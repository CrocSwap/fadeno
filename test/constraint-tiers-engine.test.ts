import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DriveError, runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

/**
 * Engine-side constraint tiers. Fixtures follow test/drive.test.ts: a real
 * playbook + `node -e` command executors, driven through `runDrive`.
 * Migrated to v3 dial world: models+routes+dials, eligibility on model entries,
 * archetype predicates.
 */

const NOTES = "process.stdout.write('NOTES')";
const NOTES_AND_FLAG =
  "require('fs').writeFileSync('ran.tmp','1');process.stdout.write('NOTES')";

const ONE_STEP = `kind: AgentPlaybook
schema_version: "0.1"
name: one-step
description: Single mutating step for eligibility / constraint tests.
when_to_use:
  - constraint tier engine tests
roles:
  builder:
    purpose: Implement the task.
    archetype: worker
flow:
  - id: implement
    kind: actor_call
    actor: builder
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

const TWO_STEP = `kind: AgentPlaybook
schema_version: "0.1"
name: two-step
description: Writer then critic; the critic's inputs are in-run provenance.
when_to_use:
  - constraint tier engine tests
roles:
  writer:
    purpose: Produce notes.
    archetype: worker
  critic:
    purpose: Review the notes.
    archetype: reviewer
flow:
  - id: implement
    kind: actor_call
    actor: writer
    output: Notes
    output_path: artifacts/notes.md
  - id: review
    kind: actor_call
    actor: critic
    input:
      - Notes
    output: Verdict
    output_path: artifacts/verdict.md
    terminal_status: completed
`;

const UNRESOLVED = `kind: AgentPlaybook
schema_version: "0.1"
name: unresolved
description: Critic whose input is a run-supplied file, not an in-run actor.
when_to_use:
  - constraint tier engine tests
inputs:
  Ghost:
    media_type: text/markdown
roles:
  critic:
    purpose: Review a ghost input.
    archetype: reviewer
flow:
  - id: review
    kind: actor_call
    actor: critic
    input:
      - Ghost
    output: Verdict
    output_path: artifacts/verdict.md
    terminal_status: completed
`;

const CONSTRAINT_FIXTURE = [
  "const fs = require('fs');",
  "const mode = fs.existsSync('constraint-mode.txt')",
  "  ? fs.readFileSync('constraint-mode.txt', 'utf8').trim()",
  "  : 'allow';",
  "let d = '';",
  "process.stdin.on('data', (c) => { d += c; });",
  "process.stdin.on('end', () => {",
  "  JSON.parse(d);",
  "  if (mode === 'refuse') { process.stderr.write('blocked by fixture'); process.exit(2); }",
  "  if (mode === 'error') { process.exit(7); }",
  "  process.exit(0);",
  "});",
].join('');

function cmd(body: string): Record<string, unknown> {
  return { adapter: 'command', command: ['node', '-e', body] };
}

function seed(
  t: TestContext,
  playbookName: string,
  playbook: string,
  profile: Record<string, unknown>,
  inputs?: string[],
): { root: string; runId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', `${playbookName}.yaml`), playbook);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(profile));
  if (inputs != null) {
    writeFileSync(join(root, 'ghost.md'), 'externally supplied notes\n');
  }
  const { runId } = runNewRun({
    playbook: playbookName,
    task: 'constraint-tier engine test',
    repoRoot: root,
    inputs,
  });
  return { root, runId };
}

function events(root: string, runId: string): RunEvent[] {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

function ofType(all: RunEvent[], type: string): RunEvent[] {
  return all.filter((e) => e.type === type);
}

function finding(
  result: { findings: Array<{ check: string; status: string; detail: string }> },
  check: string,
): { check: string; status: string; detail: string } {
  const found = result.findings.find((f) => f.check === check);
  assert.ok(found, `expected a finding for ${check}`);
  return found;
}

function rewriteEvents(
  root: string,
  runId: string,
  mutate: (row: Record<string, unknown>) => void,
): void {
  const path = join(root, '.fadeno', 'runs', runId, 'events.jsonl');
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const next = lines.map((line) => {
    const row = JSON.parse(line) as Record<string, unknown>;
    mutate(row);
    return JSON.stringify(row);
  });
  writeFileSync(path, `${next.join('\n')}\n`);
}

function drive(root: string, runId: string) {
  return runDrive({ run: runId, repoRoot: root, env: null });
}

function dummyRoutes(command: string[]): Record<string, unknown> {
  const route = { command, };
  const perHarness = { dummy: route, 'current-host': { host: true } as Record<string, unknown> };
  return {
    standalone: { ...perHarness },
    codex: { ...perHarness },
    claude: { ...perHarness },
    grok: { ...perHarness },
  };
}

function familyRoutes(): Record<string, unknown> {
  const cmdArr = ['node', '-e', NOTES];
  const perHarness = {
    moonshot: { command: cmdArr, },
    openai: { command: cmdArr, },
    'current-host': { host: true },
  };
  return {
    standalone: { ...perHarness },
    codex: { ...perHarness },
    claude: { ...perHarness },
    grok: { ...perHarness },
  };
}

function familyProfile(
  policy: 'advisory' | 'required',
  critic: 'family-a' | 'family-b',
): Record<string, unknown> {
  return {
    schema_version: 3,
    models: {
      'family-a': { provider: 'moonshot', id: 'family-a', effort: 'high' },
      'family-b': { provider: 'openai', id: 'family-b', effort: 'high' },
    },
    routes: familyRoutes(),
    archetypes: { reviewer: { distinct_provider_from_inputs: policy }, worker: {} },
    dials: { worker: 'family-a', reviewer: critic },
  };
}

function eligibilityProfile(state: 'forbidden' | 'shadow_only' | 'eligible'): Record<string, unknown> {
  const cmdArr = ['node', '-e', NOTES_AND_FLAG];
  const routes = dummyRoutes(cmdArr);
  const models: Record<string, unknown> = {
    tagged: { provider: 'dummy', id: 'tagged', effort: 'high' } as Record<string, unknown>,
  };
  if (state !== 'eligible') {
    (models.tagged as Record<string, unknown>).eligibility = { worker: state };
  }
  return {
    schema_version: 3,
    models,
    routes,
    archetypes: { worker: {} },
    bindings: { builder: 'tagged' },
  };
}

test('engine: eligibility forbidden refuses before spawn with actor_failed eligibility_forbidden', (t) => {
  const { root, runId } = seed(t, 'one-step', ONE_STEP, eligibilityProfile('forbidden'));
  const refused = drive(root, runId);

  assert.equal(refused.outcome, 'executor_failed');
  assert.match(refused.detail, /implement \(builder\) was not dispatched/);
  assert.match(refused.detail, /eligibility: forbidden/);
  assert.equal(existsSync(join(root, 'ran.tmp')), false);

  const all = events(root, runId);
  assert.equal(ofType(all, 'actor_dispatched').length, 0);
  assert.equal(ofType(all, 'prompt_assembled').length, 0);
  assert.equal(ofType(all, 'artifact_created').length, 0);

  const failures = ofType(all, 'actor_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.extra.reason, 'eligibility_forbidden');
  assert.equal(failures[0]!.extra.executor, 'tagged');
  assert.equal(failures[0]!.extra.actor, 'builder');
  assert.equal(failures[0]!.extra.archetype, 'worker');
  assert.equal(failures[0]!.extra.attempt, 1);
  assert.match(String(failures[0]!.extra.error), /eligibility: forbidden/);

  assert.equal(drive(root, runId).outcome, 'executor_failed');
  assert.equal(ofType(events(root, runId), 'actor_failed').length, 2);
});

test('engine: shadow_only dispatches and stamps gate_eligible: false; verify is green', (t) => {
  const { root, runId } = seed(t, 'one-step', ONE_STEP, eligibilityProfile('shadow_only'));
  const done = drive(root, runId);
  assert.equal(done.outcome, 'terminal');
  assert.equal(done.status, 'completed');
  assert.equal(existsSync(join(root, 'ran.tmp')), true);

  const dispatched = ofType(events(root, runId), 'actor_dispatched');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.extra.gate_eligible, false);
  assert.equal(dispatched[0]!.extra.provider_distinctness, undefined);

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.equal(finding(verify, 'gate-eligible').status, 'ok');
  assert.match(finding(verify, 'gate-eligible').detail, /1 command dispatch/);
});

test('engine: required provider clash from two-step run provenance refuses the critic', (t) => {
  const { root, runId } = seed(t, 'two-step', TWO_STEP, familyProfile('required', 'family-a'));
  const refused = drive(root, runId);

  assert.equal(refused.outcome, 'executor_failed');
  assert.match(refused.detail, /review \(critic\) was not dispatched/);
  assert.match(refused.detail, /distinct_provider_from_inputs: required/);
  assert.match(refused.detail, /moonshot/);

  const all = events(root, runId);
  const dispatched = ofType(all, 'actor_dispatched');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.step, 'implement');
  assert.equal(dispatched[0]!.extra.executor, 'family-a');

  const failures = ofType(all, 'actor_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.extra.reason, 'provider_conflict');
  assert.equal(failures[0]!.extra.actor, 'critic');
  assert.equal(failures[0]!.extra.archetype, 'reviewer');
  assert.equal(failures[0]!.extra.executor, 'family-a');
  assert.match(String(failures[0]!.extra.error), /executor "family-a"/);
});

test('engine: advisory provider clash warns, stamps actor_dispatched, and proceeds', (t) => {
  const { root, runId } = seed(t, 'two-step', TWO_STEP, familyProfile('advisory', 'family-a'));
  const done = drive(root, runId);
  assert.equal(done.outcome, 'terminal');
  assert.match(done.actions.join('\n'), /dispatch warning review \(critic\)/);
  assert.match(done.actions.join('\n'), /distinct_provider_from_inputs: advisory/);

  const dispatched = ofType(events(root, runId), 'actor_dispatched');
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0]!.extra.provider_distinctness, undefined);
  assert.equal(dispatched[1]!.step, 'review');
  assert.equal(dispatched[1]!.extra.provider_distinctness, 'warned');
  assert.equal(dispatched[1]!.extra.gate_eligible, undefined);

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.equal(finding(verify, 'gate-eligible').status, 'ok');
});

test('engine: required mode refuses an unresolvable input producer', (t) => {
  const { root, runId } = seed(
    t,
    'unresolved',
    UNRESOLVED,
    familyProfile('required', 'family-b'),
    ['Ghost=ghost.md'],
  );
  const refused = drive(root, runId);
  assert.equal(refused.outcome, 'executor_failed');
  assert.match(refused.detail, /review \(critic\) was not dispatched/);
  assert.match(refused.detail, /unresolvable/);

  const all = events(root, runId);
  assert.equal(ofType(all, 'actor_dispatched').length, 0);
  const failures = ofType(all, 'actor_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.extra.reason, 'provider_conflict');
});

test('engine: advisory mode warns on an unresolvable input producer and proceeds', (t) => {
  const { root, runId } = seed(
    t,
    'unresolved',
    UNRESOLVED,
    familyProfile('advisory', 'family-b'),
    ['Ghost=ghost.md'],
  );
  const done = drive(root, runId);
  assert.equal(done.outcome, 'terminal');
  assert.match(done.actions.join('\n'), /dispatch warning review \(critic\)/);
  assert.match(done.actions.join('\n'), /unresolvable/);

  const dispatched = ofType(events(root, runId), 'actor_dispatched');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.extra.provider_distinctness, 'warned');
});

test('engine: distinct providers pass with no warning stamp', (t) => {
  const { root, runId } = seed(t, 'two-step', TWO_STEP, familyProfile('required', 'family-b'));
  const done = drive(root, runId);
  assert.equal(done.outcome, 'terminal');
  assert.doesNotMatch(done.actions.join('\n'), /dispatch warning/);

  const dispatched = ofType(events(root, runId), 'actor_dispatched');
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1]!.extra.executor, 'family-b');
  assert.equal(dispatched[1]!.extra.provider_distinctness, undefined);

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.equal(finding(verify, 'gate-eligible').status, 'ok');
});

function seedConstraint(
  t: TestContext,
  mode: 'allow' | 'refuse' | 'error',
): { root: string; runId: string } {
  const constraintRoutes = dummyRoutes(['node', '-e', NOTES_AND_FLAG]);
  const { root, runId } = seed(t, 'one-step', ONE_STEP, {
    schema_version: 3,
    models: {
      worker: { provider: 'dummy', id: 'worker', effort: 'high' },
    },
    routes: constraintRoutes,
    archetypes: { worker: {} },
    bindings: { builder: 'worker' },
    constraints: { command: ['node', 'constraint-fixture.cjs'] },
  });
  writeFileSync(join(root, 'constraint-fixture.cjs'), CONSTRAINT_FIXTURE);
  writeFileSync(join(root, 'constraint-mode.txt'), `${mode}\n`);
  return { root, runId };
}

test('engine: constraint command exit 0 allows the dispatch', (t) => {
  const { root, runId } = seedConstraint(t, 'allow');
  const done = drive(root, runId);
  assert.equal(done.outcome, 'terminal');
  assert.equal(existsSync(join(root, 'ran.tmp')), true);
  assert.equal(ofType(events(root, runId), 'actor_dispatched').length, 1);
  assert.equal(runVerify({ run: runId, repoRoot: root }).ok, true);
});

test('engine: constraint command exit 2 refuses with actor_failed constraint_refused', (t) => {
  const { root, runId } = seedConstraint(t, 'refuse');
  const refused = drive(root, runId);
  assert.equal(refused.outcome, 'executor_failed');
  assert.match(refused.detail, /blocked by fixture/);
  assert.equal(existsSync(join(root, 'ran.tmp')), false);

  const all = events(root, runId);
  assert.equal(ofType(all, 'actor_dispatched').length, 0);
  const failures = ofType(all, 'actor_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.extra.reason, 'constraint_refused');
  assert.equal(failures[0]!.extra.error, 'blocked by fixture');
});

test('engine: constraint command other exit is a DriveError, never an allow', (t) => {
  const { root, runId } = seedConstraint(t, 'error');
  assert.throws(() => drive(root, runId), (err: unknown) => {
    assert.ok(err instanceof DriveError);
    assert.match(err.message, /constraint system error/);
    assert.match(err.message, /constraint-fixture\.cjs/);
    assert.match(err.message, /exited 7/);
    return true;
  });
  assert.equal(existsSync(join(root, 'ran.tmp')), false);
  const all = events(root, runId);
  assert.equal(ofType(all, 'actor_dispatched').length, 0);
  assert.equal(ofType(all, 'actor_failed').length, 0);
});

test('verify: adding gate_eligible: false on an eligible dispatch fails gate-eligible', (t) => {
  const { root, runId } = seed(t, 'one-step', ONE_STEP, eligibilityProfile('eligible'));
  assert.equal(drive(root, runId).outcome, 'terminal');
  const honest = runVerify({ run: runId, repoRoot: root });
  assert.equal(honest.ok, true);
  assert.equal(finding(honest, 'gate-eligible').status, 'ok');

  rewriteEvents(root, runId, (row) => {
    if (row.type === 'actor_dispatched') row.gate_eligible = false;
  });
  const tampered = runVerify({ run: runId, repoRoot: root });
  assert.equal(tampered.ok, false);
  assert.equal(finding(tampered, 'gate-eligible').status, 'fail');
  assert.match(
    finding(tampered, 'gate-eligible').detail,
    /implement \(builder\): records gate_eligible: false but snapshot eligibility is eligible/,
  );
});

test('verify: removing gate_eligible from a shadow_only dispatch fails gate-eligible', (t) => {
  const { root, runId } = seed(t, 'one-step', ONE_STEP, eligibilityProfile('shadow_only'));
  assert.equal(drive(root, runId).outcome, 'terminal');
  assert.equal(runVerify({ run: runId, repoRoot: root }).ok, true);

  rewriteEvents(root, runId, (row) => {
    if (row.type === 'actor_dispatched') delete row.gate_eligible;
  });
  const tampered = runVerify({ run: runId, repoRoot: root });
  assert.equal(tampered.ok, false);
  assert.equal(finding(tampered, 'gate-eligible').status, 'fail');
  assert.match(
    finding(tampered, 'gate-eligible').detail,
    /implement \(builder\): has no gate_eligible stamp but snapshot eligibility is shadow_only/,
  );
});

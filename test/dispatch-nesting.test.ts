import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, runDispatch } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import {
  COORDINATING_ARCHETYPES,
  DISPATCH_NESTING_ENV,
  IN_DISPATCH_ENV,
  withDispatchProvenance,
} from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

/** Echoes back exactly what the kernel stamped into the executor's environment. */
const REPORT_ENV = [
  'node',
  '-e',
  `process.stdout.write(\`\${process.env.${IN_DISPATCH_ENV} ?? 'unset'} \${process.env.${DISPATCH_NESTING_ENV} ?? 'unset'}\`)`,
];

function seed(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { probe: { provider: 'openai', id: 'probe' } },
    routes: { standalone: { openai: { command: REPORT_ENV } } },
    archetypes: { worker: {}, director: {} },
    dials: { worker: 'probe', director: 'probe' },
  }));
  return root;
}

/** Set an env var for one test, restoring whatever was there. */
function withEnv(t: TestContext, name: string, value: string | null): void {
  const previous = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  });
}

test('the executor learns which dispatch it is, and that it may not dispatch again', (t) => {
  const root = seed(t);
  const result = runDispatch({
    archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.stdout, `${result.dispatchId} deny`);
});

test('a director carries `allow`: coordinating through fadeno is its whole job', (t) => {
  const root = seed(t);
  const result = runDispatch({
    archetype: 'director', prompt: 'x', repoRoot: root, noBrief: true, userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.stdout, `${result.dispatchId} allow`);
  assert.ok(COORDINATING_ARCHETYPES.has('director'));
});

test('a director does not hand `allow` down: the workers it dispatches carry deny', (t) => {
  const root = seed(t);
  // Stand in for the director's own executor, which runs fadeno itself.
  withEnv(t, IN_DISPATCH_ENV, 'director-dispatch-id');
  withEnv(t, DISPATCH_NESTING_ENV, 'allow');
  const result = runDispatch({
    archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.stdout, `${result.dispatchId} deny`);
});

test('the 2026-08-31 recursion: an executor handed a proxy-addressed prompt is refused', (t) => {
  const root = seed(t);
  withEnv(t, IN_DISPATCH_ENV, 'aaaaaaaabbbbccccddddeeeeffff0000');
  withEnv(t, DISPATCH_NESTING_ENV, 'deny');
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: onHarness('standalone') }),
    (err: unknown) =>
      err instanceof DispatchCommandError &&
      /refusing to dispatch from inside dispatch aaaaaaaa/.test(err.message) &&
      /relay their prompt/.test(err.message) &&
      /Do the task yourself/.test(err.message),
  );
});

test('the refusal survives a catalog it never reads', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), 'schema_version: 3\nmodels: [not-a-map\n');
  withEnv(t, IN_DISPATCH_ENV, 'deadbeefcafe');
  withEnv(t, DISPATCH_NESTING_ENV, 'deny');
  // Nesting is refused on the environment alone, so a broken profile cannot
  // mask a recursion behind a parse error.
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: onHarness('standalone') }),
    (err: unknown) => err instanceof DispatchCommandError && /refusing to dispatch from inside/.test(err.message),
  );
});

test('an explicit opt-in still nests: the guard is a default, not a wall', (t) => {
  const root = seed(t);
  withEnv(t, IN_DISPATCH_ENV, 'aaaaaaaabbbb');
  withEnv(t, DISPATCH_NESTING_ENV, 'allow');
  const result = runDispatch({
    archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.stdout, `${result.dispatchId} deny`);
});

test('provenance is written, never merely omitted', () => {
  const inherited = { [IN_DISPATCH_ENV]: 'older', [DISPATCH_NESTING_ENV]: 'allow' };
  const worker = withDispatchProvenance(inherited, { dispatchId: 'new-id', archetype: 'worker' });
  assert.equal(worker[IN_DISPATCH_ENV], 'new-id');
  assert.equal(worker[DISPATCH_NESTING_ENV], 'deny');
  const unknown = withDispatchProvenance({}, { dispatchId: 'new-id', archetype: null });
  assert.equal(unknown[DISPATCH_NESTING_ENV], 'deny');
});

// --- the engine lane stamps the same provenance ---

const PROBE_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: nesting-probe
description: One actor call that reports the environment it was handed.
when_to_use:
  - engine tests
roles:
  worker:
    purpose: Report the environment.
flow:
  - id: report
    kind: actor_call
    actor: worker
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

test('an engine-dispatched actor is an executor too, and carries deny', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'nesting-probe.yaml'), PROBE_PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { probe: { provider: 'probe_p', id: 'probe', effort: 'high' } },
    // Every harness lane, so the run snapshot resolves whatever ambient
    // harness the suite happens to run under.
    routes: Object.fromEntries(
      ['standalone', 'codex', 'claude', 'grok', 'opencode', 'omp'].map((lane) => [
        lane,
        { probe_p: { command: REPORT_ENV }, 'current-host': { host: true } },
      ]),
    ),
    archetypes: { worker: {} },
    dials: { worker: 'probe' },
    bindings: { worker: 'probe', '*': 'probe' },
  }));
  const { runId } = runNewRun({ playbook: 'nesting-probe', task: 'report the environment', repoRoot: root });
  const result = runDrive({ run: runId, repoRoot: root });
  assert.equal(result.outcome, 'terminal');
  const notes = readFileSync(join(root, '.fadeno', 'runs', runId, 'artifacts', 'notes.md'), 'utf8');
  // The engine names its executor by actor call and attempt, not a dispatch id.
  assert.match(notes, /^ac-report-g1-worker:a1 deny$/);
});

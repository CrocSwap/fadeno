import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { tempRepo } from './helpers.ts';

/**
 * verify × loadouts: the executor-bindings check must replay the same
 * resolution chain the engine used — per-role pin → active loadout's archetype
 * slot → "*" default — recomputed from ledger contents alone (profile snapshot
 * + resolution_snapshot event), not a bindings-only lookup.
 */

const NOTES_CMD = ['node', '-e', "process.stdout.write('NOTES')"];
const ALT_CMD = ['node', '-e', "process.stdout.write('ALT NOTES')"];

const LOADOUT_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: verify-mixed
description: Loadout-resolution flow for verify tests.
when_to_use:
  - verify loadout tests
roles:
  implementer:
    purpose: Implement the task.
    archetype: worker
flow:
  - id: implement
    kind: actor_call
    actor: implementer
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

const BINDINGS_PLAYBOOK = LOADOUT_PLAYBOOK
  .replace('name: verify-mixed', 'name: verify-bindings')
  .replace('\n    archetype: worker', '');

/** Mixed profile: a "*" default binding AND a loadout that overrides it for the
 *  unpinned worker-archetype role. */
const MIXED_PROFILE = {
  executors: {
    'star-worker': { adapter: 'command', command: NOTES_CMD, model: 'm-star' },
    'loadout-worker': { adapter: 'command', command: ALT_CMD, model: 'm-loadout' },
  },
  loadouts: { main: { worker: 'loadout-worker' } },
  default_loadout: 'main',
  bindings: { '*': 'star-worker' },
};

function seedRepo(
  t: TestContext,
  playbookName: string,
  playbook: string,
  profile: Record<string, unknown>,
): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', `${playbookName}.yaml`), playbook);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(profile));
  return root;
}

/** Drive a fresh run of the playbook to terminal and return its id. */
function completedRun(root: string, playbookName: string): string {
  const { runId } = runNewRun({ playbook: playbookName, task: 'verify loadouts', repoRoot: root, env: null });
  const done = runDrive({ run: runId, repoRoot: root, env: null });
  assert.equal(done.outcome, 'terminal');
  assert.equal(done.status, 'completed');
  return runId;
}

function events(root: string, runId: string): RunEvent[] {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

function finding(
  result: { findings: Array<{ check: string; status: string; detail: string }> },
  check: string,
): { check: string; status: string; detail: string } {
  const found = result.findings.find((f) => f.check === check);
  assert.ok(found, `expected a finding for ${check}`);
  return found;
}

/** Append a forged dispatch claiming `executor` for the implementer role. */
function forgeDispatch(root: string, runId: string, executor: string): void {
  new LedgerWriter(join(root, '.fadeno', 'runs', runId)).append(
    {
      type: 'actor_dispatched',
      step: 'implement',
      actor: 'implementer',
      step_execution_id: 'se-implement-g1',
      actor_call_id: 'ac-implement-g1-implementer',
      attempt: 2,
      attempt_reason: 'user_retry',
      executor,
    },
    new Date(),
  );
}

test('verify: a mixed profile (loadout beating "*" for an unpinned role) verifies clean', (t) => {
  const root = seedRepo(t, 'verify-mixed', LOADOUT_PLAYBOOK, MIXED_PROFILE);
  const runId = completedRun(root, 'verify-mixed');

  // Sanity: the engine really took the loadout branch, not the "*" default.
  const all = events(root, runId);
  const dispatched = all.find((e) => e.type === 'actor_dispatched');
  assert.ok(dispatched);
  assert.equal(dispatched.extra.executor, 'loadout-worker');
  const snapshot = all.find((e) => e.type === 'resolution_snapshot');
  assert.ok(snapshot);
  assert.deepEqual(snapshot.extra.loadout, { name: 'main', source: 'default' });

  // Pre-fix this was a false mismatch: replaying bindings alone expects
  // "star-worker". The chain-aware replay must agree with the engine.
  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true, finding(verify, 'executor-bindings').detail);
  const binding = finding(verify, 'executor-bindings');
  assert.equal(binding.status, 'ok');
  assert.match(binding.detail, /1 dispatch\(es\) match the recomputed resolution chain/);
});

test('verify: a mixed profile with a per-role pin resolves the pin over the loadout, clean', (t) => {
  const root = seedRepo(t, 'verify-mixed', LOADOUT_PLAYBOOK, {
    ...MIXED_PROFILE,
    bindings: { implementer: 'star-worker', '*': 'star-worker' },
  });
  const runId = completedRun(root, 'verify-mixed');

  // Pin beats the loadout slot; both engine and verify must agree.
  assert.equal(events(root, runId).find((e) => e.type === 'actor_dispatched')!.extra.executor, 'star-worker');
  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true, finding(verify, 'executor-bindings').detail);
});

test('verify: a dispatch whose recorded executor mismatches the recomputation still fails', (t) => {
  const root = seedRepo(t, 'verify-mixed', LOADOUT_PLAYBOOK, MIXED_PROFILE);
  const runId = completedRun(root, 'verify-mixed');

  // The forged dispatch claims the "*" default executor for a role the active
  // loadout routes elsewhere — a dishonest ledger, not a resolution ambiguity.
  forgeDispatch(root, runId, 'star-worker');

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, false);
  const binding = finding(verify, 'executor-bindings');
  assert.equal(binding.status, 'fail');
  assert.match(
    binding.detail,
    /implement \(implementer\): dispatched to "star-worker" but the resolution in force was "loadout-worker"/,
  );
});

test('verify: a tampered resolution_snapshot row fails executor-bindings', (t) => {
  const root = seedRepo(t, 'verify-mixed', LOADOUT_PLAYBOOK, MIXED_PROFILE);
  const runId = completedRun(root, 'verify-mixed');

  // Tamper the snapshot's per-role claim (not the dispatch): rewrite the
  // recorded executor to the "*" default. seq numbers stay contiguous.
  const eventsPath = join(root, '.fadeno', 'runs', runId, 'events.jsonl');
  const rewritten = readFileSync(eventsPath, 'utf8')
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      const parsed = JSON.parse(line) as { type?: string; roles?: Array<{ executor?: string }> };
      if (parsed.type !== 'resolution_snapshot') return line;
      parsed.roles![0]!.executor = 'star-worker';
      return JSON.stringify(parsed);
    })
    .join('\n');
  writeFileSync(eventsPath, rewritten, 'utf8');

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, false);
  const binding = finding(verify, 'executor-bindings');
  assert.equal(binding.status, 'fail');
  assert.match(binding.detail, /resolution_snapshot: role "implementer" records "star-worker" \[loadout\]/);
  assert.match(binding.detail, /recomputes to "loadout-worker" \[loadout\]/);
});

test('verify: a bindings-only profile behaves as before (clean when honest, fails when forged)', (t) => {
  const root = seedRepo(t, 'verify-bindings', BINDINGS_PLAYBOOK, {
    executors: {
      bw: { adapter: 'command', command: NOTES_CMD },
      other: { adapter: 'command', command: ALT_CMD },
    },
    bindings: { implementer: 'bw', '*': 'bw' },
  });
  const runId = completedRun(root, 'verify-bindings');

  const clean = runVerify({ run: runId, repoRoot: root });
  assert.equal(clean.ok, true, finding(clean, 'executor-bindings').detail);
  assert.equal(finding(clean, 'executor-bindings').status, 'ok');

  // A forged dispatch to another declared executor is still a binding breach.
  forgeDispatch(root, runId, 'other');
  const forged = runVerify({ run: runId, repoRoot: root });
  assert.equal(forged.ok, false);
  assert.match(
    finding(forged, 'executor-bindings').detail,
    /dispatched to "other" but the resolution in force was "bw"/,
  );
});

test('verify: a loadout-only profile (no bindings at all) verifies clean', (t) => {
  const root = seedRepo(t, 'verify-mixed', LOADOUT_PLAYBOOK, {
    executors: { lw: { adapter: 'command', command: NOTES_CMD, model: 'm1' } },
    loadouts: { solo: { worker: 'lw' } },
    default_loadout: 'solo',
  });
  const runId = completedRun(root, 'verify-mixed');

  assert.equal(events(root, runId).find((e) => e.type === 'actor_dispatched')!.extra.executor, 'lw');
  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true, finding(verify, 'executor-bindings').detail);
  assert.equal(finding(verify, 'executor-bindings').status, 'ok');
});

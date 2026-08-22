import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runDispatchComplete, runDispatchStart } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runRun } from '../src/commands/run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

/**
 * Regression: a loadout switch must never silently abandon an in-flight host
 * dispatch. The dogfood sequence was: drive under a host-resolving loadout
 * (dispatch requested) → `fadeno loadout use` a command-resolving loadout →
 * drive again. The bug re-resolved the step, executed it with the command
 * executor, and completed a run whose pending dispatch never got receipts —
 * a completed run that failed its own `fadeno verify`.
 */

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: loadout-switch-fixture
description: Pending host dispatch across a loadout switch.
roles:
  worker:
    purpose: Implement the task.
    archetype: worker
flow:
  - id: implement
    kind: actor_call
    actor: worker
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

const EXECUTORS = {
  schema_version: 3,
  models: {
    'luna-host': { provider: 'luna_p', id: 'gpt-5.6-luna', effort: 'xhigh' },
    'ok-worker': { provider: 'ok_p', id: 'ok-worker', effort: 'high' },
  },
  routes: {
    standalone: {
      luna_p: { host: true },
      ok_p: { command: ['node', '-e', "process.stdout.write('COMMAND NOTES')"], },
      'current-host': { host: true },
    },
    codex: {
      luna_p: { host: true },
      ok_p: { command: ['node', '-e', "process.stdout.write('COMMAND NOTES')"], },
      'current-host': { host: true },
    },
    claude: {
      luna_p: { host: true },
      ok_p: { command: ['node', '-e', "process.stdout.write('COMMAND NOTES')"], },
      'current-host': { host: true },
    },
    grok: {
      luna_p: { host: true },
      ok_p: { command: ['node', '-e', "process.stdout.write('COMMAND NOTES')"], },
      'current-host': { host: true },
    },
  },
  archetypes: { worker: {} },
  dials: { worker: 'luna-host' },
};

function useLoadout(root: string, name: string): void {
  // Dial world: map old loadout names to dial values
  const dial = name === 'host-primary' ? 'luna-host' : 'ok-worker';
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ dials: { worker: dial } }));
}

function runStatus(runDir: string): unknown {
  return (parseYaml(readFileSync(join(runDir, 'run.yaml'), 'utf8')) as { status?: unknown }).status;
}

function seedPendingUnderHostLoadout(t: TestContext): { root: string; runId: string; runDir: string; dispatchId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'loadout-switch-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(EXECUTORS));
  useLoadout(root, 'host-primary');
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'loadout-switch-fixture', task: 'switch loadouts mid-flight' });
  const first = runDrive({ repoRoot: root, run: runId, env: null });
  assert.equal(first.outcome, 'awaiting_host_dispatch');
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0]!.executor, 'luna-host');
  return { root, runId, runDir, dispatchId: first.requests[0]!.dispatchId };
}

test('a loadout switch honors the pending host dispatch and reports the divergence', (t) => {
  const { root, runId, runDir, dispatchId } = seedPendingUnderHostLoadout(t);

  // The dogfood switch: the new loadout resolves the role to a command executor.
  useLoadout(root, 'command-primary');
  const second = runDrive({ repoRoot: root, run: runId, env: null });

  // The dispatch stays binding: drive keeps awaiting the same request instead of
  // re-resolving, re-dispatching, or executing the step with the command executor.
  assert.equal(second.outcome, 'awaiting_host_dispatch');
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0]!.dispatchId, dispatchId);
  assert.equal(second.requests[0]!.executor, 'luna-host');

  // The divergence is surfaced, not silent — in the report detail and the action log.
  assert.match(second.detail, /pending dispatch is honored/);
  assert.match(second.detail, new RegExp(dispatchId));
  assert.match(second.detail, /ok-worker \(command adapter\)/);
  assert.match(second.detail, /future dispatches only/);
  assert.ok(second.actions.some((line) => /pending dispatch is honored/.test(line)));

  // No silent substitution in the evidence: no actor was dispatched, no artifact
  // appeared, the request was not duplicated, and the run did not complete.
  const events = readEvents(runDir).events;
  assert.equal(events.filter((event) => event.type === 'actor_dispatched').length, 0);
  assert.equal(events.filter((event) => event.type === 'artifact_created').length, 0);
  assert.equal(events.filter((event) => event.type === 'host_dispatch_requested').length, 1);
  assert.equal(runStatus(runDir), 'running');

  // Mid-flight, the audit stays green: the only failing check is the generic
  // "trace not terminal yet" one, and the host lifecycle itself is coherent.
  const midFlight = runVerify({ repoRoot: root, run: runId });
  assert.equal(midFlight.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!.status, 'ok');
  assert.deepEqual(
    midFlight.findings.filter((finding) => finding.status === 'fail').map((finding) => finding.check),
    ['terminal-status'],
  );

  // A repeat drive under the switched loadout stays stable (still awaiting).
  const third = runDrive({ repoRoot: root, run: runId, env: null });
  assert.equal(third.outcome, 'awaiting_host_dispatch');
  assert.equal(third.requests[0]!.dispatchId, dispatchId);

  // Explicit fulfilment through the contract's receipts unblocks the run.
  runDispatchStart({ repoRoot: root, run: runId, dispatchId, agentId: 'native-worker' });
  const output = join(root, 'native-output.md');
  writeFileSync(output, 'native notes');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId, output });
  const final = runDrive({ repoRoot: root, run: runId, env: null });
  assert.equal(final.outcome, 'terminal');
  assert.equal(final.status, 'completed');
  assert.equal(runStatus(runDir), 'completed');
  assert.equal(runVerify({ repoRoot: root, run: runId }).ok, true);
});

test('drive refuses a terminal transition while a host dispatch is still requested', (t) => {
  const { root, runId, runDir, dispatchId } = seedPendingUnderHostLoadout(t);

  // Forge the corrupted precondition directly: the planned artifact appears
  // out-of-band, so the flow computes terminal while the dispatch has no
  // receipts. The engine must refuse the transition, not complete the run.
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  writeFileSync(join(runDir, 'artifacts', 'notes.md'), 'out-of-band notes');
  runRun({ repoRoot: root, run: runId, event: 'artifact_created', artifact: 'artifacts/notes.md' });

  const result = runDrive({ repoRoot: root, run: runId, env: null });
  assert.equal(result.outcome, 'awaiting_host_dispatch');
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]!.dispatchId, dispatchId);
  assert.match(result.detail, /never terminates over an in-flight host dispatch/);
  assert.equal(runStatus(runDir), 'running');
});

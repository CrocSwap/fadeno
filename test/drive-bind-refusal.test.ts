import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatchComplete, runDispatchStart } from '../src/commands/dispatch.ts';
import { runDispatchWithdraw } from '../src/commands/dispatch-withdraw.ts';
import { DriveError, runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

/**
 * `--bind` is per-invocation, and a run is driven across several invocations
 * because every host dispatch exits the engine. Dropping the flag on the
 * second call used to move the role back onto the cascade with only a NOTE —
 * both invocations individually consistent, so `verify` could not object
 * either. New work now refuses; `--unbind` is the way to actually release it.
 */

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: bind-refusal-fixture
description: A role bound by an earlier drive of the same run.
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
  schema_version: 4,
  models: {
    luna: { provider: 'luna_p', id: 'gpt-5.6-luna', effort: 'xhigh' },
    terra: { provider: 'terra_p', id: 'gpt-5.6-terra', effort: 'high' },
    // A COMMAND-lane executor, for the parallel all-command fast path: the
    // refusal must land before anything spawns, so this argv never runs.
    stub: { provider: 'stub_p', id: 'stub-cmd', effort: 'high' },
  },
  harnesses: {
    luna_p: { provider: 'luna_p', host: { effort_channel: 'none' } },
    terra_p: { provider: 'terra_p', host: { effort_channel: 'none' } },
    stub_p: { provider: 'stub_p', command: ['node', '-e', 'process.stdout.write("stub ran\\n")'] },
  },
  archetypes: { worker: {} },
  dials: { worker: 'terra' },
};

function setDial(root: string, value: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ dials: { worker: value } }));
}

/** Drive once under `--bind worker=luna`, so the run carries a binding. */
function seedBoundRun(t: TestContext, opts: { dial?: string } = {}): {
  root: string;
  runId: string;
  runDir: string;
  dispatchId: string;
} {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'bind-refusal-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(EXECUTORS));
  setDial(root, opts.dial ?? 'terra');
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'bind-refusal-fixture', task: 'bound role across invocations' });
  const first = runDrive({ repoRoot: root, run: runId, bind: ['worker=luna'] });
  assert.equal(first.outcome, 'awaiting_host_dispatch');
  assert.equal(first.requests[0]!.executor, 'luna');
  return { root, runId, runDir, dispatchId: first.requests[0]!.dispatchId };
}

function eventsOf(runDir: string): RunEvent[] {
  return readEvents(runDir).events;
}

function countOf(runDir: string, type: string): number {
  return eventsOf(runDir).filter((event) => event.type === type).length;
}

/**
 * The assertion is byte-identity of the whole ledger, not a count of the event
 * types the refusal was about.
 *
 * Counting request/start/failure rows was the too-narrow assertion that let a
 * real violation through: the invocation appended a `resolution_snapshot`
 * first, recording `source: cascade` on the very executor the refusal exists to
 * prevent — a ledger row asserting the wrong answer, in a run that is supposed
 * to be indistinguishable from one that was never driven. Nothing narrower than
 * "the file did not change" can catch the next one of those.
 */
test('dropping --bind refuses to start NEW work, and appends nothing at all', (t) => {
  const { root, runId, runDir, dispatchId } = seedBoundRun(t);
  // Retire the pending request so the next drive would MINT rather than continue.
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'retire attempt 1' });

  const ledger = join(runDir, 'events.jsonl');
  const before = readFileSync(ledger);

  assert.throws(
    () => runDrive({ repoRoot: root, run: runId }),
    (err: unknown) =>
      err instanceof DriveError &&
      (err as Error).message ===
        'role "worker" was bound to "luna" earlier in this run; this invocation would start new work for ' +
          'it on "terra". Pass --bind worker=luna to keep the binding or --unbind worker to release it.',
  );

  // Byte-identical: no request, no dispatch, no failure — and no resolution
  // snapshot naming the executor the refusal just rejected.
  const after = readFileSync(ledger);
  assert.ok(
    before.equals(after),
    `the refusal appended ${after.length - before.length} bytes:\n` +
      after.toString('utf8').slice(before.length),
  );
  assert.equal(countOf(runDir, 'resolution_snapshot'), 1, 'only the first drive recorded one');

  // And the deferral is not a leak: the NEXT drive, the one that does mint,
  // records the resolution it minted under.
  const released = runDrive({ repoRoot: root, run: runId, unbind: ['worker'] });
  assert.equal(released.requests[0]!.executor, 'terra');
  assert.equal(countOf(runDir, 'resolution_snapshot'), 2);
  const snapshots = eventsOf(runDir).filter((event) => event.type === 'resolution_snapshot');
  assert.equal((snapshots.at(-1)!.extra.roles as { executor: string }[])[0]!.executor, 'terra');
  assert.equal(runVerify({ repoRoot: root, run: runId }).findings.find((f) => f.check === 'executor-bindings')!.status, 'ok');
});

test('repeating the same --bind proceeds, keeps the executor, and verifies', (t) => {
  const { root, runId, dispatchId } = seedBoundRun(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'retire attempt 1' });

  const second = runDrive({ repoRoot: root, run: runId, bind: ['worker=luna'] });
  assert.equal(second.outcome, 'awaiting_host_dispatch');
  const retry = second.requests[0]!;
  assert.equal(retry.executor, 'luna', 'the repeated binding still wins over the cascade');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.attemptReason, 'withdrawn');

  runDispatchStart({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, agentId: 'host-attempt-2' });
  const output = join(root, 'notes.md');
  writeFileSync(output, 'notes under the repeated binding\n');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, output });
  assert.equal(runDrive({ repoRoot: root, run: runId, bind: ['worker=luna'] }).outcome, 'terminal');

  const verified = runVerify({ repoRoot: root, run: runId });
  assert.equal(verified.ok, true, JSON.stringify(verified.findings.filter((finding) => finding.status === 'fail')));
});

test('--unbind releases the role, records a cleared override, and holds for later invocations', (t) => {
  const { root, runId, runDir, dispatchId } = seedBoundRun(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'retire attempt 1' });

  const released = runDrive({ repoRoot: root, run: runId, unbind: ['worker'] });
  assert.equal(released.outcome, 'awaiting_host_dispatch');
  assert.equal(released.requests[0]!.executor, 'terra', 'the role falls back to the cascade');

  const cleared = eventsOf(runDir).filter((event) => event.type === 'executor_override' && event.extra.cleared === true);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.extra.role, 'worker');
  assert.equal(cleared[0]!.extra.executor, null);
  assert.equal(cleared[0]!.extra.prior, 'luna');
  assert.ok(released.actions.some((line) => line.includes('binding released: worker (was luna)')), released.actions.join('\n'));

  // The release is durable: a LATER invocation that passes neither flag is not
  // refused, because the run no longer holds a binding for the role.
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId: released.requests[0]!.dispatchId, reason: 'retire attempt 2' });
  const third = runDrive({ repoRoot: root, run: runId });
  assert.equal(third.outcome, 'awaiting_host_dispatch');
  assert.equal(third.requests[0]!.executor, 'terra');
  assert.equal(third.requests[0]!.attempt, 3);
});

test('a cleared override verifies: the role recomputes against the cascade again', (t) => {
  const { root, runId, dispatchId } = seedBoundRun(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'retire attempt 1' });
  const released = runDrive({ repoRoot: root, run: runId, unbind: ['worker'] });
  const retry = released.requests[0]!;

  runDispatchStart({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, agentId: 'host-attempt-2' });
  const output = join(root, 'notes.md');
  writeFileSync(output, 'notes after the release\n');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, output });
  assert.equal(runDrive({ repoRoot: root, run: runId }).outcome, 'terminal');

  const verified = runVerify({ repoRoot: root, run: runId });
  const bindings = verified.findings.find((finding) => finding.check === 'executor-bindings')!;
  assert.equal(bindings.status, 'ok', bindings.detail);
  assert.equal(verified.ok, true, JSON.stringify(verified.findings.filter((finding) => finding.status === 'fail')));
});

test('continuing an already-minted request is never refused, and still says the binding was dropped', (t) => {
  const { root, runId, runDir, dispatchId } = seedBoundRun(t);
  // No withdraw: the request is still pending, so the second drive continues it.
  const second = runDrive({ repoRoot: root, run: runId });
  assert.equal(second.outcome, 'awaiting_host_dispatch');
  assert.equal(second.requests[0]!.dispatchId, dispatchId, 'the pending request is honored');
  assert.ok(
    second.actions.some((line) => line.startsWith('NOTE: role "worker" was bound to "luna" earlier in this run')),
    second.actions.join('\n'),
  );
  assert.equal(countOf(runDir, 'host_dispatch_requested'), 1);
});

test('no refusal when the cascade already agrees with the binding', (t) => {
  const { root, runId, dispatchId } = seedBoundRun(t, { dial: 'luna' });
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'retire attempt 1' });

  const second = runDrive({ repoRoot: root, run: runId });
  assert.equal(second.outcome, 'awaiting_host_dispatch');
  assert.equal(second.requests[0]!.executor, 'luna');
});

/**
 * `--parallel > 1` takes a different engine path, and its all-command members
 * are handed straight to the wave primitive, which never asks about a role
 * again. Checking the binding at the two admission sites therefore left this
 * lane — the one a map step of command workers actually uses — unguarded.
 * The check now lives in the queue builder every parallel member passes.
 */
test('the parallel lane refuses before admitting any member, command members included', (t) => {
  const { root, runId, runDir, dispatchId } = seedBoundRun(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'retire attempt 1' });
  // The cascade now resolves the role to a COMMAND executor, so the queue is
  // all-command and would take the fast path straight into the wave.
  setDial(root, 'stub');

  const dispatchesBefore = countOf(runDir, 'actor_dispatched');
  assert.throws(
    () => runDrive({ repoRoot: root, run: runId, parallel: 2 }),
    (err: unknown) =>
      err instanceof DriveError &&
      (err as Error).message ===
        'role "worker" was bound to "luna" earlier in this run; this invocation would start new work for ' +
          'it on "stub". Pass --bind worker=luna to keep the binding or --unbind worker to release it.',
  );
  // Nothing spawned and nothing was minted: the refusal precedes admission.
  assert.equal(countOf(runDir, 'actor_dispatched'), dispatchesBefore);
  assert.equal(countOf(runDir, 'host_dispatch_requested'), 1);
});

test('--bind and --unbind for the same role contradict each other', (t) => {
  const { root, runId } = seedBoundRun(t);
  assert.throws(
    () => runDrive({ repoRoot: root, run: runId, bind: ['worker=luna'], unbind: ['worker'] }),
    (err: unknown) => err instanceof DriveError && /contradict each other/.test((err as Error).message),
  );
  assert.throws(
    () => runDrive({ repoRoot: root, run: runId, unbind: ['worker=luna'] }),
    (err: unknown) => err instanceof DriveError && /Invalid --unbind "worker=luna"; expected a role name/.test((err as Error).message),
  );
});

test("--bind '*' and --unbind '*' work on the anonymous base key", (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'bind-refusal-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(EXECUTORS));
  setDial(root, 'terra');
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'bind-refusal-fixture', task: 'base binding' });

  // `*` is the key an ANONYMOUS actor call resolves through (`role ?? '*'`, the
  // convention `effectiveBinding`, `refuseDroppedBinding` and `recordUnbinds`
  // all share), so it is the one binding every other fixture leaves untested.
  const first = runDrive({ repoRoot: root, run: runId, bind: ['*=luna'] });
  assert.equal(first.outcome, 'awaiting_host_dispatch');
  // A base binding is not a wildcard over named roles: `worker` still resolves
  // through the cascade, because `effectiveBinding` looks up one key, not two.
  assert.equal(first.requests[0]!.executor, 'terra');
  const bound = eventsOf(runDir).filter((event) => event.type === 'executor_override' && event.extra.role === '*');
  assert.equal(bound.length, 1);
  assert.equal(bound[0]!.extra.executor, 'luna');

  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId: first.requests[0]!.dispatchId, reason: 'retire attempt 1' });

  const released = runDrive({ repoRoot: root, run: runId, unbind: ['*'] });
  assert.equal(released.outcome, 'awaiting_host_dispatch');
  const cleared = eventsOf(runDir).filter((event) => event.type === 'executor_override' && event.extra.cleared === true);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.extra.role, '*');
  assert.equal(cleared[0]!.extra.executor, null);
  assert.equal(cleared[0]!.extra.prior, 'luna');
  assert.ok(released.actions.some((line) => line.includes('binding released: * (was luna)')), released.actions.join('\n'));
});

test('--unbind for a role with no binding in force records nothing', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'bind-refusal-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(EXECUTORS));
  setDial(root, 'terra');
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'bind-refusal-fixture', task: 'never bound' });

  const driven = runDrive({ repoRoot: root, run: runId, unbind: ['worker'] });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  assert.equal(countOf(runDir, 'executor_override'), 0);
  assert.ok(driven.actions.some((line) => line.includes('--unbind worker: no binding is in force')), driven.actions.join('\n'));
});

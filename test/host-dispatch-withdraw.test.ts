import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatchComplete, runDispatchStart } from '../src/commands/dispatch.ts';
import { runDispatchPrepare } from '../src/commands/dispatch-prepare.ts';
import { DispatchWithdrawError, runDispatchWithdraw } from '../src/commands/dispatch-withdraw.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runRun } from '../src/commands/run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { hostRequestTerminalState } from '../src/lib/host-dispatch.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

/**
 * A host request minted for an executor the host cannot reach used to be a
 * dead end: the only terminal receipts both require a `dispatch-start`, so the
 * run stayed pinned to the unreachable request forever. `dispatch-withdraw` is
 * the terminal receipt for a request with no execution behind it.
 */

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: withdraw-fixture
description: Host request withdrawn before it ever started.
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

/** The same role and the same executors, reached through the compositional
 *  frontier instead of the promptable step loop. */
const COMPOSITE_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.2"
name: composite-withdraw-fixture
description: A compositional map member whose request is withdrawn and re-minted.
roles:
  worker:
    purpose: Implement one item.
    archetype: worker
flow:
  - id: items
    kind: map
    over: [item_1]
    as: item
    body: [implement]
    completion: all
  - id: implement
    kind: actor_call
    actor: worker
    output: Notes
  - id: summarize
    kind: reduce
    actor: worker
    input: ["Notes[]"]
    output: FinalSummary
    terminal_status: completed
`;

const EXECUTORS = {
  schema_version: 4,
  models: {
    luna: { provider: 'luna_p', id: 'gpt-5.6-luna', effort: 'xhigh' },
    terra: { provider: 'terra_p', id: 'gpt-5.6-terra', effort: 'high' },
  },
  harnesses: {
    luna_p: { provider: 'luna_p', host: { effort_channel: 'none' } },
    terra_p: { provider: 'terra_p', host: { effort_channel: 'none' } },
  },
  archetypes: { worker: {} },
  dials: { worker: 'luna' },
};

function setDial(root: string, value: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ dials: { worker: value } }));
}

function initGit(root: string): void {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@invalid',
  };
  const run = (args: string[]): void => {
    const done = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (done.error || done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr ?? done.error}`);
  };
  run(['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-m', 'init']);
}

function seedPending(t: TestContext, opts: { git?: boolean } = {}): {
  root: string;
  runId: string;
  runDir: string;
  dispatchId: string;
} {
  const root = tempRepo(t);
  if (opts.git === true) initGit(root);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'withdraw-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(EXECUTORS));
  setDial(root, 'luna');
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'withdraw-fixture', task: 'withdraw a never-started request' });
  const first = runDrive({ repoRoot: root, run: runId });
  assert.equal(first.outcome, 'awaiting_host_dispatch');
  assert.equal(first.requests.length, 1);
  return { root, runId, runDir, dispatchId: first.requests[0]!.dispatchId };
}

function eventsOf(runDir: string): RunEvent[] {
  return readEvents(runDir).events;
}

function withdrawalsOf(runDir: string, dispatchId: string): RunEvent[] {
  return eventsOf(runDir).filter((event) => event.type === 'host_dispatch_withdrawn' && event.extra.dispatch_id === dispatchId);
}

test('withdraw records a terminal receipt for a never-started request', (t) => {
  const { root, runId, runDir, dispatchId } = seedPending(t);
  const receipt = runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'host cannot reach that executor' });
  assert.equal(receipt.state, 'withdrawn');
  assert.equal(receipt.idempotent, false);
  assert.equal(receipt.workspaceRemoved, false);
  assert.equal(receipt.workspaceError, null);

  const [event] = withdrawalsOf(runDir, dispatchId);
  assert.ok(event != null, 'a host_dispatch_withdrawn event is recorded');
  assert.equal(event.step, 'implement');
  assert.equal(event.extra.actor, 'worker');
  assert.equal(event.extra.executor, 'luna');
  assert.equal(event.extra.attempt, 1);
  assert.equal(event.extra.reason, 'host cannot reach that executor');
  assert.equal(event.extra.withdrawn_by, 'host');
  assert.equal(typeof event.extra.step_execution_id, 'string');
  assert.equal(typeof event.extra.actor_call_id, 'string');
  // Nothing was ever prepared, so no workspace keys claim otherwise.
  assert.equal(event.extra.workspace_removed, undefined);
});

test('a withdrawn request is not pending and the next drive mints attempt 2 as "withdrawn"', (t) => {
  const { root, runId, runDir, dispatchId } = seedPending(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'wrong lane' });

  const second = runDrive({ repoRoot: root, run: runId });
  assert.equal(second.outcome, 'awaiting_host_dispatch');
  assert.equal(second.requests.length, 1, 'the withdrawn request is not counted as awaiting');
  const retry = second.requests[0]!;
  assert.notEqual(retry.dispatchId, dispatchId);
  assert.equal(retry.attempt, 2, 'hostRequestAttempts keeps counting minted requests');
  assert.equal(retry.attemptReason, 'withdrawn');
  assert.equal(retry.executor, 'luna');

  const requests = eventsOf(runDir).filter((event) => event.type === 'host_dispatch_requested');
  assert.equal(requests.length, 2);
});

test('an executor change outranks the withdraw reason on the re-mint', (t) => {
  const { root, runId, dispatchId } = seedPending(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'moving this role' });
  setDial(root, 'terra');

  const second = runDrive({ repoRoot: root, run: runId });
  const retry = second.requests[0]!;
  assert.equal(retry.attempt, 2);
  assert.equal(retry.executor, 'terra');
  assert.equal(retry.attemptReason, 'executor_override');
});

/**
 * One fact — a request minted for X, withdrawn, re-driven under a binding to
 * Y — put through BOTH engine paths, because they used to answer it
 * differently. `planHostAttempt` ranks `executor_override` above `withdrawn`;
 * the compositional re-mint carried its own copy of that ladder with the
 * `executor_override` arm missing entirely, so it recorded `withdrawn` for the
 * same fact. There is one ladder now (`hostAttemptReason`) and this is the
 * test that both lanes read it.
 */
test('a re-mint onto a changed binding is executor_override on both engine paths', (t) => {
  // Promptable lane.
  const promptable = seedPending(t);
  runDispatchWithdraw({ repoRoot: promptable.root, run: promptable.runId, dispatchId: promptable.dispatchId, reason: 'moving this role' });
  const remint = runDrive({ repoRoot: promptable.root, run: promptable.runId, bind: ['worker=terra'] }).requests[0]!;
  assert.equal(remint.attempt, 2);
  assert.equal(remint.executor, 'terra');
  assert.equal(remint.attemptReason, 'executor_override');

  // Compositional lane: same fact, other engine path.
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'composite-withdraw-fixture.yaml'), COMPOSITE_PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(EXECUTORS));
  setDial(root, 'luna');
  const { runId } = runNewRun({ repoRoot: root, playbook: 'composite-withdraw-fixture', task: 'withdraw a compositional member request' });

  const first = runDrive({ repoRoot: root, run: runId });
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0]!.executor, 'luna');
  assert.equal(first.requests[0]!.attemptReason, 'initial');
  assert.equal(typeof first.requests[0]!.nodeInstanceId, 'string', 'this is the compositional path');
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId: first.requests[0]!.dispatchId, reason: 'moving this role' });

  const composite = runDrive({ repoRoot: root, run: runId, bind: ['worker=terra'] }).requests[0]!;
  assert.equal(composite.attempt, 2);
  assert.equal(composite.executor, 'terra');
  assert.equal(
    composite.attemptReason,
    'executor_override',
    'the compositional ladder must not answer "withdrawn" where the promptable one answers "executor_override"',
  );
});

test('a withdraw + re-mint + completion verifies end to end', (t) => {
  const { root, runId, runDir, dispatchId } = seedPending(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'no host session for that executor' });

  const retry = runDrive({ repoRoot: root, run: runId }).requests[0]!;
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, agentId: 'host-attempt-2' });
  const output = join(root, 'notes.md');
  writeFileSync(output, 'the notes\n');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, output });
  assert.equal(runDrive({ repoRoot: root, run: runId }).outcome, 'terminal');

  const verified = runVerify({ repoRoot: root, run: runId });
  const lifecycle = verified.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!;
  assert.equal(lifecycle.status, 'ok', lifecycle.detail);
  const reasons = verified.findings.find((finding) => finding.check === 'attempt-reasons');
  if (reasons != null) assert.notEqual(reasons.status, 'fail', reasons.detail);
  assert.equal(verified.ok, true, JSON.stringify(verified.findings.filter((f) => f.status === 'fail')));
  assert.equal(withdrawalsOf(runDir, dispatchId).length, 1);
});

test('verify fails on a ledger where a start follows a withdraw', (t) => {
  const { root, runId, runDir, dispatchId } = seedPending(t);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'retired' });

  // Hand-built corruption: the receipt says the request never ran, and the
  // ledger then dispatches it anyway. Only `verify` can catch this — the
  // library refuses the start, so it can only arrive by forgery.
  const requested = eventsOf(runDir).find(
    (event) => event.type === 'host_dispatch_requested' && event.extra.dispatch_id === dispatchId,
  )!;
  const path = join(runDir, 'events.jsonl');
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  // Ledger lines are flat: everything but type/step/timestamp/seq is `extra`.
  const forged = {
    seq: lines.length + 1,
    timestamp: new Date().toISOString(),
    type: 'actor_dispatched',
    step: 'implement',
    ...requested.extra,
    agent_id: 'forged-agent',
    delivery_transport: 'host',
    host_attested: true,
    identity_evidence: 'requested_only',
    attestation: {
      model: requested.extra.model,
      reasoning_effort: requested.extra.reasoning_effort,
      agent_type: requested.extra.agent_type,
      agent_id: 'forged-agent',
    },
  };
  appendFileSync(path, `${JSON.stringify(forged)}\n`);

  const lifecycle = runVerify({ repoRoot: root, run: runId }).findings.find(
    (finding) => finding.check === 'host-dispatch-lifecycle',
  )!;
  assert.equal(lifecycle.status, 'fail');
  assert.match(lifecycle.detail, new RegExp(`${dispatchId}: started after withdraw`));
});

test('withdraw preconditions each refuse with their own text', (t) => {
  const { root, runId, dispatchId } = seedPending(t);

  assert.throws(
    () => runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: '   ' }),
    (err: unknown) => err instanceof DispatchWithdrawError && /--reason must not be empty/.test((err as Error).message),
  );
  assert.throws(
    () => runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId: 'hd-nope', reason: 'x' }),
    (err: unknown) => err instanceof DispatchWithdrawError && /No host dispatch request "hd-nope"/.test((err as Error).message),
  );

  // Idempotent repeat, then a conflicting one.
  const first = runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'same reason' });
  assert.equal(first.idempotent, false);
  const repeat = runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'same reason' });
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.state, 'withdrawn');
  // The repeat replays the recorded receipt rather than re-deciding.
  assert.equal(repeat.workspaceRemoved, first.workspaceRemoved);
  assert.throws(
    () => runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'a different reason' }),
    (err: unknown) => err instanceof DispatchWithdrawError && /was already withdrawn for a different reason/.test((err as Error).message),
  );
});

test('withdraw refuses after a dispatch-start, and start refuses after a withdraw', (t) => {
  const started = seedPending(t);
  runDispatchStart({ repoRoot: started.root, run: started.runId, dispatchId: started.dispatchId, agentId: 'host-1' });
  assert.throws(
    () => runDispatchWithdraw({ repoRoot: started.root, run: started.runId, dispatchId: started.dispatchId, reason: 'too late' }),
    (err: unknown) =>
      err instanceof DispatchWithdrawError &&
      /cannot withdraw after dispatch-start; use dispatch-fail or dispatch-complete/.test((err as Error).message),
  );

  const retired = seedPending(t);
  runDispatchWithdraw({ repoRoot: retired.root, run: retired.runId, dispatchId: retired.dispatchId, reason: 'retired' });
  assert.throws(
    () => runDispatchStart({ repoRoot: retired.root, run: retired.runId, dispatchId: retired.dispatchId, agentId: 'host-1' }),
    /already has a terminal receipt/,
  );
});

test('a terminal run cannot withdraw', (t) => {
  const { root, runId, dispatchId } = seedPending(t);
  runRun({ repoRoot: root, run: runId, status: 'aborted' });
  assert.throws(
    () => runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'too late' }),
    (err: unknown) =>
      err instanceof DispatchWithdrawError && /is already aborted; a terminal run cannot withdraw/.test((err as Error).message),
  );
});

test('withdraw removes an isolated workspace prepared for the request', (t) => {
  const { root, runId, runDir, dispatchId } = seedPending(t, { git: true });
  const prepared = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId, isolate: true });
  assert.ok(existsSync(resolve(root, prepared.workspace)));

  const receipt = runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId, reason: 'never delivered' });
  assert.equal(receipt.workspaceRemoved, true);
  assert.equal(receipt.workspaceError, null);
  assert.equal(existsSync(resolve(root, prepared.workspace)), false, 'the prepared worktree is gone');

  const [event] = withdrawalsOf(runDir, dispatchId);
  assert.equal(event!.extra.workspace_removed, true);
  assert.equal(event!.extra.workspace, prepared.workspace);
});

test('hostRequestTerminalState reads one state per request, terminal receipts first', () => {
  const at = (type: string, dispatchId: string): RunEvent =>
    ({ seq: 1, ts: '2026-09-05T00:00:00.000Z', type, step: null, extra: { dispatch_id: dispatchId } }) as unknown as RunEvent;

  assert.equal(hostRequestTerminalState([], 'hd-1'), 'requested');
  assert.equal(hostRequestTerminalState([at('host_dispatch_requested', 'hd-1')], 'hd-1'), 'requested');
  assert.equal(hostRequestTerminalState([at('actor_dispatched', 'hd-1')], 'hd-1'), 'started');
  assert.equal(hostRequestTerminalState([at('host_dispatch_withdrawn', 'hd-1')], 'hd-1'), 'withdrawn');
  assert.equal(hostRequestTerminalState([at('actor_dispatched', 'hd-1'), at('actor_failed', 'hd-1')], 'hd-1'), 'failed');
  assert.equal(hostRequestTerminalState([at('actor_dispatched', 'hd-1'), at('actor_completed', 'hd-1')], 'hd-1'), 'completed');
  // A corrupt withdraw+start pair renders as the terminal receipt, never as
  // the start that should not have followed it.
  assert.equal(hostRequestTerminalState([at('host_dispatch_withdrawn', 'hd-1'), at('actor_dispatched', 'hd-1')], 'hd-1'), 'withdrawn');
  // Another request's receipts are not this one's.
  assert.equal(hostRequestTerminalState([at('actor_completed', 'hd-2')], 'hd-1'), 'requested');
});

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DISPATCHES_FILE, commandDispatchTerminalState } from '../src/commands/dispatch.ts';
import {
  runDispatches,
  runDispatchesCancel,
  runDispatchesMerge,
  runDispatchesOutput,
  runDispatchesWithdraw,
} from '../src/commands/dispatches.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import { tempRepo } from './helpers.ts';

/**
 * The second terminal receipt for a command dispatch.
 *
 * The field report these cover: `--cancel` refused two dead dispatches because
 * there was no claim to signal — correct, and left in place — and nothing else
 * could retire them, so both read as open forever. What is asserted here is
 * that the receipt is reachable exactly when nothing can be signalled, refused
 * when something can, and READ by every consumer that asks whether a dispatch
 * is still going.
 */

const ID = '11111111-2222-3333-4444-555555555555';
const SNAPSHOT = '.fadeno/local/outputs/11111111.md';

function requested(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: '1.1',
    timestamp: '2026-09-05T10:00:00.000Z',
    event: 'dispatch_requested',
    dispatch_id: ID,
    tag: 'worker-dead',
    archetype: 'worker',
    executor: 'slow',
    output_snapshot: SNAPSHOT,
    ...extra,
  };
}

function seed(t: import('node:test').TestContext, rows: Record<string, unknown>[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return root;
}

function rowsOf(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, DISPATCHES_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeClaim(root: string, claim: Record<string, unknown>): void {
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(join(root, ...INFLIGHT_DIR.split('/'), `${ID}.json`), JSON.stringify(claim));
}

const DEAD = (pid: number): never => {
  throw Object.assign(new Error('gone'), { code: 'ESRCH' });
};

test('the terminal-receipt list is the single reading of "is it over?"', () => {
  assert.equal(commandDispatchTerminalState('dispatch_completed'), 'completed');
  assert.equal(commandDispatchTerminalState('dispatch_withdrawn'), 'withdrawn');
  // A cancel is a REQUEST, never a receipt: the kernel still writes the
  // completion row, and treating this as terminal would retire a live dispatch.
  assert.equal(commandDispatchTerminalState('dispatch_cancelled'), null);
  assert.equal(commandDispatchTerminalState('dispatch_requested'), null);
  assert.equal(commandDispatchTerminalState(null), null);
});

test('withdraw records a terminal receipt for a dispatch with no claim at all', (t) => {
  const root = seed(t, [requested()]);
  const result = runDispatchesWithdraw({
    repoRoot: root,
    tag: 'worker-dead',
    reason: 'killed with its kernel by a session 429',
    now: new Date('2026-09-05T11:00:00.000Z'),
  });
  assert.equal(result.dispatchId, ID);
  assert.equal(result.idempotent, false);
  assert.equal(result.claim, 'none');
  assert.equal(result.workLeft, null);

  const row = rowsOf(root).find((r) => r.event === 'dispatch_withdrawn');
  assert.ok(row, 'a dispatch_withdrawn row is appended');
  assert.equal(row.dispatch_id, ID);
  assert.equal(row.tag, 'worker-dead');
  assert.equal(row.reason, 'killed with its kernel by a session 429');
  assert.equal(row.withdrawn_by, 'operator');
  assert.equal(row.claim, 'none');
  // It never invents an outcome: no exit code, no signal, no output digest.
  assert.equal(row.exit_code, undefined);
  assert.equal(row.output_sha256, undefined);
});

test('withdraw records a stale claim as stale and leaves the claim file in place', (t) => {
  const root = seed(t, [requested()]);
  writeClaim(root, { pid: 4242, supervisor_pid: 4242, executor_pid: 4343, process_group_id: 4343 });
  const result = runDispatchesWithdraw({
    repoRoot: root,
    dispatchId: ID,
    reason: 'recorded pids are absent',
    probe: DEAD,
  });
  assert.equal(result.claim, 'stale');
  const row = rowsOf(root).find((r) => r.event === 'dispatch_withdrawn');
  assert.equal(row?.claim, 'stale');
  // The claim is evidence of what happened; a receipt does not clean up after
  // a supervisor it never spoke to.
  assert.ok(readFileSync(join(root, ...INFLIGHT_DIR.split('/'), `${ID}.json`), 'utf8').length > 0);
});

test('withdraw refuses while a live executor is still behind the claim', (t) => {
  const root = seed(t, [requested()]);
  writeClaim(root, { pid: 4242, supervisor_pid: 4242 });
  assert.throws(
    () => runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'assume it is dead', probe: () => {} }),
    /still has a live executor \(pid 4242\).*--cancel/s,
  );
  assert.equal(rowsOf(root).some((r) => r.event === 'dispatch_withdrawn'), false, 'nothing is appended on a refusal');
});

test('withdraw refuses a completed dispatch and demands a reason', (t) => {
  const completed = seed(t, [
    requested(),
    { format: '1.1', timestamp: '2026-09-05T10:04:00.000Z', event: 'dispatch_completed', dispatch_id: ID, exit_code: 0, duration_ms: 240_000, output_sha256: 'abc', output_bytes: 12 },
  ]);
  assert.throws(
    () => runDispatchesWithdraw({ repoRoot: completed, dispatchId: ID, reason: 'too late' }),
    /already has a completion row/,
  );
  const open = seed(t, [requested()]);
  assert.throws(() => runDispatchesWithdraw({ repoRoot: open, dispatchId: ID, reason: '   ' }), /--reason is required/);
  assert.equal(rowsOf(open).length, 1);
});

test('withdraw is idempotent for the same reason and refuses a different one', (t) => {
  const root = seed(t, [requested()]);
  const first = runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'no executor to signal' });
  assert.equal(first.idempotent, false);
  const again = runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'no executor to signal' });
  assert.equal(again.idempotent, true);
  assert.equal(rowsOf(root).filter((r) => r.event === 'dispatch_withdrawn').length, 1, 'no second receipt is appended');
  assert.throws(
    () => runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'a different story' }),
    /already withdrawn for a different reason \(no executor to signal\)/,
  );
});

test('--work-left records the tree, must exist, and must be inside the repo', (t) => {
  const root = seed(t, [requested()]);
  mkdirSync(join(root, 'src'), { recursive: true });
  assert.throws(
    () => runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'dead', workLeft: 'nowhere/at/all' }),
    /does not exist/,
  );
  assert.throws(
    () => runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'dead', workLeft: '/etc' }),
    /outside the repository/,
  );
  const result = runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'dead', workLeft: 'src' });
  assert.equal(result.workLeft, 'src');
  assert.equal(rowsOf(root).find((r) => r.event === 'dispatch_withdrawn')?.work_left, 'src');
});

test('a withdrawn dispatch stops reading as open everywhere', (t) => {
  const root = seed(t, [requested()]);
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, SNAPSHOT), 'partial report\n');
  runDispatchesWithdraw({
    repoRoot: root,
    dispatchId: ID,
    reason: 'killed with its kernel',
    workLeft: 'src',
    now: new Date('2026-09-05T11:00:00.000Z'),
  });

  // The listing: the line that used to say "no completion recorded (killed or
  // in flight)" forever now names who ended it and where the work is.
  const listed = runDispatches({ repoRoot: root });
  assert.equal(listed.skipped, 0, 'the receipt is folded onto its dispatch, never counted as unreadable');
  assert.equal(listed.entries.length, 1, 'it folds onto the request rather than rendering its own line');
  const entry = listed.entries[0]!;
  assert.equal(entry.withdrawn, true);
  assert.equal(entry.completed, false, 'a withdraw is not a completion');
  assert.match(listed.lines[0]!, /WITHDRAWN/);
  assert.match(listed.lines[0]!, /killed with its kernel/);
  assert.match(listed.lines[0]!, /\[work left at src\]/);
  assert.doesNotMatch(listed.lines[0]!, /no completion recorded/);

  // Recovery: the bytes are still readable, and the verdict says not to wait.
  const output = runDispatchesOutput({ repoRoot: root, dispatchId: ID });
  assert.equal(output.bytes, 'partial report\n');
  assert.equal(output.attested, 'incomplete');
  assert.equal(output.withdrawn, true);
  assert.equal(output.withdrawnReason, 'killed with its kernel');

  // `--wait` must not poll for a completion row that is never coming.
  const started = Date.now();
  runDispatchesOutput({ repoRoot: root, dispatchId: ID, waitMs: 5_000, pollMs: 1_000 });
  assert.ok(Date.now() - started < 1_000, 'the wait loop returns at once for a withdrawn dispatch');

  // Cancel and merge both answer for the receipt instead of hunting a process.
  assert.throws(() => runDispatchesCancel({ repoRoot: root, dispatchId: ID }), /was withdrawn.*nothing to cancel/s);
  assert.throws(() => runDispatchesMerge({ repoRoot: root, dispatchId: ID }), /was withdrawn/);
});

test('a withdrawn dispatch stops holding "last" open and stops overlapping later ones', (t) => {
  const other = '99999999-8888-7777-6666-555555555555';
  const root = seed(t, [
    requested(),
    { format: '1.1', timestamp: '2026-09-05T12:00:00.000Z', event: 'dispatch_requested', dispatch_id: other, tag: 'worker-next', archetype: 'worker', output_snapshot: '.fadeno/local/outputs/99999999.md' },
    { format: '1.1', timestamp: '2026-09-05T12:01:00.000Z', event: 'dispatch_completed', dispatch_id: other, exit_code: 0, duration_ms: 60_000, output_sha256: 'x', output_bytes: 5 },
  ]);
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, SNAPSHOT), 'partial\n');
  writeFileSync(join(root, '.fadeno/local/outputs/99999999.md'), 'done\n');

  // Before the receipt the dead dispatch is the one `last` hands back: it is
  // the only "open" one, forever.
  assert.equal(runDispatchesOutput({ repoRoot: root, dispatchId: 'last' }).dispatchId, ID);

  runDispatchesWithdraw({ repoRoot: root, dispatchId: ID, reason: 'dead', now: new Date('2026-09-05T10:30:00.000Z') });

  // After it, nothing is open, and the retired dispatch's lifetime ENDED at
  // the receipt — so it no longer overlaps the later one and `last` resolves
  // by recency instead of refusing on a permanent phantom concurrency.
  const resolved = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(resolved.dispatchId, other);
  assert.equal(resolved.resolvedBy, 'recency');
});

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import { DispatchesCommandError, runDispatchesCancel } from '../src/commands/dispatches.ts';
import { INFLIGHT_DIR, readInflightClaim } from '../src/lib/supervisor.ts';
import { tempRepo } from './helpers.ts';

/**
 * `fadeno dispatches --cancel`.
 *
 * Reported 2026-08-14: a proxy correctly refuses to fold a mid-flight
 * amendment into a live dispatch, because a second executor would race the
 * first. But nothing could *stop* the first either, so a corrected instruction
 * had no path at all — not amendable, not safely re-dispatchable, not
 * abortable. Roughly half of dispatches outlive the caller's 600s window, so
 * this is the ordinary case.
 *
 * Delivering the amendment is impossible and not attempted: every driver is a
 * one-shot CLI whose stdin closed when the prompt was written. Cancel makes
 * the honest path — abort, then re-dispatch corrected — deterministic.
 */

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw');
}

function seedLedger(t: TestContext, rows: Array<Record<string, unknown>>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return root;
}

function claim(root: string, dispatchId: string, pid: number): void {
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(
    join(root, ...INFLIGHT_DIR.split('/'), `${dispatchId}.json`),
    JSON.stringify({ pid, started_at: '2026-08-14T10:00:00.000Z' }),
  );
}

const OPEN_ID = '11111111-2222-3333-4444-555555555555';
const openRow = {
  format: '0.2',
  timestamp: '2026-08-14T10:00:00.000Z',
  event: 'dispatch_requested',
  dispatch_id: OPEN_ID,
  tag: 'worker-live',
  archetype: 'worker',
  executor: 'slow',
  output_snapshot: '.fadeno/local/outputs/11111111.md',
};

test('cancelling a live dispatch signals its supervisor and records the request', (t) => {
  const root = seedLedger(t, [openRow]);
  claim(root, OPEN_ID, 4242);
  const signals: Array<[number, string]> = [];

  const result = runDispatchesCancel({
    repoRoot: root,
    tag: 'worker-live',
    kill: (pid, signal) => { signals.push([pid, signal]); },
    now: new Date('2026-08-14T10:05:00.000Z'),
  });

  assert.equal(result.dispatchId, OPEN_ID);
  assert.equal(result.resolvedBy, 'tag');
  // SIGTERM, never SIGKILL: the supervisor catches it and reaps the executor's
  // whole process group. SIGKILL would leave the orphan it exists to prevent.
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);

  const rows = readFileSync(join(root, DISPATCHES_FILE), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const cancelled = rows.find((row) => row.event === 'dispatch_cancelled');
  assert.ok(cancelled, 'no cancellation row written');
  assert.equal(cancelled.dispatch_id, OPEN_ID);
  assert.equal(cancelled.tag, 'worker-live');
  assert.equal(cancelled.supervisor_pid, 4242);
  assert.equal(cancelled.timestamp, '2026-08-14T10:05:00.000Z');
  // Stamped like every other row, so "which build cancelled this?" is answerable.
  assert.equal(typeof cancelled.fadeno_version, 'string');
  // Not a terminal event: the kernel still owns the completion row, and a
  // cancellation row standing in for one would report work as finished that
  // nothing observed finishing.
  assert.equal(rows.filter((row) => row.event === 'dispatch_completed').length, 0);
});

test('a dispatch that already completed is refused, not reported cancelled', (t) => {
  const root = seedLedger(t, [
    openRow,
    {
      format: '0.2',
      timestamp: '2026-08-14T10:01:00.000Z',
      event: 'dispatch_completed',
      dispatch_id: OPEN_ID,
      tag: 'worker-live',
      exit_code: 0,
      duration_ms: 60_000,
      output_bytes: 12,
      output_snapshot: '.fadeno/local/outputs/11111111.md',
    },
  ]);
  claim(root, OPEN_ID, 4242); // a stale claim must not resurrect a finished dispatch
  let signalled = false;

  const err = captureError(() =>
    runDispatchesCancel({ repoRoot: root, tag: 'worker-live', kill: () => { signalled = true; } }),
  );
  assert.match(err.message, /already completed/);
  // Points at the thing the caller actually wants next.
  assert.match(err.message, /--output tag:worker-live/);
  assert.equal(signalled, false, 'a finished dispatch must never be signalled');
});

test('an open dispatch with no claim on this machine refuses rather than claiming a kill', (t) => {
  // Open in the ledger but unclaimed: the kernel died without writing a
  // completion row, or the dispatch belongs to another host. There is no
  // process here to signal, and "cancelled" would be a claim about work this
  // call never touched.
  const root = seedLedger(t, [openRow]);
  const err = captureError(() => runDispatchesCancel({ repoRoot: root, tag: 'worker-live', kill: () => {} }));
  assert.match(err.message, /no running executor on this machine/);
  assert.match(err.message, /Nothing was signalled/);
  // The workspace may still hold half-finished work; say so before anyone re-dispatches.
  assert.match(err.message, /Check the workspace before re-dispatching/);

  const rows = readFileSync(join(root, DISPATCHES_FILE), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1, 'a refused cancel must not write evidence');
});

test('a failed signal is reported, not swallowed into a success', (t) => {
  const root = seedLedger(t, [openRow]);
  claim(root, OPEN_ID, 4242);
  const err = captureError(() =>
    runDispatchesCancel({
      repoRoot: root,
      tag: 'worker-live',
      kill: () => { throw new Error('ESRCH: no such process'); },
    }),
  );
  assert.match(err.message, /could not signal/);
  assert.match(err.message, /pid 4242/);
  const rows = readFileSync(join(root, DISPATCHES_FILE), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1, 'a cancel that never landed must not be recorded as one');
});

test('cancel names what to cancel, and resolves by id prefix as well as tag', (t) => {
  const root = seedLedger(t, [openRow]);
  claim(root, OPEN_ID, 77);
  const bare = captureError(() => runDispatchesCancel({ repoRoot: root }));
  assert.match(bare.message, /a dispatch id, an 8\+ character prefix, or tag:<handle>/);

  const byPrefix = runDispatchesCancel({ repoRoot: root, dispatchId: '11111111', kill: () => {} });
  assert.equal(byPrefix.dispatchId, OPEN_ID);
  assert.equal(byPrefix.resolvedBy, 'id');
});

test('an unusable claim reads as no claim rather than a signal to pid 0', () => {
  // Every unusable shape means the same thing to the caller — there is nothing
  // to signal — and a `pid` of 0 or -1 would signal a process group.
  for (const body of ['', 'not json', '{}', '{"pid":"4242"}', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}']) {
    assert.equal(readInflightClaim('x', () => body), null, `accepted ${JSON.stringify(body)}`);
  }
  assert.deepEqual(readInflightClaim('x', () => JSON.stringify({ pid: 9, started_at: 'T' })), {
    pid: 9,
    startedAt: 'T',
  });
  assert.deepEqual(readInflightClaim('x', () => { throw new Error('ENOENT'); }), null);
});

test('the executor profile is irrelevant to cancelling — the claim is the handle', (t) => {
  // Cancel must work when the catalog has since changed under it: the running
  // process is a fact, the catalog is only how it was chosen.
  const root = seedLedger(t, [openRow]);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({ schema_version: 2, targets: {}, routes: { claude: {} }, bindings: {} }),
  );
  claim(root, OPEN_ID, 31337);
  const signals: number[] = [];
  runDispatchesCancel({ repoRoot: root, tag: 'worker-live', kill: (pid) => { signals.push(pid); } });
  assert.deepEqual(signals, [31337]);
});

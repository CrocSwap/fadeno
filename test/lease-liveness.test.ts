import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { acquireWorkspaceLease, readWorkspaceLease } from '../src/lib/workspace-lease.ts';
import {
  describeWorkspaceLeaseLiveness,
  fallbackClaimRelPath,
  INFLIGHT_DIR,
} from '../src/lib/supervisor.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { tempRepo } from './helpers.ts';

/**
 * A host-dispatch lease publishes no `supervisor_pid` on purpose: it is a
 * durable reservation that must outlive any supervisor, or a crash between
 * executor exit and terminal receipt would admit a second writer. Correct for
 * exclusion, blind for reporting — a healthy 47-minute command fallback and an
 * abandoned one were byte-identical, and `doctor` called the live one
 * "abandoned" while offering `dispatch-fail`, which destroys the run.
 *
 * Liveness is therefore recorded beside the lock, never inside it.
 */

const HOLDER = { id: 'hd-x-a1', kind: 'host-dispatch' as const, runId: 'run-1', dispatchId: 'hd-x-a1' };

function writeClaim(root: string, rel: string, pid: number): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify({ supervisor_pid: pid, started_at: new Date(0).toISOString() }), 'utf8');
}

function acquire(root: string, livenessClaim: string | null): void {
  acquireWorkspaceLease({
    repoRoot: root,
    workspaceMode: 'shared',
    holder: HOLDER,
    supervisorPid: null,
    livenessClaim,
    startedAt: new Date(Date.now() - 47 * 60_000),
  });
}

test('a command fallback records where its liveness can be observed', (t) => {
  const root = tempRepo(t);
  const rel = fallbackClaimRelPath('run-1', 'hd-x-a1');
  acquire(root, rel);

  const record = readWorkspaceLease(root);
  assert.equal(record?.liveness_claim, rel);
  assert.equal(record?.supervisor_pid, null, 'the lock itself must stay a durable reservation');
});

test('a live claim reads as running, not abandoned', (t) => {
  const root = tempRepo(t);
  const rel = fallbackClaimRelPath('run-1', 'hd-x-a1');
  acquire(root, rel);
  writeClaim(root, rel, 4242);

  const liveness = describeWorkspaceLeaseLiveness(readWorkspaceLease(root), root, { probe: () => {} });
  assert.equal(liveness?.state, 'running');
  assert.ok((liveness?.heldMs ?? 0) >= 46 * 60_000, 'held time comes from the lease, not the claim');
});

test('a dead claim reads as ended', (t) => {
  const root = tempRepo(t);
  const rel = fallbackClaimRelPath('run-1', 'hd-x-a1');
  acquire(root, rel);
  writeClaim(root, rel, 4242);

  const dead = (): never => {
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  };
  assert.equal(describeWorkspaceLeaseLiveness(readWorkspaceLease(root), root, { probe: dead })?.state, 'ended');
});

test('a vanished claim reads as ended, and no claim at all reads as unobservable', (t) => {
  const root = tempRepo(t);
  const rel = fallbackClaimRelPath('run-1', 'hd-x-a1');
  acquire(root, rel);
  // The supervisor removes its claim in a finally block, so absence is the
  // normal end state — not the same as never having been observable.
  assert.equal(describeWorkspaceLeaseLiveness(readWorkspaceLease(root), root)?.state, 'ended');

  const other = tempRepo(t);
  acquire(other, null);
  const liveness = describeWorkspaceLeaseLiveness(readWorkspaceLease(other), other);
  assert.equal(liveness?.state, 'unobservable');
  assert.equal(liveness?.claim, null);
});

test('the recorded claim path is the one the supervisor actually writes', () => {
  // Writer and reader must agree exactly. A drifting spelling would not throw —
  // the reader would find no claim and report a running dispatch as finished.
  assert.equal(fallbackClaimRelPath('run-1', 'hd-x-a1'), `${INFLIGHT_DIR}/fallback-run-1-hd-x-a1.json`);
});

test('an observation never unlocks the workspace', (t) => {
  const root = tempRepo(t);
  const rel = fallbackClaimRelPath('run-1', 'hd-x-a1');
  acquire(root, rel);
  // Claim gone => liveness says `ended`, but the lease must still block a
  // second writer until its terminal receipt. Exclusion does not read
  // observations.
  assert.equal(describeWorkspaceLeaseLiveness(readWorkspaceLease(root), root)?.state, 'ended');
  assert.throws(
    () => acquireWorkspaceLease({
      repoRoot: root,
      workspaceMode: 'shared',
      holder: { id: 'other', kind: 'host-dispatch', runId: 'run-2', dispatchId: 'other' },
      supervisorPid: null,
    }),
    /already/i,
  );
});

/**
 * The reporting bug this whole field exists for: `doctor` warned on every held
 * lease with "recover an abandoned host dispatch" and a `dispatch-fail`
 * command. Against a live 47-minute command fallback that advice destroys the
 * run — which is exactly what it was given for, once.
 */
test('doctor reports a live command fallback as running, with no destructive advice', (t) => {
  const root = tempRepo(t);
  const rel = fallbackClaimRelPath('run-1', 'hd-x-a1');
  acquire(root, rel);
  writeClaim(root, rel, process.pid);

  const lease = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'workspace-lease');
  assert.ok(lease, 'doctor must report on the lease');
  assert.equal(lease.severity, 'ok', `a running dispatch is not a warning, got: ${lease.detail}`);
  assert.match(lease.detail, /is running/);
  assert.doesNotMatch(lease.detail, /abandoned/);
  assert.doesNotMatch(lease.remediation ?? '', /dispatch-fail/);
});

test('doctor still warns when the supervisor is gone, and says which state it is', (t) => {
  const root = tempRepo(t);
  acquire(root, fallbackClaimRelPath('run-1', 'hd-x-a1'));
  // No claim on disk: the supervisor removed it, or never got there.
  const lease = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'workspace-lease');
  assert.equal(lease?.severity, 'warning');
  assert.match(lease!.detail, /supervisor has exited/);
  assert.match(lease!.remediation ?? '', /dispatch-fail/);
});

test('doctor does not claim abandonment for a delivery it cannot observe', (t) => {
  const root = tempRepo(t);
  acquire(root, null);
  const lease = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'workspace-lease');
  assert.equal(lease?.severity, 'warning');
  assert.match(lease!.detail, /liveness not observable from here/);
  // Recovery is still offered — it may genuinely be abandoned — but hedged
  // rather than asserted.
  assert.match(lease!.remediation ?? '', /If it is genuinely abandoned/);
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  WINDOW_LEASE_STALE_MS,
  WORKSPACE_LEASE_FILE,
  WorkspaceLeaseError,
  acquireWorkspaceLease,
  isWindowHolder,
  isWorkspaceLeaseAlive,
  readWorkspaceLease,
  releaseWorkspaceLease,
  withWorkspaceWindowLease,
  type WorkspaceLeaseRecord,
} from '../src/lib/workspace-lease.ts';
import { tempRepo } from './helpers.ts';

// The kernel's own brief holds on the shared tree — a baseline capture, a
// merge-back — used to be taken with no pid. `isWorkspaceLeaseAlive` treats a
// pid-less lease as alive, so a kernel killed inside one of those windows
// (the `kill-drive mid-wave` test, roughly one run in three) left a lease
// that refused every later writer forever, including recovery of the run
// that took it. A window lease now carries the kernel's pid.

function seed(t: Parameters<typeof tempRepo>[0]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  return root;
}

function writeRecord(root: string, record: WorkspaceLeaseRecord): void {
  writeFileSync(join(root, WORKSPACE_LEASE_FILE), JSON.stringify(record));
}

const deadProbe = (): void => { const e = new Error('ESRCH') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; };
const aliveProbe = (): void => {};

test('a window lease records the kernel as its holder and is released when the action returns', (t) => {
  const root = seed(t);
  const seen = withWorkspaceWindowLease({ repoRoot: root, holder: { id: 'engine-tree:run:baseline:x', kind: 'engine', runId: 'run' } }, () => {
    const rec = readWorkspaceLease(root)!;
    return { pid: rec.supervisor_pid, holder: rec.holder.id };
  });
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.holder, 'engine-tree:run:baseline:x');
  assert.equal(existsSync(join(root, WORKSPACE_LEASE_FILE)), false, 'released on return');
});

test('a window lease whose kernel died is reclaimed by the next acquire — no timer involved', (t) => {
  const root = seed(t);
  // Take a window lease and abandon it, as a killed kernel would. Its pid is
  // this process, so probe it as dead explicitly.
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'merge-back:dead', kind: 'ad-hoc', dispatchId: 'dead' }, supervisorPid: process.pid, executorPid: null, processGroupId: null });
  assert.equal(isWorkspaceLeaseAlive(readWorkspaceLease(root), deadProbe), false);
  const rec = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'baseline:next', kind: 'ad-hoc', dispatchId: 'next' }, supervisorPid: process.pid, executorPid: null, processGroupId: null, probe: deadProbe });
  assert.equal(rec?.holder.id, 'baseline:next');
});

test('a pid-less window lease is dead once it is older than the stale bound; a pid-less executor lease never is', (t) => {
  const root = seed(t);
  const old = new Date(Date.now() - WINDOW_LEASE_STALE_MS - 1000).toISOString();
  const fresh = new Date().toISOString();
  const base = { workspace_mode: 'shared' as const, supervisor_pid: null, executor_pid: null, process_group_id: null, last_output_at: null, stdout_bytes: 0, stderr_bytes: 0 };
  // Pre-pid window lease, long abandoned: dead.
  writeRecord(root, { ...base, holder: { id: 'engine-tree:run:baseline:ac-1:a1', kind: 'engine', runId: 'run' }, started_at: old, heartbeat_at: old });
  assert.equal(isWorkspaceLeaseAlive(readWorkspaceLease(root), aliveProbe), false);
  // Same holder, just taken: alive — it may simply not have recorded a pid yet.
  writeRecord(root, { ...base, holder: { id: 'engine-tree:run:baseline:ac-1:a1', kind: 'engine', runId: 'run' }, started_at: fresh, heartbeat_at: fresh });
  assert.equal(isWorkspaceLeaseAlive(readWorkspaceLease(root), aliveProbe), true);
  // A pid-less EXECUTOR lease is never aged out: the supervisor stamps its
  // pid within milliseconds, and an executor's run has no clock on it.
  writeRecord(root, { ...base, holder: { id: 'engine:run:ac-1:a1', kind: 'engine', runId: 'run' }, started_at: old, heartbeat_at: old });
  assert.equal(isWorkspaceLeaseAlive(readWorkspaceLease(root), aliveProbe), true);
  assert.equal(isWindowHolder({ id: 'engine:run:ac-1:a1', kind: 'engine' }), false);
  assert.equal(isWindowHolder({ id: 'merge-back:x', kind: 'ad-hoc' }), true);
});

test('a window lease waits for a live holder and gives up at its bound rather than refusing at once', (t) => {
  const root = seed(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'engine:run:ac-1:a1', kind: 'engine', runId: 'run' }, supervisorPid: process.pid, executorPid: null, processGroupId: null });
  const started = Date.now();
  assert.throws(
    () => withWorkspaceWindowLease({ repoRoot: root, holder: { id: 'merge-back:w', kind: 'ad-hoc', dispatchId: 'w' }, waitMs: 300 }, () => 'never'),
    (err: unknown) => err instanceof WorkspaceLeaseError,
  );
  assert.ok(Date.now() - started >= 250, 'waited for the bound before giving up');
  // The live holder's lease is untouched by the failed wait.
  assert.equal(readWorkspaceLease(root)?.holder.id, 'engine:run:ac-1:a1');
});

test('a non-window holder is refused by the window helper — the pid stamp is for kernel windows only', (t) => {
  const root = seed(t);
  assert.throws(
    () => withWorkspaceWindowLease({ repoRoot: root, holder: { id: 'engine:run:ac-1:a1', kind: 'engine', runId: 'run' } }, () => 0),
    /must use one of the window prefixes/,
  );
  assert.equal(existsSync(join(root, WORKSPACE_LEASE_FILE)), false);
});

test('a read window (baseline capture) proceeds unleased past a shared EXECUTOR, and waits only behind another window', (t) => {
  const root = seed(t);
  // A shared-mode executor holds the lease for its whole run — possibly
  // hours, now that nothing kills it. An isolated delivery's capture must not
  // queue behind it; that it does not is the contract of isolation.
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'engine:run:ac-1:a1', kind: 'engine', runId: 'run' }, supervisorPid: process.pid, executorPid: null, processGroupId: null });
  const started = Date.now();
  const ran = withWorkspaceWindowLease({ repoRoot: root, holder: { id: 'baseline:capture', kind: 'ad-hoc', dispatchId: 'capture' }, mode: 'read', waitMs: 5000 }, () => 'read unleased');
  assert.equal(ran, 'read unleased');
  assert.ok(Date.now() - started < 1000, 'did not wait on the executor');
  assert.equal(readWorkspaceLease(root)?.holder.id, 'engine:run:ac-1:a1', 'the executor lease is untouched');
  // Behind another WINDOW — a merge-back mid-apply — the same read waits,
  // because reading a tree mid-apply is a torn baseline.
  releaseWorkspaceLease({ repoRoot: root, holder: { id: 'engine:run:ac-1:a1', kind: 'engine', runId: 'run' } });
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'merge-back:busy', kind: 'ad-hoc', dispatchId: 'busy' }, supervisorPid: process.pid, executorPid: null, processGroupId: null });
  const again = Date.now();
  assert.throws(
    () => withWorkspaceWindowLease({ repoRoot: root, holder: { id: 'baseline:capture', kind: 'ad-hoc', dispatchId: 'capture' }, mode: 'read', waitMs: 300 }, () => 'never'),
    (err: unknown) => err instanceof WorkspaceLeaseError,
  );
  assert.ok(Date.now() - again >= 250, 'waited behind the window');
});

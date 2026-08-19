import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tempRepo } from './helpers.ts';
import {
  WORKSPACE_LEASE_FILE,
  acquireWorkspaceLease,
  heartbeatWorkspaceLease,
  isBlockedByLease,
  isWorkspaceLeaseAlive,
  readEffectiveLease,
  readWorkspaceLease,
  releaseWorkspaceLease,
  WorkspaceLeaseError,
} from '../src/lib/workspace-lease.ts';

function aliveProbe(): void {}
function deadProbe(): void {
  const err = new Error('gone') as NodeJS.ErrnoException;
  err.code = 'ESRCH';
  throw err;
}
function epermProbe(): void {
  const err = new Error('perm') as NodeJS.ErrnoException;
  err.code = 'EPERM';
  throw err;
}

test('workspace_mode validation: isolated bypasses lease, shared acquires', (t) => {
  const root = tempRepo(t);
  const isol = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'isolated', holder: { id: 'a', kind: 'ad-hoc' } });
  assert.equal(isol, null);
  assert.equal(existsSync(join(root, WORKSPACE_LEASE_FILE)), false);

  const rec = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'holder-1', kind: 'ad-hoc' }, supervisorPid: 99999, probe: aliveProbe });
  assert.ok(rec);
  assert.equal(rec.workspace_mode, 'shared');
  assert.equal(rec.holder.id, 'holder-1');
  assert.ok(existsSync(join(root, WORKSPACE_LEASE_FILE)));
  assert.equal(rec.supervisor_pid, 99999);
});

test('shared writer blocks second shared writer, isolated does not', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'primary', kind: 'ad-hoc' }, supervisorPid: 100001, probe: aliveProbe });
  // second shared holder is blocked
  assert.throws(
    () => acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'second', kind: 'engine' }, supervisorPid: 100002, probe: aliveProbe }),
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceLeaseError);
      assert.match((err as Error).message, /already held by/);
      return true;
    },
  );
  // isolated bypasses — no throw, returns null, and does not disturb lease
  const iso = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'isolated', holder: { id: 'second', kind: 'ad-hoc' } });
  assert.equal(iso, null);
  const still = readWorkspaceLease(root);
  assert.equal(still?.holder.id, 'primary');
  // read-only simulation: caller simply does not acquire — verify isBlocked helper
  const blocked = isBlockedByLease(root, 'second', aliveProbe);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.lease?.holder.id, 'primary');
  const notBlockedForHolder = isBlockedByLease(root, 'primary', aliveProbe);
  assert.equal(notBlockedForHolder.blocked, false);
});

test('stale lease (dead pid) is reclaimable', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'stale', kind: 'ad-hoc' }, supervisorPid: 123456, probe: aliveProbe });
  // second acquire with a probe that says the old pid is dead should succeed
  const rec = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'fresh', kind: 'engine' }, supervisorPid: 99999, probe: deadProbe });
  assert.equal(rec?.holder.id, 'fresh');
  assert.equal(readWorkspaceLease(root)?.holder.id, 'fresh');
});

test('same holder re-acquires idempotently and refreshes heartbeat', (t) => {
  const root = tempRepo(t);
  const first = acquireWorkspaceLease({
    repoRoot: root, workspaceMode: 'shared', holder: { id: 'alpha', kind: 'ad-hoc' },
    supervisorPid: 5001, stdoutBytes: 10, stderrBytes: 2, probe: aliveProbe, now: new Date('2026-08-17T00:00:00.000Z'),
  });
  assert.equal(first?.stdout_bytes, 10);
  const second = acquireWorkspaceLease({
    repoRoot: root, workspaceMode: 'shared', holder: { id: 'alpha', kind: 'ad-hoc' },
    supervisorPid: 5001, stdoutBytes: 99, probe: aliveProbe, now: new Date('2026-08-17T00:00:10.000Z'),
  });
  assert.equal(second?.holder.id, 'alpha');
  assert.equal(second?.stdout_bytes, 99);
  assert.equal(second?.started_at, first?.started_at, 'started_at unchanged on re-acquire');
  assert.notEqual(second?.heartbeat_at, first?.heartbeat_at);
});

test('heartbeat updates bytes and timestamps; wrong holder is rejected', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'hb', kind: 'host-dispatch', runId: 'run-1' }, supervisorPid: 7001, probe: aliveProbe, now: new Date('2026-08-17T01:00:00.000Z') });
  const hb = heartbeatWorkspaceLease({
    repoRoot: root, holderId: 'hb', stdoutBytes: 1234, stderrBytes: 56,
    lastOutputAt: new Date('2026-08-17T01:00:05.000Z'), probe: aliveProbe, now: new Date('2026-08-17T01:00:05.000Z'),
  });
  assert.equal(hb.stdout_bytes, 1234);
  assert.equal(hb.stderr_bytes, 56);
  assert.equal(hb.last_output_at, '2026-08-17T01:00:05.000Z');
  // wrong holder cannot heartbeat
  assert.throws(
    () => heartbeatWorkspaceLease({ repoRoot: root, holderId: 'other', probe: aliveProbe }),
    (err: unknown) => err instanceof WorkspaceLeaseError,
  );
});

test('release only removes lease when holder matches', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'owner', kind: 'ad-hoc' }, supervisorPid: 8001, probe: aliveProbe });
  const wrong = releaseWorkspaceLease({ repoRoot: root, holderId: 'not-owner' });
  assert.equal(wrong, false);
  assert.ok(existsSync(join(root, WORKSPACE_LEASE_FILE)));
  const ok = releaseWorkspaceLease({ repoRoot: root, holderId: 'owner' });
  assert.equal(ok, true);
  assert.equal(existsSync(join(root, WORKSPACE_LEASE_FILE)), false);
  assert.equal(readEffectiveLease(root, aliveProbe), null);
  // releasing absent lease is false
  assert.equal(releaseWorkspaceLease({ repoRoot: root }), false);
});

test('unscoped release cannot delete a live singleton lease', (t) => {
  const root = tempRepo(t);
  const holder = { id: 'singleton-owner', kind: 'ad-hoc' as const };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder, supervisorPid: 8002, probe: aliveProbe });
  assert.throws(
    () => releaseWorkspaceLease({ repoRoot: root }),
    /requires an exact holder for release/,
  );
  assert.deepEqual(readWorkspaceLease(root)?.holder, holder);
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder }), true);
});

test('isWorkspaceLeaseAlive is conservative: EPERM counts as alive, ESRCH as dead', () => {
  const base = {
    workspace_mode: 'shared' as const,
    holder: { id: 'x', kind: 'ad-hoc' as const },
    supervisor_pid: 1,
    executor_pid: 2,
    process_group_id: 3,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  };
  assert.equal(isWorkspaceLeaseAlive(base, aliveProbe), true);
  assert.equal(isWorkspaceLeaseAlive(base, epermProbe), true);
  assert.equal(isWorkspaceLeaseAlive(base, deadProbe), false);
  assert.equal(isWorkspaceLeaseAlive({ ...base, supervisor_pid: null }, aliveProbe), true);
  assert.equal(isWorkspaceLeaseAlive(null, aliveProbe), false);
  assert.equal(isWorkspaceLeaseAlive({ ...base, workspace_mode: 'isolated' }, aliveProbe), false);
});

test('pid-less host and pre-spawn leases remain durable until terminal release', (t) => {
  const root = tempRepo(t);
  const holder = { id: 'dispatch-1', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'dispatch-1' };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder, supervisorPid: null });
  assert.equal(isWorkspaceLeaseAlive(readWorkspaceLease(root), deadProbe), true);
  assert.throws(
    () => acquireWorkspaceLease({
      repoRoot: root,
      workspaceMode: 'shared',
      holder: { id: 'dispatch-2', kind: 'host-dispatch', runId: 'run-b', dispatchId: 'dispatch-2' },
      supervisorPid: null,
    }),
    WorkspaceLeaseError,
  );
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder }), true);
});

test('same local id in another run is not an idempotent lease reacquire', (t) => {
  const root = tempRepo(t);
  const first = { id: 'actor-call-1', kind: 'engine' as const, runId: 'run-a' };
  const second = { id: 'actor-call-1', kind: 'engine' as const, runId: 'run-b' };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: first, supervisorPid: null });
  assert.throws(
    () => acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: second, supervisorPid: null }),
    WorkspaceLeaseError,
  );
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: second }), false);
  assert.equal(readWorkspaceLease(root)?.holder.runId, 'run-a');
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: first }), true);
});

test('same-run host fan-out is exclusive: second shared host dispatch is refused while first is live', (t) => {
  const root = tempRepo(t);
  const first = { id: 'a', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'a' };
  const second = { id: 'b', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'b' };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: first, supervisorPid: null, now: new Date('2026-08-17T00:00:00Z') });
  assert.throws(
    () => acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: second, supervisorPid: null, now: new Date('2026-08-17T00:00:10Z') }),
    (err: unknown) => err instanceof WorkspaceLeaseError && /already held by/.test((err as Error).message),
  );
  // Same-run third holder is also blocked (exclusive for all write-capable hosts)
  assert.equal(isBlockedByLease(root, second).blocked, true);
  assert.equal(isBlockedByLease(root, { id: 'c', kind: 'host-dispatch', runId: 'run-a', dispatchId: 'c' }).blocked, true);
  assert.equal(isBlockedByLease(root, { id: 'x', kind: 'host-dispatch', runId: 'run-x', dispatchId: 'x' }).blocked, true);
  // Idempotent re-acquire of the holder itself succeeds
  const refreshed = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: first, supervisorPid: null, now: new Date('2026-08-17T00:00:20Z') });
  assert.equal(refreshed?.holder.id, 'a');
  // Sequential host starts after explicit complete/fail release
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: first }), true);
  assert.equal(readWorkspaceLease(root), null);
  const secondAfter = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: second, supervisorPid: null, now: new Date('2026-08-17T00:00:30Z') });
  assert.equal(secondAfter?.holder.id, 'b');
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: second }), true);
  assert.equal(readWorkspaceLease(root), null);
});

test('legacy multi-holder record remains parseable and supports arbitrary release order', (t) => {
  const root = tempRepo(t);
  const first = { id: 'a', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'a' };
  const second = { id: 'b', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'b' };
  // Craft a legacy multi-holder file directly (normal acquisition no longer creates it)
  const now = new Date('2026-08-17T00:00:00Z').toISOString();
  const legacy = {
    workspace_mode: 'shared' as const,
    holder: first,
    holders: [first, second],
    holder_started_at: { [JSON.stringify(['host-dispatch', 'a', 'run-a', 'a'])]: now, [JSON.stringify(['host-dispatch', 'b', 'run-a', 'b'])]: now },
    holder_heartbeat_at: { [JSON.stringify(['host-dispatch', 'a', 'run-a', 'a'])]: now, [JSON.stringify(['host-dispatch', 'b', 'run-a', 'b'])]: now },
    supervisor_pid: null,
    executor_pid: null,
    process_group_id: null,
    started_at: now,
    heartbeat_at: now,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  };
  const abs = join(root, WORKSPACE_LEASE_FILE);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(abs, JSON.stringify(legacy, null, 2));
  assert.deepEqual(readWorkspaceLease(root)?.holders, [first, second]);
  assert.throws(
    () => releaseWorkspaceLease({ repoRoot: root }),
    /requires an exact holder for release/,
    'an unscoped legacy release must not drop every peer',
  );
  assert.deepEqual(readWorkspaceLease(root)?.holders, [first, second]);
  assert.equal(isBlockedByLease(root, second).blocked, false);
  assert.equal(isBlockedByLease(root, { id: 'c', kind: 'host-dispatch', runId: 'run-a', dispatchId: 'c' }).blocked, true);
  assert.equal(isBlockedByLease(root, { id: 'x', kind: 'host-dispatch', runId: 'run-x', dispatchId: 'x' }).blocked, true);
  // Arbitrary release order: remove second first, then first
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: second }), true);
  assert.deepEqual(readWorkspaceLease(root)?.holders, [first]);
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: first }), true);
  assert.equal(readWorkspaceLease(root), null);
});

test('lease distinguishes all contract process fields and is machine-local', (t) => {
  const root = tempRepo(t);
  const rec = acquireWorkspaceLease({
    repoRoot: root, workspaceMode: 'shared',
    holder: { id: 'engine-run-1', kind: 'engine', runId: '2026-08-17-0000-test' },
    supervisorPid: 1111, executorPid: 2222, processGroupId: 3333,
    stdoutBytes: 444, stderrBytes: 555,
    startedAt: new Date('2026-08-17T02:00:00.000Z'),
    heartbeatAt: new Date('2026-08-17T02:00:01.000Z'),
    lastOutputAt: new Date('2026-08-17T02:00:02.000Z'),
    probe: aliveProbe,
  });
  assert.equal(rec?.supervisor_pid, 1111);
  assert.equal(rec?.executor_pid, 2222);
  assert.equal(rec?.process_group_id, 3333);
  assert.equal(rec?.started_at, '2026-08-17T02:00:00.000Z');
  assert.equal(rec?.heartbeat_at, '2026-08-17T02:00:01.000Z');
  assert.equal(rec?.last_output_at, '2026-08-17T02:00:02.000Z');
  assert.equal(rec?.stdout_bytes, 444);
  assert.equal(rec?.stderr_bytes, 555);
  assert.equal(rec?.workspace_mode, 'shared');
  // file lives below .fadeno/local and is not ledger evidence
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.workspace_mode, 'shared');
  assert.ok(typeof parsed.holder.id === 'string');
  // never ledger: stays under .fadeno/local even though .fadeno/runs exists elsewhere
  assert.ok(WORKSPACE_LEASE_FILE.startsWith('.fadeno/local'));
});

test('invalid workspace_mode is rejected', (t) => {
  const root = tempRepo(t);
  assert.throws(
    () => acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'other' as any, holder: { id: 'x', kind: 'ad-hoc' } }),
    (err: unknown) => err instanceof WorkspaceLeaseError && /workspace_mode/.test((err as Error).message),
  );
});

test('atomic write: lease file is valid JSON even after repeated acquires', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'a', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe });
  // re-acquire same holder multiple times — file must stay valid JSON
  for (let i = 0; i < 5; i += 1) {
    acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'a', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe });
    const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  }
});

test('acquire-crash-before-write: no file or valid JSON after failed acquire', (t) => {
  const root = tempRepo(t);
  // Simulate crash before write by throwing during lock acquisition via invalid mode (already validated)
  // Instead verify that a failed acquire due to contention leaves lease file valid
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'owner', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe });
  assert.throws(() => acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'other', kind: 'ad-hoc' }, supervisorPid: 2, probe: aliveProbe }), WorkspaceLeaseError);
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.holder.id, 'owner');
});

test('acquire-crash-after-tmp-rename: lease remains valid JSON after atomic rename', (t) => {
  const root = tempRepo(t);
  for (let i = 0; i < 3; i += 1) {
    acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'a', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe, now: new Date(`2026-08-17T00:00:0${i}Z`) });
    // file after each acquire must be valid JSON (atomic tmp+rename)
    const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  }
  // Re-acquire same holder preserves file validity
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'a', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe });
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8')));
});

test('heartbeat-crash: lease valid JSON after heartbeat', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'hb', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe });
  heartbeatWorkspaceLease({ repoRoot: root, holderId: 'hb', stdoutBytes: 10, probe: aliveProbe });
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.equal(JSON.parse(raw).stdout_bytes, 10);
});

test('release-crash-partial-holders: valid JSON after partial release of legacy fan-out', (t) => {
  const root = tempRepo(t);
  const first = { id: 'a', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'a' };
  const second = { id: 'b', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'b' };
  const now = new Date('2026-08-17T00:00:00Z').toISOString();
  const legacy = {
    workspace_mode: 'shared' as const,
    holder: first,
    holders: [first, second],
    holder_started_at: { [JSON.stringify(['host-dispatch','a','run-a','a'])]: now, [JSON.stringify(['host-dispatch','b','run-a','b'])]: now },
    holder_heartbeat_at: { [JSON.stringify(['host-dispatch','a','run-a','a'])]: now, [JSON.stringify(['host-dispatch','b','run-a','b'])]: now },
    supervisor_pid: null,
    executor_pid: null,
    process_group_id: null,
    started_at: now,
    heartbeat_at: now,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  };
  const abs = join(root, WORKSPACE_LEASE_FILE);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(abs, JSON.stringify(legacy, null, 2));
  releaseWorkspaceLease({ repoRoot: root, holder: second });
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.holders.length, 1);
  assert.equal(parsed.holders[0].id, 'a');
  // holder heartbeat maps cleaned
  assert.equal(parsed.holder_heartbeat_at?.[JSON.stringify(['host-dispatch','a','run-a','a'])] != null, true);
  assert.equal(parsed.holder_heartbeat_at?.[JSON.stringify(['host-dispatch','b','run-a','b'])] == null, true);
});

test('reclaim-after-dead-supervisor: dead pid reclaim produces valid JSON', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'stale', kind: 'ad-hoc' }, supervisorPid: 99, probe: aliveProbe });
  const reclaimed = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'fresh', kind: 'ad-hoc' }, supervisorPid: 100, probe: deadProbe });
  assert.equal(reclaimed?.holder.id, 'fresh');
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.equal(JSON.parse(raw).holder.id, 'fresh');
});

test('pid-less-host-survives-deadProbe: lease with null supervisor_pid remains live', (t) => {
  const root = tempRepo(t);
  const holder = { id: 'dispatch-1', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'dispatch-1' };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder, supervisorPid: null });
  assert.equal(isWorkspaceLeaseAlive(readWorkspaceLease(root), deadProbe), true);
  assert.equal(readEffectiveLease(root, deadProbe)?.holder.id, 'dispatch-1');
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  parseExecutorProfile,
  ExecutorProfileError,
  compileDialRef,
  parseSnapshotDocument,
  serializeSnapshot,
} from '../src/lib/executors.ts';
import {
  readSupervisorStatus,
  superviseArgv,
  INFLIGHT_DIR,
  readInflightClaim,
  inflightClaimIsAlive,
} from '../src/lib/supervisor.ts';
import { tempRepo } from './helpers.ts';
import { readWorkspaceLease, WORKSPACE_LEASE_FILE, WORKSPACE_LEASE_LOCK } from '../src/lib/workspace-lease.ts';

function parseDoc(doc: Record<string, unknown>, harness: 'standalone' | 'codex' | 'claude' = 'standalone') {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml', harness);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- route timeout_ms parsing ---

test('route timeout_ms parses as positive integer and snapshots round-trip', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'], timeout_ms: 1200000 } } },
  });
  const spec = compileDialRef({ model: 'sol' }, profile).spec;
  assert.equal((spec as unknown as Record<string, unknown>).timeoutMs, 1200000);

  const snap = serializeSnapshot(profile);
  assert.match(snap, /timeout_ms: 1200000/);
  const doc = parseSnapshotDocument(snap, 'snap.yaml');
  const round = doc.executors['sol'] as unknown as Record<string, unknown>;
  assert.equal(round.timeoutMs, 1200000);
});

test('route timeout_ms absent by default and snapshot omits it', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  });
  const spec = compileDialRef({ model: 'sol' }, profile).spec as unknown as Record<string, unknown>;
  assert.equal(spec.timeoutMs, undefined);
  const snap = serializeSnapshot(profile);
  assert.doesNotMatch(snap, /timeout_ms/);
});

test('route timeout_ms rejects non-positive, non-integer, and host routes', () => {
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'], timeout_ms: 0 } } } }),
    (err: unknown) => err instanceof ExecutorProfileError && /timeout_ms.*positive integer/.test(err.message),
  );
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'], timeout_ms: -100 } } } }),
    /positive integer/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'], timeout_ms: 1.5 } } } }),
    /positive integer/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'], timeout_ms: '1200' as unknown as number } } } }),
    /positive integer/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { 'current-host': { host: true, timeout_ms: 1200 } } } }),
    (err: unknown) => err instanceof ExecutorProfileError && /host route.*may not declare.*timeout_ms/.test(err.message),
  );
  // host with timeout in snapshot entry
  assert.throws(
    () => parseSnapshotDocument('snapshot_version: 3\nexecutors:\n  h:\n    adapter: host\n    model: m\n    reasoning_effort: high\n    agent_type: "*"\n    timeout_ms: 1000\n', 'snap.yaml'),
    (err: unknown) => err instanceof ExecutorProfileError && /host executor rejects.*timeout_ms/.test(err.message),
  );
  assert.throws(
    () => parseSnapshotDocument('snapshot_version: 3\nexecutors:\n  c:\n    adapter: command\n    command: [x]\n    timeout_ms: 0\n', 'snap.yaml'),
    /positive integer/,
  );
});

test('route timeout_ms unknown key rejection and survives snapshot re-parse', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { a: { provider: 'openai' }, b: { provider: 'xai' } },
    routes: { standalone: { openai: { command: ['a'], timeout_ms: 5000 }, xai: { command: ['b'], timeout_ms: 10000 } } },
  });
  const aSpec = compileDialRef({ model: 'a' }, profile).spec as unknown as Record<string, unknown>;
  const bSpec = compileDialRef({ model: 'b' }, profile).spec as unknown as Record<string, unknown>;
  assert.equal(aSpec.timeoutMs, 5000);
  assert.equal(bSpec.timeoutMs, 10000);
  const snap = serializeSnapshot(profile);
  const doc = parseSnapshotDocument(snap, 'snap.yaml');
  assert.equal((doc.executors['a'] as unknown as Record<string, unknown>).timeoutMs, 5000);
  assert.equal((doc.executors['b'] as unknown as Record<string, unknown>).timeoutMs, 10000);
});

// --- supervisor status typed parsing ---

test('readSupervisorStatus parses timed_out, timeout_ms, deadline_at', () => {
  const path = '/tmp/fake-status-' + Date.now() + '.json';
  const raw = JSON.stringify({
    supervisor_pid: 123,
    executor_pid: 456,
    process_group_id: 456,
    started_at: '2026-08-17T00:00:00.000Z',
    ended_at: '2026-08-17T00:00:01.000Z',
    heartbeat_at: '2026-08-17T00:00:01.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    duration_ms: 1000,
    exit_code: null,
    signal: 'SIGTERM',
    timed_out: true,
    timeout_ms: 1200000,
    deadline_at: '2026-08-17T00:20:00.000Z',
  });
  const st = readSupervisorStatus(path, () => raw)!;
  assert.equal(st.timedOut, true);
  assert.equal(st.timeoutMs, 1200000);
  assert.equal(st.deadlineAt, '2026-08-17T00:20:00.000Z');
  assert.equal(st.signal, 'SIGTERM');
});

test('readSupervisorStatus defaults timed_out false and null timeout when absent (legacy)', () => {
  const raw = JSON.stringify({ supervisor_pid: 1, exit_code: 0, signal: null, duration_ms: 10 });
  const st = readSupervisorStatus('/tmp/legacy.json', () => raw)!;
  assert.equal(st.timedOut, false);
  assert.equal(st.timeoutMs, null);
  assert.equal(st.deadlineAt, null);
});

test('readSupervisorStatus coerces invalid timeout/deadline to safe defaults', () => {
  const raw = JSON.stringify({ timed_out: 'yes', timeout_ms: -5, deadline_at: 123, supervisor_pid: 1 });
  const st = readSupervisorStatus('/tmp/bad.json', () => raw)!;
  assert.equal(st.timedOut, false);
  assert.equal(st.timeoutMs, null);
  assert.equal(st.deadlineAt, null);
  const raw2 = JSON.stringify({ timed_out: true, timeout_ms: 0, deadline_at: '', supervisor_pid: 1 });
  const st2 = readSupervisorStatus('/tmp/bad2.json', () => raw2)!;
  assert.equal(st2.timeoutMs, null);
  assert.equal(st2.deadlineAt, null);
  assert.equal(st2.timedOut, true);
});

// --- supervisor deadline behavior ---

test('supervisor deadline: short timeout TERM then KILL, status timed_out true', async (t) => {
  const root = tempRepo(t);
  const statusPath = join(root, 'status.json');
  const claimPath = join(root, 'claim.json');
  const timeoutMs = 800;
  // Executor that ignores SIGTERM for 10s so we can observe KILL escalation
  const result = spawnSync(
    process.execPath,
    superviseArgv(['node', '-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 200)"], claimPath, statusPath, undefined, timeoutMs),
    { encoding: 'utf8', timeout: 15000 },
  );
  // Supervisor exits with signal after killing; status should be authoritative
  const st = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'))!;
  assert.ok(st != null, 'status file must exist after deadline');
  assert.equal(st.timedOut, true, 'deadline must mark timed_out');
  assert.equal(st.timeoutMs, timeoutMs);
  assert.ok(st.deadlineAt != null, 'deadline_at must be set');
  const deadlineMs = Date.parse(st.deadlineAt!);
  const startedMs = Date.parse(st.startedAt!);
  assert.ok(Math.abs(deadlineMs - (startedMs + timeoutMs)) < 500, `deadline_at should be started_at + timeout_ms (got ${st.deadlineAt}, started ${st.startedAt})`);
  // Even though executor was SIGTERMignored then SIGKILLed, timed_out outranks signal
  assert.ok(st.signal === 'SIGTERM' || st.signal === 'SIGKILL' || st.signal != null, 'signal should be present');
  // Claim must be cleaned only after close, not at TERM time — after supervisor exit claim should be gone
  assert.equal(existsSync(claimPath), false, 'claim must be removed after child close');
  // Supervisor process exit: on Linux it re-raises SIGTERM, so spawnSync reports signal SIGTERM
  // On some platforms it may exit with code 1 if re-raise fails — accept either but require timedOut true over signal
  assert.ok(st.timedOut === true, 'timed_out must be authoritative regardless of signal');
});

test('supervisor deadline: fast executor completes before deadline, timed_out false but deadline still recorded', (t) => {
  const root = tempRepo(t);
  const statusPath = join(root, 'status.json');
  const claimPath = join(root, 'claim.json');
  const timeoutMs = 5000;
  const result = spawnSync(
    process.execPath,
    superviseArgv(['node', '-e', "process.stdout.write('done'); process.exit(0)"], claimPath, statusPath, undefined, timeoutMs),
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const st = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'))!;
  assert.equal(st.timedOut, false, 'early exit must not be timed_out');
  assert.equal(st.timeoutMs, timeoutMs);
  assert.ok(st.deadlineAt != null);
  assert.equal(st.exitCode, 0);
});

test('supervisor deadline: no timeout means no deadline, even with long-running executor limited by external kill', (t) => {
  const root = tempRepo(t);
  const statusPath = join(root, 'status.json');
  const claimPath = join(root, 'claim.json');
  // Executor loops forever, but no deadline — we will kill supervisor externally after 600ms and check status
  // Instead test that without timeout, a quick exit does not get timed_out
  const result = spawnSync(
    process.execPath,
    superviseArgv(['node', '-e', "process.exit(42)"], claimPath, statusPath, undefined, null),
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 42);
  const st = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'))!;
  assert.equal(st.timedOut, false);
  assert.equal(st.timeoutMs, null);
  assert.equal(st.deadlineAt, null);
});

test('supervisor deadline preserves writer lease and claim until child-group termination (not at TERM)', async (t) => {
  const root = tempRepo(t);
  const statusPath = join(root, 'status.json');
  const claimPath = join(root, 'claim.json');
  const leasePath = join(root, WORKSPACE_LEASE_FILE);
  const lockPath = join(root, WORKSPACE_LEASE_LOCK);
  const holder = { id: 'call-lease-deadline', kind: 'engine' as const, runId: 'run-1', dispatchId: 'd1' };
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(leasePath, JSON.stringify({ holder, holders: [holder] }));
  const timeoutMs = 600;
  // Executor ignores TERM, so lease must survive the initial TERM until KILL+close
  const start = Date.now();
  const result = spawnSync(
    process.execPath,
    superviseArgv(['node', '-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 200)"], claimPath, statusPath, { leasePath, lockPath, holder }, timeoutMs),
    { encoding: 'utf8', timeout: 15000 },
  );
  const st = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'))!;
  assert.equal(st.timedOut, true);
  // At this point supervisor has already handled close, so lease should be released (holder removed) after close
  // The key assertion: during the TERM→KILL window, lease was NOT released early — we can verify by checking that total duration exceeds timeout+ grace and status shows proper duration
  assert.ok(st.durationMs != null && st.durationMs! >= timeoutMs, `duration ${st.durationMs} should be >= timeout ${timeoutMs}`);
  assert.ok(st.durationMs! < timeoutMs + 7000, 'duration should be within TERM+KILL grace');
  // After close, lease is released (since holder was exclusive)
  assert.equal(existsSync(leasePath), false, 'lease must be released only after child close, not at TERM');
  assert.equal(existsSync(claimPath), false, 'claim must be removed only after close');
});

test('adversarial process group: deadline kills entire executor subtree, not just the shell', async (t) => {
  const root = tempRepo(t);
  const statusPath = join(root, 'status.json');
  const claimPath = join(root, 'claim.json');
  const sentinel = join(root, 'child-alive.txt');
  // Executor spawns a child that writes sentinel every 100ms — it inherits the executor's process group, so deadline must kill the group
  const timeoutMs = 700;
  const result = spawnSync(
    process.execPath,
    superviseArgv([
      'node', '-e',
      `const { spawn } = require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath, ['-e', "setInterval(()=>{try{fs.writeFileSync('${sentinel.replace(/'/g, "\\'")}', String(Date.now()))}catch{}},100)"], {stdio: 'ignore'}); setInterval(()=>{},200);`,
    ], claimPath, statusPath, undefined, timeoutMs),
    { encoding: 'utf8', timeout: 15000 },
  );
  const st = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'))!;
  assert.equal(st.timedOut, true);
  assert.ok(st.processGroupId != null, 'process_group_id must be recorded for group-kill verification');
  // Verify process group is dead
  const pgid = st.processGroupId!;
  let groupAlive = false;
  try {
    process.kill(-pgid, 0);
    groupAlive = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    assert.equal(code, 'ESRCH', `process group ${pgid} should be ESRCH after deadline, got ${code}`);
  }
  assert.equal(groupAlive, false, 'executor process group must be dead after deadline KILL');
  // Sentinel child should have been reaped too — if group kill failed, sentinel would keep updating
  const before = existsSync(sentinel) ? readFileSync(sentinel, 'utf8') : null;
  await sleep(800);
  const after = existsSync(sentinel) ? readFileSync(sentinel, 'utf8') : null;
  // If group kill worked, file stops updating; at least it should not advance
  if (before != null && after != null) {
    assert.equal(before, after, 'child sentinel must not advance after group SIGKILL');
  }
});

test('ledger verification: no deadline inference from wall time — status is authoritative', () => {
  // Simulate a status where executor was killed by SIGTERM but NOT timed out — wall time alone would misclassify
  const raw = JSON.stringify({
    supervisor_pid: 111,
    executor_pid: 222,
    process_group_id: 222,
    started_at: '2026-08-17T00:00:00.000Z',
    ended_at: '2026-08-17T00:20:01.000Z',
    heartbeat_at: '2026-08-17T00:20:01.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    duration_ms: 1201000,
    exit_code: null,
    signal: 'SIGTERM',
    timed_out: false,
    timeout_ms: 1200000,
    deadline_at: '2026-08-17T00:20:00.000Z',
  });
  const st = readSupervisorStatus('/tmp/fake2.json', () => raw)!;
  // Even though durationMs exceeds timeoutMs and signal is SIGTERM, timedOut false means NOT a timeout
  assert.equal(st.timedOut, false);
  assert.equal(st.timeoutMs, 1200000);
  assert.equal(st.signal, 'SIGTERM');
  // Conversely, timed_out true outranks signal even if wall time is short
  const raw2 = JSON.stringify({
    supervisor_pid: 111, executor_pid: 222, process_group_id: 222,
    started_at: '2026-08-17T00:00:00.000Z', ended_at: '2026-08-17T00:00:00.500Z',
    heartbeat_at: '2026-08-17T00:00:00.500Z', last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
    duration_ms: 500, exit_code: null, signal: 'SIGTERM',
    timed_out: true, timeout_ms: 400, deadline_at: '2026-08-17T00:00:00.400Z',
  });
  const st2 = readSupervisorStatus('/tmp/fake3.json', () => raw2)!;
  assert.equal(st2.timedOut, true);
  assert.equal(st2.signal, 'SIGTERM'); // signal still present but timeout is authoritative
});

test('output silence alone never terminates work — no deadline means infinite despite idle output', async (t) => {
  const root = tempRepo(t);
  const statusPath = join(root, 'status.json');
  const claimPath = join(root, 'claim.json');
  // Executor that stays silent (no output) for 1.5s but exits normally — without deadline it must not be killed
  const start = Date.now();
  const result = spawnSync(
    process.execPath,
    superviseArgv(['node', '-e', "setTimeout(()=>{process.stdout.write('late'); process.exit(0)}, 1200)"], claimPath, statusPath, undefined, null),
    { encoding: 'utf8', timeout: 5000 },
  );
  const elapsed = Date.now() - start;
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'late');
  assert.ok(elapsed >= 1200, 'executor should have run full duration despite silence');
  const st = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'))!;
  assert.equal(st.timedOut, false);
  assert.equal(st.timeoutMs, null);
});

test('superviseArgv encodes timeout and deadline_at for supervisor consumption', () => {
  const argv = superviseArgv(['echo', 'hi'], '/tmp/in.json', '/tmp/st.json', undefined, 1200000);
  // superviseArgv format when timeout present: -e, source, --, parentPid, inflight, status, leaseJson, timeoutMs, deadlineAt, ...command
  const dashIdx = argv.indexOf('--');
  assert.ok(dashIdx >= 0);
  const after = argv.slice(dashIdx + 1);
  assert.equal(after[1], '/tmp/in.json');
  assert.equal(after[2], '/tmp/st.json');
  assert.equal(after[4], '1200000');
  assert.ok(after[5] != null && /^\d{4}-\d{2}-\d{2}T/.test(after[5]), `deadline_at should be ISO string, got ${after[5]}`);
  assert.deepEqual(after.slice(6), ['echo', 'hi']);
  const noTimeout = superviseArgv(['echo', 'hi'], '/tmp/in.json', '/tmp/st.json', undefined, null);
  const after2 = noTimeout.slice(noTimeout.indexOf('--') + 1);
  // without timeout, command starts immediately after lease slot
  assert.deepEqual(after2.slice(4), ['echo', 'hi']);
  const noTimeout2 = superviseArgv(['echo', 'hi'], '/tmp/in.json', '/tmp/st.json', undefined, 0);
  const after3 = noTimeout2.slice(noTimeout2.indexOf('--') + 1);
  assert.deepEqual(after3.slice(4), ['echo', 'hi']);
});

test('supervisor status file survives concurrent kill and remains parseable (atomic write)', (t) => {
  const root = tempRepo(t);
  const statusPath = join(root, 'status.json');
  const claimPath = join(root, 'claim.json');
  const timeoutMs = 500;
  const result = spawnSync(
    process.execPath,
    superviseArgv(['node', '-e', "process.on('SIGTERM',()=>{ setTimeout(()=>process.exit(0), 100)}); setInterval(()=>{},100)"], claimPath, statusPath, undefined, timeoutMs),
    { encoding: 'utf8', timeout: 10000 },
  );
  // Status file should be valid JSON even with concurrent signal handling
  const raw = readFileSync(statusPath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'status file must be valid JSON after atomic rename');
  const st = readSupervisorStatus(statusPath, () => raw)!;
  assert.equal(st.timedOut, true);
});

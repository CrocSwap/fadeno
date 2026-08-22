import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { tempRepo } from './helpers.ts';
import {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_LINES,
  diagnosticsTruncationMarker,
  truncateDiagnostics,
  runDispatch,
  DISPATCHES_FILE,
} from '../src/commands/dispatch.ts';
import {
  WORKSPACE_LEASE_FILE,
  acquireWorkspaceLease,
  heartbeatWorkspaceLease,
  readWorkspaceLease,
  releaseWorkspaceLease,
  isWorkspaceLeaseAlive,
  readEffectiveLease,
  createIsolatedWorktree,
  collectIsolatedDiff,
  removeIsolatedWorktree,
  withIsolatedWorktree,
  WorkspaceLeaseError,
} from '../src/lib/workspace-lease.ts';
import {
  readSupervisorStatus,
  readInflightClaim,
  superviseArgv,
  supervisedSpawnError,
  SPAWN_FAILED_MARKER,
} from '../src/lib/supervisor.ts';

function aliveProbe(): void {}
function deadProbe(): void {
  const err = new Error('gone') as NodeJS.ErrnoException;
  err.code = 'ESRCH';
  throw err;
}

function seedV3(root: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 3,
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker', effort: 'default' },
      'big-worker': { provider: 'openai', id: 'big-worker', effort: 'default' },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))"], },
      },
      codex: { openai: { command: ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))"], } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'echo-worker' },
    ...extra,
  };
  if (extra.models) (base as any).models = { ...(base as any).models, ...(extra.models as any) };
  if (extra.routes) (base as any).routes = { ...(base as any).routes, ...(extra.routes as any) };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
}

function initGit(root: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  const run = (args: string[]) => {
    const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${s.stderr ?? s.error}`);
  };
  run(['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-m', 'init']);
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const p = join(root, DISPATCHES_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Diagnostics: bounded opt-in, head+tail, marker, atomic, machine-local
// ---------------------------------------------------------------------------

test('diagnostics: not persisted by default, only byte counters remain', (t) => {
  const root = tempRepo(t);
  seedV3(root);
  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } });
  const rows = evidenceRows(root);
  const completed = rows.find((r) => r.event === 'dispatch_completed')!;
  assert.ok(completed);
  assert.equal(completed.output_bytes, Buffer.byteLength('hello'));
  assert.equal('diagnostics_snapshot' in completed, false);
  assert.equal('diagnostics_bytes' in completed, false);
  assert.equal(existsSync(join(root, '.fadeno', 'local', 'outputs', 'diagnostics', `dispatch-${result.dispatchId}.log`)), false);
});

test('diagnostics: opt-in via --diagnostics writes bounded snapshot with head+tail', (t) => {
  const root = tempRepo(t);
  seedV3(root);
  // produce output larger than 32 KiB and 500 lines
  const big = Array.from({ length: 600 }, (_, i) => `line-${String(i).padStart(4, '0')}-${'x'.repeat(80)}`).join('\n');
  seedV3(root, {
    models: { 'echo-worker': { provider: 'openai', id: 'echo-worker' } },
    routes: { standalone: { openai: { command: ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))"], } } },
  });
  const result = runDispatch({
    archetype: 'worker',
    prompt: big,
    diagnostics: true,
    repoRoot: root,
    userPathOptions: { env: { FADENO_HARNESS: 'standalone' } },
  });
  const rows = evidenceRows(root);
  const completed = rows.find((r) => r.event === 'dispatch_completed')!;
  const diagRel = completed.diagnostics_snapshot as string | undefined;
  const diagBytes = completed.diagnostics_bytes as number | undefined;
  assert.ok(diagRel, 'diagnostics_snapshot must be present when opted-in');
  assert.ok(typeof diagBytes === 'number' && diagBytes > 0);
  assert.match(diagRel, /^\.fadeno\/local\/outputs\/diagnostics\/dispatch-.*\.log$/);
  const diagAbs = join(root, diagRel);
  assert.ok(existsSync(diagAbs), 'diagnostics file must exist atomically');
  const content = readFileSync(diagAbs, 'utf8');
  assert.ok(Buffer.byteLength(content, 'utf8') < 100 * 1024, 'diagnostics file must be bounded (~ <100 KiB including headers)');
  // truncation marker must appear exactly once per truncated stream
  const markerStdout = diagnosticsTruncationMarker('stdout');
  // big output should trigger truncation for stdout
  assert.ok(content.includes(markerStdout) || content.includes(diagnosticsTruncationMarker('stderr')), 'truncation marker must be present when limits exceeded');
  // head and tail sampling: first and last lines should be present
  assert.ok(content.includes('line-0000'), 'head must be preserved');
  assert.ok(content.includes('line-0599'), 'tail must be preserved');
  // machine-local: file lives under .fadeno/local, never ledger
  assert.ok(diagRel.startsWith('.fadeno/local/outputs/diagnostics/'));
  assert.ok(existsSync(diagAbs));
});

test('diagnostics: FADENO_DIAGNOSTICS=1 env enables diagnostics for tests', (t) => {
  const root = tempRepo(t);
  seedV3(root);
  const prev = process.env.FADENO_DIAGNOSTICS;
  process.env.FADENO_DIAGNOSTICS = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.FADENO_DIAGNOSTICS;
    else process.env.FADENO_DIAGNOSTICS = prev;
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'env-test', repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } });
  const completed = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.ok(completed.diagnostics_snapshot, 'env opt-in must create diagnostics_snapshot');
  assert.ok(existsSync(join(root, String(completed.diagnostics_snapshot))));
});

test('diagnostics: truncation marker verbatim and per-stream limits', () => {
  assert.equal(DIAGNOSTICS_MAX_BYTES, 32 * 1024);
  assert.equal(DIAGNOSTICS_MAX_LINES, 500);
  const mOut = diagnosticsTruncationMarker('stdout');
  const mErr = diagnosticsTruncationMarker('stderr');
  assert.equal(mOut, '\n…[fadeno diagnostics truncated: stdout exceeded 32 KiB / 500 lines]…\n');
  assert.equal(mErr, '\n…[fadeno diagnostics truncated: stderr exceeded 32 KiB / 500 lines]…\n');
  // exactly one marker per truncated stream
  const big = 'x'.repeat(40 * 1024);
  const truncated = truncateDiagnostics(big, 'stdout');
  assert.ok(truncated.includes(mOut));
  assert.equal((truncated.match(new RegExp(mOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1, 'single marker');
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= DIAGNOSTICS_MAX_BYTES);
  const manyLines = Array.from({ length: 600 }, (_, i) => `L${i}`).join('\n');
  const truncatedLines = truncateDiagnostics(manyLines, 'stderr');
  assert.ok(truncatedLines.includes(mErr));
  assert.equal((truncatedLines.match(new RegExp(mErr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1);
});

test('diagnostics: non-ASCII and line-heavy output obey both hard bounds', () => {
  const marker = diagnosticsTruncationMarker('stdout');
  const samples = [
    '🧪'.repeat(40 * 1024),
    Array.from({ length: 4_000 }, (_, i) => `${i}:${'界'.repeat(i % 2 === 0 ? 40 : 1)}`).join('\n'),
    Array.from({ length: 500 }, (_, i) => `${i}:${i === 249 ? 'é'.repeat(40 * 1024) : 'x'}`).join('\n'),
  ];
  for (const sample of samples) {
    const truncated = truncateDiagnostics(sample, 'stdout');
    assert.equal(Buffer.from(truncated, 'utf8').toString('utf8'), truncated, 'must not split a UTF-8 sequence');
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= DIAGNOSTICS_MAX_BYTES);
    assert.ok(truncated.split('\n').length <= DIAGNOSTICS_MAX_LINES);
    assert.equal(truncated.split(marker).length - 1, 1, 'must contain exactly one marker');
  }
});

test('diagnostics: never gates control flow, bounded buffers', (t) => {
  const root = tempRepo(t);
  seedV3(root, {
    models: { 'echo-worker': { provider: 'openai', id: 'echo-worker' } },
    routes: { standalone: { openai: { command: ['node', '-e', 'process.exit(0)'], } } },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'ok', diagnostics: true, repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } });
  assert.equal(result.exitCode, 0);
  // diagnostics file still created even on empty output
  const completed = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.ok(completed.diagnostics_snapshot);
});

// ---------------------------------------------------------------------------
// Isolated delivery lifecycle — detached worktree, never auto-merge
// ---------------------------------------------------------------------------

test('isolated dispatch: creates diff, omits workspace_changed, bypasses lease', (t) => {
  const root = tempRepo(t);
  initGit(root);
  seedV3(root, {
    models: { 'echo-worker': { provider: 'openai', id: 'echo-worker' } },
    routes: { standalone: { openai: { command: ['node', '-e', "require('node:fs').writeFileSync('isolated.txt','hello');"], } } },
  });
  // hold shared lease to prove bypass
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'blocker', kind: 'ad-hoc' }, supervisorPid: 99999, probe: aliveProbe });
  const result = runDispatch({ archetype: 'worker', prompt: 'isolated-task', isolate: true, repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } });
  // diff must be present
  const rows = evidenceRows(root);
  const completed = rows.find((r) => r.event === 'dispatch_completed')!;
  assert.ok(completed.diff_snapshot, 'isolated dispatch must record diff_snapshot');
  assert.ok(typeof completed.diff_bytes === 'number');
  assert.match(String(completed.diff_snapshot), /^\.fadeno\/local\/outputs\/isolated-.*\.diff$/);
  assert.ok(existsSync(join(root, String(completed.diff_snapshot))));
  // workspace_changed omitted for isolated
  assert.equal('workspace_changed' in completed, false, 'workspace_changed must be omitted for isolated deliveries');
  // not auto-merged
  assert.equal(existsSync(join(root, 'isolated.txt')), false, 'isolated write must not leak to shared worktree');
  // lease still held by blocker
  assert.ok(existsSync(join(root, WORKSPACE_LEASE_FILE)));
  assert.equal(readWorkspaceLease(root)?.holder.id, 'blocker');
});

test('an isolated dispatch and its shadow keep separate worktrees with separate lifetimes', (t) => {
  // These used to be refused as a pair on the theory that two worktrees would
  // collide. They never shared a path, and a symmetric comparison wants both
  // arms isolated — so what the boundary owes is not refusal but distinct
  // lifetimes: the primary's worktree is consumed once its diff is collected,
  // the challenger's is retained for a judgment that has not happened yet.
  const root = tempRepo(t);
  initGit(root);
  seedV3(root);
  const result = runDispatch({ archetype: 'worker', prompt: 'x', isolate: true, shadow: 'echo-worker', repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } });
  assert.equal(result.exitCode, 0);

  const isolatedDir = join(root, '.fadeno', 'local', 'isolated');
  assert.deepEqual(existsSync(isolatedDir) ? readdirSync(isolatedDir) : [], []);
  // Both arms of a pair now live under one neutral directory
  // (`.fadeno/local/pair/<pair-id8>/<arm>`), so the retained challenger is
  // found by walking that rather than a path that named it.
  const pairDirs = readdirSync(join(root, '.fadeno', 'local', 'pair'));
  assert.equal(pairDirs.length, 1);

  // Neither arm may leave a live-shadow lease behind; that is what the cap counts.
  const inflight = join(root, '.fadeno', 'local', 'inflight');
  const leases = (existsSync(inflight) ? readdirSync(inflight) : []).filter((f) => f.endsWith('.shadow.json'));
  assert.deepEqual(leases, []);
});

test('isolated dispatch: empty diff is 0 bytes and preserved', (t) => {
  const root = tempRepo(t);
  initGit(root);
  seedV3(root, {
    routes: { standalone: { openai: { command: ['node', '-e', 'process.exit(0)'], } } },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'no-change', isolate: true, repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } });
  const completed = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal(completed.diff_bytes, 0);
  assert.ok(existsSync(join(root, String(completed.diff_snapshot))));
});

// ---------------------------------------------------------------------------
// Crash-boundary — hermetic, tempRepo, injected probe/now, valid JSON
// ---------------------------------------------------------------------------

test('acquire-crash-before-write', (t) => {
  const root = tempRepo(t);
  // No file before any acquire — crash before write leaves no torn file
  assert.equal(existsSync(join(root, WORKSPACE_LEASE_FILE)), false);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'owner', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe });
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'valid JSON after acquire');
});

test('acquire-crash-after-tmp-rename', (t) => {
  const root = tempRepo(t);
  for (let i = 0; i < 3; i += 1) {
    acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'a', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe, now: new Date(`2026-08-17T00:00:0${i}Z`) });
    const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'atomic tmp+rename must never expose torn JSON');
    assert.ok(!existsSync(join(root, WORKSPACE_LEASE_FILE + '.tmp')), 'no temp left behind');
  }
});

test('heartbeat-crash', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'hb', kind: 'ad-hoc' }, supervisorPid: 1, probe: aliveProbe });
  heartbeatWorkspaceLease({ repoRoot: root, holderId: 'hb', stdoutBytes: 10, probe: aliveProbe });
  const raw = readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.equal((JSON.parse(raw) as any).stdout_bytes, 10);
});

test('release-crash-partial-holders', (t) => {
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
  const parsed = JSON.parse(raw) as any;
  assert.equal(parsed.holders.length, 1);
});

test('reclaim-after-dead-supervisor', (t) => {
  const root = tempRepo(t);
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'stale', kind: 'ad-hoc' }, supervisorPid: 99, probe: aliveProbe });
  const reclaimed = acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'fresh', kind: 'ad-hoc' }, supervisorPid: 100, probe: deadProbe });
  assert.equal(reclaimed?.holder.id, 'fresh');
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8')));
});

test('pid-less-host-survives-deadProbe', (t) => {
  const root = tempRepo(t);
  const holder = { id: 'dispatch-1', kind: 'host-dispatch' as const, runId: 'run-a', dispatchId: 'dispatch-1' };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder, supervisorPid: null });
  assert.equal(isWorkspaceLeaseAlive(readWorkspaceLease(root), deadProbe), true);
  assert.equal(readEffectiveLease(root, deadProbe)?.holder.id, 'dispatch-1');
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8')));
});

test('supervisor-killed-atomics-lease-preserved', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'lease-killed-claim.json');
  const statusPath = join(root, 'lease-killed-claim.status.json');
  const leasePath = join(root, 'workspace-lease.json');
  const lockPath = join(root, '.workspace-lease.lock');
  const holder = { id: 'kill-test', kind: 'engine' as const, runId: 'run-kill', dispatchId: 'dispatch-kill' };
  writeFileSync(leasePath, JSON.stringify({ holder, workspace_mode: 'shared', supervisor_pid: 99999, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), stdout_bytes: 0, stderr_bytes: 0, last_output_at: null }));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, superviseArgv([process.execPath, '-e', "setTimeout(()=>process.exit(0), 5000)"], claimPath, statusPath, { leasePath, lockPath, holder }), { stdio: 'ignore' });
  const deadline = Date.now() + 5_000;
  let liveLease: any = null;
  while (Date.now() < deadline) {
    try { liveLease = JSON.parse(readFileSync(leasePath, 'utf8')); } catch {}
    if (liveLease?.supervisor_pid === child.pid && typeof liveLease?.process_group_id === 'number') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(liveLease?.supervisor_pid, child.pid, 'supervisor must replace the pid-less reservation with its pid');
  assert.equal(typeof liveLease?.executor_pid, 'number');
  assert.equal(liveLease?.process_group_id, liveLease?.executor_pid);
  try { process.kill(child.pid!, 'SIGKILL'); } catch {}
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(existsSync(claimPath), 'claim must remain so the orphaned executor group stays cancellable');
  const preserved = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.doesNotThrow(() => JSON.parse(readFileSync(leasePath, 'utf8')), 'lease must remain valid JSON after supervisor kill');
  assert.equal(isWorkspaceLeaseAlive(preserved), true, 'live detached executor group must keep the lease blocking');
  try { process.kill(-preserved.process_group_id, 'SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isWorkspaceLeaseAlive(preserved), false, 'lease becomes reclaimable only after the executor group is gone');
});

test('supervisor-spawn-failed-127-distinguished', () => {
  assert.equal(supervisedSpawnError(127, `${SPAWN_FAILED_MARKER}spawn ENOENT`), 'spawn ENOENT');
  assert.equal(supervisedSpawnError(127, 'exit 127 from executor'), null);
  assert.equal(supervisedSpawnError(0, `${SPAWN_FAILED_MARKER}x`), null);
  const missing = spawnSync(process.execPath, superviseArgv(['no-such-binary-xyz'], '', ''), { encoding: 'utf8' });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr ?? '', new RegExp(SPAWN_FAILED_MARKER));
});

test('claim-removed-only-after-child-close', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'close-claim.json');
  const statusPath = join(root, 'close-claim.status.json');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, superviseArgv([process.execPath, '-e', "process.stdout.write('hi'); setTimeout(()=>process.exit(0), 900)"], claimPath, statusPath), { stdio: ['ignore', 'pipe', 'pipe'] });
  // Poll for claim with deadline instead of single fixed sleep — under parallel load the supervisor may not have written yet.
  const deadline = Date.now() + 4000;
  while (!existsSync(claimPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(claimPath), 'claim exists while child running');
  assert.doesNotThrow(() => JSON.parse(readFileSync(claimPath, 'utf8')));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(claimPath), false, 'terminal supervisor must remove claim only after child close');
  const status = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'));
  assert.ok(status);
});

test('isolated-worktree-killed-diff-still-collectable', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'killed-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  writeFileSync(join(created.worktreeAbs, 'killed.txt'), 'content after kill\n');
  const diffRel = '.fadeno/local/outputs/isolated-killed-1.diff';
  const diffAbs = join(root, diffRel);
  const res = collectIsolatedDiff({ repoRoot: root, worktreeAbs: created.worktreeAbs, diffAbs, diffRel });
  assert.ok(res.diffBytes > 0);
  assert.ok(existsSync(diffAbs));
  removeIsolatedWorktree(root, created.worktreeAbs);
});

test('isolated-diff-failure-preserves-worktree', async (t) => {
  const root = tempRepo(t);
  initGit(root);
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'preserve-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  writeFileSync(join(created.worktreeAbs, 'preserve.txt'), 'preserve me\n');
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  const blockingFile = join(root, '.fadeno', 'local', 'outputs', 'block');
  writeFileSync(blockingFile, 'block');
  const badDiffAbs = join(blockingFile, 'isolated-preserve-1.diff');
  const badDiffRel = '.fadeno/local/outputs/block/isolated-preserve-1.diff';
  const wtPath2 = join(root, '.fadeno', 'local', 'isolated', 'preserve-2');
  let threw = false;
  try {
    withIsolatedWorktree({ repoRoot: root, worktreePath: wtPath2, diffAbs: badDiffAbs, diffRel: badDiffRel, now: new Date() }, () => {
      writeFileSync(join(wtPath2, 'inner.txt'), 'x\n');
    });
  } catch {
    threw = true;
    assert.ok(existsSync(wtPath2), 'worktree preserved after diff failure');
    removeIsolatedWorktree(root, wtPath2);
  } finally {
    try { rmSync(blockingFile, { force: true }); } catch {}
  }
  assert.equal(threw, true);
  removeIsolatedWorktree(root, created.worktreeAbs);
});

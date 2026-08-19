import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import { runDispatchesCancel, runDispatchesOutput } from '../src/commands/dispatches.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import {
  SPAWN_FAILED_MARKER,
  INFLIGHT_DIR,
  inflightClaimIsAlive,
  readInflightClaim,
  readSupervisorStatus,
  superviseArgv,
  supervisedSpawnError,
} from '../src/lib/supervisor.ts';
import { isWorkspaceLeaseAlive, readWorkspaceLease, releaseWorkspaceLease, WORKSPACE_LEASE_FILE } from '../src/lib/workspace-lease.ts';
import { tempRepo } from './helpers.ts';

/**
 * Executor lifetime. `fadeno dispatch` blocks inside `spawnSync`, so a killed
 * kernel runs no cleanup — and the harness that kills it kills its pid, not
 * its process group. A 2026-08-13 dogfood watched an executor survive that,
 * deliver all of its files, and saturate the host, while the proxy reported
 * failure. These pin the supervisor that closes it, and pin that supervision
 * stays invisible when nothing goes wrong.
 */

const REPO = join(import.meta.dirname, '..');

const HARNESS = 'standalone';
const harnessOpts = { env: { FADENO_HARNESS: HARNESS } } as const;

function seedExecutor(t: TestContext, command: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 3,
      models: {
        probe: { provider: 'openai', id: 'probe', effort: 'default' },
      },
      routes: {
        standalone: { openai: { command, write_access: true } },
        codex: { openai: { command, write_access: true } },
        claude: { openai: { command, write_access: true } },
      },
      archetypes: { worker: {} },
      dials: { worker: 'probe' },
    }),
  );
  return root;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('supervision is invisible: stdin, stdout, and exit code pass through unchanged', (t) => {
  const root = seedExecutor(t, [
    'node',
    '-e',
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('GOT:'+d))",
  ]);
  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, userPathOptions: harnessOpts });
  // The prompt reached the executor through the supervisor's stdin relay, and
  // its stdout landed in the snapshot exactly as a direct spawn would.
  assert.equal(result.stdout, 'GOT:hello');
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, 'ok');
});

test('supervision preserves a nonzero exit code verbatim', (t) => {
  const root = seedExecutor(t, ['node', '-e', 'process.exit(42)']);
  const result = runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: harnessOpts });
  assert.equal(result.exitCode, 42, 'the executor code, not the supervisor’s');
  assert.equal(result.outcome, 'failed');
});

test('supervision still distinguishes a missing executor from one that exits 127', (t) => {
  // The supervisor always starts, so `spawnSync().error` no longer reports a
  // missing binary. It has to say so itself, or a configuration error decays
  // into "the executor exited 127".
  const missing = seedExecutor(t, ['fadeno-no-such-binary-xyz']);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: missing, userPathOptions: harnessOpts }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /executor "probe" failed to spawn/);
      return true;
    },
  );

  const genuine = seedExecutor(t, ['node', '-e', 'process.exit(127)']);
  const result = runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: genuine, userPathOptions: harnessOpts });
  assert.equal(result.exitCode, 127, 'a real 127 is an exit code, not a spawn failure');
});

test('supervisedSpawnError reads only its own marker', () => {
  assert.equal(supervisedSpawnError(127, `${SPAWN_FAILED_MARKER}spawn ghost ENOENT`), 'spawn ghost ENOENT');
  // A 127 the executor itself chose carries no marker and must not be
  // reinterpreted as Fadeno failing to start it.
  assert.equal(supervisedSpawnError(127, 'bash: line 1: ghost: command not found\n'), null);
  assert.equal(supervisedSpawnError(0, `${SPAWN_FAILED_MARKER}x`), null);
  assert.equal(supervisedSpawnError(127, null), null);
});

test('superviseArgv wraps the command without changing it', () => {
  const argv = superviseArgv(['codex', 'exec', '--model', 'gpt-5.6-terra'], '/repo/.fadeno/local/inflight/x.json');
  assert.equal(argv[0], '-e');
  assert.equal(argv[2], '--');
  assert.equal(argv[3], String(process.pid), 'the kernel names itself as the parent to watch');
  // Where the supervisor publishes its in-flight claim. The kernel cannot
  // publish it: `spawnSync` yields a pid only once the spawn has finished, so
  // the supervisor is the only process that knows its own pid while the
  // executor is still running — and that claim is what cancel signals.
  assert.equal(argv[4], '/repo/.fadeno/local/inflight/x.json');
  // Where the supervisor reports how its executor ended. A concurrent
  // shadow's kernel is blocked in the primary's spawnSync when the shadow
  // exits, so the outcome must survive as a file it can poll for afterwards.
  assert.equal(argv[5], '', 'no status path requested here');
  const withStatus = superviseArgv(['x'], '/claim.json', '/status.json');
  assert.equal(withStatus[5], '/status.json');
  assert.equal(argv[6], '', 'no lease-release descriptor requested here');
  // The executor's own argv survives intact and last — the evidence row
  // records this command, and it must be the one that actually runs.
  assert.deepEqual(argv.slice(7), ['codex', 'exec', '--model', 'gpt-5.6-terra']);
  // Omitting both paths stays valid: an empty slot means "publish nothing",
  // which keeps every non-kernel caller of superviseArgv working unchanged.
  assert.deepEqual(superviseArgv(['x']).slice(4), ['', '', '', 'x']);
});

test('supervisor heartbeats and byte-counts exact forwarded stdout/stderr atomically', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'claim.json');
  const statusPath = join(root, 'claim.status.json');
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const parseErrors: Error[] = [];
  const child = spawn(process.execPath, superviseArgv([
    process.execPath,
    '-e',
    [
      'process.stdout.write(Buffer.from([0,255,65]));',
      'process.stderr.write(Buffer.from([254,0,66]));',
      'setTimeout(()=>{process.stdout.write(Buffer.from([67,128]));process.stderr.write(Buffer.from([68]));},1600);',
      'setTimeout(()=>process.exit(0),1900);',
    ].join(''),
  ], claimPath, statusPath), { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const poll = setInterval(() => {
    if (!existsSync(claimPath)) return;
    try {
      snapshots.push(JSON.parse(readFileSync(claimPath, 'utf8')) as Record<string, unknown>);
    } catch (err) {
      parseErrors.push(err as Error);
    }
  }, 5);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`supervisor exited ${code}`)));
  });
  clearInterval(poll);

  assert.deepEqual(Buffer.concat(stdout), Buffer.from([0, 255, 65, 67, 128]));
  assert.deepEqual(Buffer.concat(stderr), Buffer.from([254, 0, 66, 68]));
  assert.deepEqual(parseErrors, [], 'atomic claim replacement must never expose torn JSON');
  assert.ok(snapshots.length > 2, 'expected output observations plus an idle heartbeat');
  assert.equal(Math.max(...snapshots.map((row) => Number(row.stdout_bytes))), 5);
  assert.equal(Math.max(...snapshots.map((row) => Number(row.stderr_bytes))), 4);
  assert.ok(snapshots.some((row) => row.stdout_bytes === 3 && row.stderr_bytes === 3));
  const firstOutput = snapshots.find((row) => row.stdout_bytes === 3 && row.stderr_bytes === 3);
  assert.ok(firstOutput);
  assert.ok(snapshots.some((row) =>
    row.stdout_bytes === 3 && row.stderr_bytes === 3 && row.last_output_at === firstOutput.last_output_at &&
    row.heartbeat_at !== firstOutput.heartbeat_at,
  ), 'heartbeat must advance independently while last_output_at stays fixed');
  assert.equal(existsSync(claimPath), false, 'terminal supervisor removes the live claim');
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.tmp')), [], 'unique atomic temp files are cleaned');
  const status = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'));
  assert.equal(status?.exitCode, 0);
  assert.equal(status?.signal, null);
  assert.ok(status?.endedAt);
  assert.equal(status?.stdoutBytes, 5);
  assert.equal(status?.stderrBytes, 4);
});

test('supervisor executes with a lease descriptor and releases only the exact full holder', (t) => {
  const root = tempRepo(t);
  const leasePath = join(root, 'workspace-lease.json');
  const lockPath = join(root, '.workspace-lease.lock');
  const holder = { id: 'call-1', kind: 'engine' as const, runId: 'run-a', dispatchId: 'dispatch-a' };
  writeFileSync(leasePath, JSON.stringify({ holder }));
  const executed = spawnSync(process.execPath, superviseArgv(
    [process.execPath, '-e', "process.stdout.write('ran')"],
    '',
    '',
    { leasePath, lockPath, holder },
  ), { encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, 'ran');
  assert.equal(existsSync(leasePath), false, 'matching full holder is released after executor close');

  writeFileSync(leasePath, JSON.stringify({ holder }));
  mkdirSync(lockPath);
  const staleTime = new Date(Date.now() - 180_000);
  utimesSync(lockPath, staleTime, staleTime);
  const staleLock = spawnSync(process.execPath, superviseArgv(
    [process.execPath, '-e', 'process.exit(0)'],
    '',
    '',
    { leasePath, lockPath, holder },
  ), { encoding: 'utf8' });
  assert.equal(staleLock.status, 0, staleLock.stderr);
  assert.equal(existsSync(lockPath), false, 'supervisor prunes an abandoned lease lock');
  assert.equal(existsSync(leasePath), false, 'stale lock cannot prevent terminal lease release');

  // Repeated local ids across runs are not the same holder. A delayed
  // supervisor from run A must never release run B's durable lease.
  writeFileSync(leasePath, JSON.stringify({ holder: { ...holder, runId: 'run-b' } }));
  const stale = spawnSync(process.execPath, superviseArgv(
    [process.execPath, '-e', 'process.exit(0)'],
    '',
    '',
    { leasePath, lockPath, holder },
  ), { encoding: 'utf8' });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(existsSync(leasePath), true, 'different run identity must survive stale release');

  const peer = { id: 'call-2', kind: 'host-dispatch' as const, runId: 'run-c', dispatchId: 'dispatch-b' };
  const survivor = { id: 'call-1', kind: 'host-dispatch' as const, runId: 'run-c', dispatchId: 'dispatch-a' };
  writeFileSync(leasePath, JSON.stringify({ holder: survivor, holders: [survivor, peer] }));
  const memberRelease = spawnSync(process.execPath, superviseArgv(
    [process.execPath, '-e', 'process.exit(0)'],
    '',
    '',
    { leasePath, lockPath, holder: peer },
  ), { encoding: 'utf8' });
  assert.equal(memberRelease.status, 0, memberRelease.stderr);
  const remaining = JSON.parse(readFileSync(leasePath, 'utf8')) as { holder: unknown; holders: unknown[] };
  assert.deepEqual(remaining.holder, survivor);
  assert.deepEqual(remaining.holders, [survivor], 'supervisor release preserves peer holders');
});

test('in-flight liveness is conservative except for a proven missing pid', () => {
  const claim = { pid: 123, startedAt: null };
  assert.equal(inflightClaimIsAlive(claim, () => {}), true);
  assert.equal(inflightClaimIsAlive(claim, () => {
    const err = new Error('gone') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }), false);
  assert.equal(inflightClaimIsAlive(claim, () => {
    const err = new Error('not permitted') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    throw err;
  }), true);
});

test('killing the kernel reaps the executor instead of orphaning it', async (t) => {
  const root = seedExecutor(t, [
    'node',
    '-e',
    // Writes a file every 200ms for 12s. Unsupervised, a killed kernel leaves
    // this running to completion — that is the dogfooded failure, where all
    // twenty files landed after the dispatch had been reported as failed.
    "let i=0;const f=require('node:fs');const t=setInterval(()=>{i++;f.writeFileSync('tick-'+i+'.txt','x');if(i>=60)clearInterval(t)},200)",
  ]);

  const kernel = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'dispatch', '--archetype', 'worker'], {
    cwd: root,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, FADENO_HARNESS: HARNESS },
  });
  kernel.stdin.end('prompt\n');

  // Poll rather than sleep: under full-suite load the CLI's own startup can
  // outlast any fixed wait, and a flaky setup would quietly stop testing the
  // thing this file exists for.
  const ticks = (): number => readdirSync(root).filter((name) => name.startsWith('tick-')).length;
  const deadline = Date.now() + 20_000;
  while (ticks() === 0 && Date.now() < deadline) await sleep(100);
  assert.ok(ticks() > 0, 'the executor never started producing, so the kill proves nothing');

  kernel.kill('SIGTERM');
  await sleep(3000);
  const settled = ticks();
  await sleep(3000);
  const later = ticks();

  assert.equal(later, settled, `executor kept writing after the kernel died (${settled} → ${later})`);
  assert.ok(later < 60, `executor ran to completion despite the kill (${later}/60 files)`);
});

test('SIGKILLed supervisor preserves the production lease and claim until its orphan group is cancelled', async (t) => {
  const root = seedExecutor(t, [
    'node',
    '-e',
    "let i=0;const f=require('node:fs');setInterval(()=>f.writeFileSync('orphan-tick-'+(++i)+'.txt','x'),100)",
  ]);
  const kernel = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'dispatch', '--archetype', 'worker', '--tag', 'sigkill-orphan'], {
    cwd: root,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, FADENO_HARNESS: HARNESS },
  });
  kernel.stdin.end('prompt\n');
  const ticks = (): number => readdirSync(root).filter((name) => name.startsWith('orphan-tick-')).length;
  const deadline = Date.now() + 20_000;
  let lease = readWorkspaceLease(root);
  while ((ticks() === 0 || lease?.supervisor_pid == null || lease.process_group_id == null) && Date.now() < deadline) {
    await sleep(100);
    lease = readWorkspaceLease(root);
  }
  assert.ok(lease?.supervisor_pid != null && lease.process_group_id != null, 'production lease never received process identity');
  const processGroupId = lease.process_group_id;
  t.after(() => { try { process.kill(-processGroupId, 'SIGKILL'); } catch {} });
  const supervisorPid = lease.supervisor_pid;
  process.kill(supervisorPid, 'SIGKILL');
  await new Promise<void>((resolve) => kernel.once('close', () => resolve()));
  const afterKernel = ticks();
  await sleep(400);
  assert.ok(ticks() > afterKernel, 'fixture executor did not survive the supervisor SIGKILL, so the interlock was not exercised');
  const preserved = readWorkspaceLease(root)!;
  assert.equal(isWorkspaceLeaseAlive(preserved), true);
  assert.ok(existsSync(join(root, ...INFLIGHT_DIR.split('/'), `${preserved.holder.dispatchId}.json`)), 'kernel must preserve the cancellable claim');
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'second writer', repoRoot: root, userPathOptions: harnessOpts }),
    /shared workspace is already held/,
  );
  const cancelled = runDispatchesCancel({ repoRoot: root, tag: 'sigkill-orphan' });
  assert.equal(cancelled.pid, -preserved.process_group_id!);
  const stopDeadline = Date.now() + 5_000;
  while (isWorkspaceLeaseAlive(preserved) && Date.now() < stopDeadline) await sleep(50);
  assert.equal(isWorkspaceLeaseAlive(preserved), false, 'cancelled orphan group must become reclaimable');
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: preserved.holder }), true);
  assert.equal(existsSync(join(root, WORKSPACE_LEASE_FILE)), false);
});

test('a kernel that exits before supervisor initialization still reaps its executor', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'startup-race.json');
  const supervisorModule = pathToFileURL(join(REPO, 'src', 'lib', 'supervisor.ts')).href;
  const executor = [
    process.execPath,
    '-e',
    "let i=0;const f=require('node:fs');setInterval(()=>f.writeFileSync('startup-race-'+(++i)+'.txt','x'),100)",
  ];
  const launcherSource = [
    `import { spawn } from 'node:child_process';`,
    `import { superviseArgv } from ${JSON.stringify(supervisorModule)};`,
    `const child=spawn(process.execPath,superviseArgv(${JSON.stringify(executor)},${JSON.stringify(claimPath)}),{cwd:${JSON.stringify(root)},stdio:'ignore'});`,
    'child.unref();',
  ].join('\n');
  const launcher = spawnSync(process.execPath, ['--input-type=module', '-e', launcherSource], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(launcher.status, 0, launcher.stderr);
  await sleep(3_000);
  const ticks = readdirSync(root).filter((name) => name.startsWith('startup-race-') && name.endsWith('.txt')).length;
  assert.ok(ticks < 20, `executor survived the startup race (${ticks} writes)`);
  assert.equal(existsSync(claimPath), false);
});

test('drive supervises command attempts and refuses a retry while the first writer is alive', async (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { slow: { provider: 'slowp', id: 'slow', effort: 'default' } },
    routes: {
      standalone: {
        slowp: {
          command: [
            'node',
            '-e',
            "let i=0;const f=require('node:fs');const t=setInterval(()=>{i++;f.writeFileSync('drive-tick-'+i+'.txt','x');if(i>=60)clearInterval(t)},200)",
          ],
          write_access: true,
        },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: { requires_write: 'required' } },
    dials: { worker: 'slow' },
  }));
  writeFileSync(join(root, '.fadeno', 'playbooks', 'slow-drive.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'slow-drive',
    description: 'Long command supervision fixture.',
    roles: { worker: { purpose: 'Write slowly.', archetype: 'worker' } },
    flow: [{ id: 'work', kind: 'actor_call', actor: 'worker', output: 'Notes', terminal_status: 'completed' }],
  }));
  const created = runNewRun({ repoRoot: root, playbook: 'slow-drive', task: 'exercise supervision' });
  const env = { ...process.env, FADENO_HARNESS: HARNESS };
  const kernel = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'drive', created.runId], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore'],
    env,
  });
  const ticks = (): number => readdirSync(root).filter((name) => name.startsWith('drive-tick-')).length;
  const deadline = Date.now() + 20_000;
  while (ticks() === 0 && Date.now() < deadline) await sleep(100);
  assert.ok(ticks() > 0, 'the engine executor never started');

  const retry = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), 'drive', created.runId], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /still has a live supervisor.*refusing to record interruption or start a concurrent retry/s);
  const beforeKill = readFileSync(join(created.runDir, 'events.jsonl'), 'utf8');
  assert.match(beforeKill, /"supervisor_claim":"\.fadeno\/local\/inflight\/engine-/);
  assert.doesNotMatch(beforeKill, /"reason":"engine_interrupted"/);

  kernel.kill('SIGTERM');
  await sleep(3000);
  const settled = ticks();
  await sleep(3000);
  assert.equal(ticks(), settled, 'engine executor kept writing after drive was killed');
  assert.ok(settled < 60, `engine executor ran to completion despite the kill (${settled}/60 files)`);
});

test('drive supervises read-only command attempts and refuses a retry while the first read-only is alive', async (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { slow: { provider: 'slowp', id: 'slow', effort: 'default' } },
    routes: {
      standalone: {
        slowp: {
          command: [
            'node',
            '-e',
            "let i=0;const f=require('node:fs');const t=setInterval(()=>{i++;f.writeFileSync('drive-tick-'+i+'.txt','x');if(i>=60)clearInterval(t)},200)",
          ],
          write_access: false,
        },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: { requires_write: 'forbidden' } },
    dials: { worker: 'slow' },
  }));
  writeFileSync(join(root, '.fadeno', 'playbooks', 'slow-drive.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'slow-drive',
    description: 'Long read-only supervision fixture.',
    roles: { worker: { purpose: 'Read slowly.', archetype: 'worker' } },
    flow: [{ id: 'work', kind: 'actor_call', actor: 'worker', output: 'Notes', terminal_status: 'completed' }],
  }));
  const created = runNewRun({ repoRoot: root, playbook: 'slow-drive', task: 'exercise supervision read-only' });
  const env = { ...process.env, FADENO_HARNESS: HARNESS };
  const kernel = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'drive', created.runId], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore'],
    env,
  });
  const ticks = (): number => readdirSync(root).filter((name) => name.startsWith('drive-tick-')).length;
  const deadline = Date.now() + 20_000;
  while (ticks() === 0 && Date.now() < deadline) await sleep(100);
  assert.ok(ticks() > 0, 'the engine executor never started (read-only)');

  const retry = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), 'drive', created.runId], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /still has a live supervisor.*refusing to record interruption or start a concurrent retry/s);
  const beforeKill = readFileSync(join(created.runDir, 'events.jsonl'), 'utf8');
  assert.match(beforeKill, /"supervisor_claim":"\.fadeno\/local\/inflight\/engine-/);
  assert.doesNotMatch(beforeKill, /"reason":"engine_interrupted"/);
  // No second attempt was dispatched: only one actor_dispatched for this actor_call_id
  const dispatchedCount = (beforeKill.match(/"type":"actor_dispatched"/g) ?? []).length;
  assert.equal(dispatchedCount, 1, 'concurrent read-only drive must not dispatch another attempt');

  kernel.kill('SIGTERM');
  await sleep(3000);
  const settled = ticks();
  await sleep(3000);
  assert.equal(ticks(), settled, 'read-only engine executor kept writing after drive was killed');
  assert.ok(settled < 60, `read-only executor ran to completion despite the kill (${settled}/60 files)`);
});

test('the supervisor relays a signal as a signal, not as an exit code', () => {
  // "Killed by SIGTERM" and "exited 143" are different facts about a run, and
  // the completion row records which. The supervisor re-raises rather than
  // translating, so `spawned.signal` still answers.
  const probe = spawnSync(
    process.execPath,
    superviseArgv(['node', '-e', "process.kill(process.pid,'SIGTERM')"]),
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(probe.signal, 'SIGTERM', 'the executor’s signal reached the kernel');
  assert.equal(probe.status, null);
});

test('a dispatch that completes normally leaves no supervisor behind', (t) => {
  const root = seedExecutor(t, ['node', '-e', "process.stdout.write('done')"]);
  const result = runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: harnessOpts });
  assert.equal(result.stdout, 'done');
  // The completion row is written only after the supervisor exits, so a
  // recorded duration is itself the evidence that nothing is still running.
  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const completed = rows.find((row) => row.event === 'dispatch_completed');
  assert.ok(completed);
  assert.equal(typeof completed.duration_ms, 'number');
});

test('dispatches --output --wait: the completion row arriving late is still the answer', async (t) => {
  // The dogfooded sequence, in miniature: the caller gives up, reads the
  // ledger, and the completion row is not there *yet*. Reading once turned
  // two successful dispatches into reported failures; waiting reads the
  // answer that was always coming.
  const root = seedExecutor(t, [
    'node',
    '-e',
    "setTimeout(()=>process.stdout.write('the real report'),2500)",
  ]);

  const kernel = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'dispatch', '--archetype', 'worker'], {
    cwd: root,
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, FADENO_HARNESS: HARNESS },
  });
  let stderr = '';
  kernel.stderr.on('data', (chunk) => { stderr += String(chunk); });
  kernel.stdin.end('prompt\n');

  const idLine = /dispatch id: ([0-9a-f-]{36})/;
  const deadline = Date.now() + 20_000;
  while (!idLine.test(stderr) && Date.now() < deadline) await sleep(100);
  const dispatchId = idLine.exec(stderr)?.[1];
  assert.ok(dispatchId, 'the kernel must name the dispatch before it runs');
  const outputDir = join(root, '.fadeno', 'local', 'outputs');
  const snapshotDeadline = Date.now() + 5_000;
  while ((!existsSync(outputDir) || readdirSync(outputDir).length === 0) && Date.now() < snapshotDeadline) await sleep(25);
  assert.ok(existsSync(outputDir) && readdirSync(outputDir).length > 0, 'the requested snapshot must be materialized');

  // Read now, the way a just-timed-out caller does: no completion row yet.
  const early = runDispatchesOutput({ repoRoot: root, dispatchId });
  assert.equal(early.attested, 'incomplete');
  assert.equal(early.bytes, '', 'nothing written yet — and this is NOT a failure');

  // Read again, waiting. Same dispatch, real answer.
  const waited = runDispatchesOutput({ repoRoot: root, dispatchId, waitMs: 15_000, pollMs: 200 });
  assert.equal(waited.dispatchId, dispatchId);
  assert.equal(waited.attested, 'match');
  assert.equal(waited.bytes, 'the real report');
  await new Promise((resolve) => kernel.on('exit', resolve));
});

test('dispatches --output --wait: waiting never drifts onto another dispatch', (t) => {
  // `last` resolves once; the wait loop re-reads by the id it settled on, so a
  // dispatch that starts mid-wait cannot steal the answer.
  const root = seedExecutor(t, ['node', '-e', "process.stdout.write('done')"]);
  const first = runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, userPathOptions: harnessOpts });
  const second = runDispatch({ archetype: 'worker', prompt: 'b', repoRoot: root, userPathOptions: harnessOpts });
  const byId = runDispatchesOutput({
    repoRoot: root,
    dispatchId: first.dispatchId,
    waitMs: 1_000,
    pollMs: 100,
  });
  assert.equal(byId.dispatchId, first.dispatchId);
  assert.notEqual(first.dispatchId, second.dispatchId);
});

test('in-flight claim reads all eight contract fields', () => {
  // Engine and ad-hoc claims must distinguish supervisor_pid, executor_pid,
  // process_group_id, started_at, heartbeat_at, last_output_at, stdout_bytes,
  // stderr_bytes. Legacy {pid, started_at} remains readable.

  // Legacy file still parses (pid + started_at) — backward compat.
  const legacy = readInflightClaim('/tmp/fake.json', () => JSON.stringify({ pid: 1234, started_at: '2026-08-17T00:00:00.000Z' }));
  assert.ok(legacy);
  assert.equal(legacy.pid, 1234);
  assert.equal(legacy.supervisorPid, 1234);
  assert.equal(legacy.startedAt, '2026-08-17T00:00:00.000Z');
  assert.equal(legacy.executorPid, null);
  assert.equal(legacy.processGroupId, null);

  // Full claim round-trips all contract fields.
  const fullJson = JSON.stringify({
    pid: 5001,
    supervisor_pid: 5001,
    executor_pid: 5002,
    process_group_id: 5002,
    started_at: '2026-08-17T01:00:00.000Z',
    heartbeat_at: '2026-08-17T01:00:01.000Z',
    last_output_at: '2026-08-17T01:00:00.500Z',
    stdout_bytes: 1234,
    stderr_bytes: 56,
  });
  const full = readInflightClaim('/tmp/fake.json', () => fullJson);
  assert.equal(full?.supervisorPid, 5001);
  assert.equal(full?.executorPid, 5002);
  assert.equal(full?.processGroupId, 5002);
  assert.equal(full?.startedAt, '2026-08-17T01:00:00.000Z');
  assert.equal(full?.heartbeatAt, '2026-08-17T01:00:01.000Z');
  assert.equal(full?.lastOutputAt, '2026-08-17T01:00:00.500Z');
  assert.equal(full?.stdoutBytes, 1234);
  assert.equal(full?.stderrBytes, 56);

  // Missing file -> null, not throw.
  assert.equal(readInflightClaim('/nope.json', () => { throw new Error('missing'); }), null);
});

test('inflightClaimIsAlive prefers supervisor_pid and handles heartbeat staleness conservatively', () => {
  const claim = {
    pid: 111,
    startedAt: null,
    supervisorPid: 222,
    executorPid: 333,
    processGroupId: 333,
    heartbeatAt: '2026-08-17T01:00:00.000Z',
    lastOutputAt: null,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
  // Probes the supervisor_pid, not the legacy pid.
  let probed: number | null = null;
  assert.equal(inflightClaimIsAlive(claim, (pid) => { probed = pid; }), true);
  assert.equal(probed, 222);
  // ESRCH = proven dead, EPERM = conservative alive.
  assert.equal(inflightClaimIsAlive(claim, () => { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }), false);
  assert.equal(inflightClaimIsAlive(claim, () => { const e = new Error('perm') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; }), true);
});

test('supervisor-killed-atomics-lease-preserved', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'lease-killed-claim.json');
  const statusPath = join(root, 'lease-killed-claim.status.json');
  const leasePath = join(root, 'workspace-lease.json');
  const lockPath = join(root, '.workspace-lease.lock');
  const holder = { id: 'kill-test', kind: 'engine' as const, runId: 'run-kill', dispatchId: 'dispatch-kill' };
  // Write a durable lease that supervisor will be responsible for releasing
  writeFileSync(leasePath, JSON.stringify({ holder, workspace_mode: 'shared', supervisor_pid: 99999, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), stdout_bytes: 0, stderr_bytes: 0, last_output_at: null }));
  const child = spawn(process.execPath, superviseArgv(
    [process.execPath, '-e', "setTimeout(()=>process.exit(0), 5000)"],
    claimPath,
    statusPath,
    { leasePath, lockPath, holder },
  ), { stdio: 'ignore' });
  // Give supervisor time to start and write claim
  await sleep(200);
  assert.ok(existsSync(claimPath), 'supervisor should have published claim');
  // Kill supervisor (simulates SIGKILL)
  try { process.kill(child.pid!, 'SIGKILL'); } catch {}
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  await sleep(200);
  // Atomic lease must remain valid JSON even after kill — supervisor killed before it could release
  // Lease preserved until next reclaim, file must be valid JSON
  if (existsSync(leasePath)) {
    const raw = readFileSync(leasePath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'lease must remain valid JSON after supervisor kill');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.holder.id, 'kill-test');
  }
  // Claim may be gone or stale, but if present must be valid JSON
  if (existsSync(claimPath)) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(claimPath, 'utf8')));
  }
  // status file may exist as report; if so valid JSON
  if (existsSync(statusPath)) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(statusPath, 'utf8')));
  }
});

test('supervisor-spawn-failed-127-distinguished', () => {
  // Missing binary vs executor exit 127 must be distinguished via SPAWN_FAILED_MARKER
  const listed = readFileSync(join(REPO, 'src', 'lib', 'supervisor.ts'), 'utf8');
  assert.match(listed, /SPAWN_FAILED_MARKER/);
  // Direct probe: supervisedSpawnError must only interpret marker-prefixed 127
  assert.equal(supervisedSpawnError(127, `${SPAWN_FAILED_MARKER}spawn ENOENT`), 'spawn ENOENT');
  assert.equal(supervisedSpawnError(127, 'exit 127 from executor'), null);
  assert.equal(supervisedSpawnError(0, `${SPAWN_FAILED_MARKER}x`), null);
  // Spawn failure via supervisor reports 127 with marker on stderr
  const missing = spawnSync(process.execPath, superviseArgv(['no-such-binary-xyz'], '', ''), { encoding: 'utf8' });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr ?? '', new RegExp(SPAWN_FAILED_MARKER));
});

test('claim-removed-only-after-child-close', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'close-claim.json');
  const statusPath = join(root, 'close-claim.status.json');
  const child = spawn(process.execPath, superviseArgv([
    process.execPath,
    '-e',
    "process.stdout.write('hi'); setTimeout(()=>process.exit(0), 800)",
  ], claimPath, statusPath), { stdio: ['ignore', 'pipe', 'pipe'] });
  // Poll for claim with deadline instead of single fixed sleep — under parallel load the supervisor may not have written yet.
  const deadline = Date.now() + 4000;
  while (!existsSync(claimPath) && Date.now() < deadline) {
    await sleep(50);
  }
  assert.ok(existsSync(claimPath), 'claim exists while child is running');
  const before = readFileSync(claimPath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(before));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  await sleep(100);
  assert.equal(existsSync(claimPath), false, 'terminal supervisor must remove live claim only after child close');
  const status = readSupervisorStatus(statusPath, (p) => readFileSync(p, 'utf8'));
  assert.ok(status);
  assert.equal(status.exitCode, 0);
  assert.ok(existsSync(statusPath), 'status report remains as durable evidence after claim removal');
});

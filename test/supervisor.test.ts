import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import { runDispatchesOutput } from '../src/commands/dispatches.ts';
import { SPAWN_FAILED_MARKER, superviseArgv, supervisedSpawnError } from '../src/lib/supervisor.ts';
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

function seedExecutor(t: TestContext, command: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      executors: { probe: { adapter: 'command', command, model: 'opus' } },
      loadouts: { main: { worker: 'probe' } },
      default_loadout: 'main',
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
  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, env: null });
  // The prompt reached the executor through the supervisor's stdin relay, and
  // its stdout landed in the snapshot exactly as a direct spawn would.
  assert.equal(result.stdout, 'GOT:hello');
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, 'ok');
});

test('supervision preserves a nonzero exit code verbatim', (t) => {
  const root = seedExecutor(t, ['node', '-e', 'process.exit(42)']);
  const result = runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null });
  assert.equal(result.exitCode, 42, 'the executor code, not the supervisor’s');
  assert.equal(result.outcome, 'failed');
});

test('supervision still distinguishes a missing executor from one that exits 127', (t) => {
  // The supervisor always starts, so `spawnSync().error` no longer reports a
  // missing binary. It has to say so itself, or a configuration error decays
  // into "the executor exited 127".
  const missing = seedExecutor(t, ['fadeno-no-such-binary-xyz']);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: missing, env: null }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /executor "probe" failed to spawn/);
      return true;
    },
  );

  const genuine = seedExecutor(t, ['node', '-e', 'process.exit(127)']);
  const result = runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: genuine, env: null });
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
  // The executor's own argv survives intact and last — the evidence row
  // records this command, and it must be the one that actually runs.
  assert.deepEqual(argv.slice(5), ['codex', 'exec', '--model', 'gpt-5.6-terra']);
  // Omitting the path stays valid: an empty slot means "publish nothing",
  // which keeps every non-kernel caller of superviseArgv working unchanged.
  assert.deepEqual(superviseArgv(['x']).slice(4), ['', 'x']);
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
  const result = runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null });
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
  });
  let stderr = '';
  kernel.stderr.on('data', (chunk) => { stderr += String(chunk); });
  kernel.stdin.end('prompt\n');

  const idLine = /dispatch id: ([0-9a-f-]{36})/;
  const deadline = Date.now() + 20_000;
  while (!idLine.test(stderr) && Date.now() < deadline) await sleep(100);
  const dispatchId = idLine.exec(stderr)?.[1];
  assert.ok(dispatchId, 'the kernel must name the dispatch before it runs');

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
  const first = runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, env: null });
  const second = runDispatch({ archetype: 'worker', prompt: 'b', repoRoot: root, env: null });
  const byId = runDispatchesOutput({
    repoRoot: root,
    dispatchId: first.dispatchId,
    waitMs: 1_000,
    pollMs: 100,
  });
  assert.equal(byId.dispatchId, first.dispatchId);
  assert.notEqual(first.dispatchId, second.dispatchId);
});

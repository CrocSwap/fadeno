import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runToolRun, ToolRunError } from '../src/commands/tool-run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { runNext } from '../src/commands/next.ts';
import { runShow } from '../src/commands/show.ts';
import { runCancel } from '../src/commands/cancel.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { readEventsStrict } from '../src/lib/run-ledger.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { LedgerWriter, writeRunDocument } from '../src/lib/run-ledger-write.ts';
import { acquireWorkspaceLease, readEffectiveLease, readWorkspaceLease } from '../src/lib/workspace-lease.ts';
import { recoverInterruptedToolDispatchesForHelper } from '../src/lib/tool-exec.ts';
import {
  BUNDLED_CLI,
  SOURCE_CLI,
  collect,
  exitsWith,
  inflightClaimPath,
  isEsrch,
  readClaim,
  readJson,
  runSourceCli,
  seedToolRepo,
  startSourceCli,
  waitUntil,
} from './tool-helpers.ts';

const ECHO_HELLO = ['node', '-e', `console.log('hello')`];
/** Blocks on the first invocation, exits 0 on every later one. */
const HANGS_ONCE = ['node', '-e', `const fs=require('fs');const n=fs.existsSync('runs')?Number(fs.readFileSync('runs','utf8')):0;fs.writeFileSync('runs',String(n+1));n===0&&require('child_process').execSync('sleep 60')`];
/**
 * Waits for the test to drop a `go` file, then records that it ran.
 *
 * The point is the *release*: the test decides exactly when the executor is
 * allowed to exit, which is what makes a window measured in milliseconds on a
 * real clock into a state the test can hold open and inspect.
 */
const WAITS_FOR_GO = ['node', '-e', `const fs=require('fs');const w=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);while(!fs.existsSync('go'))w(10);fs.appendFileSync('counter.txt','x')`];

function statusFileFor(claimPath: string): string {
  return claimPath.replace(/\.json$/, '.status.json');
}

function liveClaimFile(root: string, runId: string): string {
  return inflightClaimPath(root, runId, 'tc-test-g1', 1);
}

function writeLiveClaim(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    pid: process.pid,
    supervisor_pid: process.pid,
    executor_pid: null,
    process_group_id: null,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }));
}

test('a live claim from another attempt blocks the source CLI before spawn', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  writeLiveClaim(liveClaimFile(setup.root, setup.runId));
  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /blocked — another live attempt/.test((err as Error).message),
  );
  assert.ok(!readEventsStrict(setup.runDir).some((e) => e.type === 'tool_dispatched'));
});

test('a live claim from another attempt blocks the bundled CJS binary too (build-boundary parity)', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  writeLiveClaim(liveClaimFile(setup.root, setup.runId));
  const bundled = spawnSync('node', [BUNDLED_CLI, 'tool-run', setup.runId], { cwd: setup.root, encoding: 'utf8' });
  assert.match(`${bundled.stdout}${bundled.stderr}`, /blocked — another live attempt/);
  assert.notEqual(bundled.status, 0);
});

test('two helpers racing the same attempt admit exactly one command, one dispatch, one terminal', async (t) => {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const setup = seedToolRepo(t, { test_runner: { command: ['node', '-e', `require('fs').appendFileSync('counter.txt','x')`] } });
    const [first, second] = await Promise.all([
      collect(startSourceCli(['tool-run', setup.runId], setup.root)),
      collect(startSourceCli(['tool-run', setup.runId], setup.root)),
    ]);

    const events = readEventsStrict(setup.runDir);
    const dispatched = events.filter((e) => e.type === 'tool_dispatched');
    assert.deepEqual(dispatched.map((e) => e.extra.attempt), [1], `iteration ${iteration}: exactly one dispatch`);
    assert.equal(events.filter((e) => e.type === 'tool_completed' || e.type === 'tool_failed').length, 1, `iteration ${iteration}: exactly one terminal receipt`);
    // Opening the generation is a scope decision, so it is made under the same
    // lock as admission: a second `step_started` would shift the invocation
    // number `fadeno prompt` derives from these events.
    assert.equal(events.filter((e) => e.type === 'step_started' && e.step === 'test').length, 1, `iteration ${iteration}: exactly one step_started`);
    const created = events.filter((e) => e.type === 'artifact_created' && e.step === 'test');
    assert.deepEqual(created.map((e) => e.extra.artifact), ['artifacts/test-result.json'], `iteration ${iteration}: one attribution, at the planned path`);

    const counter = existsSync(join(setup.root, 'counter.txt')) ? readFileSync(join(setup.root, 'counter.txt'), 'utf8') : '';
    assert.equal(counter, 'x', `iteration ${iteration}: the command ran exactly once`);

    const winners = [first, second].filter((r) => r.code === 0);
    assert.equal(winners.length, 1, `iteration ${iteration}: exactly one helper succeeded (${JSON.stringify([first, second])})`);
    const loser = [first, second].find((r) => r.code !== 0)!;
    // The taxonomy is deterministic, not a function of how late the loser
    // arrived: recovery leaves every live attempt alone, so locked admission
    // is the only thing that ever refuses one.
    assert.match(
      loser.stderr + loser.stdout,
      /blocked — another live attempt|already has a concurrently published|shared workspace is already held|already attributed|already has a dispatch or terminal receipt|already has a pending dispatch/,
      `iteration ${iteration}: the loser refused with a durable-admission reason`,
    );
    assert.ok(
      !events.some((e) => e.type === 'tool_failed' && e.extra.reason === 'engine_interrupted'),
      `iteration ${iteration}: recovery never declared the live attempt interrupted`,
    );
  }
});

test('a pre-supervisor lease reservation blocks other writers and is reclaimed only once the attempt is proven dead', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const claimRel = `.fadeno/local/inflight/tool-${setup.runId}-tc-test-g1-a1.json`;
  const claimAbs = join(setup.root, claimRel);
  const writeClaim = (fields: Record<string, unknown>): void => {
    mkdirSync(join(claimAbs, '..'), { recursive: true });
    writeFileSync(claimAbs, JSON.stringify({
      started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
      last_output_at: null, stdout_bytes: 0, stderr_bytes: 0, ...fields,
    }));
  };

  // The state a kernel leaves behind when it dies between reserving the lease
  // and its supervisor publishing executor identity: a claim whose executor may
  // still be running, a durable dispatch, and a lease that names no process at
  // all. `process.pid` stands in for that possibly-live executor.
  writeClaim({ pid: 999999, supervisor_pid: 999999, executor_pid: process.pid, process_group_id: null });
  new LedgerWriter(setup.runDir).append({
    type: 'tool_dispatched',
    step: 'test',
    tool: 'test_runner',
    step_execution_id: 'se-test-g1',
    tool_call_id: 'tc-test-g1',
    attempt: 1,
    generation: 1,
    command: exitsWith(0),
    command_sha256: sha256Hex(JSON.stringify(exitsWith(0))),
    supervisor_claim: claimRel,
    workspace_mode: 'shared',
  }, new Date());
  const holder = { id: `tool:${setup.runId}:test:g1:a1`, kind: 'engine' as const, runId: setup.runId, dispatchId: 'tc-test-g1:a1' };
  acquireWorkspaceLease({
    repoRoot: setup.root, workspaceMode: 'shared', holder,
    supervisorPid: null, executorPid: null, processGroupId: null,
  });

  // A reservation naming no process is conservatively live: there is no pid
  // whose death would prove the detached executor is gone, so it blocks.
  assert.ok(readEffectiveLease(setup.root) != null, 'a pid-less reservation still blocks');

  // Recovery leaves a live attempt — and therefore its reservation — alone.
  assert.equal(recoverInterruptedToolDispatchesForHelper(setup.root, setup.runDir, setup.runId), 0);
  assert.ok(existsSync(claimAbs), 'the live claim survives recovery');
  assert.ok(readEffectiveLease(setup.root) != null, 'and so does its reservation');
  assert.ok(!readEventsStrict(setup.runDir).some((e) => e.type === 'workspace_lease_recovered'));
  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /blocked — another live attempt/.test((err as Error).message),
    'no second writer is admitted beside it',
  );

  // Prove the executor gone. Only now may recovery close the attempt and
  // reclaim the reservation, and it says so in the ledger.
  writeClaim({ pid: 999999, supervisor_pid: 999999, executor_pid: null, process_group_id: null });
  assert.equal(recoverInterruptedToolDispatchesForHelper(setup.root, setup.runDir, setup.runId), 1);
  assert.ok(!existsSync(claimAbs), 'the dead claim is cleared');
  assert.equal(readWorkspaceLease(setup.root), null, 'the pid-less reservation is reclaimed');
  const recovered = readEventsStrict(setup.runDir).find((e) => e.type === 'workspace_lease_recovered')!;
  assert.ok(recovered, 'the reclaim is audited');
  assert.equal((recovered.extra.previous_holder as { id: string }).id, holder.id);

  const retry = runToolRun({ repoRoot: setup.root, run: setup.runId });
  assert.equal(retry.status, 'passed');
  assert.equal(retry.attempt, 2);
  assert.equal(runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-lifecycle')?.status, 'ok');
});

test('the pre-supervisor lease reservation names no process at all', async (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: ECHO_HELLO } });
  const leasePath = join(setup.root, '.fadeno', 'local', 'workspace-lease.json');

  // The window under test — reservation taken, supervisor not yet started — is
  // normally the tens of milliseconds it takes to boot node, which is a race to
  // observe rather than a fact to assert. Delaying every node boot by a second
  // makes it a second wide, so what the reader below sees is determined by the
  // code rather than by the scheduler.
  const delayPath = join(setup.root, 'slow-boot.cjs');
  writeFileSync(delayPath, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);\n`);

  const stopPath = join(setup.root, 'sampler-stop');
  const sampler = spawn('node', ['-e', `
    const fs = require('fs');
    const [leasePath, stopPath] = process.argv.slice(1);
    const deadline = Date.now() + 60000;
    const seen = [];
    let reads = 0;
    while (Date.now() < deadline && !fs.existsSync(stopPath)) {
      let record;
      try { record = JSON.parse(fs.readFileSync(leasePath, 'utf8')); } catch { continue; }
      reads += 1;
      if (!record || !record.holder || !String(record.holder.id).startsWith('tool:')) continue;
      const shape = [record.supervisor_pid, record.executor_pid, record.process_group_id]
        .map((pid) => (pid == null ? 'null' : String(pid))).join(',');
      if (seen[seen.length - 1] !== shape) seen.push(shape);
    }
    process.stdout.write(JSON.stringify({ reads, seen }));
  `, leasePath, stopPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sampled = collect(sampler);

  const helper = spawn('node', [SOURCE_CLI, 'tool-run', setup.runId], {
    cwd: setup.root,
    env: { ...process.env, NODE_OPTIONS: `--require ${delayPath}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const helperPid = helper.pid!;
  const finished = await collect(helper);
  writeFileSync(stopPath, '');
  assert.equal(finished.code, 0, finished.stderr);

  const observed = JSON.parse((await sampled).stdout) as { reads: number; seen: string[] };
  assert.ok(observed.reads > 100, `the reader really sampled the lease (${observed.reads} reads)`);
  // A record naming the helper as its supervisor, with no executor and no
  // group, is exactly the shape a reader proves abandoned the moment the helper
  // exits — while its detached executor may still be writing. The reservation
  // must name nothing until the supervisor can name the executor.
  assert.equal(observed.seen[0], 'null,null,null',
    `the reservation is pid-less before the supervisor publishes identity (saw ${JSON.stringify(observed.seen)})`);
  const published = observed.seen.findIndex((shape) => shape.split(',')[1] !== 'null');
  assert.ok(published > 0, `the supervisor then publishes executor identity (${JSON.stringify(observed.seen)})`);
  const namesHelper = observed.seen.findIndex((shape) => shape.split(',')[0] === String(helperPid));
  assert.ok(namesHelper === -1 || namesHelper > published,
    `the helper only names itself once it has taken the attempt back (${JSON.stringify(observed.seen)})`);
  assert.equal(readEffectiveLease(setup.root), null, 'and the completed attempt released it');
});

test('a helper stopped after its child exits but before attribution still owns the attempt, and the second helper cannot re-run it', async (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: WAITS_FOR_GO } });
  const claimPath = liveClaimFile(setup.root, setup.runId);
  const statusPath = statusFileFor(claimPath);

  const first = startSourceCli(['tool-run', setup.runId], setup.root);
  const winner = collect(first);
  // A stopped process is never left behind, however the assertions go.
  t.after(() => {
    try { process.kill(first.pid!, 'SIGCONT'); } catch {}
    try { first.kill('SIGKILL'); } catch {}
  });

  // Freeze the winner while its executor is still blocked, then release the
  // executor. The winner therefore cannot advance past the poll loop: it is
  // parked in exactly the window this repair is about — child reaped and
  // reported, nothing synthesized, placed or attributed yet.
  await waitUntil(() => (readClaim(claimPath)?.executor_pid ?? null) != null, 'the supervisor to publish an executor pid');
  process.kill(first.pid!, 'SIGSTOP');
  writeFileSync(join(setup.root, 'go'), '');
  await waitUntil(() => existsSync(statusPath), 'the supervisor to report its child exit');

  assert.equal(readFileSync(join(setup.root, 'counter.txt'), 'utf8'), 'x', 'the command ran');
  assert.ok(!existsSync(join(setup.runDir, 'artifacts/test-result.json')), 'and nothing is attributed yet');

  // A second helper arrives *inside* that window. Ownership outlives the
  // supervisor, so it must refuse rather than declare the live attempt
  // interrupted and dispatch a second command against the same generation.
  const second = runSourceCli(['tool-run', setup.runId], setup.root);
  assert.notEqual(second.status, 0, 'the second helper is refused');
  assert.match(
    second.stdout + second.stderr,
    /blocked — another live attempt|already has a pending dispatch|shared workspace is already held/,
    'and the refusal comes from admission',
  );

  const during = readEventsStrict(setup.runDir);
  assert.deepEqual(during.filter((e) => e.type === 'tool_dispatched').map((e) => e.extra.attempt), [1],
    'the window admits no second dispatch');
  assert.equal(during.filter((e) => e.type === 'tool_completed' || e.type === 'tool_failed').length, 0,
    'and writes no receipt against the attempt that is still running');
  assert.equal(readFileSync(join(setup.root, 'counter.txt'), 'utf8'), 'x', 'the command still ran exactly once');

  process.kill(first.pid!, 'SIGCONT');
  const result = await winner;
  assert.equal(result.code, 0, `the owner completes its own attempt: ${result.stderr}`);

  const events = readEventsStrict(setup.runDir);
  assert.deepEqual(events.filter((e) => e.type === 'tool_dispatched').map((e) => e.extra.attempt), [1]);
  const terminals = events.filter((e) => e.type === 'tool_completed' || e.type === 'tool_failed');
  assert.deepEqual(terminals.map((e) => `${e.type}:${e.extra.attempt}`), ['tool_completed:1'],
    'exactly one terminal receipt for the attempt');
  const created = events.filter((e) => e.type === 'artifact_created' && e.step === 'test');
  assert.deepEqual(created.map((e) => e.extra.artifact), ['artifacts/test-result.json']);
  assert.equal(readFileSync(join(setup.root, 'counter.txt'), 'utf8'), 'x');

  // The winner's bytes are the bytes the ledger names, and they are the only
  // ones on the planned path.
  const onDisk = readFileSync(join(setup.runDir, 'artifacts/test-result.json'), 'utf8');
  assert.equal(sha256Hex(onDisk), created[0]!.extra.sha256);
  assert.equal(JSON.parse(onDisk).status, 'passed');
  assert.ok(!existsSync(claimPath), 'the owner releases its claim with the terminal receipt');
  assert.equal(readEffectiveLease(setup.root), null, 'and its lease');
  assert.equal(runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-lifecycle')?.status, 'ok');
});

test('run.yaml is published whole, so a concurrent reader never mistakes a current ledger for a legacy one', async (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const runYamlPath = join(setup.runDir, 'run.yaml');
  const document = parseYaml(readFileSync(runYamlPath, 'utf8')) as Record<string, unknown>;

  // Every writer reads this file to gate on `schema_version` before appending.
  // An in-place rewrite is observable mid-truncation, and the reader that lands
  // there refuses the run as a legacy ledger; a reader is the ground truth for
  // whether the publish is atomic, so one runs in its own process throughout.
  const reader = spawn('node', ['-e', `
    const fs = require('fs');
    const deadline = Date.now() + 800;
    let reads = 0, torn = 0;
    while (Date.now() < deadline) {
      reads += 1;
      let text;
      try { text = fs.readFileSync(process.argv[1], 'utf8'); } catch { torn += 1; continue; }
      if (!/^schema_version:/m.test(text)) torn += 1;
    }
    process.stdout.write(JSON.stringify({ reads, torn }));
  `, runYamlPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  let writes = 0;
  const until = Date.now() + 800;
  while (Date.now() < until) {
    writeRunDocument(setup.runDir, document);
    writes += 1;
  }
  const finished = await collect(reader);
  const observed = JSON.parse(finished.stdout) as { reads: number; torn: number };

  assert.ok(writes > 100, `the writer really rewrote run.yaml under the reader (${writes} writes)`);
  assert.ok(observed.reads > 100, `the reader really sampled the file (${observed.reads} reads)`);
  assert.equal(observed.torn, 0, `no read observed a partial run.yaml (${observed.torn} of ${observed.reads})`);
  assert.deepEqual(parseYaml(readFileSync(runYamlPath, 'utf8')), document, 'the published document is unchanged');
  assert.deepEqual(readdirSync(setup.runDir).filter((f) => f.startsWith('run.yaml.tmp')), [], 'no staging file is left behind');
});

test('a helper and a manual completion racing the same generation produce one attribution and keep the winner bytes', async (t) => {
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const setup = seedToolRepo(t, { test_runner: { command: ['node', '-e', `require('fs').appendFileSync('counter.txt','x')`] } });
    const manualPayload = JSON.stringify({
      tool: 'test_runner',
      command: 'hand written',
      status: 'passed',
      exit_code: 0,
      summary: `manual receipt ${iteration}`,
    }, null, 2);
    mkdirSync(join(setup.runDir, 'artifacts'), { recursive: true });
    writeFileSync(join(setup.runDir, 'artifacts', 'test-result.json'), manualPayload);

    const [helper, manual] = await Promise.all([
      collect(startSourceCli(['tool-run', setup.runId], setup.root)),
      collect(startSourceCli(['tool-complete', setup.runId, '--output', 'artifacts/test-result.json'], setup.root)),
    ]);

    const events = readEventsStrict(setup.runDir);
    const created = events.filter((e) => e.type === 'artifact_created' && e.step === 'test');
    assert.equal(created.length, 1, `iteration ${iteration}: exactly one attribution (${JSON.stringify([helper, manual])})`);
    const winners = [helper, manual].filter((r) => r.code === 0);
    assert.equal(winners.length, 1, `iteration ${iteration}: exactly one writer succeeded (${JSON.stringify([helper, manual])})`);

    // Whoever won, the attributed bytes on disk are the bytes the ledger names.
    const onDisk = readFileSync(join(setup.runDir, 'artifacts', 'test-result.json'), 'utf8');
    assert.equal(sha256Hex(onDisk), created[0]!.extra.sha256, `iteration ${iteration}: attributed digest matches the file`);
    if (helper.code === 0) {
      assert.notEqual(onDisk, manualPayload, 'the helper won, so its synthesized result replaced the un-attributed placeholder');
      assert.equal(readFileSync(join(setup.root, 'counter.txt'), 'utf8'), 'x');
    } else {
      assert.equal(onDisk, manualPayload, 'the manual receipt won, and its bytes were never clobbered');
      const counter = existsSync(join(setup.root, 'counter.txt')) ? readFileSync(join(setup.root, 'counter.txt'), 'utf8') : '';
      assert.ok(counter === '' || counter === 'x', `iteration ${iteration}: the command ran at most once, got ${JSON.stringify(counter)}`);
    }
    const terminals = events.filter((e) => e.type === 'tool_completed' || e.type === 'tool_failed');
    assert.ok(terminals.length <= 1, `iteration ${iteration}: at most one tool terminal receipt`);
  }
});

test('a second helper call on an attributed generation refuses without re-running the command', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: ['node', '-e', `require('fs').appendFileSync('counter.txt','y')`] } });
  assert.equal(runToolRun({ repoRoot: setup.root, run: setup.runId }).status, 'passed');
  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /already attributed|not waiting at a tool_call/.test((err as Error).message),
  );
  assert.equal(readFileSync(join(setup.root, 'counter.txt'), 'utf8'), 'y');
  assert.equal(readEventsStrict(setup.runDir).filter((e) => e.type === 'tool_dispatched').length, 1);
});

test('the details digest is attested by the attributing event, and details never completes the step', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: ECHO_HELLO } });
  runToolRun({ repoRoot: setup.root, run: setup.runId });

  const artifact = readJson(setup.runDir, 'artifacts/test-result.json');
  assert.equal(artifact.details_path, 'artifacts/test-result.details.txt');
  const detailsBytes = readFileSync(join(setup.runDir, artifact.details_path));
  assert.match(detailsBytes.toString('utf8'), /hello/);

  const events = readEventsStrict(setup.runDir);
  const created = events.filter((e) => e.type === 'artifact_created');
  assert.deepEqual(created.map((e) => e.extra.artifact), ['artifacts/test-result.json'],
    'the sidecar gets no artifact_created of its own — only the planned TestResult completes the step');
  assert.equal(created[0]!.extra.details_path, artifact.details_path);
  assert.equal(created[0]!.extra.details_sha256, sha256Hex(detailsBytes));
  assert.equal(created[0]!.extra.details_bytes, detailsBytes.length);
  const completed = events.find((e) => e.type === 'tool_completed')!;
  assert.equal(completed.extra.details_sha256, sha256Hex(detailsBytes));

  // The attested sidecar is held to its bytes by verification.
  assert.equal(runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-lifecycle')?.status, 'ok');
  writeFileSync(join(setup.runDir, artifact.details_path), 'tampered');
  const tampered = runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-lifecycle')!;
  assert.equal(tampered.status, 'fail');
  assert.match(tampered.detail, /details_sha256/);
});

test('a failed attribution keeps the sidecar bytes, leaves no planned artifact, and the retry completes the step', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: ECHO_HELLO } });
  const original = LedgerWriter.prototype.append;
  t.after(() => { LedgerWriter.prototype.append = original; });
  LedgerWriter.prototype.append = function patched(this: LedgerWriter, event: any, now: Date) {
    if (event.type === 'artifact_created' && event.artifact === 'artifacts/test-result.json') {
      throw new Error('injected artifact_created failure');
    }
    return original.call(this, event, now);
  } as typeof original;

  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /injected artifact_created failure/.test((err as Error).message),
  );
  LedgerWriter.prototype.append = original;

  const sidecar = join(setup.runDir, 'artifacts/test-result.details.txt');
  assert.ok(existsSync(sidecar), 'the sidecar placed before attribution is never deleted');
  const sidecarBytes = readFileSync(sidecar, 'utf8');
  assert.match(sidecarBytes, /hello/);
  assert.ok(!existsSync(join(setup.runDir, 'artifacts/test-result.json')), 'the un-attributed planned artifact is withdrawn');
  const events = readEventsStrict(setup.runDir);
  assert.ok(!events.some((e) => e.type === 'artifact_created'));
  assert.ok(!events.some((e) => e.type === 'tool_completed'));
  assert.ok(!existsSync(liveClaimFile(setup.root, setup.runId)), 'the claim is released');
  assert.equal(readEffectiveLease(setup.root), null, 'the lease is released');

  const next = runNext({ run: setup.runId, repoRoot: setup.root });
  assert.equal(next.status, 'ready');
  assert.equal(next.step?.id, 'test');

  const retry = runToolRun({ repoRoot: setup.root, run: setup.runId });
  assert.equal(retry.status, 'passed');
  assert.equal(retry.attempt, 2);
  assert.equal(readFileSync(sidecar, 'utf8'), sidecarBytes, 'identical sidecar bytes are reused, not rewritten elsewhere');
  assert.equal(readJson(setup.runDir, 'artifacts/test-result.json').details_path, 'artifacts/test-result.details.txt');
  const after = readEventsStrict(setup.runDir);
  assert.equal(after.filter((e) => e.type === 'artifact_created').length, 1);
  assert.ok(after.some((e) => e.type === 'tool_failed' && e.extra.reason === 'engine_interrupted'), 'the interrupted attempt gets an honest receipt');
  assert.equal(runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-lifecycle')?.status, 'ok');
});

test('a terminal-append failure preserves the already-attributed artifact and its sidecar', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: ECHO_HELLO } });
  const original = LedgerWriter.prototype.append;
  t.after(() => { LedgerWriter.prototype.append = original; });
  LedgerWriter.prototype.append = function patched(this: LedgerWriter, event: any, now: Date) {
    if (event.type === 'tool_completed') throw new Error('injected tool_completed failure');
    return original.call(this, event, now);
  } as typeof original;

  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /injected tool_completed failure/.test((err as Error).message),
  );
  LedgerWriter.prototype.append = original;

  const payload = readJson(setup.runDir, 'artifacts/test-result.json');
  assert.equal(payload.status, 'passed');
  const events = readEventsStrict(setup.runDir);
  const created = events.find((e) => e.type === 'artifact_created')!;
  assert.ok(created, 'the artifact stays attributed');
  assert.ok(!events.some((e) => e.type === 'tool_completed'));
  // Both the artifact and the sidecar it names survive, matching their digests.
  assert.equal(sha256Hex(readFileSync(join(setup.runDir, 'artifacts/test-result.json'))), created.extra.sha256);
  assert.equal(sha256Hex(readFileSync(join(setup.runDir, payload.details_path))), created.extra.details_sha256);
});

test('stale sidecar bytes from a crashed attempt never cause a false concurrent-attribution loop', (t) => {
  const reused = seedToolRepo(t, { test_runner: { command: ECHO_HELLO } });
  mkdirSync(join(reused.runDir, 'artifacts'), { recursive: true });
  writeFileSync(join(reused.runDir, 'artifacts/test-result.details.txt'), 'hello\n');
  const first = runToolRun({ repoRoot: reused.root, run: reused.runId });
  assert.equal(first.status, 'passed');
  assert.equal(readJson(reused.runDir, 'artifacts/test-result.json').details_path, 'artifacts/test-result.details.txt',
    'a leftover sidecar with matching bytes is reused at the planned path');
  assert.ok(!readEventsStrict(reused.runDir).some((e) => e.extra.reason === 'concurrent_attribution'));

  const parked = seedToolRepo(t, { test_runner: { command: ECHO_HELLO } });
  mkdirSync(join(parked.runDir, 'artifacts'), { recursive: true });
  const stale = 'bytes from an attempt that died before attribution\n';
  writeFileSync(join(parked.runDir, 'artifacts/test-result.details.txt'), stale);
  const second = runToolRun({ repoRoot: parked.root, run: parked.runId });
  assert.equal(second.status, 'passed', 'differing leftover bytes do not fail the attempt');
  assert.ok(!readEventsStrict(parked.runDir).some((e) => e.extra.reason === 'concurrent_attribution'),
    'a leftover file is not a concurrent writer');
  assert.equal(readFileSync(join(parked.runDir, 'artifacts/test-result.details.txt'), 'utf8'), stale,
    'the leftover bytes are preserved, never clobbered');
  const payload = readJson(parked.runDir, 'artifacts/test-result.json');
  assert.equal(payload.details_path, 'artifacts/attempts/tc-test-g1-a1.details.txt', 'this attempt parks its own sidecar');
  const created = readEventsStrict(parked.runDir).find((e) => e.type === 'artifact_created')!;
  assert.equal(created.extra.details_path, payload.details_path);
  assert.equal(created.extra.details_sha256, sha256Hex(readFileSync(join(parked.runDir, payload.details_path))));
});

test('a timed-out attempt leaves its recorded process group dead (ESRCH) and attempt 2 succeeds', async (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: HANGS_ONCE, timeout_ms: 1500 } });
  const claimPath = liveClaimFile(setup.root, setup.runId);
  const child = startSourceCli(['tool-run', setup.runId], setup.root);
  const finished = collect(child);

  await waitUntil(() => (readClaim(claimPath)?.executor_pid ?? null) != null, 'the supervisor to publish an executor pid');
  const claim = readClaim(claimPath)!;
  const group = claim.process_group_id ?? claim.executor_pid;
  assert.ok(typeof group === 'number' && group > 0, 'the claim records a process group to kill');

  const result = await finished;
  assert.equal(result.code, 1, `the timed-out attempt is an infrastructure failure: ${result.stderr}`);
  assert.match(result.stderr + result.stdout, /timed out/);

  await waitUntil(() => isEsrch(-group) && isEsrch(group), 'the executor process group to be reaped');
  assert.ok(!existsSync(claimPath), 'the claim of a dead attempt is withdrawn');
  assert.ok(!existsSync(join(setup.runDir, 'artifacts/test-result.json')), 'a timeout never writes the planned artifact');

  const retry = runToolRun({ repoRoot: setup.root, run: setup.runId });
  assert.equal(retry.attempt, 2, 'the retry is a new attempt ordinal');
  assert.equal(retry.status, 'passed');
  const events = readEventsStrict(setup.runDir);
  assert.deepEqual(events.filter((e) => e.type === 'tool_dispatched').map((e) => e.extra.attempt), [1, 2]);
  assert.equal(events.filter((e) => e.type === 'step_started' && e.step === 'test').length, 1,
    'a retry inside the same generation does not append a second step_started');
  assert.equal(runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-lifecycle')?.status, 'ok');
});

test('a lost supervisor with a possibly-live executor keeps claim and lease and blocks retry until the group is dead', async (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: HANGS_ONCE } });
  const claimPath = liveClaimFile(setup.root, setup.runId);
  const child = startSourceCli(['tool-run', setup.runId], setup.root);
  const helperPid = child.pid!;
  const finished = collect(child);

  await waitUntil(() => (readClaim(claimPath)?.executor_pid ?? null) != null, 'the supervisor to publish an executor pid');
  const claim = readClaim(claimPath)!;
  const supervisorPid = claim.supervisor_pid as number;
  const group = (claim.process_group_id ?? claim.executor_pid) as number;
  // Kill the supervisor only: the executor it was watching keeps running.
  process.kill(supervisorPid, 'SIGKILL');

  const result = await finished;
  assert.equal(result.code, 1);
  assert.match(result.stderr + result.stdout, /supervisor lost but executor may still be alive/);
  assert.ok(existsSync(claimPath), 'the claim is kept while the executor may still be running');
  assert.ok(!existsSync(join(setup.runDir, 'artifacts/test-result.json')), 'no planned artifact');
  const events = readEventsStrict(setup.runDir);
  assert.ok(!events.some((e) => e.type === 'tool_completed'));
  assert.ok(!events.some((e) => e.type === 'artifact_created'));
  const lease = readEffectiveLease(setup.root);
  // The helper is dead by now, so a record naming *it* as the supervisor would
  // read as abandoned and stop blocking — whichever side of the supervisor's
  // first publish the kill landed on.
  assert.ok(lease != null && lease.holder.id.startsWith(`tool:${setup.runId}:test:g1:`), 'the writer lease is retained');
  assert.notEqual(lease!.supervisor_pid, helperPid, 'and never reserved under the helper\'s own pid');

  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /blocked — another live attempt|still has live supervisor/.test((err as Error).message),
    'retry is refused while the executor may still be writing',
  );

  process.kill(-group, 'SIGKILL');
  await waitUntil(() => isEsrch(-group) && isEsrch(group), 'the orphaned executor group to die');

  const retry = runToolRun({ repoRoot: setup.root, run: setup.runId });
  assert.equal(retry.status, 'passed', 'once the group is proven dead the step is retryable');
  assert.equal(retry.attempt, 2);
  const after = readEventsStrict(setup.runDir);
  assert.ok(after.some((e) => e.type === 'tool_failed' && e.extra.attempt === 1), 'attempt 1 is closed honestly');
  assert.equal(runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-lifecycle')?.status, 'ok');
});

test('command-binding tampering is caught against the run snapshot', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  runToolRun({ repoRoot: setup.root, run: setup.runId });
  const profilePath = join(setup.runDir, 'profile.yaml');
  const originalText = readFileSync(profilePath, 'utf8');
  const doc = parseYaml(originalText) as any;
  doc.tools.test_runner.command = exitsWith(1);
  const tamperedText = stringifyYaml(doc);
  writeFileSync(profilePath, tamperedText);
  // Re-point the snapshot attestation at the tampered bytes so the check has to
  // reach the binding comparison instead of stopping at the snapshot digest.
  const eventsPath = join(setup.runDir, 'events.jsonl');
  writeFileSync(eventsPath, readFileSync(eventsPath, 'utf8').replace(sha256Hex(originalText), sha256Hex(tamperedText)));

  const finding = runVerify({ repoRoot: setup.root, run: setup.runId }).findings.find((f) => f.check === 'tool-command-digest')!;
  assert.equal(finding.status, 'fail');
  assert.match(finding.detail, /digest|binding|argv/);
});

test('--timeout overrides the registry deadline and --timeout 0 disables it', (t) => {
  const overridden = seedToolRepo(t, { test_runner: { command: ['sleep', '60'], timeout_ms: 300000 } });
  const started = Date.now();
  assert.throws(() => runToolRun({ repoRoot: overridden.root, run: overridden.runId, timeout: '1' }), (err) => err instanceof ToolRunError);
  assert.ok(Date.now() - started < 10000, 'the override deadline, not the registry one, ended the attempt');
  const dispatched = readEventsStrict(overridden.runDir).find((e) => e.type === 'tool_dispatched')!;
  assert.equal(dispatched.extra.timeout_ms, 1000);

  const disabled = seedToolRepo(t, { test_runner: { command: exitsWith(0), timeout_ms: 1000 } });
  assert.equal(runToolRun({ repoRoot: disabled.root, run: disabled.runId, timeout: '0' }).status, 'passed');
  const noDeadline = readEventsStrict(disabled.runDir).find((e) => e.type === 'tool_dispatched')!;
  assert.ok(!('timeout_ms' in noDeadline.extra) || noDeadline.extra.timeout_ms == null);
});

test('show and cancel see this run\'s tool claim and no other run\'s', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const claim = liveClaimFile(setup.root, setup.runId);
  mkdirSync(join(claim, '..'), { recursive: true });
  writeFileSync(claim, JSON.stringify({
    pid: process.pid,
    supervisor_pid: process.pid,
    executor_pid: process.pid,
    process_group_id: process.pid,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }));

  const show = runShow({ run: setup.runId, repoRoot: setup.root });
  assert.ok(show.projection?.harnessObserved.some((h) => h.claimPath.includes(`tool-${setup.runId}-tc-test-g1-a1.json`)));

  const { runId: otherRun } = runNewRun({ repoRoot: setup.root, playbook: 'tool-test', task: 'other' });
  const other = runShow({ run: otherRun, repoRoot: setup.root });
  assert.ok(!other.projection?.harnessObserved.some((h) => h.claimPath.includes(`tool-${setup.runId}-`)),
    'claims are scoped to their own run');

  let killed: number | null = null;
  const cancelled = runCancel({ run: setup.runId, repoRoot: setup.root, kill: (pid) => { killed = pid; } });
  assert.equal(killed, process.pid, 'cancel signals the live supervisor of the tool claim');
  assert.equal(cancelled.resolvedBy, 'supervisor');
  assert.equal(cancelled.actorCallId, 'tc-test-g1');
});

test('recovery closes an interrupted tool dispatch whose supervisor is gone', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const claimRel = `.fadeno/local/inflight/tool-${setup.runId}-tc-test-g1-a1.json`;
  const claimAbs = join(setup.root, claimRel);
  mkdirSync(join(claimAbs, '..'), { recursive: true });
  writeFileSync(claimAbs, JSON.stringify({
    pid: 999999, supervisor_pid: 999999, executor_pid: null, process_group_id: null,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
  }));
  new LedgerWriter(setup.runDir).append({
    type: 'tool_dispatched',
    step: 'test',
    tool: 'test_runner',
    step_execution_id: 'se-test-g1',
    tool_call_id: 'tc-test-g1',
    attempt: 1,
    generation: 1,
    command: exitsWith(0),
    command_sha256: sha256Hex(JSON.stringify(exitsWith(0))),
    supervisor_claim: claimRel,
    workspace_mode: 'shared',
  }, new Date());
  const holder = { id: `tool:${setup.runId}:test:g1:a1`, kind: 'engine', runId: setup.runId, dispatchId: 'tc-test-g1:a1' };
  writeFileSync(join(setup.root, '.fadeno', 'local', 'workspace-lease.json'), JSON.stringify({
    workspace_mode: 'shared', holder, holders: [holder], holder_started_at: {}, holder_heartbeat_at: {},
    supervisor_pid: null, executor_pid: null, process_group_id: null,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
  }, null, 2));

  assert.equal(recoverInterruptedToolDispatchesForHelper(setup.root, setup.runDir, setup.runId), 1);
  const failed = readEventsStrict(setup.runDir).find((e) => e.type === 'tool_failed' && e.extra.tool_call_id === 'tc-test-g1');
  assert.ok(failed);
  assert.equal(failed!.extra.reason, 'engine_interrupted');
  assert.ok(!existsSync(claimAbs), 'the dead claim is cleared');
});

/**
 * Preload that rendezvouses every `fadeno tool-run` process at the ledger read
 * *inside* recovery — the racing point itself, rather than a proxy for it.
 *
 * Starting two CLIs together only reproduces the double-terminal sometimes: it
 * races two node boots against a window a few statements wide. This makes the
 * outcome a property of the code instead of the scheduler by holding each
 * reader *after* its read has returned, until every party has also read. So an
 * unlocked recovery has both readers leaving with the same terminal-free
 * snapshot in hand, and each decides from its own snapshot — both append,
 * every time, no matter which wins the following append. Waiting on the far
 * side of the read is what makes that a guarantee rather than a likelihood: a
 * barrier that released *before* the read still lets a fast winner append
 * inside the release skew, and the loser then reads the receipt.
 *
 * A serialized recovery cannot let them meet at all — the second reader is
 * still waiting on the run lock, outside this hook — so the first leaves on the
 * timeout, and the second then reads a ledger that already names the winner's
 * receipt. Keyed on the exported frame, which both shapes have on the stack,
 * so the barrier arms the same way against a regression that removes the lock.
 */
const RECOVERY_BARRIER = `
const fs = require('fs');
const { join } = require('path');
const dir = process.env.FADENO_TEST_BARRIER_DIR;
const parties = Number(process.env.FADENO_TEST_BARRIER_PARTIES);
const timeoutMs = Number(process.env.FADENO_TEST_BARRIER_TIMEOUT_MS);
const frame = process.env.FADENO_TEST_BARRIER_FRAME;
if (dir) {
  const realReadFileSync = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (path, ...rest) {
    const bytes = realReadFileSync.call(this, path, ...rest);
    if (armed && typeof path === 'string' && path.endsWith('events.jsonl')) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 80;
      const stack = new Error().stack || '';
      Error.stackTraceLimit = limit;
      if (stack.includes(frame)) {
        armed = false;
        const marker = join(dir, 'arrived-' + process.pid + '.json');
        fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, met: false }));
        const deadline = Date.now() + timeoutMs;
        let met = false;
        while (Date.now() < deadline) {
          if (fs.readdirSync(dir).length >= parties) { met = true; break; }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, met }));
      }
    }
    return bytes;
  };
}
`;

/**
 * Long enough that two concurrently started CLIs always meet when nothing
 * serializes them, short enough that the serialized winner's unmet wait stays a
 * bounded cost. It is only ever paid by the process that wins the run lock.
 */
const BARRIER_TIMEOUT_MS = 1500;

test('two tool-runs racing recovery over the same dead attempt append exactly one interrupted receipt', async (t) => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const command = ['node', '-e', `require('fs').appendFileSync('counter.txt','x')`];
    const setup = seedToolRepo(t, { test_runner: { command } });

    // The state any crashed or killed attempt leaves: a durable dispatch, a
    // claim naming a process that is provably gone, and the reservation that
    // attempt was holding. Recovery is the only thing that can close it.
    const claimRel = `.fadeno/local/inflight/tool-${setup.runId}-tc-test-g1-a1.json`;
    const claimAbs = join(setup.root, claimRel);
    mkdirSync(join(claimAbs, '..'), { recursive: true });
    writeFileSync(claimAbs, JSON.stringify({
      pid: 999999, supervisor_pid: 999999, executor_pid: null, process_group_id: null, owner_pid: null,
      started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
      last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
    }));
    new LedgerWriter(setup.runDir).append({
      type: 'tool_dispatched',
      step: 'test',
      tool: 'test_runner',
      step_execution_id: 'se-test-g1',
      tool_call_id: 'tc-test-g1',
      attempt: 1,
      generation: 1,
      command,
      command_sha256: sha256Hex(JSON.stringify(command)),
      supervisor_claim: claimRel,
      workspace_mode: 'shared',
    }, new Date());
    const holder = { id: `tool:${setup.runId}:test:g1:a1`, kind: 'engine' as const, runId: setup.runId, dispatchId: 'tc-test-g1:a1' };
    acquireWorkspaceLease({
      repoRoot: setup.root, workspaceMode: 'shared', holder,
      supervisorPid: null, executorPid: null, processGroupId: null,
    });

    const barrierPath = join(setup.root, 'recovery-barrier.cjs');
    writeFileSync(barrierPath, RECOVERY_BARRIER);
    const barrierDir = join(setup.root, 'barrier');
    mkdirSync(barrierDir, { recursive: true });
    const env = {
      ...process.env,
      NODE_OPTIONS: `--require ${barrierPath}`,
      FADENO_TEST_BARRIER_DIR: barrierDir,
      FADENO_TEST_BARRIER_PARTIES: '2',
      FADENO_TEST_BARRIER_TIMEOUT_MS: String(BARRIER_TIMEOUT_MS),
      FADENO_TEST_BARRIER_FRAME: 'recoverInterruptedToolDispatchesShared',
    };
    const start = (): ReturnType<typeof spawn> =>
      spawn('node', [SOURCE_CLI, 'tool-run', setup.runId], { cwd: setup.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const [first, second] = await Promise.all([collect(start()), collect(start())]);
    const both = `${first.stdout}${first.stderr}${second.stdout}${second.stderr}`;

    // Without this the rest proves nothing: a run where only one process ever
    // reached the read would pass an unserialized recovery too.
    const arrivals = readdirSync(barrierDir);
    assert.equal(arrivals.length, 2, `iteration ${iteration}: both processes reached recovery's ledger read (${JSON.stringify(arrivals)})`);

    const events = readEventsStrict(setup.runDir);
    const interrupted = events.filter((e) => e.type === 'tool_failed' && e.extra.tool_call_id === 'tc-test-g1' && e.extra.attempt === 1);
    assert.equal(interrupted.length, 1, `iteration ${iteration}: the dead attempt is closed exactly once (${both})`);
    assert.equal(interrupted[0]!.extra.reason, 'engine_interrupted');

    const terminals = new Map<string, number>();
    for (const e of events) {
      if (e.type !== 'tool_completed' && e.type !== 'tool_failed') continue;
      const key = `${e.extra.tool_call_id}:a${e.extra.attempt}`;
      terminals.set(key, (terminals.get(key) ?? 0) + 1);
    }
    assert.deepEqual([...terminals.values()].filter((count) => count > 1), [],
      `iteration ${iteration}: no attempt has more than one terminal receipt (${JSON.stringify([...terminals])})`);

    // Recovery closing a1 is what makes a2 admissible, and locked admission is
    // what keeps a2 single: one retry, one command, one attribution.
    assert.deepEqual(events.filter((e) => e.type === 'tool_dispatched').map((e) => e.extra.attempt), [1, 2],
      `iteration ${iteration}: exactly one retry was dispatched`);
    assert.equal(readFileSync(join(setup.root, 'counter.txt'), 'utf8'), 'x',
      `iteration ${iteration}: the winning retry executed exactly once`);
    assert.deepEqual(
      events.filter((e) => e.type === 'artifact_created' && e.step === 'test').map((e) => e.extra.artifact),
      ['artifacts/test-result.json'],
      `iteration ${iteration}: one attribution, at the planned path`,
    );
    const winners = [first, second].filter((r) => r.code === 0);
    assert.equal(winners.length, 1, `iteration ${iteration}: exactly one helper succeeded (${both})`);

    const findings = runVerify({ repoRoot: setup.root, run: setup.runId }).findings;
    assert.equal(findings.find((f) => f.check === 'tool-lifecycle')?.status, 'ok',
      `iteration ${iteration}: ${findings.find((f) => f.check === 'tool-lifecycle')?.detail}`);
    // Everything except the run's own completion: the run is deliberately
    // parked at the gate after the tool step, so `terminal-status` reporting an
    // incomplete trace is the fixture, not a finding.
    assert.deepEqual(
      findings.filter((f) => f.status === 'fail' && f.check !== 'terminal-status').map((f) => `${f.check}: ${f.detail}`),
      [],
      `iteration ${iteration}: verify is green`,
    );
  }
});

test('runNext advice names tool-run for a registered test-result tool and the manual fallback otherwise', (t) => {
  const registered = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  assert.match(runNext({ run: registered.runId, repoRoot: registered.root }).advice, /tool-run/);

  const unregistered = seedToolRepo(t, {}, [{ id: 'test', kind: 'tool_call', tool: 'missing', output: 'TestResult' }]);
  assert.match(runNext({ run: unregistered.runId, repoRoot: unregistered.root }).advice, /tool-complete/);

  const ineligible = seedToolRepo(t, { test_runner: { command: exitsWith(0) } }, [{ id: 'test', kind: 'tool_call', tool: 'test_runner', output: 'Diff' }]);
  const advice = runNext({ run: ineligible.runId, repoRoot: ineligible.root }).advice;
  assert.match(advice, /only supports test-result/);
  assert.match(advice, /tool-complete/);
});

test('tool-run refuses a run whose ledger has no ready tool_call step', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  runToolRun({ repoRoot: setup.root, run: setup.runId });
  const before = readFileSync(join(setup.runDir, 'artifacts/test-result.json'));
  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /not waiting at a tool_call/.test((err as Error).message),
  );
  assert.deepEqual(readFileSync(join(setup.runDir, 'artifacts/test-result.json')), before);
  rmSync(join(setup.runDir, 'artifacts/test-result.details.txt'), { force: true });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runToolRun, ToolRunError } from '../src/commands/tool-run.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runVerify } from '../src/commands/verify.ts';
import { runGate } from '../src/commands/gate.ts';
import { runNext } from '../src/commands/next.ts';
import { readEventsStrict } from '../src/lib/run-ledger.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { acquireWorkspaceLease, readEffectiveLease, releaseWorkspaceLease } from '../src/lib/workspace-lease.ts';
import { TOOL_SUMMARY_MAX_BYTES, TOOL_DETAILS_MAX_BYTES } from '../src/lib/tool-exec.ts';
import {
  BUNDLED_CLI,
  TOOL_STEP,
  collect,
  exitsWith,
  gatedFlow,
  inflightClaimPath,
  loopFlow,
  readJson,
  runSourceCli,
  seedToolRepo,
} from './tool-helpers.ts';
import { spawnSync } from 'node:child_process';

function findingFor(findings: Array<{ check: string; status: string; detail: string }>, check: string) {
  const found = findings.find((f) => f.check === check);
  assert.ok(found, `expected a ${check} finding`);
  return found;
}

function artifactEvents(runDir: string, step: string) {
  return readEventsStrict(runDir).filter((e) => e.type === 'artifact_created' && e.step === step);
}

test('helper executes exit 0 into a passed TestResult at the planned path, with contiguous events and green verification', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const result = runToolRun({ repoRoot: setup.root, run: setup.runId });

  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.artifact, 'artifacts/test-result.json');
  const payload = readJson(setup.runDir, 'artifacts/test-result.json');
  assert.equal(payload.status, 'passed');
  assert.equal(payload.exit_code, 0);

  const events = readEventsStrict(setup.runDir);
  const seqs = events.map((e) => e.seq);
  for (let i = 1; i < seqs.length; i += 1) assert.equal(seqs[i], (seqs[i - 1] as number) + 1);

  // Exactly one step-completing artifact event, and it names the planned output.
  const created = artifactEvents(setup.runDir, 'test');
  assert.equal(created.length, 1);
  assert.equal(created[0]!.extra.artifact, 'artifacts/test-result.json');

  const verify = runVerify({ repoRoot: setup.root, run: setup.runId });
  assert.equal(findingFor(verify.findings, 'tool-result-coherence').status, 'ok');
  assert.equal(findingFor(verify.findings, 'tool-command-digest').status, 'ok');
  assert.equal(findingFor(verify.findings, 'tool-lifecycle').status, 'ok');
});

test('helper executes a nonzero exit into a failed TestResult that routes the tests_pass fail branch', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(2) } }, gatedFlow());
  const result = runToolRun({ repoRoot: setup.root, run: setup.runId });

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 2);
  const payload = readJson(setup.runDir, 'artifacts/test-result.json');
  assert.equal(payload.status, 'failed');
  assert.equal(payload.exit_code, 2);

  const gate = runGate({ repoRoot: setup.root, run: setup.runId, condition: 'tests_pass', artifact: 'artifacts/test-result.json' });
  assert.equal(gate.pass, false);

  // A nonzero command is a completed tool result, never engine infrastructure.
  const events = readEventsStrict(setup.runDir);
  assert.ok(events.some((e) => e.type === 'tool_completed' && e.extra.status === 'failed'));
  assert.ok(!events.some((e) => e.type === 'tool_failed'));
});

test('drive executes a registered exit-0 tool itself and continues past the gate', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } }, gatedFlow());
  const outcome = runDrive({ repoRoot: setup.root, run: setup.runId });

  const events = readEventsStrict(setup.runDir);
  const dispatched = events.filter((e) => e.type === 'tool_dispatched');
  assert.equal(dispatched.length, 1, 'drive itself dispatched the tool exactly once');
  const completed = events.find((e) => e.type === 'tool_completed');
  assert.ok(completed);
  assert.equal(completed!.extra.status, 'passed');
  const gate = events.find((e) => e.type === 'gate_evaluated' && e.step === 'gate');
  assert.ok(gate, 'drive evaluated the downstream gate');
  assert.equal(gate!.extra.result, 'pass');
  assert.equal(outcome.outcome, 'paused_human_gate');
  assert.notEqual(outcome.outcome, 'executor_failed');
});

test('drive executes a registered nonzero tool itself and routes the tests_pass fail branch', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(3) } }, gatedFlow());
  const outcome = runDrive({ repoRoot: setup.root, run: setup.runId });

  const events = readEventsStrict(setup.runDir);
  assert.equal(events.filter((e) => e.type === 'tool_dispatched').length, 1);
  const completed = events.find((e) => e.type === 'tool_completed');
  assert.ok(completed);
  assert.equal(completed!.extra.status, 'failed');
  assert.equal(completed!.extra.exit_code, 3);
  const gate = events.find((e) => e.type === 'gate_evaluated' && e.step === 'gate');
  assert.ok(gate);
  assert.equal(gate!.extra.result, 'fail');
  assert.notEqual(outcome.outcome, 'executor_failed');
  // The fail branch is a distinct terminal step, and drive reached it.
  const decision = events.find((e) => e.type === 'decision_requested');
  assert.equal(decision?.step, 'fail');
});

test('unregistered tool, ineligible artifact type, and --tool mismatch each refuse before any spawn, event, claim, or snapshot', (t) => {
  const unregistered = seedToolRepo(t, {}, [{ ...TOOL_STEP, tool: 'missing' }]);
  const before = readEventsStrict(unregistered.runDir).length;
  assert.throws(
    () => runToolRun({ repoRoot: unregistered.root, run: unregistered.runId }),
    (err) => err instanceof ToolRunError && /not registered/.test(err.message),
  );
  assert.equal(readEventsStrict(unregistered.runDir).length, before);
  assert.ok(!existsSync(inflightClaimPath(unregistered.root, unregistered.runId, 'tc-test-g1', 1)));
  assert.ok(!existsSync(join(unregistered.runDir, 'profile.yaml')), 'no snapshot for an unregistered tool');

  const ineligible = seedToolRepo(t, { test_runner: { command: exitsWith(0) } }, [{ ...TOOL_STEP, output: 'Diff' }]);
  assert.throws(
    () => runToolRun({ repoRoot: ineligible.root, run: ineligible.runId }),
    (err) => /only supports test-result/.test((err as Error).message) && /tool-complete/.test((err as Error).message),
  );
  assert.ok(!readEventsStrict(ineligible.runDir).some((e) => e.type === 'tool_dispatched'));

  const mismatch = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  assert.throws(
    () => runToolRun({ repoRoot: mismatch.root, run: mismatch.runId, tool: 'wrong' }),
    (err) => /--tool mismatch/.test((err as Error).message),
  );
  assert.ok(!existsSync(inflightClaimPath(mismatch.root, mismatch.runId, 'tc-test-g1', 1)));
  assert.ok(!readEventsStrict(mismatch.runDir).some((e) => e.type === 'tool_dispatched'));
});

test('spawn failure, timeout, and signal never produce passed and never complete the step', (t) => {
  const cases: Array<{ label: string; command: string[]; timeoutMs?: number }> = [
    { label: 'spawn failure', command: ['/nonexistent-tool-binary'] },
    { label: 'timeout', command: ['sleep', '60'], timeoutMs: 1000 },
    { label: 'signal', command: ['node', '-e', 'process.kill(process.pid, "SIGKILL")'] },
  ];
  for (const testCase of cases) {
    const setup = seedToolRepo(t, {
      test_runner: { command: testCase.command, ...(testCase.timeoutMs ? { timeout_ms: testCase.timeoutMs } : {}) },
    });
    assert.throws(
      () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
      (err) => err instanceof ToolRunError && !/passed/.test(err.message),
      `${testCase.label} must raise an infrastructure failure`,
    );

    assert.ok(!existsSync(join(setup.runDir, 'artifacts/test-result.json')), `${testCase.label}: no planned artifact`);
    assert.ok(existsSync(join(setup.runDir, 'artifacts/attempts/tc-test-g1-a1.json')), `${testCase.label}: attempt evidence parked`);
    const parked = readJson(setup.runDir, 'artifacts/attempts/tc-test-g1-a1.json');
    assert.equal(parked.status, 'error', `${testCase.label}: parked result is an error`);
    assert.equal(parked.exit_code, null);
    assert.ok(!existsSync(inflightClaimPath(setup.root, setup.runId, 'tc-test-g1', 1)), `${testCase.label}: claim released`);
    assert.equal(readEffectiveLease(setup.root), null, `${testCase.label}: lease released`);

    // The parked error result carries no step-completing artifact event, so the
    // step is still the next actionable thing — the attempt stays retryable.
    assert.equal(artifactEvents(setup.runDir, 'test').length, 0, `${testCase.label}: no artifact_created`);
    const next = runNext({ run: setup.runId, repoRoot: setup.root });
    assert.equal(next.status, 'ready', `${testCase.label}: step still ready`);
    assert.equal(next.step?.id, 'test');
    const failed = readEventsStrict(setup.runDir).find((e) => e.type === 'tool_failed');
    assert.ok(failed, `${testCase.label}: terminal receipt recorded`);
    assert.equal(failed!.extra.output, 'artifacts/attempts/tc-test-g1-a1.json');
    assert.equal(failed!.extra.output_sha256, sha256Hex(readFileSync(join(setup.runDir, 'artifacts/attempts/tc-test-g1-a1.json'))));
  }
});

test('two loop generations write .v2 and .v3 with distinct preserved bytes and per-generation causal ordering', (t) => {
  // Fails the first run, passes the second: two genuine iterations of the loop.
  const command = ['node', '-e', `const fs=require('fs');const n=fs.existsSync('runs')?Number(fs.readFileSync('runs','utf8')):0;fs.writeFileSync('runs',String(n+1));console.log('iteration '+n);process.exit(n===0?4:0)`];
  const setup = seedToolRepo(t, { test_runner: { command } }, loopFlow(3));

  const first = runToolRun({ repoRoot: setup.root, run: setup.runId });
  assert.equal(first.status, 'failed');
  assert.equal(first.artifact, 'artifacts/test-result.v2.json');
  runDrive({ repoRoot: setup.root, run: setup.runId });

  const g2 = readJson(setup.runDir, 'artifacts/test-result.v2.json');
  const g3 = readJson(setup.runDir, 'artifacts/test-result.v3.json');
  assert.equal(g2.status, 'failed');
  assert.equal(g2.exit_code, 4);
  assert.equal(g3.status, 'passed');
  assert.equal(g3.exit_code, 0);

  const details2 = readFileSync(join(setup.runDir, g2.details_path), 'utf8');
  const details3 = readFileSync(join(setup.runDir, g3.details_path), 'utf8');
  assert.equal(g2.details_path, 'artifacts/test-result.v2.details.txt');
  assert.equal(g3.details_path, 'artifacts/test-result.v3.details.txt');
  assert.ok(details2.includes('iteration 0'));
  assert.ok(details3.includes('iteration 1'));
  assert.notEqual(details2, details3, 'each generation keeps its own details bytes');

  const events = readEventsStrict(setup.runDir);
  const index = (predicate: (e: (typeof events)[number]) => boolean, label: string): number => {
    const at = events.findIndex(predicate);
    assert.ok(at >= 0, `missing event: ${label}`);
    return at;
  };
  for (const generation of [2, 3]) {
    const iteration = generation - 1;
    const iterationStart = index((e) => e.type === 'loop_iteration_started' && e.step === 'loop' && e.extra.iteration === iteration, `loop_iteration_started ${iteration}`);
    const dispatched = index((e) => e.type === 'tool_dispatched' && e.extra.generation === generation, `tool_dispatched g${generation}`);
    const created = index((e) => e.type === 'artifact_created' && e.extra.artifact === `artifacts/test-result.v${generation}.json`, `artifact_created g${generation}`);
    const completed = index((e) => e.type === 'tool_completed' && e.extra.generation === generation, `tool_completed g${generation}`);
    const started = events.findIndex((e, at) => at > iterationStart && e.type === 'step_started' && e.step === 'test');
    assert.ok(started > iterationStart, `g${generation}: step_started follows the iteration start`);
    assert.ok(started < dispatched, `g${generation}: step_started precedes the dispatch`);
    assert.ok(dispatched < created, `g${generation}: dispatch precedes attribution`);
    assert.ok(created < completed, `g${generation}: attribution precedes the terminal receipt`);
    // Exactly one start per generation: a scope, not a count.
    const startsInScope = events.filter((e, at) => at > iterationStart && at < dispatched && e.type === 'step_started' && e.step === 'test');
    assert.equal(startsInScope.length, 1, `g${generation}: exactly one step_started in scope`);
  }

  // Each generation is attributed exactly once, by its planned TestResult only.
  const created = artifactEvents(setup.runDir, 'test');
  assert.deepEqual(created.map((e) => e.extra.artifact), ['artifacts/test-result.v2.json', 'artifacts/test-result.v3.json']);
  for (const event of created) {
    assert.equal(event.extra.details_sha256, sha256Hex(readFileSync(join(setup.runDir, event.extra.details_path as string))));
  }

  assert.equal(findingFor(runVerify({ repoRoot: setup.root, run: setup.runId }).findings, 'tool-lifecycle').status, 'ok');
});

test("a foreign writer's lease refuses before spawn; a normal completion releases the lease", (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const holder = { id: 'tool:other-run:step:g1:a1', kind: 'engine' as const, runId: 'other-run', dispatchId: 'x' };
  acquireWorkspaceLease({ repoRoot: setup.root, workspaceMode: 'shared', holder, supervisorPid: process.pid, executorPid: process.pid, processGroupId: process.pid });

  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /already held/.test((err as Error).message),
  );
  const refused = readEventsStrict(setup.runDir);
  assert.ok(!refused.some((e) => e.type === 'tool_dispatched'), 'refused before spawn');
  // A refusal opens nothing. `step_started` is a scope decision, and appending
  // one for a caller that was told to wait would shift the invocation number
  // `fadeno prompt` derives from these events. (The immutable binding snapshot
  // is still attested — it records what this run is bound to, not an attempt.)
  assert.ok(!refused.some((e) => e.type === 'step_started' && e.step === 'test'), 'and opened no step scope');
  releaseWorkspaceLease({ repoRoot: setup.root, holder });

  assert.equal(runToolRun({ repoRoot: setup.root, run: setup.runId }).status, 'passed');
  assert.equal(readEffectiveLease(setup.root), null, 'normal completion releases the lease');
});

for (const stream of ['stdout', 'stderr'] as const) {
  test(`${stream} over 32 MiB is bounded in the recorded evidence while the observed exit is preserved`, (t) => {
    const exitCode = stream === 'stdout' ? 7 : 5;
    const sink = stream === 'stdout' ? 'process.stdout' : 'process.stderr';
    const fill = stream === 'stdout' ? 'a' : 'b';
    // 33 MiB, past the 32 MiB read bound. `process.exitCode` rather than
    // `process.exit()`: exiting outright would drop the pipe's pending writes
    // and the test would silently stop exercising the oversize path.
    const command = ['node', '-e', `const b=Buffer.alloc(1024*1024,'${fill}');for(let i=0;i<33;i++)${sink}.write(b);process.exitCode=${exitCode}`];
    const setup = seedToolRepo(t, { test_runner: { command } });

    const result = runToolRun({ repoRoot: setup.root, run: setup.runId });
    assert.equal(result.status, 'failed', 'oversized output is still a completed nonzero result');
    assert.equal(result.exitCode, exitCode, 'the observed exit survives truncation');

    const completed = readEventsStrict(setup.runDir).find((e) => e.type === 'tool_completed');
    assert.ok(completed);
    const emitted = completed!.extra[`${stream}_bytes`] as number;
    assert.ok(emitted > 32 * 1024 * 1024, `the tool really emitted over 32 MiB on ${stream} (measured ${emitted})`);

    const payload = readJson(setup.runDir, 'artifacts/test-result.json');
    assert.equal(payload.exit_code, exitCode);
    assert.ok(Buffer.byteLength(payload.summary, 'utf8') <= TOOL_SUMMARY_MAX_BYTES, 'summary stays bounded');
    const details = readFileSync(join(setup.runDir, payload.details_path), 'utf8');
    assert.ok(Buffer.byteLength(details, 'utf8') <= TOOL_DETAILS_MAX_BYTES, 'details stay bounded');
    if (stream === 'stdout') {
      assert.ok(payload.summary.includes('…[truncated]'), 'oversized stdout is marked truncated');
      assert.ok(details.includes('…[truncated]'));
    } else {
      // Oversized stderr is kept as a bounded tail, so the evidence is the last
      // 400 bytes rather than a truncated head.
      assert.equal(Buffer.byteLength(details, 'utf8'), 400);
      assert.match(details, /^b+$/);
    }
  });
}

test('verify fails on TestResult tampering and on binding tampering, and skips measured checks for legacy manual receipts', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  runToolRun({ repoRoot: setup.root, run: setup.runId });

  const artifactPath = join(setup.runDir, 'artifacts/test-result.json');
  const original = readFileSync(artifactPath, 'utf8');
  writeFileSync(artifactPath, JSON.stringify({ ...JSON.parse(original), status: 'failed' }));
  assert.equal(findingFor(runVerify({ repoRoot: setup.root, run: setup.runId }).findings, 'tool-result-coherence').status, 'fail');
  writeFileSync(artifactPath, original);

  const profilePath = join(setup.runDir, 'profile.yaml');
  writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace('test_runner', 'test_runner_tampered'));
  assert.equal(findingFor(runVerify({ repoRoot: setup.root, run: setup.runId }).findings, 'tool-command-digest').status, 'fail');

  const legacy = seedToolRepo(t, {});
  const manual = join(legacy.runDir, 'artifacts/test-result.json');
  mkdirSync(join(legacy.runDir, 'artifacts'), { recursive: true });
  writeFileSync(manual, JSON.stringify({ tool: 'test_runner', command: 'manual', status: 'failed', exit_code: null, summary: 'hand-written receipt' }));
  new LedgerWriter(legacy.runDir).append({
    type: 'artifact_created',
    step: 'test',
    artifact: 'artifacts/test-result.json',
    bytes: 10,
    sha256: sha256Hex(readFileSync(manual, 'utf8')),
    media_type: 'application/json',
    validation: { schema: 'test-result', ok: true },
    artifact_id: 'artifact-1',
    generation: 1,
  }, new Date());
  const legacyFindings = runVerify({ repoRoot: legacy.root, run: legacy.runId }).findings;
  assert.equal(findingFor(legacyFindings, 'tool-result-coherence').status, 'skip');
  assert.equal(findingFor(legacyFindings, 'tool-command-digest').status, 'skip');
});

test('a dangling tool_dispatched fails tool-lifecycle, and removing the measured profile snapshot fails tool-command-digest', (t) => {
  const dangling = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  new LedgerWriter(dangling.runDir).append({
    type: 'tool_dispatched',
    step: 'test',
    tool: 'test_runner',
    step_execution_id: 'se-test-g1',
    tool_call_id: 'tc-test-g1',
    attempt: 1,
    generation: 1,
    command: exitsWith(0),
    command_sha256: sha256Hex(JSON.stringify(exitsWith(0))),
    supervisor_claim: '.fadeno/local/inflight/tool-missing.json',
    workspace_mode: 'shared',
  }, new Date());
  const lifecycle = findingFor(runVerify({ repoRoot: dangling.root, run: dangling.runId }).findings, 'tool-lifecycle');
  assert.equal(lifecycle.status, 'fail');
  assert.match(lifecycle.detail, /no terminal receipt/);

  const measured = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  runToolRun({ repoRoot: measured.root, run: measured.runId });
  rmSync(join(measured.runDir, 'profile.yaml'), { force: true });
  const digest = findingFor(runVerify({ repoRoot: measured.root, run: measured.runId }).findings, 'tool-command-digest');
  assert.equal(digest.status, 'fail');
  assert.match(digest.detail, /profile snapshot missing/);
});

test('an invalid synthesized TestResult leaves no planned artifact and the step stays retryable', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  // Narrow the run's own schema snapshot so the synthesized object cannot pass.
  const schemaDir = join(setup.runDir, 'definitions', 'schemas');
  mkdirSync(schemaDir, { recursive: true });
  const schemaPath = join(schemaDir, 'test-result.schema.json');
  writeFileSync(schemaPath, JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'TestResult',
    type: 'object',
    required: ['tool', 'status', 'exit_code', 'summary', 'attested_by_a_human'],
    properties: { attested_by_a_human: { type: 'string' } },
  }, null, 2));

  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => err instanceof ToolRunError && /failed validation/.test(err.message),
  );
  assert.ok(!existsSync(join(setup.runDir, 'artifacts/test-result.json')), 'no planned success artifact');
  assert.equal(artifactEvents(setup.runDir, 'test').length, 0);
  const failed = readEventsStrict(setup.runDir).find((e) => e.type === 'tool_failed');
  assert.ok(failed, 'the attempt still gets a terminal receipt');
  assert.equal(failed!.extra.output_valid, false);
  assert.ok(!existsSync(inflightClaimPath(setup.root, setup.runId, 'tc-test-g1', 1)), 'claim released');
  assert.equal(readEffectiveLease(setup.root), null, 'lease released');

  // Restore the schema: the same step retries as attempt 2 and completes.
  rmSync(schemaPath, { force: true });
  const next = runNext({ run: setup.runId, repoRoot: setup.root });
  assert.equal(next.status, 'ready');
  assert.equal(next.step?.id, 'test');
  const retry = runToolRun({ repoRoot: setup.root, run: setup.runId });
  assert.equal(retry.status, 'passed');
  assert.equal(retry.attempt, 2);
});

test('tool-run help, completion, and exit codes from the source CLI; bundled help stays in parity', (t) => {
  const help = runSourceCli(['tool-run', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /fadeno tool-run <run> \[--tool <name>\] \[--timeout <seconds>\]/);
  assert.match(help.stdout, /--tool/);
  assert.match(help.stdout, /--timeout/);

  const bundled = spawnSync('node', [BUNDLED_CLI, 'tool-run', '--help'], { encoding: 'utf8' });
  assert.equal(bundled.status, 0);
  assert.match(bundled.stdout, /fadeno tool-run <run> \[--tool <name>\] \[--timeout <seconds>\]/);

  const completion = runSourceCli(['completion', 'candidates', '3', '--', 'fadeno', 'tool-run', 'myrun', '--']);
  assert.match(completion.stdout, /--tool/);
  assert.match(completion.stdout, /--timeout/);

  const passed = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const failed = seedToolRepo(t, { test_runner: { command: exitsWith(3) } });
  const infra = seedToolRepo(t, { test_runner: { command: ['/nonexistent-tool-binary'] } });

  const passedRun = runSourceCli(['tool-run', passed.runId], passed.root);
  assert.equal(passedRun.status, 0, passedRun.stderr);
  assert.match(passedRun.stdout, /→ passed \(exit 0\)/);

  const failedRun = runSourceCli(['tool-run', failed.runId], failed.root);
  assert.equal(failedRun.status, 0, 'a failed tool result is a recorded result, not a CLI error');
  assert.match(failedRun.stdout, /→ failed \(exit 3\)/);

  const infraRun = runSourceCli(['tool-run', infra.runId], infra.root);
  assert.equal(infraRun.status, 1, 'infrastructure failure exits nonzero');
});

test('tool-run accepts a unique run prefix and prints the path of the artifact it wrote', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  const prefix = setup.runId.slice(0, 15);
  assert.notEqual(prefix, setup.runId, 'the prefix must actually be shorter than the run id');

  const result = runSourceCli(['tool-run', prefix], setup.root);
  assert.equal(result.status, 0, result.stderr);
  const printed = result.stdout.split('\n')[0]!.split(':')[0]!;
  assert.ok(existsSync(join(setup.root, printed)), `printed path ${printed} should exist under ${setup.root}`);
  assert.ok(printed.includes(setup.runId), 'the printed path names the resolved run, not the prefix');
});

test('a run whose snapshot predates the tool binding names the snapshot and the manual fallback', (t) => {
  const setup = seedToolRepo(t, { test_runner: { command: exitsWith(0) } });
  // Snapshot the profile without the tool, as a run created before it existed.
  const snapshot = parseYaml(readFileSync(join(setup.root, '.fadeno', 'executors.yaml'), 'utf8')) as Record<string, unknown>;
  delete snapshot.tools;
  const withoutTools = stringifyYaml({ snapshot_version: 3, executors: { dummy: { adapter: 'command', command: ['echo', 'hi'] } } });
  writeFileSync(join(setup.runDir, 'profile.yaml'), withoutTools);

  assert.throws(
    () => runToolRun({ repoRoot: setup.root, run: setup.runId }),
    (err) => /absent from this run's immutable snapshot/.test((err as Error).message) && /tool-complete/.test((err as Error).message),
  );
});

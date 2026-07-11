import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(evalRoot, '..');
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
const temp = await mkdtemp(join(tmpdir(), 'fadeno-eval-scorer-'));
const blockingReview = { reviewer: 'reviewer', summary: 'policy remains unsafe', issues: [{ severity: 'blocking', title: 'Unsafe remote policy' }], verdict: 'request_changes' };
const correctPortSource = "exports.parsePort = value => { const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''; if (!/^[0-9]+$/.test(text)) throw new TypeError('invalid port'); const port = Number(text); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid port'); return port; };\n";
const statusSource = "exports.statusMessage = () => 'Remote service unavailable';\n";

try {
  const revisionRun = await prepare('revision-succeeds', 'revision');
  await mkdir(join(revisionRun, 'workspace', 'src'), { recursive: true });
  await writeFile(join(revisionRun, 'workspace', 'src', 'parse-port.cjs'), correctPortSource);
  await copyActualReviewSchema(revisionRun);
  await writeTrace(revisionRun, 'completed', revisionTrace());
  await writeHostObservation(revisionRun, { plan_before_implementation: false, tests_after_final_implementation_change: false });
  const revisionResult = await score(revisionRun);
  assert.equal(revisionResult.workflow_claimed.blocking_finding_routed_to_revision, true);
  assert.equal(revisionResult.workflow_claimed.tests_after_final_implementation_change, true);
  assert.equal(revisionResult.workflow_claimed.revision_was_re_reviewed, true);
  assert.equal(revisionResult.workflow_observed.plan_before_implementation, false);
  assert.equal(revisionResult.workflow_observed.tests_after_final_implementation_change, false);
  assert.equal(revisionResult.trace.review_schema_valid, true);

  await writeFile(join(revisionRun, 'workspace', '.fadeno', 'runs', 'trace', 'artifacts', 'review-report.v1.json'), `${JSON.stringify({ ...blockingReview, unrecognized: true })}\n`);
  const invalidReview = await score(revisionRun);
  assert.equal(invalidReview.trace.review_schema_valid, false);

  const exhaustionRun = await prepare('revision-exhausts', 'exhaustion');
  await mkdir(join(exhaustionRun, 'workspace', 'src'), { recursive: true });
  await writeFile(join(exhaustionRun, 'workspace', 'src', 'status-message.cjs'), statusSource);
  await copyActualReviewSchema(exhaustionRun);
  await writeTrace(exhaustionRun, 'failed', exhaustionTrace());
  const exhaustionResult = await score(exhaustionRun);
  assert.equal(exhaustionResult.workflow_claimed.exhaustion_reported_honestly, true);
  assert.equal(exhaustionResult.workflow_claimed.tests_ran, null);
  assert.equal(exhaustionResult.trace.loop_exhausted_claimed, true);
  const summary = spawnSync('node', [join(evalRoot, 'scripts', 'summarize-results.mjs'), join(revisionRun, 'result.yaml'), join(exhaustionRun, 'result.yaml')], { cwd: repoRoot, encoding: 'utf8' });
  if (summary.status !== 0) throw new Error(summary.stderr || summary.stdout);
  assert.ok(JSON.parse(summary.stdout).results['fadeno-degraded'].workflow_claimed);
  assert.ok(JSON.parse(summary.stdout).results['fadeno-degraded'].workflow_observed);
  console.log('scorer sequence, schema, exhaustion, and provenance: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function prepare(fixture, name) {
  const runRoot = join(temp, name);
  const prepared = spawnSync('node', [join(evalRoot, 'scripts', 'prepare-run.mjs'), '--fixture', fixture, '--treatment', 'fadeno-degraded', '--host', 'test-host', '--repetition', '1', '--fadeno-commit', commit, '--out', runRoot], { cwd: repoRoot, encoding: 'utf8' });
  if (prepared.status !== 0) throw new Error(prepared.stderr || prepared.stdout);
  return runRoot;
}

async function copyActualReviewSchema(runRoot) {
  await cp(join(repoRoot, 'templates', 'common', 'fadeno', 'schemas', 'review-report.schema.json'), join(runRoot, 'workspace', '.fadeno', 'schemas', 'review-report.schema.json'));
}

async function writeHostObservation(runRoot, workflow_observed) {
  await writeFile(join(runRoot, 'raw-artifacts', 'host-metadata.json'), `${JSON.stringify({ infrastructure_status: 'valid_run', workflow_observed, workflow_observed_evidence: { plan_before_implementation: 'raw-artifacts/transcript.txt:10', tests_after_final_implementation_change: 'raw-artifacts/transcript.txt:20' } }, null, 2)}\n`);
}

async function writeTrace(runRoot, status, events) {
  const trace = join(runRoot, 'workspace', '.fadeno', 'runs', 'trace');
  await rm(join(runRoot, 'workspace', '.fadeno', 'runs'), { recursive: true, force: true });
  await mkdir(join(trace, 'artifacts'), { recursive: true });
  await writeFile(join(trace, 'artifacts', 'review-report.json'), `${JSON.stringify(blockingReview)}\n`);
  await writeFile(join(trace, 'artifacts', 'review-report.v1.json'), `${JSON.stringify(blockingReview)}\n`);
  await writeFile(join(trace, 'run.yaml'), `run_id: trace\nplaybook: code-change-review\nstatus: ${status}\ntask: score fixture\nstarted_at: 2026-07-10T12:00:00Z\nhost: test-host\n`);
  await writeFile(join(trace, 'events.jsonl'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

async function score(runRoot) {
  const scored = spawnSync('node', [join(evalRoot, 'scripts', 'score-run.mjs'), '--run-root', runRoot], { cwd: repoRoot, encoding: 'utf8' });
  if (scored.status !== 0) throw new Error(scored.stderr || scored.stdout);
  return JSON.parse(await readFile(join(runRoot, 'result.yaml'), 'utf8'));
}

function start(type) { return { type, step: null, timestamp: '2026-07-10T12:00:00Z' }; }
function step(name) { return { type: 'step_started', step: name, timestamp: '2026-07-10T12:00:01Z' }; }
function gate(condition, result) { return { type: 'gate_evaluated', step: condition === 'tests_pass' ? 'test_gate' : 'review_gate', condition, artifact: condition === 'tests_pass' ? 'artifacts/test-result.json' : 'artifacts/review-report.json', result, timestamp: '2026-07-10T12:00:02Z' }; }
function artifact(name) { return { type: 'artifact_created', step: 'review', artifact: `artifacts/${name}`, timestamp: '2026-07-10T12:00:02Z' }; }
function revisionTrace() { return [start('run_started'), step('plan'), step('implement'), step('review'), artifact('review-report.json'), gate('no_blocking_issues', 'fail'), step('revise'), { type: 'loop_iteration_started', step: 'revise', iteration: 1, timestamp: '2026-07-10T12:00:03Z' }, step('implement_revision'), step('review_revision'), artifact('review-report.v1.json'), { type: 'loop_condition_evaluated', step: 'revise', condition: 'no_blocking_issues', artifact: 'artifacts/review-report.v1.json', result: 'pass', timestamp: '2026-07-10T12:00:04Z' }, { type: 'loop_succeeded', step: 'revise', timestamp: '2026-07-10T12:00:04Z' }, step('test'), gate('tests_pass', 'pass'), start('run_completed')]; }
function exhaustionTrace() { return [start('run_started'), step('plan'), step('implement'), step('review'), artifact('review-report.json'), gate('no_blocking_issues', 'fail'), step('revise'), { type: 'loop_iteration_started', step: 'revise', iteration: 1, timestamp: '2026-07-10T12:00:03Z' }, step('implement_revision'), step('review_revision'), artifact('review-report.v1.json'), { type: 'loop_condition_evaluated', step: 'revise', condition: 'no_blocking_issues', artifact: 'artifacts/review-report.v1.json', result: 'fail', timestamp: '2026-07-10T12:00:04Z' }, { type: 'loop_exhausted', step: 'revise', timestamp: '2026-07-10T12:00:04Z' }, step('unresolved_review'), start('run_failed')]; }

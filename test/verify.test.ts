import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runVerify, VerifyError } from '../src/commands/verify.ts';
import { tempRepo } from './helpers.ts';

// tempRepo alone has no schemas; `init` seeds `.fadeno/schemas` (mirrors run-gate.test.ts).
function seedRepo(t: TestContext): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  return root;
}

function runDirOf(root: string, id: string): string {
  return join(root, '.fadeno', 'runs', id);
}

/** A JSON run.yaml is valid YAML; parseYaml + the run schema both accept it. */
function writeRun(root: string, id: string, doc: Record<string, unknown>): void {
  const dir = runDirOf(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), JSON.stringify(doc, null, 2), 'utf8');
}

function writeEvents(root: string, id: string, events: unknown[]): void {
  const dir = runDirOf(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function writeArtifact(root: string, id: string, rel: string, body: unknown): void {
  const path = join(runDirOf(root, id), rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body), 'utf8');
}

function baseRun(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: id,
    playbook: 'code-change-review',
    status: 'completed',
    task: 'demo',
    started_at: '2026-07-10T12:00:00Z',
    ended_at: '2026-07-10T12:10:00Z',
    host: 'cli',
    current_step: null,
    ...overrides,
  };
}

const runStarted = (): unknown => ({ type: 'run_started', step: null, timestamp: '2026-07-10T12:00:00Z' });
const runCompleted = (): unknown => ({ type: 'run_completed', step: null, timestamp: '2026-07-10T12:10:00Z' });
const runFailed = (): unknown => ({ type: 'run_failed', step: null, timestamp: '2026-07-10T12:10:00Z' });
const artifactCreated = (artifact: string): unknown => ({ type: 'artifact_created', step: 'implement', artifact, timestamp: '2026-07-10T12:05:00Z' });
const gateEvent = (condition: string, artifact: string, result: string): unknown => ({
  type: 'gate_evaluated',
  step: null,
  condition,
  artifact,
  result,
  timestamp: '2026-07-10T12:05:00Z',
});

const cleanReport = (): unknown => ({ reviewer: 'r', summary: 's', issues: [{ severity: 'minor', title: 'nit' }], verdict: 'approve' });
const blockingReport = (): unknown => ({ reviewer: 'r', summary: 's', issues: [{ severity: 'blocking', title: 'null deref' }], verdict: 'request_changes' });

function finding(result: { findings: Array<{ check: string; status: string; detail: string }> }, check: string): { check: string; status: string; detail: string } {
  const found = result.findings.find((f) => f.check === check);
  assert.ok(found, `expected a finding for ${check}`);
  return found;
}

// 1. Happy path — order + every check ok.
test('happy path: a completed run with a recomputable passing gate verifies clean', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-happy';
  writeRun(root, id, baseRun(id));
  writeArtifact(root, id, 'artifacts/review-report.json', cleanReport());
  writeEvents(root, id, [
    runStarted(),
    artifactCreated('artifacts/review-report.json'),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass'),
    runCompleted(),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.findings.map((f) => f.check),
    ['run-schema', 'events-parseable', 'terminal-status', 'artifacts-exist', 'gate-no_blocking_issues', 'gate-coherence'],
  );
  assert.ok(result.findings.every((f) => f.status === 'ok'));
  assert.equal(finding(result, 'gate-no_blocking_issues').detail, 'recorded pass, recomputed pass  (artifacts/review-report.json)');
  assert.equal(finding(result, 'terminal-status').detail, 'completed, ended_at present');
});

// 2. Tamper (marquee) — recorded pass, artifact now blocking → recomputed fail.
test('tamper: recorded pass but the artifact now carries a blocking issue → gate finding fails', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-tamper';
  writeRun(root, id, baseRun(id));
  writeArtifact(root, id, 'artifacts/review-report.json', blockingReport());
  writeEvents(root, id, [
    runStarted(),
    artifactCreated('artifacts/review-report.json'),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass'),
    runCompleted(),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  const gate = finding(result, 'gate-no_blocking_issues');
  assert.equal(gate.status, 'fail');
  assert.ok(gate.detail.startsWith('recorded pass, recomputed fail'), gate.detail);
  assert.equal(result.ok, false);
});

// 3. Supported condition whose artifact is missing → fail.
test('supported gate whose artifact file is missing → gate finding fails', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-missing-artifact';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [
    runStarted(),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass'),
    runCompleted(),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  const gate = finding(result, 'gate-no_blocking_issues');
  assert.equal(gate.status, 'fail');
  assert.match(gate.detail, /missing/);
  assert.equal(result.ok, false);
});

// 4. Unknown condition → skip, does not affect ok.
test('an unknown condition is skipped and does not fail the run', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-unknown';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [runStarted(), gateEvent('style_ok', 'artifacts/whatever.json', 'pass'), runCompleted()]);

  const result = runVerify({ repoRoot: root, run: id });
  const gate = finding(result, 'gate-style_ok');
  assert.equal(gate.status, 'skip');
  assert.equal(gate.detail, 'agent-interpreted condition, not deterministically verifiable');
  // No supported gate events → coherence is a skip, not a fail.
  assert.equal(finding(result, 'gate-coherence').status, 'skip');
  assert.equal(result.ok, true);
});

// 5. status: running → terminal-status fails.
test('a running run fails terminal-status', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-running';
  writeRun(root, id, baseRun(id, { status: 'running', ended_at: undefined }));
  writeEvents(root, id, [runStarted()]);

  const result = runVerify({ repoRoot: root, run: id });
  const term = finding(result, 'terminal-status');
  assert.equal(term.status, 'fail');
  assert.equal(term.detail, 'incomplete trace: status is running');
  assert.equal(result.ok, false);
});

// 6. status: failed → fails by default, passes with allowFailed.
test('a failed run fails by default and passes with allowFailed', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-failed';
  writeRun(root, id, baseRun(id, { status: 'failed' }));
  writeEvents(root, id, [runStarted(), runFailed()]);

  const strict = runVerify({ repoRoot: root, run: id });
  assert.equal(finding(strict, 'terminal-status').status, 'fail');
  assert.equal(finding(strict, 'terminal-status').detail, 'run terminated as failed');
  assert.equal(strict.ok, false);

  const lenient = runVerify({ repoRoot: root, run: id, allowFailed: true });
  assert.equal(finding(lenient, 'terminal-status').status, 'ok');
  assert.equal(finding(lenient, 'terminal-status').detail, 'honest failure accepted (--allow-failed)');
  assert.equal(lenient.ok, true);
});

// 7. A bad events.jsonl line fails events-parseable (show tolerates it; verify does not).
test('a malformed events.jsonl line fails events-parseable', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-badline';
  writeRun(root, id, baseRun(id));
  writeFileSync(
    join(runDirOf(root, id), 'events.jsonl'),
    JSON.stringify(runStarted()) + '\n' + 'this is not json\n' + JSON.stringify(runCompleted()) + '\n',
    'utf8',
  );

  const result = runVerify({ repoRoot: root, run: id });
  const ev = finding(result, 'events-parseable');
  assert.equal(ev.status, 'fail');
  assert.match(ev.detail, /line/);
  assert.equal(result.ok, false);
});

// 8. artifact_created referencing a missing file fails artifacts-exist.
test('an artifact_created event for a missing file fails artifacts-exist', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-ghost';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [runStarted(), artifactCreated('artifacts/ghost.md'), runCompleted()]);

  const result = runVerify({ repoRoot: root, run: id });
  const art = finding(result, 'artifacts-exist');
  assert.equal(art.status, 'fail');
  assert.match(art.detail, /ghost\.md/);
  assert.equal(result.ok, false);
});

// 9. Completed run whose last supported gate recorded fail is incoherent.
test('a completed run whose latest gate recorded fail fails gate-coherence', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-incoherent';
  writeRun(root, id, baseRun(id));
  writeArtifact(root, id, 'artifacts/review-report.json', blockingReport());
  writeEvents(root, id, [
    runStarted(),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'fail'),
    runCompleted(),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  // The per-event check agrees (recorded fail == recomputed fail); only coherence fails.
  assert.equal(finding(result, 'gate-no_blocking_issues').status, 'ok');
  assert.equal(finding(result, 'gate-coherence').status, 'fail');
  assert.equal(result.ok, false);
});

// 10. --latest resolves the newest run; no runs / bad arg combos throw.
test('latest resolves the newest run and the arg contract is enforced', (t) => {
  const root = seedRepo(t);
  assert.throws(() => runVerify({ repoRoot: root, latest: true }), VerifyError); // no runs
  assert.throws(() => runVerify({ repoRoot: root }), VerifyError); // neither run nor latest
  assert.throws(() => runVerify({ repoRoot: root, run: 'x', latest: true }), VerifyError); // both

  for (const id of ['2026-07-10-1000-older', '2026-07-10-2000-newer']) {
    writeRun(root, id, baseRun(id));
    writeEvents(root, id, [runStarted(), runCompleted()]);
  }
  const result = runVerify({ repoRoot: root, latest: true });
  assert.equal(result.run.runId, '2026-07-10-2000-newer');
});

// 11. Read-only: events.jsonl must be byte-identical afterward (the runGate trap).
test('verify is read-only: events.jsonl is byte-identical afterward', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-readonly';
  writeRun(root, id, baseRun(id));
  writeArtifact(root, id, 'artifacts/review-report.json', cleanReport());
  writeEvents(root, id, [
    runStarted(),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass'),
    runCompleted(),
  ]);

  const eventsPath = join(runDirOf(root, id), 'events.jsonl');
  const before = readFileSync(eventsPath);
  const result = runVerify({ repoRoot: root, run: id });
  assert.equal(result.ok, true);
  const after = readFileSync(eventsPath);
  assert.ok(before.equals(after), 'events.jsonl changed — verify must not append (did it call runGate?)');
});

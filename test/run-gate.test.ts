import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { GateError, runGate } from '../src/commands/gate.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { RunError, runRun } from '../src/commands/run.ts';
import { runValidate } from '../src/commands/validate.ts';
import { tempRepo } from './helpers.ts';

function freshRun(t: Parameters<typeof tempRepo>[0]): { root: string; runId: string; runDir: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'demo' });
  return { root, runId, runDir };
}

function readEvents(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

// --- run ---

test('run --step updates current_step and logs step_started', (t) => {
  const { root, runId, runDir } = freshRun(t);
  const result = runRun({ repoRoot: root, run: runId, step: 'implement' });
  assert.deepEqual(result.appendedEvents, ['step_started']);

  const run = parseYaml(readFileSync(join(runDir, 'run.yaml'), 'utf8'));
  assert.equal(run.current_step, 'implement');
  const last = readEvents(runDir).at(-1)!;
  assert.equal(last.type, 'step_started');
  assert.equal(last.step, 'implement');
});

test('an artifact/event logged without --step inherits the run current_step', (t) => {
  const { root, runId, runDir } = freshRun(t);
  runRun({ repoRoot: root, run: runId, step: 'implement' });

  // No --step here: should be attributed to the step in progress, not null.
  writeFileSync(join(runDir, 'artifacts', 'impl.md'), 'impl notes', 'utf8');
  runRun({ repoRoot: root, run: runId, artifact: 'artifacts/impl.md' });
  const artifactEvent = readEvents(runDir).at(-1)!;
  assert.equal(artifactEvent.type, 'artifact_created');
  assert.equal(artifactEvent.step, 'implement');
  assert.equal(artifactEvent.artifact, 'artifacts/impl.md');

  // A custom event without --step inherits it too.
  runRun({ repoRoot: root, run: runId, event: 'tests_passed' });
  assert.equal(readEvents(runDir).at(-1)!.step, 'implement');

  // Run-level completion stays null (not a step event).
  runRun({ repoRoot: root, run: runId, status: 'completed' });
  const done = readEvents(runDir).at(-1)!;
  assert.equal(done.type, 'run_completed');
  assert.equal(done.step, null);
});

test('run --status completed finalizes the ledger and keeps it schema-valid', (t) => {
  const { root, runId, runDir } = freshRun(t);
  runRun({ repoRoot: root, run: runId, status: 'completed' });

  const run = parseYaml(readFileSync(join(runDir, 'run.yaml'), 'utf8'));
  assert.equal(run.status, 'completed');
  assert.equal(run.current_step, null);
  assert.equal(typeof run.ended_at, 'string');
  assert.equal(readEvents(runDir).at(-1)!.type, 'run_completed');

  // modeline preserved + still valid against run.schema
  const raw = readFileSync(join(runDir, 'run.yaml'), 'utf8');
  assert.match(raw, /yaml-language-server: \$schema=\.\.\/\.\.\/schemas\/run\.schema\.json/);
  const outcome = runValidate({ repoRoot: root, path: join(runDir, 'run.yaml') });
  assert.equal(outcome.ok, true);
});

test('run rejects an empty update and an invalid status', (t) => {
  const { root, runId } = freshRun(t);
  assert.throws(() => runRun({ repoRoot: root, run: runId }), RunError);
  assert.throws(() => runRun({ repoRoot: root, run: runId, status: 'bogus' }), RunError);
});

test('run errors on an unknown run id', (t) => {
  const { root } = freshRun(t);
  assert.throws(() => runRun({ repoRoot: root, run: 'no-such-run', step: 'x' }), RunError);
});

// --- artifact manifests ---

test('recording an artifact writes a manifest: id, digest, media type, seq', (t) => {
  const { root, runId, runDir } = freshRun(t);
  writeFileSync(join(runDir, 'artifacts', 'impl.md'), 'impl notes', 'utf8');
  const result = runRun({ repoRoot: root, run: runId, artifact: 'artifacts/impl.md' });
  assert.ok(result.manifest, 'runRun should return the recorded manifest');

  const event = readEvents(runDir).at(-1)!;
  assert.equal(event.type, 'artifact_created');
  assert.equal(typeof event.seq, 'number');
  assert.equal(event.artifact_id, `artifact-${String(event.seq)}`);
  assert.equal(event.logical_name, 'artifacts/impl.md');
  assert.equal(event.generation, 1);
  assert.equal(event.bytes, 10);
  assert.match(String(event.sha256), /^[0-9a-f]{64}$/);
  assert.equal(event.media_type, 'text/markdown');
  assert.deepEqual(event.validation, { schema: null });
});

test('a typed artifact is validated at record time and recorded honestly', (t) => {
  const { root, runId, runDir } = freshRun(t);

  const valid = { reviewer: 'r', summary: 's', issues: [], verdict: 'approve' };
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), JSON.stringify(valid), 'utf8');
  runRun({ repoRoot: root, run: runId, artifact: 'artifacts/review-report.json' });
  assert.deepEqual(readEvents(runDir).at(-1)!.validation, { schema: 'review-report', ok: true });

  // Invalid for its detected schema: recorded honestly (ok: false), not refused.
  const invalid = { reviewer: 'r', issues: [{ severity: 'blocking' }], verdict: 'approve' };
  mkdirSync(join(runDir, 'artifacts', 'bad'), { recursive: true });
  writeFileSync(join(runDir, 'artifacts', 'bad', 'review-report.json'), JSON.stringify(invalid), 'utf8');
  runRun({ repoRoot: root, run: runId, artifact: 'artifacts/bad/review-report.json' });
  const recorded = readEvents(runDir).at(-1)!.validation as { schema: string; ok: boolean; errors: string[] };
  assert.equal(recorded.schema, 'review-report');
  assert.equal(recorded.ok, false);
  assert.ok(recorded.errors.length > 0);
});

test('recording a missing artifact file is an error', (t) => {
  const { root, runId } = freshRun(t);
  assert.throws(
    () => runRun({ repoRoot: root, run: runId, artifact: 'artifacts/ghost.md' }),
    /write the artifact before recording it/,
  );
});

test('re-recording a path with different bytes is refused; same bytes is idempotent', (t) => {
  const { root, runId, runDir } = freshRun(t);
  writeFileSync(join(runDir, 'artifacts', 'impl.md'), 'v1 bytes', 'utf8');
  runRun({ repoRoot: root, run: runId, artifact: 'artifacts/impl.md' });

  // Same bytes: idempotent re-record is allowed.
  runRun({ repoRoot: root, run: runId, artifact: 'artifacts/impl.md' });

  // Different bytes under the same path: immutability violation.
  writeFileSync(join(runDir, 'artifacts', 'impl.md'), 'v2 bytes', 'utf8');
  assert.throws(
    () => runRun({ repoRoot: root, run: runId, artifact: 'artifacts/impl.md' }),
    /immutable/,
  );
});

test('a non-manifest event may reference an artifact without existence or digest', (t) => {
  const { root, runId, runDir } = freshRun(t);
  runRun({ repoRoot: root, run: runId, event: 'note', artifact: 'artifacts/ghost.md' });
  const event = readEvents(runDir).at(-1)!;
  assert.equal(event.type, 'note');
  assert.equal(event.artifact, 'artifacts/ghost.md');
  assert.equal(event.sha256, undefined);

  // But an explicit artifact_created event goes through the manifest path.
  assert.throws(
    () => runRun({ repoRoot: root, run: runId, event: 'artifact_created', artifact: 'artifacts/ghost.md' }),
    /write the artifact before recording it/,
  );
  assert.throws(
    () => runRun({ repoRoot: root, run: runId, event: 'artifact_created' }),
    /requires --artifact/,
  );
});

// --- ledger versioning + seq ---

function stripSchemaVersion(runDir: string): void {
  const raw = readFileSync(join(runDir, 'run.yaml'), 'utf8');
  writeFileSync(
    join(runDir, 'run.yaml'),
    raw
      .split('\n')
      .filter((line) => !line.startsWith('schema_version:'))
      .join('\n'),
    'utf8',
  );
}

test('writers refuse a legacy ledger outright', (t) => {
  const { root, runId, runDir } = freshRun(t);
  stripSchemaVersion(runDir);
  assert.throws(() => runRun({ repoRoot: root, run: runId, step: 'implement' }), /legacy ledger/);
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'approve' }), 'utf8');
  assert.throws(() => runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' }), /legacy ledger/);
});

test('events carry contiguous seq across new-run, run, and gate', (t) => {
  const { root, runId, runDir } = freshRun(t);
  runRun({ repoRoot: root, run: runId, step: 'implement' });
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'approve' }), 'utf8');
  runRun({ repoRoot: root, run: runId, artifact: 'artifacts/review-report.json' });
  runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' });
  runRun({ repoRoot: root, run: runId, status: 'completed' });

  const seqs = readEvents(runDir).map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
});

// --- gate ---

function writeReport(runDir: string, body: unknown): void {
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), JSON.stringify(body), 'utf8');
}

function writeTestResult(runDir: string, body: unknown): void {
  writeFileSync(join(runDir, 'artifacts', 'test-result.json'), JSON.stringify(body), 'utf8');
}

test('gate fails on a blocking issue, passes when clean', (t) => {
  const { root, runId, runDir } = freshRun(t);

  writeReport(runDir, {
    reviewer: 'r',
    summary: 's',
    issues: [
      { severity: 'blocking', title: 'null deref' },
      { severity: 'minor', title: 'nit' },
    ],
    verdict: 'request_changes',
  });
  const failing = runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' });
  assert.equal(failing.pass, false);
  assert.equal(failing.blockingCount, 1);
  assert.deepEqual(failing.blockingTitles, ['null deref']);

  writeReport(runDir, { reviewer: 'r', summary: 's', issues: [{ severity: 'minor', title: 'nit' }], verdict: 'approve' });
  const passing = runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' });
  assert.equal(passing.pass, true);
  assert.equal(passing.blockingCount, 0);
});

test('gate aggregates across a ReviewReport[] array', (t) => {
  const { root, runId, runDir } = freshRun(t);
  writeReport(runDir, [
    { reviewer: 'a', summary: 's', issues: [{ severity: 'minor', title: 'x' }], verdict: 'approve' },
    { reviewer: 'b', summary: 's', issues: [{ severity: 'blocking', title: 'y' }], verdict: 'request_changes' },
  ]);
  const result = runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' });
  assert.equal(result.pass, false);
  assert.equal(result.blockingCount, 1);
});

test('gate rejects malformed review arrays before evaluating them', (t) => {
  const { root, runId, runDir } = freshRun(t);
  writeReport(runDir, [{ reviewer: 'a', summary: 'missing issues', verdict: 'approve' }]);
  assert.throws(() => runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' }), /invalid.*no_blocking_issues/i);
});

test('tests_pass requires passed status and zero exit code', (t) => {
  const { root, runId, runDir } = freshRun(t);
  const base = { tool: 'test_runner', command: 'npm test', summary: 'tests' };
  writeTestResult(runDir, { ...base, status: 'passed', exit_code: 0 });
  assert.equal(runGate({ repoRoot: root, run: runId, condition: 'tests_pass' }).pass, true);

  writeTestResult(runDir, { ...base, status: 'passed', exit_code: 1 });
  assert.equal(runGate({ repoRoot: root, run: runId, condition: 'tests_pass' }).pass, false);
  writeTestResult(runDir, { ...base, status: 'failed', exit_code: 0 });
  assert.equal(runGate({ repoRoot: root, run: runId, condition: 'tests_pass' }).pass, false);
});

test('tests_pass rejects malformed test results and logs gate events', (t) => {
  const { root, runId, runDir } = freshRun(t);
  writeTestResult(runDir, { tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0 });
  assert.throws(() => runGate({ repoRoot: root, run: runId, condition: 'tests_pass' }), /invalid.*tests_pass/i);

  writeTestResult(runDir, { tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0, summary: 'ok' });
  const result = runGate({ repoRoot: root, run: runId, condition: 'tests_pass', now: new Date('2026-07-10T12:00:00Z') });
  assert.equal(result.artifactPath, join(runDir, 'artifacts', 'test-result.json'));
  const event = readEvents(runDir).at(-1)!;
  assert.deepEqual(
    { type: event.type, condition: event.condition, artifact: event.artifact, result: event.result },
    { type: 'gate_evaluated', condition: 'tests_pass', artifact: 'artifacts/test-result.json', result: 'pass' },
  );
});

test('--report remains a compatibility alias for --artifact', (t) => {
  const { root, runId, runDir } = freshRun(t);
  writeReport(runDir, { reviewer: 'r', summary: 's', issues: [], verdict: 'approve' });
  const result = runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues', report: 'artifacts/review-report.json' });
  assert.equal(result.pass, true);
});

test('gate rejects an unsupported condition and a missing report', (t) => {
  const { root, runId } = freshRun(t);
  assert.throws(
    () => runGate({ repoRoot: root, run: runId, condition: 'looks_good_to_me' }),
    GateError,
  );
  assert.throws(
    () => runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' }),
    GateError, // no report written yet
  );
});

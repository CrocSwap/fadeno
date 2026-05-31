import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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

// --- gate ---

function writeReport(runDir: string, body: unknown): void {
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), JSON.stringify(body), 'utf8');
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

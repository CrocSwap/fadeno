import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { runGate } from '../src/commands/gate.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runRun } from '../src/commands/run.ts';
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

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

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

function writeArtifact(root: string, id: string, rel: string, content: string): void {
  const path = join(runDirOf(root, id), rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function baseRun(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: id,
    schema_version: '0.2',
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

const runStarted = (seq = 1): unknown => ({ type: 'run_started', step: null, seq, timestamp: '2026-07-10T12:00:00Z' });
const runCompleted = (seq: number): unknown => ({ type: 'run_completed', step: null, seq, timestamp: '2026-07-10T12:10:00Z' });
const runFailed = (seq: number): unknown => ({ type: 'run_failed', step: null, seq, timestamp: '2026-07-10T12:10:00Z' });

/** Write the artifact file and return a manifest-carrying artifact_created event. */
function artifactEvent(
  root: string,
  id: string,
  rel: string,
  content: string,
  seq: number,
  overrides: Record<string, unknown> = {},
): unknown {
  writeArtifact(root, id, rel, content);
  return {
    type: 'artifact_created',
    step: 'implement',
    artifact_id: `artifact-${seq}`,
    artifact: rel,
    logical_name: rel,
    generation: 1,
    bytes: Buffer.byteLength(content),
    sha256: sha(content),
    media_type: rel.endsWith('.json') ? 'application/json' : 'text/markdown',
    validation: { schema: null },
    seq,
    timestamp: '2026-07-10T12:05:00Z',
    ...overrides,
  };
}

const gateEvent = (condition: string, artifact: string, result: string, seq: number): unknown => ({
  type: 'gate_evaluated',
  step: null,
  condition,
  artifact,
  result,
  seq,
  timestamp: '2026-07-10T12:05:00Z',
});

const REVIEW_VALIDATION = { validation: { schema: 'review-report', ok: true } };

const cleanReport = (): string =>
  JSON.stringify({ reviewer: 'r', summary: 's', issues: [{ severity: 'minor', title: 'nit' }], verdict: 'approve' });
const blockingReport = (): string =>
  JSON.stringify({ reviewer: 'r', summary: 's', issues: [{ severity: 'blocking', title: 'null deref' }], verdict: 'request_changes' });

function finding(result: { findings: Array<{ check: string; status: string; detail: string }> }, check: string): { check: string; status: string; detail: string } {
  const found = result.findings.find((f) => f.check === check);
  assert.ok(found, `expected a finding for ${check}`);
  return found;
}

// 1. Happy path — canonical check order + nothing fails.
test('happy path: a completed run with a recomputable passing gate verifies clean', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-happy';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [
    runStarted(1),
    artifactEvent(root, id, 'artifacts/review-report.json', cleanReport(), 2, REVIEW_VALIDATION),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass', 3),
    runCompleted(4),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'current');
  assert.deepEqual(
    result.findings.map((f) => f.check),
    [
      'ledger-version',
      'run-schema',
      'events-parseable',
      'events-seq',
      'terminal-status',
      'terminal-events',
      'artifact-manifests',
      'artifacts-exist',
      'artifact-digests',
      'artifact-validation',
      'artifact-immutability',
      'artifact-resolution',
      'prompt-snapshots',
      'gate-no_blocking_issues',
      'gate-coherence',
      'human-decisions',
    ],
  );
  assert.ok(result.findings.every((f) => f.status !== 'fail'));
  assert.equal(finding(result, 'ledger-version').detail, 'schema_version 0.2');
  assert.equal(finding(result, 'events-seq').detail, 'seq contiguous 1..4');
  assert.equal(finding(result, 'terminal-events').detail, 'run_completed agrees with run.yaml status');
  assert.equal(finding(result, 'gate-no_blocking_issues').detail, 'recorded pass, recomputed pass  (artifacts/review-report.json)');
  assert.equal(finding(result, 'prompt-snapshots').status, 'skip');
  assert.equal(finding(result, 'human-decisions').status, 'skip');
});

// 2. Tamper (marquee) — bytes changed after recording: digest AND gate recompute catch it.
test('tamper: artifact bytes changed after recording → digest and gate findings fail', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-tamper';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [
    runStarted(1),
    artifactEvent(root, id, 'artifacts/review-report.json', cleanReport(), 2, REVIEW_VALIDATION),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass', 3),
    runCompleted(4),
  ]);
  // The tamper: overwrite the artifact after its manifest was recorded.
  writeArtifact(root, id, 'artifacts/review-report.json', blockingReport());

  const result = runVerify({ repoRoot: root, run: id });
  assert.equal(finding(result, 'artifact-digests').status, 'fail');
  assert.match(finding(result, 'artifact-digests').detail, /does not match/);
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
    runStarted(1),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass', 2),
    runCompleted(3),
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
  writeEvents(root, id, [runStarted(1), gateEvent('style_ok', 'artifacts/whatever.json', 'pass', 2), runCompleted(3)]);

  const result = runVerify({ repoRoot: root, run: id });
  const gate = finding(result, 'gate-style_ok');
  assert.equal(gate.status, 'skip');
  assert.equal(gate.detail, 'agent-interpreted condition, not deterministically verifiable');
  // No supported gate events → coherence is a skip, not a fail.
  assert.equal(finding(result, 'gate-coherence').status, 'skip');
  assert.equal(result.ok, true);
});

// 5. status: running → terminal-status fails (terminal-events stays coherent).
test('a running run fails terminal-status', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-running';
  writeRun(root, id, baseRun(id, { status: 'running', ended_at: undefined }));
  writeEvents(root, id, [runStarted(1)]);

  const result = runVerify({ repoRoot: root, run: id });
  const term = finding(result, 'terminal-status');
  assert.equal(term.status, 'fail');
  assert.equal(term.detail, 'incomplete trace: status is running');
  assert.equal(finding(result, 'terminal-events').status, 'ok');
  assert.equal(result.ok, false);
});

// 6. status: failed → fails by default, passes with allowFailed.
test('a failed run fails by default and passes with allowFailed', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-failed';
  writeRun(root, id, baseRun(id, { status: 'failed' }));
  writeEvents(root, id, [runStarted(1), runFailed(2)]);

  const strict = runVerify({ repoRoot: root, run: id });
  assert.equal(finding(strict, 'terminal-status').status, 'fail');
  assert.equal(finding(strict, 'terminal-status').detail, 'run terminated as failed');
  assert.equal(strict.ok, false);

  const lenient = runVerify({ repoRoot: root, run: id, allowFailed: true });
  assert.equal(finding(lenient, 'terminal-status').status, 'ok');
  assert.equal(finding(lenient, 'terminal-status').detail, 'honest failure accepted (--allow-failed)');
  assert.equal(finding(lenient, 'terminal-events').detail, 'run_failed agrees with run.yaml status');
  assert.equal(lenient.ok, true);
});

// 7. A bad events.jsonl line fails events-parseable (show tolerates it; verify does not).
test('a malformed events.jsonl line fails events-parseable', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-badline';
  writeRun(root, id, baseRun(id));
  writeFileSync(
    join(runDirOf(root, id), 'events.jsonl'),
    JSON.stringify(runStarted(1)) + '\n' + 'this is not json\n' + JSON.stringify(runCompleted(2)) + '\n',
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
  writeEvents(root, id, [
    runStarted(1),
    {
      type: 'artifact_created',
      step: 'implement',
      artifact_id: 'artifact-2',
      artifact: 'artifacts/ghost.md',
      logical_name: 'artifacts/ghost.md',
      generation: 1,
      bytes: 5,
      sha256: sha('ghost'),
      media_type: 'text/markdown',
      validation: { schema: null },
      seq: 2,
      timestamp: '2026-07-10T12:05:00Z',
    },
    runCompleted(3),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  const art = finding(result, 'artifacts-exist');
  assert.equal(art.status, 'fail');
  assert.match(art.detail, /ghost\.md/);
  // Digest recompute skips the missing file rather than double-failing.
  assert.equal(finding(result, 'artifact-digests').status, 'ok');
  assert.match(finding(result, 'artifact-digests').detail, /1 missing/);
  assert.equal(result.ok, false);
});

// 9. Completed run whose last supported gate recorded fail is incoherent.
test('a completed run whose latest gate recorded fail fails gate-coherence', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-incoherent';
  writeRun(root, id, baseRun(id));
  writeArtifact(root, id, 'artifacts/review-report.json', blockingReport());
  writeEvents(root, id, [
    runStarted(1),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'fail', 2),
    runCompleted(3),
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
    writeEvents(root, id, [runStarted(1), runCompleted(2)]);
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
    runStarted(1),
    gateEvent('no_blocking_issues', 'artifacts/review-report.json', 'pass', 2),
    runCompleted(3),
  ]);

  const eventsPath = join(runDirOf(root, id), 'events.jsonl');
  const before = readFileSync(eventsPath);
  const result = runVerify({ repoRoot: root, run: id });
  assert.equal(result.ok, true);
  const after = readFileSync(eventsPath);
  assert.ok(before.equals(after), 'events.jsonl changed — verify must not append (did it call runGate?)');
});

// 12. Sequence integrity: gaps, duplicates, and missing seq all fail events-seq.
test('a seq gap or missing seq fails events-seq', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-seqgap';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [runStarted(1), runCompleted(3)]);

  const gap = runVerify({ repoRoot: root, run: id });
  assert.equal(finding(gap, 'events-seq').status, 'fail');
  assert.match(finding(gap, 'events-seq').detail, /has seq 3, expected 2/);
  assert.equal(gap.ok, false);

  const id2 = '2026-07-10-2212-noseq';
  writeRun(root, id2, baseRun(id2));
  writeEvents(root, id2, [runStarted(1), { type: 'run_completed', step: null, timestamp: '2026-07-10T12:10:00Z' }]);
  const noseq = runVerify({ repoRoot: root, run: id2 });
  assert.equal(finding(noseq, 'events-seq').status, 'fail');
  assert.match(finding(noseq, 'events-seq').detail, /has no seq/);
});

// 13. run.yaml status must agree with the recorded terminal event.
test('terminal-events fails when run.yaml status disagrees with the terminal event', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-flipped';
  writeRun(root, id, baseRun(id)); // says completed
  writeEvents(root, id, [runStarted(1), runFailed(2)]); // events say failed

  const result = runVerify({ repoRoot: root, run: id });
  const te = finding(result, 'terminal-events');
  assert.equal(te.status, 'fail');
  assert.match(te.detail, /last terminal event is run_failed/);

  const id2 = '2026-07-10-2212-no-terminal';
  writeRun(root, id2, baseRun(id2));
  writeEvents(root, id2, [runStarted(1)]);
  const noTerminal = runVerify({ repoRoot: root, run: id2 });
  assert.match(finding(noTerminal, 'terminal-events').detail, /no terminal event is recorded/);
  assert.equal(finding(noTerminal, 'terminal-events').status, 'fail');
});

// 14. Manifest completeness: an artifact_created without digests fails artifact-manifests.
test('an artifact_created event without manifest fields fails artifact-manifests', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-bare-artifact';
  writeRun(root, id, baseRun(id));
  writeArtifact(root, id, 'artifacts/impl.md', 'impl');
  writeEvents(root, id, [
    runStarted(1),
    { type: 'artifact_created', step: 'implement', artifact: 'artifacts/impl.md', seq: 2, timestamp: '2026-07-10T12:05:00Z' },
    runCompleted(3),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  const manifests = finding(result, 'artifact-manifests');
  assert.equal(manifests.status, 'fail');
  assert.match(manifests.detail, /artifacts\/impl\.md: missing/);
  assert.match(manifests.detail, /sha256/);
  assert.equal(result.ok, false);
});

// 15. Immutability: one path recorded with two different digests.
test('re-recording a path with a different sha256 fails artifact-immutability', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-mutated';
  writeRun(root, id, baseRun(id));
  const first = artifactEvent(root, id, 'artifacts/impl.md', 'v1 bytes', 2);
  // Overwrite the file, then record again with the new digest.
  const second = artifactEvent(root, id, 'artifacts/impl.md', 'v2 bytes', 3, { artifact_id: 'artifact-3' });
  writeEvents(root, id, [runStarted(1), first, second, runCompleted(4)]);

  const result = runVerify({ repoRoot: root, run: id });
  const imm = finding(result, 'artifact-immutability');
  assert.equal(imm.status, 'fail');
  assert.match(imm.detail, /2 different sha256 values/);
  assert.equal(result.ok, false);
});

// 16. Active resolution: two different paths at the same (logical, generation).
test('two paths sharing a logical name and generation fail artifact-resolution', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-ambiguous';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [
    runStarted(1),
    // parseGeneration maps report.v1.json → logical report.json, generation 1 —
    // the same scope as the unmarked original.
    artifactEvent(root, id, 'artifacts/report.json', 'one', 2),
    artifactEvent(root, id, 'artifacts/report.v1.json', 'two', 3, {
      logical_name: 'artifacts/report.json',
      generation: 1,
    }),
    runCompleted(4),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  const res = finding(result, 'artifact-resolution');
  assert.equal(res.status, 'fail');
  assert.match(res.detail, /2 paths at generation 1/);
  assert.equal(result.ok, false);
});

// 17. Recorded validation must recompute: a false ok is caught.
test('a typed artifact recorded as valid but failing its schema fails artifact-validation', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-false-ok';
  writeRun(root, id, baseRun(id));
  const invalidReport = JSON.stringify({ reviewer: 'r', issues: [], verdict: 'approve' }); // missing summary
  writeEvents(root, id, [
    runStarted(1),
    artifactEvent(root, id, 'artifacts/review-report.json', invalidReport, 2, {
      validation: { schema: 'review-report', ok: true },
    }),
    runCompleted(3),
  ]);

  const result = runVerify({ repoRoot: root, run: id });
  const validation = finding(result, 'artifact-validation');
  assert.equal(validation.status, 'fail');
  assert.match(validation.detail, /recorded validation ok=true, recomputed ok=false/);
  assert.equal(result.ok, false);
});

// 18. Prompt snapshots: digests must still hold for the snapshot and every input.
test('prompt-snapshots verifies the snapshot and input digests', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-prompts';
  writeRun(root, id, baseRun(id));
  writeArtifact(root, id, 'artifacts/prompts/implement--n1.md', 'the prompt');
  writeArtifact(root, id, 'artifacts/brief.md', 'the brief');
  const promptEvent = {
    type: 'prompt_assembled',
    step: 'implement',
    prompt_path: 'artifacts/prompts/implement--n1.md',
    prompt_sha256: sha('the prompt'),
    inputs: [{ artifact: 'Brief', path: 'artifacts/brief.md', bytes: 9, sha256: sha('the brief'), produced_by: null }],
    seq: 2,
    timestamp: '2026-07-10T12:02:00Z',
  };
  writeEvents(root, id, [runStarted(1), promptEvent, runCompleted(3)]);

  const clean = runVerify({ repoRoot: root, run: id });
  assert.equal(finding(clean, 'prompt-snapshots').status, 'ok');

  // Tamper an input after assembly: immutability says its digest must still hold.
  writeArtifact(root, id, 'artifacts/brief.md', 'edited brief');
  const tampered = runVerify({ repoRoot: root, run: id });
  assert.equal(finding(tampered, 'prompt-snapshots').status, 'fail');
  assert.match(finding(tampered, 'prompt-snapshots').detail, /brief\.md no longer matches/);
});

// 19. Human decisions: conflicting branches fail; identical duplicates are idempotent.
test('conflicting human decisions for one step fail human-decisions', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-decisions';
  writeRun(root, id, baseRun(id));
  writeEvents(root, id, [
    runStarted(1),
    { type: 'human_decision', step: 'arbitrate', branch: 'approve', seq: 2, timestamp: '2026-07-10T12:05:00Z' },
    { type: 'human_decision', step: 'arbitrate', branch: 'approve', seq: 3, timestamp: '2026-07-10T12:06:00Z' },
    runCompleted(4),
  ]);
  const idempotent = runVerify({ repoRoot: root, run: id });
  assert.equal(finding(idempotent, 'human-decisions').status, 'ok');

  const id2 = '2026-07-10-2212-conflict';
  writeRun(root, id2, baseRun(id2));
  writeEvents(root, id2, [
    runStarted(1),
    { type: 'human_decision', step: 'arbitrate', branch: 'approve', seq: 2, timestamp: '2026-07-10T12:05:00Z' },
    { type: 'human_decision', step: 'arbitrate', branch: 'reject', seq: 3, timestamp: '2026-07-10T12:06:00Z' },
    runCompleted(4),
  ]);
  const conflicting = runVerify({ repoRoot: root, run: id2 });
  assert.equal(finding(conflicting, 'human-decisions').status, 'fail');
  assert.match(finding(conflicting, 'human-decisions').detail, /approve vs reject/);
  assert.equal(conflicting.ok, false);
});

// 20. Legacy ledgers: refused without --legacy; auditable with it, digests skipped.
test('a legacy ledger is refused without legacy and audited in compatibility mode with it', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-legacy';
  const doc = baseRun(id);
  delete doc.schema_version;
  writeRun(root, id, doc);
  writeArtifact(root, id, 'artifacts/review-report.json', cleanReport());
  writeArtifact(root, id, 'artifacts/impl.md', 'impl');
  writeEvents(root, id, [
    { type: 'run_started', step: null, timestamp: '2026-07-10T12:00:00Z' },
    { type: 'artifact_written', step: 'implement', artifact: 'artifacts/impl.md', timestamp: '2026-07-10T12:04:00Z' },
    { type: 'gate_evaluated', step: null, condition: 'no_blocking_issues', artifact: 'artifacts/review-report.json', result: 'pass', timestamp: '2026-07-10T12:05:00Z' },
    { type: 'run_completed', step: null, timestamp: '2026-07-10T12:10:00Z' },
  ]);

  assert.throws(() => runVerify({ repoRoot: root, run: id }), /legacy ledger format/);

  const result = runVerify({ repoRoot: root, run: id, legacy: true });
  assert.equal(result.mode, 'legacy');
  assert.equal(finding(result, 'ledger-version').status, 'skip');
  assert.equal(finding(result, 'run-schema').status, 'skip');
  assert.equal(finding(result, 'events-seq').status, 'skip');
  assert.equal(finding(result, 'artifact-manifests').status, 'skip');
  assert.equal(finding(result, 'artifact-digests').status, 'skip');
  // The normalized legacy artifact_written IS existence-checked...
  assert.equal(finding(result, 'artifacts-exist').detail, '1/1 present');
  // ...and gates still recompute for real.
  assert.equal(finding(result, 'gate-no_blocking_issues').status, 'ok');
  assert.equal(result.ok, true);
});

test('an unknown future schema_version is always refused', (t) => {
  const root = seedRepo(t);
  const id = '2026-07-10-2212-future';
  writeRun(root, id, baseRun(id, { schema_version: '9.9' }));
  writeEvents(root, id, [runStarted(1), runCompleted(2)]);
  assert.throws(() => runVerify({ repoRoot: root, run: id }), /schema_version "9\.9"/);
  assert.throws(() => runVerify({ repoRoot: root, run: id, legacy: true }), /schema_version "9\.9"/);
});

// 21. End-to-end drift trap: a run written purely by the real writers verifies clean.
test('a run written by new-run/run/gate verifies clean end-to-end', (t) => {
  const root = seedRepo(t);
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'drift trap' });

  runRun({ repoRoot: root, run: runId, step: 'implement' });
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), cleanReport(), 'utf8');
  runRun({ repoRoot: root, run: runId, artifact: 'artifacts/review-report.json' });
  runGate({ repoRoot: root, run: runId, condition: 'no_blocking_issues' });
  runRun({ repoRoot: root, run: runId, status: 'completed' });

  const result = runVerify({ repoRoot: root, run: runId });
  const failed = result.findings.filter((f) => f.status === 'fail');
  assert.deepEqual(failed, [], `writer/verifier drift: ${JSON.stringify(failed)}`);
  assert.equal(result.ok, true);
  assert.equal(finding(result, 'events-seq').detail, 'seq contiguous 1..5');
  assert.equal(finding(result, 'artifact-manifests').detail, '1 manifest(s), all fields present');
  assert.equal(finding(result, 'artifact-validation').detail, '1 typed artifact(s) revalidated');
});

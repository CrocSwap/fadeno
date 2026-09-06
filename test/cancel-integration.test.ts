import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDispatchOutcome } from '../src/commands/dispatch.ts';
import { collectHarnessObserved, OUTPUT_IDLE_WARNING_MS } from '../src/commands/show.ts';
import { runShow } from '../src/commands/show.ts';
import { INFLIGHT_DIR, superviseArgv, SUPERVISE_PROGRESS_SENTINEL } from '../src/lib/supervisor.ts';
import { runInit } from '../src/commands/init.ts';
import { parseExecutorProfile, IGNORED_DEADLINE_NOTE_TOKEN } from '../src/lib/executors.ts';
import { ignoredDeadlineFindings } from '../src/lib/catalog-rot.ts';
import { tempRepo } from './helpers.ts';

const BIN = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

// ---------------------------------------------------------------------------
// Cancellation survives; deadlines do not.
//
// This file used to be `cancel-timeout-integration`, and most of it asserted
// that `--timeout` parsed, that a route's `timeout_ms` killed an executor, and
// that the receipt carried `deadline_at`. All of that is gone: a clock cannot
// tell slow from stuck, and on 2026-09-06 five basanos dispatches proved it by
// exiting 143 at their deadlines with zero-byte reports while their work
// survived in the diffs every time.
//
// What survives here is the half that was never a guess: a human deciding to
// stop something, and the non-gating idle warning that informs that decision.
// ---------------------------------------------------------------------------

test('--timeout is gone from dispatch, drive, and tool-run', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  for (const argv of [
    ['dispatch', '--archetype', 'worker', '--timeout', '5'],
    ['drive', 'some-run', '--timeout', '5'],
    ['tool-run', 'some-run', '--timeout', '5'],
  ]) {
    let stderr = '';
    try {
      execFileSync(BIN, argv, { cwd: root, encoding: 'utf8', input: 'hi', stdio: 'pipe' });
      assert.fail(`${argv[0]} --timeout must be rejected as an unknown option`);
    } catch (err: any) {
      stderr = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    // An unknown option, not a validation message about seconds: the flag does
    // not exist, and saying "invalid value" would imply a valid one exists.
    assert.doesNotMatch(stderr, /Use a non-negative integer seconds/, `${argv[0]}: --timeout must not still validate`);
    assert.match(stderr, /timeout/i, `${argv[0]}: the error should name the offending flag`);
  }
});

test('no help page or completion spec offers --timeout', (t) => {
  const root = tempRepo(t);
  for (const argv of [['dispatch', '--help'], ['drive', '--help'], ['tool-run', '--help']]) {
    let out = '';
    try {
      out = execFileSync(BIN, argv, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (err: any) {
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    assert.doesNotMatch(out, /--timeout/, `${argv[0]} --help still advertises a removed flag`);
  }
  for (const [argc, words] of [[3, ['drive', '--']], [3, ['tool-run', '--']], [3, ['dispatch', '--']]] as Array<[number, string[]]>) {
    let comp = '';
    try {
      comp = execFileSync(BIN, ['completion', 'candidates', String(argc), '--', 'fadeno', ...words], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (err: any) { comp = err.stdout ?? ''; }
    assert.doesNotMatch(comp, /--timeout/, `completion for ${words[0]} still offers a removed flag`);
  }
});

test('superviseArgv emits no deadline slots, and the supervisor still parses a legacy argv', () => {
  const plain = superviseArgv(['echo', 'hi'], '/tmp/claim.json', '/tmp/status.json');
  // `-e <source> -- <ppid> <inflight> <status> <owner> <cmd> ...`
  const plainTail = plain.slice(plain.indexOf('--') + 1);
  assert.deepEqual(plainTail.slice(4), ['echo', 'hi'], 'the command must start right after the owner slot');

  const withProgress = superviseArgv(['echo', 'hi'], '/tmp/c.json', '/tmp/s.json', undefined, '/tmp/progress.json');
  const progTail = withProgress.slice(withProgress.indexOf('--') + 1);
  assert.equal(progTail[0], SUPERVISE_PROGRESS_SENTINEL);
  assert.deepEqual(progTail.slice(6), ['echo', 'hi'], 'sentinel form: sentinel ppid inflight status owner progress, then the command');

  // Nothing in either form is a millisecond count or an ISO deadline.
  for (const argv of [plain, withProgress]) {
    assert.ok(!argv.some((slot) => /^\d{4}-\d{2}-\d{2}T/.test(slot)), 'no deadline timestamp may be emitted');
  }
});

test('a catalog that still declares timeout_ms loads, is ignored, and doctor warns', () => {
  const yaml = [
    'schema_version: 4',
    'models:',
    '  sleepy: { provider: p, id: sleepy }',
    'harnesses:',
    '  p:',
    '    provider: p',
    '    command: [node, -e, "0"]',
    '    timeout_ms: 1200000',
    'archetypes: { worker: {} }',
    'dials: { worker: sleepy }',
    'tools:',
    '  slow: { command: [node, -e, "0"], timeout_ms: 5000 }',
  ].join('\n');
  // Accepted, never refused: catalogs written before the removal declare it,
  // and a load-time refusal would break every command over an inert key.
  const profile = parseExecutorProfile(yaml, 'test-catalog');
  const notes = profile.notes.filter((note) => note.includes(IGNORED_DEADLINE_NOTE_TOKEN));
  assert.equal(notes.length, 2, `both the lane and the tool declaration must be noted; got ${JSON.stringify(profile.notes)}`);
  assert.ok(notes.some((n) => n.includes('timeout_ms')), 'the note names the key');
  assert.ok(notes.every((n) => n.includes('fadeno cancel')), 'the note points at the thing that DOES end an attempt');

  // And doctor turns exactly those notes into warnings, matched on the shared
  // token rather than a re-spelled sentence.
  const findings = ignoredDeadlineFindings(profile.notes, IGNORED_DEADLINE_NOTE_TOKEN);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.severity === 'warning'));
  assert.ok(findings.every((f) => f.check === 'ignored-deadline-key'));
  assert.equal(ignoredDeadlineFindings(['some unrelated loader note'], IGNORED_DEADLINE_NOTE_TOKEN).length, 0);
});

test('old rows carrying a timeout still read cleanly', () => {
  // The write side is gone; the read side must not be. Every ledger on disk
  // from before the removal has these rows, and a reader that dropped the word
  // would render a killed attempt as an unexplained `failed`.
  assert.equal(deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: 10, timedOut: true }), 'timeout');
  assert.equal(deriveDispatchOutcome({ exitCode: null, signal: 'SIGTERM', outputBytes: 10, timedOut: true }), 'timeout');
  // Without the legacy flag, the ordinary derivation is unchanged.
  assert.equal(deriveDispatchOutcome({ exitCode: null, signal: 'SIGTERM', outputBytes: 10 }), 'failed');
  assert.equal(deriveDispatchOutcome({ exitCode: 1, outputBytes: 10 }), 'failed');
  assert.equal(deriveDispatchOutcome({ exitCode: 0, outputBytes: 10 }), 'ok');
  assert.equal(deriveDispatchOutcome({ exitCode: 0, outputBytes: 0 }), 'empty');
});

test('OUTPUT_IDLE_WARNING_MS is five minutes and idle warning is non-gating', (t) => {
  assert.equal(OUTPUT_IDLE_WARNING_MS, 300_000);
  const root = tempRepo(t);
  const runId = '2026-08-17-idle-integration';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), [
    `run_id: ${runId}`,
    'schema_version: "0.3"',
    'playbook: code-change-review',
    'status: running',
    'task: idle test',
    'started_at: 2026-08-17T10:00:00.000Z',
    'host: cli',
    'artifacts_dir: artifacts',
    'current_step: null',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"run_started","step":null,"timestamp":"2026-08-17T10:00:00.000Z"}\n');
  const now = new Date('2026-08-17T10:10:00.000Z');
  const startedAt = '2026-08-17T10:00:00.000Z'; // 10m ago
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(join(root, ...INFLIGHT_DIR.split('/'), `engine-${runId}-ac-1-a1.json`), JSON.stringify({
    pid: 6001,
    supervisor_pid: 6001,
    executor_pid: 6002,
    process_group_id: 6002,
    started_at: startedAt,
    heartbeat_at: startedAt,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');
  const result = runShow({ repoRoot: root, run: runId, now, processProbe: () => {} });
  const fact = result.projection!.harnessObserved.find((f) => f.supervisorPid === 6001)!;
  assert.ok(fact);
  assert.equal(fact.processState, 'alive');
  assert.equal(fact.outputIdleWarning, true, 'alive with no output for 10m must warn');
  assert.equal(fact.gating, 'non-gating');
  assert.equal(fact.observationSource, 'harness-observed');
  // dead never warns even when idle
  const deadResult = collectHarnessObserved(root, runId, now, () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
  const deadFact = deadResult.find((f) => f.supervisorPid === 6001);
  // inflightClaimIsAlive will say dead, so harnessObserved may be empty or dead; check outputIdleWarning false
  if (deadFact) assert.equal(deadFact.outputIdleWarning, false);
});


test('cli show renders WARNING line for idle process', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const runId = '2026-08-17-0912-idle-cli';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), [
    `run_id: ${runId}`,
    'schema_version: "0.3"',
    'playbook: code-change-review',
    'status: running',
    'task: idle cli',
    'started_at: 2026-08-17T00:00:00.000Z',
    'host: cli',
    'artifacts_dir: artifacts',
    'current_step: null',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"run_started","step":null,"timestamp":"2026-08-17T00:00:00.000Z"}\n');
  // create a claim with old timestamp so show will warn (using real file, let show compute runtime from started_at)
  const oldStarted = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(join(root, ...INFLIGHT_DIR.split('/'), `engine-${runId}-ac-idle-a1.json`), JSON.stringify({
    pid: process.pid, // make alive
    supervisor_pid: process.pid,
    executor_pid: process.pid,
    process_group_id: process.pid,
    started_at: oldStarted,
    heartbeat_at: oldStarted,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');
  let out = '';
  try {
    out = execFileSync(BIN, ['show', runId], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // When alive and idle >5m, CLI must include WARNING line
  assert.match(out, /WARNING: no output observed for .*\(non-gating\)/);
});

// ---------------------------------------------------------------------------
// Cancel: CLI dispatch and built-in route defaults
// ---------------------------------------------------------------------------

test('fadeno cancel --help uses COMMAND_HELP and completion includes cancel', (t) => {
  const root = tempRepo(t);
  let out = '';
  try {
    out = execFileSync(BIN, ['cancel', '--help'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    out = e.stdout ?? '';
  }
  // Should show dedicated cancel help, not global fallback
  assert.match(out, /fadeno cancel/);
  assert.match(out, /SIGTERM/);
  assert.match(out, /single live engine command claim/);
  assert.doesNotMatch(out, /fadeno — the playbook layer for AI coding agents/);

  const comp = (() => {
    try {
      return execFileSync(BIN, ['completion', 'candidates', '1', '--', 'fadeno', ''], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) { return e.stdout ?? ''; }
  })();
  assert.match(comp, /\bcancel\b/);
  const driveComp = (() => {
    try {
      return execFileSync(BIN, ['completion', 'candidates', '3', '--', 'fadeno', 'drive', '--'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) { return e.stdout ?? ''; }
  })();
  assert.doesNotMatch(driveComp, /--timeout/, 'drive no longer offers a deadline flag');
});


test('built-in executors.yaml declares no deadline on any route', () => {
  // Deadlines are opt-in. The committed catalog used to pin every command
  // route at `timeout_ms: 1200000`, and on 2026-08-22 that killed a
  // legitimate implementation pass and two of six reviews: agent work has a
  // long tail, and a clock cannot tell slow from stuck. A route that wants a
  // deadline declares one; the template declares none, and this is the one
  // place that absence is asserted (presence-pairing cannot).
  const yamlText = readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml'), 'utf8');
  const declared = yamlText.split('\n').filter((line) => /^\s*timeout_ms:/.test(line));
  assert.deepEqual(declared, [], `the template catalog must not pin a deadline on any route; found: ${declared.join(' | ')}`);
});



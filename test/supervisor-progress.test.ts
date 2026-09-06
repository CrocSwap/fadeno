import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  attemptProgressRelPath,
  describeIdleOutput,
  isPrintAtExitArgv,
  parseProgressSidecar,
  readClaimProgress,
} from '../src/lib/attempt-progress.ts';
import {
  readInflightClaim,
  superviseArgv,
  SUPERVISE_PROGRESS_SENTINEL,
} from '../src/lib/supervisor.ts';
import { renderStepPrompt } from '../src/lib/prompt.ts';
import { tempRepo } from './helpers.ts';

const RUN_ID = '2026-09-05-2002-visibility';
const STEP = 'run_workstreams';
const ACTOR = 'workstream_3';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An isolated-looking attempt workspace with the sidecar's parent directory ready. */
function attemptWorkspace(root: string): { workspace: string; sidecar: string } {
  const workspace = join(root, 'worktree');
  const rel = attemptProgressRelPath(RUN_ID, STEP, ACTOR);
  const sidecar = join(workspace, ...rel.split('/'));
  mkdirSync(dirname(sidecar), { recursive: true });
  return { workspace, sidecar };
}

function sidecarBody(fields: Record<string, unknown>): string {
  return JSON.stringify({ updated_at: new Date().toISOString(), ...fields });
}

// --- the mirror ---

test('supervisor mirrors the attempt progress sidecar onto its claim within two heartbeat ticks', async (t) => {
  const root = tempRepo(t);
  const { workspace, sidecar } = attemptWorkspace(root);
  const claimPath = join(root, 'claim.json');
  const statusPath = join(root, 'status.json');

  // The agent writes its sidecar a little into the run, so the supervisor's
  // first claim is written before there is anything to mirror — the real
  // ordering, and the one that proves the heartbeat is doing the reading.
  const executor = [
    'node',
    '-e',
    `const fs = require('fs');
     setTimeout(() => fs.writeFileSync(process.env.FADENO_TEST_SIDECAR, JSON.stringify({
       state: 'running',
       phase: 'writing the mirror test',
       current: 'polling the claim file',
       updated_at: new Date().toISOString(),
     })), 300);
     setTimeout(() => process.exit(0), 4000);`,
  ];

  const child = spawn(
    process.execPath,
    superviseArgv(executor, claimPath, statusPath, undefined, sidecar),
    { cwd: workspace, stdio: 'ignore', env: { ...process.env, FADENO_TEST_SIDECAR: sidecar } },
  );

  let mirrored: ReturnType<typeof readClaimProgress> = null;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!existsSync(claimPath)) continue;
    const claim = readInflightClaim(claimPath, (p) => readFileSync(p, 'utf8'));
    if (claim == null) continue;
    mirrored = readClaimProgress(claim);
    if (mirrored != null) break;
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(mirrored != null, 'the claim must carry the agent self-report the sidecar published');
  assert.equal(mirrored.state, 'running');
  assert.equal(mirrored.phase, 'writing the mirror test');
  assert.equal(mirrored.current, 'polling the claim file');
  assert.equal(mirrored.source, 'agent', 'a self-report must always be labeled as one');
  assert.ok(Date.parse(mirrored.updatedAt) > 0, 'updated_at must survive the mirror intact');
});

test('supervisor given no sidecar path leaves the claim free of progress fields', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'claim.json');
  const statusPath = join(root, 'status.json');
  const child = spawn(
    process.execPath,
    superviseArgv(['node', '-e', 'setTimeout(() => process.exit(0), 2500)'], claimPath, statusPath, undefined),
    { stdio: 'ignore' },
  );
  await sleep(1_500);
  const claim = readInflightClaim(claimPath, (p) => readFileSync(p, 'utf8'));
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(claim != null, 'the claim itself must still be published');
  assert.equal(readClaimProgress(claim), null, 'no sidecar path means nothing to report, not an empty report');
  assert.equal(claim.progressUpdatedAt, null);
  assert.equal(claim.progressSource, null);
  // The argv rides on every claim, sidecar or not: it is what tells a reader
  // whether this executor's silence means anything.
  assert.deepEqual(claim.command, ['node', '-e', 'setTimeout(() => process.exit(0), 2500)']);
  assert.equal(isPrintAtExitArgv(claim.command), false);
});

test('the claim carries the executor argv, so a reader can name silence correctly', async (t) => {
  const root = tempRepo(t);
  const claimPath = join(root, 'claim.json');
  const statusPath = join(root, 'status.json');
  // A stand-in named `claude` invoked in print mode: what the reader has to
  // recognize is the argv, not the binary that happens to be behind it.
  const shim = join(root, 'claude');
  writeFileSync(shim, '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
  const child = spawn(
    process.execPath,
    superviseArgv([shim, '-p', '--model', 'opus'], claimPath, statusPath, undefined),
    { stdio: 'ignore' },
  );
  await sleep(1_200);
  const claim = readInflightClaim(claimPath, (p) => readFileSync(p, 'utf8'));
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(claim != null);
  assert.deepEqual(claim.command, [shim, '-p', '--model', 'opus']);
  assert.equal(isPrintAtExitArgv(claim.command), true, 'a print-at-exit executor must be recognizable from the claim alone');
  const described = describeIdleOutput({ idleMs: 365_000, progress: readClaimProgress(claim), argv: claim.command });
  assert.equal(described.kind, 'print_at_exit');
});

test('supervisor clears the mirrored self-report when the sidecar goes unparsable', async (t) => {
  const root = tempRepo(t);
  const { workspace, sidecar } = attemptWorkspace(root);
  const claimPath = join(root, 'claim.json');
  const statusPath = join(root, 'status.json');
  writeFileSync(sidecar, sidecarBody({ state: 'running', phase: 'first phase' }), 'utf8');

  const child = spawn(
    process.execPath,
    superviseArgv(['node', '-e', 'setTimeout(() => process.exit(0), 4500)'], claimPath, statusPath, undefined, sidecar),
    { cwd: workspace, stdio: 'ignore' },
  );
  await sleep(1_200);
  // The mirror is live first, so the clearing below is a transition and not a
  // report that never arrived.
  const live = readClaimProgress(readInflightClaim(claimPath, (p) => readFileSync(p, 'utf8')));
  // A torn write: exactly what a reader catches mid-rename.
  writeFileSync(sidecar, '{"state": "runn', 'utf8');
  await sleep(1_500);
  const claim = readInflightClaim(claimPath, (p) => readFileSync(p, 'utf8'));
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(live != null && live.phase === 'first phase', 'the sidecar must have been mirrored before it went bad');
  assert.ok(claim != null);
  assert.equal(
    readClaimProgress(claim),
    null,
    'an unparsable sidecar leaves the fields absent; a self-report that stopped arriving must not read as current',
  );
  assert.equal(claim.progressUpdatedAt, null);
  assert.equal(claim.progressSource, null);
});

test('supervisor clears the mirrored self-report when the sidecar disappears', async (t) => {
  const root = tempRepo(t);
  const { workspace, sidecar } = attemptWorkspace(root);
  const claimPath = join(root, 'claim.json');
  const statusPath = join(root, 'status.json');
  writeFileSync(sidecar, sidecarBody({ state: 'running', phase: 'first phase' }), 'utf8');

  const child = spawn(
    process.execPath,
    superviseArgv(['node', '-e', 'setTimeout(() => process.exit(0), 4500)'], claimPath, statusPath, undefined, sidecar),
    { cwd: workspace, stdio: 'ignore' },
  );
  await sleep(1_200);
  const live = readClaimProgress(readInflightClaim(claimPath, (p) => readFileSync(p, 'utf8')));
  rmSync(sidecar, { force: true });
  await sleep(1_500);
  const claim = readInflightClaim(claimPath, (p) => readFileSync(p, 'utf8'));
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(live != null && live.phase === 'first phase', 'the sidecar must have been mirrored before it was removed');
  assert.ok(claim != null);
  assert.equal(readClaimProgress(claim), null, 'an absent sidecar leaves the fields absent');
  assert.equal(claim.progressUpdatedAt, null);
});

// --- the argv wire form ---

test('superviseArgv carries the sidecar path behind a sentinel, with no deadline slots', () => {
  // The two deadline slots this used to assert (a millisecond count and an
  // ISO `deadline_at`) are gone from the emitter with executor deadlines
  // themselves. The sentinel still disambiguates the sidecar form, and the
  // supervisor source still SNIFFS the legacy 7-slot layout so a hand-built
  // old argv lands its command correctly — see cancel-integration.
  const withProgress = superviseArgv(['echo', 'hi'], '/tmp/in.json', '/tmp/st.json', undefined, '/ws/.fadeno/progress/r/se.json');
  const after = withProgress.slice(withProgress.indexOf('--') + 1);
  assert.equal(after[0], SUPERVISE_PROGRESS_SENTINEL);
  assert.equal(after[2], '/tmp/in.json');
  assert.equal(after[3], '/tmp/st.json');
  assert.equal(after[4], '', 'the owner slot is empty when no owner is named');
  assert.equal(after[5], '/ws/.fadeno/progress/r/se.json');
  assert.deepEqual(after.slice(6), ['echo', 'hi']);
  assert.ok(!after.some((slot) => /^\d{4}-\d{2}-\d{2}T/.test(slot)), 'no deadline timestamp is emitted');
  // Slot 1 is the parent pid and is legitimately all digits; everything after
  // it is a path, an owner blob, or the command.
  assert.ok(!after.slice(2).some((slot) => /^\d+$/.test(slot)), 'no millisecond count is emitted');

  // Omitting the sidecar drops the sentinel and the slot with it.
  const legacy = superviseArgv(['echo', 'hi'], '/tmp/in.json', '/tmp/st.json', undefined);
  const afterLegacy = legacy.slice(legacy.indexOf('--') + 1);
  assert.notEqual(afterLegacy[0], SUPERVISE_PROGRESS_SENTINEL);
  assert.deepEqual(afterLegacy.slice(4), ['echo', 'hi']);
  assert.deepEqual(superviseArgv(['echo', 'hi'], '/tmp/in.json', '/tmp/st.json', undefined, ''), legacy);
});

test('parseProgressSidecar accepts a partial report and rejects everything without a timestamp', () => {
  const full = parseProgressSidecar(sidecarBody({ state: 'blocked', phase: 'waiting', current: 'on review' }))!;
  assert.equal(full.state, 'blocked');
  assert.equal(full.phase, 'waiting');
  assert.equal(full.source, 'agent');

  const partial = parseProgressSidecar(sidecarBody({ state: 'running' }))!;
  assert.equal(partial.state, 'running');
  assert.equal(partial.phase, null, 'a half-filled report keeps the half that arrived');

  assert.equal(parseProgressSidecar('{"state":"running"}'), null, 'no updated_at, no record');
  assert.equal(parseProgressSidecar('{"state":"running","updated_at":""}'), null);
  assert.equal(parseProgressSidecar('not json'), null);
  assert.equal(parseProgressSidecar('[]'), null);
  assert.equal(parseProgressSidecar('null'), null);
});

test('readClaimProgress keys on the timestamp alone', () => {
  assert.equal(readClaimProgress(null), null);
  assert.equal(readClaimProgress({}), null);
  assert.equal(readClaimProgress({ progressPhase: 'planning' }), null, 'a phase with no time is not progress');
  const progress = readClaimProgress({
    progressState: 'running',
    progressPhase: 'planning',
    progressCurrent: 'reading the contract',
    progressUpdatedAt: '2026-09-05T20:00:00.000Z',
    progressSource: 'agent',
  })!;
  assert.deepEqual(progress, {
    state: 'running',
    phase: 'planning',
    current: 'reading the contract',
    updatedAt: '2026-09-05T20:00:00.000Z',
    source: 'agent',
  });
});

test('isPrintAtExitArgv recognizes the two buffering modes and nothing else', () => {
  assert.equal(isPrintAtExitArgv(['claude', '-p']), true);
  assert.equal(isPrintAtExitArgv(['/opt/homebrew/bin/claude', '--print', '--model', 'opus']), true);
  assert.equal(isPrintAtExitArgv(['codex', 'exec', '--model', 'gpt-5.6']), true);
  assert.equal(isPrintAtExitArgv(['claude']), false, 'interactive claude does stream');
  assert.equal(isPrintAtExitArgv(['codex']), false);
  assert.equal(isPrintAtExitArgv(['opencode', 'run']), false, 'unrecognized argv falls through to the plain warning');
  assert.equal(isPrintAtExitArgv([]), false);
  assert.equal(isPrintAtExitArgv(null), false);
});

// --- the honest idle warning ---

test('describeIdleOutput says the three different things the three situations mean', () => {
  const now = new Date('2026-09-05T20:10:00.000Z');
  const progress = {
    state: 'running' as const,
    phase: 'writing tests' as string | null,
    current: null,
    updatedAt: '2026-09-05T20:09:20.000Z', // 40s before `now`
    source: 'agent' as const,
  };

  const cases: Array<{ name: string; input: Parameters<typeof describeIdleOutput>[0]; kind: string; text: string }> = [
    {
      name: 'sidecar moved during the silence',
      input: { idleMs: 365_000, progress, argv: ['claude', '-p'], now },
      kind: 'agent_progress',
      text: 'no stdout/stderr for 6m 5s; agent progress "writing tests" 40s ago',
    },
    {
      name: 'no sidecar, print-at-exit executor',
      input: { idleMs: 365_000, progress: null, argv: ['claude', '-p'], now },
      kind: 'print_at_exit',
      text: 'no stdout/stderr for 6m 5s (this executor prints only at exit; not a stall signal)',
    },
    {
      name: 'no sidecar, streaming executor',
      input: { idleMs: 365_000, progress: null, argv: ['opencode', 'run'], now },
      kind: 'output_idle',
      text: 'no output observed for 6m 5s (non-gating)',
    },
  ];
  for (const testCase of cases) {
    const described = describeIdleOutput(testCase.input);
    assert.equal(described.kind, testCase.kind, testCase.name);
    assert.equal(described.text, testCase.text, testCase.name);
  }
});

test('describeIdleOutput does not dress a stale self-report up as reassurance', () => {
  const now = new Date('2026-09-05T20:10:00.000Z');
  // Last touched twenty minutes ago; the streams have only been quiet for six.
  // The agent has not moved DURING the silence, so it is not evidence of work.
  const stale = {
    state: 'running',
    phase: 'writing tests',
    current: null,
    updatedAt: '2026-09-05T19:50:00.000Z',
    source: 'agent' as const,
  };
  const onPrintAtExit = describeIdleOutput({ idleMs: 365_000, progress: stale, argv: ['codex', 'exec'], now });
  assert.equal(onPrintAtExit.kind, 'print_at_exit');
  const onStreaming = describeIdleOutput({ idleMs: 365_000, progress: stale, argv: ['some-tool'], now });
  assert.equal(onStreaming.kind, 'output_idle');
  assert.equal(onStreaming.progressAgeMs, 1_200_000, 'the age is still reported for a caller that wants it');
});

test('describeIdleOutput falls back to the prior wording when the idle window cannot be measured', () => {
  const described = describeIdleOutput({ idleMs: null, progress: null, argv: null });
  assert.equal(described.text, 'no output observed for 5m (non-gating)');
  assert.equal(described.kind, 'output_idle');
});

test('describeIdleOutput names the phase, then the state, and never an empty label', () => {
  const now = new Date('2026-09-05T20:10:00.000Z');
  const base = { current: null, updatedAt: '2026-09-05T20:09:20.000Z', source: 'agent' as const };
  assert.match(
    describeIdleOutput({ idleMs: 365_000, progress: { ...base, state: 'blocked', phase: null }, now }).text,
    /agent progress "blocked" 40s ago/,
  );
  assert.match(
    describeIdleOutput({ idleMs: 365_000, progress: { ...base, state: null, phase: null }, now }).text,
    /agent progress "progress" 40s ago/,
  );
});

test('attemptProgressRelPath is the single spelling the prompt and the supervisor both use', () => {
  assert.equal(
    attemptProgressRelPath('2026-09-05-2002-run', 'review', 'reviewer'),
    '.fadeno/progress/2026-09-05-2002-run/review--reviewer.json',
  );
  // Same sanitization as the prompt's, including the anonymous-actor case.
  assert.equal(
    attemptProgressRelPath('2026-09-05-2002-run', 'run workstreams', null),
    '.fadeno/progress/2026-09-05-2002-run/run_workstreams--anonymous.json',
  );
});

// The drift tripwire. The supervisor watches a path; the agent is told a path
// by the rendered prompt. Nothing errors when those two disagree — the claim
// just silently reports no progress forever, which is the exact failure this
// workstream exists to remove. So assert the path the supervisor is pointed at
// appears verbatim in the prompt the engine actually renders.
test('the path the supervisor watches is the one the rendered command-lane prompt names', () => {
  const prompt = renderStepPrompt({
    runId: RUN_ID,
    playbookName: 'parallel-workstreams',
    schemaVersion: '0.1',
    task: 'close the frictions',
    step: STEP,
    kind: 'map',
    actor: ACTOR,
    otherMembers: [],
    iteration: null,
    maxIterations: null,
    invocation: 1,
    loopOwner: null,
    purpose: null,
    inputs: [],
    output: {
      path: 'artifacts/report.md',
      mediaType: 'text/markdown',
      schemaKind: null,
      instructions: null,
      collectiveType: 'WorkstreamReport[]',
      memberType: 'WorkstreamReport',
      isMap: true,
    },
    downstream: null,
    policies: null,
    schemaText: null,
    inline: false,
    rejection: null,
  });
  const watched = attemptProgressRelPath(RUN_ID, STEP, ACTOR);
  assert.ok(
    prompt.includes(`\`${watched}\``),
    `the prompt must name the sidecar the supervisor watches (${watched})`,
  );
});

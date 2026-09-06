import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { tempRepo } from './helpers.ts';
import { runClean } from '../src/commands/clean.ts';
import { runDispatchPrepare } from '../src/commands/dispatch-prepare.ts';
import { runDispatchComplete, runDispatchFail, runDispatchStart } from '../src/commands/dispatch.ts';
import { runDispatchWithdraw } from '../src/commands/dispatch-withdraw.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import {
  captureOverlapSnapshot,
  closeDispatchWindow,
  detectConcurrentWrites,
  listOverlapSnapshots,
  openDispatchWindow,
  overlapSnapshotPath,
  readDispatchWindows,
  readOverlapSnapshot,
  DISPATCH_WINDOWS_FILE,
  OVERLAP_SNAPSHOTS_DIR,
} from '../src/lib/workspace-overlap.ts';

// ---------------------------------------------------------------------------
// A shared host delivery's path set.
//
// It used to be TRUNCATED unconditionally, and the reason given was that
// `dispatch-start` and `dispatch-complete` are separate CLI invocations, so no
// "before" reading of the tree survives between them. That was true of the
// implementation, not of the problem: the reading simply was not written down.
// It is now, at `.fadeno/local/overlap-snapshots/`, and the terminal diffs it
// against a fresh one exactly as the tool lane does inside one process.
//
// What must NOT change is the thing truncated was protecting. A shared delta
// is an ATTESTATION (`attribution: 'workspace'` — this delivery, or anyone
// else in the same minutes), and every way the baseline can be unavailable has
// to come back `truncated`, never as the empty set, which is the positive
// claim "this delivery changed nothing" that the whole module exists to avoid
// making falsely. Most of the tests below are about that second half.
// ---------------------------------------------------------------------------

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: overlap-snapshot-fixture
description: Fixture.
roles:
  worker:
    purpose: Do work.
inputs:
  Task:
    media_type: text/markdown
flow:
  - id: implement
    kind: actor_call
    actor: worker
    input: [Task]
    output: Notes
    terminal_status: completed
`;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@invalid',
};

function git(root: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
  if (res.error != null || res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? res.error}`);
}

/**
 * A repo with one host request awaiting delivery, and a temp output file
 * already on disk.
 *
 * The output file is written BEFORE `dispatch-start` on purpose: it is the
 * caller's scratch, not the delivery's work, so it belongs in the baseline
 * where it cancels out of the delta rather than appearing as a path the
 * delivery touched.
 */
function seedRun(t: TestContext) {
  const root = tempRepo(t);
  git(root, ['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'overlap-snapshot-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, 'task.md'), 'do the thing');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
    harnesses: { dummy: { provider: 'dummy', host: { effort_channel: 'none' } } },
    archetypes: { worker: {} },
    bindings: { worker: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'overlap-snapshot-fixture', task: 'overlap test', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  const output = join(root, 'out.md');
  writeFileSync(output, 'final output');
  return { root, runId, runDir, request, output, windowId: `${runId}:${request.dispatchId}` };
}

function windowFor(root: string, windowId: string) {
  return readDispatchWindows(root).windows.find((w) => w.dispatchId === windowId);
}

function terminalExtra(runDir: string, dispatchId: string): Record<string, unknown> | null {
  const events = readEvents(runDir).events as unknown as Record<string, unknown>[];
  const found = events.find(
    (e) => (e.type === 'actor_completed' || e.type === 'actor_failed') && (e as any).extra?.dispatch_id === dispatchId,
  );
  return (found as any)?.extra ?? null;
}

// --- the fix ---------------------------------------------------------------

test('a shared host delivery reports the paths that changed in the shared tree', (t) => {
  const { root, runId, runDir, request, output, windowId } = seedRun(t);

  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared', now: new Date('2026-09-06T11:01:00Z') });
  assert.ok(existsSync(join(root, overlapSnapshotPath(windowId))), 'dispatch-start writes the baseline for a shared delivery');

  // What the delivery did, in the caller's tree, between start and terminal.
  writeFileSync(join(root, 'base.txt'), 'edited by the delivery\n');
  writeFileSync(join(root, 'added.txt'), 'new\n');

  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output, now: new Date('2026-09-06T11:05:00Z') });

  const window = windowFor(root, windowId)!;
  assert.equal(window.truncated, false, 'the delta was computable, so this is no longer a permanent "could not tell"');
  assert.deepEqual(window.changedPaths, ['added.txt', 'base.txt'], 'a real, sorted path set — the tree delta over the window');
  assert.equal(window.workspaceMode, 'shared');

  // And a neighbour closing after it intersects against work rather than
  // against an admission of ignorance.
  const log = readDispatchWindows(root);
  const stamps = detectConcurrentWrites(
    {
      dispatchId: 'neighbour',
      startedAt: '2026-09-06T11:00:00.000Z',
      endedAt: '2026-09-06T11:06:00.000Z',
      workspaceMode: 'isolated',
      changedPaths: ['base.txt'],
    },
    log.windows,
    { logDegraded: log.degraded },
  );
  const seen = stamps!.find((stamp) => stamp.dispatch_id === windowId)!;
  assert.equal(seen.paths_intersecting, 1);
  assert.deepEqual(seen.paths, ['base.txt']);
  assert.equal(seen.degraded, undefined, 'both listings were whole');
  // The distinction the better attestation must not erase.
  assert.equal(seen.attribution, 'workspace', 'a shared delta is still "this delivery, or anyone else"');
  assert.match(seen.note, /attestation that both windows touched these paths, not proof of who wrote them/);

  assert.equal(terminalExtra(runDir, request.dispatchId)!.workspace_mode, undefined, 'a shared receipt still stamps no workspace_mode');
});

test('a shared delivery that changed nothing says so from two real readings', (t) => {
  const { root, runId, request, output, windowId } = seedRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared' });
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });

  const window = windowFor(root, windowId)!;
  // This IS the empty set, and it is allowed here for the one reason it was
  // never allowed before: it is backed by two readings of the tree that agreed,
  // not by the absence of any reading at all.
  assert.deepEqual(window.changedPaths, []);
  assert.equal(window.truncated, false);
});

// --- every way it can fail is "could not tell", never "nothing" -------------

test('a missing baseline is truncated, never an empty positive claim', (t) => {
  const { root, runId, request, output, windowId } = seedRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared', now: new Date('2026-09-06T11:01:00Z') });
  writeFileSync(join(root, 'base.txt'), 'edited by the delivery\n');

  // The delivery ran, and its baseline is gone: a `fadeno clean` mid-flight, a
  // crashed start, an old repo. The terminal must not describe that as an
  // empty set — every neighbour intersects against what it says.
  rmSync(join(root, overlapSnapshotPath(windowId)), { force: true });

  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output, now: new Date('2026-09-06T11:05:00Z') });
  const window = windowFor(root, windowId)!;
  assert.equal(window.truncated, true, 'no baseline is "could not tell"');
  assert.deepEqual(window.changedPaths, []);

  const log = readDispatchWindows(root);
  const stamps = detectConcurrentWrites(
    {
      dispatchId: 'neighbour',
      startedAt: '2026-09-06T11:00:00.000Z',
      endedAt: '2026-09-06T11:59:00.000Z',
      workspaceMode: 'isolated',
      changedPaths: ['base.txt'],
    },
    log.windows,
    { logDegraded: log.degraded },
  );
  const seen = stamps!.find((stamp) => stamp.dispatch_id === windowId)!;
  assert.equal(seen.degraded, true, 'a neighbour reads it as unknown');
  assert.match(seen.note, /could not enumerate/);
  assert.match(seen.note, /UNKNOWN\. This is not a report that they did not meet\./);
});

test('an unusable baseline is truncated: unparsable, wrong version, incomplete, or another window\'s', (t) => {
  const cases: Array<[string, (windowId: string) => string]> = [
    ['unparsable', () => '{not json'],
    ['wrong schema version', (id) => JSON.stringify({ schema_version: 99, dispatch_id: id, captured_at: '2026-09-06T11:00:00.000Z', complete: true, status: {} })],
    ['over budget', (id) => JSON.stringify({ schema_version: 1, dispatch_id: id, captured_at: '2026-09-06T11:00:00.000Z', complete: false })],
    ['another window', () => JSON.stringify({ schema_version: 1, dispatch_id: 'someone-else', captured_at: '2026-09-06T11:00:00.000Z', complete: true, status: {} })],
    ['a non-string status code', (id) => JSON.stringify({ schema_version: 1, dispatch_id: id, captured_at: '2026-09-06T11:00:00.000Z', complete: true, status: { 'a.txt': 7 } })],
  ];
  for (const [label, body] of cases) {
    const { root, runId, request, output, windowId } = seedRun(t);
    runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared' });
    writeFileSync(join(root, overlapSnapshotPath(windowId)), body(windowId), 'utf8');
    assert.equal(readOverlapSnapshot(root, windowId), null, `${label} reads as null`);
    writeFileSync(join(root, 'base.txt'), 'edited by the delivery\n');

    runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
    const window = windowFor(root, windowId)!;
    assert.equal(window.truncated, true, `${label}: truncated`);
    assert.deepEqual(window.changedPaths, [], `${label}: and no positive claim`);
  }
});

test('a baseline over budget records that it is incomplete rather than a partial map', (t) => {
  const root = tempRepo(t);
  git(root, ['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  // A capped map diffed against a complete one reports every dropped entry as
  // a change, so the over-budget document carries no entries at all.
  const huge = new Map<string, string>();
  for (let index = 0; index < 20_001; index += 1) huge.set(`f${index}.txt`, '??');
  assert.equal(captureOverlapSnapshot(root, 'w1', { status: huge }), 'degraded');
  const doc = JSON.parse(readFileSync(join(root, overlapSnapshotPath('w1')), 'utf8')) as Record<string, unknown>;
  assert.equal(doc.complete, false);
  assert.equal(doc.status, undefined, 'no partial map is kept — a partial map is worse than none');
  assert.equal(readOverlapSnapshot(root, 'w1'), null);

  // A git that will not answer is the same answer, and still leaves a record
  // that someone tried.
  assert.equal(captureOverlapSnapshot(root, 'w2', { status: null }), 'degraded');
  assert.equal(readOverlapSnapshot(root, 'w2'), null);
});

// --- the isolated lane is untouched -----------------------------------------

test('an isolated delivery takes no baseline and still reports its own diff', (t) => {
  const { root, runId, request, output, windowId } = seedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-isolated' });
  assert.equal(
    existsSync(join(root, overlapSnapshotPath(windowId))),
    false,
    'an isolated delivery has a strictly better answer from its own diff; spending a baseline on it would buy a worse one',
  );
  assert.deepEqual(listOverlapSnapshots(root), []);

  writeFileSync(join(resolve(root, prep.workspace), 'base.txt'), 'host edit\n');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });

  const window = windowFor(root, windowId)!;
  assert.equal(window.truncated, false);
  assert.deepEqual(window.changedPaths, ['base.txt'], "from the worktree's own diff, as before");
  assert.equal(window.workspaceMode, 'isolated');
});

test("a degraded isolated terminal stays truncated — this tree's delta says nothing about another tree", (t) => {
  const { root, runId, request, windowId } = seedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-isolated' });
  // Evidence gone: no state file, no worktree, so no diff can be collected.
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`), { force: true });
  rmSync(resolve(root, prep.workspace), { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8', env: GIT_ENV });
  // Something changed in the SHARED tree in the meantime; it is not this
  // delivery's, and must not be attributed to it.
  writeFileSync(join(root, 'base.txt'), 'the human, meanwhile\n');

  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'killed' });
  const window = windowFor(root, windowId)!;
  assert.equal(window.truncated, true);
  assert.deepEqual(window.changedPaths, []);
});

// --- cleanup ---------------------------------------------------------------

test('the baseline is removed at a successful terminal', (t) => {
  const { root, runId, request, output, windowId } = seedRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared' });
  assert.equal(listOverlapSnapshots(root).length, 1);
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  assert.equal(existsSync(join(root, overlapSnapshotPath(windowId))), false);
  assert.deepEqual(listOverlapSnapshots(root), []);
});

test('the baseline is removed at a failed terminal', (t) => {
  const { root, runId, request, windowId } = seedRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared' });
  assert.equal(listOverlapSnapshots(root).length, 1);
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'stopped' });
  assert.equal(existsSync(join(root, overlapSnapshotPath(windowId))), false);
});

test('the baseline is removed at a withdrawal', (t) => {
  const { root, runId, request, windowId } = seedRun(t);
  // A withdraw requires that `dispatch-start` never landed, so the only way a
  // baseline is here is the path that writes one and then fails to append
  // `actor_dispatched` — which leaves exactly this: a baseline behind a
  // request that never started, and a withdraw is what retires it.
  captureOverlapSnapshot(root, windowId);
  assert.equal(listOverlapSnapshots(root).length, 1);
  runDispatchWithdraw({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'executor unreachable' });
  assert.equal(existsSync(join(root, overlapSnapshotPath(windowId))), false);
});

test('an idempotent re-terminal sweeps a baseline the first terminal left behind', (t) => {
  const { root, runId, request, output, windowId } = seedRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared' });
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  // The shape a crash between the receipt and the cleanup leaves.
  captureOverlapSnapshot(root, windowId);
  assert.equal(listOverlapSnapshots(root).length, 1);
  const again = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  assert.equal(again.idempotent, true);
  assert.deepEqual(listOverlapSnapshots(root), [], 'the re-terminal is a terminal too');
});

// --- the two traps ---------------------------------------------------------

test('a replayed dispatch-start keeps the FIRST baseline', (t) => {
  const { root, runId, request, output, windowId } = seedRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared', now: new Date('2026-09-06T11:01:00Z') });
  const first = readFileSync(join(root, overlapSnapshotPath(windowId)), 'utf8');

  // The agent has been working for a while.
  writeFileSync(join(root, 'base.txt'), 'half the work\n');

  // A replayed `dispatch-start` is idempotent and legal. Re-reading the tree
  // here would move the baseline PAST what the agent already wrote and erase
  // it from the delta — the delivery would report changing nothing.
  const replay = runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared', now: new Date('2026-09-06T11:04:00Z') });
  assert.equal(replay.idempotent, true);
  assert.equal(readFileSync(join(root, overlapSnapshotPath(windowId)), 'utf8'), first, 'byte-for-byte the first reading');

  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  assert.deepEqual(windowFor(root, windowId)!.changedPaths, ['base.txt'], 'the work done before the replay is still in the set');
});

test('a re-terminal does not corrupt the record the first terminal wrote', (t) => {
  const { root, runId, request, output, windowId } = seedRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared' });
  writeFileSync(join(root, 'added.txt'), 'new\n');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  const settled = windowFor(root, windowId)!;
  assert.deepEqual(settled.changedPaths, ['added.txt']);
  assert.equal(settled.truncated, false);

  // The idempotent replay must not append a truncated close over a good
  // listing — the failure `closeHostWindowIfOpen`'s `endedAt` check exists for.
  const again = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  assert.equal(again.idempotent, true);
  const after = windowFor(root, windowId)!;
  assert.deepEqual(after.changedPaths, ['added.txt'], 'unchanged');
  assert.equal(after.truncated, false, 'still a complete listing, not downgraded by the replay');
});

// --- the machine-local state has a home, a sweeper and a doctor -------------

test('doctor counts leftover baselines and never calls an in-flight one stale', (t) => {
  const root = tempRepo(t);
  const clean = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'overlap-snapshots')!;
  assert.equal(clean.severity, 'ok', 'a repo with none says so rather than staying silent');
  assert.match(clean.detail, /no leftover/);

  // One delivery still writing: its baseline is in use, not garbage.
  openDispatchWindow(root, { dispatchId: 'live', kind: 'host-dispatch', workspaceMode: 'shared', startedAt: new Date('2026-09-06T10:00:00Z') });
  captureOverlapSnapshot(root, 'live');
  const inFlight = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'overlap-snapshots')!;
  assert.equal(inFlight.severity, 'ok', 'telling a user to delete what a running delivery is about to read is the worse error');
  assert.match(inFlight.detail, /still open/);

  // One that closed and did not clean up, and one no window names at all.
  openDispatchWindow(root, { dispatchId: 'closed', kind: 'host-dispatch', workspaceMode: 'shared', startedAt: new Date('2026-09-06T10:00:00Z') });
  captureOverlapSnapshot(root, 'closed');
  closeDispatchWindow(root, { dispatchId: 'closed', changedPaths: [], truncated: true, endedAt: new Date('2026-09-06T10:05:00Z') });
  captureOverlapSnapshot(root, 'unwindowed');

  const stale = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'overlap-snapshots')!;
  assert.equal(stale.severity, 'warning');
  assert.match(stale.detail, /2 leftover/);
  assert.match(stale.detail, /a further 1 belong to deliveries still in flight/);
  assert.match(stale.detail, /closed/);
  assert.match(stale.remediation ?? '', /fadeno clean --force/);
});

test('an unreadable window log makes an unmatched baseline unknown, not proven stale', (t) => {
  const root = tempRepo(t);
  openDispatchWindow(root, { dispatchId: 'live', kind: 'host-dispatch', workspaceMode: 'shared' });
  captureOverlapSnapshot(root, 'unwindowed');
  writeFileSync(join(root, DISPATCH_WINDOWS_FILE), `${readFileSync(join(root, DISPATCH_WINDOWS_FILE), 'utf8')}{"event":"window_clos`, 'utf8');

  const finding = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'overlap-snapshots')!;
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /possibly-live rather than proven stale/);
});

test('a baseline that cannot be read is still counted and still classified', (t) => {
  const root = tempRepo(t);
  // Listing and classification go by FILENAME, so a corrupt document — the
  // file most likely to be a leftover — is never the one the reader has to
  // shrug at. A classifier that parsed documents would report "unknown" here.
  openDispatchWindow(root, { dispatchId: 'w1', kind: 'host-dispatch', workspaceMode: 'shared' });
  captureOverlapSnapshot(root, 'w1');
  writeFileSync(join(root, overlapSnapshotPath('w1')), '{not json', 'utf8');
  assert.deepEqual(listOverlapSnapshots(root), [overlapSnapshotPath('w1')]);

  const finding = runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'overlap-snapshots')!;
  assert.equal(finding.severity, 'ok', 'its window is still open, so it is in use rather than garbage');
  assert.match(finding.detail, /still open/);
});

test('fadeno clean accounts for the baselines it deletes', (t) => {
  const root = tempRepo(t);
  captureOverlapSnapshot(root, 'w1');
  captureOverlapSnapshot(root, 'w2');
  const preview = runClean({ repoRoot: root });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.overlapSnapshots.length, 2, 'counted on the dry run, before anything is deleted');
  assert.deepEqual(preview.overlapSnapshots, [overlapSnapshotPath('w1'), overlapSnapshotPath('w2')].sort());
  assert.ok(existsSync(join(root, overlapSnapshotPath('w1'))), 'a dry run deletes nothing');

  const forced = runClean({ repoRoot: root, force: true });
  assert.equal(forced.overlapSnapshots.length, 2, 'and read before deletion on a --force run too');
  assert.equal(existsSync(join(root, OVERLAP_SNAPSHOTS_DIR)), false, 'swept with .fadeno/local');
});

test('two window ids that sanitize alike do not share a baseline file', () => {
  // A collision would hand one delivery another delivery's baseline and
  // produce a confidently wrong path set — the one outcome this module never
  // permits — so the filename carries a digest of the full id.
  const a = overlapSnapshotPath('2026-09-06-1200-run:hd/ac-implement');
  const b = overlapSnapshotPath('2026-09-06-1200-run:hd_ac-implement');
  assert.notEqual(a, b);
  for (const path of [a, b]) {
    assert.ok(path.startsWith(OVERLAP_SNAPSHOTS_DIR));
    assert.doesNotMatch(path.slice(OVERLAP_SNAPSHOTS_DIR.length + 1), /[\\/]|\.\./, 'no traversal survives the sanitizer');
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  changedBetween,
  closeDispatchWindow,
  detectConcurrentWrites,
  diffChangedPaths,
  DISPATCH_WINDOWS_FILE,
  openDispatchWindow,
  openWindowsOtherThan,
  readDispatchWindows,
  shouldAutoIsolate,
  WINDOW_MAX_PATHS,
  workspaceStatusMap,
} from '../src/lib/workspace-overlap.ts';
import {
  concurrentWriteStrength,
  describeConcurrentWrite,
  parseConcurrentWriteStamps,
  UNREADABLE_WINDOW_LOG_ID,
} from '../src/lib/receipt-attestations.ts';
import { describeVestigialWorkspaceLease, WORKSPACE_LEASE_FILE, WORKSPACE_LEASE_LOCK } from '../src/lib/workspace-lease.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { tempRepo } from './helpers.ts';

// ---------------------------------------------------------------------------
// The lock is gone; this is what replaced it.
//
// Deleting the repo-wide writer lease without detection would convert a wedged
// repo into silent lost writes, which is strictly worse: a wedge is a refusal
// with a message that a human resolves, where a lost write is work that
// quietly is not there. Every test below exists because the lock no longer
// does.
// ---------------------------------------------------------------------------

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
}

function seedRepo(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed');
}

test('a window round-trips through the append-only log', (t) => {
  const root = tempRepo(t);
  openDispatchWindow(root, { dispatchId: 'd1', runId: 'r1', kind: 'ad-hoc', workspaceMode: 'shared', startedAt: new Date('2026-09-06T10:00:00Z') });
  let read = readDispatchWindows(root);
  assert.equal(read.degraded, false);
  assert.equal(read.windows.length, 1);
  assert.equal(read.windows[0]!.endedAt, null, 'an open window has no end');
  assert.equal(read.windows[0]!.changedPaths, null, 'and no path set yet');

  closeDispatchWindow(root, { dispatchId: 'd1', changedPaths: ['b.txt', 'a.txt', 'a.txt'], endedAt: new Date('2026-09-06T10:05:00Z') });
  read = readDispatchWindows(root);
  assert.equal(read.windows.length, 1, 'open+close fold into one record');
  assert.deepEqual(read.windows[0]!.changedPaths, ['a.txt', 'b.txt'], 'deduped and sorted');
  assert.equal(read.windows[0]!.truncated, false);
});

test('an unreadable or torn log degrades, and never reports clean', (t) => {
  const root = tempRepo(t);
  assert.deepEqual(readDispatchWindows(root), { windows: [], degraded: false }, 'no log at all is not degraded — nothing has run');

  openDispatchWindow(root, { dispatchId: 'd1', kind: 'ad-hoc', workspaceMode: 'shared' });
  // A half-written append is exactly what an interrupted process leaves.
  appendFileSync(join(root, DISPATCH_WINDOWS_FILE), '{"event":"window_clos', 'utf8');
  const read = readDispatchWindows(root);
  assert.equal(read.degraded, true, 'a torn line must be reported, not skipped silently');
  assert.equal(read.windows.length, 1, 'and the intact records still parse');

  // A close naming a window this log never saw open has an unknown interval.
  const root2 = tempRepo(t);
  mkdirSync(join(root2, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root2, DISPATCH_WINDOWS_FILE), `${JSON.stringify({ event: 'window_closed', dispatch_id: 'ghost', ended_at: new Date().toISOString(), changed_paths: [] })}\n`, 'utf8');
  const orphan = readDispatchWindows(root2);
  assert.equal(orphan.windows.length, 0, 'an orphan close cannot be intersected and is dropped');
  assert.equal(orphan.degraded, true, 'but the reader says it saw something it could not use');
});

test('contention isolates instead of refusing', (t) => {
  const root = tempRepo(t);
  assert.deepEqual(shouldAutoIsolate(root, 'mine'), { isolate: false, others: [] }, 'an empty repo has no contention');

  openDispatchWindow(root, { dispatchId: 'other', kind: 'host-dispatch', workspaceMode: 'shared', runId: 'r1' });
  const contended = shouldAutoIsolate(root, 'mine');
  assert.equal(contended.isolate, true, 'another shared writer means: take your own tree');
  assert.deepEqual(contended.others.map((w) => w.dispatchId), ['other']);

  // My own window never counts as contention against me.
  openDispatchWindow(root, { dispatchId: 'mine', kind: 'ad-hoc', workspaceMode: 'shared' });
  assert.deepEqual(openWindowsOtherThan(root, 'mine').map((w) => w.dispatchId), ['other']);

  // An ISOLATED neighbour is not contention: it cannot write this tree.
  const root2 = tempRepo(t);
  openDispatchWindow(root2, { dispatchId: 'iso', kind: 'ad-hoc', workspaceMode: 'isolated' });
  assert.equal(shouldAutoIsolate(root2, 'mine').isolate, false);

  // A closed neighbour is not contention either.
  closeDispatchWindow(root, { dispatchId: 'other', changedPaths: [] });
  assert.equal(shouldAutoIsolate(root, 'mine').isolate, false, 'a finished delivery holds nothing');
});

test('overlapping windows with intersecting paths stamp each other', () => {
  const other = {
    dispatchId: 'other',
    runId: 'r1',
    kind: 'engine' as const,
    workspaceMode: 'isolated' as const,
    startedAt: '2026-09-06T10:00:00Z',
    endedAt: '2026-09-06T10:10:00Z',
    changedPaths: ['src/a.ts', 'src/shared.ts'],
    truncated: false,
  };
  const stamps = detectConcurrentWrites(
    {
      dispatchId: 'mine',
      startedAt: '2026-09-06T10:05:00Z',
      endedAt: '2026-09-06T10:15:00Z',
      workspaceMode: 'isolated',
      changedPaths: ['src/b.ts', 'src/shared.ts'],
    },
    [other],
  );
  assert.ok(stamps != null, 'an intersection must be recorded');
  assert.equal(stamps!.length, 1);
  assert.equal(stamps![0]!.dispatch_id, 'other');
  assert.equal(stamps![0]!.paths_intersecting, 1);
  assert.deepEqual(stamps![0]!.paths, ['src/shared.ts']);
  assert.equal(stamps![0]!.attribution, 'delivery', "an isolated window's paths are its own work");
  assert.equal(stamps![0]!.pending, undefined);
});

test('overlap in time without overlap in paths is not an event', () => {
  const stamps = detectConcurrentWrites(
    { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'isolated', changedPaths: ['src/b.ts'] },
    [{ dispatchId: 'other', runId: null, kind: 'ad-hoc', workspaceMode: 'isolated', startedAt: '2026-09-06T10:00:00Z', endedAt: '2026-09-06T10:10:00Z', changedPaths: ['src/a.ts'], truncated: false }],
  );
  assert.equal(stamps, null, 'two writers who never met produce no stamp — a field on every receipt is a field nobody reads');
});

test('disjoint windows never stamp, however alarming the path overlap', () => {
  const stamps = detectConcurrentWrites(
    { dispatchId: 'mine', startedAt: '2026-09-06T11:00:00Z', endedAt: '2026-09-06T11:10:00Z', workspaceMode: 'shared', changedPaths: ['src/shared.ts'] },
    [{ dispatchId: 'earlier', runId: null, kind: 'ad-hoc', workspaceMode: 'shared', startedAt: '2026-09-06T10:00:00Z', endedAt: '2026-09-06T10:10:00Z', changedPaths: ['src/shared.ts'], truncated: false }],
  );
  assert.equal(stamps, null, 'editing the same file an hour apart is ordinary work, not concurrency');
});

test('a still-open neighbour is named as pending, and the later receipt carries the paths', () => {
  const openNeighbour = {
    dispatchId: 'still-running',
    runId: null,
    kind: 'host-dispatch' as const,
    workspaceMode: 'shared' as const,
    startedAt: '2026-09-06T10:00:00Z',
    endedAt: null,
    changedPaths: null,
    truncated: false,
  };
  const first = detectConcurrentWrites(
    { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'shared', changedPaths: ['src/shared.ts'] },
    [openNeighbour],
  );
  assert.ok(first != null);
  assert.equal(first![0]!.pending, true, 'the overlap in time is a fact and is recorded');
  assert.equal(first![0]!.paths_intersecting, 0, 'but there is no set on the other side to intersect yet');
  assert.match(first![0]!.note, /closes later/);

  // The neighbour closes afterwards and therefore sees MY completed set — so
  // between the two receipts the pair is fully described and each names the other.
  const second = detectConcurrentWrites(
    { dispatchId: 'still-running', startedAt: '2026-09-06T10:00:00Z', endedAt: '2026-09-06T10:20:00Z', workspaceMode: 'shared', changedPaths: ['src/shared.ts'] },
    [{ dispatchId: 'mine', runId: null, kind: 'ad-hoc', workspaceMode: 'shared', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', changedPaths: ['src/shared.ts'], truncated: false }],
  );
  assert.ok(second != null);
  assert.equal(second![0]!.paths_intersecting, 1);
  assert.deepEqual(second![0]!.paths, ['src/shared.ts']);
});

test('a shared window is an attestation and says so', () => {
  const stamps = detectConcurrentWrites(
    { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'isolated', changedPaths: ['src/shared.ts'] },
    [{ dispatchId: 'other', runId: null, kind: 'ad-hoc', workspaceMode: 'shared', startedAt: '2026-09-06T10:00:00Z', endedAt: '2026-09-06T10:10:00Z', changedPaths: ['src/shared.ts'], truncated: false }],
  );
  assert.equal(stamps![0]!.attribution, 'workspace');
  assert.match(stamps![0]!.note, /attestation/, 'a shared set includes whoever else touched the tree, and must not read as blame');
});

test("a capped listing degrades the stamp rather than under-reporting it", () => {
  // The OTHER side hit `WINDOW_MAX_PATHS`: it named paths, and there were
  // more. Its intersection is a floor. (Self can never be in this state — see
  // the next test for the shape a real caller actually produces.)
  const stamps = detectConcurrentWrites(
    { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'shared', changedPaths: ['src/shared.ts'] },
    [{ dispatchId: 'other', runId: null, kind: 'ad-hoc', workspaceMode: 'shared', startedAt: '2026-09-06T10:00:00Z', endedAt: '2026-09-06T10:10:00Z', changedPaths: ['src/shared.ts'], truncated: true }],
  );
  assert.equal(stamps![0]!.degraded, true);
  assert.match(stamps![0]!.note, /floor, not the set/);
});

test('a delivery that could not list its OWN changes still reports every overlap', () => {
  // THE SHAPE A REAL CALLER PRODUCES. Every caller writes
  //   `const truncated = changed == null; const paths = changed ?? [];`
  // so a self-truncated delivery arrives with an EMPTY set — never with paths.
  // The old test passed `truncated: true` WITH a path, a combination no caller
  // can produce, and that is why it went green while the branch it was meant
  // to protect returned nothing at all: `mine` was empty, every intersection
  // was empty, and the empty intersection was reported as "no overlap".
  const neighbour = {
    dispatchId: 'other',
    runId: 'r1',
    kind: 'engine' as const,
    workspaceMode: 'isolated' as const,
    startedAt: '2026-09-06T10:00:00Z',
    endedAt: '2026-09-06T10:10:00Z',
    changedPaths: ['src/a.ts', 'src/b.ts'],
    truncated: false,
  };
  const stamps = detectConcurrentWrites(
    {
      dispatchId: 'mine',
      startedAt: '2026-09-06T10:05:00Z',
      endedAt: '2026-09-06T10:15:00Z',
      workspaceMode: 'shared',
      changedPaths: [],
      truncated: true,
    },
    [neighbour],
  );
  assert.ok(stamps != null, 'a delivery that cannot say what it changed must not report "nothing overlapped"');
  assert.equal(stamps!.length, 1);
  assert.equal(stamps![0]!.dispatch_id, 'other');
  assert.equal(stamps![0]!.degraded, true);
  assert.equal(stamps![0]!.paths_intersecting, 0, 'zero KNOWN hits');
  assert.match(stamps![0]!.note, /UNKNOWN/);
  assert.match(stamps![0]!.note, /not a report that they did not meet/);
  assert.equal(concurrentWriteStrength(parseConcurrentWriteStamps(stamps)![0]!), 'unknown');
  assert.match(describeConcurrentWrite(parseConcurrentWriteStamps(stamps)![0]!), /COULD NOT TELL/);

  // And the same delivery with a listing it COULD take, meeting nobody, still
  // says nothing — the silence has to stay meaningful.
  assert.equal(
    detectConcurrentWrites(
      { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'shared', changedPaths: ['src/z.ts'] },
      [neighbour],
    ),
    null,
  );
});

test('a neighbour that could not list ITS changes is not intersected against nothing', () => {
  // The mirror of the case above, and the one hole 4 creates on purpose: a
  // shared host delivery closes truncated because no before-snapshot of the
  // tree survives between `dispatch-start` and its terminal receipt. Its
  // window carries an empty set, and a neighbour intersecting against it must
  // read that as "unknown", never as "we did not meet".
  const stamps = detectConcurrentWrites(
    { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'isolated', changedPaths: ['src/a.ts'] },
    [{ dispatchId: 'host', runId: 'r1', kind: 'host-dispatch', workspaceMode: 'shared', startedAt: '2026-09-06T10:00:00Z', endedAt: '2026-09-06T10:10:00Z', changedPaths: [], truncated: true }],
  );
  assert.ok(stamps != null, 'an unenumerable neighbour is a blind spot, not a clean bill of health');
  assert.equal(stamps![0]!.dispatch_id, 'host');
  assert.equal(stamps![0]!.degraded, true);
  assert.match(stamps![0]!.note, /"host" could not enumerate/);
});

test('an unreadable window log is recorded on the receipt, not swallowed', () => {
  // The log could not be read, so `readDispatchWindows` hands back zero
  // windows and `degraded: true`. Zero windows produced zero stamps, and a
  // receipt with no stamp is exactly what a delivery that was genuinely alone
  // writes — the strongest evidence of a blind spot rendered as the emptiest
  // possible record.
  const stamps = detectConcurrentWrites(
    { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'shared', changedPaths: ['src/a.ts'] },
    [],
    { logDegraded: true },
  );
  assert.ok(stamps != null, '"I could not tell" must never be spelled like "nothing happened"');
  assert.equal(stamps!.length, 1);
  assert.equal(stamps![0]!.dispatch_id, UNREADABLE_WINDOW_LOG_ID);
  assert.equal(stamps![0]!.degraded, true);
  assert.equal(stamps![0]!.kind, undefined, 'it names no window, so it claims nothing about one');
  assert.equal(stamps![0]!.attribution, undefined);

  const record = parseConcurrentWriteStamps(stamps)![0]!;
  assert.equal(concurrentWriteStrength(record), 'unknown', 'never counted as a delivery that wrote');
  assert.match(describeConcurrentWrite(record), /WINDOW LOG UNREADABLE/);
  assert.doesNotMatch(describeConcurrentWrite(record), /\(window l/, 'the sentinel id is never rendered as a short id');

  // A readable log that found nothing still says nothing.
  assert.equal(
    detectConcurrentWrites(
      { dispatchId: 'mine', startedAt: '2026-09-06T10:05:00Z', endedAt: '2026-09-06T10:15:00Z', workspaceMode: 'shared', changedPaths: ['src/a.ts'] },
      [],
    ),
    null,
  );
});

test('a duplicate close merges rather than erasing the first listing', (t) => {
  // An idempotent terminal receipt closes the window a second time, with
  // nothing to report. Under "last close wins" that second row replaced a
  // complete, attributable listing with an empty one, and every neighbour
  // then intersected against nothing.
  const root = tempRepo(t);
  openDispatchWindow(root, { dispatchId: 'd1', kind: 'ad-hoc', workspaceMode: 'isolated', startedAt: new Date('2026-09-06T10:00:00Z') });
  closeDispatchWindow(root, { dispatchId: 'd1', changedPaths: ['src/a.ts'], endedAt: new Date('2026-09-06T10:05:00Z') });
  closeDispatchWindow(root, { dispatchId: 'd1', changedPaths: [], truncated: true, endedAt: new Date('2026-09-06T10:06:00Z') });

  const window = readDispatchWindows(root).windows[0]!;
  assert.deepEqual(window.changedPaths, ['src/a.ts'], 'what was known stays known');
  assert.equal(window.truncated, true, 'and the second close\'s uncertainty is carried, not dropped');
  assert.equal(window.endedAt, '2026-09-06T10:06:00.000Z', 'the interval still ends at the latest close');
});

test('a window over the path budget is truncated, never silently trimmed to clean', (t) => {
  const root = tempRepo(t);
  openDispatchWindow(root, { dispatchId: 'big', kind: 'ad-hoc', workspaceMode: 'shared' });
  const many = Array.from({ length: WINDOW_MAX_PATHS + 25 }, (_, i) => `src/f${String(i).padStart(6, '0')}.ts`);
  closeDispatchWindow(root, { dispatchId: 'big', changedPaths: many });
  const read = readDispatchWindows(root);
  assert.equal(read.windows[0]!.changedPaths!.length, WINDOW_MAX_PATHS);
  assert.equal(read.windows[0]!.truncated, true, 'the cap must be visible, or a partial set reads as a complete one');
});

test('workspaceStatusMap and changedBetween see real edits, and null is not "clean"', (t) => {
  const root = tempRepo(t);
  seedRepo(root);
  const before = workspaceStatusMap(root);
  assert.ok(before != null);
  writeFileSync(join(root, 'a.txt'), 'a changed\n');
  writeFileSync(join(root, 'new.txt'), 'new\n');
  const after = workspaceStatusMap(root);
  const changed = changedBetween(before, after);
  assert.ok(changed!.includes('a.txt'), 'a tracked modification is in the delta');
  assert.ok(changed!.includes('new.txt'), 'so is an untracked addition');
  assert.ok(!changed!.includes('b.txt'), 'an untouched file is not');

  assert.equal(changedBetween(null, after), null, 'an unreadable snapshot yields null, never an empty set');
  assert.equal(changedBetween(before, null), null);
});

test('diffChangedPaths reads a collected diff without needing its worktree', (t) => {
  const root = tempRepo(t);
  seedRepo(root);
  writeFileSync(join(root, 'a.txt'), 'a changed\n');
  const patch = execFileSync('git', ['-C', root, 'diff', '--binary'], { encoding: 'buffer' });
  const diffAbs = join(root, 'work.diff');
  writeFileSync(diffAbs, patch);
  assert.deepEqual(diffChangedPaths(root, diffAbs), ['a.txt']);
  assert.equal(diffChangedPaths(root, join(root, 'missing.diff')), null, 'a patch that cannot be read is unknown, not empty');
});

test('the leftover lease file is reported as vestigial and safe to delete', (t) => {
  const root = tempRepo(t);
  assert.equal(describeVestigialWorkspaceLease(root), null, 'a repo that never had one says nothing');

  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, WORKSPACE_LEASE_FILE), JSON.stringify({
    workspace_mode: 'shared',
    holder: { id: 'abandoned-host-dispatch', kind: 'host-dispatch', runId: 'r1', dispatchId: 'd1' },
    // The shape that made the old lease immortal: no pid to disprove.
    supervisor_pid: null,
    executor_pid: null,
    process_group_id: null,
    started_at: '2026-09-05T10:00:00.000Z',
    heartbeat_at: '2026-09-05T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');
  mkdirSync(join(root, WORKSPACE_LEASE_LOCK), { recursive: true });

  const described = describeVestigialWorkspaceLease(root)!;
  assert.ok(described != null);
  assert.deepEqual(described.paths, [WORKSPACE_LEASE_FILE, WORKSPACE_LEASE_LOCK]);
  assert.equal(described.holder!.id, 'abandoned-host-dispatch');
  assert.match(described.detail, /nothing reads this file/);
  // The remediation must NOT hedge. The old one said "only after verifying no
  // writer remains", which was right about a lock and is what leaves a wedged
  // repo wedged once nothing reads the file.
  assert.doesNotMatch(described.remediation, /only after verifying/i);
  assert.match(described.remediation, /safe with work in flight/);

  const doctor = runDoctor({ repoRoot: root });
  const finding = doctor.findings.find((f) => f.check === 'workspace-lease')!;
  assert.ok(finding != null, 'doctor must still surface it');
  assert.equal(finding.severity, 'warning');
  assert.doesNotMatch(finding.remediation ?? '', /dispatch-fail/, 'a vestigial file is not an abandoned dispatch to recover');
});

test('a repo with no lease file gets an ok finding, not silence', (t) => {
  const root = tempRepo(t);
  const doctor = runDoctor({ repoRoot: root });
  const finding = doctor.findings.find((f) => f.check === 'workspace-lease')!;
  assert.equal(finding.severity, 'ok');
  assert.match(finding.detail, /no longer takes one/);
});

test('an unparsable leftover record is reported rather than hidden', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, WORKSPACE_LEASE_FILE), '{not json', 'utf8');
  const described = describeVestigialWorkspaceLease(root)!;
  assert.equal(described.unreadable, true);
  assert.equal(described.holder, null);
  assert.match(described.detail, /no longer parses/);
  assert.ok(readFileSync(join(root, WORKSPACE_LEASE_FILE), 'utf8').length > 0, 'describing must never delete');
});

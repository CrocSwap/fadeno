import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tempRepo } from './helpers.ts';
import {
  ADHOC_HOST_SCOPE,
  adhocHostTerminalState,
  adhocScopeIsUnreachableByRuns,
  DispatchAdhocError,
  findAdhocHostDispatch,
  isAdhocHostRequest,
  runDispatchClose,
  runDispatchOpen,
} from '../src/commands/dispatch-adhoc.ts';
import { runDispatches } from '../src/commands/dispatches.ts';
import { runVerify, VerifyError } from '../src/commands/verify.ts';
import { hostWorktreePath, readHostWorkspaceState } from '../src/lib/host-workspace.ts';
import { closeDispatchWindow, openDispatchWindow, readDispatchWindows } from '../src/lib/workspace-overlap.ts';

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
  const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
  if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${s.stderr ?? s.error}`);
}

function seedRepo(t: import('node:test').TestContext): string {
  const root = tempRepo(t);
  git(root, ['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, '.fadeno', 'dispatches.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('adhoc scope can never collide with a run id', () => {
  assert.equal(adhocScopeIsUnreachableByRuns(), true);
  // `runNewRun` builds `YYYY-MM-DD-HHMM-slug`; the scope must not look like one.
  assert.equal(/^\d{4}-\d{2}-\d{2}-/.test(ADHOC_HOST_SCOPE), false);
});

test('the terminal vocabulary is the writer\'s, and only the receipt is terminal', () => {
  assert.equal(adhocHostTerminalState('adhoc_host_dispatch_closed'), 'closed');
  assert.equal(adhocHostTerminalState('adhoc_host_dispatch_requested'), null);
  assert.equal(adhocHostTerminalState('dispatch_completed'), null);
  assert.equal(adhocHostTerminalState(null), null);
  assert.equal(isAdhocHostRequest('adhoc_host_dispatch_requested'), true);
  assert.equal(isAdhocHostRequest('dispatch_requested'), false);
});

test('dispatch-open prepares an isolated worktree and records a request row', (t) => {
  const root = seedRepo(t);
  // The caller's uncommitted state must reach the worktree, exactly as the
  // engine's host lane replays it.
  writeFileSync(join(root, 'dirty.txt'), 'uncommitted\n');
  const opened = runDispatchOpen({ repoRoot: root, archetype: 'worker', tag: 'lane-a', note: 'ad-hoc side quest' });

  assert.equal(opened.workspace, hostWorktreePath(ADHOC_HOST_SCOPE, opened.dispatchId));
  assert.ok(existsSync(opened.workspaceAbs));
  assert.ok(/^[0-9a-f]{40}$/.test(opened.baseCommit));
  assert.equal(opened.tag, 'lane-a');
  // The caller's dirty file is present in the worktree, not just tracked HEAD.
  assert.equal(readFileSync(join(opened.workspaceAbs, 'dirty.txt'), 'utf8'), 'uncommitted\n');

  const state = readHostWorkspaceState(root, ADHOC_HOST_SCOPE, opened.dispatchId);
  assert.ok(state != null);
  assert.equal(state!.workspace_mode, 'isolated');

  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'adhoc_host_dispatch_requested');
  assert.equal(rows[0]!.dispatch_id, opened.dispatchId);
  assert.equal(rows[0]!.workspace_mode, 'isolated');
  assert.equal(rows[0]!.adapter, 'host');
  assert.equal(rows[0]!.note, 'ad-hoc side quest');

  // The overlap window is open for the whole time the agent could be writing.
  const windows = readDispatchWindows(root).windows;
  const mine = windows.find((w) => w.dispatchId === opened.dispatchId);
  assert.ok(mine != null);
  assert.equal(mine!.kind, 'host-dispatch');
  assert.equal(mine!.workspaceMode, 'isolated');
  assert.equal(mine!.endedAt, null);
});

test('an ad-hoc host dispatch is READ by fadeno dispatches, never counted as damage', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, archetype: 'worker', tag: 'readable' });
  writeFileSync(join(opened.workspaceAbs, 'agent.txt'), 'agent work\n');
  runDispatchClose({ repoRoot: root, dispatchId: opened.dispatchId });

  const listed = runDispatches({ repoRoot: root });
  // The regression this guards: an unhandled event kind is counted as an
  // unreadable row, so an intact log reports damage.
  assert.equal(listed.skipped, 0);
  assert.equal(listed.skippedNewerFormat, 0);
  // Both rows fold into ONE logical entry, like a command dispatch's pair.
  assert.equal(listed.total, 1);
  const entry = listed.entries[0]!;
  assert.equal(entry.kind, 'adhoc-host');
  assert.equal(entry.dispatchId, opened.dispatchId);
  assert.equal(entry.completed, true);
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.archetype, 'worker');
  const line = listed.lines[0]!;
  assert.match(line, /\[adhoc-host\]/);
  assert.match(line, /closed by the host \(ok\)/);
  // Never the command lane's process language: nothing was spawned here.
  assert.doesNotMatch(line, /exit /);
});

test('an open ad-hoc host dispatch renders as OPEN, not as killed-or-in-flight', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'still-going' });
  const listed = runDispatches({ repoRoot: root });
  assert.equal(listed.skipped, 0);
  const line = listed.lines[0]!;
  assert.match(line, /OPEN — no terminal receipt yet/);
  assert.match(line, /fadeno dispatch-close/);
  assert.doesNotMatch(line, /killed or in flight/);
  assert.equal(listed.entries[0]!.completed, false);
  assert.equal(listed.entries[0]!.workspace, hostWorktreePath(ADHOC_HOST_SCOPE, opened.dispatchId));
});

test('dispatch-close merges the agent diff back and tears the worktree down', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'merge-me' });
  writeFileSync(join(opened.workspaceAbs, 'agent.txt'), 'agent work\n');
  writeFileSync(join(opened.workspaceAbs, 'base.txt'), 'base\nedited\n');

  const closed = runDispatchClose({ repoRoot: root, dispatchId: opened.dispatchId.slice(0, 8) });
  assert.equal(closed.outcome, 'ok');
  assert.equal(closed.resolvedBy, 'prefix');
  assert.ok(closed.diffBytes != null && closed.diffBytes > 0);
  assert.equal(closed.merge?.status, 'clean');
  assert.equal(closed.workspaceRemoved, true);
  assert.equal(closed.workspaceRetained, null);

  // The work is in the caller's tree.
  assert.equal(readFileSync(join(root, 'agent.txt'), 'utf8'), 'agent work\n');
  assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'base\nedited\n');
  assert.equal(existsSync(opened.workspaceAbs), false);

  // The window is closed with this delivery's own path set.
  const mine = readDispatchWindows(root).windows.find((w) => w.dispatchId === opened.dispatchId)!;
  assert.notEqual(mine.endedAt, null);
  assert.deepEqual(mine.changedPaths, ['agent.txt', 'base.txt']);

  const receipt = evidenceRows(root).at(-1)!;
  assert.equal(receipt.event, 'adhoc_host_dispatch_closed');
  assert.equal(receipt.outcome, 'ok');
  assert.equal(receipt.workspace_removed, true);
  assert.equal((receipt.primary_merge as Record<string, unknown>).status, 'clean');
  assert.ok(typeof receipt.diff_snapshot === 'string');
});

test('dispatch-close --reason records a FAILED receipt, merges nothing, retains the tree', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'failed-lane' });
  writeFileSync(join(opened.workspaceAbs, 'half.txt'), 'half-done\n');

  const closed = runDispatchClose({ repoRoot: root, tag: 'failed-lane', reason: 'the agent hit a 429' });
  assert.equal(closed.outcome, 'failed');
  assert.equal(closed.resolvedBy, 'tag');
  assert.equal(closed.merge, null);
  assert.equal(closed.workspaceRemoved, false);
  assert.equal(closed.workspaceRetained, opened.workspace);
  // Nothing landed in the caller's tree.
  assert.equal(existsSync(join(root, 'half.txt')), false);
  // But the evidence survives, in the worktree and as a durable diff.
  assert.ok(existsSync(opened.workspaceAbs));
  assert.ok(closed.diffSnapshot != null);
  assert.ok(existsSync(resolve(root, closed.diffSnapshot!)));

  const listed = runDispatches({ repoRoot: root });
  assert.equal(listed.skipped, 0);
  assert.equal(listed.entries[0]!.outcome, 'failed');
  assert.match(listed.lines[0]!, /FAILED/);
  assert.match(listed.lines[0]!, /the agent hit a 429/);
});

test('dispatch-close --no-merge keeps the diff for the operator to apply', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root });
  writeFileSync(join(opened.workspaceAbs, 'held.txt'), 'not yours yet\n');

  const closed = runDispatchClose({ repoRoot: root, dispatchId: opened.dispatchId, noMerge: true });
  assert.equal(closed.outcome, 'ok');
  assert.equal(closed.merge, null);
  assert.equal(existsSync(join(root, 'held.txt')), false);
  assert.equal(closed.workspaceRetained, opened.workspace);
  assert.ok(closed.diffBytes != null && closed.diffBytes > 0);
});

test('a repeated close replays its receipt; a different one is refused', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'once' });
  runDispatchClose({ repoRoot: root, tag: 'once', reason: 'gave up' });
  const before = evidenceRows(root).length;

  const again = runDispatchClose({ repoRoot: root, tag: 'once', reason: 'gave up' });
  assert.equal(again.idempotent, true);
  assert.equal(evidenceRows(root).length, before);

  assert.throws(
    () => runDispatchClose({ repoRoot: root, dispatchId: opened.dispatchId, reason: 'a different story' }),
    (err: unknown) => {
      assert.ok(err instanceof DispatchAdhocError);
      assert.match((err as Error).message, /already has a terminal receipt/);
      return true;
    },
  );
});

test('an overlapping delivery is stamped concurrent_write on the receipt', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root });
  writeFileSync(join(opened.workspaceAbs, 'base.txt'), 'base\nfrom the host agent\n');
  // A sibling delivery that wrote the same path while this one was open.
  openDispatchWindow(root, {
    dispatchId: 'sibling-0001',
    kind: 'ad-hoc',
    workspaceMode: 'isolated',
    startedAt: new Date(Date.now() - 1000),
  });
  // Its close records the path set that this dispatch's close will intersect.
  closeDispatchWindow(root, { dispatchId: 'sibling-0001', changedPaths: ['base.txt'] });

  const closed = runDispatchClose({ repoRoot: root, dispatchId: opened.dispatchId });
  assert.ok(closed.concurrentWrites != null);
  assert.equal(closed.concurrentWrites!.length, 1);
  assert.equal(closed.concurrentWrites![0]!.dispatch_id, 'sibling-0001');
  assert.deepEqual(closed.concurrentWrites![0]!.paths, ['base.txt']);
  const receipt = evidenceRows(root).at(-1)!;
  assert.ok(Array.isArray(receipt.concurrent_write));
});

test('close refuses a name it cannot resolve, and says how to name one', (t) => {
  const root = seedRepo(t);
  assert.throws(
    () => runDispatchClose({ repoRoot: root, dispatchId: 'abc' }),
    (err: unknown) => {
      assert.ok(err instanceof DispatchAdhocError);
      assert.match((err as Error).message, /too short/);
      return true;
    },
  );
  assert.throws(
    () => runDispatchClose({ repoRoot: root, dispatchId: 'last' }),
    (err: unknown) => {
      assert.match((err as Error).message, /no ad-hoc host dispatch is open/);
      return true;
    },
  );
});

/**
 * The evidence behind keeping `dispatch-prepare --isolate` REQUIRED.
 *
 * The flag is not a mode selector with one value filled in — there is no
 * second preparation mode to select. `HostWorkspaceState.workspace_mode` is
 * the literal `'isolated'`, and `readHostWorkspaceState` REFUSES a state file
 * that says anything else, so a hypothetical `--shared` prepare could not even
 * record what it had done. A shared host delivery needs no preparation at all:
 * `startHostDispatch` decides `isIsolated` purely from whether a state file
 * exists, and its absence IS the shared mode.
 */
test('there is no preparation mode but isolated — the state reader refuses any other', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root });
  const statePath = join(root, '.fadeno', 'local', 'host-workspaces', ADHOC_HOST_SCOPE, `${opened.dispatchId}.json`);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  assert.equal(state.workspace_mode, 'isolated');
  writeFileSync(statePath, JSON.stringify({ ...state, workspace_mode: 'shared' }, null, 2));
  assert.throws(
    () => readHostWorkspaceState(root, ADHOC_HOST_SCOPE, opened.dispatchId),
    /invalid workspace_mode/,
  );
});

test('fadeno verify says something true when handed an ad-hoc host dispatch id', (t) => {
  const root = seedRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'audit-me' });

  assert.equal(findAdhocHostDispatch(root, opened.dispatchId)?.dispatchId, opened.dispatchId);
  assert.equal(findAdhocHostDispatch(root, opened.dispatchId.slice(0, 8))?.dispatchId, opened.dispatchId);

  assert.throws(
    () => runVerify({ repoRoot: root, cwd: root, run: opened.dispatchId }),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      const message = (err as Error).message;
      // Not "No run matching": that reads as "your evidence is gone".
      assert.match(message, /is an ad-hoc host dispatch/);
      assert.match(message, /still open/);
      assert.match(message, /no run ledger/);
      assert.match(message, /\.fadeno\/dispatches\.jsonl/);
      assert.match(message, /tag: audit-me/);
      return true;
    },
  );

  // A genuinely unknown id still gets the ordinary run-lookup error.
  assert.throws(
    () => runVerify({ repoRoot: root, cwd: root, run: 'not-a-dispatch-or-run' }),
    (err: unknown) => {
      assert.doesNotMatch((err as Error).message, /ad-hoc host dispatch/);
      return true;
    },
  );

  runDispatchClose({ repoRoot: root, dispatchId: opened.dispatchId, reason: 'abandoned' });
  assert.throws(
    () => runVerify({ repoRoot: root, cwd: root, run: opened.dispatchId }),
    (err: unknown) => {
      assert.match((err as Error).message, /closed \(failed: abandoned\)/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Gitignored output on the host lane
// ---------------------------------------------------------------------------
//
// The command lane at least RECORDED the loss (`ignored_output_discarded`);
// this lane did not look at all, and an absent stamp from a lane that never
// looked is byte for byte an absent stamp from a lane that looked and found
// nothing. Fadeno steers work toward the host lane, so this is where a
// gitignored deliverable was quietest.

/** A seeded repo carrying the field report's own ignore rule, `data*` + slash. */
function seedIgnoringRepo(t: import('node:test').TestContext): string {
  const root = seedRepo(t);
  writeFileSync(join(root, '.gitignore'), 'data*/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'ignore data']);
  return root;
}

test('dispatch-close keeps a merged worktree that still holds gitignored output, and says so', (t) => {
  const root = seedIgnoringRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'host-research' });
  // The host agent writes a tracked file and a gitignored deliverable.
  writeFileSync(join(opened.workspaceAbs, 'base.txt'), 'base\nedited\n');
  spawnSync('mkdir', ['-p', join(opened.workspaceAbs, 'data', 'research')]);
  writeFileSync(join(opened.workspaceAbs, 'data', 'research', 'findings.md'), 'the deliverable\n');

  const echoes: string[] = [];
  const closed = runDispatchClose({ repoRoot: root, tag: 'host-research', onEcho: (l) => echoes.push(l) });
  assert.equal(closed.merge?.status, 'clean');
  // The tracked edit landed; the ignored tree could not and never could.
  assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'base\nedited\n');
  assert.equal(existsSync(join(root, 'data')), false);

  // Before this the worktree went here, with the deliverable in it and no
  // field on the receipt naming it.
  assert.equal(closed.workspaceRemoved, false, 'the teardown is refused while the directory is the only copy');
  assert.equal(closed.workspaceRetained, opened.workspace);
  assert.ok(closed.ignoredOutput != null, 'the close must report what kept the worktree alive');
  assert.deepEqual(closed.ignoredOutput!.paths, ['data/']);
  assert.equal(closed.ignoredOutput!.retained_at, opened.workspace);
  assert.equal(
    readFileSync(join(opened.workspaceAbs, 'data', 'research', 'findings.md'), 'utf8'),
    'the deliverable\n',
  );

  const receipt = evidenceRows(root).at(-1)!;
  assert.equal(receipt.workspace_removed, false);
  assert.equal(receipt.workspace_retained, true);
  assert.equal(receipt.workspace, opened.workspace);
  // Same field name and same wire shape as the command lane's, so every
  // reader picks it up without knowing which lane wrote it.
  const stamp = receipt.ignored_output_discarded as { paths: string[]; retained_at?: string };
  assert.deepEqual(stamp.paths, ['data/']);
  assert.equal(stamp.retained_at, opened.workspace);
  assert.ok(echoes.some((l) => l.startsWith('gitignored output KEPT')), echoes.join('\n'));
});

test('dispatch-close with nothing ignored still tears the worktree down and stamps nothing', (t) => {
  const root = seedIgnoringRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'host-plain' });
  writeFileSync(join(opened.workspaceAbs, 'base.txt'), 'base\nedited\n');
  const closed = runDispatchClose({ repoRoot: root, tag: 'host-plain' });
  assert.equal(closed.workspaceRemoved, true);
  assert.equal(closed.ignoredOutput, null);
  assert.equal(existsSync(opened.workspaceAbs), false);
  assert.equal(evidenceRows(root).at(-1)!.ignored_output_discarded, undefined);
});

test('a --no-merge close names the gitignored content in the tree it hands back', (t) => {
  // Nothing is torn down here, so nothing is lost — but the operator holding
  // the worktree still needs to know which of the things in it will never
  // reach their tree by patch.
  const root = seedIgnoringRepo(t);
  const opened = runDispatchOpen({ repoRoot: root, tag: 'host-hold' });
  writeFileSync(join(opened.workspaceAbs, 'base.txt'), 'base\nedited\n');
  spawnSync('mkdir', ['-p', join(opened.workspaceAbs, 'data')]);
  writeFileSync(join(opened.workspaceAbs, 'data', 'notes.md'), 'notes\n');

  const closed = runDispatchClose({ repoRoot: root, tag: 'host-hold', noMerge: true });
  assert.equal(closed.merge, null);
  assert.equal(closed.workspaceRetained, opened.workspace);
  assert.deepEqual(closed.ignoredOutput?.paths, ['data/']);
  assert.equal((evidenceRows(root).at(-1)!.ignored_output_discarded as { paths: string[] }).paths[0], 'data/');
});

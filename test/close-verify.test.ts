import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDispatchClose, DispatchesError, renderWorkMeasured, runDispatchShow, renderDispatchDetail } from '../src/commands/dispatches.ts';
import { recordStopped } from '../src/lib/spawn.ts';
import { appendRow, readDispatches } from '../src/lib/ledger.ts';
import { cutWorktree, measureWork, verifyMerged } from '../src/lib/worktree.ts';
import { catalogV4, git, gitRepo } from './helpers.ts';

/**
 * The measured half of a dispatch, and the one close verb that can be checked.
 *
 * A director running a day of dispatches closed two before checking the merge
 * result and committed conflict markers once, and named the fifteen seconds
 * between merging and closing as where its mistakes lived. Everything here is
 * that tripwire: facts git already knows, taken without asking the agent.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const ID = '11111111-2222-3333-4444-555555555555';

function cli(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** A repo with one dispatch that cut a worktree, opened in the ledger. */
function dispatched(t: TestContext, name = 'fix-login'): { root: string; worktree: string; branch: string } {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({ archetypes: { worker: {} } }));
  const cut = cutWorktree({ repoRoot: root, name });
  assert.ok(cut.ok, cut.ok ? '' : cut.reason);
  const wt = cut.worktree;
  appendRow(root, {
    row: 'opened', id: ID, name, at: new Date().toISOString(), session: null, parent: null, archetype: 'worker',
    model: 'sol', effort: null, explicit_model: null, lane: 'command', harness: 'codex',
    workspace: { path: wt.path, branch: wt.branch, base: wt.base }, task: 'x', prompt: 'p',
  });
  return { root, worktree: wt.absolute, branch: wt.branch };
}

/** Commit `text` to `file` inside the worktree. */
function commitInWorktree(worktree: string, file: string, text: string, message: string): void {
  writeFileSync(join(worktree, file), text);
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-q', '-m', message]);
}

test('measureWork counts what git knows: commits HEAD lacks, the merge-base diffstat, and markers the branch committed', (t) => {
  const { root, worktree, branch } = dispatched(t);
  assert.equal(measureWork({ repoRoot: root, branch: null }), null, 'a shared-tree dispatch has no branch to attribute anything to');

  commitInWorktree(worktree, 'a.txt', 'one\ntwo\nthree\n', 'add a');
  commitInWorktree(worktree, 'b.txt', 'four\n', 'add b');
  const measured = measureWork({ repoRoot: root, branch })!;
  assert.equal(measured.commits, 2);
  assert.equal(measured.files, 2);
  assert.equal(measured.insertions, 4);
  assert.equal(measured.deletions, 0);
  assert.equal(measured.binary, 0);
  assert.deepEqual(measured.conflicts, [], 'a clean branch reports none');
  assert.equal(measured.head, git(root, ['rev-parse', branch]).trim());

  // The failure this catches: markers that reached a commit. A resolution
  // botched in the working tree is the author's problem until they commit it.
  commitInWorktree(worktree, 'c.txt', '<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n', 'oops');
  assert.deepEqual(measureWork({ repoRoot: root, branch })!.conflicts, ['c.txt']);

  // Only paths the branch changed are searched, so a repository whose own
  // files show markers does not report itself as broken.
  writeFileSync(join(root, 'doc.md'), '<<<<<<< example\n>>>>>>> example\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'docs about conflicts']);
  assert.deepEqual(measureWork({ repoRoot: root, branch })!.conflicts, ['c.txt'], 'still only the branch\'s own file');
});

test('measureWork does not credit a worker for the upstream it merged in, as its contract told it to', (t) => {
  const { root, worktree, branch } = dispatched(t);
  commitInWorktree(worktree, 'mine.txt', 'my work\n', 'my change');
  // Meanwhile the repository moves on, and the worker merges it in.
  writeFileSync(join(root, 'theirs.txt'), 'a'.repeat(10) + '\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'someone else']);
  git(worktree, ['merge', '-q', '--no-edit', 'main']);

  const measured = measureWork({ repoRoot: root, branch })!;
  assert.equal(measured.files, 1, 'the diff is against the merge base, so only its own file counts');
  assert.equal(measured.insertions, 1);
});

test('the stop row carries the measurement, and the detail view keeps it apart from what the agent claimed', (t) => {
  const { root, worktree, branch } = dispatched(t);
  commitInWorktree(worktree, 'a.txt', 'one\n', 'add a');
  recordStopped(root, ID, { finalMessage: 'All 316 tests pass. Recommend merge.', cwd: worktree, branch });

  const row = readDispatches(root).records[0]!.stopped!;
  assert.equal(row.work?.commits, 1);
  assert.equal(row.work?.files, 1);

  const rendered = renderDispatchDetail(runDispatchShow({ repoRoot: root, ref: 'fix-login' })).join('\n');
  const measuredAt = rendered.indexOf('--- what Fadeno measured ---');
  const claimedAt = rendered.indexOf('--- what the agent reported (a claim, not a finding) ---');
  assert.ok(measuredAt > 0 && claimedAt > measuredAt, 'the measurement is labelled and comes first');
  assert.match(rendered, /fadeno\/fix-login at [0-9a-f]{12}: 1 commit\(s\) HEAD does not have; 1 file\(s\), \+1 -0/);
  assert.match(rendered, /All 316 tests pass/);

  // The claim and the measurement never merge into one paragraph: a reader
  // must be able to tell which half nobody wrote down.
  assert.ok(rendered.slice(measuredAt, claimedAt).includes('1 commit(s)'));
  assert.ok(!rendered.slice(measuredAt, claimedAt).includes('316 tests'));
});

test('renderWorkMeasured says what it could not measure rather than reporting a clean tree', () => {
  assert.match(renderWorkMeasured(undefined, null).join('\n'), /shared tree.*nothing git can attribute/);
  assert.match(renderWorkMeasured(undefined, 'fadeno/x').join('\n'), /not measured/);
  assert.match(
    renderWorkMeasured({ head: 'abcdef0123456789', commits: 0, files: 0, insertions: 0, deletions: 0, binary: 0, conflicts: [] }, 'fadeno/x').join('\n'),
    /Nothing is on this branch that HEAD lacks/,
  );
  assert.match(
    renderWorkMeasured({ head: 'abcdef0123456789', commits: 1, files: 1, insertions: 2, deletions: 0, binary: 0, conflicts: ['a.ts', 'b.ts'] }, 'fadeno/x').join('\n'),
    /CONFLICT MARKERS committed in 2 path\(s\): a\.ts, b\.ts/,
  );
});

test('verifyMerged answers only what git can settle, and says why when it cannot', (t) => {
  const { root, worktree, branch } = dispatched(t);
  commitInWorktree(worktree, 'a.txt', 'one\n', 'add a');
  assert.equal(verifyMerged({ repoRoot: root, branch }).unmerged, 1);

  git(root, ['merge', '-q', '--no-edit', branch]);
  const after = verifyMerged({ repoRoot: root, branch, worktree });
  assert.equal(after.checked, true);
  assert.equal(after.unmerged, 0);
  assert.deepEqual(after.uncommitted, []);

  // Uncommitted tracked work is work no merge could have taken. Untracked
  // scratch — an unbuilt dependency directory — is not.
  writeFileSync(join(worktree, 'a.txt'), 'edited\n');
  writeFileSync(join(worktree, 'scratch.log'), 'noise\n');
  assert.deepEqual(verifyMerged({ repoRoot: root, branch, worktree }).uncommitted, ['a.txt']);

  const shared = verifyMerged({ repoRoot: root, branch: null });
  assert.equal(shared.checked, false);
  assert.match(shared.reason!, /shared tree/);
  const gone = verifyMerged({ repoRoot: root, branch: 'fadeno/never-existed' });
  assert.equal(gone.checked, false);
  assert.match(gone.reason!, /no longer exists/);
});

test('close --merged is refused while git says the branch is not in HEAD, and --force closes it anyway', (t) => {
  const { root, worktree, branch } = dispatched(t);
  commitInWorktree(worktree, 'a.txt', 'one\n', 'add a');

  assert.throws(
    () => runDispatchClose({ repoRoot: root, ref: 'fix-login', verb: 'merged' }),
    (err: unknown) =>
      err instanceof DispatchesError &&
      /refusing to close fix-login as "merged": fadeno\/fix-login has 1 commit\(s\) that HEAD does not have/.test((err as Error).message) &&
      /git merge fadeno\/fix-login/.test((err as Error).message) &&
      /`--force`/.test((err as Error).message),
  );
  assert.equal(readDispatches(root).records[0]!.closed, null, 'a refused close appends nothing');

  // The other three verbs state the host's intent, and an intent cannot be
  // false — so nothing is checked and nothing is refused.
  const kept = runDispatchClose({ repoRoot: root, ref: 'fix-login', verb: 'kept' });
  assert.equal(kept.merge, null);
  assert.equal(kept.forced, null);
});

test('close --merged passes once the merge is real, and a squash closes with --force and a note', (t) => {
  const { root, worktree, branch } = dispatched(t);
  commitInWorktree(worktree, 'a.txt', 'one\n', 'add a');
  git(root, ['merge', '-q', '--no-edit', branch]);
  const closed = runDispatchClose({ repoRoot: root, ref: 'fix-login', verb: 'merged' });
  assert.equal(closed.merge?.checked, true);
  assert.equal(closed.merge?.unmerged, 0);
  assert.equal(closed.forced, null);

  // Closing the same dispatch again is a replay, and a replay must not be
  // re-litigated: an idempotent command that fails on its second run is not one.
  const replay = runDispatchClose({ repoRoot: root, ref: 'fix-login', verb: 'merged' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.merge, null, 'the decision was already recorded; there is nothing left to check');
});

test('uncommitted tracked work in the worktree refuses --merged too, and --force records what it closed over', (t) => {
  const { root, worktree, branch } = dispatched(t);
  commitInWorktree(worktree, 'a.txt', 'one\n', 'add a');
  git(root, ['merge', '-q', '--no-edit', branch]);
  writeFileSync(join(worktree, 'a.txt'), 'never committed\n');

  assert.throws(
    () => runDispatchClose({ repoRoot: root, ref: 'fix-login', verb: 'merged' }),
    (err: unknown) => err instanceof DispatchesError && /1 uncommitted tracked path\(s\) \(a\.txt\), which no merge could have taken/.test((err as Error).message),
  );
  const forced = runDispatchClose({ repoRoot: root, ref: 'fix-login', verb: 'merged', force: true });
  assert.equal(forced.replayed, false);
  assert.match(forced.forced!, /uncommitted tracked path/);
  assert.equal(readDispatches(root).records[0]!.closed?.verb, 'merged');
});

test('through the CLI: the refusal is the exit code, and --force says on stderr what it overrode', (t) => {
  const { root, worktree } = dispatched(t);
  commitInWorktree(worktree, 'a.txt', 'one\n', 'add a');

  const refused = cli(root, ['dispatch-close', 'fix-login', '--merged']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to close fix-login as "merged"/);

  const forced = cli(root, ['dispatch-close', 'fix-login', '--merged', '--force', '--note', 'squashed into 9a1b2c3']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /--force: closed anyway over the check/);
  assert.match(forced.stdout, /fix-login closed: merged; branch fadeno\/fix-login kept/);
  assert.equal(readDispatches(root).records[0]!.closed?.note, 'squashed into 9a1b2c3');
});

test('a shared-tree dispatch closes --merged unchecked, and the CLI says it was not verified', (t) => {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({ archetypes: { worker: {} } }));
  appendRow(root, {
    row: 'opened', id: ID, name: 'in-place', at: new Date().toISOString(), session: null, parent: null, archetype: 'worker',
    model: 'sol', effort: null, explicit_model: null, lane: 'command', harness: 'codex',
    workspace: { path: '.', branch: null, base: 'abc' }, task: 'x', prompt: 'p',
  });
  const result = cli(root, ['dispatch-close', 'in-place', '--merged']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\(not verified: the dispatch worked in the shared tree, so it has no branch to look for\)/);
});

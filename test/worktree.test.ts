import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  BRANCH_NAME_MAX,
  WORKTREES_DIR,
  cutWorktree,
  dirtyPaths,
  existingFadenoBranches,
  isRegisteredWorktree,
  listRegisteredWorktrees,
  removeWorktree,
  reportWorktrees,
  sanitizeName,
  trackedDirtyPaths,
  uniqueName,
} from '../src/lib/worktree.ts';
import { git, gitRepo, tempRepo } from './helpers.ts';

test('sanitizeName is deliberately dumb: lowercase, one dash per run, trimmed to 60', () => {
  assert.equal(sanitizeName('Fix Login  Bug!!'), 'fix-login-bug');
  assert.equal(sanitizeName('  --weird..name--  '), 'weird..name');
  assert.equal(sanitizeName('émoji 🎉 name'), 'moji-name');
  assert.equal(sanitizeName(''), 'dispatch');
  assert.equal(sanitizeName('!!!'), 'dispatch');
  const long = sanitizeName('a'.repeat(100));
  assert.equal(long.length, BRANCH_NAME_MAX);
  assert.ok(!sanitizeName('x'.repeat(59) + '-yyy').endsWith('-'), 'a trim never leaves a trailing dash');
});

test('uniqueName appends a counter, and a collision the trim creates is just another collision', () => {
  const taken = new Set(['worker-a1b2', 'worker-a1b2-2']);
  assert.equal(uniqueName('worker-a1b2', taken), 'worker-a1b2-3');
  assert.equal(uniqueName('fresh', taken), 'fresh');
});

test('cutWorktree cuts from HEAD onto fadeno/<name>, records the base commit, and leaves the caller\'s dirty tree alone', (t) => {
  const root = gitRepo(t);
  writeFileSync(join(root, 'wip.txt'), 'uncommitted\n');
  git(root, ['add', 'wip.txt']);
  const cut = cutWorktree({ repoRoot: root, name: 'fix-login' });
  assert.ok(cut.ok, cut.ok ? '' : cut.reason);
  const wt = cut.ok ? cut.worktree : null!;
  assert.equal(wt.branch, 'fadeno/fix-login');
  assert.equal(wt.path, join(WORKTREES_DIR, 'fix-login'));
  assert.equal(wt.base, git(root, ['rev-parse', 'HEAD']).trim());
  assert.equal(wt.upstream, 'main', 'a worker is told which branch to merge from');
  assert.ok(existsSync(join(wt.absolute, 'base.txt')));
  assert.ok(!existsSync(join(wt.absolute, 'wip.txt')), 'uncommitted work is never replayed into the cut');
  assert.deepEqual(trackedDirtyPaths(root), ['wip.txt'], 'and the caller\'s tree still holds it');
  assert.ok(existingFadenoBranches(root).has('fix-login'));
});

test('cutWorktree from a named ref records that ref as upstream', (t) => {
  const root = gitRepo(t);
  git(root, ['branch', 'release']);
  const cut = cutWorktree({ repoRoot: root, name: 'hotfix', from: 'release' });
  assert.ok(cut.ok && cut.worktree.upstream === 'release');
});

test('an unknown ref, a non-git directory, and an occupied path each fail with a reason instead of throwing', (t) => {
  const root = gitRepo(t);
  const bad = cutWorktree({ repoRoot: root, name: 'x', from: 'no-such-ref' });
  assert.ok(!bad.ok && /not a commit/.test(bad.reason));
  const plain = tempRepo(t);
  const notGit = cutWorktree({ repoRoot: plain, name: 'x' });
  assert.ok(!notGit.ok);
  mkdirSync(join(root, WORKTREES_DIR, 'taken'), { recursive: true });
  const occupied = cutWorktree({ repoRoot: root, name: 'taken' });
  assert.ok(!occupied.ok && /already exists/.test(occupied.reason));
});

test('two cuts never collide and consult no shared state', (t) => {
  const root = gitRepo(t);
  const a = cutWorktree({ repoRoot: root, name: 'one' });
  const b = cutWorktree({ repoRoot: root, name: 'two' });
  assert.ok(a.ok && b.ok);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'lock')));
  const listed = listRegisteredWorktrees(root).map((w) => w.branch).sort();
  assert.deepEqual(listed, ['fadeno/one', 'fadeno/two']);
});

test('reportWorktrees names uncommitted paths and unmerged commits, and never calls an unreadable tree clean', (t) => {
  const root = gitRepo(t);
  const cut = cutWorktree({ repoRoot: root, name: 'work' });
  assert.ok(cut.ok);
  const wt = cut.ok ? cut.worktree : null!;
  writeFileSync(join(wt.absolute, 'new.txt'), 'x\n');
  let [report] = reportWorktrees(root);
  assert.deepEqual(report!.dirty, { paths: ['new.txt'], truncated: false });
  assert.equal(report!.unmerged, 0);
  git(wt.absolute, ['add', '-A']);
  git(wt.absolute, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'work']);
  [report] = reportWorktrees(root);
  assert.deepEqual(report!.dirty, { paths: [], truncated: false });
  assert.equal(report!.unmerged, 1, 'one commit HEAD does not have');
  // Directory gone but registration still there: the report says it cannot read it.
  git(root, ['worktree', 'remove', '--force', wt.absolute]);
  git(root, ['worktree', 'prune']);
  assert.deepEqual(reportWorktrees(root), []);
});

test('removeWorktree refuses a tree with uncommitted work, refuses a plain directory, and removes a clean registered tree', (t) => {
  const root = gitRepo(t);
  const cut = cutWorktree({ repoRoot: root, name: 'rm' });
  assert.ok(cut.ok);
  const wt = cut.ok ? cut.worktree : null!;
  writeFileSync(join(wt.absolute, 'keep.txt'), 'do not lose me\n');
  const refused = removeWorktree({ repoRoot: root, absolute: wt.absolute });
  assert.ok(!refused.ok && /uncommitted path/.test(refused.reason));
  assert.ok(existsSync(join(wt.absolute, 'keep.txt')), 'nothing was destroyed');
  const plain = join(root, WORKTREES_DIR, 'plain');
  mkdirSync(plain, { recursive: true });
  const notRegistered = removeWorktree({ repoRoot: root, absolute: plain });
  assert.ok(!notRegistered.ok && /not a registered worktree/.test(notRegistered.reason));
  assert.ok(existsSync(plain));
  git(wt.absolute, ['add', '-A']);
  git(wt.absolute, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'keep']);
  const removed = removeWorktree({ repoRoot: root, absolute: wt.absolute });
  assert.ok(removed.ok);
  assert.ok(!existsSync(wt.absolute));
  assert.ok(existingFadenoBranches(root).has('rm'), 'the branch survives: history is not scratch');
  assert.equal(isRegisteredWorktree(root, wt.absolute), false);
  assert.equal(removeWorktree({ repoRoot: root, absolute: resolve(root) }).ok, false, 'never the repository root');
});

test('dirtyPaths reports untracked files too, and answers unavailable outside git rather than clean', (t) => {
  const root = gitRepo(t);
  writeFileSync(join(root, 'untracked.txt'), 'x\n');
  assert.deepEqual(dirtyPaths(root), { paths: ['untracked.txt'], truncated: false });
  assert.deepEqual(trackedDirtyPaths(root), [], 'untracked scratch does not count as tracked dirt');
  assert.equal(dirtyPaths(tempRepo(t)), 'unavailable');
});

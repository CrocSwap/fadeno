import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tempRepo } from './helpers.ts';
import {
  WORKSPACE_LEASE_FILE,
  acquireWorkspaceLease,
  collectIsolatedDiff,
  createIsolatedWorktree,
  removeIsolatedWorktree,
} from '../src/lib/workspace-lease.ts';

function initGit(root: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  const run = (args: string[]) => {
    const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${s.stderr ?? s.error}`);
  };
  run(['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-m', 'init']);
}

function aliveProbe(): void {}

test('isolated worktree is cut from HEAD and preserves dirty workspace', (t) => {
  const root = tempRepo(t);
  initGit(root);
  // dirty change in main workspace — must survive isolated work
  writeFileSync(join(root, 'dirty.txt'), 'user-dirty\n');
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'test-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  assert.ok(existsSync(created.worktreeAbs));
  // worktree has base.txt but not dirty.txt (cut from HEAD)
  assert.ok(existsSync(join(created.worktreeAbs, 'base.txt')));
  assert.equal(existsSync(join(created.worktreeAbs, 'dirty.txt')), false, 'isolated worktree must not contain dirty workspace files');
  // mutate inside worktree
  writeFileSync(join(created.worktreeAbs, 'isolated.txt'), 'from-isolated\n');
  writeFileSync(join(created.worktreeAbs, 'base.txt'), 'base-modified\n');
  // main workspace still has dirty.txt and untouched base.txt
  assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(readFileSync(join(root, 'dirty.txt'), 'utf8'), 'user-dirty\n');
  assert.equal(existsSync(join(root, 'isolated.txt')), false, 'isolated write must not leak to shared worktree');

  const diffRel = '.fadeno/local/outputs/isolated-test-1.diff';
  const diffAbs = join(root, diffRel);
  const diff = collectIsolatedDiff({ repoRoot: root, worktreeAbs: created.worktreeAbs, diffAbs, diffRel });
  assert.ok(diff.diffBytes > 0);
  assert.ok(existsSync(diffAbs));
  const diffText = readFileSync(diffAbs, 'utf8');
  assert.ok(diffText.includes('isolated.txt') || diffText.includes('base.txt'), 'diff must contain isolated changes');
  // diff is binary-capable (uses --binary)
  assert.ok(diff.diffRel === diffRel);

  removeIsolatedWorktree(root, created.worktreeAbs);
  assert.equal(existsSync(created.worktreeAbs), false, 'worktree removed');
  // dirty workspace still preserved after removal
  assert.equal(readFileSync(join(root, 'dirty.txt'), 'utf8'), 'user-dirty\n');
  assert.equal(existsSync(diffAbs), true, 'diff artifact preserved after worktree removal');
  // diff is not auto-merged: main workspace still has no isolated.txt
  assert.equal(existsSync(join(root, 'isolated.txt')), false);
});

test('isolated worktree bypasses shared-writer lease', (t) => {
  const root = tempRepo(t);
  initGit(root);
  // hold shared lease with a live pid
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'owner', kind: 'ad-hoc' }, supervisorPid: 99999, probe: aliveProbe });
  assert.ok(existsSync(join(root, WORKSPACE_LEASE_FILE)));
  // isolated creation must succeed even while shared lease is held
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'bypass-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  assert.ok(existsSync(created.worktreeAbs));
  // lease still held, untouched
  assert.equal(existsSync(join(root, WORKSPACE_LEASE_FILE)), true);
  removeIsolatedWorktree(root, created.worktreeAbs);
});

test('isolated diff is binary-safe and preserved as artifact', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'binary-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  // write binary-ish file
  const bin = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  writeFileSync(join(created.worktreeAbs, 'image.bin'), bin);
  const diffRel = '.fadeno/local/outputs/isolated-binary-1.diff';
  const diffAbs = join(root, diffRel);
  const res = collectIsolatedDiff({ repoRoot: root, worktreeAbs: created.worktreeAbs, diffAbs, diffRel });
  assert.ok(res.diffBytes > 0);
  const content = readFileSync(diffAbs, 'utf8');
  // --binary diff should mention binary or contain patch
  assert.ok(content.length > 0);
  assert.ok(content.includes('image.bin') || content.includes('Binary'));
  removeIsolatedWorktree(root, created.worktreeAbs);
});

test('non-git repo fails with WorkspaceLeaseError and does not create worktree', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'no-git');
  assert.throws(
    () => createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /isolated worktree could not be created/i);
      return true;
    },
  );
  assert.equal(existsSync(wtPath), false);
});

test('collectIsolatedDiff writes empty diff when worktree is clean', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'clean-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  const diffRel = '.fadeno/local/outputs/isolated-clean-1.diff';
  const diffAbs = join(root, diffRel);
  const res = collectIsolatedDiff({ repoRoot: root, worktreeAbs: created.worktreeAbs, diffAbs, diffRel });
  assert.equal(res.diffBytes, 0);
  assert.ok(existsSync(diffAbs));
  assert.equal(readFileSync(diffAbs, 'utf8'), '');
  removeIsolatedWorktree(root, created.worktreeAbs);
});

test('isolation is opt-in: shared writer path does not mutate isolated paths', (t) => {
  const root = tempRepo(t);
  initGit(root);
  // shared path: create a file directly in repo (simulating a non-isolated dispatch)
  writeFileSync(join(root, 'shared.txt'), 'shared-write\n');
  assert.ok(existsSync(join(root, 'shared.txt')));
  // isolated path: must not contain shared.txt until explicitly moved
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'optin-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  // worktree is from HEAD, so shared.txt (uncommitted) is absent there
  assert.equal(existsSync(join(created.worktreeAbs, 'shared.txt')), false, 'isolated worktree must be opt-in and not see shared writes');
  removeIsolatedWorktree(root, created.worktreeAbs);
});

test('isolated-worktree-killed-diff-still-collectable: diff collectable after simulated kill', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'killed-1');
  const created = createIsolatedWorktree({ repoRoot: root, worktreePath: wtPath });
  writeFileSync(join(created.worktreeAbs, 'killed.txt'), 'content after kill\n');
  // Simulate killed worktree: worktree still exists, diff must still be collectable
  const diffRel = '.fadeno/local/outputs/isolated-killed-1.diff';
  const diffAbs = join(root, diffRel);
  const res = collectIsolatedDiff({ repoRoot: root, worktreeAbs: created.worktreeAbs, diffAbs, diffRel });
  assert.ok(res.diffBytes > 0);
  assert.ok(existsSync(diffAbs));
  // valid diff is binary-safe
  assert.ok(readFileSync(diffAbs, 'utf8').includes('killed.txt'));
  removeIsolatedWorktree(root, created.worktreeAbs);
});

test('isolated-diff-failure-preserves-worktree: worktree preserved when diff collection fails', async (t) => {
  const root = tempRepo(t);
  initGit(root);
  const { withIsolatedWorktree: withWT, removeIsolatedWorktree: rmWT, createIsolatedWorktree: createWT } = await import('../src/lib/workspace-lease.ts');
  const wtPath = join(root, '.fadeno', 'local', 'isolated', 'preserve-1');
  const created = createWT({ repoRoot: root, worktreePath: wtPath });
  writeFileSync(join(created.worktreeAbs, 'preserve.txt'), 'preserve me\n');
  // Make diff destination unwritable by occupying its parent dir path with a file
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  const blockingFile = join(root, '.fadeno', 'local', 'outputs', 'block');
  writeFileSync(blockingFile, 'block');
  const badDiffAbs = join(blockingFile, 'isolated-preserve-1.diff');
  const badDiffRel = '.fadeno/local/outputs/block/isolated-preserve-1.diff';
  let threw = false;
  const wtPath2 = join(root, '.fadeno', 'local', 'isolated', 'preserve-2');
  try {
    withWT({ repoRoot: root, worktreePath: wtPath2, diffAbs: badDiffAbs, diffRel: badDiffRel, now: new Date() }, () => {
      writeFileSync(join(wtPath2, 'inner.txt'), 'x\n');
    });
  } catch {
    threw = true;
    assert.ok(existsSync(wtPath2), 'worktree preserved after diff failure in withIsolatedWorktree');
    rmWT(root, wtPath2);
  } finally {
    try { rmSync(blockingFile, { force: true }); } catch {}
  }
  assert.equal(threw, true);
  removeIsolatedWorktree(root, created.worktreeAbs);
});

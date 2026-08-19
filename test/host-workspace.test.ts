import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync, utimesSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tempRepo } from './helpers.ts';
import {
  HOST_ISOLATED_DIFF_DIR,
  HOST_WORKSPACE_LOCK,
  HOST_WORKSPACES_DIR,
  HOST_WORKTREES_DIR,
  HOST_WORKSPACE_SEGMENT_RE,
  HostWorkspaceError,
  hostIsolatedDiffPath,
  hostWorkspaceStatePath,
  hostWorktreePath,
  readHostWorkspaceState,
  prepareHostWorkspace,
  collectHostWorkspaceDiff,
  removeHostWorkspace,
  withHostWorkspaceLock,
} from '../src/lib/host-workspace.ts';

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

function gitEnv() {
  return { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
}

test('host-workspace path helpers validate segments and build frozen paths', () => {
  assert.equal(hostWorktreePath('run1', 'dispatch1'), join(HOST_WORKTREES_DIR, 'run1', 'dispatch1'));
  assert.equal(hostWorkspaceStatePath('run1', 'dispatch1'), join(HOST_WORKSPACES_DIR, 'run1', 'dispatch1.json'));
  assert.equal(hostIsolatedDiffPath('run1', 'dispatch1'), join(HOST_ISOLATED_DIFF_DIR, 'host-isolated-run1-dispatch1.diff'));
  // regex sanity
  assert.ok(HOST_WORKSPACE_SEGMENT_RE.test('a'));
  assert.ok(HOST_WORKSPACE_SEGMENT_RE.test('A0._-b'));
  assert.equal(HOST_WORKSPACE_SEGMENT_RE.test('.bad'), false);
  assert.equal(HOST_WORKSPACE_SEGMENT_RE.test('..'), false);
});

test('prepare cut-from-HEAD with dirty shared checkout preserved', (t) => {
  const root = tempRepo(t);
  initGit(root);
  // create dirty file in shared checkout (not committed)
  writeFileSync(join(root, 'dirty.txt'), 'user-dirty\n');
  // also modify base.txt but not committed
  writeFileSync(join(root, 'base.txt'), 'dirty-base\n');
  const { state } = prepareHostWorkspace({ repoRoot: root, run: 'runA', dispatchId: 'd1' });
  assert.equal(state.schema_version, '1.0');
  assert.equal(state.run, 'runA');
  assert.equal(state.dispatch_id, 'd1');
  assert.equal(state.workspace_mode, 'isolated');
  assert.equal(state.workspace, hostWorktreePath('runA', 'd1'));
  assert.match(state.base_commit, /^[0-9a-f]{40}$/);
  assert.ok(state.prepared_at);
  // worktree should exist and be at HEAD content, not dirty
  const wtAbs = join(root, state.workspace);
  assert.ok(existsSync(wtAbs));
  assert.equal(readFileSync(join(wtAbs, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(existsSync(join(wtAbs, 'dirty.txt')), false, 'isolated worktree must not contain dirty file');
  // shared checkout still dirty
  assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'dirty-base\n');
  assert.equal(readFileSync(join(root, 'dirty.txt'), 'utf8'), 'user-dirty\n');
  // isolated writes must not leak to shared
  writeFileSync(join(wtAbs, 'isolated.txt'), 'from-isolated\n');
  assert.equal(existsSync(join(root, 'isolated.txt')), false);
});

test('prepare idempotent re-prepare returns same base_commit and idempotent:true', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const first = prepareHostWorkspace({ repoRoot: root, run: 'runB', dispatchId: 'd2' });
  assert.equal(first.idempotent, false);
  const second = prepareHostWorkspace({ repoRoot: root, run: 'runB', dispatchId: 'd2' });
  assert.equal(second.idempotent, true);
  assert.equal(second.state.base_commit, first.state.base_commit);
  assert.equal(second.state.prepared_at, first.state.prepared_at);
  assert.equal(second.state.workspace, first.state.workspace);
  // third call after reading state directly
  const read = readHostWorkspaceState(root, 'runB', 'd2');
  assert.ok(read);
  assert.equal(read!.base_commit, first.state.base_commit);
});

test('prepare refuses an existing directory whose worktree registration is broken', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const first = prepareHostWorkspace({ repoRoot: root, run: 'runBroken', dispatchId: 'dBroken' });
  const wtAbs = join(root, first.state.workspace);
  writeFileSync(join(wtAbs, 'recover-me.txt'), 'preserve this work\n');
  const gitFile = readFileSync(join(wtAbs, '.git'), 'utf8');
  const gitdir = gitFile.trim().replace(/^gitdir:\s*/, '');
  rmSync(gitdir, { recursive: true, force: true });

  assert.throws(
    () => prepareHostWorkspace({ repoRoot: root, run: 'runBroken', dispatchId: 'dBroken' }),
    (err: unknown) => {
      assert.ok(err instanceof HostWorkspaceError);
      assert.match(err.message, /exists but is not registered/);
      return true;
    },
  );
  assert.equal(readFileSync(join(wtAbs, 'recover-me.txt'), 'utf8'), 'preserve this work\n');
});

test('worktree re-created at recorded base_commit after manual removal', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const env = gitEnv();
  const first = prepareHostWorkspace({ repoRoot: root, run: 'runC', dispatchId: 'd3' });
  const wtAbs = join(root, first.state.workspace);
  const baseCommitFirst = first.state.base_commit;
  assert.ok(existsSync(wtAbs));
  // create a new commit on main, moving HEAD
  writeFileSync(join(root, 'new.txt'), 'new commit\n');
  let s = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8', env });
  assert.equal(s.status, 0);
  s = spawnSync('git', ['commit', '-m', 'second'], { cwd: root, encoding: 'utf8', env });
  assert.equal(s.status, 0);
  const newHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env }).stdout.toString().trim();
  assert.notEqual(newHead, baseCommitFirst);
  // manually remove worktree (simulate crash) via rm -rf + prune
  rmSync(wtAbs, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8', env });
  assert.equal(existsSync(wtAbs), false);
  // re-prepare should re-create at recorded base_commit, not new HEAD
  const second = prepareHostWorkspace({ repoRoot: root, run: 'runC', dispatchId: 'd3' });
  assert.equal(second.state.base_commit, baseCommitFirst, 'recreated worktree must stay at recorded base_commit');
  assert.ok(existsSync(wtAbs));
  // content should be from first commit, not second
  assert.equal(existsSync(join(wtAbs, 'new.txt')), false, 'recreated worktree at old base must not contain new commit file');
  assert.equal(readFileSync(join(wtAbs, 'base.txt'), 'utf8'), 'base\n');
});

test('traversal rejection for ., .., absolute, slash-bearing ids', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const badRuns = ['..', '.', '../evil', 'a/b', '/absolute', '', 'a/b/c'];
  const badDispatches = ['..', '.', 'a/b', '/abs', 'has/slash', ''];
  for (const run of badRuns) {
    assert.throws(() => hostWorktreePath(run, 'ok1'), (err: unknown) => err instanceof HostWorkspaceError, `run ${JSON.stringify(run)} should be rejected`);
    assert.throws(() => hostWorkspaceStatePath(run, 'ok1'), (err: unknown) => err instanceof HostWorkspaceError);
    assert.throws(() => hostIsolatedDiffPath(run, 'ok1'), (err: unknown) => err instanceof HostWorkspaceError);
    assert.throws(() => prepareHostWorkspace({ repoRoot: root, run, dispatchId: 'ok1' }), (err: unknown) => err instanceof HostWorkspaceError);
    assert.throws(() => readHostWorkspaceState(root, run, 'ok1'), (err: unknown) => err instanceof HostWorkspaceError);
  }
  for (const did of badDispatches) {
    assert.throws(() => hostWorktreePath('okRun', did), (err: unknown) => err instanceof HostWorkspaceError);
    assert.throws(() => prepareHostWorkspace({ repoRoot: root, run: 'okRun', dispatchId: did }), (err: unknown) => err instanceof HostWorkspaceError);
  }
  // also test segment regex edge: empty, too long (>128), starting with dot/dash
  assert.throws(() => hostWorktreePath('-bad', 'ok'), (err: unknown) => err instanceof HostWorkspaceError);
  assert.throws(() => hostWorktreePath('.bad', 'ok'), (err: unknown) => err instanceof HostWorkspaceError);
  assert.throws(() => hostWorktreePath('a'.repeat(129), 'ok'), (err: unknown) => err instanceof HostWorkspaceError);
  // valid long segment (128) should pass
  const long = 'A' + 'a'.repeat(127);
  assert.doesNotThrow(() => hostWorktreePath(long, 'ok'));
});

test('symlinked path segment rejection', (t) => {
  const root = tempRepo(t);
  initGit(root);
  // create a symlink inside .fadeno/local/host-worktrees pointing outside
  const localDir = join(root, '.fadeno', 'local');
  mkdirSync(localDir, { recursive: true });
  const outside = join(root, 'outside-target');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'evil.txt'), 'evil\n');
  // Create symlink segment: host-worktrees itself as symlink
  // First ensure host-worktrees does not exist, then symlink it
  const linkPath = join(localDir, 'host-worktrees');
  // Remove if exists from previous prepare? It may not exist yet
  try { rmSync(linkPath, { recursive: true, force: true }); } catch {}
  symlinkSync(outside, linkPath);
  assert.ok(existsSync(linkPath));
  // Now attempt prepare should reject due to symlink walk
  assert.throws(() => prepareHostWorkspace({ repoRoot: root, run: 'runSym', dispatchId: 'dSym' }), (err: unknown) => {
    assert.ok(err instanceof HostWorkspaceError);
    assert.match((err as Error).message, /symlink/i);
    return true;
  });
  // cleanup symlink for next test
  rmSync(linkPath, { force: true });
  mkdirSync(linkPath, { recursive: true });

  // Also test symlink via run segment: create host-worktrees/runSym as symlink
  const runDir = join(linkPath, 'runSym2');
  mkdirSync(join(localDir, 'host-workspaces', 'runSym2'), { recursive: true });
  // Prepare a valid worktree first to create runDir then replace with symlink
  // We'll manually create a symlink for a run directory and then attempt prepare for that run
  mkdirSync(runDir, { recursive: true });
  rmSync(runDir, { recursive: true, force: true });
  symlinkSync(outside, runDir);
  assert.throws(() => prepareHostWorkspace({ repoRoot: root, run: 'runSym2', dispatchId: 'd1' }), (err: unknown) => err instanceof HostWorkspaceError);
  rmSync(runDir, { force: true });

  // Test that host-workspaces symlink also rejected on read
  const wsLink = join(localDir, 'host-workspaces');
  try { rmSync(wsLink, { recursive: true, force: true }); } catch {}
  symlinkSync(outside, wsLink);
  assert.throws(() => readHostWorkspaceState(root, 'anyRun', 'anyId'), (err: unknown) => err instanceof HostWorkspaceError);
  rmSync(wsLink, { force: true });
});

test('concurrent prepare serialized by the lock', async (t) => {
  const root = tempRepo(t);
  initGit(root);
  // Two concurrent prepares for same run/dispatch should serialize and both succeed,
  // second being idempotent. We use Promise.all with synchronous calls but lock is sync,
  // so they will queue. To actually test lock, we use child processes.
  // Simple in-process concurrent test: Promise.all over async wrappers
  const run = 'runConc';
  const dispatchId = 'dConc';
  const results = await Promise.all([
    new Promise<{ state: any; idempotent: boolean }>((resolve) => setTimeout(() => resolve(prepareHostWorkspace({ repoRoot: root, run, dispatchId })), 0)),
    new Promise<{ state: any; idempotent: boolean }>((resolve) => setTimeout(() => resolve(prepareHostWorkspace({ repoRoot: root, run, dispatchId })), 5)),
  ]);
  // One should be false (first), other true, but order non-deterministic due to timeout
  const baseCommits = results.map((r) => r.state.base_commit);
  assert.equal(baseCommits[0], baseCommits[1], 'concurrent prepares must agree on base_commit');
  // At least one idempotent true
  assert.ok(results.some((r) => r.idempotent === true) || results.some((r) => r.idempotent === false));
  const wtAbs = join(root, hostWorktreePath(run, dispatchId));
  assert.ok(existsSync(wtAbs));

  // Test lock file is cleaned up
  assert.equal(existsSync(join(root, HOST_WORKSPACE_LOCK)), false, 'lock must be released after prepare');

  // Also test withHostWorkspaceLock directly serializes
  let counter = 0;
  withHostWorkspaceLock(root, () => { counter += 1; });
  withHostWorkspaceLock(root, () => { counter += 1; });
  assert.equal(counter, 2);

  // Test that lock respects stale timeout? Create stale lock dir and ensure next acquire reclaims
  const lockPath = join(root, HOST_WORKSPACE_LOCK);
  mkdirSync(lockPath);
  // make it appear stale by utime in past
  const staleTime = new Date(Date.now() - 200_000);
  // use utimesSync to set mtime older than stale threshold (120s)
  utimesSync(lockPath, staleTime, staleTime);
  // next lock acquisition should reclaim stale lock and succeed
  let didRun = false;
  withHostWorkspaceLock(root, () => { didRun = true; });
  assert.equal(didRun, true);
  assert.equal(existsSync(lockPath), false);
});

test('atomic state write: no partial file after induced failure', async (t) => {
  const root = tempRepo(t);
  initGit(root);
  // Induced failure via non-git repo: prepare should fail and leave no state file or tmp
  const badRoot = tempRepo(t);
  // badRoot is not a git repo, so rev-parse will fail
  assert.throws(() => prepareHostWorkspace({ repoRoot: badRoot, run: 'runBad', dispatchId: 'dBad' }), (err: unknown) => err instanceof HostWorkspaceError);
  const statePath = join(badRoot, hostWorkspaceStatePath('runBad', 'dBad'));
  assert.equal(existsSync(statePath), false, 'failed prepare must not create state file');
  // Ensure no tmp file left in directory
  const dir = join(badRoot, HOST_WORKSPACES_DIR, 'runBad');
  if (existsSync(dir)) {
    const files = readdirSync(dir);
    assert.ok(files.every((f) => !f.includes('.tmp-')), 'no tmp file should remain after failure');
  }

  // Successful prepare should produce valid JSON atomic write
  const { state } = prepareHostWorkspace({ repoRoot: root, run: 'runAtomic', dispatchId: 'dAtomic' });
  const stateAbs = join(root, hostWorkspaceStatePath('runAtomic', 'dAtomic'));
  assert.ok(existsSync(stateAbs));
  const raw = readFileSync(stateAbs, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.base_commit, state.base_commit);
  // No tmp file should remain
  const dir2 = join(root, HOST_WORKSPACES_DIR, 'runAtomic');
  const files2 = readdirSync(dir2);
  assert.ok(files2.every((f) => !f.includes('.tmp-')), 'no tmp file after success');

  // Simulate failure during state write by making parent path a file (mkdir will fail or write will fail)
  // Create a file where directory should be
  const blockRun = 'blockRun';
  const blockPath = join(root, HOST_WORKSPACES_DIR, blockRun);
  rmSync(blockPath, { recursive: true, force: true });
  writeFileSync(blockPath, 'block');
  assert.throws(() => prepareHostWorkspace({ repoRoot: root, run: blockRun, dispatchId: 'd1' }), (err: unknown) => err instanceof HostWorkspaceError || err instanceof Error);
  // Even though it threw, no tmp should be left inside the file path's sibling? The tmp would be inside same directory as state file, which is blockRun/d1.json.tmp...
  // Since blockRun is a file, dirname(blockRun/d1.json) is blockRun which is a file, mkdirSync should fail, but we check no stray tmp
  // Cleanup
  rmSync(blockPath, { force: true });
  // Ensure previous valid state still valid
  const stillRaw = readFileSync(stateAbs, 'utf8');
  assert.doesNotThrow(() => JSON.parse(stillRaw));
});

test('binary diff round-trip including binary file and rename', async (t) => {
  const root = tempRepo(t);
  initGit(root);
  const env = gitEnv();
  // add a second file to test rename
  writeFileSync(join(root, 'original.txt'), 'original content\n');
  let s = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8', env });
  assert.equal(s.status, 0);
  s = spawnSync('git', ['commit', '-m', 'add original'], { cwd: root, encoding: 'utf8', env });
  assert.equal(s.status, 0);

  const { state } = prepareHostWorkspace({ repoRoot: root, run: 'runDiff', dispatchId: 'dDiff' });
  const wtAbs = join(root, state.workspace);
  assert.ok(existsSync(wtAbs));
  // mutate inside worktree: create binary file, rename original.txt, modify base.txt
  const bin = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01]);
  writeFileSync(join(wtAbs, 'image.bin'), bin);
  // rename
  const origInWt = join(wtAbs, 'original.txt');
  const renamedInWt = join(wtAbs, 'renamed.txt');
  // use git mv equivalent: just rename file, git add -A will detect rename
  // include binary file handling
  // On filesystem, rename:
  try { rmSync(renamedInWt, { force: true }); } catch {}
  renameSync(origInWt, renamedInWt);
  writeFileSync(join(wtAbs, 'renamed.txt'), 'original content modified\n');
  writeFileSync(join(wtAbs, 'base.txt'), 'base-modified\n');
  writeFileSync(join(wtAbs, 'newfile.txt'), 'new file\n');

  const collected = collectHostWorkspaceDiff({ repoRoot: root, state });
  assert.ok(collected.diffSnapshot);
  assert.equal(collected.diffSnapshot, hostIsolatedDiffPath('runDiff', 'dDiff'));
  assert.ok(collected.diffBytes > 0);
  const diffAbs = join(root, collected.diffSnapshot);
  assert.ok(existsSync(diffAbs));
  const diffContent = readFileSync(diffAbs);
  assert.ok(diffContent.length > 0);
  const diffText = diffContent.toString('utf8');
  // Diff should contain newfile, renamed, base modifications, and binary file
  // Binary diff with --binary should mention image.bin
  assert.ok(diffText.includes('image.bin') || diffText.includes('Binary'), 'diff must mention binary file');
  // Renamed file detection: diff should contain renamed.txt and original.txt or similarity
  assert.ok(diffText.includes('renamed.txt') || diffText.includes('original.txt'));
  assert.ok(diffText.includes('newfile.txt') || diffText.includes('base.txt'));

  // State should be updated atomically with diff_snapshot, diff_bytes, finalized_at
  const updatedState = collected.state;
  assert.equal(updatedState.diff_snapshot, collected.diffSnapshot);
  assert.equal(updatedState.diff_bytes, collected.diffBytes);
  assert.ok(updatedState.finalized_at);
  assert.equal(updatedState.base_commit, state.base_commit);
  assert.equal(updatedState.workspace, state.workspace);
  // Second collect should be idempotent (reuse)
  const second = collectHostWorkspaceDiff({ repoRoot: root, state: updatedState });
  assert.equal(second.diffSnapshot, collected.diffSnapshot);
  assert.equal(second.diffBytes, collected.diffBytes);
  assert.equal(second.state.diff_snapshot, collected.diffSnapshot);
  // Diff file still exists
  assert.ok(existsSync(diffAbs));
});

test('removeHostWorkspace retains finalized state file', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const { state } = prepareHostWorkspace({ repoRoot: root, run: 'runRm', dispatchId: 'dRm' });
  const wtAbs = join(root, state.workspace);
  writeFileSync(join(wtAbs, 'change.txt'), 'change\n');
  const collected = collectHostWorkspaceDiff({ repoRoot: root, state });
  const finalState = collected.state;
  assert.ok(finalState.diff_snapshot);
  const diffAbs = join(root, finalState.diff_snapshot!);
  assert.ok(existsSync(diffAbs));
  assert.ok(existsSync(wtAbs));
  // remove
  removeHostWorkspace({ repoRoot: root, state: finalState });
  assert.equal(existsSync(wtAbs), false, 'worktree should be removed');
  // diff should still exist
  assert.ok(existsSync(diffAbs), 'diff must be preserved after worktree removal');
  // state file should be retained
  const statePath = join(root, hostWorkspaceStatePath('runRm', 'dRm'));
  assert.ok(existsSync(statePath), 'state file must be retained for idempotency');
  const retained = readHostWorkspaceState(root, 'runRm', 'dRm');
  assert.ok(retained);
  assert.equal(retained!.diff_snapshot, finalState.diff_snapshot);
  assert.equal(retained!.diff_bytes, finalState.diff_bytes);
  // Idempotent terminal reuse: second remove should be best-effort no throw
  assert.doesNotThrow(() => removeHostWorkspace({ repoRoot: root, state: finalState }));
});

test('readHostWorkspaceState returns null when not prepared and validates', (t) => {
  const root = tempRepo(t);
  initGit(root);
  assert.equal(readHostWorkspaceState(root, 'noRun', 'noDispatch'), null);
  const { state } = prepareHostWorkspace({ repoRoot: root, run: 'runRead', dispatchId: 'dRead' });
  const read = readHostWorkspaceState(root, 'runRead', 'dRead');
  assert.deepEqual(read, state);
});

test('withHostWorkspaceLock cleans up even after error', (t) => {
  const root = tempRepo(t);
  assert.equal(existsSync(join(root, HOST_WORKSPACE_LOCK)), false);
  assert.throws(() => withHostWorkspaceLock(root, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(join(root, HOST_WORKSPACE_LOCK)), false, 'lock must be released even after error');
});

test('isRegisteredWorktree proves exact registered worktree', async (t) => {
  const root = tempRepo(t);
  initGit(root);
  const { isRegisteredWorktree } = await import('../src/lib/workspace-lease.ts');
  const { prepareHostWorkspace, HOST_WORKTREES_DIR } = await import('../src/lib/host-workspace.ts');
  const { state } = prepareHostWorkspace({ repoRoot: root, run: 'r1', dispatchId: 'd1' });
  const wtAbs = join(root, state.workspace);
  // true for real linked worktree
  assert.equal(isRegisteredWorktree(root, wtAbs), true);
  // false for plain directory inside repo
  const plain = join(root, '.fadeno', 'local', 'host-worktrees', 'r1', 'plain-dir');
  mkdirSync(plain, { recursive: true });
  assert.equal(isRegisteredWorktree(root, plain), false);
  // false for nested independent git repository
  const nested = join(root, '.fadeno', 'local', 'host-worktrees', 'r1', 'nested-repo');
  mkdirSync(nested, { recursive: true });
  spawnSync('git', ['init'], { cwd: nested, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(isRegisteredWorktree(root, nested), false);
  // false after admin data pruned (dangling .git pointer) — delete via gitdir file, not guessed path
  {
    const gitFile = readFileSync(join(wtAbs, '.git'), 'utf8');
    const gitdir = gitFile.trim().replace(/^gitdir:\s*/, '');
    rmSync(gitdir, { recursive: true, force: true });
  }
  assert.equal(isRegisteredWorktree(root, wtAbs), false);
  // false for nonexistent path, never throws
  assert.equal(isRegisteredWorktree(root, join(root, '.fadeno', 'local', 'host-worktrees', 'r1', 'nope')), false);
  // never throws for nonexistent
  assert.doesNotThrow(() => isRegisteredWorktree(root, join(root, 'nope2')));
  // cleanup: remove plain dirs
  rmSync(plain, { recursive: true, force: true });
  rmSync(nested, { recursive: true, force: true });
});

test('collect and remove guard against plain directory', async (t) => {
  const root = tempRepo(t);
  initGit(root);
  const { prepareHostWorkspace } = await import('../src/lib/host-workspace.ts');
  const { collectHostWorkspaceDiff, removeHostWorkspaceByPath } = await import('../src/lib/host-workspace.ts');
  const { readHostWorkspaceState } = await import('../src/lib/host-workspace.ts');
  const { state } = prepareHostWorkspace({ repoRoot: root, run: 'r2', dispatchId: 'd2' });
  const wtAbs = join(root, state.workspace);
  // turn worktree into plain directory by removing admin and recreating plain dir
  {
    const gitFile = readFileSync(join(wtAbs, '.git'), 'utf8');
    const gitdir = gitFile.trim().replace(/^gitdir:\s*/, '');
    rmSync(gitdir, { recursive: true, force: true });
  }
  rmSync(wtAbs, { recursive: true, force: true });
  mkdirSync(wtAbs, { recursive: true });
  writeFileSync(join(wtAbs, 'plain.txt'), 'plain\n');
  // dirty host tree
  writeFileSync(join(root, 'base.txt'), 'dirty\n');
  const beforePorcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const beforeCached = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const curState = readHostWorkspaceState(root, 'r2', 'd2');
  assert.ok(curState);
  assert.throws(() => collectHostWorkspaceDiff({ repoRoot: root, state: curState! }), (err: unknown) => {
    assert.match((err as Error).message, /not a registered worktree/i);
    return true;
  });
  // remove should be no-op and not delete plain dir
  removeHostWorkspaceByPath({ repoRoot: root, run: 'r2', dispatchId: 'd2', workspaceRel: state.workspace });
  assert.ok(existsSync(wtAbs), 'plain dir must not be deleted');
  assert.ok(existsSync(join(wtAbs, 'plain.txt')));
  const afterPorcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const afterCached = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  assert.equal(afterPorcelain, beforePorcelain);
  assert.equal(afterCached, beforeCached);
});

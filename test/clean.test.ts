import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runClean } from '../src/commands/clean.ts';
import { DISPATCHES_FILE, DISPATCHES_FORMAT } from '../src/commands/dispatch.ts';
import { tempRepo } from './helpers.ts';

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

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.error}`);
  }
  return result.stdout ?? '';
}

function initGit(root: string): void {
  git(root, ['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
}

/**
 * Seed a real, git-registered shadow worktree plus the ledger row that names
 * it — the shape `fadeno dispatch` leaves behind for a shadow pair (see
 * `docs/experimental/slots-and-archetypes.md`, "Phase 5 — symmetric pairs").
 * A real worktree, not a plain directory, is what makes this fixture able to
 * catch the bug: only a registered worktree can leave `.git/worktrees` in a
 * stale state when its directory is deleted out from under git.
 */
function seedRetainedShadowWorktree(root: string, id8: string): string {
  const workspaceRel = `.fadeno/local/shadow/${id8}`;
  mkdirSync(join(root, '.fadeno', 'local', 'shadow'), { recursive: true });
  git(root, ['worktree', 'add', '--detach', join(root, workspaceRel), 'HEAD']);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const rows = [
    {
      format: DISPATCHES_FORMAT,
      timestamp: '2026-08-19T12:00:00.000Z',
      event: 'dispatch_requested',
      dispatch_id: `shadow-${id8}`,
      archetype: 'worker',
      role: null,
      resolution: 'shadow',
      shadow: true,
      primary_dispatch_id: 'primary-1',
      pair_id: `pair-${id8}`,
      executor: 'grok-worker',
      workspace: workspaceRel,
      baseline_commit: 'deadbeef',
    },
    {
      format: DISPATCHES_FORMAT,
      timestamp: '2026-08-19T12:00:05.000Z',
      event: 'dispatch_completed',
      dispatch_id: `shadow-${id8}`,
      archetype: 'worker',
      role: null,
      resolution: 'shadow',
      shadow: true,
      primary_dispatch_id: 'primary-1',
      pair_id: `pair-${id8}`,
      executor: 'grok-worker',
      workspace: workspaceRel,
      baseline_commit: 'deadbeef',
      exit_code: 0,
      duration_ms: 10,
      output_sha256: 'a'.repeat(64),
      diff_snapshot: `.fadeno/local/outputs/shadow-${id8}.diff`,
      diff_bytes: 3,
    },
  ];
  writeFileSync(join(root, DISPATCHES_FILE), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return workspaceRel;
}

test('clean dry run lists retained shadow worktrees with a count, without touching git', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const workspaceRel = seedRetainedShadowWorktree(root, 'aaaaaaaa');
  const worktreeAbs = join(root, workspaceRel);

  const result = runClean({ repoRoot: root });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.retainedShadowWorktrees, [worktreeAbs]);
  assert.deepEqual(result.deregisteredShadowWorktrees, []);
  // A dry run must not deregister or delete anything.
  assert.ok(existsSync(worktreeAbs));
  assert.match(git(root, ['worktree', 'list']), /shadow\/aaaaaaaa/);
});

// The bug this closes: `runClean` used to `rmSync` `.fadeno/local`
// recursively, which for a shadow worktree means deleting a real git
// working tree without ever telling git — leaving `.git/worktrees` stale and
// a later `git worktree add` at the same path failing until someone prunes
// by hand. `--force` must deregister every retained worktree the ledger
// names before it deletes anything.
test('clean --force deregisters a real git worktree instead of orphaning it', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const workspaceRel = seedRetainedShadowWorktree(root, 'bbbbbbbb');
  const worktreeAbs = join(root, workspaceRel);
  assert.match(git(root, ['worktree', 'list']), /shadow\/bbbbbbbb/);

  const result = runClean({ repoRoot: root, force: true });
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.deregisteredShadowWorktrees, [worktreeAbs]);

  // git no longer lists it as a worktree — this is the assertion that would
  // have failed against the old rmSync-only implementation.
  const list = git(root, ['worktree', 'list']);
  assert.doesNotMatch(list, /shadow\/bbbbbbbb/);
  // .git/worktrees carries no stale administrative entry either.
  assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), /shadow\/bbbbbbbb/);
  assert.equal(existsSync(worktreeAbs), false);
  assert.equal(existsSync(join(root, '.fadeno', 'local')), false);
  assert.equal(existsSync(join(root, DISPATCHES_FILE)), false);

  // A later `git worktree add` at the same path must succeed — this is
  // exactly the failure mode a stale `.git/worktrees` entry causes.
  git(root, ['worktree', 'add', '--detach', worktreeAbs, 'HEAD']);
  assert.ok(existsSync(worktreeAbs));
});

test('clean --force tolerates a retained worktree whose directory is already gone', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const workspaceRel = seedRetainedShadowWorktree(root, 'cccccccc');
  const worktreeAbs = join(root, workspaceRel);
  // Simulate a worktree deleted by hand (or an older `fadeno clean`),
  // bypassing git — the exact stale-registration state this command exists
  // to clean up after.
  rmSync(worktreeAbs, { recursive: true, force: true });

  assert.doesNotThrow(() => runClean({ repoRoot: root, force: true }));
  assert.equal(existsSync(join(root, '.fadeno', 'local')), false);
  // `git worktree prune` should have cleared the stale entry, so re-adding
  // at the same path works.
  git(root, ['worktree', 'add', '--detach', worktreeAbs, 'HEAD']);
  assert.ok(existsSync(worktreeAbs));
});

// A repo with nothing shadow-related must see no behavior change: an empty
// retained-worktree list, no git calls, exactly the pre-existing candidate
// list. (The base dry-run/--force contract itself is already covered in
// test/low-friction-journey.test.ts; this just confirms the new field is a
// pure addition for a repo that has none.)
test('clean reports an empty retained-worktree list when the ledger names none', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'runs', 'r'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'runs', 'r', 'run.yaml'), 'status: running\n');
  const dry = runClean({ repoRoot: root });
  assert.deepEqual(dry.retainedShadowWorktrees, []);
  assert.deepEqual(dry.deregisteredShadowWorktrees, []);
});

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { listRetainedShadowWorktrees } from './dispatches.ts';

export interface CleanOptions { cwd?: string; repoRoot?: string; force?: boolean }
export interface CleanResult {
  repoRoot: string;
  candidates: string[];
  removed: string[];
  dryRun: boolean;
  /**
   * Absolute paths of shadow challenger worktrees the ledger's `workspace`
   * field still names (see `listRetainedShadowWorktrees`) — the evidence
   * `.fadeno/local` would take with it. Populated on a dry run too:
   * retention is otherwise invisible and unbounded, and a user about to
   * delete evidence should see what they are about to delete.
   */
  retainedShadowWorktrees: string[];
  /**
   * The subset of `retainedShadowWorktrees` this run actually deregistered
   * with `git worktree remove` before `.fadeno/local` was deleted. Always
   * empty on a dry run.
   */
  deregisteredShadowWorktrees: string[];
}

/**
 * Preview by default; `--force` removes only ignored runtime state, never
 * definitions/evidence.
 *
 * `.fadeno/local` now holds REGISTERED git worktrees — shadow challenger
 * worktrees under `.fadeno/local/shadow/<id8>`, retained deliberately as the
 * challenger's work product until a pair is judged. `rmSync`ing that
 * directory pulls the working tree out from under git without telling it,
 * leaving a stale entry in `.git/worktrees` that can make a later
 * `git worktree add` at the same path fail until someone prunes by hand. So
 * every retained worktree the ledger names is deregistered with
 * `git worktree remove` (then a single `git worktree prune`) before the
 * directory is deleted. A worktree that is already gone — removed by hand,
 * or by an older `fadeno clean` — is tolerated, not an error: this command's
 * job is cleanup, not asserting the ledger is current.
 */
export function runClean(opts: CleanOptions = {}): CleanResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const candidates = [
    join(repoRoot, '.fadeno', 'runs'),
    join(repoRoot, '.fadeno', 'progress'),
    join(repoRoot, '.fadeno', 'local'),
    join(repoRoot, '.fadeno', 'dispatches.jsonl'),
  ].filter(existsSync);

  // Read before anything is deleted: `dispatches.jsonl` is itself a
  // candidate, so the retained-worktree list must come from the ledger
  // while it still exists.
  const retainedShadowWorktrees = listRetainedShadowWorktrees({ repoRoot }).map((w) =>
    join(repoRoot, w.workspace),
  );

  const removed: string[] = [];
  const deregisteredShadowWorktrees: string[] = [];
  if (opts.force) {
    for (const worktree of retainedShadowWorktrees) {
      try {
        const result = spawnSync('git', ['worktree', 'remove', '--force', worktree], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
        if (result.status === 0) deregisteredShadowWorktrees.push(worktree);
      } catch {
        // best-effort: a git failure here must not block the rest of clean
      }
    }
    try {
      spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' });
    } catch {
      // best-effort: pruning stale entries is a courtesy, never a gate
    }
    for (const path of candidates) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return {
    repoRoot,
    candidates,
    removed,
    dryRun: !opts.force,
    retainedShadowWorktrees,
    deregisteredShadowWorktrees,
  };
}

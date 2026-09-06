import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { listRegisteredWorktreesUnder } from '../lib/workspace-isolation.ts';
import { listRetainedShadowWorktrees } from './dispatches.ts';

/**
 * The one directory under which every Fadeno-cut worktree lives, in the
 * `/`-separated form `listRegisteredWorktreesUnder` compares against. Shadow
 * challengers (`shadow/<id8>`), run-scoped host worktrees
 * (`host-worktrees/<run>/<dispatch>`) and runless ad-hoc ones
 * (`host-worktrees/adhoc/<uuid>`) are all under it, and so is whatever the
 * next kind turns out to be.
 */
const LOCAL_DIR = '.fadeno/local';

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
   * delete evidence should see what they are about to delete. This is an
   * EVIDENCE list, not the deregistration list: what gets deregistered comes
   * from git, below.
   */
  retainedShadowWorktrees: string[];
  /**
   * Absolute paths of every git-registered worktree under `.fadeno/local`, as
   * git itself reports them. Populated on a dry run too, and the exact set
   * `--force` deregisters.
   */
  registeredWorktrees: string[];
  /**
   * The subset of `registeredWorktrees` this run actually deregistered with
   * `git worktree remove` before `.fadeno/local` was deleted. Always empty on
   * a dry run.
   */
  deregisteredWorktrees: string[];
}

/**
 * Preview by default; `--force` removes only ignored runtime state, never
 * definitions/evidence.
 *
 * `.fadeno/local` holds REGISTERED git worktrees: shadow challengers under
 * `.fadeno/local/shadow/<id8>`, retained deliberately as the challenger's work
 * product until a pair is judged, and host worktrees under
 * `.fadeno/local/host-worktrees/` — run-scoped from `dispatch-prepare
 * --isolate`, or ad-hoc from `dispatch-open`. `rmSync`ing that directory pulls
 * the working tree out from under git without telling it, leaving a stale
 * entry in `.git/worktrees` that can make a later `git worktree add` at the
 * same path fail until someone prunes by hand.
 *
 * So every registered worktree under `.fadeno/local` is deregistered with `git
 * worktree remove` (then a single `git worktree prune`) before the directory
 * is deleted. The list comes from `git worktree list`, NOT from a hard-coded
 * set of worktree kinds: the ledger-driven version only knew about shadow
 * pairs, so host worktrees — including the ad-hoc ones, which no run ledger
 * names at all — were orphaned in exactly the way this command exists to
 * prevent, and every kind added later would have been orphaned too. A
 * worktree that is already gone — removed by hand, or by an older `fadeno
 * clean` — is tolerated, not an error: this command's job is cleanup, not
 * asserting the registry is current.
 */
export function runClean(opts: CleanOptions = {}): CleanResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const candidates = [
    join(repoRoot, '.fadeno', 'runs'),
    join(repoRoot, '.fadeno', 'progress'),
    join(repoRoot, ...LOCAL_DIR.split('/')),
    join(repoRoot, '.fadeno', 'dispatches.jsonl'),
  ].filter(existsSync);

  // Read before anything is deleted: `dispatches.jsonl` is itself a
  // candidate, so the retained-worktree list must come from the ledger
  // while it still exists.
  const retainedShadowWorktrees = listRetainedShadowWorktrees({ repoRoot }).map((w) =>
    join(repoRoot, w.workspace),
  );
  const registeredWorktrees = listRegisteredWorktreesUnder(repoRoot, LOCAL_DIR);

  const removed: string[] = [];
  const deregisteredWorktrees: string[] = [];
  if (opts.force) {
    for (const worktree of registeredWorktrees) {
      try {
        const result = spawnSync('git', ['worktree', 'remove', '--force', worktree], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
        if (result.status === 0) deregisteredWorktrees.push(worktree);
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
    registeredWorktrees,
    deregisteredWorktrees,
  };
}

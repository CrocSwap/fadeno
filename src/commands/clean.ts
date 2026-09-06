import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { listRegisteredWorktreesUnder } from '../lib/workspace-isolation.ts';
import { compactDispatchWindows, listOverlapSnapshots, type WindowLogCompaction } from '../lib/workspace-overlap.ts';
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

export interface CleanWindowsResult { repoRoot: string; compaction: WindowLogCompaction }

/**
 * `fadeno clean --windows` — compact the write-window log, delete nothing else.
 *
 * A separate entry point rather than a flag on `runClean`, because it is the
 * OPPOSITE of what `runClean --force` does to the same file. `.fadeno/local` is
 * one of `runClean`'s candidates, so `--force` deletes the window log outright,
 * along with every retained shadow worktree and every run ledger. That is the
 * right sledgehammer for "reclaim this repo's runtime state" and the wrong one
 * for "one row in a machine-local log is torn": deleting the log also deletes
 * the OPEN windows in it, which un-isolates deliveries that are writing right
 * now — the one thing `compactDispatchWindows` refuses to do.
 *
 * So this mode takes no `--force`. It removes only rows that can no longer say
 * anything to anyone, it is a no-op when there are none, and it is what
 * `doctor` names when it finds a degraded log.
 */
export function runCleanWindows(opts: { cwd?: string; repoRoot?: string } = {}): CleanWindowsResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  return { repoRoot, compaction: compactDispatchWindows(repoRoot) };
}
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
  /**
   * Repo-relative pre-delivery workspace snapshots under `.fadeno/local`
   * (`workspace-overlap.ts`), counted rather than listed one by one.
   *
   * They need no special handling — plain files, nothing registered with git,
   * swept with the directory that holds them. They are counted because a pile
   * of them is the only visible trace that shared host deliveries have been
   * dying before their terminal receipt, and `fadeno clean` is where a user
   * with a leftover-looking repo actually looks. `fadeno doctor` says the same
   * thing in more detail. Populated on a dry run too.
   */
  overlapSnapshots: string[];
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
 *
 * Plain machine-local files under `.fadeno/local` need none of that and are
 * simply deleted with it. One kind is COUNTED on the way past — the
 * pre-delivery workspace snapshots overlap detection persists between a shared
 * `dispatch-start` and its terminal receipt — because a pile of them means
 * shared host deliveries are dying before their terminal, and this command is
 * where someone with a leftover-looking `.fadeno/local` looks first.
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
  // Read before deletion for the same reason the shadow list is: they live
  // inside a candidate.
  const overlapSnapshots = listOverlapSnapshots(repoRoot);

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
    overlapSnapshots,
  };
}

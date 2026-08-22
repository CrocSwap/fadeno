/**
 * The caller's workspace as an isolated worktree sees it, and the way an
 * isolated worktree's work gets back into the caller's workspace.
 *
 * Three moments, all deterministic git, and the only moments an isolated
 * delivery ever touches the caller's tree:
 *
 *   capture   — read the caller's uncommitted state (tracked diff + untracked
 *               files) so the worktree can start from what the caller sees
 *   apply     — `git apply` the worktree's diff into the caller's tree
 *   rebase    — when the caller's tree has moved since the capture, bring the
 *               worktree up to date and re-apply the attempt's work on top
 *
 * The model is a pull request. The worktree is the branch; the caller's
 * working tree is main, and it moves — sibling members merge back, the human
 * edits. The branch owner reconciles on the branch. Main only ever receives
 * an apply that lands whole, atomically, with no index involved and no
 * conflict markers: a plain `git apply` either applies every hunk or touches
 * nothing. Conflict markers exist only inside the retained worktree, where
 * the executor that wrote the work can be re-invoked to resolve them.
 *
 * What this retires. `git apply --3way` used to be the merge-back, and it
 * was both the check and the thing that wrote markers into the CALLER's tree
 * when it failed — so a receipt had to say `conflicted`, meaning "the tree
 * MAY be partly applied, go look". And `--3way` implies `--index`, so an edit
 * to a path the caller holds untracked (carried into the worktree by the
 * baseline, hence tracked there) refused the whole patch, tracked hunks included, with
 * `does not exist in index`. Neither can happen now: a plain apply
 * has no index and handles untracked paths natively, and reconciliation
 * never runs against the caller's tree at all.
 *
 * Every function here that touches the caller's tree is documented as
 * requiring the write window lease; the callers hold it. This module does
 * not take it, so that one window can cover apply → rebase → re-apply as a
 * single atomic turn.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collectIsolatedDiff, type IsolatedDiffResult } from './workspace-lease.ts';

const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Fixed author, committer, and date for every commit this module makes. A
 * commit object hashes its timestamps, so two worktrees given the same
 * capture must get the same dates or their baseline shas would differ for
 * identical content — and a shadow pair's shared `baseline_commit` would be a
 * fiction. The epoch constant is arbitrary but must stay stable: it is an
 * identity, not a time, and nothing reads it as one.
 */
const BASELINE_COMMIT_DATE = '2000-01-01T00:00:00Z';
const FIXED_IDENTITY = ['-c', 'user.name=fadeno', '-c', 'user.email=fadeno@localhost'];
const FIXED_DATES = { GIT_AUTHOR_DATE: BASELINE_COMMIT_DATE, GIT_COMMITTER_DATE: BASELINE_COMMIT_DATE };

/** Never copy the worktrees' own home into a worktree — recursive, and the
 * one path a repo's own `.gitignore` cannot be trusted to exclude. */
function isUnderShadowHome(repoRelPath: string): boolean {
  return repoRelPath === '.fadeno/local' || repoRelPath.startsWith('.fadeno/local/');
}

function gitFailureReason(result: { error?: Error | null; status: number | null; stderr?: string | Buffer | null }): string {
  if (result.error != null) return result.error.message;
  const stderr = String(result.stderr ?? '').trim();
  if (stderr.length > 0) return stderr;
  return `exit ${result.status ?? 'unknown'}`;
}

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: SPAWN_MAX_BUFFER, env: { ...process.env, ...extraEnv } });
}

function gitOk(res: { error?: Error | null; status: number | null }): boolean {
  return res.error == null && res.status === 0;
}

// ---------------------------------------------------------------------------
// Capture and replay
// ---------------------------------------------------------------------------

/**
 * The caller's pre-spawn workspace, captured ONCE.
 *
 * Both arms of a pair replay this same capture. Capturing per-arm instead
 * would read the tree at two different moments — the challenger is
 * materialized before the primary's worktree is — so a file written between
 * the two reads would land in one arm's baseline and not the other's, which
 * is precisely the asymmetry the shared baseline exists to remove.
 */
export interface CapturedWorkspaceBaseline {
  /** `git diff HEAD --binary` over tracked content. Empty when clean. */
  patch: Buffer;
  /** Untracked-but-unignored paths; `git diff` has no notion of these. */
  untrackedFiles: string[];
}

/** Read the caller's workspace. Hold the READ window lease: a capture mid-merge-back is a torn baseline. */
export function captureWorkspaceBaseline(repoRoot: string): CapturedWorkspaceBaseline {
  const diffRes = spawnSync('git', ['-C', repoRoot, 'diff', 'HEAD', '--binary'], {
    encoding: 'buffer',
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (diffRes.error != null || diffRes.status !== 0) {
    throw new Error(`could not capture the primary workspace's pre-spawn state: ${gitFailureReason(diffRes)}`);
  }
  const untrackedRes = spawnSync('git', ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (untrackedRes.error != null || untrackedRes.status !== 0) {
    throw new Error(`could not list the primary workspace's untracked files: ${gitFailureReason(untrackedRes)}`);
  }
  return {
    patch: diffRes.stdout ?? Buffer.alloc(0),
    untrackedFiles: String(untrackedRes.stdout ?? '')
      .split('\0')
      .filter((p) => p.length > 0)
      .filter((p) => !isUnderShadowHome(p)),
  };
}

/**
 * Replay one captured baseline into one worktree and commit it.
 *
 * The commit is made with a FIXED author/committer identity and date, so two
 * worktrees cut from the same HEAD and given the same capture produce the
 * byte-identical commit object — and therefore the same sha. That is what
 * lets `baseline_commit` be one value genuinely shared by both arms rather
 * than one arm's value copied onto the other's row. The caller asserts the
 * equality; a mismatch means the arms did not start from the same state and
 * the pair is not a fair test.
 */
export function applyWorkspaceBaseline(
  repoRoot: string,
  worktreeAbs: string,
  captured: CapturedWorkspaceBaseline,
  /** Names the baseline in its commit subject. A pair passes its `pairId` so
   * both arms produce the byte-identical commit object the shared
   * `baseline_commit` depends on; an unpaired isolated delivery passes its
   * dispatch id, which has no counterpart to match. */
  baselineRef: string,
  armLabel: string,
): string {
  const patch = captured.patch;

  if (patch.length > 0) {
    const applyRes = spawnSync('git', ['-C', worktreeAbs, 'apply', '--index'], {
      input: patch,
      encoding: 'utf8',
      maxBuffer: SPAWN_MAX_BUFFER,
    });
    if (applyRes.error != null || applyRes.status !== 0) {
      throw new Error(`could not replay the caller's pre-spawn changes into the ${armLabel} worktree: ${gitFailureReason(applyRes)}`);
    }
  }

  let copiedAny = false;
  for (const relPath of captured.untrackedFiles) {
    try {
      const srcAbs = join(repoRoot, relPath);
      const destAbs = join(worktreeAbs, relPath);
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(srcAbs, destAbs);
      // copyFileSync does not preserve mode bits, notably the executable
      // one: an untracked helper script (a repo's own build/test entry
      // point is a common case) would otherwise land non-executable in the
      // challenger's worktree, so the challenger could not run something
      // the primary can — the same class of asymmetry `worktree_carry`
      // exists to remove for gitignored paths. Match the source file's mode
      // explicitly rather than trust the copy to carry it.
      chmodSync(destAbs, statSync(srcAbs).mode);
      copiedAny = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`could not copy untracked file "${relPath}" into the ${armLabel} worktree: ${reason}`);
    }
  }

  if (patch.length === 0 && !copiedAny) {
    // Nothing to replay: the primary's tree was clean, so the baseline is
    // simply the commit the worktree was already cut from.
    const headRes = git(worktreeAbs, ['rev-parse', 'HEAD']);
    if (!gitOk(headRes)) {
      throw new Error(`could not resolve the ${armLabel} worktree's HEAD: ${gitFailureReason(headRes)}`);
    }
    return String(headRes.stdout ?? '').trim();
  }

  const addRes = git(worktreeAbs, ['add', '-A']);
  if (!gitOk(addRes)) {
    throw new Error(`could not stage the workspace baseline in the ${armLabel} worktree: ${gitFailureReason(addRes)}`);
  }
  const commitRes = git(worktreeAbs, [...FIXED_IDENTITY, 'commit', '--no-verify', '--no-gpg-sign', '-m', `fadeno workspace baseline ${baselineRef}`], FIXED_DATES);
  if (!gitOk(commitRes)) {
    throw new Error(`could not commit the workspace baseline in the ${armLabel} worktree: ${gitFailureReason(commitRes)}`);
  }

  const shaRes = git(worktreeAbs, ['rev-parse', 'HEAD']);
  if (!gitOk(shaRes)) {
    throw new Error(`could not resolve the ${armLabel} worktree's baseline commit: ${gitFailureReason(shaRes)}`);
  }
  return String(shaRes.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// Merge-back
// ---------------------------------------------------------------------------

/**
 * How a merge-back ended — the stamp that goes on the receipt.
 *
 *   clean       — the whole diff is in the workspace
 *   unresolved  — the attempt's work conflicts with what the workspace now
 *                 holds; the worktree is RETAINED with conflict markers in
 *                 `conflicts`, and the workspace is untouched
 *   blocked     — nothing was applied and the workspace is untouched: no turn
 *                 at the window, or a diff that could not be collected
 *
 * There is no `conflicted` any more. That status meant "git tried and the
 * caller's tree MAY be partly applied", and a plain apply cannot produce it.
 * A reader of an old ledger still meets the word; a reader of a new one never
 * has to inspect the caller's tree because of a merge-back.
 */
export interface MergeBackResult {
  status: 'clean' | 'unresolved' | 'blocked';
  detail?: string;
  /** The fresh baseline the work was re-applied on top of, when the workspace had moved since capture. */
  rebased_onto?: string;
  /** Paths left carrying conflict markers in the retained worktree. Only with `unresolved`. */
  conflicts?: string[];
}

/** The command that would re-apply a kept diff by hand. Plain apply is the only apply there is now. */
export function mergeBackReapplyCommand(diffRel: string): string {
  return `git apply ${diffRel}`;
}

/**
 * Apply a worktree's diff to the caller's working tree. Plain `git apply`:
 * atomic (every hunk or none), no index, no markers, untracked paths
 * included. A refusal means the tree moved since the diff's baseline — the
 * signal to rebase — and it leaves the tree exactly as it was.
 *
 * Hold the WRITE window lease.
 */
export function applyDiffToWorkspace(repoRoot: string, diffAbs: string): { ok: true } | { ok: false; detail: string } {
  const res = git(repoRoot, ['apply', diffAbs]);
  if (gitOk(res)) return { ok: true };
  return { ok: false, detail: gitFailureReason(res) };
}

export interface RebaseResult {
  status: 'clean' | 'conflict';
  /** The new baseline: the caller's current workspace, committed in the worktree. */
  baselineCommit: string;
  /** Paths left with conflict markers. Empty when `clean`. */
  conflicts: string[];
}

/**
 * "Update branch": bring a worktree up to date with the caller's current
 * workspace and re-apply the attempt's work on top.
 *
 * The worktree's HEAD is its old baseline and its index holds the attempt's
 * work staged (`collectIsolatedDiff` stages everything). So:
 *   1. commit the staged work as W
 *   2. move the worktree to the caller's current HEAD
 *   3. replay the caller's current uncommitted state and commit it: B2
 *   4. cherry-pick W onto B2 without committing
 * A clean pick leaves the worktree at "B2 + the attempt's work", the same
 * shape it had before collection, ready to be diffed and applied — and that
 * apply cannot refuse while the lease is still held, because the caller's
 * tree IS B2. A conflicted pick leaves markers in the worktree; the index is
 * reset so the executor finds an ordinary dirty tree with `<<<<<<<` in the
 * named files, not a cherry-pick in progress.
 *
 * W and the old baseline become unreachable once the worktree moves on. That
 * is the same lifetime every baseline commit already has, and the pick
 * happens within the same lease window that created W, so no pruning can
 * intervene.
 *
 * Hold the WRITE window lease for the whole call: step 3 reads the caller's
 * tree, and the apply that follows a clean rebase must see that same tree.
 */
export function rebaseWorktreeOntoWorkspace(opts: {
  repoRoot: string;
  worktreeAbs: string;
  /** Names the new baseline in its commit subject. */
  baselineRef: string;
  armLabel: string;
}): RebaseResult {
  const { repoRoot, worktreeAbs, baselineRef, armLabel } = opts;
  const commitRes = git(worktreeAbs, [...FIXED_IDENTITY, 'commit', '--no-verify', '--no-gpg-sign', '--allow-empty', '-m', `fadeno attempt work ${baselineRef}`], FIXED_DATES);
  if (!gitOk(commitRes)) {
    throw new Error(`could not commit the ${armLabel} worktree's work before rebasing: ${gitFailureReason(commitRes)}`);
  }
  const workRes = git(worktreeAbs, ['rev-parse', 'HEAD']);
  if (!gitOk(workRes)) throw new Error(`could not resolve the ${armLabel} worktree's work commit: ${gitFailureReason(workRes)}`);
  const work = String(workRes.stdout ?? '').trim();

  const headRes = git(repoRoot, ['rev-parse', 'HEAD']);
  if (!gitOk(headRes)) throw new Error(`could not resolve the workspace's HEAD: ${gitFailureReason(headRes)}`);
  const callerHead = String(headRes.stdout ?? '').trim();

  const captured = captureWorkspaceBaseline(repoRoot);
  const checkoutRes = git(worktreeAbs, ['checkout', '-q', '--detach', callerHead]);
  if (!gitOk(checkoutRes)) {
    throw new Error(`could not move the ${armLabel} worktree to the workspace's HEAD: ${gitFailureReason(checkoutRes)}`);
  }
  const baselineCommit = applyWorkspaceBaseline(repoRoot, worktreeAbs, captured, baselineRef, armLabel);

  const pickRes = git(worktreeAbs, ['cherry-pick', '--no-commit', work]);
  if (gitOk(pickRes)) return { status: 'clean', baselineCommit, conflicts: [] };

  const unmergedRes = git(worktreeAbs, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = String(unmergedRes.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0).sort();
  // Leave the markers, drop the machinery: no cherry-pick in progress, no
  // unmerged index entries. The executor gets a dirty tree and a list.
  git(worktreeAbs, ['cherry-pick', '--quit']);
  git(worktreeAbs, ['reset', '-q']);
  if (conflicts.length === 0) {
    // The pick failed for a reason other than content conflicts (for
    // instance the work is already entirely present in B2 and the pick came
    // out empty). Nothing to resolve; the caller will re-collect and find
    // whatever is left.
    return { status: 'clean', baselineCommit, conflicts: [] };
  }
  return { status: 'conflict', baselineCommit, conflicts };
}

export interface SettleIsolatedWorkOptions {
  repoRoot: string;
  worktreeAbs: string;
  /** The diff already collected from the worktree against its current baseline. */
  diff: IsolatedDiffResult;
  /** Names the rebase baseline in its commit subject. */
  baselineRef: string;
  armLabel: string;
  /**
   * Paths a previous round left with conflict markers. Checked BEFORE the
   * apply: git has no opinion about marker lines, so an executor that left
   * them in place would otherwise have them applied into the caller's tree
   * as content. A file still carrying markers means the round did not
   * resolve it, and the result is `unresolved` again — no rebase, no apply.
   */
  priorConflicts?: readonly string[];
}

/** A line git wrote when it could not merge. Both ends are required so a
 * lone `=======` (a markdown rule, say) is not mistaken for one. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
}

export interface SettledIsolatedWork {
  stamp: MergeBackResult;
  /** The diff that was applied or kept — re-collected when a rebase moved the baseline. */
  diff: IsolatedDiffResult;
}

/**
 * The whole merge-back, one atomic turn under the WRITE window lease:
 * apply; if the tree moved, rebase; if the rebase is clean, apply again
 * (cannot refuse — the caller's tree is the new baseline and the lease is
 * still held); if the rebase conflicts, stop with the worktree retained.
 *
 * The caller decides what happens to an `unresolved` result — the engine
 * re-invokes the executor in the retained worktree, an ad-hoc dispatch hands
 * it to whoever launched it — and tears the worktree down only on the other
 * two.
 */
export function settleIsolatedWork(opts: SettleIsolatedWorkOptions): SettledIsolatedWork {
  const { repoRoot, worktreeAbs, baselineRef, armLabel } = opts;
  let diff = opts.diff;
  if (opts.priorConflicts != null && opts.priorConflicts.length > 0) {
    const stillMarked = opts.priorConflicts.filter((rel) => {
      try { return hasConflictMarkers(readFileSync(join(worktreeAbs, rel), 'utf8')); } catch { return false; }
    });
    if (stillMarked.length > 0) {
      return {
        stamp: {
          status: 'unresolved',
          detail: `conflict markers remain in ${stillMarked.length} file(s) after the round: ${stillMarked.join(', ')}. The worktree is retained; the workspace is untouched`,
          conflicts: stillMarked,
        },
        diff,
      };
    }
  }
  if (diff.diffBytes === 0) {
    return { stamp: { status: 'clean', detail: `nothing to apply: the ${armLabel} made no changes` }, diff };
  }
  const first = applyDiffToWorkspace(repoRoot, diff.diffAbs);
  if (first.ok) return { stamp: { status: 'clean' }, diff };

  // The workspace moved since this worktree's baseline was captured — a
  // sibling merged back, or the human edited. Reconcile on the branch.
  const rebase = rebaseWorktreeOntoWorkspace({ repoRoot, worktreeAbs, baselineRef, armLabel });
  if (rebase.status === 'conflict') {
    return {
      stamp: {
        status: 'unresolved',
        detail:
          `the workspace changed while the ${armLabel} worked; rebased onto it and ${rebase.conflicts.length} ` +
          `file(s) conflict: ${rebase.conflicts.join(', ')}. The worktree is retained with conflict markers; the workspace is untouched`,
        rebased_onto: rebase.baselineCommit,
        conflicts: rebase.conflicts,
      },
      diff,
    };
  }
  // Clean rebase: the worktree is the new baseline plus the attempt's work.
  // Re-collect against that baseline and apply.
  diff = collectIsolatedDiff({ repoRoot, worktreeAbs, diffAbs: diff.diffAbs, diffRel: diff.diffRel });
  if (diff.diffBytes === 0) {
    return {
      stamp: { status: 'clean', detail: `nothing left to apply: the workspace already contains the ${armLabel}'s work`, rebased_onto: rebase.baselineCommit },
      diff,
    };
  }
  const second = applyDiffToWorkspace(repoRoot, diff.diffAbs);
  if (second.ok) {
    return { stamp: { status: 'clean', detail: 'the workspace had moved; rebased onto it before applying', rebased_onto: rebase.baselineCommit }, diff };
  }
  // Should be unreachable under the lease. Said plainly rather than hidden
  // as a conflict the caller would then go looking for.
  return {
    stamp: {
      status: 'blocked',
      detail: `nothing was applied: rebased onto the workspace without conflicts, yet the apply still refused (${second.detail}); the diff is kept`,
      rebased_onto: rebase.baselineCommit,
    },
    diff,
  };
}

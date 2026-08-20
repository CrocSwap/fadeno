import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { appendEvidenceRow, DISPATCHES_FORMAT } from './dispatch.ts';
import { resolveDispatchPair, type DispatchEntry } from './dispatches.ts';

export class ShadowApplyCommandError extends Error {}

export type ShadowApplyArm = 'challenger' | 'primary';

export interface ShadowApplyOptions {
  /** A `pair_id`, or either arm's `dispatch_id` (full, or an 8+ character prefix). */
  ref: string;
  /** Which arm's diff to port back. Validated here; defaults to `challenger`. */
  arm?: string;
  /** Report applicability only (`git apply --check --3way`); mutates nothing. */
  check?: boolean;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface ShadowApplyResult {
  pairId: string;
  arm: ShadowApplyArm;
  /** The applied arm's own `dispatch_id`. */
  dispatchId: string;
  /** Repo-relative diff artifact path (`diff_snapshot` on the arm's evidence). */
  artifact: string;
  diffBytes: number | null;
  baselineCommit: string;
  check: boolean;
  /**
   * Whether the patch applied (a real run) or would apply (`--check`)
   * without `--3way` inserting conflict markers. NOT simply "git exited 0"
   * under `--check` — see the long comment above the `git apply` call for
   * the verified reason a naive exit-code read is wrong there.
   */
  clean: boolean;
  /** True only after a real (non-`--check`), clean apply actually mutated the workspace. */
  applied: boolean;
  /** git's own report text (stderr), or a synthesized note when git printed nothing. */
  detail: string;
}

function gitReason(result: { error?: Error | null; status: number | null; stderr?: string | null }): string {
  if (result.error != null) return result.error.message;
  const stderr = (result.stderr ?? '').trim();
  return stderr.length > 0 ? stderr : `exit ${result.status ?? 'unknown'}`;
}

function armEntry(
  pair: { primary: DispatchEntry | null; shadow: DispatchEntry | null },
  arm: ShadowApplyArm,
): DispatchEntry | null {
  return arm === 'challenger' ? pair.shadow : pair.primary;
}

/**
 * Port a shadow pair's diff into the real workspace with `git apply --3way`.
 *
 * A kernel verb rather than an instruction to a relay agent, per
 * `docs/experimental/slots-and-archetypes.md` ("Port-back is a kernel verb,
 * not an instruction") — applying a worktree's diff to the shared tree is
 * deterministic git mechanism, not a judgment call. `--3way` is used from the
 * first version because the main tree can move while a pair runs: a plain
 * `git apply` would refuse the moment context lines drift, where `--3way`
 * can still reconcile non-overlapping changes and — critically — never
 * invents a resolution for a real conflict. It stops, leaves the diff
 * artifact exactly where it was, and reports; it is never auto-resolved here
 * or by git.
 */
export function runShadowApply(opts: ShadowApplyOptions): ShadowApplyResult {
  const ref = (opts.ref ?? '').trim();
  if (ref === '') {
    throw new ShadowApplyCommandError('name a pair id or dispatch id (fadeno shadow-apply <pair-id|dispatch-id>).');
  }
  if (opts.arm != null && opts.arm !== 'challenger' && opts.arm !== 'primary') {
    throw new ShadowApplyCommandError(`invalid --arm "${opts.arm}" — use "challenger" or "primary".`);
  }
  const arm: ShadowApplyArm = (opts.arm as ShadowApplyArm | undefined) ?? 'challenger';
  const check = opts.check === true;
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const now = opts.now ?? new Date();

  const pair = resolveDispatchPair(ref, { cwd, repoRoot });
  const pairId8 = pair.pairId.slice(0, 8);
  const target = armEntry(pair, arm);

  // The primary of a shadow pair runs in the SHARED workspace by default —
  // write-shaped primaries getting their own worktree is explicitly deferred
  // (slots-and-archetypes.md, "Deliberately out of scope"). Its work is
  // therefore already in the caller's tree, and there is nothing to port
  // back — UNLESS it happened to run under `--isolate`, in which case its own
  // completion row carries a `diff_snapshot` exactly like a challenger's
  // (see dispatch.ts's `workspaceMode === 'isolated'` branch), and this falls
  // through to the ordinary path below rather than refusing.
  if (arm === 'primary' && (target == null || target.diffSnapshot == null)) {
    throw new ShadowApplyCommandError(
      `the primary arm of pair ${pairId8} ran in the shared workspace, not an isolated worktree — its work ` +
        'is already in your workspace, so there is nothing to apply. (A primary only records a diff_snapshot ' +
        '— and so only has something for shadow-apply to port back — when it ran under `--isolate`.)',
    );
  }

  if (target == null) {
    throw new ShadowApplyCommandError(`pair ${pairId8} has no recorded ${arm} evidence in this ledger.`);
  }

  if (target.diffSnapshot == null) {
    if (target.refusal != null) {
      throw new ShadowApplyCommandError(
        `the challenger in pair ${pairId8} was refused before it could run (${target.refusal.predicate}): ` +
          `${target.refusal.message} — there is no diff to apply.`,
      );
    }
    if (!target.completed) {
      throw new ShadowApplyCommandError(
        `the challenger in pair ${pairId8} has not completed yet (no diff_snapshot recorded) — wait for it ` +
          'to finish, or check `fadeno dispatches` for its status.',
      );
    }
    throw new ShadowApplyCommandError(
      `pair ${pairId8}'s ${arm} arm completed but recorded no diff_snapshot — nothing to apply.`,
    );
  }

  const diffRel = target.diffSnapshot;
  const diffAbs = isAbsolute(diffRel) ? diffRel : join(repoRoot, diffRel);
  if (!existsSync(diffAbs)) {
    throw new ShadowApplyCommandError(
      `pair ${pairId8}'s diff artifact is missing on disk: ${diffRel} — it may have already been cleaned up.`,
    );
  }

  const baselineCommit = target.baselineCommit;
  if (baselineCommit == null) {
    throw new ShadowApplyCommandError(
      `pair ${pairId8} has no recorded baseline_commit for its ${arm} arm — a 3-way apply needs a common ` +
        'ancestor and cannot proceed without one.',
    );
  }

  // The diff was captured with blob SHAs relative to `baseline_commit`
  // (`git diff --binary --cached` inside the challenger's worktree, staged
  // against the commit `commitWorkspaceBaseline` made there — see
  // dispatch.ts). `git apply --3way` needs those blobs, which live in the
  // repo's shared object database (worktrees share one) ONLY as long as
  // something keeps them reachable. The worktree's own detached HEAD is that
  // something: once `fadeno clean --force` deregisters and removes a
  // retained shadow worktree, the baseline commit is unreferenced and
  // eligible for the next `git gc` to collect — not necessarily gone
  // immediately (gc has its own grace period; verified against git 2.50.1
  // that a loose object survives a bare `worktree remove` and only vanishes
  // after `git gc --prune=now`), but no longer guaranteed to exist.
  //
  // Checked here, deliberately, instead of letting a stale baseline surface
  // as git's own "repository lacks the necessary blob to perform 3-way
  // merge... patch does not apply" — confusing on its own, and actively
  // misleading in this context because it reads like the *content* conflicts
  // when actually the *object* is gone.
  //
  // The durable fix — pinning the baseline commit under a ref at the moment
  // `commitWorkspaceBaseline` creates it, so no worktree-removal timing
  // window can ever unreference it — belongs in `commitWorkspaceBaseline`
  // (src/commands/dispatch.ts). That file is outside this change's
  // partition; recorded here as a recommendation for a later batch rather
  // than reached for.
  const baselineCheck = spawnSync(
    'git',
    ['-C', repoRoot, 'cat-file', '-e', `${baselineCommit}^{commit}`],
    { encoding: 'utf8' },
  );
  if (baselineCheck.status !== 0) {
    throw new ShadowApplyCommandError(
      `pair ${pairId8}'s baseline commit ${baselineCommit.slice(0, 8)} is no longer present in this ` +
        "repository's object database — most likely garbage-collected after its retained shadow worktree " +
        'was removed (`fadeno clean --force`). A 3-way apply needs those blobs and cannot proceed. The diff ' +
        `artifact is kept at ${diffRel} — it is a plain unified/binary diff, so it can still be applied by ` +
        'hand against a tree that already carries the same content baseline, but `shadow-apply`\'s `--3way` ' +
        'reconciliation cannot recover it automatically.',
    );
  }

  // `git apply --check --3way` never mutates the working tree or index —
  // verified — but on a patch that WOULD conflict it still exits 0 and
  // reports "Applied patch to '<path>' with conflicts." on stderr rather
  // than failing, so an exit-code-only read would misreport a conflicting
  // patch as clean. Real (non-check) `--3way`, by contrast, DOES exit
  // non-zero the moment any file is left with conflict markers (checked
  // against git 2.50.1). So `--check` here inspects the message text and a
  // real apply trusts the exit code; that asymmetry is git's own behavior,
  // not something invented for this command.
  const applyArgs = ['-C', repoRoot, 'apply', '--3way'];
  if (check) applyArgs.push('--check');
  applyArgs.push(diffAbs);
  const applyRes = spawnSync('git', applyArgs, { encoding: 'utf8' });
  const stderrText = (applyRes.stderr ?? '').trim();
  const dispatchId = target.dispatchId ?? '';

  if (check) {
    const clean = applyRes.status === 0 && !/with conflicts/.test(stderrText);
    return {
      pairId: pair.pairId,
      arm,
      dispatchId,
      artifact: diffRel,
      diffBytes: target.diffBytes,
      baselineCommit,
      check: true,
      clean,
      applied: false,
      detail: stderrText.length > 0 ? stderrText : clean ? 'would apply cleanly' : gitReason(applyRes),
    };
  }

  if (applyRes.status !== 0) {
    // A port-back is a real mutation attempt and belongs in the ledger like
    // any other dispatch outcome — including a failed one. `--check` writes
    // no row: it is the documented no-mutation preview, and the ledger is
    // part of the workspace this command promises `--check` leaves alone.
    appendEvidenceRow(repoRoot, {
      format: DISPATCHES_FORMAT,
      timestamp: now.toISOString(),
      event: 'shadow_apply',
      pair_id: pair.pairId,
      dispatch_id: dispatchId,
      arm,
      artifact: diffRel,
      baseline_commit: baselineCommit,
      check: false,
      outcome: 'conflict',
      detail: stderrText.length > 0 ? stderrText : gitReason(applyRes),
    });
    throw new ShadowApplyCommandError(
      `\`git apply --3way\` could not cleanly apply pair ${pairId8}'s ${arm} diff: ` +
        `${stderrText.length > 0 ? stderrText : gitReason(applyRes)}. The diff artifact is KEPT at ${diffRel} ` +
        `— apply it by hand once the tree settles (\`git apply --3way ${diffRel}\`, resolving any conflict ` +
        'markers `--3way` left behind) or retry `fadeno shadow-apply` later. Nothing was reverted: `--3way` ' +
        'may have already applied (and staged) some hunks cleanly while leaving others as unmerged conflict ' +
        'markers — this command never auto-resolves, so inspect `git status` before continuing.',
    );
  }

  appendEvidenceRow(repoRoot, {
    format: DISPATCHES_FORMAT,
    timestamp: now.toISOString(),
    event: 'shadow_apply',
    pair_id: pair.pairId,
    dispatch_id: dispatchId,
    arm,
    artifact: diffRel,
    baseline_commit: baselineCommit,
    check: false,
    outcome: 'applied',
  });

  return {
    pairId: pair.pairId,
    arm,
    dispatchId,
    artifact: diffRel,
    diffBytes: target.diffBytes,
    baselineCommit,
    check: false,
    clean: true,
    applied: true,
    detail: stderrText.length > 0 ? stderrText : 'applied cleanly',
  };
}

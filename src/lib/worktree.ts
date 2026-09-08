/**
 * Worktrees: where a dispatch does its work.
 *
 * One rule set, both lanes (spec §04): cut from HEAD or a named ref, never
 * from dirty state; on a branch named `fadeno/<name>` so git and the ledger
 * agree on one identifier; if `git worktree add` fails the spawn proceeds in
 * the shared tree and says so, because an environment problem must not cost
 * a turn. Nothing here consults or creates repo-wide state: two cuts never
 * collide, and cutting reads nothing but git.
 *
 * Removal never destroys a worktree holding uncommitted work. The branch is
 * left behind on purpose — the merge was real, and history survives.
 */

import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

export const WORKTREES_DIR = join('.fadeno', 'local', 'worktrees');
export const BRANCH_PREFIX = 'fadeno/';
export const BRANCH_NAME_MAX = 60;
export const GIT_TIMEOUT_MS = 20_000;
export const DIRTY_PATH_LIMIT = 200;

export type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

/** Canonical absolute path: git prints real paths, so compare real paths. */
export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (result.error != null) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === 'ETIMEDOUT'
          ? `git ${args[0]} did not answer within ${timeoutMs}ms`
          : `git could not be run: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    return { ok: false, error: stderr.length > 0 ? stderr : `git ${args[0]} exited ${result.status}` };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

/**
 * Branch-name sanitization is deliberately dumb: lowercase, one `-` for any
 * run of characters outside `[a-z0-9._-]`, trimmed to 60. A surprising branch
 * name is worse than an ugly one; a collision the trim creates is just another
 * collision for the duplicate counter.
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, BRANCH_NAME_MAX)
    .replace(/[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'dispatch';
}

/** `base`, then `base-2`, `base-3`… against everything already taken. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Branch names already in use, so a fresh name never collides with git's view. */
export function existingFadenoBranches(repoRoot: string): Set<string> {
  const listed = git(repoRoot, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${BRANCH_PREFIX}`]);
  const names = new Set<string>();
  if (!listed.ok) return names;
  for (const line of listed.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(BRANCH_PREFIX)) names.add(trimmed.slice(BRANCH_PREFIX.length));
  }
  return names;
}

export interface CutWorktree {
  /** Absolute path of the worktree. */
  absolute: string;
  /** Repo-relative path, as the ledger records it. */
  path: string;
  branch: string;
  /** Commit the worktree was cut from. */
  base: string;
  /** The ref the caller named, or the branch HEAD was on — what a worker merges from. */
  upstream: string;
}

export type CutOutcome = { ok: true; worktree: CutWorktree } | { ok: false; reason: string };

/** Tracked, uncommitted changes in a tree. Untracked scratch does not count. */
export function trackedDirtyPaths(dir: string): string[] | 'unavailable' {
  const status = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok) return 'unavailable';
  return status.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => line.slice(3));
}

/** Everything git would report, untracked included — what a stop row records. */
export function dirtyPaths(dir: string): { paths: string[]; truncated: boolean } | 'unavailable' {
  const status = git(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) return 'unavailable';
  const lines = status.stdout.split('\n').filter((line) => line.trim() !== '');
  return { paths: lines.slice(0, DIRTY_PATH_LIMIT).map((line) => line.slice(3)), truncated: lines.length > DIRTY_PATH_LIMIT };
}

/** The branch HEAD is on, or null when detached. */
export function currentBranch(dir: string): string | null {
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return head.ok ? head.stdout.trim() || null : null;
}

/**
 * Cut a worktree for `name` from `from` (default HEAD). The name must already
 * be unique — see `uniqueName` — because this consults nothing but git.
 */
export function cutWorktree(opts: { repoRoot: string; name: string; from?: string | null }): CutOutcome {
  const { repoRoot, name } = opts;
  const ref = opts.from?.trim() || 'HEAD';
  const base = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!base.ok) return { ok: false, reason: `"${ref}" is not a commit in this repository: ${base.error}` };
  const baseSha = base.stdout.trim();
  const upstream = ref === 'HEAD' ? currentBranch(repoRoot) ?? baseSha : ref;
  const branch = `${BRANCH_PREFIX}${name}`;
  const absolute = resolve(repoRoot, WORKTREES_DIR, name);
  if (existsSync(absolute)) return { ok: false, reason: `${relative(repoRoot, absolute)} already exists.` };
  try {
    mkdirSync(resolve(repoRoot, WORKTREES_DIR), { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not create ${WORKTREES_DIR}: ${(err as Error).message}` };
  }
  // A stale registration for a directory that is gone would make `add` refuse.
  git(repoRoot, ['worktree', 'prune']);
  const added = git(repoRoot, ['worktree', 'add', '-b', branch, absolute, baseSha]);
  if (!added.ok) return { ok: false, reason: added.error };
  return {
    ok: true,
    worktree: { absolute, path: relative(repoRoot, absolute), branch, base: baseSha, upstream },
  };
}

export interface RegisteredWorktree {
  absolute: string;
  path: string;
  branch: string | null;
  head: string | null;
  exists: boolean;
}

/** Fadeno's own worktrees as git knows them: under `WORKTREES_DIR` or on a `fadeno/` branch. */
export function listRegisteredWorktrees(repoRoot: string): RegisteredWorktree[] {
  const listed = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return [];
  const root = canonical(repoRoot);
  const out: RegisteredWorktree[] = [];
  let current: Partial<RegisteredWorktree> & { absolute?: string } = {};
  const flush = () => {
    if (current.absolute == null) return;
    const absolute = canonical(current.absolute);
    const branch = current.branch ?? null;
    const insideDir = absolute.startsWith(join(root, WORKTREES_DIR));
    if (absolute !== root && (insideDir || (branch != null && branch.startsWith(BRANCH_PREFIX)))) {
      out.push({
        absolute,
        path: relative(root, absolute),
        branch,
        head: current.head ?? null,
        exists: existsSync(absolute),
      });
    }
    current = {};
  };
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.absolute = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line.trim() === '') flush();
  }
  flush();
  return out;
}

export function isRegisteredWorktree(repoRoot: string, absolute: string): boolean {
  const target = canonical(absolute);
  return listRegisteredWorktrees(repoRoot).some((entry) => entry.absolute === target);
}

export interface WorktreeReport extends RegisteredWorktree {
  dirty: { paths: string[]; truncated: boolean } | 'unavailable';
  /** Commits on the branch that HEAD does not have — the work nobody merged. */
  unmerged: number | 'unavailable';
}

/**
 * What `fadeno worktrees` reports: every Fadeno worktree, with whether it
 * holds uncommitted changes and how many commits it carries that the
 * repository's HEAD does not. This is the cross-session safety net, so it
 * never answers "clean" for a tree it could not read.
 */
export function reportWorktrees(repoRoot: string): WorktreeReport[] {
  return listRegisteredWorktrees(repoRoot).map((entry) => {
    const dirty = entry.exists ? dirtyPaths(entry.absolute) : 'unavailable';
    let unmerged: number | 'unavailable' = 'unavailable';
    if (entry.branch != null) {
      const count = git(repoRoot, ['rev-list', '--count', `HEAD..${entry.branch}`]);
      if (count.ok) unmerged = Number.parseInt(count.stdout.trim(), 10) || 0;
    }
    return { ...entry, dirty, unmerged };
  });
}

export type RemoveOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Remove a worktree Fadeno registered. Refuses a tree with uncommitted
 * changes unless forced, refuses a path git does not know as a worktree
 * (a plain directory is never deleted on the ledger's word), and leaves the
 * branch alone.
 */
export function removeWorktree(opts: { repoRoot: string; absolute: string; force?: boolean }): RemoveOutcome {
  const absolute = canonical(opts.absolute);
  if (absolute === canonical(opts.repoRoot)) return { ok: false, reason: 'refusing to remove the repository root.' };
  if (!isRegisteredWorktree(opts.repoRoot, absolute)) {
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      return { ok: false, reason: `${absolute} is not a registered worktree; not deleting a plain directory.` };
    }
    // Directory gone, registration gone or stale: prune is all that is left.
    git(opts.repoRoot, ['worktree', 'prune']);
    return { ok: true };
  }
  if (existsSync(absolute) && !opts.force) {
    const dirty = dirtyPaths(absolute);
    if (dirty === 'unavailable') return { ok: false, reason: `${absolute}: could not read its status; not removing a tree that may hold work.` };
    if (dirty.paths.length > 0) {
      const sample = dirty.paths.slice(0, 5).join(', ');
      return { ok: false, reason: `${absolute} holds ${dirty.paths.length} uncommitted path(s) (${sample}); commit or discard them first, or pass --force.` };
    }
  }
  const removed = git(opts.repoRoot, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), absolute]);
  if (!removed.ok) return { ok: false, reason: removed.error };
  git(opts.repoRoot, ['worktree', 'prune']);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Measuring the work, and checking the one close verb that can be checked
// ---------------------------------------------------------------------------

/** Conflict-marker paths a measurement carries before it stops listing them. */
export const CONFLICT_PATH_LIMIT = 20;

/**
 * What a dispatch's branch holds, measured rather than asked.
 *
 * A worker's report is a claim. In one Basanos session three green reports
 * described a canary that could not fail, a feature that had never compiled
 * into the image, and an artifact built with the wrong toolchain; a director
 * asked afterwards for "structured dispatch results" so it could verify
 * without reading. A schema the agent fills in would not have caught any of
 * the three — `tests: 316 passed` is exactly as trustworthy as the sentence
 * saying so. These are the facts git already knows and no agent supplies.
 *
 * Everything here is relative to the repository's HEAD at the moment of
 * measurement, which makes it the same diff a reviewer would open: commits the
 * branch carries that HEAD does not, and the merge-base diff between them.
 */
export interface WorkMeasured {
  /** The branch's own tip. */
  head: string;
  /** Commits on the branch that the repository's HEAD does not have. */
  commits: number;
  files: number;
  insertions: number;
  deletions: number;
  /** Binary files in the diff, which have no line counts to add. */
  binary: number;
  /**
   * Paths the branch changed that still carry conflict markers. Only changed
   * paths are searched: a file this dispatch never touched cannot hold markers
   * it introduced, and a repository whose own documentation shows markers
   * would otherwise report itself as broken.
   */
  conflicts: string[];
  conflicts_truncated?: true;
}

const CONFLICT_MARKER = '^(<<<<<<<|>>>>>>>) ';

/**
 * Measure a dispatch branch against the repository's HEAD. Returns null when
 * there is nothing to measure — a shared-tree dispatch has no branch of its
 * own, and work committed onto the current branch is indistinguishable from
 * everyone else's, which is a reason to report nothing rather than a guess.
 */
export function measureWork(opts: { repoRoot: string; branch: string | null | undefined }): WorkMeasured | null {
  const { repoRoot } = opts;
  const branch = opts.branch?.trim();
  if (branch == null || branch === '') return null;
  const head = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (!head.ok) return null;

  const counted = git(repoRoot, ['rev-list', '--count', `HEAD..${branch}`]);
  const measured: WorkMeasured = {
    head: head.stdout.trim(),
    commits: counted.ok ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0,
    files: 0,
    insertions: 0,
    deletions: 0,
    binary: 0,
    conflicts: [],
  };

  // Three dots: the diff from where the branch and HEAD diverged, so a worker
  // that did as its contract asked and merged upstream in before finishing is
  // not credited with everyone else's changes.
  const stat = git(repoRoot, ['diff', '--numstat', `HEAD...${branch}`]);
  const changed: string[] = [];
  if (stat.ok) {
    for (const line of stat.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const [ins, del, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (path === '') continue;
      measured.files += 1;
      changed.push(path);
      if (ins === '-' || del === '-') measured.binary += 1;
      else {
        measured.insertions += Number.parseInt(ins ?? '0', 10) || 0;
        measured.deletions += Number.parseInt(del ?? '0', 10) || 0;
      }
    }
  }

  if (changed.length > 0) {
    // `git grep` against the branch searches what was COMMITTED, which is the
    // failure worth catching: a conflict resolved badly in the working tree is
    // the author's problem until they commit it, and then it is everyone's.
    const found = git(repoRoot, ['grep', '-l', '-E', CONFLICT_MARKER, branch, '--', ...changed]);
    if (found.ok) {
      const paths = found.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => (line.startsWith(`${branch}:`) ? line.slice(branch.length + 1) : line));
      measured.conflicts = paths.slice(0, CONFLICT_PATH_LIMIT);
      if (paths.length > CONFLICT_PATH_LIMIT) measured.conflicts_truncated = true;
    }
  }
  return measured;
}

/**
 * Whether a `--merged` claim is true, as far as git can say.
 *
 * `--merged` is the only close verb that asserts something about the world
 * rather than about the host's intent, and so the only one Fadeno can check.
 * A director that ran a day of dispatches closed two before checking the merge
 * result and committed conflict markers once, and named the fifteen seconds
 * between merging and closing as where its mistakes lived. The check is that
 * tripwire: cheap, mechanical, and overridable, because a squash or a rebase
 * lands the work without leaving the branch reachable and Fadeno must not call
 * that a lie.
 */
export interface MergeCheck {
  /** False when there was nothing to check against; then nothing is claimed. */
  checked: boolean;
  /** Why the claim could not be checked. */
  reason: string | null;
  /** Commits on the branch that HEAD does not have. */
  unmerged: number;
  /** Tracked, uncommitted paths in the worktree: work no merge could have taken. */
  uncommitted: string[];
}

export function verifyMerged(opts: { repoRoot: string; branch: string | null | undefined; worktree?: string | null }): MergeCheck {
  const unchecked = (reason: string): MergeCheck => ({ checked: false, reason, unmerged: 0, uncommitted: [] });
  const branch = opts.branch?.trim();
  if (branch == null || branch === '') return unchecked('the dispatch worked in the shared tree, so it has no branch to look for');
  const exists = git(opts.repoRoot, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (!exists.ok) return unchecked(`branch ${branch} no longer exists`);
  const counted = git(opts.repoRoot, ['rev-list', '--count', `HEAD..${branch}`]);
  if (!counted.ok) return unchecked(`git could not compare ${branch} with HEAD: ${counted.error}`);

  let uncommitted: string[] = [];
  if (opts.worktree != null && existsSync(opts.worktree)) {
    // Tracked only: an unbuilt `node_modules` in a worktree is not lost work.
    const dirty = trackedDirtyPaths(opts.worktree);
    if (dirty !== 'unavailable') uncommitted = dirty;
  }
  return { checked: true, reason: null, unmerged: Number.parseInt(counted.stdout.trim(), 10) || 0, uncommitted };
}

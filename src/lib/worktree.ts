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

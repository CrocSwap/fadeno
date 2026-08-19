import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { collectIsolatedDiff, isRegisteredWorktree, removeIsolatedWorktree, WORKSPACE_LEASE_LOCK_STALE_MS, WorkspaceLeaseError } from './workspace-lease.ts';

export const HOST_WORKSPACE_SCHEMA_VERSION = '1.0';
export const HOST_WORKTREES_DIR = join('.fadeno', 'local', 'host-worktrees');
export const HOST_WORKSPACES_DIR = join('.fadeno', 'local', 'host-workspaces');
export const HOST_WORKSPACE_LOCK = join('.fadeno', 'local', '.host-workspace.lock');
export const HOST_ISOLATED_DIFF_DIR = join('.fadeno', 'local', 'outputs');
export const HOST_WORKSPACE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class HostWorkspaceError extends Error {}

export interface HostWorkspaceState {
  schema_version: '1.0';
  run: string;
  dispatch_id: string;
  workspace_mode: 'isolated';
  workspace: string;
  base_commit: string;
  prepared_at: string;
  diff_snapshot?: string;
  diff_bytes?: number;
  finalized_at?: string;
}

function waitSync(ms: number): void {
  const sig = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sig, 0, 0, ms);
}

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 30_000;

export function withHostWorkspaceLock<T>(repoRoot: string, action: () => T): T {
  const lockPath = join(repoRoot, HOST_WORKSPACE_LOCK);
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > WORKSPACE_LEASE_LOCK_STALE_MS;
      } catch {
        // competing writer released between mkdir/stat
      }
      if (stale) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new HostWorkspaceError(`timed out waiting for the host workspace lock at ${lockPath}.`);
      }
      waitSync(LOCK_WAIT_MS);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function validateSegment(value: string, label: string): void {
  if (value === '.' || value === '..') {
    throw new HostWorkspaceError(`invalid ${label}: must not be "." or ".."; got ${JSON.stringify(value)}`);
  }
  if (!HOST_WORKSPACE_SEGMENT_RE.test(value)) {
    throw new HostWorkspaceError(`invalid ${label}: must match ${HOST_WORKSPACE_SEGMENT_RE}; got ${JSON.stringify(value)}`);
  }
}

function validateRunAndDispatch(run: string, dispatchId: string): void {
  validateSegment(run, 'run');
  validateSegment(dispatchId, 'dispatch_id');
}

export function isHostPathSafe(repoRoot: string, repoRel: string): boolean {
  try {
    assertHostPathSafe(repoRoot, repoRel);
    return true;
  } catch {
    return false;
  }
}

function assertHostPathSafe(repoRoot: string, repoRel: string): string {
  const abs = resolve(repoRoot, repoRel);
  const localAbs = resolve(repoRoot, '.fadeno', 'local');
  // Ensure abs is under localAbs
  if (abs !== localAbs && !abs.startsWith(localAbs + sep)) {
    // Also handle case where relative would escape
    const relToLocal = relative(localAbs, abs);
    // relative may use OS sep; normalize check
    if (relToLocal === '..' || relToLocal.startsWith(`..${sep}`) || relToLocal.startsWith('../') || isAbsolute(relToLocal)) {
      throw new HostWorkspaceError(`path escapes .fadeno/local: ${repoRel}`);
    }
    // If still not under, throw generically
    throw new HostWorkspaceError(`path escapes .fadeno/local: ${repoRel}`);
  }
  // lstat walk for symlink detection, same shape as safeRunRelative
  let cursor = resolve(repoRoot);
  const segments = repoRel.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new HostWorkspaceError(`path traverses a symlink: ${repoRel}`);
      }
    } catch (err) {
      if (err instanceof HostWorkspaceError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
  // realpath escape check — handle /tmp -> /private/tmp symlink on macOS
  let repoReal: string;
  try {
    repoReal = realpathSync(resolve(repoRoot));
  } catch {
    repoReal = resolve(repoRoot);
  }
  const localReal = join(repoReal, '.fadeno', 'local');
  let existing = abs;
  let existingReal: string | null = null;
  for (;;) {
    try {
      existingReal = realpathSync(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(existing);
      if (parent === existing) throw new HostWorkspaceError(`path cannot be resolved: ${repoRel}`);
      existing = parent;
    }
  }
  if (existingReal != null) {
    const suffix = relative(existing, abs);
    const resolvedTarget = resolve(existingReal, suffix);
    const realRel = relative(localReal, resolvedTarget).split('\\').join('/');
    if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
      throw new HostWorkspaceError(`path escapes .fadeno/local through a symlink: ${repoRel}`);
    }
    if (resolvedTarget !== localReal && !resolvedTarget.startsWith(localReal + sep)) {
      if (realRel.startsWith('..')) {
        throw new HostWorkspaceError(`path escapes .fadeno/local through a symlink: ${repoRel}`);
      }
      // Fallback string check for non-normalized separator
      if (!resolvedTarget.startsWith(localReal + '/') && !resolvedTarget.startsWith(localReal + sep)) {
        // On macOS, resolvedTarget uses real /private/tmp while localReal also uses real, so this should not trigger for valid paths
        // But if it does not start with localReal, it escapes
        if (realRel.startsWith('..') || realRel === '..') {
          throw new HostWorkspaceError(`path escapes .fadeno/local through a symlink: ${repoRel}`);
        }
      }
    }
  }
  return abs;
}

export function hostWorktreePath(run: string, dispatchId: string): string {
  validateRunAndDispatch(run, dispatchId);
  return join(HOST_WORKTREES_DIR, run, dispatchId).split('\\').join('/');
}

export function hostWorkspaceStatePath(run: string, dispatchId: string): string {
  validateRunAndDispatch(run, dispatchId);
  return join(HOST_WORKSPACES_DIR, run, `${dispatchId}.json`).split('\\').join('/');
}

export function hostIsolatedDiffPath(run: string, dispatchId: string): string {
  validateRunAndDispatch(run, dispatchId);
  return join(HOST_ISOLATED_DIFF_DIR, `host-isolated-${run}-${dispatchId}.diff`).split('\\').join('/');
}

function writeStateAtomic(repoRoot: string, state: HostWorkspaceState): void {
  const rel = hostWorkspaceStatePath(state.run, state.dispatch_id);
  const abs = assertHostPathSafe(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function readHostWorkspaceState(repoRoot: string, run: string, dispatchId: string): HostWorkspaceState | null {
  validateRunAndDispatch(run, dispatchId);
  const rel = hostWorkspaceStatePath(run, dispatchId);
  const abs = assertHostPathSafe(repoRoot, rel);
  if (!existsSync(abs)) return null;
  // lstat already checked via assert, but also ensure not symlink file itself? assert already checks segments including file
  // Additional symlink check for file itself: if file is symlink, lstat would have caught? Actually file exists, lstat walk includes file segment, so caught
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new HostWorkspaceError(`could not read host workspace state at ${rel}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HostWorkspaceError(`host workspace state at ${rel} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HostWorkspaceError(`host workspace state at ${rel} is not an object`);
  }
  const doc = parsed as Record<string, unknown>;
  // Minimal validation; if invalid, throw HostWorkspaceError
  if (doc.schema_version !== HOST_WORKSPACE_SCHEMA_VERSION) {
    throw new HostWorkspaceError(`host workspace state at ${rel} has invalid schema_version`);
  }
  if (typeof doc.run !== 'string' || typeof doc.dispatch_id !== 'string') {
    throw new HostWorkspaceError(`host workspace state at ${rel} missing run/dispatch_id`);
  }
  if (doc.workspace_mode !== 'isolated') {
    throw new HostWorkspaceError(`host workspace state at ${rel} has invalid workspace_mode`);
  }
  if (typeof doc.workspace !== 'string' || typeof doc.base_commit !== 'string' || typeof doc.prepared_at !== 'string') {
    throw new HostWorkspaceError(`host workspace state at ${rel} missing required fields`);
  }
  if (!/^[0-9a-f]{40}$/.test(doc.base_commit)) {
    throw new HostWorkspaceError(`host workspace state at ${rel} has invalid base_commit`);
  }
  if (doc.diff_snapshot != null) {
    if (typeof doc.diff_snapshot !== 'string') {
      throw new HostWorkspaceError(`host workspace state at ${rel} has invalid diff_snapshot`);
    }
    try {
      assertHostPathSafe(repoRoot, doc.diff_snapshot);
    } catch (err) {
      if (err instanceof HostWorkspaceError) {
        throw new HostWorkspaceError(`host workspace state at ${rel} has invalid diff_snapshot: ${(err as Error).message}`);
      }
      throw err;
    }
  }
  if (doc.diff_bytes != null) {
    if (typeof doc.diff_bytes !== 'number' || !Number.isInteger(doc.diff_bytes) || doc.diff_bytes < 0) {
      throw new HostWorkspaceError(`host workspace state at ${rel} has invalid diff_bytes`);
    }
  }
  if ((doc.diff_snapshot != null) !== (doc.diff_bytes != null)) {
    throw new HostWorkspaceError(`host workspace state at ${rel} has mismatched diff_snapshot/diff_bytes`);
  }
  // Allow optional fields
  return parsed as HostWorkspaceState;
}

export function prepareHostWorkspace(opts: { repoRoot: string; run: string; dispatchId: string; now?: Date }): { state: HostWorkspaceState; idempotent: boolean } {
  const { repoRoot, run, dispatchId } = opts;
  validateRunAndDispatch(run, dispatchId);
  // Validate paths safe before entering lock (early fail)
  const worktreeRel = hostWorktreePath(run, dispatchId);
  const stateRel = hostWorkspaceStatePath(run, dispatchId);
  assertHostPathSafe(repoRoot, worktreeRel);
  assertHostPathSafe(repoRoot, stateRel);
  const diffRel = hostIsolatedDiffPath(run, dispatchId);
  assertHostPathSafe(repoRoot, diffRel);

  return withHostWorkspaceLock(repoRoot, () => {
    const statePathAbs = assertHostPathSafe(repoRoot, stateRel);
    const worktreeAbs = assertHostPathSafe(repoRoot, worktreeRel);
    // read existing state (inside lock)
    let existing: HostWorkspaceState | null = null;
    if (existsSync(statePathAbs)) {
      existing = readHostWorkspaceState(repoRoot, run, dispatchId);
    }
    if (existing != null) {
      // Check worktree existence
      let worktreeExists = false;
      try {
        worktreeExists = existsSync(worktreeAbs) && statSync(worktreeAbs).isDirectory();
      } catch {
        worktreeExists = false;
      }
      if (worktreeExists) {
        if (!isRegisteredWorktree(repoRoot, worktreeAbs)) {
          throw new HostWorkspaceError(
            `host worktree at "${worktreeRel}" exists but is not registered; inspect or remove it before retrying isolated preparation.`,
          );
        }
        return { state: existing, idempotent: true };
      }
      // worktree missing -> re-create at recorded base_commit
      // prune and add
      mkdirSync(dirname(worktreeAbs), { recursive: true });
      try {
        spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' });
      } catch {}
      const add = spawnSync('git', ['worktree', 'add', '--detach', worktreeAbs, existing.base_commit], { cwd: repoRoot, encoding: 'utf8' });
      if (add.error != null || add.status !== 0) {
        const raw = add.error?.message ?? (add.stderr != null ? String(add.stderr).trim() : '');
        const reason = raw || `exit ${add.status ?? 'unknown'}`;
        throw new HostWorkspaceError(`host worktree could not be re-created: ${String(reason).slice(0, 4000)}`);
      }
      return { state: existing, idempotent: true };
    }

    // No existing state: create new
    const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    if (rev.error != null || rev.status !== 0) {
      const rawRev = rev.error?.message ?? (rev.stderr != null ? String(rev.stderr).trim() : '');
      const reason = rawRev || `exit ${rev.status ?? 'unknown'}`;
      throw new HostWorkspaceError(`could not resolve HEAD: ${String(reason).slice(0, 4000)}`);
    }
    const baseCommit = String(rev.stdout).trim();
    if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
      throw new HostWorkspaceError(`invalid base_commit from HEAD: ${baseCommit}`);
    }
    mkdirSync(dirname(worktreeAbs), { recursive: true });
    try {
      spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' });
    } catch {}
    const add = spawnSync('git', ['worktree', 'add', '--detach', worktreeAbs, baseCommit], { cwd: repoRoot, encoding: 'utf8' });
    if (add.error != null || add.status !== 0) {
      const raw2 = add.error?.message ?? (add.stderr != null ? String(add.stderr).trim() : '');
      const reason = raw2 || `exit ${add.status ?? 'unknown'}`;
      throw new HostWorkspaceError(`isolated worktree could not be created: ${String(reason).slice(0, 4000)}`);
    }
    const now = opts.now ?? new Date();
    const state: HostWorkspaceState = {
      schema_version: HOST_WORKSPACE_SCHEMA_VERSION,
      run: run,
      dispatch_id: dispatchId,
      workspace_mode: 'isolated',
      workspace: worktreeRel,
      base_commit: baseCommit,
      prepared_at: now.toISOString(),
    };
    writeStateAtomic(repoRoot, state);
    return { state, idempotent: false };
  });
}

export function collectHostWorkspaceDiff(opts: { repoRoot: string; state: HostWorkspaceState }): { state: HostWorkspaceState; diffSnapshot: string; diffBytes: number } {
  const { repoRoot, state } = opts;
  // Validate identifiers from state
  validateRunAndDispatch(state.run, state.dispatch_id);
  const worktreeRel = state.workspace;
  const diffRel = hostIsolatedDiffPath(state.run, state.dispatch_id);
  // Validate paths safe before lock
  assertHostPathSafe(repoRoot, worktreeRel);
  assertHostPathSafe(repoRoot, diffRel);

  return withHostWorkspaceLock(repoRoot, () => {
    // Re-read latest state file for idempotency
    const current = readHostWorkspaceState(repoRoot, state.run, state.dispatch_id);
    const effective = current ?? state;
    // Check if already finalized and diff file exists -> reuse only when diff_snapshot is safe
    if (effective.diff_snapshot != null && effective.diff_bytes != null) {
      let safe = false;
      try {
        assertHostPathSafe(repoRoot, effective.diff_snapshot);
        safe = true;
      } catch {}
      if (safe) {
        const existingDiffAbs = resolve(repoRoot, effective.diff_snapshot);
        if (existsSync(existingDiffAbs)) {
          return { state: effective, diffSnapshot: effective.diff_snapshot, diffBytes: effective.diff_bytes };
        }
      }
    }

    const result = collectVerifiedIsolatedDiff({ repoRoot, workspaceRel: effective.workspace, diffRel });

    const finalizedAt = new Date().toISOString();
    const updated: HostWorkspaceState = {
      ...effective,
      diff_snapshot: result.diffRel.split('\\').join('/'),
      diff_bytes: result.diffBytes,
      finalized_at: finalizedAt,
    };
    writeStateAtomic(repoRoot, updated);
    return { state: updated, diffSnapshot: updated.diff_snapshot!, diffBytes: updated.diff_bytes! };
  });
}

function collectVerifiedIsolatedDiff(opts: { repoRoot: string; workspaceRel: string; diffRel: string }): { diffRel: string; diffAbs: string; diffBytes: number } {
  const worktreeAbs = assertHostPathSafe(opts.repoRoot, opts.workspaceRel);
  const diffAbs = assertHostPathSafe(opts.repoRoot, opts.diffRel);
  if (!isRegisteredWorktree(opts.repoRoot, worktreeAbs)) {
    throw new HostWorkspaceError(`isolated worktree is not a registered worktree at ${opts.workspaceRel}`);
  }
  try {
    return collectIsolatedDiff({ repoRoot: opts.repoRoot, worktreeAbs, diffAbs, diffRel: opts.diffRel });
  } catch (err) {
    if (err instanceof HostWorkspaceError) throw err;
    if (err instanceof WorkspaceLeaseError) throw new HostWorkspaceError(err.message);
    throw new HostWorkspaceError((err as Error).message ?? String(err));
  }
}

export function collectIsolatedRecoveryDiff(opts: { repoRoot: string; run: string; dispatchId: string; workspaceRel: string }): { diffSnapshot: string; diffBytes: number } {
  const { repoRoot, run, dispatchId, workspaceRel } = opts;
  let diffRel: string;
  try {
    validateRunAndDispatch(run, dispatchId);
    diffRel = hostIsolatedDiffPath(run, dispatchId);
    assertHostPathSafe(repoRoot, workspaceRel);
    assertHostPathSafe(repoRoot, diffRel);
  } catch (err) {
    if (err instanceof HostWorkspaceError) throw err;
    throw new HostWorkspaceError((err as Error).message ?? String(err));
  }
  return withHostWorkspaceLock(repoRoot, () => {
    const result = collectVerifiedIsolatedDiff({ repoRoot, workspaceRel, diffRel });
    return { diffSnapshot: result.diffRel.split('\\').join('/'), diffBytes: result.diffBytes };
  });
}

export function removeHostWorkspaceByPath(opts: { repoRoot: string; run: string; dispatchId: string; workspaceRel: string }): void {
  validateRunAndDispatch(opts.run, opts.dispatchId);
  assertHostPathSafe(opts.repoRoot, opts.workspaceRel);
  return withHostWorkspaceLock(opts.repoRoot, () => {
    const worktreeAbs = assertHostPathSafe(opts.repoRoot, opts.workspaceRel);
    if (!isRegisteredWorktree(opts.repoRoot, worktreeAbs)) return;
    try {
      removeIsolatedWorktree(opts.repoRoot, worktreeAbs);
    } catch {
      // best-effort
    }
  });
}

export function removeHostWorkspace(opts: { repoRoot: string; state: HostWorkspaceState }): void {
  // Retain finalized state file for idempotency — do not delete
  return removeHostWorkspaceByPath({ repoRoot: opts.repoRoot, run: opts.state.run, dispatchId: opts.state.dispatch_id, workspaceRel: opts.state.workspace });
}

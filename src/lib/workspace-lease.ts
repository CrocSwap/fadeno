/**
 * Repo-wide writer leasing and isolated worktree delivery.
 *
 * Machine-local shared-writer state lives below `.fadeno/local/` and is never
 * ledger evidence. A live `shared` writer blocks every other shared
 * write-capable command or host dispatch across runs. Read-only and
 * `isolated` deliveries bypass the lease because they cannot mutate the shared
 * worktree.
 *
 * The lease record distinguishes every process fact the contract names:
 * `supervisor_pid`, `executor_pid`, `process_group_id`, `started_at`,
 * `heartbeat_at`, `last_output_at`, `stdout_bytes`, `stderr_bytes`, plus
 * `workspace_mode` (`shared` | `isolated`). `isolated` records are never
 * written to the shared lease file; they bypass it entirely.
 *
 * All persistent state writes are atomic (write-then-rename) or
 * lock-protected (mkdir LM). Stale leases (dead supervisor pid) are
 * reclaimable so a crashed writer cannot permanently block the repo.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/** Exactly the two workspace modes the contract allows. */
export type WorkspaceMode = 'shared' | 'isolated';

export const WORKSPACE_MODES = ['shared', 'isolated'] as const;

/** Repo-relative lease path — machine-local, never committed, never ledger. */
export const WORKSPACE_LEASE_FILE = join('.fadeno', 'local', 'workspace-lease.json');

/** Lock directory for atomic lease transitions (mkdir is the primitive). */
export const WORKSPACE_LEASE_LOCK = join('.fadeno', 'local', '.workspace-lease.lock');

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 30_000;
/** Shared stale-lock threshold used by both the kernel and embedded supervisor. */
export const WORKSPACE_LEASE_LOCK_STALE_MS = 120_000;

export class WorkspaceLeaseError extends Error {}

export interface LeaseHolder {
  /** Human-readable holder identity, e.g. dispatchId or run:step. */
  id: string;
  kind: 'ad-hoc' | 'engine' | 'host-dispatch';
  runId?: string;
  dispatchId?: string;
}

/**
 * What lives on disk under `.fadeno/local/workspace-lease.json` when a
 * shared writer is active. Field names match the contract's snake_case tokens
 * so `fadeno show` can project them without translation; the TS interface
 * keeps camelCase accessors where convenient via helpers.
 */
export interface WorkspaceLeaseRecord {
  workspace_mode: WorkspaceMode;
  /** Primary holder retained for backward-compatible readers. */
  holder: LeaseHolder;
  /** Every active holder; multiple entries are retained only for legacy records. */
  holders?: LeaseHolder[];
  /** Per-holder times preserve accurate observability for legacy records. */
  holder_started_at?: Record<string, string>;
  holder_heartbeat_at?: Record<string, string>;
  supervisor_pid: number | null;
  executor_pid: number | null;
  process_group_id: number | null;
  started_at: string;
  heartbeat_at: string;
  last_output_at: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
}

/** Options for acquiring the shared writer lease. */
export interface AcquireWorkspaceLeaseOptions {
  repoRoot: string;
  workspaceMode: WorkspaceMode;
  holder: LeaseHolder;
  supervisorPid?: number | null;
  executorPid?: number | null;
  processGroupId?: number | null;
  startedAt?: Date;
  heartbeatAt?: Date;
  lastOutputAt?: Date | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  /** Injectable liveness probe for tests (pid, signal) => void. */
  probe?: (pid: number, signal: number) => void;
  now?: Date;
}

/** Options for releasing the lease. */
export interface ReleaseWorkspaceLeaseOptions {
  repoRoot: string;
  holder?: LeaseHolder;
  holderId?: string;
}

/** Options for heartbeating the current lease. */
export interface HeartbeatWorkspaceLeaseOptions {
  repoRoot: string;
  holder?: LeaseHolder;
  holderId: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  lastOutputAt?: Date | null;
  heartbeatAt?: Date;
  probe?: (pid: number, signal: number) => void;
  now?: Date;
}

export interface IsolatedWorktreeOptions {
  repoRoot: string;
  /** Absolute path to the worktree the caller wants (under `.fadeno/local/isolated/<id>`). */
  worktreePath: string;
  now?: Date;
  onEcho?: (line: string) => void;
}

export interface IsolatedWorktreeResult {
  /** Absolute worktree path. */
  worktreeAbs: string;
  /** Repo-relative worktree path. */
  worktreeRel: string;
}

export interface IsolatedDiffOptions {
  repoRoot: string;
  worktreeAbs: string;
  /** Where to write the binary diff (absolute). */
  diffAbs: string;
  /** Repo-relative diff path for evidence. */
  diffRel: string;
  now?: Date;
}

export interface IsolatedDiffResult {
  diffRel: string;
  diffAbs: string;
  diffBytes: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function waitSync(ms: number): void {
  const sig = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sig, 0, 0, ms);
}

function withLeaseLock<T>(repoRoot: string, action: () => T): T {
  const lockPath = join(repoRoot, WORKSPACE_LEASE_LOCK);
  // ensure parent exists — temp repos may be empty
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
        throw new WorkspaceLeaseError(`timed out waiting for the workspace lease lock at ${lockPath}.`);
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

function isValidMode(value: unknown): value is WorkspaceMode {
  return value === 'shared' || value === 'isolated';
}

function probeIsAlive(pid: number | null, probe: (pid: number, signal: number) => void): boolean {
  if (pid == null) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function defaultProbe(pid: number, signal: number): void {
  process.kill(pid, signal as 0);
}

function parseHolder(value: unknown): LeaseHolder | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const holder = value as Record<string, unknown>;
  if (typeof holder.id !== 'string' || holder.id.length === 0) return null;
  if (holder.kind !== 'ad-hoc' && holder.kind !== 'engine' && holder.kind !== 'host-dispatch') return null;
  if (holder.runId != null && typeof holder.runId !== 'string') return null;
  if (holder.dispatchId != null && typeof holder.dispatchId !== 'string') return null;
  return {
    id: holder.id,
    kind: holder.kind,
    ...(typeof holder.runId === 'string' ? { runId: holder.runId } : {}),
    ...(typeof holder.dispatchId === 'string' ? { dispatchId: holder.dispatchId } : {}),
  };
}

function readRecord(repoRoot: string): WorkspaceLeaseRecord | null {
  const abs = join(repoRoot, WORKSPACE_LEASE_FILE);
  if (!existsSync(abs)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  if (!isValidMode(doc.workspace_mode)) return null;
  if (doc.workspace_mode === 'isolated') return null; // isolated never occupies the shared lease file
  const holder = parseHolder(doc.holder);
  if (holder == null) return null;
  let holders: LeaseHolder[] | undefined;
  if (doc.holders != null) {
    if (!Array.isArray(doc.holders) || doc.holders.length === 0) return null;
    holders = doc.holders.map(parseHolder).filter((item): item is LeaseHolder => item != null);
    if (holders.length !== doc.holders.length) return null;
  }
  const sup = doc.supervisor_pid;
  const exec = doc.executor_pid;
  const pgid = doc.process_group_id;
  if (sup != null && (typeof sup !== 'number' || !Number.isInteger(sup) || sup <= 0)) return null;
  if (exec != null && (typeof exec !== 'number' || !Number.isInteger(exec) || exec <= 0)) return null;
  if (pgid != null && (typeof pgid !== 'number' || !Number.isInteger(pgid) || pgid <= 0)) return null;
  if (typeof doc.started_at !== 'string' || Number.isNaN(Date.parse(doc.started_at))) return null;
  if (typeof doc.heartbeat_at !== 'string' || Number.isNaN(Date.parse(doc.heartbeat_at))) return null;
  if (doc.last_output_at != null && (typeof doc.last_output_at !== 'string' || Number.isNaN(Date.parse(doc.last_output_at as string)))) return null;
  if (typeof doc.stdout_bytes !== 'number' || typeof doc.stderr_bytes !== 'number') return null;
  return { ...(doc as unknown as WorkspaceLeaseRecord), holder, ...(holders == null ? {} : { holders }) };
}

function writeRecordAtomic(repoRoot: string, record: WorkspaceLeaseRecord): void {
  const abs = join(repoRoot, WORKSPACE_LEASE_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, abs);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function sameHolder(left: LeaseHolder, right: LeaseHolder): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.runId === right.runId
    && left.dispatchId === right.dispatchId;
}

export function workspaceLeaseHolderKey(holder: LeaseHolder): string {
  return JSON.stringify([holder.kind, holder.id, holder.runId ?? null, holder.dispatchId ?? null]);
}

function activeHolders(record: WorkspaceLeaseRecord): LeaseHolder[] {
  return record.holders == null || record.holders.length === 0 ? [record.holder] : record.holders;
}

function includesHolder(record: WorkspaceLeaseRecord, holder: LeaseHolder): boolean {
  return activeHolders(record).some((candidate) => sameHolder(candidate, holder));
}

// ---------------------------------------------------------------------------
// Public API — shared lease
// ---------------------------------------------------------------------------

/**
 * Read the current shared-writer lease, or null when none is held.
 * A stale lease (supervisor pid proven dead) is treated as absent by
 * `isWorkspaceLeaseAlive` but still returned here for observability; callers
 * that need “effective” lease should use `readEffectiveLease`.
 */
export function readWorkspaceLease(repoRoot: string): WorkspaceLeaseRecord | null {
  return readRecord(repoRoot);
}

/**
 * Whether the given lease record is still live on this machine.
 * `false` is proof every published process identity is gone (ESRCH); `true` is
 * conservative (EPERM or still alive). A record with no supervisor_pid is a durable
 * reservation (notably a host dispatch, or a pre-spawn command handoff) and
 * remains conservatively live until its owning terminal path releases it.
 * Once a command supervisor publishes identity, any live supervisor,
 * executor, or detached process group keeps the lease blocking.
 * Host recovery is explicit (`dispatch-complete` / `dispatch-fail`); optional
 * progress observations never weaken mutual exclusion.
 */
export function isWorkspaceLeaseAlive(
  record: WorkspaceLeaseRecord | null,
  probe: (pid: number, signal: number) => void = defaultProbe,
): boolean {
  if (record == null) return false;
  if (record.workspace_mode !== 'shared') return false;
  if (record.supervisor_pid == null) return true;
  if (probeIsAlive(record.supervisor_pid, probe)) return true;
  // A SIGKILLed supervisor cannot reap its detached executor group. Keep the
  // lease blocking until every published process identity is proven absent;
  // otherwise the kernel could admit a second writer beside the orphan.
  if (record.process_group_id != null && probeIsAlive(-record.process_group_id, probe)) return true;
  if (record.executor_pid != null && probeIsAlive(record.executor_pid, probe)) return true;
  return false;
}

/**
 * Effective lease: the on-disk record only when it is both present and
 * live. Stale or isolated records are treated as absent.
 */
export function readEffectiveLease(
  repoRoot: string,
  probe: (pid: number, signal: number) => void = defaultProbe,
): WorkspaceLeaseRecord | null {
  const rec = readRecord(repoRoot);
  if (rec == null) return null;
  return isWorkspaceLeaseAlive(rec, probe) ? rec : null;
}

/**
 * Acquire the repo-wide shared writer lease.
 *
 * - `workspaceMode === 'isolated'` bypasses the lease entirely (returns null)
 *   because an isolated delivery cannot mutate the shared worktree.
 * - When `workspaceMode === 'shared'` and a live shared lease is already held
 *   by a different holder, throws `WorkspaceLeaseError` with a message naming
 *   the blocker. The same holder may re-acquire idempotently (heartbeat
 *   refresh).
 * - A stale lease (dead supervisor pid) is reclaimed atomically.
 * - All file transitions are lock-protected and atomic.
 *
 * Returns the acquired (or refreshed) record, or null when bypassed.
 */
export function acquireWorkspaceLease(opts: AcquireWorkspaceLeaseOptions): WorkspaceLeaseRecord | null {
  if (!isValidMode(opts.workspaceMode)) {
    throw new WorkspaceLeaseError(`workspace_mode must be "shared" or "isolated"; got ${JSON.stringify(opts.workspaceMode)}`);
  }
  if (opts.workspaceMode === 'isolated') {
    return null;
  }
  if (opts.holder == null || typeof opts.holder.id !== 'string' || opts.holder.id.length === 0) {
    throw new WorkspaceLeaseError('holder.id must be a non-empty string.');
  }
  const probe = opts.probe ?? defaultProbe;
  const now = opts.now ?? new Date();
  const started = opts.startedAt ?? now;
  const heartbeat = opts.heartbeatAt ?? now;

  return withLeaseLock(opts.repoRoot, () => {
    const existing = readRecord(opts.repoRoot);
    if (existing != null) {
      const alive = isWorkspaceLeaseAlive(existing, probe);
      if (alive) {
        if (includesHolder(existing, opts.holder)) {
          // Idempotent re-acquire: refresh heartbeat/bytes, keep original started_at
          const refreshed: WorkspaceLeaseRecord = {
            ...existing,
            holder: existing.holder,
            holders: activeHolders(existing),
            holder_started_at: {
              ...(existing.holder_started_at ?? {}),
              [workspaceLeaseHolderKey(opts.holder)]: existing.holder_started_at?.[workspaceLeaseHolderKey(opts.holder)] ?? existing.started_at,
            },
            holder_heartbeat_at: {
              ...(existing.holder_heartbeat_at ?? {}),
              [workspaceLeaseHolderKey(opts.holder)]: heartbeat.toISOString(),
            },
            supervisor_pid: opts.supervisorPid ?? existing.supervisor_pid,
            executor_pid: opts.executorPid ?? existing.executor_pid,
            process_group_id: opts.processGroupId ?? existing.process_group_id,
            heartbeat_at: heartbeat.toISOString(),
            last_output_at: opts.lastOutputAt !== undefined ? (opts.lastOutputAt?.toISOString() ?? null) : existing.last_output_at,
            stdout_bytes: opts.stdoutBytes ?? existing.stdout_bytes,
            stderr_bytes: opts.stderrBytes ?? existing.stderr_bytes,
          };
          writeRecordAtomic(opts.repoRoot, refreshed);
          return refreshed;
        }
        const holdersSuffix = (() => {
          const holders = activeHolders(existing);
          if (holders.length <= 1) return '';
          return ` holders: ${holders.map((holder) => `"${holder.id}"`).join(', ')}`;
        })();
        throw new WorkspaceLeaseError(
          `shared workspace is already held by ${existing.holder.kind} "${existing.holder.id}"` +
          `${holdersSuffix} ` +
          `(supervisor_pid ${existing.supervisor_pid ?? 'unknown'}, started ${existing.started_at}); ` +
          `holder "${opts.holder.id}" must wait or retry. Inspect it with \`fadeno show <run>\`; ` +
          'recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, ' +
          `remove ${WORKSPACE_LEASE_FILE} as a last resort.`,
        );
      }
      // stale — reclaim below
    }

    const record: WorkspaceLeaseRecord = {
      workspace_mode: 'shared',
      holder: opts.holder,
      holders: [opts.holder],
      holder_started_at: { [workspaceLeaseHolderKey(opts.holder)]: started.toISOString() },
      holder_heartbeat_at: { [workspaceLeaseHolderKey(opts.holder)]: heartbeat.toISOString() },
      supervisor_pid: opts.supervisorPid ?? null,
      executor_pid: opts.executorPid ?? null,
      process_group_id: opts.processGroupId ?? null,
      started_at: started.toISOString(),
      heartbeat_at: heartbeat.toISOString(),
      last_output_at: opts.lastOutputAt !== undefined ? (opts.lastOutputAt?.toISOString() ?? null) : null,
      stdout_bytes: opts.stdoutBytes ?? 0,
      stderr_bytes: opts.stderrBytes ?? 0,
    };
    writeRecordAtomic(opts.repoRoot, record);
    return record;
  });
}

/**
 * Release the shared lease, but only when the caller is its holder.
 * Releasing a lease held by another holder is a no-op rather than an error —
 * a stale releaser should not mask a live writer — but mismatched holders do
 * not remove the file. Every release requires an exact holder, including
 * singleton leases; an unscoped release is never allowed when a lease exists.
 */
export function releaseWorkspaceLease(opts: ReleaseWorkspaceLeaseOptions): boolean {
  const abs = join(opts.repoRoot, WORKSPACE_LEASE_FILE);
  return withLeaseLock(opts.repoRoot, () => {
    const existing = readRecord(opts.repoRoot);
    if (existing == null) return false;
    const holders = activeHolders(existing);
    if (opts.holder == null && opts.holderId == null) {
      throw new WorkspaceLeaseError('workspace lease release requires an exact holder for release.');
    }
    const index = opts.holder != null
      ? holders.findIndex((candidate) => sameHolder(candidate, opts.holder!))
      : opts.holderId != null
        ? holders.findIndex((candidate) => candidate.id === opts.holderId)
        : -1;
    if ((opts.holder != null || opts.holderId != null) && index < 0) return false;
    if (index >= 0 && holders.length > 1) {
      const remaining = holders.filter((_, candidateIndex) => candidateIndex !== index);
      const removedKey = workspaceLeaseHolderKey(holders[index]!);
      const holderStartedAt = { ...(existing.holder_started_at ?? {}) };
      const holderHeartbeatAt = { ...(existing.holder_heartbeat_at ?? {}) };
      delete holderStartedAt[removedKey];
      delete holderHeartbeatAt[removedKey];
      writeRecordAtomic(opts.repoRoot, {
        ...existing,
        holder: remaining[0]!,
        holders: remaining,
        holder_started_at: holderStartedAt,
        holder_heartbeat_at: holderHeartbeatAt,
      });
      return true;
    }
    rmSync(abs, { force: true });
    return true;
  });
}

/**
 * Heartbeat the currently held lease. The holder must match; otherwise
 * throws. Updates `heartbeat_at`, `stdout_bytes`, `stderr_bytes`, and
 * `last_output_at`. A missing or stale lease throws as well.
 */
export function heartbeatWorkspaceLease(opts: HeartbeatWorkspaceLeaseOptions): WorkspaceLeaseRecord {
  const probe = opts.probe ?? defaultProbe;
  const now = opts.now ?? heartbeatNow(opts);
  const heartbeatAt = opts.heartbeatAt ?? now;

  return withLeaseLock(opts.repoRoot, () => {
    const existing = readRecord(opts.repoRoot);
    if (existing == null) {
      throw new WorkspaceLeaseError(`no active shared workspace lease to heartbeat for holder "${opts.holderId}".`);
    }
    if (!isWorkspaceLeaseAlive(existing, probe)) {
      throw new WorkspaceLeaseError(`shared lease for "${existing.holder.id}" is stale; holder "${opts.holderId}" cannot heartbeat it.`);
    }
    const matches = opts.holder != null
      ? includesHolder(existing, opts.holder)
      : activeHolders(existing).some((holder) => holder.id === opts.holderId);
    if (!matches) {
      throw new WorkspaceLeaseError(
        `heartbeat holder "${opts.holderId}" does not match active lease holder "${existing.holder.id}".`,
      );
    }
    const updated: WorkspaceLeaseRecord = {
      ...existing,
      heartbeat_at: heartbeatAt.toISOString(),
      last_output_at: opts.lastOutputAt !== undefined ? (opts.lastOutputAt?.toISOString() ?? null) : existing.last_output_at,
      stdout_bytes: opts.stdoutBytes ?? existing.stdout_bytes,
      stderr_bytes: opts.stderrBytes ?? existing.stderr_bytes,
      ...(opts.holder == null ? {} : {
        holder_heartbeat_at: {
          ...(existing.holder_heartbeat_at ?? {}),
          [workspaceLeaseHolderKey(opts.holder)]: heartbeatAt.toISOString(),
        },
      }),
    };
    writeRecordAtomic(opts.repoRoot, updated);
    return updated;
  });
}

function heartbeatNow(opts: HeartbeatWorkspaceLeaseOptions): Date {
  if (opts.now != null) return opts.now;
  return new Date();
}

/**
 * Whether a new shared write-capable delivery must block due to a live
 * shared lease held by another holder. Isolated and read-only deliveries
 * never block — the caller decides that before calling.
 */
export function isBlockedByLease(
  repoRoot: string,
  requester: string | LeaseHolder,
  probe: (pid: number, signal: number) => void = defaultProbe,
): { blocked: boolean; lease: WorkspaceLeaseRecord | null } {
  const existing = readRecord(repoRoot);
  if (existing == null) return { blocked: false, lease: null };
  if (!isWorkspaceLeaseAlive(existing, probe)) return { blocked: false, lease: null };
  if (typeof requester === 'string') {
    if (activeHolders(existing).some((holder) => holder.id === requester)) return { blocked: false, lease: existing };
  } else if (includesHolder(existing, requester)) {
    return { blocked: false, lease: existing };
  }
  return { blocked: true, lease: existing };
}

// ---------------------------------------------------------------------------
// Isolated worktree delivery — bypasses the shared lease
// ---------------------------------------------------------------------------

const ISOLATED_DIFF_MAX_NOTE = 4000;

// ---------------------------------------------------------------------------
// Declared worktree carry — shared by shadow pairs and isolated deliveries
// ---------------------------------------------------------------------------
//
// `git worktree add` cuts a clean checkout of *tracked* content only:
// dependencies, build output, and a local `.fadeno/` catalog are almost
// always gitignored, so a worktree cut this way has none of them and cannot
// build or test for reasons that have nothing to do with whatever is being
// compared or isolated. A repo declares `worktree_carry:` (a project-only
// field on `ExecutorProfile`, see `executors.ts`) to name the paths that
// must cross into a freshly-cut worktree regardless. One mechanism serves
// both a shadow's challenger worktree and an `--isolate` delivery's worktree
// — the gap is identical in both cases, so the carry logic lives here
// rather than being duplicated per caller.

/** Mechanism a declared path was actually carried by — recorded on the
 * dispatch's evidence row so a worktree is checkable as warmed the same way.
 * `reflink` and `hardlink` never appear together with a mutation concern
 * noted per-path; see `carryPathIntoWorktree` for why.
 */
export type WorktreeCarryMechanism = 'reflink' | 'hardlink' | 'copy';

export type CarryOutcome =
  | { status: 'absent' }
  | { status: 'carried'; mechanism: WorktreeCarryMechanism }
  | { status: 'failed'; reason: string };

/**
 * Carry one declared path from the primary's tree into a worktree cut from
 * HEAD. Ladder: reflink (copy-on-write clone) → hardlink → full copy.
 *
 * A non-CoW filesystem is not an edge case worth a single fallback line —
 * ext4 (the default on Ubuntu, Debian, and GitHub Actions' Linux runners),
 * NTFS, HFS+, tmpfs, NFS/SMB, and overlay2-on-ext4 all lack reflink support,
 * so hardlink-or-copy is the MAJORITY path on Linux CI, not a rare escape
 * hatch. `-c` is the macOS/APFS clonefile spelling; `--reflink=always` is the
 * GNU coreutils one. Both FAIL rather than degrade when the filesystem cannot
 * clone, which is the property the ladder depends on — see the note below
 * for why `--reflink=auto` would quietly break it.
 *
 * The hardlink step never dereferences symlinks (`-a`'s `--no-dereference`
 * half): a pnpm-style `node_modules` is full of intentional relative
 * symlinks that must keep resolving inside the worktree, not get flattened
 * into copies of whatever they happen to point at. Hardlinks cannot cross
 * filesystems; that failure mode falls through to the copy step below
 * rather than being treated as fatal.
 *
 * Cleanup is safe by construction: a hardlink is a second directory entry on
 * one inode, and its data is freed only when the link count reaches zero, so
 * removing a worktree (`rm -rf`, `git worktree remove --force`, the
 * post-shadow cleaner) only ever unlinks that worktree's own entry — it can
 * never destroy the primary's copy. This is exactly what makes a hardlink
 * safe where a directory *symlink* would not be: symlinking a directory
 * shares the namespace, so even a safe write-temp-then-rename still lands
 * inside the primary's real files, whereas a hardlinked tree is a genuinely
 * separate directory structure that a create-temp-then-rename write
 * naturally detaches from — the mechanism `rsync --link-dest` and Time
 * Machine rely on, and pnpm already hardlinks `node_modules` out of its
 * global content-addressed store for the same reason. Symlinking is
 * therefore never chosen automatically here — only a future declaration that
 * opts in to it explicitly, per path, could ask for it.
 *
 * The residual hazard is mutation, not deletion, and it is silent: a tool
 * that opens a carried file and writes IN PLACE (a SQLite-backed cache, an
 * append-mode log) mutates the primary's copy too, because content — and
 * mode — live on the shared inode. That cannot be defended by making the
 * carried tree read-only: a `chmod` on a shared inode makes the PRIMARY's
 * copy read-only as well, so that obvious mitigation is unavailable, not
 * merely unbuilt. Detecting after the fact whether a carry was mutated
 * (a `carry_mutated` stamp) is deliberately left for later; this function
 * does not attempt it.
 */
export function carryPathIntoWorktree(repoRoot: string, worktreeAbs: string, relPath: string): CarryOutcome {
  const srcAbs = join(repoRoot, relPath);
  if (!existsSync(srcAbs)) return { status: 'absent' }; // undeclared-equivalent: nothing to carry, not an error
  const destAbs = join(worktreeAbs, relPath);
  try {
    mkdirSync(dirname(destAbs), { recursive: true });
  } catch (err) {
    return { status: 'failed', reason: `could not prepare "${relPath}"'s parent directory in the worktree: ${err instanceof Error ? err.message : String(err)}` };
  }

  const attempt = (args: string[]): SpawnSyncReturns<string> => spawnSync('cp', args, { encoding: 'utf8' });
  const cleanupPartial = (): void => { try { rmSync(destAbs, { recursive: true, force: true }); } catch { /* best-effort */ } };

  // `=always`, never `=auto`. GNU `cp --reflink=auto` silently degrades to a
  // full byte copy when the filesystem cannot clone, and exits 0 — which on
  // ext4 (the majority path) would report `mechanism: 'reflink'` for what was
  // actually a copy, and make the hardlink rung below unreachable dead code.
  // `=always` fails instead, which is what lets the ladder fall through.
  // Darwin's `-c` (clonefile) already fails rather than degrading, so the two
  // spellings behave the same way here.
  const reflinkArgs = process.platform === 'darwin' ? ['-R', '-c', srcAbs, destAbs] : ['-R', '--reflink=always', srcAbs, destAbs];
  const reflinkRes = attempt(reflinkArgs);
  if (reflinkRes.error == null && reflinkRes.status === 0) return { status: 'carried', mechanism: 'reflink' };
  cleanupPartial();

  const hardlinkRes = attempt(['-a', '-l', srcAbs, destAbs]);
  if (hardlinkRes.error == null && hardlinkRes.status === 0) return { status: 'carried', mechanism: 'hardlink' };
  cleanupPartial();

  const copyRes = attempt(['-a', srcAbs, destAbs]);
  if (copyRes.error == null && copyRes.status === 0) return { status: 'carried', mechanism: 'copy' };
  cleanupPartial();

  const reason = copyRes.error != null
    ? copyRes.error.message
    : String(copyRes.stderr ?? '').trim() || `exit ${copyRes.status ?? 'unknown'}`;
  return { status: 'failed', reason };
}

/** Every declared path, carried in declaration order into a worktree that
 * was cut from HEAD, stopping at the first failure. Shared by shadow pairs
 * and isolated deliveries so both call the same ladder and record results in
 * the same shape (`{ path, mechanism }`) on their evidence row.
 */
export function carryDeclaredPaths(
  repoRoot: string,
  worktreeAbs: string,
  declared: readonly string[],
): { records: Array<{ path: string; mechanism: WorktreeCarryMechanism }>; failure: { path: string; reason: string } | null } {
  const records: Array<{ path: string; mechanism: WorktreeCarryMechanism }> = [];
  for (const relPath of declared) {
    const outcome = carryPathIntoWorktree(repoRoot, worktreeAbs, relPath);
    if (outcome.status === 'absent') continue; // declared but doesn't exist: not an error, skip silently
    if (outcome.status === 'failed') return { records, failure: { path: relPath, reason: outcome.reason } };
    records.push({ path: relPath, mechanism: outcome.mechanism });
  }
  return { records, failure: null };
}

/**
 * Create a detached worktree for an isolated delivery. The worktree is cut
 * from `HEAD` before any primary work runs so both sides start from the same
 * committed state and a dirty primary workspace cannot contaminate the
 * isolated view. The worktree lives under `.fadeno/local/isolated/<id>` and
 * is **not** merged automatically; the caller collects a binary diff artifact
 * via `collectIsolatedDiff` and removes the worktree with `removeIsolatedWorktree`.
 *
 * This helper intentionally bypasses the shared-writer lease — by construction
 * it cannot mutate the shared worktree.
 *
 * Returns the absolute and repo-relative worktree paths.
 * Throws `WorkspaceLeaseError` when the worktree cannot be created.
 */
export function createIsolatedWorktree(opts: IsolatedWorktreeOptions): IsolatedWorktreeResult {
  const worktreeAbs = opts.worktreePath;
  const worktreeRel = relative(opts.repoRoot, worktreeAbs).split('\\').join('/');
  if (worktreeRel === '' || worktreeRel.startsWith('../') || worktreeRel.split('/').includes('..')) {
    throw new WorkspaceLeaseError(`isolated worktree path escapes repo: ${worktreeAbs}`);
  }
  mkdirSync(dirname(worktreeAbs), { recursive: true });
  // Best-effort prune of stale worktrees left by killed deliveries.
  try { spawnSync('git', ['worktree', 'prune'], { cwd: opts.repoRoot, encoding: 'utf8' }); } catch {}
  const add = spawnSync('git', ['worktree', 'add', '--detach', worktreeAbs, 'HEAD'], { cwd: opts.repoRoot, encoding: 'utf8' });
  if (add.error != null || add.status !== 0) {
    const reason = (add.error?.message ?? (add.stderr != null ? String(add.stderr).trim() : '') ?? 'worktree add failed');
    throw new WorkspaceLeaseError(reason.length > 0 ? `isolated worktree could not be created: ${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}` : 'isolated worktree could not be created');
  }
  opts.onEcho?.(`isolated worktree: ${worktreeRel} (from HEAD)`);
  return { worktreeAbs, worktreeRel };
}

/**
 * Capture a binary diff of everything the isolated worktree changed,
 * relative to HEAD, into `diffAbs`. Uses `git -C <wt> add -A` +
 * `git -C <wt> diff --binary --cached` so renames and binary files are
 * preserved. The diff is written atomically (tmp+rename) and the byte
 * length is returned for evidence.
 *
 * `diffRel` is the repo-relative path that will be recorded in evidence
 * (e.g. `.fadeno/local/outputs/isolated-<id>.diff`).
 */
export function collectIsolatedDiff(opts: IsolatedDiffOptions): IsolatedDiffResult {
  mkdirSync(dirname(opts.diffAbs), { recursive: true });
  const add = spawnSync('git', ['-C', opts.worktreeAbs, 'add', '-A'], { encoding: 'utf8' });
  if (add.error != null || add.status !== 0) {
    const reason = add.error?.message ?? (String(add.stderr ?? '').trim() || `exit ${add.status ?? 'unknown'}`);
    throw new WorkspaceLeaseError(`could not stage isolated worktree changes: ${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}`);
  }
  const diffRes = spawnSync('git', ['-C', opts.worktreeAbs, 'diff', '--binary', '--cached'], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (diffRes.error != null || diffRes.status !== 0) {
    const reason = diffRes.error?.message ?? (Buffer.from(diffRes.stderr ?? []).toString('utf8').trim() || `exit ${diffRes.status ?? 'unknown'}`);
    throw new WorkspaceLeaseError(`could not collect isolated worktree diff: ${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}`);
  }
  const diffContent = Buffer.from(diffRes.stdout ?? []);
  const tmp = `${opts.diffAbs}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, diffContent);
  try {
    renameSync(tmp, opts.diffAbs);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  const diffBytes = diffContent.byteLength;
  return { diffRel: opts.diffRel, diffAbs: opts.diffAbs, diffBytes };
}

/**
 * Prove a candidate directory is the exact registered linked worktree for this
 * repository. Both checks must pass; any git failure returns false, never throws.
 * 1) repoRoot's `git worktree list --porcelain` lists candidateAbs (realpath).
 * 2) candidateAbs's `--show-toplevel` equals candidateAbs and its `--git-common-dir`
 *    equals repoRoot's common dir (both realpath). This rejects plain directories
 *    (check 2 fails: toplevel resolves to the host repo) and independent repos
 *    (common-dir differs), and a dangling .git pointer fails both with nonzero.
 */
export function isRegisteredWorktree(repoRoot: string, candidateAbs: string): boolean {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  let candidateReal: string;
  try {
    candidateReal = realpathSync(resolve(candidateAbs));
  } catch { return false; }
  try {
    const list = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env });
    if (list.error != null || list.status !== 0) return false;
    const out = String(list.stdout ?? '');
    let found = false;
    for (const entry of out.split('\n\n')) {
      const wtLine = entry.split('\n').find((l) => l.startsWith('worktree '));
      if (wtLine == null) continue;
      const wtPath = wtLine.slice('worktree '.length).trim();
      let wtReal: string;
      try { wtReal = realpathSync(resolve(wtPath)); } catch { continue; }
      if (wtReal !== candidateReal) continue;
      found = true;
      if (entry.split('\n').some((l) => l.startsWith('prunable'))) return false;
      break;
    }
    if (!found) return false;
    const top = spawnSync('git', ['-C', candidateAbs, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
    if (top.error != null || top.status !== 0) return false;
    let topReal: string;
    try { topReal = realpathSync(resolve(String(top.stdout).trim())); } catch { return false; }
    if (topReal !== candidateReal) return false;
    const commonDirInside = spawnSync('git', ['-C', candidateAbs, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', env });
    const commonDirRepo = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', env });
    if (commonDirInside.error != null || commonDirInside.status !== 0) return false;
    if (commonDirRepo.error != null || commonDirRepo.status !== 0) return false;
    const insideCommon = String(commonDirInside.stdout).trim();
    const repoCommon = String(commonDirRepo.stdout).trim();
    const insideCommonAbs = resolve(candidateAbs, insideCommon);
    const repoCommonAbs = resolve(repoRoot, repoCommon);
    let insideCommonReal: string;
    let repoCommonReal: string;
    try {
      insideCommonReal = realpathSync(resolve(insideCommonAbs));
      repoCommonReal = realpathSync(resolve(repoCommonAbs));
    } catch { return false; }
    if (insideCommonReal !== repoCommonReal) return false;
    return true;
  } catch { return false; }
}

/**
 * Best-effort removal of an isolated worktree. Failures are swallowed
 * because a killed delivery may have left the worktree in an unclean
 * state; the next `createIsolatedWorktree` prunes it.
 */
export function removeIsolatedWorktree(repoRoot: string, worktreeAbs: string): void {
  try { spawnSync('git', ['worktree', 'remove', '--force', worktreeAbs], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
  // fallback: remove directory if git didn't
  try { rmSync(worktreeAbs, { recursive: true, force: true }); } catch {}
}

/**
 * Convenience: run a full isolated delivery lifecycle — create worktree,
 * execute `action(worktreeAbs)` (which should spawn the executor with
 * `cwd: worktreeAbs`), collect the binary diff, and remove the worktree.
 * The lease bypass is structural: this function never touches the shared
 * lease file.
 *
 * The caller is responsible for spawning the executor itself so it can
 * choose superviseArgv/stdios/etc.; this helper only owns the worktree
 * and diff.
 */
export function withIsolatedWorktree<T>(
  opts: IsolatedWorktreeOptions & { diffRel: string; diffAbs: string },
  action: (worktreeAbs: string) => T,
): { result: T; diff: IsolatedDiffResult; worktreeRel: string } {
  const created = createIsolatedWorktree(opts);
  let result: T | undefined;
  let actionError: unknown;
  try {
    result = action(created.worktreeAbs);
  } catch (error) {
    actionError = error;
  }
  let diff: IsolatedDiffResult;
  try {
    diff = collectIsolatedDiff({
      repoRoot: opts.repoRoot,
      worktreeAbs: created.worktreeAbs,
      diffAbs: opts.diffAbs,
      diffRel: opts.diffRel,
    });
  } catch (diffError) {
    // Preserve the worktree for recovery when its only durable handoff could
    // not be produced.
    if (actionError != null) throw new AggregateError([actionError, diffError], 'isolated action and diff collection both failed');
    throw diffError;
  }
  removeIsolatedWorktree(opts.repoRoot, created.worktreeAbs);
  if (actionError != null) throw actionError;
  return { result: result as T, diff, worktreeRel: created.worktreeRel };
}

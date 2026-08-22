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

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /**
   * Repo-relative path of the in-flight claim where THIS holder's liveness can
   * be observed, or absent when nothing on this machine can observe it.
   *
   * A host dispatch deliberately publishes no `supervisor_pid` — the lease is a
   * durable reservation that must outlive any supervisor, or a crash between
   * the executor dying and the terminal receipt would admit a second writer.
   * That is right for mutual exclusion and useless for reporting: a healthy
   * 47-minute command fallback and an abandoned one are byte-identical here,
   * and `doctor` called a running dispatch "abandoned" and offered destructive
   * recovery on it.
   *
   * So liveness is recorded separately from the lock. The supervisor already
   * publishes pids into an in-flight claim; this field is the pointer to it,
   * and `describeWorkspaceLeaseLiveness` is the only reader. Nothing here
   * feeds `isWorkspaceLeaseAlive` — an observation must never be able to
   * weaken exclusion.
   */
  liveness_claim?: string | null;
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
  /** See `WorkspaceLeaseRecord.liveness_claim`; repo-relative, or null. */
  livenessClaim?: string | null;
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
  if (doc.liveness_claim != null && typeof doc.liveness_claim !== 'string') return null;
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
            liveness_claim: opts.livenessClaim !== undefined
              ? opts.livenessClaim
              : (existing.liveness_claim ?? null),
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
      liveness_claim: opts.livenessClaim ?? null,
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
 * It is also what decides whether a path is fingerprinted for mutation:
 * `hardlink` shares the inode and is, `reflink` (copy-on-write) and `copy`
 * cannot and are not. See `carryPathIntoWorktree` for the ladder and
 * `fingerprintCarriedPaths` for that distinction in full.
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
 * merely unbuilt. This function still makes no attempt to PREVENT it —
 * prevention is what is unavailable. What exists now is detection after the
 * fact: `carryDeclaredPaths` fingerprints every `hardlink`-carried path once
 * the carry lands, and `verifyCarriedPaths` re-reads it after the run to say
 * which declared paths drifted on a shared inode. See
 * `fingerprintCarriedPaths` for the fingerprint's design and, importantly,
 * for what it cannot see.
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
 *
 * `fingerprint` is the carry-time half of mutation detection: it is captured
 * AFTER the carry lands (see `fingerprintCarriedPaths` for why the ordering
 * is load-bearing) and covers only the `hardlink` records. Pass
 * `{ fingerprint: false }` to skip the walk for a caller that will never
 * verify; the default is on, so a caller gets detection without opting in.
 */
export function carryDeclaredPaths(
  repoRoot: string,
  worktreeAbs: string,
  declared: readonly string[],
  opts: { fingerprint?: boolean } = {},
): {
  records: Array<{ path: string; mechanism: WorktreeCarryMechanism }>;
  failure: { path: string; reason: string } | null;
  fingerprint: CarryFingerprint;
} {
  const records: Array<{ path: string; mechanism: WorktreeCarryMechanism }> = [];
  for (const relPath of declared) {
    const outcome = carryPathIntoWorktree(repoRoot, worktreeAbs, relPath);
    if (outcome.status === 'absent') continue; // declared but doesn't exist: not an error, skip silently
    if (outcome.status === 'failed') {
      // A refused carry is not run against, so nothing can mutate through it;
      // an empty fingerprint keeps the return shape total rather than optional.
      return { records, failure: { path: relPath, reason: outcome.reason }, fingerprint: emptyCarryFingerprint() };
    }
    records.push({ path: relPath, mechanism: outcome.mechanism });
  }
  const fingerprint = opts.fingerprint === false
    ? emptyCarryFingerprint()
    : fingerprintCarriedPaths(repoRoot, records);
  return { records, failure: null, fingerprint };
}

// ---------------------------------------------------------------------------
// Carry mutation detection — `carry_mutated`
// ---------------------------------------------------------------------------

/** Walk budget per declared path. A tree larger than this is fingerprinted
 * only in part, which is recorded (`truncated`) and degrades that path's
 * verdict to `unknown` — never to `clean`. A partial detector that reports
 * "clean" is worse than no detector, so the budget is never allowed to look
 * like a pass. Sized so a typical `node_modules` (tens of thousands of
 * entries) fits whole; two maps this size cost tens of MB at verify time,
 * which is the real reason there is a bound at all. */
export const CARRY_FINGERPRINT_MAX_ENTRIES = 250_000;

/** How many drifted entries a verdict names. The count is exact; the list is
 * a sample, because a `node_modules` that drifted wholesale must not put
 * 40,000 paths on an evidence row. */
export const CARRY_DRIFT_MAX_EXAMPLES = 10;

/** Per-entry identity inside one carried path. Keys are repo-relative paths;
 * values are the packed stat tuple built by `stampOf`. Held in memory only —
 * see `fingerprintCarriedPaths` for why it is deliberately not digested down
 * to a single row-sized value. */
export interface CarryPathFingerprint {
  /** Repo-relative declared path, exactly as it appears in `worktree_carry:`. */
  path: string;
  /** Always `hardlink`: the only rung that shares an inode. */
  mechanism: 'hardlink';
  /** Entries walked (files, directories, symlinks, everything else). */
  entries: number;
  /** The walk hit `CARRY_FINGERPRINT_MAX_ENTRIES` and stopped early. */
  truncated: boolean;
  /** Entries that could not be stat'd at capture time. */
  unreadable: number;
  /** The budget this capture ran under. `verifyCarriedPaths` re-walks with the
   * same number so both sides see the same slice of a truncated tree and a
   * budget cut cannot masquerade as entries appearing or disappearing. */
  maxEntries: number;
  stamps: Map<string, string>;
}

export interface CarryFingerprint {
  /** When the identity was captured — after the carry, before the run. */
  capturedAt: string;
  paths: CarryPathFingerprint[];
}

/**
 * How one entry drifted.
 *
 * `in_place_write` and `metadata_only` are the HAZARD: they are changes to an
 * inode the worktree still shares, which is the only channel by which work
 * done inside a carried worktree can reach the primary's tree.
 *
 * `replaced`, `added`, and `removed` are drift the worktree cannot have
 * caused — a hardlinked worktree has its own directory structure, so nothing
 * done there can repoint or create an entry in the PRIMARY's directories.
 * They mean the primary's own tooling changed the carried tree while the run
 * was in flight (an `npm install` on the primary arm is the ordinary case).
 * Reported, never conflated with the hazard.
 */
export type CarryDriftKind = 'in_place_write' | 'metadata_only' | 'replaced' | 'added' | 'removed';

const HAZARD_KINDS: readonly CarryDriftKind[] = ['in_place_write', 'metadata_only'];

export interface CarryDriftEntry {
  /** Repo-relative path of the entry that drifted. */
  path: string;
  kind: CarryDriftKind;
}

export interface CarryPathVerdict {
  path: string;
  mechanism: 'hardlink';
  /** `mutated` = at least one shared inode changed (the hazard). `drifted` =
   * the carried tree changed, but only in ways the worktree could not cause.
   * `unknown` = the fingerprint could not cover the tree, so `clean` cannot
   * be claimed. `clean` = every fingerprinted entry is byte-for-byte the same
   * identity it had at carry time. */
  status: 'clean' | 'mutated' | 'drifted' | 'unknown';
  /** Exact count across every kind. */
  entriesChanged: number;
  /** Only the kinds that actually occurred. */
  kinds: Partial<Record<CarryDriftKind, number>>;
  /** At most `CARRY_DRIFT_MAX_EXAMPLES`, hazard kinds first, then by path. */
  examples: CarryDriftEntry[];
  /** Why the verdict is `unknown`, or what qualifies a positive one. */
  note: string | null;
}

/** The row-shaped projection of a non-clean verdict. snake_case because it
 * lands verbatim on a `.fadeno/dispatches.jsonl` row. */
export interface CarryMutationStamp {
  path: string;
  mechanism: 'hardlink';
  status: 'mutated' | 'drifted' | 'unknown';
  entries_changed: number;
  kinds: Partial<Record<CarryDriftKind, number>>;
  examples: CarryDriftEntry[];
  note?: string;
}

function emptyCarryFingerprint(): CarryFingerprint {
  return { capturedAt: new Date().toISOString(), paths: [] };
}

/**
 * Pack one entry's identity into a comparable string.
 *
 * Regular files carry the full tuple. Everything else deliberately does not:
 *
 * - **Directories** are stamped by existence alone. `cp -a -l` cannot hardlink
 *   a directory — each worktree gets its own directory inodes — so a
 *   directory's own mtime can never be evidence of shared-inode mutation, and
 *   including it would mislabel an ordinary `npm install` on the primary as
 *   the hazard. Entries appearing and disappearing inside a directory are
 *   already visible as `added`/`removed` keys.
 * - **Symlinks** are stamped by inode only. A symlink's target is immutable:
 *   retargeting means unlink + symlink, which in the worktree makes a NEW
 *   inode there and cannot touch the primary's. Timestamps on a symlink are
 *   therefore pure noise here.
 * - **`nlink` is carried but never treated as drift.** It is a function of
 *   the carry and of teardown, not of mutation: `link(2)` raises it (and, as
 *   a side effect, bumps `ctime`), and removing the worktree lowers it again.
 *   It is recorded solely so `classify` can tell a ctime bump that a
 *   link-count change fully explains from one that nothing explains.
 */
function stampOf(abs: string): string {
  try {
    const st = lstatSync(abs, { bigint: true });
    if (st.isDirectory()) return 'd';
    if (st.isSymbolicLink()) return `l|${st.ino}`;
    if (st.isFile()) {
      return `f|${st.ino}|${st.size}|${st.mtimeNs}|${st.ctimeNs}|${st.mode}|${st.uid}|${st.gid}|${st.nlink}`;
    }
    return `o|${st.ino}|${st.mode}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'EUNKNOWN';
    return `!|${code}`;
  }
}

/** Walk one carried path, producing `repo-relative path -> stamp`. Never
 * follows symlinks (`lstat`, and `readdir` type checks are `lstat`-shaped),
 * so a pnpm store link out of the tree is recorded as a link and not chased.
 */
function walkCarryPath(repoRoot: string, relPath: string, maxEntries: number): { stamps: Map<string, string>; truncated: boolean; unreadable: number } {
  const stamps = new Map<string, string>();
  let truncated = false;
  let unreadable = 0;
  const rootAbs = join(repoRoot, relPath);
  const rootRel = relPath.split('\\').join('/');
  const stack: Array<{ abs: string; rel: string }> = [{ abs: rootAbs, rel: rootRel }];
  while (stack.length > 0) {
    const cur = stack.pop() as { abs: string; rel: string };
    if (stamps.size >= maxEntries) { truncated = true; break; }
    const stamp = stampOf(cur.abs);
    // ENOENT is a fact, not a blind spot: the entry is not there, which is
    // knowable drift. Every other stat failure (EACCES, EIO) means the walk
    // could not look, which is what `unreadable` degrades a verdict for.
    if (stamp.startsWith('!|') && stamp !== '!|ENOENT') unreadable += 1;
    stamps.set(cur.rel, stamp);
    if (stamp !== 'd') continue;
    let entries;
    try {
      entries = readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      // A directory we could stat but cannot list: mark it so verify cannot
      // read the absence of its children as "nothing changed there".
      stamps.set(cur.rel, 'd|unlistable');
      unreadable += 1;
      continue;
    }
    // Sorted, then reversed because the stack is LIFO: the walk order is
    // deterministic, so a truncated capture and a truncated verify cover the
    // same slice of the tree and the budget itself cannot read as drift.
    for (const entry of entries.map((e) => e.name).sort().reverse()) {
      stack.push({ abs: join(cur.abs, entry), rel: `${cur.rel}/${entry}` });
    }
  }
  return { stamps, truncated, unreadable };
}

/**
 * Capture the identity of every `hardlink`-carried path, in the PRIMARY's
 * tree, so a later `verifyCarriedPaths` can say whether it drifted.
 *
 * ## What is fingerprinted, and what is not
 *
 * **Only `hardlink` records.** `reflink` is copy-on-write — a write inside the
 * worktree allocates new blocks and the primary's extents are untouched — and
 * `copy` is a byte copy with no relationship at all. Neither can carry a
 * mutation back, so fingerprinting them would cost a full tree walk to prove
 * something the mechanism already guarantees. This is a deliberate omission,
 * not a gap to be "fixed" later: if you find yourself adding reflink here,
 * the thing to change first is the claim in `carryPathIntoWorktree` that
 * `--reflink=always` never degrades to a copy.
 *
 * **The primary's tree, not the worktree's.** The two are the same inodes
 * while the links exist, so either side observes the same mutation — but the
 * primary is the asset at risk and it outlives the worktree, so a verify can
 * run after an isolated delivery has already torn its worktree down.
 *
 * ## Why stat metadata rather than content
 *
 * Hashing a `node_modules` is not affordable on a dispatch's critical path:
 * it is hundreds of megabytes and tens of thousands of files, read twice.
 * A stat walk is one `lstat` per entry and no bytes read. What that buys is
 * exactly the write signal: any `write(2)` to a file updates `mtime` and
 * `ctime`; an append also changes `size`; a `chmod`/`chown` on the shared
 * inode — the second half of the hazard, since mode lives on the inode too —
 * changes `mode`/`uid`/`gid` and `ctime`. A tool that restores `mtime` after
 * writing (`utimes`) cannot restore `ctime`: no userspace API sets it, and
 * `utimes` itself advances it. So `ctime` is the field that closes the
 * obvious evasion, which is why it is in the tuple despite being noisy.
 *
 * ## Ordering: capture AFTER the carry
 *
 * `link(2)` bumps the source inode's `ctime` (the link count is inode
 * metadata). Capturing before the carry would therefore record a `ctime` that
 * the carry itself invalidates, and every file would read as drifted. Capture
 * runs once all declared paths have landed.
 *
 * The symmetric hazard — the worktree's links being REMOVED before verify,
 * which lowers `nlink` and bumps `ctime` again — is handled in `classify`
 * rather than by an ordering rule, so a caller that verifies after teardown
 * gets a correct answer instead of a tree full of false positives.
 *
 * ## False negatives — what this will not see
 *
 * 1. **A same-timestamp, same-size, same-mode in-place write.** If a
 *    filesystem's timestamp granularity is coarse (1s on ext3, HFS+, and some
 *    SMB/FUSE mounts) and the write lands in the same tick as the carry, and
 *    the file's length is unchanged, nothing in the tuple moves. Content
 *    hashing is the only defence and it is the thing being traded away.
 * 2. **A filesystem that does not maintain `ctime` honestly** — some network
 *    and FUSE mounts. Then an `mtime`-restoring writer is invisible.
 * 3. **Anything outside a declared path.** Only `worktree_carry:` entries are
 *    walked. A symlink pointing out of the carried tree (a global pnpm store)
 *    is stamped as a link and its target is never visited — but such a target
 *    was never carried, so it is not shared by way of this mechanism either.
 * 4. **Beyond the walk budget.** Reported as `truncated`, and the verdict
 *    degrades to `unknown` — this one is loud rather than silent by
 *    construction.
 * 5. **Attribution, always.** A shared inode that changed is proof that the
 *    carried baseline moved, not proof of who moved it: the primary arm
 *    writing its own `node_modules` in place produces the same evidence. This
 *    is an attestation, in the same sense as `workspace_changed`, and the
 *    stamp is named for what was observed rather than for a culprit.
 */
export function fingerprintCarriedPaths(
  repoRoot: string,
  records: ReadonlyArray<{ path: string; mechanism: WorktreeCarryMechanism }>,
  opts: { maxEntries?: number } = {},
): CarryFingerprint {
  const maxEntries = opts.maxEntries ?? CARRY_FINGERPRINT_MAX_ENTRIES;
  const paths: CarryPathFingerprint[] = [];
  for (const record of records) {
    if (record.mechanism !== 'hardlink') continue;
    const walked = walkCarryPath(repoRoot, record.path, maxEntries);
    paths.push({
      path: record.path,
      mechanism: 'hardlink',
      entries: walked.stamps.size,
      truncated: walked.truncated,
      unreadable: walked.unreadable,
      maxEntries,
      stamps: walked.stamps,
    });
  }
  return { capturedAt: new Date().toISOString(), paths };
}

/** Split a packed file stamp into its fields. Only meaningful for `f|…`. */
function fileFields(stamp: string): string[] {
  return stamp.split('|');
}

/**
 * Decide how one entry drifted, given its stamp at carry time and now.
 * Returns `null` when the difference is fully explained by the link count —
 * i.e. the worktree's copy was linked or unlinked and nothing else moved.
 */
function classify(before: string, after: string): CarryDriftKind | null {
  if (before === after) return null;
  if (!before.startsWith('f|') || !after.startsWith('f|')) {
    // A file that became a directory, a link that became a file, an entry
    // that became unreadable, a directory that became unlistable: the
    // primary's own directory entry changed, which a hardlinked worktree
    // cannot do.
    return 'replaced';
  }
  const b = fileFields(before);
  const a = fileFields(after);
  // f | ino | size | mtimeNs | ctimeNs | mode | uid | gid | nlink
  if (b[1] !== a[1]) return 'replaced'; // primary's dentry now points elsewhere
  if (b[2] !== a[2] || b[3] !== a[3]) return 'in_place_write';
  if (b[5] !== a[5] || b[6] !== a[6] || b[7] !== a[7]) return 'metadata_only';
  if (b[4] !== a[4]) {
    // ctime moved but nothing else did. A link count that also moved explains
    // it completely (the carry's link, or the worktree's teardown) — see
    // `stampOf`. A link count that did NOT move leaves an inode touch with no
    // benign explanation: an mtime-restoring in-place write is exactly this
    // shape, so it is reported rather than swallowed.
    if (b[8] !== a[8]) return null;
    return 'metadata_only';
  }
  return null;
}

/**
 * Re-read every fingerprinted path in the primary's tree and say which ones
 * drifted. Read-only: this never repairs, reverts, or removes anything — the
 * carried tree is the caller's to reason about, and a detector that also
 * mutated would destroy the evidence it exists to produce.
 *
 * Safe to call whether or not the carrying worktree still exists; see
 * `fingerprintCarriedPaths` on ordering.
 */
export function verifyCarriedPaths(repoRoot: string, fingerprint: CarryFingerprint): CarryPathVerdict[] {
  const verdicts: CarryPathVerdict[] = [];
  for (const captured of fingerprint.paths) {
    const now = walkCarryPath(repoRoot, captured.path, captured.maxEntries);
    const drift: CarryDriftEntry[] = [];
    const kinds: Partial<Record<CarryDriftKind, number>> = {};
    const bump = (kind: CarryDriftKind, path: string): void => {
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      drift.push({ path, kind });
    };
    for (const [path, before] of captured.stamps) {
      const after = now.stamps.get(path);
      if (after === undefined) {
        // Beyond a truncated walk we cannot tell "removed" from "not looked
        // at", so do not assert removal; `truncated` already forces `unknown`.
        if (!now.truncated) bump('removed', path);
        continue;
      }
      const kind = classify(before, after);
      if (kind != null) bump(kind, path);
    }
    if (!captured.truncated) {
      for (const path of now.stamps.keys()) {
        if (!captured.stamps.has(path)) bump('added', path);
      }
    }

    const hazards = HAZARD_KINDS.reduce((sum, kind) => sum + (kinds[kind] ?? 0), 0);
    const degraded = captured.truncated || now.truncated || captured.unreadable > 0 || now.unreadable > 0;
    let status: CarryPathVerdict['status'];
    let note: string | null = null;
    if (hazards > 0) {
      status = 'mutated';
      note = `${hazards} ${hazards === 1 ? 'entry' : 'entries'} changed on an inode this carry shares with the worktree; the primary's copy changed with it. Attestation, not attribution — the primary's own tooling writing in place produces the same evidence.`;
    } else if (degraded) {
      status = 'unknown';
      note = captured.truncated || now.truncated
        ? `the carried tree exceeds the ${captured.maxEntries}-entry fingerprint budget, so part of it was never compared — not a clean result.`
        : 'part of the carried tree could not be read at capture or verify time, so part of it was never compared — not a clean result.';
    } else if (drift.length > 0) {
      status = 'drifted';
      note = 'the carried tree changed, but only in ways a hardlinked worktree cannot cause (entries added, removed, or repointed in the primary\'s own directories).';
    } else {
      status = 'clean';
    }

    // Hazards first so a truncated sample never shows only benign drift.
    const ordered = drift.slice().sort((x, y) => {
      const hx = HAZARD_KINDS.includes(x.kind) ? 0 : 1;
      const hy = HAZARD_KINDS.includes(y.kind) ? 0 : 1;
      if (hx !== hy) return hx - hy;
      return x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
    });
    verdicts.push({
      path: captured.path,
      mechanism: 'hardlink',
      status,
      entriesChanged: drift.length,
      kinds,
      examples: ordered.slice(0, CARRY_DRIFT_MAX_EXAMPLES),
      note,
    });
  }
  return verdicts;
}

/**
 * Project verdicts onto the `carry_mutated` evidence field, or `null` when
 * every fingerprinted path came back clean. `null` rather than `[]` so the
 * caller omits the field entirely, matching how `worktree_carry` is only ever
 * added and never defaulted onto a row.
 */
export function carryMutationStamp(verdicts: readonly CarryPathVerdict[]): CarryMutationStamp[] | null {
  const stamps: CarryMutationStamp[] = [];
  for (const verdict of verdicts) {
    if (verdict.status === 'clean') continue;
    stamps.push({
      path: verdict.path,
      mechanism: verdict.mechanism,
      status: verdict.status,
      entries_changed: verdict.entriesChanged,
      kinds: verdict.kinds,
      examples: verdict.examples,
      ...(verdict.note != null ? { note: verdict.note } : {}),
    });
  }
  return stamps.length > 0 ? stamps : null;
}

// ---------------------------------------------------------------------------
// Gitignored output detection — `ignored_output`
// ---------------------------------------------------------------------------
//
// Both arms of a shadow pair now run in their own worktree, and the primary's
// work reaches the caller's tree as a patch produced by `git add -A` +
// `git diff --binary --cached` (see `collectIsolatedDiff`). `git add -A`
// RESPECTS `.gitignore`. So anything an arm produced that the repo ignores —
// a `dist/`, a `target/`, a generated `coverage/` — is staged by nothing,
// diffed by nothing, and applied by nothing: it dies with the worktree,
// silently, with no line anywhere saying it existed.
//
// This section is the detection half of removing that silence. It says what
// ignored content was sitting in a worktree when its arm exited. It does not
// rescue it, and deliberately so — see `scanIgnoredOutput`.

/**
 * How many entries one scan will name.
 *
 * Git collapses a wholly-ignored directory to a single entry (`dist/`,
 * `node_modules/`), so an ordinary repo yields tens of entries and this
 * budget is never approached — measured at 41 entries in Fadeno's own tree.
 * It exists for the one shape git cannot collapse: ignored files scattered
 * through a large TRACKED tree (compiled artifacts beside their sources),
 * where the count is per-file. Hitting it sets `truncated`, and a truncated
 * scan is a floor rather than a set.
 *
 * Three orders of magnitude below `CARRY_FINGERPRINT_MAX_ENTRIES` because
 * these are paths destined for an evidence row a human reads, not stat tuples
 * in a comparison map the machine consumes.
 *
 * Overridable per call via `scanIgnoredOutput`'s `{ maxEntries }`, the same
 * shape `fingerprintCarriedPaths` takes — which is also what lets the cap's
 * behaviour be tested without materializing ten thousand files.
 */
export const IGNORED_OUTPUT_MAX_ENTRIES = 10_000;

const IGNORED_OUTPUT_MAX_BUFFER = 32 * 1024 * 1024;

export interface IgnoredOutputScan {
  /** Repo-relative paths, directory-collapsed the way git reports them.
   * A trailing `/` is git's own marker that the entry is a whole directory
   * and is preserved rather than trimmed: `dist/` and a file named `dist`
   * are different findings. */
  paths: string[];
  /** The listing could not be trusted to be complete. `paths` is then a
   * floor, not the set. */
  truncated: boolean;
  /** Why the scan is truncated, when it is. Optional so a caller can build an
   * `IgnoredOutputScan` literal without it; follows `CarryMutationStamp.note`,
   * which exists for the same reason — a degraded verdict that cannot say why
   * is barely better than no verdict. */
  note?: string;
}

/** Normalize one path for comparison: forward slashes, no `./` prefix, no
 * trailing slash. Comparison only — the reported string keeps git's form. */
function normalizeScanPath(raw: string): string {
  let out = raw.split('\\').join('/');
  while (out.startsWith('./')) out = out.slice(2);
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Is `rel` at or underneath `prefix`?
 *
 * The `/` in the second test is the whole point. A bare
 * `rel.startsWith(prefix)` matches `node_modules_backup` against a carry of
 * `node_modules` and silently erases a real finding — the exact class of bug
 * this detector exists to stop producing, reintroduced one level down.
 */
function isAtOrUnder(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * Fadeno's own state inside a worktree, which is never the arm's output.
 *
 * `isUnderShadowHome` (dispatch.ts) makes the narrow version of this call for
 * the copy direction — `.fadeno/local` only, checked explicitly rather than
 * delegated to `--exclude-standard`, because a user repo may commit `.fadeno/`
 * definitions while ignoring only some subpaths. That same observation is why
 * the check here is WIDER, not narrower, and it is a granularity fact rather
 * than a taste call:
 *
 * - In a user repo, `.fadeno/playbooks/` and `.fadeno/schemas/` are TRACKED,
 *   so they can never appear in an `--others --ignored` listing at all. What
 *   remains ignorable under `.fadeno/` is exactly Fadeno's own machine-local
 *   state and traces (`local/`, `runs/`, `progress/`, `dispatches.jsonl`) —
 *   by definition not a deliverable, and `runs/` is documented as output that
 *   is safe to delete.
 * - In a repo that ignores `.fadeno/` wholesale (Fadeno's own tree does), git
 *   `--directory` collapses the lot to a single `.fadeno/` entry. There is
 *   then no `.fadeno/local` to exclude separately: the choice is to report an
 *   entry that is mostly the worktree's own scaffolding, or to drop it.
 *   Distinguishing them would need the recursive walk this scan is built to
 *   avoid.
 * - A dispatch running inside a worktree writes under `.fadeno/` by
 *   construction, so reporting it would put the mechanism's own footprint on
 *   every single pair — the `node_modules` argument, applied to ourselves.
 *
 * The cost is stated on `scanIgnoredOutput` as a false negative: a repo that
 * keeps genuine work product under an ignored `.fadeno/` path is not seen.
 */
function isFadenoWorktreeState(rel: string): boolean {
  return isAtOrUnder(rel, '.fadeno');
}

/**
 * List the gitignored content sitting in `worktreeAbs` that no diff will
 * carry out of it.
 *
 * ## Why git does the listing
 *
 * `git ls-files --others --ignored --exclude-standard --directory` is the
 * only listing that sees the same exclude set `git add -A` obeys — the
 * `.gitignore` files, `.git/info/exclude`, and `core.excludesFile` together.
 * A hand-rolled `.gitignore` parser would drift from the stager it is
 * supposed to predict, and a recursive `readdir` walk cannot answer "is this
 * ignored" at all. It is also cheap because git collapses wholly-ignored
 * directories: 41 entries and ~38ms across Fadeno's own tree, against a
 * `node_modules`-scale walk for the manual version.
 *
 * The spawn deliberately inherits the ambient environment. Neutralizing
 * global/system git config (as `isRegisteredWorktree` does, for reasons that
 * do not apply here) would drop `core.excludesFile` and make this scan see a
 * DIFFERENT ignore set than the `git add -A` it exists to predict, which is
 * the one property that must hold.
 *
 * ## What is excluded, and why each
 *
 * - **`carriedPaths`** — `worktree_carry:` entries are INPUT: they were
 *   deliberately placed in the worktree before the arm started, and their
 *   being ignored is why they had to be carried in the first place. Naming a
 *   carried `node_modules` as discarded output would bury the `dist/` that
 *   actually matters under the one entry guaranteed to be present.
 * - **`.fadeno/`** — see `isFadenoWorktreeState`.
 *
 * An entry that is a strict ANCESTOR of a carried path is kept, not dropped:
 * a carry of `build/cache` under a wholly-ignored `build/` yields the entry
 * `build/`, which contains the carry AND whatever the arm built beside it.
 * Dropping it would hide real output to suppress known input, and hiding is
 * the failure mode this whole detector exists to end.
 *
 * ## Never throws, and "I could not tell" is never spelled "nothing"
 *
 * A git failure — not a repo, a removed worktree, a broken git — returns
 * `truncated: true` with whatever partial listing was recovered (usually
 * none). That asymmetry is the point: `{ paths: [], truncated: false }` is a
 * positive claim that the worktree was clean, and it is only ever returned
 * when git actually said so.
 *
 * ## Read-only
 *
 * This never stages, copies, rescues, or deletes anything. The worktree is
 * about to be torn down and the caller decides what that means; a detector
 * that also repaired would be making an unreviewable merge decision on the
 * strength of a filename.
 *
 * ## False negatives — what this will not see
 *
 * 1. **Anything under `.fadeno/`**, per the exclusion above. A repo storing
 *    real deliverables at an ignored `.fadeno/` path loses them invisibly.
 * 2. **Anything at or under a declared `worktree_carry:` path.** An arm that
 *    builds INTO its carried tree — a `node_modules/.bin` shim, a
 *    `.venv/lib/.../site-packages` install — produces output that is dropped
 *    and is not reported, because at this granularity it is indistinguishable
 *    from the input that was carried in.
 * 3. **Ignored content that survives anyway.** A path that is ignored but
 *    also TRACKED is staged by `git add -A` regardless (ignore rules do not
 *    apply to tracked files) and never appears in this listing either — the
 *    two omissions agree, so this one is harmless.
 * 4. **Beyond the budget.** Reported as `truncated`, never as clean.
 * 5. **Causation, always.** This is an appearance scan with no "before"
 *    snapshot, so it names what was ignored and present, not what the arm
 *    wrote. The bound is tight rather than theoretical — `git worktree add`
 *    cuts a clean checkout of tracked HEAD content, so a fresh worktree has
 *    no ignored files except what the carry put there (excluded above) and
 *    what ran inside it. Still an attestation, in the same sense as
 *    `carry_mutated`: named for what was observed, not for a culprit.
 */
export function scanIgnoredOutput(
  worktreeAbs: string,
  carriedPaths: readonly string[],
  opts: { maxEntries?: number } = {},
): IgnoredOutputScan {
  const maxEntries = opts.maxEntries ?? IGNORED_OUTPUT_MAX_ENTRIES;
  if (typeof worktreeAbs !== 'string' || worktreeAbs.length === 0) {
    // `git -C ''` would silently scan the CURRENT process's cwd — the
    // primary's tree — and report its entire ignored set as a worktree's
    // dropped output. Refuse rather than answer about the wrong directory.
    return { paths: [], truncated: true, note: 'no worktree path was given, so nothing could be scanned.' };
  }

  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      'git',
      ['-C', worktreeAbs, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', maxBuffer: IGNORED_OUTPUT_MAX_BUFFER },
    );
  } catch (err) {
    // spawnSync itself throwing (EMFILE, ENOMEM) is rarer than a nonzero
    // exit, but it is the same answer: unknown, not clean.
    return { paths: [], truncated: true, note: `the ignored-output listing could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }

  const failed = result.error != null || result.status !== 0;
  const raw = String(result.stdout ?? '');
  const fields = raw.split('\0');
  // `git ls-files -z` NUL-TERMINATES every record, so a successful run's last
  // field is always empty. A failed run (a `maxBuffer` overflow is the case
  // worth recovering) can end mid-path; that fragment is not a real path and
  // is dropped rather than reported as one.
  if (failed && raw.length > 0 && !raw.endsWith('\0')) fields.pop();

  const carries: string[] = [];
  for (const declared of carriedPaths) {
    if (typeof declared !== 'string') continue;
    const norm = normalizeScanPath(declared);
    if (norm.length === 0 || norm === '.') continue; // a carry of the whole tree would exclude everything
    carries.push(norm);
  }

  const paths: string[] = [];
  let cappedOut = false;
  for (const field of fields) {
    if (field.length === 0) continue;
    const rel = normalizeScanPath(field);
    if (rel.length === 0 || rel === '.') continue;
    if (isFadenoWorktreeState(rel)) continue;
    if (carries.some((carry) => isAtOrUnder(rel, carry))) continue;
    if (paths.length >= maxEntries) { cappedOut = true; break; }
    paths.push(field); // git's own spelling, trailing slash and all
  }

  if (failed) {
    const reason = result.error != null
      ? result.error.message
      : (String(result.stderr ?? '').trim() || `exit ${result.status ?? 'unknown'}`);
    return {
      paths,
      truncated: true,
      note: `the ignored-output listing failed (${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}), so these ${paths.length} ${paths.length === 1 ? 'path is' : 'paths are'} a floor, not the set.`,
    };
  }
  if (cappedOut) {
    return {
      paths,
      truncated: true,
      note: `more than ${maxEntries} ignored entries are present; the listing stopped there, so these paths are a floor, not the set.`,
    };
  }
  return { paths, truncated: false };
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
 * How a merge-back ended. `clean` means the whole diff is in the workspace.
 * `conflicted` means git tried and the tree MAY be partly applied — a 3-way
 * merge leaves conflict markers behind on the files it could not reconcile,
 * so the reader has to inspect `git status`. `blocked` means nothing was
 * applied and the tree is untouched: the diff is durable and can be ported
 * once whatever blocked it settles. The distinction decides whether a reader
 * has to go look at the tree, so the two must never be collapsed.
 */
export interface MergeBackResult {
  status: 'clean' | 'conflicted' | 'blocked';
  detail?: string;
}

/** `git apply --3way` refusing a path the workspace holds untracked. */
const NOT_IN_INDEX = /^error: (.+?): does not exist in index$/gm;

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line == null ? '' : line.trim();
}

/**
 * Apply an isolated attempt's diff to the caller's workspace.
 *
 * `--3way` first, never `--check`: a sibling member may have merged back
 * while this one ran, so context lines drift routinely and a plain apply
 * would refuse work that reconciles fine. It exits non-zero the moment any
 * file is left carrying conflict markers, which is the signal `conflicted`
 * needs; `--check` would exit 0 on a patch that WOULD conflict.
 *
 * The one failure `--3way` cannot express as a conflict is a path the
 * workspace holds UNTRACKED. The worktree was cut with the caller's untracked
 * files copied in and committed as its baseline, so to the worktree they are
 * tracked and the diff describes them as modifications of tracked files — but
 * `--3way` implies `--index`, and the caller's index has no entry for them, so
 * git refuses the whole patch with `does not exist in index` before writing
 * anything (the apply is atomic: it checks every hunk, then writes, and this
 * error is raised in the check). On 2026-08-22 that dropped a worker's entire
 * change set, tracked hunks included, because one edited file lived in an
 * untracked directory — and the row called it `conflicted`, which sent the
 * reader to inspect a tree nothing had touched.
 *
 * Adding those paths to the caller's index would make them apply, and would
 * also mutate an index the caller never asked to have mutated; the baseline
 * capture goes out of its way not to run `git add` in the caller's repo for
 * exactly that reason. So when `does not exist in index` is the failure, the
 * diff is re-applied to the working tree alone (`git apply` without
 * `--index`), which has no notion of tracking and is equally atomic. The
 * trade is stated on the result: those hunks land unstaged, and without the
 * 3-way fallback, so drift on them refuses instead of reconciling. A plain
 * apply that refuses leaves the tree untouched, so that outcome is `blocked`,
 * not `conflicted`.
 */
export function applyMergeBackDiff(opts: { repoRoot: string; diffAbs: string }): MergeBackOutcome {
  const threeWay = spawnSync('git', ['-C', opts.repoRoot, 'apply', '--3way', opts.diffAbs], { encoding: 'utf8' });
  if (threeWay.error == null && threeWay.status === 0) return { stamp: { status: 'clean' }, untracked: [] };
  const threeWayErr = threeWay.error?.message ?? String(threeWay.stderr ?? '').trim();
  const untracked = [...threeWayErr.matchAll(NOT_IN_INDEX)].map((m) => m[1]!);
  if (untracked.length === 0) {
    return {
      stamp: {
        status: 'conflicted',
        detail: threeWayErr.length > 0 ? threeWayErr : `git apply --3way exited ${threeWay.status ?? 'unknown'}`,
      },
      untracked,
    };
  }
  const named = `${untracked.join(', ')} ${untracked.length === 1 ? 'is' : 'are'} untracked in the workspace`;
  const plain = spawnSync('git', ['-C', opts.repoRoot, 'apply', opts.diffAbs], { encoding: 'utf8' });
  if (plain.error == null && plain.status === 0) {
    return {
      stamp: {
        status: 'clean',
        detail:
          `applied to the working tree without 3-way merge and left unstaged: ${named}, ` +
          'so git had no index entry to merge against',
      },
      untracked,
    };
  }
  const plainErr = plain.error?.message ?? String(plain.stderr ?? '').trim();
  return {
    stamp: {
      status: 'blocked',
      detail:
        `nothing was applied: ${named}, so 3-way merge was unavailable ` +
        `(${firstLine(threeWayErr)}), and a plain working-tree apply refused too ` +
        `(${plainErr.length > 0 ? firstLine(plainErr) : `git apply exited ${plain.status ?? 'unknown'}`})`,
    },
    untracked,
  };
}

/**
 * What `applyMergeBackDiff` learned, split into the part that goes on the
 * ledger (`stamp`, exactly `{status, detail?}` — its shape is frozen with the
 * rest of the receipt) and the part the caller needs only to phrase a
 * recovery pointer (`untracked`), which stays out of the ledger.
 */
export interface MergeBackOutcome {
  stamp: MergeBackResult;
  untracked: string[];
}

/**
 * The command that would re-apply a kept diff by hand. `--3way` is the
 * right one whenever it was possible; when the diff names paths the
 * workspace holds untracked it never was, and pointing the reader at it
 * would reproduce the refusal they are recovering from.
 */
export function mergeBackReapplyCommand(diffRel: string, untracked: readonly string[]): string {
  return untracked.length > 0 ? `git apply ${diffRel}` : `git apply --3way ${diffRel}`;
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

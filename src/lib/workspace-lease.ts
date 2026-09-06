/**
 * `.fadeno/local/workspace-lease.json` — a file nothing writes any more.
 *
 * ## What this module used to be
 *
 * A repo-wide writer lock. A live `shared` writer blocked every other shared
 * write-capable command and host dispatch across every run, and the lock was
 * released only when its holder could be PROVEN gone. That proof is the whole
 * problem: it requires Fadeno to answer *"is this holder still alive?"*, and
 * Fadeno cannot.
 *
 * - The lease guessed with a pid. `isWorkspaceLeaseAlive` treated a record
 *   with no `supervisor_pid` as **live** — nothing could prove it dead, so
 *   nothing ever reclaimed it.
 * - A host dispatch never has a pid. It runs inside another agent's session,
 *   which publishes no process identity here. So every shared host delivery
 *   took a lock that was, by construction, immortal: a 429-killed agent wedged
 *   the repo permanently, refusing (in the old module's own words about the
 *   window-lease bug) "even the recovery of the very run that took it".
 *
 * Both halves of that are the same mistake as the executor deadline removed
 * alongside it: a clock cannot tell slow from stuck, and a pid probe cannot
 * tell "working in another session" from "gone".
 *
 * ## What replaced it
 *
 * Nothing blocks. A delivery that is not the sole writer is given its own
 * worktree instead of being refused (`workspace-isolation.ts`), and where two
 * deliveries' edits actually meet, both receipts record the intersection
 * (`workspace-overlap.ts`). Contention became two diffs against a common base,
 * and a merge conflict routes to an integrator that can read it — which is a
 * thing intelligence is good at and a lock never was.
 *
 * Deliberately NOT built: a soft/advisory lock agents are told to respect.
 * Same liveness problem, less honesty.
 *
 * ## Why this file still exists
 *
 * The record on disk is vestigial, not forbidden. A repo upgraded mid-flight
 * has one, possibly naming a holder that will never return, and `doctor` has
 * to be able to say so and offer to remove it. So what survives here is a
 * READER and nothing else: no acquire, no release, no heartbeat, no probe, no
 * lock directory. Reading it can refuse no one.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Repo-relative lease path — machine-local, never committed, never ledger. */
export const WORKSPACE_LEASE_FILE = join('.fadeno', 'local', 'workspace-lease.json');

/**
 * The mkdir-lock directory the lease transitions used to be taken under.
 *
 * Retained for exactly one reason: `doctor` reports a leftover one and offers
 * removal. Nothing creates it, and nothing waits on it.
 */
export const WORKSPACE_LEASE_LOCK = join('.fadeno', 'local', '.workspace-lease.lock');

export interface LeaseHolder {
  /** Human-readable holder identity, e.g. dispatchId or run:step. */
  id: string;
  kind: 'ad-hoc' | 'engine' | 'host-dispatch';
  runId?: string;
  dispatchId?: string;
}

/**
 * What a vestigial `workspace-lease.json` holds. Field names are the
 * snake_case the writer used, so `fadeno show` and `doctor` project them
 * without translation.
 *
 * Every field is now REPORTING ONLY. `supervisor_pid` in particular is not
 * probed by anything: the probe is what made a pid-less record immortal, and
 * removing the probe is the point of the change, not a casualty of it.
 */
export interface WorkspaceLeaseRecord {
  workspace_mode: 'shared' | 'isolated';
  /** Primary holder retained for backward-compatible readers. */
  holder: LeaseHolder;
  /** Every holder the record named. */
  holders?: LeaseHolder[];
  /** Per-holder times, as the writer recorded them. */
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
  /** Repo-relative path of the in-flight claim this holder published, if any. */
  liveness_claim?: string | null;
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

/**
 * Read a vestigial lease record, or null when there is none to read.
 *
 * The validation is unchanged from when this record gated writers, and
 * deliberately so: `null` has to keep meaning exactly what `persisted-state`
 * documents it to mean — "no lease, OR a record this reader refuses" — or the
 * inventory's own description of its reader would silently become wrong.
 */
export function readWorkspaceLease(repoRoot: string): WorkspaceLeaseRecord | null {
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
  if (doc.workspace_mode !== 'shared' && doc.workspace_mode !== 'isolated') return null;
  if (doc.workspace_mode === 'isolated') return null; // isolated never occupied this file
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

export function workspaceLeaseHolderKey(holder: LeaseHolder): string {
  return JSON.stringify([holder.kind, holder.id, holder.runId ?? null, holder.dispatchId ?? null]);
}

/** What `doctor` says about a leftover lease file or lock directory. */
export interface VestigialWorkspaceLease {
  /** Repo-relative paths that are present and should not be. */
  paths: string[];
  /** The holder the record names, when the record still parses. */
  holder: LeaseHolder | null;
  /** When that holder took it, when the record still parses. */
  startedAt: string | null;
  /** A record that is present but no longer parses — reported, not diagnosed. */
  unreadable: boolean;
  detail: string;
  remediation: string;
}

/**
 * Describe a leftover lease file and/or lock directory, or null when the repo
 * has neither.
 *
 * Removal is UNCONDITIONALLY safe now, and that is the one thing this text has
 * to get across. The old remediation ended "only after verifying no writer
 * remains", which was correct advice about a lock and is actively misleading
 * about a file nothing reads: there is no writer to verify, because nothing
 * consults this record before writing any more. A reader who hedges here
 * leaves a wedged repo wedged.
 */
export function describeVestigialWorkspaceLease(repoRoot: string): VestigialWorkspaceLease | null {
  const leaseAbs = join(repoRoot, WORKSPACE_LEASE_FILE);
  const lockAbs = join(repoRoot, WORKSPACE_LEASE_LOCK);
  const paths: string[] = [];
  let leasePresent = false;
  try {
    if (existsSync(leaseAbs)) { paths.push(WORKSPACE_LEASE_FILE); leasePresent = true; }
  } catch { /* unreadable is reported below via the record */ }
  try {
    if (existsSync(lockAbs)) paths.push(WORKSPACE_LEASE_LOCK);
  } catch { /* best effort */ }
  if (paths.length === 0) return null;

  const record = leasePresent ? readWorkspaceLease(repoRoot) : null;
  const unreadable = leasePresent && record == null;
  const age = ((): string => {
    if (record == null) return '';
    const started = Date.parse(record.started_at);
    if (Number.isNaN(started)) return '';
    return ` (taken ${record.started_at})`;
  })();
  const named = record != null
    ? `naming ${record.holder.kind} "${record.holder.id}"${age}`
    : unreadable
      ? 'that no longer parses'
      : '';
  const what = paths.length === 2
    ? `a leftover writer lease and its lock directory (${paths.join(', ')})`
    : `a leftover ${paths[0] === WORKSPACE_LEASE_FILE ? 'writer lease' : 'lease lock directory'} (${paths[0]})`;
  return {
    paths,
    holder: record?.holder ?? null,
    startedAt: record?.started_at ?? null,
    unreadable,
    detail:
      `${what}${named === '' ? '' : ` ${named}`}. Fadeno no longer takes a repo-wide writer lease — ` +
      'nothing reads this file, and nothing is blocked by it.',
    remediation:
      `Delete ${paths.join(' and ')}. This is safe with work in flight: no command consults it, ` +
      'so there is no writer to verify first. Concurrent writers are now given their own worktrees ' +
      'and any overlap is recorded on both receipts.',
  };
}

/** Millisecond mtime of a leftover lock directory, or null when absent. */
export function vestigialLockMtimeMs(repoRoot: string): number | null {
  try {
    return statSync(join(repoRoot, WORKSPACE_LEASE_LOCK)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The RUNLESS host dispatch: `fadeno dispatch-open` / `fadeno dispatch-close`.
 *
 * # Why this exists
 *
 * `fadeno dispatch` (the command lane) isolates by default, merges the
 * primary's diff back, and writes a request row and a terminal receipt to
 * `.fadeno/dispatches.jsonl`. It needs no playbook, no run, and no ledger.
 *
 * The host lane's equivalent — `dispatch-prepare --isolate` → `dispatch-start`
 * → `dispatch-complete`/`dispatch-fail` — was RUN-SCOPED all the way down:
 * every one of those verbs takes a `<run>` and reads a `.fadeno/runs/<run>/`
 * ledger, and `requestHostDispatch` is only ever called by the engine. So a
 * director doing ad-hoc parallel work had exactly ONE way to get isolation
 * plus receipts, and it was the command lane. That asymmetry — not the wording
 * of any advisory note — is why a real Codex-director session put a five-lane
 * campaign on the command lane and lost all five reports.
 *
 * This module is the missing half. It gives the host lane the same three
 * things a command dispatch gets, with no run behind it:
 *
 *   - a prepared, isolated worktree with the caller's dirty state replayed
 *     into it (the SAME `prepareHostWorkspace` the engine's host lane uses);
 *   - a dispatch id;
 *   - a terminal receipt, in the SAME log the command lane writes to.
 *
 * The host still spawns the subagent — Fadeno cannot spawn into its own parent
 * session — but it now spawns against a prepared workspace and closes with a
 * receipt.
 *
 * # Where the record lives, and why it is not a run ledger
 *
 * The other candidate was a synthesized ledger under `.fadeno/runs/adhoc-*`,
 * which would have let every existing host-dispatch verb work unchanged. It
 * was rejected on the reader count. `.fadeno/dispatches.jsonl` has ONE entry
 * reader (`foldEvidenceRow` in `dispatches.ts`) and one recovery reader
 * (`loadOutputRecords`, same file). `.fadeno/runs/` has many: `listRuns`,
 * `resolveRun`, `verify`, `show`, `runs`, `status`, `clean`, `doctor`, the
 * persisted-state audit — and `run.schema.json` REQUIRES a `playbook` string,
 * so a run-shaped record with no playbook is either a schema violation or a
 * fiction with a made-up playbook name in it. Teaching all of those that some
 * runs are not runs is the one-list-many-consumers failure this repo keeps
 * re-committing. One log, one reader change.
 *
 * What the run ledger DOES own — a `run` path segment — is borrowed rather
 * than synthesized: `hostWorktreePath(run, dispatchId)` validates its first
 * argument as a path SEGMENT, not as a run id, so `ADHOC_HOST_SCOPE` fills
 * that slot and the worktree, state file and diff all land at their ordinary
 * places under a namespace no run id can collide with.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import {
  collectHostWorkspaceDiff,
  hostIsolatedDiffPath,
  hostWorktreePath,
  HostWorkspaceError,
  hostWorkspaceIgnoredOutput,
  prepareHostWorkspace,
  readHostWorkspaceState,
  removeHostWorkspaceByPath,
} from '../lib/host-workspace.ts';
import { settleIsolatedWork, type MergeBackResult } from '../lib/workspace-baseline.ts';
import { isRegisteredWorktree, type IgnoredOutputStamp, type IsolatedDiffResult } from '../lib/workspace-isolation.ts';
import { UNREADABLE_WINDOW_LOG_ID } from '../lib/receipt-attestations.ts';
import {
  closeDispatchWindow,
  detectConcurrentWrites,
  diffChangedPaths,
  openDispatchWindow,
  readDispatchWindows,
  type ConcurrentWriteStamp,
} from '../lib/workspace-overlap.ts';
import {
  appendEvidenceRow,
  DISPATCHES_FILE,
  DISPATCHES_FORMAT,
  normalizeDispatchTag,
  DispatchCommandError,
} from './dispatch.ts';

export class DispatchAdhocError extends Error {}

/**
 * The path segment that stands in for a run id.
 *
 * `hostWorktreePath` / `hostWorkspaceStatePath` / `hostIsolatedDiffPath` all
 * validate this argument against `HOST_WORKSPACE_SEGMENT_RE` and use it as one
 * directory (or filename) component. Nothing downstream resolves it as a run.
 *
 * It cannot collide with a real run: `runNewRun` builds every run id as
 * `YYYY-MM-DD-HHMM-<slug>`, so a run id always begins with a digit and this
 * begins with a letter. `adhocScopeIsUnreachableByRuns` states that as a
 * checked fact rather than a comment.
 */
export const ADHOC_HOST_SCOPE = 'adhoc';

/** The request row an ad-hoc host dispatch opens with. */
export const ADHOC_HOST_REQUESTED = 'adhoc_host_dispatch_requested';

/**
 * The ONE list of TERMINAL evidence events for an ad-hoc host dispatch — the
 * host-lane twin of `COMMAND_TERMINAL_RECEIPTS` in `dispatch.ts` and of
 * `TERMINAL_RECEIPTS` in `lib/host-dispatch.ts`, and here for the same reason.
 * Every consumer that asks "is this dispatch over?" reads it through
 * `adhocHostTerminalState`: the close preconditions below and
 * `foldEvidenceRow`'s reader. A private copy of the list in either of them is
 * how a second receipt lands in one place and is counted as unreadable damage
 * in the other.
 */
const ADHOC_TERMINAL_RECEIPTS: ReadonlyArray<{ event: string; state: AdhocHostState }> = [
  { event: 'adhoc_host_dispatch_closed', state: 'closed' },
];

/** Every state an ad-hoc host dispatch can be observed in, most terminal first. */
export type AdhocHostState = 'open' | 'closed';

/** The terminal state an event records, or null when it is not a receipt at all. */
export function adhocHostTerminalState(event: string | null | undefined): AdhocHostState | null {
  if (event == null) return null;
  return ADHOC_TERMINAL_RECEIPTS.find((receipt) => receipt.event === event)?.state ?? null;
}

/** True when the event opens an ad-hoc host dispatch. */
export function isAdhocHostRequest(event: string | null | undefined): boolean {
  return event === ADHOC_HOST_REQUESTED;
}

/**
 * Whether `ADHOC_HOST_SCOPE` is a namespace no `new-run` run id can reach.
 *
 * Exported so a test asserts it instead of a comment claiming it: if run ids
 * ever stop starting with a digit, the scope has to move, and a silent
 * collision would put an ad-hoc worktree inside a real run's worktree
 * directory.
 */
export function adhocScopeIsUnreachableByRuns(): boolean {
  return !/^[0-9]/.test(ADHOC_HOST_SCOPE);
}

/** What an ad-hoc host outcome can be. Deliberately the command lane's vocabulary. */
export type AdhocHostOutcome = 'ok' | 'failed';

export interface DispatchOpenOptions {
  /** Recorded on the row so `fadeno dispatches` can say what the agent was for. */
  archetype?: string | null;
  /** A short handle, so `dispatch-close tag:<t>` works like `--output tag:<t>`. */
  tag?: string | null;
  /** Free text the operator wants on the request row. */
  note?: string | null;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

export interface DispatchOpenResult {
  dispatchId: string;
  tag: string | null;
  archetype: string | null;
  /** Repo-relative. */
  workspace: string;
  /** Absolute — this is the path the host hands the subagent. */
  workspaceAbs: string;
  baseCommit: string;
  openedAt: string;
}

export interface DispatchCloseOptions {
  /** Full id, an 8+ character prefix, or `last`; ignored when `tag` is given. */
  dispatchId?: string;
  tag?: string | null;
  /** Present means the dispatch FAILED; the text is the receipt's reason. */
  reason?: string | null;
  /** Withhold the merge-back. The diff is still collected and named. */
  noMerge?: boolean;
  /** The host agent that did the work, when the host can name one. */
  agentId?: string | null;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
  onEcho?: (line: string) => void;
}

export interface DispatchCloseResult {
  dispatchId: string;
  tag: string | null;
  outcome: AdhocHostOutcome;
  /** Null when no merge was attempted (`--no-merge`, or a failed close). */
  merge: MergeBackResult | null;
  diffSnapshot: string | null;
  diffBytes: number | null;
  /** Repo-relative path of the worktree, when it is still there. */
  workspaceRetained: string | null;
  workspaceRemoved: boolean;
  /**
   * Gitignored content in that worktree that no diff carried out, or null
   * when the scan said there was none. Non-null with `workspaceRemoved:
   * false` is the teardown being REFUSED: the directory is the only copy.
   */
  ignoredOutput: IgnoredOutputStamp | null;
  concurrentWrites: ConcurrentWriteStamp[] | null;
  /** A prior identical receipt already stood; nothing new was appended. */
  idempotent: boolean;
  /** How `dispatchId`/`tag` resolved to this dispatch. */
  resolvedBy: 'id' | 'prefix' | 'tag' | 'last';
}

// ---------------------------------------------------------------------------
// Reading the log
// ---------------------------------------------------------------------------

/**
 * One ad-hoc host dispatch, folded from its rows.
 *
 * A separate projection from `DispatchEntry` on purpose: this one exists to
 * ANSWER the close command's preconditions (is it open, where is its worktree,
 * what receipt already stands), where `DispatchEntry` exists to RENDER. Both
 * read the same rows, and the terminal vocabulary they share comes from
 * `adhocHostTerminalState` above rather than from either one's own list.
 */
export interface AdhocHostRecord {
  dispatchId: string;
  tag: string | null;
  archetype: string | null;
  openedAt: string | null;
  /** Repo-relative worktree from the request row. */
  workspace: string | null;
  baseCommit: string | null;
  closed: boolean;
  outcome: AdhocHostOutcome | null;
  closeReason: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Fold `.fadeno/dispatches.jsonl` into ad-hoc host records, in request order.
 *
 * Unreadable lines are skipped rather than fatal, on the same rule every other
 * reader of this log follows: a torn tail must not hide the rows that
 * survived. Rows belonging to any other lane are simply not ours.
 */
export function readAdhocHostRecords(repoRoot: string): AdhocHostRecord[] {
  const absolute = join(repoRoot, DISPATCHES_FILE);
  const byId = new Map<string, AdhocHostRecord>();
  const order: string[] = [];
  if (!existsSync(absolute)) return [];
  for (const line of readFileSync(absolute, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = str(row.event);
    const dispatchId = str(row.dispatch_id);
    if (dispatchId == null) continue;
    if (isAdhocHostRequest(event)) {
      if (byId.has(dispatchId)) continue; // append-only: the first request wins
      byId.set(dispatchId, {
        dispatchId,
        tag: str(row.tag),
        archetype: str(row.archetype),
        openedAt: str(row.timestamp),
        workspace: str(row.workspace),
        baseCommit: str(row.base_commit),
        closed: false,
        outcome: null,
        closeReason: null,
      });
      order.push(dispatchId);
      continue;
    }
    if (adhocHostTerminalState(event) == null) continue;
    let record = byId.get(dispatchId);
    if (record == null) {
      // A receipt whose request row is gone (a truncated head) is still
      // evidence that the dispatch happened; surface it rather than drop it.
      record = {
        dispatchId,
        tag: str(row.tag),
        archetype: str(row.archetype),
        openedAt: null,
        workspace: str(row.workspace),
        baseCommit: str(row.base_commit),
        closed: false,
        outcome: null,
        closeReason: null,
      };
      byId.set(dispatchId, record);
      order.push(dispatchId);
    }
    record.closed = true;
    const outcome = str(row.outcome);
    record.outcome = outcome === 'ok' || outcome === 'failed' ? outcome : null;
    record.closeReason = str(row.reason);
    record.workspace = record.workspace ?? str(row.workspace);
  }
  return order.map((id) => byId.get(id)!);
}

/** Shortest prefix `dispatch-close` accepts, matching the command lane's rule. */
const CLOSE_ID_PREFIX_MIN = 8;

function resolveAdhocRecord(
  records: readonly AdhocHostRecord[],
  query: string,
  tag: string | null,
): { record: AdhocHostRecord; resolvedBy: DispatchCloseResult['resolvedBy'] } {
  if (tag != null) {
    const matches = records.filter((record) => record.tag === tag);
    if (matches.length === 0) {
      throw new DispatchAdhocError(
        `no ad-hoc host dispatch carries the tag "${tag}". \`fadeno dispatches\` lists what is recorded.`,
      );
    }
    // An open one first: a tag reused across a finished dispatch and a live
    // one names the live one, which is what an operator retiring work means.
    const open = matches.filter((record) => !record.closed);
    return { record: (open.length > 0 ? open : matches).at(-1)!, resolvedBy: 'tag' };
  }
  if (query === 'last') {
    const open = records.filter((record) => !record.closed);
    if (open.length === 0) {
      throw new DispatchAdhocError(
        'no ad-hoc host dispatch is open, so `last` names nothing. Open one with `fadeno dispatch-open`.',
      );
    }
    return { record: open.at(-1)!, resolvedBy: 'last' };
  }
  const exact = records.find((record) => record.dispatchId === query);
  if (exact != null) return { record: exact, resolvedBy: 'id' };
  if (query.length < CLOSE_ID_PREFIX_MIN) {
    throw new DispatchAdhocError(
      `"${query}" is too short to identify a dispatch: give the full id, at least ` +
        `${CLOSE_ID_PREFIX_MIN} characters of it, tag:<handle>, or \`last\`.`,
    );
  }
  const prefixed = records.filter((record) => record.dispatchId.startsWith(query));
  if (prefixed.length === 1) return { record: prefixed[0]!, resolvedBy: 'prefix' };
  if (prefixed.length > 1) {
    throw new DispatchAdhocError(
      `"${query}" matches ${prefixed.length} ad-hoc host dispatches; give more characters.`,
    );
  }
  throw new DispatchAdhocError(
    `no ad-hoc host dispatch matches "${query}". \`fadeno dispatches\` lists what is recorded.`,
  );
}

/**
 * Find an ad-hoc host dispatch by id or 8+ character prefix, or null.
 *
 * The read-only half of the resolver above, for callers that are ANSWERING a
 * question about an id rather than acting on one — `fadeno verify`, which has
 * to say something true when handed an ad-hoc dispatch id instead of a run.
 */
export function findAdhocHostDispatch(repoRoot: string, query: string): AdhocHostRecord | null {
  const trimmed = query.trim();
  if (trimmed === '') return null;
  const records = readAdhocHostRecords(repoRoot);
  const exact = records.find((record) => record.dispatchId === trimmed);
  if (exact != null) return exact;
  if (trimmed.length < CLOSE_ID_PREFIX_MIN) return null;
  const prefixed = records.filter((record) => record.dispatchId.startsWith(trimmed));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/**
 * Mint an ad-hoc host dispatch: an id, an isolated worktree, a request row.
 *
 * The worktree comes from `prepareHostWorkspace`, unchanged and unwrapped —
 * the same primitive `dispatch-prepare --isolate` calls — so an ad-hoc host
 * worktree is byte-for-byte the same kind of thing an engine-run host worktree
 * is: detached at HEAD, with the caller's tracked and untracked/unignored
 * state replayed on top as a synthetic baseline commit, guarded against
 * traversal and symlink escape, serialized by `.host-workspace.lock`.
 *
 * The overlap window opens HERE rather than at close, and for the same reason
 * the command lane opens its own before the spawn: a window has to exist for
 * the whole time anything could be writing, including the minutes between the
 * host being handed a workspace and the subagent producing its first byte.
 * Nothing is reserved — a window refuses no one — so a second writer that sees
 * this one gets its own tree instead of a queue behind a holder it could never
 * prove dead.
 */
export function runDispatchOpen(opts: DispatchOpenOptions = {}): DispatchOpenResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const now = opts.now ?? new Date();
  let tag: string | null;
  try {
    tag = normalizeDispatchTag(opts.tag);
  } catch (err) {
    // One tag vocabulary across both lanes: re-raise the kernel's own wording
    // rather than inventing a second rule for the same handle.
    throw new DispatchAdhocError(err instanceof DispatchCommandError ? err.message : String(err));
  }
  const archetype = opts.archetype?.trim() || null;
  const note = opts.note?.trim() || null;
  const dispatchId = randomUUID();

  let prepared;
  try {
    prepared = prepareHostWorkspace({ repoRoot, run: ADHOC_HOST_SCOPE, dispatchId, now });
  } catch (err) {
    if (err instanceof HostWorkspaceError) {
      throw new DispatchAdhocError(
        `could not prepare an isolated workspace for the ad-hoc host dispatch: ${err.message}`,
      );
    }
    throw err;
  }
  const state = prepared.state;
  const workspaceAbs = resolve(repoRoot, state.workspace);

  // Before the row, not after: a window that opens only once the row is down
  // leaves a gap in which a concurrent dispatch believes it is alone.
  openDispatchWindow(repoRoot, {
    dispatchId,
    runId: null,
    kind: 'host-dispatch',
    workspaceMode: 'isolated',
    startedAt: now,
  });
  try {
    appendEvidenceRow(repoRoot, {
      format: DISPATCHES_FORMAT,
      timestamp: now.toISOString(),
      event: ADHOC_HOST_REQUESTED,
      dispatch_id: dispatchId,
      ...(tag != null ? { tag } : {}),
      ...(archetype != null ? { archetype } : {}),
      ...(note != null ? { note } : {}),
      adapter: 'host',
      transport: 'host',
      workspace_mode: 'isolated',
      workspace: state.workspace,
      base_commit: state.base_commit,
    });
  } catch (error) {
    closeDispatchWindow(repoRoot, { dispatchId, changedPaths: [] });
    try {
      removeHostWorkspaceByPath({ repoRoot, run: ADHOC_HOST_SCOPE, dispatchId, workspaceRel: state.workspace });
    } catch {
      // best-effort: a worktree that survives a failed open is reported by
      // `fadeno doctor`, where an unrecorded dispatch would not be.
    }
    throw error;
  }

  return {
    dispatchId,
    tag,
    archetype,
    workspace: state.workspace,
    workspaceAbs,
    baseCommit: state.base_commit,
    openedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

/**
 * Write the terminal receipt for an ad-hoc host dispatch.
 *
 * ONE terminal receipt event, not two. The engine's host lane splits
 * `dispatch-complete` from `dispatch-fail` because a `dispatch-start` sits
 * between the request and them, so the two receipts answer genuinely different
 * questions ("the agent reported" vs "the agent never did"). An ad-hoc host
 * dispatch records no start — the host spawns out of band and Fadeno never
 * sees it — so there is nothing for a second event name to distinguish, and
 * two names for one fact is how a reader ends up handling one and dropping the
 * other. The outcome rides on the row.
 *
 * The worktree is torn down on exactly one condition: the work landed in the
 * caller's tree. Every other ending — `--no-merge`, a failed close, an
 * unresolved merge — RETAINS it and says where it is. One rule, and it can
 * never destroy work that has nowhere else to be.
 */
export function runDispatchClose(opts: DispatchCloseOptions = {}): DispatchCloseResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const now = opts.now ?? new Date();
  const tag = opts.tag?.trim() ? opts.tag.trim() : null;
  const query = (opts.dispatchId ?? '').trim();
  if (tag == null && query === '') {
    throw new DispatchAdhocError(
      'name what to close: a dispatch id, an 8+ character prefix, tag:<handle>, or `last`.',
    );
  }
  const reason = opts.reason?.trim() || null;
  const outcome: AdhocHostOutcome = reason != null ? 'failed' : 'ok';

  const records = readAdhocHostRecords(repoRoot);
  const { record, resolvedBy } = resolveAdhocRecord(records, query, tag);
  const id8 = record.dispatchId.slice(0, 8);

  if (record.closed) {
    // Replay the receipt that already stands rather than appending a second
    // one — the same rule both other lanes apply, for the same reason: a
    // repeat is answering for the close that already happened.
    if (record.outcome === outcome && record.closeReason === reason) {
      return {
        dispatchId: record.dispatchId,
        tag: record.tag,
        outcome,
        merge: null,
        diffSnapshot: null,
        diffBytes: null,
        workspaceRetained: record.workspace,
        workspaceRemoved: false,
        // The replay answers for the close that already happened; the stamp
        // it wrote is on that receipt. Re-scanning now would report the
        // worktree's state at replay time as though it were the close's
        // finding, which is a different claim wearing the same field.
        ignoredOutput: null,
        concurrentWrites: null,
        idempotent: true,
        resolvedBy,
      };
    }
    throw new DispatchAdhocError(
      `ad-hoc host dispatch ${id8} already has a terminal receipt (${record.outcome ?? 'unstated'}` +
        `${record.closeReason != null ? `: ${record.closeReason}` : ''}). The log is append-only; a second ` +
        'receipt would not replace the first.',
    );
  }

  const workspaceRel = record.workspace ?? hostWorktreePath(ADHOC_HOST_SCOPE, record.dispatchId);
  const worktreeAbs = resolve(repoRoot, workspaceRel);

  // Evidence first. A receipt that names no diff is a receipt that lost the
  // work, and the collection is what proves the directory is this dispatch's
  // own registered worktree before anything stages or removes it.
  let diffSnapshot: string | null = null;
  let diffBytes: number | null = null;
  let diff: IsolatedDiffResult | null = null;
  let collectError: string | null = null;
  const state = readAdhocState(repoRoot, record.dispatchId);
  if (state != null) {
    try {
      const collected = collectHostWorkspaceDiff({ repoRoot, state });
      diffSnapshot = collected.diffSnapshot;
      diffBytes = collected.diffBytes;
      diff = {
        diffRel: collected.diffSnapshot,
        diffAbs: resolve(repoRoot, collected.diffSnapshot),
        diffBytes: collected.diffBytes,
      };
    } catch (err) {
      collectError = err instanceof Error ? err.message : String(err);
    }
  } else {
    collectError =
      `no registered worktree at "${workspaceRel}" and no readable workspace state for ${id8}; ` +
      `any diff this dispatch produced would have been written to ` +
      `${hostIsolatedDiffPath(ADHOC_HOST_SCOPE, record.dispatchId)}`;
  }
  if (collectError != null && outcome === 'ok') {
    // A successful close with no evidence would claim the work landed
    // somewhere. Refuse and preserve, exactly as the engine's host lane does.
    throw new DispatchAdhocError(
      `ad-hoc host dispatch ${id8}: the isolated worktree at "${workspaceRel}" could not be collected ` +
        `(${collectError}). Nothing was merged and nothing was removed. Close it with --reason once you ` +
        'have decided what to do with the tree, or fix the worktree and retry.',
    );
  }

  // The merge-back. Withheld on `--no-merge` and on a failed close: in both
  // the operator has said the work is not ready for the caller's tree, and a
  // merge would be the silent substitution `--isolate` refuses in the other
  // direction.
  let merge: MergeBackResult | null = null;
  if (outcome === 'ok' && opts.noMerge !== true && diff != null) {
    try {
      const settled = settleIsolatedWork({
        repoRoot,
        worktreeAbs,
        diff,
        baselineRef: `${ADHOC_HOST_SCOPE}:${id8}:rebase`,
        armLabel: 'host agent',
      });
      merge = settled.stamp;
      diff = settled.diff;
      diffSnapshot = settled.diff.diffRel;
      // `settleIsolatedWork` re-collects after a clean rebase, so this is the
      // byte count of the diff that was actually applied. The machine-local
      // state file still records the pre-rebase count; the RECEIPT is the
      // authority, and the state file is bookkeeping nothing else reads for
      // this scope.
      diffBytes = settled.diff.diffBytes;
    } catch (err) {
      merge = {
        status: 'blocked',
        detail: `the merge-back could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Tear down only when the work is in the caller's tree — and only when the
  // worktree is not the last copy of something the diff could not carry.
  //
  // This lane had NO ignored-output detection at all before: a host agent
  // that wrote a gitignored deliverable saw it merged back through the same
  // `git add -A` that skips it, and then removed with the directory, with the
  // receipt saying nothing whatsoever. That is the command lane's failure
  // minus the record of it, on the lane Fadeno steers people toward.
  // `removeHostWorkspaceByPath` now refuses the teardown and hands back what
  // it found; this reads that verdict so the receipt can state it.
  const landed = merge != null && merge.status === 'clean';
  let workspaceRemoved = false;
  let ignoredOutput: IgnoredOutputStamp | null = null;
  if (landed) {
    try {
      ignoredOutput = removeHostWorkspaceByPath({ repoRoot, run: ADHOC_HOST_SCOPE, dispatchId: record.dispatchId, workspaceRel }).ignoredOutput;
    } catch {
      // best-effort; the receipt is a fact and never waits on the disk
    }
    workspaceRemoved = !existsSync(worktreeAbs);
  } else if (workspaceRel.length > 0) {
    // Nothing was torn down, so nothing is lost — but the row still has to
    // say the content is in there. A `--no-merge` close or a failed one hands
    // the operator a worktree; which of the things in it will never reach
    // their tree by patch is exactly what they need to know before deciding
    // what to do with it.
    ignoredOutput = hostWorkspaceIgnoredOutput(repoRoot, workspaceRel);
  }
  const workspaceRetained = workspaceRemoved ? null : workspaceRel;
  if (ignoredOutput != null && workspaceRetained != null) {
    opts.onEcho?.(
      `gitignored output KEPT — ${ignoredOutput.paths.slice(0, 6).join(', ') || 'content the listing could not enumerate'} ` +
        `is gitignored, so \`git add -A\` staged none of it and no diff carried it out. The worktree is RETAINED at ` +
        `${workspaceRetained}: that directory is the only copy. Copy what you need out of it before \`fadeno clean --force\` reclaims it.`,
    );
  }

  // The overlap window closes with this delivery's own path set — from its
  // diff, so the paths are attributable to the delivery rather than to
  // whatever else touched the tree in the same minutes.
  let concurrentWrites: ConcurrentWriteStamp[] | null = null;
  {
    const changed = diffSnapshot != null
      ? diffChangedPaths(repoRoot, join(repoRoot, ...diffSnapshot.split('/')))
      : null;
    const truncated = changed == null;
    const paths = changed ?? [];
    const log = readDispatchWindows(repoRoot);
    concurrentWrites = detectConcurrentWrites(
      {
        dispatchId: record.dispatchId,
        startedAt: record.openedAt ?? now.toISOString(),
        endedAt: now.toISOString(),
        workspaceMode: 'isolated',
        changedPaths: paths,
        truncated,
      },
      log.windows,
      { logDegraded: log.degraded },
    );
    if (concurrentWrites != null) {
      // The log-unreadable stamp names no delivery, so it is never counted as
      // one; the receipt still carries it.
      const named = concurrentWrites.filter((stamp) => stamp.dispatch_id !== UNREADABLE_WINDOW_LOG_ID);
      if (named.length > 0) opts.onEcho?.(
        `concurrent_write: ${named.length} other ` +
          `${named.length === 1 ? 'delivery' : 'deliveries'} overlapped this one ` +
          `(${named.map((s) => `${s.dispatch_id.slice(0, 8)}:${s.paths_intersecting}`).join(', ')}). ` +
          'The receipt says what each one establishes.',
      );
    }
    closeDispatchWindow(repoRoot, { dispatchId: record.dispatchId, changedPaths: paths, truncated, endedAt: now });
  }

  appendEvidenceRow(repoRoot, {
    format: DISPATCHES_FORMAT,
    timestamp: now.toISOString(),
    event: ADHOC_TERMINAL_RECEIPTS[0]!.event,
    dispatch_id: record.dispatchId,
    ...(record.tag != null ? { tag: record.tag } : {}),
    ...(record.archetype != null ? { archetype: record.archetype } : {}),
    ...(opts.agentId?.trim() ? { agent_id: opts.agentId.trim() } : {}),
    adapter: 'host',
    transport: 'host',
    outcome,
    ...(reason != null ? { reason } : {}),
    closed_by: 'host',
    workspace_mode: 'isolated',
    ...(record.baseCommit != null ? { base_commit: record.baseCommit } : {}),
    ...(diffSnapshot != null && diffBytes != null ? { diff_snapshot: diffSnapshot, diff_bytes: diffBytes } : {}),
    ...(collectError != null ? { error: `diff not collected: ${collectError}` } : {}),
    ...(merge != null ? { primary_merge: merge } : {}),
    ...(workspaceRetained != null ? { workspace: workspaceRetained, workspace_retained: true } : {}),
    // Same field, same parser, same phrasing as the command lane's — so
    // `verify`, `show`, `dispatches` and the in-band `--output` banner read a
    // host delivery's destroyed-or-kept output without knowing which lane
    // produced it. `retained_at` is set by `hostWorkspaceIgnoredOutput`,
    // which only ever names a directory it just saw on disk.
    ...(ignoredOutput != null ? { ignored_output_discarded: ignoredOutput } : {}),
    workspace_removed: workspaceRemoved,
    ...(concurrentWrites != null ? { concurrent_write: concurrentWrites } : {}),
  });

  return {
    dispatchId: record.dispatchId,
    tag: record.tag,
    outcome,
    merge,
    diffSnapshot,
    diffBytes,
    workspaceRetained,
    workspaceRemoved,
    ignoredOutput,
    concurrentWrites,
    idempotent: false,
    resolvedBy,
  };
}

/** This scope's machine-local workspace state, or null when it is gone or malformed. */
function readAdhocState(repoRoot: string, dispatchId: string) {
  try {
    const state = readHostWorkspaceState(repoRoot, ADHOC_HOST_SCOPE, dispatchId);
    if (state == null) return null;
    // Never stage or remove a directory that is not proven to be this
    // dispatch's own registered worktree.
    if (!isRegisteredWorktree(repoRoot, resolve(repoRoot, state.workspace))) return null;
    return state;
  } catch (err) {
    if (err instanceof HostWorkspaceError) return null;
    throw err;
  }
}

/** Repo-relative rendering of an absolute path, for operator-facing lines. */
export function repoRelative(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).split('\\').join('/');
}

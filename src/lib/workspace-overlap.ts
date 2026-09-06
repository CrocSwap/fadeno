/**
 * Overlap detection — what replaced the repo-wide writer lock.
 *
 * ## Why this exists
 *
 * Fadeno used to prevent two writers with a lease (`workspace-lease.ts`, now
 * vestigial). The lease had to answer *"is the current holder still alive?"*,
 * which Fadeno cannot: a host delivery publishes no pid, so its lease was
 * immortal and a killed agent wedged the repo. Removing the lock is right.
 *
 * Removing it WITHOUT this module would be worse than the wedge. A wedge is
 * loud — a refusal, with a message, that a human resolves. Two writers landing
 * in one tree with nothing watching is silent lost writes: the second one's
 * `git apply` succeeds, or the human's editor saves over an agent's edit, and
 * the only symptom is work that quietly is not there. So prevention was traded
 * for detection, not for nothing.
 *
 * ## The model
 *
 * Every delivery opens a WINDOW when it starts and closes it when its terminal
 * receipt is written. Two windows OVERLAP when their intervals intersect. On
 * closing, a delivery reports the repo-relative paths it changed, and any
 * overlapping window whose path set intersects its own produces a
 * `concurrent_write` stamp on the receipt, naming the other dispatch and the
 * intersecting paths.
 *
 * Windows live in `.fadeno/local/` as an append-only log. Machine-local, never
 * ledger evidence, never gating: a missing, truncated, or unreadable log makes
 * this detector say less, never say "clean". The append-only shape is what
 * makes it safe under concurrency — the thing it observes is concurrent
 * writers, so it must not itself need a lock to record them.
 *
 * ## What a stamp is, and is not
 *
 * `concurrent_write` is an ATTESTATION, in the same sense as `carry_mutated`
 * and `workspace_changed`: it says two windows overlapped and touched the same
 * paths. It does not say either one lost work, and for a `shared` window it
 * cannot even say the window's own delivery made the change — a shared
 * window's path set is the tree's delta over its interval, which includes
 * whatever the human did in the same minutes. An `isolated` window's set IS
 * attributable, because it comes from that worktree's own diff.
 *
 * That asymmetry is recorded on the stamp (`attribution`) rather than papered
 * over, because a reader who mistakes an attestation for an accusation will go
 * looking for a culprit that may not exist.
 *
 * ## What it will not see
 *
 * 1. **A delivery that never opened a window** — anything outside the kernel:
 *    the human's own editor, a stray script, an agent working without a
 *    dispatch. Their edits still land in a shared window's path set (that is
 *    what makes a shared set an attestation), but they have no window of their
 *    own to intersect against.
 * 2. **Same-file, disjoint-hunk edits.** Path granularity, not hunk. Two
 *    agents editing different functions in one file is reported as an overlap.
 *    That is deliberate: this is the input to a human or an integrator, and a
 *    false alarm costs a glance while a miss costs the work.
 * 3. **Anything after the window closes.** The interval is the receipt's, not
 *    the agent's; work that lands after a terminal receipt is nobody's window.
 * 4. **A log that could not be read.** Reported as `degraded`, never as clean.
 *
 * ## Why the log is bounded
 *
 * Append-only is how the log stays lock-free; it is not a licence to grow
 * forever. Left alone, every dispatch a repo has ever run stays in the file and
 * is re-read on every terminal, every `shouldAutoIsolate`, and every overlap
 * detection — and one torn line (what an interrupted append looks like) makes
 * `readDispatchWindows` return `degraded` FOREVER, so every later receipt
 * carries the log-unreadable stamp until a human notices a file nothing told
 * them about. `compactDispatchWindows` is the answer to both, and
 * `dispatchWindowLogFindings` is what finally says the file exists.
 */

import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { WorkspaceMode } from './workspace-isolation.ts';
// One token, spelled once. The writer emits the log-unreadable stamp and four
// surfaces have to recognise it; a second copy of the string here is the
// one-list-two-consumers shape that ends in a reader silently saying "clean".
import { UNREADABLE_WINDOW_LOG_ID } from './receipt-attestations.ts';

/** Repo-relative window log. Machine-local; never committed, never ledger. */
export const DISPATCH_WINDOWS_FILE = join('.fadeno', 'local', 'dispatch-windows.jsonl');

/**
 * How many paths one window records.
 *
 * A window that changed more than this is recorded as `truncated`, and a
 * truncated set can only ever produce a `degraded` verdict — never a clean
 * one. Sized well above an ordinary agent pass (tens of files) and far below
 * a tree-wide regeneration, which is the case where a path list stops being
 * useful to a reader anyway.
 */
export const WINDOW_MAX_PATHS = 2_000;

/** How many intersecting paths one stamp names. The count is exact; the list is a sample. */
export const OVERLAP_MAX_EXAMPLES = 20;

const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;

/** Who opened a window. Mirrors the old lease holder kinds. */
export type WindowKind = 'ad-hoc' | 'engine' | 'host-dispatch';

export interface DispatchWindow {
  dispatchId: string;
  runId: string | null;
  kind: WindowKind;
  workspaceMode: WorkspaceMode;
  startedAt: string;
  /** Null while the delivery is still in flight. */
  endedAt: string | null;
  /**
   * Repo-relative paths the window changed, or null while it is open.
   *
   * For `isolated`, these come from the worktree's own diff and are
   * attributable to this delivery. For `shared`, they are the tree's delta
   * over the interval and are an attestation only.
   */
  changedPaths: string[] | null;
  /** The path listing hit `WINDOW_MAX_PATHS` or could not be produced whole. */
  truncated: boolean;
}

/** How much a window's path set can be said about its own delivery. */
export type OverlapAttribution =
  /** An isolated worktree's own diff: these paths are this delivery's work. */
  | 'delivery'
  /** A shared tree's delta over the interval: this delivery, or anyone else. */
  | 'workspace';

/** The row-shaped projection. snake_case: it lands verbatim on a receipt. */
export interface ConcurrentWriteStamp {
  /**
   * The other window's dispatch id, or `UNREADABLE_WINDOW_LOG_ID` on the one
   * stamp that names no window at all.
   */
  dispatch_id: string;
  run_id?: string;
  /**
   * Absent only on the log-unreadable stamp: it describes windows that could
   * not be read, so nothing about them — kind, mode, attribution — is known.
   * Absence is this file's only spelling of "not known"; a placeholder value
   * would be a claim.
   */
  kind?: WindowKind;
  workspace_mode?: WorkspaceMode;
  /** How the OTHER window's path set was derived. */
  attribution?: OverlapAttribution;
  /** Exact count of intersecting paths; `paths` is a sample of it. */
  paths_intersecting: number;
  paths: string[];
  /**
   * Absent when the other window had not closed yet, so no set existed to
   * intersect. The overlap in TIME is still recorded, and the other side
   * closes later — its receipt is where any intersection is recorded.
   */
  pending?: true;
  /**
   * Present when either side's listing was incomplete — including the case
   * where a side could not enumerate its changes AT ALL, which is a
   * `paths_intersecting: 0` stamp that means "unknown", not "nothing".
   */
  degraded?: true;
  note: string;
}

function windowsAbs(repoRoot: string): string {
  return join(repoRoot, DISPATCH_WINDOWS_FILE);
}

function appendRow(repoRoot: string, row: Record<string, unknown>): void {
  const abs = windowsAbs(repoRoot);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    // One `appendFileSync` of one line. O_APPEND makes a write below
    // PIPE_BUF atomic between processes, which is exactly the property a log
    // written BY concurrent writers needs — it must not need the lock it
    // exists because we removed.
    appendFileSync(abs, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // Never fatal. A dispatch that cannot record its window still runs; the
    // cost is that its overlaps go unreported, which `readDispatchWindows`
    // surfaces as a degraded verdict rather than a clean one.
  }
}

/**
 * Record that a delivery has started writing.
 *
 * Called before the executor is spawned, so a window exists for the whole
 * time anything could be writing — including the moments before the executor
 * produces its first byte, which is when a second dispatch is most likely to
 * be deciding whether it is alone.
 */
export function openDispatchWindow(
  repoRoot: string,
  opts: {
    dispatchId: string;
    runId?: string | null;
    kind: WindowKind;
    workspaceMode: WorkspaceMode;
    startedAt?: Date;
  },
): void {
  appendRow(repoRoot, {
    event: 'window_opened',
    dispatch_id: opts.dispatchId,
    run_id: opts.runId ?? null,
    kind: opts.kind,
    workspace_mode: opts.workspaceMode,
    started_at: (opts.startedAt ?? new Date()).toISOString(),
  });
}

/**
 * Record that a delivery has stopped writing, and what it changed.
 *
 * Must be called on EVERY terminal path, success or failure: a window left
 * open is read as "still writing" by every later dispatch, which would make
 * them isolate unnecessarily forever. That failure mode is deliberately the
 * benign one — an unnecessary worktree costs a checkout, where a window closed
 * too early costs a missed overlap.
 *
 * This is also where the log is bounded. A close is the one moment that is
 * already paying to read the whole file (the terminal computes its overlaps
 * from it), it is the only moment that ever makes a window droppable, and the
 * work is amortised to nothing: compaction fires only past
 * `WINDOW_LOG_COMPACT_BYTES` and leaves the file small enough that the next
 * several hundred closes pay one `statSync` and stop. Doing it here is what
 * makes the bound automatic instead of a chore a doctor has to nag about; the
 * explicit `fadeno clean --windows` exists for the log that is small and torn,
 * which no threshold would ever reach.
 */
export function closeDispatchWindow(
  repoRoot: string,
  opts: {
    dispatchId: string;
    changedPaths: readonly string[];
    truncated?: boolean;
    endedAt?: Date;
  },
): void {
  const paths = [...new Set(opts.changedPaths)].sort();
  const capped = paths.length > WINDOW_MAX_PATHS;
  appendRow(repoRoot, {
    event: 'window_closed',
    dispatch_id: opts.dispatchId,
    ended_at: (opts.endedAt ?? new Date()).toISOString(),
    changed_paths: capped ? paths.slice(0, WINDOW_MAX_PATHS) : paths,
    truncated: Boolean(opts.truncated) || capped,
  });
  try {
    compactDispatchWindows(repoRoot, { minBytes: WINDOW_LOG_COMPACT_BYTES });
  } catch {
    // Never fatal, for the same reason the append is not: housekeeping on a
    // machine-local file must not be able to fail a recorded terminal.
  }
}

/**
 * One line of the log, already validated — or `null` for a line no reader can
 * use (torn, blank mid-file, no `dispatch_id`, unknown `event`, unparseable
 * timestamp, `changed_paths` that is not an array).
 *
 * Split out of `readDispatchWindows` so the FOLD and COMPACTION agree by
 * construction about which lines are usable. Two hand-written copies of that
 * judgment is the one-list-two-consumers shape this project keeps getting
 * bitten by: a compactor that classified a line differently from the reader
 * would either drop a row the reader wanted or preserve a row that keeps the
 * log degraded, and both fail silently.
 */
type WindowLogRow =
  | {
    kind: 'open';
    id: string;
    startedAt: string;
    runId: string | null;
    windowKind: WindowKind;
    workspaceMode: WorkspaceMode;
  }
  | { kind: 'close'; id: string; endedAt: string; paths: string[]; truncated: boolean };

interface ClassifiedLine {
  /** The line exactly as it appeared, without its newline. Compaction re-emits this verbatim. */
  raw: string;
  /** Null when no reader can use this line; that is also what makes the log `degraded`. */
  row: WindowLogRow | null;
}

function parseWindowLogLine(line: string): WindowLogRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    // A torn line is what an interrupted append looks like.
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const id = typeof row.dispatch_id === 'string' && row.dispatch_id.length > 0 ? row.dispatch_id : null;
  if (id == null) return null;
  if (row.event === 'window_opened') {
    const startedAt = typeof row.started_at === 'string' ? row.started_at : null;
    if (startedAt == null || Number.isNaN(Date.parse(startedAt))) return null;
    return {
      kind: 'open',
      id,
      startedAt,
      runId: typeof row.run_id === 'string' ? row.run_id : null,
      windowKind: row.kind === 'engine' || row.kind === 'host-dispatch' ? row.kind : 'ad-hoc',
      workspaceMode: row.workspace_mode === 'isolated' ? 'isolated' : 'shared',
    };
  }
  if (row.event === 'window_closed') {
    const endedAt = typeof row.ended_at === 'string' ? row.ended_at : null;
    if (endedAt == null || Number.isNaN(Date.parse(endedAt))) return null;
    const raw = Array.isArray(row.changed_paths) ? row.changed_paths : null;
    if (raw == null) return null;
    const paths = raw.filter((p): p is string => typeof p === 'string');
    return { kind: 'close', id, endedAt, paths, truncated: row.truncated === true || paths.length !== raw.length };
  }
  return null;
}

/** Every line of the log, classified once. The trailing newline is not a line. */
function classifyWindowLog(text: string): { entries: ClassifiedLine[]; degraded: boolean } {
  const entries: ClassifiedLine[] = [];
  let degraded = false;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (raw.trim().length === 0) {
      // A trailing newline is normal; a blank line in the middle is not.
      if (index === lines.length - 1) continue;
      degraded = true;
      entries.push({ raw, row: null });
      continue;
    }
    const row = parseWindowLogLine(raw);
    if (row == null) degraded = true;
    entries.push({ raw, row });
  }
  return { entries, degraded };
}

/**
 * Fold the append-only log into one record per dispatch.
 *
 * A close with no matching open is dropped: it names a window this log never
 * saw begin, so its interval is unknown and an unknown interval cannot be
 * intersected with anything. A duplicate open keeps the FIRST (the earliest
 * moment the delivery could have been writing); a duplicate close keeps the
 * LAST (the latest moment it could still have been).
 *
 * "No matching open" means NO OPEN ANYWHERE IN THE FILE, which is why the fold
 * runs in two passes rather than one. The single-pass version answered a
 * subtly different question — "no open EARLIER IN THE FILE" — and so depended
 * on physical line order, which no invariant here ever claimed. That
 * dependence is what `compactDispatchWindows` would otherwise be able to
 * violate: it drains rows that raced its rewrite and re-appends them at the
 * end, so a close can legitimately land ahead of its own open. Removing the
 * ordering assumption keeps the invariant that was actually documented (a
 * close whose open this log never saw is an orphan, and orphans are degraded)
 * and drops one the code only ever had by accident.
 */
export function readDispatchWindows(repoRoot: string): { windows: DispatchWindow[]; degraded: boolean } {
  const abs = windowsAbs(repoRoot);
  if (!existsSync(abs)) return { windows: [], degraded: false };
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return { windows: [], degraded: true };
  }
  const { entries, degraded: lineDegraded } = classifyWindowLog(text);
  let degraded = lineDegraded;
  const byId = new Map<string, DispatchWindow>();
  for (const entry of entries) {
    const row = entry.row;
    if (row == null || row.kind !== 'open') continue;
    if (byId.has(row.id)) continue; // keep the first open
    byId.set(row.id, {
      dispatchId: row.id,
      runId: row.runId,
      kind: row.windowKind,
      workspaceMode: row.workspaceMode,
      startedAt: row.startedAt,
      endedAt: null,
      changedPaths: null,
      truncated: false,
    });
  }
  for (const entry of entries) {
    const row = entry.row;
    if (row == null || row.kind !== 'close') continue;
    const open = byId.get(row.id);
    if (open == null) { degraded = true; continue; }
    open.endedAt = row.endedAt;
    // A duplicate close MERGES rather than replaces. "Last close wins" was
    // fine for the interval — the latest moment the delivery could still
    // have been writing — and destructive for the path set: a terminal
    // receipt reissued idempotently closes the window a second time with
    // nothing to report, and that second row overwrote the first one's
    // complete listing with an empty one. The honest merge of a known set
    // and an unknown set is the known set, marked truncated.
    open.changedPaths = open.changedPaths == null
      ? row.paths
      : [...new Set([...open.changedPaths, ...row.paths])].sort();
    open.truncated = open.truncated || row.truncated;
  }
  return { windows: [...byId.values()], degraded };
}

// ---------------------------------------------------------------------------
// Compaction — the bound on an append-only file, and the repair for a torn one
// ---------------------------------------------------------------------------

/**
 * How long a CLOSED window is kept past the point it can still overlap
 * anything.
 *
 * The overlap argument alone would allow a much tighter bound (see
 * `compactDispatchWindows`), so this is not the load-bearing half — it is the
 * margin for the one case the argument cannot see: a delivery whose OPEN row
 * never reached the log (the append failed, or the row was torn), which
 * therefore raises no floor of its own and closes later against
 * `startFallbackIso`. Twenty-four hours is a judgment: comfortably longer than
 * any delivery this kernel has produced, and short enough that a repo running
 * Fadeno for months holds a day of history rather than all of it.
 */
export const WINDOW_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The size at which `closeDispatchWindow` compacts opportunistically.
 *
 * An open row is ~200 bytes and a close row with a typical path set is a few
 * hundred, so 256 KiB is on the order of a thousand deliveries — far past
 * "this repo has been busy" and far short of anything that matters to read.
 * Below it, the only cost of the check is one `statSync`.
 */
export const WINDOW_LOG_COMPACT_BYTES = 256 * 1024;

/** What one compaction pass did, or why it did nothing. */
export interface WindowLogCompaction {
  /** Repo-relative path of the log, so a caller can name it without rebuilding it. */
  path: string;
  /** The file was rewritten. False for a dry run and for every skip. */
  compacted: boolean;
  dryRun: boolean;
  /** Set when nothing was done, and says why. Null when a rewrite happened. */
  skipped: string | null;
  bytesBefore: number;
  /** Size after the rewrite; equal to `bytesBefore` when nothing was written. */
  bytesAfter: number;
  rowsBefore: number;
  /** Rows a rewrite would drop (reported on a dry run too). */
  rowsDropped: number;
  /** Of those, rows no reader could use — the repair half. */
  unreadableRowsDropped: number;
  /** Closed windows dropped whole because their interval can no longer meet anything. */
  windowsDropped: number;
  /** Open windows, which are never dropped whatever their age. */
  openWindowsKept: number;
  /** Rows that landed during the rewrite and were carried across it. */
  rowsDrained: number;
}

function noCompaction(
  skipped: string,
  over: Partial<WindowLogCompaction> = {},
): WindowLogCompaction {
  return {
    path: DISPATCH_WINDOWS_FILE,
    compacted: false,
    dryRun: false,
    skipped,
    bytesBefore: 0,
    bytesAfter: 0,
    rowsBefore: 0,
    rowsDropped: 0,
    unreadableRowsDropped: 0,
    windowsDropped: 0,
    openWindowsKept: 0,
    rowsDrained: 0,
    ...over,
  };
}

/**
 * Rewrite the window log without the rows that can no longer say anything.
 *
 * ## What is droppable
 *
 * An OPEN window is never droppable, at any age. It is the auto-isolate
 * signal, and dropping it silently un-isolates real contention — the one
 * failure this whole module exists to prevent. An open window that is
 * absurdly old is a crashed writer leaking that signal, which costs later
 * deliveries an unnecessary worktree and is therefore a REPORTING problem:
 * `dispatchWindowLogFindings` names it, and compaction leaves it alone.
 *
 * A CLOSED window `[s, e]` is droppable when `e` is before the horizon
 *
 *     horizon = min(earliest start among OPEN windows, now − retention)
 *
 * because a window can only be intersected against by a delivery that is
 * still going to close, and every such delivery either (a) has an open row in
 * this log, so its start is at or after the earliest open start, or (b) has
 * not begun yet, so its start is after `now`. Either way its interval starts
 * after `e` and the two cannot meet. The retention term covers case (c), the
 * one the argument cannot see: a delivery whose open row never reached the log
 * and which therefore raises no floor.
 *
 * Windows already closed are not recomputed by anything — their receipts are
 * written — so a dropped window's overlaps with other CLOSED windows are not
 * an answer anyone will ask for again.
 *
 * ## What else is dropped
 *
 * Every line no reader can use: torn appends, blank lines mid-file, rows with
 * no `dispatch_id`, unknown events, unparseable timestamps, and closes whose
 * open appears nowhere in the file. That is the repair. Until something
 * rewrites this file one torn line makes `readDispatchWindows` return
 * `degraded` forever, and `degraded` puts `UNREADABLE_WINDOW_LOG_ID` on every
 * receipt the repo writes from then on.
 *
 * ## The race, and why this shape does not have it
 *
 * The log is written by concurrent processes with no lock — deliberately; the
 * thing it observes is concurrent writers. A read-modify-rename loses any
 * append that lands between the read and the rename, and that loss is NOT
 * benign in both directions: a lost close leaks a window open (over-isolation,
 * which is always safe and is now reported), but a lost OPEN orphans its later
 * close and degrades the log permanently — precisely the state this function
 * exists to repair.
 *
 * So the rewrite does not race. `link()` gives the current inode a second name
 * before `rename()` gives the path a new one:
 *
 * 1. read the log, note its size, compute the survivors;
 * 2. stage the survivors in a temp file;
 * 3. `link(log → sidecar)` — the old inode now has two names;
 * 4. `rename(temp → log)` — appenders that open the path from here on write to
 *    the NEW inode; appenders that already opened it write to the old one,
 *    which is still reachable as `sidecar`;
 * 5. read `sidecar` past the noted size and append those rows back.
 *
 * No append is discarded: every one of them is either in the new file already
 * or in the drained tail. `appendFileSync` opens, writes and closes in one
 * synchronous call, so the set of appenders holding the old inode at step 4 is
 * whatever was mid-call, and step 5 is what collects them.
 *
 * The one thing that changes is ORDER — a drained row lands after rows already
 * written to the new file — which is why `readDispatchWindows` folds without
 * regard to line order. Two things stay unsafe and are stated rather than
 * papered over: a line that is genuinely half-written at step 1 is dropped
 * (that is what "torn" means and repairing it is the point), and a filesystem
 * with no hard links makes the whole thing a no-op rather than a gamble.
 *
 * Never a lock, a lease, or a deadline: the file exists because those were
 * removed, and needing one back to maintain it would be an argument against
 * the file, not for the lock.
 */
export function compactDispatchWindows(
  repoRoot: string,
  opts: { now?: Date; minBytes?: number; dryRun?: boolean; retentionMs?: number } = {},
): WindowLogCompaction {
  const abs = windowsAbs(repoRoot);
  const dryRun = opts.dryRun === true;
  let bytesBefore: number;
  try {
    if (!existsSync(abs)) return noCompaction('there is no window log to compact', { dryRun });
    bytesBefore = statSync(abs).size;
  } catch {
    return noCompaction('the window log could not be inspected', { dryRun });
  }
  // The cheap gate, so the opportunistic caller pays one `statSync` and no
  // read at all on the overwhelmingly common pass.
  const minBytes = opts.minBytes ?? 0;
  if (bytesBefore < minBytes) {
    return noCompaction('the window log is below the compaction threshold', {
      dryRun,
      bytesBefore,
      bytesAfter: bytesBefore,
    });
  }
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return noCompaction('the window log could not be read', { dryRun, bytesBefore, bytesAfter: bytesBefore });
  }
  // The read's own size, not the stat above: the file may have grown between
  // them, and everything past this offset is the drain's business.
  const readBytes = buf.length;
  const { entries } = classifyWindowLog(buf.toString('utf8'));

  const firstOpenMs = new Map<string, number>();
  const lastCloseMs = new Map<string, number>();
  for (const entry of entries) {
    const row = entry.row;
    if (row == null) continue;
    if (row.kind === 'open') {
      if (!firstOpenMs.has(row.id)) firstOpenMs.set(row.id, Date.parse(row.startedAt));
    } else {
      const ended = Date.parse(row.endedAt);
      const previous = lastCloseMs.get(row.id);
      if (previous == null || ended > previous) lastCloseMs.set(row.id, ended);
    }
  }
  const nowMs = (opts.now ?? new Date()).getTime();
  let earliestOpenStart = Number.POSITIVE_INFINITY;
  let openWindowsKept = 0;
  for (const [id, started] of firstOpenMs) {
    if (lastCloseMs.has(id)) continue;
    openWindowsKept += 1;
    if (started < earliestOpenStart) earliestOpenStart = started;
  }
  const horizon = Math.min(earliestOpenStart, nowMs - (opts.retentionMs ?? WINDOW_LOG_RETENTION_MS));
  const droppableIds = new Set<string>();
  for (const [id, closed] of lastCloseMs) {
    if (!firstOpenMs.has(id)) continue; // an orphan close is dropped as unusable, below
    if (closed < horizon) droppableIds.add(id);
  }

  const kept: string[] = [];
  const keptOpenIds = new Set<string>();
  let unreadableRowsDropped = 0;
  for (const entry of entries) {
    const row = entry.row;
    if (row == null) { unreadableRowsDropped += 1; continue; }
    // A close whose open is nowhere in this file names a window with an
    // unknown interval. `readDispatchWindows` already discards it and reports
    // the log degraded for it; dropping it is what clears that.
    if (row.kind === 'close' && !firstOpenMs.has(row.id)) { unreadableRowsDropped += 1; continue; }
    if (droppableIds.has(row.id)) continue;
    if (row.kind === 'open') keptOpenIds.add(row.id);
    kept.push(entry.raw);
  }
  const rowsBefore = entries.length;
  const rowsDropped = rowsBefore - kept.length;
  const plan: WindowLogCompaction = {
    path: DISPATCH_WINDOWS_FILE,
    compacted: false,
    dryRun,
    skipped: null,
    bytesBefore,
    bytesAfter: bytesBefore,
    rowsBefore,
    rowsDropped,
    unreadableRowsDropped,
    windowsDropped: droppableIds.size,
    openWindowsKept,
    rowsDrained: 0,
  };
  // A no-op when there is nothing to gain: the file is not touched at all, so
  // compaction cannot be the thing that introduces a torn line into a log that
  // did not have one.
  if (rowsDropped === 0) {
    return { ...plan, skipped: 'the window log holds no row that can be dropped' };
  }
  if (dryRun) return plan;

  const suffix = `${process.pid}-${randomUUID()}`;
  const temporary = `${abs}.compact-${suffix}`;
  const sidecar = `${abs}.draining-${suffix}`;
  try {
    writeFileSync(temporary, kept.length === 0 ? '' : `${kept.join('\n')}\n`, { flag: 'wx' });
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return { ...plan, skipped: 'the compacted window log could not be staged' };
  }
  try {
    // Before the path is repointed, give the current inode a second name.
    // Without this step every append that lands between the read above and the
    // rename below is lost, and a lost `window_opened` degrades the log
    // permanently — the exact failure being repaired.
    linkSync(abs, sidecar);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return {
      ...plan,
      skipped: 'the window log could not be hard-linked, so a concurrent append could be lost; nothing was rewritten',
    };
  }
  try {
    renameSync(temporary, abs);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    try { rmSync(sidecar, { force: true }); } catch { /* best effort */ }
    return { ...plan, skipped: 'the compacted window log could not be moved into place' };
  }

  let rowsDrained = 0;
  try {
    const raced = readFileSync(sidecar);
    if (raced.length > readBytes) {
      const { entries: tail } = classifyWindowLog(raced.subarray(readBytes).toString('utf8'));
      for (const entry of tail) {
        if (entry.row?.kind === 'open') keptOpenIds.add(entry.row.id);
      }
      for (const entry of tail) {
        const row = entry.row;
        if (row == null) continue;
        // Re-appending a close whose open this rewrite dropped would put an
        // orphan into a log that was just repaired.
        if (row.kind === 'close' && !keptOpenIds.has(row.id)) continue;
        // One `appendFileSync` per row, exactly as `appendRow` does: the file
        // is live again and another writer may be appending to it.
        appendFileSync(abs, `${entry.raw}\n`, 'utf8');
        rowsDrained += 1;
      }
    }
  } catch {
    // The rewrite already landed. A drain that fails loses only the rows that
    // raced it, which is the pre-`link` behaviour and no worse.
  }
  try { rmSync(sidecar, { force: true }); } catch { /* best effort */ }

  let bytesAfter = bytesBefore;
  try {
    bytesAfter = statSync(abs).size;
  } catch { /* reporting only */ }
  return { ...plan, compacted: true, bytesAfter, rowsDrained };
}

// ---------------------------------------------------------------------------
// What `doctor` says about the log
// ---------------------------------------------------------------------------

/**
 * How long a window may stay open before it is more likely a crashed writer
 * than a slow one.
 *
 * This is a REPORTING threshold and nothing acts on it — no window is closed,
 * reclaimed, or dropped because of it. That distinction is the whole reason it
 * is allowed to exist: the writer lease died because a threshold was used to
 * decide whether a holder was alive, and every deadline in this kernel was
 * removed for the same reason. Saying "this has been open for three days, here
 * is its id" asks a human to look; it refuses no one and reclaims nothing.
 */
export const OPEN_WINDOW_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Structurally identical to `DoctorFinding` in `src/commands/doctor.ts`, and
 * declared here rather than imported: `src/lib/` must not depend on
 * `src/commands/`. Same trade `catalog-rot.ts` makes for `RotFinding`.
 */
export interface WindowLogFinding {
  check: string;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
  remediation?: string;
}

const WINDOW_LOG_CHECK = 'dispatch-window-log';

/** `fadeno clean --windows`, spelled once. Three findings point at it. */
const COMPACT_COMMAND = '`fadeno clean --windows`';

function describeBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KiB`;
}

/**
 * What `doctor` has to say about `.fadeno/local/dispatch-windows.jsonl`.
 *
 * Nothing said anything about this file before, which is what made a torn line
 * permanent: `readDispatchWindows` reported `degraded`, `detectConcurrentWrites`
 * put `UNREADABLE_WINDOW_LOG_ID` on every receipt written afterwards, and the
 * only way out was for a human to notice a machine-local file they had never
 * been told about and delete it.
 *
 * Severities. Everything here is `warning` or `ok`, never `error`: this log is
 * machine-local, never ledger evidence, and never gating (the module header
 * says so and every reader honours it), while `doctor`'s `error` tier sets a
 * non-zero exit and is spent on state that stops Fadeno working — an
 * unwritable `.fadeno`, a catalog that will not load. A degraded log does not
 * stop anything; it makes every receipt say less than it could, silently. That
 * is exactly what `warning` is for, and it is emphatically not `ok`.
 *
 * One `ok` row when there is nothing wrong, rather than silence: a check that
 * says nothing is indistinguishable from a check that did not run, and the
 * adjacent `workspace-lease` finding sets that precedent.
 */
export function dispatchWindowLogFindings(
  repoRoot: string,
  opts: { now?: Date } = {},
): WindowLogFinding[] {
  const abs = windowsAbs(repoRoot);
  let bytes: number;
  try {
    if (!existsSync(abs)) {
      return [{
        check: WINDOW_LOG_CHECK,
        severity: 'ok',
        detail: `no write-window log yet (${DISPATCH_WINDOWS_FILE}) — nothing has opened a dispatch window in this repository`,
      }];
    }
    bytes = statSync(abs).size;
  } catch {
    return [{
      check: WINDOW_LOG_CHECK,
      severity: 'warning',
      detail: `${DISPATCH_WINDOWS_FILE} exists but could not be inspected, so overlap detection is reading a file this check cannot see`,
      remediation: `Check the permissions on ${dirname(DISPATCH_WINDOWS_FILE)}. Nothing is gated by this log — a delivery that cannot read it still runs, its receipt just says less.`,
    }];
  }
  const now = opts.now ?? new Date();
  const { windows, degraded } = readDispatchWindows(repoRoot);
  const plan = compactDispatchWindows(repoRoot, { now, dryRun: true });
  const findings: WindowLogFinding[] = [];

  if (degraded) {
    findings.push({
      check: WINDOW_LOG_CHECK,
      severity: 'warning',
      detail:
        `${DISPATCH_WINDOWS_FILE} carries ${plan.unreadableRowsDropped > 0 ? `${plan.unreadableRowsDropped} ` : ''}` +
        'row(s) no reader can use — a torn append, a blank line, or a close whose open the log never saw. ' +
        'The log is append-only, so this does not heal: every receipt written from now on carries a ' +
        '`concurrent_write` stamp naming `<window log unreadable>`, which says the list of deliveries that ' +
        'overlapped it is a floor rather than the set',
      remediation:
        `${COMPACT_COMMAND} rewrites the log without the unusable rows and keeps every open window. ` +
        'Nothing else clears it — no dispatch rewrites this file, so the torn row and the stamp it causes ' +
        'stay until something does.',
    });
  }

  const stale = windows
    .filter((w) => w.endedAt == null && now.getTime() - Date.parse(w.startedAt) > OPEN_WINDOW_STALE_MS)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  if (stale.length > 0) {
    const shown = stale.slice(0, 5).map((w) => `"${w.dispatchId}" (${w.kind}, ${w.workspaceMode}, open since ${w.startedAt})`);
    const rest = stale.length > shown.length ? `, +${stale.length - shown.length} more` : '';
    findings.push({
      check: WINDOW_LOG_CHECK,
      severity: 'warning',
      detail:
        `${stale.length} write window(s) have been open for more than ${OPEN_WINDOW_STALE_MS / 3_600_000} hours: ` +
        `${shown.join('; ')}${rest}. A delivery that was killed never closed its window, and every later ` +
        'dispatch reads it as a live writer — so they auto-isolate into their own worktrees when they did not ' +
        'need to',
      remediation:
        'Nothing closes these automatically, and nothing here decides whether the delivery is alive — that ' +
        'question is what the writer lease died of. The cost of leaving them is a worktree per dispatch, ' +
        'never a refusal. To close one, give it a terminal receipt: `fadeno dispatch-close <id>` for a ' +
        `runless host dispatch, \`fadeno dispatch-fail <run> <dispatch-id> --reason <text>\` inside a run. ` +
        `${COMPACT_COMMAND} will NOT drop them: an open window is the auto-isolate signal.`,
    });
  }

  if (bytes >= WINDOW_LOG_COMPACT_BYTES && plan.rowsDropped > 0) {
    findings.push({
      check: WINDOW_LOG_CHECK,
      severity: 'warning',
      detail:
        `${DISPATCH_WINDOWS_FILE} is ${describeBytes(bytes)} across ${plan.rowsBefore} rows, of which ` +
        `${plan.rowsDropped} can be dropped (${plan.windowsDropped} closed window(s) whose interval can no ` +
        'longer meet anything). The whole file is re-read on every dispatch terminal and every auto-isolate ' +
        'decision',
      remediation:
        `${COMPACT_COMMAND}. A dispatch terminal also compacts on its own past ` +
        `${describeBytes(WINDOW_LOG_COMPACT_BYTES)}, so a log this size means nothing has closed a window ` +
        'since it grew.',
    });
  }

  if (findings.length === 0) {
    const open = windows.filter((w) => w.endedAt == null).length;
    findings.push({
      check: WINDOW_LOG_CHECK,
      severity: 'ok',
      detail:
        `${DISPATCH_WINDOWS_FILE} reads clean: ${windows.length} window(s), ${open} still open, ` +
        `${describeBytes(bytes)}`,
    });
  }
  return findings;
}

/**
 * Windows that are still open — every delivery that may be writing right now.
 *
 * This is the auto-isolate signal, and being wrong about it is CHEAP in both
 * directions, which is the whole reason it is allowed to be a guess where the
 * lease was not. A false positive gives a delivery its own worktree, which is
 * always safe. A false negative puts it in the shared tree, where the overlap
 * is detected and recorded rather than lost. Neither answer can refuse anyone
 * or wedge a repo, so the honest thing is to act on it and move on.
 */
export function openWindowsOtherThan(repoRoot: string, dispatchId: string): DispatchWindow[] {
  return readDispatchWindows(repoRoot).windows
    .filter((w) => w.endedAt == null && w.dispatchId !== dispatchId)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

/**
 * Whether a delivery about to write the SHARED tree would be the only one in
 * it, and who else is there when it would not.
 *
 * The old answer to "someone else is here" was a refusal: `holder "X" must
 * wait or retry`. The new answer is a worktree. That inversion is the point —
 * "you must wait" becomes "you get your own tree", which is what turns
 * contention into two diffs against a common base instead of a queue.
 */
export function shouldAutoIsolate(
  repoRoot: string,
  dispatchId: string,
): { isolate: boolean; others: DispatchWindow[] } {
  const others = openWindowsOtherThan(repoRoot, dispatchId).filter((w) => w.workspaceMode === 'shared');
  return { isolate: others.length > 0, others };
}

function intervalsOverlap(a: DispatchWindow, b: DispatchWindow): boolean {
  const aStart = Date.parse(a.startedAt);
  const bStart = Date.parse(b.startedAt);
  if (Number.isNaN(aStart) || Number.isNaN(bStart)) return false;
  // An open window extends to now: it is still writing, so it overlaps
  // anything that has not already finished before it began.
  const aEnd = a.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(a.endedAt);
  const bEnd = b.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(b.endedAt);
  if (Number.isNaN(aEnd) || Number.isNaN(bEnd)) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Every other window that overlapped this one in time AND in paths.
 *
 * Called at the terminal receipt, with the closing delivery's own path set,
 * so it sees the log as it stands at the last possible moment.
 *
 * An overlapping window that has not closed yet produces a `pending` stamp:
 * the overlap in time is a fact and is recorded, but no path set exists on
 * the other side to intersect. That is not a gap — the other window closes
 * LATER, and therefore sees this one's completed set and carries the concrete
 * intersection. Between the two receipts the pair is fully described, and
 * each names the other.
 */
export function detectConcurrentWrites(
  self: {
    dispatchId: string;
    startedAt: string;
    endedAt: string;
    workspaceMode: WorkspaceMode;
    changedPaths: readonly string[];
    truncated?: boolean;
  },
  windows: readonly DispatchWindow[],
  opts: { logDegraded?: boolean } = {},
): ConcurrentWriteStamp[] | null {
  const selfWindow: DispatchWindow = {
    dispatchId: self.dispatchId,
    runId: null,
    kind: 'ad-hoc',
    workspaceMode: self.workspaceMode,
    startedAt: self.startedAt,
    endedAt: self.endedAt,
    changedPaths: [...self.changedPaths],
    truncated: Boolean(self.truncated),
  };
  const mine = new Set(self.changedPaths);
  // A real caller derives BOTH of these from one value: `truncated = changed
  // == null; paths = changed ?? []`. So a self-truncated delivery always
  // arrives here with an EMPTY set, `mine` is empty, every intersection is
  // empty, and the old `continue` below reported that as "nothing happened".
  // The one case the kernel most needs to hear about — a delivery that could
  // not enumerate its own work — was the one case it said nothing about.
  const selfIncomplete = Boolean(self.truncated);
  const stamps: ConcurrentWriteStamp[] = [];
  for (const other of windows) {
    if (other.dispatchId === self.dispatchId) continue;
    if (!intervalsOverlap(selfWindow, other)) continue;
    const attribution: OverlapAttribution = other.workspaceMode === 'isolated' ? 'delivery' : 'workspace';
    if (other.changedPaths == null) {
      stamps.push({
        dispatch_id: other.dispatchId,
        ...(other.runId != null ? { run_id: other.runId } : {}),
        kind: other.kind,
        workspace_mode: other.workspaceMode,
        attribution,
        paths_intersecting: 0,
        paths: [],
        pending: true,
        // The wording used to promise that the other side's receipt "carries
        // the intersection". It cannot promise that: the other side may close
        // unable to enumerate its own changes, in which case its receipt
        // carries a degraded admission instead. A pointer to a receipt that
        // turns out to be empty sends a reader somewhere for nothing, which is
        // worse than saying plainly what will be there.
        note:
          `windows overlapped in time; "${other.dispatchId}" had not finished, so no path set existed to ` +
          "intersect. It closes later, and its own receipt is where this pair's intersection is recorded — " +
          'as a concrete set when it can enumerate what it changed, and as a degraded stamp when it cannot.',
      });
      continue;
    }
    const hits = other.changedPaths.filter((p) => mine.has(p)).sort();
    const bothWhole = !selfIncomplete && !other.truncated;
    // An empty intersection means "these two never met" ONLY when both
    // listings were whole. When either side could not enumerate what it
    // changed, zero hits means "could not tell" — and `continue` spells that
    // identically to "nothing happened".
    if (hits.length === 0 && bothWhole) continue;
    const degraded = !bothWhole || Boolean(opts.logDegraded);
    const whose = attribution === 'delivery'
      ? `Those paths are "${other.dispatchId}"'s own work.`
      : `"${other.dispatchId}" ran in the shared tree, so its set is the tree's delta over its window — ` +
        'this is an attestation that both windows touched these paths, not proof of who wrote them.';
    stamps.push({
      dispatch_id: other.dispatchId,
      ...(other.runId != null ? { run_id: other.runId } : {}),
      kind: other.kind,
      workspace_mode: other.workspaceMode,
      attribution,
      paths_intersecting: hits.length,
      paths: hits.slice(0, OVERLAP_MAX_EXAMPLES),
      ...(degraded ? { degraded: true as const } : {}),
      note: hits.length === 0
        ? `windows overlapped in time and ${selfIncomplete && other.truncated
            ? 'neither side could enumerate'
            : selfIncomplete
              ? 'this delivery could not enumerate'
              : `"${other.dispatchId}" could not enumerate`} what it changed, so whether their edits met is ` +
          'UNKNOWN. This is not a report that they did not meet.'
        : `${hits.length} ${hits.length === 1 ? 'path' : 'paths'} changed in both windows, which overlapped in ` +
          `time. ${whose}` +
          (degraded ? ' At least one listing was incomplete, so this is a floor, not the set.' : ''),
    });
  }
  // The log itself could not be read whole, so the set of NEIGHBOURS is
  // unknown — not empty. Decorating the stamps above with `degraded` cannot
  // say this: it qualifies overlaps that were found, and the thing at stake is
  // the ones that could not be. With an unreadable log there are no windows at
  // all, so without this row the strongest evidence of a blind spot produced
  // the emptiest possible receipt.
  if (opts.logDegraded === true) {
    stamps.push({
      dispatch_id: UNREADABLE_WINDOW_LOG_ID,
      paths_intersecting: 0,
      paths: [],
      degraded: true,
      note:
        'the window log could not be read whole, so the list of deliveries that overlapped this one is a ' +
        'floor. Any overlap named on this receipt still happened; there may be others this detector never ' +
        'saw. Nothing here says the tree was clean.',
    });
  }
  return stamps.length > 0 ? stamps : null;
}

// ---------------------------------------------------------------------------
// Path sets
// ---------------------------------------------------------------------------

/**
 * The caller's working tree as a `path -> status` map.
 *
 * `git status --porcelain -z` is the listing that sees exactly what a later
 * `git add -A` would: tracked modifications, deletions, and untracked-but-
 * unignored files, with no shell quoting to unpick (`-z` emits raw NUL-
 * separated paths). Rename entries carry a second path; both are recorded,
 * because a rename changes both.
 *
 * Returns null when git could not answer — never an empty map, which would
 * be a positive claim that the tree is clean.
 */
export function workspaceStatusMap(repoRoot: string): Map<string, string> | null {
  const res = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', '-z'], {
    encoding: 'utf8',
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (res.error != null || res.status !== 0) return null;
  const map = new Map<string, string>();
  const fields = String(res.stdout ?? '').split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (path.length === 0) continue;
    map.set(path, code);
    // `R`/`C` entries are `XY<sp>dest\0orig\0`: the origin is the NEXT field,
    // not part of this one. Consume it so it is not mistaken for a new entry
    // with a two-character status prefix chopped off its front.
    if (code.startsWith('R') || code.startsWith('C')) {
      const origin = fields[index + 1];
      if (origin != null && origin.length > 0) {
        map.set(origin, code);
        index += 1;
      }
    }
  }
  return map;
}

/**
 * Paths whose working-tree state differs between two `workspaceStatusMap`
 * snapshots — the tree's delta over a shared window.
 *
 * An attestation, not attribution: everything that changed in the caller's
 * tree during the interval is here, whoever changed it. That is exactly what
 * makes it the right input for overlap detection and the wrong input for
 * blame, and it is why the stamp records `attribution: 'workspace'`.
 *
 * A null on either side means the tree could not be read at that moment; the
 * caller gets `null` and must record `degraded` rather than "nothing changed".
 */
export function changedBetween(
  before: Map<string, string> | null,
  after: Map<string, string> | null,
): string[] | null {
  if (before == null || after == null) return null;
  const changed = new Set<string>();
  for (const [path, code] of after) {
    if (before.get(path) !== code) changed.add(path);
  }
  for (const path of before.keys()) {
    // Present before and absent now: committed, reverted, or cleaned.
    if (!after.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

/**
 * The repo-relative paths a collected isolated diff touches.
 *
 * `git apply --numstat` parses the patch WITHOUT applying it, so this works
 * after the worktree is gone and cannot fail because the tree has moved. Its
 * output is `<added>\t<deleted>\t<path>` per file, already unquoted — which is
 * why it is used instead of scraping `diff --git` headers, where a path with a
 * space or a non-ASCII byte arrives quoted and a naive parse silently drops it.
 *
 * Returns null when the patch could not be read, so a caller records a
 * degraded window rather than claiming the delivery changed nothing.
 */
export function diffChangedPaths(repoRoot: string, diffAbs: string): string[] | null {
  if (!existsSync(diffAbs)) return null;
  const res = spawnSync('git', ['-C', repoRoot, 'apply', '--numstat', '-z', diffAbs], {
    encoding: 'utf8',
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (res.error != null || res.status !== 0) return null;
  const paths = new Set<string>();
  // With `-z`, numstat records are `added\tdeleted\t\0path\0` for renames and
  // `added\tdeleted\tpath\0` otherwise. Splitting on NUL and then on tab
  // covers both without needing to know which shape a record took.
  for (const record of String(res.stdout ?? '').split('\0')) {
    if (record.length === 0) continue;
    const parts = record.split('\t');
    const candidate = parts.length >= 3 ? parts.slice(2).join('\t') : parts[parts.length - 1]!;
    const path = candidate.trim();
    if (path.length > 0) paths.add(path);
  }
  return [...paths].sort();
}

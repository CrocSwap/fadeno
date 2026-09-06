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
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { WorkspaceMode } from './workspace-isolation.ts';

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
  /** The other window's dispatch id. */
  dispatch_id: string;
  run_id?: string;
  kind: WindowKind;
  workspace_mode: WorkspaceMode;
  /** How the OTHER window's path set was derived. */
  attribution: OverlapAttribution;
  /** Exact count of intersecting paths; `paths` is a sample of it. */
  paths_intersecting: number;
  paths: string[];
  /**
   * Absent when the other window had not closed yet, so no set existed to
   * intersect. The overlap in TIME is still recorded, and the other side —
   * which closes later and therefore sees this one's completed set — is what
   * carries the concrete intersection.
   */
  pending?: true;
  /** Present when either side's listing was incomplete. */
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
}

/**
 * Fold the append-only log into one record per dispatch.
 *
 * A close with no matching open is dropped: it names a window this log never
 * saw begin, so its interval is unknown and an unknown interval cannot be
 * intersected with anything. A duplicate open keeps the FIRST (the earliest
 * moment the delivery could have been writing); a duplicate close keeps the
 * LAST (the latest moment it could still have been).
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
  const byId = new Map<string, DispatchWindow>();
  let degraded = false;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      // A trailing newline is normal; a blank line in the middle is not.
      if (index !== lines.length - 1) degraded = true;
      continue;
    }
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) { degraded = true; continue; }
      row = parsed as Record<string, unknown>;
    } catch {
      // A torn last line is what an interrupted append looks like.
      degraded = true;
      continue;
    }
    const id = typeof row.dispatch_id === 'string' && row.dispatch_id.length > 0 ? row.dispatch_id : null;
    if (id == null) { degraded = true; continue; }
    if (row.event === 'window_opened') {
      if (byId.has(id)) continue; // keep the first open
      const mode = row.workspace_mode === 'isolated' ? 'isolated' : 'shared';
      const kind = row.kind === 'engine' || row.kind === 'host-dispatch' ? row.kind : 'ad-hoc';
      const startedAt = typeof row.started_at === 'string' ? row.started_at : null;
      if (startedAt == null || Number.isNaN(Date.parse(startedAt))) { degraded = true; continue; }
      byId.set(id, {
        dispatchId: id,
        runId: typeof row.run_id === 'string' ? row.run_id : null,
        kind,
        workspaceMode: mode,
        startedAt,
        endedAt: null,
        changedPaths: null,
        truncated: false,
      });
    } else if (row.event === 'window_closed') {
      const open = byId.get(id);
      if (open == null) { degraded = true; continue; }
      const endedAt = typeof row.ended_at === 'string' ? row.ended_at : null;
      if (endedAt == null || Number.isNaN(Date.parse(endedAt))) { degraded = true; continue; }
      const raw = Array.isArray(row.changed_paths) ? row.changed_paths : null;
      if (raw == null) { degraded = true; continue; }
      open.endedAt = endedAt;
      open.changedPaths = raw.filter((p): p is string => typeof p === 'string');
      open.truncated = row.truncated === true || open.changedPaths.length !== raw.length;
    } else {
      degraded = true;
    }
  }
  return { windows: [...byId.values()], degraded };
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
        note:
          `windows overlapped in time; "${other.dispatchId}" had not finished, so no path set existed to ` +
          'intersect. It closes later and its own receipt carries the intersection.',
      });
      continue;
    }
    const hits = other.changedPaths.filter((p) => mine.has(p)).sort();
    if (hits.length === 0) continue;
    const degraded = other.truncated || Boolean(self.truncated) || Boolean(opts.logDegraded);
    stamps.push({
      dispatch_id: other.dispatchId,
      ...(other.runId != null ? { run_id: other.runId } : {}),
      kind: other.kind,
      workspace_mode: other.workspaceMode,
      attribution,
      paths_intersecting: hits.length,
      paths: hits.slice(0, OVERLAP_MAX_EXAMPLES),
      ...(degraded ? { degraded: true as const } : {}),
      note:
        `${hits.length} ${hits.length === 1 ? 'path' : 'paths'} changed in both windows, which overlapped in ` +
        `time. ${attribution === 'delivery'
          ? `Those paths are "${other.dispatchId}"'s own work.`
          : `"${other.dispatchId}" ran in the shared tree, so its set is the tree's delta over its window — ` +
            'this is an attestation that both windows touched these paths, not proof of who wrote them.'}` +
        (degraded ? ' At least one listing was incomplete, so this is a floor, not the set.' : ''),
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

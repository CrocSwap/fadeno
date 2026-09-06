/**
 * Receipt attestations, and the ONE place that decides what they say.
 *
 * ## Why this module exists
 *
 * Two fields on a terminal receipt describe damage the kernel could detect
 * but not prevent:
 *
 * - `concurrent_write` (see `workspace-overlap.ts`) — another delivery wrote
 *   the same paths in an overlapping window. What replaced the writer lease.
 * - `ignored_output_discarded` (see `workspace-isolation.ts`) — gitignored
 *   content sat in a worktree that was merged back through `git add -A`,
 *   which respects `.gitignore`, and was then torn down. The output is gone.
 *
 * Both were written by the kernel and read by nobody. `concurrent_write` was
 * echoed once on stdout by `fadeno dispatch` — the channel the recover-by-tag
 * path discards — and `ignored_output_discarded` reached only the `fadeno
 * dispatches` LISTING, which is not where anyone noticed a research
 * deliverable disappearing twice. A finding has to travel on a channel its
 * consumer actually reads (`7c7a0f6`); this module is what lets `verify`,
 * `show`, `dispatches` and `dispatches --output` read them the same way.
 *
 * ## Why the PARSER is shared and the renderers are not
 *
 * The drift that costs work is not two surfaces wording a finding
 * differently — it is two surfaces disagreeing about whether there IS one.
 * That decision lives here, once. Rendering stays with each surface because
 * an inline `[bracketed]` fragment on a one-line listing and a section
 * heading in a run projection are genuinely different jobs.
 *
 * ## The rule both parsers obey
 *
 * "I could not tell" is never spelled the same as "there was nothing". A
 * truncated listing, an incomplete intersection, and a row that predates the
 * flag saying which all come back with the uncertainty ON the record, and
 * absence — the field not written at all — is the only spelling of "nothing
 * to report".
 */

/** How much a window's path set can be said about its own delivery. */
export type OverlapAttribution = 'delivery' | 'workspace';

/**
 * One `concurrent_write` stamp as a reader sees it.
 *
 * Deliberately looser than the writer's `ConcurrentWriteStamp`: every
 * enumerated field is widened to `string | null` and every count to `number |
 * null`, because a projection must render a row written by a newer kernel —
 * or a hand-edited one — rather than throw or, worse, drop it. A dropped row
 * reads as clean.
 */
export interface ConcurrentWriteRecord {
  /** The OTHER window's dispatch id. */
  dispatchId: string;
  runId: string | null;
  kind: string | null;
  workspaceMode: string | null;
  /**
   * `delivery` is the other side's own worktree diff — attributable to it.
   * `workspace` is a shared tree's delta over the window, which includes
   * whatever the human did in the same minutes: an attestation, never blame.
   * Null when the row did not say, which is itself weaker than either.
   */
  attribution: OverlapAttribution | null;
  /** Exact count the writer stated; null when it stated none. */
  pathsIntersecting: number | null;
  /** A sample of the intersection, in the writer's spelling. */
  paths: string[];
  /** The other window had not closed: overlap in TIME only, no set to intersect. */
  pending: boolean;
  /** Either side's listing was incomplete, so the intersection is a floor. */
  degraded: boolean;
  note: string | null;
}

/**
 * One `ignored_output_discarded` stamp as a reader sees it.
 *
 * `truncated` carries more weight here than anywhere else in this file: the
 * scan is capped (`IGNORED_OUTPUT_MAX_ENTRIES`) and a git failure returns a
 * partial listing, so a truncated record is a FLOOR on what was destroyed.
 * Rendering it as though the named paths were all of it is the same defect
 * as not rendering it at all.
 */
export interface IgnoredOutputRecord {
  /** Repo-relative, git-collapsed to directories, in the writer's spelling. */
  paths: string[];
  /** The listing is a floor, not the set. */
  truncated: boolean;
  /** The writer's own prose for why it is a floor. */
  note?: string;
  /**
   * A worktree still holding this output, when it survives on disk. Stated by
   * the writer, never inferred — a "still on disk" hint that turns out to be
   * wrong is worse than silence.
   */
  retainedAt: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pathList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && p !== '') : [];
}

/**
 * Parse a receipt's `ignored_output_discarded` value.
 *
 * Two shapes are no claim at all and read as null: a value that is neither an
 * object nor an array, and an object carrying no `paths`, no truncation flag
 * and no note. Everything else survives — including `truncated` with an empty
 * or missing `paths`, which is exactly the case where the writer is admitting
 * it could not enumerate what died.
 *
 * ### The legacy ARRAY shape
 *
 * The engine wrote a bare `string[]` here before it wrote an object, which
 * dropped both the truncation flag and the note on the floor: an
 * unenumerable loss was recorded as `[]`, identical on the wire to a listing
 * that found nothing, and a capped listing was indistinguishable from a
 * complete one. Those rows still exist, so they are read — as `truncated`,
 * with a note saying why. A row that cannot state its own completeness does
 * not get to be assumed complete.
 */
export function parseIgnoredOutputDiscarded(value: unknown): IgnoredOutputRecord | null {
  if (Array.isArray(value)) {
    return {
      paths: pathList(value),
      truncated: true,
      note:
        'this row recorded a bare path list with no completeness flag (an engine writer that predates the ' +
        'object shape), so it cannot say whether these were all of it.',
      retainedAt: null,
    };
  }
  if (value == null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const rawPaths = Array.isArray(row.paths) ? row.paths : null;
  // Anything present that is not an explicit `false` counts as truncated: a
  // newer writer that spells a REASON where this expects a flag must still
  // err toward "I could not tell" rather than toward "that was everything".
  const truncated = row.truncated != null && row.truncated !== false;
  const note = text(row.note);
  if (rawPaths == null && !truncated && note == null) return null;
  const out: IgnoredOutputRecord = { paths: pathList(rawPaths), truncated, retainedAt: text(row.retained_at) };
  if (note != null) out.note = note;
  return out;
}

/**
 * Parse a receipt's `concurrent_write` value into the stamps a reader can
 * render. Null when the field is absent or carries nothing usable — absence
 * is the writer's only spelling of "nothing overlapped".
 *
 * A stamp with no `dispatch_id` names no other window and cannot be
 * intersected with anything, so it is dropped; every other malformation is
 * carried through as a null field rather than discarded, because a stamp
 * that renders partially still tells a reader an overlap happened.
 */
export function parseConcurrentWriteStamps(value: unknown): ConcurrentWriteRecord[] | null {
  if (!Array.isArray(value)) return null;
  const out: ConcurrentWriteRecord[] = [];
  for (const item of value) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const dispatchId = text(row.dispatch_id);
    if (dispatchId == null) continue;
    const attribution = row.attribution === 'delivery' || row.attribution === 'workspace' ? row.attribution : null;
    out.push({
      dispatchId,
      runId: text(row.run_id),
      kind: text(row.kind),
      workspaceMode: text(row.workspace_mode),
      attribution,
      pathsIntersecting: typeof row.paths_intersecting === 'number' ? row.paths_intersecting : null,
      paths: pathList(row.paths),
      pending: row.pending === true,
      // Same asymmetry as `truncated` above, for the same reason.
      degraded: row.degraded != null && row.degraded !== false,
      note: text(row.note),
    });
  }
  return out.length > 0 ? out : null;
}

/** How many paths one rendered line names before it starts counting. */
export const ATTESTATION_PATHS_SHOWN = 8;

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function samplePaths(paths: readonly string[], stated: number | null): string {
  if (paths.length === 0) return stated != null && stated > 0 ? '(paths unrecorded)' : '(no paths named)';
  const shown = paths.slice(0, ATTESTATION_PATHS_SHOWN);
  // The stated count is exact and the list is a sample, so the remainder is
  // measured against the count when there is one — reporting `+0 more` for a
  // sample that was cut is the kind of quiet arithmetic this file exists to
  // stop.
  const total = stated != null && stated > paths.length ? stated : paths.length;
  const rest = total - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

/**
 * One line describing one overlap, in the register the finding deserves.
 *
 * An overlap is NOT proof of damage: two deliveries touching one file may
 * both be fine, and path granularity means two agents editing different
 * functions in one file land here. So the wording states what was observed
 * and how strong the evidence is, and stops. A reader who is told a fact and
 * left to judge it will keep reading these; a reader who is told an
 * accusation that turns out to be a shrug will learn to skip them, which is
 * the same outcome as never rendering them.
 */
export function describeConcurrentWrite(record: ConcurrentWriteRecord): string {
  const where = [record.kind, record.workspaceMode, record.runId != null ? `run ${record.runId}` : null]
    .filter((part): part is string => part != null)
    .join(' · ');
  const head = `${shortId(record.dispatchId)}${where.length > 0 ? ` [${where}]` : ''}`;
  if (record.pending) {
    return (
      `${head}  PENDING — the windows overlapped in time, but that delivery had not finished, so no path ` +
      'set existed to intersect. It closes later and its own receipt carries the intersection.'
    );
  }
  const count = record.pathsIntersecting ?? record.paths.length;
  const noun = count === 1 ? 'path' : 'paths';
  const floor = record.degraded ? 'at least ' : '';
  const strength = record.attribution === 'delivery'
    ? "attributable — those paths are that delivery's own work"
    : record.attribution === 'workspace'
      ? 'ATTESTATION ONLY — that delivery ran in the shared tree, so its path set is the tree\'s delta over ' +
        'its window; this says both windows touched these paths, not who wrote them'
      : 'the row did not say how that path set was derived, so it is not attributable';
  const incomplete = record.degraded ? ' At least one listing was incomplete, so this is a floor, not the set.' : '';
  return `${head}  ${floor}${count} ${noun} changed in both windows — ${strength}: ${samplePaths(record.paths, record.pathsIntersecting)}.${incomplete}`;
}

/**
 * One line describing destroyed output.
 *
 * Unlike an overlap, this is not an attestation about who touched what: it
 * is a positive statement that named content existed in a worktree and no
 * diff carried it out before that worktree was removed. The wording says so
 * plainly, and says `at least` whenever the listing is a floor — a truncated
 * discard rendered as though the named paths were all of it would understate
 * a loss, which is the failure mode with no recovery.
 */
export function describeIgnoredOutput(record: IgnoredOutputRecord): string {
  const listed = samplePaths(record.paths, null);
  const fate = record.retainedAt != null
    ? `still on disk at ${record.retainedAt} until \`fadeno clean\` removes it`
    : 'the worktree is gone, so this content is not recoverable from it';
  const head = record.paths.length === 0
    ? record.truncated
      ? 'gitignored output was DISCARDED and the listing could not be taken — what was destroyed is unknown, not nothing'
      : 'gitignored output was DISCARDED; the row names no paths'
    : `${record.truncated ? 'at least ' : ''}${listed} — gitignored, so \`git add -A\` staged none of it and no diff ` +
      'carried it out of the worktree';
  const floor = record.truncated && record.paths.length > 0 ? ' The listing is a floor, not the set.' : '';
  const why = record.note != null ? ` (${record.note})` : '';
  return `${head}. ${fate}.${floor}${why}`;
}

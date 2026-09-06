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
 * The `dispatch_id` of the one stamp that names no other window.
 *
 * Every other stamp is about a neighbour. This one is about the DETECTOR: the
 * window log could not be read whole, so the set of neighbours is itself
 * unknown. Without it, an unreadable log produced zero windows, therefore zero
 * stamps, therefore a receipt indistinguishable from one written in an empty
 * repo — "I could not tell" spelled exactly like "nothing happened".
 *
 * It lives HERE, with the renderers, rather than with the writer, because the
 * writer emits it once and four surfaces have to recognise it. Spaces and
 * parentheses keep it outside every id shape the kernel mints (uuids,
 * `run:dispatch`, `tool:run:step:gN:aN`), so it can never collide with a real
 * window.
 */
export const UNREADABLE_WINDOW_LOG_ID = '(window log unreadable)';

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

/**
 * The resolved `ignored_output` policy a dispatch ran under, as a reader sees
 * it. `null` is a row that did not say — never a defaulted `discardable`.
 *
 * The default is `discardable`, so synthesizing one for silence would be the
 * easiest possible mistake and the worst: a row written by a kernel that
 * predates this field would then RENDER a policy claim nobody made, on the
 * exact surface a director consults to check what they asked for.
 */
export type IgnoredOutputPolicyRecord = 'kept' | 'discardable';

/** Parse a receipt's `ignored_output_policy`. Anything else is "not stated". */
export function parseIgnoredOutputPolicy(value: unknown): IgnoredOutputPolicyRecord | null {
  return value === 'kept' || value === 'discardable' ? value : null;
}

/**
 * What actually became of the content the stamp names, in the ONE place that
 * decides.
 *
 * ## The defect this exists to close
 *
 * `ignored_output_discarded` is named for the only outcome that existed when
 * it was written. Since the teardown veto landed, the kernel KEEPS the
 * worktree whenever the scan is not a positive claim of nothing, so the same
 * field now records two opposite fates — and every surface spelled the
 * headline "DISCARDED" from the field's mere presence, adding "still on disk
 * at …" as a footnote several clauses later. A director launched a dispatch
 * with `--ignored-output kept`, read `DISCARDED` on `fadeno dispatches`, and
 * went and verified the artifacts by hand. The tool's report was not wrong
 * about the paths; it was wrong about the verb, which is the part a reader
 * acts on.
 *
 * `retainedAt` is the writer's own reading of the disk at teardown — it is
 * only ever set by a writer that just saw the directory — so it, and nothing
 * else, decides the word. Absence means the writer stated no surviving copy,
 * which for every writer that exists means the worktree went away.
 */
export function ignoredOutputVerdict(record: IgnoredOutputRecord): 'KEPT' | 'DISCARDED' {
  return record.retainedAt != null ? 'KEPT' : 'DISCARDED';
}

/**
 * Path names that identify REBUILDABLE output: a compiler's, a bundler's, a
 * package manager's, or a test runner's, reproduced by re-running the tool
 * that made it.
 *
 * ## Why this list is short, and why it is names rather than content
 *
 * Retention found the gitignored work the diff could not carry, and then
 * reported a `dist/` in exactly the register it reports a `data/research/`
 * tree: "that directory is the only copy. Copy what you need out of it." In
 * this repo, three of four agent dispatches retained a worktree solely
 * because they ran `npm run build`. A warning that fires on every build is a
 * warning people stop reading, and not reading that warning is precisely how
 * a research deliverable went missing for two dispatches without anyone
 * noticing.
 *
 * So the split is about SIGNAL, not about deletion. Nothing here lowers a
 * retention decision (see `dispatch.ts`'s `retainIf`): a name is not a
 * reading of what is inside a directory, and destroying bytes on the strength
 * of a filename is the class of silent wrong answer this codebase keeps
 * paying for. `dist/` is `tsc` output in one repo and a committed-then-ignored
 * vendor bundle in the next, and git collapses a whole directory to one entry
 * so even a correctly-named `dist/` may hold something else beside the build.
 *
 * That is also why the list excludes every ambiguous name a first draft
 * reaches for. `out/`, `bin/`, `obj/`, `tmp/`, `vendor/`, `logs/` are all
 * plausible build directories AND plausible places to put a deliverable; a
 * wrong `build` label costs a demoted warning on real work, which is the
 * failure this whole section exists to end. Every name below is one whose
 * contents a project's own toolchain regenerates from committed sources.
 */
const BUILD_OUTPUT_DIR_NAMES: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'target',
  'coverage',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.parcel-cache',
  '.turbo',
  '.cache',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nyc_output',
]);

/** Single files whose extension alone says a tool regenerates them. */
const BUILD_OUTPUT_SUFFIXES: readonly string[] = ['.tsbuildinfo', '.pyc', '.class'];

/** Is one scanned entry recognisable as rebuildable output BY NAME ALONE? */
function looksLikeBuildOutput(path: string): boolean {
  let rel = path.split('\\').join('/');
  while (rel.startsWith('./')) rel = rel.slice(2);
  while (rel.length > 1 && rel.endsWith('/')) rel = rel.slice(0, -1);
  const last = rel.slice(rel.lastIndexOf('/') + 1);
  if (last.length === 0) return false;
  if (BUILD_OUTPUT_DIR_NAMES.has(last)) return true;
  return BUILD_OUTPUT_SUFFIXES.some((suffix) => last.length > suffix.length && last.endsWith(suffix));
}

/** A scan's entries, split by whether a name says a tool can make them again. */
export interface IgnoredOutputClasses {
  /**
   * Recognised as build, dependency, or cache output by its NAME. Never by
   * its contents — nothing here opened a single file.
   */
  build: string[];
  /**
   * Everything else, which is the important half. Not "known to be
   * irreplaceable": unrecognised. That is the same direction
   * `ignoredOutputClean` falls in, and for the same reason — the cost of
   * over-reporting here is a line someone reads, and the cost of
   * under-reporting is a deliverable nobody looks for.
   */
  unclassified: string[];
}

/**
 * Split a scan's paths, in the ONE place that decides.
 *
 * A pure function of `paths`, which is already on the row, so writer and
 * reader call the same code and no classification is ever written to the wire
 * to drift away from the list it describes. That is deliberate: a stored
 * verdict beside a stored list is two spellings of one fact, and a row
 * written by an older kernel would carry none — where this way an old row
 * gets today's reading for free.
 */
export function classifyIgnoredOutput(paths: readonly string[]): IgnoredOutputClasses {
  const build: string[] = [];
  const unclassified: string[] = [];
  for (const path of paths) (looksLikeBuildOutput(path) ? build : unclassified).push(path);
  return { build, unclassified };
}

/**
 * The same entries, reordered so anything NOT recognisable as build output
 * comes first.
 *
 * Every rendering of this stamp is capped at `ATTESTATION_PATHS_SHOWN`, and a
 * worktree that holds `node_modules/`, `dist/`, `.next/`, `coverage/` and one
 * `data/research/` tree would show the four benign entries and count the
 * fifth away. `carryPathVerdicts` already sorts hazards first for exactly this
 * reason; this is the same rule applied to the same kind of truncated sample.
 */
export function ignoredOutputSignalOrder(paths: readonly string[]): string[] {
  const { build, unclassified } = classifyIgnoredOutput(paths);
  return [...unclassified, ...build];
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

/** What one stamp actually establishes. */
export type OverlapStrength =
  /** Two windows overlapped in time and named at least one path in common. */
  | 'intersected'
  /** They overlapped in time; the other side had not closed, so no set existed. */
  | 'pending'
  /** They overlapped in time and the intersection could not be computed at all. */
  | 'unknown';

/**
 * Grade one stamp, in the ONE place that decides.
 *
 * Every surface that counts overlaps needs this, and each one guessing costs
 * the same defect: a stamp that says "I could not tell" being tallied as a
 * delivery that wrote. A zero-path settled stamp is only ever written when a
 * side could not enumerate its changes — the writer omits the stamp when both
 * listings were whole and did not meet — so zero-and-degraded is `unknown`,
 * never a finding of nothing.
 */
export function concurrentWriteStrength(record: ConcurrentWriteRecord): OverlapStrength {
  if (record.dispatchId === UNREADABLE_WINDOW_LOG_ID) return 'unknown';
  if (record.pending) return 'pending';
  const count = record.pathsIntersecting ?? record.paths.length;
  return count === 0 && record.degraded ? 'unknown' : 'intersected';
}

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
  if (record.dispatchId === UNREADABLE_WINDOW_LOG_ID) {
    return (
      'WINDOW LOG UNREADABLE — the log of who else was writing could not be read whole, so the overlaps ' +
      'named on this receipt are a floor. Any of them still happened; there may be others nothing saw. ' +
      'This is not a report that the tree was clean.'
    );
  }
  const where = [record.kind, record.workspaceMode, record.runId != null ? `run ${record.runId}` : null]
    .filter((part): part is string => part != null)
    .join(' · ');
  const head = `${shortId(record.dispatchId)}${where.length > 0 ? ` [${where}]` : ''}`;
  if (record.pending) {
    return (
      `${head}  PENDING — the windows overlapped in time, but that delivery had not finished, so no path ` +
      "set existed to intersect. It closes later, and its receipt is where this pair's intersection is " +
      'recorded — concretely when it can enumerate its changes, and as a degraded stamp when it cannot.'
    );
  }
  const count = record.pathsIntersecting ?? record.paths.length;
  // Zero intersecting paths on a settled stamp is only ever written when a
  // side could not enumerate its changes; the writer drops the stamp entirely
  // when both listings were whole and did not meet. Rendering it through the
  // sentence below would produce "at least 0 paths changed in both windows",
  // which reads as a finding of nothing — the exact collapse this file exists
  // to prevent.
  if (count === 0 && record.degraded) {
    return (
      `${head}  COULD NOT TELL — the windows overlapped in time and at least one side could not enumerate ` +
      'what it changed, so whether their edits met is unknown. This is not a report that they did not meet.'
    );
  }
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
 * One line describing gitignored output no diff carried out of a worktree.
 *
 * Unlike an overlap, this is not an attestation about who touched what: it is
 * a positive statement that named content existed in a worktree at teardown
 * and that `git add -A` staged none of it. The wording says so plainly, and
 * says `at least` whenever the listing is a floor — a truncated finding
 * rendered as though the named paths were all of it would understate it,
 * which is the failure mode with no recovery.
 *
 * ## Three things this line reports, and none of them are guessed
 *
 * 1. **The fate** — `KEPT` or `DISCARDED`, from `ignoredOutputVerdict`, which
 *    reads the writer's own `retained_at`. This used to be hardcoded to
 *    "DISCARDED" here and at four other surfaces, so a retained worktree read
 *    as a loss on every one of them.
 * 2. **The policy** — the resolved `ignored_output` the dispatch ran under,
 *    when the row states one. Absent for a row that did not say; never
 *    defaulted, because the default is one of the two legal values and
 *    inventing it would put a claim on the screen nobody made.
 * 3. **What kind of thing it is** — `classifyIgnoredOutput`, by name only,
 *    and said to be by name only. A `dist/` and a `data/research/` tree are
 *    not the same discovery, and reporting them identically is what taught
 *    readers to skip the line.
 */
export function describeIgnoredOutput(
  record: IgnoredOutputRecord,
  policy: IgnoredOutputPolicyRecord | null = null,
): string {
  const verdict = ignoredOutputVerdict(record);
  const { build, unclassified } = classifyIgnoredOutput(record.paths);
  const listed = samplePaths(ignoredOutputSignalOrder(record.paths), null);
  const fate = record.retainedAt != null
    ? `still on disk at ${record.retainedAt} until \`fadeno clean\` removes it`
    : 'the worktree is gone, so this content is not recoverable from it';
  const head = record.paths.length === 0
    ? record.truncated
      ? `gitignored output was ${verdict} and the listing could not be taken — what was in that worktree is ` +
        'unknown, not nothing'
      : `gitignored output was ${verdict}; the row names no paths`
    : `${record.truncated ? 'at least ' : ''}${listed} — gitignored, so \`git add -A\` staged none of it and no diff ` +
      'carried it out of the worktree';
  const floor = record.truncated && record.paths.length > 0 ? ' The listing is a floor, not the set.' : '';
  // The kind clause. Only ever said when a name was actually recognised, and
  // always attributed to the name rather than to an inspection that never
  // happened.
  const kinds = build.length === 0
    ? ''
    : unclassified.length === 0
      ? ` Every entry is recognised as build or dependency output by NAME (${samplePaths(build, null)}); nothing ` +
        'was opened to confirm that, which is why it was kept rather than destroyed.'
      : ` Recognised as build or dependency output by name, and listed last: ${samplePaths(build, null)}.`;
  // A `kept` policy whose content was destroyed anyway is the one combination
  // that is a defect rather than an outcome, so it does not render as a
  // neutral policy note.
  const policyClause = policy == null
    ? ''
    : policy === 'kept' && verdict === 'DISCARDED'
      ? ' This dispatch declared `ignored_output: kept` and the content did not survive — a defect, not a policy outcome.'
      : ` Declared policy: \`ignored_output: ${policy}\`.`;
  const why = record.note != null ? ` (${record.note})` : '';
  return `${head}. ${fate}.${floor}${kinds}${policyClause}${why}`;
}

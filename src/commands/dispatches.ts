import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
import {
  DISPATCHES_FILE,
  DISPATCHES_FORMAT,
  normalizeDispatchOutcome,
  type DispatchOutcome,
} from './dispatch.ts';

export class DispatchesCommandError extends Error {}

/** Logical entries rendered when `--tail` is not given. */
export const DEFAULT_TAIL = 10;

/** Longest recorded spawn error rendered inline before ellipsis. */
const ERROR_EXCERPT = 80;

/**
 * The evidence-format major this reader understands, derived from the writer's
 * own stamp so the two can never disagree.
 */
const KNOWN_FORMAT_MAJOR = DISPATCHES_FORMAT.split('.')[0]!;

/**
 * Outcome keys that mark a row as the *result* of a dispatch rather than its
 * request. Presence, not value: `exit_code` is null when the spawn itself
 * failed, so a value test would drop exactly the rows worth keeping.
 */
const OUTCOME_KEYS = ['exit_code', 'duration_ms', 'output_sha256', 'signal'];

/**
 * One logical dispatch: a correlated `dispatch_requested` /
 * `dispatch_completed` pair from the kernel (`kind: "command"`), a single
 * `dispatch_refused` row (also `kind: "command"` — the refusal *is* the
 * request-point evidence), or a single `host_delivery` row from the Claude
 * steering hook (`kind: "host"`), which has no kernel downstream.
 */
export interface DispatchEntry {
  kind: 'command' | 'host';
  /**
   * The row's recorded evidence-format version, or null when it predates the
   * stamp (everything written before `DISPATCHES_FORMAT` existed).
   */
  format: string | null;
  /**
   * True for a pre-`dispatch_id` row: one completion-shaped row per dispatch,
   * no correlation id, read best-effort from whatever identity it recorded.
   */
  legacy: boolean;
  /** Verbatim recorded timestamp — for pairs, the request's (when it started). */
  timestamp: string | null;
  /** Correlation id; always null for host deliveries (they have none). */
  dispatchId: string | null;
  archetype: string | null;
  /** Command dispatches only: the `--role` this was attributed to. */
  role: string | null;
  /** Host deliveries only: the subagent type the harness was about to spawn. */
  agentType: string | null;
  resolution: string | null;
  loadout: string | null;
  loadoutSource: string | null;
  executor: string | null;
  model: string | null;
  /** Host deliveries only: per-spawn model override, when the hook saw one. */
  modelOverride: string | null;
  reasoningEffort: string | null;
  target: string | null;
  provider: string | null;
  transport: string | null;
  promptSource: string | null;
  promptSnapshot: string | null;
  promptSha256: string | null;
  relayAttested: boolean | null;
  writeAccess: boolean | null;
  /**
   * Present on a `dispatch_refused` row. Null on every other kind.
   */
  refusal: { predicate: string; message: string } | null;
  /**
   * `false` when the row stamped `gate_eligible: false` (shadow_only).
   * Null when the field is absent — absent is not a claim of eligible.
   */
  gateEligible: boolean | null;
  /**
   * Whether an outcome was recorded. False on a command dispatch means the
   * process never reached its completion row — killed, or still in flight.
   * Host deliveries and refusals record no outcome, so they are always false.
   */
  completed: boolean;
  /**
   * What the completion row says the dispatch produced. Stated by the writer,
   * derived from `exit_code`/`output_bytes` on rows written before the field,
   * and null when the row carries too little to say either way.
   */
  outcome: DispatchOutcome | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  outputSha256: string | null;
  /**
   * Completion-row attestation that the workspace fingerprint changed across
   * the spawn. Null when the field is absent — absent is not a claim of
   * unchanged (no git, probe failed, or a row that predates the field).
   */
  workspaceChanged: boolean | null;
  error: string | null;
  shadow: boolean;
  primaryDispatchId: string | null;
  shadowSource: string | null;
  diffSnapshot: string | null;
  diffBytes: number | null;
  outputBytes: number | null;
}

export interface DispatchesOptions {
  /** Logical entries to show, newest-last (default 10). */
  tail?: number;
  cwd?: string;
  repoRoot?: string;
}

export interface DispatchesResult {
  repoRoot: string;
  /** Repo-relative evidence log that was read. */
  path: string;
  exists: boolean;
  /** Logical entries in the whole log (before `tail` truncation). */
  total: number;
  /** Rows that could not be read as evidence (bad JSON or unknown event). */
  skipped: number;
  /**
   * Rows stamped with a format major this reader was not written against.
   * Counted apart from `skipped`: they are perfectly good evidence written by
   * a newer fadeno, and the fix is to upgrade — not to repair the log.
   */
  skippedNewerFormat: number;
  tail: number;
  /** The last `tail` logical entries, oldest → newest. */
  entries: DispatchEntry[];
  /** One rendered line per entry, index-aligned with `entries`. */
  lines: string[];
  /** Footer for the rendered view, or the friendly message when empty. */
  summary: string;
}

/** Shortest unique prefix `runDispatchesOutput` will accept as a dispatch id. */
const OUTPUT_ID_PREFIX_MIN = 8;

export type DispatchOutputAttestation = 'match' | 'mismatch' | 'incomplete';

export interface DispatchesOutputOptions {
  /** Full `dispatch_id`, unique prefix of at least 8 characters, or `last`. */
  dispatchId: string;
  cwd?: string;
  repoRoot?: string;
  /**
   * Accepted for CLI-wiring symmetry with other commands. Recovery reads only
   * the repo-local evidence log and snapshot file; user-scope state is unused.
   */
  env?: string | null;
  /**
   * Wait up to this many milliseconds for the completion row to arrive before
   * answering. Zero or absent reads once.
   *
   * A timed-out caller reads the ledger at the one moment the answer is least
   * likely to be there: the harness gave up on the call, but the executor is
   * still running and the kernel has not written its completion row yet. The
   * 2026-08-13 dogfood proxies read exactly then, saw no completion, declared
   * failure, and never looked again — while the kernel went on to record both
   * dispatches as `exit_code: 0` with 5833 and 3743 bytes. The data was right
   * the whole time; the read was early. Waiting is the difference between
   * asking once and asking until there is an answer.
   */
  waitMs?: number;
  /** Poll interval while waiting. Injectable so tests need no real delay. */
  pollMs?: number;
}

export interface DispatchesOutputResult {
  dispatchId: string;
  /** Repo-relative `output_snapshot` path recorded on the request row. */
  path: string;
  /** Current snapshot file content. */
  bytes: string;
  /**
   * `match` / `mismatch` compare sha256(bytes) to the completion row's
   * `output_sha256`. `incomplete` when no completion row exists — the
   * killed-mid-flight case this reader exists for.
   */
  attested: DispatchOutputAttestation;
  /**
   * How the query landed on this record. `recency` means `last` fell back to
   * "newest in the log" because nothing was open — a guess worth surfacing
   * when concurrent dispatches share one evidence file.
   */
  resolvedBy: OutputResolution;
}

/**
 * Block the calling thread. Recovery is a synchronous command in a
 * synchronous CLI; making the whole call stack async to wait for one file to
 * gain a line is not a trade worth making.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `loadout` is `{name, source}` on kernel rows and a bare name on hook rows. */
function loadoutOf(value: unknown): { name: string | null; source: string | null } {
  if (typeof value === 'string') return { name: value === '' ? null : value, source: null };
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    return { name: str(row.name), source: str(row.source) };
  }
  return { name: null, source: null };
}

function excerpt(text: string, max: number): string {
  const oneLine = text.split('\n')[0]!.trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Which reader tier a row's `format` stamp puts it in.
 *
 * - `unversioned` — no stamp: written before the format was versioned. Read on
 *   its recorded shape, which is what the tiers below sort out.
 * - `known` — same major as `DISPATCHES_FORMAT`. Unknown *minors* land here on
 *   purpose: within a major, a bump only adds fields, so best-effort reading
 *   of a newer minor is correct rather than reckless.
 * - `newer` — a different major. That is a format this reader was not written
 *   against, so the row is set aside and counted, never reinterpreted.
 */
function formatTier(value: unknown): 'unversioned' | 'known' | 'newer' {
  const format = str(value);
  if (format == null) return 'unversioned';
  return format.split('.')[0] === KNOWN_FORMAT_MAJOR ? 'known' : 'newer';
}

/**
 * Does an unversioned, event-less row look like a pre-`dispatch_id` dispatch?
 * That writer emitted exactly one row per dispatch, after the spawn: a
 * timestamp, whatever identity it had resolved, and the outcome. Requiring a
 * timestamp, some identity, and at least one outcome key keeps an unrelated
 * JSON object from being read as evidence of a dispatch that never happened.
 */
function isLegacyCompletion(row: Record<string, unknown>): boolean {
  if (str(row.timestamp) == null) return false;
  if (str(row.executor) == null && str(row.archetype) == null) return false;
  return OUTCOME_KEYS.some((key) => key in row);
}

function refusalOf(value: unknown): { predicate: string; message: string } | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const predicate = str(row.predicate);
  const message = typeof row.message === 'string' ? row.message : null;
  if (predicate == null || message == null) return null;
  return { predicate, message };
}

function requestedEntry(row: Record<string, unknown>): DispatchEntry {
  const loadout = loadoutOf(row.loadout);
  return {
    kind: 'command',
    format: str(row.format),
    legacy: false,
    timestamp: str(row.timestamp),
    dispatchId: str(row.dispatch_id),
    archetype: str(row.archetype),
    role: str(row.role),
    agentType: null,
    resolution: str(row.resolution),
    loadout: loadout.name,
    loadoutSource: loadout.source,
    executor: str(row.executor),
    model: str(row.model),
    modelOverride: null,
    reasoningEffort: str(row.reasoning_effort),
    target: str(row.target),
    provider: str(row.provider),
    transport: str(row.transport),
    promptSource: str(row.prompt_source),
    promptSnapshot: str(row.prompt_snapshot),
    promptSha256: str(row.prompt_sha256),
    relayAttested: bool(row.relay_attested),
    writeAccess: bool(row.write_access),
    refusal: refusalOf(row.refusal),
    gateEligible: row.gate_eligible === false ? false : null,
    completed: false,
    outcome: null,
    exitCode: null,
    signal: null,
    durationMs: null,
    outputSha256: null,
    workspaceChanged: null,
    error: null,
    shadow: row.shadow === true,
    primaryDispatchId: str(row.primary_dispatch_id),
    shadowSource: str(row.shadow_source),
    diffSnapshot: str(row.diff_snapshot),
    diffBytes: num(row.diff_bytes),
    outputBytes: num(row.output_bytes),
  };
}

function hostEntry(row: Record<string, unknown>): DispatchEntry {
  const loadout = loadoutOf(row.loadout);
  return {
    kind: 'host',
    format: str(row.format),
    legacy: false,
    timestamp: str(row.timestamp),
    dispatchId: null,
    archetype: str(row.archetype),
    role: null,
    agentType: str(row.agent_type),
    resolution: null,
    loadout: loadout.name,
    loadoutSource: loadout.source,
    executor: str(row.executor),
    model: str(row.model),
    modelOverride: str(row.model_override),
    reasoningEffort: str(row.reasoning_effort),
    target: null,
    provider: null,
    transport: str(row.transport),
    promptSource: null,
    promptSnapshot: str(row.prompt_snapshot),
    promptSha256: str(row.prompt_sha256),
    relayAttested: null,
    writeAccess: null,
    refusal: null,
    gateEligible: null,
    completed: false,
    outcome: null,
    exitCode: null,
    signal: null,
    durationMs: null,
    outputSha256: null,
    workspaceChanged: null,
    error: null,
    shadow: false,
    primaryDispatchId: null,
    shadowSource: null,
    diffSnapshot: null,
    diffBytes: null,
    outputBytes: null,
  };
}

/** Fold a completion row's outcome into the entry its request row opened. */
function applyCompletion(entry: DispatchEntry, row: Record<string, unknown>): void {
  entry.completed = true;
  entry.exitCode = num(row.exit_code);
  entry.signal = str(row.signal);
  entry.durationMs = num(row.duration_ms);
  entry.outputSha256 = str(row.output_sha256);
  entry.error = str(row.error);
  if (typeof row.workspace_changed === 'boolean') {
    entry.workspaceChanged = row.workspace_changed;
  }
  // A completion row carries the full identity again; prefer it where the
  // request row was silent (older logs, partially written rows).
  entry.relayAttested = entry.relayAttested ?? bool(row.relay_attested);
  entry.writeAccess = entry.writeAccess ?? bool(row.write_access);
  entry.model = entry.model ?? str(row.model);
  entry.executor = entry.executor ?? str(row.executor);
  if (row.gate_eligible === false) entry.gateEligible = false;
  if (entry.refusal == null) entry.refusal = refusalOf(row.refusal);
  // Shadow and output fields may arrive on either row; completion wins where
  // request was silent, mirroring the identity fallback above.
  if (row.shadow === true) entry.shadow = true;
  entry.primaryDispatchId = entry.primaryDispatchId ?? str(row.primary_dispatch_id);
  entry.shadowSource = entry.shadowSource ?? str(row.shadow_source);
  entry.diffSnapshot = entry.diffSnapshot ?? str(row.diff_snapshot);
  const db = num(row.diff_bytes);
  if (db != null) entry.diffBytes = db;
  const ob = num(row.output_bytes);
  if (ob != null) entry.outputBytes = ob;
  // Last, so it classifies against the fields this row just folded in rather
  // than the request row's blanks.
  entry.outcome = normalizeDispatchOutcome(row.outcome, entry);
}

/**
 * A pre-`dispatch_id` row read as one complete dispatch. The old writer put a
 * single row on disk after the spawn, so the row is both request and outcome:
 * build the identity the same way a request row is built (every field it
 * lacks simply reads null) and fold its own outcome straight back in. Old
 * evidence ages into `[legacy]` rather than degrading into "unreadable" — the
 * dispatch really happened, and a reader that drops it is lying by omission.
 */
function legacyEntry(row: Record<string, unknown>): DispatchEntry {
  const entry = requestedEntry(row);
  entry.legacy = true;
  applyCompletion(entry, row);
  return entry;
}

/**
 * One provenance line per logical entry:
 *
 * ```
 * <ts>  [command]  worker/reviewer → executor (model)  via command  exit 0 in 12ms  [markers]  <prompt snapshot>
 * ```
 *
 * Host deliveries render `[host]`, fold any `model_override` into the
 * model as `(model → override)`, and carry no outcome field.
 */
export function renderDispatchLine(entry: DispatchEntry): string {
  const parts: string[] = [entry.timestamp ?? '?', `[${entry.kind}]`];

  // Host rows have no `role`; their `agent_type` is the closest thing to
  // one (the subagent the harness was about to spawn), so it takes the slot
  // — unless it merely repeats the archetype.
  const roleSlot = entry.role ?? (entry.agentType !== entry.archetype ? entry.agentType : null);
  const who = `${entry.archetype ?? '(none)'}${roleSlot != null ? `/${roleSlot}` : ''}`;
  const model =
    entry.modelOverride != null
      ? `${entry.model ?? '?'} → ${entry.modelOverride}`
      : entry.model;
  parts.push(
    `${who} → ${entry.executor ?? '(unresolved)'}${model != null ? ` (${model})` : ''}`,
  );
  if (entry.transport != null) parts.push(`via ${entry.transport}`);
  if (entry.shadow) {
    const pid8 = entry.primaryDispatchId ? entry.primaryDispatchId.slice(0, 8) : '?';
    parts.push(`[shadow of ${pid8}]`);
  }

  if (entry.kind === 'command') {
    if (entry.refusal != null) {
      parts.push(`[refused: ${entry.refusal.predicate}]`);
      parts.push(entry.refusal.message);
    } else if (entry.completed) {
      // The outcome leads. `dispatch_completed` only means the spawn reached a
      // terminal state, and a reader scanning exit codes at the end of a long
      // line was the thing that let two zero-byte failures read as success.
      if (entry.outcome === 'failed') parts.push('FAILED');
      else if (entry.outcome === 'empty') parts.push('NO OUTPUT');
      const code = `exit ${entry.exitCode ?? '?'}${entry.signal != null ? ` (${entry.signal})` : ''}`;
      parts.push(entry.durationMs != null ? `${code} in ${entry.durationMs}ms` : code);
      // Exit-0 + write-capable + an explicit "nothing changed" attestation:
      // the legible face of the exit-0 no-op. Rows that omit any of the
      // three fields render unchanged — absent is not a claim.
      if (
        entry.exitCode === 0 &&
        entry.writeAccess === true &&
        entry.workspaceChanged === false &&
        !entry.shadow
      ) {
        parts.push('[no workspace change]');
      }
    } else {
      parts.push('no completion recorded (killed or in flight)');
    }
  }

  if (entry.relayAttested != null) parts.push(`[relay_attested: ${entry.relayAttested}]`);
  if (entry.writeAccess === false) parts.push('[write_access: none]');
  if (entry.gateEligible === false) parts.push('[shadow-only]');
  if (entry.error != null) parts.push(`[error: ${excerpt(entry.error, ERROR_EXCERPT)}]`);
  if (entry.promptSnapshot != null) parts.push(entry.promptSnapshot);
  // Trailing, after the identity it qualifies: this row predates the versioned
  // two-row format, so anything reading `?` above is a field that writer never
  // recorded — not a field this one lost.
  if (entry.legacy) parts.push('[legacy]');
  return parts.join('  ');
}

function summarize(
  shown: number,
  total: number,
  skipped: number,
  newerFormat: number,
  exists: boolean,
  path: string,
): string {
  // Two distinct notes: an unreadable row is damage, a newer-format row is a
  // fadeno that is behind its own evidence. Conflating them would send the
  // reader to repair a log that is perfectly intact.
  const notes =
    (skipped > 0 ? `  (${skipped} unreadable row${skipped === 1 ? '' : 's'} skipped)` : '') +
    (newerFormat > 0
      ? `  (${newerFormat} row${newerFormat === 1 ? '' : 's'} from a newer format skipped)`
      : '');
  if (total === 0) {
    return exists
      ? `No dispatches recorded in ${path}.${notes}`
      : `No dispatches recorded yet (${path} absent).${notes}`;
  }
  return `${shown} of ${total} dispatch${total === 1 ? '' : 'es'} shown${notes}`;
}

/**
 * Read `.fadeno/dispatches.jsonl` and answer "which executor actually ran
 * what?" — kernel `dispatch_requested`/`dispatch_completed` rows correlated by
 * `dispatch_id` into one logical entry each, `dispatch_refused` rows as
 * standalone command entries, plus the steering hook's `host_delivery` rows. Order is append order (oldest → newest), never
 * re-sorted by timestamp: a killed dispatch's request row is still where it
 * happened. A missing or empty log is a friendly answer, not an error, and
 * rows that cannot be read are counted rather than fatal — the log is
 * evidence, and a truncated tail must not hide the rows that survived.
 *
 * The log spans formats, so the reader is tiered on each row's `format` stamp
 * (see `formatTier`): stamped rows within the known major read normally,
 * pre-stamp rows read on their recorded shape — including the single
 * completion-shaped rows written before `dispatch_id`, which surface as
 * `[legacy]` entries — and rows from a future major are counted separately
 * from unreadable ones. This is the lightweight half of the run ledger's
 * versioning policy: a projection may read old evidence best-effort, where a
 * ledger *writer* must refuse it outright.
 */
export function runDispatches(opts: DispatchesOptions = {}): DispatchesResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const tail = opts.tail ?? DEFAULT_TAIL;
  if (!Number.isInteger(tail) || tail < 1) {
    throw new DispatchesCommandError(`tail must be a positive integer (got ${String(opts.tail)}).`);
  }

  const path = DISPATCHES_FILE.split('\\').join('/');
  const absolute = join(repoRoot, DISPATCHES_FILE);
  if (!existsSync(absolute)) {
    return {
      repoRoot,
      path,
      exists: false,
      total: 0,
      skipped: 0,
      skippedNewerFormat: 0,
      tail,
      entries: [],
      lines: [],
      summary: summarize(0, 0, 0, 0, false, path),
    };
  }

  const entries: DispatchEntry[] = [];
  const byDispatchId = new Map<string, DispatchEntry>();
  let skipped = 0;
  let skippedNewerFormat = 0;

  for (const line of readFileSync(absolute, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      row = parsed as Record<string, unknown>;
    } catch {
      skipped += 1; // a torn or hand-edited line never stops the report
      continue;
    }
    const tier = formatTier(row.format);
    if (tier === 'newer') {
      // Written by a fadeno that knows a format this one does not. Guessing at
      // the fields would fabricate provenance, so say so and move on.
      skippedNewerFormat += 1;
      continue;
    }
    const event = str(row.event);
    // Pre-`dispatch_id` evidence: no `event`, no correlation, one row per
    // dispatch. Recognized on shape, since shape is all that writer left.
    if (tier === 'unversioned' && event == null && isLegacyCompletion(row)) {
      entries.push(legacyEntry(row));
      continue;
    }
    // `native_delivery` is the pre-0.6 name for the same row; a log written
    // by an older hook still renders.
    if (event === 'host_delivery' || event === 'native_delivery') {
      entries.push(hostEntry(row));
      continue;
    }
    if (event === 'dispatch_refused') {
      entries.push(requestedEntry(row));
      continue;
    }
    const dispatchId = str(row.dispatch_id);
    if ((event === 'dispatch_requested' || event === 'dispatch_completed') && dispatchId == null) {
      skipped += 1; // uncorrelatable: the writer always pairs on dispatch_id
      continue;
    }
    if (event === 'dispatch_requested') {
      const entry = requestedEntry(row);
      entries.push(entry);
      byDispatchId.set(dispatchId!, entry);
      continue;
    }
    if (event === 'dispatch_completed') {
      const open = byDispatchId.get(dispatchId!);
      if (open != null) {
        applyCompletion(open, row);
      } else {
        // Completion without a request row (a log truncated at the head):
        // still evidence of a dispatch, so surface it rather than drop it.
        const entry = requestedEntry(row);
        applyCompletion(entry, row);
        entries.push(entry);
        byDispatchId.set(dispatchId!, entry);
      }
      continue;
    }
    skipped += 1; // some other row kind: not renderable as a dispatch
  }

  const shown = entries.slice(-tail);
  return {
    repoRoot,
    path,
    exists: true,
    total: entries.length,
    skipped,
    skippedNewerFormat,
    tail,
    entries: shown,
    lines: shown.map(renderDispatchLine),
    summary: summarize(shown.length, entries.length, skipped, skippedNewerFormat, true, path),
  };
}

interface OutputRecord {
  dispatchId: string;
  snapshot: string | null;
  outputSha256: string | null;
  completed: boolean;
}

/**
 * Walk the evidence log for output-snapshot recovery. Unreadable lines are
 * skipped (same as the list reader): a torn tail must not hide a recoverable
 * snapshot. Format majors this list reader would set aside are still
 * consulted — recovery is about the file, not the stamp.
 */
function loadOutputRecords(absolute: string): {
  byId: Map<string, OutputRecord>;
  lastWithSnapshot: string | null;
  /** Dispatch ids in the order their request rows appeared, snapshots only. */
  requestOrder: string[];
} {
  const byId = new Map<string, OutputRecord>();
  let lastWithSnapshot: string | null = null;
  const requestOrder: string[] = [];
  if (!existsSync(absolute)) return { byId, lastWithSnapshot, requestOrder };

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
    if (event !== 'dispatch_requested' && event !== 'dispatch_completed') continue;

    let rec = byId.get(dispatchId);
    if (rec == null) {
      rec = { dispatchId, snapshot: null, outputSha256: null, completed: false };
      byId.set(dispatchId, rec);
    }
    const snapshot = str(row.output_snapshot);
    if (snapshot != null) rec.snapshot = snapshot;
    if (event === 'dispatch_requested' && snapshot != null) {
      lastWithSnapshot = dispatchId;
      requestOrder.push(dispatchId);
    }
    if (event === 'dispatch_completed') {
      rec.completed = true;
      rec.outputSha256 = str(row.output_sha256);
    }
  }
  return { byId, lastWithSnapshot, requestOrder };
}

/**
 * How `last` picked its record. `in-flight` is the keyword's actual purpose —
 * the one dispatch with no completion row is the killed or still-running one
 * the caller is trying to recover. `recency` is the weaker fallback, a guess
 * about the whole repo's log, and is reported as such.
 */
export type OutputResolution = 'id' | 'in-flight' | 'recency';

function resolveOutputRecord(
  query: string,
  byId: Map<string, OutputRecord>,
  lastWithSnapshot: string | null,
  requestOrder: readonly string[],
): { record: OutputRecord; resolvedBy: OutputResolution } {
  if (query === 'last') {
    if (lastWithSnapshot == null) {
      throw new DispatchesCommandError(
        'unknown dispatch "last": no output_snapshot has been recorded.',
      );
    }
    // Recovery, not recency: prefer the dispatch that never reached its
    // completion row. Concurrent dispatches made bare recency actively wrong —
    // a 2026-08-13 dogfood had one proxy recover another proxy's report and
    // very nearly relay it as its own — so when more than one is still open,
    // refuse and make the caller name the id the kernel echoed at spawn.
    const open = requestOrder.filter((id) => byId.get(id)?.completed === false);
    if (open.length === 1) return { record: byId.get(open[0]!)!, resolvedBy: 'in-flight' };
    if (open.length > 1) {
      const candidates = open.map((id) => id.slice(0, 8)).join(', ');
      throw new DispatchesCommandError(
        `ambiguous dispatch "last": ${open.length} dispatches are still open (${candidates}). ` +
          'Name yours — the kernel echoed `dispatch id: <id>` on stderr when it started.',
      );
    }
    return { record: byId.get(lastWithSnapshot)!, resolvedBy: 'recency' };
  }

  const exact = byId.get(query);
  if (exact != null) return { record: exact, resolvedBy: 'id' };

  if (query.length < OUTPUT_ID_PREFIX_MIN) {
    throw new DispatchesCommandError(`unknown dispatch "${query}".`);
  }
  const hits = [...byId.values()].filter((rec) => rec.dispatchId.startsWith(query));
  if (hits.length === 0) throw new DispatchesCommandError(`unknown dispatch "${query}".`);
  if (hits.length > 1) {
    throw new DispatchesCommandError(`ambiguous dispatch prefix "${query}".`);
  }
  return { record: hits[0]!, resolvedBy: 'id' };
}

/**
 * Recover the streamed output snapshot for one command dispatch. `dispatchId`
 * is a full `dispatch_id`, a unique prefix of at least 8 characters, or the
 * keyword `last` (most recent `dispatch_requested` row that carries
 * `output_snapshot`). The snapshot file's current bytes are the result; the
 * attestation compares their digest to the completion row, or reports
 * `incomplete` when that row never arrived.
 *
 * Not wired to a CLI flag here — the integrator adds
 * `fadeno dispatches --output <id|last>` in `src/cli.ts` (stdout = bytes
 * verbatim, stderr = one attestation note line).
 */
export function runDispatchesOutput(opts: DispatchesOutputOptions): DispatchesOutputResult {
  const query = opts.dispatchId.trim();
  if (query === '') {
    throw new DispatchesCommandError(
      'dispatch id is required (full id, unique prefix of 8+ characters, or "last").',
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const ledger = join(repoRoot, DISPATCHES_FILE);
  let { byId, lastWithSnapshot, requestOrder } = loadOutputRecords(ledger);
  let { record: rec, resolvedBy } = resolveOutputRecord(query, byId, lastWithSnapshot, requestOrder);

  // Re-read until the completion row lands. The kernel appends it when the
  // executor exits, which is routinely *after* the caller's own timeout: the
  // answer is not missing, it has not been written yet.
  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0 && !rec.completed) {
    const pollMs = opts.pollMs ?? 1_000;
    const deadline = Date.now() + waitMs;
    // How the caller reached this dispatch is settled; only its state is not.
    const settledId = rec.dispatchId;
    while (!rec.completed && Date.now() < deadline) {
      sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      ({ byId, lastWithSnapshot, requestOrder } = loadOutputRecords(ledger));
      // Re-resolve by the id already settled on: `last` must not drift onto a
      // different dispatch that started while this one was being waited for.
      rec = resolveOutputRecord(settledId, byId, lastWithSnapshot, requestOrder).record;
    }
  }

  if (rec.snapshot == null) {
    throw new DispatchesCommandError(`dispatch "${rec.dispatchId}" predates output_snapshot.`);
  }

  const snapshotRel = rec.snapshot.split('\\').join('/');
  const snapshotAbs = isAbsolute(snapshotRel) ? snapshotRel : join(repoRoot, snapshotRel);
  if (!existsSync(snapshotAbs)) {
    throw new DispatchesCommandError(`output snapshot missing: ${snapshotRel}.`);
  }

  const bytes = readFileSync(snapshotAbs, 'utf8');
  const attested: DispatchOutputAttestation = !rec.completed
    ? 'incomplete'
    : sha256Hex(bytes) === rec.outputSha256
      ? 'match'
      : 'mismatch';
  return { dispatchId: rec.dispatchId, path: snapshotRel, bytes, attested, resolvedBy };
}

// ---------------------------------------------------------------------------
// Comparisons (shadow pairs + ModelComparison artifacts)
// ---------------------------------------------------------------------------

export const COMPARISONS_DIR = join('.fadeno', 'comparisons');

export interface DispatchComparisonPair {
  primaryId: string | null;
  shadowId: string | null;
  primaryDispatchId: string | null;
  archetype: string | null;
  primary: {
    dispatchId: string | null;
    executor: string | null;
    model: string | null;
    exitCode: number | null;
    outputBytes: number | null;
    promptSha256: string | null;
  };
  shadow: {
    dispatchId: string | null;
    executor: string | null;
    model: string | null;
    exitCode: number | null;
    outputBytes: number | null;
    diffBytes: number | null;
    diffSnapshot: string | null;
    promptSha256: string | null;
  };
  promptShaMismatch: boolean;
  orphan: boolean;
}

export interface ModelComparisonArtifact {
  file: string;
  baseline: string | null;
  challenger: string | null;
  verdict: string | null;
  date: string | null;
  dispatchIds: string[] | null;
  valid: boolean;
  error?: string;
}

export interface DispatchComparisonGroup {
  challenger: string;
  pairs: DispatchComparisonPair[];
  comparisons: ModelComparisonArtifact[];
  tally: {
    pairs: number;
    comparisons: number;
    preferChallenger: number;
    preferBaseline: number;
    tieOrInconclusive: number;
  };
}

export interface DispatchesComparisonsOptions {
  cwd?: string;
  repoRoot?: string;
}

export interface DispatchesComparisonsResult {
  repoRoot: string;
  path: string;
  comparisonsDir: string;
  totalPairs: number;
  totalComparisons: number;
  skippedComparisons: number;
  skipped: number;
  skippedNewerFormat: number;
  groups: DispatchComparisonGroup[];
  lines: string[];
  summary: string;
}

function loadAllEntries(absolute: string): {
  entries: DispatchEntry[];
  skipped: number;
  skippedNewerFormat: number;
} {
  const entries: DispatchEntry[] = [];
  const byDispatchId = new Map<string, DispatchEntry>();
  let skipped = 0;
  let skippedNewerFormat = 0;
  if (!existsSync(absolute)) return { entries, skipped, skippedNewerFormat };
  for (const line of readFileSync(absolute, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      row = parsed as Record<string, unknown>;
    } catch {
      skipped += 1;
      continue;
    }
    const tier = formatTier(row.format);
    if (tier === 'newer') {
      skippedNewerFormat += 1;
      continue;
    }
    const event = str(row.event);
    if (tier === 'unversioned' && event == null && isLegacyCompletion(row)) {
      entries.push(legacyEntry(row));
      continue;
    }
    if (event === 'host_delivery' || event === 'native_delivery') {
      entries.push(hostEntry(row));
      continue;
    }
    if (event === 'dispatch_refused') {
      entries.push(requestedEntry(row));
      continue;
    }
    const dispatchId = str(row.dispatch_id);
    if ((event === 'dispatch_requested' || event === 'dispatch_completed') && dispatchId == null) {
      skipped += 1;
      continue;
    }
    if (event === 'dispatch_requested') {
      const entry = requestedEntry(row);
      entries.push(entry);
      byDispatchId.set(dispatchId!, entry);
      continue;
    }
    if (event === 'dispatch_completed') {
      const open = byDispatchId.get(dispatchId!);
      if (open != null) {
        applyCompletion(open, row);
      } else {
        const entry = requestedEntry(row);
        applyCompletion(entry, row);
        entries.push(entry);
        byDispatchId.set(dispatchId!, entry);
      }
      continue;
    }
    skipped += 1;
  }
  return { entries, skipped, skippedNewerFormat };
}

function parseModelComparisonFile(repoRoot: string, relPath: string): ModelComparisonArtifact {
  const abs = join(repoRoot, relPath);
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return { file: relPath, baseline: null, challenger: null, verdict: null, date: null, dispatchIds: null, valid: false, error: 'unreadable' };
  }
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    return { file: relPath, baseline: null, challenger: null, verdict: null, date: null, dispatchIds: null, valid: false, error: 'missing frontmatter' };
  }
  const frontmatterText = match[1]!;
  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(frontmatterText) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    data = parsed as Record<string, unknown>;
  } catch {
    return { file: relPath, baseline: null, challenger: null, verdict: null, date: null, dispatchIds: null, valid: false, error: 'invalid yaml' };
  }
  const kind = str(data.kind);
  const baseline = str(data.baseline);
  const challenger = str(data.challenger);
  const verdict = str(data.verdict);
  const date = str(data.date);
  const dispatchIdsRaw = data.dispatch_ids;
  let dispatchIds: string[] | null = null;
  if (Array.isArray(dispatchIdsRaw)) dispatchIds = dispatchIdsRaw.filter((v): v is string => typeof v === 'string' && v !== '');
  const valid = kind === 'ModelComparison' && baseline != null && challenger != null && verdict != null && date != null;
  const body = content.slice(match[0].length);
  const hasCriteria = /^##\s+Criteria/m.test(body);
  const hasConfounds = /^##\s+Confounds/m.test(body);
  if (!hasCriteria || !hasConfounds) {
    return { file: relPath, baseline, challenger, verdict, date, dispatchIds, valid: false, error: 'missing required sections' };
  }
  if (!valid) return { file: relPath, baseline, challenger, verdict, date, dispatchIds, valid: false, error: 'invalid frontmatter' };
  const allowedVerdicts = new Set(['prefer_baseline', 'prefer_challenger', 'tie', 'inconclusive']);
  if (!allowedVerdicts.has(verdict!)) {
    return { file: relPath, baseline, challenger, verdict, date, dispatchIds, valid: false, error: 'invalid verdict' };
  }
  return { file: relPath, baseline, challenger, verdict, date, dispatchIds, valid: true };
}

function scanComparisons(repoRoot: string, dirRel: string): { artifacts: ModelComparisonArtifact[]; skipped: number } {
  const abs = join(repoRoot, dirRel);
  if (!existsSync(abs)) return { artifacts: [], skipped: 0 };
  let files: string[];
  try {
    files = readdirSync(abs).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return { artifacts: [], skipped: 0 };
  }
  const artifacts: ModelComparisonArtifact[] = [];
  let skipped = 0;
  for (const file of files) {
    const rel = join(dirRel, file).split('\\').join('/');
    const artifact = parseModelComparisonFile(repoRoot, rel);
    if (!artifact.valid) skipped += 1;
    artifacts.push(artifact);
  }
  return { artifacts, skipped };
}

function formatComparisonPair(pair: DispatchComparisonPair): string {
  const primaryId8 = pair.primaryId ? pair.primaryId.slice(0, 8) : '?';
  const shadowId8 = pair.shadowId ? pair.shadowId.slice(0, 8) : '?';
  const arch = pair.archetype ?? '(none)';
  const primaryInfo = `${pair.primary.executor ?? '(unresolved)'} (${pair.primary.model ?? '?'}) exit ${pair.primary.exitCode ?? '?'} output ${pair.primary.outputBytes ?? '?'} bytes`;
  const shadowInfo = `${pair.shadow.executor ?? '(unresolved)'} (${pair.shadow.model ?? '?'}) exit ${pair.shadow.exitCode ?? '?'} output ${pair.shadow.outputBytes ?? '?'} bytes diff ${pair.shadow.diffBytes ?? '?'} bytes`;
  const mismatch = pair.promptShaMismatch ? '  PROMPT SHA MISMATCH' : '';
  const orphan = pair.orphan ? '  [orphan: primary missing]' : '';
  return `${primaryId8} → ${shadowId8}  ${arch}  primary ${primaryInfo}  vs shadow ${shadowInfo}${mismatch}${orphan}`;
}

function formatComparisonArtifact(artifact: ModelComparisonArtifact): string {
  const verdict = artifact.verdict ?? '?';
  const baseline = artifact.baseline ?? '?';
  const challenger = artifact.challenger ?? '?';
  const date = artifact.date ?? '?';
  if (!artifact.valid) return `${artifact.file}: invalid (${artifact.error ?? 'unknown'})`;
  return `${artifact.file}: ${verdict} (baseline ${baseline} vs challenger ${challenger} on ${date})`;
}

export function runDispatchesComparisons(opts: DispatchesComparisonsOptions = {}): DispatchesComparisonsResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const path = DISPATCHES_FILE.split('\\').join('/');
  const comparisonsDir = COMPARISONS_DIR.split('\\').join('/');
  const absolute = join(repoRoot, DISPATCHES_FILE);
  const { entries, skipped, skippedNewerFormat } = loadAllEntries(absolute);

  const primaryById = new Map<string, DispatchEntry>();
  for (const entry of entries) {
    if (!entry.shadow && entry.dispatchId) primaryById.set(entry.dispatchId, entry);
  }

  const pairs: DispatchComparisonPair[] = [];
  for (const entry of entries) {
    if (!entry.shadow) continue;
    const shadowId = entry.dispatchId;
    const primaryId = entry.primaryDispatchId;
    const primary = primaryId ? primaryById.get(primaryId) ?? null : null;
    const orphan = primary == null;
    const promptShaMismatch = !orphan && entry.promptSha256 != null && primary!.promptSha256 != null && entry.promptSha256 !== primary!.promptSha256;
    pairs.push({
      primaryId: primary?.dispatchId ?? primaryId,
      shadowId,
      primaryDispatchId: primaryId,
      archetype: entry.archetype ?? primary?.archetype ?? null,
      primary: {
        dispatchId: primary?.dispatchId ?? primaryId,
        executor: primary?.executor ?? null,
        model: primary?.model ?? null,
        exitCode: primary?.exitCode ?? null,
        outputBytes: primary?.outputBytes ?? null,
        promptSha256: primary?.promptSha256 ?? null,
      },
      shadow: {
        dispatchId: shadowId,
        executor: entry.executor,
        model: entry.model,
        exitCode: entry.exitCode,
        outputBytes: entry.outputBytes,
        diffBytes: entry.diffBytes,
        diffSnapshot: entry.diffSnapshot,
        promptSha256: entry.promptSha256,
      },
      promptShaMismatch: Boolean(promptShaMismatch),
      orphan,
    });
  }

  const { artifacts, skipped: skippedComparisons } = scanComparisons(repoRoot, comparisonsDir);

  const challengers = new Set<string>();
  for (const p of pairs) {
    const name = p.shadow.executor ?? '(unknown)';
    challengers.add(name);
  }
  for (const a of artifacts) {
    if (a.challenger) challengers.add(a.challenger);
  }

  const sortedChallengers = [...challengers].sort();

  const groups: DispatchComparisonGroup[] = [];
  for (const challenger of sortedChallengers) {
    const groupPairs = pairs.filter((p) => (p.shadow.executor ?? '(unknown)') === challenger);
    const groupComparisons = artifacts.filter((a) => a.challenger === challenger);
    const preferChallenger = groupComparisons.filter((a) => a.valid && a.verdict === 'prefer_challenger').length;
    const preferBaseline = groupComparisons.filter((a) => a.valid && a.verdict === 'prefer_baseline').length;
    const tieOrInconclusive = groupComparisons.filter((a) => a.valid && (a.verdict === 'tie' || a.verdict === 'inconclusive')).length;
    groups.push({
      challenger,
      pairs: groupPairs,
      comparisons: groupComparisons,
      tally: {
        pairs: groupPairs.length,
        comparisons: groupComparisons.filter((a) => a.valid).length,
        preferChallenger,
        preferBaseline,
        tieOrInconclusive,
      },
    });
  }

  const totalPairs = pairs.length;
  const totalComparisons = artifacts.filter((a) => a.valid).length;

  const lines: string[] = [];
  if (totalPairs === 0 && totalComparisons === 0) {
    lines.push(`No shadow pairs recorded in ${path}.`);
    if (!existsSync(join(repoRoot, comparisonsDir))) {
      lines.push(`No comparisons found in ${comparisonsDir} (missing).`);
    } else if (artifacts.length === 0) {
      lines.push(`No ModelComparison artifacts in ${comparisonsDir}.`);
    }
  } else {
    for (const group of groups) {
      lines.push(`challenger ${group.challenger}: ${group.tally.pairs} pairs, ${group.tally.comparisons} comparisons: ${group.tally.preferChallenger} prefer_challenger / ${group.tally.preferBaseline} prefer_baseline / ${group.tally.tieOrInconclusive} tie/inconclusive`);
      for (const pair of group.pairs) {
        lines.push(`  ${formatComparisonPair(pair)}`);
      }
      for (const comp of group.comparisons) {
        lines.push(`  ${formatComparisonArtifact(comp)}`);
      }
    }
  }

  const summary = totalPairs === 0 && totalComparisons === 0
    ? `No comparisons to show (${path})`
    : `${totalPairs} shadow pair${totalPairs === 1 ? '' : 's'}, ${totalComparisons} comparison${totalComparisons === 1 ? '' : 's'} across ${groups.length} challenger${groups.length === 1 ? '' : 's'}`;

  return {
    repoRoot,
    path,
    comparisonsDir,
    totalPairs,
    totalComparisons,
    skippedComparisons,
    skipped,
    skippedNewerFormat,
    groups,
    lines,
    summary,
  };
}


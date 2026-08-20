import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
import {
  DISPATCHES_FILE,
  DISPATCHES_FORMAT,
  appendEvidenceRow,
  normalizeDispatchOutcome,
  type DispatchOutcome,
} from './dispatch.ts';
import { INFLIGHT_DIR, readInflightClaim } from '../lib/supervisor.ts';

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
 * steering hook (`kind: "host"`), which has no kernel downstream. A `host`
 * entry may additionally carry a correlated `host_attestation` row — written
 * by `fadeno attest` running INSIDE the subagent itself, folded onto the
 * `attestedAt`/`attestedEffort`/`attestedEffortEvidence` fields rather than
 * becoming an entry of its own (see `correlateAttestation`).
 */
export interface DispatchEntry {
  kind: 'command' | 'host';
  format: string | null;
  legacy: boolean;
  timestamp: string | null;
  dispatchId: string | null;
  archetype: string | null;
  role: string | null;
  agentType: string | null;
  resolution: string | null;
  dial: { model: string; effort?: string; via?: string } | null;
  loadout: string | null;
  loadoutSource: string | null;
  executor: string | null;
  model: string | null;
  modelOverride: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
  driver: string | null;
  target: string | null;
  provider: string | null;
  transport: string | null;
  promptSource: string | null;
  promptSnapshot: string | null;
  promptSha256: string | null;
  relayAttested: boolean | null;
  writeAccess: boolean | null;
  writeVariant: boolean | null;
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
  /**
   * Correlates one pair's rows as a single thing, independent of which arm
   * happens to carry `primary_dispatch_id`. Written on the shadow's request
   * row and refusal rows from the start, and folded onto the primary's own
   * completion row once a challenger actually fires — so a row from before
   * the field existed simply reads null rather than breaking correlation.
   */
  pairId: string | null;
  /**
   * The retained challenger worktree, repo-relative, on a shadow identity
   * row (request or completion). Null on a refusal — the worktree is either
   * never created or removed before the refusal is written — and on a
   * primary, which never places its own worktree on the ledger today. How
   * the post-shadow cleaner (`fadeno clean`) finds a challenger worktree to
   * deregister rather than deleting it out from under git.
   */
  workspace: string | null;
  /**
   * The pair's shared starting-state commit: an addressable commit both arms
   * were cut from, so the baseline is not an implicit asymmetry between them.
   * Present on the shadow's rows and, when a shadow actually fired, on the
   * primary's completion row too.
   */
  baselineCommit: string | null;
  diffSnapshot: string | null;
  diffBytes: number | null;
  outputBytes: number | null;
  diagnosticsSnapshot: string | null;
  diagnosticsBytes: number | null;
  /**
   * Measured from INSIDE the subagent by `fadeno attest` (a `host_attestation`
   * row), correlated onto the `host_delivery` entry it attests — the request
   * that row is a REQUEST recorded by the parent hook before the subagent ran.
   * `attestedAt` is null until (if ever) a matching attestation is found,
   * which is what makes "delivered, never attested" visible rather than
   * indistinguishable from success. Always null on a `command`-kind entry:
   * command dispatch already carries its own kernel-measured completion row.
   * Correlation is archetype + nearest preceding unattested `host_delivery`
   * (see `correlateAttestation`) — a best-effort match, not a guaranteed one.
   */
  attestedAt: string | null;
  /** The attested `CLAUDE_EFFORT`, or null when the attestation itself could not measure one. */
  attestedEffort: string | null;
  /** Whether the matched attestation measured `effort` or said so was `unavailable`; null with no match. */
  attestedEffortEvidence: 'measured' | 'unavailable' | null;
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
  /**
   * Caller-chosen handle passed to `fadeno dispatch --tag`; wins over
   * `dispatchId` when set.
   *
   * The handle a caller can still name after losing everything the dispatch
   * printed. A killed Bash call takes the kernel's stderr echo with it, which
   * left `last` as the only recovery route and `last` cannot tell one finished
   * dispatch from another — so a 2026-08-14 dogfood recovered a concurrent
   * proxy's report. A tag is chosen before the spawn and survives the kill.
   */
  tag?: string | null;
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
 */
function formatTier(value: unknown): 'unversioned' | 'known' | 'older' | 'newer' {
  const format = str(value);
  if (format == null) return 'unversioned';
  const majorStr = format.split('.')[0];
  const known = parseInt(KNOWN_FORMAT_MAJOR, 10);
  const maj = parseInt(majorStr ?? '', 10);
  if (!Number.isFinite(maj) || !Number.isFinite(known)) {
    return majorStr === KNOWN_FORMAT_MAJOR ? 'known' : 'newer';
  }
  if (maj === known) return 'known';
  if (maj > known) return 'newer';
  return 'older';
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

function dialOf(value: unknown): { model: string; effort?: string; via?: string } | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const model = str(row.model);
  if (model == null) return null;
  const out: { model: string; effort?: string; via?: string } = { model };
  const eff = str(row.effort);
  if (eff != null) out.effort = eff;
  const via = str(row.via);
  if (via != null) out.via = via;
  return out;
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
    dial: dialOf(row.dial),
    loadout: loadout.name,
    loadoutSource: loadout.source,
    executor: str(row.executor),
    model: str(row.model),
    modelOverride: null,
    modelId: str(row.model_id),
    reasoningEffort: str(row.reasoning_effort),
    driver: str(row.driver),
    target: str(row.target),
    provider: str(row.provider),
    transport: str(row.transport),
    promptSource: str(row.prompt_source),
    promptSnapshot: str(row.prompt_snapshot),
    promptSha256: str(row.prompt_sha256),
    relayAttested: bool(row.relay_attested),
    writeAccess: bool(row.write_access),
    writeVariant: bool(row.write_variant),
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
    pairId: str(row.pair_id),
    workspace: str(row.workspace),
    baselineCommit: str(row.baseline_commit),
    diffSnapshot: str(row.diff_snapshot),
    diffBytes: num(row.diff_bytes),
    outputBytes: num(row.output_bytes),
    diagnosticsSnapshot: str(row.diagnostics_snapshot),
    diagnosticsBytes: num(row.diagnostics_bytes),
    // Attestation only ever correlates onto a `host` entry (see
    // `correlateAttestation`); a command dispatch's own completion row is
    // already a kernel measurement, so these stay null for its whole life.
    attestedAt: null,
    attestedEffort: null,
    attestedEffortEvidence: null,
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
    dial: dialOf(row.dial),
    loadout: loadout.name,
    loadoutSource: loadout.source,
    executor: str(row.executor),
    model: str(row.model),
    modelOverride: str(row.model_override),
    modelId: str(row.model_id),
    reasoningEffort: str(row.reasoning_effort),
    driver: str(row.driver),
    target: null,
    provider: null,
    transport: str(row.transport),
    promptSource: null,
    promptSnapshot: str(row.prompt_snapshot),
    promptSha256: str(row.prompt_sha256),
    relayAttested: null,
    writeAccess: null,
    writeVariant: null,
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
    pairId: null,
    workspace: null,
    baselineCommit: null,
    diffSnapshot: null,
    diffBytes: null,
    outputBytes: null,
    diagnosticsSnapshot: null,
    diagnosticsBytes: null,
    // Unattested until a later `host_attestation` row correlates onto this
    // one — see `correlateAttestation`, called from the main read loop below.
    attestedAt: null,
    attestedEffort: null,
    attestedEffortEvidence: null,
  };
}

/**
 * Correlate a `host_attestation` row (written by `fadeno attest`, running
 * INSIDE the subagent) onto the `host_delivery` entry it measures.
 *
 * The hard part, stated honestly: the subagent has neither the parent's
 * prompt digest (injecting one into the prompt would make prompt bytes vary
 * per spawn, which shadow pairs depend on NOT happening — see
 * `runAttest` in `src/commands/attest.ts`) nor the parent's session id (its
 * own differs). Archetype plus append order is all that is left, so this
 * matches the NEAREST PRECEDING entry of `kind: 'host'` with the same
 * archetype that no earlier attestation has already claimed — scanning
 * backward through everything read so far, oldest match wins ties by being
 * found last.
 *
 * Precision limits, plainly: two host deliveries of the SAME archetype that
 * both go unattested, followed by one attestation, correlate that
 * attestation to the more recent of the two — which is usually right (the
 * subagent that just ran is more likely to be the one attesting) but is a
 * heuristic, not a proof. An attestation with no preceding unattested
 * `host_delivery` of its archetype at all (attest run twice for one
 * delivery, or run outside a steered host spawn entirely) matches nothing
 * and is silently dropped — it is real evidence that fadeno attest ran, but
 * evidence of nothing THIS reader can render as a dispatch, so it is neither
 * folded into an entry nor counted as an unreadable row.
 */
function correlateAttestation(entries: readonly DispatchEntry[], row: Record<string, unknown>): void {
  const archetype = str(row.archetype);
  if (archetype == null) return; // cannot correlate without knowing what it claims to be
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const candidate = entries[i]!;
    if (candidate.kind !== 'host') continue;
    if (candidate.archetype !== archetype) continue;
    if (candidate.attestedAt != null) continue; // already claimed by an earlier attestation
    candidate.attestedAt = str(row.timestamp);
    candidate.attestedEffort = str(row.effort);
    const evidence = str(row.effort_evidence);
    candidate.attestedEffortEvidence = evidence === 'measured' || evidence === 'unavailable' ? evidence : null;
    return;
  }
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
  entry.relayAttested = entry.relayAttested ?? bool(row.relay_attested);
  entry.writeAccess = entry.writeAccess ?? bool(row.write_access);
  entry.writeVariant = entry.writeVariant ?? bool(row.write_variant);
  entry.model = entry.model ?? str(row.model);
  entry.modelId = entry.modelId ?? str(row.model_id);
  entry.driver = entry.driver ?? str(row.driver);
  entry.reasoningEffort = entry.reasoningEffort ?? str(row.reasoning_effort);
  entry.dial = entry.dial ?? dialOf(row.dial);
  entry.executor = entry.executor ?? str(row.executor);
  if (row.gate_eligible === false) entry.gateEligible = false;
  if (entry.refusal == null) entry.refusal = refusalOf(row.refusal);
  // Shadow and output fields may arrive on either row; completion wins where
  // request was silent, mirroring the identity fallback above.
  if (row.shadow === true) entry.shadow = true;
  entry.primaryDispatchId = entry.primaryDispatchId ?? str(row.primary_dispatch_id);
  entry.shadowSource = entry.shadowSource ?? str(row.shadow_source);
  entry.pairId = entry.pairId ?? str(row.pair_id);
  entry.workspace = entry.workspace ?? str(row.workspace);
  entry.baselineCommit = entry.baselineCommit ?? str(row.baseline_commit);
  entry.diffSnapshot = entry.diffSnapshot ?? str(row.diff_snapshot);
  const db = num(row.diff_bytes);
  if (db != null) entry.diffBytes = db;
  const ob = num(row.output_bytes);
  if (ob != null) entry.outputBytes = ob;
  entry.diagnosticsSnapshot = entry.diagnosticsSnapshot ?? str(row.diagnostics_snapshot);
  const diagb = num(row.diagnostics_bytes);
  if (diagb != null) entry.diagnosticsBytes = diagb;
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
  const roleSlot = entry.role ?? (entry.agentType !== entry.archetype ? entry.agentType : null);
  const who = `${entry.archetype ?? '(none)'}${roleSlot != null ? `/${roleSlot}` : ''}`;
  const model =
    entry.modelOverride != null
      ? `${entry.model ?? '?'} → ${entry.modelOverride}`
      : entry.model;
  parts.push(
    `${who} → ${entry.executor ?? '(unresolved)'}${model != null ? ` (${model})` : ''}`,
  );
  const via = entry.driver ?? entry.transport;
  if (via != null) parts.push(`via ${via}`);
  if (entry.shadow) {
    const pid8 = entry.primaryDispatchId ? entry.primaryDispatchId.slice(0, 8) : '?';
    parts.push(`[shadow of ${pid8}]`);
  }
  // Resolution provenance marks for session/repo/user (base/binding silent)
  if (entry.resolution === 'session') parts.push('[session dial]');
  else if (entry.resolution === 'repo') parts.push('[repo pin]');
  else if (entry.resolution === 'user') parts.push('[user dial]');

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
  } else if (entry.kind === 'host') {
    if (entry.attestedAt == null) {
      // The gap this whole feature closes: a host_delivery is a REQUEST the
      // parent's steering hook recorded before the subagent ever ran, and
      // running `fadeno attest` is only tier-1/advisory — an agent may not
      // comply. An unattested row must read as visibly unconfirmed rather
      // than look identical to a measured, successful one.
      parts.push('[never attested]');
    } else if (
      entry.reasoningEffort != null &&
      entry.reasoningEffort !== 'inherited' &&
      entry.attestedEffort != null &&
      entry.reasoningEffort !== entry.attestedEffort
    ) {
      // The signature of a silent downgrade: the harness resolves a turn's
      // effort AFTER any per-model/per-org cap, so a dial asking for xhigh
      // can land lower with nothing raised on the request-side row. A shadow
      // pair spanning this row is not a comparison of equals.
      parts.push(`[effort mismatch: requested ${entry.reasoningEffort}, attested ${entry.attestedEffort}]`);
    } else {
      parts.push(`[attested: effort ${entry.attestedEffort ?? 'unmeasured'}]`);
    }
  }

  if (entry.relayAttested != null) parts.push(`[relay_attested: ${entry.relayAttested}]`);
  if (entry.writeVariant === true) parts.push('[write variant]');
  if (entry.writeAccess === false) parts.push('[write_access: none]');
  if (entry.gateEligible === false) parts.push('[shadow-only]');
  if (entry.error != null) parts.push(`[error: ${excerpt(entry.error, ERROR_EXCERPT)}]`);
  if (entry.promptSnapshot != null) parts.push(entry.promptSnapshot);
  if (entry.legacy) parts.push('[legacy]');
  if (entry.format != null && formatTier(entry.format) === 'older') parts.push(`[format ${entry.format}]`);
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
    if (event === 'host_attestation') {
      // Not its own entry: this row measures a PRECEDING host_delivery, so
      // it folds onto that entry rather than rendering as a dispatch of its
      // own — see `correlateAttestation`'s doc comment for what "nearest
      // preceding" means and its precision limits.
      correlateAttestation(entries, row);
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
  /**
   * Whether this is a shadow duplication. Shadows stay recoverable and
   * cancellable by explicit id, but are never candidates for `last`: the
   * caller asking "which dispatch was mine?" launched the primary — the
   * kernel launched the shadow. They are also excluded from the concurrency
   * refusals, because a shadow overlaps its own primary by design.
   */
  shadow: boolean;
  /** Caller-chosen `--tag`, when this dispatch was launched with one. */
  tag: string | null;
  /** Epoch ms of the request row; the start of this dispatch's lifetime. */
  requestedAt: number | null;
  /**
   * Epoch ms this dispatch actually ended; `null` while still open.
   *
   * Still derived as `requestedAt + duration_ms` rather than read from the
   * completion row's `timestamp`, even though the kernel now stamps that row
   * with the real end time. The log is append-only and long-lived: every row
   * written before that fix carries the dispatch's *start* in both rows, so
   * trusting the stamp would collapse those dispatches to zero length and stop
   * detecting the overlaps this exists to catch. The two agree on new rows by
   * construction; on old ones only the derivation is right.
   */
  completedAt: number | null;
}

/** Whether two dispatches were ever in flight at the same moment. */
function overlaps(a: OutputRecord, b: OutputRecord): boolean {
  const start = (rec: OutputRecord): number => rec.requestedAt ?? Number.NEGATIVE_INFINITY;
  // An open dispatch has not ended, so it overlaps everything after it began.
  const end = (rec: OutputRecord): number => rec.completedAt ?? Number.POSITIVE_INFINITY;
  return start(a) < end(b) && start(b) < end(a);
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
  /**
   * Dispatch ids in the order their request rows appeared — snapshots only,
   * primaries only (see `OutputRecord.shadow`).
   */
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
      rec = {
        dispatchId,
        snapshot: null,
        outputSha256: null,
        completed: false,
        shadow: false,
        tag: null,
        requestedAt: null,
        completedAt: null,
      };
      byId.set(dispatchId, rec);
    }
    if (row.shadow === true) rec.shadow = true;
    const snapshot = str(row.output_snapshot);
    if (snapshot != null) rec.snapshot = snapshot;
    const tag = str(row.tag);
    if (tag != null) rec.tag = tag;
    const stamp = str(row.timestamp);
    const at = stamp == null ? Number.NaN : Date.parse(stamp);
    if (event === 'dispatch_requested' && snapshot != null) {
      if (row.shadow !== true) {
        lastWithSnapshot = dispatchId;
        requestOrder.push(dispatchId);
      }
      if (!Number.isNaN(at)) rec.requestedAt = at;
    }
    if (event === 'dispatch_completed') {
      rec.completed = true;
      rec.outputSha256 = str(row.output_sha256);
      const duration = typeof row.duration_ms === 'number' ? row.duration_ms : null;
      // Prefer start + duration; fall back to the row's own stamp for legacy
      // rows written before `duration_ms`, where it is the best available.
      rec.completedAt =
        rec.requestedAt != null && duration != null
          ? rec.requestedAt + duration
          : Number.isNaN(at)
            ? null
            : at;
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
export type OutputResolution = 'id' | 'tag' | 'in-flight' | 'recency';

/** How a caller should name its own dispatch, once `last` has proved unsafe. */
const NAME_YOURS =
  'Name yours: `--tag <handle>` if you launched with one, otherwise the id the ' +
  'kernel echoed as `dispatch id: <id>` at spawn.';

/**
 * Resolve a caller-chosen handle. A tag is not required to be unique — nothing
 * stops two callers picking `retry` — so a reused one is refused rather than
 * silently resolved to the newest, which is the failure this whole path exists
 * to end.
 */
function resolveByTag(
  tag: string,
  byId: Map<string, OutputRecord>,
  requestOrder: readonly string[],
): { record: OutputRecord; resolvedBy: OutputResolution } {
  const hits = requestOrder.map((id) => byId.get(id)!).filter((rec) => rec.tag === tag);
  if (hits.length === 0) {
    const known = [...new Set([...byId.values()].map((rec) => rec.tag).filter((t) => t != null))];
    throw new DispatchesCommandError(
      `no dispatch carries the tag "${tag}".` +
        (known.length > 0 ? ` Tags in this log: ${known.join(', ')}.` : ' No dispatch in this log was launched with a tag.'),
    );
  }
  if (hits.length > 1) {
    throw new DispatchesCommandError(
      `ambiguous tag "${tag}": ${hits.length} dispatches carry it ` +
        `(${hits.map((rec) => rec.dispatchId.slice(0, 8)).join(', ')}). ` +
        'Use a distinct tag per dispatch, or name the id.',
    );
  }
  return { record: hits[0]!, resolvedBy: 'tag' };
}

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
          NAME_YOURS,
      );
    }
    // Nothing open, so every candidate has finished and "which one is mine?"
    // can no longer be answered by state. Recency is only safe when this
    // dispatch ran alone: a 2026-08-14 dogfood recovered a *concurrent* proxy's
    // report here, because both had completed by the time either looked. The
    // note that flagged it was in-band and the agent consumed it anyway — a
    // wrong answer with a caveat is still a wrong answer. Refuse instead.
    const newest = byId.get(lastWithSnapshot)!;
    const concurrent = requestOrder
      .filter((id) => id !== newest.dispatchId)
      .map((id) => byId.get(id)!)
      .filter((rec) => overlaps(rec, newest));
    if (concurrent.length > 0) {
      const describe = (rec: OutputRecord): string =>
        rec.tag != null ? `${rec.dispatchId.slice(0, 8)} (tag: ${rec.tag})` : rec.dispatchId.slice(0, 8);
      throw new DispatchesCommandError(
        `ambiguous dispatch "last": ${concurrent.length + 1} dispatches ran concurrently and all ` +
          `have finished (${[newest, ...concurrent].map(describe).join(', ')}), so the newest is ` +
          `not necessarily yours. ${NAME_YOURS}`,
      );
    }
    return { record: newest, resolvedBy: 'recency' };
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
  const tag = opts.tag?.trim() ? opts.tag.trim() : null;
  const query = opts.dispatchId.trim();
  if (tag == null && query === '') {
    throw new DispatchesCommandError(
      'dispatch id is required (full id, unique prefix of 8+ characters, "last", or --tag <handle>).',
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const ledger = join(repoRoot, DISPATCHES_FILE);
  let { byId, lastWithSnapshot, requestOrder } = loadOutputRecords(ledger);
  let rec: OutputRecord;
  let resolvedBy: OutputResolution;
  if (tag != null) {
    ({ record: rec, resolvedBy } = resolveByTag(tag, byId, requestOrder));
  } else {
    ({ record: rec, resolvedBy } = resolveOutputRecord(query, byId, lastWithSnapshot, requestOrder));
  }

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
    durationMs: number | null;
    promptSha256: string | null;
    /**
     * Set whenever the primary's own completion row carries `diff_snapshot`/
     * `diff_bytes` — today that means an `--isolate`d primary, whose diff was
     * already reaching `DispatchEntry` but being dropped on the floor here.
     * The struct is symmetric with `shadow` on purpose: the moment a
     * non-isolated primary also gets a retained worktree, this field is
     * already the place that data lands.
     */
    diffBytes: number | null;
    diffSnapshot: string | null;
    /** Repo-relative retained worktree path, when the primary has one. */
    workspace: string | null;
    /** The pair's shared starting-state commit; same value as `shadow`'s. */
    baselineCommit: string | null;
  };
  shadow: {
    dispatchId: string | null;
    executor: string | null;
    model: string | null;
    exitCode: number | null;
    outputBytes: number | null;
    durationMs: number | null;
    diffBytes: number | null;
    diffSnapshot: string | null;
    promptSha256: string | null;
    /**
     * Present when the shadow never ran — capacity, eligibility, write
     * posture, a constraint refusal, or a baseline that could not be
     * snapshotted. A refused arm has no exit code, duration, or output: it
     * must render as refused, not as a challenger that measured empty.
     */
    refusal: { predicate: string; message: string } | null;
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
    if (event === 'host_attestation') {
      // Same fold-onto-the-preceding-entry rule as the main reader above —
      // never its own entry, never counted as unreadable (see
      // `correlateAttestation`).
      correlateAttestation(entries, row);
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

export interface RetainedShadowWorktree {
  dispatchId: string | null;
  /** Repo-relative worktree path, as recorded in the ledger's `workspace` field. */
  workspace: string;
  pairId: string | null;
  baselineCommit: string | null;
}

/**
 * Every shadow challenger worktree the ledger's `workspace` field still names
 * (see `DispatchEntry.workspace`) — the retained work product of a shadow
 * pair, kept for later judgment rather than cleaned up when the pair
 * finishes. This is how `fadeno clean` finds a registered git worktree to
 * deregister with `git worktree remove` before it deletes `.fadeno/local`,
 * instead of pulling the directory out from under git and leaving a stale
 * entry in `.git/worktrees`.
 *
 * Reads the whole log, not just the default tail: a worktree from ten
 * dispatches ago is exactly as retained, and exactly as much a cleanup
 * target, as one from the last row.
 */
export function listRetainedShadowWorktrees(opts: { cwd?: string; repoRoot?: string } = {}): RetainedShadowWorktree[] {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { entries } = loadAllEntries(join(repoRoot, DISPATCHES_FILE));
  const out: RetainedShadowWorktree[] = [];
  for (const entry of entries) {
    if (!entry.shadow || entry.workspace == null) continue;
    out.push({
      dispatchId: entry.dispatchId,
      workspace: entry.workspace,
      pairId: entry.pairId,
      baselineCommit: entry.baselineCommit,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shadow pair resolution (for `fadeno shadow-apply`)
// ---------------------------------------------------------------------------

export interface ResolvedDispatchPair {
  pairId: string;
  /** The non-shadow arm's entry, or null when this log lacks its rows. */
  primary: DispatchEntry | null;
  /** The shadow arm's entry, or null when this log lacks its rows. */
  shadow: DispatchEntry | null;
}

export interface ResolveDispatchPairOptions {
  cwd?: string;
  repoRoot?: string;
}

/**
 * Resolve a caller-given `pair_id` or either arm's `dispatch_id` (full, or an
 * 8+ character prefix — the read-side convention `resolveOutputRecord` above
 * already established) to the shadow pair it names. Built for
 * `fadeno shadow-apply <pair-id|dispatch-id>`.
 *
 * Reads the WHOLE log, like `listRetainedShadowWorktrees`: a pair from ten
 * dispatches ago is exactly as applicable as one from the last row, and the
 * default `--tail` view must never silently hide it from this lookup.
 *
 * `pair_id` and `dispatch_id` are drawn from the same `randomUUID()` space
 * (see dispatch.ts), so an exact match is always checked, on both axes,
 * before any prefix matching is attempted — exactness never loses to a
 * shorter, coincidentally-matching prefix on the other axis.
 */
export function resolveDispatchPair(
  query: string,
  opts: ResolveDispatchPairOptions = {},
): ResolvedDispatchPair {
  const trimmed = query.trim();
  if (trimmed === '') {
    throw new DispatchesCommandError('name a pair id or dispatch id (full, or an 8+ character prefix).');
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { entries } = loadAllEntries(join(repoRoot, DISPATCHES_FILE));

  const primaryByPairId = new Map<string, DispatchEntry>();
  const primaryById = new Map<string, DispatchEntry>();
  const shadowByPairId = new Map<string, DispatchEntry>();
  const shadowById = new Map<string, DispatchEntry>();
  for (const entry of entries) {
    if (entry.shadow) {
      if (entry.dispatchId != null) shadowById.set(entry.dispatchId, entry);
      if (entry.pairId != null) shadowByPairId.set(entry.pairId, entry);
    } else {
      if (entry.dispatchId != null) primaryById.set(entry.dispatchId, entry);
      if (entry.pairId != null) primaryByPairId.set(entry.pairId, entry);
    }
  }

  const pairFor = (pairId: string): ResolvedDispatchPair => ({
    pairId,
    primary: primaryByPairId.get(pairId) ?? null,
    shadow: shadowByPairId.get(pairId) ?? null,
  });

  if (primaryByPairId.has(trimmed) || shadowByPairId.has(trimmed)) return pairFor(trimmed);

  const exactDispatch = shadowById.get(trimmed) ?? primaryById.get(trimmed);
  if (exactDispatch != null) {
    if (exactDispatch.pairId == null) {
      throw new DispatchesCommandError(
        `dispatch "${trimmed.slice(0, 8)}" is not part of any recorded shadow pair (its evidence carries no pair_id).`,
      );
    }
    return pairFor(exactDispatch.pairId);
  }

  if (trimmed.length < OUTPUT_ID_PREFIX_MIN) {
    throw new DispatchesCommandError(
      `unknown pair or dispatch "${trimmed}" (no exact match, and a prefix must be at least ${OUTPUT_ID_PREFIX_MIN} characters).`,
    );
  }

  // Prefix match: a hit can name a pair either directly (its pair_id) or
  // through one of its arms' dispatch_ids. Collected as a SET of resolved
  // pair ids so a prefix that happens to match both a pair's own id and one
  // of its arms' ids does not falsely read as ambiguous.
  const matchedPairIds = new Set<string>();
  for (const id of primaryByPairId.keys()) if (id.startsWith(trimmed)) matchedPairIds.add(id);
  for (const id of shadowByPairId.keys()) if (id.startsWith(trimmed)) matchedPairIds.add(id);
  const unpaired: DispatchEntry[] = [];
  for (const [id, entry] of [...primaryById, ...shadowById]) {
    if (!id.startsWith(trimmed)) continue;
    if (entry.pairId != null) matchedPairIds.add(entry.pairId);
    else unpaired.push(entry);
  }

  if (matchedPairIds.size === 0 && unpaired.length === 0) {
    throw new DispatchesCommandError(`unknown pair or dispatch prefix "${trimmed}".`);
  }
  if (matchedPairIds.size === 0) {
    // Every hit named a real dispatch, just not one that is part of a pair.
    const names = unpaired.map((e) => (e.dispatchId ?? '?').slice(0, 8)).join(', ');
    throw new DispatchesCommandError(
      `"${trimmed}" matches dispatch${unpaired.length === 1 ? '' : 'es'} ${names}, but ` +
        `${unpaired.length === 1 ? 'it is' : 'none are'} part of a recorded shadow pair.`,
    );
  }
  if (matchedPairIds.size > 1) {
    throw new DispatchesCommandError(
      `ambiguous prefix "${trimmed}": matches ${matchedPairIds.size} distinct pairs ` +
        `(${[...matchedPairIds].map((p) => p.slice(0, 8)).join(', ')}). Use a longer prefix or the full id.`,
    );
  }
  return pairFor([...matchedPairIds][0]!);
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

/**
 * Runtime for the comparison scorecard. Time-to-complete is itself a point of
 * comparison between baseline and challenger, so it reads as a human quantity
 * (`42.3s`, `5m12s`) rather than the raw ms the rows carry.
 */
function formatComparisonDuration(ms: number | null): string {
  if (ms == null) return '?';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function formatComparisonPair(pair: DispatchComparisonPair): string {
  const primaryId8 = pair.primaryId ? pair.primaryId.slice(0, 8) : '?';
  const shadowId8 = pair.shadowId ? pair.shadowId.slice(0, 8) : '?';
  const arch = pair.archetype ?? '(none)';
  // Only rendered when the primary actually has a diff on its own completion
  // row (today, an --isolated primary) — most primaries share the workspace
  // and have no diff concept at all, so "diff ? bytes" would read as a
  // missing value rather than a not-applicable one.
  const primaryDiff = pair.primary.diffBytes != null ? ` diff ${pair.primary.diffBytes} bytes` : '';
  const primaryInfo = `${pair.primary.executor ?? '(unresolved)'} (${pair.primary.model ?? '?'}) exit ${pair.primary.exitCode ?? '?'} in ${formatComparisonDuration(pair.primary.durationMs)} output ${pair.primary.outputBytes ?? '?'} bytes${primaryDiff}`;
  // A refused shadow never ran: exit code, duration, and output are all
  // absent, and rendering them as "?" would read as a challenger that
  // measured empty rather than one that was never allowed to fire. Name the
  // predicate instead — this is the whole reason the refusal was worth a row.
  const shadowInfo = pair.shadow.refusal != null
    ? `refused [${pair.shadow.refusal.predicate}]: ${pair.shadow.refusal.message}`
    : `${pair.shadow.executor ?? '(unresolved)'} (${pair.shadow.model ?? '?'}) exit ${pair.shadow.exitCode ?? '?'} in ${formatComparisonDuration(pair.shadow.durationMs)} output ${pair.shadow.outputBytes ?? '?'} bytes diff ${pair.shadow.diffBytes ?? '?'} bytes`;
  const mismatch = pair.promptShaMismatch ? '  PROMPT SHA MISMATCH' : '';
  const orphan = pair.orphan ? '  [orphan: primary missing]' : '';
  const baseline = pair.primary.baselineCommit != null ? `  [baseline ${pair.primary.baselineCommit.slice(0, 8)}]` : '';
  const workspace = pair.primary.workspace != null ? `  [primary workspace: ${pair.primary.workspace}]` : '';
  return `${primaryId8} → ${shadowId8}  ${arch}  primary ${primaryInfo}  vs shadow ${shadowInfo}${mismatch}${orphan}${baseline}${workspace}`;
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
  // `pair_id` is the addressable correlation from the start (see
  // `DispatchEntry.pairId`); it lands on the primary's own row only once a
  // shadow actually fires, via its completion row. Rows written before the
  // field existed carry none, so this map is a preference, not a
  // replacement — `primaryById` below stays the fallback for them.
  const primaryByPairId = new Map<string, DispatchEntry>();
  for (const entry of entries) {
    if (entry.shadow) continue;
    if (entry.dispatchId) primaryById.set(entry.dispatchId, entry);
    if (entry.pairId) primaryByPairId.set(entry.pairId, entry);
  }

  const pairs: DispatchComparisonPair[] = [];
  for (const entry of entries) {
    if (!entry.shadow) continue;
    const shadowId = entry.dispatchId;
    const primaryId = entry.primaryDispatchId;
    const primary =
      (entry.pairId != null ? primaryByPairId.get(entry.pairId) : undefined) ??
      (primaryId != null ? primaryById.get(primaryId) : undefined) ??
      null;
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
        durationMs: primary?.durationMs ?? null,
        promptSha256: primary?.promptSha256 ?? null,
        diffBytes: primary?.diffBytes ?? null,
        diffSnapshot: primary?.diffSnapshot ?? null,
        workspace: primary?.workspace ?? null,
        baselineCommit: primary?.baselineCommit ?? entry.baselineCommit ?? null,
      },
      shadow: {
        dispatchId: shadowId,
        executor: entry.executor,
        model: entry.model,
        exitCode: entry.exitCode,
        outputBytes: entry.outputBytes,
        durationMs: entry.durationMs,
        diffBytes: entry.diffBytes,
        diffSnapshot: entry.diffSnapshot,
        promptSha256: entry.promptSha256,
        refusal: entry.refusal,
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


/**
 * Cancel a running dispatch.
 *
 * The gap this closes, reported 2026-08-14: a proxy correctly refuses to fold
 * a mid-flight amendment into a live dispatch, because a second executor would
 * race the first on the same files. But with no way to *stop* the first, a
 * corrected instruction had no path at all — not amendable, not safely
 * re-dispatchable, not abortable. Roughly half of dispatches outlive the
 * caller's 600s window, so this is the common case rather than the corner.
 *
 * Delivering the amendment itself is not possible and is not attempted: every
 * driver is a one-shot CLI that read its whole prompt from a stdin that has
 * since closed. Cancel makes the honest path — abort, then re-dispatch with
 * the corrected prompt — deterministic instead of a race.
 *
 * The kernel still writes the completion row: killing the supervisor unblocks
 * its `spawnSync`, which reports the signal exactly as any other terminal
 * state. The `dispatch_cancelled` row added here records who asked and when,
 * and never stands in for that completion.
 */
/**
 * Record that a cancellation was *requested*. Deliberately not a terminal
 * event: the kernel still owns the completion row, and this row says only that
 * a signal was sent — which is the one thing this process actually witnessed.
 */
function appendCancellationRow(repoRoot: string, fields: Record<string, unknown>, now: Date): void {
  appendEvidenceRow(repoRoot, {
    format: DISPATCHES_FORMAT,
    timestamp: now.toISOString(),
    event: 'dispatch_cancelled',
    ...fields,
  });
}

export interface DispatchesCancelOptions {
  /** Full id or an 8+ character prefix; ignored when `tag` is given. */
  dispatchId?: string;
  tag?: string | null;
  repoRoot?: string;
  cwd?: string;
  /** Test seam for the signal itself. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam for supervisor/executor process liveness. */
  probe?: (pid: number, signal: 0) => void;
  now?: Date;
}

export interface DispatchesCancelResult {
  dispatchId: string;
  tag: string | null;
  /** Supervisor process signalled. */
  pid: number;
  resolvedBy: OutputResolution;
}

export function runDispatchesCancel(opts: DispatchesCancelOptions = {}): DispatchesCancelResult {
  const tag = opts.tag?.trim() ? opts.tag.trim() : null;
  const query = (opts.dispatchId ?? '').trim();
  if (tag == null && query === '') {
    throw new DispatchesCommandError(
      'name what to cancel: a dispatch id, an 8+ character prefix, or tag:<handle>.',
    );
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const { byId, lastWithSnapshot, requestOrder } = loadOutputRecords(join(repoRoot, DISPATCHES_FILE));
  const { record, resolvedBy } =
    tag != null
      ? resolveByTag(tag, byId, requestOrder)
      : resolveOutputRecord(query, byId, lastWithSnapshot, requestOrder);

  const claimPath = join(repoRoot, ...INFLIGHT_DIR.split('/'), `${record.dispatchId}.json`);
  const claim = readInflightClaim(claimPath, (path) => readFileSync(path, 'utf8'));
  // A normal terminal dispatch has no claim and is not cancellable. A
  // reportless/SIGKILLed supervisor is different: the kernel may have written
  // a failed completion row while deliberately preserving the claim because
  // its detached executor group is still alive.
  if (record.completed && claim == null) {
    throw new DispatchesCommandError(
      `dispatch ${record.dispatchId.slice(0, 8)} has already completed — nothing to cancel. ` +
        `Read what it produced with \`fadeno dispatches --output ${
          record.tag != null ? `tag:${record.tag}` : record.dispatchId.slice(0, 8)
        }\`.`,
    );
  }
  if (claim == null) {
    // Open in the ledger but unclaimed on this machine: the kernel died
    // without writing a completion row, or the dispatch belongs to another
    // host. Either way there is no process here to signal, and saying
    // "cancelled" would be a claim about work this call did not touch.
    throw new DispatchesCommandError(
      `dispatch ${record.dispatchId.slice(0, 8)} has no running executor on this machine ` +
        '(no in-flight claim), yet its evidence shows no completion. Nothing was signalled. ' +
        'Check the workspace before re-dispatching — an executor killed with its kernel can ' +
        'have left work behind.',
    );
  }

  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const probe = opts.probe ?? ((pid: number, signal: 0) => { process.kill(pid, signal); });
  const alive = (pid: number): boolean => {
    try { probe(pid, 0); return true; }
    catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  const supervisorPid = claim.supervisorPid ?? claim.pid;
  // Preserve the simple injected-kill test seam unless it also supplies a
  // liveness probe. Production probes the supervisor first, then falls back to
  // the detached executor group left by a SIGKILLed supervisor.
  const targetPid = (opts.kill != null && opts.probe == null) || alive(supervisorPid)
    ? supervisorPid
    : claim.processGroupId != null && alive(-claim.processGroupId)
      ? -claim.processGroupId
      : claim.executorPid != null && alive(claim.executorPid)
        ? claim.executorPid
        : null;
  if (targetPid == null) {
    throw new DispatchesCommandError(
      `dispatch ${record.dispatchId.slice(0, 8)} has a stale in-flight claim but no live supervisor or executor group. ` +
        'Nothing was signalled; retrying may first require stale-state recovery.',
    );
  }
  try {
    // SIGTERM, never SIGKILL: the supervisor catches it and reaps the
    // executor's whole process group, then escalates on its own schedule.
    // SIGKILL here would leave exactly the orphan the supervisor exists for.
    kill(targetPid, 'SIGTERM');
  } catch (err) {
    throw new DispatchesCommandError(
      `could not signal the executor for ${record.dispatchId.slice(0, 8)} (pid ${targetPid}): ` +
        `${(err as Error).message}`,
    );
  }

  appendCancellationRow(repoRoot, {
    dispatch_id: record.dispatchId,
    ...(record.tag != null ? { tag: record.tag } : {}),
    supervisor_pid: supervisorPid,
    ...(targetPid < 0 ? { process_group_id: -targetPid } : {}),
    ...(claim.startedAt != null ? { executor_started_at: claim.startedAt } : {}),
  }, opts.now ?? new Date());

  return { dispatchId: record.dispatchId, tag: record.tag, pid: targetPid, resolvedBy };
}

/**
 * Command-lane progress visibility.
 *
 * Every engine actor prompt tells its agent to keep a cooperative status
 * sidecar (`prompt.ts:93` builds the command-lane path and `prompt.ts:259`
 * writes the instruction into the prompt).
 * Until now nothing on the reading side ever opened one for a command-lane
 * attempt: the sidecar was written into the attempt's workspace — an isolated
 * worktree, most of the time — and left there. The host lane had a path for it
 * (`fadeno dispatch-progress` takes the file and appends a ledger receipt) but
 * that path is a HOST action; a command attempt has no host to run it, so its
 * agent's own account of what it was doing was invisible for the whole run and
 * a reporter had nothing but byte counters to describe a live attempt with.
 *
 * The supervisor is the only process positioned to close that: it is alive for
 * exactly as long as the executor is, it already publishes a per-second claim
 * file, and it runs with the attempt workspace as its cwd. So it mirrors the
 * sidecar into the claim on each heartbeat and the readers below turn that
 * into something a person can act on.
 *
 * Two rules hold throughout. The mirror is HARNESS-OBSERVED, like everything
 * else on the claim: it lives under `.fadeno/local/`, it is never ledger
 * evidence, and it never gates. And it is the AGENT's own account, not a
 * measurement — `source: 'agent'` says so on every record, because "the agent
 * says it is writing tests" and "the kernel observed 40KB of output" are
 * different kinds of claim and a reader must never confuse them.
 */

import { basename } from 'node:path';
import { progressSidecarPath } from './prompt.ts';

/**
 * What the agent said about itself, as mirrored onto a claim.
 *
 * `state`, `phase` and `current` are nullable because the sidecar is written
 * by an agent following a prompt, not by a validator: a half-filled file is
 * the normal case, not an error, and dropping the whole record because
 * `phase` was omitted would throw away the part that did arrive.
 */
export interface AttemptProgress {
  /** `running` | `waiting_input` | `blocked` | `idle`, as the agent spelled it. */
  state: string | null;
  phase: string | null;
  current: string | null;
  /** The agent's own timestamp. Required — a progress record with no time is not evidence of progress. */
  updatedAt: string;
  /** Always `agent`: this is a self-report, never a measurement. */
  source: 'agent';
}

/**
 * The claim-file fields the supervisor mirrors, in the camelCase spelling
 * `readInflightClaim` parses them into. Kept structural (every field
 * optional) so a caller can hand in a whole `InflightClaim` without this
 * module having to import the supervisor and make the dependency circular.
 */
export interface ClaimProgressFields {
  progressState?: string | null;
  progressPhase?: string | null;
  progressCurrent?: string | null;
  progressUpdatedAt?: string | null;
  progressSource?: string | null;
}

/**
 * Where a COMMAND-LANE attempt's cooperative sidecar lives, relative to the
 * attempt's workspace root.
 *
 * Delegates to the prompt's own spelling rather than restating it, because the
 * producer and the consumer of this path must agree character for character
 * and a drift would not error anywhere: the supervisor would simply find no
 * file and report a working agent as silent — the invisible wrong answer this
 * whole path exists to remove.
 *
 * There are TWO sidecar spellings in the engine and they belong to different
 * lanes. A command-lane attempt is prompted by `runPrompt` → `renderStepPrompt`
 * (`prompt.ts:259`), which names `<run>/<step>--<actor>.json`. The
 * `<run>/<step_execution_id>.json` form at `drive.ts:3096` is built by
 * `assembleCompositePrompt`, which refuses any binding whose adapter is not
 * `host` (`drive.ts:3166`) — so no supervised process ever sees it. The
 * supervisor runs command-lane attempts only, so this is the one it watches.
 */
export function attemptProgressRelPath(runId: string, step: string, actor: string | null): string {
  return progressSidecarPath(runId, step, actor);
}

/**
 * Parse a sidecar's bytes into a progress record.
 *
 * `null` covers every way there is nothing to say — absent, torn mid-write,
 * not an object, or missing `updated_at` — because each means the same thing
 * to a reader: do not claim to know what the agent is doing. `updated_at` is
 * the one hard requirement; without it a record cannot be aged, and an
 * unaged self-report is indistinguishable from a stale one.
 */
export function parseProgressSidecar(text: string): AttemptProgress | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const updatedAt = typeof record.updated_at === 'string' && record.updated_at !== '' ? record.updated_at : null;
  if (updatedAt == null) return null;
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return {
    state: str(record.state),
    phase: str(record.phase),
    current: str(record.current),
    updatedAt,
    source: 'agent',
  };
}

/**
 * The progress a claim carries, or `null` when it carries none.
 *
 * Deliberately keyed on `progress_updated_at` alone: a claim written before
 * the agent had produced a sidecar has none of these fields, and a claim from
 * a supervisor that never had a sidecar path is the same case. Both are
 * "nothing to report", not "reported nothing".
 */
export function readClaimProgress(claim: ClaimProgressFields | null | undefined): AttemptProgress | null {
  if (claim == null) return null;
  const updatedAt = typeof claim.progressUpdatedAt === 'string' && claim.progressUpdatedAt !== ''
    ? claim.progressUpdatedAt
    : null;
  if (updatedAt == null) return null;
  const str = (value: string | null | undefined): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return {
    state: str(claim.progressState),
    phase: str(claim.progressPhase),
    current: str(claim.progressCurrent),
    updatedAt,
    source: 'agent',
  };
}

/**
 * Whether this argv names an executor that prints only when it exits.
 *
 * `claude -p` and `codex exec` buffer their whole answer and emit it at the
 * end, so "no output for six minutes" is the NORMAL shape of a healthy
 * six-minute run on them and warning about it trains a reader to ignore the
 * warning. Matched on the binary's basename plus the mode flag, because the
 * same binary in its interactive mode does stream.
 *
 * Deliberately conservative: an unrecognized argv falls through to the plain
 * idle warning. A false negative costs a slightly noisier warning; a false
 * positive would suppress a real stall.
 */
export function isPrintAtExitArgv(argv: readonly string[] | null | undefined): boolean {
  if (argv == null || argv.length === 0) return false;
  const bin = basename(String(argv[0] ?? '')).replace(/\.(exe|cmd|bat)$/i, '');
  const rest = argv.slice(1);
  if (bin === 'claude') return rest.some((arg) => arg === '-p' || arg === '--print');
  if (bin === 'codex') return rest.some((arg) => arg === 'exec');
  return false;
}

/** Which of the three honest things an idle-output warning can say. */
export type IdleOutputKind =
  /** The streams are quiet but the agent's own sidecar moved during the quiet. */
  | 'agent_progress'
  /** No sidecar, and this executor is not expected to stream at all. */
  | 'print_at_exit'
  /** No sidecar, no excuse: the plain observation, unchanged. */
  | 'output_idle';

export interface IdleOutputDescription {
  kind: IdleOutputKind;
  /** The warning body, ready to print after `WARNING: `. */
  text: string;
  /** Age of the mirrored self-report, when there is one. */
  progressAgeMs: number | null;
}

export interface IdleOutputInput {
  /** How long the streams have been quiet. `null` when it could not be measured. */
  idleMs: number | null;
  /** The mirrored self-report, from `readClaimProgress`. */
  progress?: AttemptProgress | null;
  /** The executor's declared argv, when the caller has it. */
  argv?: readonly string[] | null;
  now?: Date;
}

/** `365000` → `6m 5s`. Matches the duration spelling every other surface uses. */
function formatAge(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function ageOf(timestamp: string, now: Date): number | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now.getTime() - parsed);
}

/**
 * Describe quiet streams honestly.
 *
 * The old text said one thing — "no output observed for 6m" — to three
 * situations that mean different things, and two of them are not stalls. A
 * reader who has been told three times that a healthy `claude -p` is silent
 * stops reading the fourth warning, which is the one that mattered.
 *
 * The self-report wins when it is FRESHER than the silence: a sidecar last
 * touched forty seconds into a six-minute quiet is evidence the agent is
 * working, while one last touched before the quiet began is evidence of
 * nothing and must not be dressed up as reassurance. That ordering is the
 * whole point — the warning is allowed to be quieter only where something
 * actually observed says it should be.
 *
 * Never gating, on any branch.
 */
export function describeIdleOutput(input: IdleOutputInput): IdleOutputDescription {
  const now = input.now ?? new Date();
  const progress = input.progress ?? null;
  const progressAgeMs = progress == null ? null : ageOf(progress.updatedAt, now);
  // `?? '5m'` preserves the pre-existing fallback for an unmeasurable idle
  // window rather than inventing a second spelling for "we do not know".
  const idle = formatAge(input.idleMs) ?? '5m';
  const movedDuringSilence = progressAgeMs != null && (input.idleMs == null || progressAgeMs < input.idleMs);
  if (progress != null && movedDuringSilence) {
    const label = progress.phase ?? progress.state ?? 'progress';
    return {
      kind: 'agent_progress',
      text: `no stdout/stderr for ${idle}; agent progress "${label}" ${formatAge(progressAgeMs)} ago`,
      progressAgeMs,
    };
  }
  if (isPrintAtExitArgv(input.argv)) {
    return {
      kind: 'print_at_exit',
      text: `no stdout/stderr for ${idle} (this executor prints only at exit; not a stall signal)`,
      progressAgeMs,
    };
  }
  return {
    kind: 'output_idle',
    text: `no output observed for ${idle} (non-gating)`,
    progressAgeMs,
  };
}

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
/** Workspace-relative cooperative status path embedded in the immutable prompt. */
function progressSidecarPath(runId: string, step: string, actor: string | null): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `.fadeno/progress/${safe(runId)}/${safe(step)}--${safe(actor ?? 'anonymous')}.json`;
}

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
  /**
   * Whether this attempt was given a sidecar path at all.
   *
   * Without it the two silences collapse. An attempt nobody configured a
   * sidecar for and an attempt whose agent has written nothing both produce a
   * claim with no progress fields, and a reader shown the same blank for both
   * cannot tell "there was never anywhere to look" from "we looked and the
   * agent is saying nothing" — which are different facts about the dispatch,
   * and only the second is about the agent. `null` on a claim written before
   * this field existed: a third state, and honestly a third state, because
   * such a claim genuinely does not say.
   */
  progressConfigured?: boolean | null;
}

/** What a reader can honestly say about an attempt's self-report. */
export type SelfReportKind =
  /** A sidecar was configured and the agent has written to it. */
  | 'reported'
  /** A sidecar was configured; the agent has not written anything readable to it. */
  | 'configured_silent'
  /** No sidecar was configured, so there is nothing to have read. */
  | 'unconfigured';

export interface SelfReportDescription {
  kind: SelfReportKind;
  /** The record itself, present only on `reported`. */
  progress: AttemptProgress | null;
}

/**
 * Which of the three things a claim's progress fields mean.
 *
 * Split out from the renderers so that every surface answers the question the
 * same way, and so the distinction that matters — configured-and-silent is a
 * READING, unconfigured is the absence of one — cannot be lost by a caller
 * that only checked for a record. "Never write a positive claim without a
 * reading behind it" cuts both ways: `configured_silent` is a positive claim
 * about the agent and is only reachable when a sidecar path was actually set.
 */
export function describeSelfReport(claim: ClaimProgressFields | null | undefined): SelfReportDescription {
  const progress = readClaimProgress(claim);
  if (progress != null) return { kind: 'reported', progress };
  if (claim?.progressConfigured === true) return { kind: 'configured_silent', progress: null };
  return { kind: 'unconfigured', progress: null };
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
 * The engine sidecar an ENGINE REQUEST names, for either prompt shape.
 *
 * There are two spellings and the choice between them is not a preference: a
 * compositional request is prompted by `assembleCompositePrompt`, which names
 * `<run>/<step_execution_id>.json`, and a plain one by `renderStepPrompt`,
 * which names `<run>/<step>--<actor>.json`. Picking the wrong one finds no
 * file and reports a working agent as silent.
 *
 * That branch used to be written out at each place that needed it — `cli.ts`
 * printed one for a person to `cat`, and nothing else derived it at all. It is
 * a function now because the command fallback needs the SAME answer `cli.ts`
 * prints, and two hand-copied branches is how the two drift.
 */
export function requestProgressRelPath(request: {
  run: string;
  step: string;
  actor: string | null;
  stepExecutionId: string;
  nodeInstanceId?: string | null;
}): string {
  if (request.nodeInstanceId == null) {
    return attemptProgressRelPath(request.run, request.step, request.actor);
  }
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `.fadeno/progress/${safe(request.run)}/${safe(request.stepExecutionId)}.json`;
}

/**
 * Where a RUNLESS attempt's sidecar lives, relative to the repository root.
 *
 * An ad-hoc `fadeno dispatch` has no run, no step and no actor, so
 * `attemptProgressRelPath` has nothing to key on. What it does have is the
 * uuid on its own evidence rows, and that uuid is already the identity every
 * other machine-local artifact of the dispatch is filed under — the prompt
 * snapshot, the stdout snapshot, the in-flight claim. The sidecar joins them.
 *
 * REPOSITORY-ROOT-relative, not workspace-relative, and that is the one real
 * decision here. An ad-hoc dispatch may run in the shared tree, in a
 * kernel-isolated worktree, or as one blinded arm of a pair, and which of
 * those it is gets settled AFTER this path has to exist. Anchoring at the repo
 * root means the kernel derives it once, before the isolation decision, and
 * the answer stays true whatever that decision turns out to be. It also keeps
 * a live agent's status file out of the worktree whose diff becomes the
 * delivery: a sidecar written inside an isolated arm would be one more
 * untracked file in the thing being merged back.
 *
 * `.fadeno/local/` because this is machine-local bookkeeping — gitignored,
 * never ledger evidence, never gating — which is the same rule that put
 * `prompts/`, `outputs/` and `inflight/` there.
 */
export function dispatchProgressRelPath(dispatchId: string): string {
  const safe = dispatchId.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `.fadeno/local/progress/${safe}.json`;
}

/**
 * Whether a self-report belongs to the attempt that is reading it.
 *
 * A sidecar path keyed by run+step+actor is shared by every attempt of that
 * actor, so attempt 3 opens the file attempt 2 left behind and mirrors its
 * last words onto its own claim. Observed 2026-09-06: `fadeno show` rendered
 * `(running) — Auditing the integrated diff…, 1h 45m 25s ago` against a live
 * v3 attempt, quoting text a COMPLETED v2 attempt had written. Nothing gated
 * and the age was honest, which is exactly what made it hard to see: it reads
 * as one stuck agent rather than two attempts sharing a file.
 *
 * The rule is the only one available to a reader that cannot re-key the path:
 * a report timestamped before this attempt started is not this attempt's.
 * `startedAtMs` is the supervisor's own spawn instant, so the comparison is
 * one process's clock against a file written on the same machine.
 *
 * Unparsable `updated_at` returns false. A record that cannot be aged cannot
 * be shown to belong here, and "do not claim to know" is the standing rule.
 *
 * The supervisor applies this same rule inline (it runs as a `-e` source
 * string and cannot import), so any change here must be made there too — see
 * `refreshProgress` in supervisor.ts.
 */
export function progressBelongsToAttempt(updatedAt: string, startedAtMs: number): boolean {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return false;
  return parsed >= startedAtMs;
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

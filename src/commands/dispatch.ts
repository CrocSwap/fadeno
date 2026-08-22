import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import {
  ConstraintError,
  evaluateConstraint,
  type ConstraintContext,
} from '../lib/constraints.ts';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  commandRoutable,
  deliveryIsHost,
  eligibilityFor,
  substitutePromptFile,
  explainEligibilityConflict,
  explainProviderConflict,
  explainPairRoutability,
  loadExecutorProfile,
  readLocalDialState,
  resolveRole,
  compileDialRef,
  parseDialRef,
  formatDialRef,
  roleResolutionEchoLabel,
  withoutHarnessIdentity,
  atCwd,
  type ExecutorProfile,
  type CompiledDelivery,
  type InputProducer,
  type DialRef,
  type RoleResolutionSource,
  shadowSampleRoll,
} from '../lib/executors.ts';
import { decideLane, readSessionEffort } from '../lib/lane.ts';
import { readUserDials } from '../lib/user-paths.ts';
import {
  completeHostDispatch,
  failHostDispatch,
  hostRequestProfile,
  progressHostDispatch,
  readHostDispatchRequest,
  startHostDispatch,
  type DispatchCompleteOptions,
  type DispatchFailOptions,
  type DispatchProgressOptions,
  type DispatchStartOptions,
  type HostDispatchReceipt,
  type HostDispatchProgressReceipt,
} from '../lib/host-dispatch.ts';
import { findRepoRoot, packageVersion, templatesDir } from '../lib/paths.ts';
import { fallbackClaimRelPath, INFLIGHT_DIR, readSupervisorStatus, sleepSync, superviseArgv, supervisedSpawnError, supervisorCanStillReport } from '../lib/supervisor.ts';
import {
  WORKSPACE_LEASE_FILE,
  WORKSPACE_LEASE_LOCK,
  acquireWorkspaceLease,
  carryDeclaredPaths,
  carryMutationStamp,
  isWorkspaceLeaseAlive,
  readWorkspaceLease,
  releaseWorkspaceLease,
  scanIgnoredOutput,
  verifyCarriedPaths,
  withIsolatedWorktree,
  WorkspaceLeaseError,
  type CarryFingerprint,
  type IgnoredOutputScan,
  type LeaseHolder,
  type WorkspaceLeaseRecord,
  type WorkspaceMode,
  type WorktreeCarryMechanism,
} from '../lib/workspace-lease.ts';
import { ensureFadenoIgnore } from '../lib/source-control.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';
import {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_LINES,
  diagnosticsTruncationMarker,
  truncateDiagnostics,
  isDiagnosticsEnabled,
} from '../lib/diagnostics.ts';

export class DispatchCommandError extends Error {}

/** Repo-relative append-only evidence log for ad-hoc dispatches. */
export const DISPATCHES_FILE = join('.fadeno', 'dispatches.jsonl');

/**
 * Format version stamped on every evidence row this kernel writes. The log is
 * append-only and long-lived, so rows outlive the shape they were written in:
 * without a stamp a reader can only guess whether an unfamiliar row is old or
 * new. Minor bumps add fields (readers stay forward-compatible within `0.x`);
 * a major bump re-spells what is already here, and readers that predate it
 * must set those rows aside rather than misread them.
 *
 * The Claude steering hook writes the same stamp as a literal — it runs as a
 * standalone script and cannot import this constant. Bump both together.
 */
export const DISPATCHES_FORMAT = '1.0';

/**
 * What a finished command dispatch actually produced.
 *
 * `dispatch_completed` says the spawn reached a terminal state, never that the
 * work happened. A 2026-08-13 dogfood recorded two dispatches as completed
 * with `exit_code: 1` and `output_bytes: 0` — the sha256 of the empty string —
 * and the event name alone read as success. This is the field that says which
 * it was.
 */
/**
 * Shape a caller-chosen `--tag` must take: a short, shell-safe, greppable
 * token. Constrained rather than free text because the tag travels through the
 * dispatch-proxy guard's allowlist, and a pattern the guard can state exactly
 * is one it cannot be talked past.
 */
export const DISPATCH_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate and normalize `--tag`; `null` when the caller supplied none. */
export function normalizeDispatchTag(tag: string | null | undefined): string | null {
  if (tag == null) return null;
  const trimmed = tag.trim();
  if (trimmed === '') return null;
  if (!DISPATCH_TAG_RE.test(trimmed)) {
    throw new DispatchCommandError(
      `--tag "${trimmed}" is not a valid handle: use 1-64 characters of ` +
        'letters, digits, dot, underscore or hyphen, starting with a letter or digit.',
    );
  }
  return trimmed;
}

export type DispatchOutcome = 'ok' | 'failed' | 'empty' | 'timeout';

const DISPATCH_OUTCOMES: readonly string[] = ['ok', 'failed', 'empty', 'timeout'];

/**
 * Classify a completion row from the facts it already carries.
 *
 * `failed` covers every way the spawn itself went wrong (spawn error, signal,
 * nonzero exit). `empty` is the quieter failure — the executor exited 0 and
 * wrote nothing, which is what an unusable model id, or a worker that stops
 * after backgrounding its real work, looks like from here.
 *
 * Returns null when the row does not carry enough to classify: absent is not a
 * claim, so a pre-0.6 row missing `output_bytes` renders exactly as it does
 * today rather than being relabelled by a reader that arrived later.
 */
export function deriveDispatchOutcome(row: {
  exitCode: number | null;
  signal?: string | null;
  error?: string | null;
  outputBytes: number | null;
  timedOut?: boolean | null;
}): DispatchOutcome | null {
  if (row.timedOut === true) return 'timeout';
  if (row.error != null || row.signal != null) return 'failed';
  if (row.exitCode == null) return null;
  if (row.exitCode !== 0) return 'failed';
  if (row.outputBytes == null) return null;
  return row.outputBytes === 0 ? 'empty' : 'ok';
}

/**
 * The outcome a completion row states, falling back to what its facts imply.
 * Writers stamp `outcome`; every row written before the field derives to the
 * same value, so readers need no era test.
 */
export function normalizeDispatchOutcome(
  stated: unknown,
  row: { exitCode: number | null; signal?: string | null; error?: string | null; outputBytes: number | null; timedOut?: boolean | null },
): DispatchOutcome | null {
  if (typeof stated === 'string' && DISPATCH_OUTCOMES.includes(stated)) return stated as DispatchOutcome;
  return deriveDispatchOutcome(row);
}

/**
 * Spawn-side relay attestations awaiting a matching dispatch — rows of
 * `{timestamp, prompt_sha256}` stashed by the Claude steering hook when it
 * routes a subtask to a dispatch proxy. Content-keyed, so concurrent
 * dispatches match without ordering.
 */
export const PENDING_RELAYS_FILE = join('.fadeno', 'local', 'pending-relays.jsonl');

/**
 * Dispatch-side proof that a DISPATCH PROXY is the caller — rows of
 * `{timestamp, archetype, prompt_sha256}` written by the proxy-guard hook for
 * the exact bytes it is about to send.
 *
 * `PENDING_RELAYS_FILE` proves a relay-bound SPAWN happened; it cannot prove
 * that a given dispatch IS that spawn. Without this file the kernel read
 * "fresh spawn-side entries exist but none match" as a fidelity failure, which
 * an ordinary un-relayed `fadeno dispatch` colliding with an unrelated entry
 * inside the freshness window produces identically. This repo's ledger carries
 * two such `relay_attested: false` rows from 2026-08-17 that nothing can now
 * explain — the field recorded a finding it had not earned.
 */
export const PROXY_DISPATCHES_FILE = join('.fadeno', 'local', 'proxy-dispatches.jsonl');

const PENDING_RELAY_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Match the received prompt against spawn-side attestations. A hit consumes
 * its entry and attests the proxy copied the prompt verbatim (modulo the one
 * trailing newline a heredoc appends); fresh entries with no hit mean the
 * relay altered the prompt (`false`); no fresh entries — non-hook flows —
 * record nothing (`null`). Evidence-only: never blocks the dispatch.
 */
function consumeSpawnSideRelay(repoRoot: string, prompt: string, now: Date): boolean | null {
  const path = join(repoRoot, PENDING_RELAYS_FILE);
  if (!existsSync(path)) return null;
  let rows: Array<{ timestamp?: unknown; prompt_sha256?: unknown }>;
  try {
    rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { timestamp?: unknown; prompt_sha256?: unknown });
  } catch {
    return null; // malformed stash — attest nothing rather than guess
  }
  const fresh = rows.filter((row) => {
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    return (
      Number.isFinite(ts) &&
      now.getTime() - ts <= PENDING_RELAY_MAX_AGE_MS &&
      typeof row.prompt_sha256 === 'string'
    );
  });
  const digests = new Set([sha256Hex(prompt), sha256Hex(prompt.replace(/\n$/, ''))]);
  const hit = fresh.findIndex((row) => digests.has(row.prompt_sha256 as string));
  const remaining = hit === -1 ? fresh : fresh.filter((_, index) => index !== hit);
  try {
    if (remaining.length === 0) rmSync(path, { force: true });
    else writeFileSync(path, `${remaining.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  } catch {
    // best-effort pruning; the verdict stands either way
  }
  if (hit !== -1) return true;
  return fresh.length > 0 ? false : null;
}

/**
 * Consume a proxy-dispatch marker matching these prompt bytes. True means a
 * dispatch proxy sent this exact prompt.
 *
 * Note it matches the bytes the kernel RECEIVED, not the bytes the parent
 * handed the proxy — so a proxy that altered the prompt still marks itself,
 * which is exactly what makes the alteration detectable below rather than
 * indistinguishable from silence.
 */
function consumeProxyDispatchMarker(repoRoot: string, prompt: string, now: Date): boolean {
  const path = join(repoRoot, PROXY_DISPATCHES_FILE);
  if (!existsSync(path)) return false;
  let rows: Array<{ timestamp?: unknown; prompt_sha256?: unknown }>;
  try {
    rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { timestamp?: unknown; prompt_sha256?: unknown });
  } catch {
    return false; // malformed marker file — claim nothing rather than guess
  }
  const fresh = rows.filter((row) => {
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    return (
      Number.isFinite(ts) &&
      now.getTime() - ts <= PENDING_RELAY_MAX_AGE_MS &&
      typeof row.prompt_sha256 === 'string'
    );
  });
  const digests = new Set([sha256Hex(prompt), sha256Hex(prompt.replace(/\n$/, ''))]);
  const hit = fresh.findIndex((row) => digests.has(row.prompt_sha256 as string));
  const remaining = hit === -1 ? fresh : fresh.filter((_, index) => index !== hit);
  try {
    if (remaining.length === 0) rmSync(path, { force: true });
    else writeFileSync(path, `${remaining.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  } catch {
    // best-effort pruning; the verdict stands either way
  }
  return hit !== -1;
}

/**
 * The `relay_attested` verdict, and the one place its three values are decided.
 *
 * - `null`  — no dispatch proxy sent this, or nothing to attest against. NOT a
 *             judgement about fidelity; the absence of a claim.
 * - `true`  — a proxy sent it AND the bytes match what the parent handed that
 *             proxy. Fidelity verified end to end.
 * - `false` — a proxy sent it, spawn-side attestations are in flight, and none
 *             match these bytes. The relay altered the prompt.
 *
 * The proxy marker is what makes `false` load-bearing. Before it, `false` also
 * fired for an un-relayed dispatch that happened to run while someone else's
 * spawn attestation was fresh — so the value could not be acted on, and was
 * recorded anyway.
 */
function consumeRelayAttestation(repoRoot: string, prompt: string, now: Date): boolean | null {
  if (!consumeProxyDispatchMarker(repoRoot, prompt, now)) return null;
  // A proxy sent this. `null` here means no spawn-side attestation exists to
  // check against (the spawn did not route through the steering hook), which
  // is still "cannot say", never "defected".
  return consumeSpawnSideRelay(repoRoot, prompt, now);
}

const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;

export {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_LINES,
  diagnosticsTruncationMarker,
  truncateDiagnostics,
  isDiagnosticsEnabled,
};

/** Predicate name recorded on a `dispatch_refused` row. */
export type DispatchRefusalPredicate =
  | 'eligibility'
  | 'provider_distinctness'
  | 'constraint_command'
  | 'shadow_isolation'
  | 'shadow_resolution'
  | 'shadow_cap'
  | 'shadow_baseline'
  | 'shadow_carry'
  | 'shadow_containment'
  | 'shadow_no_command_lane'
  | 'ignored_output_kept'
  | 'workspace_lease';

function producedByIds(opts: AdHocDispatchOptions): string[] {
  if (opts.producedBy == null) return [];
  return opts.producedBy.map((id) => id.trim()).filter((id) => id.length > 0);
}

/**
 * Resolve `--produced-by` ids against completed rows. Missing, torn, or
 * unreadable ids stay in the list as `provider: null` — never a flag error.
 */
function lookupInputProducers(repoRoot: string, ids: string[]): InputProducer[] {
  if (ids.length === 0) return [];
  const completed = new Map<string, { executor: string | null; provider: string | null }>();
  const path = join(repoRoot, DISPATCHES_FILE);
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        let row: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          row = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        if (row.event !== 'dispatch_completed') continue;
        const id = typeof row.dispatch_id === 'string' ? row.dispatch_id : null;
        if (id == null) continue;
        completed.set(id, {
          executor: typeof row.executor === 'string' && row.executor !== '' ? row.executor : null,
          provider: typeof row.provider === 'string' && row.provider !== '' ? row.provider : null,
        });
      }
    } catch {
      // unreadable log — every id stays unresolvable
    }
  }
  return ids.map((dispatchId) => {
    const found = completed.get(dispatchId);
    return {
      dispatchId,
      executor: found?.executor ?? null,
      provider: found?.provider ?? null,
    };
  });
}

function provenanceFields(producers: InputProducer[]): Array<{
  dispatch_id: string | null;
  executor: string | null;
  provider: string | null;
}> {
  return producers.map((producer) => ({
    dispatch_id: producer.dispatchId,
    executor: producer.executor,
    provider: producer.provider,
  }));
}


/**
 * Append one evidence row, stamped with the build that wrote it.
 *
 * `fadeno_version` is applied here rather than at the six call sites because a
 * per-site field is exactly how it came to be missing: the string existed in
 * the binary, `evidence` and `vendor` rows carried it, and no dispatch row ever
 * did. A 2026-08-13 dogfood read twelve rows across a version bump and could
 * not answer which Fadeno produced any of them — the only version-shaped key
 * present was `hook_version`, which the Claude steering hook writes on its own
 * rows and which is therefore absent (correctly, but confusingly) on every row
 * the kernel writes. Stamping centrally means a new row type cannot forget.
 *
 * This is the version of the binary that *ran*, which is the question worth
 * answering: a proxy invoking `$CLAUDE_PLUGIN_ROOT/bin/fadeno` records the
 * plugin's build, and one invoking a bare `fadeno` records the CLI's, so the
 * two are distinguishable in the log without a separate field.
 */
export function appendEvidenceRow(repoRoot: string, row: Record<string, unknown>): void {
  ensureFadenoIgnore(repoRoot);
  mkdirSync(join(repoRoot, '.fadeno'), { recursive: true });
  const stamped = { ...row, fadeno_version: packageVersion() };
  appendFileSync(join(repoRoot, DISPATCHES_FILE), `${JSON.stringify(stamped)}\n`, 'utf8');
}

function refuseDispatch(
  repoRoot: string,
  identity: Record<string, unknown>,
  predicate: DispatchRefusalPredicate,
  message: string,
  now: Date,
): never {
  appendEvidenceRow(repoRoot, {
    format: DISPATCHES_FORMAT,
    timestamp: now.toISOString(),
    event: 'dispatch_refused',
    ...identity,
    refusal: { predicate, message },
  });
  throw new DispatchCommandError(message);
}

/** How the ad-hoc dispatch landed on its executor (`flag` = `--model` bypass). */
export type DispatchResolutionSource = RoleResolutionSource | 'model-flag';

/**
 * Evidence-row spelling of the resolution path.
 */
const ROW_RESOLUTION: Record<DispatchResolutionSource, string> = {
  binding: 'binding',
  session: 'session',
  repo: 'repo',
  user: 'user',
  base: 'base',
  'model-flag': 'model-flag',
};

export interface AdHocDispatchOptions {
  /** Archetype to resolve; required unless `model` bypasses resolution. */
  archetype?: string | null;
  /** Optional role: enables per-role binding pins and evidence attribution. */
  role?: string | null;
  /** Bypass resolution and invoke this dial ref directly (debugging). */
  model?: string | null;
  /** Driver override for --model bypass. */
  via?: string | null;
  /** Prompt file path (relative paths resolve against `cwd`); wins over `prompt`. */
  promptFile?: string | null;
  /** Prompt text — the CLI reads stdin into this when no `--prompt-file`. */
  prompt?: string | null;
  /** Skip the archetype's declared brief preamble (composed by default). */
  noBrief?: boolean;
  /**
   * Repeatable `--produced-by <dispatch-id>`: prior ad-hoc dispatches whose
   * providers the distinctness predicate compares against. A missing or
   * unreadable id becomes an unresolvable producer (`provider: null`); the
   * predicate decides. Absent or empty means no inputs claimed.
   */
  producedBy?: readonly string[] | null;
  /**
   * `FADENO_LOADOUT` value; injectable for hermetic tests. `undefined` reads
   * the real environment; `null` means explicitly absent.
   */
  env?: string | null;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  /** Injectable clock for the evidence timestamp. */
  now?: Date;
  /** Resolution echo callback — cli.ts prints it to stderr; the command never prints. */
  onEcho?: (line: string) => void;
  /**
   * Caller-chosen correlation handle, recorded on this dispatch's rows and
   * resolvable with `fadeno dispatches --output --tag <tag>`.
   *
   * The kernel echoes its generated `dispatch_id` at spawn, but that echo goes
   * to stderr, and a caller whose Bash call is killed at its own timeout — the
   * exact caller who needs to recover — never receives it. A tag is known
   * *before* the spawn because the caller wrote it, so recovery survives losing
   * every byte the dispatch ever printed.
   */
  tag?: string | null;
  /** One-shot shadow target; integrator wires --shadow. */
  shadow?: string | null;
  /** Isolated worktree delivery: opt-in via --isolate, bypasses shared-writer lease. */
  /**
   * Force an isolated worktree. Largely redundant now that isolation is the
   * default wherever git allows it; kept because it is an explicit statement
   * of intent and because callers pass it.
   */
  isolate?: boolean;
  /**
   * Opt OUT of isolation and run in the caller's tree. The deliberate escape
   * hatch for work that must land in place — and the one shape where nothing
   * stands between the executor and this repo, since write posture no longer
   * exists to pretend otherwise.
   */
  shared?: boolean;
  /**
   * Whether THIS dispatch's gitignored output has to survive, overriding the
   * archetype's `ignored_output` policy.
   *
   * A pair merges the primary back through a diff built by `git add -A`,
   * which respects `.gitignore` — so a paired arm's gitignored output is
   * discarded. `kept` therefore forgoes the pair. That trade is deliberate
   * and one-directional: it costs a comparison, never work.
   */
  ignoredOutput?: 'kept' | 'discardable' | null;
  /** Hard executor deadline in milliseconds; 0 disables, null/undefined uses the route default. */
  timeoutMs?: number | null;
  /** Bounded opt-in process output diagnostics (per-stream 32 KiB / 500 lines). */
  diagnostics?: boolean;
  /** Injectable random sampler for shadow rate (test seam). */
  shadowSampler?: () => number;
}

export interface AdHocDispatchResult {
  /** Correlates the dispatch_requested / dispatch_completed evidence rows. */
  dispatchId: string;
  /** Where the prompt bytes came from (`stdin` gets a kernel-written snapshot). */
  promptSource: 'stdin' | 'file';
  /** Repo-relative snapshot path (stdin) or the given prompt file's path. */
  promptSnapshot: string;
  /**
   * Spawn-side relay verdict: `true` = the prompt matches a stashed
   * attestation, `false` = attestations were pending but none matched,
   * `null` = no attestation flow in play.
   */
  relayAttested: boolean | null;
  archetype: string | null;
  role: string | null;
  dial: DialRef;
  dialSource: DispatchResolutionSource;
  executor: string;
  model: string | null;
  modelId: string | null;
  /** The resolved delivery's provider, or null when the catalog states none. */
  provider: string | null;
  driver: string | null;
  reasoningEffort: string | null;
  source: DispatchResolutionSource;
  /** The resolution echo line (`<role-or-archetype> → <executor> (<model>) [<source>]`). */
  echo: string;
  exitCode: number;
  /** The executor's report — cli.ts relays it verbatim to stdout. */
  stdout: string;
  stderr: string;
  durationMs: number;
  promptSha256: string;
  outputSha256: string;
  /** Bytes the executor wrote to its output snapshot. */
  outputBytes: number;
  /**
   * What the spawn produced, as stamped on the completion row. `empty` is the
   * case a bare exit code cannot express: the executor succeeded and reported
   * nothing, so the caller has a "success" with no work behind it.
   */
  outcome: DispatchOutcome | null;
  /** Repo-relative path of the evidence log that received the row pair. */
  evidencePath: string;
  transport: 'command' | 'host-command-fallback';
}

export interface DispatchFallbackOptions {
  run: string;
  dispatchId: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
  onEcho?: (line: string) => void;
}

export interface DispatchFallbackResult {
  dispatchId: string;
  executor: string;
  model: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  idempotent: boolean;
}

function lockedRunFile(runDir: string, value: string, label: string): string {
  const runAbsolute = resolve(runDir);
  const path = isAbsolute(value) ? resolve(value) : resolve(runAbsolute, value);
  const rel = relative(runAbsolute, path).split('\\').join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new DispatchCommandError(`locked request ${label} escapes its run directory: ${value}.`);
  }
  if (!existsSync(path)) throw new DispatchCommandError(`locked request ${label} is missing: ${value}.`);
  const realRel = relative(realpathSync(runAbsolute), realpathSync(path)).split('\\').join('/');
  if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
    throw new DispatchCommandError(`locked request ${label} escapes its run directory through a symlink: ${value}.`);
  }
  return path;
}

function loadProfileOrThrow(
  repoRoot: string,
  userPathOptions?: UserPathOptions,
): { profile: ExecutorProfile; layers: Array<'builtin' | 'user' | 'project'>; selfContained: boolean } {
  try {
    const layered = loadExecutorProfile(repoRoot, userPathOptions);
    return {
      profile: layered.profile,
      layers: layered.layers ?? [],
      selfContained: layered.selfContained === true,
    };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
    throw err;
  }
}

/**
 * Workspace fingerprint for the exit-0 no-op attestation. Concurrent writers
 * make this attestation, not judgment: another process can mutate the tree
 * between the two probes (or during the spawn), so a true/false stamp is not
 * a verdict that this executor caused the delta.
 *
 * Null when either probe exits nonzero or fails to spawn (no git, unborn
 * HEAD, permission error) — the completion row then omits the field.
 */
/**
 * A shadow spawned ahead of the primary, to be collected after it. The child
 * runs under its own supervisor with an fd-only stdio wiring, so it makes
 * progress while the kernel is blocked inside the primary's `spawnSync`;
 * `statusAbs` is where that supervisor reports the exit the kernel could not
 * watch for.
 */
interface PendingShadow {
  dispatchId: string;
  /** Addresses the primary/shadow pair as one thing, on every row of both arms. */
  pairId: string;
  /** The pair's shared starting-state commit, same value the shadow arm carries. */
  baselineCommit: string;
  /** Request-row clock reading; the completion row derives from it. */
  startedAt: Date;
  /** Kernel-side ms fallback when the supervisor's report has no duration. */
  startedMs: number;
  identity: Record<string, unknown>;
  child: ChildProcess;
  statusAbs: string;
  inflightAbs: string;
  outputRel: string;
  outputAbs: string;
  diffRel: string;
  diffAbs: string;
  worktreeAbs: string;
  worktreeRel: string;
  /** Carry-time identity of the hardlink-carried paths, for `carry_mutated`. */
  carryFingerprint: CarryFingerprint;
  /** Live-shadow lease; its removal is what frees a slot under the cap. */
  markerAbs: string;
}

/** How often shadow collection re-checks for the supervisor's exit report. */
const SHADOW_POLL_MS = 50;
const SHADOW_LIVENESS_EVERY = 20;

/**
 * Live-shadow lease, one file per running challenger, alongside the
 * supervisor's own claim. It carries the supervisor pid so liveness is a
 * direct probe rather than a dependency on the claim the supervisor may not
 * have published yet, and it is what the cap counts.
 */
const SHADOW_MARKER_SUFFIX = '.shadow.json';

/**
 * How many challengers may be running at once in this repo.
 *
 * A cap and a `--rate` bound different things and neither substitutes for the
 * other: the rate bounds spend, this bounds machine load. A serial trickle of
 * two hundred shadows costs what two hundred concurrent ones cost, so the rate
 * is the wallet control and this is the resource control.
 */
const SHADOW_MAX_LIVE_DEFAULT = 4;

function shadowLiveCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FADENO_SHADOW_MAX_LIVE;
  if (raw == null || raw.trim() === '') return SHADOW_MAX_LIVE_DEFAULT;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) return SHADOW_MAX_LIVE_DEFAULT;
  return parsed;
}

/**
 * A generous window between a marker's recorded `started_at` and the
 * corroborating probe's observed start time. Marker writes always trail the
 * actual spawn (JSON.stringify + fs write take real, if tiny, time), and
 * `ps`'s locale-formatted timestamp only round-trips through `Date.parse` to
 * whole-second precision — this only needs to catch "a wildly different
 * process", not confirm agreement to the millisecond.
 */
const PID_START_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Best-effort corroboration that `pid` is still the SAME process the marker
 * was written for, not a different process the OS later recycled onto that
 * number. `ps -o lstart=` (supported by both BSD/macOS and GNU/Linux `ps` —
 * no dependency added) reports the CURRENT holder's actual start time.
 * `LC_ALL=C` pins the format so `Date.parse` sees the same shape on every
 * machine. Returns null — "no answer", not "no match" — whenever `ps` is
 * absent, sandboxed away, or its output does not parse; see the caller for
 * why that must never be read as a mismatch.
 */
function realPidStartedAt(pid: number): string | null {
  try {
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (res.error != null || res.status !== 0) return null;
    const out = String(res.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Challengers still running, by direct pid probe corroborated against the
 * marker's own recorded start time. Markers whose supervisor is gone are the
 * residue of a killed kernel; they are dropped in passing rather than
 * counted, so one crash cannot permanently consume the cap.
 *
 * ## The pid-reuse gap this narrows
 *
 * A bare `process.kill(pid, 0)` only proves SOME process currently holds
 * `pid` — not that it is the same supervisor the marker was written for.
 * PIDs wrap and get reused, more readily on a busy machine or inside a
 * short-lived container, so a stale marker whose pid has since been recycled
 * onto an unrelated process would read as "alive" forever, permanently
 * consuming a slot under the live-shadow cap (undercounting free capacity —
 * the reverse, a live shadow read as dead, cannot happen from reuse alone,
 * since a freshly-recycled pid's start time will not match the old marker's
 * either way `alive` starts).
 *
 * `startProbe` corroborates the bare pid check against the process's actual
 * start time (`realPidStartedAt` by default). This is a ONE-DIRECTIONAL
 * tightening, never a new way to undercount a genuinely live shadow: a probe
 * that returns no answer (`ps` unavailable, unparseable output) leaves the
 * original conservative pid-alive verdict standing exactly as it did before
 * this existed; only a probe that clearly disagrees — the running process's
 * start time falls outside `PID_START_TOLERANCE_MS` of what the marker
 * recorded — can flip `alive` to `false`. It is corroboration, not a
 * replacement for the primary liveness signal.
 *
 * `killProbe`/`startProbe` are injectable for tests; both default to the
 * real OS calls.
 */
export function countLiveShadows(
  repoRoot: string,
  killProbe: (pid: number, signal: number) => void = (pid, signal) => process.kill(pid, signal),
  startProbe: (pid: number) => string | null = realPidStartedAt,
): number {
  const dir = join(repoRoot, ...INFLIGHT_DIR.split('/'));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no inflight dir: nothing is running
  }
  let live = 0;
  for (const name of names) {
    if (!name.endsWith(SHADOW_MARKER_SUFFIX)) continue;
    const abs = join(dir, name);
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
    } catch {
      try { rmSync(abs, { force: true }); } catch { /* nothing to drop */ }
      continue;
    }
    const pid = record.supervisor_pid;
    if (typeof pid !== 'number') continue;
    let alive: boolean;
    try {
      killProbe(pid, 0);
      alive = true;
    } catch (err) {
      // EPERM means someone else's process holds the pid — conservatively live.
      alive = (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (alive && typeof record.started_at === 'string') {
      const recorded = Date.parse(record.started_at);
      let observedRaw: string | null;
      try {
        observedRaw = startProbe(pid);
      } catch {
        observedRaw = null; // a throwing probe is "no answer", same as a null return
      }
      const observed = observedRaw != null ? Date.parse(observedRaw) : NaN;
      if (!Number.isNaN(recorded) && !Number.isNaN(observed) && Math.abs(observed - recorded) > PID_START_TOLERANCE_MS) {
        alive = false; // same pid, a different (later) process — recycled
      }
    }
    if (alive) live += 1;
    else { try { rmSync(abs, { force: true }); } catch { /* nothing to drop */ } }
  }
  return live;
}


function workspaceFingerprint(repoRoot: string): string | null {
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.error != null || status.status !== 0) return null;
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.error != null || head.status !== 0) return null;
  return sha256Hex(`${status.stdout ?? ''}\0${head.stdout ?? ''}`);
}

/** Never copy the shadow worktree's own home into itself — recursive, and the
 * one path a repo's own `.gitignore` cannot be trusted to exclude, since a
 * user repo may commit `.fadeno/` definitions while ignoring only some
 * subpaths. Checked explicitly rather than delegated to `--exclude-standard`.
 */
function isUnderShadowHome(repoRelPath: string): boolean {
  return repoRelPath === '.fadeno/local' || repoRelPath.startsWith('.fadeno/local/');
}

function gitFailureReason(result: { error?: Error | null; status: number | null; stderr?: string | Buffer | null }): string {
  if (result.error != null) return result.error.message;
  const stderr = String(result.stderr ?? '').trim();
  if (stderr.length > 0) return stderr;
  return `exit ${result.status ?? 'unknown'}`;
}

// Declared `worktree_carry:` paths and the mechanism that carries them
// (reflink → hardlink → copy) now live in `workspace-lease.ts`
// (`carryDeclaredPaths`/`carryPathIntoWorktree`), shared by this file's
// shadow-pair carry (below) and its isolated-delivery carry. The
// declaration itself comes off the PARSED, validated profile
// (`profile.worktreeCarry`, from `loadExecutorProfile`/`parseExecutorProfile`
// in `executors.ts`) rather than a second raw-YAML read of the project
// catalog — a malformed declaration now fails the dispatch loudly at load
// time instead of being silently dropped here.

/**
 * Replay the primary's pre-spawn workspace state into the challenger's
 * worktree, as one commit, so the pair's starting state is an addressable
 * commit rather than an implicit one and each arm's own work becomes the
 * second commit. Three moves, in order:
 *
 * 1. Capture the primary's tracked-file state with `git diff HEAD --binary`
 *    (staged AND unstaged, deletions, binary files) without ever touching
 *    the primary's index — the primary is about to work, and mutating its
 *    index out from under it is unacceptable.
 * 2. Apply that patch in the worktree with `git apply --index`, which
 *    `git worktree add` never does (it cuts a clean checkout of HEAD) and
 *    `git diff` never sees (untracked files, handled separately below).
 * 3. Carry untracked-but-unignored files explicitly, by copy — `git diff`
 *    has no notion of them at all.
 *
 * A clean primary tree produces no diff and no untracked files, so nothing
 * is staged and no commit is made; the caller's baseline is then simply the
 * worktree's HEAD (the same commit the worktree was cut from). Any failure
 * along the way throws, and the caller is responsible for treating that as
 * a refusal — a dirty tree that cannot be replayed must never silently
 * produce a skewed pair.
 */
/**
 * Fixed author/committer date for every pair baseline commit.
 *
 * Not a timestamp — an identity. Both arms must hash to the same commit for
 * `baseline_commit` to mean what it claims, and a real clock would defeat
 * that. Never read this back as a time.
 */
const BASELINE_COMMIT_DATE = '2000-01-01T00:00:00Z';

/**
 * The caller's pre-spawn workspace, captured ONCE.
 *
 * Both arms of a pair replay this same capture. Capturing per-arm instead
 * would read the tree at two different moments — the challenger is
 * materialized before the primary's worktree is — so a file written between
 * the two reads would land in one arm's baseline and not the other's, which
 * is precisely the asymmetry the shared baseline exists to remove.
 */
export interface CapturedWorkspaceBaseline {
  /** `git diff HEAD --binary` over tracked content. Empty when clean. */
  patch: Buffer;
  /** Untracked-but-unignored paths; `git diff` has no notion of these. */
  untrackedFiles: string[];
}

export function captureWorkspaceBaseline(repoRoot: string): CapturedWorkspaceBaseline {
  const diffRes = spawnSync('git', ['-C', repoRoot, 'diff', 'HEAD', '--binary'], {
    encoding: 'buffer',
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (diffRes.error != null || diffRes.status !== 0) {
    throw new Error(`could not capture the primary workspace's pre-spawn state: ${gitFailureReason(diffRes)}`);
  }
  const untrackedRes = spawnSync('git', ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (untrackedRes.error != null || untrackedRes.status !== 0) {
    throw new Error(`could not list the primary workspace's untracked files: ${gitFailureReason(untrackedRes)}`);
  }
  return {
    patch: diffRes.stdout ?? Buffer.alloc(0),
    untrackedFiles: String(untrackedRes.stdout ?? '')
      .split('\0')
      .filter((p) => p.length > 0)
      .filter((p) => !isUnderShadowHome(p)),
  };
}

/**
 * Replay one captured baseline into one worktree and commit it.
 *
 * The commit is made with a FIXED author/committer identity and date, so two
 * worktrees cut from the same HEAD and given the same capture produce the
 * byte-identical commit object — and therefore the same sha. That is what
 * lets `baseline_commit` be one value genuinely shared by both arms rather
 * than one arm's value copied onto the other's row. The caller asserts the
 * equality; a mismatch means the arms did not start from the same state and
 * the pair is not a fair test.
 */
export function applyWorkspaceBaseline(
  repoRoot: string,
  worktreeAbs: string,
  captured: CapturedWorkspaceBaseline,
  /** Names the baseline in its commit subject. A pair passes its `pairId` so
   * both arms produce the byte-identical commit object the shared
   * `baseline_commit` depends on; an unpaired isolated delivery passes its
   * dispatch id, which has no counterpart to match. */
  baselineRef: string,
  armLabel: string,
): string {
  const patch = captured.patch;

  if (patch.length > 0) {
    const applyRes = spawnSync('git', ['-C', worktreeAbs, 'apply', '--index'], {
      input: patch,
      encoding: 'utf8',
      maxBuffer: SPAWN_MAX_BUFFER,
    });
    if (applyRes.error != null || applyRes.status !== 0) {
      throw new Error(`could not replay the caller's pre-spawn changes into the ${armLabel} worktree: ${gitFailureReason(applyRes)}`);
    }
  }

  let copiedAny = false;
  for (const relPath of captured.untrackedFiles) {
    try {
      const srcAbs = join(repoRoot, relPath);
      const destAbs = join(worktreeAbs, relPath);
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(srcAbs, destAbs);
      // copyFileSync does not preserve mode bits, notably the executable
      // one: an untracked helper script (a repo's own build/test entry
      // point is a common case) would otherwise land non-executable in the
      // challenger's worktree, so the challenger could not run something
      // the primary can — the same class of asymmetry `worktree_carry`
      // exists to remove for gitignored paths. Match the source file's mode
      // explicitly rather than trust the copy to carry it.
      chmodSync(destAbs, statSync(srcAbs).mode);
      copiedAny = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`could not copy untracked file "${relPath}" into the ${armLabel} worktree: ${reason}`);
    }
  }

  if (patch.length === 0 && !copiedAny) {
    // Nothing to replay: the primary's tree was clean, so the baseline is
    // simply the commit the worktree was already cut from.
    const headRes = spawnSync('git', ['-C', worktreeAbs, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (headRes.error != null || headRes.status !== 0) {
      throw new Error(`could not resolve the ${armLabel} worktree's HEAD: ${gitFailureReason(headRes)}`);
    }
    return String(headRes.stdout ?? '').trim();
  }

  const addRes = spawnSync('git', ['-C', worktreeAbs, 'add', '-A'], { encoding: 'utf8' });
  if (addRes.error != null || addRes.status !== 0) {
    throw new Error(`could not stage the workspace baseline in the ${armLabel} worktree: ${gitFailureReason(addRes)}`);
  }
  // Fixed identity AND fixed dates. A commit object hashes its author and
  // committer timestamps, so letting them default to "now" would give the two
  // arms different baseline shas for identical content — and the shared
  // `baseline_commit` would become a fiction maintained by copying one arm's
  // value onto the other's row. The epoch constant is arbitrary but must stay
  // stable: it is an identity, not a time, and nothing reads it as one.
  const commitRes = spawnSync('git', [
    '-C', worktreeAbs,
    '-c', 'user.name=fadeno',
    '-c', 'user.email=fadeno@localhost',
    'commit', '--no-verify', '--no-gpg-sign', '-m', `fadeno workspace baseline ${baselineRef}`,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: BASELINE_COMMIT_DATE,
      GIT_COMMITTER_DATE: BASELINE_COMMIT_DATE,
    },
  });
  if (commitRes.error != null || commitRes.status !== 0) {
    throw new Error(`could not commit the workspace baseline in the ${armLabel} worktree: ${gitFailureReason(commitRes)}`);
  }

  const shaRes = spawnSync('git', ['-C', worktreeAbs, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (shaRes.error != null || shaRes.status !== 0) {
    throw new Error(`could not resolve the ${armLabel} worktree's baseline commit: ${gitFailureReason(shaRes)}`);
  }
  return String(shaRes.stdout ?? '').trim();
}

/**
 * One ad-hoc dispatch: resolve archetype → executor with the kernel chain
 * (per-role pin → active loadout slot → `"*"` default), run the boundary
 * predicates (write posture, eligibility, provider distinctness, constraint
 * command), invoke the command adapter (or a host executor's explicit command
 * fallback) with the prompt on stdin, and append a `dispatch_requested` +
 * `dispatch_completed` evidence row pair to `.fadeno/dispatches.jsonl` (the
 * request row lands before the spawn so killed dispatches still leave a
 * trace). A boundary refusal writes one `dispatch_refused` row instead.
 * `--model` bypasses resolution for debugging.
 */
export function runDispatch(opts: AdHocDispatchOptions): AdHocDispatchResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const layered = loadProfileOrThrow(repoRoot, opts.userPathOptions);
  const profile = layered.profile;

  const archetype = opts.archetype?.trim() ? opts.archetype.trim() : null;
  const role = opts.role?.trim() ? opts.role.trim() : null;
  const tag = normalizeDispatchTag(opts.tag);

  let delivery: CompiledDelivery;
  let source: DispatchResolutionSource;
  let resolvedVia: string | null = null;
  let dial: DialRef;
  // layer maps for constraint context + legacyNote handling
  let sessionDials: Record<string, DialRef> = {};
  let repoDials: Record<string, DialRef> = {};
  let userDials: Record<string, DialRef> = {};
  let legacyNote: string | null = null;

  const bypassModelRaw = opts.model?.trim() ? opts.model.trim() : null;
  const viaOverride = opts.via?.trim() ? opts.via.trim() : null;

  if (bypassModelRaw != null && bypassModelRaw !== '') {
    // --model <ref> (+ --via) direct compile
    let ref: DialRef;
    try {
      ref = parseDialRef(bypassModelRaw, '--model');
      if (viaOverride != null) ref.via = viaOverride;
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
      throw err;
    }
    try {
      delivery = compileDialRef(ref, profile);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
      throw err;
    }
    dial = ref;
    source = 'model-flag';
    // also populate layer maps for evidence/context? For model-flag, dials still reflect current layers
    try {
      const localState = readLocalDialState(repoRoot);
      legacyNote = localState.legacyNote;
      if (legacyNote) opts.onEcho?.(legacyNote);
      sessionDials = localState.dials;
      repoDials = profile.dials;
      userDials = readUserDials(opts.userPathOptions ?? {}) as Record<string, DialRef>;
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
      throw err;
    }
  } else {
    if (archetype == null) {
      throw new DispatchCommandError(
        'fadeno dispatch needs --archetype <a> (or --model <ref> to bypass resolution).',
      );
    }
    if (!BARE_IDENTIFIER_RE.test(archetype)) {
      throw new DispatchCommandError(
        `--archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`,
      );
    }
    try {
      const localState = readLocalDialState(repoRoot);
      legacyNote = localState.legacyNote;
      if (legacyNote) opts.onEcho?.(legacyNote);
      sessionDials = localState.dials;
      repoDials = profile.dials;
      userDials = readUserDials(opts.userPathOptions ?? {}) as Record<string, DialRef>;
      const layers = { session: sessionDials, repo: repoDials, user: userDials };
      const resolved = resolveRole(role ?? archetype, archetype, profile, layers);
      delivery = resolved.delivery;
      source = resolved.source;
      resolvedVia = resolved.resolvedVia;
      dial = resolved.delivery.ref;
      // `--via` without `--model`: escalate THIS dispatch onto another driver
      // without touching the dial. Until 2026-08-21 the override was read only
      // inside the `--model` branch above, so `fadeno dispatch --archetype
      // worker --via claude-exec` accepted the flag, ignored it, and delivered
      // on the dial's own route — while `--help` advertised `--via` as
      // `(dial/dispatch)`. A flag that is parsed and dropped is the silent
      // no-op this repo keeps paying for, and it sits directly on the
      // escalation path the host-lane guidance below points at: telling a
      // caller to escalate with a flag that does nothing is worse than not
      // offering one.
      if (viaOverride != null) {
        const overridden: DialRef = { ...resolved.delivery.ref, via: viaOverride };
        try {
          delivery = compileDialRef(overridden, profile);
        } catch (err) {
          if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
          throw err;
        }
        dial = overridden;
      }
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
      throw err;
    }
  }

  const spec = delivery.spec;
  const executorName = delivery.refString;
  /**
   * The lane the RESOLVER would have chosen for this archetype — the same
   * `decideLane` the Claude hook and `fadeno dial resolve` route on, asked
   * with the same inputs so the three cannot disagree.
   *
   * The kernel does not route on this and must not: `fadeno dispatch` is an
   * explicit request for command delivery, and legitimate machine callers ask
   * for it on host-lane archetypes (`fadeno bakeoff` dispatches two judges
   * this way, and a judge is host-lane under Claude with the default dial).
   * What the lane changes is what the kernel SAYS.
   *
   * Without it the write-posture refusal reads its remedies in the wrong
   * order: it calls the in-session agent a non-equivalent substitute and leads
   * with `--via`, which is right for a genuinely command-lane archetype and
   * backwards when the resolver already chose in-session. An agent following
   * that advice re-dials a host-lane archetype onto an exec route and moves it
   * out of the session permanently — the opposite of what the resolver
   * decided, produced by the message rather than by any gate.
   */
  const laneDecision = decideLane({
    pinnedEffort: delivery.pinnedEffort,
    effectiveEffort: delivery.effectiveEffort,
    sessionEffort: readSessionEffort(opts.userPathOptions?.env ?? process.env),
    hostModel: deliveryIsHost(delivery),
    commandLane: commandRoutable(spec),
  });
  const hostLanePreferred = laneDecision.lane === 'host';
  const shape = archetype ?? role ?? 'role';
  /**
   * Prepended to every refusal and echoed on the delivering path. Leads with
   * the resolver's own choice, names the in-session agent as that choice
   * rather than as a downgrade, and keeps a real escalation open — per
   * invocation, so taking it cannot silently relocate the archetype.
   */
  const hostLaneNote = hostLanePreferred
    ? `NOTE: ${shape} resolves to the HOST lane here (${laneDecision.lane_reason}), so the resolver's own ` +
      `choice for this task is the in-session ${shape} agent — spawn it and you are done; it is not a ` +
      'downgrade, it is the delivery every other caller gets. Dispatch it only when you specifically need ' +
      'what in-session cannot give: an isolated worktree, a dispatch id, a terminal receipt, --timeout/' +
      `--diagnostics, or a shadow pair. To do that for THIS call without moving the dial, add \`--via ` +
      '<driver>\` (an *-exec route is the command-lane counterpart of a host one).'
    : null;
  // The one delivery gate left. A host spec with a `fallback_command` is
  // dispatched down that lane — the same lane a selected pair forces both arms
  // onto, and the same lane the `*-exec` routes name explicitly — so the only
  // spec ad-hoc dispatch has to refuse is one with nothing to invoke at all.
  // The harness-dependent `host_in_session` refusal that used to sit here is
  // gone; see `commandRoutable` for why it was a coin-flip rather than a
  // safeguard, and note that the write posture it was incidentally enforcing
  // is enforced for real a few lines below, by `explainWriteConflict`.
  if (!commandRoutable(spec)) {
    // `current-host` is a reference-frame sentinel, not a model you can route
    // — suggesting `--via` on it would be advice that cannot be followed.
    const dialModel = spec.model != null && spec.model !== 'current-host' ? spec.model : '<model>';
    // The in-session agent is a FALLBACK, not an equivalent, and saying so is
    // the point of this wording. A caller who reached for `fadeno dispatch`
    // wanted what only a dispatch gives: an isolated worktree, an evidence row
    // with a dispatch id readable by `--tag`, `--timeout`/`--diagnostics`, and
    // shadow pairing. An in-session agent provides none of those and looks
    // like it succeeded. On 2026-08-21 a coordinator hit this refusal, spawned
    // the in-session agent, and reported it as "equivalent role, no
    // recursion" — while the instructions it was following asked it to read
    // the result back by tag and verify a dispatch id, which by then could
    // not exist.
    // Precise about what is actually lost. An earlier version of this said the
    // in-session path "writes no evidence row", which is FALSE — the steering
    // hook writes a `host_delivery` / `native_delivery` row carrying the
    // archetype, executor, model, effort, driver and a prompt snapshot. What
    // it has no way to write is a terminal receipt: those rows carry no
    // dispatch id, so there is no exit code, duration, captured output, or
    // `--output tag:` handle. Overstating the loss is the same failure as
    // understating it — this message exists because the previous one made a
    // claim it had not checked.
    throw new DispatchCommandError(
      (hostLaneNote != null ? `${hostLaneNote}\n\n` : '') +
        `resolved to host executor "${executorName}", which declares no fallback_command, so ad-hoc ` +
        'dispatch has nothing to invoke. ' +
        `To dispatch for real, give ${shape} a command lane: \`fadeno dial ${archetype ?? '<archetype>'} ` +
        `${dialModel} --via <driver>\` (\`fadeno models\` lists the drivers; an *-exec route ` +
        'is the command-lane counterpart of a host one). ' +
        'An in-session agent is NOT an equivalent substitute. It writes a host_delivery evidence row (with ' +
        'the prompt snapshot), but that row carries no dispatch id and no terminal receipt — no exit code, ' +
        'no duration, no captured output, and nothing to read back with `fadeno dispatches --output ' +
        'tag:<tag>`. It also runs in this workspace with no isolated worktree, honours neither --timeout ' +
        'nor --diagnostics, and forms no shadow pair. Take it only if you do not need those.',
    );
  }
  let command = spec.adapter === 'command' ? spec.command : spec.fallbackCommand!;
  const transport = spec.adapter === 'command' ? 'command' : 'host-command-fallback';
  const deliveryTransport = spec.adapter === 'command' ? 'command' : 'host-command-fallback';


  let prompt: string;
  let promptSource: 'stdin' | 'file';
  let promptPath: string | null = null;
  if (opts.promptFile != null && opts.promptFile !== '') {
    promptPath = resolve(cwd, opts.promptFile);
    if (!existsSync(promptPath)) {
      throw new DispatchCommandError(`--prompt-file ${opts.promptFile} does not exist.`);
    }
    prompt = readFileSync(promptPath, 'utf8');
    promptSource = 'file';
  } else if (opts.prompt != null) {
    prompt = opts.prompt;
    promptSource = 'stdin';
  } else {
    throw new DispatchCommandError('no prompt: pass --prompt-file <path> or pipe the prompt on stdin.');
  }
  if (prompt.trim().length === 0) {
    // Usage error, not a boundary refusal: nothing was dispatched.
    throw new DispatchCommandError(
      opts.promptFile != null && opts.promptFile !== ''
        ? `--prompt-file ${opts.promptFile} is empty — a dispatch needs a non-empty prompt.`
        : 'empty prompt on stdin — pipe a non-empty prompt or pass --prompt-file <path>.',
    );
  }

  // Archetype brief: a catalog-declared preamble composed in front of the
  // task (how a director learns to coordinate through fadeno). The composed
  // prompt is what gets snapshotted and digest-attested — evidence records
  // exactly what was sent, brief included.
  const briefName = archetype != null && Object.hasOwn(profile.archetypes, archetype)
    ? profile.archetypes[archetype]!.brief
    : null;
  let briefApplied: string | null = null;
  if (briefName != null && opts.noBrief !== true) {
    const candidates = [
      join(repoRoot, '.fadeno', 'briefs', `${briefName}.md`),
      join(templatesDir(), 'common', 'fadeno', 'briefs', `${briefName}.md`),
    ];
    const briefPath = candidates.find((p) => existsSync(p));
    if (briefPath == null) {
      throw new DispatchCommandError(
        `archetype "${archetype}" declares brief "${briefName}" but no template exists at ` +
          `${candidates.map((p) => relative(repoRoot, p) || p).join(' or ')} — ` +
          'add the file, remove the `brief:` declaration, or pass --no-brief.',
      );
    }
    const briefText = readFileSync(briefPath, 'utf8');
    prompt = `${briefText.trimEnd()}\n\n${prompt}`;
    briefApplied = briefName;
    opts.onEcho?.(`brief: ${briefName} (${relative(repoRoot, briefPath) || briefPath}) composed ahead of the task`);
  }

  // Two-row evidence: a request row lands BEFORE the spawn so a dispatch
  // killed mid-flight (harness timeout, SIGTERM) still leaves a trace —
  // spawnSync blocks the event loop, so nothing written afterwards can be
  // relied on to exist. A boundary refusal writes `dispatch_refused` instead
  // of this pair, with the same identity. The completion row shares the
  // request's dispatch_id.
  const dispatchId = randomUUID();
  const now = opts.now ?? new Date();

  // The kernel owns the prompt snapshot for stdin dispatches — and for any
  // dispatch where a brief was composed: the snapshot must hold the bytes
  // actually SENT, and a brief makes those differ from the caller's file.
  let promptSnapshot: string;
  if (promptSource === 'stdin' || briefApplied != null) {
    const snapshotRel = join(
      '.fadeno',
      'local',
      'prompts',
      `${archetype ?? role ?? 'dispatch'}-${dispatchId.slice(0, 8)}.md`,
    );
    const snapshotAbs = join(repoRoot, snapshotRel);
    mkdirSync(join(repoRoot, '.fadeno', 'local', 'prompts'), { recursive: true });
    writeFileSync(snapshotAbs, prompt, 'utf8');
    promptSnapshot = snapshotRel.split('\\').join('/');
  } else {
    const rel = relative(repoRoot, promptPath!).split('\\').join('/');
    promptSnapshot = rel === '' || rel.startsWith('../') || isAbsolute(rel) ? promptPath! : rel;
  }

  // File-reading drivers: `{prompt_file}` in the route argv becomes the
  // snapshot's absolute path — the digest attests exactly what the executor
  // reads. Substituted before the identity row so evidence records the argv
  // that actually spawns.
  const promptFileAbs = isAbsolute(promptSnapshot) ? promptSnapshot : join(repoRoot, promptSnapshot);
  command = substitutePromptFile(command, promptFileAbs);

  // Streamed stdout snapshot: same naming idiom as the prompt snapshot. The
  // path is recorded on the request row before the spawn so a killed
  // dispatch's partial output is discoverable from the ledger.
  const outputRel = join(
    '.fadeno',
    'local',
    'outputs',
    `${archetype ?? role ?? 'dispatch'}-${dispatchId.slice(0, 8)}.md`,
  );
  const outputAbs = join(repoRoot, outputRel);
  const outputSnapshot = outputRel.split('\\').join('/');

  const relayAttested = consumeRelayAttestation(repoRoot, prompt, now);
  if (relayAttested === false) {
    // Contemporaneous, because retrospective is the wrong shape for this. A
    // defecting relay means the executor is about to work from bytes the
    // caller never wrote, and the person who can tell whether that matters is
    // watching this command right now. The row is written either way; this is
    // the part that gets read.
    opts.onEcho?.(
      'RELAY FIDELITY FAILED: a dispatch proxy sent bytes that do not match what it was handed. ' +
      'The executor below is working from an altered prompt — treat its output as answering a ' +
      'different question. Check the relay identity (`relay.claude` / `relay.codex` in ' +
      'executors.yaml); a model too small for the relay contract summarizes instead of forwarding.',
    );
  }

  const promptSha256 = sha256Hex(prompt);

  /** Resolved challenger identity, before any worktree exists. Side-effect
   * free apart from reading local dial state, so it is safe to run early. */
  interface PairCandidate {
    dial: DialRef | null;
    executorName: string;
    sourceTag: 'flag' | 'attachment';
  }

  const decidePairCandidate = (): PairCandidate | null => {
    // Nothing inside a shadow ever shadows: a challenger that spawns its own
    // challengers multiplies the fleet by nesting depth. The kernel reads this
    // flag; it is never echoed, which also keeps the arms blind to which one
    // they are.
    if (process.env.FADENO_IN_SHADOW === '1') return null;
    const hasFlag = typeof opts.shadow === 'string' && opts.shadow.trim().length > 0;
    let dial: DialRef | null = null;
    let executorName: string | null = null;
    let sourceTag: 'flag' | 'attachment' | null = null;
    let attachmentRate: number | undefined;
    if (hasFlag) {
      try {
        const parsed = parseDialRef(opts.shadow!.trim(), '--shadow');
        dial = parsed;
        executorName = formatDialRef(parsed);
        sourceTag = 'flag';
      } catch {
        // A malformed ref still names a shadow attempt; it becomes a
        // shadow_resolution refusal row later.
        dial = null;
        executorName = opts.shadow!.trim();
        sourceTag = 'flag';
      }
    } else if (archetype != null) {
      const localStateForShadow = readLocalDialState(repoRoot);
      const att = localStateForShadow.shadows[archetype];
      if (att != null) {
        dial = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}) };
        executorName = formatDialRef(dial);
        sourceTag = 'attachment';
        attachmentRate = att.rate;
      }
    }
    if (executorName == null || sourceTag == null) return null;
    // Rate sampling for attachments; the flag always fires. Rolled before the
    // primary spawns — nothing about the primary's run can influence it.
    if (sourceTag === 'attachment' && attachmentRate != null) {
      const sampler = opts.shadowSampler ?? (() => shadowSampleRoll(promptSha256, archetype ?? '', executorName!));
      let roll: number;
      try { roll = sampler(); } catch { roll = 0; }
      if (!(roll < attachmentRate)) return null;
    }
    return { dial, executorName, sourceTag };
  };

  // Captured lazily and at most once. Both arms replay this same value; see
  // `CapturedWorkspaceBaseline` for why capturing per-arm would be wrong.
  let capturedBaselineMemo: CapturedWorkspaceBaseline | null = null;
  const capturedBaseline = (): CapturedWorkspaceBaseline => {
    if (capturedBaselineMemo == null) capturedBaselineMemo = captureWorkspaceBaseline(repoRoot);
    return capturedBaselineMemo;
  };

  // Pair candidacy, decided here and not later, because the request evidence
  // row below records `workspace_mode` and that record must be true when it
  // is written. A selected pair puts BOTH arms in worktrees — an in-session
  // or shared-tree primary emits only a `workspace_changed` boolean while its
  // challenger emits a real diff, and a boolean cannot be compared to a diff.
  //
  // Candidacy, not materialization: the challenger can still be refused below
  // (cap, resolution, eligibility, write posture, constraint, containment,
  // worktree, carry, baseline), and the primary stays isolated when it is.
  // That is the deliberate choice. Deciding after materialization would mean
  // either writing the row before the answer is known, or rewriting a fact
  // already on disk; and isolation is the safe direction to be wrong in —
  // an isolated primary that merges back cleanly is indistinguishable from a
  // shared one, whereas a shared primary in a selected pair produces evidence
  // that cannot be compared.
  const pairCandidate = decidePairCandidate();
  // Candidacy says a pair is WANTED. Whether the primary can be isolated is a
  // separate question, and conflating them silences evidence: a non-git repo
  // still gets its `shadow_isolation` refusal row from `startShadow` below —
  // the challenger is what cannot be built — while the primary must stay
  // shared, because isolating it would fail on the very same missing git.
  //
  // So the correction to a tempting piece of reasoning: isolation is NOT
  // simply the safe direction to be wrong in. Isolating can itself fail, and
  // when it does it turns a dispatch that used to work into a hard error.
  //
  // That correction is why isolation is the default only WHERE GIT ALLOWS IT.
  // With write posture gone, the worktree is the sole thing standing between
  // a dispatched executor and this tree, so every command dispatch takes one
  // by default rather than only pair candidates — but a repo without git
  // still degrades to shared instead of failing, and that degraded path is
  // exactly where nothing contains a writer. `--shared` opts out deliberately
  // (docs/experimental/permissions-and-isolation.md).
  const gitAvailable = (() => {
    const probe = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    return probe.error == null && probe.status === 0;
  })();
  // Resolved once, here, because it now decides two things rather than one:
  // whether a pair may form, and whether KERNEL-chosen isolation may happen at
  // all. Both for the identical reason — a worktree is merged back through
  // `git add -A`, which respects .gitignore, so gitignored output does not
  // survive it. While default isolation was declared but not delivered only
  // the first mattered; now that it delivers, isolating a `kept` dispatch
  // would destroy the very output the policy exists to protect.
  const ignoredOutputPolicy: 'kept' | 'discardable' = opts.ignoredOutput
    ?? (profile.archetypes[archetype ?? '']?.ignoredOutput ?? 'discardable');

  // WHO asked for the worktree. This is the axis that decides what happens to
  // the work inside it, and conflating it with "is there a pair?" is exactly
  // what kept default isolation from ever being delivered:
  //
  //   'requested' — the caller passed `--isolate`. The contract is HOLD OUT:
  //                 keep this work out of my tree. Never merged back.
  //   'kernel'    — Fadeno isolated it, with or without a pair. The caller
  //                 asked for a dispatch, not for a quarantine, so the work
  //                 merges back. Isolation buys containment during the run and
  //                 concurrency against other dispatches; it was never meant
  //                 to change where the work ends up.
  //
  // `--shared` opts out of both. The old code asked "is there a pair?" and so
  // had no answer for a third case — kernel isolation without a pair — which
  // it resolved by degrading straight back to shared. Under this split that
  // case is not special: it merges back like any other kernel isolation.
  let isolationWithheld: string | null = null;
  if (opts.shared !== true && opts.isolate !== true && ignoredOutputPolicy === 'kept') {
    isolationWithheld =
      'this dispatch declares `ignored_output: kept`, and an isolated worktree merges back through ' +
      '`git add -A`, which respects .gitignore — so gitignored output would not survive it';
  }
  // An explicit `--isolate` that cannot be honoured is refused, never
  // downgraded. The caller asked for containment; running in their tree
  // instead is the opposite of what they asked for, and doing it quietly is
  // the failure mode this project exists to prevent. Kernel isolation is the
  // opposite case — nobody asked, so shared is a fallback rather than a
  // betrayal, and refusing would turn working dispatches into hard errors.
  if (opts.isolate === true && opts.shared !== true && !gitAvailable) {
    throw new DispatchCommandError(
      '--isolate needs a git repository: an isolated worktree is cut with `git worktree add`, and this ' +
        'directory is not one. Refusing rather than running in your tree, which is what --isolate exists ' +
        'to prevent. Run `git init` first, or drop --isolate to accept a shared-tree dispatch.',
    );
  }
  const isolationOrigin: 'requested' | 'kernel' | null =
    opts.shared === true ? null
      : opts.isolate === true ? 'requested'
        : gitAvailable && isolationWithheld == null ? 'kernel'
          : null;
  const workspaceMode: WorkspaceMode = isolationOrigin == null ? 'shared' : 'isolated';
  // An isolated primary cannot touch the shared tree while it works, so it
  // takes no lease for the duration — it takes one only across its merge-back.
  // Net effect is MORE concurrency than a shared primary, which holds the
  // repo-wide lease for its entire run.
  //
  // Every shared dispatch now takes the lease: nothing declares itself a
  // non-writer any more, and the honest reading without that claim is that we
  // do not know.
  //
  // `let`, not `const`: kernel isolation can fail before the spawn (no
  // worktree, an uncarriable declared path, a baseline that will not replay)
  // and degrade to shared, and the shared tree may not be written unleased.
  // See the degradation path below, which acquires one at that point.
  let needsLease = workspaceMode === 'shared';
  const commandSha256 = sha256Hex(JSON.stringify(command));
  const producers = lookupInputProducers(repoRoot, producedByIds(opts));
  const dialField: Record<string, unknown> = { model: dial.model };
  if (dial.effort != null) dialField.effort = dial.effort;
  if (dial.via != null) dialField.via = dial.via;
  const identity: Record<string, unknown> = {
    dispatch_id: dispatchId,
    ...(tag != null ? { tag } : {}),
    archetype,
    role,
    resolution: ROW_RESOLUTION[source],
    dial: dialField,
    ...(resolvedVia != null ? { resolved_via: resolvedVia } : {}),
    executor: executorName,
    model: delivery.model,
    model_id: delivery.modelId,
    reasoning_effort: delivery.effectiveEffort,
    driver: delivery.driver,
    ...(delivery.provider != null ? { provider: delivery.provider } : {}),
    transport,
    workspace_mode: workspaceMode,
    ...(briefApplied != null ? { brief: briefApplied } : {}),
    delivery_transport: deliveryTransport,
    prompt_source: promptSource,
    prompt_snapshot: promptSnapshot,
    prompt_sha256: promptSha256,
    ...(relayAttested != null ? { relay_attested: relayAttested } : {}),
    command,
    command_sha256: commandSha256,
    ...(producers.length > 0 ? { input_provenance: provenanceFields(producers) } : {}),
  };

  // Boundary predicates, before the spawn. Each hard refusal appends one
  // `dispatch_refused` row (the request-point evidence) and throws; an
  // advisory provider clash warns and continues. There is no write-posture
  // predicate here any more: a route is an argv, and what it may do is the
  // vendor's business and the worktree's, not a claim for Fadeno to check.
  const deliveryChoice = { executor: executorName, spec };
  const eligibilityConflict = explainEligibilityConflict(deliveryChoice, archetype);
  if (eligibilityConflict != null) {
    refuseDispatch(repoRoot, identity, 'eligibility', eligibilityConflict, now);
  }
  const providerConflict = explainProviderConflict(
    archetype,
    delivery.provider ?? null,
    producers,
    profile,
  );
  if (providerConflict != null && providerConflict.level === 'refuse') {
    refuseDispatch(repoRoot, identity, 'provider_distinctness', providerConflict.message, now);
  }

  // Build dials maps as refString for constraint context
  const sessionMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(sessionDials)) sessionMap[k] = formatDialRef(v);
  const repoMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(repoDials)) repoMap[k] = formatDialRef(v);
  const userMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(userDials)) userMap[k] = formatDialRef(v);

  const constraintContext = {
    archetype,
    role,
    executor: executorName,
    driver: delivery.driver,
    provider: delivery.provider ?? null,
    model: delivery.model,
    model_id: delivery.modelId,
    transport: 'command' as const,
    // What will actually run, not what the catalog claimed about it.
    command,
    dial: dialField as unknown as DialRef,
    dial_source: ROW_RESOLUTION[source],
    dials: { session: sessionMap, repo: repoMap, user: userMap },
    resolved_via: resolvedVia,
    input_provenance: provenanceFields(producers),
    harness: profile.harness ?? 'standalone',
  } satisfies ConstraintContext;
  let constraintVerdict;
  try {
    constraintVerdict = evaluateConstraint(profile, constraintContext, { cwd: repoRoot });
  } catch (err) {
    if (err instanceof ConstraintError) {
      throw new DispatchCommandError(`constraint system error: ${err.message}`);
    }
    throw err;
  }
  if (constraintVerdict.verdict === 'refused') {
    refuseDispatch(repoRoot, identity, 'constraint_command', constraintVerdict.reason, now);
  }

  // Proceeding-only stamps: requested+completed, omit-when-absent. The
  // output snapshot joins here, not the shared identity: a refusal never
  // creates the file, so a dispatch_refused row must not name it.
  identity.output_snapshot = outputSnapshot;
  if (providerConflict != null && providerConflict.level === 'warn') {
    opts.onEcho?.(providerConflict.message);
    identity.provider_distinctness = 'warned';
  }
  if (eligibilityFor(spec, archetype) === 'shadow_only') {
    identity.eligibility = 'shadow_only';
    identity.gate_eligible = false;
  }

  const sourceLabel =
    source === 'model-flag' ? '--model' : roleResolutionEchoLabel(source as RoleResolutionSource);
  const echo =
    `${role ?? archetype ?? executorName} → ${executorName}` +
    `${delivery.model != null ? ` (${delivery.model})` : ''} [${sourceLabel}]` +
    '';
  opts.onEcho?.(echo);
  opts.onEcho?.(`external sandbox: ${executorName} (${command.join(' ')}) runs outside the current harness via ${transport}; evidence → ${DISPATCHES_FILE}`);
  // Delivering, not refusing — but say that this deliberately leaves a session
  // that would have handled the task in-house. Silence here is how a caller
  // ends up paying for a second session without ever deciding to.
  if (hostLaneNote != null) opts.onEcho?.(hostLaneNote);
  // Name the dispatch before it runs. Recovery after a kill used to have only
  // `--output last` to go on, which is a guess about the whole repo's log
  // rather than a handle on this call: a 2026-08-13 dogfood ran two dispatches
  // at once and one proxy recovered the other's report.
  //
  // This line alone is not enough, and a later dogfood proved it: echoing early
  // does not help a caller that is killed at its own timeout, because the
  // harness discards the stream along with the call. Hence `--tag`, which the
  // caller knows without reading anything. The echo stays for the callers that
  // do see it, and names the tag when there is one so the two handles never
  // have to be correlated after the fact.
  // `tag:<handle>`, not `--tag <handle>`: `--output` takes a value, so the
  // flag spelling would be swallowed as that value. Echoing a command that
  // does not parse is worse than echoing none.
  opts.onEcho?.(
    `dispatch id: ${dispatchId}${tag != null ? ` (tag: ${tag})` : ''} — recover its output with ` +
      `\`fadeno dispatches --output ${tag != null ? `tag:${tag}` : dispatchId.slice(0, 8)}\``,
  );
  if (tag == null) {
    // Said at spawn, not at recovery: by the time recovery is needed, the
    // caller can no longer act on it for this dispatch.
    opts.onEcho?.(
      'no --tag given: if this call is killed at a timeout you will lose this id. ' +
        'Pass `--tag <handle>` to make the report recoverable without it.',
    );
  }

  // Resolve effective timeout: one CLI override applies to every lane; without
  // one, each lane uses its own snapshotted route default.
  const timeoutFor = (laneSpec: CompiledDelivery['spec']): number | null => {
    if (opts.timeoutMs === 0) return null;
    if (typeof opts.timeoutMs === 'number' && Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0) {
      return opts.timeoutMs;
    }
    if (
      laneSpec.adapter === 'command' &&
      typeof laneSpec.timeoutMs === 'number' &&
      Number.isInteger(laneSpec.timeoutMs) &&
      laneSpec.timeoutMs > 0
    ) {
      return laneSpec.timeoutMs;
    }
    return null;
  };
  const effectiveTimeoutMs = timeoutFor(spec);

  // `let` for the same reason `needsLease` is: a kernel-isolated dispatch
  // starts with no lease and acquires one only if isolation fails before the
  // spawn and it has to fall back into the shared tree.
  let leaseHolder: LeaseHolder | null = needsLease
    ? { id: `ad-hoc:${dispatchId}`, kind: 'ad-hoc', dispatchId }
    : null;
  let dispatchLeaseExistingBefore: WorkspaceLeaseRecord | null = null;
  let dispatchLeaseAliveBefore = false;
  if (leaseHolder != null) {
    try {
      dispatchLeaseExistingBefore = readWorkspaceLease(repoRoot);
    } catch {
      dispatchLeaseExistingBefore = null;
    }
    dispatchLeaseAliveBefore = dispatchLeaseExistingBefore != null ? isWorkspaceLeaseAlive(dispatchLeaseExistingBefore) : false;
  }
  if (leaseHolder != null) {
    try {
      acquireWorkspaceLease({
        repoRoot,
        workspaceMode,
        holder: leaseHolder,
        // Durable pre-spawn reservation. The supervisor owns release after
        // its executor process group has actually closed; the blocked kernel
        // cannot safely stand in for that liveness fact.
        supervisorPid: null,
        executorPid: null,
        processGroupId: null,
        startedAt: now,
        heartbeatAt: now,
        stdoutBytes: 0,
        stderrBytes: 0,
        now,
      });
      // Audited reclaim: dead supervisor pid was reclaimed atomically inside the lock (contract 1.3).
      if (dispatchLeaseExistingBefore != null && !dispatchLeaseAliveBefore && dispatchLeaseExistingBefore.supervisor_pid != null) {
        try {
          appendEvidenceRow(repoRoot, {
            format: DISPATCHES_FORMAT,
            timestamp: now.toISOString(),
            event: 'workspace_lease_recovered',
            recovered_holder: leaseHolder,
            previous_holder: dispatchLeaseExistingBefore.holder,
            supervisor_pid: dispatchLeaseExistingBefore.supervisor_pid,
            reason: 'dead_supervisor',
            recovered_at: now.toISOString(),
            by: leaseHolder.id,
            dispatch_id: dispatchId,
          });
        } catch {}
      }
    } catch (err) {
      if (err instanceof WorkspaceLeaseError) {
        // Audited denial when refusing to reclaim an abandoned host reservation (pid-less, conservatively live).
        if (dispatchLeaseExistingBefore != null && dispatchLeaseAliveBefore && dispatchLeaseExistingBefore.supervisor_pid == null) {
          try {
            appendEvidenceRow(repoRoot, {
              format: DISPATCHES_FORMAT,
              timestamp: now.toISOString(),
              event: 'workspace_lease_reclaim_denied',
              recovered_holder: null,
              previous_holder: dispatchLeaseExistingBefore.holder,
              supervisor_pid: dispatchLeaseExistingBefore.supervisor_pid,
              reason: 'abandoned_host',
              recovered_at: now.toISOString(),
              by: leaseHolder.id,
              dispatch_id: dispatchId,
            });
          } catch {}
        }
        refuseDispatch(repoRoot, identity, 'workspace_lease', err.message, now);
      }
      throw err;
    }
  }

  try {
    appendEvidenceRow(repoRoot, {
      format: DISPATCHES_FORMAT,
      timestamp: now.toISOString(),
      event: 'dispatch_requested',
      ...identity,
    });
  } catch (error) {
    if (leaseHolder != null) {
      try { releaseWorkspaceLease({ repoRoot, holder: leaseHolder }); } catch {}
    }
    throw error;
  }

  // ---- Shadow duplication ---------------------------------------------------
  // Concurrent with the primary, not after it: the challenger is resolved,
  // isolated, and spawned BEFORE the primary runs, then collected once the
  // primary's completion row is down. Three properties fall out:
  //   - latency is max(primary, shadow) instead of their sum;
  //   - the worktree is cut from HEAD before the primary can move it, so both
  //     sides start from the same state (a primary that commits can no longer
  //     contaminate the comparison);
  //   - each side's `duration_ms` is its own supervisor-measured runtime, so
  //     time-to-complete is itself comparison evidence.
  // Still never on a primary refusal (those throw above, before this point),
  // and still unable to affect the primary's result: every failure in here
  // lands as a shadow refusal row or is swallowed.
  const startShadow = (): PendingShadow | null => {
    if (pairCandidate == null) return null;
    const shadowDial = pairCandidate.dial;
    const shadowExecutorNameInner: string | null = pairCandidate.executorName;
    const shadowSourceTag: 'flag' | 'attachment' = pairCandidate.sourceTag;

    const shadowNow = new Date();
    const shadowDispatchId = randomUUID();
    // Addresses the pair as one thing from the first row. Deriving it later
    // from `primary_dispatch_id` works only while one arm is privileged;
    // emitting it now costs a field and survives that stopping to be true.
    const pairId = randomUUID();
    const shadowId8 = shadowDispatchId.slice(0, 8);
    const shadowOutputRel = join('.fadeno', 'local', 'outputs', `shadow-${shadowId8}.md`).split('\\').join('/');
    const shadowOutputAbs = join(repoRoot, shadowOutputRel);
    const shadowDiffRel = join('.fadeno', 'local', 'outputs', `shadow-${shadowId8}.diff`).split('\\').join('/');
    const shadowDiffAbs = join(repoRoot, shadowDiffRel);
    // Neutral, and identically shaped to the primary's. Both arms of a pair
    // live at `.fadeno/local/pair/<pair-id8>/<own-dispatch-id8>`: same depth,
    // same shape, a random uuid on each. Blinding was advisory while this
    // said `shadow/` — either arm could read its own cwd and know which one
    // it was, which is exactly the knowledge a fair comparison must withhold.
    // `fadeno clean` finds retained worktrees through the `workspace` path
    // recorded on the ledger row rather than by globbing this location, so
    // moving it costs nothing there.
    const shadowWorktreeRel = join('.fadeno', 'local', 'pair', pairId.slice(0, 8), shadowId8).split('\\').join('/');
    const shadowWorktreeAbs = join(repoRoot, shadowWorktreeRel);

    const writeShadowRefusal = (predicate: DispatchRefusalPredicate, message: string, extra: Record<string, unknown> = {}): void => {
      const base: Record<string, unknown> = {
        format: DISPATCHES_FORMAT,
        timestamp: shadowNow.toISOString(),
        event: 'dispatch_refused',
        dispatch_id: shadowDispatchId,
        pair_id: pairId,
        archetype,
        role,
        resolution: 'shadow',
        shadow: true,
        primary_dispatch_id: dispatchId,
        executor: shadowExecutorNameInner,
        ...extra,
        refusal: { predicate, message },
      };
      // Trim undefined extras but keep shape; leave minimal for unknown target case.
      if (base.executor == null) delete base.executor;
      appendEvidenceRow(repoRoot, base);
      opts.onEcho?.(`shadow refused: ${message} [${predicate}]`);
    };

    // Cap before resolution: a refused-for-capacity challenger is evidence a
    // comparison you expected did not happen, so it lands as a row rather than
    // vanishing the way an unfired sample does.
    const cap = shadowLiveCap();
    const live = countLiveShadows(repoRoot);
    if (live >= cap) {
      writeShadowRefusal('shadow_cap', `${live} shadow${live === 1 ? ' is' : 's are'} already running and the live cap is ${cap} — raise FADENO_SHADOW_MAX_LIVE or let one finish.`);
      return null;
    }

    // A pair moves the PRIMARY off in-session delivery onto its own command
    // lane (`spec.fallbackCommand`, selected above), so the pair is only as
    // capable as that lane is — independent of how capable the challenger's
    // own target is, because the challenger resolves its own delivery below
    // and is not confined to the primary's argv. That asymmetry is the whole
    // reason this refuses: a primary stuck on an unwritable lane compared
    // against a challenger that is not stuck on it measures the lanes, not
    // the models.
    // Checked here, not folded into `decidePairCandidate`: candidacy says a
    // pair is WANTED, this is a capability question decided after, and a
    // refusal row here is what lets a user who attached a shadow at
    // `--rate 1.0` and sees no pairs find out why from `fadeno dispatches`.
    const primaryRoutability = explainPairRoutability(spec, executorName);
    if (!primaryRoutability.routable) {
      writeShadowRefusal('shadow_no_command_lane', primaryRoutability.reason);
      return null;
    }

    // Resolve shadow delivery via compile
    let shadowDelivery: CompiledDelivery;
    if (shadowDial != null) {
      try {
        shadowDelivery = compileDialRef(shadowDial, profile);
      } catch (err) {
        const msg = err instanceof ExecutorProfileError ? err.message : String(err);
        writeShadowRefusal('shadow_resolution', msg);
        return null;
      }
    } else {
      writeShadowRefusal('shadow_resolution', `shadow target "${shadowExecutorNameInner}" is not a valid dial ref.`);
      return null;
    }
    if (shadowDelivery.spec.adapter === 'host') {
      writeShadowRefusal('shadow_resolution', `shadow executor "${shadowExecutorNameInner}" is a host executor — the kernel cannot duplicate a host dispatch.`, {
        model: shadowDelivery.model,
        model_id: shadowDelivery.modelId,
        driver: shadowDelivery.driver,
        reasoning_effort: shadowDelivery.effectiveEffort,
        transport: 'host',
      });
      return null;
    }
    const shadowSpec = shadowDelivery.spec;
    const shadowRefString = shadowDelivery.refString;
    // Eligibility: forbidden refuses, shadow_only allowed
    const eligibilityState = eligibilityFor(shadowSpec, archetype);
    if (eligibilityState === 'forbidden') {
      const msg = explainEligibilityConflict({ executor: shadowRefString, spec: shadowSpec }, archetype) ?? `archetype "${archetype}" is forbidden on executor "${shadowRefString}".`;
      writeShadowRefusal('eligibility', msg, { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effectiveEffort, transport: 'command' });
      return null;
    }
    // Constraint check with shadow:true
    const sSessionMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(sessionDials)) sSessionMap[k] = formatDialRef(v);
    const sRepoMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(repoDials)) sRepoMap[k] = formatDialRef(v);
    const sUserMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(userDials)) sUserMap[k] = formatDialRef(v);
    const sDialField = { model: shadowDial.model, ...(shadowDial.effort ? { effort: shadowDial.effort } : {}), ...(shadowDial.via ? { via: shadowDial.via } : {}) };
    const shadowConstraintContext = {
      archetype,
      role,
      executor: shadowRefString,
      driver: shadowDelivery.driver,
      provider: shadowDelivery.provider ?? null,
      model: shadowDelivery.model,
      model_id: shadowDelivery.modelId,
      transport: 'command' as const,
      command: shadowSpec.adapter === 'command' ? shadowSpec.command : null,
      dial: sDialField as DialRef,
      dial_source: 'shadow',
      dials: { session: sSessionMap, repo: sRepoMap, user: sUserMap },
      resolved_via: resolvedVia,
      input_provenance: provenanceFields(producers),
      harness: profile.harness ?? 'standalone',
      shadow: true,
    } satisfies ConstraintContext;
    let shadowConstraintVerdict;
    try {
      shadowConstraintVerdict = evaluateConstraint(profile, shadowConstraintContext, { cwd: repoRoot });
    } catch (err) {
      if (err instanceof ConstraintError) {
        // A primary lets a constraint SYSTEM error bubble loudly; a shadow
        // must never take the primary's result down with it, so the same
        // error lands as a shadow_resolution refusal row.
        writeShadowRefusal('shadow_resolution', `shadow constraint system error: ${err.message}`);
        return null;
      }
      throw err;
    }
    if (shadowConstraintVerdict.verdict === 'refused') {
      writeShadowRefusal('constraint_command', shadowConstraintVerdict.reason, { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effectiveEffort, transport: 'command' });
      return null;
    }

    // Gitignored output. A pair merges the primary back through a diff built
    // by `git add -A`, which respects `.gitignore` — so any gitignored output
    // an arm produced is discarded. A dispatch that needs that output must
    // therefore not be paired.
    //
    // A REFUSAL rather than a repair, deliberately. The alternative designs
    // were carrying gitignored paths back (which needs them named in advance,
    // the same problem `worktree_carry` already has) or letting the arm
    // report what it made (which would make carry-back depend on what a model
    // chose to mention — two runs of one pair could then carry different
    // sets, and the pair would stop being a controlled comparison, which is
    // the whole reason it exists). Skipping is always correct and costs a
    // comparison, never work.
    //
    // Refused HERE, at materialization, and not by returning null from
    // `decidePairCandidate` — suppressing candidacy writes no row at all, and
    // "no pair, and here is why" is the entire value. The primary stays
    // shared exactly as an unpaired dispatch's does.
    if (ignoredOutputPolicy === 'kept') {
      writeShadowRefusal(
        'ignored_output_kept',
        `this dispatch declares \`ignored_output: kept\`, and a pair cannot preserve it: both arms run in ` +
          `worktrees and the primary is merged back through \`git add -A\`, which respects .gitignore — so any ` +
          `gitignored output would be discarded. No pair was formed, and for the same reason this dispatch ` +
          `also runs in the shared tree rather than the isolated worktree that is otherwise the default. ` +
          `This is a trade, not a fault: a comparison AND containment were given up to protect the work. Set ` +
          `\`ignored_output: discardable\` on the archetype, or pass \`--ignored-output discardable\`, if this ` +
          `task's gitignored output is intermediate and safe to lose.`,
        { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effectiveEffort, transport: 'command' },
      );
      return null;
    }

    // Containment. Byte-identical prompts are what makes the pair a fair
    // test, but that same identity means a prompt naming this repo's
    // absolute root sends the challenger straight into the primary's tree
    // the moment it opens that path — cwd isolation is advisory against an
    // absolute reference, not a real boundary. Checked here, after every
    // earlier refusal (cap, resolution, eligibility, write posture,
    // constraint) and before the worktree that would need it exists: those
    // earlier checks decide whether a shadow would fire AT ALL, so running
    // containment after them means a more fundamental refusal reason is
    // reported instead of being masked by a containment refusal on a shadow
    // that was never going to fire anyway. Checked before worktree creation
    // rather than after-plus-cleanup, on the same "refuse before you build"
    // instinct that puts the cap ahead of resolution above — refusing before
    // creating is simpler than creating and removing.
    if (prompt.includes(repoRoot)) {
      writeShadowRefusal(
        'shadow_containment',
        `the prompt contains this repo's absolute path ("${repoRoot}") — both arms receive byte-identical prompt bytes, so a prompt naming absolute repo paths cannot be isolated: the challenger would follow that path straight into the primary's tree. Rewrite it repo-relative (drop the "${repoRoot}/" prefix) to make the pair possible.`,
        { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effectiveEffort, transport: 'command' },
      );
      return null;
    }

    // Isolation. Cut from HEAD before the primary spawns: both sides start
    // from the same committed state, whatever the primary goes on to do.
    try { spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
    const addResult = spawnSync('git', ['worktree', 'add', '--detach', shadowWorktreeAbs, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    if (addResult.error != null || addResult.status !== 0) {
      const reason = addResult.error?.message ?? (addResult.stderr != null ? String(addResult.stderr).trim() : '') ?? 'worktree add failed';
      writeShadowRefusal('shadow_isolation', reason.length > 0 ? reason : 'shadow worktree could not be created');
      return null;
    }

    // Worktree carry. Declared paths are almost always gitignored (deps,
    // build output, a local `.fadeno/` catalog), so the checkout above never
    // puts them here — this is what closes that gap. Run before the baseline
    // commit below (which writes git objects) so a carry failure is caught
    // before that costlier step runs; order otherwise does not matter, since
    // gitignored paths are invisible to the baseline's `git diff`/`git
    // apply`/`git add -A` regardless of when they land.
    const shadowCarry = carryDeclaredPaths(repoRoot, shadowWorktreeAbs, profile.worktreeCarry);
    const carryRecords = shadowCarry.records;
    const carryFingerprint = shadowCarry.fingerprint;
    if (shadowCarry.failure != null) {
      writeShadowRefusal(
        'shadow_carry',
        `declared worktree_carry path "${shadowCarry.failure.path}" exists but could not be carried into the shadow worktree by any mechanism (${shadowCarry.failure.reason}) — refusing the pair rather than running a challenger whose build state does not match what was declared.`,
      );
      try { spawnSync('git', ['worktree', 'remove', '--force', shadowWorktreeAbs], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
      try { spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
      return null;
    }

    // Workspace baseline. The worktree above is a clean checkout of HEAD, but
    // the primary works from the real workspace — usually dirty. Replay the
    // primary's pre-spawn state into the worktree as one commit, before the
    // challenger is spawned, so the pair's starting state is an addressable
    // commit shared by both arms rather than an implicit asymmetry between
    // them. A tree that cannot be snapshotted must not silently produce a
    // skewed pair, so it refuses loudly instead — and the worktree just
    // created is removed, since a refused baseline must not leak a
    // registered worktree the success path would otherwise retain.
    let baselineCommit: string;
    try {
      baselineCommit = applyWorkspaceBaseline(repoRoot, shadowWorktreeAbs, capturedBaseline(), pairId, 'challenger');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeShadowRefusal('shadow_baseline', message);
      try { spawnSync('git', ['worktree', 'remove', '--force', shadowWorktreeAbs], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
      try { spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
      return null;
    }

    // Echo fire line
    const sModel = shadowDelivery.model;
    const shadowModelSuffix = sModel != null ? ` (${sModel})` : '';
    opts.onEcho?.(`shadow → ${shadowExecutorNameInner}${shadowModelSuffix} [command, concurrent with primary]`);
    // Build shadow request row identity (mirrors primary but shadow-specific)
    // The snapshot lives in the main repo; the worktree child reads it by
    // absolute path.
    const shadowCommand = substitutePromptFile((shadowSpec as { command: string[] }).command, promptFileAbs);
    const shadowCommandSha = sha256Hex(JSON.stringify(shadowCommand));
    const shadowDialField: Record<string, unknown> = { model: shadowDial.model };
    if (shadowDial.effort != null) shadowDialField.effort = shadowDial.effort;
    if (shadowDial.via != null) shadowDialField.via = shadowDial.via;
    const shadowIdentity: Record<string, unknown> = {
      dispatch_id: shadowDispatchId,
      pair_id: pairId,
      archetype,
      role,
      resolution: 'shadow',
      shadow: true,
      primary_dispatch_id: dispatchId,
      shadow_source: shadowSourceTag,
      gate_eligible: false,
      dial: shadowDialField,
      ...(resolvedVia != null ? { resolved_via: resolvedVia } : {}),
      executor: shadowExecutorNameInner,
      model: shadowDelivery.model,
      model_id: shadowDelivery.modelId,
      reasoning_effort: shadowDelivery.effectiveEffort,
      driver: shadowDelivery.driver,
      ...(shadowDelivery.provider != null ? { provider: shadowDelivery.provider } : {}),
      transport: 'command',
      delivery_transport: 'command',
      prompt_source: promptSource,
      prompt_snapshot: promptSnapshot,
      prompt_sha256: promptSha256,
      command: shadowCommand,
      command_sha256: shadowCommandSha,
      output_snapshot: shadowOutputRel,
      // Retained after collection so the pair stays reviewable; recording the
      // path is what lets a later cleaner enumerate rather than glob.
      workspace: shadowWorktreeRel,
      // Same value on both arms: the pair's starting state is one addressable
      // commit rather than an implicit one. HEAD when the primary's tree was
      // clean (nothing was replayed), the replay commit otherwise.
      baseline_commit: baselineCommit,
    };
    if (eligibilityState === 'shadow_only') {
      shadowIdentity.eligibility = 'shadow_only';
    }
    // Absent when nothing was declared or nothing declared existed, matching
    // the "absent declaration = carry nothing" rule below — omitted rather
    // than an empty array, consistent with how `eligibility` above is only
    // ever added, never defaulted. Present on both the request and
    // completion rows, since `pending.identity` is spread into the
    // completion row unchanged: a pair's arms are then checkable as warmed
    // the same way from either row.
    if (carryRecords.length > 0) {
      shadowIdentity.worktree_carry = carryRecords;
    }
    appendEvidenceRow(repoRoot, {
      format: DISPATCHES_FORMAT,
      timestamp: shadowNow.toISOString(),
      event: 'dispatch_requested',
      ...shadowIdentity,
    });

    // The prompt reaches the child as an fd on the attested snapshot, not as
    // kernel-pumped stdin bytes: the kernel is about to block inside the
    // primary's spawnSync, where it can pump nothing.
    let promptFd: number;
    try {
      promptFd = openSync(promptFileAbs, 'r');
    } catch {
      const fallbackAbs = join(repoRoot, '.fadeno', 'local', 'prompts', `shadow-${shadowId8}.md`);
      mkdirSync(join(repoRoot, '.fadeno', 'local', 'prompts'), { recursive: true });
      writeFileSync(fallbackAbs, prompt, 'utf8');
      promptFd = openSync(fallbackAbs, 'r');
    }
    mkdirSync(join(repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
    mkdirSync(join(repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
    const shadowInflightAbs = join(repoRoot, ...INFLIGHT_DIR.split('/'), `${shadowDispatchId}.json`);
    const statusAbs = join(repoRoot, ...INFLIGHT_DIR.split('/'), `${shadowDispatchId}.status.json`);
    const sfd = openSync(shadowOutputAbs, 'w');
    const startedMs = Date.now();
    let child: ChildProcess;
    try {
      // Its own supervisor, for the same reason as the primary — a killed
      // kernel must not orphan it — plus the exit report that concurrent
      // collection depends on. The claim file makes a long-running shadow
      // cancellable by its own id.
      child = spawn(process.execPath, superviseArgv(shadowCommand, shadowInflightAbs, statusAbs, undefined, timeoutFor(shadowSpec)), {
        cwd: shadowWorktreeAbs,
        // Without `atCwd` the shadow escapes its worktree and edits the real
        // workspace. FADENO_IN_SHADOW rides along so any fadeno the challenger
        // runs — at any depth — declines to fire challengers of its own.
        env: { ...atCwd(withoutHarnessIdentity(process.env), shadowWorktreeAbs), FADENO_IN_SHADOW: '1' },
        stdio: [promptFd, sfd, 'ignore'],
      });
    } finally {
      // The child holds its own copies once spawned.
      closeSync(promptFd);
      closeSync(sfd);
    }
    child.unref();
    const markerAbs = join(repoRoot, ...INFLIGHT_DIR.split('/'), `${shadowDispatchId}${SHADOW_MARKER_SUFFIX}`);
    try {
      writeFileSync(markerAbs, `${JSON.stringify({
        pair_id: pairId,
        dispatch_id: shadowDispatchId,
        primary_dispatch_id: dispatchId,
        archetype,
        supervisor_pid: child.pid ?? null,
        started_at: shadowNow.toISOString(),
        workspace: shadowWorktreeRel,
      })}\n`, 'utf8');
    } catch {
      // Best-effort: the lease bounds concurrency, it never gates the shadow.
    }
    return {
      dispatchId: shadowDispatchId,
      pairId,
      baselineCommit,
      markerAbs,
      startedAt: shadowNow,
      startedMs,
      identity: shadowIdentity,
      child,
      statusAbs,
      inflightAbs: shadowInflightAbs,
      outputRel: shadowOutputRel,
      outputAbs: shadowOutputAbs,
      diffRel: shadowDiffRel,
      diffAbs: shadowDiffAbs,
      worktreeAbs: shadowWorktreeAbs,
      worktreeRel: shadowWorktreeRel,
      carryFingerprint,
    };
  };

  const collectShadow = (pending: PendingShadow): void => {
    try {
    // Wait out the challenger. Its supervisor reports through a file because
    // this process was blocked inside the primary's spawnSync while the
    // shadow ran — no event loop turned to deliver an exit event, and none
    // turns here either: the wait is a synchronous poll, with a liveness
    // probe so a supervisor that died reportless cannot hang the kernel.
    let polls = 0;
    while (!existsSync(pending.statusAbs)) {
      polls += 1;
      if (polls % SHADOW_LIVENESS_EVERY === 0 && pending.child.pid != null && !supervisorCanStillReport(pending.child.pid)) break;
      sleepSync(SHADOW_POLL_MS);
    }
    // Read after the loop unconditionally: the report may have landed between
    // the last existence check and a failed liveness probe.
    const status = readSupervisorStatus(pending.statusAbs, (p) => readFileSync(p, 'utf8'));
    try { rmSync(pending.statusAbs, { force: true }); } catch { /* nothing to drop */ }
    // Belt and braces, as for the primary: the supervisor unlinks its own
    // claim, but a SIGKILLed one runs no handler.
    try { rmSync(pending.inflightAbs, { force: true }); } catch { /* nothing to drop */ }

    const spawnFailedMsg = status == null
      ? 'shadow supervisor ended without an exit report'
      : status.spawnFailed;
    const sExitCode = spawnFailedMsg != null ? null : status!.exitCode;
    const sSignal = status?.signal ?? null;
    // The supervisor's own measurement, never "when the kernel looked": a
    // shadow that finished mid-primary is collected long after it ended.
    const sDuration = status?.durationMs ?? (Date.now() - pending.startedMs);

    let sStdout = '';
    try { sStdout = readFileSync(pending.outputAbs, 'utf8'); } catch { sStdout = ''; }
    const sOutputSha = sha256Hex(sStdout);
    // Diff capture after exit (any exit code)
    let diffBytes = 0;
    let diffContent = '';
    try {
      spawnSync('git', ['-C', pending.worktreeAbs, 'add', '-A'], { encoding: 'utf8' });
      const diffRes = spawnSync('git', ['-C', pending.worktreeAbs, 'diff', '--binary', '--cached'], { encoding: 'utf8', maxBuffer: SPAWN_MAX_BUFFER });
      if (diffRes.error == null && diffRes.status === 0) {
        diffContent = diffRes.stdout ?? '';
      } else if (diffRes.stdout != null) {
        diffContent = String(diffRes.stdout);
      }
    } catch {}
    try {
      mkdirSync(join(repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
      writeFileSync(pending.diffAbs, diffContent, 'utf8');
      diffBytes = Buffer.byteLength(diffContent);
    } catch {
      diffBytes = Buffer.byteLength(diffContent);
    }
    const sOutputBytes = Buffer.byteLength(sStdout);
    const sIsTimeout = status?.timedOut === true;
    const sOutcome = deriveDispatchOutcome({
      exitCode: sExitCode,
      signal: sSignal as NodeJS.Signals | null,
      error: spawnFailedMsg,
      outputBytes: sOutputBytes,
      timedOut: sIsTimeout ? true : null,
    });
    const sRow: Record<string, unknown> = {
      format: DISPATCHES_FORMAT,
      // Same rule as the primary: start plus measured duration, so
      // `completed - requested == duration_ms` holds for shadow pairs too
      // rather than drifting by whatever the wall clock read between the two
      // writes.
      timestamp: new Date(pending.startedAt.getTime() + sDuration).toISOString(),
      event: 'dispatch_completed',
      ...pending.identity,
      exit_code: sExitCode,
      ...(sSignal != null ? { signal: sSignal } : {}),
      duration_ms: sDuration,
      output_sha256: sOutputSha,
      output_bytes: sOutputBytes,
      ...(sOutcome != null ? { outcome: sOutcome } : {}),
      ...(sIsTimeout && status?.timeoutMs != null ? { timeout_ms: status.timeoutMs } : {}),
      ...(sIsTimeout && status?.deadlineAt != null ? { deadline_at: status.deadlineAt } : {}),
      diff_snapshot: pending.diffRel,
      diff_bytes: diffBytes,
    };
    // Mutation through a shared inode: declared paths carried by hardlink are
    // one inode in two trees, so a challenger tool that wrote one IN PLACE
    // changed the primary's copy with it. Checked here, after the challenger
    // exited and while its worktree is still retained. Evidence only — the
    // stamp never repairs, reverts, or deletes. Absent when clean.
    const shadowCarryMutation = carryMutationStamp(verifyCarriedPaths(repoRoot, pending.carryFingerprint));
    if (shadowCarryMutation != null) sRow.carry_mutated = shadowCarryMutation;
    // The challenger's worktree is RETAINED, so this could run later — but it
    // runs now, beside the primary's, so both arms of a pair are measured the
    // same way at the same point in their lifecycle. A challenger's ignored
    // output is discarded too: nothing merges its worktree back at all.
    const shadowIgnored = scanIgnoredOutput(pending.worktreeAbs, profile.worktreeCarry);
    if (shadowIgnored.paths.length > 0 || shadowIgnored.truncated) {
      sRow.ignored_output_discarded = {
        paths: shadowIgnored.paths,
        ...(shadowIgnored.truncated ? { truncated: true } : {}),
        ...(shadowIgnored.note != null ? { note: shadowIgnored.note } : {}),
        // "Discarded" means two different things on the two arms, and the row
        // has to say which. The challenger's worktree is RETAINED until
        // `fadeno clean`, so its output is still on disk right here — gone
        // from the comparison, not gone from the machine. The primary's
        // worktree is torn down after the merge-back, so its output really is
        // unrecoverable and this field is absent there. A reader must never
        // have to infer the difference from whether some other field happens
        // to be set.
        retained_at: pending.worktreeRel,
      };
    }
    if (spawnFailedMsg != null) sRow.error = spawnFailedMsg;
    // Shadow completions OMIT workspace_changed by construction
    appendEvidenceRow(repoRoot, sRow);
    opts.onEcho?.(`shadow diff: ${diffBytes} bytes → ${pending.diffRel}`);
    } finally {
      // The worktree is RETAINED: it is the challenger's work product, and a
      // pair is judged later — often much later — so deleting it here would
      // throw away half the comparison the moment it finished. The recorded
      // `workspace` path is how the post-shadow cleaner finds it. What is
      // released here is the live-shadow lease, in a finally: a primary
      // receipt failure or a shadow evidence failure must not permanently
      // consume a slot under the cap.
      try { rmSync(pending.markerAbs, { force: true }); } catch { /* nothing to drop */ }
    }
  };

  let pendingShadow: PendingShadow | null = null;
  try {
    pendingShadow = startShadow();
  } catch {
    // Shadow failures must never affect primary result
  }
  let shadowCollectionAttempted = false;
  const finishPendingShadow = (): void => {
    if (pendingShadow == null || shadowCollectionAttempted) return;
    shadowCollectionAttempted = true;
    try {
      collectShadow(pendingShadow);
    } catch {
      // Shadow failures must never affect primary result. collectShadow's
      // finally still removes its detached worktree.
    }
  };

  try {

  // Isolated worktree handoff metadata. The full create/action/diff/remove
  // lifecycle is owned by withIsolatedWorktree below, including action errors.
  let isolatedDiffRel: string | null = null;
  let isolatedDiffBytes: number | null = null;
  // Same gap as a shadow's challenger worktree, and the same declaration:
  // `git worktree add` checks out tracked content only, so an isolated
  // delivery gets no `node_modules`, no `dist` — it cannot build or test
  // either, for reasons that have nothing to do with the work it was asked
  // to do. Populated below, inside the isolated branch only.
  let isolatedCarryRecords: Array<{ path: string; mechanism: WorktreeCarryMechanism }> = [];
  let isolatedCarryFingerprint: CarryFingerprint | null = null;
  // Annotated and read through a helper rather than narrowed inline: the only
  // assignment happens inside the `withIsolatedWorktree` callback, and TS's
  // control-flow analysis collapses the union to `null` at the row-projection
  // site below, so a direct `!= null` there narrows to `never`.
  let isolatedIgnoredOutput: IgnoredOutputScan | null = null;
  const takeIsolatedIgnoredOutput = (): IgnoredOutputScan | null => isolatedIgnoredOutput;
  // The commit the isolated worktree's diff is relative to, for an UNPAIRED
  // isolated delivery. A pair's copy of this lives on `pendingShadow` and is
  // shared by both arms; this is the same fact for a dispatch that has no
  // second arm to share it with, and it is what makes the recorded diff
  // re-appliable with `git apply --3way` after the worktree is gone.
  let isolatedBaselineCommit: string | null = null;
  const takeIsolatedBaselineCommit = (): string | null => isolatedBaselineCommit;
  // The mode actually used. `workspaceMode` is the INTENT recorded on the
  // request row; this is what happened. They differ only when kernel-chosen
  // isolation could not be prepared before the spawn (see the degradation
  // below) — an explicit `--isolate` refuses instead of degrading.
  let effectiveWorkspaceMode: WorkspaceMode = workspaceMode;
  let isolationDegraded: string | null = null;
  /** True once the executor has actually run inside the worktree. Gates the
   * degradation below: a failure BEFORE the spawn can fall back into the
   * shared tree because nothing has happened yet, while a failure after it
   * must not — re-invoking would run the executor twice. */
  let executorRanInWorktree = false;
  /** Merge-back outcome for a kernel-isolated delivery; absent otherwise. */
  // `diff_snapshot` is deliberately NOT repeated here: the completion row
  // already carries it, and two spellings of one fact is the same defect that
  // rules out a `skipped` status.
  //
  //   clean      — applied, nothing left to do
  //   conflicted — git tried; the tree MAY be partially applied
  //   blocked    — never attempted; the tree is untouched
  let primaryMerge: {
    status: 'clean' | 'conflicted' | 'blocked';
    detail?: string;
  } | null = null;

  // stdout is the snapshot fd so bytes survive a mid-flight SIGTERM;
  // encoding/maxBuffer then apply to stderr only. input still feeds stdin.
  // The supervisor publishes the claim here; the kernel only says where. See
  // `superviseArgv` — spawnSync yields a pid too late to be of any use.
  const inflightAbs = join(repoRoot, ...INFLIGHT_DIR.split('/'), `${dispatchId}.json`);
  const statusAbs = inflightAbs.replace(/\.json$/, '.status.json');
  const workspaceBefore = workspaceMode === 'isolated' ? null : workspaceFingerprint(repoRoot);
  const started = Date.now();
  let spawned: SpawnSyncReturns<string>;
  let outputFd: number | null = null;
  let supervisorAttempted = false;
  let supervisorTerminalObserved = false;
  try {
    mkdirSync(join(repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
    mkdirSync(join(repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
    outputFd = openSync(outputAbs, 'w');
    // Read at spawn time, not hoisted: a kernel-isolated dispatch whose
    // worktree could not be prepared acquires a lease on its way into the
    // shared tree, and the supervisor is what releases it once the executor's
    // process group closes. A `const` captured before that fallback would hand
    // the supervisor `undefined` and leak the lease for its full staleness
    // window.
    const leaseRelease = (): { leasePath: string; lockPath: string; holder: LeaseHolder } | undefined =>
      leaseHolder == null ? undefined : {
        leasePath: join(repoRoot, WORKSPACE_LEASE_FILE),
        lockPath: join(repoRoot, WORKSPACE_LEASE_LOCK),
        holder: leaseHolder,
      };
    const invoke = (spawnCwd: string): SpawnSyncReturns<string> => {
      supervisorAttempted = true;
      const result = spawnSync(
        process.execPath,
        superviseArgv(command, inflightAbs, statusAbs, leaseRelease(), effectiveTimeoutMs),
        {
        input: prompt,
        encoding: 'utf8',
        cwd: spawnCwd,
        // The child is a different session, usually a different host. Inheriting
        // our harness identity would tell a `codex exec` worker it is inside
        // Claude; it establishes its own.
        env: atCwd(withoutHarnessIdentity(process.env), spawnCwd),
        maxBuffer: SPAWN_MAX_BUFFER,
        stdio: ['pipe', outputFd, 'pipe'],
        },
      );
      supervisorTerminalObserved = result.error != null || readSupervisorStatus(statusAbs, (path) => readFileSync(path, 'utf8')) != null;
      return result;
    };
    // Through the supervisor, never directly: `spawnSync` blocks the event
    // loop, so a killed kernel runs no cleanup and leaves the executor writing
    // the tree unattended. See src/lib/supervisor.ts.
    // No pair-materialization check here any more. It used to read: if the
    // challenger fell through for any reason (cap, resolution, eligibility,
    // constraint, containment, worktree, carry, baseline) and the caller did
    // not pass `--isolate`, drop the primary back to shared. That made the
    // request row's `workspace_mode: isolated` a promise the completion row
    // routinely broke, and it was the single reason default isolation was
    // declared but never delivered. An unpaired kernel-isolated primary is
    // now an ordinary case: it runs in a worktree and merges back.
    // Returns the spawn result rather than assigning `spawned`, so TypeScript
    // can still see `spawned` as definitely assigned — a closure write would
    // defeat that, and the fallback below depends on the compiler proving one
    // of the two paths ran.
    const runIsolated = (): SpawnSyncReturns<string> => {
      const id8 = dispatchId.slice(0, 8);
      const diffRel = join('.fadeno', 'local', 'outputs', `isolated-${id8}.diff`).split('\\').join('/');
      // Neutral worktree naming when paired. Blinding was advisory before
      // this: the challenger sat at `.fadeno/local/shadow/<id>` and the
      // primary at `.fadeno/local/isolated/<id>`, so either arm could read
      // its own cwd and know which one it was. Under a pair both arms live at
      // `.fadeno/local/pair/<pair-id8>/<own-dispatch-id8>` — same depth, same
      // shape, and a random uuid prefix on each, so the path says only that
      // this is one arm of some pair. The unpaired `--isolate` case keeps its
      // old home: there is no second arm to be blind to.
      const pairedWorktree = pendingShadow != null
        ? join(repoRoot, '.fadeno', 'local', 'pair', pendingShadow.pairId.slice(0, 8), id8)
        : join(repoRoot, '.fadeno', 'local', 'isolated', id8);
      const isolated = withIsolatedWorktree({
        repoRoot,
        worktreePath: pairedWorktree,
        diffRel,
        diffAbs: join(repoRoot, diffRel),
        onEcho: opts.onEcho,
      }, (worktreeAbs) => {
        // Carry before the executor ever runs, same ordering reason as the
        // shadow side: a failed carry must refuse before the more expensive
        // (and, here, the only) work happens, not after.
        const isolatedCarry = carryDeclaredPaths(repoRoot, worktreeAbs, profile.worktreeCarry);
        if (isolatedCarry.failure != null) {
          throw new WorkspaceLeaseError(
            `declared worktree_carry path "${isolatedCarry.failure.path}" exists but could not be carried into the isolated worktree by any mechanism (${isolatedCarry.failure.reason}) — refusing the dispatch rather than running it against an incomplete checkout.`,
          );
        }
        isolatedCarryRecords = isolatedCarry.records;
        isolatedCarryFingerprint = isolatedCarry.fingerprint;
        // Replay the caller's pre-spawn state. `git worktree add` cuts a clean
        // checkout of HEAD, so without this the executor works against a tree
        // that is missing every uncommitted change the caller has — and then
        // its diff gets applied back onto a tree that HAS them. That is not a
        // near-miss; it is the executor solving a different problem and the
        // merge-back conflicting on work it never saw.
        //
        // Applied to EVERY isolated delivery, not just a paired one. For a
        // pair it removes an asymmetry (the challenger already replays it, so
        // a clean-HEAD primary would be the arm reading a different tree). For
        // an unpaired one it is plain correctness. Making the two cases differ
        // would also mean `--isolate` — documented as "already the default" —
        // silently handed the executor a different checkout than the default
        // did, which is the shape of trap this codebase keeps paying for.
        //
        // `capturedBaseline()` is memoized, so a paired primary replays the
        // identical bytes the challenger did, not a second read of a tree that
        // may have moved since.
        const baselineRef = pendingShadow?.pairId ?? dispatchId;
        const primaryBaseline = applyWorkspaceBaseline(
          repoRoot, worktreeAbs, capturedBaseline(), baselineRef, pendingShadow != null ? 'primary' : 'isolated',
        );
        isolatedBaselineCommit = primaryBaseline;
        // Same content, same fixed dates, same parent — so the same sha.
        // If these ever diverge the arms did not start from the same state
        // and the pair is not a fair test, which is worth failing over
        // rather than recording a `baseline_commit` that only one arm has.
        if (pendingShadow != null && primaryBaseline !== pendingShadow.baselineCommit) {
          throw new WorkspaceLeaseError(
            `the pair's two arms produced different baseline commits (${primaryBaseline.slice(0, 12)} vs ` +
              `${pendingShadow.baselineCommit.slice(0, 12)}) — they did not start from the same state, so the ` +
              'comparison would be meaningless. Refusing rather than recording a baseline only one arm has.',
          );
        }
        const spawnedInWorktree = invoke(worktreeAbs);
        // Set the instant the executor has run, and never reset. Everything
        // above this line is recoverable by falling back to a shared-tree
        // dispatch; nothing below it is.
        executorRanInWorktree = true;
        // Scanned here, inside the callback, because `withIsolatedWorktree`
        // removes the worktree on its way out — and after the executor has
        // run, because before it there is nothing but the carry to find.
        // `git add -A` respects .gitignore, so whatever this names is about
        // to die with the worktree unless something says so first.
        isolatedIgnoredOutput = scanIgnoredOutput(worktreeAbs, profile.worktreeCarry);
        return spawnedInWorktree;
      });
      isolatedDiffRel = isolated.diff.diffRel;
      isolatedDiffBytes = isolated.diff.diffBytes;
      opts.onEcho?.(`isolated diff: ${isolated.diff.diffBytes} bytes → ${isolated.diff.diffRel}`);
      // ---- Merge-back -----------------------------------------------------
      // Keyed on WHO asked for the worktree, not on whether a pair exists.
      //
      // `--isolate` is an explicit request to keep the work out of the tree,
      // and auto-applying it would break that contract. Every other isolated
      // delivery was isolated by the kernel's choice rather than the
      // caller's — the caller asked for a dispatch, and leaving its work
      // stranded in a discarded worktree would silently change what `fadeno
      // dispatch --archetype worker` does to the repo.
      //
      // This used to read `pendingShadow != null`, which answered the wrong
      // question: it made merge-back depend on a probabilistic shadow roll, so
      // the one case it could not describe — kernel isolation with no pair —
      // was resolved by refusing to isolate at all.
      if (isolationOrigin === 'kernel') {
        // The lease, held across the apply and nothing else. An isolated
        // primary takes none while it works — it cannot reach the shared tree
        // — but the apply is exactly the moment it can, so it must not race a
        // concurrent shared-mode writer.
        const mergeHolder: LeaseHolder = { id: `merge-back:${dispatchId}`, kind: 'ad-hoc', dispatchId };
        let leaseTaken = false;
        try {
          acquireWorkspaceLease({
            repoRoot,
            workspaceMode: 'shared',
            holder: mergeHolder,
            supervisorPid: null,
            executorPid: null,
          });
          leaseTaken = true;
        } catch (err) {
          // Could not serialize, so do not apply. The diff is durable and can
          // be ported once the tree settles — `fadeno shadow-apply` for a
          // pair, `git apply --3way <diff_snapshot>` for an unpaired
          // dispatch; applying anyway is the one outcome that could corrupt
          // another writer.
          // NOT `conflicted`. A conflict means git tried and left the tree
          // partly applied; this means nothing was attempted and the
          // workspace is untouched. Collapsing the two would make a reader
          // go inspect `git status` after a run that never wrote anything,
          // and the only thing distinguishing them would be `detail`, which
          // is free-form human text nothing should parse.
          primaryMerge = {
            status: 'blocked',
            detail: `nothing was applied: could not acquire the workspace lease for merge-back (${err instanceof Error ? err.message : String(err)})`,
          };
        }
        if (leaseTaken) {
          try {
            // Real `--3way`, never `--check`: it exits non-zero the moment any
            // file is left carrying conflict markers, which is the signal we
            // need. `--check` would exit 0 on a patch that WOULD conflict.
            const applyRes = spawnSync('git', ['-C', repoRoot, 'apply', '--3way', join(repoRoot, isolated.diff.diffRel)], { encoding: 'utf8' });
            const stderrText = String(applyRes.stderr ?? '').trim();
            if (isolated.diff.diffBytes === 0) {
              primaryMerge = { status: 'clean', detail: 'nothing to apply: the primary made no changes' };
            } else if (applyRes.status === 0) {
              primaryMerge = { status: 'clean' };
              opts.onEcho?.(`merged back: ${isolated.diff.diffBytes} bytes applied to the workspace`);
            } else {
              // Nothing is reverted. `--3way` may have staged some hunks
              // cleanly while leaving others unmerged, and guessing which is
              // which is exactly the judgment this kernel does not make.
              primaryMerge = {
                status: 'conflicted',
                detail: stderrText.length > 0 ? stderrText : `git apply --3way exited ${applyRes.status ?? 'unknown'}`,
              };
              // Two recovery pointers, because there are two shapes of
              // isolated delivery now. A pair has a `shadow-apply` entry
              // point that knows both arms and their baselines; an unpaired
              // dispatch has no pair id to name, so it gets the raw
              // equivalent — the same `--3way` against the same baseline
              // commit, which is exactly what `shadow-apply` would run.
              // Naming a command that cannot resolve would be worse than
              // naming none.
              const recovery = pendingShadow != null
                ? `Resolve with \`fadeno shadow-apply ${pendingShadow.pairId.slice(0, 8)} --arm primary\``
                : `Resolve with \`git apply --3way ${isolated.diff.diffRel}\``;
              opts.onEcho?.(
                `merge-back CONFLICTED — the dispatch's work is kept at ${isolated.diff.diffRel}. ` +
                  `${recovery} once the tree settles; inspect \`git status\` first, some hunks may already be staged.`,
              );
            }
          } finally {
            // Released whatever happened, including on a conflict: the lease
            // exists to serialize writers, not to hold the repo hostage while
            // a human resolves markers.
            try { releaseWorkspaceLease({ repoRoot, holder: mergeHolder }); } catch {}
          }
        }
      }
      return isolated.result;
    };

    if (effectiveWorkspaceMode === 'isolated') {
      try {
        spawned = runIsolated();
      } catch (isolationError) {
        // Nothing below the spawn is recoverable: re-invoking would run the
        // executor a second time, and an executor that has already written a
        // worktree is not a thing to retry. Nor is an explicit `--isolate`
        // recoverable at all — the caller asked for containment, so silently
        // supplying none is the one answer that is worse than failing.
        if (executorRanInWorktree || isolationOrigin !== 'kernel') throw isolationError;

        // A kernel-isolated dispatch that could not build its worktree
        // (`git worktree add` refused, a declared `worktree_carry:` path would
        // not carry, the baseline would not replay) falls back to the shared
        // tree rather than failing. Nobody asked for isolation here, and the
        // permissions cut's own design note is explicit that making isolation
        // mandatory would turn dispatches that work today into hard errors.
        const reason = isolationError instanceof Error ? isolationError.message : String(isolationError);

        // The lease is the part that must not be waved through. A shared-tree
        // dispatch holds the repo-wide writer lease for its whole run, and
        // this one is about to become exactly that — with nothing left to
        // contain it, since the worktree is what failed. If the lease cannot
        // be taken, another writer holds the tree, and the honest outcome is
        // the original isolation failure rather than an unleased write.
        leaseHolder = { id: `ad-hoc:${dispatchId}`, kind: 'ad-hoc', dispatchId };
        try {
          acquireWorkspaceLease({
            repoRoot,
            workspaceMode: 'shared',
            holder: leaseHolder,
            supervisorPid: null,
            executorPid: null,
            processGroupId: null,
            startedAt: now,
            heartbeatAt: now,
            stdoutBytes: 0,
            stderrBytes: 0,
            now,
          });
          needsLease = true;
        } catch {
          leaseHolder = null;
          throw isolationError;
        }

        effectiveWorkspaceMode = 'shared';
        isolationDegraded = `the isolated worktree could not be prepared (${reason})`;
        spawned = invoke(repoRoot);
      }
    } else {
      spawned = invoke(repoRoot);
    }
    if (isolationDegraded != null) {
      // Kernel-chosen isolation that could not be built. The realistic causes
      // are an uncarriable declared path and a `git worktree add` that git
      // itself refused. The dispatch runs in the shared tree instead — the
      // request row's `workspace_mode` said `isolated` because that was the
      // intent when it was written, and the completion row records what
      // actually happened with `workspace_mode_degraded` naming why the two
      // differ, rather than leaving a reader to notice the discrepancy alone.
      //
      // Loud on purpose. This is the one path where nothing stands between
      // the executor and this tree, and it is reached by accident rather than
      // by anyone's choice.
      opts.onEcho?.(`isolation degraded to shared: ${isolationDegraded}`);
    }
  } catch (error) {
    if (error instanceof WorkspaceLeaseError) throw new DispatchCommandError(error.message);
    throw error;
  } finally {
    if (outputFd != null) closeSync(outputFd);
    // A terminal status is proof the supervisor observed child close. With no
    // status (notably SIGKILL/OOM), preserve both claim and lease: the detached
    // executor may still be mutating the workspace and remains cancellable.
    if (!supervisorAttempted || supervisorTerminalObserved) {
      try { rmSync(inflightAbs, { force: true }); } catch { /* nothing to drop */ }
      if (leaseHolder != null) {
        try { releaseWorkspaceLease({ repoRoot, holder: leaseHolder }); } catch {}
      }
    }
  }
  const durationMs = Date.now() - started;
  // `spawnSync` now spawns the supervisor, which always starts, so its `error`
  // no longer reports a missing executor. The supervisor reports that itself.
  const spawnFailure =
    spawned.error?.message ?? supervisedSpawnError(spawned.status, spawned.stderr);

  const stdout = readFileSync(outputAbs, 'utf8');
  const stderr = spawned.stderr ?? '';
  const outputSha256 = sha256Hex(stdout);
  const workspaceAfter = effectiveWorkspaceMode === 'isolated' ? null : workspaceFingerprint(repoRoot);

  const outputBytes = Buffer.byteLength(stdout);
  // Status-file timeout facts outrank the supervisor process exit signal when classifying a receipt.
  const supervisorStatus = readSupervisorStatus(statusAbs, (path) => {
    try { return readFileSync(path, 'utf8'); } catch { return '{}'; }
  });
  const isTimeout = supervisorStatus?.timedOut === true;
  const outcome = deriveDispatchOutcome({
    exitCode: spawnFailure != null ? null : spawned.status,
    signal: spawned.signal,
    error: spawnFailure,
    outputBytes,
    timedOut: isTimeout ? true : null,
  });

  // Bounded opt-in diagnostics: machine-local only, never ledger-persisted
  // beyond the evidence row's byte counters. Written atomically under
  // .fadeno/local/outputs/diagnostics/dispatch-<id>.log when enabled via
  // --diagnostics or FADENO_DIAGNOSTICS=1. Bounded to 32 KiB / 500 lines per
  // stream with head+tail sampling and a single truncation marker. Never gates.
  let diagnosticsRel: string | null = null;
  let diagnosticsBytes: number | null = null;
  const diagnosticsEnabled = isDiagnosticsEnabled({ diagnostics: opts.diagnostics });
  if (diagnosticsEnabled) {
    try {
      const truncatedStdout = truncateDiagnostics(stdout, 'stdout');
      const truncatedStderr = truncateDiagnostics(stderr, 'stderr');
      const content = `# diagnostics for dispatch ${dispatchId}\n# stdout_bytes=${outputBytes} stderr_bytes=${Buffer.byteLength(stderr, 'utf8')}\n--- stdout ---\n${truncatedStdout}\n--- stderr ---\n${truncatedStderr}\n`;
      const diagRel = join('.fadeno', 'local', 'outputs', 'diagnostics', `dispatch-${dispatchId}.log`).split('\\').join('/');
      const diagAbs = join(repoRoot, diagRel);
      mkdirSync(join(repoRoot, '.fadeno', 'local', 'outputs', 'diagnostics'), { recursive: true });
      const tmp = `${diagAbs}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(tmp, content, 'utf8');
      try {
        renameSync(tmp, diagAbs);
        diagnosticsRel = diagRel;
        diagnosticsBytes = Buffer.byteLength(content, 'utf8');
      } catch {
        try { rmSync(tmp, { force: true }); } catch {}
      }
      opts.onEcho?.(`diagnostics: ${diagnosticsBytes ?? 0} bytes → ${diagRel}`);
    } catch {
      // diagnostics never gates control flow
    }
  }
  // When this dispatch actually ended, not when it began.
  //
  // Both rows of a pair used to be stamped from the same clock reading, so a
  // `dispatch_completed` row's `timestamp` was the dispatch's *start* — the one
  // field a reader would reach for to answer "when did this finish?" answered a
  // different question, silently, and a ten-minute dispatch looked instantaneous.
  //
  // Derived from `now` plus the measured duration rather than read fresh off
  // the wall clock, so the pair stays internally consistent (`completed -
  // requested == duration_ms`, exactly) and an injected clock still produces a
  // deterministic log.
  const completedAt = new Date(now.getTime() + durationMs);
  const row: Record<string, unknown> = {
    format: DISPATCHES_FORMAT,
    timestamp: completedAt.toISOString(),
    event: 'dispatch_completed',
    ...identity,
    exit_code: spawnFailure != null ? null : spawned.status,
    ...(spawned.signal != null ? { signal: spawned.signal } : {}),
    duration_ms: durationMs,
    output_sha256: outputSha256,
    output_bytes: outputBytes,
    // Stated next to the event name so a row read on its own cannot pass as
    // success on the strength of `dispatch_completed` alone.
    ...(outcome != null ? { outcome } : {}),
    ...(isTimeout && supervisorStatus?.timeoutMs != null ? { timeout_ms: supervisorStatus.timeoutMs } : {}),
    ...(isTimeout && supervisorStatus?.deadlineAt != null ? { deadline_at: supervisorStatus.deadlineAt } : {}),
    // Only when a challenger actually fired. The primary's request row was
    // written before the roll, so this is the first row that can carry it.
    ...(pendingShadow != null ? { pair_id: pendingShadow.pairId, baseline_commit: pendingShadow.baselineCommit } : {}),
  };
  // An unpaired isolated delivery records its baseline too. `diff_snapshot`
  // below is a patch relative to this commit and nothing else, so without it
  // the diff is only re-appliable by luck: `git apply --3way` needs the blob
  // SHAs the patch names to be findable, and after the worktree is torn down
  // this commit is the one place they still are. A pair already carried this
  // field for exactly that reason; there was never a reason it should be a
  // pair-only fact.
  if (pendingShadow == null && effectiveWorkspaceMode === 'isolated') {
    const soloBaseline = takeIsolatedBaselineCommit();
    if (soloBaseline != null) row.baseline_commit = soloBaseline;
  }
  // Concurrent writers make this attestation, not judgment.
  if (workspaceBefore != null && workspaceAfter != null) {
    row.workspace_changed = workspaceBefore !== workspaceAfter;
  }
  if (effectiveWorkspaceMode === 'isolated' && isolatedDiffRel != null && isolatedDiffBytes != null) {
    row.diff_snapshot = isolatedDiffRel;
    row.diff_bytes = isolatedDiffBytes;
  }
  // Omitted entirely when no merge-back was attempted — an unpaired
  // `--isolate`, or a shared primary — rather than written as a "skipped"
  // status. Absence already says "nothing was attempted", and a status value
  // meaning the same thing would give a reader two spellings for one fact.
  if (primaryMerge != null) {
    row.primary_merge = primaryMerge;
  }
  // What actually happened, alongside the intent the request row recorded.
  // Written only when the two differ, so an ordinary dispatch's rows are
  // untouched and a reader never has to diff two rows to notice a fallback.
  if (isolationDegraded != null) {
    row.workspace_mode = effectiveWorkspaceMode;
    row.workspace_mode_degraded = isolationDegraded;
  }
  // Absent when nothing was declared or nothing declared existed, matching
  // the shadow row's same convention above.
  // Gitignored output that will not survive. Recorded whenever the scan found
  // something OR could not be sure it found everything: a truncated scan with
  // a non-empty list is a floor, never a set, and "I could not tell" must not
  // be spelled the same as "there was nothing".
  const primaryIgnored = takeIsolatedIgnoredOutput();
  if (primaryIgnored != null && (primaryIgnored.paths.length > 0 || primaryIgnored.truncated)) {
    row.ignored_output_discarded = {
      paths: primaryIgnored.paths,
      ...(primaryIgnored.truncated ? { truncated: true } : {}),
      ...(primaryIgnored.note != null ? { note: primaryIgnored.note } : {}),
    };
  }
  // Same shared-inode hazard on this arm, and it matters MORE here than on
  // the challenger: this is the arm whose work is kept, so a hardlinked file
  // it wrote in place has already reached the caller's tree by a channel the
  // merge-back never sees. Correct even though `withIsolatedWorktree` has
  // already removed the worktree — a link-count change is not treated as
  // drift, so teardown does not read as mutation.
  if (isolatedCarryFingerprint != null) {
    const primaryCarryMutation = carryMutationStamp(verifyCarriedPaths(repoRoot, isolatedCarryFingerprint));
    if (primaryCarryMutation != null) row.carry_mutated = primaryCarryMutation;
  }
  if (effectiveWorkspaceMode === 'isolated' && isolatedCarryRecords.length > 0) {
    row.worktree_carry = isolatedCarryRecords;
  }
  // Isolated deliveries omit workspace_changed by construction (contract 1.2)
  if (effectiveWorkspaceMode === 'isolated') {
    delete (row as Record<string, unknown>).workspace_changed;
  }
  if (diagnosticsRel != null && diagnosticsBytes != null) {
    row.diagnostics_snapshot = diagnosticsRel;
    row.diagnostics_bytes = diagnosticsBytes;
  }
  if (spawnFailure != null) row.error = spawnFailure;
  appendEvidenceRow(repoRoot, row);

  // Collect the concurrent shadow only now, after the primary's completion
  // row is down: row order stays primary-request, shadow-request,
  // primary-completed, shadow-completed, and a shadow that outlives the
  // primary is waited out here.
  finishPendingShadow();

  if (spawnFailure != null) {
    throw new DispatchCommandError(
      `executor "${executorName}" failed to spawn: ${spawnFailure}`,
    );
  }

  return {
    dispatchId,
    promptSource,
    promptSnapshot,
    relayAttested,
    archetype,
    role,
    dial,
    dialSource: source,
    executor: executorName,
    model: delivery.model,
    modelId: delivery.modelId,
    provider: delivery.provider ?? null,
    driver: delivery.driver,
    reasoningEffort: delivery.effectiveEffort,
    source,
    echo,
    exitCode: spawned.status ?? 1,
    stdout,
    stderr: spawned.stderr ?? '',
    durationMs,
    promptSha256,
    outputSha256,
    outputBytes,
    outcome,
    evidencePath: DISPATCHES_FILE,
    transport,
  };
  } finally {
    // The primary can throw after the challenger has started (for example,
    // while persisting its completion receipt). Always reap and collect the
    // shadow once so its worktree cannot leak on that exceptional path.
    finishPendingShadow();
  }
}

/** Deliver one immutable engine host request through its declared command fallback. */
export function runDispatchFallback(opts: DispatchFallbackOptions): DispatchFallbackResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const lookup = readHostDispatchRequest({ repoRoot, run: opts.run, dispatchId: opts.dispatchId });
  const request = lookup.request;
  const profile = hostRequestProfile(lookup);
  const spec = profile.executors[request.executor];
  if (spec == null || spec.adapter !== 'host') {
    throw new DispatchCommandError(`locked request executor "${request.executor}" is not a host executor.`);
  }
  if (spec.fallbackCommand == null) {
    throw new DispatchCommandError(`host executor "${request.executor}" has no fallback_command.`);
  }
  if (spec.model !== request.model || spec.reasoningEffort !== request.reasoningEffort || (spec.agentType !== '*' && spec.agentType !== request.agentType)) {
    throw new DispatchCommandError(`locked request identity no longer matches executor "${request.executor}" in its profile snapshot.`);
  }
  if (lookup.terminal != null) {
    if (
      lookup.terminal.extra.delivery_transport !== 'command-fallback' ||
      JSON.stringify(lookup.terminal.extra.fallback_command ?? null) !== JSON.stringify(spec.fallbackCommand)
    ) {
      throw new DispatchCommandError(`host dispatch "${request.dispatchId}" was not delivered through its declared command fallback.`);
    }
    if (lookup.terminal.type === 'actor_completed' && typeof lookup.terminal.extra.output === 'string') {
      const output = lockedRunFile(lookup.runDir, lookup.terminal.extra.output, 'completed output');
      const stdout = readFileSync(output, 'utf8');
      if (lookup.terminal.extra.output_sha256 !== sha256Hex(stdout)) {
        throw new DispatchCommandError('locked request completed output no longer matches its receipt digest.');
      }
      return {
        dispatchId: request.dispatchId,
        executor: request.executor,
        model: request.model,
        exitCode: 0,
        stdout,
        stderr: '',
        idempotent: true,
      };
    }
    return {
      dispatchId: request.dispatchId,
      executor: request.executor,
      model: request.model,
      exitCode: 1,
      stdout: '',
      stderr: String(lookup.terminal.extra.failure_reason ?? 'fallback dispatch already failed'),
      idempotent: true,
    };
  }
  const promptPath = lockedRunFile(lookup.runDir, request.promptPath, 'prompt');
  const prompt = readFileSync(promptPath, 'utf8');
  if (sha256Hex(prompt) !== request.promptSha256) {
    throw new DispatchCommandError(`locked request prompt digest does not match ${request.promptPath}.`);
  }
  const command = substitutePromptFile(spec.fallbackCommand, promptPath);
  opts.onEcho?.(`locked host fallback: ${request.executor} (${command.join(' ')})`);
  startHostDispatch({
    repoRoot,
    run: request.run,
    dispatchId: request.dispatchId,
    agentId: `command-fallback:${request.executor}`,
    transport: 'command-fallback',
    command,
    now: opts.now,
  });
  const fallbackClaimAbs = join(
    repoRoot,
    ...fallbackClaimRelPath(lookup.runId, request.dispatchId).split('/'),
  );
  mkdirSync(join(repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
  const spawned = (() => {
    try {
      // A command fallback has the same orphan risk as every other command
      // delivery. Its host-dispatch lease is intentionally NOT handed to the
      // supervisor: that durable reservation remains held until the terminal
      // complete/fail receipt below, per the host protocol.
      return spawnSync(process.execPath, superviseArgv(command, fallbackClaimAbs), {
        input: prompt,
        encoding: 'utf8',
        cwd: repoRoot,
        env: atCwd(withoutHarnessIdentity(process.env), repoRoot),
        maxBuffer: SPAWN_MAX_BUFFER,
      });
    } finally {
      rmSync(fallbackClaimAbs, { force: true });
    }
  })();
  const stdout = spawned.stdout ?? '';
  const stderr = spawned.stderr ?? '';
  const fallbackSpawnFailure = spawned.error?.message ?? supervisedSpawnError(spawned.status, stderr);
  if (fallbackSpawnFailure != null || spawned.status !== 0 || spawned.signal != null) {
    const reason = fallbackSpawnFailure ?? (spawned.signal != null
      ? `fallback command was terminated by ${spawned.signal}`
      : `fallback command exited ${spawned.status ?? 1}${stderr ? `: ${stderr.trim()}` : ''}`);
    failHostDispatch({ repoRoot, run: request.run, dispatchId: request.dispatchId, reason, now: opts.now });
    return {
      dispatchId: request.dispatchId,
      executor: request.executor,
      model: request.model,
      exitCode: spawned.status ?? 1,
      stdout,
      stderr,
      idempotent: false,
    };
  }
  const temporaryDir = mkdtempSync(join(tmpdir(), 'fadeno-fallback-'));
  const temporaryOutput = join(temporaryDir, 'output');
  try {
    writeFileSync(temporaryOutput, stdout, 'utf8');
    completeHostDispatch({ repoRoot, run: request.run, dispatchId: request.dispatchId, output: temporaryOutput, now: opts.now });
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
  return {
    dispatchId: request.dispatchId,
    executor: request.executor,
    model: request.model,
    exitCode: 0,
    stdout,
    stderr,
    idempotent: false,
  };
}

export function runDispatchStart(opts: DispatchStartOptions): HostDispatchReceipt {
  try {
    return startHostDispatch(opts);
  } catch (err) {
    if (err instanceof Error) throw new DispatchCommandError(err.message);
    throw err;
  }
}

export function runDispatchComplete(opts: DispatchCompleteOptions): HostDispatchReceipt {
  try {
    return completeHostDispatch(opts);
  } catch (err) {
    if (err instanceof Error) throw new DispatchCommandError(err.message);
    throw err;
  }
}

export function runDispatchFail(opts: DispatchFailOptions): HostDispatchReceipt {
  try {
    return failHostDispatch(opts);
  } catch (err) {
    if (err instanceof Error) throw new DispatchCommandError(err.message);
    throw err;
  }
}

export function runDispatchProgress(opts: DispatchProgressOptions): HostDispatchProgressReceipt {
  try {
    return progressHostDispatch(opts);
  } catch (err) {
    if (err instanceof Error) throw new DispatchCommandError(err.message);
    throw err;
  }
}

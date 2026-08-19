import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import {
  ConstraintError,
  evaluateConstraint,
  type ConstraintContext,
} from '../lib/constraints.ts';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  eligibilityFor,
  substitutePromptFile,
  explainEligibilityConflict,
  explainProviderConflict,
  applyWritePosture,
  explainWriteConflict,
  loadExecutorProfile,
  readLocalDialState,
  dispatchability,
  resolveRole,
  compileDialRef,
  parseDialRef,
  formatDialRef,
  forcesWritePosture,
  roleResolutionEchoLabel,
  withoutHarnessIdentity,
  atCwd,
  type ExecutorProfile,
  type CompiledDelivery,
  type InputProducer,
  type DialRef,
  type RoleResolutionSource,
  type WritePosture,
} from '../lib/executors.ts';
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
import { INFLIGHT_DIR, readSupervisorStatus, sleepSync, superviseArgv, supervisedSpawnError, supervisorCanStillReport } from '../lib/supervisor.ts';
import {
  WORKSPACE_LEASE_FILE,
  WORKSPACE_LEASE_LOCK,
  acquireWorkspaceLease,
  isWorkspaceLeaseAlive,
  readWorkspaceLease,
  releaseWorkspaceLease,
  withIsolatedWorktree,
  WorkspaceLeaseError,
  type LeaseHolder,
  type WorkspaceLeaseRecord,
  type WorkspaceMode,
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

const PENDING_RELAY_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Match the received prompt against spawn-side attestations. A hit consumes
 * its entry and attests the proxy copied the prompt verbatim (modulo the one
 * trailing newline a heredoc appends); fresh entries with no hit mean the
 * relay altered the prompt (`false`); no fresh entries — non-hook flows —
 * record nothing (`null`). Evidence-only: never blocks the dispatch.
 */
function consumePendingRelay(repoRoot: string, prompt: string, now: Date): boolean | null {
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
  | 'write_posture'
  | 'eligibility'
  | 'provider_distinctness'
  | 'constraint_command'
  | 'shadow_isolation'
  | 'shadow_resolution'
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

function declaredWritePosture(
  profile: ExecutorProfile,
  archetype: string | null,
): WritePosture | null {
  if (archetype == null || !Object.hasOwn(profile.archetypes, archetype)) return null;
  return profile.archetypes[archetype]!.requiresWrite;
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
  isolate?: boolean;
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
}

/** How often shadow collection re-checks for the supervisor's exit report. */
const SHADOW_POLL_MS = 50;
const SHADOW_LIVENESS_EVERY = 20;

function workspaceFingerprint(repoRoot: string): string | null {
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.error != null || status.status !== 0) return null;
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.error != null || head.status !== 0) return null;
  return sha256Hex(`${status.stdout ?? ''}\0${head.stdout ?? ''}`);
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
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
      throw err;
    }
  }

  const harness = profile.harness ?? 'standalone';
  // Write-posture delivery selection: a write-requiring archetype resolving
  // onto a read-only route that declares a write variant gets the variant
  // argv. The catalog authorized this when it declared both; the dial only
  // named the model.
  const postured = applyWritePosture(delivery.spec, archetype, profile.archetypes);
  const spec = postured.spec;
  const usedWriteVariant = postured.usedWriteVariant;
  const executorName = delivery.refString;
  const deliverable = dispatchability(spec, harness);
  if (!deliverable.supported) {
    const hostOnDemand = deliverable.reason === 'host_in_session';
    const shape = archetype ?? role ?? 'role';
    throw new DispatchCommandError(
      hostOnDemand
        ? `resolved to host executor "${executorName}", which the ${harness} harness runs in-session in ` +
          `this session; dispatching its fallback_command would hand the task to a subprocess of the ` +
          `same harness and re-enter this dispatch one level down. Run this ${shape}-shaped task with ` +
          `the in-session ${archetype ?? 'role'} agent, or bind a command executor.`
        : `resolved to host executor "${executorName}"; ad-hoc dispatch invokes command adapters only — ` +
          `run this ${shape}-shaped task with the in-session ` +
          `${archetype ?? 'role'} agent instead, declare fallback_command on the executor, or bind a ` +
          'command executor.',
    );
  }
  let command = spec.adapter === 'command' ? spec.command : spec.fallbackCommand!;
  const transport = spec.adapter === 'command' ? 'command' : 'host-command-fallback';
  const deliveryTransport = spec.adapter === 'command' ? 'command' : 'host-command-fallback';

  if (opts.isolate && opts.shadow != null && String(opts.shadow).trim() !== '') {
    throw new DispatchCommandError('--isolate conflicts with --shadow: both use worktrees — run one or the other.');
  }
  const workspaceMode: WorkspaceMode = opts.isolate ? 'isolated' : 'shared';
  const needsLease = workspaceMode === 'shared' && spec.writeAccess !== false;

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

  const relayAttested = consumePendingRelay(repoRoot, prompt, now);

  const promptSha256 = sha256Hex(prompt);
  const commandSha256 = sha256Hex(JSON.stringify(command));
  const producers = lookupInputProducers(repoRoot, producedByIds(opts));
  const dialField: Record<string, unknown> = { model: dial.model };
  if (dial.effort != null) dialField.effort = dial.effort;
  if (dial.via != null) dialField.via = dial.via;
  const writePostureForced = forcesWritePosture(dial, resolvedVia);
  if (writePostureForced) dialField.force_write_posture = true;
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
    reasoning_effort: delivery.effort,
    driver: delivery.driver,
    ...(delivery.provider != null ? { provider: delivery.provider } : {}),
    transport,
    workspace_mode: workspaceMode,
    ...(spec.writeAccess != null ? { write_access: spec.writeAccess } : {}),
    ...(usedWriteVariant ? { write_variant: true } : {}),
    ...(writePostureForced ? { write_posture_forced: true } : {}),
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

  // Boundary predicates, after write posture, before the spawn. Each hard
  // refusal appends one `dispatch_refused` row (the request-point evidence)
  // and throws; an advisory provider clash warns and continues.
  const deliveryChoice = { executor: executorName, spec };
  const writeConflict = explainWriteConflict(deliveryChoice, archetype, profile);
  if (writeConflict != null && !writePostureForced) {
    refuseDispatch(repoRoot, identity, 'write_posture', writeConflict, now);
  }
  if (writeConflict != null && writePostureForced) {
    opts.onEcho?.(
      `WARNING: FORCED WRITE-POSTURE MISMATCH — dispatch is proceeding because this dial was set with --force. ${writeConflict}`,
    );
  }
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
    write_access: spec.writeAccess,
    ...(usedWriteVariant ? { write_variant: true } : {}),
    write_posture: declaredWritePosture(profile, archetype),
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
    (usedWriteVariant ? ' [write variant]' : '') +
    (spec.writeAccess === false ? ' [write_access: none]' : '');
  opts.onEcho?.(echo);
  opts.onEcho?.(`external sandbox: ${executorName} (${command.join(' ')}) runs outside the current harness via ${transport}; evidence → ${DISPATCHES_FILE}`);
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

  const leaseHolder: LeaseHolder | null = needsLease
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
    const hasFlag = typeof opts.shadow === 'string' && opts.shadow.trim().length > 0;
    let shadowDial: DialRef | null = null;
    let shadowExecutorNameInner: string | null = null;
    let shadowSourceTag: 'flag' | 'attachment' | null = null;
    let attachmentRate: number | undefined;
    if (hasFlag) {
      try {
        const parsed = parseDialRef(opts.shadow!.trim(), '--shadow');
        shadowDial = parsed;
        shadowExecutorNameInner = formatDialRef(parsed);
        shadowSourceTag = 'flag';
      } catch {
        // A malformed ref still names a shadow attempt; it becomes a
        // shadow_resolution refusal row below.
        shadowDial = null;
        shadowExecutorNameInner = opts.shadow!.trim();
        shadowSourceTag = 'flag';
      }
    } else if (archetype != null) {
      const localStateForShadow = readLocalDialState(repoRoot);
      const att = localStateForShadow.shadows[archetype];
      if (att != null) {
        shadowDial = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}) };
        shadowExecutorNameInner = formatDialRef(shadowDial);
        shadowSourceTag = 'attachment';
        attachmentRate = att.rate;
      }
    }
    if (shadowExecutorNameInner == null || shadowSourceTag == null) return null;
    // Rate sampling for attachments; the flag always fires. Rolled before the
    // primary spawns — nothing about the primary's run can influence it.
    if (shadowSourceTag === 'attachment' && attachmentRate != null) {
      const sampler = opts.shadowSampler ?? Math.random;
      let roll: number;
      try { roll = sampler(); } catch { roll = 0; }
      if (!(roll < attachmentRate)) return null;
    }

    const shadowNow = new Date();
    const shadowDispatchId = randomUUID();
    const shadowId8 = shadowDispatchId.slice(0, 8);
    const shadowOutputRel = join('.fadeno', 'local', 'outputs', `shadow-${shadowId8}.md`).split('\\').join('/');
    const shadowOutputAbs = join(repoRoot, shadowOutputRel);
    const shadowDiffRel = join('.fadeno', 'local', 'outputs', `shadow-${shadowId8}.diff`).split('\\').join('/');
    const shadowDiffAbs = join(repoRoot, shadowDiffRel);
    const shadowWorktreeRel = join('.fadeno', 'local', 'shadow', shadowId8).split('\\').join('/');
    const shadowWorktreeAbs = join(repoRoot, shadowWorktreeRel);

    const writeShadowRefusal = (predicate: DispatchRefusalPredicate, message: string, extra: Record<string, unknown> = {}): void => {
      const base: Record<string, unknown> = {
        format: DISPATCHES_FORMAT,
        timestamp: shadowNow.toISOString(),
        event: 'dispatch_refused',
        dispatch_id: shadowDispatchId,
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
        reasoning_effort: shadowDelivery.effort,
        transport: 'host',
      });
      return null;
    }
    // Shadows duplicate the primary's shape, so a write-requiring
    // archetype's challenger gets the same posture selection.
    const shadowPostured = applyWritePosture(shadowDelivery.spec, archetype, profile.archetypes);
    const shadowSpec = shadowPostured.spec;
    const shadowUsedWriteVariant = shadowPostured.usedWriteVariant;
    const shadowRefString = shadowDelivery.refString;
    // Eligibility: forbidden refuses, shadow_only allowed
    const eligibilityState = eligibilityFor(shadowSpec, archetype);
    if (eligibilityState === 'forbidden') {
      const msg = explainEligibilityConflict({ executor: shadowRefString, spec: shadowSpec }, archetype) ?? `archetype "${archetype}" is forbidden on executor "${shadowRefString}".`;
      writeShadowRefusal('eligibility', msg, { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effort, transport: 'command' });
      return null;
    }
    const shadowWriteConflict = explainWriteConflict({ executor: shadowRefString, spec: shadowSpec }, archetype, profile);
    if (shadowWriteConflict != null) {
      writeShadowRefusal('write_posture', shadowWriteConflict, { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effort, transport: 'command' });
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
      write_access: shadowSpec.writeAccess,
      ...(shadowUsedWriteVariant ? { write_variant: true } : {}),
      write_posture: declaredWritePosture(profile, archetype),
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
      writeShadowRefusal('constraint_command', shadowConstraintVerdict.reason, { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effort, transport: 'command' });
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
      reasoning_effort: shadowDelivery.effort,
      driver: shadowDelivery.driver,
      ...(shadowDelivery.provider != null ? { provider: shadowDelivery.provider } : {}),
      transport: 'command',
      ...(shadowSpec.writeAccess != null ? { write_access: shadowSpec.writeAccess } : {}),
      ...(shadowUsedWriteVariant ? { write_variant: true } : {}),
      delivery_transport: 'command',
      prompt_source: promptSource,
      prompt_snapshot: promptSnapshot,
      prompt_sha256: promptSha256,
      command: shadowCommand,
      command_sha256: shadowCommandSha,
      output_snapshot: shadowOutputRel,
    };
    if (eligibilityState === 'shadow_only') {
      shadowIdentity.eligibility = 'shadow_only';
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
        // Without this the shadow escapes its worktree and edits the real
        // workspace; see `atCwd`.
        env: atCwd(withoutHarnessIdentity(process.env), shadowWorktreeAbs),
        stdio: [promptFd, sfd, 'ignore'],
      });
    } finally {
      // The child holds its own copies once spawned.
      closeSync(promptFd);
      closeSync(sfd);
    }
    child.unref();
    return {
      dispatchId: shadowDispatchId,
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
    if (spawnFailedMsg != null) sRow.error = spawnFailedMsg;
    // Shadow completions OMIT workspace_changed by construction
    appendEvidenceRow(repoRoot, sRow);
    opts.onEcho?.(`shadow diff: ${diffBytes} bytes → ${pending.diffRel}`);
    } finally {
      // Collection is also the ownership boundary for the detached worktree.
      // Keep cleanup in a finally: primary receipt failures and shadow evidence
      // failures must not strand a registered worktree on disk.
      try {
        const removed = spawnSync('git', ['worktree', 'remove', '--force', pending.worktreeAbs], { cwd: repoRoot, encoding: 'utf8' });
        if (removed.error != null || removed.status !== 0) rmSync(pending.worktreeAbs, { recursive: true, force: true });
      } catch {
        try { rmSync(pending.worktreeAbs, { recursive: true, force: true }); } catch {}
      }
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
    const leaseRelease = leaseHolder == null ? undefined : {
      leasePath: join(repoRoot, WORKSPACE_LEASE_FILE),
      lockPath: join(repoRoot, WORKSPACE_LEASE_LOCK),
      holder: leaseHolder,
    };
    const invoke = (spawnCwd: string): SpawnSyncReturns<string> => {
      supervisorAttempted = true;
      const result = spawnSync(
        process.execPath,
        superviseArgv(command, inflightAbs, statusAbs, leaseRelease, effectiveTimeoutMs),
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
    if (workspaceMode === 'isolated') {
      const id8 = dispatchId.slice(0, 8);
      const diffRel = join('.fadeno', 'local', 'outputs', `isolated-${id8}.diff`).split('\\').join('/');
      const isolated = withIsolatedWorktree({
        repoRoot,
        worktreePath: join(repoRoot, '.fadeno', 'local', 'isolated', id8),
        diffRel,
        diffAbs: join(repoRoot, diffRel),
        onEcho: opts.onEcho,
      }, invoke);
      spawned = isolated.result;
      isolatedDiffRel = isolated.diff.diffRel;
      isolatedDiffBytes = isolated.diff.diffBytes;
      opts.onEcho?.(`isolated diff: ${isolated.diff.diffBytes} bytes → ${isolated.diff.diffRel}`);
    } else {
      spawned = invoke(repoRoot);
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
  const workspaceAfter = workspaceMode === 'isolated' ? null : workspaceFingerprint(repoRoot);

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
  };
  // Concurrent writers make this attestation, not judgment.
  if (workspaceBefore != null && workspaceAfter != null) {
    row.workspace_changed = workspaceBefore !== workspaceAfter;
  }
  if (workspaceMode === 'isolated' && isolatedDiffRel != null && isolatedDiffBytes != null) {
    row.diff_snapshot = isolatedDiffRel;
    row.diff_bytes = isolatedDiffBytes;
  }
  // Isolated deliveries omit workspace_changed by construction (contract 1.2)
  if (workspaceMode === 'isolated') {
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
    driver: delivery.driver,
    reasoningEffort: delivery.effort,
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
    ...INFLIGHT_DIR.split('/'),
    `fallback-${lookup.runId}-${request.dispatchId}.json`,
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

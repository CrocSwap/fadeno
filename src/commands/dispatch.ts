import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  explainEligibilityConflict,
  explainProviderConflict,
  explainWriteConflict,
  loadExecutorProfile,
  readLocalDialState,
  dispatchability,
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
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { INFLIGHT_DIR, superviseArgv, supervisedSpawnError } from '../lib/supervisor.ts';
import { ensureFadenoIgnore } from '../lib/source-control.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';

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

export type DispatchOutcome = 'ok' | 'failed' | 'empty';

const DISPATCH_OUTCOMES: readonly string[] = ['ok', 'failed', 'empty'];

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
}): DispatchOutcome | null {
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
  row: { exitCode: number | null; signal?: string | null; error?: string | null; outputBytes: number | null },
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

/** Predicate name recorded on a `dispatch_refused` row. */
export type DispatchRefusalPredicate =
  | 'write_posture'
  | 'eligibility'
  | 'provider_distinctness'
  | 'constraint_command'
  | 'shadow_isolation'
  | 'shadow_resolution';

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
  const spec = delivery.spec;
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
  const command = spec.adapter === 'command' ? spec.command : spec.fallbackCommand!;
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

  // Two-row evidence: a request row lands BEFORE the spawn so a dispatch
  // killed mid-flight (harness timeout, SIGTERM) still leaves a trace —
  // spawnSync blocks the event loop, so nothing written afterwards can be
  // relied on to exist. A boundary refusal writes `dispatch_refused` instead
  // of this pair, with the same identity. The completion row shares the
  // request's dispatch_id.
  const dispatchId = randomUUID();
  const now = opts.now ?? new Date();

  // The kernel owns the prompt snapshot for stdin dispatches: the single
  // writer means the recorded digest attests exactly the bytes received, and
  // the relay contract needs no separate file-writing step in the caller.
  let promptSnapshot: string;
  if (promptSource === 'stdin') {
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
    ...(spec.writeAccess != null ? { write_access: spec.writeAccess } : {}),
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
  if (writeConflict != null) {
    refuseDispatch(repoRoot, identity, 'write_posture', writeConflict, now);
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

  appendEvidenceRow(repoRoot, {
    format: DISPATCHES_FORMAT,
    timestamp: now.toISOString(),
    event: 'dispatch_requested',
    ...identity,
  });

  // stdout is the snapshot fd so bytes survive a mid-flight SIGTERM;
  // encoding/maxBuffer then apply to stderr only. input still feeds stdin.
  mkdirSync(join(repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
  mkdirSync(join(repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
  // The supervisor publishes the claim here; the kernel only says where. See
  // `superviseArgv` — spawnSync yields a pid too late to be of any use.
  const inflightAbs = join(repoRoot, ...INFLIGHT_DIR.split('/'), `${dispatchId}.json`);
  const outputFd = openSync(outputAbs, 'w');
  const workspaceBefore = workspaceFingerprint(repoRoot);
  const started = Date.now();
  let spawned: SpawnSyncReturns<string>;
  try {
    // Through the supervisor, never directly: `spawnSync` blocks the event
    // loop, so a killed kernel runs no cleanup and leaves the executor writing
    // the tree unattended. See src/lib/supervisor.ts.
    spawned = spawnSync(process.execPath, superviseArgv(command, inflightAbs), {
      input: prompt,
      encoding: 'utf8',
      cwd: repoRoot,
      // The child is a different session, usually a different host. Inheriting
      // our harness identity would tell a `codex exec` worker it is inside
      // Claude; it establishes its own.
      env: atCwd(withoutHarnessIdentity(process.env), repoRoot),
      maxBuffer: SPAWN_MAX_BUFFER,
      stdio: ['pipe', outputFd, 'pipe'],
    });
  } finally {
    // Belt and braces: the supervisor unlinks on exit, but a SIGKILLed
    // supervisor runs no handler and a stale claim would make a finished
    // dispatch look cancellable.
    try { rmSync(inflightAbs, { force: true }); } catch { /* nothing to drop */ }
    closeSync(outputFd);
  }
  const durationMs = Date.now() - started;
  // `spawnSync` now spawns the supervisor, which always starts, so its `error`
  // no longer reports a missing executor. The supervisor reports that itself.
  const spawnFailure =
    spawned.error?.message ?? supervisedSpawnError(spawned.status, spawned.stderr);

  const stdout = readFileSync(outputAbs, 'utf8');
  const outputSha256 = sha256Hex(stdout);
  const workspaceAfter = workspaceFingerprint(repoRoot);

  const outputBytes = Buffer.byteLength(stdout);
  const outcome = deriveDispatchOutcome({
    exitCode: spawnFailure != null ? null : spawned.status,
    signal: spawned.signal,
    error: spawnFailure,
    outputBytes,
  });
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
  };
  // Concurrent writers make this attestation, not judgment.
  if (workspaceBefore != null && workspaceAfter != null) {
    row.workspace_changed = workspaceBefore !== workspaceAfter;
  }
  if (spawnFailure != null) row.error = spawnFailure;
  appendEvidenceRow(repoRoot, row);

  // Shadow duplication — fires after primary completion, regardless of exit code. Not on refusal.
  try {
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
        // parse error becomes shadow_resolution refusal below via unknown? We'll treat as invalid dial
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
    if (shadowExecutorNameInner != null && shadowSourceTag != null) {
      // Rate sampling for attachments; flag always fires.
      if (shadowSourceTag === 'attachment' && attachmentRate != null) {
        const sampler = opts.shadowSampler ?? Math.random;
        let roll: number;
        try { roll = sampler(); } catch { roll = 0; }
        if (!(roll < attachmentRate)) {
          shadowExecutorNameInner = null;
          shadowSourceTag = null;
        }
      }
    }
    if (shadowExecutorNameInner != null && shadowSourceTag != null) {
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
      let shadowDelivery: CompiledDelivery | null = null;
      if (shadowDial != null) {
        try {
          shadowDelivery = compileDialRef(shadowDial, profile);
        } catch (err) {
          const msg = err instanceof ExecutorProfileError ? err.message : String(err);
          writeShadowRefusal('shadow_resolution', msg);
          shadowDelivery = null;
        }
      } else {
        writeShadowRefusal('shadow_resolution', `shadow target "${shadowExecutorNameInner}" is not a valid dial ref.`);
      }
      // handle case where compile succeeded but shadowDelivery is host
      if (shadowDelivery != null && shadowDelivery.spec.adapter === 'host') {
        writeShadowRefusal('shadow_resolution', `shadow executor "${shadowExecutorNameInner}" is a host executor — the kernel cannot duplicate a host dispatch.`, {
          model: shadowDelivery.model,
          model_id: shadowDelivery.modelId,
          driver: shadowDelivery.driver,
          reasoning_effort: shadowDelivery.effort,
          transport: 'host',
        });
        shadowDelivery = null;
      }
      if (shadowDelivery != null) {
        const shadowSpec = shadowDelivery.spec;
        const shadowRefString = shadowDelivery.refString;
        // Eligibility: forbidden refuses, shadow_only allowed
        const eligibilityState = eligibilityFor(shadowSpec, archetype);
        if (eligibilityState === 'forbidden') {
          const msg = explainEligibilityConflict({ executor: shadowRefString, spec: shadowSpec }, archetype) ?? `archetype "${archetype}" is forbidden on executor "${shadowRefString}".`;
          writeShadowRefusal('eligibility', msg, { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effort, transport: 'command' });
        } else {
          const writeConflict = explainWriteConflict({ executor: shadowRefString, spec: shadowSpec }, archetype, profile);
          if (writeConflict != null) {
            writeShadowRefusal('write_posture', writeConflict, { model: shadowDelivery.model, model_id: shadowDelivery.modelId, driver: shadowDelivery.driver, reasoning_effort: shadowDelivery.effort, transport: 'command' });
          } else {
            // Constraint check with shadow:true
            // Build dials maps for shadow constraint
            const sSessionMap: Record<string, string> = {};
            for (const [k, v] of Object.entries(sessionDials)) sSessionMap[k] = formatDialRef(v);
            const sRepoMap: Record<string, string> = {};
            for (const [k, v] of Object.entries(repoDials)) sRepoMap[k] = formatDialRef(v);
            const sUserMap: Record<string, string> = {};
            for (const [k, v] of Object.entries(userDials)) sUserMap[k] = formatDialRef(v);
            const sDialField = shadowDial ? { model: shadowDial.model, ...(shadowDial.effort ? { effort: shadowDial.effort } : {}), ...(shadowDial.via ? { via: shadowDial.via } : {}) } : null;
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
              write_posture: declaredWritePosture(profile, archetype),
              dial: sDialField as DialRef,
              dial_source: 'shadow',
              dials: { session: sSessionMap, repo: sRepoMap, user: sUserMap },
              resolved_via: resolvedVia,
              input_provenance: provenanceFields(lookupInputProducers(repoRoot, producedByIds(opts))),
              harness: profile.harness ?? 'standalone',
              shadow: true,
            } satisfies ConstraintContext;
            let shadowConstraintVerdict;
            try {
              shadowConstraintVerdict = evaluateConstraint(profile, shadowConstraintContext, { cwd: repoRoot });
            } catch (err) {
              if (err instanceof ConstraintError) {
                // A primary lets a constraint SYSTEM error bubble loudly; a
                // shadow must never take the primary's result down with it, so
                // the same error lands as a shadow_resolution refusal row.
                writeShadowRefusal('shadow_resolution', `shadow constraint system error: ${err.message}`);
                shadowConstraintVerdict = null;
              } else {
                throw err;
              }
            }
            if (shadowConstraintVerdict != null && shadowConstraintVerdict.verdict === 'refused') {
              writeShadowRefusal('constraint_command', shadowConstraintVerdict.reason, { model: shadowDelivery!.model, model_id: shadowDelivery!.modelId, driver: shadowDelivery!.driver, reasoning_effort: shadowDelivery!.effort, transport: 'command' });
            } else if (shadowConstraintVerdict == null || shadowConstraintVerdict.verdict === 'allowed') {
              // Isolation + spawn only if not refused
              // Only proceed if verdict allowed (null means we already wrote refusal)
              const verdictAllowed = shadowConstraintVerdict != null && shadowConstraintVerdict.verdict === 'allowed';
              if (verdictAllowed) {
                // Best-effort prune
                try { spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
                const addResult = spawnSync('git', ['worktree', 'add', '--detach', shadowWorktreeAbs, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
                if (addResult.error != null || addResult.status !== 0) {
                  const reason = addResult.error?.message ?? (addResult.stderr != null ? String(addResult.stderr).trim() : '') ?? 'worktree add failed';
                  const msg = reason.length > 0 ? reason : 'shadow worktree could not be created';
                  writeShadowRefusal('shadow_isolation', msg);
                } else {
                  // Echo fire line
                  const sModel = shadowDelivery!.model;
                  const shadowModel = sModel != null ? ` (${sModel})` : '';
                  opts.onEcho?.(`shadow → ${shadowExecutorNameInner}${shadowModel} [command]`);
                  // Build shadow request row identity (mirrors primary but shadow-specific)
                  const shadowCommand = (shadowDelivery!.spec as { command: string[] }).command;
                  const shadowCommandSha = sha256Hex(JSON.stringify(shadowCommand));
                  const shadowDialField: Record<string, unknown> = { model: shadowDial!.model };
                  if (shadowDial!.effort != null) shadowDialField.effort = shadowDial!.effort;
                  if (shadowDial!.via != null) shadowDialField.via = shadowDial!.via;
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
                    executor: shadowExecutorNameInner!,
                    model: shadowDelivery!.model,
                    model_id: shadowDelivery!.modelId,
                    reasoning_effort: shadowDelivery!.effort,
                    driver: shadowDelivery!.driver,
                    ...(shadowDelivery!.provider != null ? { provider: shadowDelivery!.provider } : {}),
                    transport: 'command',
                    ...(shadowDelivery!.spec.writeAccess != null ? { write_access: shadowDelivery!.spec.writeAccess } : {}),
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

                  // Spawn shadow with prompt bytes read from snapshot file
                  let promptBytes: string;
                  try {
                    const snapPath = isAbsolute(promptSnapshot) ? promptSnapshot : join(repoRoot, promptSnapshot);
                    promptBytes = readFileSync(snapPath, 'utf8');
                  } catch {
                    promptBytes = prompt;
                  }
                  mkdirSync(join(repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
                  const sfd = openSync(shadowOutputAbs, 'w');
                  const sStarted = Date.now();
                  let sSpawned: SpawnSyncReturns<string>;
                  try {
                    const [scmd, ...sargs] = shadowCommand;
                    sSpawned = spawnSync(scmd!, sargs, {
                      input: promptBytes,
                      encoding: 'utf8',
                      cwd: shadowWorktreeAbs,
                      // Without this the shadow escapes its worktree and edits
                      // the real workspace; see `atCwd`.
                      env: atCwd(withoutHarnessIdentity(process.env), shadowWorktreeAbs),
                      maxBuffer: SPAWN_MAX_BUFFER,
                      stdio: ['pipe', sfd, 'pipe'],
                    });
                  } finally {
                    closeSync(sfd);
                  }
                  const sDuration = Date.now() - sStarted;
                  let sStdout = '';
                  try { sStdout = readFileSync(shadowOutputAbs, 'utf8'); } catch { sStdout = ''; }
                  const sOutputSha = sha256Hex(sStdout);
                  // Diff capture after exit (any exit code)
                  let diffBytes = 0;
                  let diffContent = '';
                  try {
                    spawnSync('git', ['-C', shadowWorktreeAbs, 'add', '-A'], { encoding: 'utf8' });
                    const diffRes = spawnSync('git', ['-C', shadowWorktreeAbs, 'diff', '--binary', '--cached'], { encoding: 'utf8', maxBuffer: SPAWN_MAX_BUFFER });
                    if (diffRes.error == null && diffRes.status === 0) {
                      diffContent = diffRes.stdout ?? '';
                    } else if (diffRes.stdout != null) {
                      diffContent = String(diffRes.stdout);
                    }
                  } catch {}
                  try {
                    mkdirSync(join(repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
                    writeFileSync(shadowDiffAbs, diffContent, 'utf8');
                    diffBytes = Buffer.byteLength(diffContent);
                  } catch {
                    diffBytes = Buffer.byteLength(diffContent);
                  }
                  // Best-effort worktree remove
                  try { spawnSync('git', ['worktree', 'remove', '--force', shadowWorktreeAbs], { cwd: repoRoot, encoding: 'utf8' }); } catch {}

                  const sOutputBytes = Buffer.byteLength(sStdout);
                  const sOutcome = deriveDispatchOutcome({
                    exitCode: sSpawned!.error != null ? null : sSpawned!.status,
                    signal: sSpawned!.signal,
                    error: sSpawned!.error?.message ?? null,
                    outputBytes: sOutputBytes,
                  });
                  const sRow: Record<string, unknown> = {
                    format: DISPATCHES_FORMAT,
                    // Same rule as the primary: start plus measured duration,
                    // so `completed - requested == duration_ms` holds for
                    // shadow pairs too rather than drifting by whatever the
                    // wall clock read between the two writes.
                    timestamp: new Date(shadowNow.getTime() + sDuration).toISOString(),
                    event: 'dispatch_completed',
                    ...shadowIdentity,
                    exit_code: sSpawned!.error != null ? null : sSpawned!.status,
                    ...(sSpawned!.signal != null ? { signal: sSpawned!.signal } : {}),
                    duration_ms: sDuration,
                    output_sha256: sOutputSha,
                    output_bytes: sOutputBytes,
                    ...(sOutcome != null ? { outcome: sOutcome } : {}),
                    diff_snapshot: shadowDiffRel,
                    diff_bytes: diffBytes,
                  };
                  if (sSpawned!.error != null) sRow.error = sSpawned!.error.message;
                  // Shadow completions OMIT workspace_changed by construction
                  appendEvidenceRow(repoRoot, sRow);
                  opts.onEcho?.(`shadow diff: ${diffBytes} bytes → ${shadowDiffRel}`);
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // Shadow failures must never affect primary result
  }

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
  const command = spec.fallbackCommand;
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
  const [program, ...args] = command;
  const spawned = spawnSync(program!, args, {
    input: prompt,
    encoding: 'utf8',
    cwd: repoRoot,
    env: atCwd(process.env, repoRoot),
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  const stdout = spawned.stdout ?? '';
  const stderr = spawned.stderr ?? '';
  if (spawned.error != null || spawned.status !== 0) {
    const reason = spawned.error?.message ?? `fallback command exited ${spawned.status ?? 1}${stderr ? `: ${stderr.trim()}` : ''}`;
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

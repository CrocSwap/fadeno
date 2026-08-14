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
  applicableOverrides,
  applicableShadows,
  eligibilityFor,
  explainEligibilityConflict,
  explainProviderConflict,
  explainWriteConflict,
  loadExecutorProfile,
  readLocalLoadoutState,
  applicableUserLoadout,
  dispatchability,
  resolveActiveLoadout,
  resolveRole,
  roleResolutionEchoLabel,
  withoutHarnessIdentity,
  atCwd,
  type ActiveLoadout,
  type ExecutorProfile,
  type ExecutorSpec,
  type InputProducer,
  type RoleResolutionSource,
  type WritePosture,
} from '../lib/executors.ts';
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
import { superviseArgv, supervisedSpawnError } from '../lib/supervisor.ts';
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
export const DISPATCHES_FORMAT = '0.2';

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
function appendEvidenceRow(repoRoot: string, row: Record<string, unknown>): void {
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

/** How the ad-hoc dispatch landed on its executor (`flag` = `--executor` bypass). */
export type DispatchResolutionSource = RoleResolutionSource | 'flag';

/**
 * Evidence-row spelling of the resolution path. A row's `loadout` records
 * which loadout was *active*; `resolution` records whether it actually
 * supplied the executor — a `binding` pin or `"*"` fallback row would
 * otherwise be indistinguishable from a loadout-slot hit.
 */
const ROW_RESOLUTION: Record<DispatchResolutionSource, string> = {
  binding: 'binding',
  override: 'override',
  loadout: 'loadout',
  default: 'fallback',
  flag: 'executor-flag',
};

export interface AdHocDispatchOptions {
  /** Archetype to resolve; required unless `executor` bypasses resolution. */
  archetype?: string | null;
  /** Optional role: enables per-role binding pins and evidence attribution. */
  role?: string | null;
  /** `--loadout` override for this invocation. */
  loadout?: string | null;
  /** Bypass resolution and invoke this declared executor (debugging). */
  executor?: string | null;
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
  /** Active loadout at dispatch time (null when bypassed or none configured). */
  loadout: ActiveLoadout | null;
  executor: string;
  model: string | null;
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
 * `--executor` bypasses resolution for debugging.
 */
export function runDispatch(opts: AdHocDispatchOptions): AdHocDispatchResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const layered = loadProfileOrThrow(repoRoot, opts.userPathOptions);
  const profile = layered.profile;

  const archetype = opts.archetype?.trim() ? opts.archetype.trim() : null;
  const role = opts.role?.trim() ? opts.role.trim() : null;
  const tag = normalizeDispatchTag(opts.tag);

  let executorName: string;
  let spec: ExecutorSpec;
  let active: ActiveLoadout | null = null;
  // The pin's overlay, already scoped to the loadout that won (name-match).
  let overrides: Record<string, string> = {};
  let pinState: ReturnType<typeof readLocalLoadoutState> | null = null;
  let source: DispatchResolutionSource;
  // Present on the evidence row only when a fallback chain was walked.
  let resolvedVia: string | null = null;

  if (opts.executor != null && opts.executor.trim() !== '') {
    executorName = opts.executor.trim();
    const found = profile.executors[executorName];
    if (found == null) {
      throw new DispatchCommandError(
        `--executor "${executorName}" is not a declared executor ` +
          `(${Object.keys(profile.executors).join(', ')}).`,
      );
    }
    spec = found;
    source = 'flag';
  } else {
    if (archetype == null) {
      throw new DispatchCommandError(
        'fadeno dispatch needs --archetype <a> (or --executor <name> to bypass resolution).',
      );
    }
    if (!BARE_IDENTIFIER_RE.test(archetype)) {
      throw new DispatchCommandError(
        `--archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`,
      );
    }
    try {
      pinState = readLocalLoadoutState(repoRoot);
      const pin = pinState;
      active = resolveActiveLoadout({
        flagValue: opts.loadout ?? null,
      envValue: opts.env !== undefined ? opts.env : process.env.FADENO_LOADOUT ?? null,
      localFileValue: pin.loadout,
      // A self-contained project profile is authoritative; a user-scope dial
      // must not reach into a catalog that displaced the user layer outright.
      userFileValue: applicableUserLoadout(layered.selfContained, opts.userPathOptions),
      profile,
      });
      // Overrides decorate their base loadout by name: a `--loadout other` on
      // this invocation drops the overlay rather than re-binding somebody
      // else's loadout.
      overrides = applicableOverrides(pin, active);
      // Per-role binding pins apply only when --role names one. Without a role
      // the chain is loadout slot → "*" → error, so resolveRole runs against a
      // bindings view holding only the "*" default — kernel precedence reused,
      // with no per-role pin to hit (an archetype can never be named "*").
      const resolved =
        role != null
          ? resolveRole(role, archetype, profile, active?.name ?? null, overrides)
          : resolveRole(
              archetype,
              archetype,
              {
                ...profile,
                bindings: profile.bindings['*'] != null ? { '*': profile.bindings['*'] } : {},
              },
              active?.name ?? null,
              overrides,
            );
      executorName = resolved.executorName;
      spec = resolved.executor;
      source = resolved.source;
      resolvedVia = resolved.resolvedVia;
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
      throw err;
    }
  }

  const harness = profile.harness ?? 'standalone';
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
  const identity: Record<string, unknown> = {
    dispatch_id: dispatchId,
    // Before archetype deliberately: a caller recovering its own dispatch reads
    // this row by eye as often as by query, and the handle it chose is the
    // first thing it is looking for.
    ...(tag != null ? { tag } : {}),
    archetype,
    role,
    resolution: ROW_RESOLUTION[source],
    loadout: active == null ? null : { name: active.name, source: active.source },
    // The overlay that produced this binding, recorded only when it actually
    // did: `loadout` alone would name the base and quietly misattribute the
    // executor an override dialed on top of it. Absent on every other path.
    ...(source === 'override' && archetype != null
      ? { override: { [archetype]: executorName } }
      : {}),
    ...(resolvedVia != null ? { resolved_via: resolvedVia } : {}),
    executor: executorName,
    ...(spec.target != null ? { target: spec.target, provider: spec.provider ?? null } : {}),
    model: spec.model,
    transport,
    ...(spec.writeAccess != null ? { write_access: spec.writeAccess } : {}),
    ...(spec.target != null ? { delivery_transport: transport } : {}),
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
  const delivery = { executor: executorName, spec };
  const writeConflict = explainWriteConflict(delivery, archetype, profile);
  if (writeConflict != null) {
    refuseDispatch(repoRoot, identity, 'write_posture', writeConflict, now);
  }
  const eligibilityConflict = explainEligibilityConflict(delivery, archetype);
  if (eligibilityConflict != null) {
    refuseDispatch(repoRoot, identity, 'eligibility', eligibilityConflict, now);
  }
  const providerConflict = explainProviderConflict(
    archetype,
    spec.provider ?? null,
    producers,
    profile,
  );
  if (providerConflict != null && providerConflict.level === 'refuse') {
    refuseDispatch(repoRoot, identity, 'provider_distinctness', providerConflict.message, now);
  }

  const constraintContext = {
    archetype,
    role,
    executor: executorName,
    target: spec.target ?? null,
    provider: spec.provider ?? null,
    model: spec.model,
    transport: 'command',
    write_access: spec.writeAccess,
    write_posture: declaredWritePosture(profile, archetype),
    active_loadout: active?.name ?? null,
    overrides,
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
    source === 'flag' ? '--executor' : roleResolutionEchoLabel(source, active?.name ?? null);
  const echo =
    `${role ?? archetype ?? executorName} → ${executorName}` +
    `${spec.model != null ? ` (${spec.model})` : ''} [${sourceLabel}]` +
    // Proceeding onto a read-only delivery is legal (the archetype claims no
    // write need) but worth saying out loud before the work starts.
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
  const outputFd = openSync(outputAbs, 'w');
  const workspaceBefore = workspaceFingerprint(repoRoot);
  const started = Date.now();
  let spawned: SpawnSyncReturns<string>;
  try {
    // Through the supervisor, never directly: `spawnSync` blocks the event
    // loop, so a killed kernel runs no cleanup and leaves the executor writing
    // the tree unattended. See src/lib/supervisor.ts.
    spawned = spawnSync(process.execPath, superviseArgv(command), {
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
    let shadowExecutorNameInner: string | null = null;
    let shadowSourceTag: 'flag' | 'attachment' | null = null;
    let attachmentRate: number | undefined;
    if (hasFlag) {
      shadowExecutorNameInner = opts.shadow!.trim();
      shadowSourceTag = 'flag';
    } else if (archetype != null) {
      const effectivePin = pinState ?? readLocalLoadoutState(repoRoot);
      const shadowsForLoadout = applicableShadows(effectivePin, active);
      const att = shadowsForLoadout[archetype];
      if (att != null) {
        shadowExecutorNameInner = att.executor;
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

      // Resolve shadow executor
      const shadowSpec = profile.executors[shadowExecutorNameInner];
      if (shadowSpec == null) {
        writeShadowRefusal('shadow_resolution', `shadow target "${shadowExecutorNameInner}" is not a declared executor (${Object.keys(profile.executors).join(', ')}).`);
      } else if (shadowSpec.adapter === 'host') {
        writeShadowRefusal('shadow_resolution', `shadow executor "${shadowExecutorNameInner}" is a host executor — the kernel cannot duplicate a host dispatch.`, {
          model: shadowSpec.model,
          transport: 'host',
        });
      } else {
        // Eligibility: forbidden refuses, shadow_only allowed
        const eligibilityState = eligibilityFor(shadowSpec, archetype);
        if (eligibilityState === 'forbidden') {
          const msg = explainEligibilityConflict({ executor: shadowExecutorNameInner, spec: shadowSpec }, archetype) ?? `archetype "${archetype}" is forbidden on executor "${shadowExecutorNameInner}".`;
          writeShadowRefusal('eligibility', msg, { model: shadowSpec.model, transport: 'command' });
        } else {
          const writeConflict = explainWriteConflict({ executor: shadowExecutorNameInner, spec: shadowSpec }, archetype, profile);
          if (writeConflict != null) {
            writeShadowRefusal('write_posture', writeConflict, { model: shadowSpec.model, transport: 'command' });
          } else {
            // Constraint check with shadow:true
            const shadowConstraintContext = {
              archetype,
              role,
              executor: shadowExecutorNameInner,
              target: shadowSpec.target ?? null,
              provider: shadowSpec.provider ?? null,
              model: shadowSpec.model,
              transport: 'command' as const,
              write_access: shadowSpec.writeAccess,
              write_posture: declaredWritePosture(profile, archetype),
              active_loadout: active?.name ?? null,
              overrides,
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
              writeShadowRefusal('constraint_command', shadowConstraintVerdict.reason, { model: shadowSpec.model, transport: 'command' });
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
                  const shadowModel = shadowSpec.model != null ? ` (${shadowSpec.model})` : '';
                  opts.onEcho?.(`shadow → ${shadowExecutorNameInner}${shadowModel} [command]`);
                  // Build shadow request row identity (mirrors primary but shadow-specific)
                  const shadowCommand = shadowSpec.command;
                  const shadowCommandSha = sha256Hex(JSON.stringify(shadowCommand));
                  const shadowLoadoutField = active == null ? null : { name: active.name, source: active.source };
                  const shadowIdentity: Record<string, unknown> = {
                    dispatch_id: shadowDispatchId,
                    archetype,
                    role,
                    resolution: 'shadow',
                    shadow: true,
                    primary_dispatch_id: dispatchId,
                    shadow_source: shadowSourceTag,
                    gate_eligible: false,
                    loadout: shadowLoadoutField,
                    ...(resolvedVia != null ? { resolved_via: resolvedVia } : {}),
                    executor: shadowExecutorNameInner,
                    ...(shadowSpec.target != null ? { target: shadowSpec.target, provider: shadowSpec.provider ?? null } : {}),
                    model: shadowSpec.model,
                    transport: 'command',
                    ...(shadowSpec.writeAccess != null ? { write_access: shadowSpec.writeAccess } : {}),
                    ...(shadowSpec.target != null ? { delivery_transport: 'command' } : {}),
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
    loadout: active,
    executor: executorName,
    model: spec.model,
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
  if (spec.model !== request.model || spec.reasoningEffort !== request.reasoningEffort || spec.agentType !== request.agentType) {
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

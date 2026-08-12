import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  explainWriteConflict,
  loadExecutorProfile,
  readLocalLoadout,
  readUserLoadout,
  resolveActiveLoadout,
  resolveRole,
  roleResolutionEchoLabel,
  type ActiveLoadout,
  type ExecutorProfile,
  type ExecutorSpec,
  type RoleResolutionSource,
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
import { findRepoRoot } from '../lib/paths.ts';
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
export const DISPATCHES_FORMAT = '0.1';

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

function loadProfileOrThrow(repoRoot: string, userPathOptions?: UserPathOptions): ExecutorProfile {
  try {
    return loadExecutorProfile(repoRoot, userPathOptions).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
    throw err;
  }
}

/**
 * One ad-hoc dispatch: resolve archetype → executor with the kernel chain
 * (per-role pin → active loadout slot → `"*"` default), invoke the command
 * adapter (or a host executor's explicit command fallback) with the prompt on
 * stdin, and append a `dispatch_requested` + `dispatch_completed` evidence row
 * pair to `.fadeno/dispatches.jsonl` (the request row lands before the spawn
 * so killed dispatches still leave a trace). `--executor` bypasses resolution
 * for debugging.
 */
export function runDispatch(opts: AdHocDispatchOptions): AdHocDispatchResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const profile = loadProfileOrThrow(repoRoot, opts.userPathOptions);

  const archetype = opts.archetype?.trim() ? opts.archetype.trim() : null;
  const role = opts.role?.trim() ? opts.role.trim() : null;

  let executorName: string;
  let spec: ExecutorSpec;
  let active: ActiveLoadout | null = null;
  let source: DispatchResolutionSource;

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
      active = resolveActiveLoadout({
        flagValue: opts.loadout ?? null,
      envValue: opts.env !== undefined ? opts.env : process.env.FADENO_LOADOUT ?? null,
      localFileValue: readLocalLoadout(repoRoot),
      userFileValue: readUserLoadout(opts.userPathOptions),
      profile,
      });
      // Per-role binding pins apply only when --role names one. Without a role
      // the chain is loadout slot → "*" → error, so resolveRole runs against a
      // bindings view holding only the "*" default — kernel precedence reused,
      // with no per-role pin to hit (an archetype can never be named "*").
      const resolved =
        role != null
          ? resolveRole(role, archetype, profile, active?.name ?? null)
          : resolveRole(
              archetype,
              archetype,
              {
                ...profile,
                bindings: profile.bindings['*'] != null ? { '*': profile.bindings['*'] } : {},
              },
              active?.name ?? null,
            );
      executorName = resolved.executorName;
      spec = resolved.executor;
      source = resolved.source;
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DispatchCommandError(err.message);
      throw err;
    }
  }

  if (spec.adapter === 'host' && spec.fallbackCommand == null) {
    throw new DispatchCommandError(
      `resolved to host executor "${executorName}"; ad-hoc dispatch invokes command adapters only — ` +
        `run this ${archetype ?? role ?? 'role'}-shaped task with the native in-session ` +
        `${archetype ?? 'role'} agent instead, declare fallback_command on the executor, or bind a ` +
        'command executor.',
    );
  }
  const command = spec.adapter === 'command' ? spec.command : spec.fallbackCommand!;
  const transport = spec.adapter === 'command' ? 'command' : 'host-command-fallback';

  // Every dispatch that gets this far executes a command (`command` or
  // `host-command-fallback`), so a mutating archetype delivered through a
  // command that cannot mutate the workspace is a refusal waiting to happen:
  // an expensive run that ends in "I can't write here". Catch it before the
  // spawn. Undeclared on either side means no constraint.
  const writeConflict = explainWriteConflict({ executor: executorName, spec }, archetype, profile);
  if (writeConflict != null) throw new DispatchCommandError(writeConflict);

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
    // Refuse before invoking or recording: nothing was dispatched.
    throw new DispatchCommandError(
      opts.promptFile != null && opts.promptFile !== ''
        ? `--prompt-file ${opts.promptFile} is empty — a dispatch needs a non-empty prompt.`
        : 'empty prompt on stdin — pipe a non-empty prompt or pass --prompt-file <path>.',
    );
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

  // Two-row evidence: a request row lands BEFORE the spawn so a dispatch
  // killed mid-flight (harness timeout, SIGTERM) still leaves a trace —
  // spawnSync blocks the event loop, so nothing written afterwards can be
  // relied on to exist. The completion row shares the request's dispatch_id.
  const dispatchId = randomUUID();

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

  const relayAttested = consumePendingRelay(repoRoot, prompt, opts.now ?? new Date());

  const promptSha256 = sha256Hex(prompt);
  const commandSha256 = sha256Hex(JSON.stringify(command));
  const identity: Record<string, unknown> = {
    dispatch_id: dispatchId,
    archetype,
    role,
    resolution: ROW_RESOLUTION[source],
    loadout: active == null ? null : { name: active.name, source: active.source },
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
  };
  ensureFadenoIgnore(repoRoot);
  mkdirSync(join(repoRoot, '.fadeno'), { recursive: true });
  const evidenceFile = join(repoRoot, DISPATCHES_FILE);
  appendFileSync(
    evidenceFile,
    `${JSON.stringify({ format: DISPATCHES_FORMAT, timestamp: (opts.now ?? new Date()).toISOString(), event: 'dispatch_requested', ...identity })}\n`,
    'utf8',
  );

  const started = Date.now();
  const [cmd, ...args] = command;
  const spawned = spawnSync(cmd!, args, {
    input: prompt,
    encoding: 'utf8',
    cwd: repoRoot,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  const durationMs = Date.now() - started;

  const stdout = spawned.stdout ?? '';
  const outputSha256 = sha256Hex(stdout);

  const row: Record<string, unknown> = {
    format: DISPATCHES_FORMAT,
    timestamp: (opts.now ?? new Date()).toISOString(),
    event: 'dispatch_completed',
    ...identity,
    exit_code: spawned.error != null ? null : spawned.status,
    ...(spawned.signal != null ? { signal: spawned.signal } : {}),
    duration_ms: durationMs,
    output_sha256: outputSha256,
  };
  if (spawned.error != null) row.error = spawned.error.message;
  appendFileSync(evidenceFile, `${JSON.stringify(row)}\n`, 'utf8');

  if (spawned.error != null) {
    throw new DispatchCommandError(
      `executor "${executorName}" failed to spawn: ${spawned.error.message}`,
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

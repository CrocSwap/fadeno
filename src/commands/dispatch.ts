import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
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
  progressHostDispatch,
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
  /** Repo-relative path of the evidence log that received one row. */
  evidencePath: string;
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
 * adapter with the prompt on stdin, and append one evidence row to
 * `.fadeno/dispatches.jsonl`. `--executor` bypasses resolution for debugging.
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

  if (spec.adapter !== 'command') {
    throw new DispatchCommandError(
      `resolved to host executor "${executorName}"; ad-hoc dispatch invokes command adapters only — ` +
        'bind a command executor for this archetype or run via host dispatch.',
    );
  }

  let prompt: string;
  if (opts.promptFile != null && opts.promptFile !== '') {
    const promptPath = resolve(cwd, opts.promptFile);
    if (!existsSync(promptPath)) {
      throw new DispatchCommandError(`--prompt-file ${opts.promptFile} does not exist.`);
    }
    prompt = readFileSync(promptPath, 'utf8');
  } else if (opts.prompt != null) {
    prompt = opts.prompt;
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
    `${spec.model != null ? ` (${spec.model})` : ''} [${sourceLabel}]`;
  opts.onEcho?.(echo);
  opts.onEcho?.(`external sandbox: ${executorName} (${spec.command.join(' ')}) runs outside the current harness; evidence → ${DISPATCHES_FILE}`);

  const started = Date.now();
  const [cmd, ...args] = spec.command;
  const spawned = spawnSync(cmd!, args, {
    input: prompt,
    encoding: 'utf8',
    cwd: repoRoot,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  const durationMs = Date.now() - started;

  const stdout = spawned.stdout ?? '';
  const promptSha256 = sha256Hex(prompt);
  const outputSha256 = sha256Hex(stdout);

  // Evidence first — a spawn failure is still a dispatch that happened.
  const row: Record<string, unknown> = {
    timestamp: (opts.now ?? new Date()).toISOString(),
    archetype,
    role,
    resolution: ROW_RESOLUTION[source],
    loadout: active == null ? null : { name: active.name, source: active.source },
    executor: executorName,
    model: spec.model,
    exit_code: spawned.error != null ? null : spawned.status,
    duration_ms: durationMs,
    prompt_sha256: promptSha256,
    output_sha256: outputSha256,
  };
  if (spawned.error != null) row.error = spawned.error.message;
  ensureFadenoIgnore(repoRoot);
  mkdirSync(join(repoRoot, '.fadeno'), { recursive: true });
  appendFileSync(
    join(repoRoot, DISPATCHES_FILE),
    `${JSON.stringify({ ...row, command: spec.command, command_sha256: sha256Hex(JSON.stringify(spec.command)) })}\n`,
    'utf8',
  );

  if (spawned.error != null) {
    throw new DispatchCommandError(
      `executor "${executorName}" failed to spawn: ${spawned.error.message}`,
    );
  }

  return {
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

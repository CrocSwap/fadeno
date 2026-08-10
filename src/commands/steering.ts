import { join } from 'node:path';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  loadExecutorProfile,
  readLocalLoadout,
  resolveActiveLoadout,
  resolveRole,
  type ActiveLoadout,
  type ExecutorProfile,
  type ExecutorSpec,
  type RoleResolutionSource,
} from '../lib/executors.ts';
import { emitFile, type EmitResult } from '../lib/fsutil.ts';
import { findRepoRoot } from '../lib/paths.ts';

export class SteeringError extends Error {}

export type SteeringMode = 'native' | 'command' | 'restart_required';

export interface SteeringResolution {
  mode: SteeringMode;
  archetype: string;
  role: string | null;
  activeLoadout: ActiveLoadout | null;
  executor: string;
  adapter: ExecutorSpec['adapter'];
  model: string | null;
  source: RoleResolutionSource | 'native-baseline';
  nativeExecutor: string | null;
  detail: string;
}

interface CommonOptions {
  cwd?: string;
  repoRoot?: string;
}

function rootOf(opts: CommonOptions): string {
  return opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
}

function profileOf(repoRoot: string): ExecutorProfile {
  try {
    return loadExecutorProfile(repoRoot).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
}

function validateArchetype(archetype: string): string {
  const value = archetype.trim();
  if (!BARE_IDENTIFIER_RE.test(value)) {
    throw new SteeringError(
      `archetype "${value}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`,
    );
  }
  return value;
}

export interface SteeringResolveOptions extends CommonOptions {
  archetype: string;
  role?: string | null;
  nativeExecutor?: string | null;
  loadout?: string | null;
  env?: string | null;
}

/**
 * Resolve one invocation from a session-static native Codex role agent.
 * Command slots switch immediately; host slots execute locally only when they
 * match the executor materialized into that native agent definition.
 */
export function runSteeringResolve(opts: SteeringResolveOptions): SteeringResolution {
  const repoRoot = rootOf(opts);
  const profile = profileOf(repoRoot);
  const archetype = validateArchetype(opts.archetype);
  const role = opts.role?.trim() ? opts.role.trim() : null;
  const nativeExecutor = opts.nativeExecutor?.trim() ? opts.nativeExecutor.trim() : null;
  const nativeSpec = nativeExecutor == null ? null : profile.executors[nativeExecutor];
  if (nativeExecutor != null && (nativeSpec == null || nativeSpec.adapter !== 'host')) {
    throw new SteeringError(
      `native executor "${nativeExecutor}" is not a declared host executor; ` +
        're-apply Codex steering from a host-backed baseline loadout.',
    );
  }

  let active: ActiveLoadout | null;
  try {
    active = resolveActiveLoadout({
      flagValue: opts.loadout ?? null,
      envValue: opts.env !== undefined ? opts.env : process.env.FADENO_LOADOUT ?? null,
      localFileValue: readLocalLoadout(repoRoot),
      profile,
    });
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }

  if (active == null) {
    if (nativeExecutor == null || nativeSpec == null) {
      throw new SteeringError(
        'no loadout is active and this Codex role agent has no native baseline; ' +
          'run `fadeno steering apply <loadout> --codex --force` and start a fresh Codex session.',
      );
    }
    return {
      mode: 'native', archetype, role, activeLoadout: null, executor: nativeExecutor,
      adapter: 'host', model: nativeSpec.model, source: 'native-baseline', nativeExecutor,
      detail: `no loadout is active; execute natively as baseline ${nativeExecutor}`,
    };
  }

  let resolved;
  try {
    resolved = role != null
      ? resolveRole(role, archetype, profile, active.name)
      : resolveRole(
          archetype,
          archetype,
          { ...profile, bindings: profile.bindings['*'] != null ? { '*': profile.bindings['*'] } : {} },
          active.name,
        );
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }

  if (resolved.executor.adapter === 'command') {
    return {
      mode: 'command', archetype, role, activeLoadout: active,
      executor: resolved.executorName, adapter: 'command', model: resolved.executor.model,
      source: resolved.source, nativeExecutor,
      detail: `dispatch through command executor ${resolved.executorName}; effective immediately`,
    };
  }
  if (nativeExecutor === resolved.executorName) {
    return {
      mode: 'native', archetype, role, activeLoadout: active,
      executor: resolved.executorName, adapter: 'host', model: resolved.executor.model,
      source: resolved.source, nativeExecutor,
      detail: `host executor ${resolved.executorName} matches this session's native baseline`,
    };
  }
  return {
    mode: 'restart_required', archetype, role, activeLoadout: active,
    executor: resolved.executorName, adapter: 'host', model: resolved.executor.model,
    source: resolved.source, nativeExecutor,
    detail:
      `loadout ${active.name} requests host executor ${resolved.executorName}, but this session was ` +
      `materialized for ${nativeExecutor ?? 'no native executor'}; apply the loadout and start a fresh Codex session`,
  };
}

const ROLE_BEHAVIOR: Record<string, string> = {
  worker: 'Implement the requested change, preserving unrelated work and validating the behavior you changed.',
  reviewer: 'Review correctness, security, regressions, edge cases, and tests; report concrete findings before summary.',
  judge: 'Evaluate against the stated criteria and emit the requested structured judgment; never decide Fadeno control flow yourself.',
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderCodexAgent(archetype: string, executorName: string, spec: Extract<ExecutorSpec, { adapter: 'host' }>): string {
  const behavior = ROLE_BEHAVIOR[archetype] ?? `Perform the ${archetype} role exactly as requested.`;
  return `name = ${tomlString(archetype)}
description = ${tomlString(`Fadeno hybrid ${archetype}: native on the session baseline, command-dispatched when the active loadout switches providers.`)}
model = ${tomlString(spec.model)}
model_reasoning_effort = ${tomlString(spec.reasoningEffort)}
sandbox_mode = "workspace-write"

developer_instructions = """
You are Fadeno's hybrid ${archetype}. Do not spawn subagents.

Before every task, run:
\`fadeno steering resolve --archetype ${archetype} --native-executor ${executorName}\`

- mode=native: ${behavior}
- mode=command: write the ENTIRE task prompt you received verbatim to a unique
  file under .fadeno/local/prompts/, run
  \`fadeno dispatch --archetype ${archetype} --prompt-file <path>\`, and relay
  stdout verbatim. On a non-zero exit, report the error and do not perform the
  task yourself. The command executor runs outside this subagent's sandbox.
- mode=restart_required: stop and relay the resolver's restart instruction.

Never call fadeno dispatch for a host executor and never silently substitute a
different model or executor.
"""
`;
}

export interface SteeringApplyOptions extends CommonOptions {
  loadout: string;
  target: 'codex';
  force?: boolean;
}

export interface SteeringApplyResult {
  loadout: string;
  results: EmitResult[];
  baseline: Record<string, string>;
  restartRequired: true;
}

/** Materialize a host-backed loadout into session-static Codex role agents. */
export function runSteeringApply(opts: SteeringApplyOptions): SteeringApplyResult {
  const repoRoot = rootOf(opts);
  const profile = profileOf(repoRoot);
  const loadout = opts.loadout.trim();
  const slots = profile.loadouts[loadout];
  if (slots == null) {
    throw new SteeringError(
      `"${loadout}" is not a declared loadout (${Object.keys(profile.loadouts).sort().join(', ')}).`,
    );
  }
  const baseline: Record<string, string> = {};
  const results: EmitResult[] = [];
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const executorName = slots[archetype];
    const spec = executorName == null ? null : profile.executors[executorName];
    if (executorName == null || spec == null || spec.adapter !== 'host') {
      throw new SteeringError(
        `loadout "${loadout}" needs a host executor in its "${archetype}" slot to materialize ` +
          `a native Codex baseline; found ${executorName ?? 'no slot'}.`,
      );
    }
    if (spec.agentType !== archetype) {
      throw new SteeringError(
        `loadout "${loadout}" ${archetype} slot targets ${executorName} with agent_type ` +
          `"${spec.agentType}"; expected "${archetype}".`,
      );
    }
    baseline[archetype] = executorName;
    const path = join(repoRoot, '.codex', 'agents', `${archetype}.toml`);
    results.push({ path, status: emitFile(path, renderCodexAgent(archetype, executorName, spec), opts.force ?? false) });
  }
  return { loadout, results, baseline, restartRequired: true };
}

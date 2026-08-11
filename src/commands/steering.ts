import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  loadExecutorProfile,
  parseExecutorProfile,
  readLocalLoadout,
  resolveActiveLoadout,
  resolveRole,
  type ActiveLoadout,
  type ExecutorProfile,
  type ExecutorSpec,
  type RoleResolutionSource,
} from '../lib/executors.ts';
import { emitFile, type EmitResult } from '../lib/fsutil.ts';
import { HostDispatchError, readHostDispatchRequest, type HostDispatchRequestLookup } from '../lib/host-dispatch.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { sha256Hex } from '../lib/artifact-manifest.ts';

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
  source: RoleResolutionSource | 'native-baseline' | 'host-request';
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
  /** Immutable engine delivery identity; must be supplied as a pair. */
  run?: string | null;
  dispatchId?: string | null;
}

function snapshotProfileForRequest(lookup: HostDispatchRequestLookup): ExecutorProfile {
  const snapshots = lookup.events.filter((event) => event.type === 'profile_snapshotted');
  if (snapshots.length !== 1) {
    throw new SteeringError(
      `run "${lookup.runId}" must contain exactly one profile_snapshotted event for a locked host request; ` +
        `found ${snapshots.length}.`,
    );
  }
  const snapshot = snapshots[0]!;
  const profileRel = typeof snapshot.extra.profile === 'string' && snapshot.extra.profile.length > 0
    ? snapshot.extra.profile
    : 'profile.yaml';
  const runAbsolute = resolve(lookup.runDir);
  const profilePath = isAbsolute(profileRel) ? resolve(profileRel) : resolve(runAbsolute, profileRel);
  const profileRelative = relative(runAbsolute, profilePath).split('\\').join('/');
  if (
    profileRelative === '' || profileRelative === '..' || profileRelative.startsWith('../') || isAbsolute(profileRelative)
  ) {
    throw new SteeringError(`run "${lookup.runId}" profile snapshot escapes the run directory: ${profileRel}`);
  }
  if (!existsSync(profilePath)) throw new SteeringError(`run "${lookup.runId}" profile snapshot is missing: ${profileRel}`);
  const text = readFileSync(profilePath, 'utf8');
  const digest = snapshot.extra.sha256;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new SteeringError(`run "${lookup.runId}" profile snapshot is missing or has an invalid sha256 digest.`);
  }
  if (digest !== sha256Hex(text)) {
    throw new SteeringError(`run "${lookup.runId}" profile snapshot digest does not match its recorded sha256.`);
  }
  try {
    return parseExecutorProfile(text, `${profileRel} (run snapshot)`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
}

function runLockedSteeringResolve(opts: SteeringResolveOptions, archetype: string, role: string | null, nativeExecutor: string | null): SteeringResolution {
  const run = opts.run?.trim() ?? '';
  const dispatchId = opts.dispatchId?.trim() ?? '';
  if (run === '' || dispatchId === '') {
    throw new SteeringError('locked steering resolution requires both --run and --dispatch-id.');
  }
  let lookup: HostDispatchRequestLookup;
  try {
    lookup = readHostDispatchRequest({ repoRoot: rootOf(opts), cwd: opts.cwd, run, dispatchId });
  } catch (err) {
    if (err instanceof HostDispatchError) throw new SteeringError(err.message);
    throw err;
  }
  const request = lookup.request;
  if (lookup.terminal != null) {
    throw new SteeringError(`host dispatch "${dispatchId}" already has a terminal receipt; it cannot be delivered as a live request.`);
  }
  const requestedIdentity = lookup.event.extra.requested_identity;
  if (
    !Array.isArray(requestedIdentity) ||
    !['model', 'reasoning_effort', 'agent_type'].every((field) => requestedIdentity.includes(field))
  ) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" does not declare the requested model, effort, and agent type.`,
    );
  }
  if (request.actor == null) {
    throw new SteeringError(`host dispatch "${dispatchId}" has no actor identity for locked steering.`);
  }
  if (request.agentType !== archetype) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" requests agent_type "${request.agentType}", not archetype "${archetype}".`,
    );
  }
  if (role != null && role !== request.actor) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" requests actor "${request.actor}", not role "${role}".`,
    );
  }
  const profile = snapshotProfileForRequest(lookup);
  const executor = profile.executors[request.executor];
  if (executor == null || executor.adapter !== 'host') {
    throw new SteeringError(
      `host dispatch "${dispatchId}" requests executor "${request.executor}", which is not a host executor in the run profile snapshot.`,
    );
  }
  if (
    request.model !== executor.model ||
    request.reasoningEffort !== executor.reasoningEffort ||
    request.agentType !== executor.agentType
  ) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" request identity does not match executor "${request.executor}" in the run profile snapshot.`,
    );
  }
  const detail = nativeExecutor === request.executor
    ? `host request ${dispatchId} is locked to run-snapshotted executor ${request.executor}; execute natively`
    : `host request ${dispatchId} requires native executor ${request.executor}; this session is materialized for ${nativeExecutor ?? 'no native executor'}, so start a matching Codex session`;
  return {
    mode: nativeExecutor === request.executor ? 'native' : 'restart_required',
    archetype,
    role,
    activeLoadout: null,
    executor: request.executor,
    adapter: 'host',
    model: request.model,
    source: 'host-request',
    nativeExecutor,
    detail,
  };
}

/**
 * Resolve one invocation from a session-static native Codex role agent.
 * Command slots switch immediately; host slots execute locally only when they
 * match the executor materialized into that native agent definition.
 */
export function runSteeringResolve(opts: SteeringResolveOptions): SteeringResolution {
  const repoRoot = rootOf(opts);
  const archetype = validateArchetype(opts.archetype);
  const role = opts.role?.trim() ? opts.role.trim() : null;
  const nativeExecutor = opts.nativeExecutor?.trim() ? opts.nativeExecutor.trim() : null;
  const hasRun = opts.run != null;
  const hasDispatchId = opts.dispatchId != null;
  if (hasRun !== hasDispatchId || (hasRun && (opts.run!.trim() === '' || opts.dispatchId!.trim() === ''))) {
    throw new SteeringError('locked steering resolution requires both --run and --dispatch-id.');
  }
  if (hasRun && hasDispatchId) return runLockedSteeringResolve(opts, archetype, role, nativeExecutor);

  const profile = profileOf(repoRoot);
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

function renderCodexNativeAgent(
  archetype: string,
  executorName: string,
  spec: Extract<ExecutorSpec, { adapter: 'host' }>,
): string {
  const behavior = ROLE_BEHAVIOR[archetype] ?? `Perform the ${archetype} role exactly as requested.`;
  return `name = ${tomlString(archetype)}
description = ${tomlString(`Fadeno hybrid ${archetype}: native on the session baseline, command-dispatched when the active loadout switches providers.`)}
model = ${tomlString(spec.model)}
model_reasoning_effort = ${tomlString(spec.reasoningEffort)}
sandbox_mode = "workspace-write"

developer_instructions = """
You are Fadeno's hybrid ${archetype}. Do not spawn subagents.

Before every task, inspect whether the delivery begins with \`# Fadeno engine step assignment\`.
For an engine assignment, the host coordinator must provide both \`run: <run-id>\`
and \`dispatch_id: <dispatch-id>\` in the delivery envelope. Run:
\`fadeno steering resolve --archetype ${archetype} --native-executor ${executorName} --run <run-id> --dispatch-id <dispatch-id>\`
If either identity is absent or validation fails, stop and report the resolver
error; never fall back to the ordinary ambient preflight for an engine assignment.
For an ordinary task beginning with the ordinary \`# Fadeno step assignment\` heading, run:
\`fadeno steering resolve --archetype ${archetype} --native-executor ${executorName}\`

- mode=native: ${behavior}
- mode=command: write the ENTIRE task prompt you received verbatim to a unique
  file under .fadeno/local/prompts/, run
  \`fadeno dispatch --archetype ${archetype} --prompt-file <path>\`, and relay stdout
  verbatim. On a non-zero exit, report the error and do not perform the
  task yourself. The command executor runs outside this subagent's sandbox.
- mode=restart_required: stop and relay the resolver's restart instruction.

Never call fadeno dispatch for a host executor and never silently substitute a
different model or executor.
"""
`;
}

function renderCodexCommandBroker(archetype: string): string {
  return `name = ${tomlString(archetype)}
description = ${tomlString(`Fadeno command broker ${archetype}: delegates command slots through the active loadout and stops when a host slot needs native materialization.`)}
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
sandbox_mode = "workspace-write"

developer_instructions = """
You are Fadeno's command-broker ${archetype}. Do not spawn subagents.

Before every task, inspect whether the delivery begins with \`# Fadeno engine step assignment\`.
For an engine assignment, the host coordinator must provide both \`run: <run-id>\`
and \`dispatch_id: <dispatch-id>\` in the delivery envelope. Run:
\`fadeno steering resolve --archetype ${archetype} --run <run-id> --dispatch-id <dispatch-id>\`
If either identity is absent or validation fails, stop and report the resolver
error; never fall back to the ordinary ambient preflight for an engine assignment.
For an ordinary task beginning with the ordinary \`# Fadeno step assignment\` heading, run:
\`fadeno steering resolve --archetype ${archetype}\`

- mode=command: write the ENTIRE task prompt you received verbatim to a unique
  file under .fadeno/local/prompts/, run
  \`fadeno dispatch --archetype ${archetype} --prompt-file <path>\`, and relay stdout verbatim.
  On a non-zero exit, report the error and do not perform the
  task yourself.
- mode=native or mode=restart_required: stop and relay the resolver's
  instruction; a host slot must run in a matching native Codex agent.
- If the resolver errors, stop and report the error rather than doing the role
  work on this broker.

Never dispatch a host executor and never silently substitute a different model
or executor. The command executor named by the resolver owns the work.
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
  materialization: Record<string, {
    kind: 'native' | 'command-broker';
    adapter: ExecutorSpec['adapter'];
    executor: string;
    model: string | null;
  }>;
  /** Host-only compatibility view; command-broker slots are omitted. */
  baseline: Record<string, string>;
  restartRequired: true;
}

/** Materialize every required loadout slot into a session-static Codex role agent. */
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
  const materialization: SteeringApplyResult['materialization'] = {};
  const pending: Array<{ path: string; body: string }> = [];
  const results: EmitResult[] = [];
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const executorName = slots[archetype];
    const spec = executorName == null ? null : profile.executors[executorName];
    if (executorName == null || spec == null) {
      throw new SteeringError(
        `loadout "${loadout}" needs an executor in its "${archetype}" slot to materialize ` +
          `a Codex role agent; found ${executorName ?? 'no slot'}.`,
      );
    }
    const path = join(repoRoot, '.codex', 'agents', `${archetype}.toml`);
    let body: string;
    if (spec.adapter === 'host') {
      if (spec.agentType !== archetype) {
        throw new SteeringError(
          `loadout "${loadout}" ${archetype} slot targets ${executorName} with agent_type ` +
            `"${spec.agentType}"; expected "${archetype}".`,
        );
      }
      baseline[archetype] = executorName;
      materialization[archetype] = {
        kind: 'native', adapter: 'host', executor: executorName, model: spec.model,
      };
      body = renderCodexNativeAgent(archetype, executorName, spec);
    } else {
      materialization[archetype] = {
        kind: 'command-broker', adapter: 'command', executor: executorName, model: spec.model,
      };
      body = renderCodexCommandBroker(archetype);
    }
    pending.push({ path, body });
  }
  for (const item of pending) {
    results.push({ path: item.path, status: emitFile(item.path, item.body, opts.force ?? false) });
  }
  return { loadout, results, materialization, baseline, restartRequired: true };
}

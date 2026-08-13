import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  applicableOverrides,
  executorForArchetype,
  explainWriteConflict,
  loadExecutorProfile,
  parseExecutorProfile,
  readLocalLoadoutState,
  readUserLoadout,
  resolveActiveLoadout,
  resolveRole,
  type ActiveLoadout,
  type ExecutorProfile,
  type ExecutorSpec,
  type RoleResolutionSource,
} from '../lib/executors.ts';
import { emitFile, type EmitResult } from '../lib/fsutil.ts';
import { HostDispatchError, readHostDispatchRequest, type HostDispatchRequestLookup } from '../lib/host-dispatch.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { userPaths, type UserPathOptions } from '../lib/user-paths.ts';

export class SteeringError extends Error {}

/**
 * Archetypes that have a native in-session agent surface today. A declared
 * archetype that is not itself one of these is delivered natively through the
 * first chain member that is.
 */
export const NATIVE_SURFACE_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

const NATIVE_SURFACE_SET: ReadonlySet<string> = new Set(NATIVE_SURFACE_ARCHETYPES);

const FORBIDDEN_NATIVE_ADVISORY =
  'This work is write-forbidden (requires_write: forbidden): produce artifacts in your reply only — do not edit, create, or commit workspace files.';

/**
 * `write_conflict` is a command slot the resolver refuses to present as
 * runnable: the archetype declares `requires_write` and the delivery command
 * cannot mutate the workspace. Distinct from `restart_required` — a fresh
 * session does not fix it; the binding or the command's permission mode does.
 */
export type SteeringMode = 'native' | 'command' | 'restart_required' | 'write_conflict';

export interface SteeringResolution {
  mode: SteeringMode;
  archetype: string;
  role: string | null;
  activeLoadout: ActiveLoadout | null;
  executor: string;
  adapter: ExecutorSpec['adapter'];
  model: string | null;
  source: RoleResolutionSource | 'native-baseline' | 'host-request';
  /**
   * Whether a session slot override — not the loadout's own slot — produced
   * this binding. Redundant with `source === 'override'` by construction, and
   * deliberately so: the steering hook and the Codex role agents branch on a
   * flag they cannot mis-parse, without enumerating resolution sources.
   */
  override: boolean;
  nativeExecutor: string | null;
  detail: string;
  /** The shared refusal, present only on a `write_conflict` resolution. */
  writeConflict?: string;
  /** Archetype whose binding fired when a fallback chain was walked; null on a direct bind. */
  resolved_via: string | null;
  /**
   * Native agent surface that should deliver this work when the declared
   * archetype is not itself one of `NATIVE_SURFACE_ARCHETYPES`.
   */
  surface_archetype?: string;
  /** Advisory-only write-forbidden instruction for native delivery. */
  advisory?: string;
}

interface CommonOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
}

function rootOf(opts: CommonOptions): string {
  return opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
}

function profileOf(repoRoot: string, userPathOptions?: UserPathOptions): ExecutorProfile {
  try {
    return loadExecutorProfile(repoRoot, userPathOptions, 'codex').profile;
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

/** Binding-chain successor. Undeclared names and non-string fallbacks are end-nodes. */
function nextArchetypeFallback(profile: ExecutorProfile, name: string): string | null {
  if (!Object.hasOwn(profile.archetypes, name)) return null;
  const next = profile.archetypes[name]!.fallback;
  return typeof next === 'string' ? next : null;
}

function fallbackChain(profile: ExecutorProfile, start: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = start;
  while (typeof current === 'string' && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = nextArchetypeFallback(profile, current);
  }
  return chain;
}

type SteeringResolutionBase = Omit<SteeringResolution, 'resolved_via' | 'surface_archetype' | 'advisory'>;

/**
 * Attach chain evidence and native-delivery extras. A native slot whose
 * declared archetype is not itself a native surface must land on one via the
 * fallback chain — otherwise there is no agent to hand the work to.
 */
function decorateSteering(
  base: SteeringResolutionBase,
  profile: ExecutorProfile,
  resolvedVia: string | null,
): SteeringResolution {
  const result: SteeringResolution = { ...base, resolved_via: resolvedVia };
  if (result.mode !== 'native') return result;
  if (!NATIVE_SURFACE_SET.has(result.archetype)) {
    const chain = fallbackChain(profile, result.archetype);
    const surface = chain.find((name) => NATIVE_SURFACE_SET.has(name));
    if (surface == null) {
      throw new SteeringError(
        `archetype "${result.archetype}" has no native agent surface on its fallback chain (${chain.join(' → ')}); ` +
          `deliver it through a command route, or declare a fallback to ${NATIVE_SURFACE_ARCHETYPES.join(', ')}.`,
      );
    }
    result.surface_archetype = surface;
  }
  if (
    Object.hasOwn(profile.archetypes, result.archetype) &&
    profile.archetypes[result.archetype]!.requiresWrite === 'forbidden'
  ) {
    result.advisory = FORBIDDEN_NATIVE_ADVISORY;
  }
  return result;
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
  const profileRealRelative = relative(realpathSync(runAbsolute), realpathSync(profilePath)).split('\\').join('/');
  if (profileRealRelative === '..' || profileRealRelative.startsWith('../') || isAbsolute(profileRealRelative)) {
    throw new SteeringError(`run "${lookup.runId}" profile snapshot escapes the run directory through a symlink: ${profileRel}`);
  }
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
    (executor.agentType !== '*' && request.agentType !== executor.agentType)
  ) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" request identity does not match executor "${request.executor}" in the run profile snapshot.`,
    );
  }
  const matchesNative = nativeExecutor === request.executor;
  const hasFallback = executor.fallbackCommand != null;
  const detail = matchesNative
    ? `host request ${dispatchId} is locked to run-snapshotted executor ${request.executor}; execute natively`
    : hasFallback
      ? `host request ${dispatchId} is locked to ${request.executor}; deliver it through that executor's declared command fallback`
      : `host request ${dispatchId} requires native executor ${request.executor}; this session is materialized for ${nativeExecutor ?? 'no native executor'}, so start a matching Codex session`;
  return decorateSteering({
    mode: matchesNative ? 'native' : hasFallback ? 'command' : 'restart_required',
    archetype,
    role,
    activeLoadout: null,
    executor: request.executor,
    adapter: 'host',
    model: request.model,
    source: 'host-request',
    override: false,
    nativeExecutor,
    detail,
  }, profile, null);
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

  const profile = profileOf(repoRoot, opts.userPathOptions);
  const nativeSpec = nativeExecutor == null ? null : profile.executors[nativeExecutor];
  if (nativeExecutor != null && (nativeSpec == null || nativeSpec.adapter !== 'host')) {
    throw new SteeringError(
      `native executor "${nativeExecutor}" is not a declared host executor; ` +
        're-apply Codex steering from a host-backed baseline loadout.',
    );
  }

  let active: ActiveLoadout | null;
  // Overrides ride the same read as the pin's base name and apply only when
  // that base is the loadout in force — a `--loadout other` resolves clean.
  let overrides: Record<string, string>;
  try {
    const pin = readLocalLoadoutState(repoRoot);
    active = resolveActiveLoadout({
      flagValue: opts.loadout ?? null,
      envValue: opts.env !== undefined ? opts.env : process.env.FADENO_LOADOUT ?? null,
      localFileValue: pin.loadout,
      userFileValue: readUserLoadout(opts.userPathOptions),
      profile,
    });
    overrides = applicableOverrides(pin, active);
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
    return decorateSteering({
      mode: 'native', archetype, role, activeLoadout: null, executor: nativeExecutor,
      adapter: 'host', model: nativeSpec.model, source: 'native-baseline', override: false, nativeExecutor,
      detail: `no loadout is active; execute natively as baseline ${nativeExecutor}`,
    }, profile, null);
  }

  let resolved;
  try {
    resolved = role != null
      ? resolveRole(role, archetype, profile, active.name, overrides)
      : resolveRole(
          archetype,
          archetype,
          { ...profile, bindings: profile.bindings['*'] != null ? { '*': profile.bindings['*'] } : {} },
          active.name,
          overrides,
        );
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }

  // Both command deliveries below (a command executor, and a host executor's
  // declared fallback) are checked against the archetype's write requirement:
  // a slot that would refuse the work is never presented as a clean command
  // slot. A native slot is exempt — the host owns its agent's permissions.
  const finish = (base: SteeringResolutionBase): SteeringResolution =>
    decorateSteering(base, profile, resolved.resolvedVia);

  const refusal = (spec: ExecutorSpec, executorName: string): SteeringResolution | null => {
    const conflict = explainWriteConflict({ executor: executorName, spec }, archetype, profile);
    if (conflict == null) return null;
    return finish({
      mode: 'write_conflict', archetype, role, activeLoadout: active,
      executor: executorName, adapter: spec.adapter, model: spec.model,
      source: resolved.source, override: resolved.source === 'override', nativeExecutor,
      detail: conflict,
      writeConflict: conflict,
    });
  };

  if (resolved.executor.adapter === 'command') {
    return refusal(resolved.executor, resolved.executorName) ?? finish({
      mode: 'command', archetype, role, activeLoadout: active,
      executor: resolved.executorName, adapter: 'command', model: resolved.executor.model,
      source: resolved.source, override: resolved.source === 'override', nativeExecutor,
      detail: `dispatch through command executor ${resolved.executorName}; effective immediately`,
    });
  }
  if (nativeExecutor === resolved.executorName) {
    return finish({
      mode: 'native', archetype, role, activeLoadout: active,
      executor: resolved.executorName, adapter: 'host', model: resolved.executor.model,
      source: resolved.source, override: resolved.source === 'override', nativeExecutor,
      detail: `host executor ${resolved.executorName} matches this session's native baseline`,
    });
  }
  if (resolved.executor.fallbackCommand != null) {
    return refusal(resolved.executor, resolved.executorName) ?? finish({
      mode: 'command', archetype, role, activeLoadout: active,
      executor: resolved.executorName, adapter: 'host', model: resolved.executor.model,
      source: resolved.source, override: resolved.source === 'override', nativeExecutor,
      detail:
        `host executor ${resolved.executorName} differs from this session's native baseline ` +
        `${nativeExecutor ?? '(none)'}; use its declared command fallback immediately`,
    });
  }
  return finish({
    mode: 'restart_required', archetype, role, activeLoadout: active,
    executor: resolved.executorName, adapter: 'host', model: resolved.executor.model,
    source: resolved.source, override: resolved.source === 'override', nativeExecutor,
    detail:
      `loadout ${active.name} requests host executor ${resolved.executorName}, but this session was ` +
      `materialized for ${nativeExecutor ?? 'no native executor'}; apply the loadout and start a fresh Codex session`,
  });
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
  cliPath: string,
): string {
  const behavior = ROLE_BEHAVIOR[archetype] ?? `Perform the ${archetype} role exactly as requested.`;
  const cli = /\s/.test(cliPath) ? JSON.stringify(cliPath) : cliPath;
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
\`${cli} steering resolve --archetype ${archetype} --native-executor ${executorName} --run <run-id> --dispatch-id <dispatch-id>\`
If either identity is absent or validation fails, stop and report the resolver
error; never fall back to the ordinary ambient preflight for an engine assignment.
For that engine assignment only:
- mode=native: ${behavior}
- mode=command: run \`${cli} dispatch-fallback <run-id> <dispatch-id>\` and
  relay stdout verbatim. That command owns the start and terminal receipts.
- mode=restart_required: stop and relay the resolver's restart instruction.

For an ordinary task beginning with the ordinary \`# Fadeno step assignment\` heading, run:
\`${cli} steering resolve --archetype ${archetype} --native-executor ${executorName}\`
For that ordinary task:
- mode=native: ${behavior}
- mode=command: write the ENTIRE task prompt you received verbatim to a unique
  file under .fadeno/local/prompts/, run
  \`${cli} dispatch --archetype ${archetype} --prompt-file <path>\`, and relay stdout
  verbatim. On a non-zero exit, report the error and do not perform the
  task yourself. The command executor runs outside this subagent's sandbox.
- mode=restart_required: stop and relay the resolver's restart instruction.
- mode=write_conflict: stop and relay the resolver's refusal verbatim. The
  loadout's delivery cannot write, so never dispatch it and never substitute
  yourself for the executor the loadout names.

Never use ordinary \`fadeno dispatch\` for a locked engine request and never
silently substitute a different model or executor.
"""
`;
}

function renderCodexCommandBroker(archetype: string, cliPath: string): string {
  const cli = /\s/.test(cliPath) ? JSON.stringify(cliPath) : cliPath;
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
\`${cli} steering resolve --archetype ${archetype} --run <run-id> --dispatch-id <dispatch-id>\`
If either identity is absent or validation fails, stop and report the resolver
error; never fall back to the ordinary ambient preflight for an engine assignment.
For that engine assignment only:
- mode=command: run \`${cli} dispatch-fallback <run-id> <dispatch-id>\` and
  relay stdout verbatim. That command owns the start and terminal receipts.
- mode=native or mode=restart_required: stop and relay the resolver's instruction.

For an ordinary task beginning with the ordinary \`# Fadeno step assignment\` heading, run:
\`${cli} steering resolve --archetype ${archetype}\`
For that ordinary task:
- mode=command: write the ENTIRE task prompt you received verbatim to a unique
  file under .fadeno/local/prompts/, run
  \`${cli} dispatch --archetype ${archetype} --prompt-file <path>\`, and relay stdout verbatim.
  On a non-zero exit, report the error and do not perform the
  task yourself.
- mode=native or mode=restart_required: stop and relay the resolver's
  instruction; a host slot must run in a matching native Codex agent.
- mode=write_conflict: stop and relay the resolver's refusal verbatim. The
  loadout's delivery cannot write, so never dispatch it and never do the work
  on this broker instead.
- If the resolver errors, stop and report the error rather than doing the role
  work on this broker.

Never use ordinary \`fadeno dispatch\` for a locked engine request and never
silently substitute a different model or executor. The executor named by the
resolver owns the work.
"""
`;
}

export interface SteeringApplyOptions extends CommonOptions {
  loadout: string;
  target: 'codex';
  force?: boolean;
  /** Advanced override; normal setup/use materialize at user scope. */
  scope?: 'project' | 'user';
  /** Stable managed CLI used by user-scoped agents; bare `fadeno` is fallback. */
  cliPath?: string;
}

export interface SteeringApplyResult {
  loadout: string;
  results: EmitResult[];
  materialization: Record<string, {
    /** `write-conflict` slots are refused: no agent file is written for them. */
    kind: 'native' | 'command-broker' | 'write-conflict';
    adapter: ExecutorSpec['adapter'];
    executor: string;
    model: string | null;
    /** The shared refusal, present only on a `write-conflict` slot. */
    writeConflict?: string;
  }>;
  /** Host-only compatibility view; command-broker slots are omitted. */
  baseline: Record<string, string>;
  restartRequired: boolean;
  /** Files that were preserved because they are not Fadeno-managed. */
  conflicts: string[];
  scope: 'project' | 'user';
}

function codexAgentDir(scope: 'project' | 'user', repoRoot: string, userPathOptions?: UserPathOptions): string {
  if (scope === 'project') return join(repoRoot, '.codex', 'agents');
  const codexHome = userPathOptions?.env?.CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    join(userPathOptions?.home ?? homedir(), '.codex');
  return join(codexHome, 'agents');
}

function managedAgentEmit(path: string, body: string, force: boolean, scope: 'project' | 'user'): EmitResult['status'] {
  if (scope === 'project') return emitFile(path, body, force);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.startsWith('# fadeno:managed')) return 'skipped';
    if (existing === body) return 'skipped';
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body, 'utf8');
    return 'overwritten';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return 'created';
}

/** Materialize every required loadout slot into a session-static Codex role agent. */
export function runSteeringApply(opts: SteeringApplyOptions): SteeringApplyResult {
  const repoRoot = rootOf(opts);
  const profile = profileOf(repoRoot, opts.userPathOptions);
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
  const scope = opts.scope ?? 'project';
  const agentDir = codexAgentDir(scope, repoRoot, opts.userPathOptions);
  const managedCli = userPaths(opts.userPathOptions).managedCli;
  const cliPath = opts.cliPath ?? (scope === 'user' && existsSync(managedCli) ? managedCli : 'fadeno');
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const executorName = slots[archetype];
    const spec = executorName == null ? null : executorForArchetype(profile, executorName, archetype);
    if (executorName == null || spec == null) {
      throw new SteeringError(
        `loadout "${loadout}" needs an executor in its "${archetype}" slot to materialize ` +
          `a Codex role agent; found ${executorName ?? 'no slot'}.`,
      );
    }
    const filename = scope === 'user' ? `fadeno-${archetype}.toml` : `${archetype}.toml`;
    const path = join(agentDir, filename);
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
      body = renderCodexNativeAgent(archetype, executorName, spec, cliPath);
    } else {
      // Materializing a broker for a slot whose command cannot write would
      // hand this archetype's work to a delivery that must refuse it. Skip the
      // slot — no agent file, no half-truth — and let the rest materialize.
      const conflict = explainWriteConflict({ executor: executorName, spec }, archetype, profile);
      if (conflict != null) {
        materialization[archetype] = {
          kind: 'write-conflict', adapter: 'command', executor: executorName, model: spec.model,
          writeConflict: conflict,
        };
        continue;
      }
      materialization[archetype] = {
        kind: 'command-broker', adapter: 'command', executor: executorName, model: spec.model,
      };
      body = renderCodexCommandBroker(archetype, cliPath);
    }
    const managed = scope === 'user'
      ? `# fadeno:managed version=${packageVersion()} digest=${sha256Hex(body)}\n`
      : '';
    pending.push({ path, body: `${managed}${body}` });
  }
  for (const item of pending) {
    results.push({ path: item.path, status: managedAgentEmit(item.path, item.body, opts.force ?? false, scope) });
  }
  const conflicts = pending
    .filter((item) => !existsSync(item.path) || readFileSync(item.path, 'utf8') !== item.body)
    .map((item) => item.path);
  const restartRequired = results.some((item) => item.status === 'created' || item.status === 'overwritten');
  return { loadout, results, materialization, baseline, restartRequired, conflicts, scope };
}

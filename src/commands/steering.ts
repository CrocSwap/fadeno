import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  compileDialRef,
  applyWritePosture,
  commandRoutable,
  explainWriteConflict,
  eligibilityFor,
  formatDialRef,
  forcesWritePosture,
  loadExecutorProfile,
  parseDialRef,
  parseSnapshotDocument,
  readLocalDialState,
  resolveDialCascade,
  shadowSampleRoll,
  type DialLayers,
  type DialRef,
  type ExecutorProfile,
  type LoadedExecutorProfile,
  type ExecutorSpec,
  type RoleResolutionSource,
  type ShadowAttachment,
  type SnapshotDocument,
} from '../lib/executors.ts';
import { readUserDials } from '../lib/user-paths.ts';
import { emitFile, type EmitResult } from '../lib/fsutil.ts';
import { HostDispatchError, readHostDispatchRequest, type HostDispatchRequest, type HostDispatchRequestLookup } from '../lib/host-dispatch.ts';
import { findRepoRoot, packageVersion, templatesDir } from '../lib/paths.ts';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { userPaths, type UserPathOptions } from '../lib/user-paths.ts';

export class SteeringError extends Error {}

/**
 * Archetypes that expose an in-session host agent surface today. A declared
 * archetype that is not itself one of these is delivered in-host through the
 * first chain member that is.
 */
export const HOST_SURFACE_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

const HOST_SURFACE_SET: ReadonlySet<string> = new Set(HOST_SURFACE_ARCHETYPES);

export const NEUTRAL_HOST_EXECUTOR = 'current-host';

/**
 * A `current-host` + `agent_type: "*"` request is already assigned to a
 * concrete host agent; the caller needs no `--host-executor` marker to prove it.
 */
export function isReferenceFrameNeutralHostRequest(
  request: HostDispatchRequest,
  spec: ExecutorSpec,
): boolean {
  return (
    request.executor === NEUTRAL_HOST_EXECUTOR &&
    request.agentType === '*' &&
    spec.adapter === 'host' &&
    spec.agentType === '*' &&
    spec.model === NEUTRAL_HOST_EXECUTOR
  );
}

const FORBIDDEN_HOST_ADVISORY =
  'This work is write-forbidden (requires_write: forbidden): produce artifacts in your reply only — do not edit, create, or commit workspace files.';

/**
 * `write_conflict` is a command slot the resolver refuses to present as
 * runnable: the archetype declares `requires_write` and the delivery command
 * cannot mutate the workspace. Distinct from `restart_required` — a fresh
 * session does not fix it; the binding or the command's permission mode does.
 */
export type SteeringMode = 'host' | 'command' | 'restart_required' | 'write_conflict';

export interface SteeringResolution {
  mode: SteeringMode;
  archetype: string;
  role: string | null;
  executor: string;
  adapter: ExecutorSpec['adapter'];
  model: string | null;
  effort: string | null;
  driver: string | null;
  source: RoleResolutionSource | 'host-request';
  dial: DialRef;
  hostExecutor: string | null;
  detail: string;
  /** The shared refusal, present only on a `write_conflict` resolution. */
  writeConflict?: string;
  /** Archetype whose binding fired when a fallback chain was walked; null on a direct bind. */
  resolved_via: string | null;
  /**
   * Host agent surface that should deliver this work when the declared
   * archetype is not itself one of `HOST_SURFACE_ARCHETYPES`.
   */
  surface_archetype?: string;
  /** Advisory-only write-forbidden instruction for host delivery. */
  advisory?: string;
  /** Wildcard specialization: the immutable requested agent type (may be "*"), present on locked resolves. */
  requested_agent_type?: string;
  /** Wildcard specialization: the concrete archetype delivered when the request was wildcard, present when requested_agent_type is "*". */
  delivered_archetype?: string;
  /** Request-locked host identity remains requested evidence, never runtime verification. */
  identity_evidence?: 'requested_only';
  /**
   * The pair decision, when this archetype carries a shadow attachment.
   * Computed identically to `runDialResolve`'s `shadow` field — same
   * attachment lookup, same challenger string, same roll — so a Codex
   * resolve and a Claude dial resolve for the same prompt cannot disagree.
   * Ambient path only: a locked engine request (`runLockedSteeringResolve`)
   * never sets this, since its delivery mode is fixed by the run snapshot.
   */
  shadow?: {
    attached: true;
    challenger: string;
    rate: number | null;
    selected: boolean | null;
    routable: boolean;
  };
}

interface CommonOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
}

function rootOf(opts: CommonOptions): string {
  return opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
}

function profileOf(repoRoot: string, userPathOptions?: UserPathOptions): LoadedExecutorProfile {
  try {
    return loadExecutorProfile(repoRoot, userPathOptions, 'codex');
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
function nextArchetypeFallback(profile: ExecutorProfile | SnapshotDocument, name: string): string | null {
  if (!Object.hasOwn(profile.archetypes, name)) return null;
  const next = profile.archetypes[name]!.fallback;
  return typeof next === 'string' ? next : null;
}

function fallbackChain(profile: ExecutorProfile | SnapshotDocument, start: string): string[] {
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
 * Attach chain evidence and host-delivery extras. A host slot whose
 * declared archetype is not itself a host surface must land on one via the
 * fallback chain — otherwise there is no agent to hand the work to.
 */
function decorateSteering(
  base: SteeringResolutionBase,
  profile: ExecutorProfile | SnapshotDocument,
  resolvedVia: string | null,
  allowHostWithoutSurface = false,
): SteeringResolution {
  const result: SteeringResolution = { ...base, resolved_via: resolvedVia };
  if (result.mode !== 'host') return result;
  if (!HOST_SURFACE_SET.has(result.archetype)) {
    const chain = fallbackChain(profile, result.archetype);
    const surface = chain.find((name) => HOST_SURFACE_SET.has(name));
    if (surface == null) {
      if (!allowHostWithoutSurface) {
        throw new SteeringError(
          `archetype "${result.archetype}" has no host agent surface on its fallback chain (${chain.join(' → ')}); ` +
            `deliver it through a command route, or declare a fallback to ${HOST_SURFACE_ARCHETYPES.join(', ')}.`,
        );
      }
    } else {
      result.surface_archetype = surface;
    }
  }
  if (
    Object.hasOwn(profile.archetypes, result.archetype) &&
    profile.archetypes[result.archetype]!.requiresWrite === 'forbidden'
  ) {
    result.advisory = FORBIDDEN_HOST_ADVISORY;
  }
  return result;
}

export interface SteeringResolveOptions extends CommonOptions {
  archetype: string;
  role?: string | null;
  hostExecutor?: string | null;
  /** Immutable engine delivery identity; must be supplied as a pair. */
  run?: string | null;
  dispatchId?: string | null;
  /**
   * The digest the shadow roll is keyed on, or the file to hash it from.
   * `promptFile` is read and sha256'd here, over the same utf8 bytes the
   * kernel hashes (`sha256Hex(prompt)` in `src/commands/dispatch.ts`) — the
   * agent is expected to pass the very file it will later hand to `fadeno
   * dispatch --prompt-file`, so the two hash the same content. `promptSha256`
   * is the pre-computed alternative. Ambient path only (see `shadow` below).
   */
  promptSha256?: string | null;
  promptFile?: string | null;
}

function snapshotProfileForRequest(lookup: HostDispatchRequestLookup): SnapshotDocument {
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
    return parseSnapshotDocument(text, `${profileRel} (run snapshot)`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
}

// Shadow pairing is deliberately not applied here: a locked engine request is
// an immutable dispatch with its own receipts contract, and changing its
// delivery mode out from under that contract is out of scope for phase 5.
function runLockedSteeringResolve(opts: SteeringResolveOptions, archetype: string, role: string | null, hostExecutor: string | null): SteeringResolution {
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
  // `*` is an immutable wildcard, not the literal name of an agent surface.
  // Archetyped roles are concretized when drive mints the request; an
  // archetype-free role (notably the starter coordinator) intentionally keeps
  // `*` so any concrete host surface may claim it. The run snapshot still
  // locks model, effort, executor, and the fact that the type was wildcard.
  if (request.agentType !== '*' && request.agentType !== archetype) {
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
  if (!Object.hasOwn(profile.archetypes, archetype)) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" cannot specialize wildcard identity to undeclared archetype "${archetype}".`,
    );
  }
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
  if (eligibilityFor(executor, archetype) === 'forbidden') {
    throw new SteeringError(
      `host dispatch "${dispatchId}" cannot specialize to archetype "${archetype}": executor "${request.executor}" declares it eligibility: forbidden.`,
    );
  }
  const writeConflict = explainWriteConflict(
    { executor: request.executor, spec: executor },
    archetype,
    profile as unknown as ExecutorProfile,
  );
  if (writeConflict != null) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" cannot specialize to archetype "${archetype}" because its snapshotted write posture is incompatible: ${writeConflict}`,
    );
  }
  const matchesHost = hostExecutor === request.executor;
  const hasFallback = executor.fallbackCommand != null;
  const neutral = isReferenceFrameNeutralHostRequest(request, executor);
  const detail = matchesHost
    ? `host request ${dispatchId} is locked to run-snapshotted executor ${request.executor}; execute in-host`
    : neutral
      ? `host request ${dispatchId} is locked to the reference-frame-neutral executor current-host; execute in-host`
      : hasFallback
        ? `host request ${dispatchId} is locked to ${request.executor}; deliver it through that executor's declared command fallback`
        : `host request ${dispatchId} requires host executor ${request.executor}; this session is materialized for ${hostExecutor ?? 'no host executor'}, so start a matching Codex session`;
  // For locked, dial is the executor ref itself
  let dial: DialRef;
  try { dial = parseDialRef(request.executor, 'locked'); } catch { dial = { model: request.executor }; }
  const compiled = (() => { try { return compileDialRef(dial, profile as unknown as ExecutorProfile); } catch { return null; } })();
  // Structured wildcard specialization: report both the immutable requested "*" and the concrete delivered archetype
  // without upgrading identity_evidence. This is advisory routing, not a new attestation.
  const requestedAgentType = request.agentType;
  const deliveredArchetype = requestedAgentType === '*' ? archetype : undefined;
  const base: SteeringResolution = {
    mode: matchesHost || neutral ? 'host' : hasFallback ? 'command' : 'restart_required',
    archetype,
    role,
    executor: request.executor,
    adapter: 'host',
    model: request.model,
    effort: request.reasoningEffort,
    driver: (executor as any).driver ?? compiled?.driver ?? null,
    source: 'host-request',
    dial,
    hostExecutor,
    detail,
    resolved_via: null,
    requested_agent_type: requestedAgentType,
    identity_evidence: 'requested_only',
    ...(deliveredArchetype != null ? { delivered_archetype: deliveredArchetype } : {}),
  };
  // A wildcard request is already assigned to a concrete host agent. That
  // agent may claim the locked request as `director` (or another declared,
  // compatible archetype) without a separately materialized subagent surface.
  // Concrete requests still require the ordinary host-surface contract.
  return decorateSteering(base, profile, null, requestedAgentType === '*');
}

/**
 * The digest the shadow roll is keyed on. `promptSha256` wins if given;
 * otherwise a `promptFile` is read and hashed here, over the same utf8 bytes
 * `sha256Hex(prompt)` hashes in `src/commands/dispatch.ts` for a dispatch of
 * that same file — so a Codex agent that resolves and then dispatches the
 * same path gets one digest, not two. An unreadable file answers "no digest"
 * rather than throwing: a caller that cannot supply the prompt yet must not
 * be refused resolution, only left with `shadow.selected: null`.
 */
function resolvePromptDigest(opts: SteeringResolveOptions): string | null {
  const direct = opts.promptSha256?.trim();
  if (direct) return direct;
  const file = opts.promptFile?.trim();
  if (!file) return null;
  try {
    const text = readFileSync(resolve(opts.cwd ?? process.cwd(), file), 'utf8');
    return sha256Hex(text);
  } catch {
    return null;
  }
}

/**
 * Resolve one invocation from a session-static host Codex role agent.
 * Command slots switch immediately; host slots execute locally only when they
 * match the executor materialized into that host agent definition.
 */
export function runSteeringResolve(opts: SteeringResolveOptions): SteeringResolution {
  const repoRoot = rootOf(opts);
  const archetype = validateArchetype(opts.archetype);
  const role = opts.role?.trim() ? opts.role.trim() : null;
  const hostExecutor = opts.hostExecutor?.trim() ? opts.hostExecutor.trim() : null;
  const hasRun = opts.run != null;
  const hasDispatchId = opts.dispatchId != null;
  if (hasRun !== hasDispatchId || (hasRun && (opts.run!.trim() === '' || opts.dispatchId!.trim() === ''))) {
    throw new SteeringError('locked steering resolution requires both --run and --dispatch-id.');
  }
  if (hasRun && hasDispatchId) return runLockedSteeringResolve(opts, archetype, role, hostExecutor);

  const { profile } = profileOf(repoRoot, opts.userPathOptions);
  let hostSpec: ExecutorSpec | null = null;
  if (hostExecutor != null) {
    let parsed: DialRef | null = null;
    try { parsed = parseDialRef(hostExecutor, 'host'); } catch {}
    if (parsed != null) {
      try { hostSpec = compileDialRef(parsed, profile).spec; } catch {}
    }
    if (hostSpec == null && (profile as unknown as SnapshotDocument).executors != null) {
      hostSpec = (profile as unknown as SnapshotDocument).executors[hostExecutor] ?? null;
    }
    if (hostSpec == null) {
      try {
        const fallback = (profile as unknown as Record<string, unknown>).executors as Record<string, ExecutorSpec> | undefined;
        if (fallback != null && hostExecutor in fallback) hostSpec = fallback[hostExecutor]!;
      } catch {}
    }
  }
  if (hostExecutor != null && (hostSpec == null || hostSpec.adapter !== 'host')) {
    throw new SteeringError(
      `host executor "${hostExecutor}" is not a declared host executor; ` +
        're-apply Codex steering from a host-backed dial baseline.',
    );
  }

  // Read dial layers (strict: malformed v3 pin throws)
  let dialLayers: DialLayers;
  let legacyNote: string | null = null;
  let detailNote = '';
  let shadows: Record<string, ShadowAttachment> = {};
  try {
    const state = readLocalDialState(repoRoot);
    legacyNote = state.legacyNote;
    if (legacyNote != null) detailNote = ` ${legacyNote}`;
    shadows = state.shadows;
    const userRaw = readUserDials(opts.userPathOptions ?? {});
    const user: Record<string, DialRef> = {};
    for (const [k, v] of Object.entries(userRaw)) user[k] = v as DialRef;
    dialLayers = { session: state.dials, repo: { ...profile.dials } as Record<string, DialRef>, user };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }

  // Resolve via dial cascade
  let cascade: { ref: DialRef; source: RoleResolutionSource; resolvedVia: string | null };
  try {
    cascade = resolveDialCascade(role ?? archetype, archetype, { bindings: profile.bindings, archetypes: profile.archetypes }, dialLayers);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
  const refString = formatDialRef(cascade.ref);
  let spec: ExecutorSpec | null = (profile as unknown as SnapshotDocument).executors?.[refString] ?? null;
  let compiled: ReturnType<typeof compileDialRef> | null = null;
  try { compiled = compileDialRef(cascade.ref, profile); } catch {}
  if (spec == null && compiled != null) spec = compiled.spec;
  if (spec == null) throw new SteeringError(`resolved dial "${refString}" has no compiled executor in profile`);
  // Bind neutral host agentType
  if (spec.adapter === 'host' && (spec as any).agentType === '*' && archetype != null) spec = { ...spec, agentType: archetype } as ExecutorSpec;
  // Write-posture delivery selection, same rule as dispatch/drive.
  spec = applyWritePosture(spec, archetype, profile.archetypes).spec;

  // The pair decision — computed identically to `runDialResolve`'s `shadow`
  // field (same attachment lookup, same challenger string, same roll) so a
  // Codex and a Claude resolve for the same prompt cannot disagree. Surfaced
  // on every mode, not only `host`: a caller wants to see the attachment
  // regardless of what this resolution turns out to be, even though only the
  // `host` branch below acts on it.
  const attachment = shadows[archetype];
  let shadow: SteeringResolution['shadow'];
  if (attachment != null) {
    const challenger = formatDialRef({
      model: attachment.model,
      ...(attachment.effort ? { effort: attachment.effort } : {}),
      ...(attachment.via ? { via: attachment.via } : {}),
    });
    const digest = resolvePromptDigest(opts);
    const rate = attachment.rate ?? null;
    shadow = {
      attached: true,
      challenger,
      rate,
      // No rate means every dispatch fires; no digest means the caller cannot
      // be told, and must not read the silence as a "no".
      selected: rate == null ? true : digest ? shadowSampleRoll(digest, archetype, challenger) < rate : null,
      // The PRIMARY's own resolved spec, after write-posture — what a
      // selected pair would have to reuse to reach the command lane.
      routable: commandRoutable(spec),
    };
  }

  // Every branch below funnels through `finish`, so attaching `shadow` here
  // once — rather than at each call site — is what keeps it uniformly
  // visible regardless of which mode this resolution lands on.
  const finish = (base: Omit<SteeringResolution, 'resolved_via' | 'surface_archetype' | 'advisory'>): SteeringResolution =>
    decorateSteering({ ...(shadow != null ? { shadow } : {}), ...base } as any, profile, cascade.resolvedVia);

  const refusal = (spec: ExecutorSpec, executorName: string): SteeringResolution | null => {
    const conflict = forcesWritePosture(cascade.ref, cascade.resolvedVia)
      ? null
      : explainWriteConflict({ executor: executorName, spec }, archetype, profile);
    if (conflict == null) return null;
    return finish({
      mode: 'write_conflict', archetype, role,
      executor: executorName, adapter: spec.adapter, model: (spec as any).model ?? compiled?.model ?? null,
      effort: compiled?.effort ?? (spec.adapter === 'host' ? (spec as any).reasoningEffort : null),
      driver: (spec as any).driver ?? compiled?.driver ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      detail: conflict + detailNote,
      writeConflict: conflict,
    } as any);
  };

  if (spec.adapter === 'command') {
    return refusal(spec, refString) ?? finish({
      mode: 'command', archetype, role,
      executor: refString, adapter: 'command', model: (spec as any).model ?? compiled?.model ?? null,
      effort: compiled?.effort ?? null, driver: (spec as any).driver ?? compiled?.driver ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      detail: `dispatch through command executor ${refString}; effective immediately${detailNote}`,
    } as any);
  }
  // host adapter
  if (cascade.source === 'base' || hostExecutor === refString) {
    // A selected pair forces both arms onto the command lane even though this
    // host executor otherwise matches the session baseline and would resolve
    // in-session — an in-session primary cannot be isolated, measured, or
    // diffed the way its challenger is. Gated on `routable` too: a primary
    // with no `fallback_command` has no command lane to force onto, and
    // routing it here anyway would only hand the agent a `fadeno dispatch`
    // that the kernel's own `host_in_session` refusal would then reject.
    if (shadow?.selected === true && shadow.routable === true) {
      return finish({
        mode: 'command', archetype, role,
        executor: refString, adapter: 'host', model: (spec as any).model,
        effort: (spec as any).reasoningEffort ?? compiled?.effort ?? null,
        driver: (spec as any).driver ?? compiled?.driver ?? null,
        source: cascade.source, dial: cascade.ref, hostExecutor,
        detail: `pair selected: ${archetype} → ${refString} moved to its command lane so both arms are comparable${detailNote}`,
      } as any);
    }
    return finish({
      mode: 'host', archetype, role,
      executor: refString, adapter: 'host', model: (spec as any).model,
      effort: (spec as any).reasoningEffort ?? compiled?.effort ?? null,
      driver: (spec as any).driver ?? compiled?.driver ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      detail: `host executor ${refString} matches this session's host baseline${detailNote}`,
    } as any);
  }
  if (spec.fallbackCommand != null) {
    return refusal(spec, refString) ?? finish({
      mode: 'command', archetype, role,
      executor: refString, adapter: 'host', model: (spec as any).model,
      effort: (spec as any).reasoningEffort ?? compiled?.effort ?? null,
      driver: (spec as any).driver ?? compiled?.driver ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      detail: `host executor ${refString} differs from this session's host baseline ${hostExecutor ?? '(none)'}; use its declared command fallback immediately${detailNote}`,
    } as any);
  }
  return finish({
    mode: 'restart_required', archetype, role,
    executor: refString, adapter: 'host', model: (spec as any).model,
    effort: (spec as any).reasoningEffort ?? compiled?.effort ?? null,
    driver: (spec as any).driver ?? compiled?.driver ?? null,
    source: cascade.source, dial: cascade.ref, hostExecutor,
    detail: `dial ${refString} requests host executor ${refString}, but this session was materialized for ${hostExecutor ?? 'no host executor'}; apply the dial and start a fresh session${detailNote}`,
  } as any);
}

const ROLE_BEHAVIOR: Record<string, string> = {
  worker: 'Implement the requested change, preserving unrelated work and validating the behavior you changed.',
  reviewer: 'Review correctness, security, regressions, edge cases, and tests; report concrete findings before summary.',
  judge: 'Evaluate against the stated criteria and emit the requested structured judgment; never decide Fadeno control flow yourself.',
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderCodexHostAgent(
  archetype: string,
  executorName: string,
  spec: Extract<ExecutorSpec, { adapter: 'host' }>,
  cliPath: string,
): string {
  const behavior = ROLE_BEHAVIOR[archetype] ?? `Perform the ${archetype} role exactly as requested.`;
  const cli = /\s/.test(cliPath) ? JSON.stringify(cliPath) : cliPath;
  return `name = ${tomlString(archetype)}
description = ${tomlString(`Fadeno hybrid ${archetype}: host-delivered on the session baseline, command-dispatched when the active loadout switches providers.`)}
model = ${tomlString(spec.model)}
model_reasoning_effort = ${tomlString(spec.reasoningEffort)}
sandbox_mode = "workspace-write"

developer_instructions = """
You are Fadeno's hybrid ${archetype}. Do not spawn subagents.

Before every task, inspect whether the delivery begins with \`# Fadeno engine step assignment\`.
For an engine assignment, the host coordinator must provide both \`run: <run-id>\`
and \`dispatch_id: <dispatch-id>\` in the delivery envelope. Run:
\`${cli} steering resolve --archetype ${archetype} --host-executor ${executorName} --run <run-id> --dispatch-id <dispatch-id>\`
If either identity is absent or validation fails, stop and report the resolver
error; never fall back to the ordinary ambient preflight for an engine assignment.
For that engine assignment only:
- mode=host: ${behavior}
- mode=command: run \`${cli} dispatch-fallback <run-id> <dispatch-id>\` and
  relay stdout verbatim. That command owns the start and terminal receipts.
- mode=restart_required: stop and relay the resolver's restart instruction.

For an ordinary task beginning with the ordinary \`# Fadeno step assignment\` heading, FIRST
write the ENTIRE task prompt you received verbatim to a unique file under
.fadeno/local/prompts/, THEN run:
\`${cli} steering resolve --archetype ${archetype} --host-executor ${executorName} --prompt-file <path>\`
The resolver hashes that file to decide whether this spawn is paired with a
shadow challenger, so it must see the prompt bytes before it answers — never
omit \`--prompt-file\` on the ordinary path.
For that ordinary task:
- mode=host: ${behavior}
- mode=command: run \`${cli} dispatch --archetype ${archetype} --prompt-file <path>\`
  with that same file, and relay stdout verbatim. On a non-zero exit, report
  the error and do not perform the task yourself. The command executor runs
  outside this subagent's sandbox. A resolution of mode=command here can mean
  either the dial itself is command-delivered, or a shadow pair was selected
  and both arms are moving to the command lane so they are comparable —
  either way, dispatch the same file the same way.
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
description = ${tomlString(`Fadeno command broker ${archetype}: delegates command slots through the active loadout and stops when a host slot needs host materialization.`)}
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
- mode=host or mode=restart_required: stop and relay the resolver's instruction.

For an ordinary task beginning with the ordinary \`# Fadeno step assignment\` heading, FIRST
write the ENTIRE task prompt you received verbatim to a unique file under
.fadeno/local/prompts/, THEN run:
\`${cli} steering resolve --archetype ${archetype} --prompt-file <path>\`
The resolver hashes that file to decide whether this spawn is paired with a
shadow challenger, so it must see the prompt bytes before it answers — never
omit \`--prompt-file\` on the ordinary path.
For that ordinary task:
- mode=command: run \`${cli} dispatch --archetype ${archetype} --prompt-file <path>\`
  with that same file, and relay stdout verbatim. On a non-zero exit, report
  the error and do not perform the task yourself.
- mode=host or mode=restart_required: stop and relay the resolver's
  instruction; a host slot must run in a matching host Codex agent.
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
  target: 'codex' | 'claude';
  force?: boolean;
  /** Advanced override; normal setup/use materialize at user scope. */
  scope?: 'project' | 'user';
  /** Stable managed CLI used by user-scoped agents; bare `fadeno` is fallback. */
  cliPath?: string;
}

export interface SteeringApplyResult {
  results: EmitResult[];
  materialization: Record<string, {
    /** `write-conflict` slots are refused: no agent file is written for them. */
    kind: 'host' | 'command-broker' | 'write-conflict';
    adapter: ExecutorSpec['adapter'];
    executor: string;
    model: string | null;
    /** The shared refusal, present only on a `write-conflict` slot. */
    writeConflict?: string;
  }>;
  /** Host-only compatibility view; command-broker slots are omitted. */
  baseline: Record<string, string>;
  restartRequired: boolean;
  /** Paths of the pre-registered identity grid, one per (archetype, effort). */
  grid?: string[];
  /** Files that were preserved because they are not Fadeno-managed. */
  conflicts: string[];
  scope: 'project' | 'user';
  /** Managed files removed because their slot is no longer host-delivered. */
  removed?: string[];
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

/** Materialize every archetype's resolved dial into a session-static Codex role agent. */
export function runSteeringApply(opts: SteeringApplyOptions): SteeringApplyResult {
  const repoRoot = rootOf(opts);
  const { profile } = profileOf(repoRoot, opts.userPathOptions);
  // Read live dial layers (ignore loadout if present)
  let dialLayers: DialLayers;
  try {
    const state = readLocalDialState(repoRoot);
    const userRaw = readUserDials(opts.userPathOptions ?? {});
    const user: Record<string, DialRef> = {};
    for (const [k, v] of Object.entries(userRaw)) user[k] = v as DialRef;
    dialLayers = { session: state.dials, repo: { ...profile.dials } as Record<string, DialRef>, user };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
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
    let cascade: { ref: DialRef; source: RoleResolutionSource; resolvedVia: string | null };
    try {
      cascade = resolveDialCascade(archetype, archetype, { bindings: profile.bindings, archetypes: profile.archetypes }, dialLayers);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
      throw err;
    }
    const executorName = formatDialRef(cascade.ref);
    let spec: ExecutorSpec | null = (profile as unknown as SnapshotDocument).executors?.[executorName] ?? null;
    try {
      const compiled = compileDialRef(cascade.ref, profile);
      if (spec == null) spec = compiled.spec;
    } catch {}
    if (spec == null) {
      throw new SteeringError(`archetype "${archetype}" resolved to "${executorName}" but no executor exists in profile`);
    }
    // bind neutral host agentType
    if (spec.adapter === 'host' && (spec as any).agentType === '*' ) spec = { ...spec, agentType: archetype } as ExecutorSpec;
    // Write-posture delivery selection, same rule as dispatch/drive.
    spec = applyWritePosture(spec, archetype, profile.archetypes).spec;
    const filename = scope === 'user' ? `fadeno-${archetype}.toml` : `${archetype}.toml`;
    const path = join(agentDir, filename);
    let body: string;
    if (spec.adapter === 'host') {
      if (spec.agentType !== archetype) {
        throw new SteeringError(
          `dial "${executorName}" for ${archetype} targets ${executorName} with agent_type ` +
            `"${spec.agentType}"; expected "${archetype}".`,
        );
      }
      baseline[archetype] = executorName;
      materialization[archetype] = {
        kind: 'host', adapter: 'host', executor: executorName, model: spec.model,
      };
      body = renderCodexHostAgent(archetype, executorName, spec, cliPath);
    } else {
      // Materializing a broker for a slot whose command cannot write would
      // hand this archetype's work to a delivery that must refuse it. Skip the
      // slot — no agent file, no half-truth — and let the rest materialize.
      const conflict = forcesWritePosture(cascade.ref, cascade.resolvedVia)
        ? null
        : explainWriteConflict({ executor: executorName, spec }, archetype, profile);
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
  return { results, materialization, baseline, restartRequired, conflicts, scope };
}

// --- Claude steering materialization ---

function claudeAgentDir(scope: 'project' | 'user', repoRoot: string, userPathOptions?: UserPathOptions): string {
  if (scope === 'project') return join(repoRoot, '.claude', 'agents');
  return join(userPathOptions?.home ?? homedir(), '.claude', 'agents');
}

const CLAUDE_MANAGED_MARK = '<!-- fadeno:managed';

/**
 * Named effort levels the Claude harness accepts in an agent definition.
 * Verified against the harness itself, whose turn-effort field enumerates
 * exactly these; integers are also accepted and deliberately not gridded.
 */
export const CLAUDE_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Agent name for one cell of the identity grid.
 *
 * The grid exists because the two halves of an identity travel different
 * channels: the steering hook can rewrite a spawn's MODEL per call, but the
 * Agent tool has no effort parameter, so effort can only come from a
 * definition file — and the harness registers definitions at session start.
 * Materializing per dial therefore made every dial change cost a restart.
 * Pre-registering every (archetype, effort) cell instead means the hook only
 * ever retargets among agents that are already registered.
 *
 * Keyed on effort and NOT on model, deliberately: model is already live, so
 * adding it would make the grid combinatorial in the one dimension that grows
 * (60 models x 20 archetypes x 5 efforts is 6,000 files). Keyed this way,
 * registering a model costs nothing at all.
 */
export function claudeGridAgentName(archetype: string, effort: string): string {
  return `fadeno-${archetype}-${effort}`;
}

/**
 * Emit a fadeno-managed agent definition.
 *
 * A managed file tracks its template at BOTH scopes: the grid is regenerated
 * output, and a cell left behind at an older template or version would keep
 * serving that content forever. `--force` is for someone else's file, not for
 * ours — so an unmanaged file of the same name is still skipped without it.
 * (Pre-grid this only mattered at user scope, where a single stale per-dial
 * agent was the whole risk; with fifteen regenerated cells per repo, a
 * project-scope grid that could not refresh itself would silently rot.)
 */
function claudeManagedEmit(path: string, body: string, force: boolean, scope: 'project' | 'user'): EmitResult['status'] {
  if (scope === 'project' && existsSync(path) && !readFileSync(path, 'utf8').includes(CLAUDE_MANAGED_MARK)) {
    return emitFile(path, body, force); // not ours: non-destructive unless forced
  }
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.includes(CLAUDE_MANAGED_MARK)) return 'skipped';
    if (existing === body) return 'skipped';
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body, 'utf8');
    return 'overwritten';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return 'created';
}

/** Re-emit an agent template's frontmatter with fields injected (existing keys replaced). */
function withFrontmatterFields(template: string, fields: Record<string, string>): string {
  const match = template.match(/^---\n([\s\S]*?)\n---\n/);
  if (match == null) throw new SteeringError('agent template has no frontmatter block');
  let block = match[1]!;
  for (const key of Object.keys(fields)) {
    block = block.split('\n').filter((line) => !line.startsWith(`${key}:`)).join('\n');
  }
  const added = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n');
  return `---\n${block}\n${added}\n---\n${template.slice(match[0].length)}`;
}

/**
 * Pre-register the Claude identity grid: one managed subagent per
 * (host-surface archetype, named effort level), each declaring `model:
 * inherit` and its own `effort:`.
 *
 * This is dial-INDEPENDENT by design. The grid is a function of the effort
 * vocabulary alone, so re-running it after a dial change writes nothing and
 * asks for no restart; the steering hook picks the cell matching whatever the
 * dial currently resolves to and supplies the model on the tool call, which
 * the harness documents as overriding the definition for that call. What still
 * costs a restart is a change to the grid itself — a new effort level, or the
 * first apply in a repo.
 *
 * Legacy per-dial managed agents (`.claude/agents/<archetype>.md` written by
 * earlier versions) are removed: they pin a model the dial may have moved past,
 * and the hook must never target a stale identity. Unmanaged files of the same
 * name are never touched.
 */
export function runSteeringApplyClaude(opts: SteeringApplyOptions): SteeringApplyResult {
  const repoRoot = rootOf(opts);
  // profileOf hardcodes the codex harness (steering resolve serves codex
  // brokers); this apply materializes CLAUDE deliveries, so load that family.
  const { profile } = (() => {
    try {
      return loadExecutorProfile(repoRoot, opts.userPathOptions, 'claude');
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
      throw err;
    }
  })();
  let dialLayers: DialLayers;
  try {
    const state = readLocalDialState(repoRoot);
    const userRaw = readUserDials(opts.userPathOptions ?? {});
    const user: Record<string, DialRef> = {};
    for (const [k, v] of Object.entries(userRaw)) user[k] = v as DialRef;
    dialLayers = { session: state.dials, repo: { ...profile.dials } as Record<string, DialRef>, user };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
  const baseline: Record<string, string> = {};
  const materialization: SteeringApplyResult['materialization'] = {};
  const results: EmitResult[] = [];
  const removed: string[] = [];
  const scope = opts.scope ?? 'project';
  const agentDir = claudeAgentDir(scope, repoRoot, opts.userPathOptions);
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    let cascade: { ref: DialRef; source: RoleResolutionSource; resolvedVia: string | null };
    try {
      cascade = resolveDialCascade(archetype, archetype, { bindings: profile.bindings, archetypes: profile.archetypes }, dialLayers);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
      throw err;
    }
    const executorName = formatDialRef(cascade.ref);
    let spec: ExecutorSpec | null = (profile as unknown as SnapshotDocument).executors?.[executorName] ?? null;
    try {
      const compiled = compileDialRef(cascade.ref, profile);
      if (spec == null) spec = compiled.spec;
    } catch {}
    if (spec == null) {
      throw new SteeringError(`archetype "${archetype}" resolved to "${executorName}" but no executor exists in profile`);
    }
    if (spec.adapter === 'host' && (spec as { agentType?: string }).agentType === '*') spec = { ...spec, agentType: archetype } as ExecutorSpec;
    spec = applyWritePosture(spec, archetype, profile.archetypes).spec;
    const path = join(agentDir, `${archetype}.md`);
    if (spec.adapter !== 'host') {
      // Command slot: the dispatch proxy carries it; a managed host file left
      // behind would make the hook target yesterday's model.
      materialization[archetype] = {
        kind: 'command-broker', adapter: 'command', executor: executorName, model: (spec as { model: string | null }).model,
      };
      if (existsSync(path) && readFileSync(path, 'utf8').includes(CLAUDE_MANAGED_MARK)) {
        unlinkSync(path);
        removed.push(path);
      }
      continue;
    }
    if (spec.model === 'current-host') {
      // The session baseline needs no agent file: the plugin's native role
      // agents already run on the session's own identity.
      baseline[archetype] = executorName;
      materialization[archetype] = { kind: 'host', adapter: 'host', executor: executorName, model: spec.model };
      if (existsSync(path) && readFileSync(path, 'utf8').includes(CLAUDE_MANAGED_MARK)) {
        unlinkSync(path);
        removed.push(path);
      }
      continue;
    }
    // A dialed host identity needs no file of its own any more: the grid below
    // carries every effort, and the hook supplies the model per spawn. A
    // legacy per-dial file left here would pin whatever model was dialed when
    // it was written, so it goes the same way as the other two branches'.
    baseline[archetype] = executorName;
    materialization[archetype] = { kind: 'host', adapter: 'host', executor: executorName, model: spec.model };
    if (existsSync(path) && readFileSync(path, 'utf8').includes(CLAUDE_MANAGED_MARK)) {
      unlinkSync(path);
      removed.push(path);
    }
  }

  // The grid itself. Dial-independent, so a re-apply after re-dialing is a
  // no-op and asks for no restart.
  const grid: string[] = [];
  for (const archetype of HOST_SURFACE_ARCHETYPES) {
    const templatePath = join(templatesDir(), 'claude', 'claude-agents', `${archetype}.md`);
    if (!existsSync(templatePath)) {
      throw new SteeringError(`no claude agent template for archetype "${archetype}" at ${templatePath}`);
    }
    const template = readFileSync(templatePath, 'utf8');
    for (const effort of CLAUDE_EFFORT_LADDER) {
      const name = claudeGridAgentName(archetype, effort);
      // `inherit` is the documented spelling of "take the spawning
      // conversation's model"; the hook's per-call `model` override then wins
      // over it, which is what leaves effort as the only thing this file pins.
      let rendered = withFrontmatterFields(template, { name, model: 'inherit', effort });
      rendered = `${rendered.trimEnd()}\n\n${CLAUDE_MANAGED_MARK} version=${packageVersion()} digest=${sha256Hex(rendered)} source=grid:${archetype}@${effort} -->\n`;
      const gridPath = join(agentDir, `${name}.md`);
      grid.push(gridPath);
      results.push({ path: gridPath, status: claudeManagedEmit(gridPath, rendered, opts.force ?? false, scope) });
    }
  }

  // A skipped MANAGED file is an up-to-date cell, not a collision. Reporting
  // those as conflicts told every steady-state apply to pass `--force`.
  const conflicts = results
    .filter((item) => item.status === 'skipped')
    .filter((item) => {
      try {
        return !readFileSync(item.path, 'utf8').includes(CLAUDE_MANAGED_MARK);
      } catch {
        return true;
      }
    })
    .map((item) => item.path);
  const restartRequired = results.some((item) => item.status === 'created' || item.status === 'overwritten') || removed.length > 0;
  return { results, materialization, baseline, restartRequired, conflicts, scope, removed, grid };
}

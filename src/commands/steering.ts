import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
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
  resolveRelay,
  shadowSampleRoll,
  type DialLayers,
  type DialRef,
  type ExecutorProfile,
  type LoadedExecutorProfile,
  type ExecutorSpec,
  type ResolvedRelay,
  type RoleResolutionSource,
  type ShadowAttachment,
  type SnapshotDocument,
} from '../lib/executors.ts';
import { readUserDials } from '../lib/user-paths.ts';
import { type EmitResult } from '../lib/fsutil.ts';
import { HostDispatchError, readHostDispatchRequest, type HostDispatchRequest, type HostDispatchRequestLookup } from '../lib/host-dispatch.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { codexUserAgentDir, userPaths, type UserPathOptions } from '../lib/user-paths.ts';

export class SteeringError extends Error {}

/**
 * Archetypes that expose an in-session host agent surface today. A declared
 * archetype that is not itself one of these is delivered in-host through the
 * first chain member that is.
 *
 * Deliberately module-private. It used to be exported so `doctor` could
 * enumerate identity-grid cell names from it; the grid is retired, and this
 * is once again only about which archetypes have a role agent to land on.
 */
const HOST_SURFACE_SET: ReadonlySet<string> = new Set(['worker', 'reviewer', 'judge']);

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

// The lane predicate lives in `lib/` because `dial resolve` must answer
// identically — see src/lib/lane.ts. Re-exported so existing importers of
// these names from this module keep working.
import {
  decideLane,
  readSessionEffort,
  type DeliveryLane,
  type LaneDecision,
  type LaneInput,
  type LaneReason,
} from '../lib/lane.ts';
export { decideLane, readSessionEffort };
export type { DeliveryLane, LaneDecision, LaneInput, LaneReason };

export interface SteeringResolution extends LaneDecision {
  /**
   * The resolver's verdict, and what the agent acts on. It agrees with `lane`
   * on all three lane values and adds a fourth, `write_conflict`: a delivery
   * the lane predicate placed on the command lane but that the resolver
   * refuses to present as runnable at all.
   */
  mode: SteeringMode;
  archetype: string;
  role: string | null;
  executor: string;
  adapter: ExecutorSpec['adapter'];
  model: string | null;
  /**
   * The EFFECTIVE effort, unchanged in meaning since before the lane
   * predicate existed. `effective_effort` is its non-null twin on the JSON
   * contract; `effort_pinned` is the field that says whether anyone asked
   * for it. Old readers must keep reading this one.
   */
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
   * archetype is not itself a host surface (`worker`/`reviewer`/`judge`).
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
            `deliver it through a command route, or declare a fallback to ${[...HOST_SURFACE_SET].join(', ')}.`,
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
  /**
   * Environment the session's own effort is read from (`CLAUDE_EFFORT`).
   * Injectable so a test never depends on the effort the developer's real
   * session happens to be running at — the same reason `runAttest` takes one.
   */
  env?: NodeJS.ProcessEnv;
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
  // The lane predicate deliberately does NOT run here. A locked engine
  // request is an immutable dispatch with its own receipts contract, and its
  // delivery was decided when the run snapshot was taken — re-deciding it
  // against whatever effort *this* session happens to be running at would
  // change an identity the snapshot already froze. Same reasoning as shadow
  // pairing above. The lane fields still report faithfully: they mirror the
  // locked mode, and `effort_pinned` reads the snapshotted executor ref.
  const lockedLane: DeliveryLane =
    matchesHost || neutral ? 'host' : hasFallback ? 'command' : 'restart_required';
  const base: SteeringResolution = {
    mode: matchesHost || neutral ? 'host' : hasFallback ? 'command' : 'restart_required',
    effort_pinned: dial.effort != null,
    effective_effort: request.reasoningEffort,
    session_effort: readSessionEffort(opts.env ?? process.env),
    lane: lockedLane,
    lane_reason: 'locked to the run snapshot',
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

  // --- The lane: model AND effort ---
  //
  // `pinnedEffort` is `ref.effort ?? null` and nothing else. Reading
  // `compiled.effectiveEffort` here instead would route every casual
  // `fadeno dial worker opus` to the command lane, because every model in the
  // shipped catalog declares an `effort:` — see `LaneInput.pinnedEffort`.
  // `cascade.ref.effort` is the same value by construction and keeps the
  // predicate honest when the profile is too old to compile.
  const pinnedEffort = compiled?.pinnedEffort ?? cascade.ref.effort ?? null;
  const effectiveEffort =
    compiled?.effectiveEffort ??
    (spec.adapter === 'host' ? spec.reasoningEffort : null) ??
    // Only reachable on a legacy profile whose command executor declares no
    // effort at all and that `compileDialRef` could not compile.
    'default';
  const hostModel = spec.adapter === 'host' && (cascade.source === 'base' || hostExecutor === refString);
  const lane = decideLane({
    pinnedEffort,
    effectiveEffort,
    sessionEffort: readSessionEffort(opts.env ?? process.env),
    hostModel,
    // `refString` carries the pin (`formatDialRef` renders `luna@xhigh`), so a
    // host executor that matches it identifies an agent materialized at that
    // exact effort. This is how a Codex broker proves its own effort without
    // any harness publishing one.
    hostEffortProven: pinnedEffort != null && hostExecutor === refString,
    commandLane: commandRoutable(spec),
  });

  // Every branch below funnels through `finish`, so attaching `shadow` and the
  // lane fields here once — rather than at each call site — is what keeps them
  // uniformly visible regardless of which mode this resolution lands on. Base
  // wins on conflict, so a branch that genuinely overrides the lane (the
  // shadow pair) says so in its own literal.
  const finish = (
    base: Omit<SteeringResolution, 'resolved_via' | 'surface_archetype' | 'advisory' | keyof LaneDecision>
      & Partial<LaneDecision>,
  ): SteeringResolution =>
    decorateSteering({ ...lane, ...(shadow != null ? { shadow } : {}), ...base } as any, profile, cascade.resolvedVia);

  const refusal = (spec: ExecutorSpec, executorName: string): SteeringResolution | null => {
    const conflict = forcesWritePosture(cascade.ref, cascade.resolvedVia)
      ? null
      : explainWriteConflict({ executor: executorName, spec }, archetype, profile);
    if (conflict == null) return null;
    return finish({
      mode: 'write_conflict', archetype, role,
      executor: executorName, adapter: spec.adapter, model: (spec as any).model ?? compiled?.model ?? null,
      effort: compiled?.effectiveEffort ?? (spec.adapter === 'host' ? (spec as any).reasoningEffort : null),
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
      effort: compiled?.effectiveEffort ?? null, driver: (spec as any).driver ?? compiled?.driver ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      detail: `dispatch through command executor ${refString}; effective immediately${detailNote}`,
    } as any);
  }
  // host adapter
  if (lane.lane === 'host') {
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
        // The pair overrides the lane the effort/model predicate chose, so it
        // says so rather than letting `lane: 'host'` contradict `mode`. The
        // contract guarantee still holds: this branch is gated on
        // `shadow.routable`, which is `commandRoutable(spec)`.
        lane: 'command',
        lane_reason: 'shadow pair forces the command lane',
        executor: refString, adapter: 'host', model: (spec as any).model,
        effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
        driver: (spec as any).driver ?? compiled?.driver ?? null,
        source: cascade.source, dial: cascade.ref, hostExecutor,
        detail: `pair selected: ${archetype} → ${refString} moved to its command lane so both arms are comparable${detailNote}`,
      } as any);
    }
    return finish({
      mode: 'host', archetype, role,
      executor: refString, adapter: 'host', model: (spec as any).model,
      effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
      driver: (spec as any).driver ?? compiled?.driver ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      detail: `host executor ${refString} matches this session's host baseline${detailNote}`,
    } as any);
  }
  if (lane.lane === 'command') {
    return refusal(spec, refString) ?? finish({
      mode: 'command', archetype, role,
      executor: refString, adapter: 'host', model: (spec as any).model,
      effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
      driver: (spec as any).driver ?? compiled?.driver ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      // Two ways to be here now, and the agent is told which: the model this
      // session cannot host, or an effort it is not running at.
      detail: hostModel
        ? `host executor ${refString} matches this session's host baseline, but ${lane.lane_reason}; use its declared command fallback immediately${detailNote}`
        : `host executor ${refString} differs from this session's host baseline ${hostExecutor ?? '(none)'}; use its declared command fallback immediately${detailNote}`,
    } as any);
  }
  return finish({
    mode: 'restart_required', archetype, role,
    executor: refString, adapter: 'host', model: (spec as any).model,
    effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
    driver: (spec as any).driver ?? compiled?.driver ?? null,
    source: cascade.source, dial: cascade.ref, hostExecutor,
    // Restart reason 2 of the two that survive: a host slot naming an
    // identity with neither a session that can deliver it nor a command
    // fallback. It now has two shapes — the model, as always, and an effort
    // the session is not running at.
    detail: hostModel
      ? `dial ${refString} pins effort ${pinnedEffort} but this session runs at ${lane.session_effort ?? 'no observable effort'}, ` +
        `and ${refString} declares no command fallback; start a session at ${pinnedEffort}, drop the pin, or declare one${detailNote}`
      : `dial ${refString} requests host executor ${refString}, but this session was materialized for ${hostExecutor ?? 'no host executor'}; apply the dial and start a fresh session${detailNote}`,
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

/**
 * The relay this file falls back to when the catalog states no opinion for
 * Codex — the exact literals every broker carried before `relay:` became a
 * catalog key, so a repo whose catalog says nothing sees no diff at all.
 *
 * Not a default to "improve": a relay the session's provider cannot serve is
 * worse than a stale-but-servable one, which is why `resolveRelay` returns
 * null rather than guessing, and why this stays put until a dogfood receipt
 * moves the catalog.
 */
const BUILTIN_CODEX_RELAY_MODEL = 'gpt-5.6-luna';
const BUILTIN_CODEX_RELAY_EFFORT = 'low';

/**
 * The Codex relay named by `relay.codex`, or null for "no catalog opinion".
 *
 * A relay ref this build cannot compile (an unknown model, a provider with no
 * route under the codex harness) is deliberately treated as the same "no
 * servable opinion" answer as an absent key rather than as a hard error: the
 * whole point of the null contract is that a broker must never be pointed at
 * a model the provider cannot serve. Refusing to materialize any broker at
 * all over a bad relay would be a strictly worse outcome than materializing
 * the servable built-in one.
 */
function codexRelay(profile: ExecutorProfile): ResolvedRelay | null {
  try {
    return resolveRelay(profile, 'codex');
  } catch {
    return null;
  }
}

function renderCodexCommandBroker(
  archetype: string,
  cliPath: string,
  relay: ResolvedRelay | null,
): string {
  const cli = /\s/.test(cliPath) ? JSON.stringify(cliPath) : cliPath;
  return `name = ${tomlString(archetype)}
description = ${tomlString(`Fadeno command broker ${archetype}: delegates command slots through the active loadout and stops when a host slot needs host materialization.`)}
model = ${tomlString(relay?.modelId ?? BUILTIN_CODEX_RELAY_MODEL)}
model_reasoning_effort = ${tomlString(relay?.effort ?? BUILTIN_CODEX_RELAY_EFFORT)}
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
  /** Files that were preserved because they are not Fadeno-managed. */
  conflicts: string[];
  scope: 'project' | 'user';
  /**
   * Fadeno-managed files removed: a slot that is no longer host-delivered,
   * a legacy per-dial agent, or a retired identity-grid cell. Never a file
   * without the managed marker.
   */
  removed?: string[];
  /**
   * Archetypes carrying a session dial or repo pin that a `--scope user`
   * apply deliberately did NOT read, because a global agent set may only be
   * cut from a global dial (see `dialLayersForApply`).
   *
   * Reported rather than dropped: a developer who just ran `fadeno dial
   * worker opus` in this repo and then applied at user scope would otherwise
   * watch the command succeed and change nothing, which is the same shape of
   * silent wrong answer this scoping rule exists to remove. Always empty at
   * project scope.
   */
  ignoredLocalDials?: string[];
}

/** The three Codex role slots that get a session-static agent file. */
const CODEX_STEERING_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

function codexAgentDir(scope: 'project' | 'user', repoRoot: string, userPathOptions?: UserPathOptions): string {
  if (scope === 'project') return join(repoRoot, '.codex', 'agents');
  // One definition of "$CODEX_HOME/agents", shared with status/doctor/uninstall.
  // It resolves an injected env hermetically (`options.env ?? process.env`)
  // rather than falling through to the process env key by key, so a test that
  // injects an environment without `CODEX_HOME` can no longer reach the
  // developer's real `~/.codex`.
  return codexUserAgentDir(userPathOptions);
}

/**
 * The header that makes a Codex agent file provably Fadeno's. Both scopes
 * carry it: it is the only thing that lets a later emit tell a file Fadeno
 * wrote from one a human did, and the only thing that lets `doctor` tell a
 * current project broker from a frozen legacy one.
 */
const CODEX_MANAGED_MARK = '# fadeno:managed';

/**
 * Prepend the managed header to a rendered agent body.
 *
 * The digest deliberately covers the body WITHOUT the header — a digest
 * cannot cover itself, and hashing the same bytes at both scopes means two
 * files rendered from the same resolution carry the same digest and can be
 * compared directly.
 */
function stampManagedAgent(body: string): string {
  return `${CODEX_MANAGED_MARK} version=${packageVersion()} digest=${sha256Hex(body)}\n${body}`;
}

/**
 * Write a managed Codex agent, refreshing what Fadeno wrote and preserving
 * what it did not.
 *
 * The marker governs overwriting: a file carrying it is Fadeno's to keep
 * current (that is the whole point — an agent file that can never be
 * refreshed is how a project broker came to predate `--prompt-file`), while a
 * file without it is content Fadeno never wrote and never takes.
 *
 * `force` is the one override, and it is scope-dependent on purpose:
 *
 *  - At USER scope the filename (`fadeno-<archetype>.toml`) is a name Fadeno
 *    owns by convention, so a foreign file there is a deliberate takeover and
 *    is preserved with or without `--force` — the same ownership stance
 *    `runSteeringApplyClaude` and `uninstall` take.
 *  - At PROJECT scope the filename (`<archetype>.toml`) is an ordinary name in
 *    the user's own repo, and `--force` there keeps `emitFile`'s exact
 *    semantics — the documented "re-scaffold over what is there" of
 *    `init`/`vendor`. Exempting these three paths from it would be its own
 *    surprise, and every other file those commands write still obeys it.
 */
function managedAgentEmit(path: string, body: string, force: boolean, scope: 'project' | 'user'): EmitResult['status'] {
  const existed = existsSync(path);
  if (existed && !(scope === 'project' && force)) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.startsWith(CODEX_MANAGED_MARK)) return 'skipped';
    if (existing === body) return 'skipped';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return existed ? 'overwritten' : 'created';
}

/**
 * The dial layers an apply at `scope` is allowed to read, and the repo-local
 * dials it had to ignore to stay honest.
 *
 * `steering resolve` reads all four layers, and should: it answers for the
 * repo it is standing in. An APPLY is different, because it writes a file
 * whose REACH is its scope. `--scope user` writes ONE agent set into
 * `$CODEX_HOME/agents` (or `~/.claude/agents`) that every repo on this
 * machine then steers by — so resolving it through a session dial or a repo
 * pin exports a decision made about one repo to every other repo, silently.
 *
 * That is not hypothetical. `fadeno dial worker sonnet` in the Fadeno repo
 * writes the SESSION layer (an unscoped set edits the highest EXISTING dial),
 * and a later `steering apply --codex --scope user` run from that same repo
 * rewrote the global worker agent as a command broker — whose only identity
 * is the relay, `luna@low`. Every other repo on the machine, including ones
 * whose user dial says `worker: luna`, then resolved `mode: host` into that
 * broker and did worker-grade work at the relay's effort. Nothing reported a
 * conflict, because from each repo's own point of view the resolution was
 * correct; the agent it resolved INTO had been cut from someone else's dial.
 *
 * This mirrors the rule `emitCodexSteeringBrokers` already states in the
 * other direction — scaffolding must not bake one machine's personal dial
 * into a shared, tracked surface. Same principle, both directions: a dial may
 * only be materialized into a surface whose reach it already has.
 *
 * Ignoring them silently would just move the wrong answer, so the ignored
 * archetypes come back with the layers and every caller surfaces them.
 */
function dialLayersForApply(
  scope: 'project' | 'user',
  repoRoot: string,
  profile: ExecutorProfile,
  userPathOptions: UserPathOptions | undefined,
): { layers: DialLayers; ignoredLocal: string[] } {
  const state = readLocalDialState(repoRoot);
  const userRaw = readUserDials(userPathOptions ?? {});
  const user: Record<string, DialRef> = {};
  for (const [k, v] of Object.entries(userRaw)) user[k] = v as DialRef;
  const repo = { ...profile.dials } as Record<string, DialRef>;
  if (scope !== 'user') {
    return { layers: { session: state.dials, repo, user }, ignoredLocal: [] };
  }
  const ignoredLocal: string[] = [];
  for (const archetype of [...Object.keys(state.dials), ...Object.keys(repo)]) {
    if (!ignoredLocal.includes(archetype)) ignoredLocal.push(archetype);
  }
  return { layers: { session: {}, repo: {}, user }, ignoredLocal };
}

/** Materialize every archetype's resolved dial into a session-static Codex role agent. */
export function runSteeringApply(opts: SteeringApplyOptions): SteeringApplyResult {
  const repoRoot = rootOf(opts);
  const { profile } = profileOf(repoRoot, opts.userPathOptions);
  // Read live dial layers (ignore loadout if present)
  const scope = opts.scope ?? 'project';
  let dialLayers: DialLayers;
  let ignoredLocalDials: string[];
  try {
    const scoped = dialLayersForApply(scope, repoRoot, profile, opts.userPathOptions);
    dialLayers = scoped.layers;
    ignoredLocalDials = scoped.ignoredLocal;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
  const baseline: Record<string, string> = {};
  const materialization: SteeringApplyResult['materialization'] = {};
  const pending: Array<{ path: string; body: string }> = [];
  const results: EmitResult[] = [];
  const agentDir = codexAgentDir(scope, repoRoot, opts.userPathOptions);
  const managedCli = userPaths(opts.userPathOptions).managedCli;
  const cliPath = opts.cliPath ?? (scope === 'user' && existsSync(managedCli) ? managedCli : 'fadeno');
  // One lookup for all three slots: the relay is a property of the catalog,
  // not of any archetype's dial.
  const relay = codexRelay(profile);
  for (const archetype of CODEX_STEERING_ARCHETYPES) {
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
      body = renderCodexCommandBroker(archetype, cliPath, relay);
    }
    // Both scopes now. A project broker without the header is indistinguishable
    // from a hand-authored file, which is exactly why the frozen `init` copies
    // could never be refreshed — and why `doctor` cannot tell a current project
    // broker from a legacy one without it.
    pending.push({ path, body: stampManagedAgent(body) });
  }
  for (const item of pending) {
    results.push({ path: item.path, status: managedAgentEmit(item.path, item.body, opts.force ?? false, scope) });
  }
  const conflicts = pending
    .filter((item) => !existsSync(item.path) || readFileSync(item.path, 'utf8') !== item.body)
    .map((item) => item.path);
  const restartRequired = results.some((item) => item.status === 'created' || item.status === 'overwritten');
  return { results, materialization, baseline, restartRequired, conflicts, scope, ignoredLocalDials };
}

export interface CodexBrokerEmitOptions extends CommonOptions {
  /** `init`/`vendor`'s "re-scaffold over what is there" — see `managedAgentEmit`. */
  force?: boolean;
  /** CLI the brokers invoke; bare `fadeno` is what a project scaffold gets. */
  cliPath?: string;
}

/**
 * Emit the three UNMATERIALIZED Codex brokers `init` scaffolds into
 * `<repoRoot>/.codex/agents/`, rendered here rather than copied from a frozen
 * template tree.
 *
 * These files used to be three static TOMLs under
 * `templates/codex/codex-steering-agents/`, copied byte-for-byte. That gave
 * the repo two mechanisms at two levels of currency: `steering apply`
 * re-rendered its agents from this file's templates on every dial switch,
 * while a scaffolded repo kept whatever text was frozen the day it ran `init`
 * — which is how a project broker came to predate `--prompt-file` and so
 * silently resolved without the digest that decides shadow pairing, excluding
 * that repo from pairs entirely. Emitting through the same renderer removes
 * the drift seam: a change to the broker's instructions reaches a scaffolded
 * repo and a dialed one identically.
 *
 * Deliberately NOT `runSteeringApply({ scope: 'project' })`, despite writing
 * the same three paths. That function resolves the live dial cascade, and at
 * scaffold time that is the wrong input twice over:
 *
 *  1. A fresh repo has no dials, so every slot lands on the host-native base
 *     `current-host` and materializes as a HOST agent carrying
 *     `model = "current-host"` — a string no Codex provider serves. The
 *     broker is the honest answer for a repo that has not dialed anything:
 *     it relays the resolver's instruction instead of claiming a host
 *     identity nobody has established.
 *  2. The cascade reads the invoking developer's user-scope dials, and
 *     `fadeno vendor` commits these files to the repo. Scaffolding must not
 *     bake one machine's personal dial into a shared, tracked surface.
 *
 * What IS resolved from the catalog is the relay identity — the only model
 * these files name — so `relay.codex` reaches them and a repo whose catalog
 * states no opinion keeps the built-in default.
 *
 * The files carry the same managed header `steering apply` stamps, so a later
 * `init` or `apply` can refresh what this wrote instead of being frozen out of
 * its own scaffolding, and `doctor` can tell a current project broker from a
 * legacy unmanaged one.
 */
export function emitCodexSteeringBrokers(opts: CodexBrokerEmitOptions): EmitResult[] {
  const repoRoot = rootOf(opts);
  // A catalog that cannot be loaded at all is the same practical answer as one
  // that states no relay opinion, and `init` is a scaffolding command: it
  // reports what it wrote rather than refusing to scaffold over a catalog
  // `doctor`/`validate` exist to diagnose.
  let relay: ResolvedRelay | null = null;
  try {
    relay = codexRelay(profileOf(repoRoot, opts.userPathOptions).profile);
  } catch {
    relay = null;
  }
  const agentDir = codexAgentDir('project', repoRoot, opts.userPathOptions);
  const cliPath = opts.cliPath ?? 'fadeno';
  return CODEX_STEERING_ARCHETYPES.map((archetype) => {
    const path = join(agentDir, `${archetype}.toml`);
    const body = stampManagedAgent(renderCodexCommandBroker(archetype, cliPath, relay));
    // Same ownership rule `steering apply` uses at this scope, so re-running
    // `init` after an upgrade refreshes the brokers it wrote instead of
    // leaving them frozen — and still never touches a file it did not write.
    return { path, status: managedAgentEmit(path, body, opts.force ?? false, 'project') };
  });
}

// --- Claude steering materialization ---

function claudeAgentDir(scope: 'project' | 'user', repoRoot: string, userPathOptions?: UserPathOptions): string {
  if (scope === 'project') return join(repoRoot, '.claude', 'agents');
  return join(userPathOptions?.home ?? homedir(), '.claude', 'agents');
}

const CLAUDE_MANAGED_MARK = '<!-- fadeno:managed';

/**
 * The marker `steering apply --claude` stamped into every identity-grid cell
 * it ever wrote: `<!-- fadeno:managed version=… digest=… source=grid:<archetype>@<effort> -->`.
 *
 * The grid is retired — effort decides the lane now — so this exists only to
 * RECOGNIZE the cells left on disk. It is the sole licence to delete one: a
 * file of the same name without it belongs to the user, and nothing here ever
 * touches it.
 */
const CLAUDE_GRID_CELL_RE = /<!-- fadeno:managed\b[^>]*\bsource=grid:[^\s>]+/;

/** Does this file carry the retired identity grid's marker? Content, never name. */
export function isRetiredClaudeGridCell(text: string): boolean {
  return CLAUDE_GRID_CELL_RE.test(text);
}

/**
 * Absolute paths of retired identity-grid cells in one `.claude/agents`
 * directory, sorted for a stable report.
 *
 * Shared with `doctor` (which reports them) and `uninstall` (which takes them
 * with it) so all three agree on exactly one definition of "a cell Fadeno
 * wrote". A missing or unreadable directory is not an error — there is simply
 * nothing to retire.
 */
export function listRetiredClaudeGridCells(agentDir: string): string[] {
  let entries: string[];
  try {
    entries = existsSync(agentDir) ? readdirSync(agentDir) : [];
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const path = join(agentDir, name);
    try {
      if (isRetiredClaudeGridCell(readFileSync(path, 'utf8'))) found.push(path);
    } catch {
      // Unreadable: not provably ours, so never claimed.
    }
  }
  return found.sort();
}

/** Delete a Fadeno-managed Claude agent file, recording it. Unmanaged files are untouched. */
function removeManagedClaudeAgent(path: string, removed: string[]): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  if (!text.includes(CLAUDE_MANAGED_MARK)) return;
  unlinkSync(path);
  removed.push(path);
}

/**
 * Report each Claude slot's resolved delivery, and REMOVE every managed agent
 * file earlier versions wrote. This apply no longer writes anything.
 *
 * The identity grid existed to let a host spawn run at an effort the session
 * was not running at, because the Agent tool has no effort parameter and the
 * harness registers definitions at session start. That goal is retired: a host
 * spawn now runs at the session's effort, and an effort the session cannot
 * give is delivered on the command lane instead (see `decideLane`). With
 * nothing left for a file to pin, the fifteen cells are dead weight that the
 * harness would still register at session start — so they go, alongside the
 * legacy per-dial agents (`.claude/agents/<archetype>.md`) they replaced,
 * which additionally pin a model the dial may have moved past.
 *
 * Ownership discipline is unchanged and load-bearing: only a file carrying the
 * `<!-- fadeno:managed …` marker is ever deleted. A hand-authored agent of the
 * same name is never touched, with or without `--force`.
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
  const scope = opts.scope ?? 'project';
  let dialLayers: DialLayers;
  let ignoredLocalDials: string[];
  try {
    const scoped = dialLayersForApply(scope, repoRoot, profile, opts.userPathOptions);
    dialLayers = scoped.layers;
    ignoredLocalDials = scoped.ignoredLocal;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
  const baseline: Record<string, string> = {};
  const materialization: SteeringApplyResult['materialization'] = {};
  const results: EmitResult[] = [];
  const removed: string[] = [];
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
    // Every slot reaches the same conclusion now — report the delivery, keep
    // no file — so the three branches differ only in what they report.
    if (spec.adapter !== 'host') {
      materialization[archetype] = {
        kind: 'command-broker', adapter: 'command', executor: executorName, model: (spec as { model: string | null }).model,
      };
    } else {
      // `current-host` and a dialed host identity alike: the plugin's native
      // role agents run on the session's own identity, and the hook supplies
      // the model per spawn. A managed per-dial file left here would pin
      // whatever model was dialed the day it was written.
      baseline[archetype] = executorName;
      materialization[archetype] = { kind: 'host', adapter: 'host', executor: executorName, model: spec.model };
    }
    removeManagedClaudeAgent(join(agentDir, `${archetype}.md`), removed);
  }

  // The retired identity grid. Found by marker rather than by name, so a cell
  // written for an archetype or an effort level this build no longer knows
  // about is still cleaned up — and a file without the marker never is.
  for (const cell of listRetiredClaudeGridCells(agentDir)) removeManagedClaudeAgent(cell, removed);

  // Nothing is written any more, so nothing can collide and nothing can be
  // preserved: `--force` has no work left to do here. Both stay in the result
  // shape because callers still read them.
  const conflicts: string[] = [];
  // Removing files needs no restart. The agents this apply deletes were
  // registered at session start and are simply no longer targeted; the plain
  // role agents that replace them are always registered. Restart reason 1 (a
  // new effort value entering the vocabulary) retired with the grid, and
  // neither surviving reason — a host slot with no delivery, a plugin upgrade
  // — is something this command can cause.
  const restartRequired = false;
  return { results, materialization, baseline, restartRequired, conflicts, scope, removed, ignoredLocalDials };
}

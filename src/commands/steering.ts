import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  BARE_IDENTIFIER_RE,
  activeHarness,
  ExecutorProfileError,
  resolveDelivery,
  commandRoutable,
  explainPairRoutability,
  pairRoutabilityFields,
  eligibilityFor,
  formatDialRef,
  hostCandidateOf,
  knownArchetypes,
  loadExecutorProfile,
  parseDialRef,
  parseSnapshotDocument,
  readLocalDialState,
  callerPromptDigest,
  resolveDialCascade,
  resolveRelay,
  shadowAttachmentExpired,
  shadowAttachmentRef,
  snapshotExecutor,
  shadowSampleRoll,
  type CompiledDelivery,
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
import { findRepoRoot, packageVersion, templatesDir } from '../lib/paths.ts';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { codexUserAgentDir, userPaths, type UserPathOptions } from '../lib/user-paths.ts';
import { ensureOpenCodeFadenoIgnore, ensureOmpFadenoIgnore } from '../lib/source-control.ts';
import { OMP_PROJECT_EXTENSION_ENTRY } from '../lib/omp-steering.ts';
import { stampHookVersion } from './plugin.ts';
import {
  CODEX_MANAGED_MARK,
  CODEX_STEERING_ARCHETYPES,
  codexManagedSettingsBlock,
  describeCodexAgentFileIdentity,
  effectiveCodexAgentCandidates,
  findSpawnableCodexAgent,
} from '../lib/codex-agent-file.ts';

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
  explainLane,
  hostFrameOf,
  readSessionEffort,
  type DeliveryLane,
  type HostFrame,
  type LaneDecision,
  type LaneInput,
  type LaneReason,
} from '../lib/lane.ts';
export { decideLane, explainLane, hostFrameOf, readSessionEffort };
export type { DeliveryLane, HostFrame, LaneDecision, LaneInput, LaneReason };

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
  /**
   * The EXECUTOR harness this resolution lands on (was `driver`). `host` on
   * the same payload is the ambient harness this call runs inside — the two
   * names moved together so no reader can be right about one and wrong about
   * the other.
   */
  harness: string | null;
  /** The command-lane variant policy chose, or null for the base lane. */
  variant?: string | null;
  /** The ambient host, `standalone` from a bare shell. */
  host?: string;
  source: RoleResolutionSource | 'host-request';
  dial: DialRef;
  hostExecutor: string | null;
  /**
   * WHO ASKED, and what the answer would be for a caller that holds the host
   * identity. Always present, so a machine reader never has to infer the frame
   * from the absence of `host_executor`.
   *
   * This exists because `lane` alone cannot be read as a property of the dial.
   * A `steering resolve` run from a shell names no host executor, so its
   * `lane` is `command` — correctly, for that caller — and a director who read
   * it as "this model has no host lane" routed a five-lane campaign out of
   * process and lost every report. `identity` says which question was actually
   * answered; `in_agent_lane` answers the other one.
   *
   * `in_agent_lane` is `decideLane` with the frame held and nothing else
   * changed (`explainLane`), so it cannot drift from `lane`: where the frame
   * is already held the two are the same object.
   */
  host_frame: {
    identity: HostFrame;
    /**
     * The lane a caller HOLDING this dial's host identity would get.
     *
     * `null` only on a locked engine request, whose lane the run snapshot
     * froze rather than the predicate deciding it — there is no counterfactual
     * to report, and inventing one would be a third answer.
     */
    in_agent_lane: DeliveryLane | null;
    in_agent_lane_reason: LaneReason | null;
  };
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
  /**
   * A native spawn that would deliver this request in-host, present only when
   * the CALLER could not prove a host identity of its own
   * (`host_frame.identity === 'unstated'`).
   *
   * Emitted on BOTH resolve paths since 2026-09-06. It was locked-request-only,
   * which meant the surface a director actually preflights — the ambient
   * `steering resolve --archetype worker` — answered `command` and
   * `delegate_to: null`, and the honest reading of that pair is "there is no
   * native delegate", which is how a campaign that had one went out of process
   * anyway. `host_frame.in_agent_lane` says the host lane exists; this field
   * names the agent file that takes it.
   *
   * Present ONLY when `agent_file` already carries exactly this identity. On
   * Codex a custom agent file's `model` / `model_reasoning_effort` take
   * precedence over the values passed at spawn time (see
   * `findSpawnableCodexAgent`), so the file is what delivers the requested
   * identity. Passing `model` and `reasoning_effort` at spawn is harmless and
   * overrides nothing. When the managed agent for this archetype is stale,
   * this field is absent and `detail` names it instead.
   */
  delegate_to?: {
    archetype: string;
    /** The resolved model, which this agent's file already carries. */
    model: string;
    /** The resolved effort, which this agent's file already carries. */
    reasoning_effort: string;
    executor: string;
    /** The managed agent file whose baked identity delivers this request. */
    agent_file: string;
    scope: 'project' | 'user';
  };
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
    n: number | null;
    remaining: number | null;
    expired: boolean;
    selected: boolean | null;
    routable: boolean;
    /** Why not, when `routable` is false; `null` when it is true. */
    routable_reason: string | null;
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
    // Resolver callers set FADENO_HARNESS so the HOST this delivery is
    // resolved against is the one they are actually running inside (the OMP
    // extension uses `omp`; ordinary Codex callers remain codex).
    return loadExecutorProfile(repoRoot, userPathOptions, activeHarness(undefined, userPathOptions));
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
            `deliver it on a command lane, or declare a fallback to ${[...HOST_SURFACE_SET].join(', ')}.`,
        );
      }
    } else {
      result.surface_archetype = surface;
    }
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
   * The CALLER's prompt digest (`callerPromptDigest` in `src/lib/executors.ts`)
   * — sha256 of the prompt bytes before any kernel decoration — or the file to
   * hash it from. `promptFile` is read and sha256'd here over exactly the bytes
   * the kernel pins as `callerPromptSha256`, because the agent is expected to
   * pass the very file it will later hand to `fadeno dispatch --prompt-file`
   * and the kernel captures that file's contents before prepending any brief
   * or appending the result footer. `promptSha256` is the pre-computed
   * alternative, and must be canonicalized the same way — trailing newlines
   * stripped, since a heredoc relay adds one and a prompt file usually carries
   * one. Ambient path only (see `shadow` below).
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
  const repoRoot = rootOf(opts);
  const run = opts.run?.trim() ?? '';
  const dispatchId = opts.dispatchId?.trim() ?? '';
  if (run === '' || dispatchId === '') {
    throw new SteeringError('locked steering resolution requires both --run and --dispatch-id.');
  }
  let lookup: HostDispatchRequestLookup;
  try {
    lookup = readHostDispatchRequest({ repoRoot, cwd: opts.cwd, run, dispatchId });
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
  // Specialization is a WILDCARD-only concern, and it asks whether the claimed
  // name is an archetype this profile knows — never whether the policy overlay
  // happens to carry an entry for it. Both halves of that were wrong here:
  //
  // The check ran on every request, so a CONCRETE `agent_type` was re-validated
  // after the equality check above had already settled it, against a map that
  // cannot answer the question. And `profile.archetypes` lists only archetypes
  // with non-default posture, so `reviewer` and `judge` — silent in the builtin
  // catalog precisely because they need nothing said — were refused as
  // "undeclared". A managed Codex reviewer agent that correctly consulted
  // steering was thrown to the command lane with `host_attested: false`
  // (2026-08-21, polymarket-quoter, hd-ac-review-g1-*-a1).
  //
  // Every fixture in the suite writes `archetypes: { worker: {}, reviewer: {},
  // judge: {} }` — enumerating the roster the way a test author would rather
  // than the way the catalog does — so the bug was unreachable from the tests.
  if (request.agentType === '*' && !knownArchetypes(profile.archetypes).has(archetype)) {
    throw new SteeringError(
      `host dispatch "${dispatchId}" cannot specialize wildcard identity to unknown archetype "${archetype}".`,
    );
  }
  // The archetype this locked request is being specialized TO, so a
  // policy-chosen variant's snapshot entry is the one checked.
  const executor = snapshotExecutor(profile, request.executor, archetype);
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
  const matchesHost = hostExecutor === request.executor;
  const hasFallback = executor.fallbackCommand != null;
  const neutral = isReferenceFrameNeutralHostRequest(request, executor);
  // Advisory, and only for a caller that could not prove a host identity of
  // its own. `hostExecutor == null` is what distinguishes an unidentified
  // caller from a materialized agent that asked and did not match.
  //
  // Gated on `hasFallback`, i.e. only where the resolution is `mode: command`.
  // A spawn would also help when there is NO fallback — that resolution is
  // `restart_required`, whose advice ("start a matching session") is needless
  // if the caller can just spawn one — but `cli.ts` exits 2 on that mode, so a
  // shell-driven coordinator would abort while being told to proceed. Advice
  // that contradicts the process's own exit status is worse than none. Making
  // it useful there means changing the mode vocabulary, which frozen brokers
  // (they STOP on `restart_required`) do not permit today.
  //
  // Never for the reference-frame-neutral sentinel: `current-host` is not a
  // model id, and `renderCodexHostAgent` writes no identity lines at all for
  // such a slot. Such a request is deliverable by whatever session is running
  // and needs no model-specific spawn to begin with.
  //
  // The agent named here must be one whose FILE already carries the locked
  // model and effort, because on Codex the file is what runs (see
  // `findSpawnableCodexAgent`). A managed agent for this role and executor
  // whose file says something else is named as stale in `detail` instead.
  //
  // The file's baked host executor is matched for a separate reason — it
  // controls what the agent's developer instructions pass back to this
  // resolver. A command broker passes none, and a role agent cut for a
  // different executor passes the wrong one; either would repeat this same
  // delegate advice instead of executing the assignment.
  //
  // The mode is deliberately NOT changed to `host` here. A command broker also
  // passes no `--host-executor` (`renderCodexCommandBroker`), is frozen on
  // disk, and STOPS on `mode: host` — so an unidentified caller must keep
  // seeing the mode it sees today, and the new capability rides on the
  // payload. Only a caller that can spawn acts on `delegate_to`.
  let delegateTo: SteeringResolution['delegate_to'];
  /** The role+executor agent that exists but cannot deliver: named, never offered. */
  let staleAgent: { path: string; identity: string } | null = null;
  if (
    !matchesHost && !neutral && hasFallback && hostExecutor == null
    && executor.adapter === 'host' && request.model !== NEUTRAL_HOST_EXECUTOR
  ) {
    const candidates = effectiveCodexAgentCandidates(repoRoot, opts.userPathOptions);
    const target = findSpawnableCodexAgent(candidates, archetype, request.executor, {
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    });
    if (target != null) {
      delegateTo = {
        archetype: target.state.name ?? target.archetype,
        model: request.model,
        reasoning_effort: request.reasoningEffort,
        executor: request.executor,
        agent_file: target.path,
        scope: target.scope,
      };
    } else {
      // The same search without the identity clause: a managed agent for this
      // role and executor that a caller can SEE on disk and would otherwise
      // reach for. The advisory has to explain why it is not being offered.
      const installed = findSpawnableCodexAgent(candidates, archetype, request.executor);
      if (installed != null) {
        staleAgent = { path: installed.path, identity: describeCodexAgentFileIdentity(installed.state) };
      }
    }
  }
  const detail = matchesHost
    ? `host request ${dispatchId} is locked to run-snapshotted executor ${request.executor}; execute in-host`
    : neutral
      ? `host request ${dispatchId} is locked to the reference-frame-neutral executor current-host; execute in-host`
      : hasFallback
        ? delegateTo != null
          ? `host request ${dispatchId} is locked to ${request.executor}; spawn the ${delegateTo.archetype} Codex agent (${delegateTo.agent_file}) and hand it this engine assignment envelope — its file carries exactly this identity, ${delegateTo.model} at effort ${delegateTo.reasoning_effort}, so it delivers the locked identity in-host rather than through the executor's command fallback`
          : staleAgent != null
            ? `host request ${dispatchId} is locked to ${request.executor}; the managed ${archetype} Codex agent (${staleAgent.path}) is stale: its file carries ${staleAgent.identity}, while this request is locked to ${request.model} at effort ${request.reasoningEffort}, and on Codex the file wins over any spawn value — run \`fadeno steering apply --codex\` and start a fresh Codex session to re-cut it, or deliver it now through that executor's declared command fallback`
            : `host request ${dispatchId} is locked to ${request.executor}; deliver it through that executor's declared command fallback`
        : `host request ${dispatchId} requires host executor ${request.executor}; this session is materialized for ${hostExecutor ?? 'no host executor'}, so start a matching Codex session`;
  // For locked, dial is the executor ref itself
  let dial: DialRef;
  try { dial = parseDialRef(request.executor, 'locked'); } catch { dial = { model: request.executor }; }
  const compiled = (() => { try { return resolveDelivery(dial, profile as unknown as ExecutorProfile); } catch { return null; } })();
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
    // Reported here too, so the field is on every resolution and a reader
    // never has to branch on the path to know whether it may trust `lane` as a
    // property of the dial. `in_agent_*` is null on purpose: the lane above
    // came from the snapshot, not from the predicate, so there is no
    // counterfactual to run and a fabricated one would be the third answer
    // this whole change exists to remove. `detail` and `delegate_to` already
    // carry the "a native agent could deliver this" story on this path.
    host_frame: {
      identity: hostFrameOf({ hostExecutor, executor: request.executor, neutralIdentity: neutral }),
      in_agent_lane: null,
      in_agent_lane_reason: null,
    },
    archetype,
    role,
    executor: request.executor,
    adapter: 'host',
    model: request.model,
    effort: request.reasoningEffort,
    harness: (executor as { harness?: string }).harness ?? compiled?.harness ?? null,
    variant: (executor as { variant?: string }).variant ?? compiled?.variant ?? null,
    source: 'host-request',
    dial,
    hostExecutor,
    detail,
    resolved_via: null,
    requested_agent_type: requestedAgentType,
    identity_evidence: 'requested_only',
    ...(deliveredArchetype != null ? { delivered_archetype: deliveredArchetype } : {}),
    ...(delegateTo != null ? { delegate_to: delegateTo } : {}),
  };
  // A wildcard request is already assigned to a concrete host agent. That
  // agent may claim the locked request as `director` (or another declared,
  // compatible archetype) without a separately materialized subagent surface.
  // Concrete requests still require the ordinary host-surface contract.
  return decorateSteering(base, profile, null, requestedAgentType === '*');
}

/**
 * The digest the shadow roll is keyed on — the CALLER's, always. `promptSha256`
 * wins if given; otherwise a `promptFile` is read and hashed here, over the
 * same utf8 bytes `runDispatch` pins as `callerPromptSha256` for a dispatch of
 * that same file — so a Codex agent that resolves and then dispatches the same
 * path gets one digest, not two. That agreement is what this used to only
 * claim: the kernel hashed its prompt AFTER composing the archetype brief and
 * the result footer, so a brief-carrying archetype rolled a different number
 * here than it did there. An unreadable file answers "no digest" rather than
 * throwing: a caller that cannot supply the prompt yet must not be refused
 * resolution, only left with `shadow.selected: null`.
 *
 * The file is hashed through `callerPromptDigest`, not raw sha256, so the two
 * spellings of the same prompt agree as well: a prompt FILE almost always ends
 * in a newline and an inline `--prompt-sha256` computed from a spawn's own
 * prompt string almost never does, and the trailing newline is not part of a
 * prompt's identity.
 */
function resolvePromptDigest(opts: SteeringResolveOptions): string | null {
  const direct = opts.promptSha256?.trim();
  if (direct) return direct;
  const file = opts.promptFile?.trim();
  if (!file) return null;
  try {
    const text = readFileSync(resolve(opts.cwd ?? process.cwd(), file), 'utf8');
    return callerPromptDigest(text);
  } catch {
    return null;
  }
}

/**
 * `hostEffortProven`'s EFFORT half: does the managed agent file Codex would
 * load for `archetype` bake `effort`, and was it cut from `ref`?
 *
 * The only thing that fixes a Codex subagent's reasoning effort is the
 * `model_reasoning_effort` key in its agent file, because on Codex the file
 * takes precedence over anything passed at spawn time — see
 * `findSpawnableCodexAgent` for the rule and its receipt. So a caller's
 * `--host-executor luna@xhigh` ref identifies WHICH agent is asking; the file
 * it was cut from is what proves the pin. A file that states no effort
 * inherits the session's, which is exactly the `current-host` shape:
 * `renderCodexHostAgent` omits both identity lines for the neutral sentinel,
 * so such an agent bakes and passes back a pinned ref while pinning nothing.
 *
 * Three requirements — the same three `findSpawnableCodexAgent` applies to
 * the file it offers, besides the model. The MODEL half is not this
 * predicate's: `hostModel` decides
 * whether the session can host it at all, and the spawn guard adjudicates a
 * file whose model has drifted at the moment it is authoritative.
 *
 * A missing, unmarked, or silent file answers "no", which sends the delivery
 * to the command lane, where the effort is encoded in the argv and therefore
 * guaranteed. That is the safe direction and matches `decideLane`'s stated
 * posture: degrade safely rather than hopefully.
 */
function codexAgentFilePinsEffort(
  repoRoot: string,
  archetype: string,
  ref: string,
  effort: string,
  userPathOptions?: UserPathOptions,
): boolean {
  const candidate = effectiveCodexAgentCandidates(repoRoot, userPathOptions)
    .find((entry) => entry.archetype === archetype);
  return candidate != null &&
    candidate.state.managed &&
    candidate.state.hostExecutor === ref &&
    candidate.state.reasoningEffort === effort;
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
      try { hostSpec = resolveDelivery(parsed, profile, undefined, { archetype }).spec; } catch {}
    }
    // `snapshotExecutor`, so a run whose snapshot froze an archetype-specific
    // answer for this ref is read the way it was written; it falls back to the
    // plain ref itself, which is why no second lookup follows it.
    if (hostSpec == null) hostSpec = snapshotExecutor(profile, hostExecutor, archetype) ?? null;
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
  let spec: ExecutorSpec | null = snapshotExecutor(profile, refString, archetype) ?? null;
  let compiled: CompiledDelivery | null = null;
  try { compiled = resolveDelivery(cascade.ref, profile, undefined, { archetype }); } catch {}
  if (spec == null && compiled != null) spec = compiled.spec;
  if (spec == null) throw new SteeringError(`resolved dial "${refString}" has no compiled executor in profile`);
  // Bind neutral host agentType
  if (spec.adapter === 'host' && (spec as any).agentType === '*' && archetype != null) spec = { ...spec, agentType: archetype } as ExecutorSpec;
  // Write-posture delivery selection, same rule as dispatch/drive.

  // The pair decision — computed identically to `runDialResolve`'s `shadow`
  // field (same attachment lookup, same challenger string, same roll) so a
  // Codex and a Claude resolve for the same prompt cannot disagree. Surfaced
  // on every mode, not only `host`: a caller wants to see the attachment
  // regardless of what this resolution turns out to be, even though only the
  // `host` branch below acts on it.
  const attachment = shadows[archetype];
  let shadow: SteeringResolution['shadow'];
  if (attachment != null) {
    const challenger = formatDialRef(shadowAttachmentRef(attachment));
    const digest = resolvePromptDigest(opts);
    const rate = attachment.rate ?? null;
    const expired = shadowAttachmentExpired(attachment);
    shadow = {
      attached: true,
      challenger,
      rate,
      n: attachment.n ?? null,
      remaining: attachment.remaining ?? null,
      expired,
      // No rate means every dispatch fires; no digest means the caller cannot
      // be told, and must not read the silence as a "no".
      selected: expired ? false : rate == null ? true : digest ? shadowSampleRoll(digest, archetype, challenger) < rate : null,
      // The PRIMARY's own resolved spec, after write-posture — what a
      // selected pair would have to reuse to reach the command lane.
      ...pairRoutabilityFields(explainPairRoutability(spec, refString)),
    };
  }

  // --- The lane: model, FRAME, and effort ---
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
    // effort at all and that `resolveDelivery` could not compile.
    'default';
  // `hostCandidateOf`, not `spec.adapter`: a host spec is also how a delivery
  // with no argv is represented, and the two disagree exactly there. This is
  // the CATALOG fact only — until 2026-09-06 the caller-identity clause was
  // `&&`-ed on here, which is what made a shell preflight report every
  // host-deliverable model as `model not deliverable in-host`.
  const hostModel = hostCandidateOf(compiled, spec);
  /** The reference-frame-neutral sentinel, whose agent file states no identity at all. */
  const neutralModel = spec.adapter === 'host' && spec.model === NEUTRAL_HOST_EXECUTOR;
  // WHO ASKED. Same three-way answer `fadeno dispatch` gets, from the same
  // function.
  //
  // `neutralIdentity` is the sentinel MODEL, not the layer the dial came from.
  // This clause used to read `cascade.source === 'base'` alone, which is the
  // same disease one level down: it is a proxy for "the dial is
  // `current-host`" that happens to hold for the fall-through base ref and is
  // strictly narrower than the thing it stands for. An explicit `fadeno dial
  // judge current-host` means exactly what the base ref means — "whatever
  // session is running" — but arrives on the `user` layer, so a preflight for
  // it answered `restart_required` (which `cli.ts` exits 2 on) and advised
  // "apply the dial and start a fresh session" for a dial no session can fail
  // to satisfy. The layer a dial was written on cannot change what
  // `current-host` names. `isReferenceFrameNeutralHostRequest` on the locked
  // path has always keyed on the identity for this reason.
  //
  // The `base` disjunct is kept: it is the one shape that survives a profile
  // too old for `resolveDelivery` to compile, where `spec` may not carry the
  // sentinel at all.
  const frame = hostFrameOf({
    hostExecutor,
    executor: refString,
    neutralIdentity: cascade.source === 'base' || neutralModel,
  });
  // The agent FILE's own pin, read once and used twice: as proof for THIS
  // caller only when it is that agent (`hostExecutor === refString` —
  // unchanged), and as proof for the counterfactual regardless of who asked.
  // A preflight must not answer "session effort unobserved" about an effort
  // baked into a file sitting in `~/.codex/agents/`.
  const agentFilePinsEffort =
    pinnedEffort != null &&
    codexAgentFilePinsEffort(repoRoot, archetype, refString, pinnedEffort, opts.userPathOptions);
  const explained = explainLane({
    pinnedEffort,
    effectiveEffort,
    sessionEffort: readSessionEffort(opts.env ?? process.env),
    hostModel,
    frame,
    // `refString` carries the pin (`formatDialRef` renders `luna@xhigh`), so a
    // host executor that matches it identifies WHICH agent is asking. The
    // proof is its file — see `codexAgentFilePinsEffort`.
    hostEffortProven: hostExecutor === refString && agentFilePinsEffort,
    inAgentEffortProven: agentFilePinsEffort,
    commandLane: commandRoutable(spec),
  });
  const lane = explained.decision;
  /**
   * What a caller holding this dial's host identity gets — the SAME predicate,
   * one call, so the answer this resolution hands a preflight cannot disagree
   * with the answer `fadeno dispatch`'s host-lane note gives for the same dial.
   */
  const hostFrame: SteeringResolution['host_frame'] = {
    identity: frame,
    in_agent_lane: explained.inAgent.lane,
    in_agent_lane_reason: explained.inAgent.lane_reason,
  };

  // --- The delegate an unidentified caller could spawn ---
  //
  // Same search, same gating rules and the same reason as the locked path
  // above, on the surface a coordinator actually preflights. The locked path
  // has had this since 2026-08-20; the ambient one answered `delegate_to: null`
  // to every question, and "command lane, no delegate" is exactly the pair a
  // director reads as "there is no native option here".
  //
  // Gated on `frame === 'unstated'`: a caller that named a host executor is a
  // managed agent and is being told about ITSELF, and one whose ref matches
  // needs no delegate at all. Gated on the counterfactual being `host`, so this
  // never advertises a spawn that would land right back on the command lane.
  // Gated on `lane.lane === 'command'` for the reason the locked path records:
  // `cli.ts` exits 2 on `restart_required`, and advice that contradicts the
  // process's own exit status is worse than none.
  //
  // The identity clause is what makes it safe to act on. On Codex the agent
  // file's `model` / `model_reasoning_effort` beat any spawn value, so only a
  // file already carrying this dial's identity delivers this dial; anything
  // else is named as stale in `detail` instead. `findSpawnableCodexAgent` also
  // matches the file's baked `--host-executor`, which is what keeps a COMMAND
  // BROKER — a managed file that bakes no host executor at all — from ever
  // being offered here. That case is genuinely command-lane and must stay so.
  let delegateTo: SteeringResolution['delegate_to'];
  let staleDelegate: { path: string; identity: string } | null = null;
  if (
    frame === 'unstated' && explained.inAgent.lane === 'host' && lane.lane === 'command'
    && spec.adapter === 'host' && !neutralModel && (spec as any).model != null
  ) {
    const candidates = effectiveCodexAgentCandidates(repoRoot, opts.userPathOptions);
    const identity = {
      model: (spec as any).model as string,
      reasoningEffort: (spec as any).reasoningEffort as string,
    };
    const target = findSpawnableCodexAgent(candidates, archetype, refString, identity);
    if (target != null) {
      delegateTo = {
        archetype: target.state.name ?? target.archetype,
        model: identity.model,
        reasoning_effort: identity.reasoningEffort,
        executor: refString,
        agent_file: target.path,
        scope: target.scope,
      };
    } else {
      const installed = findSpawnableCodexAgent(candidates, archetype, refString);
      if (installed != null) {
        staleDelegate = { path: installed.path, identity: describeCodexAgentFileIdentity(installed.state) };
      }
    }
  }

  // Every branch below funnels through `finish`, so attaching `shadow` and the
  // lane fields here once — rather than at each call site — is what keeps them
  // uniformly visible regardless of which mode this resolution lands on. Base
  // wins on conflict, so a branch that genuinely overrides the lane (the
  // shadow pair) says so in its own literal.
  const finish = (
    base: Omit<SteeringResolution, 'resolved_via' | 'surface_archetype' | 'advisory' | 'host_frame' | keyof LaneDecision>
      & Partial<LaneDecision>,
  ): SteeringResolution =>
    decorateSteering(
      { ...lane, host_frame: hostFrame, ...(shadow != null ? { shadow } : {}), ...base } as any,
      profile,
      cascade.resolvedVia,
    );


  if (spec.adapter === 'command') {
    return finish({
      mode: 'command', archetype, role,
      executor: refString, adapter: 'command', model: (spec as any).model ?? compiled?.model ?? null,
      effort: compiled?.effectiveEffort ?? null,
      harness: (spec as { harness?: string }).harness ?? compiled?.harness ?? null,
      variant: (spec as { variant?: string }).variant ?? compiled?.variant ?? null,
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
    // with no `fallback_command`, or whose command lane cannot satisfy the
    // archetype's write posture, has no command lane a pair could actually
    // use, and routing it here anyway would only hand the agent a `fadeno
    // dispatch` that the kernel's own refusal would then reject.
    if (shadow?.selected === true && shadow.routable === true) {
      return finish({
        mode: 'command', archetype, role,
        // The pair overrides the lane the effort/model predicate chose, so it
        // says so rather than letting `lane: 'host'` contradict `mode`. The
        // contract guarantee still holds: this branch is gated on
        // `shadow.routable`, which is `explainPairRoutability(...).routable`.
        lane: 'command',
        lane_reason: 'shadow pair forces the command lane',
        executor: refString, adapter: 'host', model: (spec as any).model,
        effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
        harness: (spec as { harness?: string }).harness ?? compiled?.harness ?? null,
        variant: (spec as { variant?: string }).variant ?? compiled?.variant ?? null,
        source: cascade.source, dial: cascade.ref, hostExecutor,
        detail: `pair selected: ${archetype} → ${refString} moved to its command lane so both arms are comparable${detailNote}`,
      } as any);
    }
    return finish({
      mode: 'host', archetype, role,
      executor: refString, adapter: 'host', model: (spec as any).model,
      effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
      harness: (spec as { harness?: string }).harness ?? compiled?.harness ?? null,
      variant: (spec as { variant?: string }).variant ?? compiled?.variant ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      detail: `host executor ${refString} matches this session's host baseline${detailNote}`,
    } as any);
  }
  if (lane.lane === 'command') {
    return finish({
      mode: 'command', archetype, role,
      executor: refString, adapter: 'host', model: (spec as any).model,
      effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
      harness: (spec as { harness?: string }).harness ?? compiled?.harness ?? null,
      variant: (spec as { variant?: string }).variant ?? compiled?.variant ?? null,
      source: cascade.source, dial: cascade.ref, hostExecutor,
      ...(delegateTo != null ? { delegate_to: delegateTo } : {}),
      // FOUR ways to be here, and the agent is told which. The first three are
      // the three halves of the predicate — catalog, frame, effort — and the
      // frame half used to be reported as the catalog half, in the sentence
      // `... differs from this session's host baseline (none)`, which reads as
      // a fact about the dial and is a fact about the asker. That sentence is
      // why a director concluded there was no native delegate and moved a
      // whole campaign out of process.
      detail:
        !hostModel
          ? `host executor ${refString} resolves onto harness ${(spec as { harness?: string }).harness ?? compiled?.harness ?? 'unknown'}, ` +
            `which is not this session's host, so there is no host lane for it here; use its declared command fallback immediately${detailNote}`
          : frame === 'unstated'
            ? `this resolve named no --host-executor, so it answers for a caller that is not a managed ${archetype} agent; ` +
              `${refString} IS host-deliverable here and a managed ${archetype} agent cut for it resolves to the HOST lane ` +
              `(${explained.inAgent.lane_reason}). ` +
              (delegateTo != null
                ? `Spawn the ${delegateTo.archetype} agent (${delegateTo.agent_file}) and hand it this assignment — its file carries exactly this identity, ${delegateTo.model} at effort ${delegateTo.reasoning_effort}, so it delivers in-host. `
                : staleDelegate != null
                  ? `The managed ${archetype} agent (${staleDelegate.path}) is stale: its file carries ${staleDelegate.identity}, and on Codex the file wins over any spawn value — run \`fadeno steering apply --codex\` and start a fresh session to re-cut it. `
                  : `No managed ${archetype} agent carries this identity, so there is nothing to spawn. `) +
              `Otherwise use its declared command fallback${detailNote}`
            : frame === 'mismatched'
              ? `host executor ${refString} differs from the executor this agent was materialized for, ${hostExecutor}; ` +
                `use its declared command fallback immediately${detailNote}`
              : `host executor ${refString} matches this session's host baseline, but ${lane.lane_reason}; use its declared command fallback immediately${detailNote}`,
    } as any);
  }
  return finish({
    mode: 'restart_required', archetype, role,
    executor: refString, adapter: 'host', model: (spec as any).model,
    effort: (spec as any).reasoningEffort ?? compiled?.effectiveEffort ?? null,
    harness: (spec as { harness?: string }).harness ?? compiled?.harness ?? null,
    variant: (spec as { variant?: string }).variant ?? compiled?.variant ?? null,
    source: cascade.source, dial: cascade.ref, hostExecutor,
    // Restart reason 2 of the two that survive: a host slot naming an
    // identity with neither a session that can deliver it nor a command
    // fallback. It now has FOUR shapes — the model, as always; who asked,
    // which used to be reported as the model; an effort the session is running
    // at something else; and an effort nothing here can ever prove, which
    // needs its own remediation because the ordinary one ("start a session at
    // <effort>") is unsatisfiable in that shape.
    detail: !hostModel
      ? `dial ${refString} requests host executor ${refString}, but its harness is not this session's host and ${refString} declares no command fallback; apply the dial and start a fresh session${detailNote}`
      : frame === 'unstated'
        ? `dial ${refString} IS host-deliverable here, but this resolve named no --host-executor, so it answers for a caller that is not a ` +
          `managed ${archetype} agent — and ${refString} declares no command fallback. A managed ${archetype} agent cut for ${refString} ` +
          `resolves to lane ${explained.inAgent.lane} (${explained.inAgent.lane_reason}); spawn one, or apply the dial and start a fresh session${detailNote}`
        : frame === 'mismatched'
          ? `dial ${refString} requests host executor ${refString}, but this agent was materialized for ${hostExecutor}, and ${refString} declares no command fallback; apply the dial and start a fresh session${detailNote}`
          // A pinned `current-host` on a harness that publishes no session
          // effort. `renderCodexHostAgent` omits `model_reasoning_effort` for
          // the neutral sentinel by construction, so no agent file can ever
          // carry this pin and no session can be started that would observe
          // it: both proofs are closed off permanently, and only changing the
          // dial reopens one.
          : neutralModel && lane.session_effort == null
            ? `dial ${refString} pins effort ${pinnedEffort}, but a ${NEUTRAL_HOST_EXECUTOR} agent file carries no model_reasoning_effort by construction ` +
              `and this session publishes no effort to observe, so nothing can prove the pin — and ${refString} declares no command fallback; ` +
              `drop the pin (dial ${NEUTRAL_HOST_EXECUTOR}) or dial a concrete model, whose agent file can bake the effort${detailNote}`
            : `dial ${refString} pins effort ${pinnedEffort} but this session runs at ${lane.session_effort ?? 'no observable effort'}, ` +
              `and ${refString} declares no command fallback; start a session at ${pinnedEffort}, drop the pin, or declare one${detailNote}`,
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
  // A `current-host` slot names no provider-servable model: Codex rejects the
  // literal with a 400 ("The 'current-host' model is not supported when using
  // Codex with a ChatGPT account", observed 2026-08-26), and the sentinel
  // means "inherit the session" anyway — the same rule renderOpenCodeRoleSlot
  // applies. Omit both identity lines rather than writing an unusable string.
  const neutralHost = spec.model === NEUTRAL_HOST_EXECUTOR;
  const identity =
    neutralHost
      ? ''
      : `model = ${tomlString(spec.model)}\nmodel_reasoning_effort = ${tomlString(spec.reasoningEffort)}\n`;
  // Rendered from `CODEX_MANAGED_SETTINGS` rather than spelled here, so the
  // list `readCodexAgentFile` judges an existing file against is the same list
  // that writes a new one. Spelling them inline is what let 3c785e0 change the
  // permissions a lane runs under while every surface kept calling the files it
  // no longer produces `current`.
  return `name = ${tomlString(archetype)}
description = ${tomlString(`Fadeno hybrid ${archetype}: host-delivered on the session baseline, command-dispatched when the active loadout switches providers.`)}
${identity}${codexManagedSettingsBlock()}
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
 * Codex — a self-contained project catalog with no `relay:` key, or a
 * `relay.codex` this build cannot compile.
 *
 * Deliberately kept EQUAL to the shipped catalog's `relay.codex`. These
 * started life as the literals every broker carried before `relay:` became a
 * catalog key, and the migration argument for freezing them ("a repo whose
 * catalog says nothing sees no diff") expired once that migration was done.
 * What is left is one question — what should relay a Codex delivery — and two
 * places that answer it, which is the drift shape this codebase keeps getting
 * bitten by. So the effort moved with the catalog (low → high, 2026-08-20);
 * the rationale is recorded once, beside the catalog value.
 *
 * The MODEL still does not move on judgment alone: a relay the session's
 * provider cannot serve is worse than a stale-but-servable one, which is why
 * `resolveRelay` returns null rather than guessing, and why changing who
 * relays still wants a dogfood receipt.
 */
const BUILTIN_CODEX_RELAY_MODEL = 'gpt-5.6-luna';
const BUILTIN_CODEX_RELAY_EFFORT = 'high';

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
${codexManagedSettingsBlock()}
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
  // This command materializes Codex agents even when invoked from another
  // harness (or a standalone test environment), so its route family must not
  // follow FADENO_HARNESS. Runtime resolution still uses profileOf above.
  const { profile } = (() => {
    try {
      return loadExecutorProfile(repoRoot, opts.userPathOptions, 'codex');
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
      throw err;
    }
  })();
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
    let spec: ExecutorSpec | null = snapshotExecutor(profile, executorName, archetype) ?? null;
    // Resolved with the ARCHETYPE, so a policy-chosen variant and the host
    // lane's own eligibility both reach this decision.
    let compiled: CompiledDelivery | null = null;
    try {
      compiled = resolveDelivery(cascade.ref, profile as unknown as ExecutorProfile, undefined, { archetype });
      if (spec == null) spec = compiled.spec;
    } catch {}
    if (spec == null) {
      throw new SteeringError(`archetype "${archetype}" resolved to "${executorName}" but no executor exists in profile`);
    }
    // Whether this slot can be delivered IN-SESSION. `spec.adapter` alone said
    // yes for `opus on omp` under a Codex host — a host-only harness nobody is
    // sitting in — and materialized a Codex host agent for it.
    const hostSlot = hostCandidateOf(compiled, spec);
    // bind neutral host agentType
    if (hostSlot && spec.adapter === 'host' && (spec as any).agentType === '*' ) spec = { ...spec, agentType: archetype } as ExecutorSpec;
    // Write-posture delivery selection, same rule as dispatch/drive.
      const filename = scope === 'user' ? `fadeno-${archetype}.toml` : `${archetype}.toml`;
    const path = join(agentDir, filename);
    let body: string;
    // `spec.adapter === 'host'` is implied by `hostSlot` — `resolveDelivery`
    // only sets `hostCandidate` on a host spec — and is written out so the
    // narrowing is the compiler's rather than a comment's.
    if (hostSlot && spec.adapter === 'host') {
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
    let spec: ExecutorSpec | null = snapshotExecutor(profile, executorName, archetype) ?? null;
    let compiled: CompiledDelivery | null = null;
    try {
      compiled = resolveDelivery(cascade.ref, profile as unknown as ExecutorProfile, undefined, { archetype });
      if (spec == null) spec = compiled.spec;
    } catch {}
    if (spec == null) {
      throw new SteeringError(`archetype "${archetype}" resolved to "${executorName}" but no executor exists in profile`);
    }
    const hostSlot = hostCandidateOf(compiled, spec);
    if (hostSlot && spec.adapter === 'host' && (spec as { agentType?: string }).agentType === '*') spec = { ...spec, agentType: archetype } as ExecutorSpec;
      // Every slot reaches the same conclusion now — report the delivery, keep
    // no file — so the three branches differ only in what they report.
    if (!hostSlot) {
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

// --- OpenCode steering materialization ---

/**
 * The managed-file mark stamped into every OpenCode agent file this module
 * writes. The runtime plugin (`.opencode/plugin/fadeno-steering.js`) refuses
 * to rewrite a spawn onto a role slot that does not carry it, so an unmarked
 * `.opencode/agent/<archetype>.md` is the user's own file: Fadeno neither
 * claims it nor steers onto it. Same ownership rule as the Codex
 * `CODEX_MANAGED_MARK`, in the syntax an agent file can carry — the mark sits
 * below the frontmatter, which must stay first.
 */
const OPENCODE_MANAGED_MARK = '<!-- fadeno:managed';

/** Same ownership mark for the emitted plugin file, in JS-comment syntax. */
const OPENCODE_PLUGIN_MANAGED_MARK = '// fadeno:managed';

/**
 * Insert the managed header into a rendered OpenCode agent body BELOW the
 * frontmatter, which YAML frontmatter parsing requires to stay first (an
 * agent file that opens with an HTML comment would not parse as one). The
 * digest covers the body WITHOUT the header, so two files rendered from one
 * resolution compare equal.
 */
function stampManagedOpenCodeAgent(body: string): string {
  const header = `${OPENCODE_MANAGED_MARK} version=${packageVersion()} digest=${sha256Hex(body)} -->`;
  if (body.startsWith('---\n')) {
    const close = body.indexOf('\n---\n');
    if (close >= 0) {
      const after = close + '\n---\n'.length;
      return `${body.slice(0, after)}${header}\n${body.slice(after)}`;
    }
  }
  return `${header}\n${body}`;
}

/**
 * Write a Fadeno-managed OpenCode file, refreshing what Fadeno wrote and
 * preserving what it did not. Same ownership rule as `managedAgentEmit` but
 * keyed on CONTAINS rather than startsWith: agent files must open with their
 * frontmatter, so the mark cannot be the first bytes of the file.
 */
function openCodeManagedEmit(path: string, body: string, force: boolean): EmitResult['status'] {
  const existed = existsSync(path);
  if (existed && !force) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.includes(OPENCODE_MANAGED_MARK)) return 'skipped';
    if (existing === body) return 'skipped';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return existed ? 'overwritten' : 'created';
}

/** Delete a Fadeno-managed OpenCode file, recording it. Unmanaged files are untouched. */
function removeManagedOpenCodeFile(path: string, removed: string[]): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  if (!text.includes(OPENCODE_MANAGED_MARK)) return;
  unlinkSync(path);
  removed.push(path);
}

interface OpenCodeTemplatePiece {
  description: string;
  body: string;
}

/** Split today's static role-agent template into description + body. */
function readOpenCodeRoleTemplate(archetype: string): OpenCodeTemplatePiece {
  const source = readFileSync(
    join(templatesDir(), 'opencode', 'opencode-agents', `${archetype}.md`),
    'utf8',
  );
  let rest = source;
  if (rest.startsWith('---\n')) {
    const end = rest.indexOf('\n---\n', 4);
    if (end >= 0) rest = rest.slice(end + '\n---\n'.length);
  }
  const described = /^description:\s*(.+)$/m.exec(source);
  return {
    description: described?.[1]?.trim() ?? `Fadeno ${archetype} role.`,
    body: rest.trimStart(),
  };
}

/**
 * A host-routed dialed slot: today's static role body with the dial's identity
 * in the frontmatter. `model` uses the provider-namespaced id the opencode
 * harness compiles (`spellings.opencode`); `variant` carries a PINNED effort —
 * OpenCode variants are named request overlays whose valid values are
 * model-specific, so a registry default effort is never asserted as one. A
 * `current-host` slot states neither: it inherits the session, which is what
 * current-host means.
 */
function renderOpenCodeRoleSlot(archetype: string, modelId: string | null, pinnedEffort: string | null): string {
  const piece = readOpenCodeRoleTemplate(archetype);
  const refresh =
    ' Fadeno-steered slot; re-run `fadeno steering apply --opencode` after re-dialing.';
  const lines = ['---', `description: ${piece.description}${refresh}`, 'mode: subagent'];
  if (modelId != null && modelId !== NEUTRAL_HOST_EXECUTOR) lines.push(`model: ${modelId}`);
  if (pinnedEffort != null && modelId != null && modelId !== NEUTRAL_HOST_EXECUTOR) {
    lines.push(`variant: ${pinnedEffort}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${piece.body}\n`;
}

/**
 * The command-lane relay broker: ONE Bash call piping the prompt verbatim via
 * quoted heredoc to `fadeno dispatch`, then verbatim relay of report + verdict.
 * Compressed from templates/claude/claude-agents/dispatch-worker.md — same
 * contract, no Claude-specific guard or plugin-root retry. No model pin: the
 * catalog names no opencode relay today, so the broker inherits the session's
 * model rather than inventing one.
 */
function renderOpenCodeDispatchBroker(archetype: string): string {
  const piece = readOpenCodeRoleTemplate(archetype);
  return `---
description: Fadeno command broker for the ${archetype} archetype — relays the received task verbatim to the external executor bound by Fadeno dials. Never performs the task itself.
mode: subagent
---

You are a **dispatch relay**, not an implementer. You do no thinking about the
task itself and you never attempt it: your only job is to hand the task,
byte-for-byte, to the external executor the user bound to the \`${archetype}\`
archetype via Fadeno dials, then relay its report.

Your FIRST and only required tool call is the contract call below — make it
ONE Bash call with the Bash \`timeout\` parameter set to \`600000\` (external
executors routinely exceed the default, and a timeout kill destroys their work):

\`\`\`bash
fadeno dispatch --archetype ${archetype} --tag ${archetype}-<slug> <<'FADENO_PROMPT'
...the ENTIRE task prompt you received, exactly as received — verbatim, every
line, starting at its very first line; headers, markers, and metadata included;
no paraphrase, no truncation, nothing added...
FADENO_PROMPT
\`\`\`

Replace \`<slug>\` with 2-4 hyphenated words naming THIS task
(\`${archetype}-parse-retry-header\`). Choose it BEFORE the call: the tag is the
only handle that survives the Bash call being killed, and it makes recovery
after a kill possible at all. The quoted heredoc keeps the shell from expanding
anything inside the prompt; the kernel snapshots the prompt and writes the
evidence rows itself.

Then:

1. Relay the command's stdout report **verbatim** as your final response — no
   summarizing, trimming, reformatting, or annotating. Relay the verdict line
   the command prints on stderr with it (\`ok\`, \`FAILED\`, \`NO OUTPUT\`,
   \`TIMED OUT\`, plus any merge-back line). \`output attested\` is NOT a
   verdict. You may prefix one structural sentence stating these are the
   executor's own claims, which you have no tools to verify.

2. If the command exits non-zero, report its output verbatim and state plainly
   that the dispatch failed. Do NOT attempt the task yourself as a fallback.

3. If the call is killed or times out, the result is UNKNOWN, not failed.
   Recover with the tag you launched with:

   \`\`\`bash
   fadeno dispatches --output tag:${archetype}-<slug> --wait 120
   \`\`\`

   The kernel writes the completion row only when the executor exits, so a
   caller that just timed out must wait like this before concluding anything.
   If the wait returns a completed dispatch, that IS the result: relay its
   output and verdict per rule 1. Only if the wait expires with still no
   completion row, report that the executor MAY STILL BE RUNNING and must be
   checked on disk before anyone re-dispatches — two workers racing on the same
   files is the failure this avoids. An empty recovered output is not a result:
   say it produced nothing.

4. If the task changes after you dispatched, do NOT re-dispatch and do not fold
   the amendment into a new call. Report the discrepancy; amending a live
   dispatch is the caller's decision.

Permission boundary: the external executor runs outside this harness's fences,
under flags the user configured via Fadeno dials; the dispatch evidence row is
the audit trail. Original role description: ${piece.description}
`;
}

/**
 * The refusal reporter: reports an embedded refusal reason verbatim and stops.
 * The plugin embeds the reason by PREPENDING the refusal envelope to the task
 * prompt, so this file is static across refusals.
 */
function renderOpenCodeRefusalBroker(archetype: string): string {
  return `---
description: Reports why the Fadeno steering layer refused a ${archetype} spawn, then stops. Spawned only by the fadeno steering plugin when no honest delivery exists.
mode: subagent
---

You are a **refusal reporter**. Your task prompt begins with a block titled
\`# FADENO STEERING REFUSED (<predicate>)\`. Do everything below and NOTHING else:

1. Relay the entire refusal block — from the title through the
   \`FADENO REFUSAL BOUNDARY\` line, including the REFUSAL REASON — **verbatim**
   as your response.
2. State plainly that the requested work was NOT started and nothing was done.
3. Stop. Do not read further, do not perform the task after the boundary, do
   not attempt any substitute or partial version of it, and do not inspect the
   repository.

The task text below the boundary exists only because the original spawn could
not be emptied; it is context for whoever reads your report, never work for you.
`;
}

export interface OpenCodeSteeringApplyOptions extends CommonOptions {
  /** Accepted for call-site symmetry with the other apply targets; always 'opencode'. */
  target?: 'opencode';
  /** Only 'project' is valid; anything else is refused (see `runSteeringApplyOpenCode`). */
  scope?: 'project' | 'user';
  /** `init`'s "re-scaffold over what is there" — see `openCodeManagedEmit`. */
  force?: boolean;
}

/**
 * Materialize the current dials into project-scoped OpenCode agent files under
 * `.opencode/agent/`, and emit the runtime steering plugin beside them.
 *
 * Architecture (the decided hybrid, mirroring how each parent host does it):
 * identity is MATERIALIZED into agent files the way Codex bakes it into TOML,
 * while lane selection stays RUNTIME through the `tool.execute.before` plugin
 * the way Claude's PreToolUse hook rewrites spawns. Per slot:
 *
 * - command adapter  → `fadeno-dispatch-<archetype>.md`, a relay-only broker.
 * - host adapter     → `<archetype>.md`, the static role body plus the dial's
 *                      model (and a pinned effort as `variant:`).
 *
 * Three refusal brokers (`fadeno-steering-refused-<archetype>.md`) are always
 * emitted: the plugin has no deny primitive, so every refusal is delivered by
 * rewriting the spawn onto one of these with the reason embedded in the prompt.
 *
 * Deliberately PROJECT scope only. A user-scope set would steer every repo on
 * the machine, so — same rule as Codex user scope — it is refused rather than
 * silently exported; `.opencode/agent/` is per-repo session machinery that any
 * later apply refreshes in place when it carries the managed mark.
 */
export function runSteeringApplyOpenCode(opts: OpenCodeSteeringApplyOptions): SteeringApplyResult {
  const repoRoot = rootOf(opts);
  if ((opts as unknown as { scope?: string }).scope === 'user') {
    throw new SteeringError(
      'OpenCode steering materializes at project scope only (.opencode/agent/); ' +
        '--scope user would export this repo\'s dials to every repo on this machine.',
    );
  }
  // This apply materializes OPENCODE deliveries, so resolve against that
  // host: which lane each dial lands on, and the spelling and argv it lands
  // with, must agree with the resolver the plugin invokes under
  // FADENO_HARNESS=opencode.
  const { profile } = (() => {
    try {
      return loadExecutorProfile(repoRoot, opts.userPathOptions, 'opencode');
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
      throw err;
    }
  })();
  let dialLayers: DialLayers;
  try {
    dialLayers = dialLayersForApply('project', repoRoot, profile, opts.userPathOptions).layers;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
  const agentDir = join(repoRoot, '.opencode', 'agent');
  const results: EmitResult[] = [];
  const materialization: SteeringApplyResult['materialization'] = {};
  const baseline: Record<string, string> = {};
  const removed: string[] = [];
  const pending: Array<{ path: string; body: string }> = [];

  for (const archetype of CODEX_STEERING_ARCHETYPES) {
    let cascade: { ref: DialRef; source: RoleResolutionSource; resolvedVia: string | null };
    try {
      cascade = resolveDialCascade(archetype, archetype, { bindings: profile.bindings, archetypes: profile.archetypes }, dialLayers);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
      throw err;
    }
    const executorName = formatDialRef(cascade.ref);
    let spec: ExecutorSpec | null = snapshotExecutor(profile, executorName, archetype) ?? null;
    let compiled: CompiledDelivery | null = null;
    try {
      // With the ARCHETYPE, so a policy-chosen variant and the host lane's own
      // eligibility both reach this decision — the same call the Codex, Claude
      // and omp applies make.
      compiled = resolveDelivery(cascade.ref, profile as unknown as ExecutorProfile, undefined, { archetype });
      if (spec == null) spec = compiled.spec;
    } catch {}
    if (spec == null) {
      throw new SteeringError(`archetype "${archetype}" resolved to "${executorName}" but no executor exists in profile`);
    }
    // Whether this slot can be delivered IN-SESSION. `spec.adapter` alone said
    // yes for `opus on omp` under an OpenCode host — a host nobody is sitting
    // in — and wrote an in-session role slot naming a model OpenCode would
    // never have been handed.
    const hostSlot = hostCandidateOf(compiled, spec);
    if (hostSlot && spec.adapter === 'host' && (spec as { agentType?: string }).agentType === '*') {
      spec = { ...spec, agentType: archetype } as ExecutorSpec;
    }
    if (!hostSlot) {
      materialization[archetype] = {
        kind: 'command-broker', adapter: 'command', executor: executorName,
        model: (spec as { model: string | null }).model,
      };
      pending.push({
        path: join(agentDir, `fadeno-dispatch-${archetype}.md`),
        body: stampManagedOpenCodeAgent(renderOpenCodeDispatchBroker(archetype)),
      });
      // The host slot file from a previous apply is now stale identity: remove
      // it so no session keeps loading yesterday's dialed model.
      removeManagedOpenCodeFile(join(agentDir, `${archetype}.md`), removed);
    } else {
      baseline[archetype] = executorName;
      materialization[archetype] = {
        kind: 'host', adapter: 'host', executor: executorName,
        model: (spec as { model: string | null }).model,
      };
      pending.push({
        path: join(agentDir, `${archetype}.md`),
        body: stampManagedOpenCodeAgent(
          renderOpenCodeRoleSlot(archetype, compiled?.modelId ?? (spec as { model: string | null }).model ?? null, cascade.ref.effort ?? null),
        ),
      });
      removeManagedOpenCodeFile(join(agentDir, `fadeno-dispatch-${archetype}.md`), removed);
    }
  }

  // Refusal brokers are static across dials — emit all three on every apply so
  // an upgrade refreshes their instructions like any other managed file.
  for (const archetype of CODEX_STEERING_ARCHETYPES) {
    pending.push({
      path: join(agentDir, `fadeno-steering-refused-${archetype}.md`),
      body: stampManagedOpenCodeAgent(renderOpenCodeRefusalBroker(archetype)),
    });
  }

  for (const item of pending) {
    results.push({ path: item.path, status: openCodeManagedEmit(item.path, item.body, opts.force ?? false) });
  }

  // The runtime plugin. Stamped with the package version so evidence rows name
  // the generation that wrote them; refreshed whenever this apply runs against
  // a file carrying Fadeno's mark, never against a foreign file.
  const pluginTemplate = readFileSync(join(templatesDir(), 'opencode', 'plugin', 'fadeno-steering.js'), 'utf8');
  const pluginContent = stampHookVersion(pluginTemplate).replace(/^#!.*\n/, '');
  const pluginBody =
    `${OPENCODE_PLUGIN_MANAGED_MARK} version=${packageVersion()} digest=${sha256Hex(pluginContent)}\n` +
    pluginContent;
  const pluginPath = join(repoRoot, '.opencode', 'plugin', 'fadeno-steering.js');
  results.push({ path: pluginPath, status: openCodePluginEmit(pluginPath, pluginBody, opts.force ?? false) });

  // The background-dispatch tool, beside the steering plugin under the same
  // managed-mark discipline (no HOOK_VERSION stamp: it writes no evidence of
  // its own — the kernel owns every dispatch row).
  const dispatchToolTemplate = readFileSync(join(templatesDir(), 'opencode', 'plugin', 'fadeno-dispatch-tool.js'), 'utf8');
  const dispatchToolContent = dispatchToolTemplate.replace(/^#!.*\n/, '');
  const dispatchToolBody =
    `${OPENCODE_PLUGIN_MANAGED_MARK} version=${packageVersion()} digest=${sha256Hex(dispatchToolContent)}\n` +
    dispatchToolContent;
  const dispatchToolPath = join(repoRoot, '.opencode', 'plugin', 'fadeno-dispatch-tool.js');
  results.push({ path: dispatchToolPath, status: openCodePluginEmit(dispatchToolPath, dispatchToolBody, opts.force ?? false) });

  // The apply command is also a supported upgrade path for an existing repo,
  // so install ignores after emission. The helper inspects ownership markers
  // and skips exact paths occupied by preserved foreign files.
  const restartRequired = results.some((item) => item.status === 'created' || item.status === 'overwritten');
  const gitignorePath = join(repoRoot, '.gitignore');
  const gitignoreExisted = existsSync(gitignorePath);
  if (ensureOpenCodeFadenoIgnore(repoRoot)) {
    results.push({ path: gitignorePath, status: gitignoreExisted ? 'appended' : 'created' });
  }

  const conflicts = pending
    .filter((item) => existsSync(item.path) && openCodeFileDiffers(item.path, item.body))
    .map((item) => item.path);
  // Agents AND the plugin register at process start, so any change to either
  // needs a fresh OpenCode session to take effect.
  return { results, materialization, baseline, restartRequired, conflicts, scope: 'project', removed };
}

/** Plugin variant of `openCodeManagedEmit`: ownership keyed on its own mark. */
function openCodePluginEmit(path: string, body: string, force: boolean): EmitResult['status'] {
  const existed = existsSync(path);
  if (existed && !force) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.includes(OPENCODE_PLUGIN_MANAGED_MARK)) return 'skipped';
    if (existing === body) return 'skipped';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return existed ? 'overwritten' : 'created';
}

function openCodeFileDiffers(path: string, body: string): boolean {
  try {
    return readFileSync(path, 'utf8') !== body;
  } catch {
    return false;
  }
}

// --- omp steering materialization ---

const OMP_MANAGED_MARK = '<!-- fadeno:managed';
const OMP_EXTENSION_MANAGED_MARK = '// fadeno:managed';
const OMP_STEERING_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;
const OMP_LEGACY_EXTENSION_ENTRY = './extensions/fadeno-steering.ts';

function stampManagedOmpAgent(body: string): string {
  const header = `${OMP_MANAGED_MARK} version=${packageVersion()} digest=${sha256Hex(body)} -->`;
  if (body.startsWith('---\n')) {
    const close = body.indexOf('\n---\n');
    if (close >= 0) {
      const after = close + '\n---\n'.length;
      return `${body.slice(0, after)}${header}\n${body.slice(after)}`;
    }
  }
  return `${header}\n${body}`;
}

function ompManagedEmit(path: string, body: string, force: boolean): EmitResult['status'] {
  const existed = existsSync(path);
  if (existed) {
    const existing = readFileSync(path, 'utf8');
    // `--force` refreshes files Fadeno owns; it never grants ownership of a
    // native omp agent or a foreign alias that happens to share our name.
    if (!existing.includes(OMP_MANAGED_MARK)) return 'skipped';
    if (!force && existing === body) return 'skipped';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return existed ? 'overwritten' : 'created';
}

function removeManagedOmpFile(path: string, removed: string[]): void {
  if (!existsSync(path)) return;
  try {
    if (!readFileSync(path, 'utf8').includes(OMP_MANAGED_MARK)) return;
    unlinkSync(path);
    removed.push(path);
  } catch {
    // Ownership cannot be proven: preserve the file.
  }
}

function readOmpRoleTemplate(archetype: string): { description: string; body: string } {
  const source = readFileSync(join(templatesDir(), 'omp', 'omp-agents', `${archetype}.md`), 'utf8');
  let body = source;
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---\n', 4);
    if (end >= 0) body = body.slice(end + '\n---\n'.length);
  }
  const description = /^description:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? `Fadeno ${archetype} role.`;
  return { description, body: body.trimStart() };
}

function ompSlotPath(agentDir: string, archetype: string, kind: 'host' | 'command' | 'refusal'): string {
  const filename = kind === 'host'
    ? `${archetype}.md`
    : kind === 'command'
      ? `fadeno-dispatch-${archetype}.md`
      : `fadeno-steering-refused-${archetype}.md`;
  const preferred = join(agentDir, filename);
  try {
    if (!existsSync(preferred) || readFileSync(preferred, 'utf8').includes(OMP_MANAGED_MARK)) return preferred;
  } catch {}
  // A pre-existing unmarked native agent belongs to the project author. Keep
  // it loadable and use a deterministic Fadeno-owned alias beside it.
  return join(agentDir, `fadeno-steering-${kind}-${archetype}.md`);
}

function ompRoleContract(archetype: string): string {
  const behavior = ROLE_BEHAVIOR[archetype] ?? `Perform the ${archetype} role exactly as requested.`;
  return `
You are Fadeno's hybrid ${archetype}. Do not spawn further task agents.

Before every task, inspect whether the delivery begins with # Fadeno engine step assignment.
For an engine assignment, the coordinator must provide both run: <run-id> and dispatch_id: <dispatch-id>.
Run FADENO_HARNESS=omp "\${FADENO_CLI:-fadeno}" steering resolve --archetype ${archetype} --host-executor current-host --run <run-id> --dispatch-id <dispatch-id>.
If either identity is absent or validation fails, stop and report the resolver error.
For that engine assignment only:
- mode=host: ${behavior}
- mode=command: run FADENO_HARNESS=omp "\${FADENO_CLI:-fadeno}" dispatch-fallback <run-id> <dispatch-id> and relay stdout verbatim.
- mode=restart_required or mode=write_conflict: stop and relay the resolver refusal.

For an ordinary task beginning with # Fadeno step assignment, first write the entire prompt verbatim to a unique file under .fadeno/local/prompts/, then run FADENO_HARNESS=omp "\${FADENO_CLI:-fadeno}" steering resolve --archetype ${archetype} --host-executor current-host --prompt-file <path>.
- mode=host: ${behavior}
- mode=command: run FADENO_HARNESS=omp "\${FADENO_CLI:-fadeno}" dispatch --archetype ${archetype} --prompt-file <path> with that same file and relay stdout verbatim. On failure, report it and do not perform the task yourself.
- mode=restart_required or mode=write_conflict: stop and relay the resolver refusal.

Never silently substitute a different model or executor.`;
}

function renderOmpHostAgent(archetype: string, modelId: string | null, agentName = archetype): string {
  const piece = readOmpRoleTemplate(archetype);
  const identity = modelId == null || modelId === NEUTRAL_HOST_EXECUTOR ? '' : `model: ${modelId}\n`;
  return `---\nname: ${agentName}\ndescription: ${piece.description} [Fadeno steering]\n${identity}---\n\n${piece.body}\n${ompRoleContract(archetype)}\n`;
}

function renderOmpCommandAgent(archetype: string, agentName = `fadeno-dispatch-${archetype}`): string {
  const piece = readOmpRoleTemplate(archetype);
  return `---\nname: ${agentName}\ndescription: Fadeno command broker for ${archetype}; relays the task through the active external executor and never performs it locally.\ntools: bash\n---\n\nThe Fadeno steering extension selected this command broker. You are a relay, not an implementer.\n\nFor an engine assignment, run FADENO_HARNESS=omp "\${FADENO_CLI:-fadeno}" dispatch-fallback <run-id> <dispatch-id> and relay stdout verbatim.\nFor an ordinary # Fadeno step assignment, first write the entire received prompt verbatim to a unique file under .fadeno/local/prompts/, then run FADENO_HARNESS=omp "\${FADENO_CLI:-fadeno}" dispatch --archetype ${archetype} --prompt-file <path> and relay stdout verbatim. If dispatch fails, report the failure and do not perform the task locally. Never paraphrase, truncate, or substitute another executor.\n\nOriginal role description: ${piece.description}\n`;
}

function renderOmpRefusalAgent(archetype: string, agentName = `fadeno-steering-refused-${archetype}`): string {
  return `---\nname: ${agentName}\ndescription: Reports why Fadeno refused a ${archetype} spawn, then stops.\ntools: read\n---\n\nYou are a refusal reporter. The task prompt begins with a Fadeno steering refusal. Relay that refusal verbatim, state that the requested work was not started, and stop. Do not inspect the repository or attempt a substitute.\n`;
}

export interface OmpSteeringApplyOptions extends CommonOptions {
  target?: 'omp';
  scope?: 'project' | 'user';
  force?: boolean;
}

/** Materialize one omp role agent (host or command), refusal agents, and the task hook. */
export function runSteeringApplyOmp(opts: OmpSteeringApplyOptions = {}): SteeringApplyResult {
  const repoRoot = rootOf(opts);
  if (opts.scope === 'user') {
    throw new SteeringError('omp steering materializes at project scope only (.omp/); --scope user would export this repo\'s dials to every repo on this machine.');
  }
  let profile: ExecutorProfile;
  try {
    profile = loadExecutorProfile(repoRoot, opts.userPathOptions, 'omp').profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
  let dialLayers: DialLayers;
  let ignoredLocalDials: string[];
  try {
    const scoped = dialLayersForApply('project', repoRoot, profile, opts.userPathOptions);
    dialLayers = scoped.layers;
    ignoredLocalDials = scoped.ignoredLocal;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
    throw err;
  }
  const agentDir = join(repoRoot, '.omp', 'agents');
  const results: EmitResult[] = [];
  const pending: Array<{ path: string; body: string }> = [];
  const removed: string[] = [];
  const materialization: SteeringApplyResult['materialization'] = {};
  const baseline: Record<string, string> = {};

  for (const archetype of OMP_STEERING_ARCHETYPES) {
    let cascade: { ref: DialRef; source: RoleResolutionSource; resolvedVia: string | null };
    try {
      cascade = resolveDialCascade(archetype, archetype, { bindings: profile.bindings, archetypes: profile.archetypes }, dialLayers);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SteeringError(err.message);
      throw err;
    }
    const executorName = formatDialRef(cascade.ref);
    let compiled: ReturnType<typeof resolveDelivery> | null = null;
    try { compiled = resolveDelivery(cascade.ref, profile as unknown as ExecutorProfile, undefined, { archetype }); } catch {}
    const spec = compiled?.spec ?? snapshotExecutor(profile, executorName, archetype);
    if (spec == null) throw new SteeringError(`archetype "${archetype}" resolved to "${executorName}" but no executor exists in profile`);
    if (hostCandidateOf(compiled, spec)) {
      baseline[archetype] = executorName;
      materialization[archetype] = { kind: 'host', adapter: 'host', executor: executorName, model: spec.model };
      const hostPath = ompSlotPath(agentDir, archetype, 'host');
      pending.push({
        path: hostPath,
        body: stampManagedOmpAgent(renderOmpHostAgent(archetype, compiled?.modelId ?? spec.model ?? null, basename(hostPath, '.md'))),
      });
      removeManagedOmpFile(join(agentDir, `fadeno-dispatch-${archetype}.md`), removed);
      removeManagedOmpFile(join(agentDir, `fadeno-steering-command-${archetype}.md`), removed);
    } else {
      materialization[archetype] = { kind: 'command-broker', adapter: 'command', executor: executorName, model: spec.model };
      const commandPath = ompSlotPath(agentDir, archetype, 'command');
      pending.push({ path: commandPath, body: stampManagedOmpAgent(renderOmpCommandAgent(archetype, basename(commandPath, '.md'))) });
      removeManagedOmpFile(join(agentDir, `${archetype}.md`), removed);
      removeManagedOmpFile(join(agentDir, `fadeno-steering-host-${archetype}.md`), removed);
    }
  }

  for (const archetype of OMP_STEERING_ARCHETYPES) {
    const refusalPath = ompSlotPath(agentDir, archetype, 'refusal');
    pending.push({ path: refusalPath, body: stampManagedOmpAgent(renderOmpRefusalAgent(archetype, basename(refusalPath, '.md'))) });
  }
  const extensionTemplate = readFileSync(join(templatesDir(), 'omp', 'extensions', 'fadeno-steering.ts'), 'utf8');
  const extensionContent = stampHookVersion(extensionTemplate);
  const extensionBody = `${OMP_EXTENSION_MANAGED_MARK} version=${packageVersion()} digest=${sha256Hex(extensionContent)}\n${extensionContent}`;
  const extensionPath = join(repoRoot, '.omp', 'extensions', 'fadeno-steering.ts');
  pending.push({ path: extensionPath, body: extensionBody });

  for (const item of pending) {
    const status = item.path === extensionPath
      ? ompExtensionEmit(item.path, item.body, opts.force ?? false)
      : ompManagedEmit(item.path, item.body, opts.force ?? false);
    results.push({ path: item.path, status });
  }
  results.push({ path: join(repoRoot, '.omp', 'settings.json'), status: ompSettingsEmit(repoRoot) });
  const gitignoreExisted = existsSync(join(repoRoot, '.gitignore'));
  if (ensureOmpFadenoIgnore(repoRoot)) results.push({ path: join(repoRoot, '.gitignore'), status: gitignoreExisted ? 'appended' : 'created' });
  const conflicts = pending.filter((item) => existsSync(item.path) && readFileSync(item.path, 'utf8') !== item.body).map((item) => item.path);
  const restartRequired = results.some((item) => item.status === 'created' || item.status === 'overwritten');
  return { results, materialization, baseline, restartRequired, conflicts, scope: 'project', removed, ignoredLocalDials };
}

function ompExtensionEmit(path: string, body: string, force: boolean): EmitResult['status'] {
  const existed = existsSync(path);
  if (existed) {
    const existing = readFileSync(path, 'utf8');
    // An extension is executable user code. Preserve it unless its own
    // Fadeno marker proves that a previous apply created it.
    if (!existing.includes(OMP_EXTENSION_MANAGED_MARK)) return 'skipped';
    if (!force && existing === body) return 'skipped';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return existed ? 'overwritten' : 'created';
}

/** Configure the ignored native extension through omp's explicit settings path.
 * Native discovery honors gitignore, so a generated extension must be listed in
 * `.omp/settings.json` to remain active while keeping executable project
 * machinery out of the repository's ordinary tracked file set. Existing
 * malformed or non-array settings are preserved rather than overwritten.
 */
function ompSettingsEmit(repoRoot: string): EmitResult['status'] {
  const path = join(repoRoot, '.omp', 'settings.json');
  const existed = existsSync(path);
  let settings: Record<string, unknown> = {};
  if (existed) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'skipped';
      settings = parsed as Record<string, unknown>;
    } catch {
      return 'skipped';
    }
  }
  const extensions = settings.extensions;
  if (extensions != null && !Array.isArray(extensions)) return 'skipped';
  if (Array.isArray(extensions) && !extensions.every((entry) => typeof entry === 'string')) return 'skipped';
  const entries = Array.isArray(extensions) ? extensions as string[] : [];
  const current = entries.filter((entry) => entry !== OMP_LEGACY_EXTENSION_ENTRY);
  if (current.includes(OMP_PROJECT_EXTENSION_ENTRY) && current.length === entries.length) return 'skipped';
  settings.extensions = current.includes(OMP_PROJECT_EXTENSION_ENTRY) ? current : [...current, OMP_PROJECT_EXTENSION_ENTRY];
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return existed ? 'overwritten' : 'created';
}

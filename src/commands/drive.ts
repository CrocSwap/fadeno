import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import {
  computeCompositeFrontier,
  hasCompositeContainers,
  type CompositeAction,
} from '../lib/composite-flow.ts';
import {
  ConstraintError,
  evaluateConstraint,
  type ConstraintContext,
} from '../lib/constraints.ts';
import {
  ExecutorProfileError,
  activeHarness,
  formatDialRef,
  parseDialRef,
  parseSnapshotDocument,
  eligibilityFor,
  explainEligibilityConflict,
  explainProviderConflict,
  loadExecutorProfile,
  readLocalDialState,
  resolveDialCascade,
  serializeDialRef,
  roleResolutionEchoLabel,
  serializeSnapshot,
  PROMPT_FILE_PLACEHOLDER,
  SESSION_ID_PLACEHOLDER,
  substitutePromptFile,
  substituteSessionId,
  type DialLayers,
  type DialRef,
  type ExecutorProfile,
  type ExecutorSpec,
  type HarnessId,
  type InputProducer,
  type RoleResolutionSource,
  type SnapshotDocument,
  atCwd,
  withoutHarnessIdentity,
} from '../lib/executors.ts';
import { readUserDials } from '../lib/user-paths.ts';
import { computeNext, FlowCursorError, type NextComputation } from '../lib/flow-cursor.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { resolveRunPlaybookFile, runSchemaDirectories } from '../lib/definitions.ts';
import {
  actorCallIdFor,
  nodeInstanceArtifactScope,
  parseNodeInstanceId,
  stepExecutionIdFor,
} from '../lib/node-instance.ts';
import { roleArchetype, SchemaSet, schemaErrorMessages, validateFile, type SchemaKind } from '../lib/playbook-validate.ts';
import { extractSchemaEnvelope, type EnvelopeExtraction } from '../lib/schema-envelope.ts';
import { baseArtifactName, parseGeneration, schemaKindFor, type Playbook, type PlaybookStep } from '../lib/prompt-resolve.ts';
import {
  readEventsStrict,
  resolveRun,
  RUN_LEDGER_SCHEMA_VERSION,
  RunLedgerError,
  type RunEvent,
} from '../lib/run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';
import {
  INFLIGHT_DIR,
  inflightClaimIsAlive,
  readInflightClaim,
  readSupervisorStatus,
  sleepSync,
  superviseArgv,
  supervisedSpawnError,
  supervisorCanStillReport,
} from '../lib/supervisor.ts';
import {
  WORKSPACE_LEASE_FILE,
  WORKSPACE_LEASE_LOCK,
  acquireWorkspaceLease,
  carryDeclaredPaths,
  collectIsolatedDiff,
  createIsolatedWorktree,
  isWorkspaceLeaseAlive,
  readEffectiveLease,
  readWorkspaceLease,
  releaseWorkspaceLease,
  removeIsolatedWorktree,
  scanIgnoredOutput,
  withWorkspaceWindowLease,
  WorkspaceLeaseError,
  type LeaseHolder,
  type WorkspaceLeaseRecord,
} from '../lib/workspace-lease.ts';
// The engine's attempts isolate the same way an ad-hoc dispatch's do, from
// the same primitives, so a member's worktree is cut from HEAD and then given
// the caller's uncommitted state rather than a clean checkout of it. Imported
// from the dispatch command rather than reimplemented: two spellings of
// "replay the workspace" is exactly how the two paths would drift.
import { applyWorkspaceBaseline, captureWorkspaceBaseline, mergeBackReapplyCommand, settleIsolatedWork, type MergeBackResult } from '../lib/workspace-baseline.ts';
import { CONDITION_REGISTRY, GateError, runGate, SUPPORTED_CONDITIONS, type GateCondition } from './gate.ts';
import { requestHostDispatch, type HostDispatchRequest } from '../lib/host-dispatch.ts';
import { PromptError, runPrompt } from './prompt.ts';
import { RunError, runRun } from './run.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';
import {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_LINES,
  diagnosticsTruncationMarker,
  truncateDiagnostics,
  isDiagnosticsEnabled,
} from '../lib/diagnostics.ts';
import { executeToolCore, ToolExecError, recoverInterruptedToolDispatchesShared } from '../lib/tool-exec.ts';
import { bodyOwnerOf, countIterationStarts, scopeStartIndex, stepStartedInScope } from '../lib/run-scope.ts';

export class DriveError extends Error {}

/**
 * The engine: owns the run transition loop that the driver skill previously
 * asked a model to perform. Control transitions and ledger writes are the
 * engine's; executor adapters own the mechanics of invoking a harness (one
 * configured one-shot command per executor). The engine exits whenever it
 * pauses — durable files, not a resident process, make the run outlive the
 * host session.
 */

export type DriveOutcome =
  | 'terminal'
  | 'paused_human_gate'
  | 'needs_decision'
  | 'executor_failed'
  | 'output_invalid'
  | 'awaiting_host_dispatch'
  | 'max_transitions';

export interface DriveDecision {
  decisionId: string;
  step: string;
  prompt: string;
  options: string[];
}

export interface DriveOptions {
  run: string;
  /** Hard cap on engine transitions per invocation (safety net over loop bounds). */
  maxTransitions?: number;
  /** Session binding overrides, each `role=dialRef`. Recorded as events. */
  bind?: string[];
  /** Hard executor deadline in milliseconds; 0 disables, null/undefined uses the route default. */
  timeoutMs?: number | null;
  /** Bounded opt-in process output diagnostics (per-stream 32 KiB / 500 lines). */
  diagnostics?: boolean;
  /** Max concurrent command deliveries within one ready wave (1–16, default 1). */
  parallel?: number;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  now?: Date;
  /** Progress callback — `cli.ts` passes console.log; the engine never prints. */
  onAction?: (line: string) => void;
}

export interface DriveResult {
  run: string;
  outcome: DriveOutcome;
  /** Terminal run status when outcome is `terminal`. */
  status: string | null;
  /** The pending decision when outcome is `paused_human_gate`. */
  decision: DriveDecision | null;
  detail: string;
  actions: string[];
  transitions: number;
  /** Durable host requests still awaiting start/terminal receipt. */
  requests: HostDispatchRequest[];
  /** Named alias for callers that prefer the protocol vocabulary. */
  unresolvedRequests: HostDispatchRequest[];
}

const MAX_TRANSITIONS_DEFAULT = 50;
const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;
const STDERR_TAIL = 400;
export const DRIVE_PARALLEL_DEFAULT = 1;
export const DRIVE_PARALLEL_MIN = 1;
export const DRIVE_PARALLEL_MAX = 16;
const POLL_MS = 50;
const LIVENESS_EVERY = 20;

export {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_LINES,
  diagnosticsTruncationMarker,
  truncateDiagnostics,
  isDiagnosticsEnabled,
};

interface EngineCtx {
  runId: string;
  runDir: string;
  repoRoot: string;
  userPathOptions?: UserPathOptions;
  harness: HarnessId;
  playbook: Playbook;
  task: string;
  schemas: SchemaSet;
  profile: SnapshotDocument;
  /** Declared `worktree_carry:` paths, off the LIVE profile rather than the
   * resolution snapshot. The snapshot records what was dialled; the carry list
   * is a project fact about what a freshly cut worktree is missing, and it is
   * not part of what a run pins. Resolved once per invocation. */
  worktreeCarry: readonly string[];
  /** Dial layers in force for this invocation (recorded snapshot layers mid-run, live layers at invocation start). */
  dialLayers: DialLayers;
  /** Explicit `--bind` overrides: role key → refString (executor name). */
  overrides: Map<string, string>;
  /** Actor calls that already consumed their one bounded repair this invocation. */
  repaired: Set<string>;
  /** Conflict rounds granted per actor call; see MAX_MERGE_CONFLICT_ROUNDS. */
  conflictRounds: Map<string, number>;
  diagnostics?: boolean;
  timeoutMs?: number | null;
  parallel: number;
  now?: Date;
  act: (line: string) => void;
}

function locatePlaybook(runDir: string, repoRoot: string, name: string): string {
  const found = resolveRunPlaybookFile(runDir, repoRoot, name);
  if (found) return found.path;
  throw new DriveError(`Playbook "${name}" not found in bundled or project definitions.`);
}

function loadValidatedPlaybook(runDir: string, repoRoot: string, name: string, schemas: SchemaSet): Playbook {
  const playbookPath = locatePlaybook(runDir, repoRoot, name);
  let playbook: Playbook;
  try {
    const parsed = parseYaml(readFileSync(playbookPath, 'utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('playbook is not a mapping');
    }
    playbook = parsed as Playbook;
  } catch (err) {
    throw new DriveError(`could not parse playbook ${name}: ${(err as Error).message}`);
  }
  const validation = validateFile(playbookPath, schemas, 'playbook');
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((issue) => `${issue.path || '/'}: ${issue.message}`).join('; ');
    throw new DriveError(`playbook ${name} is invalid; fix it before driving: ${detail}`);
  }
  return playbook;
}

/** Fresh writer per append: runRun/runGate/runPrompt each construct their own
 *  writer, so a cached `lastSeq` here would go stale and double-assign. */
function appendEvent(runDir: string, event: Record<string, unknown>, now?: Date): void {
  let writer: LedgerWriter;
  try {
    writer = new LedgerWriter(runDir);
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new DriveError(err.message);
    throw err;
  }
  writer.append(event, now ?? new Date());
}

function freshEvents(runDir: string): RunEvent[] {
  try {
    return readEventsStrict(runDir);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new DriveError(err.message);
    throw err;
  }
}

function appendLeaseRecoveryAudit(
  ctx: EngineCtx,
  kind: 'workspace_lease_recovered' | 'workspace_lease_reclaim_denied',
  previous: WorkspaceLeaseRecord,
  newHolder: LeaseHolder | null,
  byHolder: LeaseHolder,
  reason: 'dead_supervisor' | 'abandoned_host' | 'active_writer' | 'abandoned_engine',
): void {
  appendEvent(ctx.runDir, {
    type: kind,
    step: null,
    recovered_holder: newHolder,
    previous_holder: previous.holder,
    supervisor_pid: previous.supervisor_pid,
    reason,
    recovered_at: (ctx.now ?? new Date()).toISOString(),
    by: byHolder.id,
  }, ctx.now);
}

/**
 * A hard-killed engine cannot append from a signal handler. On the next drive,
 * close every command-backed start that has no terminal event so the ledger
 * never remains permanently ambiguous. Host starts carry dispatch_id
 * and are recovered through the host receipt protocol instead.
 */
function recoverInterruptedCommandDispatches(ctx: EngineCtx): number {
  const events = freshEvents(ctx.runDir);
  const terminal = new Set(
    events
      .filter((event) => event.type === 'actor_completed' || event.type === 'actor_failed')
      .map((event) => event.extra.actor_call_id)
      .filter((value): value is string => typeof value === 'string'),
  );
  const dangling = events.filter((event) =>
    event.type === 'actor_dispatched' &&
    typeof event.extra.actor_call_id === 'string' &&
    event.extra.dispatch_id == null &&
    !terminal.has(event.extra.actor_call_id),
  );
  for (const event of dangling) {
    const claimRel = event.extra.supervisor_claim;
    if (typeof claimRel === 'string') {
      const expectedPrefix = `${INFLIGHT_DIR}/`;
      if (!claimRel.startsWith(expectedPrefix) || claimRel.split('/').includes('..')) {
        throw new DriveError(
          `interrupted command attempt ${event.extra.actor_call_id} has an unsafe supervisor claim path; refusing recovery.`,
        );
      }
      const claimAbs = join(ctx.repoRoot, ...claimRel.split('/'));
      if (existsSync(claimAbs)) {
        const claim = readInflightClaim(claimAbs, (path) => readFileSync(path, 'utf8'));
        if (claim == null) {
          throw new DriveError(
            `interrupted command attempt ${event.extra.actor_call_id} has an unreadable in-flight claim at ${claimRel}; ` +
              'refusing retry until the claim is inspected or removed.',
          );
        }
        if (inflightClaimIsAlive(claim)) {
          throw new DriveError(
            `command attempt ${event.extra.actor_call_id} still has a live supervisor (pid ${claim.pid}); ` +
              'refusing to record interruption or start a concurrent retry. Wait for it to terminate, then re-run drive.',
          );
        }
        // A dead supervisor cannot remove a stale claim. Once its pid is
        // proven absent, dropping the machine-local file is safe.
        rmSync(claimAbs, { force: true });
      }
    }
  }
  // Repo-wide lease also interlocks recovery after supervisor checks: a live
  // lease held by another holder means another writer is active. Check after
  // supervisor liveness so the more specific supervisor message is preserved.
  // A dangling attempt's own lease must not block its recovery: the engine
  // holder id is `engine:<runId>:<actorCallId>:a<attempt>` and is durable
  // (supervisor_pid null) until the supervisor releases it after executor
  // close. If the drive and supervisor were both SIGKILLed, that lease
  // survives and would otherwise make the run unrecoverable.
  if (dangling.length > 0) {
    const effectiveLease = readEffectiveLease(ctx.repoRoot);
    if (effectiveLease != null) {
      const danglingIds = new Set(
        dangling.map((event) => `engine:${ctx.runId}:${String(event.extra.actor_call_id)}:a${String(event.extra.attempt)}`),
      );
      if (!danglingIds.has(effectiveLease.holder.id)) {
        const byHolder: LeaseHolder = { id: `engine:${ctx.runId}:recovery`, kind: 'engine', runId: ctx.runId };
        try {
          appendLeaseRecoveryAudit(
            ctx,
            'workspace_lease_reclaim_denied',
            effectiveLease,
            null,
            byHolder,
            'active_writer',
          );
        } catch {}
        const holdersSuffix = (() => {
          const holders = (effectiveLease.holders?.length ?? 1) > 1 ? effectiveLease.holders! : [effectiveLease.holder];
          if (holders.length <= 1) return '';
          return ` holders: ${holders.map((h) => `"${h.id}"`).join(', ')}`;
        })();
        throw new DriveError(
          `shared workspace is already held by ${effectiveLease.holder.kind} "${effectiveLease.holder.id}"${holdersSuffix} ` +
            `(supervisor_pid ${effectiveLease.supervisor_pid ?? 'unknown'}, started ${effectiveLease.started_at}); ` +
            `holder "${ctx.runId}" must wait or retry. Inspect it with \`fadeno show ${effectiveLease.holder.runId ?? '<run>'}\`; ` +
            'recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, ' +
            `remove ${WORKSPACE_LEASE_FILE} as a last resort.`,
        );
      }
      if (effectiveLease.supervisor_pid != null || effectiveLease.executor_pid != null || effectiveLease.process_group_id != null) {
        throw new DriveError(
          `command attempt still has a live executor identity in ${WORKSPACE_LEASE_FILE}; ` +
            'refusing to reclaim its lease while the supervisor or detached executor group may still be running.',
        );
      }
      // Reclaim the dangling attempt's own lease so recovery can proceed — audited per contract 1.3/3.4.
      const previous = effectiveLease;
      const byHolder: LeaseHolder = { id: `engine:${ctx.runId}:recovery`, kind: 'engine', runId: ctx.runId };
      const reason = previous.holder.kind === 'host-dispatch' ? 'abandoned_host' as const : 'abandoned_engine' as const;
      try {
        const released = releaseWorkspaceLease({ repoRoot: ctx.repoRoot, holder: effectiveLease.holder });
        if (released) {
          try {
            appendLeaseRecoveryAudit(ctx, 'workspace_lease_recovered', previous, null, byHolder, reason);
            ctx.act(`recovered workspace lease for "${previous.holder.id}" (${reason})`);
          } catch {}
        }
      } catch {}
    }
  }
  let retainedWorktrees = 0;
  for (const event of dangling) {
    // An isolated attempt killed mid-flight leaves a worktree that was never
    // collected. It is RETAINED, not removed, and named on the receipt.
    //
    // The temptation is to tear it down as cleanup, but its contents are the
    // interrupted member's actual work, and a killed drive is exactly when
    // someone wants that back. No diff is collected here and nothing is
    // applied: the executor was killed at an arbitrary point, so the worktree
    // may be mid-write and the shared tree's state is unknown. Naming it is
    // the honest amount of help. `fadeno clean` removes it, deregistering the
    // git admin entry first.
    const workspace = typeof event.extra.workspace === 'string' ? event.extra.workspace : null;
    if (workspace != null) retainedWorktrees += 1;
    appendEvent(ctx.runDir, {
      type: 'actor_failed',
      step: event.step,
      actor: event.extra.actor ?? null,
      step_execution_id: event.extra.step_execution_id,
      actor_call_id: event.extra.actor_call_id,
      attempt: event.extra.attempt,
      executor: event.extra.executor,
      reason: 'engine_interrupted',
      error: workspace == null
        ? 'the previous drive process ended before recording a terminal command receipt'
        : 'the previous drive process ended before recording a terminal command receipt; its isolated ' +
          `worktree is retained at ${workspace} — nothing was merged back, so any work it holds is there and ` +
          'nowhere else',
      ...(workspace != null ? { workspace, workspace_retained: true } : {}),
      recovered: true,
    }, ctx.now);
  }
  if (dangling.length > 0) {
    ctx.act(`recovered ${dangling.length} interrupted command dispatch receipt(s)`);
    if (retainedWorktrees > 0) {
      ctx.act(
        `${retainedWorktrees} isolated worktree(s) retained under .fadeno/local/engine/ — they hold whatever ` +
          'the interrupted members wrote, and nothing merged it back. Inspect before `fadeno clean`.',
      );
    }
  }
  return dangling.length;
}

function parseBinds(bind: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of bind ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new DriveError(`Invalid --bind "${entry}"; expected role=dialRef.`);
    }
    const role = entry.slice(0, eq).trim();
    const raw = entry.slice(eq + 1).trim();
    if (raw.length === 0) throw new DriveError(`Invalid --bind "${entry}"; expected role=dialRef.`);
    let ref: DialRef;
    try {
      ref = parseDialRef(raw, `bind ${role}`);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
      throw err;
    }
    out.set(role, formatDialRef(ref));
  }
  return out;
}

/** Snapshot the repo profile into the run dir on first engine contact; later
 *  invocations run against the snapshot (the run's truth), never a silently
 *  edited repo profile. */
function readLiveDialLayers(repoRoot: string, userPathOptions: UserPathOptions | undefined, liveProfile: ExecutorProfile): DialLayers {
  let session: Record<string, DialRef> = {};
  try {
    const state = readLocalDialState(repoRoot);
    if (state.legacyNote != null) {
      // surface once via act caller; store note for recordResolutionSnapshot to echo?
      // We will surface in runDrive after reading.
    }
    session = state.dials;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
  let user: Record<string, DialRef> = {};
  try {
    const raw = readUserDials(userPathOptions ?? {});
    for (const [k, v] of Object.entries(raw)) {
      // readUserDials returns DialRef-compatible already; parse to be safe
      user[k] = v as DialRef;
    }
  } catch {}
  const repo = { ...liveProfile.dials };
  return { session, repo, user };
}

function ensureProfileSnapshot(
  ctx: Omit<EngineCtx, 'profile' | 'dialLayers' | 'worktreeCarry'>,
  bindRefs: DialRef[],
): SnapshotDocument {
  const snapshotPath = join(ctx.runDir, 'profile.yaml');
  if (existsSync(snapshotPath)) {
    const text = readFileSync(snapshotPath, 'utf8');
    try {
      return parseSnapshotDocument(text, 'profile.yaml (run snapshot)');
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
      throw err;
    }
  }
  let liveProfile: ExecutorProfile;
  try {
    liveProfile = loadExecutorProfile(ctx.repoRoot, ctx.userPathOptions, ctx.harness).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
  // Collect extra refs: every ref in live layers + bindings + --bind refs
  const liveLayers = readLiveDialLayers(ctx.repoRoot, ctx.userPathOptions, liveProfile);
  const extraRefs: DialRef[] = [...Object.values(liveLayers.session), ...Object.values(liveLayers.repo), ...Object.values(liveLayers.user), ...Object.values(liveProfile.bindings), ...bindRefs];
  const text = serializeSnapshot(liveProfile, extraRefs);
  writeFileSync(snapshotPath, text, 'utf8');
  appendEvent(
    ctx.runDir,
    {
      type: 'profile_snapshotted',
      step: null,
      profile: 'profile.yaml',
      bytes: Buffer.byteLength(text),
      sha256: sha256Hex(text),
    },
    ctx.now,
  );
  ctx.act('profile snapshotted → profile.yaml');
  try {
    return parseSnapshotDocument(text, 'profile.yaml (run snapshot)');
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
}

function resolveChain(
  ctx: EngineCtx,
  role: string | null,
): { executor: string; spec: ExecutorSpec; source: RoleResolutionSource; resolvedVia: string | null; ref: DialRef } {
  const archetype = role == null ? null : roleArchetype(ctx.playbook, role);
  const cascade = resolveDialCascade(role ?? '*', archetype, { bindings: ctx.profile.bindings, archetypes: ctx.profile.archetypes }, ctx.dialLayers);
  const refString = formatDialRef(cascade.ref);
  const specRaw = ctx.profile.executors[refString];
  if (specRaw == null) {
    throw new ExecutorProfileError(`resolved dial "${refString}" has no executor in snapshot`);
  }
  let spec: ExecutorSpec = specRaw;
  if (spec.adapter === 'host' && (spec as any).agentType === '*' && archetype != null) {
    spec = { ...spec, agentType: archetype } as ExecutorSpec;
  }
  const source = role == null && cascade.source === 'binding' ? 'base' as RoleResolutionSource : cascade.source;
  return {
    executor: refString,
    spec,
    source,
    resolvedVia: cascade.resolvedVia,
    ref: cascade.ref,
  };
}

/**
 * Warn when a role this run bound earlier is NOT bound on this invocation.
 *
 * `--bind` is per-invocation by design — `ctx.overrides` starts empty every
 * time and is filled only from the flags — and that design is load-bearing:
 * the dead-executor recovery path depends on being able to bind once and then
 * continue without repeating it.
 *
 * What was missing is that dropping the flag is SILENT. A run is normally
 * driven across several invocations, because every host dispatch exits the
 * engine, so "drive, handle a host step, drive again" is the ordinary shape —
 * and forgetting the flag on the second call moves a role back onto the
 * cascade with nothing said. Both invocations are individually consistent, so
 * `verify` cannot object either: the ledger honestly records that the role was
 * bound for one dispatch and resolved normally for the next.
 *
 * So this warns rather than refuses or re-applies. Re-applying would break the
 * recovery path; refusing would make a legitimate pattern an error. Saying it
 * out loud is what was actually missing.
 *
 * Found by dogfood 2026-08-21: an implementer bound to a command-lane executor
 * silently reverted to its repo pin — and therefore to the host lane — on the
 * next invocation of the same run.
 */
function warnDroppedBindings(ctx: EngineCtx, binds: Map<string, string>): void {
  const boundEarlier = new Map<string, string>();
  for (const event of freshEvents(ctx.runDir)) {
    if (event.type !== 'executor_override') continue;
    const role = typeof event.extra.role === 'string' ? event.extra.role : null;
    const executor = typeof event.extra.executor === 'string' ? event.extra.executor : null;
    if (role != null && executor != null) boundEarlier.set(role, executor);
  }
  for (const [role, executor] of boundEarlier) {
    if (binds.has(role)) continue;
    let now: string | null = null;
    try { now = resolveChain(ctx, role).executor; } catch { now = null; }
    if (now === executor) continue; // the cascade agrees; nothing moved
    ctx.act(
      `NOTE: role "${role}" was bound to "${executor}" earlier in this run, but this invocation did not ` +
        `pass --bind ${role}=${executor}, so it resolves to "${now ?? 'nothing'}". --bind applies to one ` +
        'drive invocation, not to the run — repeat it to keep the binding.',
    );
  }
}

/** Validate overrides against the snapshot and record each as an event once. */
function recordOverrides(ctx: EngineCtx, binds: Map<string, string>): void {
  for (const [role, executor] of binds) {
    if (!(executor in ctx.profile.executors)) {
      throw new DriveError(
        `--bind ${role}=${executor}: "${executor}" is not in the run's snapshotted profile ` +
          `(${Object.keys(ctx.profile.executors).join(', ')}).`,
      );
    }
    let prior: string | null = null;
    try {
      prior = resolveChain(ctx, role).executor;
    } catch {
      prior = null; // an unresolvable role is simply "unbound" before override
    }
    ctx.overrides.set(role, executor);
    // Recorded even when the binding names the executor the role already
    // resolved to. It used to `continue` here as a "no-op override, no
    // evidence needed", and that reasoning had the purpose of the event
    // backwards: it does not exist to explain a CHANGE of executor, it exists
    // to explain the recorded SOURCE.
    //
    // `ctx.overrides` has one writer and two readers. The resolution snapshot
    // reads it and stamps `source: binding`; this event is what lets `verify`
    // recompute that. Suppressing the event left the snapshot asserting a
    // provenance nothing could prove, so `verify` recomputed `repo` against a
    // recorded `binding` and failed — permanently, on an append-only ledger.
    // A run driven with `--bind role=<what it already resolves to>` could
    // never verify again.
    //
    // Found by dogfood 2026-08-21, on a run whose three reviewers were bound
    // explicitly and one of which happened to match its repo pin.
    //
    // A no-op binding is also not a nothing: pinning a role to its current
    // executor is how a caller protects a run against a later dial change,
    // which is a fact about the run worth carrying.
    const changed = prior !== executor;
    appendEvent(
      ctx.runDir,
      { type: 'executor_override', step: null, role, executor, prior },
      ctx.now,
    );
    ctx.act(
      changed
        ? `executor override: ${role} → ${executor} (was ${prior ?? 'unbound'})`
        : `executor binding: ${role} → ${executor} (pinned to what it already resolved to)`,
    );
  }
}

function effectiveBinding(ctx: EngineCtx, role: string | null): { executor: string; spec: ExecutorSpec } {
  const key = role ?? '*';
  const overridden = ctx.overrides.get(key);
  if (overridden != null) {
    const spec0 = ctx.profile.executors[overridden];
    if (spec0 == null) throw new DriveError(`--bind ${key}=${overridden}: not in snapshot`);
    const archetype = key !== '*' ? roleArchetype(ctx.playbook, key) : null;
    let spec: ExecutorSpec = spec0;
    if (spec.adapter === 'host' && (spec as any).agentType === '*' && archetype != null) spec = { ...spec, agentType: archetype } as ExecutorSpec;
    return { executor: overridden, spec };
  }
  try {
    const { executor, spec } = resolveChain(ctx, role);
    return { executor, spec };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
}

function effectiveTimeoutMs(ctx: EngineCtx, spec: ExecutorSpec): number | null {
  if (ctx.timeoutMs !== undefined && ctx.timeoutMs !== null) {
    if (ctx.timeoutMs === 0) return null;
    if (typeof ctx.timeoutMs === 'number' && Number.isInteger(ctx.timeoutMs) && ctx.timeoutMs > 0) return ctx.timeoutMs;
    return null;
  }
  if (spec.adapter === 'command' && typeof (spec as any).timeoutMs === 'number' && Number.isInteger((spec as any).timeoutMs) && (spec as any).timeoutMs > 0) {
    return (spec as any).timeoutMs as number;
  }
  return null;
}

/**
 * Record where every declared role lands under this invocation's resolution
 * (dial layers + source, per-role resolved identity), and echo it so a
 * user burning a metered subscription sees which provider the run spends. The
 * ledger event is appended only when the resolution differs from the last
 * recorded snapshot; the echo prints every invocation.
 */
function recordResolutionSnapshot(ctx: EngineCtx): void {
  const rolesDoc = ctx.playbook.roles;
  const roleNames =
    rolesDoc != null && typeof rolesDoc === 'object' && !Array.isArray(rolesDoc)
      ? Object.keys(rolesDoc)
      : [];
  if (roleNames.length === 0) return;

  const entries: Record<string, unknown>[] = [];
  for (const role of roleNames) {
    const archetype = roleArchetype(ctx.playbook, role);
    const overridden = ctx.overrides.get(role);
    if (overridden != null) {
      const specRaw = ctx.profile.executors[overridden];
      const spec = specRaw as ExecutorSpec;
      const model = (spec as any).model ?? (spec.adapter === 'host' ? (spec as any).model : null);
      const effort = (spec as any).reasoningEffort ?? 'default';
      const driver = (spec as any).driver ?? null;
      const provider = (spec as any).provider ?? null;
      const delivery = spec.adapter;
      entries.push({ role, archetype, executor: overridden, model, effort, driver, provider, delivery, source: 'binding', resolved_via: null });
      ctx.act(`${role} → ${overridden}${model != null ? ` (${model})` : ''} [binding]`);
      continue;
    }
    try {
      const { executor, spec, source, resolvedVia } = resolveChain(ctx, role);
      const label = roleResolutionEchoLabel(source);
      const model = (spec as any).model ?? (spec.adapter === 'host' ? (spec as any).model : null);
      const effort = (spec as any).reasoningEffort ?? 'default';
      const driver = (spec as any).driver ?? null;
      const provider = (spec as any).provider ?? null;
      const delivery = spec.adapter;
      entries.push({
        role,
        archetype,
        executor,
        model,
        effort,
        driver,
        provider: provider ?? null,
        delivery,
        source,
        resolved_via: resolvedVia,
      });
      const modelStr = model != null ? ` (${model})` : '';
      ctx.act(
        `${role} → ${executor}${modelStr} [${label}]`,
      );
    } catch (err) {
      if (!(err instanceof ExecutorProfileError)) throw err;
      entries.push({ role, archetype, executor: null, model: null, source: null, error: err.message });
      ctx.act(`${role} → (unresolved)`);
    }
  }

  // Dials in force at snapshot time — always write `dials` key (empty object allowed) so discriminator is unambiguous.
  const dialsPayload: Record<string, Record<string, unknown>> = {};
  const toRefValueMap = (m: Record<string, DialRef>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) out[k] = serializeDialRef(v);
    return out;
  };
  if (Object.keys(ctx.dialLayers.session).length > 0) dialsPayload.session = toRefValueMap(ctx.dialLayers.session);
  if (Object.keys(ctx.dialLayers.repo).length > 0) dialsPayload.repo = toRefValueMap(ctx.dialLayers.repo);
  if (Object.keys(ctx.dialLayers.user).length > 0) dialsPayload.user = toRefValueMap(ctx.dialLayers.user);
  const payload = {
    dials: dialsPayload,
    roles: entries,
  };
  const prior = freshEvents(ctx.runDir).findLast((e) => e.type === 'resolution_snapshot');
  if (
    prior != null &&
    JSON.stringify(prior.extra.dials ?? {}) === JSON.stringify(payload.dials) &&
    JSON.stringify(prior.extra.roles ?? []) === JSON.stringify(entries)
  ) {
    return; // unchanged since last recorded — the ledger stays quiet
  }
  appendEvent(ctx.runDir, { type: 'resolution_snapshot', step: null, ...payload }, ctx.now);
}


function artifactRecorded(events: RunEvent[], path: string): boolean {
  return events.some((e) => e.type === 'artifact_created' && e.extra.artifact === path);
}

interface PriorAttempts {
  count: number;
  lastExecutor: string | null;
}

function priorAttempts(events: RunEvent[], actorCallId: string): PriorAttempts {
  let count = 0;
  let lastExecutor: string | null = null;
  for (const event of events) {
    if (event.type !== 'actor_dispatched' || event.extra.actor_call_id !== actorCallId) continue;
    count += 1;
    lastExecutor = typeof event.extra.executor === 'string' ? event.extra.executor : null;
  }
  return { count, lastExecutor };
}

type DispatchFailure =
  | { kind: 'spawn_failed'; detail: string }
  | { kind: 'exit_nonzero'; detail: string }
  | { kind: 'write_conflict'; detail: string }
  | { kind: 'eligibility_forbidden'; detail: string }
  | { kind: 'provider_conflict'; detail: string }
  | { kind: 'constraint_refused'; detail: string }
  | { kind: 'invalid_output'; detail: string; errors: string[] }
  | {
      /**
       * The attempt's work conflicts with what the workspace now holds, and a
       * conflict round was granted: the worktree is retained with markers,
       * and the next attempt re-invokes the executor in it. Not a terminal
       * failure — the wave queues the round exactly as it queues a schema
       * repair.
       */
      kind: 'merge_conflict';
      detail: string;
      conflicts: string[];
      worktreeRel: string;
      baselineCommit: string;
      priorAttempt: number;
    };

/**
 * What a conflict round needs from the attempt it follows. Carried on the
 * queued member, never on the ledger: the ledger holds the same facts on the
 * prior attempt's `merge_back` stamp and on this attempt's request row.
 */
interface ConflictRound {
  worktreeRel: string;
  baselineCommit: string;
  conflicts: string[];
  priorAttempt: number;
}

/**
 * How many times the executor is re-invoked to resolve a merge conflict
 * before the attempt is failed with the worktree retained for a human. The
 * PR model's "abandon": two rounds is one honest retry past a first miss.
 */
const MAX_MERGE_CONFLICT_ROUNDS = 2;

/**
 * The appendix a conflict round appends to the prompt (or sends alone into a
 * resumed session). Names the files, describes the worktree state as git
 * left it, and asks for the same output as before.
 */
function conflictMessage(conflict: ConflictRound): string {
  const files = conflict.conflicts.map((f) => `- ${f}`).join('\n');
  return [
    `Your previous attempt (attempt ${conflict.priorAttempt}) could not be merged into the workspace: other work landed while you were working, and these files conflict:`,
    files,
    '',
    'Your worktree has been brought up to date. HEAD is now the current workspace; your changes have been re-applied on top of it; and the files listed above contain conflict markers (<<<<<<< / ======= / >>>>>>>). Resolve every marker so the tree is consistent, keep the intent of your change, re-run whatever checks you would normally run, and then produce the same output you were originally asked for.',
  ].join('\n');
}


function playbookFlow(playbook: Playbook): PlaybookStep[] {
  return Array.isArray(playbook.flow) ? (playbook.flow as PlaybookStep[]) : [];
}

function inputNamesOf(step: PlaybookStep): string[] {
  if (typeof step.input === 'string') return [step.input];
  if (Array.isArray(step.input)) return step.input.filter((item): item is string => typeof item === 'string');
  return [];
}

/**
 * Input producers for the provider-distinctness check, attributed from this
 * run's own events — never the live catalog and never ad-hoc dispatch ids.
 * Each logical input's artifact_created → that actor_call's actor_dispatched
 * → executor → provider on the snapshotted profile. Missing in-run producer
 * (declared playbook input, no actor_call, unknown executor) is unresolvable
 * (`provider: null`). `dispatchId` stays null: attribution came from run events.
 */
function inputProducersFromRun(
  playbook: Playbook,
  stepId: string,
  events: RunEvent[],
  profile: SnapshotDocument,
): InputProducer[] {
  const flow = playbookFlow(playbook);
  const step = flow.find((candidate) => candidate.id === stepId);
  if (step == null) return [];
  const producers: InputProducer[] = [];
  for (const inputName of inputNamesOf(step)) {
    const base = baseArtifactName(inputName);
    const producerIds = new Set(
      flow
        .filter((candidate) => typeof candidate.output === 'string' && baseArtifactName(candidate.output) === base)
        .map((candidate) => candidate.id as string),
    );
    const created = events.filter(
      (event) =>
        event.type === 'artifact_created' &&
        event.step != null &&
        producerIds.has(event.step) &&
        typeof event.extra.artifact === 'string',
    );
    if (created.length === 0) {
      producers.push({ dispatchId: null, executor: null, provider: null });
      continue;
    }
    const latestByPath = new Map<string, RunEvent>();
    for (const event of created) {
      latestByPath.set(event.extra.artifact as string, event);
    }
    for (const event of latestByPath.values()) {
      const actorCallId = typeof event.extra.actor_call_id === 'string' ? event.extra.actor_call_id : null;
      if (actorCallId == null) {
        producers.push({ dispatchId: null, executor: null, provider: null });
        continue;
      }
      const attempt = event.extra.attempt;
      const dispatched = events.filter(
        (candidate) => candidate.type === 'actor_dispatched' && candidate.extra.actor_call_id === actorCallId,
      );
      const match =
        typeof attempt === 'number'
          ? dispatched.find((candidate) => candidate.extra.attempt === attempt) ?? dispatched.at(-1)
          : dispatched.at(-1);
      const executor =
        match != null && typeof match.extra.executor === 'string' ? match.extra.executor : null;
      if (executor == null || !Object.hasOwn(profile.executors, executor)) {
        producers.push({ dispatchId: null, executor, provider: null });
        continue;
      }
      producers.push({
        dispatchId: null,
        executor,
        provider: profile.executors[executor]!.provider ?? null,
      });
    }
  }
  return producers;
}



type DispatchOutcome = { kind: 'valid' } | DispatchFailure;

type PromptableOutcome =
  | DispatchFailure
  | { kind: 'awaiting_host_dispatch'; requests: HostDispatchRequest[]; notes: string[] };

function validateTyped(
  ctx: EngineCtx,
  kind: string | null,
  text: string,
): { ok: true; parsed: unknown; extraction?: EnvelopeExtraction } | { ok: false; errors: string[] } {
  if (kind == null) return { ok: true, parsed: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const schemaKind = kind as SchemaKind;
    if (ctx.schemas.has(schemaKind)) {
      const validate = ctx.schemas.get(schemaKind);
      const result = extractSchemaEnvelope(text, validate);
      if (result.ok) {
        return { ok: true, parsed: result.parsed, extraction: result.extraction };
      }
      if (result.reason === 'schema_invalid' && result.errors && result.errors.length > 0) {
        const prefixed = result.errors.slice(0, 5).map((e) => `envelope candidate failed schema: ${e}`);
        return { ok: false, errors: prefixed };
      }
      return { ok: false, errors: [`output is not valid JSON: ${(err as Error).message}`] };
    }
    return { ok: false, errors: [`output is not valid JSON: ${(err as Error).message}`] };
  }
  const schemaKind = kind as SchemaKind;
  if (!ctx.schemas.has(schemaKind)) return { ok: true, parsed };
  const validate = ctx.schemas.get(schemaKind);
  if (validate(parsed)) return { ok: true, parsed };
  return { ok: false, errors: schemaErrorMessages(validate) };
}

function repairMessage(errors: string[]): string {
  const listed = errors.slice(0, 5).map((e) => `- ${e}`).join('\n');
  return (
    'REPAIR: your previous output failed schema validation:\n' +
    `${listed}\n` +
    'Return ONLY a corrected artifact that satisfies the schema. No prose, no fences.'
  );
}

/**
 * Latest session id recorded for this role under this executor. One harness
 * session per role per run; a rebound role (different executor) never resumes
 * the old executor's session.
 */
function latestSessionForRole(events: RunEvent[], role: string | null, executor: string): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'actor_dispatched' && event.type !== 'actor_completed' && event.type !== 'actor_failed') {
      continue;
    }
    if ((event.extra.actor ?? null) !== role) continue;
    if (typeof event.extra.session_id !== 'string') continue;
    if (typeof event.extra.executor === 'string' && event.extra.executor !== executor) continue;
    return event.extra.session_id;
  }
  return null;
}

/** Data for one executor invocation; behavior is described on begin/collect below. */
interface PendingAttempt {
  stepId: string;
  role: string | null;
  generation: number;
  inBody: boolean;
  outputRel: string;
  artifactType: string | null;
  ids: { stepExecutionId: string; actorCallId: string };
  attempt: number;
  reason: string;
  repairErrors: string[] | null;
  /** The conflict this attempt was dispatched to resolve, when it is a conflict round. */
  conflict: ConflictRound | null;
  stamps: { providerWarned?: boolean; shadowOnly?: boolean };
  promptRes: { prompt: string; promptPath: string | null; sha256: string };
  argv: string[];
  stdin: string;
  session: 'fresh' | 'resumed' | null;
  sessionId: string | null;
  executor: string;
  spec: import('../lib/executors.ts').ExecutorSpec;
  leaseHolder: LeaseHolder | null;
  claimRel: string;
  claimAbs: string;
  statusAbs: string;
  outputSnapshotAbs: string;
  stderrSnapshotAbs: string;
  promptSnapshotAbs: string | null;
  startedMs: number;
  startedAt: Date;
  workspaceMode: 'shared' | 'isolated';
  /** The attempt's own worktree, when isolated. Null for a shared attempt and
   * for an isolated one whose worktree could not be built (which degrades to
   * shared and records why). Collection owns its diff, merge-back, and
   * teardown — see `releaseAttempt`. */
  worktree: { abs: string; rel: string; baselineCommit: string; diffRel: string; diffAbs: string } | null;
  /** Why isolation was not delivered, when the request asked for it. Stamped
   * on the attempt's receipt so a shared-tree engine attempt is never silently
   * mistaken for an isolated one. */
  isolationDegraded: string | null;
  effectiveTimeout: number | null;
  diagnosticsRel: string | null;
  diagnosticsBytes: number | null;
  child: import('node:child_process').ChildProcess | null;
}

/** How long a tree-touching step (baseline capture, merge-back) waits for the
 * writer lease before giving up. Generous relative to what it guards — both
 * operations are a couple of git invocations — but a wave now admits members
 * concurrently, so several can queue behind one merge-back at once. */

/**
 * Whether this repo can be isolated into, memoized per process.
 *
 * Asked both at admission (may members run concurrently?) and per attempt
 * (build a worktree?), and it cannot change under a running drive — a repo
 * does not stop being a git repo mid-wave. Memoized so a wave of ten members
 * does not shell out ten times to learn the same thing.
 */
const GIT_AVAILABILITY = new Map<string, boolean>();
function repoHasGit(repoRoot: string): boolean {
  const cached = GIT_AVAILABILITY.get(repoRoot);
  if (cached != null) return cached;
  const probe = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
  const available = probe.error == null && probe.status === 0;
  GIT_AVAILABILITY.set(repoRoot, available);
  return available;
}

/**
 * Run `action` holding the repo-wide writer lease, waiting for it if another
 * holder has it.
 *
 * Isolated engine attempts run unleased — that is what buys the concurrency —
 * but two moments still touch the shared tree and must not interleave with
 * each other or with an ad-hoc dispatch's merge-back: reading the tree to
 * build an attempt's baseline, and applying an attempt's diff back into it.
 * Reading a tree mid-`git apply --3way` yields a half-applied patch, and two
 * concurrent applies can interleave hunks.
 *
 * The wait is what distinguishes this from `acquireWorkspaceLease` used
 * directly, which refuses immediately when the lease is held. Refusing would
 * be wrong here: contention is the NORMAL case once members run concurrently,
 * not an error condition.
 */
function withEngineTreeLease<T>(ctx: EngineCtx, label: string, action: () => T, mode: 'read' | 'write' = 'write'): T {
  const holder: LeaseHolder = { id: `engine-tree:${ctx.runId}:${label}`, kind: 'engine', runId: ctx.runId };
  // The wait, the kernel-pid stamp, and the release live with the lease so
  // the ad-hoc dispatch's windows cannot drift from the engine's.
  return withWorkspaceWindowLease({ repoRoot: ctx.repoRoot, holder, mode }, action);
}

function parseParallelOption(value: unknown): number {
  if (value == null) return DRIVE_PARALLEL_DEFAULT;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < DRIVE_PARALLEL_MIN || n > DRIVE_PARALLEL_MAX) {
    throw new DriveError(`Invalid --parallel "${String(value)}". Use an integer ${DRIVE_PARALLEL_MIN}–${DRIVE_PARALLEL_MAX} (default ${DRIVE_PARALLEL_DEFAULT}).`);
  }
  return n;
}

/**
 * Begin phase: assemble prompt, publish inflight claim, acquire lease (if needed),
 * append actor_dispatched, and spawn the supervisor async. Caller must collect.
 * Owns the claim and lease until collect.
 */
function beginCommandAttempt(
  ctx: EngineCtx,
  stepId: string,
  role: string | null,
  generation: number,
  inBody: boolean,
  outputRel: string,
  artifactType: string | null,
  ids: { stepExecutionId: string; actorCallId: string },
  attempt: number,
  reason: string,
  repairErrors: string[] | null,
  stamps: { providerWarned?: boolean; shadowOnly?: boolean } = {},
  conflict: ConflictRound | null = null,
): PendingAttempt {
  let promptRes;
  try {
    promptRes = runPrompt({
      run: ctx.runId,
      step: stepId,
      actor: role ?? undefined,
      iteration: inBody ? generation : undefined,
      record: true,
      repoRoot: ctx.repoRoot,
      now: ctx.now,
    });
  } catch (err) {
    if (err instanceof PromptError) throw new DriveError(err.message);
    throw err;
  }

  const { executor, spec } = effectiveBinding(ctx, role);
  if (spec.adapter !== 'command') {
    throw new DriveError(`host executor "${executor}" must be handled by the host dispatch protocol.`);
  }
  // One appendix at most: a conflict round and a schema repair are never
  // the same attempt, and the request row names which this is.
  const repairCore = conflict != null ? conflictMessage(conflict) : repairErrors != null ? repairMessage(repairErrors) : null;

  let session: 'fresh' | 'resumed' | null = null;
  let sessionId: string | null = null;
  let argv = spec.command;
  if (spec.resume != null) {
    const prior = latestSessionForRole(freshEvents(ctx.runDir), role, executor);
    if (prior != null) {
      session = 'resumed';
      sessionId = prior;
      argv = substituteSessionId(spec.resume, prior);
    } else {
      session = 'fresh';
      if (spec.command.some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
        sessionId = randomUUID();
        argv = substituteSessionId(spec.command, sessionId);
      }
    }
  }
  if (argv.some((part) => part.includes(PROMPT_FILE_PLACEHOLDER))) {
    if (promptRes.promptPath == null) {
      throw new DriveError(`executor "${executor}" needs ${PROMPT_FILE_PLACEHOLDER} but this step recorded no prompt artifact.`);
    }
    argv = substitutePromptFile(argv, join(ctx.runDir, promptRes.promptPath));
  }

  const stdin =
    repairCore == null
      ? promptRes.prompt
      : session === 'resumed'
        ? repairCore
        : `${promptRes.prompt}\n\n---\n${repairCore}`;

  const dispatched: Record<string, unknown> = {
    type: 'actor_dispatched',
    step: stepId,
    actor: role,
    step_execution_id: ids.stepExecutionId,
    actor_call_id: ids.actorCallId,
    attempt,
    attempt_reason: reason,
    executor,
    command: argv,
    command_sha256: sha256Hex(JSON.stringify(argv)),
    model: spec.model,
    prompt_path: promptRes.promptPath,
    prompt_sha256: promptRes.sha256,
    // What the attempt is for, on the row that started it: a later acceptance
    // of its work (`attempt-accept`) reads these rather than recomputing
    // them from a playbook that may have moved on.
    output_path: outputRel,
    ...(artifactType != null ? { artifact_type: artifactType } : {}),
  };
  const claimRel = `${INFLIGHT_DIR}/engine-${ctx.runId}-${ids.actorCallId}-a${attempt}.json`;
  const claimAbs = join(ctx.repoRoot, ...claimRel.split('/'));
  const statusAbs = claimAbs.replace(/\.json$/, '.status.json');
  mkdirSync(join(ctx.repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
  if (existsSync(claimAbs)) {
    const existingClaim = readInflightClaim(claimAbs, (path) => readFileSync(path, 'utf8'));
    if (existingClaim == null) {
      throw new DriveError(
        `interrupted command attempt ${ids.actorCallId} has an unreadable in-flight claim at ${claimRel}; ` +
          'refusing retry until the claim is inspected or removed.',
      );
    }
    if (inflightClaimIsAlive(existingClaim)) {
      throw new DriveError(
        `command attempt ${ids.actorCallId} still has a live supervisor (pid ${existingClaim.pid}); ` +
          'refusing to record interruption or start a concurrent retry. Wait for it to terminate, then re-run drive.',
      );
    }
    rmSync(claimAbs, { force: true });
  }
  {
    const nowIso = (ctx.now ?? new Date()).toISOString();
    const initialClaim = {
      pid: process.pid,
      supervisor_pid: process.pid,
      executor_pid: null,
      process_group_id: null,
      started_at: nowIso,
      heartbeat_at: nowIso,
      last_output_at: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
    };
    const tmp = `${claimAbs}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify(initialClaim), { flag: 'wx' });
      linkSync(tmp, claimAbs);
    } catch (error) {
      rmSync(tmp, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const competing = readInflightClaim(claimAbs, (path) => readFileSync(path, 'utf8'));
        if (competing == null) {
          throw new DriveError(
            `command attempt ${ids.actorCallId} has a concurrently published unreadable in-flight claim at ${claimRel}; ` +
              'refusing retry until the claim is inspected or removed.',
          );
        }
        throw new DriveError(
          `command attempt ${ids.actorCallId} already has a concurrently published supervisor claim (pid ${competing.pid}); ` +
            'refusing to start a duplicate attempt. Wait for it to terminate, then re-run drive.',
        );
      }
      throw new DriveError(`failed to publish inflight claim for ${ids.actorCallId}.`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  dispatched.supervisor_claim = claimRel;
  if (session != null) dispatched.session = session;
  if (sessionId != null) dispatched.session_id = sessionId;
  dispatched.engine_pid = process.pid;
  if (stamps.providerWarned === true) dispatched.provider_distinctness = 'warned';
  if (stamps.shadowOnly === true) dispatched.gate_eligible = false;
  if (repairCore != null && conflict == null) {
    dispatched.repair_appendix = session === 'resumed' ? repairCore : `\n\n---\n${repairCore}`;
  }
  if (conflict != null) {
    // The same facts the prior attempt's `merge_back` stamp carries, restated
    // on the request so verify can pair the two without reading the prompt.
    dispatched.conflicts = [...conflict.conflicts];
    dispatched.conflict_appendix = session === 'resumed' ? repairCore : `\n\n---\n${repairCore}`;
  }
  // Isolation, on the same terms as an ad-hoc dispatch: kernel-chosen, so it
  // merges back. The engine never offers a hold-out mode — a run's members
  // exist to produce work the run then consumes, so withholding it would make
  // the following step read a tree the previous step did not write.
  //
  // This is what restores `--parallel`. Concurrency was previously paid for by
  // read-only base argvs, and the permissions cut spent those; separate
  // worktrees buy it back as a fact rather than as a declaration nothing
  // checked. A shared member holds the repo-wide writer lease for its whole
  // run, which is what forced members to serialize.
  //
  // Falls back to shared where git cannot cut a worktree, exactly as a
  // dispatch does, and for the same reason: nobody asked for isolation here,
  // so hard-failing would break runs that work today.
  const workspaceMode: 'shared' | 'isolated' = repoHasGit(ctx.repoRoot) ? 'isolated' : 'shared';

  // The attempt's worktree, built before anything is recorded so the
  // `actor_dispatched` row states a fact rather than an intent. Every failure
  // here degrades to a shared-tree attempt rather than failing the run:
  // nothing has spawned yet, so falling back costs nothing, and hard-failing
  // would turn runs that work today into errors on a repo whose declared
  // carry paths happen not to carry.
  //
  // The degradation is stamped, never silent. A shared engine attempt is the
  // one shape where nothing contains the executor.
  let worktree: PendingAttempt['worktree'] = null;
  let isolationDegraded: string | null = null;
  if (workspaceMode === 'isolated') {
    const id8 = `${ids.actorCallId}-a${attempt}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const worktreeRel = join('.fadeno', 'local', 'engine', ctx.runId, id8).split('\\').join('/');
    const worktreeAbs = join(ctx.repoRoot, worktreeRel);
    const diffRel = join('.fadeno', 'local', 'outputs', `engine-${ctx.runId}-${id8}.diff`).split('\\').join('/');
    if (conflict != null) {
      // A conflict round does not get a fresh worktree: the one it follows
      // IS the work — the attempt's changes on top of the current workspace,
      // markers and all. Moved to this attempt's name so the `workspace` a
      // receipt records still names the attempt that ran there; if git will
      // not move it, it is used where it is, and the receipt records that
      // path instead. Its baseline is the one the rebase produced, not a new
      // capture: capturing again would hand the executor a tree that no
      // longer matches the markers it is being asked to resolve. And a
      // missing worktree is a refusal, never a degradation to shared —
      // there is nothing to resolve in, so running "the same task" in the
      // caller's tree would be a different task.
      const priorAbs = join(ctx.repoRoot, ...conflict.worktreeRel.split('/'));
      if (!existsSync(priorAbs)) {
        throw new DriveError(`conflict round for ${ids.actorCallId}: the retained worktree ${conflict.worktreeRel} is gone, so there is nothing to resolve in.`);
      }
      const moved = spawnSync('git', ['-C', ctx.repoRoot, 'worktree', 'move', priorAbs, worktreeAbs], { encoding: 'utf8' });
      const useAbs = moved.error == null && moved.status === 0 ? worktreeAbs : priorAbs;
      const useRel = useAbs === worktreeAbs ? worktreeRel : conflict.worktreeRel;
      worktree = { abs: useAbs, rel: useRel, baselineCommit: conflict.baselineCommit, diffRel, diffAbs: join(ctx.repoRoot, diffRel) };
    } else try {
      // A retry re-uses the same identity, so a worktree left behind by a
      // killed prior attempt would collide. Remove it first: its work was
      // either already collected or already lost.
      try { removeIsolatedWorktree(ctx.repoRoot, worktreeAbs); } catch {}
      const created = createIsolatedWorktree({ repoRoot: ctx.repoRoot, worktreePath: worktreeAbs });
      try {
        const carry = carryDeclaredPaths(ctx.repoRoot, created.worktreeAbs, ctx.worktreeCarry, { fingerprint: false });
        if (carry.failure != null) {
          throw new Error(`declared worktree_carry path "${carry.failure.path}" could not be carried (${carry.failure.reason})`);
        }
        // Capture and replay under the writer lease. Not ceremony: a sibling
        // member's merge-back is a `git apply --3way` against this same tree,
        // and reading the tree mid-apply would hand this member a half-applied
        // patch as its starting state. Held for the capture only, then
        // released — the executor itself runs unleased, which is the entire
        // point of isolating it.
        //
        // Captured PER ATTEMPT, unlike a shadow pair's single shared capture.
        // A pair captures once because its two arms must start from identical
        // state; engine members are not being compared, and a member admitted
        // after an earlier one merged back must see that work, not a snapshot
        // predating it.
        const baselineCommit = withEngineTreeLease(
          ctx, `baseline:${ids.actorCallId}:a${attempt}`,
          () => applyWorkspaceBaseline(
            ctx.repoRoot, created.worktreeAbs, captureWorkspaceBaseline(ctx.repoRoot), `${ctx.runId}:${id8}`, 'engine attempt',
          ),
          'read',
        );
        worktree = { abs: created.worktreeAbs, rel: created.worktreeRel, baselineCommit, diffRel, diffAbs: join(ctx.repoRoot, diffRel) };
      } catch (inner) {
        try { removeIsolatedWorktree(ctx.repoRoot, created.worktreeAbs); } catch {}
        throw inner;
      }
    } catch (err) {
      isolationDegraded = err instanceof Error ? err.message : String(err);
      worktree = null;
      ctx.act(`isolation degraded to shared for ${ids.actorCallId} attempt ${attempt}: ${isolationDegraded}`);
    }
  }
  // What actually happened. A degraded attempt runs in the shared tree and so
  // must hold the lease a shared attempt holds.
  const effectiveWorkspaceMode: 'shared' | 'isolated' = worktree != null ? 'isolated' : 'shared';
  const needsLease = effectiveWorkspaceMode === 'shared';
  const leaseHolder: LeaseHolder | null = needsLease
    ? {
        id: `engine:${ctx.runId}:${ids.actorCallId}:a${attempt}`,
        kind: 'engine',
        runId: ctx.runId,
        dispatchId: `${ids.actorCallId}:a${attempt}`,
      }
    : null;
  const withdrawClaim = (): void => { try { rmSync(claimAbs, { force: true }); } catch {} };
  /** Everything the dispatch row says about where this attempt runs, written
   * in one place so the isolated and shared branches cannot drift on it. */
  const stampWorkspace = (): void => {
    const row = dispatched as Record<string, unknown>;
    row.workspace_mode = effectiveWorkspaceMode;
    if (worktree != null) {
      row.workspace = worktree.rel;
      row.baseline_commit = worktree.baselineCommit;
    }
    if (isolationDegraded != null) row.workspace_mode_degraded = isolationDegraded;
  };
  if (needsLease) {
    const existingBefore = (() => {
      try { return readWorkspaceLease(ctx.repoRoot); } catch { return null; }
    })();
    const aliveBefore = existingBefore == null ? false : isWorkspaceLeaseAlive(existingBefore);
    try {
      acquireWorkspaceLease({
        repoRoot: ctx.repoRoot,
        workspaceMode: effectiveWorkspaceMode,
        holder: leaseHolder!,
        supervisorPid: null,
        executorPid: null,
        processGroupId: null,
        startedAt: ctx.now,
        heartbeatAt: ctx.now,
        stdoutBytes: 0,
        stderrBytes: 0,
        now: ctx.now,
      });
      stampWorkspace();
      if (existingBefore != null && !aliveBefore && existingBefore.supervisor_pid != null) {
        try {
          appendLeaseRecoveryAudit(ctx, 'workspace_lease_recovered', existingBefore, leaseHolder!, leaseHolder!, 'dead_supervisor');
          ctx.act(`recovered stale workspace lease for "${existingBefore.holder.id}" (dead supervisor_pid ${existingBefore.supervisor_pid})`);
        } catch {}
      }
    } catch (err) {
      if (err instanceof WorkspaceLeaseError) {
        if (existingBefore != null && aliveBefore && existingBefore.supervisor_pid == null) {
          try {
            appendLeaseRecoveryAudit(ctx, 'workspace_lease_reclaim_denied', existingBefore, null, leaseHolder!, 'abandoned_host');
          } catch {}
        }
        withdrawClaim();
        throw new DriveError(err.message);
      }
      withdrawClaim();
      throw err;
    }
  } else {
    stampWorkspace();
  }

  try {
    appendEvent(ctx.runDir, dispatched, ctx.now);
    ctx.act(
      `dispatch ${stepId}${role ? ` (${role})` : ''} attempt ${attempt} [${reason}]` +
        ` → ${executor}${session != null ? ` (${session} session)` : ''}`,
    );
    ctx.act(`external sandbox: ${executor} (${argv.join(' ')}) runs outside the current harness; evidence is recorded in the run ledger`);
  } catch (error) {
    if (leaseHolder != null) {
      try { releaseWorkspaceLease({ repoRoot: ctx.repoRoot, holder: leaseHolder }); } catch {}
    }
    withdrawClaim();
    throw error;
  }

  const effectiveTimeout = effectiveTimeoutMs(ctx, spec);
  // Prepare snapshot files for async supervisor collection.
  const outputSnapshotAbs = join(ctx.repoRoot, '.fadeno', 'local', 'outputs', `${ctx.runId}-${ids.actorCallId}-a${attempt}.out`);
  const stderrSnapshotAbs = join(ctx.repoRoot, '.fadeno', 'local', 'outputs', `${ctx.runId}-${ids.actorCallId}-a${attempt}.err`);
  mkdirSync(join(ctx.repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
  // Ensure any prior snapshot is removed.
  try { rmSync(outputSnapshotAbs, { force: true }); } catch {}
  try { rmSync(stderrSnapshotAbs, { force: true }); } catch {}
  // Prompt fd: for the attested prompt, fd the recorded artifact; for repair/resumed, compose into a local prompt file.
  let promptSnapshotAbs: string | null = null;
  let promptFdPath: string;
  if (repairCore == null && !argv.some((p) => p.includes(PROMPT_FILE_PLACEHOLDER))) {
    // Simple case: prompt is the recorded artifact; if no placeholder, stdin file is the prompt snapshot.
    // We still need a file containing stdin for the supervisor to fd. For non-repair, stdin == promptRes.prompt, which equals the snapshot file content.
    // Use the snapshot file directly when it exists.
    if (promptRes.promptPath != null) {
      promptFdPath = join(ctx.runDir, promptRes.promptPath);
      promptSnapshotAbs = promptFdPath;
    } else {
      const tmpPrompt = join(ctx.repoRoot, '.fadeno', 'local', 'prompts', `${ctx.runId}-${ids.actorCallId}-a${attempt}.md`);
      mkdirSync(join(ctx.repoRoot, '.fadeno', 'local', 'prompts'), { recursive: true });
      writeFileSync(tmpPrompt, stdin, 'utf8');
      promptFdPath = tmpPrompt;
      promptSnapshotAbs = tmpPrompt;
    }
  } else if (repairCore != null || session === 'resumed') {
    const tmpPrompt = join(ctx.repoRoot, '.fadeno', 'local', 'prompts', `${ctx.runId}-${ids.actorCallId}-a${attempt}.md`);
    mkdirSync(join(ctx.repoRoot, '.fadeno', 'local', 'prompts'), { recursive: true });
    writeFileSync(tmpPrompt, stdin, 'utf8');
    promptFdPath = tmpPrompt;
    promptSnapshotAbs = tmpPrompt;
  } else {
    // PROMPT_FILE_PLACEHOLDER case: the argv already points at the snapshot file, but stdin is still piped (ignored). Use prompt file anyway.
    if (promptRes.promptPath != null) {
      promptFdPath = join(ctx.runDir, promptRes.promptPath);
      promptSnapshotAbs = promptFdPath;
    } else {
      const tmpPrompt = join(ctx.repoRoot, '.fadeno', 'local', 'prompts', `${ctx.runId}-${ids.actorCallId}-a${attempt}.md`);
      mkdirSync(join(ctx.repoRoot, '.fadeno', 'local', 'prompts'), { recursive: true });
      writeFileSync(tmpPrompt, stdin, 'utf8');
      promptFdPath = tmpPrompt;
      promptSnapshotAbs = tmpPrompt;
    }
  }

  const leaseRelease = leaseHolder == null ? undefined : {
    leasePath: join(ctx.repoRoot, WORKSPACE_LEASE_FILE),
    lockPath: join(ctx.repoRoot, WORKSPACE_LEASE_LOCK),
    holder: leaseHolder,
  };
  const spawnCwd = worktree?.abs ?? ctx.repoRoot;
  let promptFd: number | null = null;
  let outFd: number | null = null;
  let errFd: number | null = null;
  let child: import('node:child_process').ChildProcess | null = null;
  try {
    promptFd = openSync(promptFdPath, 'r');
    outFd = openSync(outputSnapshotAbs, 'w');
    errFd = openSync(stderrSnapshotAbs, 'w');
    child = spawn(process.execPath, superviseArgv(argv, claimAbs, statusAbs, leaseRelease, effectiveTimeout), {
      stdio: [promptFd, outFd, errFd],
      cwd: spawnCwd,
      env: atCwd(withoutHarnessIdentity(process.env), spawnCwd),
      detached: false,
    });
    child.unref();
    // Close our copies; child holds its own.
  } catch (err) {
    if (promptFd != null) try { closeSync(promptFd); } catch {}
    if (outFd != null) try { closeSync(outFd); } catch {}
    if (errFd != null) try { closeSync(errFd); } catch {}
    // Withdraw claim and lease on synchronous spawn failure.
    try { rmSync(claimAbs, { force: true }); } catch {}
    if (leaseHolder != null) try { releaseWorkspaceLease({ repoRoot: ctx.repoRoot, holder: leaseHolder }); } catch {}
    try { rmSync(outputSnapshotAbs, { force: true }); } catch {}
    try { rmSync(stderrSnapshotAbs, { force: true }); } catch {}
    throw new DriveError(`failed to spawn executor "${executor}": ${(err as Error).message}`);
  } finally {
    if (promptFd != null) try { closeSync(promptFd); } catch {}
    if (outFd != null) try { closeSync(outFd); } catch {}
    if (errFd != null) try { closeSync(errFd); } catch {}
  }

  // The supervisor will atomically replace the claim and eventually drop it; do not remove it here.
  // Lease is held by the supervisor until close.

  return {
    stepId,
    role,
    generation,
    inBody,
    outputRel,
    artifactType,
    ids,
    attempt,
    reason,
    repairErrors,
    conflict,
    stamps,
    promptRes,
    argv,
    stdin,
    session,
    sessionId,
    executor,
    spec,
    leaseHolder,
    claimRel,
    claimAbs,
    statusAbs,
    outputSnapshotAbs,
    stderrSnapshotAbs,
    promptSnapshotAbs,
    startedMs: Date.now(),
    startedAt: new Date(),
    workspaceMode: effectiveWorkspaceMode,
    worktree,
    isolationDegraded,
    effectiveTimeout,
    diagnosticsRel: null,
    diagnosticsBytes: null,
    child,
  };
}

/**
 * Collect phase: poll supervisor status, enforce output-size boundary, validate,
 * append receipts, and release lease/claim. Must be called once per begin.
 */
function collectCommandAttempt(ctx: EngineCtx, pending: PendingAttempt): DispatchOutcome {
  const { stepId, role, outputRel, artifactType, ids, attempt, executor, leaseHolder, statusAbs, claimAbs, outputSnapshotAbs, stderrSnapshotAbs, effectiveTimeout } = pending;
  /**
   * Every resource this attempt holds, released together.
   *
   * Was twelve byte-identical copies of the same five lines, one before each
   * of this function's returns. That shape survives only while the list is
   * short and never grows: the moment an attempt holds something else — a
   * worktree, say — twelve sites have to learn about it at once, and the one
   * that does not is a leak nothing reports. Idempotent, so calling it on a
   * path that already released is a no-op rather than a double-free.
   */
  /**
   * Collect this attempt's worktree diff, apply it to the shared tree, and
   * tear the worktree down. Idempotent and never throws — a merge-back that
   * cannot happen is a recorded outcome, not an exception, because the diff
   * artifact survives either way and is the thing worth protecting.
   *
   * Three statuses, the same three an ad-hoc dispatch records:
   *   clean       — applied; the work is in the tree
   *   unresolved  — the work conflicts with what the tree now holds; the
   *                 worktree is RETAINED with markers and the tree is untouched
   *   blocked     — nothing was attempted; the tree is untouched
   * The caller's tree is never partly applied: the apply is a plain
   * `git apply`, atomic, and all reconciliation happens in the worktree.
   */
  let workspaceSettled = false;
  let mergeStamp: MergeBackResult | null = null;
  let mergeDiff: { rel: string; bytes: number } | null = null;
  let mergeIgnored: string[] | null = null;
  const settleWorkspace = (): void => {
    if (workspaceSettled) return;
    workspaceSettled = true;
    const wt = pending.worktree;
    if (wt == null) return;
    try {
      // Before the diff, because `git add -A` respects .gitignore and the
      // teardown below is final: whatever this names is about to die.
      const ignored = scanIgnoredOutput(wt.abs, ctx.worktreeCarry);
      if (ignored.paths.length > 0 || ignored.truncated) mergeIgnored = ignored.paths;
      const diff = collectIsolatedDiff({ repoRoot: ctx.repoRoot, worktreeAbs: wt.abs, diffAbs: wt.diffAbs, diffRel: wt.diffRel });
      mergeDiff = { rel: diff.diffRel, bytes: diff.diffBytes };
      if (diff.diffBytes === 0) {
        // The common case for a reviewer or judge, and the reason isolating
        // every member is cheap: nothing to apply, nothing to conflict with.
        mergeStamp = { status: 'clean', detail: 'nothing to apply: the attempt changed no tracked files' };
      } else {
        // One atomic turn at the write window: apply; if the tree moved,
        // rebase the worktree onto it; if that is clean, apply again; if it
        // conflicts, stop with the worktree retained. The rules live with
        // the helper, shared with the ad-hoc dispatch, so the two cannot
        // drift.
        const settled = withEngineTreeLease(ctx, `merge:${ids.actorCallId}:a${attempt}`, () =>
          settleIsolatedWork({
            repoRoot: ctx.repoRoot,
            worktreeAbs: wt.abs,
            diff,
            baselineRef: `${ctx.runId}:${ids.actorCallId}-a${attempt}:rebase`,
            armLabel: 'engine attempt',
            priorConflicts: pending.conflict?.conflicts,
          }));
        mergeStamp = settled.stamp;
        mergeDiff = { rel: settled.diff.diffRel, bytes: settled.diff.diffBytes };
      }
    } catch (err) {
      // Reached when the diff could not be collected or the lease never came
      // free. Nothing was applied, so the tree is untouched — `blocked`, and
      // the diff (when it was collected) is kept.
      mergeStamp = { status: 'blocked', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      // Retained on `unresolved`: the markers in it are the next attempt's
      // input, or a human's. Torn down on everything else — the diff is the
      // durable artifact there, not the worktree.
      if (mergeStamp?.status !== 'unresolved') {
        try { removeIsolatedWorktree(ctx.repoRoot, wt.abs); } catch {}
      }
    }
  };
  // Read through helpers, not directly: every assignment above happens inside
  // `settleWorkspace`, and TypeScript's control-flow analysis collapses these
  // to `null` at the read sites below, so a direct `!= null` narrows to
  // `never`. `dispatch.ts` reads its isolated scan the same way and for the
  // same reason.
  const takeMergeStamp = (): MergeBackResult | null => mergeStamp;
  const takeMergeDiff = (): { rel: string; bytes: number } | null => mergeDiff;
  /** Workspace facts for this attempt's receipt, in one place so a failure
   * event and a completion event cannot disagree about where it ran. */
  const workspaceFields = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { workspace_mode: pending.workspaceMode };
    if (pending.isolationDegraded != null) out.workspace_mode_degraded = pending.isolationDegraded;
    if (pending.worktree != null) out.baseline_commit = pending.worktree.baselineCommit;
    const diff = takeMergeDiff();
    if (diff != null) { out.diff_snapshot = diff.rel; out.diff_bytes = diff.bytes; }
    const stamp = takeMergeStamp();
    if (stamp != null) out.merge_back = stamp;
    if (mergeIgnored != null) out.ignored_output_discarded = mergeIgnored;
    return out;
  };
  let released = false;
  const releaseAttempt = (): void => {
    if (released) return;
    released = true;
    settleWorkspace();
    try { rmSync(outputSnapshotAbs, { force: true }); } catch {}
    try { rmSync(stderrSnapshotAbs, { force: true }); } catch {}
    try { rmSync(statusAbs, { force: true }); } catch {}
    try { rmSync(claimAbs, { force: true }); } catch {}
    if (leaseHolder != null) try { releaseWorkspaceLease({ repoRoot: ctx.repoRoot, holder: leaseHolder }); } catch {}
  };
  let sessionId: string | null = pending.sessionId;
  const startedMs = pending.startedMs;
  // Poll for supervisor status file, with liveness probe. The supervisor measures duration/ended.
  let polls = 0;
  while (!existsSync(statusAbs)) {
    polls += 1;
    if (polls % LIVENESS_EVERY === 0 && pending.child?.pid != null && !supervisorCanStillReport(pending.child.pid)) break;
    sleepSync(POLL_MS);
  }
  let supervisorStatus = readSupervisorStatus(statusAbs, (path) => {
    try { return readFileSync(path, 'utf8'); } catch { return '{}'; }
  });
  // The supervisor holds the claim and lease until close; the kernel never deletes a live claim here.
  // A dead claim is kept for recoverInterruptedCommandDispatches to translate into engine_interrupted.

  // Enforce output-size boundary before materialising the file. A runaway executor is bounded at collection by size on disk.
  let stdout: string;
  let stderr = '';
  // stdout: size check then read; a read failure is a distinct failure, not empty output.
  try {
    const st = statSync(outputSnapshotAbs);
    if (st.size > SPAWN_MAX_BUFFER) {
      const durationMs = supervisorStatus?.durationMs ?? (Date.now() - startedMs);
      const endedAt = supervisorStatus?.endedAt ?? new Date().toISOString();
      const evidenceTiming = { duration_ms: durationMs, ended_at: endedAt };
      const baseFail: Record<string, unknown> = { step: stepId, actor: role, step_execution_id: ids.stepExecutionId, actor_call_id: ids.actorCallId, attempt, executor, ...(sessionId != null ? { session_id: sessionId } : {}), ...(pending.session != null ? { session: pending.session } : {}) };
      appendEvent(ctx.runDir, { type: 'actor_failed', ...baseFail, ...evidenceTiming, reason: 'output_too_large', error: `output exceeded ${SPAWN_MAX_BUFFER} bytes` }, ctx.now);
      releaseAttempt();
      return { kind: 'exit_nonzero', detail: `${executor} output too large on ${stepId}${role ? ` (${role})` : ''}` };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code != null && code !== 'ENOENT') {
      const durationMs = supervisorStatus?.durationMs ?? (Date.now() - startedMs);
      const endedAt = supervisorStatus?.endedAt ?? new Date().toISOString();
      const evidenceTiming = { duration_ms: durationMs, ended_at: endedAt };
      const baseFail: Record<string, unknown> = { step: stepId, actor: role, step_execution_id: ids.stepExecutionId, actor_call_id: ids.actorCallId, attempt, executor, ...(sessionId != null ? { session_id: sessionId } : {}), ...(pending.session != null ? { session: pending.session } : {}) };
      appendEvent(ctx.runDir, { type: 'actor_failed', ...baseFail, ...evidenceTiming, reason: 'output_unreadable', error: `failed to stat output snapshot: ${(err as Error).message}` }, ctx.now);
      releaseAttempt();
      return { kind: 'exit_nonzero', detail: `${executor} output unreadable on ${stepId}${role ? ` (${role})` : ''}: ${(err as Error).message}` };
    }
  }
  try {
    stdout = readFileSync(outputSnapshotAbs, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      stdout = '';
    } else {
      const durationMs = supervisorStatus?.durationMs ?? (Date.now() - startedMs);
      const endedAt = supervisorStatus?.endedAt ?? new Date().toISOString();
      const evidenceTiming = { duration_ms: durationMs, ended_at: endedAt };
      const baseFail: Record<string, unknown> = { step: stepId, actor: role, step_execution_id: ids.stepExecutionId, actor_call_id: ids.actorCallId, attempt, executor, ...(sessionId != null ? { session_id: sessionId } : {}), ...(pending.session != null ? { session: pending.session } : {}) };
      appendEvent(ctx.runDir, { type: 'actor_failed', ...baseFail, ...evidenceTiming, reason: 'output_unreadable', error: `failed to read output snapshot: ${(err as Error).message}` }, ctx.now);
      releaseAttempt();
      return { kind: 'exit_nonzero', detail: `${executor} output unreadable on ${stepId}${role ? ` (${role})` : ''}: ${(err as Error).message}` };
    }
  }
  // stderr: bounded read. Under the cap read it whole (session harvest scans the full
  // text); over the cap keep only the trailing STDERR_TAIL bytes so a runaway stderr
  // cannot exhaust the drive process while its tail evidence survives.
  try {
    const errStat = statSync(stderrSnapshotAbs);
    if (errStat.size > SPAWN_MAX_BUFFER) {
      const fd = openSync(stderrSnapshotAbs, 'r');
      try {
        const tail = Buffer.alloc(STDERR_TAIL);
        const read = readSync(fd, tail, 0, STDERR_TAIL, errStat.size - STDERR_TAIL);
        stderr = tail.subarray(0, read).toString('utf8');
      } finally {
        try { closeSync(fd); } catch {}
      }
    } else {
      stderr = readFileSync(stderrSnapshotAbs, 'utf8');
    }
  } catch { stderr = ''; }

  // Harvest session id from output when the executor declares a pattern (fresh call, pattern mode).
  let harvestedSessionId: string | null = sessionId;
  if (pending.session === 'fresh' && harvestedSessionId == null && (pending.spec as any).sessionIdPattern != null) {
    try {
      const pattern = new RegExp((pending.spec as any).sessionIdPattern);
      const match = pattern.exec(stderr ?? '') ?? pattern.exec(stdout ?? '');
      harvestedSessionId = match?.[1] ?? null;
    } catch {}
  }
  if (harvestedSessionId != null) sessionId = harvestedSessionId;

  const base: Record<string, unknown> = {
    step: stepId,
    actor: role,
    step_execution_id: ids.stepExecutionId,
    actor_call_id: ids.actorCallId,
    attempt,
    executor,
  };
  if (sessionId != null) base.session_id = sessionId;
  if (pending.session != null) base.session = pending.session;
  else if (harvestedSessionId != null) base.session = 'fresh';

  // Diagnostics (bounded, opt-in)
  let diagnosticsRel: string | null = null;
  let diagnosticsBytes: number | null = null;
  const diagnosticsEnabled = isDiagnosticsEnabled({ diagnostics: ctx.diagnostics });
  if (diagnosticsEnabled) {
    try {
      const truncatedStdout = truncateDiagnostics(stdout ?? '', 'stdout');
      const truncatedStderr = truncateDiagnostics(stderr ?? '', 'stderr');
      const content = `# diagnostics for run ${ctx.runId} dispatch ${ids.actorCallId}-a${attempt}\n# stdout_bytes=${Buffer.byteLength(stdout ?? '', 'utf8')} stderr_bytes=${Buffer.byteLength(stderr ?? '', 'utf8')}\n--- stdout ---\n${truncatedStdout}\n--- stderr ---\n${truncatedStderr}\n`;
      const diagRel = join('.fadeno', 'local', 'outputs', 'diagnostics', `${ctx.runId}-${ids.actorCallId}-a${attempt}.log`).split('\\').join('/');
      const diagAbs = join(ctx.repoRoot, diagRel);
      mkdirSync(join(ctx.repoRoot, '.fadeno', 'local', 'outputs', 'diagnostics'), { recursive: true });
      const tmp = `${diagAbs}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(tmp, content, 'utf8');
      try {
        renameSync(tmp, diagAbs);
        diagnosticsRel = diagRel;
        diagnosticsBytes = Buffer.byteLength(content, 'utf8');
      } catch {
        try { rmSync(tmp, { force: true }); } catch {}
      }
      ctx.act(`diagnostics: ${diagnosticsBytes ?? 0} bytes → ${diagRel}`);
    } catch {}
  }
  if (diagnosticsRel != null && diagnosticsBytes != null) {
    base.diagnostics_snapshot = diagnosticsRel;
    base.diagnostics_bytes = diagnosticsBytes;
  }
  // Resolve supervisor status, handling the race where the supervisor is still alive but hasn't yet written the status file.
  // Use the supervisor's own duration/ended when available.
  if (supervisorStatus == null) {
    const isAlive = pending.child?.pid != null && supervisorCanStillReport(pending.child.pid);
    if (!isAlive) {
      let claimAlive = false;
      try {
        if (existsSync(claimAbs)) {
          const claim = readInflightClaim(claimAbs, (p) => readFileSync(p, 'utf8'));
          if (claim != null) claimAlive = inflightClaimIsAlive(claim);
        }
      } catch {}
      if (!claimAlive) {
        const durationMs = Date.now() - startedMs;
        const endedAt = new Date().toISOString();
        const evidenceTiming = { duration_ms: durationMs, ended_at: endedAt };
        appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'supervisor_lost', error: 'supervisor ended without an exit report' }, ctx.now);
        releaseAttempt();
        return { kind: 'exit_nonzero', detail: `${executor} supervisor lost on ${stepId}${role ? ` (${role})` : ''}` };
      }
    }
    // Supervisor still alive but status not yet visible: poll briefly.
    let extraPolls = 0;
    while (!existsSync(statusAbs) && extraPolls < 200) {
      extraPolls += 1;
      if (pending.child?.pid != null && !supervisorCanStillReport(pending.child.pid)) break;
      sleepSync(POLL_MS);
    }
    const retryStatus = readSupervisorStatus(statusAbs, (p) => { try { return readFileSync(p, 'utf8'); } catch { return '{}'; } });
    if (retryStatus == null) {
      const durationMs = Date.now() - startedMs;
      const endedAt = new Date().toISOString();
      const evidenceTiming = { duration_ms: durationMs, ended_at: endedAt };
      appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'supervisor_lost', error: 'supervisor ended without an exit report' }, ctx.now);
      releaseAttempt();
      return { kind: 'exit_nonzero', detail: `${executor} supervisor lost on ${stepId}${role ? ` (${role})` : ''}` };
    }
    supervisorStatus = retryStatus;
  }
  // From here supervisorStatus is non-null; use its measured duration/ended.
  const durationMs = supervisorStatus.durationMs ?? (Date.now() - startedMs);
  const endedAt = supervisorStatus.endedAt ?? new Date().toISOString();
  const evidenceTiming = { duration_ms: durationMs, ended_at: endedAt };

  // The executor has stopped, so its worktree holds everything it is ever
  // going to. Settled HERE — before any receipt is written — for two reasons.
  // Every event below spreads `base`, so stamping it once puts the workspace
  // facts on whichever receipt this attempt turns out to produce. And the work
  // is merged back whatever the exit code: an executor that failed after
  // writing real changes still wrote them, and discarding a worktree because
  // the process exited badly would lose work the caller can see no trace of.
  settleWorkspace();
  Object.assign(base, workspaceFields());

  const spawnFailure = supervisorStatus.spawnFailed ?? supervisedSpawnError(supervisorStatus.exitCode ?? null, stderr);
  if (spawnFailure != null) {
    appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'spawn_failed', error: spawnFailure }, ctx.now);
    releaseAttempt();
    return { kind: 'spawn_failed', detail: `${executor}: ${spawnFailure}` };
  }
  if (supervisorStatus.timedOut === true) {
    const stderrTail = (stderr ?? '').slice(-STDERR_TAIL);
    appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'executor_timeout', ...(supervisorStatus.timeoutMs != null ? { timeout_ms: supervisorStatus.timeoutMs } : {}), ...(supervisorStatus.deadlineAt != null ? { deadline_at: supervisorStatus.deadlineAt } : {}), ...(supervisorStatus.signal != null ? { signal: supervisorStatus.signal } : {}), ...(supervisorStatus.exitCode != null ? { exit_code: supervisorStatus.exitCode } : {}), stderr_tail: stderrTail }, ctx.now);
    releaseAttempt();
    return { kind: 'exit_nonzero', detail: `${executor} timed out after ${supervisorStatus.timeoutMs ?? effectiveTimeout ?? '?'}ms on ${stepId}${role ? ` (${role})` : ''}` };
  }
  if (supervisorStatus.signal != null) {
    const stderrTail = (stderr ?? '').slice(-STDERR_TAIL);
    appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'signal', signal: supervisorStatus.signal, stderr_tail: stderrTail }, ctx.now);
    releaseAttempt();
    return { kind: 'exit_nonzero', detail: `${executor} was interrupted by ${supervisorStatus.signal} on ${stepId}${role ? ` (${role})` : ''}` };
  }
  if (supervisorStatus.exitCode != null && supervisorStatus.exitCode !== 0) {
    const stderrTail = (stderr ?? '').slice(-STDERR_TAIL);
    appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'exit_nonzero', exit_code: supervisorStatus.exitCode, stderr_tail: stderrTail }, ctx.now);
    releaseAttempt();
    return { kind: 'exit_nonzero', detail: `${executor} exited ${supervisorStatus.exitCode ?? '(signal)'} on ${stepId}${role ? ` (${role})` : ''}` };
  }

  // The executor succeeded but its work did not reach the tree. Failing here
  // rather than completing is the whole point: the next step of the run reads
  // the workspace, and an `actor_completed` over a diff that never applied
  // would tell it the change is there. That is the silent-wrong-answer shape
  // this engine exists to avoid — and unlike the shared-tree case, it is
  // recoverable, because the diff artifact is durable and named.
  const settled = takeMergeStamp();
  if (settled != null && settled.status === 'unresolved' && pending.worktree != null) {
    // The PR model: the branch owner resolves. The worktree was rebased onto
    // the current workspace and retains the markers; the executor is
    // re-invoked there, as a new attempt with reason `merge_conflict`, up to
    // the round cap. Past the cap the attempt fails with the worktree still
    // retained for a human. Either way the caller's tree is untouched.
    //
    // The executor's report is parked beside the invalid-output attempts: it
    // is the output of work that has not landed, so it cannot be the step's
    // artifact, but a human who resolves the markers by hand will want it.
    const wt = pending.worktree;
    const conflicts = settled.conflicts ?? [];
    const ext = extname(outputRel) || '.out';
    const attemptRel = `artifacts/attempts/${ids.actorCallId}-a${attempt}${ext}`;
    const attemptAbs = join(ctx.runDir, attemptRel);
    mkdirSync(dirname(attemptAbs), { recursive: true });
    writeFileSync(attemptAbs, stdout, 'utf8');
    const rounds = ctx.conflictRounds.get(ids.actorCallId) ?? 0;
    const where = `${wt.rel} (rebased onto ${(settled.rebased_onto ?? wt.baselineCommit).slice(0, 12)})`;
    if (rounds < MAX_MERGE_CONFLICT_ROUNDS) {
      ctx.conflictRounds.set(ids.actorCallId, rounds + 1);
      const error =
        `${executor} completed, but its work conflicts with what the workspace now holds (${conflicts.join(', ')}). ` +
        `The worktree ${where} is retained with the conflict markers; the workspace is untouched. ` +
        `A merge_conflict attempt follows to resolve them (round ${rounds + 1} of ${MAX_MERGE_CONFLICT_ROUNDS}).`;
      appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'merge_conflict', exit_code: 0, attempt_output: attemptRel, workspace: wt.rel, workspace_retained: true, error }, ctx.now);
      ctx.act(`  merge conflict for ${stepId}${role ? ` (${role})` : ''} in ${conflicts.length} file(s) — re-invoking ${executor} in ${wt.rel} (round ${rounds + 1} of ${MAX_MERGE_CONFLICT_ROUNDS})`);
      releaseAttempt();
      return {
        kind: 'merge_conflict',
        detail: error,
        conflicts,
        worktreeRel: wt.rel,
        baselineCommit: settled.rebased_onto ?? wt.baselineCommit,
        priorAttempt: attempt,
      };
    }
    const error =
      `${executor} completed, but its work still conflicts with the workspace after ${MAX_MERGE_CONFLICT_ROUNDS} conflict round(s) ` +
      `(${conflicts.join(', ')}). The worktree ${where} is retained with the conflict markers and the workspace is untouched. ` +
      `Resolve the markers there, then \`fadeno attempt-accept ${ctx.runId} ${ids.actorCallId}\` to merge the resolved work ` +
      'and complete this attempt without another executor run.';
    appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'merge_back_failed', exit_code: 0, attempt_output: attemptRel, workspace: wt.rel, workspace_retained: true, error }, ctx.now);
    ctx.act(`  merge-back unresolved for ${stepId}${role ? ` (${role})` : ''} after ${MAX_MERGE_CONFLICT_ROUNDS} round(s) — worktree retained at ${wt.rel}`);
    releaseAttempt();
    return { kind: 'exit_nonzero', detail: error };
  }
  if (settled != null && settled.status !== 'clean') {
    const settledDiff = takeMergeDiff();
    const recovery = settledDiff == null
      ? 'the diff could not be collected, so there is nothing to re-apply'
      : `re-apply with \`${mergeBackReapplyCommand(settledDiff.rel)}\` once the tree settles`;
    const error =
      `${executor} completed, but its work could not be merged back into the workspace ` +
      `(${settled.status}${settled.detail != null ? `: ${settled.detail}` : ''}). The tree is untouched. ${recovery}.`;
    appendEvent(ctx.runDir, { type: 'actor_failed', ...base, ...evidenceTiming, reason: 'merge_back_failed', exit_code: 0, error }, ctx.now);
    ctx.act(`  merge-back ${settled.status} for ${stepId}${role ? ` (${role})` : ''} — ${recovery}`);
    releaseAttempt();
    return { kind: 'exit_nonzero', detail: error };
  }

  const verdict = validateTyped(ctx, artifactType, stdout);

  if (!verdict.ok) {
    const ext = extname(outputRel) || '.out';
    const attemptRel = `artifacts/attempts/${ids.actorCallId}-a${attempt}${ext}`;
    const abs = join(ctx.runDir, attemptRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, stdout, 'utf8');
    appendEvent(ctx.runDir, { type: 'actor_completed', ...base, ...evidenceTiming, exit_code: 0, output: attemptRel, output_bytes: Buffer.byteLength(stdout), output_sha256: sha256Hex(stdout), output_valid: false, validation_errors: verdict.errors.slice(0, 5) }, ctx.now);
    ctx.act(`  output failed ${artifactType} validation (attempt ${attempt})`);
    releaseAttempt();
    return { kind: 'invalid_output', detail: `${stepId}${role ? ` (${role})` : ''}: output failed ${artifactType} validation`, errors: verdict.errors };
  }

  const extraction = verdict.ok ? verdict.extraction : undefined;
  if (extraction) {
    const ext = extname(outputRel) || '.out';
    const rawRel = `artifacts/attempts/${ids.actorCallId}-a${attempt}.raw${ext}`;
    const rawAbs = join(ctx.runDir, rawRel);
    mkdirSync(dirname(rawAbs), { recursive: true });
    writeFileSync(rawAbs, stdout, 'utf8');
    const payload = extraction.payload;
    const abs = join(ctx.runDir, outputRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, payload, 'utf8');
    const artifactFields = [`step_execution_id=${ids.stepExecutionId}`, `actor_call_id=${ids.actorCallId}`, `attempt=${attempt}`];
    if (pending.session != null) artifactFields.push(`session=${pending.session}`);
    if (sessionId != null) artifactFields.push(`session_id=${sessionId}`);
    try {
      runRun({ run: ctx.runId, event: 'artifact_created', artifact: outputRel, member: role ?? undefined, fields: artifactFields, repoRoot: ctx.repoRoot, now: ctx.now });
    } catch (err) {
      if (err instanceof RunError) throw new DriveError(err.message);
      throw err;
    }
    appendEvent(ctx.runDir, { type: 'actor_completed', ...base, ...evidenceTiming, exit_code: 0, output: outputRel, output_valid: true, output_extraction: extraction.kind, envelope_candidates: extraction.candidates, raw_output: rawRel, raw_output_bytes: Buffer.byteLength(stdout), raw_output_sha256: sha256Hex(stdout) }, ctx.now);
    ctx.act(`  output normalized (${extraction.kind} envelope) → wrote ${outputRel}`);
    releaseAttempt();
    return { kind: 'valid' };
  }

  const abs = join(ctx.runDir, outputRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, stdout, 'utf8');
  const artifactFields = [`step_execution_id=${ids.stepExecutionId}`, `actor_call_id=${ids.actorCallId}`, `attempt=${attempt}`];
  if (pending.session != null) artifactFields.push(`session=${pending.session}`);
  if (sessionId != null) artifactFields.push(`session_id=${sessionId}`);
  try {
    runRun({ run: ctx.runId, event: 'artifact_created', artifact: outputRel, member: role ?? undefined, fields: artifactFields, repoRoot: ctx.repoRoot, now: ctx.now });
  } catch (err) {
    if (err instanceof RunError) throw new DriveError(err.message);
    throw err;
  }
  appendEvent(ctx.runDir, { type: 'actor_completed', ...base, ...evidenceTiming, exit_code: 0, output: outputRel, output_valid: true }, ctx.now);
  ctx.act(`  wrote ${outputRel}`);
  releaseAttempt();
  return { kind: 'valid' };
}

function dispatchOnce(
  ctx: EngineCtx,
  stepId: string,
  role: string | null,
  generation: number,
  inBody: boolean,
  outputRel: string,
  artifactType: string | null,
  ids: { stepExecutionId: string; actorCallId: string },
  attempt: number,
  reason: string,
  repairErrors: string[] | null,
  stamps: { providerWarned?: boolean; shadowOnly?: boolean } = {},
  conflict: ConflictRound | null = null,
): DispatchOutcome {
  const pending = beginCommandAttempt(ctx, stepId, role, generation, inBody, outputRel, artifactType, ids, attempt, reason, repairErrors, stamps, conflict);
  return collectCommandAttempt(ctx, pending);
}

/**
 * The member to queue after an outcome that earns another attempt — a
 * schema repair (once per actor call) or a conflict round (granted by
 * collection, which holds the round budget) — or null when the outcome is
 * final. One function for the four places a wave consumes an outcome, so a
 * new kind of follow-up cannot be wired into three of them.
 */
function followUpMember(
  ctx: EngineCtx,
  outcome: DispatchOutcome,
  member: Pick<WaveMember, 'role' | 'outputRel' | 'artifactType' | 'ids' | 'stamps' | 'generation' | 'inBody' | 'stepId'>,
): WaveMember | null {
  const base = { role: member.role, outputRel: member.outputRel, artifactType: member.artifactType, ids: member.ids, stamps: member.stamps, generation: member.generation, inBody: member.inBody, stepId: member.stepId };
  if (outcome.kind === 'invalid_output' && !ctx.repaired.has(member.ids.actorCallId)) {
    ctx.repaired.add(member.ids.actorCallId);
    return { ...base, reason: 'schema_repair', repairErrors: outcome.errors, conflict: null };
  }
  if (outcome.kind === 'merge_conflict') {
    return {
      ...base,
      reason: 'merge_conflict',
      repairErrors: null,
      conflict: { worktreeRel: outcome.worktreeRel, baselineCommit: outcome.baselineCommit, conflicts: outcome.conflicts, priorAttempt: outcome.priorAttempt },
    };
  }
  return null;
}

interface WaveMember {
  role: string | null;
  outputRel: string;
  artifactType: string | null;
  ids: { stepExecutionId: string; actorCallId: string };
  reason: string;
  repairErrors: string[] | null;
  /** Set when this member is a conflict round; see `ConflictRound`. */
  conflict: ConflictRound | null;
  stamps: { providerWarned?: boolean; shadowOnly?: boolean };
  // Per-member identity; stepId/generation/inBody are authoritative here, the
  // wave parameters are the common case for classic maps and are kept for
  // compatibility. Prefer head.stepId etc when they differ.
  generation: number;
  inBody: boolean;
  stepId: string;
}

/**
 * Shared preflight evaluation for a command member. Returns stamps on success
 * or a terminal refusal that both wave and serial paths record identically.
 * Binding is resolved by the caller (so lease admission can inspect writeAccess first).
 */
function evaluateMemberPreflight(
  ctx: EngineCtx,
  stepId: string,
  role: string | null,
  binding: ReturnType<typeof effectiveBinding>,
): { ok: true; providerWarned: boolean; shadowOnly: boolean } | { ok: false; outcome: DispatchOutcome; reason: string; error: string; archetype: string | null; executor: string } {
  const archetype = role == null ? null : roleArchetype(ctx.playbook, role);
  const delivery = { executor: binding.executor, spec: binding.spec };
  const eligibilityConflict = explainEligibilityConflict(delivery, archetype);
  if (eligibilityConflict != null) {
    return { ok: false, outcome: { kind: 'eligibility_forbidden', detail: `${stepId}${role ? ` (${role})` : ''} was not dispatched: ${eligibilityConflict}` }, reason: 'eligibility_forbidden', error: eligibilityConflict, archetype, executor: binding.executor };
  }
  const producers = inputProducersFromRun(ctx.playbook, stepId, freshEvents(ctx.runDir), ctx.profile);
  const providerConflict = explainProviderConflict(archetype, binding.spec.provider ?? null, producers, ctx.profile as unknown as import('../lib/executors.ts').ExecutorProfile);
  if (providerConflict != null && providerConflict.level === 'refuse') {
    return { ok: false, outcome: { kind: 'provider_conflict', detail: `${stepId}${role ? ` (${role})` : ''} was not dispatched: ${providerConflict.message}` }, reason: 'provider_conflict', error: providerConflict.message, archetype, executor: binding.executor };
  }
  const providerWarned = providerConflict != null && providerConflict.level === 'warn';
  if (providerWarned) ctx.act(`dispatch warning ${stepId}${role ? ` (${role})` : ''}: ${providerConflict.message}`);

  const chainInfo = (() => { try { return resolveChain(ctx, role); } catch { return null; } })();
  const dialRef = ctx.overrides.get(role ?? '*') != null ? parseDialRef(ctx.overrides.get(role ?? '*')!, 'bind') : chainInfo?.ref ?? null;
  const dialSource = ctx.overrides.get(role ?? '*') != null ? 'binding' : chainInfo?.source ?? null;
  const toRefStr = (m: Record<string, import('../lib/executors.ts').DialRef>) => { const o: Record<string, string> = {}; for (const [k, v] of Object.entries(m)) o[k] = formatDialRef(v); return o; };
  const modelId = (binding.spec as any).model ?? null;
  const constraintContext: ConstraintContext = {
    archetype, role, executor: binding.executor, driver: (binding.spec as any).driver ?? null, provider: (binding.spec as any).provider ?? null, model: (binding.spec as any).model ?? null, model_id: modelId, transport: 'command', command: binding.spec.adapter === 'command' ? binding.spec.command : null, dial: dialRef, dial_source: dialSource, dials: { session: toRefStr(ctx.dialLayers.session), repo: toRefStr(ctx.dialLayers.repo), user: toRefStr(ctx.dialLayers.user) }, resolved_via: chainInfo?.resolvedVia ?? null, input_provenance: producers.map((producer) => ({ dispatch_id: producer.dispatchId, executor: producer.executor, provider: producer.provider })), harness: ctx.harness,
  };
  let constraintVerdict;
  try { constraintVerdict = evaluateConstraint(ctx.profile, constraintContext, { cwd: ctx.repoRoot }); } catch (err) { if (err instanceof ConstraintError) throw new DriveError(`constraint system error: ${(err as Error).message}`); throw err; }
  if (constraintVerdict.verdict === 'refused') {
    return { ok: false, outcome: { kind: 'constraint_refused', detail: `${stepId}${role ? ` (${role})` : ''} was not dispatched: ${constraintVerdict.reason}` }, reason: 'constraint_refused', error: constraintVerdict.reason, archetype, executor: binding.executor };
  }
  const shadowOnly = eligibilityFor(binding.spec, archetype) === 'shadow_only';
  return { ok: true, providerWarned, shadowOnly };
}

/**
 * Bounded wave scheduler for command-delivered actor calls.
 * - Admission in canonical member order, up to --parallel.
 * - Isolated members hold no repo-wide lease and run concurrently; a member
 *   that could not be isolated takes the lease and is admitted alone.
 * - Collection head-of-line in canonical order, independent of wall-clock.
 * - One bounded schema-repair requeue per actor call per invocation.
 * - No sibling cancellation.
 */
function runCommandWave(
  ctx: EngineCtx,
  stepId: string,
  generation: number,
  inBody: boolean,
  members: WaveMember[],
  parallel: number,
): { failure: DispatchOutcome | null; repairQueued: WaveMember[] } {
  const queue: WaveMember[] = [...members];
  const inflight: PendingAttempt[] = [];
  let failure: DispatchOutcome | null = null;
  const repairQueued: WaveMember[] = [];
  let stopAdmitting = false;
  // Ensure inflight siblings are receipted even if admission throws (foreign lease, spawn failure, etc.).
  try {
    while (queue.length > 0 || inflight.length > 0) {
      while (!stopAdmitting && inflight.length < parallel && queue.length > 0) {
        const head = queue[0]!;
        // A prior preflight refusal stops further admission; inflight siblings run to receipt.
        // Binding failures propagate as DriveError to preserve the true resolution error (matching serial path).
        const binding = effectiveBinding(ctx, head.role);
        // Members that will isolate need no repo-wide lease and so do not
        // serialize against each other — that is the concurrency this change
        // buys back. Where git cannot cut a worktree they all run in the
        // shared tree, and the old at-most-one-live-writer rule is exactly
        // right again.
        //
        // This predicate used to be the constant `true`, which made the two
        // checks below unreachable-in-effect: they would fire every time and
        // admit exactly one member. They are meaningful now.
        const needsLease = !repoHasGit(ctx.repoRoot);
        // Still a real gate under isolation, because an isolated member can
        // DEGRADE to shared and take the lease for its whole run. Its siblings
        // must not be admitted behind it, or their merge-backs would sit
        // waiting on a lease held until that member finishes.
        if (inflight.some((p) => p.leaseHolder != null)) {
          break;
        }
        if (needsLease) {
          const effectiveLease = (() => { try { return readEffectiveLease(ctx.repoRoot); } catch { return null; } })();
          // Any live lease here is by construction foreign: the wave enforces at-most-one live writer via the inflight check above.
          if (effectiveLease != null && isWorkspaceLeaseAlive(effectiveLease)) {
            throw new DriveError(
              `shared workspace is already held by ${effectiveLease.holder.kind} "${effectiveLease.holder.id}"` +
                ` (supervisor_pid ${effectiveLease.supervisor_pid ?? 'unknown'}, started ${effectiveLease.started_at}); ` +
                `holder "${ctx.runId}" must wait or retry. Inspect it with \`fadeno show ${effectiveLease.holder.runId ?? '<run>'}\`; ` +
                'recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, ' +
                `remove ${WORKSPACE_LEASE_FILE} as a last resort.`,
            );
          }
        }
        const preflight = evaluateMemberPreflight(ctx, stepId, head.role, binding);
        if (!preflight.ok) {
          const prior = priorAttempts(freshEvents(ctx.runDir), head.ids.actorCallId);
          appendEvent(ctx.runDir, { type: 'actor_failed', step: stepId, actor: head.role, step_execution_id: head.ids.stepExecutionId, actor_call_id: head.ids.actorCallId, attempt: prior.count + 1, executor: preflight.executor, archetype: preflight.archetype, reason: preflight.reason, error: preflight.error }, ctx.now);
          ctx.act(`dispatch refused ${stepId}${head.role ? ` (${head.role})` : ''}: ${preflight.error}`);
          if (failure == null) failure = preflight.outcome;
          queue.shift();
          stopAdmitting = true;
          break;
        }
        const { providerWarned, shadowOnly } = preflight;
        // Compute attempt ordinal: freshEvents after prior dispatches.
        const priorAttemptsInfo = priorAttempts(freshEvents(ctx.runDir), head.ids.actorCallId);
        const attempt = priorAttemptsInfo.count + 1;
        let reason = 'initial';
        if (head.conflict != null) reason = 'merge_conflict';
        else if (head.repairErrors != null) reason = 'schema_repair';
        else if (priorAttemptsInfo.count > 0) {
          const { executor } = effectiveBinding(ctx, head.role);
          reason = executor !== priorAttemptsInfo.lastExecutor ? 'executor_override' : 'user_retry';
        }
        const pending = beginCommandAttempt(ctx, stepId, head.role, generation, inBody, head.outputRel, head.artifactType, head.ids, attempt, reason, head.repairErrors, { providerWarned, shadowOnly }, head.conflict);
        queue.shift();
        inflight.push(pending);
      }
      if (inflight.length > 0) {
        const headPending = inflight[0]!;
        const outcome = collectCommandAttempt(ctx, headPending);
        inflight.shift();
        const follow = followUpMember(ctx, outcome, headPending);
        if (follow != null) repairQueued.push(follow);
        else if (outcome.kind !== 'valid') {
          if (failure == null) failure = outcome;
        }
        // On valid, continue to next collection; no sibling cancellation.
      } else if (queue.length === 0) {
        break;
      } else {
        if (stopAdmitting) break;
        sleepSync(POLL_MS);
      }
    }
  } catch (err) {
    // Admission threw (foreign lease, spawn failure, binding failure). Drain inflight siblings so their work is not lost.
    while (inflight.length > 0) {
      try {
        const hp = inflight[0]!;
        const out = collectCommandAttempt(ctx, hp);
        inflight.shift();
        const follow = followUpMember(ctx, out, hp);
        if (follow != null) repairQueued.push(follow);
        else if (out.kind !== 'valid' && failure == null) {
          failure = out;
        }
      } catch {
        // Best effort drain; individual collection failures are already recorded as actor_failed.
        try { inflight.shift(); } catch {}
      }
    }
    throw err;
  }
  return { failure, repairQueued };
}


function pendingHostRequest(events: RunEvent[], actorCallId: string, runId: string): HostDispatchRequest | null {
  const requested = events.filter(
    (event) => event.type === 'host_dispatch_requested' && event.extra.actor_call_id === actorCallId,
  );
  for (let i = requested.length - 1; i >= 0; i -= 1) {
    const event = requested[i]!;
    const dispatchId = event.extra.dispatch_id;
    if (typeof dispatchId !== 'string') continue;
    const terminal = events.some(
      (candidate) =>
        (candidate.type === 'actor_completed' || candidate.type === 'actor_failed') &&
        candidate.extra.dispatch_id === dispatchId,
    );
    if (terminal) continue;
    const attempt = event.extra.attempt;
    const step = event.step;
    const actor = typeof event.extra.actor === 'string' ? event.extra.actor : null;
    if (
      step == null ||
      typeof attempt !== 'number' ||
      typeof event.extra.step_execution_id !== 'string' ||
      typeof event.extra.executor !== 'string' ||
      typeof event.extra.model !== 'string' ||
      typeof event.extra.reasoning_effort !== 'string' ||
      typeof event.extra.agent_type !== 'string' ||
      typeof event.extra.prompt_path !== 'string' ||
      typeof event.extra.prompt_sha256 !== 'string' ||
      typeof event.extra.output_path !== 'string'
    ) {
      throw new DriveError(`host dispatch request "${dispatchId}" is malformed.`);
    }
    return {
      dispatchId,
      run: runId,
      step,
      actor,
      stepExecutionId: event.extra.step_execution_id,
      actorCallId,
      attempt,
      attemptReason: typeof event.extra.attempt_reason === 'string' ? event.extra.attempt_reason : 'initial',
      executor: event.extra.executor,
      model: event.extra.model,
      reasoningEffort: event.extra.reasoning_effort,
      agentType: event.extra.agent_type,
      promptPath: event.extra.prompt_path,
      promptSha256: event.extra.prompt_sha256,
      outputPath: event.extra.output_path,
      artifactType: typeof event.extra.artifact_type === 'string' ? event.extra.artifact_type as HostDispatchRequest['artifactType'] : null,
      ...(typeof event.extra.node_instance_id === 'string' ? { nodeInstanceId: event.extra.node_instance_id } : {}),
      ...(typeof event.extra.parent_instance_id === 'string' ? { parentInstanceId: event.extra.parent_instance_id } : {}),
      ...(typeof event.extra.map_member === 'string' ? { mapMember: event.extra.map_member } : {}),
      ...(typeof event.extra.generation === 'number' ? { generation: event.extra.generation } : {}),
      ...(typeof event.extra.logical_artifact === 'string' ? { logicalArtifact: event.extra.logical_artifact } : {}),
      ...(Array.isArray(event.extra.validation_errors)
        ? { validationErrors: event.extra.validation_errors.filter((error): error is string => typeof error === 'string') }
        : {}),
      ...(typeof event.extra.repair_appendix === 'string' ? { repairAppendix: event.extra.repair_appendix } : {}),
    };
  }
  return null;
}

/**
 * Divergence note for an in-flight host dispatch whose role would resolve
 * differently under the current loadout/profile resolution. The pending
 * dispatch is honored — a resolution change affects future dispatches only —
 * and this note keeps the divergence visible instead of a silent substitution
 * (the design's explicit non-goal). The contract's only sanctioned path to
 * substitute is a host terminal receipt; drive never invents another.
 */
function pendingResolutionNote(
  ctx: EngineCtx,
  stepId: string,
  role: string | null,
  pending: HostDispatchRequest,
): string | null {
  let current: { executor: string; spec: ExecutorSpec } | null = null;
  try {
    current = effectiveBinding(ctx, role);
  } catch (err) {
    if (!(err instanceof DriveError)) throw err;
  }
  if (current != null && current.executor === pending.executor) return null;
  const currently =
    current == null
      ? 'the current resolution leaves this role unbound'
      : `the current resolution is ${current.executor} (${current.spec.adapter} adapter)`;
  return (
    `step ${stepId}${role ? ` (${role})` : ''} still awaits host dispatch ${pending.dispatchId} → ` +
    `${pending.executor}; ${currently} — the pending dispatch is honored, and the resolution change ` +
    'applies to future dispatches only. To substitute explicitly, submit its host receipts ' +
    '(dispatch-start, then dispatch-complete or dispatch-fail) and re-run drive.'
  );
}

/**
 * Every host dispatch still in requested state (no terminal receipt), across
 * the whole run. Terminal invariant: a run may never reach a terminal status
 * while any of these exist — drive refuses the transition instead of leaving
 * verify to catch the corrupted "completed but still pending" state post-hoc.
 */
function unresolvedHostDispatches(events: RunEvent[], runId: string): HostDispatchRequest[] {
  const actorCallIds = new Set<string>();
  for (const event of events) {
    if (event.type === 'host_dispatch_requested' && typeof event.extra.actor_call_id === 'string') {
      actorCallIds.add(event.extra.actor_call_id);
    }
  }
  const out: HostDispatchRequest[] = [];
  for (const actorCallId of actorCallIds) {
    const pending = pendingHostRequest(events, actorCallId, runId);
    if (pending != null) out.push(pending);
  }
  return out;
}

function hostRequestFor(
  ctx: EngineCtx,
  stepId: string,
  role: string | null,
  outputRel: string,
  artifactType: string | null,
  ids: { stepExecutionId: string; actorCallId: string },
  attempt: number,
  reason: string,
  promptPath: string | null,
  promptSha256: string,
  validationErrors: string[] | null,
  instance?: {
    nodeInstanceId: string;
    parentInstanceId?: string;
    mapMember?: string;
    generation?: number;
    logicalArtifact?: string;
  },
): HostDispatchRequest {
  if (promptPath == null) throw new DriveError(`host dispatch for ${stepId} has no recorded prompt snapshot.`);
  const { executor, spec } = effectiveBinding(ctx, role);
  if (spec.adapter !== 'host') throw new DriveError(`internal error: ${executor} is not a host executor.`);
  const dispatchId = `hd-${ids.actorCallId}-a${attempt}`;
  const repairAppendix = validationErrors != null && validationErrors.length > 0 ? repairMessage(validationErrors) : undefined;
  const request = requestHostDispatch({
    dispatchId,
    run: ctx.runId,
    step: stepId,
    actor: role,
    stepExecutionId: ids.stepExecutionId,
    actorCallId: ids.actorCallId,
    attempt,
    attemptReason: reason,
    executor,
    model: spec.model,
    reasoningEffort: spec.reasoningEffort,
    agentType: spec.agentType,
    promptPath,
    promptSha256,
    outputPath: outputRel,
    artifactType: artifactType as HostDispatchRequest['artifactType'],
    ...(instance ?? {}),
    ...(validationErrors != null && validationErrors.length > 0 ? { validationErrors } : {}),
    ...(repairAppendix != null ? { repairAppendix } : {}),
    repoRoot: ctx.repoRoot,
    now: ctx.now,
  });
  ctx.act(`host dispatch requested ${dispatchId}${role ? ` (${role})` : ''} → ${executor}`);
  return request;
}

function hostRequestAttempts(events: RunEvent[], actorCallId: string): number {
  return events.filter(
    (event) => event.type === 'host_dispatch_requested' && event.extra.actor_call_id === actorCallId,
  ).length;
}

/** Drive one promptable step: every pending actor call, then the collective. */
function drivePromptable(ctx: EngineCtx, comp: NextComputation): PromptableOutcome | null {
  const step = comp.step!;
  const stepId = step.id;
  const generation = step.loop.iteration ?? 1;
  const owner = step.loop.in_body ? bodyOwnerOf(ctx.playbook, stepId) : null;

  let events = freshEvents(ctx.runDir);

  if (owner != null && countIterationStarts(events, owner) < generation) {
    appendEvent(
      ctx.runDir,
      { type: 'loop_iteration_started', step: owner, iteration: generation },
      ctx.now,
    );
    ctx.act(`loop ${owner}: iteration ${generation} started`);
    events = freshEvents(ctx.runDir);
  }

  const scopeFrom = scopeStartIndex(events, owner, generation);
  if (!stepStartedInScope(events, stepId, scopeFrom)) {
    try {
      runRun({ run: ctx.runId, step: stepId, repoRoot: ctx.repoRoot, now: ctx.now });
    } catch (err) {
      if (err instanceof RunError) throw new DriveError(err.message);
      throw err;
    }
    ctx.act(`step ${stepId} started${generation > 1 ? ` (iteration ${generation})` : ''}`);
  }

  const actors: (string | null)[] = step.actors && step.actors.length > 0 ? step.actors : [null];
  const outputs = step.outputs ?? [];
  if (outputs.length < actors.length) {
    throw new DriveError(
      `step "${stepId}" is promptable but plans ${outputs.length} output path(s) for ${actors.length} actor(s).`,
    );
  }

  const stepExecutionId = `se-${stepId}-g${generation}`;

  // Parallel <=1 preserves the original per-member inline ordering: dispatch rows
  // appear in canonical actor order and a preflight refusal stops later members
  // from ever dispatching. This keeps --parallel 1 bit-identical to the serial
  // engine except for output arriving via snapshot files and timing evidence.
  if (ctx.parallel <= 1) {
    const hostRequests: HostDispatchRequest[] = [];
    const hostNotes: string[] = [];
    let serialFailure: DispatchOutcome | null = null;
    for (let i = 0; i < actors.length; i += 1) {
      if (serialFailure != null) break;
      const role = actors[i];
      const outputRel = outputs[i]!;
      events = freshEvents(ctx.runDir);
      if (artifactRecorded(events, outputRel)) continue;
      const actorCallId = role ? `ac-${stepId}-g${generation}-${role}` : `ac-${stepId}-g${generation}`;
      const ids = { stepExecutionId, actorCallId };
      events = freshEvents(ctx.runDir);
      const pendingDispatch = pendingHostRequest(events, actorCallId, ctx.runId);
      if (pendingDispatch != null) {
        const note = pendingResolutionNote(ctx, stepId, role, pendingDispatch);
        if (note != null) { hostNotes.push(note); ctx.act(note); }
        hostRequests.push(pendingDispatch);
        continue;
      }
      const binding = effectiveBinding(ctx, role);
      if (binding.spec.adapter === 'host') {
        const priorHostAttempts = hostRequestAttempts(events, actorCallId);
        const attempt = priorHostAttempts + 1;
        const priorHostRequest = events.filter((e) => e.type === 'host_dispatch_requested' && e.extra.actor_call_id === actorCallId).at(-1);
        const priorHostTerminal = priorHostRequest == null ? null : events.findLast((e) => (e.type === 'actor_completed' || e.type === 'actor_failed') && e.extra.dispatch_id === priorHostRequest.extra.dispatch_id);
        const reason = priorHostAttempts === 0 ? 'initial' : priorHostTerminal?.type === 'actor_completed' && priorHostTerminal.extra.output_valid === false ? 'schema_repair' : binding.executor !== priorHostRequest?.extra.executor ? 'executor_override' : 'user_retry';
        const repairErrors = reason === 'schema_repair' && priorHostTerminal != null && Array.isArray(priorHostTerminal.extra.validation_errors) ? priorHostTerminal.extra.validation_errors.filter((e): e is string => typeof e === 'string') : null;
        const promptRes = (() => {
          try {
            return runPrompt({ run: ctx.runId, step: stepId, actor: role ?? undefined, iteration: step.loop.in_body ? generation : undefined, record: true, repoRoot: ctx.repoRoot, now: ctx.now });
          } catch (err) { if (err instanceof PromptError) throw new DriveError(err.message); throw err; }
        })();
        hostRequests.push(hostRequestFor(ctx, stepId, role, outputRel, step.artifact_type, ids, attempt, reason, promptRes.promptPath, promptRes.sha256, repairErrors));
        continue;
      }
      // Command member: preflight via shared helper before any spawn.
      const preflight = evaluateMemberPreflight(ctx, stepId, role, binding);
      if (!preflight.ok) {
        events = freshEvents(ctx.runDir);
        appendEvent(ctx.runDir, { type: 'actor_failed', step: stepId, actor: role, step_execution_id: ids.stepExecutionId, actor_call_id: ids.actorCallId, attempt: priorAttempts(events, ids.actorCallId).count + 1, executor: preflight.executor, archetype: preflight.archetype, reason: preflight.reason, error: preflight.error }, ctx.now);
        ctx.act(`dispatch refused ${stepId}${role ? ` (${role})` : ''}: ${preflight.error}`);
        serialFailure = { kind: preflight.outcome.kind as DispatchFailure['kind'], detail: (preflight.outcome as { detail: string }).detail } as DispatchOutcome;
        break;
      }
      let repairErrors: string[] | null = null;
      let conflict: ConflictRound | null = null;
      for (;;) {
        events = freshEvents(ctx.runDir);
        const prior = priorAttempts(events, ids.actorCallId);
        const attempt = prior.count + 1;
        let reason: string = 'initial';
        if (conflict != null) reason = 'merge_conflict';
        else if (repairErrors != null) reason = 'schema_repair';
        else if (prior.count > 0) {
          const { executor } = effectiveBinding(ctx, role);
          reason = executor !== prior.lastExecutor ? 'executor_override' : 'user_retry';
        }
        const outcome = dispatchOnce(ctx, stepId, role, generation, step.loop.in_body, outputRel, step.artifact_type, ids, attempt, reason, repairErrors, { providerWarned: preflight.providerWarned, shadowOnly: preflight.shadowOnly }, conflict);
        if (outcome.kind === 'valid') break;
        // The same two follow-ups the wave grants, through the same helper.
        const follow = followUpMember(ctx, outcome, { role, outputRel, artifactType: step.artifact_type, ids, stamps: {}, generation, inBody: step.loop.in_body, stepId });
        if (follow != null) {
          repairErrors = follow.repairErrors;
          conflict = follow.conflict;
          continue;
        }
        serialFailure = outcome;
        break;
      }
    }
    if (hostRequests.length > 0 && serialFailure != null) {
      const failureDetail = (serialFailure as { detail: string }).detail;
      hostNotes.push(`command member failed: ${failureDetail} — host dispatch still required`);
      return { kind: 'awaiting_host_dispatch', requests: hostRequests, notes: hostNotes };
    }
    if (serialFailure != null) return serialFailure as PromptableOutcome;
    if (hostRequests.length > 0) {
      return { kind: 'awaiting_host_dispatch', requests: hostRequests, notes: hostNotes };
    }
    // Collective assembly for serial path
    if (step.collective != null) {
      events = freshEvents(ctx.runDir);
      if (!artifactRecorded(events, step.collective)) {
        const parts = actors.map((role, i) => {
          const rel = outputs[i]!;
          const abs = join(ctx.runDir, rel);
          try { return JSON.parse(readFileSync(abs, 'utf8')) as unknown; } catch (err) { throw new DriveError(`cannot assemble ${step.collective}: member output ${rel}${role ? ` (${role})` : ''} is not valid JSON: ${(err as Error).message}`); }
        });
        const abs = join(ctx.runDir, step.collective);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, `${JSON.stringify(parts, null, 2)}\n`, 'utf8');
        try { runRun({ run: ctx.runId, event: 'artifact_created', artifact: step.collective, fields: [`step_execution_id=${stepExecutionId}`], repoRoot: ctx.repoRoot, now: ctx.now }); } catch (err) { if (err instanceof RunError) throw new DriveError(err.message); throw err; }
        ctx.act(`assembled collective ${step.collective}`);
      }
    }
    return null;
  }

  // Parallel path (parallel >1): admit members in canonical order, interleaving
  // durable host requests in the same canonical order. A preflight refusal
  // stops further admission; inflight command siblings run to receipt. Host
  // requests that appear after a refused command are never created, preserving
  // the serial durability invariant.
  //
  // Members overlap because each runs in its own worktree and merges back at
  // collection. Concurrency used to be bought by routes declaring
  // `write_access: false` — the permissions cut removed that declaration, and
  // with it the speedup, because the two were one mechanism. Separate
  // worktrees buy it back as a FACT rather than as a claim nothing verified,
  // and the guarantee is now stronger than the one it replaces: a reviewer on
  // a bare `claude -p` used to be free to write the shared tree unleased,
  // precisely because it had declared itself a reader.
  //
  // Where git cannot cut a worktree there is nothing to isolate into, every
  // member takes the repo-wide writer lease, and they serialize. Said out loud
  // rather than accepting a concurrency request that will not be honoured.
  // See docs/experimental/permissions-and-isolation.md.
  if (!repoHasGit(ctx.repoRoot)) {
    ctx.act(
      `NOTE: --parallel ${ctx.parallel} serializes command members here. Concurrency comes from running ` +
        'each member in its own git worktree, and this directory is not a git repository, so every member ' +
        'runs in the shared tree and takes the repo-wide writer lease. Host requests still interleave.',
    );
  }
  type PendingQueueEntry = { role: string | null; outputRel: string; ids: { stepExecutionId: string; actorCallId: string }; kind: 'host_pending'; pending: HostDispatchRequest } | { role: string | null; outputRel: string; ids: { stepExecutionId: string; actorCallId: string }; kind: 'host'; } | { role: string | null; outputRel: string; artifactType: string | null; ids: { stepExecutionId: string; actorCallId: string }; kind: 'command'; };
  const queue: PendingQueueEntry[] = [];
  const hostRequests: HostDispatchRequest[] = [];
  const hostNotes: string[] = [];
  for (let i = 0; i < actors.length; i += 1) {
    const role = actors[i];
    const outputRel = outputs[i]!;
    events = freshEvents(ctx.runDir);
    if (artifactRecorded(events, outputRel)) continue;
    const actorCallId = role ? `ac-${stepId}-g${generation}-${role}` : `ac-${stepId}-g${generation}`;
    const ids = { stepExecutionId, actorCallId };
    events = freshEvents(ctx.runDir);
    const pendingDispatch = pendingHostRequest(events, actorCallId, ctx.runId);
    if (pendingDispatch != null) {
      queue.push({ role, outputRel, ids, kind: 'host_pending', pending: pendingDispatch });
      continue;
    }
    // Binding determines host vs command; let DriveError propagate to preserve true error.
    const binding = effectiveBinding(ctx, role);
    if (binding.spec.adapter === 'host') {
      queue.push({ role, outputRel, ids, kind: 'host' });
    } else {
      queue.push({ role, outputRel, artifactType: step.artifact_type, ids, kind: 'command' });
    }
  }

  // Fast path when there are no hosts: reuse bounded wave primitive (already handles concurrency, lease, repair).
  const hasHosts = queue.some((e) => e.kind !== 'command');
  if (!hasHosts) {
    const commandMembersInOrder: WaveMember[] = queue.filter((e) => e.kind === 'command').map((e) => {
      const ce = e as Extract<PendingQueueEntry, { kind: 'command' }>;
      return { role: ce.role, outputRel: ce.outputRel, artifactType: ce.artifactType, ids: ce.ids, reason: 'initial', repairErrors: null, conflict: null, stamps: {}, generation, inBody: step.loop.in_body, stepId };
    });
    if (commandMembersInOrder.length > 0) {
      const waveResult = runCommandWave(ctx, stepId, generation, step.loop.in_body, commandMembersInOrder, ctx.parallel);
      // Follow-up waves until none is queued. Bounded by construction: each
      // actor call gets at most one schema repair (`ctx.repaired`) and
      // MAX_MERGE_CONFLICT_ROUNDS conflict rounds (`ctx.conflictRounds`), and
      // an outcome past either budget is a failure, not a follow-up.
      let queued = waveResult.repairQueued;
      while (queued.length > 0) {
        const next = runCommandWave(ctx, stepId, generation, step.loop.in_body, queued, ctx.parallel);
        waveResult.failure = waveResult.failure ?? next.failure;
        queued = next.repairQueued;
      }
      if (waveResult.failure != null) {
        const f = waveResult.failure;
        if (f.kind === 'write_conflict' || f.kind === 'eligibility_forbidden' || f.kind === 'provider_conflict' || f.kind === 'constraint_refused') {
          return { kind: f.kind, detail: (f as { detail: string }).detail } as PromptableOutcome;
        }
        if (f.kind === 'invalid_output') return { kind: 'invalid_output', detail: (f as { detail: string }).detail, errors: (f as { detail: string; errors: string[] }).errors } as unknown as PromptableOutcome;
        if (f.kind === 'valid') return null;
        return { kind: 'exit_nonzero', detail: (f as { detail: string }).detail } as unknown as PromptableOutcome;
      }
    }
    if (step.collective != null) {
      events = freshEvents(ctx.runDir);
      if (!artifactRecorded(events, step.collective)) {
        const parts = actors.map((role, i) => {
          const rel = outputs[i]!;
          const abs = join(ctx.runDir, rel);
          try { return JSON.parse(readFileSync(abs, 'utf8')) as unknown; } catch (err) { throw new DriveError(`cannot assemble ${step.collective}: member output ${rel}${role ? ` (${role})` : ''} is not valid JSON: ${(err as Error).message}`); }
        });
        const abs = join(ctx.runDir, step.collective);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, `${JSON.stringify(parts, null, 2)}\n`, 'utf8');
        try { runRun({ run: ctx.runId, event: 'artifact_created', artifact: step.collective, fields: [`step_execution_id=${stepExecutionId}`], repoRoot: ctx.repoRoot, now: ctx.now }); } catch (err) { if (err instanceof RunError) throw new DriveError(err.message); throw err; }
        ctx.act(`assembled collective ${step.collective}`);
      }
    }
    return null;
  }

  // Mixed host/command path: schedule in canonical order with concurrent command lanes.
  // We reuse the same wave admission/collection logic but inline host dispatch in canonical position.
  const mixedQueue: PendingQueueEntry[] = [...queue];
  const inflight: PendingAttempt[] = [];
  let failure: DispatchOutcome | null = null;
  const repairQueued: WaveMember[] = [];
  let stopAdmitting = false;

  const drainInflightOnThrow = () => {
    while (inflight.length > 0) {
      try {
        const hp = inflight[0]!;
        const out = collectCommandAttempt(ctx, hp);
        inflight.shift();
        const follow = followUpMember(ctx, out, hp);
        if (follow != null) repairQueued.push(follow);
        else if (out.kind !== 'valid' && failure == null) {
          failure = out;
        }
      } catch { try { inflight.shift(); } catch {} }
    }
  };

  try {
    while (mixedQueue.length > 0 || inflight.length > 0) {
      // Admit as many as parallel allows, in canonical order, hosts do not count toward the cap.
      while (!stopAdmitting && mixedQueue.length > 0) {
        const head = mixedQueue[0]!;
        if (head.kind === 'host_pending') {
          const note = pendingResolutionNote(ctx, stepId, head.role, head.pending);
          if (note != null) { hostNotes.push(note); ctx.act(note); }
          hostRequests.push(head.pending);
          mixedQueue.shift();
          continue;
        }
        if (head.kind === 'host') {
          // Fresh host: create durable request now, in canonical order.
          events = freshEvents(ctx.runDir);
          const binding = effectiveBinding(ctx, head.role);
          const priorHostAttempts = hostRequestAttempts(events, head.ids.actorCallId);
          const attempt = priorHostAttempts + 1;
          const priorHostRequest = events.filter((e) => e.type === 'host_dispatch_requested' && e.extra.actor_call_id === head.ids.actorCallId).at(-1);
          const priorHostTerminal = priorHostRequest == null ? null : events.findLast((e) => (e.type === 'actor_completed' || e.type === 'actor_failed') && e.extra.dispatch_id === priorHostRequest.extra.dispatch_id);
          const reason = priorHostAttempts === 0 ? 'initial' : priorHostTerminal?.type === 'actor_completed' && priorHostTerminal.extra.output_valid === false ? 'schema_repair' : binding.executor !== priorHostRequest?.extra.executor ? 'executor_override' : 'user_retry';
          const repairErrors = reason === 'schema_repair' && priorHostTerminal != null && Array.isArray(priorHostTerminal.extra.validation_errors) ? priorHostTerminal.extra.validation_errors.filter((e): e is string => typeof e === 'string') : null;
          const promptRes = (() => {
            try { return runPrompt({ run: ctx.runId, step: stepId, actor: head.role ?? undefined, iteration: step.loop.in_body ? generation : undefined, record: true, repoRoot: ctx.repoRoot, now: ctx.now }); } catch (err) { if (err instanceof PromptError) throw new DriveError(err.message); throw err; }
          })();
          hostRequests.push(hostRequestFor(ctx, stepId, head.role, head.outputRel, step.artifact_type, head.ids, attempt, reason, promptRes.promptPath, promptRes.sha256, repairErrors));
          mixedQueue.shift();
          continue;
        }
        // Command head
        const binding = effectiveBinding(ctx, head.role);
        const needsLease = true;
        if (needsLease && inflight.some((p) => p.leaseHolder != null)) break;
        if (needsLease) {
          const effectiveLease = (() => { try { return readEffectiveLease(ctx.repoRoot); } catch { return null; } })();
          // Any live lease here is by construction foreign: the wave enforces at-most-one live writer via the inflight check above.
          if (effectiveLease != null && isWorkspaceLeaseAlive(effectiveLease)) {
            throw new DriveError(`shared workspace is already held by ${effectiveLease.holder.kind} "${effectiveLease.holder.id}" (supervisor_pid ${effectiveLease.supervisor_pid ?? 'unknown'}, started ${effectiveLease.started_at}); holder "${ctx.runId}" must wait or retry. Inspect it with \`fadeno show ${effectiveLease.holder.runId ?? '<run>'}\`; recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`);
          }
        }
        if (inflight.length >= ctx.parallel) break;
        const preflight = evaluateMemberPreflight(ctx, stepId, head.role, binding);
        if (!preflight.ok) {
          events = freshEvents(ctx.runDir);
          appendEvent(ctx.runDir, { type: 'actor_failed', step: stepId, actor: head.role, step_execution_id: head.ids.stepExecutionId, actor_call_id: head.ids.actorCallId, attempt: priorAttempts(events, head.ids.actorCallId).count + 1, executor: preflight.executor, archetype: preflight.archetype, reason: preflight.reason, error: preflight.error }, ctx.now);
          ctx.act(`dispatch refused ${stepId}${head.role ? ` (${head.role})` : ''}: ${preflight.error}`);
          if (failure == null) failure = preflight.outcome;
          mixedQueue.shift();
          stopAdmitting = true;
          break;
        }
        const priorAttemptsInfo = priorAttempts(freshEvents(ctx.runDir), head.ids.actorCallId);
        const attempt = priorAttemptsInfo.count + 1;
        // Fresh admissions here are never schema_repair: mixed-path repairs go through
        // the post-wave runCommandWave below, which carries the real repairErrors.
        let reason = 'initial';
        if (priorAttemptsInfo.count > 0) {
          const { executor } = effectiveBinding(ctx, head.role);
          reason = executor !== priorAttemptsInfo.lastExecutor ? 'executor_override' : 'user_retry';
        }
        const pending = beginCommandAttempt(ctx, stepId, head.role, generation, step.loop.in_body, head.outputRel, step.artifact_type, head.ids, attempt, reason, null, { providerWarned: preflight.providerWarned, shadowOnly: preflight.shadowOnly });
        mixedQueue.shift();
        inflight.push(pending);
      }
      if (inflight.length > 0) {
        const hp = inflight[0]!;
        const outcome = collectCommandAttempt(ctx, hp);
        inflight.shift();
        const follow = followUpMember(ctx, outcome, hp);
        if (follow != null) repairQueued.push(follow);
        else if (outcome.kind !== 'valid' && failure == null) {
          failure = outcome;
        }
      } else if (mixedQueue.length === 0) {
        break;
      } else {
        if (stopAdmitting) break;
        sleepSync(POLL_MS);
      }
    }
  } catch (err) {
    drainInflightOnThrow();
    throw err;
  }

  // Bounded repair wave for invalid outputs (hosts never need repair). Align with no-host
  // path: run the repair wave even when a sibling command already failed, so each
  // invalid member gets its bounded retry regardless of sibling status.
  // Follow-up waves until none is queued; bounded by the per-call repair and
  // conflict-round budgets, exactly as on the no-host path.
  let queued = repairQueued;
  while (queued.length > 0) {
    const next = runCommandWave(ctx, stepId, generation, step.loop.in_body, queued, ctx.parallel);
    failure = failure ?? next.failure;
    queued = next.repairQueued;
  }

  if (failure != null && hostRequests.length > 0) {
    const failureDetail = (failure as { detail: string }).detail;
    hostNotes.push(`command member failed: ${failureDetail} — host dispatch still required`);
    return { kind: 'awaiting_host_dispatch', requests: hostRequests, notes: hostNotes };
  }

  if (failure != null) {
    if (failure.kind === 'write_conflict' || failure.kind === 'eligibility_forbidden' || failure.kind === 'provider_conflict' || failure.kind === 'constraint_refused') {
      return { kind: failure.kind, detail: (failure as { detail: string }).detail } as PromptableOutcome;
    }
    if (failure.kind === 'invalid_output') return { kind: 'invalid_output', detail: (failure as { detail: string }).detail, errors: (failure as { detail: string; errors: string[] }).errors } as unknown as PromptableOutcome;
    if (failure.kind === 'valid') { /* fall through */ } else {
      return { kind: 'exit_nonzero', detail: (failure as { detail: string }).detail } as unknown as PromptableOutcome;
    }
  }

  if (hostRequests.length > 0) {
    return { kind: 'awaiting_host_dispatch', requests: hostRequests, notes: hostNotes };
  }

  if (step.collective != null) {
    events = freshEvents(ctx.runDir);
    if (!artifactRecorded(events, step.collective)) {
      const parts = actors.map((role, i) => {
        const rel = outputs[i]!;
        const abs = join(ctx.runDir, rel);
        try { return JSON.parse(readFileSync(abs, 'utf8')) as unknown; } catch (err) { throw new DriveError(`cannot assemble ${step.collective}: member output ${rel}${role ? ` (${role})` : ''} is not valid JSON: ${(err as Error).message}`); }
      });
      const abs = join(ctx.runDir, step.collective);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(parts, null, 2)}\n`, 'utf8');
      try { runRun({ run: ctx.runId, event: 'artifact_created', artifact: step.collective, fields: [`step_execution_id=${stepExecutionId}`], repoRoot: ctx.repoRoot, now: ctx.now }); } catch (err) { if (err instanceof RunError) throw new DriveError(err.message); throw err; }
      ctx.act(`assembled collective ${step.collective}`);
    }
  }
  return null;
}

function recoverInterruptedToolDispatches(ctx: EngineCtx): number {
  const recovered = recoverInterruptedToolDispatchesShared(ctx.repoRoot, ctx.runDir, ctx.runId, ctx.now, (msg) => new DriveError(msg));
  if (recovered > 0) ctx.act(`recovered ${recovered} interrupted tool dispatch receipt(s)`);
  return recovered;
}

function driveTool(ctx: EngineCtx, step: import('../lib/flow-cursor.ts').NextStepInfo): { kind: 'executor_failed'; detail: string } | 'needs_decision' | null {
  const toolName = step.tool;
  if (toolName == null || toolName.length === 0) return 'needs_decision';
  // No artifact-type gate any more. Every registered tool step is executable:
  // a `test-result` step synthesizes its artifact from the exit status, and
  // every other one captures stdout. See `ToolCaptureMode`. A step whose tool
  // is not registered still falls through to `needs_decision` below — that is
  // a missing declaration, not an unsupported shape.
  const spec = (ctx.profile as any).tools?.[toolName];
  if (spec == null) return 'needs_decision';
  const outputRel = step.outputs?.[0];
  if (outputRel == null) return 'needs_decision';
  const generation = parseGeneration(outputRel).generation;
  const loopOwner = step.loop.in_body ? bodyOwnerOf(ctx.playbook, step.id) : null;
  const effectiveTimeoutMs = (() => {
    if (ctx.timeoutMs !== undefined && ctx.timeoutMs !== null) {
      if (ctx.timeoutMs === 0) return null;
      if (typeof ctx.timeoutMs === 'number' && ctx.timeoutMs > 0) return ctx.timeoutMs;
      return null;
    }
    if (spec.timeoutMs != null && spec.timeoutMs > 0) return spec.timeoutMs;
    return null;
  })();
  try {
    const result = executeToolCore({
      repoRoot: ctx.repoRoot,
      runId: ctx.runId,
      runDir: ctx.runDir,
      stepId: step.id,
      stepKind: step.kind,
      toolName,
      artifactType: step.artifact_type,
      outputRel,
      generation,
      loopOwner,
      iteration: step.loop.iteration,
      command: spec.command,
      effectiveTimeoutMs: effectiveTimeoutMs ?? null,
      now: ctx.now,
    });
    ctx.act(`tool ${toolName} → ${result.status} (exit ${result.exitCode}) → wrote ${outputRel}`);
    return null;
  } catch (err) {
    if (err instanceof ToolExecError) {
      // Infra failure is retryable executor_failed, and so is the refusal a
      // live attempt earns from locked admission — recovery no longer raises
      // that one, so every tool refusal arrives on this single path.
      return { kind: 'executor_failed', detail: err.message };
    }
    throw err;
  }
}

function driveGate(ctx: EngineCtx, comp: NextComputation): void {
  const step = comp.step!;
  const gate = comp.gate!;
  if (!SUPPORTED_CONDITIONS.includes(gate.condition as GateCondition)) {
    throw new DriveError(
      `gate condition "${gate.condition}" has no deterministic evaluator; ` +
        'the engine cannot advance past it (drive the run manually or add the evaluator).',
    );
  }

  const events = freshEvents(ctx.runDir);
  if (!stepStartedInScope(events, step.id, 0) || step.kind === 'loop') {
    try {
      runRun({ run: ctx.runId, step: step.id, repoRoot: ctx.repoRoot, now: ctx.now });
    } catch (err) {
      if (err instanceof RunError) throw new DriveError(err.message);
      throw err;
    }
  }

  let result;
  try {
    result = runGate({
      run: ctx.runId,
      condition: gate.condition,
      artifact: gate.artifact,
      repoRoot: ctx.repoRoot,
      now: ctx.now,
    });
  } catch (err) {
    if (err instanceof GateError) throw new DriveError(err.message);
    throw err;
  }
  ctx.act(`gate ${gate.condition} → ${result.result}  (${gate.artifact})`);

  if (step.kind === 'loop') {
    appendEvent(
      ctx.runDir,
      {
        type: 'loop_condition_evaluated',
        step: step.id,
        condition: gate.condition,
        result: result.result,
        artifact: gate.artifact,
      },
      ctx.now,
    );
  }
}

/** Persist (or reuse) the durable named decision for a blocked human gate. */
function ensureDecisionRequested(ctx: EngineCtx, comp: NextComputation): DriveDecision {
  const stepId = comp.step!.id;
  const prompt = comp.human_gate?.prompt ?? '(no prompt declared)';
  const options = ['approve', 'reject'];

  const events = freshEvents(ctx.runDir);
  const requests = events.filter(
    (e) => e.type === 'decision_requested' && e.step === stepId && typeof e.extra.decision_id === 'string',
  );
  const resolvedIds = new Set(
    events
      .filter((e) => e.type === 'decision_resolved' && typeof e.extra.decision_id === 'string')
      .map((e) => e.extra.decision_id as string),
  );
  const pending = requests.filter((e) => !resolvedIds.has(e.extra.decision_id as string)).at(-1);
  if (pending != null) {
    const opts = Array.isArray(pending.extra.options)
      ? pending.extra.options.filter((o): o is string => typeof o === 'string')
      : options;
    return {
      decisionId: pending.extra.decision_id as string,
      step: stepId,
      prompt: typeof pending.extra.prompt === 'string' ? pending.extra.prompt : prompt,
      options: opts,
    };
  }

  const decisionId = `dec-${stepId}-${requests.length + 1}`;
  appendEvent(
    ctx.runDir,
    { type: 'decision_requested', step: stepId, decision_id: decisionId, kind: 'human_gate', prompt, options },
    ctx.now,
  );
  ctx.act(`decision requested: ${decisionId} — ${prompt}`);
  return { decisionId, step: stepId, prompt, options };
}

interface CompositePromptPlan {
  prompt: string;
  promptPath: string;
  promptSha256: string;
  outputPath: string;
  artifactType: SchemaKind | null;
  logicalArtifact: string;
}

function compositeStep(ctx: EngineCtx, stepId: string): PlaybookStep {
  const flow = Array.isArray(ctx.playbook.flow) ? ctx.playbook.flow as PlaybookStep[] : [];
  const step = flow.find((candidate) => candidate.id === stepId);
  if (step == null) throw new DriveError(`compositional step "${stepId}" is missing.`);
  return step;
}

function compositeOutputPlan(ctx: EngineCtx, action: Extract<CompositeAction, { kind: 'actor' }>): {
  outputPath: string;
  artifactType: SchemaKind | null;
  logicalArtifact: string;
} {
  const step = compositeStep(ctx, action.step);
  const declared = typeof step.output === 'string' ? step.output : '';
  const logicalArtifact = baseArtifactName(declared);
  if (logicalArtifact === '') throw new DriveError(`compositional actor step "${action.step}" requires output.`);
  const artifactType = schemaKindFor(logicalArtifact);
  const stem = logicalArtifact.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const extension = artifactType == null ? '.md' : '.json';
  return {
    outputPath: `${nodeInstanceArtifactScope(action.instance.id)}/${stem}${extension}`,
    artifactType,
    logicalArtifact,
  };
}

function latestCompositeInputs(ctx: EngineCtx, action: Extract<CompositeAction, { kind: 'actor' }>): Array<{
  logical: string;
  path: string;
  sha256: string | null;
}> {
  const step = compositeStep(ctx, action.step);
  const wanted = Array.isArray(step.input)
    ? step.input.filter((item): item is string => typeof item === 'string').map((ref) => ({
        logical: baseArtifactName(ref),
        collection: ref.endsWith('[]'),
      }))
    : [];
  const instance = parseNodeInstanceId(action.instance.id);
  const events = freshEvents(ctx.runDir);
  return wanted.flatMap(({ logical, collection }) => {
    const candidates = events.filter((event) => {
      if (event.type !== 'artifact_created' || event.extra.logical_artifact !== logical) return false;
      if (typeof event.extra.artifact !== 'string') return false;
      if (instance.member != null && event.extra.map_member !== instance.member) return false;
      return true;
    });
    const selected = collection
      ? [...new Map(candidates.map((event) => [String(event.extra.map_member ?? event.extra.member ?? event.extra.node_instance_id ?? event.extra.artifact), event])).values()]
      : candidates.slice(-1);
    return selected.map((event) => ({
      logical,
      path: event.extra.artifact as string,
      sha256: typeof event.extra.sha256 === 'string' ? event.extra.sha256 : null,
    }));
  });
}

function assembleCompositePrompt(
  ctx: EngineCtx,
  action: Extract<CompositeAction, { kind: 'actor' }>,
  ids: { stepExecutionId: string; actorCallId: string },
): CompositePromptPlan {
  const plan = compositeOutputPlan(ctx, action);
  const roles = ctx.playbook.roles && typeof ctx.playbook.roles === 'object' && !Array.isArray(ctx.playbook.roles)
    ? ctx.playbook.roles as Record<string, unknown>
    : {};
  const role = roles[action.actor];
  const purpose = role && typeof role === 'object' && !Array.isArray(role) && typeof (role as Record<string, unknown>).purpose === 'string'
    ? (role as Record<string, unknown>).purpose as string
    : '';
  const inputs = latestCompositeInputs(ctx, action);
  const progressPath = `.fadeno/progress/${ctx.runId}/${ids.stepExecutionId}.json`;
  const lines = [
    '# Fadeno assignment',
    '',
    `- run: ${ctx.runId}`,
    `- node instance: ${action.instance.id}`,
    `- role: ${action.actor}`,
    `- task: ${ctx.task}`,
    ...(purpose === '' ? [] : [`- role purpose: ${purpose}`]),
    '',
    '## Inputs',
    ...(inputs.length === 0
      ? ['- No upstream artifact files are bound. Use the repository and task statement.']
      : inputs.map((input) => `- ${input.logical}: ${input.path}${input.sha256 == null ? '' : ` (sha256 ${input.sha256})`}`)),
    '',
    '## Output contract',
    `Return only the ${plan.logicalArtifact} artifact body. Do not wrap it in a code fence.`,
    plan.artifactType == null
      ? '- Format: Markdown.'
      : `- Format: JSON satisfying .fadeno/schemas/${plan.artifactType}.schema.json.`,
    `- The director records it at ${plan.outputPath}.`,
    `- That artifact path is relative to run directory .fadeno/runs/${ctx.runId}/, not the repository root.`,
    '',
    '## Cooperative progress',
    `Update repository-root-relative ${progressPath} at meaningful phases using the Fadeno progress JSON shape.`,
    'Progress is attested observability only and never controls a gate. Do not include secrets or private reasoning.',
    '',
  ];
  const prompt = lines.join('\n');
  const promptSha256 = sha256Hex(prompt);
  const promptPath = `artifacts/prompts/${ids.actorCallId}.md`;
  const promptAbs = join(ctx.runDir, promptPath);
  if (existsSync(promptAbs)) {
    if (readFileSync(promptAbs, 'utf8') !== prompt) {
      throw new DriveError(`existing composite prompt ${promptPath} differs; refusing to overwrite.`);
    }
  } else {
    mkdirSync(dirname(promptAbs), { recursive: true });
    writeFileSync(promptAbs, prompt, 'utf8');
    appendEvent(ctx.runDir, {
      type: 'prompt_assembled',
      step: action.step,
      actor: action.actor,
      node_instance_id: action.instance.id,
      parent_instance_id: action.instance.parentId,
      inputs: inputs.map((input) => ({ artifact: input.logical, path: input.path, sha256: input.sha256 })),
      output_path: plan.outputPath,
      prompt_sha256: promptSha256,
      prompt_path: promptPath,
      manifest_version: 1,
    }, ctx.now);
  }
  return { prompt, promptPath, promptSha256, ...plan };
}

function compositeRequest(
  ctx: EngineCtx,
  action: Extract<CompositeAction, { kind: 'actor' }>,
): HostDispatchRequest {
  const stepExecutionId = stepExecutionIdFor(action.instance.id);
  const actorCallId = actorCallIdFor(action.instance.id, action.actor);
  const ids = { stepExecutionId, actorCallId };
  const events = freshEvents(ctx.runDir);
  const pending = pendingHostRequest(events, actorCallId, ctx.runId);
  if (pending != null) return pending;
  const binding = effectiveBinding(ctx, action.actor);
  if (binding.spec.adapter !== 'host') {
    throw new DriveError(
      `compositional execution currently requires a host adapter; role "${action.actor}" is bound to command executor "${binding.executor}".`,
    );
  }
  if (!events.some((event) => event.type === 'step_started' && event.extra.node_instance_id === action.instance.id)) {
    appendEvent(ctx.runDir, {
      type: 'step_started',
      step: action.step,
      node_instance_id: action.instance.id,
      parent_instance_id: action.instance.parentId,
      map_member: action.instance.member,
      generation: action.instance.generation,
    }, ctx.now);
  }
  const prompt = assembleCompositePrompt(ctx, action, ids);
  const priorRequests = events.filter(
    (event) => event.type === 'host_dispatch_requested' && event.extra.actor_call_id === actorCallId,
  );
  const priorTerminal = events.findLast(
    (event) => (event.type === 'actor_completed' || event.type === 'actor_failed') && event.extra.actor_call_id === actorCallId,
  );
  const validationErrors = priorTerminal?.type === 'actor_completed' && priorTerminal.extra.output_valid === false && Array.isArray(priorTerminal.extra.validation_errors)
    ? priorTerminal.extra.validation_errors.filter((item): item is string => typeof item === 'string')
    : null;
  const attempt = priorRequests.length + 1;
  const reason = attempt === 1 ? 'initial' : validationErrors != null ? 'schema_repair' : 'user_retry';
  return hostRequestFor(
    ctx,
    action.step,
    action.actor,
    prompt.outputPath,
    prompt.artifactType,
    ids,
    attempt,
    reason,
    prompt.promptPath,
    prompt.promptSha256,
    validationErrors,
    {
      nodeInstanceId: action.instance.id,
      parentInstanceId: action.instance.parentId ?? undefined,
      mapMember: action.instance.member ?? undefined,
      generation: action.instance.generation ?? undefined,
      logicalArtifact: prompt.logicalArtifact,
    },
  );
}

function compositeGateArtifacts(ctx: EngineCtx, action: Extract<CompositeAction, { kind: 'evaluate_loop' }>): string[] {
  const logical = baseArtifactName(action.input);
  return freshEvents(ctx.runDir).flatMap((event) =>
    event.type === 'artifact_created' &&
    event.extra.logical_artifact === logical &&
    typeof event.extra.node_instance_id === 'string' &&
    event.extra.node_instance_id.startsWith(`${action.instance.id}/`) &&
    typeof event.extra.artifact === 'string'
      ? [event.extra.artifact]
      : [],
  );
}

function evaluateCompositeLoop(ctx: EngineCtx, action: Extract<CompositeAction, { kind: 'evaluate_loop' }>): void {
  if (!SUPPORTED_CONDITIONS.includes(action.condition as GateCondition)) {
    throw new DriveError(`unsupported compositional loop condition "${action.condition}".`);
  }
  const condition = action.condition as GateCondition;
  const paths = compositeGateArtifacts(ctx, action);
  if (paths.length === 0) throw new DriveError(`loop ${action.instance.id} has no scoped ${action.input} artifact.`);
  const documents = paths.map((path) => JSON.parse(readFileSync(join(ctx.runDir, path), 'utf8')) as unknown);
  const document = action.input.endsWith('[]') ? documents : documents.at(-1);
  const definition = CONDITION_REGISTRY[condition];
  const validate = ctx.schemas.get(definition.schema);
  const values = Array.isArray(document) && action.input.endsWith('[]') ? document : [document];
  for (const value of values) {
    if (!validate(value)) throw new DriveError(`scoped artifact for ${action.instance.id} is invalid for ${condition}.`);
  }
  const evaluation = definition.evaluate(document);
  appendEvent(ctx.runDir, {
    type: 'loop_condition_evaluated',
    step: action.step,
    node_instance_id: action.instance.id,
    parent_instance_id: action.instance.parentId,
    generation: action.instance.generation,
    condition,
    artifacts: paths,
    result: evaluation.pass ? 'pass' : 'fail',
    details: evaluation.details,
  }, ctx.now);
  ctx.act(`loop ${action.instance.id}: ${condition} → ${evaluation.pass ? 'pass' : 'fail'}`);
}

function driveComposite(ctx: EngineCtx, maxTransitions: number, actions: string[]): DriveResult {
  let transitions = 0;
  const finish = (
    outcome: DriveOutcome,
    detail: string,
    status: string | null = null,
    requests: HostDispatchRequest[] = [],
  ): DriveResult => ({
    run: ctx.runId,
    outcome,
    status,
    decision: null,
    detail,
    actions,
    transitions,
    requests,
    unresolvedRequests: requests,
  });

  for (;;) {
    if (transitions >= maxTransitions) {
      return finish('max_transitions', `stopped after ${maxTransitions} compositional transitions; re-run to continue.`);
    }
    const compositeEvents = freshEvents(ctx.runDir);
    const frontier = computeCompositeFrontier(ctx.playbook, compositeEvents);
    if (frontier.complete || frontier.failed) {
      const status = frontier.failed ? 'failed' : 'completed';
      // Same terminal invariant as the sequential engine: never terminal while
      // any host dispatch is still in requested state.
      const outstanding = unresolvedHostDispatches(compositeEvents, ctx.runId);
      if (outstanding.length > 0) {
        const ids = outstanding.map((request) => request.dispatchId).join(', ');
        const detail =
          `compositional frontier computes terminal (${status}) but ${outstanding.length} host ` +
          `dispatch(es) are still in requested state (${ids}); a run never terminates over an ` +
          'in-flight host dispatch — submit its receipts and re-run drive.';
        ctx.act(detail);
        return finish('awaiting_host_dispatch', detail, null, outstanding);
      }
      runRun({ run: ctx.runId, status, repoRoot: ctx.repoRoot, now: ctx.now });
      ctx.act(`run ${status}`);
      return finish('terminal', `compositional run is terminal (${status}).`, status);
    }
    if (frontier.actions.length === 0) {
      return finish('needs_decision', 'compositional frontier has no runnable action and is not terminal.');
    }

    const requests: HostDispatchRequest[] = [];
    let advanced = false;
    for (const action of frontier.actions) {
      if (transitions >= maxTransitions) break;
      transitions += 1;
      if (action.kind === 'start_loop') {
        appendEvent(ctx.runDir, {
          type: 'loop_iteration_started',
          step: action.step,
          node_instance_id: action.instance.id,
          parent_instance_id: action.instance.parentId,
          member: action.instance.member,
          generation: action.generation,
          iteration: action.generation,
        }, ctx.now);
        ctx.act(`loop ${action.instance.id}: generation ${action.generation} started`);
        advanced = true;
        continue;
      }
      if (action.kind === 'evaluate_loop') {
        evaluateCompositeLoop(ctx, action);
        advanced = true;
        continue;
      }
      if (action.kind === 'actor') {
        requests.push(compositeRequest(ctx, action));
        continue;
      }
      if (action.kind === 'human_gate') {
        return finish(
          'needs_decision',
          `member-scoped human gate ${action.instance.id} is awaiting host integration: ${action.prompt}`,
        );
      }
      return finish(
        'needs_decision',
        `node ${action.instance.id} (kind ${action.stepKind}) is not executable in the first compositional milestone.`,
      );
    }
    if (requests.length > 0) {
      return finish(
        'awaiting_host_dispatch',
        `${requests.length} compositional host dispatch request(s) are awaiting host receipts.`,
        null,
        requests,
      );
    }
    if (!advanced) return finish('needs_decision', 'compositional frontier did not advance.');
  }
}

/**
 * Advance a run until it is terminal, pauses on a human decision, or hits
 * something the engine cannot resolve. Deterministic: every consequential
 * effect is an event, an artifact, or a run.yaml update via existing writers.
 */
interface OpenedEngine {
  ctx: EngineCtx;
  run: ReturnType<typeof resolveRun>;
  actions: string[];
  bindMapEarly: Map<string, string>;
}

/**
 * Resolve a run and build the engine context for it — the ledger, the
 * playbook and schemas, the executor profile snapshot, the dial layers.
 * `runDrive` and `runAttemptAccept` open the engine the same way, so an
 * acceptance validates an attempt's output with the same schemas and
 * resolves its bindings against the same snapshot the drive did.
 */
function openEngine(opts: DriveOptions, repoRoot: string): OpenedEngine {
  let run;
  try {
    run = resolveRun(repoRoot, opts.run);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new DriveError(err.message);
    throw err;
  }
  if (run.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new DriveError(
      run.schemaVersion == null
        ? `run "${run.runId}" is a legacy ledger (run.yaml has no schema_version); ` +
          'the engine drives only current-format ledgers. Create a new run with `fadeno new-run`.'
        : `run "${run.runId}" has ledger schema_version "${run.schemaVersion}"; ` +
          `this fadeno drives "${RUN_LEDGER_SCHEMA_VERSION}".`,
    );
  }
  if (run.playbook == null) {
    throw new DriveError(`run "${run.runId}" has no playbook recorded in run.yaml.`);
  }

  const actions: string[] = [];
  const act = (line: string): void => {
    actions.push(line);
    opts.onAction?.(line);
  };

  const schemaPaths = runSchemaDirectories(run.dir, repoRoot);
  const schemas = new SchemaSet(schemaPaths.snapshot, schemaPaths.project, schemaPaths.builtin);
  const playbook = loadValidatedPlaybook(run.dir, repoRoot, run.playbook, schemas);

  // Resolve harness once — same value for profile loading, snapshot compilation, and constraint lookup.
  // A resumed run keeps its recorded snapshot; only first-snapshot compilation uses this live harness.
  const harness = activeHarness(undefined, opts.userPathOptions);
  // Parse --bind refs early for snapshot extraRefs
  const bindMapEarly = parseBinds(opts.bind);
  const bindRefsForSnapshot: DialRef[] = [];
  for (const v of bindMapEarly.values()) {
    try { bindRefsForSnapshot.push(parseDialRef(v, 'bind')); } catch {}
  }
  const parallel = parseParallelOption(opts.parallel);
  const base: Omit<EngineCtx, 'profile' | 'dialLayers' | 'worktreeCarry'> = {
    runId: run.runId,
    runDir: run.dir,
    repoRoot,
    userPathOptions: opts.userPathOptions,
    harness,
    playbook,
    task: run.task ?? '',
    schemas,
    overrides: new Map<string, string>(),
    repaired: new Set<string>(),
    conflictRounds: new Map<string, number>(),
    diagnostics: opts.diagnostics,
    timeoutMs: opts.timeoutMs,
    parallel,
    now: opts.now,
    act,
  };
  const profile = ensureProfileSnapshot(base, bindRefsForSnapshot);
  let dialLayers: DialLayers;
  try {
    const state = readLocalDialState(repoRoot);
    if (state.legacyNote != null) act(state.legacyNote);
    const userRaw = readUserDials(opts.userPathOptions ?? {});
    const user: Record<string, DialRef> = {};
    for (const [k, v] of Object.entries(userRaw)) user[k] = v as DialRef;
    let liveRepo: Record<string, DialRef> = {};
    try {
      const live = loadExecutorProfile(repoRoot, opts.userPathOptions, harness).profile;
      liveRepo = { ...live.dials };
    } catch {}
    dialLayers = { session: state.dials, repo: liveRepo, user };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
  // Read off the live profile, not the snapshot: a missing or unreadable
  // profile means no declared carry, which is the same answer an empty
  // declaration gives. Never a reason to fail a run.
  const worktreeCarry: readonly string[] = (() => {
    try { return loadExecutorProfile(repoRoot, opts.userPathOptions, harness).profile.worktreeCarry; } catch { return []; }
  })();
  const ctx: EngineCtx = {
    ...base,
    profile,
    worktreeCarry,
    dialLayers,
  };
  return { ctx, run, actions, bindMapEarly };
}

export function runDrive(opts: DriveOptions): DriveResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);

  const { ctx, run, actions, bindMapEarly } = openEngine(opts, repoRoot);
  // Handle recorded dialLayers for in-flight comparison? Load last snapshot's dials to detect change note (not needed)
  recoverInterruptedCommandDispatches(ctx);
  recoverInterruptedToolDispatches(ctx);
  // Bind overrides: validate and record
  recordOverrides(ctx, bindMapEarly);
  warnDroppedBindings(ctx, bindMapEarly);
  recordResolutionSnapshot(ctx);

  const maxTransitions = opts.maxTransitions ?? MAX_TRANSITIONS_DEFAULT;
  if (hasCompositeContainers(ctx.playbook)) return driveComposite(ctx, maxTransitions, actions);
  let transitions = 0;

  const finish = (
    outcome: DriveOutcome,
    detail: string,
    status: string | null = null,
    decision: DriveDecision | null = null,
    requests: HostDispatchRequest[] = [],
  ): DriveResult => ({
    run: run.runId,
    outcome,
    status,
    decision,
    detail,
    actions,
    transitions,
    requests,
    unresolvedRequests: requests,
  });

  for (;;) {
    if (transitions >= maxTransitions) {
      return finish(
        'max_transitions',
        `stopped after ${maxTransitions} transitions (--max-transitions); re-run to continue.`,
      );
    }
    transitions += 1;

    const events = freshEvents(ctx.runDir);
    let comp: NextComputation;
    try {
      comp = computeNext(ctx.playbook, events);
    } catch (err) {
      if (err instanceof FlowCursorError) throw new DriveError(err.message);
      throw err;
    }

    if (comp.status === 'terminal') {
      const status = comp.terminal?.status ?? 'completed';
      // Terminal invariant: a run never reaches a terminal status while any
      // host dispatch is still in requested state. The engine refuses the
      // transition here so the corrupted "terminal run, pending dispatch"
      // combination is unrepresentable, not merely caught by verify post-hoc.
      const outstanding = unresolvedHostDispatches(events, ctx.runId);
      if (outstanding.length > 0) {
        const ids = outstanding.map((request) => request.dispatchId).join(', ');
        const detail =
          `flow computes terminal (${status}) but ${outstanding.length} host dispatch(es) are still ` +
          `in requested state (${ids}); a run never terminates over an in-flight host dispatch — ` +
          'submit its receipts (dispatch-start, then dispatch-complete or dispatch-fail) and re-run drive.';
        ctx.act(detail);
        return finish('awaiting_host_dispatch', detail, null, null, outstanding);
      }
      const current = parseYaml(readFileSync(join(ctx.runDir, 'run.yaml'), 'utf8')) as {
        status?: unknown;
      };
      if (current.status === 'running') {
        try {
          runRun({ run: ctx.runId, status, repoRoot: ctx.repoRoot, now: ctx.now });
        } catch (err) {
          if (err instanceof RunError) throw new DriveError(err.message);
          throw err;
        }
        ctx.act(`run ${status}`);
      }
      return finish('terminal', `run is terminal (${status}).`, status);
    }

    if (comp.status === 'blocked_human_gate') {
      const decision = ensureDecisionRequested(ctx, comp);
      return finish(
        'paused_human_gate',
        `paused: ${decision.prompt} — resolve with ` +
          `\`fadeno decide ${run.runId} <${decision.options.join('|')}>\` then re-run drive.`,
        null,
        decision,
      );
    }

    if (comp.status === 'needs_decision') {
      return finish('needs_decision', comp.advice);
    }

    // ready
    const step = comp.step!;
    if (step.kind === 'gate' || (step.kind === 'loop' && comp.gate != null)) {
      driveGate(ctx, comp);
      continue;
    }
    if (step.kind === 'tool_call') {
      const toolOutcome = driveTool(ctx, step);
      if (toolOutcome === 'needs_decision') {
        return finish('needs_decision', comp.advice);
      }
      if (toolOutcome != null) {
        return finish('executor_failed', toolOutcome.detail);
      }
      continue;
    }
    if (!step.promptable) {
      return finish(
        'needs_decision',
        `step "${step.id}" (kind ${step.kind}) is not engine-executable in this protocol; ${comp.advice}`,
      );
    }

    const failure = drivePromptable(ctx, comp);
    if (failure != null) {
      if (failure.kind === 'awaiting_host_dispatch') {
        const base = `${failure.requests.length} host dispatch request(s) are awaiting host receipts.`;
        return finish(
          'awaiting_host_dispatch',
          failure.notes.length > 0 ? `${base} ${failure.notes.join(' ')}` : base,
          null,
          null,
          failure.requests,
        );
      }
      // A refused delivery is a failed dispatch like any other, but re-running
      // drive unchanged would refuse identically: the message carries the fixes.
      if (
        failure.kind === 'write_conflict' ||
        failure.kind === 'eligibility_forbidden' ||
        failure.kind === 'provider_conflict' ||
        failure.kind === 'constraint_refused'
      ) {
        return finish('executor_failed', failure.detail);
      }
      if (failure.kind === 'invalid_output') {
        return finish(
          'output_invalid',
          `${failure.detail} after the bounded repair; ` +
            're-run drive to retry, or --bind the role to another executor.',
        );
      }
      return finish(
        'executor_failed',
        `${failure.detail}; the run pauses — re-run drive to retry, or --bind the role to another executor.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// attempt-accept: the human half of the pull-request model
// ---------------------------------------------------------------------------

export interface AttemptAcceptOptions {
  run: string;
  actorCallId: string;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
  userPathOptions?: UserPathOptions;
  onAction?: (line: string) => void;
}

export interface AttemptAcceptResult {
  runId: string;
  actorCallId: string;
  /** The attempt this acceptance recorded (the failed attempt's ordinal + 1). */
  attempt: number;
  /** Run-relative path of the artifact written. */
  output: string;
  mergeBack: MergeBackResult;
  diffBytes: number;
  /** The worktree that was merged and removed. */
  workspace: string;
  actions: string[];
}

/**
 * Accept an attempt whose merge-back failed after the conflict rounds were
 * spent, once a human has resolved the markers in its retained worktree.
 *
 * The engine could not land the work and gave up; nothing about the work
 * itself changed, only who reconciled it. So this records a new attempt with
 * reason `host_resolved` — no executor ran, the request row says `resolved_by:
 * host` and carries no command — and then does exactly what collection would
 * have done had the merge-back been clean: validates the executor's parked
 * report against the step's schema, applies the worktree's diff to the
 * workspace (rebasing first if the tree moved again, under the same window
 * lease), writes the artifact, and receipts `actor_completed` with the
 * merge-back stamp. The next `fadeno drive` sees a completed attempt and
 * moves on; nothing re-runs.
 *
 * Refuses, with nothing applied and the worktree kept, when the markers are
 * still there, when the report fails validation, or when the tree moved in a
 * way that conflicts again — each of which is the human's to fix, not the
 * kernel's to guess at.
 */
export function runAttemptAccept(opts: AttemptAcceptOptions): AttemptAcceptResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { ctx, actions } = openEngine({ run: opts.run, cwd, repoRoot, now: opts.now, userPathOptions: opts.userPathOptions, onAction: opts.onAction }, repoRoot);
  const events = freshEvents(ctx.runDir);
  const callId = opts.actorCallId;
  const terminal = events.findLast((e) => (e.type === 'actor_failed' || e.type === 'actor_completed') && e.extra.actor_call_id === callId);
  if (terminal == null) throw new DriveError(`no attempt of "${callId}" is recorded in run ${ctx.runId}.`);
  const describe = `${terminal.type}${typeof terminal.extra.reason === 'string' ? `(${terminal.extra.reason})` : ''} at attempt ${String(terminal.extra.attempt ?? '?')}`;
  if (
    terminal.type !== 'actor_failed' ||
    terminal.extra.reason !== 'merge_back_failed' ||
    terminal.extra.workspace_retained !== true ||
    typeof terminal.extra.workspace !== 'string' ||
    typeof terminal.extra.attempt !== 'number'
  ) {
    throw new DriveError(
      `attempt-accept applies to an attempt whose merge-back failed with its worktree retained; ` +
        `the latest attempt of "${callId}" is ${describe}.`,
    );
  }
  const attempt = terminal.extra.attempt;
  if (events.some((e) => e.type === 'actor_dispatched' && e.extra.actor_call_id === callId && typeof e.extra.attempt === 'number' && e.extra.attempt > attempt)) {
    throw new DriveError(`attempt ${attempt} of "${callId}" has already been followed by a later attempt; nothing to accept.`);
  }
  const dispatched = events.find((e) => e.type === 'actor_dispatched' && e.extra.actor_call_id === callId && e.extra.attempt === attempt);
  if (dispatched == null) throw new DriveError(`attempt ${attempt} of "${callId}" has no actor_dispatched row.`);
  const outputRel = typeof dispatched.extra.output_path === 'string' ? dispatched.extra.output_path : null;
  if (outputRel == null) {
    throw new DriveError(`attempt ${attempt} of "${callId}" recorded no output_path on its dispatch row (written by fadeno 0.6.0-rc.60 and later); accept it by re-driving instead.`);
  }
  const artifactType = typeof dispatched.extra.artifact_type === 'string' ? dispatched.extra.artifact_type : null;
  const workspaceRel = terminal.extra.workspace;
  const worktreeAbs = join(repoRoot, ...workspaceRel.split('/'));
  if (!existsSync(worktreeAbs)) throw new DriveError(`the retained worktree ${workspaceRel} is gone; there is nothing to accept.`);
  const parkedRel = typeof terminal.extra.attempt_output === 'string' ? terminal.extra.attempt_output : null;
  if (parkedRel == null || !existsSync(join(ctx.runDir, parkedRel))) {
    throw new DriveError(`attempt ${attempt} of "${callId}" has no parked report (attempt_output) to accept.`);
  }
  const stdout = readFileSync(join(ctx.runDir, parkedRel), 'utf8');
  const priorStamp = terminal.extra.merge_back != null && typeof terminal.extra.merge_back === 'object' ? (terminal.extra.merge_back as MergeBackResult) : null;
  const priorConflicts = priorStamp?.conflicts ?? [];

  // Validate BEFORE touching the tree: a report that fails its schema is
  // the human's to fix too, and applying the work first would leave a tree
  // that changed and a step that did not.
  const verdict = validateTyped(ctx, artifactType, stdout);
  if (!verdict.ok) {
    throw new DriveError(
      `the parked report for attempt ${attempt} of "${callId}" fails ${artifactType} validation (${verdict.errors.slice(0, 3).join('; ')}); ` +
        `nothing was applied. Fix ${parkedRel} under the run directory, then accept again.`,
    );
  }

  const newAttempt = attempt + 1;
  const id8 = `${callId}-a${newAttempt}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const diffRel = join('.fadeno', 'local', 'outputs', `engine-${ctx.runId}-${id8}.diff`).split('\\').join('/');
  const headRes = spawnSync('git', ['-C', worktreeAbs, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const baselineBefore = headRes.error == null && headRes.status === 0 ? String(headRes.stdout ?? '').trim() : null;
  const diff = collectIsolatedDiff({ repoRoot, worktreeAbs, diffAbs: join(repoRoot, diffRel), diffRel });
  const settled = withEngineTreeLease(ctx, `merge:${callId}:a${newAttempt}`, () =>
    settleIsolatedWork({ repoRoot, worktreeAbs, diff, baselineRef: `${ctx.runId}:${id8}:rebase`, armLabel: 'engine attempt', priorConflicts }));
  if (settled.stamp.status === 'unresolved') {
    throw new DriveError(
      `the worktree ${workspaceRel} still conflicts with the workspace (${(settled.stamp.conflicts ?? []).join(', ')}): ` +
        `${settled.stamp.detail ?? 'unresolved'}. Nothing was applied; resolve the markers there and accept again.`,
    );
  }
  if (settled.stamp.status === 'blocked') {
    throw new DriveError(`could not merge ${workspaceRel}: ${settled.stamp.detail ?? 'blocked'}. Nothing was applied; the worktree is kept.`);
  }

  const now = ctx.now ?? new Date();
  const stepId = typeof terminal.extra.step === 'string' ? terminal.extra.step : typeof dispatched.step === 'string' ? dispatched.step : null;
  const role = typeof terminal.extra.actor === 'string' ? terminal.extra.actor : null;
  const stepExecutionId = typeof terminal.extra.step_execution_id === 'string' ? terminal.extra.step_execution_id : null;
  const base: Record<string, unknown> = {
    step: stepId,
    actor: role,
    step_execution_id: stepExecutionId,
    actor_call_id: callId,
    attempt: newAttempt,
    executor: dispatched.extra.executor,
  };
  const baselineCommit = settled.stamp.rebased_onto ?? baselineBefore;
  appendEvent(ctx.runDir, {
    type: 'actor_dispatched',
    ...base,
    attempt_reason: 'host_resolved',
    resolved_by: 'host',
    model: dispatched.extra.model ?? null,
    prompt_path: dispatched.extra.prompt_path ?? null,
    prompt_sha256: dispatched.extra.prompt_sha256 ?? null,
    output_path: outputRel,
    ...(artifactType != null ? { artifact_type: artifactType } : {}),
    workspace_mode: 'isolated',
    workspace: workspaceRel,
    ...(baselineCommit != null ? { baseline_commit: baselineCommit } : {}),
    engine_pid: process.pid,
  }, now);

  const receipt: Record<string, unknown> = {
    ...base,
    duration_ms: 0,
    ended_at: now.toISOString(),
    exit_code: 0,
    workspace_mode: 'isolated',
    workspace: workspaceRel,
    ...(baselineCommit != null ? { baseline_commit: baselineCommit } : {}),
    diff_snapshot: settled.diff.diffRel,
    diff_bytes: settled.diff.diffBytes,
    merge_back: settled.stamp,
  };
  const artifactFields = [`step_execution_id=${stepExecutionId}`, `actor_call_id=${callId}`, `attempt=${newAttempt}`];
  const extraction = verdict.extraction;
  if (extraction) {
    const ext = extname(outputRel) || '.out';
    const rawRel = `artifacts/attempts/${callId}-a${newAttempt}.raw${ext}`;
    const rawAbs = join(ctx.runDir, rawRel);
    mkdirSync(dirname(rawAbs), { recursive: true });
    writeFileSync(rawAbs, stdout, 'utf8');
    const abs = join(ctx.runDir, outputRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, extraction.payload, 'utf8');
    try {
      runRun({ run: ctx.runId, event: 'artifact_created', artifact: outputRel, member: role ?? undefined, fields: artifactFields, repoRoot, now });
    } catch (err) {
      if (err instanceof RunError) throw new DriveError(err.message);
      throw err;
    }
    appendEvent(ctx.runDir, { type: 'actor_completed', ...receipt, output: outputRel, output_valid: true, output_extraction: extraction.kind, envelope_candidates: extraction.candidates, raw_output: rawRel, raw_output_bytes: Buffer.byteLength(stdout), raw_output_sha256: sha256Hex(stdout) }, now);
  } else {
    const abs = join(ctx.runDir, outputRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, stdout, 'utf8');
    try {
      runRun({ run: ctx.runId, event: 'artifact_created', artifact: outputRel, member: role ?? undefined, fields: artifactFields, repoRoot, now });
    } catch (err) {
      if (err instanceof RunError) throw new DriveError(err.message);
      throw err;
    }
    appendEvent(ctx.runDir, { type: 'actor_completed', ...receipt, output: outputRel, output_valid: true }, now);
  }
  try { removeIsolatedWorktree(repoRoot, worktreeAbs); } catch {}
  ctx.act(`accepted ${callId}: attempt ${newAttempt} (host_resolved) merged ${settled.diff.diffBytes} bytes into the workspace and wrote ${outputRel}`);
  return {
    runId: ctx.runId,
    actorCallId: callId,
    attempt: newAttempt,
    output: outputRel,
    mergeBack: settled.stamp,
    diffBytes: settled.diff.diffBytes,
    workspace: workspaceRel,
    actions,
  };
}

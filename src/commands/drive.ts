import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  applicableOverrides,
  eligibilityFor,
  explainEligibilityConflict,
  explainProviderConflict,
  explainWriteConflict,
  loadExecutorProfile,
  parseExecutorProfile,
  readLocalLoadoutState,
  applicableUserLoadout,
  repoProfileSelfContained,
  resolveActiveLoadout,
  resolveRole,
  roleResolutionEchoLabel,
  serializeProfile,
  SESSION_ID_PLACEHOLDER,
  substituteSessionId,
  type ActiveLoadout,
  type ExecutorProfile,
  type ExecutorSpec,
  type InputProducer,
  type LocalLoadoutState,
  type RoleResolutionSource,
  type WritePosture,
} from '../lib/executors.ts';
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
import { baseArtifactName, schemaKindFor, type Playbook, type PlaybookStep } from '../lib/prompt-resolve.ts';
import {
  readEventsStrict,
  resolveRun,
  RUN_LEDGER_SCHEMA_VERSION,
  RunLedgerError,
  type RunEvent,
} from '../lib/run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';
import { CONDITION_REGISTRY, GateError, runGate, SUPPORTED_CONDITIONS, type GateCondition } from './gate.ts';
import { requestHostDispatch, type HostDispatchRequest } from '../lib/host-dispatch.ts';
import { PromptError, runPrompt } from './prompt.ts';
import { RunError, runRun } from './run.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';

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
  /** Session binding overrides, each `role=executor`. Recorded as events. */
  bind?: string[];
  /** `--loadout` override for this invocation (active-loadout resolution). */
  loadout?: string;
  /**
   * `FADENO_LOADOUT` value; injectable for hermetic tests. `undefined` reads
   * the real environment; `null` means explicitly absent.
   */
  env?: string | null;
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
  /** Durable native-host requests still awaiting start/terminal receipt. */
  requests: HostDispatchRequest[];
  /** Named alias for callers that prefer the protocol vocabulary. */
  unresolvedRequests: HostDispatchRequest[];
}

const MAX_TRANSITIONS_DEFAULT = 50;
const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;
const STDERR_TAIL = 400;

interface EngineCtx {
  runId: string;
  runDir: string;
  repoRoot: string;
  userPathOptions?: UserPathOptions;
  playbook: Playbook;
  task: string;
  schemas: SchemaSet;
  profile: ExecutorProfile;
  /** Active loadout for this invocation — resolved fresh at engine start. */
  activeLoadout: ActiveLoadout | null;
  /**
   * Session slot overrides from the sticky pin (archetype → executor), already
   * scoped to `activeLoadout` by name. Distinct from `overrides` below: these
   * decorate the loadout's archetype slots, `--bind` pins a role outright.
   */
  slotOverrides: Record<string, string>;
  /** Explicit `--bind` overrides: role key → executor name. */
  overrides: Map<string, string>;
  /** Actor calls that already consumed their one bounded repair this invocation. */
  repaired: Set<string>;
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

/**
 * A hard-killed engine cannot append from a signal handler. On the next drive,
 * close every command-backed start that has no terminal event so the ledger
 * never remains permanently ambiguous. Native host starts carry dispatch_id
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
    appendEvent(ctx.runDir, {
      type: 'actor_failed',
      step: event.step,
      actor: event.extra.actor ?? null,
      step_execution_id: event.extra.step_execution_id,
      actor_call_id: event.extra.actor_call_id,
      attempt: event.extra.attempt,
      executor: event.extra.executor,
      reason: 'engine_interrupted',
      error: 'the previous drive process ended before recording a terminal command receipt',
      recovered: true,
    }, ctx.now);
  }
  if (dangling.length > 0) {
    ctx.act(`recovered ${dangling.length} interrupted command dispatch receipt(s)`);
  }
  return dangling.length;
}

function parseBinds(bind: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of bind ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new DriveError(`Invalid --bind "${entry}"; expected role=executor.`);
    }
    out.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return out;
}

/** Snapshot the repo profile into the run dir on first engine contact; later
 *  invocations run against the snapshot (the run's truth), never a silently
 *  edited repo profile. */
function ensureProfileSnapshot(ctx: Omit<EngineCtx, 'profile' | 'activeLoadout' | 'slotOverrides'>): ExecutorProfile {
  const snapshotPath = join(ctx.runDir, 'profile.yaml');
  if (existsSync(snapshotPath)) {
    try {
      return parseExecutorProfile(readFileSync(snapshotPath, 'utf8'), 'profile.yaml (run snapshot)');
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
      throw err;
    }
  }
  let profile: ExecutorProfile;
  try {
    profile = loadExecutorProfile(ctx.repoRoot, ctx.userPathOptions).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
  const text = serializeProfile(profile);
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
  return profile;
}

/**
 * Full dispatch-kernel resolution for one role: explicit `bindings[role]` pin
 * → session override for the role's archetype → active loadout's slot for that
 * archetype → `"*"` default. Computed at dispatch time against the run's
 * snapshotted profile; never cached in config. Throws `ExecutorProfileError`
 * when nothing serves.
 */
function resolveChain(
  ctx: EngineCtx,
  role: string | null,
): { executor: string; spec: ExecutorSpec; source: RoleResolutionSource } {
  const archetype = role == null ? null : roleArchetype(ctx.playbook, role);
  const resolved = resolveRole(
    role ?? '*',
    archetype,
    ctx.profile,
    ctx.activeLoadout?.name ?? null,
    ctx.slotOverrides,
  );
  // The anonymous "*" key is by definition the default, not a per-role pin.
  const source = role == null && resolved.source === 'binding' ? 'default' : resolved.source;
  return { executor: resolved.executorName, spec: resolved.executor, source };
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
    if (prior === executor) continue; // no-op override, no evidence needed
    appendEvent(
      ctx.runDir,
      { type: 'executor_override', step: null, role, executor, prior },
      ctx.now,
    );
    ctx.act(`executor override: ${role} → ${executor} (was ${prior ?? 'unbound'})`);
  }
}

function effectiveBinding(ctx: EngineCtx, role: string | null): { executor: string; spec: ExecutorSpec } {
  const key = role ?? '*';
  const overridden = ctx.overrides.get(key);
  if (overridden != null) return { executor: overridden, spec: ctx.profile.executors[overridden]! };
  try {
    const { executor, spec } = resolveChain(ctx, role);
    return { executor, spec };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
}

/**
 * Record where every declared role lands under this invocation's resolution
 * (active loadout + source, per-role executor/model/source), and echo it so a
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
      const spec = ctx.profile.executors[overridden]!;
      entries.push({ role, archetype, executor: overridden, model: spec.model, source: 'override', ...(spec.target != null ? { target: spec.target, provider: spec.provider ?? null, delivery: spec.adapter } : {}) });
      ctx.act(`${role} → ${overridden}${spec.model != null ? ` (${spec.model})` : ''} [override]`);
      continue;
    }
    try {
      const { executor, spec, source } = resolveChain(ctx, role);
      const label = roleResolutionEchoLabel(source, ctx.activeLoadout?.name ?? null);
      entries.push({ role, archetype, executor, model: spec.model, source, ...(spec.target != null ? { target: spec.target, provider: spec.provider ?? null, delivery: spec.adapter } : {}) });
      ctx.act(`${role} → ${executor}${spec.model != null ? ` (${spec.model})` : ''} [${label}]`);
    } catch (err) {
      if (!(err instanceof ExecutorProfileError)) throw err;
      entries.push({ role, archetype, executor: null, model: null, source: null, error: err.message });
      ctx.act(`${role} → (unresolved)`);
    }
  }

  // The overlay in force at snapshot time, omitted entirely when empty so a
  // run with no session overrides records exactly the event it always did —
  // and so a later verify can tell "no overrides" from "overrides unrecorded".
  const slotOverrides = { ...ctx.slotOverrides };
  const payload = {
    loadout:
      ctx.activeLoadout == null
        ? null
        : { name: ctx.activeLoadout.name, source: ctx.activeLoadout.source },
    ...(Object.keys(slotOverrides).length > 0 ? { overrides: slotOverrides } : {}),
    roles: entries,
  };
  const prior = freshEvents(ctx.runDir).findLast((e) => e.type === 'resolution_snapshot');
  if (
    prior != null &&
    JSON.stringify(prior.extra.loadout ?? null) === JSON.stringify(payload.loadout) &&
    JSON.stringify(prior.extra.overrides ?? {}) === JSON.stringify(slotOverrides) &&
    JSON.stringify(prior.extra.roles ?? []) === JSON.stringify(entries)
  ) {
    return; // unchanged since last recorded — the ledger stays quiet
  }
  appendEvent(ctx.runDir, { type: 'resolution_snapshot', step: null, ...payload }, ctx.now);
}

function bodyOwnerOf(playbook: Playbook, stepId: string): string | null {
  const flow = Array.isArray(playbook.flow) ? (playbook.flow as PlaybookStep[]) : [];
  for (const step of flow) {
    if (step.kind !== 'loop' || !Array.isArray(step.body)) continue;
    if ((step.body as unknown[]).includes(stepId) && typeof step.id === 'string') return step.id;
  }
  return null;
}

function countIterationStarts(events: RunEvent[], loopId: string): number {
  return events.filter((e) => e.type === 'loop_iteration_started' && e.step === loopId).length;
}

/** Index just past the Gth iteration start of `loopId`, or 0 for outer scope. */
function scopeStartIndex(events: RunEvent[], loopId: string | null, generation: number): number {
  if (loopId == null) return 0;
  let seen = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === 'loop_iteration_started' && events[i]!.step === loopId) {
      seen += 1;
      if (seen === generation) return i;
    }
  }
  return 0;
}

function stepStartedInScope(events: RunEvent[], stepId: string, from: number): boolean {
  for (let i = from; i < events.length; i += 1) {
    if (events[i]!.type === 'step_started' && events[i]!.step === stepId) return true;
  }
  return false;
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
  | { kind: 'invalid_output'; detail: string; errors: string[] };

function declaredWritePosture(
  profile: ExecutorProfile,
  archetype: string | null,
): WritePosture | null {
  if (archetype == null || !Object.hasOwn(profile.archetypes, archetype)) return null;
  return profile.archetypes[archetype]!.requiresWrite;
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
  profile: ExecutorProfile,
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

function resolvedViaFor(ctx: EngineCtx, role: string | null): string | null {
  if (role != null && ctx.overrides.has(role)) return null;
  if (role == null && ctx.overrides.has('*')) return null;
  try {
    const archetype = role == null ? null : roleArchetype(ctx.playbook, role);
    return resolveRole(
      role ?? '*',
      archetype,
      ctx.profile,
      ctx.activeLoadout?.name ?? null,
      ctx.slotOverrides,
    ).resolvedVia;
  } catch {
    return null;
  }
}

type DispatchOutcome = { kind: 'valid' } | DispatchFailure;

type PromptableOutcome =
  | DispatchFailure
  | { kind: 'awaiting_host_dispatch'; requests: HostDispatchRequest[]; notes: string[] };

function validateTyped(
  ctx: EngineCtx,
  kind: string | null,
  text: string,
): { ok: true; parsed: unknown } | { ok: false; errors: string[] } {
  if (kind == null) return { ok: true, parsed: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
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

/**
 * One executor invocation for one actor call: assemble (or reuse) the prompt
 * snapshot, dispatch the bound command, validate the output, and record only
 * facts the adapter can witness — started/failed to start, exit status, and
 * whether the output passed validation.
 */
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
): DispatchOutcome {
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
  const repairCore = repairErrors != null ? repairMessage(repairErrors) : null;

  // Session state — only for executors that declare `resume`. One session per
  // role per run; the mode and id are recorded on every dispatch so verify can
  // check continuity, and resumed context is visibly attested, not recomputed.
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

  // A resumed session already holds the assembled prompt and its own failed
  // output, so a repair re-ask sends only the repair message; every other
  // dispatch sends the full deterministic prompt. `repair_appendix` records
  // exactly what was sent beyond the snapshotted prompt.
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
  };
  if (session != null) dispatched.session = session;
  if (sessionId != null) dispatched.session_id = sessionId;
  dispatched.engine_pid = process.pid;
  if (stamps.providerWarned === true) dispatched.provider_distinctness = 'warned';
  if (stamps.shadowOnly === true) dispatched.gate_eligible = false;
  if (repairCore != null) {
    dispatched.repair_appendix = session === 'resumed' ? repairCore : `\n\n---\n${repairCore}`;
  }
  appendEvent(ctx.runDir, dispatched, ctx.now);
  ctx.act(
    `dispatch ${stepId}${role ? ` (${role})` : ''} attempt ${attempt} [${reason}]` +
      ` → ${executor}${session != null ? ` (${session} session)` : ''}`,
  );
  ctx.act(`external sandbox: ${executor} (${argv.join(' ')}) runs outside the current harness; evidence is recorded in the run ledger`);

  const [cmd, ...args] = argv;
  const spawned = spawnSync(cmd!, args, {
    input: stdin,
    encoding: 'utf8',
    cwd: ctx.repoRoot,
    maxBuffer: SPAWN_MAX_BUFFER,
  });

  // Harness-assigned ids (fresh call, pattern mode) are learned post-spawn and
  // recorded on the completion event instead of the dispatch.
  if (session === 'fresh' && sessionId == null && spec.sessionIdPattern != null) {
    const pattern = new RegExp(spec.sessionIdPattern);
    const match = pattern.exec(spawned.stderr ?? '') ?? pattern.exec(spawned.stdout ?? '');
    sessionId = match?.[1] ?? null;
  }

  const base: Record<string, unknown> = {
    step: stepId,
    actor: role,
    step_execution_id: ids.stepExecutionId,
    actor_call_id: ids.actorCallId,
    attempt,
    executor,
  };
  if (sessionId != null) base.session_id = sessionId;

  if (spawned.error != null) {
    appendEvent(
      ctx.runDir,
      { type: 'actor_failed', ...base, reason: 'spawn_failed', error: spawned.error.message },
      ctx.now,
    );
    return { kind: 'spawn_failed', detail: `${executor}: ${spawned.error.message}` };
  }
  if (spawned.signal != null) {
    const stderrTail = (spawned.stderr ?? '').slice(-STDERR_TAIL);
    appendEvent(
      ctx.runDir,
      {
        type: 'actor_failed',
        ...base,
        reason: 'signal',
        signal: spawned.signal,
        stderr_tail: stderrTail,
      },
      ctx.now,
    );
    return {
      kind: 'exit_nonzero',
      detail: `${executor} was interrupted by ${spawned.signal} on ${stepId}${role ? ` (${role})` : ''}`,
    };
  }
  if (spawned.status !== 0) {
    const stderrTail = (spawned.stderr ?? '').slice(-STDERR_TAIL);
    appendEvent(
      ctx.runDir,
      {
        type: 'actor_failed',
        ...base,
        reason: 'exit_nonzero',
        exit_code: spawned.status,
        stderr_tail: stderrTail,
      },
      ctx.now,
    );
    return {
      kind: 'exit_nonzero',
      detail: `${executor} exited ${spawned.status ?? '(signal)'} on ${stepId}${role ? ` (${role})` : ''}`,
    };
  }

  const stdout = spawned.stdout ?? '';
  const verdict = validateTyped(ctx, artifactType, stdout);

  if (!verdict.ok) {
    // Rejected output stays out of the planned path (the step must not look
    // done), but the bytes are evidence: park them under artifacts/attempts/.
    const ext = extname(outputRel) || '.out';
    const attemptRel = `artifacts/attempts/${ids.actorCallId}-a${attempt}${ext}`;
    const abs = join(ctx.runDir, attemptRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, stdout, 'utf8');
    appendEvent(
      ctx.runDir,
      {
        type: 'actor_completed',
        ...base,
        exit_code: 0,
        output: attemptRel,
        output_bytes: Buffer.byteLength(stdout),
        output_sha256: sha256Hex(stdout),
        output_valid: false,
        validation_errors: verdict.errors.slice(0, 5),
      },
      ctx.now,
    );
    ctx.act(`  output failed ${artifactType} validation (attempt ${attempt})`);
    return {
      kind: 'invalid_output',
      detail: `${stepId}${role ? ` (${role})` : ''}: output failed ${artifactType} validation`,
      errors: verdict.errors,
    };
  }

  const abs = join(ctx.runDir, outputRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, stdout, 'utf8');
  const artifactFields = [
    `step_execution_id=${ids.stepExecutionId}`,
    `actor_call_id=${ids.actorCallId}`,
    `attempt=${attempt}`,
  ];
  // Mark artifacts born from session context: the id is auditable, the prior
  // session contents are attested rather than recomputable.
  if (session != null) artifactFields.push(`session=${session}`);
  if (sessionId != null) artifactFields.push(`session_id=${sessionId}`);
  try {
    runRun({
      run: ctx.runId,
      event: 'artifact_created',
      artifact: outputRel,
      member: role ?? undefined,
      fields: artifactFields,
      repoRoot: ctx.repoRoot,
      now: ctx.now,
    });
  } catch (err) {
    if (err instanceof RunError) throw new DriveError(err.message);
    throw err;
  }
  appendEvent(
    ctx.runDir,
    { type: 'actor_completed', ...base, exit_code: 0, output: outputRel, output_valid: true },
    ctx.now,
  );
  ctx.act(`  wrote ${outputRel}`);
  return { kind: 'valid' };
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
  const hostRequests: HostDispatchRequest[] = [];
  const hostNotes: string[] = [];

  for (let i = 0; i < actors.length; i += 1) {
    const role = actors[i];
    const outputRel = outputs[i]!;
    events = freshEvents(ctx.runDir);
    if (artifactRecorded(events, outputRel)) continue; // resume: already produced

    const actorCallId = role ? `ac-${stepId}-g${generation}-${role}` : `ac-${stepId}-g${generation}`;
    const ids = { stepExecutionId, actorCallId };

    events = freshEvents(ctx.runDir);
    // An in-flight (requested, unresolved) host dispatch is attested pending
    // work: it stays binding regardless of what the current loadout/profile
    // resolution now says. Checked before resolution so a loadout switch can
    // never silently abandon the request and execute the step another way.
    const pendingDispatch = pendingHostRequest(events, actorCallId, ctx.runId);
    if (pendingDispatch != null) {
      const note = pendingResolutionNote(ctx, stepId, role, pendingDispatch);
      if (note != null) {
        hostNotes.push(note);
        ctx.act(note);
      }
      hostRequests.push(pendingDispatch);
      continue;
    }
    const binding = effectiveBinding(ctx, role);
    if (binding.spec.adapter === 'host') {
      const priorHostAttempts = hostRequestAttempts(events, actorCallId);
      const attempt = priorHostAttempts + 1;
      const priorHostRequest = events
        .filter((event) => event.type === 'host_dispatch_requested' && event.extra.actor_call_id === actorCallId)
        .at(-1);
      const priorHostTerminal = priorHostRequest == null
        ? null
        : events.findLast(
            (event) =>
              (event.type === 'actor_completed' || event.type === 'actor_failed') &&
              event.extra.dispatch_id === priorHostRequest.extra.dispatch_id,
          );
      const reason = priorHostAttempts === 0
        ? 'initial'
        : priorHostTerminal?.type === 'actor_completed' && priorHostTerminal.extra.output_valid === false
          ? 'schema_repair'
          : binding.executor !== priorHostRequest?.extra.executor
            ? 'executor_override'
            : 'user_retry';
      const repairErrors = reason === 'schema_repair' && priorHostTerminal != null && Array.isArray(priorHostTerminal.extra.validation_errors)
        ? priorHostTerminal.extra.validation_errors.filter((error): error is string => typeof error === 'string')
        : null;
      const promptRes = (() => {
        try {
          return runPrompt({
            run: ctx.runId,
            step: stepId,
            actor: role ?? undefined,
            iteration: step.loop.in_body ? generation : undefined,
            record: true,
            repoRoot: ctx.repoRoot,
            now: ctx.now,
          });
        } catch (err) {
          if (err instanceof PromptError) throw new DriveError(err.message);
          throw err;
        }
      })();
      hostRequests.push(hostRequestFor(
        ctx,
        stepId,
        role,
        outputRel,
        step.artifact_type,
        ids,
        attempt,
        reason,
        promptRes.promptPath,
        promptRes.sha256,
        repairErrors,
      ));
      continue;
    }

    // The delivery is a command, so the role's archetype needs a command that
    // can do its work. Refused here — before the prompt is assembled and long
    // before the spawn — in the same words `fadeno dispatch` refuses, so a
    // playbook run cannot hand worker-shaped work to a read-only executor.
    // Host dispatch requests are exempt above: in-session permissions belong
    // to the host, not to this policy.
    const archetype = role == null ? null : roleArchetype(ctx.playbook, role);
    const writeConflict = explainWriteConflict(
      { executor: binding.executor, spec: binding.spec },
      archetype,
      ctx.profile,
    );
    if (writeConflict != null) {
      appendEvent(
        ctx.runDir,
        {
          type: 'actor_failed',
          step: stepId,
          actor: role,
          step_execution_id: stepExecutionId,
          actor_call_id: actorCallId,
          attempt: priorAttempts(events, actorCallId).count + 1,
          executor: binding.executor,
          archetype,
          write_access: false,
          reason: 'write_access_denied',
          error: writeConflict,
        },
        ctx.now,
      );
      ctx.act(`dispatch refused ${stepId}${role ? ` (${role})` : ''}: ${writeConflict}`);
      return {
        kind: 'write_conflict',
        detail: `${stepId}${role ? ` (${role})` : ''} was not dispatched: ${writeConflict}`,
      };
    }

    // Same chokepoint, same refusal shape: forbidden eligibility, then
    // provider distinctness, then the tier-2 constraint command. shadow_only
    // is not a refusal — it stamps the dispatch. Host adapters stay exempt
    // above, matching write-posture.
    const delivery = { executor: binding.executor, spec: binding.spec };
    const eligibilityConflict = explainEligibilityConflict(delivery, archetype);
    if (eligibilityConflict != null) {
      appendEvent(
        ctx.runDir,
        {
          type: 'actor_failed',
          step: stepId,
          actor: role,
          step_execution_id: stepExecutionId,
          actor_call_id: actorCallId,
          attempt: priorAttempts(events, actorCallId).count + 1,
          executor: binding.executor,
          archetype,
          reason: 'eligibility_forbidden',
          error: eligibilityConflict,
        },
        ctx.now,
      );
      ctx.act(`dispatch refused ${stepId}${role ? ` (${role})` : ''}: ${eligibilityConflict}`);
      return {
        kind: 'eligibility_forbidden',
        detail: `${stepId}${role ? ` (${role})` : ''} was not dispatched: ${eligibilityConflict}`,
      };
    }

    const producers = inputProducersFromRun(ctx.playbook, stepId, events, ctx.profile);
    const providerConflict = explainProviderConflict(
      archetype,
      binding.spec.provider ?? null,
      producers,
      ctx.profile,
    );
    if (providerConflict != null && providerConflict.level === 'refuse') {
      appendEvent(
        ctx.runDir,
        {
          type: 'actor_failed',
          step: stepId,
          actor: role,
          step_execution_id: stepExecutionId,
          actor_call_id: actorCallId,
          attempt: priorAttempts(events, actorCallId).count + 1,
          executor: binding.executor,
          archetype,
          reason: 'provider_conflict',
          error: providerConflict.message,
        },
        ctx.now,
      );
      ctx.act(`dispatch refused ${stepId}${role ? ` (${role})` : ''}: ${providerConflict.message}`);
      return {
        kind: 'provider_conflict',
        detail: `${stepId}${role ? ` (${role})` : ''} was not dispatched: ${providerConflict.message}`,
      };
    }
    const providerWarned = providerConflict != null && providerConflict.level === 'warn';
    if (providerWarned) {
      ctx.act(`dispatch warning ${stepId}${role ? ` (${role})` : ''}: ${providerConflict.message}`);
    }

    const constraintContext: ConstraintContext = {
      archetype,
      role,
      executor: binding.executor,
      target: binding.spec.target ?? null,
      provider: binding.spec.provider ?? null,
      model: binding.spec.model,
      transport: 'command',
      write_access: binding.spec.writeAccess,
      write_posture: declaredWritePosture(ctx.profile, archetype),
      active_loadout: ctx.activeLoadout?.name ?? null,
      overrides: ctx.slotOverrides,
      resolved_via: resolvedViaFor(ctx, role),
      input_provenance: producers.map((producer) => ({
        dispatch_id: producer.dispatchId,
        executor: producer.executor,
        provider: producer.provider,
      })),
      harness: ctx.profile.harness ?? 'standalone',
    };
    let constraintVerdict;
    try {
      constraintVerdict = evaluateConstraint(ctx.profile, constraintContext, { cwd: ctx.repoRoot });
    } catch (err) {
      if (err instanceof ConstraintError) {
        throw new DriveError(`constraint system error: ${err.message}`);
      }
      throw err;
    }
    if (constraintVerdict.verdict === 'refused') {
      appendEvent(
        ctx.runDir,
        {
          type: 'actor_failed',
          step: stepId,
          actor: role,
          step_execution_id: stepExecutionId,
          actor_call_id: actorCallId,
          attempt: priorAttempts(events, actorCallId).count + 1,
          executor: binding.executor,
          archetype,
          reason: 'constraint_refused',
          error: constraintVerdict.reason,
        },
        ctx.now,
      );
      ctx.act(`dispatch refused ${stepId}${role ? ` (${role})` : ''}: ${constraintVerdict.reason}`);
      return {
        kind: 'constraint_refused',
        detail: `${stepId}${role ? ` (${role})` : ''} was not dispatched: ${constraintVerdict.reason}`,
      };
    }

    const shadowOnly = eligibilityFor(binding.spec, archetype) === 'shadow_only';

    let repairErrors: string[] | null = null;
    for (;;) {
      events = freshEvents(ctx.runDir);
      const prior = priorAttempts(events, actorCallId);
      const attempt = prior.count + 1;
      let reason = 'initial';
      if (repairErrors != null) {
        reason = 'schema_repair';
      } else if (prior.count > 0) {
        const { executor } = effectiveBinding(ctx, role);
        reason = executor !== prior.lastExecutor ? 'executor_override' : 'user_retry';
      }

      const outcome = dispatchOnce(
        ctx,
        stepId,
        role,
        generation,
        step.loop.in_body,
        outputRel,
        step.artifact_type,
        ids,
        attempt,
        reason,
        repairErrors,
        { providerWarned, shadowOnly },
      );

      if (outcome.kind === 'valid') break;
      if (outcome.kind === 'invalid_output' && !ctx.repaired.has(actorCallId)) {
        // One bounded re-ask per actor call per invocation, then fail honestly.
        ctx.repaired.add(actorCallId);
        repairErrors = outcome.errors;
        continue;
      }
      return outcome;
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
        try {
          return JSON.parse(readFileSync(abs, 'utf8')) as unknown;
        } catch (err) {
          throw new DriveError(
            `cannot assemble ${step.collective}: member output ${rel}` +
              `${role ? ` (${role})` : ''} is not valid JSON: ${(err as Error).message}`,
          );
        }
      });
      const abs = join(ctx.runDir, step.collective);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(parts, null, 2)}\n`, 'utf8');
      try {
        runRun({
          run: ctx.runId,
          event: 'artifact_created',
          artifact: step.collective,
          fields: [`step_execution_id=${stepExecutionId}`],
          repoRoot: ctx.repoRoot,
          now: ctx.now,
        });
      } catch (err) {
        if (err instanceof RunError) throw new DriveError(err.message);
        throw err;
      }
      ctx.act(`assembled collective ${step.collective}`);
    }
  }

  return null;
}

/** Evaluate a gate (or a loop's `until`) with the deterministic evaluator. */
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
        `${requests.length} compositional host dispatch request(s) are awaiting native receipts.`,
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
export function runDrive(opts: DriveOptions): DriveResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);

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

  const base = {
    runId: run.runId,
    runDir: run.dir,
    repoRoot,
    userPathOptions: opts.userPathOptions,
    playbook,
    task: run.task ?? '',
    schemas,
    overrides: new Map<string, string>(),
    repaired: new Set<string>(),
    now: opts.now,
    act,
  };
  const profile = ensureProfileSnapshot(base);
  // Active loadout: --loadout flag → FADENO_LOADOUT → .fadeno/local/loadout →
  // default_loadout, resolved fresh every invocation (dispatch time), against
  // the run's snapshotted profile. An unknown name is a hard error naming its
  // source — never a silent fallback.
  let activeLoadout: ActiveLoadout | null;
  let requestedLoadout: string | null = null;
  try {
    const runDoc = parseYaml(readFileSync(join(run.dir, 'run.yaml'), 'utf8')) as Record<string, unknown>;
    requestedLoadout = typeof runDoc.requested_loadout === 'string' ? runDoc.requested_loadout : null;
  } catch {
    requestedLoadout = null;
  }
  let pin: LocalLoadoutState;
  try {
    pin = readLocalLoadoutState(repoRoot);
    activeLoadout = resolveActiveLoadout({
      flagValue: opts.loadout ?? null,
      runValue: requestedLoadout,
      envValue: opts.env !== undefined ? opts.env : process.env.FADENO_LOADOUT ?? null,
      localFileValue: pin.loadout,
      // The run resolves against a snapshotted profile, so self-containment is
      // read from the repo's current catalog rather than the snapshot.
      userFileValue: applicableUserLoadout(
        repoProfileSelfContained(repoRoot, opts.userPathOptions),
        opts.userPathOptions,
      ),
      profile,
    });
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
  // Overrides belong to their base loadout by name, so a run that persisted a
  // different loadout (or a `--loadout` flag on this invocation) sees none of
  // this pin's overlay.
  const ctx: EngineCtx = {
    ...base,
    profile,
    activeLoadout,
    slotOverrides: applicableOverrides(pin, activeLoadout),
  };
  recoverInterruptedCommandDispatches(ctx);
  if (opts.loadout != null && opts.loadout !== requestedLoadout && requestedLoadout != null) {
    appendEvent(
      ctx.runDir,
      { type: 'loadout_override', step: null, prior: requestedLoadout, loadout: opts.loadout, source: 'flag' },
      ctx.now,
    );
    ctx.act(`loadout override: ${requestedLoadout} → ${opts.loadout}`);
  }
  recordOverrides(ctx, parseBinds(opts.bind));
  recordResolutionSnapshot(ctx);

  const maxTransitions = opts.maxTransitions ?? MAX_TRANSITIONS_DEFAULT;
  if (hasCompositeContainers(playbook)) return driveComposite(ctx, maxTransitions, actions);
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
      comp = computeNext(playbook, events);
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
        act(detail);
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
        act(`run ${status}`);
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
    if (!step.promptable) {
      return finish(
        'needs_decision',
        `step "${step.id}" (kind ${step.kind}) is not engine-executable in this protocol; ${comp.advice}`,
      );
    }

    const failure = drivePromptable(ctx, comp);
    if (failure != null) {
      if (failure.kind === 'awaiting_host_dispatch') {
        const base = `${failure.requests.length} host dispatch request(s) are awaiting native receipts.`;
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

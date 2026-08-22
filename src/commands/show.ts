import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveActiveArtifacts, type ActiveArtifact } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { resolveRunPlaybookFile } from '../lib/definitions.ts';
import { mapMemberInstance, parseNodeInstanceId } from '../lib/node-instance.ts';
import {
  ledgerMode,
  listArtifacts,
  normalizeLegacyEvents,
  readEvents,
  resolveRun,
  type LedgerMode,
  type RunEvent,
  type RunSummary,
} from '../lib/run-ledger.ts';
import { INFLIGHT_DIR, readInflightClaim, readSupervisorStatus } from '../lib/supervisor.ts';
import { readWorkspaceLease, workspaceLeaseHolderKey, WORKSPACE_LEASE_FILE } from '../lib/workspace-lease.ts';
import { HostWorkspaceError, readHostWorkspaceState } from '../lib/host-workspace.ts';

/** Five minutes without output — prominent but non-gating diagnostic. */
export const OUTPUT_IDLE_WARNING_MS = 300_000;

export interface ShowOptions {
  run: string;
  /** Read a 0.2 or unversioned pre-0.3 ledger in explicit compatibility mode. */
  legacy?: boolean;
  cwd?: string;
  repoRoot?: string;
  /** Injectable clock for stable running-duration projections. */
  now?: Date;
  /** Injectable machine-local liveness probe for stable process projections. */
  processProbe?: (pid: number, signal: 0) => void;
}

export type WorkflowState = 'pending' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed';

/**
 * Actor progress as observed via attested sidecars.
 * `source` is the observation source: `agent`, `harness`, or `director`.
 * This is agent/harness/director-attested progress and never controls gates.
 */
export interface ActorView {
  actor: string;
  state: WorkflowState;
  runtimeMs: number | null;
  phase: string | null;
  summary: string | null;
  completed: string[];
  current: string | null;
  next: string | null;
  blockers: string[];
  updatedAt: string | null;
  progressAgeMs: number | null;
  /** Attested source: agent | harness | director — never gates. */
  source: ProgressSource | null;
}

export type ProgressSource = 'agent' | 'harness' | 'director';
export type HarnessProcessState = 'alive' | 'dead' | 'unknown';

export interface StepView {
  id: string;
  kind: string | null;
  loopBodyOf: string | null;
  state: WorkflowState;
  runtimeMs: number | null;
  actors: ActorView[];
  instances: NodeInstanceView[];
  artifacts: number;
  gates: { condition: string; result: string }[];
  iterations: number;
  decisions: string[];
  /** Distinct engine actor calls (0 for hand-driven steps). */
  actorCalls: number;
  /** Engine dispatches across those calls; > actorCalls means retries. */
  attempts: number;
  /** Dispatches with attempt_reason schema_repair. */
  repairs: number;
  /** Dispatches into a resumed harness session (attested context). */
  resumed: number;
}

export interface NodeInstanceView {
  id: string;
  parentId: string | null;
  member: string | null;
  generation: number | null;
  state: WorkflowState;
  runtimeMs: number | null;
}

/**
 * Harness-observed process facts — machine-local state below `.fadeno/local/`
 * and never ledger evidence. Distinguishes `supervisor_pid`, `executor_pid`,
 * `process_group_id`, `started_at`, `heartbeat_at`, `last_output_at`,
 * `stdout_bytes`, `stderr_bytes`, and `workspace_mode`. Labeled
 * `harness-observed` and never controls gates.
 */
export interface HarnessObservedProcessView {
  holderId: string | null;
  holderKind: string | null;
  runId: string | null;
  dispatchId: string | null;
  /** Repo-relative source record for diagnosis; machine-local, never evidence. */
  claimPath: string;
  workspaceMode: string | null;
  processState: HarnessProcessState;
  observationError: string | null;
  supervisorPid: number | null;
  executorPid: number | null;
  processGroupId: number | null;
  startedAt: string | null;
  runtimeMs: number | null;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  lastOutputAt: string | null;
  outputAgeMs: number | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  /** Terminal supervisor outcome, null while running or unavailable. */
  exitCode: number | null;
  signal: string | null;
  endedAt: string | null;
  /** True when alive and no output for five minutes — prominent, non-gating. */
  outputIdleWarning: boolean;
  /** Always `harness-observed` — process facts are not ledger and never gate. */
  observationSource: 'harness-observed';
  /** Harness-observed facts never control gates. */
  gating: 'non-gating';
}

/**
 * The legible run projection: logical steps, decisions, failures, and active
 * artifacts — grown from workflow progress, not raw event volume. Raw events
 * remain available for drill-down.
 *
 * - `harnessObserved` are process facts labeled `harness-observed` (non-gating).
 * - `ActorView.source` / `HostRequestView.progressSource` are
 *   agent/harness/director-attested semantic progress (also non-gating).
 * Neither controls gates — gates consume only deterministic artifacts.
 */
export interface ShowProjection {
  playbook: string | null;
  runtimeMs: number | null;
  steps: StepView[];
  active: ActiveArtifact[];
  decisions: { step: string | null; branch: string }[];
  failures: string[];
  requests: HostRequestView[];
  /** Harness-observed process facts (workspace lease + live inflight claims). */
  harnessObserved: HarnessObservedProcessView[];
}

export interface HostRequestView {
  dispatchId: string;
  step: string;
  actor: string | null;
  executor: string;
  model: string | null;
  reasoningEffort: string | null;
  state: 'requested' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed';
  agentId: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  runtimeMs: number | null;
  phase: string | null;
  summary: string | null;
  completed: string[];
  current: string | null;
  next: string | null;
  blockers: string[];
  progressUpdatedAt: string | null;
  progressAgeMs: number | null;
  /** Attested progress source: agent | harness | director — never gates. */
  progressSource: ProgressSource | null;
  workspaceMode: 'shared' | 'isolated';
  workspace: string | null;
  baseCommit: string | null;
  diffSnapshot: string | null;
  diffBytes: number | null;
}

export interface ShowResult {
  run: RunSummary;
  mode: LedgerMode;
  events: RunEvent[];
  badLines: number[];
  artifacts: { path: string; bytes: number }[];
  /** Null in compatibility mode — older ledgers get only the raw timeline. */
  projection: ShowProjection | null;
}

/** Resolve a run and return its summary, projection, timeline, and artifacts. */
export function runShow(opts: ShowOptions): ShowResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const run = resolveRun(repoRoot, opts.run);
  const mode = ledgerMode(run, opts.legacy === true);
  const raw = readEvents(run.dir);
  const events = mode !== 'current' ? normalizeLegacyEvents(raw.events) : raw.events;
  const artifacts = listArtifacts(run.dir);
  const projection = mode === 'current'
    ? projectRun(repoRoot, run, events, opts.now ?? new Date(), opts.processProbe)
    : null;
  return { run, mode, events, badLines: raw.badLines, artifacts, projection };
}

interface WorkflowStep {
  id: string;
  kind: string | null;
  actors: string[];
  loopBodyOf: string | null;
  mapMembers: string[];
}

function workflowSteps(runDir: string, repoRoot: string, playbook: string | null): WorkflowStep[] {
  if (playbook == null) return [];
  const file = resolveRunPlaybookFile(runDir, repoRoot, playbook)?.path;
  if (file == null) return [];
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8')) as { flow?: unknown };
    if (!Array.isArray(parsed?.flow)) return [];
    const raw = parsed.flow.filter(
      (step): step is Record<string, unknown> => step != null && typeof step === 'object' && !Array.isArray(step),
    );
    const bodyOwner = new Map<string, string>();
    for (const step of raw) {
      if (typeof step.id !== 'string' || !Array.isArray(step.body)) continue;
      for (const member of step.body) if (typeof member === 'string') bodyOwner.set(member, step.id);
    }
    return raw.flatMap((step) => {
      if (typeof step.id !== 'string') return [];
      const compositionalMap = step.kind === 'map' && Array.isArray(step.body);
      const actors = Array.isArray(step.over) && !compositionalMap
        ? step.over.filter((actor): actor is string => typeof actor === 'string')
        : typeof step.actor === 'string'
          ? [step.actor]
          : [];
      return [{
        id: step.id,
        kind: typeof step.kind === 'string' ? step.kind : null,
        actors,
        loopBodyOf: bodyOwner.get(step.id) ?? null,
        mapMembers: compositionalMap && Array.isArray(step.over)
          ? step.over.filter((member): member is string => typeof member === 'string')
          : [],
      }];
    });
  } catch {
    return [];
  }
}

function timeMs(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function elapsed(start: string | null, end: string | null, now: Date): number | null {
  const from = timeMs(start);
  const to = timeMs(end) ?? now.getTime();
  return from == null ? null : Math.max(0, to - from);
}

/**
 * Collect harness-observed process facts from machine-local state.
 * Reads `.fadeno/local/workspace-lease.json` (repo-wide writer lease) and
 * `.fadeno/local/inflight/*.json` (per-dispatch engine/ad-hoc claims).
 * Each record distinguishes supervisor_pid, executor_pid, process_group_id,
 * started_at, heartbeat_at, last_output_at, stdout_bytes, stderr_bytes,
 * and workspace_mode. All are labeled harness-observed and never gate.
 */
function processObservation(
  pid: number | null,
  probe: (pid: number, signal: 0) => void,
): { state: HarnessProcessState; error: string | null } {
  if (pid == null) return { state: 'unknown', error: 'supervisor pid unavailable' };
  try {
    probe(pid, 0);
    return { state: 'alive', error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'dead', error: null };
    return {
      state: 'unknown',
      error: `liveness probe failed${code == null ? '' : ` (${code})`}`,
    };
  }
}

function age(value: string | null, now: Date): number | null {
  const at = timeMs(value);
  return at == null ? null : Math.max(0, now.getTime() - at);
}

/**
 * Non-gating idle-output warning: true when the process is alive and has
 * produced no output for OUTPUT_IDLE_WARNING_MS. If lastOutputAt is null,
 * the age is measured from startedAt via runtimeMs. Never signals, never gates,
 * never alters deadlines — purely observational.
 */
function outputIdleWarning(
  processState: HarnessProcessState,
  lastOutputAt: string | null,
  outputAgeMs: number | null,
  runtimeMs: number | null,
): boolean {
  if (processState !== 'alive') return false;
  if (lastOutputAt == null) {
    return runtimeMs != null && runtimeMs >= OUTPUT_IDLE_WARNING_MS;
  }
  return outputAgeMs != null && outputAgeMs >= OUTPUT_IDLE_WARNING_MS;
}

function blankHarnessFact(
  claimPath: string,
  holderId: string | null,
  holderKind: string | null,
  runId: string | null,
  error: string,
): HarnessObservedProcessView {
  return {
    holderId,
    holderKind,
    runId,
    dispatchId: null,
    claimPath,
    workspaceMode: null,
    processState: 'unknown',
    observationError: error,
    supervisorPid: null,
    executorPid: null,
    processGroupId: null,
    startedAt: null,
    runtimeMs: null,
    heartbeatAt: null,
    heartbeatAgeMs: null,
    lastOutputAt: null,
    outputAgeMs: null,
    stdoutBytes: null,
    stderrBytes: null,
    exitCode: null,
    signal: null,
    endedAt: null,
    outputIdleWarning: false,
    observationSource: 'harness-observed',
    gating: 'non-gating',
  };
}

export function collectHarnessObserved(
  repoRoot: string,
  runId: string,
  now: Date,
  probe: (pid: number, signal: 0) => void = (pid, signal) => { process.kill(pid, signal); },
  events: RunEvent[] = [],
): HarnessObservedProcessView[] {
  const out: HarnessObservedProcessView[] = [];

  // An inflight claim says nothing about where its executor is working; the
  // `actor_dispatched` row that named the claim does. Until rc.62 every engine
  // claim was projected as `shared` regardless, so `fadeno show` called an
  // isolated attempt shared while the ledger said otherwise.
  const claimWorkspaceMode = new Map<string, 'shared' | 'isolated'>();
  for (const event of events) {
    if (event.type !== 'actor_dispatched' && event.type !== 'tool_dispatched') continue;
    const claim = event.extra.supervisor_claim;
    if (typeof claim !== 'string') continue;
    claimWorkspaceMode.set(claim, event.extra.workspace_mode === 'isolated' ? 'isolated' : 'shared');
  }
  const modeOf = (claimPath: string): 'shared' | 'isolated' => claimWorkspaceMode.get(claimPath) ?? 'shared';

  // Inflight claims — per-engine and per-ad-hoc.
  const inflightDir = join(repoRoot, ...INFLIGHT_DIR.split('/'));
  if (existsSync(inflightDir)) {
    try {
      const files = readdirSync(inflightDir).sort();
      const fileSet = new Set(files);
      for (const name of files) {
        if (!name.endsWith('.json')) continue;
        if (name.endsWith('.status.json')) {
          if (!name.startsWith(`engine-${runId}-`) && !name.startsWith(`tool-${runId}-`)) continue;
          if (fileSet.has(name.replace(/\.status\.json$/, '.json'))) continue;
          const abs = join(inflightDir, name);
          const claimPath = `${INFLIGHT_DIR}/${name}`;
          const holderId = name.replace(/\.status\.json$/, '');
          const status = readSupervisorStatus(abs, (p) => readFileSync(p, 'utf8'));
          if (status == null) {
            out.push(blankHarnessFact(claimPath, holderId, 'engine', runId, 'unreadable supervisor status'));
            continue;
          }
          const statusRuntimeMs = status.durationMs ?? elapsed(status.startedAt, status.endedAt, now);
          const statusOutputAgeMs = age(status.lastOutputAt, now);
          out.push({
            holderId,
            holderKind: 'engine',
            runId,
            dispatchId: null,
            claimPath,
            workspaceMode: modeOf(claimPath),
            processState: 'dead',
            observationError: status.spawnFailed == null ? null : `spawn failed: ${status.spawnFailed}`,
            supervisorPid: status.supervisorPid,
            executorPid: status.executorPid,
            processGroupId: status.processGroupId,
            startedAt: status.startedAt,
            runtimeMs: statusRuntimeMs,
            heartbeatAt: status.heartbeatAt,
            heartbeatAgeMs: age(status.heartbeatAt, now),
            lastOutputAt: status.lastOutputAt,
            outputAgeMs: statusOutputAgeMs,
            stdoutBytes: status.stdoutBytes,
            stderrBytes: status.stderrBytes,
            exitCode: status.exitCode,
            signal: status.signal,
            endedAt: status.endedAt,
            outputIdleWarning: outputIdleWarning('dead', status.lastOutputAt, statusOutputAgeMs, statusRuntimeMs),
            observationSource: 'harness-observed',
            gating: 'non-gating',
          });
          continue;
        }
        if (!name.startsWith(`engine-${runId}-`) && !name.startsWith(`tool-${runId}-`)) continue;
        const abs = join(inflightDir, name);
        const claimPath = `${INFLIGHT_DIR}/${name}`;
        try {
          const claim = readInflightClaim(abs, (p) => readFileSync(p, 'utf8'));
          if (claim == null) {
            out.push(blankHarnessFact(claimPath, name.replace(/\.json$/, ''), 'engine', runId, 'unreadable in-flight claim'));
            continue;
          }
          const observed = processObservation(claim.supervisorPid, probe);
          const claimRuntimeMs = elapsed(claim.startedAt, null, now);
          const claimOutputAgeMs = age(claim.lastOutputAt, now);
          out.push({
            holderId: name.replace(/\.json$/, ''),
            holderKind: 'engine',
            runId,
            dispatchId: null,
            claimPath,
            workspaceMode: modeOf(claimPath),
            processState: observed.state,
            observationError: observed.error,
            supervisorPid: claim.supervisorPid,
            executorPid: claim.executorPid,
            processGroupId: claim.processGroupId,
            startedAt: claim.startedAt,
            runtimeMs: claimRuntimeMs,
            heartbeatAt: claim.heartbeatAt,
            heartbeatAgeMs: age(claim.heartbeatAt, now),
            lastOutputAt: claim.lastOutputAt,
            outputAgeMs: claimOutputAgeMs,
            stdoutBytes: claim.stdoutBytes,
            stderrBytes: claim.stderrBytes,
            exitCode: null,
            signal: null,
            endedAt: null,
            outputIdleWarning: outputIdleWarning(observed.state, claim.lastOutputAt, claimOutputAgeMs, claimRuntimeMs),
            observationSource: 'harness-observed',
            gating: 'non-gating',
          });
        } catch {
          continue;
        }
      }
    } catch {
      // missing or unreadable inflight dir — no process facts
    }
  }

  // The durable repo-wide lease is always projected so a repo-wide blocker
  // is visible from any run's `fadeno show`. When the lease belongs to the
  // run being shown, its runId is used only to suppress double-counting: if
  // the same supervisor already has an inflight row, that row's fresher
  // counters are preferred over a duplicate lease entry.
  const leasePath = join(repoRoot, WORKSPACE_LEASE_FILE);
  const lease = readWorkspaceLease(repoRoot);
  if (lease != null) {
    for (const holder of lease.holders ?? [lease.holder]) {
      const expectedEngineClaim = holder.kind === 'engine'
        ? holder.id.split(':').join('-')
        : null;
      const duplicate = holder.runId !== runId
        ? undefined
        : out.find((fact) =>
            (lease.supervisor_pid != null && fact.supervisorPid === lease.supervisor_pid) ||
            (expectedEngineClaim != null && fact.holderId === expectedEngineClaim),
          );
      if (duplicate != null) {
        duplicate.runId = holder.runId ?? duplicate.runId;
        duplicate.dispatchId = holder.dispatchId ?? duplicate.dispatchId;
        duplicate.workspaceMode = lease.workspace_mode;
        continue;
      }
      const observed = processObservation(lease.supervisor_pid, probe);
      const key = workspaceLeaseHolderKey(holder);
      const startedAt = lease.holder_started_at?.[key] ?? lease.started_at;
      const heartbeatAt = lease.holder_heartbeat_at?.[key] ?? lease.heartbeat_at;
      const leaseRuntimeMs = elapsed(startedAt, null, now);
      const leaseOutputAgeMs = age(lease.last_output_at, now);
      out.push({
        holderId: holder.id,
        holderKind: holder.kind,
        runId: holder.runId ?? null,
        dispatchId: holder.dispatchId ?? null,
        claimPath: WORKSPACE_LEASE_FILE.split('\\').join('/'),
        workspaceMode: lease.workspace_mode,
        processState: observed.state,
        observationError: observed.error,
        supervisorPid: lease.supervisor_pid,
        executorPid: lease.executor_pid,
        processGroupId: lease.process_group_id,
        startedAt,
        runtimeMs: leaseRuntimeMs,
        heartbeatAt,
        heartbeatAgeMs: age(heartbeatAt, now),
        lastOutputAt: lease.last_output_at,
        outputAgeMs: leaseOutputAgeMs,
        stdoutBytes: lease.stdout_bytes,
        stderrBytes: lease.stderr_bytes,
        exitCode: null,
        signal: null,
        endedAt: null,
        outputIdleWarning: outputIdleWarning(observed.state, lease.last_output_at, leaseOutputAgeMs, leaseRuntimeMs),
        observationSource: 'harness-observed',
        gating: 'non-gating',
      });
    }
  } else if (existsSync(leasePath)) {
    // A corrupt repo-wide writer record is itself operationally important. It
    // may block acquisition even when none of its correlation metadata can be
    // trusted, so surface an unknown diagnostic rather than hiding it.
    let holderId: string | null = null;
    let holderKind: string | null = null;
    let holderRunId: string | null = null;
    try {
      const raw = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>;
      const holder = raw?.holder as Record<string, unknown> | undefined;
      holderId = typeof holder?.id === 'string' ? holder.id : null;
      holderKind = typeof holder?.kind === 'string' ? holder.kind : null;
      holderRunId = typeof holder?.runId === 'string' ? holder.runId : null;
    } catch {
      // The diagnostic below intentionally survives totally invalid JSON.
    }
    out.push(blankHarnessFact(
      WORKSPACE_LEASE_FILE.split('\\').join('/'),
      holderId,
      holderKind,
      holderRunId,
      'unreadable workspace lease',
    ));
  }

  return out;
}

function projectRun(
  repoRoot: string,
  run: RunSummary,
  events: RunEvent[],
  now: Date,
  processProbe?: (pid: number, signal: 0) => void,
): ShowProjection {
  const stepOrder: string[] = [];
  const byStep = new Map<string, StepView>();
  const definitions = new Map(workflowSteps(run.dir, repoRoot, run.playbook).map((step) => [step.id, step]));
  const view = (id: string): StepView => {
    let v = byStep.get(id);
    if (!v) {
      const definition = definitions.get(id);
      v = {
        id,
        kind: definition?.kind ?? null,
        loopBodyOf: definition?.loopBodyOf ?? null,
        state: 'pending',
        runtimeMs: null,
        actors: (definition?.actors ?? []).map((actor) => ({
          actor,
          state: 'pending',
          runtimeMs: null,
          phase: null,
          summary: null,
          completed: [],
          current: null,
          next: null,
          blockers: [],
          updatedAt: null,
          progressAgeMs: null,
          source: null,
        })),
        instances: (definition?.mapMembers ?? []).map((member) => {
          const instance = mapMemberInstance(null, id, member);
          return { id: instance.id, parentId: instance.parentId, member, generation: null, state: 'pending', runtimeMs: null };
        }),
        artifacts: 0,
        gates: [],
        iterations: 0,
        decisions: [],
        actorCalls: 0,
        attempts: 0,
        repairs: 0,
        resumed: 0,
      };
      byStep.set(id, v);
      stepOrder.push(id);
    }
    return v;
  };

  for (const step of definitions.values()) view(step.id);

  const decisions: { step: string | null; branch: string }[] = [];
  const failures: string[] = [];
  const requests = projectHostRequests(repoRoot, run.runId, events, now);
  const callsByStep = new Map<string, Set<string>>();
  const pendingDecisions = new Map<string, string>(); // decision_id → step
  const firstAt = new Map<string, string>();
  const lastAt = new Map<string, string>();
  const instanceFirstAt = new Map<string, string>();
  const instanceLastAt = new Map<string, string>();
  const instanceById = new Map<string, NodeInstanceView>();
  for (const step of byStep.values()) for (const instance of step.instances) instanceById.set(instance.id, instance);

  const instanceView = (id: string): NodeInstanceView | null => {
    const existing = instanceById.get(id);
    if (existing != null) return existing;
    try {
      const parsed = parseNodeInstanceId(id);
      const instance = { id, parentId: parsed.parentId, member: parsed.member, generation: parsed.generation, state: 'pending' as WorkflowState, runtimeMs: null };
      view(parsed.step).instances.push(instance);
      instanceById.set(id, instance);
      return instance;
    } catch {
      return null;
    }
  };

  for (const event of events) {
    const nodeId = typeof event.extra.node_instance_id === 'string' ? event.extra.node_instance_id : null;
    const node = nodeId == null ? null : instanceView(nodeId);
    if (node != null && event.timestamp != null) {
      if (!instanceFirstAt.has(node.id)) instanceFirstAt.set(node.id, event.timestamp);
      instanceLastAt.set(node.id, event.timestamp);
    }
    if (node != null) {
      if (event.type === 'actor_failed' || event.type === 'step_failed') node.state = 'failed';
      else if (event.type === 'actor_dispatched' || event.type === 'step_started' || event.type === 'loop_iteration_started') node.state = 'running';
      else if (event.type === 'artifact_created' || event.type === 'actor_completed' || event.type === 'step_completed') node.state = event.extra.output_valid === false ? 'pending' : 'completed';
      else if (event.type === 'loop_condition_evaluated') node.state = event.extra.result === 'pass' ? 'completed' : 'running';
    }
    if (event.step != null) {
      view(event.step);
      if (event.timestamp != null) {
        if (!firstAt.has(event.step)) firstAt.set(event.step, event.timestamp);
        lastAt.set(event.step, event.timestamp);
      }
    }
    switch (event.type) {
      case 'step_started':
        if (event.step != null) view(event.step).state = 'running';
        break;
      case 'artifact_created':
        if (event.step != null) {
          view(event.step).artifacts += 1;
          view(event.step).state = 'completed';
        }
        break;
      case 'gate_evaluated': {
        const condition = typeof event.extra.condition === 'string' ? event.extra.condition : '?';
        const result = typeof event.extra.result === 'string' ? event.extra.result : '?';
        if (event.step != null) {
          view(event.step).gates.push({ condition, result });
          view(event.step).state = 'completed';
        }
        if (result === 'fail') {
          const artifact = typeof event.extra.artifact === 'string' ? ` (${event.extra.artifact})` : '';
          failures.push(`gate ${condition} → fail${artifact}`);
        }
        break;
      }
      case 'loop_iteration_started':
        if (event.step != null) {
          view(event.step).iterations += 1;
          view(event.step).state = 'running';
        }
        break;
      case 'human_decision': {
        const branch = typeof event.extra.branch === 'string' ? event.extra.branch : '?';
        if (event.step != null) view(event.step).decisions.push(branch);
        if (event.step != null) view(event.step).state = 'completed';
        decisions.push({ step: event.step, branch });
        break;
      }
      case 'actor_dispatched': {
        if (event.step == null) break;
        const v = view(event.step);
        v.state = 'running';
        v.attempts += 1;
        if (event.extra.attempt_reason === 'schema_repair') v.repairs += 1;
        if (event.extra.session === 'resumed') v.resumed += 1;
        const callId = typeof event.extra.actor_call_id === 'string' ? event.extra.actor_call_id : `?${v.attempts}`;
        const set = callsByStep.get(event.step) ?? new Set<string>();
        set.add(callId);
        callsByStep.set(event.step, set);
        break;
      }
      case 'actor_failed': {
        const reason = typeof event.extra.reason === 'string' ? event.extra.reason : 'failed';
        const executor = typeof event.extra.executor === 'string' ? ` (${event.extra.executor})` : '';
        failures.push(`${event.step ?? '?'}: executor ${reason}${executor}`);
        if (event.step != null) view(event.step).state = 'failed';
        break;
      }
      case 'actor_completed':
        if (event.step != null) view(event.step).state = event.extra.output_valid === false ? 'pending' : 'completed';
        break;
      case 'decision_requested': {
        const id = typeof event.extra.decision_id === 'string' ? event.extra.decision_id : null;
        if (id != null && event.step != null) pendingDecisions.set(id, event.step);
        if (event.step != null) view(event.step).state = 'waiting';
        break;
      }
      case 'decision_resolved': {
        const id = typeof event.extra.decision_id === 'string' ? event.extra.decision_id : null;
        if (id != null) pendingDecisions.delete(id);
        const option = typeof event.extra.option === 'string' ? event.extra.option : '?';
        if (event.step != null) view(event.step).decisions.push(option);
        if (event.step != null) view(event.step).state = 'completed';
        decisions.push({ step: event.step, branch: option });
        break;
      }
      case 'run_failed':
        failures.push('run failed');
        break;
      case 'run_aborted':
        failures.push('run aborted');
        break;
      default:
        break;
    }
  }

  for (const [stepId, calls] of callsByStep) view(stepId).actorCalls = calls.size;
  if (run.status === 'running' || run.status == null) {
    for (const stepId of pendingDecisions.values()) view(stepId).state = 'waiting';
  }

  const commandActors = new Map<string, { actor: string; state: WorkflowState; startedAt: string | null; endedAt: string | null }>();
  const actorEvidenceSteps = new Set<string>();
  for (const event of events) {
    if (event.type !== 'actor_dispatched' && event.type !== 'actor_completed' && event.type !== 'actor_failed') continue;
    if (event.step == null || typeof event.extra.actor !== 'string') continue;
    const key = `${event.step}\0${event.extra.actor}`;
    actorEvidenceSteps.add(event.step);
    const current = commandActors.get(key) ?? {
      actor: event.extra.actor,
      state: 'pending' as WorkflowState,
      startedAt: null,
      endedAt: null,
    };
    if (event.type === 'actor_dispatched') {
      current.state = 'running';
      current.startedAt ??= event.timestamp;
      current.endedAt = null;
    } else {
      current.state = event.type === 'actor_completed' ? 'completed' : 'failed';
      current.endedAt = event.timestamp;
    }
    commandActors.set(key, current);
  }
  for (const [key, lifecycle] of commandActors) {
    const stepId = key.split('\0', 1)[0]!;
    const step = view(stepId);
    let actor = step.actors.find((candidate) => candidate.actor === lifecycle.actor);
    if (actor == null) {
      actor = { actor: lifecycle.actor, state: 'pending', runtimeMs: null, phase: null, summary: null, completed: [], current: null, next: null, blockers: [], updatedAt: null, progressAgeMs: null, source: null };
      step.actors.push(actor);
    }
    actor.state = lifecycle.state;
    actor.runtimeMs = lifecycle.startedAt == null ? null : elapsed(lifecycle.startedAt, lifecycle.endedAt, now);
  }

  const latestByActor = new Map<string, HostRequestView>();
  for (const request of requests) latestByActor.set(`${request.step}\0${request.actor ?? ''}`, request);
  for (const request of latestByActor.values()) {
    actorEvidenceSteps.add(request.step);
    const step = view(request.step);
    const actorName = request.actor ?? '(anonymous)';
    let actor = step.actors.find((candidate) => candidate.actor === actorName);
    if (actor == null) {
      actor = { actor: actorName, state: 'pending', runtimeMs: null, phase: null, summary: null, completed: [], current: null, next: null, blockers: [], updatedAt: null, progressAgeMs: null, source: null };
      step.actors.push(actor);
    }
    actor.state = request.state === 'requested' ? 'pending' : request.state;
    actor.runtimeMs = request.runtimeMs;
    actor.phase = request.phase;
    actor.summary = request.summary;
    actor.completed = request.completed;
    actor.current = request.current;
    actor.next = request.next;
    actor.blockers = request.blockers;
    actor.updatedAt = request.progressUpdatedAt;
    actor.progressAgeMs = request.progressAgeMs;
    actor.source = request.progressSource;
  }

  for (const step of byStep.values()) {
    // Declared actors are useful pending placeholders, but legacy/manual traces
    // may advance a step without actor lifecycle receipts. Only let actor state
    // override the step-level event projection when actor evidence exists.
    if (step.actors.length > 0 && actorEvidenceSteps.has(step.id)) {
      const states = step.actors.map((actor) => actor.state);
      if (states.some((state) => state === 'failed')) step.state = 'failed';
      else if (states.some((state) => state === 'blocked')) step.state = 'blocked';
      else if (states.some((state) => state === 'running')) step.state = 'running';
      else if (states.some((state) => state === 'waiting')) step.state = 'waiting';
      else if (states.every((state) => state === 'completed')) step.state = 'completed';
      else step.state = 'pending';
    }
    const startedAt = firstAt.get(step.id) ?? null;
    const isOpen = step.state === 'running' || step.state === 'waiting' || step.state === 'blocked';
    step.runtimeMs = step.state === 'pending' ? null : elapsed(startedAt, isOpen ? null : lastAt.get(step.id) ?? null, now);
  }

  // A compositional map member is represented by its selected container path;
  // descendant events drive its aggregate state even though the container does
  // not need a synthetic lifecycle event of its own.
  for (const instance of instanceById.values()) {
    if (instance.generation != null && instance.state === 'running') {
      const parsed = parseNodeInstanceId(instance.id);
      const later = [...instanceById.values()].some((candidate) => {
        if (candidate.generation == null || candidate.generation <= instance.generation!) return false;
        const other = parseNodeInstanceId(candidate.id);
        return other.parentId === parsed.parentId && other.step === parsed.step;
      });
      if (later) instance.state = 'completed';
    }
    const descendants = [...instanceById.values()].filter((candidate) => candidate.id.startsWith(`${instance.id}/`));
    if (descendants.length > 0) {
      if (descendants.some((candidate) => candidate.state === 'failed')) instance.state = 'failed';
      else if (descendants.some((candidate) => candidate.state === 'running')) instance.state = 'running';
      else if (descendants.some((candidate) => candidate.state === 'waiting')) instance.state = 'waiting';
      else if (descendants.every((candidate) => candidate.state === 'completed')) instance.state = 'completed';
    }
    const latestCondition = events.findLast(
      (event) => event.type === 'loop_condition_evaluated' &&
        typeof event.extra.node_instance_id === 'string' &&
        event.extra.node_instance_id.startsWith(`${instance.id}/`),
    );
    if (latestCondition?.extra.result === 'pass') instance.state = 'completed';
    const start = instanceFirstAt.get(instance.id) ?? descendants.map((candidate) => instanceFirstAt.get(candidate.id)).find((value) => value != null) ?? null;
    const end = instanceLastAt.get(instance.id) ?? descendants.map((candidate) => instanceLastAt.get(candidate.id)).filter((value): value is string => value != null).at(-1) ?? null;
    const open = instance.state === 'running' || instance.state === 'waiting' || instance.state === 'blocked';
    instance.runtimeMs = instance.state === 'pending' ? null : elapsed(start, open ? null : end, now);
  }
  for (const step of byStep.values()) {
    if (step.instances.length === 0) continue;
    const states = step.instances.map((instance) => instance.state);
    if (states.some((state) => state === 'failed')) step.state = 'failed';
    else if (states.some((state) => state === 'blocked')) step.state = 'blocked';
    else if (states.some((state) => state === 'running')) step.state = 'running';
    else if (states.some((state) => state === 'waiting')) step.state = 'waiting';
    else if (states.every((state) => state === 'completed')) step.state = 'completed';
    else step.state = 'pending';
  }

  for (const step of byStep.values()) {
    if (step.kind !== 'loop') continue;
    const body = [...byStep.values()].filter((candidate) => candidate.loopBodyOf === step.id);
    if (body.some((candidate) => candidate.state === 'failed')) step.state = 'failed';
    else if (body.some((candidate) => candidate.state === 'blocked')) step.state = 'blocked';
    else if (body.some((candidate) => candidate.state === 'running')) step.state = 'running';
    else if (body.some((candidate) => candidate.state === 'waiting')) step.state = 'waiting';
  }

  const { active } = resolveActiveArtifacts(events);
  const harnessObserved = collectHarnessObserved(repoRoot, run.runId, now, processProbe, events);
  return {
    playbook: run.playbook,
    runtimeMs: elapsed(run.startedAt, run.endedAt, now),
    steps: stepOrder.map((id) => byStep.get(id)!),
    active,
    decisions,
    failures,
    requests,
    harnessObserved,
  };
}

function projectHostRequests(repoRoot: string, runId: string, events: RunEvent[], now: Date): HostRequestView[] {
  const requested = events.filter(
    (event) => event.type === 'host_dispatch_requested' && typeof event.extra.dispatch_id === 'string',
  );
  const out: HostRequestView[] = [];
  for (const event of requested) {
    const dispatchId = event.extra.dispatch_id as string;
    const start = events.find((candidate) => candidate.type === 'actor_dispatched' && candidate.extra.dispatch_id === dispatchId);
    const terminal = events.find(
      (candidate) => (candidate.type === 'actor_completed' || candidate.type === 'actor_failed') && candidate.extra.dispatch_id === dispatchId,
    );
    const progress = events.findLast(
      (candidate) => candidate.type === 'host_dispatch_progress' && candidate.extra.dispatch_id === dispatchId,
    );
    const progressState = progress?.extra.progress_state;
    const progressUpdatedAt = typeof progress?.extra.reported_at === 'string'
      ? progress.extra.reported_at
      : progress?.timestamp ?? null;
    const progressSource = progress?.extra.observation_source;
    const state: HostRequestView['state'] = terminal?.type === 'actor_completed'
      ? 'completed'
      : terminal?.type === 'actor_failed'
        ? 'failed'
        : progressState === 'blocked'
          ? 'blocked'
          : progressState === 'waiting_input' || progressState === 'idle'
            ? 'waiting'
            : start
              ? 'running'
              : 'requested';
    // Ledger-first workspace projection; prepared-but-not-started may read machine-local state.
    let workspaceMode: 'shared' | 'isolated' = 'shared';
    let workspace: string | null = null;
    let baseCommit: string | null = null;
    let diffSnapshot: string | null = null;
    let diffBytes: number | null = null;
    if (start != null) {
      workspaceMode = start.extra.workspace_mode === 'isolated' ? 'isolated' : 'shared';
      workspace = typeof start.extra.workspace === 'string' ? start.extra.workspace : null;
      baseCommit = typeof start.extra.base_commit === 'string' ? start.extra.base_commit : null;
      diffSnapshot = typeof terminal?.extra.diff_snapshot === 'string' ? terminal.extra.diff_snapshot : null;
      diffBytes = typeof terminal?.extra.diff_bytes === 'number' ? terminal.extra.diff_bytes : null;
      // If isolated but ledger fields missing (should not happen), degrade gracefully to prepared state when available.
      if (workspaceMode === 'isolated' && (workspace == null || baseCommit == null)) {
        try {
          const prepared = readHostWorkspaceState(repoRoot, runId, dispatchId);
          if (prepared != null) {
            workspace = workspace ?? prepared.workspace;
            baseCommit = baseCommit ?? prepared.base_commit;
          }
        } catch (err) {
          if (!(err instanceof HostWorkspaceError)) throw err;
        }
      }
    } else {
      try {
        const prepared = readHostWorkspaceState(repoRoot, runId, dispatchId);
        if (prepared != null) {
          workspaceMode = 'isolated';
          workspace = prepared.workspace;
          baseCommit = prepared.base_commit;
          diffSnapshot = prepared.diff_snapshot ?? null;
          diffBytes = prepared.diff_bytes ?? null;
        }
      } catch (err) {
        if (err instanceof HostWorkspaceError) {
          workspaceMode = 'shared';
          workspace = null;
          baseCommit = null;
          diffSnapshot = null;
          diffBytes = null;
        } else {
          throw err;
        }
      }
    }
    out.push({
      dispatchId,
      step: event.step ?? '?',
      actor: typeof event.extra.actor === 'string' ? event.extra.actor : null,
      executor: typeof event.extra.executor === 'string' ? event.extra.executor : '?',
      model: typeof event.extra.model === 'string' ? event.extra.model : null,
      reasoningEffort: typeof event.extra.reasoning_effort === 'string' ? event.extra.reasoning_effort : null,
      state,
      agentId: typeof start?.extra.agent_id === 'string' ? start.extra.agent_id : null,
      requestedAt: event.timestamp,
      startedAt: start?.timestamp ?? null,
      endedAt: terminal?.timestamp ?? null,
      runtimeMs: start == null ? null : elapsed(start.timestamp, terminal?.timestamp ?? null, now),
      phase: typeof progress?.extra.phase === 'string' ? progress.extra.phase : null,
      summary: typeof progress?.extra.summary === 'string' ? progress.extra.summary : null,
      completed: Array.isArray(progress?.extra.completed)
        ? progress.extra.completed.filter((item): item is string => typeof item === 'string')
        : [],
      current: typeof progress?.extra.current === 'string' ? progress.extra.current : null,
      next: typeof progress?.extra.next === 'string' ? progress.extra.next : null,
      blockers: Array.isArray(progress?.extra.blockers)
        ? progress.extra.blockers.filter((blocker): blocker is string => typeof blocker === 'string')
        : [],
      progressUpdatedAt,
      progressAgeMs: age(progressUpdatedAt, now),
      progressSource: progressSource === 'agent' || progressSource === 'harness' || progressSource === 'director'
        ? progressSource
        : null,
      workspaceMode,
      workspace,
      baseCommit,
      diffSnapshot,
      diffBytes,
    });
  }
  return out;
}

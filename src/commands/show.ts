import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveActiveArtifacts, type ActiveArtifact } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
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

export interface ShowOptions {
  run: string;
  /** Read a 0.2 or unversioned pre-0.3 ledger in explicit compatibility mode. */
  legacy?: boolean;
  cwd?: string;
  repoRoot?: string;
  /** Injectable clock for stable running-duration projections. */
  now?: Date;
}

export type WorkflowState = 'pending' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed';

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
  source: string | null;
}

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
 * The legible run projection: logical steps, decisions, failures, and active
 * artifacts — grown from workflow progress, not raw event volume. Raw events
 * remain available for drill-down.
 */
export interface ShowProjection {
  playbook: string | null;
  runtimeMs: number | null;
  steps: StepView[];
  active: ActiveArtifact[];
  decisions: { step: string | null; branch: string }[];
  failures: string[];
  requests: HostRequestView[];
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
  progressSource: string | null;
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
  const projection = mode === 'current' ? projectRun(repoRoot, run, events, opts.now ?? new Date()) : null;
  return { run, mode, events, badLines: raw.badLines, artifacts, projection };
}

interface WorkflowStep {
  id: string;
  kind: string | null;
  actors: string[];
  loopBodyOf: string | null;
  mapMembers: string[];
}

function workflowSteps(repoRoot: string, playbook: string | null): WorkflowStep[] {
  if (playbook == null) return [];
  const file = [`${playbook}.yaml`, `${playbook}.yml`]
    .map((name) => join(repoRoot, '.fadeno', 'playbooks', name))
    .find((candidate) => existsSync(candidate));
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

function projectRun(repoRoot: string, run: RunSummary, events: RunEvent[], now: Date): ShowProjection {
  const stepOrder: string[] = [];
  const byStep = new Map<string, StepView>();
  const definitions = new Map(workflowSteps(repoRoot, run.playbook).map((step) => [step.id, step]));
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
  const requests = projectHostRequests(events, now);
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
  for (const event of events) {
    if (event.type !== 'actor_dispatched' && event.type !== 'actor_completed' && event.type !== 'actor_failed') continue;
    if (event.step == null || typeof event.extra.actor !== 'string') continue;
    const key = `${event.step}\0${event.extra.actor}`;
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
      actor = { actor: lifecycle.actor, state: 'pending', runtimeMs: null, phase: null, summary: null, completed: [], current: null, next: null, blockers: [], updatedAt: null, source: null };
      step.actors.push(actor);
    }
    actor.state = lifecycle.state;
    actor.runtimeMs = lifecycle.startedAt == null ? null : elapsed(lifecycle.startedAt, lifecycle.endedAt, now);
  }

  const latestByActor = new Map<string, HostRequestView>();
  for (const request of requests) latestByActor.set(`${request.step}\0${request.actor ?? ''}`, request);
  for (const request of latestByActor.values()) {
    const step = view(request.step);
    const actorName = request.actor ?? '(anonymous)';
    let actor = step.actors.find((candidate) => candidate.actor === actorName);
    if (actor == null) {
      actor = { actor: actorName, state: 'pending', runtimeMs: null, phase: null, summary: null, completed: [], current: null, next: null, blockers: [], updatedAt: null, source: null };
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
    actor.source = request.progressSource;
  }

  for (const step of byStep.values()) {
    if (step.actors.length > 0) {
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
  return {
    playbook: run.playbook,
    runtimeMs: elapsed(run.startedAt, run.endedAt, now),
    steps: stepOrder.map((id) => byStep.get(id)!),
    active,
    decisions,
    failures,
    requests,
  };
}

function projectHostRequests(events: RunEvent[], now: Date): HostRequestView[] {
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
      progressUpdatedAt: typeof progress?.extra.reported_at === 'string' ? progress.extra.reported_at : progress?.timestamp ?? null,
      progressSource: typeof progress?.extra.observation_source === 'string' ? progress.extra.observation_source : null,
    });
  }
  return out;
}

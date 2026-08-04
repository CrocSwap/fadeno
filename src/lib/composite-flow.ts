import {
  childNodeInstance,
  loopGenerationInstance,
  mapMemberInstance,
  rootNodeInstance,
  type NodeInstance,
} from './node-instance.ts';
import type { RunEvent } from './run-ledger.ts';

export class CompositeFlowError extends Error {}

export interface CompositeStep {
  id?: unknown;
  kind?: unknown;
  actor?: unknown;
  body?: unknown;
  over?: unknown;
  input?: unknown;
  output?: unknown;
  condition?: unknown;
  until?: unknown;
  max_iterations?: unknown;
  completion?: unknown;
  exhaustion?: unknown;
  [key: string]: unknown;
}

export interface CompositePlaybook {
  flow?: unknown;
}

export type CompositeAction =
  | { kind: 'start_loop'; step: string; instance: NodeInstance; generation: number }
  | { kind: 'actor'; step: string; instance: NodeInstance; actor: string; stepKind: string }
  | { kind: 'evaluate_loop'; step: string; instance: NodeInstance; condition: string; input: string }
  | { kind: 'human_gate'; step: string; instance: NodeInstance; prompt: string }
  | { kind: 'needs_decision'; step: string; instance: NodeInstance; stepKind: string };

export type CompositeNodeState = 'pending' | 'running' | 'completed' | 'failed' | 'exhausted';

export interface CompositeInstanceState {
  step: string;
  instanceId: string;
  parentInstanceId: string | null;
  state: CompositeNodeState;
  member: string | null;
  generation: number | null;
}

export interface CompositeFrontier {
  actions: CompositeAction[];
  instances: CompositeInstanceState[];
  complete: boolean;
  failed: boolean;
}

interface EvalResult {
  state: CompositeNodeState;
  actions: CompositeAction[];
}

interface Context {
  byId: Map<string, CompositeStep>;
  roots: string[];
  events: RunEvent[];
  instances: Map<string, CompositeInstanceState>;
}

const PROMPTABLE = new Set(['actor_call', 'evaluator', 'reduce']);

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function eventInstance(event: RunEvent): string | null {
  return typeof event.extra.node_instance_id === 'string' ? event.extra.node_instance_id : null;
}

function hasEvent(ctx: Context, instanceId: string, types: Set<string>): boolean {
  return ctx.events.some((event) => eventInstance(event) === instanceId && types.has(event.type));
}

function terminalFor(ctx: Context, instanceId: string): 'completed' | 'failed' | null {
  const event = ctx.events.findLast(
    (candidate) => eventInstance(candidate) === instanceId &&
      (candidate.type === 'actor_completed' || candidate.type === 'actor_failed' ||
       candidate.type === 'step_completed' || candidate.type === 'step_failed'),
  );
  if (event == null) return null;
  if (event.type === 'actor_completed' && event.extra.output_valid === false) return null;
  return event.type === 'actor_failed' || event.type === 'step_failed' ? 'failed' : 'completed';
}

function record(ctx: Context, instance: NodeInstance, state: CompositeNodeState): void {
  const existing = ctx.instances.get(instance.id);
  const rank: Record<CompositeNodeState, number> = { pending: 0, running: 1, completed: 2, exhausted: 3, failed: 4 };
  if (existing != null && rank[existing.state] >= rank[state]) return;
  ctx.instances.set(instance.id, {
    step: instance.step,
    instanceId: instance.id,
    parentInstanceId: instance.parentId,
    state,
    member: instance.member,
    generation: instance.generation,
  });
}

function ordinaryInstance(parentId: string | null, stepId: string): NodeInstance {
  return parentId == null ? rootNodeInstance(stepId) : childNodeInstance(parentId, stepId);
}

function requireStep(ctx: Context, id: string): CompositeStep {
  const step = ctx.byId.get(id);
  if (step == null) throw new CompositeFlowError(`container body references missing step "${id}".`);
  return step;
}

function evalSequence(ctx: Context, ids: string[], parentId: string | null): EvalResult {
  for (const id of ids) {
    const result = evalNode(ctx, requireStep(ctx, id), parentId);
    if (result.state === 'failed' || result.state === 'exhausted') return result;
    if (result.state !== 'completed') return result;
  }
  return { state: 'completed', actions: [] };
}

function evalMap(ctx: Context, step: CompositeStep, parentId: string | null): EvalResult {
  const id = step.id as string;
  const members = strings(step.over);
  const body = strings(step.body);
  if (members.length === 0) throw new CompositeFlowError(`compositional map "${id}" requires a non-empty literal over list.`);
  if (body.length === 0) throw new CompositeFlowError(`compositional map "${id}" requires a non-empty body.`);

  const actions: CompositeAction[] = [];
  const states: CompositeNodeState[] = [];
  for (const member of members) {
    const instance = mapMemberInstance(parentId, id, member);
    const result = evalSequence(ctx, body, instance.id);
    states.push(result.state);
    actions.push(...result.actions);
    record(ctx, instance, result.state === 'pending' && result.actions.length > 0 ? 'running' : result.state);
  }
  const failed = states.some((state) => state === 'failed' || state === 'exhausted');
  if (failed && step.completion !== 'collect') return { state: 'failed', actions: [] };
  if (states.every((state) => state === 'completed' || (step.completion === 'collect' && (state === 'failed' || state === 'exhausted')))) {
    return { state: 'completed', actions: [] };
  }
  return { state: 'running', actions };
}

function startedGenerations(ctx: Context, parentId: string | null, stepId: string): number[] {
  const out = new Set<number>();
  for (const event of ctx.events) {
    if (event.type !== 'loop_iteration_started') continue;
    const generation = event.extra.generation ?? event.extra.iteration;
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) continue;
    const expected = loopGenerationInstance(parentId, stepId, generation).id;
    if (eventInstance(event) === expected) out.add(generation);
  }
  return [...out].sort((left, right) => left - right);
}

function loopResult(ctx: Context, instanceId: string): 'pass' | 'fail' | null {
  const event = ctx.events.findLast(
    (candidate) => candidate.type === 'loop_condition_evaluated' && eventInstance(candidate) === instanceId,
  );
  return event?.extra.result === 'pass' || event?.extra.result === 'fail' ? event.extra.result : null;
}

function evalLoop(ctx: Context, step: CompositeStep, parentId: string | null): EvalResult {
  const id = step.id as string;
  const body = strings(step.body);
  const max = step.max_iterations;
  const condition = step.until;
  const inputs = strings(step.input);
  if (body.length === 0) throw new CompositeFlowError(`loop "${id}" requires a non-empty body.`);
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1) throw new CompositeFlowError(`loop "${id}" requires a positive max_iterations.`);
  if (typeof condition !== 'string' || inputs.length !== 1) throw new CompositeFlowError(`loop "${id}" requires one input and an until condition.`);

  const generations = startedGenerations(ctx, parentId, id);
  const expected = generations.length + 1;
  if (generations.some((generation, index) => generation !== index + 1)) {
    throw new CompositeFlowError(`loop "${id}" has non-contiguous generations: ${generations.join(', ')}.`);
  }
  if (generations.length === 0) {
    const instance = loopGenerationInstance(parentId, id, 1);
    record(ctx, instance, 'pending');
    return { state: 'pending', actions: [{ kind: 'start_loop', step: id, instance, generation: 1 }] };
  }

  const generation = generations.at(-1)!;
  const instance = loopGenerationInstance(parentId, id, generation);
  const result = loopResult(ctx, instance.id);
  if (result === 'pass') {
    record(ctx, instance, 'completed');
    return { state: 'completed', actions: [] };
  }
  if (result === 'fail') {
    if (generation >= max) {
      record(ctx, instance, 'exhausted');
      return { state: step.exhaustion === 'collect' ? 'completed' : 'exhausted', actions: [] };
    }
    const next = loopGenerationInstance(parentId, id, expected);
    record(ctx, instance, 'completed');
    record(ctx, next, 'pending');
    return { state: 'running', actions: [{ kind: 'start_loop', step: id, instance: next, generation: expected }] };
  }

  const bodyResult = evalSequence(ctx, body, instance.id);
  if (bodyResult.state === 'failed' || bodyResult.state === 'exhausted') {
    record(ctx, instance, bodyResult.state);
    return bodyResult;
  }
  if (bodyResult.state !== 'completed') {
    record(ctx, instance, 'running');
    return { state: 'running', actions: bodyResult.actions };
  }
  record(ctx, instance, 'running');
  return {
    state: 'running',
    actions: [{ kind: 'evaluate_loop', step: id, instance, condition, input: inputs[0]! }],
  };
}

function evalLeaf(ctx: Context, step: CompositeStep, parentId: string | null): EvalResult {
  const id = step.id as string;
  const kind = step.kind as string;
  const instance = ordinaryInstance(parentId, id);
  const terminal = terminalFor(ctx, instance.id);
  if (terminal != null) {
    record(ctx, instance, terminal);
    return { state: terminal, actions: [] };
  }
  if (hasEvent(ctx, instance.id, new Set(['artifact_created', 'human_decision', 'decision_resolved']))) {
    record(ctx, instance, 'completed');
    return { state: 'completed', actions: [] };
  }
  if (PROMPTABLE.has(kind)) {
    if (typeof step.actor !== 'string') throw new CompositeFlowError(`promptable step "${id}" requires an actor.`);
    record(ctx, instance, 'pending');
    return { state: 'pending', actions: [{ kind: 'actor', step: id, instance, actor: step.actor, stepKind: kind }] };
  }
  if (kind === 'human_gate') {
    const prompt = typeof step.prompt === 'string' ? step.prompt : '';
    record(ctx, instance, 'pending');
    return { state: 'pending', actions: [{ kind: 'human_gate', step: id, instance, prompt }] };
  }
  record(ctx, instance, 'pending');
  return { state: 'pending', actions: [{ kind: 'needs_decision', step: id, instance, stepKind: kind }] };
}

function evalNode(ctx: Context, step: CompositeStep, parentId: string | null): EvalResult {
  if (typeof step.id !== 'string' || typeof step.kind !== 'string') {
    throw new CompositeFlowError('every compositional step requires string id and kind fields.');
  }
  if (step.kind === 'map' && Array.isArray(step.body)) return evalMap(ctx, step, parentId);
  if (step.kind === 'loop') return evalLoop(ctx, step, parentId);
  return evalLeaf(ctx, step, parentId);
}

export function hasCompositeContainers(playbook: CompositePlaybook): boolean {
  return Array.isArray(playbook.flow) && (playbook.flow as CompositeStep[]).some(
    (step) => (step.kind === 'map' || step.kind === 'replicate') && Array.isArray(step.body),
  );
}

/** Pure runnable-frontier projection for the first compositional milestone. */
export function computeCompositeFrontier(playbook: CompositePlaybook, events: RunEvent[]): CompositeFrontier {
  const flow = Array.isArray(playbook.flow) ? playbook.flow as CompositeStep[] : [];
  const byId = new Map<string, CompositeStep>();
  const owned = new Set<string>();
  for (const step of flow) {
    if (typeof step.id === 'string') byId.set(step.id, step);
    if ((step.kind === 'map' || step.kind === 'loop' || step.kind === 'replicate') && Array.isArray(step.body)) {
      for (const id of step.body) if (typeof id === 'string') owned.add(id);
    }
  }
  const roots = flow.flatMap((step) => typeof step.id === 'string' && !owned.has(step.id) ? [step.id] : []);
  const ctx: Context = { byId, roots, events, instances: new Map() };
  const result = evalSequence(ctx, roots, null);
  return {
    actions: result.actions,
    instances: [...ctx.instances.values()],
    complete: result.state === 'completed',
    failed: result.state === 'failed' || result.state === 'exhausted',
  };
}

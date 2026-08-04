import { resolveActiveArtifacts, type ActiveArtifact } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
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
}

export interface StepView {
  id: string;
  state: 'done' | 'current' | 'failed' | 'waiting';
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

/**
 * The legible run projection: logical steps, decisions, failures, and active
 * artifacts — grown from workflow progress, not raw event volume. Raw events
 * remain available for drill-down.
 */
export interface ShowProjection {
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
  state: 'requested' | 'running' | 'completed' | 'failed';
  agentId: string | null;
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
  const projection = mode === 'current' ? projectRun(run, events) : null;
  return { run, mode, events, badLines: raw.badLines, artifacts, projection };
}

function projectRun(run: RunSummary, events: RunEvent[]): ShowProjection {
  const stepOrder: string[] = [];
  const byStep = new Map<string, StepView>();
  const view = (id: string): StepView => {
    let v = byStep.get(id);
    if (!v) {
      v = {
        id,
        state: 'done',
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

  const decisions: { step: string | null; branch: string }[] = [];
  const failures: string[] = [];
  const requests = projectHostRequests(events);
  const callsByStep = new Map<string, Set<string>>();
  const pendingDecisions = new Map<string, string>(); // decision_id → step
  let lastStarted: string | null = null;

  for (const event of events) {
    if (event.step != null) view(event.step);
    switch (event.type) {
      case 'step_started':
        if (event.step != null) lastStarted = event.step;
        break;
      case 'artifact_created':
        if (event.step != null) view(event.step).artifacts += 1;
        break;
      case 'gate_evaluated': {
        const condition = typeof event.extra.condition === 'string' ? event.extra.condition : '?';
        const result = typeof event.extra.result === 'string' ? event.extra.result : '?';
        if (event.step != null) view(event.step).gates.push({ condition, result });
        if (result === 'fail') {
          const artifact = typeof event.extra.artifact === 'string' ? ` (${event.extra.artifact})` : '';
          failures.push(`gate ${condition} → fail${artifact}`);
        }
        break;
      }
      case 'loop_iteration_started':
        if (event.step != null) view(event.step).iterations += 1;
        break;
      case 'human_decision': {
        const branch = typeof event.extra.branch === 'string' ? event.extra.branch : '?';
        if (event.step != null) view(event.step).decisions.push(branch);
        decisions.push({ step: event.step, branch });
        break;
      }
      case 'actor_dispatched': {
        if (event.step == null) break;
        const v = view(event.step);
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
        break;
      }
      case 'decision_requested': {
        const id = typeof event.extra.decision_id === 'string' ? event.extra.decision_id : null;
        if (id != null && event.step != null) pendingDecisions.set(id, event.step);
        break;
      }
      case 'decision_resolved': {
        const id = typeof event.extra.decision_id === 'string' ? event.extra.decision_id : null;
        if (id != null) pendingDecisions.delete(id);
        const option = typeof event.extra.option === 'string' ? event.extra.option : '?';
        if (event.step != null) view(event.step).decisions.push(option);
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

  if (lastStarted != null) {
    const last = view(lastStarted);
    if (run.status === 'running') last.state = 'current';
    else if (run.status === 'failed' || run.status === 'aborted') last.state = 'failed';
  }

  for (const [stepId, calls] of callsByStep) view(stepId).actorCalls = calls.size;
  if (run.status === 'running' || run.status == null) {
    for (const stepId of pendingDecisions.values()) view(stepId).state = 'waiting';
  }

  const { active } = resolveActiveArtifacts(events);
  return { steps: stepOrder.map((id) => byStep.get(id)!), active, decisions, failures, requests };
}

function projectHostRequests(events: RunEvent[]): HostRequestView[] {
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
    out.push({
      dispatchId,
      step: event.step ?? '?',
      actor: typeof event.extra.actor === 'string' ? event.extra.actor : null,
      executor: typeof event.extra.executor === 'string' ? event.extra.executor : '?',
      model: typeof event.extra.model === 'string' ? event.extra.model : null,
      reasoningEffort: typeof event.extra.reasoning_effort === 'string' ? event.extra.reasoning_effort : null,
      state: terminal?.type === 'actor_completed' ? 'completed' : terminal?.type === 'actor_failed' ? 'failed' : start ? 'running' : 'requested',
      agentId: typeof start?.extra.agent_id === 'string' ? start.extra.agent_id : null,
    });
  }
  return out;
}

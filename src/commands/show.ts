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
  /** Read a pre-0.2 ledger in explicit compatibility mode. */
  legacy?: boolean;
  cwd?: string;
  repoRoot?: string;
}

export interface StepView {
  id: string;
  state: 'done' | 'current' | 'failed';
  artifacts: number;
  gates: { condition: string; result: string }[];
  iterations: number;
  decisions: string[];
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
}

export interface ShowResult {
  run: RunSummary;
  mode: LedgerMode;
  events: RunEvent[];
  badLines: number[];
  artifacts: { path: string; bytes: number }[];
  /** Null in legacy mode — pre-0.2 ledgers get only the raw timeline. */
  projection: ShowProjection | null;
}

/** Resolve a run and return its summary, projection, timeline, and artifacts. */
export function runShow(opts: ShowOptions): ShowResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const run = resolveRun(repoRoot, opts.run);
  const mode = ledgerMode(run, opts.legacy === true);
  const raw = readEvents(run.dir);
  const events = mode === 'legacy' ? normalizeLegacyEvents(raw.events) : raw.events;
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
      v = { id, state: 'done', artifacts: 0, gates: [], iterations: 0, decisions: [] };
      byStep.set(id, v);
      stepOrder.push(id);
    }
    return v;
  };

  const decisions: { step: string | null; branch: string }[] = [];
  const failures: string[] = [];
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

  const { active } = resolveActiveArtifacts(events);
  return { steps: stepOrder.map((id) => byStep.get(id)!), active, decisions, failures };
}

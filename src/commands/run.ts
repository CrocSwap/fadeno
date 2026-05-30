import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { findRepoRoot } from '../lib/paths.ts';

export class RunError extends Error {}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
const VALID_STATUSES = new Set(['running', ...TERMINAL_STATUSES]);
const RUN_YAML_MODELINE = '# yaml-language-server: $schema=../../schemas/run.schema.json';

export interface RunOptions {
  /** Run id (under .fadeno/runs) or a path to a run directory / run.yaml. */
  run: string;
  /** Set current_step and append a `step_started` event. */
  step?: string;
  /** Set status; terminal statuses also set ended_at and append a `run_<status>` event. */
  status?: string;
  /** Append a custom event of this type. */
  event?: string;
  /** Artifact path to attach (with --event, or alone as an `artifact_created` event). */
  artifact?: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface RunResult {
  runDir: string;
  appendedEvents: string[];
  updatedFields: string[];
}

function resolveRunDir(repoRoot: string, cwd: string, run: string): string {
  const candidates = isAbsolute(run)
    ? [run]
    : [join(repoRoot, '.fadeno', 'runs', run), resolve(cwd, run)];
  for (const candidate of candidates) {
    const dir = candidate.endsWith('run.yaml') ? candidate.slice(0, -'run.yaml'.length) : candidate;
    if (existsSync(join(dir, 'run.yaml'))) return dir;
  }
  throw new RunError(`No run found for "${run}" (looked for run.yaml under .fadeno/runs).`);
}

/**
 * Update a run ledger: set `current_step`/`status` in run.yaml and append
 * lifecycle events to events.jsonl. This keeps the agent (or a script) from
 * hand-editing JSONL.
 */
export function runRun(opts: RunOptions): RunResult {
  if (!opts.step && !opts.status && !opts.event && !opts.artifact) {
    throw new RunError('Nothing to do: pass --step, --status, --event, and/or --artifact.');
  }

  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const runDir = resolveRunDir(repoRoot, cwd, opts.run);
  const runYamlPath = join(runDir, 'run.yaml');
  const eventsPath = join(runDir, 'events.jsonl');

  const run = parseYaml(readFileSync(runYamlPath, 'utf8')) as Record<string, unknown>;
  const iso = (opts.now ?? new Date()).toISOString();
  const appendedEvents: string[] = [];
  const updatedFields: string[] = [];

  const appendEvent = (event: Record<string, unknown>): void => {
    appendFileSync(eventsPath, `${JSON.stringify({ ...event, timestamp: iso })}\n`, 'utf8');
    appendedEvents.push(event.type as string);
  };

  if (opts.step) {
    run.current_step = opts.step;
    updatedFields.push('current_step');
    appendEvent({ type: 'step_started', step: opts.step });
  }

  if (opts.event) {
    const event: Record<string, unknown> = { type: opts.event, step: opts.step ?? null };
    if (opts.artifact) event.artifact = opts.artifact;
    appendEvent(event);
  } else if (opts.artifact) {
    appendEvent({ type: 'artifact_created', step: opts.step ?? null, artifact: opts.artifact });
  }

  if (opts.status) {
    if (!VALID_STATUSES.has(opts.status)) {
      throw new RunError(
        `Invalid status "${opts.status}". Use one of: ${[...VALID_STATUSES].join(', ')}.`,
      );
    }
    run.status = opts.status;
    updatedFields.push('status');
    if (TERMINAL_STATUSES.has(opts.status)) {
      run.ended_at = iso;
      updatedFields.push('ended_at');
      run.current_step = null;
      appendEvent({ type: `run_${opts.status}`, step: null });
    }
  }

  writeFileSync(runYamlPath, `${RUN_YAML_MODELINE}\n${stringifyYaml(run)}`, 'utf8');
  return { runDir, appendedEvents, updatedFields };
}

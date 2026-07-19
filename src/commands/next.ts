import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { computeNext, FlowCursorError, type NextComputation } from '../lib/flow-cursor.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet, validateFile } from '../lib/playbook-validate.ts';
import type { Playbook } from '../lib/prompt-resolve.ts';
import {
  ledgerMode,
  normalizeLegacyEvents,
  readEventsStrict,
  resolveRun,
  RunLedgerError,
  type LedgerMode,
} from '../lib/run-ledger.ts';

export class NextError extends Error {}

export interface NextOptions {
  run: string;
  /** Read a pre-0.2 ledger in explicit compatibility mode. */
  legacy?: boolean;
  cwd?: string;
  repoRoot?: string;
}

export interface NextResult extends NextComputation {
  run: string;
  playbook: string;
}

function locatePlaybook(repoRoot: string, name: string): string {
  const dir = join(repoRoot, '.fadeno', 'playbooks');
  for (const candidate of [`${name}.yaml`, `${name}.yml`]) {
    const path = join(dir, candidate);
    if (existsSync(path)) return path;
  }
  throw new NextError(`Playbook "${name}" not found in ${dir}.`);
}

/**
 * Read-only flow cursor: pure function of the validated playbook + run ledger
 * events. Emits the single next actionable step (or a blocked/terminal state).
 * Writes nothing — no event, no snapshot.
 */
export function runNext(opts: NextOptions): NextResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);

  let run;
  try {
    run = resolveRun(repoRoot, opts.run);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new NextError(err.message);
    throw err;
  }

  if (run.playbook == null) {
    throw new NextError(`run "${run.runId}" has no playbook recorded in run.yaml.`);
  }

  // Version gate BEFORE the terminal short-circuit below — a legacy terminal
  // run must refuse loudly rather than silently succeed without ever reading
  // its events.
  let mode: LedgerMode;
  try {
    mode = ledgerMode(run, opts.legacy === true);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new NextError(err.message);
    throw err;
  }

  // Trust run.yaml.status as authoritative for terminal short-circuit. This is
  // deliberately *not* a pure event walk: a completed/failed/aborted status
  // wins even if events.jsonl is incomplete or disagrees (the origin-run failure
  // mode was the inverse — events present, status lagging). Callers that need
  // an events-only cursor should use `computeNext` directly.
  if (run.status != null && run.status !== 'running') {
    return {
      run: run.runId,
      playbook: run.playbook,
      status: 'terminal',
      step: null,
      gate: null,
      human_gate: null,
      terminal: { status: run.status, step: null },
      advice: `run is terminal (${run.status}); return the final summary.`,
    };
  }

  let events;
  try {
    events = readEventsStrict(run.dir);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new NextError(err.message);
    throw err;
  }
  if (mode === 'legacy') events = normalizeLegacyEvents(events);

  const playbookPath = locatePlaybook(repoRoot, run.playbook);
  let playbook: Playbook;
  try {
    const parsed = parseYaml(readFileSync(playbookPath, 'utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('playbook is not a mapping');
    }
    playbook = parsed as Playbook;
  } catch (err) {
    throw new NextError(`could not parse playbook ${run.playbook}: ${(err as Error).message}`);
  }

  const schemas = new SchemaSet(join(repoRoot, '.fadeno', 'schemas'));
  const validation = validateFile(playbookPath, schemas, 'playbook');
  const errorIssues = validation.issues.filter((issue) => issue.severity === 'error');
  if (errorIssues.length > 0) {
    const detail = errorIssues.map((issue) => `${issue.path || '/'}: ${issue.message}`).join('; ');
    throw new NextError(`playbook ${run.playbook} is invalid; fix it before asking for the next step: ${detail}`);
  }

  let computation: NextComputation;
  try {
    computation = computeNext(playbook, events);
  } catch (err) {
    if (err instanceof FlowCursorError) throw new NextError(err.message);
    throw err;
  }

  return {
    run: run.runId,
    playbook: typeof playbook.name === 'string' ? playbook.name : run.playbook,
    ...computation,
  };
}

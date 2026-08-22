import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { computeNext, FlowCursorError, type NextComputation } from '../lib/flow-cursor.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { resolveRunPlaybookFile, runSchemaDirectories } from '../lib/definitions.ts';
import { SchemaSet, validateFile } from '../lib/playbook-validate.ts';
import type { Playbook } from '../lib/prompt-resolve.ts';
import { parseSnapshotDocument, loadExecutorProfile } from '../lib/executors.ts';
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
  /** Read a 0.2 or unversioned pre-0.3 ledger in explicit compatibility mode. */
  legacy?: boolean;
  cwd?: string;
  repoRoot?: string;
}

export interface NextResult extends NextComputation {
  run: string;
  playbook: string;
}

function locatePlaybook(runDir: string, repoRoot: string, name: string): string {
  const found = resolveRunPlaybookFile(runDir, repoRoot, name);
  if (found) return found.path;
  throw new NextError(`Playbook "${name}" not found in bundled or project definitions.`);
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
  if (mode !== 'current') events = normalizeLegacyEvents(events);

  const playbookPath = locatePlaybook(run.dir, repoRoot, run.playbook);
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

  const schemaPaths = runSchemaDirectories(run.dir, repoRoot);
  const schemas = new SchemaSet(schemaPaths.snapshot, schemaPaths.project, schemaPaths.builtin);
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

  // Extend advice for tool_call steps to expose exact planned artifact path and tool-run eligibility
  if (computation.status === 'ready' && computation.step?.kind === 'tool_call') {
    const step = computation.step;
    const toolName = step.tool;
    const artifactType = step.artifact_type;
    const outputPath = step.outputs?.[0] ?? null;
    // Registration is the axis, not artifact type. Gating this branch on
    // `artifact_type === 'test-result'` sent a caller to `tool-complete` for a
    // perfectly runnable tool whenever its artifact happened to be untyped,
    // which is every tool step in the shipped `pr-review` starter.
    if (toolName && outputPath) {
      // Check registry eligibility
      let isRegistered = false;
      try {
        const snapshotPath = join(run.dir, 'profile.yaml');
        if (existsSync(snapshotPath)) {
          const snapText = readFileSync(snapshotPath, 'utf8');
          const snap = parseSnapshotDocument(snapText, 'profile.yaml');
          isRegistered = Object.hasOwn(snap.tools, toolName);
        } else {
          try {
            const live = loadExecutorProfile(repoRoot).profile;
            isRegistered = Object.hasOwn(live.tools, toolName);
          } catch {}
        }
      } catch {}
      if (isRegistered) {
        computation.advice = `tool "${toolName}" is registered — run \`fadeno tool-run ${run.runId} --tool ${toolName}\` to execute it (writes ${outputPath}${artifactType === 'test-result' ? ', synthesizing the result from the exit status' : ', capturing stdout as the artifact'}); or record it manually with \`fadeno tool-complete ${run.runId} --output ${outputPath}\`.`;
      } else {
        computation.advice = `tool "${toolName}" is not registered (produces ${artifactType ?? 'unknown'}, planned artifact ${outputPath}) — declare it under \`tools:\` in executors.yaml to run it automatically, or record the result manually with \`fadeno tool-complete ${run.runId} --output ${outputPath}\` (no execution).`;
      }
    } else if (step.tool) {
      const outputPath = step.outputs?.[0] ?? 'the planned artifact';
      computation.advice = `tool "${step.tool}" produces ${artifactType ?? 'unknown'} — declare it under \`tools:\` in executors.yaml to run it automatically, or save the result at ${outputPath} and attribute it with \`fadeno tool-complete ${run.runId} --output ${outputPath}\`.`;
    }
  }

  return {
    run: run.runId,
    playbook: typeof playbook.name === 'string' ? playbook.name : run.playbook,
    ...computation,
  };
}

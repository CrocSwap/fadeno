import { runNext, NextError } from './next.ts';
import { runRun, RunError, type RunResult } from './run.ts';
import { findRepoRoot } from '../lib/paths.ts';

export class ToolCompleteError extends Error {}

export interface ToolCompleteOptions {
  run: string;
  output: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface ToolCompleteResult extends RunResult {
  step: string;
}

/** Atomically attribute a manual tool result to the exact next tool_call step. */
export function runToolComplete(opts: ToolCompleteOptions): ToolCompleteResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  let next;
  try {
    next = runNext({ run: opts.run, cwd: opts.cwd, repoRoot });
  } catch (err) {
    if (err instanceof NextError) throw new ToolCompleteError(err.message);
    throw err;
  }
  if (next.status !== 'ready' || next.step?.kind !== 'tool_call') {
    throw new ToolCompleteError(
      `run "${opts.run}" is not waiting at a tool_call step` +
        (next.step == null ? ` (status ${next.status}).` : `; next is ${next.step.id} (${next.step.kind}).`),
    );
  }
  try {
    const result = runRun({
      run: opts.run,
      step: next.step.id,
      event: 'artifact_created',
      artifact: opts.output,
      cwd: opts.cwd,
      repoRoot,
      now: opts.now,
    });
    return { ...result, step: next.step.id };
  } catch (err) {
    if (err instanceof RunError) throw new ToolCompleteError(err.message);
    throw err;
  }
}

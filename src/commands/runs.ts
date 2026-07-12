import { findRepoRoot } from '../lib/paths.ts';
import { listRuns, type RunSummary } from '../lib/run-ledger.ts';

export interface RunsOptions {
  cwd?: string;
  repoRoot?: string;
}

export interface RunsResult {
  repoRoot: string;
  runs: RunSummary[];
}

/** List run ledgers under `.fadeno/runs/` (empty list is fine). */
export function runRuns(opts: RunsOptions = {}): RunsResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  return { repoRoot, runs: listRuns(repoRoot) };
}

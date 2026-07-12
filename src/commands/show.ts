import { findRepoRoot } from '../lib/paths.ts';
import {
  listArtifacts,
  readEvents,
  resolveRun,
  type RunEvent,
  type RunSummary,
} from '../lib/run-ledger.ts';

export interface ShowOptions {
  run: string;
  cwd?: string;
  repoRoot?: string;
}

export interface ShowResult {
  run: RunSummary;
  events: RunEvent[];
  badLines: number[];
  artifacts: { path: string; bytes: number }[];
}

/** Resolve a run and return its summary, timeline, and artifacts. */
export function runShow(opts: ShowOptions): ShowResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const run = resolveRun(repoRoot, opts.run);
  const { events, badLines } = readEvents(run.dir);
  const artifacts = listArtifacts(run.dir);
  return { run, events, badLines, artifacts };
}

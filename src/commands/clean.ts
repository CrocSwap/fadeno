import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';

export interface CleanOptions { cwd?: string; repoRoot?: string; force?: boolean }
export interface CleanResult { repoRoot: string; candidates: string[]; removed: string[]; dryRun: boolean }

/** Preview by default; --force removes only ignored runtime state, never definitions/evidence. */
export function runClean(opts: CleanOptions = {}): CleanResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const candidates = [
    join(repoRoot, '.fadeno', 'runs'),
    join(repoRoot, '.fadeno', 'progress'),
    join(repoRoot, '.fadeno', 'local'),
    join(repoRoot, '.fadeno', 'dispatches.jsonl'),
  ].filter(existsSync);
  const removed: string[] = [];
  if (opts.force) {
    for (const path of candidates) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return { repoRoot, candidates, removed, dryRun: !opts.force };
}

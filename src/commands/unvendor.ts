import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';

export class UnvendorError extends Error {}
export interface UnvendorOptions { cwd?: string; repoRoot?: string; force?: boolean }
export interface UnvendorResult { repoRoot: string; removed: string[]; preserved: string[]; lockRemoved: boolean }

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function runUnvendor(opts: UnvendorOptions = {}): UnvendorResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const lockPath = join(repoRoot, 'fadeno.lock');
  if (!existsSync(lockPath)) throw new UnvendorError('fadeno.lock is missing; refusing an ownership-blind unvendor.');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { files?: Record<string, string> };
  if (lock.files == null) throw new UnvendorError('fadeno.lock predates managed file ownership; re-run `fadeno vendor --force` first.');
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const [rel, expected] of Object.entries(lock.files)) {
    const path = resolve(repoRoot, rel);
    const back = relative(repoRoot, path).split('\\').join('/');
    if (back.startsWith('../') || isAbsolute(back) || !existsSync(path)) continue;
    if (opts.force || digest(path) === expected) {
      rmSync(path, { force: true });
      removed.push(path);
    } else preserved.push(path);
  }
  const lockRemoved = preserved.length === 0 || Boolean(opts.force);
  if (lockRemoved) rmSync(lockPath, { force: true });
  return { repoRoot, removed, preserved, lockRemoved };
}

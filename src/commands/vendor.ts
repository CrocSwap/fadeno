import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runInit, type InitResult, type Target } from './init.ts';
import { emitFile, type EmitResult } from '../lib/fsutil.ts';
import { findRepoRoot, packageVersion, templatesDir } from '../lib/paths.ts';

export class VendorError extends Error {}

export interface VendorOptions {
  target: Target;
  withHooks?: boolean;
  withSteering?: boolean;
  force?: boolean;
  cwd?: string;
  repoRoot?: string;
}

export interface VendorResult {
  target: Target;
  repoRoot: string;
  init: InitResult;
  lockPath: string;
  lock: EmitResult;
}

function makeVendoredCodexAgentsTrackable(repoRoot: string): void {
  const path = join(repoRoot, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const rules = ['!.codex/agents/worker.toml', '!.codex/agents/reviewer.toml', '!.codex/agents/judge.toml'];
  const missing = rules.filter((rule) => !current.split(/\r?\n/).includes(rule));
  if (missing.length === 0) return;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${current}${separator}# Fadeno: explicitly vendored Codex brokers\n${missing.join('\n')}\n`, 'utf8');
}

function digestTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files[relative(root, full).split('\\').join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  walk(root);
  return files;
}

function ownedVendoredFiles(repoRoot: string, init: InitResult): Record<string, string> {
  const owned: Record<string, string> = {};
  // Own every byte-emitted init result except shared/merged surfaces. The lock
  // digest still preserves later edits; these exclusions avoid ever treating a
  // user's bootstrap, ignore policy, or merged Claude settings as wholly ours.
  const shared = new Set(['AGENTS.md', 'CLAUDE.md', '.gitignore', '.claude/settings.local.json']);
  for (const result of init.results) {
    if (result.status !== 'created' && result.status !== 'overwritten') continue;
    const rel = relative(repoRoot, result.path).split('\\').join('/');
    if (shared.has(rel) || rel.startsWith('../') || !existsSync(result.path)) continue;
    owned[rel] = createHash('sha256').update(readFileSync(result.path)).digest('hex');
  }
  return owned;
}

/** Explicitly vendor capability/definitions into a repository with a lock. */
export function runVendor(opts: VendorOptions): VendorResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const init = runInit({
    target: opts.target,
    repoRoot,
    force: opts.force,
    withHooks: opts.withHooks,
    withSteering: opts.withSteering ?? opts.target !== 'grok',
  });
  if (opts.target === 'codex') makeVendoredCodexAgentsTrackable(repoRoot);
  const lockPath = join(repoRoot, 'fadeno.lock');
  const lockDoc = {
    version: 1,
    fadeno_version: packageVersion(),
    target: opts.target,
    mode: 'vendored',
    definitions: digestTree(join(templatesDir(), 'common', 'fadeno')),
    capability: digestTree(join(templatesDir(), opts.target)),
    files: ownedVendoredFiles(repoRoot, init),
  };
  const lock = emitFile(lockPath, `${JSON.stringify(lockDoc, null, 2)}\n`, opts.force ?? false);
  return { target: opts.target, repoRoot, init, lockPath, lock: { path: lockPath, status: lock } };
}

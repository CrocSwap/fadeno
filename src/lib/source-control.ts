import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FADENO_IGNORE_PATTERNS = [
  '.fadeno/runs/',
  '.fadeno/progress/',
  '.fadeno/local/',
  '.fadeno/dispatches.jsonl',
  '.codex/agents/worker.toml',
  '.codex/agents/reviewer.toml',
  '.codex/agents/judge.toml',
  '.codex/agents/fadeno-*.toml',
  '.claude/settings.local.json',
] as const;

export function isFadenoPathIgnored(lines: string[], pattern: string): boolean {
  if (lines.includes(pattern)) return true;
  if (pattern.startsWith('.fadeno/') && (lines.includes('.fadeno') || lines.includes('.fadeno/'))) return true;
  if (pattern.startsWith('.codex/') && (lines.includes('.codex') || lines.includes('.codex/'))) return true;
  if (pattern.startsWith('.claude/') && (lines.includes('.claude') || lines.includes('.claude/'))) return true;
  return false;
}

/** Add the managed Fadeno block without touching unrelated .gitignore bytes. */
export function ensureFadenoIgnore(repoRoot: string): boolean {
  const path = join(repoRoot, '.gitignore');
  const existed = existsSync(path);
  const content = existed ? readFileSync(path, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const missing = FADENO_IGNORE_PATTERNS.filter((pattern) => !isFadenoPathIgnored(lines, pattern));
  if (missing.length === 0) return false;
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${sep}# Fadeno: local generated files (not committed)\n${missing.join('\n')}\n`;
  writeFileSync(path, content + block, 'utf8');
  return true;
}

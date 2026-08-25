import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Exact OpenCode files emitted by Fadeno's project-scoped steering apply. */
export const OPENCODE_IGNORE_PATTERNS = [
  '.opencode/agent/worker.md',
  '.opencode/agent/reviewer.md',
  '.opencode/agent/judge.md',
  '.opencode/agent/fadeno-dispatch-worker.md',
  '.opencode/agent/fadeno-dispatch-reviewer.md',
  '.opencode/agent/fadeno-dispatch-judge.md',
  '.opencode/agent/fadeno-steering-refused-worker.md',
  '.opencode/agent/fadeno-steering-refused-reviewer.md',
  '.opencode/agent/fadeno-steering-refused-judge.md',
  '.opencode/plugin/fadeno-steering.js',
  '.opencode/plugin/fadeno-dispatch-tool.js',
] as const;

/** Exact omp files emitted by Fadeno's project-scoped steering apply. */
export const OMP_IGNORE_PATTERNS = [
  '.omp/agents/worker.md',
  '.omp/agents/reviewer.md',
  '.omp/agents/judge.md',
  '.omp/agents/fadeno-dispatch-worker.md',
  '.omp/agents/fadeno-dispatch-reviewer.md',
  '.omp/agents/fadeno-dispatch-judge.md',
  '.omp/agents/fadeno-steering-host-worker.md',
  '.omp/agents/fadeno-steering-host-reviewer.md',
  '.omp/agents/fadeno-steering-host-judge.md',
  '.omp/agents/fadeno-steering-command-worker.md',
  '.omp/agents/fadeno-steering-command-reviewer.md',
  '.omp/agents/fadeno-steering-command-judge.md',
  '.omp/agents/fadeno-steering-refused-worker.md',
  '.omp/agents/fadeno-steering-refused-reviewer.md',
  '.omp/agents/fadeno-steering-refused-judge.md',
  '.omp/agents/fadeno-steering-refusal-worker.md',
  '.omp/agents/fadeno-steering-refusal-reviewer.md',
  '.omp/agents/fadeno-steering-refusal-judge.md',
  '.omp/extensions/fadeno-steering.ts',
] as const;

const OPENCODE_IGNORE_BEGIN = '# fadeno:opencode-steering:begin';
const OPENCODE_IGNORE_END = '# fadeno:opencode-steering:end';
const OMP_IGNORE_BEGIN = '# fadeno:omp-steering:begin';
const OMP_IGNORE_END = '# fadeno:omp-steering:end';

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
  if (pattern.startsWith('.opencode/') && (lines.includes('.opencode') || lines.includes('.opencode/'))) return true;
  if (pattern.startsWith('.omp/') && (lines.includes('.omp') || lines.includes('.omp/'))) return true;
  return false;
}

/** Return only OpenCode paths that currently contain Fadeno's ownership mark. */
export function openCodeManagedIgnorePatterns(repoRoot: string): string[] {
  return OPENCODE_IGNORE_PATTERNS.filter((pattern) => {
    const path = join(repoRoot, pattern);
    if (!existsSync(path)) return false;
    const marker = pattern === '.opencode/plugin/fadeno-steering.js' || pattern === '.opencode/plugin/fadeno-dispatch-tool.js'
      ? '// fadeno:managed'
      : '<!-- fadeno:managed';
    try {
      return readFileSync(path, 'utf8').includes(marker);
    } catch {
      return false;
    }
  });
}

function ensureIgnorePatterns(repoRoot: string, patterns: readonly string[]): boolean {
  const path = join(repoRoot, '.gitignore');
  const existed = existsSync(path);
  const content = existed ? readFileSync(path, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const missing = patterns.filter((pattern) => !isFadenoPathIgnored(lines, pattern));
  if (missing.length === 0) return false;
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${sep}# Fadeno: local generated files (not committed)\n${missing.join('\n')}\n`;
  writeFileSync(path, content + block, 'utf8');
  return true;
}

function replaceOpenCodeIgnoreBlock(content: string, patterns: readonly string[]): string {
  const block = patterns.length === 0
    ? ''
    : `${OPENCODE_IGNORE_BEGIN}\n${patterns.join('\n')}\n${OPENCODE_IGNORE_END}\n`;
  const markerStart = content.indexOf(OPENCODE_IGNORE_BEGIN);
  if (markerStart < 0) {
    if (block === '') return content;
    const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    return `${content}${separator}${block}`;
  }

  const lineStart = content.lastIndexOf('\n', markerStart - 1) + 1;
  const markerEnd = content.indexOf(OPENCODE_IGNORE_END, markerStart + OPENCODE_IGNORE_BEGIN.length);
  if (markerEnd < 0) return content;
  let suffixStart = markerEnd + OPENCODE_IGNORE_END.length;
  if (content.startsWith('\r\n', suffixStart)) suffixStart += 2;
  else if (content.startsWith('\n', suffixStart)) suffixStart += 1;
  return `${content.slice(0, lineStart)}${block}${content.slice(suffixStart)}`;
}

/** Add the managed Fadeno block without touching unrelated .gitignore bytes. */
export function ensureFadenoIgnore(repoRoot: string): boolean {
  return ensureIgnorePatterns(repoRoot, FADENO_IGNORE_PATTERNS);
}

/** Add ignores only for OpenCode files that were actually materialized by Fadeno. */
export function ensureOpenCodeFadenoIgnore(repoRoot: string): boolean {
  const path = join(repoRoot, '.gitignore');
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const updated = replaceOpenCodeIgnoreBlock(content, openCodeManagedIgnorePatterns(repoRoot));
  if (updated === content) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

/** Return only omp paths that currently contain Fadeno's ownership mark. */
export function ompManagedIgnorePatterns(repoRoot: string): string[] {
  return OMP_IGNORE_PATTERNS.filter((pattern) => {
    const path = join(repoRoot, pattern);
    if (!existsSync(path)) return false;
    const marker = pattern.endsWith('.ts') ? '// fadeno:managed' : '<!-- fadeno:managed';
    try {
      return readFileSync(path, 'utf8').includes(marker);
    } catch {
      return false;
    }
  });
}

function replaceOmpIgnoreBlock(content: string, patterns: readonly string[]): string {
  const block = patterns.length === 0 ? '' : `${OMP_IGNORE_BEGIN}\n${patterns.join('\n')}\n${OMP_IGNORE_END}\n`;
  const markerStart = content.indexOf(OMP_IGNORE_BEGIN);
  if (markerStart < 0) {
    if (block === '') return content;
    const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    return `${content}${separator}${block}`;
  }
  const lineStart = content.lastIndexOf('\n', markerStart - 1) + 1;
  const markerEnd = content.indexOf(OMP_IGNORE_END, markerStart + OMP_IGNORE_BEGIN.length);
  if (markerEnd < 0) return content;
  let suffixStart = markerEnd + OMP_IGNORE_END.length;
  if (content.startsWith('\r\n', suffixStart)) suffixStart += 2;
  else if (content.startsWith('\n', suffixStart)) suffixStart += 1;
  return `${content.slice(0, lineStart)}${block}${content.slice(suffixStart)}`;
}

/** Add or refresh only exact managed omp paths in a marker-bounded block. */
export function ensureOmpFadenoIgnore(repoRoot: string): boolean {
  const path = join(repoRoot, '.gitignore');
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const updated = replaceOmpIgnoreBlock(content, ompManagedIgnorePatterns(repoRoot));
  if (updated === content) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

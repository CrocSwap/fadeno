import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type EmitStatus = 'created' | 'overwritten' | 'appended' | 'skipped';

export interface EmitResult {
  /** Absolute path of the affected file. */
  path: string;
  status: EmitStatus;
}

/**
 * Write `content` to `absPath`, creating parent directories as needed.
 * Existing files are left untouched unless `force` is set.
 */
export function emitFile(absPath: string, content: string, force: boolean): EmitStatus {
  const exists = existsSync(absPath);
  if (exists && !force) return 'skipped';
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
  return exists ? 'overwritten' : 'created';
}

/**
 * Recursively copy a template directory tree to a destination, honouring the
 * skip/overwrite rules of {@link emitFile}. A template file literally named
 * `gitkeep` is emitted as `.gitkeep` (npm does not reliably publish dotfiles,
 * so they are stored un-dotted in the template tree).
 */
export function copyTree(
  srcDir: string,
  destDir: string,
  force: boolean,
  results: EmitResult[],
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destName = entry.name === 'gitkeep' ? '.gitkeep' : entry.name;
    const destPath = join(destDir, destName);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath, force, results);
    } else {
      const content = readFileSync(srcPath, 'utf8');
      results.push({ path: destPath, status: emitFile(destPath, content, force) });
    }
  }
}

const FADENO_BEGIN = '<!-- fadeno:begin (managed by fadeno init — edit above/below, not inside) -->';
const FADENO_END = '<!-- fadeno:end -->';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Add a Fadeno section to a bootstrap file (AGENTS.md / CLAUDE.md) without
 * clobbering existing content. The section is wrapped in marker comments so
 * re-running `init` is idempotent:
 *   - file absent          -> create it with the wrapped section
 *   - markers absent        -> append the wrapped section
 *   - markers present       -> skip (or replace the block when `force`)
 */
export function emitBootstrap(
  absPath: string,
  section: string,
  force: boolean,
  results: EmitResult[],
): void {
  const block = `${FADENO_BEGIN}\n\n${section.trim()}\n\n${FADENO_END}\n`;

  if (!existsSync(absPath)) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, block, 'utf8');
    results.push({ path: absPath, status: 'created' });
    return;
  }

  const existing = readFileSync(absPath, 'utf8');
  const hasBlock = existing.includes(FADENO_BEGIN);

  if (hasBlock) {
    if (!force) {
      results.push({ path: absPath, status: 'skipped' });
      return;
    }
    const blockRe = new RegExp(
      `${escapeRegExp(FADENO_BEGIN)}[\\s\\S]*?${escapeRegExp(FADENO_END)}\\n?`,
    );
    writeFileSync(absPath, existing.replace(blockRe, block), 'utf8');
    results.push({ path: absPath, status: 'overwritten' });
    return;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(absPath, existing + separator + block, 'utf8');
  results.push({ path: absPath, status: 'appended' });
}

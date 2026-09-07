import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Version baked in by esbuild (`--define`) when building the standalone plugin
// binary; absent in the normal ESM build, where we read package.json instead.
declare const __FADENO_VERSION__: string;

// `__dirname` exists in the esbuild CJS bundle (the plugin binary); in the ESM
// dev/dist build it's absent and we use import.meta.url. `typeof` is safe on an
// undeclared identifier, so this resolves correctly under both module systems.
const moduleDir =
  typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from `startDir` looking for a file or directory named `name`.
 * Returns the absolute path to the match, or null if the filesystem root is
 * reached without finding it.
 */
export function findUp(name: string, startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate the bundled `templates/` directory.
 *
 * `templates/` is a sibling of both `src/` (dev) and `dist/` (built), so a
 * fixed `../../templates` relative to this module resolves correctly in both
 * cases (src/lib/paths.ts and dist/lib/paths.js are at the same depth).
 */
export function templatesDir(): string {
  const candidates = [
    resolve(moduleDir, 'templates'), // bundled binary: <bin>/templates (plugin/bin)
    resolve(moduleDir, '../templates'),
    resolve(moduleDir, '../../templates'), // dev (src/lib) and built (dist/lib)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fallback: find the package root and look for templates beside it.
  const pkg = findUp('package.json', moduleDir);
  if (pkg) {
    const beside = join(dirname(pkg), 'templates');
    if (existsSync(beside)) return beside;
  }
  throw new Error(
    'Could not locate the Fadeno templates directory. Is the package installed correctly?',
  );
}

/**
 * Determine the repository root by walking up for a `.git` directory.
 * Falls back to `startDir` when not inside a git repository.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  const gitPath = findUp('.git', startDir);
  if (gitPath) return mainRepoRoot(gitPath);
  return resolve(startDir);
}

/**
 * The repository a `.git` entry belongs to. A linked worktree carries a `.git`
 * FILE (`gitdir: <main>/.git/worktrees/<name>`) rather than a directory, and a
 * dispatch running inside one — a director in its worktree spawning workers —
 * must still find the main repository: that is where `.fadeno/` and the ledger
 * live, and a worktree is gitignored scratch that never holds either.
 */
function mainRepoRoot(gitPath: string): string {
  try {
    if (statSync(gitPath).isDirectory()) return dirname(gitPath);
    const pointer = readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (pointer) {
      const gitDir = resolve(dirname(gitPath), pointer);
      const common = gitDir.match(/^(.*)[\\/]worktrees[\\/][^\\/]+[\\/]?$/)?.[1];
      if (common) return dirname(common);
    }
  } catch {
    // unreadable: fall through to the directory that holds the entry
  }
  return dirname(gitPath);
}

/** Read this package's version from its own package.json. */
export function packageVersion(): string {
  if (typeof __FADENO_VERSION__ === 'string') return __FADENO_VERSION__;
  const pkgPath = findUp('package.json', moduleDir);
  if (!pkgPath) return '0.0.0';
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

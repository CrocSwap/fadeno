import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { activeHarness } from '../lib/executors.ts';
import { unclosedDispatches } from '../lib/ledger.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { codexUserAgentDir, userPaths, type UserPathOptions } from '../lib/user-paths.ts';
import { runDialShow, type EffectiveRow } from './dial.ts';
import { runWorktrees, type WorktreeEntry } from './dispatches.ts';

export class StatusError extends Error {}

export interface StatusOptions {
  verbose?: boolean;
  target?: 'codex' | 'claude' | 'opencode' | 'omp' | null;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
}

/**
 * An agent definition someone wrote by hand whose name Fadeno also routes.
 *
 * Fadeno materializes nothing, so any file here is the user's own. It is
 * reported rather than touched, because on a harness whose agent file wins
 * over the value a spawn passes — Codex — such a file silently overrides the
 * dial, which is the one integration failure a person cannot see from
 * outside.
 */
export interface ShadowingAgentFile {
  path: string;
  archetype: string;
  harness: 'claude' | 'codex';
  scope: 'user' | 'project';
}

export interface StatusResult {
  repoRoot: string;
  version: string;
  /** The host this session is inside; `standalone` from a bare shell. */
  harness: 'codex' | 'claude' | 'grok' | 'opencode' | 'omp' | 'standalone' | null;
  /** Effective routing, from the same table `fadeno dial` prints. */
  routing: EffectiveRow[];
  /** Archetypes whose dial no longer resolves, with the resolver's reason. */
  unresolved: Array<{ archetype: string; reason: string }>;
  /** Where the CLI is linked, and whether that link still leads anywhere. */
  link: { path: string; target: string | null; state: 'linked' | 'missing' | 'foreign' };
  agentFiles: ShadowingAgentFile[];
  /** Worktrees holding work that is not on HEAD, or that could not be read. */
  worktrees: WorktreeEntry[];
  unclosed: number;
  projectCustomized: boolean;
  verbose: boolean;
  /** Everything above that needs a person, in the order to deal with it. */
  attention: string[];
}

function linkState(path: string): StatusResult['link'] {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return { path, target: null, state: 'foreign' };
    const target = readlinkSync(path);
    return { path, target, state: existsSync(target) ? 'linked' : 'foreign' };
  } catch {
    return { path, target: null, state: 'missing' };
  }
}

/**
 * The agent name a definition file DECLARES, which is not always its filename.
 *
 * The one that matters: `~/.codex/agents/fadeno-worker.toml` declares
 * `name = "worker"`, so it answers a `worker` spawn while looking, from the
 * directory listing, like it could not. A check that probed filenames missed
 * exactly the files an earlier Fadeno had written.
 */
function declaredAgentName(path: string, ext: string): string {
  const fallback = basename(path, ext);
  let text: string;
  try {
    text = readFileSync(path, 'utf8').slice(0, 4096);
  } catch {
    return fallback;
  }
  const declared = ext === '.toml'
    ? /^\s*name\s*=\s*["']([^"'\n]+)["']/m.exec(text)
    : /^name:\s*([^\n]+)$/m.exec(text);
  return declared?.[1]?.trim() || fallback;
}

/**
 * Agent files whose name Fadeno routes, in the four places the two
 * hook-capable harnesses read them from.
 *
 * The directory is listed rather than probed, and each file is asked what it
 * calls itself — see `declaredAgentName`.
 */
function shadowingAgentFiles(
  repoRoot: string,
  archetypes: readonly string[],
  options: UserPathOptions | undefined,
): ShadowingAgentFile[] {
  const home = options?.home ?? homedir();
  const env = options?.env ?? process.env;
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  const roots: Array<{ dir: string; harness: 'claude' | 'codex'; scope: 'user' | 'project'; ext: string }> = [
    { dir: join(claudeHome, 'agents'), harness: 'claude', scope: 'user', ext: '.md' },
    { dir: join(repoRoot, '.claude', 'agents'), harness: 'claude', scope: 'project', ext: '.md' },
    { dir: codexUserAgentDir(options), harness: 'codex', scope: 'user', ext: '.toml' },
    { dir: join(repoRoot, '.codex', 'agents'), harness: 'codex', scope: 'project', ext: '.toml' },
  ];
  // `dispatch` is on the list because the spawn hook prefers a bare `dispatch`
  // agent where one exists: a file by that name is not shadowing the proxy, it
  // IS the proxy, and a person should know which one is running.
  const routed = new Set([...archetypes, 'dispatch']);
  const found: ShadowingAgentFile[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root.dir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(root.ext)) continue;
      const path = join(root.dir, entry);
      const archetype = declaredAgentName(path, root.ext);
      if (!routed.has(archetype)) continue;
      found.push({ path, archetype, harness: root.harness, scope: root.scope });
    }
  }
  return found;
}

function holdsWork(tree: WorktreeEntry): boolean {
  if (tree.dirty === 'unavailable' || tree.unmerged === 'unavailable') return true;
  return tree.dirty.paths.length > 0 || tree.unmerged > 0;
}

/**
 * What routing this repo has, whether the integration around it is intact,
 * and what needs a person.
 *
 * The routing half is `runDialShow` rather than a second resolver: `status`
 * telling a different story from `dial` about the same repo is the failure
 * this codebase keeps finding, and one call is the only durable fix.
 */
export function runStatus(opts: StatusOptions = {}): StatusResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const harness = activeHarness(opts.target ?? undefined, opts.userPathOptions);
  let shown;
  try {
    shown = runDialShow({ repoRoot, userPathOptions: opts.userPathOptions });
  } catch (err) {
    throw new StatusError((err as Error).message);
  }
  const link = linkState(userPaths(opts.userPathOptions).linkPath);
  const agentFiles = shadowingAgentFiles(repoRoot, shown.rows.map((row) => row.archetype), opts.userPathOptions);
  const worktrees = runWorktrees({ repoRoot }).filter(holdsWork);
  const unclosed = unclosedDispatches(repoRoot).length;

  const attention: string[] = [];
  // "Does my dial resolve to something real" — the first of the two checks the
  // doctor left behind. A dial that does not resolve, and one that resolves to
  // a model this session can neither host nor spawn, fail it in different ways.
  for (const stale of shown.staleDials) {
    attention.push(`${stale.archetype} does not resolve — ${stale.reason}`);
  }
  for (const row of shown.rows) {
    if (row.deliverable) continue;
    attention.push(
      `${row.archetype} has no lane from here: it routes to ${row.model}, which this session can neither deliver in-session nor run as a process.`,
    );
  }
  if (link.state === 'missing') {
    attention.push(`no \`fadeno\` linked at ${link.path} — run \`fadeno setup\` to link it onto PATH.`);
  } else if (link.state === 'foreign') {
    attention.push(`${link.path} is not a link Fadeno wrote, or points at a CLI that is gone — rerun \`fadeno setup\`.`);
  }
  for (const file of agentFiles) {
    attention.push(
      `${file.path} defines the agent "${file.archetype}" (${file.scope} scope, ${file.harness}). ` +
        (file.harness === 'codex'
          ? 'A Codex agent file wins over the model a spawn passes, so it overrides the dial.'
          : 'It supplies the prompt and tools for that spawn, whatever the dial says.'),
    );
  }
  if (worktrees.length > 0) {
    attention.push(`${worktrees.length} worktree(s) hold work that is not on HEAD — \`fadeno worktrees\` lists them.`);
  }
  if (unclosed > 0) {
    attention.push(`${unclosed} dispatch(es) are still open — \`fadeno dispatches\` lists them.`);
  }

  return {
    repoRoot,
    version: packageVersion(),
    harness,
    routing: shown.rows,
    unresolved: shown.staleDials,
    link,
    agentFiles,
    worktrees,
    unclosed,
    projectCustomized: existsSync(join(repoRoot, '.fadeno')),
    verbose: Boolean(opts.verbose),
    attention,
  };
}

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { CODEX_AGENT_MARKER, codexAgentFile, codexAgentFilename } from '../lib/codex-agents.ts';
import { BUILTIN_ARCHETYPE_DESCRIPTIONS } from '../lib/contracts.ts';
import { loadExecutorProfile } from '../lib/executors.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import {
  codexUserAgentDir,
  retiredStateDirs,
  retiredStateFiles,
  userPaths,
  type FadenoUserPaths,
  type UserPathOptions,
} from '../lib/user-paths.ts';

export class SetupError extends Error {}

export type SetupTarget = 'codex' | 'claude' | null;

export interface SetupOptions {
  target?: SetupTarget;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  probeCommand?: (command: string) => CommandProbe;
  /**
   * The CLI to link. Normally the one running this command — the plugin's
   * bundled `bin/fadeno`, published to the launcher environment as
   * `FADENO_BUNDLED_RUNTIME`.
   */
  source?: string | null;
  /** Replace a `fadeno` at the link path that Fadeno did not put there. */
  force?: boolean;
}

export interface CommandProbe {
  name: string;
  command: string;
  available: boolean;
  version: string | null;
}

export interface SetupLink {
  path: string;
  target: string;
  action: 'created' | 'retargeted' | 'unchanged';
  /** Whether the link's directory is on this shell's PATH. */
  onPath: boolean;
}

export interface SetupResult {
  target: SetupTarget;
  repoRoot: string;
  paths: FadenoUserPaths;
  probes: CommandProbe[];
  link: SetupLink;
  /** Retired state this setup swept, if any. */
  removed: string[];
  /** Codex agent files written: the archetype vocabulary a Codex host spawns by. */
  codexAgents: string[];
  permission: { path: string; rule: string } | null;
  notices: string[];
}

const PROBES: Array<{ name: string; command: string }> = [
  { name: 'codex', command: 'codex' },
  { name: 'claude', command: 'claude' },
  { name: 'grok', command: 'grok' },
];

function probe(command: string): CommandProbe {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return {
    name: command,
    command,
    available: result.error == null && result.status === 0,
    version: output.length > 0 ? output.split(/\r?\n/, 1)[0] ?? null : null,
  };
}

/**
 * The marker at the top of every agent file Fadeno writes.
 *
 * `writeCodexAgents` writes this version's set; the sweep takes any OTHER
 * managed file — an archetype that is no longer builtin, or a project-scope
 * copy from a Fadeno that wrote them there. A file carrying the marker is
 * Fadeno's to remove, and on Codex a stale one is worse than litter: if it
 * declares a `model`, that model wins over the one the spawn passes and
 * silently overrides the dial it was written to serve.
 */
const MANAGED_AGENT_MARKER = CODEX_AGENT_MARKER;

/** The agent files this version stands behind, by filename. */
function ourCodexAgentFiles(): Set<string> {
  return new Set(Object.keys(BUILTIN_ARCHETYPE_DESCRIPTIONS).map((archetype) => codexAgentFilename(archetype)));
}

/**
 * Write the archetype vocabulary Codex reads agent types from.
 *
 * Runs after the sweep, so the files that exist afterwards are this version's.
 * A failure here is a notice, never a thrown setup: linking the CLI is what
 * `setup` promised, and a home directory Fadeno cannot write to should not
 * cost the user that.
 */
function writeCodexAgents(options: UserPathOptions | undefined, notices: string[]): string[] {
  const dir = codexUserAgentDir(options);
  const written: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    for (const [archetype, description] of Object.entries(BUILTIN_ARCHETYPE_DESCRIPTIONS)) {
      const path = join(dir, codexAgentFilename(archetype));
      writeFileSync(path, codexAgentFile(archetype, description), 'utf8');
      written.push(path);
    }
  } catch (err) {
    notices.push(
      `could not write the Codex agent files under ${dir} (${(err as Error).message}). ` +
        'Codex spawns cannot name an archetype without them, so host mode there will route every spawn to the command lane.',
    );
    return written;
  }
  notices.push(
    `Codex archetype vocabulary written to ${dir} (${written.length} agents, spawned as \`fadeno-<archetype>\`). ` +
      'They declare no model: the dial rides the spawn, so routing stays live.',
  );
  return written;
}

/**
 * Managed agent files this version does not write, in the two places Fadeno
 * has written them. The user-scope files it DOES write are left for
 * `writeCodexAgents` to overwrite: sweeping them would make every setup report
 * removing the files it is about to put back.
 */
function sweepManagedAgents(repoRoot: string, options: UserPathOptions | undefined): string[] {
  const removed: string[] = [];
  const userDir = codexUserAgentDir(options);
  const ours = ourCodexAgentFiles();
  for (const dir of [userDir, join(repoRoot, '.codex', 'agents')]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.toml')) continue;
      if (dir === userDir && ours.has(entry)) continue;
      const path = join(dir, entry);
      try {
        if (!readFileSync(path, 'utf8').startsWith(MANAGED_AGENT_MARKER)) continue;
      } catch {
        continue;
      }
      rmSync(path, { force: true });
      removed.push(path);
    }
  }
  return removed;
}

/**
 * Setup used to record its `--codex`/`--claude` target as "your harness", and
 * to copy the CLI into a managed runtime directory it then version-compared
 * against the plugin. Both are gone. A file nothing consults is a lie on disk
 * waiting to be believed, so removing the readers was only half the change.
 */
function sweepRetiredState(paths: FadenoUserPaths): string[] {
  const removed: string[] = [];
  for (const path of retiredStateFiles(paths)) {
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    rmSync(path, { force: true });
    removed.push(path);
  }
  for (const dir of retiredStateDirs(paths)) {
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/** The CLI this process is running, resolved through any symlink. */
function runningCli(env: NodeJS.ProcessEnv): string | null {
  const bundled = env.FADENO_BUNDLED_RUNTIME?.trim();
  if (bundled && existsSync(join(bundled, 'fadeno'))) return join(bundled, 'fadeno');
  const argv1 = process.argv[1];
  if (argv1 == null) return null;
  try {
    return realpathSync(resolve(argv1));
  } catch {
    return resolve(argv1);
  }
}

function onPath(dir: string, env: NodeJS.ProcessEnv): boolean {
  const entries = (env.PATH ?? '').split(delimiter).filter((part) => part.length > 0);
  return entries.some((entry) => {
    try {
      return realpathSync(entry) === realpathSync(dir);
    } catch {
      return resolve(entry) === resolve(dir);
    }
  });
}

/** A Windows shim: it NAMES the CLI rather than duplicating it. */
function windowsShim(target: string): string {
  return ['@echo off', `"${process.execPath}" "${target}" %*`, ''].join('\r\n');
}

/**
 * Point `<binDir>/fadeno` at the CLI that is running.
 *
 * A LINK, never a copy. Two copies of one CLI on disk is a version-skew
 * problem, and the machinery that reconciled them — version comparison, an
 * installation manifest, a preferred-cli line in `status` — was fifteen
 * hundred lines answering a question this one call removes: the link is
 * whatever the plugin currently holds, always.
 *
 * Windows gets a shim instead, for the same reason and because symlinks there
 * need privileges.
 */
function linkCli(paths: FadenoUserPaths, target: string, options: UserPathOptions | undefined, force: boolean): SetupLink {
  const windows = (options?.platform ?? process.platform) === 'win32';
  const path = paths.linkPath;
  mkdirSync(paths.binDir, { recursive: true });
  const env = options?.env ?? process.env;
  const FOREIGN = ' foreign';
  const current = (() => {
    try {
      const stat = lstatSync(path);
      if (windows) return stat.isFile() ? readFileSync(path, 'utf8') : FOREIGN;
      return stat.isSymbolicLink() ? readlinkSync(path) : FOREIGN;
    } catch {
      return null;
    }
  })();
  const want = windows ? windowsShim(target) : target;
  if (current === want) return { path, target, action: 'unchanged', onPath: onPath(paths.binDir, env) };
  if (current === FOREIGN && !force) {
    throw new SetupError(
      `${path} exists and is not something Fadeno wrote. Remove it, choose another directory with FADENO_BIN_DIR, or rerun with --force to replace it.`,
    );
  }
  if (current != null) rmSync(path, { force: true });
  if (windows) writeFileSync(path, want, 'utf8');
  else symlinkSync(target, path);
  return { path, target, action: current == null ? 'created' : 'retargeted', onPath: onPath(paths.binDir, env) };
}

/**
 * Let Claude run `fadeno` without asking each time.
 *
 * Scoped to the one command, added to the user's own settings, and named in
 * the notice so the grant is never silent. Every Fadeno subcommand is a read
 * or a record; the one that removes anything (`clean --force`) refuses a
 * worktree holding uncommitted work.
 */
function ensureClaudePermission(
  options: UserPathOptions | undefined,
  notices: string[],
): { path: string; rule: string } | null {
  const env = options?.env ?? process.env;
  const settingsPath = join(env.CLAUDE_CONFIG_DIR?.trim() || join(options?.home ?? homedir(), '.claude'), 'settings.json');
  let data: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        notices.push(`Claude user settings ${settingsPath} are not an object; permission setup left them untouched.`);
        return null;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      notices.push(`Claude user settings ${settingsPath} are malformed; permission setup left them untouched.`);
      return null;
    }
  }
  const permissions = data.permissions == null
    ? {}
    : typeof data.permissions === 'object' && !Array.isArray(data.permissions)
      ? data.permissions as Record<string, unknown>
      : null;
  if (permissions == null || (permissions.allow != null && !Array.isArray(permissions.allow))) {
    notices.push(`Claude permission settings in ${settingsPath} have an unexpected shape; they were left untouched.`);
    return null;
  }
  const allow = [...(permissions.allow as unknown[] | undefined ?? [])];
  const rule = 'Bash(fadeno:*)';
  if (allow.includes(rule)) return { path: settingsPath, rule };
  allow.push(rule);
  permissions.allow = allow;
  data.permissions = permissions;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  notices.push(`Claude user permission added so agents can run the CLI without a prompt each time: ${rule} in ${settingsPath}`);
  return { path: settingsPath, rule };
}

/** Link the CLI onto PATH, and probe the harnesses this machine can reach. */
export function runSetup(opts: SetupOptions = {}): SetupResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const paths = userPaths(opts.userPathOptions);
  const env = opts.userPathOptions?.env ?? process.env;
  const probeCommand = opts.probeCommand ?? probe;
  const probes = PROBES.map((item) => probeCommand(item.command));
  const notices: string[] = [];

  // The catalog is read before anything is written: a setup that links a CLI
  // which then refuses to load this repo's config has helped nobody.
  try {
    loadExecutorProfile(repoRoot, opts.userPathOptions).profile;
  } catch (err) {
    throw new SetupError((err as Error).message);
  }

  const source = opts.source !== undefined ? opts.source : runningCli(env);
  if (source == null || !existsSync(source)) {
    throw new SetupError(
      `cannot find the CLI to link${source == null ? '' : ` at ${source}`} — run \`fadeno setup\` from the plugin's own CLI, or pass --from <bin-dir>.`,
    );
  }
  const link = linkCli(paths, source, opts.userPathOptions, opts.force ?? false);
  const removed = [...sweepRetiredState(paths), ...sweepManagedAgents(repoRoot, opts.userPathOptions)];
  // After the sweep, never before: the sweep takes every managed file, and
  // these are the ones this version stands behind.
  const codexAgents = writeCodexAgents(opts.userPathOptions, notices);
  const permission = opts.target === 'claude' ? ensureClaudePermission(opts.userPathOptions, notices) : null;

  // Name the target, and say what it means rather than what it usually means:
  // the link follows whatever CLI ran setup. Run from the plugin's launcher it
  // follows the plugin; run from a checkout it follows that checkout. Claiming
  // the first unconditionally would be a sentence that is sometimes false, and
  // the whole reason for a link over a copy is that nobody has to wonder.
  notices.unshift(
    `Fadeno ${packageVersion()} linked at ${link.path} -> ${link.target}. It is a link, not a copy: \`fadeno\` runs whatever is at that path, ` +
      "so there is no second CLI to keep in step. Run setup from the plugin's own launcher to point it at the plugin instead.",
  );
  if (!link.onPath) {
    notices.push(`${paths.binDir} is not on this shell's PATH — add it, or the \`fadeno\` command will not be found.`);
  }
  notices.push(`User configuration and state live under ${paths.configDir} and ${paths.stateDir}; project files were not changed.`);
  for (const path of removed) {
    notices.push(
      path.endsWith('.toml')
        ? `Removed the agent file ${path}, which an earlier Fadeno materialized and this one does not write. On Codex a stale file that declares a model overrides the dial.`
        : `Removed retired state ${path} (nothing reads it).`,
    );
  }
  notices.push('Skills and subagents are loaded at host session start; a fresh session is required to pick up a new plugin version.');

  return { target: opts.target ?? null, repoRoot, paths, probes, link, removed, codexAgents, permission, notices };
}

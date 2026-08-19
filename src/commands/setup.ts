import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runSteeringApply, type SteeringApplyResult } from './steering.ts';
import { loadExecutorProfile } from '../lib/executors.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { userPaths, type FadenoUserPaths, type UserPathOptions } from '../lib/user-paths.ts';
import {
  syncManagedRuntime,
  readInstallationManifest,
  recordHarnessInstallation,
  writeInstallationManifest,
  sourceBundleVersion,
  type ManagedPermissionRule,
  type RuntimeSyncOutcome,
} from '../lib/installations.ts';

export class SetupError extends Error {}

export type SetupTarget = 'codex' | 'claude' | null;

export interface SetupOptions {
  target?: SetupTarget;
  nonInteractive?: boolean;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  probeCommand?: (command: string) => CommandProbe;
  /** Plugin `bin/` directory; normally supplied by its launcher environment. */
  runtimeSource?: string | null;
  /** Explicit flag to allow downgrade */
  resetRuntime?: boolean;
}

export interface CommandProbe {
  name: string;
  command: string;
  available: boolean;
  version: string | null;
}

export interface SetupResult {
  target: SetupTarget;
  repoRoot: string;
  paths: FadenoUserPaths;
  probes: CommandProbe[];
  created: string[];
  activeLoadout: string;
  steering: SteeringApplyResult | null;
  restartRequired: boolean;
  notices: string[];
  runtimeRefresh: {
    outcome: RuntimeSyncOutcome;
    from: string | null;
    to: string | null;
  };
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

function rememberHarness(paths: FadenoUserPaths, target: Exclude<SetupTarget, null>, created: string[]): void {
  const body = `${target}\n`;
  if (existsSync(paths.harnessFile) && readFileSync(paths.harnessFile, 'utf8') === body) return;
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.harnessFile, body, 'utf8');
  created.push(paths.harnessFile);
}

function ensureClaudePermission(
  paths: FadenoUserPaths,
  options: UserPathOptions | undefined,
  notices: string[],
): ManagedPermissionRule | null {
  if (!existsSync(paths.managedCli)) return null;
  const env = options?.env ?? process.env;
  const settingsPath = join(env.CLAUDE_CONFIG_DIR?.trim() || join(options?.home ?? homedir(), '.claude'), 'settings.json');
  const createdFile = !existsSync(settingsPath);
  let data: Record<string, unknown> = {};
  if (!createdFile) {
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
  if (/[\r\n)]/.test(paths.managedCli)) {
    notices.push(`Managed runtime path ${paths.managedCli} cannot be represented safely in a Claude permission rule.`);
    return null;
  }
  const rule = `Bash(${paths.managedCli}:*)`;
  if (allow.includes(rule)) return null;
  allow.push(rule);
  permissions.allow = allow;
  data.permissions = permissions;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  notices.push(`Claude user permission added for the managed Fadeno runtime only: ${rule}`);
  return { path: settingsPath, rule, createdFile };
}

function inferBundledRuntimeForRemediation(userPathOptions?: UserPathOptions): string | null {
  const env = userPathOptions?.env ?? process.env;
  if (env.FADENO_BUNDLED_RUNTIME && existsSync(join(env.FADENO_BUNDLED_RUNTIME, 'fadeno'))) {
    return env.FADENO_BUNDLED_RUNTIME;
  }
  try {
    const argv1 = process.argv[1];
    if (argv1) {
      const dir = dirname(resolve(argv1));
      // check if dir contains fadeno and package.json marker
      if (existsSync(join(dir, 'fadeno')) && existsSync(join(dir, 'package.json'))) {
        return dir;
      }
      // also check realpath
      try {
        const real = realpathSync(argv1);
        const realDir = dirname(resolve(real));
        if (existsSync(join(realDir, 'fadeno'))) return realDir;
      } catch {}
    }
  } catch {}
  return null;
}

/** One explicit, read-only-probe setup action for user-scoped integration. */
export function runSetup(opts: SetupOptions = {}): SetupResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const paths = userPaths(opts.userPathOptions);
  const probeCommand = opts.probeCommand ?? probe;
  const probes = PROBES.map((item) => probeCommand(item.command));
  const created: string[] = [];
  const setupNotices: string[] = [];
  const manifestExisted = existsSync(paths.installationsFile);
  const manifest = readInstallationManifest(opts.userPathOptions);
  const runtimeSource = opts.runtimeSource !== undefined
    ? opts.runtimeSource
    : (opts.userPathOptions?.env ?? process.env).FADENO_BUNDLED_RUNTIME ?? null;
  let syncOutcome: RuntimeSyncOutcome = 'absent';
  let syncFrom: string | null = null;
  let syncTo: string | null = null;
  try {
    const res = syncManagedRuntime(paths, runtimeSource, manifest, {
      allowInstall: true,
      trustSource: true,
      force: Boolean(opts.resetRuntime),
    });
    syncOutcome = res.outcome;
    syncFrom = res.from;
    syncTo = res.to;
    if (res.outcome === 'installed' || res.outcome === 'refreshed') {
      if (!created.includes(paths.managedRuntimeDir)) created.push(paths.managedRuntimeDir);
    }
  } catch (err) {
    throw err;
  }
  if (opts.target != null) rememberHarness(paths, opts.target, created);

  try {
    loadExecutorProfile(repoRoot, opts.userPathOptions).profile;
  } catch (err) {
    throw new SetupError((err as Error).message);
  }

  let steering: SteeringApplyResult | null = null;
  if (opts.target === 'codex') {
    steering = (runSteeringApply as any)({
      repoRoot,
      target: 'codex',
      scope: 'user',
      userPathOptions: opts.userPathOptions,
      cliPath: existsSync(paths.managedCli) ? paths.managedCli : undefined,
    });
  }
  const priorPermissionRules = opts.target == null ? [] : manifest.harnesses[opts.target]?.permissionRules ?? [];
  const addedPermission = opts.target === 'claude'
    ? ensureClaudePermission(paths, opts.userPathOptions, setupNotices)
    : null;
  if (opts.target != null) {
    const managedFiles = steering?.results
      .map((item) => item.path)
      .filter((path) => existsSync(path) && readFileSync(path, 'utf8').startsWith('# fadeno:managed')) ?? [];
    const permissionRules = (addedPermission == null ? priorPermissionRules : [...priorPermissionRules, addedPermission])
      .filter((item, index, all) => all.findIndex((other) => other.path === item.path && other.rule === item.rule) === index);
    recordHarnessInstallation(
      paths,
      opts.target,
      managedFiles,
      manifest,
      permissionRules,
    );
    if (!manifestExisted && !created.includes(paths.installationsFile)) created.push(paths.installationsFile);
  } else if (manifest.runtime != null) {
    if (!existsSync(paths.installationsFile)) {
      writeInstallationManifest(paths, manifest);
      if (!manifestExisted && !created.includes(paths.installationsFile)) created.push(paths.installationsFile);
    }
  }

  const invokingVersion = packageVersion();
  const managedVersion = manifest.runtime?.version ?? null;
  const remediationDir = inferBundledRuntimeForRemediation(opts.userPathOptions);
  const fromFlag = remediationDir ? ` --from ${remediationDir}` : ' --from <bin-dir>';
  const targetFlag = opts.target ? ` --${opts.target}` : '';

  const notices: string[] = [
    `Fadeno ${invokingVersion} is using bundled definitions; project files remain optional.`,
    `User configuration and state live under ${paths.configDir} and ${paths.stateDir}; project files were not changed.`,
  ];

  if (syncOutcome === 'installed') {
    notices.push(`Managed runtime installed at ${manifest.runtime!.path} (${manifest.runtime!.version})`);
  } else if (syncOutcome === 'refreshed') {
    notices.push(`Managed runtime refreshed ${syncFrom} -> ${syncTo} at ${manifest.runtime!.path}`);
  } else if (syncOutcome === 'current') {
    if (manifest.runtime) notices.push(`Managed runtime: ${manifest.runtime.path} (${manifest.runtime.version})`);
  } else if (syncOutcome === 'kept-newer') {
    let sourceReadable: string | null = null;
    try {
      sourceReadable = runtimeSource ? sourceBundleVersion(runtimeSource) : null;
    } catch {}
    if (sourceReadable == null && runtimeSource != null) {
      notices.push(`source version unreadable or unparseable at ${runtimeSource}; managed runtime ${managedVersion} kept — use --from <bin-dir> with a valid source or --reset-runtime to mirror this plugin`);
    } else {
      notices.push(`managed runtime ${managedVersion} is newer than this plugin ${invokingVersion}; kept — use --reset-runtime to mirror this plugin`);
    }
  } else if (syncOutcome === 'locked') {
    notices.push(`another fadeno process is refreshing the managed runtime; rerun if status still reports skew`);
  } else if (syncOutcome === 'skipped-no-source') {
    if (managedVersion) {
      notices.push(`managed runtime NOT refreshed — it is ${managedVersion} and this CLI is ${invokingVersion}. Run: fadeno setup${targetFlag}${fromFlag}`);
    } else if (remediationDir) {
      notices.push(`managed runtime not installed — run: fadeno setup${targetFlag}${fromFlag}`);
    } else {
      notices.push(`managed runtime not installed — no source available; run from a plugin bundle or use --from <bin-dir>`);
    }
  } else if (syncOutcome === 'absent') {
    if (manifest.runtime) notices.push(`Managed runtime: ${manifest.runtime.path}`);
  }

  notices.push(...setupNotices);

  if (opts.target === 'claude') {
    notices.push('Claude steering is installed by the plugin and remains inert while the host-native base is active.');
  }
  if (opts.target === 'codex') notices.push('Codex managed agents are user-scoped; start a fresh Codex session to load them.');
  if (!opts.nonInteractive) notices.push('External command dials remain opt-in; setup selected safe host-native base.');

  // Add session definitions notice (point 7)
  notices.push('Skills and subagents are loaded at host session start; a fresh session is required to refresh them — no setup or refresh will update the current session.');

  return {
    target: opts.target ?? null,
    repoRoot,
    paths,
    probes,
    created,
    activeLoadout: 'host-native base',
    steering,
    restartRequired: steering?.restartRequired ?? false,
    notices,
    runtimeRefresh: { outcome: syncOutcome, from: syncFrom, to: syncTo },
  };
}

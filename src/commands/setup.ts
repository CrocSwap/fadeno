import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runSteeringApply, type SteeringApplyResult } from './steering.ts';
import { loadExecutorProfile, type ExecutorProfile } from '../lib/executors.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { userPaths, type FadenoUserPaths, type UserPathOptions } from '../lib/user-paths.ts';
import { ensureFadenoIgnore } from '../lib/source-control.ts';

export class SetupError extends Error {}

export type SetupTarget = 'codex' | 'claude' | null;

export interface SetupOptions {
  target?: SetupTarget;
  nonInteractive?: boolean;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  probeCommand?: (command: string) => CommandProbe;
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

function validUserYaml(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SetupError(`user executor configuration ${path} did not parse: ${(err as Error).message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SetupError(`user executor configuration ${path} must be a mapping; it was left untouched.`);
  }
  return parsed as Record<string, unknown>;
}

function generatedUserCatalog(probes: CommandProbe[]): Record<string, unknown> | null {
  const executors: Record<string, unknown> = {};
  for (const item of probes) {
    if (!item.available) continue;
    const executor = `${item.name}-cli`;
    const command = item.name === 'codex'
      ? ['codex', 'exec', '-']
      : item.name === 'claude'
        ? ['claude', '-p']
        : ['grok', 'build', '-'];
    executors[executor] = { adapter: 'command', command, model: `${item.name}-cli` };
  }
  if (Object.keys(executors).length === 0) return null;
  // Ready, named patterns live in the bundled catalog. User setup only records
  // provider command overrides; it never invents a cross-provider routing
  // policy from probe order.
  return { executors };
}

function ensureUserCatalog(paths: FadenoUserPaths, probes: CommandProbe[], created: string[]): void {
  const current = validUserYaml(paths.executorsFile);
  if (current != null) {
    // Existing user configuration is authoritative and never rewritten by setup.
    return;
  }
  const generated = generatedUserCatalog(probes);
  if (generated == null) return;
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.executorsFile, stringifyYaml(generated), 'utf8');
  created.push(paths.executorsFile);
}

function ensureNativeState(paths: FadenoUserPaths, created: string[]): void {
  if (existsSync(paths.loadoutFile)) return;
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.loadoutFile, 'native\n', 'utf8');
  created.push(paths.loadoutFile);
}

function rememberHarness(paths: FadenoUserPaths, target: Exclude<SetupTarget, null>, created: string[]): void {
  const body = `${target}\n`;
  if (existsSync(paths.harnessFile) && readFileSync(paths.harnessFile, 'utf8') === body) return;
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.harnessFile, body, 'utf8');
  created.push(paths.harnessFile);
}

/** One explicit, read-only-probe setup action for user-scoped integration. */
export function runSetup(opts: SetupOptions = {}): SetupResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const paths = userPaths(opts.userPathOptions);
  const probeCommand = opts.probeCommand ?? probe;
  const probes = PROBES.map((item) => probeCommand(item.command));
  const created: string[] = [];
  if (ensureFadenoIgnore(repoRoot)) created.push(`${repoRoot}/.gitignore`);
  ensureUserCatalog(paths, probes, created);
  if (opts.target != null) rememberHarness(paths, opts.target, created);

  // Compose before pinning. A self-contained legacy project profile remains
  // authoritative and may not declare the bundled `native` loadout; planting
  // a global stale pin would make its first dispatch/drive fail hard.
  let profile: ExecutorProfile;
  try {
    profile = loadExecutorProfile(repoRoot, opts.userPathOptions).profile;
  } catch (err) {
    throw new SetupError((err as Error).message);
  }
  const hasNative = profile.loadouts.native != null;
  if (hasNative) ensureNativeState(paths, created);

  let steering: SteeringApplyResult | null = null;
  if (opts.target === 'codex' && hasNative) {
    steering = runSteeringApply({
      repoRoot,
      loadout: 'native',
      target: 'codex',
      scope: 'user',
      userPathOptions: opts.userPathOptions,
    });
  }
  const notices: string[] = [
    `Fadeno ${packageVersion()} is using bundled definitions; project files remain optional.`,
    `User configuration was written under ${paths.configDir}; restart the current session if host integration was installed.`,
  ];
  if (opts.target === 'claude') {
    notices.push('Claude steering is installed by the plugin and remains inert while the native loadout is active.');
  }
  if (opts.target === 'codex') notices.push('Codex managed agents are user-scoped; start a fresh Codex session to load them.');
  if (!opts.nonInteractive) notices.push('External command loadouts remain opt-in; setup selected safe native defaults.');
  if (!hasNative) notices.push('The active project profile does not declare native, so setup preserved its existing selection and wrote no stale user pin.');
  return {
    target: opts.target ?? null,
    repoRoot,
    paths,
    probes,
    created,
    activeLoadout: hasNative ? 'native' : profile.defaultLoadout ?? Object.keys(profile.loadouts)[0] ?? '',
    steering,
    restartRequired: steering?.restartRequired ?? false,
    notices,
  };
}

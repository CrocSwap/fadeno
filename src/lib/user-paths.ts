import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Inputs used to resolve Fadeno's user-level configuration locations. */
export interface UserPathOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface FadenoUserPaths {
  configHome: string;
  stateHome: string;
  dataHome: string;
  configDir: string;
  stateDir: string;
  dataDir: string;
  executorsFile: string;
  configFile: string;
  loadoutFile: string;
  harnessFile: string;
  installationsFile: string;
  managedRuntimeDir: string;
  managedCli: string;
}

/**
 * Resolve platform-aware user paths without creating anything. The injectable
 * inputs keep commands hermetic and make the precedence rules testable.
 */
export function userPaths(options: UserPathOptions = {}): FadenoUserPaths {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const os = options.platform ?? platform();
  const windows = os === 'win32';
  const configHome = env.FADENO_CONFIG_HOME ??
    (windows ? env.APPDATA : env.XDG_CONFIG_HOME) ??
    join(home, windows ? 'AppData' : '.config');
  const stateHome = env.FADENO_STATE_HOME ??
    (windows ? env.LOCALAPPDATA : env.XDG_STATE_HOME) ??
    (windows ? join(home, 'AppData', 'Local') : join(home, '.local', 'state'));
  const dataHome = env.FADENO_DATA_HOME ??
    (windows ? env.LOCALAPPDATA : env.XDG_DATA_HOME) ??
    (windows ? join(home, 'AppData', 'Local') : join(home, '.local', 'share'));
  const configDir = join(configHome, 'fadeno');
  const stateDir = join(stateHome, 'fadeno');
  const dataDir = join(dataHome, 'fadeno');
  const managedRuntimeDir = join(dataDir, 'runtime');
  return {
    configHome,
    stateHome,
    dataHome,
    configDir,
    stateDir,
    dataDir,
    executorsFile: join(configDir, 'executors.yaml'),
    configFile: join(configDir, 'config.yaml'),
    loadoutFile: join(stateDir, 'loadout'),
    harnessFile: join(stateDir, 'harness'),
    installationsFile: join(stateDir, 'installations.json'),
    managedRuntimeDir,
    managedCli: join(managedRuntimeDir, windows ? 'fadeno.cmd' : 'fadeno'),
  };
}

export type FadenoHarness = 'codex' | 'claude';

/** Read the harness selected by the last targeted setup, if any. */
export function readUserHarness(options: UserPathOptions = {}): FadenoHarness | null {
  const path = userPaths(options).harnessFile;
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value === 'codex' || value === 'claude' ? value : null;
  } catch {
    return null;
  }
}

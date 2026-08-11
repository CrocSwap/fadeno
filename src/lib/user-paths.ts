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
  configDir: string;
  stateDir: string;
  executorsFile: string;
  configFile: string;
  loadoutFile: string;
  harnessFile: string;
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
  const configDir = join(configHome, 'fadeno');
  const stateDir = join(stateHome, 'fadeno');
  return {
    configHome,
    stateHome,
    configDir,
    stateDir,
    executorsFile: join(configDir, 'executors.yaml'),
    configFile: join(configDir, 'config.yaml'),
    loadoutFile: join(stateDir, 'loadout'),
    harnessFile: join(stateDir, 'harness'),
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

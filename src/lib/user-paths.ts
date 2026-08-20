import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  harnessFile: string;
  installationsFile: string;
  managedRuntimeDir: string;
  managedCli: string;
  dialsFile: string;
  modelVerificationsFile: string;
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
    harnessFile: join(stateDir, 'harness'),
    installationsFile: join(stateDir, 'installations.json'),
    managedRuntimeDir,
    managedCli: join(managedRuntimeDir, windows ? 'fadeno.cmd' : 'fadeno'),
    dialsFile: join(stateDir, 'dials.json'),
    modelVerificationsFile: join(stateDir, 'model-verifications.json'),
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

// --- dials file ---

export function readUserDials(options: UserPathOptions = {}): Record<string, { model: string; effort?: string; via?: string; force_write_posture?: true }> {
  const path = userPaths(options).dialsFile;
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return {};
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return {}; }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const out: Record<string, { model: string; effort?: string; via?: string; force_write_posture?: true }> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length === 0) continue;
      let via: string | undefined;
      let core = trimmed;
      const viaIdx = trimmed.indexOf(' via ');
      if (viaIdx >= 0) {
        core = trimmed.slice(0, viaIdx).trim();
        via = trimmed.slice(viaIdx + 5).trim();
      }
      const atIdx = core.indexOf('@');
      if (atIdx >= 0) {
        const model = core.slice(0, atIdx).trim();
        const effort = core.slice(atIdx + 1).trim();
        out[k] = via ? { model, effort, via } : { model, effort };
      } else {
        out[k] = via ? { model: core, via } : { model: core };
      }
    } else if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      const map = v as Record<string, unknown>;
      const model = typeof map.model === 'string' ? map.model.trim() : '';
      if (model.length === 0) continue;
      const entry: { model: string; effort?: string; via?: string; force_write_posture?: true } = { model };
      if (typeof map.effort === 'string' && map.effort.trim().length > 0) entry.effort = map.effort.trim();
      if (typeof map.via === 'string' && map.via.trim().length > 0) entry.via = map.via.trim();
      if (map.force_write_posture === true) entry.force_write_posture = true;
      out[k] = entry;
    }
  }
  return out;
}

export function writeUserDials(options: UserPathOptions, dials: Record<string, { model: string; effort?: string; via?: string; force_write_posture?: true }>): string {
  const path = userPaths(options).dialsFile;
  const keys = Object.keys(dials).sort();
  if (keys.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return path;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  const sorted: Record<string, unknown> = {};
  for (const k of keys) {
    const ref = dials[k]!;
    if (ref.force_write_posture === true) {
      sorted[k] = {
        model: ref.model,
        ...(ref.effort ? { effort: ref.effort } : {}),
        ...(ref.via ? { via: ref.via } : {}),
        force_write_posture: true,
      };
    } else {
      let str = ref.model;
      if (ref.effort) str += `@${ref.effort}`;
      if (ref.via) str += ` via ${ref.via}`;
      sorted[k] = str;
    }
  }
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(sorted).sort()) ordered[k] = sorted[k];
  writeFileSync(path, `${JSON.stringify(ordered)}\n`, 'utf8');
  return path;
}

// --- verification cache ---

export interface ModelVerification {
  driver: string;
  model: string;
  verified_at: string;
}

export function readVerifiedModels(options: UserPathOptions = {}): ModelVerification[] {
  const path = userPaths(options).modelVerificationsFile;
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const out: ModelVerification[] = [];
    for (const entry of parsed) {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const map = entry as Record<string, unknown>;
      if (typeof map.driver !== 'string' || typeof map.model !== 'string' || typeof map.verified_at !== 'string') continue;
      out.push({ driver: map.driver, model: map.model, verified_at: map.verified_at });
    }
    out.sort((a, b) => {
      if (a.driver !== b.driver) return a.driver.localeCompare(b.driver);
      return a.model.localeCompare(b.model);
    });
    return out;
  } catch {
    return [];
  }
}

export function isModelVerified(options: UserPathOptions, driver: string, model: string): boolean {
  const list = readVerifiedModels(options);
  return list.some((e) => e.driver === driver && e.model === model);
}

export function recordVerifiedModel(options: UserPathOptions, entry: ModelVerification): void {
  const path = userPaths(options).modelVerificationsFile;
  const existing = readVerifiedModels(options);
  if (existing.some((e) => e.driver === entry.driver && e.model === entry.model)) return;
  const next = [...existing, entry];
  next.sort((a, b) => {
    if (a.driver !== b.driver) return a.driver.localeCompare(b.driver);
    return a.model.localeCompare(b.model);
  });
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next)}\n`, 'utf8');
}

/**
 * `$CODEX_HOME/agents`, else `<home>/.codex/agents` — where Codex looks for
 * user-scope role agents, and so where `steering apply --codex` writes them,
 * `status` and `doctor` look for them, and `uninstall` removes them.
 *
 * This lived as four hand-copied expressions, and one of them disagreed.
 * Three read `options?.env?.CODEX_HOME ?? process.env.CODEX_HOME`; the fourth
 * bound `env = options?.env ?? process.env` first. In production the two are
 * identical, because nothing in `src/` ever builds a partial `env` — only
 * tests inject one. In a test they are not: under the fall-through spelling an
 * injected env WITHOUT `CODEX_HOME` still picks up the developer's real one,
 * so a suite could read (or claim to remove) agents under a real `~/.codex`.
 *
 * This takes the hermetic spelling, which is also `userPaths`' own convention
 * directly above: an injected env replaces the process env rather than layering
 * over it. Injecting an env means declaring the whole environment.
 */
export function codexUserAgentDir(options: UserPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'agents');
}

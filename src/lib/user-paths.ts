import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
// One-directional at runtime: `executors.ts` imports only TYPES from this
// module, so there is no cycle to break. The dial-ref grammar lives there, and
// a second copy here is exactly how a user dial would start reading
// differently from a catalog dial.
import { formatDialRef, legacyDriverHarness, parseDialRef, type DialRef } from './executors.ts';

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
    installationsFile: join(stateDir, 'installations.json'),
    managedRuntimeDir,
    managedCli: join(managedRuntimeDir, windows ? 'fadeno.cmd' : 'fadeno'),
    dialsFile: join(stateDir, 'dials.json'),
    modelVerificationsFile: join(stateDir, 'model-verifications.json'),
  };
}

/** The harnesses Fadeno *installs into* — the ones `setup`/`uninstall` manage. */
export type FadenoHarness = 'codex' | 'claude';

/**
 * State files Fadeno used to write and no longer reads, listed here only so
 * `setup` and `uninstall` can delete a leftover.
 *
 * `harness` recorded "the harness you last set up" and `activeHarness` used to
 * consult it. It is gone on purpose: people swap harnesses constantly, so a
 * remembered one is a guess dressed as a fact — a bare shell is `standalone`,
 * and a host is only a host when the session is actually inside it (see
 * `activeHarness` in `src/lib/executors.ts`). `loadout` is older still: named
 * loadouts retired in 0.6 and nothing has read it since.
 *
 * A file nothing consults is a lie on disk waiting to be believed, so removing
 * the readers is only half the change — the bytes have to go too.
 */
export function retiredStateFiles(paths: FadenoUserPaths): string[] {
  return [join(paths.stateDir, 'harness'), join(paths.stateDir, 'loadout')];
}

// --- dials file ---

/** Thrown when a user dial file carries a key the dial vocabulary no longer
 * has. Its own class so a caller can tell a stale personal config from an
 * unreadable one — an unreadable dials file degrades to `{}` on purpose, and a
 * removed-key file must NOT. */
export class UserDialsError extends Error {}

export function readUserDials(options: UserPathOptions = {}): Record<string, { model: string; effort?: string; harness?: string }> {
  const path = userPaths(options).dialsFile;
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return {};
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return {}; }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const out: Record<string, { model: string; effort?: string; harness?: string }> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length === 0) continue;
      // One parser for the grammar, so a user dial and a catalog dial cannot
      // read differently — including the legacy ` via <driver>` form, which
      // `parseDialRef` translates to a harness on read and never writes back.
      let ref: DialRef;
      try { ref = parseDialRef(trimmed, `user dial "${k}"`); } catch { continue; }
      out[k] = ref;
    } else if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      const map = v as Record<string, unknown>;
      const model = typeof map.model === 'string' ? map.model.trim() : '';
      if (model.length === 0) continue;
      // Refused, not dropped, and refused HERE rather than left to the profile
      // parser. `parseExecutorProfile` rejects this key with the same pointer,
      // but a user dial never reaches it: `drive` casts this map straight to
      // `DialRef`, so the flag used to ride along invisibly and mean nothing.
      // Silently ignoring a key someone wrote in order to override a guard is
      // the failure the permissions cut exists to end — and the guard it named
      // does not exist any more, so the file is stating something untrue.
      if (map.force_write_posture !== undefined) {
        throw new UserDialsError(
          `user dial "${k}" in ${path} carries "force_write_posture", which is no longer supported — there ` +
            'is no write-posture guard left to override. Remove the key (the dial\'s model/effort/harness are ' +
            'still valid) or re-set the dial with `fadeno dial`. ' +
            'See docs/experimental/permissions-and-isolation.md.',
        );
      }
      const entry: { model: string; effort?: string; harness?: string } = { model };
      if (typeof map.effort === 'string' && map.effort.trim().length > 0) entry.effort = map.effort.trim();
      if (typeof map.harness === 'string' && map.harness.trim().length > 0) entry.harness = map.harness.trim();
      // Legacy mapping form, read only.
      else if (typeof map.via === 'string' && map.via.trim().length > 0) entry.harness = legacyDriverHarness(map.via.trim());
      out[k] = entry;
    }
  }
  return out;
}

export function writeUserDials(options: UserPathOptions, dials: Record<string, { model: string; effort?: string; harness?: string }>): string {
  const path = userPaths(options).dialsFile;
  const keys = Object.keys(dials).sort();
  if (keys.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return path;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  const sorted: Record<string, unknown> = {};
  for (const k of keys) {
    // One shape now. The object form existed only to carry
    // `force_write_posture`, and with that gone every dial is expressible as
    // the `model[@effort][ on <harness>]` string that `formatDialRef` emits.
    sorted[k] = formatDialRef(dials[k]!);
  }
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(sorted).sort()) ordered[k] = sorted[k];
  writeFileSync(path, `${JSON.stringify(ordered)}\n`, 'utf8');
  return path;
}

// --- verification cache ---

export interface ModelVerification {
  /** The executor harness whose `models_command` listed the model. */
  harness: string;
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
      // A cache written before catalog v4 keys on `driver`; the value was
      // always a harness wearing a driver's name, so it reads back as one.
      const harness = typeof map.harness === 'string'
        ? map.harness
        : typeof map.driver === 'string' ? legacyDriverHarness(map.driver) : null;
      if (harness == null || typeof map.model !== 'string' || typeof map.verified_at !== 'string') continue;
      out.push({ harness, model: map.model, verified_at: map.verified_at });
    }
    out.sort((a, b) => {
      if (a.harness !== b.harness) return a.harness.localeCompare(b.harness);
      return a.model.localeCompare(b.model);
    });
    return out;
  } catch {
    return [];
  }
}

export function isModelVerified(options: UserPathOptions, harness: string, model: string): boolean {
  const list = readVerifiedModels(options);
  return list.some((e) => e.harness === harness && e.model === model);
}

export function recordVerifiedModel(options: UserPathOptions, entry: ModelVerification): void {
  const path = userPaths(options).modelVerificationsFile;
  const existing = readVerifiedModels(options);
  if (existing.some((e) => e.harness === entry.harness && e.model === entry.model)) return;
  const next = [...existing, entry];
  next.sort((a, b) => {
    if (a.harness !== b.harness) return a.harness.localeCompare(b.harness);
    return a.model.localeCompare(b.model);
  });
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next)}\n`, 'utf8');
}

/**
 * Drop every cached row the predicate selects, returning how many went.
 *
 * The cache only ever grew: `recordVerifiedModel` adds and `probeModel` reads,
 * so a row that stopped being true stayed on disk vouching for a model the
 * backend no longer lists. Removal is the other half — `models verify` deletes
 * a pair's rows when the listing definitively does not name it, and `model
 * remove` deletes them for an alias that is going away.
 *
 * Same shape the writer above emits: a sorted flat array, one JSON line.
 */
export function removeVerifiedModels(
  options: UserPathOptions,
  predicate: (entry: ModelVerification) => boolean,
): number {
  const path = userPaths(options).modelVerificationsFile;
  const existing = readVerifiedModels(options);
  const kept = existing.filter((entry) => !predicate(entry));
  const removed = existing.length - kept.length;
  if (removed === 0) return 0;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(kept)}\n`, 'utf8');
  return removed;
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

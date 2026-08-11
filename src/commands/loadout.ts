import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ExecutorProfileError,
  loadExecutorProfile,
  LOADOUT_LOCAL_FILE,
  readLocalLoadout,
  readUserLoadout,
  resolveActiveLoadout,
  type ActiveLoadout,
  type ExecutorProfile,
} from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';

export class LoadoutError extends Error {}

/** One archetype slot of a loadout, rendering-ready. */
export interface LoadoutSlotView {
  archetype: string;
  executor: string;
  model: string | null;
  adapter: 'command' | 'host';
}

export interface LoadoutInfo {
  name: string;
  slots: LoadoutSlotView[];
  isDefault: boolean;
  isActive: boolean;
}

export interface LoadoutCommonOptions {
  /** `--loadout` override for this invocation. */
  loadout?: string | null;
  /**
   * `FADENO_LOADOUT` value; injectable for hermetic tests. `undefined` reads
   * the real environment; `null` means explicitly absent.
   */
  env?: string | null;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
}

function repoRootOf(opts: LoadoutCommonOptions): string {
  return opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
}

function envValue(opts: LoadoutCommonOptions): string | null {
  return opts.env !== undefined ? opts.env : process.env.FADENO_LOADOUT ?? null;
}

function loadProfile(repoRoot: string, userPathOptions?: UserPathOptions): ExecutorProfile {
  try {
    return loadExecutorProfile(repoRoot, userPathOptions).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new LoadoutError(err.message);
    throw err;
  }
}

/**
 * Resolution for the inspection commands (show/list): a stale local pin —
 * `.fadeno/local/loadout` naming a since-removed loadout — must not brick the
 * very commands that let the user see what is declared. The pin is treated as
 * absent for resolution and surfaced as `stalePin`; flag/env problems (explicit
 * per-invocation inputs) stay hard errors, as does dispatch-time resolution.
 */
function activeFor(
  opts: LoadoutCommonOptions,
  repoRoot: string,
  profile: ExecutorProfile,
): { active: ActiveLoadout | null; stalePin: string | null } {
  const localValue = readLocalLoadout(repoRoot);
  const userValue = readUserLoadout(opts.userPathOptions);
  const stalePin = localValue != null && !(localValue in profile.loadouts) ? localValue : null;
  const staleUserPin = userValue != null && !(userValue in profile.loadouts) ? userValue : null;
  try {
    const active = resolveActiveLoadout({
      flagValue: opts.loadout ?? null,
      envValue: envValue(opts),
      localFileValue: stalePin == null ? localValue : null,
      userFileValue: staleUserPin == null ? userValue : null,
      profile,
    });
    return { active, stalePin };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new LoadoutError(err.message);
    throw err;
  }
}

function slotViews(profile: ExecutorProfile, name: string): LoadoutSlotView[] {
  const slots = profile.loadouts[name] ?? {};
  return Object.keys(slots)
    .sort()
    .map((archetype) => {
      const executor = slots[archetype]!;
      const spec = profile.executors[executor]!;
      return { archetype, executor, model: spec.model, adapter: spec.adapter };
    });
}

export interface LoadoutShowResult {
  active: ActiveLoadout | null;
  /** Archetype table of the active loadout; empty when none is active. */
  slots: LoadoutSlotView[];
  available: string[];
  defaultLoadout: string | null;
  /** `.fadeno/local/loadout` content when it names an undeclared loadout. */
  stalePin: string | null;
}

/** `fadeno loadout` — the active loadout, its source, and its slot table. */
export function runLoadoutShow(opts: LoadoutCommonOptions = {}): LoadoutShowResult {
  const repoRoot = repoRootOf(opts);
  const profile = loadProfile(repoRoot, opts.userPathOptions);
  const { active, stalePin } = activeFor(opts, repoRoot, profile);
  return {
    active,
    slots: active == null ? [] : slotViews(profile, active.name),
    available: Object.keys(profile.loadouts).sort(),
    defaultLoadout: profile.defaultLoadout,
    stalePin,
  };
}

export interface LoadoutListResult {
  loadouts: LoadoutInfo[];
  active: ActiveLoadout | null;
  defaultLoadout: string | null;
  /** `.fadeno/local/loadout` content when it names an undeclared loadout. */
  stalePin: string | null;
}

/** `fadeno loadout list` — every declared loadout, marking active + default. */
export function runLoadoutList(opts: LoadoutCommonOptions = {}): LoadoutListResult {
  const repoRoot = repoRootOf(opts);
  const profile = loadProfile(repoRoot, opts.userPathOptions);
  const { active, stalePin } = activeFor(opts, repoRoot, profile);
  const loadouts = Object.keys(profile.loadouts)
    .sort()
    .map((name) => ({
      name,
      slots: slotViews(profile, name),
      isDefault: profile.defaultLoadout === name,
      isActive: active?.name === name,
    }));
  return { loadouts, active, defaultLoadout: profile.defaultLoadout, stalePin };
}

export interface LoadoutUseResult {
  name: string;
  /** Absolute path of the sticky session file that was written. */
  path: string;
  /** Previously pinned local name, if any. */
  previous: string | null;
}

/** `fadeno loadout use <name>` — pin the session loadout in `.fadeno/local/loadout`. */
export function runLoadoutUse(opts: LoadoutCommonOptions & { name: string }): LoadoutUseResult {
  const repoRoot = repoRootOf(opts);
  const profile = loadProfile(repoRoot, opts.userPathOptions);
  const name = opts.name.trim();
  if (name.length === 0) throw new LoadoutError('Usage: fadeno loadout use <name>');
  if (!(name in profile.loadouts)) {
    const declared = Object.keys(profile.loadouts).sort();
    throw new LoadoutError(
      `"${name}" is not a declared loadout` +
        (declared.length > 0 ? ` (${declared.join(', ')}).` : ' — the profile has no `loadouts`.'),
    );
  }
  const previous = readLocalLoadout(repoRoot);
  const path = join(repoRoot, LOADOUT_LOCAL_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${name}\n`, 'utf8');
  return { name, path, previous };
}

export interface LoadoutClearResult {
  removed: boolean;
  path: string;
}

/** `fadeno loadout clear` — remove the sticky session file (idempotent). */
export function runLoadoutClear(opts: LoadoutCommonOptions = {}): LoadoutClearResult {
  const repoRoot = repoRootOf(opts);
  const path = join(repoRoot, LOADOUT_LOCAL_FILE);
  const removed = existsSync(path);
  rmSync(path, { force: true });
  return { removed, path };
}

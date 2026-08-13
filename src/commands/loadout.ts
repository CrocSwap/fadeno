import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  applicableOverrides,
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  eligibilityFor,
  explainEligibilityConflict,
  explainWriteConflict,
  loadExecutorProfile,
  LOADOUT_LOCAL_FILE,
  readLocalLoadoutState,
  readUserLoadout,
  resolveActiveLoadout,
  resolveRole,
  writeLocalLoadoutState,
  type ActiveLoadout,
  type EligibilityState,
  type ExecutorProfile,
  type LocalLoadoutState,
  type RoleResolutionSource,
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

/**
 * One row of the *effective* table: the active loadout's slot with any session
 * override already applied. `baseExecutor` is what the loadout itself declares
 * for the archetype — null when it declares nothing, which is exactly the case
 * an override binding a slot-less archetype creates — so a row can always say
 * what it replaced.
 */
export interface LoadoutEffectiveRow extends LoadoutSlotView {
  /** A session override, not the loadout's own slot, supplied `executor`. */
  overridden: boolean;
  baseExecutor: string | null;
  /** Present when the resolved target is not fully eligible for this archetype. */
  eligibility?: EligibilityState;
}

/** A pinned override whose target is no longer a declared executor. */
export interface StaleOverrideView {
  archetype: string;
  target: string;
}

export interface LoadoutInfo {
  name: string;
  /**
   * Declared slots — except for the active loadout, whose rows are the
   * effective table (session overlay applied, `overridden`/`baseExecutor`
   * populated): the listing must show the bindings dispatch would use.
   */
  slots: Array<LoadoutSlotView & Partial<LoadoutEffectiveRow>>;
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

/** Read the sticky pin, restating a malformed-pin error as a command error. */
function readPin(repoRoot: string): LocalLoadoutState {
  try {
    return readLocalLoadoutState(repoRoot);
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
 *
 * `overrides` is the pin's overlay already scoped by the kernel's name-match
 * rule, so callers never have to decide for themselves whether an overlay
 * belongs to the loadout that actually won.
 */
function activeFor(
  opts: LoadoutCommonOptions,
  repoRoot: string,
  profile: ExecutorProfile,
): {
  active: ActiveLoadout | null;
  stalePin: string | null;
  pin: LocalLoadoutState;
  overrides: Record<string, string>;
} {
  const pin = readPin(repoRoot);
  const localValue = pin.loadout;
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
    return { active, stalePin, pin, overrides: applicableOverrides(pin, active) };
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

/**
 * The effective table: the loadout's own slots with the session overlay on top.
 * Rows are the union of the two — an override can bind an archetype the loadout
 * has no slot for at all, and hiding that row would hide the binding that
 * actually runs.
 *
 * An override naming an executor that has since left the profile is *reported*,
 * not thrown: like a stale loadout pin, it must not brick the command whose job
 * is showing the user what is wrong. Dispatch-time resolution still refuses it.
 */
function effectiveRows(
  profile: ExecutorProfile,
  name: string,
  overrides: Record<string, string>,
): { rows: LoadoutEffectiveRow[]; stale: StaleOverrideView[] } {
  const slots = profile.loadouts[name] ?? {};
  const stale: StaleOverrideView[] = [];
  const live: Record<string, string> = {};
  for (const archetype of Object.keys(overrides).sort()) {
    const target = overrides[archetype]!;
    // `hasOwn`, not `in`: a pin reading "constructor" would otherwise be called
    // declared and then render an inherited function as an executor.
    if (Object.hasOwn(profile.executors, target)) live[archetype] = target;
    else stale.push({ archetype, target });
  }
  const archetypes = [...new Set([...Object.keys(slots), ...Object.keys(live)])].sort();
  const rows = archetypes.map((archetype) => {
    const baseExecutor = slots[archetype] ?? null;
    const executor = live[archetype] ?? baseExecutor!;
    const spec = profile.executors[executor]!;
    const eligibility = eligibilityFor(spec, archetype);
    return {
      archetype,
      executor,
      model: spec.model,
      adapter: spec.adapter,
      overridden: live[archetype] != null,
      baseExecutor,
      ...(eligibility !== 'eligible' ? { eligibility } : {}),
    };
  });
  return { rows, stale };
}

export interface LoadoutShowResult {
  active: ActiveLoadout | null;
  /** Effective archetype table (loadout slots + overlay); empty when none is active. */
  slots: LoadoutEffectiveRow[];
  available: string[];
  defaultLoadout: string | null;
  /** `.fadeno/local/loadout` content when it names an undeclared loadout. */
  stalePin: string | null;
  /** Session overrides in force for the active loadout; `{}` when none apply. */
  overrides: Record<string, string>;
  /** Pinned overrides left out of the table because their target is undeclared. */
  staleOverrides: StaleOverrideView[];
}

/** `fadeno loadout` — the active loadout, its source, and its effective table. */
export function runLoadoutShow(opts: LoadoutCommonOptions = {}): LoadoutShowResult {
  const repoRoot = repoRootOf(opts);
  const profile = loadProfile(repoRoot, opts.userPathOptions);
  const { active, stalePin, overrides } = activeFor(opts, repoRoot, profile);
  const effective = active == null
    ? { rows: [], stale: [] as StaleOverrideView[] }
    : effectiveRows(profile, active.name, overrides);
  return {
    active,
    slots: effective.rows,
    available: Object.keys(profile.loadouts).sort(),
    defaultLoadout: profile.defaultLoadout,
    stalePin,
    overrides,
    staleOverrides: effective.stale,
  };
}

export interface LoadoutListResult {
  loadouts: LoadoutInfo[];
  active: ActiveLoadout | null;
  defaultLoadout: string | null;
  /** `.fadeno/local/loadout` content when it names an undeclared loadout. */
  stalePin: string | null;
  /** Session overrides in force for the active loadout; `{}` when none apply. */
  overrides: Record<string, string>;
  /** Pinned overrides left out of the table because their target is undeclared. */
  staleOverrides: StaleOverrideView[];
}

/** `fadeno loadout list` — every declared loadout, marking active + default. */
export function runLoadoutList(opts: LoadoutCommonOptions = {}): LoadoutListResult {
  const repoRoot = repoRootOf(opts);
  const profile = loadProfile(repoRoot, opts.userPathOptions);
  const { active, stalePin, overrides } = activeFor(opts, repoRoot, profile);
  let staleOverrides: StaleOverrideView[] = [];
  const loadouts = Object.keys(profile.loadouts)
    .sort()
    .map((name) => {
      const isActive = active?.name === name;
      // The active entry renders the effective table, not the declaration —
      // a listing that shows the base slot under a dialed override hides the
      // binding that actually runs.
      let slots: Array<LoadoutSlotView & Partial<LoadoutEffectiveRow>>;
      if (isActive) {
        const effective = effectiveRows(profile, name, overrides);
        slots = effective.rows;
        staleOverrides = effective.stale;
      } else {
        slots = slotViews(profile, name);
      }
      return { name, slots, isDefault: profile.defaultLoadout === name, isActive };
    });
  return {
    loadouts,
    active,
    defaultLoadout: profile.defaultLoadout,
    stalePin,
    overrides,
    staleOverrides,
  };
}

export interface LoadoutUseResult {
  name: string;
  /** Absolute path of the sticky session file that was written. */
  path: string;
  /** Previously pinned local name, if any. */
  previous: string | null;
  /**
   * Session overrides the base switch discarded. Selecting a base rewrites the
   * pin as a bare name, so an overlay never survives into a loadout it was
   * never dialed against.
   */
  droppedOverrides: Record<string, string>;
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
  const pin = readPin(repoRoot);
  const path = writeLocalLoadoutState(repoRoot, { loadout: name, overrides: {} });
  return { name, path, previous: pin.loadout, droppedOverrides: pin.overrides };
}

export interface LoadoutSetResult {
  archetype: string;
  target: string;
  /** Base loadout the overlay decorates — the pin now names it. */
  loadout: string;
  /** Absolute path of the sticky session file that was written. */
  path: string;
  /** This archetype's previous override on the same base, when it had one. */
  previous: string | null;
  /** Every override now in force for `loadout`. */
  overrides: Record<string, string>;
  /** Overrides discarded because the pin decorated a *different* base loadout. */
  droppedOverrides: Record<string, string>;
  /** The base those dropped overrides decorated; null when nothing was dropped. */
  droppedBase: string | null;
}

/**
 * `fadeno loadout set <archetype> <target>` — override one archetype on top of
 * the active loadout, whatever selected it. The overlay is written against that
 * loadout **by name**, so the pin ends up naming it too: an overlay with no
 * base to decorate is exactly the state the kernel refuses to represent.
 */
export function runLoadoutSet(
  opts: LoadoutCommonOptions & { archetype: string; target: string },
): LoadoutSetResult {
  const repoRoot = repoRootOf(opts);
  const profile = loadProfile(repoRoot, opts.userPathOptions);
  const archetype = opts.archetype.trim();
  const target = opts.target.trim();
  if (archetype.length === 0 || target.length === 0) {
    throw new LoadoutError('Usage: fadeno loadout set <archetype> <executor>');
  }
  // The writer stores what it is given; the name rules are enforced here, at
  // dial time, so a bad key is refused with the command that produced it in
  // hand rather than surfacing later as an unreadable pin.
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new LoadoutError(
      `archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`,
    );
  }
  if (!Object.hasOwn(profile.executors, target)) {
    throw new LoadoutError(
      `"${target}" is not a declared executor (${Object.keys(profile.executors).sort().join(', ')}).`,
    );
  }
  const { active, pin } = activeFor(opts, repoRoot, profile);
  if (active == null) {
    throw new LoadoutError(
      'No loadout is active, so a session override has nothing to decorate. ' +
        'Fix: select a base first with `fadeno loadout use <name>`.',
    );
  }

  // Set-time policy check, in the dispatch kernel's own words: dialing a
  // mutating archetype onto a command route that cannot write is a refusal
  // waiting to happen, and the honest moment to say so is now — not after the
  // first expensive dispatch. Native deliveries are exempt: the in-session
  // agent's permissions belong to the host, and on a host executor
  // `write_access` describes its command fallback, not the native facility.
  const spec = profile.executors[target]!;
  if (spec.adapter === 'command') {
    const conflict = explainWriteConflict({ executor: target, spec }, archetype, profile);
    if (conflict != null) throw new LoadoutError(conflict);
  }
  const eligibilityConflict = explainEligibilityConflict({ executor: target, spec }, archetype);
  if (eligibilityConflict != null) throw new LoadoutError(eligibilityConflict);

  // Overrides belong to a base by name. A pin decorating some *other* loadout
  // cannot be merged into this one, so it is dropped — and reported, because a
  // silently discarded overlay is the failure this layer exists to prevent.
  const rebase = pin.loadout !== active.name;
  const droppedOverrides = rebase ? pin.overrides : {};
  const overrides: Record<string, string> = rebase ? {} : { ...pin.overrides };
  const previous = overrides[archetype] ?? null;
  overrides[archetype] = target;
  const path = writeLocalLoadoutState(repoRoot, { loadout: active.name, overrides });
  return {
    archetype,
    target,
    loadout: active.name,
    path,
    previous,
    overrides,
    droppedOverrides,
    droppedBase: Object.keys(droppedOverrides).length > 0 ? pin.loadout : null,
  };
}

export interface LoadoutClearResult {
  removed: boolean;
  path: string;
  /** Archetype targeted by a single-override clear; null for a whole-pin clear. */
  archetype: string | null;
  /** The override target removed, when there was one to remove. */
  cleared: string | null;
  /** Base loadout the pin still names after a single-override clear. */
  loadout: string | null;
  /** Overrides still pinned after the clear. */
  overrides: Record<string, string>;
}

export interface LoadoutResolveResult {
  archetype: string;
  active: ActiveLoadout;
  executor: string;
  model: string | null;
  adapter: 'command' | 'host';
  harness: string;
  /** Which layer of the cascade supplied the executor. */
  source: RoleResolutionSource;
  /** Convenience for hook consumers: `source === 'override'`. */
  override: boolean;
  /** Archetype whose binding fired when a fallback chain was walked. Absent on a direct bind. */
  resolved_via?: string;
  /** Present when the resolved target is not fully eligible for this archetype. */
  eligibility?: EligibilityState;
}

/** Structured, harness-relative slot resolution for host adapters and hooks. */
export function runLoadoutResolve(
  opts: LoadoutCommonOptions & { archetype: string },
): LoadoutResolveResult {
  const repoRoot = repoRootOf(opts);
  const profile = loadProfile(repoRoot, opts.userPathOptions);
  const { active, overrides } = activeFor(opts, repoRoot, profile);
  if (active == null) throw new LoadoutError('No loadout is active.');
  try {
    const resolved = resolveRole(
      opts.archetype,
      opts.archetype,
      { ...profile, bindings: profile.bindings['*'] != null ? { '*': profile.bindings['*'] } : {} },
      active.name,
      overrides,
    );
    const eligibility = eligibilityFor(resolved.executor, opts.archetype);
    return {
      archetype: opts.archetype,
      active,
      executor: resolved.executorName,
      model: resolved.executor.model,
      adapter: resolved.executor.adapter,
      harness: profile.harness ?? 'standalone',
      source: resolved.source,
      override: resolved.source === 'override',
      ...(resolved.resolvedVia != null ? { resolved_via: resolved.resolvedVia } : {}),
      ...(eligibility !== 'eligible' ? { eligibility } : {}),
    };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new LoadoutError(err.message);
    throw err;
  }
}

/**
 * `fadeno loadout clear` — remove the sticky session file (idempotent).
 * `fadeno loadout clear <archetype>` — drop one session override, rewriting the
 * pin (back to a bare name once the last override goes) and leaving the base
 * selection alone. Clearing an override that is not there is reported, never
 * thrown: the user's intent — "that override is gone" — already holds.
 */
export function runLoadoutClear(
  opts: LoadoutCommonOptions & { archetype?: string | null } = {},
): LoadoutClearResult {
  const repoRoot = repoRootOf(opts);
  const path = join(repoRoot, LOADOUT_LOCAL_FILE);
  const archetype = opts.archetype?.trim() ? opts.archetype.trim() : null;
  if (archetype == null) {
    const removed = existsSync(path);
    rmSync(path, { force: true });
    return { removed, path, archetype: null, cleared: null, loadout: null, overrides: {} };
  }
  const pin = readPin(repoRoot);
  if (pin.loadout == null || !Object.hasOwn(pin.overrides, archetype)) {
    return {
      removed: false,
      path,
      archetype,
      cleared: null,
      loadout: pin.loadout,
      overrides: pin.overrides,
    };
  }
  const cleared = pin.overrides[archetype]!;
  const overrides = { ...pin.overrides };
  delete overrides[archetype];
  return {
    removed: true,
    path: writeLocalLoadoutState(repoRoot, { loadout: pin.loadout, overrides }),
    archetype,
    cleared,
    loadout: pin.loadout,
    overrides,
  };
}

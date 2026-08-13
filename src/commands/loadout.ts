import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadLayeredProfile, type ConfigLayer, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  applicableOverrides,
  applicableShadows,
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  eligibilityFor,
  explainEligibilityConflict,
  explainWriteConflict,
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
  type ShadowAttachment,
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

/** Archetype-keyed shadow attachment enriched for display/JSON. */
export interface ShadowAttachmentView {
  executor: string;
  model: string | null;
  rate?: number;
  /** Delivery adapter for rendering; omitted from JSON when not needed. */
  adapter?: 'command' | 'host';
}

/** A pinned shadow whose target is no longer a declared executor. */
export interface StaleShadowView {
  archetype: string;
  target: string;
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
  /** Shadow attachment for this archetype when one is in force. */
  shadow?: ShadowAttachmentView;
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
  /** Present on the active entry when the catalog suppresses builtin archetypes. */
  note?: string;
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

function loadLayered(repoRoot: string, userPathOptions?: UserPathOptions): LayeredProfile {
  try {
    return loadLayeredProfile(repoRoot, userPathOptions, activeHarness(undefined, userPathOptions));
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new LoadoutError(err.message);
    throw err;
  }
}

function loadProfile(repoRoot: string, userPathOptions?: UserPathOptions): ExecutorProfile {
  return loadLayered(repoRoot, userPathOptions).profile;
}

/**
 * The exact note line appended to the no-arg effective view and the active
 * `loadout list` entry when a self-contained catalog omitted builtin archetypes.
 */
export function formatSuppressedCanonNote(archetypes: readonly string[]): string | null {
  if (archetypes.length === 0) return null;
  return (
    `note: canon archetypes not declared by this catalog: <${archetypes.join(', ')}> ` +
    '(self-contained profile suppresses builtin layering; declare them in .fadeno/executors.yaml to adopt)'
  );
}

function canonSurfacing(layered: LayeredProfile): {
  suppressed_canon_archetypes: string[];
  note: string | null;
} {
  const suppressed_canon_archetypes = layered.suppressedCanonArchetypes;
  return { suppressed_canon_archetypes, note: formatSuppressedCanonNote(suppressed_canon_archetypes) };
}

/** User sticky pin, only when the composed profile actually included the user layer. */
function userPinValue(layers: readonly ConfigLayer[], userPathOptions?: UserPathOptions): string | null {
  // A self-contained project profile never composed the user layer; a
  // user-scope pin must not reach into a catalog that never saw that layer.
  if (!layers.includes('user')) return null;
  return readUserLoadout(userPathOptions);
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
 * Active-loadout resolution shared by inspection and `loadout resolve`.
 *
 * Inspection (`strict: false`, show/list/set): a stale local pin —
 * `.fadeno/local/loadout` naming a since-removed loadout — must not brick the
 * very commands that let the user see what is declared. The pin is treated as
 * absent and surfaced as `stalePin`; flag/env problems (explicit
 * per-invocation inputs) stay hard errors.
 *
 * Resolve (`strict: true`): let `resolveActiveLoadout` throw. Silent fallback
 * to `default_loadout` would substitute a different executor than dispatch.
 *
 * `overrides` is the pin's overlay already scoped by the kernel's name-match
 * rule, so callers never have to decide for themselves whether an overlay
 * belongs to the loadout that actually won.
 */
function activeFor(
  opts: LoadoutCommonOptions,
  repoRoot: string,
  profile: ExecutorProfile,
  layers: readonly ConfigLayer[],
  strict = false,
): {
  active: ActiveLoadout | null;
  stalePin: string | null;
  pin: LocalLoadoutState;
  overrides: Record<string, string>;
  shadows: Record<string, ShadowAttachment>;
  shadow_attachments: Record<string, ShadowAttachmentView>;
} {
  const pin = readPin(repoRoot);
  const localValue = pin.loadout;
  const userValue = userPinValue(layers, opts.userPathOptions);
  const stalePin = localValue != null && !(localValue in profile.loadouts) ? localValue : null;
  const staleUserPin = userValue != null && !(userValue in profile.loadouts) ? userValue : null;
  try {
    const active = resolveActiveLoadout({
      flagValue: opts.loadout ?? null,
      envValue: envValue(opts),
      localFileValue: strict ? localValue : stalePin == null ? localValue : null,
      userFileValue: strict ? userValue : staleUserPin == null ? userValue : null,
      profile,
    });
    const overrides = applicableOverrides(pin, active);
    const shadows = applicableShadows(pin, active);
    const shadow_attachments: Record<string, ShadowAttachmentView> = {};
    for (const [archetype, att] of Object.entries(shadows)) {
      const spec = profile.executors[att.executor];
      if (spec == null) continue;
      shadow_attachments[archetype] = att.rate == null
        ? { executor: att.executor, model: spec.model }
        : { executor: att.executor, model: spec.model, rate: att.rate };
    }
    return { active, stalePin, pin, overrides, shadows, shadow_attachments };
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
  shadows: Record<string, ShadowAttachment> = {},
): { rows: LoadoutEffectiveRow[]; stale: StaleOverrideView[]; staleShadows: StaleShadowView[] } {
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
  const staleShadows: StaleShadowView[] = [];
  const liveShadows: Record<string, ShadowAttachment> = {};
  for (const archetype of Object.keys(shadows).sort()) {
    const att = shadows[archetype]!;
    if (Object.hasOwn(profile.executors, att.executor)) liveShadows[archetype] = att;
    else staleShadows.push({ archetype, target: att.executor });
  }
  const archetypes = [...new Set([...Object.keys(slots), ...Object.keys(live)])].sort();
  const rows = archetypes.map((archetype) => {
    const baseExecutor = slots[archetype] ?? null;
    const executor = live[archetype] ?? baseExecutor!;
    const spec = profile.executors[executor]!;
    const eligibility = eligibilityFor(spec, archetype);
    const att = liveShadows[archetype];
    let shadow: ShadowAttachmentView | undefined;
    if (att != null) {
      const shadowSpec = profile.executors[att.executor]!;
      shadow = att.rate == null
        ? { executor: att.executor, model: shadowSpec.model, adapter: shadowSpec.adapter }
        : { executor: att.executor, model: shadowSpec.model, adapter: shadowSpec.adapter, rate: att.rate };
    }
    return {
      archetype,
      executor,
      model: spec.model,
      adapter: spec.adapter,
      overridden: live[archetype] != null,
      baseExecutor,
      ...(eligibility !== 'eligible' ? { eligibility } : {}),
      ...(shadow != null ? { shadow } : {}),
    };
  });
  return { rows, stale, staleShadows };
}

export function formatShadowLine(shadow: ShadowAttachmentView, baseIndent: string): string {
  const model = shadow.model != null ? ` (${shadow.model})` : '';
  const rate = shadow.rate != null ? ` rate ${shadow.rate}` : '';
  const transport = shadow.adapter != null ? ` [${shadow.adapter}]` : '';
  return `${baseIndent}  ~ shadow: ${shadow.executor}${model}${transport}${rate}`;
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
  /** Session shadows in force for the active loadout; `{}` when none apply. */
  shadows: Record<string, ShadowAttachment>;
  /** Enriched shadow attachments for rendering/JSON (snake_case). */
  shadow_attachments: Record<string, ShadowAttachmentView>;
  /** Pinned shadows left out of the table because their target is undeclared. */
  staleShadows: StaleShadowView[];
  /** Builtin archetypes the self-contained project catalog omitted. */
  suppressed_canon_archetypes: string[];
  /** Exact note line when `suppressed_canon_archetypes` is non-empty; otherwise null. */
  note: string | null;
}

/** `fadeno loadout` — the active loadout, its source, and its effective table. */
export function runLoadoutShow(opts: LoadoutCommonOptions = {}): LoadoutShowResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const { active, stalePin, overrides, shadows, shadow_attachments } = activeFor(opts, repoRoot, profile, layered.layers);
  const effective = active == null
    ? { rows: [], stale: [] as StaleOverrideView[], staleShadows: [] as StaleShadowView[] }
    : effectiveRows(profile, active.name, overrides, shadows);
  const canon = canonSurfacing(layered);
  // shadow_attachments filtered to live only (like staleShadows separate), but
  // activeFor already scoped to applicable shadows and filtered to live via spec check;
  // stale shadows are reported separately and not included in shadow_attachments.
  const liveShadowAttachments: Record<string, ShadowAttachmentView> = {};
  for (const [archetype, view] of Object.entries(shadow_attachments)) {
    if (effective.staleShadows.some((s) => s.archetype === archetype)) continue;
    // Strip adapter for JSON: spec says {executor, model, rate?}
    const { executor, model, rate } = view;
    liveShadowAttachments[archetype] = rate == null ? { executor, model } : { executor, model, rate };
  }
  return {
    active,
    slots: effective.rows,
    available: Object.keys(profile.loadouts).sort(),
    defaultLoadout: profile.defaultLoadout,
    stalePin,
    overrides,
    staleOverrides: effective.stale,
    shadows,
    shadow_attachments: liveShadowAttachments,
    staleShadows: effective.staleShadows,
    suppressed_canon_archetypes: canon.suppressed_canon_archetypes,
    note: canon.note,
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
  /** Session shadows in force for the active loadout; `{}` when none apply. */
  shadows: Record<string, ShadowAttachment>;
  shadow_attachments: Record<string, ShadowAttachmentView>;
  staleShadows: StaleShadowView[];
  /** Builtin archetypes the self-contained project catalog omitted. */
  suppressed_canon_archetypes: string[];
}

/** `fadeno loadout list` — every declared loadout, marking active + default. */
export function runLoadoutList(opts: LoadoutCommonOptions = {}): LoadoutListResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const { active, stalePin, overrides, shadows, shadow_attachments } = activeFor(opts, repoRoot, profile, layered.layers);
  const canon = canonSurfacing(layered);
  let staleOverrides: StaleOverrideView[] = [];
  let staleShadows: StaleShadowView[] = [];
  // live shadow_attachments for JSON, filtered to live after effectiveRows knows stale
  // For list we need to know staleShadows from the active entry's effectiveRows.
  let liveShadowAttachments: Record<string, ShadowAttachmentView> = {};
  const loadouts = Object.keys(profile.loadouts)
    .sort()
    .map((name) => {
      const isActive = active?.name === name;
      // The active entry renders the effective table, not the declaration —
      // a listing that shows the base slot under a dialed override hides the
      // binding that actually runs.
      let slots: Array<LoadoutSlotView & Partial<LoadoutEffectiveRow>>;
      if (isActive) {
        const effective = effectiveRows(profile, name, overrides, shadows);
        slots = effective.rows;
        staleOverrides = effective.stale;
        staleShadows = effective.staleShadows;
        // Build live shadow_attachments sans stale
        for (const [archetype, view] of Object.entries(shadow_attachments)) {
          if (staleShadows.some((s) => s.archetype === archetype)) continue;
          const { executor, model, rate } = view;
          liveShadowAttachments[archetype] = rate == null ? { executor, model } : { executor, model, rate };
        }
      } else {
        slots = slotViews(profile, name);
      }
      return {
        name,
        slots,
        isDefault: profile.defaultLoadout === name,
        isActive,
        ...(isActive && canon.note != null ? { note: canon.note } : {}),
      };
    });
  return {
    loadouts,
    active,
    defaultLoadout: profile.defaultLoadout,
    stalePin,
    overrides,
    staleOverrides,
    shadows,
    shadow_attachments: liveShadowAttachments,
    staleShadows,
    suppressed_canon_archetypes: canon.suppressed_canon_archetypes,
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
  /** Session shadows the base switch discarded. */
  droppedShadows: Record<string, ShadowAttachment>;
  /** Enriched shadows for JSON/display. */
  dropped_shadow_attachments: Record<string, ShadowAttachmentView>;
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
  const path = writeLocalLoadoutState(repoRoot, { loadout: name, overrides: {}, shadows: {} });
  const droppedShadows = pin.shadows ?? {};
  const dropped_shadow_attachments: Record<string, ShadowAttachmentView> = {};
  for (const [archetype, att] of Object.entries(droppedShadows)) {
    const spec = profile.executors[att.executor];
    dropped_shadow_attachments[archetype] = spec == null
      ? { executor: att.executor, model: null, ...(att.rate != null ? { rate: att.rate } : {}) }
      : att.rate == null ? { executor: att.executor, model: spec.model } : { executor: att.executor, model: spec.model, rate: att.rate };
  }
  return { name, path, previous: pin.loadout, droppedOverrides: pin.overrides, droppedShadows, dropped_shadow_attachments };
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
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
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
  const { active, pin } = activeFor(opts, repoRoot, profile, layered.layers);
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
  const shadows: Record<string, ShadowAttachment> = rebase ? {} : { ...(pin.shadows ?? {}) };
  const previous = overrides[archetype] ?? null;
  overrides[archetype] = target;
  const path = writeLocalLoadoutState(repoRoot, { loadout: active.name, overrides, ...(Object.keys(shadows).length > 0 ? { shadows } : {}) });
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
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const { active, overrides } = activeFor(opts, repoRoot, profile, layered.layers, true);
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
  const shadows = pin.shadows ?? {};
  const state: LocalLoadoutState = { loadout: pin.loadout, overrides, ...(Object.keys(shadows).length > 0 ? { shadows } : {}) };
  return {
    removed: true,
    path: writeLocalLoadoutState(repoRoot, state),
    archetype,
    cleared,
    loadout: pin.loadout,
    overrides,
  };
}

export interface LoadoutShadowResult {
  archetype: string;
  executor: string;
  model: string | null;
  rate: number | null;
  loadout: string;
  path: string;
  previous: ShadowAttachment | null;
  shadows: Record<string, ShadowAttachment>;
  shadow_attachments: Record<string, ShadowAttachmentView>;
  droppedShadows: Record<string, ShadowAttachment>;
  droppedOverrides: Record<string, string>;
  droppedBase: string | null;
}

export interface LoadoutClearShadowResult {
  archetype: string | null;
  cleared: ShadowAttachment | null;
  removed: boolean;
  count: number;
  loadout: string | null;
  shadows: Record<string, ShadowAttachment>;
  shadow_attachments: Record<string, ShadowAttachmentView>;
  path: string;
}

/**
 * `fadeno loadout shadow <archetype> <executor> [--rate <n>]` — attach a shadow
 * executor for one archetype on top of the active loadout. Mirrors `set` validation
 * and name-match rebase semantics.
 */
export function runLoadoutShadow(
  opts: LoadoutCommonOptions & { archetype: string; executor: string; rate?: number | string | null },
): LoadoutShadowResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const archetype = opts.archetype.trim();
  const executor = opts.executor.trim();
  if (archetype.length === 0 || executor.length === 0) {
    throw new LoadoutError('Usage: fadeno loadout shadow <archetype> <executor> [--rate <n>]');
  }
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new LoadoutError(
      `archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`,
    );
  }
  if (!Object.hasOwn(profile.executors, executor)) {
    throw new LoadoutError(
      `"${executor}" is not a declared executor (${Object.keys(profile.executors).sort().join(', ')}).`,
    );
  }
  let rate: number | undefined;
  if (opts.rate != null && opts.rate !== '') {
    const raw = opts.rate;
    const parsed = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      throw new LoadoutError(`rate ${JSON.stringify(raw)} is not a number in (0, 1].`);
    }
    rate = parsed;
  }
  const spec = profile.executors[executor]!;
  if (spec.adapter === 'command') {
    const conflict = explainWriteConflict({ executor, spec }, archetype, profile);
    if (conflict != null) throw new LoadoutError(conflict);
  }
  const eligibility = eligibilityFor(spec, archetype);
  if (eligibility === 'forbidden') {
    const conflict = explainEligibilityConflict({ executor, spec }, archetype);
    throw new LoadoutError(conflict ?? `archetype "${archetype}" is forbidden on executor "${executor}".`);
  }
  const { active, pin } = activeFor(opts, repoRoot, profile, layered.layers);
  if (active == null) {
    throw new LoadoutError(
      'No loadout is active, so a shadow attachment has nothing to decorate. ' +
        'Fix: select a base first with `fadeno loadout use <name>`.',
    );
  }
  const rebase = pin.loadout !== active.name;
  const droppedOverrides = rebase ? pin.overrides : {};
  const droppedShadows = rebase ? (pin.shadows ?? {}) : {};
  const overrides: Record<string, string> = rebase ? {} : { ...pin.overrides };
  const shadows: Record<string, ShadowAttachment> = rebase ? {} : { ...(pin.shadows ?? {}) };
  const previous = shadows[archetype] ?? null;
  shadows[archetype] = rate == null ? { executor } : { executor, rate };
  const state: LocalLoadoutState = { loadout: active.name, overrides, shadows };
  const path = writeLocalLoadoutState(repoRoot, state);
  const shadow_attachments: Record<string, ShadowAttachmentView> = {};
  for (const [key, att] of Object.entries(shadows)) {
    const s = profile.executors[att.executor]!;
    shadow_attachments[key] = att.rate == null ? { executor: att.executor, model: s.model } : { executor: att.executor, model: s.model, rate: att.rate };
  }
  return {
    archetype,
    executor,
    model: spec.model,
    rate: rate ?? null,
    loadout: active.name,
    path,
    previous,
    shadows,
    shadow_attachments,
    droppedShadows,
    droppedOverrides,
    droppedBase: Object.keys({ ...droppedOverrides, ...droppedShadows }).length > 0 ? pin.loadout : null,
  };
}

/**
 * `fadeno loadout clear-shadow [archetype]` — drop one or all shadow attachments.
 * With archetype clears that attachment (error if none). Without clears all (count
 * in result; clearing zero is a no-op success).
 */
export function runLoadoutClearShadow(
  opts: LoadoutCommonOptions & { archetype?: string | null } = {},
): LoadoutClearShadowResult {
  const repoRoot = repoRootOf(opts);
  const pin = readPin(repoRoot);
  const path = join(repoRoot, LOADOUT_LOCAL_FILE);
  const archetype = opts.archetype?.trim() ? opts.archetype.trim() : null;
  if (archetype != null && !BARE_IDENTIFIER_RE.test(archetype)) {
    throw new LoadoutError(
      `archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`,
    );
  }
  if (archetype == null) {
    const count = Object.keys(pin.shadows ?? {}).length;
    if (count === 0) {
      const shadows: Record<string, ShadowAttachment> = {};
      const shadow_attachments: Record<string, ShadowAttachmentView> = {};
      return { archetype: null, cleared: null, removed: false, count: 0, loadout: pin.loadout, shadows, shadow_attachments, path };
    }
    const overrides = pin.overrides;
    const loadout = pin.loadout;
    // loadout must be non-null when shadows exist (kernel guarantees), but guard
    if (loadout == null) {
      rmSync(path, { force: true });
      return { archetype: null, cleared: null, removed: true, count, loadout: null, shadows: {}, shadow_attachments: {}, path };
    }
    // Writing without a shadows key collapses the pin back to its bare-name
    // or overrides-only form.
    const newPath = writeLocalLoadoutState(repoRoot, { loadout, overrides });
    const shadows: Record<string, ShadowAttachment> = {};
    const shadow_attachments: Record<string, ShadowAttachmentView> = {};
    return { archetype: null, cleared: null, removed: true, count, loadout, shadows, shadow_attachments, path: newPath };
  }
  // single archetype clear
  if (pin.loadout == null || pin.shadows == null || !Object.hasOwn(pin.shadows, archetype)) {
    throw new LoadoutError(`no shadow attachment for "${archetype}" to clear (.fadeno/local/loadout)`);
  }
  const cleared = pin.shadows[archetype]!;
  const shadows: Record<string, ShadowAttachment> = { ...pin.shadows };
  delete shadows[archetype];
  const overrides = pin.overrides;
  const loadout = pin.loadout!;
  const state: LocalLoadoutState = { loadout, overrides, ...(Object.keys(shadows).length > 0 ? { shadows } : {}) };
  const newPath = writeLocalLoadoutState(repoRoot, state);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const shadow_attachments: Record<string, ShadowAttachmentView> = {};
  for (const [key, att] of Object.entries(shadows)) {
    const s = profile.executors[att.executor];
    if (s == null) continue;
    shadow_attachments[key] = att.rate == null ? { executor: att.executor, model: s.model } : { executor: att.executor, model: s.model, rate: att.rate };
  }
  return { archetype, cleared, removed: true, count: 1, loadout, shadows, shadow_attachments, path: newPath };
}

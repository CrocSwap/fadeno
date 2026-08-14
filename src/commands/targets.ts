import { loadLayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  ExecutorProfileError,
  type EligibilityState,
  type HarnessId,
} from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';

/**
 * `fadeno targets` — one row per declared target, independent of loadouts.
 *
 * `loadout list` answers "what will run for this archetype", which is a
 * different question from "what is available to dial". A target no loadout
 * references was invisible: the only way to discover one was reading
 * executors.yaml or misspelling a name and reading the error's candidate list.
 * Two shipped drivers (Antigravity, OpenCode) are in exactly that position by
 * design, since neither ships a loadout.
 *
 * Delivery is resolved against the *active host*, so the same target reads
 * `host` on one harness and `command` on another. That is the host/driver
 * distinction (architecture.md → Glossary) made visible per row.
 */

export class TargetsError extends Error {}

export interface TargetView {
  name: string;
  provider: string | null;
  /** Model slug as the delivery will request it. */
  model: string | null;
  adapter: 'command' | 'host';
  /**
   * argv[0] of the command delivery — the driver binary. `null` for a host
   * slot, which is delivered in-session and spawns nothing.
   */
  driver: string | null;
  /** Declared write capability of the command delivery; null = undeclared. */
  writeAccess: boolean | null;
  /** Loadout names with at least one slot bound to this target, sorted. */
  loadouts: string[];
  /** `bindings:` role keys naming this target, sorted. */
  bindings: string[];
  /** Archetypes this target refuses or only shadows; eligible ones are omitted. */
  restricted: Record<string, EligibilityState>;
}

export interface TargetsResult {
  /** Host whose route table compiled these deliveries. */
  harness: HarnessId;
  targets: TargetView[];
}

export interface TargetsOptions {
  repoRoot?: string;
  cwd?: string;
  userPathOptions?: UserPathOptions;
}

export function runTargets(opts: TargetsOptions = {}): TargetsResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const harness = activeHarness(undefined, opts.userPathOptions);
  let profile;
  try {
    profile = loadLayeredProfile(repoRoot, opts.userPathOptions, harness).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new TargetsError(err.message);
    throw err;
  }

  const loadoutsFor = new Map<string, Set<string>>();
  for (const [loadout, slots] of Object.entries(profile.loadouts)) {
    for (const target of Object.values(slots)) {
      if (!loadoutsFor.has(target)) loadoutsFor.set(target, new Set());
      loadoutsFor.get(target)!.add(loadout);
    }
  }
  const bindingsFor = new Map<string, Set<string>>();
  for (const [role, target] of Object.entries(profile.bindings)) {
    if (!bindingsFor.has(target)) bindingsFor.set(target, new Set());
    bindingsFor.get(target)!.add(role);
  }

  const targets = Object.keys(profile.executors)
    .sort()
    .map((name): TargetView => {
      const spec = profile.executors[name]!;
      const restricted: Record<string, EligibilityState> = {};
      for (const [archetype, state] of Object.entries(spec.eligibility)) {
        if (state !== 'eligible') restricted[archetype] = state;
      }
      return {
        name,
        provider: spec.provider ?? null,
        model: spec.model ?? null,
        adapter: spec.adapter,
        driver: spec.adapter === 'command' ? spec.command[0] ?? null : null,
        writeAccess: spec.writeAccess,
        loadouts: [...(loadoutsFor.get(name) ?? [])].sort(),
        bindings: [...(bindingsFor.get(name) ?? [])].sort(),
        restricted,
      };
    });

  return { harness, targets };
}

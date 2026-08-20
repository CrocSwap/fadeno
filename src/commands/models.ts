import { spawnSync } from 'node:child_process';
import { loadLayeredProfile, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  compileDialRef,
  detectAmbientHarness,
  ExecutorProfileError,
  type CommandExecutorSpec,
  type EligibilityState,
  type ExecutorProfile,
} from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { readUserHarness, readVerifiedModels, type UserPathOptions } from '../lib/user-paths.ts';

export class ModelsError extends Error {}

export interface ModelsCommonOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
}

/** One registry entry with frame-neutral harness identity plus resolution data. */
export interface ModelRow {
  name: string;
  provider: string | null;
  id: string;
  /** Delivered id under the home driver (effort suffix applied where encoded). */
  model_id: string | null;
  /** Registry-standard effort — frame-invariant. Command lanes inject it into
   * the argv; host lanes carry it as the request, applied by the materialized
   * agent surface. */
  effort: string;
  driver: string | null;
  /** Stable harness/driver identity for the model, independent of caller. */
  harness: string | null;
  adapter: 'command' | 'host' | null;
  /** Resolution detail retained for structured consumers; not model identity. */
  native: boolean;
  /** Backward-compatible neutral display value; equals `harness` when known. */
  delivery: string;
  /** The home route declares a write variant (a `+write` lane exists). */
  write_variant: boolean;
  /** That variant's argv grants the fadeno command family (director-capable). */
  fadeno_capable: boolean;
  eligibility: Record<string, EligibilityState>;
  spellings: Record<string, string>;
  /** verified_at from the probe cache for (driver, delivered id), else null. */
  verified_at: string | null;
  /** Compile failure under this harness (no route for provider etc.), else null. */
  stale: string | null;
  /**
   * Every non-home delivery this model has under the active harness — what
   * `--via <driver>` would compile to. This is where an in-session model's
   * command lane (e.g. claude-exec) becomes visible.
   */
  lanes: Array<{
    via: string;
    id: string;
    adapter: 'command' | 'host';
    delivery: string;
    write_variant: boolean;
    fadeno_capable: boolean;
  }>;
}

export interface ModelsResult {
  harness: string;
  /** How the harness was chosen — the table is harness-relative, so say so. */
  harness_source: 'FADENO_HARNESS' | 'ambient' | 'user default' | 'fallback';
  models: ModelRow[];
  unregistered_model_driver: string;
  /** Driver aliases under this harness that declare a models_command. */
  listable_drivers: string[];
}

function harnessSource(userPathOptions: UserPathOptions = {}): ModelsResult['harness_source'] {
  const env = userPathOptions.env ?? process.env;
  const explicit = env.FADENO_HARNESS?.trim();
  if (explicit === 'codex' || explicit === 'claude' || explicit === 'grok' || explicit === 'standalone') return 'FADENO_HARNESS';
  if (detectAmbientHarness(userPathOptions).harness != null) return 'ambient';
  if (readUserHarness(userPathOptions) != null) return 'user default';
  return 'fallback';
}

function repoRootOf(opts: ModelsCommonOptions): string {
  return opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
}

function loadLayered(repoRoot: string, userPathOptions?: UserPathOptions): LayeredProfile {
  try {
    return loadLayeredProfile(repoRoot, userPathOptions, activeHarness(undefined, userPathOptions));
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ModelsError(err.message);
    throw err;
  }
}

function routesForHarness(profile: ExecutorProfile): Record<string, { driver?: string; models_command?: string[] | null; write_variant?: { command: string[] } | null }> {
  const harness = profile.harness ?? 'standalone';
  return (profile.routes as Record<string, Record<string, { driver?: string; models_command?: string[] | null; write_variant?: { command: string[] } | null }>>)[harness] ?? {};
}

function routeByDriver(profile: ExecutorProfile, driver: string): { key: string; route: { driver?: string; models_command?: string[] | null; write_variant?: { command: string[] } | null } } | null {
  for (const [key, route] of Object.entries(routesForHarness(profile))) {
    if ((route.driver ?? key) === driver) return { key, route };
  }
  return null;
}

/** The model's home harness is declared by its provider route, not by which
 * host happens to be asking. Route families are required to keep this alias
 * stable; use the first declared family so the view remains frame-neutral. */
function homeHarness(profile: ExecutorProfile, provider: string): string {
  for (const routes of Object.values(profile.routes)) {
    const route = routes[provider];
    if (route != null) return route.driver ?? provider;
  }
  return provider;
}

export function runModels(opts: ModelsCommonOptions = {}): ModelsResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const harness = profile.harness ?? 'standalone';
  const verifications = readVerifiedModels(opts.userPathOptions ?? {});

  const driverAliases = new Set<string>();
  for (const [key, route] of Object.entries(routesForHarness(profile))) driverAliases.add(route.driver ?? key);

  const rows: ModelRow[] = [];
  for (const name of Object.keys(profile.models).sort()) {
    const entry = profile.models[name]!;
    const modelHarness = name === 'current-host' ? 'current-host' : homeHarness(profile, entry.provider);
    const lanes: ModelRow['lanes'] = [];
    let homeDriver: string | null = null;
    let row: ModelRow;
    try {
      const compiled = compileDialRef({ model: name }, profile);
      const adapter = compiled.spec.adapter;
      const writeVariant = adapter === 'command' && (compiled.spec as CommandExecutorSpec).writeVariant != null;
      const fadenoCapable =
        writeVariant &&
        (compiled.spec as CommandExecutorSpec).writeVariant!.command.some((part) => part.includes('Bash(fadeno:'));
      const delivery = modelHarness;
      const verified = verifications.find((v) => v.driver === compiled.driver && v.model === compiled.modelId);
      homeDriver = compiled.driver;
      row = {
        name,
        provider: compiled.provider,
        id: entry.id,
        model_id: compiled.modelId,
        effort: compiled.effectiveEffort,
        driver: compiled.driver,
        harness: modelHarness,
        adapter,
        native: adapter === 'host',
        delivery,
        write_variant: writeVariant,
        fadeno_capable: fadenoCapable,
        eligibility: { ...entry.eligibility },
        spellings: { ...entry.spellings },
        verified_at: verified?.verified_at ?? null,
        stale: null,
        lanes,
      };
    } catch (err) {
      // A registered name whose provider has no route under this harness is
      // still worth listing — the registry is harness-neutral, delivery isn't.
      row = {
        name,
        provider: entry.provider,
        id: entry.id,
        model_id: null,
        effort: entry.effort,
        driver: null,
        harness: modelHarness,
        adapter: null,
        native: false,
        delivery: modelHarness,
        write_variant: false,
        fadeno_capable: false,
        eligibility: { ...entry.eligibility },
        spellings: { ...entry.spellings },
        verified_at: null,
        stale: err instanceof ExecutorProfileError ? err.message : String(err),
        lanes,
      };
    }
    for (const alias of [...driverAliases].sort()) {
      if (alias === homeDriver || alias === 'current-host' || name === 'current-host') continue;
      try {
        const laneCompiled = compileDialRef({ model: name, via: alias }, profile);
        const laneAdapter = laneCompiled.spec.adapter;
        const laneWrite = laneAdapter === 'command' && (laneCompiled.spec as CommandExecutorSpec).writeVariant != null;
        const laneFadeno =
          laneWrite &&
          (laneCompiled.spec as CommandExecutorSpec).writeVariant!.command.some((part) => part.includes('Bash(fadeno:'));
        lanes.push({
          via: alias,
          id: laneCompiled.modelId,
          adapter: laneAdapter,
          delivery: alias,
          write_variant: laneWrite,
          fadeno_capable: laneFadeno,
        });
      } catch {
        // driver exists but cannot deliver this model here — not a lane
      }
    }
    rows.push(row);
  }

  const listable = new Set<string>();
  for (const [key, route] of Object.entries(routesForHarness(profile))) {
    if (route.models_command != null && route.models_command.length > 0) listable.add(route.driver ?? key);
  }

  return {
    harness,
    harness_source: harnessSource(opts.userPathOptions),
    models: rows,
    unregistered_model_driver: profile.unregisteredModelDriver,
    listable_drivers: [...listable].sort(),
  };
}

export interface DriverListingOptions extends ModelsCommonOptions {
  driver: string;
  /** Test seam mirroring probeModel's. */
  spawn?: (command: string[], opts: { timeout: number }) => {
    status: number | null;
    stdout: string | Buffer;
    stderr: string | Buffer;
    error?: Error;
  };
}

export interface DriverListingResult {
  driver: string;
  harness: string;
  models_command: string[];
  /** Every id the backend listed, in listing order (deduplicated). */
  models: Array<{
    id: string;
    /** Registry names that deliver this id through this driver (home or spelling). */
    registered_as: string[];
  }>;
}

export function runModelsDriver(opts: DriverListingOptions): DriverListingResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const harness = profile.harness ?? 'standalone';
  const driver = opts.driver.trim();
  const found = routeByDriver(profile, driver);
  if (found == null) {
    const declared = Object.entries(routesForHarness(profile)).map(([key, route]) => route.driver ?? key).sort();
    throw new ModelsError(`unknown driver "${driver}" — declared drivers: ${[...new Set(declared)].join(', ')}`);
  }
  const modelsCommand = found.route.models_command;
  if (modelsCommand == null || modelsCommand.length === 0) {
    throw new ModelsError(`driver "${driver}" declares no models_command — its backend cannot be listed.`);
  }

  const spawnFn =
    opts.spawn ??
    ((command: string[], spawnOpts: { timeout: number }) => {
      const run = spawnSync(command[0]!, command.slice(1), { timeout: spawnOpts.timeout, encoding: 'utf8' });
      return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', ...(run.error != null ? { error: run.error } : {}) };
    });
  let result: ReturnType<NonNullable<DriverListingOptions['spawn']>>;
  try {
    result = spawnFn(modelsCommand, { timeout: 10_000 });
  } catch (err) {
    throw new ModelsError(`models_command failed for ${driver}: ${(err as Error).message}`);
  }
  if (result.error != null) throw new ModelsError(`models_command failed for ${driver}: ${result.error.message}`);
  if (result.status !== 0) throw new ModelsError(`models_command for ${driver} exited ${result.status}.`);
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  // Same membership tokenization the dial-time probe uses.
  const tokens = stdout.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 0);

  // Which registry names deliver a given id through this driver: the home
  // route's alias matching (delivered id = entry.id), or an explicit
  // per-driver spelling.
  const registeredBy = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(profile.models)) {
    const ids: string[] = [];
    const home = routesForHarness(profile)[entry.provider];
    if (home != null && (home.driver ?? entry.provider) === driver) ids.push(entry.id);
    if (entry.spellings[driver] != null) ids.push(entry.spellings[driver]!);
    for (const id of ids) {
      const list = registeredBy.get(id) ?? [];
      if (!list.includes(name)) list.push(name);
      registeredBy.set(id, list);
    }
  }

  const seen = new Set<string>();
  const models: DriverListingResult['models'] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    models.push({ id: token, registered_as: (registeredBy.get(token) ?? []).sort() });
  }
  return { driver, harness, models_command: modelsCommand, models };
}

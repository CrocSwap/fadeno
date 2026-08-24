import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadGlobalProfile, loadLayeredProfile, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  BARE_IDENTIFIER_RE,
  compileDialRef,
  detectAmbientHarness,
  ExecutorProfileError,
  qualifyListedModelId,
  type CommandExecutorSpec,
  type EligibilityState,
  type ExecutorProfile,
  type RouteRaw,
} from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { readUserHarness, readVerifiedModels, userPaths, type UserPathOptions } from '../lib/user-paths.ts';

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
  /**
   * The route's public name — what `--via` takes and what the table prints in
   * its `via` column. Null when this model has no route under the active
   * harness (see `stale`); `home_via` still names where it would land.
   */
  driver: string | null;
  /**
   * The model's home driver, independent of the caller and of whether it
   * compiles here. Two synonyms for this value — `harness` and `delivery` —
   * were dropped on 2026-08-21; `harness` in particular collided with the
   * real harness this command resolves under.
   */
  home_via: string;
  adapter: 'command' | 'host' | null;
  /** Resolution detail retained for structured consumers; not model identity. */
  native: boolean;
  /** The home route declares a write variant (a `+write` lane exists). */
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
  if (explicit === 'codex' || explicit === 'claude' || explicit === 'grok' || explicit === 'opencode' || explicit === 'omp' || explicit === 'standalone') return 'FADENO_HARNESS';
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

function loadGlobal(userPathOptions?: UserPathOptions): LayeredProfile {
  try {
    return loadGlobalProfile(userPathOptions, activeHarness(undefined, userPathOptions));
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ModelsError(err.message);
    throw err;
  }
}

function routesForHarness(profile: ExecutorProfile): Record<string, RouteRaw> {
  const harness = profile.harness ?? 'standalone';
  return profile.routes[harness] ?? {};
}

function routeByDriver(profile: ExecutorProfile, driver: string): { key: string; route: RouteRaw } | null {
  for (const [key, route] of Object.entries(routesForHarness(profile))) {
    if ((route.driver ?? key) === driver) return { key, route };
  }
  return null;
}

export interface ModelDiscoveryPath {
  /** Stable result label and the delivery route persisted for this match. */
  name: string;
  /** Public driver alias whose single model listing is inspected. */
  driver: string;
  /** Construct the exact identity expected on that driver's listing. */
  listedId: (provider: string, id: string) => string;
  /** The route-relative id delivered when this identity matched. */
  delivery: (provider: string, id: string) => { route: string; id: string };
}

/**
 * Default ordered discovery stays data, not command control flow: an
 * integration can provide its own path without rewriting `runModelsAdd`.
 * Both entries deliberately share OpenCode's one listing invocation.
 */
export const DEFAULT_MODEL_DISCOVERY_PATH: readonly ModelDiscoveryPath[] = [
  {
    name: 'opencode',
    driver: 'opencode',
    listedId: (provider, id) => `${provider}/${id}`,
    delivery: (provider, id) => ({ route: 'opencode-direct', id: `${provider}/${id}` }),
  },
  {
    name: 'opencode/openrouter',
    driver: 'opencode',
    listedId: (provider, id) => `openrouter/${provider}/${id}`,
    delivery: (provider, id) => ({ route: 'openrouter', id: `${provider}/${id}` }),
  },
];

type ListingSpawn = NonNullable<DriverListingOptions['spawn']>;

function defaultSpawn(command: string[], opts: { timeout: number }): ReturnType<ListingSpawn> {
  const run = spawnSync(command[0]!, command.slice(1), { timeout: opts.timeout, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', ...(run.error != null ? { error: run.error } : {}) };
}

/** One listed id per non-prose line; exact identity matching happens above it. */
function listedIds(stdout: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t')[0]!.trim())
    .filter((candidate) => candidate.length > 0 && !/\s/.test(candidate))) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function runListingCommand(
  profile: ExecutorProfile,
  driver: string,
  spawn: ListingSpawn | undefined,
): { route: RouteRaw; modelsCommand: string[]; ids: string[] } {
  const found = routeByDriver(profile, driver);
  if (found == null) {
    const declared = Object.entries(routesForHarness(profile)).map(([key, route]) => route.driver ?? key).sort();
    throw new ModelsError(`unknown driver "${driver}" — declared drivers: ${[...new Set(declared)].join(', ')}`);
  }
  const modelsCommand = found.route.models_command;
  if (modelsCommand == null || modelsCommand.length === 0) {
    throw new ModelsError(`driver "${driver}" declares no models_command — its backend cannot be listed.`);
  }
  const spawnFn = spawn ?? defaultSpawn;
  let result: ReturnType<ListingSpawn>;
  try {
    result = spawnFn(modelsCommand, { timeout: 10_000 });
  } catch (err) {
    throw new ModelsError(`models_command failed for ${driver}: ${(err as Error).message}`);
  }
  if (result.error != null) throw new ModelsError(`models_command failed for ${driver}: ${result.error.message}`);
  if (result.status !== 0) throw new ModelsError(`models_command for ${driver} exited ${result.status}.`);
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  return { route: found.route, modelsCommand, ids: listedIds(stdout) };
}

/** The model's home DRIVER — the `--via` value it takes without being asked
 * — is declared by its provider route, not by which host happens to be
 * asking. Route families are required to keep this alias stable; use the
 * first declared family so the view remains frame-neutral.
 *
 * Named `homeHarness` until 2026-08-21, which was wrong twice over: it
 * returns `route.driver` (a CLI), and `harness` in this same command means
 * the agent asking. */
function homeVia(profile: ExecutorProfile, entry: ExecutorProfile['models'][string]): string {
  const routeKey = entry.delivery?.route ?? entry.provider;
  for (const routes of Object.values(profile.routes)) {
    const route = routes[routeKey];
    if (route != null) return route.driver ?? routeKey;
  }
  return routeKey;
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
    const modelVia = name === 'current-host' ? 'current-host' : homeVia(profile, entry);
    const lanes: ModelRow['lanes'] = [];
    let homeDriver: string | null = null;
    let row: ModelRow;
    try {
      const compiled = compileDialRef({ model: name }, profile);
      const adapter = compiled.spec.adapter;
      // Read straight off the argv that will actually run: there is no longer
      // a second "variant" argv to look inside — a route is one command.
      const fadenoCapable =
        adapter === 'command' &&
        (compiled.spec as CommandExecutorSpec).command.some((part: string) => part.includes('Bash(fadeno:'));
      const verified = verifications.find((v) => v.driver === compiled.driver && v.model === compiled.modelId);
      homeDriver = compiled.driver;
      row = {
        name,
        provider: compiled.provider,
        id: entry.id,
        model_id: compiled.modelId,
        effort: compiled.effectiveEffort,
        driver: compiled.driver,
        home_via: modelVia,
        adapter,
        native: adapter === 'host',
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
        home_via: modelVia,
        adapter: null,
        native: false,
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
        const laneFadeno =
          laneAdapter === 'command' &&
          (laneCompiled.spec as CommandExecutorSpec).command.some((part: string) => part.includes('Bash(fadeno:'));
        lanes.push({
          via: alias,
          id: laneCompiled.modelId,
          adapter: laneAdapter,
          delivery: alias,
          fadeno_capable: laneFadeno,
        });
      } catch {
        // driver exists but cannot deliver this model here — not a lane
      }
    }
    rows.push(row);
  }

  // Table order groups by the printed `via` column, not registry scan order.
  // ModelRow.provider is `string | null` even though neither construction path
  // above yields null today; `?? ''` keeps the comparator total if that ever
  // changes, with a null leading its group.
  rows.sort((a, b) => {
    if (a.home_via !== b.home_via) return a.home_via < b.home_via ? -1 : 1;
    const pa = a.provider ?? '';
    const pb = b.provider ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

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
  const { route, modelsCommand, ids: tokens } = runListingCommand(profile, driver, opts.spawn);

  // Which registry names deliver a given id through this driver: the home
  // route's alias matching (delivered id = entry.id), or an explicit
  // per-driver spelling.
  const registeredBy = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(profile.models)) {
    const ids: string[] = [];
    const homeKey = entry.delivery?.route ?? entry.provider;
    const home = routesForHarness(profile)[homeKey];
    if (home != null && (home.driver ?? homeKey) === driver) ids.push(qualifyListedModelId(home, entry.delivery?.id ?? entry.id));
    if (entry.spellings[driver] != null) ids.push(qualifyListedModelId(route, entry.spellings[driver]!));
    for (const id of ids) {
      const list = registeredBy.get(id) ?? [];
      if (!list.includes(name)) list.push(name);
      registeredBy.set(id, list);
    }
  }

  const models: DriverListingResult['models'] = [];
  for (const token of tokens) {
    models.push({ id: token, registered_as: (registeredBy.get(token) ?? []).sort() });
  }
  return { driver, harness, models_command: modelsCommand, models };
}

export interface ModelAddOptions extends ModelsCommonOptions {
  alias: string;
  /** The upstream identity, `provider/id`; it is not the canonical alias. */
  discoveryId: string;
  /** Test seam for the one driver listing call per discovery driver. */
  spawn?: DriverListingOptions['spawn'];
  discoveryPath?: readonly ModelDiscoveryPath[];
}

export interface ModelAddResult {
  alias: string;
  provider: string;
  id: string;
  catalog_path: string;
  discovery_path: string;
  matched_identity: string;
  delivery: { route: string; id: string; listed_id: string };
  /** A complete project catalog masks user additions in this checkout. */
  suppressed_by_project: boolean;
}

function splitDiscoveryId(raw: string): { provider: string; id: string } {
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new ModelsError(`discovery id "${raw}" must be provider/id.`);
  }
  const provider = raw.slice(0, slash).trim();
  const id = raw.slice(slash + 1).trim();
  if (provider.length === 0 || id.length === 0 || /\s/.test(provider) || /\s/.test(id)) {
    throw new ModelsError(`discovery id "${raw}" must be a whitespace-free provider/id.`);
  }
  return { provider, id };
}

function readUserCatalog(path: string): { doc: ReturnType<typeof parseDocument>; value: Record<string, unknown> } {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : 'schema_version: 3\nmodels: {}\n';
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ModelsError(`${path} did not parse: ${doc.errors[0]!.message}`);
  const value = doc.toJS();
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelsError(`${path} is not a mapping; refusing to overwrite it.`);
  }
  const map = value as Record<string, unknown>;
  if (map.schema_version !== undefined && map.schema_version !== 3) {
    throw new ModelsError(`${path} requires schema_version: 3; refusing to overwrite it.`);
  }
  if (map.models !== undefined && (map.models == null || typeof map.models !== 'object' || Array.isArray(map.models))) {
    throw new ModelsError(`${path} has a non-mapping models: entry; refusing to overwrite it.`);
  }
  return { doc, value: map };
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.fadeno-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, path);
  } catch (err) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw new ModelsError(`could not write ${path}: ${(err as Error).message}`);
  }
}

/**
 * Promote an actually listed upstream model to a stable user-catalog alias.
 * It intentionally writes only user scope: project catalogs remain source
 * controlled, and a complete project catalog reports (rather than hides) the
 * new entry's standing there — per-key fallback serves it when its delivery
 * route resolves, and `dial show` names any that drop.
 */
export function runModelsAdd(opts: ModelAddOptions): ModelAddResult {
  const alias = opts.alias.trim();
  if (!BARE_IDENTIFIER_RE.test(alias) || alias === 'current-host') {
    throw new ModelsError(`canonical alias "${opts.alias}" must be a bare lowercase identifier and may not be current-host.`);
  }
  const { provider, id } = splitDiscoveryId(opts.discoveryId.trim());
  const repoRoot = repoRootOf(opts);
  const userCatalogPath = userPaths(opts.userPathOptions ?? {}).executorsFile;
  const { doc, value: userCatalog } = readUserCatalog(userCatalogPath);
  // Promotion is user-scoped, so discovery routes come from builtin + user,
  // never a project's self-contained replacement catalog. Alias admission is
  // the union instead: neither the global catalog nor this project may already
  // own the canonical name.
  const global = loadGlobal(opts.userPathOptions);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  if (
    Object.hasOwn(global.profile.models, alias)
    || Object.hasOwn(layered.profile.models, alias)
    || (userCatalog.models != null && typeof userCatalog.models === 'object' && Object.hasOwn(userCatalog.models as object, alias))
  ) {
    throw new ModelsError(`canonical model "${alias}" already exists; choose a new alias rather than overwriting it.`);
  }

  const path = opts.discoveryPath ?? DEFAULT_MODEL_DISCOVERY_PATH;
  if (path.length === 0) throw new ModelsError('model discovery path is empty.');
  const listings = new Map<string, string[]>();
  let matched: { step: ModelDiscoveryPath; listedId: string; delivery: { route: string; id: string } } | null = null;
  for (const step of path) {
    if (step.name.trim().length === 0 || step.driver.trim().length === 0) {
      throw new ModelsError('model discovery path entries need non-empty name and driver.');
    }
    const listedId = step.listedId(provider, id);
    const delivery = step.delivery(provider, id);
    if (listedId.trim().length === 0 || !BARE_IDENTIFIER_RE.test(delivery.route) || delivery.id.trim().length === 0) {
      throw new ModelsError(`model discovery path "${step.name}" produced an invalid delivery.`);
    }
    let ids = listings.get(step.driver);
    if (ids == null) {
      ids = runListingCommand(global.profile, step.driver, opts.spawn).ids;
      listings.set(step.driver, ids);
    }
    if (ids.includes(listedId)) {
      if (routesForHarness(global.profile)[delivery.route] == null) {
        continue;
      }
      matched = { step, listedId, delivery };
      break;
    }
  }
  if (matched == null) {
    const attempted = path.map((step) => step.listedId(provider, id)).join(', ');
    throw new ModelsError(`model "${provider}/${id}" was not found on the discovery path (tried exact identities: ${attempted}).`);
  }

  doc.set('schema_version', 3);
  if (userCatalog.models === undefined) doc.set('models', {});
  doc.setIn(['models', alias], {
    provider,
    id,
    effort: 'default',
    delivery: matched.delivery,
  });
  atomicWrite(userCatalogPath, doc.toString());
  return {
    alias,
    provider,
    id,
    catalog_path: userCatalogPath,
    discovery_path: matched.step.name,
    matched_identity: matched.listedId,
    delivery: { ...matched.delivery, listed_id: matched.listedId },
    suppressed_by_project: layered.selfContained,
  };
}

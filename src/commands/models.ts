import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadGlobalProfile, loadLayeredProfile, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  argvGrantsFadenoShell,
  BARE_IDENTIFIER_RE,
  resolveDelivery,
  detectAmbientHarness,
  ExecutorProfileError,
  qualifyListedModelId,
  type CommandExecutorSpec,
  type EligibilityState,
  type ExecutorProfile,
  type HarnessRaw,
} from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { readVerifiedModels, userPaths, type UserPathOptions } from '../lib/user-paths.ts';

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
  /** Delivered id on the home harness (effort suffix applied where encoded). */
  model_id: string | null;
  /** Registry-standard effort — frame-invariant. Command lanes inject it into
   * the argv; host lanes carry it as the request, applied by the materialized
   * agent surface. */
  effort: string;
  /**
   * The EXECUTOR harness this model resolves onto. Null when it does not
   * resolve at all (see `stale`); `home_harness` still names where it would
   * land.
   */
  harness: string | null;
  /**
   * The model's home harness — its explicit `harness:`, else whichever harness
   * claims its provider — independent of the caller and of whether it
   * resolves here. Under v4 this no longer varies by host at all: one harness
   * table, one answer.
   */
  home_harness: string;
  adapter: 'command' | 'host' | null;
  /** Resolution detail retained for structured consumers; not model identity. */
  native: boolean;
  /** The resolved argv grants the fadeno command family (director-capable). */
  fadeno_capable: boolean;
  eligibility: Record<string, EligibilityState>;
  spellings: Record<string, string>;
  /** verified_at from the probe cache for (harness, delivered id), else null. */
  verified_at: string | null;
  /** Resolution failure (no harness for provider etc.), else null. */
  stale: string | null;
  /**
   * Every non-home harness this model can be delivered on — what
   * `--harness <id>` would resolve to.
   */
  deliveries: Array<{
    harness: string;
    id: string;
    adapter: 'command' | 'host';
    variant: string | null;
    fadeno_capable: boolean;
  }>;
}

export interface ModelsResult {
  /** The ambient HOST this call is running inside. */
  host: string;
  /**
   * How the host was discovered. `fallback` means no host claimed this call,
   * so it answered as standalone.
   */
  host_source: 'FADENO_HARNESS' | 'ambient' | 'fallback';
  models: ModelRow[];
  unregistered_model_harness: string;
  /** Harness ids that declare a models_command. */
  listable_harnesses: string[];
}

function hostSource(userPathOptions: UserPathOptions = {}): ModelsResult['host_source'] {
  const env = userPathOptions.env ?? process.env;
  const explicit = env.FADENO_HARNESS?.trim();
  if (explicit === 'codex' || explicit === 'claude' || explicit === 'grok' || explicit === 'opencode' || explicit === 'omp' || explicit === 'standalone') return 'FADENO_HARNESS';
  if (detectAmbientHarness(userPathOptions).harness != null) return 'ambient';
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

/**
 * The harness table. Host-independent under v4 — the same table answers for
 * every host, which is the whole point of collapsing the six route tables.
 */
function harnessTable(profile: ExecutorProfile): Record<string, HarnessRaw> {
  return profile.harnesses ?? {};
}

export interface ModelDiscoveryPath {
  /** Stable result label for this match. */
  name: string;
  /** The harness whose single model listing is inspected. */
  harness: string;
  /** Construct the exact identity expected on that harness's listing. */
  listedId: (provider: string, id: string) => string;
  /** The harness-facing spelling recorded when this identity matched. */
  spelling: (provider: string, id: string) => string;
}

/**
 * Default ordered discovery stays data, not command control flow: an
 * integration can provide its own path without rewriting `runModelsAdd`.
 *
 * One entry under v4, where there used to be two. The second targeted the
 * `opencode-direct` ROUTE — a model OpenCode serves natively rather than
 * through OpenRouter — and v4 turned that route into the `direct` VARIANT of
 * the `opencode` harness. A variant is chosen by policy and cannot be named
 * on a dial or pinned by a model entry, so there is no v4 spelling for
 * "register this model onto the direct lane". Registering it here anyway would
 * write an entry that silently resolves onto the OpenRouter lane with a
 * direct id — the exact silent-wrong-answer shape this catalog keeps closing —
 * so the step is gone rather than wrong. See the "Known gap" section of
 * docs/experimental/harness-neutral-dials.md.
 */
export const DEFAULT_MODEL_DISCOVERY_PATH: readonly ModelDiscoveryPath[] = [
  {
    name: 'opencode/openrouter',
    harness: 'opencode',
    listedId: (provider, id) => `openrouter/${provider}/${id}`,
    spelling: (provider, id) => `${provider}/${id}`,
  },
];

type ListingSpawn = NonNullable<HarnessListingOptions['spawn']>;

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
  harness: string,
  spawn: ListingSpawn | undefined,
): { entry: HarnessRaw; modelsCommand: string[]; ids: string[] } {
  const entry = harnessTable(profile)[harness];
  if (entry == null) {
    throw new ModelsError(`unknown harness "${harness}" — declared harnesses: ${Object.keys(harnessTable(profile)).sort().join(', ') || '(none)'}`);
  }
  const modelsCommand = entry.models_command;
  if (modelsCommand == null || modelsCommand.length === 0) {
    throw new ModelsError(`harness "${harness}" declares no models_command — its backend cannot be listed.`);
  }
  const spawnFn = spawn ?? defaultSpawn;
  let result: ReturnType<ListingSpawn>;
  try {
    result = spawnFn(modelsCommand, { timeout: 10_000 });
  } catch (err) {
    throw new ModelsError(`models_command failed for ${harness}: ${(err as Error).message}`);
  }
  if (result.error != null) throw new ModelsError(`models_command failed for ${harness}: ${result.error.message}`);
  if (result.status !== 0) throw new ModelsError(`models_command for ${harness} exited ${result.status}.`);
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  return { entry, modelsCommand, ids: listedIds(stdout) };
}

/**
 * The model's home HARNESS: its explicit `harness:`, else whichever harness
 * claims its provider. Frame-neutral by construction now — there is one
 * harness table, so the answer no longer depends on which host is asking.
 */
function homeHarness(profile: ExecutorProfile, entry: ExecutorProfile['models'][string]): string {
  if (entry.harness != null) return entry.harness;
  for (const [id, harness] of Object.entries(harnessTable(profile))) {
    if (harness.provider === entry.provider) return id;
  }
  return entry.provider;
}

export function runModels(opts: ModelsCommonOptions = {}): ModelsResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const host = profile.host ?? 'standalone';
  const verifications = readVerifiedModels(opts.userPathOptions ?? {});
  const harnessIds = Object.keys(harnessTable(profile)).sort();

  const rows: ModelRow[] = [];
  for (const name of Object.keys(profile.models).sort()) {
    const entry = profile.models[name]!;
    const home = name === 'current-host' ? 'current-host' : homeHarness(profile, entry);
    const deliveries: ModelRow['deliveries'] = [];
    let resolvedHarness: string | null = null;
    let row: ModelRow;
    try {
      const compiled = resolveDelivery({ model: name }, profile);
      const adapter = compiled.spec.adapter;
      // Read straight off the argv that will actually run.
      const fadenoCapable =
        adapter === 'command' &&
        argvGrantsFadenoShell((compiled.spec as CommandExecutorSpec).command);
      const verified = verifications.find((v) => v.harness === compiled.harness && v.model === compiled.modelId);
      resolvedHarness = compiled.harness;
      row = {
        name,
        provider: compiled.provider,
        id: entry.id,
        model_id: compiled.modelId,
        effort: compiled.effectiveEffort,
        harness: compiled.harness,
        home_harness: home,
        adapter,
        // `hostCandidate`, not `adapter`: "native" means this model runs in the
        // session you are in, and a host spec is also how a delivery with no
        // argv at all is represented.
        native: compiled.hostCandidate,
        fadeno_capable: fadenoCapable,
        eligibility: { ...entry.eligibility },
        spellings: { ...entry.spellings },
        verified_at: verified?.verified_at ?? null,
        stale: null,
        deliveries,
      };
    } catch (err) {
      // A registered name whose provider claims no harness is still worth
      // listing — the registry is a registry, not a delivery promise.
      row = {
        name,
        provider: entry.provider,
        id: entry.id,
        model_id: null,
        effort: entry.effort,
        harness: null,
        home_harness: home,
        adapter: null,
        native: false,
        fadeno_capable: false,
        eligibility: { ...entry.eligibility },
        spellings: { ...entry.spellings },
        verified_at: null,
        stale: err instanceof ExecutorProfileError ? err.message : String(err),
        deliveries,
      };
    }
    for (const candidate of harnessIds) {
      if (candidate === resolvedHarness || name === 'current-host') continue;
      try {
        const alt = resolveDelivery({ model: name, harness: candidate }, profile);
        const altAdapter = alt.spec.adapter;
        const altCommand = altAdapter === 'command'
          ? (alt.spec as CommandExecutorSpec).command
          : (alt.spec as { fallbackCommand?: string[] | null }).fallbackCommand ?? [];
        deliveries.push({
          harness: candidate,
          id: alt.modelId,
          adapter: altAdapter,
          variant: alt.variant,
          fadeno_capable: argvGrantsFadenoShell(altCommand),
        });
      } catch {
        // harness exists but cannot deliver this model — not a delivery
      }
    }
    rows.push(row);
  }

  // Table order groups by the printed `harness` column, not registry scan
  // order. ModelRow.provider is `string | null` even though neither
  // construction path above yields null today; `?? ''` keeps the comparator
  // total if that ever changes, with a null leading its group.
  rows.sort((a, b) => {
    if (a.home_harness !== b.home_harness) return a.home_harness < b.home_harness ? -1 : 1;
    const pa = a.provider ?? '';
    const pb = b.provider ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const listable = harnessIds.filter((id) => {
    const command = harnessTable(profile)[id]!.models_command;
    return command != null && command.length > 0;
  });

  return {
    host,
    host_source: hostSource(opts.userPathOptions),
    models: rows,
    unregistered_model_harness: profile.unregisteredModelHarness,
    listable_harnesses: listable,
  };
}

export interface HarnessListingOptions extends ModelsCommonOptions {
  harness: string;
  /** Test seam mirroring probeModel's. */
  spawn?: (command: string[], opts: { timeout: number }) => {
    status: number | null;
    stdout: string | Buffer;
    stderr: string | Buffer;
    error?: Error;
  };
}

export interface HarnessListingResult {
  harness: string;
  /** The ambient HOST this call ran inside; the listing itself is host-free. */
  host: string;
  models_command: string[];
  /** Every id the backend listed, in listing order (deduplicated). */
  models: Array<{
    id: string;
    /** Registry names that deliver this id on this harness (home or spelling). */
    registered_as: string[];
  }>;
}

export function runModelsHarness(opts: HarnessListingOptions): HarnessListingResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const host = profile.host ?? 'standalone';
  const harness = opts.harness.trim();
  const { entry, modelsCommand, ids: tokens } = runListingCommand(profile, harness, opts.spawn);

  // Which registry names deliver a given id on this harness: the home rule
  // (delivered id = entry.id), or an explicit per-harness spelling.
  const registeredBy = new Map<string, string[]>();
  for (const [name, model] of Object.entries(profile.models)) {
    if (name === 'current-host') continue;
    const ids: string[] = [];
    if (homeHarness(profile, model) === harness) ids.push(qualifyListedModelId(entry, model.id));
    if (model.spellings[harness] != null) ids.push(qualifyListedModelId(entry, model.spellings[harness]!));
    for (const id of ids) {
      const list = registeredBy.get(id) ?? [];
      if (!list.includes(name)) list.push(name);
      registeredBy.set(id, list);
    }
  }

  const models: HarnessListingResult['models'] = [];
  for (const token of tokens) {
    models.push({ id: token, registered_as: (registeredBy.get(token) ?? []).sort() });
  }
  return { harness, host, models_command: modelsCommand, models };
}

export interface ModelAddOptions extends ModelsCommonOptions {
  alias: string;
  /** The upstream identity, `provider/id`; it is not the canonical alias. */
  discoveryId: string;
  /** Test seam for the one listing call per discovery harness. */
  spawn?: HarnessListingOptions['spawn'];
  discoveryPath?: readonly ModelDiscoveryPath[];
}

export interface ModelAddResult {
  alias: string;
  provider: string;
  id: string;
  catalog_path: string;
  discovery_path: string;
  matched_identity: string;
  /** The harness the alias was registered onto, and its harness-facing id. */
  delivery: { harness: string; id: string; listed_id: string };
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
  const text = existsSync(path) ? readFileSync(path, 'utf8') : 'schema_version: 4\nmodels: {}\n';
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ModelsError(`${path} did not parse: ${doc.errors[0]!.message}`);
  const value = doc.toJS();
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelsError(`${path} is not a mapping; refusing to overwrite it.`);
  }
  const map = value as Record<string, unknown>;
  // A v3 user catalog is still readable (a `models:`-only personal catalog is
  // not made wrong by the bump), but writing bumps it to 4 — the entry this
  // command adds is v4-shaped.
  if (map.schema_version !== undefined && map.schema_version !== 3 && map.schema_version !== 4) {
    throw new ModelsError(`${path} requires schema_version: 4; refusing to overwrite it.`);
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
 * new entry's standing there — per-key fallback serves it when the merged
 * `harnesses:` table can deliver it, and `dial show` names any that drop.
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
  // Promotion is user-scoped, so the harnesses whose `models_command` does
  // the discovery come from builtin + user, never a project's self-contained
  // replacement catalog. Alias admission is
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
  let matched: { step: ModelDiscoveryPath; listedId: string; spelling: string } | null = null;
  for (const step of path) {
    if (step.name.trim().length === 0 || !BARE_IDENTIFIER_RE.test(step.harness.trim())) {
      throw new ModelsError('model discovery path entries need a non-empty name and a bare harness id.');
    }
    const listedId = step.listedId(provider, id);
    const spelling = step.spelling(provider, id);
    if (listedId.trim().length === 0 || spelling.trim().length === 0) {
      throw new ModelsError(`model discovery path "${step.name}" produced an invalid delivery.`);
    }
    let ids = listings.get(step.harness);
    if (ids == null) {
      ids = runListingCommand(global.profile, step.harness, opts.spawn).ids;
      listings.set(step.harness, ids);
    }
    if (ids.includes(listedId)) {
      if (harnessTable(global.profile)[step.harness] == null) continue;
      matched = { step, listedId, spelling };
      break;
    }
  }
  if (matched == null) {
    const attempted = path.map((step) => step.listedId(provider, id)).join(', ');
    // The listing is already in hand, so say WHICH failure this is. A model
    // OpenCode serves directly (listed bare, without the `openrouter/`
    // namespace) is not missing — it is unregistrable under v4, because the
    // lane that would deliver it is a policy-chosen variant and no model entry
    // can name one. Saying "not found" for that sends the user hunting for a
    // spelling that is right in front of them.
    const directlyListed = [...listings.values()].some((ids) => ids.includes(`${provider}/${id}`));
    if (directlyListed) {
      throw new ModelsError(
        `model "${provider}/${id}" IS listed by OpenCode, but only as a direct (non-OpenRouter) identity, and ` +
          'catalog v4 cannot register that yet: the direct lane is the `direct` VARIANT of the `opencode` ' +
          'harness, variants are chosen by policy, and no model entry can name one. See the "Known gap" ' +
          'section of docs/experimental/harness-neutral-dials.md.',
      );
    }
    throw new ModelsError(`model "${provider}/${id}" was not found on the discovery path (tried exact identities: ${attempted}).`);
  }

  doc.set('schema_version', 4);
  if (userCatalog.models === undefined) doc.set('models', {});
  // v4 shape: name the executor harness, and put the harness-facing id in
  // `spellings.<harness>`. (Was `delivery: { route, id }`.)
  doc.setIn(['models', alias], {
    provider,
    id,
    effort: 'default',
    harness: matched.step.harness,
    spellings: { [matched.step.harness]: matched.spelling },
  });
  atomicWrite(userCatalogPath, doc.toString());
  return {
    alias,
    provider,
    id,
    catalog_path: userCatalogPath,
    discovery_path: matched.step.name,
    matched_identity: matched.listedId,
    delivery: { harness: matched.step.harness, id: matched.spelling, listed_id: matched.listedId },
    suppressed_by_project: layered.selfContained,
  };
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  CATALOG_TOP_LEVEL_KEYS,
  ExecutorProfileError,
  PRE_DIALS_CATALOG_KEYS,
  parseExecutorProfile,
  preDialsCatalogError,
  suggestCatalogKey,
  type CatalogTopLevelKey,
  type ExecutorProfile,
  type HarnessId,
} from './executors.ts';
import { templatesDir } from './paths.ts';
import { userPaths, type FadenoUserPaths, type UserPathOptions } from './user-paths.ts';

export type ConfigLayer = 'builtin' | 'user' | 'project';

export interface ProfileProvenance {
  bindings: Record<string, ConfigLayer>;
  /** Which layer supplied each `models:` entry, when tracked. Absent keys predate tracking. */
  models?: Record<string, ConfigLayer>;
}

/**
 * What happened to the user catalog's personal models when a self-contained
 * project catalog took over. Names the outcome instead of leaving it implicit:
 * a promoted alias behaves exactly like a project-declared one, and a dropped
 * one failed INTEGRITY (its delivery route resolves nowhere in the merged
 * catalog), never mere absence from the project's `models:` list.
 */
export interface ModelFallbackOutcome {
  /** User-catalog model names promoted into the effective profile. */
  promoted: string[];
  /**
   * User-catalog model names dropped because their home delivery route is not
   * declared anywhere in the merged route table. `route` is the unresolved
   * route key (`delivery.route`, or `provider` when the entry declares no
   * delivery).
   */
  dropped: Array<{ alias: string; route: string }>;
}

export interface LayeredProfile {
  profile: ExecutorProfile;
  path: string;
  layers: ConfigLayer[];
  provenance: ProfileProvenance;
  paths: FadenoUserPaths;
  /**
   * A complete project catalog took over and suppressed builtin/user layering.
   * This — not `layers.includes('user')` — is what makes a user-scope dial
   * inapplicable: `layers` only reports which catalogs exist on disk, so a repo
   * with no project catalog at all (`['builtin']`) would read as "no user
   * layer" and wrongly drop a pin that names a perfectly valid builtin loadout.
   *
   * Suppression is wholesale EXCEPT for one deliberate carve-out: user-catalog
   * models fall back per-key (see `modelFallback`). A personal alias is state,
   * not catalog policy — an unlisted name in the project's `models:` is not an
   * explicit exclusion of it.
   */
  selfContained: boolean;
  /**
   * Builtin `archetypes:` keys the project catalog omitted. Non-empty only
   * when a self-contained project profile suppressed layering.
   */
  suppressedCanonArchetypes: string[];
  /**
   * Per-key model fallback outcomes. Empty (not null) whenever layering ran
   * normally — a self-contained catalog is the only loader path that can
   * promote or drop a user model.
   */
  modelFallback: ModelFallbackOutcome;
}

function mapping(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseLayer(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ExecutorProfileError(`${path} did not parse: ${(err as Error).message}`);
  }
  const doc = mapping(parsed);
  if (!doc) throw new ExecutorProfileError(`${path} is not a mapping.`);
  return doc;
}

/**
 * Top-level keys merged entry by entry, so a later layer overrides individual
 * names instead of replacing the whole mapping. Every other key in
 * `CATALOG_TOP_LEVEL_KEYS` is copied whole — including any key added there
 * later, which is the point: a new catalog key now layers by default rather
 * than being silently dropped until someone remembers this file. Typed to the
 * key union so a typo in this subset is a compile error, not another
 * quietly-inert key.
 */
const ENTRY_MERGED_KEYS: ReadonlySet<CatalogTopLevelKey> = new Set<CatalogTopLevelKey>([
  'routes',
  'archetypes',
  'bindings',
  'models',
  'dials',
  'tools',
  // Per-harness, so entry-merged: overriding the Codex relay in a project
  // catalog must not silently drop the builtin's Claude relay beside it.
  'relay',
]);

/**
 * Reject unknown top-level keys in ONE layer's raw document, before the
 * selective merge below reads out the keys it knows by name.
 *
 * This has to happen here and cannot happen in `parseExecutorProfile`: the
 * merge copies top-level keys by exact literal name, so a MISSPELLED key
 * (`worktree_carrry:` for `worktree_carry:`) is never looked up, never
 * copied, and therefore never reaches the parser's strict unknown-key check —
 * it vanishes, and the feature it was meant to switch on silently does
 * nothing. For `worktree_carry` specifically that is a shadow challenger with
 * no `node_modules`, unable to build or test, with nothing said about it. The
 * raw per-layer document is the last place the typo still exists.
 *
 * Scope note: only the layers that actually take part in the merge are
 * checked. A self-contained project catalog suppresses the builtin and user
 * layers wholesale by design — except the per-key user-model fallback
 * (`applyUserModelFallback`), which merges a fragment of the user layer after
 * this check has run. That fragment is a `models:` mapping read out of a file
 * that passed its own layer's check when it was written; and a repo
 * insulating itself this way should not start failing over a key in a file it
 * deliberately does not consult.
 */
function validateLayerKeys(doc: Record<string, unknown>, path: string): void {
  const unknown = Object.keys(doc).filter((key) => !(CATALOG_TOP_LEVEL_KEYS as readonly string[]).includes(key));
  if (unknown.length === 0) return;
  // A pre-dials catalog is misdated, not misspelled: keep the migration
  // instructions it would have got from the parser rather than offering a
  // did-you-mean for `loadouts:`. Naming the file is the gain here — the
  // merged document the parser sees is attributed to "builtin + user +
  // project", which does not say which file to edit.
  if (unknown.some((key) => (PRE_DIALS_CATALOG_KEYS as readonly string[]).includes(key))) {
    throw preDialsCatalogError(path);
  }
  const described = unknown.map((key) => {
    const near = suggestCatalogKey(key);
    return near != null ? `\`${key}\` (did you mean \`${near}\`?)` : `\`${key}\``;
  });
  throw new ExecutorProfileError(
    `${path}: unknown top-level key${unknown.length === 1 ? '' : 's'} ${described.join(', ')}. ` +
      `Known keys: ${CATALOG_TOP_LEVEL_KEYS.join(', ')}.`,
  );
}

function mergeLayer(target: Record<string, unknown>, source: Record<string, unknown>, layer: ConfigLayer, path: string, provenance: ProfileProvenance): void {
  // Disallow dials in non-project layers
  if (layer !== 'project' && mapping(source.dials) != null && Object.keys(mapping(source.dials)!).length > 0) {
    throw new ExecutorProfileError('repo pins live in the project catalog; user dials are state — use `fadeno dial <archetype> <model> --user`');
  }
  // Disallow worktree_carry in non-project layers, same shape as `dials`
  // above and for the same reason: it describes THIS repo's gitignored
  // build state (deps, build output, a local `.fadeno/` catalog), not a
  // role or a model, so a user- or builtin-scope declaration could never
  // name paths that make sense in whatever repo happens to load that
  // layer. Project-only keeps the declaration co-located with the repo it
  // describes.
  if (layer !== 'project' && Array.isArray(source.surfaces) && source.surfaces.length > 0) {
    throw new ExecutorProfileError('surfaces describes this repo\'s shape; it is project-only — declare it in .fadeno/executors.yaml, not the user or builtin catalog.');
  }
  if (layer !== 'project' && Array.isArray(source.worktree_carry) && source.worktree_carry.length > 0) {
    throw new ExecutorProfileError('worktree_carry describes this repo\'s build state; it is project-only — declare it in .fadeno/executors.yaml, not the user or builtin catalog.');
  }
  // After the placement checks above, never before: a key that is KNOWN but
  // declared in the wrong layer has its own specific message, and must keep
  // saying so rather than being reported as unknown.
  validateLayerKeys(source, path);
  for (const key of CATALOG_TOP_LEVEL_KEYS) {
    if (!ENTRY_MERGED_KEYS.has(key)) {
      if (source[key] !== undefined) target[key] = source[key];
      continue;
    }
    // `undefined` is absent, and a bare `key:` with nothing under it parses
    // as `null` — both mean "this layer says nothing", and both are skipped
    // as they always were. Anything else that is not a mapping is a DECLARED
    // value of the wrong shape: `dials: "sol"`, `tools: []`. Those used to be
    // dropped right here, before the parser could reject them, so the catalog
    // loaded clean and the declaration did nothing — the same silent-drop
    // failure as a misspelled top-level key, one layer down.
    //
    // Rejecting only the non-null case is what makes this safe: the parser is
    // inconsistent about null (`dials`/`bindings` throw, `archetypes`/
    // `constraints`/`tools` tolerate), so forwarding null instead of skipping
    // it would make a bare `dials:` start failing.
    if (source[key] !== undefined && source[key] !== null && mapping(source[key]) == null) {
      throw new ExecutorProfileError(
        `${path}: \`${key}\` must be a mapping; found ${Array.isArray(source[key]) ? 'an array' : typeof source[key]}.`,
      );
    }
    const entries = mapping(source[key]);
    if (entries == null) continue;
    const current = mapping(target[key]) ?? {};
    for (const [name, value] of Object.entries(entries)) {
      if ((key === 'routes' || key === 'models') && mapping(value) != null && mapping(current[name]) != null) {
        current[name] = { ...(current[name] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        current[name] = value;
      }
      if (key === 'bindings') provenance.bindings[name] = layer;
      if (key === 'models') (provenance.models ??= {})[name] = layer;
    }
    target[key] = current;
  }
}

function projectIsComplete(doc: Record<string, unknown>): boolean {
  const models = mapping(doc.models);
  const routes = mapping(doc.routes);
  if (models == null || Object.keys(models).length === 0) return false;
  if (routes == null || Object.keys(routes).length === 0) return false;
  return true;
}

/** Builtin archetype keys absent from a self-contained project catalog. */
function missingCanonArchetypes(
  builtinDoc: Record<string, unknown> | null,
  projectDoc: Record<string, unknown> | null,
): string[] {
  const builtin = builtinDoc != null ? mapping(builtinDoc.archetypes) : null;
  if (builtin == null || projectDoc == null) return [];
  const declared = mapping(projectDoc.archetypes) ?? {};
  return Object.keys(builtin).filter((name) => !Object.hasOwn(declared, name)).sort();
}

/**
 * The home route key a model entry compiles against: its declared delivery
 * route when it has one, else its provider (the `homeKey = delivery?.route ??
 * provider` rule in `compileDialRef`). Null when the entry is not a mapping —
 * the parser will reject that shape anyway; the fallback must not crash first.
 */
function modelHomeRoute(entry: unknown): string | null {
  const map = mapping(entry);
  if (map == null) return null;
  const delivery = mapping(map.delivery);
  if (delivery != null && typeof delivery.route === 'string' && delivery.route.trim().length > 0) {
    return delivery.route.trim();
  }
  const provider = map.provider;
  if (typeof provider === 'string' && provider.trim().length > 0) return provider.trim();
  return null;
}

/**
 * Per-key user-model fallback into a self-contained project catalog.
 *
 * A self-contained catalog suppresses the user layer wholesale EXCEPT for one
 * carve-out: models. A personal alias (`fadeno models add`) is machine state,
 * not repo policy — a project catalog that simply does not list `ox` has not
 * thereby excluded it. Without this fallback the alias silently vanished,
 * dispatch fell through to the unregistered path, and the task died hours
 * later on an upstream error naming neither file (observed 2026-08-24: an
 * `ox` alias promoted at user scope never reached a self-contained checkout).
 *
 * Integrity guard: promotion requires the entry's home route to be declared in
 * at least one harness route table of the MERGED catalog. A dangling route
 * reference cannot compile anywhere, so merging it would only move today's
 * late confusing failure (`no route for provider ... in harness ...`, thrown
 * from deep inside `compileDialRef` at dispatch time) into the profile under a
 * name nobody asked for. Dropped entries are named, not silent; per-harness
 * gaps stay with `compileDialRef`'s existing loud per-harness errors.
 */
function applyUserModelFallback(
  document: Record<string, unknown>,
  userDoc: Record<string, unknown> | undefined,
  userPath: string,
  provenance: ProfileProvenance,
): ModelFallbackOutcome {
  const outcome: ModelFallbackOutcome = { promoted: [], dropped: [] };
  const userModelEntries = userDoc != null ? mapping(userDoc.models) : null;
  if (userModelEntries == null || Object.keys(userModelEntries).length === 0) return outcome;
  const targetModels = mapping(document.models);
  if (targetModels == null) return outcome;
  const mergedRoutes = mapping(document.routes) ?? {};
  const routeDeclaredSomewhere = (routeKey: string): boolean =>
    Object.values(mergedRoutes).some((table) => {
      const routes = mapping(table);
      return routes != null && routes[routeKey] != null;
    });
  for (const [alias, entry] of Object.entries(userModelEntries)) {
    // A project-declared (or already-promoted) name wins: explicit catalog
    // policy outranks personal state, and admission in `runModelsAdd` makes
    // same-name collisions rare enough to stay quiet here.
    if (Object.hasOwn(targetModels, alias)) continue;
    const routeKey = modelHomeRoute(entry);
    if (routeKey == null || !routeDeclaredSomewhere(routeKey)) {
      outcome.dropped.push({ alias, route: routeKey ?? '?' });
      continue;
    }
    mergeLayer(document, { models: { [alias]: entry } }, 'user', userPath, provenance);
    outcome.promoted.push(alias);
  }
  return outcome;
}

/**
 * Compose bundled → user → project profiles. A self-contained legacy project
 * profile remains authoritative — it suppresses the builtin and user layers,
 * with one deliberate carve-out: the user catalog's personal models fall back
 * per-key, integrity-gated on their delivery route resolving in the merged
 * route table (see `applyUserModelFallback`).
 */
export function loadLayeredProfile(repoRoot: string, options: UserPathOptions = {}, harness?: HarnessId): LayeredProfile {
  const paths = userPaths(options);
  const layers: Array<{ layer: ConfigLayer; path: string }> = [
    { layer: 'builtin', path: `${templatesDir()}/common/fadeno/executors.yaml` },
    { layer: 'user', path: paths.executorsFile },
    { layer: 'project', path: join(repoRoot, '.fadeno', 'executors.yaml') },
  ];
  const present = layers.filter((entry) => existsSync(entry.path));
  if (present.length === 0) throw new ExecutorProfileError('No executor catalog is available.');
  const parsedLayers = new Map(present.map((entry) => [entry.layer, parseLayer(entry.path)]));
  const project = present.find((entry) => entry.layer === 'project');
  const projectDoc = project ? parsedLayers.get('project') ?? null : null;
  const suppressLayering = Boolean(projectDoc && projectIsComplete(projectDoc));
  const effective = suppressLayering
    ? [{ layer: 'project' as ConfigLayer, path: project!.path }]
    : present;
  const document: Record<string, unknown> = {};
  const provenance: ProfileProvenance = { bindings: {} };
  for (const entry of effective) mergeLayer(document, parsedLayers.get(entry.layer)!, entry.layer, entry.path, provenance);
  // The carve-out: even when the project layer suppressed layering, the user
  // catalog's personal models fall back per-key (integrity-gated). Runs only
  // on the suppression path — normal layering already merges models by key.
  const modelFallback = suppressLayering
    ? applyUserModelFallback(document, parsedLayers.get('user'), layers.find((entry) => entry.layer === 'user')?.path ?? '', provenance)
    : { promoted: [], dropped: [] };
  const text = stringifyObject(document);
  return {
    profile: parseExecutorProfile(text, effective.map((entry) => entry.layer).join(' + '), harness),
    path: project?.path ?? present.find((entry) => entry.layer === 'user')?.path ?? present[0]!.path,
    layers: effective.map((entry) => entry.layer),
    provenance,
    paths,
    selfContained: suppressLayering,
    suppressedCanonArchetypes: suppressLayering
      ? missingCanonArchetypes(parsedLayers.get('builtin') ?? null, projectDoc)
      : [],
    modelFallback,
  };
}

/**
 * The portable, user-scoped catalog view: bundled defaults plus the user's
 * additions, intentionally excluding the current project's self-contained
 * catalog. Commands that PROMOTE into user scope use this to avoid letting a
 * project hide canonical names or the discovery routes that user models rely
 * on; callers that need current-repo visibility still load the layered view.
 */
export function loadGlobalProfile(options: UserPathOptions = {}, harness?: HarnessId): LayeredProfile {
  const paths = userPaths(options);
  const layers: Array<{ layer: ConfigLayer; path: string }> = [
    { layer: 'builtin', path: `${templatesDir()}/common/fadeno/executors.yaml` },
    { layer: 'user', path: paths.executorsFile },
  ];
  const present = layers.filter((entry) => existsSync(entry.path));
  if (present.length === 0) throw new ExecutorProfileError('No executor catalog is available.');
  const document: Record<string, unknown> = {};
  const provenance: ProfileProvenance = { bindings: {} };
  for (const entry of present) {
    const parsed = parseLayer(entry.path);
    mergeLayer(document, parsed, entry.layer, entry.path, provenance);
  }
  return {
    profile: parseExecutorProfile(stringifyObject(document), present.map((entry) => entry.layer).join(' + '), harness),
    path: present.find((entry) => entry.layer === 'user')?.path ?? present[0]!.path,
    layers: present.map((entry) => entry.layer),
    provenance,
    paths,
    selfContained: false,
    suppressedCanonArchetypes: [],
    modelFallback: { promoted: [], dropped: [] },
  };
}

/**
 * Declarations the builtin catalog makes that a SELF-CONTAINED project catalog
 * silently drops, as dotted paths.
 *
 * A project catalog that declares its own `models:` and `routes:` suppresses
 * the builtin layer wholesale (see `projectIsComplete`; user models are the
 * one per-key carve-out). That is a supported, deliberate mode — and it is
 * also a one-way ratchet: from that moment the catalog can only fall behind
 * the builtin sitting next to it, and nothing ever says so. This repo's own
 * catalog drifted 25 `timeout_ms` declarations, a stale `relay.codex`, and the
 * entire `tools:` block that way while `doctor` reported zero warnings.
 *
 * **Absences only, never differing values.** A different value IS the point of
 * an override, so reporting it would be noise on every honest catalog. An
 * absence is almost never deliberate: someone overriding a route changes its
 * argv, they do not delete `timeout_ms` from it. That asymmetry is what makes
 * this check quiet enough to leave on — and it is also its known blind spot,
 * so a stale VALUE still goes unreported.
 *
 * Descends only into nodes BOTH sides declare as mappings, and reports only
 * SCALAR absences. Omitting a whole model or route is a legitimate way to ship
 * a smaller catalog; omitting a scalar from a route you DID declare is the
 * drift being looked for.
 */
export function missingBuiltinDeclarations(
  builtinDoc: Record<string, unknown> | null,
  projectDoc: Record<string, unknown> | null,
): string[] {
  if (builtinDoc == null || projectDoc == null) return [];
  const missing: string[] = [];
  const walk = (builtin: Record<string, unknown>, project: Record<string, unknown>, path: string): void => {
    for (const [key, builtinValue] of Object.entries(builtin)) {
      const here = path === '' ? key : `${path}.${key}`;
      if (!Object.hasOwn(project, key)) {
        // Only a SCALAR (or list) the builtin declares counts as drift. A
        // missing mapping is a whole model, route, or archetype the project
        // chose not to ship, which is the normal way to keep a catalog small —
        // reporting it would fire on every honest self-contained catalog. A
        // missing scalar on a node the project DID declare is the drift being
        // looked for: nobody deliberately deletes `timeout_ms` from a route
        // they are otherwise copying.
        if (mapping(builtinValue) == null) missing.push(here);
        continue;
      }
      // Arrays are leaves: a shorter list is a value difference, not an
      // absence, and this check deliberately says nothing about values.
      const builtinChild = mapping(builtinValue);
      const projectChild = mapping(project[key]);
      if (builtinChild != null && projectChild != null) walk(builtinChild, projectChild, here);
    }
  };
  walk(builtinDoc, projectDoc, '');
  return missing;
}

/**
 * The same report for a repo on disk: `null` when nothing is suppressed —
 * either there is no project catalog, or it layers normally and therefore
 * cannot fall behind.
 */
export function explainSuppressedBuiltin(
  repoRoot: string,
  options: UserPathOptions = {},
): { missing: string[] } | null {
  void options;
  const projectPath = join(repoRoot, '.fadeno', 'executors.yaml');
  const builtinPath = `${templatesDir()}/common/fadeno/executors.yaml`;
  if (!existsSync(projectPath) || !existsSync(builtinPath)) return null;
  let projectDoc: Record<string, unknown>;
  let builtinDoc: Record<string, unknown>;
  try {
    projectDoc = parseLayer(projectPath);
    builtinDoc = parseLayer(builtinPath);
  } catch {
    // A catalog that will not parse is a louder problem that other checks
    // already report; this one stays silent rather than double-reporting.
    return null;
  }
  if (!projectIsComplete(projectDoc)) return null;
  return { missing: missingBuiltinDeclarations(builtinDoc, projectDoc) };
}

function stringifyObject(value: Record<string, unknown>): string {
  return stringifyYaml(value);
}

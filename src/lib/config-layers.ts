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
   */
  selfContained: boolean;
  /**
   * Builtin `archetypes:` keys the project catalog omitted. Non-empty only
   * when a self-contained project profile suppressed layering.
   */
  suppressedCanonArchetypes: string[];
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
 * layers wholesale by design, and a repo insulating itself that way should
 * not start failing over a key in a file it deliberately does not consult.
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
 * Compose bundled → user → project profiles. A self-contained legacy project
 * profile remains authoritative, preserving the pre-layering contract.
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
  };
}

/**
 * Declarations the builtin catalog makes that a SELF-CONTAINED project catalog
 * silently drops, as dotted paths.
 *
 * A project catalog that declares its own `models:` and `routes:` suppresses
 * the builtin and user layers wholesale (see `projectIsComplete`). That is a
 * supported, deliberate mode — and it is also a one-way ratchet: from that
 * moment the catalog can only fall behind the builtin sitting next to it, and
 * nothing ever says so. This repo's own catalog drifted 25 `timeout_ms`
 * declarations, a stale `relay.codex`, and the entire `tools:` block that way
 * while `doctor` reported zero warnings.
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

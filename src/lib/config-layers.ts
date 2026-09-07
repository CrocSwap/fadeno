import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  refuseRemovedCatalogKeys,
  BARE_IDENTIFIER_RE,
  CATALOG_TOP_LEVEL_KEYS,
  ExecutorProfileError,
  PRE_DIALS_CATALOG_KEYS,
  V4_REMOVED_CATALOG_KEYS,
  formatDialRef,
  legacyDriverHarness,
  parseDialRef,
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
  /**
   * For each `models:` name the USER layer overrode, the entry it displaced —
   * so an override that turns out to be undeliverable can put the lower
   * layer's model back instead of taking the name out of the catalog with it.
   *
   * Recorded during the merge because that is the only moment both values
   * exist: the entry merge produces a NEW object, so this reference stays the
   * pre-user one.
   */
  shadowedModels?: Record<string, unknown>;
}

/**
 * What happened to the user catalog's personal models when a self-contained
 * project catalog took over. Names the outcome instead of leaving it implicit:
 * a promoted alias behaves exactly like a project-declared one, and a dropped
 * one failed INTEGRITY (nothing in the merged harness table can deliver it),
 * never mere absence from the project's `models:` list.
 */
export interface ModelFallbackOutcome {
  /** User-catalog model names promoted into the effective profile. */
  promoted: string[];
  /**
   * User-catalog model names dropped because nothing in the merged harness
   * table can deliver them. `harness` is the unresolved claim: the entry's
   * explicit `harness:`, or its `provider:` when no harness claims that
   * provider as home.
   */
  dropped: Array<{ alias: string; harness: string }>;
  /**
   * Everything the tolerant user-layer read changed or discarded on the way
   * in, one sentence each, already phrased for a user to read.
   *
   * Not merged into `dropped`: a repair is not a dropped model — a v3
   * `delivery:` translated into `harness:` + `spellings:` leaves the alias
   * working, and saying "dropped" about it would be a lie. Empty on every
   * catalog that is already v4, which is the common case.
   */
  repairs: string[];
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
   * What the user layer's personal models cost on the way in: promotions,
   * drops, and repairs. Empty (never null) on a catalog that is already v4 and
   * fully deliverable, which is the common case. `promoted` is the one field
   * only a self-contained catalog can fill — `dropped` and `repairs` are
   * produced on both loader paths.
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

/** The model-entry keys catalog v4 allows; anything else is residue or a typo. */
const V4_MODEL_KEYS: ReadonlySet<string> = new Set(['provider', 'id', 'effort', 'spellings', 'harness']);

/** A ref written the v3 way, as a string or in mapping form. */
function repairLegacyRef(raw: unknown): unknown {
  if (typeof raw === 'string') {
    // `parseDialRef` already reads ` via <driver>` and maps the alias; going
    // back out through `formatDialRef` is what turns the READ into a durable
    // v4 spelling, so `refuseRemovedCatalogKeys` downstream sees no ` via `.
    try {
      return formatDialRef(parseDialRef(raw, 'ref'));
    } catch {
      return raw;
    }
  }
  const map = mapping(raw);
  if (map == null || map.via === undefined) return raw;
  const { via, ...rest } = map;
  if (typeof via !== 'string' || via.trim().length === 0) return rest;
  return { ...rest, ...(rest.harness === undefined ? { harness: legacyDriverHarness(via.trim()) } : {}) };
}

/**
 * Translate a USER-layer catalog document into v4 shapes in place, dropping
 * what cannot be translated — and never throwing.
 *
 * The whole point is the asymmetry between layers. A project or builtin
 * catalog is a FILE SOMEONE EDITS: a v3 key in it is a defect, and the
 * migration error naming the key and its v4 spelling is the right answer. The
 * user catalog is MACHINE STATE — `fadeno model add` wrote it, possibly under
 * a fadeno two versions old — and one stale entry in it must not be able to
 * take out every unrelated command. It did, on 2026-09-05: an `ox` alias with
 * a provider no harness claimed made `fadeno dial reviewer opus` fail from a
 * bare shell, and nothing in the message mentioned `ox`.
 *
 * So this runs BEFORE `mergeLayer` (and therefore before
 * `refuseRemovedCatalogKeys` and the parser) and leaves behind a document that
 * cannot make either of them throw on a MODEL or a REF. Everything it changes
 * is named in `repairs`, which surfaces through `ModelFallbackOutcome`.
 *
 * Deliberately NOT tolerated, because neither is machine state and both name a
 * different schema generation with nothing to salvage: a pre-dials user
 * catalog (`targets:`/`loadouts:`) still gets `preDialsCatalogError`, and an
 * unknown top-level key still gets its did-you-mean — that check is what keeps
 * a misspelled catalog key from silently doing nothing.
 */
/**
 * v3 `routes.<host>` KEYS → the v4 harness that owns that lane. A v3 `model
 * add` wrote `delivery.route` as one of these keys (its OpenRouter step wrote
 * `openrouter`, its direct step `opencode-direct`), never as a driver alias,
 * so a route key is mapped here first and only then through the driver-alias
 * map (`legacyDriverHarness`) for hand-written `via`-style values.
 */
const V3_ROUTE_KEY_HARNESS: Record<string, string> = {
  openai: 'codex',
  anthropic: 'claude',
  'anthropic-exec': 'claude',
  xai: 'grok',
  google: 'agy',
  'opencode-direct': 'opencode',
  openrouter: 'opencode',
  muse: 'muse',
};

function legacyRouteHarness(route: string): string {
  return V3_ROUTE_KEY_HARNESS[route] ?? legacyDriverHarness(route);
}

function repairUserLayer(doc: Record<string, unknown>, path: string, repairs: string[]): void {
  const where = `user catalog ${path}`;

  // --- top-level keys v4 removed ---
  if (typeof doc.unregistered_model_driver === 'string' && doc.unregistered_model_driver.trim().length > 0) {
    const harness = legacyDriverHarness(doc.unregistered_model_driver.trim());
    if (doc.unregistered_model_harness === undefined) doc.unregistered_model_harness = harness;
    repairs.push(`${where}: \`unregistered_model_driver\` read as \`unregistered_model_harness: ${harness}\``);
  }
  for (const key of Object.keys(V4_REMOVED_CATALOG_KEYS)) {
    if (doc[key] === undefined) continue;
    delete doc[key];
    // Translated above, not ignored — one note, not two contradicting ones.
    if (key === 'unregistered_model_driver') continue;
    // `routes:` and `relay:` are per-host tables v4 replaced wholesale; there
    // is no faithful mechanical translation into a `harnesses:` entry (the
    // shallow entry merge would silently replace a harness's whole `host:`
    // block), so they are discarded rather than guessed at.
    repairs.push(`${where}: \`${key}\` was removed in catalog v4 and was ignored — declare ${V4_REMOVED_CATALOG_KEYS[key]}`);
  }

  // --- refs ---
  for (const section of ['dials', 'bindings'] as const) {
    const table = mapping(doc[section]);
    if (table == null) continue;
    for (const [name, raw] of Object.entries(table)) {
      const repaired = repairLegacyRef(raw);
      if (JSON.stringify(repaired) === JSON.stringify(raw)) continue;
      table[name] = repaired;
      repairs.push(`${where}: \`${section}.${name}\` read as "${typeof repaired === 'string' ? repaired : JSON.stringify(repaired)}"`);
    }
  }

  // --- models ---
  const models = mapping(doc.models);
  if (models == null) {
    // A declared-but-wrong-shaped `models:` would be rejected by `mergeLayer`.
    // Personal state has no business failing the load, so drop it.
    if (doc.models !== undefined && doc.models !== null) {
      delete doc.models;
      repairs.push(`${where}: \`models\` is not a mapping and was ignored`);
    }
    return;
  }
  const dropModel = (name: string, why: string): void => {
    delete models[name];
    repairs.push(`${where}: model "${name}" dropped — ${why}`);
  };
  for (const [name, raw] of Object.entries(models)) {
    if (name === 'current-host') {
      dropModel(name, '"current-host" is built in');
      continue;
    }
    if (!BARE_IDENTIFIER_RE.test(name)) {
      dropModel(name, 'the name is not a bare lowercase identifier');
      continue;
    }
    const entry = mapping(raw);
    if (entry == null) {
      dropModel(name, 'the entry is not a mapping');
      continue;
    }

    // v3 `delivery: {route, id}` → v4 `harness:` + `spellings.<harness>:`.
    if (entry.delivery !== undefined) {
      const delivery = mapping(entry.delivery);
      const route = delivery != null ? delivery.route : undefined;
      const deliveryId = delivery != null ? delivery.id : undefined;
      if (
        typeof route !== 'string' || !BARE_IDENTIFIER_RE.test(route.trim())
        || typeof deliveryId !== 'string' || deliveryId.trim().length === 0
      ) {
        dropModel(name, 'its v3 `delivery:` has no usable `route`/`id` to translate');
        continue;
      }
      const harness = legacyRouteHarness(route.trim());
      // The v3 direct lane has no v4 spelling a model entry can name (variants
      // are policy-chosen), so a direct id now travels on the harness's base
      // lane. Say so, because the lane moved.
      const laneMoved = route.trim() === 'opencode-direct';
      delete entry.delivery;
      if (entry.harness === undefined) entry.harness = harness;
      const spellings = mapping(entry.spellings);
      if (spellings != null) {
        if (spellings[harness] === undefined) spellings[harness] = deliveryId.trim();
      } else if (entry.spellings === undefined) {
        entry.spellings = { [harness]: deliveryId.trim() };
      }
      repairs.push(
        `${where}: model "${name}" \`delivery:\` read as \`harness: ${harness}\` plus \`spellings.${harness}\`` +
          (laneMoved ? ' — the v3 direct lane has no v4 spelling, so this id now travels on the OpenRouter lane; re-add with `fadeno model add` to verify it' : ''),
      );
    }

    if (typeof entry.provider !== 'string' || entry.provider.trim().length === 0) {
      dropModel(name, 'it declares no `provider`');
      continue;
    }
    if (entry.harness !== undefined && (typeof entry.harness !== 'string' || !BARE_IDENTIFIER_RE.test(entry.harness.trim()))) {
      delete entry.harness;
      repairs.push(`${where}: model "${name}" \`harness\` is not a bare identifier and was ignored`);
    }
    for (const key of ['id', 'effort'] as const) {
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || (entry[key] as string).trim().length === 0)) {
        delete entry[key];
        repairs.push(`${where}: model "${name}" \`${key}\` is not a non-empty string and was ignored`);
      }
    }
    if (entry.spellings !== undefined) {
      const spellings = mapping(entry.spellings);
      if (spellings == null) {
        delete entry.spellings;
        repairs.push(`${where}: model "${name}" \`spellings\` is not a mapping and was ignored`);
      } else {
        for (const [key, value] of Object.entries(spellings)) {
          const harness = legacyDriverHarness(key);
          if (typeof value !== 'string' || value.trim().length === 0 || !BARE_IDENTIFIER_RE.test(harness)) {
            delete spellings[key];
            repairs.push(`${where}: model "${name}" spelling "${key}" is unusable and was ignored`);
            continue;
          }
          if (harness === key) continue;
          delete spellings[key];
          if (spellings[harness] === undefined) spellings[harness] = value;
          repairs.push(`${where}: model "${name}" spelling "${key}" read as harness "${harness}"`);
        }
      }
    }
    for (const key of Object.keys(entry)) {
      if (V4_MODEL_KEYS.has(key)) continue;
      delete entry[key];
      repairs.push(`${where}: model "${name}" key \`${key}\` is not a catalog v4 model key and was ignored`);
    }
  }
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
  // Per harness id, so entry-merged: overriding one harness (its argv, its
  // relay) in a project catalog must not silently drop the five beside it.
  'harnesses',
  'archetypes',
  'bindings',
  'models',
  'dials',
]);

/**
 * Reject unknown top-level keys in ONE layer's raw document, before the
 * selective merge below reads out the keys it knows by name.
 *
 * This has to happen here and cannot happen in `parseExecutorProfile`: the
 * merge copies top-level keys by exact literal name, so a MISSPELLED key
 * (`modles:` for `models:`) is never looked up, never copied, and therefore
 * never reaches the parser's strict unknown-key check — it vanishes, and the
 * thing it was meant to declare silently does nothing. The raw per-layer
 * document is the last place the typo still exists.
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
  // Catalog v4 first: a layer that declares `routes:`, `relay:`,
  // `unregistered_model_driver:`, a model `delivery:`, or a ` via ` in a dial
  // gets the migration note naming the key and its v4 spelling, while the file
  // it lives in is still identifiable — rather than being reported as merely
  // "unknown", or (worse) silently dropped by the copy-by-literal-name merge.
  // Unconditionally, not only for a v3 layer: someone bumping the version
  // number without moving the keys under it deserves the migration note
  // naming the key, not "unknown top-level key" plus a did-you-mean.
  refuseRemovedCatalogKeys(doc, path);
  if (doc.harnesses !== undefined && doc.schema_version !== 4) {
    throw new ExecutorProfileError(
      `${path}: \`harnesses:\` requires \`schema_version: 4\` (found ${JSON.stringify(doc.schema_version)}).`,
    );
  }
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
  // After the placement check above, never before: a key that is KNOWN but
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
      if (key === 'models' && layer === 'user' && current[name] !== undefined) {
        (provenance.shadowedModels ??= {})[name] = current[name];
      }
      if ((key === 'harnesses' || key === 'models') && mapping(value) != null && mapping(current[name]) != null) {
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
  const harnesses = mapping(doc.harnesses);
  if (models == null || Object.keys(models).length === 0) return false;
  if (harnesses == null || Object.keys(harnesses).length === 0) return false;
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
 * How a user-catalog model entry says which harness delivers it: an explicit
 * `harness:`, else its `provider:` (which must be some harness's home — the
 * `homeHarnessOf` rule in `resolveDelivery`). Null when the entry is not a
 * mapping: the parser will reject that shape anyway, and the fallback must not
 * crash first.
 */
function modelHomeClaim(entry: unknown): { kind: 'harness' | 'provider'; value: string } | null {
  const map = mapping(entry);
  if (map == null) return null;
  if (typeof map.harness === 'string' && map.harness.trim().length > 0) {
    return { kind: 'harness', value: map.harness.trim() };
  }
  const provider = map.provider;
  if (typeof provider === 'string' && provider.trim().length > 0) return { kind: 'provider', value: provider.trim() };
  return null;
}

/**
 * Whether the merged `harnesses:` table can deliver a model's home claim: an
 * explicit `harness:` must be declared, or some harness must claim the model's
 * provider as home.
 *
 * The one integrity predicate all three user-model paths share — the
 * self-contained fallback, the normal-layering drop, and `loadGlobalProfile` —
 * so a model can never be admitted by one and refused by another.
 */
function claimDeliverable(document: Record<string, unknown>, claim: { kind: 'harness' | 'provider'; value: string }): boolean {
  const mergedHarnesses = mapping(document.harnesses) ?? {};
  if (claim.kind === 'harness') return mergedHarnesses[claim.value] != null;
  return Object.values(mergedHarnesses).some((entry) => {
    const harness = mapping(entry);
    return harness != null && harness.provider === claim.value;
  });
}

/**
 * Normal-layering counterpart of `applyUserModelFallback`: a user-catalog
 * model that nothing in the merged table can deliver is DROPPED with a note
 * instead of failing the whole load. A personal alias is machine state, not
 * catalog policy — one stale `fadeno model add` must not make every unrelated
 * dial error (observed 2026-09-05: `ox` with provider `stealth`, declared
 * before v4, bricked `fadeno dial reviewer opus` from a bare shell). Dialing
 * the dropped model itself still fails loudly, naming the fix. Only models
 * the USER layer supplied are eligible; a project- or builtin-declared model
 * that cannot be delivered is a catalog defect and keeps failing at parse.
 */
function dropUndeliverableUserModels(
  document: Record<string, unknown>,
  userDoc: Record<string, unknown> | null,
  provenance: ProfileProvenance,
  repairs: string[],
): ModelFallbackOutcome['dropped'] {
  const dropped: ModelFallbackOutcome['dropped'] = [];
  const userModels = userDoc != null ? mapping(userDoc.models) : null;
  const merged = mapping(document.models);
  if (userModels == null || merged == null) return dropped;
  for (const [alias, userEntry] of Object.entries(userModels)) {
    if (!Object.hasOwn(merged, alias)) continue;
    const suppliedByUser = provenance.models != null
      ? provenance.models[alias] === 'user'
      : JSON.stringify(merged[alias]) === JSON.stringify(userEntry);
    if (!suppliedByUser) continue;
    pruneUndeliverableSpellings(document, merged[alias], alias, repairs);
    const claim = modelHomeClaim(merged[alias]);
    if (claim != null && claimDeliverable(document, claim)) continue;
    // A user override that shadows a builtin or project model is the one case
    // where deleting the name is worse than the override itself: `opus` would
    // vanish from the catalog because a personal edit to it went stale, and
    // every dial naming it would fail with no mention of the user file. Put
    // the displaced entry back and say whose edit was discarded.
    const shadowed = provenance.shadowedModels?.[alias];
    if (shadowed !== undefined) {
      merged[alias] = shadowed;
      repairs.push(
        `user-catalog override of model "${alias}" discarded — nothing in this catalog can deliver ` +
          `harness/provider "${claim?.value ?? '?'}"; the ${provenance.models?.[alias] === 'user' ? 'lower layer' : 'catalog'}'s "${alias}" is used instead`,
      );
      if (provenance.models != null) delete provenance.models[alias];
      continue;
    }
    delete merged[alias];
    dropped.push({ alias, harness: claim?.value ?? '?' });
  }
  return dropped;
}

/**
 * Drop a user model's `spellings` keys that name a harness the merged table
 * does not declare.
 *
 * The parser refuses such a key outright, and for a project or builtin model
 * that is right — a spelling for a harness nobody declared is a catalog
 * defect. For a personal alias it is the `ox` failure again one field over: a
 * `fadeno model add` written when `opencode-direct` was a route name would
 * fail the whole load rather than lose one spelling.
 */
function pruneUndeliverableSpellings(
  document: Record<string, unknown>,
  entry: unknown,
  alias: string,
  repairs: string[],
): void {
  const map = mapping(entry);
  const spellings = map != null ? mapping(map.spellings) : null;
  if (spellings == null) return;
  const harnesses = mapping(document.harnesses) ?? {};
  for (const key of Object.keys(spellings)) {
    if (Object.hasOwn(harnesses, key)) continue;
    delete spellings[key];
    repairs.push(`user-catalog model "${alias}" spelling for harness "${key}" dropped — no such harness is declared`);
  }
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
 * Integrity guard: promotion requires the entry's home — its `harness:`, or a
 * harness claiming its `provider:` — to be declared in the MERGED harness
 * table. A dangling harness reference cannot resolve
 * anywhere, so merging it would only move today's late confusing failure
 * (`unknown harness ...`, thrown from deep inside `resolveDelivery` at
 * dispatch time) into the profile under a name nobody asked for. Dropped
 * entries are named, not silent.
 */
function applyUserModelFallback(
  document: Record<string, unknown>,
  userDoc: Record<string, unknown> | undefined,
  userPath: string,
  provenance: ProfileProvenance,
  repairs: string[],
): ModelFallbackOutcome {
  const outcome: ModelFallbackOutcome = { promoted: [], dropped: [], repairs };
  const userModelEntries = userDoc != null ? mapping(userDoc.models) : null;
  if (userModelEntries == null || Object.keys(userModelEntries).length === 0) return outcome;
  const targetModels = mapping(document.models);
  if (targetModels == null) return outcome;
  for (const [alias, entry] of Object.entries(userModelEntries)) {
    // A project-declared (or already-promoted) name wins: explicit catalog
    // policy outranks personal state, and admission in `runModelsAdd` makes
    // same-name collisions rare enough to stay quiet here.
    if (Object.hasOwn(targetModels, alias)) continue;
    pruneUndeliverableSpellings(document, entry, alias, repairs);
    const claim = modelHomeClaim(entry);
    if (claim == null || !claimDeliverable(document, claim)) {
      outcome.dropped.push({ alias, harness: claim?.value ?? '?' });
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
 * per-key, integrity-gated on the merged harness table being able to deliver
 * them (see `applyUserModelFallback`).
 */
export function loadLayeredProfile(repoRoot: string, options: UserPathOptions = {}, host?: HarnessId): LayeredProfile {
  const paths = userPaths(options);
  const layers: Array<{ layer: ConfigLayer; path: string }> = [
    { layer: 'builtin', path: `${templatesDir()}/common/fadeno/executors.yaml` },
    { layer: 'user', path: paths.executorsFile },
    { layer: 'project', path: join(repoRoot, '.fadeno', 'executors.yaml') },
  ];
  const present = layers.filter((entry) => existsSync(entry.path));
  if (present.length === 0) throw new ExecutorProfileError('No executor catalog is available.');
  const repairs: string[] = [];
  const parsedLayers = new Map(present.map((entry) => {
    const parsed = parseLayer(entry.path);
    // The user layer only: machine state gets translated, a file someone
    // edits gets the migration error. See `repairUserLayer`.
    if (entry.layer === 'user') repairUserLayer(parsed, entry.path, repairs);
    return [entry.layer, parsed] as const;
  }));
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
  const modelFallback: ModelFallbackOutcome = suppressLayering
    ? applyUserModelFallback(document, parsedLayers.get('user'), layers.find((entry) => entry.layer === 'user')?.path ?? '', provenance, repairs)
    : { promoted: [], dropped: dropUndeliverableUserModels(document, parsedLayers.get('user') ?? null, provenance, repairs), repairs };
  normalizeSchemaVersion(document);
  const text = stringifyObject(document);
  return {
    profile: parseExecutorProfile(text, effective.map((entry) => entry.layer).join(' + '), host),
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
 * project hide canonical names or the harnesses whose discovery user models
 * rely on; callers that need current-repo visibility still load the layered view.
 */
export function loadGlobalProfile(options: UserPathOptions = {}, host?: HarnessId): LayeredProfile {
  const paths = userPaths(options);
  const layers: Array<{ layer: ConfigLayer; path: string }> = [
    { layer: 'builtin', path: `${templatesDir()}/common/fadeno/executors.yaml` },
    { layer: 'user', path: paths.executorsFile },
  ];
  const present = layers.filter((entry) => existsSync(entry.path));
  if (present.length === 0) throw new ExecutorProfileError('No executor catalog is available.');
  const document: Record<string, unknown> = {};
  const provenance: ProfileProvenance = { bindings: {} };
  let userDoc: Record<string, unknown> | null = null;
  const repairs: string[] = [];
  for (const entry of present) {
    const parsed = parseLayer(entry.path);
    if (entry.layer === 'user') {
      repairUserLayer(parsed, entry.path, repairs);
      userDoc = parsed;
    }
    mergeLayer(document, parsed, entry.layer, entry.path, provenance);
  }
  const dropped = dropUndeliverableUserModels(document, userDoc, provenance, repairs);
  normalizeSchemaVersion(document);
  return {
    profile: parseExecutorProfile(stringifyObject(document), present.map((entry) => entry.layer).join(' + '), host),
    path: present.find((entry) => entry.layer === 'user')?.path ?? present[0]!.path,
    layers: present.map((entry) => entry.layer),
    provenance,
    paths,
    selfContained: false,
    suppressedCanonArchetypes: [],
    modelFallback: { promoted: [], dropped, repairs },
  };
}

/**
 * Declarations the builtin catalog makes that a SELF-CONTAINED project catalog
 * silently drops, as dotted paths.
 *
 * A project catalog that declares its own `models:` and `harnesses:` suppresses
 * the builtin layer wholesale (see `projectIsComplete`; user models are the
 * one per-key carve-out). That is a supported, deliberate mode — and it is
 * also a one-way ratchet: from that moment the catalog can only fall behind
 * the builtin sitting next to it, and nothing ever says so. This repo's own
 * catalog drifted 25 `timeout_ms` declarations, a stale `relay.codex`, and the
 * entire `tools:` block that way while `doctor` reported zero warnings.
 *
 * **Absences only, never differing values.** A different value IS the point of
 * an override, so reporting it would be noise on every honest catalog. An
 * absence is almost never deliberate: someone overriding a harness changes its
 * argv, they do not delete `timeout_ms` from it. That asymmetry is what makes
 * this check quiet enough to leave on — and it is also its known blind spot,
 * so a stale VALUE still goes unreported.
 *
 * Descends only into nodes BOTH sides declare as mappings, and reports only
 * SCALAR absences. Omitting a whole model or harness is a legitimate way to
 * ship a smaller catalog; omitting a scalar from a harness you DID declare is
 * the drift being looked for.
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
        // missing mapping is a whole model, harness, or archetype the project
        // chose not to ship, which is the normal way to keep a catalog small —
        // reporting it would fire on every honest self-contained catalog. A
        // missing scalar on a node the project DID declare is the drift being
        // looked for: nobody deliberately deletes `timeout_ms` from a harness
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

/**
 * The `schema_version` each catalog layer that exists on disk declares.
 *
 * For `doctor`: a v3 layer still loads (it declares none of the removed keys,
 * or the load would have failed), but it is frozen out of everything v4 added
 * and will fail the moment someone edits it toward `harnesses:`. A finding is
 * the honest middle: not an error, not silence.
 */
export function catalogLayerVersions(
  repoRoot: string,
  options: UserPathOptions = {},
): Array<{ layer: ConfigLayer; path: string; schemaVersion: number | null }> {
  const paths = userPaths(options);
  const candidates: Array<{ layer: ConfigLayer; path: string }> = [
    { layer: 'user', path: paths.executorsFile },
    { layer: 'project', path: join(repoRoot, '.fadeno', 'executors.yaml') },
  ];
  const out: Array<{ layer: ConfigLayer; path: string; schemaVersion: number | null }> = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const doc = parseLayer(candidate.path);
      out.push({
        ...candidate,
        schemaVersion: typeof doc.schema_version === 'number' ? doc.schema_version : null,
      });
    } catch {
      // A catalog that will not parse is a louder problem other checks report.
    }
  }
  return out;
}

function stringifyObject(value: Record<string, unknown>): string {
  return stringifyYaml(value);
}

/**
 * The merged document is always v4, whatever the layers said.
 *
 * `schema_version` is copied whole, so the last present layer's value would
 * otherwise win — a `schema_version: 3` personal `models:` catalog layered
 * under the v4 builtin would produce a v3 document that declares `harnesses:`,
 * which the parser correctly refuses. Each layer was already checked on its
 * own terms (`validateLayerKeys` → `refuseRemovedCatalogKeys`), which is where a v3
 * document that declares something v4 removed is caught, with its own path in
 * the message. By the time the layers are one document there is nothing left
 * for a version number to say.
 */
function normalizeSchemaVersion(document: Record<string, unknown>): void {
  document.schema_version = 4;
}

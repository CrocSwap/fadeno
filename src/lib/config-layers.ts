import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ExecutorProfileError, parseExecutorProfile, type ExecutorProfile, type HarnessId } from './executors.ts';
import { templatesDir } from './paths.ts';
import { userPaths, type FadenoUserPaths, type UserPathOptions } from './user-paths.ts';

export type ConfigLayer = 'builtin' | 'user' | 'project';

export interface ProfileProvenance {
  executors: Record<string, ConfigLayer>;
  loadouts: Record<string, ConfigLayer>;
  bindings: Record<string, ConfigLayer>;
  defaultLoadout: ConfigLayer | null;
}

export interface LayeredProfile {
  profile: ExecutorProfile;
  path: string;
  layers: ConfigLayer[];
  provenance: ProfileProvenance;
  paths: FadenoUserPaths;
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

function mergeLayer(target: Record<string, unknown>, source: Record<string, unknown>, layer: ConfigLayer, provenance: ProfileProvenance): void {
  for (const key of ['executors', 'targets', 'routes', 'loadouts', 'bindings']) {
    const entries = mapping(source[key]);
    if (entries == null) continue;
    const current = mapping(target[key]) ?? {};
    for (const [name, value] of Object.entries(entries)) {
      if ((key === 'loadouts' || key === 'routes') && mapping(value) != null && mapping(current[name]) != null) {
        current[name] = { ...(current[name] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        current[name] = value;
      }
      if (key === 'executors') provenance.executors[name] = layer;
      if (key === 'loadouts') provenance.loadouts[name] = layer;
      if (key === 'bindings') provenance.bindings[name] = layer;
    }
    target[key] = current;
  }
  for (const key of ['schema_version', 'default_loadout']) {
    if (source[key] !== undefined) {
      target[key] = source[key];
      provenance.defaultLoadout = layer;
    }
  }
}

function projectIsComplete(doc: Record<string, unknown>): boolean {
  const catalog = mapping(doc.targets) ?? mapping(doc.executors);
  if (catalog == null || Object.keys(catalog).length === 0) return false;
  const bindings = mapping(doc.bindings);
  const loadouts = mapping(doc.loadouts);
  if ((bindings == null || Object.keys(bindings).length === 0) &&
      (loadouts == null || Object.keys(loadouts).length === 0)) return false;
  const declared = new Set(Object.keys(catalog));
  if (bindings && Object.values(bindings).some((target) => typeof target !== 'string' || !declared.has(target))) return false;
  if (loadouts) {
    for (const slots of Object.values(loadouts)) {
      const map = mapping(slots);
      if (map && Object.values(map).some((target) => typeof target !== 'string' || !declared.has(target))) return false;
    }
  }
  return doc.default_loadout == null || (typeof doc.default_loadout === 'string' && loadouts != null && doc.default_loadout in loadouts);
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
  const effective = projectDoc && projectIsComplete(projectDoc)
    ? [{ layer: 'project' as ConfigLayer, path: project!.path }]
    : present;
  const document: Record<string, unknown> = {};
  const provenance: ProfileProvenance = { executors: {}, loadouts: {}, bindings: {}, defaultLoadout: null };
  for (const entry of effective) mergeLayer(document, parsedLayers.get(entry.layer)!, entry.layer, provenance);
  if (existsSync(paths.configFile)) {
    const userConfig = parseLayer(paths.configFile);
    if (userConfig.default_loadout !== undefined && provenance.defaultLoadout !== 'project') {
      document.default_loadout = userConfig.default_loadout;
      provenance.defaultLoadout = 'user';
    }
  }
  const text = stringifyObject(document);
  return {
    profile: parseExecutorProfile(text, effective.map((entry) => entry.layer).join(' + '), harness),
    path: project?.path ?? present.find((entry) => entry.layer === 'user')?.path ?? present[0]!.path,
    layers: effective.map((entry) => entry.layer),
    provenance,
    paths,
  };
}

function stringifyObject(value: Record<string, unknown>): string {
  return stringifyYaml(value);
}

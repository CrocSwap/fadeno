import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutorProfileError,
  loadExecutorProfile,
  readLocalLoadout,
  readUserLoadout,
  resolveActiveLoadout,
  type ActiveLoadout,
  type ExecutorProfile,
} from '../lib/executors.ts';
import { definitionSourceSummary } from '../lib/definitions.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { readUserHarness, type UserPathOptions } from '../lib/user-paths.ts';

export class StatusError extends Error {}

export interface StatusOptions {
  verbose?: boolean;
  target?: 'codex' | 'claude' | null;
  cwd?: string;
  repoRoot?: string;
  env?: string | null;
  userPathOptions?: UserPathOptions;
}

export interface StatusRole {
  archetype: string;
  executor: string;
  adapter: 'command' | 'host';
  model: string | null;
  source: 'builtin' | 'user' | 'project' | null;
  command: string[] | null;
}

export interface StatusResult {
  repoRoot: string;
  version: string;
  harness: 'codex' | 'claude' | 'grok' | 'standalone' | null;
  definitions: ReturnType<typeof definitionSourceSummary>;
  activeLoadout: ActiveLoadout | null;
  staleProjectPin: string | null;
  staleUserPin: string | null;
  roles: StatusRole[];
  external: StatusRole[];
  codexMaterialization: { path: string; fresh: boolean; restartRequired: boolean } | null;
  projectCustomized: boolean;
  verbose: boolean;
  next: string | null;
}

function harnessOf(target: StatusOptions['target'], userPathOptions?: UserPathOptions): StatusResult['harness'] {
  if (target) return target;
  const env = process.env.FADENO_HARNESS?.trim();
  if (env === 'codex' || env === 'claude' || env === 'grok') return env;
  return readUserHarness(userPathOptions) ?? 'standalone';
}

function materialization(
  loadout: string | null,
  profile: ExecutorProfile,
  target: StatusResult['harness'],
  userPathOptions?: UserPathOptions,
): StatusResult['codexMaterialization'] {
  if (target !== 'codex' || loadout == null) return null;
  const path = join(
    userPathOptions?.env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || join(userPathOptions?.home ?? homedir(), '.codex'),
    'agents',
  );
  const slots = profile.loadouts[loadout] ?? {};
  const hostSlots = Object.entries(slots).filter(([, executor]) => profile.executors[executor]?.adapter === 'host');
  if (hostSlots.length === 0) return { path, fresh: true, restartRequired: false };
  const fresh = hostSlots.every(([archetype, executor]) => {
    const file = join(path, `fadeno-${archetype}.toml`);
    if (!existsSync(file)) return false;
    const body = readFileSync(file, 'utf8');
    return body.startsWith('# fadeno:managed') && body.includes(`--native-executor ${executor}`);
  });
  return { path, fresh, restartRequired: !fresh };
}

/** Read the effective configuration without creating a file or probing commands. */
export function runStatus(opts: StatusOptions = {}): StatusResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  let loaded;
  try {
    loaded = loadExecutorProfile(repoRoot, opts.userPathOptions);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new StatusError(err.message);
    throw err;
  }
  const projectPin = readLocalLoadout(repoRoot);
  const userPin = readUserLoadout(opts.userPathOptions);
  const staleProjectPin = projectPin != null && !(projectPin in loaded.profile.loadouts) ? projectPin : null;
  const staleUserPin = userPin != null && !(userPin in loaded.profile.loadouts) ? userPin : null;
  let active: ActiveLoadout | null;
  try {
    active = resolveActiveLoadout({
      envValue: opts.env !== undefined ? opts.env : process.env.FADENO_LOADOUT ?? null,
      localFileValue: staleProjectPin == null ? projectPin : null,
      userFileValue: staleUserPin == null ? userPin : null,
      profile: loaded.profile,
    });
  } catch (err) {
    throw new StatusError((err as Error).message);
  }
  const roles: StatusRole[] = [];
  const slots = active == null ? {} : loaded.profile.loadouts[active.name] ?? {};
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const fromLoadout = slots[archetype] != null;
    const executor = slots[archetype] ?? loaded.profile.bindings['*'];
    if (executor == null) continue;
    const spec = loaded.profile.executors[executor]!;
    const source = fromLoadout
      ? loaded.provenance?.loadouts[active?.name ?? ''] ?? null
      : loaded.provenance?.bindings['*'] ?? null;
    roles.push({ archetype, executor, adapter: spec.adapter, model: spec.model, source, command: spec.adapter === 'command' ? spec.command : null });
  }
  const external = roles.filter((role) => role.adapter === 'command');
  const harness = harnessOf(opts.target, opts.userPathOptions);
  const materialized = materialization(active?.name ?? null, loaded.profile, harness, opts.userPathOptions);
  const next = staleProjectPin || staleUserPin
    ? 'clear or replace the stale loadout pin'
    : materialized?.restartRequired
      ? 'run setup/use and start a fresh Codex session'
      : external.length > 0
        ? 'review the external sandbox boundary before driving'
        : null;
  return {
    repoRoot,
    version: packageVersion(),
    harness,
    definitions: definitionSourceSummary(repoRoot),
    activeLoadout: active,
    staleProjectPin,
    staleUserPin,
    roles,
    external,
    codexMaterialization: materialized,
    projectCustomized: existsSync(join(repoRoot, '.fadeno')),
    verbose: Boolean(opts.verbose),
    next,
  };
}

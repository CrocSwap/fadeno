import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  activeHarness,
  resolveRole,
  readLocalDialState,
} from '../lib/executors.ts';
import { definitionSourceSummary } from '../lib/definitions.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { readUserDials, type UserPathOptions } from '../lib/user-paths.ts';
import { loadLayeredProfile } from '../lib/config-layers.ts';
import { maintainedHarnesses, readInstallationManifest } from '../lib/installations.ts';
import type { DialRef } from '../lib/executors.ts';

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
  source: 'binding' | 'session' | 'repo' | 'user' | 'base';
  command: string[] | null;
}

export interface StatusResult {
  repoRoot: string;
  version: string;
  harness: 'codex' | 'claude' | 'grok' | 'standalone' | null;
  definitions: ReturnType<typeof definitionSourceSummary>;
  dials: { session: Record<string, DialRef>; repo: Record<string, DialRef>; user: Record<string, DialRef> };
  legacy_pin_note: string | null;
  roles: StatusRole[];
  external: StatusRole[];
  codexMaterialization: { path: string; fresh: boolean; restartRequired: boolean } | null;
  projectCustomized: boolean;
  verbose: boolean;
  next: string | null;
  runtime: {
    invocationSource: string;
    managedVersion: string | null;
    managedPath: string | null;
    versionCurrent: boolean;
    installedHarnesses: string[];
  };
  // Legacy aliases for cli
  activeLoadout?: any;
  staleProjectPin?: string | null;
  staleUserPin?: string | null;
  pinOverrides?: Record<string, string>;
}

function harnessOf(target: StatusOptions['target'], userPathOptions?: UserPathOptions): StatusResult['harness'] {
  return activeHarness(target ?? undefined, userPathOptions);
}

function materialization(
  _profile: import('../lib/executors.ts').ExecutorProfile,
  codexMaintained: boolean,
  userPathOptions?: UserPathOptions,
): StatusResult['codexMaterialization'] {
  if (!codexMaintained) return null;
  const path = join(
    userPathOptions?.env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || join(userPathOptions?.home ?? homedir(), '.codex'),
    'agents',
  );
  // Use resolved triad: worker/reviewer/judge resolved via dial cascade
  // For materialization, check if resolved delivery is host and needs agent file
  // Simplify: if any of triad resolves to host, check freshness
  // We'll use same logic as before but via resolved roles: check if any role's adapter is host
  // Caller will supply roles; we defer to caller to compute fresh?
  // For now, check existence of fadeno-*.toml files
  const needed = ['worker', 'reviewer', 'judge'];
  let allFresh = true;
  let anyHost = false;
  for (const arch of needed) {
    // We don't have spec here; assume host needed if archetype requires? For status we can't know.
    // Just check files exist
    const file = join(path, `fadeno-${arch}.toml`);
    if (!existsSync(file)) {
      // If file missing, not fresh
      allFresh = false;
    } else {
      anyHost = true;
    }
  }
  if (!anyHost && allFresh) return { path, fresh: true, restartRequired: false };
  return { path, fresh: allFresh, restartRequired: !allFresh };
}

export function runStatus(opts: StatusOptions = {}): StatusResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const harness = harnessOf(opts.target, opts.userPathOptions);
  let layered;
  try {
    layered = loadLayeredProfile(repoRoot, opts.userPathOptions, harness ?? 'standalone');
  } catch (err) {
    throw new StatusError((err as Error).message);
  }
  const profile = layered.profile;
  let dialState;
  try {
    dialState = readLocalDialState(repoRoot);
  } catch (err) {
    throw new StatusError((err as Error).message);
  }
  const userDials = readUserDials(opts.userPathOptions) as Record<string, DialRef>;
  const sessionDials = dialState.dials;
  const repoDials = profile.dials;
  const legacy_pin_note = dialState.legacyNote;

  const roles: StatusRole[] = [];
  const archetypes = ['worker', 'reviewer', 'judge'];
  // Also include any declared archetypes
  for (const name of Object.keys(profile.archetypes)) if (!archetypes.includes(name)) archetypes.push(name);

  const layers = { session: sessionDials, repo: repoDials, user: userDials };
  for (const archetype of archetypes) {
    try {
      const resolved = resolveRole(archetype, archetype, profile, layers);
      const spec = resolved.delivery.spec;
      roles.push({
        archetype,
        executor: resolved.delivery.refString,
        adapter: spec.adapter,
        model: resolved.delivery.model,
        source: resolved.source,
        command: spec.adapter === 'command' ? spec.command : null,
      });
    } catch {
      // Skip if resolution fails (unknown driver)
    }
  }
  const external = roles.filter((r) => r.adapter === 'command');

  const installation = readInstallationManifest(opts.userPathOptions);
  const invocationSource = process.env.FADENO_INVOCATION_SOURCE?.trim()
    || (installation.runtime != null && resolve(process.argv[1] ?? '') === resolve(installation.runtime.path) ? 'managed' : 'path');
  const codexMaintained = maintainedHarnesses(opts.userPathOptions).includes('codex');
  let codexProfile: import('../lib/executors.ts').ExecutorProfile | null = null;
  if (codexMaintained) {
    try {
      const loaded = loadLayeredProfile(repoRoot, opts.userPathOptions, 'codex');
      codexProfile = loaded.profile;
    } catch {
      codexProfile = null;
    }
  }
  const materialized = codexProfile == null ? null : materialization(codexProfile, true, opts.userPathOptions);

  const next = legacy_pin_note ? 'clear legacy pin with `fadeno dial clear`' : external.length > 0 ? 'review the external sandbox boundary before driving' : null;

  return {
    repoRoot,
    version: packageVersion(),
    harness,
    definitions: definitionSourceSummary(repoRoot),
    dials: { session: sessionDials, repo: repoDials, user: userDials },
    legacy_pin_note,
    roles,
    external,
    codexMaterialization: materialized,
    projectCustomized: existsSync(join(repoRoot, '.fadeno')),
    verbose: Boolean(opts.verbose),
    next,
    runtime: {
      invocationSource,
      managedVersion: installation.runtime?.version ?? null,
      managedPath: installation.runtime?.path ?? null,
      versionCurrent: installation.runtime == null || installation.runtime.version === packageVersion(),
      installedHarnesses: Object.keys(installation.harnesses).sort(),
    },
    // Legacy shims
    activeLoadout: null,
    staleProjectPin: null,
    staleUserPin: null,
    pinOverrides: {},
  };
}

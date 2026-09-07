import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  activeHarness,
  archetypeDisplaySort,
  hostCandidateOf,
  resolveRole,
  readLocalDialState,
} from '../lib/executors.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { readUserDials, type UserPathOptions, userPaths } from '../lib/user-paths.ts';
import { loadLayeredProfile } from '../lib/config-layers.ts';
import { readInstallationManifest, compareFadenoVersions, readRuntimeVersionAt } from '../lib/installations.ts';
import type { DialRef } from '../lib/executors.ts';

export class StatusError extends Error {}

export interface StatusOptions {
  verbose?: boolean;
  // 'opencode' is accepted since OpenCode steering materialization exists and
  // the harness has an adapter tree; 'grok' stays excluded — it has no
  // steering surface to report on.
  target?: 'codex' | 'claude' | 'opencode' | 'omp' | null;
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
  harness: 'codex' | 'claude' | 'grok' | 'opencode' | 'omp' | 'standalone' | null;
  dials: { session: Record<string, DialRef>; repo: Record<string, DialRef>; user: Record<string, DialRef> };
  roles: StatusRole[];
  external: StatusRole[];
  projectCustomized: boolean;
  verbose: boolean;
  next: string | null;
  runtime: {
    invocationSource: string;
    managedVersion: string | null;
    managedPath: string | null;
    versionCurrent: boolean;
    installedHarnesses: string[];
    // New fields
    skew: 'managed-older' | 'managed-newer' | 'divergent' | null;
    preferredCli: string;
    preferredReason: string | null;
    observedVersion: string | null;
    observedSource: 'observed' | 'assumed' | null;
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

  const roles: StatusRole[] = [];
  /**
   * Per archetype: can this delivery go out IN-SESSION, as `steering apply`
   * decides it.
   *
   * Kept beside `adapter` rather than folded into it, because they answer
   * different questions and both are wanted here: `adapter` is the SPEC SHAPE
   * (which fields the row's `command` can come from), while this is the LANE.
   * They diverge on a host spec with no argv, and keying the materialization
   * comparison below on `adapter` made `status` expect an in-session slot the
   * apply had deliberately written as a broker — reporting drift that was not
   * there.
   */
  const hostSlots = new Map<string, boolean>();
  const archetypes = archetypeDisplaySort(new Set(['worker', 'reviewer', 'judge', ...Object.keys(profile.archetypes)]));

  const layers = { session: sessionDials, repo: repoDials, user: userDials };
  for (const archetype of archetypes) {
    try {
      const resolved = resolveRole(archetype, archetype, profile, layers);
      const spec = resolved.delivery.spec;
      hostSlots.set(archetype, hostCandidateOf(resolved.delivery, spec));
      roles.push({
        archetype,
        executor: resolved.delivery.refString,
        adapter: spec.adapter,
        model: resolved.delivery.model,
        source: resolved.source,
        command: spec.adapter === 'command' ? spec.command : null,
      });
    } catch {
      // Skip if resolution fails (an undeclared harness, say).
    }
  }
  const external = roles.filter((r) => r.adapter === 'command');

  const installation = readInstallationManifest(opts.userPathOptions);
  const upaths = userPaths(opts.userPathOptions);
  const invocationSource = process.env.FADENO_INVOCATION_SOURCE?.trim()
    || (installation.runtime != null && resolve(process.argv[1] ?? '') === resolve(installation.runtime.path) ? 'managed' : 'path');
  const next = external.length > 0 ? 'review the external sandbox boundary before driving' : null;

  const invokingVersion = packageVersion();
  let observedVersion: string | null = null;
  let observedSource: 'observed' | 'assumed' | null = null;
  try {
    if (existsSync(upaths.managedRuntimeDir)) {
      const obs = readRuntimeVersionAt(upaths.managedRuntimeDir);
      if (obs.version != null) {
        observedVersion = obs.version;
        observedSource = obs.source;
      }
    }
  } catch {}
  const managedVersion = observedVersion ?? installation.runtime?.version ?? null;
  // If observed missing but manifest has version, observedSource is assumed
  if (observedVersion == null && installation.runtime?.version != null) {
    observedSource = installation.runtime.version_source ?? 'assumed';
  }
  const versionCurrent = installation.runtime == null || installation.runtime.version === invokingVersion;

  let skew: StatusResult['runtime']['skew'] = null;
  if (managedVersion != null && invokingVersion != null) {
    const cmp = compareFadenoVersions(managedVersion, invokingVersion);
    if (cmp === 1) skew = 'managed-newer';
    else if (cmp === -1) skew = 'managed-older';
    else if (cmp === 0) skew = null;
    else skew = 'divergent';
  } else if (managedVersion == null) {
    skew = null;
  } else {
    skew = 'divergent';
  }

  let preferredCli: string;
  let preferredReason: string | null = null;
  const invokingPath = resolve(process.argv[1] ?? 'fadeno');
  if (managedVersion != null && managedVersion === invokingVersion && installation.runtime?.path) {
    preferredCli = installation.runtime.path;
  } else {
    preferredCli = invokingPath;
    if (installation.runtime == null) {
      preferredReason = `managed runtime not installed; using invoking CLI`;
    } else if (skew === 'managed-older') {
      preferredReason = `managed runtime ${managedVersion} is older than this CLI ${invokingVersion}; refreshes at next plugin-launched command, or run fadeno setup --from <bin-dir>`;
    } else if (skew === 'managed-newer') {
      preferredReason = `managed runtime ${managedVersion} is newer than this CLI ${invokingVersion}; update this CLI via your package manager — do not rerun setup from this older CLI`;
    } else if (skew === 'divergent') {
      preferredReason = `versions diverge (managed ${managedVersion} vs invoking ${invokingVersion}); using invoking CLI`;
    } else {
      preferredReason = `managed version differs; using invoking CLI`;
    }
  }

  return {
    repoRoot,
    version: invokingVersion,
    harness,
    dials: { session: sessionDials, repo: repoDials, user: userDials },
    roles,
    external,
    projectCustomized: existsSync(join(repoRoot, '.fadeno')),
    verbose: Boolean(opts.verbose),
    next,
    runtime: {
      invocationSource,
      managedVersion,
      managedPath: installation.runtime?.path ?? null,
      versionCurrent,
      installedHarnesses: Object.keys(installation.harnesses).sort(),
      skew,
      preferredCli,
      preferredReason,
      observedVersion,
      observedSource,
    },
    activeLoadout: null,
    staleProjectPin: null,
    staleUserPin: null,
    pinOverrides: {},
  };
}

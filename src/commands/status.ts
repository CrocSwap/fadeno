import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  activeHarness,
  archetypeDisplaySort,
  hostCandidateOf,
  resolveRole,
  readLocalDialState,
} from '../lib/executors.ts';
import { definitionSourceSummary } from '../lib/definitions.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { codexUserAgentDir, readUserDials, type UserPathOptions, userPaths } from '../lib/user-paths.ts';
import { loadLayeredProfile } from '../lib/config-layers.ts';
import { maintainedHarnesses, readInstallationManifest, compareFadenoVersions, readRuntimeVersionAt } from '../lib/installations.ts';
import type { DialRef } from '../lib/executors.ts';
import { inspectOpenCodeMaterialization, type OpenCodeMaterialization } from '../lib/opencode-steering.ts';
import { inspectOmpMaterialization, type OmpMaterialization } from '../lib/omp-steering.ts';
import {
  CODEX_IDENTITY_REMEDIATION,
  CODEX_STEERING_ARCHETYPES,
  codexAgentIdentityStatus,
  readCodexAgentFile,
  type CodexAgentIdentityRow,
  type CodexDialIdentity,
} from '../lib/codex-agent-file.ts';
import { NEUTRAL_HOST_EXECUTOR, runSteeringResolve } from './steering.ts';

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
  definitions: ReturnType<typeof definitionSourceSummary>;
  dials: { session: Record<string, DialRef>; repo: Record<string, DialRef>; user: Record<string, DialRef> };
  legacy_pin_note: string | null;
  roles: StatusRole[];
  external: StatusRole[];
  codexMaterialization: CodexMaterialization | null;
  opencodeMaterialization: OpenCodeMaterialization | null;
  ompMaterialization: OmpMaterialization | null;
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

export interface CodexMaterialization {
  path: string;
  /** No file missing and no host slot's identity drifted. */
  fresh: boolean;
  restartRequired: boolean;
  agents: CodexAgentIdentityRow[];
  /** The exact command that fixes it, or null when nothing is wrong. */
  remediation: string | null;
}

/**
 * What Codex would actually load for the three role slots, judged against what
 * the dials say — not merely whether the files are there.
 *
 * File EXISTENCE was the whole test until 2026-09-05, and it reported
 * `current` at the exact moment it mattered least: a Codex director whose
 * `reviewer` dial had moved to another model kept spawning the old identity,
 * because the agent file is a frozen identity that no spawn value can correct
 * (`findSpawnableCodexAgent`), and `status` said the managed agents were fine.
 *
 * The dial side comes from `runSteeringResolve`, so this asks the same
 * resolver `steering apply` and the spawn guard ask rather than re-deriving a
 * second cascade. Two things it must be told, both of which would otherwise be
 * read off the ambient session:
 *
 *  - The HARNESS. These files are Codex's whatever this session runs inside,
 *    and the resolver reads its host from `activeHarness`, which reads the
 *    injected env — so the harness is forced through the same options object
 *    the user paths already travel in, never by touching `process.env`.
 *  - Nothing else: the dial cascade, the catalog, and the effort are the
 *    resolver's own answers.
 *
 * A slot is JUDGED when its dial is host-shaped on codex (`adapter: 'host'`
 * and `harness: 'codex'`) — precisely the case where `steering apply` bakes
 * the dialed identity into the file. Anything else materializes as a command
 * broker carrying the relay's identity, which is not the dial's and must not
 * be compared to it. `SteeringResolution.lane` cannot answer this: it also
 * folds in "is this the session's own baseline", which `status` has no host
 * executor to prove and which would mark every dialed slot `command`.
 *
 * Known corner: a codex-harness model that the host lane's own `eligibility:`
 * excludes for one archetype is materialized as a broker while still
 * resolving with `adapter: 'host'`. The shipped catalog declares no such
 * exclusion; if one appears, this predicate is where it gets read.
 */
function materialization(
  codexMaintained: boolean,
  repoRoot: string,
  userPathOptions?: UserPathOptions,
): CodexMaterialization | null {
  if (!codexMaintained) return null;
  const path = codexUserAgentDir(userPathOptions);
  const codexOptions: UserPathOptions = {
    ...userPathOptions,
    env: { ...(userPathOptions?.env ?? process.env), FADENO_HARNESS: 'codex' },
  };
  const agents = CODEX_STEERING_ARCHETYPES.map((archetype): CodexAgentIdentityRow => {
    const state = readCodexAgentFile(join(path, `fadeno-${archetype}.toml`));
    const file = state == null ? null : { model: state.model, effort: state.reasoningEffort };
    let dial: CodexDialIdentity | null = null;
    try {
      const resolved = runSteeringResolve({
        archetype,
        repoRoot,
        userPathOptions: codexOptions,
        env: codexOptions.env as NodeJS.ProcessEnv,
      });
      // The neutral sentinel names no provider-servable model, and
      // `renderCodexHostAgent` omits both identity lines for it — so the
      // identity a correct file carries is "none", not the sentinel string.
      const neutral = resolved.model === NEUTRAL_HOST_EXECUTOR;
      dial = {
        model: neutral ? null : resolved.model,
        effort: neutral ? null : resolved.effort,
        lane: resolved.adapter === 'host' && resolved.harness === 'codex' ? 'host' : 'command',
      };
    } catch {
      // An uncompilable dial is reported as unjudged rather than as drift:
      // `status` must not turn a catalog problem into an identity accusation.
      dial = null;
    }
    return { archetype, file, dial, status: codexAgentIdentityStatus(file, dial) };
  });
  const fresh = agents.every((agent) => agent.status === 'current' || agent.status === 'not_applicable');
  return {
    path,
    fresh,
    restartRequired: !fresh,
    agents,
    remediation: fresh ? null : CODEX_IDENTITY_REMEDIATION,
  };
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
  const codexMaintained = maintainedHarnesses(opts.userPathOptions).includes('codex');
  // The codex profile still gates the report — a catalog that cannot be loaded
  // for that harness has no dial to judge a file against — but the identity
  // comparison itself goes through `runSteeringResolve`, which loads its own.
  let codexProfileLoads = false;
  if (codexMaintained) {
    try {
      loadLayeredProfile(repoRoot, opts.userPathOptions, 'codex');
      codexProfileLoads = true;
    } catch {
      codexProfileLoads = false;
    }
  }
  const materialized = codexProfileLoads ? materialization(true, repoRoot, opts.userPathOptions) : null;
  const opencodeMaterialized = harness === 'opencode'
    ? inspectOpenCodeMaterialization(
      repoRoot,
      new Map(roles.map((role) => [role.archetype, hostSlots.get(role.archetype) === true ? 'host' : 'command'] as const)),
    )
    : null;
  const ompMaterialized = harness === 'omp'
    ? inspectOmpMaterialization(
      repoRoot,
      new Map(roles.map((role) => [role.archetype, hostSlots.get(role.archetype) === true ? 'host' : 'command'] as const)),
    )
    : null;

  const next = legacy_pin_note ? 'clear legacy pin with `fadeno dial clear`' : external.length > 0 ? 'review the external sandbox boundary before driving' : null;

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
    definitions: definitionSourceSummary(repoRoot),
    dials: { session: sessionDials, repo: repoDials, user: userDials },
    legacy_pin_note,
    roles,
    external,
    codexMaterialization: materialized,
    opencodeMaterialization: opencodeMaterialized,
    ompMaterialization: ompMaterialized,
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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DIALS_LOCAL_FILE,
  LOCAL_DIALS_SCHEMA_VERSION,
  validateLocalDialDocument,
  withLocalDialStateLock,
} from './executors.ts';
import { parseBakeoffFile } from './bakeoff.ts';
import { HOST_WORKSPACE_SCHEMA_VERSION, HOST_WORKSPACES_DIR, readHostWorkspaceState } from './host-workspace.ts';
import { validateInstallationManifestDocument } from './installations.ts';
import { RUN_LEDGER_SCHEMA_VERSION, readEvents } from './run-ledger.ts';
import { spawnMarkerLines, spawnMarkerRow } from './spawn-markers.ts';
import { readInflightClaim, readSupervisorStatus } from './supervisor.ts';
import { readWorkspaceLease } from './workspace-lease.ts';
import {
  DIALS_SCHEMA_VERSION,
  MODEL_VERIFICATIONS_SCHEMA_VERSION,
  userPaths,
  validateUserDialsDocument,
  validateVerificationDocument,
  type DocumentDefect,
  type FadenoUserPaths,
} from './user-paths.ts';

/**
 * The inventory of everything Fadeno leaves on disk, and the schema-evolution
 * machinery that keeps those files readable across versions.
 *
 * The failure this module exists to prevent: a writer changes shape, an old
 * file stays on disk, and a reader silently degrades it to `{}` instead of
 * saying so. Every Fadeno bug of that class has looked the same — two
 * consumers of one fact, one of them holding a stale copy. So the list of
 * surfaces lives here ONCE, and both the doctor audit and the drift tripwire
 * in `test/persisted-state-inventory.test.ts` read it rather than restating
 * it.
 *
 * The versioning rule is deliberately boring:
 *
 * - The stamp key is `schema_version`, an integer at the top level of a
 *   JSON/YAML document.
 * - An UNSTAMPED document is **version 0 = the legacy shape today's writers
 *   produce**, and stays readable forever. Tolerance is not a migration
 *   nicety; it is the contract.
 * - Writers emit the current version. `fadeno setup` migrates in place, after
 *   a timestamped backup. `fadeno doctor` only reports.
 *
 * Library module: this returns `PersistedFinding`s structurally identical to
 * `DoctorFinding` in `src/commands/doctor.ts` rather than importing it —
 * `src/lib/` never imports from `src/commands/`.
 */

/** Where a surface lives, which is also how its `relPath` is resolved. */
export type SurfaceScope = 'user-config' | 'user-state' | 'repo-local' | 'run' | 'ledger' | 'ephemeral';

export interface PersistedSurface {
  id: string;
  scope: SurfaceScope;
  /**
   * Path relative to the scope root: `configDir` for `user-config`,
   * `stateDir` for `user-state`, and the repo root for every other scope. A
   * `<run>` segment marks a per-run path that only resolves once a run is
   * named; `surfaceAbsolutePath` returns null for those and the audit
   * enumerates `.fadeno/runs/` instead.
   */
  relPath: string;
  format: 'json' | 'jsonl' | 'yaml' | 'text';
  /** Top-level key carrying the version, or null when the surface has none. */
  versionField: string | null;
  /** What this Fadeno writes. Null means the surface is unversioned by design. */
  currentVersion: number | string | null;
  reader: string;
  writer: string;
  notes?: string;
}

/** Structurally identical to `DoctorFinding`; declared locally on purpose. */
export interface PersistedFinding {
  check: string;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
  remediation?: string;
}

/** The contract spelling for `FadenoUserPaths`. */
export type UserPaths = FadenoUserPaths;

/**
 * Every file and directory Fadeno persists, with the version it carries.
 *
 * Deliberately NOT listed: opaque scratch bytes that no reader parses —
 * `.fadeno/local/outputs/` and `.fadeno/local/prompts/` (executor stdout and
 * prompt snapshots) and the worktree checkouts under
 * `.fadeno/local/host-worktrees/`. They have no schema to drift, so a version
 * stamp on them would be decoration. Everything a reader parses is here.
 */
export const PERSISTED_SURFACES: readonly PersistedSurface[] = [
  {
    id: 'user-executors',
    scope: 'user-config',
    relPath: 'executors.yaml',
    format: 'yaml',
    versionField: 'schema_version',
    currentVersion: 4,
    reader: 'loadLayeredProfile / loadGlobalProfile (src/lib/config-layers.ts)',
    writer: 'runModelsAdd (src/commands/models.ts)',
    notes: 'The personal catalog layer. A `schema_version: 3` models-only layer still loads; `harnesses:` requires 4.',
  },
  {
    id: 'user-config',
    scope: 'user-config',
    relPath: 'config.yaml',
    format: 'yaml',
    versionField: null,
    currentVersion: null,
    reader: '(none)',
    writer: '(none)',
    notes:
      'Declared by userPaths() as `configFile` and NOT stamped — because nothing reads or writes it. ' +
      'No code path in src/ touches this path; it is a reserved location only. Stamp it when it grows a reader.',
  },
  {
    id: 'installations',
    scope: 'user-state',
    relPath: 'installations.json',
    format: 'json',
    versionField: 'schema_version',
    currentVersion: 1,
    reader: 'readInstallationManifest (src/lib/installations.ts)',
    writer: 'writeInstallationManifest (src/lib/installations.ts)',
    notes: 'Already stamped, and already atomic (tmp + rename). The pattern every writer here copies.',
  },
  {
    id: 'dials',
    scope: 'user-state',
    relPath: 'dials.json',
    format: 'json',
    versionField: 'schema_version',
    currentVersion: DIALS_SCHEMA_VERSION,
    reader: 'readUserDials (src/lib/user-paths.ts)',
    writer: 'writeUserDials (src/lib/user-paths.ts)',
    notes: 'v1 is `{schema_version, dials}`; v0 is the flat `{archetype: ref}` map, still read.',
  },
  {
    id: 'model-verifications',
    scope: 'user-state',
    relPath: 'model-verifications.json',
    format: 'json',
    versionField: 'schema_version',
    currentVersion: MODEL_VERIFICATIONS_SCHEMA_VERSION,
    reader: 'readVerifiedModels (src/lib/user-paths.ts)',
    writer: 'recordVerifiedModel (src/lib/user-paths.ts)',
    notes: 'v1 is `{schema_version, verifications}`; v0 is the bare array, still read.',
  },
  {
    id: 'retired-harness-pin',
    scope: 'user-state',
    relPath: 'harness',
    format: 'text',
    versionField: null,
    currentVersion: null,
    reader: '(none — retired)',
    writer: '(none — retired)',
    notes:
      'One line naming "the harness you last set up". NO reader is left: `activeHarness` (src/lib/executors.ts) ' +
      'decides from the live session. `removeRetiredState` in src/commands/setup.ts sweeps a leftover.',
  },
  {
    id: 'retired-loadout-pin',
    scope: 'user-state',
    relPath: 'loadout',
    format: 'text',
    versionField: null,
    currentVersion: null,
    reader: '(none — retired)',
    writer: '(none — retired)',
    notes:
      'One line naming a loadout. NO reader is left: named loadouts retired in 0.6. ' +
      '`removeRetiredState` in src/commands/setup.ts sweeps a leftover.',
  },
  {
    id: 'project-executors',
    scope: 'repo-local',
    relPath: join('.fadeno', 'executors.yaml'),
    format: 'yaml',
    versionField: 'schema_version',
    currentVersion: 4,
    reader: 'loadLayeredProfile (src/lib/config-layers.ts), layer `project`',
    writer: 'runInit (src/commands/init.ts) — seeded once, then hand-edited',
    notes:
      'The PROJECT catalog copy `fadeno init` seeds. Today it is a full copy of the builtin `harnesses:` table, ' +
      'so it SHADOWS later builtin catalog changes: a harness entry fixed in a new Fadeno never reaches a repo ' +
      'that was init-ed before the fix. Whether doctor should flag that divergence is the integrator\'s call. ' +
      'Separately: `EXECUTORS_FILE` (src/lib/executors.ts) is exported for this path and has NO consumer — ' +
      'config-layers.ts re-spells the literal in five places.',
  },
  {
    id: 'repo-dials-pin',
    scope: 'repo-local',
    relPath: DIALS_LOCAL_FILE,
    format: 'json',
    versionField: 'schema_version',
    currentVersion: LOCAL_DIALS_SCHEMA_VERSION,
    reader: 'readLocalDialState (src/lib/executors.ts)',
    writer: 'writeLocalDialState (src/lib/executors.ts)',
    notes: 'v1 adds the stamp beside `dials`/`shadows`; v0 is the unstamped pair, still read. Machine-local, never committed.',
  },
  {
    id: 'dispatches-ledger',
    scope: 'ledger',
    relPath: join('.fadeno', 'dispatches.jsonl'),
    format: 'jsonl',
    versionField: 'format',
    currentVersion: '1.1',
    reader:
      'lookupInputProducers / findTagOccupant (src/commands/dispatch.ts), src/commands/dispatches.ts, ' +
      'readAdhocHostRecords (src/commands/dispatch-adhoc.ts)',
    writer:
      'appendEvidenceRow (src/commands/dispatch.ts), called by the command lane, by the runless host lane ' +
      '(src/commands/dispatch-adhoc.ts), and by the Claude steering hook, which writes the stamp as a literal',
    notes:
      'Per-ROW stamp, not per-file: the log is append-only, so rows outlive the shape they were written in. '
      + 'THREE lanes write here — command (`dispatch_requested`/`dispatch_completed`/`dispatch_withdrawn`), '
      + 'runless host (`adhoc_host_dispatch_requested`/`adhoc_host_dispatch_closed`), and the steering hook '
      + '(`host_delivery`/`host_refused`/`host_rewritten`/`native_spawn`/`host_attestation`) — and every one of '
      + 'their event names is additive under format 1.x, because readers tier on the MAJOR. A row kind the '
      + 'entry reader does not handle is counted as unreadable DAMAGE, so a new event name always ships with '
      + 'its `foldEvidenceRow` case.',
  },
  {
    id: 'run-ledger',
    scope: 'ledger',
    relPath: join('.fadeno', 'runs', '<run>', 'run.yaml'),
    format: 'yaml',
    versionField: 'schema_version',
    currentVersion: RUN_LEDGER_SCHEMA_VERSION,
    reader: 'listRuns / resolveRun / readEvents (src/lib/run-ledger.ts)',
    writer: 'writeRunDocument / LedgerWriter (src/lib/run-ledger-write.ts)',
    notes:
      'A STRING version, not an integer — the one surface that predates the integer rule. `events.jsonl` carries no ' +
      'stamp of its own and is governed by this one: `LedgerWriter` refuses to append across versions.',
  },
  {
    id: 'run-snapshot',
    scope: 'run',
    relPath: join('.fadeno', 'runs', '<run>', 'profile.yaml'),
    format: 'yaml',
    versionField: 'snapshot_version',
    currentVersion: 3,
    reader: 'parseSnapshotDocument (src/lib/executors.ts)',
    writer: 'serializeSnapshot (src/lib/executors.ts)',
    notes: 'Its own field name, `snapshot_version`, and refused rather than degraded when it is not 3.',
  },
  {
    id: 'bakeoff-records',
    scope: 'repo-local',
    relPath: join('.fadeno', 'bakeoffs'),
    format: 'json',
    versionField: null,
    currentVersion: null,
    reader: 'parseBakeoffFile (src/commands/dispatches.ts, BAKEOFFS_DIR)',
    writer: 'src/commands/bakeoff.ts',
    notes: 'Adjudication records. Unstamped today; a directory of independent documents rather than one evolving file.',
  },
  {
    id: 'host-workspace-state',
    scope: 'ephemeral',
    relPath: HOST_WORKSPACES_DIR,
    format: 'json',
    versionField: 'schema_version',
    currentVersion: HOST_WORKSPACE_SCHEMA_VERSION,
    reader: 'readHostWorkspaceState (src/lib/host-workspace.ts)',
    writer: 'writeStateAtomic (src/lib/host-workspace.ts)',
    notes: 'One file per host dispatch, stamped `1.0` as a string. Machine-local; a stale one is swept, never migrated.',
  },
  {
    id: 'workspace-lease',
    scope: 'ephemeral',
    relPath: join('.fadeno', 'local', 'workspace-lease.json'),
    format: 'json',
    versionField: null,
    currentVersion: null,
    reader: 'readWorkspaceLease (src/lib/workspace-lease.ts)',
    writer: 'nothing — the repo-wide writer lease was removed',
    notes:
      'VESTIGIAL. Fadeno no longer takes a repo-wide writer lease: it required proving a holder dead, ' +
      'which a pid-less host delivery made impossible, so a killed agent wedged the repo forever. A file ' +
      'here is a leftover from before the removal; `fadeno doctor` reports it and says to delete it. ' +
      'Read only for that report, never migrated.',
  },
  {
    id: 'inflight-status',
    scope: 'ephemeral',
    relPath: join('.fadeno', 'local', 'inflight'),
    format: 'json',
    versionField: null,
    currentVersion: null,
    reader: 'readInflightClaim (src/lib/supervisor.ts) for fallback-*.json, readSupervisorStatus for *.status.json',
    writer: 'runDispatchFallback and the command-lane supervisor (src/commands/dispatch.ts)',
    notes:
      'TWO document kinds share this directory: in-flight claims (`<dispatch>.json`, and `fallback-<run>-<dispatch>.json` ' +
      'from `fallbackClaimRelPath`) and `<dispatch>.status.json` supervisor exit records. Naming only the claim reader was ' +
      'how the audit could face a directory of 143 status records and read none of them. A pid means nothing elsewhere; ' +
      'a claim left by a crash must never look like evidence.',
  },
  {
    id: 'pending-relays',
    scope: 'ephemeral',
    relPath: join('.fadeno', 'local', 'pending-relays.jsonl'),
    format: 'jsonl',
    versionField: null,
    currentVersion: null,
    reader: 'consumeSpawnSideRelay (src/commands/dispatch.ts, PENDING_RELAYS_FILE)',
    writer:
      'templates/claude/hooks/dispatch-steering.mjs and templates/codex/hooks/spawn-guard.mjs — standalone hooks that cannot import the constant',
    notes:
      'Proof that a relay-bound spawn happened. Consumed and truncated within a session. Two writers, one row shape: '
      + 'the Claude hook stashes a spawn bound for a dispatch proxy, the Codex hook stashes every delivered managed role spawn '
      + '(any of which can dispatch on a per-task `mode=command` resolution).',
  },
  {
    id: 'proxy-dispatches',
    scope: 'ephemeral',
    relPath: join('.fadeno', 'local', 'proxy-dispatches.jsonl'),
    format: 'jsonl',
    versionField: null,
    currentVersion: null,
    reader: 'consumeProxyDispatchMarker (src/commands/dispatch.ts, PROXY_DISPATCHES_FILE)',
    writer:
      'templates/claude/hooks/dispatch-proxy-guard.mjs and templates/codex/hooks/dispatch-proxy-guard.mjs — standalone hooks that cannot import the constant',
    notes:
      'Sibling of pending-relays; machine-local proxy bookkeeping. The Codex writer digests the prompt FILE the role agent '
      + 'named, since a Codex relay carries the path rather than the bytes.',
  },
];

/**
 * Which surface owns each key of `FadenoUserPaths`, or null when the key names
 * a directory (or an installed artifact) rather than a persisted document.
 *
 * This is the half of the tripwire that makes "add a field to
 * `FadenoUserPaths`" fail loudly: the inventory test walks the keys
 * `userPaths()` actually returns and requires every one to appear here. A new
 * `somethingFile` with no entry fails the suite instead of quietly becoming an
 * uninventoried surface.
 */
export const USER_PATH_SURFACE_IDS: Readonly<Record<keyof FadenoUserPaths, string | null>> = {
  configHome: null,
  stateHome: null,
  dataHome: null,
  configDir: null,
  stateDir: null,
  dataDir: null,
  managedRuntimeDir: null,
  // Installed bytes, not persisted state: the runtime tree is a copy of a
  // plugin bundle, and the version that matters is recorded in `installations`.
  managedCli: null,
  executorsFile: 'user-executors',
  configFile: 'user-config',
  installationsFile: 'installations',
  dialsFile: 'dials',
  modelVerificationsFile: 'model-verifications',
};

/** The one lookup, so a caller cannot mistype an id and get silence. */
export function surfaceById(id: string): PersistedSurface | null {
  return PERSISTED_SURFACES.find((s) => s.id === id) ?? null;
}

/**
 * Absolute path of a surface, or null when it cannot be resolved here — a
 * per-run `<run>` template, or a repo-scoped surface with no repo root.
 */
export function surfaceAbsolutePath(
  surface: PersistedSurface,
  opts: { repoRoot?: string | null; paths?: UserPaths },
): string | null {
  if (surface.relPath.split(/[\\/]/).includes('<run>')) return null;
  if (surface.scope === 'user-config' || surface.scope === 'user-state') {
    const paths = opts.paths ?? userPaths();
    const root = surface.scope === 'user-config' ? paths.configDir : paths.stateDir;
    return join(root, surface.relPath);
  }
  if (opts.repoRoot == null) return null;
  return join(opts.repoRoot, surface.relPath);
}

// --- stamping and tolerant reads ---

/**
 * Return `doc` with `schema_version` set, stamp FIRST.
 *
 * Order is not cosmetic: every writer here serializes with sorted or literal
 * key order and the files are read by humans debugging a bad dial. A stamp
 * buried after a 40-key body is a stamp nobody sees. An existing stamp is
 * replaced, never duplicated.
 */
export function stampSchemaVersion<T extends object>(doc: T, version: number): T & { schema_version: number } {
  const out: Record<string, unknown> = { schema_version: version };
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'schema_version') continue;
    out[key] = value;
  }
  return out as T & { schema_version: number };
}

export type VersionedRead =
  | { version: number; body: unknown }
  | { missing: true }
  | { unreadable: string };

/**
 * Read a stamped JSON or YAML document tolerantly.
 *
 * `body` is the parsed document VERBATIM, stamp included — each surface's own
 * reader knows how to interpret its shape, and this function refuses to guess.
 * An absent or empty file is `missing`, matching every existing Fadeno reader
 * (an empty dials file has always meant "no dials", not "corrupt").
 *
 * A version ABOVE `expected` is `unreadable` on purpose: a file written by a
 * newer Fadeno is exactly the case where guessing does damage.
 */
export function readVersioned(path: string, opts: { expected: number; legacyIsVersion0: true }): VersionedRead {
  if (!existsSync(path)) return { missing: true };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { unreadable: (err as Error).message };
  }
  if (text.trim().length === 0) return { missing: true };
  const yaml = /\.ya?ml$/i.test(path);
  let doc: unknown;
  try {
    doc = yaml ? parseYaml(text) : JSON.parse(text);
  } catch (err) {
    return { unreadable: `not valid ${yaml ? 'YAML' : 'JSON'}: ${(err as Error).message}` };
  }
  if (doc == null || typeof doc !== 'object') {
    return { unreadable: 'is not a JSON/YAML object or array' };
  }
  if (Array.isArray(doc)) {
    // A bare array cannot carry a top-level stamp, so it is legacy by
    // construction — which is exactly the v0 model-verifications shape.
    return opts.legacyIsVersion0 ? { version: 0, body: doc } : { unreadable: 'is an array with no version' };
  }
  const raw = (doc as Record<string, unknown>).schema_version;
  if (raw === undefined) return { version: 0, body: doc };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return { unreadable: `has schema_version ${JSON.stringify(raw)}, which is not a non-negative integer` };
  }
  if (raw > opts.expected) {
    return { unreadable: `has schema_version ${raw}, which is newer than this fadeno reads (${opts.expected})` };
  }
  return { version: raw, body: doc };
}

// --- doctor audit ---

/** How many run directories the ledger/snapshot audit reads before it stops. */
export const RUN_AUDIT_SCAN_LIMIT = 50;

/**
 * How many member documents a DIRECTORY surface is read through before the
 * audit stops and says so.
 *
 * A sibling of `RUN_AUDIT_SCAN_LIMIT` rather than the same number: these are
 * small machine-local files (a lease claim, a supervisor exit record, one
 * host workspace) and a working repo accumulates them by the hundred, so a
 * 50-file bound would report "read cleanly" about a third of a directory. The
 * finding names the bound whenever it is hit, because a bounded scan that
 * does not say it was bounded is the confident wrong answer this module
 * exists to prevent.
 */
export const MEMBER_AUDIT_SCAN_LIMIT = 250;

function finding(surface: PersistedSurface, severity: 'ok' | 'warning' | 'error', detail: string, remediation?: string): PersistedFinding {
  return {
    check: `persisted-state:${surface.id}`,
    severity,
    detail,
    ...(remediation != null ? { remediation } : {}),
  };
}

/**
 * What to actually DO about a surface that is behind, in the user's
 * vocabulary. A remediation that names an internal function is a remediation
 * nobody can act on, so each non-migratable surface names its command.
 */
const BEHIND_REMEDIATION: Record<string, string> = {
  'user-executors':
    'Harmless on its own — a `models:`-only personal catalog still loads at 3. ' +
    '`fadeno model add <alias> <provider/id> --harness <h>` rewrites it at 4.',
  'project-executors':
    'Edit `.fadeno/executors.yaml` and set `schema_version: 4`, or re-seed it with `fadeno init --force`.',
  'host-workspace-state':
    'Machine-local and never migrated: remove the stale directory under `.fadeno/local/host-workspaces/`.',
};

function behindRemediation(surface: PersistedSurface): string {
  if (MIGRATABLE.has(surface.id)) return 'Run `fadeno setup` to migrate it (a timestamped backup is written first).';
  return (
    BEHIND_REMEDIATION[surface.id] ??
    `Rewrite it with its writer (${surface.writer}); \`fadeno setup\` does not migrate this surface.`
  );
}

/**
 * What to do about a file the reader cannot use at all.
 *
 * "Keep it, then delete it" is only actionable if the user knows WHERE to keep
 * it. `malformedCurrent` already names the surface's backup directory, and an
 * unreadable file is the same instruction with a worse cause — so the two
 * agree on the destination, and both point at the directory
 * `migratePersistedState` would have used, so a hand-made copy lands beside
 * the automatic ones instead of somewhere only its author remembers.
 */
function unreadableRemediation(surface: PersistedSurface, abs: string, backupDir: string | null = null): string {
  const where = backupDir != null ? ` (e.g. into ${backupDir}/)` : '';
  return `Copy ${abs} somewhere safe${where}, then delete it; ${surface.writer} recreates it.`;
}

/**
 * What a surface's REAL reader requires of a document beyond its stamp, or
 * null when it demands nothing the stamp check has not already proved.
 *
 * A version stamp is not a schema. `{"schema_version": 1, "dials": []}` is at
 * the current version and `readUserDials` yields nothing from it; an audit
 * that compares the stamp and stops reports that file `ok` — a confident wrong
 * answer from the check built to catch confident wrong answers. So every
 * stamped surface is validated through its own reader's rules before the audit
 * says `ok`, and each validator is EXPORTED FROM THE MODULE THAT OWNS THE
 * READER rather than reimplemented here, so the two cannot drift.
 *
 * The table is exhaustive over stamped surfaces on purpose, with `null`
 * meaning "decided: nothing beyond the envelope", never "not thought about".
 * `test/persisted-state.test.ts` fails if a stamped surface is missing an
 * entry, so adding one forces the decision.
 */
type ShapeValidator = (body: unknown) => DocumentDefect | null;

const SHAPE_VALIDATORS: Readonly<Record<string, ShapeValidator | null>> = {
  // `parseLayer` (config-layers.ts) asks one thing of a catalog LAYER: that it
  // be a YAML mapping — which `readVersioned` has already established. Parsing
  // the merged profile is doctor's `configuration` check, and it must stay
  // there: a user layer is legitimately a `models:`-only fragment that no
  // full-profile parse would accept, so validating it here would report every
  // healthy personal catalog as damaged.
  'user-executors': null,
  'project-executors': null,
  installations: validateInstallationManifestDocument,
  dials: (body) => validateUserDialsDocument(body),
  'model-verifications': validateVerificationDocument,
  'repo-dials-pin': validateLocalDialDocument,
  // Immutable history and per-document ephemeral state: a run ledger, a run
  // snapshot and a host-workspace file are written once and never migrated, so
  // "the reader cannot use this one" is damage the reader reports where it is
  // read, not drift the inventory can act on. The dispatch ledger is
  // append-only and validated row by row in `auditJsonlRows`; the run ledger's
  // `events.jsonl` companion likewise, through `readEvents` itself
  // (`auditRunEventRows`), which is why neither needs a body validator here.
  'run-ledger': null,
  'run-snapshot': null,
  'host-workspace-state': null,
  'dispatches-ledger': null,
};

/** The validator for a surface, or null. Throws for a stamped surface with no entry. */
export function shapeValidatorFor(surface: PersistedSurface): ShapeValidator | null {
  if (surface.versionField == null || surface.currentVersion == null) return null;
  if (!Object.hasOwn(SHAPE_VALIDATORS, surface.id)) {
    throw new Error(`persisted surface "${surface.id}" is stamped but has no SHAPE_VALIDATORS entry`);
  }
  return SHAPE_VALIDATORS[surface.id] ?? null;
}

/**
 * Where this surface's backups go, without a timestamp — the directory
 * `migratePersistedState` creates a stamped subdirectory inside. Named in the
 * remediation for a damaged file so "back it up" points somewhere concrete.
 */
export function surfaceBackupDir(
  surface: PersistedSurface,
  opts: { repoRoot?: string | null; paths?: UserPaths },
): string | null {
  const userScoped = surface.scope === 'user-config' || surface.scope === 'user-state';
  if (userScoped) return join((opts.paths ?? userPaths()).stateDir, 'backups');
  if (opts.repoRoot == null) return null;
  return join(opts.repoRoot, '.fadeno', 'local', 'backups');
}

/**
 * A document that carries the CURRENT stamp and a body its reader cannot fully
 * use.
 *
 * `error` when the reader gets NOTHING out of it — the same event, from the
 * reader's point of view, as the unparsable and unknown-version cases the
 * contract already calls `error`: the file is there and every read comes back
 * empty. `warning` when the reader got the rest and silently dropped a part.
 * Either way `fadeno setup` cannot help (migration only runs 0 → current), so
 * the remediation names the file and where to put a copy before deleting it.
 */
function malformedCurrent(
  surface: PersistedSurface,
  abs: string,
  defect: DocumentDefect,
  backupDir: string | null,
): PersistedFinding {
  const where = backupDir != null ? ` (e.g. into ${backupDir}/)` : '';
  const consequence = defect.severity === 'error'
    ? 'Every read of it comes back empty.'
    : 'The rest of it still reads; that part is silently dropped.';
  return finding(
    surface,
    defect.severity,
    `${surface.relPath} is stamped ${surface.versionField} ${surface.currentVersion}, but its body is not one ` +
      `${surface.reader} can read in full: it ${defect.detail}. ${consequence}`,
    `Copy ${abs} somewhere safe${where}, then ${defect.severity === 'error' ? 'delete it' : 'delete it or repair the offending entry'}; ` +
      `${surface.writer} recreates it. \`fadeno setup\` will not repair this — migration only runs version 0 → ${surface.currentVersion}.`,
  );
}

function auditStamped(surface: PersistedSurface, abs: string, backupDir: string | null = null): PersistedFinding {
  const expected = surface.currentVersion;
  // `readVersioned` reads `schema_version` and only `schema_version` — the
  // stamp key is the rule, not a parameter. A surface that carries its OWN
  // version key (`run-snapshot`'s `snapshot_version`) must be compared
  // literally instead, or every one of its documents reads back as an
  // unstamped v0 and the audit reports "0 of 42 current" about files that are
  // all current: a confident wrong answer, which is the exact failure this
  // inventory exists to catch.
  if (typeof expected === 'number' && surface.versionField === 'schema_version') {
    const read = readVersioned(abs, { expected, legacyIsVersion0: true });
    if ('missing' in read) return finding(surface, 'ok', `${surface.relPath} is not present (nothing to migrate).`);
    if ('unreadable' in read) {
      return finding(surface, 'error', `${surface.relPath} ${read.unreadable}.`, unreadableRemediation(surface, abs, backupDir));
    }
    if (read.version === expected) {
      // The stamp is right. Now ask the surface's own reader whether the BODY
      // is one it can use — a current version over an empty shape is the
      // failure mode this whole inventory exists to make loud.
      const defect = shapeValidatorFor(surface)?.(read.body) ?? null;
      if (defect != null) return malformedCurrent(surface, abs, defect, backupDir);
      return finding(surface, 'ok', `${surface.relPath} is at ${surface.versionField} ${expected}.`);
    }
    return finding(
      surface,
      'warning',
      `${surface.relPath} is at ${surface.versionField} ${read.version}; this fadeno writes ${expected}.`,
      behindRemediation(surface),
    );
  }
  // A string version (`run.yaml` 0.3, host workspace state 1.0): compare
  // literally rather than pretending it is ordered.
  return auditStringStamped(surface, abs, String(expected), backupDir);
}

function auditStringStamped(
  surface: PersistedSurface,
  abs: string,
  expected: string,
  backupDir: string | null = null,
): PersistedFinding {
  if (!existsSync(abs)) return finding(surface, 'ok', `${surface.relPath} is not present (nothing to migrate).`);
  let doc: unknown;
  try {
    const text = readFileSync(abs, 'utf8');
    if (text.trim().length === 0) return finding(surface, 'ok', `${surface.relPath} is empty.`);
    doc = /\.ya?ml$/i.test(abs) ? parseYaml(text) : JSON.parse(text);
  } catch (err) {
    return finding(surface, 'error', `${surface.relPath} could not be parsed: ${(err as Error).message}.`, unreadableRemediation(surface, abs, backupDir));
  }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    return finding(surface, 'error', `${surface.relPath} is not an object.`, unreadableRemediation(surface, abs, backupDir));
  }
  const found = (doc as Record<string, unknown>)[surface.versionField ?? 'schema_version'];
  if (found === undefined) {
    return finding(surface, 'warning', `${surface.relPath} has no ${surface.versionField}; this fadeno writes ${expected}.`, behindRemediation(surface));
  }
  if (String(found) === expected) {
    const defect = shapeValidatorFor(surface)?.(doc) ?? null;
    if (defect != null) return malformedCurrent(surface, abs, defect, backupDir);
    return finding(surface, 'ok', `${surface.relPath} is at ${surface.versionField} ${expected}.`);
  }
  return finding(
    surface,
    'warning',
    `${surface.relPath} is at ${surface.versionField} ${String(found)}; this fadeno writes ${expected}.`,
    behindRemediation(surface),
  );
}

function auditJsonlRows(surface: PersistedSurface, abs: string, backupDir: string | null = null): PersistedFinding {
  if (!existsSync(abs)) return finding(surface, 'ok', `${surface.relPath} is not present (nothing to migrate).`);
  const expected = String(surface.currentVersion);
  const field = surface.versionField!;
  let lines: string[];
  try {
    lines = readFileSync(abs, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  } catch (err) {
    return finding(surface, 'error', `${surface.relPath} could not be read: ${(err as Error).message}.`, unreadableRemediation(surface, abs, backupDir));
  }
  if (lines.length === 0) return finding(surface, 'ok', `${surface.relPath} is empty.`);
  const versions = new Set<string>();
  let unparsed = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const value = row?.[field];
      versions.add(value === undefined ? '(none)' : String(value));
    } catch {
      unparsed += 1;
    }
  }
  if (unparsed > 0) {
    return finding(
      surface,
      'error',
      `${surface.relPath} has ${unparsed} of ${lines.length} row(s) that are not valid JSON.`,
      `Append-only evidence is never rewritten in place: keep ${abs}, and treat the unparsable rows as lost.`,
    );
  }
  const stale = [...versions].filter((v) => v !== expected).sort();
  if (stale.length === 0) return finding(surface, 'ok', `${lines.length} row(s) in ${surface.relPath} are all ${field} ${expected}.`);
  return finding(
    surface,
    'warning',
    `${surface.relPath} carries row ${field}(s) ${stale.join(', ')} beside the current ${expected}.`,
    'Expected for an append-only log — older rows keep the stamp they were written with. Nothing to fix unless a reader rejects them.',
  );
}

function runDirectories(repoRoot: string): string[] {
  const runsDir = join(repoRoot, '.fadeno', 'runs');
  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      try {
        return statSync(join(runsDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, RUN_AUDIT_SCAN_LIMIT)
    .map((name) => join(runsDir, name));
}

/**
 * Row files a per-run surface owns BEYOND the document its `relPath` names.
 *
 * `run.yaml` and `events.jsonl` are one surface with two files: events carry
 * no stamp of their own, `LedgerWriter` refuses to append across versions, and
 * the run document governs both. An audit that read only the yaml reported
 * `persisted-state:run-ledger` healthy over a shredded event log — the exact
 * confident wrong answer this inventory exists to catch — so the companion is
 * named here, machine-readably, and the inventory tripwire holds this table
 * and the surface's `notes` to the same file name.
 */
export const RUN_COMPANION_ROWS: Readonly<Record<string, string>> = {
  'run-ledger': 'events.jsonl',
};

/** How many corrupt line numbers a rolled-up finding names before it counts the rest. */
const MAX_NAMED_BAD_LINES = 3;

/**
 * Audit one run's companion row file THROUGH ITS OWN READER.
 *
 * `readEvents` is what `fadeno show` and the driver actually parse the log
 * with, and it already reports the line numbers it could not use — so asking
 * it is the only way the audit and the reader cannot disagree about what
 * "corrupt" means. Reimplementing a JSONL scan here (as the dispatches ledger
 * does, where no shared reader exists) would have re-created the drift the
 * module's shape validators exist to prevent.
 *
 * A row in an OLDER format is not corrupt. Events are unstamped, `readEvents`
 * keeps every field it does not recognise in `extra`, and a run ledger is
 * immutable history — so an older row reads back fine and stays `ok`, exactly
 * as an older `run.yaml` does. Only a line the reader cannot turn into an
 * event at all — unparsable JSON, or a scalar or array where an object
 * belongs — is a defect.
 */
function auditRunEventRows(
  surface: PersistedSurface,
  dir: string,
  companion: string,
  backupDir: string | null,
): { rows: number; defect: PersistedFinding | null } | null {
  const abs = join(dir, companion);
  if (!existsSync(abs)) return null;
  const runId = basename(dir);
  let read: ReturnType<typeof readEvents>;
  try {
    read = readEvents(dir);
  } catch (err) {
    return {
      rows: 0,
      defect: finding(
        surface,
        'error',
        `run ${runId}: ${companion} could not be read: ${(err as Error).message}.`,
        unreadableRemediation(surface, abs, backupDir),
      ),
    };
  }
  if (read.badLines.length === 0) return { rows: read.events.length, defect: null };
  const named = read.badLines.slice(0, MAX_NAMED_BAD_LINES).join(', ');
  const more = read.badLines.length > MAX_NAMED_BAD_LINES
    ? ` (+${read.badLines.length - MAX_NAMED_BAD_LINES} more)`
    : '';
  const plural = read.badLines.length === 1 ? 'line' : 'lines';
  return {
    rows: read.events.length,
    defect: finding(
      surface,
      'error',
      `run ${runId}: ${companion} has ${read.badLines.length} row(s) its reader cannot use, at ${plural} ${named}${more}; ` +
        `${read.events.length} row(s) still read.`,
      `Append-only evidence is never rewritten in place: keep ${abs} (a copy belongs${backupDir != null ? ` in ${backupDir}/` : ' somewhere safe'}) ` +
        `and treat those ${plural} as lost. \`fadeno show ${runId}\` reads the rest.`,
    ),
  };
}

/**
 * Roll the per-run surfaces up into ONE finding: the worst outcome across the
 * runs scanned, naming a concrete run. A line per run ledger would drown every
 * other doctor check the moment a repo has history.
 *
 * A run recorded at an OLDER version is reported `ok`, not `warning`. A run
 * ledger is immutable evidence of what happened — it is supposed to keep the
 * format it was written in, `fadeno setup` will never rewrite it, and the
 * newest run is always current by construction. Warning forever about history
 * nobody can or should change is how a doctor teaches people to ignore it.
 * An UNPARSABLE ledger is still an error: that is damage, not age.
 */
function auditPerRun(surface: PersistedSurface, repoRoot: string): PersistedFinding {
  const dirs = runDirectories(repoRoot);
  if (dirs.length === 0) return finding(surface, 'ok', `no runs recorded under .fadeno/runs/.`);
  const leaf = basename(surface.relPath);
  const worst: { severity: 'ok' | 'warning' | 'error'; detail: string; remediation?: string } = {
    severity: 'ok',
    detail: '',
  };
  const rank = { ok: 0, warning: 1, error: 2 };
  const consider = (per: PersistedFinding): void => {
    if (rank[per.severity] <= rank[worst.severity]) return;
    worst.severity = per.severity;
    worst.detail = per.detail;
    if (per.remediation != null) worst.remediation = per.remediation;
  };
  const companion = RUN_COMPANION_ROWS[surface.id] ?? null;
  const backupDir = surfaceBackupDir(surface, { repoRoot });
  let checked = 0;
  let companionRuns = 0;
  let companionRows = 0;
  const older = new Set<string>();
  for (const dir of dirs) {
    // The companion is audited independently of the document beside it: a run
    // whose run.yaml never landed can still hold events, and a corrupt log is
    // damage whether or not its ledger header survived.
    if (companion != null) {
      const rows = auditRunEventRows(surface, dir, companion, backupDir);
      if (rows != null) {
        companionRuns += 1;
        companionRows += rows.rows;
        if (rows.defect != null) consider(rows.defect);
      }
    }
    const abs = join(dir, leaf);
    if (!existsSync(abs)) continue;
    checked += 1;
    const scoped = { ...surface, relPath: join(basename(dir), leaf) };
    const per = typeof surface.currentVersion === 'number'
      ? auditStamped(scoped, abs, backupDir)
      : auditStringStamped(scoped, abs, String(surface.currentVersion), backupDir);
    // "Behind" on immutable history is age, not rot — collected and named,
    // never escalated. Only real damage raises the severity.
    if (per.severity === 'warning') {
      older.add(basename(dir));
      continue;
    }
    consider(per);
  }
  // A defect wins over "nothing to report" even when it came from the
  // companion rather than the document, so damage is never swallowed by a run
  // that happens to be missing its `leaf`.
  if (worst.severity !== 'ok') {
    return finding(surface, worst.severity, `${worst.detail} (worst of ${dirs.length} run(s) scanned)`, worst.remediation);
  }
  // Only claim the events were read when they actually were — a silent
  // "audited" on a surface nothing looked at is the failure being fixed here.
  const rows = companion != null && companionRuns > 0
    ? ` ${companionRows} ${companion} row(s) across ${companionRuns} run(s) read cleanly.`
    : '';
  if (checked === 0) return finding(surface, 'ok', `no ${leaf} in the ${dirs.length} most recent run(s).${rows}`);
  const current = checked - older.size;
  if (older.size === 0) {
    return finding(
      surface,
      'ok',
      `${checked} of the ${dirs.length} most recent run(s) carry ${leaf} at ${surface.versionField} ${surface.currentVersion}.${rows}`,
    );
  }
  return finding(
    surface,
    'ok',
    `${current} of ${checked} scanned run(s) carry ${leaf} at ${surface.versionField} ${surface.currentVersion}; ` +
      `${older.size} older run(s) keep the format they were written with (e.g. ${[...older].sort().reverse()[0]}).${rows}`,
  );
}

// --- unversioned and directory surfaces: read through the REAL reader ---

/**
 * What reading one surface through its own reader actually produced.
 *
 * `rejected` carries BOTH paths on purpose: the repo-relative one names the
 * offending document in the detail a person reads, and the absolute one is
 * what `unreadableRemediation` puts in the "copy it here" instruction.
 */
export type UnversionedRead =
  | { state: 'absent' }
  | { state: 'read'; detail: string }
  | { state: 'rejected'; rel: string; abs: string; why: string };

/** Reads one surface, given a path already known to exist. */
type UnversionedReader = (ctx: { surface: PersistedSurface; abs: string; repoRoot: string }) => UnversionedRead;

/** Members of a directory surface, newest-name-first and bounded. */
function directoryMembers(abs: string, keep: (name: string) => boolean): { names: string[]; truncated: boolean } | null {
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return null;
  }
  const names = entries.filter(keep).sort();
  return { names: names.slice(0, MEMBER_AUDIT_SCAN_LIMIT), truncated: names.length > MEMBER_AUDIT_SCAN_LIMIT };
}

/** "17 of 400 (bound MEMBER_AUDIT_SCAN_LIMIT)" — never a silent partial count. */
function scanned(count: number, truncated: boolean): string {
  return truncated ? `${count} (the ${MEMBER_AUDIT_SCAN_LIMIT}-document scan bound was reached)` : `${count}`;
}

/** Repo-relative spelling of a member, for the human half of a finding. */
function memberRel(repoRoot: string, abs: string): string {
  return abs.startsWith(repoRoot + sep) ? abs.slice(repoRoot.length + 1) : abs;
}

/**
 * How an UNVERSIONED surface is read, or `null` when nothing reads it at all.
 *
 * The bug this table closes: the audit used to answer `ok` for every
 * unversioned surface — "unversioned by design" — WITHOUT OPENING THE FILE.
 * Six surfaces holding live machine-local state were reported healthy by a
 * check that had not looked at them, which is precisely the confident wrong
 * answer `SHAPE_VALIDATORS` exists to prevent one layer up. A version stamp is
 * not the only thing a document can fail; being unstamped is not a reason to
 * skip the read.
 *
 * Exhaustive over unversioned surfaces, with an explicit `null` meaning
 * "decided: no reader exists" rather than "not thought about" —
 * `unversionedReaderFor` throws for an unversioned surface the table does not
 * mention, so adding one forces the decision. Each `null` states its reason
 * beside it, and each reason must agree with the surface's own `reader`
 * column, which spells `(none…)`.
 */
const UNVERSIONED_READERS: Readonly<Record<string, UnversionedReader | null>> = {
  // No reader in src/: `userPaths()` declares `configFile` as a reserved
  // location and nothing in the codebase opens it. Reading it here would
  // invent a shape it has never had.
  'user-config': null,
  // Retired: `activeHarness` decides from the live session, and named
  // loadouts were retired in 0.6. `removeRetiredState` sweeps a leftover, so
  // a file here is litter, not state — there is nothing to read it WITH.
  'retired-harness-pin': null,
  'retired-loadout-pin': null,

  // `readWorkspaceLease` answers `null` for BOTH "no lease" and "a record
  // this build cannot use" — so existence is checked first and a null from a
  // file that is there is a rejection, never an absence. That distinction used
  // to be load-bearing (a half-written lease read as "workspace free" and
  // mutual exclusion silently stopped excluding). It no longer gates anything,
  // and it is kept because this inventory's job is to say whether every
  // persisted surface still reads back — including the ones nothing writes.
  'workspace-lease': ({ abs, repoRoot, surface }) => {
    const record = readWorkspaceLease(repoRoot);
    if (record == null) {
      return {
        state: 'rejected',
        rel: surface.relPath,
        abs,
        why: 'readWorkspaceLease refuses it — an unparsable record, an unknown workspace_mode, ' +
          'a holder it cannot read, or a missing timestamp. Vestigial either way: `fadeno doctor` reports ' +
          'the leftover file and it is safe to delete',
      };
    }
    return { state: 'read', detail: `${surface.relPath} reads back as a leftover ${record.workspace_mode} lease naming "${record.holder.id}"; nothing reads it any more.` };
  },

  // Two document kinds in one directory (see the surface's notes); both are
  // read, because auditing only the one the inventory happened to name is how
  // a directory of 147 status files got reported on by nothing.
  'inflight-status': ({ abs, repoRoot, surface }) => {
    const members = directoryMembers(abs, (name) => name.endsWith('.json'));
    if (members == null) {
      return { state: 'rejected', rel: surface.relPath, abs, why: 'the directory could not be listed' };
    }
    const read = (path: string): string => readFileSync(path, 'utf8');
    let claims = 0;
    let statuses = 0;
    for (const name of members.names) {
      const memberAbs = join(abs, name);
      const isStatus = name.endsWith('.status.json');
      const parsed = isStatus ? readSupervisorStatus(memberAbs, read) : readInflightClaim(memberAbs, read);
      if (parsed == null) {
        return {
          state: 'rejected',
          rel: memberRel(repoRoot, memberAbs),
          abs: memberAbs,
          why: isStatus
            ? 'readSupervisorStatus gets nothing from it — unparsable bytes, or a scalar where the record belongs'
            : 'readInflightClaim gets nothing from it — unparsable bytes, or no usable supervisor pid, ' +
              'which makes a live delivery look finished',
        };
      }
      if (isStatus) statuses += 1;
      else claims += 1;
    }
    return {
      state: 'read',
      detail: `${surface.relPath} holds ${scanned(claims, members.truncated)} claim(s) and ` +
        `${scanned(statuses, members.truncated)} supervisor status record(s); every one reads cleanly.`,
    };
  },

  // Append-only marker logs. `spawnMarkerLines` throws on a line that is not
  // JSON — the same abort the consumers take — and `spawnMarkerRow` is the
  // one predicate deciding whether a row is usable, shared with
  // `consumeSpawnSideRelay`/`consumeProxyDispatchMarker`. A row the reader
  // cannot use is silently skipped there, so this is the only place it is
  // ever said out loud. Age is NOT a defect: a stale marker is one the
  // consumer correctly ignores.
  'pending-relays': auditSpawnMarkerLog,
  'proxy-dispatches': auditSpawnMarkerLog,

  // The scorecard reads `.fadeno/bakeoffs/` with `parseBakeoffFile` and counts
  // what it rejects as `skipped` — so a judged pair that cost two dispatches
  // can vanish from the accumulation with nothing saying the numbers stopped
  // adding up. The audit says it.
  'bakeoff-records': ({ abs, repoRoot, surface }) => {
    const members = directoryMembers(abs, (name) => name.endsWith('.md'));
    if (members == null) {
      return { state: 'rejected', rel: surface.relPath, abs, why: 'the directory could not be listed' };
    }
    for (const name of members.names) {
      const rel = join(surface.relPath, name).split('\\').join('/');
      const artifact = parseBakeoffFile(repoRoot, rel);
      if (!artifact.valid) {
        return {
          state: 'rejected',
          rel,
          abs: join(abs, name),
          why: `parseBakeoffFile rejects it (${artifact.error ?? 'unknown'}), so the scorecard counts it as skipped ` +
            'and the pair it records disappears from every tally',
        };
      }
    }
    return {
      state: 'read',
      detail: `${scanned(members.names.length, members.truncated)} record(s) in ${surface.relPath} parse as valid comparisons.`,
    };
  },
};

/** Shared by the two spawn-side marker logs, which have one row shape. */
function auditSpawnMarkerLog(ctx: { surface: PersistedSurface; abs: string; repoRoot: string }): UnversionedRead {
  const { abs, surface } = ctx;
  let rows: unknown[];
  try {
    rows = spawnMarkerLines(readFileSync(abs, 'utf8'));
  } catch (err) {
    return { state: 'rejected', rel: surface.relPath, abs, why: `a row is not valid JSON: ${(err as Error).message}` };
  }
  for (const [index, row] of rows.entries()) {
    if (spawnMarkerRow(row) == null) {
      return {
        state: 'rejected',
        rel: surface.relPath,
        abs,
        why: `row ${index + 1} carries no usable timestamp/prompt_sha256 pair, so ${surface.reader} skips it silently`,
      };
    }
  }
  return { state: 'read', detail: `${rows.length} row(s) in ${surface.relPath} carry a marker its reader can use.` };
}

/**
 * The reader for an unversioned surface, or null when nothing reads it.
 * Throws for an unversioned surface the table does not mention.
 */
export function unversionedReaderFor(surface: PersistedSurface): UnversionedReader | null {
  if (surface.versionField != null && surface.currentVersion != null) return null;
  if (!Object.hasOwn(UNVERSIONED_READERS, surface.id)) {
    throw new Error(`persisted surface "${surface.id}" is unversioned but has no UNVERSIONED_READERS entry`);
  }
  return UNVERSIONED_READERS[surface.id] ?? null;
}

/** Turn a reader's answer into the surface's finding. */
function fromRead(surface: PersistedSurface, read: UnversionedRead, backupDir: string | null): PersistedFinding {
  if (read.state === 'absent') return finding(surface, 'ok', `${surface.relPath} is not present (nothing to read).`);
  if (read.state === 'read') return finding(surface, 'ok', read.detail);
  return finding(
    surface,
    'error',
    // The `why` always names the reader that refused it — repeating the
    // surface's whole `reader` column here made a two-reader surface read as
    // one unpunctuated run-on.
    `${read.rel} is not a document its reader can use: ${read.why}.`,
    unreadableRemediation(surface, read.abs, backupDir),
  );
}

function auditUnversioned(surface: PersistedSurface, opts: { repoRoot?: string | null; paths?: UserPaths }): PersistedFinding {
  const reader = unversionedReaderFor(surface);
  if (reader == null) {
    const why = surface.reader.startsWith('(none') ? 'nothing reads it' : 'ephemeral or per-document state';
    return finding(surface, 'ok', `${surface.relPath} is unversioned by design (${why}).`);
  }
  const abs = surfaceAbsolutePath(surface, opts);
  if (abs == null || opts.repoRoot == null) {
    return finding(surface, 'ok', `${surface.relPath} could not be resolved here.`);
  }
  if (!existsSync(abs)) return fromRead(surface, { state: 'absent' }, null);
  return fromRead(surface, reader({ surface, abs, repoRoot: opts.repoRoot }), surfaceBackupDir(surface, opts));
}

/**
 * A STAMPED surface whose path is a directory of independent documents.
 *
 * Today that is `host-workspace-state` and only that. The audit used to
 * report `holds per-dispatch state stamped 1.0` about the directory without
 * opening a single member — a claim about a stamp it had never read. Each
 * member is read through `readHostWorkspaceState`, the same reader
 * `dispatch-complete` uses to decide whether an isolated worktree's diff can
 * be collected, so "this state is usable" means one thing in both places.
 *
 * Any OTHER stamped directory surface throws, on the same principle as
 * `shapeValidatorFor`: a new one must declare how its members are read rather
 * than inheriting a blanket `ok`.
 */
function auditStampedDirectory(
  surface: PersistedSurface,
  abs: string,
  opts: { repoRoot?: string | null; paths?: UserPaths },
): PersistedFinding {
  if (surface.id !== 'host-workspace-state') {
    throw new Error(`persisted surface "${surface.id}" is a stamped directory with no member reader`);
  }
  const repoRoot = opts.repoRoot!;
  const backupDir = surfaceBackupDir(surface, opts);
  const runs = directoryMembers(abs, (name) => {
    try {
      return statSync(join(abs, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (runs == null) {
    return finding(surface, 'error', `${surface.relPath} could not be listed.`, unreadableRemediation(surface, abs, backupDir));
  }
  let documents = 0;
  let truncated = runs.truncated;
  for (const run of runs.names) {
    const members = directoryMembers(join(abs, run), (name) => name.endsWith('.json'));
    if (members == null) continue;
    truncated = truncated || members.truncated;
    for (const name of members.names) {
      const dispatchId = name.slice(0, -'.json'.length);
      const memberAbs = join(abs, run, name);
      try {
        // A `null` here means the file vanished between listing and reading —
        // ephemeral state doing exactly what ephemeral state does, not damage.
        if (readHostWorkspaceState(repoRoot, run, dispatchId) != null) documents += 1;
      } catch (err) {
        return finding(
          surface,
          'error',
          `${memberRel(repoRoot, memberAbs)} is not a document readHostWorkspaceState can use: ${(err as Error).message}.`,
          unreadableRemediation(surface, memberAbs, backupDir),
        );
      }
    }
  }
  return finding(
    surface,
    'ok',
    `${surface.relPath} holds ${scanned(documents, truncated)} per-dispatch document(s), each stamped ` +
      `${surface.versionField} ${surface.currentVersion} and readable by ${surface.reader}; not migrated.`,
  );
}

/**
 * One finding per surface: `ok` when current or absent, `warning` when
 * readable but behind, `error` when unreadable or stamped with a version this
 * Fadeno does not know.
 */
export function auditPersistedState(opts: { repoRoot?: string | null; paths?: UserPaths }): PersistedFinding[] {
  const findings: PersistedFinding[] = [];
  for (const surface of PERSISTED_SURFACES) {
    const repoScoped = surface.scope !== 'user-config' && surface.scope !== 'user-state';
    if (repoScoped && opts.repoRoot == null) {
      findings.push(finding(surface, 'ok', `${surface.relPath} is repo-scoped; not checked outside a repository.`));
      continue;
    }
    if (surface.currentVersion == null || surface.versionField == null) {
      findings.push(auditUnversioned(surface, opts));
      continue;
    }
    if (surface.relPath.split(/[\\/]/).includes('<run>')) {
      findings.push(auditPerRun(surface, opts.repoRoot!));
      continue;
    }
    const abs = surfaceAbsolutePath(surface, opts);
    if (abs == null) {
      findings.push(finding(surface, 'ok', `${surface.relPath} could not be resolved here.`));
      continue;
    }
    // A directory of independent documents (host workspace state) is stamped
    // per FILE, so the directory itself has no stamp to compare — every member
    // is read through the surface's own reader instead.
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      findings.push(auditStampedDirectory(surface, abs, opts));
      continue;
    }
    findings.push(
      surface.format === 'jsonl'
        ? auditJsonlRows(surface, abs, surfaceBackupDir(surface, opts))
        : auditStamped(surface, abs, surfaceBackupDir(surface, opts)),
    );
  }
  return findings;
}

// --- migration ---

export interface MigrationReport {
  migrated: Array<{ id: string; from: number; to: number; backup: string }>;
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; error: string }>;
}

/** The surfaces `fadeno setup` will rewrite. Everything else is reported only. */
const MIGRATABLE = new Set(['dials', 'model-verifications', 'repo-dials-pin']);

/** ISO-8601 basic: `20260905T154500Z`. Sorts, and survives every filesystem. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Copy `abs` into the scope's backup directory before it is rewritten.
 *
 * A migration that cannot back up does not rewrite — losing a dial file to a
 * failed migration is strictly worse than leaving it at v0, which stays
 * readable forever by construction.
 */
function backupBefore(
  abs: string,
  surface: PersistedSurface,
  opts: { repoRoot?: string | null; paths?: UserPaths },
  stamp: string,
): string {
  const userScoped = surface.scope === 'user-config' || surface.scope === 'user-state';
  const root = userScoped
    ? join((opts.paths ?? userPaths()).stateDir, 'backups', stamp)
    : join(opts.repoRoot!, '.fadeno', 'local', 'backups', stamp);
  mkdirSync(root, { recursive: true });
  const target = join(root, basename(abs));
  writeFileSync(target, readFileSync(abs), { flag: 'w' });
  return target;
}

function writeAtomic(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, abs);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

type MigrationPlan = { plan: 'empty' } | { plan: 'current' } | { plan: 'rewrite'; from: number; to: number; text: string };

/** What v0 → v1 would do to one surface. The caller has checked it exists. */
function migrateDocument(surface: PersistedSurface, abs: string): MigrationPlan {
  const to = surface.currentVersion as number;
  const read = readVersioned(abs, { expected: to, legacyIsVersion0: true });
  // Existence was checked before the lock, so `missing` here means empty —
  // which every Fadeno reader already treats as "no state", not as damage.
  if ('missing' in read) return { plan: 'empty' };
  if ('unreadable' in read) throw new Error(`${surface.relPath} ${read.unreadable}`);
  if (read.version === to) return { plan: 'current' };
  if (read.version !== 0) throw new Error(`${surface.relPath} is at ${surface.versionField} ${read.version}; only 0 → ${to} is known`);
  let next: Record<string, unknown>;
  if (surface.id === 'model-verifications') {
    if (!Array.isArray(read.body)) throw new Error(`${surface.relPath} v0 is not an array`);
    next = stampSchemaVersion({ verifications: read.body }, to);
  } else if (surface.id === 'dials') {
    next = stampSchemaVersion({ dials: read.body as Record<string, unknown> }, to);
  } else {
    // repo-dials-pin: the v1 shape is the v0 body with a stamp beside it.
    next = stampSchemaVersion(read.body as Record<string, unknown>, to);
  }
  return { plan: 'rewrite', from: read.version, to, text: `${JSON.stringify(next)}\n` };
}

/**
 * Bring every migratable surface to its current version, backing each up
 * first. Called by `fadeno setup`, never by `fadeno doctor`.
 *
 * Failures are collected, not thrown: one unreadable dials file must not stop
 * setup from installing a runtime.
 */
export function migratePersistedState(
  opts: { repoRoot?: string | null; paths?: UserPaths; now?: Date; dryRun?: boolean },
): MigrationReport {
  const report: MigrationReport = { migrated: [], skipped: [], errors: [] };
  const stamp = backupStamp(opts.now ?? new Date());
  for (const surface of PERSISTED_SURFACES) {
    if (!MIGRATABLE.has(surface.id)) continue;
    const repoScoped = surface.scope !== 'user-config' && surface.scope !== 'user-state';
    if (repoScoped && opts.repoRoot == null) {
      report.skipped.push({ id: surface.id, reason: 'repo-scoped; no repository root' });
      continue;
    }
    const abs = surfaceAbsolutePath(surface, opts);
    if (abs == null) {
      report.skipped.push({ id: surface.id, reason: 'path could not be resolved' });
      continue;
    }
    // Checked BEFORE the lock: `withLocalDialStateLock` mkdirs `.fadeno/local/`
    // to place its lock, and `fadeno setup` promises in the same breath that
    // "project files were not changed". Nothing to migrate must mean nothing
    // touched, not an empty directory tree in every repo setup is run from.
    if (!existsSync(abs)) {
      report.skipped.push({ id: surface.id, reason: 'not present' });
      continue;
    }
    try {
      const apply = (): void => {
        const planned = migrateDocument(surface, abs);
        if (planned.plan === 'empty') {
          report.skipped.push({ id: surface.id, reason: 'empty' });
          return;
        }
        if (planned.plan === 'current') {
          report.skipped.push({ id: surface.id, reason: `already at ${surface.versionField} ${surface.currentVersion}` });
          return;
        }
        if (opts.dryRun === true) {
          report.skipped.push({ id: surface.id, reason: `dry run: would migrate ${planned.from} → ${planned.to}` });
          return;
        }
        const backup = backupBefore(abs, surface, opts, stamp);
        writeAtomic(abs, planned.text);
        report.migrated.push({ id: surface.id, from: planned.from, to: planned.to, backup });
      };
      // The repo pin is shared with live `fadeno dial` writers and shadow
      // budget decrements; take the same lock they do rather than racing.
      if (surface.id === 'repo-dials-pin') withLocalDialStateLock(opts.repoRoot!, apply);
      else apply();
    } catch (err) {
      report.errors.push({ id: surface.id, error: (err as Error).message });
    }
  }
  return report;
}

/** One line per outcome, for `setup` to hand to the view. */
export function describeMigrationReport(report: MigrationReport): string[] {
  const lines: string[] = [];
  for (const item of report.migrated) {
    lines.push(`Migrated ${item.id} schema_version ${item.from} → ${item.to} (backup: ${item.backup}).`);
  }
  for (const item of report.errors) {
    lines.push(`Could not migrate ${item.id}: ${item.error} — it was left untouched and stays readable.`);
  }
  return lines;
}

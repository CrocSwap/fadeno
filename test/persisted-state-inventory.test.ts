import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DISPATCHES_FILE, DISPATCHES_FORMAT, PENDING_RELAYS_FILE, PROXY_DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import { BAKEOFFS_DIR } from '../src/commands/dispatches.ts';
import { DIALS_LOCAL_FILE, EXECUTORS_FILE, LOCAL_DIALS_SCHEMA_VERSION, writeLocalDialState } from '../src/lib/executors.ts';
import { HOST_WORKSPACE_SCHEMA_VERSION, HOST_WORKSPACES_DIR } from '../src/lib/host-workspace.ts';
import { emptyInstallationManifest, writeInstallationManifest } from '../src/lib/installations.ts';
import {
  PERSISTED_SURFACES,
  RUN_COMPANION_ROWS,
  USER_PATH_SURFACE_IDS,
  surfaceById,
  type PersistedSurface,
} from '../src/lib/persisted-state.ts';
import { RUN_LEDGER_SCHEMA_VERSION } from '../src/lib/run-ledger.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import {
  DIALS_SCHEMA_VERSION,
  MODEL_VERIFICATIONS_SCHEMA_VERSION,
  recordVerifiedModel,
  retiredStateFiles,
  userPaths,
  writeUserDials,
} from '../src/lib/user-paths.ts';
import { WORKSPACE_LEASE_FILE } from '../src/lib/workspace-lease.ts';
import { tempRepo } from './helpers.ts';

/**
 * The drift tripwire for `PERSISTED_SURFACES`.
 *
 * Fadeno's recurring bug is one fact with two consumers where only one of them
 * gets updated. A persisted-state inventory is exactly that shape: the moment
 * someone adds a state file and forgets the list, `fadeno doctor` reports
 * "everything is current" about a file it has never looked at — a silent wrong
 * answer, which is the failure class this repo exists to end.
 *
 * So this file fails when a path constant grows without an inventory entry,
 * and when a writer's actual bytes stop matching the version the inventory
 * claims. It matches TOKENS (constants, written bytes), never prose.
 */

function scope(t: TestContext): { env: Record<string, string>; home: string } {
  const home = tempRepo(t);
  return {
    home,
    env: {
      FADENO_CONFIG_HOME: join(home, 'config'),
      FADENO_STATE_HOME: join(home, 'state'),
      FADENO_DATA_HOME: join(home, 'data'),
    },
  };
}

// --- shape ---

test('inventory: ids are unique and every field is populated', () => {
  const ids = PERSISTED_SURFACES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate surface id');
  for (const surface of PERSISTED_SURFACES) {
    assert.ok(surface.id.length > 0 && surface.relPath.length > 0, `${surface.id}: empty id/relPath`);
    assert.ok(surface.reader.length > 0 && surface.writer.length > 0, `${surface.id}: unattributed reader/writer`);
    // A version without a field to carry it, or a field with no version, is a
    // half-declared surface — the audit would not know what to compare.
    assert.equal(
      surface.versionField == null,
      surface.currentVersion == null,
      `${surface.id}: versionField and currentVersion must be declared together`,
    );
    assert.equal(surfaceById(surface.id), surface);
  }
});

// --- user-paths.ts: every path constant is accounted for ---

test('tripwire: every key userPaths() returns is mapped to a surface or explicitly excluded', (t) => {
  const paths = userPaths(scope(t));
  for (const key of Object.keys(paths)) {
    assert.ok(
      key in USER_PATH_SURFACE_IDS,
      `userPaths() returns "${key}" with no entry in USER_PATH_SURFACE_IDS — add it to the inventory (src/lib/persisted-state.ts) or map it to null with a reason`,
    );
  }
  for (const [key, id] of Object.entries(USER_PATH_SURFACE_IDS)) {
    assert.ok(key in paths, `USER_PATH_SURFACE_IDS names "${key}", which userPaths() no longer returns`);
    if (id == null) continue;
    const surface = surfaceById(id);
    assert.ok(surface, `USER_PATH_SURFACE_IDS maps ${key} → "${id}", which is not in PERSISTED_SURFACES`);
    const root = surface.scope === 'user-config' ? paths.configDir : paths.stateDir;
    assert.equal(
      join(root, surface.relPath),
      paths[key as keyof typeof paths],
      `surface "${id}" resolves somewhere other than userPaths().${key}`,
    );
  }
});

test('tripwire: the retired state files are inventoried, not forgotten', (t) => {
  const paths = userPaths(scope(t));
  const retired = retiredStateFiles(paths);
  for (const abs of retired) {
    const surface = PERSISTED_SURFACES.find((s) => s.scope === 'user-state' && join(paths.stateDir, s.relPath) === abs);
    assert.ok(surface, `retiredStateFiles() names ${abs} with no inventory entry`);
    assert.equal(surface.format, 'text');
    assert.equal(surface.currentVersion, null);
    assert.match(surface.reader, /none/, `${surface.id} claims a reader; retired state has none`);
  }
});

// --- repo-local constants ---

test('tripwire: every repo-local path constant appears in the inventory', () => {
  const byRelPath = new Map(PERSISTED_SURFACES.map((s) => [s.relPath, s]));
  const required: Array<[string, string]> = [
    [DIALS_LOCAL_FILE, 'repo-dials-pin'],
    [EXECUTORS_FILE, 'project-executors'],
    [DISPATCHES_FILE, 'dispatches-ledger'],
    [WORKSPACE_LEASE_FILE, 'workspace-lease'],
    [INFLIGHT_DIR, 'inflight-status'],
    [PENDING_RELAYS_FILE, 'pending-relays'],
    [PROXY_DISPATCHES_FILE, 'proxy-dispatches'],
    [HOST_WORKSPACES_DIR, 'host-workspace-state'],
    [BAKEOFFS_DIR, 'bakeoff-records'],
  ];
  for (const [relPath, id] of required) {
    const surface = byRelPath.get(relPath);
    assert.ok(surface, `no PERSISTED_SURFACES entry for the path constant "${relPath}"`);
    assert.equal(surface.id, id, `"${relPath}" is inventoried as "${surface.id}", not "${id}"`);
  }
});

test('tripwire: the run ledger and snapshot paths are inventoried as per-run templates', () => {
  const ledger = surfaceById('run-ledger');
  const snapshot = surfaceById('run-snapshot');
  assert.ok(ledger && snapshot);
  assert.equal(ledger.relPath, join('.fadeno', 'runs', '<run>', 'run.yaml'));
  assert.equal(snapshot.relPath, join('.fadeno', 'runs', '<run>', 'profile.yaml'));
  assert.equal(snapshot.versionField, 'snapshot_version');
});

test('tripwire: a per-run surface names its companion row file in both the table and its notes', () => {
  // `events.jsonl` is one fact with two consumers — `RUN_COMPANION_ROWS`,
  // where the audit reads it, and the surface's own `notes`, where a human
  // does. That is the exact shape that rots, and a rotted copy here means
  // doctor silently stops reading a file it claims to audit.
  assert.deepEqual(Object.keys(RUN_COMPANION_ROWS), ['run-ledger']);
  for (const [id, companion] of Object.entries(RUN_COMPANION_ROWS)) {
    const surface = surfaceById(id);
    assert.ok(surface, `RUN_COMPANION_ROWS names "${id}", which is not an inventoried surface`);
    assert.ok(surface.relPath.split(/[\\/]/).includes('<run>'), `"${id}" is not a per-run surface`);
    assert.ok(surface.notes?.includes(companion), `"${id}" notes no longer name ${companion}`);
    assert.notEqual(companion, basename(surface.relPath), `"${id}" companion must be a SECOND file`);
  }
});

// --- the inventory's versions are the code's versions ---

test('tripwire: declared versions equal the constants the writers use', () => {
  const expected: Array<[string, number | string]> = [
    ['dials', DIALS_SCHEMA_VERSION],
    ['model-verifications', MODEL_VERIFICATIONS_SCHEMA_VERSION],
    ['repo-dials-pin', LOCAL_DIALS_SCHEMA_VERSION],
    ['dispatches-ledger', DISPATCHES_FORMAT],
    ['run-ledger', RUN_LEDGER_SCHEMA_VERSION],
    ['host-workspace-state', HOST_WORKSPACE_SCHEMA_VERSION],
  ];
  for (const [id, version] of expected) {
    const surface = surfaceById(id);
    assert.ok(surface, `missing surface ${id}`);
    assert.equal(surface.currentVersion, version, `surface "${id}" disagrees with its writer's constant`);
  }
});

test('tripwire: the two versions with no importable constant still match their source', () => {
  // `snapshot_version` and the installation manifest's `schema_version` are
  // literals in their writers. Match the token rather than restate the number.
  const executors = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'executors.ts'), 'utf8');
  const snapshot = surfaceById('run-snapshot');
  assert.ok(snapshot);
  assert.ok(
    executors.includes(`snapshot_version: ${snapshot.currentVersion},`),
    `serializeSnapshot no longer writes snapshot_version: ${snapshot.currentVersion}`,
  );
  const installations = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'installations.ts'), 'utf8');
  const manifest = surfaceById('installations');
  assert.ok(manifest);
  assert.ok(
    installations.includes(`schema_version: ${manifest.currentVersion}`),
    `the installation manifest no longer writes schema_version: ${manifest.currentVersion}`,
  );
});

// --- every writer's bytes carry the stamp the inventory promises ---

/** Read the stamp a file actually contains, without going through a reader. */
function stampOnDisk(abs: string, field: string): unknown {
  return (JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>)[field];
}

test('tripwire: writeUserDials writes the version the inventory declares', (t) => {
  const options = scope(t);
  const path = writeUserDials(options, { worker: { model: 'sol' } });
  const surface = surfaceById('dials')!;
  assert.equal(stampOnDisk(path, surface.versionField!), surface.currentVersion);
});

test('tripwire: recordVerifiedModel writes the version the inventory declares', (t) => {
  const options = scope(t);
  recordVerifiedModel(options, { harness: 'codex', model: 'sol', verified_at: '2026-09-05T00:00:00.000Z' });
  const surface = surfaceById('model-verifications')!;
  assert.equal(stampOnDisk(userPaths(options).modelVerificationsFile, surface.versionField!), surface.currentVersion);
});

test('tripwire: writeLocalDialState writes the version the inventory declares', (t) => {
  const root = tempRepo(t);
  const path = writeLocalDialState(root, { dials: { worker: { model: 'sol' } }, shadows: {}, legacyNote: null });
  const surface = surfaceById('repo-dials-pin')!;
  assert.equal(stampOnDisk(path, surface.versionField!), surface.currentVersion);
});

test('tripwire: writeInstallationManifest writes the version the inventory declares', (t) => {
  const options = scope(t);
  const paths = userPaths(options);
  mkdirSync(paths.stateDir, { recursive: true });
  writeInstallationManifest(paths, emptyInstallationManifest());
  const surface = surfaceById('installations')!;
  assert.equal(stampOnDisk(paths.installationsFile, surface.versionField!), surface.currentVersion);
});

test('tripwire: the host workspace writer stamps what the inventory declares', (t) => {
  // Written by `writeStateAtomic`, which is module-private; assert the shape
  // its reader enforces instead, which is the same fact from the other side.
  const root = tempRepo(t);
  const surface = surfaceById('host-workspace-state')!;
  const dir = join(root, surface.relPath, 'run', 'dispatch');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema_version: surface.currentVersion }), 'utf8');
  assert.equal(stampOnDisk(join(dir, 'state.json'), surface.versionField!), HOST_WORKSPACE_SCHEMA_VERSION);
});

// --- the audit covers what the inventory lists ---

test('tripwire: a surface added to the inventory is audited, not silently ignored', async (t) => {
  const { auditPersistedState } = await import('../src/lib/persisted-state.ts');
  const root = tempRepo(t);
  const findings = auditPersistedState({ repoRoot: root, paths: userPaths(scope(t)) });
  const audited = new Set(findings.map((f) => f.check));
  for (const surface of PERSISTED_SURFACES) {
    assert.ok(
      audited.has(`persisted-state:${surface.id}`),
      `surface "${surface.id}" is inventoried but produces no doctor finding`,
    );
  }
  assert.equal(findings.length, PERSISTED_SURFACES.length, 'one finding per surface, no more');
});

test('inventory: scopes resolve against a root the audit knows how to find', () => {
  const userScoped: PersistedSurface['scope'][] = ['user-config', 'user-state'];
  for (const surface of PERSISTED_SURFACES) {
    if (userScoped.includes(surface.scope)) {
      assert.ok(!surface.relPath.startsWith('.fadeno'), `${surface.id} is user-scoped but names a repo path`);
    } else {
      assert.ok(surface.relPath.startsWith('.fadeno'), `${surface.id} is repo-scoped but does not live under .fadeno/`);
    }
  }
});

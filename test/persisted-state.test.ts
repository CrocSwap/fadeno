import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  auditPersistedState,
  backupStamp,
  describeMigrationReport,
  MEMBER_AUDIT_SCAN_LIMIT,
  migratePersistedState,
  PERSISTED_SURFACES,
  readVersioned,
  shapeValidatorFor,
  stampSchemaVersion,
  surfaceAbsolutePath,
  surfaceById,
  unversionedReaderFor,
} from '../src/lib/persisted-state.ts';
import { parseBakeoffFile } from '../src/lib/bakeoff.ts';
import { readHostWorkspaceState } from '../src/lib/host-workspace.ts';
import { readInflightClaim } from '../src/lib/supervisor.ts';
import { readWorkspaceLease } from '../src/lib/workspace-lease.ts';
import { DIALS_LOCAL_FILE, readLocalDialState } from '../src/lib/executors.ts';
import { readInstallationManifest } from '../src/lib/installations.ts';
import { RUN_LEDGER_SCHEMA_VERSION } from '../src/lib/run-ledger.ts';
import {
  MODEL_VERIFICATIONS_SCHEMA_VERSION,
  readUserDials,
  readVerifiedModels,
  recordVerifiedModel,
  removeVerifiedModels,
  userPaths,
  writeUserDials,
} from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/** A literal path inside a RegExp — Windows separators and dots included. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A hermetic user scope rooted in a throwaway directory. */
function userScope(t: TestContext): { env: Record<string, string>; home: string } {
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

// --- stampSchemaVersion ---

test('stampSchemaVersion puts the stamp first and never duplicates it', () => {
  const stamped = stampSchemaVersion({ dials: { worker: 'sol' } }, 1);
  assert.equal(JSON.stringify(stamped), '{"schema_version":1,"dials":{"worker":"sol"}}');
  const restamped = stampSchemaVersion(stamped, 2);
  assert.equal(JSON.stringify(restamped), '{"schema_version":2,"dials":{"worker":"sol"}}');
  assert.equal(Object.keys(restamped).filter((k) => k === 'schema_version').length, 1);
});

// --- readVersioned ---

test('readVersioned: absent and empty files are missing, not corrupt', (t) => {
  const root = tempRepo(t);
  const path = join(root, 'doc.json');
  assert.deepEqual(readVersioned(path, { expected: 1, legacyIsVersion0: true }), { missing: true });
  writeFileSync(path, '   \n', 'utf8');
  assert.deepEqual(readVersioned(path, { expected: 1, legacyIsVersion0: true }), { missing: true });
});

test('readVersioned: an unstamped document is version 0 and keeps its body', (t) => {
  const root = tempRepo(t);
  const path = join(root, 'doc.json');
  writeFileSync(path, '{"worker":"sol"}\n', 'utf8');
  assert.deepEqual(readVersioned(path, { expected: 1, legacyIsVersion0: true }), { version: 0, body: { worker: 'sol' } });
  // A bare array cannot carry a top-level stamp, so it is legacy by construction.
  writeFileSync(path, '[{"model":"sol"}]\n', 'utf8');
  assert.deepEqual(readVersioned(path, { expected: 1, legacyIsVersion0: true }), { version: 0, body: [{ model: 'sol' }] });
});

test('readVersioned: a stamped document reports its version; a future one is unreadable', (t) => {
  const root = tempRepo(t);
  const path = join(root, 'doc.json');
  writeFileSync(path, '{"schema_version":1,"dials":{}}\n', 'utf8');
  const read = readVersioned(path, { expected: 1, legacyIsVersion0: true });
  assert.deepEqual(read, { version: 1, body: { schema_version: 1, dials: {} } });

  writeFileSync(path, '{"schema_version":9,"dials":{}}\n', 'utf8');
  const future = readVersioned(path, { expected: 1, legacyIsVersion0: true });
  assert.ok('unreadable' in future && /newer than this fadeno reads/.test(future.unreadable));
});

test('readVersioned: malformed bytes and a non-integer stamp are unreadable, never silently v0', (t) => {
  const root = tempRepo(t);
  const path = join(root, 'doc.json');
  writeFileSync(path, '{not json', 'utf8');
  assert.ok('unreadable' in readVersioned(path, { expected: 1, legacyIsVersion0: true }));
  writeFileSync(path, '{"schema_version":"1"}', 'utf8');
  const bad = readVersioned(path, { expected: 1, legacyIsVersion0: true });
  assert.ok('unreadable' in bad && /not a non-negative integer/.test(bad.unreadable));
});

test('readVersioned reads YAML by extension', (t) => {
  const root = tempRepo(t);
  const path = join(root, 'doc.yaml');
  writeFileSync(path, 'schema_version: 4\nmodels: {}\n', 'utf8');
  const read = readVersioned(path, { expected: 4, legacyIsVersion0: true });
  assert.ok('version' in read && read.version === 4);
});

// --- backups ---

test('backupStamp is ISO-8601 basic and sorts', () => {
  assert.equal(backupStamp(new Date('2026-09-05T15:28:00.123Z')), '20260905T152800Z');
  assert.ok(backupStamp(new Date('2026-09-05T15:28:00Z')) < backupStamp(new Date('2026-09-05T15:29:00Z')));
});

// --- migration ---

test('migratePersistedState: v0 dials become v1, backed up first, and read back identically', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  const v0 = readFileSync(join(import.meta.dirname, 'fixtures', 'persisted-state', 'dials', 'v0.json'), 'utf8');
  writeFileSync(paths.dialsFile, v0, 'utf8');
  const before = readUserDials(scope);

  const report = migratePersistedState({ repoRoot: null, paths, now: new Date('2026-09-05T15:28:00Z') });
  const migrated = report.migrated.find((m) => m.id === 'dials');
  assert.ok(migrated, `expected dials to migrate; got ${JSON.stringify(report)}`);
  assert.equal(migrated.from, 0);
  assert.equal(migrated.to, 1);
  assert.equal(migrated.backup, join(paths.stateDir, 'backups', '20260905T152800Z', 'dials.json'));
  assert.equal(readFileSync(migrated.backup, 'utf8'), v0);

  assert.equal(JSON.parse(readFileSync(paths.dialsFile, 'utf8')).schema_version, 1);
  assert.deepEqual(readUserDials(scope), before);
});

test('migratePersistedState: v0 verifications become v1 without losing an entry', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  const v0 = readFileSync(join(import.meta.dirname, 'fixtures', 'persisted-state', 'model-verifications', 'v0.json'), 'utf8');
  writeFileSync(paths.modelVerificationsFile, v0, 'utf8');
  const before = readVerifiedModels(scope);
  assert.equal(before.length, 2);

  const report = migratePersistedState({ repoRoot: null, paths });
  assert.ok(report.migrated.some((m) => m.id === 'model-verifications'));
  const doc = JSON.parse(readFileSync(paths.modelVerificationsFile, 'utf8'));
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.verifications.length, 2);
  assert.deepEqual(readVerifiedModels(scope), before);
});

test('migratePersistedState: the repo pin gains a stamp and the same dials read back', (t) => {
  const root = tempRepo(t);
  const scope = userScope(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  const v0 = readFileSync(join(import.meta.dirname, 'fixtures', 'persisted-state', 'repo-dials-pin', 'v0.json'), 'utf8');
  writeFileSync(join(root, DIALS_LOCAL_FILE), v0, 'utf8');
  const before = readLocalDialState(root);

  const report = migratePersistedState({ repoRoot: root, paths: userPaths(scope), now: new Date('2026-09-05T15:28:00Z') });
  const migrated = report.migrated.find((m) => m.id === 'repo-dials-pin');
  assert.ok(migrated, `expected repo-dials-pin to migrate; got ${JSON.stringify(report)}`);
  assert.equal(migrated.backup, join(root, '.fadeno', 'local', 'backups', '20260905T152800Z', 'dials'));
  assert.equal(readFileSync(migrated.backup, 'utf8'), v0);
  assert.equal(JSON.parse(readFileSync(join(root, DIALS_LOCAL_FILE), 'utf8')).schema_version, 1);
  assert.deepEqual(readLocalDialState(root), before);
});

test('migratePersistedState is idempotent and reports why it skipped', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  writeUserDials(scope, { worker: { model: 'sol' } });

  const first = migratePersistedState({ repoRoot: null, paths });
  assert.deepEqual(first.migrated, []);
  const skipped = first.skipped.find((s) => s.id === 'dials');
  assert.ok(skipped && /already at schema_version 1/.test(skipped.reason));
  const absent = first.skipped.find((s) => s.id === 'model-verifications');
  assert.ok(absent && absent.reason === 'not present');
  assert.ok(first.skipped.some((s) => s.id === 'repo-dials-pin' && /repo-scoped/.test(s.reason)));
});

test('migratePersistedState creates nothing in a repo that has no pin to migrate', (t) => {
  const root = tempRepo(t);
  const report = migratePersistedState({ repoRoot: root, paths: userPaths(userScope(t)) });
  assert.ok(report.skipped.some((s) => s.id === 'repo-dials-pin' && s.reason === 'not present'));
  // `withLocalDialStateLock` mkdirs `.fadeno/local/` to place its lock, and
  // `fadeno setup` promises project files were not changed. Nothing to do
  // must mean nothing touched.
  assert.equal(existsSync(join(root, '.fadeno')), false);
});

test('migratePersistedState: an empty file is reported as empty, not as current', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.dialsFile, '\n', 'utf8');
  const report = migratePersistedState({ repoRoot: null, paths });
  assert.ok(report.skipped.some((s) => s.id === 'dials' && s.reason === 'empty'));
});

test('migratePersistedState: a dry run changes no bytes', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  const v0 = '{"worker":"sol"}\n';
  writeFileSync(paths.dialsFile, v0, 'utf8');
  const report = migratePersistedState({ repoRoot: null, paths, dryRun: true });
  assert.deepEqual(report.migrated, []);
  assert.ok(report.skipped.some((s) => s.id === 'dials' && /dry run: would migrate 0 → 1/.test(s.reason)));
  assert.equal(readFileSync(paths.dialsFile, 'utf8'), v0);
  assert.equal(existsSync(join(paths.stateDir, 'backups')), false);
});

test('migratePersistedState: an unreadable file is an error and is LEFT ALONE', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  const corrupt = '{"schema_version":99,"dials":{}}\n';
  writeFileSync(paths.dialsFile, corrupt, 'utf8');
  const report = migratePersistedState({ repoRoot: null, paths });
  const error = report.errors.find((e) => e.id === 'dials');
  assert.ok(error && /newer than this fadeno reads/.test(error.error));
  assert.equal(readFileSync(paths.dialsFile, 'utf8'), corrupt);
  assert.ok(describeMigrationReport(report).some((line) => /left untouched and stays readable/.test(line)));
});

// --- audit ---

test('auditPersistedState: every surface produces exactly one finding, id-prefixed', (t) => {
  const root = tempRepo(t);
  const findings = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) });
  const checks = findings.map((f) => f.check);
  assert.equal(new Set(checks).size, checks.length, 'one finding per surface, no duplicates');
  assert.ok(checks.every((c) => c.startsWith('persisted-state:')));
  assert.ok(checks.includes('persisted-state:dials'));
  assert.ok(checks.includes('persisted-state:repo-dials-pin'));
  // Nothing on disk yet: absent is not rot.
  assert.ok(findings.every((f) => f.severity === 'ok'), JSON.stringify(findings.filter((f) => f.severity !== 'ok')));
});

test('auditPersistedState: a v0 file is a warning that names both versions and points at setup', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.dialsFile, '{"worker":"sol"}\n', 'utf8');
  const finding = auditPersistedState({ repoRoot: null, paths }).find((f) => f.check === 'persisted-state:dials');
  assert.ok(finding);
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /schema_version 0; this fadeno writes 1/);
  assert.match(finding.remediation ?? '', /fadeno setup/);
});

test('auditPersistedState: an unparsable file is an error that names the recreate path AND where to keep a copy', (t) => {
  // "Move it aside, then delete it" is only actionable once the user knows
  // WHERE aside is. The malformed-current findings already name the surface's
  // backup directory; unreadable is the same instruction with a worse cause,
  // so it points at the same place — the directory `fadeno setup` would have
  // written to, so a hand-made copy lands beside the automatic ones.
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  const backups = join(paths.stateDir, 'backups');
  writeFileSync(paths.dialsFile, '{oops', 'utf8');
  const finding = auditPersistedState({ repoRoot: null, paths }).find((f) => f.check === 'persisted-state:dials');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.remediation ?? '', /writeUserDials/);
  assert.match(finding.remediation ?? '', new RegExp(escapeRe(backups)), 'names <stateDir>/backups');

  // An UNKNOWN version is the same class of dead end and gets the same path.
  writeFileSync(paths.dialsFile, '{"schema_version":9,"dials":{}}\n', 'utf8');
  const future = auditPersistedState({ repoRoot: null, paths }).find((f) => f.check === 'persisted-state:dials');
  assert.ok(future);
  assert.equal(future.severity, 'error');
  assert.match(future.detail, /newer than this fadeno reads/);
  assert.match(future.remediation ?? '', new RegExp(escapeRe(backups)));
});

test('auditPersistedState: an unreadable REPO-local surface names the repo backup directory', (t) => {
  // The other half of the contract's backup-and-recreate guidance: repo-local
  // files back up under the repo, never into the user state directory.
  const root = tempRepo(t);
  const paths = userPaths(userScope(t));
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"schema_version":9,"dials":{}}\n', 'utf8');
  const finding = auditPersistedState({ repoRoot: root, paths }).find((f) => f.check === 'persisted-state:repo-dials-pin');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.remediation ?? '', new RegExp(escapeRe(join(root, '.fadeno', 'local', 'backups'))));
});

// --- malformed at the CURRENT version ---
//
// The bug this section exists for: `auditStamped` used to compare
// `schema_version` and stop, so `{"schema_version": 1, "dials": []}` was
// reported `ok` while `readUserDials` yielded nothing from it. A stamp is not
// a schema. Every stamped surface is now validated through its own reader's
// rules — the same functions the readers use, not a second copy — before the
// audit is allowed to say `ok`.

const ZOO = join(import.meta.dirname, 'fixtures', 'persisted-state');

function malformed(surfaceId: string): string {
  return readFileSync(join(ZOO, surfaceId, 'malformed-v1.json'), 'utf8');
}

test('audit: a v1 dials file that yields no dials is an error, not a healthy current file', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.dialsFile, malformed('dials'), 'utf8');

  // The premise: the reader really does get nothing out of it.
  assert.deepEqual(readUserDials(scope), {});

  const finding = auditPersistedState({ repoRoot: null, paths }).find((f) => f.check === 'persisted-state:dials');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.detail, /stamped schema_version 1/);
  assert.match(finding.detail, /no `dials` mapping/);
  assert.match(finding.detail, /Every read of it comes back empty/);
  // The remediation names the file and where to put a copy of it.
  assert.match(finding.remediation ?? '', new RegExp(escapeRe(paths.dialsFile)));
  assert.match(finding.remediation ?? '', new RegExp(escapeRe(join(paths.stateDir, 'backups'))));
  assert.match(finding.remediation ?? '', /fadeno setup` will not repair this/);
});

test('audit: a v1 dials file that drops ONE entry is a warning — the rest of it still reads', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.dialsFile, '{"schema_version":1,"dials":{"worker":"sol","judge":7}}\n', 'utf8');
  assert.deepEqual(readUserDials(scope), { worker: { model: 'sol' } });

  const finding = auditPersistedState({ repoRoot: null, paths }).find((f) => f.check === 'persisted-state:dials');
  assert.ok(finding);
  assert.equal(finding.severity, 'warning', 'a partly-readable file is not a broken one');
  assert.match(finding.detail, /dial "judge" is a number, not a dial ref/);
  assert.match(finding.detail, /that part is silently dropped/);
});

test('audit: a v1 verification cache with no `verifications` array is an error', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.modelVerificationsFile, malformed('model-verifications'), 'utf8');
  assert.deepEqual(readVerifiedModels(scope), []);

  const finding = auditPersistedState({ repoRoot: null, paths })
    .find((f) => f.check === 'persisted-state:model-verifications');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.detail, /no `verifications` array/);
  assert.match(finding.remediation ?? '', new RegExp(escapeRe(paths.modelVerificationsFile)));
});

test('audit: a v1 repo pin still carrying a pre-0.6 `loadout` is an error, and names the repo backup dir', (t) => {
  const root = tempRepo(t);
  const paths = userPaths(userScope(t));
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), malformed('repo-dials-pin'), 'utf8');
  assert.deepEqual(readLocalDialState(root).dials, {});

  const finding = auditPersistedState({ repoRoot: root, paths })
    .find((f) => f.check === 'persisted-state:repo-dials-pin');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.detail, /pre-0\.6 loadout pin ignored/);
  assert.match(finding.remediation ?? '', new RegExp(escapeRe(join(root, '.fadeno', 'local', 'backups'))));
});

test('audit: a v1 installation manifest with no `harnesses` is an error', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.installationsFile, malformed('installations'), 'utf8');
  assert.throws(() => readInstallationManifest(scope), /malformed installation manifest/);

  const finding = auditPersistedState({ repoRoot: null, paths })
    .find((f) => f.check === 'persisted-state:installations');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.detail, /no `harnesses` mapping/);
});

test('audit: a well-formed current document of every stamped surface is still ok', (t) => {
  const root = tempRepo(t);
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeUserDials(scope, { worker: { model: 'sol' } });
  recordVerifiedModel(scope, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: new Date().toISOString() });
  writeFileSync(paths.installationsFile, `${JSON.stringify({ schema_version: 1, runtime: null, harnesses: {} })}\n`, 'utf8');
  writeFileSync(join(root, DIALS_LOCAL_FILE), `${JSON.stringify({ schema_version: 1, dials: { worker: 'sol' }, shadows: {} })}\n`, 'utf8');

  const findings = auditPersistedState({ repoRoot: root, paths });
  for (const id of ['dials', 'model-verifications', 'installations', 'repo-dials-pin']) {
    const found = findings.find((f) => f.check === `persisted-state:${id}`);
    assert.ok(found, id);
    assert.equal(found.severity, 'ok', `${id}: ${found.detail}`);
  }
});

test('tripwire: every stamped surface has a decided SHAPE_VALIDATORS entry', () => {
  // `shapeValidatorFor` throws for a stamped surface the table does not
  // mention, so adding a surface forces the decision instead of defaulting to
  // "trust the stamp" — which is exactly what shipped and was wrong.
  const validated: string[] = [];
  for (const surface of PERSISTED_SURFACES) {
    const validator = shapeValidatorFor(surface); // throws on an undecided stamped surface
    if (validator != null) validated.push(surface.id);
  }
  assert.deepEqual(validated.sort(), ['dials', 'installations', 'model-verifications', 'repo-dials-pin']);
});

test('auditPersistedState: repo-scoped surfaces are ok, not error, outside a repository', (t) => {
  const findings = auditPersistedState({ repoRoot: null, paths: userPaths(userScope(t)) });
  const pin = findings.find((f) => f.check === 'persisted-state:repo-dials-pin');
  assert.ok(pin && pin.severity === 'ok' && /not checked outside a repository/.test(pin.detail));
});

test('auditPersistedState: an old dispatches row is reported without calling append-only history rot', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'dispatches.jsonl'),
    '{"format":"1.0","event":"dispatch_completed"}\n{"format":"1.1","event":"dispatch_completed"}\n',
    'utf8',
  );
  const finding = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) })
    .find((f) => f.check === 'persisted-state:dispatches-ledger');
  assert.ok(finding);
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /1\.0/);
  assert.match(finding.remediation ?? '', /append-only/i);
});

test('auditPersistedState: an older run ledger is named but not called rot — history is immutable', (t) => {
  const root = tempRepo(t);
  for (const [runId, version] of [['2026-01-01-0001-a', '0.2'], ['2026-01-02-0002-b', '0.3']] as const) {
    const dir = join(root, '.fadeno', 'runs', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.yaml'), `schema_version: "${version}"\nrun_id: ${runId}\n`, 'utf8');
  }
  const findings = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) })
    .filter((f) => f.check === 'persisted-state:run-ledger');
  assert.equal(findings.length, 1, 'one rolled-up finding, not one per run');
  assert.equal(findings[0]!.severity, 'ok');
  assert.match(findings[0]!.detail, /1 of 2 scanned run\(s\)/);
  assert.match(findings[0]!.detail, /1 older run\(s\) keep the format they were written with/);
  assert.match(findings[0]!.detail, /2026-01-01-0001-a/);
});

test('auditPersistedState: a surface with its OWN version key is read by that key, not by schema_version', (t) => {
  // `readVersioned` reads `schema_version` and nothing else. Routing a
  // `snapshot_version` surface through it made every profile.yaml — including
  // the one written moments earlier — read back as an unstamped v0, so doctor
  // reported "0 of N current" about a directory where all N were current.
  // A confident wrong answer from the check that exists to catch wrong
  // answers, so it gets its own regression.
  const root = tempRepo(t);
  const dir = join(root, '.fadeno', 'runs', '2026-01-01-0001-a');
  mkdirSync(dir, { recursive: true });
  const snapshot = surfaceById('run-snapshot');
  writeFileSync(join(dir, 'profile.yaml'), `snapshot_version: ${snapshot.currentVersion}\nexecutors: {}\n`, 'utf8');

  const finding = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) })
    .find((f) => f.check === 'persisted-state:run-snapshot');
  assert.ok(finding);
  assert.equal(finding.severity, 'ok');
  assert.match(finding.detail, /1 of the 1 most recent run\(s\) carry profile\.yaml at snapshot_version 3/);
  assert.doesNotMatch(finding.detail, /older run\(s\)/, 'a current snapshot must not be counted as legacy');
});

test('auditPersistedState: a DAMAGED run ledger is still an error, however old the run is', (t) => {
  const root = tempRepo(t);
  const dir = join(root, '.fadeno', 'runs', '2026-01-01-0001-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), 'schema_version: "0.3"\n  bad: [indent\n', 'utf8');
  const finding = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) })
    .find((f) => f.check === 'persisted-state:run-ledger');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.detail, /worst of 1 run\(s\) scanned/);
});

// --- the run ledger's second file ---

/** The captured event log: two pre-`seq` rows, one current row, two damaged lines. */
const EVENTS_FIXTURE = join(ZOO, 'run-ledger', 'malformed-events.jsonl');

/** A run directory with a current `run.yaml` and the given event rows. */
function runWithEvents(t: TestContext, lines: string): { root: string; runId: string } {
  const root = tempRepo(t);
  const runId = '2026-01-01-0001-a';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), `schema_version: "${RUN_LEDGER_SCHEMA_VERSION}"\nrun_id: ${runId}\n`, 'utf8');
  writeFileSync(join(dir, 'events.jsonl'), lines, 'utf8');
  return { root, runId };
}

test('auditPersistedState: a corrupt events.jsonl row is a defect naming the run and the line', (t) => {
  // `run-ledger` is ONE surface with TWO files. The audit derived only
  // `run.yaml` from the surface path, so a shredded event log left
  // `persisted-state:run-ledger` reporting `ok` — a confident wrong answer
  // from the check built to catch confident wrong answers.
  const { root, runId } = runWithEvents(t, readFileSync(EVENTS_FIXTURE, 'utf8'));
  const finding = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) })
    .find((f) => f.check === 'persisted-state:run-ledger');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.match(finding.detail, new RegExp(`run ${escapeRe(runId)}`), 'the finding names which run is damaged');
  assert.match(finding.detail, /events\.jsonl has 2 row\(s\)/);
  assert.match(finding.detail, /at lines 4, 5/, 'and which lines');
  assert.match(finding.detail, /3 row\(s\) still read/);
  assert.match(finding.remediation ?? '', /never rewritten in place/i);
  assert.match(finding.remediation ?? '', /backups/, 'a copy belongs in the backup directory');
});

test('auditPersistedState: older-format event rows read clean and are never called rot', (t) => {
  // Lines 1-2 of the fixture were captured from a 0.2-era run and carry no
  // `seq`. Immutable history keeps the shape it was written in: the reader
  // still yields them, so they are `ok`, exactly as an older `run.yaml` is.
  const older = readFileSync(EVENTS_FIXTURE, 'utf8').split('\n').slice(0, 3).join('\n') + '\n';
  const { root } = runWithEvents(t, older);
  const finding = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) })
    .find((f) => f.check === 'persisted-state:run-ledger');
  assert.ok(finding);
  assert.equal(finding.severity, 'ok');
  assert.match(finding.detail, /3 events\.jsonl row\(s\) across 1 run\(s\) read cleanly/);
});

// --- path resolution ---

test('surfaceAbsolutePath resolves by scope and refuses a per-run template', (t) => {
  const root = tempRepo(t);
  const paths = userPaths(userScope(t));
  const dials = surfaceById('dials');
  assert.ok(dials);
  assert.equal(surfaceAbsolutePath(dials, { paths }), paths.dialsFile);
  const executors = surfaceById('user-executors');
  assert.ok(executors);
  assert.equal(surfaceAbsolutePath(executors, { paths }), paths.executorsFile);
  const pin = surfaceById('repo-dials-pin');
  assert.ok(pin);
  assert.equal(surfaceAbsolutePath(pin, { repoRoot: root, paths }), join(root, DIALS_LOCAL_FILE));
  assert.equal(surfaceAbsolutePath(pin, { paths }), null);
  const ledger = surfaceById('run-ledger');
  assert.ok(ledger);
  assert.equal(surfaceAbsolutePath(ledger, { repoRoot: root, paths }), null);
  assert.equal(surfaceById('no-such-surface'), null);
});

// --- the write-side guard the cache depends on ---

test('removeVerifiedModels writes the stamped shape, so pruning cannot revert the file to v0', (t) => {
  // `models remove` and `models verify --` both prune without recording, and
  // the pruning writer was the one path that still emitted the bare v0 array.
  // A user who ran either would have watched a migrated file silently
  // un-migrate itself, then seen doctor warn about it again.
  const scope = userScope(t);
  const paths = userPaths(scope);
  recordVerifiedModel(scope, { harness: 'codex', model: 'sol', verified_at: '2026-09-05T00:00:00.000Z' });
  recordVerifiedModel(scope, { harness: 'codex', model: 'luna', verified_at: '2026-09-05T00:00:00.000Z' });

  assert.equal(removeVerifiedModels(scope, (row) => row.model === 'sol'), 1);
  const doc = JSON.parse(readFileSync(paths.modelVerificationsFile, 'utf8')) as Record<string, unknown>;
  assert.equal(doc.schema_version, MODEL_VERIFICATIONS_SCHEMA_VERSION);
  assert.deepEqual(readVerifiedModels(scope).map((row) => row.model), ['luna']);
  const finding = auditPersistedState({ repoRoot: null, paths }).find((f) => f.check === 'persisted-state:model-verifications');
  assert.ok(finding && finding.severity === 'ok', 'and doctor still calls the pruned file current');
});

test('recordVerifiedModel refuses to overwrite a document it could not understand', (t) => {
  const scope = userScope(t);
  const paths = userPaths(scope);
  mkdirSync(paths.stateDir, { recursive: true });
  const future = '{"schema_version":42,"verifications":[{"harness":"claude","model":"opus","verified_at":"2026-01-01T00:00:00.000Z"}]}\n';
  writeFileSync(paths.modelVerificationsFile, future, 'utf8');
  recordVerifiedModel(scope, { harness: 'codex', model: 'sol', verified_at: '2026-09-05T00:00:00.000Z' });
  assert.equal(readFileSync(paths.modelVerificationsFile, 'utf8'), future, 'a newer cache must survive an older fadeno');
  const finding = auditPersistedState({ repoRoot: null, paths }).find((f) => f.check === 'persisted-state:model-verifications');
  assert.ok(finding && finding.severity === 'error', 'and the user must be told by doctor');
});

// --- unversioned and directory surfaces: read through the REAL reader ---
//
// The second half of "a stamp is not a schema": being UNSTAMPED is not a
// reason to skip the read either. The audit used to answer `ok` for every
// unversioned surface — "unversioned by design" — and for every directory
// surface — "holds per-dispatch state stamped 1.0" — without opening a single
// file. Six surfaces holding live machine-local state were reported healthy by
// a check that had never looked at them.

/** Install a fixture from the zoo at a repo-relative path. */
function installFixture(root: string, relPath: string, surfaceId: string, name: string): string {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, readFileSync(join(ZOO, surfaceId, name), 'utf8'), 'utf8');
  return abs;
}

function auditFor(root: string, t: TestContext, check: string) {
  const found = auditPersistedState({ repoRoot: root, paths: userPaths(userScope(t)) })
    .find((f) => f.check === `persisted-state:${check}`);
  assert.ok(found, `no finding for ${check}`);
  return found;
}

/** Where a repo-local surface's damaged copy is told to go. */
function repoBackups(root: string): RegExp {
  return new RegExp(escapeRe(join(root, '.fadeno', 'local', 'backups')));
}

test('tripwire: every unversioned surface has a decided UNVERSIONED_READERS entry', () => {
  // The sibling of the SHAPE_VALIDATORS tripwire: `unversionedReaderFor`
  // throws for an unversioned surface the table does not mention, so adding a
  // surface forces the decision instead of defaulting to a blanket `ok` — the
  // exact silence this change closes.
  const read: string[] = [];
  const unread: string[] = [];
  for (const surface of PERSISTED_SURFACES) {
    if (surface.versionField != null && surface.currentVersion != null) continue;
    if (unversionedReaderFor(surface) != null) read.push(surface.id);
    else unread.push(surface.id);
  }
  assert.deepEqual(read.sort(), [
    'bakeoff-records', 'inflight-status', 'pending-relays', 'proxy-dispatches', 'workspace-lease',
  ]);
  // Each of these declares `(none…)` in its own `reader` column, and the two
  // must agree — a surface that grows a reader must grow an entry with it.
  assert.deepEqual(unread.sort(), ['retired-harness-pin', 'retired-loadout-pin', 'user-config']);
  for (const id of unread) assert.ok(surfaceById(id)!.reader.startsWith('(none'), `${id} reader column`);
});

test('audit: a surface nothing reads is still ok, and says why', (t) => {
  const found = auditFor(tempRepo(t), t, 'user-config');
  assert.equal(found.severity, 'ok');
  assert.match(found.detail, /unversioned by design \(nothing reads it\)/);
});

// --- workspace-lease ---

test('audit: a workspace lease its reader refuses is an error, not a free workspace', (t) => {
  const root = tempRepo(t);
  const abs = installFixture(root, join('.fadeno', 'local', 'workspace-lease.json'), 'workspace-lease', 'malformed.json');
  // The premise: the reader really does get nothing out of it. That used to be
  // how mutual exclusion silently stopped excluding; there is nothing to
  // exclude now, and the audit still has to report a surface it cannot read —
  // saying nothing about a file it never opened is the defect this inventory
  // exists to prevent, whatever the file is for.
  assert.equal(readWorkspaceLease(root), null);

  const found = auditFor(root, t, 'workspace-lease');
  assert.equal(found.severity, 'error');
  assert.match(found.detail, /workspace-lease\.json/);
  assert.match(found.detail, /Vestigial either way/);
  assert.match(found.remediation ?? '', new RegExp(escapeRe(abs)));
  assert.match(found.remediation ?? '', repoBackups(root));
});

test('audit: a real captured lease reads back and names its holder', (t) => {
  const root = tempRepo(t);
  installFixture(root, join('.fadeno', 'local', 'workspace-lease.json'), 'workspace-lease', 'current.json');
  const found = auditFor(root, t, 'workspace-lease');
  assert.equal(found.severity, 'ok', found.detail);
  assert.match(found.detail, /leftover shared lease naming "hd-ac-implement-g1-implementer-a1"/);
  assert.match(found.detail, /nothing reads it any more/);
});

test('audit: an absent lease is ok — absence is not damage', (t) => {
  const found = auditFor(tempRepo(t), t, 'workspace-lease');
  assert.equal(found.severity, 'ok');
  assert.match(found.detail, /not present \(nothing to read\)/);
});

// --- inflight-status: TWO document kinds in one directory ---

test('audit: both kinds of inflight document are read, and counted separately', (t) => {
  const root = tempRepo(t);
  const dir = join('.fadeno', 'local', 'inflight');
  installFixture(root, join(dir, 'ed4d8ed6.json'), 'inflight-status', 'claim.json');
  installFixture(root, join(dir, 'ed4d8ed6.status.json'), 'inflight-status', 'status.json');
  const found = auditFor(root, t, 'inflight-status');
  assert.equal(found.severity, 'ok', found.detail);
  assert.match(found.detail, /1 claim\(s\) and 1 supervisor status record\(s\)/);
});

test('audit: a claim with no usable pid is an error — a live delivery must not read as finished', (t) => {
  const root = tempRepo(t);
  const abs = installFixture(root, join('.fadeno', 'local', 'inflight', 'ed4d8ed6.json'), 'inflight-status', 'malformed-claim.json');
  assert.equal(readInflightClaim(abs, (p) => readFileSync(p, 'utf8')), null);

  const found = auditFor(root, t, 'inflight-status');
  assert.equal(found.severity, 'error');
  assert.match(found.detail, /inflight[\\/]ed4d8ed6\.json/);
  assert.match(found.detail, /look finished/);
  assert.match(found.remediation ?? '', new RegExp(escapeRe(abs)));
  assert.match(found.remediation ?? '', repoBackups(root));
});

test('audit: a supervisor status record truncated mid-write is an error naming that file', (t) => {
  const root = tempRepo(t);
  const abs = installFixture(root, join('.fadeno', 'local', 'inflight', 'ed4d8ed6.status.json'), 'inflight-status', 'malformed-status.json');
  const found = auditFor(root, t, 'inflight-status');
  assert.equal(found.severity, 'error');
  assert.match(found.detail, /ed4d8ed6\.status\.json/);
  assert.match(found.detail, /readSupervisorStatus/);
  assert.match(found.remediation ?? '', new RegExp(escapeRe(abs)));
});

test('audit: a directory scan says so when it hits its bound', (t) => {
  // A bounded scan that does not announce the bound is the confident wrong
  // answer this module exists to catch: "every one reads cleanly" about a
  // fraction of a directory.
  const root = tempRepo(t);
  const dir = join(root, '.fadeno', 'local', 'inflight');
  mkdirSync(dir, { recursive: true });
  const claim = readFileSync(join(ZOO, 'inflight-status', 'status.json'), 'utf8');
  for (let i = 0; i <= MEMBER_AUDIT_SCAN_LIMIT; i += 1) {
    writeFileSync(join(dir, `${String(i).padStart(4, '0')}.status.json`), claim, 'utf8');
  }
  const found = auditFor(root, t, 'inflight-status');
  assert.equal(found.severity, 'ok', found.detail);
  assert.match(found.detail, new RegExp(`${MEMBER_AUDIT_SCAN_LIMIT}-document scan bound was reached`));
});

// --- the two spawn-side marker logs ---

for (const [id, relPath] of [
  ['pending-relays', join('.fadeno', 'local', 'pending-relays.jsonl')],
  ['proxy-dispatches', join('.fadeno', 'local', 'proxy-dispatches.jsonl')],
] as const) {
  test(`audit: a usable ${id} row reads cleanly`, (t) => {
    const root = tempRepo(t);
    installFixture(root, relPath, id, 'current.jsonl');
    const found = auditFor(root, t, id);
    assert.equal(found.severity, 'ok', found.detail);
    assert.match(found.detail, /1 row\(s\)/);
  });

  test(`audit: a ${id} row its reader would silently skip is an error`, (t) => {
    const root = tempRepo(t);
    const abs = installFixture(root, relPath, id, 'malformed.jsonl');
    const found = auditFor(root, t, id);
    assert.equal(found.severity, 'error');
    assert.match(found.remediation ?? '', new RegExp(escapeRe(abs)));
    assert.match(found.remediation ?? '', repoBackups(root));
  });
}

test('audit: an old marker row is not a defect — a stale marker is one the reader correctly ignores', (t) => {
  const root = tempRepo(t);
  const abs = join(root, '.fadeno', 'local', 'pending-relays.jsonl');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '{"timestamp":"2020-01-01T00:00:00.000Z","prompt_sha256":"deadbeef"}\n', 'utf8');
  const found = auditFor(root, t, 'pending-relays');
  assert.equal(found.severity, 'ok', found.detail);
});

// --- bakeoff-records ---

test('audit: a record the scorecard would skip is an error naming the file and the reason', (t) => {
  const root = tempRepo(t);
  const abs = installFixture(root, join('.fadeno', 'bakeoffs', 'pair.md'), 'bakeoff-records', 'malformed.md');
  // The premise: the scorecard's own reader rejects it, and counts it silently.
  assert.equal(parseBakeoffFile(root, '.fadeno/bakeoffs/pair.md').valid, false);

  const found = auditFor(root, t, 'bakeoff-records');
  assert.equal(found.severity, 'error');
  assert.match(found.detail, /pair\.md/);
  assert.match(found.detail, /missing required sections/);
  assert.match(found.detail, /disappears from every tally/);
  assert.match(found.remediation ?? '', new RegExp(escapeRe(abs)));
  assert.match(found.remediation ?? '', repoBackups(root));
});

test('audit: a valid comparison record is ok and counted', (t) => {
  const root = tempRepo(t);
  installFixture(root, join('.fadeno', 'bakeoffs', 'pair.md'), 'bakeoff-records', 'valid.md');
  const found = auditFor(root, t, 'bakeoff-records');
  assert.equal(found.severity, 'ok', found.detail);
  assert.match(found.detail, /1 record\(s\)/);
});

// --- host-workspace-state: a STAMPED directory ---

test('audit: a malformed host workspace document is an error naming it and the repo backup dir', (t) => {
  const root = tempRepo(t);
  const abs = installFixture(root, join('.fadeno', 'local', 'host-workspaces', 'r', 'd.json'), 'host-workspace-state', 'malformed.json');
  const found = auditFor(root, t, 'host-workspace-state');
  assert.equal(found.severity, 'error');
  assert.match(found.detail, /r[\\/]d\.json/);
  assert.match(found.remediation ?? '', new RegExp(escapeRe(abs)));
  assert.match(found.remediation ?? '', repoBackups(root));
});

test('audit: a captured host workspace document reads through its own reader, and is counted', (t) => {
  const root = tempRepo(t);
  const run = '2026-09-05-1528-catalog-rot-doctor-checks-and-persisted';
  const id = 'hd-ac-run_workstreams-g1-workstream_1-a1';
  installFixture(root, join('.fadeno', 'local', 'host-workspaces', run, `${id}.json`), 'host-workspace-state', 'current.json');
  // The premise: this is a document the REAL reader accepts — captured from a
  // real isolated host dispatch, not written from memory of the shape.
  assert.equal(readHostWorkspaceState(root, run, id)?.schema_version, '1.0');

  const found = auditFor(root, t, 'host-workspace-state');
  assert.equal(found.severity, 'ok', found.detail);
  assert.match(found.detail, /holds 1 per-dispatch document\(s\)/);
  assert.match(found.detail, /schema_version 1\.0/);
});

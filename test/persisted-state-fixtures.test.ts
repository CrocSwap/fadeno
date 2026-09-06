import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DIALS_LOCAL_FILE, readLocalDialState, validateLocalDialDocument } from '../src/lib/executors.ts';
import { validateInstallationManifestDocument } from '../src/lib/installations.ts';
import { PERSISTED_SURFACES, shapeValidatorFor, unversionedReaderFor } from '../src/lib/persisted-state.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import {
  readUserDials,
  readVerifiedModels,
  userPaths,
  validateUserDialsDocument,
  validateVerificationDocument,
} from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * The fixture zoo: one captured sample per version of every surface that grew
 * a stamp in this change, loaded through the REAL reader.
 *
 * The v0 files were captured by running the writers as they shipped in 0.6.1,
 * BEFORE the stamp existed, and copying the bytes. That ordering is the whole
 * point — a v0 fixture hand-written after the fact only proves the author's
 * memory of the old shape, which is exactly the thing that drifts.
 */
const ZOO = join(import.meta.dirname, 'fixtures', 'persisted-state');

function fixture(surfaceId: string, version: number): string {
  return readFileSync(join(ZOO, surfaceId, `v${version}.json`), 'utf8');
}

/**
 * A document at the CURRENT version whose body the reader cannot use.
 *
 * The zoo's other half. A version sample proves tolerance across versions; a
 * malformed-current sample proves the audit does not mistake a stamp for a
 * schema — `{"schema_version": 1, "dials": []}` is current and yields nothing,
 * and the audit reported it healthy until this fixture existed.
 */
function malformedFixture(surfaceId: string, version: number | string | null): string {
  return readFileSync(join(ZOO, surfaceId, `malformed-v${version}.json`), 'utf8');
}

/** Surfaces that gained a stamp in this change and keep a captured legacy sample. */
const VERSIONED_SURFACES = ['dials', 'model-verifications', 'repo-dials-pin'];

/** Install a fixture into a hermetic user scope and read it back. */
function withUserFixture(t: TestContext, surfaceId: string, version: number, file: 'dials' | 'verifications') {
  const home = tempRepo(t);
  const options = {
    home,
    env: {
      FADENO_CONFIG_HOME: join(home, 'config'),
      FADENO_STATE_HOME: join(home, 'state'),
      FADENO_DATA_HOME: join(home, 'data'),
    },
  };
  const paths = userPaths(options);
  mkdirSync(paths.stateDir, { recursive: true });
  const target = file === 'dials' ? paths.dialsFile : paths.modelVerificationsFile;
  writeFileSync(target, fixture(surfaceId, version), 'utf8');
  return options;
}

test('zoo: every surface with version samples has a v0 and a current one', () => {
  for (const surface of PERSISTED_SURFACES) {
    const dir = join(ZOO, surface.id);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // Only the newly stamped surfaces keep version samples.
    }
    if (!entries.some((name) => /^v\d+\.json$/.test(name))) continue;
    assert.ok(entries.includes('v0.json'), `${surface.id} has no captured legacy sample`);
    assert.ok(
      entries.includes(`v${surface.currentVersion}.json`),
      `${surface.id} has no sample of its current version ${surface.currentVersion}`,
    );
  }
});

test('zoo: the three newly stamped surfaces each keep exactly the versions they have shipped', () => {
  for (const id of VERSIONED_SURFACES) {
    const versions = readdirSync(join(ZOO, id)).filter((name) => /^v\d+\.json$/.test(name)).sort();
    assert.deepEqual(versions, ['v0.json', 'v1.json'], `${id} zoo`);
  }
  const withVersions = readdirSync(ZOO)
    .filter((id) => readdirSync(join(ZOO, id)).some((name) => /^v\d+\.json$/.test(name)))
    .sort();
  assert.deepEqual(withVersions, VERSIONED_SURFACES, 'only the newly stamped surfaces keep version samples');
});

/**
 * The tripwire that makes the malformed half of the zoo mandatory: a surface
 * whose reader has a shape validator MUST have a captured
 * `malformed-v<current>` sample, or the validator is untested and the audit
 * can quietly go back to trusting the stamp.
 */
test('zoo: every surface with a shape validator keeps a malformed-current sample', () => {
  const expected: string[] = [];
  for (const surface of PERSISTED_SURFACES) {
    if (shapeValidatorFor(surface) == null) continue;
    expected.push(surface.id);
    assert.ok(
      readdirSync(join(ZOO, surface.id)).includes(`malformed-v${surface.currentVersion}.json`),
      `${surface.id} has a shape validator but no malformed-v${surface.currentVersion} sample`,
    );
  }
  assert.deepEqual(expected.sort(), ['dials', 'installations', 'model-verifications', 'repo-dials-pin']);
});

// --- malformed-current: the reader really does get nothing out of these ---

test('zoo: a v1 dials document whose `dials` is an array yields no dials at all', (t) => {
  const options = withUserFixture(t, 'dials', 1, 'dials');
  writeFileSync(userPaths(options).dialsFile, malformedFixture('dials', 1), 'utf8');
  assert.deepEqual(readUserDials(options), {}, 'the stamp says current; the reader gets nothing');
  assert.equal(validateUserDialsDocument(JSON.parse(malformedFixture('dials', 1)))?.severity, 'error');
});

test('zoo: a v1 verification cache with no `verifications` array yields no rows', (t) => {
  const options = withUserFixture(t, 'model-verifications', 1, 'verifications');
  writeFileSync(userPaths(options).modelVerificationsFile, malformedFixture('model-verifications', 1), 'utf8');
  assert.deepEqual(readVerifiedModels(options), []);
  assert.equal(validateVerificationDocument(JSON.parse(malformedFixture('model-verifications', 1)))?.severity, 'error');
});

test('zoo: a v1 repo pin that still carries a pre-0.6 `loadout` yields no dials', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), malformedFixture('repo-dials-pin', 1), 'utf8');
  const state = readLocalDialState(root);
  assert.deepEqual(state.dials, {});
  assert.match(state.legacyNote!, /pre-0\.6 loadout pin ignored/);
  assert.equal(validateLocalDialDocument(JSON.parse(malformedFixture('repo-dials-pin', 1)))?.severity, 'error');
});

test('zoo: a v1 installation manifest with no `harnesses` is refused by its reader', () => {
  const doc = JSON.parse(malformedFixture('installations', 1));
  const defect = validateInstallationManifestDocument(doc);
  assert.equal(defect?.severity, 'error');
  assert.match(defect!.detail, /no `harnesses` mapping/);
});

// --- dials.json ---

test('zoo: dials v0 (flat map) and v1 (stamped) read to the same dials', (t) => {
  const expected = {
    generator: { model: 'opus' },
    judge: { model: 'current-host' },
    reviewer: { model: 'sol', effort: 'high' },
    worker: { model: 'opus', harness: 'claude' },
  };
  assert.deepEqual(readUserDials(withUserFixture(t, 'dials', 0, 'dials')), expected);
  assert.deepEqual(readUserDials(withUserFixture(t, 'dials', 1, 'dials')), expected);
});

test('zoo: dials v0 is genuinely unstamped and v1 is genuinely stamped', () => {
  assert.equal(JSON.parse(fixture('dials', 0)).schema_version, undefined);
  assert.equal(JSON.parse(fixture('dials', 1)).schema_version, 1);
});

test('a v0 dials file whose archetype is literally named schema_version still reads as v0', (t) => {
  const options = withUserFixture(t, 'dials', 0, 'dials');
  const paths = userPaths(options);
  writeFileSync(paths.dialsFile, '{"schema_version":"sol","worker":"opus"}\n', 'utf8');
  assert.deepEqual(readUserDials(options), { schema_version: { model: 'sol' }, worker: { model: 'opus' } });
});

// --- model-verifications.json ---

test('zoo: verifications v0 (bare array) and v1 (stamped) read to the same entries', (t) => {
  const expected = [
    { harness: 'claude', model: 'opus', verified_at: '2026-06-01T00:00:00.000Z' },
    { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2026-09-01T00:00:00.000Z' },
  ];
  assert.deepEqual(readVerifiedModels(withUserFixture(t, 'model-verifications', 0, 'verifications')), expected);
  assert.deepEqual(readVerifiedModels(withUserFixture(t, 'model-verifications', 1, 'verifications')), expected);
});

test('zoo: verifications v0 is an array and v1 wraps that same array', () => {
  const v0 = JSON.parse(fixture('model-verifications', 0));
  const v1 = JSON.parse(fixture('model-verifications', 1));
  assert.ok(Array.isArray(v0));
  assert.equal(v1.schema_version, 1);
  assert.deepEqual(v1.verifications, v0);
});

// --- .fadeno/local/dials ---

test('zoo: the repo pin reads identically at v0 and v1', (t) => {
  const expected = {
    dials: { reviewer: { model: 'sol', effort: 'high', harness: 'codex' }, worker: { model: 'opus' } },
    shadows: { worker: { model: 'sol', harness: 'codex', rate: 0.5, n: 3, remaining: 2 } },
    legacyNote: null,
    legacyViaNote: null,
  };
  for (const version of [0, 1]) {
    const root = tempRepo(t);
    mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
    writeFileSync(join(root, DIALS_LOCAL_FILE), fixture('repo-dials-pin', version), 'utf8');
    assert.deepEqual(readLocalDialState(root), expected, `repo pin v${version}`);
  }
});

test('zoo: the repo pin refuses a stamp from the future rather than half-reading it', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"schema_version":7,"dials":{"worker":"sol"}}\n', 'utf8');
  assert.throws(() => readLocalDialState(root), /schema_version 7; this fadeno reads 1/);
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"schema_version":"1","dials":{}}\n', 'utf8');
  assert.throws(() => readLocalDialState(root), /not a non-negative integer/);
});

test('a user dials file from the future is refused, not silently emptied', (t) => {
  const options = withUserFixture(t, 'dials', 1, 'dials');
  const paths = userPaths(options);
  writeFileSync(paths.dialsFile, '{"schema_version":7,"dials":{"worker":"opus"}}\n', 'utf8');
  assert.throws(() => readUserDials(options), /schema_version 7; this fadeno reads 1/);
});

// --- the run ledger's second file ---

test('zoo: the captured event log reads its older rows and refuses only the damaged lines', (t) => {
  // `events.jsonl` has no stamp of its own, so its "versions" are shape drift:
  // lines 1-2 were captured from a 0.2-era run and predate `seq` entirely.
  // Immutable history stays readable, so the reader yields them unchanged and
  // only the two lines it cannot turn into an event at all are reported —
  // a truncated append (a writer that died mid-row) and a bare scalar.
  const root = tempRepo(t);
  const dir = join(root, '.fadeno', 'runs', '2026-01-01-0001-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'events.jsonl'),
    readFileSync(join(ZOO, 'run-ledger', 'malformed-events.jsonl'), 'utf8'),
    'utf8',
  );

  const { events, badLines } = readEvents(dir);
  assert.deepEqual(badLines, [4, 5]);
  assert.deepEqual(events.map((event) => event.type), ['run_started', 'step_started', 'run_started']);
  assert.deepEqual(events.map((event) => event.seq), [null, null, 1], 'pre-`seq` rows still read');
});

/**
 * The same tripwire for the surfaces the audit reads WITHOUT a stamp to lean
 * on: an unversioned surface with a real reader, and the one stamped surface
 * that is a directory of per-document state. Each keeps a good sample and a
 * malformed one, so "the reader accepts this" and "the reader refuses that"
 * are both asserted against captured bytes rather than a remembered shape.
 *
 * The `host-workspace-state` and `workspace-lease` samples were copied out of
 * this repo's own live machine-local state, and the `inflight-status` status
 * record out of a real supervisor exit — the same capture-first rule the v0
 * samples follow.
 */
test('zoo: every surface the audit reads through a real reader keeps a good and a malformed sample', () => {
  const expected: string[] = [];
  for (const surface of PERSISTED_SURFACES) {
    const stampedDirectory = surface.id === 'host-workspace-state';
    if (unversionedReaderFor(surface) == null && !stampedDirectory) continue;
    expected.push(surface.id);
    const entries = readdirSync(join(ZOO, surface.id));
    assert.ok(
      entries.some((name) => name.startsWith('malformed')),
      `${surface.id} is read through ${surface.reader} but keeps no malformed sample`,
    );
    assert.ok(
      entries.some((name) => !name.startsWith('malformed')),
      `${surface.id} keeps no sample its reader accepts`,
    );
  }
  assert.deepEqual(expected.sort(), [
    'bakeoff-records', 'host-workspace-state', 'inflight-status', 'pending-relays', 'proxy-dispatches', 'workspace-lease',
  ]);
});

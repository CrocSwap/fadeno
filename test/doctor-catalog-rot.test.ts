import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDoctor } from '../src/commands/doctor.ts';
import {
  VERIFICATION_MAX_AGE_DAYS,
  catalogRepairFindings,
  isVerificationStale,
  verificationFindings,
} from '../src/lib/catalog-rot.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4Doc, tempRepo } from './helpers.ts';

// Catalog rot: the two ways a working setup goes wrong with nothing failing.
//
// The user catalog is machine state, so `config-layers.ts` reads it
// tolerantly — `repairUserLayer` translates what it can and
// `dropUndeliverableUserModels` discards what it must, rather than letting one
// stale `fadeno model add` brick every unrelated command (the `ox` failure of
// 2026-09-05). Right, and silent: on the ordinary layering path nothing ever
// printed those notes, so a personal alias simply vanishes and the first
// symptom is a dial failing on a model the user is certain they added.
//
// The verification cache never expires. `isModelVerified` is existence-only,
// so a row written a year ago short-circuits the probe forever while the
// provider quietly retires the id.

// --- fixtures ---

function isolatedUser(t: TestContext, root: string): UserPathOptions {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

/** The user catalog `fadeno model add` writes — machine state, read tolerantly. */
function writeUserCatalog(root: string, doc: Record<string, unknown>): string {
  const dir = join(root, 'user-config', 'fadeno');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'executors.yaml');
  writeFileSync(path, stringifyYaml(doc), 'utf8');
  return path;
}

function writeProjectCatalog(root: string, doc: Record<string, unknown>): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc), 'utf8');
}

function writeVerifications(root: string, rows: unknown[]): void {
  const dir = join(root, 'user-state', 'fadeno');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model-verifications.json'), `${JSON.stringify(rows)}\n`, 'utf8');
}

/**
 * A timestamp `days` before the REAL clock. Correct only for tests that let
 * the code under test read the real clock too — the `runDoctor` cases below,
 * which write a verifications file and never pass a `now`.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * A timestamp `days` before a FROZEN `now`.
 *
 * A test that pins `now` must build its fixtures from that same `now`.
 * Mixing the two makes the fixture's age drift with wall-clock time, and the
 * drift is one-way: the gap between a frozen `now` and the real clock only
 * grows, so such a test does not flake — it passes until a threshold is
 * crossed and then fails forever. This is not hypothetical. Three fixtures
 * here used `daysAgo(VERIFICATION_MAX_AGE_DAYS + 1)` against a `now` frozen
 * at 2026-09-05T12:00:00Z; that pair stopped being stale at exactly
 * 2026-09-06T12:00:00Z, and a full-suite gate run three hours earlier was
 * accurate when it was taken and wrong by lunchtime.
 */
function daysBefore(base: Date, days: number): string {
  return new Date(base.getTime() - days * 86_400_000).toISOString();
}

/**
 * A catalog where exactly one harness can answer a model probe.
 *
 * `codex` declares `models_command`, `claude` does not — which is the
 * distinction the doctor check turns on, so both live in the same fixture and
 * one test can assert the carve-out without a second catalog.
 */
function probeCatalog(dials: Record<string, unknown>): Record<string, unknown> {
  return catalogV4Doc({
    models: {
      luna: { provider: 'openai', id: 'gpt-5.6-luna', effort: 'high' },
      quiet: { provider: 'anthropic', id: 'quiet-1' },
    },
    harnesses: {
      codex: {
        provider: 'openai',
        command: ['codex', 'exec', '--model', '{model}', '-'],
        models_command: ['codex', 'models'],
      },
      claude: { provider: 'anthropic', command: ['claude', '-p', '--model', '{model}'] },
    },
    dials,
  });
}

function checks(root: string, user: UserPathOptions, check: string) {
  return runDoctor({ repoRoot: root, userPathOptions: user }).findings.filter((f) => f.check === check);
}

// --- isVerificationStale ---

test('isVerificationStale separates "never verified" from "verified too long ago", and puts the boundary at exactly the threshold', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const at = (days: number) => ({ verified_at: new Date(now.getTime() - days * 86_400_000).toISOString() });

  assert.equal(isVerificationStale(null, now), 'missing');
  assert.equal(isVerificationStale(undefined, now), 'missing');
  // The two are not interchangeable: `missing` means the next dial will probe,
  // `stale` means the existence-only cache check stops it from probing.
  assert.equal(isVerificationStale(at(1), now), 'fresh');
  assert.equal(isVerificationStale(at(VERIFICATION_MAX_AGE_DAYS), now), 'fresh', 'exactly at the threshold still counts');
  assert.equal(isVerificationStale({ verified_at: new Date(now.getTime() - (VERIFICATION_MAX_AGE_DAYS * 86_400_000 + 1000)).toISOString() }, now), 'stale');
  assert.equal(isVerificationStale(at(365), now), 'stale');
});

test('isVerificationStale calls an unreadable timestamp stale, not missing, and never reports a clock that ran backwards', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  // The row is ON DISK. Calling it `missing` would claim the pair was never
  // verified while the file says otherwise; what it lost is its proof of age.
  assert.equal(isVerificationStale({ verified_at: 'yesterday' }, now), 'stale');
  assert.equal(isVerificationStale({ verified_at: '' }, now), 'stale');
  // A future row means a clock moved or someone hand-edited the file — neither
  // is evidence the model listing went stale.
  assert.equal(isVerificationStale({ verified_at: '2027-01-01T00:00:00.000Z' }, now), 'fresh');
});

test('isVerificationStale honours an explicit threshold', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const tenDaysOld = { verified_at: new Date(now.getTime() - 10 * 86_400_000).toISOString() };
  assert.equal(isVerificationStale(tenDaysOld, now), 'fresh');
  assert.equal(isVerificationStale(tenDaysOld, now, 7), 'stale');
});

// --- catalogRepairFindings ---

test('catalogRepairFindings emits one warning per loader note, keeps the loader wording, and names a command that exists', () => {
  const found = catalogRepairFindings({
    repairs: ['user catalog /u/executors.yaml: `routes` was removed in catalog v4 and was ignored'],
    drops: ['user-catalog model "ox" dropped — nothing in this catalog can deliver harness/provider "stealth"'],
  });

  assert.equal(found.length, 2);
  for (const item of found) {
    assert.equal(item.check, 'user-catalog-repairs');
    assert.equal(item.severity, 'warning');
  }
  // The loader's own sentence, verbatim — it already names the file and key,
  // and re-wrapping it in a category label would lose the path.
  assert.match(found[0]!.detail, /^user catalog \/u\/executors\.yaml:/);
  assert.match(found[1]!.detail, /"ox" dropped/);
  // Both halves name a command this build has: `fadeno models add` writes the
  // user catalog and `fadeno models remove` deletes an entry (dropping its
  // cached verification rows too). No `~/.config` path literal — that spelling
  // is only right on an XDG default, and the loader's note already carries the
  // real absolute path.
  assert.match(found[0]!.remediation!, /fadeno models add <alias> <provider\/id> --harness <h>/);
  assert.match(found[0]!.remediation!, /`fadeno models remove <alias>`/);
  assert.doesNotMatch(found[0]!.remediation!, /~\/\.config/);
});

test('catalogRepairFindings collapses a note the loader produced twice and drops empty ones', () => {
  const note = 'user-catalog model "ox" dropped — nothing in this catalog can deliver harness/provider "stealth"';
  // Both loader paths can push the same sentence; reported twice it reads as
  // two separate defects.
  const found = catalogRepairFindings({ repairs: [note, '  ', note], drops: [note, ''] });
  assert.equal(found.length, 1);
});

test('catalogRepairFindings says nothing about a clean catalog', () => {
  assert.deepEqual(catalogRepairFindings({ repairs: [], drops: [] }), []);
});

// --- verificationFindings ---

test('verificationFindings distinguishes a missing row from a stale one, and says why re-dialing alone fixes only the first', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const found = verificationFindings({
    dialed: [
      { archetype: 'worker', harness: 'codex', modelId: 'gpt-5.6-luna' },
      { archetype: 'judge', harness: 'claude', modelId: 'opus-4' },
    ],
    verifications: [
      { harness: 'claude', model: 'opus-4', verified_at: new Date(now.getTime() - 400 * 86_400_000).toISOString() },
    ],
    now,
    verifyCommand: '`fadeno models verify`',
  });

  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.check), ['model-verification-stale', 'model-verification-stale']);
  assert.deepEqual(found.map((f) => f.severity), ['warning', 'warning']);

  // Sorted by harness, so `claude` (stale) precedes `codex` (missing).
  const [stale, missing] = found as [typeof found[number], typeof found[number]];
  assert.match(stale.detail, /"opus-4" on claude/);
  assert.match(stale.detail, /400 days ago/);
  assert.match(stale.detail, new RegExp(`${VERIFICATION_MAX_AGE_DAYS}-day`));
  // The point of the split: an existing row short-circuits `fadeno dial`'s own
  // probe, so the stale remediation has to name the command that ignores the
  // cache and say plainly that re-dialing does not.
  assert.match(stale.remediation!, /EXISTENCE, not age/);
  assert.match(stale.remediation!, /Re-dialing alone will not/);
  assert.match(stale.remediation!, /`fadeno models verify` ignores the cache/);

  assert.match(missing.detail, /"gpt-5\.6-luna" on codex/);
  assert.match(missing.detail, /no row in the model-verification cache/);
  assert.match(missing.remediation!, /records a row/);
  assert.doesNotMatch(missing.remediation!, /Re-dialing alone/);
});

test('verificationFindings reports one unverified model, not one per archetype that dials it', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const found = verificationFindings({
    dialed: [
      { archetype: 'worker', harness: 'codex', modelId: 'gpt-5.6-luna' },
      { archetype: 'reviewer', harness: 'codex', modelId: 'gpt-5.6-luna' },
      { archetype: 'director', harness: 'codex', modelId: 'gpt-5.6-luna' },
    ],
    verifications: [],
    now,
    verifyCommand: 'verify',
  });

  assert.equal(found.length, 1, 'three archetypes on one model is one unverified model');
  // …and the finding still names every archetype it would affect, sorted.
  assert.match(found[0]!.detail, /dialed by director, reviewer, worker/);
});

test('verificationFindings is silent on a fresh row — this check exists to name rot, not to inventory the catalog', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const found = verificationFindings({
    dialed: [{ archetype: 'worker', harness: 'codex', modelId: 'gpt-5.6-luna' }],
    verifications: [
      { harness: 'codex', model: 'gpt-5.6-luna', verified_at: new Date(now.getTime() - 3 * 86_400_000).toISOString() },
    ],
    now,
    verifyCommand: 'verify',
  });
  assert.deepEqual(found, []);
});

test('verificationFindings keys on the harness as well as the model id — the cache does', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const found = verificationFindings({
    dialed: [{ archetype: 'worker', harness: 'opencode', modelId: 'gpt-5.6-luna' }],
    // Verified on `codex`, which says nothing about what `opencode` lists.
    verifications: [{ harness: 'codex', model: 'gpt-5.6-luna', verified_at: daysBefore(now, 1) }],
    now,
    verifyCommand: 'verify',
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!.detail, /on opencode/);
});

test('verificationFindings audits an unlistable pair and re-words the remediation instead of dropping it', () => {
  const now = new Date('2026-09-05T12:00:00.000Z');
  const unlistable = { archetype: 'judge', harness: 'claude', modelId: 'quiet-1', listable: false };

  // Missing: reported, with no command named — nothing can create the row.
  const missing = verificationFindings({ dialed: [unlistable], verifications: [], now, verifyCommand: '`v`' });
  assert.equal(missing.length, 1, 'an unprobeable pair is still an unverified pair');
  assert.match(missing[0]!.remediation!, /claude declares no `models_command`/);
  assert.match(missing[0]!.remediation!, /Nothing to run/);

  // Stale: reported, naming the cache file the row has to be deleted from.
  const stale = verificationFindings({
    dialed: [unlistable],
    verifications: [{ harness: 'claude', model: 'quiet-1', verified_at: daysBefore(now, VERIFICATION_MAX_AGE_DAYS + 1) }],
    now,
    verifyCommand: '`v`',
    verificationsPath: '/state/fadeno/model-verifications.json',
  });
  assert.equal(stale.length, 1);
  assert.match(stale[0]!.remediation!, /delete the claude\/quiet-1 entry from \/state\/fadeno\/model-verifications\.json/);

  // Without a path, the bare filename stands in rather than an empty gap.
  const noPath = verificationFindings({
    dialed: [unlistable],
    verifications: [{ harness: 'claude', model: 'quiet-1', verified_at: daysBefore(now, VERIFICATION_MAX_AGE_DAYS + 1) }],
    now,
    verifyCommand: '`v`',
  });
  assert.match(noPath[0]!.remediation!, /from model-verifications\.json/);

  // `listable` defaults to true, so a caller that omits it keeps the old,
  // command-naming wording.
  const listable = verificationFindings({
    dialed: [{ archetype: 'judge', harness: 'claude', modelId: 'quiet-1' }],
    verifications: [],
    now,
    verifyCommand: '`v`',
  });
  assert.match(listable[0]!.remediation!, /probes the harness for every dialed pair/);
});

// --- runDoctor wiring ---

test('doctor surfaces what the tolerant user-layer read discarded, which nothing else on the layering path ever printed', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  // No project catalog: the ordinary layering path, where `formatModelFallbackNote`
  // is never consulted and the drop was previously invisible.
  const catalogPath = writeUserCatalog(root, {
    schema_version: 4,
    // A v3 top-level key the loader translates rather than failing on.
    unregistered_model_driver: 'openai',
    // The `ox` shape: a provider no harness in the merged table claims home.
    models: { ox: { provider: 'stealth', id: 'ox-1' } },
  });

  const found = checks(root, user, 'user-catalog-repairs');
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.severity), ['warning', 'warning']);
  const translated = found.find((f) => f.detail.includes('unregistered_model_driver'));
  assert.ok(translated, 'the v3 key translation is reported');
  // The loader's note names the offending file, so the user can find it.
  assert.ok(translated!.detail.includes(catalogPath), 'the note names the user catalog path');
  const dropped = found.find((f) => f.detail.includes('"ox"'));
  assert.ok(dropped, 'the dropped alias is reported');
  assert.match(dropped!.detail, /nothing in this catalog can deliver harness\/provider "stealth"/);
  assert.match(dropped!.remediation!, /fadeno models add/);
});

test('doctor says nothing about a user catalog the loader did not have to touch', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeUserCatalog(root, { schema_version: 4, models: { mine: { provider: 'openai', id: 'gpt-5.6-mine' } } });

  assert.deepEqual(checks(root, user, 'user-catalog-repairs'), []);
});

test('doctor reports a dialed model with no verification row, and stays quiet once one is fresh', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeProjectCatalog(root, probeCatalog({ worker: 'luna', reviewer: 'luna' }));
  writeVerifications(root, []);

  const missing = checks(root, user, 'model-verification-stale');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.severity, 'warning');
  // The delivered id, not the alias — that is what the cache and the listing
  // are both keyed on.
  assert.match(missing[0]!.detail, /"gpt-5\.6-luna" on codex/);
  assert.match(missing[0]!.detail, /dialed by reviewer, worker/);

  writeVerifications(root, [{ harness: 'codex', model: 'gpt-5.6-luna', verified_at: daysAgo(2) }]);
  assert.deepEqual(checks(root, user, 'model-verification-stale'), []);

  // …and the same row, past the window, comes back as a warning that says the
  // cache will not re-probe while it is there.
  writeVerifications(root, [{ harness: 'codex', model: 'gpt-5.6-luna', verified_at: daysAgo(VERIFICATION_MAX_AGE_DAYS + 10) }]);
  const stale = checks(root, user, 'model-verification-stale');
  assert.equal(stale.length, 1);
  assert.match(stale[0]!.detail, /days ago/);
  assert.match(stale[0]!.remediation!, /EXISTENCE, not age/);
});

test('doctor audits a dial whose harness has no listing, and says plainly that nothing can re-probe it', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  // `quiet` resolves onto `claude`, which declares no `models_command`. The
  // pair is genuinely unverified — nothing has ever confirmed it and no
  // command can — so the audit reports it. Dropping it would be the doctor
  // silently declining to run a check it claims to run. What changes is the
  // REMEDIATION: it must not name a command that would report `skipped`.
  writeProjectCatalog(root, probeCatalog({ judge: 'quiet' }));
  writeVerifications(root, []);

  const missing = checks(root, user, 'model-verification-stale');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.severity, 'warning');
  assert.match(missing[0]!.detail, /"quiet-1" on claude \(dialed by judge\)/);
  assert.match(missing[0]!.remediation!, /claude declares no `models_command`/);
  assert.match(missing[0]!.remediation!, /`skipped`/);
  assert.match(missing[0]!.remediation!, /Nothing to run/);
  assert.doesNotMatch(missing[0]!.remediation!, /probes the harness for every dialed pair/);

  // A STALE row on the same unlistable harness: still reported, and the
  // remediation names the cache file, because deleting the row by hand is the
  // only thing that clears it.
  writeVerifications(root, [{ harness: 'claude', model: 'quiet-1', verified_at: daysAgo(VERIFICATION_MAX_AGE_DAYS + 10) }]);
  const stale = checks(root, user, 'model-verification-stale');
  assert.equal(stale.length, 1);
  assert.match(stale[0]!.detail, /days ago/);
  assert.match(stale[0]!.remediation!, /claude declares no `models_command`/);
  assert.match(stale[0]!.remediation!, /delete the claude\/quiet-1 entry from .*model-verifications\.json/);
  assert.doesNotMatch(stale[0]!.remediation!, /ignores the cache and always re-probes/);

  // …and a fresh row on an unlistable harness is still silence.
  writeVerifications(root, [{ harness: 'claude', model: 'quiet-1', verified_at: daysAgo(2) }]);
  assert.deepEqual(checks(root, user, 'model-verification-stale'), []);
});

test('doctor audits an archetype the CATALOG dials and no stored layer mentions', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  // `integrator` is not in ARCHETYPE_DISPLAY_ORDER and no session/repo/user
  // dial names it — it exists only in the catalog's own `dials:` mapping. A
  // dial set built from the stored layers alone never resolves it, so a custom
  // archetype's model could rot with the doctor reporting a clean bill.
  writeProjectCatalog(root, probeCatalog({ integrator: 'luna' }));
  writeVerifications(root, []);

  const found = checks(root, user, 'model-verification-stale');
  assert.equal(found.length, 1);
  assert.match(found[0]!.detail, /"gpt-5\.6-luna" on codex \(dialed by integrator\)/);
});

test('catalog rot never fails doctor — both checks are advisory', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeUserCatalog(root, { schema_version: 4, models: { ox: { provider: 'stealth', id: 'ox-1' } } });
  writeProjectCatalog(root, probeCatalog({ worker: 'luna' }));
  writeVerifications(root, []);

  const result = runDoctor({ repoRoot: root, userPathOptions: user });
  const rot = result.findings.filter((f) => f.check === 'user-catalog-repairs' || f.check === 'model-verification-stale');
  assert.ok(rot.length > 0, 'the fixture is rotten enough to be worth asserting on');
  assert.ok(rot.every((f) => f.severity === 'warning'));
  assert.equal(result.ok, true, 'warnings never turn into a failing exit status');
});

test('a catalog that will not load leaves doctor to its existing configuration error, not a rot crash', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), 'models: [not, a, mapping\n', 'utf8');

  const result = runDoctor({ repoRoot: root, userPathOptions: user });
  assert.deepEqual(checks(root, user, 'user-catalog-repairs'), []);
  assert.deepEqual(checks(root, user, 'model-verification-stale'), []);
  assert.ok(result.findings.some((f) => f.check === 'configuration' && f.severity === 'error'));
});

// --- integrator wiring: the two checks doctor gained a call site for ---

/**
 * A catalog whose listing is a real spawn, but a hermetic one.
 *
 * `--probe-models` is the only part of doctor that shells out, so the wiring
 * test has to exercise a genuine spawn rather than an injected fake — the seam
 * a fake would prove is `listHarnessModels`, which its own suite already
 * covers. `process.execPath` keeps that honest without depending on anything
 * on PATH.
 */
function listingCatalog(listed: string[], dials: Record<string, unknown>): Record<string, unknown> {
  return catalogV4Doc({
    models: { luna: { provider: 'openai', id: 'gpt-5.6-luna', effort: 'high' } },
    harnesses: {
      codex: {
        provider: 'openai',
        command: ['codex', 'exec', '--model', '{model}', '-'],
        models_command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(listed.join('\n'))})`],
      },
    },
    dials,
  });
}

test('the model-listing check is opt-in: without --probe-models doctor names the flag instead of spawning', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  // The listing would fail loudly if it ran — a command that does not exist.
  writeProjectCatalog(root, catalogV4Doc({
    models: { luna: { provider: 'openai', id: 'gpt-5.6-luna', effort: 'high' } },
    harnesses: {
      codex: {
        provider: 'openai',
        command: ['codex', 'exec', '--model', '{model}', '-'],
        models_command: ['fadeno-no-such-binary-ever'],
      },
    },
    dials: { worker: 'luna' },
  }));

  const findings = runDoctor({ repoRoot: root, userPathOptions: user }).findings;
  const skipped = findings.filter((f) => f.check === 'model-listing-skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.severity, 'ok');
  assert.match(skipped[0]!.remediation!, /--probe-models/);
  assert.deepEqual(findings.filter((f) => f.check.startsWith('model-listing-')).map((f) => f.check), ['model-listing-skipped']);
});

test('every default model-listing-skipped finding names the flag — including when nothing is probeable', (t) => {
  // Two branches reach `model-listing-skipped`, and the one where nothing is
  // listable used to omit the flag: naming a flag that would spawn nothing
  // read as noise. But the finding is the ONLY place the check announces
  // itself, so a reader who dials a listable harness tomorrow would never
  // learn `--probe-models` exists. The honest sentence stays in `detail`; the
  // flag moves into `remediation`, worded as what it would do here.
  const user = isolatedUser(t, tempRepo(t));
  const cases: Array<[string, Record<string, unknown>]> = [
    // `quiet` resolves onto claude, which declares no `models_command`.
    ['nothing probeable', probeCatalog({ judge: 'quiet' })],
    // `luna` resolves onto codex, which does.
    ['something probeable', probeCatalog({ worker: 'luna' })],
  ];
  for (const [label, catalog] of cases) {
    const root = tempRepo(t);
    writeProjectCatalog(root, catalog);
    const skipped = checks(root, user, 'model-listing-skipped');
    assert.equal(skipped.length, 1, label);
    assert.equal(skipped[0]!.severity, 'ok', label);
    assert.match(
      `${skipped[0]!.detail} ${skipped[0]!.remediation ?? ''}`,
      /`fadeno doctor --probe-models`/,
      `${label}: the skipped finding must name the flag that runs the check`,
    );
  }

  // …and the no-probeable branch still says plainly that there is nothing to
  // spawn, rather than promising a check that would find nothing.
  const root = tempRepo(t);
  writeProjectCatalog(root, probeCatalog({ judge: 'quiet' }));
  const quiet = checks(root, user, 'model-listing-skipped')[0]!;
  assert.match(quiet.detail, /no dialed model resolves onto a harness that declares a models_command/);
  assert.match(quiet.remediation!, /nothing to spawn until/);
});

test('--probe-models reports a dialed model the backend no longer lists, and is silent when it does', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);

  writeProjectCatalog(root, listingCatalog(['gpt-5.6-other'], { worker: 'luna' }));
  const missing = runDoctor({ repoRoot: root, userPathOptions: user, probeModels: true }).findings
    .filter((f) => f.check === 'model-listing-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.severity, 'warning');
  assert.match(missing[0]!.detail, /gpt-5\.6-luna/);

  writeProjectCatalog(root, listingCatalog(['gpt-5.6-luna', 'gpt-5.6-other'], { worker: 'luna' }));
  const listed = runDoctor({ repoRoot: root, userPathOptions: user, probeModels: true }).findings
    .filter((f) => f.check.startsWith('model-listing-'));
  assert.deepEqual(listed.map((f) => f.check), [], 'a model still in the listing is not rot, and not an ok line either');
});

test('the persisted-state audit runs on every doctor invocation, flag or not', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeProjectCatalog(root, probeCatalog({ worker: 'luna' }));

  const findings = runDoctor({ repoRoot: root, userPathOptions: user }).findings
    .filter((f) => f.check.startsWith('persisted-state:'));
  assert.ok(findings.length > 1, 'one finding per inventoried surface');
  // Doctor reports; only `fadeno setup` migrates. A hermetic user scope has
  // nothing on disk yet, so nothing may be reported as damaged.
  assert.deepEqual(findings.filter((f) => f.severity === 'error'), []);
});

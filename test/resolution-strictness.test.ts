import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DialError, runDialResolve, runDialShow } from '../src/commands/dial.ts';
import { SpawnError, resolveArchetype } from '../src/lib/spawn.ts';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import { ExecutorProfileError } from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * Resolution strictness under dials:
 * - malformed v3 pin is a hard error on every resolving path (resolve/dispatch/steering share the same message)
 * - legacy pin (bare string or {loadout, overrides}) is a graceful note: show surfaces it, resolution falls through to base
 * All calls pin the harness explicitly.
 */

const V3_BASE = {
  schema_version: 4,
  models: {
    sol: { provider: 'dummy', id: 'sol', effort: 'high' },
    grok: { provider: 'dummy', id: 'grok', effort: 'high' },
  },
  harnesses: { dummy: { provider: 'dummy', command: ['node', '-e', '0'] } },
  archetypes: {
    worker: { },
    reviewer: { },
  },
  dials: {
    worker: 'sol',
  },
};

const CANON_NOTE =
  'note: canon archetypes not declared by this catalog: <generator, worker> ' +
  '(self-contained profile suppresses builtin layering; declare them in .fadeno/executors.yaml to adopt)';

function isolatedUser(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

function harnessEnv(): UserPathOptions {
  return { env: { FADENO_HARNESS: 'standalone', FADENO_CONFIG_HOME: process.env.FADENO_CONFIG_HOME, FADENO_STATE_HOME: process.env.FADENO_STATE_HOME, FADENO_DATA_HOME: process.env.FADENO_DATA_HOME } } as any;
}

function seedProject(t: TestContext, doc: Record<string, unknown> = V3_BASE): { root: string; paths: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return { root, paths: isolatedUser(root) };
}

function writeMalformedPin(root: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // malformed v3: unknown top-level key (strict), dials are valid so error is the unknown key
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ dials: { worker: 'sol' }, unknown: true }) + '\n');
}

function writeLegacyPin(root: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // legacy bare string (pre-0.6)
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), 'ghost-loadout\n');
}

function writeLegacyJsonPin(root: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ loadout: 'main', overrides: { worker: 'over' } }) + '\n');
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

test('dial resolve: a malformed v3 pin throws the same message dispatch would', (t) => {
  const { root, paths } = seedProject(t);
  writeMalformedPin(root);
  const resolveErr = thrownMessage(() => runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'worker' }));
  const dispatchErr = thrownMessage(() => resolveArchetype({ archetype: 'worker', repoRoot: root, userPathOptions: paths }));
  // Both strict paths share the exact local pin error (fix hint included)
  assert.match(resolveErr, /has unknown key/);
  assert.equal(dispatchErr, resolveErr);
  assert.throws(() => runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'worker' }), (err: unknown) => err instanceof DialError && err.message === resolveErr);
  assert.throws(() => resolveArchetype({ archetype: 'worker', repoRoot: root, userPathOptions: paths }), (err: unknown) => err instanceof SpawnError && /has unknown key/.test((err as Error).message));
});


test('a pin file this fadeno cannot read stops every reader of it, in one voice', (t) => {
  // Both shapes a pre-0.7 checkout can be holding: the bare loadout name, and
  // the JSON one. Neither is readable as dials, and the danger is not the
  // error — it is the alternative, where `dial` prints a table and `dispatch`
  // routes work with the user's dials silently missing.
  for (const write of [writeLegacyPin, writeLegacyJsonPin]) {
    const { root, paths } = seedProject(t, V3_BASE);
    write(root);
    const fix = /\.fadeno\/local\/dials .*Fix: delete it/s;
    assert.throws(() => runDialShow({ repoRoot: root, userPathOptions: paths }), fix);
    assert.throws(() => runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'worker' }), fix);
    assert.throws(() => resolveArchetype({ archetype: 'worker', repoRoot: root, userPathOptions: paths }), fix);
  }
});

test('suppressedCanonArchetypes: computed only when a self-contained project suppresses layering', (t) => {
  const onlyProject = seedProject(t, { ...V3_BASE, archetypes: {} });
  assert.deepEqual(loadLayeredProfile(onlyProject.root, onlyProject.paths).layers, ['project']);
  // Project suppresses builtin layering when self-contained; canon set includes worker etc.
  const suppressed = loadLayeredProfile(onlyProject.root, onlyProject.paths).suppressedCanonArchetypes;
  assert.ok(suppressed.includes('scout'));
  assert.ok(suppressed.includes('worker'));

  const withWorker = seedProject(t, { ...V3_BASE, archetypes: { worker: { } } });
  const suppressed2 = loadLayeredProfile(withWorker.root, withWorker.paths).suppressedCanonArchetypes;
  assert.ok(!suppressed2.includes('worker'));

  const layered = tempRepo(t);
  mkdirSync(join(layered, '.fadeno'), { recursive: true });
  const layeredPaths = isolatedUser(layered);
  // No project catalog => layers includes builtin, not suppressed
  assert.ok(loadLayeredProfile(layered, layeredPaths).layers.includes('builtin'));
  assert.deepEqual(loadLayeredProfile(layered, layeredPaths).suppressedCanonArchetypes, []);
});

test('dial show: render the canon note on the effective view', (t) => {
  const { root, paths } = seedProject(t, { ...V3_BASE, archetypes: {} });
  const shown = runDialShow({ repoRoot: root, userPathOptions: paths });
  assert.match(shown.note ?? '', /canon archetypes not declared/);

  const layered = tempRepo(t);
  mkdirSync(join(layered, '.fadeno'), { recursive: true });
  const layeredPaths = isolatedUser(layered);
  const open = runDialShow({ repoRoot: layered, userPathOptions: layeredPaths });
  assert.deepEqual(open.suppressed_canon_archetypes, []);
  assert.equal(open.note, null);
});

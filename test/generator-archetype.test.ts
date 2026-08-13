import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { LoadoutError, runLoadoutSet } from '../src/commands/loadout.ts';
import {
  ExecutorProfileError,
  explainWriteConflict,
  LOADOUT_LOCAL_FILE,
  parseExecutorProfile,
  resolveRole,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

/**
 * Starter-catalog `generator` — the fourth canon — plus the parse / resolve /
 * conflict / dial contracts it depends on.
 */

const STARTER = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml');

const EXECUTORS = {
  rw: { adapter: 'command', command: ['codex', 'exec', '-'], model: 'luna', write_access: true },
  ro: { adapter: 'command', command: ['claude', '-p'], model: 'opus', write_access: false },
};

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

function parseStarter(): ExecutorProfile {
  return parseExecutorProfile(readFileSync(STARTER, 'utf8'), 'templates/common/fadeno/executors.yaml', 'standalone');
}

function seedProfile(t: TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

test('starter catalog: parses; generator is forbidden→worker, worker is required', () => {
  const profile = parseStarter();
  assert.deepEqual(profile.archetypes.generator, { requiresWrite: 'forbidden', fallback: 'worker' });
  assert.deepEqual(profile.archetypes.worker, { requiresWrite: 'required', fallback: null });
});

test('starter catalog: a generator-shaped role binds the worker slot via the fallback chain', () => {
  const profile = parseStarter();
  const native = resolveRole('prover', 'generator', profile, 'native');
  assert.equal(native.executorName, 'current-host');
  assert.equal(native.source, 'loadout');
  assert.equal(native.resolvedVia, 'worker');

  const luna = resolveRole('prover', 'generator', profile, 'luna');
  assert.equal(luna.executorName, 'luna-medium');
  assert.equal(luna.source, 'loadout');
  assert.equal(luna.resolvedVia, 'worker');
});

test('explainWriteConflict: generator is refused on a write-capable command route', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: { main: { worker: 'rw' } },
    archetypes: {
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      worker: { requires_write: 'required' },
    },
  });
  const conflict = explainWriteConflict(
    { executor: 'rw', spec: profile.executors.rw! },
    'generator',
    profile,
  );
  assert.ok(conflict != null);
  assert.match(conflict, /archetype "generator" declares `requires_write: forbidden`, but executor "rw"/);
  assert.match(conflict, /`write_access: true`/);
  // Bindings-only: the fallback does not import worker's `required` posture,
  // so generator on a read-only route is unconstrained.
  assert.equal(
    explainWriteConflict({ executor: 'ro', spec: profile.executors.ro! }, 'generator', profile),
    null,
  );
});

test('loadout set: refuses dialing generator onto a write-capable command executor', (t) => {
  const root = seedProfile(t, {
    executors: {
      'rw-cmd': { adapter: 'command', command: ['codex', 'exec', '-'], model: 'luna', write_access: true },
      'ro-cmd': { adapter: 'command', command: ['claude', '-p'], model: 'opus', write_access: false },
    },
    archetypes: {
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      worker: { requires_write: 'required' },
    },
    loadouts: { main: { worker: 'rw-cmd', reviewer: 'ro-cmd' } },
    default_loadout: 'main',
  });

  assert.throws(
    () => runLoadoutSet({ repoRoot: root, env: null, archetype: 'generator', target: 'rw-cmd' }),
    (err: unknown) =>
      err instanceof LoadoutError &&
      /archetype "generator" declares `requires_write: forbidden`, but executor "rw-cmd"/.test(err.message) &&
      /`write_access: true`/.test(err.message),
  );
  assert.equal(existsSync(join(root, LOADOUT_LOCAL_FILE)), false);
});

test('repo-declared scout with fallback: reviewer resolves via the reviewer slot', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: { main: { worker: 'rw', reviewer: 'ro' } },
    archetypes: { scout: { fallback: 'reviewer' } },
  });
  const resolved = resolveRole('explorer', 'scout', profile, 'main');
  assert.equal(resolved.executorName, 'ro');
  assert.equal(resolved.source, 'loadout');
  assert.equal(resolved.resolvedVia, 'reviewer');
});

test('archetypes: a fallback cycle is refused at parse', () => {
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: { main: { worker: 'rw' } },
      archetypes: {
        scout: { fallback: 'reviewer' },
        reviewer: { fallback: 'scout' },
      },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /archetype fallback cycle: scout → reviewer → scout/.test(err.message),
  );
});

test('archetypes: boolean aliases parse to required/none', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: { main: { worker: 'rw' } },
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
  });
  assert.deepEqual(profile.archetypes.worker, { requiresWrite: 'required', fallback: null });
  assert.deepEqual(profile.archetypes.reviewer, { requiresWrite: 'none', fallback: null });
});

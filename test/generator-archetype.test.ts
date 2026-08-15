import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DialError, runDialSet } from '../src/commands/dial.ts';
import {
  ExecutorProfileError,
  compileDialRef,
  explainWriteConflict,
  DIALS_LOCAL_FILE,
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

const HARNESS = 'standalone';
const harnessOpts = { env: { FADENO_HARNESS: HARNESS } } as const;

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml', HARNESS as any);
}

function parseStarter(): ExecutorProfile {
  return parseExecutorProfile(readFileSync(STARTER, 'utf8'), 'templates/common/fadeno/executors.yaml', HARNESS as any);
}

function seedProfile(t: TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

test('starter catalog: parses; generator is forbidden→worker, worker is required', () => {
  const profile = parseStarter();
  assert.deepEqual(profile.archetypes.generator, { requiresWrite: 'forbidden', fallback: 'worker', distinctProviderFromInputs: null });
  assert.deepEqual(profile.archetypes.worker, { requiresWrite: 'required', fallback: null, distinctProviderFromInputs: null });
});

test('starter catalog: a generator-shaped role binds the worker slot via the fallback chain', () => {
  const profile = parseStarter();
  const baseLayers = { session: {}, repo: {}, user: {} };
  const native = resolveRole('prover', 'generator', profile, baseLayers as any);
  assert.equal(native.delivery.model, 'current-host');
  assert.equal(native.source, 'base');
  assert.equal(native.resolvedVia, null);

  // Dial worker to luna via repo pin -> generator falls back to worker's luna
  const lunaLayers = { session: {}, repo: { worker: { model: 'luna' } }, user: {} };
  const luna = resolveRole('prover', 'generator', profile, lunaLayers as any);
  assert.equal(luna.delivery.model, 'luna');
  assert.equal(luna.source, 'repo');
  assert.equal(luna.resolvedVia, 'worker');
});

test('explainWriteConflict: generator is refused on a write-capable command route', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: {
      'rw-model': { provider: 'openai', id: 'rw-model' },
      'ro-model': { provider: 'anthropic', id: 'ro-model' },
    },
    routes: {
      standalone: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
      codex: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
      claude: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
    },
    archetypes: {
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      worker: { requires_write: 'required' },
    },
  });
  const rwCompiled = compileDialRef({ model: 'rw-model' }, profile);
  const roCompiled = compileDialRef({ model: 'ro-model' }, profile);
  const conflict = explainWriteConflict(
    { executor: rwCompiled.refString, spec: rwCompiled.spec },
    'generator',
    profile,
  );
  assert.ok(conflict != null);
  assert.match(conflict, /archetype "generator" declares `requires_write: forbidden`, but executor "rw-model"/);
  assert.match(conflict, /`write_access: true`/);
  // Bindings-only: the fallback does not import worker's `required` posture,
  // so generator on a read-only route is unconstrained.
  assert.equal(
    explainWriteConflict({ executor: roCompiled.refString, spec: roCompiled.spec }, 'generator', profile),
    null,
  );
});

test('loadout set: refuses dialing generator onto a write-capable command executor', (t) => {
  const root = seedProfile(t, {
    schema_version: 3,
    models: {
      'rw-model': { provider: 'openai', id: 'rw-model' },
      'ro-model': { provider: 'anthropic', id: 'ro-model' },
    },
    routes: {
      standalone: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
      codex: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
      claude: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
    },
    archetypes: {
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      worker: { requires_write: 'required' },
    },
  });

  assert.throws(
    () => runDialSet({ repoRoot: root, archetype: 'generator', model: 'rw-model', userPathOptions: harnessOpts }),
    (err: unknown) =>
      err instanceof DialError &&
      /archetype "generator" declares `requires_write: forbidden`, but executor "rw-model"/.test((err as Error).message) &&
      /`write_access: true`/.test((err as Error).message),
  );
  assert.equal(existsSync(join(root, DIALS_LOCAL_FILE)), false);
});

test('repo-declared scout with fallback: reviewer resolves via the reviewer slot through dial cascade', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: {
      'rw-model': { provider: 'openai', id: 'rw-model' },
      'ro-model': { provider: 'anthropic', id: 'ro-model' },
    },
    routes: {
      standalone: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
      codex: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
      claude: {
        openai: { command: ['codex', 'exec', '-'], write_access: true },
        anthropic: { command: ['claude', '-p'], write_access: false },
      },
    },
    archetypes: { scout: { fallback: 'reviewer' }, reviewer: {} },
    dials: { reviewer: 'ro-model' },
  });
  // also need to handle repo layers for resolveRole; repo layer contains the dial
  const layers = { session: {}, repo: { reviewer: { model: 'ro-model' } }, user: {} };
  const resolved = resolveRole('explorer', 'scout', profile, layers as any);
  assert.equal(resolved.delivery.model, 'ro-model');
  assert.equal(resolved.source, 'repo');
  assert.equal(resolved.resolvedVia, 'reviewer');
});

test('archetypes: a fallback cycle is refused at parse', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { 'rw-model': { provider: 'openai', id: 'rw-model' } },
      routes: { standalone: { openai: { command: ['node', '-e', "process.stdout.write('x')"], write_access: true } } },
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
    schema_version: 3,
    models: { 'rw-model': { provider: 'openai', id: 'rw-model' } },
    routes: { standalone: { openai: { command: ['node', '-e', "process.stdout.write('x')"], write_access: true } } },
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
  });
  assert.deepEqual(profile.archetypes.worker, { requiresWrite: 'required', fallback: null, distinctProviderFromInputs: null });
  assert.deepEqual(profile.archetypes.reviewer, { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null });
});

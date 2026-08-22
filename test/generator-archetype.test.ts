import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DialError, runDialSet } from '../src/commands/dial.ts';
import {
  ExecutorProfileError,
  compileDialRef,
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

test('starter catalog: generator stands alone — no fallback, and no policy left to carry', () => {
  // Both stay LISTED with empty policy: their only key was a write posture,
  // but membership in this map is itself meaningful — it is the canon set a
  // self-contained project is measured against. What they no longer carry is
  // any permission claim.
  const profile = parseStarter();
  assert.deepEqual(profile.archetypes.generator, { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null });
  assert.deepEqual(profile.archetypes.worker, { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null });
  assert.doesNotMatch(JSON.stringify(profile.archetypes), /requiresWrite/);
});

test('starter catalog: an undialed generator resolves to the host-native base, never through worker', () => {
  const profile = parseStarter();
  const baseLayers = { session: {}, repo: {}, user: {} };
  const native = resolveRole('prover', 'generator', profile, baseLayers as any);
  assert.equal(native.delivery.model, 'current-host');
  assert.equal(native.source, 'base');
  assert.equal(native.resolvedVia, null);

  // A worker dial no longer leaks into generator: it stays on base.
  const lunaLayers = { session: {}, repo: { worker: { model: 'luna' } }, user: {} };
  const stillBase = resolveRole('prover', 'generator', profile, lunaLayers as any);
  assert.equal(stillBase.delivery.model, 'current-host');
  assert.equal(stillBase.source, 'base');
  assert.equal(stillBase.resolvedVia, null);

  // Its own dial works like any archetype's.
  const own = resolveRole('prover', 'generator', profile, { session: {}, repo: {}, user: { generator: { model: 'luna' } } } as any);
  assert.equal(own.delivery.model, 'luna');
  assert.equal(own.source, 'user');
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
        openai: { command: ['codex', 'exec', '-'], },
        anthropic: { command: ['claude', '-p'], },
      },
      codex: {
        openai: { command: ['codex', 'exec', '-'], },
        anthropic: { command: ['claude', '-p'], },
      },
      claude: {
        openai: { command: ['codex', 'exec', '-'], },
        anthropic: { command: ['claude', '-p'], },
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
      routes: { standalone: { openai: { command: ['node', '-e', "process.stdout.write('x')"], } } },
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
    routes: { standalone: { openai: { command: ['node', '-e', "process.stdout.write('x')"], } } },
    archetypes: { worker: { }, reviewer: { } },
  });
  assert.deepEqual(profile.archetypes.worker, { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null });
  assert.deepEqual(profile.archetypes.reviewer, { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null });
});

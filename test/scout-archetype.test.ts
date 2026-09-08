import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DialError, runDialSet } from '../src/commands/dial.ts';
import {
  ExecutorProfileError,
  resolveDelivery,
  DIALS_LOCAL_FILE,
  parseExecutorProfile,
  resolveRole,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

/**
 * Starter-catalog `scout` — the fourth canon — plus the parse / resolve /
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

test('starter catalog: scout stands alone — no fallback, and carries only its description', () => {
  // Both stay LISTED with empty policy: their only key was a write posture,
  // but membership in this map is itself meaningful — it is the canon set a
  // self-contained project is measured against. What they no longer carry is
  // any permission claim.
  const profile = parseStarter();
  assert.equal(profile.archetypes.scout?.fallback, null);
  assert.match(profile.archetypes.scout?.description ?? '', /Explores and reports/);
  assert.equal(profile.archetypes.worker?.fallback, null);
  assert.match(profile.archetypes.worker?.description ?? '', /Implements a described change/);
  assert.doesNotMatch(JSON.stringify(profile.archetypes), /requiresWrite/);
});

test('starter catalog: an undialed scout resolves to the host-native base, never through worker', () => {
  const profile = parseStarter();
  const baseLayers = { session: {}, repo: {}, user: {} };
  const native = resolveRole('prover', 'scout', profile, baseLayers as any);
  assert.equal(native.delivery.model, 'host');
  assert.equal(native.source, 'base');
  assert.equal(native.resolvedVia, null);

  // A worker dial no longer leaks into scout: it stays on base.
  const lunaLayers = { session: {}, repo: { worker: { model: 'luna' } }, user: {} };
  const stillBase = resolveRole('prover', 'scout', profile, lunaLayers as any);
  assert.equal(stillBase.delivery.model, 'host');
  assert.equal(stillBase.source, 'base');
  assert.equal(stillBase.resolvedVia, null);

  // Its own dial works like any archetype's.
  const own = resolveRole('prover', 'scout', profile, { session: {}, repo: {}, user: { scout: { model: 'luna' } } } as any);
  assert.equal(own.delivery.model, 'luna');
  assert.equal(own.source, 'user');
});



test('repo-declared scout with fallback: reviewer resolves via the reviewer slot through dial cascade', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: {
      'rw-model': { provider: 'openai', id: 'rw-model' },
      'ro-model': { provider: 'anthropic', id: 'ro-model' },
    },
    harnesses: { codex: { provider: 'openai', command: ['codex', 'exec', '-'] }, claude: { provider: 'anthropic', command: ['claude', '-p'] } },
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
      schema_version: 4,
      models: { 'rw-model': { provider: 'openai', id: 'rw-model' } },
      harnesses: { codex: { provider: 'openai', command: ['node', '-e', 'process.stdout.write(\'x\')'] } },
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

test('an archetype entry carries only what a catalog can say about it', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { 'rw-model': { provider: 'openai', id: 'rw-model' } },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', 'process.stdout.write(\'x\')'] } },
    archetypes: { worker: { }, reviewer: { } },
  });
  assert.deepEqual(profile.archetypes.worker, { fallback: null, description: null });
  assert.deepEqual(profile.archetypes.reviewer, { fallback: null, description: null });
});

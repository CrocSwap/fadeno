import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runTargets } from '../src/commands/targets.ts';
import { tempRepo } from './helpers.ts';

/**
 * `fadeno targets`. `loadout list` answers "what runs for this archetype",
 * which left a target no loadout references completely invisible — the only
 * way to find one was reading executors.yaml or misspelling a name and reading
 * the error's candidate list. The two drivers added 2026-08-13 ship with no
 * loadout by design, so that gap was about to become the normal case.
 */

function seed(t: TestContext, doc: unknown): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

const CATALOG = {
  schema_version: 2,
  targets: {
    'in-session': { provider: 'anthropic', model: 'opus', reasoning_effort: 'high' },
    'driven': { provider: 'google', model: 'gemini-3.1-pro-high', reasoning_effort: 'high' },
    'undialed': { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', reasoning_effort: 'high' },
  },
  routes: {
    claude: {
      anthropic: { host: true, command: ['claude', '-p', '--model', '{model}'], write_access: false },
      google: { command: ['agy', '--model', '{model}', '--new-project'], write_access: true },
      openrouter: { command: ['opencode', 'run', '-m', 'openrouter/{model}'], write_access: true },
    },
    codex: {
      anthropic: { command: ['claude', '-p', '--model', '{model}'], write_access: false },
      google: { command: ['agy', '--model', '{model}', '--new-project'], write_access: true },
      openrouter: { command: ['opencode', 'run', '-m', 'openrouter/{model}'], write_access: true },
    },
  },
  loadouts: { main: { worker: 'driven', reviewer: 'in-session' } },
  default_loadout: 'main',
};

test('a target bound to no loadout is still listed', (t) => {
  const root = seed(t, CATALOG);
  const result = runTargets({ repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'claude' } } });

  const undialed = result.targets.find((target) => target.name === 'undialed');
  assert.ok(undialed, 'a declared target vanished because nothing dialed it');
  assert.deepEqual(undialed.loadouts, []);
  assert.deepEqual(undialed.bindings, []);
  // Sorted by name, so the listing is stable across runs and diffable.
  assert.deepEqual(result.targets.map((target) => target.name), ['driven', 'in-session', 'undialed']);
});

test('each row names the driver binary it would spawn', (t) => {
  const root = seed(t, CATALOG);
  const result = runTargets({ repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'claude' } } });
  const byName = new Map(result.targets.map((target) => [target.name, target]));

  assert.equal(byName.get('driven')?.adapter, 'command');
  assert.equal(byName.get('driven')?.driver, 'agy');
  assert.equal(byName.get('undialed')?.driver, 'opencode');
  // A host slot spawns nothing, so it must not invent a binary — the fallback
  // command exists but is not what delivers this row.
  assert.equal(byName.get('in-session')?.adapter, 'host');
  assert.equal(byName.get('in-session')?.driver, null);
});

test('delivery is resolved against the active host, so one target reads differently per harness', (t) => {
  const root = seed(t, CATALOG);
  const onClaude = runTargets({ repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'claude' } } });
  const onCodex = runTargets({ repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'codex' } } });

  assert.equal(onClaude.harness, 'claude');
  assert.equal(onCodex.harness, 'codex');
  // The host/driver distinction, per row: the same anthropic target is an
  // in-session slot on its own harness and a spawned subprocess elsewhere.
  assert.equal(onClaude.targets.find((t2) => t2.name === 'in-session')?.adapter, 'host');
  assert.equal(onCodex.targets.find((t2) => t2.name === 'in-session')?.adapter, 'command');
  assert.equal(onCodex.targets.find((t2) => t2.name === 'in-session')?.driver, 'claude');
  // A driver never flips: it is a subprocess under every host.
  for (const result of [onClaude, onCodex]) {
    assert.equal(result.targets.find((t2) => t2.name === 'driven')?.adapter, 'command');
  }
});

test('the loadouts that dial a target are reported, including wildcard bindings', (t) => {
  const root = seed(t, {
    ...CATALOG,
    loadouts: { main: { worker: 'driven' }, spare: { worker: 'driven', judge: 'in-session' } },
    default_loadout: 'main',
    bindings: { '*': 'in-session' },
  });
  const result = runTargets({ repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'claude' } } });
  const byName = new Map(result.targets.map((target) => [target.name, target]));

  assert.deepEqual(byName.get('driven')?.loadouts, ['main', 'spare']);
  assert.deepEqual(byName.get('in-session')?.loadouts, ['spare']);
  assert.deepEqual(byName.get('in-session')?.bindings, ['*']);
});

test('only non-eligible archetypes are reported, so an unrestricted target stays quiet', (t) => {
  const root = seed(t, {
    ...CATALOG,
    targets: {
      ...CATALOG.targets,
      driven: {
        provider: 'google',
        model: 'gemini-3.1-pro-high',
        eligibility: { worker: 'forbidden', reviewer: 'shadow_only', judge: 'eligible' },
      },
    },
  });
  const result = runTargets({ repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'claude' } } });
  const byName = new Map(result.targets.map((target) => [target.name, target]));

  // `eligible` is the default and says nothing; listing it would bury the two
  // states that actually constrain a dial.
  assert.deepEqual(byName.get('driven')?.restricted, { worker: 'forbidden', reviewer: 'shadow_only' });
  assert.deepEqual(byName.get('undialed')?.restricted, {});
});

test('write access is reported as declared, including undeclared', (t) => {
  const root = seed(t, CATALOG);
  const result = runTargets({ repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'codex' } } });
  const byName = new Map(result.targets.map((target) => [target.name, target]));

  assert.equal(byName.get('in-session')?.writeAccess, false);
  assert.equal(byName.get('driven')?.writeAccess, true);
});

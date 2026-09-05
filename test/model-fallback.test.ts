import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDialResolve, runDialShow } from '../src/commands/dial.ts';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import { catalogV4Doc, tempRepo } from './helpers.ts';

// A self-contained project catalog: models + harnesses both declared, which
// is what flips `projectIsComplete` and historically suppressed the user layer
// wholesale. The per-key user-model fallback is the one carve-out.
const V4_BASE = catalogV4Doc({
  models: {
    sol: { provider: 'dummy', id: 'sol', effort: 'high' },
  },
  harnesses: { dummy: { provider: 'dummy', command: ['node', '-e', '0'] } },
  archetypes: { worker: {} },
  dials: { worker: 'sol' },
});

function isolatedPaths(root: string) {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
    },
  } as const;
}

function seedRepo(t: TestContext, doc: Record<string, unknown>, userModels?: Record<string, unknown>): { root: string; paths: ReturnType<typeof isolatedPaths> } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  if (userModels != null) {
    mkdirSync(join(root, 'user-config', 'fadeno'), { recursive: true });
    writeFileSync(join(root, 'user-config', 'fadeno', 'executors.yaml'), stringifyYaml({ schema_version: 4, models: userModels }));
  }
  return { root, paths: isolatedPaths(root) };
}

test('user-catalog alias falls back into a self-contained project catalog when its harness resolves', (t) => {
  const { root, paths } = seedRepo(t, V4_BASE, {
    ox: { provider: 'stealth', id: 'ox-alpha', effort: 'default', harness: 'dummy', spellings: { dummy: 'stealth/ox-alpha' } },
  });
  const loaded = loadLayeredProfile(root, paths);
  assert.ok(loaded.selfContained);
  assert.deepEqual(loaded.modelFallback.promoted, ['ox']);
  assert.deepEqual(loaded.modelFallback.dropped, []);
  // Promoted means compiled like a project-declared model: full delivery id,
  // not the bare alias passed through the unregistered path.
  assert.equal(loaded.profile.models['ox']?.id, 'ox-alpha');
});

test('a promoted alias resolves with its delivery id and names its origin', (t) => {
  const { root, paths } = seedRepo(t, { ...V4_BASE, dials: {} }, {
    ox: { provider: 'stealth', id: 'ox-alpha', effort: 'default', harness: 'dummy', spellings: { dummy: 'stealth/ox-alpha' } },
  });
  mkdirSync(join(root, 'user-state', 'fadeno'), { recursive: true });
  writeFileSync(join(root, 'user-state', 'fadeno', 'dials.json'), JSON.stringify({ worker: { model: 'ox' } }));
  const resolved = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'worker' });
  // The whole point: stealth/ox-alpha reaches the executor, not bare "ox".
  assert.equal(resolved.model, 'ox');
  assert.equal(resolved.model_id, 'stealth/ox-alpha');
  assert.deepEqual(resolved.model_fallback?.promoted_from_user, true);
  assert.match(resolved.model_fallback?.note ?? '', /promoted into this self-contained catalog: ox/);
});

test('an alias nothing in the merged harness table can deliver drops loudly instead of merging broken', (t) => {
  const { root, paths } = seedRepo(t, V4_BASE, {
    ghosty: { provider: 'ghost', id: 'ghost-1', effort: 'default' },
  });
  const loaded = loadLayeredProfile(root, paths);
  assert.deepEqual(loaded.modelFallback.promoted, []);
  // No harness claims `ghost` as home, and the entry names none, so promoting
  // it would only move a load error under a name nobody asked for.
  assert.deepEqual(loaded.modelFallback.dropped, [{ alias: 'ghosty', harness: 'ghost' }]);
  // Dropped means NOT registered: the parser never saw the dangling reference.
  assert.equal(Object.hasOwn(loaded.profile.models, 'ghosty'), false);
  const shown = runDialShow({ repoRoot: root, userPathOptions: paths });
  assert.match(shown.note ?? '', /dropped — nothing in this catalog can deliver harness\/provider "ghost"/);
});

test('a project-declared model wins by name; the user entry neither overrides nor drops', (t) => {
  const { root, paths } = seedRepo(t, V4_BASE, {
    sol: { provider: 'dummy', id: 'user-sol', effort: 'low' },
  });
  const loaded = loadLayeredProfile(root, paths);
  assert.deepEqual(loaded.modelFallback, { promoted: [], dropped: [], repairs: [] });
  assert.equal(loaded.profile.models['sol']?.id, 'sol');
});

test('normal layering reports an empty fallback outcome; user models were always merged there', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  // No harnesses key => NOT self-contained => normal layering onto the builtin.
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    archetypes: { worker: {} },
  }));
  const paths = isolatedPaths(root);
  mkdirSync(join(root, 'user-config', 'fadeno'), { recursive: true });
  // `harness:` explicitly, because with the builtin layered in there is no
  // harness claiming `stealth` as home — the v4 load error names exactly that.
  writeFileSync(join(root, 'user-config', 'fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { ox: { provider: 'stealth', id: 'ox-alpha', effort: 'default', harness: 'opencode' } },
  }));
  const loaded = loadLayeredProfile(root, paths);
  assert.ok(!loaded.selfContained);
  assert.deepEqual(loaded.modelFallback, { promoted: [], dropped: [], repairs: [] });
  assert.equal(loaded.profile.models['ox']?.id, 'ox-alpha');
});

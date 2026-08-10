import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  LoadoutError,
  runLoadoutClear,
  runLoadoutList,
  runLoadoutShow,
  runLoadoutUse,
} from '../src/commands/loadout.ts';
import { LOADOUT_LOCAL_FILE } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

/**
 * CLI-surface tests for `fadeno loadout` (show/list/use/clear). All calls pass
 * `env: null` so a real FADENO_LOADOUT in the developer's shell never leaks in.
 */

const EXECUTORS = {
  'opus-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'opus' },
  'luna-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'gpt-5.6-luna' },
  'terra-host': { adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer' },
};

const LOADOUTS = {
  'anthropic-primary': { worker: 'opus-cmd', reviewer: 'terra-host' },
  'openai-primary': { worker: 'luna-cmd', reviewer: 'terra-host' },
};

function seedProfile(t: TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

function seedLoadouts(t: TestContext): string {
  return seedProfile(t, { executors: EXECUTORS, loadouts: LOADOUTS, default_loadout: 'anthropic-primary' });
}

test('loadout show: default loadout with its archetype table, available names, and models', (t) => {
  const root = seedLoadouts(t);
  const result = runLoadoutShow({ repoRoot: root, env: null });

  assert.deepEqual(result.active, { name: 'anthropic-primary', source: 'default' });
  assert.deepEqual(result.slots, [
    { archetype: 'reviewer', executor: 'terra-host', model: 'gpt-5.6-terra', adapter: 'host' },
    { archetype: 'worker', executor: 'opus-cmd', model: 'opus', adapter: 'command' },
  ]);
  assert.deepEqual(result.available, ['anthropic-primary', 'openai-primary']);
  assert.equal(result.defaultLoadout, 'anthropic-primary');
});

test('loadout show: flag → env → local → default precedence, blank values absent', (t) => {
  const root = seedLoadouts(t);
  runLoadoutUse({ repoRoot: root, name: 'openai-primary' });

  // local beats default
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: null }).active, {
    name: 'openai-primary',
    source: 'local',
  });
  // env beats local
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: 'anthropic-primary' }).active, {
    name: 'anthropic-primary',
    source: 'env',
  });
  // flag beats env
  assert.deepEqual(
    runLoadoutShow({ repoRoot: root, env: 'anthropic-primary', loadout: 'openai-primary' }).active,
    { name: 'openai-primary', source: 'flag' },
  );
  // blank env is absent, not an override
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: '  ' }).active, {
    name: 'openai-primary',
    source: 'local',
  });
});

test('loadout use/clear round-trip: writes and removes .fadeno/local/loadout idempotently', (t) => {
  const root = seedLoadouts(t);

  const used = runLoadoutUse({ repoRoot: root, name: 'openai-primary' });
  assert.equal(used.name, 'openai-primary');
  assert.equal(used.previous, null);
  assert.equal(read(root, LOADOUT_LOCAL_FILE), 'openai-primary\n');

  const again = runLoadoutUse({ repoRoot: root, name: 'anthropic-primary' });
  assert.equal(again.previous, 'openai-primary');
  assert.equal(read(root, LOADOUT_LOCAL_FILE), 'anthropic-primary\n');

  const cleared = runLoadoutClear({ repoRoot: root });
  assert.equal(cleared.removed, true);
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: null }).active, {
    name: 'anthropic-primary',
    source: 'default',
  });

  // clear is idempotent
  assert.equal(runLoadoutClear({ repoRoot: root }).removed, false);
});

test('loadout use: an unknown name is rejected, naming the declared loadouts', (t) => {
  const root = seedLoadouts(t);
  assert.throws(
    () => runLoadoutUse({ repoRoot: root, name: 'ghost' }),
    (err: unknown) =>
      err instanceof LoadoutError &&
      /"ghost" is not a declared loadout \(anthropic-primary, openai-primary\)/.test(err.message),
  );
  // the sticky file stays untouched by a failed use
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: null }).active, {
    name: 'anthropic-primary',
    source: 'default',
  });
});

test('loadout use: a profile without loadouts explains itself', (t) => {
  const root = seedProfile(t, { executors: EXECUTORS, bindings: { '*': 'opus-cmd' } });
  assert.throws(
    () => runLoadoutUse({ repoRoot: root, name: 'anything' }),
    /"anything" is not a declared loadout — the profile has no `loadouts`/,
  );
});

test('loadout show: an unknown name from env or flag is a hard error naming the source', (t) => {
  const root = seedLoadouts(t);
  assert.throws(
    () => runLoadoutShow({ repoRoot: root, env: 'ghost' }),
    (err: unknown) => err instanceof LoadoutError && /FADENO_LOADOUT names loadout "ghost"/.test(err.message),
  );
  assert.throws(
    () => runLoadoutShow({ repoRoot: root, env: null, loadout: 'ghost' }),
    /--loadout names loadout "ghost"/,
  );
});

test('loadout show/list: a bindings-only profile has no active loadout and none available', (t) => {
  const root = seedProfile(t, { executors: EXECUTORS, bindings: { '*': 'opus-cmd' } });
  const shown = runLoadoutShow({ repoRoot: root, env: null });
  assert.equal(shown.active, null);
  assert.deepEqual(shown.slots, []);
  assert.deepEqual(shown.available, []);
  assert.equal(shown.defaultLoadout, null);

  const listed = runLoadoutList({ repoRoot: root, env: null });
  assert.deepEqual(listed.loadouts, []);
  assert.equal(listed.active, null);
});

test('loadout list: marks the active and default loadouts with their slot tables', (t) => {
  const root = seedLoadouts(t);
  runLoadoutUse({ repoRoot: root, name: 'openai-primary' });
  const result = runLoadoutList({ repoRoot: root, env: null });

  assert.deepEqual(
    result.loadouts.map((l) => [l.name, l.isDefault, l.isActive]),
    [
      ['anthropic-primary', true, false],
      ['openai-primary', false, true],
    ],
  );
  assert.deepEqual(result.active, { name: 'openai-primary', source: 'local' });
  const openai = result.loadouts.find((l) => l.name === 'openai-primary')!;
  assert.deepEqual(openai.slots, [
    { archetype: 'reviewer', executor: 'terra-host', model: 'gpt-5.6-terra', adapter: 'host' },
    { archetype: 'worker', executor: 'luna-cmd', model: 'gpt-5.6-luna', adapter: 'command' },
  ]);
});

test('loadout: show/list/use need a profile; clear works without one', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  assert.throws(() => runLoadoutShow({ repoRoot: root, env: null }), LoadoutError);
  assert.throws(() => runLoadoutList({ repoRoot: root, env: null }), LoadoutError);
  assert.throws(() => runLoadoutUse({ repoRoot: root, name: 'x' }), LoadoutError);
  assert.equal(runLoadoutClear({ repoRoot: root }).removed, false);
});

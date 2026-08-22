import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { ModelsError, runModels, runModelsDriver } from '../src/commands/models.ts';
import { recordVerifiedModel, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

function isolated(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

function seed(t: TestContext): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'high', spellings: { openrouter: 'anthropic/claude-opus' } },
      // provider with no route under standalone → stale row, still listed
      ghost: { provider: 'nowhere', id: 'ghost-1', effort: 'high' },
    },
    routes: {
      standalone: {
        openai: {
          command: ['node', '-e', '0'],
          // One id per LINE, which is what every shipped backend actually
          // emits. This fixture used to put both ids on one space-separated
          // line — a shape no real backend produces, and one that only
          // "worked" because the listing tokenized on whitespace and so also
          // turned agy's `id<TAB>Description` rows into four models each.
          models_command: ['printf', 'gpt-5.6-sol\\ngpt-5.6-luna\\n'],
        },
        anthropic: {
          driver: 'claude',
          // `fadeno_capable` is now read off the argv that will actually run,
          // so the flag has to be IN it — there is no second "variant" argv to
          // look inside any more.
          command: ['claude', '-p', '--model', '{model}', '--allowedTools', 'Bash(fadeno:*)'],
        },
        openrouter: {
          command: ['opencode', 'run', '-m', '{model}'],
          models_command: ['printf', 'anthropic/claude-opus\\nqwen-max\\n'],
        },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: { } },
    unregistered_model_driver: 'openrouter',
  }));
  return { root, user: isolated(root) };
}

test('models: registry table — deliveries, lane marks, stale providers, verification cache', (t) => {
  const { root, user } = seed(t);
  recordVerifiedModel(user, { driver: 'openai', model: 'gpt-5.6-sol', verified_at: '2026-08-16T00:00:00Z' });

  const result = runModels({ repoRoot: root, userPathOptions: user });
  assert.equal(result.harness, 'standalone');
  assert.equal(result.harness_source, 'FADENO_HARNESS');
  assert.equal(result.unregistered_model_driver, 'openrouter');
  assert.deepEqual(result.listable_drivers, ['openai', 'openrouter']);

  const names = result.models.map((r) => r.name);
  assert.deepEqual([...names].sort(), names, 'rows are name-sorted');
  assert.ok(names.includes('sol') && names.includes('opus') && names.includes('ghost'));

  const sol = result.models.find((r) => r.name === 'sol')!;
  assert.equal(sol.home_via, 'openai');
  assert.equal(sol.native, false);
  assert.equal(sol.effort, 'high');
  assert.equal(sol.verified_at, '2026-08-16T00:00:00Z');

  // Adapter state remains structured resolution data; the displayed `via`
  // and effort are frame-neutral model identity.
  const host = result.models.find((r) => r.name === 'current-host');
  if (host != null) assert.equal(host.native, true);

  const opus = result.models.find((r) => r.name === 'opus')!;
  assert.equal(opus.home_via, 'claude');
  assert.equal(opus.fadeno_capable, true);
  // The openrouter lane is visible with its spelling-substituted id.
  const orLane = opus.lanes.find((l) => l.via === 'openrouter');
  assert.ok(orLane);
  assert.equal(orLane!.id, 'anthropic/claude-opus');

  const ghost = result.models.find((r) => r.name === 'ghost')!;
  assert.equal(ghost.home_via, 'nowhere');
  assert.match(ghost.stale ?? '', /no route for provider "nowhere"/);
});

test('models --driver: live listing via models_command with registered spellings marked', (t) => {
  const { root, user } = seed(t);
  const result = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openrouter' });
  assert.deepEqual(result.models_command, ['printf', 'anthropic/claude-opus\\nqwen-max\\n']);
  assert.deepEqual(result.models, [
    { id: 'anthropic/claude-opus', registered_as: ['opus'] },
    { id: 'qwen-max', registered_as: [] },
  ]);
  // Home-route ids mark too.
  const openai = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openai' });
  assert.deepEqual(openai.models[0], { id: 'gpt-5.6-sol', registered_as: ['sol'] });
  assert.deepEqual(openai.models[1], { id: 'gpt-5.6-luna', registered_as: [] });
});

test('models --driver: a listing is parsed per line, not per whitespace token', (t) => {
  // The three shapes the shipped backends actually emit, pinned together
  // because the bug was that one parse was serving two different questions.
  // `agy` is the one that broke: `id<TAB>Description` after a progress
  // preamble became `gemini-3.7-flash-high`, `Gemini`, `3.7`, `Flash`,
  // `(High)` — five "models" from one, and 31 real models became 100-odd.
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { flash: { provider: 'google', id: 'gemini-3.7-flash-high', effort: 'high' } },
    routes: {
      standalone: {
        // agy: a preamble line, then tab-separated id + human label.
        google: {
          driver: 'agy',
          command: ['agy'],
          models_command: ['printf', 'Fetching available models...\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n'],
        },
        // opencode: one bare id per line, nothing else.
        openrouter: { command: ['opencode'], models_command: ['printf', 'opencode/big-pickle\nopencode/hy3-free\n'] },
        // grok: prose, and no listing at all. The honest answer is an empty
        // list, not a set of models named after the words in its login banner.
        xai: { driver: 'grok', command: ['grok'], models_command: ['printf', 'You are logged in with grok.com.\n\nDefault model: grok-4.6\n'] },
      },
    },
    archetypes: { worker: {} },
  }));
  const user = isolated(root);

  const agy = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'agy' });
  assert.deepEqual(agy.models, [
    { id: 'gemini-3.7-flash-high', registered_as: ['flash'] },
    { id: 'gemini-3.7-flash-low', registered_as: [] },
  ], 'the tab-separated label is not a model, and the preamble is not a model');

  const oc = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openrouter' });
  assert.deepEqual(oc.models.map((m) => m.id), ['opencode/big-pickle', 'opencode/hy3-free']);

  const grok = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'grok' });
  assert.deepEqual(grok.models, [], 'prose yields no models rather than one per word');
});

test('models --driver: unknown driver and probe-less driver refuse with guidance', (t) => {
  const { root, user } = seed(t);
  assert.throws(
    () => runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'nope' }),
    (err: unknown) => err instanceof ModelsError && /unknown driver "nope" — declared drivers:/.test((err as Error).message),
  );
  assert.throws(
    () => runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'claude' }),
    (err: unknown) => err instanceof ModelsError && /declares no models_command/.test((err as Error).message),
  );
});

test('models: home `via` is stable while the caller-specific adapter changes', (t) => {
  const root = tempRepo(t);
  const rows = new Map<string, ReturnType<typeof runModels>['models'][number]>();
  for (const harness of ['codex', 'claude', 'grok', 'standalone']) {
    const result = runModels({
      repoRoot: root,
      userPathOptions: {
        home: join(root, `home-${harness}`),
        env: {
          FADENO_CONFIG_HOME: join(root, `config-${harness}`),
          FADENO_STATE_HOME: join(root, `state-${harness}`),
          FADENO_HARNESS: harness,
        },
      },
    });
    rows.set(harness, result.models.find((row) => row.name === 'luna')!);
  }
  for (const row of rows.values()) {
    // `home_via`, the model's own driver — not `harness`, which in this same
    // command means the agent asking and differs on every iteration of the
    // loop above. The two used to share a field name.
    assert.equal(row.home_via, 'codex');
    assert.ok(!('harness' in row), 'the misleading synonym is gone, not deprecated');
  }
  assert.equal(rows.get('codex')!.adapter, 'host');
  assert.equal(rows.get('claude')!.adapter, 'command');
  assert.equal(rows.get('grok')!.adapter, 'command');
  assert.equal(rows.get('standalone')!.adapter, 'command');
});

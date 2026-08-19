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
          write_access: true,
          models_command: ['echo', 'gpt-5.6-sol gpt-5.6-luna'],
        },
        anthropic: {
          driver: 'claude-cli',
          command: ['claude', '-p', '--model', '{model}'],
          write_access: false,
          write_variant: { command: ['claude', '-p', '--model', '{model}', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(fadeno:*)'] },
        },
        openrouter: {
          command: ['opencode', 'run', '-m', '{model}'],
          write_access: true,
          models_command: ['echo', 'anthropic/claude-opus qwen-max'],
        },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: { requires_write: 'required' } },
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
  assert.equal(sol.delivery, 'openai');
  assert.equal(sol.harness, 'openai');
  assert.equal(sol.native, false);
  assert.equal(sol.effort, 'high');
  assert.equal(sol.verified_at, '2026-08-16T00:00:00Z');

  // Adapter state remains structured resolution data; the displayed harness
  // and effort are frame-neutral model identity.
  const host = result.models.find((r) => r.name === 'current-host');
  if (host != null) assert.equal(host.native, true);

  const opus = result.models.find((r) => r.name === 'opus')!;
  assert.equal(opus.delivery, 'claude-cli');
  assert.equal(opus.harness, 'claude-cli');
  assert.equal(opus.write_variant, true);
  assert.equal(opus.fadeno_capable, true);
  // The openrouter lane is visible with its spelling-substituted id.
  const orLane = opus.lanes.find((l) => l.via === 'openrouter');
  assert.ok(orLane);
  assert.equal(orLane!.id, 'anthropic/claude-opus');

  const ghost = result.models.find((r) => r.name === 'ghost')!;
  assert.equal(ghost.delivery, 'nowhere');
  assert.equal(ghost.harness, 'nowhere');
  assert.match(ghost.stale ?? '', /no route for provider "nowhere"/);
});

test('models --driver: live listing via models_command with registered spellings marked', (t) => {
  const { root, user } = seed(t);
  const result = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openrouter' });
  assert.deepEqual(result.models_command, ['echo', 'anthropic/claude-opus qwen-max']);
  assert.deepEqual(result.models, [
    { id: 'anthropic/claude-opus', registered_as: ['opus'] },
    { id: 'qwen-max', registered_as: [] },
  ]);
  // Home-route ids mark too.
  const openai = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openai' });
  assert.deepEqual(openai.models[0], { id: 'gpt-5.6-sol', registered_as: ['sol'] });
  assert.deepEqual(openai.models[1], { id: 'gpt-5.6-luna', registered_as: [] });
});

test('models --driver: unknown driver and probe-less driver refuse with guidance', (t) => {
  const { root, user } = seed(t);
  assert.throws(
    () => runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'nope' }),
    (err: unknown) => err instanceof ModelsError && /unknown driver "nope" — declared drivers:/.test((err as Error).message),
  );
  assert.throws(
    () => runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'claude-cli' }),
    (err: unknown) => err instanceof ModelsError && /declares no models_command/.test((err as Error).message),
  );
});

test('models: harness identity is stable while the caller-specific adapter changes', (t) => {
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
    assert.equal(row.harness, 'codex');
    assert.equal(row.delivery, 'codex');
  }
  assert.equal(rows.get('codex')!.adapter, 'host');
  assert.equal(rows.get('claude')!.adapter, 'command');
  assert.equal(rows.get('grok')!.adapter, 'command');
  assert.equal(rows.get('standalone')!.adapter, 'command');
});

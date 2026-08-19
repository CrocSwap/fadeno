import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DialError,
  runDialSet,
  runDialShow,
  runDialResolve,
} from '../src/commands/dial.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { DIALS_LOCAL_FILE } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

// Isolated per-repo user state: these tests must never read the developer's
// real user dials (a non-empty real user layer flips `base` rows to `user`).
const isolated = (root: string): UserPathOptions => ({
  home: join(root, 'home'),
  env: {
    FADENO_CONFIG_HOME: join(root, 'user-config'),
    FADENO_STATE_HOME: join(root, 'user-state'),
    FADENO_HARNESS: 'standalone',
  },
});

function seedV3(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      terra: { provider: 'openai', id: 'terra-model', effort: 'medium' },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], write_access: true },
        xai: { command: ['node', '-e', '0'], write_access: true },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
      reviewer: { requires_write: 'none' },
      judge: { requires_write: 'none' },
    },
    ...extra,
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
  return root;
}

test('dial show: effective table with triad and source base', (t) => {
  const root = seedV3(t);
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.equal(result.harness, 'standalone');
  // All three triad rows present with base source
  const workers = result.rows.find((r) => r.archetype === 'worker');
  assert.ok(workers);
  assert.equal(workers!.source, 'base');
  assert.equal(workers!.model, 'current-host');
  assert.equal(result.legacy_pin_note, null);
  assert.ok(Array.isArray(result.suppressed_canon_archetypes));
  // snake_case fields present
  const json = JSON.stringify(result);
  assert.match(json, /"legacy_pin_note"/);
  assert.match(json, /"suppressed_canon_archetypes"/);
});

test('dial show: rows follow the canon power order, extras alphabetical after', (t) => {
  const root = seedV3(t, {
    archetypes: {
      worker: { requires_write: 'required' },
      reviewer: { requires_write: 'none' },
      judge: { requires_write: 'none' },
      director: { requires_write: 'required' },
      generator: { requires_write: 'forbidden' },
      scout: {},
    },
  });
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.deepEqual(
    result.rows.map((r) => r.archetype),
    ['director', 'judge', 'reviewer', 'generator', 'worker', 'scout'],
  );
});

test('dial show: legacy pin note surfaces', (t) => {
  const root = seedV3(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), 'anthropic-primary\n', 'utf8');
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.match(result.legacy_pin_note ?? '', /pre-0\.6 loadout pin ignored/);
  // Rows still render base
  assert.ok(result.rows.length > 0);
});

test('dial resolve: hook fields stable', (t) => {
  const root = seedV3(t);
  const result = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: isolated(root) });
  assert.equal(result.archetype, 'worker');
  assert.equal(result.model, 'current-host');
  assert.equal(result.adapter, 'host');
  assert.equal(result.source, 'base');
  assert.ok('executor' in result);
  assert.ok('model_id' in result);
  assert.ok('driver' in result);
  assert.ok('delivery' in result);
  assert.equal(typeof result.delivery.dispatchable, 'boolean');
  assert.equal(typeof result.delivery.action, 'string');
  // Keys exact
  const keys = Object.keys(result);
  assert.ok(keys.includes('executor'));
  assert.ok(keys.includes('model'));
  assert.ok(!keys.includes('active')); // active is gone
});

test('dial show: luna stays in codex while adapter selection follows the caller', (t) => {
  const root = tempRepo(t);
  const rows = new Map<string, ReturnType<typeof runDialShow>['rows'][number]>();
  for (const harness of ['codex', 'claude', 'grok', 'standalone']) {
    const userPathOptions: UserPathOptions = {
      home: join(root, `home-${harness}`),
      env: {
        FADENO_CONFIG_HOME: join(root, `config-${harness}`),
        FADENO_STATE_HOME: join(root, `state-${harness}`),
        FADENO_HARNESS: harness,
      },
    };
    runDialSet({ repoRoot: root, userPathOptions, archetype: 'reviewer', model: 'luna', user: true });
    rows.set(harness, runDialShow({ repoRoot: root, userPathOptions }).rows.find((row) => row.archetype === 'reviewer')!);
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

test('dial CLI: --session creates a local dial and a later unscoped set updates it', (t) => {
  const root = seedV3(t);
  const paths = isolated(root);
  const env = { ...process.env, ...paths.env, HOME: paths.home! };
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  })) as Record<string, any>;

  const created = run(['dial', 'judge', 'grok', '--session']);
  assert.equal(created.layer, 'session');
  const updated = run(['dial', 'judge', 'sol']);
  assert.equal(updated.layer, 'session');
  assert.equal(updated.adaptive, true);

  const shown = run(['dial']);
  assert.equal(shown.dials.session.judge.model, 'sol');
  assert.equal(shown.dials.user.judge, undefined);
  assert.equal(shown.rows.find((row: Record<string, unknown>) => row.archetype === 'judge')?.model, 'sol');
});

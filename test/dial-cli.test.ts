import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DialError,
  runDialShow,
  runDialResolve,
} from '../src/commands/dial.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { DIALS_LOCAL_FILE } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

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
  const result = runDialShow({ repoRoot: root, userPathOptions: onHarness('standalone') });
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

test('dial show: legacy pin note surfaces', (t) => {
  const root = seedV3(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), 'anthropic-primary\n', 'utf8');
  const result = runDialShow({ repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.match(result.legacy_pin_note ?? '', /pre-0\.6 loadout pin ignored/);
  // Rows still render base
  assert.ok(result.rows.length > 0);
});

test('dial resolve: hook fields stable', (t) => {
  const root = seedV3(t);
  const result = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: onHarness('standalone') });
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

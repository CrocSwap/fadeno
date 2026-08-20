import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { runInit } from '../src/commands/init.ts';
import { runValidate } from '../src/commands/validate.ts';
import { parseExecutorProfile } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

// Loadout dispatch resolves role → archetype → executor; the starter templates
// must stay provider-neutral for that to work: archetypes are bare lowercase
// identifiers, and role names never encode model or vendor names
// (docs/experimental/loadouts-and-dispatch.md §Schema).

const ARCHETYPE_RE = /^[a-z][a-z0-9_-]*$/;

/** Model/vendor tokens that must never appear as a role-name segment. */
const MODEL_TOKENS = new Set([
  'luna',
  'terra',
  'sol',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'gpt',
  'claude',
  'gemini',
  'grok',
]);

interface RoleEntry {
  purpose?: unknown;
  archetype?: unknown;
}

function initRepo(t: Parameters<typeof tempRepo>[0]): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  return root;
}

function starterPlaybooks(root: string): Array<{ file: string; roles: Record<string, RoleEntry> }> {
  const dir = join(root, '.fadeno', 'playbooks');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 4, `expected at least 4 starter playbooks, found ${files.length}`);
  return files.map((file) => {
    const doc = parseYaml(readFileSync(join(dir, file), 'utf8')) as { roles?: Record<string, RoleEntry> };
    assert.ok(doc.roles && Object.keys(doc.roles).length > 0, `${file}: playbook declares roles`);
    return { file, roles: doc.roles };
  });
}

test('every starter playbook validates after init', (t) => {
  const root = initRepo(t);
  const outcome = runValidate({ repoRoot: root });
  assert.ok(outcome.ok, JSON.stringify(outcome.results, null, 2));
});

test('starter-playbook archetypes are bare lowercase identifiers', (t) => {
  const root = initRepo(t);
  let declared = 0;
  for (const { file, roles } of starterPlaybooks(root)) {
    for (const [name, role] of Object.entries(roles)) {
      if (role.archetype === undefined) continue;
      declared += 1;
      assert.equal(typeof role.archetype, 'string', `${file}: ${name}.archetype is a string`);
      assert.match(
        role.archetype as string,
        ARCHETYPE_RE,
        `${file}: ${name}.archetype ${JSON.stringify(role.archetype)} is a bare identifier`,
      );
    }
  }
  assert.ok(declared > 0, 'at least one starter role declares an archetype');
});

test('starter catalog archetypes: worker is required, generator is forbidden with worker fallback', () => {
  const profile = parseExecutorProfile(
    readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml'), 'utf8'),
    'templates/common/fadeno/executors.yaml',
  );
  assert.deepEqual(profile.archetypes.worker, { requiresWrite: 'required', ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null });
  assert.deepEqual(profile.archetypes.generator, { requiresWrite: 'forbidden', ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null });
  assert.deepEqual(profile.dials, {}, 'starter catalog ships no repo dials');
  assert.equal((profile as unknown as Record<string, unknown>).loadouts, undefined, 'starter catalog has no legacy loadouts');
  assert.equal((profile as unknown as Record<string, unknown>).defaultLoadout, undefined, 'starter catalog has no default_loadout');
  assert.equal(profile.schemaVersion, 3, 'starter catalog is schema_version 3');
  assert.ok(Object.keys(profile.models).length >= 6, 'starter catalog declares registry models');
  // generator needs no explicit slot; the fallback serves it
  assert.ok(!('generator' in profile.models), 'generator is an archetype, not a model');
});

test('starter-playbook role names do not encode model names', (t) => {
  const root = initRepo(t);
  for (const { file, roles } of starterPlaybooks(root)) {
    for (const name of Object.keys(roles)) {
      for (const segment of name.split(/[_-]/)) {
        assert.ok(
          !MODEL_TOKENS.has(segment),
          `${file}: role ${JSON.stringify(name)} encodes model name ${JSON.stringify(segment)}`,
        );
      }
    }
  }
});

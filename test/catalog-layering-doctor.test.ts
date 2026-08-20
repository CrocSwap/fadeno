import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDoctor } from '../src/commands/doctor.ts';
import { missingBuiltinDeclarations } from '../src/lib/config-layers.ts';
import { tempRepo } from './helpers.ts';

/**
 * A self-contained project catalog suppresses the builtin and user layers.
 * That is supported and deliberate — and it is a one-way ratchet: from that
 * moment the catalog can only fall behind the builtin shipped beside it, and
 * nothing said so. This repo's own catalog sat 26 declarations behind while
 * `doctor` reported zero warnings.
 */

const MODELS = { luna: { provider: 'openai', id: 'gpt-5.6-luna', effort: 'xhigh' } };

function seed(root: string, doc: Record<string, unknown>): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc), 'utf8');
}

function layering(root: string): ReturnType<typeof runDoctor>['findings'][number] | undefined {
  return runDoctor({ repoRoot: root }).findings.find((f) => f.check === 'catalog-layering');
}

test('a self-contained catalog that omits builtin declarations is reported', (t) => {
  const root = tempRepo(t);
  // Declares its own models AND routes => self-contained => suppresses builtin.
  // Declares the codex/openai route but omits the builtin's `timeout_ms` on it.
  seed(root, {
    schema_version: 3,
    models: MODELS,
    routes: { codex: { 'current-host': { host: true }, openai: { host: true } } },
  });

  const found = layering(root);
  assert.equal(found?.severity, 'warning');
  assert.match(found!.detail, /self-contained/);
  assert.match(found!.detail, /omits \d+ declaration/);
});

test('a catalog that layers is silent — it cannot fall behind', (t) => {
  const root = tempRepo(t);
  // No `models:` + `routes:` => not self-contained => layers on the builtin.
  // This is the shape a project overlay should have.
  seed(root, { schema_version: 3, worktree_carry: ['node_modules'] });

  assert.equal(layering(root), undefined, 'a layering catalog has nothing to fall behind');
});

test('no project catalog at all is silent', (t) => {
  const root = tempRepo(t);
  assert.equal(layering(root), undefined);
});

test('omitting a whole route or model is not drift — shipping a smaller catalog is legitimate', () => {
  const builtin = {
    models: { luna: { id: 'a' }, terra: { id: 'b' } },
    routes: { codex: { openai: { timeout_ms: 1 }, xai: { timeout_ms: 2 } } },
  };
  // The project declares only `luna` and only the `openai` route, and declares
  // `timeout_ms` on the route it DID declare. Nothing is behind.
  const project = {
    models: { luna: { id: 'a' } },
    routes: { codex: { openai: { timeout_ms: 1 } } },
  };
  assert.deepEqual(missingBuiltinDeclarations(builtin, project), []);
});

test('a key omitted from a node the project DID declare is drift', () => {
  const builtin = { routes: { codex: { openai: { timeout_ms: 1, driver: 'codex' } } } };
  const project = { routes: { codex: { openai: { driver: 'codex' } } } };
  assert.deepEqual(missingBuiltinDeclarations(builtin, project), ['routes.codex.openai.timeout_ms']);
});

/**
 * The documented blind spot, pinned so nobody assumes coverage it does not
 * have: a differing VALUE is exactly what an override is for, so reporting it
 * would fire on every honest catalog. That is why a stale `relay.codex` went
 * unreported while 26 absences did not.
 */
test('a differing value is an override, not drift, and is deliberately not reported', () => {
  const builtin = { relay: { codex: 'luna@high' } };
  const project = { relay: { codex: 'luna@low' } };
  assert.deepEqual(missingBuiltinDeclarations(builtin, project), []);
});

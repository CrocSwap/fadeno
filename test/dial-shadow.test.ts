import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DialError,
  formatShadowLine,
  runDialClearShadow,
  runDialResolve,
  runDialShadow,
  runDialShow,
} from '../src/commands/dial.ts';
import { readLocalDialState } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { read, tempRepo } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

function seedV3(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], },
        xai: { command: ['node', '-e', '0'], },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { },
      reviewer: { },
    },
  }));
  return root;
}

test('shadow attach/clear round-trip', (t) => {
  const root = seedV3(t);
  const attached = runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol' });
  assert.equal(attached.archetype, 'worker');
  assert.equal(attached.model, 'sol');
  assert.equal(attached.rate, null);
  assert.ok(attached.previous == null);
  const shown = runDialShow({ repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.ok(shown.shadows.worker);
  assert.equal(shown.shadows.worker.model, 'sol');
  assert.ok(shown.shadow_attachments.worker);
  // Clear single
  const cleared = runDialClearShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker' });
  assert.equal(cleared.archetype, 'worker');
  assert.equal(cleared.cleared?.model, 'sol');
  const shown2 = runDialShow({ repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(Object.keys(shown2.shadows).length, 0);
});

test('shadow with rate and via', (t) => {
  const root = seedV3(t);
  const withRate = runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'grok', rate: 0.25 });
  assert.equal(withRate.rate, 0.25);
  const shown = runDialShow({ repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(shown.shadow_attachments.worker.rate, 0.25);
  // Table renders ~ shadow line
  const line = formatShadowLine(shown.shadow_attachments.worker, '  ');
  assert.match(line, /~ shadow:/);
  assert.match(line, /rate 0.25/);
});

test('finite shadow budget persists, reattach resets it, and expiry stays visible', (t) => {
  const root = seedV3(t);
  const attached = runDialShadow({
    repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'grok', rate: 0.2, n: 3,
  });
  assert.equal(attached.n, 3);
  assert.equal(attached.remaining, 3);
  assert.equal(attached.expired, false);
  assert.deepEqual(readLocalDialState(root).shadows.worker, { model: 'grok', rate: 0.2, n: 3, remaining: 3 });

  // An exhausted attachment is still an attachment: `fadeno dial` must not
  // make a spent experiment disappear and leave a user wondering why pairs
  // stopped.
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({
    shadows: { worker: { model: 'grok', rate: 0.2, n: 3, remaining: 0 } },
  }));
  const shown = runDialShow({ repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(shown.shadow_attachments.worker.n, 3);
  assert.equal(shown.shadow_attachments.worker.remaining, 0);
  assert.equal(shown.shadow_attachments.worker.expired, true);
  assert.match(formatShadowLine(shown.shadow_attachments.worker, ''), /expired after 3 triggers/);
  const resolved = runDialResolve({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker' });
  assert.equal(resolved.shadow?.expired, true);
  assert.equal(resolved.shadow?.selected, false);

  const reset = runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'grok', n: 2 });
  assert.equal(reset.previous?.remaining, 0);
  assert.equal(reset.remaining, 2);
  assert.equal(reset.expired, false);
});

test('shadow refusals: host delivery and forbidden', (t) => {
  const root = seedV3(t);
  assert.throws(() => runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'current-host' }), (err: unknown) => err instanceof DialError && /command delivery/.test((err as Error).message));
  // bad rate
  assert.throws(() => runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol', rate: 0 }), /is not a number in \(0, 1\]/);
  assert.throws(() => runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol', rate: 1.5 }), /is not a number in \(0, 1\]/);
  assert.throws(() => runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol', n: 0 }), /not a positive integer/);
  assert.throws(() => runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol', n: '1.5' }), /not a positive integer/);
  assert.throws(() => runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol', n: Number.MAX_SAFE_INTEGER + 1 }), /not a positive integer/);
});

test('local shadow count state rejects malformed finite records but keeps legacy unlimited records', (t) => {
  const root = seedV3(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  const write = (shadow: unknown): void => writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ shadows: { worker: shadow } }));
  write({ model: 'sol' });
  assert.deepEqual(readLocalDialState(root).shadows.worker, { model: 'sol' });
  write({ model: 'sol', n: 3 });
  assert.throws(() => readLocalDialState(root), /remaining/);
  write({ model: 'sol', remaining: 1 });
  assert.throws(() => readLocalDialState(root), /without a finite `n`/);
  write({ model: 'sol', n: 3, remaining: 4 });
  assert.throws(() => readLocalDialState(root), /integer in \[0, n\]/);
});

test('clear-shadow error when no attachment', (t) => {
  const root = seedV3(t);
  assert.throws(() => runDialClearShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker' }), (err: unknown) => err instanceof DialError && /no shadow attachment for "worker"/.test((err as Error).message));
});

test('clear-shadow all', (t) => {
  const root = seedV3(t);
  runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol' });
  runDialShadow({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'reviewer', model: 'grok', rate: 0.5 });
  const clearedAll = runDialClearShadow({ repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(clearedAll.count, 2);
  assert.equal(clearedAll.removed, true);
  const shown = runDialShow({ repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(Object.keys(shown.shadows).length, 0);
});

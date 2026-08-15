import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DialError,
  runDialClear,
  runDialResolve,
  runDialSet,
  runDialShow,
} from '../src/commands/dial.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { read, tempRepo } from './helpers.ts';

function seedV3(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      luna: { provider: 'openai', id: 'luna-model', effort: 'default' },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], write_access: true, models_command: ['echo', 'gpt-5.6-sol gpt-5.6-luna grok-4.6'] },
        xai: { command: ['node', '-e', '0'], write_access: true, models_command: ['echo', 'grok-4.6 gpt-5.6-sol'] },
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

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

function isolatedUser(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

test('set: dial round-trip through pin file (user default)', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'sol' });
  assert.equal(result.layer, 'user');
  assert.equal(result.adaptive, false);
  assert.match(result.narrative, /\[user default/);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.worker.model, 'sol');
  assert.equal(shown.dials.session.worker, undefined);
  // RefString preserved
  assert.equal(result.refString, 'sol');
});

test('set: adaptive session when repo pin exists', (t) => {
  const root = seedV3(t, { dials: { worker: 'sol' } });
  const user = isolatedUser(root);
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok' });
  assert.equal(result.layer, 'session');
  assert.equal(result.adaptive, true);
  assert.match(result.narrative, /this repo only, sticky until cleared — worker is repo-pinned to sol/);
  assert.match(result.narrative, /--user sets your global default/);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.session.worker.model, 'grok');
  assert.equal(shown.dials.repo.worker.model, 'sol');
});

test('set: explicit --user forces user layer even with repo pin', (t) => {
  const root = seedV3(t, { dials: { worker: 'sol' } });
  const user = isolatedUser(root);
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok', user: true });
  assert.equal(result.layer, 'user');
  assert.equal(result.adaptive, false);
  assert.match(result.narrative, /\[user default/);
});

test('clear: never adaptive downward', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok', user: true });
  // Try plain clear (targets session) — should not touch user layer
  const cleared = runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'worker' });
  assert.equal(cleared.removed, false);
  assert.equal(cleared.layer, null);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.worker.model, 'grok');
  // Explicit --user clears it
  const clearedUser = runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'worker', user: true });
  assert.equal(clearedUser.removed, true);
  assert.equal(clearedUser.layer, 'user');
});

test('clear: no archetype clears all session dials preserves shadows', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'sol' }); // user
  // Need session dial: create repo pin then adaptive set
  const root2 = seedV3(t, { dials: { judge: 'sol' } });
  const user2 = isolatedUser(root2);
  runDialSet({ repoRoot: root2, userPathOptions: user2, archetype: 'judge', model: 'grok' }); // session
  const clearedAll = runDialClear({ repoRoot: root2, userPathOptions: user2 });
  assert.equal(clearedAll.removed, true);
  const shown = runDialShow({ repoRoot: root2, userPathOptions: user2 });
  assert.equal(Object.keys(shown.dials.session).length, 0);
});

test('repo pin: --repo writes via parseDocument preserving comments', (t) => {
  const root = seedV3(t);
  const executorsPath = join(root, '.fadeno', 'executors.yaml');
  // Add comment
  const original = readFileSync(executorsPath, 'utf8');
  writeFileSync(executorsPath, `# keep this comment\n${original}`, 'utf8');
  const result = runDialSet({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol', repo: true });
  assert.equal(result.layer, 'repo');
  assert.match(result.narrative, /repo pin — committed/);
  const text = readFileSync(executorsPath, 'utf8');
  assert.match(text, /keep this comment/);
  assert.match(text, /dials:/);
});

test('set-time refusals: @effort on host, write posture, forbidden eligibility', (t) => {
  const root = seedV3(t, {
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      forbidden: { provider: 'openai', id: 'forbid-model', effort: 'high', eligibility: { worker: 'forbidden' } },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], write_access: false },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
    },
  });
  // @effort on host
  assert.throws(() => runDialSet({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'current-host@high' }), (err: unknown) => err instanceof DialError && /native delivery cannot pin reasoning effort/.test((err as Error).message));
  // write posture: worker requires_write but route is write_access false
  assert.throws(() => runDialSet({ repoRoot: root, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'sol' }), (err: unknown) => err instanceof DialError && /requires_write: required/.test((err as Error).message));
  // forbidden eligibility (need a write-compatible route for this test, so use different root)
  const root2 = seedV3(t, {
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      forbidden: { provider: 'openai', id: 'forbid-model', effort: 'high', eligibility: { worker: 'forbidden' } },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], write_access: true },
        'current-host': { host: true },
      },
    },
  });
  assert.throws(() => runDialSet({ repoRoot: root2, userPathOptions: onHarness('standalone'), archetype: 'worker', model: 'forbidden' }), (err: unknown) => err instanceof DialError && /forbidden/.test((err as Error).message));
});

test('probe: verified/cached/unverified/refused via injected spawn', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  // Verified: spawn returns listing containing delivered model ids (gpt-5.6-sol etc)
  const spawnVerified = () => ({ status: 0, stdout: 'gpt-5.6-sol grok-4.6 luna-model', stderr: '' });
  const r1 = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'sol', spawn: spawnVerified as any });
  assert.equal(r1.verification, 'verified');
  // Cached: second time same model should be cached (no spawn called)
  let spawnCalled = false;
  const spawnNever = () => { spawnCalled = true; return { status: 0, stdout: '', stderr: '' }; };
  const r2 = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'reviewer', model: 'sol', spawn: spawnNever as any });
  // sol already verified, so should be cached
  assert.equal(r2.verification, 'cached');
  assert.equal(spawnCalled, false);
  // Unverified: spawn fails (non-zero) -> unverified, not refused
  const spawnFail = () => ({ status: 1, stdout: '', stderr: '' });
  const r3 = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'grok', spawn: spawnFail as any });
  assert.equal(r3.verification, 'unverified');
  // Refused: spawn succeeds but model absent -> throws with did-you-mean (use delivered id luna-model)
  const spawnAbsent = () => ({ status: 0, stdout: 'gpt-5.6-sol grok-4.6', stderr: '' });
  assert.throws(() => runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'luna', spawn: spawnAbsent as any }), (err: unknown) => err instanceof DialError && /unknown model "luna-model"/.test((err as Error).message) && /did you mean/.test((err as Error).message));
});

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
  runDialSetMany,
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

test('set: plain set updates an active repo pin in place', (t) => {
  const root = seedV3(t, { dials: { worker: 'sol' } });
  const user = isolatedUser(root);
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok' });
  assert.equal(result.layer, 'repo');
  assert.equal(result.adaptive, true);
  assert.match(result.narrative, /repo pin — committed/);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.session.worker, undefined);
  assert.equal(shown.dials.repo.worker.model, 'grok');
});

test('set: plain set updates the active session dial instead of writing a shadowed user default', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'grok', session: true });
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'sol' });
  assert.equal(result.layer, 'session');
  assert.equal(result.adaptive, true);
  assert.deepEqual(result.previous, { layer: 'session', dial: { model: 'grok' } });
  assert.match(result.narrative, /session dial — this checkout only/);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.session.judge.model, 'sol');
  assert.equal(shown.dials.user.judge, undefined);
  assert.equal(shown.rows.find((row) => row.archetype === 'judge')?.model, 'sol');
});

test('set: --session creates a checkout-local dial and clear --session removes it', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  const set = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'grok', session: true });
  assert.equal(set.layer, 'session');
  assert.equal(set.adaptive, false);
  assert.equal(runDialShow({ repoRoot: root, userPathOptions: user }).dials.session.judge.model, 'grok');
  const cleared = runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'judge', session: true });
  assert.equal(cleared.layer, 'session');
  assert.equal(cleared.removed, true);
  assert.equal(runDialShow({ repoRoot: root, userPathOptions: user }).dials.session.judge, undefined);
});

test('set: explicit --user forces user layer even with repo pin', (t) => {
  const root = seedV3(t, { dials: { worker: 'sol' } });
  const user = isolatedUser(root);
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok', user: true });
  assert.equal(result.layer, 'user');
  assert.equal(result.adaptive, false);
  assert.match(result.narrative, /\[user default/);
});

test('set and clear reject more than one explicit scope', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  assert.throws(
    () => runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'sol', session: true, user: true }),
    (err: unknown) => err instanceof DialError && /mutually exclusive/.test(err.message),
  );
  assert.throws(
    () => runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'judge', session: true, repo: true }),
    (err: unknown) => err instanceof DialError && /mutually exclusive/.test(err.message),
  );
});

test('clear: plain clear falls through to the user default when it is the only dial', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok', user: true });
  // No session dial, no repo pin: the user default is the only dial this
  // clear can mean, so it is cleared with the inference marked.
  const cleared = runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'worker' });
  assert.equal(cleared.removed, true);
  assert.equal(cleared.layer, 'user');
  assert.equal(cleared.inferred, true);
  assert.equal(cleared.cleared, 'grok');
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.worker, undefined);
});

test('clear: a repo pin blocks the inference and keeps the user dial untouched', (t) => {
  const root = seedV3(t, { dials: { worker: 'sol' } });
  const user = isolatedUser(root);
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok', user: true });
  const cleared = runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'worker' });
  assert.equal(cleared.removed, false);
  assert.equal(cleared.layer, null);
  assert.equal(cleared.livesAt, 'repo');
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.worker.model, 'grok');
  // Explicit --user still reaches past the pin.
  const clearedUser = runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'worker', user: true });
  assert.equal(clearedUser.removed, true);
  assert.equal(clearedUser.layer, 'user');
});

test('clear: a session dial still wins over the user default on plain clear', (t) => {
  const root = seedV3(t, { dials: { judge: 'sol' } });
  const user = isolatedUser(root);
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'grok', session: true });
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'sol', user: true });
  const cleared = runDialClear({ repoRoot: root, userPathOptions: user, archetype: 'judge' });
  assert.equal(cleared.removed, true);
  assert.equal(cleared.layer, 'session');
  assert.equal(cleared.inferred, undefined);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.judge.model, 'sol');
});

test('clear: no archetype wipes session AND user dials, preserves shadows and repo pins', (t) => {
  const root = seedV3(t, { dials: { judge: 'sol' } });
  const user = isolatedUser(root);
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'judge', model: 'grok', session: true });
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'sol', user: true }); // user
  const clearedAll = runDialClear({ repoRoot: root, userPathOptions: user });
  assert.equal(clearedAll.removed, true);
  assert.equal(clearedAll.count, 2);
  assert.deepEqual(clearedAll.cleared_layers, { session: 1, user: 1 });
  assert.deepEqual(clearedAll.repo_pins_remaining, ['judge']);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(Object.keys(shown.dials.session).length, 0);
  assert.equal(Object.keys(shown.dials.user).length, 0);
  // The committed repo pin still stands.
  assert.equal(shown.dials.repo.judge.model, 'sol');
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
  // @effort on host: no longer refused — it travels as the request, with a
  // note pointing at the materialized agent surface. (worker requires_write
  // would bite here, so pin a posture-free archetype.)
  const hostEffort = runDialSet({ repoRoot: root, userPathOptions: isolatedUser(root), archetype: 'scout', model: 'current-host@high' });
  assert.ok(hostEffort.notes.some((n) => /current-host host route — effort high is recorded as the request/.test(n)), JSON.stringify(hostEffort.notes));
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

test('set many: one model lands on several archetypes atomically', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  const results = runDialSetMany({ repoRoot: root, userPathOptions: user, archetypes: ['judge', 'reviewer'], model: 'sol' });
  assert.deepEqual(results.map((r) => r.archetype ?? null).length, 2);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.judge.model, 'sol');
  assert.equal(shown.dials.user.reviewer.model, 'sol');
});

test('set many: one refused archetype refuses the whole command — nothing written', (t) => {
  // grok's route is write-capable; generator forbids write. worker is fine.
  const root = seedV3(t, {
    archetypes: {
      worker: { requires_write: 'required' },
      generator: { requires_write: 'forbidden' },
    },
  });
  const user = isolatedUser(root);
  assert.throws(
    () => runDialSetMany({ repoRoot: root, userPathOptions: user, archetypes: ['worker', 'generator'], model: 'grok' }),
    (err: unknown) =>
      err instanceof DialError &&
      /nothing was dialed — 1 of 2 archetype\(s\) refused/.test((err as Error).message) &&
      /requires_write: forbidden/.test((err as Error).message),
  );
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.worker, undefined);
  assert.equal(shown.dials.session.worker, undefined);
});

test('set many: reserved words and duplicates handled; single archetype keeps the plain error shape', (t) => {
  const root = seedV3(t);
  const user = isolatedUser(root);
  assert.throws(
    () => runDialSetMany({ repoRoot: root, userPathOptions: user, archetypes: ['judge', 'clear'], model: 'sol' }),
    /reserved word/,
  );
  // Duplicates collapse: judge+judge writes once.
  const results = runDialSetMany({ repoRoot: root, userPathOptions: user, archetypes: ['judge', 'judge'], model: 'sol' });
  assert.equal(results.length, 1);
  // Single-archetype failure keeps the unwrapped message.
  assert.throws(
    () => runDialSetMany({ repoRoot: root, userPathOptions: user, archetypes: ['clear'], model: 'sol' }),
    (err: unknown) => err instanceof DialError && !/nothing was dialed/.test((err as Error).message) && /reserved word/.test((err as Error).message),
  );
});

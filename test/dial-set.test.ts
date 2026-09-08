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

function seedCatalog(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 4,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      luna: { provider: 'openai', id: 'luna-model', effort: 'default' },
    },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', '0'], models_command: ['echo', 'gpt-5.6-sol gpt-5.6-luna grok-4.6'] }, grok: { provider: 'xai', command: ['node', '-e', '0'], models_command: ['echo', 'grok-4.6 gpt-5.6-sol'] } },
    archetypes: {
      worker: { },
      reviewer: { },
      judge: { },
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

test('set: an archetype where a model goes is named as one, not probed as a model', (t) => {
  const root = seedCatalog(t);
  // `fadeno dial scout worker` reads as "make scout follow worker" and is not
  // that: the last argument is a model. It used to fall through to the
  // unregistered-model harness and come back with backend suggestions for a
  // name that was never a model.
  assert.throws(
    () => runDialSet({ repoRoot: root, userPathOptions: isolatedUser(root), archetype: 'reviewer', model: 'worker', session: true }),
    (err: unknown) => err instanceof DialError
      && /"worker" is an archetype, not a model/.test((err as Error).message)
      // Both real ways to get what was meant, named in full.
      && /fadeno dial reviewer worker <model>/.test((err as Error).message)
      && /archetypes\.reviewer\.fallback: worker/.test((err as Error).message),
  );
  // Nothing was written.
  assert.equal(runDialShow({ repoRoot: root, userPathOptions: isolatedUser(root) }).dials.session.reviewer, undefined);
});

test('set: dial round-trip through pin file (user default)', (t) => {
  const root = seedCatalog(t);
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
  const root = seedCatalog(t, { dials: { worker: 'sol' } });
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
  const root = seedCatalog(t);
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
  const root = seedCatalog(t);
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
  const root = seedCatalog(t, { dials: { worker: 'sol' } });
  const user = isolatedUser(root);
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok', user: true });
  assert.equal(result.layer, 'user');
  assert.equal(result.adaptive, false);
  assert.match(result.narrative, /\[user default/);
});

test('set and clear reject more than one explicit scope', (t) => {
  const root = seedCatalog(t);
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
  const root = seedCatalog(t);
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
  const root = seedCatalog(t, { dials: { worker: 'sol' } });
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
  const root = seedCatalog(t, { dials: { judge: 'sol' } });
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

test('clear: no archetype wipes session AND user dials, and leaves repo pins standing', (t) => {
  const root = seedCatalog(t, { dials: { judge: 'sol' } });
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
  const root = seedCatalog(t);
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

test('set time validates against the REGISTRY only — no lane notes, nothing about the call', (t) => {
  // Catalog v4 moved both of these out of `dial set`. A dial is stored
  // host-neutrally and re-resolved at every dispatch, so narrating the lane a
  // pin would take made `fadeno dial worker opus@xhigh` print a different
  // story depending on which terminal you typed it in — and refusing on
  // eligibility refused dials that resolve perfectly well on another lane or
  // another host. Both questions are about a CALL; both are answered where a
  // host exists (`dial resolve`, and the dispatch kernel).
  const root = seedCatalog(t, {
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      plain: { provider: 'openai', id: 'plain-model', effort: 'high' },
    },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', '0'] } },
    archetypes: { worker: { } },
  });
  const user = isolatedUser(root);

  // An `@effort` pin on a host-shaped dial is recorded, silently.
  const hostEffort = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'scout', model: 'current-host@high' });
  assert.equal(hostEffort.pinned_effort, 'high');
  assert.deepEqual(hostEffort.notes, [], 'no lane narration at set time');

  // Any model this catalog can compile dials, and `dial resolve` answers what
  // it resolves to. Nothing here asks a model to justify itself.
  assert.doesNotThrow(() => runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'plain' }));
  assert.equal(runDialResolve({ repoRoot: root, userPathOptions: user, archetype: 'worker' }).model, 'plain');

  // An unknown `--harness` IS refused at set time: it is the one thing a dial
  // can be wrong about without knowing anything about the call.
  assert.throws(
    () => runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'sol', harness: 'nope' }),
    (err: unknown) => err instanceof DialError && /unknown harness "nope" — declared harnesses: codex/.test(err.message),
  );
  assert.doesNotThrow(() => runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'sol', harness: 'codex' }));
});

test('probe: verified/cached/unverified/refused via injected spawn', (t) => {
  const root = seedCatalog(t);
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
  const root = seedCatalog(t);
  const user = isolatedUser(root);
  const results = runDialSetMany({ repoRoot: root, userPathOptions: user, archetypes: ['judge', 'reviewer'], model: 'sol' });
  assert.deepEqual(results.map((r) => r.archetype ?? null).length, 2);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.judge.model, 'sol');
  assert.equal(shown.dials.user.reviewer.model, 'sol');
});

test('set many: one refused archetype refuses the whole command — nothing written', (t) => {
  // The all-or-nothing invariant. Re-pinned on the refusal that survives at
  // set time under v4 — an archetype name that is not a bare identifier —
  // because eligibility no longer refuses here (it is a dispatch-time
  // question). The property under test, that a partial multi-set writes
  // NOTHING, is unrelated to which predicate did the refusing.
  const root = seedCatalog(t, {
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
    },
  });
  const user = isolatedUser(root);
  assert.throws(
    () => runDialSetMany({ repoRoot: root, userPathOptions: user, archetypes: ['worker', 'Generator'], model: 'grok' }),
    (err: unknown) =>
      err instanceof DialError &&
      /nothing was dialed — 1 of 2 archetype\(s\) refused/.test((err as Error).message) &&
      /bare lowercase identifier/.test((err as Error).message),
  );
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(shown.dials.user.worker, undefined);
  assert.equal(shown.dials.session.worker, undefined);
});

test('set many: reserved words and duplicates handled; single archetype keeps the plain error shape', (t) => {
  const root = seedCatalog(t);
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

test('a dial that introduces a provider nothing else uses says so', (t) => {
  const root = seedCatalog(t);
  const opts = { repoRoot: root, userPathOptions: onHarness('standalone') };
  // Seed the repo on one vendor. `sol` is openai; every other slot falls back
  // to the host baseline, which has no provider to vouch for anything.
  runDialSet({ ...opts, archetype: 'worker', model: 'sol', session: true });

  // Another slot on the same vendor is not new egress — the repo already
  // talks to them.
  const familiar = runDialSet({ ...opts, archetype: 'reviewer', model: 'sol', session: true });
  assert.ok(!familiar.notes.some((n) => n.includes('NEW PROVIDER')), familiar.notes.join('\n'));

  // xai is.
  const novel = runDialSet({ ...opts, archetype: 'judge', model: 'grok', session: true });
  const warning = novel.notes.find((n) => n.includes('NEW PROVIDER'));
  assert.ok(warning, novel.notes.join('\n'));
  assert.match(warning!, /judge → grok routes to "xai"/);

  // And once xai is dialed somewhere, it stops being news.
  const repeat = runDialSet({ ...opts, archetype: 'worker', model: 'grok', session: true });
  assert.ok(!repeat.notes.some((n) => n.includes('NEW PROVIDER')), repeat.notes.join('\n'));
});

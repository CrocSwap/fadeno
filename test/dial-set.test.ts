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
  runDialShadow,
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
  // @effort on host: no longer refused — but what the pin DOES splits by
  // harness, and `current-host` on standalone is the inert case: no agent
  // format to carry an effort, and no command lane to divert to either. The
  // note must say that rather than send the user to a `steering apply` that
  // writes nothing. (worker requires_write would bite here, so pin a
  // posture-free archetype.)
  const hostEffort = runDialSet({ repoRoot: root, userPathOptions: isolatedUser(root), archetype: 'scout', model: 'current-host@high' });
  assert.ok(hostEffort.notes.some((n) => /has no command lane, so scout runs in-session at the session's own effort/.test(n)), JSON.stringify(hostEffort.notes));
  assert.ok(hostEffort.notes.every((n) => !/run `fadeno steering apply`/.test(n)), JSON.stringify(hostEffort.notes));
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

test('a dial that introduces a provider nothing else uses says so', (t) => {
  const root = seedV3(t);
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

test('a shadow attachment gets the same provider check, scoped to its own slot', (t) => {
  const root = seedV3(t);
  const opts = { repoRoot: root, userPathOptions: onHarness('standalone') };
  runDialSet({ ...opts, archetype: 'worker', model: 'sol', session: true });

  // The slot is the unit, not the archetype: shadowing worker with the vendor
  // worker already dials duplicates the prompt to nobody new.
  const sameVendor = runDialShadow({ ...opts, archetype: 'worker', model: 'sol' });
  assert.ok(!sameVendor.notes.some((n) => n.includes('NEW PROVIDER')), sameVendor.notes.join('\n'));

  // A challenger at a vendor this repo has never dialed is the case the
  // warning exists for — a shadow is standing egress once attached.
  const novel = runDialShadow({ ...opts, archetype: 'worker', model: 'grok' });
  const warning = novel.notes.find((n) => n.includes('NEW PROVIDER'));
  assert.ok(warning, novel.notes.join('\n'));
  assert.match(warning!, /worker ~ grok routes to "xai"/);
  assert.match(warning!, /duplicates the prompt/);
});

test('a shadow attachment warns at set time when the primary has no command lane to force', (t) => {
  const root = seedV3(t);
  // Isolated user scope: this checks the truly undialed base, so it must not
  // pick up whatever the real machine's user-scoped worker dial happens to be.
  const opts = { repoRoot: root, userPathOptions: isolatedUser(root) };
  // worker carries no primary dial anywhere, so it falls through to the
  // current-host base — a host executor with no fallback_command. A selected
  // pair has nothing to reuse for the command lane, so this attachment could
  // sample forever and never produce a pair; dispatch time is too late to
  // say so.
  const result = runDialShadow({ ...opts, archetype: 'worker', model: 'sol' });
  const warning = result.notes.find((n) => n.includes('NO PAIR POSSIBLE'));
  assert.ok(warning, result.notes.join('\n'));
  assert.match(warning!, /worker.*current-host.*no fallback_command/s);

  // A warning, not a refusal: dialing the primary onto a command-capable
  // executor afterwards makes the same attachment usable without touching
  // the shadow attachment itself.
  runDialSet({ ...opts, archetype: 'worker', model: 'grok', session: true });
  const fixed = runDialShadow({ ...opts, archetype: 'worker', model: 'sol' });
  assert.ok(!fixed.notes.some((n) => n.includes('NO PAIR POSSIBLE')), fixed.notes.join('\n'));
});

test('dial resolve: shadow.routable mirrors whether the kernel could force the primary onto a command lane', (t) => {
  const root = seedV3(t);
  // Isolated user scope, same reason as above: the undialed check must not
  // depend on the real machine's ambient user dial for worker.
  const opts = { repoRoot: root, userPathOptions: isolatedUser(root) };
  runDialShadow({ ...opts, archetype: 'worker', model: 'sol' });

  // Undialed worker resolves to current-host, a host executor with no
  // fallback_command — the same condition `dispatchability` reports as
  // host_in_session/host_without_fallback and `pairCommandFallback` refuses.
  const unroutable = runDialResolve({ ...opts, archetype: 'worker' });
  assert.equal(unroutable.shadow?.routable, false);
  // `selected` is unaffected — it stays a pure function of the roll, and
  // with no rate on the attachment every dispatch "fires" the roll.
  assert.equal(unroutable.shadow?.selected, true);

  // Once the primary is dialed to a command executor, `routable` flips
  // without the shadow attachment changing at all.
  runDialSet({ ...opts, archetype: 'worker', model: 'grok', session: true });
  const routable = runDialResolve({ ...opts, archetype: 'worker' });
  assert.equal(routable.shadow?.routable, true);
});

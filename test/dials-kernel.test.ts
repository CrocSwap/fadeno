import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  BARE_IDENTIFIER_RE,
  resolveDelivery,
  deliveryIsHost,
  DIALS_LOCAL_FILE,
  LOCAL_DIALS_SCHEMA_VERSION,
  ExecutorProfileError,
  formatDialRef,
  parseDialRef,
  parseExecutorProfile,
  readLocalDialState,
  resolveDialCascade,
  resolveRole,
  roleResolutionEchoLabel,
  writeLocalDialState,
  type ExecutorProfile,
  type LocalDialState,
} from '../src/lib/executors.ts';
import { readUserDials, userPaths, UserDialsError, writeUserDials, type UserPathOptions } from '../src/lib/user-paths.ts';
import { exists, read, tempRepo } from './helpers.ts';

function parseDoc(doc: Record<string, unknown>, harness: 'standalone' | 'codex' | 'claude' = 'standalone'): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml', harness);
}

// --- v3 strict parsing ---

test('pre-dials catalogs are rejected with schema_version 3 message', () => {
  assert.throws(
    () => parseDoc({ schema_version: 2, targets: { opus: { provider: 'anthropic', model: 'opus' } }, harnesses: { claude: { provider: 'anthropic', command: ['claude', '-p'] } }, loadouts: { main: { worker: 'opus' } } }),
    (err: unknown) => err instanceof ExecutorProfileError && /schema_version 4 required/.test(err.message) && /pre-dials catalogs are not supported/.test(err.message) && /targets:→models:/.test(err.message) && /loadouts:→dials:/.test(err.message) && /routes:→harnesses:/.test(err.message),
  );
  assert.throws(
    () => parseDoc({ targets: { opus: { provider: 'anthropic', model: 'opus' } }, harnesses: { claude: { provider: 'anthropic', command: ['claude', '-p'] } }, bindings: { '*': 'opus' } }),
    (err: unknown) => err instanceof ExecutorProfileError && /schema_version 4 required/.test(err.message),
  );
  assert.throws(
    () => parseDoc({ executors: { foo: { adapter: 'command', command: ['x'] } }, bindings: { '*': 'foo' } }),
    /schema_version 4 required/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 1, executors: { foo: { adapter: 'command', command: ['x'] } }, bindings: { '*': 'foo' } }),
    /schema_version 4 required/,
  );
});

test('schema_version 4 requires models', () => {
  assert.throws(() => parseDoc({ schema_version: 4, harnesses: { codex: { provider: 'openai', command: ['x'] } } }), /schema_version 4 required/);
  assert.throws(() => parseDoc({ schema_version: 4, models: {}, harnesses: { codex: { provider: 'openai', command: ['x'] } } }), /schema_version 4 required/);
});

test('v4 models registry happy path', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'default', spellings: { opencode: 'anthropic/claude-opus-4.8' } },
    },
    harnesses: { codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}'] }, claude: { provider: 'anthropic', command: ['claude', '-p', '--model', '{model}'] }, grok: { provider: 'xai', command: ['grok', '--model', '{model}'] }, opencode: { command: ['opencode', 'run', '-m', '{model}'] } },
    archetypes: { worker: { }, judge: {} },
    dials: { judge: 'opus' },
    bindings: { my_role: 'sol@high' },
    unregistered_model_harness: 'opencode',
  });
  assert.equal(profile.schemaVersion, 4);
  assert.equal(profile.models.sol!.provider, 'openai');
  assert.equal(profile.models.sol!.id, 'gpt-5.6-sol');
  assert.equal(profile.models.sol!.effort, 'high');
  assert.equal(profile.models.opus!.spellings.opencode, 'anthropic/claude-opus-4.8');
  assert.deepEqual(profile.dials, { judge: { model: 'opus' } });
  assert.deepEqual(profile.bindings, { my_role: { model: 'sol', effort: 'high' } });
  assert.equal(profile.unregisteredModelHarness, 'opencode');
  assert.ok(Object.hasOwn(profile.models, 'host'));
  assert.equal(profile.models['host']!.provider, 'host');
  const withDefaultId = parseDoc({
    schema_version: 4,
    models: { foo: { provider: 'openai' } },
    harnesses: { codex: { provider: 'openai', command: ['x'] } },
  });
  assert.equal(withDefaultId.models.foo!.id, 'foo');
  assert.equal(withDefaultId.models.foo!.effort, 'default');
});

test('declaring built-in host is error', () => {
  assert.throws(() => parseDoc({ schema_version: 4, models: { 'host': { provider: 'openai' } }, harnesses: { codex: { provider: 'openai', command: ['x'] } } }), /built-in/);
});

test('v4 harness entries carry provider and effort_encoding', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { gem: { provider: 'google', id: 'gemini-3.1-pro', effort: 'high' } },
    harnesses: { agy: { provider: 'google', command: ['agy', '--model', '{model}'], effort_encoding: 'model-suffix' }, codex: { provider: 'openai', command: ['codex', 'exec', '{model}'] } },
  });
  assert.equal(profile.harnesses.agy!.provider, 'google');
  assert.equal(profile.harnesses.agy!.effort_encoding, 'model-suffix');
  assert.throws(() => parseDoc({ schema_version: 4, models: { m: { provider: 'google' } }, harnesses: { agy: { provider: 'google', effort_encoding: 'bad', command: ['x'] } } }), /effort_encoding.*flag.*model-suffix/);
});

test('v4 refuses two harnesses claiming one provider as home', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 4,
      models: { sol: { provider: 'openai' } },
      harnesses: { codex: { provider: 'openai', command: ['codex'] }, other: { provider: 'openai', command: ['other'] } },
    }),
    /provider "openai" is claimed as home by two harnesses \(codex, other\)/,
  );
});

test('v4 refuses a harness that is neither host nor executor', () => {
  assert.throws(
    () => parseDoc({ schema_version: 4, models: { sol: { provider: 'openai' } }, harnesses: { codex: { provider: 'openai' } } }),
    /declares neither `host:` .* nor `command:`/,
  );
});

test('v4 explicit model harness + spelling, and the removed `delivery:` migration note', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: {
      moonshot: {
        provider: 'stealth', id: 'ox-alpha',
        // `harness:` + `spellings.<harness>` replaced `delivery: {route, id}`.
        harness: 'opencode',
        spellings: { opencode: 'stealth/ox-alpha' },
      },
    },
    harnesses: { opencode: { command: ['opencode', 'run', '-m', 'openrouter/{model}'], models_prefix: 'openrouter/' } },
  });
  assert.equal(profile.models.moonshot!.harness, 'opencode');
  assert.equal(profile.harnesses.opencode!.modelsPrefix, 'openrouter/');
  assert.equal(resolveDelivery({ model: 'moonshot' }, profile).modelId, 'stealth/ox-alpha');
  assert.throws(
    () => parseDoc({ schema_version: 4, models: { m: { provider: 'p', delivery: { route: 'r', id: 'x' } } }, harnesses: { p: { provider: 'p', command: ['x'] } } }),
    /`delivery` was removed in catalog v4/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 4, models: { m: { provider: 'p', harness: 'nope' } }, harnesses: { p: { provider: 'p', command: ['x'] } } }),
    /names harness "nope", which is not declared/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 4, models: { m: { provider: 'p' } }, harnesses: { p: { provider: 'p', command: ['x'], models_prefix: 'has space' } } }),
    /models_prefix.*whitespace-free/,
  );
});

test('v4 harnesses reject the retired `native:` alias — only `host:` parses', () => {
  assert.throws(
    () => parseDoc({ schema_version: 4, models: { sol: { provider: 'openai' } }, harnesses: { codex: { provider: 'openai', command: ['x'], native: true } as unknown as Record<string, unknown> } }),
    /unknown key.*native|host/,
  );
});

test('bindings "*" is accepted but ignored with deprecation note', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' } },
    harnesses: { codex: { provider: 'openai', command: ['x'] } },
    bindings: { '*': 'sol', my_role: 'sol' },
  });
  assert.deepEqual(profile.bindings, { my_role: { model: 'sol' } });
  assert.ok(profile.notes.some((n) => n.includes('binding "*"`') || n.includes('deprecated')));
});

test('DialRef parse/format', () => {
  assert.deepEqual(parseDialRef('sol', 'test'), { model: 'sol' });
  assert.deepEqual(parseDialRef('sol@high', 'test'), { model: 'sol', effort: 'high' });
  assert.deepEqual(parseDialRef({ model: 'sol', effort: 'high', harness: 'opencode' }, 'test'), { model: 'sol', effort: 'high', harness: 'opencode' });
  assert.deepEqual(parseDialRef('sol@high on opencode', 'test'), { model: 'sol', effort: 'high', harness: 'opencode' });
  assert.equal(formatDialRef({ model: 'sol' }), 'sol');
  assert.equal(formatDialRef({ model: 'sol', effort: 'xhigh' }), 'sol@xhigh');
  assert.equal(formatDialRef({ model: 'opus', harness: 'opencode' }), 'opus on opencode');
  assert.equal(formatDialRef({ model: 'sol', effort: 'xhigh', harness: 'opencode' }), 'sol@xhigh on opencode');
  assert.deepEqual(parseDialRef(formatDialRef({ model: 'sol', effort: 'high', harness: 'opencode' }), 't'), { model: 'sol', effort: 'high', harness: 'opencode' });
  // Legacy ` via <driver>` is READ and translated — never emitted back. The
  // variant half of a driver name is dropped, which is what re-rolls a shadow
  // sample keyed on the challenger string. See CHANGELOG.
  assert.deepEqual(parseDialRef('sonnet via claude-exec', 't'), { model: 'sonnet', harness: 'claude' });
  assert.equal(formatDialRef(parseDialRef('sonnet via claude-exec', 't')), 'sonnet on claude');
  assert.deepEqual(parseDialRef('m via opencode-direct', 't'), { model: 'm', harness: 'opencode' });
  assert.deepEqual(parseDialRef('m via muse-code', 't'), { model: 'm', harness: 'muse' });
  assert.deepEqual(parseDialRef({ model: 'm', via: 'claude-cli' }, 't'), { model: 'm', harness: 'claude' });
  assert.deepEqual(parseDialRef('m via grok', 't'), { model: 'm', harness: 'grok' }, 'a name that was already a harness passes through');
  assert.throws(() => parseDialRef('', 'dials.judge'), /empty string/);
  assert.throws(() => parseDialRef('sol@', 'dials.judge'), /valid dial ref/);
  assert.throws(() => parseDialRef({ model: '' }, 'dials.judge'), /non-empty "model"/);
  assert.throws(() => parseDialRef({ model: 'sol', effort: '' }, 'x'), /"effort" must be a non-empty string/);
  assert.throws(
    () => parseDialRef({ model: 'sol', force_write_posture: true }, 'x'),
    /"force_write_posture" is no longer supported/,
    'a forced dial refuses rather than silently losing its override',
  );
  assert.throws(() => parseDialRef(42, 'x'), /must be a string/);
});

test('user dials: force_write_posture is refused there too, not just in the catalog', (t) => {
  // The gap this closes. `parseDialRef` above already refused the key, but a
  // USER dial never reaches that parser — `drive` reads the user dials file
  // with `readUserDials` and casts the result straight to `DialRef`. So the
  // flag rode along invisibly, satisfying nothing and overriding a guard that
  // no longer exists. Two parsers for one vocabulary, agreeing on everything
  // except the one key that was removed.
  const root = tempRepo(t);
  const user: UserPathOptions = { home: join(root, 'home'), env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state') } };

  // A plain dial still round-trips, and now writes the string form: the object
  // form existed only to carry this key.
  writeUserDials(user, { worker: { model: 'sol', effort: 'high', harness: 'opencode' } });
  assert.deepEqual(readUserDials(user), { worker: { model: 'sol', effort: 'high', harness: 'opencode' } });
  assert.match(readFileSync(userPaths(user).dialsFile, 'utf8'), /"worker":\s*"sol@high on opencode"/);
  // A user dials file written before v4 still reads, translated once.
  writeFileSync(userPaths(user).dialsFile, JSON.stringify({ worker: 'sol@high via opencode-direct' }), 'utf8');
  assert.deepEqual(readUserDials(user), { worker: { model: 'sol', effort: 'high', harness: 'opencode' } });

  // A file written by an older version still carries the key. It refuses with
  // a pointer and names the remedy, rather than being read as an ordinary dial
  // with one key quietly dropped.
  writeFileSync(userPaths(user).dialsFile, JSON.stringify({ worker: { model: 'sol', force_write_posture: true } }), 'utf8');
  assert.throws(
    () => readUserDials(user),
    (err: unknown) =>
      err instanceof UserDialsError &&
      /"force_write_posture", which is no longer supported/.test((err as Error).message) &&
      /no write-posture guard left to override/.test((err as Error).message),
  );

  // An unreadable dials file still degrades to {}. That is deliberate and must
  // not be swept up by the refusal above: a corrupt personal config should not
  // stop every command, while a config stating something untrue should.
  writeFileSync(userPaths(user).dialsFile, '{ not json', 'utf8');
  assert.deepEqual(readUserDials(user), {});
});

test('resolveDelivery: registered home harness', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' } },
    harnesses: { codex: { provider: 'openai', command: ['codex', 'exec', '-m', '{model}', '--effort', '{reasoning_effort}'] } },
  });
  const compiled = resolveDelivery({ model: 'sol' }, profile);
  assert.equal(compiled.registered, true);
  assert.equal(compiled.provider, 'openai');
  assert.equal(compiled.harness, 'codex');
  assert.equal(compiled.effectiveEffort, 'high');
  // No `@effort` on the dial: the registry default fills the effective effort,
  // and the absent pin stays visible as null.
  assert.equal(compiled.pinnedEffort, null);
  assert.equal(compiled.model, 'sol');
  assert.equal(compiled.modelId, 'gpt-5.6-sol');
  assert.equal(compiled.spec.adapter, 'command');
  assert.deepEqual(compiled.spec.adapter === 'command' ? compiled.spec.command : null, ['codex','exec','-m','gpt-5.6-sol','--effort','high']);
  const over = resolveDelivery({ model: 'sol', effort: 'low' }, profile);
  assert.equal(over.effectiveEffort, 'low');
  assert.equal(over.pinnedEffort, 'low');
  assert.deepEqual(over.spec.adapter === 'command' ? over.spec.command : null, ['codex','exec','-m','gpt-5.6-sol','--effort','low']);
});

test('resolveDelivery: spellings are keyed by harness', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { opus: { provider: 'anthropic', id: 'opus', effort: 'default', spellings: { opencode: 'anthropic/claude-opus-4.8' } } },
    harnesses: { claude: { provider: 'anthropic', command: ['claude', '-p', '--model', '{model}'] }, opencode: { command: ['opencode', 'run', '-m', '{model}'] } },
  });
  const onHarness = resolveDelivery({ model: 'opus', harness: 'opencode' }, profile);
  assert.equal(onHarness.modelId, 'anthropic/claude-opus-4.8');
  assert.equal(onHarness.harness, 'opencode');
  assert.equal(onHarness.spec.adapter, 'command');
  assert.deepEqual(onHarness.spec.adapter === 'command' ? onHarness.spec.command : null, ['opencode','run','-m','anthropic/claude-opus-4.8']);
  const home = resolveDelivery({ model: 'opus' }, profile);
  assert.equal(home.modelId, 'opus');
});

test('resolveDelivery: effort_encoding model-suffix', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { gem: { provider: 'google', id: 'gemini-3.1-pro', effort: 'high' } },
    harnesses: { agy: { provider: 'google', command: ['agy', '--model', '{model}'], effort_encoding: 'model-suffix' } },
  });
  const base = resolveDelivery({ model: 'gem' }, profile);
  assert.equal(base.modelId, 'gemini-3.1-pro-high');
  const def = parseDoc({
    schema_version: 4,
    models: { gem: { provider: 'google', id: 'gemini-3.1-pro', effort: 'default' } },
    harnesses: { agy: { provider: 'google', command: ['agy', '--model', '{model}'], effort_encoding: 'model-suffix' } },
  });
  const low = resolveDelivery({ model: 'gem' }, def);
  assert.equal(low.modelId, 'gemini-3.1-pro');
  const over = resolveDelivery({ model: 'gem', effort: 'low' }, def);
  assert.equal(over.modelId, 'gemini-3.1-pro-low');
});

test('resolveDelivery: unregistered fall-through onto the default harness', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai', harness: 'opencode' } },
    harnesses: { opencode: { command: ['opencode', 'run', '-m', '{model}'] } },
    unregistered_model_harness: 'opencode',
  });
  const compiled = resolveDelivery({ model: 'kimi-k3' }, profile);
  assert.equal(compiled.registered, false);
  assert.equal(compiled.provider, null);
  assert.equal(compiled.harness, 'opencode');
  assert.equal(compiled.modelId, 'kimi-k3');
  assert.equal(compiled.effectiveEffort, 'default');
  assert.equal(compiled.pinnedEffort, null);
  const withEffort = resolveDelivery({ model: 'kimi-k3', effort: 'high' }, profile);
  assert.equal(withEffort.effectiveEffort, 'high');
  assert.equal(withEffort.pinnedEffort, 'high');
  const profile2 = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai', harness: 'opencode' } },
    harnesses: { opencode: { command: ['opencode', 'run', '-m', '{model}'] }, agy: { provider: 'google', command: ['agy', '--model', '{model}'] } },
  });
  const explicit = resolveDelivery({ model: 'my-model', harness: 'agy' }, profile2);
  assert.equal(explicit.harness, 'agy');
});

test('resolveDelivery: unknown harness error naming the declared table', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' } },
    harnesses: { codex: { provider: 'openai', command: ['codex', 'exec'] }, grok: { provider: 'xai', command: ['grok', '--model', '{model}'] }, opencode: { command: ['opencode', 'run'] } },
  });
  assert.throws(() => resolveDelivery({ model: 'sol', harness: 'unknown' }, profile), (err: unknown) => err instanceof ExecutorProfileError && /unknown harness "unknown"/.test(err.message) && /codex/.test(err.message) && /opencode/.test(err.message));
  assert.throws(() => resolveDelivery({ model: 'nope-model', harness: 'bad' }, profile), /unknown harness/);
  assert.throws(() => resolveDelivery({ model: 'nope-model' }, parseDoc({ schema_version: 4, models: { sol: { provider: 'xai' } }, harnesses: { grok: { provider: 'xai', command: ['grok'] } }, unregistered_model_harness: 'opencode' })), /unknown harness "opencode"/);
});

test('resolveDelivery: host built-in host compiles to host', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' } },
    harnesses: { codex: { provider: 'openai', command: ['codex'] } },
  });
  const host = resolveDelivery({ model: 'host' }, profile);
  assert.equal(host.spec.adapter, 'host');
  assert.equal(deliveryIsHost(host), true);
  assert.equal(host.effectiveEffort, 'default');
  const profile2 = parseDoc({ schema_version: 4, models: { sol: { provider: 'openai' } }, harnesses: { codex: { provider: 'openai', command: ['codex'] } } });
  const implicit = resolveDelivery({ model: 'host' }, profile2);
  assert.equal(implicit.spec.adapter, 'host');
});

test('archetypes: requires_write parses; an absent block is an empty map', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' } },
    harnesses: { codex: { provider: 'openai', command: ['codex'] } },
    archetypes: { worker: { }, reviewer: { } },
  });
  assert.deepEqual(profile.archetypes, {
    worker: { fallback: null, description: null },
    reviewer: { fallback: null, description: null },
  });
  assert.deepEqual(parseDoc({ schema_version: 4, models: { sol: { provider: 'openai' } }, harnesses: { codex: { provider: 'openai', command: ['x'] } } }).archetypes, {});
});

test('archetypes: strict validation names the offending path', () => {
  assert.throws(
    () => parseDoc({ schema_version: 4, models: { sol: { provider: 'openai' } }, harnesses: { codex: { provider: 'openai', command: ['x'] } }, archetypes: 'worker' as unknown as Record<string, unknown> }),
    /`archetypes` is not a mapping/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 4, models: { sol: { provider: 'openai' } }, harnesses: { codex: { provider: 'openai', command: ['x'] } }, archetypes: { worker: 'yes' as unknown as Record<string, unknown> } }),
    /`archetypes\.worker` is not a mapping/,
  );
});

// --- pin v3 ---

test('pin v4: write and read round-trip (dial keys sorted)', (t) => {
  const root = tempRepo(t);
  assert.deepEqual(readLocalDialState(root), { dials: {} });
  const state: LocalDialState = { dials: { generator: { model: 'gem' }, worker: { model: 'sol', effort: 'high' }, reviewer: { model: 'opus' } } };
  const path = writeLocalDialState(root, state);
  assert.equal(path, join(root, DIALS_LOCAL_FILE));
  const text = read(root, DIALS_LOCAL_FILE);
  // The stamp leads, so a person opening the file to debug a dial sees which
  // shape they are looking at before the payload. Spelled from the constant:
  // a version bump must not need this literal edited twice.
  assert.equal(
    text,
    `{"schema_version":${LOCAL_DIALS_SCHEMA_VERSION},"dials":{"generator":"gem","reviewer":"opus","worker":"sol@high"}}\n`,
  );
  assert.deepEqual(readLocalDialState(root).dials, { generator: { model: 'gem' }, worker: { model: 'sol', effort: 'high' }, reviewer: { model: 'opus' } });
  writeLocalDialState(root, { dials: {} });
  assert.equal(exists(root, DIALS_LOCAL_FILE), false);
});

test('a file this fadeno cannot read is refused by name, never read as "no dials"', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // A pre-0.6 loadout pin, a pre-0.7 shadow attachment, and a stamp from the
  // future: three shapes this reader does not understand. Each one decides
  // which model runs, so each is an error naming the file and the fix — the
  // one thing that must never happen is a silent fall-through to zero dials.
  for (const body of ['openai-primary\n', '{"loadout":"x","overrides":{"worker":"luna-cli"}}\n', '{"dials":{},"shadows":{"worker":{"model":"opus"}}}\n', '{"schema_version":99,"dials":{}}\n']) {
    writeFileSync(join(root, DIALS_LOCAL_FILE), body, 'utf8');
    assert.throws(() => readLocalDialState(root), /\.fadeno\/local\/dials .*Fix: delete it/s, body);
  }
  writeFileSync(join(root, DIALS_LOCAL_FILE), '   \n', 'utf8');
  assert.deepEqual(readLocalDialState(root), { dials: {} });
});

test('pin v3: an unreadable pin names the file and how to reset it', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"dials": 42}\n', 'utf8');
  assert.throws(() => readLocalDialState(root), (err: unknown) => err instanceof ExecutorProfileError && (err.message.includes(DIALS_LOCAL_FILE) && /delete it/.test(err.message) && /fadeno dial <archetype> <model>/.test(err.message)));
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"dials":{"Worker":"sol"}}\n', 'utf8');
  assert.throws(() => readLocalDialState(root), /bare lowercase identifier/);
});

// --- cascade ---

test('cascade: binding-first, then session→repo→user, base terminal', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' }, opus: { provider: 'anthropic' } },
    harnesses: { codex: { provider: 'openai', command: ['codex'] }, grok: { provider: 'xai', command: ['grok'] }, claude: { provider: 'anthropic', command: ['claude'] } },
    bindings: { my_role: 'sol' },
    dials: { worker: 'grok' },
  });
  const Layers = {
    session: { worker: { model: 'opus' } },
    repo: profile.dials,
    user: { worker: { model: 'sol' } },
  };
  const b = resolveDialCascade('my_role', 'worker', { bindings: profile.bindings, archetypes: profile.archetypes }, Layers);
  assert.equal(b.source, 'binding');
  assert.deepEqual(b.ref, { model: 'sol' });

  const profileNoBinding = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' } },
    harnesses: { codex: { provider: 'openai', command: ['x'] }, grok: { provider: 'xai', command: ['y'] } },
    dials: { worker: 'sol' },
    archetypes: { worker: { fallback: 'reviewer' } },
  });
  const layers2 = { session: { worker: { model: 'grok' } }, repo: profileNoBinding.dials, user: { worker: { model: 'sol' } } };
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, layers2).source, 'session');
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, { session: {}, repo: profileNoBinding.dials, user: { worker: { model: 'sol' } } }).source, 'repo');
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, { session: {}, repo: {}, user: { worker: { model: 'sol' } } }).source, 'user');
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, { session: {}, repo: {}, user: {} }).source, 'base');
  assert.deepEqual(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: {} }, { session: {}, repo: {}, user: {} }).ref, { model: 'host' });
  assert.equal(resolveDialCascade('arbitrary', null, { bindings: {}, archetypes: {} }, { session: {}, repo: {}, user: {} }).source, 'base');
});

test('cascade: fallback chain via archetypes', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' } },
    harnesses: { codex: { provider: 'openai', command: ['x'] }, grok: { provider: 'xai', command: ['y'] } },
    archetypes: { generator: { fallback: 'worker' } },
    dials: { worker: 'sol' },
  });
  const res = resolveDialCascade('r', 'generator', { bindings: {}, archetypes: profile.archetypes }, { session: {}, repo: profile.dials, user: {} });
  assert.deepEqual(res.ref, { model: 'sol' });
  assert.equal(res.resolvedVia, 'worker');
  const direct = resolveDialCascade('r', 'worker', { bindings: {}, archetypes: profile.archetypes }, { session: {}, repo: profile.dials, user: {} });
  assert.equal(direct.resolvedVia, null);
});

test('cascade: prototype hardening (hasOwn)', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai' } },
    harnesses: { codex: { provider: 'openai', command: ['x'] } },
  });
  const plain: Record<string, { model: string }> = {};
  const res2 = resolveDialCascade('role', 'toString', { bindings: {}, archetypes: {} }, { session: plain, repo: {}, user: {} });
  assert.equal(res2.source, 'base');
  const bindingsProto = Object.create({ my_role: { model: 'sol' } }) as Record<string, { model: string }>;
  const res3 = resolveDialCascade('my_role', null, { bindings: bindingsProto, archetypes: {} }, { session: {}, repo: {}, user: {} });
  assert.equal(res3.source, 'base');
});

test('resolveRole: live resolution cascade+compile', () => {
  const profile = parseDoc({
    schema_version: 4,
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol' }, grok: { provider: 'xai', id: 'grok-4.6' } },
    harnesses: { codex: { provider: 'openai', command: ['codex', '--model', '{model}'] }, grok: { provider: 'xai', command: ['grok', '--model', '{model}'] } },
    dials: { worker: 'sol' },
    archetypes: { worker: {} },
  });
  const layers = { session: {}, repo: profile.dials, user: {} };
  const res = resolveRole('coder', 'worker', profile, layers);
  assert.equal(res.source, 'repo');
  assert.equal(res.delivery.model, 'sol');
  assert.equal(res.delivery.spec.adapter, 'command');
  assert.equal(roleResolutionEchoLabel(res.source), 'repo');
});

test('roleResolutionEchoLabel vocabulary: one word per layer, and null where none answered', () => {
  assert.equal(roleResolutionEchoLabel('binding'), 'binding');
  assert.equal(roleResolutionEchoLabel('session'), 'session');
  assert.equal(roleResolutionEchoLabel('repo'), 'repo');
  assert.equal(roleResolutionEchoLabel('user'), 'user');
  // `base` is the absence of a dial, not a layer. The word for that belongs to
  // the surface: an empty cell in a table, "no dial" in prose.
  assert.equal(roleResolutionEchoLabel('base'), null);
});

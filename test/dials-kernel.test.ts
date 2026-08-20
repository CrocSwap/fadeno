import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  BARE_IDENTIFIER_RE,
  applyWritePosture,
  compileDialRef,
  deliveryIsHost,
  DIALS_LOCAL_FILE,
  eligibilityFor,
  ExecutorProfileError,
  explainWriteConflict,
  formatDialRef,
  forcesWritePosture,
  parseDialRef,
  parseExecutorProfile,
  parseSnapshotDocument,
  readLocalDialState,
  resolveDialCascade,
  resolveRole,
  roleResolutionEchoLabel,
  serializeSnapshot,
  writeLocalDialState,
  type ExecutorProfile,
  type LocalDialState,
} from '../src/lib/executors.ts';
import { roleArchetype, semanticChecks } from '../src/lib/playbook-validate.ts';
import { exists, read, tempRepo } from './helpers.ts';

function parseDoc(doc: Record<string, unknown>, harness: 'standalone' | 'codex' | 'claude' = 'standalone'): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml', harness);
}

// --- v3 strict parsing ---

test('pre-dials catalogs are rejected with schema_version 3 message', () => {
  assert.throws(
    () => parseDoc({ schema_version: 2, targets: { opus: { provider: 'anthropic', model: 'opus' } }, routes: { standalone: { anthropic: { command: ['claude','-p'] } } }, loadouts: { main: { worker: 'opus' } } }),
    (err: unknown) => err instanceof ExecutorProfileError && /schema_version 3 required/.test(err.message) && /pre-dials catalogs are not supported/.test(err.message) && /targets:→models:/.test(err.message) && /loadouts:→dials:/.test(err.message) && /dials-and-registry/.test(err.message),
  );
  assert.throws(
    () => parseDoc({ targets: { opus: { provider: 'anthropic', model: 'opus' } }, routes: { standalone: { anthropic: { command: ['claude','-p'] } } }, bindings: { '*': 'opus' } }),
    (err: unknown) => err instanceof ExecutorProfileError && /schema_version 3 required/.test(err.message),
  );
  assert.throws(
    () => parseDoc({ executors: { foo: { adapter: 'command', command: ['x'] } }, bindings: { '*': 'foo' } }),
    /schema_version 3 required/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 1, executors: { foo: { adapter: 'command', command: ['x'] } }, bindings: { '*': 'foo' } }),
    /schema_version 3 required/,
  );
});

test('schema_version 3 requires models', () => {
  assert.throws(() => parseDoc({ schema_version: 3, routes: { standalone: { openai: { command: ['x'] } } } }), /schema_version 3 required/);
  assert.throws(() => parseDoc({ schema_version: 3, models: {}, routes: { standalone: { openai: { command: ['x'] } } } }), /schema_version 3 required/);
});

test('v3 models registry happy path', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'default', spellings: { opencode: 'anthropic/claude-opus-4.8' }, eligibility: { judge: 'shadow_only' } },
    },
    routes: {
      standalone: {
        openai: { command: ['codex', 'exec', '--model', '{model}'], write_access: true },
        anthropic: { command: ['claude', '-p', '--model', '{model}'], write_access: false },
        xai: { command: ['grok', '--model', '{model}'], write_access: true },
        openrouter: { driver: 'opencode', command: ['opencode','run','-m','{model}'], write_access: true },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: { requires_write: 'required' }, judge: {} },
    dials: { judge: 'opus' },
    bindings: { my_role: 'sol@high' },
    unregistered_model_driver: 'opencode',
  });
  assert.equal(profile.schemaVersion, 3);
  assert.equal(profile.models.sol!.provider, 'openai');
  assert.equal(profile.models.sol!.id, 'gpt-5.6-sol');
  assert.equal(profile.models.sol!.effort, 'high');
  assert.equal(profile.models.opus!.spellings.opencode, 'anthropic/claude-opus-4.8');
  assert.deepEqual(profile.models.opus!.eligibility, { judge: 'shadow_only' });
  assert.deepEqual(profile.dials, { judge: { model: 'opus' } });
  assert.deepEqual(profile.bindings, { my_role: { model: 'sol', effort: 'high' } });
  assert.equal(profile.unregisteredModelDriver, 'opencode');
  assert.ok(Object.hasOwn(profile.models, 'current-host'));
  assert.equal(profile.models['current-host']!.provider, 'current-host');
  const withDefaultId = parseDoc({
    schema_version: 3,
    models: { foo: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['x'] } } },
  });
  assert.equal(withDefaultId.models.foo!.id, 'foo');
  assert.equal(withDefaultId.models.foo!.effort, 'default');
});

test('declaring built-in current-host is error', () => {
  assert.throws(() => parseDoc({ schema_version: 3, models: { 'current-host': { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'] } } } }), /built-in/);
});

test('v3 routes driver fields and effort_encoding', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { gem: { provider: 'google', id: 'gemini-3.1-pro', effort: 'high' } },
    routes: {
      standalone: {
        google: { driver: 'agy', command: ['agy','--model','{model}'], write_access: true, effort_encoding: 'model-suffix' },
        openai: { command: ['codex','exec','{model}'] },
      },
    },
  });
  assert.equal(profile.routes.standalone.google!.driver, 'agy');
  assert.equal(profile.routes.standalone.google!.effort_encoding, 'model-suffix');
  assert.throws(() => parseDoc({ schema_version: 3, models: { m: { provider: 'google' } }, routes: { standalone: { google: { driver: 'agy', effort_encoding: 'bad', command: ['x'] } } } }), /effort_encoding.*flag.*model-suffix/);
});

test('v3 routes reject native alias — only host: parses', () => {
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'], native: true } as unknown as Record<string, unknown> } } }),
    /unknown key.*native|host/,
  );
});

test('bindings "*" is accepted but ignored with deprecation note', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['x'] } } },
    bindings: { '*': 'sol', my_role: 'sol' },
  });
  assert.deepEqual(profile.bindings, { my_role: { model: 'sol' } });
  assert.ok(profile.notes.some((n) => n.includes('binding "*"`') || n.includes('deprecated')));
});

test('DialRef parse/format', () => {
  assert.deepEqual(parseDialRef('sol', 'test'), { model: 'sol' });
  assert.deepEqual(parseDialRef('sol@high', 'test'), { model: 'sol', effort: 'high' });
  assert.deepEqual(parseDialRef({ model: 'sol', effort: 'high', via: 'opencode' }, 'test'), { model: 'sol', effort: 'high', via: 'opencode' });
  assert.deepEqual(parseDialRef({ model: 'gem', via: 'agy' }, 'test'), { model: 'gem', via: 'agy' });
  assert.deepEqual(
    parseDialRef({ model: 'gem', via: 'agy', force_write_posture: true }, 'test'),
    { model: 'gem', via: 'agy', force_write_posture: true },
  );
  assert.equal(formatDialRef({ model: 'sol' }), 'sol');
  assert.equal(formatDialRef({ model: 'sol', effort: 'xhigh' }), 'sol@xhigh');
  assert.equal(formatDialRef({ model: 'opus', via: 'opencode' }), 'opus via opencode');
  assert.equal(formatDialRef({ model: 'sol', effort: 'xhigh', via: 'opencode' }), 'sol@xhigh via opencode');
  assert.deepEqual(parseDialRef(formatDialRef({ model: 'sol', effort: 'high', via: 'opencode' }), 't'), { model: 'sol', effort: 'high', via: 'opencode' });
  assert.throws(() => parseDialRef('', 'dials.judge'), /empty string/);
  assert.throws(() => parseDialRef('sol@', 'dials.judge'), /valid dial ref/);
  assert.throws(() => parseDialRef({ model: '' }, 'dials.judge'), /non-empty "model"/);
  assert.throws(() => parseDialRef({ model: 'sol', effort: '' }, 'x'), /"effort" must be a non-empty string/);
  assert.throws(() => parseDialRef({ model: 'sol', force_write_posture: false }, 'x'), /"force_write_posture" must be true/);
  assert.throws(() => parseDialRef(42, 'x'), /must be a string/);
});

test('compileDialRef: registered home driver', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' } },
    routes: { standalone: { openai: { command: ['codex','exec','-m','{model}','--effort','{reasoning_effort}'], write_access: true } } },
  });
  const compiled = compileDialRef({ model: 'sol' }, profile);
  assert.equal(compiled.registered, true);
  assert.equal(compiled.provider, 'openai');
  assert.equal(compiled.driver, 'openai');
  assert.equal(compiled.effectiveEffort, 'high');
  // No `@effort` on the dial: the registry default fills the effective effort,
  // and the absent pin stays visible as null.
  assert.equal(compiled.pinnedEffort, null);
  assert.equal(compiled.model, 'sol');
  assert.equal(compiled.modelId, 'gpt-5.6-sol');
  assert.equal(compiled.spec.adapter, 'command');
  assert.deepEqual(compiled.spec.adapter === 'command' ? compiled.spec.command : null, ['codex','exec','-m','gpt-5.6-sol','--effort','high']);
  const over = compileDialRef({ model: 'sol', effort: 'low' }, profile);
  assert.equal(over.effectiveEffort, 'low');
  assert.equal(over.pinnedEffort, 'low');
  assert.deepEqual(over.spec.adapter === 'command' ? over.spec.command : null, ['codex','exec','-m','gpt-5.6-sol','--effort','low']);
});

test('compileDialRef: spellings via', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { opus: { provider: 'anthropic', id: 'opus', effort: 'default', spellings: { opencode: 'anthropic/claude-opus-4.8' } } },
    routes: {
      standalone: {
        anthropic: { command: ['claude','-p','--model','{model}'], write_access: false },
        openrouter: { driver: 'opencode', command: ['opencode','run','-m','{model}'], write_access: true },
      },
    },
  });
  const via = compileDialRef({ model: 'opus', via: 'opencode' }, profile);
  assert.equal(via.modelId, 'anthropic/claude-opus-4.8');
  assert.equal(via.driver, 'opencode');
  assert.equal(via.spec.adapter, 'command');
  assert.deepEqual(via.spec.adapter === 'command' ? via.spec.command : null, ['opencode','run','-m','anthropic/claude-opus-4.8']);
  const home = compileDialRef({ model: 'opus' }, profile);
  assert.equal(home.modelId, 'opus');
});

test('compileDialRef: effort_encoding model-suffix', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { gem: { provider: 'google', id: 'gemini-3.1-pro', effort: 'high' } },
    routes: { standalone: { google: { driver: 'agy', command: ['agy','--model','{model}'], effort_encoding: 'model-suffix', write_access: true } } },
  });
  const base = compileDialRef({ model: 'gem' }, profile);
  assert.equal(base.modelId, 'gemini-3.1-pro-high');
  const def = parseDoc({
    schema_version: 3,
    models: { gem: { provider: 'google', id: 'gemini-3.1-pro', effort: 'default' } },
    routes: { standalone: { google: { driver: 'agy', command: ['agy','--model','{model}'], effort_encoding: 'model-suffix' } } },
  });
  const low = compileDialRef({ model: 'gem' }, def);
  assert.equal(low.modelId, 'gemini-3.1-pro');
  const over = compileDialRef({ model: 'gem', effort: 'low' }, def);
  assert.equal(over.modelId, 'gemini-3.1-pro-low');
});

test('compileDialRef: unregistered fall-through via default driver', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openrouter: { driver: 'opencode', command: ['opencode','run','-m','{model}'], write_access: true } } },
    unregistered_model_driver: 'opencode',
  });
  const compiled = compileDialRef({ model: 'kimi-k3' }, profile);
  assert.equal(compiled.registered, false);
  assert.equal(compiled.provider, null);
  assert.equal(compiled.driver, 'opencode');
  assert.equal(compiled.modelId, 'kimi-k3');
  assert.equal(compiled.effectiveEffort, 'default');
  assert.equal(compiled.pinnedEffort, null);
  const withEffort = compileDialRef({ model: 'kimi-k3', effort: 'high' }, profile);
  assert.equal(withEffort.effectiveEffort, 'high');
  assert.equal(withEffort.pinnedEffort, 'high');
  const profile2 = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: {
      standalone: {
        openrouter: { driver: 'opencode', command: ['opencode','run','-m','{model}'] },
        google: { driver: 'agy', command: ['agy','--model','{model}'] },
      },
    },
  });
  const via = compileDialRef({ model: 'my-model', via: 'agy' }, profile2);
  assert.equal(via.driver, 'agy');
});

test('compileDialRef: unknown driver error naming declared aliases', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' } },
    routes: {
      standalone: {
        openai: { command: ['codex','exec'] },
        xai: { command: ['grok','--model','{model}'] },
        openrouter: { driver: 'opencode', command: ['opencode','run'] },
      },
    },
  });
  assert.throws(() => compileDialRef({ model: 'sol', via: 'unknown' }, profile), (err: unknown) => err instanceof ExecutorProfileError && /unknown driver "unknown"/.test(err.message) && /openai/.test(err.message) && /opencode/.test(err.message));
  assert.throws(() => compileDialRef({ model: 'nope-model', via: 'bad' }, profile), /unknown driver/);
  assert.throws(() => compileDialRef({ model: 'nope-model' }, parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { xai: { command: ['grok'] } } }, unregistered_model_driver: 'opencode' })), /unknown driver "opencode"/);
});

test('compileDialRef: eligibility copied to spec', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai', eligibility: { judge: 'forbidden', reviewer: 'shadow_only' } } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  });
  const compiled = compileDialRef({ model: 'sol' }, profile);
  assert.equal(eligibilityFor(compiled.spec, 'judge'), 'forbidden');
  assert.equal(eligibilityFor(compiled.spec, 'reviewer'), 'shadow_only');
  assert.equal(eligibilityFor(compiled.spec, 'worker'), 'eligible');
});

test('compileDialRef: host built-in current-host compiles to host', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] }, 'current-host': { host: true, command: ['codex','fallback'] } } },
  });
  const host = compileDialRef({ model: 'current-host' }, profile);
  assert.equal(host.spec.adapter, 'host');
  assert.equal(deliveryIsHost(host), true);
  assert.equal(host.effectiveEffort, 'default');
  const profile2 = parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['codex'] } } } });
  const implicit = compileDialRef({ model: 'current-host' }, profile2);
  assert.equal(implicit.spec.adapter, 'host');
});

test('archetypes: requires_write parses; an absent block is an empty map', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
  });
  assert.deepEqual(profile.archetypes, {
    worker: { requiresWrite: 'required', ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null },
    reviewer: { requiresWrite: 'none', ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null },
  });
  assert.deepEqual(parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'] } } } }).archetypes, {});
});

test('archetypes: strict validation names the offending path', () => {
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'] } } }, archetypes: 'worker' as unknown as Record<string, unknown> }),
    /`archetypes` is not a mapping/,
  );
  assert.throws(
    () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'] } } }, archetypes: { worker: 'yes' as unknown as Record<string, unknown> } }),
    /`archetypes\.worker` is not a mapping/,
  );
});

test('explainWriteConflict: one refusal, spoken identically by every enforcement point', () => {
  const roProfile = parseDoc({
    schema_version: 3,
    models: { ro: { provider: 'anthropic' }, rw: { provider: 'openai' }, silent: { provider: 'openai' } },
    routes: {
      standalone: {
        anthropic: { command: ['claude','-p'], write_access: false },
        openai: { command: ['codex','exec'], write_access: true },
      },
    },
    archetypes: { worker: { requires_write: 'required' }, reviewer: { requires_write: 'forbidden' } },
  });
  const roSpec = compileDialRef({ model: 'ro' }, roProfile).spec;
  const rwSpec = compileDialRef({ model: 'rw' }, roProfile).spec;
  const silentSpec = (() => {
    const p = parseDoc({
      schema_version: 3,
      models: { silent: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { worker: { requires_write: 'required' } },
    });
    return compileDialRef({ model: 'silent' }, p).spec;
  })();
  const conflict = explainWriteConflict({ executor: 'ro', spec: roSpec }, 'worker', roProfile);
  assert.ok(conflict != null);
  assert.match(conflict, /archetype "worker" declares `requires_write: required`, but executor "ro"/);
  assert.match(conflict, /`write_access: false`/);
  const hostProfile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { 'current-host': { host: true, command: ['claude','-p'], write_access: false } } },
    archetypes: { worker: { requires_write: 'required' } },
  });
  const hostSpec = compileDialRef({ model: 'current-host' }, hostProfile).spec;
  assert.ok(explainWriteConflict({ executor: 'current-host', spec: hostSpec }, 'worker', hostProfile) != null);

  assert.equal(explainWriteConflict({ executor: 'rw', spec: rwSpec }, 'worker', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: roSpec }, 'reviewer', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'silent', spec: silentSpec }, 'worker', roProfile), null);
  // forbidden × write
  const forbidden = explainWriteConflict({ executor: 'rw', spec: rwSpec }, 'reviewer', roProfile);
  assert.ok(forbidden != null);
  assert.match(forbidden, /archetype "reviewer" declares `requires_write: forbidden`, but executor "rw"/);
  assert.match(forbidden, /`write_access: true`/);
});

// --- pin v3 ---

test('pin v3: write and read round-trip (dial keys sorted)', (t) => {
  const root = tempRepo(t);
  assert.deepEqual(readLocalDialState(root), { dials: {}, shadows: {}, legacyNote: null });
  const state: LocalDialState = { dials: { generator: { model: 'gem', force_write_posture: true }, worker: { model: 'sol', effort: 'high' }, reviewer: { model: 'opus' } }, shadows: { worker: { model: 'kimi-k3', rate: 0.25 } }, legacyNote: null };
  const path = writeLocalDialState(root, state);
  assert.equal(path, join(root, DIALS_LOCAL_FILE));
  const text = read(root, DIALS_LOCAL_FILE);
  assert.equal(text, '{"dials":{"generator":{"model":"gem","force_write_posture":true},"reviewer":"opus","worker":"sol@high"},"shadows":{"worker":{"model":"kimi-k3","rate":0.25}}}\n');
  assert.deepEqual(readLocalDialState(root), { dials: { generator: { model: 'gem', force_write_posture: true }, worker: { model: 'sol', effort: 'high' }, reviewer: { model: 'opus' } }, shadows: { worker: { model: 'kimi-k3', rate: 0.25 } }, legacyNote: null });
  writeLocalDialState(root, { dials: {}, shadows: {}, legacyNote: null });
  assert.equal(exists(root, DIALS_LOCAL_FILE), false);
});

test('pin v3: legacy pin returns empty with legacyNote, never error', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), 'openai-primary\n', 'utf8');
  assert.deepEqual(readLocalDialState(root), { dials: {}, shadows: {}, legacyNote: 'pre-0.6 loadout pin ignored (named loadouts retired) — re-dial with `fadeno dial <archetype> <model>`' });
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"loadout":"x","overrides":{"worker":"luna-cli"}}\n', 'utf8');
  const legacy = readLocalDialState(root);
  assert.ok(legacy.legacyNote != null && legacy.legacyNote.includes('pre-0.6'));
  assert.deepEqual(legacy.dials, {});
  writeFileSync(join(root, DIALS_LOCAL_FILE), '   \n', 'utf8');
  assert.deepEqual(readLocalDialState(root), { dials: {}, shadows: {}, legacyNote: null });
});

test('pin v3: an unreadable pin names the file and how to reset it', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"dials": 42}\n', 'utf8');
  assert.throws(() => readLocalDialState(root), (err: unknown) => err instanceof ExecutorProfileError && (err.message.includes(DIALS_LOCAL_FILE) && /delete it/.test(err.message) && /fadeno dial <archetype> <model>/.test(err.message)));
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"dials":{"Worker":"sol"}}\n', 'utf8');
  assert.throws(() => readLocalDialState(root), /bare lowercase identifier/);
});

test('pin v3: shadows with via and effort round-trip', (t) => {
  const root = tempRepo(t);
  const state: LocalDialState = { dials: {}, shadows: { worker: { model: 'opus', effort: 'high', via: 'opencode', rate: 0.5 } }, legacyNote: null };
  writeLocalDialState(root, state);
  const readBack = readLocalDialState(root);
  assert.deepEqual(readBack.shadows.worker, { model: 'opus', effort: 'high', via: 'opencode', rate: 0.5 });
});

// --- cascade ---

test('cascade: binding-first, then session→repo→user, base terminal', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' }, opus: { provider: 'anthropic' } },
    routes: {
      standalone: {
        openai: { command: ['codex'] },
        xai: { command: ['grok'] },
        anthropic: { command: ['claude'] },
      },
    },
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
    schema_version: 3,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' } },
    routes: { standalone: { openai: { command: ['x'] }, xai: { command: ['y'] } } },
    dials: { worker: 'sol' },
    archetypes: { worker: { fallback: 'reviewer' } },
  });
  const layers2 = { session: { worker: { model: 'grok' } }, repo: profileNoBinding.dials, user: { worker: { model: 'sol' } } };
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, layers2).source, 'session');
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, { session: {}, repo: profileNoBinding.dials, user: { worker: { model: 'sol' } } }).source, 'repo');
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, { session: {}, repo: {}, user: { worker: { model: 'sol' } } }).source, 'user');
  assert.equal(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: profileNoBinding.archetypes }, { session: {}, repo: {}, user: {} }).source, 'base');
  assert.deepEqual(resolveDialCascade('coder', 'worker', { bindings: {}, archetypes: {} }, { session: {}, repo: {}, user: {} }).ref, { model: 'current-host' });
  assert.equal(resolveDialCascade('arbitrary', null, { bindings: {}, archetypes: {} }, { session: {}, repo: {}, user: {} }).source, 'base');
});

test('cascade: fallback chain via archetypes', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' } },
    routes: { standalone: { openai: { command: ['x'] }, xai: { command: ['y'] } } },
    archetypes: { generator: { fallback: 'worker' } },
    dials: { worker: 'sol' },
  });
  const res = resolveDialCascade('r', 'generator', { bindings: {}, archetypes: profile.archetypes }, { session: {}, repo: profile.dials, user: {} });
  assert.deepEqual(res.ref, { model: 'sol' });
  assert.equal(res.resolvedVia, 'worker');
  const direct = resolveDialCascade('r', 'worker', { bindings: {}, archetypes: profile.archetypes }, { session: {}, repo: profile.dials, user: {} });
  assert.equal(direct.resolvedVia, null);
});

test('cascade: a forced posture marker stays scoped to its directly dialed archetype', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['x'], write_access: true } } },
    archetypes: {
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      worker: { requires_write: 'required' },
    },
  });
  const layers = {
    session: {},
    repo: {},
    user: { worker: { model: 'sol', force_write_posture: true as const } },
  };
  const direct = resolveDialCascade('worker', 'worker', { bindings: {}, archetypes: profile.archetypes }, layers);
  assert.equal(direct.ref.force_write_posture, true);
  assert.equal(direct.resolvedVia, null);
  const fallback = resolveDialCascade('generator', 'generator', { bindings: {}, archetypes: profile.archetypes }, layers);
  assert.equal(fallback.ref.force_write_posture, true);
  assert.equal(fallback.resolvedVia, 'worker');
  assert.equal(forcesWritePosture(direct.ref, direct.resolvedVia), true);
  assert.equal(forcesWritePosture(fallback.ref, fallback.resolvedVia), false);
});

test('cascade: prototype hardening (hasOwn)', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['x'] } } },
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
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol' }, grok: { provider: 'xai', id: 'grok-4.6' } },
    routes: { standalone: { openai: { command: ['codex','--model','{model}'] }, xai: { command: ['grok','--model','{model}'] } } },
    dials: { worker: 'sol' },
    archetypes: { worker: {} },
  });
  const layers = { session: {}, repo: profile.dials, user: {} };
  const res = resolveRole('coder', 'worker', profile, layers);
  assert.equal(res.source, 'repo');
  assert.equal(res.delivery.model, 'sol');
  assert.equal(res.delivery.spec.adapter, 'command');
  assert.match(roleResolutionEchoLabel(res.source), /repo pin/);
});

test('roleResolutionEchoLabel vocabulary', () => {
  assert.equal(roleResolutionEchoLabel('binding'), 'binding');
  assert.equal(roleResolutionEchoLabel('session'), 'session dial');
  assert.equal(roleResolutionEchoLabel('repo'), 'repo pin');
  assert.equal(roleResolutionEchoLabel('user'), 'user dial');
  assert.equal(roleResolutionEchoLabel('base'), 'base');
});

// --- snapshot format v3 ---

test('serializeSnapshot v3 byte-stable and includes current-host always', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' }, grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' } },
    routes: { standalone: { openai: { command: ['codex','{model}'] }, xai: { command: ['grok','{model}'] } } },
    archetypes: { worker: { requires_write: true } },
    bindings: { my_role: 'sol@high' },
  });
  const t1 = serializeSnapshot(profile, [{ model: 'sol', effort: 'low' }]);
  const t2 = serializeSnapshot(profile, [{ model: 'sol', effort: 'low' }]);
  assert.equal(t1, t2);
  assert.match(t1, /snapshot_version: 3/);
  assert.match(t1, /executors:/);
  assert.match(t1, /current-host:/);
  assert.match(t1, /sol:/);
});

test('serializeSnapshot round-trips via parseSnapshotDocument', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol' } },
    routes: { standalone: { openai: { command: ['codex','{model}'] } } },
    archetypes: { worker: {} },
    bindings: { my_role: 'sol' },
  });
  const snapText = serializeSnapshot(profile);
  const doc = parseSnapshotDocument(snapText, 'snap.yaml');
  assert.ok(Object.keys(doc.executors).length >= 1);
  assert.ok(Object.hasOwn(doc.executors, 'sol') || Object.keys(doc.executors).some((k) => k.includes('sol')));
  assert.deepEqual(doc.bindings, { my_role: { model: 'sol' } });
  const snap2 = serializeSnapshot(profile);
  assert.equal(snapText, snap2);
});

test('serializeSnapshot all-native profile with zero dials/bindings', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'sol-id' } },
    routes: { standalone: { openai: { command: ['codex','{model}'] } } },
  });
  // remove bindings/dials to simulate all-native
  const emptyBindingsProfile: ExecutorProfile = { ...profile, bindings: {}, dials: {}, archetypes: {} };
  const snapText = serializeSnapshot(emptyBindingsProfile);
  const doc = parseSnapshotDocument(snapText, 'snap.yaml');
  assert.ok(Object.hasOwn(doc.executors, 'current-host'));
  assert.ok(Object.hasOwn(doc.executors, 'sol'));
  assert.deepEqual(doc.bindings, {});
  assert.deepEqual(doc.archetypes, {});
  assert.equal(doc.constraints, null);
  // no synthesized "*" binding
  assert.ok(!Object.hasOwn(doc.bindings, '*'));
  // reparses byte-stable
  assert.equal(serializeSnapshot(emptyBindingsProfile), snapText);
});

test('parseSnapshotDocument rejects pre-dials snapshots', () => {
  assert.throws(
    () => parseSnapshotDocument('executors:\n  foo:\n    adapter: command\n    command: [x]\n', 'old.yaml'),
    (err: unknown) => err instanceof ExecutorProfileError && /pre-dials run snapshot/.test(err.message) && /snapshot_version 3/.test(err.message),
  );
  assert.throws(
    () => parseSnapshotDocument('snapshot_version: 2\nexecutors:\n  foo:\n    adapter: command\n    command: [x]\n', 'old.yaml'),
    /pre-dials run snapshot/,
  );
});

test('snapshot eligibility round-trip', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai', eligibility: { worker: 'forbidden' } } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  });
  const snapText = serializeSnapshot(profile);
  const doc = parseSnapshotDocument(snapText, 'snap.yaml');
  assert.equal(doc.executors['sol']!.eligibility['worker'], 'forbidden');
});

test('playbook roles: archetype validation', () => {
  const issues = semanticChecks({ kind: 'AgentPlaybook', roles: { implementer: { purpose: 'x', archetype: 'worker' } }, flow: [{ id: 'a', kind: 'actor_call', actor: 'implementer', terminal_status: 'completed' }] }, 'pb.yaml');
  assert.deepEqual(issues, []);
  const bad = semanticChecks({ kind: 'AgentPlaybook', roles: { implementer: { purpose: 'x', archetype: 'Worker' } }, flow: [{ id: 'a', kind: 'actor_call', actor: 'implementer', terminal_status: 'completed' }] }, 'pb.yaml');
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.message, /must be a bare lowercase identifier/);
});

test('roleArchetype accessor', () => {
  const pb = { kind: 'AgentPlaybook', roles: { implementer: { purpose: 'x', archetype: 'worker' } }, flow: [{ id: 'a', kind: 'actor_call', actor: 'implementer', terminal_status: 'completed' }] };
  assert.equal(roleArchetype(pb, 'implementer'), 'worker');
  assert.equal(roleArchetype(pb, 'ghost'), null);
});

test('route timeout_ms: parses, host rejection, snapshot preservation, and write-variant inheritance', () => {
  const withTimeout = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' }, grok: { provider: 'xai' } },
    routes: {
      standalone: {
        openai: { command: ['codex'], timeout_ms: 1200000 },
        xai: { command: ['grok'], timeout_ms: 600000 },
      },
    },
  });
  const solSpec = compileDialRef({ model: 'sol' }, withTimeout).spec as unknown as Record<string, unknown>;
  const grokSpec = compileDialRef({ model: 'grok' }, withTimeout).spec as unknown as Record<string, unknown>;
  assert.equal(solSpec.timeoutMs, 1200000);
  assert.equal(grokSpec.timeoutMs, 600000);
  // absent by default
  const noTimeout = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  });
  const none = compileDialRef({ model: 'sol' }, noTimeout).spec as unknown as Record<string, unknown>;
  assert.equal(none.timeoutMs, undefined);
  // host route may not declare timeout_ms
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { 'current-host': { host: true, timeout_ms: 1000 } } },
    }),
    (err: unknown) => err instanceof ExecutorProfileError && /host route.*may not declare.*timeout_ms/.test(err.message),
  );
  // positive integer only
  for (const bad of [0, -1, 1.5, '1000' as unknown as number, NaN, Infinity]) {
    assert.throws(
      () => parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['x'], timeout_ms: bad as unknown as number } } } }),
      (err: unknown) => err instanceof ExecutorProfileError && /timeout_ms.*positive integer/.test(err.message),
    );
  }
  // snapshot preserves timeout_ms and omits when absent
  const snap = serializeSnapshot(withTimeout);
  assert.match(snap, /timeout_ms: 1200000/);
  assert.match(snap, /timeout_ms: 600000/);
  const parsed = parseSnapshotDocument(snap, 'snap.yaml');
  assert.equal((parsed.executors['sol'] as unknown as Record<string, unknown>).timeoutMs, 1200000);
  assert.equal((parsed.executors['grok'] as unknown as Record<string, unknown>).timeoutMs, 600000);
  const snap2 = serializeSnapshot(noTimeout);
  assert.doesNotMatch(snap2, /timeout_ms/);
  const parsed2 = parseSnapshotDocument(snap2, 'snap.yaml');
  assert.equal((parsed2.executors['sol'] as unknown as Record<string, unknown>).timeoutMs, undefined);
  // snapshot host rejection
  assert.throws(
    () => parseSnapshotDocument('snapshot_version: 3\nexecutors:\n  h:\n    adapter: host\n    model: m\n    reasoning_effort: high\n    agent_type: "*"\n    timeout_ms: 100\n', 'snap.yaml'),
    (err: unknown) => err instanceof ExecutorProfileError && /host executor rejects.*timeout_ms/.test(err.message),
  );
  assert.throws(
    () => parseSnapshotDocument('snapshot_version: 3\nexecutors:\n  c:\n    adapter: command\n    command: [x]\n    timeout_ms: 0\n', 'snap.yaml'),
    /positive integer/,
  );
  // write-variant inherits timeoutMs via spread (checked via compile, not parseSnapshot)
  const variantProfile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'anthropic' } },
    routes: {
      standalone: {
        anthropic: { command: ['claude', '-p'], write_access: false, timeout_ms: 900000, write_variant: { command: ['claude', '-p', '--permission-mode', 'acceptEdits'] } },
      },
    },
    archetypes: { worker: { requires_write: 'required' } },
  });
  const variantSpec = compileDialRef({ model: 'sol' }, variantProfile).spec as unknown as Record<string, unknown>;
  assert.equal(variantSpec.timeoutMs, 900000);
  // applyWritePosture preserves timeoutMs across variant switch
  const postured = applyWritePosture(variantSpec as unknown as import('../src/lib/executors.ts').ExecutorSpec, 'worker', variantProfile.archetypes);
  assert.equal((postured.spec as unknown as Record<string, unknown>).timeoutMs, 900000);
  assert.equal(postured.usedWriteVariant, true);
});

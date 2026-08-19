import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  BARE_IDENTIFIER_RE,
  compileDialRef,
  ExecutorProfileError,
  explainWriteConflict,
  parseExecutorProfile,
  parseSnapshotDocument,
  serializeSnapshot,
  type ExecutorProfile,
} from '../src/lib/executors.ts';

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

function specForModel(profile: ExecutorProfile, model: string) {
  return compileDialRef({ model }, profile).spec;
}

// --- parse: postures ---

test('archetypes: boolean aliases map to required/none', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
  });
  assert.deepEqual(profile.archetypes.worker, { requiresWrite: 'required', fallback: null, distinctProviderFromInputs: null, brief: null });
  assert.deepEqual(profile.archetypes.reviewer, { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null, brief: null });
});

test('archetypes: the three string postures parse', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: {
      worker: { requires_write: 'required' },
      generator: { requires_write: 'forbidden' },
      reviewer: { requires_write: 'none' },
    },
  });
  assert.equal(profile.archetypes.worker!.requiresWrite, 'required');
  assert.equal(profile.archetypes.generator!.requiresWrite, 'forbidden');
  assert.equal(profile.archetypes.reviewer!.requiresWrite, 'none');
  assert.equal(profile.archetypes.worker!.fallback, null);
});

test('archetypes: a bad requires_write value lists the accepted forms', () => {
  for (const bad of ['yes', 'true', 'Required', 1, null]) {
    assert.throws(
      () => parseDoc({
        schema_version: 3,
        models: { sol: { provider: 'openai' } },
        routes: { standalone: { openai: { command: ['codex'] } } },
        archetypes: { worker: { requires_write: bad } },
      }),
      (err: unknown) =>
        err instanceof ExecutorProfileError &&
        /`archetypes\.worker\.requires_write` must be /.test(err.message) &&
        /true/.test(err.message) &&
        /false/.test(err.message) &&
        /required/.test(err.message) &&
        /forbidden/.test(err.message) &&
        /none/.test(err.message),
      String(bad),
    );
  }
});

test('archetypes: an empty policy is legal (all-default)', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { scout: {} },
  });
  assert.deepEqual(profile.archetypes.scout, { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null, brief: null });
});

test('archetypes: unknown keys name the new allowed set', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { worker: { requires_write: true, requires_network: true } },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /`archetypes\.worker` has unknown key\(s\) requires_network; only `requires_write`, `fallback`, `distinct_provider_from_inputs`, and `brief` are allowed/
        .test(err.message),
  );
});

// --- parse: identifiers, self-fallback, cycles ---

test('archetypes: keys and fallback values must be bare identifiers', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { Worker: { requires_write: 'none' } },
    }),
    /archetype name "Worker" is not a bare lowercase identifier/,
  );
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { scout: { fallback: 'Reviewer' } },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /`archetypes\.scout\.fallback` "Reviewer" is not a bare lowercase identifier/.test(err.message) &&
      err.message.includes(BARE_IDENTIFIER_RE.source),
  );
});

test('archetypes: fallback may not name its own archetype', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { scout: { fallback: 'scout' } },
    }),
    /`archetypes\.scout\.fallback` may not name its own archetype/,
  );
});

test('archetypes: a 2-cycle is refused with the cycle path', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: {
        scout: { fallback: 'reviewer' },
        reviewer: { fallback: 'scout' },
      },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /archetype fallback cycle: scout → reviewer → scout/.test(err.message),
  );
});

test('archetypes: a 3-cycle is refused with the cycle path', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: {
        scout: { fallback: 'reviewer' },
        reviewer: { fallback: 'judge' },
        judge: { fallback: 'scout' },
      },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /archetype fallback cycle: scout → reviewer → judge → scout/.test(err.message),
  );
});

test('archetypes: fallback to an undeclared archetype is allowed', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { scout: { fallback: 'reviewer' } },
  });
  assert.deepEqual(profile.archetypes.scout, { requiresWrite: 'none', fallback: 'reviewer', distinctProviderFromInputs: null, brief: null });
  assert.equal(profile.archetypes.reviewer, undefined);
});

// --- explainWriteConflict ---

test('explainWriteConflict: forbidden×write refuses; required×no-write still refuses; none never does', () => {
  const roProfile = parseDoc({
    schema_version: 3,
    models: { ro: { provider: 'anthropic' }, rw: { provider: 'openai' } },
    routes: {
      standalone: {
        anthropic: { command: ['claude', '-p'], write_access: false },
        openai: { command: ['codex', 'exec', '-'], write_access: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      reviewer: { requires_write: 'none' },
      scout: { fallback: 'worker' },
    },
  });

  const roSpec = specForModel(roProfile, 'ro');
  const rwSpec = specForModel(roProfile, 'rw');

  const required = explainWriteConflict({ executor: 'ro', spec: roSpec }, 'worker', roProfile);
  assert.ok(required != null);
  assert.match(required, /archetype "worker" declares `requires_write: required`, but executor "ro"/);
  assert.match(required, /`write_access: false`/);

  const forbidden = explainWriteConflict({ executor: 'rw', spec: rwSpec }, 'generator', roProfile);
  assert.ok(forbidden != null);
  assert.match(forbidden, /archetype "generator" declares `requires_write: forbidden`, but executor "rw"/);
  assert.match(forbidden, /`write_access: true`/);
  assert.match(forbidden, /mutating toolchain/);
  assert.match(forbidden, /read-only route/);
  assert.match(forbidden, /fadeno dial clear generator/);
  assert.match(forbidden, /`requires_write: none`/);

  assert.equal(explainWriteConflict({ executor: 'ro', spec: roSpec }, 'reviewer', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'rw', spec: rwSpec }, 'reviewer', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: roSpec }, 'generator', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'rw', spec: rwSpec }, 'worker', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: roSpec }, 'scout', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: roSpec }, 'judge', roProfile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: roSpec }, null, roProfile), null);
});

// --- serialize snapshot ---

test('serializeSnapshot: canonical strings, omits none, emits fallback, round-trips', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: {
      worker: { requires_write: true },
      reviewer: { requires_write: false },
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      scout: { fallback: 'reviewer' },
      extra: {},
    },
  });
  assert.deepEqual(profile.archetypes, {
    worker: { requiresWrite: 'required', fallback: null, distinctProviderFromInputs: null, brief: null },
    reviewer: { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null, brief: null },
    generator: { requiresWrite: 'forbidden', fallback: 'worker', distinctProviderFromInputs: null, brief: null },
    scout: { requiresWrite: 'none', fallback: 'reviewer', distinctProviderFromInputs: null, brief: null },
    extra: { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null, brief: null },
  });

  const text = serializeSnapshot(profile);
  assert.match(text, /requires_write: required/);
  assert.match(text, /requires_write: forbidden/);
  assert.doesNotMatch(text, /requires_write: none/);
  assert.doesNotMatch(text, /requires_write: (true|false)/);
  assert.match(text, /fallback: worker/);
  assert.match(text, /fallback: reviewer/);
  assert.match(text, /extra: \{\}/);

  const doc = parseSnapshotDocument(text, 'snap.yaml');
  assert.deepEqual(doc.archetypes, profile.archetypes);
  assert.equal(serializeSnapshot(profile), text);
});

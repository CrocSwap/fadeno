import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  BARE_IDENTIFIER_RE,
  compileDialRef,
  ExecutorProfileError,
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

// --- parse: the removed write posture ---

// `requires_write` is refused, never ignored. Quietly dropping a key someone
// wrote in order to RESTRICT something is the failure mode the permissions cut
// exists to end, and it would be a poor way to land a change whose premise is
// that unenforced claims are dangerous.
test('archetypes: requires_write is refused with a pointer, not silently ignored', () => {
  for (const value of [true, false, 'required', 'forbidden', 'none']) {
    assert.throws(
      () => parseDoc({
        schema_version: 3,
        models: { sol: { provider: 'openai' } },
        routes: { standalone: { openai: { command: ['codex'] } } },
        archetypes: { worker: { requires_write: value } },
      }),
      (err: unknown) =>
        err instanceof ExecutorProfileError &&
        /`archetypes\.worker\.requires_write` is no longer supported/.test(err.message) &&
        /permissions-and-isolation\.md/.test(err.message),
      `requires_write: ${JSON.stringify(value)} must be refused`,
    );
  }
});

test('routes: write_access and write_variant are refused with a pointer', () => {
  for (const route of [{ command: ['codex'], write_access: false }, { command: ['codex'], write_variant: { command: ['codex', '--yolo'] } }]) {
    assert.throws(
      () => parseDoc({
        schema_version: 3,
        models: { sol: { provider: 'openai' } },
        routes: { standalone: { openai: route } },
      }),
      (err: unknown) =>
        err instanceof ExecutorProfileError &&
        /is no longer supported/.test(err.message) &&
        /permissions-and-isolation\.md/.test(err.message),
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
  assert.deepEqual(profile.archetypes.scout, { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null });
});

test('archetypes: unknown keys name the new allowed set', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { worker: { requires_network: true } },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /`archetypes\.worker` has unknown key\(s\) requires_network; only `ignored_output`, `fallback`, `distinct_provider_from_inputs`, and `brief` are allowed/
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
      archetypes: { Worker: { } },
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
  assert.deepEqual(profile.archetypes.scout, { ignoredOutput: 'discardable', fallback: 'reviewer', distinctProviderFromInputs: null, brief: null });
  assert.equal(profile.archetypes.reviewer, undefined);
});

// --- explainWriteConflict ---


// --- serialize snapshot ---

test('serializeSnapshot: canonical strings, omits none, emits fallback, round-trips', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: {
      worker: { },
      reviewer: { },
      generator: { fallback: 'worker' },
      scout: { fallback: 'reviewer' },
      extra: {},
    },
  });
  assert.deepEqual(profile.archetypes, {
    worker: { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null },
    reviewer: { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null },
    generator: { ignoredOutput: 'discardable', fallback: 'worker', distinctProviderFromInputs: null, brief: null },
    scout: { ignoredOutput: 'discardable', fallback: 'reviewer', distinctProviderFromInputs: null, brief: null },
    extra: { ignoredOutput: 'discardable', fallback: null, distinctProviderFromInputs: null, brief: null },
  });

  const text = serializeSnapshot(profile);
  // A snapshot can no longer carry a write posture at all — the key is gone
  // from the policy it serializes, so nothing can round-trip one back in.
  assert.doesNotMatch(text, /requires_write/);
  assert.match(text, /fallback: worker/);
  assert.match(text, /fallback: reviewer/);
  assert.match(text, /extra: \{\}/);

  const doc = parseSnapshotDocument(text, 'snap.yaml');
  assert.deepEqual(doc.archetypes, profile.archetypes);
  assert.equal(serializeSnapshot(profile), text);
});

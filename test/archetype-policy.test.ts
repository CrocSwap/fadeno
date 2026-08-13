import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  explainWriteConflict,
  parseExecutorProfile,
  resolveRole,
  serializeProfile,
  type ExecutorProfile,
} from '../src/lib/executors.ts';

const EXECUTORS = {
  'opus-xhigh': { adapter: 'command', command: ['claude', '-p', '--model', 'opus'], model: 'opus' },
  'luna-cli': { adapter: 'command', command: ['codex', 'exec', '-'], model: 'gpt-5.6-luna' },
  ro: { adapter: 'command', command: ['claude', '-p'], write_access: false },
  rw: { adapter: 'command', command: ['codex', 'exec', '-'], write_access: true },
};

const LOADOUTS = {
  main: { worker: 'luna-cli', reviewer: 'opus-xhigh' },
};

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

function specOf(profile: ExecutorProfile, name: string) {
  return profile.executors[name]!;
}

// --- parse: postures ---

test('archetypes: boolean aliases map to required/none', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
  });
  assert.deepEqual(profile.archetypes.worker, { requiresWrite: 'required', fallback: null, distinctProviderFromInputs: null });
  assert.deepEqual(profile.archetypes.reviewer, { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null });
});

test('archetypes: the three string postures parse', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
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
        executors: EXECUTORS,
        loadouts: LOADOUTS,
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
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { scout: {} },
  });
  assert.deepEqual(profile.archetypes.scout, { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null });
});

test('archetypes: unknown keys name the new allowed set', () => {
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: LOADOUTS,
      archetypes: { worker: { requires_write: true, requires_network: true } },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /`archetypes\.worker` has unknown key\(s\) requires_network; only `requires_write`, `fallback`, and `distinct_provider_from_inputs` are allowed/
        .test(err.message),
  );
});

// --- parse: identifiers, self-fallback, cycles ---

test('archetypes: keys and fallback values must be bare identifiers', () => {
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: LOADOUTS,
      archetypes: { Worker: { requires_write: 'none' } },
    }),
    /archetype name "Worker" is not a bare lowercase identifier/,
  );
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: LOADOUTS,
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
      executors: EXECUTORS,
      loadouts: LOADOUTS,
      archetypes: { scout: { fallback: 'scout' } },
    }),
    /`archetypes\.scout\.fallback` may not name its own archetype/,
  );
});

test('archetypes: a 2-cycle is refused with the cycle path', () => {
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: LOADOUTS,
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
      executors: EXECUTORS,
      loadouts: LOADOUTS,
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
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { scout: { fallback: 'reviewer' } },
  });
  assert.deepEqual(profile.archetypes.scout, { requiresWrite: 'none', fallback: 'reviewer', distinctProviderFromInputs: null });
  assert.equal(profile.archetypes.reviewer, undefined);
});

// --- resolveRole: fallback chain + resolvedVia ---

test('role resolution: walks declared → fallback and sets resolvedVia', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { scout: { fallback: 'worker' } },
  });
  const resolved = resolveRole('implementer', 'scout', profile, 'main');
  assert.equal(resolved.executorName, 'luna-cli');
  assert.equal(resolved.source, 'loadout');
  assert.equal(resolved.resolvedVia, 'worker');
});

test('role resolution: resolvedVia is null on a direct bind', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { worker: { requires_write: 'required' }, scout: { fallback: 'worker' } },
  });
  const direct = resolveRole('implementer', 'worker', profile, 'main');
  assert.equal(direct.executorName, 'luna-cli');
  assert.equal(direct.source, 'loadout');
  assert.equal(direct.resolvedVia, null);
});

test('role resolution: an override on the fallback archetype is honored', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { scout: { fallback: 'worker' } },
  });
  const resolved = resolveRole('implementer', 'scout', profile, 'main', { worker: 'opus-xhigh' });
  assert.equal(resolved.executorName, 'opus-xhigh');
  assert.equal(resolved.source, 'override');
  assert.equal(resolved.resolvedVia, 'worker');
});

test('role resolution: an override on the declared archetype beats the chain', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { scout: { fallback: 'worker' } },
  });
  const resolved = resolveRole('implementer', 'scout', profile, 'main', {
    scout: 'opus-xhigh',
    worker: 'ro',
  });
  assert.equal(resolved.executorName, 'opus-xhigh');
  assert.equal(resolved.source, 'override');
  assert.equal(resolved.resolvedVia, null);
});

test('role resolution: bindings[role] and bindings["*"] leave resolvedVia null', () => {
  const pinned = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { scout: { fallback: 'worker' } },
    bindings: { implementer: 'opus-xhigh' },
  });
  const pin = resolveRole('implementer', 'scout', pinned, 'main');
  assert.equal(pin.source, 'binding');
  assert.equal(pin.resolvedVia, null);
  assert.equal(pin.executorName, 'opus-xhigh');

  const withDefault = parseDoc({
    executors: EXECUTORS,
    loadouts: { main: { worker: 'luna-cli' } },
    archetypes: { scout: { fallback: 'reviewer' } },
    bindings: { '*': 'opus-xhigh' },
  });
  const fallback = resolveRole('implementer', 'scout', withDefault, 'main');
  assert.equal(fallback.source, 'default');
  assert.equal(fallback.resolvedVia, null);
  assert.equal(fallback.executorName, 'opus-xhigh');
});

test('role resolution: a constructor fallback does not walk Object.prototype', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { scout: { fallback: 'constructor' } },
    bindings: { '*': 'opus-xhigh' },
  });
  const resolved = resolveRole('implementer', 'scout', profile, 'main');
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.resolvedVia, null);
  assert.equal(resolved.executorName, 'opus-xhigh');
});

// --- explainWriteConflict ---

test('explainWriteConflict: forbidden×write refuses; required×no-write still refuses; none never does', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: {
      worker: { requires_write: 'required' },
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      reviewer: { requires_write: 'none' },
      scout: { fallback: 'worker' },
    },
    bindings: { '*': 'ro' },
  });

  const required = explainWriteConflict({ executor: 'ro', spec: specOf(profile, 'ro') }, 'worker', profile);
  assert.ok(required != null);
  assert.match(required, /archetype "worker" declares `requires_write: required`, but executor "ro"/);
  assert.match(required, /`write_access: false`/);

  const forbidden = explainWriteConflict({ executor: 'rw', spec: specOf(profile, 'rw') }, 'generator', profile);
  assert.ok(forbidden != null);
  assert.match(forbidden, /archetype "generator" declares `requires_write: forbidden`, but executor "rw"/);
  assert.match(forbidden, /`write_access: true`/);
  assert.match(forbidden, /mutating toolchain/);
  assert.match(forbidden, /read-only route/);
  assert.match(forbidden, /fadeno loadout clear generator/);
  assert.match(forbidden, /`requires_write: none`/);

  assert.equal(explainWriteConflict({ executor: 'ro', spec: specOf(profile, 'ro') }, 'reviewer', profile), null);
  assert.equal(explainWriteConflict({ executor: 'rw', spec: specOf(profile, 'rw') }, 'reviewer', profile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: specOf(profile, 'ro') }, 'generator', profile), null);
  assert.equal(explainWriteConflict({ executor: 'rw', spec: specOf(profile, 'rw') }, 'worker', profile), null);
  // Bindings-only: scout does not import worker's `required` posture.
  assert.equal(explainWriteConflict({ executor: 'ro', spec: specOf(profile, 'ro') }, 'scout', profile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: specOf(profile, 'ro') }, 'judge', profile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: specOf(profile, 'ro') }, null, profile), null);
});

// --- serialize ---

test('serializeProfile: canonical strings, omits none, emits fallback, round-trips', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: {
      worker: { requires_write: true },
      reviewer: { requires_write: false },
      generator: { requires_write: 'forbidden', fallback: 'worker' },
      scout: { fallback: 'reviewer' },
      extra: {},
    },
  });
  assert.deepEqual(profile.archetypes, {
    worker: { requiresWrite: 'required', fallback: null, distinctProviderFromInputs: null },
    reviewer: { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null },
    generator: { requiresWrite: 'forbidden', fallback: 'worker', distinctProviderFromInputs: null },
    scout: { requiresWrite: 'none', fallback: 'reviewer', distinctProviderFromInputs: null },
    extra: { requiresWrite: 'none', fallback: null, distinctProviderFromInputs: null },
  });

  const text = serializeProfile(profile);
  assert.match(text, /requires_write: required/);
  assert.match(text, /requires_write: forbidden/);
  assert.doesNotMatch(text, /requires_write: none/);
  assert.doesNotMatch(text, /requires_write: (true|false)/);
  assert.match(text, /fallback: worker/);
  assert.match(text, /fallback: reviewer/);
  assert.match(text, /extra: \{\}/);

  const roundTrip = parseExecutorProfile(text, 'round-trip.yaml');
  assert.deepEqual(roundTrip.archetypes, profile.archetypes);
  assert.deepEqual(roundTrip, profile);
  assert.equal(serializeProfile(roundTrip), text);
});

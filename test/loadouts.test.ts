import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  ExecutorProfileError,
  LOADOUT_LOCAL_FILE,
  parseExecutorProfile,
  readLocalLoadout,
  resolveActiveLoadout,
  resolveRole,
  serializeProfile,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { roleArchetype, semanticChecks } from '../src/lib/playbook-validate.ts';
import { tempRepo } from './helpers.ts';

const EXECUTORS = {
  'opus-xhigh': { adapter: 'command', command: ['claude', '-p', '--model', 'opus'], model: 'opus' },
  'luna-cli': { adapter: 'command', command: ['codex', 'exec', '-'], model: 'gpt-5.6-luna' },
  'terra-host': { adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer' },
};

const LOADOUTS = {
  'anthropic-primary': { worker: 'opus-xhigh', reviewer: 'terra-host' },
  'openai-primary': { worker: 'luna-cli', reviewer: 'terra-host' },
};

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

// --- loadouts / default_loadout parsing ---

test('loadouts: happy path parses without bindings', () => {
  const profile = parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS, default_loadout: 'anthropic-primary' });
  assert.deepEqual(profile.loadouts, LOADOUTS);
  assert.equal(profile.defaultLoadout, 'anthropic-primary');
  assert.deepEqual(profile.bindings, {});
  assert.equal(profile.executors['terra-host']!.adapter, 'host');
});

test('loadouts: coexist with bindings; both are parsed', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    bindings: { opus_reviewer: 'opus-xhigh', '*': 'luna-cli' },
  });
  assert.deepEqual(profile.loadouts, LOADOUTS);
  assert.deepEqual(profile.bindings, { opus_reviewer: 'opus-xhigh', '*': 'luna-cli' });
  assert.equal(profile.defaultLoadout, null);
});

test('loadouts: slot referencing an undeclared executor is rejected', () => {
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: { solo: { worker: 'ghost' } } }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /loadout "solo" slot "worker" targets "ghost", which is not a declared executor/.test(err.message),
  );
});

test('loadouts: names and archetype keys must be bare lowercase identifiers', () => {
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: { 'Anthropic-Primary': { worker: 'opus-xhigh' } } }),
    /loadout name "Anthropic-Primary" is not a bare lowercase identifier/,
  );
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: { solo: { Worker: 'opus-xhigh' } } }),
    /loadout "solo" archetype key "Worker" is not a bare lowercase identifier/,
  );
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: { '9lives': { worker: 'opus-xhigh' } } }),
    /loadout name "9lives" is not a bare lowercase identifier/,
  );
});

test('loadouts: a loadout entry must be an archetype → executor mapping', () => {
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: { solo: 'opus-xhigh' } }),
    /loadout "solo" is not a mapping/,
  );
});

test('default_loadout must name a declared loadout', () => {
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS, default_loadout: 'ghost' }),
    /default_loadout "ghost" does not name a declared loadout \(anthropic-primary, openai-primary\)/,
  );
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, bindings: { '*': 'luna-cli' }, default_loadout: 'ghost' }),
    /default_loadout "ghost" does not name a declared loadout \(no loadouts declared\)/,
  );
});

test('bindings may be omitted only when loadouts are present and non-empty', () => {
  // No bindings, no loadouts: still an error.
  assert.throws(() => parseDoc({ executors: EXECUTORS }), /needs a non-empty `bindings` mapping/);
  // Empty loadouts do not lift the requirement.
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: {} }),
    /needs a non-empty `bindings` mapping/,
  );
  // Empty bindings alongside non-empty loadouts are fine.
  const profile = parseDoc({ executors: EXECUTORS, bindings: {}, loadouts: LOADOUTS });
  assert.deepEqual(profile.bindings, {});
});

test('serializeProfile round-trips loadouts and default_loadout byte-stably', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    default_loadout: 'openai-primary',
  });
  const text = serializeProfile(profile);
  const roundTrip = parseExecutorProfile(text, 'round-trip.yaml');
  assert.deepEqual(roundTrip, profile);
  assert.equal(serializeProfile(roundTrip), text);
});

// --- active-loadout resolution ---

const LOADED = parseExecutorProfile(
  stringifyYaml({ executors: EXECUTORS, loadouts: LOADOUTS, default_loadout: 'anthropic-primary' }),
  'test.yaml',
);

test('active loadout: flag → env → local → default precedence', () => {
  assert.deepEqual(
    resolveActiveLoadout({
      flagValue: 'openai-primary',
      envValue: 'anthropic-primary',
      localFileValue: 'anthropic-primary',
      profile: LOADED,
    }),
    { name: 'openai-primary', source: 'flag' },
  );
  assert.deepEqual(
    resolveActiveLoadout({ envValue: 'openai-primary', localFileValue: 'anthropic-primary', profile: LOADED }),
    { name: 'openai-primary', source: 'env' },
  );
  assert.deepEqual(
    resolveActiveLoadout({ localFileValue: 'openai-primary', profile: LOADED }),
    { name: 'openai-primary', source: 'local' },
  );
  assert.deepEqual(resolveActiveLoadout({ profile: LOADED }), { name: 'anthropic-primary', source: 'default' });
  // Blank values are absent, not overrides.
  assert.deepEqual(
    resolveActiveLoadout({ flagValue: '  ', envValue: '', localFileValue: 'openai-primary', profile: LOADED }),
    { name: 'openai-primary', source: 'local' },
  );
});

test('active loadout: none configured resolves to null', () => {
  const bare = parseDoc({ executors: EXECUTORS, bindings: { '*': 'luna-cli' } });
  assert.equal(resolveActiveLoadout({ profile: bare }), null);
});

test('active loadout: an unknown name is an error naming its source', () => {
  assert.throws(
    () => resolveActiveLoadout({ flagValue: 'ghost', profile: LOADED }),
    /--loadout names loadout "ghost", which is not declared \(anthropic-primary, openai-primary\)/,
  );
  assert.throws(
    () => resolveActiveLoadout({ envValue: 'ghost', profile: LOADED }),
    /FADENO_LOADOUT names loadout "ghost"/,
  );
  assert.throws(
    () => resolveActiveLoadout({ localFileValue: 'ghost', profile: LOADED }),
    new RegExp(`${LOADOUT_LOCAL_FILE.replaceAll('\\', '\\\\')} names loadout "ghost"`),
  );
  // parseExecutorProfile validates default_loadout, but a hand-built profile
  // still gets the same guard with the source named.
  const broken: ExecutorProfile = { executors: {}, bindings: {}, loadouts: {}, defaultLoadout: 'ghost' };
  assert.throws(
    () => resolveActiveLoadout({ profile: broken }),
    /default_loadout names loadout "ghost", which is not declared — the profile has no `loadouts`/,
  );
});

test('readLocalLoadout reads .fadeno/local/loadout, trimmed; missing or blank → null', (t) => {
  const root = tempRepo(t);
  assert.equal(readLocalLoadout(root), null);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, LOADOUT_LOCAL_FILE), 'openai-primary\n', 'utf8');
  assert.equal(readLocalLoadout(root), 'openai-primary');
  writeFileSync(join(root, LOADOUT_LOCAL_FILE), '  \n', 'utf8');
  assert.equal(readLocalLoadout(root), null);
});

// --- role resolution ---

test('role resolution: explicit bindings[role] pin wins over the loadout slot', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    bindings: { implementer: 'opus-xhigh', '*': 'luna-cli' },
  });
  const resolved = resolveRole('implementer', 'worker', profile, 'openai-primary');
  assert.equal(resolved.executorName, 'opus-xhigh');
  assert.equal(resolved.source, 'binding');
});

test('role resolution: loadout slot serves the role archetype', () => {
  const resolved = resolveRole('implementer', 'worker', LOADED, 'openai-primary');
  assert.equal(resolved.executorName, 'luna-cli');
  assert.equal(resolved.source, 'loadout');
  assert.equal(resolved.executor.adapter, 'command');
  // Host-adapter executors resolve normally at this layer.
  const host = resolveRole('critic', 'reviewer', LOADED, 'anthropic-primary');
  assert.equal(host.executorName, 'terra-host');
  assert.equal(host.executor.adapter, 'host');
  assert.equal(host.source, 'loadout');
});

test('role resolution: falls through to the "*" default binding', () => {
  const profile = parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS, bindings: { '*': 'opus-xhigh' } });
  // No archetype at all.
  assert.deepEqual(
    { ...resolveRole('implementer', null, profile, 'openai-primary'), executor: undefined },
    { executorName: 'opus-xhigh', source: 'default', executor: undefined },
  );
  // Archetype with no slot in the active loadout.
  assert.equal(resolveRole('arbiter', 'judge', profile, 'openai-primary').source, 'default');
  // Archetype but no active loadout.
  assert.equal(resolveRole('implementer', 'worker', profile, null).source, 'default');
});

test('role resolution: hard error names role, archetype, loadout, and the fix', () => {
  assert.throws(
    () => resolveRole('arbiter', 'judge', LOADED, 'openai-primary'),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /No executor for role "arbiter" \(archetype "judge"; active loadout "openai-primary" has no "judge" slot; no "\*" default binding\)/.test(err.message) &&
      /add a "judge" slot to loadout "openai-primary"/.test(err.message) &&
      /pin `bindings.arbiter` to an executor/.test(err.message),
  );
  assert.throws(
    () => resolveRole('arbiter', null, LOADED, 'openai-primary'),
    /No executor for role "arbiter" \(no declared archetype;.*declare `archetype:` on role "arbiter"/s,
  );
  assert.throws(
    () => resolveRole('arbiter', 'judge', LOADED, null),
    /no active loadout.*activate a loadout that maps "judge"/s,
  );
});

// --- playbook role archetype field ---

function playbookWith(role: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'AgentPlaybook',
    roles: { implementer: role },
    flow: [{ id: 'a', kind: 'actor_call', actor: 'implementer', terminal_status: 'completed' }],
  };
}

test('playbook roles: a well-shaped archetype produces no issues', () => {
  const issues = semanticChecks(playbookWith({ purpose: 'x', archetype: 'worker' }), 'pb.yaml');
  assert.deepEqual(issues, []);
});

test('playbook roles: archetype absence is fine (no warning)', () => {
  const issues = semanticChecks(playbookWith({ purpose: 'x' }), 'pb.yaml');
  assert.deepEqual(issues, []);
});

test('playbook roles: a malformed archetype is an error', () => {
  const bad = semanticChecks(playbookWith({ purpose: 'x', archetype: 'Worker' }), 'pb.yaml');
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.severity, 'error');
  assert.equal(bad[0]!.path, '/roles/implementer/archetype');
  assert.match(bad[0]!.message, /role archetype "Worker" must be a bare lowercase identifier/);

  const nonString = semanticChecks(playbookWith({ purpose: 'x', archetype: 42 }), 'pb.yaml');
  assert.equal(nonString.length, 1);
  assert.match(nonString[0]!.message, /role archetype 42 must be a bare lowercase identifier/);
});

test('roleArchetype accessor reads the declared archetype or null', () => {
  const playbook = playbookWith({ purpose: 'x', archetype: 'worker' });
  assert.equal(roleArchetype(playbook, 'implementer'), 'worker');
  assert.equal(roleArchetype(playbook, 'ghost'), null);
  assert.equal(roleArchetype(playbookWith({ purpose: 'x' }), 'implementer'), null);
  assert.equal(roleArchetype(null, 'implementer'), null);
  assert.equal(roleArchetype({ roles: 'nope' }, 'implementer'), null);
});

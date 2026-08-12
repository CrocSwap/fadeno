import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  ExecutorProfileError,
  explainWriteConflict,
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
  'terra-host': {
    adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer',
    fallback_command: ['codex', 'exec', '--model', 'gpt-5.6-terra', '-'],
  },
};

const LOADOUTS = {
  'anthropic-primary': { worker: 'opus-xhigh', reviewer: 'terra-host' },
  'openai-primary': { worker: 'luna-cli', reviewer: 'terra-host' },
};

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

// --- loadouts / default_loadout parsing ---

test('v2 targets compile through the active harness route', () => {
  const document = stringifyYaml({
    schema_version: 2,
    targets: {
      opus: { provider: 'anthropic', model: 'opus', reasoning_effort: 'high' },
    },
    routes: {
      codex: {
        anthropic: { command: ['claude', '-p', '--model', '{model}'] },
        opus: { command: ['claude', '-p', '--model', '{model}', '--permission-mode', 'plan'] },
      },
      claude: { anthropic: { native: true, command: ['claude', '-p', '--model', '{model}'] } },
    },
    loadouts: { main: { worker: 'opus' } },
    default_loadout: 'main',
  });
  const codex = parseExecutorProfile(document, 'v2.yaml', 'codex');
  const claude = parseExecutorProfile(document, 'v2.yaml', 'claude');
  assert.deepEqual(codex.executors.opus, {
    adapter: 'command', command: ['claude', '-p', '--model', 'opus', '--permission-mode', 'plan'], model: 'opus',
    resume: null, sessionIdPattern: null, writeAccess: null, target: 'opus', provider: 'anthropic',
  });
  const native = resolveRole('implementer', 'worker', claude, 'main');
  assert.equal(native.executor.adapter, 'host');
  assert.equal(native.executor.adapter === 'host' ? native.executor.agentType : null, 'worker');
  assert.equal(native.executor.provider, 'anthropic');
});

test('v2 reports a missing provider route for the active harness', () => {
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({
      schema_version: 2,
      targets: { opus: { provider: 'anthropic', model: 'opus' } },
      routes: { codex: { openai: { native: true } } },
      loadouts: { main: { worker: 'opus' } },
    }), 'v2.yaml', 'codex'),
    /routes\.codex\.anthropic/,
  );
});

// --- route write capability + archetype requirements ---

test('v2 routes declare the write capability of their command delivery', () => {
  const document = stringifyYaml({
    schema_version: 2,
    targets: {
      opus: { provider: 'anthropic', model: 'opus' },
      luna: { provider: 'openai', model: 'gpt-5.6-luna' },
    },
    routes: {
      codex: {
        // The headless Claude fallback runs in the default permission mode.
        anthropic: { command: ['claude', '-p', '--model', '{model}'], write_access: false },
        openai: { command: ['codex', 'exec', '--sandbox', 'workspace-write', '-'], write_access: true },
      },
      claude: {
        anthropic: { native: true, command: ['claude', '-p', '--model', '{model}'], write_access: false },
        openai: { command: ['codex', 'exec', '-'] },
      },
    },
    loadouts: { main: { worker: 'opus', reviewer: 'luna' } },
  });

  const codex = parseExecutorProfile(document, 'v2.yaml', 'codex');
  assert.equal(codex.executors.opus!.writeAccess, false);
  assert.equal(codex.executors.luna!.writeAccess, true);

  const claude = parseExecutorProfile(document, 'v2.yaml', 'claude');
  // On a native route the flag describes the fallback command, not the
  // in-session agent — the host owns that agent's permissions.
  assert.equal(claude.executors.opus!.adapter, 'host');
  assert.equal(claude.executors.opus!.writeAccess, false);
  // Undeclared stays undeclared: no constraint, full backward compatibility.
  assert.equal(claude.executors.luna!.writeAccess, null);
});

test('route write_access must be boolean', () => {
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({
      schema_version: 2,
      targets: { opus: { provider: 'anthropic', model: 'opus' } },
      routes: { codex: { anthropic: { command: ['claude', '-p'], write_access: 'no' } } },
      loadouts: { main: { worker: 'opus' } },
    }), 'v2.yaml', 'codex'),
    /route `routes\.codex\.anthropic\.write_access` must be boolean/,
  );
});

test('a v1 executor may declare write_access; a non-boolean is rejected', () => {
  const profile = parseDoc({
    executors: { ro: { adapter: 'command', command: ['claude', '-p'], write_access: false } },
    bindings: { '*': 'ro' },
  });
  assert.equal(profile.executors.ro!.writeAccess, false);
  assert.equal(
    parseDoc({ executors: EXECUTORS, bindings: { '*': 'luna-cli' } }).executors['luna-cli']!.writeAccess,
    null,
  );
  assert.throws(
    () => parseDoc({
      executors: { ro: { adapter: 'command', command: ['claude', '-p'], write_access: 'no' } },
      bindings: { '*': 'ro' },
    }),
    /executor "ro" has a non-boolean `write_access`/,
  );
});

test('archetypes: requires_write parses; an absent block is an empty map', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
  });
  assert.deepEqual(profile.archetypes, {
    worker: { requiresWrite: true },
    reviewer: { requiresWrite: false },
  });
  assert.deepEqual(parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS }).archetypes, {});
});

test('archetypes: strict validation names the offending path', () => {
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS, archetypes: 'worker' }),
    /`archetypes` is not a mapping \(archetype → requirements\)/,
  );
  assert.throws(
    () => parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS, archetypes: { worker: 'yes' } }),
    /`archetypes\.worker` is not a mapping \(only `requires_write` is allowed\)/,
  );
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: LOADOUTS,
      archetypes: { worker: { requires_write: true, requires_network: true } },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /`archetypes\.worker` has unknown key\(s\) requires_network; only `requires_write` is allowed/.test(err.message),
  );
  for (const policy of [{ requires_write: 'yes' }, {}]) {
    assert.throws(
      () => parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS, archetypes: { worker: policy } }),
      /`archetypes\.worker\.requires_write` must be boolean/,
    );
  }
});

test('explainWriteConflict: one refusal, spoken identically by every enforcement point', () => {
  const profile = parseDoc({
    executors: {
      ro: { adapter: 'command', command: ['claude', '-p'], write_access: false },
      rw: { adapter: 'command', command: ['codex', 'exec', '-'], write_access: true },
      silent: { adapter: 'command', command: ['codex', 'exec', '-'] },
      'ro-host': {
        adapter: 'host', model: 'opus', reasoning_effort: 'high', agent_type: 'worker',
        fallback_command: ['claude', '-p'], write_access: false,
      },
    },
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
    bindings: { '*': 'ro' },
  });
  const spec = (name: string) => profile.executors[name]!;

  const conflict = explainWriteConflict({ executor: 'ro', spec: spec('ro') }, 'worker', profile);
  assert.ok(conflict != null);
  assert.match(conflict, /archetype "worker" declares `requires_write: true`, but executor "ro"/);
  assert.match(conflict, /`write_access: false`/);
  // Three ways out: rebind, re-permission the command, or stay in-session.
  assert.match(conflict, /bind "worker" to a write-capable executor/);
  assert.match(conflict, /permission mode/);
  assert.match(conflict, /native in-session worker agent/);

  // A host executor's `write_access` describes its command fallback, so the
  // same refusal applies when a caller is about to deliver through it.
  assert.equal(explainWriteConflict({ executor: 'ro-host', spec: spec('ro-host') }, 'worker', profile), conflict.replace('"ro"', '"ro-host"'));

  // No conflict: a write-capable delivery, an archetype that claims no write
  // need, an undeclared delivery, an undeclared archetype, no archetype at all.
  assert.equal(explainWriteConflict({ executor: 'rw', spec: spec('rw') }, 'worker', profile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: spec('ro') }, 'reviewer', profile), null);
  assert.equal(explainWriteConflict({ executor: 'silent', spec: spec('silent') }, 'worker', profile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: spec('ro') }, 'judge', profile), null);
  assert.equal(explainWriteConflict({ executor: 'ro', spec: spec('ro') }, null, profile), null);
});

test('target catalogs require the explicit v2 schema boundary', () => {
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({
      targets: { opus: { provider: 'anthropic', model: 'opus' } },
      routes: { codex: { anthropic: { native: true } } },
      loadouts: { main: { worker: 'opus' } },
    }), 'unversioned.yaml', 'codex'),
    /schema_version: 2/,
  );
  assert.throws(
    () => parseExecutorProfile('schema_version: 3\nexecutors: {x: {adapter: command, command: [x]}}\nbindings: {"*": x}\n', 'future.yaml'),
    /unsupported schema_version 3/,
  );
});

test('loadouts: happy path parses without bindings', () => {
  const profile = parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS, default_loadout: 'anthropic-primary' });
  assert.deepEqual(profile.loadouts, LOADOUTS);
  assert.equal(profile.defaultLoadout, 'anthropic-primary');
  assert.deepEqual(profile.bindings, {});
  assert.equal(profile.executors['terra-host']!.adapter, 'host');
  assert.deepEqual(
    profile.executors['terra-host']!.adapter === 'host' ? profile.executors['terra-host']!.fallbackCommand : null,
    ['codex', 'exec', '--model', 'gpt-5.6-terra', '-'],
  );
});

test('host fallback_command must be a non-empty argv', () => {
  for (const fallback of [[], ['codex', ''], 'codex exec']) {
    assert.throws(
      () => parseDoc({
        executors: {
          host: { adapter: 'host', model: 'gpt-5.6-sol', reasoning_effort: 'high', agent_type: 'worker', fallback_command: fallback },
        },
        bindings: { '*': 'host' },
      }),
      /fallback_command.*non-empty array of strings/,
    );
  }
});

test('command executors reject host-only fallback_command', () => {
  assert.throws(
    () => parseDoc({
      executors: { command: { adapter: 'command', command: ['codex', 'exec', '-'], fallback_command: ['codex', 'exec', '-'] } },
      bindings: { '*': 'command' },
    }),
    /rejects host-only.*fallback_command/,
  );
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

test('serializeProfile round-trips archetypes and declared write_access', () => {
  const profile = parseDoc({
    executors: {
      ...EXECUTORS,
      'read-only': { adapter: 'command', command: ['claude', '-p'], model: 'opus', write_access: false },
    },
    loadouts: { main: { worker: 'read-only', reviewer: 'terra-host' } },
    archetypes: { reviewer: { requires_write: false }, worker: { requires_write: true } },
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
  const broken: ExecutorProfile = { executors: {}, bindings: {}, archetypes: {}, loadouts: {}, defaultLoadout: 'ghost' };
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

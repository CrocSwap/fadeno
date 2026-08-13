import assert from 'node:assert/strict';
import type { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  ConstraintError,
  evaluateConstraint,
  type ConstraintContext,
} from '../src/lib/constraints.ts';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  eligibilityFor,
  explainEligibilityConflict,
  explainProviderConflict,
  parseExecutorProfile,
  serializeProfile,
  type ExecutorProfile,
  type InputProducer,
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

function producer(over: Partial<InputProducer> = {}): InputProducer {
  return { dispatchId: 'd1', executor: 'opus-xhigh', provider: 'anthropic', ...over };
}

const CONTEXT: ConstraintContext = {
  archetype: 'reviewer',
  role: 'critic',
  executor: 'luna-cli',
  target: null,
  provider: 'openai',
  model: 'gpt-5.6-luna',
  transport: 'command',
  write_access: null,
  write_posture: 'none',
  active_loadout: 'main',
  overrides: {},
  resolved_via: null,
  input_provenance: [],
  harness: 'standalone',
};

function fakeSpawn(partial: {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stderr?: string;
  stdout?: string;
}): typeof spawnSync {
  return ((_cmd, _args, _opts) => ({
    pid: 0,
    output: [],
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    status: partial.error != null ? null : (partial.status ?? 0),
    signal: partial.signal ?? null,
    error: partial.error,
  })) as typeof spawnSync;
}

// --- parse: distinct_provider_from_inputs ---

test('archetypes: advisory and required distinct_provider_from_inputs parse; absent is null', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: {
      reviewer: { distinct_provider_from_inputs: 'advisory' },
      judge: { distinct_provider_from_inputs: 'required' },
      worker: { requires_write: 'required' },
    },
  });
  assert.equal(profile.archetypes.reviewer!.distinctProviderFromInputs, 'advisory');
  assert.equal(profile.archetypes.judge!.distinctProviderFromInputs, 'required');
  assert.equal(profile.archetypes.worker!.distinctProviderFromInputs, null);
  assert.deepEqual(profile.archetypes.reviewer, {
    requiresWrite: 'none', fallback: null, distinctProviderFromInputs: 'advisory',
  });
});

test('archetypes: a bad distinct_provider_from_inputs value lists both forms', () => {
  for (const bad of ['yes', 'true', 'Advisory', 1, null, false]) {
    assert.throws(
      () => parseDoc({
        executors: EXECUTORS,
        loadouts: LOADOUTS,
        archetypes: { reviewer: { distinct_provider_from_inputs: bad } },
      }),
      (err: unknown) =>
        err instanceof ExecutorProfileError &&
        /`archetypes\.reviewer\.distinct_provider_from_inputs` must be /.test(err.message) &&
        /advisory/.test(err.message) &&
        /required/.test(err.message),
      String(bad),
    );
  }
});

test('archetypes: unknown keys name the three-key allowed set', () => {
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
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: LOADOUTS,
      archetypes: { worker: 'yes' },
    }),
    /`archetypes\.worker` is not a mapping \(only `requires_write`, `fallback`, and `distinct_provider_from_inputs` are allowed\)/,
  );
});

// --- parse: eligibility ---

test('eligibility: v1 command and host executors carry the map; absent is empty', () => {
  const profile = parseDoc({
    executors: {
      ...EXECUTORS,
      gated: {
        adapter: 'command', command: ['claude', '-p'],
        eligibility: { worker: 'eligible', reviewer: 'shadow_only', judge: 'forbidden' },
      },
      terra: {
        adapter: 'host', model: 'opus', reasoning_effort: 'high', agent_type: 'reviewer',
        eligibility: { worker: 'forbidden' },
      },
    },
    loadouts: { main: { worker: 'gated', reviewer: 'terra' } },
  });
  assert.deepEqual(specOf(profile, 'gated').eligibility, {
    worker: 'eligible', reviewer: 'shadow_only', judge: 'forbidden',
  });
  assert.deepEqual(specOf(profile, 'terra').eligibility, { worker: 'forbidden' });
  assert.deepEqual(specOf(profile, 'luna-cli').eligibility, {});
});

test('eligibility: v2 targets compile the map onto both native and command branches', () => {
  const document = stringifyYaml({
    schema_version: 2,
    targets: {
      opus: {
        provider: 'anthropic',
        model: 'opus',
        eligibility: { worker: 'eligible', reviewer: 'shadow_only', judge: 'forbidden' },
      },
    },
    routes: {
      standalone: { anthropic: { command: ['claude', '-p', '--model', '{model}'] } },
      claude: { anthropic: { host: true, command: ['claude', '-p', '--model', '{model}'] } },
    },
    loadouts: { main: { worker: 'opus' } },
  });
  const command = parseExecutorProfile(document, 'v2.yaml', 'standalone');
  const native = parseExecutorProfile(document, 'v2.yaml', 'claude');
  const expected = { worker: 'eligible', reviewer: 'shadow_only', judge: 'forbidden' };
  assert.deepEqual(specOf(command, 'opus').eligibility, expected);
  assert.equal(specOf(command, 'opus').adapter, 'command');
  assert.deepEqual(specOf(native, 'opus').eligibility, expected);
  assert.equal(specOf(native, 'opus').adapter, 'host');
});

test('eligibility: a bad state lists the three; keys must be bare identifiers', () => {
  for (const bad of ['yes', 'Eligible', 'deny', 1, null, true]) {
    assert.throws(
      () => parseDoc({
        executors: {
          gated: { adapter: 'command', command: ['claude', '-p'], eligibility: { worker: bad } },
        },
        bindings: { '*': 'gated' },
      }),
      (err: unknown) =>
        err instanceof ExecutorProfileError &&
        /executor "gated" `eligibility\.worker` must be /.test(err.message) &&
        /eligible/.test(err.message) &&
        /shadow_only/.test(err.message) &&
        /forbidden/.test(err.message),
      String(bad),
    );
  }
  assert.throws(
    () => parseDoc({
      executors: {
        gated: { adapter: 'command', command: ['claude', '-p'], eligibility: { Worker: 'eligible' } },
      },
      bindings: { '*': 'gated' },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /executor "gated" eligibility key "Worker" is not a bare lowercase identifier/.test(err.message) &&
      err.message.includes(BARE_IDENTIFIER_RE.source),
  );
  assert.throws(
    () => parseDoc({
      executors: {
        gated: { adapter: 'command', command: ['claude', '-p'], eligibility: ['worker'] },
      },
      bindings: { '*': 'gated' },
    }),
    /executor "gated" `eligibility` is not a mapping/,
  );
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({
      schema_version: 2,
      targets: { opus: { provider: 'anthropic', model: 'opus', eligibility: { Reviewer: 'forbidden' } } },
      routes: { standalone: { anthropic: { command: ['claude', '-p'] } } },
      loadouts: { main: { worker: 'opus' } },
    }), 'v2.yaml', 'standalone'),
    /target "opus" eligibility key "Reviewer" is not a bare lowercase identifier/,
  );
});

// --- parse: constraints ---

test('constraints: a valid command parses; absent is null', () => {
  const withCmd = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    constraints: { command: ['node', '.fadeno/constraints.mjs'] },
  });
  assert.deepEqual(withCmd.constraints, { command: ['node', '.fadeno/constraints.mjs'] });
  assert.equal(parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS }).constraints, null);
});

test('constraints: only command is allowed; argv must be a non-empty string array', () => {
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS, loadouts: LOADOUTS, constraints: 'node',
    }),
    /`constraints` is not a mapping \(only `command` is allowed\)/,
  );
  assert.throws(
    () => parseDoc({
      executors: EXECUTORS,
      loadouts: LOADOUTS,
      constraints: { command: ['node'], extra: true },
    }),
    /`constraints` has unknown key\(s\) extra; only `command` is allowed/,
  );
  for (const bad of [undefined, [], [''], ['node', ''], 'node', 1, null]) {
    assert.throws(
      () => parseDoc({
        executors: EXECUTORS,
        loadouts: LOADOUTS,
        constraints: { command: bad },
      }),
      /`constraints\.command` must be a non-empty array of non-empty strings/,
      String(bad),
    );
  }
});

// --- eligibilityFor ---

test('eligibilityFor: defaults to eligible; hasOwn-hardens prototype keys', () => {
  const profile = parseDoc({
    executors: {
      ...EXECUTORS,
      gated: {
        adapter: 'command', command: ['claude', '-p'],
        eligibility: { reviewer: 'shadow_only', constructor: 'forbidden' },
      },
    },
    loadouts: LOADOUTS,
  });
  const bare = specOf(profile, 'luna-cli');
  const gated = specOf(profile, 'gated');
  assert.equal(eligibilityFor(bare, 'worker'), 'eligible');
  assert.equal(eligibilityFor(bare, null), 'eligible');
  assert.equal(eligibilityFor(gated, 'reviewer'), 'shadow_only');
  assert.equal(eligibilityFor(gated, 'worker'), 'eligible');
  assert.equal(eligibilityFor(gated, 'constructor'), 'forbidden');
  assert.equal(eligibilityFor(gated, 'toString'), 'eligible');
  assert.equal(eligibilityFor(gated, null), 'eligible');
});

// --- explainEligibilityConflict ---

test('explainEligibilityConflict: forbidden refuses; shadow_only and eligible do not', () => {
  const profile = parseDoc({
    executors: {
      gated: {
        adapter: 'command', command: ['claude', '-p'],
        eligibility: { judge: 'forbidden', reviewer: 'shadow_only', worker: 'eligible' },
      },
    },
    bindings: { '*': 'gated' },
  });
  const delivery = { executor: 'gated', spec: specOf(profile, 'gated') };

  const forbidden = explainEligibilityConflict(delivery, 'judge');
  assert.ok(forbidden != null);
  assert.match(forbidden, /archetype "judge"/);
  assert.match(forbidden, /`eligibility: forbidden`/);
  assert.match(forbidden, /executor "gated"/);
  assert.match(forbidden, /choose an eligible executor/);
  assert.match(forbidden, /dial a different target/);
  assert.match(forbidden, /change the catalog's eligibility entry/);

  assert.equal(explainEligibilityConflict(delivery, 'reviewer'), null);
  assert.equal(explainEligibilityConflict(delivery, 'worker'), null);
  assert.equal(explainEligibilityConflict(delivery, 'scout'), null);
  assert.equal(explainEligibilityConflict(delivery, null), null);
});

// --- explainProviderConflict ---

test('explainProviderConflict: null policy or empty producers is no check', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: {
      reviewer: { distinct_provider_from_inputs: 'required' },
      worker: { requires_write: 'required' },
    },
  });
  const clash = [producer({ provider: 'openai' })];
  assert.equal(explainProviderConflict(null, 'openai', clash, profile), null);
  assert.equal(explainProviderConflict('scout', 'openai', clash, profile), null);
  assert.equal(explainProviderConflict('worker', 'openai', clash, profile), null);
  assert.equal(explainProviderConflict('reviewer', 'openai', [], profile), null);
  assert.equal(explainProviderConflict('reviewer', null, [], profile), null);
});

test('explainProviderConflict: declared-archetype only — fallback does not import policy', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: {
      scout: { fallback: 'reviewer' },
      reviewer: { distinct_provider_from_inputs: 'required' },
    },
  });
  const clash = [producer({ provider: 'anthropic' })];
  assert.equal(explainProviderConflict('scout', 'anthropic', clash, profile), null);
  const hit = explainProviderConflict('reviewer', 'anthropic', clash, profile);
  assert.ok(hit != null);
  assert.equal(hit.level, 'refuse');
});

test('explainProviderConflict: clash refuses under required and warns under advisory', () => {
  const required = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { reviewer: { distinct_provider_from_inputs: 'required' } },
  });
  const advisory = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { reviewer: { distinct_provider_from_inputs: 'advisory' } },
  });
  const clash = [producer({ dispatchId: 'disp-9', executor: 'opus-xhigh', provider: 'anthropic' })];

  const refuse = explainProviderConflict('reviewer', 'anthropic', clash, required);
  assert.ok(refuse != null);
  assert.equal(refuse.level, 'refuse');
  assert.match(refuse.message, /archetype "reviewer"/);
  assert.match(refuse.message, /`distinct_provider_from_inputs: required`/);
  assert.match(refuse.message, /provider "anthropic"/);
  assert.match(refuse.message, /dispatch disp-9/);

  const warn = explainProviderConflict('reviewer', 'anthropic', clash, advisory);
  assert.ok(warn != null);
  assert.equal(warn.level, 'warn');
  assert.match(warn.message, /`distinct_provider_from_inputs: advisory`/);
  assert.match(warn.message, /dispatch disp-9/);

  const byExecutor = explainProviderConflict(
    'reviewer',
    'anthropic',
    [producer({ dispatchId: null, executor: 'opus-xhigh', provider: 'anthropic' })],
    required,
  );
  assert.ok(byExecutor != null);
  assert.match(byExecutor.message, /executor "opus-xhigh"/);
});

test('explainProviderConflict: unresolvable provenance refuses under required and warns under advisory', () => {
  const required = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { reviewer: { distinct_provider_from_inputs: 'required' } },
  });
  const advisory = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { reviewer: { distinct_provider_from_inputs: 'advisory' } },
  });
  const unknownProducer = [producer({ dispatchId: 'disp-3', provider: null })];

  const refuseProducer = explainProviderConflict('reviewer', 'openai', unknownProducer, required);
  assert.ok(refuseProducer != null);
  assert.equal(refuseProducer.level, 'refuse');
  assert.match(refuseProducer.message, /archetype "reviewer"/);
  assert.match(refuseProducer.message, /dispatch disp-3/);
  assert.match(refuseProducer.message, /provenance is demanded but unresolvable/);

  const warnProducer = explainProviderConflict('reviewer', 'openai', unknownProducer, advisory);
  assert.ok(warnProducer != null);
  assert.equal(warnProducer.level, 'warn');
  assert.match(warnProducer.message, /provider provenance is unresolvable/);

  const refuseTarget = explainProviderConflict('reviewer', null, [producer()], required);
  assert.ok(refuseTarget != null);
  assert.equal(refuseTarget.level, 'refuse');
  assert.match(refuseTarget.message, /resolved target's provider is unknown/);
  assert.match(refuseTarget.message, /provenance is demanded but unresolvable/);

  const warnTarget = explainProviderConflict('reviewer', null, [producer()], advisory);
  assert.ok(warnTarget != null);
  assert.equal(warnTarget.level, 'warn');
  assert.match(warnTarget.message, /resolved target's provider is unknown/);
});

test('explainProviderConflict: distinct providers pass; a later clash still fires', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { reviewer: { distinct_provider_from_inputs: 'required' } },
  });
  assert.equal(
    explainProviderConflict('reviewer', 'openai', [producer({ provider: 'anthropic' })], profile),
    null,
  );
  const mixed = explainProviderConflict(
    'reviewer',
    'openai',
    [producer({ provider: 'anthropic' }), producer({ dispatchId: 'd2', provider: 'openai' })],
    profile,
  );
  assert.ok(mixed != null);
  assert.equal(mixed.level, 'refuse');
  assert.match(mixed.message, /dispatch d2/);
});

// --- serialize ---

test('serializeProfile: eligibility, distinct_provider, and constraints round-trip', () => {
  const profile = parseDoc({
    executors: {
      ...EXECUTORS,
      gated: {
        adapter: 'command', command: ['claude', '-p'],
        eligibility: { worker: 'eligible', judge: 'forbidden', reviewer: 'shadow_only' },
      },
    },
    loadouts: { main: { worker: 'gated', reviewer: 'opus-xhigh' } },
    archetypes: {
      reviewer: { distinct_provider_from_inputs: 'advisory' },
      judge: { distinct_provider_from_inputs: 'required', fallback: 'reviewer' },
      worker: { requires_write: 'required' },
    },
    constraints: { command: ['node', '.fadeno/constraints.mjs'] },
  });

  const text = serializeProfile(profile);
  assert.match(text, /eligibility:/);
  assert.match(text, /worker: eligible/);
  assert.match(text, /judge: forbidden/);
  assert.match(text, /reviewer: shadow_only/);
  assert.match(text, /distinct_provider_from_inputs: advisory/);
  assert.match(text, /distinct_provider_from_inputs: required/);
  assert.match(text, /constraints:/);
  assert.match(text, /\.fadeno\/constraints\.mjs/);
  // Sorted keys: judge before reviewer before worker.
  assert.ok(text.indexOf('judge: forbidden') < text.indexOf('reviewer: shadow_only'));
  assert.ok(text.indexOf('reviewer: shadow_only') < text.indexOf('worker: eligible'));
  // Empty eligibility is omitted; declared eligible is kept.
  const lunaBlock = text.slice(text.indexOf('luna-cli:'), text.indexOf('opus-xhigh:'));
  assert.doesNotMatch(lunaBlock, /eligibility:/);

  const omitted = serializeProfile(parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    archetypes: { worker: { requires_write: 'required' } },
  }));
  assert.doesNotMatch(omitted, /eligibility:/);
  assert.doesNotMatch(omitted, /distinct_provider_from_inputs:/);
  assert.doesNotMatch(omitted, /constraints:/);

  const roundTrip = parseExecutorProfile(text, 'round-trip.yaml');
  assert.deepEqual(roundTrip.archetypes, profile.archetypes);
  assert.deepEqual(roundTrip.executors.gated!.eligibility, profile.executors.gated!.eligibility);
  assert.deepEqual(roundTrip.constraints, profile.constraints);
  assert.deepEqual(roundTrip, profile);
  assert.equal(serializeProfile(roundTrip), text);
});

// --- evaluateConstraint ---

test('evaluateConstraint: no constraints allows without spawning', () => {
  const profile = parseDoc({ executors: EXECUTORS, loadouts: LOADOUTS });
  let called = false;
  const verdict = evaluateConstraint(profile, CONTEXT, {
    cwd: '/tmp/repo',
    spawn: ((..._args: unknown[]) => {
      called = true;
      throw new Error('must not spawn');
    }) as typeof spawnSync,
  });
  assert.deepEqual(verdict, { verdict: 'allowed' });
  assert.equal(called, false);
});

test('evaluateConstraint: exit 0 allows and feeds JSON context on stdin', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    constraints: { command: ['node', '.fadeno/constraints.mjs'] },
  });
  let captured: { cmd: unknown; args: unknown; opts: { cwd?: string; input?: string } } | null = null;
  const verdict = evaluateConstraint(profile, CONTEXT, {
    cwd: '/tmp/repo',
    spawn: ((cmd, args, opts) => {
      captured = { cmd, args, opts: opts as { cwd?: string; input?: string } };
      return fakeSpawn({ status: 0 })(cmd, args, opts);
    }) as typeof spawnSync,
  });
  assert.deepEqual(verdict, { verdict: 'allowed' });
  assert.ok(captured != null);
  assert.equal(captured.cmd, 'node');
  assert.deepEqual(captured.args, ['.fadeno/constraints.mjs']);
  assert.equal(captured.opts.cwd, '/tmp/repo');
  assert.equal(captured.opts.input, JSON.stringify(CONTEXT));
});

test('evaluateConstraint: exit 2 refuses with trimmed stderr or the fixed fallback', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    constraints: { command: ['node', '.fadeno/constraints.mjs'] },
  });
  assert.deepEqual(
    evaluateConstraint(profile, CONTEXT, {
      cwd: '/tmp/repo',
      spawn: fakeSpawn({ status: 2, stderr: '  family mismatch\n' }),
    }),
    { verdict: 'refused', reason: 'family mismatch' },
  );
  assert.deepEqual(
    evaluateConstraint(profile, CONTEXT, {
      cwd: '/tmp/repo',
      spawn: fakeSpawn({ status: 2, stderr: '  \n' }),
    }),
    { verdict: 'refused', reason: 'constraint command refused the dispatch (no reason on stderr)' },
  );
});

test('evaluateConstraint: any other exit, signal, or spawn failure throws ConstraintError', () => {
  const profile = parseDoc({
    executors: EXECUTORS,
    loadouts: LOADOUTS,
    constraints: { command: ['node', '.fadeno/constraints.mjs'] },
  });
  assert.throws(
    () => evaluateConstraint(profile, CONTEXT, { cwd: '/tmp/repo', spawn: fakeSpawn({ status: 1 }) }),
    (err: unknown) =>
      err instanceof ConstraintError &&
      /constraint command \["node",".fadeno\/constraints.mjs"\] exited 1/.test(err.message),
  );
  assert.throws(
    () => evaluateConstraint(profile, CONTEXT, {
      cwd: '/tmp/repo',
      spawn: fakeSpawn({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
    }),
    (err: unknown) =>
      err instanceof ConstraintError &&
      /constraint command \["node",".fadeno\/constraints.mjs"\] failed to spawn: spawn ENOENT/.test(err.message),
  );
  assert.throws(
    () => evaluateConstraint(profile, CONTEXT, {
      cwd: '/tmp/repo',
      spawn: fakeSpawn({ status: null, signal: 'SIGTERM' }),
    }),
    (err: unknown) =>
      err instanceof ConstraintError &&
      /constraint command \["node",".fadeno\/constraints.mjs"\] terminated by signal SIGTERM/.test(err.message),
  );
});

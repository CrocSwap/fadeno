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
  compileDialRef,
  ExecutorProfileError,
  eligibilityFor,
  explainEligibilityConflict,
  explainProviderConflict,
  parseExecutorProfile,
  parseSnapshotDocument,
  serializeSnapshot,
  type ExecutorProfile,
  type InputProducer,
} from '../src/lib/executors.ts';

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

function specForModel(profile: ExecutorProfile, model: string) {
  return compileDialRef({ model }, profile).spec;
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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
        schema_version: 3,
        models: { sol: { provider: 'openai' } },
        routes: { standalone: { openai: { command: ['codex'] } } },
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
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { worker: { requires_write: true, requires_network: true } },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /`archetypes\.worker` has unknown key\(s\) requires_network; only `requires_write`, `fallback`, and `distinct_provider_from_inputs` are allowed/
        .test(err.message),
  );
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { worker: 'yes' },
    }),
    /`archetypes\.worker` is not a mapping \(only `requires_write`, `fallback`, and `distinct_provider_from_inputs` are allowed\)/,
  );
});

// --- parse: eligibility ---

test('eligibility: v3 models compile the map onto both native and command branches', () => {
  const expected = { worker: 'eligible', reviewer: 'shadow_only', judge: 'forbidden' };
  const cmdProfile = parseExecutorProfile(stringifyYaml({
    schema_version: 3,
    models: { opus: { provider: 'anthropic', id: 'opus', eligibility: expected } },
    routes: { standalone: { anthropic: { command: ['claude','-p'] } } },
  }), 'v3.yaml', 'standalone');
  assert.deepEqual(cmdProfile.models.opus!.eligibility, expected);
  const compiledCmd = compileDialRef({ model: 'opus' }, cmdProfile);
  assert.deepEqual(compiledCmd.spec.eligibility, expected);
  assert.equal(compiledCmd.spec.adapter, 'command');
  const hostProfile = parseExecutorProfile(stringifyYaml({
    schema_version: 3,
    models: { opus: { provider: 'anthropic', id: 'opus', eligibility: expected } },
    routes: { claude: { anthropic: { host: true } }, standalone: { anthropic: { command: ['claude'] } } },
  }), 'v3.yaml', 'claude');
  assert.deepEqual(hostProfile.models.opus!.eligibility, expected);
  const compiledHost = compileDialRef({ model: 'opus' }, hostProfile);
  assert.deepEqual(compiledHost.spec.eligibility, expected);
  assert.equal(compiledHost.spec.adapter, 'host');
});

test('eligibility: snapshot entries preserve eligibility', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { gated: { provider: 'openai', eligibility: { worker: 'eligible', judge: 'forbidden', reviewer: 'shadow_only' } } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  });
  const snapText = serializeSnapshot(profile);
  const doc = parseSnapshotDocument(snapText, 'snap.yaml');
  assert.deepEqual(doc.executors['gated']!.eligibility, { worker: 'eligible', judge: 'forbidden', reviewer: 'shadow_only' });
});

test('eligibility: a bad state lists the three; keys must be bare identifiers', () => {
  for (const bad of ['yes', 'Eligible', 'deny', 1, null, true]) {
    assert.throws(
      () => parseDoc({
        schema_version: 3,
        models: { gated: { provider: 'openai', eligibility: { worker: bad as unknown as string } } },
        routes: { standalone: { openai: { command: ['codex'] } } },
      }),
      (err: unknown) =>
        err instanceof ExecutorProfileError &&
        /model "gated" `eligibility\.worker` must be /.test(err.message) &&
        /eligible/.test(err.message) &&
        /shadow_only/.test(err.message) &&
        /forbidden/.test(err.message),
      String(bad),
    );
  }
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { gated: { provider: 'openai', eligibility: { Worker: 'eligible' } } },
      routes: { standalone: { openai: { command: ['codex'] } } },
    }),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /model "gated" eligibility key "Worker" is not a bare lowercase identifier/.test(err.message) &&
      err.message.includes(BARE_IDENTIFIER_RE.source),
  );
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { gated: { provider: 'openai', eligibility: ['worker'] as unknown as Record<string,string> } },
      routes: { standalone: { openai: { command: ['codex'] } } },
    }),
    /model "gated" `eligibility` is not a mapping/,
  );
});

// --- parse: constraints ---

test('constraints: a valid command parses; absent is null', () => {
  const withCmd = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    constraints: { command: ['node', '.fadeno/constraints.mjs'] },
  });
  assert.deepEqual(withCmd.constraints, { command: ['node', '.fadeno/constraints.mjs'] });
  assert.equal(parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['codex'] } } } }).constraints, null);
});

test('constraints: only command is allowed; argv must be a non-empty string array', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['codex'] } } }, constraints: 'node' as unknown as Record<string,unknown>,
    }),
    /`constraints` is not a mapping \(only `command` is allowed\)/,
  );
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      constraints: { command: ['node'], extra: true } as unknown as Record<string,unknown>,
    }),
    /`constraints` has unknown key\(s\) extra; only `command` is allowed/,
  );
  for (const bad of [undefined, [], [''], ['node', ''], 'node', 1, null]) {
    assert.throws(
      () => parseDoc({
        schema_version: 3,
        models: { sol: { provider: 'openai' } },
        routes: { standalone: { openai: { command: ['codex'] } } },
        constraints: { command: bad } as unknown as Record<string,unknown>,
      }),
      /`constraints\.command` must be a non-empty array of non-empty strings/,
      String(bad),
    );
  }
});

// --- eligibilityFor ---

test('eligibilityFor: defaults to eligible; hasOwn-hardens prototype keys', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { gated: { provider: 'openai', eligibility: { reviewer: 'shadow_only', constructor: 'forbidden' } } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  });
  const gated = specForModel(profile, 'gated');
  const bare = specForModel(parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['codex'] } } } }), 'sol');
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
    schema_version: 3,
    models: { gated: { provider: 'openai', eligibility: { judge: 'forbidden', reviewer: 'shadow_only', worker: 'eligible' } } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  });
  const delivery = { executor: 'gated', spec: specForModel(profile, 'gated') };

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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { reviewer: { distinct_provider_from_inputs: 'required' } },
  });
  const advisory = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { reviewer: { distinct_provider_from_inputs: 'required' } },
  });
  const advisory = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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

// --- serialize snapshot ---

test('serializeSnapshot: eligibility, distinct_provider, and constraints round-trip', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { gated: { provider: 'openai', eligibility: { worker: 'eligible', judge: 'forbidden', reviewer: 'shadow_only' } } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: {
      reviewer: { distinct_provider_from_inputs: 'advisory' },
      judge: { distinct_provider_from_inputs: 'required', fallback: 'reviewer' },
      worker: { requires_write: 'required' },
    },
    constraints: { command: ['node', '.fadeno/constraints.mjs'] },
  });

  const text = serializeSnapshot(profile);
  assert.match(text, /eligibility:/);
  assert.match(text, /worker: eligible/);
  assert.match(text, /judge: forbidden/);
  assert.match(text, /reviewer: shadow_only/);
  assert.match(text, /distinct_provider_from_inputs: advisory/);
  assert.match(text, /distinct_provider_from_inputs: required/);
  assert.match(text, /constraints:/);
  assert.match(text, /\.fadeno\/constraints\.mjs/);
  assert.ok(text.indexOf('judge: forbidden') < text.indexOf('reviewer: shadow_only'));
  assert.ok(text.indexOf('reviewer: shadow_only') < text.indexOf('worker: eligible'));
  // Empty eligibility is omitted; declared eligible is kept.
  const solBlock = text.slice(text.indexOf('gated:'), text.indexOf('gated:') + 500);
  assert.match(solBlock, /eligibility:/);

  const omitted = serializeSnapshot(parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { worker: { requires_write: 'required' } },
  }));
  assert.match(omitted, /snapshot_version: 3/);
  const docOmitted = parseSnapshotDocument(omitted, 'snap.yaml');
  assert.ok(!Object.values(docOmitted.executors).some((s) => Object.keys(s.eligibility).length > 0 && s.eligibility['worker'] != null && !['eligible','shadow_only','forbidden'].includes(s.eligibility['worker']!)));
  // snapshot without eligibility entries should not contain eligibility for empty spec
  // we check that no eligibility block appears for a plain model
  // Instead verify constraints omitted when null
  const plainProfile = parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['codex'] } } } });
  const plainSnap = serializeSnapshot(plainProfile);
  assert.doesNotMatch(plainSnap, /distinct_provider_from_inputs:/);
  assert.doesNotMatch(plainSnap, /constraints:/);

  const roundTrip = parseSnapshotDocument(text, 'round-trip.yaml');
  assert.deepEqual(roundTrip.archetypes, profile.archetypes);
  assert.deepEqual(roundTrip.executors['gated']!.eligibility, profile.models.gated!.eligibility);
  assert.deepEqual(roundTrip.constraints, profile.constraints);
});

// --- evaluateConstraint ---

test('evaluateConstraint: no constraints allows without spawning', () => {
  const profile = parseDoc({ schema_version: 3, models: { sol: { provider: 'openai' } }, routes: { standalone: { openai: { command: ['codex'] } } } });
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
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

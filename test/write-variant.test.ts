import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  applyWritePosture,
  compileDialRef,
  ExecutorProfileError,
  explainWriteConflict,
  parseExecutorProfile,
  parseSnapshotDocument,
  serializeSnapshot,
  type CommandExecutorSpec,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { runDialResolve, runDialSet, runDialShow } from '../src/commands/dial.ts';
import { runDispatch } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

// The recurring shape: a read-only claude-style route that declares the
// write-capable argv it escalates to for write-requiring archetypes.
const VARIANT_ROUTES = {
  standalone: {
    anthropic: {
      command: ['claude', '-p', '--model', '{model}'],
      write_access: false,
      write_variant: { command: ['claude', '-p', '--model', '{model}', '--permission-mode', 'acceptEdits'] },
    },
    openai: { command: ['codex', 'exec', '-'], write_access: true },
    'current-host': { host: true },
  },
};

const VARIANT_DOC = {
  schema_version: 3,
  models: {
    opus: { provider: 'anthropic', id: 'opus-id', effort: 'high' },
    sol: { provider: 'openai', id: 'sol-id', effort: 'high' },
  },
  routes: VARIANT_ROUTES,
  archetypes: {
    worker: { requires_write: 'required' },
    reviewer: { requires_write: 'none' },
    generator: { requires_write: 'forbidden' },
  },
};

// --- parse ---

test('write_variant: parses and compiles with {model}/{reasoning_effort} substitution', () => {
  const profile = parseDoc(VARIANT_DOC);
  const spec = compileDialRef({ model: 'opus' }, profile).spec as CommandExecutorSpec;
  assert.equal(spec.writeAccess, false);
  assert.deepEqual(spec.writeVariant, {
    command: ['claude', '-p', '--model', 'opus-id', '--permission-mode', 'acceptEdits'],
    resume: null,
  });
  // Base argv untouched
  assert.deepEqual(spec.command, ['claude', '-p', '--model', 'opus-id']);
});

test('write_variant: refused on a route that is not write_access: false', () => {
  for (const write_access of [true, undefined]) {
    assert.throws(
      () => parseDoc({
        schema_version: 3,
        models: { sol: { provider: 'openai' } },
        routes: {
          standalone: {
            openai: {
              command: ['codex'],
              ...(write_access !== undefined ? { write_access } : {}),
              write_variant: { command: ['codex', '--yolo'] },
            },
          },
        },
      }),
      (err: unknown) =>
        err instanceof ExecutorProfileError &&
        /declares `write_variant` but not `write_access: false`/.test(err.message),
      `write_access: ${String(write_access)}`,
    );
  }
});

test('write_variant: refused on host routes, without a base command, on bad shapes, and on unknown keys', () => {
  const route = (variant: unknown, base: Record<string, unknown> = { command: ['claude'], write_access: false }) => ({
    schema_version: 3,
    models: { opus: { provider: 'anthropic' } },
    routes: { standalone: { anthropic: { ...base, write_variant: variant } } },
  });
  // host: true refuses the key outright — no host lane can deliver a variant.
  assert.throws(
    () => parseDoc(route({ command: ['claude', '--write'] }, { host: true, command: ['claude'], write_access: false })),
    /declares `write_variant` on a `host: true` route/,
  );
  assert.throws(
    () => parseDoc(route({ command: ['claude', '--write'] }, { write_access: false })),
    /declares `write_variant` but no `command`/,
  );
  assert.throws(() => parseDoc(route(['claude'])), /must be a mapping/);
  assert.throws(() => parseDoc(route({ command: [] })), /write_variant\.command` must be a non-empty string array/);
  assert.throws(() => parseDoc(route({ command: ['claude'], mode: 'yolo' })), /unknown key\(s\) mode/);
  assert.throws(
    () => parseDoc(route({ command: ['claude', '--write'], resume: ['claude', '--resume'] })),
    /write_variant\.resume` must contain \{session_id\}/,
  );
});

test('write_variant: a no-op variant (argv identical to the base) is refused', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { opus: { provider: 'anthropic' } },
      routes: {
        standalone: {
          anthropic: {
            command: ['claude', '-p', '--model', '{model}'],
            write_access: false,
            write_variant: { command: ['claude', '-p', '--model', '{model}'] },
          },
        },
      },
    }),
    /write_variant\.command` is identical to the base command/,
  );
});

test('write_variant: session coherence enforced — the postured spec must keep the resume ⟺ id-source invariant', () => {
  const doc = (base: Record<string, unknown>, variant: Record<string, unknown>) => ({
    schema_version: 3,
    models: { opus: { provider: 'anthropic' } },
    routes: { standalone: { anthropic: { ...base, write_variant: variant } } },
  });
  const sessionBase = {
    command: ['claude', '-p', '--session-id', '{session_id}', '--model', '{model}'],
    resume: ['claude', '--resume', '{session_id}'],
    write_access: false,
  };
  // The natural authoring mistake: copy the base command (placeholder and
  // all), append a flag, declare no variant resume → literal {session_id}
  // would reach spawn. Refused.
  assert.throws(
    () => parseDoc(doc(sessionBase, { command: [...sessionBase.command, '--permission-mode', 'acceptEdits'] })),
    /contains \{session_id\} but the variant declares no `resume`/,
  );
  // Variant resume with no id source at all.
  assert.throws(
    () => parseDoc(doc(
      { command: ['claude', '-p'], write_access: false },
      { command: ['claude', '-p', '--write'], resume: ['claude', '--resume', '{session_id}'] },
    )),
    /declares `resume` but no session id source/,
  );
  // Variant resume with BOTH id sources (minting command + inherited pattern).
  assert.throws(
    () => parseDoc(doc(
      { command: ['claude', '-p'], resume: ['claude', '--resume', '{session_id}'], session_id_pattern: 'session (\\S+)', write_access: false },
      { command: ['claude', '-p', '--session-id', '{session_id}', '--write'], resume: ['claude', '--resume', '{session_id}', '--write'] },
    )),
    /both a \{session_id\} placeholder in its command and inherits `session_id_pattern`/,
  );
});

test('write_variant: a variant with its own resume keeps the route session_id_pattern after posturing', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { opus: { provider: 'anthropic', id: 'opus-id', effort: 'high' } },
    routes: {
      standalone: {
        anthropic: {
          command: ['claude', '-p', '--model', '{model}'],
          resume: ['claude', '--resume', '{session_id}'],
          session_id_pattern: 'session (\\S+)',
          write_access: false,
          write_variant: {
            command: ['claude', '-p', '--model', '{model}', '--permission-mode', 'acceptEdits'],
            resume: ['claude', '--resume', '{session_id}', '--permission-mode', 'acceptEdits'],
          },
        },
      },
    },
    archetypes: { worker: { requires_write: 'required' } },
  });
  const postured = applyWritePosture(compileDialRef({ model: 'opus' }, profile).spec, 'worker', profile.archetypes);
  assert.equal(postured.usedWriteVariant, true);
  const spec = postured.spec as CommandExecutorSpec;
  assert.deepEqual(spec.resume, ['claude', '--resume', '{session_id}', '--permission-mode', 'acceptEdits']);
  assert.equal(spec.sessionIdPattern, 'session (\\S+)');
});

test('applyWritePosture: idempotent — a second application is a deep-equal no-op', () => {
  const profile = parseDoc(VARIANT_DOC);
  const compiled = compileDialRef({ model: 'opus' }, profile);
  const once = applyWritePosture(compiled.spec, 'worker', profile.archetypes);
  const twice = applyWritePosture(once.spec, 'worker', profile.archetypes);
  assert.equal(twice.usedWriteVariant, false);
  assert.deepEqual(twice.spec, once.spec);
  // The source spec was not mutated: it still carries the variant.
  assert.notEqual((compiled.spec as CommandExecutorSpec).writeVariant, undefined);
});

test('write_variant: the snapshot parser is as strict as the catalog parser', () => {
  const entry = (variant: Record<string, unknown>) => [
    'snapshot_version: 3',
    'executors:',
    '  opus:',
    '    adapter: command',
    '    command: [claude, -p]',
    '    write_access: false',
    `    write_variant: ${JSON.stringify(variant)}`,
    'archetypes:',
    '  worker: { requires_write: required }',
    '',
  ].join('\n');
  assert.throws(
    () => parseSnapshotDocument(entry({ command: ['claude', '-p', '--write'], resume: ['claude', '--resume', 'NO-PLACEHOLDER'] }), 'lax'),
    /write_variant\.resume` must contain \{session_id\}/,
  );
  assert.throws(
    () => parseSnapshotDocument(entry({ command: ['claude', '-p', '--session-id', '{session_id}', '--write'] }), 'lax'),
    /contains \{session_id\} but the variant declares no `resume`/,
  );
  // Host executors reject the key entirely.
  assert.throws(
    () => parseSnapshotDocument([
      'snapshot_version: 3',
      'executors:',
      '  opus:',
      '    adapter: host',
      '    model: opus',
      '    reasoning_effort: high',
      '    agent_type: worker',
      '    write_variant: { fallback_command: [claude, -p] }',
      '',
    ].join('\n'), 'lax'),
    /host executor rejects `write_variant`/,
  );
});

// --- applyWritePosture ---

test('applyWritePosture: required posture on a read-only spec swaps in the variant argv', () => {
  const profile = parseDoc(VARIANT_DOC);
  const compiled = compileDialRef({ model: 'opus' }, profile);
  const postured = applyWritePosture(compiled.spec, 'worker', profile.archetypes);
  assert.equal(postured.usedWriteVariant, true);
  const spec = postured.spec as CommandExecutorSpec;
  assert.equal(spec.writeAccess, true);
  assert.deepEqual(spec.command, ['claude', '-p', '--model', 'opus-id', '--permission-mode', 'acceptEdits']);
  // A variant without its own resume does not advertise resumption.
  assert.equal(spec.resume, null);
  assert.equal(spec.writeVariant, undefined);
});

test('applyWritePosture: every other posture leaves the base delivery untouched', () => {
  const profile = parseDoc(VARIANT_DOC);
  const compiled = compileDialRef({ model: 'opus' }, profile);
  for (const archetype of ['reviewer', 'generator', 'undeclared', null]) {
    const postured = applyWritePosture(compiled.spec, archetype, profile.archetypes);
    assert.equal(postured.usedWriteVariant, false, String(archetype));
    assert.deepEqual((postured.spec as CommandExecutorSpec).command, ['claude', '-p', '--model', 'opus-id']);
    assert.equal(postured.spec.writeAccess, false);
  }
  // A write-capable spec never needs the variant.
  const rw = compileDialRef({ model: 'sol' }, profile);
  assert.equal(applyWritePosture(rw.spec, 'worker', profile.archetypes).usedWriteVariant, false);
});

// --- explainWriteConflict ---

test('explainWriteConflict: a declared variant satisfies required; without one the refusal names write_variant', () => {
  const profile = parseDoc(VARIANT_DOC);
  const withVariant = compileDialRef({ model: 'opus' }, profile).spec;
  assert.equal(explainWriteConflict({ executor: 'opus', spec: withVariant }, 'worker', profile), null);

  const bare = parseDoc({
    ...VARIANT_DOC,
    routes: { standalone: { ...VARIANT_ROUTES.standalone, anthropic: { command: ['claude', '-p'], write_access: false } } },
  });
  const conflict = explainWriteConflict({ executor: 'opus', spec: compileDialRef({ model: 'opus' }, bare).spec }, 'worker', bare);
  assert.ok(conflict != null);
  assert.match(conflict, /declare a `write_variant` on the route/);
});

// --- snapshot round-trip ---

test('write_variant: survives serializeSnapshot → parseSnapshotDocument and postures identically on replay', () => {
  const profile = parseDoc(VARIANT_DOC);
  const yaml = serializeSnapshot(profile);
  const snapshot = parseSnapshotDocument(yaml, 'round-trip');
  const spec = snapshot.executors['opus'] as CommandExecutorSpec;
  assert.deepEqual(spec.writeVariant, {
    command: ['claude', '-p', '--model', 'opus-id', '--permission-mode', 'acceptEdits'],
    resume: null,
  });
  // The engine-side selection over the parsed snapshot gives the same argv
  // the live compile would.
  const postured = applyWritePosture(spec, 'worker', snapshot.archetypes);
  assert.equal(postured.usedWriteVariant, true);
  assert.deepEqual((postured.spec as CommandExecutorSpec).command, ['claude', '-p', '--model', 'opus-id', '--permission-mode', 'acceptEdits']);
});

// --- starter catalog: the director lane ---

test('starter catalog: director dials a claude model onto the claude-exec command lane, fadeno-capable', () => {
  const starter = readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml'), 'utf8');
  const profile = parseExecutorProfile(starter, 'starter.yaml', 'claude');
  assert.equal(profile.archetypes.director!.requiresWrite, 'required');

  // Under the claude harness the plain dial stays in-session; the exec lane
  // is the command delivery an expensive host hands a side task to.
  const inSession = compileDialRef({ model: 'opus' }, profile);
  assert.equal(inSession.spec.adapter, 'host');
  const exec = compileDialRef({ model: 'opus', via: 'claude-exec' }, profile);
  assert.equal(exec.spec.adapter, 'command');

  const postured = applyWritePosture(exec.spec, 'director', profile.archetypes);
  assert.equal(postured.usedWriteVariant, true);
  const argv = (postured.spec as CommandExecutorSpec).command;
  assert.ok(argv.includes('acceptEdits'), argv.join(' '));
  assert.ok(argv.includes('Bash(fadeno:*)'), argv.join(' '));
  // The scoped grant is the ceiling: nothing wider than the fadeno family.
  assert.ok(!argv.includes('bypassPermissions'));

  // The exec lane exists in every family, so a user-level director dial
  // compiles under any harness.
  for (const harness of ['codex', 'grok', 'standalone'] as const) {
    const p = parseExecutorProfile(starter, 'starter.yaml', harness);
    const c = compileDialRef({ model: 'opus', via: 'claude-exec' }, p);
    assert.equal(c.spec.adapter, 'command', harness);
    assert.equal(applyWritePosture(c.spec, 'director', p.archetypes).usedWriteVariant, true, harness);
  }
});

// --- dial + dispatch surfaces ---

function seedVariantRepo(t: TestContext): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  // Executable variant fixture: base echoes READ, variant echoes WRITE, so
  // the spawned argv is observable from the output snapshot.
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      opus: { provider: 'anthropic', id: 'opus-id', effort: 'high' },
    },
    routes: {
      standalone: {
        anthropic: {
          command: ['node', '-e', "process.stdout.write('READ')"],
          write_access: false,
          write_variant: { command: ['node', '-e', "process.stdout.write('WRITE')"] },
        },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
      reviewer: { requires_write: 'none' },
    },
    dials: { worker: 'opus', reviewer: 'opus' },
  }));
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
  return { root, user };
}

test('dial: setting a write-requiring archetype to a variant-backed model succeeds with a note', (t) => {
  const { root, user } = seedVariantRepo(t);
  const result = runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'opus' });
  assert.ok(result.notes.some((n) => /worker requires write — opus delivers through the anthropic route's write variant/.test(n)), JSON.stringify(result.notes));
});

test('dial: the table keeps harness identity neutral while variant state stays structured', (t) => {
  const { root, user } = seedVariantRepo(t);
  const shown = runDialShow({ repoRoot: root, userPathOptions: user });
  const worker = shown.rows.find((r) => r.archetype === 'worker')!;
  const reviewer = shown.rows.find((r) => r.archetype === 'reviewer')!;
  assert.equal(worker.write_variant, true);
  assert.equal(worker.harness, 'anthropic');
  assert.equal(worker.delivery, 'anthropic');
  assert.equal(reviewer.write_variant, undefined);
  assert.equal(reviewer.harness, 'anthropic');
  assert.equal(reviewer.delivery, 'anthropic');
});

test('dial resolve: the hook contract reports write_variant for the write-requiring archetype', (t) => {
  const { root, user } = seedVariantRepo(t);
  const worker = runDialResolve({ repoRoot: root, userPathOptions: user, archetype: 'worker' });
  assert.equal(worker.write_variant, true);
  const reviewer = runDialResolve({ repoRoot: root, userPathOptions: user, archetype: 'reviewer' });
  assert.equal(reviewer.write_variant, undefined);
});

test('drive: a worker role dispatches through the variant argv from the run snapshot', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'one-write.yaml'), [
    'kind: AgentPlaybook',
    'schema_version: "0.1"',
    'name: one-write',
    'description: Single mutating step through a write-variant route.',
    'when_to_use:',
    '  - write variant engine test',
    'roles:',
    '  builder:',
    '    purpose: Implement the task.',
    '    archetype: worker',
    'flow:',
    '  - id: implement',
    '    kind: actor_call',
    '    actor: builder',
    '    output: Notes',
    '    output_path: artifacts/notes.md',
    '    terminal_status: completed',
    '',
  ].join('\n'));
  const anthropicRoute = {
    command: ['node', '-e', "process.stdout.write('READ')"],
    write_access: false,
    write_variant: { command: ['node', '-e', "process.stdout.write('WRITE')"] },
  };
  const perHarness = { anthropic: anthropicRoute, 'current-host': { host: true } };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { opus: { provider: 'anthropic', id: 'opus-id', effort: 'high' } },
    routes: {
      standalone: { ...perHarness },
      codex: { ...perHarness },
      claude: { ...perHarness },
      grok: { ...perHarness },
    },
    archetypes: { worker: { requires_write: 'required' } },
    dials: { worker: 'opus' },
  }));
  const { runId } = runNewRun({ playbook: 'one-write', task: 'write variant engine test', repoRoot: root });
  const result = runDrive({ run: runId, repoRoot: root, env: null });
  assert.equal(result.outcome, 'terminal', JSON.stringify(result));
  assert.equal(result.status, 'completed');
  // The artifact carries the variant command's output, and the snapshot the
  // engine recorded keeps the variant for deterministic replay.
  assert.equal(readFileSync(join(root, '.fadeno', 'runs', runId, 'artifacts', 'notes.md'), 'utf8'), 'WRITE');
  const snapshot = readFileSync(join(root, '.fadeno', 'runs', runId, 'profile.yaml'), 'utf8');
  assert.match(snapshot, /write_variant:/);
});

test('dispatch: worker spawns the variant argv and the evidence row says so; reviewer spawns the base', (t) => {
  const { root, user } = seedVariantRepo(t);
  const worker = runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: user });
  assert.equal(worker.stdout, 'WRITE');
  const reviewer = runDispatch({ archetype: 'reviewer', prompt: 'x', repoRoot: root, userPathOptions: user });
  assert.equal(reviewer.stdout, 'READ');

  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const workerRequest = rows.find((r) => r.event === 'dispatch_requested' && r.archetype === 'worker')!;
  assert.equal(workerRequest.write_variant, true);
  assert.equal(workerRequest.write_access, true);
  assert.deepEqual(workerRequest.command, ['node', '-e', "process.stdout.write('WRITE')"]);
  const reviewerRequest = rows.find((r) => r.event === 'dispatch_requested' && r.archetype === 'reviewer')!;
  assert.equal(reviewerRequest.write_variant, undefined);
  assert.equal(reviewerRequest.write_access, false);
  assert.deepEqual(reviewerRequest.command, ['node', '-e', "process.stdout.write('READ')"]);
});

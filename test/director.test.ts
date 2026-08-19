import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DialError, runDialSet } from '../src/commands/dial.ts';
import { DispatchCommandError, runDispatch } from '../src/commands/dispatch.ts';
import {
  compileDialRef,
  eligibilityFor,
  ExecutorProfileError,
  parseExecutorProfile,
  parseSnapshotDocument,
  serializeSnapshot,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

function parseDoc(doc: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml');
}

const STARTER = readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml'), 'utf8');

// --- route-level eligibility ---

test('route eligibility: parses, merges strictest-wins with model eligibility, binds unregistered models', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: {
      sol: { provider: 'openai', eligibility: { judge: 'shadow_only' } },
    },
    routes: {
      standalone: {
        openai: { command: ['codex'], eligibility: { director: 'forbidden', judge: 'eligible' } },
      },
    },
    archetypes: { director: {} },
    unregistered_model_driver: 'openai',
  });
  const spec = compileDialRef({ model: 'sol' }, profile).spec;
  // Route forbids director; the model's stricter judge state survives the merge.
  assert.equal(eligibilityFor(spec, 'director'), 'forbidden');
  assert.equal(eligibilityFor(spec, 'judge'), 'shadow_only');
  // Unregistered models fall through the same route and inherit its constraint.
  const unregistered = compileDialRef({ model: 'mystery-model' }, profile).spec;
  assert.equal(eligibilityFor(unregistered, 'director'), 'forbidden');
});

test('route eligibility: bad states and non-identifier keys refuse with the route label', () => {
  const route = (eligibility: unknown) => ({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'], eligibility } } },
  });
  assert.throws(
    () => parseDoc(route({ director: 'never' })),
    (err: unknown) =>
      err instanceof ExecutorProfileError &&
      /route `routes\.standalone\.openai` `eligibility\.director` must be "eligible", "shadow_only", or "forbidden"/.test(err.message),
  );
  assert.throws(() => parseDoc(route({ Director: 'forbidden' })), /eligibility key "Director" is not a bare lowercase identifier/);
});

test('route eligibility: survives the snapshot as the merged per-spec map', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'], eligibility: { director: 'forbidden' } } } },
    archetypes: { director: {} },
  });
  const snapshot = parseSnapshotDocument(serializeSnapshot(profile), 'round-trip');
  assert.equal(eligibilityFor(snapshot.executors['sol']!, 'director'), 'forbidden');
});

// --- archetype brief ---

test('archetype brief: parses as a bare identifier, refuses anything else, round-trips the snapshot', () => {
  const profile = parseDoc({
    schema_version: 3,
    models: { sol: { provider: 'openai' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
    archetypes: { director: { brief: 'director' } },
  });
  assert.equal(profile.archetypes.director!.brief, 'director');
  const snapshot = parseSnapshotDocument(serializeSnapshot(profile), 'round-trip');
  assert.equal(snapshot.archetypes.director!.brief, 'director');
  assert.throws(
    () => parseDoc({
      schema_version: 3,
      models: { sol: { provider: 'openai' } },
      routes: { standalone: { openai: { command: ['codex'] } } },
      archetypes: { director: { brief: '../escape' } },
    }),
    /`archetypes\.director\.brief` must be a bare lowercase identifier/,
  );
});

// --- dispatch composition ---

function seedDirectorRepo(t: TestContext, opts: { brief?: boolean } = {}): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'briefs'), { recursive: true });
  if (opts.brief !== false) {
    writeFileSync(join(root, '.fadeno', 'briefs', 'director.md'), 'BRIEF-HEADER: coordinate through fadeno.\n');
  }
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { boss: { provider: 'openai', id: 'boss-1', effort: 'high' } },
    routes: {
      standalone: {
        openai: {
          command: ['node', '-e', "let d='';process.stdin.on('data',(c)=>{d+=c});process.stdin.on('end',()=>{process.stdout.write(d)})"],
          write_access: true,
        },
        'current-host': { host: true },
      },
    },
    archetypes: { director: { brief: 'director' } },
    dials: { director: 'boss' },
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

test('dispatch: the declared brief is composed ahead of the task and stamped in evidence', (t) => {
  const { root, user } = seedDirectorRepo(t);
  const result = runDispatch({ archetype: 'director', prompt: 'THE-TASK', repoRoot: root, userPathOptions: user });
  assert.ok(result.stdout.startsWith('BRIEF-HEADER: coordinate through fadeno.'), result.stdout.slice(0, 80));
  assert.ok(result.stdout.endsWith('THE-TASK'), result.stdout.slice(-40));

  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const request = rows.find((r) => r.event === 'dispatch_requested')!;
  assert.equal(request.brief, 'director');
  // The snapshot holds the composed bytes — the digest attests brief + task.
  const snapshot = readFileSync(join(root, String(request.prompt_snapshot)), 'utf8');
  assert.ok(snapshot.startsWith('BRIEF-HEADER'));
  assert.ok(snapshot.endsWith('THE-TASK'));
});

test('dispatch: --no-brief sends the bare task; a declared-but-missing brief refuses loudly', (t) => {
  const { root, user } = seedDirectorRepo(t);
  const bare = runDispatch({ archetype: 'director', prompt: 'THE-TASK', noBrief: true, repoRoot: root, userPathOptions: user });
  assert.equal(bare.stdout, 'THE-TASK');

  // A repo brief absent falls back to the shipped builtin — still composed.
  const { root: root2, user: user2 } = seedDirectorRepo(t, { brief: false });
  const builtin = runDispatch({ archetype: 'director', prompt: 'THE-TASK', repoRoot: root2, userPathOptions: user2 });
  assert.match(builtin.stdout, /You are a Fadeno director/);
  assert.ok(builtin.stdout.endsWith('THE-TASK'));

  // A brief name with no template anywhere refuses loudly.
  const { root: root3, user: user3 } = seedDirectorRepo(t, { brief: false });
  writeFileSync(join(root3, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { boss: { provider: 'openai', id: 'boss-1', effort: 'high' } },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], write_access: true },
        'current-host': { host: true },
      },
    },
    archetypes: { director: { brief: 'sidequest' } },
    dials: { director: 'boss' },
  }));
  assert.throws(
    () => runDispatch({ archetype: 'director', prompt: 'x', repoRoot: root3, userPathOptions: user3 }),
    (err: unknown) => err instanceof DispatchCommandError && /declares brief "sidequest" but no template exists/.test((err as Error).message),
  );
});

// --- starter catalog: the director contract ---

test('starter catalog: director brief declared; non-fadeno lanes forbid director; exec lane is eligible', () => {
  for (const harness of ['claude', 'codex', 'grok', 'standalone'] as const) {
    const profile = parseExecutorProfile(STARTER, 'starter.yaml', harness);
    assert.equal(profile.archetypes.director!.brief, 'director', harness);
    // The grok/agy/opencode lanes have no fadeno capability — structurally blocked.
    for (const model of ['grok', 'gemini'] as const) {
      try {
        const spec = compileDialRef({ model }, profile).spec;
        assert.equal(eligibilityFor(spec, 'director'), 'forbidden', `${harness}/${model}`);
      } catch {
        // provider absent in this family — equally undialable
      }
    }
    // Unregistered fall-through (opencode) is blocked too.
    const unregistered = compileDialRef({ model: 'mystery' }, profile).spec;
    assert.equal(eligibilityFor(unregistered, 'director'), 'forbidden', harness);
    // Plain claude lane blocked (its variant has no fadeno grant); exec lane open.
    const plain = compileDialRef({ model: 'opus' }, profile).spec;
    assert.equal(eligibilityFor(plain, 'director'), 'forbidden', harness);
    const exec = compileDialRef({ model: 'opus', via: 'claude-exec' }, profile).spec;
    assert.equal(eligibilityFor(exec, 'director'), 'eligible', harness);
    // Codex lane open (workspace-write sandbox runs fadeno).
    const codexLane = compileDialRef({ model: 'sol' }, profile).spec;
    assert.equal(eligibilityFor(codexLane, 'director'), 'eligible', harness);
  }
  // The builtin brief template ships.
  const briefPath = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'briefs', 'director.md');
  assert.match(readFileSync(briefPath, 'utf8'), /fadeno dispatch --archetype worker/);
});

test('dial: setting director onto a forbidden lane refuses at set time', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' } },
    routes: {
      standalone: {
        xai: { command: ['node', '-e', '0'], write_access: true, eligibility: { director: 'forbidden' } },
        'current-host': { host: true },
      },
    },
    archetypes: { director: { requires_write: 'required' } },
  }));
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'user-config'), FADENO_STATE_HOME: join(root, 'user-state'), FADENO_HARNESS: 'standalone' },
  };
  assert.throws(
    () => runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'director', model: 'grok' }),
    (err: unknown) => err instanceof DialError && /forbidden/.test((err as Error).message),
  );
});

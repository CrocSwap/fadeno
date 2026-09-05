import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelsError, runModelsRemove } from '../src/commands/models.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { readVerifiedModels, recordVerifiedModel, userPaths, writeUserDials, type UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4, tempRepo } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function isolated(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

/**
 * A hand-maintained personal catalog: leading comment, per-entry comments, a
 * sibling alias, and a top-level key that is none of this command's business.
 * The point of every one of them is that removal must not disturb them.
 */
const USER_CATALOG = `# personal catalog — hand maintained, do not generate
schema_version: 4
models:
  # promoted from the OpenRouter listing
  moonshot:
    provider: stealth
    id: ox-alpha
    effort: default
    harness: opencode
    spellings:
      opencode: stealth/ox-alpha
  # keep: still the fastest reviewer here
  luna:
    provider: stealth
    id: ox-luna
    effort: default
    harness: opencode
    spellings:
      opencode: stealth/ox-luna
`;

const PROJECT_CATALOG = catalogV4({
  models: {
    sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
  },
  harnesses: {
    codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'] },
    opencode: { command: ['opencode', 'run', '-m', '{model}'], models_command: ['printf', 'stealth/ox-alpha\\n'] },
  },
  archetypes: { worker: {}, reviewer: {} },
  unregistered_model_harness: 'opencode',
});

function seed(t: TestContext, options: { project?: string | null; userCatalog?: string } = {}): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  const user = isolated(root);
  const project = options.project === undefined ? PROJECT_CATALOG : options.project;
  if (project != null) {
    mkdirSync(join(root, '.fadeno'), { recursive: true });
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), project);
  }
  const userCatalog = options.userCatalog ?? USER_CATALOG;
  const catalogPath = userPaths(user).executorsFile;
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, userCatalog);
  return { root, user };
}

test('model remove: takes a user alias out, preserving comments, siblings, and unrelated rows', (t) => {
  const { root, user } = seed(t);
  recordVerifiedModel(user, { harness: 'opencode', model: 'stealth/ox-alpha', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'opencode', model: 'stealth/ox-luna', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2026-08-01T00:00:00Z' });

  const result = runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'moonshot' });
  assert.equal(result.removed, true);
  assert.equal(result.alias, 'moonshot');
  assert.equal(result.path, userPaths(user).executorsFile);
  assert.deepEqual(result.dangling_dials, []);
  assert.deepEqual(result.dangling_shadows, []);

  const text = readFileSync(userPaths(user).executorsFile, 'utf8');
  assert.match(text, /# personal catalog — hand maintained/, 'the file header survived');
  assert.match(text, /# keep: still the fastest reviewer here/, "the sibling's comment survived");
  assert.match(text, /luna:/);
  assert.doesNotMatch(text, /moonshot/);
  assert.doesNotMatch(text, /ox-alpha/);

  // The cache stops vouching for the alias, and only for the alias.
  assert.equal(result.verifications_removed, 1);
  assert.deepEqual(
    readVerifiedModels(user).map((row) => `${row.harness} ${row.model}`),
    ['codex gpt-5.6-sol', 'opencode stealth/ox-luna'],
  );
});

test('model remove: a lower-layer alias names the file to edit rather than being touched', (t) => {
  const { root, user } = seed(t);
  assert.throws(
    () => runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'sol' }),
    (err: unknown) => {
      assert.ok(err instanceof ModelsError);
      assert.match(err.message, /project catalog/);
      assert.match(err.message, new RegExp(join(root, '.fadeno', 'executors.yaml').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(err.message, /user catalog only/);
      return true;
    },
  );
  // Refused means untouched: the project catalog still declares it.
  assert.match(readFileSync(join(root, '.fadeno', 'executors.yaml'), 'utf8'), /sol:/);
});

test('model remove: a builtin alias reports the builtin layer, not "not found"', (t) => {
  const { root, user } = seed(t, { project: null });
  assert.throws(
    () => runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'fable' }),
    (err: unknown) => {
      assert.ok(err instanceof ModelsError);
      assert.match(err.message, /builtin catalog/);
      assert.match(err.message, /templates[/\\]common[/\\]fadeno[/\\]executors\.yaml/);
      return true;
    },
  );
});

test('model remove: an unknown alias and current-host are refused distinctly', (t) => {
  const { root, user } = seed(t);
  assert.throws(
    () => runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'nope' }),
    /no model named "nope"/,
  );
  assert.throws(
    () => runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'current-host' }),
    /current-host is the host itself/,
  );
});

test('model remove: refuses while a dial names the alias, and --force reports what it strands', (t) => {
  const { root, user } = seed(t);
  writeUserDials(user, { worker: { model: 'moonshot' } });
  recordVerifiedModel(user, { harness: 'opencode', model: 'stealth/ox-alpha', verified_at: '2026-08-01T00:00:00Z' });

  assert.throws(
    () => runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'moonshot' }),
    (err: unknown) => {
      assert.ok(err instanceof ModelsError);
      assert.match(err.message, /dialed by worker/);
      assert.match(err.message, /fadeno dial <archetype> <other>/);
      assert.match(err.message, /--force/);
      return true;
    },
  );
  assert.match(readFileSync(userPaths(user).executorsFile, 'utf8'), /moonshot/, 'a refusal writes nothing');

  const forced = runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'moonshot', force: true });
  assert.equal(forced.removed, true);
  assert.deepEqual(forced.dangling_dials, [{ archetype: 'worker', layer: 'user', ref: 'moonshot' }]);
  assert.equal(forced.verifications_removed, 1);
  assert.doesNotMatch(readFileSync(userPaths(user).executorsFile, 'utf8'), /moonshot/);
});

test('model remove: a shadow attachment strands the same way a dial does', (t) => {
  const { root, user } = seed(t);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'moonshot' } }, legacyNote: null });

  assert.throws(
    () => runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'moonshot' }),
    /shadowed on worker/,
  );

  const forced = runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'moonshot', force: true });
  assert.deepEqual(forced.dangling_shadows, [{ archetype: 'worker', ref: 'moonshot' }]);
});

/**
 * A project catalog that declares the SAME alias the user catalog does, with a
 * different model underneath. `runModels` answers with this one — which is
 * exactly why removal must not ask it which cached rows to drop.
 */
const SHADOWING_PROJECT = catalogV4({
  models: {
    moonshot: { provider: 'openai', id: 'project-moonshot', effort: 'default', harness: 'codex', spellings: { codex: 'project-moonshot' } },
  },
  harnesses: {
    codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'] },
    opencode: { command: ['opencode', 'run', '-m', '{model}'] },
  },
  archetypes: { worker: {}, reviewer: {} },
  unregistered_model_harness: 'opencode',
});

test('model remove: a project alias of the same name does not decide which rows are dropped', (t) => {
  const { root, user } = seed(t, { project: SHADOWING_PROJECT });
  // The removed user entry's row, and the surviving project entry's row.
  recordVerifiedModel(user, { harness: 'opencode', model: 'stealth/ox-alpha', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'codex', model: 'project-moonshot', verified_at: '2026-08-01T00:00:00Z' });

  const result = runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'moonshot' });
  assert.equal(result.removed, true);
  // Keying the cleanup off the EFFECTIVE row got this backwards in both
  // directions at once: it deleted `codex project-moonshot`, which still
  // vouches for a live project model, and left `opencode stealth/ox-alpha`
  // vouching for an alias that no longer exists anywhere.
  assert.equal(result.verifications_removed, 1);
  assert.deepEqual(
    readVerifiedModels(user).map((row) => `${row.harness} ${row.model}`),
    ['codex project-moonshot'],
  );
  assert.doesNotMatch(readFileSync(userPaths(user).executorsFile, 'utf8'), /ox-alpha/);
  assert.match(readFileSync(join(root, '.fadeno', 'executors.yaml'), 'utf8'), /project-moonshot/, 'the project alias is untouched');
});

/** `agy` encodes the effort into the model id, so the pin changes the cache key. */
const SUFFIX_PROJECT = catalogV4({
  models: { sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' } },
  harnesses: {
    codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'] },
    agy: { provider: 'google', command: ['agy', '--model', '{model}'], effort_encoding: 'model-suffix' },
  },
  archetypes: { worker: {}, reviewer: {} },
  unregistered_model_harness: 'codex',
});

const SUFFIX_USER_CATALOG = `schema_version: 4
models:
  personal:
    provider: google
    id: gemini
    effort: default
    harness: agy
`;

test('model remove: a pinned effort is part of the delivered id, so its row goes too', (t) => {
  const { root, user } = seed(t, { project: SUFFIX_PROJECT, userCatalog: SUFFIX_USER_CATALOG });
  writeUserDials(user, { worker: { model: 'personal', effort: 'xhigh' } });
  // What a forced `personal@xhigh` dial actually asked `agy` for, plus the
  // unpinned delivery, plus a row that has nothing to do with either.
  recordVerifiedModel(user, { harness: 'agy', model: 'gemini-xhigh', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'agy', model: 'gemini', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2026-08-01T00:00:00Z' });

  const forced = runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'personal', force: true });
  assert.deepEqual(forced.dangling_dials, [{ archetype: 'worker', layer: 'user', ref: 'personal@xhigh' }]);
  // Collecting only the default delivery left `agy gemini-xhigh` behind — the
  // one row the active dial had actually written.
  assert.equal(forced.verifications_removed, 2);
  assert.deepEqual(
    readVerifiedModels(user).map((row) => `${row.harness} ${row.model}`),
    ['codex gpt-5.6-sol'],
  );
});

/**
 * The same `model-suffix` shape with a SURVIVING entry on that harness, so the
 * prefix rule below has something it must not take.
 */
const SUFFIX_SURVIVOR_PROJECT = catalogV4({
  models: {
    sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
    other: { provider: 'google', id: 'other', effort: 'default', harness: 'agy' },
  },
  harnesses: {
    codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'] },
    agy: { provider: 'google', command: ['agy', '--model', '{model}'], effort_encoding: 'model-suffix' },
  },
  archetypes: { worker: {}, reviewer: {} },
  unregistered_model_harness: 'codex',
});

test('model remove: a row cached under a since-cleared effort dial goes too', (t) => {
  const { root, user } = seed(t, { project: SUFFIX_SURVIVOR_PROJECT, userCatalog: SUFFIX_USER_CATALOG });
  // NOTHING dials `personal`: the `personal@high` that wrote `agy gemini-high`
  // was cleared (or re-pointed) before the removal, so no ref in the cascade
  // resolves the alias at `high` any more. Efforts are free-form strings and a
  // row records none, so the effort set can no longer reach that row — only its
  // shape on an effort-encoding harness can.
  recordVerifiedModel(user, { harness: 'agy', model: 'gemini-high', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'agy', model: 'gemini', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'agy', model: 'other-high', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2026-08-01T00:00:00Z' });

  const result = runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'personal' });
  assert.deepEqual(result.dangling_dials, []);
  assert.equal(result.verifications_removed, 2);
  assert.deepEqual(
    readVerifiedModels(user).map((row) => `${row.harness} ${row.model}`),
    // `agy other-high` is a suffix of a DIFFERENT base, and `codex` does not
    // encode effort into the id at all.
    ['agy other-high', 'codex gpt-5.6-sol'],
  );
});

/** A surviving entry whose id is literally `<the removed base>-<something>`. */
const SUFFIX_COLLIDING_PROJECT = catalogV4({
  models: {
    sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
    gp: { provider: 'google', id: 'gemini-pro', effort: 'default', harness: 'agy' },
  },
  harnesses: {
    codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'] },
    agy: { provider: 'google', command: ['agy', '--model', '{model}'], effort_encoding: 'model-suffix' },
  },
  archetypes: { worker: {}, reviewer: {} },
  unregistered_model_harness: 'codex',
});

test('model remove: the survivor guard keeps a row another entry still delivers', (t) => {
  const { root, user } = seed(t, { project: SUFFIX_COLLIDING_PROJECT, userCatalog: SUFFIX_USER_CATALOG });
  // `gemini-pro` is shaped exactly like `personal` at effort `pro` would be.
  // It is also what `gp` is asked for, so the prefix rule must not take it.
  recordVerifiedModel(user, { harness: 'agy', model: 'gemini-high', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'agy', model: 'gemini-pro', verified_at: '2026-08-01T00:00:00Z' });

  const result = runModelsRemove({ repoRoot: root, userPathOptions: user, alias: 'personal' });
  assert.equal(result.verifications_removed, 1);
  assert.deepEqual(
    readVerifiedModels(user).map((row) => `${row.harness} ${row.model}`),
    ['agy gemini-pro'],
  );
});

test('model remove: the CLI removes under both spellings and fails loudly when refused', (t) => {
  const { root, user } = seed(t);
  const env = { ...process.env, ...user.env, HOME: user.home! };
  const runCli = (args: string[]): { status: number; stdout: string; stderr: string } => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
    } catch (err) {
      const failure = err as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  };

  const refused = runCli(['models', 'remove', 'sol']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /user catalog only/);

  const removed = runCli(['model', 'remove', 'moonshot']);
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, /^removed moonshot from /m);
  assert.doesNotMatch(readFileSync(userPaths(user).executorsFile, 'utf8'), /moonshot/);
});

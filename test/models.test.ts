import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { KNOWN_CLI_COMMANDS } from '../src/cli.ts';
import { ModelsError, runModels, runModelsAdd, runModelsDriver } from '../src/commands/models.ts';
import { unknownFlagsFor } from '../src/commands/completion.ts';
import { recordVerifiedModel, type UserPathOptions } from '../src/lib/user-paths.ts';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import { compileDialRef } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

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

function seed(t: TestContext): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'high', spellings: { openrouter: 'anthropic/claude-opus' } },
      // provider with no route under standalone → stale row, still listed
      ghost: { provider: 'nowhere', id: 'ghost-1', effort: 'high' },
    },
    routes: {
      standalone: {
        openai: {
          command: ['node', '-e', '0'],
          // One id per LINE, which is what every shipped backend actually
          // emits. This fixture used to put both ids on one space-separated
          // line — a shape no real backend produces, and one that only
          // "worked" because the listing tokenized on whitespace and so also
          // turned agy's `id<TAB>Description` rows into four models each.
          models_command: ['printf', 'gpt-5.6-sol\\ngpt-5.6-luna\\n'],
        },
        anthropic: {
          driver: 'claude',
          // `fadeno_capable` is now read off the argv that will actually run,
          // so the flag has to be IN it — there is no second "variant" argv to
          // look inside any more.
          command: ['claude', '-p', '--model', '{model}', '--allowedTools', 'Bash(fadeno:*)'],
        },
        openrouter: {
          command: ['opencode', 'run', '-m', '{model}'],
          models_command: ['printf', 'anthropic/claude-opus\\nqwen-max\\n'],
        },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: { } },
    unregistered_model_driver: 'openrouter',
  }));
  return { root, user: isolated(root) };
}

test('models: registry table — deliveries, lane marks, stale providers, verification cache', (t) => {
  const { root, user } = seed(t);
  recordVerifiedModel(user, { driver: 'openai', model: 'gpt-5.6-sol', verified_at: '2026-08-16T00:00:00Z' });

  const result = runModels({ repoRoot: root, userPathOptions: user });
  assert.equal(result.harness, 'standalone');
  assert.equal(result.harness_source, 'FADENO_HARNESS');
  assert.equal(result.unregistered_model_driver, 'openrouter');
  assert.deepEqual(result.listable_drivers, ['openai', 'openrouter']);

  const names = result.models.map((r) => r.name);
  assert.deepEqual(
    names.filter((n) => n !== 'current-host'),
    ['opus', 'ghost', 'sol'],
    'rows sort by home_via (claude < nowhere < openai)',
  );
  assert.ok(names.includes('sol') && names.includes('opus') && names.includes('ghost'));

  const sol = result.models.find((r) => r.name === 'sol')!;
  assert.equal(sol.home_via, 'openai');
  assert.equal(sol.native, false);
  assert.equal(sol.effort, 'high');
  assert.equal(sol.verified_at, '2026-08-16T00:00:00Z');

  // Adapter state remains structured resolution data; the displayed `via`
  // and effort are frame-neutral model identity.
  const host = result.models.find((r) => r.name === 'current-host');
  if (host != null) assert.equal(host.native, true);

  const opus = result.models.find((r) => r.name === 'opus')!;
  assert.equal(opus.home_via, 'claude');
  assert.equal(opus.fadeno_capable, true);
  // The openrouter lane is visible with its spelling-substituted id.
  const orLane = opus.lanes.find((l) => l.via === 'openrouter');
  assert.ok(orLane);
  assert.equal(orLane!.id, 'anthropic/claude-opus');

  const ghost = result.models.find((r) => r.name === 'ghost')!;
  assert.equal(ghost.home_via, 'nowhere');
  // The entry has no `delivery`, so the compile error must name the command
  // that records a real route — the 2026-08-26 futa failure was only
  // diagnosable by reading the source.
  assert.match(ghost.stale ?? '', /no route for provider "nowhere"/);
  assert.match(ghost.stale ?? '', /fadeno model add ghost nowhere\/ghost-1/);
});

test('models --driver: live listing via models_command with registered spellings marked', (t) => {
  const { root, user } = seed(t);
  const result = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openrouter' });
  assert.deepEqual(result.models_command, ['printf', 'anthropic/claude-opus\\nqwen-max\\n']);
  assert.deepEqual(result.models, [
    { id: 'anthropic/claude-opus', registered_as: ['opus'] },
    { id: 'qwen-max', registered_as: [] },
  ]);
  // Home-route ids mark too.
  const openai = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openai' });
  assert.deepEqual(openai.models[0], { id: 'gpt-5.6-sol', registered_as: ['sol'] });
  assert.deepEqual(openai.models[1], { id: 'gpt-5.6-luna', registered_as: [] });
});

test('models --driver: a listing is parsed per line, not per whitespace token', (t) => {
  // The three shapes the shipped backends actually emit, pinned together
  // because the bug was that one parse was serving two different questions.
  // `agy` is the one that broke: `id<TAB>Description` after a progress
  // preamble became `gemini-3.7-flash-high`, `Gemini`, `3.7`, `Flash`,
  // `(High)` — five "models" from one, and 31 real models became 100-odd.
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { flash: { provider: 'google', id: 'gemini-3.7-flash-high', effort: 'high' } },
    routes: {
      standalone: {
        // agy: a preamble line, then tab-separated id + human label.
        google: {
          driver: 'agy',
          command: ['agy'],
          models_command: ['printf', 'Fetching available models...\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n'],
        },
        // opencode: one bare id per line, nothing else.
        openrouter: { command: ['opencode'], models_command: ['printf', 'opencode/big-pickle\nopencode/hy3-free\n'] },
        // grok: prose, and no listing at all. The honest answer is an empty
        // list, not a set of models named after the words in its login banner.
        xai: { driver: 'grok', command: ['grok'], models_command: ['printf', 'You are logged in with grok.com.\n\nDefault model: grok-4.6\n'] },
      },
    },
    archetypes: { worker: {} },
  }));
  const user = isolated(root);

  const agy = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'agy' });
  assert.deepEqual(agy.models, [
    { id: 'gemini-3.7-flash-high', registered_as: ['flash'] },
    { id: 'gemini-3.7-flash-low', registered_as: [] },
  ], 'the tab-separated label is not a model, and the preamble is not a model');

  const oc = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'openrouter' });
  assert.deepEqual(oc.models.map((m) => m.id), ['opencode/big-pickle', 'opencode/hy3-free']);

  const grok = runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'grok' });
  assert.deepEqual(grok.models, [], 'prose yields no models rather than one per word');
});

test('models --driver: unknown driver and probe-less driver refuse with guidance', (t) => {
  const { root, user } = seed(t);
  assert.throws(
    () => runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'nope' }),
    (err: unknown) => err instanceof ModelsError && /unknown driver "nope" — declared drivers:/.test((err as Error).message),
  );
  assert.throws(
    () => runModelsDriver({ repoRoot: root, userPathOptions: user, driver: 'claude' }),
    (err: unknown) => err instanceof ModelsError && /declares no models_command/.test((err as Error).message),
  );
});

test('models: home `via` is stable while the caller-specific adapter changes', (t) => {
  const root = tempRepo(t);
  const rows = new Map<string, ReturnType<typeof runModels>['models'][number]>();
  for (const harness of ['codex', 'claude', 'grok', 'standalone']) {
    const result = runModels({
      repoRoot: root,
      userPathOptions: {
        home: join(root, `home-${harness}`),
        env: {
          FADENO_CONFIG_HOME: join(root, `config-${harness}`),
          FADENO_STATE_HOME: join(root, `state-${harness}`),
          FADENO_HARNESS: harness,
        },
      },
    });
    rows.set(harness, result.models.find((row) => row.name === 'luna')!);
  }
  for (const row of rows.values()) {
    // `home_via`, the model's own driver — not `harness`, which in this same
    // command means the agent asking and differs on every iteration of the
    // loop above. The two used to share a field name.
    assert.equal(row.home_via, 'codex');
    assert.ok(!('harness' in row), 'the misleading synonym is gone, not deprecated');
  }
  assert.equal(rows.get('codex')!.adapter, 'host');
  assert.equal(rows.get('claude')!.adapter, 'command');
  assert.equal(rows.get('grok')!.adapter, 'command');
  assert.equal(rows.get('standalone')!.adapter, 'command');
});

test('models: rows sort by home_via, then provider, then name', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    // Name order (alpha, bravo, mike, zulu) differs from every sort key. The
    // acme tie pair is declared mike-before-bravo: rows enter the sort in
    // name-sorted iteration order and Array.sort is stable, so the `name`
    // comparator key alone can never flip this assertion — but this document
    // order means losing either the name key OR the iteration `.sort()` (or a
    // non-stable sort) does.
    models: {
      zulu: { provider: 'anthropic', id: 'z-1', effort: 'high' },
      alpha: { provider: 'zenith', id: 'a-1', effort: 'high' },
      mike: { provider: 'acme', id: 'm-1', effort: 'high' },
      bravo: { provider: 'acme', id: 'b-1', effort: 'high' },
    },
    routes: {
      standalone: {
        anthropic: { driver: 'claude', command: ['node', '-e', '0'] },
        // Two providers share one driver alias, so `home_via` ties and the
        // provider key decides between them.
        acme: { driver: 'shared', command: ['node', '-e', '0'] },
        zenith: { driver: 'shared', command: ['node', '-e', '0'] },
      },
    },
    archetypes: { worker: {} },
  }));

  const result = runModels({ repoRoot: root, userPathOptions: isolated(root) });
  assert.deepEqual(
    result.models.map((r) => [r.name, r.home_via, r.provider]),
    [
      ['zulu', 'claude', 'anthropic'],
      // The synthesized current-host row participates in the same ordering.
      ['current-host', 'current-host', 'current-host'],
      ['bravo', 'shared', 'acme'],
      ['mike', 'shared', 'acme'],
      ['alpha', 'shared', 'zenith'],
    ],
  );
});

test('model is a registered top-level alias of models for flag validation', () => {
  assert.ok(KNOWN_CLI_COMMANDS.has('model'));
  // Same completion spec object as `models`, so the accepted flag sets match
  // exactly — including what each spelling rejects.
  assert.deepEqual(unknownFlagsFor('model', undefined, ['driver', 'json']), []);
  assert.deepEqual(unknownFlagsFor('models', undefined, ['driver', 'json']), []);
  assert.deepEqual(unknownFlagsFor('model', undefined, ['session']), ['--session']);
  assert.deepEqual(unknownFlagsFor('model', 'add', ['json']), []);
  // Completion is intentionally additive for subcommands; the CLI still
  // rejects --driver on model add because it would change discovery meaning.
  assert.deepEqual(unknownFlagsFor('models', 'add', ['driver']), []);
});

test('fadeno model runs the models handler end to end', (t) => {
  const { root, user } = seed(t);
  const env = { ...process.env, ...user.env, HOME: user.home! };
  const runCli = (args: string[]): string =>
    execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });

  assert.equal(runCli(['model']), runCli(['models']));
  const singular = JSON.parse(runCli(['model', '--json']));
  const plural = JSON.parse(runCli(['models', '--json']));
  assert.equal(singular.harness, 'standalone');
  assert.deepEqual(singular.models, plural.models);
});

test('model add: direct OpenCode discovery adds a preserved user-catalog alias and delivers exactly once', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  const userCatalog = join(user.env!.FADENO_CONFIG_HOME!, 'fadeno', 'executors.yaml');
  mkdirSync(join(user.env!.FADENO_CONFIG_HOME!, 'fadeno'), { recursive: true });
  writeFileSync(userCatalog, `# Keep this comment and unrelated known configuration.\nschema_version: 3\nmodels:\n  older:\n    provider: openai\n    id: old\nrelay:\n  codex: luna\n`);
  let calls = 0;
  const result = runModelsAdd({
    repoRoot: root,
    userPathOptions: user,
    alias: 'moonshot',
    discoveryId: 'stealth/ox-alpha',
    spawn: (command) => {
      calls += 1;
      assert.deepEqual(command, ['opencode', 'models']);
      return { status: 0, stdout: 'stealth/ox-alpha\nopenrouter/stealth/ox-alpha\n', stderr: '' };
    },
  });
  assert.equal(calls, 1, 'direct and fallback path entries share one OpenCode listing');
  assert.equal(result.discovery_path, 'opencode');
  assert.equal(result.matched_identity, 'stealth/ox-alpha');
  assert.deepEqual(result.delivery, { route: 'opencode-direct', id: 'stealth/ox-alpha', listed_id: 'stealth/ox-alpha' });
  const stored = readFileSync(userCatalog, 'utf8');
  assert.match(stored, /Keep this comment/);
  assert.match(stored, /relay:\n  codex: luna/);
  assert.match(stored, /moonshot:/);
  const profile = loadLayeredProfile(root, user, 'standalone').profile;
  const compiled = compileDialRef({ model: 'moonshot' }, profile);
  assert.equal(compiled.driver, 'opencode-direct');
  assert.equal(compiled.modelId, 'stealth/ox-alpha');
  assert.ok((compiled.spec as { command: string[] }).command.includes('stealth/ox-alpha'));
  assert.ok(!(compiled.spec as { command: string[] }).command.includes('openrouter/stealth/ox-alpha'));
  const explicitFallback = compileDialRef({ model: 'moonshot', via: 'opencode' }, profile);
  assert.equal(explicitFallback.modelId, 'ox-alpha');
  assert.deepEqual(
    (explicitFallback.spec as { command: string[] }).command.filter((part) => part.includes('stealth/')),
    [],
    'an unrelated explicit route must not inherit the home delivery spelling',
  );
  assert.ok((explicitFallback.spec as { command: string[] }).command.includes('openrouter/ox-alpha'));
  assert.equal(runModels({ repoRoot: root, userPathOptions: user }).models.find((row) => row.name === 'moonshot')!.home_via, 'opencode-direct');
});

test('model add: OpenRouter fallback uses the route-relative id without double prefixing', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  let calls = 0;
  const result = runModelsAdd({
    repoRoot: root,
    userPathOptions: user,
    alias: 'moonshot',
    discoveryId: 'stealth/ox-alpha',
    spawn: () => {
      calls += 1;
      return { status: 0, stdout: 'openrouter/stealth/ox-alpha\n', stderr: '' };
    },
  });
  assert.equal(calls, 1, 'the shared listing is cached across direct then OpenRouter checks');
  assert.equal(result.discovery_path, 'opencode/openrouter');
  assert.deepEqual(result.delivery, { route: 'openrouter', id: 'stealth/ox-alpha', listed_id: 'openrouter/stealth/ox-alpha' });
  const compiled = compileDialRef({ model: 'moonshot' }, loadLayeredProfile(root, user, 'standalone').profile);
  assert.equal(compiled.driver, 'opencode');
  assert.equal(compiled.modelId, 'stealth/ox-alpha');
  assert.deepEqual((compiled.spec as { command: string[] }).command.filter((part) => part.includes('stealth/')), ['openrouter/stealth/ox-alpha']);
  const explicitHome = compileDialRef({ model: 'moonshot', via: 'opencode' }, loadLayeredProfile(root, user, 'standalone').profile);
  assert.equal(explicitHome.modelId, 'stealth/ox-alpha');
  assert.deepEqual((explicitHome.spec as { command: string[] }).command.filter((part) => part.includes('stealth/')), ['openrouter/stealth/ox-alpha']);
  const explicitDirect = compileDialRef({ model: 'moonshot', via: 'opencode-direct' }, loadLayeredProfile(root, user, 'standalone').profile);
  assert.equal(explicitDirect.modelId, 'ox-alpha');
  assert.deepEqual((explicitDirect.spec as { command: string[] }).command.filter((part) => part.includes('stealth/')), []);
  assert.ok((explicitDirect.spec as { command: string[] }).command.includes('ox-alpha'));
  const listed = runModelsDriver({
    repoRoot: root,
    userPathOptions: user,
    driver: 'opencode',
    spawn: () => ({ status: 0, stdout: 'openrouter/stealth/ox-alpha\n', stderr: '' }),
  });
  assert.deepEqual(listed.models, [{ id: 'openrouter/stealth/ox-alpha', registered_as: ['moonshot'] }]);
});

test('model add: duplicate, missing discovery, and malformed user catalog never overwrite user state', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  const userCatalog = join(user.env!.FADENO_CONFIG_HOME!, 'fadeno', 'executors.yaml');
  assert.throws(
    () => runModelsAdd({ repoRoot: root, userPathOptions: user, alias: 'luna', discoveryId: 'stealth/ox-alpha', spawn: () => { throw new Error('must not list'); } }),
    (err: unknown) => err instanceof ModelsError && /already exists/.test(err.message),
  );
  assert.ok(!existsSync(userCatalog));
  assert.throws(
    () => runModelsAdd({ repoRoot: root, userPathOptions: user, alias: 'moonshot', discoveryId: 'stealth/ox-alpha', spawn: () => ({ status: 0, stdout: 'other/model\n', stderr: '' }) }),
    (err: unknown) => err instanceof ModelsError && /tried exact identities/.test(err.message),
  );
  assert.ok(!existsSync(userCatalog), 'failed discovery writes nothing');
  mkdirSync(join(user.env!.FADENO_CONFIG_HOME!, 'fadeno'), { recursive: true });
  writeFileSync(userCatalog, 'models: []\n');
  const before = readFileSync(userCatalog, 'utf8');
  assert.throws(
    () => runModelsAdd({ repoRoot: root, userPathOptions: user, alias: 'moonshot', discoveryId: 'stealth/ox-alpha', spawn: () => ({ status: 0, stdout: 'stealth/ox-alpha\n', stderr: '' }) }),
    (err: unknown) => err instanceof ModelsError && /non-mapping models/.test(err.message),
  );
  assert.equal(readFileSync(userCatalog, 'utf8'), before);
});

test('model add: injected discovery path and a self-contained project are explicit about promotion visibility', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { local: { provider: 'local', id: 'local-1' } },
    routes: {
      standalone: {
        local: { command: ['local', '{model}'] },
        'opencode-direct': { driver: 'opencode-direct', command: ['opencode', 'run', '-m', '{model}'] },
        openrouter: { driver: 'opencode', command: ['opencode', 'run', '-m', 'openrouter/{model}'], models_command: ['opencode', 'models'], models_prefix: 'openrouter/' },
      },
    },
  }));
  const result = runModelsAdd({
    repoRoot: root,
    userPathOptions: user,
    alias: 'moonshot',
    discoveryId: 'stealth/ox-alpha',
    discoveryPath: [{
      name: 'test-plugin-path',
      driver: 'opencode',
      listedId: (provider, id) => `plugin/${provider}/${id}`,
      delivery: (provider, id) => ({ route: 'opencode-direct', id: `${provider}/${id}` }),
    }],
    spawn: () => ({ status: 0, stdout: 'plugin/stealth/ox-alpha\n', stderr: '' }),
  });
  assert.equal(result.discovery_path, 'test-plugin-path');
  assert.equal(result.suppressed_by_project, true);
  assert.match(readFileSync(join(user.env!.FADENO_CONFIG_HOME!, 'fadeno', 'executors.yaml'), 'utf8'), /moonshot:/);
  // The alias's delivery route (`opencode-direct`) IS declared in this
  // self-contained catalog, so the per-key fallback promotes it: it is now a
  // first-class citizen of this repo's effective view, not hidden. A user
  // model whose route resolves NOWHERE is the dropped case — covered in
  // test/model-fallback.test.ts.
  assert.equal(runModels({ repoRoot: root, userPathOptions: user }).models.some((row) => row.name === 'moonshot'), true);
});

test('model add: a self-contained project cannot hide global aliases or discovery routes', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  // Deliberately complete enough to suppress both builtin and user layers,
  // while carrying no OpenCode route at all. Promotion must still use the
  // global builtin+user catalog, then report this project's suppression.
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { local: { provider: 'local', id: 'local-1' } },
    routes: { standalone: { local: { command: ['local', '{model}'] } } },
  }));
  assert.throws(
    () => runModelsAdd({ repoRoot: root, userPathOptions: user, alias: 'luna', discoveryId: 'stealth/ox-alpha', spawn: () => { throw new Error('must not list'); } }),
    (err: unknown) => err instanceof ModelsError && /already exists/.test(err.message),
    'builtin canonical aliases remain reserved even when this project hides the builtin catalog',
  );
  let listings = 0;
  const result = runModelsAdd({
    repoRoot: root,
    userPathOptions: user,
    alias: 'moonshot',
    discoveryId: 'stealth/ox-alpha',
    spawn: (command) => {
      listings += 1;
      assert.deepEqual(command, ['opencode', 'models']);
      return { status: 0, stdout: 'stealth/ox-alpha\n', stderr: '' };
    },
  });
  assert.equal(listings, 1);
  assert.equal(result.suppressed_by_project, true);
  assert.match(readFileSync(join(user.env!.FADENO_CONFIG_HOME!, 'fadeno', 'executors.yaml'), 'utf8'), /moonshot:/);
});

test('model add: project aliases are reserved in overlay and self-contained catalogs', (t) => {
  const cases = [
    {
      mode: 'overlay',
      catalog: { schema_version: 3, models: { moonshot: { provider: 'local', id: 'local-1' } } },
    },
    {
      mode: 'self-contained',
      catalog: {
        schema_version: 3,
        models: { moonshot: { provider: 'local', id: 'local-1' } },
        routes: { standalone: { local: { command: ['local', '{model}'] } } },
      },
    },
  ] as const;
  for (const { mode, catalog } of cases) {
    const root = tempRepo(t);
    const user = isolated(root);
    mkdirSync(join(root, '.fadeno'), { recursive: true });
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(catalog));
    assert.throws(
      () => runModelsAdd({ repoRoot: root, userPathOptions: user, alias: 'moonshot', discoveryId: 'stealth/ox-alpha', spawn: () => { throw new Error('must not list'); } }),
      (err: unknown) => err instanceof ModelsError && /already exists/.test(err.message),
      `${mode} project aliases must be rejected before discovery`,
    );
  }
});

test('fadeno model add runs the singular CLI form end to end', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const opencode = join(bin, 'opencode');
  writeFileSync(opencode, '#!/bin/sh\nprintf "stealth/ox-alpha\\n"\n');
  chmodSync(opencode, 0o755);
  const output = execFileSync(
    process.execPath,
    [CLI, 'model', 'add', 'moonshot', 'stealth/ox-alpha', '--json'],
    {
      cwd: root,
      env: { ...process.env, ...user.env, HOME: user.home!, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
  const result = JSON.parse(output);
  assert.equal(result.alias, 'moonshot');
  assert.equal(result.discovery_path, 'opencode');
});

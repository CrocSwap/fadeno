import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { KNOWN_CLI_COMMANDS } from '../src/cli.ts';
import { ModelsError, runModels, runModelsAdd, runModelsHarness } from '../src/commands/models.ts';
import { unknownFlagsFor } from '../src/commands/completion.ts';
import { recordVerifiedModel, type UserPathOptions } from '../src/lib/user-paths.ts';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import { argvGrantsFadenoShell, resolveDelivery } from '../src/lib/executors.ts';
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
    schema_version: 4,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'high', spellings: { opencode: 'anthropic/claude-opus' } },
    },
    harnesses: {
      codex: {
        provider: 'openai',
        command: ['node', '-e', '0'],
        // One id per LINE, which is what every shipped backend actually
        // emits. This fixture used to put both ids on one space-separated
        // line — a shape no real backend produces, and one that only
        // "worked" because the listing tokenized on whitespace and so also
        // turned agy's `id<TAB>Description` rows into four models each.
        models_command: ['printf', 'gpt-5.6-sol\\ngpt-5.6-luna\\n'],
      },
      claude: {
        provider: 'anthropic',
        // `fadeno_capable` is read off the argv that will actually run, so the
        // flag has to be IN it — there is no second "variant" argv beside it.
        command: ['claude', '-p', '--model', '{model}', '--allowedTools', 'Bash(fadeno:*)'],
      },
      opencode: {
        command: ['opencode', 'run', '-m', '{model}'],
        models_command: ['printf', 'anthropic/claude-opus\\nqwen-max\\n'],
      },
    },
    archetypes: { worker: { } },
    unregistered_model_harness: 'opencode',
  }));
  return { root, user: isolated(root) };
}

test('models: the catch-all is a row, not a footnote', (t) => {
  const { root, user } = seed(t);
  const out = execFileSync(process.execPath, [CLI, 'models'], {
    cwd: root, env: { ...process.env, ...user.env, HOME: user.home! }, encoding: 'utf8',
  });
  // An unregistered name is dialed as written and delivered by
  // `unregistered_model_harness`. That is the same question every other row
  // answers, so it is answered in the same columns rather than in a sentence
  // under the table that a reader scanning the harness column never reaches.
  assert.match(out, /^\*\s+\*\s+\*\s+\*\s+opencode$/m);
  assert.doesNotMatch(out, /any other name runs on/);
  // The header is the only uppercase line: column names, docker-style.
  assert.match(out.split('\n')[0]!, /^MODEL\s+PROVIDER\s+ID\s+EFFORT\s+HARNESS$/);
  // The row follows the catalog: a repo that sets the key sees its own answer.
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), readFileSync(join(root, '.fadeno', 'executors.yaml'), 'utf8').replace('unregistered_model_harness: opencode', 'unregistered_model_harness: claude'));
  const retargeted = execFileSync(process.execPath, [CLI, 'models'], {
    cwd: root, env: { ...process.env, ...user.env, HOME: user.home! }, encoding: 'utf8',
  });
  assert.match(retargeted, /^\*\s+\*\s+\*\s+\*\s+claude$/m);
  // One model is one question: the detail view answers about that name only.
  const detail = execFileSync(process.execPath, [CLI, 'models', 'sol'], {
    cwd: root, env: { ...process.env, ...user.env, HOME: user.home! }, encoding: 'utf8',
  });
  assert.doesNotMatch(detail, /^\*\s/m);
});

test('models: registry table — deliveries, lane marks, verification cache', (t) => {
  const { root, user } = seed(t);
  recordVerifiedModel(user, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2026-08-16T00:00:00Z' });

  const result = runModels({ repoRoot: root, userPathOptions: user });
  assert.equal(result.host, 'standalone');
  assert.equal(result.host_source, 'FADENO_HARNESS');
  assert.equal(result.unregistered_model_harness, 'opencode');
  assert.deepEqual(result.listable_harnesses, ['codex', 'opencode']);

  const names = result.models.map((r) => r.name);
  assert.deepEqual(
    names.filter((n) => n !== 'current-host'),
    ['opus', 'sol'],
    'rows sort by home_harness (claude < codex)',
  );

  const sol = result.models.find((r) => r.name === 'sol')!;
  assert.equal(sol.home_harness, 'codex');
  assert.equal(sol.native, false);
  assert.equal(sol.effort, 'high');
  assert.equal(sol.verified_at, '2026-08-16T00:00:00Z');

  const host = result.models.find((r) => r.name === 'current-host');
  // `false`, from a bare shell and against a catalog whose harnesses declare
  // no `host:` block at all. `native` means "runs in the session you are in",
  // and there is no session here — the `true` this used to assert came from
  // reading `spec.adapter`, which is also how a delivery with NO argv is
  // represented. The positive case is pinned in the caller-frame test below.
  if (host != null) assert.equal(host.native, false);

  const opus = result.models.find((r) => r.name === 'opus')!;
  assert.equal(opus.home_harness, 'claude');
  assert.equal(opus.fadeno_capable, true);
  // The fixture above pins the SCOPED spelling on purpose: a user catalog may
  // still carry `Bash(fadeno:*)`, and the shipped lanes moved to the bare
  // `Bash` rule. `fadeno_capable` reads both, which is what kept this column
  // from silently flipping to `false` for every anthropic delivery when the
  // base claude lane opened its shell. See argvGrantsFadenoShell.
  // The opencode delivery is visible with its spelling-substituted id.
  const alt = opus.deliveries.find((d) => d.harness === 'opencode');
  assert.ok(alt);
  assert.equal(alt!.id, 'anthropic/claude-opus');
});

test('models: the SHIPPED catalog reports an anthropic command delivery as fadeno_capable', (t) => {
  // End to end on the real one-list-two-consumers path — starter
  // executors.yaml -> resolveDelivery -> runModels -> `fadeno_capable` — with
  // no fixture in between. The test above deliberately pins a catalog that
  // still spells the grant `Bash(fadeno:*)`, so it stays green no matter what
  // the shipped lanes carry; this one goes red the moment the shipped argv
  // stops granting the shell, which is exactly the drift that would otherwise
  // flip a shipped output field in silence.
  //
  // No project catalog is written: the builtin layer IS
  // templates/common/fadeno/executors.yaml.
  const root = tempRepo(t);
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      // A NON-Claude host, so the anthropic dial ejects to the command lane
      // rather than answering in session with no argv at all.
      FADENO_HARNESS: 'codex',
    },
  };
  const opus = runModels({ repoRoot: root, userPathOptions: user }).models.find((r) => r.name === 'opus')!;
  assert.equal(opus.home_harness, 'claude');
  assert.equal(opus.adapter, 'command', 'ejected to the command lane under a codex host');
  assert.equal(opus.fadeno_capable, true, 'the shipped claude command lane can run fadeno');

  // One lane per harness now, so what the column reports IS what a director
  // would get — there is no second, archetype-chosen argv to read separately.
  const profile = loadLayeredProfile(root, user, 'codex').profile;
  const resolved = resolveDelivery({ model: 'opus' }, profile, 'codex');
  assert.equal(resolved.spec.adapter, 'command');
  assert.equal(argvGrantsFadenoShell((resolved.spec as { command: string[] }).command), true);
});

test('models: the SHIPPED catalog reports an openai command delivery as fadeno_capable', (t) => {
  // The codex half of the same one-list-two-consumers path, and until
  // 2026-09-06 it was WRONG: the catalog's director note said codex "already
  // could" run fadeno and `director.test.ts` called the codex lane open, while
  // this column answered `false` for every codex delivery because the
  // predicate only knew Claude's vocabulary. Widening it is the fix; this is
  // the end-to-end pin that the two now agree.
  const root = tempRepo(t);
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      // A NON-Codex host, so the openai dial ejects to the codex command lane.
      FADENO_HARNESS: 'claude',
    },
  };
  const sol = runModels({ repoRoot: root, userPathOptions: user }).models.find((r) => r.name === 'sol')!;
  assert.equal(sol.home_harness, 'codex');
  assert.equal(sol.adapter, 'command', 'ejected to the command lane under a claude host');
  assert.equal(sol.fadeno_capable, true, 'the shipped codex command lane can run fadeno');
});

test('models: a model whose provider no harness claims as home is a LOAD error, not a stale row', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { ghost: { provider: 'nowhere', id: 'ghost-1', effort: 'high' } },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', '0'] } },
  }));
  // v3 listed it as a stale row and failed at dispatch time instead. Under v4
  // the harness table is host-independent, so "nothing can deliver this" is
  // knowable at load — and the message names the command that fixes it.
  assert.throws(
    () => runModels({ repoRoot: root, userPathOptions: isolated(root) }),
    (err: unknown) => err instanceof ModelsError
      && /provider "nowhere", which no harness claims as home/.test(err.message)
      && /fadeno model add ghost nowhere\/ghost-1/.test(err.message),
  );
});

test('models --harness: live listing via models_command with registered spellings marked', (t) => {
  const { root, user } = seed(t);
  const result = runModelsHarness({ repoRoot: root, userPathOptions: user, harness: 'opencode' });
  assert.deepEqual(result.models_command, ['printf', 'anthropic/claude-opus\\nqwen-max\\n']);
  assert.deepEqual(result.models, [
    { id: 'anthropic/claude-opus', registered_as: ['opus'] },
    { id: 'qwen-max', registered_as: [] },
  ]);
  // Home ids mark too.
  const codex = runModelsHarness({ repoRoot: root, userPathOptions: user, harness: 'codex' });
  assert.deepEqual(codex.models[0], { id: 'gpt-5.6-sol', registered_as: ['sol'] });
  assert.deepEqual(codex.models[1], { id: 'gpt-5.6-luna', registered_as: [] });
});

test('models --harness: a listing is parsed per line, not per whitespace token', (t) => {
  // The three shapes the shipped backends actually emit, pinned together
  // because the bug was that one parse was serving two different questions.
  // `agy` is the one that broke: `id<TAB>Description` after a progress
  // preamble became `gemini-3.7-flash-high`, `Gemini`, `3.7`, `Flash`,
  // `(High)` — five "models" from one, and 31 real models became 100-odd.
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { flash: { provider: 'google', id: 'gemini-3.7-flash-high', effort: 'high' } },
    harnesses: {
      // agy: a preamble line, then tab-separated id + human label.
      agy: {
        provider: 'google',
        command: ['agy'],
        models_command: ['printf', 'Fetching available models...\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n'],
      },
      // opencode: one bare id per line, nothing else.
      opencode: { command: ['opencode'], models_command: ['printf', 'opencode/big-pickle\nopencode/hy3-free\n'] },
      // grok: prose, and no listing at all. The honest answer is an empty
      // list, not a set of models named after the words in its login banner.
      grok: { provider: 'xai', command: ['grok'], models_command: ['printf', 'You are logged in with grok.com.\n\nDefault model: grok-4.6\n'] },
    },
    archetypes: { worker: {} },
  }));
  const user = isolated(root);

  const agy = runModelsHarness({ repoRoot: root, userPathOptions: user, harness: 'agy' });
  assert.deepEqual(agy.models, [
    { id: 'gemini-3.7-flash-high', registered_as: ['flash'] },
    { id: 'gemini-3.7-flash-low', registered_as: [] },
  ], 'the tab-separated label is not a model, and the preamble is not a model');

  const oc = runModelsHarness({ repoRoot: root, userPathOptions: user, harness: 'opencode' });
  assert.deepEqual(oc.models.map((m) => m.id), ['opencode/big-pickle', 'opencode/hy3-free']);

  const grok = runModelsHarness({ repoRoot: root, userPathOptions: user, harness: 'grok' });
  assert.deepEqual(grok.models, [], 'prose yields no models rather than one per word');
});

test('models --harness: unknown harness and probe-less harness refuse with guidance', (t) => {
  const { root, user } = seed(t);
  assert.throws(
    () => runModelsHarness({ repoRoot: root, userPathOptions: user, harness: 'nope' }),
    (err: unknown) => err instanceof ModelsError && /unknown harness "nope" — declared harnesses:/.test((err as Error).message),
  );
  assert.throws(
    () => runModelsHarness({ repoRoot: root, userPathOptions: user, harness: 'claude' }),
    (err: unknown) => err instanceof ModelsError && /declares no models_command/.test((err as Error).message),
  );
});

test('models: the home harness is stable while the caller-specific adapter changes', (t) => {
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
    // `home_harness`, the model's own executor — not `host`, which in this
    // same command means the agent asking and differs on every iteration of
    // the loop above. The two used to share the name `harness`.
    assert.equal(row.home_harness, 'codex');
    assert.ok(!('home_via' in row), 'the driver-era synonym is gone, not deprecated');
  }
  assert.equal(rows.get('codex')!.adapter, 'host');
  assert.equal(rows.get('claude')!.adapter, 'command');
  assert.equal(rows.get('grok')!.adapter, 'command');
  assert.equal(rows.get('standalone')!.adapter, 'command');
  // `native` is the LANE, and the two questions diverge on a spec with no
  // argv: only the caller sitting inside `luna`'s own harness gets it
  // in-session.
  assert.equal(rows.get('codex')!.native, true);
  assert.equal(rows.get('claude')!.native, false);
  assert.equal(rows.get('grok')!.native, false);
  assert.equal(rows.get('standalone')!.native, false);
});

test('models: rows sort by home_harness, then provider, then name', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
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
    harnesses: {
      claude: { provider: 'anthropic', command: ['node', '-e', '0'] },
      // Two providers cannot share one harness under v4 (exactly one home per
      // provider), so the tie is made by two harnesses that sort together.
      shared_a: { provider: 'acme', command: ['node', '-e', '0'] },
      shared_z: { provider: 'zenith', command: ['node', '-e', '0'] },
    },
    archetypes: { worker: {} },
  }));

  const result = runModels({ repoRoot: root, userPathOptions: isolated(root) });
  assert.deepEqual(
    result.models.map((r) => [r.name, r.home_harness, r.provider]),
    [
      ['zulu', 'claude', 'anthropic'],
      // The synthesized current-host row participates in the same ordering.
      ['current-host', 'current-host', 'current-host'],
      ['bravo', 'shared_a', 'acme'],
      ['mike', 'shared_a', 'acme'],
      ['alpha', 'shared_z', 'zenith'],
    ],
  );
});

test('model is a registered top-level alias of models for flag validation', () => {
  assert.ok(KNOWN_CLI_COMMANDS.has('model'));
  // Same completion spec object as `models`, so the accepted flag sets match
  // exactly — including what each spelling rejects.
  assert.deepEqual(unknownFlagsFor('model', undefined, ['harness', 'json']), []);
  assert.deepEqual(unknownFlagsFor('models', undefined, ['harness', 'json']), []);
  assert.deepEqual(unknownFlagsFor('model', undefined, ['session']), ['--session']);
  assert.deepEqual(unknownFlagsFor('model', 'add', ['json']), []);
  // Completion is intentionally additive for subcommands; the CLI still
  // rejects --harness on model add because it would change discovery meaning.
  assert.deepEqual(unknownFlagsFor('models', 'add', ['harness']), []);
});

test('fadeno model runs the models handler end to end', (t) => {
  const { root, user } = seed(t);
  const env = { ...process.env, ...user.env, HOME: user.home! };
  const runCli = (args: string[]): string =>
    execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });

  assert.equal(runCli(['model']), runCli(['models']));
  const singular = JSON.parse(runCli(['model', '--json']));
  const plural = JSON.parse(runCli(['models', '--json']));
  assert.equal(singular.host, 'standalone');
  assert.deepEqual(singular.models, plural.models);
});

test('model add: a directly-served identity is not registrable against the shipped opencode lane', (t) => {
  // The shipped `opencode` command prefixes every id with `openrouter/`, so an
  // identity OpenCode lists WITHOUT that prefix has no spelling to record
  // against it. Discovery fails loudly and names the way out — declare a
  // harness entry whose argv omits the prefix — rather than writing an entry
  // that silently resolves onto the OpenRouter lane carrying a direct id.
  const root = tempRepo(t);
  const user = isolated(root);
  const userCatalog = join(user.env!.FADENO_CONFIG_HOME!, 'fadeno', 'executors.yaml');
  mkdirSync(join(user.env!.FADENO_CONFIG_HOME!, 'fadeno'), { recursive: true });
  writeFileSync(userCatalog, `# Keep this comment and unrelated known configuration.\nschema_version: 4\nmodels:\n  older:\n    provider: openai\n    id: old\n`);
  const before = readFileSync(userCatalog, 'utf8');
  assert.throws(
    () => runModelsAdd({
      repoRoot: root,
      userPathOptions: user,
      alias: 'moonshot',
      discoveryId: 'stealth/ox-alpha',
      spawn: () => ({ status: 0, stdout: 'stealth/ox-alpha\n', stderr: '' }),
    }),
    // And the message names WHICH failure this is: the identity is listed,
    // just not registrable, so a reader is not sent hunting for a spelling
    // that is right in front of them.
    (err: unknown) => err instanceof ModelsError
      && /IS listed by OpenCode, but only as a direct \(non-OpenRouter\) identity/.test(err.message)
      && /Declare a harness entry of your own/.test(err.message),
  );
  assert.equal(readFileSync(userCatalog, 'utf8'), before, 'a failed discovery writes nothing');
  // An identity that is on NEITHER listing still gets the plain not-found.
  assert.throws(
    () => runModelsAdd({
      repoRoot: root, userPathOptions: user, alias: 'nope', discoveryId: 'stealth/absent',
      spawn: () => ({ status: 0, stdout: 'stealth/ox-alpha\n', stderr: '' }),
    }),
    (err: unknown) => err instanceof ModelsError && /tried exact identities: openrouter\/stealth\/absent/.test(err.message),
  );
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
  assert.deepEqual(result.delivery, { harness: 'opencode', id: 'stealth/ox-alpha', listed_id: 'openrouter/stealth/ox-alpha' });
  const compiled = resolveDelivery({ model: 'moonshot' }, loadLayeredProfile(root, user, 'standalone').profile);
  assert.equal(compiled.harness, 'opencode');
  assert.equal(compiled.modelId, 'stealth/ox-alpha');
  assert.deepEqual((compiled.spec as { command: string[] }).command.filter((part) => part.includes('stealth/')), ['openrouter/stealth/ox-alpha']);
  // Naming the same harness explicitly resolves identically: the spelling is
  // a property of the (model, harness) pair, not of how the dial reached it.
  // Under v3 the same name reached two different ROUTES (`openrouter` vs
  // `opencode-direct`) and produced two different ids; v4 has one lane per
  // harness, and a variant is policy's to choose, never a dial's to name.
  const explicitHome = resolveDelivery({ model: 'moonshot', harness: 'opencode' }, loadLayeredProfile(root, user, 'standalone').profile);
  assert.equal(explicitHome.modelId, 'stealth/ox-alpha');
  assert.deepEqual((explicitHome.spec as { command: string[] }).command.filter((part) => part.includes('stealth/')), ['openrouter/stealth/ox-alpha']);
  const listed = runModelsHarness({
    repoRoot: root,
    userPathOptions: user,
    harness: 'opencode',
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
    schema_version: 4,
    models: { local: { provider: 'local', id: 'local-1' } },
    harnesses: {
      local: { provider: 'local', command: ['local', '{model}'] },
      opencode: { command: ['opencode', 'run', '-m', 'openrouter/{model}'], models_command: ['opencode', 'models'], models_prefix: 'openrouter/' },
    },
  }));
  const result = runModelsAdd({
    repoRoot: root,
    userPathOptions: user,
    alias: 'moonshot',
    discoveryId: 'stealth/ox-alpha',
    discoveryPath: [{
      name: 'test-plugin-path',
      harness: 'opencode',
      listedId: (provider, id) => `plugin/${provider}/${id}`,
      spelling: (provider, id) => `${provider}/${id}`,
    }],
    spawn: () => ({ status: 0, stdout: 'plugin/stealth/ox-alpha\n', stderr: '' }),
  });
  assert.equal(result.discovery_path, 'test-plugin-path');
  assert.equal(result.suppressed_by_project, true);
  assert.match(readFileSync(join(user.env!.FADENO_CONFIG_HOME!, 'fadeno', 'executors.yaml'), 'utf8'), /moonshot:/);
  // The alias's harness (`opencode`) IS declared in this self-contained
  // catalog, so the per-key fallback promotes it: it is now a first-class
  // citizen of this repo's effective view, not hidden. A user model whose
  // harness resolves NOWHERE is the dropped case — covered in
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
    schema_version: 4,
    models: { local: { provider: 'local', id: 'local-1' } },
    harnesses: { local: { provider: 'local', command: ['local', '{model}'] } },
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
      return { status: 0, stdout: 'openrouter/stealth/ox-alpha\n', stderr: '' };
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
      catalog: {
        schema_version: 4,
        models: { moonshot: { provider: 'local', id: 'local-1', harness: 'opencode' } },
      },
    },
    {
      mode: 'self-contained',
      catalog: {
        schema_version: 4,
        models: { moonshot: { provider: 'local', id: 'local-1' } },
        harnesses: { local: { provider: 'local', command: ['local', '{model}'] } },
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
  writeFileSync(opencode, '#!/bin/sh\nprintf "openrouter/stealth/ox-alpha\\n"\n');
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
  assert.equal(result.discovery_path, 'opencode/openrouter');
});

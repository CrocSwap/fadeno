import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDialResolve, runDialSet, runDialShow } from '../src/commands/dial.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// Isolated per-repo user state: these tests must never read the developer's
// real user dials (a non-empty real user layer flips `base` rows to `user`).
const isolated = (root: string): UserPathOptions => ({
  home: join(root, 'home'),
  env: {
    FADENO_CONFIG_HOME: join(root, 'user-config'),
    FADENO_STATE_HOME: join(root, 'user-state'),
    FADENO_HARNESS: 'standalone',
  },
});

/** The same catalog seen from inside a host session, where `codex` is the host. */
const inCodex = (root: string): UserPathOptions => ({
  home: join(root, 'home-codex'),
  env: {
    FADENO_CONFIG_HOME: join(root, 'cfg-codex'),
    FADENO_STATE_HOME: join(root, 'state-codex'),
    FADENO_HARNESS: 'codex',
  },
});

function seedCatalog(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 4,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      terra: { provider: 'openai', id: 'terra-model', effort: 'medium' },
    },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', '0'] }, grok: { provider: 'xai', command: ['node', '-e', '0'] } },
    archetypes: {
      worker: { },
      reviewer: { },
      judge: { },
    },
    ...extra,
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
  return root;
}

function cliRun(root: string, paths: UserPathOptions, args: string[]): string {
  return execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args], {
    cwd: root,
    env: { ...process.env, ...paths.env, HOME: paths.home! },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

test('dial show: every archetype, and where it goes', (t) => {
  const root = seedCatalog(t);
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.equal(result.host, 'standalone');
  const worker = result.rows.find((r) => r.archetype === 'worker')!;
  assert.ok(worker);
  assert.equal(worker.source, 'base');
  assert.equal(worker.model, 'current-host');
  // Routing only. What an archetype is FOR is `fadeno context`; a row that
  // carried it too meant one description with two owners.
  assert.ok(!('description' in worker));
  // From a bare shell the base dial names a session that is not there, so it
  // is off the host lane with nothing to invoke.
  assert.equal(worker.lane, 'command');
  assert.equal(worker.deliverable, false);
  assert.ok(Array.isArray(result.suppressed_canon_archetypes));
  assert.match(JSON.stringify(result), /"suppressed_canon_archetypes"/);
});

test('dial show: rows follow the canon power order, extras alphabetical after', (t) => {
  const root = seedCatalog(t, {
    archetypes: {
      worker: { },
      reviewer: { },
      judge: { },
      director: { },
      scout: {},
      auditor: {},
    },
  });
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.deepEqual(
    result.rows.map((r) => r.archetype),
    ['director', 'judge', 'reviewer', 'scout', 'worker', 'auditor'],
  );
});

test('dial resolve: the inspection contract', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'grok' } });
  const result = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: isolated(root) });
  assert.deepEqual(Object.keys(result).sort(), [
    'archetype', 'command', 'dial', 'effective_effort', 'executor', 'harness',
    'host', 'lane', 'model', 'model_id', 'pinned_effort', 'source',
  ]);
  assert.equal(result.model, 'grok');
  assert.equal(result.model_id, 'grok-4.6');
  assert.equal(result.harness, 'grok');
  assert.equal(result.host, 'standalone');
  assert.equal(result.source, 'repo');
  // The argv a dispatch would run, so a reader can see what "command lane"
  // actually means here rather than being told a lane name.
  assert.equal(result.lane, 'command');
  assert.deepEqual(result.command, ['node', '-e', '0']);
});

test('dial show: the model keeps its home harness while the LANE follows the caller', (t) => {
  const root = seedCatalog(t, {
    harnesses: {
      codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: ['node', '-e', '0'] },
      grok: { provider: 'xai', command: ['node', '-e', '0'] },
    },
    dials: { reviewer: 'sol' },
  });
  const lanes = new Map<string, ReturnType<typeof runDialShow>['rows'][number]>();
  for (const harness of ['codex', 'claude', 'grok', 'standalone']) {
    const userPathOptions: UserPathOptions = {
      home: join(root, `home-${harness}`),
      env: {
        FADENO_CONFIG_HOME: join(root, `config-${harness}`),
        FADENO_STATE_HOME: join(root, `state-${harness}`),
        FADENO_HARNESS: harness,
      },
    };
    lanes.set(harness, runDialShow({ repoRoot: root, userPathOptions }).rows.find((row) => row.archetype === 'reviewer')!);
  }
  for (const row of lanes.values()) {
    // `harness` is the EXECUTOR — who runs it. Not the host, which is what the
    // loop varies. Two keys with two names; they used to be one word.
    assert.equal(row.harness, 'codex');
    assert.equal(row.harness_explicit, false, 'no `--harness` was given; this is the model\'s home');
    assert.equal(row.model, 'sol');
  }
  // The lane, and only the lane, moves with the caller: `sol` lives on codex,
  // so a codex session delivers it in-session and everyone else spawns it.
  assert.equal(lanes.get('codex')!.lane, 'host');
  assert.equal(lanes.get('claude')!.lane, 'command');
  assert.equal(lanes.get('grok')!.lane, 'command');
  assert.equal(lanes.get('standalone')!.lane, 'command');
  for (const row of lanes.values()) assert.equal(row.deliverable, true, 'codex declares a command');
});

test('dial CLI: --session creates a local dial and a later unscoped set updates it', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  const run = (args: string[]) => JSON.parse(cliRun(root, paths, [...args, '--json'])) as Record<string, any>;

  const created = run(['dial', 'judge', 'grok', '--session']);
  assert.equal(created.layer, 'session');
  const updated = run(['dial', 'judge', 'sol']);
  assert.equal(updated.layer, 'session');
  assert.equal(updated.adaptive, true);

  const shown = run(['dial']);
  assert.equal(shown.dials.session.judge.model, 'sol');
  assert.equal(shown.dials.user.judge, undefined);
  assert.equal(shown.rows.find((row: Record<string, unknown>) => row.archetype === 'judge')?.model, 'sol');
});

// ---- Pinned vs unpinned effort ----

test('dial show: a registry default never renders as a pin', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  // `sol` declares effort: high in the registry. Three dials on the same
  // model: no opinion, a pin that differs from the default, and a pin that
  // happens to equal it — the third is the one a display keyed on "differs
  // from the default" erases.
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'sol', session: true });
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'reviewer', model: 'sol@low', session: true });
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'judge', model: 'sol@high', session: true });
  const rows = runDialShow({ repoRoot: root, userPathOptions: paths }).rows;
  const row = (archetype: string) => rows.find((r) => r.archetype === archetype)!;

  assert.equal(row('worker').pinned_effort, null);
  assert.equal(row('worker').effective_effort, 'high');
  assert.equal(row('reviewer').pinned_effort, 'low');
  assert.equal(row('reviewer').effective_effort, 'low');
  assert.equal(row('judge').pinned_effort, 'high');
  assert.equal(row('judge').effective_effort, 'high');
});

test('dial set/resolve JSON carries the pin separately from the resolved effort', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  const unpinned = runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'sol', session: true });
  assert.equal(unpinned.pinned_effort, null);
  assert.equal(unpinned.effective_effort, 'high');
  const resolvedUnpinned = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: paths });
  assert.equal(resolvedUnpinned.pinned_effort, null);
  assert.equal(resolvedUnpinned.effective_effort, 'high');

  const pinned = runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'sol@low', session: true });
  assert.equal(pinned.pinned_effort, 'low');
  assert.equal(pinned.effective_effort, 'low');
  const resolvedPinned = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: paths });
  assert.equal(resolvedPinned.pinned_effort, 'low');
  assert.equal(resolvedPinned.effective_effort, 'low');
});

test('dial CLI: effort rides the model cell, and only when the pin is not the default', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  // `sol` declares `effort: high`.
  cliRun(root, paths, ['dial', 'worker', 'sol', '--session']);
  cliRun(root, paths, ['dial', 'reviewer', 'sol@low', '--session']);
  cliRun(root, paths, ['dial', 'judge', 'sol@high', '--session']);
  const table = cliRun(root, paths, ['dial']);
  const rowFor = (archetype: string) => table.split('\n').find((line) => line.startsWith(archetype))!;
  assert.match(rowFor('worker'), /\bsol\s/, 'no pin, no suffix');
  assert.match(rowFor('reviewer'), /\bsol@low\s/, 'a pin the registry would not have given it');
  // A pin that restates the model's own default changes nothing, so it is not
  // shown: the column would otherwise carry a suffix on every row that said
  // only what the registry already says.
  assert.match(rowFor('judge'), /\bsol\s/);
  assert.doesNotMatch(rowFor('judge'), /@high/);
  // No column of its own, on any row.
  assert.doesNotMatch(table.split('\n')[0]!, /\beffort\b/);
  assert.doesNotMatch(table, /\binherit\b/);
  // The single-archetype view is the same renderer, so it must agree.
  assert.match(cliRun(root, paths, ['dial', 'reviewer']), /\bsol@low\s/);
});

// --- The lane, and where it is NOT ---
//
// `laneOf` stays on the row because `status` reports it, and because the
// resolver and the spawn wrapper must agree about one bit. The TABLE does not
// print it: the lane is `harness == host`, so from a bare shell — where this
// command is almost always run — it is a constant, and a column of constants
// only invited the reading it could not survive, that a dial IS a command-lane
// dial when the same dial file is a host dial read from inside that harness.

test('dial rows carry the lane for status, and the table prints archetype, model, harness, source', (t) => {
  const root = seedCatalog(t, {
    harnesses: {
      // The host: `sol` is deliverable in-session here, and has a command lane.
      codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: ['node', '-e', '0'] },
      // Not the host, so `grok` can only be spawned.
      grok: { provider: 'xai', command: ['node', '-e', '0'] },
    },
    dials: { worker: 'sol', reviewer: 'grok' },
  });
  const paths = inCodex(root);
  const rows = runDialShow({ repoRoot: root, userPathOptions: paths }).rows;
  const row = (archetype: string) => rows.find((r) => r.archetype === archetype)!;
  assert.equal(row('worker').lane, 'host');
  assert.equal(row('reviewer').lane, 'command');
  // Undialed inside a host session: `current-host` IS the session, so it is a
  // host candidate here — the same dial that has no lane from a bare shell.
  assert.equal(row('judge').model, 'current-host');
  assert.equal(row('judge').lane, 'host');
  assert.equal(row('judge').deliverable, true);

  const table = cliRun(root, paths, ['dial']);
  const rowFor = (archetype: string) => table.split('\n').find((line) => line.startsWith(archetype))!;
  assert.match(table.split('\n')[0]!, /^ARCHETYPE\s+MODEL\s+HARNESS\s+SOURCE$/);
  assert.doesNotMatch(table, /\blane\b/i);
  assert.match(rowFor('worker'), /\bsol\s+codex\s+repo$/);
  assert.match(rowFor('reviewer'), /\bgrok\s+grok\s+repo$/);
  // One line per archetype: a header and three rows.
  const printed = table.split('\n').filter((line) => line.length > 0 && !line.startsWith('note:'));
  assert.equal(printed.length, 4, table);

  // The same catalog from a bare shell. Nothing is in-session, so `judge` has
  // no harness to name and no lane at all — but the table says only what it
  // knows (an empty harness cell), and `status` is where "cannot be dispatched
  // from here" is reported to someone who has to act on it.
  const bare = cliRun(root, isolated(root), ['dial']);
  assert.match(bare.split('\n').find((line) => line.startsWith('judge'))!, /current-host\s+—\s+—$/);
  assert.doesNotMatch(bare, /no lane/);
  assert.equal(runDialShow({ repoRoot: root, userPathOptions: isolated(root) }).rows.find((r) => r.archetype === 'judge')!.deliverable, false);
});

test('the source column says the layer in one word, and an empty cell where no layer answered', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'sol' } });
  const paths = isolated(root);
  cliRun(root, paths, ['dial', 'reviewer', 'grok', '--session']);
  const table = cliRun(root, paths, ['dial']);
  const rowFor = (archetype: string) => table.split('\n').find((line) => line.startsWith(archetype))!;
  assert.match(rowFor('worker'), /\srepo$/);
  assert.match(rowFor('reviewer'), /\ssession$/);
  // No dial at any layer: the cell is empty rather than a sentence.
  assert.match(rowFor('judge'), /\s—$/);
  assert.doesNotMatch(table, /user dial|repo pin|session dial|no dial/);
});

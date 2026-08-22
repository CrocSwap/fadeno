import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runDialShow } from '../src/commands/dial.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runSteeringResolve } from '../src/commands/steering.ts';
import { runValidate } from '../src/commands/validate.ts';
import { DIALS_LOCAL_FILE, parseExecutorProfile, writeLocalDialState } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

/**
 * Dogfood papercut fixes for the dial/dispatch kernel: scaffold
 * discoverability, help discoverability, evidence completeness, failure
 * legibility, stale-pin tolerance, the empty-prompt guard, and the evidence
 * gitignore. All dispatch paths pin harness via userPathOptions; CLI paths
 * pin via child env FADENO_HARNESS.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const HARNESS = 'standalone';
const harnessOpts = { env: { FADENO_HARNESS: HARNESS } } as const;

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const v3RoutesFor = (cmd: string[]) => ({
  standalone: { openai: { command: cmd, }, 'current-host': { host: true } },
  codex: { openai: { command: cmd, }, 'current-host': { host: true } },
  claude: { openai: { command: cmd, }, 'current-host': { host: true } },
});

function seedProfile(t: TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cli(
  root: string,
  args: string[],
  stdin?: string,
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env, FADENO_HARNESS: HARNESS } as Record<string, string>;
  delete (env as any).FADENO_LOADOUT;
  // ensure config/state isolation already set via helpers import
  const spawned = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: stdin ?? '',
    env,
  });
  return { status: spawned.status ?? 1, stdout: spawned.stdout, stderr: spawned.stderr };
}

// --- 1. scaffold discoverability -------------------------------------------

test('scaffold: executors.yaml carries the built-in v3 catalog', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });

  const content = read(root, join('.fadeno', 'executors.yaml'));
  assert.match(content, /^schema_version: 3$/m);
  assert.match(content, /^models:$/m);
  assert.match(content, /^\s+luna:/m);
  assert.match(content, /^\s+terra:/m);
  assert.match(content, /^\s+sol:/m);
  assert.match(content, /^\s+opus:/m);
  assert.match(content, /^routes:$/m);
  assert.doesNotMatch(content, /^loadouts:$/m);
  assert.doesNotMatch(content, /^default_loadout:/m);

  const asShipped = parseExecutorProfile(content, 'executors.yaml', HARNESS as any);
  assert.equal(asShipped.schemaVersion, 3);
  assert.ok(asShipped.models.sol);
  assert.equal(asShipped.models.sol?.provider, 'openai');
  assert.equal(asShipped.models.sol?.id, 'gpt-5.6-sol');
  assert.ok(Object.keys(asShipped.routes).length > 0);
  assert.deepEqual(asShipped.dials, {}, 'starter catalog ships no repo dials');
  assert.equal((asShipped as any).defaultLoadout ?? null, null);
  assert.ok(runValidate({ repoRoot: root }).ok);
});

test('built-in catalog: worker resolves to base (current-host) with no dials', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // steering resolve for worker with no dials → base host. User state is
  // isolated: "no dials" must mean this fixture, not the developer's real
  // user layer (a real `worker` user dial would flip source to `user`).
  const result = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    userPathOptions: { home: join(root, 'home'), env: { FADENO_STATE_HOME: join(root, 'user-state'), FADENO_HARNESS: HARNESS } },
  });
  // In standalone, current-host host without fallback is unsupported for dispatch
  // but steering should still resolve mode; for codex host materialization is host.
  // With standalone harness the base is host; we just check executor is current-host.
  assert.equal(result.executor, 'current-host');
  assert.equal(result.source, 'base');
});

// --- 2. help text -----------------------------------------------------------

test('help: new dial flags are discoverable and old loadout vars are gone', (t) => {
  const root = tempRepo(t);
  const result = cli(root, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--via/);
  assert.match(result.stdout, /--model/);
  assert.match(result.stdout, /--user/);
  assert.match(result.stdout, /--repo/);
  assert.doesNotMatch(result.stdout, /FADENO_LOADOUT/);
  assert.match(result.stdout, /fadeno dial/);
});

// --- 3. echo-tag disambiguation ---------------------------------------------

test('echo: resolution labels use dial source vocabulary, not loadout', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // Seed a repo pin for worker
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 3,
      models: {
        'echo-worker': { provider: 'openai', id: 'echo-worker' },
        'luna-worker': { provider: 'openai', id: 'luna-worker' },
      },
      routes: v3RoutesFor(STDIN_ECHO('REPORT:')),
      archetypes: { worker: {}, reviewer: {} },
      dials: { worker: 'echo-worker' },
    }),
  );
  const created = runNewRun({ playbook: 'code-change-review', task: 'Echo tags', repoRoot: root, userPathOptions: harnessOpts });
  assert.ok(created.resolution);
  assert.ok(created.resolution.echo.length > 0);
  for (const line of created.resolution.echo) {
    // No old loadout vocabulary
    assert.doesNotMatch(line, /\[default\]/);
    assert.doesNotMatch(line, /\[fallback "\*"\]/);
    assert.doesNotMatch(line, /\[loadout/);
    // At least one recognised dial label
    assert.match(line, /\[(repo pin|base|binding|session dial|user dial)\]/);
  }
  // repo pin row carries source repo
  const repoRow = created.resolution.roles.find((r) => r.role === 'implementer' || r.archetype === 'worker');
  if (repoRow) assert.equal(repoRow.source, 'repo');
});

// --- 4. evidence completeness -----------------------------------------------

test('evidence: rows record the resolution path for dial sources', (t) => {
  const root = seedProfile(t, {
    schema_version: 3,
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
      'luna-worker': { provider: 'openai', id: 'luna-worker' },
    },
    routes: v3RoutesFor(STDIN_ECHO('REPORT:')),
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'echo-worker' },
    bindings: { implementer: 'luna-worker' },
  });
  // session dial for reviewer
  writeLocalDialState(root, { dials: { reviewer: { model: 'luna-worker' } }, shadows: {}, legacyNote: null });

  runDispatch({ archetype: 'worker', role: 'implementer', prompt: 'p', repoRoot: root, userPathOptions: harnessOpts });
  runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: harnessOpts });
  runDispatch({ archetype: 'reviewer', prompt: 'p', repoRoot: root, userPathOptions: harnessOpts });
  runDispatch({ model: 'echo-worker', prompt: 'p', repoRoot: root, userPathOptions: harnessOpts });

  const rows = evidenceRows(root);
  assert.deepEqual(rows.map((r) => r.event), [
    'dispatch_requested', 'dispatch_completed',
    'dispatch_requested', 'dispatch_completed',
    'dispatch_requested', 'dispatch_completed',
    'dispatch_requested', 'dispatch_completed',
  ]);
  const completed = rows.filter((r) => r.event === 'dispatch_completed');
  assert.deepEqual(
    completed.map((r) => [r.resolution, r.executor]),
    [
      ['binding', 'luna-worker'],
      ['repo', 'echo-worker'],
      ['session', 'luna-worker'],
      ['model-flag', 'echo-worker'],
    ],
  );
  // All completion rows carry dial/model/driver fields, no legacy loadout/target
  for (const r of completed) {
    assert.ok(typeof r.dial === 'object' && r.dial != null);
    assert.equal(typeof r.executor, 'string');
    assert.equal(typeof r.model, 'string');
    assert.equal(typeof r.model_id, 'string');
    assert.equal(typeof r.driver, 'string');
    assert.ok(!('loadout' in r));
    assert.ok(!('target' in r));
  }
  // binding row still records source binding, session row source session
  assert.equal(completed[0]!.dial != null, true);
  assert.deepEqual((completed[0]!.dial as any), { model: 'luna-worker' });
  assert.deepEqual((completed[2]!.dial as any), { model: 'luna-worker' });
});

// --- 5. failure legibility ---------------------------------------------------

test('cli: a nonzero executor exit gets a stderr diagnosis line; stdout stays pure', (t) => {
  const root = seedProfile(t, {
    schema_version: 3,
    models: { probe: { provider: 'openai', id: 'probe' }, 'fail-model': { provider: 'openai', id: 'fail-model' } },
    routes: {
      standalone: { openai: { command: ['node', '-e', 'process.exit(7)'], } },
      codex: { openai: { command: ['node', '-e', 'process.exit(7)'], } },
      claude: { openai: { command: ['node', '-e', 'process.exit(7)'], } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'fail-model' },
  });
  const result = cli(root, ['dispatch', '--archetype', 'worker'], 'do the thing');
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /dispatch: executor fail-model exited 7/);

  // A clean exit prints no such line – dispatch via model flag to echo
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 3,
      models: { probe: { provider: 'openai', id: 'probe' } },
      routes: v3RoutesFor(STDIN_ECHO('REPORT:')),
      archetypes: { worker: {} },
      dials: { worker: 'probe' },
    }),
  );
  const ok = cli(root, ['dispatch', '--archetype', 'worker'], 'p');
  assert.equal(ok.status, 0);
  assert.doesNotMatch(ok.stderr, /dispatch: executor/);
});

// --- 6. stale local pin ------------------------------------------------------

function seedStalePin(t: TestContext): string {
  const root = seedProfile(t, {
    schema_version: 3,
    models: { probe: { provider: 'openai', id: 'probe' }, luna: { provider: 'openai', id: 'luna' } },
    routes: v3RoutesFor(STDIN_ECHO('REPORT:')),
    archetypes: { worker: {} },
    dials: { worker: 'probe' },
  });
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), 'removed-loadout\n');
  return root;
}

test('stale pin: dial show surfaces the legacy note and falls back to repo pin', (t) => {
  const root = seedStalePin(t);

  const shown = runDialShow({ repoRoot: root, userPathOptions: harnessOpts });
  assert.match(shown.legacy_pin_note ?? '', /pre-0\.6 loadout pin ignored/);
  // still resolves worker via repo pin
  const workerRow = shown.rows.find((r) => r.archetype === 'worker');
  assert.ok(workerRow);
  assert.equal(workerRow.model, 'probe');
  assert.equal(workerRow.source, 'repo');

  // A healthy session dial is not stale
  writeLocalDialState(root, { dials: { worker: { model: 'luna' } }, shadows: {}, legacyNote: null });
  const healthy = runDialShow({ repoRoot: root, userPathOptions: harnessOpts });
  assert.equal(healthy.legacy_pin_note, null);
  const healthyRow = healthy.rows.find((r) => r.archetype === 'worker');
  assert.equal(healthyRow?.source, 'session');
});

test('stale pin: dispatch still succeeds via base/repo pin (legacy pin ignored)', (t) => {
  const root = seedStalePin(t);
  // dispatch should succeed, not throw – legacy pin is empty with note
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: harnessOpts });
  assert.equal(result.stdout, 'REPORT:p');
  // exactly one dispatch pair
  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.resolution, 'repo');
});

test('stale pin: drive still succeeds with legacy pin ignored', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 3,
      models: { probe: { provider: 'openai', id: 'probe' } },
      routes: v3RoutesFor(STDIN_ECHO('REPORT:')),
      archetypes: { worker: {} },
      dials: { worker: 'probe' },
    }),
  );
  const created = runNewRun({ playbook: 'code-change-review', task: 'Stale pin', repoRoot: root, userPathOptions: harnessOpts });
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), 'removed-loadout\n');
  // drive should not throw due to stale pin – it is ignored
  const driven = runDrive({ run: created.runId, repoRoot: root, userPathOptions: harnessOpts });
  assert.ok(driven != null);
});

// --- 7. empty prompt guard ---------------------------------------------------

test('dispatch: an empty or whitespace-only prompt is refused before any invocation', (t) => {
  const root = seedProfile(t, {
    schema_version: 3,
    models: { probe: { provider: 'openai', id: 'probe' } },
    routes: v3RoutesFor(STDIN_ECHO('REPORT:')),
    archetypes: { worker: {} },
    dials: { worker: 'probe' },
  });

  for (const prompt of ['', '  \n\t \n']) {
    assert.throws(
      () => runDispatch({ archetype: 'worker', prompt, repoRoot: root, userPathOptions: harnessOpts }),
      (err: unknown) =>
        err instanceof DispatchCommandError && /empty prompt on stdin/.test(err.message),
    );
  }

  writeFileSync(join(root, 'blank.txt'), '   \n');
  assert.throws(
    () => runDispatch({ archetype: 'worker', promptFile: 'blank.txt', cwd: root, repoRoot: root, userPathOptions: harnessOpts }),
    /--prompt-file blank\.txt is empty — a dispatch needs a non-empty prompt/,
  );

  // Nothing was dispatched, so nothing was recorded.
  assert.deepEqual(evidenceRows(root), []);
});

test('cli: empty stdin is a clear dispatch error, not a silent empty dispatch', (t) => {
  const root = seedProfile(t, {
    schema_version: 3,
    models: { probe: { provider: 'openai', id: 'probe' } },
    routes: v3RoutesFor(STDIN_ECHO('REPORT:')),
    archetypes: { worker: {} },
    dials: { worker: 'probe' },
  });
  const result = cli(root, ['dispatch', '--archetype', 'worker'], '');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /empty prompt on stdin/);
  assert.deepEqual(evidenceRows(root), []);
});

// --- 8. evidence gitignore ---------------------------------------------------

test('init gitignores .fadeno/dispatches.jsonl beside progress/ and local/', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const gitignore = read(root, '.gitignore');
  assert.match(gitignore, /^\.fadeno\/dispatches\.jsonl$/m);
  assert.match(gitignore, /^\.fadeno\/progress\/$/m);
  assert.match(gitignore, /^\.fadeno\/local\/$/m);

  // Idempotent on re-init.
  runInit({ target: 'codex', repoRoot: root });
  assert.equal(read(root, '.gitignore'), gitignore);
});

test('a repo scaffolded before dispatch evidence existed gains only the missing entry', (t) => {
  const root = tempRepo(t);
  writeFileSync(
    join(root, '.gitignore'),
    '# Fadeno: local generated files (not committed)\n.fadeno/progress/\n.fadeno/local/\n',
  );
  runInit({ target: 'codex', repoRoot: root });
  const gitignore = read(root, '.gitignore');
  assert.match(gitignore, /^\.fadeno\/dispatches\.jsonl$/m);
  assert.equal(gitignore.match(/^\.fadeno\/progress\/$/gm)!.length, 1);
  assert.equal(gitignore.match(/^\.fadeno\/local\/$/gm)!.length, 1);
});

test('a repo already ignoring .fadeno/ entirely gets no dispatches entry', (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, '.gitignore'), '.fadeno/\n');
  runInit({ target: 'codex', repoRoot: root });
  assert.doesNotMatch(read(root, '.gitignore'), /dispatches\.jsonl/);
});

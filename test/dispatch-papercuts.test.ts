import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runLoadoutList, runLoadoutShow } from '../src/commands/loadout.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runSteeringResolve } from '../src/commands/steering.ts';
import { runValidate } from '../src/commands/validate.ts';
import { LOADOUT_LOCAL_FILE, parseExecutorProfile } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

/**
 * Dogfood papercut fixes for the loadout/dispatch kernel: scaffold
 * discoverability, echo-tag disambiguation, evidence completeness, failure
 * legibility, stale-pin tolerance, the empty-prompt guard, and the evidence
 * gitignore. All calls pass `env: null` (command level) or a scrubbed
 * environment (CLI level) so a real FADENO_LOADOUT never leaks in.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const EXECUTORS = {
  'echo-worker': { adapter: 'command', command: STDIN_ECHO('REPORT:'), model: 'opus' },
  'luna-worker': { adapter: 'command', command: STDIN_ECHO('LUNA:'), model: 'gpt-5.6-luna' },
  'fail-7': { adapter: 'command', command: ['node', '-e', 'process.exit(7)'] },
};

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
  const env = { ...process.env };
  delete env.FADENO_LOADOUT;
  const spawned = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: stdin ?? '',
    env,
  });
  return { status: spawned.status ?? 1, stdout: spawned.stdout, stderr: spawned.stderr };
}

// --- 1. scaffold discoverability -------------------------------------------

test('scaffold: executors.yaml carries the built-in safe catalog', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });

  const content = read(root, join('.fadeno', 'executors.yaml'));
  assert.match(content, /^loadouts:$/m);
  assert.match(content, /^default_loadout: native$/m);
  assert.match(content, /^  native:$/m);
  assert.match(content, /^  codex:$/m);
  assert.match(content, /^  luna:$/m);
  assert.match(content, /^  terra:$/m);
  assert.match(content, /^  sol:$/m);

  const asShipped = parseExecutorProfile(content, 'executors.yaml');
  assert.ok(asShipped.loadouts.native);
  assert.equal(asShipped.loadouts.sol?.worker, 'sol-high');
  const sol = asShipped.executors['sol-high'];
  assert.equal(sol?.adapter, 'command');
  assert.deepEqual(sol?.adapter === 'command' ? sol.command : null, [
    'codex', 'exec', '--model', 'gpt-5.6-sol', '--sandbox', 'workspace-write',
    '-c', 'model_reasoning_effort="high"', '-',
  ]);
  assert.equal(asShipped.bindings['*'], 'current-host');
  assert.ok(runValidate({ repoRoot: root }).ok);
});

test('built-in Codex model loadouts fall back immediately across native baselines', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const result = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    nativeExecutor: 'luna-medium',
    loadout: 'sol',
    env: null,
  });
  assert.equal(result.mode, 'command');
  assert.equal(result.executor, 'sol-high');
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.match(result.detail, /declared command fallback/);
});

// --- 2. help text -----------------------------------------------------------

test('help: FADENO_LOADOUT is discoverable in --help', (t) => {
  const root = tempRepo(t);
  const result = cli(root, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /FADENO_LOADOUT/);
  assert.match(result.stdout, /--loadout > run-persisted > FADENO_LOADOUT > \.fadeno\/local\/loadout > user state > default_loadout/);
});

// --- 3. echo-tag disambiguation ---------------------------------------------

test('echo: the "*" fallback tags as [fallback "*"] in new-run previews, never [default]', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({ executors: EXECUTORS, bindings: { '*': 'luna-worker' } }),
  );
  const created = runNewRun({ playbook: 'code-change-review', task: 'Echo tags', repoRoot: root, env: null });
  assert.ok(created.resolution);
  assert.ok(created.resolution.echo.length > 0);
  for (const line of created.resolution.echo) {
    assert.match(line, /\[fallback "\*"\]$/);
  }
  // The recorded source value is untouched — display-only rename.
  assert.ok(created.resolution.roles.every((r) => r.source === 'default'));
});

// --- 4. evidence completeness -----------------------------------------------

test('evidence: rows record the resolution path for all four ways of choosing an executor', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
    bindings: { implementer: 'luna-worker', '*': 'luna-worker' },
  });

  runDispatch({ archetype: 'worker', role: 'implementer', prompt: 'p', repoRoot: root, env: null });
  runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, env: null });
  runDispatch({ archetype: 'judge', prompt: 'p', repoRoot: root, env: null });
  runDispatch({ executor: 'echo-worker', prompt: 'p', repoRoot: root, env: null });

  const rows = evidenceRows(root);
  assert.deepEqual(
    rows.map((r) => [r.resolution, r.executor]),
    [
      ['binding', 'luna-worker'],
      ['loadout', 'echo-worker'],
      ['fallback', 'luna-worker'],
      ['executor-flag', 'echo-worker'],
    ],
  );
  // Role-pin and fallback rows still record the *active* loadout — the
  // resolution field is what disambiguates who supplied the executor.
  assert.deepEqual(rows[0]!.loadout, { name: 'main', source: 'default' });
  assert.deepEqual(rows[2]!.loadout, { name: 'main', source: 'default' });
  assert.equal(rows[3]!.loadout, null);
});

// --- 5. failure legibility ---------------------------------------------------

test('cli: a nonzero executor exit gets a stderr diagnosis line; stdout stays pure', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'fail-7' } },
    default_loadout: 'main',
  });
  const result = cli(root, ['dispatch', '--archetype', 'worker'], 'do the thing');
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /dispatch: executor fail-7 exited 7/);

  // A clean exit prints no such line.
  const ok = cli(root, ['dispatch', '--archetype', 'worker', '--executor', 'echo-worker'], 'p');
  assert.equal(ok.status, 0);
  assert.doesNotMatch(ok.stderr, /dispatch: executor/);
});

// --- 6. stale local pin ------------------------------------------------------

function seedStalePin(t: TestContext): string {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' }, alt: { worker: 'luna-worker' } },
    default_loadout: 'main',
  });
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, LOADOUT_LOCAL_FILE), 'removed-loadout\n');
  return root;
}

test('stale pin: loadout show/list still render, surface the pin, and fall back past it', (t) => {
  const root = seedStalePin(t);

  const shown = runLoadoutShow({ repoRoot: root, env: null });
  assert.equal(shown.stalePin, 'removed-loadout');
  assert.deepEqual(shown.active, { name: 'main', source: 'default' });
  assert.deepEqual(shown.available, ['alt', 'main']);

  const listed = runLoadoutList({ repoRoot: root, env: null });
  assert.equal(listed.stalePin, 'removed-loadout');
  assert.equal(listed.loadouts.length, 2);
  assert.deepEqual(listed.active, { name: 'main', source: 'default' });

  // An explicit flag/env still wins and still reports the stale pin.
  const flagged = runLoadoutShow({ repoRoot: root, env: null, loadout: 'alt' });
  assert.deepEqual(flagged.active, { name: 'alt', source: 'flag' });
  assert.equal(flagged.stalePin, 'removed-loadout');

  // A healthy pin is not stale.
  writeFileSync(join(root, LOADOUT_LOCAL_FILE), 'alt\n');
  const healthy = runLoadoutShow({ repoRoot: root, env: null });
  assert.equal(healthy.stalePin, null);
  assert.deepEqual(healthy.active, { name: 'alt', source: 'local' });
});

test('stale pin: the CLI renders the warning on stderr and exits 0 for show/list', (t) => {
  const root = seedStalePin(t);
  const result = cli(root, ['loadout', 'list']);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /pins "removed-loadout", which is no longer declared/);
  assert.match(result.stderr, /fadeno loadout clear/);
  assert.match(result.stdout, /main/); // the table still renders
});

test('stale pin: dispatch still fails hard, now naming the fix', (t) => {
  const root = seedStalePin(t);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, env: null }),
    (err: unknown) =>
      err instanceof DispatchCommandError &&
      /\.fadeno[\\/]local[\\/]loadout names loadout "removed-loadout", which is not declared/.test(err.message) &&
      /fadeno loadout clear/.test(err.message),
  );
  assert.deepEqual(evidenceRows(root), []);
});

test('stale pin: drive still fails hard, now naming the fix', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      executors: EXECUTORS,
      loadouts: { main: { worker: 'echo-worker' } },
      default_loadout: 'main',
    }),
  );
  const created = runNewRun({ playbook: 'code-change-review', task: 'Stale pin', repoRoot: root, env: null });
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, LOADOUT_LOCAL_FILE), 'removed-loadout\n');
  assert.throws(
    () => runDrive({ run: created.runId, repoRoot: root, env: null }),
    /names loadout "removed-loadout".*fadeno loadout clear/,
  );
});

// --- 7. empty prompt guard ---------------------------------------------------

test('dispatch: an empty or whitespace-only prompt is refused before any invocation', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });

  for (const prompt of ['', '  \n\t \n']) {
    assert.throws(
      () => runDispatch({ archetype: 'worker', prompt, repoRoot: root, env: null }),
      (err: unknown) =>
        err instanceof DispatchCommandError && /empty prompt on stdin/.test(err.message),
    );
  }

  writeFileSync(join(root, 'blank.txt'), '   \n');
  assert.throws(
    () => runDispatch({ archetype: 'worker', promptFile: 'blank.txt', cwd: root, repoRoot: root, env: null }),
    /--prompt-file blank\.txt is empty — a dispatch needs a non-empty prompt/,
  );

  // Nothing was dispatched, so nothing was recorded.
  assert.deepEqual(evidenceRows(root), []);
});

test('cli: empty stdin is a clear dispatch error, not a silent empty dispatch', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
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

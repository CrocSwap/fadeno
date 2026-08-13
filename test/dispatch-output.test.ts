import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { read, tempRepo } from './helpers.ts';

/**
 * Streamed output snapshots, workspace-change attestation, and user-pin
 * scoping for `fadeno dispatch`. Executors are `node -e` one-liners. All
 * calls pass `env: null` (or an explicit value) so a real FADENO_LOADOUT
 * never leaks in.
 */

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const MUTATE = [
  'node',
  '-e',
  "require('fs').writeFileSync('mutated.txt','x');process.stdout.write('MUTATED');",
];

const EXECUTORS = {
  'echo-worker': { adapter: 'command', command: STDIN_ECHO('REPORT:'), model: 'opus' },
  'luna-worker': { adapter: 'command', command: STDIN_ECHO('LUNA:'), model: 'gpt-5.6-luna' },
  'mutate-worker': { adapter: 'command', command: MUTATE, model: 'opus' },
  'ghost-bin': { adapter: 'command', command: ['no-such-fadeno-dispatch-bin'] },
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

function isolatedUser(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
    },
  };
}

function seedUserPin(paths: UserPathOptions, loadout: string, userDoc: Record<string, unknown>): void {
  const resolved = userPaths(paths);
  mkdirSync(resolved.configDir, { recursive: true });
  mkdirSync(resolved.stateDir, { recursive: true });
  writeFileSync(resolved.loadoutFile, `${loadout}\n`);
  writeFileSync(resolved.executorsFile, stringifyYaml(userDoc));
}

function initGit(root: string): void {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fadeno-test',
    GIT_AUTHOR_EMAIL: 'fadeno-test@invalid',
    GIT_COMMITTER_NAME: 'fadeno-test',
    GIT_COMMITTER_EMAIL: 'fadeno-test@invalid',
  };
  const run = (args: string[]): void => {
    const spawned = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (spawned.error != null || spawned.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${spawned.stderr || spawned.error?.message}`);
    }
  };
  run(['init']);
  run(['commit', '--allow-empty', '-m', 'init']);
}

test('dispatch output: snapshot file exists and row fields match the executor bytes', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, env: null });

  const [requested, completed] = evidenceRows(root) as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(requested.event, 'dispatch_requested');
  assert.equal(completed.event, 'dispatch_completed');
  assert.equal(typeof requested.output_snapshot, 'string');
  assert.equal(requested.output_snapshot, completed.output_snapshot);
  assert.match(requested.output_snapshot as string, /^\.fadeno\/local\/outputs\/worker-[0-9a-f]{8}\.md$/);
  assert.equal(read(root, requested.output_snapshot as string), 'REPORT:hello');
  assert.equal(read(root, requested.output_snapshot as string), result.stdout);
  assert.equal(completed.output_sha256, sha256Hex(read(root, requested.output_snapshot as string)));
  assert.equal(completed.output_sha256, result.outputSha256);
  assert.equal(completed.output_bytes, Buffer.byteLength('REPORT:hello'));
  assert.ok(!('output_bytes' in requested));

  writeFileSync(join(root, 'task.md'), 'from-a-file');
  const fromFile = runDispatch({
    archetype: 'worker',
    promptFile: 'task.md',
    cwd: root,
    repoRoot: root,
    env: null,
  });
  const fileRow = evidenceRows(root).at(-1)!;
  assert.equal(fileRow.prompt_source, 'file');
  assert.equal(typeof fileRow.output_snapshot, 'string');
  assert.match(fileRow.output_snapshot as string, /^\.fadeno\/local\/outputs\/worker-[0-9a-f]{8}\.md$/);
  assert.equal(read(root, fileRow.output_snapshot as string), 'REPORT:from-a-file');
  assert.equal(fileRow.output_sha256, sha256Hex('REPORT:from-a-file'));
  assert.equal(fileRow.output_bytes, Buffer.byteLength(fromFile.stdout));
});

test('dispatch output: request row names the snapshot even when spawn fails', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  assert.throws(
    () => runDispatch({ executor: 'ghost-bin', prompt: 'p', repoRoot: root, env: null }),
    (err: unknown) =>
      err instanceof DispatchCommandError && /executor "ghost-bin" failed to spawn/.test(err.message),
  );
  const rows = evidenceRows(root);
  const requested = rows.find((row) => row.event === 'dispatch_requested');
  const completed = rows.find((row) => row.event === 'dispatch_completed');
  assert.ok(requested);
  assert.equal(typeof requested.output_snapshot, 'string');
  assert.match(requested.output_snapshot as string, /^\.fadeno\/local\/outputs\/dispatch-[0-9a-f]{8}\.md$/);
  assert.ok(existsSync(join(root, requested.output_snapshot as string)));
  assert.equal(read(root, requested.output_snapshot as string), '');
  assert.ok(completed);
  assert.equal(completed.output_snapshot, requested.output_snapshot);
  assert.equal(completed.output_sha256, sha256Hex(''));
  assert.equal(completed.output_bytes, 0);
});

test('dispatch output: workspace_changed is true after a mutating executor', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'mutate-worker' } },
    default_loadout: 'main',
  });
  initGit(root);
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, env: null });
  assert.equal(result.stdout, 'MUTATED');
  assert.equal(read(root, 'mutated.txt'), 'x');
  const completed = evidenceRows(root).at(-1)!;
  assert.equal(completed.workspace_changed, true);
});

test('dispatch output: workspace_changed is false after a pure-echo executor', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root);
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, env: null });
  const completed = evidenceRows(root).at(-1)!;
  assert.equal(completed.workspace_changed, false);
});

test('dispatch output: workspace_changed is omitted outside a git repo', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, env: null });
  const [requested, completed] = evidenceRows(root) as [Record<string, unknown>, Record<string, unknown>];
  assert.ok(!('workspace_changed' in requested));
  assert.ok(!('workspace_changed' in completed));
});

test('dispatch output: a complete project profile ignores the user-level pin', (t) => {
  const root = seedProfile(t, {
    executors: {
      'echo-worker': { adapter: 'command', command: STDIN_ECHO('REPORT:'), model: 'opus', write_access: true },
      'luna-worker': { adapter: 'command', command: STDIN_ECHO('LUNA:'), model: 'gpt-5.6-luna', write_access: true },
    },
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  const paths = isolatedUser(root);
  seedUserPin(paths, 'user-fav', {
    executors: {
      'luna-worker': { adapter: 'command', command: STDIN_ECHO('LUNA:'), model: 'gpt-5.6-luna', write_access: true },
    },
    loadouts: { 'user-fav': { worker: 'luna-worker' } },
  });

  const result = runDispatch({
    archetype: 'worker',
    prompt: 'p',
    repoRoot: root,
    env: null,
    userPathOptions: paths,
  });
  assert.equal(result.executor, 'echo-worker');
  assert.deepEqual(result.loadout, { name: 'main', source: 'default' });
  assert.equal(result.stdout, 'REPORT:p');
});

test('dispatch output: an incomplete project profile consults the user-level pin', (t) => {
  const root = seedProfile(t, {
    executors: {
      'echo-worker': { adapter: 'command', command: STDIN_ECHO('REPORT:'), model: 'opus', write_access: true },
    },
  });
  const paths = isolatedUser(root);
  seedUserPin(paths, 'user-fav', {
    executors: {
      'luna-worker': { adapter: 'command', command: STDIN_ECHO('LUNA:'), model: 'gpt-5.6-luna', write_access: true },
    },
    loadouts: { 'user-fav': { worker: 'luna-worker' } },
  });

  const result = runDispatch({
    archetype: 'worker',
    prompt: 'p',
    repoRoot: root,
    env: null,
    userPathOptions: paths,
  });
  assert.equal(result.executor, 'luna-worker');
  assert.deepEqual(result.loadout, { name: 'user-fav', source: 'user' });
  assert.equal(result.stdout, 'LUNA:p');
});

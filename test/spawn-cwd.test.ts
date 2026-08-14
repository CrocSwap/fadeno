import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import { atCwd } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

/**
 * `spawnSync({ cwd })` chdirs the child but leaves the inherited `PWD` alone,
 * and a shell always rewrites it. A tool that resolves its project from `$PWD`
 * therefore operates on the *parent's* directory. Verified 2026-08-14 with
 * OpenCode: a shadow spawned into its isolated worktree edited the real
 * workspace, while the untouched worktree produced `diff_bytes: 0` — the
 * damage landed on the tree shadow exists to protect and the ledger recorded
 * nothing.
 */

function gitRepo(t: TestContext): string {
  const root = tempRepo(t);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  };
  try {
    git('init', '-q', '.');
  } catch { /* helpers may already init */ }
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'seed');
  return root;
}

test('atCwd points PWD at the directory the child actually starts in', () => {
  const env = atCwd({ PWD: '/somewhere/else', KEEP: 'yes' }, '/target');
  assert.equal(env.PWD, '/target');
  assert.equal(env.KEEP, 'yes', 'atCwd must not drop the rest of the environment');
});

test('a shadow sees PWD inside its worktree, not the workspace it must not touch', (t) => {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  // The shadow reports the two directories it could believe it is in. A tool
  // trusting $PWD must land in the worktree like one calling getcwd().
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 2,
      targets: { noop: { provider: 'noop', model: 'noop' }, probe: { provider: 'probe', model: 'probe' } },
      routes: {
        claude: {
          ['noop']: { command: ['node', '-e', "process.stdout.write('primary')"], write_access: true },
          probe: {
            command: ['node', '-e', 'process.stdout.write(JSON.stringify({pwd:process.env.PWD,cwd:process.cwd()}))'],
            write_access: true,
          },
        },
      },
      loadouts: { main: { worker: 'noop' } },
      default_loadout: 'main',
    }),
  );

  runDispatch({
    archetype: 'worker',
    prompt: 'x',
    repoRoot: root,
    env: null,
    shadow: 'probe',
    userPathOptions: { env: { FADENO_HARNESS: 'claude' } },
  });

  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const shadowDone = rows.find((row) => row.shadow === true && row.event === 'dispatch_completed');
  assert.ok(shadowDone, 'no shadow completion row');

  const snapshot = join(root, String(shadowDone.output_snapshot));
  const reported = JSON.parse(readFileSync(snapshot, 'utf8')) as { pwd: string; cwd: string };
  assert.match(reported.cwd, /[/\\]\.fadeno[/\\]local[/\\]shadow[/\\]/, 'shadow did not run in its worktree');
  assert.match(reported.pwd, /[/\\]\.fadeno[/\\]local[/\\]shadow[/\\]/, 'PWD pointed outside the shadow worktree');
  // Compare tails, not whole paths: process.cwd() resolves symlinks
  // (/var → /private/var on macOS) while PWD keeps the logical spelling, and
  // the worktree is already removed by the time this assertion runs.
  const tail = (path: string): string => path.split(/[/\\]/).slice(-3).join('/');
  assert.equal(tail(reported.pwd), tail(reported.cwd));
});

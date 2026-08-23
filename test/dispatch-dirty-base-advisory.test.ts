import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// The dirty-base advisory. A dispatched worker whose task builds on the
// caller's uncommitted work needs everyone to know that an isolated worktree
// does not give it live-tree semantics — the base is HEAD plus a replay of
// the dirty state as one synthetic commit. Advisory only, isolated spawns
// only; --shared IS the live tree, so there is nothing to tell there.

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

function seedV3(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { worker: { provider: 'openai', id: 'worker-1' } },
    routes: {
      standalone: { openai: { command: ['node', '-e', "process.stdout.write('done')"] } },
      codex: { openai: { command: ['node', '-e', "process.stdout.write('done')"] } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'worker' },
  }));
  return root;
}

function initGitWithCommit(root: string): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  const run = (args: string[]): void => {
    const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  run(['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-m', 'init']);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env });
  return String(head.stdout ?? '').trim();
}

test('isolated dispatch on a dirty tree emits the loud dirty-base advisory', (t) => {
  const root = seedV3(t);
  const head = initGitWithCommit(root);
  // Tracked modification + a staged file = 2 uncommitted tracked entries.
  writeFileSync(join(root, 'base.txt'), 'dirty\n');
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  spawnSync('git', ['add', 'staged.txt'], { cwd: root });

  const echoes: string[] = [];
  const result = runDispatch({
    archetype: 'worker', prompt: 'p', repoRoot: root,
    userPathOptions: onHarness('standalone'), onEcho: (line) => echoes.push(line),
  });
  assert.equal(result.outcome, 'ok');
  const advisory = echoes.find((l) => l.startsWith('advisory: cutting the worktree from HEAD'));
  assert.ok(advisory, `expected an advisory among: ${echoes.join(' | ')}`);
  assert.match(advisory!, new RegExp(head.slice(0, 12)));
  assert.match(advisory!, /2 uncommitted change\(s\)/);
  assert.match(advisory!, /--shared/);
});

test('the advisory is absent when the tree is clean or the dispatch is --shared', (t) => {
  {
    // Clean tree, kernel-isolated: nothing to warn about.
    const root = seedV3(t);
    initGitWithCommit(root);
    const echoes: string[] = [];
    runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone'), onEcho: (l) => echoes.push(l) });
    assert.equal(echoes.find((l) => l.startsWith('advisory:')), undefined, echoes.join(' | '));
  }
  {
    // Dirty tree but --shared: the executor runs ON the live tree.
    const root = seedV3(t);
    initGitWithCommit(root);
    writeFileSync(join(root, 'base.txt'), 'dirty\n');
    const echoes: string[] = [];
    runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, shared: true, userPathOptions: onHarness('standalone'), onEcho: (l) => echoes.push(l) });
    assert.equal(echoes.find((l) => l.startsWith('advisory:')), undefined, echoes.join(' | '));
  }
});

test('untracked files alone do not fire the advisory', (t) => {
  // Untracked scratch is carried into the baseline like everything else and
  // would nag on nearly every active repo; only tracked work counts (see
  // `uncommittedTrackedChanges`).
  const root = seedV3(t);
  initGitWithCommit(root);
  writeFileSync(join(root, 'scratch.md'), 'untracked\n');
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone'), onEcho: (l) => echoes.push(l) });
  assert.equal(result.outcome, 'ok');
  assert.equal(echoes.find((l) => l.startsWith('advisory:')), undefined, echoes.join(' | '));
});

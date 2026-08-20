import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runSteeringApplyClaude } from '../src/commands/steering.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

function seed(t: TestContext, dials: Record<string, string>): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      luna: { provider: 'openai', id: 'gpt-5.6-luna', effort: 'xhigh' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'xhigh' },
      fable: { provider: 'anthropic', id: 'fable', effort: 'high' },
    },
    routes: {
      claude: {
        'current-host': { host: true },
        anthropic: { driver: 'claude-cli', host: true, command: ['claude', '-p', '--model', '{model}'], write_access: false },
        openai: { driver: 'codex', command: ['codex', 'exec', '--model', '{model}', '-'], write_access: true },
      },
    },
    archetypes: { worker: {}, reviewer: {}, judge: {} },
    dials,
  }));
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'claude',
    },
  };
  return { root, user };
}

test('steering apply --claude pre-registers an identity grid instead of per-dial agents', (t) => {
  // Doug's example, mirrored: session on one model, worker dialed to another
  // in-session model. The worker's OWN effort still wins over the session's —
  // but it now comes from a pre-registered cell rather than a file cut for
  // this dial, which is what makes the next re-dial free.
  const { root, user } = seed(t, { worker: 'fable', reviewer: 'luna', judge: 'current-host' });
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });

  const cellPath = join(root, '.claude', 'agents', 'fadeno-worker-high.md');
  const cell = readFileSync(cellPath, 'utf8');
  assert.match(cell, /^---\n[\s\S]*?\nname: fadeno-worker-high\nmodel: inherit\neffort: high\n---\n/);
  assert.match(cell, /source=grid:worker@high -->/);
  // The role body survives the frontmatter injection, exactly as before.
  assert.match(cell, /implementer/);

  // Every archetype x effort cell, and nothing keyed on a model.
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.ok(existsSync(join(root, '.claude', 'agents', `fadeno-${archetype}-${effort}.md`)), `${archetype}@${effort} missing`);
    }
    assert.equal(existsSync(join(root, '.claude', 'agents', `${archetype}.md`)), false);
  }
  assert.equal(result.grid?.length, 15);

  // Resolution reporting is unchanged; it just no longer drives emission.
  assert.equal(result.materialization.reviewer!.kind, 'command-broker');
  assert.equal(result.materialization.judge!.kind, 'host');
  assert.equal(result.restartRequired, true); // first apply registers new names
});

test('re-dialing needs no apply and no restart: the grid does not depend on dials', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  const first = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.equal(first.restartRequired, true);

  // Move the worker to a different model at a different effort, and to the
  // command lane — the three shapes that each used to rewrite a file.
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ dials: { worker: 'luna' } }));
  const second = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });

  // This is the whole point of the grid: ending a session is expensive, and a
  // dial change is not a grid change.
  assert.equal(second.restartRequired, false);
  assert.deepEqual(second.results.filter((r) => r.status !== 'skipped'), []);
  assert.deepEqual(second.removed, []);
});

test('steering apply --claude removes a legacy per-dial managed agent but never an unmanaged one', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  const workerPath = join(root, '.claude', 'agents', 'worker.md');
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  // What a pre-grid install left behind: a file pinning whatever was dialed
  // the day it was written. The hook must never target that identity again.
  writeFileSync(workerPath, '---\nname: worker\nmodel: fable\neffort: high\n---\nbody\n\n<!-- fadeno:managed version=0.0.0 digest=x source=fable -->\n');
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.equal(existsSync(workerPath), false);
  assert.deepEqual(result.removed, [workerPath]);

  // A hand-written file of the same name is not ours and is left alone.
  writeFileSync(workerPath, '---\nname: worker\n---\nhand-written\n');
  const again = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.equal(readFileSync(workerPath, 'utf8'), '---\nname: worker\n---\nhand-written\n');
  assert.deepEqual(again.removed, []);
});

test('steering apply --claude: an unmanaged existing file is preserved without --force at project scope', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  const cellPath = join(root, '.claude', 'agents', 'fadeno-worker-high.md');
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(cellPath, '---\nname: fadeno-worker-high\n---\nprecious\n');
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.equal(readFileSync(cellPath, 'utf8'), '---\nname: fadeno-worker-high\n---\nprecious\n');
  assert.ok(result.conflicts.includes(cellPath));

  const forced = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user, force: true });
  assert.match(readFileSync(cellPath, 'utf8'), /model: inherit/);
  assert.equal(forced.conflicts.length, 0);
});

test('a managed grid cell refreshes itself; only someone else\'s file needs --force', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  const cellPath = join(root, '.claude', 'agents', 'fadeno-worker-high.md');

  // A cell left behind by an older template or version must not serve that
  // content forever — the grid is regenerated output, and `--force` is for
  // files that are not ours.
  writeFileSync(cellPath, '---\nname: fadeno-worker-high\nmodel: inherit\neffort: high\n---\nSTALE\n\n<!-- fadeno:managed version=0.0.1 digest=old source=grid:worker@high -->\n');
  const refreshed = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.doesNotMatch(readFileSync(cellPath, 'utf8'), /STALE/);
  assert.equal(refreshed.restartRequired, true);
  assert.deepEqual(refreshed.conflicts, []);

  // And a steady-state apply reports no conflicts at all, so it never tells
  // the user to pass --force for files it is perfectly happy with.
  const steady = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.deepEqual(steady.conflicts, []);
  assert.equal(steady.restartRequired, false);
});

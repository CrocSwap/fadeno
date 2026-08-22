import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
        anthropic: { driver: 'claude', host: true, command: ['claude', '-p', '--model', '{model}'], },
        openai: { driver: 'codex', command: ['codex', 'exec', '--model', '{model}', '-'], },
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

/** One cell as `steering apply --claude` used to write it, marker and all. */
function gridCell(archetype: string, effort: string): string {
  return [
    '---',
    `name: fadeno-${archetype}-${effort}`,
    'description: Grid cell.',
    'model: inherit',
    `effort: ${effort}`,
    '---',
    '',
    'Body.',
    '',
    `<!-- fadeno:managed version=0.6.0-rc.34 digest=deadbeef source=grid:${archetype}@${effort} -->`,
    '',
  ].join('\n');
}

test('steering apply --claude writes nothing at all: effort decides the lane, so no file pins one', (t) => {
  const { root, user } = seed(t, { worker: 'fable', reviewer: 'luna', judge: 'current-host' });
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });

  // The whole grid is gone, and so is the per-dial file it replaced. A host
  // spawn runs at the session's effort; a pinned effort the session cannot
  // give goes out on the command lane instead. Neither needs a definition.
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.removed, []);
  assert.equal(existsSync(join(root, '.claude', 'agents')), false);

  // Resolution reporting is unchanged; it just no longer drives emission.
  assert.equal(result.materialization.reviewer!.kind, 'command-broker');
  assert.equal(result.materialization.judge!.kind, 'host');
  assert.equal(result.materialization.worker!.kind, 'host');
  assert.equal(result.baseline.worker, 'fable');

  // Nothing was registered, so nothing has to be registered again. Restart
  // reason 1 (a new effort value entering the vocabulary) retired with the
  // grid; the two that survive are not something this command can cause.
  assert.equal(result.restartRequired, false);
  assert.deepEqual(result.conflicts, []);
});

test('steering apply --claude removes the retired identity grid, found by marker not by name', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    for (const archetype of ['worker', 'reviewer', 'judge']) {
      writeFileSync(join(dir, `fadeno-${archetype}-${effort}.md`), gridCell(archetype, effort));
    }
  }
  // A cell for an archetype and an effort level this build knows nothing
  // about. The marker is the identity, so it goes with the rest.
  writeFileSync(join(dir, 'fadeno-scribe-glacial.md'), gridCell('scribe', 'glacial'));

  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });

  assert.equal(result.removed?.length, 16);
  assert.deepEqual(readdirSync(dir), []);
  // Removal alone is not a restart: the plain role agents that take over are
  // always registered, and a deleted cell simply stops being targeted.
  assert.equal(result.restartRequired, false);

  // And a second apply is a clean no-op rather than a repeated claim.
  const again = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.deepEqual(again.removed, []);
});

test('steering apply --claude never touches a file lacking the managed marker, grid-named or not', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });

  // Two traps, both hand-authored: one wearing a grid cell's exact name, one
  // wearing a legacy per-dial agent's. Names are not ownership; the marker is.
  const impostorCell = '---\nname: fadeno-worker-high\nmodel: inherit\neffort: high\n---\nprecious\n';
  const impostorLegacy = '---\nname: worker\n---\nhand-written\n';
  writeFileSync(join(dir, 'fadeno-worker-high.md'), impostorCell);
  writeFileSync(join(dir, 'worker.md'), impostorLegacy);

  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.deepEqual(result.removed, []);
  assert.equal(readFileSync(join(dir, 'fadeno-worker-high.md'), 'utf8'), impostorCell);
  assert.equal(readFileSync(join(dir, 'worker.md'), 'utf8'), impostorLegacy);

  // `--force` is for overwriting someone else's file with ours. There is no
  // "ours" left on this surface, so it must not become a licence to delete.
  const forced = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user, force: true });
  assert.deepEqual(forced.removed, []);
  assert.equal(readFileSync(join(dir, 'fadeno-worker-high.md'), 'utf8'), impostorCell);
  assert.equal(readFileSync(join(dir, 'worker.md'), 'utf8'), impostorLegacy);
});

test('steering apply --claude still removes a legacy per-dial managed agent, on every slot kind', (t) => {
  // `reviewer` is command-delivered here, `judge` is the bare session
  // baseline, `worker` is a dialed host identity — the three shapes that used
  // to take three different branches. All three now end the same way.
  const { root, user } = seed(t, { worker: 'fable', reviewer: 'luna', judge: 'current-host' });
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    writeFileSync(
      join(dir, `${archetype}.md`),
      `---\nname: ${archetype}\nmodel: fable\neffort: high\n---\nbody\n\n<!-- fadeno:managed version=0.0.0 digest=x source=fable -->\n`,
    );
  }
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.deepEqual(
    result.removed?.slice().sort(),
    ['judge', 'reviewer', 'worker'].map((archetype) => join(dir, `${archetype}.md`)),
  );
});

test('steering apply --claude at user scope cleans the user agent directory, not the repo', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  const userDir = join(root, 'home', '.claude', 'agents');
  const projectDir = join(root, '.claude', 'agents');
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(userDir, 'fadeno-worker-high.md'), gridCell('worker', 'high'));
  writeFileSync(join(projectDir, 'fadeno-worker-high.md'), gridCell('worker', 'high'));

  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user, scope: 'user' });
  assert.deepEqual(result.removed, [join(userDir, 'fadeno-worker-high.md')]);
  assert.equal(existsSync(join(projectDir, 'fadeno-worker-high.md')), true);
});

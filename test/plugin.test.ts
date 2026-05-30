import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runPlugin } from '../src/commands/plugin.ts';
import { exists, tempRepo } from './helpers.ts';

test('plugin generates manifest, namespaced skills, and subagents', (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });

  // manifest
  assert.ok(exists(outDir, '.claude-plugin/plugin.json'));
  const manifest = JSON.parse(readFileSync(join(outDir, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'fadeno');
  assert.equal(typeof manifest.version, 'string');

  // skills use short dir names → /fadeno:runner, /fadeno:builder
  assert.ok(exists(outDir, 'skills/runner/SKILL.md'));
  assert.ok(exists(outDir, 'skills/runner/references/runtime.md'));
  assert.ok(exists(outDir, 'skills/builder/SKILL.md'));

  const runner = readFileSync(join(outDir, 'skills/runner/SKILL.md'), 'utf8');
  const builder = readFileSync(join(outDir, 'skills/builder/SKILL.md'), 'utf8');
  assert.match(runner, /^name: runner$/m);
  assert.doesNotMatch(runner, /disable-model-invocation/);
  assert.match(builder, /^name: builder$/m);
  assert.match(builder, /^disable-model-invocation: true$/m);

  // subagents
  assert.ok(exists(outDir, 'agents/fadeno-worker.md'));
  assert.ok(exists(outDir, 'agents/fadeno-reviewer.md'));
  assert.ok(exists(outDir, 'agents/fadeno-judge.md'));

  // the plugin carries no per-repo definitions
  assert.ok(!exists(outDir, 'skills/runner/playbooks'));
});

test('the committed plugin/ matches a fresh generation (no drift)', (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });
  const fresh = readFileSync(join(outDir, 'skills/builder/SKILL.md'), 'utf8');
  // Compare against the committed copy in the repo (run `npm run build:plugin` if this fails).
  const committed = readFileSync(
    join(import.meta.dirname, '..', 'plugin', 'skills', 'builder', 'SKILL.md'),
    'utf8',
  );
  assert.equal(fresh, committed);
});

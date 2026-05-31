import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  // Builder stays model-invocable — a builder gated with disable-model-invocation
  // was uninvocable (plugin skills aren't reliably slash-invocable).
  assert.doesNotMatch(builder, /disable-model-invocation/);

  // slash-command entry points → /fadeno:runner, /fadeno:builder
  assert.ok(exists(outDir, 'commands/runner.md'));
  assert.ok(exists(outDir, 'commands/builder.md'));

  // subagents — namespaced as fadeno:worker / :reviewer / :judge
  assert.ok(exists(outDir, 'agents/worker.md'));
  assert.ok(exists(outDir, 'agents/reviewer.md'));
  assert.ok(exists(outDir, 'agents/judge.md'));

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

test('the committed plugin ships a self-contained CJS binary + templates', () => {
  const binDir = join(import.meta.dirname, '..', 'plugin', 'bin');
  const bin = join(binDir, 'fadeno');
  assert.ok(existsSync(bin), 'plugin/bin/fadeno missing — run `npm run build:bin`');
  assert.ok(statSync(bin).mode & 0o111, 'plugin/bin/fadeno is not executable');
  assert.match(readFileSync(bin, 'utf8').split('\n', 1)[0]!, /^#!\/usr\/bin\/env node/);
  // Pinned to CommonJS so the extensionless bundle runs under a type:module ancestor.
  const pkg = JSON.parse(readFileSync(join(binDir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'commonjs');
  // Templates travel with the binary so `fadeno init` works with no node_modules.
  assert.ok(existsSync(join(binDir, 'templates', 'common', 'fadeno', 'vocabulary.md')));
});


import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { runPlugin } from '../src/commands/plugin.ts';
import { exists, read, tempRepo } from './helpers.ts';

/** Every file under `dir`, as paths relative to it (recursive). */
function listFilesRel(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRel(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

test('plugin generates manifest, namespaced skills, and subagents', (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });

  // manifest
  assert.ok(exists(outDir, '.claude-plugin/plugin.json'));
  const manifest = JSON.parse(readFileSync(join(outDir, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'fadeno');
  assert.equal(typeof manifest.version, 'string');

  // skills use short dir names → /fadeno:runner, /fadeno:builder, /fadeno:driver
  assert.ok(exists(outDir, 'skills/runner/SKILL.md'));
  assert.ok(exists(outDir, 'skills/runner/references/runtime.md'));
  assert.ok(exists(outDir, 'skills/builder/SKILL.md'));
  assert.ok(exists(outDir, 'skills/driver/SKILL.md'));

  const runner = readFileSync(join(outDir, 'skills/runner/SKILL.md'), 'utf8');
  const builder = readFileSync(join(outDir, 'skills/builder/SKILL.md'), 'utf8');
  const driver = readFileSync(join(outDir, 'skills/driver/SKILL.md'), 'utf8');
  assert.match(runner, /^name: runner$/m);
  assert.doesNotMatch(runner, /disable-model-invocation/);
  assert.match(builder, /^name: builder$/m);
  // Builder stays model-invocable — a builder gated with disable-model-invocation
  // was uninvocable (plugin skills aren't reliably slash-invocable).
  assert.doesNotMatch(builder, /disable-model-invocation/);
  assert.match(driver, /^name: driver$/m);
  assert.match(driver, /fadeno next/);

  // slash-command entry points → /fadeno:runner, /fadeno:builder, /fadeno:driver
  assert.ok(exists(outDir, 'commands/runner.md'));
  assert.ok(exists(outDir, 'commands/builder.md'));
  assert.ok(exists(outDir, 'commands/driver.md'));

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
  const committedDir = join(import.meta.dirname, '..', 'plugin');

  // `runPlugin` emits the whole plugin surface EXCEPT bin/ (the esbuild bundle +
  // its bundled templates), which `npm run build:bin` produces — so diff
  // everything else, in both directions, file by file.
  const generated = listFilesRel(outDir).sort();
  const committed = listFilesRel(committedDir)
    .filter((f) => !f.startsWith(`bin${sep}`))
    .sort();

  // Same file set: catches an added/removed/renamed template, not just edits.
  assert.deepEqual(
    committed,
    generated,
    'plugin/ file set differs from a fresh generation — run `npm run build:plugin`',
  );
  // Same contents.
  for (const rel of generated) {
    assert.equal(
      read(committedDir, rel),
      read(outDir, rel),
      `plugin/${rel} is stale — run \`npm run build:plugin\``,
    );
  }
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
  // The bundle bakes in the version (esbuild --define); executing it must report
  // the current package.json version — catches a forgotten `npm run build:bin`
  // after a bump (the marketplace cache is version-keyed, so a stale bin ships).
  const version = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ).version;
  const reported = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(reported, version, 'plugin/bin/fadeno is stale — run `npm run build:bin`');
  // Templates travel with the binary so `fadeno init` works with no node_modules.
  assert.ok(existsSync(join(binDir, 'templates', 'common', 'fadeno', 'vocabulary.md')));
});


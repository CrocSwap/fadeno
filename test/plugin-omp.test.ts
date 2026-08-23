import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import test from 'node:test';
import { runOmpPlugin } from '../src/commands/plugin.ts';
import { exists, read, tempRepo } from './helpers.ts';

const REPO = join(import.meta.dirname, '..');
// `fadeno-setup` is deliberately absent: `<cli> setup` supports only
// --codex/--claude, and that skill teaches using only the current host's line.
const SKILLS = ['fadeno-runner', 'fadeno-builder', 'fadeno-driver', 'fadeno-bakeoff'] as const;
const AGENTS = [
  'worker.md',
  'reviewer.md',
  'judge.md',
  'dispatch-worker.md',
  'dispatch-reviewer.md',
  'dispatch-judge.md',
  'dispatch-director.md',
] as const;

// Same escape hatch as test/plugin.test.ts: `FADENO_SKIP_DRIFT=1` skips only the
// committed-vs-fresh comparison so a work-in-progress template edit doesn't block
// the rest of the suite. Unset (or empty) → unchanged behavior.
const SKIP_DRIFT: string | false = process.env.FADENO_SKIP_DRIFT
  ? 'FADENO_SKIP_DRIFT set — drift unchecked, rebuild plugins and rerun before integration'
  : false;

function listFilesRel(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRel(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

test('omp plugin: package.json manifest is loadable with a single-sourced version', (t) => {
  const root = tempRepo(t);
  const { outDir } = runOmpPlugin({ cwd: root, outDir: join(root, 'plugin-omp') });

  // The `omp` key is what runtime plugin discovery requires before a package
  // counts as loadable; without it an npm/link install is skipped wholesale.
  const manifest = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'fadeno');
  assert.deepEqual(manifest.omp, { extensions: ['./extensions/fadeno-steering.ts'] });
  const pkgVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
  assert.equal(manifest.version, pkgVersion);
});

test('omp plugin: skills are full-named shared bodies with per-skill launchers', (t) => {
  const root = tempRepo(t);
  const { outDir } = runOmpPlugin({ cwd: root, outDir: join(root, 'plugin-omp') });

  for (const skill of SKILLS) {
    // Byte-identical to the single-source template shared with the Claude and
    // Codex plugins + init (the Codex convention: no surface-version stamps —
    // omp keys plugin upgrades off the manifest version).
    assert.equal(
      read(outDir, `skills/${skill}/SKILL.md`),
      readFileSync(join(REPO, 'templates', 'common', 'skills', skill, 'SKILL.md'), 'utf8'),
      `${skill}/SKILL.md drifted from templates/common`,
    );
    const launcher = join(outDir, 'skills', skill, 'scripts', 'fadeno.cjs');
    assert.ok(exists(outDir, `skills/${skill}/scripts/fadeno.cjs`), `${skill} must carry its private CLI launcher`);
    assert.notEqual(statSync(launcher).mode & 0o111, 0, `${skill} CLI launcher must be executable`);
    // The launcher pins the omp harness identity for route compilation.
    assert.match(readFileSync(launcher, 'utf8'), /FADENO_HARNESS: 'omp'/);
  }

  // References carry over; bakeoff has none (guarded in the generator).
  assert.ok(exists(outDir, 'skills/fadeno-runner/references/runtime.md'));
  assert.ok(exists(outDir, 'skills/fadeno-driver/references/README.md'));
  assert.ok(!exists(outDir, 'skills/fadeno-bakeoff/references'));

  // No commands/: omp registers /skill:<name> natively for every skill.
  assert.ok(!exists(outDir, 'commands'));
});

test('omp plugin: agents satisfy the task-agent contract', (t) => {
  const root = tempRepo(t);
  const { outDir } = runOmpPlugin({ cwd: root, outDir: join(root, 'plugin-omp') });

  for (const file of AGENTS) {
    const md = readFileSync(join(REPO, 'templates', 'omp', 'omp-agents', file), 'utf8');
    // omp parse contract: missing name or description invalidates the agent.
    assert.match(md, /^---\nname: /, `${file} must open with a name field`);
    assert.match(md, /^description: .+/m, `${file} must carry a description`);
  }
  for (const proxy of ['dispatch-worker.md', 'dispatch-reviewer.md', 'dispatch-judge.md', 'dispatch-director.md']) {
    const md = readFileSync(join(REPO, 'templates', 'omp', 'omp-agents', proxy), 'utf8');
    // Proxies are bash-only relays; no Claude-specific surface may leak in.
    assert.match(md, /^tools: bash$/m, `${proxy} must restrict itself to bash`);
    assert.doesNotMatch(md, /^model: /m, `${proxy} must not pin a host model`);
    assert.doesNotMatch(md, /CLAUDE_PLUGIN_ROOT|PreToolUse/, `${proxy} must not reference Claude-only machinery`);
  }
  for (const file of AGENTS) {
    assert.equal(
      read(outDir, `agents/${file}`),
      readFileSync(join(REPO, 'templates', 'omp', 'omp-agents', file), 'utf8'),
      `agents/${file} drifted from templates/omp`,
    );
  }
});

test('omp plugin: bundles a self-contained CLI and no hooks', (t) => {
  const root = tempRepo(t);
  const { outDir } = runOmpPlugin({ cwd: root, outDir: join(root, 'plugin-omp') });

  assert.ok(!exists(outDir, 'hooks'), 'steering has no omp implementation yet — no hooks may ship');
  assert.ok(exists(outDir, 'bin/fadeno'), 'omp plugin must bundle a binary');
  assert.ok(exists(outDir, 'bin/templates/common/fadeno/playbooks/code-change-review.yaml'));
  const binary = join(outDir, 'bin', 'fadeno');
  assert.notEqual(statSync(binary).mode & 0o111, 0, 'generated omp plugin CLI must be executable');
  const expectedVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
  assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), expectedVersion);
});

test('the committed plugin-omp/ matches a fresh generation (no drift)', { skip: SKIP_DRIFT }, (t) => {
  const root = tempRepo(t);
  const { outDir } = runOmpPlugin({ cwd: root, outDir: join(root, 'plugin-omp') });
  const committedDir = join(REPO, 'plugin-omp');

  const generated = listFilesRel(outDir).sort();
  const committed = listFilesRel(committedDir).sort();
  assert.deepEqual(
    committed,
    generated,
    'plugin-omp/ file set differs from a fresh generation — run `npm run build:plugin:omp`',
  );
  for (const rel of generated) {
    assert.equal(
      read(committedDir, rel),
      read(outDir, rel),
      `plugin-omp/${rel} is stale — run \`npm run build:plugin:omp\``,
    );
  }
});

test('the committed omp marketplace.json points at the plugin', () => {
  const mkt = JSON.parse(readFileSync(join(REPO, '.omp-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(mkt.name, 'fadeno');
  const entry = mkt.plugins.find((p: { name: string }) => p.name === 'fadeno');
  assert.ok(entry, '.omp-plugin/marketplace.json must list the fadeno plugin');
  // Path is relative to the marketplace ROOT (repo root).
  assert.equal(entry.source, './plugin-omp');
});

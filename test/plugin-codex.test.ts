import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { runCodexPlugin } from '../src/commands/plugin.ts';
import { exists, read, tempRepo } from './helpers.ts';

const REPO = join(import.meta.dirname, '..');
const SKILLS = ['fadeno-runner', 'fadeno-builder', 'fadeno-driver'] as const;

function listFilesRel(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRel(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

test('codex plugin: manifest is spec-minimal with a single-sourced version', (t) => {
  const root = tempRepo(t);
  const { outDir } = runCodexPlugin({ cwd: root, outDir: join(root, 'plugin-codex') });

  assert.ok(exists(outDir, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(readFileSync(join(outDir, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'fadeno');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.interface.displayName, 'Fadeno');
  // "Engineering" is a capitalized marketplace category — confirmed accepted by
  // `codex plugin add` (the docs' free-text "code review and security" was wrong).
  assert.equal(manifest.interface.category, 'Engineering');

  // Version is single-sourced from package.json (like the Claude manifest), so the
  // no-drift guard keeps a bumped bundle from shipping stale.
  const pkgVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
  assert.equal(manifest.version, pkgVersion);
});

test('codex plugin: skills are the shared bodies + in-plugin invocation policy', (t) => {
  const root = tempRepo(t);
  const { outDir } = runCodexPlugin({ cwd: root, outDir: join(root, 'plugin-codex') });

  for (const skill of SKILLS) {
    // SKILL.md keeps its full `fadeno-` name (Codex invokes $fadeno-runner) and is
    // byte-identical to the single-source template shared with the Claude plugin + init.
    assert.equal(
      read(outDir, `skills/${skill}/SKILL.md`),
      readFileSync(join(REPO, 'templates', 'common', 'skills', skill, 'SKILL.md'), 'utf8'),
      `${skill}/SKILL.md drifted from templates/common`,
    );
    // The per-skill openai.yaml policy travels IN the plugin (validated: it survives
    // `codex plugin add`), byte-identical to what `fadeno init --codex` installs.
    assert.equal(
      read(outDir, `skills/${skill}/agents/openai.yaml`),
      readFileSync(join(REPO, 'templates', 'codex', 'openai', `${skill}.yaml`), 'utf8'),
      `${skill}/agents/openai.yaml drifted from templates/codex/openai`,
    );
  }

  // Policy correctness: runner fires implicitly; builder/driver are explicit-only.
  assert.match(read(outDir, 'skills/fadeno-runner/agents/openai.yaml'), /allow_implicit_invocation:\s*true/);
  assert.match(read(outDir, 'skills/fadeno-builder/agents/openai.yaml'), /allow_implicit_invocation:\s*false/);
  assert.match(read(outDir, 'skills/fadeno-driver/agents/openai.yaml'), /allow_implicit_invocation:\s*false/);

  // References carry over; the driver reference exists.
  assert.ok(exists(outDir, 'skills/fadeno-runner/references/runtime.md'));
  assert.ok(exists(outDir, 'skills/fadeno-driver/references/README.md'));
});

test('codex plugin: carries no subagents, commands, or bundled binary', (t) => {
  const root = tempRepo(t);
  const { outDir } = runCodexPlugin({ cwd: root, outDir: join(root, 'plugin-codex') });

  // Codex plugins have no manifest slot for these — subagents come from
  // `fadeno init --codex` (.codex/agents), the CLI from npm. Emitting them would
  // be dead weight the marketplace validator ignores.
  assert.ok(!exists(outDir, 'agents'), 'codex plugin must not ship subagents');
  assert.ok(!exists(outDir, 'commands'), 'codex plugin has no commands component');
  assert.ok(!exists(outDir, 'bin'), 'codex plugin does not bundle a binary');
});

test('the committed plugin-codex/ matches a fresh generation (no drift)', (t) => {
  const root = tempRepo(t);
  const { outDir } = runCodexPlugin({ cwd: root, outDir: join(root, 'plugin-codex') });
  const committedDir = join(REPO, 'plugin-codex');

  const generated = listFilesRel(outDir).sort();
  const committed = listFilesRel(committedDir).sort();
  assert.deepEqual(
    committed,
    generated,
    'plugin-codex/ file set differs from a fresh generation — run `npm run build:plugin:codex`',
  );
  for (const rel of generated) {
    assert.equal(
      read(committedDir, rel),
      read(outDir, rel),
      `plugin-codex/${rel} is stale — run \`npm run build:plugin:codex\``,
    );
  }
});

test('the committed codex marketplace.json points at the plugin', () => {
  const mkt = JSON.parse(
    readFileSync(join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );
  assert.equal(mkt.name, 'fadeno');
  const entry = mkt.plugins.find((p: { name: string }) => p.name === 'fadeno');
  assert.ok(entry, 'marketplace.json must list the fadeno plugin');
  // Path is relative to the marketplace ROOT (repo root), where the manifest lives
  // at .agents/plugins/marketplace.json — confirmed resolving via `codex plugin list`.
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.source.path, './plugin-codex');
  assert.equal(entry.category, 'Engineering');
});

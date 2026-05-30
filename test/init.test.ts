import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { exists, read, tempRepo } from './helpers.ts';

const SHARED_FILES = [
  '.fadeno/vocabulary.md',
  '.fadeno/enforcement.md',
  '.fadeno/playbooks/code-change-review.yaml',
  '.fadeno/playbooks/pr-review.yaml',
  '.fadeno/playbooks/research-synthesis.yaml',
  '.fadeno/schemas/playbook.schema.json',
  '.fadeno/schemas/run.schema.json',
  '.fadeno/schemas/review-report.schema.json',
  '.fadeno/runs/.gitkeep',
];

test('init --codex creates the Codex target tree', (t) => {
  const root = tempRepo(t);
  const { results } = runInit({ target: 'codex', repoRoot: root });

  for (const f of SHARED_FILES) assert.ok(exists(root, f), `missing ${f}`);

  // Codex-specific surface
  assert.ok(exists(root, 'AGENTS.md'));
  assert.ok(exists(root, '.agents/skills/fadeno-runner/SKILL.md'));
  assert.ok(exists(root, '.agents/skills/fadeno-runner/references/runtime.md'));
  assert.ok(exists(root, '.agents/skills/fadeno-runner/references/playbook-format.md'));
  assert.ok(exists(root, '.agents/skills/fadeno-runner/agents/openai.yaml'));
  assert.ok(exists(root, '.agents/skills/fadeno-builder/SKILL.md'));
  assert.ok(exists(root, '.agents/skills/fadeno-builder/agents/openai.yaml'));
  assert.ok(exists(root, '.codex/agents/fadeno-worker.toml'));
  assert.ok(exists(root, '.codex/agents/fadeno-reviewer.toml'));
  assert.ok(exists(root, '.codex/agents/fadeno-judge.toml'));

  // No Claude artifacts leak in
  assert.ok(!exists(root, 'CLAUDE.md'));
  assert.ok(!exists(root, '.claude/skills/fadeno-runner/SKILL.md'));

  // All emitted as `created` on a clean repo
  assert.ok(results.every((r) => r.status === 'created'));
});

test('init --claude creates the Claude target tree', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root });

  for (const f of SHARED_FILES) assert.ok(exists(root, f), `missing ${f}`);

  assert.ok(exists(root, 'CLAUDE.md'));
  assert.ok(exists(root, '.claude/skills/fadeno-runner/SKILL.md'));
  assert.ok(exists(root, '.claude/skills/fadeno-runner/references/runtime.md'));
  assert.ok(exists(root, '.claude/skills/fadeno-builder/SKILL.md'));
  assert.ok(exists(root, '.claude/agents/fadeno-worker.md'));
  assert.ok(exists(root, '.claude/agents/fadeno-reviewer.md'));
  assert.ok(exists(root, '.claude/agents/fadeno-judge.md'));

  // Claude uses frontmatter, not an openai.yaml policy file
  assert.ok(!exists(root, '.claude/skills/fadeno-runner/agents/openai.yaml'));
  assert.ok(!exists(root, 'AGENTS.md'));
  assert.ok(!exists(root, '.agents/skills/fadeno-runner/SKILL.md'));
});

test('invocation policy differs per target (builder gated, runner not)', (t) => {
  const codexRoot = tempRepo(t);
  const claudeRoot = tempRepo(t);
  runInit({ target: 'codex', repoRoot: codexRoot });
  runInit({ target: 'claude', repoRoot: claudeRoot });

  // Claude: builder frontmatter disables implicit invocation; runner does not.
  const claudeBuilder = read(claudeRoot, '.claude/skills/fadeno-builder/SKILL.md');
  const claudeRunner = read(claudeRoot, '.claude/skills/fadeno-runner/SKILL.md');
  assert.match(claudeBuilder, /disable-model-invocation:\s*true/);
  assert.doesNotMatch(claudeRunner, /disable-model-invocation/);

  // Codex: openai.yaml carries the policy; SKILL.md frontmatter is untouched.
  const codexBuilderPolicy = read(codexRoot, '.agents/skills/fadeno-builder/agents/openai.yaml');
  const codexRunnerPolicy = read(codexRoot, '.agents/skills/fadeno-runner/agents/openai.yaml');
  assert.match(codexBuilderPolicy, /allow_implicit_invocation:\s*false/);
  assert.match(codexRunnerPolicy, /allow_implicit_invocation:\s*true/);
  const codexBuilder = read(codexRoot, '.agents/skills/fadeno-builder/SKILL.md');
  assert.doesNotMatch(codexBuilder, /disable-model-invocation/);
});

test('SKILL.md bodies are sigil-free; sigils live only in the bootstrap file', (t) => {
  const codexRoot = tempRepo(t);
  const claudeRoot = tempRepo(t);
  runInit({ target: 'codex', repoRoot: codexRoot });
  runInit({ target: 'claude', repoRoot: claudeRoot });

  // Shared SKILL.md bodies must not hard-code a harness sigil.
  for (const root of [codexRoot]) {
    const body = read(root, '.agents/skills/fadeno-runner/SKILL.md');
    assert.doesNotMatch(body, /\$fadeno-runner/);
    assert.doesNotMatch(body, /\/fadeno-runner/);
  }

  // Bootstrap files carry the correct per-target sigil.
  assert.match(read(codexRoot, 'AGENTS.md'), /\$fadeno-runner/);
  assert.match(read(claudeRoot, 'CLAUDE.md'), /\/fadeno-runner/);
});

test('existing bootstrap content is preserved; section appended once', (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, 'AGENTS.md'), '# My Project\n\nExisting instructions.\n');

  const first = runInit({ target: 'codex', repoRoot: root });
  const agents1 = read(root, 'AGENTS.md');
  assert.match(agents1, /Existing instructions\./);
  assert.match(agents1, /# Fadeno/);
  assert.equal((agents1.match(/fadeno:begin/g) ?? []).length, 1);
  assert.equal(
    first.results.find((r) => r.path.endsWith('AGENTS.md'))?.status,
    'appended',
  );

  // Re-running is idempotent: bootstrap skipped, no second block.
  const second = runInit({ target: 'codex', repoRoot: root });
  const agents2 = read(root, 'AGENTS.md');
  assert.equal(agents2, agents1);
  assert.equal((agents2.match(/fadeno:begin/g) ?? []).length, 1);
  assert.equal(
    second.results.find((r) => r.path.endsWith('AGENTS.md'))?.status,
    'skipped',
  );
});

test('re-running init without --force skips everything', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const again = runInit({ target: 'codex', repoRoot: root });
  assert.ok(again.results.every((r) => r.status === 'skipped'));
});

test('--force overwrites existing files', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const forced = runInit({ target: 'codex', repoRoot: root, force: true });
  assert.ok(forced.results.every((r) => r.status === 'overwritten'));
});

test('hooks are only scaffolded with --with-hooks', (t) => {
  const plain = tempRepo(t);
  runInit({ target: 'codex', repoRoot: plain });
  assert.ok(!exists(plain, '.fadeno/hooks/pre-commit'));
  assert.ok(!exists(plain, '.github/workflows/fadeno-guard.yml'));

  const hooked = tempRepo(t);
  runInit({ target: 'codex', repoRoot: hooked, withHooks: true });
  assert.ok(exists(hooked, '.fadeno/hooks/pre-commit'));
  assert.ok(exists(hooked, '.fadeno/hooks/README.md'));
  assert.ok(exists(hooked, '.github/workflows/fadeno-guard.yml'));
  // pre-commit must be executable
  assert.ok(statSync(join(hooked, '.fadeno/hooks/pre-commit')).mode & 0o111);
});

test('--with-hooks on Claude adds a settings example', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withHooks: true });
  assert.ok(exists(root, '.fadeno/hooks/claude-settings.example.json'));
});

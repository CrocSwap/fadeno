import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { exists, read, starterPlaybooks, tempRepo } from './helpers.ts';

const SHARED_FILES = [
  '.fadeno/vocabulary.md',
  '.fadeno/enforcement.md',
  // Playbooks are derived so a new starter is covered without editing this list.
  ...starterPlaybooks().map((pb) => `.fadeno/playbooks/${pb}.yaml`),
  '.fadeno/schemas/playbook.schema.json',
  '.fadeno/schemas/run.schema.json',
  '.fadeno/schemas/review-report.schema.json',
  '.fadeno/schemas/test-result.schema.json',
  // Route policy used when OpenCode is spawned as a read-only driver.
  '.opencode/agents/fadeno-readonly.md',
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
  assert.ok(exists(root, '.agents/skills/fadeno-driver/SKILL.md'));
  assert.ok(exists(root, '.agents/skills/fadeno-driver/agents/openai.yaml'));
  assert.ok(exists(root, '.codex/agents/worker.toml'));
  assert.ok(exists(root, '.codex/agents/reviewer.toml'));
  assert.ok(exists(root, '.codex/agents/judge.toml'));
  assert.match(read(root, '.gitignore'), /^\.fadeno\/progress\/$/m);

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
  assert.ok(exists(root, '.claude/skills/fadeno-driver/SKILL.md'));
  assert.ok(exists(root, '.claude/agents/worker.md'));
  assert.ok(exists(root, '.claude/agents/reviewer.md'));
  assert.ok(exists(root, '.claude/agents/judge.md'));

  // Claude uses frontmatter, not an openai.yaml policy file
  assert.ok(!exists(root, '.claude/skills/fadeno-runner/agents/openai.yaml'));
  assert.ok(!exists(root, 'AGENTS.md'));
  assert.ok(!exists(root, '.agents/skills/fadeno-runner/SKILL.md'));
});

test('init --grok creates the Grok target tree without other host artifacts', (t) => {
  const root = tempRepo(t);
  const { results } = runInit({ target: 'grok', repoRoot: root });

  for (const f of SHARED_FILES) assert.ok(exists(root, f), `missing ${f}`);

  assert.ok(exists(root, 'AGENTS.md'));
  for (const skill of ['fadeno-runner', 'fadeno-builder', 'fadeno-driver']) {
    assert.ok(exists(root, `.grok/skills/${skill}/SKILL.md`));
  }
  assert.ok(exists(root, '.grok/skills/fadeno-runner/references/runtime.md'));
  assert.ok(exists(root, '.grok/skills/fadeno-runner/references/playbook-format.md'));
  assert.ok(exists(root, '.grok/skills/fadeno-builder/references/playbook-authoring.md'));
  assert.ok(exists(root, '.grok/skills/fadeno-driver/references/README.md'));
  assert.ok(exists(root, '.grok/agents/worker.md'));
  assert.ok(exists(root, '.grok/agents/reviewer.md'));
  assert.ok(exists(root, '.grok/agents/judge.md'));

  assert.ok(!exists(root, '.agents/skills/fadeno-runner/SKILL.md'));
  assert.ok(!exists(root, '.codex/agents/worker.toml'));
  assert.ok(!exists(root, '.claude/skills/fadeno-runner/SKILL.md'));
  assert.ok(!exists(root, '.claude/agents/worker.md'));
  assert.ok(!exists(root, 'CLAUDE.md'));
  assert.ok(!exists(root, '.grok/skills/fadeno-runner/agents/openai.yaml'));
  assert.ok(!exists(root, '.grok/config.toml'));
  assert.ok(!exists(root, '.claude/settings.local.json'));

  assert.ok(results.every((r) => r.status === 'created'));
});

test('init --opencode creates the OpenCode target tree without other host artifacts', (t) => {
  const root = tempRepo(t);
  const { results } = runInit({ target: 'opencode', repoRoot: root });

  for (const f of SHARED_FILES) assert.ok(exists(root, f), `missing ${f}`);

  assert.ok(exists(root, 'AGENTS.md'));
  // OpenCode reads the cross-harness `.agents/skills` directory (shared with Codex).
  for (const skill of ['fadeno-runner', 'fadeno-builder', 'fadeno-driver']) {
    assert.ok(exists(root, `.agents/skills/${skill}/SKILL.md`));
    assert.ok(!exists(root, `.agents/skills/${skill}/agents/openai.yaml`));
  }
  assert.ok(exists(root, '.agents/skills/fadeno-runner/references/runtime.md'));
  assert.ok(exists(root, '.agents/skills/fadeno-runner/references/playbook-format.md'));
  // Role subagents in OpenCode's agent format, beside the always-emitted read-only lane.
  for (const role of ['worker', 'reviewer', 'judge']) {
    const body = read(root, `.opencode/agents/${role}.md`);
    assert.match(body, /^description: /m);
    assert.match(body, /^mode: subagent$/m);
  }

  assert.ok(!exists(root, '.grok/agents/worker.md'));
  assert.ok(!exists(root, '.codex/agents/worker.toml'));
  assert.ok(!exists(root, '.claude/skills/fadeno-runner/SKILL.md'));
  assert.ok(!exists(root, '.claude/agents/worker.md'));
  assert.ok(!exists(root, 'CLAUDE.md'));
  assert.ok(!exists(root, '.claude/settings.local.json'));

  assert.ok(results.every((r) => r.status === 'created'));
});

test('OpenCode receives shared skill bodies and a sigil-free bootstrap', (t) => {
  const opencodeRoot = tempRepo(t);
  const codexRoot = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: opencodeRoot });
  runInit({ target: 'codex', repoRoot: codexRoot });

  for (const skill of ['fadeno-runner', 'fadeno-builder', 'fadeno-driver']) {
    const opencodeBody = read(opencodeRoot, `.agents/skills/${skill}/SKILL.md`);
    const codexBody = read(codexRoot, `.agents/skills/${skill}/SKILL.md`);
    assert.equal(opencodeBody, codexBody, `${skill}/SKILL.md differs between OpenCode and Codex`);
    assert.doesNotMatch(opencodeBody, /\$fadeno-(runner|builder|driver)/);
    assert.doesNotMatch(opencodeBody, /\/fadeno-(runner|builder|driver)/);
  }

  const bootstrap = read(opencodeRoot, 'AGENTS.md');
  assert.match(bootstrap, /fadeno-runner/);
  assert.doesNotMatch(bootstrap, /\$fadeno-runner/);
});

test('OpenCode init preserves and refreshes one managed AGENTS.md section', (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, 'AGENTS.md'), '# My Project\n\nExisting instructions.\n');

  const first = runInit({ target: 'opencode', repoRoot: root });
  const agents1 = read(root, 'AGENTS.md');
  assert.match(agents1, /Existing instructions\./);
  assert.match(agents1, /# Fadeno/);
  assert.equal((agents1.match(/fadeno:begin/g) ?? []).length, 1);
  assert.equal(first.results.find((r) => r.path.endsWith('AGENTS.md'))?.status, 'appended');
});

test('Grok receives shared skill bodies and slash handles only in its bootstrap', (t) => {
  const grokRoot = tempRepo(t);
  const codexRoot = tempRepo(t);
  runInit({ target: 'grok', repoRoot: grokRoot });
  runInit({ target: 'codex', repoRoot: codexRoot });

  for (const skill of ['fadeno-runner', 'fadeno-builder', 'fadeno-driver']) {
    const grokBody = read(grokRoot, `.grok/skills/${skill}/SKILL.md`);
    const codexBody = read(codexRoot, `.agents/skills/${skill}/SKILL.md`);
    assert.equal(grokBody, codexBody, `${skill}/SKILL.md differs between Grok and Codex`);
    assert.doesNotMatch(grokBody, /\$fadeno-(runner|builder|driver)/);
    assert.doesNotMatch(grokBody, /\/fadeno-(runner|builder|driver)/);
  }

  const bootstrap = read(grokRoot, 'AGENTS.md');
  assert.match(bootstrap, /\/fadeno-runner/);
  assert.match(bootstrap, /\/fadeno-driver/);
  assert.match(bootstrap, /\/fadeno-builder/);
});

test('invocation policy: Claude skills stay model-invocable; Codex builder is gated', (t) => {
  const codexRoot = tempRepo(t);
  const claudeRoot = tempRepo(t);
  runInit({ target: 'codex', repoRoot: codexRoot });
  runInit({ target: 'claude', repoRoot: claudeRoot });

  // Claude: neither skill carries a frontmatter gate. A builder gated with
  // disable-model-invocation was uninvocable (plugin skills aren't slash-
  // invocable) — the builder is now scoped by its description instead.
  const claudeBuilder = read(claudeRoot, '.claude/skills/fadeno-builder/SKILL.md');
  const claudeRunner = read(claudeRoot, '.claude/skills/fadeno-runner/SKILL.md');
  assert.doesNotMatch(claudeBuilder, /disable-model-invocation/);
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
  assert.match(read(codexRoot, 'AGENTS.md'), /\$fadeno-driver/);
  assert.match(read(claudeRoot, 'CLAUDE.md'), /\/fadeno-runner/);
  assert.match(read(claudeRoot, 'CLAUDE.md'), /\/fadeno-driver/);
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

test('Grok init preserves and refreshes one managed AGENTS.md section', (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, 'AGENTS.md'), '# My Project\n\nExisting instructions.\n');

  const first = runInit({ target: 'grok', repoRoot: root });
  const agents1 = read(root, 'AGENTS.md');
  assert.match(agents1, /Existing instructions\./);
  assert.match(agents1, /\/fadeno-runner/);
  assert.equal((agents1.match(/fadeno:begin/g) ?? []).length, 1);
  assert.equal(first.results.find((r) => r.path.endsWith('AGENTS.md'))?.status, 'appended');

  const second = runInit({ target: 'grok', repoRoot: root });
  assert.equal(read(root, 'AGENTS.md'), agents1);
  assert.equal(second.results.find((r) => r.path.endsWith('AGENTS.md'))?.status, 'skipped');

  const forced = runInit({ target: 'grok', repoRoot: root, force: true });
  const agents3 = read(root, 'AGENTS.md');
  assert.match(agents3, /Existing instructions\./);
  assert.equal((agents3.match(/fadeno:begin/g) ?? []).length, 1);
  assert.equal(forced.results.find((r) => r.path.endsWith('AGENTS.md'))?.status, 'overwritten');
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

test('--data-only seeds definitions and driver policy but no host capability layer', (t) => {
  const root = tempRepo(t);
  const { results } = runInit({ target: 'claude', repoRoot: root, dataOnly: true });

  // definitions present
  assert.ok(exists(root, '.fadeno/schemas/playbook.schema.json'));
  assert.ok(exists(root, '.fadeno/playbooks/code-change-review.yaml'));
  assert.ok(exists(root, '.fadeno/vocabulary.md'));
  assert.ok(exists(root, '.opencode/agents/fadeno-readonly.md'));

  // capability layer skipped (comes from the plugin)
  assert.ok(!exists(root, '.claude/skills/fadeno-runner/SKILL.md'));
  assert.ok(!exists(root, '.claude/agents/worker.md'));
  assert.ok(!exists(root, 'CLAUDE.md'));

  // every emitted path is either a .fadeno/ definition, driver route policy,
  // or the local CLI allow-list (no host skills/subagents/bootstrap — those
  // come from the plugin)
  assert.ok(
    results.every(
      (r) =>
        r.path.includes('.fadeno') ||
        r.path.includes('.opencode') ||
        r.path.endsWith('settings.local.json') ||
        r.path.endsWith('.gitignore'),
    ),
  );
});

test('init --claude pre-approves the fadeno CLI in local, git-ignored settings', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root });

  const settings = JSON.parse(read(root, '.claude/settings.local.json')) as {
    permissions: { allow: string[] };
  };
  assert.deepEqual(settings.permissions.allow, ['Bash(fadeno:*)']);
  // local-only: git-ignored so the trust decision is never committed to the repo
  assert.match(read(root, '.gitignore'), /\.claude\/settings\.local\.json/);

  // it ships in the plugin (data-only) flow too — where the prompts bite most
  const dataRoot = tempRepo(t);
  runInit({ target: 'claude', repoRoot: dataRoot, dataOnly: true });
  assert.ok(exists(dataRoot, '.claude/settings.local.json'));

  // Codex uses a different permission model — no settings.local.json there
  const codexRoot = tempRepo(t);
  runInit({ target: 'codex', repoRoot: codexRoot });
  assert.ok(!exists(codexRoot, '.claude/settings.local.json'));
});

test('init merges the fadeno allow rule into existing Claude settings, idempotently', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`,
  );

  const first = runInit({ target: 'claude', repoRoot: root });
  const merged = JSON.parse(read(root, '.claude/settings.local.json')) as {
    permissions: { allow: string[] };
  };
  assert.deepEqual(merged.permissions.allow, ['Bash(ls:*)', 'Bash(fadeno:*)']); // preserves + appends
  assert.equal(
    first.results.find((r) => r.path.endsWith('settings.local.json'))?.status,
    'appended',
  );

  // re-running leaves the rule once and reports it skipped
  const second = runInit({ target: 'claude', repoRoot: root });
  const after = JSON.parse(read(root, '.claude/settings.local.json')) as {
    permissions: { allow: string[] };
  };
  assert.deepEqual(after.permissions.allow, ['Bash(ls:*)', 'Bash(fadeno:*)']);
  assert.equal(
    second.results.find((r) => r.path.endsWith('settings.local.json'))?.status,
    'skipped',
  );
});

test('--data-only still scaffolds hooks when requested', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, dataOnly: true, withHooks: true });
  assert.ok(exists(root, '.fadeno/hooks/pre-commit'));
  assert.ok(!exists(root, '.claude/skills/fadeno-runner/SKILL.md'));
});

test('--data-only Grok init has no capability or Claude-specific settings', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'grok', repoRoot: root, dataOnly: true, withHooks: true });

  assert.ok(exists(root, '.fadeno/hooks/pre-commit'));
  assert.ok(exists(root, '.fadeno/hooks/README.md'));
  assert.ok(exists(root, '.github/workflows/fadeno-guard.yml'));
  assert.ok(!exists(root, 'AGENTS.md'));
  assert.ok(!exists(root, '.grok/skills/fadeno-runner/SKILL.md'));
  assert.ok(!exists(root, '.grok/agents/worker.md'));
  assert.ok(!exists(root, '.grok/config.toml'));
  assert.ok(!exists(root, '.claude/settings.local.json'));
  assert.ok(!exists(root, '.fadeno/hooks/claude-settings.example.json'));
});

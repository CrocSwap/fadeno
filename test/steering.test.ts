import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { exists, read, tempRepo } from './helpers.ts';

const ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;
const BIN = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

test('Codex native agents use the current custom-agent schema', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });

  for (const archetype of ARCHETYPES) {
    const body = read(root, `.codex/agents/${archetype}.toml`);
    assert.ok(body.includes(`name = "${archetype}"\n`));
    assert.match(body, /^description = /m);
    assert.ok(body.includes('developer_instructions = """\n'));
    assert.doesNotMatch(body, /^instructions =/m);
    assert.doesNotMatch(body, /^max_depth =/m);
    assert.match(body, /Do not spawn subagents/);
  }
});

test('Codex --with-steering installs loadout-aware role overrides', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, withSteering: true });

  for (const archetype of ARCHETYPES) {
    const body = read(root, `.codex/agents/${archetype}.toml`);
    assert.match(body, /loadout-aware/i);
    assert.match(body, new RegExp(`First run .*fadeno steering resolve --archetype ${archetype}`));
    assert.match(body, new RegExp(`fadeno dispatch --archetype ${archetype} --prompt-file`));
    assert.match(body, /ENTIRE task prompt.*verbatim/s);
    assert.match(body, /mode=restart_required/);
    assert.match(body, /fadeno dispatch-fallback <run-id> <dispatch-id>/);
    assert.match(body, /do not silently/);
  }
});

test('Codex data-only plugin flow still emits explicitly requested steering agents', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true, withSteering: true });

  assert.ok(exists(root, '.codex/agents/worker.toml'));
  assert.ok(!exists(root, '.agents/skills/fadeno-runner/SKILL.md'));
  assert.ok(!exists(root, 'AGENTS.md'));
});

test('Claude --with-steering merges one local Agent hook without clobbering settings', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    `${JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: './check-write' }] }],
      },
    }, null, 2)}\n`,
  );

  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  assert.ok(exists(root, '.fadeno/local/claude-dispatch-steering.mjs'));
  const first = JSON.parse(read(root, '.claude/settings.local.json')) as {
    permissions: { allow: string[] };
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  };
  assert.deepEqual(first.permissions.allow, ['Bash(ls:*)', 'Bash(fadeno:*)']);
  assert.equal(first.hooks.PreToolUse.length, 2);
  assert.equal(first.hooks.PreToolUse[0]!.hooks[0]!.command, './check-write');
  assert.equal(first.hooks.PreToolUse[1]!.matcher, 'Agent');
  assert.equal(
    first.hooks.PreToolUse[1]!.hooks[0]!.command,
    'node .fadeno/local/claude-dispatch-steering.mjs',
  );

  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const second = JSON.parse(read(root, '.claude/settings.local.json')) as typeof first;
  assert.deepEqual(second, first);
});

function writeFakeFadeno(root: string, output: string, exitCode = 0): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'fadeno');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return bin;
}

function runClaudeSteering(
  root: string,
  event: Record<string, unknown>,
  fadenoOutput: string,
): string {
  const bin = writeFakeFadeno(root, fadenoOutput);
  const script = join(root, '.fadeno', 'local', 'claude-dispatch-steering.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('Claude steering rewrites worker-shaped Agent input and preserves Explore', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const base = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: {
      prompt: 'Implement the change exactly.',
      description: 'Implement change',
      subagent_type: 'general-purpose',
      run_in_background: true,
      model: 'opus',
    },
  };
  const rewritten = JSON.parse(runClaudeSteering(root, base, '{"adapter":"command"}')) as {
    hookSpecificOutput: { updatedInput: Record<string, unknown> };
  };
  assert.deepEqual(rewritten.hookSpecificOutput.updatedInput, {
    prompt: 'Implement the change exactly.',
    description: 'Implement change',
    subagent_type: 'dispatch-worker',
    run_in_background: true,
    model: 'haiku',
  });

  const explore = {
    ...base,
    tool_input: { ...base.tool_input, subagent_type: 'Explore' },
  };
  assert.equal(runClaudeSteering(root, explore, '{"adapter":"command"}'), '');
});

test('Claude steering selects a native target model without a command proxy', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const event = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt: 'Review it.', description: 'Review', subagent_type: 'reviewer', model: 'sonnet' },
  };
  const rewritten = JSON.parse(runClaudeSteering(root, event, '{"adapter":"host","model":"opus"}')) as {
    hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } };
  };
  assert.equal(rewritten.hookSpecificOutput.updatedInput.subagent_type, 'reviewer');
  assert.equal(rewritten.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(runClaudeSteering(root, event, '{"adapter":"host","model":"current-host"}'), '');
});

test('Claude steering is inactive without a loadout and uses plugin-scoped proxies in data-only flow', (t) => {
  const nativeRoot = tempRepo(t);
  runInit({ target: 'claude', repoRoot: nativeRoot, withSteering: true });
  const event = {
    cwd: nativeRoot,
    tool_name: 'Agent',
    tool_input: { prompt: 'Review it.', description: 'Review', subagent_type: 'reviewer' },
  };
  assert.equal(runClaudeSteering(nativeRoot, event, '{"adapter":"host"}'), '');

  const pluginRoot = tempRepo(t);
  runInit({ target: 'claude', repoRoot: pluginRoot, dataOnly: true, withSteering: true });
  const pluginEvent = {
    ...event,
    cwd: pluginRoot,
  };
  const rewritten = JSON.parse(runClaudeSteering(pluginRoot, pluginEvent, '{"adapter":"command"}')) as {
    hookSpecificOutput: { updatedInput: { subagent_type: string } };
  };
  assert.equal(rewritten.hookSpecificOutput.updatedInput.subagent_type, 'fadeno:dispatch-reviewer');
});

test('Grok rejects --with-steering before scaffolding anything', (t) => {
  const root = tempRepo(t);
  assert.throws(
    () => runInit({ target: 'grok', repoRoot: root, withSteering: true }),
    /supported for Codex and Claude Code, not Grok Build/,
  );
  assert.ok(!exists(root, '.fadeno/vocabulary.md'));
});

test('bundled CLI parses --with-steering and carries its templates', (t) => {
  const root = tempRepo(t);
  const result = spawnSync(BIN, ['init', '--codex', '--with-steering'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Materialize Codex steering with .*fadeno steering apply/);
  assert.match(read(root, '.codex/agents/worker.toml'), /Fadeno worker broker/i);
  assert.match(read(root, '.codex/agents/worker.toml'), /fadeno dispatch-fallback <run-id> <dispatch-id>/);
});

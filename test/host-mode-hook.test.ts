import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { templatesDir } from '../src/lib/paths.ts';
import { tempRepo } from './helpers.ts';

const HOOK = join(templatesDir(), 'common/plugin/host-mode-hook.mjs');

function invoke(t: TestContext, input: Record<string, unknown>, dataDir?: string) {
  const root = tempRepo(t);
  const pluginData = dataDir ?? join(root, 'plugin-data');
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: pluginData },
    input: JSON.stringify(input),
  });
  assert.equal(result.status, 0, result.stderr);
  return { ...result, root, pluginData };
}

function reinvoke(root: string, pluginData: string, input: Record<string, unknown>) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: pluginData },
    input: JSON.stringify(input),
  });
}

function context(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

test('Claude host command enables persistent session context and off clears it', (t) => {
  const activation = invoke(t, {
    hook_event_name: 'UserPromptExpansion',
    session_id: 'claude-session',
    command_name: 'fadeno:host',
    command_args: 'Implement the feature',
  });
  assert.equal(activation.stdout, '');
  assert.equal(readdirSync(join(activation.pluginData, 'host-mode')).length, 1);
  assert.equal(existsSync(join(activation.root, 'AGENTS.md')), false);
  assert.equal(existsSync(join(activation.root, 'CLAUDE.md')), false);

  const next = reinvoke(activation.root, activation.pluginData, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'claude-session',
    prompt: 'Continue',
  });
  assert.equal(next.status, 0, next.stderr);
  assert.match(context(next.stdout), /host coordinator/i);
  assert.match(context(next.stdout), /\.\/\.fadeno\/feedback\.md/);

  const off = reinvoke(activation.root, activation.pluginData, {
    hook_event_name: 'UserPromptExpansion',
    session_id: 'claude-session',
    command_name: 'fadeno:host',
    command_args: 'off',
  });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stdout, '');
  const afterOff = reinvoke(activation.root, activation.pluginData, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'claude-session',
    prompt: 'Continue again',
  });
  assert.equal(afterOff.stdout, '');
});

test('Codex host skill enables compaction-safe context and SessionEnd clears it', (t) => {
  const activation = invoke(t, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'codex-session',
    prompt: '$fadeno-host Fix the recovery path',
  });
  assert.match(context(activation.stdout), /host coordinator/i);

  const compact = reinvoke(activation.root, activation.pluginData, {
    hook_event_name: 'SessionStart',
    session_id: 'codex-session',
    source: 'compact',
  });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(context(compact.stdout), /session-scoped/i);

  const end = reinvoke(activation.root, activation.pluginData, {
    hook_event_name: 'SessionEnd',
    session_id: 'codex-session',
  });
  assert.equal(end.status, 0, end.stderr);
  assert.equal(end.stdout, '');
  const resume = reinvoke(activation.root, activation.pluginData, {
    hook_event_name: 'SessionStart',
    session_id: 'codex-session',
    source: 'resume',
  });
  assert.equal(resume.stdout, '');
});

test('host hook ignores unrelated prompts and malformed input', (t) => {
  const unrelated = invoke(t, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'ordinary-session',
    prompt: 'Please fix the tests',
  });
  assert.equal(unrelated.stdout, '');

  const malformed = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: join(unrelated.root, 'plugin-data') },
    input: '{not json',
  });
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(malformed.stdout, '');
});

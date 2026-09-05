import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { templatesDir } from '../src/lib/paths.ts';
import { tempRepo } from './helpers.ts';

const HOOK = join(templatesDir(), 'common/plugin/host-mode-hook.mjs');
const SKILL = join(templatesDir(), 'common/skills/fadeno-host/SKILL.md');

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

/**
 * The two halves of one policy.
 *
 * The skill governs the activation turn; the hook makes the same policy
 * survive later turns and compaction. They are separate files with no import
 * between them, so the only thing keeping them from drifting apart is this
 * test — and drift here is silent by construction: a host would simply behave
 * one way on the turn it was switched on and another way forever after.
 *
 * Compared sentence by sentence, on normalized whitespace and with backticks
 * stripped: the hook's policy is a template literal (no backticks allowed in
 * it) while the skill is Markdown that code-quotes `worker`, `off` and the
 * feedback path. Wrapping and bullet markers are free to differ; wording is
 * not.
 */
test('every sentence of the hook policy survives in the fadeno-host skill', (t) => {
  // The policy as a SESSION actually receives it, not as the file spells it:
  // running the hook evaluates the template literal, so an escaped backtick
  // (`off`) is compared as the one character the model will read rather than
  // as the two the source needs. A regex over the literal got this wrong.
  const policy = context(
    invoke(t, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'policy-session',
      prompt: '$fadeno-host',
    }).stdout,
  );
  assert.ok(policy.length > 500, 'the emitted policy looks truncated');

  const normalize = (text: string): string => text.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const body = normalize(readFileSync(SKILL, 'utf8'));
  const missing: string[] = [];
  for (const paragraph of policy.split(/\n\s*\n/)) {
    if (paragraph.trim().startsWith('#')) continue; // the policy's own title
    for (const sentence of normalize(paragraph).split(/(?<=\.)\s+/)) {
      if (sentence === '') continue;
      if (!body.includes(sentence)) missing.push(sentence);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `sentences in HOST_POLICY with no twin in the fadeno-host skill:\n- ${missing.join('\n- ')}`,
  );
});

test('both halves carry the failure-reporting policy the hooks enforce', () => {
  // The tokens the docs-claims tripwire pairs, asserted here as behavior: the
  // policy that a Fadeno failure stops the work, and the refusal sentence both
  // plugins' PreToolUse hooks append. A host that loses either one is back to
  // the 2026-09-04 receipt — a failed lane answered with generic subagents on
  // a frontier model, reported to nobody.
  for (const path of [HOOK, SKILL]) {
    const text = readFileSync(path, 'utf8');
    assert.match(text, /Fadeno failing is a user-facing event/, path);
  }
  assert.match(readFileSync(SKILL, 'utf8'), /Report this refusal to the user/);
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

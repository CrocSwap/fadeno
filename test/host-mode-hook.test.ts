import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { templatesDir } from '../src/lib/paths.ts';
import { cli, hookPlugin, hookRepo, type HookPlugin } from './hook-helpers.ts';

/**
 * Session-scoped host mode: the marker, what each event injects, and the
 * sentence-for-sentence parity between the hook's policy and the host skill.
 */

const HOOK = 'host-mode.mjs';
const SKILL = join(templatesDir(), 'common/skills/fadeno-host/SKILL.md');

function context(plugin: HookPlugin, event: Record<string, unknown>, cwd: string): string | null {
  const run = plugin.run(HOOK, event, { cwd });
  assert.equal(run.status, 0, run.stderr);
  return run.out?.hookSpecificOutput?.additionalContext ?? null;
}

function setup(t: TestContext): { plugin: HookPlugin; root: string } {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', 'pending'], 'x');
  return { plugin, root };
}

test('Claude: the host command enables the session, injects the vocabulary, reminds on later prompts, restores after compaction, and off clears it', (t) => {
  const { plugin, root } = setup(t);
  const activation = context(plugin, { hook_event_name: 'UserPromptExpansion', session_id: 'claude-session', command_name: 'fadeno:host', command_args: 'Implement the feature' }, root);
  assert.equal(readdirSync(join(plugin.data, 'host-mode')).length, 1);
  assert.ok(!existsSync(join(root, 'CLAUDE.md')) && !existsSync(join(root, 'AGENTS.md')));
  // The skill carries the policy on the activating turn; the hook adds only what the skill cannot: the live vocabulary.
  assert.match(activation ?? '', /^# Fadeno\n/);
  assert.match(activation ?? '', /- \*\*reviewer\*\* — Reviews /);
  assert.doesNotMatch(activation ?? '', /routes to/, 'no routing snapshot to go stale in a long session');
  assert.match(activation ?? '', /## Unclosed dispatches \(1; 0 of 5 allowed are waiting on you\)[\s\S]*`pending`/);
  assert.doesNotMatch(activation ?? '', /Fadeno host mode \(session-scoped\)/);

  const later = context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: 'Continue' }, root);
  assert.match(later ?? '', /^Fadeno host mode is on for this session: delegate through archetypes/);
  assert.doesNotMatch(later ?? '', /## Archetypes/, 'an ordinary turn gets the reminder, not the whole vocabulary');

  const compacted = context(plugin, { hook_event_name: 'SessionStart', session_id: 'claude-session', source: 'compact' }, root);
  assert.match(compacted ?? '', /^# Fadeno host mode \(session-scoped\)/);
  assert.match(compacted ?? '', /\n# Fadeno\n[\s\S]*## Archetypes/);

  assert.equal(context(plugin, { hook_event_name: 'UserPromptExpansion', session_id: 'claude-session', command_name: 'fadeno:host', command_args: 'off' }, root), null);
  assert.equal(context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: 'Continue again' }, root), null);
  assert.equal(context(plugin, { hook_event_name: 'SessionStart', session_id: 'claude-session', source: 'resume' }, root), null);
});

test('Codex: $fadeno-host enables with policy and vocabulary together, survives compaction, and SessionEnd clears it', (t) => {
  const { plugin, root } = setup(t);
  const activation = context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'codex-session', prompt: '$fadeno-host Fix the recovery path' }, root);
  assert.match(activation ?? '', /^# Fadeno host mode \(session-scoped\)[\s\S]*\n# Fadeno\n[\s\S]*## Unclosed dispatches/);
  assert.match(context(plugin, { hook_event_name: 'SessionStart', session_id: 'codex-session', source: 'compact' }, root) ?? '', /session-scoped/);
  assert.equal(context(plugin, { hook_event_name: 'SessionEnd', session_id: 'codex-session' }, root), null);
  assert.equal(context(plugin, { hook_event_name: 'SessionStart', session_id: 'codex-session', source: 'resume' }, root), null);
});

test('when `fadeno context` cannot answer, the hook says so instead of inventing a vocabulary', (t) => {
  const plugin = hookPlugin(t);
  const broken = hookRepo(t);
  writeFileSync(join(broken, '.fadeno', 'executors.yaml'), 'schema_version: 4\nmodels: {}\nharnesses: {}\nunknown_key: 1\n');
  const activation = context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'bare-session', prompt: '$fadeno-host' }, broken);
  assert.match(activation ?? '', /`fadeno context` could not be read here: /);
  assert.match(activation ?? '', /Run it yourself for the archetype table/);
});

/**
 * The two halves of one policy: the skill governs the activation turn, the
 * hook makes the same policy survive later turns and compaction. Compared
 * sentence by sentence as a session receives it (template evaluated), on
 * normalized whitespace and with backticks stripped.
 */
test('every sentence of the hook policy survives in the fadeno-host skill', (t) => {
  const plugin = hookPlugin(t);
  const emitted = context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'policy-session', prompt: '$fadeno-host' }, plugin.root) ?? '';
  const policy = emitted.split(/\n\n(?:# Fadeno\n|\(`fadeno context`)/)[0]!;
  assert.ok(policy.length > 500, 'the emitted policy looks truncated');
  const normalize = (text: string): string => text.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const body = normalize(readFileSync(SKILL, 'utf8'));
  const missing: string[] = [];
  for (const paragraph of policy.split(/\n\s*\n/)) {
    if (paragraph.trim().startsWith('#')) continue;
    for (const sentence of normalize(paragraph).split(/(?<=\.)\s+/)) {
      if (sentence === '') continue;
      if (!body.includes(sentence)) missing.push(sentence);
    }
  }
  assert.deepEqual(missing, [], `sentences in HOST_POLICY with no twin in the fadeno-host skill:\n- ${missing.join('\n- ')}`);
  for (const path of [join(templatesDir(), 'hooks', HOOK), SKILL]) {
    assert.match(readFileSync(path, 'utf8'), /Fadeno failing is a user-facing event/, path);
  }
  assert.match(readFileSync(SKILL, 'utf8'), /Report this refusal to the user/);
});

test('the host hook ignores unrelated prompts and malformed input', (t) => {
  const plugin = hookPlugin(t);
  assert.equal(context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'ordinary', prompt: 'Please fix the tests' }, plugin.root), null);
  const malformed = plugin.run(HOOK, '{not json' as unknown as Record<string, unknown>);
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(malformed.out, null);
});

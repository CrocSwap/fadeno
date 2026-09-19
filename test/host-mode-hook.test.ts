import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { templatesDir } from '../src/lib/paths.ts';
import { cli, denial, hookPlugin, hookRepo, type HookPlugin } from './hook-helpers.ts';
import { readDispatches } from '../src/lib/ledger.ts';

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
  assert.match(activation ?? '', /## Unclosed dispatches \(1; 0 stopped and waiting on you\)[\s\S]*`pending`/);
  assert.match(activation ?? '', /If it is still `open`, or if it is `awaiting close` with worktree inspection pending/);
  assert.match(activation ?? '', /save the already-received final response to a file and replay the idempotent stop with `fadeno dispatch-stop <name\|id> --message-file <path>`/);
  assert.doesNotMatch(activation ?? '', /Fadeno host mode \(session-scoped\)/);

  const later = context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: 'Continue' }, root);
  assert.match(later ?? '', /^Fadeno host mode is on for this session: delegate through archetypes/);
  assert.match(later ?? '', /1 dispatch still running; none is waiting for a decision/);
  assert.doesNotMatch(later ?? '', /## Archetypes/, 'an ordinary turn gets the reminder, not the whole vocabulary');

  cli(root, ['dispatch-stop', 'pending'], 'The report is ready.');
  const afterStop = context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: 'Review the report' }, root);
  assert.match(afterStop ?? '', /1 stopped dispatch waiting for your decision: `pending`/);
  assert.match(afterStop ?? '', /dispatch-close <name\|id> --merged\|--kept\|--discarded\|--failed\|--reviewed/);

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
  // Codex provides PLUGIN_ROOT alongside the Claude-compatible alias. The
  // fixture sets both, so this must still deliver Codex's spawn instructions.
  assert.match(activation ?? '', /model and effort ON THE SPAWN/);
  assert.match(activation ?? '', /fadeno dial <archetype> --json/);
  assert.match(activation ?? '', /command-lane process liveness echo.*not a user-facing host progress update/s);
  assert.match(activation ?? '', /report host progress only when something materially changes/i);
  assert.match(activation ?? '', /Codex desktop app.*thread heartbeat\/scheduled follow-up facility/s);
  assert.match(activation ?? '', /Keep the scheduled check quiet.*end it when no dispatch remains in flight/s);
  assert.match(activation ?? '', /Fadeno itself cannot call a Codex app API/s);
  assert.match(activation ?? '', /Outside an environment with scheduled thread heartbeats.*not hold a foreground assistant turn open solely to emit chat updates/s);
  assert.match(context(plugin, { hook_event_name: 'SessionStart', session_id: 'codex-session', source: 'compact' }, root) ?? '', /model and effort ON THE SPAWN/);
  assert.match(context(plugin, { hook_event_name: 'SessionStart', session_id: 'codex-session', source: 'compact' }, root) ?? '', /session-scoped/);
  assert.match(context(plugin, { hook_event_name: 'SessionStart', session_id: 'codex-session', source: 'compact' }, root) ?? '', /inspect the report and close it normally/);
  assert.equal(context(plugin, { hook_event_name: 'SessionEnd', session_id: 'codex-session' }, root), null);
  assert.equal(context(plugin, { hook_event_name: 'SessionStart', session_id: 'codex-session', source: 'resume' }, root), null);
});

test('Codex: qualified skill activation enables spawn scaffolding and qualified off disables it', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const session_id = 'qualified-session';
  const activation = context(plugin, { hook_event_name: 'UserPromptSubmit', session_id, prompt: '$fadeno:fadeno-host' }, root);
  assert.match(activation ?? '', /^# Fadeno host mode/);
  const event = { hook_event_name: 'PreToolUse', session_id, cwd: root, tool_name: 'collaborationspawn_agent' };
  assert.match(denial(plugin.run('spawn-codex.mjs', { ...event, tool_input: { agent_type: 'explorer', message: 'x' } })) ?? '', /refuses generic/);
  const passed = plugin.run('spawn-codex.mjs', { ...event, tool_input: {
    agent_type: 'fadeno-worker', task_name: 'qualified-worker', message: 'Inspect only.', model: 'gpt-5.6-sol', reasoning_effort: 'high',
  } });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(denial(passed), null);
  const started = plugin.run('spawn-codex.mjs', {
    hook_event_name: 'SubagentStart', session_id, cwd: root, agent_id: 'qualified-agent', agent_type: 'fadeno-worker', model: 'gpt-5.6-sol',
  });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.out?.hookSpecificOutput?.additionalContext ?? '', /Fadeno dispatch/);
  assert.equal(readDispatches(root).records.length, 1);
  assert.ok(existsSync(join(root, '.fadeno/local/worktrees/qualified-worker')));
  assert.equal(context(plugin, { hook_event_name: 'UserPromptSubmit', session_id, prompt: '$fadeno:fadeno-host off' }, root), null);
  assert.equal(plugin.run('spawn-codex.mjs', { ...event, tool_input: { agent_type: 'explorer', message: 'x' } }).out, null);
});

test('Claude-only plugin environment keeps Claude spawn guidance', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const run = plugin.run(HOOK, { hook_event_name: 'UserPromptExpansion', session_id: 'claude-only', command_name: 'fadeno:host' }, {
    cwd: root, env: { PLUGIN_ROOT: undefined, PLUGIN_DATA: undefined },
  });
  assert.equal(run.status, 0, run.stderr);
  const text = run.out?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(text, /fadeno:worker/);
  assert.doesNotMatch(text, /model and effort ON THE SPAWN/);
});

test('Codex: similarly named skills do not activate host mode', (t) => {
  const plugin = hookPlugin(t);
  for (const prompt of ['$fadeno-host-extra', '$fadeno:fadeno-host-extra', '$other:fadeno-host']) {
    assert.equal(context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'unrelated', prompt }, plugin.root), null, prompt);
  }
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
  assert.match(readFileSync(SKILL, 'utf8'), /The managed foreground shell requirement for the command launcher itself remains unchanged/);
  assert.match(readFileSync(SKILL, 'utf8'), /no live inbox or mid-run messaging/);
  assert.match(readFileSync(SKILL, 'utf8'), /fadeno dispatches --output <name>/);
  assert.match(readFileSync(SKILL, 'utf8'), /shared-tree dispatch cannot provide a follow-up baseline/);
});

test('the host skill keeps a live foreground dispatch session instead of duplicating an empty initial chunk', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /empty initial tool chunk with a live session id is not a silent launch/);
  assert.match(skill, /Continue the same\s+managed session and read its later chunks; do not launch a duplicate dispatch/);
});

test('the host hook ignores unrelated prompts and malformed input', (t) => {
  const plugin = hookPlugin(t);
  assert.equal(context(plugin, { hook_event_name: 'UserPromptSubmit', session_id: 'ordinary', prompt: 'Please fix the tests' }, plugin.root), null);
  const malformed = plugin.run(HOOK, '{not json' as unknown as Record<string, unknown>);
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(malformed.out, null);
});

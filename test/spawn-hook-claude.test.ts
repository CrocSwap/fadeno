import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CONTRACT_HEADER, REPORT_REFUSAL_SENTENCE } from './hook-sentences.ts';
import { readDispatches } from '../src/lib/ledger.ts';
import { cli, denial, hookPlugin, hookRepo } from './hook-helpers.ts';

/**
 * The spawn wrapper on Claude Code: a PreToolUse hook on the Agent tool,
 * asking the real CLI what to do and rewriting the spawn with the answer.
 */

const HOOK = 'spawn-claude.mjs';
const SESSION = 'claude-session-1';

function agentEvent(root: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { session_id: SESSION, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: input, ...extra };
}

test('spawns that name no archetype pass untouched outside host mode and are refused inside it, with the way out', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  assert.equal(plugin.run(HOOK, { tool_name: 'Bash', tool_input: { command: 'ls' } }).out, null);
  for (const input of [{ prompt: 'x', description: 'x' }, { prompt: 'x', description: 'x', subagent_type: 'general-purpose' }, { prompt: 'x', description: 'x', subagent_type: 'fadeno:dispatch' }]) {
    assert.equal(plugin.run(HOOK, agentEvent(root, input)).out, null, `host mode off: ${JSON.stringify(input)} passes`);
  }
  plugin.hostMode(SESSION, true);
  const generic = denial(plugin.run(HOOK, agentEvent(root, { prompt: 'x', description: 'x', subagent_type: 'general-purpose', model: 'opus' })));
  assert.ok(generic != null);
  assert.match(generic, /refuses generic \(non-archetype\) subagents/);
  assert.match(generic, /the model it named \(opus\)/);
  assert.match(generic, /fadeno:director, fadeno:judge, fadeno:reviewer, fadeno:scout, fadeno:worker/);
  assert.match(generic, /\/fadeno:host off/);
  assert.ok(generic.endsWith(REPORT_REFUSAL_SENTENCE));
  assert.match(denial(plugin.run(HOOK, agentEvent(root, { prompt: 'x', description: 'x' }))) ?? '', /named no subagent_type at all/);
  assert.match(denial(plugin.run(HOOK, agentEvent(root, { prompt: 'x', description: 'x', subagent_type: 'fadeno:dispatch' }))) ?? '', /named the dispatch proxy .* directly/);
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'a refusal writes nothing');
});

test('an archetype the session can deliver opens on the host lane: contract in the prompt, dial model on the spawn, row written, host told', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const run = plugin.run(HOOK, agentEvent(root, { prompt: 'Review the retry logic.', description: 'Review retry logic', subagent_type: 'fadeno:reviewer' }));
  assert.equal(run.status, 0, run.stderr);
  const out = run.out!;
  const updated = out.hookSpecificOutput.updatedInput;
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(updated.subagent_type, 'fadeno:reviewer');
  assert.equal(updated.model, 'opus', 'the reviewer dial (opus on claude) rides the spawn');
  assert.equal(updated.description, 'Review retry logic');
  assert.ok(updated.prompt.startsWith('Review the retry logic.\n\n' + CONTRACT_HEADER), updated.prompt.slice(0, 120));
  assert.match(updated.prompt, /on branch `fadeno\/review-retry-logic`/);
  const records = readDispatches(root).records;
  assert.equal(records.length, 1);
  const opened = records[0]!.opened!;
  assert.equal(opened.name, 'review-retry-logic');
  assert.equal(opened.lane, 'host');
  assert.equal(opened.harness, 'claude');
  assert.equal(opened.session, SESSION);
  assert.equal(opened.model, 'opus');
  assert.match(out.systemMessage, /fadeno: reviewer → review-retry-logic \([0-9a-f]{8}\) on opus@xhigh, host lane, branch fadeno\/review-retry-logic/);
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`Fadeno opened dispatch \`review-retry-logic\` \\(${opened.id}\\) for this reviewer spawn on the host lane: opus@xhigh`));
  assert.match(out.hookSpecificOutput.additionalContext, /fadeno dispatch-close review-retry-logic --merged\|--kept\|--discarded\|--failed/);
  assert.match(out.hookSpecificOutput.additionalContext, /No unclosed dispatches in this repository\./);

  // An undialed archetype runs on the session's own model: no model is set,
  // and one the caller passed is not carried either — Fadeno resolved it.
  const judge = plugin.run(HOOK, agentEvent(root, { prompt: 'Judge it.', description: 'Judge the two', subagent_type: 'judge' })).out!;
  assert.equal(judge.hookSpecificOutput.updatedInput.subagent_type, 'fadeno:judge');
  assert.equal('model' in judge.hookSpecificOutput.updatedInput, false);
  assert.match(judge.systemMessage, /on this session's model, host lane/);
  assert.match(judge.hookSpecificOutput.additionalContext, /## Unclosed dispatches \(1 of 5 allowed\)/, 'the second spawn is nagged about the first');

  // A repo-local agent of the same name shadows the plugin's.
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', 'judge.md'), '---\nname: judge\n---\n');
  assert.equal(plugin.run(HOOK, agentEvent(root, { prompt: 'Judge again.', description: 'Judge again', subagent_type: 'fadeno:judge' })).out!.hookSpecificOutput.updatedInput.subagent_type, 'judge');
});

test('an archetype that resolves to a process is retargeted to the dispatch proxy with the staged command, and the proxy\'s run records it', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  // An explicit model that only runs as a process takes a host-lane archetype to the command lane, override and all.
  const run = plugin.run(HOOK, agentEvent(root, { prompt: 'Fix the login bug.\n', description: 'Fix login bug', subagent_type: 'fadeno:reviewer', model: 'sol' }));
  assert.equal(run.status, 0, run.stderr);
  const out = run.out!;
  const updated = out.hookSpecificOutput.updatedInput;
  assert.equal(updated.subagent_type, 'fadeno:dispatch');
  assert.equal('model' in updated, false, 'the caller\'s model override went into the command, not onto the proxy');
  const command = updated.prompt.match(/```bash\n(.*)\n```/)?.[1];
  assert.ok(command, updated.prompt);
  assert.match(command, /^fadeno dispatch --archetype reviewer --name 'Fix login bug' --model sol --prompt-file \S+\.fadeno\/local\/relay\/\S+\.md$/);
  assert.match(updated.prompt, /relay its stdout verbatim/);
  assert.match(updated.prompt, /timeout` parameter set to 600000/);
  assert.match(out.systemMessage, /fadeno: reviewer → command lane \(sol@high on codex\); the dispatch proxy runs it as Fix login bug/);
  assert.match(out.hookSpecificOutput.additionalContext, /routed this reviewer spawn to the command lane/);
  const promptFile = command.match(/--prompt-file (\S+)$/)![1]!;
  assert.equal(readFileSync(promptFile, 'utf8'), 'Fix the login bug.\n');
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'nothing is recorded until the proxy runs the command');

  // Without an override the worker dial (sol on codex) is the executor, and running the relayed command is the dispatch.
  const plain = plugin.run(HOOK, agentEvent(root, { prompt: 'Add the header.', description: 'Add header', subagent_type: 'worker' })).out!;
  const plainCommand = plain.hookSpecificOutput.updatedInput.prompt.match(/```bash\n(.*)\n```/)![1]!;
  assert.match(plainCommand, /^fadeno dispatch --archetype worker --name 'Add header' --prompt-file /);
  const args = plainCommand.replace(/^fadeno /, '').replace(/'Add header'/, 'Add header').split(' ');
  const ran = cli(root, args.map((a) => (a === 'Add' ? 'Add header' : a)).filter((a) => a !== 'header'));
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(ran.stdout.startsWith('REPORT:Add the header.'));
  const record = readDispatches(root).records[0]!;
  assert.equal(record.opened?.name, 'add-header');
  assert.equal(record.opened?.lane, 'command');
  assert.equal(record.opened?.session, null, 'the relay carries no session: the proxy is a different process');
});

test('the limit, a resolver error, a missing CLI, a timeout and an unreadable answer each refuse with their own diagnosis', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  for (let i = 0; i < 5; i += 1) assert.equal(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host'], `job ${i}`).status, 0);
  const limited = denial(plugin.run(HOOK, agentEvent(root, { prompt: 'x', description: 'six', subagent_type: 'fadeno:reviewer' })));
  assert.match(limited ?? '', /5 dispatches are unclosed and the limit is 5/);
  assert.ok(limited!.endsWith(REPORT_REFUSAL_SENTENCE));

  const broken = hookRepo(t);
  writeFileSync(join(broken, '.fadeno', 'executors.yaml'), 'schema_version: 4\nmodels: {}\nharnesses: {}\nunknown_key: 1\n');
  const resolver = denial(plugin.run(HOOK, agentEvent(broken, { prompt: 'x', description: 'x', subagent_type: 'fadeno:worker' })));
  assert.match(resolver ?? '', /could not open the worker dispatch/);
  assert.match(resolver ?? '', /unknown/);

  plugin.fakeCli('#!/bin/sh\nprintf \'%s\\n\' not-json\nexit 0\n');
  assert.match(denial(plugin.run(HOOK, agentEvent(root, { prompt: 'x', description: 'x', subagent_type: 'fadeno:worker' }))) ?? '', /without a readable answer \(not-json\)/);
  plugin.fakeCli('#!/bin/sh\nsleep 5\n');
  assert.match(denial(plugin.run(HOOK, agentEvent(root, { prompt: 'x', description: 'x', subagent_type: 'fadeno:worker' }), { env: { FADENO_HOOK_TIMEOUT_MS: '300' } })) ?? '', /did not answer within 300ms/);
  plugin.removeCli();
  const missing = denial(plugin.run(HOOK, agentEvent(root, { prompt: 'x', description: 'x', subagent_type: 'fadeno:worker' }), { env: { PATH: '/nonexistent', CLAUDE_PLUGIN_ROOT: undefined, PLUGIN_ROOT: undefined } }));
  assert.match(missing ?? '', /the fadeno CLI was not found/);
});

test('a spawn made from inside a dispatched agent records that agent\'s dispatch as its parent, read from the agent\'s transcript', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const director = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', 'lead', '--json'], 'Lead.').stdout) as { id: string; prompt: string };
  // Claude's layout: <session transcript>.jsonl beside <session id>/subagents/agent-<id>.jsonl
  const transcripts = join(plugin.root, 'transcripts');
  const sessionTranscript = join(transcripts, `${SESSION}.jsonl`);
  mkdirSync(join(transcripts, SESSION, 'subagents'), { recursive: true });
  writeFileSync(sessionTranscript, '');
  writeFileSync(join(transcripts, SESSION, 'subagents', 'agent-abc123.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: director.prompt } }) + '\n');
  const run = plugin.run(HOOK, agentEvent(root, { prompt: 'Child work.', description: 'Child work', subagent_type: 'fadeno:reviewer' }, { agent_id: 'abc123', agent_type: 'fadeno:judge', transcript_path: sessionTranscript }));
  assert.equal(run.status, 0, run.stderr);
  const child = readDispatches(root).records.find((r) => r.opened?.name === 'child-work')!;
  assert.equal(child.opened?.parent, director.id);
});

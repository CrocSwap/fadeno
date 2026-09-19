import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readDispatches } from '../src/lib/ledger.ts';
import { cli, hookPlugin, hookRepo } from './hook-helpers.ts';

/**
 * The stop hook, one file for Claude Code and Codex: hand the transcript and
 * the last message to `fadeno dispatch-stop`, which finds the dispatch by the
 * contract header in the agent's prompt. An agent with no contract is not a
 * dispatch and leaves no row.
 */

const HOOK = 'agent-stop.mjs';

function record(o: unknown): string {
  return JSON.stringify(o) + '\n';
}

function stopEvent(root: string, transcript: string, extra: Record<string, unknown> = {}) {
  return { session_id: 's', cwd: root, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'fadeno:worker', agent_transcript_path: transcript, stop_hook_active: false, ...extra };
}

test('a dispatched agent\'s stop is recorded from its transcript, with the message the harness passed and the model that ran', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'reviewer', '--lane', 'host', '--name', 'rev', '--json'], 'Review.').stdout) as { id: string; prompt: string; cwd: string };
  writeFileSync(join(opened.cwd, 'notes.md'), 'x\n');
  const transcript = join(plugin.root, 'agent-a1.jsonl');
  writeFileSync(transcript,
    record({ type: 'user', message: { role: 'user', content: opened.prompt } }) +
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-7', content: [{ type: 'text', text: 'Looks fine; merge it.' }] } }));
  const run = plugin.run(HOOK, stopEvent(root, transcript, { last_assistant_message: 'Looks fine; merge it.' }));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.out!.systemMessage, /fadeno: dispatch rev stopped; stop recorded durably; worktree inspection deferred; ran on claude-sonnet-4-7, not the dialed opus\. Close it: fadeno dispatch-close rev --merged\|--kept\|--discarded\|--failed\|--reviewed/);
  const stopped = readDispatches(root).records[0]!.stopped!;
  assert.equal(stopped.final_message, 'Looks fine; merge it.');
  assert.equal(stopped.model_observed, 'claude-sonnet-4-7');
  const enriched = cli(root, ['dispatch-stop', 'rev', '--json'], 'Looks fine; merge it.');
  assert.equal(enriched.status, 0, enriched.stderr);
  assert.deepEqual(readDispatches(root).records[0]!.stopped!.dirty, { paths: ['notes.md'], truncated: false });
  // A second stop for the same agent is a replay, said so.
  assert.match(plugin.run(HOOK, stopEvent(root, transcript, { last_assistant_message: 'again' })).out!.systemMessage, /already recorded/);
});

test('on the interrupted path the harness passes no message; the transcript\'s last words stand in, and a session-model dispatch draws no model warning', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', 'jj', '--json'], 'Judge.').stdout) as { prompt: string };
  const transcript = join(plugin.root, 'agent-a2.jsonl');
  writeFileSync(transcript,
    record({ type: 'user', message: { role: 'user', content: opened.prompt } }) +
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'Halfway through the comparison' }] } }));
  const run = plugin.run(HOOK, stopEvent(root, transcript, { turn_id: 'codex-turn' }));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.out!.systemMessage, /dispatch jj stopped; stop recorded durably; worktree inspection deferred\. Close it/);
  const stopped = readDispatches(root).records[0]!.stopped!;
  assert.equal(stopped.final_message, 'Halfway through the comparison');
  assert.equal(stopped.model_observed, 'claude-fable-5-1');
});

test('a durable stop is fast and replay enriches its worktree evidence idempotently', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'reviewer', '--lane', 'host', '--name', 'deferred', '--json'], 'Review.').stdout) as { prompt: string };
  const transcript = join(plugin.root, 'agent-deferred.jsonl');
  writeFileSync(transcript, record({ type: 'user', message: { role: 'user', content: opened.prompt } }));

  const first = plugin.run(HOOK, stopEvent(root, transcript, { last_assistant_message: 'final response' }));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.out?.systemMessage ?? '', /stop recorded durably; worktree inspection deferred/);
  const durable = readDispatches(root).records[0]!.stopped!;
  assert.equal(durable.evidence, 'durable');
  assert.equal(durable.final_message, 'final response');
  assert.equal(durable.dirty, 'unavailable');
  assert.deepEqual(readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).row), ['opened', 'stopped']);

  const replay = cli(root, ['dispatch-stop', 'deferred', '--json'], 'final response');
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  const enriched = readDispatches(root).records[0]!.stopped!;
  assert.equal(enriched.evidence, 'inspected');
  assert.deepEqual(enriched.dirty, { paths: [], truncated: false });
  assert.deepEqual(readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).row), ['opened', 'stopped', 'stopped']);
});

test('a stop-recording failure is visible and gives an idempotent replay command', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.fakeCli('#!/bin/sh\nsleep 0.05\nprintf "%s\\n" "ledger is not writable" >&2\nexit 1\n');
  const transcript = join(plugin.root, 'agent-failing-stop.jsonl');
  writeFileSync(transcript, record({ type: 'user', message: { role: 'user', content: 'not enough to identify a dispatch' } }));
  const run = plugin.run(HOOK, stopEvent(root, transcript, { last_assistant_message: 'the final response' }), {
    // Other hooks inherit this budget. The stop receipt deliberately does
    // not: the harness owns its lifetime, so this delayed CLI still answers.
    env: { FADENO_HOOK_TIMEOUT_MS: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.out?.systemMessage ?? '', /could not record the stopped dispatch/);
  assert.match(run.out?.systemMessage ?? '', /ledger is not writable/);
  assert.match(run.out?.systemMessage ?? '', /save the received final response to a file and replay idempotently with/);
  assert.match(run.out?.systemMessage ?? '', /fadeno.*dispatch-stop.*--agent-id.*a1/);
});

test('an agent with no contract, a missing transcript, a missing cwd, and a foreign event all leave nothing behind', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  const foreign = join(plugin.root, 'agent-a3.jsonl');
  writeFileSync(foreign, record({ type: 'user', message: { role: 'user', content: 'Explore the repo.' } }));
  assert.equal(plugin.run(HOOK, stopEvent(root, foreign, { last_assistant_message: 'done' })).out, null);
  assert.equal(plugin.run(HOOK, stopEvent(root, join(plugin.root, 'nope.jsonl'))).out, null);
  assert.equal(plugin.run(HOOK, { ...stopEvent(root, foreign), cwd: undefined }).out, null);
  assert.equal(plugin.run(HOOK, { ...stopEvent(root, foreign), hook_event_name: 'Stop' }).out, null);
  assert.equal(plugin.run(HOOK, 'not an object').out, null);
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')));
});

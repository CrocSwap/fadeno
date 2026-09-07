import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REPORT_REFUSAL_SENTENCE } from './hook-sentences.ts';
import { cli, denial, hookPlugin, hookRepo } from './hook-helpers.ts';

/**
 * The spawn hook on Codex, whose PreToolUse can refuse a call and nothing
 * else: in host mode every spawn is answered with a refusal that carries the
 * way through — the staged `fadeno dispatch` command for an archetype, the
 * archetype list for anything else. Outside host mode Fadeno stays silent.
 */

const HOOK = 'spawn-codex.mjs';
const SESSION = 'codex-session-1';

function spawnEvent(root: string, input: Record<string, unknown>) {
  return { session_id: SESSION, cwd: root, hook_event_name: 'PreToolUse', model: 'gpt-6-astra', tool_name: 'Agent', tool_use_id: 'call-1', turn_id: 'turn-1', tool_input: input };
}

test('outside host mode every spawn passes; other tools always pass', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  assert.equal(plugin.run(HOOK, { tool_name: 'Bash', tool_input: { command: 'ls' } }).out, null);
  assert.equal(plugin.run(HOOK, spawnEvent(root, { agent_type: 'explorer', message: 'look' })).out, null);
  assert.equal(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: 'work' })).out, null);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'relay')), 'nothing staged when Fadeno has no opinion');
});

test('in host mode a generic spawn is refused with the identity it would have inherited and the archetypes to name instead', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'explorer', message: 'look' })));
  assert.ok(reason != null);
  assert.match(reason, /asked for agent_type "explorer"/);
  assert.match(reason, /this session's model \(gpt-6-astra\)/);
  assert.match(reason, /spawn one of director, judge, reviewer, scout, worker/);
  assert.match(reason, /\$fadeno-host off/);
  assert.ok(reason.endsWith(REPORT_REFUSAL_SENTENCE));
  assert.match(denial(plugin.run(HOOK, spawnEvent(root, { message: 'look' }))) ?? '', /"\(unnamed\)"/);
});

test('in host mode an archetype spawn is refused with the exact staged command that runs it, and the nag', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', 'earlier'], 'x');
  const run = plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: 'Fix the login bug.\n', model: 'sol' }));
  assert.equal(run.status, 0, run.stderr);
  const reason = denial(run);
  assert.ok(reason != null);
  assert.match(reason, /this worker spawn goes through the command lane \(sol@high on codex\)/);
  assert.match(reason, /a hook can refuse a spawn but not rewrite it/);
  const command = reason.match(/\n\n    (fadeno dispatch [^\n]+)\n\n/)?.[1];
  assert.ok(command, reason);
  assert.match(command, /^fadeno dispatch --archetype worker --model sol --prompt-file \S+\.fadeno\/local\/relay\/\S+\.md$/);
  assert.equal(readFileSync(command.match(/--prompt-file (\S+)$/)![1]!, 'utf8'), 'Fix the login bug.\n');
  assert.match(reason, /## Unclosed dispatches \(1 of 5 allowed\)/);
  assert.match(reason, /fadeno dispatch-close worker --merged/);
  assert.ok(reason.endsWith(REPORT_REFUSAL_SENTENCE));

  // Nothing to invoke: the session's own model has no command lane, so the refusal says how to open it by hand.
  const byHand = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'judge', message: 'Judge it.' })));
  assert.match(byHand ?? '', /resolves to this session's own model and has no command lane/);
  assert.match(byHand ?? '', /fadeno dispatch-open --archetype judge --lane host --prompt-file <file> --json/);

  // At the limit the refusal is the limit's.
  for (let i = 0; i < 4; i += 1) cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host'], `job ${i}`);
  assert.match(denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: 'more' }))) ?? '', /5 dispatches are unclosed and the limit is 5/);
});

test('a broken catalog refuses with the resolver\'s own words rather than letting an unverified spawn through', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), 'schema_version: 4\nmodels: {}\nharnesses: {}\nunknown_key: 1\n');
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: 'x' })));
  assert.match(reason ?? '', /could not stage the worker dispatch/);
  assert.match(reason ?? '', /unknown/);
});

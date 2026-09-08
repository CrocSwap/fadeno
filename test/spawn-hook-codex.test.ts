import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readDispatches } from '../src/lib/ledger.ts';
import { REPORT_REFUSAL_SENTENCE } from './hook-sentences.ts';
import { cli, denial, hookPlugin, hookRepo } from './hook-helpers.ts';

/**
 * The spawn hook on Codex, whose PreToolUse can refuse a call and nothing
 * else. The host lane is therefore a two-pass handshake: the first spawn is
 * refused with the corrected one to make, and the corrected spawn — which
 * carries the dispatch contract Fadeno wrote — is let through in silence.
 * A model this session cannot deliver takes the command lane instead, and is
 * refused with the command that runs it. Outside host mode Fadeno is silent.
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
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'nothing opened when Fadeno has no opinion');
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

test('the host lane is a handshake: the first spawn is refused with the corrected one, and the corrected one passes', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);

  // Pass 1. `worker` dials to sol, whose home harness IS this host, so the
  // dispatch opens in-session — and the refusal carries the spawn to make.
  const first = plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', task_name: 'login-fix', message: 'Fix the login bug.\n' }));
  assert.equal(first.status, 0, first.stderr);
  const reason = denial(first);
  assert.ok(reason != null);
  assert.match(reason, /dispatch login-fix \([0-9a-f-]{36}\) is open and routed to sol@high/);
  assert.match(reason, /agent_type: "worker"/);
  assert.match(reason, /model: "gpt-5\.6-sol"/, 'the provider id, not the alias — that is what a spawn takes');
  assert.match(reason, /reasoning_effort: "high"/);
  assert.match(reason, /a hook can refuse a spawn but not rewrite one/);
  assert.match(reason, /fadeno dispatch-close login-fix --merged/);
  assert.ok(reason.endsWith(REPORT_REFUSAL_SENTENCE));

  // The prompt is a file, not four hundred lines of refusal text to copy.
  const promptFile = reason.match(/message: the exact contents of (\S+)/)?.[1];
  assert.ok(promptFile, reason);
  const composed = readFileSync(promptFile, 'utf8');
  assert.match(composed, /^Fix the login bug\./);
  assert.match(composed, /## Fadeno dispatch [0-9a-f-]{36} \(login-fix\)/);

  // The dispatch is recorded, on the host lane, with the id that travelled.
  const record = readDispatches(root).records[0]!;
  assert.equal(record.opened!.lane, 'host');
  assert.equal(record.opened!.name, 'login-fix');
  assert.equal(record.opened!.model, 'sol');
  assert.equal(record.opened!.model_id, 'gpt-5.6-sol');

  // Pass 2. The corrected spawn carries the contract, the model and the
  // effort, so it passes — and says what it is running.
  //
  // A Codex PreToolUse hook that emits `hookEventName` + `additionalContext`
  // and NO decision both passes the call and delivers that text (verified on
  // Codex 0.153.4). Until this, a Codex host heard the dispatch name, its
  // worktree and the close command only when it was REFUSED; the spawn that
  // actually worked was silent.
  const corrected = plugin.run(HOOK, spawnEvent(root, {
    agent_type: 'worker', task_name: 'login-fix', message: composed, model: 'gpt-5.6-sol', reasoning_effort: 'high',
  }));
  const passed = corrected.out as { hookSpecificOutput?: Record<string, unknown> } | null;
  assert.ok(passed != null, corrected.stdout);
  const out = passed.hookSpecificOutput!;
  // Exactly two keys: any permissionDecision but deny, or a reason without a
  // decision, makes Codex mark the hook Failed and discard the context.
  assert.deepEqual(Object.keys(out).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(out.hookEventName, 'PreToolUse');
  const context = out.additionalContext as string;
  assert.match(context, /Fadeno opened dispatch `login-fix` \([0-9a-f-]{36}\) for this worker spawn, per the worker dial: gpt-5\.6-sol@high/);
  assert.match(context, /branch `fadeno\/login-fix`/);
  assert.match(context, /fadeno dispatch-close login-fix --merged/);
  // The nag is not repeated: pass 1's refusal already carried one.
  assert.doesNotMatch(context, /Unclosed dispatches/);
  assert.equal(readDispatches(root).records.length, 1, 'letting a spawn through opens nothing new');
});

test('a corrected spawn is checked against the dispatch it carries, not taken on trust', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'w1', '--json'], 'Do it.', { FADENO_HARNESS: 'codex' }).stdout) as { id: string; prompt: string };

  // The right contract, the wrong model: the dial decides, and the refusal
  // says which model to use rather than letting the work run on another.
  const wrongModel = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: opened.prompt, model: 'opus', reasoning_effort: 'high' })));
  assert.match(wrongModel ?? '', /was opened for gpt-5\.6-sol@high, and this spawn carries opus@high/);
  assert.match(wrongModel ?? '', /model="gpt-5\.6-sol" and reasoning_effort="high"/);

  // No model at all inherits the session's, which is exactly what the dial
  // exists to prevent.
  assert.match(denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: opened.prompt }))) ?? '', /no model \(it would inherit this session's\)/);

  // The right contract on the wrong archetype.
  assert.match(
    denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'judge', message: opened.prompt, model: 'gpt-5.6-sol', reasoning_effort: 'high' }))) ?? '',
    /asks for `judge` but carries the contract for dispatch .* opened for `worker`/,
  );

  // A contract for a dispatch that has already stopped: one contract, one agent.
  cli(root, ['dispatch-stop', 'w1'], 'done', { FADENO_HARNESS: 'codex' });
  assert.match(
    denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: opened.prompt, model: 'gpt-5.6-sol', reasoning_effort: 'high' }))) ?? '',
    /already stopped/,
  );

  // A contract Fadeno never wrote.
  const forged = `Do it.\n\n## Fadeno dispatch 11111111-2222-3333-4444-555555555555 (ghost)\n`;
  assert.match(
    denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: forged, model: 'gpt-5.6-sol' }))) ?? '',
    /could not be read back/,
  );
});

test('a fumbled retry reuses the dispatch it was already given rather than cutting another worktree', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const ids = [0, 1, 2].map(() => {
    const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', task_name: 'same-task', message: 'Fix it.' })));
    return reason!.match(/dispatch same-task \(([0-9a-f-]{36})\)/)![1];
  });
  assert.equal(new Set(ids).size, 1, 'three refused attempts, one dispatch');
  assert.equal(readDispatches(root).records.length, 1);
  assert.match(
    denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', task_name: 'same-task', message: 'Fix it.' })))!,
    /is already open/,
  );
});

test('a model this session cannot deliver takes the command lane, refused with the command that runs it', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t, { dials: { worker: 'opus' } });
  plugin.hostMode(SESSION, true);
  cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', 'earlier'], 'x');
  // `opus` lives on claude; this session is codex, so it can only be spawned.
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: 'Fix the login bug.\n' })));
  assert.ok(reason != null);
  assert.match(reason, /this worker spawn goes through the command lane \(opus@xhigh on claude\)/);
  assert.match(reason, /runs as a process, not as a subagent/);
  const command = reason.match(/\n\n    (fadeno dispatch [^\n]+)\n\n/)?.[1];
  assert.ok(command, reason);
  assert.match(command, /^fadeno dispatch --archetype worker --prompt-file \S+\.fadeno\/local\/relay\/\S+\.md$/);
  assert.equal(readFileSync(command.match(/--prompt-file (\S+)$/)![1]!, 'utf8'), 'Fix the login bug.\n');
  assert.match(reason, /## Unclosed dispatches \(1; 0 of 5 allowed are waiting on you\)/);
  assert.ok(reason.endsWith(REPORT_REFUSAL_SENTENCE));
});

test('an archetype with no lane at all is refused by name, not opened', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  // `omp` is a host Fadeno can run inside and cannot spawn, and `stray` lives
  // there. From a codex session that model has neither lane — and that is a
  // refusal, never a dispatch opened against nothing.
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), [
    'schema_version: 4',
    'models:',
    '  sol: { provider: openai, id: gpt-5.6-sol, effort: high }',
    '  stray: { provider: ompco, id: stray-1, harness: omp }',
    'harnesses:',
    '  codex: { provider: openai, host: { effort_channel: agent-file }, command: [codex, exec] }',
    '  omp: { host: { effort_channel: none, identity: model } }',
    'archetypes: { worker: {} }',
    'dials: { worker: stray }',
    '',
  ].join('\n'));
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: 'x' })));
  assert.match(reason ?? '', /neither deliver in-session nor run as a process, so there is no lane for it here/);
  assert.match(reason ?? '', /fadeno dial worker host/);
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'a refusal opens nothing');
});

test('the limit and a broken catalog each refuse with their own diagnosis', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  // Five dispatches STOPPED and unread. Five still running would refuse
  // nothing: the limit counts work waiting on a person.
  for (let i = 0; i < 5; i += 1) {
    cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', `j${i}`], `job ${i}`);
    cli(root, ['dispatch-stop', `j${i}`], 'done', { FADENO_HARNESS: 'codex' });
  }
  assert.match(denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'worker', message: 'more' }))) ?? '', /dispatches have stopped and are waiting for your decision, and the limit is 5/);

  const broken = hookRepo(t);
  writeFileSync(join(broken, '.fadeno', 'executors.yaml'), 'schema_version: 4\nmodels: {}\nharnesses: {}\nunknown_key: 1\n');
  const reason = denial(plugin.run(HOOK, spawnEvent(broken, { agent_type: 'worker', message: 'x' })));
  assert.match(reason ?? '', /could not open the worker dispatch/);
  assert.match(reason ?? '', /unknown/);
});

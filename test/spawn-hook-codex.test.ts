import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readDispatches } from '../src/lib/ledger.ts';
import { REPORT_REFUSAL_SENTENCE } from './hook-sentences.ts';
import { cli, denial, hookPlugin, hookRepo } from './hook-helpers.ts';

/**
 * The spawn hook on Codex, across the two events it lives in.
 *
 * A Codex hook can refuse a call and cannot rewrite one — `updatedInput` is
 * gated shut on PreToolUse and reserved-for-future on PermissionRequest — so
 * Fadeno cannot put a contract on the prompt. It does not need to:
 * `SubagentStart` delivers `additionalContext` to the SUBAGENT, so the
 * contract is handed over rather than composed in.
 *
 * That splits the work by what each event can know. PreToolUse sees the model
 * and the message but not which subagent they become, so it REFUSES (a generic
 * spawn, a mis-dialed model, the unclosed limit) and otherwise gets out of the
 * way. SubagentStart sees the agent id, so it OPENS — worktree, row, contract —
 * with a binding that cannot be mismatched.
 */

const HOOK = 'spawn-codex.mjs';
const SESSION = 'codex-session-1';

/**
 * A spawn as Codex actually delivers it. `tool_name` defaults to the newer
 * `collaborationspawn_agent`, which is what gpt-6-astra sends: the hook that
 * matched only `Agent`/`spawn_agent` was silent on that whole model family,
 * and every test below would have passed anyway.
 */
function spawnEvent(root: string, input: Record<string, unknown>, toolName = 'collaborationspawn_agent') {
  return { session_id: SESSION, cwd: root, hook_event_name: 'PreToolUse', model: 'gpt-6-astra', tool_name: toolName, tool_use_id: 'call-1', turn_id: 'turn-1', tool_input: input };
}

function startEvent(root: string, agentType: string, agentId: string) {
  return { session_id: SESSION, cwd: root, hook_event_name: 'SubagentStart', model: 'gpt-5.6-sol', turn_id: 'turn-1', agent_id: agentId, agent_type: agentType };
}

/** The `additionalContext` a passing hook carries, asserting the shape Codex requires. */
function context(run: { out: Record<string, any> | null; stdout: string }): string {
  assert.ok(run.out != null, run.stdout);
  const out = run.out.hookSpecificOutput as Record<string, unknown>;
  // Exactly two keys: any permissionDecision but deny, or a reason without a
  // decision, makes Codex mark the hook Failed, run the call, and discard this.
  assert.deepEqual(Object.keys(out).sort(), ['additionalContext', 'hookEventName']);
  return out.additionalContext as string;
}

test('outside host mode every spawn passes; other tools always pass', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  assert.equal(plugin.run(HOOK, { tool_name: 'Bash', tool_input: { command: 'ls' } }).out, null);
  assert.equal(plugin.run(HOOK, spawnEvent(root, { agent_type: 'explorer', message: 'look' })).out, null);
  assert.equal(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: 'work' })).out, null);
  assert.equal(plugin.run(HOOK, startEvent(root, 'fadeno-worker', 'agent-1')).out, null);
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'nothing opened when Fadeno has no opinion');
});

test('the spawn tool is recognized by every name Codex gives it, not the one model happened to use', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  // Measured on 0.153.4: gpt-5.6-luna calls it `spawn_agent`, gpt-6-astra
  // `collaborationspawn_agent`, Claude `Agent`. Fadeno's hook matched two of
  // the three and was therefore absent on astra, where three unhooked
  // subagents once ran for 71 minutes.
  for (const toolName of ['collaborationspawn_agent', 'spawn_agent', 'Agent', 'multi_agent_v2spawn_agent']) {
    const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'explorer', message: 'x' }, toolName)));
    assert.match(reason ?? '', /refuses generic \(non-archetype\) subagents/, toolName);
  }
  // A tool that merely contains the word is not the spawn tool.
  assert.equal(plugin.run(HOOK, spawnEvent(root, { command: 'ls' }, 'spawn_agent_logs')).out, null);
});

test('in host mode a generic spawn is refused with the identity it would have inherited and the archetypes to name instead', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'explorer', message: 'look' })));
  assert.ok(reason != null);
  assert.match(reason, /asked for agent_type "explorer"/);
  assert.match(reason, /this session's model \(gpt-6-astra\)/);
  // The Codex spelling, which is what `fadeno setup` writes into
  // `$CODEX_HOME/agents/` — a bare `worker` names nothing there.
  assert.match(reason, /`fadeno-worker`/);
  assert.match(reason, /`fadeno-director`/);
  assert.match(reason, /\$fadeno-host off/);
  assert.ok(reason.endsWith(REPORT_REFUSAL_SENTENCE));
  assert.match(denial(plugin.run(HOOK, spawnEvent(root, { message: 'look' }))) ?? '', /"\(unnamed\)"/);
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'a refusal opens nothing');
});

test('a correctly dialed spawn passes and opens NOTHING; the dispatch is opened when the agent starts', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);

  const passed = plugin.run(HOOK, spawnEvent(root, {
    agent_type: 'fadeno-worker', task_name: 'login-fix', message: 'Fix the login bug.\n', model: 'gpt-5.6-sol', reasoning_effort: 'high',
  }));
  const told = context(passed);
  assert.match(told, /Fadeno is opening a `worker` dispatch for this spawn on sol@high/);
  assert.match(told, /fadeno dispatch-close <name>/);
  // Nothing is written at PreToolUse. A spawn that is refused later, or never
  // becomes an agent, must not leave a row or a worktree behind.
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'PreToolUse opens nothing');

  // The agent starts, and NOW the dispatch exists — bound to this agent id.
  const started = plugin.run(HOOK, startEvent(root, 'fadeno-worker', 'agent-7'));
  const contract = context(started);
  assert.match(contract, /^## Fadeno dispatch [0-9a-f-]{36} \(login-fix\)/);
  assert.match(contract, /Fadeno opened this as dispatch `login-fix`/);
  assert.match(contract, /branch fadeno\/login-fix/);

  const record = readDispatches(root).records[0]!;
  assert.equal(readDispatches(root).records.length, 1);
  assert.equal(record.opened!.lane, 'host');
  assert.equal(record.opened!.name, 'login-fix');
  assert.equal(record.opened!.model, 'sol');
  assert.equal(record.opened!.agent_id, 'agent-7', 'the binding a stop hook resolves by');
  // The task crossed from PreToolUse, which is the only event that saw it.
  assert.equal(record.opened!.task, 'Fix the login bug.');
  assert.equal(record.opened!.prompt_sealed, undefined);
});

test('the stop hook resolves by agent id, without reading a transcript', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', task_name: 'w1', message: 'Do it.', model: 'gpt-5.6-sol', reasoning_effort: 'high' }));
  plugin.run(HOOK, startEvent(root, 'fadeno-worker', 'agent-9'));

  const stopped = plugin.run('agent-stop.mjs', {
    session_id: SESSION, cwd: root, hook_event_name: 'SubagentStop', turn_id: 'turn-1',
    agent_id: 'agent-9', agent_type: 'fadeno-worker', agent_transcript_path: null, last_assistant_message: 'done',
  });
  assert.match(stopped.out?.systemMessage ?? '', /dispatch w1 stopped/);
  assert.match(stopped.out?.systemMessage ?? '', /fadeno dispatch-close w1/);
  assert.notEqual(readDispatches(root).records[0]!.stopped, null);
});

test('a message Codex encrypted is recorded as sealed, never as the task', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  // What gpt-6-astra actually sends: a Fernet token where the prompt should be.
  const ciphertext = `gAAAAABqoMPH${'3dC8T7a2foTpusoqb_4ryG0ZTjYcYJX63MZyw3dpVrcZNoJmqiOqork5QPkOXA5H'.repeat(2)}`;
  const told = context(plugin.run(HOOK, spawnEvent(root, {
    agent_type: 'fadeno-worker', task_name: 'sealed-one', message: ciphertext, model: 'gpt-5.6-sol', reasoning_effort: 'high',
  })));
  assert.match(told, /Codex encrypted the message on this spawn/);
  plugin.run(HOOK, startEvent(root, 'fadeno-worker', 'agent-3'));

  const opened = readDispatches(root).records[0]!.opened!;
  assert.equal(opened.prompt_sealed, true, 'a flag, so no reader has to parse prose to know');
  assert.equal(opened.name, 'sealed-one', 'the task NAME still crosses; only the prompt is sealed');
  assert.doesNotMatch(opened.task, /gAAAAA/, 'the ciphertext is never presented as the ask');
  assert.match(opened.task, /Fadeno did not see this dispatch's prompt/);
  assert.match(readFileSync(join(root, opened.prompt), 'utf8'), /Codex encrypted the spawn's message/);
});

test('two spawns of one archetype in flight: Fadeno declines to guess which prompt is whose', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  // Both PreToolUse events land before either SubagentStart — measured, and
  // the reason nothing consequential may depend on matching them up.
  plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', task_name: 'alpha', message: 'Do ALPHA.', model: 'gpt-5.6-sol', reasoning_effort: 'high' }));
  plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', task_name: 'bravo', message: 'Do BRAVO.', model: 'gpt-5.6-sol', reasoning_effort: 'high' }));

  plugin.run(HOOK, startEvent(root, 'fadeno-worker', 'agent-a'));
  plugin.run(HOOK, startEvent(root, 'fadeno-worker', 'agent-b'));

  const records = readDispatches(root).records;
  assert.equal(records.length, 2, 'both dispatches exist, each bound to its own agent');
  assert.deepEqual(records.map((r) => r.opened!.agent_id).sort(), ['agent-a', 'agent-b']);
  for (const record of records) {
    // Guessing would have put one agent's task on the other's row half the
    // time. The absence is recorded instead, with the reason.
    assert.equal(record.opened!.prompt_sealed, true);
    assert.match(record.opened!.task, /2 worker spawns were in flight at once/);
    // Each still got its OWN worktree and branch: the binding that matters is
    // made at SubagentStart against the agent id and was never in doubt.
    assert.ok(record.opened!.workspace?.branch != null);
  }
  assert.equal(new Set(records.map((r) => r.opened!.workspace!.branch)).size, 2);
});

test('the dial decides the model, and a spawn that carries another is refused with the call to make', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);

  const wrong = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: 'x', model: 'opus', reasoning_effort: 'high' })));
  assert.match(wrong ?? '', /`worker` is dialed to sol@high \(gpt-5\.6-sol\), and this spawn carries opus/);
  assert.match(wrong ?? '', /model="gpt-5\.6-sol" and reasoning_effort="high"/);
  assert.match(wrong ?? '', /nothing has been opened, so nothing is left behind/);

  // No model at all inherits the session's, which is what the dial exists to prevent.
  assert.match(
    denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: 'x' }))) ?? '',
    /no model, so it would inherit this session's/,
  );
  // The right model, the wrong effort.
  assert.match(
    denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: 'x', model: 'gpt-5.6-sol', reasoning_effort: 'low' }))) ?? '',
    /carries reasoning_effort="low"/,
  );
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'every one of those opened nothing');
});

test('a model this session cannot deliver takes the command lane, refused with the command that runs it', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t, { dials: { worker: 'opus' } });
  plugin.hostMode(SESSION, true);
  cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', 'earlier'], 'x');
  // `opus` lives on claude; this session is codex, so it can only be spawned.
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: 'Fix the login bug.\n' })));
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

test('a sealed message on the command lane cannot be staged, and says so instead of staging a blob', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t, { dials: { worker: 'opus' } });
  plugin.hostMode(SESSION, true);
  const ciphertext = `gAAAAABqoMPH${'x_-A9'.repeat(40)}`;
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: ciphertext })));
  assert.match(reason ?? '', /Codex encrypted the message on this spawn, so Fadeno cannot stage the task for it/);
  assert.match(reason ?? '', /fadeno dispatch --archetype worker --name <name> --prompt-file <file>/);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'relay')), 'nothing was staged');
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
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: 'x' })));
  assert.match(reason ?? '', /neither deliver in-session nor run as a process, so there is no lane for it here/);
  assert.match(reason ?? '', /fadeno dial worker host/);
  assert.ok(!existsSync(join(root, '.fadeno', 'dispatches.jsonl')), 'a refusal opens nothing');
});

test('the limit refuses the spawn, not the agent that already started', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  // Five dispatches STOPPED and unread. Five still running would refuse
  // nothing: the limit counts work waiting on a person.
  for (let i = 0; i < 5; i += 1) {
    cli(root, ['dispatch-open', '--archetype', 'judge', '--lane', 'host', '--name', `j${i}`], `job ${i}`);
    cli(root, ['dispatch-stop', `j${i}`], 'done', { FADENO_HARNESS: 'codex' });
  }
  // The open now happens at SubagentStart, one event AFTER the last point a
  // spawn can be stopped. A limit enforced only there would let the agent
  // start and then leave it running with no contract, so the check moved
  // forward — into the same dry run that resolves the lane.
  const reason = denial(plugin.run(HOOK, spawnEvent(root, { agent_type: 'fadeno-worker', message: 'more', model: 'gpt-5.6-sol', reasoning_effort: 'high' })));
  assert.match(reason ?? '', /dispatches have stopped and are waiting for your decision, and the limit is 5/);
  assert.equal(readDispatches(root).records.length, 5, 'the sixth was never opened');
});

test('a broken catalog refuses the spawn; a broken open tells the agent it has no contract', (t) => {
  const plugin = hookPlugin(t);
  const broken = hookRepo(t);
  plugin.hostMode(SESSION, true);
  writeFileSync(join(broken, '.fadeno', 'executors.yaml'), 'schema_version: 4\nmodels: {}\nharnesses: {}\nunknown_key: 1\n');
  const reason = denial(plugin.run(HOOK, spawnEvent(broken, { agent_type: 'fadeno-worker', message: 'x' })));
  assert.match(reason ?? '', /could not be routed/);
  assert.match(reason ?? '', /unknown/);

  // At SubagentStart there is nothing left to refuse — the agent is running.
  // The one thing that helps is telling it what it does NOT have, so it says
  // so rather than proceeding as though it had a contract.
  const started = plugin.run(HOOK, startEvent(broken, 'fadeno-worker', 'agent-x'));
  const told = context(started);
  assert.match(told, /You have NO dispatch contract/);
  assert.match(told, /commit nothing, change no branch/);
  assert.match(told, /say plainly at the top of your report/);
});

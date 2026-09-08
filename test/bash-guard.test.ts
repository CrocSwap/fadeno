import assert from 'node:assert/strict';
import test from 'node:test';
import { REPORT_REFUSAL_SENTENCE } from './hook-sentences.ts';
import { denial, hookPlugin, type HookRun } from './hook-helpers.ts';

/**
 * The Bash guard: the dispatch proxy runs one command; a dispatched agent
 * keeps its hands off the six git subcommands that destroy shared work
 * unless the call says it runs in the agent's own worktree.
 */

const HOOK = 'bash-guard.mjs';

function bash(agentType: string | undefined, command: string, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...extra }, ...(agentType != null ? { agent_type: agentType } : {}), ...top };
}

const RELAY = "fadeno dispatch --archetype worker --name 'Fix login' --prompt-file /repo/.fadeno/local/relay/20260907T120000Z-fix-login-ab12.md";

function updated(run: HookRun): Record<string, unknown> | undefined {
  return run.out?.hookSpecificOutput?.updatedInput;
}

test('the guard is silent for other tools, the main session, and generic subagents', (t) => {
  const plugin = hookPlugin(t);
  assert.equal(plugin.run(HOOK, { tool_name: 'Agent', tool_input: {} }).out, null);
  assert.equal(plugin.run(HOOK, bash(undefined, 'git reset --hard')).out, null);
  assert.equal(plugin.run(HOOK, bash('general-purpose', 'git reset --hard')).out, null);
  assert.equal(plugin.run(HOOK, bash('Explore', 'git checkout -- x')).out, null);
});

test('the dispatch proxy may run its relay command and the recovery read, gets the long timeout on the dispatch leg, and nothing else', (t) => {
  const plugin = hookPlugin(t);
  for (const agent of ['dispatch', 'fadeno:dispatch']) {
    assert.deepEqual(updated(plugin.run(HOOK, bash(agent, RELAY))), { command: RELAY, timeout: 600000 }, agent);
    assert.equal(plugin.run(HOOK, bash(agent, RELAY, { timeout: 600000 })).out, null, 'an already-long timeout passes through');
    assert.equal(plugin.run(HOOK, bash(agent, 'fadeno dispatches --output fix-login')).out, null, 'the recovery read passes');
    // The wait loop is contract, not inspection: a dispatch outrunning the
    // harness's shell ceiling is ordinary, and asking again is how the proxy
    // finishes honestly instead of relaying a half-written log.
    assert.equal(plugin.run(HOOK, bash(agent, 'fadeno dispatch-wait fix-login')).out, null, 'the wait passes');
    assert.equal(plugin.run(HOOK, bash(agent, "fadeno dispatch-wait 'Fix the login bug' --wait-seconds 540")).out, null, 'quoted name and bound');
  }
  for (const spelling of [
    '"$CLAUDE_PLUGIN_ROOT/bin/fadeno" dispatch --archetype reviewer --prompt-file /r/.fadeno/local/relay/x.md',
    'FADENO_HARNESS=omp "${FADENO_CLI:-fadeno}" dispatch --archetype judge --name judge-it --model opus --shared --prompt-file "/r/.fadeno/local/relay/x y.md"',
    '/plugin/bin/fadeno dispatch --archetype director --parent 0f0f0f0f-0000-4000-8000-000000000000 --prompt-file /r/.fadeno/local/relay/x.md',
  ]) {
    assert.ok(updated(plugin.run(HOOK, bash('fadeno:dispatch', spelling))) != null, spelling);
  }
  for (const [command, why] of [
    ['ls -la', 'inspection'],
    ['cat /repo/.fadeno/local/relay/x.md', 'reading the staged prompt'],
    [`${RELAY} && git status`, 'a second statement'],
    ['fadeno dispatch --archetype worker <<\'EOF\'\nhi\nEOF', 'the retired heredoc grammar'],
    ['fadeno dispatch-close fix-login --merged', 'closing is the caller\'s'],
    ['', 'no command at all'],
  ] as const) {
    const reason = denial(plugin.run(HOOK, bash('fadeno:dispatch', command)));
    assert.ok(reason != null, why);
    assert.match(reason, /dispatch proxy/);
    assert.ok(reason.endsWith(REPORT_REFUSAL_SENTENCE));
  }
  // Codex rejects updatedInput, so the timeout is not rewritten there; the grammar still holds.
  assert.equal(plugin.run(HOOK, bash('dispatch', RELAY, {}, { turn_id: 'turn-1' })).out, null);
  assert.ok(denial(plugin.run(HOOK, bash('dispatch', 'ls', {}, { turn_id: 'turn-1', tool_name: 'shell' }))) != null, 'Codex tool spellings are guarded');
});

test('a dispatched agent is refused the destructive git subcommands unless the call names its Fadeno worktree', (t) => {
  const plugin = hookPlugin(t);
  const cases: Array<[string, RegExp]> = [
    ['git checkout -- src/a.ts', /git checkout/],
    ['git switch other', /git switch/],
    ['git restore src/a.ts', /git restore/],
    ['git reset --hard origin/main', /git reset/],
    ['git stash', /git stash/],
    ['git clean -fd', /git clean/],
    ['npm test && git reset --hard', /git reset/],
    ['cd /tmp; FOO=1 git stash push -m wip', /git stash/],
    ['git -C /elsewhere restore src/a.ts', /git restore/],
    ['echo start | git clean -f', /git clean/],
  ];
  for (const agent of ['fadeno:worker', 'worker', 'fadeno:reviewer', 'judge', 'scout', 'director']) {
    for (const [command, expected] of cases) {
      const reason = denial(plugin.run(HOOK, bash(agent, command)));
      assert.ok(reason != null, `${agent}: ${command} must be denied`);
      assert.match(reason, expected);
      assert.match(reason, /git -C <your worktree>/);
      assert.match(reason, /stop and report it/);
      assert.ok(reason.endsWith(REPORT_REFUSAL_SENTENCE));
    }
  }
  for (const command of [
    'git status --short',
    'git log --oneline -5',
    'git diff HEAD',
    'git stash list',
    'git stash show',
    'git clean -n',
    'git clean --dry-run',
    'git commit -am "done"',
    'git merge main',
    "echo 'do not git checkout here' >> notes.md",
    'grep -rn "git reset" docs/',
    'cargo build --release && ./scripts/verify.sh',
    // In its own worktree the agent owns the tree: named by -C or a cd in the same call.
    'git -C /repo/.fadeno/local/worktrees/fix-login checkout --theirs src/a.ts',
    'cd /repo/.fadeno/local/worktrees/fix-login && git stash && git merge main && git stash pop',
    'cd "/repo/.fadeno/local/worktrees/fix login" && git reset --hard HEAD',
  ]) {
    assert.equal(plugin.run(HOOK, bash('fadeno:worker', command)).out, null, `${command} must pass`);
  }
  // A cd OUT of the worktree stops vouching for what follows.
  assert.ok(denial(plugin.run(HOOK, bash('fadeno:worker', 'cd /repo/.fadeno/local/worktrees/x && git status; cd /repo && git stash'))) != null);
  // A dispatched agent's other long-running commands are not given the proxy's timeout.
  assert.equal(plugin.run(HOOK, bash('fadeno:worker', 'npm test', { timeout: 1000 })).out, null);
});

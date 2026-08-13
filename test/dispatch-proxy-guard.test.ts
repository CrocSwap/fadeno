import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import './helpers.ts';

// The dispatch proxy relay-contract guard (loadouts-and-dispatch.md, steering
// ladder rung 3): inside a dispatch proxy agent, the only Bash allowed is the
// single contract call, and the dispatch leg gets the long tool timeout. The
// guard is exercised exactly as the harness runs it — stdin JSON in, one JSON
// decision (or nothing) out.
const GUARD = join(import.meta.dirname, '..', 'templates', 'claude', 'hooks', 'dispatch-proxy-guard.mjs');

interface HookDecision {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

function runGuard(event: unknown): HookDecision | null {
  const spawned = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  assert.equal(spawned.status, 0, `guard must always exit 0 (stderr: ${spawned.stderr})`);
  const out = (spawned.stdout ?? '').trim();
  return out === '' ? null : (JSON.parse(out) as HookDecision);
}

function bashEvent(agentType: string | undefined, command: string, timeout?: number): unknown {
  return {
    session_id: 'test',
    ...(agentType != null ? { agent_type: agentType } : {}),
    tool_name: 'Bash',
    tool_input: { command, ...(timeout != null ? { timeout } : {}) },
  };
}

// The PRIMARY contract: one statement, prompt on stdin, bare `fadeno` so the
// `Bash(fadeno:*)` permission rule matches.
const CONTRACT_CALL = [
  `fadeno dispatch --archetype worker <<'FADENO_PROMPT'`,
  'Subtask: survey the repo.',
  'Do NOT commit. Also: git push --force && rm -rf / # hostile-looking prompt bytes',
  'FADENO_PROMPT',
].join('\n');

// The retry spelling for when bare `fadeno` is not on PATH.
const RETRY_CALL = CONTRACT_CALL.replace(
  'fadeno dispatch',
  '"$CLAUDE_PLUGIN_ROOT/bin/fadeno" dispatch',
);

// The LEGACY contract older init-emitted proxy bodies still use.
const LEGACY_CALL = [
  'mkdir -p .fadeno/local/prompts',
  'f=$(mktemp .fadeno/local/prompts/worker-XXXXXXXX)',
  `cat > "$f" <<'FADENO_PROMPT'`,
  'Subtask: survey the repo.',
  'Do NOT commit. Also: git push --force && rm -rf / # hostile-looking prompt bytes',
  'FADENO_PROMPT',
  '"${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/bin/}fadeno" dispatch --archetype worker --prompt-file "$f"',
].join('\n');

test('guard: no-ops for non-Bash tools, absent agent_type, and non-proxy agents', () => {
  assert.equal(runGuard({ tool_name: 'Agent', tool_input: {} }), null);
  assert.equal(runGuard(bashEvent(undefined, 'git status')), null);
  assert.equal(runGuard(bashEvent('general-purpose', 'git status')), null);
  assert.equal(runGuard(bashEvent('fadeno:worker', 'git status')), null); // native role, not a proxy
});

test('guard: the full contract call is allowed and gets the long dispatch timeout', () => {
  for (const agentType of ['dispatch-worker', 'fadeno:dispatch-worker']) {
    for (const call of [CONTRACT_CALL, RETRY_CALL, LEGACY_CALL]) {
      const decision = runGuard(bashEvent(agentType, call));
      assert.ok(decision, `${agentType}: expected an updatedInput decision`);
      assert.equal(decision!.hookSpecificOutput?.permissionDecision, undefined);
      assert.deepEqual(decision!.hookSpecificOutput?.updatedInput, { timeout: 600000 });
    }
  }
});

test('guard: hostile bytes inside the heredoc body are never inspected', () => {
  // The body IS the relayed task prompt; only surrounding statements count.
  const decision = runGuard(bashEvent('fadeno:dispatch-worker', CONTRACT_CALL));
  assert.equal(decision!.hookSpecificOutput?.permissionDecision, undefined);
});

test('guard: an already-long timeout passes through untouched', () => {
  assert.equal(runGuard(bashEvent('fadeno:dispatch-worker', CONTRACT_CALL, 600000)), null);
});

test('guard: a standalone retry dispatch with a literal prompt file is allowed', () => {
  const retry =
    '"${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/bin/}fadeno" dispatch --archetype worker --prompt-file .fadeno/local/prompts/worker-a1B2c3D4';
  const decision = runGuard(bashEvent('fadeno:dispatch-worker', retry));
  assert.deepEqual(decision!.hookSpecificOutput?.updatedInput, { timeout: 600000 });
});

test('guard: the recovery read of a killed dispatch output is allowed', () => {
  // No dispatch statement → no timeout rewrite; the call passes through.
  for (const recovery of [
    'fadeno dispatches --output last',
    'fadeno dispatches --output 3f9a1c2e',
    '"$CLAUDE_PLUGIN_ROOT/bin/fadeno" dispatches --output 3f9a1c2e-77aa-4a10-9d1c-0a1b2c3d4e5f',
  ]) {
    assert.equal(runGuard(bashEvent('fadeno:dispatch-worker', recovery)), null, recovery);
  }
  // Recovery does not open the door to the list surface or other flags.
  const listing = runGuard(bashEvent('fadeno:dispatch-worker', 'fadeno dispatches --tail 5'));
  assert.equal(listing?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('guard: freelancing is denied with an actionable reason', () => {
  for (const command of [
    'git status --porcelain=v1',
    'ls -la src/',
    'cat package.json',
    `${CONTRACT_CALL}\ngit log --oneline`, // contract call + a smuggled extra statement
    'mkdir -p .fadeno/local/prompts && git status', // smuggled via &&
  ]) {
    const decision = runGuard(bashEvent('fadeno:dispatch-worker', command));
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny', `expected deny for: ${command}`);
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason!, /relay contract|dispatch proxy contract/);
  }
});

test('guard: the wrong archetype, unquoted heredocs, and unterminated heredocs are denied', () => {
  // A worker proxy may not dispatch as reviewer.
  const crossArchetype = CONTRACT_CALL.replace('--archetype worker', '--archetype reviewer');
  assert.equal(
    runGuard(bashEvent('fadeno:dispatch-worker', crossArchetype))?.hookSpecificOutput?.permissionDecision,
    'deny',
  );
  // Unquoted delimiter would let the shell expand the prompt's bytes.
  const unquoted = CONTRACT_CALL.replace("<<'FADENO_PROMPT'", '<<FADENO_PROMPT');
  const unquotedDecision = runGuard(bashEvent('fadeno:dispatch-worker', unquoted));
  assert.equal(unquotedDecision?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(unquotedDecision!.hookSpecificOutput!.permissionDecisionReason!, /quoted/);
  // An unterminated heredoc means the "body" swallowed the dispatch.
  const unterminated = CONTRACT_CALL.split('\n').filter((l) => l !== 'FADENO_PROMPT').join('\n');
  assert.equal(
    runGuard(bashEvent('fadeno:dispatch-worker', unterminated))?.hookSpecificOutput?.permissionDecision,
    'deny',
  );
});

test('guard: reviewer and judge proxies enforce their own archetype', () => {
  for (const archetype of ['reviewer', 'judge']) {
    const call = CONTRACT_CALL.split('worker').join(archetype);
    const decision = runGuard(bashEvent(`fadeno:dispatch-${archetype}`, call));
    assert.deepEqual(decision!.hookSpecificOutput?.updatedInput, { timeout: 600000 });
  }
});

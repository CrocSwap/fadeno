import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Always spawned with an explicit, throwaway cwd.
 *
 * The guard WRITES (a proxy-dispatch marker) and resolves its target from
 * `event.cwd`, falling back to `process.cwd()`. A spawn that declares neither
 * inherits this repo — and on 2026-08-20 that appended 22 marker rows into the
 * developer's own `.fadeno/local/`. Same rule `codexUserAgentDir` documents for
 * env injection: declaring a hermetic environment means declaring all of it,
 * not the parts you happened to think about.
 */
function runGuard(event: unknown, cwd = mkdtempSync(join(tmpdir(), 'fadeno-guard-'))): HookDecision | null {
  const spawned = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    cwd,
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
    // The handle spelling, which is the one the proxies are told to use: after
    // a kill the id echo is gone, and the tag is what the proxy still knows.
    'fadeno dispatches --output tag:worker-parse-retry-header --wait 120',
    '"$CLAUDE_PLUGIN_ROOT/bin/fadeno" dispatches --output tag:worker-a.b_c-1',
  ]) {
    assert.equal(runGuard(bashEvent('fadeno:dispatch-worker', recovery)), null, recovery);
  }
  // Recovery does not open the door to the list surface or other flags.
  const listing = runGuard(bashEvent('fadeno:dispatch-worker', 'fadeno dispatches --tail 5'));
  assert.equal(listing?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('guard: the tagged contract call is allowed and still gets the long timeout', () => {
  const tagged = CONTRACT_CALL.replace(
    '--archetype worker',
    '--archetype worker --tag worker-survey-the-repo',
  );
  const decision = runGuard(bashEvent('fadeno:dispatch-worker', tagged));
  assert.deepEqual(decision!.hookSpecificOutput?.updatedInput, { timeout: 600000 });
});

test('guard: an unsubstituted <slug> placeholder is denied, not passed through', () => {
  // The proxy body shows `--tag worker-<slug>` as a template. Copied literally
  // it is not a usable handle, and the kernel would reject it after the guard
  // had already granted the call — better to say so here, where the message
  // can name the substitution.
  const literal = CONTRACT_CALL.replace('--archetype worker', '--archetype worker --tag worker-<slug>');
  const decision = runGuard(bashEvent('fadeno:dispatch-worker', literal));
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(decision!.hookSpecificOutput!.permissionDecisionReason!, /<slug>/);
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

/**
 * The marker is the dispatch-side half of relay attestation: without it the
 * kernel cannot tell an un-relayed dispatch from a relay that altered the
 * prompt, and `relay_attested: false` means nothing (see
 * `consumeRelayAttestation`).
 */
test('guard records a proxy-dispatch marker for the bytes it is about to send', () => {
  const root = mkdtempSync(join(tmpdir(), 'fadeno-guard-repo-'));
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const body = 'do the thing\nwith care\n';
  const command = `fadeno dispatch --archetype worker --tag worker-a-thing <<'FADENO_PROMPT'\n${body}FADENO_PROMPT`;

  runGuard({ ...(bashEvent('dispatch-worker', command) as object), cwd: root });

  const rows = readFileSync(join(root, '.fadeno', 'local', 'proxy-dispatches.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as { archetype: string; prompt_sha256: string });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.archetype, 'worker');
  // The digest is of what the kernel will RECEIVE on stdin — body lines plus
  // the heredoc's trailing newline — not of the surrounding shell.
  assert.equal(rows[0]!.prompt_sha256, createHash('sha256').update(body).digest('hex'));
});

test('guard writes no marker outside a Fadeno repo, and none for a denied call', () => {
  const bare = mkdtempSync(join(tmpdir(), 'fadeno-guard-bare-'));
  const command = `fadeno dispatch --archetype worker <<'FADENO_PROMPT'\nhi\nFADENO_PROMPT`;
  runGuard({ ...(bashEvent('dispatch-worker', command) as object), cwd: bare });
  assert.ok(!existsSync(join(bare, '.fadeno', 'local', 'proxy-dispatches.jsonl')));

  const repo = mkdtempSync(join(tmpdir(), 'fadeno-guard-denied-'));
  mkdirSync(join(repo, '.fadeno'), { recursive: true });
  // Outside the relay contract: denied, and nothing is dispatched, so nothing
  // may claim a dispatch is imminent.
  runGuard({ ...(bashEvent('dispatch-worker', 'rm -rf /tmp/whatever') as object), cwd: repo });
  assert.ok(!existsSync(join(repo, '.fadeno', 'local', 'proxy-dispatches.jsonl')));
});

test('guard writes no marker when the event declares no cwd', () => {
  // Belt and braces on top of the hermetic spawn cwd above: the hook must not
  // infer a repo for a WRITE. Spawned FROM a real-looking repo, with no
  // `event.cwd` — nothing may be written there.
  const root = mkdtempSync(join(tmpdir(), 'fadeno-guard-nocwd-'));
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const command = `fadeno dispatch --archetype worker <<'FADENO_PROMPT'\nhi\nFADENO_PROMPT`;
  runGuard(bashEvent('dispatch-worker', command), root);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'proxy-dispatches.jsonl')));
});

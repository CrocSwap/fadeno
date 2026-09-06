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

test('guard: the --shared variant is inside the grammar, on explicit caller request only', () => {
  // The caller explicitly asked for live-tree work: archetype, then --shared,
  // then the tag — nothing else about the call changes.
  for (const withTag of [true, false]) {
    for (const archetype of ['worker', 'reviewer', 'judge']) {
      const base = CONTRACT_CALL.split('worker').join(archetype);
      const call = base.replace(
        `--archetype ${archetype}`,
        `--archetype ${archetype} --shared${withTag ? ` --tag ${archetype}-survey` : ''}`,
      );
      const decision = runGuard(bashEvent(`fadeno:dispatch-${archetype}`, call));
      assert.deepEqual(decision!.hookSpecificOutput?.updatedInput, { timeout: 600000 }, call);
    }
  }
  // The flag goes between the archetype and the tag — after the tag is not
  // the documented spelling and stays outside the grammar.
  const tagged = CONTRACT_CALL.replace(
    '--archetype worker',
    '--archetype worker --tag worker-survey-the-repo',
  );
  const misplaced = tagged.replace('--tag worker-survey-the-repo', '--tag worker-survey-the-repo --shared');
  assert.equal(runGuard(bashEvent('fadeno:dispatch-worker', misplaced))?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('guard: other isolation argv mutations stay outside the grammar', () => {
  // --isolate changes what happens to the work; a proxy may never add it.
  const isolate = CONTRACT_CALL.replace(
    '--archetype worker',
    '--archetype worker --isolate',
  );
  assert.equal(runGuard(bashEvent('fadeno:dispatch-worker', isolate))?.hookSpecificOutput?.permissionDecision, 'deny');
  const sharedPromptFile = '"$CLAUDE_PLUGIN_ROOT/bin/fadeno" dispatch --archetype worker --shared --prompt-file .fadeno/local/prompts/worker-a1B2c3D4';
  assert.equal(runGuard(bashEvent('fadeno:dispatch-worker', sharedPromptFile))?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('guard: proxy bodies document --shared exactly where the guard allows it', () => {
  // Template/guard consistency: the proxies are told about the flag in the
  // same position the grammar accepts it, and director — which PROXY_RE does
  // not cover — deliberately carries no --shared language at all.
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const body = readFileSync(join(import.meta.dirname, '..', 'templates', 'claude', 'claude-agents', `dispatch-${archetype}.md`), 'utf8');
    assert.match(body, new RegExp(`--archetype ${archetype} --shared --tag ${archetype}-`), archetype);
  }
  const director = readFileSync(join(import.meta.dirname, '..', 'templates', 'claude', 'claude-agents', 'dispatch-director.md'), 'utf8');
  assert.doesNotMatch(director, /--shared/);
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
  // The digest is of what the kernel will RECEIVE on stdin — body lines, never
  // the surrounding shell — canonicalized the way `callerPromptDigest` defines
  // it, with the heredoc's own trailing newline stripped rather than baked in.
  // That strip is what makes this marker equal the spawn-side stash the
  // steering hook wrote from `tool_input.prompt`, which carries no terminator
  // at all: three writers, one value for one task.
  assert.equal(
    rows[0]!.prompt_sha256,
    createHash('sha256').update(body.replace(/(?:\r?\n)+$/, '')).digest('hex'),
  );
  assert.notEqual(rows[0]!.prompt_sha256, createHash('sha256').update(body).digest('hex'));
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

// ---------------------------------------------------------------------------
// The role-agent git guard (the hook's second job).
// ---------------------------------------------------------------------------
//
// Reported 2026-09-05: a worker ran `git checkout -- <file>` in a shared tree
// against the dispatch's explicit instruction, lost its own edits and redid
// them. It was lucky the file was its own. These cover what the guard refuses,
// what it deliberately lets through, and — the part that matters most — the
// coverage it does NOT have, so nobody reads it as a sandbox.

function denialOf(decision: HookDecision | null): string | null {
  const out = decision?.hookSpecificOutput;
  return out?.permissionDecision === 'deny' ? (out.permissionDecisionReason ?? '') : null;
}

test('role agents: the destructive git subcommands are refused with the harm named', () => {
  const cases: Array<[string, RegExp]> = [
    ['git checkout -- src/a.ts', /git checkout/],
    ['git checkout main', /git checkout/],
    ['git switch other-branch', /git switch/],
    ['git restore src/a.ts', /git restore/],
    ['git reset --hard origin/main', /git reset/],
    ['git stash', /git stash/],
    ['git clean -fd', /git clean/],
    // Not the first statement, and wrapped: a guard that only reads token one
    // is a guard anyone steps over by accident.
    ['npm test && git reset --hard', /git reset/],
    ['cd /tmp; FOO=1 git stash push -m wip', /git stash/],
    ['git -C . restore src/a.ts', /git restore/],
    ['echo start | git clean -f', /git clean/],
  ];
  for (const [command, expected] of cases) {
    const reason = denialOf(runGuard(bashEvent('fadeno:worker', command)));
    assert.ok(reason != null, `${command} must be denied`);
    assert.match(reason, expected);
    // Every refusal says what to do instead: the point is to stop a reflex,
    // not to leave the agent stuck.
    assert.match(reason, /report/i);
  }
});

test('role agents: reading git state is untouched', () => {
  for (const command of [
    'git status --short',
    'git log --oneline -5',
    'git diff HEAD',
    'git stash list',
    'git stash show',
    'git clean -n',
    'git clean --dry-run',
    'npm test',
    // The word appearing in ARGUMENTS is not an invocation of it.
    "echo 'do not git checkout here' >> notes.md",
    'grep -rn "git reset" docs/',
  ]) {
    assert.equal(denialOf(runGuard(bashEvent('fadeno:worker', command))), null, `${command} must pass`);
  }
});

test('role agents: reviewer and judge are guarded, the main session is not', () => {
  for (const agent of ['fadeno:reviewer', 'fadeno:judge', 'worker']) {
    assert.ok(denialOf(runGuard(bashEvent(agent, 'git checkout -- x'))) != null, `${agent} must be guarded`);
  }
  // No agent_type at all is the main loop: the host legitimately runs every
  // one of these, and guarding it would break the coordinator's own hands.
  assert.equal(runGuard(bashEvent(undefined, 'git checkout -- x')), null);
  // An agent that is neither a proxy nor a role agent stays unguarded too:
  // coverage follows the agent TYPE, which is exactly the documented limit —
  // a role brief handed to a plain `claude` subagent is invisible here.
  assert.equal(runGuard(bashEvent('claude', 'git checkout -- x')), null);
  assert.equal(runGuard(bashEvent('Explore', 'git reset --hard')), null);
});

test('role agents keep every other Bash call, and get no proxy relay contract', () => {
  // The proxy guard's allowlist must not leak onto role agents: they run
  // arbitrary commands as their job. Only the six git subcommands are refused.
  const decision = runGuard(bashEvent('fadeno:worker', 'cargo build --release && ./scripts/verify.sh'));
  assert.equal(decision, null);
  // And a role agent's long-running command does not get the proxy's forced
  // 600s tool timeout, which exists for the dispatch leg alone.
  assert.equal(runGuard(bashEvent('fadeno:worker', 'npm test', 1000)), null);
});

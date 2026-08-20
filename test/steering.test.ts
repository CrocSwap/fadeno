import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runInit } from '../src/commands/init.ts';
import { stampHookVersion } from '../src/commands/plugin.ts';
import { runSteeringApply, runSteeringResolve } from '../src/commands/steering.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { packageVersion } from '../src/lib/paths.ts';
import { exists, read, tempRepo } from './helpers.ts';

const ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;
const REPO = join(import.meta.dirname, '..');
const BIN = join(REPO, 'plugin', 'bin', 'fadeno');
const STEERING_TEMPLATE = join(REPO, 'templates', 'claude', 'hooks', 'dispatch-steering.mjs');

test('Codex native agents use the current custom-agent schema', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });

  for (const archetype of ARCHETYPES) {
    const body = read(root, `.codex/agents/${archetype}.toml`);
    assert.ok(body.includes(`name = "${archetype}"\n`));
    assert.match(body, /^description = /m);
    assert.ok(body.includes('developer_instructions = """\n'));
    assert.doesNotMatch(body, /^instructions =/m);
    assert.doesNotMatch(body, /^max_depth =/m);
    assert.match(body, /Do not spawn subagents/);
  }
});

test('Codex --with-steering installs loadout-aware role overrides', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, withSteering: true });

  for (const archetype of ARCHETYPES) {
    const body = read(root, `.codex/agents/${archetype}.toml`);
    // `init` no longer copies a frozen TOML: it renders the same
    // command-broker template `steering apply` renders, so a scaffolded repo
    // and a dialed one carry identical instructions. An unmaterialized slot
    // is a broker by construction — nothing has been dialed yet, so it must
    // relay the resolver's answer rather than claim a host identity.
    assert.match(body, /command.broker/i);
    assert.doesNotMatch(body, /--host-executor/);
    // The ORDERING is the contract, not any particular wording: the resolver
    // has to see the prompt bytes to answer the pair question, so the file
    // must exist before the resolve call. This assertion used to pin the
    // literal phrase "First run", which is what let this static template
    // drift out of step with its dynamically generated twin — and then
    // pressured a later fix into contorting the prose to satisfy the regex
    // rather than saying the thing plainly. Assert the sequence instead.
    const writeAt = body.indexOf('ENTIRE task prompt');
    // Anchored on `--prompt-file`: the engine-assignment line earlier in the
    // same template also names `steering resolve --archetype <a>`, and only
    // the ordinary path carries the digest.
    const resolveAt = body.indexOf(`fadeno steering resolve --archetype ${archetype} --prompt-file`);
    assert.ok(writeAt >= 0, `${archetype}: template must instruct writing the prompt verbatim`);
    assert.ok(resolveAt > writeAt, `${archetype}: the prompt file must be written BEFORE steering resolve`);
    assert.match(body, new RegExp(`fadeno steering resolve --archetype ${archetype} --prompt-file`));
    assert.match(body, new RegExp(`fadeno dispatch --archetype ${archetype} --prompt-file`));
    assert.match(body, /ENTIRE task prompt.*verbatim/s);
    assert.match(body, /mode=restart_required/);
    assert.match(body, /fadeno dispatch-fallback <run-id> <dispatch-id>/);
    assert.match(body, /never\s+silently substitute a different model or executor/);
  }
});

test('Codex data-only plugin flow still emits explicitly requested steering agents', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true, withSteering: true });

  assert.ok(exists(root, '.codex/agents/worker.toml'));
  assert.ok(!exists(root, '.agents/skills/fadeno-runner/SKILL.md'));
  assert.ok(!exists(root, 'AGENTS.md'));
});

test('Claude --with-steering merges the local steering hooks without clobbering settings', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    `${JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: './check-write' }] }],
      },
    }, null, 2)}\n`,
  );

  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  assert.ok(exists(root, '.fadeno/local/claude-dispatch-steering.mjs'));
  assert.ok(exists(root, '.fadeno/local/claude-dispatch-proxy-guard.mjs'));
  const first = JSON.parse(read(root, '.claude/settings.local.json')) as {
    permissions: { allow: string[] };
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  };
  assert.deepEqual(first.permissions.allow, ['Bash(ls:*)', 'Bash(fadeno:*)']);
  // Existing entry preserved, then spawn-rewrite + proxy relay guard.
  assert.equal(first.hooks.PreToolUse.length, 3);
  assert.equal(first.hooks.PreToolUse[0]!.hooks[0]!.command, './check-write');
  assert.equal(first.hooks.PreToolUse[1]!.matcher, 'Agent');
  assert.equal(
    first.hooks.PreToolUse[1]!.hooks[0]!.command,
    'node .fadeno/local/claude-dispatch-steering.mjs',
  );
  assert.equal(first.hooks.PreToolUse[2]!.matcher, 'Bash');
  assert.equal(
    first.hooks.PreToolUse[2]!.hooks[0]!.command,
    'node .fadeno/local/claude-dispatch-proxy-guard.mjs',
  );

  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const second = JSON.parse(read(root, '.claude/settings.local.json')) as typeof first;
  assert.deepEqual(second, first);
});

test('init stamps the emitted steering hook with the package version', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });

  // The template is the un-stamped source: a row reading 'dev' can only have
  // come from executing the template directly, never from an installed copy.
  const template = readFileSync(STEERING_TEMPLATE, 'utf8');
  assert.ok(
    template.includes("const HOOK_VERSION = 'dev';"),
    "the steering template must keep the literal 'dev' placeholder",
  );

  // The emitted copy is byte-identical to the template modulo that one stamp —
  // the same anchored-replace discipline as the plugin surface stamp.
  const emitted = read(root, '.fadeno/local/claude-dispatch-steering.mjs');
  assert.ok(
    emitted.includes(`const HOOK_VERSION = '${packageVersion()}';`),
    'the init-emitted hook must carry the current package version',
  );
  assert.ok(!emitted.includes("HOOK_VERSION = 'dev'"));
  assert.equal(emitted, stampHookVersion(template));
});

function writeFakeFadeno(root: string, output: string, exitCode = 0): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'fadeno');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return bin;
}

function runClaudeSteering(
  root: string,
  event: Record<string, unknown>,
  fadenoOutput: string,
): string {
  const bin = writeFakeFadeno(root, fadenoOutput);
  const script = join(root, '.fadeno', 'local', 'claude-dispatch-steering.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('Claude steering rewrites worker-shaped Agent input and preserves Explore', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const base = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: {
      prompt: 'Implement the change exactly.',
      description: 'Implement change',
      subagent_type: 'worker',
      run_in_background: true,
      model: 'opus',
    },
  };
  const rewritten = JSON.parse(runClaudeSteering(root, base, '{"adapter":"command"}')) as {
    hookSpecificOutput: { updatedInput: Record<string, unknown> };
  };
  assert.deepEqual(rewritten.hookSpecificOutput.updatedInput, {
    prompt: 'Implement the change exactly.',
    description: 'Implement change',
    subagent_type: 'dispatch-worker',
    run_in_background: true,
    // Proxy relays run on sonnet since the 2026-08-12 dogfood A/B caught
    // haiku defecting on the relay contract.
    model: 'sonnet',
  });

  const explore = {
    ...base,
    tool_input: { ...base.tool_input, subagent_type: 'Explore' },
  };
  assert.equal(runClaudeSteering(root, explore, '{"adapter":"command"}'), '');
});

test('Claude steering leaves the general-purpose catch-all alone', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  // `general-purpose` is the harness's default subagent — what a director
  // reaches for to run an analysis, a search, anything at all. It once mapped
  // to the worker archetype, which turned every generic spawn in a Fadeno repo
  // into an external dispatch; a 2026-08-13 dogfood then watched the proxy
  // guard hold the relay contract against the analysis it was asked to do, so
  // the work simply did not happen. Naming an archetype is opt-in.
  const generic = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: {
      prompt: 'Analyze metrics.py and explain why marketability falls as the margin grows.',
      description: 'Analyze',
      subagent_type: 'general-purpose',
    },
  };
  assert.equal(runClaudeSteering(root, generic, '{"adapter":"command"}'), '');
  // Unsteered means untouched: no relay attestation, no host_delivery row.
  assert.equal(exists(root, '.fadeno/local/pending-relays.jsonl'), false);
  assert.equal(exists(root, '.fadeno/dispatches.jsonl'), false);
});

test('Claude steering stashes a relay attestation for proxy-bound spawns', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const rewritten = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt: 'Implement the change exactly.', description: 'x', subagent_type: 'worker' },
  };
  runClaudeSteering(root, rewritten, '{"adapter":"command"}'); // rewrite → proxy: stash

  const explicit = {
    ...rewritten,
    tool_input: { ...rewritten.tool_input, prompt: 'Second prompt.', subagent_type: 'fadeno:dispatch-reviewer' },
  };
  // An explicitly-targeted proxy is resolved like any other archetype spawn.
  // The slot is command-delivered here, so it stays on the proxy — and is
  // attested — but the decision came from the loadout, not the caller.
  const held = JSON.parse(runClaudeSteering(root, explicit, '{"adapter":"command"}')) as {
    hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } };
  };
  assert.equal(held.hookSpecificOutput.updatedInput.subagent_type, 'dispatch-reviewer');
  assert.equal(held.hookSpecificOutput.updatedInput.model, 'sonnet');

  const rows = read(root, '.fadeno/local/pending-relays.jsonl')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { timestamp: string; hook_version: string; prompt_sha256: string });
  assert.deepEqual(
    rows.map((row) => row.prompt_sha256),
    [sha256Hex('Implement the change exactly.'), sha256Hex('Second prompt.')],
  );
  assert.ok(rows.every((row) => !Number.isNaN(Date.parse(row.timestamp))));
  // Which hook generation stashed the attestation — the emitted copy is
  // stamped, so these rows carry the package version, not 'dev'.
  assert.deepEqual(
    rows.map((row) => row.hook_version),
    [packageVersion(), packageVersion()],
  );

  // Host-native rewrites are not relays: nothing further stashed.
  const native = {
    ...rewritten,
    tool_input: { ...rewritten.tool_input, subagent_type: 'reviewer' },
  };
  runClaudeSteering(root, native, '{"adapter":"host","model":"opus"}');
  assert.equal(read(root, '.fadeno/local/pending-relays.jsonl').trim().split('\n').length, 2);
});

test('Claude steering selects a native target model without a command proxy', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const event = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt: 'Review it.', description: 'Review', subagent_type: 'reviewer', model: 'sonnet' },
  };
  const rewritten = JSON.parse(runClaudeSteering(root, event, '{"adapter":"host","model":"opus"}')) as {
    hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } };
  };
  assert.equal(rewritten.hookSpecificOutput.updatedInput.subagent_type, 'reviewer');
  assert.equal(rewritten.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(runClaudeSteering(root, event, '{"adapter":"host","model":"current-host"}'), '');
});

test('Claude steering pulls an explicitly-named proxy back to a native slot', (t) => {
  // The proxy agents advertise themselves as MUST-BE-USED, so a director names
  // `fadeno:dispatch-judge` directly. That used to skip resolution outright and
  // lock in command delivery: on Claude the proxy then shelled out to
  // `claude -p`, which loaded this same plugin, re-read the prompt as director
  // work, and re-dispatched one level down until a headless permission denial
  // ended it. The caller does not get to pick the transport — the loadout does.
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const event = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt: 'Adjudicate the fork.', description: 'Judge', subagent_type: 'fadeno:dispatch-judge' },
  };
  const decision = JSON.parse(runClaudeSteering(root, event, '{"adapter":"host","model":"opus"}')) as {
    hookSpecificOutput: { updatedInput: { subagent_type: string; model?: string } };
  };
  assert.equal(decision.hookSpecificOutput.updatedInput.subagent_type, 'judge');
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'opus');

  // Native delivery never reaches the kernel, so the hook owns its evidence —
  // and a native slot is not a relay, so nothing is stashed for one.
  assert.ok(read(root, '.fadeno/dispatches.jsonl').includes('"event":"host_delivery"'));
  assert.equal(exists(root, '.fadeno/local/pending-relays.jsonl'), false);

  // `current-host` is the explicit "inherit the caller's model" spelling: the
  // proxy still has to be unwound, but no model is pinned on the way out.
  const inherited = JSON.parse(
    runClaudeSteering(root, event, '{"adapter":"host","model":"current-host"}'),
  ) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model?: string } } };
  assert.equal(inherited.hookSpecificOutput.updatedInput.subagent_type, 'judge');
  assert.equal(inherited.hookSpecificOutput.updatedInput.model, undefined);
});

// A realistic `fadeno loadout resolve` payload for a native (host) slot.
const NATIVE_SLOT = JSON.stringify({
  archetype: 'reviewer',
  active: { name: 'claude-native', source: 'local file' },
  executor: 'claude-opus',
  model: 'opus',
  adapter: 'host',
  harness: 'claude',
});

/**
 * The same slot, but with an effort the user PINNED that the session is not
 * running at. The resolver puts that on the command lane — the identity grid
 * that used to serve it in-session is retired, because a session's effort is
 * fixed at session start just like its agent registry.
 */
const PINNED_OFF_SESSION_SLOT = JSON.stringify({
  ...JSON.parse(NATIVE_SLOT),
  effort: 'xhigh',
  effort_pinned: true,
  effective_effort: 'xhigh',
  session_effort: 'high',
  lane: 'command',
  lane_reason: 'session effort is high, dial pins xhigh',
});

/** A pin the session DOES match: still in-session, and the row says why. */
const PINNED_MATCHING_SLOT = JSON.stringify({
  ...JSON.parse(NATIVE_SLOT),
  effort: 'high',
  effort_pinned: true,
  effective_effort: 'high',
  session_effort: 'high',
  lane: 'host',
  lane_reason: 'session effort matches the pin',
});

type EvidenceRow = Record<string, unknown> & { timestamp: string; prompt_snapshot: string };

function evidenceRows(root: string): EvidenceRow[] {
  return read(root, '.fadeno/dispatches.jsonl')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as EvidenceRow);
}

test('Claude steering writes the host_delivery evidence the kernel never sees', (t) => {
  // The suite itself may run inside a Claude session, which publishes
  // CLAUDE_EFFORT to every child. Pin it off so the row is the unobserved case.
  const previousEffort = process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_EFFORT;
  t.after(() => { if (previousEffort != null) process.env.CLAUDE_EFFORT = previousEffort; });
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const prompt = 'Review the diff.\n\n  Keep every byte verbatim.\n';
  const event = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt, description: 'Review', subagent_type: 'reviewer', model: 'sonnet' },
  };
  const decision = JSON.parse(runClaudeSteering(root, event, NATIVE_SLOT)) as {
    hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } };
  };
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'opus');

  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  const { timestamp, ...row } = rows[0]!;
  assert.ok(!Number.isNaN(Date.parse(timestamp)));
  const digest = sha256Hex(prompt);
  assert.deepEqual(row, {
    // Evidence-format version, stamped identically by both writers. The hook
    // cannot import DISPATCHES_FORMAT (it runs as a standalone script), so the
    // literal is duplicated there and pinned here — orthogonal to hook_version
    // below, which stamps the *writer*, not the format it writes.
    format: '1.0',
    event: 'host_delivery',
    // The one key that answers "which Fadeno produced this row?" on every row
    // in the log, kernel-written or hook-written. Before it existed the only
    // version-shaped key was `hook_version`, which is absent on every kernel
    // row — so the log's own provenance read as mostly missing.
    fadeno_version: packageVersion(),
    // Hook generation that wrote the row: the session-start hook cache means a
    // live session can be a build behind, so the row names its own writer.
    hook_version: packageVersion(),
    archetype: 'reviewer',
    agent_type: 'reviewer',
    executor: 'claude-opus',
    model: 'opus',
    // The two model fields answer different questions, and this row is the
    // clearest case of them disagreeing: the caller asked for sonnet on the
    // tool call, the dial says opus, and the hook applied opus. `_override`
    // records what arrived, `_applied` what the hook put on `updatedInput`.
    // Before `_applied` existed, a row could not distinguish "the hook
    // rewrote this spawn" from "the caller already asked for that model" —
    // which is exactly the question a host-delivery row exists to answer.
    model_override: 'sonnet',
    model_applied: 'opus',
    dial_source: null,
    driver: null,
    effort: null,
    // Nothing pins an effort on the host lane any more — no agent file does,
    // and this dial stated no opinion — so the spawn takes the session's. With
    // CLAUDE_EFFORT unset nothing observed that either, which is `unobserved`:
    // distinct from `session` (measured) and from `dial` (asserted).
    reasoning_effort: 'inherited',
    effort_source: 'unobserved',
    effort_pinned: false,
    session_effort: null,
    // Null from this fixture, which predates the field; a real resolver always
    // supplies one. (`materialized_source` retired with the identity grid.)
    lane_reason: null,
    transport: 'host',
    prompt_sha256: digest,
    prompt_snapshot: `.fadeno/local/prompts/host-${digest.slice(0, 8)}.md`,
  });
  // The snapshot mirrors the kernel's: the exact bytes that were delivered.
  assert.equal(read(root, row.prompt_snapshot), prompt);
  // Native delivery is not a relay — nothing for the kernel to consume.
  assert.ok(!exists(root, '.fadeno/local/pending-relays.jsonl'));

  // Archetype comes from the hook's own mapping, not from the slot payload;
  // an unpinned spawn records a null override.
  const second = 'Implement it.';
  runClaudeSteering(
    root,
    { ...event, tool_input: { prompt: second, description: 'x', subagent_type: 'worker' } },
    NATIVE_SLOT,
  );
  const latest = evidenceRows(root).at(-1)!;
  assert.equal(latest.archetype, 'worker');
  assert.equal(latest.agent_type, 'worker');
  assert.equal(latest.model_override, null);
  assert.equal(read(root, latest.prompt_snapshot), second);
});

test('a pinned effort the session is not running at leaves the session; a managed role agent is just an agent now', (t) => {
  // The identity grid is retired. It existed so a host spawn could run at an
  // effort the session was not running at, by pre-registering a cell per
  // (archetype, effort) and retargeting `subagent_type` onto it. That goal is
  // gone: the spawn takes the session's effort, and a pinned effort the
  // session cannot give goes out of process instead, where the argv encodes it.
  const previousEffort = process.env.CLAUDE_EFFORT;
  process.env.CLAUDE_EFFORT = 'high';
  t.after(() => { if (previousEffort == null) delete process.env.CLAUDE_EFFORT; else process.env.CLAUDE_EFFORT = previousEffort; });
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  // A managed role agent, exactly as `steering apply --claude` would leave one
  // if it existed: no model, no effort, just the role body. It is a landing
  // place, not an identity — nothing here can pin an effort any more.
  writeFileSync(
    join(root, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\n---\n\nBody.\n\n<!-- fadeno:managed version=0.0.0 digest=deadbeef -->\n',
  );

  // Pin != session: out of process, onto the dispatch proxy.
  const offSession = JSON.parse(runClaudeSteering(
    root,
    { cwd: root, tool_name: 'Agent', tool_input: { prompt: 'Review it.', description: 'x', subagent_type: 'reviewer' } },
    PINNED_OFF_SESSION_SLOT,
  )) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } } };
  assert.match(offSession.hookSpecificOutput.updatedInput.subagent_type, /dispatch-reviewer$/);
  // Command delivery ends at `fadeno dispatch`, where the kernel writes the
  // evidence — the hook stashes a relay attestation instead of a host row.
  assert.ok(exists(root, '.fadeno/local/pending-relays.jsonl'));
  assert.ok(!exists(root, '.fadeno/dispatches.jsonl'));

  // Pin == session: in-session, on the plain role agent. The bare archetype
  // name, never a `fadeno-<archetype>-<effort>` cell.
  const matching = JSON.parse(runClaudeSteering(
    root,
    { cwd: root, tool_name: 'Agent', tool_input: { prompt: 'Review again.', description: 'x', subagent_type: 'reviewer' } },
    PINNED_MATCHING_SLOT,
  )) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } } };
  assert.equal(matching.hookSpecificOutput.updatedInput.subagent_type, 'reviewer');
  assert.equal(matching.hookSpecificOutput.updatedInput.model, 'opus');
  const row = evidenceRows(root).at(-1)!;
  // The session's own level is the row's effort, and it is MEASURED — the one
  // observed number on the path, already past any silent downgrade.
  assert.equal(row.reasoning_effort, 'high');
  assert.equal(row.effort_source, 'session');
  assert.equal(row.session_effort, 'high');
  assert.equal(row.effort_pinned, true);
  // Why it stayed, in the resolver's own closed vocabulary: the lane is
  // session-state dependent and can flip mid-session, so the reason is the
  // only record of which state this spawn saw.
  assert.equal(row.lane_reason, 'session effort matches the pin');

  // An unpinned dial in the same session: same lane, and the row says the
  // spawn never had an opinion to honor in the first place.
  runClaudeSteering(
    root,
    { cwd: root, tool_name: 'Agent', tool_input: { prompt: 'Do it.', description: 'x', subagent_type: 'worker' } },
    NATIVE_SLOT,
  );
  const unpinned = evidenceRows(root).at(-1)!;
  assert.equal(unpinned.effort_pinned, false);
  assert.equal(unpinned.reasoning_effort, 'high');
  assert.equal(unpinned.effort_source, 'session');
});

test('Claude steering leaves command-delivery evidence to the kernel', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const event = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt: 'Implement the change.', description: 'x', subagent_type: 'worker' },
  };
  runClaudeSteering(root, event, '{"adapter":"command","executor":"codex-worker","model":"gpt-5"}');
  const explicit = {
    ...event,
    tool_input: { ...event.tool_input, subagent_type: 'fadeno:dispatch-worker' },
  };
  runClaudeSteering(root, explicit, '{"adapter":"command","executor":"codex-worker"}');

  // Both rewritten and explicitly-targeted proxies are dispatched by the
  // kernel, which owns their rows; the hook only stashes the relay digests.
  assert.ok(!exists(root, '.fadeno/dispatches.jsonl'));
  assert.ok(!exists(root, '.fadeno/local/prompts'));
  assert.equal(read(root, '.fadeno/local/pending-relays.jsonl').trim().split('\n').length, 2);
});

test('Claude steering records no native evidence outside a Fadeno repo', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const bare = tempRepo(t); // has no .fadeno/ at all
  const decision = JSON.parse(
    runClaudeSteering(
      root,
      {
        cwd: bare,
        tool_name: 'Agent',
        tool_input: { prompt: 'Review it.', description: 'Review', subagent_type: 'reviewer' },
      },
      NATIVE_SLOT,
    ),
  ) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } } };

  // Decision unchanged; evidence simply skipped.
  assert.equal(decision.hookSpecificOutput.updatedInput.subagent_type, 'fadeno:reviewer');
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'opus');
  assert.ok(!exists(bare, '.fadeno'));
  assert.ok(!exists(root, '.fadeno/dispatches.jsonl'));
});

test('Claude steering evidence failure never changes the steering decision', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  // Snapshot directory is occupied by a file: the recursive mkdir throws.
  // (Portable stand-in for an unwritable evidence path — chmod-based denial is
  // a no-op for a root-owned CI user.)
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'prompts'), 'not a directory\n');

  const decision = JSON.parse(
    runClaudeSteering(
      root,
      {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { prompt: 'Review it.', description: 'Review', subagent_type: 'reviewer' },
      },
      NATIVE_SLOT,
    ),
  ) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } } };
  assert.equal(decision.hookSpecificOutput.updatedInput.subagent_type, 'reviewer');
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'opus');
  assert.ok(!exists(root, '.fadeno/dispatches.jsonl'));
});

test('Claude steering is inactive without a loadout and uses plugin-scoped proxies in data-only flow', (t) => {
  const nativeRoot = tempRepo(t);
  runInit({ target: 'claude', repoRoot: nativeRoot, withSteering: true });
  const event = {
    cwd: nativeRoot,
    tool_name: 'Agent',
    tool_input: { prompt: 'Review it.', description: 'Review', subagent_type: 'reviewer' },
  };
  assert.equal(runClaudeSteering(nativeRoot, event, '{"adapter":"host"}'), '');

  const pluginRoot = tempRepo(t);
  runInit({ target: 'claude', repoRoot: pluginRoot, dataOnly: true, withSteering: true });
  const pluginEvent = {
    ...event,
    cwd: pluginRoot,
  };
  const rewritten = JSON.parse(runClaudeSteering(pluginRoot, pluginEvent, '{"adapter":"command"}')) as {
    hookSpecificOutput: { updatedInput: { subagent_type: string } };
  };
  assert.equal(rewritten.hookSpecificOutput.updatedInput.subagent_type, 'fadeno:dispatch-reviewer');
});

test('Grok rejects --with-steering before scaffolding anything', (t) => {
  const root = tempRepo(t);
  assert.throws(
    () => runInit({ target: 'grok', repoRoot: root, withSteering: true }),
    /supported for Codex and Claude Code, not Grok Build/,
  );
  assert.ok(!exists(root, '.fadeno/vocabulary.md'));
});

test('bundled CLI parses --with-steering and carries its templates', (t) => {
  const root = tempRepo(t);
  const result = spawnSync(BIN, ['init', '--codex', '--with-steering'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Materialize Codex steering with .*fadeno steering apply/);
  assert.match(read(root, '.codex/agents/worker.toml'), /Fadeno command broker worker/i);
  // The broker is rendered from the shipped catalog now, not copied from a
  // frozen TOML, so the bundle's own `templates/common/fadeno/executors.yaml`
  // (`relay.codex: luna@low`) is what these two literals come from. They
  // deliberately equal the built-in fallback, so this asserts the emitted
  // shape rather than distinguishing the two paths — test/relay-broker.test.ts
  // is where an overriding catalog proves the resolution actually happens.
  assert.match(read(root, '.codex/agents/worker.toml'), /model = "gpt-5\.6-luna"\nmodel_reasoning_effort = "low"/);
  assert.match(read(root, '.codex/agents/worker.toml'), /fadeno dispatch-fallback <run-id> <dispatch-id>/);
});

/**
 * A host slot whose archetype carries a shadow attachment the roll selected,
 * and whose primary has a fallback_command to force it onto — the case
 * `pairCommandFallback` in the kernel actually honors.
 */
const PAIRED_SLOT = JSON.stringify({
  ...JSON.parse(NATIVE_SLOT),
  effort: 'xhigh',
  shadow: { attached: true, challenger: 'grok', rate: 0.25, selected: true, routable: true },
});

const UNPAIRED_SLOT = JSON.stringify({
  ...JSON.parse(NATIVE_SLOT),
  effort: 'xhigh',
  shadow: { attached: true, challenger: 'grok', rate: 0.25, selected: false, routable: true },
});

/**
 * A selected pair whose primary has NO fallback_command — the `current-host`
 * base dial, most commonly. `pairCommandFallback` in the kernel refuses to
 * reuse a fallback that does not exist, so the hook must not route here
 * either: a selected-but-unroutable pair degrades to "no pair", never to a
 * `fadeno dispatch` the kernel would throw `host_in_session` on.
 */
const UNROUTABLE_PAIRED_SLOT = JSON.stringify({
  ...JSON.parse(NATIVE_SLOT),
  effort: 'xhigh',
  shadow: { attached: true, challenger: 'grok', rate: 0.25, selected: true, routable: false },
});

test('a selected pair sends the in-session primary down the command lane too', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const decision = JSON.parse(runClaudeSteering(
    root,
    { cwd: root, tool_name: 'Agent', tool_input: { prompt: 'Review it.', description: 'x', subagent_type: 'reviewer' } },
    PAIRED_SLOT,
  )) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } } };

  // Not "an in-session agent with a challenger beside it" — the spawn becomes
  // a pair of equals, both command-delivered, differing only in the model.
  assert.match(decision.hookSpecificOutput.updatedInput.subagent_type, /dispatch-reviewer$/);
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'sonnet'); // relay, not the work

  // The kernel writes both arms' rows, so the hook writes none at all — it
  // only stashes the relay attestation, as for any other command delivery.
  assert.equal(exists(root, '.fadeno/dispatches.jsonl'), false);
  assert.ok(exists(root, '.fadeno/local/pending-relays.jsonl'));
});

test('an unselected spawn stays in-session: sampling must not tax the common path', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const decision = JSON.parse(runClaudeSteering(
    root,
    { cwd: root, tool_name: 'Agent', tool_input: { prompt: 'Review it.', description: 'x', subagent_type: 'reviewer' } },
    UNPAIRED_SLOT,
  )) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } } };

  // At rate 0.25 the other three spawns in four must be untouched, or the
  // attachment would degrade every in-session spawn to buy evidence on one.
  assert.doesNotMatch(decision.hookSpecificOutput.updatedInput.subagent_type, /dispatch-/);
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(evidenceRows(root).filter((r) => r.event === 'host_delivery').length, 1);
});

test('a selected pair with no command lane to force stays in-session — degrades to no pair, not a failed dispatch', (t) => {
  // `dispatchability` refuses ANY host spec on an on-demand harness whether
  // or not it has a fallback_command, and the kernel's `pairCommandFallback`
  // correctly requires one. The hook used to force command delivery on
  // `selected` alone, which would route this spawn to the dispatch proxy —
  // and `fadeno dispatch` would then throw its ordinary `host_in_session`
  // refusal, turning a selected pair into a failed task.
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  const decision = JSON.parse(runClaudeSteering(
    root,
    { cwd: root, tool_name: 'Agent', tool_input: { prompt: 'Review it.', description: 'x', subagent_type: 'reviewer' } },
    UNROUTABLE_PAIRED_SLOT,
  )) as { hookSpecificOutput: { updatedInput: { subagent_type: string; model: string } } };

  // Exactly the same outcome as an unselected spawn: routed to the ordinary
  // in-session host agent, never to a dispatch proxy — the pair decision
  // could not be honored, so it is as if there were no pair at all.
  assert.doesNotMatch(decision.hookSpecificOutput.updatedInput.subagent_type, /dispatch-/);
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(evidenceRows(root).filter((r) => r.event === 'host_delivery').length, 1);
});

/** A codex-harness catalog with a host worker that has a command fallback (`luna`) and a command-only shadow challenger (`grok`). */
function seedCodexPairV3(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      luna: { provider: 'lunap', id: 'gpt-5.6-luna', effort: 'high' },
      grok: { provider: 'xai', id: 'grok' },
    },
    routes: {
      codex: {
        lunap: {
          host: true,
          command: ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('HOST-FALLBACK:'+d))"],
        },
        xai: { command: ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('CHALLENGER:'+d))"] },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'luna' },
  }));
}

test('Codex host agent instructions write the prompt file before resolving, so the resolver can see it', (t) => {
  // Phase 5 parity: host-spawn shadowing was Claude-only because the Claude
  // hook always has the prompt in hand before it resolves, while Codex's
  // agent used to resolve with no prompt at all. Fixing the ORDER (write
  // first, then resolve, then dispatch the same file) is what lets the
  // resolver's digest match the one the kernel later hashes from the same
  // path.
  const root = tempRepo(t);
  seedCodexPairV3(root);
  const applied = runSteeringApply({ repoRoot: root, target: 'codex' });
  assert.equal(applied.materialization.worker?.kind, 'host');
  const body = read(root, '.codex/agents/worker.toml');
  assert.match(body, /ordinary `# Fadeno step assignment` heading, FIRST\nwrite the ENTIRE task prompt/);
  assert.match(body, /steering resolve --archetype worker --host-executor luna --prompt-file <path>/);
  assert.match(body, /dispatch --archetype worker --prompt-file <path>/);
  // mode=command now covers two distinct reasons (plain command dial, or a
  // selected pair) and the instructions must not let the agent tell them
  // apart before dispatching — both go through the same file, the same way.
  assert.match(body, /both arms are moving to the command lane so they are comparable/);
});

test('Codex command-broker instructions also write the prompt file before resolving', (t) => {
  // renderCodexCommandBroker() used to resolve with no prompt at all and only
  // write the prompt file AFTER learning mode=command — its sibling
  // renderCodexHostAgent() (tested just above) and the static
  // templates/codex/codex-steering-agents/*.toml were already fixed to write
  // first. Same fix here, same order: write the prompt file, THEN resolve
  // with --prompt-file, THEN dispatch that same file — never a second write.
  const root = tempRepo(t);
  seedCodexPairV3(root);
  // A command-only session dial (no host route at all) forces the
  // command-broker branch instead of the host-agent branch tested above.
  writeLocalDialState(root, { dials: { worker: { model: 'grok' } }, shadows: {}, legacyNote: null });
  const applied = runSteeringApply({ repoRoot: root, target: 'codex' });
  assert.equal(applied.materialization.worker?.kind, 'command-broker');
  const body = read(root, '.codex/agents/worker.toml');
  const writeAt = body.indexOf('ENTIRE task prompt');
  const resolveAt = body.indexOf('steering resolve --archetype worker --prompt-file');
  assert.ok(writeAt >= 0, 'template must instruct writing the prompt verbatim');
  assert.ok(resolveAt > writeAt, 'the prompt file must be written BEFORE steering resolve');
  assert.match(body, /ordinary `# Fadeno step assignment` heading, FIRST\nwrite the ENTIRE task prompt/);
  assert.match(body, /steering resolve --archetype worker --prompt-file <path>/);
  assert.doesNotMatch(body, /--host-executor/);
  // Dispatches the SAME file the resolver was handed, never a second write.
  assert.match(body, /dispatch --archetype worker --prompt-file <path>/);
});

test('Codex steering resolve forces mode=command on a selected, routable pair, keyed on the prompt file it is handed', (t) => {
  const root = tempRepo(t);
  seedCodexPairV3(root);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'grok', rate: 1 } }, legacyNote: null });
  mkdirSync(join(root, '.fadeno', 'local', 'prompts'), { recursive: true });
  const promptPath = join(root, '.fadeno', 'local', 'prompts', 'task-1.md');
  writeFileSync(promptPath, 'do the pairable thing');

  // Baseline: hostExecutor matches the resolved dial, so with no digest at
  // all this resolves mode=host, same as it would with no shadow attached.
  const noDigest = runSteeringResolve({ repoRoot: root, archetype: 'worker', hostExecutor: 'luna' });
  assert.equal(noDigest.mode, 'host');
  // A rate is set but no digest was supplied — the resolver cannot answer
  // "is this a pair", and must not read that silence as "no".
  assert.equal(noDigest.shadow?.selected, null);

  const paired = runSteeringResolve({
    repoRoot: root, archetype: 'worker', hostExecutor: 'luna', promptFile: promptPath,
  });
  assert.equal(paired.shadow?.selected, true);
  assert.equal(paired.shadow?.routable, true);
  // The whole point of a symmetric pair: an in-session primary cannot be
  // isolated, measured, or diffed the way its command-delivered challenger
  // is, so the resolution routes it to the command lane instead of `host`.
  assert.equal(paired.mode, 'command');
  assert.match(paired.detail, /pair selected/);
  assert.match(paired.detail, /both arms are comparable/);

  // `--prompt-sha256` is the pre-computed alternative, and it must agree
  // exactly with hashing the file here — the same digest the kernel will
  // compute from the same path when the agent later dispatches it, or hook
  // and kernel (here, resolver and kernel) could disagree on the pair.
  const digest = sha256Hex(readFileSync(promptPath, 'utf8'));
  const viaSha = runSteeringResolve({
    repoRoot: root, archetype: 'worker', hostExecutor: 'luna', promptSha256: digest,
  });
  assert.equal(viaSha.mode, 'command');
  assert.equal(viaSha.shadow?.selected, true);
});

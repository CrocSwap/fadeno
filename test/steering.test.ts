import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { stampHookVersion } from '../src/commands/plugin.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
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
    assert.match(body, /dial-aware/i);
    assert.match(body, new RegExp(`First run .*fadeno steering resolve --archetype ${archetype}`));
    assert.match(body, new RegExp(`fadeno dispatch --archetype ${archetype} --prompt-file`));
    assert.match(body, /ENTIRE task prompt.*verbatim/s);
    assert.match(body, /mode=restart_required/);
    assert.match(body, /fadeno dispatch-fallback <run-id> <dispatch-id>/);
    assert.match(body, /do not silently/);
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

type EvidenceRow = Record<string, unknown> & { timestamp: string; prompt_snapshot: string };

function evidenceRows(root: string): EvidenceRow[] {
  return read(root, '.fadeno/dispatches.jsonl')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as EvidenceRow);
}

test('Claude steering writes the host_delivery evidence the kernel never sees', (t) => {
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
    model_override: 'sonnet',
    dial_source: null,
    driver: null,
    effort: null,
    // The harness Agent tool has no effort parameter: native spawns inherit.
    reasoning_effort: 'inherited',
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
  assert.match(read(root, '.codex/agents/worker.toml'), /Fadeno worker broker/i);
  assert.match(read(root, '.codex/agents/worker.toml'), /fadeno dispatch-fallback <run-id> <dispatch-id>/);
});

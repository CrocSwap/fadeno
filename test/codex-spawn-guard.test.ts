import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { stampHookVersion } from '../src/commands/plugin.ts';
import { packageVersion } from '../src/lib/paths.ts';
import { exists, read, tempRepo } from './helpers.ts';

/**
 * The Codex `PreToolUse` spawn guard.
 *
 * Same shape as `test/steering.test.ts`'s `runClaudeSteering` harness: stamp
 * the template into a temp tree, put a fake `fadeno` on PATH that prints a
 * canned `dial resolve` answer, point `PLUGIN_DATA` and `CODEX_HOME` at temp
 * directories, and feed the hook synthetic `PreToolUse` events on stdin. No
 * test reads or writes the developer's real `~/.codex` or user data dir.
 */
const REPO = join(import.meta.dirname, '..');
const TEMPLATE = join(REPO, 'templates', 'codex', 'hooks', 'spawn-guard.mjs');

const HOST_SLOT = JSON.stringify({
  archetype: 'worker',
  executor: 'gpt-5.6-luna@xhigh',
  model: 'gpt-5.6-luna',
  model_id: 'gpt-5.6-luna',
  effort: 'xhigh',
  effective_effort: 'xhigh',
  effort_pinned: true,
  lane: 'host',
  lane_reason: 'session already at the pinned effort',
  driver: 'codex',
  adapter: 'host',
  source: 'repo',
});

interface Guard {
  /** Repo root the hook is told it is running in (has a `.fadeno/` tree). */
  root: string;
  /** `PLUGIN_DATA` root, where the host-mode marker lives. */
  data: string;
  /** `CODEX_HOME`, whose `agents/` dir holds user-scope role agents. */
  codexHome: string;
  hostMode(on: boolean): void;
  /** What the fake `fadeno` on PATH prints for `dial resolve`. */
  resolver(stdout: string, options?: { exitCode?: number; sleepSeconds?: number }): void;
  run(event: Record<string, unknown>): { stdout: string; stderr: string; status: number | null };
  rows(): Array<Record<string, unknown>>;
}

const SESSION = 'sess-guard';

function guard(t: Parameters<typeof tempRepo>[0], options: { fadenoDir?: boolean } = {}): Guard {
  const base = tempRepo(t);
  const root = join(base, 'repo');
  const data = join(base, 'data');
  const codexHome = join(base, 'codex');
  const bin = join(base, 'bin');
  mkdirSync(root, { recursive: true });
  if (options.fadenoDir !== false) mkdirSync(join(root, '.fadeno'), { recursive: true });
  mkdirSync(join(codexHome, 'agents'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const script = join(base, 'spawn-guard.mjs');
  writeFileSync(script, stampHookVersion(readFileSync(TEMPLATE, 'utf8')), 'utf8');

  const marker = join(
    data,
    'host-mode',
    `${createHash('sha256').update(SESSION).digest('hex')}.enabled`,
  );
  const resolver = (stdout: string, opts: { exitCode?: number; sleepSeconds?: number } = {}): void => {
    const sleep = opts.sleepSeconds != null ? `sleep ${opts.sleepSeconds}\n` : '';
    writeFileSync(
      join(bin, 'fadeno'),
      `#!/bin/sh\n${sleep}printf '%s\\n' '${stdout}'\nexit ${opts.exitCode ?? 0}\n`,
    );
    chmodSync(join(bin, 'fadeno'), 0o755);
  };
  resolver(HOST_SLOT);

  return {
    root,
    data,
    codexHome,
    hostMode(on: boolean): void {
      mkdirSync(join(data, 'host-mode'), { recursive: true });
      // Presence is the whole signal, exactly as `host-mode-hook.mjs` writes it.
      if (on) writeFileSync(marker, 'enabled\n', 'utf8');
      else rmSync(marker, { force: true });
    },
    resolver,
    run(event: Record<string, unknown>) {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          PLUGIN_DATA: data,
          CODEX_HOME: codexHome,
        },
        input: JSON.stringify(event),
        encoding: 'utf8',
      });
      return { stdout: result.stdout, stderr: result.stderr, status: result.status };
    },
    rows() {
      if (!exists(root, '.fadeno/dispatches.jsonl')) return [];
      return read(root, '.fadeno/dispatches.jsonl')
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

function spawnEvent(root: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    cwd: root,
    hook_event_name: 'PreToolUse',
    model: 'gpt-6-astra',
    tool_name: 'Agent',
    tool_use_id: 'call-1',
    tool_input: toolInput,
    ...extra,
  };
}

function managedWorker(
  codexHome: string,
  options: { model?: string | null; effort?: string | null; hostExecutor?: string | null; managed?: boolean } = {},
): void {
  const model = options.model === undefined ? 'gpt-5.6-luna' : options.model;
  const effort = options.effort === undefined ? 'xhigh' : options.effort;
  const executor = options.hostExecutor === undefined ? 'gpt-5.6-luna@xhigh' : options.hostExecutor;
  const header = options.managed === false ? '' : '# fadeno:managed version=0.6.1 digest=deadbeef\n';
  const identity =
    (model != null ? `model = "${model}"\n` : '') +
    (effort != null ? `model_reasoning_effort = "${effort}"\n` : '');
  writeFileSync(
    join(codexHome, 'agents', 'fadeno-worker.toml'),
    `${header}name = "worker"
description = "Fadeno hybrid worker"
${identity}sandbox_mode = "workspace-write"

developer_instructions = """
${executor != null
      ? `Run \`fadeno steering resolve --archetype worker --host-executor ${executor} --prompt-file <path>\``
      : 'Run `fadeno steering resolve --archetype worker --prompt-file <path>`'}
"""
`,
    'utf8',
  );
}

function denial(stdout: string): { permissionDecision: string; permissionDecisionReason: string } {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  return parsed.hookSpecificOutput;
}

test('codex spawn guard: host mode denies a generic spawn and names the model it would inherit', (t) => {
  const g = guard(t);
  g.hostMode(true);
  const result = g.run(
    spawnEvent(g.root, { agent_type: 'default', fork_turns: 'none', message: 'do x', task_name: 'lane' }),
  );
  assert.equal(result.status, 0, result.stderr);

  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  // The receipt this guard exists for: a generic spawn silently inheriting the
  // parent's frontier model. The reason must name it, or the reader has to go
  // find out what `default` even runs on.
  assert.match(decision.permissionDecisionReason, /gpt-6-astra/);
  assert.match(decision.permissionDecisionReason, /default/);
  // And the two ways out, both spelled exactly as the user would type them.
  assert.match(decision.permissionDecisionReason, /\$fadeno-host off/);
  assert.doesNotMatch(decision.permissionDecisionReason, /\n/);

  const rows = g.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'host_refused');
  assert.deepEqual((rows[0]!.refusal as Record<string, unknown>).predicate, 'generic_spawn_in_host_mode');
  assert.equal(rows[0]!.parent_model, 'gpt-6-astra');
  assert.equal(rows[0]!.agent_type, 'default');
  assert.equal(rows[0]!.hook_version, packageVersion());
});

test('codex spawn guard: host mode off allows a generic spawn but records it', (t) => {
  const g = guard(t);
  g.hostMode(false);
  const result = g.run(
    spawnEvent(g.root, { agent_type: 'default', fork_turns: 'none', message: 'do x' }),
  );
  // Allow = exit 0 with no stdout at all. Anything else is a decision.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');

  const rows = g.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'native_spawn');
  assert.equal(rows[0]!.agent_type, 'default');
  assert.equal(rows[0]!.model_requested, null);
  // The whole point of the row: what a spawn naming no model actually runs on.
  assert.equal(rows[0]!.model_inherited, 'gpt-6-astra');
  assert.equal(rows[0]!.fork_turns, 'none');
  assert.equal(
    rows[0]!.prompt_sha256,
    createHash('sha256').update('do x').digest('hex'),
  );
  // No snapshot file for an unsteered spawn — the digest correlates it.
  assert.equal(exists(g.root, '.fadeno/local/prompts'), false);
});

test('codex spawn guard: a managed role agent that matches the dial is allowed and recorded', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome);
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');

  const rows = g.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'host_delivery');
  assert.equal(rows[0]!.archetype, 'worker');
  assert.equal(rows[0]!.lane, 'host');
  assert.equal(rows[0]!.drift, false);
  assert.equal(rows[0]!.executor, 'gpt-5.6-luna@xhigh');
  assert.equal(rows[0]!.transport, 'host');
  // Codex publishes no effort env to a hook command, so this is never observed.
  assert.equal(rows[0]!.session_effort, null);
  assert.deepEqual(rows[0]!.agent_file, {
    path: join(g.codexHome, 'agents', 'fadeno-worker.toml'),
    model: 'gpt-5.6-luna',
    reasoning_effort: 'xhigh',
    host_executor: 'gpt-5.6-luna@xhigh',
  });
  const snapshot = rows[0]!.prompt_snapshot as string;
  assert.match(snapshot, /^\.fadeno\/local\/prompts\/host-[0-9a-f]{8}\.md$/);
  assert.equal(read(g.root, snapshot), 'implement it');
});

test('codex spawn guard: a drifted agent file is denied in host mode and flagged without it', (t) => {
  const g = guard(t);
  managedWorker(g.codexHome, { model: 'gpt-5.6-sol' }); // the dial resolves gpt-5.6-luna

  g.hostMode(true);
  const denied = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(denied.status, 0, denied.stderr);
  const decision = denial(denied.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  // Both identities, so the reader can see which way the file is stale.
  assert.match(decision.permissionDecisionReason, /gpt-5\.6-sol/);
  assert.match(decision.permissionDecisionReason, /gpt-5\.6-luna/);
  // The fix, and the fact that a fresh session is part of it.
  assert.match(decision.permissionDecisionReason, /fadeno steering apply --codex/);
  const refused = g.rows().at(-1)!;
  assert.equal(refused.event, 'host_refused');
  assert.equal((refused.refusal as Record<string, unknown>).predicate, 'agent_file_drift');

  // Host mode off: Fadeno is not the authority on this session's spawns, so the
  // spawn proceeds — but the drift is on the record.
  g.hostMode(false);
  const allowed = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(allowed.stdout, '');
  const delivered = g.rows().at(-1)!;
  assert.equal(delivered.event, 'host_delivery');
  assert.equal(delivered.drift, true);
  // The file wins on Codex, so the recorded effort is the FILE's, not the dial's.
  assert.equal(delivered.reasoning_effort, 'xhigh');
});

test('codex spawn guard: a command-lane resolution is recorded, not second-guessed', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome, { model: null, effort: null, hostExecutor: null });
  g.resolver(
    JSON.stringify({
      archetype: 'worker',
      executor: 'claude-opus@high',
      model: 'claude-opus',
      model_id: 'claude-opus',
      effective_effort: 'high',
      effort_pinned: false,
      lane: 'command',
      lane_reason: 'command adapter',
      adapter: 'command',
      driver: 'claude',
      source: 'repo',
    }),
  );
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '', 'a command lane is the hybrid agent\'s own business');
  const row = g.rows().at(-1)!;
  assert.equal(row.event, 'host_delivery');
  assert.equal(row.lane, 'command');
  // Drift is not computed on a lane the guard does not adjudicate.
  assert.equal(row.drift, null);
});

test('codex spawn guard: a resolver that hangs denies with resolver_timeout in host mode', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome);
  g.resolver(HOST_SLOT, { sleepSeconds: 30 });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /10000ms/);
  const row = g.rows().at(-1)!;
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'resolver_timeout');
  // The budget that expired, so a reader never has to guess which one it was.
  assert.equal(row.timeout_ms, 10_000);
});

test('codex spawn guard: with host mode off a failed resolver allows the spawn and says so', (t) => {
  const g = guard(t);
  g.hostMode(false);
  managedWorker(g.codexHome);
  g.resolver('', { exitCode: 3 });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const row = g.rows().at(-1)!;
  assert.equal(row.event, 'host_delivery');
  // Not a silent gap: the row states outright that nothing resolved, so a
  // reader never mistakes an unverified spawn for a verified one.
  assert.equal(row.resolver, 'failed');
  assert.equal(row.lane, null);
  assert.equal(row.drift, null);
  assert.equal(row.executor, null);
});

test('codex spawn guard: an agent file without the managed header is generic', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome, { managed: false });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  const row = g.rows().at(-1)!;
  // Unmarked is the user's own file: not provably Fadeno's, so not a role agent.
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'generic_spawn_in_host_mode');
});

test('codex spawn guard: non-spawn tools pass through untouched', (t) => {
  const g = guard(t);
  g.hostMode(true);
  const result = g.run({
    session_id: SESSION,
    cwd: g.root,
    hook_event_name: 'PreToolUse',
    model: 'gpt-6-astra',
    tool_name: 'Bash',
    tool_use_id: 'call-9',
    tool_input: { command: 'ls' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(g.rows(), []);
});

test('codex spawn guard: a repo without .fadeno is still guarded but never written to', (t) => {
  const g = guard(t, { fadenoDir: false });
  g.hostMode(true);
  const result = g.run(spawnEvent(g.root, { agent_type: 'default', message: 'do x' }));
  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  // A hook must never be the thing that creates a Fadeno tree in a repo that
  // has none: the decision still stands, the evidence is simply not written.
  assert.equal(exists(g.root, '.fadeno'), false);
});

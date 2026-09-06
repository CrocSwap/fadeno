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
 *
 * The script is stamped into `<base>/plugin/hooks/` rather than beside the
 * temp root, because the hook now finds its own bundled CLI at
 * `<plugin>/bin/fadeno` when `PLUGIN_ROOT` is absent — the layout has to be
 * the real one for that fallback to be exercised rather than accidentally hit.
 */
const REPO = join(import.meta.dirname, '..');
const TEMPLATE = join(REPO, 'templates', 'codex', 'hooks', 'spawn-guard.mjs');

/**
 * What a real `fadeno dial resolve --archetype worker` emits for a HOST-adapter
 * dial under Codex — `DialResolveResult` spread with `decideLane`'s five lane
 * fields, not an invented subset.
 *
 * Two shapes, because they are the only two a Codex session can produce and
 * they take opposite branches. `readSessionEffort` reads `CLAUDE_EFFORT`, which
 * Codex never publishes, so `session_effort` is ALWAYS null here:
 *
 * - unpinned (`fadeno dial worker luna`): no pin, so effort states no opinion
 *   and the delivery rides the session — `lane: host`, `effort unpinned`.
 * - pinned (`fadeno dial worker luna@xhigh`): a pin with nothing able to
 *   observe the session's effort, so the resolver cannot keep it on the host
 *   lane — `lane: command`, `session effort unobserved`. This is the shape the
 *   guard used to skip drift on, while the spawn ran in-host anyway.
 */
const UNPINNED_HOST_SLOT = JSON.stringify({
  archetype: 'worker',
  executor: 'gpt-5.6-luna',
  model: 'gpt-5.6-luna',
  model_id: 'gpt-5.6-luna',
  effort: 'xhigh',
  pinned_effort: null,
  effective_effort: 'xhigh',
  effort_pinned: false,
  session_effort: null,
  lane: 'host',
  lane_reason: 'effort unpinned',
  harness: 'codex',
  variant: null,
  adapter: 'host',
  host: 'codex',
  source: 'repo',
});

const PINNED_HOST_SLOT = JSON.stringify({
  archetype: 'worker',
  executor: 'gpt-5.6-luna@xhigh',
  model: 'gpt-5.6-luna',
  model_id: 'gpt-5.6-luna',
  effort: 'xhigh',
  pinned_effort: 'xhigh',
  effective_effort: 'xhigh',
  effort_pinned: true,
  session_effort: null,
  lane: 'command',
  lane_reason: 'session effort unobserved',
  harness: 'codex',
  variant: null,
  adapter: 'host',
  host: 'codex',
  source: 'repo',
});

/**
 * The base-fallback slot: `current-host` names no provider-servable model, so
 * `renderCodexHostAgent` omits BOTH identity lines and the expected file state
 * is "no model, no effort" rather than a literal.
 */
const NEUTRAL_HOST_SLOT = JSON.stringify({
  archetype: 'worker',
  executor: 'current-host',
  model: 'current-host',
  model_id: 'current-host',
  effort: 'default',
  pinned_effort: null,
  effective_effort: 'default',
  effort_pinned: false,
  session_effort: null,
  lane: 'host',
  lane_reason: 'effort unpinned',
  harness: 'codex',
  variant: null,
  adapter: 'host',
  host: 'codex',
  source: 'binding',
});

interface Guard {
  /** Repo root the hook is told it is running in (has a `.fadeno/` tree). */
  root: string;
  /** `PLUGIN_DATA` root, where the host-mode marker lives. */
  data: string;
  /** `CODEX_HOME`, whose `agents/` dir holds user-scope role agents. */
  codexHome: string;
  /** The directory put on `PATH`; the fake `fadeno` lands here by default. */
  bin: string;
  /** `<plugin>/bin`, sibling of the stamped hook — the `PLUGIN_ROOT`-less fallback. */
  pluginBin: string;
  /** A directory with nothing in it, for a `PATH` carrying no `fadeno` at all. */
  emptyBin: string;
  hostMode(on: boolean): void;
  /** What the fake `fadeno` prints for `dial resolve`, and where it is written. */
  resolver(stdout: string, options?: { exitCode?: number; sleepSeconds?: number; dir?: string }): void;
  run(event: Record<string, unknown>, options?: { path?: string }): { stdout: string; stderr: string };
  rows(): Array<Record<string, unknown>>;
}

const SESSION = 'sess-guard';

function guard(t: Parameters<typeof tempRepo>[0], options: { fadenoDir?: boolean } = {}): Guard {
  const base = tempRepo(t);
  const root = join(base, 'repo');
  const data = join(base, 'data');
  const codexHome = join(base, 'codex');
  const bin = join(base, 'bin');
  const pluginBin = join(base, 'plugin', 'bin');
  const emptyBin = join(base, 'empty-bin');
  mkdirSync(root, { recursive: true });
  if (options.fadenoDir !== false) mkdirSync(join(root, '.fadeno'), { recursive: true });
  mkdirSync(join(codexHome, 'agents'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(pluginBin, { recursive: true });
  mkdirSync(emptyBin, { recursive: true });
  const script = join(base, 'plugin', 'hooks', 'spawn-guard.mjs');
  mkdirSync(join(base, 'plugin', 'hooks'), { recursive: true });
  writeFileSync(script, stampHookVersion(readFileSync(TEMPLATE, 'utf8')), 'utf8');

  const marker = join(
    data,
    'host-mode',
    `${createHash('sha256').update(SESSION).digest('hex')}.enabled`,
  );
  const resolver = (
    stdout: string,
    opts: { exitCode?: number; sleepSeconds?: number; dir?: string } = {},
  ): void => {
    const sleep = opts.sleepSeconds != null ? `sleep ${opts.sleepSeconds}\n` : '';
    const path = join(opts.dir ?? bin, 'fadeno');
    writeFileSync(path, `#!/bin/sh\n${sleep}printf '%s\\n' '${stdout}'\nexit ${opts.exitCode ?? 0}\n`);
    chmodSync(path, 0o755);
  };
  resolver(PINNED_HOST_SLOT);

  return {
    root,
    data,
    codexHome,
    bin,
    pluginBin,
    emptyBin,
    hostMode(on: boolean): void {
      mkdirSync(join(data, 'host-mode'), { recursive: true });
      // Presence is the whole signal, exactly as `host-mode-hook.mjs` writes it.
      if (on) writeFileSync(marker, 'enabled\n', 'utf8');
      else rmSync(marker, { force: true });
    },
    resolver,
    run(event: Record<string, unknown>, opts: { path?: string } = {}) {
      const env = { ...process.env };
      // Never inherited: an ambient PLUGIN_ROOT (this suite can run inside a
      // Codex session) would point the hook at a REAL bundled `fadeno`.
      delete env.PLUGIN_ROOT;
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...env,
          PATH: opts.path ?? `${bin}:${process.env.PATH ?? ''}`,
          PLUGIN_DATA: data,
          CODEX_HOME: codexHome,
        },
        input: JSON.stringify(event),
        encoding: 'utf8',
      });
      // A PreToolUse hook that exits non-zero is a broken hook, not a decision:
      // asserted here so every test in this file carries the check, exactly as
      // `runClaudeSteering` does.
      assert.equal(result.status, 0, result.stderr);
      return { stdout: result.stdout, stderr: result.stderr };
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

interface AgentFileOptions {
  model?: string | null;
  effort?: string | null;
  hostExecutor?: string | null;
  managed?: boolean;
  /** The file's `name` key — what Codex resolves a spawn's `agent_type` against. */
  name?: string;
}

function writeAgentFile(dir: string, filename: string, options: AgentFileOptions = {}): void {
  const model = options.model === undefined ? 'gpt-5.6-luna' : options.model;
  const effort = options.effort === undefined ? 'xhigh' : options.effort;
  const executor = options.hostExecutor === undefined ? 'gpt-5.6-luna@xhigh' : options.hostExecutor;
  const name = options.name ?? 'worker';
  const header = options.managed === false ? '' : '# fadeno:managed version=0.6.1 digest=deadbeef\n';
  const identity =
    (model != null ? `model = "${model}"\n` : '') +
    (effort != null ? `model_reasoning_effort = "${effort}"\n` : '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `${header}name = "${name}"
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

/** The user-scope `fadeno-worker.toml` that `steering apply --codex` writes. */
function managedWorker(codexHome: string, options: AgentFileOptions = {}): void {
  writeAgentFile(join(codexHome, 'agents'), 'fadeno-worker.toml', options);
}

/**
 * The sentence every refusal this guard writes ends with, appended inside
 * `deny()` so no path can lose it. Host mode's claim is that a Fadeno failure
 * is a user-facing event, and a refusal text is the one thing the spawning
 * model is guaranteed to read at that moment — the basanos receipt is a host
 * that met a failure, filed feedback, and routed around it silently.
 */
const REPORT_REFUSAL = 'Report this refusal to the user instead of routing around it.';

function denial(stdout: string): { permissionDecision: string; permissionDecisionReason: string } {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  // Asserted here rather than per test: every deny path in this file goes
  // through this parser, so a new refusal that forgot the sentence fails.
  assert.ok(
    parsed.hookSpecificOutput.permissionDecisionReason.endsWith(REPORT_REFUSAL),
    `refusal did not end with the report instruction: ${parsed.hookSpecificOutput.permissionDecisionReason}`,
  );
  return parsed.hookSpecificOutput;
}

/** The spawn-side relay attestations this guard stashed, or `[]`. */
function relayStash(root: string): Array<Record<string, unknown>> {
  if (!exists(root, '.fadeno/local/pending-relays.jsonl')) return [];
  return read(root, '.fadeno/local/pending-relays.jsonl')
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The canonical caller digest every writer of these markers must agree on. */
function callerDigest(text: string): string {
  return createHash('sha256').update(text.replace(/(?:\r?\n)+$/, '')).digest('hex');
}

test('codex spawn guard: host mode denies a generic spawn and names the model it would inherit', (t) => {
  const g = guard(t);
  g.hostMode(true);
  const result = g.run(
    spawnEvent(g.root, { agent_type: 'default', fork_turns: 'none', message: 'do x', task_name: 'lane' }),
  );

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
  // The refusal is the user's business, not a routing problem for the host to
  // solve quietly — the sentence says so, and it is the last thing read.
  assert.ok(decision.permissionDecisionReason.endsWith(REPORT_REFUSAL));

  const rows = g.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'host_refused');
  assert.deepEqual((rows[0]!.refusal as Record<string, unknown>).predicate, 'generic_spawn_in_host_mode');
  assert.equal(rows[0]!.parent_model, 'gpt-6-astra');
  assert.equal(rows[0]!.agent_type, 'default');
  assert.equal(rows[0]!.hook_version, packageVersion());
  // The row keeps the compact reason. The report instruction is addressed to
  // the caller, and repeating it on every line of an evidence view is noise.
  assert.doesNotMatch((rows[0]!.refusal as { message: string }).message, /Report this refusal/);
});

test('codex spawn guard: host mode off allows a generic spawn but records it', (t) => {
  const g = guard(t);
  g.hostMode(false);
  const result = g.run(
    spawnEvent(g.root, { agent_type: 'default', fork_turns: 'none', message: 'do x' }),
  );
  // Allow = exit 0 with no stdout at all. Anything else is a decision.
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

test('codex spawn guard: a PINNED host dial is drift-checked and recorded on the host lane', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome); // cut for gpt-5.6-luna@xhigh, exactly what the dial pins
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '');

  const rows = g.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'host_delivery');
  assert.equal(rows[0]!.archetype, 'worker');
  // The resolver said `command`/`session effort unobserved` — it reads
  // CLAUDE_EFFORT, which Codex never publishes. The agent file is the proof it
  // could not have: cut for this executor, carrying this effort, and the spawn
  // runs in-host on it. So the row records the lane the guard established.
  assert.equal(rows[0]!.lane, 'host');
  assert.equal(rows[0]!.lane_reason, 'host agent pins the same effort');
  assert.equal(rows[0]!.drift, false);
  assert.equal(rows[0]!.executor, 'gpt-5.6-luna@xhigh');
  assert.equal(rows[0]!.transport, 'host');
  // What it RUNS on, the key the Claude row also carries: the file's model,
  // because on Codex the file wins over anything passed at spawn time.
  assert.equal(rows[0]!.model_applied, 'gpt-5.6-luna');
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

test('codex spawn guard: an UNPINNED host dial keeps the resolver\'s own lane reason', (t) => {
  const g = guard(t);
  g.hostMode(true);
  g.resolver(UNPINNED_HOST_SLOT);
  managedWorker(g.codexHome, { hostExecutor: 'gpt-5.6-luna' });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '');

  const row = g.rows().at(-1)!;
  assert.equal(row.lane, 'host');
  // Nothing to upgrade: the resolver already had the answer, and overwriting
  // its reason would claim a proof that was never needed.
  assert.equal(row.lane_reason, 'effort unpinned');
  assert.equal(row.drift, false);
});

test('codex spawn guard: a pinned host dial whose file drifted is denied in host mode', (t) => {
  const g = guard(t);
  // The dial pins gpt-5.6-luna@xhigh; the file is a stale sol cut at high.
  managedWorker(g.codexHome, { model: 'gpt-5.6-sol', effort: 'high' });

  g.hostMode(true);
  const denied = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
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
  // The file wins on Codex, so the recorded effort is the FILE's `high`, not
  // the dial's `xhigh` — the two differ here precisely so this discriminates.
  assert.equal(delivered.effort, 'xhigh');
  assert.equal(delivered.reasoning_effort, 'high');
  assert.equal(delivered.model_applied, 'gpt-5.6-sol');
});

test('codex spawn guard: a current-host neutral slot has no identity to drift from', (t) => {
  const g = guard(t);
  g.hostMode(true);
  g.resolver(NEUTRAL_HOST_SLOT);
  // `renderCodexHostAgent` omits both identity lines for `current-host`.
  managedWorker(g.codexHome, { model: null, effort: null, hostExecutor: 'current-host' });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '');

  const row = g.rows().at(-1)!;
  assert.equal(row.drift, false);
  assert.equal(row.lane, 'host');
  assert.deepEqual(row.agent_file, {
    path: join(g.codexHome, 'agents', 'fadeno-worker.toml'),
    model: null,
    reasoning_effort: null,
    host_executor: 'current-host',
  });
  // The neutral slot inherits: what it runs on is the session's model, and
  // `model_applied` says so rather than leaving a null a reader must decode.
  assert.equal(row.model_applied, 'gpt-6-astra');
  assert.equal(row.reasoning_effort, 'inherited');
});

const PINNED_NEUTRAL_HOST_SLOT = JSON.stringify({
  archetype: 'worker',
  executor: 'current-host@xhigh',
  model: 'current-host',
  model_id: 'current-host',
  effort: 'xhigh',
  pinned_effort: 'xhigh',
  effective_effort: 'xhigh',
  effort_pinned: true,
  session_effort: null,
  // A pinned neutral dial has no command lane, so the resolver's honest answer
  // is restart_required — the shape `decideLane` gives with no proof.
  lane: 'restart_required',
  lane_reason: 'no command fallback',
  // `current-host` in a bare shell has no harness to name; inside Codex it is
  // the Codex session itself.
  harness: 'codex',
  variant: null,
  adapter: 'host',
  host: 'codex',
  source: 'user',
});

test('codex spawn guard: a pinned current-host dial is never proven by a file that pins nothing', (t) => {
  const g = guard(t);
  g.hostMode(true);
  g.resolver(PINNED_NEUTRAL_HOST_SLOT);
  // The file bakes the pinned ref as --host-executor but, as for every
  // current-host slot, carries neither model nor effort.
  managedWorker(g.codexHome, { model: null, effort: null, hostExecutor: 'current-host@xhigh' });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '');

  const row = g.rows().at(-1)!;
  assert.equal(row.drift, false);
  // No drift, but no proof either: the resolver's answer stands rather than
  // being upgraded to a claim the file cannot back.
  assert.equal(row.lane, 'restart_required');
  assert.equal(row.lane_reason, 'no command fallback');
  assert.equal(row.agent_file.reasoning_effort, null);
});

test('codex spawn guard: a pinned dial with no command lane is upgraded to host when the file carries the pin', (t) => {
  const g = guard(t);
  g.hostMode(true);
  const slot = { ...JSON.parse(PINNED_HOST_SLOT), lane: 'restart_required', lane_reason: 'no command fallback' };
  g.resolver(JSON.stringify(slot));
  managedWorker(g.codexHome, { model: slot.model_id, effort: slot.effective_effort, hostExecutor: slot.executor });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '');

  const row = g.rows().at(-1)!;
  assert.equal(row.drift, false);
  // Exactly what `decideLane` answers with `hostEffortProven: true`.
  assert.equal(row.lane, 'host');
  assert.equal(row.lane_reason, 'host agent pins the same effort');
});

test('codex spawn guard: a command-adapter resolution is recorded, not second-guessed', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome, { model: null, effort: null, hostExecutor: null });
  g.resolver(
    JSON.stringify({
      archetype: 'worker',
      executor: 'claude-opus@high',
      model: 'claude-opus',
      model_id: 'claude-opus',
      effort: 'high',
      pinned_effort: 'high',
      effective_effort: 'high',
      effort_pinned: true,
      session_effort: null,
      lane: 'command',
      lane_reason: 'session effort unobserved',
      adapter: 'command',
      harness: 'claude',
      variant: null,
      host: 'codex',
      source: 'repo',
    }),
  );
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '', 'a command broker is the hybrid agent\'s own business');
  const row = g.rows().at(-1)!;
  assert.equal(row.event, 'host_delivery');
  assert.equal(row.lane, 'command');
  assert.equal(row.lane_reason, 'session effort unobserved');
  // A broker file carries no identity at all, so there is nothing to drift.
  assert.equal(row.drift, null);
});

test('codex spawn guard: a resolver that hangs denies with resolver_timeout in host mode', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome);
  g.resolver(PINNED_HOST_SLOT, { sleepSeconds: 30 });
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
  assert.equal(result.stdout, '');
  const row = g.rows().at(-1)!;
  assert.equal(row.event, 'host_delivery');
  // Not a silent gap: the row states outright that nothing resolved, so a
  // reader never mistakes an unverified spawn for a verified one.
  assert.equal(row.resolver, 'failed');
  assert.equal(row.lane, null);
  assert.equal(row.lane_reason, null);
  assert.equal(row.drift, null);
  assert.equal(row.executor, null);
});

test('codex spawn guard: unreadable resolver output fails closed in host mode', (t) => {
  const g = guard(t);
  managedWorker(g.codexHome);
  g.resolver('not json at all');

  g.hostMode(true);
  const denied = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  const decision = denial(denied.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /unreadable resolution/);
  const refused = g.rows().at(-1)!;
  assert.equal(refused.event, 'host_refused');
  assert.equal((refused.refusal as Record<string, unknown>).predicate, 'resolver_error');

  // Outside host mode the spawn still goes through, exactly as before: this is
  // not evidence of a wrong identity, only of a resolver this hook cannot read.
  g.hostMode(false);
  const allowed = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(allowed.stdout, '');
  const delivered = g.rows().at(-1)!;
  assert.equal(delivered.event, 'host_delivery');
  assert.equal(delivered.resolver, 'unreadable');
  assert.equal(delivered.drift, null);
});

test('codex spawn guard: an empty resolution is a resolver_error, never agent_file_drift', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome);
  // `{}` used to reach the drift check, which read its missing `model` as
  // "resolves to the session model" and refused with the wrong diagnosis.
  g.resolver('{}');
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.doesNotMatch(decision.permissionDecisionReason, /stale/);
  const row = g.rows().at(-1)!;
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'resolver_error');
  assert.match((row.refusal as { message: string }).message, /no known adapter/);
});

test('codex spawn guard: without PLUGIN_ROOT the hook falls back to its own bundled CLI', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome);
  // The only `fadeno` anywhere is the plugin's own, and PATH cannot reach it.
  g.resolver(PINNED_HOST_SLOT, { dir: g.pluginBin });
  const result = g.run(
    spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }),
    { path: g.emptyBin },
  );
  assert.equal(result.stdout, '', 'the sibling bin resolved the dial');
  const row = g.rows().at(-1)!;
  assert.equal(row.event, 'host_delivery');
  assert.equal(row.resolver, 'ok');
  assert.equal(row.drift, false);
});

test('codex spawn guard: a resolver that cannot start is refused by its error code', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome);
  // No PLUGIN_ROOT, no sibling bundle, nothing named `fadeno` on PATH.
  const result = g.run(
    spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }),
    { path: g.emptyBin },
  );
  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  // "could not resolve" alone sends the reader to the dial; the code sends
  // them to the install, which is where the problem actually is.
  assert.match(decision.permissionDecisionReason, /ENOENT/);
  const row = g.rows().at(-1)!;
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'resolver_error');
  assert.match((row.refusal as { message: string }).message, /ENOENT/);
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

test('codex spawn guard: a managed file whose name disagrees with the type is generic', (t) => {
  const g = guard(t);
  g.hostMode(true);
  // A real hazard, not a contrivance: `fadeno-worker.toml` is a FILENAME, and
  // Codex resolves a spawn by the file's `name` key. Reading a reviewer's
  // identity off it would put the wrong model on a worker's evidence row.
  managedWorker(g.codexHome, { name: 'reviewer' });
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  const row = g.rows().at(-1)!;
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'generic_spawn_in_host_mode');
  assert.equal(row.archetype, null);
  assert.equal(denial(result.stdout).permissionDecision, 'deny');
});

test('codex spawn guard: the fadeno-<archetype> filename is not itself a spawnable type', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome); // name = "worker", file = fadeno-worker.toml
  const result = g.run(spawnEvent(g.root, { agent_type: 'fadeno-worker', message: 'implement it' }));
  const row = g.rows().at(-1)!;
  // No managed file declares `name = "fadeno-worker"`, so Codex would resolve
  // no custom agent for it — and neither does this guard.
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'generic_spawn_in_host_mode');
  assert.equal(denial(result.stdout).permissionDecision, 'deny');
});

test('codex spawn guard: an agent_type carrying a path traversal is generic', (t) => {
  const g = guard(t);
  g.hostMode(true);
  // Reachable by `join(userAgentDir(), '../agents/worker.toml')`, managed, and
  // its `name` even matches the spawned string — so only the traversal check
  // stops it being claimed as a role agent.
  writeAgentFile(join(g.codexHome, 'agents'), 'worker.toml', { name: '../agents/worker' });
  const result = g.run(spawnEvent(g.root, { agent_type: '../agents/worker', message: 'implement it' }));
  const row = g.rows().at(-1)!;
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'generic_spawn_in_host_mode');
  assert.equal(denial(result.stdout).permissionDecision, 'deny');
});

test('codex spawn guard: a project-scope file shadows the user-scope one entirely', (t) => {
  const g = guard(t);
  g.hostMode(true);
  // The user-scope file is current in both cases; the project one is what
  // Codex would actually load, so it is the only one that may be read.
  managedWorker(g.codexHome);

  // Unmanaged project file: the spawn is the user's own agent, so generic.
  writeAgentFile(join(g.root, '.codex', 'agents'), 'worker.toml', { managed: false });
  const generic = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(denial(generic.stdout).permissionDecision, 'deny');
  assert.equal(
    (g.rows().at(-1)!.refusal as Record<string, unknown>).predicate,
    'generic_spawn_in_host_mode',
  );

  // Managed but drifted: refused on the PROJECT file's identity, not the
  // user-scope file's, which is current and invisible here.
  writeAgentFile(join(g.root, '.codex', 'agents'), 'worker.toml', { model: 'gpt-5.6-sol' });
  const drifted = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  const decision = denial(drifted.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /gpt-5\.6-sol/);
  const row = g.rows().at(-1)!;
  assert.equal((row.refusal as Record<string, unknown>).predicate, 'agent_file_drift');
  assert.equal(
    (row.agent_file as { path: string }).path,
    join(g.root, '.codex', 'agents', 'worker.toml'),
  );
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

// --- Relay attestation, spawn side -------------------------------------------

test('codex spawn guard: every delivered managed spawn stashes the caller prompt digest', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome, { model: null, effort: null, hostExecutor: null });
  g.resolver(
    JSON.stringify({
      archetype: 'worker',
      executor: 'claude-opus@high',
      model: 'claude-opus',
      model_id: 'claude-opus',
      effort: 'high',
      pinned_effort: 'high',
      effective_effort: 'high',
      effort_pinned: true,
      session_effort: null,
      lane: 'command',
      lane_reason: 'session effort unobserved',
      adapter: 'command',
      harness: 'claude',
      variant: null,
      host: 'codex',
      source: 'repo',
    }),
  );
  g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  const stash = relayStash(g.root);
  assert.equal(stash.length, 1);
  // The CANONICAL digest, because the broker relays through a prompt FILE that
  // ends in a newline `message` never had. The dispatch-side marker
  // (`templates/codex/hooks/dispatch-proxy-guard.mjs`) and the kernel's
  // `callerPromptSha256` reduce the same task to this same value; hashing raw
  // bytes on either side would manufacture `relay_attested: false`.
  assert.equal(stash[0]!.prompt_sha256, callerDigest('implement it'));
  assert.equal(stash[0]!.hook_version, packageVersion());
  assert.equal(typeof stash[0]!.timestamp, 'string');
});

test('codex spawn guard: a HOST-lane managed spawn is stashed too', (t) => {
  const g = guard(t);
  g.hostMode(true);
  managedWorker(g.codexHome);
  g.resolver(PINNED_HOST_SLOT);
  const result = g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal(result.stdout, '');
  assert.equal(g.rows().at(-1)!.lane, 'host');
  // A host-adapter role agent resolves per task and dispatches on
  // `mode=command` (a shadow pair moves both arms to the command lane). Stash
  // only the command lane and those dispatches carry a proxy marker with no
  // spawn-side row of their own — which the kernel reads as DEFECTION.
  assert.equal(relayStash(g.root).length, 1);
});

test('codex spawn guard: a refused spawn stashes nothing', (t) => {
  const g = guard(t);
  g.hostMode(true);
  // Generic in host mode: denied, so nothing was ever handed over. A stash here
  // would be a spawn-side record with no spawn behind it.
  g.run(spawnEvent(g.root, { agent_type: 'default', message: 'do x' }));
  assert.deepEqual(relayStash(g.root), []);

  // And a managed spawn whose agent file drifted, which is the other refusal.
  managedWorker(g.codexHome, { model: 'gpt-5.6-sol' });
  g.resolver(PINNED_HOST_SLOT);
  g.run(spawnEvent(g.root, { agent_type: 'worker', message: 'implement it' }));
  assert.equal((g.rows().at(-1)!.refusal as { predicate: string }).predicate, 'agent_file_drift');
  assert.deepEqual(relayStash(g.root), []);
});

test('codex spawn guard: a spawn with no message has nothing to attest', (t) => {
  const g = guard(t);
  g.hostMode(false);
  managedWorker(g.codexHome);
  g.resolver(UNPINNED_HOST_SLOT);
  g.run(spawnEvent(g.root, { agent_type: 'worker' }));
  assert.equal(g.rows().at(-1)!.event, 'host_delivery');
  assert.deepEqual(relayStash(g.root), []);
});

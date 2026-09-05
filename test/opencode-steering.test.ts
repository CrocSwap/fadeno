import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runSteeringApplyOpenCode } from '../src/commands/steering.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { inspectOpenCodeMaterialization } from '../src/lib/opencode-steering.ts';
import { runStatus } from '../src/commands/status.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { packageVersion } from '../src/lib/paths.ts';
import { isFadenoPathIgnored, openCodeManagedIgnorePatterns } from '../src/lib/source-control.ts';
import { exists, read, tempRepo } from './helpers.ts';

/**
 * The OpenCode steering plugin's pure decision core. The emitted module hangs
 * everything testable behind one exported factory (`fadenoSteeringCore`) —
 * OpenCode's legacy loader calls every exported function at startup, so bare
 * helper exports would be invoked with PluginInput and poison the hooks list.
 * Tests import through the factory and never need a live OpenCode.
 */
const PLUGIN_PATH = join(import.meta.dirname, '..', 'templates', 'opencode', 'plugin', 'fadeno-steering.js');
const pluginModule = await import(PLUGIN_PATH);
const core = pluginModule.fadenoSteeringCore() as {
  ARCHETYPES: string[];
  MANAGED_MARK: string;
  RESOLVE_TIMEOUT_MS: number;
  extractArchetype: (name: unknown) => string | null;
  laneAction: (
    slot: any,
    archetype: string,
    opts?: { hasHostAgent?: boolean; hasDispatchAgent?: boolean; hasRefusalAgent?: boolean },
  ) => any;
  refusalEnvelope: (archetype: string, predicate: string, reason: string) => string;
  applyRewrite: (args: Record<string, unknown>, newAgent: string) => void;
  hostDeliveryRow: (fields: Record<string, any>) => Record<string, unknown>;
  hostRefusalRow: (fields: Record<string, any>) => Record<string, unknown>;
  taskCorrelation: (hookInput: Record<string, unknown>, args: Record<string, unknown>) => Record<string, unknown>;
};

type HookArgs = Record<string, unknown>;

/** Execute the emitted OpenCode hook with a deterministic fake resolver. */
async function invokeOpenCodeHook(
  t: import('node:test').TestContext,
  slot: Record<string, unknown> | null,
  args: HookArgs,
  resolverExit = 0,
): Promise<{ root: string; args: HookArgs; rows: Array<Record<string, unknown>> }> {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root });
  if (slot?.adapter === 'command') {
    writeLocalDialState(root, { dials: { worker: { model: 'opus' } }, shadows: {}, legacyNote: null });
    runSteeringApplyOpenCode({ repoRoot: root, force: true });
  }
  mkdirSync(join(root, 'test-bin'), { recursive: true });
  const resolver = join(root, 'test-bin', 'fadeno');
  writeFileSync(
    resolver,
    '#!/usr/bin/env node\n' +
      "const fs = require('node:fs');\n" +
      `if (${resolverExit} !== 0) { process.stderr.write('resolver failed\\n'); process.exit(${resolverExit}); }\n` +
      "process.stdout.write(fs.readFileSync('.fadeno/local/opencode-test-slot.json', 'utf8'));\n",
    'utf8',
  );
  chmodSync(resolver, 0o755);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  if (slot != null) writeFileSync(join(root, '.fadeno', 'local', 'opencode-test-slot.json'), `${JSON.stringify(slot)}\n`, 'utf8');
  const previousPath = process.env.PATH;
  process.env.PATH = `${join(root, 'test-bin')}${previousPath == null ? '' : `:${previousPath}`}`;
  try {
    const plugin = await pluginModule.default({ directory: root });
    const hooks = plugin as Record<string, (input: Record<string, unknown>, output: { args: HookArgs }) => Promise<void>>;
    await hooks['tool.execute.before']!({ tool: 'task', sessionID: 'session-hook', callID: 'call-hook' }, { args });
  } finally {
    if (previousPath == null) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  const evidencePath = join(root, '.fadeno', 'dispatches.jsonl');
  const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8').trim() : '';
  const rows = evidence === '' ? [] : evidence.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, args, rows };
}

// --- Archetype extraction ---

test('archetype extraction steers only spawns that name an archetype', () => {
  for (const a of core.ARCHETYPES) assert.equal(core.extractArchetype(a), a);
  // OpenCode's namespaced form is colon-based; slash-containing names are not
  // treated as Fadeno archetypes without evidence that OpenCode emits them.
  assert.equal(core.extractArchetype('fadeno:worker'), 'worker');
  assert.equal(core.extractArchetype('team/worker'), null);
  assert.equal(core.extractArchetype('team/sub/worker'), null);
  // Catch-alls, specialists, proxies, and near-misses stay unsteered.
  for (const name of ['general-purpose', 'explore', 'dispatch-worker', 'worker2', 'fadeno-worker', '']) {
    assert.equal(core.extractArchetype(name), null, name);
  }
  assert.equal(core.extractArchetype(null), null);
  assert.equal(core.extractArchetype(undefined), null);
  assert.equal(core.extractArchetype(42), null);
});

// --- Args spelling handling (field spelling is unverified across versions) ---

test('applyRewrite rewrites whichever task-arg spelling is present', () => {
  const snake: Record<string, unknown> = { subagent_type: 'worker', prompt: 'x' };
  core.applyRewrite(snake, 'reviewer');
  assert.equal(snake.subagent_type, 'reviewer');
  assert.ok(!('subagentType' in snake));

  const camel: Record<string, unknown> = { subagentType: 'worker' };
  core.applyRewrite(camel, 'reviewer');
  assert.equal(camel.subagentType, 'reviewer');
  assert.ok(!('subagent_type' in camel));

  const both: Record<string, unknown> = { subagent_type: 'worker', subagentType: 'worker' };
  core.applyRewrite(both, 'judge');
  assert.equal(both.subagent_type, 'judge');
  assert.equal(both.subagentType, 'judge');

  // Neither key present: default to the snake spelling rather than dropping the rewrite.
  const neither: Record<string, unknown> = {};
  core.applyRewrite(neither, 'reviewer');
  assert.equal(neither.subagent_type, 'reviewer');
});

test('taskCorrelation records native foreground/background, continuation, and hook ids', () => {
  assert.deepEqual(
    core.taskCorrelation(
      { sessionID: 'sess-1', callID: 'call-1' },
      { background: true, task_id: 'task-1' },
    ),
    { background: true, task_id: 'task-1', session_id: 'sess-1', call_id: 'call-1' },
  );
  assert.deepEqual(
    core.taskCorrelation(
      { session_id: 'sess-2', call_id: 'call-2' },
      { background: false, taskId: 'task-2' },
    ),
    { background: false, task_id: 'task-2', session_id: 'sess-2', call_id: 'call-2' },
  );
});

test('agent rewrite preserves every native background-task argument', () => {
  const args: Record<string, unknown> = {
    subagent_type: 'worker', prompt: 'keep me', background: true, task_id: 'continue-1',
    model: 'caller-model', variant: 'caller-variant', custom: { untouched: true },
  };
  const before = { ...args };
  core.applyRewrite(args, 'fadeno-dispatch-worker');
  assert.equal(args.subagent_type, 'fadeno-dispatch-worker');
  for (const key of ['prompt', 'background', 'task_id', 'model', 'variant', 'custom']) {
    assert.deepEqual(args[key], before[key], key);
  }
});

// --- Lane decision ---

test('laneAction fail-opens on garbage or unrecognized slots', () => {
  for (const slot of [null, undefined, {}, 'nope', { adapter: 'carrier-pigeon' }, 7]) {
    assert.deepEqual(core.laneAction(slot as any, 'worker'), { action: 'pass' });
  }
});

test('laneAction derives the lane from adapter alone when lane is missing (older CLI)', () => {
  assert.deepEqual(core.laneAction({ adapter: 'command' }, 'worker'), {
    action: 'dispatch', agent: 'fadeno-dispatch-worker', lane: 'command', pairSelected: false,
  });
  assert.deepEqual(
    core.laneAction({ adapter: 'host' }, 'worker', { hasHostAgent: true }),
    { action: 'host', agent: 'worker', lane: 'host' },
  );
});

test('laneAction passes through when the command target was not materialized', () => {
  assert.deepEqual(
    core.laneAction({ adapter: 'command' }, 'worker', { hasDispatchAgent: false }),
    { action: 'pass', lane: 'command', pairSelected: false },
  );
});

test('laneAction maps restart_required to a refusal carrying executor, effort, and remedy', () => {
  const decision = core.laneAction(
    {
      adapter: 'host',
      lane: 'restart_required',
      lane_reason: 'session effort mismatch',
      executor: 'luna',
      effective_effort: 'xhigh',
      session_effort: 'high',
    },
    'worker',
    { hasHostAgent: true },
  );
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.predicate, 'restart_required');
  assert.match(decision.reason, /no lane for luna at effort xhigh/);
  assert.match(decision.reason, /session effort high/);
  assert.match(decision.reason, /lane_reason: session effort mismatch|session effort mismatch/);
});

test('laneAction keeps refusal evidence eligible when the refusal target is absent', () => {
  const decision = core.laneAction(
    { adapter: 'host', lane: 'restart_required', executor: 'luna' },
    'worker',
    { hasRefusalAgent: false },
  );
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.rewrite, false);
});

test('laneAction sends a selected routable pair to dispatch on BOTH arms', () => {
  const decision = core.laneAction(
    { adapter: 'host', lane: 'host', shadow: { selected: true, routable: true } },
    'judge',
    { hasHostAgent: true },
  );
  assert.equal(decision.action, 'dispatch');
  assert.equal(decision.agent, 'fadeno-dispatch-judge');
  assert.equal(decision.pairSelected, true);
});

test('an unroutable selected pair degrades to no-pair, never a refusal', () => {
  const decision = core.laneAction(
    { adapter: 'host', lane: 'host', shadow: { selected: true, routable: false } },
    'worker',
    { hasHostAgent: true },
  );
  assert.equal(decision.action, 'host');
  assert.notEqual(decision.action, 'refuse');
});

test('host lane rewrites onto the materialized slot only when one exists', () => {
  const slot = { adapter: 'host', lane: 'host', model: 'anthropic/claude-opus-4.8' };
  assert.deepEqual(core.laneAction(slot, 'reviewer', { hasHostAgent: true }), {
    action: 'host', agent: 'reviewer', lane: 'host',
  });
  // No materialized file: untouched unsteered host spawn (static role agents remain).
  assert.deepEqual(core.laneAction(slot, 'reviewer'), { action: 'pass', lane: 'host' });
});

// --- Refusal embedding ---

test('the refusal envelope is clearly delimited and preserves the task text below it', () => {
  const envelope = core.refusalEnvelope('worker', 'resolver_timeout', 'did not answer within 10000ms');
  assert.match(envelope, /^# FADENO STEERING REFUSED \(resolver_timeout\)/);
  assert.match(envelope, /REFUSAL REASON: did not answer within 10000ms/);
  assert.match(envelope, /FADENO REFUSAL BOUNDARY/);
  // Prepending keeps the original prompt byte-for-byte below the boundary.
  const prompt = 'Do the actual task.';
  const rewritten = `${envelope}\n${prompt}`;
  assert.ok(rewritten.endsWith(prompt));
});

// --- Evidence rows ---

const SLOT = {
  executor: 'luna',
  model: 'gpt-5.6-luna',
  effort: 'pinned-effort',
  lane_reason: 'effort unpinned',
  session_effort: 'high',
  effective_effort: 'high',
  effort_pinned: false,
  // The 1.1 resolver shape the adapters actually read: `harness` is the
  // EXECUTOR and `variant` the lane policy chose. (`host` is the adapter's own
  // constant, not the resolver's.)
  harness: 'codex',
  variant: null,
};

test('host_delivery row carries the shared field names and always the digest', () => {
  const row = core.hostDeliveryRow({
    timestamp: '2026-08-23T00:00:00.000Z',
    archetype: 'worker',
    requested: 'worker',
    slot: SLOT,
    lane: 'host',
    modelOverride: null,
    promptSha256: 'a'.repeat(64),
    promptSnapshotRel: '.fadeno/local/prompts/host-aaaaaaaa.md',
    background: true,
    taskId: 'task-7',
    sessionId: 'session-7',
    callId: 'call-7',
  });
  assert.equal(row.format, '1.1');
  assert.equal(row.event, 'host_delivery');
  assert.equal(row.archetype, 'worker');
  assert.equal(row.agent_type, 'worker');
  assert.equal(row.transport, 'host');
  assert.equal(row.prompt_sha256, 'a'.repeat(64));
  assert.equal(row.prompt_snapshot, '.fadeno/local/prompts/host-aaaaaaaa.md');
  assert.equal(row.executor, 'luna');
  assert.equal(row.model_applied, 'gpt-5.6-luna');
  // Format 1.1 splits the two harness identities by their real names: `host`
  // is where the call ran, `harness` is what executed it. 1.0 spelled the
  // first `harness` and the second `driver`.
  assert.equal(row.host, 'opencode');
  assert.equal(row.effort, 'pinned-effort');
  assert.equal(row.effort_pinned, false);
  assert.equal(row.fadeno_version, row.hook_version);
  assert.equal(row.background, true);
  assert.equal(row.task_id, 'task-7');
  assert.equal(row.session_id, 'session-7');
  assert.equal(row.call_id, 'call-7');

  const inherited = core.hostDeliveryRow({
    timestamp: '2026-08-23T00:00:00.000Z',
    archetype: 'worker',
    requested: 'worker',
    slot: { ...SLOT, model: 'current-host', effort_pinned: undefined },
    lane: 'host',
    modelOverride: null,
    promptSha256: null,
  });
  assert.equal(inherited.model_applied, null);
  assert.equal(inherited.effort_pinned, null);
});

test('host_refused row records predicate, bounded message, and null identity when no slot resolved', () => {
  const row = core.hostRefusalRow({
    timestamp: '2026-08-23T00:00:00.000Z',
    archetype: 'judge',
    requested: 'team/judge',
    predicate: 'resolver_error',
    reason: `fadeno dial resolve failed\nwith a multi-line\tstderr ${'x'.repeat(600)}`,
    slot: null,
    promptSha256: 'b'.repeat(64),
    background: true,
    taskId: 'task-refused',
    sessionId: 'session-refused',
    callId: 'call-refused',
  });
  assert.equal(row.format, '1.1');
  assert.equal(row.event, 'host_refused');
  const refusal = row.refusal as { predicate: string; message: string };
  assert.equal(refusal.predicate, 'resolver_error');
  // One line, bounded at 400 chars — same discipline as the Claude hook.
  assert.ok(!/\s{2}|\n|\t/.test(refusal.message));
  assert.ok(refusal.message.length <= 400);
  assert.equal(row.timeout_ms, null);
  assert.equal(row.prompt_sha256, 'b'.repeat(64));
  assert.equal(row.background, true);
  assert.equal(row.task_id, 'task-refused');
  assert.equal(row.session_id, 'session-refused');
  assert.equal(row.call_id, 'call-refused');
  // Nothing resolved: every identity field is an explicit null, not omitted.
  for (const key of ['executor', 'model', 'effort', 'effort_pinned', 'session_effort', 'lane_reason']) {
    assert.equal(row[key], null, key);
  }

  const timedOut = core.hostRefusalRow({
    timestamp: '2026-08-23T00:00:00.000Z',
    archetype: 'judge',
    requested: 'judge',
    predicate: 'resolver_timeout',
    reason: 'timed out',
    slot: SLOT,
    promptSha256: null,
  });
  assert.equal(timedOut.timeout_ms, core.RESOLVE_TIMEOUT_MS);
  // Always include prompt_sha256 even when there was no prompt to hash.
  assert.ok('prompt_sha256' in timedOut && timedOut.prompt_sha256 === null);
});

// --- Emission ---

test('init --opencode materializes agents plus the plugin, stamped and managed', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root });

  const plugin = read(root, '.opencode/plugin/fadeno-steering.js');
  assert.match(plugin, /^\/\/ fadeno:managed version=\S+ digest=[0-9a-f]{64}$/m);
  // The emitters stamp HOOK_VERSION so evidence rows name the generation that wrote them.
  assert.match(plugin, new RegExp(`const HOOK_VERSION = '${packageVersion()}';`));
  // The template's shebang is stripped — a `.js` module under `.opencode/plugin/` is imported, not executed.
  assert.ok(!plugin.startsWith('#!'));

  for (const archetype of ['worker', 'reviewer', 'judge'] as const) {
    const slotPath =
      exists(root, `.opencode/agent/${archetype}.md`)
        ? `.opencode/agent/${archetype}.md`
        : `.opencode/agent/fadeno-dispatch-${archetype}.md`;
    const body = read(root, slotPath);
    // Frontmatter must stay first; the managed mark sits below it.
    assert.match(body, /^---\n/);
    assert.match(body, /<!-- fadeno:managed version=.* -->/, `${slotPath} lacks a closed managed mark`);
    if (slotPath.endsWith(`${archetype}.md`)) {
      // Host slots carry the dialed identity in frontmatter.
      assert.match(body, /^mode: subagent$/m);
    }
    assert.ok(exists(root, `.opencode/agent/fadeno-steering-refused-${archetype}.md`));
  }
});

test('OpenCode gitignore entries cover only Fadeno materialization', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root });
  const gitignore = read(root, '.gitignore');
  const lines = gitignore.split(/\r?\n/).map((line) => line.trim());

  for (const pattern of openCodeManagedIgnorePatterns(root)) {
    assert.ok(isFadenoPathIgnored(lines, pattern), pattern);
  }
  assert.doesNotMatch(gitignore, /^\.opencode\/agent\/$/m);
  assert.doesNotMatch(gitignore, /^\.opencode\/plugin\/$/m);
  assert.equal(isFadenoPathIgnored(lines, '.opencode/agent/unmanaged.md'), false);
  assert.equal(isFadenoPathIgnored(lines, '.opencode/plugin/other-plugin.js'), false);
  assert.equal(isFadenoPathIgnored(lines, '.opencode/agents/native.md'), false);

  const codexRoot = tempRepo(t);
  runInit({ target: 'codex', repoRoot: codexRoot });
  const codexGitignore = read(codexRoot, '.gitignore');
  assert.doesNotMatch(codexGitignore, /^\.opencode\/agent\//m);
  assert.doesNotMatch(codexGitignore, /^\.opencode\/plugin\//m);
});

test('OpenCode init reports one gitignore result when the file already exists', (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, '.gitignore'), 'project-owned.cache\n', 'utf8');

  const { results } = runInit({ target: 'opencode', repoRoot: root });

  const gitignoreResults = results.filter((item) => item.path === join(root, '.gitignore'));
  assert.equal(gitignoreResults.length, 1);
  assert.equal(gitignoreResults[0]!.status, 'appended');
  assert.match(read(root, '.gitignore'), /^project-owned\.cache$/m);
  assert.match(read(root, '.gitignore'), /^# fadeno:opencode-steering:begin$/m);
});

test('init preserves foreign files at exact managed paths without ignoring them', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.opencode', 'agent'), { recursive: true });
  mkdirSync(join(root, '.opencode', 'plugin'), { recursive: true });
  const foreignAgent = '---\ndescription: project-owned\nmode: subagent\n---\nforeign agent\n';
  const foreignPlugin = '// project-owned OpenCode plugin\nexport default {}\n';
  writeFileSync(join(root, '.opencode', 'agent', 'worker.md'), foreignAgent, 'utf8');
  writeFileSync(join(root, '.opencode', 'plugin', 'fadeno-steering.js'), foreignPlugin, 'utf8');

  runInit({ target: 'opencode', repoRoot: root });

  assert.equal(read(root, '.opencode/agent/worker.md'), foreignAgent);
  assert.equal(read(root, '.opencode/plugin/fadeno-steering.js'), foreignPlugin);
  const gitignore = read(root, '.gitignore');
  assert.doesNotMatch(gitignore, /^\.opencode\/agent\/worker\.md$/m);
  assert.doesNotMatch(gitignore, /^\.opencode\/plugin\/fadeno-steering\.js$/m);
});

test('standalone OpenCode apply installs ownership-aware ignores', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root, noSteering: true });
  mkdirSync(join(root, '.opencode', 'agent'), { recursive: true });
  mkdirSync(join(root, '.opencode', 'plugin'), { recursive: true });
  const foreignAgent = '---\ndescription: project-owned\nmode: subagent\n---\nforeign agent\n';
  const foreignPlugin = '// project-owned OpenCode plugin\nexport default {}\n';
  writeFileSync(join(root, '.opencode', 'agent', 'worker.md'), foreignAgent, 'utf8');
  writeFileSync(join(root, '.opencode', 'plugin', 'fadeno-steering.js'), foreignPlugin, 'utf8');

  runSteeringApplyOpenCode({ repoRoot: root });

  assert.equal(read(root, '.opencode/agent/worker.md'), foreignAgent);
  assert.equal(read(root, '.opencode/plugin/fadeno-steering.js'), foreignPlugin);
  const gitignore = read(root, '.gitignore');
  assert.doesNotMatch(gitignore, /^\.opencode\/agent\/worker\.md$/m);
  assert.doesNotMatch(gitignore, /^\.opencode\/plugin\/fadeno-steering\.js$/m);
  assert.match(gitignore, /^\.opencode\/agent\/reviewer\.md$/m);
});

test('OpenCode lane changes retire stale managed ignores without touching user entries', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root, noSteering: true });
  writeFileSync(join(root, '.gitignore'), `${read(root, '.gitignore')}project-owned.cache\n`, 'utf8');

  writeLocalDialState(root, { dials: { worker: { model: 'opus' } }, shadows: {}, legacyNote: null });
  runSteeringApplyOpenCode({ repoRoot: root, force: true });
  assert.match(read(root, '.gitignore'), /^\.opencode\/agent\/fadeno-dispatch-worker\.md$/m);

  writeLocalDialState(root, { dials: { worker: { model: 'current-host' } }, shadows: {}, legacyNote: null });
  runSteeringApplyOpenCode({ repoRoot: root, force: true });
  assert.match(read(root, '.gitignore'), /^\.opencode\/agent\/worker\.md$/m);

  writeLocalDialState(root, { dials: { worker: { model: 'opus' } }, shadows: {}, legacyNote: null });
  runSteeringApplyOpenCode({ repoRoot: root, force: true });
  const after = read(root, '.gitignore');
  assert.doesNotMatch(after, /^\.opencode\/agent\/worker\.md$/m);
  assert.match(after, /^\.opencode\/agent\/fadeno-dispatch-worker\.md$/m);
  assert.match(after, /^project-owned\.cache$/m);

  writeFileSync(join(root, '.opencode', 'agent', 'worker.md'), 'project-owned worker\n', 'utf8');
  const lines = after.split(/\r?\n/).map((line) => line.trim());
  assert.equal(isFadenoPathIgnored(lines, '.opencode/agent/worker.md'), false);
});

test('re-running init --opencode is non-destructive: managed files refresh, nothing else', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root });

  // A user file squatting on a managed path must survive a re-run.
  const userSlot = join(root, '.opencode', 'agent', 'unmanaged.md');
  writeFileSync(userSlot, '---\ndescription: mine\nmode: subagent\n---\nmine.\n', 'utf8');

  const second = runInit({ target: 'opencode', repoRoot: root });
  assert.ok(exists(root, '.opencode/agent/unmanaged.md'));
  assert.equal(read(root, '.opencode/agent/unmanaged.md'), '---\ndescription: mine\nmode: subagent\n---\nmine.\n');
  // Managed files are idempotent: identical bodies come back 'skipped'.
  const steering = second.results.filter((r) => r.path.includes('.opencode/agent/') || r.path.includes('.opencode/plugin/'));
  assert.ok(steering.length > 0);
  assert.ok(steering.every((r) => r.status === 'skipped'), JSON.stringify(steering));

  // --force refreshes what Fadeno wrote while still preserving foreign files.
  const third = runInit({ target: 'opencode', repoRoot: root, force: true });
  assert.ok(third.results.some((r) => r.status === 'overwritten'));
  assert.ok(exists(root, '.opencode/agent/unmanaged.md'));
});

test('status and doctor expose a healthy OpenCode materialization', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root });
  const status = runStatus({ repoRoot: root, target: 'opencode' });
  assert.ok(status.opencodeMaterialization?.healthy);
  assert.equal(status.opencodeMaterialization?.issues.length, 0);
  const doctor = runDoctor({ repoRoot: root, target: 'opencode', processEnv: {} });
  assert.ok(doctor.findings.some((item) => item.check === 'opencode-steering' && item.severity === 'ok'));
});

test('completely missing OpenCode materialization requires a fresh session', (t) => {
  const root = tempRepo(t);
  const expected = new Map<string, 'host' | 'command'>([['worker', 'host'], ['reviewer', 'host'], ['judge', 'host']]);
  const missing = inspectOpenCodeMaterialization(root, expected);
  assert.equal(missing.healthy, false);
  assert.ok(missing.issues.some((item) => item.kind === 'missing'));
  assert.equal(missing.restartRequired, true);
});

test('OpenCode diagnostics distinguish unmanaged, malformed, stale, digest drift, and contradiction', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root });
  const expected = new Map<string, 'host' | 'command'>([['worker', 'host'], ['reviewer', 'host'], ['judge', 'host']]);
  const healthy = inspectOpenCodeMaterialization(root, expected);
  assert.equal(healthy.issues.length, 0);
  assert.equal(healthy.plugin.digestValid, true);

  const plugin = join(root, '.opencode', 'plugin', 'fadeno-steering.js');
  writeFileSync(
    plugin,
    readFileSync(plugin, 'utf8').replace('const RESOLVE_TIMEOUT_MS = 10_000;', 'const RESOLVE_TIMEOUT_MS = 1;'),
    'utf8',
  );
  const pluginDrifted = inspectOpenCodeMaterialization(root, expected);
  assert.ok(pluginDrifted.issues.some((item) => item.kind === 'digest-drifted' && item.path === plugin));
  const driftDoctor = runDoctor({ repoRoot: root, target: 'opencode', processEnv: {} });
  assert.ok(driftDoctor.findings.some((item) => item.check === 'opencode-digest-drifted' && item.severity === 'warning'));

  const worker = join(root, '.opencode', 'agent', 'worker.md');
  writeFileSync(worker, '---\ndescription: foreign\nmode: subagent\n---\nforeign\n', 'utf8');
  const unmanaged = inspectOpenCodeMaterialization(root, expected);
  assert.ok(unmanaged.issues.some((item) => item.kind === 'unmanaged'));

  // Restore a managed body, then introduce each integrity failure separately.
  runInit({ target: 'opencode', repoRoot: root, force: true });
  const managed = readFileSync(worker, 'utf8');
  writeFileSync(worker, managed.replace('mode: subagent', 'mode: primary'), 'utf8');
  const malformed = inspectOpenCodeMaterialization(root, expected);
  assert.ok(malformed.issues.some((item) => item.kind === 'malformed'));

  runInit({ target: 'opencode', repoRoot: root, force: true });
  writeFileSync(worker, readFileSync(worker, 'utf8').replace(`version=${packageVersion()}`, 'version=0.0.0'), 'utf8');
  const stale = inspectOpenCodeMaterialization(root, expected);
  assert.ok(stale.issues.some((item) => item.kind === 'stale-version'));

  runInit({ target: 'opencode', repoRoot: root, force: true });
  writeFileSync(worker, `${readFileSync(worker, 'utf8')}drift\n`, 'utf8');
  const drifted = inspectOpenCodeMaterialization(root, expected);
  assert.ok(drifted.issues.some((item) => item.kind === 'digest-drifted'));

  runInit({ target: 'opencode', repoRoot: root, force: true });
  writeFileSync(join(root, '.opencode', 'agent', 'fadeno-dispatch-worker.md'), readFileSync(worker, 'utf8'), 'utf8');
  const contradictory = inspectOpenCodeMaterialization(root, expected);
  assert.ok(contradictory.issues.some((item) => item.kind === 'contradictory'));
});

test('runSteeringApplyOpenCode refuses user scope: dials must not steer every repo', (t) => {
  const root = tempRepo(t);
  assert.throws(
    () => runSteeringApplyOpenCode({ repoRoot: root, scope: 'user' }),
    /project scope only/,
  );
});

test('OpenCode hook preserves a foreground task and records hook correlation', async (t) => {
  const result = await invokeOpenCodeHook(t, { adapter: 'host', lane: 'host', model: 'current-host' }, {
    subagent_type: 'worker', prompt: 'foreground work', background: false,
    custom_arg: 'preserve',
  });
  assert.equal(result.args.subagent_type, 'worker');
  assert.equal(result.args.background, false);
  assert.equal(result.args.custom_arg, 'preserve');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.event, 'host_delivery');
  assert.equal(result.rows[0]!.background, false);
  assert.equal(result.rows[0]!.task_id, null);
  assert.equal(result.rows[0]!.session_id, 'session-hook');
  assert.equal(result.rows[0]!.call_id, 'call-hook');
});

test('OpenCode hook preserves a background task and continuation task_id on host delivery', async (t) => {
  const result = await invokeOpenCodeHook(t, { adapter: 'host', lane: 'host', model: 'current-host' }, {
    subagent_type: 'fadeno:worker', prompt: 'background work', background: true,
    task_id: 'task-continue-1', variant: 'fast',
  });
  assert.equal(result.args.subagent_type, 'worker');
  assert.equal(result.args.background, true);
  assert.equal(result.args.task_id, 'task-continue-1');
  assert.equal(result.args.variant, 'fast');
  assert.equal(result.rows[0]!.event, 'host_delivery');
  assert.equal(result.rows[0]!.background, true);
  assert.equal(result.rows[0]!.task_id, 'task-continue-1');
});

test('OpenCode command steering rewrites only the agent and leaves background continuation intact', async (t) => {
  const result = await invokeOpenCodeHook(t, { adapter: 'command', lane: 'command' }, {
    subagent_type: 'worker', prompt: 'command work', background: true,
    task_id: 'task-command-1', model: 'caller-model', extra: { keep: true },
  });
  assert.equal(result.args.subagent_type, 'fadeno-dispatch-worker');
  assert.equal(result.args.background, true);
  assert.equal(result.args.task_id, 'task-command-1');
  assert.equal(result.args.model, 'caller-model');
  assert.deepEqual(result.args.extra, { keep: true });
  assert.equal(result.rows.length, 0, 'command completion is evidenced by the dispatch kernel');
});

test('OpenCode refusal rewrites the broker while preserving background continuation evidence', async (t) => {
  const result = await invokeOpenCodeHook(t, {
    adapter: 'host', lane: 'restart_required', executor: 'luna', session_effort: 'high', effective_effort: 'xhigh',
  }, {
    subagent_type: 'worker', prompt: 'must not start', background: true, task_id: 'task-refused-1', model: 'caller-model',
  });
  assert.equal(result.args.subagent_type, 'fadeno-steering-refused-worker');
  assert.equal(result.args.background, true);
  assert.equal(result.args.task_id, 'task-refused-1');
  assert.match(String(result.args.prompt), /FADENO STEERING REFUSED/);
  assert.equal(result.rows[0]!.event, 'host_refused');
  assert.equal(result.rows[0]!.background, true);
  assert.equal(result.rows[0]!.task_id, 'task-refused-1');
  assert.equal(result.rows[0]!.session_id, 'session-hook');
  assert.equal(result.rows[0]!.call_id, 'call-hook');
});

test('OpenCode hook leaves unrelated agent names untouched without invoking steering', async (t) => {
  const result = await invokeOpenCodeHook(t, { adapter: 'host', lane: 'host' }, {
    subagent_type: 'general-purpose', prompt: 'scouting', background: true, task_id: 'task-general',
  });
  assert.deepEqual(result.args, {
    subagent_type: 'general-purpose', prompt: 'scouting', background: true, task_id: 'task-general',
  });
  assert.equal(result.rows.length, 0);
});

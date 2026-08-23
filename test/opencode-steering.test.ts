import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runSteeringApplyOpenCode } from '../src/commands/steering.ts';
import { packageVersion } from '../src/lib/paths.ts';
import { exists, read, tempRepo } from './helpers.ts';

/**
 * The OpenCode steering plugin's pure decision core. The emitted module hangs
 * everything testable behind one exported factory (`fadenoSteeringCore`) —
 * OpenCode's legacy loader calls every exported function at startup, so bare
 * helper exports would be invoked with PluginInput and poison the hooks list.
 * Tests import through the factory and never need a live OpenCode.
 */
const PLUGIN_PATH = join(import.meta.dirname, '..', 'templates', 'opencode', 'plugin', 'fadeno-steering.js');
const core = (await import(PLUGIN_PATH)).fadenoSteeringCore() as {
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
};

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
  driver: 'codex',
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
  });
  assert.equal(row.format, '1.0');
  assert.equal(row.event, 'host_delivery');
  assert.equal(row.archetype, 'worker');
  assert.equal(row.agent_type, 'worker');
  assert.equal(row.transport, 'host');
  assert.equal(row.prompt_sha256, 'a'.repeat(64));
  assert.equal(row.prompt_snapshot, '.fadeno/local/prompts/host-aaaaaaaa.md');
  assert.equal(row.executor, 'luna');
  assert.equal(row.model_applied, 'gpt-5.6-luna');
  assert.equal(row.effort, 'pinned-effort');
  assert.equal(row.effort_pinned, false);
  assert.equal(row.fadeno_version, row.hook_version);

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
  });
  assert.equal(row.format, '1.0');
  assert.equal(row.event, 'host_refused');
  const refusal = row.refusal as { predicate: string; message: string };
  assert.equal(refusal.predicate, 'resolver_error');
  // One line, bounded at 400 chars — same discipline as the Claude hook.
  assert.ok(!/\s{2}|\n|\t/.test(refusal.message));
  assert.ok(refusal.message.length <= 400);
  assert.equal(row.timeout_ms, null);
  assert.equal(row.prompt_sha256, 'b'.repeat(64));
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
  assert.match(plugin, /^\/\/ fadeno:managed version=/m);
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

test('runSteeringApplyOpenCode refuses user scope: dials must not steer every repo', (t) => {
  const root = tempRepo(t);
  assert.throws(
    () => runSteeringApplyOpenCode({ repoRoot: root, scope: 'user' }),
    /project scope only/,
  );
});

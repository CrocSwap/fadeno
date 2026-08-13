import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, runDispatch } from '../src/commands/dispatch.ts';
import {
  LoadoutError,
  runLoadoutClear,
  runLoadoutList,
  runLoadoutResolve,
  runLoadoutSet,
  runLoadoutShow,
  runLoadoutUse,
} from '../src/commands/loadout.ts';
import { runStatus } from '../src/commands/status.ts';
import { runUse } from '../src/commands/use.ts';
import { LOADOUT_LOCAL_FILE } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { read, tempRepo } from './helpers.ts';

/**
 * Session slot overrides across the loadout CLI surface (set/clear/use/show/
 * resolve) plus the two places the overlay must stay visible: `fadeno use
 * --project` and `fadeno status`. Every call passes `env: null` so a real
 * FADENO_LOADOUT in the developer's shell never leaks in.
 */

const EXECUTORS = {
  'opus-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'opus' },
  'luna-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'gpt-5.6-luna' },
  'terra-host': { adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer' },
};

const LOADOUTS = {
  'anthropic-primary': { worker: 'opus-cmd', reviewer: 'terra-host' },
  'openai-primary': { worker: 'luna-cmd', reviewer: 'terra-host' },
};

function seedProfile(t: TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

function seedLoadouts(t: TestContext): string {
  return seedProfile(t, { executors: EXECUTORS, loadouts: LOADOUTS, default_loadout: 'anthropic-primary' });
}

function isolatedUser(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
    },
  };
}

test('loadout set: pins the overlay over the active base, and clear round-trips to a bare name', (t) => {
  const root = seedLoadouts(t);

  // No pin at all: the active loadout comes from `default_loadout`, and the
  // overlay attaches to it by name — so the pin ends up naming it too.
  const set = runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });
  assert.equal(set.archetype, 'worker');
  assert.equal(set.target, 'luna-cmd');
  assert.equal(set.loadout, 'anthropic-primary');
  assert.equal(set.previous, null);
  assert.deepEqual(set.overrides, { worker: 'luna-cmd' });
  assert.deepEqual(set.droppedOverrides, {});
  assert.equal(set.droppedBase, null);
  assert.equal(
    read(root, LOADOUT_LOCAL_FILE),
    '{"loadout":"anthropic-primary","overrides":{"worker":"luna-cmd"}}\n',
  );

  // Re-dialing the same archetype reports what it replaced.
  const again = runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'opus-cmd' });
  assert.equal(again.previous, 'luna-cmd');
  assert.deepEqual(again.overrides, { worker: 'opus-cmd' });

  // Dropping the last override restores the bare-name pin: the file changes
  // shape only when its meaning does.
  const cleared = runLoadoutClear({ repoRoot: root, archetype: 'worker' });
  assert.equal(cleared.removed, true);
  assert.equal(cleared.cleared, 'opus-cmd');
  assert.equal(cleared.loadout, 'anthropic-primary');
  assert.deepEqual(cleared.overrides, {});
  assert.equal(read(root, LOADOUT_LOCAL_FILE), 'anthropic-primary\n');
});

test('loadout set: refuses with no active loadout, an unknown target, or a bad archetype key', (t) => {
  const bindingsOnly = seedProfile(t, { executors: EXECUTORS, bindings: { '*': 'opus-cmd' } });
  assert.throws(
    () => runLoadoutSet({ repoRoot: bindingsOnly, env: null, archetype: 'worker', target: 'opus-cmd' }),
    (err: unknown) =>
      err instanceof LoadoutError &&
      /No loadout is active.*`fadeno loadout use <name>`/s.test(err.message),
  );
  assert.equal(existsSync(join(bindingsOnly, LOADOUT_LOCAL_FILE)), false);

  const root = seedLoadouts(t);
  assert.throws(
    () => runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'ghost-cmd' }),
    (err: unknown) =>
      err instanceof LoadoutError &&
      /"ghost-cmd" is not a declared executor \(luna-cmd, opus-cmd, terra-host\)/.test(err.message),
  );
  assert.throws(
    () => runLoadoutSet({ repoRoot: root, env: null, archetype: 'Worker!', target: 'opus-cmd' }),
    /archetype "Worker!" is not a bare lowercase identifier/,
  );
  // A refused set writes nothing.
  assert.equal(existsSync(join(root, LOADOUT_LOCAL_FILE)), false);
});

test('loadout set: refuses a mutating archetype dialed onto a read-only command route', (t) => {
  // Same shape a v2 `routes.<harness>.<target>.write_access: false` compiles
  // to: a command delivery that cannot mutate the workspace.
  const root = seedProfile(t, {
    executors: {
      'ro-cmd': { adapter: 'command', command: ['claude', '-p'], model: 'opus', write_access: false },
      'rw-cmd': { adapter: 'command', command: ['codex', 'exec', '-'], model: 'luna', write_access: true },
      'ro-host': {
        adapter: 'host', model: 'opus', reasoning_effort: 'high', agent_type: 'worker',
        fallback_command: ['claude', '-p'], write_access: false,
      },
    },
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
    loadouts: { safe: { worker: 'rw-cmd', reviewer: 'ro-cmd' } },
    default_loadout: 'safe',
  });

  // The dispatch kernel's own refusal, spoken at dial time.
  assert.throws(
    () => runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'ro-cmd' }),
    (err: unknown) =>
      err instanceof LoadoutError &&
      /archetype "worker" declares `requires_write: required`, but executor "ro-cmd" delivers through a command route declared `write_access: false`/.test(
        err.message,
      ),
  );
  assert.equal(existsSync(join(root, LOADOUT_LOCAL_FILE)), false);

  // An archetype that claims no write need is unaffected...
  assert.deepEqual(
    runLoadoutSet({ repoRoot: root, env: null, archetype: 'reviewer', target: 'ro-cmd' }).overrides,
    { reviewer: 'ro-cmd' },
  );
  // ...and a native delivery is never refused: the in-session agent's
  // permissions are the host's business, not this policy's.
  assert.deepEqual(
    runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'ro-host' }).overrides,
    { reviewer: 'ro-cmd', worker: 'ro-host' },
  );
});

test('loadout set: a pin decorating a different base is rebased, and the drop is reported', (t) => {
  const root = seedLoadouts(t);
  runLoadoutUse({ repoRoot: root, name: 'openai-primary' });
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'opus-cmd' });
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'judge', target: 'terra-host' });

  // `--loadout` selects a different base for this invocation: the old overlay
  // belongs to "openai-primary" by name and cannot follow.
  const rebased = runLoadoutSet({
    repoRoot: root,
    env: null,
    loadout: 'anthropic-primary',
    archetype: 'reviewer',
    target: 'luna-cmd',
  });
  assert.equal(rebased.loadout, 'anthropic-primary');
  assert.equal(rebased.previous, null);
  assert.deepEqual(rebased.overrides, { reviewer: 'luna-cmd' });
  assert.deepEqual(rebased.droppedOverrides, { judge: 'terra-host', worker: 'opus-cmd' });
  assert.equal(rebased.droppedBase, 'openai-primary');
  assert.equal(
    read(root, LOADOUT_LOCAL_FILE),
    '{"loadout":"anthropic-primary","overrides":{"reviewer":"luna-cmd"}}\n',
  );
});

test('loadout clear <archetype>: removes one override and reports a missing one instead of throwing', (t) => {
  const root = seedLoadouts(t);
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'judge', target: 'terra-host' });

  const one = runLoadoutClear({ repoRoot: root, archetype: 'judge' });
  assert.equal(one.removed, true);
  assert.equal(one.cleared, 'terra-host');
  assert.deepEqual(one.overrides, { worker: 'luna-cmd' });
  assert.equal(
    read(root, LOADOUT_LOCAL_FILE),
    '{"loadout":"anthropic-primary","overrides":{"worker":"luna-cmd"}}\n',
  );

  // Idempotent-friendly: the intent ("that override is gone") already holds.
  const missing = runLoadoutClear({ repoRoot: root, archetype: 'judge' });
  assert.equal(missing.removed, false);
  assert.equal(missing.cleared, null);
  assert.equal(missing.archetype, 'judge');
  assert.deepEqual(missing.overrides, { worker: 'luna-cmd' });

  // Bare `clear` still drops the whole pin, overlay and base together.
  const all = runLoadoutClear({ repoRoot: root });
  assert.equal(all.removed, true);
  assert.equal(all.archetype, null);
  assert.equal(existsSync(join(root, LOADOUT_LOCAL_FILE)), false);
});

test('loadout use: selecting a base drops the overlay and reports what it dropped', (t) => {
  const root = seedLoadouts(t);
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });

  const used = runLoadoutUse({ repoRoot: root, name: 'openai-primary' });
  assert.equal(used.previous, 'anthropic-primary');
  assert.deepEqual(used.droppedOverrides, { worker: 'luna-cmd' });
  assert.equal(read(root, LOADOUT_LOCAL_FILE), 'openai-primary\n');
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: null }).overrides, {});
});

test('use --project: the project pin drops the overlay and says so in one notice', (t) => {
  const root = seedLoadouts(t);
  const paths = isolatedUser(root);
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });

  const result = runUse({ repoRoot: root, userPathOptions: paths, name: 'openai-primary', project: true });
  assert.equal(result.scope, 'project');
  assert.equal(result.previous, 'anthropic-primary');
  assert.deepEqual(result.droppedOverrides, { worker: 'luna-cmd' });
  assert.equal(read(root, LOADOUT_LOCAL_FILE), 'openai-primary\n');
  assert.match(result.notices.join('\n'), /dropped 1 session override\(s\) pinned over "anthropic-primary" \(worker→luna-cmd\)/);

  // User scope never carries an overlay, so nothing is ever dropped there.
  assert.deepEqual(runUse({ repoRoot: root, userPathOptions: paths, name: 'openai-primary' }).droppedOverrides, {});
});

test('loadout show: the effective table marks overrides, their base, and slot-less rows', (t) => {
  const root = seedLoadouts(t);
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'judge', target: 'terra-host' });

  const shown = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(shown.active, { name: 'anthropic-primary', source: 'local' });
  assert.deepEqual(shown.overrides, { judge: 'terra-host', worker: 'luna-cmd' });
  assert.deepEqual(shown.slots, [
    // An override can bind an archetype the loadout has no slot for at all.
    { archetype: 'judge', executor: 'terra-host', model: 'gpt-5.6-terra', adapter: 'host', overridden: true, baseExecutor: null },
    { archetype: 'reviewer', executor: 'terra-host', model: 'gpt-5.6-terra', adapter: 'host', overridden: false, baseExecutor: 'terra-host' },
    { archetype: 'worker', executor: 'luna-cmd', model: 'gpt-5.6-luna', adapter: 'command', overridden: true, baseExecutor: 'opus-cmd' },
  ]);

  // The overlay belongs to its base by NAME: it applies when any source lands
  // on that name, and drops when the active loadout is someone else.
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: 'anthropic-primary' }).overrides, {
    judge: 'terra-host',
    worker: 'luna-cmd',
  });
  const elsewhere = runLoadoutShow({ repoRoot: root, env: 'openai-primary' });
  assert.deepEqual(elsewhere.overrides, {});
  assert.deepEqual(
    elsewhere.slots.map((slot) => [slot.archetype, slot.executor, slot.overridden]),
    [['reviewer', 'terra-host', false], ['worker', 'luna-cmd', false]],
  );
});

test('loadout list: the active entry is the effective table; the others stay declarations', (t) => {
  const root = seedLoadouts(t);
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });

  const listed = runLoadoutList({ repoRoot: root, env: null });
  assert.deepEqual(listed.overrides, { worker: 'luna-cmd' });
  const activeEntry = listed.loadouts.find((entry) => entry.isActive)!;
  assert.equal(activeEntry.name, 'anthropic-primary');
  // The active listing must show the binding dispatch would use, marked.
  assert.deepEqual(
    activeEntry.slots.map((slot) => [slot.archetype, slot.executor, slot.overridden, slot.baseExecutor]),
    [
      ['reviewer', 'terra-host', false, 'terra-host'],
      ['worker', 'luna-cmd', true, 'opus-cmd'],
    ],
  );
  // Non-active loadouts keep their declared slots, no overlay flags.
  const other = listed.loadouts.find((entry) => entry.name === 'openai-primary')!;
  assert.deepEqual(
    other.slots.map((slot) => [slot.archetype, slot.executor, slot.overridden]),
    [['reviewer', 'terra-host', undefined], ['worker', 'luna-cmd', undefined]],
  );

  // A stale override target surfaces in the listing instead of bricking it.
  writeFileSync(
    join(root, LOADOUT_LOCAL_FILE),
    `${JSON.stringify({ loadout: 'anthropic-primary', overrides: { worker: 'gone-cmd' } })}\n`,
  );
  const staleListed = runLoadoutList({ repoRoot: root, env: null });
  assert.deepEqual(staleListed.staleOverrides, [{ archetype: 'worker', target: 'gone-cmd' }]);
  assert.deepEqual(
    staleListed.loadouts.find((entry) => entry.isActive)!.slots.map((slot) => [slot.archetype, slot.executor]),
    [['reviewer', 'terra-host'], ['worker', 'opus-cmd']],
  );
});

test('loadout show: an override naming a since-removed executor is reported, not fatal', (t) => {
  const root = seedLoadouts(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, LOADOUT_LOCAL_FILE),
    `${JSON.stringify({ loadout: 'anthropic-primary', overrides: { worker: 'retired-cmd' } })}\n`,
  );

  const shown = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(shown.staleOverrides, [{ archetype: 'worker', target: 'retired-cmd' }]);
  // Filtered out of the table, so the row falls back to the loadout's slot.
  assert.deepEqual(
    shown.slots.map((slot) => [slot.archetype, slot.executor, slot.overridden]),
    [['reviewer', 'terra-host', false], ['worker', 'opus-cmd', false]],
  );

  // Resolution, unlike inspection, refuses it: substituting a different
  // executor for the one the user dialed is the failure this layer prevents.
  assert.throws(
    () => runLoadoutResolve({ repoRoot: root, env: null, archetype: 'worker' }),
    (err: unknown) =>
      err instanceof LoadoutError &&
      /Session override for archetype "worker" targets "retired-cmd"/.test(err.message) &&
      /fadeno loadout clear worker/.test(err.message),
  );
});

test('loadout resolve: gains source/override without disturbing the fields hooks parse', (t) => {
  const root = seedLoadouts(t);

  const base = runLoadoutResolve({ repoRoot: root, env: null, archetype: 'worker' });
  // Additive only: the Claude steering hook reads this JSON.
  assert.deepEqual(Object.keys(base), [
    'archetype',
    'active',
    'executor',
    'model',
    'adapter',
    'harness',
    'source',
    'override',
    'delivery',
  ]);
  assert.equal(base.executor, 'opus-cmd');
  assert.equal(base.model, 'opus');
  assert.equal(base.adapter, 'command');
  assert.equal(base.source, 'loadout');
  assert.equal(base.override, false);
  // `adapter` states what the slot is; `delivery` states what to do with it
  // from here. A director that reads only the former can narrate "host
  // adapter" correctly and still dispatch into a refusal.
  assert.deepEqual(base.delivery, {
    dispatchable: true,
    dispatch_command: 'fadeno dispatch --archetype worker',
    action:
      'Dispatch it: `fadeno dispatch --archetype worker` with the task prompt on stdin. ' +
      'Executor "opus-cmd" runs outside this harness.',
  });

  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });
  const overridden = runLoadoutResolve({ repoRoot: root, env: null, archetype: 'worker' });
  assert.equal(overridden.executor, 'luna-cmd');
  assert.equal(overridden.model, 'gpt-5.6-luna');
  assert.equal(overridden.source, 'override');
  assert.equal(overridden.override, true);
  // The unoverridden slot still resolves through the loadout.
  assert.equal(runLoadoutResolve({ repoRoot: root, env: null, archetype: 'reviewer' }).source, 'loadout');
});

test('status: the pin line names its overrides, and the role table shows the effective binding', (t) => {
  const root = seedLoadouts(t);
  const paths = isolatedUser(root);
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'luna-cmd' });

  const status = runStatus({ repoRoot: root, userPathOptions: paths, env: null });
  assert.deepEqual(status.activeLoadout, { name: 'anthropic-primary', source: 'local' });
  assert.deepEqual(status.pinOverrides, { worker: 'luna-cmd' });
  const worker = status.roles.find((role) => role.archetype === 'worker')!;
  assert.equal(worker.executor, 'luna-cmd');
  assert.equal(worker.overridden, true);
  assert.equal(status.roles.find((role) => role.archetype === 'reviewer')!.overridden, false);

  // An overlay pinned over a different base is not this loadout's business.
  const elsewhere = runStatus({ repoRoot: root, userPathOptions: paths, env: 'openai-primary' });
  assert.deepEqual(elsewhere.pinOverrides, {});
  assert.equal(elsewhere.roles.find((role) => role.archetype === 'worker')!.overridden, false);
});

/**
 * The resolver's hint and the kernel's refusal share one predicate
 * (`dispatchability`) on purpose. A hint that says "dispatchable" where the
 * kernel refuses is worse than no hint: it sends a director confidently down
 * a path that ends in a rejected call after the prompt is already written,
 * which is exactly what the 2026-08-13 dogfood spent four tool calls on.
 */
test('loadout resolve: a host slot the kernel would refuse is reported as do-not-dispatch', (t) => {
  const root = seedProfile(t, {
    schema_version: 2,
    targets: { 'in-session': { provider: 'current-host', model: 'current-host' } },
    routes: { claude: { 'in-session': { host: true } } },
    loadouts: { main: { reviewer: 'in-session' } },
    default_loadout: 'main',
  });
  const user = { ...isolatedUser(root), env: { ...isolatedUser(root).env, FADENO_HARNESS: 'claude' } };

  const resolved = runLoadoutResolve({
    repoRoot: root,
    env: null,
    archetype: 'reviewer',
    userPathOptions: user,
  });
  assert.equal(resolved.adapter, 'host');
  assert.equal(resolved.harness, 'claude');
  assert.equal(resolved.delivery.dispatchable, false);
  assert.equal(resolved.delivery.dispatch_command, null);
  // Every branch ends in a verb: reading `adapter: "host"` was never the
  // problem, acting on it was.
  assert.match(resolved.delivery.action, /^Do NOT dispatch\./);
  assert.match(resolved.delivery.action, /spawn the in-session reviewer agent instead/);

  // And the kernel really does refuse it — the hint is not a guess about the
  // kernel, it is the kernel's own predicate asked one step earlier.
  assert.throws(
    () =>
      runDispatch({
        archetype: 'reviewer',
        prompt: 'review it',
        repoRoot: root,
        env: null,
        userPathOptions: user,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DispatchCommandError);
      assert.match(err.message, /runs in-session/);
      return true;
    },
  );
});

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { LoadoutError, runLoadoutList, runLoadoutResolve, runLoadoutShow } from '../src/commands/loadout.ts';
import { SteeringError, runSteeringResolve } from '../src/commands/steering.ts';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import { ExecutorProfileError, LOADOUT_LOCAL_FILE, resolveActiveLoadout } from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * Resolution must not silently substitute a different executor than dispatch;
 * inspection must still surface a stale pin. All calls pass `env: null` and
 * isolated `userPathOptions` so a real user pin never leaks in.
 */

const STEERING_HOOK = join(import.meta.dirname, '..', 'templates', 'claude', 'hooks', 'dispatch-steering.mjs');

const PROJECT_EXECUTORS = {
  echo: { adapter: 'command', command: ['node', '-e', '0'], model: 'echo' },
};

const COMPLETE_DOC = {
  executors: PROJECT_EXECUTORS,
  loadouts: { main: { worker: 'echo' }, alt: { worker: 'echo' } },
  default_loadout: 'main',
};

const CANON_NOTE =
  'note: canon archetypes not declared by this catalog: <generator, worker> ' +
  '(self-contained profile suppresses builtin layering; declare them in .fadeno/executors.yaml to adopt)';

function isolatedUser(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
    },
  };
}

function seedProject(t: TestContext, doc: Record<string, unknown>): { root: string; paths: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return { root, paths: isolatedUser(root) };
}

function writeUserCatalog(paths: UserPathOptions, doc: Record<string, unknown> = {}): void {
  const resolved = userPaths(paths);
  mkdirSync(resolved.configDir, { recursive: true });
  writeFileSync(resolved.executorsFile, stringifyYaml(doc));
}

function writeUserPin(paths: UserPathOptions, name: string): void {
  const resolved = userPaths(paths);
  mkdirSync(resolved.stateDir, { recursive: true });
  writeFileSync(resolved.loadoutFile, `${name}\n`);
}

function writeLocalPin(root: string, name: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, LOADOUT_LOCAL_FILE), `${name}\n`);
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

function writeFakeFadeno(root: string, script: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'fadeno');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return bin;
}

function runSteeringHook(
  root: string,
  event: Record<string, unknown>,
  fadenoScript: string,
): { status: number | null; stdout: string; stderr: string } {
  const bin = writeFakeFadeno(root, fadenoScript);
  const result = spawnSync(process.execPath, [STEERING_HOOK], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('loadout resolve: a stale local pin throws the same message dispatch would', (t) => {
  const { root, paths } = seedProject(t, COMPLETE_DOC);
  writeLocalPin(root, 'removed-loadout');
  const layered = loadLayeredProfile(root, paths);
  const kernel = thrownMessage(() =>
    resolveActiveLoadout({ localFileValue: 'removed-loadout', profile: layered.profile }),
  );
  const resolveErr = thrownMessage(() =>
    runLoadoutResolve({ repoRoot: root, env: null, userPathOptions: paths, archetype: 'worker' }),
  );
  assert.match(kernel, /names loadout/);
  assert.equal(resolveErr, kernel);
  assert.ok(resolveErr.includes('removed-loadout'));
  assert.throws(
    () => runLoadoutResolve({ repoRoot: root, env: null, userPathOptions: paths, archetype: 'worker' }),
    (err: unknown) => err instanceof LoadoutError && err.message === kernel,
  );
});

test('loadout resolve: ignores a user pin when the project profile is complete', (t) => {
  const { root, paths } = seedProject(t, COMPLETE_DOC);
  writeUserCatalog(paths);
  writeUserPin(paths, 'alt');
  const resolved = runLoadoutResolve({
    repoRoot: root, env: null, userPathOptions: paths, archetype: 'worker',
  });
  // `alt` is declared on the project catalog: consulting the pin would
  // report source "user". A complete profile never composed that layer.
  assert.deepEqual(resolved.active, { name: 'main', source: 'default' });
});

test('loadout resolve: consults a user pin only when the user layer was composed', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const paths = isolatedUser(root);
  writeUserCatalog(paths);
  writeUserPin(paths, 'luna');

  const composed = runLoadoutResolve({
    repoRoot: root, env: null, userPathOptions: paths, archetype: 'worker',
  });
  assert.deepEqual(composed.active, { name: 'luna', source: 'user' });
  assert.ok(loadLayeredProfile(root, paths).layers.includes('user'));

  const noCatalog = tempRepo(t);
  mkdirSync(join(noCatalog, '.fadeno'), { recursive: true });
  const barePaths = isolatedUser(noCatalog);
  writeUserPin(barePaths, 'luna');
  const ignored = runLoadoutResolve({
    repoRoot: noCatalog, env: null, userPathOptions: barePaths, archetype: 'worker',
  });
  assert.deepEqual(ignored.active, { name: 'native', source: 'default' });
  assert.equal(loadLayeredProfile(noCatalog, barePaths).layers.includes('user'), false);
});

test('loadout show/list: a stale local pin is surfaced, not thrown', (t) => {
  const { root, paths } = seedProject(t, COMPLETE_DOC);
  writeLocalPin(root, 'removed-loadout');

  const shown = runLoadoutShow({ repoRoot: root, env: null, userPathOptions: paths });
  assert.equal(shown.stalePin, 'removed-loadout');
  assert.deepEqual(shown.active, { name: 'main', source: 'default' });

  const listed = runLoadoutList({ repoRoot: root, env: null, userPathOptions: paths });
  assert.equal(listed.stalePin, 'removed-loadout');
  assert.deepEqual(listed.active, { name: 'main', source: 'default' });
});

test('suppressedCanonArchetypes: computed only when a self-contained project suppresses layering', (t) => {
  const missingBoth = seedProject(t, COMPLETE_DOC);
  assert.deepEqual(loadLayeredProfile(missingBoth.root, missingBoth.paths).layers, ['project']);
  assert.deepEqual(
    loadLayeredProfile(missingBoth.root, missingBoth.paths).suppressedCanonArchetypes,
    ['generator', 'worker'],
  );

  const workerOnly = seedProject(t, { ...COMPLETE_DOC, archetypes: { worker: { requires_write: true } } });
  assert.deepEqual(
    loadLayeredProfile(workerOnly.root, workerOnly.paths).suppressedCanonArchetypes,
    ['generator'],
  );

  const completeCanon = seedProject(t, {
    ...COMPLETE_DOC,
    archetypes: { worker: { requires_write: true }, generator: { requires_write: false } },
  });
  assert.deepEqual(loadLayeredProfile(completeCanon.root, completeCanon.paths).suppressedCanonArchetypes, []);

  const layered = tempRepo(t);
  mkdirSync(join(layered, '.fadeno'), { recursive: true });
  const layeredPaths = isolatedUser(layered);
  writeUserCatalog(layeredPaths);
  assert.ok(loadLayeredProfile(layered, layeredPaths).layers.includes('builtin'));
  assert.deepEqual(loadLayeredProfile(layered, layeredPaths).suppressedCanonArchetypes, []);
});

test('loadout show/list: render the canon note on the effective view and the active entry', (t) => {
  const { root, paths } = seedProject(t, COMPLETE_DOC);
  const shown = runLoadoutShow({ repoRoot: root, env: null, userPathOptions: paths });
  assert.deepEqual(shown.suppressed_canon_archetypes, ['generator', 'worker']);
  assert.equal(shown.note, CANON_NOTE);

  const listed = runLoadoutList({ repoRoot: root, env: null, userPathOptions: paths });
  assert.deepEqual(listed.suppressed_canon_archetypes, ['generator', 'worker']);
  const active = listed.loadouts.find((entry) => entry.isActive);
  assert.equal(active?.note, CANON_NOTE);
  assert.equal(listed.loadouts.find((entry) => !entry.isActive)?.note, undefined);

  const layered = tempRepo(t);
  mkdirSync(join(layered, '.fadeno'), { recursive: true });
  const layeredPaths = isolatedUser(layered);
  const open = runLoadoutShow({ repoRoot: layered, env: null, userPathOptions: layeredPaths });
  assert.deepEqual(open.suppressed_canon_archetypes, []);
  assert.equal(open.note, null);
});

test('steering resolve: a stale local pin stays a hard error', (t) => {
  const { root, paths } = seedProject(t, COMPLETE_DOC);
  writeLocalPin(root, 'removed-loadout');
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, env: null, userPathOptions: paths, archetype: 'worker' }),
    (err: unknown) =>
      err instanceof SteeringError &&
      /names loadout "removed-loadout"/.test(err.message) &&
      !(err instanceof ExecutorProfileError),
  );
});

test('Claude steering hook: resolver error denies a spawn that would have been rewritten', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const event = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt: 'Implement it.', description: 'x', subagent_type: 'general-purpose' },
  };
  const result = runSteeringHook(
    root,
    event,
    '#!/bin/sh\nprintf \'%s\\n\' \'.fadeno/local/loadout names loadout "ghost"\' >&2\nexit 1\n',
  );
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /names loadout "ghost"/);
});

test('Claude steering hook: unreadable resolve stdout still fail-opens; native success is unchanged', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const event = {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { prompt: 'Review it.', description: 'x', subagent_type: 'reviewer' },
  };
  const unreadable = runSteeringHook(root, event, '#!/bin/sh\nprintf \'%s\\n\' \'not-json\'\nexit 0\n');
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.equal(unreadable.stdout, '');

  const native = runSteeringHook(
    root,
    event,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"adapter":"host","model":"opus"}\'\nexit 0\n',
  );
  assert.equal(native.status, 0, native.stderr);
  const decision = JSON.parse(native.stdout) as {
    hookSpecificOutput: { permissionDecision?: string; updatedInput: { subagent_type: string; model: string } };
  };
  assert.equal(decision.hookSpecificOutput.permissionDecision, undefined);
  // No local `.claude/agents/reviewer.md` in this fixture, so the plugin-scoped name.
  assert.equal(decision.hookSpecificOutput.updatedInput.subagent_type, 'fadeno:reviewer');
  assert.equal(decision.hookSpecificOutput.updatedInput.model, 'opus');
});

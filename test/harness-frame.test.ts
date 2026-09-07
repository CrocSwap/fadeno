import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDialResolve, runDialSet, runDialShow } from '../src/commands/dial.ts';
import { runModels } from '../src/commands/models.ts';
import { runStatus } from '../src/commands/status.ts';
import { activeHarness, withoutHarnessIdentity } from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * The bare-shell frame of reference.
 *
 * Fadeno has no host-harness frame of reference unless the call happens INSIDE
 * a harness, which is exactly two signals — `FADENO_HARNESS`, stamped by an
 * in-harness adapter, and the ambient markers a harness exports into its own
 * sessions. A plain shell is `standalone`, and every surface that reports or
 * compiles against a harness has to agree on that.
 *
 * These tests deliberately pass NO `FADENO_HARNESS`: most of the suite pins it
 * to `standalone` for isolation, which cannot tell "resolved to standalone"
 * apart from "was told standalone". This is the only file where the absence is
 * the subject.
 */

function bare(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_DATA_HOME: join(root, 'user-data'),
    },
  };
}

/** Write what an older `fadeno setup --codex` left in user state. */
function staleMemo(options: UserPathOptions, value = 'codex'): string {
  const dir = userPaths(options).stateDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'harness');
  writeFileSync(path, `${value}\n`, 'utf8');
  return path;
}

function bareRepo(t: TestContext): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  return { root, user: bare(root) };
}

test('a bare shell is standalone, and a stale memo on disk does not change that', (t) => {
  const { user } = bareRepo(t);
  assert.equal(activeHarness(undefined, user), 'standalone');
  staleMemo(user);
  assert.equal(activeHarness(undefined, user), 'standalone', 'a file is not a session');
});

test('nested hosts resolve to standalone rather than to a remembered one', (t) => {
  const { user } = bareRepo(t);
  staleMemo(user, 'claude');
  const nested: UserPathOptions = {
    ...user,
    env: { ...user.env, CLAUDECODE: '1', CODEX_THREAD_ID: 'thread-1' },
  };
  assert.equal(activeHarness(undefined, nested), 'standalone');
  // Saying which one is still available, and still wins.
  assert.equal(activeHarness(undefined, { ...nested, env: { ...nested.env, FADENO_HARNESS: 'codex' } }), 'codex');
});

test('an executor child sheds the host frame even when the parent had one', (t) => {
  const { user } = bareRepo(t);
  staleMemo(user, 'codex');
  const insideClaude = { ...user.env, CLAUDECODE: '1', FADENO_HARNESS: 'claude' };
  assert.equal(activeHarness(undefined, { ...user, env: insideClaude }), 'claude');
  // What `fadeno tool-run` sees inside a spawned executor: this is the env a
  // snapshot would be built under, and it must compile the standalone routes.
  const child: UserPathOptions = { ...user, env: withoutHarnessIdentity(insideClaude) };
  assert.equal(activeHarness(undefined, child), 'standalone');
});

test('models reports standalone with host_source fallback from a bare shell', (t) => {
  const { root, user } = bareRepo(t);
  const result = runModels({ repoRoot: root, userPathOptions: user });
  assert.equal(result.host, 'standalone');
  assert.equal(result.host_source, 'fallback');

  staleMemo(user);
  const withMemo = runModels({ repoRoot: root, userPathOptions: user });
  assert.equal(withMemo.host, 'standalone');
  assert.equal(withMemo.host_source, 'fallback', 'a leftover file is not a source');

  const inCodex = runModels({ repoRoot: root, userPathOptions: { ...user, env: { ...user.env, CODEX_THREAD_ID: 't' } } });
  assert.equal(inCodex.host, 'codex');
  assert.equal(inCodex.host_source, 'ambient');
});

test('status reports host standalone from a bare shell', (t) => {
  const { root, user } = bareRepo(t);
  staleMemo(user);
  assert.equal(runStatus({ repoRoot: root, userPathOptions: user }).harness, 'standalone');
});

test('a bare shell compiles exactly what an explicit standalone compiles', (t) => {
  const { root, user } = bareRepo(t);
  const explicit: UserPathOptions = { ...user, env: { ...user.env, FADENO_HARNESS: 'standalone' } };
  const before = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(before.host, 'standalone');
  assert.ok(before.rows.length > 0, 'the shipped catalog must produce rows');
  assert.deepEqual(before.rows, runDialShow({ repoRoot: root, userPathOptions: explicit }).rows);

  // The point of the whole change: a file cannot move the frame of reference.
  staleMemo(user);
  const after = runDialShow({ repoRoot: root, userPathOptions: user });
  assert.equal(after.host, 'standalone');
  assert.deepEqual(after.rows, before.rows);
});

test('dial resolve from a bare shell resolves standalone and stays memo-independent', (t) => {
  const { root, user } = bareRepo(t);
  // A dialed model is delivered by the standalone route table, on the command
  // lane — there is no session for a host lane to use.
  runDialSet({ repoRoot: root, userPathOptions: user, archetype: 'worker', model: 'grok' });
  const worker = runDialResolve({ repoRoot: root, userPathOptions: user, archetype: 'worker' });
  assert.equal(worker.host, 'standalone');
  assert.equal(worker.lane, 'command');
  assert.equal(worker.harness, 'grok');
  assert.ok(worker.command != null && worker.command.length > 0);

  staleMemo(user);
  for (const row of runDialShow({ repoRoot: root, userPathOptions: user }).rows) {
    const resolved = runDialResolve({ repoRoot: root, userPathOptions: user, archetype: row.archetype });
    assert.equal(resolved.host, 'standalone', `${row.archetype} must resolve against the standalone host`);
    // A bare shell can never resolve a HOST LANE: `current-host` names
    // whatever session is running, and there is none. The undialed archetype
    // is therefore off the host lane with nothing to invoke — a null command,
    // never a host lane it cannot take.
    if (resolved.model === 'current-host') assert.equal(resolved.command, null);
    assert.notEqual(resolved.lane, 'host', `${row.archetype} claims an in-session lane from a bare shell`);
  }
});

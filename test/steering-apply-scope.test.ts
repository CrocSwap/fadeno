import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runSteeringApply, runSteeringApplyClaude } from '../src/commands/steering.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { writeUserDials, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * A user-scope agent set steers EVERY repo on the machine, so it may only be
 * cut from a dial that already has that reach.
 *
 * This is a regression pin, not a style preference. `fadeno dial worker
 * sonnet` writes the SESSION layer whenever one already exists (an unscoped
 * set edits the highest existing dial), and `steering apply --codex --scope
 * user` used to resolve through that layer while writing the global file. Run
 * once from a repo dialed to a command-delivered model, it rewrote the global
 * worker agent as a command broker — whose only identity is the relay,
 * `luna@low`. Every other repo then resolved `mode: host` into that broker and
 * did worker work at the relay's effort, with nothing reporting a conflict:
 * each repo's own resolution was correct, but the agent it resolved INTO had
 * been cut from a different repo's dial.
 */

function isolatedUser(t: TestContext, root: string): UserPathOptions {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

/**
 * The exact shape that bit: `luna` is host-delivered under the codex harness,
 * `grok` is command-delivered. A user dial of `luna` must produce a HOST
 * agent even when the repo's session dial says `grok`.
 */
function seedConflictingLayers(root: string, user: UserPathOptions): void {
  writeLocalDialState(root, { dials: { worker: { model: 'grok' } }, shadows: {} } as never);
  writeUserDials(user, { worker: { model: 'luna' } });
}

test('a user-scope Codex apply is cut from user dials, never the repo session dial', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  seedConflictingLayers(root, user);

  const applied = runSteeringApply({ repoRoot: root, target: 'codex', scope: 'user', userPathOptions: user, force: true });

  assert.equal(applied.materialization.worker?.executor, 'luna', 'the user dial decides a user-scope agent');
  assert.equal(applied.materialization.worker?.kind, 'host', 'luna is host-delivered under codex; the session grok dial must not reach here');

  const body = readFileSync(join(user.home!, '.codex', 'agents', 'fadeno-worker.toml'), 'utf8');
  assert.match(body, /gpt-5\.6-luna/);
  assert.match(body, /model_reasoning_effort = "xhigh"/, 'a host agent bakes the dialed identity, not the relay effort');
  assert.doesNotMatch(body, /command broker/, 'the session dial must not turn the global worker agent into a relay-identity broker');
});

test('the ignored repo-local dial is reported, not silently dropped', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  seedConflictingLayers(root, user);

  const applied = runSteeringApply({ repoRoot: root, target: 'codex', scope: 'user', userPathOptions: user, force: true });
  assert.deepEqual(applied.ignoredLocalDials, ['worker']);
});

test('a project-scope apply still honors the repo session dial', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  seedConflictingLayers(root, user);

  const applied = runSteeringApply({ repoRoot: root, target: 'codex', scope: 'project', userPathOptions: user, force: true });
  assert.equal(applied.materialization.worker?.executor, 'grok', 'a repo-scoped file may carry a repo-scoped dial');
  assert.deepEqual(applied.ignoredLocalDials, [], 'nothing is ignored when the surface and the dial share a reach');
});

test('the Claude apply obeys the same scope rule', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  seedConflictingLayers(root, user);

  const applied = runSteeringApplyClaude({ repoRoot: root, target: 'claude', scope: 'user', userPathOptions: user });
  assert.equal(applied.materialization.worker?.executor, 'luna', 'codex and claude must not drift on where a global agent comes from');
  assert.deepEqual(applied.ignoredLocalDials, ['worker']);
});

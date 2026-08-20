import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { decideLane, runSteeringResolve } from '../src/commands/steering.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// --- Effort decides the lane ---
//
// A host spawn runs at the SESSION's effort. An effort the session cannot give
// is delivered on the command lane instead. The predicate keys on whether the
// user PINNED an effort (`ref.effort`), never on the effort the delivery
// happens to resolve to.
//
// Every model below declares an `effort:`, exactly as every model in the
// shipped catalog does — that is what makes the trap real rather than
// theoretical, and what makes `test('… never on the effective effort …')`
// below fail the moment someone "simplifies" the predicate.

const RELAY = ['node', '-e', "process.stdout.write('fallback')"];

function seed(t: TestContext, dials: Record<string, string>): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      // Host-deliverable AND command-routable: it has both lanes to choose from.
      luna: { provider: 'lunap', id: 'gpt-5.6-luna', effort: 'xhigh' },
      // Host-deliverable with NO command lane: the restart_required case.
      terra: { provider: 'terrap', id: 'gpt-5.6-terra', effort: 'high' },
      // Command-only.
      opus: { provider: 'opusp', id: 'opus', effort: 'high' },
    },
    routes: {
      codex: {
        'current-host': { host: true },
        lunap: { host: true, command: RELAY },
        terrap: { host: true },
        opusp: { command: ['claude', '-p', '--model', '{model}'] },
      },
    },
    archetypes: { worker: {}, reviewer: {}, judge: {} },
    dials,
  }));
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'codex',
    },
  };
  return { root, user };
}

/**
 * Resolve with an EXPLICIT session effort. `env` is injected on every call in
 * this file — never omitted — so no assertion here depends on the effort the
 * developer's own session happens to be running at.
 */
function resolve(
  root: string,
  user: UserPathOptions,
  hostExecutor: string,
  sessionEffort: string | null,
): ReturnType<typeof runSteeringResolve> {
  return runSteeringResolve({
    repoRoot: root,
    userPathOptions: user,
    archetype: 'worker',
    hostExecutor,
    env: sessionEffort == null ? {} : { CLAUDE_EFFORT: sessionEffort },
  });
}

test('an unpinned dial stays in-session even when the session is nowhere near the model\'s registry effort — never on the effective effort', (t) => {
  // THE TRAP, made executable. `luna` declares `effort: xhigh` in the
  // registry, so `effectiveEffort` is 'xhigh' while the session runs 'medium'.
  // A predicate that compared THOSE two would ship this casual `dial worker
  // luna` out of process — the exact inversion this design exists to avoid.
  // Only `pinnedEffort` (here: absent) may move a delivery off the host lane.
  const { root, user } = seed(t, { worker: 'luna' });
  const result = resolve(root, user, 'luna', 'medium');

  assert.equal(result.mode, 'host');
  assert.equal(result.lane, 'host');
  assert.equal(result.lane_reason, 'effort unpinned');
  assert.equal(result.effort_pinned, false);
  // The registry default is still REPORTED — it is the command-lane default,
  // and the value this delivery runs at if it ever reaches that lane.
  assert.equal(result.effective_effort, 'xhigh');
  assert.equal(result.session_effort, 'medium');
});

test('a pinned effort the session already runs at stays in-session', (t) => {
  const { root, user } = seed(t, { worker: 'luna@medium' });
  const result = resolve(root, user, 'luna@medium', 'medium');

  assert.equal(result.mode, 'host');
  assert.equal(result.lane, 'host');
  assert.equal(result.effort_pinned, true);
  assert.equal(result.effective_effort, 'medium'); // the pin beats the registry's xhigh
  assert.equal(result.lane_reason, 'session effort matches the pin');
});

test('a pinned effort the session cannot give takes the command lane, at the pinned effort', (t) => {
  const { root, user } = seed(t, { worker: 'luna@xhigh' });
  const result = resolve(root, user, 'luna@xhigh', 'medium');

  assert.equal(result.mode, 'command');
  assert.equal(result.lane, 'command');
  assert.equal(result.lane_reason, 'session effort is medium, dial pins xhigh');
  assert.equal(result.effort_pinned, true);
  assert.equal(result.effective_effort, 'xhigh');
  assert.equal(result.session_effort, 'medium');
  // The model half of the predicate still matched — the detail says which
  // half actually decided, because "differs from this session's baseline"
  // would send the reader looking for a model change that never happened.
  assert.match(result.detail, /matches this session's host baseline, but session effort is medium, dial pins xhigh/);
});

test('CONTRACT: a pinned mismatch with no command fallback is restart_required and never command', (t) => {
  // `terra` declares no command for its route, so there is nowhere to go.
  // This is the guarantee a consumer routes on without re-checking: emitting
  // `command` here would hand the spawn to the dispatch proxy, which would run
  // `fadeno dispatch` for a delivery the kernel has nothing to invoke and die
  // on `host_in_session` — the failure `shadow.routable` exists to prevent.
  // It is also restart reason 2, which survives the grid's retirement.
  const { root, user } = seed(t, { worker: 'terra@xhigh' });
  const refused: Array<[string, string | null]> = [
    ['terra@xhigh', 'medium'], // the session contradicts the pin
    ['terra', null], // a different ref, and nothing observes an effort either
    ['terra', 'medium'], // a different ref
  ];
  for (const [hostExecutor, sessionEffort] of refused) {
    const result = resolve(root, user, hostExecutor, sessionEffort);
    const where = `${hostExecutor} @ session ${sessionEffort}`;
    assert.notEqual(result.lane, 'command', where);
    assert.equal(result.lane, 'restart_required', where);
    assert.equal(result.mode, 'restart_required', where);
    assert.equal(result.lane_reason, 'no command fallback', where);
  }
  assert.match(resolve(root, user, 'terra@xhigh', 'medium').detail, /pins effort xhigh but this session runs at medium/);
});

test('an unobserved session effort takes the command lane: a pin the host cannot PROVE is not honored optimistically', (t) => {
  // The harness stopped publishing CLAUDE_EFFORT, or this is not Claude at
  // all. The whole point of the rule is that a pinned effort is deterministic,
  // so an unprovable host lane loses to a command lane that encodes the effort
  // in its argv. `--host-executor luna` names a DIFFERENT ref than the dial's
  // `luna@xhigh`, so nothing here proves the pin either.
  const { root, user } = seed(t, { worker: 'luna@xhigh' });
  const result = resolve(root, user, 'luna', null);

  assert.equal(result.mode, 'command');
  assert.equal(result.lane, 'command');
  assert.equal(result.session_effort, null);
  assert.equal(result.effective_effort, 'xhigh');
});

test('an unobserved session effort still leaves an UNPINNED dial in-session', (t) => {
  // Nothing to compare, so nothing to prove: the casual path must not pay for
  // a harness that publishes no effort.
  const { root, user } = seed(t, { worker: 'luna' });
  const result = resolve(root, user, 'luna', null);

  assert.equal(result.mode, 'host');
  assert.equal(result.lane, 'host');
  assert.equal(result.lane_reason, 'effort unpinned');
  assert.equal(result.session_effort, null);
});

test('a host agent materialized from the pinned ref proves its own effort without the harness publishing one', (t) => {
  // Codex bakes effort into the agent TOML (`model_reasoning_effort`) and the
  // agent identifies itself with the full ref it was cut from. A match on
  // `luna@xhigh` therefore proves the effort as directly as CLAUDE_EFFORT
  // does — otherwise every pinned dial in a Codex session would dispatch out
  // of process from the very agent materialized for it.
  const { root, user } = seed(t, { worker: 'luna@xhigh' });
  const result = resolve(root, user, 'luna@xhigh', null);

  assert.equal(result.mode, 'host');
  assert.equal(result.lane, 'host');
  assert.equal(result.lane_reason, 'host agent pins the same effort');

  // An OBSERVED session effort is the stronger evidence — it is already past
  // any silent downgrade — and overrules the agent file when they disagree.
  assert.equal(resolve(root, user, 'luna@xhigh', 'medium').lane, 'command');
});

test('the model half of the predicate still decides first, and says so', (t) => {
  // Model AND effort both disagree. The model is the older, coarser reason
  // and the one the user must fix first, so it is the one named.
  const { root, user } = seed(t, { worker: 'luna@xhigh' });
  const result = resolve(root, user, 'terra', 'medium');

  assert.equal(result.mode, 'command');
  assert.equal(result.lane, 'command');
  assert.equal(result.lane_reason, 'model not deliverable in-host');
  assert.match(result.detail, /differs from this session's host baseline terra/);
});

test('a command-adapter dial reports the command lane without consulting the session at all', (t) => {
  const { root, user } = seed(t, { worker: 'opus' });
  const result = resolve(root, user, 'luna', 'medium');

  assert.equal(result.mode, 'command');
  assert.equal(result.lane, 'command');
  assert.equal(result.adapter, 'command');
  assert.equal(result.effort_pinned, false);
  assert.equal(result.effective_effort, 'high');
});

test('the legacy `effort` field keeps meaning the effective value, on every lane', (t) => {
  // Old readers parse `effort`. It was the effective value before the lane
  // predicate existed and it stays the effective value now; `effort_pinned`
  // is the new field that says whether anyone asked for it.
  const { root, user } = seed(t, { worker: 'luna' });
  const host = resolve(root, user, 'luna', 'medium');
  assert.equal(host.effort, host.effective_effort);

  const { root: root2, user: user2 } = seed(t, { worker: 'luna@xhigh' });
  const command = resolve(root2, user2, 'luna@xhigh', 'medium');
  assert.equal(command.effort, 'xhigh');
  assert.equal(command.effort, command.effective_effort);
});

test('the session effort is injectable, so nothing here reads the developer\'s real session', (t) => {
  // Same repo, same dial, same call — only the injected environment differs,
  // and the lane flips. That is both the liveness the design wants and the
  // proof that the value is not coming from ambient process state.
  const previous = process.env.CLAUDE_EFFORT;
  process.env.CLAUDE_EFFORT = 'this-would-break-every-assertion';
  t.after(() => {
    if (previous == null) delete process.env.CLAUDE_EFFORT;
    else process.env.CLAUDE_EFFORT = previous;
  });

  const { root, user } = seed(t, { worker: 'luna@xhigh' });
  assert.equal(resolve(root, user, 'luna@xhigh', 'xhigh').lane, 'host');
  assert.equal(resolve(root, user, 'luna@xhigh', 'medium').lane, 'command');
});

test('decideLane: the three states, and the one comparison that must never happen', () => {
  const registryDefault = { effectiveEffort: 'xhigh', sessionEffort: 'medium', hostModel: true, commandLane: true };

  // No opinion stated: the common path, and it is cheap.
  assert.equal(decideLane({ ...registryDefault, pinnedEffort: null }).lane, 'host');
  // The same call with the pin the registry default would have supplied. If
  // the predicate ever reads `effectiveEffort`, these two become identical
  // and the assertion above breaks.
  assert.equal(decideLane({ ...registryDefault, pinnedEffort: 'xhigh' }).lane, 'command');

  assert.equal(decideLane({ ...registryDefault, pinnedEffort: 'medium' }).lane, 'host');
  assert.equal(decideLane({ ...registryDefault, pinnedEffort: 'xhigh', commandLane: false }).lane, 'restart_required');
  assert.equal(decideLane({ ...registryDefault, pinnedEffort: null, hostModel: false }).lane, 'command');
  assert.equal(
    decideLane({ ...registryDefault, pinnedEffort: null, hostModel: false, commandLane: false }).lane,
    'restart_required',
  );

  // Unobserved session effort: proof, or the command lane.
  const unobserved = { ...registryDefault, sessionEffort: null, pinnedEffort: 'xhigh' };
  assert.equal(decideLane(unobserved).lane, 'command');
  assert.equal(decideLane({ ...unobserved, hostEffortProven: true }).lane, 'host');
  // Proof of a pin nobody made is meaningless and must not resurrect a lane.
  assert.equal(decideLane({ ...unobserved, pinnedEffort: null, hostEffortProven: true }).lane, 'host');
});

test('CONTRACT: decideLane never answers "command" without a command lane, on any input', () => {
  // Exhaustive over the whole input space that matters. A consumer routes to
  // the dispatch proxy on this value alone; there is no re-check downstream.
  for (const pinnedEffort of [null, 'xhigh', 'medium']) {
    for (const sessionEffort of [null, 'medium', 'xhigh']) {
      for (const hostModel of [true, false]) {
        for (const hostEffortProven of [true, false]) {
          const decision = decideLane({
            pinnedEffort, sessionEffort, hostModel, hostEffortProven,
            effectiveEffort: 'xhigh', commandLane: false,
          });
          assert.notEqual(decision.lane, 'command', JSON.stringify({ pinnedEffort, sessionEffort, hostModel, hostEffortProven }));
          if (decision.lane !== 'host') assert.equal(decision.lane_reason, 'no command fallback');
        }
      }
    }
  }
});

test('lane_reason stays a spliceable fragment across the closed vocabulary', () => {
  // It is interpolated into a user-facing message and written verbatim into
  // evidence, so: lowercase, trimmed, no trailing period, and drawn from the
  // exported union rather than composed on the fly.
  const seen = new Set<string>();
  for (const pinnedEffort of [null, 'xhigh', 'medium']) {
    for (const sessionEffort of [null, 'medium', 'xhigh']) {
      for (const hostModel of [true, false]) {
        for (const commandLane of [true, false]) {
          for (const hostEffortProven of [true, false]) {
            const { lane_reason } = decideLane({
              pinnedEffort, sessionEffort, hostModel, commandLane, hostEffortProven,
              effectiveEffort: 'xhigh',
            });
            seen.add(lane_reason);
            assert.doesNotMatch(lane_reason, /\.$/, lane_reason);
            assert.equal(lane_reason, lane_reason.trim());
            assert.notEqual(lane_reason[0], lane_reason[0]!.toUpperCase());
          }
        }
      }
    }
  }
  // Small and closed: one parameterized member (the two efforts being
  // compared) plus the fixed ones this predicate can reach.
  assert.deepEqual([...seen].sort(), [
    'effort unpinned',
    'host agent pins the same effort',
    'model not deliverable in-host',
    'no command fallback',
    'session effort is medium, dial pins xhigh',
    'session effort is xhigh, dial pins medium',
    'session effort matches the pin',
    'session effort unobserved',
  ]);
});

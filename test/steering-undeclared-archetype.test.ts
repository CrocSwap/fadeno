import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runSteeringResolve } from '../src/commands/steering.ts';
import { knownArchetypes, loadExecutorProfile } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

const FALLBACK_COMMAND = ['node', '-e', "process.stdout.write('fallback')"];

/**
 * A catalog shaped like the SHIPPED one rather than like a test fixture: the
 * `archetypes:` map carries only archetypes with something non-default to say.
 * `reviewer` is silent here for the same reason it is silent in
 * `templates/common/fadeno/executors.yaml` — its posture is entirely default.
 *
 * Every other locked-steering fixture in this suite writes
 * `archetypes: { worker: {}, reviewer: {}, judge: {} }`, enumerating the roster
 * the way a test author would. That is what let the resolver read the policy
 * overlay as a registry undetected: in the fixtures the entry always existed.
 */
function seedProductionShapedProfile(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const routes = {
    lunap: { host: true, command: FALLBACK_COMMAND },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { luna: { provider: 'lunap', id: 'gpt-5.6-luna', effort: 'xhigh' } },
    routes: { standalone: routes, codex: routes, claude: routes, grok: routes },
    archetypes: { worker: {} },
    dials: { worker: 'luna', reviewer: 'luna' },
  }));
}

function seedLockedReviewerRequest(root: string): { runId: string; dispatchId: string } {
  runInit({ target: 'codex', repoRoot: root, dataOnly: true, noSteering: true });
  seedProductionShapedProfile(root);
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'locked.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'locked',
    description: 'Locked reviewer against a catalog that declares no reviewer policy.',
    roles: { checker: { purpose: 'Review.', archetype: 'reviewer' } },
    inputs: { Task: { media_type: 'text/markdown' } },
    flow: [{ id: 'review', kind: 'actor_call', actor: 'checker', input: ['Task'], output: 'Notes', terminal_status: 'completed' }],
  }));
  writeFileSync(join(root, 'task.md'), 'review this');
  const created = runNewRun({ repoRoot: root, playbook: 'locked', task: 'undeclared archetype', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: created.runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  assert.equal(request.agentType, 'reviewer');
  return { runId: created.runId, dispatchId: request.dispatchId };
}

test('a locked reviewer resolves natively even though the catalog declares no reviewer policy', (t) => {
  const root = tempRepo(t);
  const { runId, dispatchId } = seedLockedReviewerRequest(root);

  // The exact call the managed Codex reviewer agent makes. Before the fix this
  // threw "cannot specialize wildcard identity to undeclared archetype", and a
  // reviewer that correctly consulted steering was pushed onto the command
  // lane with `host_attested: false` (2026-08-21, polymarket-quoter).
  const resolved = runSteeringResolve({
    repoRoot: root,
    archetype: 'reviewer',
    hostExecutor: 'luna',
    run: runId,
    dispatchId,
  });
  assert.equal(resolved.mode, 'host');
  assert.equal(resolved.source, 'host-request');

  // Again through the BUNDLED CJS, which is what a managed Codex agent
  // actually executes (`~/.local/share/fadeno/runtime/fadeno`). The in-process
  // ESM path proves the logic; only this proves the artifact. `host-dispatch`
  // already drives locked steering through the bundle, but solely for a
  // DECLARED archetype — the reviewer path was unproven here.
  const bundled = spawnSync(
    join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno'),
    ['steering', 'resolve', '--archetype', 'reviewer', '--host-executor', 'luna', '--run', runId, '--dispatch-id', dispatchId],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(bundled.status, 0, bundled.stderr);
  const parsed = JSON.parse(bundled.stdout) as Record<string, unknown>;
  assert.equal(parsed.mode, 'host');
  assert.equal(parsed.requested_agent_type, 'reviewer');
  // Null, and that is the point: `delivered_archetype` records what a WILDCARD
  // was specialized to. A concrete request is not a specialization at all,
  // which is why the guard above it has no business running here.
  assert.equal(parsed.delivered_archetype, null);
});

test('a concrete agent_type is still matched exactly, and an unknown wildcard specialization is still refused', (t) => {
  const root = tempRepo(t);
  const { runId, dispatchId } = seedLockedReviewerRequest(root);

  // The equality check settles a concrete request; relaxing the overlay lookup
  // must not let a different archetype claim it.
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, archetype: 'worker', hostExecutor: 'luna', run: runId, dispatchId }),
    /requests agent_type "reviewer", not archetype "worker"/,
  );
  // And a name no layer knows is still not a valid specialization target.
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, archetype: 'nonesuch', hostExecutor: 'luna', run: runId, dispatchId }),
    /agent_type "reviewer", not archetype "nonesuch"/,
  );
});

test('the builtin catalog declares no reviewer or judge policy, and knownArchetypes still knows them', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true, noSteering: true });
  const profile = loadExecutorProfile(root, undefined, 'codex').profile;

  // The tripwire. If a future catalog gives `reviewer` or `judge` a declared
  // policy, this fails loudly rather than silently making the regression
  // untestable — the whole bug was that the shipped catalog and every fixture
  // disagreed about whether these keys exist.
  assert.ok(!Object.hasOwn(profile.archetypes, 'reviewer'), 'reviewer gained a declared policy: retarget this test at an archetype that still has none');
  assert.ok(!Object.hasOwn(profile.archetypes, 'judge'), 'judge gained a declared policy: retarget this test at an archetype that still has none');

  const known = knownArchetypes(profile.archetypes);
  for (const name of ['worker', 'reviewer', 'judge']) assert.ok(known.has(name), `${name} must be a known archetype`);
  assert.ok(!known.has('nonesuch'));
});

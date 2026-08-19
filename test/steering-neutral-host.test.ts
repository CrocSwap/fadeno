import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runDrive } from '../src/commands/drive.ts';
import { isReferenceFrameNeutralHostRequest, NEUTRAL_HOST_EXECUTOR, runSteeringResolve } from '../src/commands/steering.ts';
import { requestHostDispatch } from '../src/lib/host-dispatch.ts';
import { tempRepo } from './helpers.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const BUNDLED_CLI = join(REPO_ROOT, 'plugin', 'bin', 'fadeno');

function seedHybridProfileV3ForStrict(_root: string): void {
  // placeholder retained for line count; not used
}

// Helper to create code-change-review coordinator run (current-host wildcard)
function coordinatorRun(t: import('node:test').TestContext) {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true });
  const created = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'plan a safe change' });
  const driven = runDrive({ repoRoot: root, run: created.runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  assert.equal(request.executor, 'current-host');
  assert.equal(request.agentType, '*');
  return { root, runId: created.runId, runDir: created.runDir, request };
}

test('predicate is true only for current-host wildcard host request', () => {
  assert.equal(NEUTRAL_HOST_EXECUTOR, 'current-host');
  const baseRequest = { executor: 'current-host', agentType: '*' } as any;
  const hostSpec = { adapter: 'host', agentType: '*', model: 'current-host' } as any;
  assert.equal(isReferenceFrameNeutralHostRequest(baseRequest, hostSpec), true);
  // each of the five conditions flipped -> false
  assert.equal(isReferenceFrameNeutralHostRequest({ executor: 'luna', agentType: '*' } as any, hostSpec), false);
  assert.equal(isReferenceFrameNeutralHostRequest({ executor: 'current-host', agentType: 'worker' } as any, hostSpec), false);
  assert.equal(isReferenceFrameNeutralHostRequest(baseRequest, { adapter: 'command', agentType: '*', model: 'current-host' } as any), false);
  assert.equal(isReferenceFrameNeutralHostRequest(baseRequest, { adapter: 'host', agentType: 'worker', model: 'current-host' } as any), false);
  assert.equal(isReferenceFrameNeutralHostRequest(baseRequest, { adapter: 'host', agentType: '*', model: 'opus' } as any), false);
});

test('neutral current-host locked steering resolves host without --host-executor', (t) => {
  const { root, runId, request } = coordinatorRun(t);
  const resolution = runSteeringResolve({
    repoRoot: root,
    archetype: 'director',
    run: runId,
    dispatchId: request.dispatchId,
  });
  assert.equal(resolution.mode, 'host');
  assert.equal(resolution.executor, 'current-host');
  assert.equal(resolution.adapter, 'host');
  assert.equal(resolution.requested_agent_type, '*');
  assert.equal(resolution.delivered_archetype, 'director');
  assert.equal(resolution.identity_evidence, 'requested_only');
  assert.equal(resolution.source, 'host-request');
  assert.match(resolution.detail, /reference-frame-neutral executor current-host; execute in-host/);
  assert.equal(resolution.detail, `host request ${request.dispatchId} is locked to the reference-frame-neutral executor current-host; execute in-host`);
});

test('neutral current-host bundled CLI resolves host without --host-executor', (t) => {
  const { root, runId, request } = coordinatorRun(t);
  const result = spawnSync(BUNDLED_CLI, ['steering', 'resolve', '--archetype', 'director', '--run', runId, '--dispatch-id', request.dispatchId], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `bundled CLI failed: ${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.mode, 'host');
  assert.equal(payload.executor, 'current-host');
  assert.equal(payload.adapter, 'host');
  assert.equal(payload.requested_agent_type, '*');
  assert.equal(payload.delivered_archetype, 'director');
  assert.equal(payload.identity_evidence, 'requested_only');
  assert.equal(payload.detail, `host request ${request.dispatchId} is locked to the reference-frame-neutral executor current-host; execute in-host`);
});

// Strictness: concrete host executor without fallback still requires restart
test('concrete host executor without fallback still restart_required without matching hostExecutor', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // Overwrite executors.yaml to define luna host-only
  // Use v3 models/routes with dummy provider for luna
  const yaml = stringifyYaml({
    schema_version: 3,
    models: {
      luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' },
    },
    routes: {
      standalone: { dummy: { host: true }, 'current-host': { host: true } },
      codex: { dummy: { host: true }, 'current-host': { host: true } },
      claude: { dummy: { host: true }, 'current-host': { host: true } },
      grok: { dummy: { host: true }, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    bindings: { agent_1: 'luna' },
  });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), yaml);
  // Need a playbook that maps agent_1
  const playbook = `kind: AgentPlaybook
schema_version: "0.1"
name: strict-concrete
description: strict fixture
roles:
  agent_1: { purpose: worker }
inputs:
  Task: { media_type: text/markdown }
flow:
  - id: implement
    kind: actor_call
    actor: agent_1
    input: [Task]
    output: Notes
    terminal_status: completed
`;
  writeFileSync(join(root, '.fadeno', 'playbooks', 'strict-concrete.yaml'), playbook);
  writeFileSync(join(root, 'task.md'), 'do work');
  const created = runNewRun({ repoRoot: root, playbook: 'strict-concrete', task: 'test strict concrete', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: created.runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const req = driven.requests[0]!;
  assert.equal(req.executor, 'luna');
  // No hostExecutor matching, no fallback -> restart_required
  const resolution = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    role: 'agent_1',
    run: created.runId,
    dispatchId: req.dispatchId,
  });
  assert.equal(resolution.mode, 'restart_required');
  assert.match(resolution.detail, /requires host executor luna/);
  // With matching hostExecutor, should be host
  const withHost = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    role: 'agent_1',
    hostExecutor: 'luna',
    run: created.runId,
    dispatchId: req.dispatchId,
  });
  assert.equal(withHost.mode, 'host');

  // Also verify predicate false for this request's spec
  // Load snapshot spec for luna is host with agentType *, model gpt-5.6-luna
  // Predicate requires executor current-host, so false
  assert.equal(isReferenceFrameNeutralHostRequest(req as any, { adapter: 'host', agentType: '*', model: 'gpt-5.6-luna' } as any), false);

  // Bundled CLI also reports restart_required (exit 2)
  const cli = spawnSync(BUNDLED_CLI, ['steering', 'resolve', '--archetype', 'worker', '--role', 'agent_1', '--run', created.runId, '--dispatch-id', req.dispatchId], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 2);
  const payload = JSON.parse(cli.stdout) as Record<string, unknown>;
  assert.equal(payload.mode, 'restart_required');
});

// Strictness: concrete agent_type with current-host executor is NOT neutral
test('concrete agent_type with current-host executor retains surface requirement', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true });
  const created = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'concrete agent type strictness' });
  const driven = runDrive({ repoRoot: root, run: created.runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const baseReq = driven.requests[0]!;
  // Forge a second host request with same executor current-host but concrete agent_type 'worker'
  const dispatchId = 'hd-concrete-agent-type';
  const newRequest = requestHostDispatch({
    repoRoot: root,
    run: created.runId,
    dispatchId,
    step: 'custom',
    actor: 'worker',
    stepExecutionId: 'se-custom-g1',
    actorCallId: 'ac-custom-g1-worker',
    attempt: 1,
    attemptReason: 'initial',
    executor: 'current-host',
    model: 'current-host',
    reasoningEffort: 'default',
    agentType: 'worker',
    promptPath: baseReq.promptPath,
    promptSha256: baseReq.promptSha256,
    outputPath: baseReq.outputPath,
    artifactType: null,
  });
  assert.equal(newRequest.agentType, 'worker');
  assert.equal(newRequest.executor, 'current-host');

  // Without hostExecutor, concrete agentType should NOT be neutral => restart_required (no fallback for current-host)
  const resolution = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    role: 'worker',
    run: created.runId,
    dispatchId,
  });
  assert.equal(resolution.mode, 'restart_required');
  assert.equal(resolution.executor, 'current-host');
  // detail should be the generic restart string, not neutral
  assert.doesNotMatch(resolution.detail, /reference-frame-neutral/);
  assert.match(resolution.detail, /requires host executor current-host/);

  // Predicate should be false for this request+spec
  assert.equal(
    isReferenceFrameNeutralHostRequest(newRequest as any, { adapter: 'host', agentType: '*', model: 'current-host' } as any),
    false,
  );

  // With matching hostExecutor current-host, it should be host (since matchesHost true, even though not neutral)
  const withHost = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    role: 'worker',
    hostExecutor: 'current-host',
    run: created.runId,
    dispatchId,
  });
  assert.equal(withHost.mode, 'host');
});

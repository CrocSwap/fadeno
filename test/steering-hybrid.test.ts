import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runNext } from '../src/commands/next.ts';
import { runDispatchStart } from '../src/commands/dispatch.ts';
import { runSteeringApply, runSteeringResolve } from '../src/commands/steering.ts';
import { runPrompt } from '../src/commands/prompt.ts';
import { runToolComplete } from '../src/commands/tool-complete.ts';
import { read, tempRepo } from './helpers.ts';

function seedHybridProfile(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      luna: { adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker' },
      terra: { adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer' },
      sol: { adapter: 'host', model: 'gpt-5.6-sol', reasoning_effort: 'medium', agent_type: 'judge' },
      opus: { adapter: 'command', command: ['claude', '-p', '--model', 'opus'], model: 'opus' },
      other: { adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'worker' },
    },
    loadouts: {
      native: { worker: 'luna', reviewer: 'terra', judge: 'sol' },
      mixed: { worker: 'luna', reviewer: 'opus', judge: 'sol' },
      'all-command': { worker: 'opus', reviewer: 'opus', judge: 'opus' },
      mismatch: { worker: 'other', reviewer: 'terra', judge: 'sol' },
      missing: { worker: 'luna', reviewer: 'terra' },
      'bad-type': { worker: 'luna', reviewer: 'other', judge: 'sol' },
    },
  }));
}

test('hybrid steering resolves matching host locally, command slots live, and mismatches loudly', (t) => {
  const root = tempRepo(t);
  seedHybridProfile(root);

  const local = runSteeringResolve({ repoRoot: root, archetype: 'worker', nativeExecutor: 'luna', loadout: 'mixed', env: null });
  assert.equal(local.mode, 'native');
  assert.equal(local.executor, 'luna');

  const brokerHost = runSteeringResolve({ repoRoot: root, archetype: 'worker', loadout: 'native', env: null });
  assert.equal(brokerHost.mode, 'restart_required');
  assert.match(brokerHost.detail, /no native executor/);

  const command = runSteeringResolve({ repoRoot: root, archetype: 'reviewer', nativeExecutor: 'terra', loadout: 'mixed', env: null });
  assert.equal(command.mode, 'command');
  assert.equal(command.executor, 'opus');

  const restart = runSteeringResolve({ repoRoot: root, archetype: 'worker', nativeExecutor: 'luna', loadout: 'mismatch', env: null });
  assert.equal(restart.mode, 'restart_required');
  assert.match(restart.detail, /fresh Codex session/);
});

test('engine host steering is locked to the run request, not ambient loadouts', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true });
  seedHybridProfile(root);
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'locked.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'locked',
    description: 'Locked steering fixture.',
    roles: { worker: { purpose: 'Implement.', archetype: 'worker' } },
    inputs: { Task: { media_type: 'text/markdown' } },
    flow: [{ id: 'implement', kind: 'actor_call', actor: 'worker', input: ['Task'], output: 'Notes', terminal_status: 'completed' }],
  }));
  writeFileSync(join(root, 'task.md'), 'locked task');
  const created = runNewRun({ repoRoot: root, playbook: 'locked', task: 'test locked steering', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: created.runId, loadout: 'native' });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;

  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'loadout'), 'mismatch\n');
  const locked = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    role: 'worker',
    nativeExecutor: 'luna',
    loadout: 'mismatch',
    env: 'mismatch',
    run: created.runId,
    dispatchId: request.dispatchId,
  });
  assert.equal(locked.mode, 'native');
  assert.equal(locked.executor, 'luna');
  assert.equal(locked.source, 'host-request');

  const restart = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    nativeExecutor: 'other',
    run: created.runId,
    dispatchId: request.dispatchId,
  });
  assert.equal(restart.mode, 'restart_required');
  assert.match(restart.detail, /native executor luna/);
  const broker = runSteeringResolve({ repoRoot: root, archetype: 'worker', run: created.runId, dispatchId: request.dispatchId });
  assert.equal(broker.mode, 'restart_required');
  assert.match(broker.detail, /native executor luna/);
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, archetype: 'reviewer', run: created.runId, dispatchId: request.dispatchId }),
    /agent_type "worker"/,
  );
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, archetype: 'worker', run: created.runId }),
    /both --run and --dispatch-id/,
  );

  const ordinary = runPrompt({ repoRoot: root, run: created.runId, step: 'implement', actor: 'worker', record: false });
  assert.match(ordinary.prompt, /^# Fadeno step assignment\n/);
  assert.doesNotMatch(ordinary.prompt, /^# Fadeno engine step assignment/);

  const eventsPath = join(created.runDir, 'events.jsonl');
  const withoutDigest = readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'profile_snapshotted') delete event.sha256;
    return JSON.stringify(event);
  }).join('\n');
  writeFileSync(eventsPath, `${withoutDigest}\n`);
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, archetype: 'worker', run: created.runId, dispatchId: request.dispatchId }),
    /sha256 digest/,
  );

  runDispatchStart({ repoRoot: root, run: created.runId, dispatchId: request.dispatchId, agentId: 'native-duplicate-fixture' });
  const withDuplicateStart = readFileSync(eventsPath, 'utf8').trim().split('\n');
  const startLine = withDuplicateStart.find((line) => {
    const event = JSON.parse(line) as Record<string, unknown>;
    return event.type === 'actor_dispatched' && event.dispatch_id === request.dispatchId;
  });
  assert.ok(startLine);
  withDuplicateStart.push(startLine);
  writeFileSync(eventsPath, `${withDuplicateStart.join('\n')}\n`);
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, archetype: 'worker', run: created.runId, dispatchId: request.dispatchId }),
    /started more than once/,
  );
});

test('steering apply materializes mixed host and command slots without clobbering by default', (t) => {
  const root = tempRepo(t);
  seedHybridProfile(root);

  const first = runSteeringApply({ repoRoot: root, loadout: 'native', target: 'codex' });
  assert.ok(first.results.every((item) => item.status === 'created'));
  assert.deepEqual(first.materialization.worker, {
    kind: 'native', adapter: 'host', executor: 'luna', model: 'gpt-5.6-luna',
  });
  assert.match(read(root, '.codex/agents/worker.toml'), /model = "gpt-5\.6-luna"/);
  assert.match(read(root, '.codex/agents/reviewer.toml'), /model = "gpt-5\.6-terra"/);
  assert.match(read(root, '.codex/agents/judge.toml'), /model_reasoning_effort = "medium"/);
  assert.match(read(root, '.codex/agents/worker.toml'), /# Fadeno engine step assignment/);
  assert.match(read(root, '.codex/agents/worker.toml'), /# Fadeno step assignment/);
  assert.match(read(root, '.codex/agents/worker.toml'), /mode=command/);
  assert.match(read(root, '.codex/agents/worker.toml'), /mode=restart_required/);
  assert.match(read(root, '.codex/agents/worker.toml'), /fadeno steering resolve --archetype worker --native-executor luna/);

  const second = runSteeringApply({ repoRoot: root, loadout: 'native', target: 'codex' });
  assert.ok(second.results.every((item) => item.status === 'skipped'));

  const mixed = runSteeringApply({ repoRoot: root, loadout: 'mixed', target: 'codex', force: true });
  assert.equal(mixed.materialization.reviewer?.kind, 'command-broker');
  assert.equal(mixed.materialization.reviewer?.executor, 'opus');
  const broker = read(root, '.codex/agents/reviewer.toml');
  assert.match(broker, /model = "gpt-5\.6-luna"/);
  assert.match(broker, /model_reasoning_effort = "low"/);
  assert.match(broker, /fadeno steering resolve --archetype reviewer/);
  assert.doesNotMatch(broker, /--native-executor/);
  assert.match(broker, /mode=command/);
  assert.match(broker, /mode=restart_required/);
  assert.match(broker, /relay stdout verbatim/);
  assert.doesNotMatch(broker, /native baseline/);

  const allCommand = runSteeringApply({ repoRoot: root, loadout: 'all-command', target: 'codex', force: true });
  assert.ok(Object.values(allCommand.materialization).every((slot) => slot.kind === 'command-broker'));
  const agentPaths = ['worker', 'reviewer', 'judge'].map((role) => `.codex/agents/${role}.toml`);
  const beforeMissing = agentPaths.map((path) => read(root, path));

  assert.throws(
    () => runSteeringApply({ repoRoot: root, loadout: 'missing', target: 'codex', force: true }),
    /needs an executor in its "judge" slot/,
  );
  assert.deepEqual(agentPaths.map((path) => read(root, path)), beforeMissing);
  const beforeBadType = agentPaths.map((path) => read(root, path));
  assert.throws(
    () => runSteeringApply({ repoRoot: root, loadout: 'bad-type', target: 'codex', force: true }),
    /agent_type "worker"; expected "reviewer"/,
  );
  assert.deepEqual(agentPaths.map((path) => read(root, path)), beforeBadType);
});

test('tool-complete starts and attributes the exact next tool_call atomically', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'tool-only.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'tool-only',
    description: 'Exercise one manual tool call.',
    roles: { coordinator: { purpose: 'Own the run.' } },
    flow: [{ id: 'test', kind: 'tool_call', tool: 'test_runner', output: 'TestResult' }],
  }));
  const created = runNewRun({ repoRoot: root, playbook: 'tool-only', task: 'Run tests' });
  const output = join(created.runDir, 'artifacts', 'test-result.json');
  const beforeEvents = readFileSync(join(created.runDir, 'events.jsonl'), 'utf8');
  const beforeRun = readFileSync(join(created.runDir, 'run.yaml'), 'utf8');
  writeFileSync(output, JSON.stringify({
    tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 'not-an-integer', summary: 'invalid result',
  }));
  assert.throws(
    () => runToolComplete({ repoRoot: root, run: created.runId, output }),
    /test-result validation/,
  );
  assert.equal(readFileSync(join(created.runDir, 'events.jsonl'), 'utf8'), beforeEvents);
  assert.equal(readFileSync(join(created.runDir, 'run.yaml'), 'utf8'), beforeRun);
  const retry = runNext({ repoRoot: root, run: created.runId });
  assert.equal(retry.status, 'ready');
  assert.equal(retry.step?.id, 'test');

  writeFileSync(output, JSON.stringify({
    tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0, summary: 'ok',
  }));

  const result = runToolComplete({ repoRoot: root, run: created.runId, output });
  assert.equal(result.step, 'test');
  assert.deepEqual(result.appendedEvents, ['step_started', 'artifact_created']);
  const next = runNext({ repoRoot: root, run: created.runId });
  assert.equal(next.status, 'terminal');
});

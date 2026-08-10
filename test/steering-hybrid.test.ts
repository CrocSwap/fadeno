import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runNext } from '../src/commands/next.ts';
import { runSteeringApply, runSteeringResolve } from '../src/commands/steering.ts';
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
      mismatch: { worker: 'other', reviewer: 'terra', judge: 'sol' },
    },
  }));
}

test('hybrid steering resolves matching host locally, command slots live, and mismatches loudly', (t) => {
  const root = tempRepo(t);
  seedHybridProfile(root);

  const local = runSteeringResolve({ repoRoot: root, archetype: 'worker', nativeExecutor: 'luna', loadout: 'mixed', env: null });
  assert.equal(local.mode, 'native');
  assert.equal(local.executor, 'luna');

  const command = runSteeringResolve({ repoRoot: root, archetype: 'reviewer', nativeExecutor: 'terra', loadout: 'mixed', env: null });
  assert.equal(command.mode, 'command');
  assert.equal(command.executor, 'opus');

  const restart = runSteeringResolve({ repoRoot: root, archetype: 'worker', nativeExecutor: 'luna', loadout: 'mismatch', env: null });
  assert.equal(restart.mode, 'restart_required');
  assert.match(restart.detail, /fresh Codex session/);
});

test('steering apply materializes one host-backed Codex baseline without clobbering by default', (t) => {
  const root = tempRepo(t);
  seedHybridProfile(root);

  const first = runSteeringApply({ repoRoot: root, loadout: 'native', target: 'codex' });
  assert.ok(first.results.every((item) => item.status === 'created'));
  assert.match(read(root, '.codex/agents/worker.toml'), /model = "gpt-5\.6-luna"/);
  assert.match(read(root, '.codex/agents/reviewer.toml'), /model = "gpt-5\.6-terra"/);
  assert.match(read(root, '.codex/agents/judge.toml'), /model_reasoning_effort = "medium"/);
  assert.match(read(root, '.codex/agents/worker.toml'), /mode=command/);
  assert.match(read(root, '.codex/agents/worker.toml'), /mode=restart_required/);

  const second = runSteeringApply({ repoRoot: root, loadout: 'native', target: 'codex' });
  assert.ok(second.results.every((item) => item.status === 'skipped'));
  assert.throws(
    () => runSteeringApply({ repoRoot: root, loadout: 'mixed', target: 'codex', force: true }),
    /needs a host executor in its "reviewer" slot/,
  );
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
  writeFileSync(output, JSON.stringify({
    tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0, summary: 'ok',
  }));

  const result = runToolComplete({ repoRoot: root, run: created.runId, output });
  assert.equal(result.step, 'test');
  assert.deepEqual(result.appendedEvents, ['step_started', 'artifact_created']);
  const next = runNext({ repoRoot: root, run: created.runId });
  assert.equal(next.status, 'terminal');
});

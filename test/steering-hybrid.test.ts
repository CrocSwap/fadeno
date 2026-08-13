import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runNext } from '../src/commands/next.ts';
import { runDispatchFallback, runDispatchStart } from '../src/commands/dispatch.ts';
import { runSteeringApply, runSteeringResolve } from '../src/commands/steering.ts';
import { runPrompt } from '../src/commands/prompt.ts';
import { runToolComplete } from '../src/commands/tool-complete.ts';
import { runVerify } from '../src/commands/verify.ts';
import { exists, read, tempRepo } from './helpers.ts';

function seedHybridProfile(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      luna: {
        adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker',
        fallback_command: ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('fallback:'+d))"],
      },
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

  const local = runSteeringResolve({ repoRoot: root, archetype: 'worker', hostExecutor: 'luna', loadout: 'mixed', env: null });
  assert.equal(local.mode, 'host');
  assert.equal(local.executor, 'luna');

  const brokerHost = runSteeringResolve({ repoRoot: root, archetype: 'worker', loadout: 'native', env: null });
  assert.equal(brokerHost.mode, 'command');
  assert.match(brokerHost.detail, /declared command fallback/);

  const command = runSteeringResolve({ repoRoot: root, archetype: 'reviewer', hostExecutor: 'terra', loadout: 'mixed', env: null });
  assert.equal(command.mode, 'command');
  assert.equal(command.executor, 'opus');

  const restart = runSteeringResolve({ repoRoot: root, archetype: 'worker', hostExecutor: 'luna', loadout: 'mismatch', env: null });
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
    hostExecutor: 'luna',
    loadout: 'mismatch',
    env: 'mismatch',
    run: created.runId,
    dispatchId: request.dispatchId,
  });
  assert.equal(locked.mode, 'host');
  assert.equal(locked.executor, 'luna');
  assert.equal(locked.source, 'host-request');

  const restart = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    hostExecutor: 'other',
    run: created.runId,
    dispatchId: request.dispatchId,
  });
  assert.equal(restart.mode, 'command');
  assert.match(restart.detail, /declared command fallback/);
  const broker = runSteeringResolve({ repoRoot: root, archetype: 'worker', run: created.runId, dispatchId: request.dispatchId });
  assert.equal(broker.mode, 'command');
  assert.match(broker.detail, /declared command fallback/);
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

test('engine host steering automatically completes a mismatched native slot through its locked fallback', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true });
  seedHybridProfile(root);
  writeFileSync(join(root, '.fadeno', 'playbooks', 'fallback.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'fallback',
    description: 'Locked fallback fixture.',
    roles: { worker: { purpose: 'Implement.', archetype: 'worker' } },
    inputs: { Task: { media_type: 'text/markdown' } },
    flow: [{ id: 'implement', kind: 'actor_call', actor: 'worker', input: ['Task'], output: 'Notes', terminal_status: 'completed' }],
  }));
  writeFileSync(join(root, 'task.md'), 'fallback task');
  const created = runNewRun({ repoRoot: root, playbook: 'fallback', task: 'test automatic fallback', inputs: ['Task=task.md'] });
  const paused = runDrive({ repoRoot: root, run: created.runId, loadout: 'native' });
  assert.equal(paused.outcome, 'awaiting_host_dispatch');
  const request = paused.requests[0]!;

  const resolution = runSteeringResolve({
    repoRoot: root,
    archetype: 'worker',
    hostExecutor: 'other',
    run: created.runId,
    dispatchId: request.dispatchId,
  });
  assert.equal(resolution.mode, 'command');
  const delivered = runDispatchFallback({ repoRoot: root, run: created.runId, dispatchId: request.dispatchId });
  assert.equal(delivered.exitCode, 0);
  assert.match(delivered.stdout, /^fallback:# Fadeno step assignment/);

  const terminal = runDrive({ repoRoot: root, run: created.runId });
  assert.equal(terminal.outcome, 'terminal');
  assert.equal(terminal.status, 'completed');
  assert.equal(runVerify({ repoRoot: root, run: created.runId }).ok, true);
  const events = readFileSync(join(created.runDir, 'events.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const start = events.find((event) => event.type === 'actor_dispatched' && event.dispatch_id === request.dispatchId)!;
  const completion = events.find((event) => event.type === 'actor_completed' && event.dispatch_id === request.dispatchId)!;
  assert.equal(start.delivery_transport, 'command-fallback');
  assert.equal(start.host_attested, false);
  assert.equal(start.identity_evidence, 'command_receipt');
  assert.deepEqual(completion.fallback_command, start.fallback_command);
  assert.equal(completion.fallback_command_sha256, start.fallback_command_sha256);

  const replay = runDispatchFallback({ repoRoot: root, run: created.runId, dispatchId: request.dispatchId });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.stdout, delivered.stdout);

  const eventsPath = join(created.runDir, 'events.jsonl');
  const forged = readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.dispatch_id === request.dispatchId && Array.isArray(event.fallback_command)) {
      event.fallback_command = ['forged-command'];
    }
    return JSON.stringify(event);
  }).join('\n');
  writeFileSync(eventsPath, `${forged}\n`);
  const audit = runVerify({ repoRoot: root, run: created.runId });
  assert.equal(audit.ok, false);
  assert.equal(audit.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')?.status, 'fail');
});

test('steering apply materializes mixed host and command slots without clobbering by default', (t) => {
  const root = tempRepo(t);
  seedHybridProfile(root);

  const first = runSteeringApply({ repoRoot: root, loadout: 'native', target: 'codex' });
  assert.ok(first.results.every((item) => item.status === 'created'));
  assert.deepEqual(first.materialization.worker, {
    kind: 'host', adapter: 'host', executor: 'luna', model: 'gpt-5.6-luna',
  });
  assert.match(read(root, '.codex/agents/worker.toml'), /model = "gpt-5\.6-luna"/);
  assert.match(read(root, '.codex/agents/reviewer.toml'), /model = "gpt-5\.6-terra"/);
  assert.match(read(root, '.codex/agents/judge.toml'), /model_reasoning_effort = "medium"/);
  assert.match(read(root, '.codex/agents/worker.toml'), /# Fadeno engine step assignment/);
  assert.match(read(root, '.codex/agents/worker.toml'), /# Fadeno step assignment/);
  assert.match(read(root, '.codex/agents/worker.toml'), /mode=command/);
  assert.match(read(root, '.codex/agents/worker.toml'), /mode=restart_required/);
  assert.match(read(root, '.codex/agents/worker.toml'), /fadeno steering resolve --archetype worker --host-executor luna/);
  assert.match(read(root, '.codex/agents/worker.toml'), /fadeno dispatch-fallback <run-id> <dispatch-id>/);

  const second = runSteeringApply({ repoRoot: root, loadout: 'native', target: 'codex' });
  assert.ok(second.results.every((item) => item.status === 'skipped'));

  const mixed = runSteeringApply({ repoRoot: root, loadout: 'mixed', target: 'codex', force: true });
  assert.equal(mixed.materialization.reviewer?.kind, 'command-broker');
  assert.equal(mixed.materialization.reviewer?.executor, 'opus');
  const broker = read(root, '.codex/agents/reviewer.toml');
  assert.match(broker, /model = "gpt-5\.6-luna"/);
  assert.match(broker, /model_reasoning_effort = "low"/);
  assert.match(broker, /fadeno steering resolve --archetype reviewer/);
  assert.doesNotMatch(broker, /--host-executor/);
  assert.match(broker, /mode=command/);
  assert.match(broker, /mode=restart_required/);
  assert.match(broker, /relay stdout verbatim/);
  assert.match(broker, /fadeno dispatch-fallback <run-id> <dispatch-id>/);
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

/**
 * `ro-cli` stands in for a headless CLI in a read-only permission mode, and
 * `ro-host` for a native target whose declared command fallback is read-only.
 */
function seedWriteGuardProfile(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      'ro-cli': { adapter: 'command', command: ['claude', '-p'], model: 'opus', write_access: false },
      'rw-cli': { adapter: 'command', command: ['codex', 'exec', '-'], model: 'gpt-5.6-sol', write_access: true },
      'ro-host': {
        adapter: 'host', model: 'opus', reasoning_effort: 'high', agent_type: 'worker',
        fallback_command: ['claude', '-p'], write_access: false,
      },
      native: { adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker' },
      reviewer: { adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer' },
      judge: { adapter: 'host', model: 'gpt-5.6-sol', reasoning_effort: 'medium', agent_type: 'judge' },
    },
    archetypes: { worker: { requires_write: true }, reviewer: { requires_write: false } },
    loadouts: {
      'ro-worker': { worker: 'ro-cli', reviewer: 'ro-cli', judge: 'judge' },
      'ro-fallback': { worker: 'ro-host', reviewer: 'reviewer', judge: 'judge' },
      'rw-worker': { worker: 'rw-cli', reviewer: 'ro-cli', judge: 'judge' },
      native: { worker: 'native', reviewer: 'reviewer', judge: 'judge' },
    },
  }));
}

test('steering resolve refuses a command slot whose delivery cannot do the archetype\'s work', (t) => {
  const root = tempRepo(t);
  seedWriteGuardProfile(root);

  const refused = runSteeringResolve({ repoRoot: root, archetype: 'worker', loadout: 'ro-worker', env: null });
  assert.equal(refused.mode, 'write_conflict');
  assert.equal(refused.executor, 'ro-cli');
  assert.equal(refused.adapter, 'command');
  assert.match(refused.writeConflict!, /archetype "worker" declares `requires_write: required`, but executor "ro-cli"/);
  assert.match(refused.writeConflict!, /in-session worker agent/);
  // The human echo carries the refusal, not a "dispatch through …" invitation.
  assert.equal(refused.detail, refused.writeConflict);

  // A host slot's declared command fallback is a command delivery too.
  const fallback = runSteeringResolve({ repoRoot: root, archetype: 'worker', loadout: 'ro-fallback', env: null });
  assert.equal(fallback.mode, 'write_conflict');
  assert.equal(fallback.executor, 'ro-host');
  assert.equal(fallback.adapter, 'host');

  // Native delivery of the same read-only target is the host's business.
  const native = runSteeringResolve({
    repoRoot: root, archetype: 'worker', hostExecutor: 'ro-host', loadout: 'ro-fallback', env: null,
  });
  assert.equal(native.mode, 'host');
  assert.equal(native.writeConflict, undefined);

  // Clean command slots are untouched: a write-capable delivery, and an
  // archetype that declares no write need.
  const capable = runSteeringResolve({ repoRoot: root, archetype: 'worker', loadout: 'rw-worker', env: null });
  assert.equal(capable.mode, 'command');
  assert.equal(capable.executor, 'rw-cli');
  assert.equal(capable.writeConflict, undefined);
  const reader = runSteeringResolve({ repoRoot: root, archetype: 'reviewer', loadout: 'ro-worker', env: null });
  assert.equal(reader.mode, 'command');
  assert.equal(reader.executor, 'ro-cli');
});

test('steering apply refuses to materialize a broker for a conflicted slot; other slots proceed', (t) => {
  const root = tempRepo(t);
  seedWriteGuardProfile(root);

  const applied = runSteeringApply({ repoRoot: root, loadout: 'ro-worker', target: 'codex' });
  assert.equal(applied.materialization.worker?.kind, 'write-conflict');
  assert.equal(applied.materialization.worker?.executor, 'ro-cli');
  assert.match(
    applied.materialization.worker!.writeConflict!,
    /archetype "worker" declares `requires_write: required`, but executor "ro-cli"/,
  );
  // No broker file at all for the refused slot — nothing can route to it.
  assert.equal(exists(root, '.codex/agents/worker.toml'), false);

  // The read-only reviewer slot (same executor, no write need) still lands, as
  // does the native judge slot.
  assert.equal(applied.materialization.reviewer?.kind, 'command-broker');
  assert.equal(applied.materialization.judge?.kind, 'host');
  assert.ok(exists(root, '.codex/agents/reviewer.toml'));
  assert.ok(exists(root, '.codex/agents/judge.toml'));
  assert.deepEqual(
    applied.results.map((item) => item.path.endsWith('worker.toml')),
    [false, false],
  );

  // A write-capable worker slot materializes normally, and the materialized
  // agents know to stop on a refusal rather than dispatch or substitute.
  const capable = runSteeringApply({ repoRoot: root, loadout: 'rw-worker', target: 'codex', force: true });
  assert.equal(capable.materialization.worker?.kind, 'command-broker');
  assert.match(read(root, '.codex/agents/worker.toml'), /mode=write_conflict/);
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

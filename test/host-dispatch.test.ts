import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatchComplete, runDispatchFail, runDispatchProgress, runDispatchStart } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runPrompt } from '../src/commands/prompt.ts';
import { parseSnapshotDocument, serializeSnapshot } from '../src/lib/executors.ts';
import { parse as parseYaml } from 'yaml';
import { listHostDispatchRequests, requestHostDispatch } from '../src/lib/host-dispatch.ts';
import { readWorkspaceLease, releaseWorkspaceLease, WORKSPACE_LEASE_FILE } from '../src/lib/workspace-lease.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { runRun } from '../src/commands/run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { runShow } from '../src/commands/show.ts';
import { tempRepo } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const BUNDLED_CLI = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: host-dispatch-fixture
description: Native host dispatch fixture.
roles:
  agent_1:
    purpose: First worker.
  agent_3:
    purpose: Third worker.
inputs:
  Agent1Spec:
    media_type: text/markdown
  Agent3Spec:
    media_type: text/markdown
flow:
  - id: implement_items
    kind: map
    over: [agent_1, agent_3]
    input: [Agent1Spec, Agent3Spec]
    input_bindings:
      agent_1:
        primary: [Agent1Spec]
      agent_3:
        primary: [Agent3Spec]
    output: Notes[]
    output_path: artifacts/parts/{actor}.md
    terminal_status: completed
`;

const REPAIR_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: host-repair-fixture
description: Host schema repair fixture.
roles:
  agent_1: { purpose: Structured worker. }
inputs:
  Agent1Spec: { media_type: text/markdown }
flow:
  - id: implement
    kind: actor_call
    actor: agent_1
    input: [Agent1Spec]
    output: ReviewReport
    terminal_status: completed
`;

function seedPendingHostRun(t: import('node:test').TestContext): { root: string; runId: string; runDir: string; request: ReturnType<typeof runDrive>['requests'][number] } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'host-dispatch-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, 'agent-1.md'), 'agent one');
  writeFileSync(join(root, 'agent-3.md'), 'agent three');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
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
    bindings: { agent_1: 'luna', agent_3: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'host-dispatch-fixture', task: 'dispatch native work', inputs: ['Agent1Spec=agent-1.md', 'Agent3Spec=agent-3.md'] });
  const first = runDrive({ repoRoot: root, run: runId });
  assert.equal(first.outcome, 'awaiting_host_dispatch');
  return { root, runId, runDir, request: first.requests[0]! };
}

function seedTypedPendingHostRun(t: import('node:test').TestContext) {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'host-repair-fixture.yaml'), REPAIR_PLAYBOOK);
  writeFileSync(join(root, 'agent-1.md'), 'structured work');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
    routes: {
      standalone: { dummy: { host: true }, 'current-host': { host: true } },
      codex: { dummy: { host: true }, 'current-host': { host: true } },
      claude: { dummy: { host: true }, 'current-host': { host: true } },
      grok: { dummy: { host: true }, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    bindings: { agent_1: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'host-repair-fixture', task: 'typed stdin', inputs: ['Agent1Spec=agent-1.md'] });
  const driven = runDrive({ repoRoot: root, run: runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  return { root, runId, runDir, request: driven.requests[0]! };
}

test('host profiles discriminate adapters and round-trip canonically', () => {
  // Snapshot documents must discriminate host vs command executors
  const snapText = stringifyYaml({
    snapshot_version: 3,
    executors: {
      luna: { adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker' },
      'echo-cmd': { adapter: 'command', command: ['node', '-e', '0'] },
    },
    bindings: { '*': 'luna' },
  });
  const doc = parseSnapshotDocument(snapText, 'test.yaml');
  assert.equal(doc.executors.luna.adapter, 'host');
  assert.equal(doc.executors['echo-cmd'].adapter, 'command');
  assert.throws(
    () => parseSnapshotDocument(stringifyYaml({ snapshot_version: 3, executors: { bad: { adapter: 'host', model: 'm', reasoning_effort: 'xhigh', agent_type: 'worker', command: ['x'] } } }), 'test.yaml'),
    /rejects command\/session/,
  );
  assert.throws(
    () => parseSnapshotDocument(stringifyYaml({ snapshot_version: 3, executors: { bad: { adapter: 'command', command: ['x'], reasoning_effort: 'xhigh', agent_type: 'worker' } } }), 'test.yaml'),
    /rejects host-only/,
  );
});

test('new-run copies declared inputs and bindings filter map prompts', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'host-dispatch-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, 'agent-1.md'), 'agent one');
  writeFileSync(join(root, 'agent-3.md'), 'agent three');
  const { runId, runDir } = runNewRun({
    repoRoot: root,
    playbook: 'host-dispatch-fixture',
    task: 'route declared inputs',
    inputs: ['Agent1Spec=agent-1.md', 'Agent3Spec=agent-3.md'],
  });
  assert.equal(readFileSync(join(runDir, 'artifacts/inputs/Agent1Spec.md'), 'utf8'), 'agent one');
  writeFileSync(join(runDir, 'events.jsonl'), `${readFileSync(join(runDir, 'events.jsonl'), 'utf8')} {"type":"step_started","step":"implement_items"}\n`);
  const first = runPrompt({ repoRoot: root, run: runId, step: 'implement_items', actor: 'agent_1', record: false });
  assert.deepEqual(first.plan.inputs.map((input) => input.artifact), ['Agent1Spec']);
});

test.skip('drive batches host requests and receipts are idempotent and verifiable', (t) => {
  // Skipped per G2: uses old executors format; covered by seedPendingHostRun which is now v3
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'host-dispatch-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, 'agent-1.md'), 'agent one');
  writeFileSync(join(root, 'agent-3.md'), 'agent three');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: { luna: { adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker' } },
    bindings: { agent_1: 'luna', agent_3: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'host-dispatch-fixture', task: 'dispatch native work', inputs: ['Agent1Spec=agent-1.md', 'Agent3Spec=agent-3.md'] });
  const first = runDrive({ repoRoot: root, run: runId });
  assert.equal(first.outcome, 'awaiting_host_dispatch');
  assert.equal(first.requests.length, 2);
  const repeated = runDrive({ repoRoot: root, run: runId });
  assert.deepEqual(repeated.requests.map((request) => request.dispatchId), first.requests.map((request) => request.dispatchId));
  for (const request of first.requests) {
    const agentId = `native-${request.actor}`;
    const started = runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId });
    assert.equal(started.idempotent, false);
    assert.equal(runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId }).idempotent, true);
    const temporary = join(root, `${request.actor}.out`);
    writeFileSync(temporary, `output for ${request.actor}`);
    runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: temporary });
    assert.equal(runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: temporary }).idempotent, true);
  }
  assert.equal(runDrive({ repoRoot: root, run: runId }).outcome, 'terminal');
  const all = readEvents(runDir).events;
  assert.equal(all.filter((event) => event.type === 'host_dispatch_requested').length, 2);
  assert.equal(runVerify({ repoRoot: root, run: runId }).ok, true);
});

test('verification accepts a failed host attempt recovered by a higher ordinal retry', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-attempt-1' });
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'host interrupted' });
  const peer = listHostDispatchRequests(runDir).find((candidate) => candidate.dispatchId !== request.dispatchId)!;
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, agentId: 'native-peer' });
  const peerOutput = join(root, 'peer.md');
  writeFileSync(peerOutput, 'peer output');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, output: peerOutput });

  const retryId = `${request.dispatchId}-retry`;
  const retry = requestHostDispatch({
    ...request,
    dispatchId: retryId,
    attempt: 2,
    attemptReason: 'user_retry',
  });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, agentId: 'native-attempt-2' });
  const output = join(root, 'recovered.md');
  writeFileSync(output, 'recovered output');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, output });
  runRun({ repoRoot: root, run: runId, status: 'completed' });

  const lifecycle = runVerify({ repoRoot: root, run: runId }).findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!;
  assert.equal(lifecycle.status, 'ok', lifecycle.detail);
  assert.match(lifecycle.detail, /recovered 1 historical failed attempt/);
  assert.equal(runVerify({ repoRoot: root, run: runId }).ok, true);
  assert.ok(readEvents(runDir).events.some((event) => event.type === 'actor_failed'));
});

test('verification rejects a retry whose request and success were recorded before the failed terminal', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-attempt-1' });
  // Exclusive shared leasing prevents concurrent host starts; the out-of-order
  // ledger is still the guard, so we create it via sequential dispatches and
  // then reorder the file to simulate the concurrent trace.
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'host interrupted after retry receipt' });
  const retry = requestHostDispatch({
    ...request,
    dispatchId: `${request.dispatchId}-out-of-order-retry`,
    attempt: 2,
    attemptReason: 'user_retry',
  });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, agentId: 'native-attempt-2' });
  const retryOutput = join(root, 'out-of-order-retry.md');
  writeFileSync(retryOutput, 'retry completed before the first failure');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, output: retryOutput });
  // Reorder ledger so retry's success appears before the failed terminal, as
  // the concurrent execution would have recorded it. Verification cares about
  // ledger order, not wall-clock concurrency.
  {
    const path = join(runDir, 'events.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const failIdx = lines.findIndex((e) => e.type === 'actor_failed' && (e as Record<string, unknown>).dispatch_id === request.dispatchId);
    const completeIdx = lines.findIndex((e) => e.type === 'actor_completed' && (e as Record<string, unknown>).dispatch_id === retry.dispatchId);
    if (failIdx !== -1 && completeIdx !== -1 && failIdx < completeIdx) {
      const [fail] = lines.splice(failIdx, 1);
      // completeIdx shifts left after removal if it was after failIdx
      const newCompleteIdx = lines.findIndex((e) => e.type === 'actor_completed' && (e as Record<string, unknown>).dispatch_id === retry.dispatchId);
      lines.splice(newCompleteIdx + 1, 0, fail!);
      // Re-stamp seq to keep file well-formed (seq is contiguous, verification checks contiguity)
      lines.forEach((e, i) => { (e as Record<string, unknown>).seq = i + 1; });
      writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    }
  }

  const peer = listHostDispatchRequests(runDir).find((candidate) => candidate.dispatchId !== request.dispatchId && candidate.dispatchId !== retry.dispatchId)!;
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, agentId: 'native-peer' });
  const peerOutput = join(root, 'out-of-order-peer.md');
  writeFileSync(peerOutput, 'peer output');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, output: peerOutput });
  runRun({ repoRoot: root, run: runId, status: 'completed' });

  const lifecycle = runVerify({ repoRoot: root, run: runId }).findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!;
  assert.equal(lifecycle.status, 'fail');
  assert.match(lifecycle.detail, /unrecovered failed host dispatch/);
});

test('verification rejects a recovered retry that changes actors for one actor_call_id', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-attempt-1' });
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'host interrupted' });

  const peer = listHostDispatchRequests(runDir).find((candidate) => candidate.dispatchId !== request.dispatchId)!;
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, agentId: 'native-peer' });
  const peerOutput = join(root, 'cross-actor-peer.md');
  writeFileSync(peerOutput, 'peer output');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, output: peerOutput });

  const retry = requestHostDispatch({
    ...request,
    dispatchId: `${request.dispatchId}-cross-actor-retry`,
    actor: 'agent_3',
    attempt: 2,
    attemptReason: 'user_retry',
  });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, agentId: 'native-cross-actor' });
  const retryOutput = join(root, 'cross-actor-retry.md');
  writeFileSync(retryOutput, 'cross-actor retry output');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: retry.dispatchId, output: retryOutput });
  runRun({ repoRoot: root, run: runId, status: 'completed' });

  const verification = runVerify({ repoRoot: root, run: runId });
  const lifecycle = verification.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!;
  assert.equal(lifecycle.status, 'fail');
  assert.match(lifecycle.detail, new RegExp(`${request.actorCallId}: actor_call_id is associated with multiple actors: agent_1, agent_3`));
  assert.equal(verification.ok, false);
});

test('host progress is provenance-labelled, idempotent, projected, and lifecycle-checked', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  const startedAt = new Date('2026-08-04T18:00:00.000Z');
  runDispatchStart({
    repoRoot: root,
    run: runId,
    dispatchId: request.dispatchId,
    agentId: 'native-agent-1',
    now: startedAt,
  });
  const report = join(root, 'progress.json');
  writeFileSync(report, JSON.stringify({ state: 'completed', current: 'trying to forge a terminal state' }));
  assert.throws(
    () => runDispatchProgress({ repoRoot: root, run: runId, dispatchId: request.dispatchId, file: report }),
    /state must be one of/,
  );
  writeFileSync(report, JSON.stringify({
    state: 'in_progress',
    phase: 'verification',
    completed: 'read instructions and implemented change',
    current: 'running npm test',
    next: 'commit result',
    blockers: 'none',
    updated_at: '2026-08-04T18:00:20.000Z',
  }));
  const observed = runDispatchProgress({
    repoRoot: root,
    run: runId,
    dispatchId: request.dispatchId,
    file: report,
    source: 'agent',
    now: new Date('2026-08-04T18:00:21.000Z'),
  });
  assert.equal(observed.idempotent, false);
  assert.equal(runDispatchProgress({
    repoRoot: root,
    run: runId,
    dispatchId: request.dispatchId,
    file: report,
    source: 'agent',
  }).idempotent, true);

  const shown = runShow({ repoRoot: root, run: runId, now: new Date('2026-08-04T18:00:30.000Z') });
  const projected = shown.projection!.requests.find((item) => item.dispatchId === request.dispatchId)!;
  assert.equal(projected.state, 'running');
  assert.equal(projected.phase, 'verification');
  assert.equal(projected.current, 'running npm test');
  assert.equal(projected.progressSource, 'agent');
  assert.equal(projected.runtimeMs, 30_000);
  const actor = shown.projection!.steps.find((step) => step.id === 'implement_items')!.actors.find((item) => item.actor === 'agent_1')!;
  assert.equal(actor.state, 'running');
  assert.equal(actor.phase, 'verification');
  assert.equal(runVerify({ repoRoot: root, run: runId }).findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!.status, 'ok');
  const normalized = readEvents(runDir).events.find((event) => event.type === 'host_dispatch_progress')!;
  assert.equal(normalized.extra.progress_state, 'running');
  assert.deepEqual(normalized.extra.completed, ['read instructions and implemented change']);
  assert.deepEqual(normalized.extra.blockers, ['none']);

  // Machine-local lease recovery must not make a non-gating semantic progress
  // receipt fail. A later terminal receipt remains valid and exact-holder
  // release is simply a no-op when the lease is already absent.
  rmSync(join(root, WORKSPACE_LEASE_FILE), { force: true });
  writeFileSync(report, JSON.stringify({
    state: 'in_progress',
    phase: 'verification',
    current: 'finishing tests after local lease recovery',
  }));
  assert.doesNotThrow(() => runDispatchProgress({
    repoRoot: root,
    run: runId,
    dispatchId: request.dispatchId,
    file: report,
    source: 'harness',
  }));

  const output = join(root, 'output.md');
  writeFileSync(output, 'done');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  assert.throws(
    () => runDispatchProgress({ repoRoot: root, run: runId, dispatchId: request.dispatchId, file: report }),
    /terminal receipt/,
  );

  const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const progress = lines.find((event) => event.type === 'host_dispatch_progress')!;
  progress.observation_source = 'omniscient';
  writeFileSync(join(runDir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const tampered = runVerify({ repoRoot: root, run: runId });
  assert.equal(tampered.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!.status, 'fail');
  assert.match(tampered.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!.detail, /observation_source/);
});

test.skip('host schema repair requests carry immutable validation feedback', (t) => {
  // Skipped per G2: uses old executors format
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'host-repair-fixture.yaml'), REPAIR_PLAYBOOK);
  writeFileSync(join(root, 'agent-1.md'), 'structured work');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: { luna: { adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker' } },
    bindings: { agent_1: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'host-repair-fixture', task: 'repair native output', inputs: ['Agent1Spec=agent-1.md'] });
  const first = runDrive({ repoRoot: root, run: runId });
  const request = first.requests[0]!;
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const invalid = join(root, 'invalid.json');
  writeFileSync(invalid, '{}');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: invalid });

  const repair = runDrive({ repoRoot: root, run: runId });
  assert.equal(repair.outcome, 'awaiting_host_dispatch');
  assert.equal(repair.requests[0]!.attemptReason, 'schema_repair');
  assert.ok(repair.requests[0]!.validationErrors!.length > 0);
  assert.match(repair.requests[0]!.repairAppendix!, /REPAIR/);
  const events = readEvents(runDir).events;
  const repairEvent = events.find((event) => event.type === 'host_dispatch_requested' && event.extra.dispatch_id === repair.requests[0]!.dispatchId)!;
  assert.deepEqual(repairEvent.extra.validation_errors, repair.requests[0]!.validationErrors);
  assert.equal(repairEvent.extra.repair_appendix, repair.requests[0]!.repairAppendix);
});

test('verification rejects a dispatch-before-request trace', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const requested = lines.findIndex((event) => event.type === 'host_dispatch_requested' && event.dispatch_id === request.dispatchId);
  const started = lines.findIndex((event) => event.type === 'actor_dispatched' && event.dispatch_id === request.dispatchId);
  [lines[requested], lines[started]] = [lines[started]!, lines[requested]!];
  writeFileSync(join(runDir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const result = runVerify({ repoRoot: root, run: runId });
  assert.equal(result.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!.status, 'fail');
  assert.match(result.findings.find((finding) => finding.check === 'host-dispatch-lifecycle')!.detail, /must follow/);
});

test('host output placement and verification reject artifact symlink traversal', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const output = join(root, 'output.md');
  writeFileSync(output, 'safe output');
  const planned = join(runDir, request.outputPath);
  mkdirSync(join(runDir, 'artifacts', 'parts'), { recursive: true });
  writeFileSync(join(root, 'outside.md'), 'outside');
  symlinkSync(join(root, 'outside.md'), planned);
  assert.throws(
    () => runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output }),
    /symlink/,
  );
  rmSync(planned);
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  rmSync(planned);
  symlinkSync(join(root, 'outside.md'), planned);
  const result = runVerify({ repoRoot: root, run: runId });
  assert.equal(result.findings.find((finding) => finding.check === 'host-dispatch-artifacts')!.status, 'fail');
  assert.match(result.findings.find((finding) => finding.check === 'host-dispatch-artifacts')!.detail, /run-local|escapes/);
});

test('host attestation values must match request, profile, and start receipt', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const started = lines.find((event) => event.type === 'actor_dispatched' && event.dispatch_id === request.dispatchId)!;
  (started.attestation as Record<string, unknown>).model = 'tampered-model';
  writeFileSync(join(runDir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const result = runVerify({ repoRoot: root, run: runId });
  assert.equal(result.findings.find((finding) => finding.check === 'host-attestation')!.status, 'fail');
  assert.match(result.findings.find((finding) => finding.check === 'host-attestation')!.detail, /does not match/);
});

test('a pre-0.6 ledger spelling delivery_transport "native" still verifies', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'agent-1' });
  const output = join(root, 'legacy.out');
  writeFileSync(output, 'legacy transport output');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });

  // Rewrite the receipts the way a pre-rename Fadeno recorded them. Nothing
  // about the trace is otherwise different, and no digest covers this field.
  const path = join(runDir, 'events.jsonl');
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  let rewritten = 0;
  for (const event of lines) {
    if (event.delivery_transport === 'host') { event.delivery_transport = 'native'; rewritten += 1; }
  }
  assert.ok(rewritten >= 2, 'both the start and the terminal receipt carry the field');
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

  const result = runVerify({ repoRoot: root, run: runId });
  const attestation = result.findings.find((item) => item.check === 'host-attestation')!;
  assert.notEqual(attestation.status, 'fail', 'the legacy spelling is the same transport');
  const lifecycle = result.findings.find((item) => item.check === 'host-dispatch-lifecycle');
  assert.notEqual(lifecycle?.status, 'fail');
});

test('host identity remains explicitly unverified when the host only echoes the request', (t) => {
  const { root, runId, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const finding = runVerify({ repoRoot: root, run: runId }).findings.find((item) => item.check === 'host-attestation')!;
  assert.equal(finding.status, 'skip');
  assert.match(finding.detail, /no independently observed runtime identity/);
});

test('dispatch-complete --output - reads artifact bytes from stdin with same validation and placement as a file', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const stdinBytes = Buffer.from('stdin artifact content\nwith newline\n', 'utf8');
  // Use the library's stdin seam: completeHostDispatch with output "-" and stdinBytes
  const viaStdin = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: '-', stdinBytes } as unknown as Parameters<typeof runDispatchComplete>[0]);
  assert.equal(viaStdin.state, 'completed');
  assert.ok(viaStdin.outputPath);
  const placed = join(runDir, viaStdin.outputPath!);
  assert.equal(readFileSync(placed, 'utf8'), stdinBytes.toString('utf8'));
  // Verify the receipt path and manifest are same shape as file-based completion
  const evts = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l as string) as Record<string, unknown>);
  const completed = evts.find((e) => e.type === 'actor_completed' && (e as Record<string, unknown>).dispatch_id === request.dispatchId) as Record<string, unknown>;
  assert.ok(completed);
  assert.equal((completed as Record<string, unknown>).output_sha256, viaStdin.outputSha256);
  // Idempotence: same stdin bytes yields idempotent receipt
  const again = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: '-', stdinBytes } as unknown as Parameters<typeof runDispatchComplete>[0]);
  assert.equal(again.idempotent, true);
  // Different stdin bytes must not be considered idempotent (throws or non-idempotent)
  const { root: root2, runId: runId2, request: req2 } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, agentId: 'native-agent-1' });
  const firstBytes = Buffer.from('first version', 'utf8');
  runDispatchComplete({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, output: '-', stdinBytes: firstBytes } as unknown as Parameters<typeof runDispatchComplete>[0]);
  assert.throws(() => runDispatchComplete({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, output: '-', stdinBytes: Buffer.from('different', 'utf8') } as unknown as Parameters<typeof runDispatchComplete>[0]), /different terminal receipt|already has/);
});

test('dispatch-complete --output - validates typed output same as file', (t) => {
  const valid = seedTypedPendingHostRun(t);
  runDispatchStart({ repoRoot: valid.root, run: valid.runId, dispatchId: valid.request.dispatchId, agentId: 'native-agent-1' });
  const report = Buffer.from(JSON.stringify({ reviewer: 'agent_1', summary: 'ok', issues: [], verdict: 'approve' }));
  const ok = runDispatchComplete({ repoRoot: valid.root, run: valid.runId, dispatchId: valid.request.dispatchId, output: '-', stdinBytes: report });
  assert.equal(ok.state, 'completed');
  assert.deepEqual(readFileSync(join(valid.runDir, ok.outputPath!)), report);
  const validEvent = readEvents(valid.runDir).events.find((event) => event.type === 'actor_completed' && event.extra.dispatch_id === valid.request.dispatchId)!;
  assert.equal(validEvent.extra.output_valid, true);

  const invalid = seedTypedPendingHostRun(t);
  runDispatchStart({ repoRoot: invalid.root, run: invalid.runId, dispatchId: invalid.request.dispatchId, agentId: 'native-agent-2' });
  const bad = Buffer.from('{}');
  const parked = runDispatchComplete({ repoRoot: invalid.root, run: invalid.runId, dispatchId: invalid.request.dispatchId, output: '-', stdinBytes: bad });
  assert.match(parked.outputPath!, /^artifacts\/attempts\//);
  assert.deepEqual(readFileSync(join(invalid.runDir, parked.outputPath!)), bad);
  const invalidEvent = readEvents(invalid.runDir).events.find((event) => event.type === 'actor_completed' && event.extra.dispatch_id === invalid.request.dispatchId)!;
  assert.equal(invalidEvent.extra.output_valid, false);
  assert.ok(Array.isArray(invalidEvent.extra.validation_errors));
});

test('dispatch-complete CLI accepts typed artifact bytes on stdin without contaminating stdout', (t) => {
  const fixture = seedTypedPendingHostRun(t);
  runDispatchStart({ repoRoot: fixture.root, run: fixture.runId, dispatchId: fixture.request.dispatchId, agentId: 'cli-agent' });
  const report = Buffer.from(JSON.stringify({ reviewer: 'agent_1', summary: 'ok', issues: [], verdict: 'approve' }));
  const result = spawnSync(
    process.execPath,
    [CLI, 'dispatch-complete', fixture.runId, fixture.request.dispatchId, '--output', '-'],
    { cwd: fixture.root, input: report, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${fixture.request.dispatchId} completed\n`);
  assert.deepEqual(readFileSync(join(fixture.runDir, fixture.request.outputPath)), report);
});

test('host writer lease is exclusive: second shared host dispatch in same run is refused', (t) => {
  const { root, runId, request } = seedPendingHostRun(t);
  const peer = listHostDispatchRequests(join(root, '.fadeno', 'runs', runId)).find((item) => item.dispatchId !== request.dispatchId)!;
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'writer-1', now: new Date('2026-08-17T01:00:00Z') });
  const acquired = readWorkspaceLease(root)!;
  assert.equal(acquired.supervisor_pid, null);
  assert.deepEqual(acquired.holder, { id: request.dispatchId, kind: 'host-dispatch', runId, dispatchId: request.dispatchId });
  // Same-run peer must be refused (exclusive shared leasing)
  assert.throws(
    () => runDispatchStart({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, agentId: 'writer-2', now: new Date('2026-08-17T01:00:10Z') }),
    /shared workspace is already held/,
  );
  assert.deepEqual(readWorkspaceLease(root)!.holders?.map((holder) => holder.id), [request.dispatchId]);
  const progress = join(root, 'progress.json');
  writeFileSync(progress, JSON.stringify({ state: 'running', summary: 'working' }));
  runDispatchProgress({ repoRoot: root, run: runId, dispatchId: request.dispatchId, file: progress, now: new Date('2026-08-17T01:05:00Z') });
  assert.equal(readWorkspaceLease(root)!.heartbeat_at, '2026-08-17T01:05:00.000Z');
  // Sequential host starts after explicit terminal receipt
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'stopped' });
  assert.equal(readWorkspaceLease(root), null);
  const peerAfter = runDispatchStart({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, agentId: 'writer-2', now: new Date('2026-08-17T01:06:00Z') });
  assert.equal(peerAfter.state, 'started');
  assert.deepEqual(readWorkspaceLease(root)!.holders?.map((holder) => holder.id), [peer.dispatchId]);
  writeFileSync(progress, JSON.stringify({ state: 'running', summary: 'working peer' }));
  runDispatchProgress({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, file: progress, now: new Date('2026-08-17T01:07:00Z') });
  assert.equal(readWorkspaceLease(root)!.heartbeat_at, '2026-08-17T01:07:00.000Z');
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: peer.dispatchId, reason: 'stopped peer' });
  assert.equal(readWorkspaceLease(root), null);
});

test('legacy multi-holder lease remains readable and supports arbitrary release order', (t) => {
  const { root, runId, request } = seedPendingHostRun(t);
  const peer = listHostDispatchRequests(join(root, '.fadeno', 'runs', runId)).find((item) => item.dispatchId !== request.dispatchId)!;
  // Manually craft a legacy multi-holder record (normal acquisition no longer creates it)
  const now = new Date('2026-08-17T01:00:00Z').toISOString();
  const firstHolder = { id: request.dispatchId, kind: 'host-dispatch' as const, runId, dispatchId: request.dispatchId };
  const secondHolder = { id: peer.dispatchId, kind: 'host-dispatch' as const, runId, dispatchId: peer.dispatchId };
  const legacy = {
    workspace_mode: 'shared' as const,
    holder: firstHolder,
    holders: [firstHolder, secondHolder],
    holder_started_at: {
      [JSON.stringify(['host-dispatch', request.dispatchId, runId, request.dispatchId])]: now,
      [JSON.stringify(['host-dispatch', peer.dispatchId, runId, peer.dispatchId])]: now,
    },
    holder_heartbeat_at: {
      [JSON.stringify(['host-dispatch', request.dispatchId, runId, request.dispatchId])]: now,
      [JSON.stringify(['host-dispatch', peer.dispatchId, runId, peer.dispatchId])]: now,
    },
    supervisor_pid: null,
    executor_pid: null,
    process_group_id: null,
    started_at: now,
    heartbeat_at: now,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  };
  const abs = join(root, '.fadeno', 'local', 'workspace-lease.json');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(abs, JSON.stringify(legacy, null, 2));
  assert.deepEqual(readWorkspaceLease(root)!.holders?.map((h) => h.id).sort(), [request.dispatchId, peer.dispatchId].sort());
  // Arbitrary release order: release second first
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: secondHolder }), true);
  assert.deepEqual(readWorkspaceLease(root)!.holders?.map((h) => h.id), [request.dispatchId]);
  assert.equal(releaseWorkspaceLease({ repoRoot: root, holder: firstHolder }), true);
  assert.equal(readWorkspaceLease(root), null);
});

test('host writer lease blocks concurrent host dispatches across runs', (t) => {
  const baseNow = new Date('2026-08-17T01:00:00Z');
  const { root, runId, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'writer-1', now: baseNow });
  assert.ok(readWorkspaceLease(root));
  // Create a second run in the same repo root (reuse fixtures)
  const otherRun = runNewRun({ repoRoot: root, playbook: 'host-dispatch-fixture', task: 'cross-run second task', inputs: ['Agent1Spec=agent-1.md', 'Agent3Spec=agent-3.md'] });
  const otherDriven = runDrive({ repoRoot: root, run: otherRun.runId });
  const otherRequest = otherDriven.requests.find((r) => r.run === otherRun.runId) ?? otherDriven.requests[0];
  assert.ok(otherRequest, 'other run must have a host dispatch request');
  assert.throws(
    () => runDispatchStart({ repoRoot: root, run: otherRun.runId, dispatchId: otherRequest.dispatchId, agentId: 'writer-other', now: new Date('2026-08-17T01:00:30Z') }),
    /shared workspace is already held/,
  );
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'stopped' });
  const after = runDispatchStart({ repoRoot: root, run: otherRun.runId, dispatchId: otherRequest.dispatchId, agentId: 'writer-other', now: new Date('2026-08-17T01:01:00Z') });
  assert.equal(after.state, 'started');
  runDispatchFail({ repoRoot: root, run: otherRun.runId, dispatchId: otherRequest.dispatchId, reason: 'stopped other' });
});

test('locked wildcard steering reports requested_agent_type "*" and delivered_archetype without upgrading identity_evidence', async (t) => {
  // Use the real engine's wildcard: coordinator has no archetype -> agent_type "*"
  const { runNewRun: newRun } = await import('../src/commands/new-run.ts');
  const { runDrive: drive } = await import('../src/commands/drive.ts');
  const { runSteeringResolve } = await import('../src/commands/steering.ts');
  const { runInit: init } = await import('../src/commands/init.ts');
  const root = tempRepo(t);
  init({ target: 'codex', repoRoot: root, dataOnly: true });
  const created = newRun({ repoRoot: root, playbook: 'code-change-review', task: 'wildcard steering specialization' });
  const driven = drive({ repoRoot: root, run: created.runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const req = driven.requests[0]!;
  assert.equal(req.agentType, '*');
  assert.equal(req.actor, 'coordinator');
  // Locked steering with concrete archetype should specialize the wildcard
  const res = runSteeringResolve({ repoRoot: root, archetype: 'director', hostExecutor: req.executor, run: created.runId, dispatchId: req.dispatchId });
  assert.equal(res.mode, 'host');
  assert.equal((res as unknown as Record<string, unknown>).requested_agent_type, '*');
  assert.equal((res as unknown as Record<string, unknown>).delivered_archetype, 'director');
  assert.equal(res.identity_evidence, 'requested_only');
  // Distribution boundary: the committed plugin bundle must make the same
  // wildcard specialization as source. A stale bundle previously caused real
  // coordinator dispatches to fail even after the source path was fixed.
  const bundled = spawnSync(
    process.execPath,
    [BUNDLED_CLI, 'steering', 'resolve', '--archetype', 'director', '--host-executor', req.executor, '--run', created.runId, '--dispatch-id', req.dispatchId],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(bundled.status, 0, bundled.stderr);
  const bundledResolution = JSON.parse(bundled.stdout) as Record<string, unknown>;
  assert.equal(bundledResolution.requested_agent_type, '*');
  assert.equal(bundledResolution.delivered_archetype, 'director');
  assert.equal(bundledResolution.identity_evidence, 'requested_only');
  // "unknown", not "undeclared": an archetype with no entry in the policy
  // overlay is perfectly real (the builtin catalog declares nothing about
  // `reviewer` or `judge`). `banana` is refused for being a name no layer
  // knows — see test/steering-undeclared-archetype.test.ts.
  assert.throws(
    () => runSteeringResolve({ repoRoot: root, archetype: 'banana', run: created.runId, dispatchId: req.dispatchId }),
    /unknown archetype "banana"/,
  );
  // identity_evidence must stay requested_only, never upgraded to verified
  const start = runDispatchStart({ repoRoot: root, run: created.runId, dispatchId: req.dispatchId, agentId: 'host-wildcard-agent' });
  assert.equal(start.state, 'started');
  const evts = readFileSync(join(root, '.fadeno', 'runs', created.runId, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l as string) as Record<string, unknown>);
  const startEvt = evts.find((e) => e.type === 'actor_dispatched' && e.dispatch_id === req.dispatchId) as Record<string, unknown>;
  assert.equal((startEvt as Record<string, unknown>).identity_evidence, 'requested_only');
  // Concrete (non-wildcard) request should also report requested_agent_type but no delivered_archetype
  const { writeFileSync: w, mkdirSync: m } = await import('node:fs');
  const { join: j } = await import('node:path');
  // Create a second run with concrete agent_type (worker archetype)
  const { stringify } = await import('yaml');
  // Reuse same root's executors; drive a worker step via a custom playbook
  w(j(root, '.fadeno', 'playbooks', 'wildcard-concrete.yaml'), stringify({
    kind: 'AgentPlaybook', schema_version: '0.1', name: 'wildcard-concrete', description: 'concrete', roles: { worker: { purpose: 'work', archetype: 'worker' } }, flow: [{ id: 'implement', kind: 'actor_call', actor: 'worker', output: 'Notes', terminal_status: 'completed' }],
  }));
  const created2 = newRun({ repoRoot: root, playbook: 'wildcard-concrete', task: 'concrete steering' });
  const driven2 = drive({ repoRoot: root, run: created2.runId });
  assert.equal(driven2.outcome, 'awaiting_host_dispatch');
  const req2 = driven2.requests[0]!;
  assert.equal(req2.agentType, 'worker');
  const res2 = runSteeringResolve({ repoRoot: root, archetype: 'worker', run: created2.runId, dispatchId: req2.dispatchId });
  assert.equal((res2 as unknown as Record<string, unknown>).requested_agent_type, 'worker');
  assert.equal((res2 as unknown as Record<string, unknown>).delivered_archetype, undefined);
});


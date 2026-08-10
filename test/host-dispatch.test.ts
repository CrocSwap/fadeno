import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatchComplete, runDispatchProgress, runDispatchStart } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runPrompt } from '../src/commands/prompt.ts';
import { parseExecutorProfile, serializeProfile } from '../src/lib/executors.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { runVerify } from '../src/commands/verify.ts';
import { runShow } from '../src/commands/show.ts';
import { tempRepo } from './helpers.ts';

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
    executors: { luna: { adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker' } },
    bindings: { agent_1: 'luna', agent_3: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'host-dispatch-fixture', task: 'dispatch native work', inputs: ['Agent1Spec=agent-1.md', 'Agent3Spec=agent-3.md'] });
  const first = runDrive({ repoRoot: root, run: runId });
  assert.equal(first.outcome, 'awaiting_host_dispatch');
  return { root, runId, runDir, request: first.requests[0]! };
}

test('host profiles discriminate adapters and round-trip canonically', () => {
  const profile = parseExecutorProfile(
    stringifyYaml({
      executors: {
        luna: { adapter: 'host', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', agent_type: 'worker' },
      },
      bindings: { '*': 'luna' },
    }),
    'test.yaml',
  );
  const roundTrip = parseExecutorProfile(serializeProfile(profile), 'round-trip.yaml');
  assert.deepEqual(roundTrip, profile);
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({ executors: { bad: { adapter: 'host', model: 'm', reasoning_effort: 'xhigh', agent_type: 'worker', command: ['x'] } }, bindings: { '*': 'bad' } }), 'test.yaml'),
    /rejects command\/session/,
  );
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({ executors: { bad: { adapter: 'command', command: ['x'], reasoning_effort: 'xhigh', agent_type: 'worker' } }, bindings: { '*': 'bad' } }), 'test.yaml'),
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

test('drive batches host requests and receipts are idempotent and verifiable', (t) => {
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

test('host schema repair requests carry immutable validation feedback', (t) => {
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

test('native attestation values must match request, profile, and start receipt', (t) => {
  const { root, runId, runDir, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const started = lines.find((event) => event.type === 'actor_dispatched' && event.dispatch_id === request.dispatchId)!;
  (started.attestation as Record<string, unknown>).model = 'tampered-model';
  writeFileSync(join(runDir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const result = runVerify({ repoRoot: root, run: runId });
  assert.equal(result.findings.find((finding) => finding.check === 'native-attestation')!.status, 'fail');
  assert.match(result.findings.find((finding) => finding.check === 'native-attestation')!.detail, /does not match/);
});

test('native identity remains explicitly unverified when the host only echoes the request', (t) => {
  const { root, runId, request } = seedPendingHostRun(t);
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'native-agent-1' });
  const finding = runVerify({ repoRoot: root, run: runId }).findings.find((item) => item.check === 'native-attestation')!;
  assert.equal(finding.status, 'skip');
  assert.match(finding.detail, /no independently observed runtime identity/);
});

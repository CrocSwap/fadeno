import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runShow } from '../src/commands/show.ts';
import { RunLedgerError } from '../src/lib/run-ledger.ts';
import { workspaceLeaseHolderKey } from '../src/lib/workspace-lease.ts';
import { tempRepo } from './helpers.ts';

const REPO = join(import.meta.dirname, '..');

function seedRun(
  root: string,
  runId: string,
  opts: {
    yaml?: string;
    events?: string;
    skipEvents?: boolean;
    artifacts?: Record<string, string>;
  } = {},
): string {
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const yaml =
    opts.yaml ??
    [
      '# yaml-language-server: $schema=../../schemas/run.schema.json',
      `run_id: ${runId}`,
      'schema_version: "0.3"',
      'playbook: code-change-review',
      'status: running',
      'task: Add label normalization',
      'started_at: 2026-07-11T02:12:32.797Z',
      'host: cli',
      'artifacts_dir: artifacts',
      'current_step: null',
      '',
    ].join('\n');
  writeFileSync(join(dir, 'run.yaml'), yaml, 'utf8');
  if (!opts.skipEvents) {
    const events =
      opts.events ??
      '{"type":"run_started","step":null,"timestamp":"2026-07-11T02:12:32.797Z"}\n';
    writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');
  }
  if (opts.artifacts) {
    for (const [rel, body] of Object.entries(opts.artifacts)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body, 'utf8');
    }
  }
  return dir;
}

test('show returns summary, events, and empty badLines for a clean run', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-add-label-normalization';
  seedRun(root, runId);

  const result = runShow({ repoRoot: root, run: '2026-07-10-2212' });
  assert.equal(result.run.runId, runId);
  assert.equal(result.run.playbook, 'code-change-review');
  assert.equal(result.run.status, 'running');
  assert.equal(result.run.task, 'Add label normalization');
  assert.equal(result.run.host, 'cli');
  assert.equal(result.run.startedAt, '2026-07-11T02:12:32.797Z');
  assert.equal(result.run.endedAt, null);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.type, 'run_started');
  assert.equal(result.events[0]!.step, null);
  assert.deepEqual(result.events[0]!.extra, {});
  assert.deepEqual(result.badLines, []);
});

test('projection starts from the playbook graph so unstarted steps and actors are pending', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-pending-graph';
  seedRun(root, runId);
  const playbooks = join(root, '.fadeno', 'playbooks');
  mkdirSync(playbooks, { recursive: true });
  writeFileSync(join(playbooks, 'code-change-review.yaml'), `kind: AgentPlaybook
schema_version: "0.1"
name: code-change-review
description: Projection fixture.
roles:
  agent_1: { purpose: First. }
  agent_2: { purpose: Second. }
  finalizer: { purpose: Finish. }
flow:
  - id: implement
    kind: map
    over: [agent_1, agent_2]
  - id: finalize
    kind: actor_call
    actor: finalizer
    terminal_status: completed
`);

  const result = runShow({ repoRoot: root, run: runId, now: new Date('2026-07-11T02:12:42.797Z') });
  const projection = result.projection!;
  assert.equal(projection.runtimeMs, 10_000);
  assert.deepEqual(projection.steps.map((step) => step.id), ['implement', 'finalize']);
  assert.deepEqual(projection.steps.map((step) => step.state), ['pending', 'pending']);
  assert.deepEqual(projection.steps[0]!.actors.map((actor) => [actor.actor, actor.state]), [
    ['agent_1', 'pending'],
    ['agent_2', 'pending'],
  ]);
  assert.deepEqual(projection.steps[1]!.actors.map((actor) => [actor.actor, actor.state]), [['finalizer', 'pending']]);

  const runDir = join(root, '.fadeno', 'runs', runId);
  writeFileSync(join(runDir, 'events.jsonl'), [
    '{"type":"run_started","step":null,"seq":1,"timestamp":"2026-07-11T02:12:32.797Z"}',
    '{"type":"actor_dispatched","step":"implement","actor":"agent_1","executor":"opus","seq":2,"timestamp":"2026-07-11T02:12:34.000Z"}',
    '{"type":"actor_failed","step":"implement","actor":"agent_1","executor":"opus","reason":"exit_nonzero","seq":3,"timestamp":"2026-07-11T02:12:39.000Z"}',
    '',
  ].join('\n'));
  const failed = runShow({ repoRoot: root, run: runId, now: new Date('2026-07-11T02:12:42.797Z') }).projection!;
  assert.equal(failed.steps[0]!.actors.find((actor) => actor.actor === 'agent_1')!.state, 'failed');
  assert.equal(failed.steps[0]!.actors.find((actor) => actor.actor === 'agent_1')!.runtimeMs, 5_000);
  assert.equal(failed.steps[0]!.state, 'failed');
});

test('unparseable event lines land in badLines; others still parse', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-mixed-events';
  seedRun(root, runId, {
    events: [
      '{"type":"run_started","step":null,"timestamp":"2026-07-11T02:12:32.797Z"}',
      'not-json',
      '{"type":"step_started","step":"implement","timestamp":"2026-07-11T02:13:00.000Z"}',
      '["array-not-object"]',
      '',
      '{"type":"run_completed","step":null,"timestamp":"2026-07-11T02:14:00.000Z"}',
      '',
    ].join('\n'),
  });

  const result = runShow({ repoRoot: root, run: runId });
  assert.equal(result.events.length, 3);
  assert.deepEqual(
    result.events.map((e) => e.type),
    ['run_started', 'step_started', 'run_completed'],
  );
  assert.deepEqual(result.badLines, [2, 4]);
  assert.equal(result.events[1]!.step, 'implement');
});

test('missing events.jsonl yields empty events and badLines', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-no-events';
  seedRun(root, runId, { skipEvents: true });

  const result = runShow({ repoRoot: root, run: runId });
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.badLines, []);
});

test('artifacts lists files recursively with sizes, sorted', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-with-arts';
  seedRun(root, runId, {
    artifacts: {
      'artifacts/plan.md': 'hello',
      'artifacts/nested/out.txt': 'abcd',
      'artifacts/review-report.json': '{}',
    },
  });

  const result = runShow({ repoRoot: root, run: runId });
  assert.deepEqual(
    result.artifacts.map((a) => a.path),
    ['artifacts/nested/out.txt', 'artifacts/plan.md', 'artifacts/review-report.json'],
  );
  assert.equal(result.artifacts[0]!.bytes, 4);
  assert.equal(result.artifacts[1]!.bytes, 5);
  assert.equal(result.artifacts[2]!.bytes, 2);
});

test('missing artifacts dir yields empty list', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-no-arts';
  const dir = seedRun(root, runId);
  rmSync(join(dir, 'artifacts'), { recursive: true, force: true });

  const result = runShow({ repoRoot: root, run: runId });
  assert.deepEqual(result.artifacts, []);
});

test('show throws RunLedgerError for unknown run', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'runs'), { recursive: true });
  assert.throws(() => runShow({ repoRoot: root, run: 'missing' }), RunLedgerError);
});

// --- projection ---

test('projection: steps in order with states, counts, gates, decisions, failures', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'playbooks', 'code-change-review.yaml'),
    [
      'flow:',
      '  - id: implement',
      '    kind: actor_call',
      '    actor: implementer',
      '  - id: review',
      '    kind: actor_call',
      '    actor: reviewer',
      '  - id: revise',
      '    kind: actor_call',
      '    actor: implementer',
      '  - id: arbitrate',
      '    kind: human_gate',
      '',
    ].join('\n'),
  );
  const runId = '2026-07-10-2212-projection';
  seedRun(root, runId, {
    events: [
      '{"type":"run_started","step":null,"seq":1,"timestamp":"2026-07-11T02:12:32.797Z"}',
      '{"type":"step_started","step":"implement","seq":2,"timestamp":"2026-07-11T02:13:00.000Z"}',
      '{"type":"artifact_created","step":"implement","artifact":"artifacts/impl.md","artifact_id":"artifact-3","logical_name":"artifacts/impl.md","generation":1,"bytes":5,"sha256":"ab","media_type":"text/markdown","validation":{"schema":null},"seq":3,"timestamp":"2026-07-11T02:13:10.000Z"}',
      '{"type":"step_started","step":"review","seq":4,"timestamp":"2026-07-11T02:14:00.000Z"}',
      '{"type":"gate_evaluated","step":"review","condition":"no_blocking_issues","artifact":"artifacts/review-report.json","result":"fail","seq":5,"timestamp":"2026-07-11T02:15:00.000Z"}',
      '{"type":"step_started","step":"revise","seq":6,"timestamp":"2026-07-11T02:16:00.000Z"}',
      '{"type":"loop_iteration_started","step":"revise","iteration":1,"seq":7,"timestamp":"2026-07-11T02:16:10.000Z"}',
      '{"type":"human_decision","step":"arbitrate","branch":"approve","seq":8,"timestamp":"2026-07-11T02:17:00.000Z"}',
      '',
    ].join('\n'),
  });

  const result = runShow({ repoRoot: root, run: runId });
  assert.equal(result.mode, 'current');
  const p = result.projection!;
  assert.deepEqual(
    p.steps.map((s) => s.id),
    ['implement', 'review', 'revise', 'arbitrate'],
  );
  // status running → the last-started step is current; arbitrate only appeared
  // via its decision event, so it is not the cursor.
  assert.deepEqual(
    p.steps.map((s) => s.state),
    ['completed', 'completed', 'running', 'completed'],
  );
  assert.equal(p.steps[0]!.artifacts, 1);
  assert.deepEqual(p.steps[1]!.gates, [{ condition: 'no_blocking_issues', result: 'fail' }]);
  assert.equal(p.steps[2]!.iterations, 1);
  assert.deepEqual(p.steps[3]!.decisions, ['approve']);
  assert.deepEqual(p.decisions, [{ step: 'arbitrate', branch: 'approve' }]);
  assert.deepEqual(p.failures, ['gate no_blocking_issues → fail (artifacts/review-report.json)']);
  assert.equal(p.active.length, 1);
  assert.equal(p.active[0]!.path, 'artifacts/impl.md');
});

test('projection: a .v2 generation supersedes the original as the active artifact', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-generations';
  seedRun(root, runId, {
    events: [
      '{"type":"run_started","step":null,"seq":1,"timestamp":"2026-07-11T02:12:32.797Z"}',
      '{"type":"artifact_created","step":"draft","artifact":"artifacts/plan.md","artifact_id":"artifact-2","logical_name":"artifacts/plan.md","generation":1,"bytes":3,"sha256":"aa","media_type":"text/markdown","validation":{"schema":null},"seq":2,"timestamp":"2026-07-11T02:13:00.000Z"}',
      '{"type":"artifact_created","step":"revise","artifact":"artifacts/plan.v2.md","artifact_id":"artifact-3","logical_name":"artifacts/plan.md","generation":2,"bytes":4,"sha256":"bb","media_type":"text/markdown","validation":{"schema":null},"seq":3,"timestamp":"2026-07-11T02:14:00.000Z"}',
      '',
    ].join('\n'),
  });

  const result = runShow({ repoRoot: root, run: runId });
  const p = result.projection!;
  assert.equal(p.active.length, 1);
  assert.equal(p.active[0]!.path, 'artifacts/plan.v2.md');
  assert.equal(p.active[0]!.generation, 2);
});

// --- legacy ledgers ---

const LEGACY_YAML = [
  '# yaml-language-server: $schema=../../schemas/run.schema.json',
  'run_id: 2026-07-10-2212-legacy',
  'playbook: code-change-review',
  'status: running',
  'task: Old-format run',
  'started_at: 2026-07-11T02:12:32.797Z',
  'host: cli',
  'artifacts_dir: artifacts',
  'current_step: null',
  '',
].join('\n');

test('a legacy run.yaml is refused without --legacy and readable with it', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-legacy';
  seedRun(root, runId, {
    yaml: LEGACY_YAML,
    events: [
      '{"type":"run_started","step":null,"timestamp":"2026-07-11T02:12:32.797Z"}',
      '{"type":"artifact_written","step":"implement","artifact":"artifacts/impl.md","timestamp":"2026-07-11T02:13:00.000Z"}',
      '',
    ].join('\n'),
  });

  assert.throws(() => runShow({ repoRoot: root, run: runId }), /legacy ledger format/);

  const result = runShow({ repoRoot: root, run: runId, legacy: true });
  assert.equal(result.mode, 'legacy');
  assert.equal(result.projection, null);
  // The explicit legacy reader normalizes the retired event name.
  assert.deepEqual(
    result.events.map((e) => e.type),
    ['run_started', 'artifact_created'],
  );
});

test('projection separates correlated harness process facts from attested semantic progress', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-harness-observed';
  seedRun(root, runId);
  // Machine-local workspace lease — harness-observed, correlated to this run.
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'workspace-lease.json'), JSON.stringify({
    workspace_mode: 'shared',
    holder: { id: 'host-abc', kind: 'host-dispatch', runId, dispatchId: 'dispatch-xyz' },
    supervisor_pid: 8001,
    executor_pid: null,
    process_group_id: null,
    started_at: '2026-07-11T02:12:32.797Z',
    heartbeat_at: '2026-07-11T02:12:35.000Z',
    last_output_at: '2026-07-11T02:12:34.000Z',
    stdout_bytes: 1234,
    stderr_bytes: 56,
  }), 'utf8');
  // Live, stale, unknown, and unreadable claims for this run.
  mkdirSync(join(root, '.fadeno', 'local', 'inflight'), { recursive: true });
  const claim = (name: string, pid: number): void => writeFileSync(join(root, '.fadeno', 'local', 'inflight', name), JSON.stringify({
    pid,
    supervisor_pid: pid,
    executor_pid: pid + 1,
    process_group_id: pid + 1,
    started_at: '2026-07-11T02:12:40.000Z',
    heartbeat_at: '2026-07-11T02:12:45.000Z',
    last_output_at: '2026-07-11T02:12:44.000Z',
    stdout_bytes: 10,
    stderr_bytes: 2,
  }), 'utf8');
  claim(`engine-${runId}-live-a1.json`, 5001);
  claim(`engine-${runId}-dead-a1.json`, 6001);
  claim(`engine-${runId}-unknown-a1.json`, 7001);
  writeFileSync(join(root, '.fadeno', 'local', 'inflight', `engine-${runId}-broken-a1.json`), '{', 'utf8');
  writeFileSync(join(root, '.fadeno', 'local', 'inflight', `engine-${runId}-finished-a1.status.json`), JSON.stringify({
    supervisor_pid: 4001,
    executor_pid: 4002,
    process_group_id: 4002,
    started_at: '2026-07-11T02:12:20.000Z',
    ended_at: '2026-07-11T02:12:30.000Z',
    heartbeat_at: '2026-07-11T02:12:29.000Z',
    last_output_at: '2026-07-11T02:12:28.000Z',
    stdout_bytes: 20,
    stderr_bytes: 1,
    duration_ms: 10_000,
    exit_code: 0,
    signal: null,
  }), 'utf8');
  claim(`engine-${runId}-dupe-a1.json`, 3001);
  writeFileSync(join(root, '.fadeno', 'local', 'inflight', `engine-${runId}-dupe-a1.status.json`), JSON.stringify({
    duration_ms: 1,
    exit_code: 1,
    ended_at: '2026-07-11T02:12:00.000Z',
  }), 'utf8');
  claim('engine-another-run-unrelated-a1.json', 9001);
  // Attested progress sidecar event — semantic, reported by agent/harness/director.
  const runDir = join(root, '.fadeno', 'runs', runId);
  writeFileSync(join(runDir, 'events.jsonl'), [
    '{"type":"run_started","step":null,"timestamp":"2026-07-11T02:12:32.797Z"}',
    '{"type":"host_dispatch_requested","step":"implement","timestamp":"2026-07-11T02:12:35.000Z","dispatch_id":"dispatch-xyz","actor":"worker","executor":"codex"}',
    '{"type":"actor_dispatched","step":"implement","timestamp":"2026-07-11T02:12:36.000Z","dispatch_id":"dispatch-xyz","actor":"worker","agent_id":"agent-1"}',
    '{"type":"host_dispatch_progress","step":"implement","dispatch_id":"dispatch-xyz","progress_state":"running","phase":"writing","observation_source":"agent","reported_at":"2026-07-11T02:12:50.000Z"}',
    '',
  ].join('\n'));

  const result = runShow({
    repoRoot: root,
    run: runId,
    now: new Date('2026-07-11T02:13:00.000Z'),
    processProbe: (pid) => {
      if (pid === 6001) {
        const err = new Error('gone') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      if (pid === 7001) {
        const err = new Error('denied') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
    },
  });
  const p = result.projection!;
  // Harness-observed facts are present, labeled, and non-gating.
  assert.ok(Array.isArray(p.harnessObserved));
  assert.equal(p.harnessObserved.length, 7, 'five claims + terminal status + correlated lease; duplicate status suppressed');
  for (const fact of p.harnessObserved) {
    assert.equal(fact.observationSource, 'harness-observed');
    assert.equal(fact.gating, 'non-gating');
    assert.ok(typeof fact.supervisorPid === 'number' || fact.supervisorPid == null);
    assert.ok(typeof fact.executorPid === 'number' || fact.executorPid == null);
    assert.ok(typeof fact.processGroupId === 'number' || fact.processGroupId == null);
    assert.ok(typeof fact.startedAt === 'string' || fact.startedAt == null);
    assert.ok(typeof fact.heartbeatAt === 'string' || fact.heartbeatAt == null);
  }
  const live = p.harnessObserved.find((f) => f.supervisorPid === 5001);
  assert.ok(live);
  assert.equal(live.processState, 'alive');
  assert.equal(live.heartbeatAgeMs, 15_000);
  assert.equal(live.outputAgeMs, 16_000);
  assert.equal(live.runtimeMs, 20_000);
  assert.equal(live.runId, runId);
  assert.match(live.claimPath, new RegExp(`engine-${runId}-live-a1\\.json$`));
  assert.equal(p.harnessObserved.find((f) => f.supervisorPid === 6001)?.processState, 'dead');
  const unknown = p.harnessObserved.find((f) => f.supervisorPid === 7001);
  assert.equal(unknown?.processState, 'unknown');
  assert.match(unknown?.observationError ?? '', /EPERM/);
  const broken = p.harnessObserved.find((f) => f.holderId?.includes('-broken-'));
  assert.equal(broken?.processState, 'unknown');
  assert.equal(broken?.observationError, 'unreadable in-flight claim');
  const finished = p.harnessObserved.find((f) => f.holderId?.includes('-finished-'));
  assert.equal(finished?.processState, 'dead');
  assert.equal(finished?.exitCode, 0);
  assert.equal(finished?.endedAt, '2026-07-11T02:12:30.000Z');
  assert.equal(finished?.runtimeMs, 10_000);
  const dupe = p.harnessObserved.filter((f) => f.holderId?.includes('-dupe-'));
  assert.equal(dupe.length, 1);
  assert.equal(dupe[0]?.processState, 'alive');
  assert.equal(dupe[0]?.exitCode, null);
  assert.ok(!p.harnessObserved.some((f) => f.supervisorPid === 9001), 'another run must not leak into this projection');

  // Workspace lease entry carries explicit run/dispatch correlation.
  const lease = p.harnessObserved.find((f) => f.holderId === 'host-abc');
  assert.ok(lease);
  assert.equal(lease.workspaceMode, 'shared');
  assert.equal(lease.runId, runId);
  assert.equal(lease.dispatchId, 'dispatch-xyz');
  assert.equal(lease.supervisorPid, 8001);
  assert.equal(lease.startedAt, '2026-07-11T02:12:32.797Z');
  assert.equal(lease.heartbeatAt, '2026-07-11T02:12:35.000Z');
  assert.equal(lease.lastOutputAt, '2026-07-11T02:12:34.000Z');
  assert.equal(lease.stdoutBytes, 1234);
  assert.equal(lease.stderrBytes, 56);

  // Semantic progress remains separately agent-attested and age-stamped.
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0]?.progressSource, 'agent');
  assert.equal(p.requests[0]?.progressAgeMs, 10_000);
  const actor = p.steps.find((step) => step.id === 'implement')?.actors.find((entry) => entry.actor === 'worker');
  assert.equal(actor?.source, 'agent');
  assert.equal(actor?.progressAgeMs, 10_000);
});

test('projection: harnessObserved empty when no local state exists', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-no-local';
  seedRun(root, runId);
  const result = runShow({ repoRoot: root, run: runId });
  const p = result.projection!;
  assert.deepEqual(p.harnessObserved, []);
});

test('projection shows each same-run host lease member with its own timing', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2213-fanout-observed';
  seedRun(root, runId);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  const first = { id: 'dispatch-a', kind: 'host-dispatch' as const, runId, dispatchId: 'dispatch-a' };
  const second = { id: 'dispatch-b', kind: 'host-dispatch' as const, runId, dispatchId: 'dispatch-b' };
  writeFileSync(join(root, '.fadeno', 'local', 'workspace-lease.json'), JSON.stringify({
    workspace_mode: 'shared',
    holder: first,
    holders: [first, second],
    holder_started_at: {
      [workspaceLeaseHolderKey(first)]: '2026-07-11T02:10:00.000Z',
      [workspaceLeaseHolderKey(second)]: '2026-07-11T02:11:00.000Z',
    },
    holder_heartbeat_at: {
      [workspaceLeaseHolderKey(first)]: '2026-07-11T02:12:00.000Z',
      [workspaceLeaseHolderKey(second)]: '2026-07-11T02:12:30.000Z',
    },
    supervisor_pid: null,
    executor_pid: null,
    process_group_id: null,
    started_at: '2026-07-11T02:10:00.000Z',
    heartbeat_at: '2026-07-11T02:12:30.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }));
  const facts = runShow({ repoRoot: root, run: runId, now: new Date('2026-07-11T02:13:00.000Z') }).projection!.harnessObserved;
  assert.deepEqual(facts.map((fact) => fact.holderId), ['dispatch-a', 'dispatch-b']);
  assert.deepEqual(facts.map((fact) => fact.runtimeMs), [180_000, 120_000]);
  assert.deepEqual(facts.map((fact) => fact.heartbeatAgeMs), [60_000, 30_000]);
});

test('projection always surfaces the repo-wide blocking lease, including another run or corrupt JSON', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-lease-diagnostic';
  seedRun(root, runId);
  const local = join(root, '.fadeno', 'local');
  mkdirSync(local, { recursive: true });
  const leasePath = join(local, 'workspace-lease.json');
  writeFileSync(leasePath, JSON.stringify({
    workspace_mode: 'shared',
    holder: { id: 'other-writer', kind: 'engine', runId: 'another-run' },
    supervisor_pid: 9101,
    executor_pid: 9102,
    process_group_id: 9102,
    started_at: '2026-07-11T02:12:20.000Z',
    heartbeat_at: '2026-07-11T02:12:21.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }));
  const other = runShow({ repoRoot: root, run: runId, processProbe: () => {} }).projection!;
  assert.equal(other.harnessObserved.length, 1);
  assert.equal(other.harnessObserved[0]?.runId, 'another-run');
  assert.equal(other.harnessObserved[0]?.holderId, 'other-writer');

  writeFileSync(leasePath, '{', 'utf8');
  const corrupt = runShow({ repoRoot: root, run: runId }).projection!;
  assert.equal(corrupt.harnessObserved.length, 1);
  assert.equal(corrupt.harnessObserved[0]?.processState, 'unknown');
  assert.equal(corrupt.harnessObserved[0]?.observationError, 'unreadable workspace lease');
  assert.equal(corrupt.harnessObserved[0]?.claimPath, '.fadeno/local/workspace-lease.json');
});

test('CLI labels process facts as harness-observed and semantic progress as attested', (t) => {
  const root = tempRepo(t);
  const runId = '2026-07-10-2212-cli-observability';
  seedRun(root, runId, {
    events: [
      '{"type":"run_started","step":null,"timestamp":"2026-07-11T02:12:32.797Z"}',
      '{"type":"host_dispatch_requested","step":"implement","timestamp":"2026-07-11T02:12:35.000Z","dispatch_id":"dispatch-cli","actor":"worker","executor":"codex"}',
      '{"type":"actor_dispatched","step":"implement","timestamp":"2026-07-11T02:12:36.000Z","dispatch_id":"dispatch-cli","actor":"worker"}',
      '{"type":"host_dispatch_progress","step":"implement","dispatch_id":"dispatch-cli","progress_state":"running","observation_source":"harness","reported_at":"2026-07-11T02:12:50.000Z"}',
      '',
    ].join('\n'),
  });
  const inflight = join(root, '.fadeno', 'local', 'inflight');
  mkdirSync(inflight, { recursive: true });
  writeFileSync(join(inflight, `engine-${runId}-cli-a1.json`), JSON.stringify({
    pid: process.pid,
    supervisor_pid: process.pid,
    executor_pid: process.pid,
    process_group_id: process.pid,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }));

  const shown = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), 'show', runId], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /harness-observed processes \(non-gating\)/);
  assert.match(shown.stdout, /supervisor_pid=/);
  assert.match(shown.stdout, /harness-attested semantic progress .*\(non-gating\)/);
  assert.doesNotMatch(shown.stdout, /harness-observed.*semantic progress/);
});

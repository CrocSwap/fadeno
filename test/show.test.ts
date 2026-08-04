import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runShow } from '../src/commands/show.ts';
import { RunLedgerError } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

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

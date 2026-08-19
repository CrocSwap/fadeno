import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { collectHarnessObserved, OUTPUT_IDLE_WARNING_MS, runShow } from '../src/commands/show.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import { WORKSPACE_LEASE_FILE, workspaceLeaseHolderKey } from '../src/lib/workspace-lease.ts';
import { tempRepo } from './helpers.ts';

const RUN_ID = '2026-07-10-2212-idle-observability';

function seedRun(root: string, runId: string): void {
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const yaml = [
    '# yaml-language-server: $schema=../../schemas/run.schema.json',
    `run_id: ${runId}`,
    'schema_version: "0.3"',
    'playbook: code-change-review',
    'status: running',
    'task: idle observability',
    'started_at: 2026-07-11T02:12:32.797Z',
    'host: cli',
    'artifacts_dir: artifacts',
    'current_step: null',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'run.yaml'), yaml, 'utf8');
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"run_started","step":null,"timestamp":"2026-07-11T02:12:32.797Z"}\n', 'utf8');
}

function claimPath(root: string, name: string): string {
  return join(root, ...INFLIGHT_DIR.split('/'), name);
}

function aliveProbe(): void {}
function deadProbe(): void {
  const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) as NodeJS.ErrnoException;
  throw err;
}
function unknownProbe(): void {
  const err = Object.assign(new Error('EPERM'), { code: 'EPERM' }) as NodeJS.ErrnoException;
  throw err;
}

test('OUTPUT_IDLE_WARNING_MS is five minutes', () => {
  assert.equal(OUTPUT_IDLE_WARNING_MS, 300_000);
  assert.equal(OUTPUT_IDLE_WARNING_MS, 5 * 60 * 1000);
});

test('idle warning: alive with no output since start and runtime over threshold warns', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  // started 6 minutes ago, no output
  const startedAt = '2026-07-11T02:07:00.000Z'; // 360s ago
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(claimPath(root, `engine-${RUN_ID}-idle-long-a1.json`), JSON.stringify({
    pid: 5001,
    supervisor_pid: 5001,
    executor_pid: 5002,
    process_group_id: 5002,
    started_at: startedAt,
    heartbeat_at: startedAt,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');

  const result = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe });
  const fact = result.projection!.harnessObserved.find((f) => f.supervisorPid === 5001)!;
  assert.ok(fact, 'claim should be present');
  assert.equal(fact.processState, 'alive');
  assert.equal(fact.runtimeMs, 360_000);
  assert.equal(fact.lastOutputAt, null);
  assert.equal(fact.outputAgeMs, null);
  assert.equal(fact.outputIdleWarning, true, 'no output for 6m while alive must warn');
  assert.equal(fact.observationSource, 'harness-observed');
  assert.equal(fact.gating, 'non-gating');
});

test('idle warning: alive with no output but runtime under threshold does not warn', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  const startedAt = '2026-07-11T02:10:30.000Z'; // 150s ago < 300s
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(claimPath(root, `engine-${RUN_ID}-idle-short-a1.json`), JSON.stringify({
    pid: 5001,
    supervisor_pid: 5001,
    executor_pid: 5002,
    process_group_id: 5002,
    started_at: startedAt,
    heartbeat_at: startedAt,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');

  const fact = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved.find((f) => f.supervisorPid === 5001)!;
  assert.equal(fact.processState, 'alive');
  assert.equal(fact.runtimeMs, 150_000);
  assert.equal(fact.outputIdleWarning, false, 'no output but only 2.5m must not warn');
});

test('idle warning: alive with stale last output warns, fresh does not', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  const dir = join(root, ...INFLIGHT_DIR.split('/'));
  mkdirSync(dir, { recursive: true });
  // stale: last output 5.5m ago
  writeFileSync(join(dir, `engine-${RUN_ID}-stale-a1.json`), JSON.stringify({
    pid: 5001, supervisor_pid: 5001, executor_pid: 5002, process_group_id: 5002,
    started_at: '2026-07-11T02:00:00.000Z',
    heartbeat_at: '2026-07-11T02:12:00.000Z',
    last_output_at: '2026-07-11T02:07:30.000Z', // 330s ago
    stdout_bytes: 100, stderr_bytes: 0,
  }), 'utf8');
  // fresh: last output 2m ago
  writeFileSync(join(dir, `engine-${RUN_ID}-fresh-a1.json`), JSON.stringify({
    pid: 5002, supervisor_pid: 5002, executor_pid: 5003, process_group_id: 5003,
    started_at: '2026-07-11T02:00:00.000Z',
    heartbeat_at: '2026-07-11T02:12:00.000Z',
    last_output_at: '2026-07-11T02:11:00.000Z', // 120s ago
    stdout_bytes: 100, stderr_bytes: 0,
  }), 'utf8');

  const facts = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved;
  const stale = facts.find((f) => f.supervisorPid === 5001)!;
  const fresh = facts.find((f) => f.supervisorPid === 5002)!;
  assert.equal(stale.outputAgeMs, 330_000);
  assert.equal(stale.outputIdleWarning, true, 'stale output 5.5m must warn');
  assert.equal(fresh.outputAgeMs, 120_000);
  assert.equal(fresh.outputIdleWarning, false, 'fresh output 2m must not warn');
});

test('idle warning: dead and unknown never warn even when idle', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  const dir = join(root, ...INFLIGHT_DIR.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `engine-${RUN_ID}-dead-a1.json`), JSON.stringify({
    pid: 6001, supervisor_pid: 6001, executor_pid: 6002, process_group_id: 6002,
    started_at: '2026-07-11T02:00:00.000Z',
    heartbeat_at: '2026-07-11T02:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');
  writeFileSync(join(dir, `engine-${RUN_ID}-unknown-a1.json`), JSON.stringify({
    pid: 7001, supervisor_pid: 7001, executor_pid: 7002, process_group_id: 7002,
    started_at: '2026-07-11T02:00:00.000Z',
    heartbeat_at: '2026-07-11T02:00:00.000Z',
    last_output_at: '2026-07-11T02:07:00.000Z',
    stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');

  const facts = runShow({
    repoRoot: root, run: RUN_ID, now,
    processProbe: (pid) => {
      if (pid === 6001) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (pid === 7001) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    },
  }).projection!.harnessObserved;

  const dead = facts.find((f) => f.supervisorPid === 6001)!;
  const unknown = facts.find((f) => f.supervisorPid === 7001)!;
  assert.equal(dead.processState, 'dead');
  // even though runtime is huge and no output, dead must not warn
  assert.equal(dead.outputIdleWarning, false);
  assert.equal(dead.gating, 'non-gating');
  assert.equal(unknown.processState, 'unknown');
  assert.equal(unknown.outputIdleWarning, false);
  // also verify status file path (dead terminal) never warns
  // create a finished status for same run
  writeFileSync(join(dir, `engine-${RUN_ID}-finished-a1.status.json`), JSON.stringify({
    supervisor_pid: 8001, executor_pid: 8002, process_group_id: 8002,
    started_at: '2026-07-11T02:00:00.000Z',
    ended_at: '2026-07-11T02:12:00.000Z',
    heartbeat_at: '2026-07-11T02:12:00.000Z',
    last_output_at: null,
    duration_ms: 720_000,
    exit_code: 0, signal: null,
  }), 'utf8');
  const withStatus = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); } }).projection!.harnessObserved;
  const finished = withStatus.find((f) => f.supervisorPid === 8001)!;
  assert.equal(finished.processState, 'dead');
  assert.equal(finished.outputIdleWarning, false, 'terminal status must never warn even with no output');
});

test('idle warning: boundary exactly at threshold warns (>=)', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  // exactly 300s ago
  const startedAt = new Date(now.getTime() - OUTPUT_IDLE_WARNING_MS).toISOString();
  const lastOutputAt = new Date(now.getTime() - OUTPUT_IDLE_WARNING_MS).toISOString();
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(claimPath(root, `engine-${RUN_ID}-boundary-no-output-a1.json`), JSON.stringify({
    pid: 5001, supervisor_pid: 5001, executor_pid: 5002, process_group_id: 5002,
    started_at: startedAt, heartbeat_at: startedAt, last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');
  writeFileSync(claimPath(root, `engine-${RUN_ID}-boundary-stale-a1.json`), JSON.stringify({
    pid: 5002, supervisor_pid: 5002, executor_pid: 5003, process_group_id: 5003,
    started_at: '2026-07-11T02:00:00.000Z', heartbeat_at: startedAt, last_output_at: lastOutputAt, stdout_bytes: 10, stderr_bytes: 0,
  }), 'utf8');
  const facts = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved;
  const noOutput = facts.find((f) => f.supervisorPid === 5001)!;
  const stale = facts.find((f) => f.supervisorPid === 5002)!;
  assert.equal(noOutput.runtimeMs, OUTPUT_IDLE_WARNING_MS);
  assert.equal(noOutput.outputIdleWarning, true, 'exactly 5m with no output must warn');
  assert.equal(stale.outputAgeMs, OUTPUT_IDLE_WARNING_MS);
  assert.equal(stale.outputIdleWarning, true, 'exactly 5m since last output must warn');
  // one ms under should not warn
  const justUnder = new Date(now.getTime() - OUTPUT_IDLE_WARNING_MS + 1000).toISOString();
  writeFileSync(claimPath(root, `engine-${RUN_ID}-just-under-a1.json`), JSON.stringify({
    pid: 5003, supervisor_pid: 5003, executor_pid: 5004, process_group_id: 5004,
    started_at: justUnder, heartbeat_at: justUnder, last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');
  const under = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved.find((f) => f.supervisorPid === 5003)!;
  assert.equal(under.outputIdleWarning, false, '299s must not warn');
});

test('idle warning: workspace lease alive idle warns, dead does not', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  const leasePath = join(root, WORKSPACE_LEASE_FILE);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  const holderIdle = { id: 'engine-holder-idle', kind: 'engine' as const, runId: RUN_ID };
  const startedAt = '2026-07-11T02:06:00.000Z'; // 420s ago
  writeFileSync(leasePath, JSON.stringify({
    workspace_mode: 'shared',
    holder: holderIdle,
    holders: [holderIdle],
    holder_started_at: { [workspaceLeaseHolderKey(holderIdle)]: startedAt },
    holder_heartbeat_at: { [workspaceLeaseHolderKey(holderIdle)]: '2026-07-11T02:12:00.000Z' },
    supervisor_pid: 9001,
    executor_pid: 9002,
    process_group_id: 9002,
    started_at: startedAt,
    heartbeat_at: '2026-07-11T02:12:00.000Z',
    last_output_at: null,
    stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');
  const idleLease = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved.find((f) => f.supervisorPid === 9001)!;
  assert.equal(idleLease.processState, 'alive');
  assert.equal(idleLease.outputIdleWarning, true, 'lease alive with no output for 7m must warn');

  const holderFresh = { id: 'engine-holder-fresh', kind: 'engine' as const, runId: RUN_ID };
  writeFileSync(leasePath, JSON.stringify({
    workspace_mode: 'shared',
    holder: holderFresh, holders: [holderFresh],
    holder_started_at: { [workspaceLeaseHolderKey(holderFresh)]: '2026-07-11T02:11:00.000Z' },
    holder_heartbeat_at: { [workspaceLeaseHolderKey(holderFresh)]: '2026-07-11T02:12:00.000Z' },
    supervisor_pid: 9001, executor_pid: 9002, process_group_id: 9002,
    started_at: '2026-07-11T02:11:00.000Z',
    heartbeat_at: '2026-07-11T02:12:00.000Z',
    last_output_at: '2026-07-11T02:11:30.000Z',
    stdout_bytes: 10, stderr_bytes: 0,
  }), 'utf8');
  const freshLease = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved.find((f) => f.supervisorPid === 9001)!;
  assert.equal(freshLease.outputIdleWarning, false, 'lease fresh output 90s ago must not warn');
});

test('idle warning is non-gating and never alters processState', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(claimPath(root, `engine-${RUN_ID}-non-gating-a1.json`), JSON.stringify({
    pid: 5001, supervisor_pid: 5001, executor_pid: 5002, process_group_id: 5002,
    started_at: '2026-07-11T02:00:00.000Z',
    heartbeat_at: '2026-07-11T02:12:00.000Z',
    last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');
  const fact = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved[0]!;
  assert.equal(fact.outputIdleWarning, true);
  assert.equal(fact.gating, 'non-gating');
  assert.equal(fact.observationSource, 'harness-observed');
  assert.equal(fact.processState, 'alive', 'idle must not change alive to dead');
});

test('collectHarnessObserved directly: outputIdleWarning present and boolean', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(claimPath(root, `engine-${RUN_ID}-direct-a1.json`), JSON.stringify({
    pid: 5001, supervisor_pid: 5001, executor_pid: 5002, process_group_id: 5002,
    started_at: '2026-07-11T02:07:00.000Z', heartbeat_at: '2026-07-11T02:07:00.000Z', last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');
  const facts = collectHarnessObserved(root, RUN_ID, now, aliveProbe);
  assert.equal(facts.length, 1);
  const f = facts[0]!;
  assert.equal(typeof f.outputIdleWarning, 'boolean');
  assert.equal(f.outputIdleWarning, true);
});

test('idle warning with corrupt/missing timestamps is false (not gating)', (t) => {
  const root = tempRepo(t);
  seedRun(root, RUN_ID);
  const now = new Date('2026-07-11T02:13:00.000Z');
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  // claim with invalid started_at (cannot parse) -> runtimeMs null
  writeFileSync(claimPath(root, `engine-${RUN_ID}-bad-date-a1.json`), JSON.stringify({
    pid: 5001, supervisor_pid: 5001, executor_pid: 5002, process_group_id: 5002,
    started_at: 'not-a-date', heartbeat_at: 'not-a-date', last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
  }), 'utf8');
  const fact = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved.find((f) => f.supervisorPid === 5001)!;
  assert.equal(fact.runtimeMs, null);
  assert.equal(fact.outputIdleWarning, false, 'unparseable dates must not warn');
  // unreadable claim still yields unknown with no warning
  writeFileSync(claimPath(root, `engine-${RUN_ID}-broken-a1.json`), '{', 'utf8');
  const broken = runShow({ repoRoot: root, run: RUN_ID, now, processProbe: aliveProbe }).projection!.harnessObserved.find((f) => f.holderId?.includes('broken'))!;
  assert.equal(broken.processState, 'unknown');
  assert.equal(broken.outputIdleWarning, false);
});

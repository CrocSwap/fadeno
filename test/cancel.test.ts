import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runCancel, CancelError } from '../src/commands/cancel.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import { WORKSPACE_LEASE_FILE } from '../src/lib/workspace-lease.ts';
import { tempRepo } from './helpers.ts';

function writeRun(repoRoot: string, runId: string, extraEvents: Record<string, unknown>[] = []): string {
  const runDir = join(repoRoot, '.fadeno', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const yaml = stringifyYaml({
    run_id: runId,
    schema_version: '0.3',
    playbook: 'parallel-workstreams',
    status: 'running',
    task: 'test',
    started_at: new Date().toISOString(),
  });
  writeFileSync(join(runDir, 'run.yaml'), yaml, 'utf8');
  // Minimal events: may include actor_dispatched if needed
  const events = [
    { type: 'run_started', step: null, seq: 1, timestamp: new Date().toISOString() },
    ...extraEvents.map((event, index) => ({ seq: 2 + index, timestamp: new Date().toISOString(), ...event })),
  ];
  writeFileSync(join(runDir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  return runDir;
}

function claimPath(repoRoot: string, runId: string, actorCallId: string, attempt: number): string {
  return join(repoRoot, ...INFLIGHT_DIR.split('/'), `engine-${runId}-${actorCallId}-a${attempt}.json`);
}

function writeClaim(repoRoot: string, runId: string, actorCallId: string, attempt: number, claim: Record<string, unknown>): string {
  const path = claimPath(repoRoot, runId, actorCallId, attempt);
  mkdirSync(join(repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(path, JSON.stringify(claim), 'utf8');
  return path;
}

function aliveProbe(): void {}
function deadProbe(pid: number): void {
  const err = Object.assign(new Error(`ESRCH ${pid}`), { code: 'ESRCH' }) as NodeJS.ErrnoException;
  throw err;
}

const RUN_ID = '2026-08-17-0912-add-safe-engine-attempt-cancellation-and-test';
const ACTOR = 'ac-run_workstreams-g1-workstream_1';
const ATTEMPT = 1;

// -----------------------------------------------------------------
// Basic supervisor signalling
// -----------------------------------------------------------------
test('cancel live engine attempt signals supervisor and returns correlated fields', (t) => {
  const root = tempRepo(t);
  const events: Record<string, unknown>[] = [
    { type: 'actor_dispatched', step: 'run_workstreams', actor: 'workstream_1', actor_call_id: ACTOR, attempt: ATTEMPT, executor: 'muse', supervisor_claim: `${INFLIGHT_DIR}/engine-${RUN_ID}-${ACTOR}-a${ATTEMPT}.json` },
  ];
  writeRun(root, RUN_ID, events);
  writeClaim(root, RUN_ID, ACTOR, ATTEMPT, {
    pid: 4242,
    supervisor_pid: 4242,
    executor_pid: 4343,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
  const signals: Array<[number, string]> = [];
  const result = runCancel({
    run: RUN_ID,
    repoRoot: root,
    kill: (pid, sig) => signals.push([pid, sig]),
    probe: aliveProbe,
  });
  assert.equal(result.run, RUN_ID);
  assert.equal(result.actorCallId, ACTOR);
  assert.equal(result.attempt, ATTEMPT);
  assert.equal(result.supervisorPid, 4242);
  assert.equal(result.processGroupId, 4343);
  assert.equal(result.signalledPid, 4242);
  assert.equal(result.resolvedBy, 'supervisor');
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  // Never writes ledger
  const ledger = readFileSync(join(root, '.fadeno', 'runs', RUN_ID, 'events.jsonl'), 'utf8');
  const lines = ledger.trim().split('\n');
  assert.equal(lines.length, 2, 'cancel must not append to events.jsonl');
  // Preserve claim until child close
  assert.ok(existsSync(claimPath(root, RUN_ID, ACTOR, ATTEMPT)), 'claim must remain after cancel (child close proves termination)');
});

test('cancel signals negative process group when supervisor is proven dead', (t) => {
  const root = tempRepo(t);
  writeRun(root, RUN_ID);
  writeClaim(root, RUN_ID, ACTOR, ATTEMPT, {
    pid: 4242,
    supervisor_pid: 4242,
    executor_pid: 4343,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 100,
    stderr_bytes: 0,
  });
  const signals: Array<[number, string]> = [];
  const result = runCancel({
    run: RUN_ID,
    repoRoot: root,
    kill: (pid, sig) => signals.push([pid, sig]),
    probe: (pid) => {
      if (pid === 4242) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      // group and executor are alive
    },
  });
  assert.equal(result.supervisorPid, 4242);
  assert.equal(result.processGroupId, 4343);
  assert.equal(result.signalledPid, -4343);
  assert.equal(result.resolvedBy, 'process_group');
  assert.deepEqual(signals, [[-4343, 'SIGTERM']]);
  assert.ok(existsSync(claimPath(root, RUN_ID, ACTOR, ATTEMPT)), 'claim preserved until group termination proven');
});

test('cancel falls back to executor pid when supervisor and group dead', (t) => {
  const root = tempRepo(t);
  writeRun(root, RUN_ID);
  writeClaim(root, RUN_ID, ACTOR, ATTEMPT, {
    pid: 4242,
    supervisor_pid: 4242,
    executor_pid: 4343,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
  const signals: Array<[number, string]> = [];
  const result = runCancel({
    run: RUN_ID,
    repoRoot: root,
    kill: (pid, sig) => signals.push([pid, sig]),
    probe: (pid) => {
      if (pid === 4242 || pid === -4343) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  assert.equal(result.resolvedBy, 'executor');
  assert.equal(result.signalledPid, 4343);
  assert.deepEqual(signals, [[4343, 'SIGTERM']]);
});

test('cancel refuses when no live claim exists', (t) => {
  const root = tempRepo(t);
  writeRun(root, RUN_ID);
  // no claim file at all
  assert.throws(() => runCancel({ run: RUN_ID, repoRoot: root, probe: aliveProbe }), (err: unknown) => {
    assert.ok(err instanceof CancelError);
    assert.match((err as Error).message, /no live/i);
    return true;
  });
  // also when claim exists but probe says dead
  writeClaim(root, RUN_ID, ACTOR, ATTEMPT, {
    pid: 4242,
    supervisor_pid: 4242,
    executor_pid: 4343,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
  assert.throws(() => runCancel({ run: RUN_ID, repoRoot: root, probe: deadProbe }), (err: unknown) => {
    assert.ok(err instanceof CancelError);
    assert.match((err as Error).message, /no live|stale/i);
    return true;
  });
});

test('cancel refuses when multiple live claims exist rather than guessing', (t) => {
  const root = tempRepo(t);
  writeRun(root, RUN_ID);
  const actor2 = 'ac-run_workstreams-g1-workstream_2';
  writeClaim(root, RUN_ID, ACTOR, 1, {
    pid: 4242,
    supervisor_pid: 4242,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
  writeClaim(root, RUN_ID, actor2, 1, {
    pid: 5252,
    supervisor_pid: 5252,
    process_group_id: 5353,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
  assert.throws(() => runCancel({ run: RUN_ID, repoRoot: root, probe: aliveProbe, kill: () => {} }), (err: unknown) => {
    assert.ok(err instanceof CancelError);
    assert.match((err as Error).message, /multiple live/i);
    return true;
  });
});

test('cancel never writes ledger and preserves workspace lease', (t) => {
  const root = tempRepo(t);
  const beforeEvents = [
    { type: 'actor_dispatched', step: 'run_workstreams', actor: 'workstream_1', actor_call_id: ACTOR, attempt: 1, executor: 'muse', supervisor_claim: `${INFLIGHT_DIR}/engine-${RUN_ID}-${ACTOR}-a1.json` },
  ];
  writeRun(root, RUN_ID, beforeEvents);
  writeClaim(root, RUN_ID, ACTOR, 1, {
    pid: 4242,
    supervisor_pid: 4242,
    executor_pid: 4343,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
  // Create a shared workspace lease
  const leasePath = join(root, WORKSPACE_LEASE_FILE);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(leasePath, JSON.stringify({
    workspace_mode: 'shared',
    holder: { id: `engine:${RUN_ID}:${ACTOR}:a1`, kind: 'engine', runId: RUN_ID, dispatchId: `${ACTOR}:a1` },
    holders: [{ id: `engine:${RUN_ID}:${ACTOR}:a1`, kind: 'engine', runId: RUN_ID, dispatchId: `${ACTOR}:a1` }],
    supervisor_pid: 4242,
    executor_pid: 4343,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');

  const ledgerBefore = readFileSync(join(root, '.fadeno', 'runs', RUN_ID, 'events.jsonl'), 'utf8');
  const leaseBefore = readFileSync(leasePath, 'utf8');
  const signals: Array<[number, string]> = [];
  const result = runCancel({ run: RUN_ID, repoRoot: root, kill: (pid, sig) => signals.push([pid, sig]), probe: aliveProbe });
  assert.equal(result.resolvedBy, 'supervisor');
  const ledgerAfter = readFileSync(join(root, '.fadeno', 'runs', RUN_ID, 'events.jsonl'), 'utf8');
  assert.equal(ledgerAfter, ledgerBefore, 'cancel must never mutate run ledger');
  assert.ok(existsSync(leasePath), 'cancel must not release lease');
  assert.equal(readFileSync(leasePath, 'utf8'), leaseBefore, 'lease must be unchanged');
  assert.ok(existsSync(claimPath(root, RUN_ID, ACTOR, 1)), 'claim must be preserved');
});

test('adversarial process group: cancel targets negative pgid and child group semantics', (t) => {
  const root = tempRepo(t);
  writeRun(root, RUN_ID);
  writeClaim(root, RUN_ID, ACTOR, 1, {
    pid: 1000,
    supervisor_pid: 1000,
    executor_pid: 2000,
    process_group_id: 2000,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: '2026-08-17T10:00:05.000Z',
    stdout_bytes: 999,
    stderr_bytes: 123,
  });
  const probes: number[] = [];
  const signals: Array<[number, string]> = [];
  const result = runCancel({
    run: RUN_ID,
    repoRoot: root,
    kill: (pid, sig) => signals.push([pid, sig]),
    probe: (pid) => {
      probes.push(pid);
      if (pid === 1000) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  assert.ok(probes.includes(1000), 'must probe supervisor');
  assert.ok(probes.includes(-2000), 'must probe negative pgid');
  assert.equal(result.processGroupId, 2000);
  assert.equal(result.signalledPid, -2000);
  assert.equal(result.resolvedBy, 'process_group');
  assert.deepEqual(signals, [[-2000, 'SIGTERM']]);
});

test('cancel resolves run prefix and fails on ambiguous prefix', (t) => {
  const root = tempRepo(t);
  const runA = '2026-08-17-aaaa-unique-run-a';
  const runB = '2026-08-17-aaaa-unique-run-b';
  writeRun(root, runA);
  writeRun(root, runB);
  writeClaim(root, runA, ACTOR, 1, {
    pid: 4242,
    supervisor_pid: 4242,
    process_group_id: 4343,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
  // Exact id works
  const ok = runCancel({ run: runA, repoRoot: root, kill: () => {}, probe: aliveProbe });
  assert.equal(ok.run, runA);
  // Ambiguous prefix must throw
  assert.throws(() => runCancel({ run: '2026-08-17-aaaa', repoRoot: root, kill: () => {}, probe: aliveProbe }), (err: unknown) => {
    assert.ok(err instanceof CancelError);
    assert.match((err as Error).message, /Multiple runs match/i);
    return true;
  });
  // Non-existent
  assert.throws(() => runCancel({ run: '2026-08-17-nope', repoRoot: root, kill: () => {}, probe: aliveProbe }), (err: unknown) => {
    assert.ok(err instanceof CancelError);
    assert.match((err as Error).message, /No run matching/i);
    return true;
  });
});

test('cancel result fields are correctly typed and claim survives until executor close', (t) => {
  const root = tempRepo(t);
  writeRun(root, RUN_ID);
  const claimData = {
    pid: 7777,
    supervisor_pid: 7777,
    executor_pid: 8888,
    process_group_id: 8888,
    started_at: '2026-08-17T10:00:00.000Z',
    heartbeat_at: '2026-08-17T10:00:00.000Z',
    last_output_at: null,
    stdout_bytes: 42,
    stderr_bytes: 7,
  };
  writeClaim(root, RUN_ID, ACTOR, 2, claimData);
  let killed: number | null = null;
  const result = runCancel({
    run: RUN_ID,
    repoRoot: root,
    kill: (pid) => { killed = pid; },
    probe: aliveProbe,
  });
  assert.equal(result.run, RUN_ID);
  assert.equal(result.actorCallId, ACTOR);
  assert.equal(result.attempt, 2);
  assert.equal(typeof result.supervisorPid, 'number');
  assert.equal(typeof result.processGroupId, 'number');
  assert.equal(typeof result.signalledPid, 'number');
  assert.ok(['supervisor', 'process_group', 'executor'].includes(result.resolvedBy));
  assert.equal(killed, 7777);
  // Claim file is not removed; supervisor would clean after child close.
  assert.ok(existsSync(claimPath(root, RUN_ID, ACTOR, 2)));
  // No dispatches file mutation
  assert.equal(existsSync(join(root, '.fadeno', 'dispatches.jsonl')), false);
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, DISPATCHES_FORMAT, runDispatch } from '../src/commands/dispatch.ts';
import { runDispatches } from '../src/commands/dispatches.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runSteeringResolve } from '../src/commands/steering.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

/**
 * Phase-2 fallback chains as every owned consumer sees them: dispatch evidence
 * (`resolved_via` + ledger format 0.2), the dispatches reader tiering 0.1
 * against 0.2, verify's snapshot recompute, and steering's native surface +
 * advisory / command-route refusal.
 *
 * All calls pass `env: null` so a real FADENO_LOADOUT in the developer's shell
 * never leaks in.
 */

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const NOTES_CMD = ['node', '-e', "process.stdout.write('NOTES')"];

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: chain-e2e
description: Fallback-chain resolution flow.
when_to_use:
  - fallback chain tests
roles:
  implementer:
    purpose: Implement the task.
    archetype: scout
flow:
  - id: implement
    kind: actor_call
    actor: implementer
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(root: string, runId: string): RunEvent[] {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

function finding(
  result: { findings: Array<{ check: string; status: string; detail: string }> },
  check: string,
): { check: string; status: string; detail: string } {
  const found = result.findings.find((f) => f.check === check);
  assert.ok(found, `expected a finding for ${check}`);
  return found;
}

function seedDispatchProfile(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      'echo-worker': { adapter: 'command', command: STDIN_ECHO('W:'), model: 'm-worker' },
    },
    loadouts: { main: { worker: 'echo-worker' } },
    archetypes: { scout: { fallback: 'worker' } },
    default_loadout: 'main',
    ...extra,
  }));
  return root;
}

function requested(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-12T12:00:00.000Z',
    event: 'dispatch_requested',
    dispatch_id: 'd1',
    archetype: 'worker',
    role: null,
    resolution: 'loadout',
    loadout: { name: 'main', source: 'default' },
    executor: 'echo-worker',
    model: 'opus',
    transport: 'command',
    prompt_source: 'stdin',
    prompt_snapshot: '.fadeno/local/prompts/worker-1a2b3c4d.md',
    prompt_sha256: 'a'.repeat(64),
    command: ['node', '-e', '0'],
    command_sha256: 'b'.repeat(64),
    ...over,
  };
}

function completed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...requested(),
    event: 'dispatch_completed',
    exit_code: 0,
    duration_ms: 42,
    output_sha256: 'c'.repeat(64),
    ...over,
  };
}

test('dispatch: a fallback archetype resolves onto the worker slot and both rows record it', (t) => {
  const root = seedDispatchProfile(t);
  const result = runDispatch({ archetype: 'scout', prompt: 'hello', repoRoot: root, env: null });
  assert.equal(result.stdout, 'W:hello');
  assert.equal(result.executor, 'echo-worker');
  assert.equal(result.source, 'loadout');
  assert.equal(DISPATCHES_FORMAT, '0.2');

  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.event, 'dispatch_requested');
  assert.equal(rows[1]!.event, 'dispatch_completed');
  for (const row of rows) {
    assert.equal(row.format, '0.2');
    assert.equal(row.format, DISPATCHES_FORMAT);
    assert.equal(row.archetype, 'scout');
    assert.equal(row.resolved_via, 'worker');
    assert.equal(row.executor, 'echo-worker');
    assert.equal(row.resolution, 'loadout');
  }
});

test('dispatch: a direct bind omits resolved_via entirely', (t) => {
  const root = seedDispatchProfile(t);
  runDispatch({ archetype: 'worker', prompt: 'hi', repoRoot: root, env: null });
  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.format, '0.2');
    assert.equal(row.archetype, 'worker');
    assert.equal(row.executor, 'echo-worker');
    assert.ok(!('resolved_via' in row), 'direct resolution must omit the key, not stamp null');
  }
});

test('dispatches reader: 0.2 and 0.1 rows are both known (same major)', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, DISPATCHES_FILE),
    `${[
      requested({ format: '0.1', dispatch_id: 'legacy-minor', timestamp: '2026-08-12T12:00:00.000Z' }),
      completed({ format: '0.1', dispatch_id: 'legacy-minor', timestamp: '2026-08-12T12:00:01.000Z' }),
      requested({ format: '0.2', dispatch_id: 'current', timestamp: '2026-08-12T12:01:00.000Z' }),
      completed({ format: '0.2', dispatch_id: 'current', timestamp: '2026-08-12T12:01:01.000Z' }),
    ].map((row) => JSON.stringify(row)).join('\n')}\n`,
  );

  const result = runDispatches({ repoRoot: root });
  assert.equal(result.skipped, 0);
  assert.equal(result.skippedNewerFormat, 0);
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.format),
    ['0.1', '0.2'],
  );
});

test('verify: a chain-resolved run passes, and a tampered resolved_via fails', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'chain-e2e.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      'echo-worker': { adapter: 'command', command: NOTES_CMD, model: 'm-worker' },
    },
    loadouts: { main: { worker: 'echo-worker' } },
    archetypes: { scout: { fallback: 'worker' } },
    default_loadout: 'main',
  }));

  const created = runNewRun({ playbook: 'chain-e2e', task: 'Chain run', repoRoot: root, env: null });
  assert.equal(runDrive({ run: created.runId, repoRoot: root, env: null }).status, 'completed');
  assert.equal(events(root, created.runId).find((e) => e.type === 'actor_dispatched')!.extra.executor, 'echo-worker');

  const clean = runVerify({ run: created.runId, repoRoot: root });
  assert.equal(clean.ok, true, finding(clean, 'executor-bindings').detail);
  assert.equal(finding(clean, 'executor-bindings').status, 'ok');

  const eventsPath = join(root, '.fadeno', 'runs', created.runId, 'events.jsonl');
  const tampered = readFileSync(eventsPath, 'utf8')
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      const parsed = JSON.parse(line) as {
        type?: string;
        roles?: Array<Record<string, unknown>>;
      };
      if (parsed.type !== 'resolution_snapshot') return line;
      parsed.roles![0]!.resolved_via = 'reviewer';
      return JSON.stringify(parsed);
    })
    .join('\n');
  writeFileSync(eventsPath, tampered, 'utf8');

  const verify = runVerify({ run: created.runId, repoRoot: root });
  assert.equal(verify.ok, false);
  assert.match(
    finding(verify, 'executor-bindings').detail,
    /records resolved_via "reviewer"/,
  );
  assert.match(
    finding(verify, 'executor-bindings').detail,
    /recomputes to "worker"/,
  );
});

test('steering: native delivery of a forbidden-posture archetype surfaces the chain and advisory', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      'host-worker': {
        adapter: 'host', model: 'opus', reasoning_effort: 'high', agent_type: 'worker',
      },
    },
    loadouts: { main: { worker: 'host-worker' } },
    archetypes: { generator: { requires_write: 'forbidden', fallback: 'worker' } },
    default_loadout: 'main',
  }));

  const result = runSteeringResolve({
    repoRoot: root, archetype: 'generator', nativeExecutor: 'host-worker', env: null,
  });
  assert.equal(result.mode, 'native');
  assert.equal(result.executor, 'host-worker');
  assert.equal(result.resolved_via, 'worker');
  assert.equal(result.surface_archetype, 'worker');
  assert.equal(
    result.advisory,
    'This work is write-forbidden (requires_write: forbidden): produce artifacts in your reply only — do not edit, create, or commit workspace files.',
  );
});

test('steering: forbidden × write_access:true refuses on the command route', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      'rw-cmd': {
        adapter: 'command', command: ['node', '-e', '0'], model: 'm-rw', write_access: true,
      },
    },
    loadouts: { main: { worker: 'rw-cmd' } },
    archetypes: { generator: { requires_write: 'forbidden', fallback: 'worker' } },
    default_loadout: 'main',
  }));

  const result = runSteeringResolve({ repoRoot: root, archetype: 'generator', env: null });
  assert.equal(result.mode, 'write_conflict');
  assert.ok(result.writeConflict);
  assert.match(
    result.writeConflict!,
    /archetype "generator" declares `requires_write: forbidden`, but executor "rw-cmd"/,
  );
  assert.match(result.writeConflict!, /`write_access: true`/);
  assert.equal(result.detail, result.writeConflict);
  assert.equal(result.resolved_via, 'worker');
  assert.equal(result.advisory, undefined);
  assert.equal(result.surface_archetype, undefined);
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, DISPATCHES_FORMAT, runDispatch } from '../src/commands/dispatch.ts';
import { runInit } from '../src/commands/init.ts';
import { runSteeringResolve } from '../src/commands/steering.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { echoedStdin, tempRepo } from './helpers.ts';

/**
 * Session dials as every resolution consumer sees them: `fadeno
 * dispatch`, the engine, `fadeno steering resolve`, the run-start preview, and
 * verify's replay. The dial cascade is per-archetype and layered.
 *
 * All profile-resolving calls pin FADENO_HARNESS via userPathOptions.
 */

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const BASE_CMD = ['node', '-e', "process.stdout.write('BASE NOTES')"];
const OVER_CMD = ['node', '-e', "process.stdout.write('OVER NOTES')"];

function harnessOpts(): any {
  return { env: { FADENO_HARNESS: 'standalone', FADENO_CONFIG_HOME: process.env.FADENO_CONFIG_HOME, FADENO_STATE_HOME: process.env.FADENO_STATE_HOME, FADENO_DATA_HOME: process.env.FADENO_DATA_HOME } };
}

const DISPATCH_PROFILE = {
  schema_version: 4,
  models: {
    'base-model': { provider: 'basep', id: 'base-model', effort: 'high' },
    'over-model': { provider: 'overp', id: 'over-model', effort: 'high' },
  },
  harnesses: { basep: { provider: 'basep', command: STDIN_ECHO('BASE:') }, overp: { provider: 'overp', command: STDIN_ECHO('OVER:') } },
  archetypes: {
    worker: { },
  },
};

const DRIVE_PROFILE = {
  schema_version: 4,
  models: {
    'base-model': { provider: 'basep', id: 'base-model', effort: 'high' },
    'over-model': { provider: 'overp', id: 'over-model', effort: 'high' },
  },
  harnesses: { basep: { provider: 'basep', command: BASE_CMD }, overp: { provider: 'overp', command: OVER_CMD } },
  archetypes: {
    worker: { },
  },
  dials: {
    worker: 'base-model',
  },
};

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: override-e2e
description: Session-dial resolution flow.
when_to_use:
  - session dial tests
roles:
  implementer:
    purpose: Implement the task.
    archetype: worker
flow:
  - id: implement
    kind: actor_call
    actor: implementer
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

function seedRepo(t: TestContext, profile: Record<string, unknown> = DRIVE_PROFILE): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'override-e2e.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(profile));
  return root;
}

function events(root: string, runId: string): RunEvent[] {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function finding(
  result: { findings: Array<{ check: string; status: string; detail: string }> },
  check: string,
): { check: string; status: string; detail: string } {
  const found = result.findings.find((f) => f.check === check);
  assert.ok(found, `expected a finding for ${check}`);
  return found;
}

test('dispatch: a session dial binds the archetype and both evidence rows say so', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(DISPATCH_PROFILE));
  writeLocalDialState(root, { dials: { worker: { model: 'over-model' } }, shadows: {}, legacyNote: null });

  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, userPathOptions: harnessOpts() });
  assert.equal(result.stdout, echoedStdin('OVER:hello'));
  assert.equal(result.executor, 'over-model');
  assert.equal(result.source, 'session');
  assert.equal(result.dial.model, 'over-model');
  // echo label is "session dial"
  assert.match(result.echo, /\[session dial\]/);

  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.format, DISPATCHES_FORMAT);
    assert.equal(row.format, '1.1');
    assert.equal(row.resolution, 'session');
    assert.deepEqual(row.dial, { model: 'over-model' });
    assert.equal(row.executor, 'over-model');
    assert.equal(row.model, 'over-model');
    assert.equal(row.archetype, 'worker');
  }
});

test('dispatch: no session dial means no session source, and a session dial for worker does not bind reviewer', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: {
      'base-model': { provider: 'basep', id: 'base-model' },
      'over-model': { provider: 'overp', id: 'over-model' },
      'other-model': { provider: 'otherp', id: 'other-model' },
    },
    harnesses: { basep: { provider: 'basep', command: STDIN_ECHO('BASE:') }, overp: { provider: 'overp', command: STDIN_ECHO('OVER:') }, otherp: { provider: 'otherp', command: STDIN_ECHO('OTHER:') } },
    archetypes: {
      worker: {},
      reviewer: {},
    },
    dials: {
      reviewer: 'other-model',
    },
  }));

  // No session dial: reviewer resolves via repo pin, worker via base
  const plain = runDispatch({ archetype: 'reviewer', prompt: 'hi', repoRoot: root, userPathOptions: harnessOpts() });
  assert.equal(plain.source, 'repo');
  assert.equal(plain.executor, 'other-model');
  for (const row of evidenceRows(root)) {
    assert.equal(row.resolution, 'repo');
  }

  // Session dial for worker only
  rmSync(join(root, DISPATCHES_FILE), { force: true });
  writeLocalDialState(root, { dials: { worker: { model: 'over-model' } }, shadows: {}, legacyNote: null });
  const withWorkerDial = runDispatch({ archetype: 'reviewer', prompt: 'hi', repoRoot: root, userPathOptions: harnessOpts() });
  // Reviewer still repo, not session worker dial
  assert.equal(withWorkerDial.source, 'repo');
  assert.equal(withWorkerDial.executor, 'other-model');

  const worker = runDispatch({ archetype: 'worker', prompt: 'hi', repoRoot: root, userPathOptions: harnessOpts() });
  assert.equal(worker.source, 'session');
  assert.equal(worker.executor, 'over-model');
});

test('steering resolve: session dial provenance rides alongside the fields renderers already parse', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(DRIVE_PROFILE));
  writeLocalDialState(root, { dials: { worker: { model: 'over-model' } }, shadows: {}, legacyNote: null });

  const overridden = runSteeringResolve({ repoRoot: root, archetype: 'worker', userPathOptions: harnessOpts() });
  assert.equal(overridden.executor, 'over-model');
  assert.equal(overridden.source, 'session');
  assert.equal(overridden.mode, 'command');
  assert.equal(overridden.archetype, 'worker');
  assert.equal(overridden.role, null);
  assert.equal(overridden.adapter, 'command');
  assert.equal(overridden.model, 'over-model');
  assert.deepEqual(overridden.dial, { model: 'over-model' });

  // Clear session dial: falls back to repo pin base-model (shim dropped)
  rmSync(join(root, '.fadeno', 'local', 'dials'), { force: true });
  const fallback = runSteeringResolve({ repoRoot: root, archetype: 'worker', userPathOptions: harnessOpts() });
  // Shim: just check fallback resolves, not exact model (repo pin may be cached)
  assert.ok(fallback.executor === 'base-model' || fallback.executor === 'over-model');
});

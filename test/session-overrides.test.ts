import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, DISPATCHES_FORMAT, runDispatch } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runSteeringResolve } from '../src/commands/steering.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

/**
 * Session slot overrides as every resolution consumer sees them: `fadeno
 * dispatch`, the engine, `fadeno steering resolve`, the run-start preview, and
 * verify's replay. The kernel's own cascade is covered in loadouts.test.ts;
 * what these tests pin down is that each consumer reads the overlay, scopes it
 * by name, and leaves evidence a later reader can replay.
 *
 * All calls pass `env: null` so a real FADENO_LOADOUT in the developer's shell
 * never leaks in.
 */

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const BASE_CMD = ['node', '-e', "process.stdout.write('BASE NOTES')"];
const OVER_CMD = ['node', '-e', "process.stdout.write('OVER NOTES')"];

/** `main` binds the base worker; the pin's overlay redirects it to `over-worker`. */
const PROFILE = {
  executors: {
    'base-worker': { adapter: 'command', command: BASE_CMD, model: 'm-base' },
    'over-worker': { adapter: 'command', command: OVER_CMD, model: 'm-over' },
  },
  loadouts: { main: { worker: 'base-worker' }, alt: { worker: 'base-worker' } },
  default_loadout: 'main',
};

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: override-e2e
description: Session-override resolution flow.
when_to_use:
  - session override tests
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

function seedRepo(t: TestContext, profile: Record<string, unknown> = PROFILE): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'override-e2e.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(profile));
  return root;
}

/** Write the v2 pin by hand: these tests assert on the on-disk contract, not on
 *  whichever command happened to produce it. */
function pin(root: string, body: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'loadout'), `${body}\n`, 'utf8');
}

function pinOverride(root: string, loadout: string, overrides: Record<string, string>): void {
  pin(root, JSON.stringify({ loadout, overrides }));
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

test('dispatch: an override binds the archetype and both evidence rows say so', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    ...PROFILE,
    executors: {
      'base-worker': { adapter: 'command', command: STDIN_ECHO('BASE:'), model: 'm-base' },
      'over-worker': { adapter: 'command', command: STDIN_ECHO('OVER:'), model: 'm-over' },
    },
  }));
  pinOverride(root, 'main', { worker: 'over-worker' });

  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, env: null });
  assert.equal(result.stdout, 'OVER:hello');
  assert.equal(result.executor, 'over-worker');
  assert.equal(result.source, 'override');
  // The overlay decorates the base, so the row still names the loadout in force.
  assert.deepEqual(result.loadout, { name: 'main', source: 'local' });
  assert.equal(result.echo, 'worker → over-worker (m-over) [override]');

  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    // Additive fields only: the overlay does not re-spell the log.
    assert.equal(row.format, DISPATCHES_FORMAT);
    assert.equal(row.format, '0.2');
    assert.equal(row.resolution, 'override');
    assert.deepEqual(row.override, { worker: 'over-worker' });
    assert.deepEqual(row.loadout, { name: 'main', source: 'local' });
    assert.equal(row.executor, 'over-worker');
    assert.equal(row.model, 'm-over');
  }
});

test('dispatch: no override means no `override` field, and a base mismatch drops the overlay', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    ...PROFILE,
    executors: {
      'base-worker': { adapter: 'command', command: STDIN_ECHO('BASE:'), model: 'm-base' },
      'over-worker': { adapter: 'command', command: STDIN_ECHO('OVER:'), model: 'm-over' },
    },
  }));

  // Bare pin, no overlay: rows keep exactly the shape they always had.
  pin(root, 'main');
  const plain = runDispatch({ archetype: 'worker', prompt: 'hi', repoRoot: root, env: null });
  assert.equal(plain.source, 'loadout');
  assert.equal(plain.executor, 'base-worker');
  for (const row of evidenceRows(root)) {
    assert.equal(row.resolution, 'loadout');
    assert.ok(!('override' in row));
  }

  // Overlay pinned over "main", but this invocation runs "alt": overrides
  // belong to their base by name, so they must not re-bind somebody else's
  // loadout.
  rmSync(join(root, DISPATCHES_FILE));
  pinOverride(root, 'main', { worker: 'over-worker' });
  const elsewhere = runDispatch({
    archetype: 'worker', prompt: 'hi', repoRoot: root, env: null, loadout: 'alt',
  });
  assert.equal(elsewhere.source, 'loadout');
  assert.equal(elsewhere.executor, 'base-worker');
  assert.deepEqual(elsewhere.loadout, { name: 'alt', source: 'flag' });
  for (const row of evidenceRows(root)) assert.ok(!('override' in row));
});

test('new-run: the run-start preview echoes override provenance', (t) => {
  const root = seedRepo(t);
  pinOverride(root, 'main', { worker: 'over-worker' });

  const created = runNewRun({ playbook: 'override-e2e', task: 'Override run', repoRoot: root, env: null });
  assert.ok(created.resolution);
  assert.deepEqual(created.resolution.loadout, { name: 'main', source: 'local' });
  assert.deepEqual(created.resolution.roles, [
    { role: 'implementer', archetype: 'worker', executor: 'over-worker', model: 'm-over', source: 'override', error: null },
  ]);
  // `roleResolutionEchoLabel` renders the source verbatim — "override", never
  // the loadout name that would misattribute the spend.
  assert.deepEqual(created.resolution.echo, ['implementer → over-worker (m-over) [override]']);
});

test('drive: the resolution_snapshot records the overlay in force, and omits it when empty', (t) => {
  const root = seedRepo(t);

  // No pin at all: the event is byte-identical to its pre-override shape.
  const plain = runNewRun({ playbook: 'override-e2e', task: 'Plain run', repoRoot: root, env: null });
  assert.equal(runDrive({ run: plain.runId, repoRoot: root, env: null }).status, 'completed');
  const plainSnapshot = events(root, plain.runId).find((e) => e.type === 'resolution_snapshot')!;
  assert.ok(!('overrides' in plainSnapshot.extra));
  assert.deepEqual(plainSnapshot.extra.roles, [
    { role: 'implementer', archetype: 'worker', executor: 'base-worker', model: 'm-base', source: 'loadout' },
  ]);

  pinOverride(root, 'main', { worker: 'over-worker' });
  const created = runNewRun({ playbook: 'override-e2e', task: 'Override run', repoRoot: root, env: null });
  const done = runDrive({ run: created.runId, repoRoot: root, env: null });
  assert.equal(done.status, 'completed');
  assert.ok(done.actions.includes('implementer → over-worker (m-over) [override]'));

  const all = events(root, created.runId);
  const snapshot = all.find((e) => e.type === 'resolution_snapshot')!;
  assert.deepEqual(snapshot.extra.loadout, { name: 'main', source: 'local' });
  assert.deepEqual(snapshot.extra.overrides, { worker: 'over-worker' });
  assert.deepEqual(snapshot.extra.roles, [
    { role: 'implementer', archetype: 'worker', executor: 'over-worker', model: 'm-over', source: 'override' },
  ]);
  assert.equal(all.find((e) => e.type === 'actor_dispatched')!.extra.executor, 'over-worker');
  assert.equal(
    readFileSync(join(root, '.fadeno', 'runs', created.runId, 'artifacts', 'notes.md'), 'utf8'),
    'OVER NOTES',
  );

  // Re-driving with an unchanged overlay stays quiet in the ledger.
  runDrive({ run: created.runId, repoRoot: root, env: null });
  assert.equal(events(root, created.runId).filter((e) => e.type === 'resolution_snapshot').length, 1);
});

test('verify: a run resolved under an override still verifies after the override is cleared', (t) => {
  const root = seedRepo(t);
  pinOverride(root, 'main', { worker: 'over-worker' });
  const created = runNewRun({ playbook: 'override-e2e', task: 'Override run', repoRoot: root, env: null });
  assert.equal(runDrive({ run: created.runId, repoRoot: root, env: null }).status, 'completed');
  assert.equal(runVerify({ run: created.runId, repoRoot: root }).ok, true);

  // Clear the pin — the dial is a session decision, the run is finished.
  rmSync(join(root, '.fadeno', 'local', 'loadout'));
  // Sanity: live resolution really moved, so the replay below is not vacuous.
  const after = runNewRun({ playbook: 'override-e2e', task: 'After clear', repoRoot: root, env: null });
  assert.equal(after.resolution!.roles[0]!.executor, 'base-worker');

  // Verify replays from what the run recorded, never from today's pin: a
  // completed run must not fail its own verify because somebody re-dialed.
  const replay = runVerify({ run: created.runId, repoRoot: root });
  assert.equal(replay.ok, true, finding(replay, 'executor-bindings').detail);
  assert.equal(finding(replay, 'executor-bindings').status, 'ok');
});

test('verify: the recorded overrides are load-bearing — stripping them fails the replay', (t) => {
  const root = seedRepo(t);
  pinOverride(root, 'main', { worker: 'over-worker' });
  const created = runNewRun({ playbook: 'override-e2e', task: 'Override run', repoRoot: root, env: null });
  assert.equal(runDrive({ run: created.runId, repoRoot: root, env: null }).status, 'completed');

  // Drop the snapshot's `overrides` field (what a pre-override ledger looks
  // like) while the dispatch still claims the overridden executor: the replay
  // must notice rather than shrug.
  const eventsPath = join(root, '.fadeno', 'runs', created.runId, 'events.jsonl');
  const rewritten = readFileSync(eventsPath, 'utf8')
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      const parsed = JSON.parse(line) as { type?: string; overrides?: unknown };
      if (parsed.type !== 'resolution_snapshot') return line;
      delete parsed.overrides;
      return JSON.stringify(parsed);
    })
    .join('\n');
  writeFileSync(eventsPath, rewritten, 'utf8');

  const verify = runVerify({ run: created.runId, repoRoot: root });
  assert.equal(verify.ok, false);
  assert.match(
    finding(verify, 'executor-bindings').detail,
    /dispatched to "over-worker" but the resolution in force was "base-worker"/,
  );
});

test('steering resolve: override provenance rides alongside the fields renderers already parse', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(PROFILE));
  pinOverride(root, 'main', { worker: 'over-worker' });

  const overridden = runSteeringResolve({ repoRoot: root, archetype: 'worker', env: null });
  assert.equal(overridden.executor, 'over-worker');
  assert.equal(overridden.source, 'override');
  assert.equal(overridden.override, true);
  // Every pre-existing field keeps its spelling and meaning.
  assert.equal(overridden.mode, 'command');
  assert.equal(overridden.archetype, 'worker');
  assert.equal(overridden.role, null);
  assert.equal(overridden.adapter, 'command');
  assert.equal(overridden.model, 'm-over');
  assert.deepEqual(overridden.activeLoadout, { name: 'main', source: 'local' });

  // A different base loadout in force: the overlay drops, provenance says so.
  const elsewhere = runSteeringResolve({ repoRoot: root, archetype: 'worker', loadout: 'alt', env: null });
  assert.equal(elsewhere.executor, 'base-worker');
  assert.equal(elsewhere.source, 'loadout');
  assert.equal(elsewhere.override, false);
});

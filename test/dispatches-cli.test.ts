import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { DISPATCHES_FILE, DISPATCHES_FORMAT, runDispatch } from '../src/commands/dispatch.ts';
import {
  DispatchesCommandError,
  runDispatches,
  runDispatchesOutput,
} from '../src/commands/dispatches.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });
const SNAPSHOT = '.fadeno/local/prompts/worker-1a2b3c4d.md';
const OUTPUT_SNAP = '.fadeno/local/outputs/worker-aaaaaaaa.md';
const OUTPUT_BODY = 'hello from the executor\n';
const OUTPUT_DIGEST = sha256Hex(OUTPUT_BODY);

function requested(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: '1.0',
    timestamp: '2026-08-12T12:00:00.000Z',
    event: 'dispatch_requested',
    dispatch_id: 'd1',
    archetype: 'worker',
    role: null,
    resolution: 'repo',
    dial: { model: 'echo-worker' },
    executor: 'echo-worker',
    model: 'echo-worker',
    model_id: 'echo-worker',
    reasoning_effort: 'default',
    driver: 'openai',
    provider: 'openai',
    transport: 'command',
    prompt_source: 'stdin',
    prompt_snapshot: SNAPSHOT,
    prompt_sha256: 'a'.repeat(64),
    command: ['node', '-e', '0'],
    command_sha256: 'b'.repeat(64),
    output_snapshot: OUTPUT_SNAP,
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
    output_bytes: 10,
    ...over,
  };
}
function hostRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-12T12:02:00.000Z',
    event: 'host_delivery',
    archetype: 'worker',
    agent_type: 'general-purpose',
    loadout: 'claude-native',
    executor: 'claude-host',
    model: 'opus',
    model_override: null,
    reasoning_effort: 'inherited',
    transport: 'host',
    prompt_sha256: 'd'.repeat(64),
    prompt_snapshot: '.fadeno/local/prompts/host-deadbeef.md',
    ...over,
  };
}
function legacyRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-10T22:23:15.949Z',
    archetype: 'worker',
    role: null,
    resolution: 'repo',
    dial: { model: 'grok-worker' },
    executor: 'grok-worker',
    model: 'grok-4.6',
    model_id: 'grok-4.6',
    driver: 'openai',
    exit_code: 0,
    duration_ms: 17444,
    prompt_sha256: 'e'.repeat(64),
    output_sha256: 'f'.repeat(64),
    ...over,
  };
}
function seedLog(t: TestContext, rows: Array<Record<string, unknown> | string>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`, 'utf8');
  return root;
}
function seedSnapshot(root: string, rel: string, content: string): void {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

test('dispatches: correlates a requested/completed pair into one logical entry', (t) => {
  const root = seedLog(t, [requested(), completed()]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.path, '.fadeno/dispatches.jsonl');
  assert.equal(result.exists, true);
  assert.ok(result.lines[0]!.includes('worker → echo-worker'));
  assert.ok(result.lines[0]!.includes('via openai') || result.lines[0]!.includes('via command'));
  assert.equal(result.summary, '1 of 1 dispatch shown');
  const entry = result.entries[0]!;
  assert.equal(entry.kind, 'command');
  assert.equal(entry.dispatchId, 'd1');
  assert.equal(entry.completed, true);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.durationMs, 42);
  assert.equal(entry.outputSha256, 'c'.repeat(64));
  assert.equal(entry.resolution, 'repo');
  assert.equal(entry.promptSnapshot, SNAPSHOT);
  assert.equal(entry.relayAttested, null);
  assert.equal(entry.writeAccess, null);
});

test('dispatches: reads what the kernel actually writes (round trip)', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { 'echo-worker': { provider: 'openai', id: 'echo-worker' } },
    routes: { standalone: { openai: { command: ['node', '-e', "process.stdout.write('ok')"] } }, codex: { openai: { command: ['node', '-e', "process.stdout.write('ok')"] } } },
    archetypes: { worker: {} },
    dials: { worker: 'echo-worker' },
  }));
  const dispatched = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, now: new Date('2026-08-12T12:00:00Z'), userPathOptions: onHarness('standalone') });
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 1);
  const entry = result.entries[0]!;
  assert.equal(entry.dispatchId, dispatched.dispatchId);
  assert.equal(entry.format, DISPATCHES_FORMAT);
  assert.equal(entry.legacy, false);
  assert.equal(entry.executor, 'echo-worker');
  assert.equal(entry.model, 'echo-worker');
  assert.equal(entry.transport, 'command');
  assert.equal(entry.completed, true);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.promptSnapshot, dispatched.promptSnapshot);
});

test('dispatches: a requested row with no completion is marked, not silently dropped', (t) => {
  const root = seedLog(t, [
    requested({
      timestamp: '2026-08-12T12:01:00.000Z',
      dispatch_id: 'd2',
      archetype: 'reviewer',
      role: 'senior_reviewer',
      executor: 'terra-fallback',
      model: 'gpt-5.6-terra',
      transport: 'host-command-fallback',
      relay_attested: true,
      write_access: false,
      prompt_snapshot: '.fadeno/local/prompts/reviewer-9f8e7d6c.md',
      output_snapshot: '.fadeno/local/outputs/reviewer-9f8e7d6c.md',
    }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 1);
  assert.ok(result.lines[0]!.includes('no completion recorded (killed or in flight)'));
  assert.ok(result.lines[0]!.includes('[relay_attested: true]'));
  assert.ok(result.lines[0]!.includes('[write_access: none]'));
  const entry = result.entries[0]!;
  assert.equal(entry.completed, false);
  assert.equal(entry.exitCode, null);
  assert.equal(entry.durationMs, null);
  assert.equal(entry.relayAttested, true);
  assert.equal(entry.writeAccess, false);
});

test('dispatches: a pre-0.6 native_delivery row still renders as a host entry', (t) => {
  const root = seedLog(t, [hostRow({ event: 'native_delivery', transport: 'host-native' })]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.kind, 'host');
  assert.equal(result.skipped, 0);
});

test('dispatches: host_delivery rows render one entry each, with model_override', (t) => {
  const root = seedLog(t, [
    hostRow({ model_override: 'sonnet' }),
    hostRow({
      timestamp: '2026-08-12T12:03:00.000Z',
      archetype: 'reviewer',
      agent_type: 'reviewer',
      executor: 'codex-host',
      model: 'gpt-5.6-terra',
      prompt_snapshot: '.fadeno/local/prompts/host-abcdef01.md',
    }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 2);
  assert.ok(result.lines[0]!.includes('→ sonnet') || result.lines[0]!.includes('sonnet'));
  assert.equal(result.entries[0]!.modelOverride, 'sonnet');
  assert.equal(result.entries[0]!.agentType, 'general-purpose');
  assert.equal(result.entries[0]!.completed, false);
});

test('dispatches: default shows the last 10 entries; --tail selects a different window', (t) => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 12; i += 1) {
    const id = `d${i}`;
    rows.push(requested({ dispatch_id: id, timestamp: `2026-08-12T12:${String(i).padStart(2, '0')}:00.000Z`, output_snapshot: `.fadeno/local/outputs/${id}.md` }));
    rows.push(completed({ dispatch_id: id, timestamp: `2026-08-12T12:${String(i).padStart(2, '0')}:01.000Z`, output_snapshot: `.fadeno/local/outputs/${id}.md` }));
  }
  const root = seedLog(t, rows);
  const byDefault = runDispatches({ repoRoot: root });
  assert.equal(byDefault.total, 12);
  assert.equal(byDefault.tail, 10);
  assert.deepEqual(byDefault.entries.map((e) => e.dispatchId), ['d3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11', 'd12']);
  assert.equal(byDefault.summary, '10 of 12 dispatches shown');
  const tailed = runDispatches({ repoRoot: root, tail: 2 });
  assert.deepEqual(tailed.entries.map((e) => e.dispatchId), ['d11', 'd12']);
  assert.equal(tailed.lines.length, 2);
  assert.equal(tailed.summary, '2 of 12 dispatches shown');
  assert.equal(runDispatches({ repoRoot: root, tail: 99 }).entries.length, 12);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => runDispatches({ repoRoot: root, tail: bad }), DispatchesCommandError);
  }
});

test('dispatches: entries are structured data (what --json prints) — 1.0 shape pin', (t) => {
  const root = seedLog(t, [requested(), completed(), hostRow({ model_override: 'sonnet' })]);
  const result = runDispatches({ repoRoot: root });
  const payload = JSON.parse(JSON.stringify({ path: result.path, total: result.total, shown: result.entries.length, skipped: result.skipped, entries: result.entries })) as any;
  assert.equal(payload.path, '.fadeno/dispatches.jsonl');
  assert.equal(payload.total, 2);
  assert.equal(payload.shown, 2);
  assert.equal(payload.skipped, 0);
  const e = payload.entries[0] as Record<string, unknown>;
  // pin 1.0 fields
  assert.equal(e.kind, 'command');
  assert.equal(e.format, '1.0');
  assert.equal(e.legacy, false);
  assert.equal(e.dispatchId, 'd1');
  assert.equal(e.archetype, 'worker');
  assert.equal(e.role, null);
  assert.equal(e.agentType, null);
  assert.equal(e.resolution, 'repo');
  assert.deepEqual(e.dial, { model: 'echo-worker' });
  assert.equal(e.executor, 'echo-worker');
  assert.equal(e.model, 'echo-worker');
  assert.equal(e.modelOverride, null);
  assert.equal(e.modelId, 'echo-worker');
  assert.equal(e.reasoningEffort, 'default');
  assert.equal(e.driver, 'openai');
  assert.equal(e.provider, 'openai');
  assert.equal(e.transport, 'command');
  assert.equal(e.promptSource, 'stdin');
  assert.equal(e.promptSnapshot, SNAPSHOT);
  assert.equal(e.promptSha256, 'a'.repeat(64));
  assert.equal(e.relayAttested, null);
  assert.equal(e.writeAccess, null);
  assert.equal(e.refusal, null);
  assert.equal(e.gateEligible, null);
  assert.equal(e.completed, true);
  // outcome may be ok if output_bytes present; check classification
  assert.ok(e.outcome === 'ok' || e.outcome === null);
  assert.equal(e.exitCode, 0);
  assert.equal(e.signal, null);
  assert.equal(e.durationMs, 42);
  assert.equal(e.outputSha256, 'c'.repeat(64));
  assert.equal(e.outputBytes, 10);
  assert.equal(e.workspaceChanged, null);
  assert.equal(e.shadow, false);
  assert.equal(e.shadowSource, null);
  assert.equal(e.primaryDispatchId, null);
  assert.equal(e.diffSnapshot, null);
  assert.equal(e.diffBytes, null);
  assert.equal(e.error, null);
  assert.equal(e.loadout, null);
  assert.equal(e.loadoutSource, null);
  assert.equal(payload.entries[1].kind, 'host');
});

test('dispatches: pre-dispatch_id rows read as [legacy] entries, not unreadable ones', (t) => {
  const root = seedLog(t, [
    legacyRow(),
    legacyRow({
      timestamp: '2026-08-11T04:12:34.209Z',
      archetype: null,
      resolution: 'repo',
      dial: null,
      executor: 'opus-high-readonly',
      model: 'opus',
      duration_ms: 582698,
      command: ['claude', '-p', '--model', 'opus'],
      command_sha256: '9'.repeat(64),
    }),
    legacyRow({
      timestamp: '2026-08-12T17:16:01.303Z',
      executor: 'luna-xhigh',
      model: 'gpt-5.6-luna',
      transport: 'command',
      duration_ms: 46987,
    }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.skipped, 0);
  assert.equal(result.skippedNewerFormat, 0);
  assert.equal(result.total, 3);
  assert.ok(result.lines[0]!.includes('[legacy]'));
  assert.ok(result.lines[1]!.includes('(none)'));
  assert.ok(result.lines[0]!.endsWith('[legacy]') || result.lines[0]!.includes('[legacy]'));
  const entry = result.entries[0]!;
  assert.equal(entry.kind, 'command');
  assert.equal(entry.legacy, true);
  assert.equal(entry.format, null);
  assert.equal(entry.dispatchId, null);
  assert.equal(entry.completed, true);
  assert.equal(entry.exitCode, 0);
});

test('dispatches: a legacy row missing identity renders ? rather than being dropped', (t) => {
  const root = seedLog(t, [
    { timestamp: '2026-08-09T01:00:00.000Z', executor: 'mystery-worker', exit_code: null },
    { timestamp: '2026-08-09T02:00:00.000Z', exit_code: 0 },
    { timestamp: '2026-08-09T03:00:00.000Z', executor: 'mystery-worker' },
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 1);
  assert.equal(result.skipped, 2);
  assert.ok(result.lines[0]!.includes('(none)'));
  assert.ok(result.lines[0]!.includes('mystery-worker'));
});

test('dispatches: rows from a newer format are counted apart from unreadable ones', (t) => {
  const root = seedLog(t, [
    requested(),
    completed(),
    { format: '2.0', timestamp: '2026-09-01T09:00:00.000Z', event: 'dispatch_requested', dispatch_id: 'future' },
    { format: '2.3', timestamp: '2026-09-01T09:01:00.000Z', event: 'something_new' },
    'not json at all',
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 1);
  assert.equal(result.skippedNewerFormat, 2);
  assert.equal(result.skipped, 1);
  assert.ok(result.summary.includes('unreadable row skipped'));
  assert.ok(result.summary.includes('newer format skipped'));
  const onlyNewer = seedLog(t, [{ format: '2.0', timestamp: '2026-09-01T09:00:00.000Z', event: 'x' }]);
  assert.ok(runDispatches({ repoRoot: onlyNewer }).summary.includes('newer format skipped'));
  // assert both strings present when both kinds
  assert.equal(result.skipped, 1);
  assert.equal(result.skippedNewerFormat, 2);
});

test('dispatches: an unknown minor within the known major is read best-effort', (t) => {
  const root = seedLog(t, [
    requested({ format: '1.9', dispatch_id: 'dm' }),
    completed({ format: '1.9', dispatch_id: 'dm', some_future_field: 'ignored' }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.skippedNewerFormat, 0);
  assert.equal(result.entries[0]!.format, '1.9');
  assert.equal(result.entries[0]!.completed, true);
});

test('dispatches: a log spanning every format generation renders in append order', (t) => {
  const root = seedLog(t, [
    legacyRow(),
    hostRow(),
    requested({ dispatch_id: 'd7', timestamp: '2026-08-12T12:05:00.000Z', output_snapshot: '.fadeno/local/outputs/d7.md' }),
    completed({ dispatch_id: 'd7', timestamp: '2026-08-12T12:05:01.000Z', output_snapshot: '.fadeno/local/outputs/d7.md' }),
    { format: '2.0', timestamp: '2026-08-12T12:06:00.000Z', event: 'dispatch_requested', dispatch_id: 'd8' },
    requested({ format: DISPATCHES_FORMAT, dispatch_id: 'd9', timestamp: '2026-08-12T12:07:00.000Z', output_snapshot: '.fadeno/local/outputs/d9.md' }),
    completed({ format: DISPATCHES_FORMAT, dispatch_id: 'd9', timestamp: '2026-08-12T12:07:02.000Z', output_snapshot: '.fadeno/local/outputs/d9.md' }),
    'torn write',
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 4);
  assert.equal(result.skipped, 1);
  assert.equal(result.skippedNewerFormat, 1);
  assert.deepEqual(result.entries.map((e) => [e.kind, e.format, e.legacy, e.dispatchId]), [
    ['command', null, true, null],
    ['host', null, false, null],
    ['command', '1.0', false, 'd7'],
    ['command', DISPATCHES_FORMAT, false, 'd9'],
  ]);
});

test('dispatches: a missing or empty log is a friendly answer, not an error', (t) => {
  const bare = tempRepo(t);
  const missing = runDispatches({ repoRoot: bare });
  assert.equal(missing.exists, false);
  assert.equal(missing.total, 0);
  assert.deepEqual(missing.entries, []);
  assert.deepEqual(missing.lines, []);
  assert.ok(missing.summary.includes('absent'));
  const empty = seedLog(t, []);
  const result = runDispatches({ repoRoot: empty });
  assert.equal(result.exists, true);
  assert.equal(result.total, 0);
  assert.deepEqual(result.lines, []);
  assert.ok(result.summary.includes('No dispatches'));
});

test('dispatches: malformed rows are counted and skipped, never fatal', (t) => {
  const root = seedLog(t, [
    requested(),
    '{"timestamp":"2026-08-12T12:00:30.000Z","event":"dispatch_req',
    'not json at all',
    '["an","array"]',
    completed(),
    { timestamp: '2026-08-12T12:04:00.000Z', event: 'something_else' },
    requested({ dispatch_id: undefined, archetype: 'judge' }),
    hostRow(),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.skipped, 5);
  assert.equal(result.total, 2);
  assert.deepEqual(result.entries.map((e) => e.kind), ['command', 'host']);
  assert.equal(result.entries[0]!.completed, true);
});

test('dispatches: a completion that records a spawn error surfaces it', (t) => {
  const root = seedLog(t, [
    requested({ dispatch_id: 'd9', executor: 'missing-bin', output_snapshot: '.fadeno/local/outputs/missing.md' }),
    completed({
      dispatch_id: 'd9',
      executor: 'missing-bin',
      exit_code: null,
      signal: 'SIGKILL',
      duration_ms: 7,
      error: 'spawnSync missing-bin ENOENT',
      output_snapshot: '.fadeno/local/outputs/missing.md',
    }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries[0]!.completed, true);
  assert.equal(result.entries[0]!.error, 'spawnSync missing-bin ENOENT');
  assert.match(result.lines[0]!, /exit \? \(SIGKILL\) in 7ms.*\[error: spawnSync missing-bin ENOENT]/);
});

test('dispatches: [no workspace change] marks an exit-0 write-capable no-op', (t) => {
  const root = seedLog(t, [
    requested({ write_access: true, output_snapshot: OUTPUT_SNAP }),
    completed({ write_access: true, output_snapshot: OUTPUT_SNAP, output_bytes: Buffer.byteLength(OUTPUT_BODY), workspace_changed: false }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries[0]!.workspaceChanged, false);
  assert.equal(result.entries[0]!.writeAccess, true);
  assert.match(result.lines[0]!, /\[no workspace change]/);
});

test('dispatches: [no workspace change] stays off unless every frozen field agrees', (t) => {
  const cases: Array<Record<string, unknown>> = [
    { write_access: true, workspace_changed: true },
    { write_access: true },
    { write_access: false, workspace_changed: false },
    { write_access: true, workspace_changed: false, exit_code: 1 },
  ];
  for (const over of cases) {
    const root = seedLog(t, [
      requested({ write_access: over.write_access }),
      completed(over),
    ]);
    const line = runDispatches({ repoRoot: root }).lines[0]!;
    assert.equal(line.includes('[no workspace change]'), false, line);
  }
});

test('dispatches: shadow rows never get [no workspace change]', (t) => {
  const root = seedLog(t, [
    requested({ write_access: true, output_snapshot: OUTPUT_SNAP }),
    completed({ write_access: true, output_snapshot: OUTPUT_SNAP, workspace_changed: false, shadow: true, primary_dispatch_id: 'd1', output_bytes: 10 }),
  ]);
  // need to make entry shadow true via request row as well? We'll seed shadow request directly
  const root2 = seedLog(t, [
    requested({ dispatch_id: 'd1', write_access: true, output_snapshot: OUTPUT_SNAP }),
    completed({ dispatch_id: 'd1', write_access: true, output_snapshot: OUTPUT_SNAP, workspace_changed: false, output_bytes: 10 }),
    { ...requested({ dispatch_id: 's1', shadow: true, primary_dispatch_id: 'd1', write_access: true, output_snapshot: '.fadeno/local/outputs/shadow-aaa.md' }) },
    { ...completed({ dispatch_id: 's1', shadow: true, primary_dispatch_id: 'd1', write_access: true, workspace_changed: false, output_bytes: 5, output_snapshot: '.fadeno/local/outputs/shadow-aaa.md', diff_snapshot: '.fadeno/local/outputs/shadow-aaa.diff', diff_bytes: 1 }) },
  ]);
  const result = runDispatches({ repoRoot: root2 });
  const shadowLine = result.lines.find(l=>l.includes('[shadow of'))!;
  assert.ok(!shadowLine.includes('[no workspace change]'));
});

test('dispatches --output: happy path returns snapshot bytes and match attestation', (t) => {
  const root = seedLog(t, [
    requested({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: OUTPUT_SNAP }),
    completed({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: OUTPUT_SNAP, output_sha256: OUTPUT_DIGEST, output_bytes: Buffer.byteLength(OUTPUT_BODY) }),
  ]);
  seedSnapshot(root, OUTPUT_SNAP, OUTPUT_BODY);
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: 'aaaaaaaa-1111-4000-8000-000000000001' });
  assert.equal(result.dispatchId, 'aaaaaaaa-1111-4000-8000-000000000001');
  assert.equal(result.path, OUTPUT_SNAP);
  assert.equal(result.bytes, OUTPUT_BODY);
  assert.equal(result.attested, 'match');
  assert.equal(result.resolvedBy, 'id');
});

test('dispatches --output: unique prefix and last resolve the recorded snapshot', (t) => {
  const olderSnap = '.fadeno/local/outputs/worker-aaaaaaaa.md';
  const newerSnap = '.fadeno/local/outputs/reviewer-bbbbbbbb.md';
  const olderBody = 'older\n';
  const newerBody = 'newer\n';
  const root = seedLog(t, [
    requested({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: olderSnap }),
    completed({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: olderSnap, output_sha256: sha256Hex(olderBody) }),
    requested({ dispatch_id: 'bbbbbbbb-2222-4000-8000-000000000002', archetype: 'reviewer', output_snapshot: newerSnap, timestamp: '2026-08-12T12:05:00.000Z' }),
    completed({ dispatch_id: 'bbbbbbbb-2222-4000-8000-000000000002', archetype: 'reviewer', output_snapshot: newerSnap, output_sha256: sha256Hex(newerBody), timestamp: '2026-08-12T12:05:00.000Z' }),
  ]);
  seedSnapshot(root, olderSnap, olderBody);
  seedSnapshot(root, newerSnap, newerBody);
  const byPrefix = runDispatchesOutput({ repoRoot: root, dispatchId: 'bbbbbbbb' });
  assert.equal(byPrefix.dispatchId, 'bbbbbbbb-2222-4000-8000-000000000002');
  assert.equal(byPrefix.bytes, newerBody);
  assert.equal(byPrefix.attested, 'match');
  const last = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(last.dispatchId, 'bbbbbbbb-2222-4000-8000-000000000002');
  assert.equal(last.path, newerSnap);
  assert.equal(last.bytes, newerBody);
  assert.equal(last.resolvedBy, 'recency');
});

test('dispatches --output: incomplete when the completion row never arrived', (t) => {
  const root = seedLog(t, [requested({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: OUTPUT_SNAP })]);
  seedSnapshot(root, OUTPUT_SNAP, OUTPUT_BODY);
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: 'aaaaaaaa-1111-4000-8000-000000000001' });
  assert.equal(result.attested, 'incomplete');
  assert.equal(result.bytes, OUTPUT_BODY);
});

test('dispatches --output: mismatch when the file no longer matches output_sha256', (t) => {
  const root = seedLog(t, [
    requested({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: OUTPUT_SNAP }),
    completed({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: OUTPUT_SNAP, output_sha256: OUTPUT_DIGEST }),
  ]);
  seedSnapshot(root, OUTPUT_SNAP, 'tampered bytes\n');
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: 'aaaaaaaa-1111-4000-8000-000000000001' });
  assert.equal(result.attested, 'mismatch');
  assert.equal(result.bytes, 'tampered bytes\n');
});

test('dispatches --output: errors for unknown, ambiguous, pre-snapshot, and missing-file', (t) => {
  // Build a pre-snapshot row without output_snapshot
  const preReq: Record<string, unknown> = { format: '1.0', timestamp: '2026-08-12T11:00:00.000Z', event: 'dispatch_requested', dispatch_id: 'pre-snap-00000001', archetype: 'worker', resolution: 'repo', dial: { model: 'echo-worker' }, executor: 'echo-worker', prompt_sha256: 'a'.repeat(64) };
  const preComp: Record<string, unknown> = { ...preReq, event: 'dispatch_completed', exit_code: 0, duration_ms: 10, output_sha256: 'b'.repeat(64) };
  const root = seedLog(t, [
    preReq,
    preComp,
    requested({ dispatch_id: 'cccccccc-1111-4000-8000-000000000001', output_snapshot: OUTPUT_SNAP }),
    completed({ dispatch_id: 'cccccccc-1111-4000-8000-000000000001', output_snapshot: OUTPUT_SNAP, output_sha256: OUTPUT_DIGEST }),
    requested({ dispatch_id: 'cccccccc-2222-4000-8000-000000000002', output_snapshot: '.fadeno/local/outputs/worker-cccccccc.md' }),
    completed({ dispatch_id: 'cccccccc-2222-4000-8000-000000000002', output_snapshot: '.fadeno/local/outputs/worker-cccccccc.md', output_sha256: OUTPUT_DIGEST }),
    requested({ dispatch_id: 'dddddddd-3333-4000-8000-000000000003', output_snapshot: '.fadeno/local/outputs/missing.md' }),
    completed({ dispatch_id: 'dddddddd-3333-4000-8000-000000000003', output_snapshot: '.fadeno/local/outputs/missing.md', output_sha256: OUTPUT_DIGEST }),
  ]);
  seedSnapshot(root, OUTPUT_SNAP, OUTPUT_BODY);
  assert.throws(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'deadbeef' }), (err: unknown) => err instanceof DispatchesCommandError && /unknown dispatch "deadbeef"/.test(err.message));
  assert.throws(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'cccccccc' }), (err: unknown) => err instanceof DispatchesCommandError && /ambiguous dispatch prefix "cccccccc"/.test(err.message));
  assert.throws(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'pre-snap' }), (err: unknown) => err instanceof DispatchesCommandError && /predates output_snapshot/.test(err.message));
  assert.throws(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'dddddddd' }), (err: unknown) => err instanceof DispatchesCommandError && /output snapshot missing: \.fadeno\/local\/outputs\/missing\.md/.test(err.message));
});

test('dispatches: a nonzero exit is stamped and rendered as FAILED, not completed', (t) => {
  function dispatchWith(cmd: string[]): string {
    const root = tempRepo(t);
    mkdirSync(join(root, '.fadeno'), { recursive: true });
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
      schema_version: 3,
      models: { probe: { provider: 'openai', id: 'probe' } },
      routes: { standalone: { openai: { command: cmd } }, codex: { openai: { command: cmd } } },
      archetypes: { worker: {} },
      dials: { worker: 'probe' },
    }));
    return root;
  }
  const root = dispatchWith(['node', '-e', 'process.exit(1)']);
  const dispatched = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, now: new Date('2026-08-12T12:00:00Z'), userPathOptions: onHarness('standalone') });
  assert.equal(dispatched.exitCode, 1);
  assert.equal(dispatched.outcome, 'failed');
  assert.equal(dispatched.outputBytes, 0);
  const result = runDispatches({ repoRoot: root });
  const entry = result.entries[0]!;
  assert.equal(entry.completed, true);
  assert.equal(entry.outcome, 'failed');
  assert.match(result.lines[0]!, /FAILED.*exit 1 in \d+ms/);
});

test('dispatches: exit 0 with no output is stamped `empty`, not success', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { probe: { provider: 'openai', id: 'probe' } },
    routes: { standalone: { openai: { command: ['node', '-e', '0'] } }, codex: { openai: { command: ['node', '-e', '0'] } } },
    archetypes: { worker: {} },
    dials: { worker: 'probe' },
  }));
  const dispatched = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, now: new Date('2026-08-12T12:00:00Z'), userPathOptions: onHarness('standalone') });
  assert.equal(dispatched.exitCode, 0);
  assert.equal(dispatched.outputBytes, 0);
  assert.equal(dispatched.outcome, 'empty');
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries[0]!.outcome, 'empty');
  assert.match(result.lines[0]!, /NO OUTPUT.*exit 0 in \d+ms/);
});

test('dispatches: rows written before `outcome` still classify from their own facts', (t) => {
  const root = seedLog(t, [
    requested({ dispatch_id: 'd9', output_snapshot: '.fadeno/local/outputs/d9.md' }),
    completed({ dispatch_id: 'd9', exit_code: 1, output_bytes: 0, output_snapshot: '.fadeno/local/outputs/d9.md' }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries[0]!.outcome, 'failed');
  assert.match(result.lines[0]!, /FAILED/);
});

test('dispatches --output last: prefers the open dispatch over a newer completed one', (t) => {
  const mineSnap = '.fadeno/local/outputs/mine.out';
  const theirsSnap = '.fadeno/local/outputs/theirs.out';
  const root = seedLog(t, [
    requested({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: mineSnap }),
    requested({ dispatch_id: 'bbbbbbbb-2222-4000-8000-000000000002', output_snapshot: theirsSnap }),
    completed({ dispatch_id: 'bbbbbbbb-2222-4000-8000-000000000002', output_snapshot: theirsSnap, output_sha256: sha256Hex('an unrelated code change') }),
  ]);
  seedSnapshot(root, mineSnap, 'my partial report');
  seedSnapshot(root, theirsSnap, 'an unrelated code change');
  const last = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(last.dispatchId, 'aaaaaaaa-1111-4000-8000-000000000001');
  assert.equal(last.bytes, 'my partial report');
  assert.equal(last.resolvedBy, 'in-flight');
  assert.equal(last.attested, 'incomplete');
});

test('dispatches --output last: refuses rather than guess between two open dispatches', (t) => {
  const aSnap = '.fadeno/local/outputs/a.out';
  const bSnap = '.fadeno/local/outputs/b.out';
  const root = seedLog(t, [
    requested({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: aSnap }),
    requested({ dispatch_id: 'bbbbbbbb-2222-4000-8000-000000000002', output_snapshot: bSnap }),
  ]);
  seedSnapshot(root, aSnap, 'a');
  seedSnapshot(root, bSnap, 'b');
  assert.throws(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'last' }), (err: unknown) => {
    assert.ok(err instanceof DispatchesCommandError);
    assert.match((err as Error).message, /2 dispatches are still open \(aaaaaaaa, bbbbbbbb\)/);
    assert.match((err as Error).message, /dispatch id: <id>/);
    return true;
  });
});

test('dispatches --output: an explicit id reports that it resolved by id', (t) => {
  const snap = '.fadeno/local/outputs/only.out';
  const root = seedLog(t, [requested({ dispatch_id: 'aaaaaaaa-1111-4000-8000-000000000001', output_snapshot: snap })]);
  seedSnapshot(root, snap, 'body');
  const byId = runDispatchesOutput({ repoRoot: root, dispatchId: 'aaaaaaaa-1111-4000-8000-000000000001' });
  assert.equal(byId.resolvedBy, 'id');
});

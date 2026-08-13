import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, DISPATCHES_FORMAT, runDispatch } from '../src/commands/dispatch.ts';
import { DispatchesCommandError, runDispatches } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/**
 * `fadeno dispatches` — the provenance reader over `.fadeno/dispatches.jsonl`.
 * Most fixtures are handwritten rows (the shapes the kernel and the Claude
 * steering hook write), so rendering is pinned exactly; one round-trip test
 * runs the real writer so the reader cannot silently drift from it.
 *
 * The log is append-only across format generations, so the fixtures below span
 * three of them on purpose: pre-`dispatch_id` rows (no `format`, no `event`),
 * the unversioned two-row era (no `format`, correlated by `dispatch_id`), and
 * stamped rows. `requested`/`completed`/`native` deliberately carry no
 * `format` — they *are* the unversioned-with-event tier, which must keep
 * reading exactly as it did before the stamp existed.
 */

const SNAPSHOT = '.fadeno/local/prompts/worker-1a2b3c4d.md';

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
    prompt_snapshot: SNAPSHOT,
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

function native(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-12T12:02:00.000Z',
    event: 'native_delivery',
    archetype: 'worker',
    agent_type: 'general-purpose',
    loadout: 'claude-native',
    executor: 'claude-host',
    model: 'opus',
    model_override: null,
    reasoning_effort: 'inherited',
    transport: 'host-native',
    prompt_sha256: 'd'.repeat(64),
    prompt_snapshot: '.fadeno/local/prompts/native-deadbeef.md',
    ...over,
  };
}

/**
 * A pre-`dispatch_id` row, copied in shape from real evidence this repo's own
 * `.fadeno/dispatches.jsonl` still carries: one row per dispatch, written
 * after the spawn, with no `event`, no correlation id, and no prompt snapshot.
 */
function legacyRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-10T22:23:15.949Z',
    archetype: 'worker',
    role: null,
    resolution: 'loadout',
    loadout: { name: 'grok-worker', source: 'local' },
    executor: 'grok-worker',
    model: 'grok-4.6',
    exit_code: 0,
    duration_ms: 17444,
    prompt_sha256: 'e'.repeat(64),
    output_sha256: 'f'.repeat(64),
    ...over,
  };
}

/** Write raw evidence rows (objects are serialized; strings land verbatim). */
function seedLog(t: TestContext, rows: Array<Record<string, unknown> | string>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, DISPATCHES_FILE),
    `${rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`,
    'utf8',
  );
  return root;
}

test('dispatches: correlates a requested/completed pair into one logical entry', (t) => {
  const root = seedLog(t, [requested(), completed()]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.path, '.fadeno/dispatches.jsonl');
  assert.equal(result.exists, true);
  assert.deepEqual(result.lines, [
    '2026-08-12T12:00:00.000Z  [command]  worker → echo-worker (opus)  via command  exit 0 in 42ms  ' +
      '.fadeno/local/prompts/worker-1a2b3c4d.md',
  ]);
  assert.equal(result.summary, '1 of 1 dispatch shown');

  const entry = result.entries[0]!;
  assert.equal(entry.kind, 'command');
  assert.equal(entry.dispatchId, 'd1');
  assert.equal(entry.completed, true);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.durationMs, 42);
  assert.equal(entry.outputSha256, 'c'.repeat(64));
  assert.equal(entry.loadout, 'main');
  assert.equal(entry.loadoutSource, 'default');
  assert.equal(entry.resolution, 'loadout');
  assert.equal(entry.promptSnapshot, SNAPSHOT);
  // Absent optional evidence stays absent rather than becoming a false claim.
  assert.equal(entry.relayAttested, null);
  assert.equal(entry.writeAccess, null);
});

test('dispatches: reads what the kernel actually writes (round trip)', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      executors: {
        'echo-worker': {
          adapter: 'command',
          command: ['node', '-e', "process.stdout.write('ok')"],
          model: 'opus',
        },
      },
      loadouts: { main: { worker: 'echo-worker' } },
      default_loadout: 'main',
    }),
  );
  const dispatched = runDispatch({
    archetype: 'worker',
    prompt: 'hello',
    repoRoot: root,
    env: null,
    now: new Date('2026-08-12T12:00:00Z'),
  });

  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 1); // two rows, one logical entry
  const entry = result.entries[0]!;
  assert.equal(entry.dispatchId, dispatched.dispatchId);
  // What the writer stamps is what the reader reports — no re-derivation.
  assert.equal(entry.format, DISPATCHES_FORMAT);
  assert.equal(entry.legacy, false);
  assert.equal(entry.executor, 'echo-worker');
  assert.equal(entry.model, 'opus');
  assert.equal(entry.transport, 'command');
  assert.equal(entry.completed, true);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.promptSnapshot, dispatched.promptSnapshot);
  assert.match(
    result.lines[0]!,
    /^2026-08-12T12:00:00\.000Z {2}\[command] {2}worker → echo-worker \(opus\) {2}via command {2}exit 0 in \d+ms {2}\.fadeno\/local\/prompts\/worker-[0-9a-f]{8}\.md$/,
  );
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
    }),
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 1);
  assert.deepEqual(result.lines, [
    '2026-08-12T12:01:00.000Z  [command]  reviewer/senior_reviewer → terra-fallback (gpt-5.6-terra)  ' +
      'via host-command-fallback  no completion recorded (killed or in flight)  ' +
      '[relay_attested: true]  [write_access: none]  .fadeno/local/prompts/reviewer-9f8e7d6c.md',
  ]);
  const entry = result.entries[0]!;
  assert.equal(entry.completed, false);
  assert.equal(entry.exitCode, null);
  assert.equal(entry.durationMs, null);
  assert.equal(entry.relayAttested, true);
  assert.equal(entry.writeAccess, false);
});

test('dispatches: native_delivery rows render one entry each, with model_override', (t) => {
  const root = seedLog(t, [
    native({ model_override: 'sonnet' }),
    native({
      timestamp: '2026-08-12T12:03:00.000Z',
      archetype: 'reviewer',
      agent_type: 'reviewer',
      executor: 'codex-host',
      model: 'gpt-5.6-terra',
      prompt_snapshot: '.fadeno/local/prompts/native-abcdef01.md',
    }),
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 2);
  assert.deepEqual(result.lines, [
    // The override is folded into the model as `bound → actual`; agent_type
    // takes the role slot when it says something the archetype does not.
    '2026-08-12T12:02:00.000Z  [native]  worker/general-purpose → claude-host (opus → sonnet)  ' +
      'via host-native  .fadeno/local/prompts/native-deadbeef.md',
    '2026-08-12T12:03:00.000Z  [native]  reviewer → codex-host (gpt-5.6-terra)  ' +
      'via host-native  .fadeno/local/prompts/native-abcdef01.md',
  ]);
  const [override, plain] = result.entries;
  assert.equal(override!.kind, 'native');
  assert.equal(override!.dispatchId, null);
  assert.equal(override!.modelOverride, 'sonnet');
  assert.equal(override!.agentType, 'general-purpose');
  assert.equal(override!.loadout, 'claude-native'); // hook rows record a bare name
  assert.equal(override!.completed, false); // native delivery records no outcome
  assert.equal(plain!.modelOverride, null);
});

test('dispatches: default shows the last 10 entries; --tail selects a different window', (t) => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 12; i += 1) {
    const id = `d${i}`;
    rows.push(requested({ dispatch_id: id, timestamp: `2026-08-12T12:${String(i).padStart(2, '0')}:00.000Z` }));
    rows.push(completed({ dispatch_id: id, timestamp: `2026-08-12T12:${String(i).padStart(2, '0')}:01.000Z` }));
  }
  const root = seedLog(t, rows);

  const byDefault = runDispatches({ repoRoot: root });
  assert.equal(byDefault.total, 12);
  assert.equal(byDefault.tail, 10);
  // Oldest → newest within the window: the two oldest fall off the front.
  assert.deepEqual(byDefault.entries.map((e) => e.dispatchId), [
    'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11', 'd12',
  ]);
  assert.equal(byDefault.summary, '10 of 12 dispatches shown');

  const tailed = runDispatches({ repoRoot: root, tail: 2 });
  assert.deepEqual(tailed.entries.map((e) => e.dispatchId), ['d11', 'd12']);
  assert.equal(tailed.lines.length, 2);
  assert.equal(tailed.summary, '2 of 12 dispatches shown');

  // A window larger than the log is fine; it just shows everything.
  assert.equal(runDispatches({ repoRoot: root, tail: 99 }).entries.length, 12);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => runDispatches({ repoRoot: root, tail: bad }), DispatchesCommandError);
  }
});

test('dispatches: entries are structured data (what --json prints)', (t) => {
  const root = seedLog(t, [requested(), completed(), native({ model_override: 'sonnet' })]);
  const result = runDispatches({ repoRoot: root });

  const payload = JSON.parse(
    JSON.stringify({
      path: result.path,
      total: result.total,
      shown: result.entries.length,
      skipped: result.skipped,
      entries: result.entries,
    }),
  ) as { path: string; total: number; shown: number; skipped: number; entries: Record<string, unknown>[] };

  assert.equal(payload.path, '.fadeno/dispatches.jsonl');
  assert.equal(payload.total, 2);
  assert.equal(payload.shown, 2);
  assert.equal(payload.skipped, 0);
  assert.deepEqual(payload.entries[0], {
    kind: 'command',
    // Unversioned two-row evidence: readable, and honest that it carries no
    // stamp rather than being backfilled with one it was never written with.
    format: null,
    legacy: false,
    timestamp: '2026-08-12T12:00:00.000Z',
    dispatchId: 'd1',
    archetype: 'worker',
    role: null,
    agentType: null,
    resolution: 'loadout',
    loadout: 'main',
    loadoutSource: 'default',
    executor: 'echo-worker',
    model: 'opus',
    modelOverride: null,
    reasoningEffort: null,
    target: null,
    provider: null,
    transport: 'command',
    promptSource: 'stdin',
    promptSnapshot: SNAPSHOT,
    promptSha256: 'a'.repeat(64),
    relayAttested: null,
    writeAccess: null,
    completed: true,
    exitCode: 0,
    signal: null,
    durationMs: 42,
    outputSha256: 'c'.repeat(64),
    error: null,
  });
  assert.equal(payload.entries[1]!.kind, 'native');
  assert.equal(payload.entries[1]!.modelOverride, 'sonnet');
});

test('dispatches: pre-dispatch_id rows read as [legacy] entries, not unreadable ones', (t) => {
  const root = seedLog(t, [
    legacyRow(),
    // Real logs from that era also recorded --executor dispatches with no
    // archetype at all, and later ones grew a `transport`.
    legacyRow({
      timestamp: '2026-08-11T04:12:34.209Z',
      archetype: null,
      resolution: 'executor-flag',
      loadout: null,
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

  // The whole point: these stop being "unreadable rows skipped".
  assert.equal(result.skipped, 0);
  assert.equal(result.skippedNewerFormat, 0);
  assert.equal(result.total, 3);
  assert.deepEqual(result.lines, [
    '2026-08-10T22:23:15.949Z  [command]  worker → grok-worker (grok-4.6)  ' +
      'exit 0 in 17444ms  [legacy]',
    // No archetype recorded → the existing `(none)` placeholder, not a guess.
    '2026-08-11T04:12:34.209Z  [command]  (none) → opus-high-readonly (opus)  ' +
      'exit 0 in 582698ms  [legacy]',
    '2026-08-12T17:16:01.303Z  [command]  worker → luna-xhigh (gpt-5.6-luna)  ' +
      'via command  exit 0 in 46987ms  [legacy]',
  ]);
  assert.equal(result.summary, '3 of 3 dispatches shown');

  const entry = result.entries[0]!;
  assert.equal(entry.kind, 'command');
  assert.equal(entry.legacy, true);
  assert.equal(entry.format, null); // predates the stamp; never backfilled
  assert.equal(entry.dispatchId, null); // that writer minted no correlation id
  assert.equal(entry.completed, true); // the row IS the outcome
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.durationMs, 17444);
  assert.equal(entry.outputSha256, 'f'.repeat(64));
  assert.equal(entry.loadout, 'grok-worker');
  assert.equal(entry.loadoutSource, 'local');
  assert.equal(entry.promptSnapshot, null); // that era wrote no snapshot file
});

test('dispatches: a legacy row missing identity renders ? rather than being dropped', (t) => {
  // Best-effort means best-effort: an outcome plus a timestamp and one scrap
  // of identity is still evidence that a dispatch happened.
  const root = seedLog(t, [
    { timestamp: '2026-08-09T01:00:00.000Z', executor: 'mystery-worker', exit_code: null },
    // No identity at all → not a dispatch row, and not read as one.
    { timestamp: '2026-08-09T02:00:00.000Z', exit_code: 0 },
    // An outcome-less object is some other row kind, not a legacy dispatch.
    { timestamp: '2026-08-09T03:00:00.000Z', executor: 'mystery-worker' },
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.lines, [
    '2026-08-09T01:00:00.000Z  [command]  (none) → mystery-worker  exit ?  [legacy]',
  ]);
});

test('dispatches: rows from a newer format are counted apart from unreadable ones', (t) => {
  const root = seedLog(t, [
    requested(),
    completed(),
    // A future major re-spells what is already here, so this reader sets the
    // row aside instead of misreading fields it only thinks it recognizes.
    { format: '1.0', timestamp: '2026-09-01T09:00:00.000Z', event: 'dispatch_requested', dispatch_id: 'future' },
    { format: '2.3', timestamp: '2026-09-01T09:01:00.000Z', event: 'something_new' },
    'not json at all', // genuine damage, counted separately
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 1);
  assert.equal(result.skippedNewerFormat, 2);
  assert.equal(result.skipped, 1); // the newer rows never inflate this count
  assert.equal(
    result.summary,
    '1 of 1 dispatch shown  (1 unreadable row skipped)  (2 rows from a newer format skipped)',
  );

  // Distinct wording when only the version is the problem: nothing here needs
  // repairing, so the summary must not send anyone looking for damage.
  const onlyNewer = seedLog(t, [{ format: '1.0', timestamp: '2026-09-01T09:00:00.000Z', event: 'x' }]);
  assert.equal(
    runDispatches({ repoRoot: onlyNewer }).summary,
    'No dispatches recorded in .fadeno/dispatches.jsonl.  (1 row from a newer format skipped)',
  );
});

test('dispatches: an unknown minor within the known major is read best-effort', (t) => {
  // Minor bumps add fields; they do not re-spell the ones already here, so a
  // reader one release behind must keep reading rather than go blind.
  const root = seedLog(t, [
    requested({ format: '0.9', dispatch_id: 'dm' }),
    completed({ format: '0.9', dispatch_id: 'dm', some_future_field: 'ignored' }),
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.skippedNewerFormat, 0);
  assert.equal(result.entries[0]!.format, '0.9');
  assert.equal(result.entries[0]!.completed, true);
  assert.equal(result.entries[0]!.exitCode, 0);
});

test('dispatches: a log spanning every format generation renders in append order', (t) => {
  const root = seedLog(t, [
    legacyRow(), // pre-dispatch_id: no format, no event
    native(), // unversioned hook row
    requested({ dispatch_id: 'd7', timestamp: '2026-08-12T12:05:00.000Z' }), // unversioned pair
    completed({ dispatch_id: 'd7', timestamp: '2026-08-12T12:05:01.000Z' }),
    { format: '3.0', timestamp: '2026-08-12T12:06:00.000Z', event: 'dispatch_requested', dispatch_id: 'd8' },
    requested({ format: DISPATCHES_FORMAT, dispatch_id: 'd9', timestamp: '2026-08-12T12:07:00.000Z' }),
    completed({ format: DISPATCHES_FORMAT, dispatch_id: 'd9', timestamp: '2026-08-12T12:07:02.000Z' }),
    'torn write',
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 4);
  assert.equal(result.skipped, 1);
  assert.equal(result.skippedNewerFormat, 1);
  // Append order, never re-sorted by timestamp, across all three generations.
  assert.deepEqual(
    result.entries.map((e) => [e.kind, e.format, e.legacy, e.dispatchId]),
    [
      ['command', null, true, null],
      ['native', null, false, null],
      ['command', null, false, 'd7'],
      ['command', DISPATCHES_FORMAT, false, 'd9'],
    ],
  );
  assert.equal(result.lines[0]!.endsWith('  [legacy]'), true);
  assert.equal(result.lines.some((line) => line.includes('[legacy]') && line.includes('[native]')), false);
  assert.equal(
    result.summary,
    '4 of 4 dispatches shown  (1 unreadable row skipped)  (1 row from a newer format skipped)',
  );
});

test('dispatches: a missing or empty log is a friendly answer, not an error', (t) => {
  const bare = tempRepo(t);
  const missing = runDispatches({ repoRoot: bare });
  assert.equal(missing.exists, false);
  assert.equal(missing.total, 0);
  assert.deepEqual(missing.entries, []);
  assert.deepEqual(missing.lines, []);
  assert.equal(missing.summary, 'No dispatches recorded yet (.fadeno/dispatches.jsonl absent).');

  const empty = seedLog(t, []);
  const result = runDispatches({ repoRoot: empty });
  assert.equal(result.exists, true);
  assert.equal(result.total, 0);
  assert.deepEqual(result.lines, []);
  assert.equal(result.summary, 'No dispatches recorded in .fadeno/dispatches.jsonl.');
});

test('dispatches: malformed rows are counted and skipped, never fatal', (t) => {
  const root = seedLog(t, [
    requested(),
    '{"timestamp":"2026-08-12T12:00:30.000Z","event":"dispatch_req', // torn write
    'not json at all',
    '["an","array"]', // valid JSON, not an evidence object
    completed(),
    { timestamp: '2026-08-12T12:04:00.000Z', event: 'something_else' }, // unknown kind
    requested({ dispatch_id: undefined, archetype: 'judge' }), // uncorrelatable
    native(),
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.skipped, 5);
  assert.equal(result.total, 2); // the valid pair + the native row
  assert.deepEqual(result.entries.map((e) => e.kind), ['command', 'native']);
  assert.equal(result.entries[0]!.completed, true);
  assert.equal(result.summary, '2 of 2 dispatches shown  (5 unreadable rows skipped)');
});

test('dispatches: a completion that records a spawn error surfaces it', (t) => {
  const root = seedLog(t, [
    requested({ dispatch_id: 'd9', executor: 'missing-bin' }),
    completed({
      dispatch_id: 'd9',
      executor: 'missing-bin',
      exit_code: null,
      signal: 'SIGKILL',
      duration_ms: 7,
      error: 'spawnSync missing-bin ENOENT',
    }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries[0]!.completed, true);
  assert.equal(result.entries[0]!.error, 'spawnSync missing-bin ENOENT');
  assert.match(result.lines[0]!, /exit \? \(SIGKILL\) in 7ms {2}\[error: spawnSync missing-bin ENOENT]/);
});

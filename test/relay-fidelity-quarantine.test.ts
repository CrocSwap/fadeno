import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { DISPATCHES_FILE, DISPATCHES_FORMAT } from '../src/commands/dispatch.ts';
import {
  DispatchesCommandError,
  runDispatches,
  runDispatchesMerge,
  runDispatchesOutput,
} from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/**
 * The quarantine half of the relay-fidelity fix.
 *
 * `dispatch.ts` refuses a defecting relay before the spawn; these tests cover
 * everything that has to happen when a `relay_attested: false` dispatch
 * EXISTS anyway — because a person passed `--allow-relay-mismatch`, or because
 * the row was written by a build that only warned.
 *
 * The mechanism under test is the CHANNEL, not the wording. `onEcho` is
 * `console.error`, the verdict goes to stdout, and the dispatch-proxy contract
 * states that stderr "is discarded along with a timed-out call" — so on the
 * recover-by-tag path (the exact path a timed-out dispatch takes) a
 * stderr-only warning does not reach the reader at all. That is how the E25
 * dispatch shipped a success verdict over an altered prompt. The finding
 * therefore has to travel in the bytes.
 */

const OUTPUT_SNAP = '.fadeno/local/outputs/worker-aaaaaaaa.md';
const REPORT = 'the executor report\n';

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: DISPATCHES_FORMAT,
    timestamp: '2026-09-06T12:00:00.000Z',
    event: 'dispatch_requested',
    dispatch_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    archetype: 'worker',
    role: null,
    resolution: 'repo',
    dial: { model: 'echo-worker' },
    executor: 'echo-worker',
    model: 'echo-worker',
    model_id: 'echo-worker',
    reasoning_effort: 'default',
    host: 'standalone',
    harness: 'codex',
    provider: 'openai',
    transport: 'command',
    prompt_source: 'stdin',
    prompt_snapshot: '.fadeno/local/prompts/worker-aaaaaaaa.md',
    prompt_sha256: 'a'.repeat(64),
    caller_prompt_sha256: 'b'.repeat(64),
    command: ['node', '-e', '0'],
    command_sha256: 'c'.repeat(64),
    output_snapshot: OUTPUT_SNAP,
    tag: 'worker-e25',
    ...over,
  };
}

/**
 * A completed dispatch whose relay defected, with its output snapshot on
 * disk — the shape a caller recovers by tag after a timeout.
 */
function seedTaintedDispatch(t: TestContext, over: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const rows = [
    row({ relay_attested: false, ...over }),
    row({
      event: 'dispatch_completed',
      relay_attested: false,
      exit_code: 0,
      outcome: 'ok',
      duration_ms: 42,
      output_sha256: sha256Hex(REPORT),
      output_bytes: REPORT.length,
      ...over,
    }),
  ];
  writeFileSync(join(root, DISPATCHES_FILE), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const outAbs = join(root, ...OUTPUT_SNAP.split('/'));
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, REPORT, 'utf8');
  return root;
}

/**
 * The stderr-loss regression, stated as a property of the returned bytes: a
 * reader who sees ONLY what `--output` writes to stdout still learns the
 * report is tainted.
 */
test('dispatches --output carries the fidelity failure in the returned BYTES, not just on stderr', (t) => {
  const root = seedTaintedDispatch(t, { relay_mismatch_allowed: true });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-e25' });

  assert.equal(result.relayAttested, false);
  assert.equal(result.relayMismatchAllowed, true);
  assert.match(result.bytes, /RELAY FIDELITY FAILED/);
  assert.match(result.bytes, /--allow-relay-mismatch/);
  assert.match(result.bytes, /QUARANTINE IT/);
  // The banner leads; the report is intact behind it and unedited.
  assert.ok(result.bytes.startsWith('!! RELAY FIDELITY FAILED'), result.bytes.slice(0, 80));
  assert.ok(result.bytes.endsWith(REPORT));
  assert.equal(result.snapshotBytes, REPORT);

  // And the attestation still describes the EXECUTOR's bytes. Hashing the
  // banner in would turn every quarantined dispatch into a spurious
  // "snapshot sha does not match the completion row".
  assert.equal(result.attested, 'match');
});

test('an untainted dispatch gets no banner at all — the bytes stay verbatim', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, DISPATCHES_FILE),
    `${[
      JSON.stringify(row()),
      JSON.stringify(row({ event: 'dispatch_completed', exit_code: 0, outcome: 'ok', duration_ms: 1, output_sha256: sha256Hex(REPORT), output_bytes: REPORT.length })),
    ].join('\n')}\n`,
    'utf8',
  );
  const outAbs = join(root, ...OUTPUT_SNAP.split('/'));
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, REPORT, 'utf8');

  const result = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-e25' });
  assert.equal(result.relayNotice, null);
  assert.equal(result.bytes, REPORT);
  assert.equal(result.relayAttested, null);
});

/**
 * A dispatch recovered while it is still open is the case the reader exists
 * for, and it is also the case where nobody has looked at the work yet — so
 * the warning matters most there. The verdict is on the REQUEST row, decided
 * before the spawn, which is why it is available with no completion row.
 */
test('the banner is there before the completion row lands', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), `${JSON.stringify(row({ relay_attested: false, relay_mismatch_allowed: true }))}\n`, 'utf8');
  const outAbs = join(root, ...OUTPUT_SNAP.split('/'));
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, 'partial output', 'utf8');

  const result = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-e25' });
  assert.equal(result.attested, 'incomplete');
  assert.match(result.bytes, /RELAY FIDELITY FAILED/);
  assert.ok(result.bytes.endsWith('partial output'));
});

/**
 * Merging is the point of no return: the diff stops being something the ledger
 * describes and becomes something the working tree contains. So it takes its
 * own override — a second, later decision by a possibly different person.
 */
test('dispatches --merge refuses a tainted dispatch without a second explicit override', (t) => {
  const root = seedTaintedDispatch(t, {
    relay_mismatch_allowed: true,
    primary_merge: { status: 'unresolved', detail: 'conflicts', conflicts: ['src/a.ts'] },
    workspace_retained: true,
    workspace: '.fadeno/local/isolated/aaaaaaaa',
  });
  assert.throws(
    () => runDispatchesMerge({ repoRoot: root, tag: 'worker-e25' }),
    (err: unknown) =>
      err instanceof DispatchesCommandError &&
      /RELAY FIDELITY FAILED/.test((err as Error).message) &&
      /--allow-relay-mismatch/.test((err as Error).message) &&
      /Nothing was applied/.test((err as Error).message),
  );

  // With the override the relay gate is passed — the merge then fails on its
  // own mechanics (this fixture has no worktree on disk), which is exactly
  // what proves the flag moved the refusal and nothing else.
  assert.throws(
    () => runDispatchesMerge({ repoRoot: root, tag: 'worker-e25', allowRelayMismatch: true }),
    (err: unknown) => err instanceof DispatchesCommandError && /is gone; there is nothing to merge/.test((err as Error).message),
  );
});

/**
 * Old rows. `relay_attested: false` was warn-only until this change, so rows
 * written then have no `relay_mismatch_allowed` — nobody was ever asked. They
 * must still read cleanly, and they must still be quarantined: the finding did
 * not become less true because the build that recorded it did nothing about it.
 */
test('a pre-refusal row reads cleanly and is still quarantined, without claiming an override', (t) => {
  const root = seedTaintedDispatch(t);
  const out = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-e25' });
  assert.equal(out.relayMismatchAllowed, false);
  assert.match(out.bytes, /RELAY FIDELITY FAILED/);
  assert.match(out.bytes, /predates the `relay_fidelity` refusal/);
  assert.ok(!out.bytes.includes('under --allow-relay-mismatch'));

  const listed = runDispatches({ repoRoot: root });
  assert.equal(listed.total, 1);
  assert.equal(listed.entries[0]!.relayAttested, false);
  assert.equal(listed.entries[0]!.relayMismatchAllowed, false);
});

/**
 * The listing said `[relay_attested: false]` in the same register as
 * `[relay_attested: true]`, which is how the loudest fact on the line read as
 * a footnote. The machine token is kept inside the louder phrasing so anything
 * grepping the old string still finds it.
 */
test('the dispatches listing renders a defection louder than an attestation', (t) => {
  const root = seedTaintedDispatch(t, { relay_mismatch_allowed: true });
  const line = runDispatches({ repoRoot: root }).lines[0]!;
  assert.ok(line.includes('RELAY FIDELITY FAILED'), line);
  assert.ok(line.includes('relay_attested: false'), line);
  assert.ok(line.includes('relay_mismatch_allowed: true'), line);
});

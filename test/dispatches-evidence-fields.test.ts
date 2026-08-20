import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import { runDispatches, type DispatchEntry } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/**
 * Fields the evidence reader used to drop on the floor.
 *
 * Two groups, one defect. `session_effort` and `lane_reason` have been on
 * `host_delivery` and `host_refused` rows since the lane predicate shipped and
 * had no home on `DispatchEntry`, so they were invisible in both the rendered
 * view and `--json` (roadmap horizon 9, item 2). `primary_merge` is new: when
 * a shadow pair is selected BOTH arms now run in isolated worktrees, and the
 * primary's diff is merged back into the caller's tree at the end — the one
 * part of a paired dispatch that changes the workspace the caller is looking
 * at, and therefore the one that must never be silent.
 *
 * Every fixture here is hand-authored JSONL rather than a real dispatch. This
 * is a READER: the honest test of it is evidence bytes it did not write, and
 * hand-authored rows let it be tested against a contract before, and
 * independently of, the writer that produces it.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function seed(t: TestContext, rows: Array<Record<string, unknown>>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return root;
}

/** What `fadeno dispatches --json` puts on stdout, from the real CLI. */
function cliJson(root: string): { entries: DispatchEntry[] } {
  const stdout = execFileSync(process.execPath, [CLI, 'dispatches', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return JSON.parse(stdout) as { entries: DispatchEntry[] };
}

function hostDelivery(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: '1.0',
    timestamp: '2026-08-20T10:00:00.000Z',
    event: 'host_delivery',
    archetype: 'worker',
    agent_type: 'worker',
    executor: 'luna',
    model: 'opus',
    transport: 'host',
    reasoning_effort: 'medium',
    effort_pinned: true,
    session_effort: 'medium',
    lane_reason: 'session effort matches the pin',
    prompt_sha256: 'a'.repeat(64),
    ...over,
  };
}

function hostRefused(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: '1.0',
    timestamp: '2026-08-20T10:05:00.000Z',
    event: 'host_refused',
    archetype: 'worker',
    agent_type: 'worker',
    refusal: {
      predicate: 'restart_required',
      message: 'no lane for terra@xhigh; session effort medium: no command fallback',
    },
    executor: 'terra@xhigh',
    model: 'terra',
    session_effort: 'medium',
    lane_reason: 'no command fallback',
    prompt_sha256: 'b'.repeat(64),
    ...over,
  };
}

const PAIR_ID = 'pair0123456789ab';
const PRIMARY_DIFF = '.fadeno/local/diffs/primary-1a2b3c4d.diff';

function primaryRequested(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: '1.0',
    timestamp: '2026-08-20T11:00:00.000Z',
    event: 'dispatch_requested',
    dispatch_id: 'prim0123456789ab',
    archetype: 'worker',
    executor: 'echo-worker',
    model: 'echo-worker',
    transport: 'command',
    prompt_sha256: 'c'.repeat(64),
    ...over,
  };
}

function primaryCompleted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: '1.0',
    timestamp: '2026-08-20T11:00:12.000Z',
    event: 'dispatch_completed',
    dispatch_id: 'prim0123456789ab',
    archetype: 'worker',
    executor: 'echo-worker',
    exit_code: 0,
    duration_ms: 12000,
    output_bytes: 2048,
    output_sha256: 'd'.repeat(64),
    pair_id: PAIR_ID,
    baseline_commit: 'e'.repeat(40),
    diff_snapshot: PRIMARY_DIFF,
    diff_bytes: 640,
    ...over,
  };
}

// --- group 1: session_effort / lane_reason -------------------------------

test('a host_delivery row surfaces session_effort and lane_reason', (t) => {
  const root = seed(t, [hostDelivery()]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  const entry = entries[0]!;
  assert.equal(entry.kind, 'host');
  assert.equal(entry.sessionEffort, 'medium');
  assert.equal(entry.laneReason, 'session effort matches the pin');
  assert.match(lines[0]!, /\[session effort: medium\]/);
  assert.match(lines[0]!, /\[lane: session effort matches the pin\]/);
});

test('a host_refused row surfaces both, alongside the refusal it already carried', (t) => {
  const root = seed(t, [hostRefused()]);
  const { entries, lines, skipped } = runDispatches({ repoRoot: root });

  assert.equal(skipped, 0, 'a refusal row is evidence, never an unreadable line');
  const entry = entries[0]!;
  assert.equal(entry.refusal!.predicate, 'restart_required');
  assert.equal(entry.sessionEffort, 'medium');
  assert.equal(entry.laneReason, 'no command fallback');
  // The refusal message repeats both in prose; the point of the fields is that
  // a reader can group on them without parsing that sentence.
  assert.match(lines[0]!, /\[refused: restart_required\]/);
  assert.match(lines[0]!, /\[session effort: medium\]/);
  assert.match(lines[0]!, /\[lane: no command fallback\]/);
});

test('a row that states neither renders neither: absent is not a claim', (t) => {
  const root = seed(t, [
    hostDelivery({ session_effort: undefined, lane_reason: undefined }),
    primaryRequested(),
    primaryCompleted(),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  for (const entry of entries) {
    assert.equal(entry.sessionEffort, null);
    assert.equal(entry.laneReason, null);
  }
  for (const line of lines) {
    assert.doesNotMatch(line, /session effort/);
    assert.doesNotMatch(line, /\[lane:/);
  }
});

test('lane fields fold from a completion row when the request row was silent', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ session_effort: 'xhigh', lane_reason: 'shadow pair forces the command lane' }),
  ]);
  const { entries } = runDispatches({ repoRoot: root });

  assert.equal(entries.length, 1, 'still one logical dispatch');
  assert.equal(entries[0]!.sessionEffort, 'xhigh');
  assert.equal(entries[0]!.laneReason, 'shadow pair forces the command lane');
});

// --- group 2: the primary arm's merge-back --------------------------------

test('a paired primary records a clean merge-back into the caller tree', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ primary_merge: { status: 'clean', diff_snapshot: PRIMARY_DIFF } }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.deepEqual(entries[0]!.primaryMerge, { status: 'clean', diffSnapshot: PRIMARY_DIFF });
  assert.match(lines[0]!, /\[primary merged: clean\]/);
  assert.doesNotMatch(lines[0]!, /CONFLICTED/);
  assert.doesNotMatch(lines[0]!, /shadow-apply/);
});

test('a clean merge-back that changed nothing says so', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      diff_bytes: 0,
      primary_merge: {
        status: 'clean',
        diff_snapshot: PRIMARY_DIFF,
        detail: 'the primary made no changes',
      },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.primaryMerge!.detail, 'the primary made no changes');
  assert.match(lines[0]!, /\[primary merged: clean\]/);
  assert.match(lines[0]!, /\[merge detail: the primary made no changes\]/);
});

test('a conflicted merge-back names the partial state and the recovery command', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      primary_merge: {
        status: 'conflicted',
        diff_snapshot: PRIMARY_DIFF,
        // git's stderr, verbatim and multi-line, which is how the writer has it.
        detail: 'error: patch failed: src/lib/lane.ts:41\nerror: src/lib/lane.ts: patch does not apply',
      },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  const merge = entries[0]!.primaryMerge!;
  assert.equal(merge.status, 'conflicted');
  assert.equal(merge.diffSnapshot, PRIMARY_DIFF);
  assert.match(merge.detail!, /^error: patch failed/);

  const [line] = lines;
  assert.match(line!, /\[primary merge CONFLICTED — nothing reverted, the tree may be partially applied\]/);
  // The remedy is on the line, keyed to the pair rather than to either arm.
  assert.match(line!, /\[recover: fadeno shadow-apply pair0123 --arm primary\]/);
  // Free-form stderr is bounded to one line: this view is one line per entry.
  assert.match(line!, /\[merge detail: error: patch failed: src\/lib\/lane\.ts:41\]/);
  assert.doesNotMatch(line!, /does not apply/);
  assert.equal(line!.includes('\n'), false, 'multi-line detail must not break the one-line-per-entry view');
});

test('a conflicted row with no pair_id still offers a runnable recovery', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      pair_id: undefined,
      primary_merge: { status: 'conflicted', diff_snapshot: PRIMARY_DIFF },
    }),
  ]);
  const { lines } = runDispatches({ repoRoot: root });

  // `shadow-apply` resolves either arm's dispatch id as well as a pair id.
  assert.match(lines[0]!, /\[recover: fadeno shadow-apply prim0123 --arm primary\]/);
});

test('an absent primary_merge is not applicable, and no status is synthesized for it', (t) => {
  const root = seed(t, [primaryRequested(), primaryCompleted(), hostDelivery()]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  for (const entry of entries) assert.equal(entry.primaryMerge, null);
  for (const line of lines) assert.doesNotMatch(line, /primary merge/i);
});

test('a merge object with no status is no claim at all', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ primary_merge: { diff_snapshot: PRIMARY_DIFF } }),
  ]);
  const { entries, lines, skipped } = runDispatches({ repoRoot: root });

  assert.equal(skipped, 0, 'a malformed sub-object never costs the whole row');
  assert.equal(entries[0]!.primaryMerge, null);
  assert.equal(entries[0]!.exitCode, 0, 'the rest of the completion row still reads');
  assert.doesNotMatch(lines[0]!, /primary merge/i);
});

test('a status this reader does not know renders verbatim rather than vanishing', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ primary_merge: { status: 'deferred', diff_snapshot: PRIMARY_DIFF } }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.primaryMerge!.status, 'deferred');
  assert.match(lines[0]!, /\[primary merge: deferred\]/);
});

test('a literal "skipped" status is carried but never rendered — omission says the same thing', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ primary_merge: { status: 'skipped' } }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.primaryMerge!.status, 'skipped', 'read, not dropped');
  assert.doesNotMatch(lines[0]!, /primary merge/i, 'and not louder than the rows that omit it');
});

// --- the same fields, through the real `--json` surface -------------------

test('fadeno dispatches --json carries every one of these fields', (t) => {
  const root = seed(t, [
    hostDelivery(),
    hostRefused(),
    primaryRequested(),
    primaryCompleted({
      session_effort: 'xhigh',
      lane_reason: 'shadow pair forces the command lane',
      primary_merge: {
        status: 'conflicted',
        diff_snapshot: PRIMARY_DIFF,
        detail: 'error: patch failed: src/lib/lane.ts:41',
      },
    }),
  ]);
  const { entries } = cliJson(root);

  assert.equal(entries.length, 3);
  const [delivery, refusal, primary] = entries;

  assert.equal(delivery!.sessionEffort, 'medium');
  assert.equal(delivery!.laneReason, 'session effort matches the pin');
  assert.equal(delivery!.primaryMerge, null);

  assert.equal(refusal!.sessionEffort, 'medium');
  assert.equal(refusal!.laneReason, 'no command fallback');
  assert.equal(refusal!.refusal!.predicate, 'restart_required');

  assert.equal(primary!.sessionEffort, 'xhigh');
  assert.equal(primary!.laneReason, 'shadow pair forces the command lane');
  assert.deepEqual(primary!.primaryMerge, {
    status: 'conflicted',
    detail: 'error: patch failed: src/lib/lane.ts:41',
    diffSnapshot: PRIMARY_DIFF,
  });
});

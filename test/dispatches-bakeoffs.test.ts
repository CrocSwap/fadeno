import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DISPATCHES_FILE, DISPATCHES_FORMAT } from '../src/commands/dispatch.ts';
import { runDispatches, runDispatchesBakeoffs } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

function seedLog(root: string, rows: Array<Record<string, unknown> | string>): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`, 'utf8');
}

function requested(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: DISPATCHES_FORMAT,
    timestamp: '2026-08-12T12:00:00.000Z',
    event: 'dispatch_requested',
    dispatch_id: 'primary-11111111-1111-1111-1111-111111111111',
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
    prompt_snapshot: '.fadeno/local/prompts/worker-aaaaaaaa.md',
    prompt_sha256: 'a'.repeat(64),
    command: ['node', '-e', '0'],
    output_snapshot: '.fadeno/local/outputs/worker-aaaaaaaa.md',
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
    output_bytes: 123,
    ...over,
  };
}

function shadowRequested(primaryId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: DISPATCHES_FORMAT,
    timestamp: '2026-08-12T12:00:10.000Z',
    event: 'dispatch_requested',
    dispatch_id: 'shadow-22222222-2222-2222-2222-222222222222',
    archetype: 'worker',
    role: null,
    resolution: 'shadow',
    shadow: true,
    primary_dispatch_id: primaryId,
    shadow_source: 'flag',
    dial: { model: 'grok-worker' },
    executor: 'grok-worker',
    model: 'grok-4',
    model_id: 'grok-4',
    driver: 'openai',
    provider: 'openai',
    transport: 'command',
    prompt_source: 'stdin',
    prompt_snapshot: '.fadeno/local/prompts/worker-aaaaaaaa.md',
    prompt_sha256: 'a'.repeat(64),
    gate_eligible: false,
    output_snapshot: '.fadeno/local/outputs/shadow-22222222.md',
    command: ['node', '-e', '0'],
    ...over,
  };
}

function shadowCompleted(primaryId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...shadowRequested(primaryId),
    event: 'dispatch_completed',
    exit_code: 0,
    duration_ms: 55,
    output_sha256: 'd'.repeat(64),
    output_bytes: 99,
    diff_snapshot: '.fadeno/local/outputs/shadow-22222222.diff',
    diff_bytes: 45,
    ...over,
  };
}

const PRIMARY_ID = 'primary-11111111-1111-1111-1111-111111111111';
const SHADOW_ID = 'shadow-22222222-2222-2222-2222-222222222222';

test('dispatches: shadow rows render with [shadow of <primaryId8>] and json fields', (t) => {
  const root = tempRepo(t);
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64) }),
    completed({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64), output_bytes: 123, workspace_changed: false, }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64) }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64), output_bytes: 99, diff_bytes: 45, workspace_changed: false }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 2);
  const primary = result.entries.find((e) => e.dispatchId === PRIMARY_ID)!;
  const shadow = result.entries.find((e) => e.dispatchId === SHADOW_ID)!;
  assert.equal(primary.shadow, false);
  assert.equal(primary.primaryDispatchId, null);
  assert.equal(shadow.shadow, true);
  assert.equal(shadow.primaryDispatchId, PRIMARY_ID);
  assert.equal(shadow.diffBytes, 45);
  assert.equal(shadow.diffSnapshot, '.fadeno/local/outputs/shadow-22222222.diff');
  assert.equal(shadow.gateEligible, false);
  const shadowLine = result.lines.find((l) => l.includes('[shadow of'))!;
  assert.match(shadowLine, /\[shadow of primary-/);
  assert.doesNotMatch(shadowLine, /\[no workspace change\]/);
  const primaryLine = result.lines.find((l) => !l.includes('[shadow of'))!;
  assert.match(primaryLine, /\[no workspace change\]/);
});

test('dispatches --json: shadow entries carry shadow, primaryDispatchId, diffBytes', (t) => {
  const root = tempRepo(t);
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID }),
    completed({ dispatch_id: PRIMARY_ID, output_bytes: 10 }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, diff_bytes: 0, output_bytes: 5 }),
  ]);
  const result = runDispatches({ repoRoot: root });
  const payload = JSON.parse(JSON.stringify({ entries: result.entries })) as { entries: Array<Record<string, unknown>> };
  const shadowJson = payload.entries.find((e) => e.dispatchId === SHADOW_ID)!;
  assert.equal(shadowJson.shadow, true);
  assert.equal(shadowJson.primaryDispatchId, PRIMARY_ID);
  assert.equal(shadowJson.diffBytes, 0);
  const primaryJson = payload.entries.find((e) => e.dispatchId === PRIMARY_ID)!;
  assert.equal(primaryJson.shadow, false);
  assert.equal(primaryJson.primaryDispatchId, null);
  assert.equal(primaryJson.diffBytes, null);
  // also check diffBytes null vs 0 discrimination via lines
  const diffLine = result.lines.find(l=>l.includes('[shadow of'))!;
  assert.ok(diffLine);
});

test('dispatches comparisons: pairs by challenger, prompt sha mismatch flag, orphan marked', (t) => {
  const root = tempRepo(t);
  const otherShadowId = 'shadow-33333333-3333-3333-3333-333333333333';
  const orphanShadowId = 'shadow-44444444-4444-4444-4444-444444444444';
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64), executor: 'base-worker', model: 'base-worker', model_id: 'base-worker' }),
    completed({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64), executor: 'base-worker', model: 'base-worker', output_bytes: 100, exit_code: 0 }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64), executor: 'challenger-x', model: 'challenger-x' }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64), executor: 'challenger-x', model: 'challenger-x', output_bytes: 90, diff_bytes: 10, exit_code: 0 }),
    shadowRequested(PRIMARY_ID, { dispatch_id: otherShadowId, prompt_sha256: 'b'.repeat(64), executor: 'challenger-x', model: 'challenger-x' }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: otherShadowId, prompt_sha256: 'b'.repeat(64), executor: 'challenger-x', model: 'challenger-x', output_bytes: 80, diff_bytes: 5, exit_code: 1 }),
    shadowRequested('missing-primary-99999999-9999-9999-9999-999999999999', { dispatch_id: orphanShadowId, executor: 'lonely-challenger', model: 'lonely-challenger' }),
    shadowCompleted('missing-primary-99999999-9999-9999-9999-999999999999', { dispatch_id: orphanShadowId, executor: 'lonely-challenger', model: 'lonely-challenger', output_bytes: 70, diff_bytes: 0 }),
  ]);
  const comps = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(comps.totalPairs, 3);
  const challengerX = comps.groups.find((g) => g.challenger === 'challenger-x')!;
  assert.equal(challengerX.pairs.length, 2);
  const mismatched = challengerX.pairs.find((p) => p.shadowId === otherShadowId)!;
  assert.equal(mismatched.promptShaMismatch, true);
  const matched = challengerX.pairs.find((p) => p.shadowId === SHADOW_ID)!;
  assert.equal(matched.promptShaMismatch, false);
  const lonely = comps.groups.find((g) => g.challenger === 'lonely-challenger')!;
  assert.equal(lonely.pairs.length, 1);
  assert.equal(lonely.pairs[0]!.orphan, true);
  const lines = comps.lines.join('\n');
  assert.match(lines, /PROMPT SHA MISMATCH/);
  assert.match(lines, /\[orphan: primary missing\]/);
  assert.match(comps.summary, /3 shadow pairs/);
});

test('dispatches comparisons: ModelComparison artifact frontmatter parse + tally', (t) => {
  const root = tempRepo(t);
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, executor: 'base-worker', model: 'base-worker', prompt_sha256: 'a'.repeat(64) }),
    completed({ dispatch_id: PRIMARY_ID, executor: 'base-worker', model: 'base-worker', prompt_sha256: 'a'.repeat(64), output_bytes: 10 }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, executor: 'challenger-x', model: 'challenger-x', prompt_sha256: 'a'.repeat(64) }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, executor: 'challenger-x', model: 'challenger-x', prompt_sha256: 'a'.repeat(64), output_bytes: 9, diff_bytes: 2 }),
  ]);
  mkdirSync(join(root, '.fadeno', 'bakeoffs'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'bakeoffs', 'run-01.md'), `---
kind: Bakeoff
baseline: base-worker
challenger: challenger-x
verdict: prefer_challenger
date: 2026-08-13
dispatch_ids: ["${PRIMARY_ID}", "${SHADOW_ID}"]
---
## Criteria
correctness: challenger better
scope discipline: ok
instruction adherence: ok
style fit: ok

## Model traits
- **output_volume** (more: challenger): the challenger wrote more for the same task.

## Confounds
delivery transport: command vs command
tool availability: same
effort pinning: same
isolation: detached-HEAD worktree vs dirty workspace — dirty case
## Shared blind spots
none identified

`, 'utf8');
  writeFileSync(join(root, '.fadeno', 'bakeoffs', 'run-02.md'), `---
kind: Bakeoff
baseline: base-worker
challenger: challenger-x
verdict: prefer_baseline
date: 2026-08-13
---
## Criteria
correctness: baseline better

## Model traits
- **output_volume** (more: challenger): the challenger wrote more for the same task.

## Confounds
delivery transport: same
tool availability: same
effort pinning: same
isolation: clean worktree
## Shared blind spots
none identified

`, 'utf8');
  writeFileSync(join(root, '.fadeno', 'bakeoffs', 'run-03.md'), `---
kind: Bakeoff
baseline: base-worker
challenger: challenger-x
verdict: tie
date: 2026-08-13
---
## Criteria
tie

## Model traits
- **output_volume** (more: challenger): the challenger wrote more for the same task.

## Confounds
confounds here
## Shared blind spots
none identified

`, 'utf8');
  const comps = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(comps.totalComparisons, 3);
  const group = comps.groups.find((g) => g.challenger === 'challenger-x')!;
  assert.equal(group.tally.preferChallenger, 1);
  assert.equal(group.tally.preferBaseline, 1);
  assert.equal(group.tally.tieOrInconclusive, 1);
  assert.equal(group.tally.pairs, 1);
  assert.equal(group.tally.comparisons, 3);
  const lines = comps.lines.join('\n');
  assert.match(lines, /prefer_challenger/);
  assert.match(lines, /prefer_baseline/);
  assert.match(lines, /1 prefer_challenger \/ 1 prefer_baseline \/ 0 graft \/ 1 tie\/inconclusive/);
  const json = JSON.parse(JSON.stringify(comps)) as typeof comps;
  assert.equal(json.groups[0]!.tally.preferChallenger, 1);
});

test('dispatches comparisons: empty states friendly output', (t) => {
  const root = tempRepo(t);
  const comps = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(comps.totalPairs, 0);
  assert.equal(comps.totalComparisons, 0);
  assert.match(comps.lines.join('\n'), /No shadow pairs recorded/);
  assert.match(comps.summary, /No comparisons to show/);
  mkdirSync(join(root, '.fadeno', 'bakeoffs'), { recursive: true });
  const comps2 = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(comps2.totalPairs, 0);
  assert.match(comps2.lines.join('\n'), /No ModelComparison artifacts/);
});

test('dispatches comparisons: missing primary renders orphan not dropped (json)', (t) => {
  const root = tempRepo(t);
  const orphanId = 'shadow-55555555-5555-5555-5555-555555555555';
  seedLog(root, [
    shadowRequested('no-such-primary-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { dispatch_id: orphanId, executor: 'orphan-challenger', model: 'orphan-challenger', prompt_sha256: 'a'.repeat(64) }),
    shadowCompleted('no-such-primary-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { dispatch_id: orphanId, executor: 'orphan-challenger', model: 'orphan-challenger', prompt_sha256: 'a'.repeat(64), output_bytes: 11, diff_bytes: 3 }),
  ]);
  const comps = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(comps.totalPairs, 1);
  assert.equal(comps.groups[0]!.pairs[0]!.orphan, true);
  const payload = JSON.parse(JSON.stringify(comps)) as typeof comps;
  assert.equal(payload.groups[0]!.pairs[0]!.orphan, true);
});

test('dispatches: shadow rows discrimination via --json shadow fields (diffBytes 0 vs null)', (t) => {
  const root = tempRepo(t);
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID }),
    completed({ dispatch_id: PRIMARY_ID, output_bytes: 10 }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, diff_bytes: 0, output_bytes: 5 }),
  ]);
  const result = runDispatches({ repoRoot: root });
  const shadow = result.entries.find(e=>e.dispatchId===SHADOW_ID)!;
  const primary = result.entries.find(e=>e.dispatchId===PRIMARY_ID)!;
  assert.equal(shadow.diffBytes, 0);
  assert.equal(primary.diffBytes, null);
});

// `dispatch.ts` already writes diff_snapshot/diff_bytes onto an --isolated
// primary's own completion row, and the parser already lifts them into
// DispatchEntry (see the round-trip test above) — but DispatchBakeoffPair
// used to drop them on the floor, so a paired --isolated primary rendered no
// diff at all even though the evidence was sitting right there.
test('dispatches comparisons: a paired primary reports its own diff, workspace, and baseline_commit', (t) => {
  const root = tempRepo(t);
  const baselineCommit = 'cafef00d'.repeat(5);
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, executor: 'base-worker', model: 'base-worker' }),
    completed({
      dispatch_id: PRIMARY_ID,
      executor: 'base-worker',
      model: 'base-worker',
      output_bytes: 40,
      // What an --isolated primary's completion row carries: its own diff,
      // plus (only once a shadow actually fired) pair_id/baseline_commit.
      diff_snapshot: '.fadeno/local/outputs/isolated-11111111.diff',
      diff_bytes: 7,
      pair_id: 'pair-primary-diff',
      baseline_commit: baselineCommit,
    }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, pair_id: 'pair-primary-diff', executor: 'challenger-x', model: 'challenger-x' }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, pair_id: 'pair-primary-diff', executor: 'challenger-x', model: 'challenger-x', output_bytes: 30, diff_bytes: 3 }),
  ]);
  const comps = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(comps.totalPairs, 1);
  const pair = comps.groups[0]!.pairs[0]!;
  assert.equal(pair.primary.diffBytes, 7);
  assert.equal(pair.primary.diffSnapshot, '.fadeno/local/outputs/isolated-11111111.diff');
  assert.equal(pair.primary.baselineCommit, baselineCommit);
  // No production writer ever puts `workspace` on a primary row today (only
  // shadow rows retain a worktree), so this reads null — the field exists
  // for when that stops being true, per the design doc's Phase 5 notes.
  assert.equal(pair.primary.workspace, null);
  const line = comps.lines.find((l) => l.includes('primary base-worker'))!;
  // duration_ms defaults to 42 in `completed()`, formatted as "42ms".
  assert.ok(line.includes('primary base-worker (base-worker) exit 0 in 42ms output 40 bytes diff 7 bytes'), line);
  assert.match(line, /vs shadow challenger-x/);
});

// The comparisons loop used to pair solely by `primary_dispatch_id`. Now it
// prefers `pair_id` when both rows carry it, so correlation survives even a
// stale/misleading `primary_dispatch_id` — while a log written before
// pair_id existed (no pair_id anywhere) must still pair by
// primary_dispatch_id, or every pre-Phase-5 pair in a repo's history would
// silently orphan.
test('dispatches comparisons: pairing prefers pair_id, and still falls back for pre-pair_id rows', (t) => {
  const root = tempRepo(t);
  const otherPrimaryId = 'primary-99999999-9999-9999-9999-999999999999';
  seedLog(root, [
    // Two primaries in the log. The shadow's stale primary_dispatch_id
    // points at the FIRST one, but its pair_id correlates it with the
    // SECOND — pair_id must win, or the wrong primary gets compared.
    requested({ dispatch_id: PRIMARY_ID, executor: 'stale-primary', model: 'stale-primary' }),
    completed({ dispatch_id: PRIMARY_ID, executor: 'stale-primary', model: 'stale-primary', output_bytes: 1 }),
    requested({ dispatch_id: otherPrimaryId, executor: 'true-primary', model: 'true-primary' }),
    completed({ dispatch_id: otherPrimaryId, executor: 'true-primary', model: 'true-primary', output_bytes: 2, pair_id: 'pair-wins', baseline_commit: 'a'.repeat(40) }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, pair_id: 'pair-wins', executor: 'challenger-x', model: 'challenger-x' }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, pair_id: 'pair-wins', executor: 'challenger-x', model: 'challenger-x', output_bytes: 9, diff_bytes: 1 }),
  ]);
  const comps = runDispatchesBakeoffs({ repoRoot: root });
  const pair = comps.groups[0]!.pairs[0]!;
  assert.equal(pair.primaryId, otherPrimaryId);
  assert.equal(pair.primary.executor, 'true-primary');
  assert.equal(pair.orphan, false);

  // A second, independent pair with no pair_id anywhere (a log written
  // before the field existed) must still correlate via primary_dispatch_id.
  const legacyPrimaryId = 'primary-legacy-88888888-8888-8888-8888-888888888888';
  const legacyShadowId = 'shadow-legacy-77777777-7777-7777-7777-777777777777';
  const legacyRoot = tempRepo(t);
  seedLog(legacyRoot, [
    requested({ dispatch_id: legacyPrimaryId, executor: 'base-worker', model: 'base-worker' }),
    completed({ dispatch_id: legacyPrimaryId, executor: 'base-worker', model: 'base-worker', output_bytes: 1 }),
    shadowRequested(legacyPrimaryId, { dispatch_id: legacyShadowId, executor: 'challenger-x', model: 'challenger-x' }),
    shadowCompleted(legacyPrimaryId, { dispatch_id: legacyShadowId, executor: 'challenger-x', model: 'challenger-x', output_bytes: 5, diff_bytes: 2 }),
  ]);
  const legacyComps = runDispatchesBakeoffs({ repoRoot: legacyRoot });
  assert.equal(legacyComps.totalPairs, 1);
  assert.equal(legacyComps.groups[0]!.pairs[0]!.orphan, false);
  assert.equal(legacyComps.groups[0]!.pairs[0]!.primaryId, legacyPrimaryId);
});

// A shadow refused before it ever ran (capacity, eligibility, write posture,
// a constraint, or a baseline that could not be snapshotted) used to render
// as a row of "?" — indistinguishable from a challenger that crashed with no
// output. `formatBakeoffPair` must name the refusal instead.
test('dispatches comparisons: a refused shadow renders as refused with its predicate, not "?"', (t) => {
  const root = tempRepo(t);
  const refusedShadowId = 'shadow-66666666-6666-6666-6666-666666666666';
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, executor: 'base-worker', model: 'base-worker' }),
    completed({ dispatch_id: PRIMARY_ID, executor: 'base-worker', model: 'base-worker', output_bytes: 12 }),
    {
      format: DISPATCHES_FORMAT,
      timestamp: '2026-08-12T12:00:11.000Z',
      event: 'dispatch_refused',
      dispatch_id: refusedShadowId,
      pair_id: 'pair-refused',
      archetype: 'worker',
      role: null,
      resolution: 'shadow',
      shadow: true,
      primary_dispatch_id: PRIMARY_ID,
      executor: 'challenger-x',
      refusal: { predicate: 'shadow_cap', message: '4 shadows are already running and the live cap is 4.' },
    },
  ]);
  const comps = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(comps.totalPairs, 1);
  const pair = comps.groups[0]!.pairs[0]!;
  assert.deepEqual(pair.shadow.refusal, { predicate: 'shadow_cap', message: '4 shadows are already running and the live cap is 4.' });
  assert.equal(pair.shadow.exitCode, null);
  assert.equal(pair.orphan, false);
  const line = comps.lines.find((l) => l.includes(refusedShadowId.slice(0, 8)))!;
  assert.match(line, /refused \[shadow_cap\]: 4 shadows are already running/);
  assert.doesNotMatch(line, /exit \? in/);
});

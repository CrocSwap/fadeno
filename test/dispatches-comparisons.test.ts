import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DISPATCHES_FILE, DISPATCHES_FORMAT } from '../src/commands/dispatch.ts';
import { runDispatches, runDispatchesComparisons } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

function seedLog(root: string, rows: Array<Record<string, unknown> | string>): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, DISPATCHES_FILE),
    `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`,
    'utf8',
  );
}

function requested(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: DISPATCHES_FORMAT,
    timestamp: '2026-08-12T12:00:00.000Z',
    event: 'dispatch_requested',
    dispatch_id: 'primary-11111111-1111-1111-1111-111111111111',
    archetype: 'worker',
    role: null,
    resolution: 'loadout',
    loadout: { name: 'main', source: 'default' },
    executor: 'echo-worker',
    model: 'opus',
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
    loadout: { name: 'main', source: 'default' },
    executor: 'grok-worker',
    model: 'grok-4',
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
    // shadow completions omit workspace_changed by construction
    ...over,
  };
}

const PRIMARY_ID = 'primary-11111111-1111-1111-1111-111111111111';
const SHADOW_ID = 'shadow-22222222-2222-2222-2222-222222222222';

test('dispatches: shadow rows render with [shadow of <primaryId8>] and json fields', (t) => {
  const root = tempRepo(t);
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64) }),
    completed({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64), output_bytes: 123, workspace_changed: false, write_access: true }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64) }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64), output_bytes: 99, diff_bytes: 45, write_access: true, workspace_changed: false }),
  ]);

  const result = runDispatches({ repoRoot: root });
  assert.equal(result.total, 2);
  // primary entry should NOT be shadow, shadow entry should be
  const primary = result.entries.find((e) => e.dispatchId === PRIMARY_ID)!;
  const shadow = result.entries.find((e) => e.dispatchId === SHADOW_ID)!;
  assert.equal(primary.shadow, false);
  assert.equal(primary.primaryDispatchId, null);
  assert.equal(shadow.shadow, true);
  assert.equal(shadow.primaryDispatchId, PRIMARY_ID);
  assert.equal(shadow.diffBytes, 45);
  assert.equal(shadow.diffSnapshot, '.fadeno/local/outputs/shadow-22222222.diff');
  assert.equal(shadow.gateEligible, false);

  // line marks
  const shadowLine = result.lines.find((l) => l.includes('[shadow of'))!;
  assert.match(shadowLine, /\[shadow of primary-/);
  // shadow rows never get [no workspace change] even though exit 0 + write_access true + workspace_changed false would otherwise trigger it
  assert.doesNotMatch(shadowLine, /\[no workspace change\]/);

  // primary does get the mark when conditions hold
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
});

test('dispatches comparisons: pairs by challenger, prompt sha mismatch flag, orphan marked', (t) => {
  const root = tempRepo(t);
  const otherShadowId = 'shadow-33333333-3333-3333-3333-333333333333';
  const orphanShadowId = 'shadow-44444444-4444-4444-4444-444444444444';
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64), executor: 'base-worker', model: 'opus' }),
    completed({ dispatch_id: PRIMARY_ID, prompt_sha256: 'a'.repeat(64), executor: 'base-worker', model: 'opus', output_bytes: 100, exit_code: 0 }),
    // matching shadow (same sha)
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64), executor: 'challenger-x', model: 'grok' }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, prompt_sha256: 'a'.repeat(64), executor: 'challenger-x', model: 'grok', output_bytes: 90, diff_bytes: 10, exit_code: 0 }),
    // mismatched sha
    shadowRequested(PRIMARY_ID, { dispatch_id: otherShadowId, prompt_sha256: 'b'.repeat(64), executor: 'challenger-x', model: 'grok' }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: otherShadowId, prompt_sha256: 'b'.repeat(64), executor: 'challenger-x', model: 'grok', output_bytes: 80, diff_bytes: 5, exit_code: 1 }),
    // orphan (primary missing)
    shadowRequested('missing-primary-99999999-9999-9999-9999-999999999999', { dispatch_id: orphanShadowId, executor: 'lonely-challenger', model: 'kimi' }),
    shadowCompleted('missing-primary-99999999-9999-9999-9999-999999999999', { dispatch_id: orphanShadowId, executor: 'lonely-challenger', model: 'kimi', output_bytes: 70, diff_bytes: 0 }),
  ]);

  const comps = runDispatchesComparisons({ repoRoot: root });
  assert.equal(comps.totalPairs, 3);
  // grouped by challenger
  const challengerX = comps.groups.find((g) => g.challenger === 'challenger-x')!;
  assert.equal(challengerX.pairs.length, 2);
  // one of those has mismatch
  const mismatched = challengerX.pairs.find((p) => p.shadowId === otherShadowId)!;
  assert.equal(mismatched.promptShaMismatch, true);
  const matched = challengerX.pairs.find((p) => p.shadowId === SHADOW_ID)!;
  assert.equal(matched.promptShaMismatch, false);
  // orphan group
  const lonely = comps.groups.find((g) => g.challenger === 'lonely-challenger')!;
  assert.equal(lonely.pairs.length, 1);
  assert.equal(lonely.pairs[0]!.orphan, true);
  // lines contain flags
  const lines = comps.lines.join('\n');
  assert.match(lines, /PROMPT SHA MISMATCH/);
  assert.match(lines, /\[orphan: primary missing\]/);
  // summary mentions pairs
  assert.match(comps.summary, /3 shadow pairs/);
});

test('dispatches comparisons: ModelComparison artifact frontmatter parse + tally', (t) => {
  const root = tempRepo(t);
  seedLog(root, [
    requested({ dispatch_id: PRIMARY_ID, executor: 'base-worker', model: 'opus', prompt_sha256: 'a'.repeat(64) }),
    completed({ dispatch_id: PRIMARY_ID, executor: 'base-worker', model: 'opus', prompt_sha256: 'a'.repeat(64), output_bytes: 10 }),
    shadowRequested(PRIMARY_ID, { dispatch_id: SHADOW_ID, executor: 'challenger-x', model: 'grok', prompt_sha256: 'a'.repeat(64) }),
    shadowCompleted(PRIMARY_ID, { dispatch_id: SHADOW_ID, executor: 'challenger-x', model: 'grok', prompt_sha256: 'a'.repeat(64), output_bytes: 9, diff_bytes: 2 }),
  ]);
  // write comparisons
  mkdirSync(join(root, '.fadeno', 'comparisons'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'comparisons', 'run-01.md'),
    `---
kind: ModelComparison
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

## Confounds
delivery transport: command vs command
tool availability: same
effort pinning: same
isolation: detached-HEAD worktree vs dirty workspace — dirty case
`,
    'utf8',
  );
  writeFileSync(
    join(root, '.fadeno', 'comparisons', 'run-02.md'),
    `---
kind: ModelComparison
baseline: base-worker
challenger: challenger-x
verdict: prefer_baseline
date: 2026-08-13
---
## Criteria
correctness: baseline better

## Confounds
delivery transport: same
tool availability: same
effort pinning: same
isolation: clean worktree
`,
    'utf8',
  );
  writeFileSync(
    join(root, '.fadeno', 'comparisons', 'run-03.md'),
    `---
kind: ModelComparison
baseline: base-worker
challenger: challenger-x
verdict: tie
date: 2026-08-13
---
## Criteria
tie

## Confounds
confounds here
`,
    'utf8',
  );

  const comps = runDispatchesComparisons({ repoRoot: root });
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
  assert.match(lines, /1 prefer_challenger \/ 1 prefer_baseline \/ 1 tie\/inconclusive/);
  // json groups mirror same
  const json = JSON.parse(JSON.stringify(comps)) as typeof comps;
  assert.equal(json.groups[0]!.tally.preferChallenger, 1);
});

test('dispatches comparisons: empty states friendly output', (t) => {
  const root = tempRepo(t);
  // no log, no comparisons dir
  const comps = runDispatchesComparisons({ repoRoot: root });
  assert.equal(comps.totalPairs, 0);
  assert.equal(comps.totalComparisons, 0);
  assert.match(comps.lines.join('\n'), /No shadow pairs recorded/);
  assert.match(comps.summary, /No comparisons to show/);
  // also empty when dir exists but no pairs
  mkdirSync(join(root, '.fadeno', 'comparisons'), { recursive: true });
  const comps2 = runDispatchesComparisons({ repoRoot: root });
  assert.equal(comps2.totalPairs, 0);
  assert.match(comps2.lines.join('\n'), /No ModelComparison artifacts/);
});

test('dispatches comparisons: missing primary renders orphan not dropped (json)', (t) => {
  const root = tempRepo(t);
  const orphanId = 'shadow-55555555-5555-5555-5555-555555555555';
  seedLog(root, [
    shadowRequested('no-such-primary-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { dispatch_id: orphanId, executor: 'orphan-challenger', model: 'm1', prompt_sha256: 'a'.repeat(64) }),
    shadowCompleted('no-such-primary-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { dispatch_id: orphanId, executor: 'orphan-challenger', model: 'm1', prompt_sha256: 'a'.repeat(64), output_bytes: 11, diff_bytes: 3 }),
  ]);
  const comps = runDispatchesComparisons({ repoRoot: root });
  assert.equal(comps.totalPairs, 1);
  assert.equal(comps.groups[0]!.pairs[0]!.orphan, true);
  const payload = JSON.parse(JSON.stringify(comps)) as typeof comps;
  assert.equal(payload.groups[0]!.pairs[0]!.orphan, true);
});

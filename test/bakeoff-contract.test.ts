import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDispatchesBakeoffs, BAKEOFFS_DIR } from '../src/commands/dispatches.ts';
import {
  BAKEOFF_VERDICTS,
  BAKEOFF_REQUIRED_SECTIONS,
  VERDICT_BUCKET,
  checkGraftCoherence,
} from '../src/lib/bakeoff.ts';
import { SCHEMA_KINDS } from '../src/lib/playbook-validate.ts';
import { tempRepo } from './helpers.ts';

function writeComparison(
  root: string,
  name: string,
  frontmatter: string,
  sections = BAKEOFF_REQUIRED_SECTIONS,
  bodies: Record<string, string> = {},
): void {
  mkdirSync(join(root, BAKEOFFS_DIR), { recursive: true });
  const body = sections.map((s) => `## ${s}\n\n${bodies[s] ?? 'prose.'}\n`).join('\n');
  writeFileSync(join(root, BAKEOFFS_DIR, name), `---\n${frontmatter}\n---\n\n${body}`);
}

function base(verdict: string, extra = ''): string {
  return [
    'kind: Bakeoff',
    'baseline: sonnet',
    'challenger: grok',
    `verdict: ${verdict}`,
    'date: 2026-08-21',
    extra,
  ].filter((l) => l !== '').join('\n');
}

test('every verdict has a scorecard bucket, so none can be silently uncounted', () => {
  // The failure this prevents is quiet: a verdict the tally does not name
  // parses as valid, counts toward `comparisons`, and lands in no bucket, so
  // the row's own numbers stop adding up with nothing to say so.
  for (const verdict of BAKEOFF_VERDICTS) {
    assert.ok(VERDICT_BUCKET[verdict] != null, `${verdict} needs a bucket`);
  }
  assert.equal(Object.keys(VERDICT_BUCKET).length, BAKEOFF_VERDICTS.length);
});

test('a graft verdict is counted, not dropped', (t: TestContext) => {
  const root = tempRepo(t);
  writeComparison(root, 'a.md', base('graft', 'graft_plan:\n  - from_arm: challenger\n    what: the cli.ts line\n    why: nothing else reaches stdout'));
  const result = runDispatchesBakeoffs({ repoRoot: root });
  const group = result.groups[0]!;

  assert.equal(group.tally.comparisons, 1);
  assert.equal(group.tally.graft, 1);
  // The buckets must account for every counted comparison.
  const bucketed = group.tally.preferChallenger + group.tally.preferBaseline + group.tally.graft + group.tally.tieOrInconclusive;
  assert.equal(bucketed, group.tally.comparisons, 'every counted comparison must land in a bucket');
});

test('graft and graft_plan are checked in BOTH directions', (t: TestContext) => {
  assert.equal(checkGraftCoherence('graft', undefined), 'graft without a plan');
  assert.equal(checkGraftCoherence('graft', []), 'graft without a plan');
  assert.equal(checkGraftCoherence('tie', [{ from_arm: 'primary', what: 'x', why: 'y' }]), 'plan without a graft verdict');
  assert.equal(checkGraftCoherence('graft', [{ from_arm: 'primary', what: 'x', why: 'y' }]), null);
  assert.equal(checkGraftCoherence('tie', undefined), null);

  const root = tempRepo(t);
  // A graft naming nothing is unactionable and reads in a scorecard exactly
  // like a considered result, so it must never render as valid.
  writeComparison(root, 'a.md', base('graft'));
  const result = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(result.groups[0]?.comparisons[0]?.valid, false);
  assert.equal(result.groups[0]?.comparisons[0]?.error, 'graft without a plan');
});

test('every required section is enforced, including shared blind spots', (t: TestContext) => {
  const root = tempRepo(t);
  // Agreement between two arms is not evidence they are right, so the section
  // recording what BOTH missed cannot be optional — an optional section is one
  // a judge learns to skip.
  writeComparison(root, 'a.md', base('tie'), ['Criteria', 'Confounds'] as unknown as typeof BAKEOFF_REQUIRED_SECTIONS);
  const result = runDispatchesBakeoffs({ repoRoot: root });
  assert.equal(result.groups[0]?.comparisons[0]?.valid, false);
  assert.equal(result.groups[0]?.comparisons[0]?.error, 'missing required sections');
});

test('the schema kind registry is one list, so --schema cannot reject a shipped schema', () => {
  // This list lived as five separate literals. Adding `model-comparison` to
  // the type alone left `fadeno validate --schema model-comparison` refusing
  // it while naming the old four — the schema shipped, the registry knew it,
  // and the CLI said no such kind.
  assert.ok(SCHEMA_KINDS.includes('bakeoff'));
  assert.ok(SCHEMA_KINDS.includes('review-report'));
});

test('traits accumulate across a challenger\'s comparisons, which one comparison cannot show', (t: TestContext) => {
  // The reading shadow pairs are collected FOR. One artifact says "arm_b
  // validated its own output"; three say "this challenger is consistently more
  // self-verifying and consistently writes more" — a fact about the MODEL, not
  // about any one task. Verdicts alone never give that.
  const root = tempRepo(t);
  const traits = (selfVerification: string) => [
    '- **output_volume** (more: challenger): wrote more for the same task.',
    `- **self_verification** (more: ${selfVerification}): checked its own work.`,
    '- **abstraction** (more: neither): indistinguishable here.',
  ].join('\n');
  for (const [name, who] of [['a.md', 'challenger'], ['b.md', 'challenger'], ['c.md', 'primary']] as const) {
    writeComparison(root, name, base('tie'), BAKEOFF_REQUIRED_SECTIONS, { 'Model traits': traits(who) });
  }

  const group = runDispatchesBakeoffs({ repoRoot: root }).groups[0]!;
  const byDim = new Map(group.traitTally.map((row) => [row.dimension, row]));

  assert.deepEqual(byDim.get('output_volume'), { dimension: 'output_volume', challenger: 3, baseline: 0, neither: 0 });
  // 2-1 is a model that mostly does this, and must NOT be netted to "1" — a
  // dimension that varies and one that never distinguishes the two are
  // different findings, and netting collapses them into the same number.
  assert.deepEqual(byDim.get('self_verification'), { dimension: 'self_verification', challenger: 2, baseline: 1, neither: 0 });
  assert.deepEqual(byDim.get('abstraction'), { dimension: 'abstraction', challenger: 0, baseline: 0, neither: 3 });

  // Most-distinguishing first: a dimension where the arms are always the same
  // tells you least, so it sorts last.
  assert.equal(group.traitTally.at(-1)?.dimension, 'abstraction');
});

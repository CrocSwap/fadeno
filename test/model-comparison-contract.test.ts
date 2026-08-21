import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDispatchesComparisons, COMPARISONS_DIR } from '../src/commands/dispatches.ts';
import {
  MODEL_COMPARISON_VERDICTS,
  MODEL_COMPARISON_REQUIRED_SECTIONS,
  VERDICT_BUCKET,
  checkGraftCoherence,
} from '../src/lib/model-comparison.ts';
import { SCHEMA_KINDS } from '../src/lib/playbook-validate.ts';
import { tempRepo } from './helpers.ts';

function writeComparison(root: string, name: string, frontmatter: string, sections = MODEL_COMPARISON_REQUIRED_SECTIONS): void {
  mkdirSync(join(root, COMPARISONS_DIR), { recursive: true });
  const body = sections.map((s) => `## ${s}\n\nprose.\n`).join('\n');
  writeFileSync(join(root, COMPARISONS_DIR, name), `---\n${frontmatter}\n---\n\n${body}`);
}

function base(verdict: string, extra = ''): string {
  return [
    'kind: ModelComparison',
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
  for (const verdict of MODEL_COMPARISON_VERDICTS) {
    assert.ok(VERDICT_BUCKET[verdict] != null, `${verdict} needs a bucket`);
  }
  assert.equal(Object.keys(VERDICT_BUCKET).length, MODEL_COMPARISON_VERDICTS.length);
});

test('a graft verdict is counted, not dropped', (t: TestContext) => {
  const root = tempRepo(t);
  writeComparison(root, 'a.md', base('graft', 'graft_plan:\n  - from_arm: challenger\n    what: the cli.ts line\n    why: nothing else reaches stdout'));
  const result = runDispatchesComparisons({ repoRoot: root });
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
  const result = runDispatchesComparisons({ repoRoot: root });
  assert.equal(result.groups[0]?.comparisons[0]?.valid, false);
  assert.equal(result.groups[0]?.comparisons[0]?.error, 'graft without a plan');
});

test('every required section is enforced, including shared blind spots', (t: TestContext) => {
  const root = tempRepo(t);
  // Agreement between two arms is not evidence they are right, so the section
  // recording what BOTH missed cannot be optional — an optional section is one
  // a judge learns to skip.
  writeComparison(root, 'a.md', base('tie'), ['Criteria', 'Confounds'] as unknown as typeof MODEL_COMPARISON_REQUIRED_SECTIONS);
  const result = runDispatchesComparisons({ repoRoot: root });
  assert.equal(result.groups[0]?.comparisons[0]?.valid, false);
  assert.equal(result.groups[0]?.comparisons[0]?.error, 'missing required sections');
});

test('the schema kind registry is one list, so --schema cannot reject a shipped schema', () => {
  // This list lived as five separate literals. Adding `model-comparison` to
  // the type alone left `fadeno validate --schema model-comparison` refusing
  // it while naming the old four — the schema shipped, the registry knew it,
  // and the CLI said no such kind.
  assert.ok(SCHEMA_KINDS.includes('model-comparison'));
  assert.ok(SCHEMA_KINDS.includes('review-report'));
});

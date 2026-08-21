import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  BAKEOFF_PROMPT_MARKER,
  deriveBlinding,
  runBakeoff,
  runBakeoffPrepare,
  BakeoffCommandError,
} from '../src/commands/bakeoff.ts';
import { parseBakeoffFile } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/**
 * `--evidence explored` reconstructs each arm's post-work tree on disk and
 * hands the judge paths instead of ~50 KB of inlined diff.
 *
 * The thing these tests exist to prevent is not a crash. It is a tree that is
 * silently the BASELINE — see `materializeArmTree`, where the obvious
 * implementation (`cd` into the destination, `git apply`) exits 0, applies
 * nothing, and leaves a judge exploring pristine code while the prompt tells
 * it that it is looking at an arm's work.
 */

const PAIR = 'pair0001-aaaa-bbbb-cccc-dddddddddddd';

function git(root: string, ...args: string[]): void {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

function judgeCommand(comparisonJson: unknown, adversarialJson: unknown): string[] {
  const marker = JSON.stringify(BAKEOFF_PROMPT_MARKER.adversarial);
  const adv = JSON.stringify(JSON.stringify(adversarialJson));
  const cmp = JSON.stringify(JSON.stringify(comparisonJson));
  return ['node', '-e',
    "let d='';process.stdin.on('data',c=>d+=c);" +
    `process.stdin.on('end',()=>{process.stdout.write(d.includes(${marker})?${adv}:${cmp});});`];
}

/** Baseline holds `src/a.ts` and `src/keep.ts`; each arm rewrites `src/a.ts` its own way. */
function seed(
  t: TestContext,
  opts: { primaryDiff: string; challengerDiff: string; judge?: string[]; brokenBaseline?: boolean },
): string {
  const root = tempRepo(t);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = true;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
  const baseline = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'outputs', 'p.diff'), opts.primaryDiff);
  writeFileSync(join(root, '.fadeno', 'local', 'outputs', 'c.diff'), opts.challengerDiff);
  if (opts.judge != null) {
    const route = { judgeprov: { command: opts.judge, write_access: false } };
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
      schema_version: 3,
      models: { 'judge-model': { provider: 'judgeprov', id: 'judge-model' } },
      routes: { standalone: route, claude: route, codex: route, grok: route },
      dials: { judge: 'judge-model' },
    }));
  }
  const row = (extra: Record<string, unknown>) => ({
    event: 'dispatch_completed', format: '1.0', pair_id: PAIR,
    archetype: 'worker', exit_code: 0, duration_ms: 1000, output_bytes: 10,
    // A commit that does not exist is how "the baseline was garbage-collected"
    // reaches the reconstruction path.
    baseline_commit: opts.brokenBaseline ? '0'.repeat(40) : baseline,
    ...extra,
  });
  writeFileSync(join(root, '.fadeno', 'dispatches.jsonl'), [
    JSON.stringify(row({
      dispatch_id: 'prim0001-aaaa-bbbb-cccc-dddddddddddd', executor: 'sonnet', model: 'sonnet',
      reasoning_effort: 'xhigh', diff_snapshot: '.fadeno/local/outputs/p.diff', diff_bytes: opts.primaryDiff.length,
    })),
    JSON.stringify(row({
      shadow: true, dispatch_id: 'chal0001-aaaa-bbbb-cccc-dddddddddddd', executor: 'grok', model: 'grok',
      reasoning_effort: 'xhigh', diff_snapshot: '.fadeno/local/outputs/c.diff', diff_bytes: opts.challengerDiff.length,
    })),
  ].join('\n') + '\n');
  return root;
}

const PRIMARY_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const a = 1;',
  '+export const a = 2; // primary',
  '',
].join('\n');

const CHALLENGER_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const a = 1;',
  '+export const a = 3; // challenger',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export const fresh = true;',
  '',
].join('\n');

test('each arm tree is the baseline WITH that arm\'s changes, under its blinded name', (t) => {
  const root = seed(t, { primaryDiff: PRIMARY_DIFF, challengerDiff: CHALLENGER_DIFF });
  const result = runBakeoffPrepare({ repoRoot: root, ref: 'pair0001', evidence: 'explored' });

  assert.equal(result.evidenceMode, 'explored');
  assert.ok(result.armTrees != null);
  // Blinded names only. A directory called `primary/` in a prompt would undo
  // the label swap more thoroughly than any prose leak.
  assert.match(result.armTrees.a.tree, /arm_a$/);
  assert.match(result.armTrees.b.tree, /arm_b$/);

  const blinding = deriveBlinding(PAIR);
  const expected = {
    primary: 'export const a = 2; // primary',
    challenger: 'export const a = 3; // challenger',
  };
  for (const label of ['a', 'b'] as const) {
    const treeAbs = join(root, result.armTrees[label].tree);
    const body = readFileSync(join(treeAbs, 'src', 'a.ts'), 'utf8');
    // THE test: the tree carries this arm's own work, not the baseline. The
    // trap version of this code produces `export const a = 1;` here, silently.
    assert.match(body, new RegExp(expected[blinding[label]]));
    // Untouched baseline files come along, which is the point of a tree.
    assert.equal(readFileSync(join(treeAbs, 'src', 'keep.ts'), 'utf8'), 'export const keep = true;\n');
    // No `.git`: nothing to register, nothing to prune — and no `git log` for
    // a curious judge to identify its arm with.
    assert.equal(existsSync(join(treeAbs, '.git')), false);
  }
  // A file only one arm created exists only in that arm's tree.
  const challengerTree = join(root, result.armTrees[blinding.a === 'challenger' ? 'a' : 'b'].tree);
  const primaryTree = join(root, result.armTrees[blinding.a === 'primary' ? 'a' : 'b'].tree);
  assert.equal(existsSync(join(challengerTree, 'src', 'new.ts')), true);
  assert.equal(existsSync(join(primaryTree, 'src', 'new.ts')), false);
});

test('the prompt hands over paths instead of diff bytes, and says to go read them', (t) => {
  const root = seed(t, { primaryDiff: PRIMARY_DIFF, challengerDiff: CHALLENGER_DIFF });

  const inlined = runBakeoffPrepare({ repoRoot: root, ref: 'pair0001' });
  const inlinedText = readFileSync(join(root, inlined.comparisonPromptPath), 'utf8');
  const explored = runBakeoffPrepare({ repoRoot: root, ref: 'pair0001', evidence: 'explored' });
  const exploredText = readFileSync(join(root, explored.comparisonPromptPath), 'utf8');

  // Inlined is the default: an omitted flag never silently changes the mode.
  assert.equal(inlined.evidenceMode, 'inlined');
  assert.equal(inlined.armTrees, null);
  assert.match(inlinedText, /```diff/);
  assert.match(inlinedText, /export const a = 3; \/\/ challenger/);

  // Explored carries neither the fence nor the diff body.
  assert.doesNotMatch(exploredText, /```diff/);
  assert.doesNotMatch(exploredText, /export const a = 3; \/\/ challenger/);
  assert.match(exploredText, /- tree \(baseline \+ this arm's changes applied\): `\.fadeno\/local\/judge\/pair0001\/arm_a\/`/);
  assert.match(exploredText, /- changes as a diff: `\.fadeno\/local\/judge\/pair0001\/arm_b\.diff`/);
  // A judge told only "here is a path" answers from the diffstat, which is
  // strictly worse than inlining. The instruction has to be explicit.
  assert.match(exploredText, /Read them\./);
  assert.match(exploredText, /Read ONLY inside the two arm directories/);
  // Both prompts get it — the adversarial pass explores the same trees.
  assert.match(readFileSync(join(root, explored.adversarialPromptPath), 'utf8'), /Read ONLY inside the two arm directories/);
});

test('a baseline that cannot be reconstructed refuses instead of showing a wrong tree', (t) => {
  const root = seed(t, { primaryDiff: PRIMARY_DIFF, challengerDiff: CHALLENGER_DIFF, brokenBaseline: true });
  assert.throws(
    () => runBakeoffPrepare({ repoRoot: root, ref: 'pair0001', evidence: 'explored' }),
    (err: unknown) => err instanceof BakeoffCommandError && /baseline tree|garbage-collected/.test((err as Error).message),
  );
  // …and the same pair still adjudicates inlined, which needs only the diff.
  const inlined = runBakeoffPrepare({ repoRoot: root, ref: 'pair0001' });
  assert.equal(inlined.evidenceMode, 'inlined');
});

test('a diff that does not apply to its recorded baseline refuses too', (t) => {
  // The preimage says `a = 99`, the baseline says `a = 1`. Reconstruction
  // cannot produce this arm's tree, and a baseline tree wearing the arm's
  // label is the failure this whole path is guarding.
  const wrong = PRIMARY_DIFF.replace('-export const a = 1;', '-export const a = 99;');
  const root = seed(t, { primaryDiff: wrong, challengerDiff: CHALLENGER_DIFF });
  assert.throws(
    () => runBakeoffPrepare({ repoRoot: root, ref: 'pair0001', evidence: 'explored' }),
    (err: unknown) => err instanceof BakeoffCommandError && /do not agree|does not match/.test((err as Error).message),
  );
});

test('the artifact records which kind of evidence produced the verdict', (t) => {
  const judgment = {
    verdict: 'prefer_a',
    criteria: [{ criterion: 'correctness', assessment: 'arm_a is tighter.', favors: 'a' }],
    shared_blind_spots: [],
    traits: [{ dimension: 'output_volume', more: 'b', note: 'arm_b wrote more.' }],
  };
  const root = seed(t, {
    primaryDiff: PRIMARY_DIFF,
    challengerDiff: CHALLENGER_DIFF,
    judge: judgeCommand(judgment, { shared_blind_spots: [] }),
  });

  const result = runBakeoff({ repoRoot: root, ref: 'pair0001', evidence: 'explored' });
  const written = readFileSync(join(root, result.comparisonPath), 'utf8');
  assert.match(written, /^evidence_mode: explored$/m);
  // Through the same parser the scorecard uses — a frontmatter key the reader
  // rejects would make the verdict vanish from the tally rather than error.
  assert.equal(parseBakeoffFile(root, result.comparisonPath).valid, true);
});

test('an artifact written without the flag says inlined, not nothing', (t) => {
  const judgment = {
    verdict: 'tie',
    criteria: [{ criterion: 'correctness', assessment: 'even.', favors: 'neither' }],
    shared_blind_spots: [],
    traits: [],
  };
  const root = seed(t, {
    primaryDiff: PRIMARY_DIFF,
    challengerDiff: CHALLENGER_DIFF,
    judge: judgeCommand(judgment, { shared_blind_spots: [] }),
  });
  const result = runBakeoff({ repoRoot: root, ref: 'pair0001' });
  assert.match(readFileSync(join(root, result.comparisonPath), 'utf8'), /^evidence_mode: inlined$/m);
});

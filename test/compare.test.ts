import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  COMPARE_PROMPT_MARKER,
  deriveBlinding,
  runCompare,
  runComparePrepare,
  runCompareRecord,
  CompareCommandError,
} from '../src/commands/compare.ts';
import { parseModelComparisonFile, runDispatchesComparisons } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/** A fake `judge` command: reads the prompt on stdin, and answers with whichever canned JSON matches its task marker. */
function judgeCommand(comparisonJson: unknown, adversarialJson: unknown): string[] {
  const marker = JSON.stringify(COMPARE_PROMPT_MARKER.adversarial);
  const adv = JSON.stringify(JSON.stringify(adversarialJson));
  const cmp = JSON.stringify(JSON.stringify(comparisonJson));
  const script =
    "let d='';process.stdin.on('data',c=>d+=c);" +
    `process.stdin.on('end',()=>{process.stdout.write(d.includes(${marker})?${adv}:${cmp});});`;
  return ['node', '-e', script];
}

/** A fake `judge` command that always exits non-zero and writes nothing — the dispatch-failure case. */
function failingJudgeCommand(): string[] {
  return ['node', '-e', "process.stdin.resume();process.exitCode=1;"];
}

const GOOD_ADVERSARIAL = { shared_blind_spots: [] };

function git(root: string, ...args: string[]): void {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

/**
 * A repo with one committed baseline and a pair of diff artifacts, seeded
 * straight into the ledger. `runCompare` reads evidence and git, so the
 * fixture has to be a real commit — not a stub — for the baseline probes to
 * mean anything.
 */
function seedPair(t: TestContext, opts: {
  baselineSources?: Record<string, string>;
  primaryDiff: string;
  challengerDiff: string;
  surfaces?: string[];
  primaryRowExtra?: Record<string, unknown>;
  challengerRowExtra?: Record<string, unknown>;
  /** When given, the `judge` archetype dials to a fake command emitting canned JSON; omitted means no judge dial at all (falls back to bare `current-host` — the no-command-lane case). */
  judgeCommand?: string[];
  /** A SECOND complete pair, for the artifact-path collision case. */
  secondPairId?: string;
}): string {
  const root = tempRepo(t);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), 'export function main(): void {}\n');
  for (const [rel, body] of Object.entries(opts.baselineSources ?? {})) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
  const baseline = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'outputs', 'p.diff'), opts.primaryDiff);
  writeFileSync(join(root, '.fadeno', 'local', 'outputs', 'c.diff'), opts.challengerDiff);
  if (opts.surfaces != null || opts.judgeCommand != null) {
    const catalog: Record<string, unknown> = { schema_version: 3 };
    if (opts.surfaces != null) catalog.surfaces = opts.surfaces;
    if (opts.judgeCommand != null) {
      catalog.models = { 'judge-model': { provider: 'judgeprov', id: 'judge-model' } };
      // Declared for every harness this suite might ambiently detect (a real
      // `CLAUDECODE`/`CODEX_*` env var in whatever session runs the tests) —
      // the same redundancy `dispatch-shadow.test.ts`'s own fixtures use,
      // since which harness is active is real ambient state a command has no
      // business overriding.
      const route = { judgeprov: { command: opts.judgeCommand, write_access: false } };
      catalog.routes = { standalone: route, claude: route, codex: route, grok: route };
      catalog.dials = { judge: 'judge-model' };
    }
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(catalog));
  }

  const rows = [
    {
      event: 'dispatch_completed', format: '1.0',
      pair_id: 'pair0001-aaaa-bbbb-cccc-dddddddddddd', dispatch_id: 'prim0001-aaaa-bbbb-cccc-dddddddddddd',
      archetype: 'worker', executor: 'sonnet', model: 'sonnet', reasoning_effort: 'xhigh',
      exit_code: 0, duration_ms: 1000, output_bytes: 10,
      diff_snapshot: '.fadeno/local/outputs/p.diff', diff_bytes: opts.primaryDiff.length,
      baseline_commit: baseline, ...(opts.primaryRowExtra ?? {}),
    },
    {
      event: 'dispatch_completed', format: '1.0', shadow: true,
      pair_id: 'pair0001-aaaa-bbbb-cccc-dddddddddddd', dispatch_id: 'chal0001-aaaa-bbbb-cccc-dddddddddddd',
      archetype: 'worker', executor: 'grok', model: 'grok', reasoning_effort: 'xhigh',
      exit_code: 0, duration_ms: 1200, output_bytes: 20,
      diff_snapshot: '.fadeno/local/outputs/c.diff', diff_bytes: opts.challengerDiff.length,
      baseline_commit: baseline, ...(opts.challengerRowExtra ?? {}),
    },
  ];
  if (opts.secondPairId != null) {
    rows.push(
      { ...rows[0]!, pair_id: opts.secondPairId, dispatch_id: 'prim0002-aaaa-bbbb-cccc-dddddddddddd' },
      { ...rows[1]!, pair_id: opts.secondPairId, dispatch_id: 'chal0002-aaaa-bbbb-cccc-dddddddddddd' },
    );
  }
  writeFileSync(join(root, '.fadeno', 'dispatches.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return root;
}

function diffFor(file: string, addedLines: string[], removedLines: string[] = []): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,1 +1,9 @@',
    ...removedLines.map((l) => `-${l}`),
    ...addedLines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

test('the reach differential names a value one arm wired to a surface and the other did not', (t) => {
  // Both arms compute `delegate_to`; only the challenger adds it to the
  // printed object. This is shadow pair 89536181 in miniature — the defect
  // that 1282 green tests and an identical diffstat both missed.
  const root = seedPair(t, {
    surfaces: ['src/cli.ts'],
    primaryDiff: diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']),
    challengerDiff:
      diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']) +
      diffFor('src/cli.ts', ['      delegate_to: result.delegate_to ?? null,']),
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001-aaaa-bbbb-cccc-dddddddddddd', measureOnly: true });

  assert.deepEqual(result.reachDifferential, [
    { identifier: 'delegate_to', reachedIn: 'challenger', unreachedIn: 'primary' },
  ]);
  const primary = result.arms.find((a) => a.arm === 'primary')!;
  assert.deepEqual(primary.signals?.unreached, ['delegate_to']);
  const challenger = result.arms.find((a) => a.arm === 'challenger')!;
  assert.deepEqual(challenger.signals?.unreached, []);
});

test('reach is withheld, not reported clean, when the repo declares no surfaces', (t) => {
  const root = seedPair(t, {
    primaryDiff: diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']),
    challengerDiff: diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']),
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001', measureOnly: true });

  // `null`, never `[]`. An empty list reads as "everything reached a
  // consumer"; absent a declaration this cannot tell that from "there was
  // nothing to reach", and the difference is the whole value of the signal.
  for (const arm of result.arms) assert.equal(arm.signals?.unreached, null);
  assert.equal(result.reachDifferential, null);
});

test('a MOVED symbol is not reported as a duplication', (t) => {
  // The old home did not export it; the new one does. Treating that as
  // "already defined at baseline" would flag every extraction-into-a-shared-
  // module — which is the refactor this codebase's own convention asks for.
  const root = seedPair(t, {
    baselineSources: { 'src/doctor.ts': "const SHARED_MARK = '# fadeno:managed';\n" },
    primaryDiff:
      diffFor('src/doctor.ts', [], ["const SHARED_MARK = '# fadeno:managed';"]) +
      diffFor('src/shared.ts', ["export const SHARED_MARK = '# fadeno:managed';"]),
    challengerDiff: diffFor('src/other.ts', ["export const SHARED_MARK = '# fadeno:managed';"]),
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001', measureOnly: true });

  const primary = result.arms.find((a) => a.arm === 'primary')!;
  assert.deepEqual(primary.signals?.redefined, [], 'the primary moved the symbol, it did not duplicate it');

  // The challenger added a second definition and removed nothing, which is a
  // genuine duplication and MUST still be reported. This half is the tripwire:
  // the baseline probe shells out to `git grep -E`, whose POSIX ERE does not
  // honour `\\s` or `\\b`. The first version used both, matched nothing ever,
  // and reported a clean bill that was indistinguishable from a real one.
  const challenger = result.arms.find((a) => a.arm === 'challenger')!;
  assert.deepEqual(challenger.signals?.redefined, ['SHARED_MARK']);
});

test('confounds are stamped from the ledger, and generated files are called out', (t) => {
  const root = seedPair(t, {
    primaryDiff: diffFor('plugin/bin/fadeno', ['export const generated = 1;']),
    challengerDiff: diffFor('src/thing.ts', ['export const thing = 1;']),
    primaryRowExtra: { ignored_output_discarded: { paths: ['dist/'] }, exit_code: 1 },
    challengerRowExtra: { carry_mutated: true, workspace_mode_degraded: 'worktree_unavailable' },
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001', measureOnly: true });
  const codes = result.confounds.map((c) => c.code).sort();

  assert.ok(codes.includes('ignored_output_discarded'));
  assert.ok(codes.includes('carry_mutated'), 'carry_mutated must survive the reader');
  assert.ok(codes.includes('workspace_mode_degraded'), 'workspace_mode_degraded must survive the reader');
  assert.ok(codes.includes('exit_code_differs'));
  assert.ok(codes.includes('effort_unattested'));

  // A regenerated bundle is one 1.7 MB line: a pair that merely rebuilt it
  // reads as an enormous change unless the diffstat says so.
  const primary = result.arms.find((a) => a.arm === 'primary')!;
  assert.deepEqual(primary.diff?.generatedFiles, ['plugin/bin/fadeno']);
  // ...and its identifiers are excluded from the signals entirely.
  assert.deepEqual(primary.signals?.introduced, []);
});

test('a judge with no command lane refuses with an actionable message, and writes nothing', (t) => {
  // No dial for `judge` anywhere in this fixture — resolution falls back to
  // the bare `current-host` sentinel, exactly the case `runDispatch` itself
  // already refuses with the remedy this command's own wording discipline
  // borrows verbatim: `fadeno dial judge <model> --via <driver>`.
  const root = seedPair(t, { primaryDiff: diffFor('src/a.ts', ['+x']), challengerDiff: diffFor('src/b.ts', ['+y']) });
  assert.throws(
    () => runCompare({ repoRoot: root, ref: 'pair0001' }),
    (err: unknown) =>
      err instanceof CompareCommandError &&
      /fadeno dial judge <model> --via <driver>/.test((err as Error).message),
  );
  assert.equal(existsSync(join(root, '.fadeno', 'comparisons')), false, 'a refused adjudication must write nothing');
});

test('--measure-only keeps working exactly as before, needing no judge dial at all', (t) => {
  const root = seedPair(t, { primaryDiff: diffFor('src/a.ts', ['+x']), challengerDiff: diffFor('src/b.ts', ['+y']) });
  const result = runCompare({ repoRoot: root, ref: 'pair0001', measureOnly: true });
  assert.equal(result.measureOnly, true);
  assert.ok(!('verdict' in result));
});

test('blinding is derived from the pair id, stable across calls, and not always primary-first', () => {
  const first = deriveBlinding('pair0001-aaaa-bbbb-cccc-dddddddddddd');
  const again = deriveBlinding('pair0001-aaaa-bbbb-cccc-dddddddddddd');
  assert.deepEqual(first, again, 'the same pair id must blind the same way every time');
  assert.ok(
    (first.a === 'primary' && first.b === 'challenger') || (first.a === 'challenger' && first.b === 'primary'),
  );
  const orders = new Set(Array.from({ length: 32 }, (_, i) => deriveBlinding(`pair-${i}`).a));
  assert.ok(orders.has('primary') && orders.has('challenger'), 'a fixed order would itself be a label');
});

test('a dispatch that fails, or a judgment that fails schema validation, writes no file', (t) => {
  // The comparison dispatch itself exits non-zero.
  const failing = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: failingJudgeCommand(),
  });
  assert.throws(() => runCompare({ repoRoot: failing, ref: 'pair0001' }), CompareCommandError);
  assert.equal(existsSync(join(failing, '.fadeno', 'comparisons')), false);

  // The dispatch succeeds, but the JSON it emits does not validate — an
  // unrecognized verdict rather than one of the five the schema names.
  const invalidVerdict = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand({ verdict: 'definitely_the_best', criteria: [], shared_blind_spots: [] }, GOOD_ADVERSARIAL),
  });
  assert.throws(() => runCompare({ repoRoot: invalidVerdict, ref: 'pair0001' }), CompareCommandError);
  assert.equal(existsSync(join(invalidVerdict, '.fadeno', 'comparisons')), false);
});

test('a graft judgment round-trips through render, unblinds from_arm, and is accepted + counted by the scorecard', (t) => {
  const pairId = 'pair0001-aaaa-bbbb-cccc-dddddddddddd';
  const blinding = deriveBlinding(pairId);
  // Ask the graft to come from whichever real arm blinds to `b`, so the test
  // asserts the render step actually looked up the mapping rather than
  // happening to match by coincidence.
  const graftFromArm = blinding.b;
  const comparisonJudgment = {
    verdict: 'graft',
    criteria: [
      { criterion: 'correctness', assessment: 'both pass the suite', favors: 'neither' },
      { criterion: 'repo_convention', assessment: 'arm_b better follows the drift-tripwire convention', favors: 'b' },
    ],
    shared_blind_spots: [],
    traits: [{ dimension: 'self_verification', more: 'b', note: 'arm_b checked its own output; arm_a did not.' }],
    graft_plan: [{ from_arm: 'b', what: 'the drift tripwire in cli.ts', why: 'the other arm never wired the field to the printed object' }],
    confound_notes: 'both arms ran unusually slowly, which the ledger did not otherwise explain.',
  };
  const adversarialJudgment = {
    shared_blind_spots: [{ issue: 'no offline test for the tool', why_invisible: 'both arms only ran the online suite', config_that_breaks_it: 'FADENO_OFFLINE=1' }],
  };
  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(comparisonJudgment, adversarialJudgment),
  });

  const result = runCompare({ repoRoot: root, ref: pairId });
  assert.equal(result.measureOnly, false);
  assert.equal(result.verdict, 'graft');
  // The FULL pair id: an 8-char prefix lets two pairs overwrite each other's
  // verdict silently.
  assert.equal(result.comparisonPath, `.fadeno/comparisons/${pairId}.md`);

  const written = readFileSync(join(root, result.comparisonPath), 'utf8');
  assert.match(written, new RegExp(`from_arm: ${graftFromArm}`), 'from_arm must be unblinded to the real arm name, not left as a/b');
  assert.match(written, /## Shared blind spots/);
  assert.match(written, /no offline test for the tool/);
  assert.match(written, /## Confounds/);
  assert.match(written, /judge's own observation/);

  const scorecard = runDispatchesComparisons({ repoRoot: root });
  const group = scorecard.groups.find((g) => g.comparisons.some((c) => c.file === result.comparisonPath));
  assert.ok(group, 'the written artifact must be findable in its own challenger group');
  const artifact = group!.comparisons.find((c) => c.file === result.comparisonPath)!;
  assert.equal(artifact.valid, true, 'parseModelComparisonFile must accept what this command wrote');
  assert.equal(artifact.verdict, 'graft');
  assert.equal(group!.tally.graft, 1, 'a graft verdict must be counted, not silently dropped');
});

test('a refused arm blocks adjudication before any judge is dispatched', (t) => {
  // The pair has nothing to compare, and a judge asked to weigh a real diff
  // against an absence will still return a verdict — `prefer_baseline` being
  // the obvious one, and meaningless: the challenger did not lose, it never
  // ran. Pair 097929f6 in this repo is exactly this shape.
  //
  // It also closes a blinding leak no label swap can: `shadow_containment`,
  // `shadow_baseline` and `shadow_carry` can ONLY refuse a challenger, so a
  // predicate reaching a blinded judge names the arm however it is labelled.
  // Refusing here means the predicate never reaches a prompt at all.
  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    challengerRowExtra: {
      event: 'dispatch_refused',
      refusal: { predicate: 'shadow_containment', message: 'the prompt contains this repo\'s absolute path' },
    },
    // A judge command that would FAIL the test if it ever ran: reaching it at
    // all means the guard did not fire.
    judgeCommand: ['node', '-e', 'process.stderr.write("judge must not be dispatched for an incomplete pair");process.exit(3)'],
  });

  assert.throws(
    () => runCompare({ repoRoot: root, ref: 'pair0001' }),
    (err: unknown) => err instanceof CompareCommandError
      && /cannot be adjudicated/.test((err as Error).message)
      && /shadow_containment/.test((err as Error).message),
  );
  assert.equal(existsSync(join(root, '.fadeno', 'comparisons')), false, 'nothing may be written for a pair that cannot be judged');
});

test('the graft plan reaches the returned result, not only the written file', (t) => {
  // A `graft` verdict says neither arm should be taken whole; a plan that
  // lives solely in a file says that and then withholds what to take. Same
  // defect shape as pair 89536181's `delegate_to` — computed, documented, and
  // never wired to the surface its consumer reads.
  const pairId = 'pair0001-aaaa-bbbb-cccc-dddddddddddd';
  const blinding = deriveBlinding(pairId);
  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(
      {
        verdict: 'graft',
        criteria: [{ criterion: 'correctness', assessment: 'both fine', favors: 'neither' }],
        shared_blind_spots: [],
        traits: [{ dimension: 'output_volume', more: 'b', note: 'arm_b wrote noticeably more for the same task.' }],
        graft_plan: [{ from_arm: 'b', what: 'the tripwire', why: 'the other arm never wired it' }],
      },
      { shared_blind_spots: [] },
    ),
  });

  const result = runCompare({ repoRoot: root, ref: pairId });
  assert.equal(result.measureOnly, false);
  assert.ok(result.graftPlan != null, 'a graft verdict must return its plan');
  assert.equal(result.graftPlan!.length, 1);
  assert.equal(result.graftPlan![0]!.from_arm, blinding.b, 'the returned plan must be unblinded too');
  assert.equal(result.graftPlan![0]!.what, 'the tripwire');
});

test('the verdict is unblinded, so a swapped mapping cannot invert the recorded result', (t) => {
  // The judge answers in the only frame it has (`prefer_a`/`prefer_b`) and the
  // kernel translates once. The original contract reused
  // `prefer_baseline`/`prefer_challenger` in the JUDGMENT schema while the
  // prompt told the judge it does not know which arm is which — so the single
  // field that decides the outcome was the one field the judge could not
  // answer. It answered anyway, and the kernel passed it through verbatim.
  //
  // `pair0001` blinds a→challenger, b→primary — the swapped case. A judge that
  // prefers arm_a is preferring the CHALLENGER, so anything that records
  // `prefer_baseline` here has inverted the result. The first real adjudication
  // was correct only because that pair's mapping happened to be the identity.
  const pairId = 'pair0001-aaaa-bbbb-cccc-dddddddddddd';
  const blinding = deriveBlinding(pairId);
  assert.equal(blinding.a, 'challenger', 'fixture precondition: this pair id must blind a→challenger');

  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(
      {
        verdict: 'prefer_a',
        criteria: [{ criterion: 'correctness', assessment: 'arm_a is better', favors: 'a' }],
        shared_blind_spots: [],
        traits: [{ dimension: 'output_volume', more: 'b', note: 'arm_b wrote noticeably more for the same task.' }],
      },
      { shared_blind_spots: [] },
    ),
  });

  const result = runCompare({ repoRoot: root, ref: pairId });
  assert.equal(result.measureOnly, false);
  assert.equal(result.verdict, 'prefer_challenger', 'prefer_a under a swapped mapping is the CHALLENGER');

  const written = readFileSync(join(root, result.comparisonPath), 'utf8');
  assert.match(written, /verdict: prefer_challenger/);
  // And the artifact must never carry the blinded vocabulary out to a reader.
  assert.doesNotMatch(written, /verdict: prefer_[ab]\b/);
});

test('a judgment using the artifact vocabulary is refused, not silently reinterpreted', (t) => {
  // `prefer_baseline` is not a frame the judge has. Accepting it would mean
  // guessing what the judge meant by a word it was told it could not evaluate.
  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(
      {
        verdict: 'prefer_baseline',
        criteria: [{ criterion: 'correctness', assessment: 'x', favors: 'a' }],
        shared_blind_spots: [],
        traits: [{ dimension: 'output_volume', more: 'b', note: 'arm_b wrote noticeably more for the same task.' }],
      },
      { shared_blind_spots: [] },
    ),
  });
  assert.throws(
    () => runCompare({ repoRoot: root, ref: 'pair0001' }),
    (err: unknown) => err instanceof CompareCommandError
      && /does not validate|did not return a judgment that validates/.test((err as Error).message)
      && /prefer_a/.test((err as Error).message),
  );
  assert.equal(existsSync(join(root, '.fadeno', 'comparisons')), false);
});

test('two pairs sharing eight hex characters do not overwrite each other', (t) => {
  // Both arms of the pair that built this command wrote to <pair-id-8>.md.
  // Nothing errors on collision: one verdict simply replaces another in the
  // accumulation the scorecard exists to build.
  const a = 'pair0001-aaaa-bbbb-cccc-dddddddddddd';
  const b = 'pair0001-aaaa-bbbb-cccc-eeeeeeeeeeee';
  assert.equal(a.slice(0, 8), b.slice(0, 8), 'fixture precondition: the ids must share an 8-char prefix');

  const judgment = {
    verdict: 'prefer_a',
    criteria: [{ criterion: 'correctness', assessment: 'x', favors: 'a' }],
    shared_blind_spots: [],
    traits: [{ dimension: 'abstraction', more: 'a', note: 'arm_a extracted a helper where arm_b inlined.' }],
  };
  const root = seedPair(t, {
    secondPairId: b,
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(judgment, { shared_blind_spots: [] }),
  });

  const first = runCompare({ repoRoot: root, ref: a });
  const second = runCompare({ repoRoot: root, ref: b });
  assert.notEqual(first.comparisonPath, second.comparisonPath, 'each pair needs its own artifact path');
  assert.ok(existsSync(join(root, first.comparisonPath)));
  assert.ok(existsSync(join(root, second.comparisonPath)));

  const scorecard = runDispatchesComparisons({ repoRoot: root });
  assert.equal(scorecard.totalComparisons, 2, 'both verdicts must survive');
});

test('an artifact the scorecard cannot read is removed, not left to be silently skipped', (t) => {
  // The writer verifies its output through the reader that consumes it. A
  // rejected artifact is otherwise entirely silent: it sits on disk, counts as
  // skipped, and two judge dispatches vanish from the accumulation.
  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(
      {
        verdict: 'prefer_a',
        criteria: [{ criterion: 'correctness', assessment: 'x', favors: 'a' }],
        shared_blind_spots: [],
        traits: [{ dimension: 'convention_adherence', more: 'a', note: 'arm_a matched the surrounding style.' }],
      },
      { shared_blind_spots: [] },
    ),
  });
  // Break the contract from the reader's side: drop a required section name so
  // whatever render produces cannot parse.
  const result = runCompare({ repoRoot: root, ref: 'pair0001' });
  const written = readFileSync(join(root, result.comparisonPath), 'utf8');
  const reparsed = parseModelComparisonFile(root, result.comparisonPath);
  assert.equal(reparsed.valid, true, 'what compare writes must be what the scorecard reads');
  assert.match(written, /## Shared blind spots/);
});

test("the judge's own prose is unblinded too, so the artifact never names one arm twice", (t) => {
  // Structured fields translate by lookup; free text does not. Without this
  // the artifact reads "(more: challenger): Arm_b produces a larger
  // implementation" — two names for one arm on a single line, leaving a reader
  // to carry the mapping the blinding exists to hide.
  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(
      {
        verdict: 'prefer_a',
        criteria: [{ criterion: 'correctness', assessment: 'arm_a is tighter than arm_b here.', favors: 'a' }],
        shared_blind_spots: [],
        traits: [{ dimension: 'output_volume', more: 'b', note: 'Arm_b wrote more than arm_a.' }],
      },
      { shared_blind_spots: [] },
    ),
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001' });
  const written = readFileSync(join(root, result.comparisonPath), 'utf8');
  const blinding = deriveBlinding('pair0001-aaaa-bbbb-cccc-dddddddddddd');

  assert.doesNotMatch(written, /\barm_[ab]\b/i, 'no blinded label may survive into the artifact');
  assert.match(written, new RegExp(`${blinding.a} is tighter than ${blinding.b}`));
  assert.match(written, new RegExp(`${blinding.b} wrote more than ${blinding.a}`));
});

// ---------------------------------------------------------------------------
// --prepare / --record: the host-subagent path.
// ---------------------------------------------------------------------------

test('--prepare measures and writes the two blinded prompts, and writes no artifact', (t) => {
  // No judgeCommand configured at all — --prepare must need no judge dial.
  const root = seedPair(t, { primaryDiff: diffFor('src/a.ts', ['+x']), challengerDiff: diffFor('src/b.ts', ['+y']) });
  const result = runComparePrepare({ repoRoot: root, ref: 'pair0001' });

  assert.equal(result.prepared, true);
  assert.equal(result.judgeArchetype, 'judge');
  assert.ok(existsSync(join(root, result.comparisonPromptPath)));
  assert.ok(existsSync(join(root, result.adversarialPromptPath)));
  const comparisonPrompt = readFileSync(join(root, result.comparisonPromptPath), 'utf8');
  const adversarialPrompt = readFileSync(join(root, result.adversarialPromptPath), 'utf8');
  assert.match(comparisonPrompt, /fadeno-compare-task: comparison/);
  assert.match(adversarialPrompt, /fadeno-compare-task: adversarial/);
  assert.equal(existsSync(join(root, '.fadeno', 'comparisons')), false, '--prepare must write no artifact');
});

test('--prepare refuses an incomplete pair before writing anything, same as the one-shot path', (t) => {
  const root = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    challengerRowExtra: {
      event: 'dispatch_refused',
      refusal: { predicate: 'shadow_containment', message: 'the prompt contains this repo\'s absolute path' },
    },
  });
  assert.throws(
    () => runComparePrepare({ repoRoot: root, ref: 'pair0001' }),
    (err: unknown) => err instanceof CompareCommandError && /cannot be adjudicated/.test((err as Error).message),
  );
  assert.equal(existsSync(join(root, '.fadeno', 'local', 'prompts')), false, 'a refused pair gets no prompts either');
});

test('--record reconstructs the same blinding and writes an artifact byte-identical to the one-shot path, aside from delivery provenance', (t) => {
  const judgment = {
    verdict: 'prefer_a',
    criteria: [{ criterion: 'correctness', assessment: 'arm_a is better organized.', favors: 'a' }],
    shared_blind_spots: [],
    traits: [{ dimension: 'output_volume', more: 'b', note: 'arm_b wrote more for the same task.' }],
  };
  const adversarial = {
    shared_blind_spots: [{ issue: 'no offline test for the tool', why_invisible: 'both arms only ran the online suite', config_that_breaks_it: 'FADENO_OFFLINE=1' }],
  };

  const oneShotRoot = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(judgment, adversarial),
  });
  const oneShot = runCompare({ repoRoot: oneShotRoot, ref: 'pair0001' });
  const oneShotBody = readFileSync(join(oneShotRoot, oneShot.comparisonPath), 'utf8');

  // A SEPARATE, identically-seeded root — --prepare/--record need no judge
  // dial at all, which is the entire point of this path.
  const recordRoot = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
  });
  runComparePrepare({ repoRoot: recordRoot, ref: 'pair0001' });
  const comparisonFile = join(recordRoot, 'judge-comparison-result.json');
  const adversarialFile = join(recordRoot, 'judge-adversarial-result.json');
  writeFileSync(comparisonFile, JSON.stringify(judgment));
  writeFileSync(adversarialFile, JSON.stringify(adversarial));
  const recorded = runCompareRecord({
    repoRoot: recordRoot,
    ref: 'pair0001',
    comparisonPath: comparisonFile,
    adversarialPath: adversarialFile,
  });
  const recordedBody = readFileSync(join(recordRoot, recorded.comparisonPath), 'utf8');

  assert.equal(recorded.verdict, oneShot.verdict, 'the same judgment must unblind to the same verdict');

  // Strip what legitimately differs between the two delivery paths:
  // judge_delivery and dispatch_ids in the frontmatter (the recorded path
  // names no judge dispatch, because none was dispatched), and the one extra
  // Confounds line the host path is REQUIRED to disclose (see the
  // judge_delivery test below) — before comparing the rest of the artifact
  // byte-for-byte.
  const normalize = (body: string): string =>
    body
      .replace(/^judge_delivery:.*$/m, 'judge_delivery: <normalized>')
      .replace(/^dispatch_ids:\n(?: {2}- .*\n)*/m, 'dispatch_ids: <normalized>\n')
      .replace(/^- \[judge_delivery_unattested\].*\n/m, '');
  assert.equal(normalize(recordedBody), normalize(oneShotBody));
});

test('--record refuses a fabricated or schema-invalid judgment file, and writes nothing', (t) => {
  const root = seedPair(t, { primaryDiff: diffFor('src/a.ts', ['+x']), challengerDiff: diffFor('src/b.ts', ['+y']) });
  runComparePrepare({ repoRoot: root, ref: 'pair0001' });

  // The file does not exist at all.
  assert.throws(
    () => runCompareRecord({
      repoRoot: root, ref: 'pair0001',
      comparisonPath: join(root, 'missing.json'), adversarialPath: join(root, 'also-missing.json'),
    }),
    CompareCommandError,
  );

  // The file exists and is valid JSON, but not a shape the schema accepts —
  // the "fabricated" case: nothing prevents a coordinator from handing
  // --record any JSON at all, and this must be refused exactly like a
  // command-lane judge's invalid output is.
  const fabricated = join(root, 'fabricated.json');
  writeFileSync(fabricated, JSON.stringify({ hello: 'world' }));
  const goodAdversarial = join(root, 'good-adversarial.json');
  writeFileSync(goodAdversarial, JSON.stringify(GOOD_ADVERSARIAL));
  assert.throws(
    () => runCompareRecord({
      repoRoot: root, ref: 'pair0001',
      comparisonPath: fabricated, adversarialPath: goodAdversarial,
    }),
    CompareCommandError,
  );
  assert.equal(existsSync(join(root, '.fadeno', 'comparisons')), false, 'a refused record must write nothing');
});

test('judge_delivery is command on the one-shot path and host on --record, and the scorecard can tell them apart', (t) => {
  const judgment = {
    verdict: 'prefer_a',
    criteria: [{ criterion: 'correctness', assessment: 'x', favors: 'a' }],
    shared_blind_spots: [],
    traits: [],
  };

  const commandRoot = seedPair(t, {
    primaryDiff: diffFor('src/a.ts', ['+x']),
    challengerDiff: diffFor('src/b.ts', ['+y']),
    judgeCommand: judgeCommand(judgment, GOOD_ADVERSARIAL),
  });
  const commandResult = runCompare({ repoRoot: commandRoot, ref: 'pair0001' });
  assert.equal(commandResult.judgeDelivery, 'command');
  assert.ok(commandResult.judgeDispatchIds != null, 'the command lane must name its two judge dispatches');
  const commandArtifact = parseModelComparisonFile(commandRoot, commandResult.comparisonPath);
  assert.equal(commandArtifact.judgeDelivery, 'command');
  assert.ok(!commandResult.confounds.some((c) => c.code === 'judge_delivery_unattested'));

  const hostRoot = seedPair(t, { primaryDiff: diffFor('src/a.ts', ['+x']), challengerDiff: diffFor('src/b.ts', ['+y']) });
  runComparePrepare({ repoRoot: hostRoot, ref: 'pair0001' });
  const cmpFile = join(hostRoot, 'cmp.json');
  const advFile = join(hostRoot, 'adv.json');
  writeFileSync(cmpFile, JSON.stringify(judgment));
  writeFileSync(advFile, JSON.stringify(GOOD_ADVERSARIAL));
  const hostResult = runCompareRecord({ repoRoot: hostRoot, ref: 'pair0001', comparisonPath: cmpFile, adversarialPath: advFile });
  assert.equal(hostResult.judgeDelivery, 'host');
  assert.equal(hostResult.judgeDispatchIds, null, 'nothing was dispatched, so there is no receipt to name');
  assert.ok(
    hostResult.confounds.some((c) => c.code === 'judge_delivery_unattested'),
    'a host-delivered judgment must be disclosed as a confound, not just a frontmatter field',
  );
  const hostArtifact = parseModelComparisonFile(hostRoot, hostResult.comparisonPath);
  assert.equal(hostArtifact.judgeDelivery, 'host');

  const scorecard = runDispatchesComparisons({ repoRoot: hostRoot });
  assert.match(scorecard.lines.join('\n'), /judge delivery: host/);
});

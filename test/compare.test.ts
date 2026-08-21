import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { COMPARE_PROMPT_MARKER, deriveBlinding, runCompare, CompareCommandError } from '../src/commands/compare.ts';
import { runDispatchesComparisons } from '../src/commands/dispatches.ts';
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
  assert.equal(result.comparisonPath, `.fadeno/comparisons/${pairId.slice(0, 8)}.md`);

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

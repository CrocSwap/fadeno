import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import { runDispatches, type DispatchEntry } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/**
 * The two facts a pair used to lose silently.
 *
 * A shadow pair runs BOTH arms in isolated worktrees and moves the work back
 * as a diff taken from `git add -A` — which respects `.gitignore`. So a
 * paired arm's gitignored output (a `dist/`, a build cache) is not in the
 * diff and never reaches the caller's tree, while the dispatch reads exit 0
 * all the way down. `ignored_output_discarded` is the row that says so, and
 * `truncated` is the row admitting it could not enumerate everything: the one
 * thing it must never do is render like "there was nothing".
 *
 * The second fact is the opposite decision. A dispatch may declare (archetype
 * policy `ignored_output: kept`, or a per-dispatch override) that its ignored
 * output must survive, so no pair is formed at all — a `dispatch_refused` row
 * with predicate `ignored_output_kept`. That is a comparison traded away to
 * protect work, not a failure, and it must not read like one.
 *
 * Every fixture is hand-authored JSONL, as in `dispatches-evidence-fields`:
 * this is a READER, and the honest test of a reader is evidence bytes it did
 * not write — which also means it can be tested against the contract before,
 * and independently of, the writer that produces it.
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

const PAIR_ID = 'pair0123456789ab';
const PRIMARY_DIFF = '.fadeno/local/outputs/primary-1a2b3c4d.diff';

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
    primary_merge: { status: 'clean', diff_snapshot: PRIMARY_DIFF },
    ...over,
  };
}

/** The kernel's shadow-side refusal row: no pair formed, the primary ran on. */
function pairRefused(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: '1.0',
    timestamp: '2026-08-20T11:00:01.000Z',
    event: 'dispatch_refused',
    dispatch_id: 'shad0123456789ab',
    pair_id: PAIR_ID,
    archetype: 'worker',
    resolution: 'shadow',
    shadow: true,
    primary_dispatch_id: 'prim0123456789ab',
    executor: 'terra',
    refusal: {
      predicate: 'ignored_output_kept',
      message: 'worker declares ignored_output: kept — a paired run would not carry dist/ back.',
    },
    ...over,
  };
}

// --- group 1: output the diff could not carry -----------------------------

test('a paired arm names the gitignored output its diff left behind', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ ignored_output_discarded: { paths: ['dist/', '.cache/'] } }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.deepEqual(entries[0]!.ignoredOutputDiscarded, {
    paths: ['dist/', '.cache/'],
    truncated: false,
    // A primary's worktree is torn down after the merge-back, so its
    // discarded output is genuinely gone — no retention path.
    retainedAt: null,
  });
  assert.match(
    lines[0]!,
    /\[ignored output DISCARDED: dist\/, \.cache\/ — gitignored, so no diff carried it out of the worktree\]/,
  );
  // It sits on a line that otherwise reads as an unqualified success — which
  // is the whole reason it has to be there.
  assert.match(lines[0]!, /exit 0 in 12000ms/);
  assert.match(lines[0]!, /\[primary merged: clean\]/);
});

test('a truncated listing renders as a floor, never as the set', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      ignored_output_discarded: { paths: ['dist/', '.cache/'], truncated: true, retainedAt: null },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.ignoredOutputDiscarded!.truncated, true);
  assert.match(
    lines[0]!,
    /\[ignored output DISCARDED: at least dist\/, \.cache\/ — gitignored, so no diff carried it out of the worktree; the listing is a floor, not the set\]/,
  );
});

test('truncated with nothing enumerable still says something was lost', (t) => {
  const root = seed(t, [
    primaryRequested(),
    // A git failure: detection could not run, so it can neither list what was
    // discarded nor claim there was nothing.
    primaryCompleted({ ignored_output_discarded: { paths: [], truncated: true, retainedAt: null } }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.deepEqual(entries[0]!.ignoredOutputDiscarded, { paths: [], truncated: true, retainedAt: null });
  assert.match(
    lines[0]!,
    /\[ignored output DISCARDED — gitignored, and the listing could not be taken: what was left behind is unknown, not nothing\]/,
  );
});

test('a truncation says WHY, because two floors have different remedies', (t) => {
  const capped = 'more than 10000 ignored entries are present; the listing stopped there, so these paths are a floor, not the set.';
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      ignored_output_discarded: { paths: ['dist/'], truncated: true, note: capped },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.ignoredOutputDiscarded!.note, capped);
  assert.match(lines[0]!, /\[ignored output note: more than 10000 ignored entries are present;/);
  // "at least" already carries the floor claim, so the generic tail steps
  // aside for the writer's more specific one rather than saying it twice.
  assert.match(lines[0]!, /at least dist\//);
  assert.equal(
    lines[0]!.match(/a floor, not the set/g)!.length,
    1,
    'one finding, stated once',
  );
});

test('a git failure keeps its reason, where the 80-column prose cap would have cut it', (t) => {
  const note =
    'the ignored-output listing failed (EMFILE: too many open files, spawnSync git), ' +
    'so these 2 paths are a floor, not the set.';
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      ignored_output_discarded: { paths: ['dist/', '.cache/'], truncated: true, note },
    }),
  ]);
  const { lines } = runDispatches({ repoRoot: root });

  assert.match(lines[0]!, /EMFILE: too many open files/, 'the remedy-bearing half survives');
  assert.match(lines[0]!, /a floor, not the set\.\]/, 'and so does the end of the sentence');
});

test('a note is bounded to one line, however long the writer runs', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      ignored_output_discarded: {
        paths: ['dist/'],
        truncated: true,
        note: `the ignored-output listing failed (${'x'.repeat(4000)}), so these paths are a floor.`,
      },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.ignoredOutputDiscarded!.note!.length > 4000, true, '--json keeps all of it');
  assert.equal(lines[0]!.includes('\n'), false);
  assert.equal(lines[0]!.length < 600, true, 'the rendered line stays a line');
  assert.match(lines[0]!, /…\]/, 'and says it was cut');
});

test('a note with no truncation flag still reaches the reader', (t) => {
  const root = seed(t, [
    primaryRequested(),
    // Not a shape today's writer emits — it notes only when truncating — but
    // dropping prose because its companion flag was missing is the same
    // silent drop by a different route.
    primaryCompleted({
      ignored_output_discarded: { paths: [], note: 'scanned after the worktree was already gone.' },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.ignoredOutputDiscarded!.note, 'scanned after the worktree was already gone.');
  assert.match(lines[0]!, /\[ignored output DISCARDED — gitignored; the row names no paths\]/);
  assert.match(lines[0]!, /\[ignored output note: scanned after the worktree was already gone\.\]/);
});

test('a long listing is bounded but counts what it is not showing', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({
      ignored_output_discarded: {
        paths: ['dist/', '.cache/', 'coverage/', 'build/', 'target/'],
      },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.ignoredOutputDiscarded!.paths.length, 5, 'the entry keeps all of them');
  assert.match(lines[0]!, /dist\/, \.cache\/, coverage\/ \(\+2 more\)/);
  assert.doesNotMatch(lines[0]!, /target\//, 'the line is bounded');
  assert.doesNotMatch(lines[0]!, /a floor, not the set/, 'bounded rendering is not a truncated listing');
});

test('an absent object is not a claim, and nothing is synthesized for it', (t) => {
  const root = seed(t, [primaryRequested(), primaryCompleted()]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.ignoredOutputDiscarded, null);
  assert.doesNotMatch(lines[0]!, /ignored output/i);
});

test('an explicitly empty listing is read, and is no louder than omitting it', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ ignored_output_discarded: { paths: [] } }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.deepEqual(entries[0]!.ignoredOutputDiscarded, { paths: [], truncated: false, retainedAt: null }, 'read, not dropped');
  assert.doesNotMatch(lines[0]!, /ignored output/i, 'nothing discarded says nothing');
});

test('a malformed object costs itself, never the rest of the row', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ ignored_output_discarded: { paths: 'dist/' } }),
  ]);
  const { entries, lines, skipped } = runDispatches({ repoRoot: root });

  assert.equal(skipped, 0);
  assert.equal(entries[0]!.ignoredOutputDiscarded, null);
  assert.equal(entries[0]!.exitCode, 0, 'the rest of the completion row still reads');
  assert.doesNotMatch(lines[0]!, /ignored output/i);
});

test('a truncation flag this reader does not understand still reads as truncated', (t) => {
  const root = seed(t, [
    primaryRequested(),
    // A newer writer spelling the REASON where this expects a flag. Reading
    // it as "not truncated" would be the silent drop; erring the other way
    // only over-warns.
    primaryCompleted({
      ignored_output_discarded: { paths: ['dist/'], truncated: 'size_cap' },
    }),
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  assert.equal(entries[0]!.ignoredOutputDiscarded!.truncated, true);
  assert.match(lines[0]!, /at least dist\//);
});

test('a path with a newline in it does not break the one-line-per-entry view', (t) => {
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ ignored_output_discarded: { paths: ['we\nird/dist'] } }),
  ]);
  const { lines } = runDispatches({ repoRoot: root });

  assert.equal(lines[0]!.includes('\n'), false);
  // Escaped, not cut at: `we` would name a path that does not exist.
  assert.match(lines[0]!, /we\\nird\/dist/);
});

// --- group 2: the pair traded away on purpose -----------------------------

test('ignored_output_kept reads as a trade, not as a fault', (t) => {
  const root = seed(t, [primaryRequested(), pairRefused(), primaryCompleted()]);
  const { entries, lines, skipped } = runDispatches({ repoRoot: root });

  assert.equal(skipped, 0, 'a refusal row is evidence, never an unreadable line');
  const refusal = entries.find((e) => e.refusal != null)!;
  assert.equal(refusal.refusal!.predicate, 'ignored_output_kept');

  const line = lines[entries.indexOf(refusal)]!;
  assert.match(
    line,
    /\[no pair: ignored_output_kept — the comparison was traded away so the gitignored output survives\]/,
  );
  // The point of the whole case: nothing on this line accuses anyone.
  assert.doesNotMatch(line, /refused/i);
  assert.doesNotMatch(line, /FAILED|error/i);
  // The writer's own prose still follows the marker, as it does for a denial.
  assert.match(line, /worker declares ignored_output: kept/);
});

test('the steering hook spells the same choice the same way', (t) => {
  const root = seed(t, [
    {
      format: '1.0',
      timestamp: '2026-08-20T10:05:00.000Z',
      event: 'host_refused',
      archetype: 'worker',
      agent_type: 'worker',
      executor: 'luna',
      model: 'opus',
      refusal: {
        predicate: 'ignored_output_kept',
        message: 'worker keeps its ignored output; no pair was formed.',
      },
    },
  ]);
  const { lines } = runDispatches({ repoRoot: root });

  assert.match(lines[0]!, /\[no pair: ignored_output_kept/);
  assert.doesNotMatch(lines[0]!, /refused/i);
});

test('every other predicate still renders as the denial it is', (t) => {
  const root = seed(t, [
    primaryRequested(),
    pairRefused({
      refusal: {
        predicate: 'shadow_cap',
        message: '2 shadows are already running and the live cap is 2 — let one finish.',
      },
    }),
  ]);
  const { lines } = runDispatches({ repoRoot: root });

  const line = lines.find((l) => l.includes('shadow_cap'))!;
  assert.match(line, /\[refused: shadow_cap\]/);
  assert.doesNotMatch(line, /no pair:/);
});

// --- the same facts, through the real `--json` surface --------------------

test('fadeno dispatches --json carries both of them', (t) => {
  const root = seed(t, [
    primaryRequested(),
    pairRefused(),
    primaryCompleted({
      ignored_output_discarded: {
        paths: ['dist/', '.cache/'],
        truncated: true,
        note: 'the ignored-output listing failed (exit 128), so these 2 paths are a floor, not the set.',
      },
    }),
  ]);
  const { entries } = cliJson(root);

  assert.equal(entries.length, 2);
  const [primary, refusal] = entries;

  assert.deepEqual(primary!.ignoredOutputDiscarded, {
    paths: ['dist/', '.cache/'],
    truncated: true,
    note: 'the ignored-output listing failed (exit 128), so these 2 paths are a floor, not the set.',
    retainedAt: null,
  });
  assert.deepEqual(refusal!.refusal, {
    predicate: 'ignored_output_kept',
    message: 'worker declares ignored_output: kept — a paired run would not carry dist/ back.',
  });
  assert.equal(refusal!.ignoredOutputDiscarded, null, 'a refused pair discarded nothing');
});

test('a challenger says its output is still on disk; a primary says nothing of the kind', (t) => {
  // "Discarded" means two different things on the two arms and the row has to
  // say which. A challenger's worktree is RETAINED until `fadeno clean`, so
  // its output is gone from the comparison while still sitting on disk. A
  // primary's worktree is torn down after the merge-back, so its output is
  // genuinely unrecoverable. Same field, same rendering, opposite fates —
  // which is why the writer stamps it rather than leaving a reader to infer
  // it from whether some other field happens to be set.
  const root = seed(t, [
    primaryRequested(),
    primaryCompleted({ ignored_output_discarded: { paths: ['dist/'] } }),
    {
      ...primaryRequested(),
      dispatch_id: 'chal0123456789ab',
      shadow: true,
      pair_id: PAIR_ID,
      primary_dispatch_id: 'prim0123456789ab',
      resolution: 'shadow',
    },
    {
      ...primaryCompleted(),
      dispatch_id: 'chal0123456789ab',
      shadow: true,
      primary_dispatch_id: 'prim0123456789ab',
      resolution: 'shadow',
      primary_merge: undefined,
      ignored_output_discarded: { paths: ['dist/'], retained_at: '.fadeno/local/pair/aaaaaaaa/bbbbbbbb' },
    },
  ]);
  const { entries, lines } = runDispatches({ repoRoot: root });

  const primary = entries.find((e) => !e.shadow)!;
  const challenger = entries.find((e) => e.shadow)!;

  assert.equal(primary.ignoredOutputDiscarded!.retainedAt, null);
  assert.equal(challenger.ignoredOutputDiscarded!.retainedAt, '.fadeno/local/pair/aaaaaaaa/bbbbbbbb');

  const primaryLine = lines.find((l) => !l.includes('shadow of'))!;
  const challengerLine = lines.find((l) => l.includes('shadow of'))!;
  assert.doesNotMatch(primaryLine, /still on disk/, 'a torn-down worktree must not promise recovery');
  assert.match(challengerLine, /still on disk at \.fadeno\/local\/pair\/aaaaaaaa\/bbbbbbbb until `fadeno clean`/);
});

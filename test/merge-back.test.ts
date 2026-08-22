import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { runDispatchesMerge, runDispatchesOutput } from '../src/commands/dispatches.ts';
import { applyDiffToWorkspace, hasConflictMarkers, rebaseWorktreeOntoWorkspace, settleIsolatedWork } from '../src/lib/workspace-baseline.ts';
import { collectIsolatedDiff } from '../src/lib/workspace-lease.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// Merge-back on the pull-request model. The worktree is the branch, the
// caller's working tree is main, and main moves: sibling members merge back,
// the human edits. The branch reconciles; main only ever receives a plain
// `git apply` that lands whole or touches nothing. Conflict markers exist
// only in a retained worktree.
//
// Two live failures this replaces, both 2026-08-22: `git apply --3way`
// implied `--index` and refused a whole patch because one edited file lived
// in an untracked directory (`does not exist in index`); and its failure
// mode wrote markers into the CALLER's tree, so a receipt had to say
// `conflicted` — "the tree may be partly applied, go look".

const REPO = join(import.meta.dirname, '..');
const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid',
};

function git(root: string, args: string[]): string {
  const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
  if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${s.stderr ?? s.error}`);
  return s.stdout;
}

const FIVE_LINES = 'line1\nline2\nline3\nline4\nline5\n';

/** A repo with one tracked five-line file and one untracked directory. */
function seedRepo(t: TestContext): string {
  const root = tempRepo(t);
  git(root, ['init']);
  writeFileSync(join(root, 'tracked.txt'), FIVE_LINES);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  mkdirSync(join(root, 'pmcap'));
  writeFileSync(join(root, 'pmcap', 'a.txt'), 'original untracked\n');
  return root;
}

/**
 * Cut a worktree the way an isolated delivery does — from HEAD, with the
 * caller's untracked file copied in and committed as the baseline — then
 * make the edit and collect the diff. Returns what the engine holds at
 * settle time.
 */
function worktreeWithEdit(root: string, name: string, edit: (wt: string) => void) {
  const wt = join(root, '.fadeno', 'local', 'engine', name);
  mkdirSync(join(root, '.fadeno', 'local', 'engine'), { recursive: true });
  git(root, ['worktree', 'add', '--detach', wt, 'HEAD']);
  mkdirSync(join(wt, 'pmcap'), { recursive: true });
  writeFileSync(join(wt, 'pmcap', 'a.txt'), readFileSync(join(root, 'pmcap', 'a.txt')));
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-m', 'baseline']);
  const baseline = git(wt, ['rev-parse', 'HEAD']).trim();
  edit(wt);
  const diffAbs = join(root, '.fadeno', 'local', 'outputs', `${name}.diff`);
  const diff = collectIsolatedDiff({ repoRoot: root, worktreeAbs: wt, diffAbs, diffRel: `.fadeno/local/outputs/${name}.diff` });
  return { wt, baseline, diff };
}

function edited(lines: Record<number, string>): string {
  return FIVE_LINES.split('\n').map((l, i) => (lines[i + 1] ?? l)).join('\n');
}

test('plain apply: an edit to a file the workspace holds untracked lands beside tracked hunks, with no index involved', (t) => {
  const root = seedRepo(t);
  const { wt, diff } = worktreeWithEdit(root, 'w1', (w) => {
    writeFileSync(join(w, 'pmcap', 'a.txt'), 'edited\n');
    writeFileSync(join(w, 'pmcap', 'b.txt'), 'new\n');
    writeFileSync(join(w, 'tracked.txt'), edited({ 3: 'line3 edited' }));
  });
  const settled = settleIsolatedWork({ repoRoot: root, worktreeAbs: wt, diff, baselineRef: 'w1', armLabel: 'test' });
  assert.deepEqual(settled.stamp, { status: 'clean' });
  assert.equal(readFileSync(join(root, 'pmcap', 'a.txt'), 'utf8'), 'edited\n');
  assert.equal(readFileSync(join(root, 'pmcap', 'b.txt'), 'utf8'), 'new\n');
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), edited({ 3: 'line3 edited' }));
  // Plain apply stages nothing: the caller's index is exactly as they left it.
  assert.equal(git(root, ['diff', '--cached', '--name-only']).trim(), '');
  assert.ok(existsSync(wt), 'the helper never tears down; the caller does');
});

test('the workspace moved without overlap: the worktree is rebased onto it and the work lands, stamped with the new baseline', (t) => {
  const root = seedRepo(t);
  const { wt, baseline, diff } = worktreeWithEdit(root, 'w2', (w) => {
    writeFileSync(join(w, 'tracked.txt'), edited({ 5: 'line5 by the attempt' }));
  });
  // Main moves inside the attempt's context lines (line 3 is in the hunk's
  // context for line 5), so a plain apply refuses — but nothing overlaps.
  writeFileSync(join(root, 'tracked.txt'), edited({ 3: 'line3 by the caller' }));
  assert.equal(applyDiffToWorkspace(root, diff.diffAbs).ok, false, 'precondition: the tree moved under the diff');

  const settled = settleIsolatedWork({ repoRoot: root, worktreeAbs: wt, diff, baselineRef: 'w2', armLabel: 'test' });
  assert.equal(settled.stamp.status, 'clean');
  assert.match(settled.stamp.detail ?? '', /rebased onto it before applying/);
  assert.ok(settled.stamp.rebased_onto != null && settled.stamp.rebased_onto !== baseline, 'a new baseline was committed');
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), edited({ 3: 'line3 by the caller', 5: 'line5 by the attempt' }));
  // The worktree's HEAD is the new baseline and its diff was re-collected against it.
  assert.equal(git(wt, ['rev-parse', 'HEAD']).trim(), settled.stamp.rebased_onto);
  assert.ok(settled.diff.diffBytes > 0);
  assert.doesNotMatch(readFileSync(settled.diff.diffAbs, 'utf8'), /^\+line3 by the caller/m, 'the re-collected diff carries only the attempt\'s work — the caller\'s line is context, not a change');
});

test('the workspace moved on the same lines: unresolved, markers in the retained worktree only, the workspace untouched', (t) => {
  const root = seedRepo(t);
  const { wt, diff } = worktreeWithEdit(root, 'w3', (w) => {
    writeFileSync(join(w, 'tracked.txt'), edited({ 3: 'line3 by the attempt' }));
    writeFileSync(join(w, 'pmcap', 'a.txt'), 'also edited\n');
  });
  writeFileSync(join(root, 'tracked.txt'), edited({ 3: 'line3 by the caller' }));

  const settled = settleIsolatedWork({ repoRoot: root, worktreeAbs: wt, diff, baselineRef: 'w3', armLabel: 'test' });
  assert.equal(settled.stamp.status, 'unresolved');
  assert.deepEqual(settled.stamp.conflicts, ['tracked.txt']);
  assert.ok(settled.stamp.rebased_onto);
  assert.match(settled.stamp.detail ?? '', /1 file\(s\) conflict: tracked\.txt/);
  // Markers in the worktree, as an ordinary dirty tree: no cherry-pick in
  // progress, nothing unmerged in the index, HEAD at the new baseline.
  const inWorktree = readFileSync(join(wt, 'tracked.txt'), 'utf8');
  assert.ok(hasConflictMarkers(inWorktree), inWorktree);
  assert.match(inWorktree, /line3 by the caller/);
  assert.match(inWorktree, /line3 by the attempt/);
  assert.equal(existsSync(join(git(root, ['rev-parse', '--git-common-dir']).trim(), 'worktrees', 'w3', 'CHERRY_PICK_HEAD')), false);
  assert.equal(git(wt, ['diff', '--name-only', '--diff-filter=U']).trim(), '');
  assert.equal(git(wt, ['rev-parse', 'HEAD']).trim(), settled.stamp.rebased_onto);
  // The non-conflicting part of the work rode along into the worktree.
  assert.equal(readFileSync(join(wt, 'pmcap', 'a.txt'), 'utf8'), 'also edited\n');
  // The caller's tree never saw a marker.
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), edited({ 3: 'line3 by the caller' }));
  assert.equal(readFileSync(join(root, 'pmcap', 'a.txt'), 'utf8'), 'original untracked\n');
});

test('a round that leaves markers in place is unresolved again — git would have applied them as content', (t) => {
  const root = seedRepo(t);
  const { wt, diff } = worktreeWithEdit(root, 'w4', (w) => {
    writeFileSync(join(w, 'tracked.txt'), '<<<<<<< HEAD\nline1\n=======\nline1 other\n>>>>>>> theirs\nline2\nline3\nline4\nline5\n');
  });
  const settled = settleIsolatedWork({ repoRoot: root, worktreeAbs: wt, diff, baselineRef: 'w4', armLabel: 'test', priorConflicts: ['tracked.txt'] });
  assert.equal(settled.stamp.status, 'unresolved');
  assert.deepEqual(settled.stamp.conflicts, ['tracked.txt']);
  assert.match(settled.stamp.detail ?? '', /conflict markers remain/);
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), FIVE_LINES, 'nothing applied');
  // Without the prior-conflict list there is nothing to check against, and
  // the same bytes would apply: the list is what makes the check possible.
  assert.equal(hasConflictMarkers('=======\nnot a conflict\n'), false);
});

test('rebase alone: a clean pick reports no conflicts and a new baseline', (t) => {
  const root = seedRepo(t);
  const { wt, baseline } = worktreeWithEdit(root, 'w5', (w) => {
    writeFileSync(join(w, 'tracked.txt'), edited({ 5: 'line5 by the attempt' }));
  });
  writeFileSync(join(root, 'tracked.txt'), edited({ 1: 'line1 by the caller' }));
  const rebased = rebaseWorktreeOntoWorkspace({ repoRoot: root, worktreeAbs: wt, baselineRef: 'w5', armLabel: 'test' });
  assert.equal(rebased.status, 'clean');
  assert.deepEqual(rebased.conflicts, []);
  assert.notEqual(rebased.baselineCommit, baseline);
  assert.equal(readFileSync(join(wt, 'tracked.txt'), 'utf8'), edited({ 1: 'line1 by the caller', 5: 'line5 by the attempt' }));
});

// ---------------------------------------------------------------------------
// Through a real kernel-isolated dispatch, receipt included.
// ---------------------------------------------------------------------------

function seedDispatch(t: TestContext, cmd: string[]): string {
  const root = seedRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { w: { provider: 'openai', id: 'w' } },
    routes: { standalone: { openai: { command: cmd } } },
    archetypes: { worker: {} },
    dials: { worker: 'w' },
  }));
  return root;
}

function rows(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, DISPATCHES_FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('a kernel-isolated dispatch that edits an untracked file merges back clean, with no detail to explain', (t) => {
  const root = seedDispatch(t, ['node', '-e',
    "const fs=require('fs');" +
    "fs.writeFileSync('pmcap/a.txt','edited by worker\\n');" +
    "fs.writeFileSync('pmcap/b.txt','new by worker\\n');" +
    "fs.writeFileSync('tracked.txt','line1\\nline2\\nline3 edited\\nline4\\nline5\\n');" +
    "process.stdout.write('DONE')"]);
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'edit', tag: 'worker-edit', repoRoot: root, userPathOptions: onHarness('standalone'), onEcho: (l) => echoes.push(l) });
  assert.equal(result.outcome, 'ok');
  const comp = rows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal(comp.workspace_mode, 'isolated');
  assert.deepEqual(comp.primary_merge, { status: 'clean' });
  assert.ok(!('workspace_retained' in comp));
  assert.equal(readFileSync(join(root, 'pmcap', 'a.txt'), 'utf8'), 'edited by worker\n');
  assert.ok(existsSync(join(root, 'pmcap', 'b.txt')));
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), edited({ 3: 'line3 edited' }));
  assert.ok(echoes.some((l) => /^merged back: \d+ bytes applied to the workspace$/.test(l)), echoes.join('\n'));
  const isolatedDir = join(root, '.fadeno', 'local', 'isolated');
  assert.equal(existsSync(isolatedDir) ? readdirSync(isolatedDir).length : 0, 0, 'the worktree was torn down');
});

test('a kernel-isolated dispatch whose work conflicts with a workspace that moved: unresolved, worktree retained, every surface says so', (t) => {
  const root = seedDispatch(t, ['node', '-e',
    "const fs=require('fs');" +
    "fs.writeFileSync('tracked.txt','line1\\nline2\\nline3 by the worker\\nline4\\nline5\\n');" +
    // Move the caller's tree on the same line from inside the worktree: the
    // merge-back runs after the executor exits, so the tree has moved by then.
    "fs.writeFileSync(process.env.CALLER_ROOT+'/tracked.txt','line1\\nline2\\nline3 by the caller\\nline4\\nline5\\n');" +
    "process.stdout.write('DONE')"]);
  process.env.CALLER_ROOT = root;
  t.after(() => { delete process.env.CALLER_ROOT; });
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'edit', tag: 'worker-conflict', repoRoot: root, userPathOptions: onHarness('standalone'), onEcho: (l) => echoes.push(l) });
  assert.equal(result.outcome, 'ok', 'the executor itself succeeded; the merge did not');
  const comp = rows(root).find((r) => r.event === 'dispatch_completed')!;
  const merge = comp.primary_merge as { status: string; detail?: string; conflicts?: string[]; rebased_onto?: string };
  assert.equal(merge.status, 'unresolved');
  assert.deepEqual(merge.conflicts, ['tracked.txt']);
  assert.ok(merge.rebased_onto);
  assert.equal(comp.workspace_retained, true);
  const retained = comp.workspace as string;
  assert.ok(typeof retained === 'string' && existsSync(join(root, retained)), `worktree retained at ${retained}`);
  assert.ok(hasConflictMarkers(readFileSync(join(root, retained, 'tracked.txt'), 'utf8')));
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), edited({ 3: 'line3 by the caller' }), 'the caller\'s tree is untouched');
  const echo = echoes.find((l) => l.startsWith('merge-back UNRESOLVED'));
  assert.ok(echo, echoes.join('\n'));
  assert.match(echo!, /conflicts with the workspace in 1 file\(s\): tracked\.txt/);
  assert.match(echo!, new RegExp(`retained at ${retained.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} with conflict markers`));
  assert.match(echo!, /fadeno dispatches --merge [0-9a-f]{8}/);
  const cli = spawnSync('node', [join(REPO, 'src', 'cli.ts'), 'dispatches', '--output', 'tag:worker-conflict'], { cwd: root, encoding: 'utf8' });
  assert.match(cli.stderr, /merge-back UNRESOLVED: the work conflicts with the workspace and did NOT land; the worktree is retained with conflict markers/);
});

test('dispatches --merge: refuses while markers remain, merges once they are resolved, and records a dispatch_merged row', (t) => {
  const root = seedDispatch(t, ['node', '-e',
    "const fs=require('fs');" +
    "fs.writeFileSync('tracked.txt','line1\\nline2\\nline3 by the worker\\nline4\\nline5\\n');" +
    "fs.writeFileSync(process.env.CALLER_ROOT+'/tracked.txt','line1\\nline2\\nline3 by the caller\\nline4\\nline5\\n');" +
    "process.stdout.write('DONE')"]);
  process.env.CALLER_ROOT = root;
  t.after(() => { delete process.env.CALLER_ROOT; });
  runDispatch({ archetype: 'worker', prompt: 'edit', tag: 'worker-merge', repoRoot: root, userPathOptions: onHarness('standalone') });
  const comp = rows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal((comp.primary_merge as { status: string }).status, 'unresolved');
  const retained = comp.workspace as string;

  assert.throws(
    () => runDispatchesMerge({ repoRoot: root, tag: 'worker-merge' }),
    (err: unknown) => err instanceof Error && /still conflicts with the workspace \(tracked\.txt\)[\s\S]*conflict markers remain/.test(err.message),
  );
  assert.ok(existsSync(join(root, retained)), 'refusal keeps the worktree');
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), edited({ 3: 'line3 by the caller' }), 'refusal touches nothing');

  writeFileSync(join(root, retained, 'tracked.txt'), edited({ 3: 'line3 resolved by hand' }));
  const merged = runDispatchesMerge({ repoRoot: root, tag: 'worker-merge' });
  assert.equal(merged.mergeBack.status, 'clean');
  assert.match(merged.mergeBack.detail ?? '', /merged by hand/);
  assert.equal(merged.workspace, retained);
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), edited({ 3: 'line3 resolved by hand' }));
  assert.equal(existsSync(join(root, retained)), false, 'the worktree is removed once merged');
  const row = rows(root).find((r) => r.event === 'dispatch_merged')!;
  assert.equal(row.dispatch_id, merged.dispatchId);
  assert.equal(row.tag, 'worker-merge');
  assert.equal(row.merged_by, 'host');
  assert.deepEqual(row.merge, merged.mergeBack);
  assert.ok(existsSync(join(root, row.diff_snapshot as string)));

  // The reader carries the later fact.
  const out = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-merge' });
  assert.equal(out.primaryMerge?.status, 'clean');
  assert.equal(out.workspace, null);
  const cli = spawnSync('node', [join(REPO, 'src', 'cli.ts'), 'dispatches', '--output', 'tag:worker-merge'], { cwd: root, encoding: 'utf8' });
  assert.match(cli.stderr, /merge-back clean: merged by hand/);
  assert.doesNotMatch(cli.stderr, /UNRESOLVED/);
  assert.throws(() => runDispatchesMerge({ repoRoot: root, tag: 'worker-merge' }), /was already merged/);
});

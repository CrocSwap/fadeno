import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { runDispatchesOutput } from '../src/commands/dispatches.ts';
import { applyMergeBackDiff, mergeBackReapplyCommand } from '../src/lib/workspace-lease.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// The failure these tests pin, seen live on 2026-08-22: a worker dispatched
// into an isolated worktree edited a file that lived in a directory the
// caller's workspace held UNTRACKED. The baseline had copied that directory
// into the worktree and committed it, so the diff described the edit as a
// modification of a tracked file; `git apply --3way` in the caller's repo
// then refused the WHOLE patch — `does not exist in index` — and the receipt
// said `conflicted` about a tree nothing had touched. The tracked hunks in
// the same diff were dropped with it.

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

/** A repo with one tracked file and one untracked directory, like the live case. */
function seedRepo(t: TestContext): string {
  const root = tempRepo(t);
  git(root, ['init']);
  writeFileSync(join(root, 'tracked.txt'), 'tracked\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  mkdirSync(join(root, 'pmcap'));
  writeFileSync(join(root, 'pmcap', 'a.txt'), 'original untracked\n');
  return root;
}

/**
 * Build the diff exactly the way an isolated delivery does: a worktree cut
 * from HEAD, the caller's untracked file copied in and committed as the
 * baseline, the edit made on top, and the diff taken against that baseline.
 */
function diffFromWorktree(root: string, edit: (wt: string) => void): string {
  const wt = join(root, '.fadeno', 'local', 'wt');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  git(root, ['worktree', 'add', '--detach', wt, 'HEAD']);
  mkdirSync(join(wt, 'pmcap'));
  writeFileSync(join(wt, 'pmcap', 'a.txt'), readFileSync(join(root, 'pmcap', 'a.txt')));
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-m', 'baseline']);
  edit(wt);
  git(wt, ['add', '-A']);
  const diff = git(wt, ['diff', '--binary', '--cached']);
  const diffAbs = join(root, '.fadeno', 'local', 'merge.diff');
  writeFileSync(diffAbs, diff);
  git(root, ['worktree', 'remove', '--force', wt]);
  return diffAbs;
}

test('merge-back: an edit to a file the workspace holds untracked lands, with the tracked hunks beside it, and says how', (t) => {
  const root = seedRepo(t);
  const diffAbs = diffFromWorktree(root, (wt) => {
    writeFileSync(join(wt, 'pmcap', 'a.txt'), 'edited\n');
    writeFileSync(join(wt, 'pmcap', 'b.txt'), 'new\n');
    writeFileSync(join(wt, 'tracked.txt'), 'tracked edited\n');
  });
  const merged = applyMergeBackDiff({ repoRoot: root, diffAbs });
  assert.equal(merged.stamp.status, 'clean');
  assert.match(merged.stamp.detail ?? '', /pmcap\/a\.txt is untracked in the workspace/);
  assert.match(merged.stamp.detail ?? '', /left unstaged/);
  assert.deepEqual(merged.untracked, ['pmcap/a.txt']);
  // Every hunk reached the tree — the untracked edit, the new file beside
  // it, and the tracked file's hunk that used to be dropped with them.
  assert.equal(readFileSync(join(root, 'pmcap', 'a.txt'), 'utf8'), 'edited\n');
  assert.equal(readFileSync(join(root, 'pmcap', 'b.txt'), 'utf8'), 'new\n');
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'tracked edited\n');
  // The recovery pointer for this shape is the plain apply, not `--3way`,
  // which would reproduce the refusal.
  assert.equal(mergeBackReapplyCommand('x.diff', merged.untracked), 'git apply x.diff');
  assert.equal(mergeBackReapplyCommand('x.diff', []), 'git apply --3way x.diff');
});

test('merge-back: a diff touching only tracked files still goes through 3-way and stamps no detail', (t) => {
  const root = seedRepo(t);
  const diffAbs = diffFromWorktree(root, (wt) => {
    writeFileSync(join(wt, 'tracked.txt'), 'tracked edited\n');
  });
  const merged = applyMergeBackDiff({ repoRoot: root, diffAbs });
  assert.deepEqual(merged, { stamp: { status: 'clean' }, untracked: [] });
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'tracked edited\n');
});

test('merge-back: when the untracked file moved under the worktree, nothing is applied and the stamp says blocked, not conflicted', (t) => {
  const root = seedRepo(t);
  const diffAbs = diffFromWorktree(root, (wt) => {
    writeFileSync(join(wt, 'pmcap', 'a.txt'), 'edited\n');
    writeFileSync(join(wt, 'tracked.txt'), 'tracked edited\n');
  });
  // The caller changed the untracked file after the baseline was captured,
  // so the plain apply's preimage no longer matches. `git apply` is atomic:
  // the tracked hunk must not land either, and the reader must be told the
  // tree is untouched rather than sent to inspect it.
  writeFileSync(join(root, 'pmcap', 'a.txt'), 'changed by the caller meanwhile\n');
  const merged = applyMergeBackDiff({ repoRoot: root, diffAbs });
  assert.equal(merged.stamp.status, 'blocked');
  assert.match(merged.stamp.detail ?? '', /^nothing was applied: pmcap\/a\.txt is untracked in the workspace/);
  assert.match(merged.stamp.detail ?? '', /plain working-tree apply refused too/);
  assert.equal(readFileSync(join(root, 'pmcap', 'a.txt'), 'utf8'), 'changed by the caller meanwhile\n');
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'tracked\n');
  assert.equal(git(root, ['status', '--porcelain']).includes('tracked.txt'), false);
});

test('merge-back: a genuine 3-way conflict on a tracked file is still conflicted, and the 3-way markers are left for the reader', (t) => {
  const root = seedRepo(t);
  const diffAbs = diffFromWorktree(root, (wt) => {
    writeFileSync(join(wt, 'tracked.txt'), 'tracked edited by the attempt\n');
  });
  writeFileSync(join(root, 'tracked.txt'), 'tracked edited by the caller\n');
  git(root, ['commit', '-am', 'caller moved on']);
  const merged = applyMergeBackDiff({ repoRoot: root, diffAbs });
  assert.equal(merged.stamp.status, 'conflicted');
  assert.deepEqual(merged.untracked, []);
  assert.match(readFileSync(join(root, 'tracked.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);
});

// ---------------------------------------------------------------------------
// The same through a real kernel-isolated dispatch, receipt included.
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

const EDIT_UNTRACKED = ['node', '-e',
  "const fs=require('fs');" +
  "fs.writeFileSync('pmcap/a.txt','edited by worker\\n');" +
  "fs.writeFileSync('pmcap/b.txt','new by worker\\n');" +
  "fs.writeFileSync('tracked.txt','tracked edited\\n');" +
  "process.stdout.write('DONE')"];

test('a kernel-isolated dispatch that edits an untracked file merges back clean, and the receipt and --output both say how', (t) => {
  const root = seedDispatch(t, EDIT_UNTRACKED);
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'edit', tag: 'worker-edit', repoRoot: root, userPathOptions: onHarness('standalone'), onEcho: (l) => echoes.push(l) });
  assert.equal(result.outcome, 'ok');
  const comp = rows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal(comp.workspace_mode, 'isolated');
  const merge = comp.primary_merge as { status: string; detail?: string };
  assert.equal(merge.status, 'clean');
  assert.match(merge.detail ?? '', /pmcap\/a\.txt is untracked in the workspace/);
  assert.equal(readFileSync(join(root, 'pmcap', 'a.txt'), 'utf8'), 'edited by worker\n');
  assert.ok(existsSync(join(root, 'pmcap', 'b.txt')));
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'tracked edited\n');
  assert.ok(echoes.some((l) => /^merged back: \d+ bytes applied to the workspace \(applied to the working tree/.test(l)), echoes.join('\n'));

  // The recovery reader carries the stamp too, so a proxy relaying the
  // output relays the merge-back with it.
  const out = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-edit' });
  assert.equal(out.primaryMerge?.status, 'clean');
  const cli = spawnSync('node', [join(REPO, 'src', 'cli.ts'), 'dispatches', '--output', 'tag:worker-edit'], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.match(cli.stderr, /ok: exit 0, 4 bytes; merge-back clean: applied to the working tree/);
});

test('a kernel-isolated dispatch whose merge-back is blocked says so on the receipt, the echo, and --output — and the tree is untouched', (t) => {
  const root = seedDispatch(t, ['node', '-e',
    "const fs=require('fs');" +
    // Edit the untracked file AND move the caller's copy out from under the
    // merge, from inside the worktree: the merge-back runs after the
    // executor exits, so the caller's tree has changed by then.
    "fs.writeFileSync('pmcap/a.txt','edited by worker\\n');" +
    "fs.writeFileSync(process.env.CALLER_ROOT+'/pmcap/a.txt','changed meanwhile\\n');" +
    "process.stdout.write('DONE')"]);
  process.env.CALLER_ROOT = root;
  t.after(() => { delete process.env.CALLER_ROOT; });
  const echoes: string[] = [];
  runDispatch({ archetype: 'worker', prompt: 'edit', tag: 'worker-blocked', repoRoot: root, userPathOptions: onHarness('standalone'), onEcho: (l) => echoes.push(l) });
  const comp = rows(root).find((r) => r.event === 'dispatch_completed')!;
  const merge = comp.primary_merge as { status: string; detail?: string };
  assert.equal(merge.status, 'blocked');
  assert.match(merge.detail ?? '', /^nothing was applied: pmcap\/a\.txt is untracked/);
  assert.equal(readFileSync(join(root, 'pmcap', 'a.txt'), 'utf8'), 'changed meanwhile\n');
  const blocked = echoes.find((l) => l.startsWith('merge-back BLOCKED'));
  assert.ok(blocked, echoes.join('\n'));
  assert.match(blocked!, /nothing was applied, the workspace is untouched/);
  assert.match(blocked!, /Resolve with `git apply \.fadeno\/local\/outputs\/[^`]+\.diff`/);
  assert.doesNotMatch(blocked!, /--3way/);
  const cli = spawnSync('node', [join(REPO, 'src', 'cli.ts'), 'dispatches', '--output', 'tag:worker-blocked'], { cwd: root, encoding: 'utf8' });
  assert.match(cli.stderr, /merge-back BLOCKED: nothing was applied, the workspace is untouched/);
});

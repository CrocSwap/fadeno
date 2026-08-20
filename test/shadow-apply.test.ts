import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DISPATCHES_FILE, DISPATCHES_FORMAT } from '../src/commands/dispatch.ts';
import { DispatchesCommandError } from '../src/commands/dispatches.ts';
import { ShadowApplyCommandError, runShadowApply } from '../src/commands/shadow-apply.ts';
import { FADENO_IGNORE_PATTERNS } from '../src/lib/source-control.ts';
import { tempRepo } from './helpers.ts';

const REPO = join(import.meta.dirname, '..');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@invalid',
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.error}`);
  }
  return result.stdout ?? '';
}

/**
 * A real fadeno-managed repo already has `.fadeno/local/` and
 * `.fadeno/dispatches.jsonl` gitignored (`ensureFadenoIgnore`, called the
 * first time any evidence row is written) well before a shadow pair ever
 * fires. Seeding that upfront here — rather than leaving it to
 * `runShadowApply`'s own call to that same helper — keeps this fixture's
 * `git add -A` calls (used below to simulate "the main tree moves on while
 * the pair runs") from sweeping up and committing the challenger's own
 * worktree as an embedded-repository gitlink, which could never happen in a
 * real repo once the ignore file exists.
 */
function initGit(root: string): void {
  git(root, ['init']);
  writeFileSync(join(root, 'f.txt'), 'line1\nline2\nline3\n');
  writeFileSync(join(root, '.gitignore'), `${FADENO_IGNORE_PATTERNS.join('\n')}\n`, 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
}

function row(over: Record<string, unknown>): Record<string, unknown> {
  return { format: DISPATCHES_FORMAT, archetype: 'worker', role: null, ...over };
}

function appendRows(root: string, rows: Record<string, unknown>[]): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const path = join(root, DISPATCHES_FILE);
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, prior + rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function ts(offsetSeconds: number): string {
  return new Date(Date.parse('2026-08-19T12:00:00.000Z') + offsetSeconds * 1000).toISOString();
}

const DEFAULT_EDIT = (worktreeAbs: string): void => {
  const p = join(worktreeAbs, 'f.txt');
  writeFileSync(p, readFileSync(p, 'utf8').replace('line2', 'line2-challenger'));
};

/**
 * Cut a real detached worktree from HEAD, run `edit` in it, stage the
 * result, and capture the real `git diff --binary --cached` bytes as a diff
 * artifact under `diffRel` — the exact mechanism `dispatch.ts` uses for a
 * shadow challenger (`commitWorkspaceBaseline` + the post-run diff capture in
 * `collectShadow`) and for an `--isolate`d primary.
 *
 * With no `baselineReplay`, the baseline is simply the worktree's cut-from
 * HEAD — the "clean primary tree" case `commitWorkspaceBaseline` documents,
 * which is also an ancestor of the main branch and so is NOT a useful
 * fixture for testing baseline garbage collection. `baselineReplay`, when
 * given, commits an extra change in the worktree first (mirroring a dirty
 * primary's pre-spawn state being replayed in) so `baselineCommit` is a
 * genuinely separate commit reachable ONLY through the worktree's own
 * detached HEAD — exactly the shape that becomes collectible once the
 * worktree is removed and pruned.
 */
function makeDiffArtifact(
  root: string,
  worktreeRel: string,
  diffRel: string,
  edit: (worktreeAbs: string) => void = DEFAULT_EDIT,
  baselineReplay?: (worktreeAbs: string) => void,
): { diffRel: string; diffBytes: number; baselineCommit: string; worktreeAbs: string } {
  const worktreeAbs = join(root, worktreeRel);
  mkdirSync(dirname(worktreeAbs), { recursive: true });
  git(root, ['worktree', 'add', '--detach', worktreeAbs, 'HEAD']);
  if (baselineReplay != null) {
    baselineReplay(worktreeAbs);
    git(worktreeAbs, ['add', '-A']);
    git(worktreeAbs, [
      '-c', 'user.name=fadeno',
      '-c', 'user.email=fadeno@localhost',
      'commit', '--no-verify', '-m', 'fadeno pair baseline (test fixture)',
    ]);
  }
  const baselineCommit = git(worktreeAbs, ['rev-parse', 'HEAD']).trim();
  edit(worktreeAbs);
  git(worktreeAbs, ['add', '-A']);
  const diffContent = spawnSync('git', ['-C', worktreeAbs, 'diff', '--binary', '--cached'], {
    encoding: 'utf8',
    env: GIT_ENV,
  }).stdout ?? '';
  const diffAbs = join(root, diffRel);
  mkdirSync(dirname(diffAbs), { recursive: true });
  writeFileSync(diffAbs, diffContent, 'utf8');
  return { diffRel, diffBytes: Buffer.byteLength(diffContent), baselineCommit, worktreeAbs };
}

interface PairFixture {
  pairId: string;
  primaryId: string;
  shadowId: string;
  workspaceRel: string;
  diffRel: string;
  baselineCommit: string;
}

/**
 * Seed a full, real shadow pair: a retained challenger worktree at
 * `.fadeno/local/shadow/<id8>`, a real diff artifact, and the
 * `dispatch_requested`/`dispatch_completed` ledger rows `fadeno dispatch`
 * would have written for it (see `docs/experimental/slots-and-archetypes.md`,
 * "Phase 5 — symmetric pairs"). The primary here is the ordinary case: it
 * shares the workspace and carries no `diff_snapshot` of its own.
 */
function seedPair(
  root: string,
  id8: string,
  opts: { edit?: (worktreeAbs: string) => void; baselineReplay?: (worktreeAbs: string) => void } = {},
): PairFixture {
  const pairId = `pair-${id8}`;
  const primaryId = `primary-${id8}`;
  const shadowId = `shadow-${id8}`;
  const workspaceRel = `.fadeno/local/shadow/${id8}`;
  const shadow = makeDiffArtifact(root, workspaceRel, `.fadeno/local/outputs/shadow-${id8}.diff`, opts.edit, opts.baselineReplay);

  appendRows(root, [
    row({ timestamp: ts(0), event: 'dispatch_requested', dispatch_id: primaryId, resolution: 'repo', executor: 'echo-worker', model: 'echo-worker' }),
    row({
      timestamp: ts(5),
      event: 'dispatch_completed',
      dispatch_id: primaryId,
      resolution: 'repo',
      executor: 'echo-worker',
      model: 'echo-worker',
      exit_code: 0,
      duration_ms: 10,
      output_sha256: 'a'.repeat(64),
      output_bytes: 3,
      pair_id: pairId,
      baseline_commit: shadow.baselineCommit,
    }),
    row({
      timestamp: ts(1),
      event: 'dispatch_requested',
      dispatch_id: shadowId,
      resolution: 'shadow',
      shadow: true,
      primary_dispatch_id: primaryId,
      pair_id: pairId,
      shadow_source: 'flag',
      executor: 'grok-worker',
      model: 'grok-4',
      gate_eligible: false,
      workspace: workspaceRel,
      baseline_commit: shadow.baselineCommit,
    }),
    row({
      timestamp: ts(6),
      event: 'dispatch_completed',
      dispatch_id: shadowId,
      resolution: 'shadow',
      shadow: true,
      primary_dispatch_id: primaryId,
      pair_id: pairId,
      shadow_source: 'flag',
      executor: 'grok-worker',
      model: 'grok-4',
      gate_eligible: false,
      workspace: workspaceRel,
      baseline_commit: shadow.baselineCommit,
      exit_code: 0,
      duration_ms: 10,
      output_sha256: 'b'.repeat(64),
      output_bytes: 5,
      diff_snapshot: shadow.diffRel,
      diff_bytes: shadow.diffBytes,
    }),
  ]);

  return { pairId, primaryId, shadowId, workspaceRel, diffRel: shadow.diffRel, baselineCommit: shadow.baselineCommit };
}

function lastLedgerRow(root: string): Record<string, unknown> {
  const lines = readFileSync(join(root, DISPATCHES_FILE), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

test('shadow-apply: a clean challenger diff lands in the workspace and records a row', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const fixture = seedPair(root, 'aaaaaaaa');

  const result = runShadowApply({ ref: fixture.pairId, repoRoot: root });

  assert.equal(result.pairId, fixture.pairId);
  assert.equal(result.arm, 'challenger');
  assert.equal(result.dispatchId, fixture.shadowId);
  assert.equal(result.artifact, fixture.diffRel);
  assert.equal(result.applied, true);
  assert.equal(result.clean, true);
  assert.equal(result.check, false);

  // The challenger's edit actually landed in the real workspace.
  assert.match(readFileSync(join(root, 'f.txt'), 'utf8'), /line2-challenger/);
  // `--3way` stages a clean apply on its own (verified: no explicit --index
  // needed) — port-back leaves the change ready to review/commit, not just
  // sitting unstaged in the working tree.
  assert.match(git(root, ['status', '--porcelain']), /^M {2}f\.txt$/m);

  // A port-back is a real mutation, so it is recorded like any other
  // dispatch outcome.
  const last = lastLedgerRow(root);
  assert.equal(last.event, 'shadow_apply');
  assert.equal(last.outcome, 'applied');
  assert.equal(last.pair_id, fixture.pairId);
  assert.equal(last.dispatch_id, fixture.shadowId);
  assert.equal(last.arm, 'challenger');
  assert.equal(last.artifact, fixture.diffRel);
  assert.equal(last.check, false);
});

// `--3way` is conflict-aware from the first version because the main tree
// can move while a pair runs. This proves the conflict path stops rather
// than guessing, keeps the artifact, and records the attempt — and is
// honest about what `--3way` actually leaves in the working tree (conflict
// markers on an unmerged file), while showing that state is fully
// recoverable rather than "hard to back out of".
test('shadow-apply: a conflicting apply stops, keeps the artifact, and leaves an honest — but recoverable — conflict', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const fixture = seedPair(root, 'bbbbbbbb');

  // Diverge the main tree on the exact same line the challenger touched, so
  // `--3way` cannot reconcile the two.
  writeFileSync(join(root, 'f.txt'), readFileSync(join(root, 'f.txt'), 'utf8').replace('line2', 'line2-MAIN'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'main diverges']);
  const beforeAttempt = readFileSync(join(root, 'f.txt'), 'utf8');

  assert.throws(
    () => runShadowApply({ ref: fixture.pairId, repoRoot: root }),
    (err: unknown) => {
      assert.ok(err instanceof ShadowApplyCommandError);
      const message = (err as Error).message;
      assert.match(message, /could not cleanly apply/);
      assert.match(message, new RegExp(fixture.diffRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(message, /kept/i);
      assert.match(message, /never/i); // "never auto-resolves" / "never reverted"
      return true;
    },
  );

  // The diff artifact was never touched.
  assert.ok(existsSync(join(root, fixture.diffRel)));

  // What `--3way` actually did: left an unmerged file with real conflict
  // markers — not a silent success, and not a rollback.
  assert.match(git(root, ['status', '--porcelain']), /^UU f\.txt$/m);
  const afterAttempt = readFileSync(join(root, 'f.txt'), 'utf8');
  assert.match(afterAttempt, /<<<<<<</);
  assert.match(afterAttempt, />>>>>>>/);
  assert.notEqual(afterAttempt, beforeAttempt);

  // ...and it is NOT hard to back out of: an ordinary `git reset --hard`
  // fully restores the pre-attempt tree, same as backing out any other
  // failed `git apply`.
  git(root, ['reset', '--hard', 'HEAD']);
  assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), beforeAttempt);
  assert.equal(git(root, ['status', '--porcelain']), '');

  // The attempt is recorded even though it failed.
  const last = lastLedgerRow(root);
  assert.equal(last.event, 'shadow_apply');
  assert.equal(last.outcome, 'conflict');
  assert.equal(last.pair_id, fixture.pairId);
});

test('shadow-apply CLI: a conflicting apply exits non-zero and reports the kept artifact', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const fixture = seedPair(root, 'cccc1111');
  writeFileSync(join(root, 'f.txt'), readFileSync(join(root, 'f.txt'), 'utf8').replace('line2', 'line2-MAIN'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'main diverges']);

  const cli = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), 'shadow-apply', fixture.pairId], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, new RegExp(fixture.diffRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('shadow-apply --check: reports applicability and changes nothing', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const fixture = seedPair(root, 'dddddddd');
  const beforeFile = readFileSync(join(root, 'f.txt'), 'utf8');
  const beforeLedger = readFileSync(join(root, DISPATCHES_FILE), 'utf8');

  const result = runShadowApply({ ref: fixture.pairId, check: true, repoRoot: root });

  assert.equal(result.check, true);
  assert.equal(result.applied, false);
  assert.equal(result.clean, true);
  // Not the workspace, not the index, and not the ledger (--check is a
  // documented no-mutation preview — including no `shadow_apply` row).
  assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), beforeFile);
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(readFileSync(join(root, DISPATCHES_FILE), 'utf8'), beforeLedger);
});

// The sharp git behavior this guards against: `git apply --check --3way` on
// a patch that WOULD conflict still exits 0 and reports "with conflicts" on
// stderr rather than failing (verified against git 2.50.1) — so a naive
// exit-code read would report a conflicting pair as applicable.
test('shadow-apply --check: reports would-NOT-apply-cleanly on a conflicting pair, and still changes nothing', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const fixture = seedPair(root, 'eeeeeeee');
  writeFileSync(join(root, 'f.txt'), readFileSync(join(root, 'f.txt'), 'utf8').replace('line2', 'line2-MAIN'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'main diverges']);
  const beforeFile = readFileSync(join(root, 'f.txt'), 'utf8');

  const result = runShadowApply({ ref: fixture.pairId, check: true, repoRoot: root });

  assert.equal(result.clean, false);
  assert.equal(result.applied, false);
  assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), beforeFile);
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('shadow-apply --arm primary refuses on an ordinary paired primary (already in the shared workspace)', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const fixture = seedPair(root, 'ffffffff');

  assert.throws(
    () => runShadowApply({ ref: fixture.pairId, arm: 'primary', repoRoot: root }),
    (err: unknown) => {
      assert.ok(err instanceof ShadowApplyCommandError);
      assert.match((err as Error).message, /already in your workspace/);
      return true;
    },
  );
  // Nothing was touched by the refusal.
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('shadow-apply --arm primary applies when the primary itself ran --isolate (its own diff_snapshot)', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const pairId = 'pair-11110000';
  const primaryId = 'primary-11110000';
  const primaryDiff = makeDiffArtifact(
    root,
    '.fadeno/local/host-worktrees/isolated-primary',
    '.fadeno/local/outputs/primary-11110000.diff',
    (worktreeAbs) => {
      const p = join(worktreeAbs, 'f.txt');
      writeFileSync(p, readFileSync(p, 'utf8').replace('line2', 'line2-primary-isolated'));
    },
  );
  appendRows(root, [
    row({ timestamp: ts(0), event: 'dispatch_requested', dispatch_id: primaryId, resolution: 'repo', executor: 'echo-worker', model: 'echo-worker' }),
    row({
      timestamp: ts(5),
      event: 'dispatch_completed',
      dispatch_id: primaryId,
      resolution: 'repo',
      executor: 'echo-worker',
      model: 'echo-worker',
      exit_code: 0,
      duration_ms: 10,
      output_sha256: 'a'.repeat(64),
      output_bytes: 3,
      pair_id: pairId,
      baseline_commit: primaryDiff.baselineCommit,
      diff_snapshot: primaryDiff.diffRel,
      diff_bytes: primaryDiff.diffBytes,
    }),
  ]);

  const result = runShadowApply({ ref: pairId, arm: 'primary', repoRoot: root });
  assert.equal(result.arm, 'primary');
  assert.equal(result.applied, true);
  assert.match(readFileSync(join(root, 'f.txt'), 'utf8'), /line2-primary-isolated/);
});

// The design's own framing: a retained worktree's baseline commit is
// reachable only as long as something keeps it referenced. Once `fadeno
// clean --force` deregisters and removes the worktree AND a real `git gc`
// runs, the commit is gone — this must be diagnosed by name, not surfaced as
// git's own "lacks the necessary blob to perform 3-way merge" error.
test("shadow-apply: a pair whose baseline_commit was garbage-collected is diagnosed precisely, not as raw git noise", (t) => {
  const root = tempRepo(t);
  initGit(root);
  // `baselineReplay` makes the baseline commit reachable ONLY through this
  // worktree's own detached HEAD (see `makeDiffArtifact`) — without it, the
  // "baseline" would just be the repo's initial commit, which stays reachable
  // from the main branch forever and could never actually be collected.
  const fixture = seedPair(root, '99999999', {
    baselineReplay: (worktreeAbs) => {
      writeFileSync(join(worktreeAbs, 'f.txt'), 'line1\nline2\nline3\nprimary-dirty-addition\n');
    },
  });
  const worktreeAbs = join(root, fixture.workspaceRel);

  git(root, ['worktree', 'remove', '--force', worktreeAbs]);
  git(root, ['worktree', 'prune']);
  git(root, ['reflog', 'expire', '--expire=now', '--all']);
  git(root, ['gc', '--prune=now']);

  assert.throws(
    () => runShadowApply({ ref: fixture.pairId, repoRoot: root }),
    (err: unknown) => {
      assert.ok(err instanceof ShadowApplyCommandError);
      const message = (err as Error).message;
      assert.match(message, /no longer present/);
      assert.match(message, /garbage-collected/);
      // The precise diagnostic replaces git's own confusing message, it does
      // not just prepend to it.
      assert.doesNotMatch(message, /lacks the necessary blob/);
      return true;
    },
  );
});

test('shadow-apply: resolves by either arm\'s dispatch_id (full, or an 8+ character prefix), not just pair_id', (t) => {
  const root = tempRepo(t);
  initGit(root);
  const fixture = seedPair(root, 'abcabc12');

  const byShadowId = runShadowApply({ ref: fixture.shadowId, check: true, repoRoot: root });
  assert.equal(byShadowId.pairId, fixture.pairId);

  const byPrimaryPrefix = runShadowApply({ ref: fixture.primaryId.slice(0, 12), check: true, repoRoot: root });
  assert.equal(byPrimaryPrefix.pairId, fixture.pairId);
});

test('shadow-apply: an unknown id is a typed error', (t) => {
  const root = tempRepo(t);
  initGit(root);
  assert.throws(
    () => runShadowApply({ ref: 'totally-unknown-identifier', repoRoot: root }),
    DispatchesCommandError,
  );
});

test('shadow-apply: an ambiguous prefix is a typed error naming the candidates', (t) => {
  const root = tempRepo(t);
  initGit(root);
  seedPair(root, 'ccccccc1');
  seedPair(root, 'ccccccc2');

  assert.throws(
    () => runShadowApply({ ref: 'pair-ccccccc', repoRoot: root }),
    (err: unknown) => {
      assert.ok(err instanceof DispatchesCommandError);
      assert.match((err as Error).message, /ambiguous/);
      assert.match((err as Error).message, /pair-cccccc/);
      return true;
    },
  );
});

test('shadow-apply: a dispatch id that exists but was never part of a pair is a typed error', (t) => {
  const root = tempRepo(t);
  initGit(root);
  appendRows(root, [
    row({ timestamp: ts(0), event: 'dispatch_requested', dispatch_id: 'lone-worker-1', resolution: 'repo', executor: 'echo-worker', model: 'echo-worker' }),
    row({
      timestamp: ts(5),
      event: 'dispatch_completed',
      dispatch_id: 'lone-worker-1',
      resolution: 'repo',
      executor: 'echo-worker',
      model: 'echo-worker',
      exit_code: 0,
      duration_ms: 5,
      output_sha256: 'a'.repeat(64),
      output_bytes: 1,
    }),
  ]);

  assert.throws(
    () => runShadowApply({ ref: 'lone-worker-1', repoRoot: root }),
    (err: unknown) => {
      assert.ok(err instanceof DispatchesCommandError);
      assert.match((err as Error).message, /not part of any recorded shadow pair/);
      return true;
    },
  );
});

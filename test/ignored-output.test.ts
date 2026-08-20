/**
 * Detection of gitignored output a worktree produced that no diff carries out.
 *
 * Every test here builds a REAL git repo with REAL `.gitignore` rules — there
 * is no stub for `git ls-files`, because the whole value of the function is
 * that it sees the exact exclude set `git add -A` obeys, and a stub would
 * agree with itself rather than with git. The first test goes further and
 * proves the premise the feature rests on: it runs the real
 * `git add -A` + `git diff --cached` pipeline over a real linked worktree and
 * shows the ignored tree is genuinely absent from the diff before asserting
 * that the scan reports it. Without that, every "detected" assertion below
 * would prove only that a listing lists things.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { IGNORED_OUTPUT_MAX_ENTRIES, scanIgnoredOutput } from '../src/lib/workspace-lease.ts';
import { tempRepo } from './helpers.ts';

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
  if (result.error != null || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.error}`);
  }
  return result.stdout ?? '';
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

/** A committed repo whose `.gitignore` carries `patterns`. */
function initRepo(root: string, patterns: string[]): void {
  git(root, ['init', '-q', '.']);
  write(root, 'src/app.ts', 'export const a = 1;\n');
  write(root, '.gitignore', `${patterns.join('\n')}\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
}

test('ignored output in a real worktree is invisible to git add -A and visible to the scan', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['dist/', 'node_modules/']);
  const wt = join(root, '.fadeno', 'local', 'pair', 'aaaaaaaa', 'bbbbbbbb');
  git(root, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
  t.after(() => {
    try { git(root, ['worktree', 'remove', '--force', wt]); } catch { /* best-effort */ }
  });

  // The arm does its work: one tracked edit, and one gitignored build tree.
  write(wt, 'src/app.ts', 'export const a = 2;\n');
  write(wt, 'dist/bundle.js', 'console.log(2);\n');
  write(wt, 'dist/assets/logo.svg', '<svg/>\n');

  // The premise, proven rather than assumed: the delivery path drops `dist/`.
  git(wt, ['add', '-A']);
  const diff = git(wt, ['diff', '--binary', '--cached']);
  assert.match(diff, /src\/app\.ts/, 'the tracked edit must survive, or this fixture is not exercising the real path');
  assert.doesNotMatch(diff, /dist/, 'git add -A staged the ignored tree; the silent-drop this feature exists for is not reproduced');

  const scan = scanIgnoredOutput(wt, []);
  assert.equal(scan.truncated, false);
  assert.deepEqual(scan.paths, ['dist/']);
});

test('a wholly-ignored directory is reported once, with git\'s trailing slash', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['dist/']);
  write(root, 'dist/a/b/c/deep.js', 'x\n');
  write(root, 'dist/top.js', 'y\n');

  const scan = scanIgnoredOutput(root, []);
  assert.deepEqual(scan.paths, ['dist/'], 'git collapses the tree; the trailing slash is the marker that it is a whole directory');
  assert.equal(scan.truncated, false);
});

test('a nested ignored directory under a tracked parent is reported at its own path', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['**/target/', 'src/generated.ts']);
  write(root, 'src/generated.ts', 'export const g = 1;\n');
  write(root, 'crates/one/target/debug/bin', 'ELF\n');
  write(root, 'crates/two/target/debug/bin', 'ELF\n');
  write(root, 'crates/one/src/lib.rs', 'fn main() {}\n');
  write(root, 'crates/two/src/lib.rs', 'fn main() {}\n');
  git(root, ['add', 'crates/one/src/lib.rs', 'crates/two/src/lib.rs']);
  git(root, ['commit', '-q', '-m', 'crates']);

  const scan = scanIgnoredOutput(root, []);
  assert.equal(scan.truncated, false);
  assert.deepEqual(
    scan.paths.slice().sort(),
    ['crates/one/target/', 'crates/two/target/', 'src/generated.ts'],
    'nested ignored dirs collapse at their own level, and a scattered ignored file keeps file granularity',
  );
});

test('carried paths are excluded — they are input, not output', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['node_modules/', 'dist/', '.venv/']);
  write(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  write(root, '.venv/lib/site.py', 'x\n');
  write(root, 'dist/bundle.js', 'y\n');

  const none = scanIgnoredOutput(root, []);
  assert.deepEqual(none.paths.slice().sort(), ['.venv/', 'dist/', 'node_modules/']);

  const carried = scanIgnoredOutput(root, ['node_modules', '.venv']);
  assert.deepEqual(carried.paths, ['dist/'], 'the declared carries are input; only the build output is a finding');
  assert.equal(carried.truncated, false);
});

test('a carried path excludes everything under it, at file granularity', (t) => {
  const root = tempRepo(t);
  // `node_modules/` itself is tracked-adjacent here: the parent dir holds a
  // tracked file, so git cannot collapse it and reports per-file entries.
  initRepo(root, ['node_modules/*.log', 'node_modules/cache/']);
  write(root, 'node_modules/keep.txt', 'tracked\n');
  git(root, ['add', 'node_modules/keep.txt']);
  git(root, ['commit', '-q', '-m', 'nm']);
  write(root, 'node_modules/install.log', 'x\n');
  write(root, 'node_modules/cache/blob', 'y\n');

  const none = scanIgnoredOutput(root, []);
  assert.deepEqual(none.paths.slice().sort(), ['node_modules/cache/', 'node_modules/install.log']);

  const carried = scanIgnoredOutput(root, ['node_modules']);
  assert.deepEqual(carried.paths, [], 'a carry of the parent must exclude every entry beneath it');
});

test('a carried node_modules does not swallow node_modules_backup (false-prefix)', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['node_modules/', 'node_modules_backup/', 'node_modulesX']);
  write(root, 'node_modules/pkg/index.js', 'a\n');
  write(root, 'node_modules_backup/pkg/index.js', 'b\n');
  write(root, 'node_modulesX', 'c\n');

  const scan = scanIgnoredOutput(root, ['node_modules']);
  assert.deepEqual(
    scan.paths.slice().sort(),
    ['node_modulesX', 'node_modules_backup/'],
    'string-prefix matching would erase both of these; only a path-boundary match is correct',
  );
  assert.equal(scan.truncated, false);
});

test('a carry declared with a trailing slash or ./ prefix still matches', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['node_modules/', 'dist/']);
  write(root, 'node_modules/pkg/index.js', 'a\n');
  write(root, 'dist/bundle.js', 'b\n');

  for (const declared of ['node_modules/', './node_modules', './node_modules/']) {
    const scan = scanIgnoredOutput(root, [declared]);
    assert.deepEqual(scan.paths, ['dist/'], `carry spelled "${declared}" should still exclude node_modules`);
  }
});

test('an entry that is a strict ancestor of a carry is kept, not hidden', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['build/']);
  write(root, 'build/cache/warm.bin', 'carried in\n');
  write(root, 'build/out/app.js', 'produced here\n');

  // Git collapses the wholly-ignored `build/` to one entry that contains BOTH
  // the carried subtree and the arm's real output. Dropping it to suppress
  // known input would hide the output too.
  const scan = scanIgnoredOutput(root, ['build/cache']);
  assert.deepEqual(scan.paths, ['build/'], 'an ancestor entry holds more than the carry and must stay reported');
});

test('.fadeno/ is excluded whether git collapses it or reports its subpaths', (t) => {
  // The user-repo shape: `.fadeno/playbooks/` is committed, so only Fadeno's
  // own machine-local state and traces are ignorable and git reports them
  // individually.
  const userRepo = tempRepo(t);
  initRepo(userRepo, ['.fadeno/local/', '.fadeno/runs/', '.fadeno/progress/', '.fadeno/dispatches.jsonl', 'dist/']);
  write(userRepo, '.fadeno/playbooks/p.yaml', 'name: p\n');
  git(userRepo, ['add', '.fadeno/playbooks/p.yaml']);
  git(userRepo, ['commit', '-q', '-m', 'playbooks']);
  write(userRepo, '.fadeno/local/pair/aaaa/marker', 'x\n');
  write(userRepo, '.fadeno/runs/r1/run.yaml', 'id: r1\n');
  write(userRepo, '.fadeno/progress/p.json', '{}\n');
  write(userRepo, '.fadeno/dispatches.jsonl', '{}\n');
  write(userRepo, 'dist/bundle.js', 'y\n');

  const userScan = scanIgnoredOutput(userRepo, []);
  assert.deepEqual(userScan.paths, ['dist/'], 'no .fadeno subpath is a finding');
  assert.equal(userScan.truncated, false);

  // Fadeno's own shape: `.fadeno/` is ignored wholesale and git collapses the
  // entire tree to a single entry, which is why the exclusion is by prefix.
  const selfRepo = tempRepo(t);
  initRepo(selfRepo, ['.fadeno/', 'dist/']);
  write(selfRepo, '.fadeno/local/pair/aaaa/marker', 'x\n');
  write(selfRepo, '.fadeno/playbooks/p.yaml', 'name: p\n');
  write(selfRepo, 'dist/bundle.js', 'y\n');

  const selfScan = scanIgnoredOutput(selfRepo, []);
  assert.deepEqual(selfScan.paths, ['dist/']);
  assert.equal(selfScan.truncated, false);
});

test('the .fadeno exclusion is a path-boundary match, not a string prefix', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['.fadeno/', '.fadeno-cache/', '.fadenorc']);
  write(root, '.fadeno/local/x', 'a\n');
  write(root, '.fadeno-cache/blob', 'b\n');
  write(root, '.fadenorc', 'c\n');

  const scan = scanIgnoredOutput(root, []);
  assert.deepEqual(
    scan.paths.slice().sort(),
    ['.fadeno-cache/', '.fadenorc'],
    'only `.fadeno` itself and paths beneath it are Fadeno state',
  );
});

test('a clean worktree returns no paths and is NOT truncated', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['dist/', 'node_modules/']);

  const scan = scanIgnoredOutput(root, []);
  assert.deepEqual(scan.paths, []);
  assert.equal(scan.truncated, false, 'a genuinely clean tree is a positive claim, not an unknown');
  assert.equal(scan.note, undefined);
});

test('a clean worktree stays clean when its declared carries are the only ignored content', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['node_modules/']);
  write(root, 'node_modules/pkg/index.js', 'a\n');

  const scan = scanIgnoredOutput(root, ['node_modules']);
  assert.deepEqual(scan.paths, []);
  assert.equal(scan.truncated, false);
});

test('a non-git directory is truncated, never empty-and-clean', (t) => {
  const root = tempRepo(t);
  const plain = join(root, 'not-a-repo');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'dist.js'), 'x\n', 'utf8');

  const scan = scanIgnoredOutput(plain, []);
  assert.deepEqual(scan.paths, []);
  assert.equal(scan.truncated, true, '"I could not tell" must never be spelled the same as "there was nothing"');
  assert.match(String(scan.note), /floor, not the set/);
});

test('a worktree path that no longer exists is truncated, never empty-and-clean', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['dist/']);
  const gone = join(root, 'removed-worktree');
  mkdirSync(gone, { recursive: true });
  rmSync(gone, { recursive: true, force: true });

  const scan = scanIgnoredOutput(gone, []);
  assert.deepEqual(scan.paths, []);
  assert.equal(scan.truncated, true);
});

test('an empty worktree path refuses rather than scanning the process cwd', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['dist/']);
  write(root, 'dist/bundle.js', 'x\n');

  const scan = scanIgnoredOutput('', []);
  assert.deepEqual(scan.paths, []);
  assert.equal(scan.truncated, true);
  assert.match(String(scan.note), /no worktree path/);
});

test('hitting the entry budget yields a floor plus truncated, not a short clean answer', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['*.log']);
  for (let i = 0; i < 5; i += 1) write(root, `run-${i}.log`, 'x\n');

  const full = scanIgnoredOutput(root, []);
  assert.equal(full.paths.length, 5);
  assert.equal(full.truncated, false);

  const capped = scanIgnoredOutput(root, [], { maxEntries: 2 });
  assert.equal(capped.paths.length, 2, 'the cap bounds the reported set');
  assert.equal(capped.truncated, true);
  assert.match(String(capped.note), /floor, not the set/);
  for (const path of capped.paths) assert.ok(full.paths.includes(path), 'a capped listing is a subset of the full one');
});

test('the default entry budget is well clear of an ordinary repo', () => {
  assert.ok(IGNORED_OUTPUT_MAX_ENTRIES >= 1000);
});

test('an ignored-but-tracked path is reported by neither the scan nor the drop', (t) => {
  const root = tempRepo(t);
  git(root, ['init', '-q', '.']);
  write(root, 'build.lock', 'v1\n');
  write(root, '.gitignore', 'build.lock\ndist/\n');
  // Force-added: ignore rules do not apply to tracked files, so `git add -A`
  // keeps carrying it and there is nothing to warn about.
  git(root, ['add', '-A', '-f']);
  git(root, ['commit', '-q', '-m', 'init']);
  write(root, 'build.lock', 'v2\n');
  write(root, 'dist/bundle.js', 'x\n');

  const scan = scanIgnoredOutput(root, []);
  assert.deepEqual(scan.paths, ['dist/'], 'the tracked-but-ignored file survives the diff, so it is not a finding');
  const status = git(root, ['status', '--porcelain']);
  assert.match(status, /build\.lock/, 'and git really does still track it');
});

test('the scan never mutates the worktree it inspects', (t) => {
  const root = tempRepo(t);
  initRepo(root, ['dist/']);
  write(root, 'dist/bundle.js', 'x\n');
  write(root, 'src/app.ts', 'export const a = 99;\n');

  const before = git(root, ['status', '--porcelain', '--ignored']);
  scanIgnoredOutput(root, []);
  scanIgnoredOutput(root, ['dist']);
  const after = git(root, ['status', '--porcelain', '--ignored']);
  assert.equal(after, before, 'detection must not stage, clean, or otherwise disturb the tree');
});

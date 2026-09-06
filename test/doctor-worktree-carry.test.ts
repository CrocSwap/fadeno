import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDoctor } from '../src/commands/doctor.ts';
import {
  CARRY_ENVIRONMENT_DIRECTORIES,
  undeclaredCarryEnvironment,
  undeclaredCarryFindings,
} from '../src/lib/workspace-isolation.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4Doc, tempRepo } from './helpers.ts';

/**
 * The UNDECLARED half of `worktree_carry:`.
 *
 * The declared half is already loud: a path a repo names and Fadeno cannot
 * carry refuses the dispatch. The undeclared half was silent, and that silence
 * is what two directors reported in the same week — a Python repo whose eight
 * isolated reviews could not run the repo's own replay gate because no
 * worktree had a `.venv`, and a Rust/Python repo whose dispatches returned
 * terminal `ok` receipts over validation that had quietly degraded from the
 * full suite to a smoke test.
 *
 * So the properties under test are as much about staying QUIET as about
 * firing. A check that warned about a tracked `vendor/` (which carries itself)
 * or about a repo that has declared its carry would be noise, and noise is how
 * a real finding gets scrolled past.
 */

// --- fixtures ---

function isolatedUser(t: TestContext, root: string): UserPathOptions {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

function git(root: string, args: string[]): void {
  const res = spawnSync('git', ['-C', root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr ?? ''}`);
}

/** A real git repository — the ignore/tracked split is git's answer, not ours. */
function gitRepo(t: TestContext): string {
  const root = tempRepo(t);
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

function writeIgnore(root: string, lines: string[]): void {
  writeFileSync(join(root, '.gitignore'), `${lines.join('\n')}\n`, 'utf8');
}

/** A directory with one file in it, at a repo-relative path. */
function seedDir(root: string, rel: string): void {
  mkdirSync(join(root, rel), { recursive: true });
  writeFileSync(join(root, rel, 'marker'), 'x\n', 'utf8');
}

/** The ledger every lane appends to — the cheapest proof this repo dispatches. */
function seedDispatchActivity(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'dispatches.jsonl'), '', 'utf8');
}

function writeProjectCatalog(root: string, doc: Record<string, unknown>): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc), 'utf8');
}

function only(findings: ReturnType<typeof undeclaredCarryFindings>): { severity: string; detail: string; remediation?: string } {
  assert.equal(findings.length, 1, 'this check emits exactly one row, always');
  return findings[0]!;
}

// --- the fact: which environment directories a worktree would not get ---

test('a gitignored environment directory that nothing declares is reported', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/', '.venv/']);
  seedDir(root, 'node_modules');
  seedDir(root, '.venv');

  const found = undeclaredCarryEnvironment(root, []);
  assert.deepEqual(found.paths, ['node_modules', '.venv'], 'candidate order, not directory-listing order');
  assert.equal(found.unknown, false);
});

test('a declared path is not reported again — that case is the loud one', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/', '.venv/']);
  seedDir(root, 'node_modules');
  seedDir(root, '.venv');

  assert.deepEqual(undeclaredCarryEnvironment(root, ['node_modules', '.venv']).paths, []);
  // A partial declaration still names what it left out: the polymarket failure
  // one directory over is the same failure.
  assert.deepEqual(undeclaredCarryEnvironment(root, ['node_modules']).paths, ['.venv']);
});

test('a declared `node_modules` does not cover a directory that merely starts with it', (t) => {
  // `startsWith` instead of a path-segment test is the bug `isAtOrUnder`
  // exists for; a second spelling of the coverage test here would reintroduce
  // it. `node_modules_backup` is not a candidate name, so the observable form
  // of the same mistake is a declared prefix swallowing a longer candidate.
  const root = gitRepo(t);
  writeIgnore(root, ['ven*', 'node_modules/']);
  seedDir(root, 'vendor');
  seedDir(root, 'venv');

  const found = undeclaredCarryEnvironment(root, ['ven']);
  assert.deepEqual(found.paths, ['venv', 'vendor'], 'a declared "ven" covers neither "venv" nor "vendor"');
});

test('a directory that is present but TRACKED is not reported — it carries itself', (t) => {
  const root = gitRepo(t);
  // Both halves at once: the pattern matches, AND the content is committed.
  // `git worktree add` checks out tracked content, so this one is already in
  // every worktree and a warning about it would be a false positive.
  writeIgnore(root, ['vendor/']);
  seedDir(root, 'vendor');
  git(root, ['add', '-f', 'vendor']);
  git(root, ['commit', '-qm', 'vendor']);

  const found = undeclaredCarryEnvironment(root, []);
  assert.deepEqual(found.paths, []);
  assert.deepEqual(found.present, ['vendor'], 'still observed, so a caller can say why it is not a finding');
  assert.equal(found.unknown, false);
});

test('a present but UNIGNORED directory is not reported', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['# nothing ignored']);
  seedDir(root, 'node_modules');

  assert.deepEqual(undeclaredCarryEnvironment(root, []).paths, []);
});

test('no environment directory at all is a clean, positive answer', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/']);

  const found = undeclaredCarryEnvironment(root, []);
  assert.deepEqual(found.paths, []);
  assert.deepEqual(found.present, []);
  assert.equal(found.unknown, false, 'nothing present is a real "none", not an "I could not tell"');
});

test('a directory that git cannot be asked about is unknown, never "none"', (t) => {
  const root = tempRepo(t); // deliberately NOT a git repository
  seedDir(root, 'node_modules');

  const found = undeclaredCarryEnvironment(root, []);
  assert.deepEqual(found.paths, []);
  assert.deepEqual(found.present, ['node_modules'], 'the directory is there; only the ignore question failed');
  assert.equal(found.unknown, true);
});

test('the candidate list is overridable, so the check is testable without every ecosystem present', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['.cabal-sandbox/']);
  seedDir(root, '.cabal-sandbox');

  assert.deepEqual(undeclaredCarryEnvironment(root, []).paths, [], 'not a shipped candidate');
  assert.deepEqual(
    undeclaredCarryEnvironment(root, [], { candidates: ['.cabal-sandbox'] }).paths,
    ['.cabal-sandbox'],
  );
});

test('the shipped candidate list holds installed dependencies, never build output or caches', () => {
  const names = new Set<string>(CARRY_ENVIRONMENT_DIRECTORIES);
  for (const dependency of ['node_modules', '.venv', 'venv', 'vendor', 'target']) {
    assert.ok(names.has(dependency), `${dependency} is a dependency tree and must be a candidate`);
  }
  // Output is regenerated from sources the worktree HAS, and seeding a
  // worktree with the primary's artifacts is how a run reads someone else's
  // build as its own product. Caches cost seconds, never an answer.
  for (const output of ['dist', 'build', 'coverage', '.next', '.pytest_cache', '.ruff_cache', '__pycache__']) {
    assert.ok(!names.has(output), `${output} is output or cache and must NOT be a candidate`);
  }
});

// --- the finding: what doctor says about it ---

test('the finding fires on a dispatching repo with a gitignored env dir and no carry', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/', '.venv/']);
  seedDir(root, 'node_modules');
  seedDir(root, '.venv');
  seedDispatchActivity(root);

  const found = only(undeclaredCarryFindings(root, []));
  assert.equal(found.severity, 'warning');
  assert.match(found.detail, /node_modules/);
  assert.match(found.detail, /\.venv/);
  assert.match(found.detail, /exit 0/, 'the receipt-said-ok failure is the point, not the missing directory');
  // The remediation is a line to paste, naming the directories actually found.
  assert.ok(found.remediation != null);
  assert.match(found.remediation!, /worktree_carry: \["node_modules", "\.venv"\]/);
  assert.match(found.remediation!, /\.fadeno\/executors\.yaml/);
});

test('the remediation names only what is really there', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['.venv/']);
  seedDir(root, '.venv');
  seedDispatchActivity(root);

  const found = only(undeclaredCarryFindings(root, []));
  assert.equal(found.severity, 'warning');
  assert.match(found.remediation!, /worktree_carry: \["\.venv"\]/);
  assert.ok(!found.remediation!.includes('node_modules'), 'never a directory this repo does not have');
});

test('the finding is quiet when a carry is declared', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/', '.venv/']);
  seedDir(root, 'node_modules');
  seedDir(root, '.venv');
  seedDispatchActivity(root);

  const both = only(undeclaredCarryFindings(root, ['node_modules', '.venv']));
  assert.equal(both.severity, 'ok');
  assert.equal(both.remediation, undefined);

  // A partial declaration is still `ok` — this check does not argue with a
  // repo that has looked at itself — but the row says what was left out
  // rather than implying the question is settled.
  const partial = only(undeclaredCarryFindings(root, ['node_modules']));
  assert.equal(partial.severity, 'ok');
  assert.match(partial.detail, /NOT declared: \.venv/);
});

test('the finding is quiet when there is no environment directory', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/']);
  seedDispatchActivity(root);

  const found = only(undeclaredCarryFindings(root, []));
  assert.equal(found.severity, 'ok');
  assert.equal(found.remediation, undefined);
});

test('the finding is quiet when the directory exists but is tracked', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['vendor/']);
  seedDir(root, 'vendor');
  git(root, ['add', '-f', 'vendor']);
  git(root, ['commit', '-qm', 'vendor']);
  seedDispatchActivity(root);

  const found = only(undeclaredCarryFindings(root, []));
  assert.equal(found.severity, 'ok');
  assert.match(found.detail, /vendor is present and tracked/);
});

test('the finding is quiet in a repo that has never dispatched', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/']);
  seedDir(root, 'node_modules');
  // No `.fadeno/dispatches.jsonl`, no isolated or host worktree directory.

  const found = only(undeclaredCarryFindings(root, []));
  assert.equal(found.severity, 'ok');
  assert.match(found.detail, /no dispatch has cut a worktree/);
});

test('a cut worktree is dispatch activity even after the ledger is swept', (t) => {
  const root = gitRepo(t);
  writeIgnore(root, ['node_modules/']);
  seedDir(root, 'node_modules');
  mkdirSync(join(root, '.fadeno', 'local', 'host-worktrees'), { recursive: true });

  assert.equal(only(undeclaredCarryFindings(root, [])).severity, 'warning');
});

// --- through doctor, where the declaration comes off the project catalog ---

test('fadeno doctor reports the gap, and stops once the catalog declares the carry', (t) => {
  const root = gitRepo(t);
  const userPathOptions = isolatedUser(t, root);
  writeIgnore(root, ['node_modules/', '.venv/', '.fadeno/']);
  seedDir(root, 'node_modules');
  seedDir(root, '.venv');
  seedDispatchActivity(root);
  writeProjectCatalog(root, catalogV4Doc());

  const before = runDoctor({ repoRoot: root, userPathOptions }).findings.find((f) => f.check === 'worktree-carry');
  assert.ok(before != null, 'doctor must carry the row at all');
  assert.equal(before.severity, 'warning');
  assert.match(before.remediation ?? '', /worktree_carry: \["node_modules", "\.venv"\]/);

  // Paste the remediation back into the catalog: the check goes quiet.
  writeProjectCatalog(root, catalogV4Doc({ worktree_carry: ['node_modules', '.venv'] }));
  const after = runDoctor({ repoRoot: root, userPathOptions }).findings.find((f) => f.check === 'worktree-carry');
  assert.equal(after?.severity, 'ok');
});

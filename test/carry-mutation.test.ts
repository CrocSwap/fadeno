/**
 * Mutation detection for hardlink-carried `worktree_carry:` paths.
 *
 * These tests build a REAL hardlink carry with the same `cp -a -l` the ladder
 * in `carryPathIntoWorktree` uses, then mutate through the worktree's path and
 * prove the primary's copy moved with it. Nothing here simulates the hazard —
 * every "mutated" assertion is preceded by a check that the primary's own file
 * actually changed, so the test would fail if hardlinks stopped sharing an
 * inode rather than quietly passing.
 *
 * Timing note: the same-size in-place cases lean on nanosecond `mtime`/`ctime`
 * (APFS, ext4, tmpfs, XFS all have it). On a filesystem with 1-second stamps
 * these would fail loudly rather than pass vacuously — which is the intended
 * failure mode, and is exactly the false-negative surface documented on
 * `fingerprintCarriedPaths`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { tempRepo } from './helpers.ts';
import {
  CARRY_DRIFT_MAX_EXAMPLES,
  carryDeclaredPaths,
  carryMutationStamp,
  fingerprintCarriedPaths,
  verifyCarriedPaths,
} from '../src/lib/workspace-lease.ts';

/** A gitignored build tree of the shape `worktree_carry:` exists for. */
function seedCarried(root: string): void {
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'index.js'), 'module.exports = 1;\n');
  // Stands in for the docstring's hazards: a SQLite-backed cache written in
  // place at a fixed size, and an append-mode log.
  writeFileSync(join(root, 'node_modules', '.cache', 'store.db'), 'PAGE0000PAGE1111');
  writeFileSync(join(root, 'node_modules', '.cache', 'build.log'), 'start\n');
  symlinkSync('index.js', join(root, 'node_modules', 'alias.js'));
}

/**
 * Carry `rel` by hardlink, exactly as the ladder's middle rung does, and prove
 * the inode really is shared before any test relies on it.
 */
function hardlinkCarry(root: string, worktreeAbs: string, rel: string, probeRel: string): void {
  mkdirSync(dirname(join(worktreeAbs, rel)), { recursive: true });
  const res = spawnSync('cp', ['-a', '-l', join(root, rel), join(worktreeAbs, rel)], { encoding: 'utf8' });
  assert.equal(res.status, 0, `cp -a -l failed: ${String(res.stderr ?? '')}`);
  const primaryIno = lstatSync(join(root, probeRel), { bigint: true }).ino;
  const worktreeIno = lstatSync(join(worktreeAbs, probeRel), { bigint: true }).ino;
  assert.equal(worktreeIno, primaryIno, 'the carry did not actually share an inode; the rest of this test would prove nothing');
}

function worktreeFor(root: string): string {
  const wt = join(root, '.fadeno', 'local', 'isolated', 'wt');
  mkdirSync(wt, { recursive: true });
  return wt;
}

const HARDLINK_ONE = [{ path: 'node_modules', mechanism: 'hardlink' as const }];

test('an in-place write through a hardlinked carry is detected on the primary copy', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'node_modules', join('node_modules', '.cache', 'store.db'));

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  assert.equal(fingerprint.paths.length, 1);
  assert.equal(fingerprint.paths[0]!.truncated, false);
  assert.ok(fingerprint.paths[0]!.entries >= 5, 'the walk should cover the dir, its subdir and every file');

  // The exact hazard: a fixed-size page rewrite through the worktree's path.
  const dbInWorktree = join(wt, 'node_modules', '.cache', 'store.db');
  const fd = openSync(dbInWorktree, 'r+');
  try { writeSync(fd, Buffer.from('PAGE9999'), 0, 8, 0); } finally { closeSync(fd); }

  // The corruption is real before anything is asserted about detection.
  assert.equal(readFileSync(join(root, 'node_modules', '.cache', 'store.db'), 'utf8'), 'PAGE9999PAGE1111');

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.status, 'mutated');
  assert.equal(verdicts[0]!.kinds.in_place_write, 1);
  assert.equal(verdicts[0]!.entriesChanged, 1);
  assert.deepEqual(verdicts[0]!.examples, [{ path: 'node_modules/.cache/store.db', kind: 'in_place_write' }]);

  const stamp = carryMutationStamp(verdicts);
  assert.ok(stamp);
  assert.equal(stamp.length, 1);
  assert.equal(stamp[0]!.path, 'node_modules');
  assert.equal(stamp[0]!.mechanism, 'hardlink');
  assert.equal(stamp[0]!.status, 'mutated');
  assert.equal(stamp[0]!.entries_changed, 1);
  assert.match(String(stamp[0]!.note), /shares with the worktree/);
});

test('an append through a hardlinked carry is detected (size and mtime both move)', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'node_modules', join('node_modules', '.cache', 'build.log'));

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  appendFileSync(join(wt, 'node_modules', '.cache', 'build.log'), 'challenger ran\n');

  assert.equal(readFileSync(join(root, 'node_modules', '.cache', 'build.log'), 'utf8'), 'start\nchallenger ran\n');
  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'mutated');
  assert.equal(verdicts[0]!.kinds.in_place_write, 1);
});

test('an mtime-restoring in-place write is still caught, by ctime', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  const dbRel = join('node_modules', '.cache', 'store.db');
  // Whole-second stamps so the restore below can be byte-exact; otherwise the
  // test could pass on a restored-but-not-identical mtime and prove nothing
  // about ctime.
  const pinned = 1_700_000_000;
  utimesSync(join(root, dbRel), pinned, pinned);
  hardlinkCarry(root, wt, 'node_modules', dbRel);

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  const beforeMtime = lstatSync(join(root, dbRel), { bigint: true }).mtimeNs;

  const fd = openSync(join(wt, dbRel), 'r+');
  try { writeSync(fd, Buffer.from('XXXX'), 0, 4, 0); } finally { closeSync(fd); }
  utimesSync(join(wt, dbRel), pinned, pinned); // the evasion: put mtime back

  const after = lstatSync(join(root, dbRel), { bigint: true });
  assert.equal(after.mtimeNs, beforeMtime, 'mtime restore must be exact or this test proves nothing about ctime');
  assert.equal(after.size, 16n, 'size must be unchanged or mtime is not the only signal being removed');
  assert.equal(readFileSync(join(root, dbRel), 'utf8'), 'XXXX0000PAGE1111');

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'mutated');
  // Caught by ctime alone: no userspace API can put ctime back.
  assert.equal(verdicts[0]!.kinds.metadata_only, 1);
  assert.equal(verdicts[0]!.kinds.in_place_write, undefined);
});

test('a chmod through the shared inode is caught, because mode lives on the inode', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  const rel = join('node_modules', 'index.js');
  hardlinkCarry(root, wt, 'node_modules', rel);

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  const modeBefore = lstatSync(join(root, rel)).mode;
  chmodSync(join(wt, rel), 0o400);

  // The docstring's claim, asserted rather than assumed: a chmod inside the
  // worktree makes the PRIMARY's copy read-only too.
  assert.notEqual(lstatSync(join(root, rel)).mode, modeBefore);

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'mutated');
  assert.equal(verdicts[0]!.kinds.metadata_only, 1);
});

test('an untouched hardlinked carry verifies clean, and reads do not count', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'node_modules', join('node_modules', 'index.js'));

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  // A challenger that only builds/tests reads the carried tree; atime is not
  // in the tuple, so this must not register.
  readFileSync(join(wt, 'node_modules', 'index.js'), 'utf8');
  readFileSync(join(wt, 'node_modules', '.cache', 'store.db'), 'utf8');

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.status, 'clean');
  assert.equal(verdicts[0]!.entriesChanged, 0);
  assert.deepEqual(verdicts[0]!.kinds, {});
  assert.equal(verdicts[0]!.note, null);
  assert.equal(carryMutationStamp(verdicts), null);
});

test('tearing the carrying worktree down before verify is not mutation', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  const rel = join('node_modules', 'index.js');
  hardlinkCarry(root, wt, 'node_modules', rel);

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  const ctimeBefore = lstatSync(join(root, rel), { bigint: true }).ctimeNs;

  // An isolated delivery removes its worktree as part of its lifecycle, which
  // drops every link count back and bumps ctime on files nothing touched.
  rmSync(wt, { recursive: true, force: true });

  const afterTeardown = lstatSync(join(root, rel), { bigint: true });
  assert.notEqual(afterTeardown.ctimeNs, ctimeBefore, 'teardown should have moved ctime, or this test is not exercising the case');
  assert.equal(afterTeardown.nlink, 1n);

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'clean', 'a link-count change fully explains the ctime bump');
  assert.equal(carryMutationStamp(verdicts), null);
});

test('a mutation that happened before teardown is still caught after teardown', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  const dbRel = join('node_modules', '.cache', 'store.db');
  hardlinkCarry(root, wt, 'node_modules', dbRel);

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  const fd = openSync(join(wt, dbRel), 'r+');
  try { writeSync(fd, Buffer.from('PAGE9999'), 0, 8, 0); } finally { closeSync(fd); }
  rmSync(wt, { recursive: true, force: true });

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'mutated');
  assert.equal(verdicts[0]!.kinds.in_place_write, 1);
});

test('reflink and copy carries are never fingerprinted, and mutation there cannot reach the primary', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);

  // A real byte copy, the ladder's bottom rung.
  mkdirSync(join(wt, 'node_modules'), { recursive: true });
  const copied = spawnSync('cp', ['-a', join(root, 'node_modules'), join(wt, 'node_modules')], { encoding: 'utf8' });
  assert.equal(copied.status, 0);

  const fingerprint = fingerprintCarriedPaths(root, [
    { path: 'node_modules', mechanism: 'copy' },
    { path: 'node_modules', mechanism: 'reflink' },
  ]);
  assert.deepEqual(fingerprint.paths, [], 'only the hardlink rung shares an inode, so only it is worth walking');

  const dbRel = join('node_modules', '.cache', 'store.db');
  const fd = openSync(join(wt, 'node_modules', dbRel), 'r+');
  try { writeSync(fd, Buffer.from('PAGE9999'), 0, 8, 0); } finally { closeSync(fd); }

  // The mechanism, not the detector, is what protects the primary here.
  assert.equal(readFileSync(join(root, dbRel), 'utf8'), 'PAGE0000PAGE1111');
  assert.deepEqual(verifyCarriedPaths(root, fingerprint), []);
  assert.equal(carryMutationStamp(verifyCarriedPaths(root, fingerprint)), null);
});

test('drift a hardlinked worktree cannot cause is reported as drifted, never as mutated', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'node_modules', join('node_modules', 'index.js'));

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  // The primary's own tooling, mid-run: an install adds a package and drops
  // another. A worktree with its own directory inodes cannot do either.
  writeFileSync(join(root, 'node_modules', 'added.js'), 'new\n');
  rmSync(join(root, 'node_modules', '.cache', 'build.log'));

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'drifted');
  assert.equal(verdicts[0]!.kinds.added, 1);
  assert.equal(verdicts[0]!.kinds.removed, 1);
  assert.equal(verdicts[0]!.kinds.in_place_write, undefined);
  assert.equal(verdicts[0]!.kinds.metadata_only, undefined);

  const stamp = carryMutationStamp(verdicts);
  assert.ok(stamp);
  assert.equal(stamp[0]!.status, 'drifted');
  assert.match(String(stamp[0]!.note), /cannot cause/);
});

test('replacing the primary entry is drift, not a shared-inode mutation', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  const rel = join('node_modules', 'index.js');
  hardlinkCarry(root, wt, 'node_modules', rel);

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  const inoBefore = lstatSync(join(root, rel), { bigint: true }).ino;
  // write-temp-then-rename in the PRIMARY: the safe write pattern, which
  // detaches the primary's entry from the shared inode entirely.
  writeFileSync(join(root, rel, '..', 'index.js.tmp'), 'module.exports = 2;\n');
  spawnSync('mv', [join(root, 'node_modules', 'index.js.tmp'), join(root, rel)], { encoding: 'utf8' });
  assert.notEqual(lstatSync(join(root, rel), { bigint: true }).ino, inoBefore);
  // The worktree's copy is untouched: proof this is not the shared-inode path.
  assert.equal(readFileSync(join(wt, rel), 'utf8'), 'module.exports = 1;\n');

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'drifted');
  assert.equal(verdicts[0]!.kinds.replaced, 1);
});

test('a carried tree deleted out from under the primary is knowable drift, not unknown', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'node_modules', join('node_modules', 'index.js'));

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE);
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });

  const verdicts = verifyCarriedPaths(root, fingerprint);
  // ENOENT says the entry is gone, which is a fact — reporting it as `unknown`
  // would throw away what was actually observed.
  assert.equal(verdicts[0]!.status, 'drifted');
  assert.ok((verdicts[0]!.kinds.removed ?? 0) >= 4);
  assert.equal(verdicts[0]!.kinds.in_place_write, undefined);
});

test('a tree beyond the fingerprint budget degrades to unknown, never to clean', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'node_modules', join('node_modules', 'index.js'));

  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE, { maxEntries: 2 });
  assert.equal(fingerprint.paths[0]!.truncated, true);
  assert.equal(fingerprint.paths[0]!.entries, 2);

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'unknown');
  assert.equal(verdicts[0]!.entriesChanged, 0, 'a budget cut must not read as entries appearing or disappearing');
  assert.match(String(verdicts[0]!.note), /never compared/);

  const stamp = carryMutationStamp(verdicts);
  assert.ok(stamp, 'unknown is not clean, so it must reach the evidence row');
  assert.equal(stamp[0]!.status, 'unknown');
});

test('a positive detection still wins over a truncated walk', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'node_modules', join('node_modules', '.cache', 'store.db'));

  // Budget large enough to reach the cache file, small enough to truncate.
  const fingerprint = fingerprintCarriedPaths(root, HARDLINK_ONE, { maxEntries: 4 });
  assert.equal(fingerprint.paths[0]!.truncated, true);
  const covered = [...fingerprint.paths[0]!.stamps.keys()];
  assert.ok(covered.includes('node_modules/.cache/store.db'), `budget slice unexpectedly excluded the probe file: ${covered.join(', ')}`);

  const fd = openSync(join(wt, 'node_modules', '.cache', 'store.db'), 'r+');
  try { writeSync(fd, Buffer.from('PAGE9999'), 0, 8, 0); } finally { closeSync(fd); }

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'mutated');
});

test('examples are capped and lead with the hazard', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, 'built'), { recursive: true });
  for (let i = 0; i < CARRY_DRIFT_MAX_EXAMPLES + 5; i += 1) {
    writeFileSync(join(root, 'built', `f${String(i).padStart(2, '0')}.bin`), 'x');
  }
  const wt = worktreeFor(root);
  hardlinkCarry(root, wt, 'built', join('built', 'f00.bin'));

  const fingerprint = fingerprintCarriedPaths(root, [{ path: 'built', mechanism: 'hardlink' }]);
  // Many benign additions in the primary, one real in-place write through the
  // worktree — the sample must not bury the hazard under alphabetical noise.
  for (let i = 0; i < CARRY_DRIFT_MAX_EXAMPLES + 5; i += 1) {
    writeFileSync(join(root, 'built', `aaa${String(i).padStart(2, '0')}.bin`), 'x');
  }
  const fd = openSync(join(wt, 'built', 'f09.bin'), 'r+');
  try { writeSync(fd, Buffer.from('y'), 0, 1, 0); } finally { closeSync(fd); }

  const verdicts = verifyCarriedPaths(root, fingerprint);
  assert.equal(verdicts[0]!.status, 'mutated');
  assert.equal(verdicts[0]!.examples.length, CARRY_DRIFT_MAX_EXAMPLES);
  assert.deepEqual(verdicts[0]!.examples[0], { path: 'built/f09.bin', kind: 'in_place_write' });
  assert.equal(verdicts[0]!.entriesChanged, CARRY_DRIFT_MAX_EXAMPLES + 6);
});

// --- the seam: what the dispatch path actually calls ------------------------

test('carryDeclaredPaths fingerprints exactly its hardlink records, whatever the host filesystem chose', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);

  const carried = carryDeclaredPaths(root, wt, ['node_modules']);
  assert.equal(carried.failure, null);
  assert.equal(carried.records.length, 1);
  const mechanism = carried.records[0]!.mechanism;
  assert.match(mechanism, /^(reflink|hardlink|copy)$/);

  assert.deepEqual(
    carried.fingerprint.paths.map((p) => p.path),
    carried.records.filter((r) => r.mechanism === 'hardlink').map((r) => r.path),
    'the fingerprint must cover the hardlink records and nothing else',
  );

  const dbRel = join('node_modules', '.cache', 'store.db');
  const fd = openSync(join(wt, dbRel), 'r+');
  try { writeSync(fd, Buffer.from('PAGE9999'), 0, 8, 0); } finally { closeSync(fd); }
  const verdicts = verifyCarriedPaths(root, carried.fingerprint);

  if (mechanism === 'hardlink') {
    assert.equal(readFileSync(join(root, dbRel), 'utf8'), 'PAGE9999PAGE1111', 'a hardlink carry shares the inode');
    assert.equal(verdicts[0]!.status, 'mutated');
  } else {
    // reflink is copy-on-write and copy is a byte copy: the primary is
    // untouched, and there is correspondingly nothing to verify.
    assert.equal(readFileSync(join(root, dbRel), 'utf8'), 'PAGE0000PAGE1111');
    assert.deepEqual(verdicts, []);
    assert.equal(carryMutationStamp(verdicts), null);
  }
});

test('carryDeclaredPaths can skip the walk, and a refused carry returns an empty fingerprint', (t) => {
  const root = tempRepo(t);
  seedCarried(root);
  const wt = worktreeFor(root);

  const skipped = carryDeclaredPaths(root, wt, ['node_modules'], { fingerprint: false });
  assert.equal(skipped.failure, null);
  assert.equal(skipped.records.length, 1);
  assert.deepEqual(skipped.fingerprint.paths, []);

  const root2 = tempRepo(t);
  mkdirSync(join(root2, 'blocked', 'inner'), { recursive: true });
  writeFileSync(join(root2, 'blocked', 'inner', 'f.txt'), 'x');
  chmodSync(join(root2, 'blocked'), 0o000);
  try {
    const refused = carryDeclaredPaths(root2, worktreeFor(root2), ['blocked']);
    assert.ok(refused.failure, 'an unreadable declared path must refuse rather than carry');
    assert.equal(refused.failure.path, 'blocked');
    assert.deepEqual(refused.fingerprint.paths, [], 'nothing ran against a refused carry, so there is nothing to fingerprint');
  } finally {
    try { chmodSync(join(root2, 'blocked'), 0o755); } catch { /* best-effort */ }
  }
});

test('an absent declared path is fingerprinted as nothing, not as an error', (t) => {
  const root = tempRepo(t);
  const carried = carryDeclaredPaths(root, worktreeFor(root), ['node_modules']);
  assert.deepEqual(carried.records, []);
  assert.equal(carried.failure, null);
  assert.deepEqual(carried.fingerprint.paths, []);
  assert.equal(carryMutationStamp(verifyCarriedPaths(root, carried.fingerprint)), null);
});

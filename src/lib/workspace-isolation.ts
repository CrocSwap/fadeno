/**
 * Isolated worktree delivery, declared carry, and the attestations that say
 * what a worktree actually did.
 *
 * This module is the half of the old `workspace-lease.ts` that survived the
 * removal of repo-wide writer leasing. That module's own header called it two
 * modules — "Repo-wide writer leasing **and** isolated worktree delivery" —
 * and only one of them was a lock. Leasing is gone: it required Fadeno to
 * answer "is this holder still alive?", which it cannot, and on the host lane
 * (where no pid is ever published) it answered "alive, forever" and wedged the
 * repo. Isolation never asked that question. Cutting a worktree, carrying the
 * declared paths into it, collecting its diff, and saying afterwards what
 * drifted are all facts about files, provable at the moment they are read.
 *
 * Nothing here excludes anyone. Two deliveries may run at once; each gets its
 * own tree, and where their edits meet, `workspace-overlap.ts` records the
 * intersection on both receipts instead of preventing the second one from
 * starting. See that module for why detection replaced prevention.
 *
 * All persistent writes are atomic (write-then-rename).
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/**
 * Exactly the two workspace modes the contract allows.
 *
 * Still a two-value union after the lock's removal, and still meaningful: it
 * says whether a delivery ran in the caller's tree or in a worktree of its
 * own. What changed is that `shared` no longer implies exclusive — it means
 * "this one wrote where everyone else can see it", which is precisely what
 * makes overlap detection necessary.
 */
export type WorkspaceMode = 'shared' | 'isolated';

export const WORKSPACE_MODES = ['shared', 'isolated'] as const;

/**
 * Failure of an isolated delivery — a worktree that could not be cut, a diff
 * that could not be collected, a path that escapes the repo.
 *
 * Renamed from `WorkspaceLeaseError`, which it was called for as long as one
 * module threw it for both concerns. Every remaining `catch` is catching an
 * isolation failure: the lease half no longer throws anything at all.
 */
export class WorkspaceIsolationError extends Error {}

/** How much of a git failure message an evidence note may carry. */
const ISOLATED_DIFF_MAX_NOTE = 4000;

export interface IsolatedWorktreeOptions {
  repoRoot: string;
  /** Absolute path to the worktree the caller wants (under `.fadeno/local/isolated/<id>`). */
  worktreePath: string;
  now?: Date;
  onEcho?: (line: string) => void;
}

export interface IsolatedWorktreeResult {
  /** Absolute worktree path. */
  worktreeAbs: string;
  /** Repo-relative worktree path. */
  worktreeRel: string;
}

export interface IsolatedDiffOptions {
  repoRoot: string;
  worktreeAbs: string;
  /** Where to write the binary diff (absolute). */
  diffAbs: string;
  /** Repo-relative diff path for evidence. */
  diffRel: string;
  now?: Date;
}

export interface IsolatedDiffResult {
  diffRel: string;
  diffAbs: string;
  diffBytes: number;
}

// ---------------------------------------------------------------------------
// Declared worktree carry — shared by shadow pairs and isolated deliveries
// ---------------------------------------------------------------------------
//
// `git worktree add` cuts a clean checkout of *tracked* content only:
// dependencies, build output, and a local `.fadeno/` catalog are almost
// always gitignored, so a worktree cut this way has none of them and cannot
// build or test for reasons that have nothing to do with whatever is being
// compared or isolated. A repo declares `worktree_carry:` (a project-only
// field on `ExecutorProfile`, see `executors.ts`) to name the paths that
// must cross into a freshly-cut worktree regardless. One mechanism serves
// both a shadow's challenger worktree and an `--isolate` delivery's worktree
// — the gap is identical in both cases, so the carry logic lives here
// rather than being duplicated per caller.

/** Mechanism a declared path was actually carried by — recorded on the
 * dispatch's evidence row so a worktree is checkable as warmed the same way.
 * It is also what decides whether a path is fingerprinted for mutation:
 * `hardlink` shares the inode and is, `reflink` (copy-on-write) and `copy`
 * cannot and are not. See `carryPathIntoWorktree` for the ladder and
 * `fingerprintCarriedPaths` for that distinction in full.
 */
export type WorktreeCarryMechanism = 'reflink' | 'hardlink' | 'copy';

export type CarryOutcome =
  | { status: 'absent' }
  | { status: 'carried'; mechanism: WorktreeCarryMechanism }
  | { status: 'failed'; reason: string };

/**
 * Carry one declared path from the primary's tree into a worktree cut from
 * HEAD. Ladder: reflink (copy-on-write clone) → hardlink → full copy.
 *
 * A non-CoW filesystem is not an edge case worth a single fallback line —
 * ext4 (the default on Ubuntu, Debian, and GitHub Actions' Linux runners),
 * NTFS, HFS+, tmpfs, NFS/SMB, and overlay2-on-ext4 all lack reflink support,
 * so hardlink-or-copy is the MAJORITY path on Linux CI, not a rare escape
 * hatch. `-c` is the macOS/APFS clonefile spelling; `--reflink=always` is the
 * GNU coreutils one. Both FAIL rather than degrade when the filesystem cannot
 * clone, which is the property the ladder depends on — see the note below
 * for why `--reflink=auto` would quietly break it.
 *
 * The hardlink step never dereferences symlinks (`-a`'s `--no-dereference`
 * half): a pnpm-style `node_modules` is full of intentional relative
 * symlinks that must keep resolving inside the worktree, not get flattened
 * into copies of whatever they happen to point at. Hardlinks cannot cross
 * filesystems; that failure mode falls through to the copy step below
 * rather than being treated as fatal.
 *
 * Cleanup is safe by construction: a hardlink is a second directory entry on
 * one inode, and its data is freed only when the link count reaches zero, so
 * removing a worktree (`rm -rf`, `git worktree remove --force`, the
 * post-shadow cleaner) only ever unlinks that worktree's own entry — it can
 * never destroy the primary's copy. This is exactly what makes a hardlink
 * safe where a directory *symlink* would not be: symlinking a directory
 * shares the namespace, so even a safe write-temp-then-rename still lands
 * inside the primary's real files, whereas a hardlinked tree is a genuinely
 * separate directory structure that a create-temp-then-rename write
 * naturally detaches from — the mechanism `rsync --link-dest` and Time
 * Machine rely on, and pnpm already hardlinks `node_modules` out of its
 * global content-addressed store for the same reason. Symlinking is
 * therefore never chosen automatically here — only a future declaration that
 * opts in to it explicitly, per path, could ask for it.
 *
 * The residual hazard is mutation, not deletion, and it is silent: a tool
 * that opens a carried file and writes IN PLACE (a SQLite-backed cache, an
 * append-mode log) mutates the primary's copy too, because content — and
 * mode — live on the shared inode. That cannot be defended by making the
 * carried tree read-only: a `chmod` on a shared inode makes the PRIMARY's
 * copy read-only as well, so that obvious mitigation is unavailable, not
 * merely unbuilt. This function still makes no attempt to PREVENT it —
 * prevention is what is unavailable. What exists now is detection after the
 * fact: `carryDeclaredPaths` fingerprints every `hardlink`-carried path once
 * the carry lands, and `verifyCarriedPaths` re-reads it after the run to say
 * which declared paths drifted on a shared inode. See
 * `fingerprintCarriedPaths` for the fingerprint's design and, importantly,
 * for what it cannot see.
 */
export function carryPathIntoWorktree(repoRoot: string, worktreeAbs: string, relPath: string): CarryOutcome {
  const srcAbs = join(repoRoot, relPath);
  if (!existsSync(srcAbs)) return { status: 'absent' }; // undeclared-equivalent: nothing to carry, not an error
  const destAbs = join(worktreeAbs, relPath);
  try {
    mkdirSync(dirname(destAbs), { recursive: true });
  } catch (err) {
    return { status: 'failed', reason: `could not prepare "${relPath}"'s parent directory in the worktree: ${err instanceof Error ? err.message : String(err)}` };
  }

  const attempt = (args: string[]): SpawnSyncReturns<string> => spawnSync('cp', args, { encoding: 'utf8' });
  const cleanupPartial = (): void => { try { rmSync(destAbs, { recursive: true, force: true }); } catch { /* best-effort */ } };

  // `=always`, never `=auto`. GNU `cp --reflink=auto` silently degrades to a
  // full byte copy when the filesystem cannot clone, and exits 0 — which on
  // ext4 (the majority path) would report `mechanism: 'reflink'` for what was
  // actually a copy, and make the hardlink rung below unreachable dead code.
  // `=always` fails instead, which is what lets the ladder fall through.
  // Darwin's `-c` (clonefile) already fails rather than degrading, so the two
  // spellings behave the same way here.
  const reflinkArgs = process.platform === 'darwin' ? ['-R', '-c', srcAbs, destAbs] : ['-R', '--reflink=always', srcAbs, destAbs];
  const reflinkRes = attempt(reflinkArgs);
  if (reflinkRes.error == null && reflinkRes.status === 0) return { status: 'carried', mechanism: 'reflink' };
  cleanupPartial();

  const hardlinkRes = attempt(['-a', '-l', srcAbs, destAbs]);
  if (hardlinkRes.error == null && hardlinkRes.status === 0) return { status: 'carried', mechanism: 'hardlink' };
  cleanupPartial();

  const copyRes = attempt(['-a', srcAbs, destAbs]);
  if (copyRes.error == null && copyRes.status === 0) return { status: 'carried', mechanism: 'copy' };
  cleanupPartial();

  const reason = copyRes.error != null
    ? copyRes.error.message
    : String(copyRes.stderr ?? '').trim() || `exit ${copyRes.status ?? 'unknown'}`;
  return { status: 'failed', reason };
}

/** Every declared path, carried in declaration order into a worktree that
 * was cut from HEAD, stopping at the first failure. Shared by shadow pairs
 * and isolated deliveries so both call the same ladder and record results in
 * the same shape (`{ path, mechanism }`) on their evidence row.
 *
 * `fingerprint` is the carry-time half of mutation detection: it is captured
 * AFTER the carry lands (see `fingerprintCarriedPaths` for why the ordering
 * is load-bearing) and covers only the `hardlink` records. Pass
 * `{ fingerprint: false }` to skip the walk for a caller that will never
 * verify; the default is on, so a caller gets detection without opting in.
 */
export function carryDeclaredPaths(
  repoRoot: string,
  worktreeAbs: string,
  declared: readonly string[],
  opts: { fingerprint?: boolean } = {},
): {
  records: Array<{ path: string; mechanism: WorktreeCarryMechanism }>;
  failure: { path: string; reason: string } | null;
  fingerprint: CarryFingerprint;
} {
  const records: Array<{ path: string; mechanism: WorktreeCarryMechanism }> = [];
  for (const relPath of declared) {
    const outcome = carryPathIntoWorktree(repoRoot, worktreeAbs, relPath);
    if (outcome.status === 'absent') continue; // declared but doesn't exist: not an error, skip silently
    if (outcome.status === 'failed') {
      // A refused carry is not run against, so nothing can mutate through it;
      // an empty fingerprint keeps the return shape total rather than optional.
      return { records, failure: { path: relPath, reason: outcome.reason }, fingerprint: emptyCarryFingerprint() };
    }
    records.push({ path: relPath, mechanism: outcome.mechanism });
  }
  const fingerprint = opts.fingerprint === false
    ? emptyCarryFingerprint()
    : fingerprintCarriedPaths(repoRoot, records);
  return { records, failure: null, fingerprint };
}

// ---------------------------------------------------------------------------
// Carry mutation detection — `carry_mutated`
// ---------------------------------------------------------------------------

/** Walk budget per declared path. A tree larger than this is fingerprinted
 * only in part, which is recorded (`truncated`) and degrades that path's
 * verdict to `unknown` — never to `clean`. A partial detector that reports
 * "clean" is worse than no detector, so the budget is never allowed to look
 * like a pass. Sized so a typical `node_modules` (tens of thousands of
 * entries) fits whole; two maps this size cost tens of MB at verify time,
 * which is the real reason there is a bound at all. */
export const CARRY_FINGERPRINT_MAX_ENTRIES = 250_000;

/** How many drifted entries a verdict names. The count is exact; the list is
 * a sample, because a `node_modules` that drifted wholesale must not put
 * 40,000 paths on an evidence row. */
export const CARRY_DRIFT_MAX_EXAMPLES = 10;

/** Per-entry identity inside one carried path. Keys are repo-relative paths;
 * values are the packed stat tuple built by `stampOf`. Held in memory only —
 * see `fingerprintCarriedPaths` for why it is deliberately not digested down
 * to a single row-sized value. */
export interface CarryPathFingerprint {
  /** Repo-relative declared path, exactly as it appears in `worktree_carry:`. */
  path: string;
  /** Always `hardlink`: the only rung that shares an inode. */
  mechanism: 'hardlink';
  /** Entries walked (files, directories, symlinks, everything else). */
  entries: number;
  /** The walk hit `CARRY_FINGERPRINT_MAX_ENTRIES` and stopped early. */
  truncated: boolean;
  /** Entries that could not be stat'd at capture time. */
  unreadable: number;
  /** The budget this capture ran under. `verifyCarriedPaths` re-walks with the
   * same number so both sides see the same slice of a truncated tree and a
   * budget cut cannot masquerade as entries appearing or disappearing. */
  maxEntries: number;
  stamps: Map<string, string>;
}

export interface CarryFingerprint {
  /** When the identity was captured — after the carry, before the run. */
  capturedAt: string;
  paths: CarryPathFingerprint[];
}

/**
 * How one entry drifted.
 *
 * `in_place_write` and `metadata_only` are the HAZARD: they are changes to an
 * inode the worktree still shares, which is the only channel by which work
 * done inside a carried worktree can reach the primary's tree.
 *
 * `replaced`, `added`, and `removed` are drift the worktree cannot have
 * caused — a hardlinked worktree has its own directory structure, so nothing
 * done there can repoint or create an entry in the PRIMARY's directories.
 * They mean the primary's own tooling changed the carried tree while the run
 * was in flight (an `npm install` on the primary arm is the ordinary case).
 * Reported, never conflated with the hazard.
 */
export type CarryDriftKind = 'in_place_write' | 'metadata_only' | 'replaced' | 'added' | 'removed';

const HAZARD_KINDS: readonly CarryDriftKind[] = ['in_place_write', 'metadata_only'];

export interface CarryDriftEntry {
  /** Repo-relative path of the entry that drifted. */
  path: string;
  kind: CarryDriftKind;
}

export interface CarryPathVerdict {
  path: string;
  mechanism: 'hardlink';
  /** `mutated` = at least one shared inode changed (the hazard). `drifted` =
   * the carried tree changed, but only in ways the worktree could not cause.
   * `unknown` = the fingerprint could not cover the tree, so `clean` cannot
   * be claimed. `clean` = every fingerprinted entry is byte-for-byte the same
   * identity it had at carry time. */
  status: 'clean' | 'mutated' | 'drifted' | 'unknown';
  /** Exact count across every kind. */
  entriesChanged: number;
  /** Only the kinds that actually occurred. */
  kinds: Partial<Record<CarryDriftKind, number>>;
  /** At most `CARRY_DRIFT_MAX_EXAMPLES`, hazard kinds first, then by path. */
  examples: CarryDriftEntry[];
  /** Why the verdict is `unknown`, or what qualifies a positive one. */
  note: string | null;
}

/** The row-shaped projection of a non-clean verdict. snake_case because it
 * lands verbatim on a `.fadeno/dispatches.jsonl` row. */
export interface CarryMutationStamp {
  path: string;
  mechanism: 'hardlink';
  status: 'mutated' | 'drifted' | 'unknown';
  entries_changed: number;
  kinds: Partial<Record<CarryDriftKind, number>>;
  examples: CarryDriftEntry[];
  note?: string;
}

function emptyCarryFingerprint(): CarryFingerprint {
  return { capturedAt: new Date().toISOString(), paths: [] };
}

/**
 * Pack one entry's identity into a comparable string.
 *
 * Regular files carry the full tuple. Everything else deliberately does not:
 *
 * - **Directories** are stamped by existence alone. `cp -a -l` cannot hardlink
 *   a directory — each worktree gets its own directory inodes — so a
 *   directory's own mtime can never be evidence of shared-inode mutation, and
 *   including it would mislabel an ordinary `npm install` on the primary as
 *   the hazard. Entries appearing and disappearing inside a directory are
 *   already visible as `added`/`removed` keys.
 * - **Symlinks** are stamped by inode only. A symlink's target is immutable:
 *   retargeting means unlink + symlink, which in the worktree makes a NEW
 *   inode there and cannot touch the primary's. Timestamps on a symlink are
 *   therefore pure noise here.
 * - **`nlink` is carried but never treated as drift.** It is a function of
 *   the carry and of teardown, not of mutation: `link(2)` raises it (and, as
 *   a side effect, bumps `ctime`), and removing the worktree lowers it again.
 *   It is recorded solely so `classify` can tell a ctime bump that a
 *   link-count change fully explains from one that nothing explains.
 */
function stampOf(abs: string): string {
  try {
    const st = lstatSync(abs, { bigint: true });
    if (st.isDirectory()) return 'd';
    if (st.isSymbolicLink()) return `l|${st.ino}`;
    if (st.isFile()) {
      return `f|${st.ino}|${st.size}|${st.mtimeNs}|${st.ctimeNs}|${st.mode}|${st.uid}|${st.gid}|${st.nlink}`;
    }
    return `o|${st.ino}|${st.mode}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'EUNKNOWN';
    return `!|${code}`;
  }
}

/** Walk one carried path, producing `repo-relative path -> stamp`. Never
 * follows symlinks (`lstat`, and `readdir` type checks are `lstat`-shaped),
 * so a pnpm store link out of the tree is recorded as a link and not chased.
 */
function walkCarryPath(repoRoot: string, relPath: string, maxEntries: number): { stamps: Map<string, string>; truncated: boolean; unreadable: number } {
  const stamps = new Map<string, string>();
  let truncated = false;
  let unreadable = 0;
  const rootAbs = join(repoRoot, relPath);
  const rootRel = relPath.split('\\').join('/');
  const stack: Array<{ abs: string; rel: string }> = [{ abs: rootAbs, rel: rootRel }];
  while (stack.length > 0) {
    const cur = stack.pop() as { abs: string; rel: string };
    if (stamps.size >= maxEntries) { truncated = true; break; }
    const stamp = stampOf(cur.abs);
    // ENOENT is a fact, not a blind spot: the entry is not there, which is
    // knowable drift. Every other stat failure (EACCES, EIO) means the walk
    // could not look, which is what `unreadable` degrades a verdict for.
    if (stamp.startsWith('!|') && stamp !== '!|ENOENT') unreadable += 1;
    stamps.set(cur.rel, stamp);
    if (stamp !== 'd') continue;
    let entries;
    try {
      entries = readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      // A directory we could stat but cannot list: mark it so verify cannot
      // read the absence of its children as "nothing changed there".
      stamps.set(cur.rel, 'd|unlistable');
      unreadable += 1;
      continue;
    }
    // Sorted, then reversed because the stack is LIFO: the walk order is
    // deterministic, so a truncated capture and a truncated verify cover the
    // same slice of the tree and the budget itself cannot read as drift.
    for (const entry of entries.map((e) => e.name).sort().reverse()) {
      stack.push({ abs: join(cur.abs, entry), rel: `${cur.rel}/${entry}` });
    }
  }
  return { stamps, truncated, unreadable };
}

/**
 * Capture the identity of every `hardlink`-carried path, in the PRIMARY's
 * tree, so a later `verifyCarriedPaths` can say whether it drifted.
 *
 * ## What is fingerprinted, and what is not
 *
 * **Only `hardlink` records.** `reflink` is copy-on-write — a write inside the
 * worktree allocates new blocks and the primary's extents are untouched — and
 * `copy` is a byte copy with no relationship at all. Neither can carry a
 * mutation back, so fingerprinting them would cost a full tree walk to prove
 * something the mechanism already guarantees. This is a deliberate omission,
 * not a gap to be "fixed" later: if you find yourself adding reflink here,
 * the thing to change first is the claim in `carryPathIntoWorktree` that
 * `--reflink=always` never degrades to a copy.
 *
 * **The primary's tree, not the worktree's.** The two are the same inodes
 * while the links exist, so either side observes the same mutation — but the
 * primary is the asset at risk and it outlives the worktree, so a verify can
 * run after an isolated delivery has already torn its worktree down.
 *
 * ## Why stat metadata rather than content
 *
 * Hashing a `node_modules` is not affordable on a dispatch's critical path:
 * it is hundreds of megabytes and tens of thousands of files, read twice.
 * A stat walk is one `lstat` per entry and no bytes read. What that buys is
 * exactly the write signal: any `write(2)` to a file updates `mtime` and
 * `ctime`; an append also changes `size`; a `chmod`/`chown` on the shared
 * inode — the second half of the hazard, since mode lives on the inode too —
 * changes `mode`/`uid`/`gid` and `ctime`. A tool that restores `mtime` after
 * writing (`utimes`) cannot restore `ctime`: no userspace API sets it, and
 * `utimes` itself advances it. So `ctime` is the field that closes the
 * obvious evasion, which is why it is in the tuple despite being noisy.
 *
 * ## Ordering: capture AFTER the carry
 *
 * `link(2)` bumps the source inode's `ctime` (the link count is inode
 * metadata). Capturing before the carry would therefore record a `ctime` that
 * the carry itself invalidates, and every file would read as drifted. Capture
 * runs once all declared paths have landed.
 *
 * The symmetric hazard — the worktree's links being REMOVED before verify,
 * which lowers `nlink` and bumps `ctime` again — is handled in `classify`
 * rather than by an ordering rule, so a caller that verifies after teardown
 * gets a correct answer instead of a tree full of false positives.
 *
 * ## False negatives — what this will not see
 *
 * 1. **A same-timestamp, same-size, same-mode in-place write.** If a
 *    filesystem's timestamp granularity is coarse (1s on ext3, HFS+, and some
 *    SMB/FUSE mounts) and the write lands in the same tick as the carry, and
 *    the file's length is unchanged, nothing in the tuple moves. Content
 *    hashing is the only defence and it is the thing being traded away.
 * 2. **A filesystem that does not maintain `ctime` honestly** — some network
 *    and FUSE mounts. Then an `mtime`-restoring writer is invisible.
 * 3. **Anything outside a declared path.** Only `worktree_carry:` entries are
 *    walked. A symlink pointing out of the carried tree (a global pnpm store)
 *    is stamped as a link and its target is never visited — but such a target
 *    was never carried, so it is not shared by way of this mechanism either.
 * 4. **Beyond the walk budget.** Reported as `truncated`, and the verdict
 *    degrades to `unknown` — this one is loud rather than silent by
 *    construction.
 * 5. **Attribution, always.** A shared inode that changed is proof that the
 *    carried baseline moved, not proof of who moved it: the primary arm
 *    writing its own `node_modules` in place produces the same evidence. This
 *    is an attestation, in the same sense as `workspace_changed`, and the
 *    stamp is named for what was observed rather than for a culprit.
 */
export function fingerprintCarriedPaths(
  repoRoot: string,
  records: ReadonlyArray<{ path: string; mechanism: WorktreeCarryMechanism }>,
  opts: { maxEntries?: number } = {},
): CarryFingerprint {
  const maxEntries = opts.maxEntries ?? CARRY_FINGERPRINT_MAX_ENTRIES;
  const paths: CarryPathFingerprint[] = [];
  for (const record of records) {
    if (record.mechanism !== 'hardlink') continue;
    const walked = walkCarryPath(repoRoot, record.path, maxEntries);
    paths.push({
      path: record.path,
      mechanism: 'hardlink',
      entries: walked.stamps.size,
      truncated: walked.truncated,
      unreadable: walked.unreadable,
      maxEntries,
      stamps: walked.stamps,
    });
  }
  return { capturedAt: new Date().toISOString(), paths };
}

/** Split a packed file stamp into its fields. Only meaningful for `f|…`. */
function fileFields(stamp: string): string[] {
  return stamp.split('|');
}

/**
 * Decide how one entry drifted, given its stamp at carry time and now.
 * Returns `null` when the difference is fully explained by the link count —
 * i.e. the worktree's copy was linked or unlinked and nothing else moved.
 */
function classify(before: string, after: string): CarryDriftKind | null {
  if (before === after) return null;
  if (!before.startsWith('f|') || !after.startsWith('f|')) {
    // A file that became a directory, a link that became a file, an entry
    // that became unreadable, a directory that became unlistable: the
    // primary's own directory entry changed, which a hardlinked worktree
    // cannot do.
    return 'replaced';
  }
  const b = fileFields(before);
  const a = fileFields(after);
  // f | ino | size | mtimeNs | ctimeNs | mode | uid | gid | nlink
  if (b[1] !== a[1]) return 'replaced'; // primary's dentry now points elsewhere
  if (b[2] !== a[2] || b[3] !== a[3]) return 'in_place_write';
  if (b[5] !== a[5] || b[6] !== a[6] || b[7] !== a[7]) return 'metadata_only';
  if (b[4] !== a[4]) {
    // ctime moved but nothing else did. A link count that also moved explains
    // it completely (the carry's link, or the worktree's teardown) — see
    // `stampOf`. A link count that did NOT move leaves an inode touch with no
    // benign explanation: an mtime-restoring in-place write is exactly this
    // shape, so it is reported rather than swallowed.
    if (b[8] !== a[8]) return null;
    return 'metadata_only';
  }
  return null;
}

/**
 * Re-read every fingerprinted path in the primary's tree and say which ones
 * drifted. Read-only: this never repairs, reverts, or removes anything — the
 * carried tree is the caller's to reason about, and a detector that also
 * mutated would destroy the evidence it exists to produce.
 *
 * Safe to call whether or not the carrying worktree still exists; see
 * `fingerprintCarriedPaths` on ordering.
 */
export function verifyCarriedPaths(repoRoot: string, fingerprint: CarryFingerprint): CarryPathVerdict[] {
  const verdicts: CarryPathVerdict[] = [];
  for (const captured of fingerprint.paths) {
    const now = walkCarryPath(repoRoot, captured.path, captured.maxEntries);
    const drift: CarryDriftEntry[] = [];
    const kinds: Partial<Record<CarryDriftKind, number>> = {};
    const bump = (kind: CarryDriftKind, path: string): void => {
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      drift.push({ path, kind });
    };
    for (const [path, before] of captured.stamps) {
      const after = now.stamps.get(path);
      if (after === undefined) {
        // Beyond a truncated walk we cannot tell "removed" from "not looked
        // at", so do not assert removal; `truncated` already forces `unknown`.
        if (!now.truncated) bump('removed', path);
        continue;
      }
      const kind = classify(before, after);
      if (kind != null) bump(kind, path);
    }
    if (!captured.truncated) {
      for (const path of now.stamps.keys()) {
        if (!captured.stamps.has(path)) bump('added', path);
      }
    }

    const hazards = HAZARD_KINDS.reduce((sum, kind) => sum + (kinds[kind] ?? 0), 0);
    const degraded = captured.truncated || now.truncated || captured.unreadable > 0 || now.unreadable > 0;
    let status: CarryPathVerdict['status'];
    let note: string | null = null;
    if (hazards > 0) {
      status = 'mutated';
      note = `${hazards} ${hazards === 1 ? 'entry' : 'entries'} changed on an inode this carry shares with the worktree; the primary's copy changed with it. Attestation, not attribution — the primary's own tooling writing in place produces the same evidence.`;
    } else if (degraded) {
      status = 'unknown';
      note = captured.truncated || now.truncated
        ? `the carried tree exceeds the ${captured.maxEntries}-entry fingerprint budget, so part of it was never compared — not a clean result.`
        : 'part of the carried tree could not be read at capture or verify time, so part of it was never compared — not a clean result.';
    } else if (drift.length > 0) {
      status = 'drifted';
      note = 'the carried tree changed, but only in ways a hardlinked worktree cannot cause (entries added, removed, or repointed in the primary\'s own directories).';
    } else {
      status = 'clean';
    }

    // Hazards first so a truncated sample never shows only benign drift.
    const ordered = drift.slice().sort((x, y) => {
      const hx = HAZARD_KINDS.includes(x.kind) ? 0 : 1;
      const hy = HAZARD_KINDS.includes(y.kind) ? 0 : 1;
      if (hx !== hy) return hx - hy;
      return x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
    });
    verdicts.push({
      path: captured.path,
      mechanism: 'hardlink',
      status,
      entriesChanged: drift.length,
      kinds,
      examples: ordered.slice(0, CARRY_DRIFT_MAX_EXAMPLES),
      note,
    });
  }
  return verdicts;
}

/**
 * Project verdicts onto the `carry_mutated` evidence field, or `null` when
 * every fingerprinted path came back clean. `null` rather than `[]` so the
 * caller omits the field entirely, matching how `worktree_carry` is only ever
 * added and never defaulted onto a row.
 */
export function carryMutationStamp(verdicts: readonly CarryPathVerdict[]): CarryMutationStamp[] | null {
  const stamps: CarryMutationStamp[] = [];
  for (const verdict of verdicts) {
    if (verdict.status === 'clean') continue;
    stamps.push({
      path: verdict.path,
      mechanism: verdict.mechanism,
      status: verdict.status,
      entries_changed: verdict.entriesChanged,
      kinds: verdict.kinds,
      examples: verdict.examples,
      ...(verdict.note != null ? { note: verdict.note } : {}),
    });
  }
  return stamps.length > 0 ? stamps : null;
}

// ---------------------------------------------------------------------------
// Gitignored output detection — `ignored_output`
// ---------------------------------------------------------------------------
//
// Both arms of a shadow pair now run in their own worktree, and the primary's
// work reaches the caller's tree as a patch produced by `git add -A` +
// `git diff --binary --cached` (see `collectIsolatedDiff`). `git add -A`
// RESPECTS `.gitignore`. So anything an arm produced that the repo ignores —
// a `dist/`, a `target/`, a generated `coverage/` — is staged by nothing,
// diffed by nothing, and applied by nothing: it dies with the worktree,
// silently, with no line anywhere saying it existed.
//
// This section is the detection half of removing that silence. It says what
// ignored content was sitting in a worktree when its arm exited. It does not
// rescue it, and deliberately so — see `scanIgnoredOutput`.

/**
 * How many entries one scan will name.
 *
 * Git collapses a wholly-ignored directory to a single entry (`dist/`,
 * `node_modules/`), so an ordinary repo yields tens of entries and this
 * budget is never approached — measured at 41 entries in Fadeno's own tree.
 * It exists for the one shape git cannot collapse: ignored files scattered
 * through a large TRACKED tree (compiled artifacts beside their sources),
 * where the count is per-file. Hitting it sets `truncated`, and a truncated
 * scan is a floor rather than a set.
 *
 * Three orders of magnitude below `CARRY_FINGERPRINT_MAX_ENTRIES` because
 * these are paths destined for an evidence row a human reads, not stat tuples
 * in a comparison map the machine consumes.
 *
 * Overridable per call via `scanIgnoredOutput`'s `{ maxEntries }`, the same
 * shape `fingerprintCarriedPaths` takes — which is also what lets the cap's
 * behaviour be tested without materializing ten thousand files.
 */
export const IGNORED_OUTPUT_MAX_ENTRIES = 10_000;

const IGNORED_OUTPUT_MAX_BUFFER = 32 * 1024 * 1024;

export interface IgnoredOutputScan {
  /** Repo-relative paths, directory-collapsed the way git reports them.
   * A trailing `/` is git's own marker that the entry is a whole directory
   * and is preserved rather than trimmed: `dist/` and a file named `dist`
   * are different findings. */
  paths: string[];
  /** The listing could not be trusted to be complete. `paths` is then a
   * floor, not the set. */
  truncated: boolean;
  /** Why the scan is truncated, when it is. Optional so a caller can build an
   * `IgnoredOutputScan` literal without it; follows `CarryMutationStamp.note`,
   * which exists for the same reason — a degraded verdict that cannot say why
   * is barely better than no verdict. */
  note?: string;
}

/** Normalize one path for comparison: forward slashes, no `./` prefix, no
 * trailing slash. Comparison only — the reported string keeps git's form. */
function normalizeScanPath(raw: string): string {
  let out = raw.split('\\').join('/');
  while (out.startsWith('./')) out = out.slice(2);
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Is `rel` at or underneath `prefix`?
 *
 * The `/` in the second test is the whole point. A bare
 * `rel.startsWith(prefix)` matches `node_modules_backup` against a carry of
 * `node_modules` and silently erases a real finding — the exact class of bug
 * this detector exists to stop producing, reintroduced one level down.
 */
function isAtOrUnder(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * Fadeno's own state inside a worktree, which is never the arm's output.
 *
 * `isUnderShadowHome` (dispatch.ts) makes the narrow version of this call for
 * the copy direction — `.fadeno/local` only, checked explicitly rather than
 * delegated to `--exclude-standard`, because a user repo may commit `.fadeno/`
 * definitions while ignoring only some subpaths. That same observation is why
 * the check here is WIDER, not narrower, and it is a granularity fact rather
 * than a taste call:
 *
 * - In a user repo, `.fadeno/playbooks/` and `.fadeno/schemas/` are TRACKED,
 *   so they can never appear in an `--others --ignored` listing at all. What
 *   remains ignorable under `.fadeno/` is exactly Fadeno's own machine-local
 *   state and traces (`local/`, `runs/`, `progress/`, `dispatches.jsonl`) —
 *   by definition not a deliverable, and `runs/` is documented as output that
 *   is safe to delete.
 * - In a repo that ignores `.fadeno/` wholesale (Fadeno's own tree does), git
 *   `--directory` collapses the lot to a single `.fadeno/` entry. There is
 *   then no `.fadeno/local` to exclude separately: the choice is to report an
 *   entry that is mostly the worktree's own scaffolding, or to drop it.
 *   Distinguishing them would need the recursive walk this scan is built to
 *   avoid.
 * - A dispatch running inside a worktree writes under `.fadeno/` by
 *   construction, so reporting it would put the mechanism's own footprint on
 *   every single pair — the `node_modules` argument, applied to ourselves.
 *
 * The cost is stated on `scanIgnoredOutput` as a false negative: a repo that
 * keeps genuine work product under an ignored `.fadeno/` path is not seen.
 */
function isFadenoWorktreeState(rel: string): boolean {
  return isAtOrUnder(rel, '.fadeno');
}

/**
 * List the gitignored content sitting in `worktreeAbs` that no diff will
 * carry out of it.
 *
 * ## Why git does the listing
 *
 * `git ls-files --others --ignored --exclude-standard --directory` is the
 * only listing that sees the same exclude set `git add -A` obeys — the
 * `.gitignore` files, `.git/info/exclude`, and `core.excludesFile` together.
 * A hand-rolled `.gitignore` parser would drift from the stager it is
 * supposed to predict, and a recursive `readdir` walk cannot answer "is this
 * ignored" at all. It is also cheap because git collapses wholly-ignored
 * directories: 41 entries and ~38ms across Fadeno's own tree, against a
 * `node_modules`-scale walk for the manual version.
 *
 * The spawn deliberately inherits the ambient environment. Neutralizing
 * global/system git config (as `isRegisteredWorktree` does, for reasons that
 * do not apply here) would drop `core.excludesFile` and make this scan see a
 * DIFFERENT ignore set than the `git add -A` it exists to predict, which is
 * the one property that must hold.
 *
 * ## What is excluded, and why each
 *
 * - **`carriedPaths`** — `worktree_carry:` entries are INPUT: they were
 *   deliberately placed in the worktree before the arm started, and their
 *   being ignored is why they had to be carried in the first place. Naming a
 *   carried `node_modules` as discarded output would bury the `dist/` that
 *   actually matters under the one entry guaranteed to be present.
 * - **`.fadeno/`** — see `isFadenoWorktreeState`.
 *
 * An entry that is a strict ANCESTOR of a carried path is kept, not dropped:
 * a carry of `build/cache` under a wholly-ignored `build/` yields the entry
 * `build/`, which contains the carry AND whatever the arm built beside it.
 * Dropping it would hide real output to suppress known input, and hiding is
 * the failure mode this whole detector exists to end.
 *
 * ## Never throws, and "I could not tell" is never spelled "nothing"
 *
 * A git failure — not a repo, a removed worktree, a broken git — returns
 * `truncated: true` with whatever partial listing was recovered (usually
 * none). That asymmetry is the point: `{ paths: [], truncated: false }` is a
 * positive claim that the worktree was clean, and it is only ever returned
 * when git actually said so.
 *
 * ## Read-only
 *
 * This never stages, copies, rescues, or deletes anything. The worktree is
 * about to be torn down and the caller decides what that means; a detector
 * that also repaired would be making an unreviewable merge decision on the
 * strength of a filename.
 *
 * ## False negatives — what this will not see
 *
 * 1. **Anything under `.fadeno/`**, per the exclusion above. A repo storing
 *    real deliverables at an ignored `.fadeno/` path loses them invisibly.
 * 2. **Anything at or under a declared `worktree_carry:` path.** An arm that
 *    builds INTO its carried tree — a `node_modules/.bin` shim, a
 *    `.venv/lib/.../site-packages` install — produces output that is dropped
 *    and is not reported, because at this granularity it is indistinguishable
 *    from the input that was carried in.
 * 3. **Ignored content that survives anyway.** A path that is ignored but
 *    also TRACKED is staged by `git add -A` regardless (ignore rules do not
 *    apply to tracked files) and never appears in this listing either — the
 *    two omissions agree, so this one is harmless.
 * 4. **Beyond the budget.** Reported as `truncated`, never as clean.
 * 5. **Causation, always.** This is an appearance scan with no "before"
 *    snapshot, so it names what was ignored and present, not what the arm
 *    wrote. The bound is tight rather than theoretical — `git worktree add`
 *    cuts a clean checkout of tracked HEAD content, so a fresh worktree has
 *    no ignored files except what the carry put there (excluded above) and
 *    what ran inside it. Still an attestation, in the same sense as
 *    `carry_mutated`: named for what was observed, not for a culprit.
 */
export function scanIgnoredOutput(
  worktreeAbs: string,
  carriedPaths: readonly string[],
  opts: { maxEntries?: number } = {},
): IgnoredOutputScan {
  const maxEntries = opts.maxEntries ?? IGNORED_OUTPUT_MAX_ENTRIES;
  if (typeof worktreeAbs !== 'string' || worktreeAbs.length === 0) {
    // `git -C ''` would silently scan the CURRENT process's cwd — the
    // primary's tree — and report its entire ignored set as a worktree's
    // dropped output. Refuse rather than answer about the wrong directory.
    return { paths: [], truncated: true, note: 'no worktree path was given, so nothing could be scanned.' };
  }

  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      'git',
      ['-C', worktreeAbs, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', maxBuffer: IGNORED_OUTPUT_MAX_BUFFER },
    );
  } catch (err) {
    // spawnSync itself throwing (EMFILE, ENOMEM) is rarer than a nonzero
    // exit, but it is the same answer: unknown, not clean.
    return { paths: [], truncated: true, note: `the ignored-output listing could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }

  const failed = result.error != null || result.status !== 0;
  const raw = String(result.stdout ?? '');
  const fields = raw.split('\0');
  // `git ls-files -z` NUL-TERMINATES every record, so a successful run's last
  // field is always empty. A failed run (a `maxBuffer` overflow is the case
  // worth recovering) can end mid-path; that fragment is not a real path and
  // is dropped rather than reported as one.
  if (failed && raw.length > 0 && !raw.endsWith('\0')) fields.pop();

  const carries: string[] = [];
  for (const declared of carriedPaths) {
    if (typeof declared !== 'string') continue;
    const norm = normalizeScanPath(declared);
    if (norm.length === 0 || norm === '.') continue; // a carry of the whole tree would exclude everything
    carries.push(norm);
  }

  const paths: string[] = [];
  let cappedOut = false;
  for (const field of fields) {
    if (field.length === 0) continue;
    const rel = normalizeScanPath(field);
    if (rel.length === 0 || rel === '.') continue;
    if (isFadenoWorktreeState(rel)) continue;
    if (carries.some((carry) => isAtOrUnder(rel, carry))) continue;
    if (paths.length >= maxEntries) { cappedOut = true; break; }
    paths.push(field); // git's own spelling, trailing slash and all
  }

  if (failed) {
    const reason = result.error != null
      ? result.error.message
      : (String(result.stderr ?? '').trim() || `exit ${result.status ?? 'unknown'}`);
    return {
      paths,
      truncated: true,
      note: `the ignored-output listing failed (${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}), so these ${paths.length} ${paths.length === 1 ? 'path is' : 'paths are'} a floor, not the set.`,
    };
  }
  if (cappedOut) {
    return {
      paths,
      truncated: true,
      note: `more than ${maxEntries} ignored entries are present; the listing stopped there, so these paths are a floor, not the set.`,
    };
  }
  return { paths, truncated: false };
}

/**
 * Create a detached worktree for an isolated delivery. The worktree is cut
 * from `HEAD` before any primary work runs so both sides start from the same
 * committed state and a dirty primary workspace cannot contaminate the
 * isolated view. The worktree lives under `.fadeno/local/isolated/<id>` and
 * is **not** merged automatically; the caller collects a binary diff artifact
 * via `collectIsolatedDiff` and removes the worktree with `removeIsolatedWorktree`.
 *
 * Nothing is excluded and nothing is reserved. A worktree cut here cannot
 * mutate the caller's tree at all, so there was never anything for a lock to
 * protect; what a second writer in the caller's tree CAN do is move the
 * ground under this worktree's baseline, and that is detected at merge-back
 * (`settleIsolatedWork` rebases) and recorded (`workspace-overlap.ts`).
 *
 * Returns the absolute and repo-relative worktree paths.
 * Throws `WorkspaceIsolationError` when the worktree cannot be created.
 */
export function createIsolatedWorktree(opts: IsolatedWorktreeOptions): IsolatedWorktreeResult {
  const worktreeAbs = opts.worktreePath;
  const worktreeRel = relative(opts.repoRoot, worktreeAbs).split('\\').join('/');
  if (worktreeRel === '' || worktreeRel.startsWith('../') || worktreeRel.split('/').includes('..')) {
    throw new WorkspaceIsolationError(`isolated worktree path escapes repo: ${worktreeAbs}`);
  }
  mkdirSync(dirname(worktreeAbs), { recursive: true });
  // Best-effort prune of stale worktrees left by killed deliveries.
  try { spawnSync('git', ['worktree', 'prune'], { cwd: opts.repoRoot, encoding: 'utf8' }); } catch {}
  const add = spawnSync('git', ['worktree', 'add', '--detach', worktreeAbs, 'HEAD'], { cwd: opts.repoRoot, encoding: 'utf8' });
  if (add.error != null || add.status !== 0) {
    const reason = (add.error?.message ?? (add.stderr != null ? String(add.stderr).trim() : '') ?? 'worktree add failed');
    throw new WorkspaceIsolationError(reason.length > 0 ? `isolated worktree could not be created: ${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}` : 'isolated worktree could not be created');
  }
  opts.onEcho?.(`isolated worktree: ${worktreeRel} (from HEAD)`);
  return { worktreeAbs, worktreeRel };
}

/**
 * Capture a binary diff of everything the isolated worktree changed,
 * relative to HEAD, into `diffAbs`. Uses `git -C <wt> add -A` +
 * `git -C <wt> diff --binary --cached` so renames and binary files are
 * preserved. The diff is written atomically (tmp+rename) and the byte
 * length is returned for evidence.
 *
 * `diffRel` is the repo-relative path that will be recorded in evidence
 * (e.g. `.fadeno/local/outputs/isolated-<id>.diff`).
 */
export function collectIsolatedDiff(opts: IsolatedDiffOptions): IsolatedDiffResult {
  mkdirSync(dirname(opts.diffAbs), { recursive: true });
  const add = spawnSync('git', ['-C', opts.worktreeAbs, 'add', '-A'], { encoding: 'utf8' });
  if (add.error != null || add.status !== 0) {
    const reason = add.error?.message ?? (String(add.stderr ?? '').trim() || `exit ${add.status ?? 'unknown'}`);
    throw new WorkspaceIsolationError(`could not stage isolated worktree changes: ${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}`);
  }
  const diffRes = spawnSync('git', ['-C', opts.worktreeAbs, 'diff', '--binary', '--cached'], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (diffRes.error != null || diffRes.status !== 0) {
    const reason = diffRes.error?.message ?? (Buffer.from(diffRes.stderr ?? []).toString('utf8').trim() || `exit ${diffRes.status ?? 'unknown'}`);
    throw new WorkspaceIsolationError(`could not collect isolated worktree diff: ${reason.slice(0, ISOLATED_DIFF_MAX_NOTE)}`);
  }
  const diffContent = Buffer.from(diffRes.stdout ?? []);
  const tmp = `${opts.diffAbs}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, diffContent);
  try {
    renameSync(tmp, opts.diffAbs);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  const diffBytes = diffContent.byteLength;
  return { diffRel: opts.diffRel, diffAbs: opts.diffAbs, diffBytes };
}

/**
 * Prove a candidate directory is the exact registered linked worktree for this
 * repository. Both checks must pass; any git failure returns false, never throws.
 * 1) repoRoot's `git worktree list --porcelain` lists candidateAbs (realpath).
 * 2) candidateAbs's `--show-toplevel` equals candidateAbs and its `--git-common-dir`
 *    equals repoRoot's common dir (both realpath). This rejects plain directories
 *    (check 2 fails: toplevel resolves to the host repo) and independent repos
 *    (common-dir differs), and a dangling .git pointer fails both with nonzero.
 */
export function isRegisteredWorktree(repoRoot: string, candidateAbs: string): boolean {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  let candidateReal: string;
  try {
    candidateReal = realpathSync(resolve(candidateAbs));
  } catch { return false; }
  try {
    const list = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env });
    if (list.error != null || list.status !== 0) return false;
    const out = String(list.stdout ?? '');
    let found = false;
    for (const entry of out.split('\n\n')) {
      const wtLine = entry.split('\n').find((l) => l.startsWith('worktree '));
      if (wtLine == null) continue;
      const wtPath = wtLine.slice('worktree '.length).trim();
      let wtReal: string;
      try { wtReal = realpathSync(resolve(wtPath)); } catch { continue; }
      if (wtReal !== candidateReal) continue;
      found = true;
      if (entry.split('\n').some((l) => l.startsWith('prunable'))) return false;
      break;
    }
    if (!found) return false;
    const top = spawnSync('git', ['-C', candidateAbs, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
    if (top.error != null || top.status !== 0) return false;
    let topReal: string;
    try { topReal = realpathSync(resolve(String(top.stdout).trim())); } catch { return false; }
    if (topReal !== candidateReal) return false;
    const commonDirInside = spawnSync('git', ['-C', candidateAbs, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', env });
    const commonDirRepo = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', env });
    if (commonDirInside.error != null || commonDirInside.status !== 0) return false;
    if (commonDirRepo.error != null || commonDirRepo.status !== 0) return false;
    const insideCommon = String(commonDirInside.stdout).trim();
    const repoCommon = String(commonDirRepo.stdout).trim();
    const insideCommonAbs = resolve(candidateAbs, insideCommon);
    const repoCommonAbs = resolve(repoRoot, repoCommon);
    let insideCommonReal: string;
    let repoCommonReal: string;
    try {
      insideCommonReal = realpathSync(resolve(insideCommonAbs));
      repoCommonReal = realpathSync(resolve(repoCommonAbs));
    } catch { return false; }
    if (insideCommonReal !== repoCommonReal) return false;
    return true;
  } catch { return false; }
}

/**
 * Every git-registered worktree of this repository whose directory lies at or
 * under the repo-relative `relDir`, returned in `repoRoot`'s own path space.
 *
 * `fadeno clean` is the caller, and asking GIT rather than a ledger is the
 * whole point. Clean used to deregister a hard-coded list of worktree KINDS —
 * the shadow challengers `dispatches.jsonl` names — and `rmSync` the rest of
 * `.fadeno/local`, so every kind added afterwards (run-scoped host worktrees,
 * and the runless ad-hoc ones under `.fadeno/local/host-worktrees/adhoc/`) had
 * its directory pulled out from under git without git being told, leaving a
 * stale entry in `.git/worktrees` that makes a later `git worktree add` at the
 * same path fail until someone prunes by hand. A reader carrying its own copy
 * of "which kinds exist" is how that recurs; `git worktree list` already knows
 * all of them, including the ones nobody has invented yet.
 *
 * A PRUNABLE entry — the directory is already gone, removed by hand or by an
 * older `fadeno clean` — is INCLUDED rather than skipped, unlike
 * `isRegisteredWorktree`'s stricter question. A stale registration is exactly
 * what the caller is here to clear, and `git worktree remove --force` accepts
 * one.
 *
 * Paths are rebuilt as `join(repoRoot, …)` rather than passed through from
 * git, which prints them realpath-resolved: a caller working in a symlinked
 * root (`/var/…` on macOS) has to get back paths it can compare with its own.
 *
 * Never throws. No git on PATH, a directory that is not a repository, or an
 * unreadable listing all return an empty list — which leaves the caller
 * exactly where it stood before this function existed.
 */
export function listRegisteredWorktreesUnder(repoRoot: string, relDir: string): string[] {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const real = (path: string): string => {
    try { return realpathSync(resolve(path)); } catch { return resolve(path); }
  };
  const rootReal = real(repoRoot);
  let list: SpawnSyncReturns<string>;
  try {
    list = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env });
  } catch { return []; }
  if (list.error != null || list.status !== 0) return [];
  const out: string[] = [];
  for (const entry of String(list.stdout ?? '').split('\n\n')) {
    const line = entry.split('\n').find((l) => l.startsWith('worktree '));
    if (line == null) continue;
    const raw = line.slice('worktree '.length).trim();
    if (raw === '') continue;
    const rel = relative(rootReal, real(raw)).split('\\').join('/');
    // The main worktree resolves to `''`; anything outside the repo root to a
    // `../` path. Neither is under `relDir`, and neither is clean's business.
    if (rel === '' || rel.startsWith('../')) continue;
    if (!isAtOrUnder(rel, relDir)) continue;
    out.push(join(repoRoot, ...rel.split('/')));
  }
  return out.sort();
}

/**
 * Best-effort removal of an isolated worktree. Failures are swallowed
 * because a killed delivery may have left the worktree in an unclean
 * state; the next `createIsolatedWorktree` prunes it.
 */
export function removeIsolatedWorktree(repoRoot: string, worktreeAbs: string): void {
  try { spawnSync('git', ['worktree', 'remove', '--force', worktreeAbs], { cwd: repoRoot, encoding: 'utf8' }); } catch {}
  // fallback: remove directory if git didn't
  try { rmSync(worktreeAbs, { recursive: true, force: true }); } catch {}
}

/**
 * Convenience: run a full isolated delivery lifecycle — create worktree,
 * execute `action(worktreeAbs)` (which should spawn the executor with
 * `cwd: worktreeAbs`), collect the binary diff, and remove the worktree.
 * Structurally isolated: this function never writes anything in the caller's
 * tree except the diff artifact it is asked for.
 *
 * The caller is responsible for spawning the executor itself so it can
 * choose superviseArgv/stdios/etc.; this helper only owns the worktree
 * and diff.
 */
export function withIsolatedWorktree<T>(
  opts: IsolatedWorktreeOptions & {
    diffRel: string;
    diffAbs: string;
    /**
     * Runs after the diff is collected and before the worktree is removed,
     * with the worktree still intact — the merge-back lives here, because a
     * merge-back that has to rebase needs the worktree, and one that ends
     * `unresolved` needs it to survive. Return `retain: true` to keep the
     * worktree; return a `diff` to replace the collected one (a rebase
     * re-collects against the new baseline). Not called when the action
     * threw: there is no work to settle, only a failure to report.
     */
    settle?: (worktreeAbs: string, diff: IsolatedDiffResult) => { retain: boolean; diff?: IsolatedDiffResult };
  },
  action: (worktreeAbs: string) => T,
): { result: T; diff: IsolatedDiffResult; worktreeRel: string; retained: boolean } {
  const created = createIsolatedWorktree(opts);
  let result: T | undefined;
  let actionError: unknown;
  try {
    result = action(created.worktreeAbs);
  } catch (error) {
    actionError = error;
  }
  let diff: IsolatedDiffResult;
  try {
    diff = collectIsolatedDiff({
      repoRoot: opts.repoRoot,
      worktreeAbs: created.worktreeAbs,
      diffAbs: opts.diffAbs,
      diffRel: opts.diffRel,
    });
  } catch (diffError) {
    // Preserve the worktree for recovery when its only durable handoff could
    // not be produced.
    if (actionError != null) throw new AggregateError([actionError, diffError], 'isolated action and diff collection both failed');
    throw diffError;
  }
  let retained = false;
  if (actionError == null && opts.settle != null) {
    const settled = opts.settle(created.worktreeAbs, diff);
    retained = settled.retain;
    if (settled.diff != null) diff = settled.diff;
  }
  if (!retained) removeIsolatedWorktree(opts.repoRoot, created.worktreeAbs);
  if (actionError != null) throw actionError;
  return { result: result as T, diff, worktreeRel: created.worktreeRel, retained };
}

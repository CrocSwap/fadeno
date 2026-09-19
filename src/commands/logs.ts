/** Read the command-lane internal activity stream for one dispatch.
 *
 * The activity file is deliberately not a user-supplied path. Its location is
 * derived from the dispatch id recorded in the ledger, which keeps `logs` from
 * becoming a general-purpose file reader and makes the path stable across
 * names, id prefixes, and renamed worktrees.
 */

import { closeSync, fstatSync, openSync, readSync, statSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { findDispatch, LEDGER_FILE, readDispatches, type DispatchRecord } from '../lib/ledger.ts';
import { outputPaths } from '../lib/spawn.ts';

export class LogsError extends Error {}

export interface LogsOptions {
  cwd?: string;
  repoRoot?: string;
  ref: string;
  /** A positive decimal integer, as received from `--tail`. */
  tail?: string | number | null;
  follow?: boolean;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface LogsProgress {
  /** Newly appended bytes, never decoded or normalized. */
  chunk: Buffer;
  stopped: boolean;
  /** True when the current stopped row has no bytes left to read. */
  drained: boolean;
  /** Filesystem/ledger state observed before this read began. */
  token: string;
}

export interface LogsSource {
  readonly repoRoot: string;
  readonly id: string;
  readonly activityPath: string;
  readonly follow: boolean;
  readonly tail: number | null;
  /** Existing bytes, already reduced to `tail` when requested. */
  readonly initial: Buffer;
  /** The resolved dispatch is updated by `readLogsProgress`. */
  record: DispatchRecord;
  offset: number;
  identity: FileIdentity | null;
  /** State captured by the last progress read, before it consumed bytes. */
  progressToken: string | null;
}

function rootOf(opts: Pick<LogsOptions, 'cwd' | 'repoRoot'>): string {
  return resolve(opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd()));
}

function displayName(record: DispatchRecord): string {
  return record.opened?.name ?? record.id;
}

function parseTail(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const rendered = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(rendered)) {
    throw new LogsError(`--tail must be a positive integer; received "${String(value)}".`);
  }
  const parsed = Number(rendered);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LogsError(`--tail must be a positive integer; received "${String(value)}".`);
  }
  return parsed;
}

/** Return the final N newline-delimited lines without changing any bytes. */
export function tailActivity(bytes: Buffer, lines: number): Buffer {
  if (!Number.isSafeInteger(lines) || lines <= 0) throw new LogsError('--tail must be a positive integer.');
  let boundaries = 0;
  // A trailing newline terminates the final line; it does not create an extra
  // empty line. This matches the useful shell meaning of `tail -n N` while
  // retaining that newline byte in the returned slice.
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) end -= 1;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (bytes[index] !== 0x0a) continue;
    boundaries += 1;
    if (boundaries === lines) return bytes.subarray(index + 1);
  }
  return bytes;
}

function identity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left != null && right != null && left.dev === right.dev && left.ino === right.ino;
}

function activityError(source: { activityPath: string }, record: DispatchRecord): LogsError {
  const name = displayName(record);
  const relativePath = source.activityPath;
  return new LogsError(
    `dispatch ${name} (${record.id}) has no Fadeno internal activity recorded yet; ` +
      `expected ${relativePath}. The command-lane activity file may appear while it is running; ` +
      'use `fadeno logs ' + name + ' --follow` to wait for it.',
  );
}

function readRange(fd: number, offset: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    try {
      const count = readSync(fd, bytes, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EINTR' || code === 'EAGAIN') continue;
      throw error;
    }
  }
  return read === length ? bytes : bytes.subarray(0, read);
}

function readActivity(path: string): { bytes: Buffer; identity: FileIdentity } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const stats = fstatSync(fd);
    return { bytes: readRange(fd, 0, stats.size), identity: identity(stats) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LogsError(`cannot read Fadeno internal activity at ${path}: ${(error as Error).message}`);
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function activityStats(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LogsError(`cannot inspect Fadeno internal activity at ${path}: ${(error as Error).message}`);
  }
}

function currentRecord(source: LogsSource): DispatchRecord {
  const record = readDispatches(source.repoRoot).records.find((candidate) => candidate.id === source.id);
  if (record == null) throw new LogsError(`dispatch ${source.id} vanished from the ledger while following its activity.`);
  source.record = record;
  return record;
}

/** Resolve the ref and take the initial byte snapshot for the CLI view. */
export function runLogs(opts: LogsOptions): LogsSource {
  const repoRoot = rootOf(opts);
  const tail = parseTail(opts.tail);
  const found = findDispatch(readDispatches(repoRoot).records, opts.ref);
  if (!found.ok) throw new LogsError(found.message);
  const record = found.record;
  const opened = record.opened;
  if (opened == null) throw new LogsError(`dispatch ${record.id} has no opened row; its activity cannot be read.`);
  if (opened.lane === 'host') {
    throw new LogsError(
      `dispatch ${displayName(record)} (${record.id}) used the host lane; Fadeno has no internal activity file for it. ` +
        'The harness owns that transcript.',
    );
  }

  const activityPath = join(repoRoot, outputPaths(record.id).stderr);
  const initial = readActivity(activityPath);
  const follow = opts.follow === true;
  if (initial == null && (!follow || record.stopped != null)) throw activityError({ activityPath }, record);
  const bytes = initial?.bytes ?? Buffer.alloc(0);
  return {
    repoRoot,
    id: record.id,
    activityPath,
    follow,
    tail,
    initial: tail == null ? bytes : tailActivity(bytes, tail),
    record,
    offset: bytes.length,
    identity: initial?.identity ?? null,
    progressToken: null,
  };
}

/** Read bytes appended since the last progress call, handling replacement. */
export function readLogsProgress(source: LogsSource): LogsProgress {
  const record = currentRecord(source);
  // Capture the state before opening/reading the stream. If bytes or a stopped
  // row arrive after this point but before the caller installs its watcher,
  // waitForLogsChange can compare against this token instead of treating the
  // late state as the new baseline.
  const progressToken = stateToken(record, activityStats(source.activityPath));
  source.progressToken = progressToken;
  let fd: number | null = null;
  try {
    fd = openSync(source.activityPath, 'r');
    const stats = fstatSync(fd);
    const currentIdentity = identity(stats);
    // A replacement gets a fresh identity. A truncation gets a smaller size.
    // Either means the cursor must start at zero so the new stream is not lost.
    if (!sameIdentity(source.identity, currentIdentity) || stats.size < source.offset) source.offset = 0;
    source.identity = currentIdentity;
    const chunk = readRange(fd, source.offset, stats.size - source.offset);
    source.offset += chunk.length;
    return { chunk, stopped: record.stopped != null, drained: record.stopped != null && source.offset >= stats.size, token: progressToken };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LogsError(`cannot read Fadeno internal activity at ${source.activityPath}: ${(error as Error).message}`);
    if (source.identity != null) throw new LogsError(`Fadeno internal activity at ${source.activityPath} disappeared while following dispatch ${source.id}.`);
    source.identity = null;
    source.offset = 0;
    return { chunk: Buffer.alloc(0), stopped: record.stopped != null, drained: record.stopped != null, token: progressToken };
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function stateToken(record: DispatchRecord, stats: Stats | null): string {
  const file = stats == null ? 'missing' : `${stats.dev}:${stats.ino}:${stats.size}`;
  return `${record.stopped?.at ?? ''}|${file}`;
}

function token(source: LogsSource): string {
  const record = currentRecord(source);
  return stateToken(record, activityStats(source.activityPath));
}

/** Wait for a ledger or activity-file change, with a token check closing the setup race. */
export async function waitForLogsChange(source: LogsSource, expectedToken?: string): Promise<void> {
  const before = expectedToken ?? source.progressToken ?? token(source);
  source.progressToken = null;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const paths = [source.activityPath, join(source.repoRoot, LEDGER_FILE)];
    const changed = (): void => finish();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      for (const path of paths) unwatchFile(path, changed);
      if (error == null) resolvePromise();
      else rejectPromise(error);
    };
    try {
      // stat-based watching avoids consuming a file descriptor for every
      // follower and also works before either file exists.
      for (const path of paths) watchFile(path, { persistent: true, interval: 250 }, changed);
      // The append or stop row can land after the first read but before the
      // watchers exist. Re-read once after setup to close that race.
      if (token(source) !== before) finish();
    } catch (error) {
      finish(new LogsError(`cannot watch Fadeno activity for dispatch ${source.id}: ${(error as Error).message}`));
    }
  });
}

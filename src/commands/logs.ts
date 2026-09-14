/** Read the command-lane internal activity stream for one dispatch.
 *
 * The activity file is deliberately not a user-supplied path. Its location is
 * derived from the dispatch id recorded in the ledger, which keeps `logs` from
 * becoming a general-purpose file reader and makes the path stable across
 * names, id prefixes, and renamed worktrees.
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { findDispatch, readDispatches, type DispatchRecord } from '../lib/ledger.ts';
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
}

export interface LogsSource {
  readonly repoRoot: string;
  readonly id: string;
  readonly activityPath: string;
  readonly ledgerDir: string;
  readonly follow: boolean;
  readonly tail: number | null;
  /** Existing bytes, already reduced to `tail` when requested. */
  readonly initial: Buffer;
  /** The resolved dispatch is updated by `readLogsProgress`. */
  record: DispatchRecord;
  offset: number;
  identity: FileIdentity | null;
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

function readActivity(path: string): { bytes: Buffer; identity: FileIdentity } | null {
  try {
    const stats = statSync(path);
    return { bytes: readFileSync(path), identity: identity(stats) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LogsError(`cannot read Fadeno internal activity at ${path}: ${(error as Error).message}`);
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
    ledgerDir: join(repoRoot, '.fadeno'),
    follow,
    tail,
    initial: tail == null ? bytes : tailActivity(bytes, tail),
    record,
    offset: bytes.length,
    identity: initial?.identity ?? null,
  };
}

/** Read bytes appended since the last progress call, handling replacement. */
export function readLogsProgress(source: LogsSource): LogsProgress {
  const record = currentRecord(source);
  const current = readActivity(source.activityPath);
  if (current == null) {
    source.identity = null;
    source.offset = 0;
    return { chunk: Buffer.alloc(0), stopped: record.stopped != null, drained: record.stopped != null };
  }
  // A replacement gets a fresh identity. A truncation gets a smaller size.
  // Either means the cursor must start at zero so the new stream is not lost.
  if (!sameIdentity(source.identity, current.identity) || current.bytes.length < source.offset) source.offset = 0;
  source.identity = current.identity;
  const chunk = current.bytes.subarray(source.offset);
  source.offset = current.bytes.length;
  return { chunk, stopped: record.stopped != null, drained: record.stopped != null && source.offset >= current.bytes.length };
}

function token(source: LogsSource): string {
  const record = currentRecord(source);
  const current = readActivity(source.activityPath);
  const file = current == null ? 'missing' : `${current.identity.dev}:${current.identity.ino}:${current.bytes.length}`;
  return `${record.stopped?.at ?? ''}|${file}`;
}

function watchDirectory(source: LogsSource): string[] {
  const outputDir = dirname(source.activityPath);
  const localDir = join(source.repoRoot, '.fadeno', 'local');
  const candidates = [existsSync(outputDir) ? outputDir : existsSync(localDir) ? localDir : source.ledgerDir, source.ledgerDir];
  return [...new Set(candidates)];
}

/** Wait for a ledger or activity-file event, with a token check closing the race before watch setup. */
export async function waitForLogsChange(source: LogsSource): Promise<void> {
  const before = token(source);
  const watchers: FSWatcher[] = [];
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      for (const watcher of watchers) watcher.close();
      if (error == null) resolvePromise();
      else rejectPromise(error);
    };
    try {
      for (const path of watchDirectory(source)) watchers.push(watch(path, { persistent: true }, () => finish()));
      // The append or stop row can land after the first read but before the
      // watcher exists. Re-read once after setup; this is synchronization, not
      // polling, and closes the only event-registration race.
      if (token(source) !== before) finish();
    } catch (error) {
      finish(new LogsError(`cannot watch Fadeno activity for dispatch ${source.id}: ${(error as Error).message}`));
    }
  });
}

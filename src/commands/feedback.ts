import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { activeHarness } from '../lib/executors.ts';
import { findDispatch, readDispatches } from '../lib/ledger.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';

export class FeedbackError extends Error {}

/**
 * Where a host records friction with Fadeno itself.
 *
 * It sits beside the ledger rather than under `.fadeno/local/`, because it is
 * not scratch: it is the one channel by which the agents USING Fadeno reach
 * the people changing it, and `fadeno clean` must never take it.
 */
export const FEEDBACK_FILE = join('.fadeno', 'feedback.md');

export interface FeedbackOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  /** A dispatch this friction happened on, by id, id prefix, or name. */
  dispatch?: string | null;
  now?: Date;
}

export interface FeedbackEntry {
  at: string;
  harness: string;
  version: string;
  dispatch: { id: string; name: string | null } | null;
  text: string;
}

export interface FeedbackAppendResult extends FeedbackEntry {
  path: string;
  /** Entries in the file after this one was added. */
  total: number;
}

function repoRootOf(opts: FeedbackOptions): string {
  return opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
}

function pathOf(repoRoot: string): string {
  return join(repoRoot, FEEDBACK_FILE);
}

const HEADING = /^## /gm;

/**
 * Append one entry, with the context a reader needs and a host would otherwise
 * have to remember to include: when, which harness, which Fadeno, and — when
 * the friction happened on a dispatch — which one.
 *
 * Append-only and plain markdown, for the same reason the ledger is append-only
 * JSONL: the file is read by people and by agents that did not write it, and a
 * format either of them can lose is not a channel.
 */
export function runFeedbackAdd(opts: FeedbackOptions & { text: string }): FeedbackAppendResult {
  const repoRoot = repoRootOf(opts);
  const text = opts.text.trim();
  if (text.length === 0) {
    throw new FeedbackError('nothing to record — pass the friction as one argument, e.g. `fadeno feedback "the nag counts running dispatches"`.');
  }
  let dispatch: FeedbackEntry['dispatch'] = null;
  if (opts.dispatch != null && opts.dispatch.trim().length > 0) {
    const found = findDispatch(readDispatches(repoRoot).records, opts.dispatch);
    // A ref that names nothing is refused rather than dropped: an entry that
    // silently loses the one identifier tying it to a run is worse than none.
    if (!found.ok) throw new FeedbackError(found.message);
    dispatch = { id: found.record.id, name: found.record.opened?.name ?? null };
  }
  const entry: FeedbackEntry = {
    at: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    harness: activeHarness(undefined, opts.userPathOptions) ?? 'standalone',
    version: packageVersion(),
    dispatch,
    text,
  };
  const path = pathOf(repoRoot);
  const existed = existsSync(path);
  const header = existed
    ? ''
    : [
        '# Fadeno feedback',
        '',
        'Friction with Fadeno itself, recorded by the sessions that hit it.',
        'Append with `fadeno feedback "<what happened>"`; read with `fadeno feedback`.',
        '',
      ].join('\n');
  const body = [
    `## ${entry.at} · ${entry.harness} · fadeno ${entry.version}${dispatch != null ? ` · dispatch ${dispatch.name ?? dispatch.id.slice(0, 8)} (${dispatch.id})` : ''}`,
    '',
    entry.text,
    '',
    '',
  ].join('\n');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${header}${body}`, 'utf8');
  return { ...entry, path, total: (readFileSync(path, 'utf8').match(HEADING) ?? []).length };
}

export interface FeedbackReadResult {
  path: string;
  exists: boolean;
  text: string | null;
  entries: number;
}

/** The whole file, for a person or for an agent collecting what hosts reported. */
export function runFeedbackRead(opts: FeedbackOptions = {}): FeedbackReadResult {
  const path = pathOf(repoRootOf(opts));
  if (!existsSync(path)) return { path, exists: false, text: null, entries: 0 };
  const text = readFileSync(path, 'utf8');
  return { path, exists: true, text, entries: (text.match(HEADING) ?? []).length };
}

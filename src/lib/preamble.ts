/**
 * `.fadeno/preamble.md` — what this repository tells every dispatch.
 *
 * Fadeno already owns the prompt envelope: the caller's prompt leads and the
 * worker's contract follows it. What the contract could not say was anything
 * about the repository, so every convention that never changes — the
 * interpreter to use, the shared build directory, where receipts belong, which
 * features are forbidden — had to be retyped into each brief by hand.
 *
 * A director running a day of dispatches named that as its second-biggest cost
 * and its most expensive single mistake: it omitted an absolute path from one
 * brief and the worker wrote its receipts into a disposable tree. The fix is
 * not better recall. It is a file the repository states once and Fadeno
 * carries every time.
 *
 * It is prose in a file rather than a field in `executors.yaml` because it is
 * text for an intelligence to read, not configuration for Fadeno to parse:
 * it wants review in a diff, and a YAML block scalar is a worse place to write
 * a paragraph than a markdown file is.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PREAMBLE_FILE = join('.fadeno', 'preamble.md');

/**
 * How much of it rides on every prompt.
 *
 * A cap exists because this text is paid for once per dispatch, forever, and a
 * conventions file is exactly the kind of thing that becomes a junk drawer.
 * Going over is not an error and nothing is silently dropped: the contract
 * carries the first `PREAMBLE_MAX_CHARS`, says so in the agent's own words,
 * and names the absolute path so it can read the rest itself.
 */
export const PREAMBLE_MAX_CHARS = 4000;

export interface Preamble {
  /** Repo-relative path, whether or not it exists. */
  path: string;
  exists: boolean;
  /** What the contract should carry: the file, cut at the cap. */
  text: string | null;
  /** Length of the whole file, in characters. */
  chars: number;
  truncated: boolean;
}

export function readPreamble(repoRoot: string): Preamble {
  const path = PREAMBLE_FILE;
  const file = join(repoRoot, path);
  if (!existsSync(file)) return { path, exists: false, text: null, chars: 0, truncated: false };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // Unreadable is reported as absent rather than thrown: a preamble is an
    // improvement to a dispatch, and no improvement is worth failing a spawn.
    return { path, exists: false, text: null, chars: 0, truncated: false };
  }
  const trimmed = raw.trim();
  if (trimmed === '') return { path, exists: false, text: null, chars: 0, truncated: false };
  if (trimmed.length <= PREAMBLE_MAX_CHARS) {
    return { path, exists: true, text: trimmed, chars: trimmed.length, truncated: false };
  }
  return { path, exists: true, text: trimmed.slice(0, PREAMBLE_MAX_CHARS).trimEnd(), chars: trimmed.length, truncated: true };
}

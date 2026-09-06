/**
 * The row shape of the two spawn-side marker logs —
 * `.fadeno/local/pending-relays.jsonl` and
 * `.fadeno/local/proxy-dispatches.jsonl`.
 *
 * Both are written by standalone Claude hooks that cannot import a constant
 * from this codebase, and both are read by `src/commands/dispatch.ts` with the
 * same two questions: is this line JSON, and does the row carry a timestamp
 * and a prompt digest this process can use. That predicate lived twice in
 * `dispatch.ts` and a third time would have appeared in the persisted-state
 * audit — which is the one-list-two-consumers shape this codebase keeps
 * paying for. It lives here once, and both the consumer and the audit call it,
 * so "a row the reader can use" cannot mean two different things.
 *
 * Freshness is deliberately NOT here. Age is a property of the CALL (a relay
 * consumed seconds later, an audit reporting a file at rest); a stale row is
 * a row the reader correctly ignores, never a damaged one.
 */

/** The fields a marker row must carry before any reader can act on it. */
export interface SpawnMarkerRow {
  timestamp: string;
  prompt_sha256: string;
}

/**
 * Split a marker log into its rows, THROWING on a line that is not JSON.
 *
 * Aborting the whole read is the existing contract of both consumers: a
 * malformed stash attests nothing rather than guessing from the half of it
 * that parsed. Blank lines are not damage — the writers append with a
 * trailing newline.
 */
export function spawnMarkerLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * Interpret one parsed row, or null when no reader can make use of it: a
 * non-object, a timestamp that is not a parsable instant, or a missing
 * prompt digest. The returned object is a VIEW of the two fields — callers
 * that rewrite the log keep the original row, so fields a newer hook writes
 * are never dropped on the way through.
 */
export function spawnMarkerRow(value: unknown): SpawnMarkerRow | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const timestamp = row.timestamp;
  const digest = row.prompt_sha256;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;
  if (typeof digest !== 'string') return null;
  return { timestamp, prompt_sha256: digest };
}

/** Whether this row is usable AND written within `maxAgeMs` of `now`. */
export function spawnMarkerIsFresh(value: unknown, now: Date, maxAgeMs: number): boolean {
  const row = spawnMarkerRow(value);
  if (row == null) return false;
  return now.getTime() - Date.parse(row.timestamp) <= maxAgeMs;
}

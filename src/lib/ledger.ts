/**
 * The dispatch ledger: `.fadeno/dispatches.jsonl`, append-only, three row
 * kinds. Nothing here is written by hand and nothing here is ever rewritten.
 *
 * Three rows because "started", "the agent stopped" and "the host decided"
 * are three facts, recorded by three parties, at three times:
 *
 *   opened  — by the spawn wrapper (a hook on the host lane, the CLI on the
 *             command lane) the moment a dispatch exists.
 *   stopped — by an outside observer (the stop hook, or the CLI watching a
 *             command-lane process exit). Records presence of a final
 *             message, never completeness, and what the tree held.
 *   closed  — when the host decides: exactly one verb.
 *
 * The reader is tolerant by rule: a line it cannot parse is COUNTED and
 * skipped, never fatal; a row kind it does not know is counted apart from
 * unreadable ones; a missing file is an empty ledger, not an error. Every
 * count is surfaced, because a reader that silently drops a row is how an
 * intact log gets reported as damaged — or a damaged one as intact.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEDGER_FILE = join('.fadeno', 'dispatches.jsonl');
export const PROMPTS_DIR = join('.fadeno', 'prompts');
/** How much of the caller's prompt rides inline on the opened row. */
export const TASK_EXCERPT_CHARS = 300;
/** Longest final-message excerpt a stopped row carries. */
export const FINAL_MESSAGE_CHARS = 2000;
/** Longest dirty-path listing a stopped row carries. */
export const DIRTY_PATH_LIMIT = 200;

export type Lane = 'host' | 'command';
export type CloseVerb = 'merged' | 'kept' | 'discarded' | 'failed';
export const CLOSE_VERBS: readonly CloseVerb[] = ['merged', 'kept', 'discarded', 'failed'];

export interface Workspace {
  /** Repo-relative worktree path, or the repo root itself (`.`) for a shared tree. */
  path: string;
  /** Branch the worktree is on; null for a shared tree. */
  branch: string | null;
  /** Commit the worktree was cut from. */
  base: string;
}

export interface OpenedRow {
  row: 'opened';
  id: string;
  name: string;
  at: string;
  /** Host session the spawn came from, when the harness names one. */
  session: string | null;
  /** The dispatch that spawned this one, when this is a nested spawn. */
  parent: string | null;
  archetype: string;
  model: string;
  /**
   * The provider-facing id handed to the harness — `gpt-5.6-sol` where `model`
   * is `sol`. Recorded because it is what actually travelled, and because it
   * makes the stop-time comparison against `model_observed` exact instead of a
   * substring guess. Absent on rows an older Fadeno wrote.
   */
  model_id?: string;
  effort: string | null;
  /** Set when the caller overrode the dial with an explicit model. */
  explicit_model: string | null;
  lane: Lane;
  harness: string | null;
  workspace: Workspace | null;
  /** First `TASK_EXCERPT_CHARS` of the caller's prompt. */
  task: string;
  task_truncated?: true;
  /** Repo-relative path of the full prompt text. */
  prompt: string;
  /** Command lane only: the process group Fadeno launched, for `cancel`. */
  process_group?: number;
}

/** What the tree held when the agent stopped. */
export type DirtyPaths = { paths: string[]; truncated: boolean } | 'unavailable';

export interface StoppedRow {
  row: 'stopped';
  id: string;
  at: string;
  /** Excerpt of the agent's final message; null when the harness supplied none. */
  final_message: string | null;
  dirty: DirtyPaths;
  /** Where the agent was actually working, when known — compared to the assigned worktree. */
  cwd?: string | null;
  /** Command lane: how the process ended. */
  exit?: { code: number | null; signal: string | null };
  /**
   * The model the agent's transcript says it ran on, when the harness left a
   * transcript to read. An observation, recorded so a dial the harness did
   * not apply is visible next to the model the opened row asked for.
   */
  model_observed?: string | null;
}

export interface ClosedRow {
  row: 'closed';
  id: string;
  at: string;
  verb: CloseVerb;
  note: string | null;
}

export type LedgerRow = OpenedRow | StoppedRow | ClosedRow;

export type DispatchState = 'open' | 'stopped' | 'closed';

export interface DispatchRecord {
  id: string;
  opened: OpenedRow | null;
  stopped: StoppedRow | null;
  closed: ClosedRow | null;
  state: DispatchState;
}

export interface LedgerReading {
  rows: LedgerRow[];
  /** Lines that are not JSON at all: damage. */
  unreadable: number;
  /** JSON lines that are not a row this version reads: another format's, never damage. */
  unknown: number;
}

export interface DispatchReading {
  records: DispatchRecord[];
  unreadable: number;
  unknown: number;
}

export function newDispatchId(): string {
  return randomUUID();
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** Append one row. The directory is created on first use; the file is never rewritten. */
export function appendRow(repoRoot: string, row: LedgerRow): void {
  const file = join(repoRoot, LEDGER_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

const KNOWN_ROWS = new Set(['opened', 'stopped', 'closed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Read every line, counting what could not be read rather than throwing. */
export function readLedger(repoRoot: string): LedgerReading {
  const file = join(repoRoot, LEDGER_FILE);
  const reading: LedgerReading = { rows: [], unreadable: 0, unknown: 0 };
  if (!existsSync(file)) return reading;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { rows: [], unreadable: 1, unknown: 0 };
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      reading.unreadable += 1;
      continue;
    }
    // A line that is JSON but not a row this version reads — no `row` kind,
    // or one it does not know — is another format, not damage: a repository
    // upgraded from the 0.6 line carries hundreds of its old event rows here.
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.row !== 'string' || !KNOWN_ROWS.has(parsed.row)) {
      reading.unknown += 1;
      continue;
    }
    reading.rows.push(parsed as unknown as LedgerRow);
  }
  return reading;
}

/**
 * Fold rows into one record per dispatch, in first-seen order. The first
 * row of each kind wins: a second `closed` for the same id is a replay the
 * writer should have refused, and the reader must not let it overturn the
 * decision that was recorded first.
 */
export function correlate(rows: readonly LedgerRow[]): DispatchRecord[] {
  const byId = new Map<string, DispatchRecord>();
  for (const row of rows) {
    let record = byId.get(row.id);
    if (record == null) {
      record = { id: row.id, opened: null, stopped: null, closed: null, state: 'open' };
      byId.set(row.id, record);
    }
    if (row.row === 'opened' && record.opened == null) record.opened = row;
    else if (row.row === 'stopped' && record.stopped == null) record.stopped = row;
    else if (row.row === 'closed' && record.closed == null) record.closed = row;
  }
  for (const record of byId.values()) {
    record.state = record.closed != null ? 'closed' : record.stopped != null ? 'stopped' : 'open';
  }
  return [...byId.values()];
}

export function readDispatches(repoRoot: string): DispatchReading {
  const reading = readLedger(repoRoot);
  return { records: correlate(reading.rows), unreadable: reading.unreadable, unknown: reading.unknown };
}

/** Every dispatch with no terminal decision, oldest first. Repository-wide by design. */
export function unclosedDispatches(repoRoot: string): DispatchRecord[] {
  return readDispatches(repoRoot).records.filter((record) => record.closed == null && record.opened != null);
}

export type DispatchLookup =
  | { ok: true; record: DispatchRecord; by: 'id' | 'prefix' | 'name' }
  | { ok: false; reason: 'unknown' | 'ambiguous'; message: string };

/**
 * Resolve a dispatch by full id, unique id prefix, or unique name. A name
 * that several dispatches share is ambiguous rather than "the newest": the
 * caller has an id for exactly this case.
 */
export function findDispatch(records: readonly DispatchRecord[], query: string): DispatchLookup {
  const q = query.trim();
  if (q === '') return { ok: false, reason: 'unknown', message: 'empty dispatch reference.' };
  const exact = records.find((record) => record.id === q);
  if (exact != null) return { ok: true, record: exact, by: 'id' };
  const byName = records.filter((record) => record.opened?.name === q);
  if (byName.length === 1) return { ok: true, record: byName[0]!, by: 'name' };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `${byName.length} dispatches are named "${q}": ${byName.map((r) => r.id).join(', ')} — use an id.`,
    };
  }
  const byPrefix = q.length >= 4 ? records.filter((record) => record.id.startsWith(q)) : [];
  if (byPrefix.length === 1) return { ok: true, record: byPrefix[0]!, by: 'prefix' };
  if (byPrefix.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `"${q}" is a prefix of ${byPrefix.length} dispatch ids: ${byPrefix.map((r) => r.id).join(', ')}.`,
    };
  }
  const names = [...new Set(records.map((record) => record.opened?.name).filter((n): n is string => n != null))];
  const hint = names.length === 0 ? 'the ledger holds no dispatches.' : `known names: ${names.slice(-10).join(', ')}.`;
  return { ok: false, reason: 'unknown', message: `no dispatch "${q}"; ${hint}` };
}

/** The inline task excerpt: the first characters of the prompt, flagged when cut. */
export function excerptTask(prompt: string): { task: string; truncated: boolean } {
  const normalized = prompt.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= TASK_EXCERPT_CHARS) return { task: normalized, truncated: false };
  return { task: normalized.slice(0, TASK_EXCERPT_CHARS), truncated: true };
}

export function excerptFinalMessage(message: string | null | undefined): string | null {
  if (typeof message !== 'string') return null;
  return message.length <= FINAL_MESSAGE_CHARS ? message : `${message.slice(0, FINAL_MESSAGE_CHARS)}…`;
}

/** Full prompt text lives outside `local/`, so `clean` can never orphan the rows that point at it. */
export function promptPath(id: string): string {
  return join(PROMPTS_DIR, `${id}.md`);
}

export function writePrompt(repoRoot: string, id: string, prompt: string): string {
  const rel = promptPath(id);
  const file = join(repoRoot, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, prompt);
  return rel;
}

export function readPrompt(repoRoot: string, record: DispatchRecord): string | null {
  const rel = record.opened?.prompt;
  if (rel == null) return null;
  try {
    return readFileSync(join(repoRoot, rel), 'utf8');
  } catch {
    return null;
  }
}

export function isCloseVerb(value: unknown): value is CloseVerb {
  return typeof value === 'string' && (CLOSE_VERBS as readonly string[]).includes(value);
}

export type CloseOutcome =
  | { ok: true; row: ClosedRow; replayed: boolean }
  | { ok: false; message: string };

/**
 * Record the terminal decision. Idempotent for the same verb (the row is
 * replayed, nothing appended); a different verb for an already-closed
 * dispatch is refused, because two decisions for one dispatch is the one
 * thing the ledger must never hold.
 */
export function closeDispatch(
  repoRoot: string,
  record: DispatchRecord,
  verb: CloseVerb,
  note: string | null,
  now: Date = new Date(),
): CloseOutcome {
  if (record.closed != null) {
    if (record.closed.verb === verb) return { ok: true, row: record.closed, replayed: true };
    return {
      ok: false,
      message:
        `dispatch ${record.id} is already closed as "${record.closed.verb}" (${record.closed.at}); ` +
        `a second decision ("${verb}") is refused — the ledger holds one decision per dispatch.`,
    };
  }
  const row: ClosedRow = { row: 'closed', id: record.id, at: nowIso(now), verb, note: note?.trim() || null };
  appendRow(repoRoot, row);
  return { ok: true, row, replayed: false };
}

/** Age of a dispatch in whole minutes, for the nag and the listing. */
/**
 * Whether the model an agent's transcript reports is the one the dial asked
 * for. The dial names a registry alias (`opus`) and the harness reports its
 * own id (`claude-opus-5`), so equality is too strict; an alias that appears
 * inside the reported id is taken as agreement, and `host` agrees
 * with anything, since it names whatever the session runs on.
 */
export function modelAgrees(
  asked: string | null | undefined,
  observed: string | null | undefined,
  askedId?: string | null,
): boolean {
  if (asked == null || observed == null) return true;
  if (asked === 'host') return true;
  // The recorded provider id, where the row has one: an exact answer, and the
  // reason `model_id` is on the row at all.
  if (askedId != null && askedId.length > 0) return askedId === observed || observed.includes(askedId);
  // Older rows carry only the alias, so fall back to containment — `opus`
  // against `claude-opus-5` is agreement, not a mismatch.
  if (asked === observed) return true;
  return observed.toLowerCase().includes(asked.toLowerCase());
}

export function ageMinutes(record: DispatchRecord, now: Date = new Date()): number | null {
  const at = record.opened?.at;
  if (at == null) return null;
  const ms = now.getTime() - Date.parse(at);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : null;
}

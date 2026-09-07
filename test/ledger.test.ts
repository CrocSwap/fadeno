import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  LEDGER_FILE,
  TASK_EXCERPT_CHARS,
  ageMinutes,
  appendRow,
  closeDispatch,
  correlate,
  excerptTask,
  findDispatch,
  newDispatchId,
  promptPath,
  readDispatches,
  readLedger,
  readPrompt,
  unclosedDispatches,
  writePrompt,
  type OpenedRow,
  type StoppedRow,
} from '../src/lib/ledger.ts';
import { tempRepo } from './helpers.ts';

function opened(id: string, overrides: Partial<OpenedRow> = {}): OpenedRow {
  return {
    row: 'opened',
    id,
    name: `worker-${id.slice(0, 4)}`,
    at: '2026-09-07T10:00:00.000Z',
    session: null,
    parent: null,
    archetype: 'worker',
    model: 'luna',
    effort: 'xhigh',
    explicit_model: null,
    lane: 'command',
    harness: 'codex',
    workspace: { path: '.fadeno/local/worktrees/x', branch: 'fadeno/x', base: 'abc' },
    task: 'do the thing',
    prompt: promptPath(id),
    ...overrides,
  };
}

function stopped(id: string, overrides: Partial<StoppedRow> = {}): StoppedRow {
  return { row: 'stopped', id, at: '2026-09-07T10:05:00.000Z', final_message: 'done', dirty: { paths: [], truncated: false }, ...overrides };
}

test('rows appended by the writer read back through the reader, one record per dispatch', (t) => {
  const root = tempRepo(t);
  const a = newDispatchId();
  const b = newDispatchId();
  appendRow(root, opened(a));
  appendRow(root, opened(b));
  appendRow(root, stopped(a));
  appendRow(root, { row: 'closed', id: a, at: '2026-09-07T10:06:00.000Z', verb: 'merged', note: null });
  const reading = readDispatches(root);
  assert.equal(reading.unreadable, 0);
  assert.equal(reading.unknown, 0);
  assert.deepEqual(reading.records.map((r) => [r.id, r.state]), [[a, 'closed'], [b, 'open']]);
  assert.equal(reading.records[0]!.stopped?.final_message, 'done');
});

test('a missing ledger is an empty answer, not an error', (t) => {
  const root = tempRepo(t);
  assert.deepEqual(readLedger(root), { rows: [], unreadable: 0, unknown: 0 });
  assert.deepEqual(unclosedDispatches(root), []);
});

test('a malformed line is counted and skipped, never fatal; an unknown row kind is counted apart', (t) => {
  const root = tempRepo(t);
  const id = newDispatchId();
  appendRow(root, opened(id));
  appendFileSync(join(root, LEDGER_FILE), 'this is not json\n{"row":"opened"}\n{"row":"annotated","id":"x"}\n\n');
  const reading = readLedger(root);
  assert.equal(reading.rows.length, 1);
  assert.equal(reading.unreadable, 2, 'a torn line and a row with no id are both unreadable');
  assert.equal(reading.unknown, 1, 'a well-formed row of a kind this reader does not know is not damage');
});

test('an opened row with no terminal is open, never dropped; a stop makes it stopped; a close makes it closed', (t) => {
  const root = tempRepo(t);
  const id = newDispatchId();
  appendRow(root, opened(id));
  assert.equal(readDispatches(root).records[0]!.state, 'open');
  appendRow(root, stopped(id));
  assert.equal(readDispatches(root).records[0]!.state, 'stopped');
  appendRow(root, { row: 'closed', id, at: '2026-09-07T10:06:00.000Z', verb: 'kept', note: 'keep for review' });
  assert.equal(readDispatches(root).records[0]!.state, 'closed');
});

test('a stop row for an id nobody opened still correlates into a record rather than vanishing', () => {
  const records = correlate([stopped('orphan')]);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.opened, null);
  assert.equal(records[0]!.state, 'stopped');
});

test('the first row of each kind wins: a replayed close cannot overturn the recorded decision', () => {
  const records = correlate([
    opened('a'),
    { row: 'closed', id: 'a', at: 't1', verb: 'merged', note: null },
    { row: 'closed', id: 'a', at: 't2', verb: 'discarded', note: null },
  ]);
  assert.equal(records[0]!.closed?.verb, 'merged');
});

test('closeDispatch replays the same verb and refuses a different one', (t) => {
  const root = tempRepo(t);
  const id = newDispatchId();
  appendRow(root, opened(id));
  const first = closeDispatch(root, readDispatches(root).records[0]!, 'merged', '  landed on main ', new Date('2026-09-07T11:00:00Z'));
  assert.ok(first.ok && !first.replayed);
  assert.equal(first.ok && first.row.note, 'landed on main');
  const again = closeDispatch(root, readDispatches(root).records[0]!, 'merged', null);
  assert.ok(again.ok && again.replayed, 'same decision twice is a replay');
  const other = closeDispatch(root, readDispatches(root).records[0]!, 'discarded', null);
  assert.ok(!other.ok);
  assert.match(other.ok ? '' : other.message, /already closed as "merged"/);
  const lines = readFileSync(join(root, LEDGER_FILE), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'the refused and replayed closes appended nothing');
});

test('unclosed is repository-wide and oldest first, and a closed dispatch drops out', (t) => {
  const root = tempRepo(t);
  const older = newDispatchId();
  const newer = newDispatchId();
  appendRow(root, opened(older, { at: '2026-09-07T09:00:00.000Z', session: 'session-1' }));
  appendRow(root, opened(newer, { at: '2026-09-07T10:00:00.000Z', session: 'session-2', parent: older }));
  assert.deepEqual(unclosedDispatches(root).map((r) => r.id), [older, newer]);
  appendRow(root, { row: 'closed', id: older, at: '2026-09-07T10:30:00.000Z', verb: 'failed', note: null });
  assert.deepEqual(unclosedDispatches(root).map((r) => r.id), [newer]);
  assert.equal(unclosedDispatches(root)[0]!.opened?.parent, older, 'parent is on the row so orphan inheritance can be computed');
});

test('findDispatch resolves by id, by unique prefix, and by unique name; ambiguity is refused, never guessed', () => {
  const a = '11111111-2222-3333-4444-555555555555';
  const b = '11111111-9999-3333-4444-555555555555';
  const records = correlate([opened(a, { name: 'fix-login' }), opened(b, { name: 'fix-login' }), opened('c', { name: 'docs' })]);
  assert.equal(findDispatch(records, a).ok, true);
  const byPrefix = findDispatch(records, '11111111-9');
  assert.ok(byPrefix.ok && byPrefix.by === 'prefix' && byPrefix.record.id === b);
  const byName = findDispatch(records, 'docs');
  assert.ok(byName.ok && byName.by === 'name');
  const dupName = findDispatch(records, 'fix-login');
  assert.ok(!dupName.ok && dupName.reason === 'ambiguous');
  assert.match(dupName.ok ? '' : dupName.message, /use an id/);
  const dupPrefix = findDispatch(records, '11111111');
  assert.ok(!dupPrefix.ok && dupPrefix.reason === 'ambiguous');
  const unknown = findDispatch(records, 'nope');
  assert.ok(!unknown.ok && unknown.reason === 'unknown');
  assert.match(unknown.ok ? '' : unknown.message, /known names: fix-login, docs/);
  assert.match(findDispatch([], 'x').ok ? '' : (findDispatch([], 'x') as { message: string }).message, /holds no dispatches/);
});

test('a short prefix never matches: three characters could be anything', () => {
  const records = correlate([opened('abcdef-1'), opened('abcxyz-2')]);
  assert.equal(findDispatch(records, 'abc').ok, false);
});

test('the task excerpt is the first 300 characters, flagged when cut, and the full prompt lives in .fadeno/prompts', (t) => {
  const root = tempRepo(t);
  const id = newDispatchId();
  const short = excerptTask('  Fix the login bug.\r\n');
  assert.deepEqual(short, { task: 'Fix the login bug.', truncated: false });
  const long = excerptTask('x'.repeat(TASK_EXCERPT_CHARS + 50));
  assert.equal(long.task.length, TASK_EXCERPT_CHARS);
  assert.equal(long.truncated, true);
  const rel = writePrompt(root, id, 'full prompt text');
  assert.equal(rel, join('.fadeno', 'prompts', `${id}.md`));
  assert.ok(!rel.includes('local'), 'prompts live outside local/ so clean cannot orphan the rows that reference them');
  appendRow(root, opened(id, { prompt: rel }));
  assert.equal(readPrompt(root, readDispatches(root).records[0]!), 'full prompt text');
});

test('readPrompt answers null, not a throw, when the file is gone', (t) => {
  const root = tempRepo(t);
  const id = newDispatchId();
  appendRow(root, opened(id));
  assert.equal(readPrompt(root, readDispatches(root).records[0]!), null);
});

test('ageMinutes reads the opened timestamp and never goes negative', () => {
  const [record] = correlate([opened('a', { at: '2026-09-07T10:00:00.000Z' })]);
  assert.equal(ageMinutes(record!, new Date('2026-09-07T10:42:30Z')), 42);
  assert.equal(ageMinutes(record!, new Date('2026-09-07T09:00:00Z')), 0);
  assert.equal(ageMinutes(correlate([stopped('b')])[0]!), null);
});

test('appendRow creates .fadeno on first use and only ever appends', (t) => {
  const root = tempRepo(t);
  assert.ok(!existsSync(join(root, '.fadeno')));
  appendRow(root, opened('a'));
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const before = readFileSync(join(root, LEDGER_FILE), 'utf8');
  appendRow(root, opened('b'));
  const after = readFileSync(join(root, LEDGER_FILE), 'utf8');
  assert.ok(after.startsWith(before), 'earlier bytes are untouched');
  writeFileSync(join(root, LEDGER_FILE), after); // no-op sanity: still two lines
  assert.equal(after.trim().split('\n').length, 2);
});

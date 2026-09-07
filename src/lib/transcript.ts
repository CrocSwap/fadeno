/**
 * What a stop hook can read out of the transcript a harness leaves behind.
 *
 * A `SubagentStop` event names an agent, never a dispatch. The one thing that
 * ties the two together deterministically is the contract Fadeno injected
 * into the agent's prompt: its header line carries the dispatch id and name
 * (`CONTRACT_HEADER` in contracts.ts), and the prompt is the first thing in
 * the agent's transcript. Reading it back is an identification, not a guess.
 *
 * The same read yields two observations the ledger wants: the model the
 * agent actually ran on (the harness records it on every assistant turn, and
 * a dial the harness silently ignored is otherwise invisible), and the last
 * assistant text when the event itself carried none — which on Claude is
 * exactly the interrupted path, where it matters most.
 *
 * Shapes are read leniently: a JSONL of records with `message.role`,
 * `message.content` (a string or an array of `{type:'text', text}` blocks)
 * and `message.model` is Claude's; anything else yields nulls rather than an
 * error, so a harness whose transcript this cannot read still gets its stop
 * recorded without these facts.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { CONTRACT_HEADER } from './contracts.ts';

/** How much of a transcript is read looking for the header. The prompt is first, so this is generous. */
export const TRANSCRIPT_HEAD_BYTES = 1024 * 1024;
/** How much of the tail is read for the last assistant text and model. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

export interface TranscriptFacts {
  /** The dispatch the injected contract names, or null when the prompt carries none. */
  dispatchId: string | null;
  name: string | null;
  /** The model on the last assistant record that names one. */
  model: string | null;
  /** The last assistant text block, when one exists. */
  lastAssistantText: string | null;
}

const HEADER_RE = new RegExp(`${CONTRACT_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([0-9a-f-]{36}) \\(([^)\\n]+)\\)`);

function readSlice(path: string, offset: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function fileSize(path: string): number {
  const fd = openSync(path, 'r');
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

interface Record_ {
  message?: { role?: unknown; model?: unknown; content?: unknown };
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((block) => (block != null && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? (block as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return texts.length > 0 ? texts.join('\n') : null;
}

function parseLines(chunk: string, dropFirstPartial: boolean): Record_[] {
  const lines = chunk.split('\n');
  if (dropFirstPartial) lines.shift();
  const out: Record_[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed != null && typeof parsed === 'object') out.push(parsed as Record_);
    } catch {
      // a torn or foreign line says nothing
    }
  }
  return out;
}

/** Read the facts above from a transcript, or nulls where it does not say. */
export function readTranscriptFacts(path: string): TranscriptFacts {
  const facts: TranscriptFacts = { dispatchId: null, name: null, model: null, lastAssistantText: null };
  let size: number;
  try {
    size = fileSize(path);
  } catch {
    return facts;
  }
  // The header: in the prompt, which is the first record. Matched on the raw
  // bytes rather than a parsed record because the id and name contain nothing
  // JSON escapes, and the record may be far larger than any parser budget.
  const head = readSlice(path, 0, Math.min(size, TRANSCRIPT_HEAD_BYTES));
  const header = HEADER_RE.exec(head);
  if (header != null) {
    facts.dispatchId = header[1]!;
    facts.name = header[2]!;
  }
  // The model and last words: from the tail, newest record first.
  const tailStart = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const tail = tailStart === 0 ? head.length >= size ? head : readSlice(path, 0, size) : readSlice(path, tailStart, size - tailStart);
  const records = parseLines(tail, tailStart > 0);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const message = records[i]!.message;
    if (message == null || message.role !== 'assistant') continue;
    if (facts.model == null && typeof message.model === 'string' && message.model.length > 0) facts.model = message.model;
    if (facts.lastAssistantText == null) {
      const text = textOf(message.content);
      if (text != null) facts.lastAssistantText = text;
    }
    if (facts.model != null && facts.lastAssistantText != null) break;
  }
  return facts;
}

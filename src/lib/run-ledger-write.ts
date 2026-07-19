import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RUN_LEDGER_SCHEMA_VERSION } from './run-ledger.ts';

export class LedgerWriteError extends Error {}

/**
 * Append-side twin of `run-ledger.ts`: stamps every event with a contiguous
 * 1-based `seq` and refuses to write into a ledger of another format version,
 * so a legacy ledger can never become mixed-format. One instance per command
 * invocation; `lastSeq` advances in memory across that invocation's appends.
 */
export class LedgerWriter {
  readonly runDir: string;
  private lastSeq: number;

  constructor(runDir: string) {
    this.runDir = runDir;
    const runYamlPath = join(runDir, 'run.yaml');
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(runYamlPath, 'utf8'));
    } catch (err) {
      throw new LedgerWriteError(`cannot read ${runYamlPath}: ${(err as Error).message}`);
    }
    const version =
      doc !== null && typeof doc === 'object' && !Array.isArray(doc)
        ? (doc as Record<string, unknown>).schema_version
        : undefined;
    const versionText = version != null ? String(version) : null;
    if (versionText == null) {
      throw new LedgerWriteError(
        `run at ${runDir} is a legacy ledger (run.yaml has no schema_version); ` +
          'refusing to append new-format events. Create a new run with `fadeno new-run`.',
      );
    }
    if (versionText !== RUN_LEDGER_SCHEMA_VERSION) {
      throw new LedgerWriteError(
        `run at ${runDir} has ledger schema_version "${versionText}"; ` +
          `this fadeno writes "${RUN_LEDGER_SCHEMA_VERSION}".`,
      );
    }
    this.lastSeq = scanLastSeq(join(runDir, 'events.jsonl'));
  }

  /** The seq the next append will receive — lets callers mint ids up front. */
  get nextSeq(): number {
    return this.lastSeq + 1;
  }

  /** Stamp `seq` + `timestamp` and append one line; returns the seq used. */
  append(event: Record<string, unknown>, now: Date): number {
    const seq = this.nextSeq;
    const line = JSON.stringify({ ...event, seq, timestamp: now.toISOString() });
    appendFileSync(join(this.runDir, 'events.jsonl'), `${line}\n`, 'utf8');
    this.lastSeq = seq;
    return seq;
  }
}

/**
 * Max recorded seq, floored at the non-empty line count — a corrupt or
 * seq-less line still occupied its position, and the next append must not
 * reuse it.
 */
function scanLastSeq(eventsPath: string): number {
  if (!existsSync(eventsPath)) return 0;
  const lines = readFileSync(eventsPath, 'utf8').split('\n');
  let maxSeq = 0;
  let lineCount = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    lineCount += 1;
    try {
      const parsed = JSON.parse(line) as { seq?: unknown };
      if (typeof parsed.seq === 'number' && parsed.seq > maxSeq) maxSeq = parsed.seq;
    } catch {
      // Counted above; the line-count floor covers it.
    }
  }
  return Math.max(maxSeq, lineCount);
}

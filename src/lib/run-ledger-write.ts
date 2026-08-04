import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RUN_LEDGER_SCHEMA_VERSION } from './run-ledger.ts';

export class LedgerWriteError extends Error {}

const LOCK_NAME = '.ledger.lock';
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

function waitSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/**
 * Acquire an atomic per-run lock. `mkdir` is the lock acquisition primitive:
 * it succeeds for exactly one process, so sequence scanning and append happen
 * as one serialized critical section. A stale lock is recoverable after a
 * crashed writer; normal contention waits rather than allocating duplicate
 * sequence numbers.
 */
function withRunLock<T>(runDir: string, action: () => T): T {
  const lockPath = join(runDir, LOCK_NAME);
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        // The competing writer may have released the lock between mkdir/stat.
      }
      if (stale) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new LedgerWriteError(`timed out waiting for the ledger lock at ${lockPath}.`);
      }
      waitSync(LOCK_WAIT_MS);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Append-side twin of `run-ledger.ts`: stamps every event with a contiguous
 * 1-based `seq` and refuses to write into a ledger of another format version,
 * so a legacy ledger can never become mixed-format. Every append takes the
 * per-run lock and rescans the ledger while holding it; the in-memory value is
 * only a convenience for the read-only `nextSeq` peek.
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
    return withRunLock(this.runDir, () => {
      const eventsPath = join(this.runDir, 'events.jsonl');
      const seq = scanLastSeq(eventsPath) + 1;
      const line = JSON.stringify({ ...event, seq, timestamp: now.toISOString() });
      appendFileSync(eventsPath, `${line}\n`, 'utf8');
      this.lastSeq = seq;
      return seq;
    });
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

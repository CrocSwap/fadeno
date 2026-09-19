import { readSync } from 'node:fs';

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const RETRY_SLEEP_MS = 10;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type StdinReader = (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number;

export interface ReadStdinOptions {
  fd?: number;
  read?: StdinReader;
  sleep?: (milliseconds: number) => void;
  chunkSize?: number;
}

function isRetryableReadError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'EAGAIN' || code === 'EINTR' || code === 'EWOULDBLOCK';
}

function sleepForRetry(milliseconds: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, milliseconds);
}

function describeReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read all available bytes from stdin, tolerating a descriptor that is
 * temporarily nonblocking. The retry has no deadline: EAGAIN/EINTR means the
 * caller should wait for the same descriptor and try again. Other failures
 * remain errors, with stdin named so the caller knows what to repair.
 */
export function readStdin(options: ReadStdinOptions = {}): string {
  const fd = options.fd ?? 0;
  const read: StdinReader = options.read ?? readSync;
  const sleep = options.sleep ?? sleepForRetry;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`could not read stdin: invalid chunk size ${chunkSize}`);
  }

  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(chunkSize);
  for (;;) {
    let bytesRead: number;
    try {
      bytesRead = read(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (isRetryableReadError(error)) {
        sleep(RETRY_SLEEP_MS);
        continue;
      }
      throw new Error(`could not read stdin: ${describeReadError(error)}`, { cause: error });
    }
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) {
      throw new Error(`could not read stdin: reader returned invalid byte count ${bytesRead}`);
    }
    if (bytesRead === 0) return Buffer.concat(chunks).toString('utf8');
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readStdin, type StdinReader } from '../src/lib/stdin.ts';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test('readStdin sleeps through EAGAIN and consumes each byte exactly once', () => {
  const payload = Buffer.from('first chunk\nsecond chunk — UTF-8\n', 'utf8');
  const delivered: Buffer[] = [];
  let calls = 0;
  const read: StdinReader = (_fd, buffer, offset, length) => {
    calls += 1;
    if (calls === 1) throw errno('EAGAIN');
    if (calls === 2) throw errno('EINTR');
    if (calls >= 3) {
      const start = delivered.reduce((total, chunk) => total + chunk.length, 0);
      const count = Math.min(length, payload.length - start);
      if (count === 0) return 0;
      payload.copy(buffer, offset, start, start + count);
      delivered.push(Buffer.from(payload.subarray(start, start + count)));
      return count;
    }
    throw new Error('unreachable read call');
  };
  const sleeps: number[] = [];

  assert.equal(readStdin({ read, sleep: (milliseconds) => sleeps.push(milliseconds), chunkSize: 7 }), payload.toString('utf8'));
  assert.deepEqual(Buffer.concat(delivered), payload);
  assert.deepEqual(sleeps, [10, 10]);
  assert.equal(calls, 8, 'two retries, five successful reads, and one EOF read');
});

test('readStdin surfaces permanent read failures as stdin errors', () => {
  assert.throws(
    () => readStdin({ read: () => { throw errno('EBADF'); }, sleep: () => undefined }),
    (error: unknown) => error instanceof Error && error.message === 'could not read stdin: EBADF',
  );
});

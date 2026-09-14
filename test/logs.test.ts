import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type ChildProcessWithoutNullStreams } from 'node:test';
import { outputPaths } from '../src/lib/spawn.ts';
import { LEDGER_FILE } from '../src/lib/ledger.ts';
import { gitRepo } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

type Lane = 'command' | 'host';

function cli(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function dispatch(root: string, id: string, name: string, lane: Lane = 'command'): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  appendFileSync(join(root, LEDGER_FILE), `${JSON.stringify({
    row: 'opened',
    id,
    name,
    at: new Date().toISOString(),
    session: null,
    parent: null,
    archetype: 'worker',
    model: 'echo',
    effort: 'high',
    explicit_model: null,
    lane,
    harness: lane === 'command' ? 'codex' : 'codex',
    workspace: null,
    task: 'task',
    prompt: 'p',
  })}\n`);
}

function stop(root: string, id: string): void {
  appendFileSync(join(root, LEDGER_FILE), `${JSON.stringify({
    row: 'stopped',
    id,
    at: new Date().toISOString(),
    final_message: null,
    dirty: { paths: [], truncated: false },
  })}\n`);
}

function close(root: string, id: string): void {
  appendFileSync(join(root, LEDGER_FILE), `${JSON.stringify({
    row: 'closed',
    id,
    at: new Date().toISOString(),
    verb: 'reviewed',
    note: null,
  })}\n`);
}

function activity(root: string, id: string): string {
  return join(root, outputPaths(id).stderr);
}

function waitForData(child: ChildProcessWithoutNullStreams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk: Buffer | string) => resolve(Buffer.from(chunk)));
    child.once('error', reject);
  });
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

test('logs reads full and tailed command-lane activity by name or id, including after close', (t) => {
  const root = gitRepo(t);
  const id = '11111111-1111-4111-8111-111111111111';
  dispatch(root, id, 'activity');
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(activity(root, id), Buffer.from('one\ntwo\nthree\n', 'utf8'));

  const full = cli(root, ['logs', 'activity']);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.stdout, 'one\ntwo\nthree\n');
  const tail = cli(root, ['logs', id, '--tail', '2']);
  assert.equal(tail.status, 0, tail.stderr);
  assert.equal(tail.stdout, 'two\nthree\n');

  stop(root, id);
  close(root, id);
  const afterClose = cli(root, ['logs', 'activity']);
  assert.equal(afterClose.status, 0, afterClose.stderr);
  assert.equal(afterClose.stdout, full.stdout);
});

test('logs rejects invalid tails and explains host-lane and missing activity', (t) => {
  const root = gitRepo(t);
  const commandId = '22222222-2222-4222-8222-222222222222';
  dispatch(root, commandId, 'missing');
  for (const value of ['0', '-1', '1.5', 'nope']) {
    const invalid = cli(root, ['logs', 'missing', '--tail', value]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /--tail must be a positive integer/);
  }
  const missing = cli(root, ['logs', 'missing']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no Fadeno internal activity recorded yet/);
  assert.match(missing.stderr, /\.fadeno\/local\/outputs\/22222222-2222-4222-8222-222222222222\.err/);

  const hostId = '33333333-3333-4333-8333-333333333333';
  dispatch(root, hostId, 'host-job', 'host');
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(activity(root, hostId), 'this must not be read');
  const host = cli(root, ['logs', 'host-job']);
  assert.notEqual(host.status, 0);
  assert.match(host.stderr, /used the host lane/);
  assert.match(host.stderr, /harness owns that transcript/);
});

test('logs --follow preserves appended partial chunks and stops only after the stopped row drains the file', async (t) => {
  const root = gitRepo(t);
  const id = '44444444-4444-4444-8444-444444444444';
  dispatch(root, id, 'stream');
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(activity(root, id), 'first\n');

  const child = spawn(process.execPath, [CLI, 'logs', 'stream', '--tail', '1', '--follow'], {
    cwd: root,
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  const chunks: Buffer[] = [await waitForData(child)];

  appendFileSync(activity(root, id), 'second');
  chunks.push(await waitForData(child));
  appendFileSync(activity(root, id), '\nthird');
  chunks.push(await waitForData(child));
  appendFileSync(activity(root, id), '\n');
  chunks.push(await waitForData(child));
  // The row is deliberately written only after the last partial chunk. The
  // follower must emit that byte and then observe the stop before exiting.
  stop(root, id);
  const ended = await waitForClose(child);
  assert.equal(ended.code, 0, `stderr: ${stderr}`);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'first\nsecond\nthird\n');
});

test('logs activity remains readable until clean --force removes command-lane scratch', (t) => {
  const root = gitRepo(t);
  const id = '55555555-5555-4555-8555-555555555555';
  dispatch(root, id, 'cleanup');
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(activity(root, id), 'keep me\n');
  stop(root, id);
  assert.equal(cli(root, ['logs', 'cleanup']).stdout, 'keep me\n');
  const cleaned = cli(root, ['clean', '--force']);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(existsSync(activity(root, id)), false);
  const gone = cli(root, ['logs', 'cleanup']);
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /no Fadeno internal activity recorded yet/);
});

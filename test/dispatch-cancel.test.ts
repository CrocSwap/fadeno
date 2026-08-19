import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import { runDispatchesCancel } from '../src/commands/dispatches.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import { tempRepo } from './helpers.ts';

function seedLedger(t: import('node:test').TestContext, rows: Record<string, unknown>[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return root;
}
function claim(root: string, id: string, pid: number): void {
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(join(root, ...INFLIGHT_DIR.split('/'), `${id}.json`), JSON.stringify({ pid, started_at: '2026-08-14T10:00:00.000Z' }));
}
const OPEN_ID = '11111111-2222-3333-4444-555555555555';
const openRow = { format: '1.0', timestamp: '2026-08-14T10:00:00.000Z', event: 'dispatch_requested', dispatch_id: OPEN_ID, tag: 'worker-live', archetype: 'worker', executor: 'slow', output_snapshot: '.fadeno/local/outputs/11111111.md' };

test('cancel live dispatch signals supervisor', (t) => {
  const root = seedLedger(t, [openRow]);
  claim(root, OPEN_ID, 4242);
  const signals: Array<[number, string]> = [];
  const result = runDispatchesCancel({ repoRoot: root, tag: 'worker-live', kill: (pid, sig) => signals.push([pid, sig]), now: new Date('2026-08-14T10:05:00.000Z') });
  assert.equal(result.dispatchId, OPEN_ID);
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  const rows = readFileSync(join(root, DISPATCHES_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const cancelled = rows.find((r) => r.event === 'dispatch_cancelled');
  assert.ok(cancelled);
  assert.equal(cancelled.dispatch_id, OPEN_ID);
});

test('cancel signals the executor group when the supervisor was SIGKILLed', (t) => {
  const root = seedLedger(t, [openRow]);
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(join(root, ...INFLIGHT_DIR.split('/'), `${OPEN_ID}.json`), JSON.stringify({
    pid: 4242,
    supervisor_pid: 4242,
    executor_pid: 4343,
    process_group_id: 4343,
    started_at: '2026-08-14T10:00:00.000Z',
  }));
  const signals: Array<[number, string]> = [];
  const result = runDispatchesCancel({
    repoRoot: root,
    tag: 'worker-live',
    kill: (pid, sig) => signals.push([pid, sig]),
    probe: (pid) => {
      if (pid === 4242) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  assert.equal(result.pid, -4343);
  assert.deepEqual(signals, [[-4343, 'SIGTERM']]);
});

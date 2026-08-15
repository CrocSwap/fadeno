import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, runDispatch } from '../src/commands/dispatch.ts';
import { DispatchesCommandError, runDispatchesOutput } from '../src/commands/dispatches.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

function seedV3(t: TestContext, cmd: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { probe: { provider: 'openai', id: 'probe' } },
    routes: { standalone: { openai: { command: cmd } }, codex: { openai: { command: cmd } } },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'probe', reviewer: 'probe' },
  }));
  return root;
}
function echoing(text: string): string[] { return ['node', '-e', `process.stdout.write(${JSON.stringify(text)})`]; }
function captureError(fn: () => unknown): Error {
  try { fn(); } catch (err) { assert.ok(err instanceof Error); return err as Error; }
  return assert.fail('expected throw');
}

test('a tag recovers caller own dispatch with no id in hand', (t) => {
  const root = seedV3(t, echoing('mine'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, tag: 'worker-parse-header', userPathOptions: onHarness('standalone') });
  const rec = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-parse-header' });
  assert.equal(rec.bytes, 'mine');
  assert.equal(rec.attested, 'match');
  assert.equal(rec.resolvedBy, 'tag');
});

test('tag lands on evidence rows', (t) => {
  const root = seedV3(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, tag: 'worker-abc', userPathOptions: onHarness('standalone') });
  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => r.tag), ['worker-abc', 'worker-abc']);
});

test('an untagged dispatch stays untagged rather than carrying a null', (t) => {
  const root = seedV3(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: onHarness('standalone') });
  const first = JSON.parse(readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n')[0]!) as Record<string, unknown>;
  assert.ok(!('tag' in first));
});

test('the exact failure: two concurrent dispatches, both finished, and `last` refuses', (t) => {
  const root = seedV3(t, ['node', '-e', "setTimeout(()=>process.stdout.write('report'),150)"]);
  const together = new Date('2026-08-14T12:00:00.000Z');
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, tag: 'worker-a', now: together, userPathOptions: onHarness('standalone') });
  runDispatch({ archetype: 'reviewer', prompt: 'b', repoRoot: root, tag: 'reviewer-b', now: together, userPathOptions: onHarness('standalone') });
  const err = captureError(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'last' }));
  assert.ok(err instanceof DispatchesCommandError);
  assert.match(err.message, /ambiguous dispatch "last"/);
  assert.match(err.message, /ran concurrently/);
  assert.match(err.message, /worker-a/);
  assert.match(err.message, /reviewer-b/);
  assert.equal(runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-a' }).bytes, 'report');
  assert.equal(runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'reviewer-b' }).bytes, 'report');
});

test('`last` still answers when the dispatch genuinely ran alone', (t) => {
  const root = seedV3(t, echoing('only one'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, userPathOptions: onHarness('standalone') });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(result.bytes, 'only one');
  assert.equal(result.resolvedBy, 'recency');
});

test('`last` answers across dispatches that never overlapped', (t) => {
  const root = seedV3(t, echoing('second'));
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, now: new Date('2026-08-14T10:00:00.000Z'), userPathOptions: onHarness('standalone') });
  runDispatch({ archetype: 'worker', prompt: 'b', repoRoot: root, now: new Date('2026-08-14T18:00:00.000Z'), userPathOptions: onHarness('standalone') });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(result.resolvedBy, 'recency');
  assert.equal(result.bytes, 'second');
});

test('a reused tag is refused rather than resolved to the newest', (t) => {
  const root = seedV3(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, tag: 'same', userPathOptions: onHarness('standalone') });
  runDispatch({ archetype: 'worker', prompt: 'b', repoRoot: root, tag: 'same', userPathOptions: onHarness('standalone') });
  const err = captureError(() => runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'same' }));
  assert.ok(err instanceof DispatchesCommandError);
  assert.match(err.message, /ambiguous tag "same": 2 dispatches carry it/);
});

test('an unknown tag says which tags the log does hold', (t) => {
  const root = seedV3(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, tag: 'worker-real', userPathOptions: onHarness('standalone') });
  const err = captureError(() => runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-typo' }));
  assert.ok(err instanceof DispatchesCommandError);
  assert.match(err.message, /no dispatch carries the tag "worker-typo"/);
  assert.match(err.message, /worker-real/);
});

test('a malformed tag is refused at the kernel, before anything is spawned', (t) => {
  const root = seedV3(t, echoing('x'));
  for (const bad of ['worker-<slug>', 'has space', '-leading', 'a'.repeat(65)]) {
    assert.throws(() => runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, tag: bad, userPathOptions: onHarness('standalone') }), DispatchCommandError, `"${bad}" should not be usable`);
  }
  assert.throws(() => readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8'));
});

test('the spawn echo names the tag, and nags when there is none', (t) => {
  const root = seedV3(t, echoing('x'));
  const tagged: string[] = [];
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, tag: 'worker-t', onEcho: (line) => tagged.push(line), userPathOptions: onHarness('standalone') });
  const named = tagged.find((line) => line.startsWith('dispatch id:'));
  assert.match(named ?? '', /\(tag: worker-t\)/);
  assert.match(named ?? '', /--output tag:worker-t/);
  assert.doesNotMatch(named ?? '', /--output --tag/);
  assert.ok(!tagged.some((line) => line.includes('no --tag given')));
  const untagged: string[] = [];
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, onEcho: (line) => untagged.push(line), userPathOptions: onHarness('standalone') });
  assert.ok(untagged.some((line) => line.includes('no --tag given')));
});

test('a slow dispatch records when it ended, and the pair agrees with its duration', (t) => {
  const root = seedV3(t, ['node', '-e', "setTimeout(()=>process.stdout.write('slow'),400)"]);
  const at = new Date('2026-08-14T09:00:00.000Z');
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, now: at, tag: 'worker-slow', userPathOptions: onHarness('standalone') });
  const [requested, completed] = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) as [Record<string, unknown>, Record<string, unknown>];
  const start = Date.parse(requested.timestamp as string);
  const end = Date.parse(completed.timestamp as string);
  assert.equal(start, at.getTime());
  assert.ok(end > start);
  assert.ok(end - start >= 400, `400ms executor produced ${end-start}ms lifetime`);
  assert.equal(end - start, completed.duration_ms);
});

test('overlap detection still works on rows written before the stamp was fixed', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const legacy = (id: string, event: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ format: '1.0', timestamp: '2026-08-14T12:00:00.000Z', event, dispatch_id: id, archetype: 'worker', output_snapshot: `.fadeno/local/outputs/${id}.md`, ...extra });
  writeFileSync(join(root, '.fadeno', 'dispatches.jsonl'), [
    legacy('aaaaaaaa-1111-4000-8000-000000000001', 'dispatch_requested'),
    legacy('bbbbbbbb-2222-4000-8000-000000000002', 'dispatch_requested'),
    legacy('aaaaaaaa-1111-4000-8000-000000000001', 'dispatch_completed', { duration_ms: 9000, output_sha256: 'a'.repeat(64), output_bytes: 1 }),
    legacy('bbbbbbbb-2222-4000-8000-000000000002', 'dispatch_completed', { duration_ms: 9000, output_sha256: 'a'.repeat(64), output_bytes: 1 }),
  ].join('\n') + '\n');
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  for (const id of ['aaaaaaaa-1111-4000-8000-000000000001', 'bbbbbbbb-2222-4000-8000-000000000002']) {
    writeFileSync(join(root, '.fadeno', 'local', 'outputs', `${id}.md`), 'x');
  }
  const err = captureError(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'last' }));
  assert.match(err.message, /ran concurrently/);
});

test('waiting by tag settles on that dispatch and does not drift', (t) => {
  const root = seedV3(t, echoing('first'));
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, tag: 'worker-first', userPathOptions: onHarness('standalone') });
  runDispatch({ archetype: 'worker', prompt: 'b', repoRoot: root, tag: 'worker-second', userPathOptions: onHarness('standalone') });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-first', waitMs: 1000, pollMs: 100 });
  assert.equal(result.bytes, 'first');
  assert.equal(result.resolvedBy, 'tag');
});

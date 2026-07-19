import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LedgerWriteError, LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { tempRepo } from './helpers.ts';

function seedRunDir(root: string, runYaml: string): string {
  const dir = join(root, '.fadeno', 'runs', '2026-07-19-1200-writer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), runYaml, 'utf8');
  return dir;
}

const CURRENT_YAML = 'run_id: x\nschema_version: "0.2"\nplaybook: p\nstatus: running\ntask: t\nstarted_at: 2026-07-19T12:00:00Z\nhost: cli\n';

function events(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('seq is contiguous across sequential writer instances', (t) => {
  const root = tempRepo(t);
  const dir = seedRunDir(root, CURRENT_YAML);
  const now = new Date('2026-07-19T12:00:00Z');

  const first = new LedgerWriter(dir);
  assert.equal(first.nextSeq, 1);
  assert.equal(first.append({ type: 'run_started', step: null }, now), 1);
  assert.equal(first.append({ type: 'step_started', step: 'a' }, now), 2);

  // A fresh instance (a later CLI invocation) picks up where the file left off.
  const second = new LedgerWriter(dir);
  assert.equal(second.nextSeq, 3);
  assert.equal(second.append({ type: 'run_completed', step: null }, now), 3);

  assert.deepEqual(events(dir).map((e) => e.seq), [1, 2, 3]);
  assert.ok(events(dir).every((e) => e.timestamp === '2026-07-19T12:00:00.000Z'));
});

test('nextSeq peek matches the seq the next append receives', (t) => {
  const root = tempRepo(t);
  const dir = seedRunDir(root, CURRENT_YAML);
  const writer = new LedgerWriter(dir);
  writer.append({ type: 'run_started', step: null }, new Date());
  const peeked = writer.nextSeq;
  const used = writer.append({ type: 'artifact_created', step: null, artifact_id: `artifact-${peeked}` }, new Date());
  assert.equal(used, peeked);
});

test('a corrupt or seq-less line still occupies its position (line-count floor)', (t) => {
  const root = tempRepo(t);
  const dir = seedRunDir(root, CURRENT_YAML);
  appendFileSync(
    join(dir, 'events.jsonl'),
    '{"type":"run_started","step":null,"seq":1,"timestamp":"2026-07-19T12:00:00Z"}\n' +
      'not json at all\n' +
      '{"type":"step_started","step":"a","timestamp":"2026-07-19T12:01:00Z"}\n',
    'utf8',
  );
  const writer = new LedgerWriter(dir);
  // max seq is 1, but three non-empty lines exist — the floor wins.
  assert.equal(writer.nextSeq, 4);
});

test('the writer refuses legacy and unknown-version ledgers', (t) => {
  const root = tempRepo(t);
  const legacyDir = seedRunDir(root, CURRENT_YAML.replace('schema_version: "0.2"\n', ''));
  assert.throws(() => new LedgerWriter(legacyDir), LedgerWriteError);
  assert.throws(() => new LedgerWriter(legacyDir), /legacy ledger/);

  const futureDir = join(root, '.fadeno', 'runs', 'future');
  mkdirSync(futureDir, { recursive: true });
  writeFileSync(join(futureDir, 'run.yaml'), CURRENT_YAML.replace('"0.2"', '"9.9"'), 'utf8');
  assert.throws(() => new LedgerWriter(futureDir), /schema_version "9\.9"/);
});

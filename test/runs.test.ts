import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runRuns } from '../src/commands/runs.ts';
import { RunLedgerError, resolveRun } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

function writeRun(
  root: string,
  runId: string,
  yaml: string | null,
  opts: { skipYaml?: boolean } = {},
): string {
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  if (!opts.skipYaml && yaml !== null) {
    writeFileSync(join(dir, 'run.yaml'), yaml, 'utf8');
  }
  return dir;
}

const validYaml = (fields: Record<string, string | null>): string => {
  const lines = ['# yaml-language-server: $schema=../../schemas/run.schema.json'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) lines.push(`${k}: null`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  return `${lines.join('\n')}\n`;
};

test('listRuns orders by runId descending and returns both runs', (t) => {
  const root = tempRepo(t);
  writeRun(
    root,
    '2026-05-30-2029-older',
    validYaml({
      run_id: '2026-05-30-2029-older',
      playbook: 'code-change-review',
      status: 'completed',
      task: 'older task',
      started_at: '2026-05-30T20:29:07.790Z',
      host: 'cli',
    }),
  );
  writeRun(
    root,
    '2026-07-10-2212-newer',
    validYaml({
      run_id: '2026-07-10-2212-newer',
      playbook: 'code-change-review',
      status: 'running',
      task: 'newer task',
      started_at: '2026-07-11T02:12:32.797Z',
      host: 'cli',
    }),
  );

  const { runs } = runRuns({ repoRoot: root });
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.runId, '2026-07-10-2212-newer');
  assert.equal(runs[1]!.runId, '2026-05-30-2029-older');
  assert.equal(runs[0]!.status, 'running');
  assert.equal(runs[1]!.status, 'completed');
});

test('empty runs dir yields an empty list', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'runs'), { recursive: true });
  const { runs } = runRuns({ repoRoot: root });
  assert.deepEqual(runs, []);
});

test('missing .fadeno/runs yields an empty list', (t) => {
  const root = tempRepo(t);
  const { runs } = runRuns({ repoRoot: root });
  assert.deepEqual(runs, []);
});

test('unparseable run.yaml appears with problems', (t) => {
  const root = tempRepo(t);
  writeRun(root, '2026-01-01-0000-bad', ':\n  - this is not valid yaml: [[[\n');
  const { runs } = runRuns({ repoRoot: root });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runId, '2026-01-01-0000-bad');
  assert.equal(runs[0]!.playbook, null);
  assert.equal(runs[0]!.status, null);
  assert.ok(runs[0]!.problems.length >= 1);
  assert.match(runs[0]!.problems[0]!, /unparseable run\.yaml/);
});

test('directory without run.yaml is skipped', (t) => {
  const root = tempRepo(t);
  writeRun(
    root,
    '2026-07-10-2212-real',
    validYaml({
      run_id: '2026-07-10-2212-real',
      playbook: 'code-change-review',
      status: 'running',
      task: 'real',
      started_at: '2026-07-11T02:12:32.797Z',
      host: 'cli',
    }),
  );
  writeRun(root, 'not-a-run', null, { skipYaml: true });
  const { runs } = runRuns({ repoRoot: root });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runId, '2026-07-10-2212-real');
});

test('resolveRun supports exact, prefix, ambiguous, and missing', (t) => {
  const root = tempRepo(t);
  writeRun(
    root,
    '2026-07-10-2212-add-label-normalization',
    validYaml({
      run_id: '2026-07-10-2212-add-label-normalization',
      playbook: 'code-change-review',
      status: 'running',
      task: 'labels',
      started_at: '2026-07-11T02:12:32.797Z',
      host: 'cli',
    }),
  );
  writeRun(
    root,
    '2026-05-30-2029-add-a-slugify-str-utility-and-a-node-tes',
    validYaml({
      run_id: '2026-05-30-2029-add-a-slugify-str-utility-and-a-node-tes',
      playbook: 'small-code-change',
      status: 'completed',
      task: 'slugify',
      started_at: '2026-05-30T20:29:07.790Z',
      host: 'claude',
    }),
  );

  const exact = resolveRun(root, '2026-07-10-2212-add-label-normalization');
  assert.equal(exact.runId, '2026-07-10-2212-add-label-normalization');

  const prefix = resolveRun(root, '2026-07-10-2212');
  assert.equal(prefix.runId, '2026-07-10-2212-add-label-normalization');

  assert.throws(
    () => resolveRun(root, '2026'),
    (err: unknown) => {
      assert.ok(err instanceof RunLedgerError);
      assert.match(err.message, /Multiple runs match "2026"/);
      assert.match(err.message, /2026-07-10-2212-add-label-normalization/);
      assert.match(err.message, /2026-05-30-2029-add-a-slugify-str-utility-and-a-node-tes/);
      return true;
    },
  );

  assert.throws(
    () => resolveRun(root, 'no-such-run'),
    (err: unknown) => {
      assert.ok(err instanceof RunLedgerError);
      assert.equal(err.message, 'No run matching "no-such-run" under .fadeno/runs.');
      return true;
    },
  );
});

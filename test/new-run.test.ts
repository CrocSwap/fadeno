import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Ajv } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { runInit } from '../src/commands/init.ts';
import { NewRunError, runNewRun, slugify } from '../src/commands/new-run.ts';
import { exists, tempRepo } from './helpers.ts';

function initRepo(t: Parameters<typeof tempRepo>[0]): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  return root;
}

test('slugify produces filesystem-safe slugs', () => {
  assert.equal(slugify('Add CSV export for reports!'), 'add-csv-export-for-reports');
  assert.equal(slugify('   '), 'run');
  assert.equal(slugify('a'.repeat(80)).length, 40);
  assert.doesNotMatch(slugify('Trailing punctuation ...'), /-$/);
  // Truncation lands on a word boundary — never mid-word.
  const long = slugify('Create a Python module for converting to and from Roman numerals');
  assert.ok(long.length <= 40);
  assert.doesNotMatch(long, /-$/);
  // The break must coincide with a real word from the input, not a fragment.
  const words = 'create a python module for converting to and from roman numerals'.split(' ');
  assert.ok(words.includes(long.split('-').at(-1)!), `"${long}" ends mid-word`);
});

test('new-run writes a complete run ledger', (t) => {
  const root = initRepo(t);
  const now = new Date('2026-05-30T11:32:00.000Z');
  const { runId, runDir } = runNewRun({
    repoRoot: root,
    playbook: 'code-change-review',
    task: 'Add CSV export',
    now,
  });

  // The id uses local date/time (TZ-robust: derive the expectation the same way).
  const p = (n: number): string => String(n).padStart(2, '0');
  const expectedId =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}-add-csv-export`;
  assert.equal(runId, expectedId);
  assert.ok(exists(root, join('.fadeno', 'runs', runId, 'run.yaml')));
  assert.ok(exists(root, join('.fadeno', 'runs', runId, 'events.jsonl')));
  assert.ok(exists(root, join('.fadeno', 'runs', runId, 'artifacts', '.gitkeep')));

  const run = parseYaml(readFileSync(join(runDir, 'run.yaml'), 'utf8'));
  assert.equal(run.status, 'running');
  assert.equal(run.playbook, 'code-change-review');
  assert.equal(run.started_at, now.toISOString());
  assert.equal(run.schema_version, '0.2');

  const firstEvent = JSON.parse(readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim());
  assert.equal(firstEvent.type, 'run_started');
  assert.equal(firstEvent.seq, 1);
});

test('emitted run.yaml conforms to run.schema.json', (t) => {
  const root = initRepo(t);
  const { runDir } = runNewRun({ repoRoot: root, playbook: 'pr-review', task: 'check it' });

  const schema = JSON.parse(readFileSync(join(root, '.fadeno/schemas/run.schema.json'), 'utf8'));
  // logger:false silences the advisory "unknown format date-time" notice;
  // formats are documentation in v0 and not enforced by the dependency-light validator.
  const validate = new Ajv({ allErrors: true, strict: false, logger: false }).compile(schema);
  const run = parseYaml(readFileSync(join(runDir, 'run.yaml'), 'utf8'));
  assert.ok(validate(run), JSON.stringify(validate.errors));
});

test('new-run accepts a playbook name with a .yaml extension', (t) => {
  const root = initRepo(t);
  const { playbook } = runNewRun({
    repoRoot: root,
    playbook: 'research-synthesis.yaml',
    task: 'x',
  });
  assert.equal(playbook, 'research-synthesis');
});

test('new-run rejects an unknown playbook', (t) => {
  const root = initRepo(t);
  assert.throws(
    () => runNewRun({ repoRoot: root, playbook: 'does-not-exist', task: 'x' }),
    NewRunError,
  );
});

test('new-run requires an initialized .fadeno directory', (t) => {
  const root = tempRepo(t);
  assert.throws(
    () => runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'x' }),
    NewRunError,
  );
});

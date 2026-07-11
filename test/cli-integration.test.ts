import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { tempRepo } from './helpers.ts';

const BIN = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

function cli(root: string, args: string[]): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync(BIN, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function fresh(root: string): string {
  runInit({ target: 'codex', repoRoot: root });
  return runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'cli integration' }).runId;
}

test('built CLI gate exits 0 for pass and 1 for fail', (t) => {
  const root = tempRepo(t);
  const runId = fresh(root);
  const artifact = join(root, '.fadeno', 'runs', runId, 'artifacts', 'test-result.json');
  writeFileSync(artifact, JSON.stringify({ tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0, summary: 'ok' }));
  assert.equal(cli(root, ['gate', runId, 'tests_pass', '--artifact', 'artifacts/test-result.json']).status, 0);
  writeFileSync(artifact, JSON.stringify({ tool: 'test_runner', command: 'npm test', status: 'failed', exit_code: 1, summary: 'failed' }));
  assert.equal(cli(root, ['gate', runId, 'tests_pass', '--artifact', 'artifacts/test-result.json']).status, 1);
});

test('built CLI rejects invalid artifacts and path-dependent playbooks', (t) => {
  const root = tempRepo(t);
  const runId = fresh(root);
  const artifact = join(root, '.fadeno', 'runs', runId, 'artifacts', 'test-result.json');
  writeFileSync(artifact, JSON.stringify({ tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0 }));
  const invalid = cli(root, ['gate', runId, 'tests_pass']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.output, /invalid.*tests_pass/i);

  const playbook = [
    'kind: AgentPlaybook',
    'schema_version: "0.1"',
    'name: path-dependent',
    'description: path dependent',
    'roles:',
    '  c: {purpose: work}',
    'flow:',
    '  - id: start',
    '    kind: actor_call',
    '    actor: c',
    '    output: TestResult',
    '  - id: branch',
    '    kind: gate',
    '    input: [TestResult]',
    '    condition: tests_pass',
    '    on_pass: made',
    '    on_fail: skipped',
    '  - id: made',
    '    kind: actor_call',
    '    actor: c',
    '    output: Present',
    '    next: done',
    '  - id: skipped',
    '    kind: actor_call',
    '    actor: c',
    '    output: Other',
    '    next: done',
    '  - id: done',
    '    kind: actor_call',
    '    actor: c',
    '    input: [Present]',
    '    terminal_status: completed',
    '',
  ].join('\n');
  writeFileSync(join(root, '.fadeno', 'playbooks', 'path-dependent.yaml'), playbook);
  const validation = cli(root, ['validate', '.fadeno/playbooks/path-dependent.yaml']);
  assert.equal(validation.status, 1);
  assert.match(validation.output, /not definitely available|unreachable/i);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runPrompt } from '../src/commands/prompt.ts';
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

function cliSplit(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync(BIN, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const CROSS_REVIEW_EVENTS = [
  '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
  '{"type":"step_started","step":"draft_approaches","timestamp":"2026-07-12T21:21:10.416Z"}',
  '{"type":"artifact_created","step":"draft_approaches","artifact":"artifacts/approach-sol.md","timestamp":"2026-07-12T21:28:35.231Z"}',
  '{"type":"artifact_created","step":"draft_approaches","artifact":"artifacts/approach-fable.md","timestamp":"2026-07-12T21:31:15.350Z"}',
  '{"type":"step_started","step":"cross_review","timestamp":"2026-07-12T21:31:15.407Z"}',
  '',
].join('\n');

function seedCrossReview(root: string): string {
  runInit({ target: 'codex', repoRoot: root });
  const dogfood = join(import.meta.dirname, '..', 'docs', 'experimental', 'dual-architect-review.yaml');
  writeFileSync(join(root, '.fadeno', 'playbooks', 'dual-architect-review.yaml'), readFileSync(dogfood, 'utf8'));
  const runId = '2026-07-12-1718-design-and-build-fadeno-prompt';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    join(dir, 'run.yaml'),
    [
      `run_id: ${runId}`,
      'schema_version: "0.2"',
      'playbook: dual-architect-review',
      'status: running',
      'task: "Design and build fadeno prompt"',
      'started_at: 2026-07-12T21:18:58.647Z',
      'host: cli',
      'artifacts_dir: artifacts',
      'current_step: cross_review',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'artifacts', 'approach-fable.md'), '# Fable\n');
  writeFileSync(join(dir, 'artifacts', 'approach-sol.md'), '# Sol\n');
  writeFileSync(join(dir, 'events.jsonl'), CROSS_REVIEW_EVENTS);
  return runId;
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

test('built CLI prompt renders to stdout, errors cleanly, and emits stable JSON', (t) => {
  const root = tempRepo(t);
  const runId = seedCrossReview(root);

  // text: stdout is exactly the assembled prompt (+ the trailing console newline),
  // stderr empty, exit 0 — safe to pipe into `codex exec -`.
  const expected = runPrompt({ repoRoot: root, run: runId, step: 'cross_review', actor: 'architect_fable', record: false }).prompt;
  const text = cliSplit(root, ['prompt', runId, 'cross_review', '--actor', 'architect_fable', '--no-record']);
  assert.equal(text.status, 0);
  assert.equal(text.stderr, '');
  assert.equal(text.stdout, `${expected}\n`);

  // a failure keeps stdout empty and exits 1 so a pipeline never gets a partial prompt.
  const failure = cliSplit(root, ['prompt', runId, 'cross_review', '--no-record']);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /maps over roles; pass --actor/);

  // --format json: stable key order.
  const json = cliSplit(root, ['prompt', runId, 'cross_review', '--actor', 'architect_fable', '--no-record', '--format', 'json']);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(parsed), ['step', 'actor', 'iteration', 'invocation', 'recorded', 'prompt_path', 'sha256', 'prompt']);
  assert.equal(parsed.actor, 'architect_fable');
  assert.equal(parsed.recorded, 'preview');
});

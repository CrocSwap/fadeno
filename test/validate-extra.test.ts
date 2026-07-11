import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runValidate } from '../src/commands/validate.ts';
import { tempRepo } from './helpers.ts';

function initRepo(t: Parameters<typeof tempRepo>[0]): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  return root;
}

function write(root: string, rel: string, content: string): string {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

const HEADER = `kind: AgentPlaybook
schema_version: "0.1"
name: fixture
description: fixture
roles:
  c:
    purpose: do things
flow:
`;

// --- #1 semantic validation ---

test('shipped starter playbooks have zero issues (no warnings either)', (t) => {
  const root = initRepo(t);
  const outcome = runValidate({ repoRoot: root });
  const allIssues = outcome.results.flatMap((r) => r.issues);
  assert.deepEqual(allIssues, [], JSON.stringify(allIssues, null, 2));
});

test('actor not declared in roles is an error', (t) => {
  const root = initRepo(t);
  const file = write(
    root,
    '.fadeno/playbooks/bad.yaml',
    `${HEADER}  - {id: a, kind: actor_call, actor: nobody, output: R}\n`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(
    outcome.results[0]!.issues.some(
      (i) => i.severity === 'error' && /actor "nobody" is not a declared role/.test(i.message),
    ),
  );
});

test('unproduced input is an error because it is unavailable on the entry path', (t) => {
  const root = initRepo(t);
  const file = write(
    root,
    '.fadeno/playbooks/warn.yaml',
    `${HEADER}  - {id: a, kind: actor_call, actor: c, input: [Ghost], output: R}\n`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(
    outcome.results[0]!.issues.some(
      (i) => i.severity === 'error' && /input artifact "Ghost"/.test(i.message),
    ),
  );
});

test('declared-but-unused role is a warning', (t) => {
  const root = initRepo(t);
  const file = write(
    root,
    '.fadeno/playbooks/unused.yaml',
    `kind: AgentPlaybook
schema_version: "0.1"
name: unused
description: x
roles:
  c: {purpose: used}
  spare: {purpose: never used}
flow:
  - {id: a, kind: actor_call, actor: c, output: R}
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, true);
  assert.ok(
    outcome.results[0]!.issues.some(
      (i) => i.severity === 'warning' && /role "spare" is declared but never used/.test(i.message),
    ),
  );
});

// --- #3 validate run + review-report artifacts ---

test('validate auto-detects and checks a run.yaml', (t) => {
  const root = initRepo(t);
  const file = write(
    root,
    '.fadeno/runs/sample/run.yaml',
    `run_id: sample
playbook: code-change-review
status: running
task: x
started_at: 2026-05-30T11:32:00Z
host: cli
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.results[0]!.kind, 'run');
  assert.equal(outcome.ok, true);
});

test('validate flags a bad run status and a bad date-time', (t) => {
  const root = initRepo(t);
  const file = write(
    root,
    '.fadeno/runs/bad/run.yaml',
    `run_id: bad
playbook: p
status: nonsense
task: x
started_at: not-a-date
host: cli
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file, schema: 'run' });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results[0]!.issues.length >= 1);
});

test('validate auto-detects a review-report; rejects a malformed one', (t) => {
  const root = initRepo(t);
  const good = write(
    root,
    'good-report.json',
    JSON.stringify({
      reviewer: 'substance_reviewer',
      summary: 'ok',
      issues: [{ severity: 'minor', title: 'nit' }],
      verdict: 'approve',
    }),
  );
  const goodOutcome = runValidate({ repoRoot: root, path: good });
  assert.equal(goodOutcome.results[0]!.kind, 'review-report');
  assert.equal(goodOutcome.ok, true);

  const array = write(
    root,
    'good-reports.json',
    JSON.stringify([
      { reviewer: 'a', summary: 'ok', issues: [], verdict: 'approve' },
      { reviewer: 'b', summary: 'ok', issues: [], verdict: 'approve' },
    ]),
  );
  const arrayOutcome = runValidate({ repoRoot: root, path: array, schema: 'review-report' });
  assert.equal(arrayOutcome.ok, true);

  const bad = write(
    root,
    'bad-report.json',
    JSON.stringify({ reviewer: 'r', issues: [{ severity: 'oops', title: 't' }], verdict: 'nope' }),
  );
  const badOutcome = runValidate({ repoRoot: root, path: bad, schema: 'review-report' });
  assert.equal(badOutcome.ok, false);
});

function fixture(root: string, name: string, flow: string): string {
  return write(
    root,
    `.fadeno/playbooks/${name}.yaml`,
    `${HEADER}${flow}`,
  );
}

test('loop requires explicit success and exhaustion exits', (t) => {
  const root = initRepo(t);
  const missingSuccess = fixture(root, 'missing-success', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: loop
    kind: loop
    input: [TestResult]
    body: [body]
    max_iterations: 1
    until: tests_pass
    on_exhausted: done
  - id: body
    kind: actor_call
    actor: c
    output: TestResult
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const missingExhaustion = fixture(root, 'missing-exhaustion', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: loop
    kind: loop
    input: [TestResult]
    body: [body]
    max_iterations: 1
    until: tests_pass
    on_success: done
  - id: body
    kind: actor_call
    actor: c
    output: TestResult
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  assert.equal(runValidate({ repoRoot: root, path: missingSuccess }).ok, false);
  assert.equal(runValidate({ repoRoot: root, path: missingExhaustion }).ok, false);
});

test('loop references and ownership are statically checked', (t) => {
  const root = initRepo(t);
  const dangling = fixture(root, 'dangling-success', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: loop
    kind: loop
    input: [TestResult]
    body: [body]
    max_iterations: 1
    until: tests_pass
    on_success: nowhere
    on_exhausted: done
  - id: body
    kind: actor_call
    actor: c
    output: TestResult
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const recursive = fixture(root, 'recursive-loop', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: loop
    kind: loop
    input: [TestResult]
    body: [loop]
    max_iterations: 1
    until: tests_pass
    on_success: done
    on_exhausted: done
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const shared = fixture(root, 'shared-body', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: first
    kind: loop
    input: [TestResult]
    body: [body]
    max_iterations: 1
    until: tests_pass
    on_success: second
    on_exhausted: second
  - id: second
    kind: loop
    input: [TestResult]
    body: [body]
    max_iterations: 1
    until: tests_pass
    on_success: done
    on_exhausted: done
  - id: body
    kind: actor_call
    actor: c
    output: TestResult
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  assert.ok(runValidate({ repoRoot: root, path: dangling }).results[0]!.issues.some((i) => /undefined step "nowhere"/.test(i.message)));
  assert.ok(runValidate({ repoRoot: root, path: recursive }).results[0]!.issues.some((i) => /recursively/.test(i.message)));
  assert.ok(runValidate({ repoRoot: root, path: shared }).results[0]!.issues.some((i) => /multiple loops/.test(i.message)));
});

test('reachability and definite artifacts follow branches, not YAML position', (t) => {
  const root = initRepo(t);
  const file = fixture(root, 'path-dependent', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: branch
    kind: gate
    input: [TestResult]
    condition: tests_pass
    on_pass: made
    on_fail: skipped
  - id: made
    kind: actor_call
    actor: c
    output: Present
    next: merge
  - id: skipped
    kind: actor_call
    actor: c
    output: Other
    next: merge
  - id: merge
    kind: actor_call
    actor: c
    input: [Present]
    output: Done
    terminal_status: completed
  - id: orphan
    kind: actor_call
    actor: c
    output: Never
    terminal_status: completed
`);
  const result = runValidate({ repoRoot: root, path: file });
  assert.equal(result.ok, false);
  assert.ok(result.results[0]!.issues.some((i) => /not definitely available|unreachable/.test(i.message)));
});

test('condition names and artifact bindings are validated', (t) => {
  const root = initRepo(t);
  const unsupported = fixture(root, 'unsupported', `  - id: start
    kind: actor_call
    actor: c
    output: ReviewReport
  - id: gate
    kind: gate
    input: [ReviewReport]
    condition: no_such_condition
    on_pass: done
    on_fail: done
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const wrong = fixture(root, 'wrong-binding', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: gate
    kind: gate
    input: [TestResult]
    condition: no_blocking_issues
    on_pass: done
    on_fail: done
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const unavailable = fixture(root, 'unavailable-gate', `  - id: gate
    kind: gate
    input: [ReviewReport]
    condition: no_blocking_issues
    on_pass: done
    on_fail: done
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  assert.ok(runValidate({ repoRoot: root, path: unsupported }).results[0]!.issues.some((i) => /unsupported condition/.test(i.message)));
  assert.ok(runValidate({ repoRoot: root, path: wrong }).results[0]!.issues.some((i) => /accepts ReviewReport/.test(i.message)));
  assert.ok(runValidate({ repoRoot: root, path: unavailable }).results[0]!.issues.some((i) => /not definitely available/.test(i.message)));
});

test('terminal_status is rejected on a step with an outgoing edge', (t) => {
  const root = initRepo(t);
  const file = fixture(root, 'bad-terminal', `  - id: start
    kind: actor_call
    actor: c
    next: done
    terminal_status: failed
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const result = runValidate({ repoRoot: root, path: file });
  assert.equal(result.ok, false);
  assert.ok(result.results[0]!.issues.some((i) => /terminal_status/.test(i.message)));
});

test('loop-body steps reject explicit control flow and gate conditions', (t) => {
  const root = initRepo(t);
  const file = fixture(root, 'nonlinear-body', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: loop
    kind: loop
    input: [TestResult]
    body: [body]
    max_iterations: 1
    until: tests_pass
    on_success: done
    on_exhausted: done
  - id: body
    kind: actor_call
    actor: c
    input: [TestResult]
    output: TestResult
    condition: tests_pass
    next: done
    on_pass: done
    on_fail: done
    on_approve: done
    on_reject: done
    on_success: done
    on_exhausted: done
    routes:
      branch: done
    default: done
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const issues = runValidate({ repoRoot: root, path: file }).results[0]!.issues;
  for (const field of ['next', 'on_pass', 'on_fail', 'on_approve', 'on_reject', 'on_success', 'on_exhausted', 'routes', 'default']) {
    assert.ok(issues.some((issue) => issue.path.includes(`(id "body")/${field}`)), `missing ${field} diagnostic`);
  }
  assert.ok(issues.some((issue) => /gates? or declare a condition|loop bodies are linear/.test(issue.message)));
});

test('nested loops are rejected inside Milestone 1 loop bodies', (t) => {
  const root = initRepo(t);
  const file = fixture(root, 'nested-body-loop', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: outer
    kind: loop
    input: [TestResult]
    body: [inner]
    max_iterations: 1
    until: tests_pass
    on_success: done
    on_exhausted: done
  - id: inner
    kind: loop
    input: [TestResult]
    body: [inner_step]
    max_iterations: 1
    until: tests_pass
    on_success: done
    on_exhausted: done
  - id: inner_step
    kind: actor_call
    actor: c
    output: TestResult
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const issues = runValidate({ repoRoot: root, path: file }).results[0]!.issues;
  assert.ok(issues.some((issue) => /nested loop/.test(issue.message)), JSON.stringify(issues));
});

test('terminal_status remains forbidden on loop-body steps', (t) => {
  const root = initRepo(t);
  const file = fixture(root, 'terminal-body', `  - id: start
    kind: actor_call
    actor: c
    output: TestResult
  - id: loop
    kind: loop
    input: [TestResult]
    body: [body]
    max_iterations: 1
    until: tests_pass
    on_success: done
    on_exhausted: done
  - id: body
    kind: actor_call
    actor: c
    input: [TestResult]
    output: TestResult
    terminal_status: failed
  - id: done
    kind: actor_call
    actor: c
    terminal_status: completed
`);
  const issues = runValidate({ repoRoot: root, path: file }).results[0]!.issues;
  assert.ok(issues.some((issue) => /terminal_status is not allowed on a loop-body step/.test(issue.message)), JSON.stringify(issues));
});

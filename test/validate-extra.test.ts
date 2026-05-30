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

test('unproduced input is a warning, not a failure', (t) => {
  const root = initRepo(t);
  const file = write(
    root,
    '.fadeno/playbooks/warn.yaml',
    `${HEADER}  - {id: a, kind: actor_call, actor: c, input: [Ghost], output: R}\n`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, true); // warnings do not fail
  assert.ok(
    outcome.results[0]!.issues.some(
      (i) => i.severity === 'warning' && /input artifact "Ghost"/.test(i.message),
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

  const bad = write(
    root,
    'bad-report.json',
    JSON.stringify({ reviewer: 'r', issues: [{ severity: 'oops', title: 't' }], verdict: 'nope' }),
  );
  const badOutcome = runValidate({ repoRoot: root, path: bad, schema: 'review-report' });
  assert.equal(badOutcome.ok, false);
});

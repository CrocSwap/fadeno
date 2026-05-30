import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runValidate, ValidateError } from '../src/commands/validate.ts';
import { tempRepo } from './helpers.ts';

function initRepo(t: Parameters<typeof tempRepo>[0]): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  return root;
}

function writePlaybook(root: string, name: string, content: string): string {
  const file = join(root, '.fadeno', 'playbooks', name);
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

test('the shipped starter playbooks all validate', (t) => {
  const root = initRepo(t);
  const outcome = runValidate({ repoRoot: root });
  assert.ok(outcome.ok, JSON.stringify(outcome.results, null, 2));
  assert.equal(outcome.results.length, 3);
});

test('malformed YAML is reported', (t) => {
  const root = initRepo(t);
  const file = writePlaybook(root, 'bad.yaml', 'kind: AgentPlaybook\n  : : :\n bad indent');
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.match(outcome.results[0]!.issues[0]!.message, /invalid YAML/i);
});

test('schema violation: gate missing on_fail', (t) => {
  const root = initRepo(t);
  const file = writePlaybook(
    root,
    'bad.yaml',
    `${HEADER}  - id: g
    kind: gate
    condition: ok
    on_pass: g
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results[0]!.issues.some((i) => /on_fail/.test(i.message)));
});

test('schema violation: unknown property is rejected', (t) => {
  const root = initRepo(t);
  const file = writePlaybook(
    root,
    'bad.yaml',
    `${HEADER}  - id: a
    kind: actor_call
    actor: c
    bogus_field: 1
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results[0]!.issues.some((i) => /unknown property "bogus_field"/.test(i.message)));
});

test('schema violation: invalid kind', (t) => {
  const root = initRepo(t);
  const file = writePlaybook(
    root,
    'bad.yaml',
    `${HEADER}  - id: a
    kind: teleport
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
});

test('reference integrity: dangling on_pass target is caught', (t) => {
  const root = initRepo(t);
  const file = writePlaybook(
    root,
    'dangling.yaml',
    `${HEADER}  - id: g
    kind: gate
    condition: ok
    on_pass: nowhere
    on_fail: g
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(
    outcome.results[0]!.issues.some((i) => /undefined step "nowhere"/.test(i.message)),
    JSON.stringify(outcome.results[0]!.issues),
  );
});

test('reference integrity: dangling loop body target is caught', (t) => {
  const root = initRepo(t);
  const file = writePlaybook(
    root,
    'loop.yaml',
    `${HEADER}  - id: l
    kind: loop
    max_iterations: 2
    body:
      - ghost
    on_exhausted: l
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results[0]!.issues.some((i) => /undefined step "ghost"/.test(i.message)));
});

test('reference integrity: duplicate step id is caught', (t) => {
  const root = initRepo(t);
  const file = writePlaybook(
    root,
    'dupe.yaml',
    `${HEADER}  - id: a
    kind: actor_call
    actor: c
  - id: a
    kind: actor_call
    actor: c
`,
  );
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results[0]!.issues.some((i) => /duplicate step id/.test(i.message)));
});

test('validate throws a helpful error when no schema is present', (t) => {
  const root = tempRepo(t); // not initialized
  assert.throws(() => runValidate({ repoRoot: root }), ValidateError);
});

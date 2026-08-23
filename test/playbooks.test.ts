import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PlaybooksError, runPlaybooks } from '../src/commands/playbooks.ts';
import { tempRepo } from './helpers.ts';

const BIN = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

function fixture(name: string, description = 'A project workflow.'): string {
  return [
    'kind: AgentPlaybook',
    'schema_version: "0.1"',
    `name: ${name}`,
    `description: ${description}`,
    'when_to_use:',
    '  - project-specific work',
    'roles:',
    '  worker:',
    '    purpose: Do the work.',
    'flow:',
    '  - id: work',
    '    kind: actor_call',
    '    actor: worker',
    '    output: Result',
    '    terminal_status: completed',
    '',
  ].join('\n');
}

function writePlaybook(root: string, name: string, content: string, extension = '.yaml'): void {
  const dir = join(root, '.fadeno', 'playbooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${extension}`), content);
}

function cli(root: string, args: string[]): string {
  return execFileSync(BIN, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

test('playbooks lists effective bundled definitions with typed metadata', (t) => {
  const root = tempRepo(t);
  const result = runPlaybooks({ repoRoot: root });
  assert.equal(result.kind, 'list');
  const codeReview = result.playbooks.find((playbook) => playbook.name === 'code-change-review');
  assert.ok(codeReview);
  assert.equal(codeReview.source, 'builtin');
  assert.equal(codeReview.description, 'Plan, implement, review, test, and run a bounded revision loop for nontrivial code changes.');
  assert.doesNotMatch(codeReview.description, /\n/);
  assert.deepEqual(codeReview.when_to_use, ['nontrivial code change', 'multiple files may be touched', 'correctness matters', 'tests or review are useful']);
  assert.match(codeReview.path, /templates\/common\/fadeno\/playbooks\/code-change-review\.yaml$/);
});

test('playbooks project definitions shadow bundled names and add effective names', (t) => {
  const root = tempRepo(t);
  writePlaybook(root, 'code-change-review', fixture('code-change-review', 'The local replacement.'));
  writePlaybook(root, 'project-flow', fixture('project-flow'));

  const result = runPlaybooks({ repoRoot: root });
  assert.equal(result.kind, 'list');
  const overridden = result.playbooks.find((playbook) => playbook.name === 'code-change-review');
  assert.ok(overridden);
  assert.equal(overridden.source, 'project');
  assert.equal(overridden.description, 'The local replacement.');
  assert.deepEqual(result.playbooks.map((playbook) => playbook.name), [...result.playbooks.map((playbook) => playbook.name)].sort());
  assert.equal(result.playbooks.find((playbook) => playbook.name === 'project-flow')?.source, 'project');
});

test('playbooks resolves every project extension before bundled definitions and prefers project yaml deterministically', (t) => {
  const root = tempRepo(t);
  writePlaybook(root, 'code-change-review', fixture('code-change-review', 'The project yml override.'), '.yml');

  let result = runPlaybooks({ repoRoot: root, playbook: 'code-change-review' });
  assert.equal(result.kind, 'detail');
  assert.equal(result.playbook.source, 'project');
  assert.equal(result.playbook.description, 'The project yml override.');
  assert.match(result.playbook.path, /code-change-review\.yml$/);

  writePlaybook(root, 'code-change-review', fixture('code-change-review', 'The project yaml override.'));
  result = runPlaybooks({ repoRoot: root, playbook: 'code-change-review' });
  assert.equal(result.kind, 'detail');
  assert.equal(result.playbook.description, 'The project yaml override.');
  assert.match(result.playbook.path, /code-change-review\.yaml$/);
});

test('playbooks detail renders the effective workflow through the shared diagram renderer', (t) => {
  const root = tempRepo(t);
  writePlaybook(root, 'code-change-review', fixture('code-change-review', 'The local replacement.'));

  const result = runPlaybooks({ repoRoot: root, playbook: 'code-change-review' });
  assert.equal(result.kind, 'detail');
  assert.equal(result.playbook.source, 'project');
  assert.match(result.diagram, /entry: work/);
  assert.match(result.diagram, /┌─ work .* actor ─┐/);
});

test('playbooks refuses a malformed effective project override instead of falling back', (t) => {
  const root = tempRepo(t);
  writePlaybook(root, 'code-change-review', 'description: broken\nflow: not-a-list\n');

  assert.throws(() => runPlaybooks({ repoRoot: root }), (err: unknown) => {
    assert.ok(err instanceof PlaybooksError);
    assert.match(err.message, /Effective playbook .*code-change-review\.yaml cannot be displayed: missing a flow list/);
    return true;
  });
  assert.throws(() => runPlaybooks({ repoRoot: root, playbook: 'code-change-review' }), PlaybooksError);
});

test('playbooks normalizes multiline when_to_use cues in structured data', (t) => {
  const root = tempRepo(t);
  writePlaybook(root, 'project-flow', fixture('project-flow').replace('  - project-specific work', '  - >\n    project-specific\n    work'));

  const result = runPlaybooks({ repoRoot: root, playbook: 'project-flow' });
  assert.equal(result.kind, 'detail');
  assert.deepEqual(result.playbook.when_to_use, ['project-specific work']);
});

test('bundled CLI serves playbooks list/detail, JSON, and help', (t) => {
  const root = tempRepo(t);
  writePlaybook(root, 'project-flow', fixture('project-flow'));

  const list = cli(root, ['playbooks']);
  assert.match(list, /effective playbooks:/);
  assert.match(list, /project-flow  \[project\]/);
  const detail = cli(root, ['playbooks', 'project-flow']);
  assert.match(detail, /workflow/);
  assert.match(detail, /entry: work/);
  const json = JSON.parse(cli(root, ['playbooks', 'project-flow', '--json'])) as { kind: string; playbook: { source: string } };
  assert.equal(json.kind, 'detail');
  assert.equal(json.playbook.source, 'project');
  assert.match(cli(root, ['playbooks', '--help']), /effective bundled and project workflows/);
});

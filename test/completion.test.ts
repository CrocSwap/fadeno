import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCompletion, runCompletionCandidates } from '../src/commands/completion.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { starterPlaybooks, tempRepo } from './helpers.ts';

function complete(root: string, words: string[], cword = words.length - 1): string[] {
  return runCompletionCandidates({ cwd: root, repoRoot: root, cword, words });
}

test('completion script is sourceable Bash and covers commands/options', () => {
  const script = runCompletion();
  assert.match(script, /complete -F _fadeno_complete fadeno/);
  assert.match(script, /completion candidates/);
  execFileSync('bash', ['-n'], { input: script });

  assert.deepEqual(complete('/tmp', ['fadeno', '-']), ['--help', '--version', '-h', '-v']);
  assert.deepEqual(complete('/tmp', ['fadeno', '--']), ['--help', '--version']);
  assert.ok(complete('/tmp', ['fadeno', 'd']).includes('diagram'));
  assert.deepEqual(complete('/tmp', ['fadeno', 'dial', '']), ['clear', 'clear-shadow', 'resolve', 'shadow']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'steering', '']), ['apply', 'resolve']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'validate', '--schema', '']), [
    'playbook',
    'review-report',
    'run',
    'test-result',
  ]);
  assert.deepEqual(complete('/tmp', ['fadeno', 'diagram', '--format=']), ['--format=ascii', '--format=mermaid']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'gate', 'run', '']), ['no_blocking_issues', 'tests_pass']);
  // new flags: --via, --model, --user, --repo exist; old --executor gone
  assert.ok(complete('/tmp', ['fadeno', 'dial', 'shadow', '--']).includes('--via'));
  assert.ok(complete('/tmp', ['fadeno', 'dispatch', '--']).includes('--model'));
  assert.ok(complete('/tmp', ['fadeno', 'dispatch', '--']).includes('--via'));
});

test('completion discovers repo-local playbooks, runs, steps, and paths', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // v3 model catalog
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    [
      'schema_version: 3',
      'models:',
      '  alpha:',
      '    provider: openai',
      '    id: alpha',
      '  beta:',
      '    provider: openai',
      '    id: beta',
      'routes:',
      '  standalone:',
      '    openai:',
      '      command: [alpha]',
      '      write_access: true',
      'archetypes:',
      '  worker: {}',
      '  reviewer: {}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, '.fadeno', 'playbooks', 'zeta.yaml'), readFileSync(join(root, '.fadeno', 'playbooks', 'code-change-review.yaml'), 'utf8'));
  mkdirSync(join(root, 'folder'), { recursive: true });
  writeFileSync(join(root, 'folder', 'file with spaces.txt'), 'x');
  const runId = runNewRun({ repoRoot: root, playbook: 'zeta', task: 'completion test' }).runId;

  // Exact match, not a superset check: every starter plus the repo-local `zeta`, sorted.
  assert.deepEqual(complete(root, ['fadeno', 'diagram', '']), [...starterPlaybooks(), 'zeta'].sort());
  assert.ok(complete(root, ['fadeno', 'show', '']).includes(runId));
  // dial no longer has use/list; subcommands are dial vocabulary
  assert.ok(!complete(root, ['fadeno', 'dial', '']).includes('use'));
  assert.ok(!complete(root, ['fadeno', 'dial', '']).includes('list'));
  // archetype completions currently empty for v3 – just ensure no crash
  assert.deepEqual(complete(root, ['fadeno', 'dispatch', '--archetype', '']), []);
  assert.ok(complete(root, ['fadeno', 'dispatch', '--prompt-file', 'folder/']).includes('folder/file with spaces.txt'));

  const malformed = join(root, '.fadeno', 'executors.yaml');
  writeFileSync(malformed, 'not: [valid');
  assert.deepEqual(complete(root, ['fadeno', 'dispatch', '--model', '']), []);
  assert.deepEqual(complete(root, ['fadeno', 'prompt', 'ambiguous-prefix', '']), []);
});

test('completion: dial flags replace old flags', (t) => {
  const root = tempRepo(t);
  // no profile needed for flag completion
  assert.ok(complete(root, ['fadeno', 'dial', 'worker', '--']).includes('--user'));
  assert.ok(complete(root, ['fadeno', 'dial', 'worker', '--']).includes('--repo'));
  assert.ok(complete(root, ['fadeno', 'dial', 'clear', '--']).includes('--user'));
  assert.ok(complete(root, ['fadeno', 'dial', 'clear', '--']).includes('--repo'));
  assert.ok(complete(root, ['fadeno', 'dispatch', '--']).includes('--archetype'));
  assert.ok(complete(root, ['fadeno', 'dispatch', '--']).includes('--role'));
  // old flags gone
  assert.ok(!complete(root, ['fadeno', 'dispatch', '--']).includes('--executor'));
  assert.ok(!complete(root, ['fadeno', 'dispatch', '--']).includes('--loadout'));
});

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
  assert.deepEqual(complete('/tmp', ['fadeno', 'loadout', '']), ['clear', 'list', 'set', 'use']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'steering', '']), ['apply', 'resolve']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'validate', '--schema', '']), [
    'playbook',
    'review-report',
    'run',
    'test-result',
  ]);
  assert.deepEqual(complete('/tmp', ['fadeno', 'diagram', '--format=']), ['--format=ascii', '--format=mermaid']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'gate', 'run', '']), ['no_blocking_issues', 'tests_pass']);
});

test('completion discovers repo-local playbooks, runs, steps, profiles, and paths', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    [
      'executors:',
      '  alpha:',
      '    adapter: command',
      '    command: [alpha]',
      '  beta:',
      '    adapter: command',
      '    command: [beta]',
      'loadouts:',
      '  sample:',
      '    worker: alpha',
      '    reviewer: beta',
      'default_loadout: sample',
      'bindings:',
      '  "*": alpha',
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
  assert.ok(complete(root, ['fadeno', 'loadout', 'use', '']).includes('sample'));
  // `set <archetype> <executor>`; `clear` completes the archetype it may drop.
  assert.deepEqual(complete(root, ['fadeno', 'loadout', 'set', '']), ['reviewer', 'worker']);
  assert.deepEqual(complete(root, ['fadeno', 'loadout', 'set', 'worker', '']), ['alpha', 'beta']);
  assert.deepEqual(complete(root, ['fadeno', 'loadout', 'clear', '']), ['reviewer', 'worker']);
  assert.ok(complete(root, ['fadeno', 'steering', 'apply', '']).includes('sample'));
  assert.deepEqual(complete(root, ['fadeno', 'steering', 'resolve', '--host-executor', '']), ['alpha', 'beta']);
  assert.ok(complete(root, ['fadeno', 'steering', 'resolve', '--run', '']).includes(runId));
  assert.deepEqual(complete(root, ['fadeno', 'steering', 'resolve', '--dispatch-id', 'abc']), []);
  assert.deepEqual(complete(root, ['fadeno', 'dispatch', '--executor', '']), ['alpha', 'beta']);
  assert.deepEqual(complete(root, ['fadeno', 'dispatch', '--archetype', '']), ['reviewer', 'worker']);
  assert.deepEqual(complete(root, ['fadeno', 'drive', runId, '--bind', '']), []);
  assert.deepEqual(complete(root, ['fadeno', 'drive', runId, '--bind', 'worker=']), ['worker=alpha', 'worker=beta']);
  assert.ok(complete(root, ['fadeno', 'prompt', runId, '']).includes('plan'));
  assert.ok(complete(root, ['fadeno', 'dispatch', '--prompt-file', 'folder/']).includes('folder/file with spaces.txt'));

  const malformed = join(root, '.fadeno', 'executors.yaml');
  writeFileSync(malformed, 'not: [valid');
  assert.deepEqual(complete(root, ['fadeno', 'dispatch', '--executor', '']), []);
  assert.deepEqual(complete(root, ['fadeno', 'prompt', 'ambiguous-prefix', '']), []);
});

import assert from 'node:assert/strict';
import { SCHEMA_KINDS } from '../src/lib/playbook-validate.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCompletion, runCompletionCandidates } from '../src/commands/completion.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { userPaths } from '../src/lib/user-paths.ts';
import { catalogV4, starterPlaybooks, tempRepo } from './helpers.ts';

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
  assert.ok(complete('/tmp', ['fadeno', 'p']).includes('playbooks'));
  assert.deepEqual(complete('/tmp', ['fadeno', 'dial', '']), ['clear', 'clear-shadow', 'resolve', 'shadow']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'steering', '']), ['apply', 'resolve']);
  // Derived, not restated: this list was a sixth copy of the schema-kind
  // vocabulary, and a literal here would have to be edited in lockstep with
  // the registry forever — which is exactly how `model-comparison` came to be
  // known to the registry and rejected by `--schema`.
  assert.deepEqual(complete('/tmp', ['fadeno', 'validate', '--schema', '']), [...SCHEMA_KINDS].sort());
  assert.deepEqual(complete('/tmp', ['fadeno', 'diagram', '--format=']), ['--format=ascii', '--format=mermaid']);
  assert.deepEqual(complete('/tmp', ['fadeno', 'gate', 'run', '']), ['all_reviews_approved', 'no_blocking_issues', 'tests_pass']);
  // new flags: --via, --model, --session, --user, --repo exist; old --executor gone
  assert.ok(complete('/tmp', ['fadeno', 'dial', 'shadow', '--']).includes('--harness'));
  assert.ok(complete('/tmp', ['fadeno', 'dial', 'shadow', '--']).includes('--n'));
  assert.ok(complete('/tmp', ['fadeno', 'dispatch', '--']).includes('--model'));
  assert.ok(complete('/tmp', ['fadeno', 'dispatch', '--']).includes('--harness'));
});

test('completion discovers repo-local playbooks, runs, steps, and paths', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // v3 model catalog
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    [
      'schema_version: 4',
      'models:',
      '  alpha:',
      '    provider: openai',
      '    id: alpha',
      '  beta:',
      '    provider: openai',
      '    id: beta',
      'harnesses:',
      '  codex:',
      '    provider: openai',
      '    command: [alpha]',
      '    ',
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
  assert.deepEqual(complete(root, ['fadeno', 'playbooks', '']), [...starterPlaybooks(), 'zeta'].sort());
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
  assert.ok(complete(root, ['fadeno', 'dial', 'worker', '--']).includes('--session'));
  assert.ok(complete(root, ['fadeno', 'dial', 'clear', '--']).includes('--user'));
  assert.ok(complete(root, ['fadeno', 'dial', 'clear', '--']).includes('--repo'));
  assert.ok(complete(root, ['fadeno', 'dial', 'clear', '--']).includes('--session'));
  assert.ok(complete(root, ['fadeno', 'dispatch', '--']).includes('--archetype'));
  assert.ok(complete(root, ['fadeno', 'dispatch', '--']).includes('--role'));
  // old flags gone
  assert.ok(!complete(root, ['fadeno', 'dispatch', '--']).includes('--executor'));
  assert.ok(!complete(root, ['fadeno', 'dispatch', '--']).includes('--loadout'));
});

test('completion scopes host dispatch ids to pending requests in the selected run', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const created = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'dispatch completion' });
  const writer = new LedgerWriter(created.runDir);
  writer.append({ type: 'host_dispatch_requested', step: 'implement', dispatch_id: 'pending-a' }, new Date());
  writer.append({ type: 'host_dispatch_requested', step: 'review', dispatch_id: 'finished-b' }, new Date());
  writer.append({ type: 'actor_completed', step: 'review', dispatch_id: 'finished-b' }, new Date());

  assert.deepEqual(complete(root, ['fadeno', 'dispatch-prompt', created.runId, '']), ['pending-a']);
  assert.deepEqual(complete(root, ['fadeno', 'dispatch-start', created.runId, 'pending']), ['pending-a']);
  assert.deepEqual(complete(root, ['fadeno', 'dispatch-complete', created.runId, '']), ['pending-a']);
  assert.deepEqual(complete(root, ['fadeno', 'dispatch-fail', created.runId, '']), ['pending-a']);
  assert.deepEqual(complete(root, ['fadeno', 'dispatch-complete', created.runId, 'pending-a', '--output', '-']), ['-']);
});

test('completion: model remove offers user-catalog aliases, models verify offers dialed refs and keeps taking them', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({
    models: {
      alpha: { provider: 'openai', id: 'alpha-id', effort: 'default' },
      projectonly: { provider: 'openai', id: 'project-id', effort: 'default' },
    },
    harnesses: { codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'], models_command: ['codex-models'] } },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'alpha', reviewer: 'personal' },
    unregistered_model_harness: 'codex',
  }));
  // `tempRepo` redirects HOME and the FADENO_*_HOME variables, so this is the
  // user catalog both the command and the completion will actually read.
  const catalogPath = userPaths().executorsFile;
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, ['schema_version: 4', 'models:', '  personal:', '    provider: openai', '    id: personal-id', '    effort: default', ''].join('\n'));

  // `remove` edits the user catalog and refuses everything else by name, so
  // the merged registry (which is what the general `executor` kind answers
  // with) is the wrong list: it proposed `current-host` and every project and
  // builtin alias, none of which the command will accept.
  for (const spelling of ['model', 'models']) {
    assert.deepEqual(complete(root, ['fadeno', spelling, 'remove', '']), ['personal']);
    assert.deepEqual(complete(root, ['fadeno', spelling, 'remove', 'per']), ['personal']);
  }

  // `verify` narrows against the DIALED table, and accepts an alias, a
  // delivered id, the canonical id, or `provider/id`.
  const refs = complete(root, ['fadeno', 'models', 'verify', '']);
  assert.deepEqual(refs, ['alpha', 'alpha-id', 'openai/alpha-id', 'openai/personal-id', 'personal', 'personal-id']);
  assert.ok(!refs.includes('projectonly'), 'a registered but undialed model is not a verify target');
  assert.ok(!refs.includes('current-host'));

  // `[<ref>...]` is variadic. Two declared slots meant the third argument
  // completed as flags — the completion announcing the command was done
  // taking refs while it was still happy to take them.
  assert.deepEqual(complete(root, ['fadeno', 'models', 'verify', 'alpha', 'personal', '']), refs);
  assert.deepEqual(complete(root, ['fadeno', 'model', 'verify', 'alpha', 'personal', 'alpha-id', '']), refs);
  // Flags still complete when one is being typed.
  assert.ok(complete(root, ['fadeno', 'models', 'verify', 'alpha', 'personal', '--']).includes('--strict'));
});

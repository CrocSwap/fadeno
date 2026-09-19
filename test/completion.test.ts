import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCompletion, runCompletionCandidates } from '../src/commands/completion.ts';
import { userPaths } from '../src/lib/user-paths.ts';
import { catalogV4, tempRepo } from './helpers.ts';

function complete(root: string, words: string[], cword = words.length - 1): string[] {
  return runCompletionCandidates({ cwd: root, repoRoot: root, cword, words });
}

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
  assert.ok(complete(root, ['fadeno', 'dispatch', '--']).includes('--name'));
  assert.ok(complete(root, ['fadeno', 'dispatch', '']).includes('run'));
  assert.ok(complete(root, ['fadeno', 'dispatch', 'run', '--']).includes('--archetype'));
  assert.ok(complete(root, ['fadeno', 'dispatch', 'run', '--']).includes('--model'));
  // old flags gone
  assert.ok(!complete(root, ['fadeno', 'dispatch', '--']).includes('--executor'));
  assert.ok(!complete(root, ['fadeno', 'dispatch', '--']).includes('--loadout'));
});

test('completion: dispatch selectors include effective archetypes and registered model references', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({
    models: { echo: { provider: 'openai', id: 'echo-model', effort: 'default' } },
    harnesses: { codex: { provider: 'openai', command: ['codex', '--model', '{model}'] } },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'echo' },
  }));
  const selectors = complete(root, ['fadeno', 'dispatch', 'run', '']);
  assert.ok(selectors.includes('worker'));
  assert.ok(selectors.includes('reviewer'));
  assert.ok(selectors.includes('echo'));
  assert.ok(selectors.includes('echo-model'));
  assert.ok(selectors.includes('openai/echo-model'));
});

test('completion: model remove offers user-catalog aliases, models verify offers registry refs and keeps taking them', (t) => {
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
  // with) is the wrong list: it proposed `host` and every project and
  // builtin alias, none of which the command will accept.
  for (const spelling of ['model', 'models']) {
    assert.deepEqual(complete(root, ['fadeno', spelling, 'remove', '']), ['personal']);
    assert.deepEqual(complete(root, ['fadeno', spelling, 'remove', 'per']), ['personal']);
  }

  // `verify` accepts a merged-registry alias, a delivered id, the canonical
  // id, or `provider/id`, whether or not an archetype currently dials it.
  const refs = complete(root, ['fadeno', 'models', 'verify', '']);
  assert.deepEqual(refs, [
    'alpha', 'alpha-id', 'openai/alpha-id', 'openai/personal-id', 'openai/project-id',
    'personal', 'personal-id', 'project-id', 'projectonly',
  ]);
  assert.ok(refs.includes('projectonly'), 'a registered but undialed model is a verify target');
  assert.ok(!refs.includes('host'));

  // `[<ref>...]` is variadic. Two declared slots meant the third argument
  // completed as flags — the completion announcing the command was done
  // taking refs while it was still happy to take them.
  assert.deepEqual(complete(root, ['fadeno', 'models', 'verify', 'alpha', 'personal', '']), refs);
  assert.deepEqual(complete(root, ['fadeno', 'model', 'verify', 'alpha', 'personal', 'alpha-id', '']), refs);
  // Flags still complete when one is being typed.
  assert.ok(complete(root, ['fadeno', 'models', 'verify', 'alpha', 'personal', '--']).includes('--strict'));
});

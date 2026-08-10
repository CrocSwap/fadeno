import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { read, tempRepo } from './helpers.ts';

/**
 * `.fadeno/local/` is per-machine session state (sticky loadout, prompt
 * relays) and must never be committed — init scaffolds the gitignore entry
 * (spec: docs/experimental/loadouts-and-dispatch.md §Resolution).
 */

function countLines(content: string, line: string): number {
  return content.split(/\r?\n/).filter((l) => l.trim() === line).length;
}

test('init scaffolds a .fadeno/local/ gitignore entry on a fresh repo', (t) => {
  const root = tempRepo(t);
  const { results } = runInit({ target: 'codex', repoRoot: root });

  const gitignore = read(root, '.gitignore');
  assert.match(gitignore, /^\.fadeno\/local\/$/m);
  // Sits alongside the existing progress entry, under one Fadeno comment block.
  assert.match(gitignore, /^\.fadeno\/progress\/$/m);
  assert.match(gitignore, /# Fadeno: local generated files \(not committed\)/);

  // The clean-scaffold contract holds: one created .gitignore, no appends.
  const gitignoreResults = results.filter((r) => r.path.endsWith('.gitignore'));
  assert.equal(gitignoreResults.length, 1);
  assert.equal(gitignoreResults[0]!.status, 'created');
});

test('re-running init never duplicates the ignore entries', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const first = read(root, '.gitignore');

  const { results } = runInit({ target: 'codex', repoRoot: root });
  const second = read(root, '.gitignore');

  assert.equal(second, first, 'a second init must leave .gitignore byte-identical');
  assert.equal(countLines(second, '.fadeno/local/'), 1);
  assert.equal(countLines(second, '.fadeno/progress/'), 1);
  assert.ok(
    results.every((r) => !r.path.endsWith('.gitignore')),
    'a second init emits no .gitignore result',
  );
});

test('init appends to an existing .gitignore without touching user content', (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n*.log\n');

  const { results } = runInit({ target: 'codex', repoRoot: root });

  const gitignore = read(root, '.gitignore');
  assert.ok(gitignore.startsWith('node_modules/\n*.log\n'), 'user entries stay first and intact');
  assert.match(gitignore, /^\.fadeno\/local\/$/m);
  const gitignoreResults = results.filter((r) => r.path.endsWith('.gitignore'));
  assert.equal(gitignoreResults.length, 1);
  assert.equal(gitignoreResults[0]!.status, 'appended');
});

test('a repo already ignoring .fadeno/ entirely gets no redundant entry', (t) => {
  const root = tempRepo(t);
  writeFileSync(join(root, '.gitignore'), '.fadeno/\n');

  runInit({ target: 'codex', repoRoot: root });

  const gitignore = read(root, '.gitignore');
  assert.doesNotMatch(gitignore, /^\.fadeno\/local\/$/m);
  assert.doesNotMatch(gitignore, /^\.fadeno\/progress\/$/m);
});

test('a repo scaffolded before .fadeno/local/ existed gains only the missing entry', (t) => {
  const root = tempRepo(t);
  // Simulate an older init: the progress entry is present, local/ is not.
  writeFileSync(
    join(root, '.gitignore'),
    '# Fadeno: local generated files (not committed)\n.fadeno/progress/\n',
  );

  runInit({ target: 'codex', repoRoot: root });

  const gitignore = read(root, '.gitignore');
  assert.equal(countLines(gitignore, '.fadeno/progress/'), 1);
  assert.equal(countLines(gitignore, '.fadeno/local/'), 1);
});

test('the entry ships in the data-only (plugin) flow and for every target', (t) => {
  const dataRoot = tempRepo(t);
  runInit({ target: 'claude', repoRoot: dataRoot, dataOnly: true });
  assert.match(read(dataRoot, '.gitignore'), /^\.fadeno\/local\/$/m);

  const grokRoot = tempRepo(t);
  runInit({ target: 'grok', repoRoot: grokRoot });
  assert.match(read(grokRoot, '.gitignore'), /^\.fadeno\/local\/$/m);

  // The scaffold ignores the directory; it does not create it (session state
  // appears only when `fadeno loadout use` or a dispatch first writes it).
  assert.ok(!existsSync(join(grokRoot, '.fadeno', 'local')));
});

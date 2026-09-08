import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hostVocabulary, workerContract } from '../src/lib/contracts.ts';
import { PREAMBLE_FILE, PREAMBLE_MAX_CHARS, readPreamble } from '../src/lib/preamble.ts';
import { prepareDispatch } from '../src/lib/spawn.ts';
import { catalogV4, git, gitRepo } from './helpers.ts';

/**
 * `.fadeno/preamble.md` — what this repository tells every dispatch.
 *
 * A director named prompt precision as its biggest recurring cost and its most
 * expensive single mistake: it left an absolute path out of one brief and the
 * worker wrote its receipts into a disposable tree. Conventions that never
 * change do not belong in a brief that a person has to remember to write.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

const WORKTREE = { kind: 'worktree', absolute: '/tmp/wt', branch: 'fadeno/x', base: 'a'.repeat(40), upstream: 'main' } as const;

function repo(t: TestContext, preamble?: string): string {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({ archetypes: { worker: {} }, dials: { worker: 'sol' } }));
  if (preamble != null) writeFileSync(join(root, PREAMBLE_FILE), preamble);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  return root;
}

test('a missing, empty or unreadable preamble is simply absent — never a failed spawn', (t) => {
  const root = repo(t);
  const none = readPreamble(root);
  assert.equal(none.exists, false);
  assert.equal(none.text, null);
  assert.equal(none.path, PREAMBLE_FILE);

  writeFileSync(join(root, PREAMBLE_FILE), '   \n\n');
  assert.equal(readPreamble(root).exists, false, 'whitespace is not a convention');

  const contract = workerContract({ id: 'i', name: 'n', archetype: 'worker', repoRoot: root, worktree: WORKTREE, preamble: readPreamble(root) });
  assert.ok(!contract.includes('**This repository.**'), 'nothing is injected, not an empty heading');
});

test('the preamble rides on every dispatched prompt, under a heading of its own', (t) => {
  const text = 'Run python with `uv run`, never bare `python3`.\nReceipts go to `/srv/receipts`, an absolute path.';
  const root = repo(t, text);
  const contract = workerContract({ id: 'i', name: 'n', archetype: 'worker', repoRoot: root, worktree: WORKTREE, preamble: readPreamble(root) });
  assert.match(contract, /\*\*This repository\.\*\*/);
  assert.ok(contract.includes(text));

  // Placement: repository facts sit with the other environmental facts, and
  // ahead of the rules about what the worker owns and what it must report.
  assert.ok(contract.indexOf('**Where to work.**') < contract.indexOf('**This repository.**'));
  assert.ok(contract.indexOf('**This repository.**') < contract.indexOf('**Your final message.**'));
});

test('over the cap it is cut, says so, and names the absolute path so the agent can read the rest', (t) => {
  const long = `first line\n${'x'.repeat(PREAMBLE_MAX_CHARS * 2)}`;
  const root = repo(t, long);
  const preamble = readPreamble(root);
  assert.equal(preamble.truncated, true);
  assert.equal(preamble.chars, long.length);
  assert.ok(preamble.text!.length <= PREAMBLE_MAX_CHARS);

  const contract = workerContract({ id: 'i', name: 'n', archetype: 'worker', repoRoot: root, worktree: WORKTREE, preamble });
  assert.match(contract, new RegExp(`Cut at \\d+ of ${long.length} characters`));
  assert.ok(contract.includes(`${root}/${PREAMBLE_FILE}`), 'an absolute path, because the agent can go and read it');
});

test('prepareDispatch reads it, so both lanes carry it without either one remembering to', (t) => {
  const root = repo(t, 'Never edit `generated/`; it is rebuilt by `make gen`.');
  const outcome = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'do the thing', lane: 'command' });
  assert.ok(outcome.ok);
  assert.ok(outcome.ok && outcome.prepared.composedPrompt.includes('Never edit `generated/`'));
  assert.ok(outcome.ok && outcome.prepared.composedPrompt.indexOf('do the thing') === 0, 'the task still leads');
});

test('the host is told the file exists and not to repeat it — and told to start one when it does not', (t) => {
  const archetypes = [{ name: 'worker', description: 'd', model: 'sol', effort: null, source: 'base' }];
  const without = hostVocabulary({ archetypes, unclosed: [], unclosedLimit: 5, preamble: readPreamble(repo(t)) });
  assert.match(without, /belong in `\.fadeno\/preamble\.md`/);
  assert.doesNotMatch(without, /This repository states conventions/);

  const with_ = hostVocabulary({ archetypes, unclosed: [], unclosedLimit: 5, preamble: readPreamble(repo(t, 'use uv')) });
  assert.match(with_, /This repository states conventions for every dispatch in `\.fadeno\/preamble\.md`/);
  assert.match(with_, /Do not repeat them in a brief/);
});

test('`fadeno context` reports it, so a host can see what its dispatches already carry', (t) => {
  const root = repo(t, 'Build with `make`, never `npm run build`.');
  const run = spawnSync(process.execPath, [CLI, 'context', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { preamble: { exists: boolean; chars: number; path: string } };
  assert.equal(parsed.preamble.exists, true);
  assert.equal(parsed.preamble.path, PREAMBLE_FILE);
  assert.ok(parsed.preamble.chars > 0);
});

test('a brief with one impossible clause is not a blocked brief: the contract says to do the rest', (t) => {
  const contract = workerContract({ id: 'i', name: 'n', archetype: 'worker', repoRoot: repo(t), worktree: WORKTREE });
  assert.match(contract, /\*\*If part of it is impossible\.\*\*/);
  assert.match(contract, /Do every part that is not, and say in your report exactly which part you left out and why/);
  assert.match(contract, /Scaling the work down is your caller's decision/);
});

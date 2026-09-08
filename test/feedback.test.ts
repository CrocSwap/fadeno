import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runFeedbackAdd, runFeedbackRead, FeedbackError, FEEDBACK_FILE } from '../src/commands/feedback.ts';
import { runClean } from '../src/commands/dispatches.ts';
import { appendRow } from '../src/lib/ledger.ts';
import { catalogV4, tempRepo } from './helpers.ts';

/**
 * `.fadeno/feedback.md` — the channel from the agents using Fadeno to the
 * people changing it.
 *
 * It was a convention in one repository's docs before it was a command, which
 * is how a host that hit five frictions in an afternoon reported them only in
 * chat: nothing in what Fadeno tells a host ever named the file.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const AT = new Date('2026-09-08T04:00:00.123Z');

function repo(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({ archetypes: { worker: {} } }));
  return root;
}

const env = (root: string) => ({
  ...process.env,
  FADENO_CONFIG_HOME: join(root, 'cfg'),
  FADENO_STATE_HOME: join(root, 'state'),
  FADENO_HARNESS: 'claude',
  HOME: join(root, 'home'),
});

test('an entry carries when, which harness and which Fadeno, and the file explains itself', (t) => {
  const root = repo(t);
  const added = runFeedbackAdd({
    repoRoot: root,
    userPathOptions: { env: { FADENO_HARNESS: 'codex' } },
    text: '  The nag counted running dispatches.  ',
    now: AT,
  });
  assert.equal(added.at, '2026-09-08T04:00:00Z');
  assert.equal(added.harness, 'codex');
  assert.equal(added.text, 'The nag counted running dispatches.', 'trimmed');
  assert.equal(added.total, 1);
  assert.equal(added.path, join(root, FEEDBACK_FILE));

  const text = readFileSync(added.path, 'utf8');
  // A file a maintainer opens cold says what it is and how to add to it.
  assert.match(text, /^# Fadeno feedback\n/);
  assert.match(text, /Append with `fadeno feedback "<what happened>"`/);
  assert.match(text, /^## 2026-09-08T04:00:00Z · codex · fadeno \d+\.\d+\.\d+$/m);
  assert.match(text, /^The nag counted running dispatches\.$/m);

  // Append-only: a second entry leaves the first exactly as it was.
  const second = runFeedbackAdd({ repoRoot: root, text: 'And the refusal named an action I could not take.', now: AT });
  assert.equal(second.total, 2);
  const after = readFileSync(added.path, 'utf8');
  assert.ok(after.startsWith(text), 'the earlier entry is untouched');
  assert.equal((after.match(/^# Fadeno feedback/gm) ?? []).length, 1, 'the header is written once');
});

test('a dispatch ref ties the entry to the run, and a ref that names nothing is refused', (t) => {
  const root = repo(t);
  appendRow(root, {
    row: 'opened', id: '11111111-2222-3333-4444-555555555555', name: 'fix-login', at: AT.toISOString(), session: null,
    parent: null, archetype: 'worker', model: 'sol', effort: null, explicit_model: null, lane: 'host', harness: 'codex',
    workspace: null, task: 'x', prompt: 'p',
  });
  const added = runFeedbackAdd({ repoRoot: root, text: 'Its report came back partial.', dispatch: 'fix-login', now: AT });
  assert.deepEqual(added.dispatch, { id: '11111111-2222-3333-4444-555555555555', name: 'fix-login' });
  assert.match(readFileSync(added.path, 'utf8'), /· dispatch fix-login \(11111111-2222-3333-4444-555555555555\)$/m);

  // Dropping an unknown ref would lose the one identifier tying the entry to a
  // run, so it is refused with the ledger's own message.
  assert.throws(
    () => runFeedbackAdd({ repoRoot: root, text: 'x', dispatch: 'no-such-thing', now: AT }),
    (err: unknown) => err instanceof FeedbackError && /no dispatch "no-such-thing"/.test((err as Error).message),
  );
  // And an empty entry says what to pass instead of writing a blank heading.
  assert.throws(
    () => runFeedbackAdd({ repoRoot: root, text: '   ', now: AT }),
    (err: unknown) => err instanceof FeedbackError && /nothing to record/.test((err as Error).message),
  );
});

test('reading answers with the file, and with nothing when there is none', (t) => {
  const root = repo(t);
  const empty = runFeedbackRead({ repoRoot: root });
  assert.equal(empty.exists, false);
  assert.equal(empty.text, null);
  assert.equal(empty.entries, 0);

  runFeedbackAdd({ repoRoot: root, text: 'one', now: AT });
  runFeedbackAdd({ repoRoot: root, text: 'two', now: AT });
  const read = runFeedbackRead({ repoRoot: root });
  assert.equal(read.exists, true);
  assert.equal(read.entries, 2);
  assert.match(read.text ?? '', /^one$/m);
});

test('`fadeno clean` never takes it: this is a record, not scratch', (t) => {
  const root = repo(t);
  const added = runFeedbackAdd({ repoRoot: root, text: 'kept', now: AT });
  runClean({ repoRoot: root, force: true });
  assert.ok(existsSync(added.path), 'clean removes machine-local scratch, and this is not that');
  assert.match(readFileSync(added.path, 'utf8'), /^kept$/m);
});

test('the CLI records with one argument and prints the file with none', (t) => {
  const root = repo(t);
  const run = (args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env: env(root), encoding: 'utf8' });

  assert.match(run(['feedback']), /no feedback recorded — `fadeno feedback "<what happened>"` starts /);
  assert.match(run(['feedback', 'The activation block quoted dials that had moved.']), /recorded in .*feedback\.md \(1 entry\)\./);
  assert.match(run(['feedback', 'A second one.']), /\(2 entries\)\./);

  const shown = run(['feedback']);
  assert.match(shown, /The activation block quoted dials that had moved\./);
  assert.match(shown, /· claude · fadeno /, 'the harness this ran under is recorded, not guessed at read time');

  const json = JSON.parse(run(['feedback', '--json'])) as { entries: number; exists: boolean };
  assert.equal(json.entries, 2);
  assert.equal(json.exists, true);
});

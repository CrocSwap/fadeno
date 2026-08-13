import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, runDispatch } from '../src/commands/dispatch.ts';
import { DispatchesCommandError, runDispatchesOutput } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/** `assert.throws` returns nothing, and these tests assert on the message. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error);
    return err;
  }
  return assert.fail('expected a throw');
}

/**
 * Caller-chosen recovery handles.
 *
 * The kernel echoes a `dispatch id` at spawn, but that echo goes to stderr and
 * a Bash call killed at its own timeout takes the stream with it — so the one
 * caller who needs the id is the one guaranteed not to receive it. That left
 * `--output last`, which cannot distinguish one finished dispatch from
 * another: a 2026-08-14 dogfood recovered a concurrent proxy's report and very
 * nearly relayed it as its own. A tag is known before the spawn because the
 * caller chose it, so it survives losing every byte the dispatch printed.
 */

function seedExecutor(t: TestContext, command: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      executors: { probe: { adapter: 'command', command, model: 'opus' } },
      loadouts: { main: { worker: 'probe', reviewer: 'probe' } },
      default_loadout: 'main',
    }),
  );
  return root;
}

/** An executor whose report names itself, so a mix-up is visible in the bytes. */
function echoing(text: string): string[] {
  return ['node', '-e', `process.stdout.write(${JSON.stringify(text)})`];
}

test('a tag recovers the caller’s own dispatch with no id in hand', (t) => {
  const root = seedExecutor(t, echoing('mine'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null, tag: 'worker-parse-header' });

  // The caller names only what it chose — never having seen the kernel's echo.
  const recovered = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-parse-header' });
  assert.equal(recovered.bytes, 'mine');
  assert.equal(recovered.attested, 'match');
  assert.equal(recovered.resolvedBy, 'tag');
});

test('the tag lands on the evidence rows so the log is greppable by handle', (t) => {
  const root = seedExecutor(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null, tag: 'worker-abc' });
  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(rows.map((row) => row.tag), ['worker-abc', 'worker-abc']);
});

test('an untagged dispatch stays untagged rather than carrying a null', (t) => {
  // Absent is not a claim: a row from a caller that chose no handle should not
  // look like a row whose handle failed to record.
  const root = seedExecutor(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null });
  const first = JSON.parse(
    readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n')[0]!,
  ) as Record<string, unknown>;
  assert.ok(!('tag' in first));
});

test('the exact failure: two concurrent dispatches, both finished, and `last` refuses', (t) => {
  // The dogfooded shape. Both proxies time out, both executors finish, and the
  // ledger holds two completed dispatches with nothing open. `last` used to
  // hand back whichever was newest — which is the other agent's report half
  // the time. It now refuses, and names the candidates.
  // Both launched at the same instant and each takes a measurable moment, so
  // their lifetimes genuinely overlap — two proxies dispatching at once, which
  // is how the real one happened. The clock is injected; the durations are real.
  const root = seedExecutor(t, ['node', '-e', "setTimeout(()=>process.stdout.write('report'),150)"]);
  const together = new Date('2026-08-14T12:00:00.000Z');
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, env: null, tag: 'worker-a', now: together });
  runDispatch({ archetype: 'reviewer', prompt: 'b', repoRoot: root, env: null, tag: 'reviewer-b', now: together });

  const err = captureError(() => runDispatchesOutput({ repoRoot: root, dispatchId: 'last' }));
  assert.ok(err instanceof DispatchesCommandError);
  assert.match(err.message, /ambiguous dispatch "last"/);
  assert.match(err.message, /ran concurrently/);
  // The refusal has to be actionable, so it names both handles.
  assert.match(err.message, /worker-a/);
  assert.match(err.message, /reviewer-b/);

  // And each caller still recovers its own, which is the point of refusing.
  assert.equal(runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-a' }).bytes, 'report');
  assert.equal(runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'reviewer-b' }).bytes, 'report');
});

test('`last` still answers when the dispatch genuinely ran alone', (t) => {
  // The refusal must not swallow the common case: one dispatch, no ambiguity,
  // recency is simply correct.
  const root = seedExecutor(t, echoing('only one'));
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(result.bytes, 'only one');
  assert.equal(result.resolvedBy, 'recency');
});

test('`last` answers across dispatches that never overlapped', (t) => {
  // Sequential dispatches in a long-lived repo are not ambiguous — the earlier
  // one had finished before the later one began, so nobody is waiting on it.
  const root = seedExecutor(t, echoing('second'));
  runDispatch({
    archetype: 'worker', prompt: 'a', repoRoot: root, env: null,
    now: new Date('2026-08-14T10:00:00.000Z'),
  });
  runDispatch({
    archetype: 'worker', prompt: 'b', repoRoot: root, env: null,
    now: new Date('2026-08-14T18:00:00.000Z'),
  });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(result.resolvedBy, 'recency');
  assert.equal(result.bytes, 'second');
});

test('a reused tag is refused rather than resolved to the newest', (t) => {
  // Nothing stops two callers picking the same handle. Silently answering with
  // the newest would rebuild the exact bug this replaced.
  const root = seedExecutor(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, env: null, tag: 'same' });
  runDispatch({ archetype: 'worker', prompt: 'b', repoRoot: root, env: null, tag: 'same' });
  const err = captureError(() => runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'same' }));
  assert.ok(err instanceof DispatchesCommandError);
  assert.match(err.message, /ambiguous tag "same": 2 dispatches carry it/);
});

test('an unknown tag says which tags the log does hold', (t) => {
  const root = seedExecutor(t, echoing('x'));
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, env: null, tag: 'worker-real' });
  const err = captureError(() => runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-typo' }));
  assert.ok(err instanceof DispatchesCommandError);
  assert.match(err.message, /no dispatch carries the tag "worker-typo"/);
  assert.match(err.message, /worker-real/);
});

test('a malformed tag is refused at the kernel, before anything is spawned', (t) => {
  const root = seedExecutor(t, echoing('x'));
  for (const bad of ['worker-<slug>', 'has space', '-leading', 'a'.repeat(65)]) {
    assert.throws(
      () => runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null, tag: bad }),
      DispatchCommandError,
      `"${bad}" should not be a usable handle`,
    );
  }
  // No spawn happened, so no evidence row claims one did.
  assert.throws(() => readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8'));
});

test('the spawn echo names the tag, and nags when there is none', (t) => {
  const root = seedExecutor(t, echoing('x'));
  const tagged: string[] = [];
  runDispatch({
    archetype: 'worker', prompt: 'x', repoRoot: root, env: null, tag: 'worker-t',
    onEcho: (line) => tagged.push(line),
  });
  const named = tagged.find((line) => line.startsWith('dispatch id:'));
  assert.match(named ?? '', /\(tag: worker-t\)/);
  // The echoed recovery command must be one that actually parses: `--output`
  // takes a value, so `--output --tag worker-t` would swallow the flag.
  assert.match(named ?? '', /--output tag:worker-t/);
  assert.doesNotMatch(named ?? '', /--output --tag/);
  assert.ok(!tagged.some((line) => line.includes('no --tag given')));

  const untagged: string[] = [];
  runDispatch({
    archetype: 'worker', prompt: 'x', repoRoot: root, env: null,
    onEcho: (line) => untagged.push(line),
  });
  // Warned at spawn, which is the only moment the caller can still act on it.
  assert.ok(untagged.some((line) => line.includes('no --tag given')));
});

test('waiting by tag settles on that dispatch and does not drift', (t) => {
  const root = seedExecutor(t, echoing('first'));
  runDispatch({ archetype: 'worker', prompt: 'a', repoRoot: root, env: null, tag: 'worker-first' });
  runDispatch({ archetype: 'worker', prompt: 'b', repoRoot: root, env: null, tag: 'worker-second' });
  const result = runDispatchesOutput({
    repoRoot: root, dispatchId: '', tag: 'worker-first', waitMs: 1_000, pollMs: 100,
  });
  assert.equal(result.bytes, 'first');
  assert.equal(result.resolvedBy, 'tag');
});

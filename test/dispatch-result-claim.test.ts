import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DISPATCHES_FILE,
  DISPATCH_PROGRESS_FOOTER,
  DISPATCH_RESULT_FOOTER,
  deriveDispatchOutcome,
  runDispatch,
  scanDispatchResultClaim,
} from '../src/commands/dispatch.ts';
import { runDispatches, runDispatchesOutput } from '../src/commands/dispatches.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { echoedStdin, tempRepo } from './helpers.ts';

// The outcome-claim channel (the result footer). A dispatched worker that
// writes an "I failed" report and exits 0 used to classify as `ok`,
// content-blind; the footer gives the executor a deterministic byte channel
// the kernel parses, and exit 0 can no longer launder a reported failure.

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

function seedCatalog(t: TestContext, command: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { worker: { provider: 'openai', id: 'worker-1' } },
    harnesses: { codex: { provider: 'openai', command: command } },
    archetypes: { worker: {} },
    dials: { worker: 'worker' },
  }));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, DISPATCHES_FILE), 'utf8')
    .split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const REPORTER = (body: string): string[] => ['node', '-e', `process.stdout.write(${JSON.stringify(body)})`];

// --- scanner units ---------------------------------------------------------

test('scanDispatchResultClaim: strict, case-sensitive, last match wins', () => {
  assert.equal(scanDispatchResultClaim('FADENO-DISPATCH-RESULT: ok'), 'ok');
  assert.equal(scanDispatchResultClaim('FADENO-DISPATCH-RESULT: failed — model unavailable'), 'failed');
  // last-wins is the determinism rule when output contains several matches
  assert.equal(
    scanDispatchResultClaim('FADENO-DISPATCH-RESULT: failed — early doubt\nwork continued\nFADENO-DISPATCH-RESULT: ok'),
    'ok',
  );
  assert.equal(
    scanDispatchResultClaim('FADENO-DISPATCH-RESULT: ok\nFADENO-DISPATCH-RESULT: failed — actually no'),
    'failed',
  );
  // No well-formed claim ⇒ null (legacy derivation applies)
  assert.equal(scanDispatchResultClaim('all done, ship it'), null);
  assert.equal(scanDispatchResultClaim(''), null);
  // Near-misses are not claims: case, trailing prose, and missing reason dash
  assert.equal(scanDispatchResultClaim('fadeno-dispatch-result: ok'), null);
  assert.equal(scanDispatchResultClaim('FADENO-DISPATCH-RESULT: OK'), null);
  assert.equal(scanDispatchResultClaim('FADENO-DISPATCH-RESULT: ok (done)'), null);
  // A bare `failed` with no reason is still well-formed (the reason is
  // optional in the grammar).
  assert.equal(scanDispatchResultClaim('FADENO-DISPATCH-RESULT: failed'), 'failed');
  // The footer's own example lines are wrapped in prose/backticks: echoing the
  // footer verbatim is not a claim.
  assert.equal(scanDispatchResultClaim(DISPATCH_RESULT_FOOTER), null);
});

test('deriveDispatchOutcome: a claim decides the exit-0 case; everything else outranks it', () => {
  // THE fix: exit 0 can no longer launder a reported failure.
  assert.equal(
    deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: 356 }, 'failed'),
    'failed',
  );
  assert.equal(deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: 12 }, 'ok'), 'ok');
  // No claim ⇒ exactly today's derivation.
  assert.equal(deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: 12 }), 'ok');
  assert.equal(deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: 0 }), 'empty');
  assert.equal(deriveDispatchOutcome({ exitCode: 1, signal: null, outputBytes: 5 }), 'failed');
  assert.equal(deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: null }), null);
  // Timeout and spawn failure outrank any claim.
  assert.equal(deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: 10, timedOut: true }, 'ok'), 'timeout');
  assert.equal(deriveDispatchOutcome({ exitCode: null, signal: 'SIGTERM', outputBytes: 10 }, 'ok'), 'failed');
});

// --- footer bytes ----------------------------------------------------------

test('the result footer is a fixed constant appended to every prompt, so digests stay stable across identical dispatches', (t) => {
  const root = seedCatalog(t, REPORTER('fine'));
  const first = runDispatch({ archetype: 'worker', prompt: 'same task', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
  const second = runDispatch({ archetype: 'worker', prompt: 'same task', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root).filter((r) => r.event === 'dispatch_requested') as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  // Identical prompts ⇒ identical composed bytes ⇒ identical digests: this is
  // what keeps shadow-pair arms byte-identical to each other.
  assert.equal(rows[0]!.prompt_sha256, rows[1]!.prompt_sha256);
  assert.notEqual(rows[0]!.prompt_sha256, sha256Hex('same task'));
  const expectedComposed = echoedStdin('same task');
  assert.equal(rows[0]!.prompt_sha256, sha256Hex(expectedComposed));
  for (const row of rows) {
    const snapshot = readFileSync(join(root, row.prompt_snapshot as string), 'utf8');
    assert.equal(snapshot, expectedComposed);
    assert.ok(snapshot.endsWith(DISPATCH_PROGRESS_FOOTER));
  }
  void first; void second;
});

// --- end-to-end classification --------------------------------------------

test('a worker that reports failure at exit 0 is classified failed', (t) => {
  const root = seedCatalog(t, REPORTER('I could not finish the task\nFADENO-DISPATCH-RESULT: failed — tests would not pass'));
  const result = runDispatch({ archetype: 'worker', prompt: 'p', tag: 'worker-claims-failed', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, 'failed');
  const completed = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal(completed.outcome, 'failed');
  assert.equal(completed.exit_code, 0);
});

test('a claimed ok is classified ok, and no claim leaves the legacy derivation untouched', (t) => {
  {
    const root = seedCatalog(t, REPORTER('done\nFADENO-DISPATCH-RESULT: ok'));
    const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
    assert.equal(result.outcome, 'ok');
    assert.equal(evidenceRows(root).find((r) => r.event === 'dispatch_completed')!.outcome, 'ok');
  }
  {
    // Exit 0 with bytes but no claim line ⇒ ok exactly as before.
    const root = seedCatalog(t, REPORTER('plain report'));
    const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
    assert.equal(result.outcome, 'ok');
  }
  {
    // Exit 0 with zero bytes ⇒ empty exactly as before.
    const root = seedCatalog(t, REPORTER(''));
    const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
    assert.equal(result.outcome, 'empty');
  }
});

test('rendering tells the truth about a claimed failure at exit 0', (t) => {
  const root = seedCatalog(t, REPORTER('nope\nFADENO-DISPATCH-RESULT: failed — could not build'));
  runDispatch({ archetype: 'worker', prompt: 'p', tag: 'worker-render-failed', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
  const listing = runDispatches({ repoRoot: root });
  const line = listing.lines.find((l) => l.includes('FAILED'))!;
  assert.ok(line, 'the FAILED verdict leads');
  assert.match(line, /\[claimed failed despite exit 0\]/);
  // And the recovery reader says it too, rather than "exit 0" reading as fine.
  const rec = runDispatchesOutput({ repoRoot: root, dispatchId: '', tag: 'worker-render-failed' });
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.exitCode, 0);

  // An honest ok at exit 0 earns neither the FAILED mark nor the bracket.
  const okRoot = seedCatalog(t, REPORTER(`fine\nFADENO-DISPATCH-RESULT: ok`));
  runDispatch({ archetype: 'worker', prompt: 'p', tag: 'worker-render-ok', repoRoot: okRoot, shared: true, userPathOptions: onHarness('standalone') });
  const okListing = runDispatches({ repoRoot: okRoot });
  const okLine = okListing.lines.find((l) => l.includes('exit 0'))!;
  assert.doesNotMatch(okLine, /claimed failed|FAILED/);
});

test('an echo-style executor that relays its prompt does not accidentally claim via the footer examples', (t) => {
  // The executor echoes stdin (prompt + footer) back. Nothing in that stream
  // matches the strict claim grammar, so classification stays content-based.
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const echo = ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))"];
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { worker: { provider: 'openai', id: 'worker-1' } },
    harnesses: { codex: { provider: 'openai', command: echo } },
    archetypes: { worker: {} },
    dials: { worker: 'worker' },
  }));
  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, echoedStdin('hello'));
  assert.equal(result.outcome, 'ok');
});

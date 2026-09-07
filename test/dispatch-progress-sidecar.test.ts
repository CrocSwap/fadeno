import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DISPATCHES_FILE,
  DISPATCH_PROGRESS_FOOTER,
  DISPATCH_RESULT_FOOTER,
  runDispatch,
} from '../src/commands/dispatch.ts';
import {
  describeSelfReport,
  dispatchProgressRelPath,
  parseProgressSidecar,
  progressBelongsToAttempt,
  readClaimProgress,
  requestProgressRelPath,
} from '../src/lib/attempt-progress.ts';
import { callerPromptDigest, PROGRESS_SIDECAR_ENV } from '../src/lib/executors.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// A host watching a command-lane dispatch is blind: `claude -p` prints nothing
// until exit, so a forty-minute agentic task shows 0 bytes the whole way and
// reads as hung. The engine lane closed this by naming a sidecar in the prompt
// it renders; an ad-hoc dispatch renders no prompt, so the contract arrives
// split — a CONSTANT instruction in the protocol footer, and the per-dispatch
// PATH in the environment. These tests hold that split in place, because
// collapsing it back into the prompt bytes is what would silently cross a
// shadow pair's two arms.

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

function seedCatalog(t: TestContext, command: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { worker: { provider: 'openai', id: 'worker-1' } },
    harnesses: { codex: { provider: 'openai', command } },
    archetypes: { worker: {} },
    dials: { worker: 'worker' },
  }));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, DISPATCHES_FILE), 'utf8')
    .split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function requestedRow(root: string): Record<string, unknown> {
  return evidenceRows(root).find((row) => row.event === 'dispatch_requested')!;
}

// --- the runless identity --------------------------------------------------

test('a runless dispatch files its sidecar under its own dispatch id, machine-locally', () => {
  assert.equal(
    dispatchProgressRelPath('e40af001-1c64-4632-9417-491067be95c1'),
    '.fadeno/local/progress/e40af001-1c64-4632-9417-491067be95c1.json',
  );
  // Same sanitization discipline as every other sidecar spelling: an id is not
  // trusted to be path-safe just because today's ids happen to be uuids.
  assert.equal(dispatchProgressRelPath('a b/../c'), '.fadeno/local/progress/a_b_.._c.json');
  // `.fadeno/local/`, never `.fadeno/progress/`: this is machine-local
  // bookkeeping filed next to the prompt, output and claim of the same
  // dispatch, not run evidence.
  assert.ok(dispatchProgressRelPath('x').startsWith('.fadeno/local/'));
});

test('requestProgressRelPath picks the engine spelling the request actually uses', () => {
  // Plain request: `renderStepPrompt` names `<run>/<step>--<actor>.json`.
  assert.equal(
    requestProgressRelPath({
      run: '2026-09-06-1200-run', step: 'review', actor: 'reviewer', stepExecutionId: 'se-1',
    }),
    '.fadeno/progress/2026-09-06-1200-run/review--reviewer.json',
  );
  // Compositional request: `assembleCompositePrompt` names
  // `<run>/<step_execution_id>.json`. Choosing the wrong branch finds no file
  // and reports a working agent as silent, so both are pinned here.
  assert.equal(
    requestProgressRelPath({
      run: '2026-09-06-1200-run', step: 'review', actor: 'reviewer', stepExecutionId: 'se-1', nodeInstanceId: 'ni-1',
    }),
    '.fadeno/progress/2026-09-06-1200-run/se-1.json',
  );
});

// --- the footer, and the digest it must not disturb ------------------------

test('the progress footer is constant: it carries an instruction, never a path', () => {
  // The whole reason the value rides the environment. If a dispatch id or a
  // sidecar path could appear in these bytes, both arms of a shadow pair —
  // which are handed the SAME snapshot file by fd — would be pointed at one
  // file, and the challenger's self-report would land on the primary's claim.
  assert.ok(DISPATCH_PROGRESS_FOOTER.includes(PROGRESS_SIDECAR_ENV));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(DISPATCH_PROGRESS_FOOTER), 'no dispatch id may appear');
  assert.ok(!DISPATCH_PROGRESS_FOOTER.includes('.fadeno/local/progress/'), 'no derived path may appear');
  // It says what a self-report is, on the surface where an agent reads it.
  assert.ok(/never gates/.test(DISPATCH_PROGRESS_FOOTER));
});

test('appending the progress footer leaves caller_prompt_sha256 untouched and both arms byte-identical', (t) => {
  const root = seedCatalog(t, ['node', '-e', 'process.stdout.write("done")']);
  const opts = { archetype: 'worker', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') } as const;
  runDispatch({ ...opts, prompt: 'same task' });
  runDispatch({ ...opts, prompt: 'same task' });
  const rows = evidenceRows(root).filter((row) => row.event === 'dispatch_requested');
  assert.equal(rows.length, 2);

  // The pin that matters. `callerPromptSha256` is taken above the brief and
  // above both footers, so it is the digest of the CALLER's bytes and nothing
  // else — this is the value a spawn-side hook computed for the same task, and
  // the one a shadow pair rolls on. Appending a footer must not move it.
  const callerDigest = callerPromptDigest('same task');
  for (const row of rows) {
    assert.equal(row.caller_prompt_sha256, callerDigest, 'the footer must not enter the caller digest');
  }

  // And the composed bytes stay a function of prompt content alone: two
  // dispatches of the same task compose identically, which is what keeps a
  // pair's arms comparable.
  const expected = `same task\n${DISPATCH_RESULT_FOOTER}\n\n${DISPATCH_PROGRESS_FOOTER}`;
  assert.equal(rows[0]!.prompt_sha256, rows[1]!.prompt_sha256);
  for (const row of rows) {
    assert.equal(readFileSync(join(root, row.prompt_snapshot as string), 'utf8'), expected);
  }
  // Neither dispatch's own identity leaked into the bytes the other also reads.
  for (const row of rows) {
    const snapshot = readFileSync(join(root, row.prompt_snapshot as string), 'utf8');
    assert.ok(!snapshot.includes(row.dispatch_id as string), 'the dispatch id must stay out of the prompt');
    assert.ok(!snapshot.includes('.fadeno/local/progress/'), 'the sidecar path must stay out of the prompt');
  }
});

// --- the wiring, end to end ------------------------------------------------

test('an ad-hoc dispatch derives a sidecar and tells its executor where it is', (t) => {
  // The executor plays the agent: it reads the path out of the environment and
  // writes the cooperative status file, exactly as the footer instructs.
  const root = seedCatalog(t, [
    'node',
    '-e',
    `const fs = require('fs');
     const p = process.env.${PROGRESS_SIDECAR_ENV};
     if (!p) { process.stdout.write('NO SIDECAR IN ENV'); process.exit(0); }
     fs.mkdirSync(require('path').dirname(p), { recursive: true });
     fs.writeFileSync(p, JSON.stringify({
       state: 'running', phase: 'reading the contract',
       current: 'deriving the sidecar', updated_at: new Date().toISOString(),
     }));
     process.stdout.write(p);`,
  ]);
  const result = runDispatch({
    archetype: 'worker', prompt: 'do the thing', repoRoot: root, shared: true,
    userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.outcome, 'ok');

  const rel = dispatchProgressRelPath(result.dispatchId);
  const abs = join(root, ...rel.split('/'));
  assert.ok(existsSync(abs), `the executor must have been told ${rel}`);
  // The kernel handed the environment the very path it derived — not a
  // near-miss the supervisor would then fail to find.
  assert.equal(result.stdout.trim(), abs);
  // And the id on the evidence rows is the id the sidecar is filed under, so a
  // reader holding a dispatch row can find the file.
  assert.equal(requestedRow(root).dispatch_id, result.dispatchId);
  const progress = parseProgressSidecar(readFileSync(abs, 'utf8'))!;
  assert.equal(progress.phase, 'reading the contract');
  assert.equal(progress.source, 'agent', 'a mirrored report is always labeled a self-report');
});

test('a sidecar written mid-run reaches a reader before the executor exits', (t) => {
  // The complaint in one test. The executor writes its status, waits out two
  // supervisor heartbeats, then reads its OWN in-flight claim — standing in
  // for the host running `fadeno show` while the dispatch is still going — and
  // reports what a watcher would have seen. Nothing here is read after exit.
  const root = seedCatalog(t, [
    'node',
    '-e',
    `const fs = require('fs');
     const path = require('path');
     const p = process.env.${PROGRESS_SIDECAR_ENV};
     fs.mkdirSync(path.dirname(p), { recursive: true });
     fs.writeFileSync(p, JSON.stringify({
       state: 'running', phase: 'mid-flight', current: 'still working',
       updated_at: new Date().toISOString(),
     }));
     const claim = path.join(process.cwd(), ${JSON.stringify(INFLIGHT_DIR)}.split('/').join(path.sep),
       process.env.FADENO_IN_DISPATCH + '.json');
     setTimeout(() => {
       let seen = 'CLAIM UNREADABLE';
       try { seen = fs.readFileSync(claim, 'utf8'); } catch {}
       process.stdout.write(seen);
     }, 2400);`,
  ]);
  const result = runDispatch({
    archetype: 'worker', prompt: 'watch me work', repoRoot: root, shared: true,
    userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.outcome, 'ok');
  const seen = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(seen.progress_configured, true, 'the claim must say a sidecar was configured');
  assert.equal(seen.progress_phase, 'mid-flight', 'the self-report must be on the claim WHILE the executor runs');
  assert.equal(seen.progress_source, 'agent');
  // The byte counters and the self-report are different kinds of claim and sit
  // side by side on purpose: stdout was still empty when this was read.
  assert.equal(seen.stdout_bytes, 0);
});

// --- attempt scoping -------------------------------------------------------

test('progressBelongsToAttempt refuses a report older than the attempt reading it', () => {
  const started = Date.parse('2026-09-06T12:00:00.000Z');
  assert.equal(progressBelongsToAttempt('2026-09-06T12:00:05.000Z', started), true);
  assert.equal(progressBelongsToAttempt('2026-09-06T12:00:00.000Z', started), true, 'the boundary is inclusive');
  // The observed defect: a v2 attempt's last words, read by a live v3.
  assert.equal(progressBelongsToAttempt('2026-09-06T10:14:35.000Z', started), false);
  assert.equal(progressBelongsToAttempt('not a time', started), false, 'a report that cannot be aged is not ours');
});

test('a previous attempt\'s report is never adopted by the attempt that finds it', (t) => {
  // The engine's command-lane path is keyed by run+step+actor, so every attempt
  // of one actor opens the SAME file: attempt v2 finishes, leaves its last
  // phase behind, and live v3 opens it. That is the 2026-09-06 sighting —
  // `(running) — Auditing the integrated diff…, 1h 45m 25s ago` shown against
  // an attempt that had just started.
  //
  // Reproduced exactly: the executor plants a report timestamped 105 minutes
  // ago at its own sidecar path (a finished predecessor's words in the file
  // this attempt is pointed at), then reads its own claim as a watcher would.
  // It must find the fields absent — and then, once it writes a report of its
  // OWN, find that one mirrored, so the rule is shown to reject staleness
  // rather than to have simply stopped working.
  const root = seedCatalog(t, [
    'node',
    '-e',
    `const fs = require('fs');
     const path = require('path');
     const p = process.env.${PROGRESS_SIDECAR_ENV};
     fs.mkdirSync(path.dirname(p), { recursive: true });
     fs.writeFileSync(p, JSON.stringify({
       state: 'running', phase: 'auditing the integrated diff',
       current: 'auditing the integrated diff',
       updated_at: new Date(Date.now() - 105 * 60 * 1000).toISOString(),
     }));
     const claim = path.join(process.cwd(), ${JSON.stringify(INFLIGHT_DIR)}.split('/').join(path.sep),
       process.env.FADENO_IN_DISPATCH + '.json');
     const read = () => { try { return fs.readFileSync(claim, 'utf8'); } catch { return '{}'; } };
     setTimeout(() => {
       const stale = read();
       fs.writeFileSync(p, JSON.stringify({
         state: 'running', phase: 'my own phase', updated_at: new Date().toISOString(),
       }));
       setTimeout(() => {
         process.stdout.write(JSON.stringify({ stale: JSON.parse(stale), fresh: JSON.parse(read()) }));
       }, 2400);
     }, 2400);`,
  ]);
  const result = runDispatch({
    archetype: 'worker', prompt: 'a fresh attempt', repoRoot: root, shared: true,
    userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.outcome, 'ok');
  const seen = JSON.parse(result.stdout) as { stale: Record<string, unknown>; fresh: Record<string, unknown> };

  assert.equal(seen.stale.progress_configured, true, 'a sidecar WAS configured, and that stays true');
  assert.equal(seen.stale.progress_phase, undefined, 'a predecessor\'s words must not reach a live claim');
  assert.equal(readClaimProgress({ progressUpdatedAt: (seen.stale.progress_updated_at ?? null) as string | null }), null);

  // The same path, the same attempt, a report of its own: mirrored.
  assert.equal(seen.fresh.progress_phase, 'my own phase');
  assert.equal(seen.fresh.progress_source, 'agent');
});

// --- the two silences ------------------------------------------------------

test('no sidecar configured reads differently from a sidecar that is empty', () => {
  // Both produce a claim with no progress fields, and collapsing them is the
  // error: one is a fact about the dispatch (nobody was asked), the other a
  // fact about the agent (asked, saying nothing).
  assert.equal(describeSelfReport({ progressConfigured: false }).kind, 'unconfigured');
  assert.equal(describeSelfReport({ progressConfigured: true }).kind, 'configured_silent');
  assert.equal(describeSelfReport(null).kind, 'unconfigured');
  // A claim from a supervisor that predates the field genuinely does not say,
  // so it must not be reported as an observation of silence.
  assert.equal(describeSelfReport({ progressConfigured: null }).kind, 'unconfigured');
  const reported = describeSelfReport({
    progressConfigured: true,
    progressPhase: 'writing tests',
    progressUpdatedAt: '2026-09-06T12:00:00.000Z',
  });
  assert.equal(reported.kind, 'reported');
  assert.equal(reported.progress!.phase, 'writing tests');
  assert.equal(reported.progress!.source, 'agent');
});

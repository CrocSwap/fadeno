import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { spawnSync } from 'node:child_process';
import {
  DispatchCommandError,
  DISPATCHES_FILE,
  DISPATCHES_FORMAT,
  DISPATCH_RESULT_FOOTER,
  PENDING_RELAYS_FILE,
  PROXY_DISPATCHES_FILE,
  runDispatch,
} from '../src/commands/dispatch.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { callerPromptDigest, writeLocalDialState } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { echoedStdin, tempRepo } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

function seedCatalog(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 4,
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker', effort: 'default' },
      'luna-worker': { provider: 'openai', id: 'luna-worker', effort: 'default' },
      'fail-7': { provider: 'openai', id: 'fail-7' },
      'ro-model': { provider: 'openai', id: 'ro-model' },
    },
    harnesses: { codex: { provider: 'openai', command: STDIN_ECHO('REPORT:') } },
    archetypes: {
      worker: {},
      reviewer: { },
    },
    dials: {},
    ...extra,
  };
  // Also merge if extra provides models/routes
  if (extra.models) (base as any).models = { ...(base as any).models, ...(extra.models as any) };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('dispatch: request-before-spawn pairing with 1.1 row shape', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-09T12:00:00Z');
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, now, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, echoedStdin('REPORT:hello'));
  assert.equal(result.exitCode, 0);
  assert.equal(result.executor, 'echo-worker');
  assert.equal(result.model, 'echo-worker');
  assert.equal(result.source, 'repo');
  assert.deepEqual(result.dial, { model: 'echo-worker' });
  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  const [req, comp] = rows as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(req.event, 'dispatch_requested');
  assert.equal(comp.event, 'dispatch_completed');
  assert.equal(req.format, '1.1');
  assert.equal(comp.format, '1.1');
  assert.equal(req.dispatch_id, comp.dispatch_id);
  assert.equal(req.dispatch_id, result.dispatchId);
  assert.deepEqual(req.dial, { model: 'echo-worker' });
  assert.equal(req.executor, 'echo-worker');
  assert.equal(req.model, 'echo-worker');
  assert.equal(req.model_id, 'echo-worker');
  assert.equal(req.reasoning_effort, 'default');
  assert.equal(req.harness, 'codex');
  assert.equal(req.provider, 'openai');
  assert.equal(req.resolution, 'repo');
  assert.ok(!('exit_code' in req));
  assert.ok(!('output_sha256' in req));
  assert.ok(!('duration_ms' in req));
  assert.equal(req.prompt_sha256, sha256Hex(echoedStdin('hello')));
  assert.equal(comp.timestamp, new Date(now.getTime() + (comp.duration_ms as number)).toISOString());
  assert.equal(req.prompt_source, 'stdin');
  assert.equal(result.promptSource, 'stdin');
  assert.match(result.promptSnapshot as string, /^\.fadeno\/local\/prompts\/worker-[0-9a-f]{8}\.md$/);
  assert.ok(!('relay_attested' in comp));
  assert.equal(result.relayAttested, null);
  // append-only: second dispatch adds second pair
  runDispatch({ archetype: 'worker', prompt: 'again', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(evidenceRows(root).length, 4);
});

/**
 * The proxy-guard hook's half of the attestation: proof that a dispatch proxy
 * is the caller, keyed by the bytes it is about to send. Without it the kernel
 * cannot tell an un-relayed dispatch from a relay that altered the prompt, and
 * `relay_attested: false` means nothing.
 */
function markProxyDispatch(root: string, prompts: string[], timestamp = '2026-08-12T11:59:45Z'): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, PROXY_DISPATCHES_FILE),
    `${prompts.map((p) => JSON.stringify({ timestamp, archetype: 'worker', prompt_sha256: sha256Hex(p) })).join('\n')}\n`,
  );
}

test('dispatch: relay attestation consumes a matching spawn-side stash', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  markProxyDispatch(root, ['hello\n', 'ello\n']);
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${[
      JSON.stringify({ timestamp: '2026-08-12T10:00:00Z', prompt_sha256: sha256Hex('old') }),
      JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('hello') }),
      JSON.stringify({ timestamp: '2026-08-12T11:59:30Z', prompt_sha256: sha256Hex('other') }),
    ].join('\n')}\n`,
  );
  const attested = runDispatch({ archetype: 'worker', prompt: 'hello\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(attested.relayAttested, true);
  assert.equal(evidenceRows(root).at(-1)!.relay_attested, true);
  const remaining = readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { prompt_sha256: string });
  assert.deepEqual(remaining.map((row) => row.prompt_sha256), [sha256Hex('other')]);

  // `--allow-relay-mismatch` so this stays a test of CONSUMPTION: without it
  // the mangled dispatch is refused (see the refusal tests below) and the
  // stash bookkeeping would never be reached.
  const mangled = runDispatch({
    archetype: 'worker', prompt: 'ello\n', repoRoot: root, now,
    userPathOptions: onHarness('standalone'), allowRelayMismatch: true,
  });
  assert.equal(mangled.relayAttested, false);
  assert.equal(evidenceRows(root).at(-1)!.relay_attested, false);
});

test('dispatch: pending relay stale-pruned and trailing-newline tolerance', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // trailing newline case: stash has sha of 'hello' without newline, dispatch with 'hello\n' still matches via heredoc contract
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('hello') })}\n`,
  );
  markProxyDispatch(root, ['hello\n']);
  const r = runDispatch({ archetype: 'worker', prompt: 'hello\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(r.relayAttested, true);
  // after consumption file should be removed (no remaining fresh entries)
  assert.ok(!existsSync(join(root, PENDING_RELAYS_FILE)) || readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8').trim() === '');
});

test('dispatch: concurrent pending relay survives', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${[
      JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('first') }),
      JSON.stringify({ timestamp: '2026-08-12T11:59:30Z', prompt_sha256: sha256Hex('second') }),
    ].join('\n')}\n`,
  );
  markProxyDispatch(root, ['first\n']);
  runDispatch({ archetype: 'worker', prompt: 'first\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  const remaining = readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8').trim().split('\n').map(l=>JSON.parse(l) as any);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].prompt_sha256, sha256Hex('second'));
});

/**
 * The reason this fix exists. An un-relayed `fadeno dispatch` that happens to
 * run while someone else's spawn attestation is still fresh used to be
 * reported `relay_attested: false` — indistinguishable from a relay that
 * altered the prompt. Two such rows sit in this repo's own ledger from
 * 2026-08-17 and nothing can now say which case they were. No proxy marker
 * means no proxy sent it, so the honest verdict is `null`.
 */
test('dispatch: an un-relayed dispatch colliding with a fresh stash attests null, not false', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // Someone else's relay is in flight, and it is fresh.
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('someone-elses-prompt') })}\n`,
  );
  // No proxy marker: this dispatch was typed directly, not relayed.
  const result = runDispatch({ archetype: 'worker', prompt: 'mine\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(result.relayAttested, null);
  assert.ok(!('relay_attested' in evidenceRows(root).at(-1)!));
  // And the unrelated attestation is left untouched, still waiting for the
  // dispatch it actually belongs to.
  const stash = readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { prompt_sha256: string });
  assert.deepEqual(stash.map((row) => row.prompt_sha256), [sha256Hex('someone-elses-prompt')]);
});

/**
 * Stage a defecting relay: the parent handed the proxy one set of bytes, and
 * the proxy is dispatching different ones. It still marks itself, which is
 * precisely what makes the alteration visible.
 */
function stageDefectingRelay(root: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('the original task text\n') })}\n`,
  );
  markProxyDispatch(root, ['a summary of the task\n']);
}

/**
 * The E25 regression, and why this predicate exists.
 *
 * Fadeno detected that the bytes reaching the executor were not the bytes the
 * caller wrote, said so on stderr, ran the executor anyway, and returned a
 * success verdict. The director who caught it read the whole diff by hand and
 * the work happened to be right: being right was luck, not process.
 *
 * `false` is a positive finding of defection, not an absence of evidence, so
 * the honest answer is to refuse — and to refuse HERE, before the spawn, where
 * it costs nothing.
 */
test('dispatch: a proxy that altered the prompt is REFUSED before the executor spawns', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  stageDefectingRelay(root);
  const echoed: string[] = [];
  assert.throws(
    () => runDispatch({
      archetype: 'worker', prompt: 'a summary of the task\n', repoRoot: root, now,
      userPathOptions: onHarness('standalone'), onEcho: (line: string) => echoed.push(line),
    }),
    (err: unknown) => err instanceof DispatchCommandError && /RELAY FIDELITY FAILED/.test((err as Error).message),
  );

  const rows = evidenceRows(root);
  // A boundary refusal, in the shape every other one uses — with the finding
  // and the remedy on the row, so the defection stays investigable.
  const refused = rows.at(-1)!;
  assert.equal(refused.event, 'dispatch_refused');
  assert.equal((refused.refusal as Record<string, unknown>).predicate, 'relay_fidelity');
  assert.match(String((refused.refusal as Record<string, unknown>).message), /--allow-relay-mismatch/);
  assert.equal(refused.relay_attested, false);
  assert.ok(!('relay_mismatch_allowed' in refused));

  // The point of refusing at the boundary: NOTHING ran. No request row, no
  // completion row, no output snapshot — so no tokens were spent and there is
  // no report for anyone to mistake for an answer.
  assert.deepEqual(rows.filter((r) => r.event === 'dispatch_requested'), []);
  assert.deepEqual(rows.filter((r) => r.event === 'dispatch_completed'), []);
  assert.ok(!('output_snapshot' in refused));

  // The stderr echo is kept — it is what a human watching the terminal sees
  // first — but it is no longer the mechanism, because stderr is discarded on
  // the recover-by-tag path.
  assert.ok(echoed.some((line) => line.startsWith('RELAY FIDELITY FAILED:')), echoed.join(' | '));
});

/**
 * The refusal has to survive being re-run, or it is not a refusal.
 *
 * Reading the attestation used to CONSUME it, so the dispatch that had just
 * been refused destroyed the evidence it was refused on: an identical re-run
 * found no proxy marker, read `null` ("no proxy sent this"), and proceeded —
 * with no override flag and no `relay_mismatch_allowed` on the row. That is
 * strictly worse than the warn-only behaviour it replaced, because the
 * operator now believes a gate exists. A refusal must not destroy the evidence
 * it refused on.
 */
test('dispatch: an identical re-run after a relay refusal refuses AGAIN, not silently', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  stageDefectingRelay(root);
  const run = () => runDispatch({
    archetype: 'worker', prompt: 'a summary of the task\n', repoRoot: root, now,
    userPathOptions: onHarness('standalone'),
  });
  const refusedTwice = /RELAY FIDELITY FAILED/;
  assert.throws(run, (err: unknown) => err instanceof DispatchCommandError && refusedTwice.test((err as Error).message));
  // Up-arrow, enter. Same bytes, same repo, no flag.
  assert.throws(run, (err: unknown) => err instanceof DispatchCommandError && refusedTwice.test((err as Error).message));
  assert.throws(run, (err: unknown) => err instanceof DispatchCommandError && refusedTwice.test((err as Error).message));

  // Three refusal rows and nothing else: no dispatch ever proceeded.
  const rows = evidenceRows(root);
  assert.equal(rows.length, 3);
  assert.deepEqual(new Set(rows.map((r) => r.event)), new Set(['dispatch_refused']));
  assert.deepEqual(rows.map((r) => (r.refusal as Record<string, unknown>).predicate), ['relay_fidelity', 'relay_fidelity', 'relay_fidelity']);

  // A refusal writes nothing to the attestation state — that is what makes the
  // re-read reach the same finding.
  assert.ok(existsSync(join(root, PROXY_DISPATCHES_FILE)));
  assert.ok(existsSync(join(root, PENDING_RELAYS_FILE)));
});

/**
 * Aging is the one way a left-in-place marker goes away on its own, and the
 * direction it falls in is what makes leaving it safe. An hour later the proxy
 * marker is outside the freshness window, so nothing fresh names these bytes
 * and the verdict is `null` — "cannot say", the field omitted from the row.
 * It can never become `true`: that needs a MATCHING spawn-side row, which a
 * defecting relay by construction does not have.
 */
test('dispatch: a refused attestation that ages out degrades to cannot-say, never to a silent attested', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  stageDefectingRelay(root);
  assert.throws(
    () => runDispatch({
      archetype: 'worker', prompt: 'a summary of the task\n', repoRoot: root,
      now: new Date('2026-08-12T12:00:00Z'), userPathOptions: onHarness('standalone'),
    }),
    (err: unknown) => err instanceof DispatchCommandError,
  );

  // Two hours later: the markers are stale, not matched.
  const result = runDispatch({
    archetype: 'worker', prompt: 'a summary of the task\n', repoRoot: root,
    now: new Date('2026-08-12T14:00:00Z'), userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.relayAttested, null);
  const completion = evidenceRows(root).at(-1)!;
  assert.equal(completion.event, 'dispatch_completed');
  // Not `true`, and not present at all — nothing claims this was attested.
  assert.ok(!('relay_attested' in completion));
  assert.ok(!('relay_mismatch_allowed' in completion));
  // The finding itself did not expire: the refusal row is still the record.
  assert.equal(evidenceRows(root)[0]!.event, 'dispatch_refused');
});

test('dispatch: --allow-relay-mismatch proceeds, and records that a human chose it', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  stageDefectingRelay(root);
  const echoed: string[] = [];
  const result = runDispatch({
    archetype: 'worker', prompt: 'a summary of the task\n', repoRoot: root, now,
    userPathOptions: onHarness('standalone'), allowRelayMismatch: true,
    onEcho: (line: string) => echoed.push(line),
  });
  assert.equal(result.relayAttested, false);
  assert.equal(result.relayMismatchAllowed, true);

  // Both fields, on both rows. The finding is not erased by the override —
  // the ledger has to show a defection AND a person who waved it through.
  const rows = evidenceRows(root);
  assert.deepEqual(rows.filter((r) => r.event === 'dispatch_refused'), []);
  for (const event of ['dispatch_requested', 'dispatch_completed']) {
    const row = rows.find((r) => r.event === event)!;
    assert.equal(row.relay_attested, false, event);
    assert.equal(row.relay_mismatch_allowed, true, event);
  }
  assert.ok(echoed.some((line) => line.includes('Proceeding under --allow-relay-mismatch')), echoed.join(' | '));

  // Consumed exactly once. The PROXY marker — the row that hit, and the row
  // that makes a `false` verdict reachable at all — is spent, so this
  // dispatch's finding cannot re-fire on the next one.
  assert.ok(!existsSync(join(root, PROXY_DISPATCHES_FILE)));
  // The spawn-side entry legitimately survives: it never matched (that is WHY
  // the verdict was false), so it is still an un-consumed attestation waiting
  // for the dispatch it actually belongs to. Deleting it would forge a
  // consumption that never happened.
  assert.ok(existsSync(join(root, PENDING_RELAYS_FILE)));

  // And it is inert on its own. A later dispatch of the same bytes reads
  // `null`, not the previous run's `false`: a defection verdict needs a proxy
  // marker to hit FIRST, and that one is spent.
  const after = runDispatch({
    archetype: 'worker', prompt: 'a summary of the task\n', repoRoot: root, now,
    userPathOptions: onHarness('standalone'),
  });
  assert.equal(after.relayAttested, null);
  assert.equal(after.relayMismatchAllowed, false);
  assert.ok(!('relay_attested' in evidenceRows(root).at(-1)!));
});

/**
 * The override is scoped to the finding, not a mode. A dispatch with nothing
 * to allow must not claim on its ledger row that something was allowed.
 */
test('dispatch: --allow-relay-mismatch records nothing when there was no mismatch', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const result = runDispatch({
    archetype: 'worker', prompt: 'plain\n', repoRoot: root,
    userPathOptions: onHarness('standalone'), allowRelayMismatch: true,
  });
  assert.equal(result.relayAttested, null);
  assert.equal(result.relayMismatchAllowed, false);
  assert.ok(!('relay_mismatch_allowed' in evidenceRows(root).at(-1)!));
});

test('dispatch: a proxy dispatch with no spawn-side stash attests null, never false', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  markProxyDispatch(root, ['hello\n']);
  // No pending-relays file at all: the spawn did not route through the
  // steering hook, so there is nothing to check fidelity against. "Cannot
  // say" is not "defected".
  const result = runDispatch({ archetype: 'worker', prompt: 'hello\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(result.relayAttested, null);
});

/**
 * Attestation matches on the CALLER's bytes, so a brief cannot break it.
 *
 * Both attestation files are written by hooks that only ever see the caller's
 * prompt — the spawn-side stash from `tool_input.prompt`, the proxy marker from
 * the bytes the proxy piped in. The kernel used to hash its own `prompt`
 * variable, which by the attestation call already carried the archetype brief,
 * so an archetype that declares one could never match either file: the marker
 * missed, `consumeRelayAttestation` returned `null`, and the row said "no proxy
 * sent this" about a dispatch a proxy demonstrably had. Same digest skew as the
 * pair roll, on a different consumer.
 */
test('dispatch: relay attestation matches the caller bytes with and without a brief', (t) => {
  const now = new Date('2026-08-12T12:00:00Z');
  const B = 'the bytes the parent handed the proxy\n';
  const attest = (root: string): void => {
    mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
    writeFileSync(
      join(root, PENDING_RELAYS_FILE),
      `${JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex(B) })}\n`,
    );
    markProxyDispatch(root, [B]);
  };

  const plain = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  attest(plain);
  assert.equal(
    runDispatch({ archetype: 'worker', prompt: B, repoRoot: plain, now, userPathOptions: onHarness('standalone') }).relayAttested,
    true,
  );

  const briefed = seedCatalog(t, {
    dials: { worker: 'echo-worker' },
    archetypes: { worker: { brief: 'coordination' } },
  });
  mkdirSync(join(briefed, '.fadeno', 'briefs'), { recursive: true });
  writeFileSync(join(briefed, '.fadeno', 'briefs', 'coordination.md'), 'BRIEF: coordinate through fadeno.\n');
  attest(briefed);
  const result = runDispatch({ archetype: 'worker', prompt: B, repoRoot: briefed, now, userPathOptions: onHarness('standalone') });
  assert.equal(result.relayAttested, true);

  // The brief really was composed — the fixture is not silently exercising the
  // no-brief path — and the two digests on the row are correspondingly
  // different, which is exactly why they need separate names.
  const request = evidenceRows(briefed).find((row) => row.event === 'dispatch_requested')!;
  assert.equal(request.caller_prompt_sha256, callerPromptDigest(B));
  assert.notEqual(request.prompt_sha256, request.caller_prompt_sha256);
  // Canonical, not raw: `B` ends in the newline a heredoc relay would have
  // added, and the digest a spawn-side hook took of the same task before that
  // happened is what this field has to equal.
  assert.notEqual(request.caller_prompt_sha256, sha256Hex(B));
  assert.match(readFileSync(join(briefed, request.prompt_snapshot as string), 'utf8'), /^BRIEF: /);
});

test('dispatch: --prompt-file dispatches get a kernel snapshot of the composed bytes', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  writeFileSync(join(root, 'task.md'), 'from-a-file');
  const result = runDispatch({ archetype: 'worker', promptFile: 'task.md', cwd: root, repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.promptSource, 'file');
  // The kernel composes the result footer onto every prompt, so it owns the
  // snapshot even for a --prompt-file dispatch — and the digest attests the
  // composed bytes, not the caller's file.
  const composed = echoedStdin('from-a-file');
  assert.match(result.promptSnapshot, /^\.fadeno\/local\/prompts\/worker-[0-9a-f]{8}\.md$/);
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.prompt_source, 'file');
  assert.equal(row.prompt_snapshot, result.promptSnapshot);
  assert.equal(row.prompt_sha256, sha256Hex(composed));
  assert.equal(readFileSync(join(root, row.prompt_snapshot as string), 'utf8'), composed);
});

test('dispatch: --prompt-file missing-file and no-prompt errors', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  writeFileSync(join(root, 'prompt.txt'), 'from-file');
  const result = runDispatch({ archetype: 'worker', promptFile: 'prompt.txt', cwd: root, repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, echoedStdin('REPORT:from-file'));
  assert.throws(
    () => runDispatch({ archetype: 'worker', promptFile: 'missing.txt', cwd: root, repoRoot: root, userPathOptions: onHarness('standalone') }),
    /--prompt-file missing\.txt does not exist/,
  );
  assert.throws(
    () => runDispatch({ archetype: 'worker', repoRoot: root, userPathOptions: onHarness('standalone') }),
    /no prompt: pass --prompt-file <path> or pipe the prompt on stdin/,
  );
});

test('dispatch: unknown --model rejected with helpful list', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  // bypass via --model
  const result = runDispatch({ model: 'echo-worker', prompt: 'raw', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.executor, 'echo-worker');
  assert.equal(result.source, 'model-flag');
  // unknown model: may error about driver or model — accept either, but must mention ghost or declared models
  assert.throws(
    () => runDispatch({ model: 'ghost', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    (err: unknown) => {
      assert.ok(err instanceof DispatchCommandError);
      const msg = (err as Error).message;
      assert.ok(/ghost/.test(msg) || /echo-worker/.test(msg) || /declared/.test(msg) || /unknown driver/.test(msg), `unexpected message: ${msg}`);
      return true;
    },
  );
  // also unknown via with effort should list
  assert.throws(
    () => runDispatch({ model: 'ghost@high', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    DispatchCommandError,
  );
});

test('dispatch: propagates the executor exit code and records it as evidence', (t) => {
  const root = seedCatalog(t, {
    models: {
      'fail-7': { provider: 'openai', id: 'fail-7' },
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
    },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', 'process.exit(7)'] } },
    dials: { worker: 'fail-7' },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, '');
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.exit_code, 7);
  assert.equal(row.output_sha256, sha256Hex(''));
});

test('dispatch: requires --archetype unless --model bypasses', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  assert.throws(
    () => runDispatch({ prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    /needs --archetype/,
  );
  assert.throws(
    () => runDispatch({ archetype: 'Worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    /--archetype "Worker" is not a bare lowercase identifier/,
  );
});




test('dispatch: exit-code propagation row.exit_code ===7 + sha256("") pinned', (t) => {
  const root = seedCatalog(t, {
    models: { 'fail-7': { provider: 'openai', id: 'fail-7' } },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', 'process.exit(7)'] } },
    dials: { worker: 'fail-7' },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.exitCode, 7);
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.exit_code, 7);
  assert.equal(row.output_sha256, sha256Hex(''));
});

test('dispatch: request-row negatives + append-only', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-09T12:00:00Z');
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  const [req, comp] = rows as [Record<string, unknown>, Record<string, unknown>];
  assert.ok(!('output_sha256' in req));
  assert.ok(!('duration_ms' in req));
  // append-only second pair
  runDispatch({ archetype: 'worker', prompt: 'again', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(evidenceRows(root).length, 4);
});

test('dispatch: output snapshot agreement and workspace_changed false case', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  spawnSync('git', ['init'], { cwd: root, env });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: root, env });
  // `--shared` explicitly: isolation is the DEFAULT now, and an isolated
  // dispatch records its change as a diff rather than as `workspace_changed`.
  // This test is about the shared path's tri-state, so it asks for it.
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
  const comp = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  // tri-state: with git and pure-echo, workspace_changed must be false (not truthy)
  assert.equal(comp.workspace_changed, false);
});

test('dispatch: workspace_changed omitted outside git', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, userPathOptions: onHarness('standalone') });
  const [req, comp] = evidenceRows(root) as [Record<string, unknown>, Record<string, unknown>];
  assert.ok(!('workspace_changed' in req));
  assert.ok(!('workspace_changed' in comp));
});

test('dispatch: unknown --model and empty prompt handling', (t) => {
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  assert.throws(() => runDispatch({ archetype: 'worker', prompt: '   ', repoRoot: root, userPathOptions: onHarness('standalone') }), /empty prompt/);
  assert.equal(evidenceRows(root).length, 0);
});

/** A repo with git, and an executor that writes one file into its cwd. The
 * file is what proves where the executor actually ran and whether its work
 * reached the caller's tree — a `workspace_mode` string proves neither, which
 * is how isolation stayed declared-but-not-delivered through a green suite. */
function seedIsolationRepo(t: TestContext, opts: { command?: string[] } = {}): string {
  const write = opts.command ?? ['node', '-e', "require('node:fs').writeFileSync('made-by-executor.txt','x');process.stdout.write('REPORT:done')"];
  const root = seedCatalog(t, {
    dials: { worker: 'echo-worker' },
    harnesses: { codex: { provider: 'openai', command: write } },
  });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  spawnSync('git', ['init'], { cwd: root, env });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: root, env });
  return root;
}

test('dispatch: kernel isolation is delivered, not just declared — unpaired work merges back', (t) => {
  // The claim this test exists to make is NOT "the row says isolated". Rows
  // said that before and the dispatch ran in the shared tree anyway; the
  // request row carried an intent the completion row quietly broke. So this
  // asserts the two facts a string cannot fake: the executor's file is absent
  // from the tree WHILE it runs somewhere else, and present afterwards
  // because the merge-back put it there.
  const root = seedIsolationRepo(t);
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, userPathOptions: onHarness('standalone') });

  const requested = evidenceRows(root).find((r) => r.event === 'dispatch_requested')!;
  const completed = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal(requested.workspace_mode, 'isolated', 'the default INTENT is isolation');
  assert.equal(completed.workspace_mode ?? 'isolated', 'isolated', 'and it is now what actually happened');
  assert.equal(completed.workspace_mode_degraded, undefined, 'no degradation to stamp');

  // The executor ran in a worktree: its output is a diff, not a direct write.
  assert.equal(typeof completed.diff_snapshot, 'string');
  assert.ok(Number(completed.diff_bytes) > 0, 'the worktree produced a real patch');
  // And the diff is anchored, so it stays appliable after the worktree is gone.
  assert.match(String(completed.baseline_commit ?? ''), /^[0-9a-f]{40}$/);

  // Merge-back is what makes isolation invisible to the caller: the work
  // lands, exactly as a shared-tree dispatch's would have.
  assert.deepEqual(completed.primary_merge, { status: 'clean' });
  assert.ok(existsSync(join(root, 'made-by-executor.txt')), 'the executor\'s work reached the caller\'s tree');
});

test('dispatch: --isolate holds the work OUT of the tree — the one case that never merges back', (t) => {
  // The whole reason merge-back keys on WHO asked. `--isolate` is a caller
  // saying "keep this out of my tree"; honouring the letter of isolation and
  // then applying the diff anyway would be the exact opposite of the request.
  const root = seedIsolationRepo(t);
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, isolate: true, userPathOptions: onHarness('standalone') });

  const completed = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal(completed.workspace_mode ?? 'isolated', 'isolated');
  assert.equal(completed.primary_merge, undefined, 'absence means nothing was attempted — no "skipped" status');
  assert.ok(Number(completed.diff_bytes) > 0, 'the work is still captured, just not applied');
  assert.ok(!existsSync(join(root, 'made-by-executor.txt')), 'and the tree is untouched');
});

test('dispatch: --isolate without git refuses rather than silently running in the tree', (t) => {
  // A downgrade here is not a fallback, it is the opposite of what was asked
  // for. Kernel isolation may degrade — nobody asked for it — but an explicit
  // containment request that lands in the caller's tree anyway is the silent
  // wrong answer this codebase keeps paying for.
  const root = seedCatalog(t, { dials: { worker: 'echo-worker' } });
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, isolate: true, userPathOptions: onHarness('standalone') }),
    (err: unknown) => err instanceof DispatchCommandError && /--isolate needs a git repository/.test(err.message),
  );
});

test('dispatch: --shared opts out of isolation deliberately, with no degradation stamp', (t) => {
  const root = seedIsolationRepo(t);
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, shared: true, userPathOptions: onHarness('standalone') });
  const requested = evidenceRows(root).find((r) => r.event === 'dispatch_requested')!;
  const completed = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  assert.equal(requested.workspace_mode, 'shared');
  assert.equal(completed.workspace_mode_degraded, undefined, 'a choice is not a degradation');
  assert.equal(completed.diff_snapshot, undefined, 'a shared dispatch writes the tree directly');
  assert.ok(existsSync(join(root, 'made-by-executor.txt')));
});

test('dispatch: `ignored_output: kept` keeps the dispatch shared — the worktree would eat the output', (t) => {
  // `git add -A` respects .gitignore, so a merged-back worktree discards
  // exactly what this policy exists to preserve. Isolation is withheld rather
  // than the policy being honoured in name only.
  const root = seedIsolationRepo(t, {
    command: ['node', '-e', "require('node:fs').writeFileSync('build-output.bin','x');process.stdout.write('REPORT:done')"],
  });
  writeFileSync(join(root, '.gitignore'), 'build-output.bin\n');
  runDispatch({
    archetype: 'worker', prompt: 'hello', repoRoot: root, ignoredOutput: 'kept',
    userPathOptions: onHarness('standalone'),
  });
  const requested = evidenceRows(root).find((r) => r.event === 'dispatch_requested')!;
  assert.equal(requested.workspace_mode, 'shared', 'declared shared up front, not degraded after the fact');
  assert.ok(existsSync(join(root, 'build-output.bin')), 'the gitignored output survived');
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runShow } from '../src/commands/show.ts';
import { runVerify, type Finding } from '../src/commands/verify.ts';
import { DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import { runDispatches, runDispatchesOutput } from '../src/commands/dispatches.ts';
import {
  describeIgnoredOutput,
  parseConcurrentWriteStamps,
  parseIgnoredOutputDiscarded,
} from '../src/lib/receipt-attestations.ts';
import { tempRepo } from './helpers.ts';

// ---------------------------------------------------------------------------
// Two kernel attestations that were written and read by NOBODY.
//
// `concurrent_write` is what replaced the repo-wide writer lease. The lease
// PREVENTED a second writer; nothing prevents one now, so the entire safety
// argument for deleting it rests on someone SEEING the overlap — and the
// stamp reached only `fadeno dispatch`'s stdout echo, which the recover-by-tag
// path discards.
//
// `ignored_output_discarded` is the row that says a worktree's gitignored
// content died with it, unstaged by `git add -A` and carried by no diff. It
// reached only the `fadeno dispatches` listing, which is not where anyone
// noticed a `data/research/` deliverable disappearing. Twice.
//
// Both are the same defect the relay-fidelity fix closed in 7c7a0f6: a
// finding on a channel its consumer does not read is a finding that does not
// exist. Every test here exists because a reader was silent.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function finding(findings: readonly Finding[], check: string): Finding {
  const found = findings.find((f) => f.check === check);
  assert.ok(found != null, `expected a "${check}" finding`);
  return found;
}

/** A minimal current-format run whose one receipt carries `extra`. */
function seedRun(t: TestContext, receipt: Record<string, unknown>): { root: string; runId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const runId = '2026-09-06-1100-attestations';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    join(dir, 'run.yaml'),
    JSON.stringify(
      {
        run_id: runId,
        schema_version: '0.3',
        playbook: 'code-change-review',
        status: 'completed',
        task: 'demo',
        started_at: '2026-09-06T11:00:00Z',
        ended_at: '2026-09-06T11:10:00Z',
        host: 'cli',
        current_step: null,
      },
      null,
      2,
    ),
    'utf8',
  );
  const events = [
    { type: 'run_started', step: null, seq: 1, timestamp: '2026-09-06T11:00:00Z' },
    {
      type: 'actor_completed',
      step: 'implement',
      actor: 'worker',
      seq: 2,
      timestamp: '2026-09-06T11:05:00Z',
      exit_code: 0,
      ...receipt,
    },
    { type: 'run_completed', step: null, seq: 3, timestamp: '2026-09-06T11:10:00Z' },
  ];
  writeFileSync(join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  return { root, runId };
}

// --- group 1: the shared parser -------------------------------------------

test('an unenumerable discard is not spelled the way "nothing was discarded" is', () => {
  // The whole field. `{ paths: [], truncated: true }` is the scan admitting it
  // could not list what died; reading it as null — or as an empty, complete
  // set — is the silent-loss shape this exists to end.
  const blind = parseIgnoredOutputDiscarded({ paths: [], truncated: true, note: 'git could not run here' });
  assert.ok(blind != null, 'a truncated scan with no paths is still a finding');
  assert.equal(blind.truncated, true);
  assert.match(describeIgnoredOutput(blind), /unknown, not nothing/);
  assert.doesNotMatch(describeIgnoredOutput(blind), /^\s*$/);

  // A capped listing is a FLOOR. Rendering it as though the named paths were
  // all of it understates a loss, which is the failure with no recovery.
  const capped = parseIgnoredOutputDiscarded({ paths: ['data/research/'], truncated: true });
  assert.match(describeIgnoredOutput(capped!), /^at least /);
  assert.match(describeIgnoredOutput(capped!), /floor, not the set/);

  // And a complete listing must NOT claim to be a floor, or the distinction
  // stops carrying information.
  const complete = parseIgnoredOutputDiscarded({ paths: ['dist/'] });
  assert.equal(complete!.truncated, false);
  assert.doesNotMatch(describeIgnoredOutput(complete!), /at least/);
  assert.doesNotMatch(describeIgnoredOutput(complete!), /floor/);

  // Silence is the only spelling of "nothing to report".
  assert.equal(parseIgnoredOutputDiscarded(undefined), null);
  assert.equal(parseIgnoredOutputDiscarded({}), null);
});

test('a legacy bare-array discard cannot claim completeness it never recorded', () => {
  // The engine wrote `string[]` here before it wrote an object, throwing away
  // both the truncation flag and the note. Those rows exist. A row that cannot
  // state its own completeness does not get assumed complete.
  const legacy = parseIgnoredOutputDiscarded(['data/research/', 'dist/']);
  assert.ok(legacy != null, 'an array row is evidence, not garbage');
  assert.deepEqual(legacy.paths, ['data/research/', 'dist/']);
  assert.equal(legacy.truncated, true, 'no flag was recorded, so completeness is unstated — never assumed');
  assert.match(legacy.note ?? '', /no completeness flag/);

  // The worst legacy case: truncated with nothing enumerated was written as
  // `[]`, byte-identical to a listing that found nothing.
  const blindLegacy = parseIgnoredOutputDiscarded([]);
  assert.ok(blindLegacy != null, 'an empty array row still says something was discarded');
  assert.equal(blindLegacy.truncated, true);
});

test('a concurrent_write stamp keeps the strength of its evidence', () => {
  const stamps = parseConcurrentWriteStamps([
    {
      dispatch_id: 'aaaaaaaabbbbbbbb',
      kind: 'engine',
      workspace_mode: 'isolated',
      attribution: 'delivery',
      paths_intersecting: 2,
      paths: ['src/a.ts', 'src/b.ts'],
      note: 'writer prose',
    },
    {
      dispatch_id: 'ccccccccdddddddd',
      kind: 'ad-hoc',
      workspace_mode: 'shared',
      attribution: 'workspace',
      paths_intersecting: 1,
      paths: ['src/a.ts'],
      degraded: true,
      note: 'writer prose',
    },
    { dispatch_id: 'eeeeeeeeffffffff', kind: 'host-dispatch', workspace_mode: 'shared', attribution: 'workspace', paths_intersecting: 0, paths: [], pending: true, note: 'p' },
  ]);
  assert.equal(stamps!.length, 3);
  assert.equal(stamps![0]!.attribution, 'delivery');
  assert.equal(stamps![1]!.degraded, true);
  assert.equal(stamps![2]!.pending, true);

  // A stamp naming no other window cannot be intersected with anything.
  assert.equal(parseConcurrentWriteStamps([{ paths: ['x'] }]), null);
  assert.equal(parseConcurrentWriteStamps(undefined), null);
});

// --- group 2: fadeno verify ------------------------------------------------

test('verify warns on an overlap and never fails the run for one', (t) => {
  const { root, runId } = seedRun(t, {
    concurrent_write: [
      {
        dispatch_id: 'aaaaaaaabbbbbbbb',
        run_id: 'r-other',
        kind: 'engine',
        workspace_mode: 'isolated',
        attribution: 'delivery',
        paths_intersecting: 2,
        paths: ['src/a.ts', 'src/shared.ts'],
        note: 'writer prose',
      },
    ],
  });
  const result = runVerify({ repoRoot: root, run: runId });

  const overlap = finding(result.findings, 'concurrent-writes');
  assert.equal(overlap.status, 'warn', 'an overlap is a finding, not a verdict on the run');
  assert.equal(result.ok, true, 'and it must not gate: `fadeno evidence` refuses to promote a run that fails');
  assert.match(overlap.detail, /aaaaaaaa/, 'the other delivery is named');
  assert.match(overlap.detail, /src\/shared\.ts/, 'and so are the intersecting paths');
  assert.match(overlap.detail, /attributable/, "an isolated window's set is its own work");
  assert.match(overlap.detail, /not proof either side lost work/, 'a check that over-claims is one people skip');
  assert.match(overlap.detail, /implement\/worker/, 'located at the receipt that carries it');
});

test('verify reports a shared-tree overlap as an attestation, and a pending one as unsettled', (t) => {
  const { root, runId } = seedRun(t, {
    concurrent_write: [
      { dispatch_id: 'ccccccccdddddddd', kind: 'ad-hoc', workspace_mode: 'shared', attribution: 'workspace', paths_intersecting: 1, paths: ['README.md'], note: 'n' },
      { dispatch_id: 'eeeeeeeeffffffff', kind: 'host-dispatch', workspace_mode: 'shared', attribution: 'workspace', paths_intersecting: 0, paths: [], pending: true, note: 'n' },
    ],
  });
  const overlap = finding(runVerify({ repoRoot: root, run: runId }).findings, 'concurrent-writes');
  assert.equal(overlap.status, 'warn');
  assert.match(overlap.detail, /ATTESTATION ONLY/, 'a shared set includes whoever else touched the tree');
  assert.match(overlap.detail, /not who wrote them/);
  assert.match(overlap.detail, /PENDING/, 'the overlap in time is a fact even with no set to intersect');
  assert.match(overlap.detail, /still open at this receipt|its own receipt carries the intersection/);
});

test('verify says "at least" when an overlap listing was incomplete', (t) => {
  const { root, runId } = seedRun(t, {
    concurrent_write: [
      { dispatch_id: 'ccccccccdddddddd', kind: 'ad-hoc', workspace_mode: 'shared', attribution: 'workspace', paths_intersecting: 1, paths: ['README.md'], degraded: true, note: 'n' },
    ],
  });
  const overlap = finding(runVerify({ repoRoot: root, run: runId }).findings, 'concurrent-writes');
  assert.match(overlap.detail, /at least 1 path/);
  assert.match(overlap.detail, /floor, not the set/);
});

test('verify warns on discarded output, and a TRUNCATED discard never reads as clean', (t) => {
  const { root, runId } = seedRun(t, {
    ignored_output_discarded: {
      paths: ['data/research/'],
      truncated: true,
      note: 'more than 10000 ignored entries are present',
    },
  });
  const result = runVerify({ repoRoot: root, run: runId });
  const discard = finding(result.findings, 'discarded-output');

  assert.equal(discard.status, 'warn');
  assert.notEqual(discard.status, 'ok', 'a run that destroyed named output is not clean');
  assert.equal(result.ok, true, 'but a declared `discardable` policy discarding a dist/ must stay promotable');
  assert.match(discard.detail, /data\/research\//);
  assert.match(discard.detail, /FLOOR rather than the set/, 'a capped listing is a floor on what was destroyed');
  assert.match(discard.detail, /at least /);
  assert.match(discard.detail, /not recoverable from it/);
});

test('verify reads the legacy bare-array discard the engine used to write', (t) => {
  const { root, runId } = seedRun(t, { ignored_output_discarded: ['data/research/'] });
  const discard = finding(runVerify({ repoRoot: root, run: runId }).findings, 'discarded-output');
  assert.equal(discard.status, 'warn', 'an old row is still a loss');
  assert.match(discard.detail, /no completeness flag/, 'and it cannot claim to have listed everything');
});

test('a silent ledger reports silence, not a clean tree', (t) => {
  const { root, runId } = seedRun(t, {});
  const result = runVerify({ repoRoot: root, run: runId });
  const overlap = finding(result.findings, 'concurrent-writes');
  assert.equal(overlap.status, 'ok');
  // The wording is deliberately weaker than "nothing overlapped": a delivery
  // whose own path listing failed, and a window log that could not be read,
  // both produce a receipt with no stamp on it.
  assert.match(overlap.detail, /no receipt carries a concurrent_write stamp/);
  assert.doesNotMatch(overlap.detail, /no concurrent writer|ran alone/);
  assert.equal(finding(result.findings, 'discarded-output').status, 'ok');
});

// --- group 3: fadeno show --------------------------------------------------

test('show projects both attestations above the artifact list', (t) => {
  const { root, runId } = seedRun(t, {
    concurrent_write: [
      { dispatch_id: 'aaaaaaaabbbbbbbb', kind: 'engine', workspace_mode: 'isolated', attribution: 'delivery', paths_intersecting: 1, paths: ['src/a.ts'], note: 'n' },
    ],
    ignored_output_discarded: { paths: ['data/research/'], truncated: true },
  });
  const projection = runShow({ repoRoot: root, run: runId }).projection!;

  assert.equal(projection.workspaceOverlaps.length, 1);
  assert.equal(projection.workspaceOverlaps[0]!.dispatchId, 'aaaaaaaabbbbbbbb');
  assert.equal(projection.workspaceOverlaps[0]!.attribution, 'delivery');
  assert.equal(projection.workspaceOverlaps[0]!.step, 'implement');
  assert.equal(projection.workspaceOverlaps[0]!.actor, 'worker');

  assert.equal(projection.discardedOutput.length, 1);
  assert.deepEqual(projection.discardedOutput[0]!.paths, ['data/research/']);
  assert.equal(projection.discardedOutput[0]!.truncated, true, 'a floor must survive the projection');

  const stdout = execFileSync(process.execPath, [CLI, 'show', runId], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  assert.match(stdout, /DISCARDED OUTPUT/);
  assert.match(stdout, /at least: a listing was a FLOOR, not the set/);
  assert.match(stdout, /data\/research\//);
  assert.match(stdout, /concurrent writes \(attestation, non-gating/);
  // Placement is the finding. A reader who meets the artifact list first
  // concludes it is the whole product — which is exactly how a research
  // deliverable was lost without anyone noticing.
  assert.ok(
    stdout.indexOf('DISCARDED OUTPUT') < stdout.indexOf('\nartifacts ('),
    'the loss must precede the artifact list it qualifies',
  );
  assert.ok(
    stdout.indexOf('DISCARDED OUTPUT') < stdout.indexOf('concurrent writes ('),
    'proof of loss leads; an attestation of overlap follows it',
  );
});

test('show says nothing when the receipts say nothing', (t) => {
  const { root, runId } = seedRun(t, {});
  const projection = runShow({ repoRoot: root, run: runId }).projection!;
  assert.deepEqual(projection.workspaceOverlaps, [], 'a field on every projection is a field nobody reads');
  assert.deepEqual(projection.discardedOutput, []);
  const stdout = execFileSync(process.execPath, [CLI, 'show', runId], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  assert.doesNotMatch(stdout, /DISCARDED OUTPUT/);
  assert.doesNotMatch(stdout, /concurrent writes \(/);
});

// --- group 4: fadeno dispatches (the ad-hoc half) --------------------------

const DISPATCH_ID = 'adhoc0123456789ab';
const SNAPSHOT = '.fadeno/local/outputs/adhoc.txt';
const REPORT_BODY = 'the report body\n';

function seedDispatchLog(t: TestContext, completion: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, SNAPSHOT), REPORT_BODY, 'utf8');
  const rows = [
    {
      format: '1.0',
      timestamp: '2026-09-06T11:00:00.000Z',
      event: 'dispatch_requested',
      dispatch_id: DISPATCH_ID,
      archetype: 'worker',
      executor: 'echo-worker',
      transport: 'command',
      output_snapshot: SNAPSHOT,
    },
    {
      format: '1.0',
      timestamp: '2026-09-06T11:00:12.000Z',
      event: 'dispatch_completed',
      dispatch_id: DISPATCH_ID,
      archetype: 'worker',
      executor: 'echo-worker',
      exit_code: 0,
      duration_ms: 12000,
      output_bytes: Buffer.byteLength(REPORT_BODY),
      output_sha256: createHash('sha256').update(REPORT_BODY).digest('hex'),
      ...completion,
    },
  ];
  writeFileSync(join(root, DISPATCHES_FILE), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return root;
}

test('the dispatches listing names who else wrote while a dispatch ran', (t) => {
  // `.fadeno/dispatches.jsonl` is the ONLY home of an ad-hoc dispatch's stamp,
  // so this listing is the only place it can ever be read. Before this it went
  // to a stdout echo, which the recover-by-tag path discards.
  const root = seedDispatchLog(t, {
    concurrent_write: [
      { dispatch_id: 'aaaaaaaabbbbbbbb', kind: 'engine', workspace_mode: 'isolated', attribution: 'delivery', paths_intersecting: 2, paths: ['src/a.ts', 'src/b.ts'], note: 'n' },
    ],
  });
  const { entries, lines } = runDispatches({ repoRoot: root });
  assert.equal(entries[0]!.concurrentWrite!.length, 1);
  assert.match(lines[0]!, /\[concurrent_write: 1 other delivery wrote while this ran \(aaaaaaaa\)/);
  assert.match(lines[0]!, /2 intersecting paths/);
  assert.match(lines[0]!, /src\/a\.ts, src\/b\.ts/);
  assert.match(lines[0]!, /attributable/);
});

test('a degraded overlap renders as a floor in the listing, never as the whole set', (t) => {
  const root = seedDispatchLog(t, {
    concurrent_write: [
      { dispatch_id: 'ccccccccdddddddd', kind: 'ad-hoc', workspace_mode: 'shared', attribution: 'workspace', paths_intersecting: 1, paths: ['README.md'], degraded: true, note: 'n' },
    ],
  });
  const { lines } = runDispatches({ repoRoot: root });
  assert.match(lines[0]!, /at least 1 intersecting path/);
  assert.match(lines[0]!, /ATTESTATION ONLY/);
  assert.match(lines[0]!, /floor, not the set/);
});

test('--output puts destroyed output IN the bytes, where a relay cannot drop it', (t) => {
  // stderr is discarded along with a timed-out call, so a stderr-only warning
  // does not exist on the recover-by-tag path. A report that says "wrote the
  // analysis to data/research/" is describing files that are not there.
  const root = seedDispatchLog(t, {
    ignored_output_discarded: { paths: ['data/research/'], truncated: true, note: 'the listing failed' },
  });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: DISPATCH_ID });
  assert.ok(result.ignoredOutputNotice != null, 'the banner exists');
  assert.match(result.bytes, /^!! GITIGNORED OUTPUT DISCARDED/, 'and it rides with the bytes');
  assert.match(result.bytes, /at least data\/research\//);
  assert.match(result.bytes, /---- report follows ----/);
  assert.ok(result.bytes.endsWith(result.snapshotBytes), 'the report itself is intact and unmodified');
  assert.equal(result.snapshotBytes, REPORT_BODY);
  // The load-bearing half: the digest on the completion row is the executor's
  // output, and a banner Fadeno prepended afterwards is not part of it. If
  // `attested` were computed against `bytes` this would read `mismatch` and a
  // caller would be told the snapshot had been tampered with.
  assert.equal(result.attested, 'match', 'the banner must not be hashed into the attestation');
});

test('--output states an overlap beside the bytes, and does not prefix it onto them', (t) => {
  // The in-band channel is reserved for findings that invalidate the bytes.
  // An overlap does not: two deliveries touching one file may both be fine,
  // and a banner readers learn to scroll past protects nothing.
  const root = seedDispatchLog(t, {
    concurrent_write: [
      { dispatch_id: 'aaaaaaaabbbbbbbb', kind: 'engine', workspace_mode: 'isolated', attribution: 'delivery', paths_intersecting: 1, paths: ['src/a.ts'], note: 'n' },
    ],
  });
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: DISPATCH_ID });
  assert.equal(result.concurrentWrite!.length, 1);
  assert.equal(result.ignoredOutputNotice, null);
  assert.equal(result.bytes, result.snapshotBytes, 'the report is handed over unprefixed');

  const proc = execFileSync(
    process.execPath,
    [CLI, 'dispatches', '--output', DISPATCH_ID],
    { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  assert.equal(proc, REPORT_BODY);
});

test('--output says nothing about a receipt that recorded nothing', (t) => {
  const root = seedDispatchLog(t, {});
  const result = runDispatchesOutput({ repoRoot: root, dispatchId: DISPATCH_ID });
  assert.equal(result.ignoredOutputNotice, null);
  assert.equal(result.ignoredOutputDiscarded, null);
  assert.equal(result.concurrentWrite, null);
  assert.equal(result.bytes, result.snapshotBytes);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runToolComplete } from '../src/commands/tool-complete.ts';
import { runVerify } from '../src/commands/verify.ts';
import { reduceCollective } from '../src/lib/collective.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

// The two artifact classes that carried no completion receipt before rc.61 —
// a tool result recorded by hand and an engine-assembled collective — and the
// receipts that now anchor them. The trace this builds is the rc.61 shape the
// tamper matrix measures: a manual `Diff`, a two-member map whose collective a
// gate reads, a terminal actor.

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const VALID_REVIEW = JSON.stringify({ reviewer: 'reviewer', summary: 'clean', issues: [], verdict: 'approve' });

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: receipts
description: manual tool + gated map
roles:
  reviewer_a:
    purpose: review a
    archetype: reviewer
  reviewer_b:
    purpose: review b
    archetype: reviewer
  worker:
    purpose: summarize
    archetype: worker
flow:
  - id: load_diff
    kind: tool_call
    tool: diff_loader
    output: Diff
  - id: review
    kind: map
    over: [reviewer_a, reviewer_b]
    input: [Diff]
    output: ReviewReport[]
  - id: decision_gate
    kind: gate
    input: ["ReviewReport[]"]
    condition: no_blocking_issues
    on_pass: done
    on_fail: abandoned
  - id: done
    kind: actor_call
    actor: worker
    input: ["ReviewReport[]"]
    output: FinalSummary
    terminal_status: completed
  - id: abandoned
    kind: actor_call
    actor: worker
    input: ["ReviewReport[]"]
    output: FinalSummary
    terminal_status: failed
`;

function seed(t: TestContext): { root: string; runId: string; runDir: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'receipts.yaml'), PLAYBOOK);
  const emit = (body: string): string[] => ['node', '-e', `process.stdout.write(${JSON.stringify(body)})`];
  const routes: Record<string, unknown> = {
    ro_a_p: { command: emit(VALID_REVIEW) },
    ro_b_p: { command: emit(VALID_REVIEW) },
    rw_worker_p: { command: emit('summary') },
    'current-host': { host: true },
  };
  const v3 = {
    schema_version: 3,
    models: {
      'ro-a': { provider: 'ro_a_p', id: 'ro-a', effort: 'high' },
      'ro-b': { provider: 'ro_b_p', id: 'ro-b', effort: 'high' },
      'rw-worker': { provider: 'rw_worker_p', id: 'rw-worker', effort: 'high' },
    },
    routes: { standalone: routes, codex: routes, claude: routes, grok: routes },
    archetypes: { worker: {}, reviewer: {} },
    dials: {},
    bindings: { reviewer_a: 'ro-a', reviewer_b: 'ro-b', worker: 'rw-worker' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  const { runId } = runNewRun({ playbook: 'receipts', task: 'receipts', repoRoot: root });
  return { root, runId, runDir: join(root, '.fadeno', 'runs', runId) };
}

function events(runDir: string): RunEvent[] {
  return readEvents(runDir).events;
}

function driveToCompletion(t: TestContext): { root: string; runId: string; runDir: string } {
  const seeded = seed(t);
  const first = runDrive({ repoRoot: seeded.root, run: seeded.runId });
  assert.equal(first.outcome, 'needs_decision', `manual tool must hand back: ${first.detail}`);
  mkdirSync(join(seeded.runDir, 'artifacts'), { recursive: true });
  writeFileSync(join(seeded.runDir, 'artifacts', 'diff.md'), '--- a\n+++ b\n+added\n');
  const recorded = runToolComplete({ repoRoot: seeded.root, run: seeded.runId, output: 'artifacts/diff.md' });
  assert.deepEqual(recorded.appendedEvents, ['step_started', 'artifact_created', 'tool_recorded']);
  const second = runDrive({ repoRoot: seeded.root, run: seeded.runId });
  assert.equal(second.outcome, 'terminal', second.detail);
  assert.equal(second.status, 'completed');
  return seeded;
}

test('a host-recorded tool result carries a tool_recorded receipt that attests its bytes', (t) => {
  const { runDir } = driveToCompletion(t);
  const all = events(runDir);
  const receipt = all.find((e) => e.type === 'tool_recorded');
  assert.ok(receipt, 'tool_recorded receipt');
  assert.equal(receipt.step, 'load_diff');
  assert.equal(receipt.extra.tool, 'diff_loader');
  assert.equal(receipt.extra.tool_call_id, 'tc-load_diff-g1');
  assert.equal(receipt.extra.attempt, 1);
  assert.equal(receipt.extra.output, 'artifacts/diff.md');
  assert.equal(receipt.extra.recorded_by, 'host');
  const bytes = readFileSync(join(runDir, 'artifacts', 'diff.md'));
  assert.equal(receipt.extra.output_sha256, sha(bytes));
  assert.equal(receipt.extra.output_bytes, bytes.length);
  const manifest = all.find((e) => e.type === 'artifact_created' && e.extra.artifact === 'artifacts/diff.md');
  assert.ok(manifest);
  assert.equal(manifest.extra.sha256, receipt.extra.output_sha256);
  // Manifest first, receipt second — a receipt never attests unmanifested bytes.
  assert.ok((manifest.seq ?? 0) < (receipt.seq ?? 0));
  // The measured lifecycle is not claimed: the kernel did not run anything.
  assert.equal(all.some((e) => e.type === 'tool_dispatched' || e.type === 'tool_completed'), false);
});

test('an assembled collective carries a collective_assembled receipt naming its parts in order', (t) => {
  const { runDir } = driveToCompletion(t);
  const all = events(runDir);
  const receipt = all.find((e) => e.type === 'collective_assembled');
  assert.ok(receipt, 'collective_assembled receipt');
  assert.equal(receipt.step, 'review');
  assert.equal(receipt.extra.step_execution_id, 'se-review-g1');
  assert.equal(receipt.extra.assembled_by, 'engine');
  const output = receipt.extra.output as string;
  const parts = receipt.extra.parts as string[];
  assert.deepEqual(receipt.extra.members, ['reviewer_a', 'reviewer_b']);
  assert.equal(parts.length, 2);
  for (const rel of parts) {
    assert.ok(all.some((e) => e.type === 'artifact_created' && e.extra.artifact === rel), `part ${rel} is manifested`);
  }
  const expected = reduceCollective(parts.map((rel) => JSON.parse(readFileSync(join(runDir, rel), 'utf8'))));
  assert.equal(readFileSync(join(runDir, output), 'utf8'), expected);
  assert.equal(receipt.extra.output_sha256, sha(expected));
  assert.equal(receipt.extra.output_bytes, Buffer.byteLength(expected));
  const manifest = all.find((e) => e.type === 'artifact_created' && e.extra.artifact === output);
  assert.ok(manifest);
  assert.equal(manifest.extra.sha256, sha(expected));
  assert.ok((manifest.seq ?? 0) < (receipt.seq ?? 0));
  // The gate read exactly this collective.
  const gate = all.find((e) => e.type === 'gate_evaluated');
  assert.ok(gate);
  assert.equal(gate.extra.artifact, output);
});

test('verify recomputes the collective from its parts and accounts for every tool artifact', (t) => {
  const { root, runId } = driveToCompletion(t);
  const result = runVerify({ repoRoot: root, run: runId });
  assert.equal(result.ok, true, JSON.stringify(result.findings.filter((f) => f.status === 'fail')));
  const find = (check: string) => result.findings.find((f) => f.check === check)!;
  assert.equal(find('collective-provenance').status, 'ok');
  assert.match(find('collective-provenance').detail, /1 collective\(s\) reduce from their receipted parts/);
  assert.equal(find('tool-artifact-receipts').status, 'ok');
  assert.match(find('tool-artifact-receipts').detail, /1 tool artifact\(s\) claimed by a receipt, 1 recorded by the host/);
  assert.equal(find('receipt-output-manifests').status, 'ok');
  assert.match(find('receipt-output-manifests').detail, /5 receipt output\(s\)/); // 2 parts + collective + diff + summary
});

test('the tamper matrix catches every attack on the two receipts and finds no unreceipted artifact', (t) => {
  const { runDir } = driveToCompletion(t);
  const script = join(import.meta.dirname, '..', 'scripts', 'tamper-matrix.mjs');
  const proc = spawnSync(process.execPath, [script, '--json', runDir], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout) as { uncaught: number; baselineFailures: number; results: Array<{ fixture: string; status: string; by?: string }> };
  assert.equal(report.uncaught, 0);
  assert.equal(report.baselineFailures, 0);
  const status = (id: string) => report.results.find((r) => r.fixture === id)?.status;
  const by = (id: string) => report.results.find((r) => r.fixture === id)?.by ?? '';
  assert.equal(status('unreceipted-artifact-renamed'), 'n/a', 'the gap is closed: nothing on the trace is unreceipted');
  for (const id of ['collective-renamed', 'collective-receipt-dropped', 'collective-forged', 'recorded-tool-renamed', 'recorded-tool-receipt-dropped', 'recorded-tool-forged']) {
    assert.equal(status(id), 'caught', `${id}: ${by(id)}`);
  }
  // The forgery is consistent with itself — only the reduction disagrees.
  assert.doesNotMatch(by('collective-forged'), /artifact-digests/);
  assert.match(by('collective-forged'), /collective-provenance/);
});

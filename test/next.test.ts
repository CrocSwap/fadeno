import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { NextError, runNext } from '../src/commands/next.ts';
import { runRun } from '../src/commands/run.ts';
import { planMapMemberOutputs, type Playbook } from '../src/lib/prompt-resolve.ts';
import { tempRepo } from './helpers.ts';

const DOGFOOD = join(import.meta.dirname, '..', 'docs', 'experimental', 'dual-architect-review.yaml');
const RUN_ID = '2026-07-12-1718-design-and-build-fadeno-prompt';
const TASK = 'Design and build fadeno prompt: deterministic step-prompt assembly';

interface SeedOpts {
  status?: string;
  currentStep?: string | null;
  events?: string;
  legacy?: boolean;
}

function seed(root: string, opts: SeedOpts = {}): string {
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'dual-architect-review.yaml'), readFileSync(DOGFOOD, 'utf8'));

  const dir = join(root, '.fadeno', 'runs', RUN_ID);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const current =
    opts.currentStep === null
      ? 'current_step: null'
      : `current_step: ${opts.currentStep ?? 'frame'}`;
  writeFileSync(
    join(dir, 'run.yaml'),
    [
      `run_id: ${RUN_ID}`,
      ...(opts.legacy ? [] : ['schema_version: "0.2"']),
      'playbook: dual-architect-review',
      `status: ${opts.status ?? 'running'}`,
      `task: "${TASK}"`,
      'started_at: 2026-07-12T21:18:58.647Z',
      'host: cli',
      'artifacts_dir: artifacts',
      current,
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'events.jsonl'), opts.events ?? '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}\n');
  return dir;
}

function lines(...events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

const TS = '2026-07-12T21:00:00.000Z';

test('next at run start returns the entry step (frame)', (t) => {
  const root = tempRepo(t);
  seed(root);
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'ready');
  assert.equal(result.step?.id, 'frame');
  assert.equal(result.step?.kind, 'actor_call');
  assert.equal(result.step?.promptable, true);
  assert.deepEqual(result.step?.actors, ['coordinator']);
  assert.equal(result.playbook, 'dual-architect-review');
  assert.equal(result.run, RUN_ID);
});

test('next at cross_review returns the map with both architects', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'cross_review',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'frame', timestamp: TS },
      { type: 'artifact_created', step: 'frame', artifact: 'artifacts/brief.md', timestamp: TS },
      { type: 'step_started', step: 'draft_approaches', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-sol.md', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-fable.md', timestamp: TS },
      { type: 'step_started', step: 'cross_review', timestamp: TS },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'ready');
  assert.equal(result.step?.id, 'cross_review');
  assert.equal(result.step?.kind, 'map');
  assert.equal(result.step?.promptable, true);
  assert.deepEqual(result.step?.actors, ['architect_fable', 'architect_sol']);
  assert.deepEqual(result.step?.outputs, [
    'artifacts/cross-review.architect_fable.json',
    'artifacts/cross-review.architect_sol.json',
  ]);
  assert.equal(result.step?.collective, 'artifacts/cross-review.json');
  assert.equal(result.step?.artifact_type, 'review-report');
  assert.match(result.advice, /fadeno prompt/);
});

test('next after cross_review complete returns convergence_gate', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'cross_review',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'frame', timestamp: TS },
      { type: 'artifact_created', step: 'frame', artifact: 'artifacts/brief.md', timestamp: TS },
      { type: 'step_started', step: 'draft_approaches', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-sol.md', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-fable.md', timestamp: TS },
      { type: 'step_started', step: 'cross_review', timestamp: TS },
      {
        type: 'artifact_created',
        step: 'cross_review',
        artifact: 'artifacts/cross-review.architect_sol.json',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 'cross_review',
        artifact: 'artifacts/cross-review.architect_fable.json',
        timestamp: TS,
      },
      { type: 'artifact_created', step: 'cross_review', artifact: 'artifacts/cross-review.json', timestamp: TS },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'ready');
  assert.equal(result.step?.id, 'convergence_gate');
  assert.equal(result.step?.kind, 'gate');
  assert.equal(result.step?.promptable, false);
  assert.equal(result.gate?.condition, 'no_blocking_issues');
  assert.equal(result.gate?.artifact, 'artifacts/cross-review.json');
  assert.equal(result.gate?.on_pass, 'consolidate');
  assert.equal(result.gate?.on_fail, 'reconcile');
});

test('golden: re_cross_review / convergence boundary — condition fail, iters remain → revise_approaches v2', (t) => {
  // After iteration-1 body completes and the until condition fails, with
  // max_iterations=2 and only one iteration used, next re-enters the body.
  const root = tempRepo(t);
  seed(root, {
    currentStep: 're_cross_review',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'frame', timestamp: TS },
      { type: 'artifact_created', step: 'frame', artifact: 'artifacts/brief.md', timestamp: TS },
      { type: 'step_started', step: 'draft_approaches', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-sol.md', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-fable.md', timestamp: TS },
      { type: 'step_started', step: 'cross_review', timestamp: TS },
      {
        type: 'artifact_created',
        step: 'cross_review',
        artifact: 'artifacts/cross-review.architect_sol.json',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 'cross_review',
        artifact: 'artifacts/cross-review.architect_fable.json',
        timestamp: TS,
      },
      { type: 'artifact_created', step: 'cross_review', artifact: 'artifacts/cross-review.json', timestamp: TS },
      { type: 'step_started', step: 'convergence_gate', timestamp: TS },
      {
        type: 'gate_evaluated',
        step: 'convergence_gate',
        condition: 'no_blocking_issues',
        artifact: 'artifacts/cross-review.json',
        result: 'fail',
        timestamp: TS,
      },
      { type: 'step_started', step: 'reconcile', timestamp: TS },
      { type: 'loop_iteration_started', step: 'reconcile', iteration: 1, timestamp: TS },
      { type: 'step_started', step: 'revise_approaches', timestamp: TS },
      {
        type: 'artifact_created',
        step: 'revise_approaches',
        artifact: 'artifacts/approach-sol.v2.md',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 'revise_approaches',
        artifact: 'artifacts/approach-fable.v2.md',
        timestamp: TS,
      },
      { type: 'step_started', step: 're_cross_review', timestamp: TS },
      {
        type: 'artifact_created',
        step: 're_cross_review',
        artifact: 'artifacts/cross-review.architect_sol.v2.json',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 're_cross_review',
        artifact: 'artifacts/cross-review.architect_fable.v2.json',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 're_cross_review',
        artifact: 'artifacts/cross-review.v2.json',
        timestamp: TS,
      },
      // Legacy origin form: gate_evaluated on the last body step (until fail).
      {
        type: 'gate_evaluated',
        step: 're_cross_review',
        condition: 'no_blocking_issues',
        artifact: 'artifacts/cross-review.v2.json',
        result: 'fail',
        timestamp: TS,
      },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'ready');
  assert.equal(result.step?.id, 'revise_approaches');
  assert.equal(result.step?.loop.iteration, 2);
  assert.equal(result.step?.loop.max, 2);
  assert.equal(result.step?.loop.in_body, true);
  assert.deepEqual(result.step?.outputs, [
    'artifacts/approach-fable.v3.md',
    'artifacts/approach-sol.v3.md',
  ]);
  assert.match(result.advice, /loop_iteration_started/);
});

test('next after body complete without condition returns loop until evaluation', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 're_cross_review',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'reconcile', timestamp: TS },
      { type: 'loop_iteration_started', step: 'reconcile', iteration: 1, timestamp: TS },
      { type: 'step_started', step: 'revise_approaches', timestamp: TS },
      {
        type: 'artifact_created',
        step: 'revise_approaches',
        artifact: 'artifacts/approach-sol.v2.md',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 'revise_approaches',
        artifact: 'artifacts/approach-fable.v2.md',
        timestamp: TS,
      },
      { type: 'step_started', step: 're_cross_review', timestamp: TS },
      {
        type: 'artifact_created',
        step: 're_cross_review',
        artifact: 'artifacts/cross-review.architect_sol.v2.json',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 're_cross_review',
        artifact: 'artifacts/cross-review.architect_fable.v2.json',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 're_cross_review',
        artifact: 'artifacts/cross-review.v2.json',
        timestamp: TS,
      },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'ready');
  assert.equal(result.step?.id, 'reconcile');
  assert.equal(result.step?.kind, 'loop');
  assert.equal(result.gate?.condition, 'no_blocking_issues');
  assert.equal(result.gate?.artifact, 'artifacts/cross-review.v2.json');
  assert.match(result.advice, /loop_condition_evaluated/);
});

test('next at human_gate without decision is blocked_human_gate', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'arbitrate',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'arbitrate', timestamp: TS },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'blocked_human_gate');
  assert.equal(result.step?.id, 'arbitrate');
  assert.ok(result.human_gate?.prompt);
  assert.equal(result.human_gate?.on_approve, 'consolidate');
  assert.equal(result.human_gate?.on_reject, 'abandoned');
});

test('next after human_decision approve advances to consolidate', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'arbitrate',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'arbitrate', timestamp: TS },
      { type: 'human_decision', step: 'arbitrate', branch: 'approve', timestamp: TS },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'ready');
  assert.equal(result.step?.id, 'consolidate');
  assert.equal(result.step?.kind, 'reduce');
  assert.equal(result.step?.promptable, true);
});

test('next accepts legacy human_gate_approved', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'arbitrate',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'arbitrate', timestamp: TS },
      { type: 'human_gate_approved', step: 'arbitrate', timestamp: TS },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.step?.id, 'consolidate');
});

test('next on a completed run is terminal', (t) => {
  const root = tempRepo(t);
  seed(root, {
    status: 'completed',
    currentStep: null,
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'run_completed', step: null, timestamp: TS },
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'terminal');
  assert.equal(result.terminal?.status, 'completed');
});

test('next on artifact-field map returns needs_decision', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'build',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'build', timestamp: TS },
    ),
  });
  // Jump the cursor to build without full history — seed a minimal playbook path
  // by only having step_started on build (incomplete). resolveAt handles it.
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'needs_decision');
  assert.equal(result.step?.id, 'build');
  assert.equal(result.step?.kind, 'map');
  assert.equal(result.step?.promptable, false);
});

test('next errors on unknown run', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  assert.throws(() => runNext({ repoRoot: root, run: 'nope' }), NextError);
});

test('legacy ledger without --legacy is refused', (t) => {
  const root = tempRepo(t);
  seed(root, { legacy: true });
  assert.throws(
    () => runNext({ repoRoot: root, run: RUN_ID }),
    (err: unknown) => err instanceof NextError && /legacy ledger format/.test((err as Error).message),
  );
});

test('untyped role-list map without output_path is not promptable (matches fadeno prompt)', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const playbook = `
kind: AgentPlaybook
schema_version: "0.1"
name: untyped-map
description: Minimal playbook for untyped map without output_path.
roles:
  a: { purpose: A }
  b: { purpose: B }
flow:
  - id: fan
    kind: map
    over:
      - a
      - b
    output: Notes[]
  - id: done
    kind: actor_call
    actor: a
    input:
      - Notes[]
    output: FinalSummary
    terminal_status: completed
`;
  writeFileSync(join(root, '.fadeno', 'playbooks', 'untyped-map.yaml'), playbook);
  const runId = 'untyped-map-run';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    join(dir, 'run.yaml'),
    [
      `run_id: ${runId}`,
      'schema_version: "0.2"',
      'playbook: untyped-map',
      'status: running',
      'task: "x"',
      'started_at: 2026-07-12T21:18:58.647Z',
      'host: cli',
      'artifacts_dir: artifacts',
      'current_step: fan',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'events.jsonl'),
    lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'fan', timestamp: TS },
    ),
  );

  const result = runNext({ repoRoot: root, run: runId });
  assert.equal(result.step?.id, 'fan');
  assert.equal(result.step?.promptable, false);
  assert.equal(result.step?.outputs, null);
  assert.equal(result.status, 'needs_decision');
  assert.match(result.advice, /output_path/);
});

test('gated map with both members but no collective stays on the map (resume-safe)', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'cross_review',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'frame', timestamp: TS },
      { type: 'artifact_created', step: 'frame', artifact: 'artifacts/brief.md', timestamp: TS },
      { type: 'step_started', step: 'draft_approaches', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-sol.md', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-fable.md', timestamp: TS },
      { type: 'step_started', step: 'cross_review', timestamp: TS },
      {
        type: 'artifact_created',
        step: 'cross_review',
        artifact: 'artifacts/cross-review.architect_sol.json',
        member: 'architect_sol',
        timestamp: TS,
      },
      {
        type: 'artifact_created',
        step: 'cross_review',
        artifact: 'artifacts/cross-review.architect_fable.json',
        member: 'architect_fable',
        timestamp: TS,
      },
      // deliberately no collective artifacts/cross-review.json
    ),
  });
  const result = runNext({ repoRoot: root, run: RUN_ID });
  assert.equal(result.status, 'ready');
  assert.equal(result.step?.id, 'cross_review');
  assert.equal(result.step?.collective, 'artifacts/cross-review.json');
  assert.notEqual(result.step?.id, 'convergence_gate');
  assert.match(result.advice, /assemble/);
});

test('human_decision with unrecognized branch errors instead of re-pausing', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'arbitrate',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'arbitrate', timestamp: TS },
      { type: 'human_decision', step: 'arbitrate', branch: 'consolidate', timestamp: TS },
    ),
  });
  assert.throws(
    () => runNext({ repoRoot: root, run: RUN_ID }),
    /unrecognized branch "consolidate"/,
  );
});

test('next outputs for a promptable map match planMapMemberOutputs (shared with prompt)', (t) => {
  const root = tempRepo(t);
  seed(root, {
    currentStep: 'cross_review',
    events: lines(
      { type: 'run_started', step: null, timestamp: TS },
      { type: 'step_started', step: 'frame', timestamp: TS },
      { type: 'artifact_created', step: 'frame', artifact: 'artifacts/brief.md', timestamp: TS },
      { type: 'step_started', step: 'draft_approaches', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-sol.md', timestamp: TS },
      { type: 'artifact_created', step: 'draft_approaches', artifact: 'artifacts/approach-fable.md', timestamp: TS },
      { type: 'step_started', step: 'cross_review', timestamp: TS },
    ),
  });
  const next = runNext({ repoRoot: root, run: RUN_ID });
  const playbook = parseYaml(
    readFileSync(join(root, '.fadeno', 'playbooks', 'dual-architect-review.yaml'), 'utf8'),
  ) as Playbook;
  const flow = playbook.flow as Array<{ id?: string }>;
  const step = flow.find((s) => s.id === 'cross_review')!;
  const planned = planMapMemberOutputs(
    playbook,
    step,
    ['architect_fable', 'architect_sol'],
    null,
    false,
  );
  assert.ok(planned);
  assert.deepEqual(
    next.step?.outputs,
    planned.map((p) => p.path),
  );
});

test('run --member and --field attach to artifact/event records', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // Use a shipped starter so we don't need the experimental playbook.
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'member field demo' });

  // artifact_created now builds a manifest, so the file must exist (12 bytes).
  mkdirSync(join(runDir, 'artifacts', 'parts', 'review'), { recursive: true });
  writeFileSync(join(runDir, 'artifacts', 'parts', 'review', 'substance_reviewer.json'), '{"ok":true}\n');

  runRun({
    repoRoot: root,
    run: runId,
    step: 'review',
    event: 'artifact_created',
    artifact: 'artifacts/parts/review/substance_reviewer.json',
    member: 'substance_reviewer',
    fields: ['source=driver', 'bytes=12'],
  });

  const last = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .at(-1)!;
  assert.equal(last.type, 'artifact_created');
  assert.equal(last.step, 'review');
  assert.equal(last.artifact, 'artifacts/parts/review/substance_reviewer.json');
  assert.equal(last.member, 'substance_reviewer');
  assert.equal(last.source, 'driver');
  assert.equal(last.bytes, 12); // JSON-decoded number

  runRun({
    repoRoot: root,
    run: runId,
    step: 'arbitrate-not-real',
    event: 'human_decision',
    fields: ['branch=approve'],
  });
  const decision = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .at(-1)!;
  assert.equal(decision.type, 'human_decision');
  assert.equal(decision.branch, 'approve');
});

test('run rejects --member without an event', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const { runId } = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'x' });
  assert.throws(
    () => runRun({ repoRoot: root, run: runId, member: 'x' }),
    /--member \/ --field require an event/,
  );
});

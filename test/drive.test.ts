import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DecideError, runDecide } from '../src/commands/decide.ts';
import { DriveError, runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { RunError, runRun } from '../src/commands/run.ts';
import { runShow } from '../src/commands/show.ts';
import { runVerify } from '../src/commands/verify.ts';
import { resolveActiveArtifacts } from '../src/lib/artifact-manifest.ts';
import { ExecutorProfileError, parseExecutorProfile } from '../src/lib/executors.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { tempRepo } from './helpers.ts';

/**
 * Engine tests run real subprocess executors — `node -e` one-liners standing
 * in for harness CLIs (read stdin, write the artifact to stdout).
 */

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: engine-e2e
description: Minimal engine-drivable flow for tests.
when_to_use:
  - engine tests
roles:
  worker:
    purpose: Implement the task.
  reviewer:
    purpose: Adversarially review the implementation.
flow:
  - id: implement
    kind: actor_call
    actor: worker
    output: Notes
    output_path: artifacts/notes.md
  - id: review
    kind: evaluator
    actor: reviewer
    input:
      - Notes
    output: ReviewReport
  - id: quality_gate
    kind: gate
    input:
      - ReviewReport
    condition: no_blocking_issues
    on_pass: approve_release
    on_fail: abandoned
  - id: approve_release
    kind: human_gate
    prompt: Ship it?
    on_approve: ship
    on_reject: abandoned
  - id: ship
    kind: actor_call
    actor: worker
    input:
      - ReviewReport
    output: FinalSummary
    output_path: artifacts/summary.md
    terminal_status: completed
  - id: abandoned
    kind: actor_call
    actor: worker
    output: FinalSummary
    output_path: artifacts/abandoned.md
    terminal_status: failed
`;

const VALID_REVIEW = JSON.stringify({
  reviewer: 'reviewer',
  summary: 'clean',
  issues: [],
  verdict: 'approve',
});

const EXECUTORS = {
  'ok-worker': {
    adapter: 'command',
    command: ['node', '-e', "process.stdout.write('IMPLEMENTATION NOTES')"],
  },
  'ok-reviewer': {
    adapter: 'command',
    command: ['node', '-e', `process.stdout.write(JSON.stringify(${VALID_REVIEW}))`],
  },
  'flaky-reviewer': {
    adapter: 'command',
    command: [
      'node',
      '-e',
      "const fs=require('fs');" +
        "if(fs.existsSync('flaky-flag.tmp')){" +
        `process.stdout.write(JSON.stringify(${VALID_REVIEW}));` +
        "}else{fs.writeFileSync('flaky-flag.tmp','1');process.stdout.write('not json at all');}",
    ],
  },
  dead: { adapter: 'command', command: ['node', '-e', 'process.exit(3)'] },
  // Minted-id session executor: the engine passes a fresh UUID as argv; the
  // fake harness persists "memory" in a session-keyed file in the repo cwd.
  'session-worker': {
    adapter: 'command',
    command: [
      'node',
      '-e',
      "const fs=require('fs');const id=process.argv[1];" +
        "fs.writeFileSync('sess-store-'+id+'.txt','remembered-work');" +
        "process.stdout.write('notes from session '+id);",
      '{session_id}',
    ],
    resume: [
      'node',
      '-e',
      "const fs=require('fs');const id=process.argv[1];" +
        "process.stdout.write('RESUMED '+id+' '+fs.readFileSync('sess-store-'+id+'.txt','utf8'));",
      '{session_id}',
    ],
  },
  // Pattern-mode session executor that fails validation once: the harness
  // assigns its own id (stderr banner); the repair attempt must resume it and
  // send ONLY the repair message (captured to a file for assertion).
  'flaky-session-reviewer': {
    adapter: 'command',
    command: [
      'node',
      '-e',
      "const fs=require('fs');process.stderr.write('session id: flk-001\\n');" +
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{" +
        "if(fs.existsSync('flk-flag.tmp')){process.stdout.write(JSON.stringify(" +
        `${VALID_REVIEW}));}else{fs.writeFileSync('flk-flag.tmp','1');` +
        "process.stdout.write('garbage');}});",
    ],
    resume: [
      'node',
      '-e',
      "const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c);" +
        "process.stdin.on('end',()=>{fs.writeFileSync('stdin-a2.txt',d);" +
        `process.stdout.write(JSON.stringify(${VALID_REVIEW}));});`,
      '{session_id}',
    ],
    session_id_pattern: 'session id: (\\S+)',
  },
};

const DEFAULT_BINDINGS = { worker: 'ok-worker', reviewer: 'ok-reviewer', '*': 'ok-worker' };

interface SeedOpts {
  bindings?: Record<string, string>;
}

function seed(t: TestContext, opts: SeedOpts = {}): { root: string; runId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'engine-e2e.yaml'), PLAYBOOK);
  // Translate old executors map into v3 models/routes/dials
  const models: Record<string, unknown> = {};
  const routesStandalone: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(EXECUTORS as Record<string, Record<string, unknown>>)) {
    const provider = name.replace(/-/g, '_') + '_p';
    models[name] = { provider, id: name, effort: 'high' };
    const route: Record<string, unknown> = { };
    if (spec.command) route.command = spec.command;
    if (spec.resume) route.resume = spec.resume;
    if (spec.session_id_pattern) route.session_id_pattern = spec.session_id_pattern;
    routesStandalone[provider] = route;
  }
  routesStandalone['current-host'] = { host: true };
  const v3 = {
    schema_version: 3,
    models,
    routes: {
      standalone: { ...routesStandalone },
      codex: { ...routesStandalone },
      claude: { ...routesStandalone },
      grok: { ...routesStandalone },
    },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'ok-worker', reviewer: 'ok-reviewer' },
    bindings: opts.bindings ?? DEFAULT_BINDINGS,
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  const { runId } = runNewRun({ playbook: 'engine-e2e', task: 'Engine end-to-end test', repoRoot: root });
  return { root, runId };
}

function events(root: string, runId: string): RunEvent[] {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

function ofType(all: RunEvent[], type: string): RunEvent[] {
  return all.filter((e) => e.type === type);
}

function finding(
  result: { findings: Array<{ check: string; status: string; detail: string }> },
  check: string,
): { check: string; status: string; detail: string } {
  const found = result.findings.find((f) => f.check === check);
  assert.ok(found, `expected a finding for ${check}`);
  return found;
}

/** Drive to the human gate, resolve it, drive to terminal. */
function completeHappyRun(t: TestContext): { root: string; runId: string } {
  const { root, runId } = seed(t);
  const paused = runDrive({ run: runId, repoRoot: root });
  assert.equal(paused.outcome, 'paused_human_gate');
  runDecide({ run: runId, option: 'approve', repoRoot: root });
  const done = runDrive({ run: runId, repoRoot: root });
  assert.equal(done.outcome, 'terminal');
  assert.equal(done.status, 'completed');
  return { root, runId };
}

test('engine: drives actor steps and gates to the human pause with full identity evidence', (t) => {
  const { root, runId } = seed(t);
  const result = runDrive({ run: runId, repoRoot: root });

  assert.equal(result.outcome, 'paused_human_gate');
  assert.equal(result.decision?.step, 'approve_release');
  assert.deepEqual(result.decision?.options, ['approve', 'reject']);
  assert.match(result.decision?.prompt ?? '', /Ship it\?/);

  const all = events(root, runId);

  // Profile snapshot: recorded once, digest matches the file.
  const snaps = ofType(all, 'profile_snapshotted');
  assert.equal(snaps.length, 1);
  assert.ok(existsSync(join(root, '.fadeno', 'runs', runId, 'profile.yaml')));

  // Two dispatches (implement/worker, review/reviewer), both attempt 1 initial.
  const dispatches = ofType(all, 'actor_dispatched');
  assert.equal(dispatches.length, 2);
  for (const d of dispatches) {
    assert.equal(d.extra.attempt, 1);
    assert.equal(d.extra.attempt_reason, 'initial');
    assert.equal(typeof d.extra.prompt_sha256, 'string');
    assert.equal(typeof d.extra.prompt_path, 'string');
  }
  assert.equal(dispatches[0]!.extra.step_execution_id, 'se-implement-g1');
  assert.equal(dispatches[0]!.extra.actor_call_id, 'ac-implement-g1-worker');
  assert.equal(dispatches[0]!.extra.executor, 'ok-worker');
  assert.equal(dispatches[1]!.extra.actor_call_id, 'ac-review-g1-reviewer');

  // Outputs recorded with identity fields; bytes are what the executor wrote.
  const notes = ofType(all, 'artifact_created').find((e) => e.extra.artifact === 'artifacts/notes.md');
  assert.ok(notes);
  assert.equal(notes.extra.step_execution_id, 'se-implement-g1');
  assert.equal(notes.extra.actor_call_id, 'ac-implement-g1-worker');
  assert.equal(notes.extra.attempt, 1);
  assert.equal(readFileSync(join(root, '.fadeno', 'runs', runId, 'artifacts', 'notes.md'), 'utf8'), 'IMPLEMENTATION NOTES');

  // Gate evaluated deterministically; prompt snapshots recorded.
  const gates = ofType(all, 'gate_evaluated');
  assert.equal(gates.length, 1);
  assert.equal(gates[0]!.extra.result, 'pass');
  assert.ok(ofType(all, 'prompt_assembled').length >= 2);

  // The pause is durable: a named decision with declared options.
  const requests = ofType(all, 'decision_requested');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.extra.decision_id, 'dec-approve_release-1');
  assert.deepEqual(requests[0]!.extra.options, ['approve', 'reject']);

  // Re-driving while paused is idempotent: no duplicate request.
  const again = runDrive({ run: runId, repoRoot: root });
  assert.equal(again.outcome, 'paused_human_gate');
  assert.equal(again.decision?.decisionId, 'dec-approve_release-1');
  assert.equal(ofType(events(root, runId), 'decision_requested').length, 1);
});

test('engine: decide resolves the pause; resume drives to terminal; verify passes all checks', (t) => {
  const { root, runId } = completeHappyRun(t);

  const all = events(root, runId);
  const resolved = ofType(all, 'decision_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.extra.option, 'approve');
  assert.equal(ofType(all, 'run_completed').length, 1);

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.equal(finding(verify, 'actor-attempts').status, 'ok');
  assert.equal(finding(verify, 'executor-bindings').status, 'ok');
  assert.equal(finding(verify, 'gate-eligible').status, 'ok');
  assert.equal(finding(verify, 'named-decisions').status, 'ok');
  assert.equal(finding(verify, 'artifact-supersede').status, 'skip');

  // The projection surfaces the decision and stays step-shaped.
  const shown = runShow({ run: runId, repoRoot: root });
  assert.ok(shown.projection);
  assert.deepEqual(
    shown.projection.decisions.map((d) => `${d.step}:${d.branch}`),
    ['approve_release:approve'],
  );
});

test('decide: undeclared options, conflicts, and duplicates behave per the decision contract', (t) => {
  const { root, runId } = seed(t);
  runDrive({ run: runId, repoRoot: root });

  assert.throws(() => runDecide({ run: runId, option: 'maybe', repoRoot: root }), DecideError);

  const first = runDecide({ run: runId, option: 'approve', repoRoot: root });
  assert.equal(first.recorded, 'resolved');

  const dup = runDecide({ run: runId, option: 'approve', repoRoot: root, decision: first.decisionId });
  assert.equal(dup.recorded, 'idempotent');
  assert.equal(ofType(events(root, runId), 'decision_resolved').length, 1);

  assert.throws(
    () => runDecide({ run: runId, option: 'reject', repoRoot: root, decision: first.decisionId }),
    /already resolved as "approve"/,
  );
});

test('engine: schema repair — invalid output is parked as evidence, attempt 2 carries the reason', (t) => {
  const { root, runId } = seed(t, {
    bindings: { worker: 'ok-worker', reviewer: 'flaky-reviewer', '*': 'ok-worker' },
  });
  const result = runDrive({ run: runId, repoRoot: root });
  assert.equal(result.outcome, 'paused_human_gate'); // repair succeeded, flow continued

  const all = events(root, runId);
  const reviewDispatches = ofType(all, 'actor_dispatched').filter(
    (e) => e.extra.actor_call_id === 'ac-review-g1-reviewer',
  );
  assert.deepEqual(
    reviewDispatches.map((e) => [e.extra.attempt, e.extra.attempt_reason]),
    [
      [1, 'initial'],
      [2, 'schema_repair'],
    ],
  );
  assert.equal(typeof reviewDispatches[1]!.extra.repair_appendix, 'string');

  // The rejected bytes are durable evidence outside the planned path.
  const rejected = ofType(all, 'actor_completed').find((e) => e.extra.output_valid === false);
  assert.ok(rejected);
  const rejectedPath = rejected.extra.output as string;
  assert.match(rejectedPath, /^artifacts\/attempts\/ac-review-g1-reviewer-a1/);
  assert.equal(
    readFileSync(join(root, '.fadeno', 'runs', runId, rejectedPath), 'utf8'),
    'not json at all',
  );

  // And the run still verifies clean end-to-end.
  runDecide({ run: runId, option: 'approve', repoRoot: root });
  runDrive({ run: runId, repoRoot: root });
  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.match(finding(verify, 'actor-attempts').detail, /4 dispatch\(es\) across 3 actor call\(s\)/);
});

test('engine: a dead executor pauses the run; explicit --bind substitution is the recorded recovery', (t) => {
  const { root, runId } = seed(t, {
    bindings: { worker: 'ok-worker', reviewer: 'dead', '*': 'ok-worker' },
  });

  const failed = runDrive({ run: runId, repoRoot: root });
  assert.equal(failed.outcome, 'executor_failed');
  const failures = ofType(events(root, runId), 'actor_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.extra.reason, 'exit_nonzero');
  assert.equal(failures[0]!.extra.exit_code, 3);

  const recovered = runDrive({ run: runId, repoRoot: root, bind: ['reviewer=ok-reviewer'] });
  assert.equal(recovered.outcome, 'paused_human_gate');

  const all = events(root, runId);
  const overrides = ofType(all, 'executor_override');
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0]!.extra.role, 'reviewer');
  assert.equal(overrides[0]!.extra.executor, 'ok-reviewer');
  assert.equal(overrides[0]!.extra.prior, 'dead');

  const reviewDispatches = ofType(all, 'actor_dispatched').filter(
    (e) => e.extra.actor_call_id === 'ac-review-g1-reviewer',
  );
  assert.deepEqual(
    reviewDispatches.map((e) => [e.extra.attempt, e.extra.attempt_reason, e.extra.executor]),
    [
      [1, 'initial', 'dead'],
      [2, 'executor_override', 'ok-reviewer'],
    ],
  );

  runDecide({ run: runId, option: 'approve', repoRoot: root });
  runDrive({ run: runId, repoRoot: root });
  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.match(finding(verify, 'executor-bindings').detail, /1 explicit override/);
});

/**
 * A role whose archetype declares `requires_write`, routed by an active
 * loadout onto a command delivery that declares it cannot write. The executor
 * would leave a witness file if it ever ran.
 */
const WRITE_GUARD_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: write-guard
description: One implementation step whose role declares a mutating archetype.
when_to_use:
  - engine write-capability tests
roles:
  builder:
    purpose: Implement the task.
    archetype: worker
flow:
  - id: implement
    kind: actor_call
    actor: builder
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;


test('verify: tampered profile snapshot fails executor-bindings', (t) => {
  const { root, runId } = completeHappyRun(t);
  const snapshotPath = join(root, '.fadeno', 'runs', runId, 'profile.yaml');
  writeFileSync(snapshotPath, `${readFileSync(snapshotPath, 'utf8')}\n# tampered\n`);

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, false);
  assert.match(finding(verify, 'executor-bindings').detail, /does not match its recorded sha256/);
});

test('verify: attempt gaps and unexplained redispatches fail actor-attempts', (t) => {
  const { root, runId } = completeHappyRun(t);
  const runDir = join(root, '.fadeno', 'runs', runId);
  new LedgerWriter(runDir).append(
    {
      type: 'actor_dispatched',
      step: 'review',
      actor: 'reviewer',
      step_execution_id: 'se-review-g1',
      actor_call_id: 'ac-review-g1-reviewer',
      attempt: 3,
      executor: 'ok-reviewer',
    },
    new Date(),
  );

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, false);
  const detail = finding(verify, 'actor-attempts').detail;
  assert.match(detail, /expected 1\.\.2/);
  assert.match(detail, /redispatched without an allowed reason/);
});

test('verify: a conflicting hand-appended resolution fails named-decisions', (t) => {
  const { root, runId } = completeHappyRun(t);
  const runDir = join(root, '.fadeno', 'runs', runId);
  new LedgerWriter(runDir).append(
    {
      type: 'decision_resolved',
      step: 'approve_release',
      decision_id: 'dec-approve_release-1',
      option: 'reject',
      resolved_by: 'tamper',
    },
    new Date(),
  );

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, false);
  assert.match(finding(verify, 'named-decisions').detail, /resolved as both "approve" and "reject"/);
});

test('supersede: validated at record time, excluded from active resolution, verified', (t) => {
  const { root, runId } = completeHappyRun(t);
  const runDir = join(root, '.fadeno', 'runs', runId);

  // Record-time validation: both sides must already be recorded artifacts.
  assert.throws(
    () =>
      runRun({
        run: runId,
        event: 'artifact_superseded',
        artifact: 'artifacts/ghost.md',
        fields: ['superseded_by=artifacts/notes.md'],
        repoRoot: root,
      }),
    RunError,
  );
  assert.throws(
    () =>
      runRun({
        run: runId,
        event: 'artifact_superseded',
        artifact: 'artifacts/notes.md',
        fields: ['superseded_by=artifacts/notes.md'],
        repoRoot: root,
      }),
    /different artifact/,
  );

  runRun({
    run: runId,
    event: 'artifact_superseded',
    artifact: 'artifacts/notes.md',
    fields: ['superseded_by=artifacts/summary.md'],
    repoRoot: root,
  });

  const all = events(root, runId);
  const active = resolveActiveArtifacts(all).active.map((a) => a.path);
  assert.ok(!active.includes('artifacts/notes.md'), 'superseded artifact must not be active');
  assert.ok(active.includes('artifacts/summary.md'));

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(finding(verify, 'artifact-supersede').status, 'ok');

  // Tamper: a forged supersession referencing a never-recorded artifact.
  new LedgerWriter(runDir).append(
    { type: 'artifact_superseded', step: null, artifact: 'artifacts/summary.md', superseded_by: 'artifacts/ghost.md' },
    new Date(),
  );
  const tampered = runVerify({ run: runId, repoRoot: root });
  assert.equal(tampered.ok, false);
  assert.match(finding(tampered, 'artifact-supersede').detail, /ghost\.md was never recorded/);
});

test('sessions: a minted session carries role memory across steps and the human pause', (t) => {
  const { root, runId } = seed(t, {
    bindings: { worker: 'session-worker', reviewer: 'ok-reviewer', '*': 'ok-worker' },
  });

  const paused = runDrive({ run: runId, repoRoot: root });
  assert.equal(paused.outcome, 'paused_human_gate');
  runDecide({ run: runId, option: 'approve', repoRoot: root });
  const done = runDrive({ run: runId, repoRoot: root });
  assert.equal(done.outcome, 'terminal');

  const all = events(root, runId);
  const workerDispatches = ofType(all, 'actor_dispatched').filter((e) => e.extra.actor === 'worker');
  assert.equal(workerDispatches.length, 2); // implement, then ship after the pause

  const [implementD, shipD] = workerDispatches;
  assert.equal(implementD!.extra.session, 'fresh');
  const sessionId = implementD!.extra.session_id;
  assert.equal(typeof sessionId, 'string');
  assert.equal(shipD!.extra.session, 'resumed');
  assert.equal(shipD!.extra.session_id, sessionId);
  assert.ok((shipD!.extra.command as string[]).includes(sessionId as string), 'resume argv carries the id');

  // The resumed call really saw the fresh call's state — memory, not re-derivation.
  const summary = readFileSync(join(root, '.fadeno', 'runs', runId, 'artifacts', 'summary.md'), 'utf8');
  assert.equal(summary, `RESUMED ${sessionId} remembered-work`);

  // The artifact born from resumed context is marked as such.
  const summaryEvent = ofType(all, 'artifact_created').find((e) => e.extra.artifact === 'artifacts/summary.md');
  assert.ok(summaryEvent);
  assert.equal(summaryEvent.extra.session, 'resumed');
  assert.equal(summaryEvent.extra.session_id, sessionId);

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.match(finding(verify, 'session-continuity').detail, /2 session dispatch\(es\), continuity holds/);
});

test('sessions: pattern-extracted id + repair resumes the session with only the repair message', (t) => {
  const { root, runId } = seed(t, {
    bindings: { worker: 'ok-worker', reviewer: 'flaky-session-reviewer', '*': 'ok-worker' },
  });
  const result = runDrive({ run: runId, repoRoot: root });
  assert.equal(result.outcome, 'paused_human_gate'); // repair succeeded on the resumed session

  const all = events(root, runId);
  const reviewDispatches = ofType(all, 'actor_dispatched').filter(
    (e) => e.extra.actor_call_id === 'ac-review-g1-reviewer',
  );
  assert.equal(reviewDispatches.length, 2);
  const [first, second] = reviewDispatches;

  // Fresh call: id unknown at dispatch, harvested from stderr onto the completion.
  assert.equal(first!.extra.session, 'fresh');
  assert.equal(first!.extra.session_id, undefined);
  const firstCompletion = ofType(all, 'actor_completed').find(
    (e) => e.extra.actor_call_id === 'ac-review-g1-reviewer' && e.extra.attempt === 1,
  );
  assert.ok(firstCompletion);
  assert.equal(firstCompletion.extra.output_valid, false);
  assert.equal(firstCompletion.extra.session_id, 'flk-001');

  // Repair attempt: resumed, and stdin was the repair message alone.
  assert.equal(second!.extra.attempt_reason, 'schema_repair');
  assert.equal(second!.extra.session, 'resumed');
  assert.equal(second!.extra.session_id, 'flk-001');
  const capturedStdin = readFileSync(join(root, 'stdin-a2.txt'), 'utf8');
  assert.equal(capturedStdin, second!.extra.repair_appendix);
  assert.match(capturedStdin, /^REPAIR: your previous output failed schema validation:/);
  assert.ok(!capturedStdin.includes('# Fadeno'), 'resumed repair must not re-send the assembled prompt');

  runDecide({ run: runId, option: 'approve', repoRoot: root });
  runDrive({ run: runId, repoRoot: root });
  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, true);
  assert.equal(finding(verify, 'session-continuity').status, 'ok');
});

test('verify: a forged resumed dispatch with an unknown session fails session-continuity', (t) => {
  const { root, runId } = completeHappyRun(t);
  new LedgerWriter(join(root, '.fadeno', 'runs', runId)).append(
    {
      type: 'actor_dispatched',
      step: 'ship',
      actor: 'worker',
      step_execution_id: 'se-ship-g1',
      actor_call_id: 'ac-ship-g1-worker',
      attempt: 2,
      attempt_reason: 'user_retry',
      executor: 'ok-worker',
      session: 'resumed',
      session_id: 'sess-zzz',
    },
    new Date(),
  );

  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, false);
  assert.match(
    finding(verify, 'session-continuity').detail,
    /resumed session sess-zzz was never recorded earlier/,
  );
});

test.skip('sessions: profile validation rejects resume without an id source, and double id sources', (t) => {
  // Skipped per G2: old executors profile validation is now at route level (v3); covered by dials-kernel tests
});

test('engine: refuses legacy ledgers and honors the transition cap', (t) => {
  const { root, runId } = seed(t);

  const capped = runDrive({ run: runId, repoRoot: root, maxTransitions: 1 });
  assert.equal(capped.outcome, 'max_transitions');

  const legacyDir = join(root, '.fadeno', 'runs', '2026-01-01-0000-legacy');
  mkdirSync(join(legacyDir, 'artifacts'), { recursive: true });
  writeFileSync(
    join(legacyDir, 'run.yaml'),
    ['run_id: 2026-01-01-0000-legacy', 'playbook: engine-e2e', 'status: running', 'task: t', 'host: cli', ''].join('\n'),
  );
  writeFileSync(join(legacyDir, 'events.jsonl'), '{"type":"run_started","step":null}\n');
  assert.throws(() => runDrive({ run: '2026-01-01-0000-legacy', repoRoot: root }), /legacy ledger/);
  assert.throws(() => runDrive({ run: '2026-01-01-0000-legacy', repoRoot: root }), DriveError);
});

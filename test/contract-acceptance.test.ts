import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDecide } from '../src/commands/decide.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runPrompt } from '../src/commands/prompt.ts';
import { runVerify } from '../src/commands/verify.ts';
import { resolveActiveArtifacts } from '../src/lib/artifact-manifest.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { resolveStepPlan } from '../src/lib/prompt-resolve.ts';
import { tempRepo } from './helpers.ts';

function seedParallelWorkstreamsRun(t: TestContext): { root: string; runId: string; runDir: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const execSpecs: Record<string, { command: string[] }> = {
    'coord-exec': { command: ['node', '-e', "process.stdout.write('# Contract\\n\\ncontent')"] },
    'w1-exec': { command: ['node', '-e', "process.stdout.write('ok')"] },
    'w2-exec': { command: ['node', '-e', "process.stdout.write('ok')"] },
    'w3-exec': { command: ['node', '-e', "process.stdout.write('ok')"] },
    'integ-exec': { command: ['node', '-e', "process.stdout.write('integrated')"] },
    'rev-exec': { command: ['node', '-e', `process.stdout.write(JSON.stringify({reviewer:'r',summary:'s',issues:[],verdict:'approve'}))`] },
  };
  const models: Record<string, unknown> = {};
  const routesStandalone: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(execSpecs)) {
    const provider = name.replace(/-/g, '_') + '_p';
    models[name] = { provider, id: name, effort: 'high' };
    routesStandalone[provider] = { command: spec.command, };
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
    archetypes: { worker: {}, reviewer: {}, coordinator: {} },
    dials: {
      coordinator: 'coord-exec',
      workstream_1: 'w1-exec',
      workstream_2: 'w2-exec',
      workstream_3: 'w3-exec',
      integrator: 'integ-exec',
      integration_reviewer: 'rev-exec',
    },
    bindings: {
      coordinator: 'coord-exec',
      workstream_1: 'w1-exec',
      workstream_2: 'w2-exec',
      workstream_3: 'w3-exec',
      integrator: 'integ-exec',
      integration_reviewer: 'rev-exec',
    },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'parallel-workstreams', task: 'contract acceptance test' });
  return { root, runId, runDir };
}

function eventsOf(root: string, runId: string) {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

test('contract approve-first reaches run_workstreams without revise_contract', (t: TestContext) => {
  const { root, runId } = seedParallelWorkstreamsRun(t);
  let res = runDrive({ repoRoot: root, run: runId });
  let attempts = 0;
  while (res.outcome !== 'paused_human_gate' && attempts < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    attempts += 1;
  }
  assert.equal(res.outcome, 'paused_human_gate');
  const ev = eventsOf(root, runId);
  const req = ev.find((e) => e.type === 'decision_requested' && e.step === 'accept_contract');
  assert.ok(req, 'accept_contract decision_requested must exist');
  assert.equal(typeof req.extra.decision_id, 'string');
  runDecide({ repoRoot: root, run: runId, step: 'accept_contract', option: 'approve' });
  res = runDrive({ repoRoot: root, run: runId });
  const ev2 = eventsOf(root, runId);
  const startedRevise = ev2.some((e) => e.type === 'step_started' && e.step === 'revise_contract');
  assert.equal(startedRevise, false, 'revise_contract must not start after approve');
  const contractV2Exists = ev2.some((e) => e.type === 'artifact_created' && e.extra.artifact === 'artifacts/contract.v2.md');
  assert.equal(contractV2Exists, false, 'contract.v2 must not exist after approve');
  const active = resolveActiveArtifacts(ev2);
  const contractActive = active.active.find((a) => a.logicalName === 'artifacts/contract.md');
  assert.ok(contractActive, 'active contract must exist after approve');
  assert.equal(contractActive.generation, 1, 'approve-first active generation must be 1');
});

test('contract reject with feedback does not start workstreams', (t: TestContext) => {
  const { root, runId } = seedParallelWorkstreamsRun(t);
  let res = runDrive({ repoRoot: root, run: runId });
  let attempts = 0;
  while (res.outcome !== 'paused_human_gate' && attempts < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    attempts += 1;
  }
  assert.equal(res.outcome, 'paused_human_gate');
  runDecide({ repoRoot: root, run: runId, step: 'accept_contract', option: 'reject', feedback: 'manifests overlap on src/lib/executors.ts' });
  res = runDrive({ repoRoot: root, run: runId });
  const ev = eventsOf(root, runId);
  const startedWorkstreams = ev.some((e) => e.type === 'step_started' && e.step === 'run_workstreams');
  assert.equal(startedWorkstreams, false, 'workstreams must not start after reject');
  const startedRevise = ev.some((e) => e.type === 'step_started' && e.step === 'revise_contract');
  assert.equal(startedRevise, true, 'revise_contract must start after reject');
  const rejected = ev.find((e) => e.type === 'decision_resolved' && e.step === 'accept_contract');
  assert.ok(rejected, 'decision_resolved for accept_contract must exist');
  assert.equal(rejected.extra.option, 'reject');
  assert.equal(rejected.extra.feedback, 'manifests overlap on src/lib/executors.ts');
});

test('generation-2 prompt input carries both contracts and authority note', (t: TestContext) => {
  const { root, runId } = seedParallelWorkstreamsRun(t);
  let res = runDrive({ repoRoot: root, run: runId });
  let attempts = 0;
  while (res.outcome !== 'paused_human_gate' && attempts < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    attempts += 1;
  }
  runDecide({ repoRoot: root, run: runId, step: 'accept_contract', option: 'reject', feedback: 'needs more detail' });
  res = runDrive({ repoRoot: root, run: runId });
  let ev = eventsOf(root, runId);
  let tries = 0;
  while (!ev.find((e) => e.type === 'artifact_created' && e.extra.artifact === 'artifacts/contract.v2.md') && tries < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    ev = eventsOf(root, runId);
    tries += 1;
    if (existsSync(join(root, '.fadeno', 'runs', runId, 'artifacts', 'contract.v2.md'))) break;
  }
  const v2Created = ev.find((e) => e.type === 'artifact_created' && e.extra.artifact === 'artifacts/contract.v2.md');
  assert.ok(v2Created, `v2 contract must be created, artifacts: ${JSON.stringify(ev.filter((e)=>e.type==='artifact_created').map((e)=>e.extra.artifact))}`);
  const active = resolveActiveArtifacts(ev);
  const contractActive = active.active.find((a) => a.logicalName === 'artifacts/contract.md');
  assert.ok(contractActive, 'active contract must exist');
  assert.equal(contractActive.generation, 2, 'active generation must be exactly 2');
  assert.equal(contractActive.path, 'artifacts/contract.v2.md', 'active path must be v2');
  assert.equal(active.immutabilityViolations.length, 0);
  assert.equal(active.conflicts.length, 0);
  const promptEvents = ev.filter((e) => e.type === 'prompt_assembled' && e.step === 'revise_contract');
  assert.ok(promptEvents.length > 0, 'revise_contract prompt_assembled event must exist');
  const promptPath = promptEvents[0]!.extra.prompt_path;
  assert.equal(typeof promptPath, 'string', 'prompt_path must be a string');
  assert.ok((promptPath as string).length > 0, 'prompt_path must not be empty');
  const promptText = readFileSync(join(root, '.fadeno', 'runs', runId, promptPath as string), 'utf8');
  assert.match(promptText, /Decision context/);
  assert.match(promptText, /accept_contract/);
  assert.match(promptText, /dec-accept_contract-1/);
  assert.match(promptText, /needs more detail/);
  assert.match(promptText, /was rejected/);
  // authority note: highest generation is authoritative and complete replacement
  assert.match(promptText, /highest generation is authoritative/);
  // Contract input must be the produced Contract as files, not an assembled aggregate.
  // revise_contract prompt is cut off before v2, so it should list the generation-1 contract file
  // and must not be misclassified as an aggregate (the P2 prompt-resolve fix).
  const revisePlan = runPrompt({ repoRoot: root, run: runId, step: 'revise_contract' }).plan;
  const contractInput = revisePlan.inputs.find((i) => i.artifact === 'Contract');
  assert.ok(contractInput, 'revise_contract Contract input must be resolved');
  assert.equal(contractInput.isAssembledAggregate, false, 'non-map producer with output_path must not be misclassified as aggregate');
  assert.equal(contractInput.aggregatePath, null);
  assert.ok(contractInput.files.length >= 1, 'Contract files must be non-empty');
  assert.ok(contractInput.files.some((f) => f.path === 'artifacts/contract.md'), `Contract prompt must list artifacts/contract.md, got ${JSON.stringify(contractInput.files.map(f=>f.path))}`);
  assert.match(promptText, /artifacts\/contract\.md/, 'prompt inputs section must list the contract file path');
  assert.match(promptText, /produced by step `fix_contract`/, 'prompt must attribute contract to fix_contract');
  // After reaccept approve, workstreams see the authoritative generation-2 contract as active
  runDecide({ repoRoot: root, run: runId, step: 'reaccept_contract', option: 'approve' });
  res = runDrive({ repoRoot: root, run: runId });
  ev = eventsOf(root, runId);
  const startedWorkstreams = ev.some((e) => e.type === 'step_started' && e.step === 'run_workstreams');
  assert.equal(startedWorkstreams, true, 'run_workstreams must start after reaccept approve');
  // Verify workstream prompt also sees authoritative contract (generation 2 file)
  const wsPlan = runPrompt({ repoRoot: root, run: runId, step: 'run_workstreams', actor: 'workstream_1' }).plan;
  const wsContract = wsPlan.inputs.find((i) => i.artifact === 'Contract');
  assert.ok(wsContract, 'workstream Contract input must be resolved');
  assert.equal(wsContract.isAssembledAggregate, false);
  // Active resolution now selects v2; the prompt should reference the v2 path or the logical name
  assert.ok(wsContract.files.some((f) => f.path === 'artifacts/contract.v2.md' || f.path === 'artifacts/contract.md'), `workstream must see authoritative contract; got ${JSON.stringify(wsContract.files)}`);
});

test('reject → reject terminates failed without workstreams', (t: TestContext) => {
  const { root, runId } = seedParallelWorkstreamsRun(t);
  let res = runDrive({ repoRoot: root, run: runId });
  let attempts = 0;
  while (res.outcome !== 'paused_human_gate' && attempts < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    attempts += 1;
  }
  runDecide({ repoRoot: root, run: runId, step: 'accept_contract', option: 'reject', feedback: 'bad' });
  res = runDrive({ repoRoot: root, run: runId });
  // Now at reaccept
  const evMid = eventsOf(root, runId);
  const reacceptReq = evMid.find((e) => e.type === 'decision_requested' && e.step === 'reaccept_contract');
  assert.ok(reacceptReq, 'reaccept_contract decision_requested must exist');
  runDecide({ repoRoot: root, run: runId, step: 'reaccept_contract', option: 'reject', feedback: 'still bad' });
  res = runDrive({ repoRoot: root, run: runId });
  const ev = eventsOf(root, runId);
  const runYaml = readFileSync(join(root, '.fadeno', 'runs', runId, 'run.yaml'), 'utf8');
  assert.match(runYaml, /status: failed/);
  const startedWorkstreams = ev.some((e) => e.type === 'step_started' && e.step === 'run_workstreams');
  assert.equal(startedWorkstreams, false, 'workstreams must not start after second reject');
  const contractRejectedStarted = ev.some((e) => e.type === 'step_started' && e.step === 'contract_rejected');
  assert.equal(contractRejectedStarted, true, 'contract_rejected must start after second reject');
  assert.equal(res.outcome, 'terminal');
  assert.equal(res.status, 'failed');
});

test('prompt-resolve: non-map producer with output_path resolves as files not aggregate', () => {
  // Direct regression for src/lib/prompt-resolve.ts:275 — a non-map producer that carries
  // a plain output_path must not be misclassified as an assembled map aggregate.
  // The old code was `producer != null && producer.output_path != null` without checking `over`.
  // That would make a compare → done flow (a bakeoff) resolve ModelComparison with files:[].
  const playbook: any = {
    name: 'aggregate-regression',
    schema_version: '0.1',
    roles: { a: { purpose: 'maker' }, b: { purpose: 'user' } },
    flow: [
      { id: 'make_contract', kind: 'actor_call', actor: 'a', output: 'Contract', output_path: 'artifacts/contract.md' },
      { id: 'use_contract', kind: 'actor_call', actor: 'b', input: ['Contract'], output: 'Result' },
    ],
  };
  const events: any[] = [
    { type: 'run_started', step: null, seq: 1, timestamp: '2026-01-01T00:00:00Z', extra: {} },
    { type: 'step_started', step: 'make_contract', seq: 2, timestamp: '2026-01-01T00:00:01Z', extra: {} },
    { type: 'artifact_created', step: 'make_contract', seq: 3, timestamp: '2026-01-01T00:00:02Z', extra: { artifact: 'artifacts/contract.md', member: undefined } },
    { type: 'step_started', step: 'use_contract', seq: 4, timestamp: '2026-01-01T00:00:03Z', extra: {} },
  ];
  // Before fix, this would return isAssembledAggregate true with files [].
  const plan = resolveStepPlan(playbook, events, { step: 'use_contract', actor: 'b', iteration: null });
  const input = plan.inputs.find((i) => i.artifact === 'Contract');
  assert.ok(input, 'Contract input must be resolved');
  assert.equal(input.isAssembledAggregate, false, 'non-map producer with output_path must not be aggregate');
  assert.equal(input.aggregatePath, null);
  assert.equal(input.files.length, 1);
  assert.equal(input.files[0]!.path, 'artifacts/contract.md');

  // Also verify the bakeoff pattern: compare (non-map) with output_path .fadeno/bakeoffs/bakeoff.md
  // must not become an aggregate for its consumer.
  const playbook2: any = {
    name: 'bakeoff',
    schema_version: '0.1',
    roles: { comparison_judge: { purpose: 'judge' }, coordinator: { purpose: 'coord' } },
    flow: [
      { id: 'compare', kind: 'evaluator', actor: 'comparison_judge', input: ['WorkSpec', 'CandidateResult[]'], output: 'Bakeoff', output_path: '.fadeno/bakeoffs/bakeoff.md' },
      { id: 'done', kind: 'actor_call', actor: 'coordinator', input: ['Bakeoff'], output: 'FinalSummary' },
    ],
  };
  const events2: any[] = [
    { type: 'run_started', step: null, seq: 1, timestamp: '2026-01-01T00:00:00Z', extra: {} },
    { type: 'step_started', step: 'compare', seq: 2, timestamp: '2026-01-01T00:00:01Z', extra: {} },
    { type: 'artifact_created', step: 'compare', seq: 3, timestamp: '2026-01-01T00:00:02Z', extra: { artifact: '.fadeno/bakeoffs/bakeoff.md' } },
    { type: 'step_started', step: 'done', seq: 4, timestamp: '2026-01-01T00:00:03Z', extra: {} },
  ];
  const plan2 = resolveStepPlan(playbook2, events2, { step: 'done', actor: 'coordinator', iteration: null });
  const mc = plan2.inputs.find((i) => i.artifact === 'Bakeoff');
  assert.ok(mc, 'ModelComparison must be resolved');
  assert.equal(mc.isAssembledAggregate, false);
  assert.equal(mc.files.length, 1);
  assert.equal(mc.files[0]!.path, '.fadeno/bakeoffs/bakeoff.md');

  // Preserve map-aggregate behavior: a map over roles with output_path should still produce an aggregate.
  const playbookMap: any = {
    name: 'map-aggregate',
    schema_version: '0.1',
    roles: { a: { purpose: 'w' }, b: { purpose: 'w' } },
    flow: [
      { id: 'fan', kind: 'map', over: ['a', 'b'], output: 'ReviewReport[]', output_path: { a: 'artifacts/review.a.json', b: 'artifacts/review.b.json' } },
      { id: 'gate', kind: 'gate', input: ['ReviewReport[]'], condition: 'all_reviews_approved', on_pass: 'done', on_fail: 'rev' },
      { id: 'done', kind: 'actor_call', actor: 'a', input: ['ReviewReport[]'], output: 'FinalSummary' },
    ],
  };
  const eventsMap: any[] = [
    { type: 'run_started', step: null, seq: 1, timestamp: '2026-01-01T00:00:00Z', extra: {} },
    { type: 'step_started', step: 'fan', seq: 2, timestamp: '2026-01-01T00:00:01Z', extra: {} },
    { type: 'artifact_created', step: 'fan', seq: 3, timestamp: '2026-01-01T00:00:02Z', extra: { artifact: 'artifacts/review.a.json', member: 'a' } },
    { type: 'artifact_created', step: 'fan', seq: 4, timestamp: '2026-01-01T00:00:03Z', extra: { artifact: 'artifacts/review.b.json', member: 'b' } },
    { type: 'artifact_created', step: 'fan', seq: 5, timestamp: '2026-01-01T00:00:04Z', extra: { artifact: 'artifacts/review.json' } },
    { type: 'step_started', step: 'done', seq: 6, timestamp: '2026-01-01T00:00:05Z', extra: {} },
  ];
  const mapPlan = resolveStepPlan(playbookMap, eventsMap, { step: 'done', actor: 'a', iteration: null });
  const reportInput = mapPlan.inputs.find((i) => i.artifact === 'ReviewReport[]' || i.artifact === 'ReviewReport');
  // The input is ReviewReport[]; the consumer done sees members plus aggregate annotation.
  assert.ok(reportInput, 'map aggregate input must be resolved');
  assert.equal(reportInput.isAssembledAggregate, true, 'map with output_path should still be aggregate');
  assert.ok(reportInput.aggregatePath === 'artifacts/review.json', `aggregatePath should be artifacts/review.json, got ${reportInput.aggregatePath}`);
  assert.equal(reportInput.files.length, 2, 'member files must be listed');
});

test('prompt cutoff stability: re-render with same cutoff is byte-identical', (t: TestContext) => {
  const { root, runId } = seedParallelWorkstreamsRun(t);
  let res = runDrive({ repoRoot: root, run: runId });
  let attempts = 0;
  while (res.outcome !== 'paused_human_gate' && attempts < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    attempts += 1;
  }
  runDecide({ repoRoot: root, run: runId, step: 'accept_contract', option: 'reject', feedback: 'feedback for cutoff' });
  // Start revise_contract so its prompt has a real cutoff (step_started index), not a preview spanEnd.
  res = runDrive({ repoRoot: root, run: runId });
  // Drive until reaccept is pending or until revise artifact exists — we need a real step_started for revise_contract.
  let ev = eventsOf(root, runId);
  let tries = 0;
  while (!ev.some((e) => e.type === 'step_started' && e.step === 'revise_contract') && tries < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    ev = eventsOf(root, runId);
    tries += 1;
  }
  const p1 = runPrompt({ repoRoot: root, run: runId, step: 'revise_contract' });
  const p1Cutoff = p1.plan.cutoffLine;
  assert.match(p1.prompt, /Decision context/, 'prompt must contain Decision context');
  assert.match(p1.prompt, /feedback for cutoff/, 'prompt must contain rejection feedback');
  assert.match(p1.prompt, /dec-accept_contract-1/, 'prompt must contain decision id');
  // Immediate second render without ledger change must be byte-identical (baseline).
  const p2 = runPrompt({ repoRoot: root, run: runId, step: 'revise_contract' });
  assert.equal(p1.prompt, p2.prompt, 're-rendered prompts must be byte-identical');
  assert.equal(p1.sha256, p2.sha256);
  assert.equal(p1Cutoff, p2.plan.cutoffLine, 'cutoff must be stable without ledger change');

  // Append a later rejection after the first prompt's cutoff (reaccept_contract reject).
  // A cutoff-unaware implementation that scans globally would pick up this later rejection.
  ev = eventsOf(root, runId);
  // Drive to finish revise_contract and reach reaccept gate, then reject it.
  tries = 0;
  while (!ev.find((e) => e.type === 'decision_requested' && e.step === 'reaccept_contract') && tries < 10) {
    res = runDrive({ repoRoot: root, run: runId });
    ev = eventsOf(root, runId);
    tries += 1;
  }
  const reacceptReq = ev.find((e) => e.type === 'decision_requested' && e.step === 'reaccept_contract');
  assert.ok(reacceptReq, 'reaccept_contract decision_requested must exist for cutoff test');
  runDecide({ repoRoot: root, run: runId, step: 'reaccept_contract', option: 'reject', feedback: 'second rejection for stability' });
  res = runDrive({ repoRoot: root, run: runId });

  // Re-render the earlier targeted prompt; it must remain bound to first decision, not the later one.
  const p3 = runPrompt({ repoRoot: root, run: runId, step: 'revise_contract' });
  assert.equal(p1.prompt, p3.prompt, 'earlier prompt must remain byte-identical after later rejection appended');
  assert.equal(p1.sha256, p3.sha256);
  assert.equal(p1Cutoff, p3.plan.cutoffLine, 'cutoff must not advance for earlier step after later events');
  assert.match(p3.prompt, /dec-accept_contract-1/);
  assert.match(p3.prompt, /feedback for cutoff/);
  assert.doesNotMatch(p3.prompt, /second rejection for stability/, 'earlier prompt must not pick up later rejection feedback');
  assert.doesNotMatch(p3.prompt, /dec-reaccept_contract-1/, 'earlier prompt must not pick up later decision id');
});

test('contract clean verify requires ok checks', (t: TestContext) => {
  const { root, runId } = seedParallelWorkstreamsRun(t);
  let res = runDrive({ repoRoot: root, run: runId });
  let attempts = 0;
  while (res.outcome !== 'paused_human_gate' && attempts < 5) {
    res = runDrive({ repoRoot: root, run: runId });
    attempts += 1;
  }
  runDecide({ repoRoot: root, run: runId, step: 'accept_contract', option: 'approve' });
  res = runDrive({ repoRoot: root, run: runId });
  const verify = runVerify({ repoRoot: root, run: runId });
  const immut = verify.findings.find((f) => f.check === 'artifact-immutability');
  assert.ok(immut, 'artifact-immutability finding must exist');
  assert.equal(immut.status, 'ok', 'artifact-immutability must be ok (not skip) for clean run');
  const resolution = verify.findings.find((f) => f.check === 'artifact-resolution');
  assert.ok(resolution);
  assert.equal(resolution.status, 'ok', 'artifact-resolution must be ok');
  const snapshots = verify.findings.find((f) => f.check === 'prompt-snapshots');
  assert.ok(snapshots);
  assert.equal(snapshots.status, 'ok', 'prompt-snapshots must be ok');
});

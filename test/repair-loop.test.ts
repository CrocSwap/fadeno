import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runDrive } from '../src/commands/drive.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { resolveActiveArtifacts } from '../src/lib/artifact-manifest.ts';
import { parseGeneration } from '../src/lib/prompt-resolve.ts';
import { tempRepo } from './helpers.ts';

test('code-change-review and parallel-workstreams have max_iterations 2 for repair', async () => {
  const { parse } = await import('yaml');
  const cc = parse(readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'playbooks', 'code-change-review.yaml'), 'utf8'));
  const pw = parse(readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'playbooks', 'parallel-workstreams.yaml'), 'utf8'));
  const ccLoop = (cc.flow as any[]).find((s: any) => s.id === 'revise');
  const pwLoop = (pw.flow as any[]).find((s: any) => s.id === 'rework');
  assert.equal(ccLoop.max_iterations, 2);
  assert.equal(pwLoop.max_iterations, 2);
  assert.equal(cc.policies.max_revision_loops, 2);
  assert.equal(pw.policies.max_revision_loops, 2);
  assert.equal(pw.limits.max_iterations, 2);
  assert.equal(pw.limits.max_actor_calls, 14);
});

test('generation parsing yields .v2 and .v3 with active resolution', () => {
  assert.deepEqual(parseGeneration('artifacts/implementation-result.v2.md'), { logicalPath: 'artifacts/implementation-result.md', generation: 2 });
  assert.deepEqual(parseGeneration('artifacts/implementation-result.v3.md'), { logicalPath: 'artifacts/implementation-result.md', generation: 3 });
  assert.deepEqual(parseGeneration('artifacts/parts/review_revision/substance_reviewer.v2.json'), { logicalPath: 'artifacts/parts/review_revision/substance_reviewer.json', generation: 2 });
  assert.deepEqual(parseGeneration('artifacts/parts/review_revision.v3.json'), { logicalPath: 'artifacts/parts/review_revision.json', generation: 3 });
});

function seedCodeChangeReviewWithFailingReviews(t: TestContext): { root: string; runId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const failingReview = `process.stdout.write(JSON.stringify({reviewer:'r',summary:'s',issues:[{severity:'blocking',title:'t'}],verdict:'request_changes'}))`;
  const execSpecs: Record<string, { command: string[] }> = {
    'coord-exec': { command: ['node', '-e', "process.stdout.write('plan')"] },
    'impl-exec': { command: ['node', '-e', "process.stdout.write('impl')"] },
    'rev-exec': { command: ['node', '-e', failingReview] },
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
      implementer: 'impl-exec',
      substance_reviewer: 'rev-exec',
      style_reviewer: 'rev-exec',
    },
    bindings: {
      coordinator: 'coord-exec',
      implementer: 'impl-exec',
      substance_reviewer: 'rev-exec',
      style_reviewer: 'rev-exec',
      worker: 'impl-exec',
      reviewer: 'rev-exec',
    },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  const { runId } = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'repair loop test' });
  return { root, runId };
}

test('engine: two repair iterations produce .v2 and .v3, active generation 3, generation-scoped identities, honest failed exhaustion', (t: TestContext) => {
  const { root, runId } = seedCodeChangeReviewWithFailingReviews(t);
  let res = runDrive({ repoRoot: root, run: runId });
  // The engine drives the entire flow (including two failing revise iterations) in one call
  // because all steps are command-backed. It should terminate as failed via on_exhausted.
  assert.equal(res.outcome, 'terminal', `expected terminal, got ${res.outcome} ${res.detail}`);
  assert.equal(res.status, 'failed', 'exhaustion after second failed revision must be terminal failed');

  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events;

  // .v2 and .v3 artifacts must exist for both implement_revision and review_revision
  const artifacts = ev.filter((e) => e.type === 'artifact_created').map((e) => e.extra.artifact as string);
  assert.ok(artifacts.includes('artifacts/implementation-result.v2.md'), `missing .v2 implement, have ${artifacts.join(', ')}`);
  assert.ok(artifacts.includes('artifacts/implementation-result.v3.md'), `missing .v3 implement, have ${artifacts.join(', ')}`);
  assert.ok(artifacts.includes('artifacts/parts/review_revision/substance_reviewer.v2.json'));
  assert.ok(artifacts.includes('artifacts/parts/review_revision/substance_reviewer.v3.json'));
  assert.ok(artifacts.includes('artifacts/parts/review_revision.v3.json'), 'collective .v3 must exist');

  // Active resolution selects generation 3 as authoritative
  const active = resolveActiveArtifacts(ev);
  const implActive = active.active.find((a) => a.logicalName === 'artifacts/implementation-result.md');
  assert.ok(implActive, 'active implementation-result must exist');
  assert.equal(implActive.generation, 3, 'active generation must be 3 after two revisions');
  assert.equal(implActive.path, 'artifacts/implementation-result.v3.md');
  const reviewActive = active.active.find((a) => a.logicalName === 'artifacts/parts/review_revision.json');
  assert.ok(reviewActive);
  assert.equal(reviewActive.generation, 3);
  assert.equal(active.conflicts.length, 0);
  assert.equal(active.immutabilityViolations.length, 0);

  // Generation-scoped actor call identities
  const dispatches = ev.filter((e) => e.type === 'actor_dispatched');
  const implementDispatches = dispatches.filter((e) => (e.extra.actor_call_id as string).startsWith('ac-implement_revision-'));
  assert.equal(implementDispatches.length, 2, 'exactly two implement_revision dispatches (g1 -> v2, g2 -> v3)');
  const g1 = implementDispatches.find((e) => e.extra.actor_call_id === 'ac-implement_revision-g1-implementer');
  const g2 = implementDispatches.find((e) => e.extra.actor_call_id === 'ac-implement_revision-g2-implementer');
  assert.ok(g1, 'g1 identity must be ac-implement_revision-g1-implementer');
  assert.ok(g2, 'g2 identity must be ac-implement_revision-g2-implementer');
  assert.equal(g1.extra.step_execution_id, 'se-implement_revision-g1');
  assert.equal(g2.extra.step_execution_id, 'se-implement_revision-g2');

  const reviewDispatches = dispatches.filter((e) => (e.extra.actor_call_id as string).startsWith('ac-review_revision-'));
  // 2 iterations × 2 reviewers = 4 dispatches
  assert.equal(reviewDispatches.length, 4);
  assert.ok(reviewDispatches.some((e) => e.extra.actor_call_id === 'ac-review_revision-g1-substance_reviewer'));
  assert.ok(reviewDispatches.some((e) => e.extra.actor_call_id === 'ac-review_revision-g2-substance_reviewer'));

  // Honest exhaustion: loop evaluated twice and terminated via on_exhausted path.
  const iterations = ev.filter((e) => e.type === 'loop_iteration_started' && e.step === 'revise');
  assert.equal(iterations.length, 2, 'exactly two loop iterations started');
  // At least two gate evaluations for revise loop (one per iteration) and overall terminal is unresolved_review
  assert.ok(ev.some((e) => e.type === 'step_started' && e.step === 'unresolved_review'), 'must have started unresolved_review after exhaustion');
  assert.ok(ev.some((e) => e.type === 'run_failed'), 'must have recorded run_failed after exhaustion');
  const runYaml = readFileSync(join(root, '.fadeno', 'runs', runId, 'run.yaml'), 'utf8');
  assert.match(runYaml, /status: failed/);
});

test('engine: approval gate diverges from blocking-only — zero-blocking request_changes fails all_reviews_approved and starts revise', async (t: TestContext) => {
  // Proves priority 1 control-flow: same report would pass legacy no_blocking_issues
  // but must fail all_reviews_approved and enter the bounded revise loop.
  const { parse } = await import('yaml');
  // Ensure shipped playbook is actually wired to all_reviews_approved; reverting to no_blocking_issues must fail this test
  const cc = parse(readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'playbooks', 'code-change-review.yaml'), 'utf8'));
  const gate = (cc.flow as any[]).find((s: any) => s.id === 'review_gate');
  assert.equal(gate.condition, 'all_reviews_approved', 'shipped playbook must gate on all_reviews_approved');
  const loop = (cc.flow as any[]).find((s: any) => s.id === 'revise');
  assert.equal(loop.until, 'all_reviews_approved', 'loop until must be all_reviews_approved');

  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // reviewer returns request_changes with ZERO blocking issues (only minor) — legacy would pass
  const zeroBlockingRequestChanges = `process.stdout.write(JSON.stringify({reviewer:'alice',summary:'needs work',issues:[{severity:'minor',title:'nit'}],verdict:'request_changes'}))`;
  const execSpecs: Record<string, { command: string[] }> = {
    'coord-exec': { command: ['node', '-e', "process.stdout.write('plan')"] },
    'impl-exec': { command: ['node', '-e', "process.stdout.write('impl')"] },
    'rev-exec': { command: ['node', '-e', zeroBlockingRequestChanges] },
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
      implementer: 'impl-exec',
      substance_reviewer: 'rev-exec',
      style_reviewer: 'rev-exec',
    },
    bindings: {
      coordinator: 'coord-exec',
      implementer: 'impl-exec',
      substance_reviewer: 'rev-exec',
      style_reviewer: 'rev-exec',
      worker: 'impl-exec',
      reviewer: 'rev-exec',
    },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  const { runId } = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'approval divergence test' });
  const res = runDrive({ repoRoot: root, run: runId });
  assert.equal(res.outcome, 'terminal', `expected terminal after bounded retries, got ${res.outcome}`);
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events;
  const gates = ev.filter((e) => e.type === 'gate_evaluated' && e.extra.condition === 'all_reviews_approved');
  assert.ok(gates.length >= 1, 'must have at least one all_reviews_approved gate evaluation');
  assert.ok(gates.some((e) => e.extra.result === 'fail'), `all_reviews_approved must fail for zero-blocking request_changes, got ${JSON.stringify(gates.map((g:any)=>g.extra))}`);
  // Must have entered the revise loop — proves we branched to revise, not to test/final
  assert.ok(ev.some((e) => e.type === 'step_started' && e.step === 'revise'), 'revise loop must start');
  assert.ok(ev.some((e) => e.type === 'loop_iteration_started' && e.step === 'revise'), 'loop_iteration_started for revise must exist');
  assert.ok(ev.some((e) => e.type === 'step_started' && e.step === 'review_revision'), 'bounded review_revision must have been dispatched');
});

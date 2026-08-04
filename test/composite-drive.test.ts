import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatchComplete, runDispatchStart } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runShow } from '../src/commands/show.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { tempRepo } from './helpers.ts';

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.2"
name: compositional-review
description: Independently revise mapped work items.
roles:
  luna:
    purpose: Implement one work item.
  terra:
    purpose: Adversarially review one implementation.
  finalizer:
    purpose: Review and merge all completed items.
flow:
  - id: complete_items
    kind: map
    over: [item_1, item_2]
    as: item
    body: [revision_cycle]
    completion: all
  - id: revision_cycle
    kind: loop
    body: [implement, review]
    input: [ReviewReport]
    until: no_blocking_issues
    max_iterations: 3
    exhaustion: fail
  - id: implement
    kind: actor_call
    actor: luna
    output: Implementation
  - id: review
    kind: evaluator
    actor: terra
    input: [Implementation]
    output: ReviewReport
  - id: final_review
    kind: reduce
    actor: finalizer
    input: ["ReviewReport[]"]
    output: FinalSummary
    terminal_status: completed
`;

const LOOP_MAP_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.2"
name: loop-map-review
description: Repeat a mapped review batch as one bounded generation.
roles:
  terra:
    purpose: Review one item.
  finalizer:
    purpose: Summarize the converged batch.
flow:
  - id: convergence
    kind: loop
    body: [reviews]
    input: ["ReviewReport[]"]
    until: no_blocking_issues
    max_iterations: 2
    on_success: finish
    on_exhausted: finish
  - id: reviews
    kind: map
    over: [item_a, item_b]
    as: item
    body: [review]
    completion: all
  - id: review
    kind: evaluator
    actor: terra
    output: ReviewReport
  - id: finish
    kind: actor_call
    actor: finalizer
    input: ["ReviewReport[]"]
    output: FinalSummary
    terminal_status: completed
`;

const cleanReview = (reviewer: string): string => JSON.stringify({
  reviewer,
  summary: 'clean',
  issues: [],
  verdict: 'approve',
});

const blockingReview = JSON.stringify({
  reviewer: 'terra',
  summary: 'revision required',
  issues: [{ severity: 'blocking', title: 'fix it', detail: 'required' }],
  verdict: 'request_changes',
});

function seed(t: TestContext): { root: string; runId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'compositional-review.yaml'), PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      luna_native: { adapter: 'host', model: 'gpt-luna', reasoning_effort: 'xhigh', agent_type: 'worker' },
      terra_native: { adapter: 'host', model: 'gpt-terra', reasoning_effort: 'medium', agent_type: 'reviewer' },
      final_native: { adapter: 'host', model: 'gpt-sol', reasoning_effort: 'high', agent_type: 'reviewer' },
    },
    bindings: { luna: 'luna_native', terra: 'terra_native', finalizer: 'final_native' },
  }));
  return { root, runId: runNewRun({ playbook: 'compositional-review', task: 'Complete two items', repoRoot: root }).runId };
}

function completeRequests(root: string, runId: string, requests: ReturnType<typeof runDrive>['requests'], body: (request: (typeof requests)[number]) => string): void {
  for (const request of requests) {
    runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: `native-${request.mapMember}-${request.generation}-${request.actor}` });
    const output = join(root, `${request.dispatchId}.out`);
    writeFileSync(output, body(request));
    runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output });
  }
}

test('drive: map-of-loop members advance independently and reconverge', (t) => {
  const { root, runId } = seed(t);

  const implementations = runDrive({ repoRoot: root, run: runId });
  assert.equal(implementations.outcome, 'awaiting_host_dispatch');
  assert.deepEqual(implementations.requests.map((request) => [request.mapMember, request.generation, request.actor]), [
    ['item_1', 1, 'luna'],
    ['item_2', 1, 'luna'],
  ]);
  const runningMap = runShow({ repoRoot: root, run: runId }).projection!.steps.find((step) => step.id === 'complete_items')!;
  assert.deepEqual(runningMap.instances.map((instance) => [instance.member, instance.state]), [
    ['item_1', 'running'],
    ['item_2', 'running'],
  ]);
  completeRequests(root, runId, implementations.requests, (request) => `implementation for ${request.mapMember}`);

  const reviews = runDrive({ repoRoot: root, run: runId });
  assert.deepEqual(reviews.requests.map((request) => [request.mapMember, request.generation, request.actor]), [
    ['item_1', 1, 'terra'],
    ['item_2', 1, 'terra'],
  ]);
  completeRequests(root, runId, reviews.requests, (request) => request.mapMember === 'item_2' ? blockingReview : cleanReview('terra'));

  const revision = runDrive({ repoRoot: root, run: runId });
  assert.deepEqual(revision.requests.map((request) => [request.mapMember, request.generation, request.actor]), [
    ['item_2', 2, 'luna'],
  ]);
  completeRequests(root, runId, revision.requests, () => 'revised implementation');

  const rereview = runDrive({ repoRoot: root, run: runId });
  assert.deepEqual(rereview.requests.map((request) => [request.mapMember, request.generation, request.actor]), [
    ['item_2', 2, 'terra'],
  ]);
  completeRequests(root, runId, rereview.requests, () => cleanReview('terra'));

  const finalReview = runDrive({ repoRoot: root, run: runId });
  assert.deepEqual(finalReview.requests.map((request) => request.actor), ['finalizer']);
  const finalPrompt = readFileSync(join(root, '.fadeno', 'runs', runId, finalReview.requests[0]!.promptPath), 'utf8');
  assert.match(finalPrompt, /item_1/);
  assert.match(finalPrompt, /item_2/);
  completeRequests(root, runId, finalReview.requests, () => 'final integration complete');

  const done = runDrive({ repoRoot: root, run: runId });
  assert.equal(done.outcome, 'terminal');
  assert.equal(done.status, 'completed');

  const completedMap = runShow({ repoRoot: root, run: runId }).projection!.steps.find((step) => step.id === 'complete_items')!;
  assert.deepEqual(completedMap.instances.map((instance) => [instance.member, instance.state]), [
    ['item_1', 'completed'],
    ['item_2', 'completed'],
  ]);

  const events = readEvents(join(root, '.fadeno', 'runs', runId)).events;
  const generations = events.filter((event) => event.type === 'loop_iteration_started');
  assert.equal(generations.filter((event) => event.extra.member === 'item_1').length, 1);
  assert.equal(generations.filter((event) => event.extra.member === 'item_2').length, 2);
  assert.equal(runVerify({ repoRoot: root, run: runId }).ok, true);

  new LedgerWriter(join(root, '.fadeno', 'runs', runId)).append({
    type: 'step_started',
    step: 'implement',
    node_instance_id: 'complete_items[member=item_2]/revision_cycle[generation=2]/review',
    parent_instance_id: 'wrong-parent',
  }, new Date());
  const tampered = runVerify({ repoRoot: root, run: runId });
  assert.equal(tampered.findings.find((finding) => finding.check === 'node-instances')?.status, 'fail');
});

test('drive: a loop generation may contain a compositional map', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'loop-map-review.yaml'), LOOP_MAP_PLAYBOOK);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      terra_native: { adapter: 'host', model: 'gpt-terra', reasoning_effort: 'medium', agent_type: 'reviewer' },
      final_native: { adapter: 'host', model: 'gpt-sol', reasoning_effort: 'high', agent_type: 'worker' },
    },
    bindings: { terra: 'terra_native', finalizer: 'final_native' },
  }));
  const runId = runNewRun({ playbook: 'loop-map-review', task: 'Review two items together', repoRoot: root }).runId;

  const reviews = runDrive({ repoRoot: root, run: runId });
  assert.deepEqual(reviews.requests.map((request) => [request.mapMember, request.generation, request.actor]), [
    ['item_a', 1, 'terra'],
    ['item_b', 1, 'terra'],
  ]);
  completeRequests(root, runId, reviews.requests, () => cleanReview('terra'));

  const finish = runDrive({ repoRoot: root, run: runId });
  assert.deepEqual(finish.requests.map((request) => [request.mapMember, request.generation, request.actor]), [
    [undefined, undefined, 'finalizer'],
  ]);
  completeRequests(root, runId, finish.requests, () => 'all reviews converged');
  assert.equal(runDrive({ repoRoot: root, run: runId }).status, 'completed');
  assert.equal(runVerify({ repoRoot: root, run: runId }).ok, true);
});

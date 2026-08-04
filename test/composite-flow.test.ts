import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCompositeFrontier, type CompositePlaybook } from '../src/lib/composite-flow.ts';
import type { RunEvent } from '../src/lib/run-ledger.ts';

const MAP_LOOP: CompositePlaybook = {
  flow: [
    { id: 'complete_items', kind: 'map', over: ['item_1', 'item_2'], body: ['revision_cycle'], completion: 'all' },
    { id: 'revision_cycle', kind: 'loop', body: ['implement', 'review'], input: ['ReviewReport'], until: 'no_blocking_issues', max_iterations: 3 },
    { id: 'implement', kind: 'actor_call', actor: 'luna', output: 'Implementation' },
    { id: 'review', kind: 'evaluator', actor: 'terra', input: ['Implementation'], output: 'ReviewReport' },
  ],
};

const event = (type: string, instance: string, extra: Record<string, unknown> = {}): RunEvent => ({
  type,
  step: instance.split('/').at(-1)!.split('[')[0]!,
  timestamp: null,
  seq: null,
  extra: { node_instance_id: instance, ...extra },
});

test('composite frontier: map members start independent loop instances', () => {
  const frontier = computeCompositeFrontier(MAP_LOOP, []);
  assert.deepEqual(frontier.actions.map((action) => [action.kind, action.instance.id]), [
    ['start_loop', 'complete_items[member=item_1]/revision_cycle[generation=1]'],
    ['start_loop', 'complete_items[member=item_2]/revision_cycle[generation=1]'],
  ]);
});

test('composite frontier: one map member can advance while its peer remains earlier', () => {
  const oneLoop = 'complete_items[member=item_1]/revision_cycle[generation=1]';
  const twoLoop = 'complete_items[member=item_2]/revision_cycle[generation=1]';
  const events = [
    event('loop_iteration_started', oneLoop, { generation: 1 }),
    event('loop_iteration_started', twoLoop, { generation: 1 }),
    event('artifact_created', `${oneLoop}/implement`),
  ];
  const frontier = computeCompositeFrontier(MAP_LOOP, events);
  assert.deepEqual(frontier.actions.map((action) => [action.kind, action.instance.id]), [
    ['actor', `${oneLoop}/review`],
    ['actor', `${twoLoop}/implement`],
  ]);
});

test('composite frontier: only the failing member enters generation two', () => {
  const one = 'complete_items[member=item_1]/revision_cycle[generation=1]';
  const two = 'complete_items[member=item_2]/revision_cycle[generation=1]';
  const events = [
    event('loop_iteration_started', one, { generation: 1 }),
    event('artifact_created', `${one}/implement`),
    event('artifact_created', `${one}/review`),
    event('loop_condition_evaluated', one, { result: 'pass' }),
    event('loop_iteration_started', two, { generation: 1 }),
    event('artifact_created', `${two}/implement`),
    event('artifact_created', `${two}/review`),
    event('loop_condition_evaluated', two, { result: 'fail' }),
  ];
  const frontier = computeCompositeFrontier(MAP_LOOP, events);
  assert.deepEqual(frontier.actions.map((action) => [action.kind, action.instance.id]), [
    ['start_loop', 'complete_items[member=item_2]/revision_cycle[generation=2]'],
  ]);
});

test('composite frontier: loop may contain a map', () => {
  const playbook: CompositePlaybook = {
    flow: [
      { id: 'convergence', kind: 'loop', body: ['reviews'], input: ['ReviewReport[]'], until: 'no_blocking_issues', max_iterations: 2 },
      { id: 'reviews', kind: 'map', over: ['a', 'b'], body: ['review'] },
      { id: 'review', kind: 'evaluator', actor: 'terra', output: 'ReviewReport' },
    ],
  };
  const loop = 'convergence[generation=1]';
  const frontier = computeCompositeFrontier(playbook, [event('loop_iteration_started', loop, { generation: 1 })]);
  assert.deepEqual(frontier.actions.map((action) => action.instance.id), [
    `${loop}/reviews[member=a]/review`,
    `${loop}/reviews[member=b]/review`,
  ]);
});

test('composite frontier: completed loop bodies request deterministic evaluation', () => {
  const one = 'complete_items[member=item_1]/revision_cycle[generation=1]';
  const two = 'complete_items[member=item_2]/revision_cycle[generation=1]';
  const events = [one, two].flatMap((loop) => [
    event('loop_iteration_started', loop, { generation: 1 }),
    event('artifact_created', `${loop}/implement`),
    event('artifact_created', `${loop}/review`),
  ]);
  const frontier = computeCompositeFrontier(MAP_LOOP, events);
  assert.deepEqual(frontier.actions.map((action) => [action.kind, action.instance.id]), [
    ['evaluate_loop', one],
    ['evaluate_loop', two],
  ]);
});

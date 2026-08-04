import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actorCallIdFor,
  childNodeInstance,
  isDescendantInstance,
  loopGenerationInstance,
  mapMemberInstance,
  NodeInstanceError,
  nodeInstanceArtifactScope,
  parseNodeInstanceId,
  rootNodeInstance,
  stepExecutionIdFor,
} from '../src/lib/node-instance.ts';

test('node instance: map-of-loop identity is canonical and scoped', () => {
  const member = mapMemberInstance(null, 'complete_items', 'item 3/ci');
  const generation = loopGenerationInstance(member.id, 'revision_cycle', 2);
  const review = childNodeInstance(generation.id, 'review');

  assert.equal(
    review.id,
    'complete_items[member=item%203%2Fci]/revision_cycle[generation=2]/review',
  );
  assert.equal(review.parentId, generation.id);
  assert.equal(review.step, 'review');
  assert.equal(review.member, 'item 3/ci');
  assert.equal(review.generation, 2);
  assert.equal(
    nodeInstanceArtifactScope(review.id),
    'artifacts/instances/complete_items/member-item%203%2Fci/revision_cycle/g2/review',
  );
});

test('node instance: loop-of-map preserves the nearest selectors', () => {
  const outer = loopGenerationInstance(null, 'convergence', 3);
  const member = mapMemberInstance(outer.id, 'parallel_reviews', 'item_4');
  const review = childNodeInstance(member.id, 'review');

  assert.equal(review.member, 'item_4');
  assert.equal(review.generation, 3);
  assert.equal(parseNodeInstanceId(review.id).id, review.id);
  assert.equal(isDescendantInstance(outer.id, review.id), true);
  assert.equal(isDescendantInstance(review.id, outer.id), false);
});

test('node instance: dispatch identities include the complete execution path', () => {
  const one = childNodeInstance(loopGenerationInstance(mapMemberInstance(null, 'items', 'a').id, 'cycle', 1).id, 'review');
  const two = childNodeInstance(loopGenerationInstance(mapMemberInstance(null, 'items', 'b').id, 'cycle', 1).id, 'review');
  assert.notEqual(stepExecutionIdFor(one.id), stepExecutionIdFor(two.id));
  assert.notEqual(actorCallIdFor(one.id, 'terra'), actorCallIdFor(two.id, 'terra'));
  assert.notEqual(actorCallIdFor(one.id, 'terra'), actorCallIdFor(one.id, 'luna'));
  assert.match(stepExecutionIdFor(one.id), /^se-[0-9a-f]{20}$/);
});

test('node instance: roots and invalid/non-canonical encodings', () => {
  assert.equal(rootNodeInstance('frame').id, 'frame');
  for (const invalid of [
    '',
    '/frame',
    'BadStep',
    'items[member=]',
    'items[member=a%2fb]',
    'cycle[generation=0]',
    'cycle[generation=01]',
    'cycle[wat=1]',
  ]) {
    assert.throws(() => parseNodeInstanceId(invalid), NodeInstanceError, invalid);
  }
});

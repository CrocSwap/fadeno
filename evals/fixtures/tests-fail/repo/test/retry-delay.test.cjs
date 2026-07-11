const test = require('node:test');
const assert = require('node:assert/strict');

test('calculates ordinary retry delays', () => {
  const { getRetryDelay } = require('../src/retry-delay.cjs');
  assert.equal(getRetryDelay(0, 100), 100);
  assert.equal(getRetryDelay(3, 100), 800);
});

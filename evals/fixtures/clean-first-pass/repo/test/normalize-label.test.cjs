const test = require('node:test');
const assert = require('node:assert/strict');

test('normalizes ordinary labels', () => {
  const { normalizeLabel } = require('../src/normalize-label.cjs');
  assert.equal(normalizeLabel('  Hello, World!  '), 'hello-world');
  assert.equal(normalizeLabel('already-clean'), 'already-clean');
});

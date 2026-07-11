const test = require('node:test');
const assert = require('node:assert/strict');

test('accepts normal port values', () => {
  const { parsePort } = require('../src/parse-port.cjs');
  assert.equal(parsePort('3000'), 3000);
  assert.equal(parsePort(443), 443);
  assert.equal(parsePort(' 080 '), 80);
});

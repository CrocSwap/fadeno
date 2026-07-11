const test = require('node:test');
const assert = require('node:assert/strict');

test('remote contract needs the provided integration endpoint', () => {
  assert.ok(process.env.FADENO_EVAL_REMOTE_URL, 'FADENO_EVAL_REMOTE_URL is required for this check');
});

const test = require('node:test');
const assert = require('node:assert/strict');

test('status message reports the disconnected state', () => {
  const { statusMessage } = require('../src/status-message.cjs');
  assert.equal(statusMessage(), 'Remote service unavailable');
});

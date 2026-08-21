import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchability, type ExecutorSpec } from '../src/lib/executors.ts';

function hostSpec(fallback: string[] | null): ExecutorSpec {
  return {
    adapter: 'host',
    model: 'sonnet',
    fallbackCommand: fallback,
  } as unknown as ExecutorSpec;
}

test('a host spec with NO fallback reports that, not a re-entrancy it cannot have', () => {
  // `host_in_session` asserts that dispatching would shell out to this spec's
  // fallback_command and re-enter the harness. With no fallback_command that
  // claim is simply false, and the message sent a reader hunting for a
  // fallback that does not exist. Checking the harness first produced exactly
  // that for `current-host` under claude — a host adapter that declares no
  // command at all.
  const result = dispatchability(hostSpec(null), 'claude');
  assert.equal(result.supported, false);
  assert.equal(result.supported === false && result.reason, 'host_without_fallback');
});

test('a host spec WITH a fallback still reports re-entrancy on an in-session harness', () => {
  // The claude-harness `anthropic` route is `host: true` AND carries
  // `command: [claude, -p, …]`, so the re-entrancy claim is true there and
  // must survive the reordering.
  const result = dispatchability(hostSpec(['claude', '-p']), 'claude');
  assert.equal(result.supported, false);
  assert.equal(result.supported === false && result.reason, 'host_in_session');
});

test('the reorder cannot disturb the pair path', () => {
  // `pairCommandFallback` requires host_in_session AND commandRoutable, and a
  // host spec without a fallbackCommand is never commandRoutable — so no spec
  // whose reason changed here could have taken that branch. Asserted rather
  // than reasoned about, because the pair path silently degrading to "no
  // pair" is precisely the class of failure this repo keeps shipping.
  const withFallback = dispatchability(hostSpec(['claude', '-p']), 'claude');
  assert.equal(withFallback.supported === false && withFallback.reason, 'host_in_session');
  const withoutFallback = dispatchability(hostSpec(null), 'claude');
  assert.notEqual(withoutFallback.supported === false && withoutFallback.reason, 'host_in_session');
});

test('a non-in-session harness is unaffected in both directions', () => {
  assert.equal(dispatchability(hostSpec(['codex', 'exec']), 'codex').supported, true);
  const bare = dispatchability(hostSpec(null), 'codex');
  assert.equal(bare.supported === false && bare.reason, 'host_without_fallback');
});

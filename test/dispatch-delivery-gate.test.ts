import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  commandRoutable,
  parseExecutorProfile,
  type ExecutorSpec,
} from '../src/lib/executors.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'templates', 'common', 'fadeno', 'executors.yaml');

function hostSpec(fallback: string[] | null, writeAccess = false): ExecutorSpec {
  return {
    adapter: 'host',
    model: 'sonnet',
    fallbackCommand: fallback,
    writeAccess,
  } as unknown as ExecutorSpec;
}

test('a host spec with NO fallback is refused — there is nothing to invoke', () => {
  // The one honest delivery refusal left: `current-host`, the base dial, is a
  // host adapter that declares no command at all.
  assert.equal(commandRoutable(hostSpec(null)), false);
});

test('a host spec WITH a fallback is dispatchable under every harness', () => {
  // The relaxation of 2026-08-21. This used to be refused as `host_in_session`
  // whenever the caller sat inside `claude`, and permitted under `codex` for
  // an identically-shaped route — a coin-flip on which agent you happened to
  // be running in, not a safety property. `commandRoutable` takes no harness
  // argument, so the asymmetry cannot come back by accident: there is no
  // parameter left to branch on.
  assert.equal(commandRoutable(hostSpec(['claude', '-p'])), true);
  assert.equal(commandRoutable(hostSpec(['codex', 'exec'])), true);
  assert.equal(commandRoutable.length, 1);
});

test('the shipped claude-harness anthropic route is the case that was refused', () => {
  // Fixtures proved the predicate; this proves the CATALOG still has the shape
  // the predicate was relaxed for. A route that quietly lost its `command:`
  // would send `fadeno dispatch --archetype reviewer` back to a hard refusal
  // under Claude with no test noticing.
  const profile = parseExecutorProfile(readFileSync(CATALOG, 'utf8'), CATALOG, 'claude');
  const route = (profile.routes as Record<string, Record<string, Record<string, unknown>>>)
    .claude!.anthropic!;
  assert.equal(route.host, true, 'claude→anthropic is the in-session host route');
  assert.ok(Array.isArray(route.command) && route.command.length > 0, 'and it declares a command lane');
  assert.equal(route.driver, 'claude', 'dialed as `--via claude`, not `--via claude-cli`');
});



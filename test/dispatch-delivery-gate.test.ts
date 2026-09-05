import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  commandRoutable,
  parseExecutorProfile,
  resolveDelivery,
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

test('the shipped claude harness is the case that was refused: host AND command', () => {
  // Fixtures proved the predicate; this proves the CATALOG still has the shape
  // the predicate was relaxed for. A harness that quietly lost its `command:`
  // would send `fadeno dispatch --archetype reviewer` back to a hard refusal
  // under Claude with no test noticing.
  const profile = parseExecutorProfile(readFileSync(CATALOG, 'utf8'), CATALOG, 'claude');
  const claude = profile.harnesses.claude!;
  assert.ok(claude.host, 'claude is a host — Fadeno can run inside it');
  assert.ok(claude.command != null && claude.command.command.length > 0, 'and it declares a command lane');
  // The compiled shape a Claude session actually sees: a host candidate whose
  // `fallback_command` is that lane.
  const compiled = resolveDelivery({ model: 'opus' }, profile, 'claude', { archetype: 'reviewer' });
  assert.equal(compiled.spec.adapter, 'host');
  assert.equal(compiled.hostCandidate, true);
  assert.ok(commandRoutable(compiled.spec), 'a Claude reviewer must still be dispatchable out of process');
});



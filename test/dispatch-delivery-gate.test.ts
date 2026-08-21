import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  commandRoutable,
  explainWriteConflict,
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

test('write posture is the refusal that survives, and it names a remedy a host route can take', () => {
  // What the delivery gate was standing in front of. A write-requiring
  // archetype on a read-only host route is refused HERE now, and the message
  // must not tell the reader to add a `write_variant` — the parser rejects
  // that key on a host route, so it is advice that cannot be followed.
  const profile = parseExecutorProfile(readFileSync(CATALOG, 'utf8'), CATALOG, 'claude');
  const conflict = explainWriteConflict(
    { executor: 'sonnet', spec: hostSpec(['claude', '-p'], false) },
    'worker',
    profile,
  );
  assert.ok(conflict != null, 'a write-requiring archetype on a read-only host lane is refused');
  // Substring, precisely chosen: the host wording legitimately contains
  // "cannot declare a `write_variant`". What must never appear is the ADVICE
  // form the command-route branch gives.
  assert.ok(
    !/declare a `write_variant` on the route/.test(conflict),
    'never suggests a key host routes reject',
  );
  assert.match(conflict, /cannot declare a `write_variant`/, 'says why the variant remedy is unavailable');
  assert.match(conflict, /--via <driver>/, 'points at the lane that can actually write');
  assert.match(conflict, /host route/, 'says which kind of route it is talking about');

  // The command-route wording is unchanged, variant advice included.
  const commandConflict = explainWriteConflict(
    { executor: 'sonnet', spec: { adapter: 'command', model: 'sonnet', writeAccess: false } as unknown as ExecutorSpec },
    'worker',
    profile,
  );
  assert.ok(commandConflict != null);
  assert.match(commandConflict, /declare a `write_variant` on the route/);
});

test('a read-only archetype on that same host route is NOT refused', () => {
  // The whole point of the relaxation: `reviewer` needs no write access, so
  // nothing about its dispatch is unsafe, and it used to be refused anyway.
  const profile = parseExecutorProfile(readFileSync(CATALOG, 'utf8'), CATALOG, 'claude');
  const spec = hostSpec(['claude', '-p'], false);
  assert.equal(commandRoutable(spec), true);
  assert.equal(explainWriteConflict({ executor: 'sonnet', spec }, 'reviewer', profile), null);
});

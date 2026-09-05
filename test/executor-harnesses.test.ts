import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { resolveDelivery, parseDialRef, parseExecutorProfile, type HarnessId } from '../src/lib/executors.ts';
import './helpers.ts';

/**
 * Executor harnesses. A harness is a **host** when Fadeno can run inside it —
 * it needs a `templates/<host>/` adapter tree and declares `host:` in the
 * catalog — and an **executor** when Fadeno can spawn it, which needs nothing
 * but a `command:` argv. Most are both; some are only one.
 *
 * Catalog v4 collapsed the six `routes.<host>` tables into this one, so the
 * property these tests pin is now structural rather than repeated: an
 * executor's argv does not depend on which harness is invoking it, because
 * there is only one table to look in. What still has to be checked is that a
 * spawn-only harness never quietly acquires a host surface — Antigravity
 * (`agy`) shipped 2026-08-13 with zero host-side surface precisely because an
 * executor never earns one. OpenCode was promoted to host on 2026-08-22 and is
 * pinned from the other side.
 */

const CATALOG = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml');
const HOSTS: HarnessId[] = ['codex', 'claude', 'grok', 'opencode', 'standalone'];
/** Harnesses that must remain spawn-only: no `host:`, no adapter tree. */
const EXECUTOR_ONLY = ['agy', 'muse'] as const;

function catalogFor(host: HarnessId) {
  return parseExecutorProfile(readFileSync(CATALOG, 'utf8'), 'templates/common/fadeno/executors.yaml', host);
}

test('an executor-only harness is reachable as a command delivery from every host', () => {
  // The defining property: how you invoke it does not depend on which harness
  // is invoking it. Under v4 that is true by construction — one table — so
  // this asserts the CONSEQUENCE, which is what a user experiences.
  for (const host of HOSTS) {
    const profile = catalogFor(host);
    const compiled = resolveDelivery(parseDialRef('gemini', 'test'), profile, host);
    assert.equal(compiled.spec.adapter, 'command', `${host}: gemini must never be host-delivered`);
    assert.equal(compiled.spec.command?.[0], 'agy', `${host}: gemini must invoke agy`);
    assert.equal(compiled.provider, 'google');
    assert.equal(compiled.harness, 'agy');
    assert.equal(compiled.hostCandidate, false, `${host}: an executor-only harness is never a host candidate`);

    const muse = resolveDelivery(parseDialRef('muse', 'test'), profile, host);
    assert.equal(muse.spec.adapter, 'command', `${host}: muse must never be host-delivered`);
    assert.equal(muse.spec.command?.[0], 'muse', `${host}: muse must invoke muse`);
  }
});

test('an executor never becomes a host: no adapter tree and no `host:` block', () => {
  const trees = readdirSync(join(import.meta.dirname, '..', 'templates'));
  const profile = catalogFor('standalone');
  for (const id of EXECUTOR_ONLY) {
    assert.ok(!trees.includes(id), `templates/${id}/ exists — that would make it a host, not an executor`);
    assert.ok(profile.harnesses[id], `harnesses.${id} is missing`);
    assert.equal(profile.harnesses[id]!.host, undefined, `harnesses.${id}.host exists — an executor must not declare one`);
  }
  // The promotion is pinned from the other side: opencode must have BOTH.
  assert.ok(trees.includes('opencode'), 'templates/opencode/ missing — the OpenCode host promotion regressed');
  assert.ok(profile.harnesses.opencode?.host, 'harnesses.opencode.host missing — the promotion regressed');
  assert.ok(profile.harnesses.opencode?.command, 'harnesses.opencode.command missing — it is still an executor too');
  // omp is the mirror case: a host with no CLI to spawn.
  assert.ok(profile.harnesses.omp?.host, 'harnesses.omp.host missing');
  assert.equal(profile.harnesses.omp?.command, undefined, 'omp declares no command lane — there is no headless omp to spawn');
});

test('the harness table keeps providers honest — exactly one home each', () => {
  const profile = catalogFor('standalone');
  assert.equal(profile.models.gemini?.provider, 'google');
  assert.equal(profile.harnesses.agy?.provider, 'google', 'agy is google\'s home harness');
  // OpenCode is home to nobody: it is the universal adapter, reached by an
  // explicit `--harness opencode` or by the unregistered fall-through.
  assert.equal(profile.harnesses.opencode?.provider, undefined);
  assert.equal(profile.unregisteredModelHarness, 'opencode');

  // Spellings are keyed by harness, and reach the argv.
  assert.equal(profile.models.opus?.spellings.opencode, 'anthropic/claude-opus-4.8');
  const onOpencode = resolveDelivery(parseDialRef({ model: 'opus', harness: 'opencode' }, 'test'), profile, 'standalone');
  assert.equal(onOpencode.modelId, 'anthropic/claude-opus-4.8');
  assert.equal(onOpencode.harness, 'opencode');
  assert.ok((onOpencode.spec as { command: string[] }).command.includes('openrouter/anthropic/claude-opus-4.8'));
});

test('the Antigravity lane keeps the three flags that stop it exiting 0 having done nothing', () => {
  const agy = catalogFor('standalone').harnesses.agy!;
  const command = agy.command?.command ?? [];
  assert.ok(!command.includes('-p'), 'agy -p does not read stdin; the prompt would be dropped');
  assert.ok(command.includes('--new-project'), 'without --new-project agy writes outside the repo and still exits 0');
  assert.ok(!command.includes('--effort'), '--effort rejects the "default" reasoning effort');
  // effort_encoding is model-suffix, not a flag
  assert.equal(agy.effort_encoding, 'model-suffix', 'the agy harness must declare effort_encoding model-suffix');
  assert.ok(agy.models_command, 'the agy harness must declare models_command');
});

test('harnesses that can be listed declare models_command for verification', () => {
  const profile = catalogFor('standalone');
  for (const id of ['agy', 'opencode', 'grok'] as const) {
    const entry = profile.harnesses[id];
    assert.ok(entry, `harnesses.${id} is missing`);
    assert.ok(entry!.models_command, `harnesses.${id} must declare models_command`);
    assert.ok(entry!.models_command!.every((p) => p.length > 0), `harnesses.${id} models_command has an empty part`);
  }
});

test('no harness lane carries an empty argv element', () => {
  const profile = catalogFor('standalone');
  for (const [id, entry] of Object.entries(profile.harnesses)) {
    for (const part of entry.command?.command ?? []) {
      assert.notEqual(part, '', `harnesses.${id} has an empty argv element`);
    }
    for (const [name, variant] of Object.entries(entry.variants ?? {})) {
      for (const part of variant.command) {
        assert.notEqual(part, '', `harnesses.${id}.variants.${name} has an empty argv element`);
      }
    }
  }
});

// Replaces the three route-posture tests deleted with the permissions cut.
// The shipped catalog now carries the PERMISSIVE argv for each vendor, and a
// restriction is expressed as a separate named variant rather than as metadata
// beside the command. See docs/experimental/permissions-and-isolation.md.
test('no shipped harness lane declares a removed permissions key', () => {
  const raw = readFileSync(CATALOG, 'utf8');
  const doc = parseYaml(raw) as { harnesses: Record<string, Record<string, unknown>> };
  for (const [harness, entry] of Object.entries(doc.harnesses)) {
    const lanes: Array<[string, Record<string, unknown>]> = [[harness, entry]];
    for (const [name, variant] of Object.entries((entry.variants ?? {}) as Record<string, Record<string, unknown>>)) {
      lanes.push([`${harness}/${name}`, variant]);
    }
    for (const [label, lane] of lanes) {
      assert.ok(!('write_access' in lane), `${label} still declares write_access`);
      assert.ok(!('write_variant' in lane), `${label} still declares write_variant`);
    }
  }
});

test('the claude harness can escalate its own models — the asymmetry that motivated the cut', () => {
  // Under `claude`, the anthropic lane was a HOST route, and host routes were
  // refused a write_variant at parse. That made Claude-as-harness uniquely
  // unable to deliver write-requiring work on its own command lane while codex
  // and grok escalated the identical argv fine. With variants-as-metadata
  // gone, the command lane simply carries the permissive flags directly.
  const claude = catalogFor('standalone').harnesses.claude!;
  assert.ok(claude.command, 'the host-capable claude harness keeps a command lane');
  assert.ok(
    claude.command!.command.includes('acceptEdits'),
    'the claude command lane must be able to write without a variant to escalate through',
  );
});

test('a director reaches the exec variant by POLICY, never by naming a lane on the dial', () => {
  // The one place a variant is chosen. `worker opus` takes the base claude
  // lane; `director opus` cannot (that lane declares `director: forbidden`,
  // because plain `claude -p` cannot run `fadeno` and so cannot coordinate),
  // so resolution falls through to the first variant that permits it.
  const profile = catalogFor('claude');
  const worker = resolveDelivery(parseDialRef('opus', 'test'), profile, 'claude', { archetype: 'worker' });
  assert.equal(worker.variant, null);
  assert.equal(worker.hostCandidate, true, 'a worker is delivered in-session under the claude host');

  const director = resolveDelivery(parseDialRef('opus', 'test'), profile, 'claude', { archetype: 'director' });
  assert.equal(director.variant, 'exec');
  assert.equal(director.hostCandidate, false, 'an in-session agent cannot spawn subagents, so it cannot coordinate');
  assert.ok(
    (director.spec as { fallbackCommand?: string[] | null }).fallbackCommand?.includes('Bash(fadeno:*)')
      ?? (director.spec as { command?: string[] }).command?.includes('Bash(fadeno:*)'),
    'the exec variant is the lane that can actually run fadeno',
  );
});

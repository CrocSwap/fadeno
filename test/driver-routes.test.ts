import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseExecutorProfile, type HarnessId } from '../src/lib/executors.ts';
import './helpers.ts';

/**
 * Driver routes. A **host** is a harness Fadeno runs inside; it needs a
 * `templates/<host>/` adapter tree and owns a `routes.<host>` table. A
 * **driver** is a harness Fadeno spawns as a subprocess; it needs nothing but
 * argv. The distinction is documented in architecture.md → "Glossary:
 * harnesses, hosts, and drivers", and these pin it for the two drivers added
 * 2026-08-13 (gemini-cli and OpenCode), which shipped with zero host-side
 * surface precisely because a driver never earns one.
 */

const CATALOG = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml');
const HOSTS: HarnessId[] = ['codex', 'claude', 'grok', 'standalone'];
const DRIVERS = [
  { target: 'gemini-default', provider: 'google', binary: 'agy' },
  { target: 'opencode-default', provider: 'openrouter', binary: 'opencode' },
] as const;

function catalogFor(harness: HarnessId) {
  return parseExecutorProfile(readFileSync(CATALOG, 'utf8'), 'templates/common/fadeno/executors.yaml', harness);
}

test('each driver is reachable as a command delivery from every host', () => {
  // The defining property of a driver: how you invoke it does not depend on
  // which harness is invoking it, so every host table must carry it and every
  // one of them must deliver it out of process.
  for (const harness of HOSTS) {
    const profile = catalogFor(harness);
    for (const { target, binary } of DRIVERS) {
      const spec = profile.executors[target];
      assert.ok(spec, `${harness}: driver target ${target} is missing`);
      assert.equal(spec.adapter, 'command', `${harness}: ${target} must never be host-delivered`);
      assert.equal(spec.command?.[0], binary, `${harness}: ${target} must invoke ${binary}`);
    }
  }
});

test('a driver never becomes a host: no adapter tree and no route table of its own', () => {
  // `templates/<x>/` is the reliable test for which role a harness has. Adding
  // one of these dirs would silently promote a driver to a host without any of
  // the init/plugin work that actually makes a host work.
  const trees = readdirSync(join(import.meta.dirname, '..', 'templates'));
  for (const { binary } of DRIVERS) {
    assert.ok(!trees.includes(binary), `templates/${binary}/ exists — that would make it a host, not a driver`);
  }
  // A catalog compiles exactly one host's sub-table, so asking for a driver as
  // the active harness is a hard error rather than an empty-but-valid profile.
  for (const { binary } of DRIVERS) {
    assert.throws(
      () => catalogFor(binary as HarnessId),
      /routes/,
      `routes.${binary} resolved; a driver must not own a route table`,
    );
  }
});

test('driver targets keep the provider honest', () => {
  const profile = catalogFor('standalone');
  for (const { target, provider } of DRIVERS) {
    assert.equal(profile.executors[target]?.provider, provider, `${target} declares the wrong provider`);
  }
  // OpenCode fronts whichever provider holds the credential, so its model keeps
  // that provider's own namespaced id and the route prefixes the credential
  // holder. Losing the prefix silently sends `-m anthropic/...` with no
  // provider, which OpenCode rejects only at request time.
  const opencode = profile.executors['opencode-default'];
  assert.ok(
    opencode?.command?.includes('openrouter/anthropic/claude-opus-4.8'),
    `opencode model must resolve provider-namespaced, got ${JSON.stringify(opencode?.command)}`,
  );
});

test('the Antigravity route keeps the three flags that stop it exiting 0 having done nothing', () => {
  // Every one of these failed *silently* when probed live on 2026-08-13:
  //   `-p -`        → takes "-" as the prompt, never reads stdin, exit 0.
  //   no workspace  → writes to ~/.gemini/antigravity-cli/scratch/, exit 0,
  //                   reports "I have created the file", repo untouched.
  //   `--effort`    → only low|medium|high, so a `default`-effort target
  //                   hard-fails (loud, but needlessly).
  for (const harness of HOSTS) {
    const command = catalogFor(harness).executors['gemini-default']?.command ?? [];
    assert.ok(!command.includes('-p'), `${harness}: agy -p does not read stdin; the prompt would be dropped`);
    assert.ok(
      command.includes('--new-project'),
      `${harness}: without --new-project agy writes outside the repo and still exits 0`,
    );
    assert.ok(!command.includes('--effort'), `${harness}: --effort rejects the "default" reasoning effort`);
  }
});

test('no route command carries an empty argv element', () => {
  // gemini-cli documents `-p ''` for headless mode, which would need an empty
  // element; the route schema rejects those because an empty element is far
  // more often a YAML slip than an intent. The shipped spelling relies on
  // piped stdin instead, and this keeps anyone from "fixing" it back.
  for (const harness of HOSTS) {
    const profile = catalogFor(harness);
    for (const [name, spec] of Object.entries(profile.executors)) {
      for (const part of spec.command ?? []) {
        assert.notEqual(part, '', `${harness}: ${name} has an empty argv element`);
      }
    }
  }
});

test('every driver route can take worker-shaped work', () => {
  // `archetypes.worker` is `requires_write: required`, so a driver route that
  // forgot `write_access: true` would be refused before spawning — a failure
  // that only shows up on first real use.
  for (const harness of HOSTS) {
    const profile = catalogFor(harness);
    for (const { target } of DRIVERS) {
      assert.equal(profile.executors[target]?.writeAccess, true, `${harness}: ${target} cannot take worker work`);
    }
  }
});

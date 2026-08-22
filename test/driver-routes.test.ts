import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { compileDialRef, parseDialRef, parseExecutorProfile, type HarnessId } from '../src/lib/executors.ts';
import './helpers.ts';

/**
 * Driver routes. A **host** is a harness Fadeno runs inside; it needs a
 * `templates/<host>/` adapter tree and owns a `routes.<host>` table. A
 * **driver** is a harness Fadeno spawns as a subprocess; it needs nothing but
 * argv. The distinction is documented in architecture.md → "Glossary:
 * harnesses, hosts, and drivers", and these pin it for the two drivers added
 * 2026-08-13 (Antigravity and OpenCode), which shipped with zero host-side
 * surface precisely because a driver never earns one.
 */

const CATALOG = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml');
const HOSTS: HarnessId[] = ['codex', 'claude', 'grok', 'standalone'];
// v3 registry models whose home provider route is driver-backed
const DRIVERS = [
  { model: 'gemini', provider: 'google', binary: 'agy', routeKey: 'google' },
  { model: 'opencode-driver', provider: 'openrouter', binary: 'opencode', routeKey: 'openrouter' },
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
    for (const { provider, binary, routeKey } of DRIVERS) {
      if (provider === 'openrouter') {
        // openrouter route is the multi-provider universal driver; check route table directly
        const route = profile.routes[harness]?.[routeKey];
        assert.ok(route, `${harness}: route ${routeKey} is missing`);
        assert.ok(!route.host, `${harness}: ${routeKey} must never be host-delivered`);
        assert.equal(route.command?.[0], binary, `${harness}: ${routeKey} must invoke ${binary}`);
      } else {
        // google/agy: compile via the registry model to exercise driver + effort_encoding
        const ref = parseDialRef('gemini', 'test');
        const compiled = compileDialRef(ref, profile);
        assert.equal(compiled.spec.adapter, 'command', `${harness}: gemini must never be host-delivered`);
        assert.equal(compiled.spec.command?.[0], binary, `${harness}: gemini must invoke ${binary}`);
        assert.equal(compiled.provider, provider);
        assert.equal(compiled.driver, binary);
      }
    }
  }
});

test('a driver never becomes a host: no adapter tree and no route table of its own', () => {
  const trees = readdirSync(join(import.meta.dirname, '..', 'templates'));
  for (const { binary } of DRIVERS) {
    assert.ok(!trees.includes(binary), `templates/${binary}/ exists — that would make it a host, not a driver`);
  }
  // A catalog declares routes keyed by host, never by driver — a driver must not own a route table.
  const profile = catalogFor('standalone');
  for (const { binary } of DRIVERS) {
    assert.ok(!(binary in profile.routes), `routes.${binary} exists — a driver must not own a route table`);
  }
});

test('driver routes keep the provider honest', () => {
  const profile = catalogFor('standalone');
  // gemini model entry declares google provider
  assert.equal(profile.models['gemini']?.provider, 'google', 'gemini declares the wrong provider');
  // openrouter route exists under every harness and is keyed by openrouter
  for (const harness of HOSTS) {
    const p = catalogFor(harness);
    assert.ok(p.routes[harness]?.openrouter, `${harness}: openrouter route missing`);
    assert.equal(p.routes[harness]?.openrouter?.driver, 'opencode');
  }
  // OpenCode spellings: opus has an openrouter spelling via openCode
  const opusEntry = profile.models['opus'];
  assert.ok(opusEntry?.spellings?.opencode, 'opus must declare a spelling for opencode');
  assert.equal(opusEntry.spellings.opencode, 'anthropic/claude-opus-4.8');
  // Compile opus via opencode to verify spelling + provider-namespaced delivery
  const viaOpencode = compileDialRef(parseDialRef({ model: 'opus', via: 'opencode' }, 'test'), profile);
  assert.equal(viaOpencode.modelId, 'anthropic/claude-opus-4.8');
  assert.equal(viaOpencode.driver, 'opencode');
});

test('the Antigravity route keeps the three flags that stop it exiting 0 having done nothing', () => {
  for (const harness of HOSTS) {
    const route = catalogFor(harness).routes[harness]?.google;
    const command = route?.command ?? [];
    assert.ok(!command.includes('-p'), `${harness}: agy -p does not read stdin; the prompt would be dropped`);
    assert.ok(
      command.includes('--new-project'),
      `${harness}: without --new-project agy writes outside the repo and still exits 0`,
    );
    assert.ok(!command.includes('--effort'), `${harness}: --effort rejects the "default" reasoning effort`);
    // effort_encoding is model-suffix, not a flag
    assert.equal(route?.effort_encoding, 'model-suffix', `${harness}: google route must declare effort_encoding model-suffix`);
    // models_command probes verification
    assert.ok(route?.models_command, `${harness}: google route must declare models_command`);
  }
});

test('routes declare models_command for verification', () => {
  for (const harness of HOSTS) {
    const profile = catalogFor(harness);
    for (const key of ['google', 'openrouter', 'xai'] as const) {
      const route = profile.routes[harness]?.[key];
      if (route) {
        assert.ok(route.models_command, `${harness}: ${key} route must declare models_command`);
        assert.ok(route.models_command!.every((p) => p.length > 0), `${harness}: ${key} models_command has empty part`);
      }
    }
  }
});

test('no route command carries an empty argv element', () => {
  for (const harness of HOSTS) {
    const profile = catalogFor(harness);
    for (const [key, route] of Object.entries(profile.routes[harness] ?? {})) {
      for (const part of route.command ?? []) {
        assert.notEqual(part, '', `${harness}: routes.${key} has an empty argv element`);
      }
    }
  }
});




// Replaces the three route-posture tests deleted with the permissions cut.
// The shipped catalog now carries the PERMISSIVE argv for each vendor, and a
// restriction is expressed as a separate route with its own name rather than
// as metadata beside the command. See
// docs/experimental/permissions-and-isolation.md.
test('no shipped route declares a removed permissions key', () => {
  const raw = readFileSync(CATALOG, 'utf8');
  const doc = parseYaml(raw) as { routes: Record<string, Record<string, Record<string, unknown>>> };
  for (const [harness, drivers] of Object.entries(doc.routes)) {
    for (const [name, route] of Object.entries(drivers)) {
      assert.ok(!('write_access' in route), `${harness}/${name} still declares write_access`);
      assert.ok(!('write_variant' in route), `${harness}/${name} still declares write_variant`);
    }
  }
});

test('the claude harness can escalate its own models — the asymmetry that motivated the cut', () => {
  // Under `claude`, `anthropic` is a host route, and host routes were refused
  // a write_variant at parse. That made Claude-as-harness uniquely unable to
  // deliver write-requiring work on its own command lane while codex and grok
  // escalated the identical argv fine. With variants gone, the fallback lane
  // simply carries the permissive flags directly.
  const raw = readFileSync(CATALOG, 'utf8');
  const doc = parseYaml(raw) as { routes: Record<string, Record<string, { command?: string[] }>> };
  const anthropic = doc.routes.claude!.anthropic!;
  assert.ok(anthropic.command, 'the host route keeps a fallback command lane');
  assert.ok(
    anthropic.command!.includes('acceptEdits'),
    'the claude host fallback lane must be able to write without a variant to escalate through',
  );
});

// A selected pair forces BOTH arms onto the primary's command lane
// (`docs/experimental/slots-and-archetypes.md`, "a primary with no usable
// command lane should degrade to no pair rather than to a failed task"). Prior
// to this fix, `shadow.routable` in both `steering resolve` and `dial
// resolve` was `commandRoutable(spec)` alone — "does a command lane exist" —
// never asking whether that lane could satisfy the archetype's declared write
// posture. A `requires_write: required` archetype whose primary resolves to a
// host route with `write_access: false` and no `write_variant` would then be
// reported `routable: true`, announced as a pair, and refused by the kernel's
// own write-posture guard — exactly the "silent wrong answer" this repo keeps
// getting bitten by. `explainPairRoutability` (src/lib/executors.ts) is the
// one shared predicate now driving both resolve previews and the dispatch
// kernel's own pair-capability check.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { runDialResolve } from '../src/commands/dial.ts';
import { DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { runSteeringResolve } from '../src/commands/steering.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const ECHO = (prefix: string): string[] => [
  'node', '-e', `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

// Isolates user-scope config/state, same technique as test/dispatch-shadow.test.ts:
// a plain `{ env: { FADENO_HARNESS } }` replaces `process.env` wholesale rather
// than merging with it, so it bypasses `tempRepo()`'s HOME redirect unless the
// FADENO_*_HOME vars are named here explicitly too.
function isolatedUser(root: string, harness: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: harness,
    },
  };
}

/**
 * A codex-harness catalog matching the shape of the reported bug: `worker`
 * requires write and is dialed onto a host route (`lunap`) whose command
 * fallback declares `write_access: false` and no `write_variant` — a host
 * route can never declare one (write_variant is command-adapter only). A
 * command-adapter route with the same `write_access: false` but a declared
 * `write_variant` (`variant`) is the control that proves a variant is what
 * makes the lane usable. `reviewer` shares the same unwritable host lane but
 * carries no write posture, and must be unaffected by any of this.
 */
function seedRoot(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      luna: { provider: 'lunap', id: 'gpt-5.6-luna', effort: 'high' },
      grok: { provider: 'xai', id: 'grok' },
      variant: { provider: 'variantp', id: 'variant-model' },
    },
    routes: {
      codex: {
        lunap: { host: true, command: ECHO('HOST-FALLBACK:'), write_access: false },
        xai: { command: ECHO('CHALLENGER:'), write_access: true },
        variantp: {
          command: ECHO('CMD:'),
          write_access: false,
          write_variant: { command: ECHO('CMDWRITE:') },
        },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
      reviewer: {},
    },
    dials: { worker: 'luna', reviewer: 'luna' },
  }));
  return root;
}

test('routable is false: write-required archetype on a command lane declared write_access:false with no write_variant', (t) => {
  const root = seedRoot(t);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'grok', rate: 1 } }, legacyNote: null });
  const resolved = runDialResolve({
    archetype: 'worker', repoRoot: root, userPathOptions: isolatedUser(root, 'codex'),
    promptSha256: sha256Hex('do the thing'),
  });
  assert.equal(resolved.adapter, 'host');
  assert.equal(resolved.shadow?.selected, true);
  assert.equal(resolved.shadow?.routable, false);
});

test('routable is true: the same posture, but the route declares a write_variant', (t) => {
  const root = seedRoot(t);
  writeLocalDialState(root, {
    dials: { worker: { model: 'variant' } },
    shadows: { worker: { model: 'grok', rate: 1 } },
    legacyNote: null,
  });
  const resolved = runDialResolve({
    archetype: 'worker', repoRoot: root, userPathOptions: isolatedUser(root, 'codex'),
    promptSha256: sha256Hex('do the thing'),
  });
  assert.equal(resolved.adapter, 'command');
  assert.equal(resolved.shadow?.selected, true);
  assert.equal(resolved.shadow?.routable, true);
});

test('routable is unchanged (true) for a non-write-requiring archetype on the same unwritable lane', (t) => {
  const root = seedRoot(t);
  writeLocalDialState(root, { dials: {}, shadows: { reviewer: { model: 'grok', rate: 1 } }, legacyNote: null });
  const resolved = runDialResolve({
    archetype: 'reviewer', repoRoot: root, userPathOptions: isolatedUser(root, 'codex'),
    promptSha256: sha256Hex('review it'),
  });
  assert.equal(resolved.adapter, 'host');
  assert.equal(resolved.shadow?.selected, true);
  assert.equal(resolved.shadow?.routable, true);
});

test('anti-drift tripwire: steering resolve and dial resolve report the same routable for the same input', (t) => {
  const root = seedRoot(t);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'grok', rate: 1 } }, legacyNote: null });
  const digest = sha256Hex('do the thing');

  const dialResolved = runDialResolve({
    archetype: 'worker', repoRoot: root, userPathOptions: isolatedUser(root, 'codex'),
    promptSha256: digest,
  });
  const steeringResolved = runSteeringResolve({
    repoRoot: root, archetype: 'worker', hostExecutor: 'luna', promptSha256: digest,
    userPathOptions: isolatedUser(root, 'codex'),
  });

  assert.equal(dialResolved.shadow?.routable, false);
  assert.equal(steeringResolved.shadow?.routable, false);
  assert.equal(steeringResolved.shadow?.routable, dialResolved.shadow?.routable);
  // And the resolution this drives: an unroutable pair must not force the
  // command lane, matching test/steering.test.ts's "degrades to no pair"
  // regression for the `commandRoutable`-false case.
  assert.equal(steeringResolved.mode, 'host');
});

test('a refusal row is written when a selected shadow cannot pair for write posture, and the primary still runs', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      'bad-worker': { provider: 'openai', id: 'bad-worker' },
      grok: { provider: 'xai', id: 'grok' },
    },
    routes: {
      standalone: {
        openai: { command: ECHO('REPORT:'), write_access: false },
        xai: { command: ECHO('CHALLENGER:'), write_access: true },
      },
    },
    archetypes: { worker: { requires_write: 'required' } },
  }));
  // A dial forced past its own write-posture conflict (`--force`, persisted
  // as `force_write_posture`) is the only way the primary itself proceeds
  // rather than refusing outright — the pair-capability check this test
  // targets is a separate, later question: even though the primary is
  // running anyway, a challenger must not be spawned to "compare" against a
  // primary that cannot mutate the workspace the way the challenger can.
  writeLocalDialState(root, {
    dials: { worker: { model: 'bad-worker', force_write_posture: true } },
    shadows: { worker: { model: 'grok' } },
    legacyNote: null,
  });

  const echoes: string[] = [];
  const result = runDispatch({
    archetype: 'worker', prompt: 'do the thing', repoRoot: root,
    userPathOptions: isolatedUser(root, 'standalone'),
    onEcho: (l) => echoes.push(l),
  });
  assert.equal(result.exitCode, 0);

  const rows = readFileSync(join(root, DISPATCHES_FILE), 'utf8')
    .split('\n').filter((l: string) => l.trim() !== '').map((l: string) => JSON.parse(l));
  const primaryCompleted = rows.find((r: any) => r.event === 'dispatch_completed' && r.shadow !== true);
  assert.ok(primaryCompleted, 'primary must still have run to completion');
  const shadowRefusal = rows.find((r: any) => r.event === 'dispatch_refused' && r.shadow === true);
  assert.ok(shadowRefusal, 'a refusal row must explain why no pair formed');
  assert.equal(shadowRefusal.refusal.predicate, 'shadow_write_posture');
  assert.match(shadowRefusal.refusal.message, /requires_write.*required/s);
  assert.equal(shadowRefusal.primary_dispatch_id, primaryCompleted.dispatch_id);
});

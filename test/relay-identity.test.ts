import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runDialResolve, runDialSet } from '../src/commands/dial.ts';
import { runInit } from '../src/commands/init.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * The relay identity comes from the catalog, not from a source literal.
 *
 * `relay.<harness>` names the cheap model that forwards a delivery without
 * doing the role work. Claude's used to be the literal `'sonnet'` inside the
 * steering hook, which meant a repo could re-dial every identity it has
 * EXCEPT the one that carries them. These tests pin the whole chain — project
 * catalog → `fadeno dial resolve` → the model the hook puts on the spawn —
 * and the fallback that has to survive a catalog stating no opinion, which is
 * what a self-contained project catalog produces and therefore the common
 * case rather than the exotic one.
 */

const REPO = join(import.meta.dirname, '..');
const STEERING_TEMPLATE = join(REPO, 'templates', 'claude', 'hooks', 'dispatch-steering.mjs');
const EMITTED_HOOK = join('.fadeno', 'local', 'claude-dispatch-steering.mjs');

/**
 * Isolated user scope. These tests must never read the developer's real user
 * dials or user catalog: either one would silently change what the resolver
 * answers, and the whole point here is that the ANSWER is the assertion.
 */
function isolated(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_DATA_HOME: join(root, 'user-data'),
      FADENO_HARNESS: 'claude',
    },
  };
}

/** A Claude repo with the shipped catalog and the emitted steering hook. */
function seedClaudeRepo(t: TestContext): string {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withSteering: true });
  return root;
}

/** Rewrite the project catalog's `relay:` map — `null` removes the key. */
function setRelay(root: string, relay: Record<string, string> | null): void {
  const path = join(root, '.fadeno', 'executors.yaml');
  const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (relay == null) delete doc.relay;
  else doc.relay = relay;
  writeFileSync(path, stringifyYaml(doc));
}

/**
 * A `fadeno` on PATH that runs THIS working tree's CLI source, so the hook
 * exercises the real resolver rather than a hand-written stub. The bundled
 * `plugin/bin/fadeno` is a committed build artifact and would answer with the
 * previous generation's fields.
 */
function realFadenoShim(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'fadeno');
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${join(REPO, 'src', 'cli.ts')} "$@"\n`);
  chmodSync(path, 0o755);
  return bin;
}

/**
 * Run the emitted hook over a spawn event, with the real CLI on PATH.
 *
 * `CLAUDE_PLUGIN_ROOT` is deleted deliberately: the hook prefers a bundled
 * binary when one is named, and this suite may well be running inside a
 * session that has the plugin installed.
 */
function runHook(root: string, toolInput: Record<string, unknown>): Record<string, unknown> | null {
  const bin = realFadenoShim(root);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FADENO_CONFIG_HOME: join(root, 'user-config'),
    FADENO_STATE_HOME: join(root, 'user-state'),
    FADENO_DATA_HOME: join(root, 'user-data'),
    // Explicit, never the developer's ambient level: the lane decision reads
    // it, so an inherited value would make these assertions depend on how the
    // suite happened to be started.
    CLAUDE_EFFORT: 'xhigh',
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  const result = spawnSync(process.execPath, [join(root, EMITTED_HOOK)], {
    cwd: root,
    env,
    input: JSON.stringify({ cwd: root, tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().length === 0 ? null : (JSON.parse(result.stdout) as Record<string, unknown>);
}

/** The model the hook put on a rewritten spawn, plus where it sent it. */
function spawnDecision(decision: Record<string, unknown> | null): { subagent_type: string; model?: string } {
  assert.ok(decision, 'expected the hook to rewrite this spawn');
  const output = (decision as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } }).hookSpecificOutput;
  const updated = output?.updatedInput;
  assert.ok(updated, 'expected an updatedInput decision');
  return updated as { subagent_type: string; model?: string };
}

/**
 * Put the worker on the command lane, which is the only lane that has a relay:
 * a host-delivered spawn stays in session and never touches a proxy. `luna`
 * is command-routed under the claude harness in the shipped catalog.
 */
function dialWorkerToCommandLane(root: string): void {
  runDialSet({ repoRoot: root, userPathOptions: isolated(root), archetype: 'worker', model: 'luna', session: true });
}

const SPAWN = { prompt: 'Implement the change exactly.', description: 'Implement', subagent_type: 'worker' };

test('dial resolve reports the catalog relay for the resolving harness', (t) => {
  const root = seedClaudeRepo(t);
  const shipped = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: isolated(root) });
  // The shipped catalog states an opinion, so the resolver reports it: the
  // ref as written, the id a harness is handed, and the effort it lands on.
  assert.deepEqual(shipped.relay, { ref: 'sonnet', model_id: 'sonnet', effort: 'xhigh' });

  setRelay(root, { claude: 'fable' });
  const overridden = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: isolated(root) });
  assert.deepEqual(overridden.relay, { ref: 'fable', model_id: 'fable', effort: 'high' });

  // A catalog that states no opinion answers null — never a guess. The key is
  // present rather than omitted so a reader can tell "no opinion" from a
  // resolver too old to have the field.
  setRelay(root, null);
  const silent = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: isolated(root) });
  assert.equal(silent.relay, null);
  assert.ok('relay' in silent, 'relay must be present-and-null, not omitted');
});

test('a catalog relay.claude override reaches the hook model choice', (t) => {
  const root = seedClaudeRepo(t);
  dialWorkerToCommandLane(root);

  // Baseline: the shipped catalog says sonnet, and that is what the spawn gets.
  assert.deepEqual(spawnDecision(runHook(root, SPAWN)), {
    ...SPAWN,
    subagent_type: 'dispatch-worker',
    model: 'sonnet',
  });

  // Re-dial the relay in the catalog alone — no hook edit, no re-emit — and
  // the very next spawn carries the new identity.
  setRelay(root, { claude: 'fable' });
  assert.equal(spawnDecision(runHook(root, SPAWN)).model, 'fable');

  // Re-dialling the relay must not cost the relay-fidelity attestation the
  // proxy path depends on — both spawns above are proxy-bound, so both stash.
  const stashed = readFileSync(join(root, '.fadeno', 'local', 'pending-relays.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(stashed.length, 2);
});

test('a catalog stating no relay opinion falls back to sonnet', (t) => {
  const root = seedClaudeRepo(t);
  dialWorkerToCommandLane(root);
  setRelay(root, null);

  // Null is "the catalog states no opinion", and the caller keeps its own
  // built-in default rather than inventing one — a relay this session's
  // provider cannot serve is worse than a stale but servable one.
  assert.equal(spawnDecision(runHook(root, SPAWN)).model, 'sonnet');

  // Same answer from a resolver that predates the field entirely: an absent
  // key must read as "no opinion", never as a reason to deny or to inherit.
  const bin = join(root, 'legacy-bin');
  mkdirSync(bin, { recursive: true });
  const legacy = join(bin, 'fadeno');
  writeFileSync(
    legacy,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ adapter: 'command', model: 'luna', executor: 'luna', lane: 'command' })}'\n`,
  );
  chmodSync(legacy, 0o755);
  const result = spawnSync(process.execPath, [join(root, EMITTED_HOOK)], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDE_EFFORT: 'xhigh', CLAUDE_PLUGIN_ROOT: undefined },
    input: JSON.stringify({ cwd: root, tool_name: 'Agent', tool_input: SPAWN }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnDecision(JSON.parse(result.stdout) as Record<string, unknown>).model, 'sonnet');
});

test('the hook keeps exactly one relay literal, as the named fallback', () => {
  const template = readFileSync(STEERING_TEMPLATE, 'utf8');
  // The spawn rewrite reads the resolved relay, never a literal.
  assert.match(template, /commandDelivery \? \{ model: relayModel \}/);
  // …and the only surviving `'sonnet'` is the named built-in default.
  const literals = template.match(/'sonnet'/g) ?? [];
  assert.deepEqual(literals, ["'sonnet'"], 'sonnet must appear once, as RELAY_FALLBACK_MODEL');
  assert.match(template, /const RELAY_FALLBACK_MODEL = 'sonnet';/);
  // The 2026-08-12 dogfood receipt is the reason this must stay a capable
  // model. Losing it invites the next reader to "save tokens" here.
  assert.match(template, /2026-08-12 dogfood A\/B/);
  assert.match(template, /haiku/);
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { tempRepo } from './helpers.ts';

/**
 * `dial resolve`'s dispatch advice and the dispatch kernel answer from one
 * predicate.
 *
 * The guidance used to say `dispatchable: true` for anything `commandRoutable`
 * — a lane EXISTS — while the kernel additionally checks whether that lane can
 * satisfy the archetype's write posture. The two diverge on a shape a user
 * reaches by accident: `fadeno dial worker sonnet@medium` pins an effort the
 * session cannot give, so the delivery leaves the host lane for its route's
 * `fallback_command` — which is `write_access: false`, and a host route may
 * not declare a `write_variant`. Guidance said "Dispatch it"; the dispatch
 * refused. Following your own tool's instruction and being refused by it is
 * the failure this pins shut.
 *
 * The assertions below are deliberately end-to-end (CLI in, CLI out) rather
 * than unit calls on the shared helper: a unit test would pass even if the
 * resolve path stopped calling the helper at all, which is exactly how the
 * two drifted the first time.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function seed(t: TestContext): { root: string; env: NodeJS.ProcessEnv } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'xhigh' } },
    routes: {
      claude: {
        'current-host': { host: true },
        // The shipped shape: in-session host delivery, with a command lane
        // that cannot write and cannot be given a variant because it is host.
        anthropic: {
          driver: 'claude',
          host: true,
          command: ['claude', '-p', '--model', '{model}'],
          write_access: false,
        },
        // The command-lane counterpart, which CAN carry a write variant.
        'anthropic-exec': {
          driver: 'claude-exec',
          command: ['claude', '-p', '--model', '{model}'],
          write_access: false,
          write_variant: { command: ['claude', '-p', '--model', '{model}', '--permission-mode', 'acceptEdits'] },
        },
      },
    },
    archetypes: { worker: { requires_write: 'required' } },
    dials: { worker: 'sonnet' },
  }));
  return {
    root,
    env: {
      ...process.env,
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'claude',
      HOME: join(root, 'home'),
    },
  };
}

function resolve(root: string, env: NodeJS.ProcessEnv): any {
  return JSON.parse(execFileSync(
    process.execPath,
    [CLI, 'dial', 'resolve', '--archetype', 'worker'],
    { cwd: root, env, encoding: 'utf8' },
  ));
}

test('an effort-pinned host dial is advised NOT to dispatch, and the kernel agrees', (t) => {
  const { root, env } = seed(t);
  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'sonnet@medium', '--session'], { cwd: root, env });

  const r = resolve(root, env);
  // The pin is what ejects it from the host lane; without that there is no
  // command lane in play and nothing for the posture to conflict with.
  assert.equal(r.lane, 'command', 'the pinned effort leaves the session');
  assert.equal(r.delivery.dispatchable, false);
  assert.equal(r.delivery.dispatch_command, null, 'and it offers no command to run');
  assert.match(r.delivery.action, /^Do NOT dispatch/);
  assert.match(r.delivery.action, /requires_write: required/);

  // The other half: the kernel refuses the very dispatch the guidance now
  // declines to suggest. If either side moves alone, one of these two fails.
  const ran = spawnSync(
    process.execPath,
    [CLI, 'dispatch', '--archetype', 'worker'],
    { cwd: root, env, encoding: 'utf8', input: 'do the thing' },
  );
  assert.notEqual(ran.status, 0, 'dispatching anyway is refused');
  assert.match(ran.stderr, /requires_write: required/);
});

test('the same dial on a write-capable command lane is advised TO dispatch', (t) => {
  const { root, env } = seed(t);
  execFileSync(
    process.execPath,
    [CLI, 'dial', 'worker', 'sonnet@medium', '--via', 'claude-exec', '--session'],
    { cwd: root, env },
  );

  const r = resolve(root, env);
  assert.equal(r.write_variant, true, 'the exec route can be postured for write');
  assert.equal(r.delivery.dispatchable, true);
  assert.equal(r.delivery.dispatch_command, 'fadeno dispatch --archetype worker');
  assert.doesNotMatch(r.delivery.action, /Do NOT dispatch/);
});

test('an unpinned host dial stays in-session and is not sold as a dispatch', (t) => {
  const { root, env } = seed(t);
  // No pin: the delivery never leaves the host lane, so the command lane's
  // write_access is irrelevant to how this task actually runs. The advice
  // must still not point at a dispatch that would be refused.
  const r = resolve(root, env);
  assert.equal(r.lane, 'host');
  assert.equal(r.delivery.dispatchable, false);
});

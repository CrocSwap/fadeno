import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import { tempRepo } from './helpers.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';

/**
 * `fadeno dispatch` is an explicit request for command delivery and does not
 * route on the lane — `fadeno bakeoff` dispatches two judges this way, and a
 * judge is host-lane under Claude with the default dial, so refusing host-lane
 * archetypes outright would break a first-class caller.
 *
 * What the lane changes is what the kernel SAYS. When the resolver already
 * chose in-session, the write-posture refusal used to read its remedies in the
 * wrong order — calling the in-session agent a non-equivalent substitute and
 * leading with `--via` — which talks a caller into re-dialing a host-lane
 * archetype onto an exec route and moving it out of the session for good. The
 * message, not any gate, was the thing producing the outcome nobody wanted.
 */

const ECHO = (prefix: string): string[] => [
  'node', '-e', `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

function initGit(root: string): void {
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid',
  };
  const run = (args: string[]) => {
    const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  run(['init']);
  writeFileSync(join(root, '.gitignore'), '.fadeno\n');
  run(['add', '-A']);
  run(['commit', '-m', 'seed']);
}

/** A host route with a read-only command lane, plus an exec route that can write. */
function seed(t: TestContext): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'high' } },
    routes: {
      claude: {
        'current-host': { host: true },
        anthropic: { driver: 'claude', host: true, command: ECHO('HOST-FALLBACK:'), },
        'anthropic-exec': { driver: 'claude-exec', command: ECHO('EXEC:'), },
      },
    },
    archetypes: { worker: { }, reviewer: {} },
    dials: { worker: 'sonnet', reviewer: 'sonnet' },
  }));
  initGit(root);
  return {
    root,
    user: {
      home: join(root, 'home'),
      env: {
        FADENO_CONFIG_HOME: join(root, 'user-config'),
        FADENO_STATE_HOME: join(root, 'user-state'),
        FADENO_HARNESS: 'claude',
      },
    },
  };
}


test('the note also fires on the delivering path — leaving the session is announced', (t) => {
  const { root, user } = seed(t);
  const echoes: string[] = [];
  // `reviewer` needs no write access, so this host dial actually delivers down
  // its fallback rather than refusing. It should still say that it is leaving
  // a session that would have handled the task in-house: silence here is how a
  // caller pays for a second session without ever deciding to.
  const result = runDispatch({
    archetype: 'reviewer', prompt: 'review it', repoRoot: root,
    userPathOptions: user, onEcho: (l) => echoes.push(l),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(echoes.some((l) => /resolves to the HOST lane/.test(l)), echoes.join('\n'));
  assert.ok(echoes.some((l) => /external sandbox/.test(l)), 'and still announces the sandbox');
});

test('no host-lane note when the dial is genuinely command-lane', (t) => {
  const { root, user } = seed(t);
  const echoes: string[] = [];
  // Dialed straight at the exec route: the resolver never wanted this
  // in-session, so nagging about a host lane would be noise — and worse, would
  // teach a reader to discount the note when it matters.
  const result = runDispatch({
    archetype: 'reviewer', model: 'sonnet', via: 'claude-exec', prompt: 'review it',
    repoRoot: root, userPathOptions: user, onEcho: (l) => echoes.push(l),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(!echoes.some((l) => /resolves to the HOST lane/.test(l)), echoes.join('\n'));
});

test('`--via` without `--model` escalates this one dispatch off the host lane', (t) => {
  const { root, user } = seed(t);
  // Regression: `--via` used to be read only inside the `--model` branch, so
  // this exact call accepted the flag, dropped it, and refused on write
  // posture — while `--help` advertised `--via` as `(dial/dispatch)`. It is
  // also the lever the host-lane note now points at, so a no-op here would
  // make that guidance advice that cannot be followed.
  const result = runDispatch({
    archetype: 'worker', via: 'claude-exec', prompt: 'do it',
    repoRoot: root, userPathOptions: user,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^EXEC:/, 'delivered on the exec route, not the host fallback');
  assert.equal(result.driver, 'claude-exec');
});

test('the escalation does not move the dial', (t) => {
  // Asserted on the RECORDED EXECUTOR rather than on a refusal. It used to
  // lean on the write-posture guard rejecting the unescalated second call;
  // that guard is gone, so the invariant is now checked directly — which is
  // what it always meant anyway: a per-call `--via` must not persist.
  const { root, user } = seed(t);
  runDispatch({ archetype: 'worker', via: 'claude-exec', prompt: 'do it', repoRoot: root, userPathOptions: user });
  runDispatch({ archetype: 'worker', prompt: 'again', repoRoot: root, userPathOptions: user });
  const requested = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
    .filter((r: { event: string }) => r.event === 'dispatch_requested');
  assert.equal(requested.length, 2);
  assert.notEqual(
    requested[1]!.executor,
    requested[0]!.executor,
    'the second dispatch must resolve through the dial, not through the first call\'s --via',
  );
});

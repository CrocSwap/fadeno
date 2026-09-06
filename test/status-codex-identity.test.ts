import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runStatus, type CodexMaterialization } from '../src/commands/status.ts';
import { runSteeringApply } from '../src/commands/steering.ts';
import {
  CODEX_IDENTITY_REMEDIATION,
  describeCodexAgentIdentityRow,
  type CodexAgentIdentityRow,
} from '../src/lib/codex-agent-file.ts';
import { userPaths, writeUserDials, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * A Codex agent file is a FROZEN IDENTITY (`findSpawnableCodexAgent`): its
 * `model` / `model_reasoning_effort` beat anything a spawn passes, and the
 * session loads it once at start. So "the file exists" answers a question
 * nobody is asking. Until 2026-09-05 that was the whole of
 * `codexMaterialization`, and a Codex director whose `reviewer` dial had moved
 * kept spawning the old model for a whole session while `fadeno status`
 * printed `current`.
 *
 * These tests pin the identity comparison, the four verdicts, and — the part
 * that is a claim about the CLI rather than about a data function — the exact
 * remediation command, by RUNNING it against a temp user dir and watching the
 * drift clear.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Fixture {
  root: string;
  user: UserPathOptions;
  agentDir: string;
}

/** A temp repo plus a user scope that keeps Codex, isolated from the real one. */
function fixture(t: TestContext): Fixture {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      // Deliberately NOT codex: these files are Codex's whatever harness the
      // status call runs inside, and forcing the resolver onto the codex
      // profile is `runStatus`'s job, not the caller's.
      FADENO_HARNESS: 'standalone',
    },
  };
  const paths = userPaths(user);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(
    paths.installationsFile,
    `${JSON.stringify({ schema_version: 1, runtime: null, harnesses: { codex: { version: '0.6.1', files: [] } } })}\n`,
    'utf8',
  );
  return { root, user, agentDir: join(root, 'home', '.codex', 'agents') };
}

function materialize(fx: Fixture): void {
  runSteeringApply({ repoRoot: fx.root, target: 'codex', scope: 'user', userPathOptions: fx.user });
}

function inspect(fx: Fixture): CodexMaterialization {
  const result = runStatus({ repoRoot: fx.root, userPathOptions: fx.user });
  assert.ok(result.codexMaterialization != null, 'codex is maintained, so status must report on it');
  return result.codexMaterialization;
}

function row(materialization: CodexMaterialization, archetype: string): CodexAgentIdentityRow {
  const found = materialization.agents.find((agent) => agent.archetype === archetype);
  assert.ok(found != null, `no row for ${archetype}`);
  return found;
}

/** Hand-edit one materialized file's identity, the way a dial change leaves it. */
function driftFile(fx: Fixture, archetype: string, model: string, effort: string): void {
  const path = join(fx.agentDir, `fadeno-${archetype}.toml`);
  const text = readFileSync(path, 'utf8')
    .replace(/^model = ".*"$/m, `model = ${JSON.stringify(model)}`)
    .replace(/^model_reasoning_effort = ".*"$/m, `model_reasoning_effort = ${JSON.stringify(effort)}`);
  writeFileSync(path, text, 'utf8');
}

test('a host slot whose file disagrees with the dial is stale, not current', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { worker: { model: 'luna' }, reviewer: { model: 'terra' }, judge: { model: 'sol' } });
  materialize(fx);
  driftFile(fx, 'reviewer', 'gpt-5.6-luna', 'high');

  const materialization = inspect(fx);
  assert.equal(row(materialization, 'reviewer').status, 'stale');
  assert.equal(row(materialization, 'worker').status, 'current', 'an untouched slot stays current');
  assert.equal(row(materialization, 'judge').status, 'current');
  assert.equal(materialization.fresh, false, 'one stale identity is not a fresh materialization');
  assert.equal(materialization.restartRequired, true);
  assert.equal(materialization.remediation, CODEX_IDENTITY_REMEDIATION);

  // The exact sentence §1.3 of the contract froze, assembled from the data.
  assert.equal(
    describeCodexAgentIdentityRow(row(materialization, 'reviewer')),
    'reviewer file gpt-5.6-luna/high vs dial gpt-5.6-terra/xhigh',
  );
});

test('the frozen remediation command clears the drift when it is actually run', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  driftFile(fx, 'reviewer', 'gpt-5.6-luna', 'high');
  assert.equal(row(inspect(fx), 'reviewer').status, 'stale');

  // The remediation string is a claim about the CLI, so it is proved by
  // running that CLI — not by calling the data function it happens to reach.
  const result = spawnSync(
    process.execPath,
    [CLI, 'steering', 'apply', '--codex', '--scope', 'user'],
    {
      cwd: fx.root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: fx.user.home!,
        CODEX_HOME: join(fx.user.home!, '.codex'),
        FADENO_CONFIG_HOME: fx.user.env!.FADENO_CONFIG_HOME!,
        FADENO_STATE_HOME: fx.user.env!.FADENO_STATE_HOME!,
        FADENO_HARNESS: 'standalone',
      },
    },
  );
  assert.equal(result.status, 0, `remediation failed: ${result.stderr}`);

  const after = inspect(fx);
  assert.equal(row(after, 'reviewer').status, 'current', 'the remediation must actually rewrite the identity');
  assert.equal(after.fresh, true);
  assert.equal(after.remediation, null, 'nothing to fix, nothing to advise');
});

/**
 * The tripwire for the OTHER candidate the contract offered. `fadeno steering
 * apply <loadout> --codex --force` is not a command — the CLI refuses any
 * positional after `apply` — so freezing it as remediation would have printed
 * an instruction that exits non-zero. If the CLI ever grows a loadout
 * positional, this fails and the frozen text gets re-examined.
 */
test('the rejected remediation spelling is still not a command', (t) => {
  const fx = fixture(t);
  const result = spawnSync(
    process.execPath,
    [CLI, 'steering', 'apply', 'baseline', '--codex', '--force'],
    {
      cwd: fx.root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: fx.user.home!,
        CODEX_HOME: join(fx.user.home!, '.codex'),
        FADENO_CONFIG_HOME: fx.user.env!.FADENO_CONFIG_HOME!,
        FADENO_STATE_HOME: fx.user.env!.FADENO_STATE_HOME!,
        FADENO_HARNESS: 'standalone',
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Usage: fadeno steering apply/);
});

/**
 * The default cascade resolves every archetype to `current-host`, whose agent
 * file states no identity at all by construction (`renderCodexHostAgent` omits
 * both lines — Codex 400s on the literal). Comparing the file's two nulls
 * against the sentinel STRING would report the untouched default as stale,
 * which is the loudest possible false positive: it fires for every user who
 * has not dialed anything.
 */
test('the neutral current-host default is current, not stale', (t) => {
  const fx = fixture(t);
  materialize(fx);

  const materialization = inspect(fx);
  for (const agent of materialization.agents) {
    assert.deepEqual(agent.file, { model: null, effort: null }, `${agent.archetype} file states no identity`);
    assert.deepEqual(agent.dial, { model: null, effort: null, lane: 'host' });
    assert.equal(agent.status, 'current');
  }
  assert.equal(materialization.fresh, true);
  assert.equal(materialization.remediation, null);
});

/**
 * A command-lane dial materializes as a BROKER, whose model and effort are the
 * relay's by construction. Judging that identity against the dial would report
 * drift on a file that is exactly right.
 */
test('a dial on another provider is reported but not judged', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { judge: { model: 'opus' } });
  materialize(fx);

  const judge = row(inspect(fx), 'judge');
  assert.equal(judge.status, 'not_applicable');
  assert.equal(judge.dial?.lane, 'command');
  assert.equal(judge.dial?.model, 'opus', 'the dial is still reported');
  assert.deepEqual(judge.file, { model: 'gpt-5.6-luna', effort: 'high' }, 'the broker carries the relay identity');
  assert.equal(inspect(fx).fresh, true, 'a correct broker is not a stale materialization');
});

test('a missing file outranks the lane it would have been cut for', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { judge: { model: 'opus' } });
  materialize(fx);
  rmSync(join(fx.agentDir, 'fadeno-judge.toml'));
  rmSync(join(fx.agentDir, 'fadeno-worker.toml'));

  const materialization = inspect(fx);
  assert.equal(row(materialization, 'judge').status, 'missing', 'a command-lane slot still needs its broker');
  assert.equal(row(materialization, 'worker').status, 'missing');
  assert.equal(row(materialization, 'reviewer').status, 'current');
  assert.equal(materialization.fresh, false);
  assert.equal(materialization.remediation, CODEX_IDENTITY_REMEDIATION);
});

test('no report at all when Codex is not a maintained harness', (t) => {
  const fx = fixture(t);
  writeFileSync(
    userPaths(fx.user).installationsFile,
    `${JSON.stringify({ schema_version: 1, runtime: null, harnesses: {} })}\n`,
    'utf8',
  );
  assert.equal(runStatus({ repoRoot: fx.root, userPathOptions: fx.user }).codexMaterialization, null);
});

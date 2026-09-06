import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runStatus, type CodexMaterialization } from '../src/commands/status.ts';
import { emitCodexSteeringBrokers, runSteeringApply } from '../src/commands/steering.ts';
import {
  CODEX_IDENTITY_REMEDIATION,
  CODEX_PROJECT_IDENTITY_REMEDIATION,
  CODEX_UNMANAGED_IDENTITY_REMEDIATION,
  codexAgentIdentityStatus,
  describeCodexAgentIdentityRow,
  readCodexAgentFile,
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
  drift(join(fx.agentDir, `fadeno-${archetype}.toml`), model, effort);
}

function drift(path: string, model: string, effort: string): void {
  const text = readFileSync(path, 'utf8')
    .replace(/^model = ".*"$/m, `model = ${JSON.stringify(model)}`)
    .replace(/^model_reasoning_effort = ".*"$/m, `model_reasoning_effort = ${JSON.stringify(effort)}`);
  writeFileSync(path, text, 'utf8');
}

/** Where Codex looks FIRST: `<repo>/.codex/agents/<archetype>.toml`. */
function projectPath(fx: Fixture, archetype: string): string {
  return join(fx.root, '.codex', 'agents', `${archetype}.toml`);
}

/** The project-scope managed set, cut from the same live cascade `status` reads. */
function materializeProject(fx: Fixture): void {
  runSteeringApply({ repoRoot: fx.root, target: 'codex', scope: 'project', userPathOptions: fx.user });
}

/**
 * Codex resolves a PROJECT-scope agent file before it ever looks at the
 * user-scope one, and the user file underneath is then invisible — not lower
 * priority. `status` read only the user file until 2026-09-06, so every case
 * below reported `current` on a file no session would load.
 *
 * These are not exotic states. `fadeno init` writes exactly these three
 * project paths, so any repo scaffolded on a machine that has also run
 * `fadeno setup --codex` is in one of them.
 */
test('a stale PROJECT file shadowing a correct user file is stale, not current', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  materializeProject(fx);
  // Only the project copy drifts. The managed user-scope file still carries
  // exactly what the dial says — which is what made the old reader vouch for a
  // spawn that would have run the project file's identity instead.
  drift(projectPath(fx, 'reviewer'), 'gpt-5.6-luna', 'high');

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'stale', 'the file Codex loads is the project one, and it has drifted');
  assert.equal(reviewer.scope, 'project', 'the row must say WHICH file it judged');
  assert.equal(reviewer.path, projectPath(fx, 'reviewer'));
  assert.deepEqual(reviewer.file, { model: 'gpt-5.6-luna', effort: 'high' });
  assert.equal(materialization.fresh, false);

  // `--scope user` would rewrite the file the project copy is shadowing and
  // change nothing Codex reads, so it must not be the advice.
  assert.equal(materialization.remediation, CODEX_PROJECT_IDENTITY_REMEDIATION);
  assert.notEqual(materialization.remediation, CODEX_IDENTITY_REMEDIATION);
  assert.match(describeCodexAgentIdentityRow(reviewer), /project file .*reviewer\.toml gpt-5\.6-luna\/high vs dial gpt-5\.6-terra\/xhigh/);

  // The reader this replaced, spelled out so the assertion above is provably
  // not tautological: the user-scope path alone, judged by the same unchanged
  // `codexAgentIdentityStatus`. It answers `current` on this exact fixture.
  // That is the whole finding — the judge was right and the file was wrong.
  const userOnly = readCodexAgentFile(join(fx.agentDir, 'fadeno-reviewer.toml'));
  assert.ok(userOnly != null);
  assert.equal(
    codexAgentIdentityStatus({ model: userOnly.model, effort: userOnly.reasoningEffort }, reviewer.dial),
    'current',
    'the user-scope file is correct; reading only it is what made status vouch for a shadowed spawn',
  );
});

/**
 * The project remediation is a claim about the CLI, so it is proved the same
 * way the user-scope one is: by running that exact argv and watching the drift
 * clear. It has to be run, not reasoned about — `--scope user` resolves the
 * user dial layer ALONE (`dialLayersForApply`) while `--scope project` reads
 * the full cascade, which is the second reason the user-scope spelling cannot
 * stand in for it here.
 */
test('the project remediation command clears a project-scope drift when it is actually run', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  materializeProject(fx);
  drift(projectPath(fx, 'reviewer'), 'gpt-5.6-luna', 'high');
  assert.equal(row(inspect(fx), 'reviewer').status, 'stale');

  const result = spawnSync(
    process.execPath,
    [CLI, 'steering', 'apply', '--codex', '--scope', 'project'],
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
  assert.equal(result.status, 0, `project remediation failed: ${result.stderr}`);

  const after = inspect(fx);
  assert.equal(row(after, 'reviewer').status, 'current', 'a managed project file is refreshed in place');
  assert.equal(after.fresh, true);
  assert.equal(after.remediation, null);
});

/**
 * A project file Fadeno never wrote, whose two identity keys happen to agree
 * with the dial. Judging it on those keys alone would call it `current` — a
 * claim about a whole file made from the only two lines this reader can check.
 * It cannot be: nothing verifies its developer instructions resolve an
 * envelope at all, and `steering apply` will never refresh it.
 */
test('an unmanaged project file is never called current, even when its identity matches', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  mkdirSync(join(fx.root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    projectPath(fx, 'reviewer'),
    'name = "reviewer"\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "xhigh"\n',
    'utf8',
  );

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'unmanaged');
  assert.equal(reviewer.scope, 'project');
  assert.equal(reviewer.path, projectPath(fx, 'reviewer'));
  assert.deepEqual(reviewer.file, { model: 'gpt-5.6-terra', effort: 'xhigh' }, 'still reported, just not vouched for');
  assert.equal(materialization.fresh, false);
  // Neither apply spelling overwrites a file Fadeno did not write, so neither
  // may be printed as the fix.
  assert.equal(materialization.remediation, CODEX_UNMANAGED_IDENTITY_REMEDIATION);
  assert.equal(row(materialization, 'worker').status, 'current', 'the untouched slots still load user scope');
});

/**
 * The state `fadeno init` leaves behind: three project-scope command brokers.
 * With a host-lane dial they shadow the managed host agent, so the dialed
 * identity can never spawn in this repo — but the broker's own model/effort
 * are the relay's BY CONSTRUCTION, so `stale` would accuse the file of an
 * identity no `steering apply` would ever write there. It gets its own verdict.
 */
test('a project broker shadowing a host-lane dial is shadowed, not stale and not current', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  emitCodexSteeringBrokers({ repoRoot: fx.root, userPathOptions: fx.user });

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'shadowed');
  assert.equal(reviewer.scope, 'project');
  assert.equal(reviewer.dial?.lane, 'host');
  assert.equal(materialization.fresh, false);
  assert.equal(materialization.remediation, CODEX_PROJECT_IDENTITY_REMEDIATION);
  assert.match(describeCodexAgentIdentityRow(reviewer), /project-scope command broker/);
});

/**
 * The same project brokers under a COMMAND-lane dial are exactly right — the
 * relay identity is what a broker is for — so the shadowing verdict must not
 * fire on lane agreement alone.
 */
test('a project broker under a command-lane dial is reported, not judged', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'opus' } });
  materialize(fx);
  emitCodexSteeringBrokers({ repoRoot: fx.root, userPathOptions: fx.user });

  const reviewer = row(inspect(fx), 'reviewer');
  assert.equal(reviewer.status, 'not_applicable');
  assert.equal(reviewer.scope, 'project', 'still says which file it looked at');
});

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
  // Nothing at either scope, so the row names no file and the fix is to cut
  // the managed set where it belongs — user scope.
  assert.equal(row(materialization, 'worker').scope, null);
  assert.equal(row(materialization, 'worker').path, null);
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

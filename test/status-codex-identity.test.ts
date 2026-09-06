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
  CODEX_TAMPERED_IDENTITY_REMEDIATION,
  CODEX_UNMANAGED_IDENTITY_REMEDIATION,
  codexAgentIdentityStatus,
  codexManagedBody,
  codexManagedDigest,
  codexStandingReason,
  describeCodexAgentIdentityRow,
  readCodexAgentFile,
  stampCodexManagedAgent,
  type CodexAgentIdentityRow,
} from '../src/lib/codex-agent-file.ts';
import { packageVersion } from '../src/lib/paths.ts';
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

/**
 * Rewrite a materialized file's BODY and re-stamp its managed header, so what
 * lands on disk is a file `steering apply` could itself have written.
 *
 * Every fixture below that stands in for "an older build wrote this" or "the
 * dial has since moved" has to go through here, because since 2026-09-06 an
 * edit that leaves the header's `digest=` behind is its own verdict
 * (`tampered`) and that verdict deliberately masks the others. A fixture that
 * skips the re-stamp is not testing the case its name claims — it is testing
 * tampering, with the assertion of a different check. The one test that DOES
 * want tampering edits the file directly and says so.
 */
function rewriteAsApplied(path: string, edit: (text: string) => string): void {
  const before = readFileSync(path, 'utf8');
  const version = /^# fadeno:managed\b[^\n]*?\bversion=(\S+)/.exec(before)?.[1];
  assert.ok(version != null, `${path} must carry a managed header to be re-stamped`);
  writeFileSync(path, stampCodexManagedAgent(edit(codexManagedBody(before)), version), 'utf8');
}

/** Hand-edit one materialized file's identity, the way a dial change leaves it. */
function driftFile(fx: Fixture, archetype: string, model: string, effort: string): void {
  drift(join(fx.agentDir, `fadeno-${archetype}.toml`), model, effort);
}

function drift(path: string, model: string, effort: string): void {
  rewriteAsApplied(path, (body) => body
    .replace(/^model = ".*"$/m, `model = ${JSON.stringify(model)}`)
    .replace(/^model_reasoning_effort = ".*"$/m, `model_reasoning_effort = ${JSON.stringify(effort)}`));
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

/**
 * Rewrite one materialized file's SETTINGS back to what the previous build
 * baked: `sandbox_mode = "workspace-write"` and no `approval_policy` at all.
 * The identity lines are untouched, so the file still agrees with the dial —
 * which is precisely why nothing could see it.
 */
function retireSettings(path: string): void {
  rewriteAsApplied(path, (body) => body
    .replace(/^sandbox_mode = ".*"$/m, 'sandbox_mode = "workspace-write"')
    .replace(/^approval_policy = ".*"\n/m, ''));
}

/**
 * The other half of the same "an older build wrote this" fixture: a file whose
 * `steering resolve` invocation predates `--prompt-file`.
 *
 * Not hypothetical — it is the state `doctor`'s project-shadow branch has
 * described since it was written, and the reason `CODEX_RESOLVE_FLAGS` exists.
 *
 * EVERY mention goes, not just the one in the invocation, because
 * `missingFlags` is a whole-text `includes` and a current render also names the
 * flag in the prose that tells the agent never to omit it. A build that
 * predates the flag mentions it nowhere; one that stripped only the invocation
 * would be a file no renderer has ever produced, and testing against it would
 * be testing the fixture.
 */
function dropPromptFileFlag(path: string): void {
  rewriteAsApplied(path, (body) => body.replaceAll('--prompt-file', ''));
}

/**
 * The gap 3c785e0 filed and did not fix. It moved every command lane to
 * maximal permissions, which for these files meant `sandbox_mode =
 * "danger-full-access"` and `approval_policy = "never"` in place of
 * `sandbox_mode = "workspace-write"` — and left every upgrading user's files
 * frozen on the retired shape with no surface able to say so.
 *
 * The file below is the exact production state after that upgrade: managed,
 * matching model, matching effort, retired settings. Model and effort are the
 * whole of the identity comparison and the header's digest covers the file's
 * OWN body, so both agreed with it; `status` said `fresh`, `doctor` printed
 * "managed host-agent state is current", and the BREAKING change was inert
 * while the report said everything was fine.
 */
test('a managed file carrying the retired sandbox settings is outdated, not current', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  const path = join(fx.agentDir, 'fadeno-reviewer.toml');
  retireSettings(path);

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'outdated');
  assert.equal(reviewer.scope, 'user');
  assert.equal(reviewer.path, path);
  // The identity is untouched and still agrees with the dial — the point being
  // that the identity comparison is not what caught this, and could not be.
  assert.deepEqual(reviewer.file, { model: 'gpt-5.6-terra', effort: 'xhigh' });
  assert.equal(
    codexAgentIdentityStatus(reviewer.file, reviewer.dial),
    'current',
    'the identity judge was right; the FILE was wrong in a way it never reads',
  );
  assert.equal(materialization.fresh, false);
  assert.equal(materialization.restartRequired, true);
  assert.equal(materialization.remediation, CODEX_IDENTITY_REMEDIATION);

  // The detail names both retired settings and the build that wrote them, so
  // the reader can tell an upgrade from a hand edit.
  const detail = describeCodexAgentIdentityRow(reviewer);
  assert.match(detail, /sandbox_mode = "workspace-write" where this build renders "danger-full-access"/);
  assert.match(detail, /no approval_policy where this build renders "never"/);
  assert.match(detail, new RegExp(`cut by fadeno ${packageVersion().replace(/\./g, '\\.')}`));

  // The other two slots were materialized by this build and are untouched, so
  // the verdict is about the file and not about the build being newer.
  assert.equal(row(materialization, 'worker').status, 'current');
  assert.equal(row(materialization, 'judge').status, 'current');
});

/**
 * The same staleness on a command BROKER, which is the shape most upgrading
 * installs are actually in: a broker's identity is the relay's by construction,
 * so `codexAgentIdentityStatus` declines to judge it (`not_applicable`) and
 * every identity-shaped check is blind to it by design. The settings verdict is
 * asked before the dial for exactly this case.
 */
test('a broker carrying the retired sandbox settings is outdated, not not_applicable', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { judge: { model: 'opus' } });
  materialize(fx);
  const path = join(fx.agentDir, 'fadeno-judge.toml');
  retireSettings(path);

  const materialization = inspect(fx);
  const judge = row(materialization, 'judge');
  assert.equal(judge.dial?.lane, 'command', 'a command-lane dial, so the identity is never judged');
  assert.equal(judge.status, 'outdated');
  assert.equal(materialization.fresh, false);
  assert.equal(materialization.remediation, CODEX_IDENTITY_REMEDIATION);
});

/**
 * The remediation is a claim about the CLI, so it is proved the way the other
 * two are: by running that exact argv and watching the verdict clear. `--force`
 * is deliberately absent, and this is what proves it can be — `managedAgentEmit`
 * refreshes a file carrying the managed header whenever its content differs,
 * and an outdated file differs by definition.
 */
test('the frozen remediation command re-cuts an outdated file, with no --force', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  retireSettings(join(fx.agentDir, 'fadeno-reviewer.toml'));
  assert.equal(row(inspect(fx), 'reviewer').status, 'outdated');

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
  assert.equal(row(after, 'reviewer').status, 'current');
  assert.equal(after.fresh, true);
  assert.equal(after.remediation, null);
  const text = readFileSync(join(fx.agentDir, 'fadeno-reviewer.toml'), 'utf8');
  assert.match(text, /^sandbox_mode = "danger-full-access"$/m);
  assert.match(text, /^approval_policy = "never"$/m);
});

/**
 * A project-scope outdated file must NOT be sent to `--scope user`, which
 * rewrites the file the project copy makes invisible. Same rule the identity
 * verdicts follow, and it comes free from `codexIdentityRemediation` — this
 * pins that the new verdict actually goes through it.
 */
test('an outdated PROJECT file gets the project remediation, not the user one', (t) => {
  const fx = fixture(t);
  materialize(fx);
  materializeProject(fx);
  retireSettings(projectPath(fx, 'worker'));

  const materialization = inspect(fx);
  assert.equal(row(materialization, 'worker').status, 'outdated');
  assert.equal(row(materialization, 'worker').scope, 'project');
  assert.equal(materialization.remediation, CODEX_PROJECT_IDENTITY_REMEDIATION);
  assert.notEqual(materialization.remediation, CODEX_IDENTITY_REMEDIATION);
});

/**
 * An UNMANAGED file is not held to Fadeno's render contract: Fadeno did not
 * write it, will never refresh it, and telling its owner to re-cut it would be
 * wrong. `unmanaged` outranks `outdated` for that reason, and the remediation
 * has to stay the move-it-out-of-the-way one.
 */
test('an unmanaged file is unmanaged, not outdated, whatever its settings say', (t) => {
  const fx = fixture(t);
  materialize(fx);
  mkdirSync(join(fx.root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    projectPath(fx, 'reviewer'),
    'name = "reviewer"\nsandbox_mode = "workspace-write"\n',
    'utf8',
  );

  const materialization = inspect(fx);
  assert.equal(row(materialization, 'reviewer').status, 'unmanaged');
  assert.equal(materialization.remediation, CODEX_UNMANAGED_IDENTITY_REMEDIATION);
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

// --- Contract drift: the resolve flags a file's own lane should pass ---

/**
 * `missingFlags` had been computed by `readCodexAgentFile` since the parser
 * existed and no verdict ever read it. Measured on this tree before the fix: a
 * managed user-scope file with `--prompt-file` stripped reported
 * `status: 'current'`, `fresh: true`, `remediation: null`, under a `doctor`
 * line reading "managed host-agent state is current".
 *
 * The damage is not cosmetic. The resolver hashes the prompt bytes that flag
 * points at to decide whether a spawn is paired with a shadow challenger, so a
 * repo whose agent omits it drops out of shadow pairing entirely — silently,
 * with nothing on disk looking wrong. It is `outdated` rather than a fourth
 * verdict because it is the same disagreement `outdated` already names (the
 * file's TEXT vs this build's renderers) and the same single apply clears it.
 */
test('a managed file whose resolve invocation omits --prompt-file is outdated, not current', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  const path = join(fx.agentDir, 'fadeno-reviewer.toml');
  dropPromptFileFlag(path);

  const state = readCodexAgentFile(path)!;
  assert.deepEqual(state.missingFlags, ['--prompt-file']);
  assert.equal(state.digestValid, true, 'an older build stamped its own body correctly; only the text is behind');

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'outdated');
  // The identity still agrees with the dial, which is the point: the
  // comparison that was doing all the judging could never have caught this.
  assert.equal(codexAgentIdentityStatus(reviewer.file, reviewer.dial), 'current');
  assert.equal(materialization.fresh, false);
  assert.equal(materialization.restartRequired, true);
  assert.equal(materialization.remediation, CODEX_IDENTITY_REMEDIATION);

  // Every renderer, told: the standing question, the row sentence, the fix.
  assert.equal(
    codexStandingReason(reviewer),
    'carries no `--prompt-file` in its `steering resolve` invocation where this build\'s renderers pass it',
  );
  const detail = describeCodexAgentIdentityRow(reviewer);
  assert.match(detail, /--prompt-file/);
  assert.match(detail, new RegExp(`cut by fadeno ${packageVersion().replace(/\./g, '\\.')}`));
  // And it must NOT claim the settings are the problem — the sentence used to
  // end "what applies this build's lane permissions" for every outdated file.
  assert.equal(/lane permissions/.test(detail), false, detail);
  assert.equal(/sandbox_mode/.test(detail), false, detail);

  assert.equal(row(materialization, 'worker').status, 'current', 'an untouched slot stays current');
  assert.equal(row(materialization, 'judge').status, 'current');
});

/**
 * A file can be behind on both at once, and the answer has to be ONE row: the
 * two clauses are two symptoms of the same "this file predates this build",
 * and `fadeno steering apply` clears both in one go. A verdict that named only
 * whichever check happened to run first would send its reader to fix half a
 * problem and watch the warning come back.
 */
test('a file with BOTH retired settings and a missing resolve flag names both in one outdated row', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  const path = join(fx.agentDir, 'fadeno-reviewer.toml');
  retireSettings(path);
  dropPromptFileFlag(path);

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'outdated');
  assert.deepEqual(reviewer.missingFlags, ['--prompt-file']);
  assert.equal(reviewer.settingDrift.length, 2);

  for (const sentence of [codexStandingReason(reviewer)!, describeCodexAgentIdentityRow(reviewer)]) {
    assert.match(sentence, /sandbox_mode = "workspace-write" where this build renders "danger-full-access"/);
    assert.match(sentence, /no approval_policy where this build renders "never"/);
    assert.match(sentence, /no `--prompt-file` in its `steering resolve` invocation/);
  }
  // One problem, one fix — not the same command printed three times.
  assert.equal(materialization.remediation, CODEX_IDENTITY_REMEDIATION);
});

/**
 * The false positive the naive version of this check would have shipped, and
 * the reason `missingFlags` is filtered by lane.
 *
 * `renderCodexCommandBroker` has NEVER written `--host-executor` — a broker's
 * identity travels in the dispatch argv — so an unfiltered "which of
 * CODEX_RESOLVE_FLAGS is absent" reports the flag missing on every managed
 * command broker Fadeno has ever written, at every scope, on every machine.
 * Measured on this tree: a freshly emitted broker had
 * `missingFlags: ['--host-executor']` while being exactly correct.
 */
test('a freshly emitted command broker owes no --host-executor and is never outdated for it', (t) => {
  const fx = fixture(t);
  emitCodexSteeringBrokers({ repoRoot: fx.root, userPathOptions: fx.user });

  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const state = readCodexAgentFile(projectPath(fx, archetype))!;
    assert.equal(state.managed, true, archetype);
    assert.equal(state.hostExecutor, null, `${archetype} is a broker: it bakes no --host-executor`);
    assert.deepEqual(state.missingFlags, [], `${archetype} broker must owe no resolve flag`);
    assert.equal(state.digestValid, true, `${archetype} broker's own stamp must verify`);
  }
});

// --- The stamped digest, finally read ---

/**
 * The writer and the reader of `digest=` are one function's inverse, and this
 * is what says so. Getting the hashed bytes wrong by a single newline would
 * report every managed Codex file on every machine as tampered, which is
 * strictly worse than not checking — so the round trip is asserted against a
 * file `steering apply` actually wrote, not against a hand-built string.
 */
test('the digest a real applied file carries is the one this build recomputes for it', (t) => {
  const fx = fixture(t);
  materialize(fx);

  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const path = join(fx.agentDir, `fadeno-${archetype}.toml`);
    const text = readFileSync(path, 'utf8');
    const stamped = /^# fadeno:managed\b[^\n]*?\bdigest=([0-9a-f]{64})/.exec(text)?.[1];
    assert.ok(stamped != null, `${archetype} must be stamped with a sha256`);
    assert.equal(codexManagedDigest(codexManagedBody(text)), stamped, archetype);
    // And the pair is an inverse, so a body survives a stamp unchanged.
    assert.equal(codexManagedBody(stampCodexManagedAgent(codexManagedBody(text), '9.9.9')), codexManagedBody(text));
    assert.equal(readCodexAgentFile(path)!.digestValid, true, archetype);
  }

  // A clean file is still simply `current`: the new check is quiet when it has
  // nothing to say, which is the whole cost of adding it.
  const materialization = inspect(fx);
  assert.equal(materialization.fresh, true);
  assert.equal(materialization.remediation, null);
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    assert.equal(row(materialization, archetype).status, 'current', archetype);
  }
});

/**
 * The gap: `steering apply` has stamped `digest=<sha256 of the body>` since
 * 02bdc54 and nothing ever compared it back. So a hand-edited managed file was
 * undetectable — the header survives the edit, the digest goes stale, and the
 * enumerated checks only cover the two settings keys they know about. An edit
 * to `model`, to `developer_instructions`, or to the resolve line was invisible
 * on every surface.
 *
 * Note the edit below is one `settingDrift` WOULD have caught. `tampered` still
 * wins, and must: on a file whose bytes are not Fadeno's, "carries the retired
 * sandbox setting, re-cut it" names a symptom of the edit while the edit itself
 * — which could equally have moved anything no check enumerates — goes
 * unmentioned, and the remediation quietly destroys it.
 */
test('a hand-edited managed file is tampered, and tampering outranks the checks its edit would trip', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  const path = join(fx.agentDir, 'fadeno-reviewer.toml');
  // Edited in place, header untouched — exactly what a hand edit leaves.
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(/^sandbox_mode = ".*"$/m, 'sandbox_mode = "workspace-write"'),
    'utf8',
  );

  const state = readCodexAgentFile(path)!;
  assert.equal(state.managed, true, 'the header survives the edit — that is the point');
  assert.equal(state.digestValid, false);
  assert.ok(state.settingDrift.length > 0, 'the edit also trips settingDrift, which tampered must outrank');

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'tampered');
  assert.equal(reviewer.scope, 'user');
  assert.equal(reviewer.path, path);
  assert.equal(materialization.fresh, false);
  assert.equal(materialization.restartRequired, true);

  // Every renderer says something true, and none of them says "outdated".
  assert.equal(codexStandingReason(reviewer), 'no longer hashes to the `digest=` its own managed header stamps');
  const detail = describeCodexAgentIdentityRow(reviewer);
  assert.match(detail, /no longer hashes to the `digest=`/);
  assert.match(detail, /cannot vouch for what it does/);
  assert.equal(/where this build renders/.test(detail), false, detail);

  // The fix warns BEFORE it commands, because the apply that repairs the file
  // is the apply that discards the edit.
  const remediation = materialization.remediation!;
  assert.ok(remediation.startsWith(CODEX_TAMPERED_IDENTITY_REMEDIATION), remediation);
  assert.ok(remediation.includes(CODEX_IDENTITY_REMEDIATION), remediation);
  assert.equal(remediation.includes(CODEX_PROJECT_IDENTITY_REMEDIATION), false, remediation);
});

/**
 * And the scope rule still holds for the new verdict, from the one mapping
 * that owns it: a `--scope user` apply cannot reach a project-scope file.
 */
test('a tampered PROJECT file gets the project remediation, still warned first', (t) => {
  const fx = fixture(t);
  materialize(fx);
  materializeProject(fx);
  const path = projectPath(fx, 'worker');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n# hand-added line\n`, 'utf8');

  const materialization = inspect(fx);
  assert.equal(row(materialization, 'worker').status, 'tampered');
  assert.equal(row(materialization, 'worker').scope, 'project');
  const remediation = materialization.remediation!;
  assert.ok(remediation.startsWith(CODEX_TAMPERED_IDENTITY_REMEDIATION), remediation);
  assert.ok(remediation.includes(CODEX_PROJECT_IDENTITY_REMEDIATION), remediation);
});

/**
 * "Not stamped" is not "tampered", and the difference is not pedantry: they
 * have different causes (an older or hand-written build vs. an edit outside
 * `steering apply`) and different costs (re-cutting an unstamped file destroys
 * nothing; re-cutting a tampered one destroys the edit). Collapsing them would
 * accuse an upgrading user of tampering — the same class of confidently-wrong
 * sentence this ladder keeps having to unlearn.
 */
test('a managed header carrying no digest= is reported unstamped, not tampered', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'terra' } });
  materialize(fx);
  const path = join(fx.agentDir, 'fadeno-reviewer.toml');
  const text = readFileSync(path, 'utf8');
  // A header shaped the way a build older than 02bdc54 would have left it.
  writeFileSync(path, `# fadeno:managed version=0.5.0\n${codexManagedBody(text)}`, 'utf8');

  const state = readCodexAgentFile(path)!;
  assert.equal(state.managed, true);
  assert.equal(state.digest, null);
  assert.equal(state.digestValid, null, 'nothing to compare against is not a failed comparison');

  const materialization = inspect(fx);
  const reviewer = row(materialization, 'reviewer');
  assert.equal(reviewer.status, 'outdated', 'a lossless re-cut, not an accusation');
  assert.notEqual(reviewer.status, 'tampered');

  for (const sentence of [codexStandingReason(reviewer)!, describeCodexAgentIdentityRow(reviewer)]) {
    assert.match(sentence, /no `digest=` in its managed header where this build always stamps one/);
    assert.equal(/no longer hashes/.test(sentence), false, sentence);
  }
  assert.equal(materialization.remediation, CODEX_IDENTITY_REMEDIATION);
  assert.equal(materialization.remediation!.includes(CODEX_TAMPERED_IDENTITY_REMEDIATION), false);
});

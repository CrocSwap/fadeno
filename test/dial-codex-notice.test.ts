import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDialSet } from '../src/commands/dial.ts';
import { runSteeringApply } from '../src/commands/steering.ts';
import {
  CODEX_IDENTITY_REMEDIATION,
  CODEX_PROJECT_IDENTITY_REMEDIATION,
  CODEX_UNMANAGED_IDENTITY_REMEDIATION,
  codexManagedBody,
  stampCodexManagedAgent,
} from '../src/lib/codex-agent-file.ts';
import { userPaths, writeUserDials, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * `fadeno dial` moves a dial; it does not — and must not — rewrite
 * `~/.codex/agents/*`. A Codex session loads those files once at start, and a
 * user-scope agent set is machine-wide state that a dial landing on a session
 * layer has no reach over. The friction that put this notice here was the
 * silence in between: a director dialed a role mid-session, believed the
 * change had taken, and spawned the file's old identity for the rest of it.
 */

interface Fixture {
  root: string;
  user: UserPathOptions;
  agentDir: string;
}

function fixture(t: TestContext, options: { codexMaintained?: boolean } = {}): Fixture {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
  const paths = userPaths(user);
  mkdirSync(paths.stateDir, { recursive: true });
  const harnesses = options.codexMaintained === false ? {} : { codex: { version: '0.6.1', files: [] } };
  writeFileSync(
    paths.installationsFile,
    `${JSON.stringify({ schema_version: 1, runtime: null, harnesses })}\n`,
    'utf8',
  );
  return { root, user, agentDir: join(root, 'home', '.codex', 'agents') };
}

/** Materialize the managed set from a starting dial, then move the dial. */
function seed(fx: Fixture, dials: Record<string, { model: string }>): void {
  writeUserDials(fx.user, dials);
  runSteeringApply({ repoRoot: fx.root, target: 'codex', scope: 'user', userPathOptions: fx.user });
}

function agentFile(fx: Fixture, archetype: string): string {
  return readFileSync(join(fx.agentDir, `fadeno-${archetype}.toml`), 'utf8');
}

test('dialing away from the materialized identity says so', (t) => {
  const fx = fixture(t);
  seed(fx, { reviewer: { model: 'luna' } });

  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'reviewer',
    model: 'terra',
    user: true,
  });

  assert.ok(result.codex_materialization != null, 'the managed file still carries the old identity');
  assert.equal(result.codex_materialization.stale, true);
  assert.equal(
    result.codex_materialization.detail,
    'reviewer file gpt-5.6-luna/xhigh vs dial gpt-5.6-terra/xhigh',
  );
  assert.equal(result.codex_materialization.remediation, CODEX_IDENTITY_REMEDIATION);
});

test('the dial leaves the agent file byte-identical', (t) => {
  const fx = fixture(t);
  seed(fx, { reviewer: { model: 'luna' } });
  const before = agentFile(fx, 'reviewer');

  runDialSet({ repoRoot: fx.root, userPathOptions: fx.user, archetype: 'reviewer', model: 'terra', user: true });

  assert.equal(agentFile(fx, 'reviewer'), before, 'fadeno dial never rewrites ~/.codex/agents/*');
});

test('no notice when the file already carries the dial just set', (t) => {
  const fx = fixture(t);
  seed(fx, { reviewer: { model: 'terra' } });

  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'reviewer',
    model: 'terra',
    user: true,
  });
  assert.equal(result.codex_materialization, null);
});

/**
 * A dial on another provider materializes as a command broker carrying the
 * relay's identity, which is not the dial's and never will be. Comparing the
 * two would fire the notice on every single dial to a non-Codex model.
 */
test('no notice for a dial that materializes as a broker', (t) => {
  const fx = fixture(t);
  seed(fx, { judge: { model: 'luna' } });

  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'judge',
    model: 'opus',
    user: true,
  });
  assert.equal(result.codex_materialization, null);
});

test('no notice when Codex is not a maintained harness', (t) => {
  const fx = fixture(t, { codexMaintained: false });
  writeUserDials(fx.user, { reviewer: { model: 'luna' } });
  // Materialize anyway: the files can exist from an earlier install, and it is
  // the manifest — what this machine still maintains — that decides.
  runSteeringApply({ repoRoot: fx.root, target: 'codex', scope: 'user', userPathOptions: fx.user });

  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'reviewer',
    model: 'terra',
    user: true,
  });
  assert.equal(result.codex_materialization, null);
});

test('no notice when the archetype has no managed file at all', (t) => {
  const fx = fixture(t);
  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'reviewer',
    model: 'terra',
    user: true,
  });
  assert.equal(result.codex_materialization, null, 'a file that does not exist has no identity to disagree');
});

/**
 * Codex loads `<repo>/.codex/agents/<archetype>.toml` before it ever looks at
 * `$CODEX_HOME/agents/fadeno-<archetype>.toml`, and this notice read only the
 * second one until 2026-09-06.
 *
 * The user-scope-only read failed in two directions, and this is the SILENT
 * one: with no user-scope file the old code hit `if (state == null) return
 * null` and printed nothing at all — having concluded there was no managed
 * agent to disagree with, while a project file sat in the repo ready to spawn
 * the identity the user had just dialed away from. That is the ordinary state
 * of any repo scaffolded by `fadeno init` on a machine where `fadeno setup
 * --codex` has not run.
 */
test('a project file shadowing an ABSENT user file still gets a notice', (t) => {
  const fx = fixture(t);
  writeUserDials(fx.user, { reviewer: { model: 'luna' } });
  runSteeringApply({ repoRoot: fx.root, target: 'codex', scope: 'project', userPathOptions: fx.user });
  assert.ok(!existsSync(join(fx.agentDir, 'fadeno-reviewer.toml')), 'nothing at user scope to read');

  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'reviewer',
    model: 'terra',
    user: true,
  });

  assert.ok(result.codex_materialization != null, 'the project file still carries the old identity');
  assert.equal(result.codex_materialization.status, 'stale');
  assert.match(result.codex_materialization.detail, /project file .*reviewer\.toml gpt-5\.6-luna\/xhigh vs dial gpt-5\.6-terra\/xhigh/);
  // A user-scope apply would write a file this project copy shadows.
  assert.equal(result.codex_materialization.remediation, CODEX_PROJECT_IDENTITY_REMEDIATION);
  assert.notEqual(result.codex_materialization.remediation, CODEX_IDENTITY_REMEDIATION);
});

/**
 * The loud direction of the same bug: a correct user-scope file underneath a
 * drifted project one. The old reader found the user file, judged it current,
 * and said nothing.
 */
test('a stale project file shadowing a CORRECT user file gets a notice', (t) => {
  const fx = fixture(t);
  seed(fx, { reviewer: { model: 'terra' } });
  runSteeringApply({ repoRoot: fx.root, target: 'codex', scope: 'project', userPathOptions: fx.user });
  const projectFile = join(fx.root, '.codex', 'agents', 'reviewer.toml');
  // Re-stamped, because the state being staged is "an apply at an earlier dial
  // wrote this", not "someone edited it". Since 2026-09-06 a managed file whose
  // body no longer hashes to its own header's `digest=` is `tampered`, and that
  // verdict masks `stale` — leaving the stamp behind would quietly turn this
  // into a test of a different check.
  writeFileSync(
    projectFile,
    stampCodexManagedAgent(
      codexManagedBody(readFileSync(projectFile, 'utf8'))
        .replace(/^model = ".*"$/m, 'model = "gpt-5.6-luna"')
        .replace(/^model_reasoning_effort = ".*"$/m, 'model_reasoning_effort = "high"'),
      '0.6.1',
    ),
    'utf8',
  );

  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'reviewer',
    model: 'terra',
    user: true,
  });

  assert.ok(result.codex_materialization != null, 'the user file agrees, but it is not the file that loads');
  assert.equal(result.codex_materialization.status, 'stale');
  assert.equal(agentFile(fx, 'reviewer').includes('gpt-5.6-terra'), true, 'the user-scope file is the correct one');
});

/**
 * A file Fadeno never wrote is what Codex will load. Whatever this dial says,
 * that file's instructions are unverified and no apply will refresh them, so
 * the notice fires rather than pretending the dial took.
 */
test('an unmanaged project file gets its own notice and its own fix', (t) => {
  const fx = fixture(t);
  seed(fx, { reviewer: { model: 'terra' } });
  mkdirSync(join(fx.root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    join(fx.root, '.codex', 'agents', 'reviewer.toml'),
    'name = "reviewer"\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "xhigh"\n',
    'utf8',
  );

  const result = runDialSet({
    repoRoot: fx.root,
    userPathOptions: fx.user,
    archetype: 'reviewer',
    model: 'terra',
    user: true,
  });

  assert.ok(result.codex_materialization != null);
  assert.equal(result.codex_materialization.status, 'unmanaged');
  assert.equal(result.codex_materialization.remediation, CODEX_UNMANAGED_IDENTITY_REMEDIATION);
});

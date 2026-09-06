import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDialSet } from '../src/commands/dial.ts';
import { runSteeringApply } from '../src/commands/steering.ts';
import { CODEX_IDENTITY_REMEDIATION } from '../src/lib/codex-agent-file.ts';
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

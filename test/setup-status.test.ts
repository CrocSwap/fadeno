import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runSetup, SetupError } from '../src/commands/setup.ts';
import { runStatus } from '../src/commands/status.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4, gitRepo, tempRepo } from './helpers.ts';

/**
 * `setup` links the CLI onto PATH and `status` reports what it finds. Both
 * used to be about a managed COPY of the CLI — installed, version-compared,
 * refreshed, and reported on a `use:` line. The copy is gone; these tests are
 * about the link that replaced it and the two checks the doctor left behind.
 */

/** A CLI to link at: an executable file, standing in for the plugin's bundle. */
function fakeCli(dir: string, name = 'fadeno'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho fake\n', 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function seed(t: TestContext, catalog?: string): { root: string; user: UserPathOptions; source: string } {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalog ?? catalogV4({ archetypes: { worker: {}, reviewer: {} } }));
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'cfg'),
      FADENO_STATE_HOME: join(root, 'state'),
      FADENO_DATA_HOME: join(root, 'data'),
      FADENO_BIN_DIR: join(root, 'bin'),
      FADENO_HARNESS: 'standalone',
      PATH: '/usr/bin',
    },
    platform: 'darwin',
  };
  return { root, user, source: fakeCli(join(root, 'plugin-bin')) };
}

test('setup links the CLI rather than copying it, and says when the directory is not on PATH', (t) => {
  const { root, user, source } = seed(t);
  const result = runSetup({ repoRoot: root, userPathOptions: user, source, probeCommand: (command) => ({ name: command, command, available: false, version: null }) });
  assert.equal(result.link.action, 'created');
  assert.equal(result.link.path, join(root, 'bin', 'fadeno'));
  assert.equal(lstatSync(result.link.path).isSymbolicLink(), true, 'a link, never a copy');
  assert.equal(readlinkSync(result.link.path), source);
  assert.equal(result.link.onPath, false);
  assert.match(result.notices.join('\n'), /is not on this shell's PATH/);
  assert.match(result.notices.join('\n'), /It is a link, not a copy/);

  // Running it again is a no-op, and running it against a new plugin build
  // retargets the same link — which is the whole point of a link.
  assert.equal(runSetup({ repoRoot: root, userPathOptions: user, source }).link.action, 'unchanged');
  const next = fakeCli(join(root, 'plugin-bin-2'));
  assert.equal(runSetup({ repoRoot: root, userPathOptions: user, source: next }).link.action, 'retargeted');
  assert.equal(readlinkSync(join(root, 'bin', 'fadeno')), next);
});

test('setup sees its own directory on PATH, and refuses to clobber a `fadeno` it did not write', (t) => {
  const { root, user, source } = seed(t);
  const onPath: UserPathOptions = { ...user, env: { ...user.env, PATH: ['/usr/bin', join(root, 'bin')].join(delimiter) } };
  assert.equal(runSetup({ repoRoot: root, userPathOptions: onPath, source }).link.onPath, true);

  // Somebody else's fadeno at the same path: a copy, not a link. Replacing it
  // silently would take over a command Fadeno does not own.
  const { root: other, user: otherUser, source: otherSource } = seed(t);
  fakeCli(join(other, 'bin'));
  assert.throws(
    () => runSetup({ repoRoot: other, userPathOptions: otherUser, source: otherSource }),
    (err: unknown) => err instanceof SetupError && /is not something Fadeno wrote/.test(err.message),
  );
  const forced = runSetup({ repoRoot: other, userPathOptions: otherUser, source: otherSource, force: true });
  assert.equal(forced.link.action, 'retargeted');
  assert.equal(lstatSync(forced.link.path).isSymbolicLink(), true);
});

test('setup sweeps the state the managed-runtime era wrote, because nothing reads it now', (t) => {
  const { root, user, source } = seed(t);
  const stateDir = join(root, 'state', 'fadeno');
  mkdirSync(join(root, 'data', 'fadeno', 'runtime'), { recursive: true });
  writeFileSync(join(root, 'data', 'fadeno', 'runtime', 'fadeno'), 'an old copy of the CLI\n', 'utf8');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'installations.json'), '{"schema_version":1,"runtime":null,"harnesses":{}}\n', 'utf8');
  writeFileSync(join(stateDir, 'harness'), 'codex\n', 'utf8');
  // Not ours: a state file that is still live must survive the sweep.
  writeFileSync(join(stateDir, 'dials.json'), '{}\n', 'utf8');

  const result = runSetup({ repoRoot: root, userPathOptions: user, source });
  assert.deepEqual(
    result.removed.map((path) => path.replace(root, '<root>')),
    ['<root>/state/fadeno/harness', '<root>/state/fadeno/installations.json', '<root>/data/fadeno/runtime'],
  );
  assert.equal(existsSync(join(root, 'data', 'fadeno', 'runtime')), false, 'a second CLI on disk is a second Fadeno');
  assert.equal(existsSync(join(stateDir, 'dials.json')), true);
});

test('setup removes the agent files an earlier Fadeno materialized, and leaves hand-written ones alone', (t) => {
  const { root, user, source } = seed(t);
  const projectAgents = join(root, '.codex', 'agents');
  const userAgents = join(root, 'home', '.codex', 'agents');
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(userAgents, { recursive: true });
  writeFileSync(join(projectAgents, 'worker.toml'), '# fadeno:managed version=0.6.1\nmodel = "gpt-5.6-luna"\n', 'utf8');
  writeFileSync(join(userAgents, 'fadeno-judge.toml'), '# fadeno:managed version=0.6.1\nmodel = "opus"\n', 'utf8');
  // Not Fadeno's, and never touched: an agent file without the marker belongs
  // to the user, whatever it is named.
  writeFileSync(join(projectAgents, 'reviewer.toml'), 'model = "mine"\n', 'utf8');

  const result = runSetup({ repoRoot: root, userPathOptions: user, source, target: 'codex' });
  assert.equal(existsSync(join(projectAgents, 'worker.toml')), false);
  assert.equal(existsSync(join(userAgents, 'fadeno-judge.toml')), false);
  assert.equal(existsSync(join(projectAgents, 'reviewer.toml')), true, 'a hand-written agent file is the user\'s');
  assert.match(result.notices.join('\n'), /worker\.toml, which an earlier Fadeno materialized.*overrides the dial/s);
});

test('setup --claude grants the CLI permission once, in the user\'s own settings', (t) => {
  const { root, user, source } = seed(t);
  const settings = join(root, 'home', '.claude', 'settings.json');
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2), 'utf8');

  const result = runSetup({ repoRoot: root, userPathOptions: user, source, target: 'claude' });
  assert.deepEqual(result.permission, { path: settings, rule: 'Bash(fadeno:*)' });
  assert.match(result.notices.join('\n'), /Bash\(fadeno:\*\)/, 'a grant is never silent');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).permissions.allow, ['Bash(ls:*)', 'Bash(fadeno:*)']);
  // Idempotent: a second setup does not stack duplicates.
  runSetup({ repoRoot: root, userPathOptions: user, source, target: 'claude' });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).permissions.allow, ['Bash(ls:*)', 'Bash(fadeno:*)']);

  // Without --claude nothing is written to another tool's settings.
  const { root: bare, user: bareUser, source: bareSource } = seed(t);
  assert.equal(runSetup({ repoRoot: bare, userPathOptions: bareUser, source: bareSource }).permission, null);
});

test('setup refuses before it writes when the repo catalog does not load', (t) => {
  // A model no harness can deliver: a file someone edits, and a load error.
  const { root, user, source } = seed(t, catalogV4({ models: { ghost: { provider: 'nowhere', id: 'ghost-1' } } }));
  assert.throws(() => runSetup({ repoRoot: root, userPathOptions: user, source }), SetupError);
  assert.equal(existsSync(join(root, 'bin', 'fadeno')), false, 'a refused setup links nothing');
});

test('status answers with the routing dial prints, and nothing needs attention on a healthy repo', (t) => {
  const { root, user, source } = seed(t);
  runSetup({ repoRoot: root, userPathOptions: user, source });
  const result = runStatus({ repoRoot: root, userPathOptions: user });
  assert.equal(result.harness, 'standalone');
  assert.equal(result.link.state, 'linked');
  assert.equal(result.link.target, source);
  assert.deepEqual(result.routing.map((row) => row.archetype), ['judge', 'reviewer', 'worker']);
  // From a bare shell the undialed base has no lane, and status says so
  // rather than reporting a command lane with nothing to invoke.
  assert.equal(result.attention.length, 3);
  assert.ok(result.attention.every((item) => /has no lane from here/.test(item)), result.attention.join('\n'));
});

test('status names an unlinked CLI, an agent file that answers an archetype, and open work', (t) => {
  const { root, user } = seed(t);
  // No setup ran, so there is no link.
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', 'worker.md'), '---\nname: worker\nmodel: haiku\n---\nmine\n', 'utf8');
  mkdirSync(join(root, 'home', '.codex', 'agents'), { recursive: true });
  // The filename says `fadeno-reviewer`; the file says `name = "reviewer"`,
  // and the name is what a spawn asks for. A check that probed filenames
  // missed exactly these — every file an earlier Fadeno wrote at user scope.
  writeFileSync(join(root, 'home', '.codex', 'agents', 'fadeno-reviewer.toml'), 'name = "reviewer"\nmodel = "gpt-5"\n', 'utf8');
  // Nobody's archetype, so nobody's business.
  writeFileSync(join(root, 'home', '.codex', 'agents', 'note-taker.toml'), 'name = "note-taker"\n', 'utf8');

  const result = runStatus({ repoRoot: root, userPathOptions: user });
  assert.equal(result.link.state, 'missing');
  assert.deepEqual(
    result.agentFiles.map((file) => [file.archetype, file.harness, file.scope]),
    [['worker', 'claude', 'project'], ['reviewer', 'codex', 'user']],
  );
  const attention = result.attention.join('\n');
  assert.match(attention, /no `fadeno` linked at .*run `fadeno setup`/);
  assert.match(attention, /fadeno-reviewer\.toml defines the agent "reviewer" \(user scope, codex\)\. A Codex agent file wins over the model a spawn passes/);
  assert.match(attention, /worker\.md defines the agent "worker" \(project scope, claude\)/);
  assert.doesNotMatch(attention, /note-taker/);
});

test('status refuses in one voice with dial when the machine-local dials cannot be read', (t) => {
  const { root, user } = seed(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), 'a pre-0.6 loadout name\n', 'utf8');
  assert.throws(() => runStatus({ repoRoot: root, userPathOptions: user }), /\.fadeno\/local\/dials .*Fix: delete it/s);
});

test('a repo with no git and no catalog still reports', (t) => {
  const root = tempRepo(t);
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state'), FADENO_BIN_DIR: join(root, 'bin'), FADENO_HARNESS: 'standalone' },
  };
  const result = runStatus({ repoRoot: root, userPathOptions: user });
  assert.equal(result.projectCustomized, false);
  assert.equal(result.unclosed, 0);
  assert.deepEqual(result.worktrees, []);
  assert.ok(result.routing.length > 0, 'the builtin catalog still answers');
});

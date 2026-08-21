import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { hostEffortIsMaterializable } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

/**
 * `hostEffortIsMaterializable` must keep saying what `steering apply` does.
 *
 * The predicate exists because `fadeno dial <a> <model>@<effort>` has to tell
 * the user what happens to that pin, and the answer splits by harness: a Codex
 * agent TOML has `model_reasoning_effort`, Claude's Agent tool has no effort
 * channel. The note said only the Codex half for both, so a Claude user
 * pinning an effort was told to "run `fadeno steering apply` to pin it into
 * the host agent slots" — a command that, on that harness, writes nothing.
 *
 * A test that merely restated the predicate would have passed the whole time.
 * So each case RUNS the apply and reads the filesystem.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function seed(t: TestContext, harness: 'claude' | 'codex'): { root: string; env: NodeJS.ProcessEnv } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'xhigh' },
      luna: { provider: 'openai', id: 'gpt-luna', effort: 'xhigh' },
    },
    routes: {
      claude: {
        'current-host': { host: true },
        anthropic: { driver: 'claude', host: true, command: ['claude', '-p', '--model', '{model}'], write_access: true },
      },
      codex: {
        'current-host': { host: true },
        openai: { driver: 'codex', host: true, command: ['codex', 'exec'], write_access: true },
      },
    },
    archetypes: {},
    dials: {},
  }));
  return {
    root,
    env: {
      ...process.env,
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: harness,
      CODEX_HOME: join(root, 'codex-home'),
      HOME: join(root, 'home'),
    },
  };
}

test('codex CAN carry a dialed effort into a host slot, and apply writes one', (t) => {
  const { root, env } = seed(t, 'codex');
  assert.equal(hostEffortIsMaterializable('codex'), true);

  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'luna@medium', '--session'], { cwd: root, env });
  execFileSync(process.execPath, [CLI, 'steering', 'apply', '--codex'], { cwd: root, env, encoding: 'utf8' });

  const toml = readFileSync(join(root, '.codex', 'agents', 'worker.toml'), 'utf8');
  // The effort is IN the file — that is the whole claim the note makes.
  assert.match(toml, /model_reasoning_effort\s*=\s*"medium"/);
});

test('claude CANNOT, and apply writes no agent file to pretend otherwise', (t) => {
  const { root, env } = seed(t, 'claude');
  assert.equal(hostEffortIsMaterializable('claude'), false);

  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'sonnet@medium', '--session'], { cwd: root, env });
  execFileSync(process.execPath, [CLI, 'steering', 'apply', '--claude'], { cwd: root, env, encoding: 'utf8' });

  const dir = join(root, '.claude', 'agents');
  const written = existsSync(dir) ? readdirSync(dir) : [];
  assert.deepEqual(written, [], 'apply must not leave a file that pins a dialed effort');
});

test('the dial note tells each harness the truth about its own pin', (t) => {
  const codex = seed(t, 'codex');
  const codexNote = execFileSync(
    process.execPath, [CLI, 'dial', 'worker', 'luna@medium', '--session'],
    { cwd: codex.root, env: codex.env, encoding: 'utf8' },
  );
  assert.match(codexNote, /run `fadeno steering apply`/);

  const claude = seed(t, 'claude');
  const claudeNote = execFileSync(
    process.execPath, [CLI, 'dial', 'worker', 'sonnet@medium', '--session'],
    { cwd: claude.root, env: claude.env, encoding: 'utf8' },
  );
  // Not "go run apply" — apply is inert here, and saying so is the fix.
  assert.match(claudeNote, /selects the DELIVERY LANE instead/);
  assert.match(claudeNote, /`fadeno steering apply` writes nothing here/);
});

test('a pin that strands a write-required archetype says so at SET time', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  // The shipped shape: the host route's command lane cannot write, and being
  // a host route it may not declare a `write_variant` to fix that.
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'xhigh' } },
    routes: {
      claude: {
        'current-host': { host: true },
        anthropic: { driver: 'claude', host: true, command: ['claude', '-p', '--model', '{model}'], write_access: false },
      },
    },
    archetypes: { worker: { requires_write: 'required' } },
    dials: {},
  }));
  const env = {
    ...process.env,
    FADENO_CONFIG_HOME: join(root, 'user-config'),
    FADENO_STATE_HOME: join(root, 'user-state'),
    FADENO_HARNESS: 'claude',
    HOME: join(root, 'home'),
  };
  const out = execFileSync(
    process.execPath, [CLI, 'dial', 'worker', 'sonnet@medium', '--session'],
    { cwd: root, env, encoding: 'utf8' },
  );
  // Set time, not dispatch time: the dial is what created the dead end.
  assert.match(out, /WARNING: that command lane cannot deliver worker/);
  assert.match(out, /requires_write: required/);
});

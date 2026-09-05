import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { hostEffortIsMaterializable, parseExecutorProfile } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

/**
 * `hostEffortIsMaterializable` must keep saying what `steering apply` does.
 *
 * The predicate exists because a pinned effort has to reach the host somehow,
 * and the answer splits by harness: a Codex agent TOML has
 * `model_reasoning_effort`, Claude's Agent tool has no effort channel at all.
 * Under v4 the catalog states it directly — `harnesses.<id>.host.effort_channel`
 * — instead of the predicate hardcoding a harness name, so a new host declares
 * its own answer rather than waiting for a source edit.
 *
 * A test that merely restated the predicate would have passed the whole time.
 * So each case RUNS the apply and reads the filesystem, and the third asks
 * `dial resolve` — which is where the lane is answered now that `dial set`
 * validates against the registry only.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

const CATALOG = {
  schema_version: 4,
  models: {
    sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'xhigh' },
    luna: { provider: 'openai', id: 'gpt-luna', effort: 'xhigh' },
  },
  harnesses: { claude: { provider: 'anthropic', host: { effort_channel: 'none' }, command: ['claude', '-p', '--model', '{model}'] }, codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: ['codex', 'exec'] } },
  archetypes: {},
  dials: {},
};

function seed(t: TestContext, harness: 'claude' | 'codex'): { root: string; env: NodeJS.ProcessEnv } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: {
      sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'xhigh' },
      luna: { provider: 'openai', id: 'gpt-luna', effort: 'xhigh' },
    },
    harnesses: { claude: { provider: 'anthropic', host: { effort_channel: 'none' }, command: ['claude', '-p', '--model', '{model}'] }, codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: ['codex', 'exec'] } },
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
  const profile = parseExecutorProfile(stringifyYaml(CATALOG), 'fixture', 'codex');
  assert.equal(hostEffortIsMaterializable(profile, 'codex'), true);

  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'luna@medium', '--session'], { cwd: root, env });
  execFileSync(process.execPath, [CLI, 'steering', 'apply', '--codex'], { cwd: root, env, encoding: 'utf8' });

  const toml = readFileSync(join(root, '.codex', 'agents', 'worker.toml'), 'utf8');
  // The effort is IN the file — that is the whole claim the note makes.
  assert.match(toml, /model_reasoning_effort\s*=\s*"medium"/);
});

test('claude CANNOT, and apply writes no agent file to pretend otherwise', (t) => {
  const { root, env } = seed(t, 'claude');
  const profile = parseExecutorProfile(stringifyYaml(CATALOG), 'fixture', 'claude');
  assert.equal(hostEffortIsMaterializable(profile, 'claude'), false);

  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'sonnet@medium', '--session'], { cwd: root, env });
  execFileSync(process.execPath, [CLI, 'steering', 'apply', '--claude'], { cwd: root, env, encoding: 'utf8' });

  const dir = join(root, '.claude', 'agents');
  const written = existsSync(dir) ? readdirSync(dir) : [];
  assert.deepEqual(written, [], 'apply must not leave a file that pins a dialed effort');
});

test('dial set says nothing about the lane; `dial resolve` tells each harness the truth', (t) => {
  // Catalog v4 moved this out of set time: a dial is stored host-neutrally and
  // re-resolved at every dispatch, so narrating the lane where the dial is
  // WRITTEN made the same command print a different story in each terminal.
  const codex = seed(t, 'codex');
  const codexSet = execFileSync(
    process.execPath, [CLI, 'dial', 'worker', 'luna@medium', '--session'],
    { cwd: codex.root, env: codex.env, encoding: 'utf8' },
  );
  assert.doesNotMatch(codexSet, /steering apply/, 'set time narrates no lane at all');
  assert.doesNotMatch(codexSet, /DELIVERY LANE/);

  // Before apply, nothing on disk proves the pin, so the pin takes the command
  // lane where the effort travels in the argv.
  const beforeApply = JSON.parse(execFileSync(
    process.execPath, [CLI, 'dial', 'resolve', '--archetype', 'worker', '--json'],
    { cwd: codex.root, env: { ...codex.env, CLAUDE_EFFORT: '' }, encoding: 'utf8' },
  )) as Record<string, unknown>;
  assert.equal(beforeApply.lane, 'command');
  assert.equal(beforeApply.lane_reason, 'session effort unobserved');

  // Claude has no effort channel at all, so apply can never change the answer.
  const claude = seed(t, 'claude');
  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'sonnet@medium', '--session'], { cwd: claude.root, env: claude.env, encoding: 'utf8' });
  execFileSync(process.execPath, [CLI, 'steering', 'apply', '--claude'], { cwd: claude.root, env: claude.env, encoding: 'utf8' });
  const claudeResolved = JSON.parse(execFileSync(
    process.execPath, [CLI, 'dial', 'resolve', '--archetype', 'worker', '--json'],
    { cwd: claude.root, env: { ...claude.env, CLAUDE_EFFORT: '' }, encoding: 'utf8' },
  )) as Record<string, unknown>;
  assert.equal(claudeResolved.lane, 'command');
  assert.equal(claudeResolved.host, 'claude');
  assert.equal(claudeResolved.harness, 'claude');
});


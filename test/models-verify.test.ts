import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelsVerifyError, runModelsVerify } from '../src/commands/models-verify.ts';
import { unknownFlagsFor } from '../src/commands/completion.ts';
import { readVerifiedModels, recordVerifiedModel, type UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4, tempRepo } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function isolated(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

/**
 * Three dialed pairs on purpose: one listable harness per dial plus `claude`,
 * which declares no `models_command` at all — the skipped case has to be a
 * first-class outcome, not an absence.
 */
const CATALOG = catalogV4({
  models: {
    sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
    opus: { provider: 'anthropic', id: 'opus', effort: 'high', spellings: { opencode: 'anthropic/claude-opus' } },
  },
  harnesses: {
    codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'], models_command: ['codex-models'] },
    claude: { provider: 'anthropic', command: ['claude', '-p', '--model', '{model}'] },
    opencode: { command: ['opencode', 'run', '-m', '{model}'], models_command: ['opencode-models'] },
  },
  archetypes: { worker: {}, reviewer: {}, judge: {} },
  dials: { worker: 'sol', reviewer: 'opus on opencode', judge: 'opus' },
  unregistered_model_harness: 'opencode',
});

function seed(t: TestContext): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), CATALOG);
  return { root, user: isolated(root) };
}

type Backend = { status?: number; stdout?: string; error?: Error };

/** An injected listing per `models_command[0]`; anything else is a test bug. */
function backends(map: Record<string, Backend>): { spawn: (command: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error }; seen: string[] } {
  const seen: string[] = [];
  const spawn = (command: string[]) => {
    seen.push(command.join(' '));
    const entry = map[command[0]!];
    assert.ok(entry != null, `models verify spawned an undeclared command: ${command.join(' ')}`);
    if (entry.error != null) return { status: null, stdout: '', stderr: '', error: entry.error };
    return { status: entry.status ?? 0, stdout: entry.stdout ?? '', stderr: '' };
  };
  return { spawn, seen };
}

function byPair(result: { rows: Array<{ harness: string; model_id: string; outcome: string }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of result.rows) out[`${row.harness} ${row.model_id}`] = row.outcome;
  return out;
}

test('models verify: a still-listed model is re-probed past the cache and gets a fresh row', (t) => {
  const { root, user } = seed(t);
  recordVerifiedModel(user, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2020-01-01T00:00:00Z' });
  const { spawn, seen } = backends({ 'codex-models': { stdout: 'gpt-5.6-sol\ngpt-5.6-luna\n' } });

  const result = runModelsVerify({ repoRoot: root, userPathOptions: user, refs: ['sol'], spawn });
  assert.deepEqual(seen, ['codex-models'], 'the cached row did not short-circuit the probe');
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.outcome, 'verified');
  assert.equal(row.model, 'sol');
  assert.deepEqual(row.archetypes, ['worker']);
  assert.ok(row.verified_at != null && row.verified_at > '2020-01-01T00:00:00Z');
  assert.equal(result.ok, true);

  const cached = readVerifiedModels(user);
  assert.equal(cached.length, 1, 'the stale row was replaced, not duplicated');
  assert.equal(cached[0]!.verified_at, row.verified_at);
});

test('models verify: a listing that omits the model deletes its rows and fails the command', (t) => {
  const { root, user } = seed(t);
  recordVerifiedModel(user, { harness: 'opencode', model: 'anthropic/claude-opus', verified_at: '2026-08-01T00:00:00Z' });
  recordVerifiedModel(user, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2026-08-01T00:00:00Z' });
  const { spawn } = backends({ 'opencode-models': { stdout: 'anthropic/claude-sonnet\nqwen-max\n' } });

  const result = runModelsVerify({ repoRoot: root, userPathOptions: user, harness: 'opencode', spawn });
  assert.equal(result.ok, false, 'a definitive miss must exit non-zero');
  const row = result.rows.find((r) => r.harness === 'opencode')!;
  assert.equal(row.outcome, 'not_listed');
  assert.equal(row.listed_id, 'anthropic/claude-opus');
  assert.equal(row.verifications_removed, 1);
  assert.match(row.detail ?? '', /fadeno dial <archetype> <other>/);

  assert.deepEqual(
    readVerifiedModels(user).map((r) => `${r.harness} ${r.model}`),
    ['codex gpt-5.6-sol'],
    'only the disproven pair lost its row',
  );
});

test('models verify: an unreachable listing leaves the cache alone and passes unless --strict', (t) => {
  const { root, user } = seed(t);
  recordVerifiedModel(user, { harness: 'codex', model: 'gpt-5.6-sol', verified_at: '2026-08-01T00:00:00Z' });

  const failing = () => backends({ 'codex-models': { status: 1 } }).spawn;
  const lenient = runModelsVerify({ repoRoot: root, userPathOptions: user, refs: ['sol'], spawn: failing() });
  assert.equal(lenient.rows[0]!.outcome, 'unavailable');
  assert.equal(lenient.rows[0]!.verifications_removed, 0);
  assert.match(lenient.rows[0]!.detail ?? '', /models_command exited 1/);
  assert.equal(lenient.ok, true, 'a backend that is down says nothing about the model');
  assert.equal(readVerifiedModels(user).length, 1, 'the row is untouched');

  const strict = runModelsVerify({ repoRoot: root, userPathOptions: user, refs: ['sol'], strict: true, spawn: failing() });
  assert.equal(strict.ok, false);
  assert.equal(readVerifiedModels(user).length, 1);
});

test('models verify: the default set is every dialed pair, and an unlistable harness is skipped, not probed', (t) => {
  const { root, user } = seed(t);
  const { spawn, seen } = backends({
    'codex-models': { stdout: 'gpt-5.6-sol\n' },
    'opencode-models': { stdout: 'anthropic/claude-opus\n' },
  });

  const result = runModelsVerify({ repoRoot: root, userPathOptions: user, spawn });
  assert.deepEqual(byPair(result), {
    'claude opus': 'skipped',
    'codex gpt-5.6-sol': 'verified',
    'opencode anthropic/claude-opus': 'verified',
  });
  assert.deepEqual(seen.sort(), ['codex-models', 'opencode-models'], 'the skipped pair spawned nothing');
  const skipped = result.rows.find((r) => r.outcome === 'skipped')!;
  assert.deepEqual(skipped.archetypes, ['judge']);
  assert.match(skipped.detail ?? '', /declares no models_command/);
  assert.deepEqual(result.counts, { verified: 2, not_listed: 0, unavailable: 0, skipped: 1 });
  assert.equal(result.ok, true);
});

test('models verify: refs and --harness narrow, and an unmatched ref is an error rather than an empty pass', (t) => {
  const { root, user } = seed(t);
  const listings = {
    'codex-models': { stdout: 'gpt-5.6-sol\n' },
    'opencode-models': { stdout: 'anthropic/claude-opus\n' },
  };

  const byId = runModelsVerify({ repoRoot: root, userPathOptions: user, refs: ['anthropic/claude-opus'], spawn: backends(listings).spawn });
  assert.deepEqual(byPair(byId), { 'opencode anthropic/claude-opus': 'verified' });

  const byProviderId = runModelsVerify({ repoRoot: root, userPathOptions: user, refs: ['openai/gpt-5.6-sol'], spawn: backends(listings).spawn });
  assert.deepEqual(byPair(byProviderId), { 'codex gpt-5.6-sol': 'verified' });

  const byHarness = runModelsVerify({ repoRoot: root, userPathOptions: user, harness: 'codex', spawn: backends(listings).spawn });
  assert.deepEqual(byPair(byHarness), { 'codex gpt-5.6-sol': 'verified' });

  assert.throws(
    () => runModelsVerify({ repoRoot: root, userPathOptions: user, refs: ['sol', 'nope'], spawn: backends(listings).spawn }),
    (err: unknown) => {
      assert.ok(err instanceof ModelsVerifyError);
      assert.match(err.message, /no dialed model matches "nope"/);
      assert.match(err.message, /dialed models: opus, sol/);
      return true;
    },
  );
  assert.throws(
    () => runModelsVerify({ repoRoot: root, userPathOptions: user, harness: 'nosuch', spawn: backends(listings).spawn }),
    /unknown harness "nosuch"/,
  );
});

/**
 * Two dialed aliases whose deliveries collapse onto ONE `(harness, id)` pair.
 * Deduplicating by that pair is right — probing it twice is just slower — but
 * the names each alias can be asked for by have to survive the merge.
 */
const SHARED_DELIVERY = catalogV4({
  models: {
    alpha: { provider: 'openai', id: 'alpha-id', effort: 'default', spellings: { codex: 'same' } },
    beta: { provider: 'openai', id: 'beta-id', effort: 'default', spellings: { codex: 'same' } },
  },
  harnesses: {
    codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'], models_command: ['codex-models'] },
  },
  archetypes: { worker: {}, reviewer: {} },
  dials: { worker: 'alpha', reviewer: 'beta' },
  unregistered_model_harness: 'codex',
});

test('models verify: aliases sharing one delivery all stay matchable', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), SHARED_DELIVERY);
  const listings = { 'codex-models': { stdout: 'same\n' } };

  const all = runModelsVerify({ repoRoot: root, userPathOptions: user, spawn: backends(listings).spawn });
  assert.equal(all.rows.length, 1, 'one pair, probed once');
  assert.deepEqual(all.rows[0]!.archetypes, ['reviewer', 'worker']);

  // Collecting spellings only when the target was CREATED left whichever dial
  // came first as the sole matchable name, and the other alias — plainly
  // dialed, right there in `fadeno dial` — threw "no dialed model matches".
  for (const ref of ['alpha', 'beta', 'alpha-id', 'beta-id', 'openai/alpha-id', 'openai/beta-id', 'same']) {
    const narrowed = runModelsVerify({ repoRoot: root, userPathOptions: user, refs: [ref], spawn: backends(listings).spawn });
    assert.deepEqual(byPair(narrowed), { 'codex same': 'verified' }, `ref ${ref} must select the shared pair`);
  }

  assert.throws(
    () => runModelsVerify({ repoRoot: root, userPathOptions: user, refs: ['nope'], spawn: backends(listings).spawn }),
    (err: unknown) => {
      assert.ok(err instanceof ModelsVerifyError);
      assert.match(err.message, /dialed models: alpha, beta/, 'both names are reported, not just the first');
      return true;
    },
  );
});

test('models verify: the CLI exits non-zero only on a definitive miss, under both spellings', (t) => {
  const root = tempRepo(t);
  const user = isolated(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'high', spellings: { opencode: 'anthropic/claude-opus' } },
    },
    harnesses: {
      codex: { provider: 'openai', command: ['codex', 'exec', '--model', '{model}', '-'], models_command: ['printf', 'gpt-5.6-sol\\n'] },
      claude: { provider: 'anthropic', command: ['claude', '-p', '--model', '{model}'] },
      opencode: { command: ['opencode', 'run', '-m', '{model}'], models_command: ['printf', 'qwen-max\\n'] },
    },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'sol', reviewer: 'opus on opencode' },
    unregistered_model_harness: 'opencode',
  }));
  const env = { ...process.env, ...user.env, HOME: user.home! };
  const runCli = (args: string[]): { status: number; stdout: string } => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      const failure = err as { status?: number; stdout?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? '' };
    }
  };

  const listed = runCli(['models', 'verify', 'sol', '--json']);
  assert.equal(listed.status, 0);
  assert.equal(JSON.parse(listed.stdout).rows[0].outcome, 'verified');

  // Same handler under the singular spelling, and the miss is what fails.
  const missing = runCli(['model', 'verify', '--harness', 'opencode']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /not_listed/);
});

test('models verify and model remove are registered subcommands with matching flag sets', () => {
  for (const spelling of ['model', 'models']) {
    assert.deepEqual(unknownFlagsFor(spelling, 'remove', ['force', 'json']), []);
    assert.deepEqual(unknownFlagsFor(spelling, 'verify', ['harness', 'strict', 'json']), []);
    assert.deepEqual(unknownFlagsFor(spelling, 'remove', ['strict']), ['--strict']);
  }
});

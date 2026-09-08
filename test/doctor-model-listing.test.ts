import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runModelsHarness } from '../src/commands/models.ts';
import {
  CHECK_LISTING_MISSING,
  CHECK_LISTING_UNAVAILABLE,
  LISTING_TIMEOUT_MS,
  isListable,
  listHarnessModels,
  listingContains,
  listingFindings,
  type SpawnLike,
} from '../src/lib/model-listing.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4, tempRepo } from './helpers.ts';

// No test here may reach a real vendor CLI: every listing goes through an
// injected `SpawnLike`. `spawnFails` is the guard — a code path that spawns
// when it must not fails loudly instead of shelling out to whatever `grok` or
// `opencode` happens to be on the developer's PATH.
const spawnFails: SpawnLike = () => {
  throw new Error('must not spawn');
};

function ok(stdout: string): SpawnLike {
  return () => ({ status: 0, stdout, stderr: '' });
}

/** A dial row in the shape `listingFindings` consumes. */
function dial(archetype: string, harness: string, modelId: string): { archetype: string; harness: string; modelId: string } {
  return { archetype, harness, modelId };
}

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

// A listing whose shape exercises every rule in the parser at once: a bare id,
// an `id<TAB>description` row (agy's shape), a leading-whitespace repeat of an
// id already seen, a prose banner carrying a space, and a blank line.
const MESSY_LISTING = [
  'gpt-5.6-sol',
  'gpt-5.6-luna\tThe luna model',
  '  gpt-5.6-sol',
  'Available models:',
  '',
  'gpt-5.6-nova',
  '',
].join('\n');

const MESSY_IDS = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-nova'];

test('model-listing: parses a listing the way `fadeno models <harness>` does', () => {
  const calls: Array<{ command: string[]; timeout: number }> = [];
  const result = listHarnessModels(
    'codex',
    { models_command: ['codex', 'models'] },
    (command, opts) => {
      calls.push({ command, timeout: opts.timeout });
      return { status: 0, stdout: MESSY_LISTING, stderr: '' };
    },
  );

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.listing.harness, 'codex');
  assert.deepEqual(result.listing.ids, MESSY_IDS, 'first tab field, trimmed, deduped, prose and blanks dropped, order kept');
  assert.deepEqual(calls, [{ command: ['codex', 'models'], timeout: LISTING_TIMEOUT_MS }], 'the declared argv runs once, under the 10s listing timeout');
});

// `src/commands/models.ts` imports the parser AND the membership rule from
// src/lib/model-listing.ts rather than keeping copies (a lib may not import
// from a command, so the shared code has to live in the lib). These two tests
// are the tripwire on that arrangement: if either fails, the doctor and
// `fadeno models` have started disagreeing about what "listed" means, which is
// the exact silent-wrong-answer this check exists to close. Fix the divergence;
// do not relax the assertion.
test('model-listing: agrees with runModelsHarness on what the backend listed', (t: TestContext) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' } },
    harnesses: {
      codex: {
        provider: 'openai',
        command: ['codex', 'exec', '--model', '{model}', '-'],
        models_command: ['codex', 'models'],
      },
    },
  }));

  const viaCommand = runModelsHarness({
    repoRoot: root,
    userPathOptions: isolated(root),
    harness: 'codex',
    spawn: ok(MESSY_LISTING),
  });
  const viaLib = listHarnessModels('codex', { models_command: ['codex', 'models'] }, ok(MESSY_LISTING));

  assert.ok(viaLib.ok);
  assert.deepEqual(viaLib.listing.ids, viaCommand.models.map((m) => m.id));
});

/**
 * The membership half of the parity tripwire, on the case that used to
 * diverge: a `models_prefix` harness that prints a token WITHOUT its prefix.
 *
 * `fadeno models` qualifies the dialed id and compares it to the raw listing,
 * so a bare `qwen/qwen-max` token does not deliver a `qwen/qwen-max` dial. An
 * earlier doctor de-prefixed the listing instead, matched it, and stayed
 * silent about a dial `fadeno dial` would have refused outright. One rule now:
 * `listingContains`.
 */
test('model-listing: membership matches `fadeno models`, prefixed harness included', (t: TestContext) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({
    models: {
      // Qualifies to a token the backend prints: registered, and dialable.
      opus: { provider: 'anthropic', id: 'anthropic/claude-opus', effort: 'xhigh', harness: 'opencode' },
      // Its argv-facing id is printed BARE by a prefixed harness, so it
      // qualifies to `openrouter/qwen/qwen-max`, which is not in the listing.
      qwen: { provider: 'qwen', id: 'qwen/qwen-max', effort: 'high', harness: 'opencode' },
    },
    harnesses: {
      opencode: {
        command: ['opencode', 'run', '-m', '{model}'],
        models_command: ['opencode', 'models'],
        models_prefix: 'openrouter/',
      },
    },
  }));

  // The bare `qwen/qwen-max` line is the whole point of the fixture.
  const stdout = 'openrouter/anthropic/claude-opus\nqwen/qwen-max\n';

  const viaCommand = runModelsHarness({
    repoRoot: root,
    userPathOptions: isolated(root),
    harness: 'opencode',
    spawn: ok(stdout),
  });
  const viaLib = listHarnessModels(
    'opencode',
    { models_command: ['opencode', 'models'], models_prefix: 'openrouter/' },
    ok(stdout),
  );
  assert.ok(viaLib.ok);

  // The listing itself: raw tokens, never de-prefixed.
  assert.deepEqual(viaLib.listing.ids, ['openrouter/anthropic/claude-opus', 'qwen/qwen-max']);
  assert.equal(viaLib.listing.prefix, 'openrouter/');
  assert.deepEqual(viaLib.listing.ids, viaCommand.models.map((m) => m.id));

  // MEMBERSHIP parity: `fadeno models` says a registry name is delivered by a
  // listed token exactly when `listingContains` says so.
  const deliveredByCommand = (alias: string): boolean =>
    viaCommand.models.some((row) => row.registered_as.includes(alias));
  for (const [alias, modelId] of [['opus', 'anthropic/claude-opus'], ['qwen', 'qwen/qwen-max']] as const) {
    assert.equal(
      listingContains(viaLib.listing, modelId),
      deliveredByCommand(alias),
      `${alias} (${modelId}): the doctor and \`fadeno models\` must agree`,
    );
  }
  assert.equal(deliveredByCommand('opus'), true, 'the prefixed token is registered');
  assert.equal(deliveredByCommand('qwen'), false, 'a bare token on a prefixed harness delivers nothing');

  // And the doctor draws the same conclusion from the same listing: silence
  // for the dial the listing covers, one warning for the one it does not.
  const findings = listingFindings({
    dialed: [dial('worker', 'opencode', 'anthropic/claude-opus'), dial('reviewer', 'opencode', 'qwen/qwen-max')],
    listings: [{ harness: 'opencode', result: viaLib }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.check, CHECK_LISTING_MISSING);
  assert.match(findings[0]!.detail, /reviewer is dialed to "qwen\/qwen-max" \(listed as "openrouter\/qwen\/qwen-max"\)/);
});

test('model-listing: both prefix spellings read alike, and a prefixed dial matches its listed form', () => {
  const stdout = 'openrouter/anthropic/claude-opus\nopenrouter/qwen/qwen-max\n';

  // YAML spelling (what the contract froze) …
  const yamlSpelling = listHarnessModels('opencode', { models_command: ['opencode', 'models'], models_prefix: 'openrouter/' }, ok(stdout));
  assert.ok(yamlSpelling.ok);
  assert.deepEqual(yamlSpelling.listing.ids, ['openrouter/anthropic/claude-opus', 'openrouter/qwen/qwen-max']);

  // … and the parsed HarnessRaw spelling, so a profile entry passes straight through.
  const parsedSpelling = listHarnessModels('opencode', { models_command: ['opencode', 'models'], modelsPrefix: 'openrouter/' }, ok(stdout));
  assert.ok(parsedSpelling.ok);
  assert.deepEqual(parsedSpelling.listing, yamlSpelling.listing);

  // A dial holds the unprefixed id (`-m` must not receive the prefix twice),
  // so the prefixed listing must not read as rot — the id is qualified, not
  // the listing stripped.
  assert.equal(listingContains(yamlSpelling.listing, 'anthropic/claude-opus'), true);
  assert.equal(listingContains(yamlSpelling.listing, 'openrouter/anthropic/claude-opus'), true, 'an already-qualified dial matches too');
  assert.equal(listingContains(yamlSpelling.listing, 'anthropic/claude-sonnet'), false);
  assert.deepEqual(
    listingFindings({
      dialed: [dial('worker', 'opencode', 'anthropic/claude-opus')],
      listings: [{ harness: 'opencode', result: yamlSpelling }],
    }),
    [],
  );
});

test('model-listing: an empty listing succeeds with no ids — it is not a failure', () => {
  const result = listHarnessModels('grok', { models_command: ['grok', 'models'] }, ok(''));
  assert.ok(result.ok);
  assert.deepEqual(result.listing.ids, []);

  // …but every dialed model on it is then unlisted.
  const findings = listingFindings({
    dialed: [dial('worker', 'grok', 'grok-5')],
    listings: [{ harness: 'grok', result }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.check, CHECK_LISTING_MISSING);
});

test('model-listing: a non-zero exit is reported, not thrown', () => {
  const result = listHarnessModels('grok', { models_command: ['grok', 'models'] }, () => ({ status: 2, stdout: '', stderr: 'boom' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.reason, /models_command for grok exited 2\./);
});

test('model-listing: a missing binary is reported, not thrown', () => {
  const missing = Object.assign(new Error('spawnSync grok ENOENT'), { code: 'ENOENT' });
  const result = listHarnessModels('grok', { models_command: ['grok', 'models'] }, () => ({ status: null, stdout: '', stderr: '', error: missing }));
  assert.ok(!result.ok);
  assert.match(result.reason, /models_command failed for grok: spawnSync grok ENOENT/);
});

test('model-listing: a timeout is reported, not thrown', () => {
  // spawnSync surfaces a timeout the same way as a missing binary: `error`
  // set, `status` null.
  const timedOut = Object.assign(new Error('spawnSync grok ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const result = listHarnessModels('grok', { models_command: ['grok', 'models'] }, () => ({ status: null, stdout: '', stderr: '', error: timedOut }));
  assert.ok(!result.ok);
  assert.match(result.reason, /ETIMEDOUT/);
});

test('model-listing: a spawn that throws is reported, not propagated', () => {
  const result = listHarnessModels('grok', { models_command: ['grok', 'models'] }, spawnFails);
  assert.ok(!result.ok);
  assert.match(result.reason, /models_command failed for grok: must not spawn/);
});

test('model-listing: a harness with no models_command is unlistable and never spawns', () => {
  assert.equal(isListable({ models_command: ['claude', 'models'] }), true);
  assert.equal(isListable({}), false);
  assert.equal(isListable({ models_command: [] }), false);
  assert.equal(isListable({ models_command: null }), false);
  assert.equal(isListable(null), false);

  const result = listHarnessModels('claude', {}, spawnFails);
  assert.ok(!result.ok);
  assert.match(result.reason, /harness "claude" declares no models_command/);
});

test('model-listing: a dialed model still in the listing produces no finding', () => {
  const listing = listHarnessModels('codex', { models_command: ['codex', 'models'] }, ok(MESSY_LISTING));
  assert.deepEqual(
    listingFindings({
      dialed: [dial('worker', 'codex', 'gpt-5.6-sol'), dial('reviewer', 'codex', 'gpt-5.6-nova')],
      listings: [{ harness: 'codex', result: listing }],
    }),
    [],
  );
});

test('model-listing: a dialed model the backend no longer lists is one warning naming the fix', () => {
  const listing = listHarnessModels('codex', { models_command: ['codex', 'models'] }, ok(MESSY_LISTING));
  const findings = listingFindings({
    dialed: [dial('worker', 'codex', 'gpt-5.6-sol'), dial('director', 'codex', 'gpt-5.5-retired')],
    listings: [{ harness: 'codex', result: listing }],
  });

  assert.equal(findings.length, 1, 'only the missing dial is reported');
  const [only] = findings;
  assert.equal(only!.check, CHECK_LISTING_MISSING);
  assert.equal(only!.severity, 'warning');
  assert.match(only!.detail, /director is dialed to "gpt-5\.5-retired" on codex/);
  assert.match(only!.remediation!, /fadeno models codex/);
  assert.match(only!.remediation!, /fadeno dial director <ref>/);
});

test('model-listing: a harness that is not in the listings is skipped, not a finding', () => {
  // How a harness with no `models_command` reaches this function: the caller
  // filters with `isListable`, so `claude` simply has no listing to check
  // against. Silence is the contract — an unlistable backend says nothing
  // about the dial.
  const listing = listHarnessModels('codex', { models_command: ['codex', 'models'] }, ok(MESSY_LISTING));
  assert.deepEqual(
    listingFindings({
      dialed: [dial('worker', 'claude', 'opus'), dial('reviewer', 'codex', 'gpt-5.6-sol')],
      listings: [{ harness: 'codex', result: listing }],
    }),
    [],
  );
});

test('model-listing: the host identity is never checked against a backend listing', () => {
  const listing = listHarnessModels('codex', { models_command: ['codex', 'models'] }, ok(MESSY_LISTING));
  assert.deepEqual(
    listingFindings({
      dialed: [dial('worker', 'codex', 'host')],
      listings: [{ harness: 'codex', result: listing }],
    }),
    [],
    'host names the session itself; no backend lists it',
  );
});

test('model-listing: an unreadable listing is ONE warning for the harness, never an error', () => {
  const failed = listHarnessModels('grok', { models_command: ['grok', 'models'] }, () => ({ status: 127, stdout: '', stderr: '' }));
  const findings = listingFindings({
    dialed: [dial('worker', 'grok', 'grok-5'), dial('reviewer', 'grok', 'grok-5-mini')],
    listings: [{ harness: 'grok', result: failed }, { harness: 'grok', result: failed }],
  });

  assert.equal(findings.length, 1, 'one per harness, not one per dial and not one per duplicate listing');
  const [only] = findings;
  assert.equal(only!.check, CHECK_LISTING_UNAVAILABLE);
  assert.equal(only!.severity, 'warning');
  assert.match(only!.detail, /grok: could not read the model listing/);
  assert.match(only!.detail, /exited 127/);
  assert.match(only!.detail, /worker → grok-5/);
  assert.match(only!.detail, /reviewer → grok-5-mini/);
  assert.match(only!.remediation!, /fadeno models grok/);
  assert.ok(findings.every((f) => f.severity !== 'error'), 'a missing or slow vendor CLI is never an error');
});

test('model-listing: a failed listing for a harness nobody dials is silent', () => {
  const failed = listHarnessModels('agy', { models_command: ['agy', 'models'] }, () => ({ status: 1, stdout: '', stderr: '' }));
  const listing = listHarnessModels('codex', { models_command: ['codex', 'models'] }, ok(MESSY_LISTING));
  assert.deepEqual(
    listingFindings({
      dialed: [dial('worker', 'codex', 'gpt-5.6-sol')],
      listings: [{ harness: 'agy', result: failed }, { harness: 'codex', result: listing }],
    }),
    [],
  );
});

test('model-listing: a repeated dial row is reported once', () => {
  const listing = listHarnessModels('codex', { models_command: ['codex', 'models'] }, ok(MESSY_LISTING));
  const findings = listingFindings({
    dialed: [dial('worker', 'codex', 'gone'), dial('worker', 'codex', 'gone')],
    listings: [{ harness: 'codex', result: listing }],
  });
  assert.equal(findings.length, 1);
});

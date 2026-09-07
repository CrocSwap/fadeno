import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import {
  CATALOG_TOP_LEVEL_KEYS,
  ExecutorProfileError,
  suggestCatalogKey,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4Doc, tempRepo } from './helpers.ts';

/**
 * A misspelled top-level catalog key must fail loudly, not vanish.
 *
 * `mergeLayer` composes layers by copying top-level keys by exact literal
 * name, so a key nobody names is never looked up, never copied, and never
 * reaches `parseExecutorProfile`'s strict unknown-key check: it disappears
 * mid-merge and the feature it was meant to switch on silently does nothing.
 * `worktree_carrry:` is the sharpest case — the resulting shadow challenger
 * has no `node_modules`, cannot build or test, and nothing said so.
 *
 * Every test here pins an isolated user scope (`isolatedUser`) on top of
 * `tempRepo`'s home redirect, so nothing reads the developer's real
 * `~/.config/fadeno/executors.yaml`.
 */

const V4_BASE = catalogV4Doc({
  models: { sol: { provider: 'dummy', id: 'sol', effort: 'high' } },
  harnesses: { dummy: { provider: 'dummy', command: ['node', '-e', '0'] } },
  archetypes: { worker: { } },
});

function isolatedUser(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

/** A repo with a project catalog, plus an optional user-scope one. */
function seed(
  t: TestContext,
  project: Record<string, unknown> | null,
  user?: Record<string, unknown>,
): { root: string; paths: UserPathOptions; projectFile: string; userFile: string } {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  if (project != null) {
    mkdirSync(join(root, '.fadeno'), { recursive: true });
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(project));
  }
  const userFile = userPaths(paths).executorsFile;
  if (user != null) {
    mkdirSync(join(userFile, '..'), { recursive: true });
    writeFileSync(userFile, stringifyYaml(user));
  }
  return { root, paths, projectFile: join(root, '.fadeno', 'executors.yaml'), userFile };
}

function thrown(fn: () => unknown): ExecutorProfileError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ExecutorProfileError, `expected an ExecutorProfileError, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected a throw, got none' });
}

test('a misspelled top-level key fails loudly instead of vanishing in the merge', (t) => {
  // The regression: this catalog used to load clean, with `worktree_carry`
  // simply never in effect. Nothing downstream could tell the difference
  // between "carry nothing" and "the declaration was thrown away".
  const { root, paths, projectFile } = seed(t, { ...V4_BASE, unregistered_model_harnes: 'opencode' });
  const err = thrown(() => loadLayeredProfile(root, paths));
  assert.match(err.message, /unknown top-level key/);
  // Names the file to edit and the exact key that is wrong...
  assert.ok(err.message.startsWith(`${projectFile}: `), `message must lead with the offending file; got ${err.message}`);
  assert.match(err.message, /`unregistered_model_harnes`/);
  // ...and, since a typo is the whole failure mode, the key that was meant.
  assert.match(err.message, /did you mean `unregistered_model_harness`\?/);
});

test('the layer that carries the typo is the file named, even under layering', (t) => {
  // "unknown key" without a path is close to useless when catalogs compose
  // across user and project scope: the merged document the parser sees is
  // attributed to "builtin + user + project", which names no file at all.
  const { root, paths, projectFile, userFile } = seed(t, { dials: { worker: 'sol' } }, { ...V4_BASE, dails: { worker: 'sol' } });
  const err = thrown(() => loadLayeredProfile(root, paths));
  assert.ok(err.message.startsWith(`${userFile}: `), `must name the user catalog; got ${err.message}`);
  assert.ok(!err.message.includes(projectFile), 'must not point at the innocent project catalog');
  assert.match(err.message, /`dails` \(did you mean `dials`\?\)/);
});

test('an unknown key with no near match gets the key list, not a wild guess', (t) => {
  const { root, paths } = seed(t, { ...V4_BASE, pipeline_settings: { retries: 2 } });
  const err = thrown(() => loadLayeredProfile(root, paths));
  assert.match(err.message, /unknown top-level key `pipeline_settings`/);
  assert.doesNotMatch(err.message, /did you mean/);
  // The known set is printed either way, so silence still leaves a usable error.
  for (const key of CATALOG_TOP_LEVEL_KEYS) assert.ok(err.message.includes(key), `known-key list should include ${key}`);
});

test('several unknown keys are all reported, each with its own suggestion', (t) => {
  const { root, paths } = seed(t, { ...V4_BASE, modles: {}, zzzz: 1 });
  const err = thrown(() => loadLayeredProfile(root, paths));
  assert.match(err.message, /unknown top-level keys/);
  assert.match(err.message, /`modles` \(did you mean `models`\?\)/);
  assert.match(err.message, /`zzzz`/);
  assert.doesNotMatch(err.message, /`zzzz` \(did you mean/);
});

test('suggestCatalogKey answers typos and stays quiet on everything else', () => {
  assert.equal(suggestCatalogKey('unregistered_model_harnes'), 'unregistered_model_harness');
  assert.equal(suggestCatalogKey('dails'), 'dials'); // transposition
  assert.equal(suggestCatalogKey('modles'), 'models');
  assert.equal(suggestCatalogKey('dial'), 'dials'); // singular/plural
  assert.equal(suggestCatalogKey('archetype'), 'archetypes');
  assert.equal(suggestCatalogKey('Unclosed_Limit'), 'unclosed_limit'); // case-only
  // Not close enough to be worth asserting: a confident wrong suggestion is
  // worse than none, and short keys must not be able to "mean" a long one.
  assert.equal(suggestCatalogKey('pipeline'), null);
  assert.equal(suggestCatalogKey('x'), null);
  assert.equal(suggestCatalogKey('to'), null);
  assert.equal(suggestCatalogKey(''), null);
});

test('a known key in the wrong layer keeps its own message, not "unknown key"', (t) => {
  // `dials` and `worktree_carry` are project-only and already say exactly why.
  // An unknown-key check that swallowed or reworded those would trade a
  // precise diagnosis for a vague one. (No project catalog in these repos: a
  // self-contained one suppresses the user layer entirely, so the user
  // catalog would never be merged and never be checked.)
  const withDials = seed(t, null, { ...V4_BASE, dials: { worker: 'sol' } });
  const dialsErr = thrown(() => loadLayeredProfile(withDials.root, withDials.paths));
  assert.equal(
    dialsErr.message,
    'repo pins live in the project catalog; user dials are state — use `fadeno dial <archetype> <model> --user`',
  );

  // Even alongside a typo: the misplacement is the more specific finding.
  const both = seed(t, null, { ...V4_BASE, dials: { worker: 'sol' }, modles: {} });
  assert.doesNotMatch(thrown(() => loadLayeredProfile(both.root, both.paths)).message, /unknown top-level key/);
});

test('a pre-dials catalog still gets migration instructions, now naming the file', (t) => {
  // `targets:`/`loadouts:` are obsolete, not misspelled — a did-you-mean here
  // would be actively misleading.
  const { root, paths, projectFile } = seed(t, {
    targets: { opus: { provider: 'anthropic', model: 'opus' } },
    loadouts: { main: { worker: 'opus' } },
  });
  const err = thrown(() => loadLayeredProfile(root, paths));
  assert.match(err.message, /schema_version 4 required/);
  assert.match(err.message, /targets:→models:/);
  assert.doesNotMatch(err.message, /unknown top-level key/);
  assert.ok(err.message.startsWith(`${projectFile}: `), `should name the legacy file; got ${err.message}`);
});

/**
 * The anti-regression for the whole bug class: every key the catalog
 * vocabulary advertises must actually survive layering. A key present in
 * `CATALOG_TOP_LEVEL_KEYS` but absent from the merge is exactly the shape of
 * the original `worktree_carry` defect — accepted by the validator, dropped
 * before the parser, inert with no complaint (that key is itself gone now, and
 * this table is what its lesson left behind). Adding a key without teaching
 * this table about it fails the coverage assertion below rather than shipping
 * an unverified one.
 */
const SURVIVES_THE_MERGE: Record<string, { declare: Record<string, unknown>; check: (p: ExecutorProfile) => void }> = {
  schema_version: { declare: { schema_version: 4 }, check: (p) => assert.equal(p.schemaVersion, 4) },
  models: { declare: {}, check: (p) => assert.equal(p.models.sol?.id, 'sol') },
  harnesses: {
    // `relay:` moved INSIDE this key (`harnesses.<id>.host.relay`), so its
    // survival is covered here rather than by a top-level case of its own.
    declare: {
      harnesses: {
        // `dummy` carried over from the base: this case REPLACES the key in
        // the assembled document, and `sol` still needs a home harness.
        dummy: { provider: 'dummy', command: ['node', '-e', '0'] },
        claude: { provider: 'anthropic', host: { effort_channel: 'none', relay: 'sonnet' } },
        codex: { provider: 'openai', host: { effort_channel: 'agent-file', relay: 'luna@low' }, command: ['codex'] },
      },
    },
    check: (p) => {
      assert.ok(p.harnesses.dummy?.command, 'the base harness must survive layering');
      assert.ok(p.harnesses.codex?.command, 'a project harness entry must not drop its command lane');
      assert.equal(p.harnesses.claude?.host?.relay?.model, 'sonnet');
      // The effort pin has to survive as a pin: the Codex broker bakes it,
      // and losing it would silently promote the relay to luna's xhigh
      // registry default on every dispatch.
      assert.equal(p.harnesses.codex?.host?.relay?.model, 'luna');
      assert.equal(p.harnesses.codex?.host?.relay?.effort, 'low');
    },
  },
  bindings: { declare: { bindings: { reviewer: 'sol' } }, check: (p) => assert.equal(p.bindings.reviewer?.model, 'sol') },
  dials: { declare: { dials: { worker: 'sol' } }, check: (p) => assert.equal(p.dials.worker?.model, 'sol') },
  archetypes: { declare: { archetypes: { auditor: { description: 'Audits.' } } }, check: (p) => assert.equal(p.archetypes.auditor?.description, 'Audits.') },
  unregistered_model_harness: {
    declare: { unregistered_model_harness: 'crush' },
    check: (p) => assert.equal(p.unregisteredModelHarness, 'crush'),
  },
  unclosed_limit: {
    declare: { unclosed_limit: 8 },
    check: (p) => assert.equal(p.unclosedLimit, 8),
  },
};

test('every advertised top-level key survives the merge and reaches the parsed profile', (t) => {
  assert.deepEqual(
    Object.keys(SURVIVES_THE_MERGE).sort(),
    [...CATALOG_TOP_LEVEL_KEYS].sort(),
    'each catalog key needs a case here proving layering does not drop it',
  );
  const doc: Record<string, unknown> = { ...V4_BASE };
  for (const entry of Object.values(SURVIVES_THE_MERGE)) Object.assign(doc, entry.declare);
  const { root, paths } = seed(t, doc);
  const { profile } = loadLayeredProfile(root, paths);
  for (const [key, entry] of Object.entries(SURVIVES_THE_MERGE)) {
    t.diagnostic(`key survives layering: ${key}`);
    entry.check(profile);
  }
});

test('valid catalogs are untouched: builtin, user, and project still compose', (t) => {
  // Purely additive rejection — a catalog that was fine before is fine now,
  // including the shipped builtin one, which layers in when a project catalog
  // is not self-contained.
  const { root, paths } = seed(t, { schema_version: 4, dials: { worker: 'sol' } }, V4_BASE);
  const layered = loadLayeredProfile(root, paths);
  assert.deepEqual(layered.layers, ['builtin', 'user', 'project']);
  assert.equal(layered.selfContained, false);
  assert.equal(layered.profile.dials.worker?.model, 'sol');
  assert.equal(layered.profile.models.sol?.id, 'sol');
  // The builtin layer contributes its own archetypes, so the shipped catalog
  // itself passes the new per-layer key check.
  assert.ok(Object.keys(layered.profile.archetypes).length > 0);
});

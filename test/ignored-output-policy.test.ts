import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import {
  CATALOG_TOP_LEVEL_KEYS,
  ExecutorProfileError,
  parseExecutorProfile,
  parseSnapshotDocument,
  serializeSnapshot,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * `archetypes.<name>.ignored_output` — whether an archetype's *gitignored*
 * output has to survive the dispatch.
 *
 * The failure it exists to prevent: a shadow pair runs each arm in its own
 * worktree and merges the primary's work back through a `git add -A` diff,
 * which respects `.gitignore` and therefore drops every ignored path. An
 * archetype whose real product is ignored (a build, a dataset, a local
 * cache) silently loses it the moment someone pairs it. `kept` says so, so
 * pair formation can decline — losing a comparison, never the work.
 *
 * Deliberately not a `requires_write` variant, and the tests below pin both
 * halves of that split: `requires_write` is a `WritePosture` consumed during
 * *resolution* to pick a write-capable delivery or refuse the slot, and says
 * nothing about where writes land; this is consumed much later, at pair
 * materialization. One key would make the illegal combinations expressible
 * and be read at two stages for two purposes.
 *
 * Also not `worktree_carry`, which is the opposite direction: ignored files
 * copied *into* a worktree before an arm runs.
 */

const BASE = {
  schema_version: 3,
  models: { sol: { provider: 'openai' } },
  routes: { standalone: { openai: { command: ['codex'] } } },
};

function parseDoc(over: Record<string, unknown>): ExecutorProfile {
  return parseExecutorProfile(stringifyYaml({ ...BASE, ...over }), 'test.yaml');
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

// --- parse: the value itself ---

test('ignored_output: absent is discardable, so no existing archetype changes meaning', () => {
  const profile = parseDoc({
    archetypes: { worker: { requires_write: 'required' }, reviewer: {}, scribe: { brief: 'director' } },
  });
  for (const name of ['worker', 'reviewer', 'scribe']) {
    assert.equal(profile.archetypes[name]!.ignoredOutput, 'discardable', name);
  }
  // Pinned as a whole-shape assertion: the default has to be a real value on
  // the policy, not an absent key a consumer has to remember to coalesce.
  assert.deepEqual(profile.archetypes.reviewer, {
    requiresWrite: 'none',
    ignoredOutput: 'discardable',
    fallback: null,
    distinctProviderFromInputs: null,
    brief: null,
  });
});

test('ignored_output: both values parse, independently of requires_write', () => {
  const profile = parseDoc({
    archetypes: {
      worker: { requires_write: 'required', ignored_output: 'kept' },
      builder: { ignored_output: 'kept' },
      scribe: { requires_write: 'required', ignored_output: 'discardable' },
    },
  });
  assert.equal(profile.archetypes.worker!.ignoredOutput, 'kept');
  assert.equal(profile.archetypes.builder!.ignoredOutput, 'kept');
  assert.equal(profile.archetypes.scribe!.ignoredOutput, 'discardable');
  // The two fields are read at different stages and neither derives from the
  // other: `kept` does not imply a write posture, and `required` does not
  // imply the output survives.
  assert.equal(profile.archetypes.worker!.requiresWrite, 'required');
  assert.equal(profile.archetypes.builder!.requiresWrite, 'none');
  assert.equal(profile.archetypes.scribe!.requiresWrite, 'required');
});

test('ignored_output: a misspelled value fails loudly and names both legal values', () => {
  // The whole point of the declaration is that it is load-bearing at pair
  // formation. A value that quietly fell back to the default would put the
  // dispatch right back in the silent-data-loss case it was written to avoid.
  for (const bad of ['keep', 'kepts', 'Kept', 'keeps', 'discard', 'discardible', 'none', '', 1, null]) {
    const err = thrown(() => parseDoc({ archetypes: { worker: { ignored_output: bad } } }));
    assert.match(err.message, /`archetypes\.worker\.ignored_output` must be "kept" or "discardable"\./, String(bad));
    assert.ok(err.message.startsWith('test.yaml: '), `must name the offending source; got ${err.message}`);
  }
});

test('ignored_output: booleans are refused even though requires_write accepts them', () => {
  // `requires_write: true` is legal shorthand for `required`. There is no
  // corresponding reading here — "true" names neither value — so the
  // shorthand must not be inherited by copy-paste from the line above it.
  for (const bad of [true, false]) {
    assert.match(
      thrown(() => parseDoc({ archetypes: { worker: { ignored_output: bad } } })).message,
      /`archetypes\.worker\.ignored_output` must be "kept" or "discardable"\./,
      String(bad),
    );
  }
  // ...while the neighbouring shorthand is untouched.
  assert.equal(parseDoc({ archetypes: { worker: { requires_write: true } } }).archetypes.worker!.requiresWrite, 'required');
});

test('ignored_output: a typo in the KEY is an unknown key that names the legal set', () => {
  // The nested analogue of the top-level `worktree_carrry` bug: a misspelled
  // key must not be accepted-and-ignored, and the message has to name the key
  // that was meant.
  const err = thrown(() => parseDoc({ archetypes: { worker: { ignored_ouput: 'kept' } } }));
  assert.match(err.message, /`archetypes\.worker` has unknown key\(s\) ignored_ouput;/);
  assert.match(err.message, /only `requires_write`, `ignored_output`, `fallback`, `distinct_provider_from_inputs`, and `brief` are allowed\./);
});

// --- both parse sites ---

/**
 * `executors.ts` parses `archetypes.<name>` in two places: the catalog parser
 * (`parseExecutorProfile`) and the snapshot reader (`parseSnapshotDocument`,
 * the round-trip path). They differ only in message verbosity — the snapshot
 * reader reads a document this code generated, so it does not spell out the
 * legal key list — and must never differ in what they ACCEPT. A key known to
 * one and unknown to the other means a snapshot that cannot be re-read, or a
 * declaration that survives a write and vanishes on the next load.
 */
test('ignored_output: the snapshot reader accepts and validates exactly like the catalog parser', () => {
  // Hand-authored `archetypes:` on top of a genuine serialized executors
  // block, so the reader is fed the document shape it will really see.
  const snapshotWith = (archetypes: Record<string, unknown>): string => {
    const base = serializeSnapshot(parseDoc({}));
    return `${base}archetypes:\n${stringifyYaml({ archetypes }).slice('archetypes:\n'.length)}`;
  };

  const doc = parseSnapshotDocument(
    snapshotWith({ worker: { requires_write: 'required', ignored_output: 'kept' }, scribe: { ignored_output: 'discardable' } }),
    'snap.yaml',
  );
  assert.equal(doc.archetypes.worker!.ignoredOutput, 'kept');
  assert.equal(doc.archetypes.scribe!.ignoredOutput, 'discardable');

  assert.match(
    thrown(() => parseSnapshotDocument(snapshotWith({ worker: { ignored_output: 'keep' } }), 'snap.yaml')).message,
    /`archetypes\.worker\.ignored_output` must be "kept" or "discardable"\./,
  );

  assert.match(
    thrown(() => parseSnapshotDocument(snapshotWith({ worker: { ignored_ouput: 'kept' } }), 'snap.yaml')).message,
    /`archetypes\.worker` has unknown key\(s\) ignored_ouput\./,
  );
});

// --- serialize / round-trip ---

test('ignored_output: kept survives a snapshot round-trip', () => {
  const profile = parseDoc({
    archetypes: {
      worker: { requires_write: 'required', ignored_output: 'kept' },
      builder: { ignored_output: 'kept', fallback: 'worker' },
      scribe: { requires_write: 'required' },
    },
  });
  const text = serializeSnapshot(profile);
  assert.match(text, /ignored_output: kept/);
  // Two `kept` archetypes, two emissions — and nothing emitted for the
  // defaulted one.
  assert.equal(text.split('ignored_output: kept').length - 1, 2);
  assert.doesNotMatch(text, /ignored_output: discardable/);

  const roundTrip = parseSnapshotDocument(text, 'round-trip.yaml');
  assert.deepEqual(roundTrip.archetypes, profile.archetypes);
  assert.equal(roundTrip.archetypes.worker!.ignoredOutput, 'kept');
  assert.equal(roundTrip.archetypes.scribe!.ignoredOutput, 'discardable');
});

test('ignored_output: discardable is added, never defaulted — no stored snapshot moves a byte', () => {
  // `requires_write: none` is omitted the same way. A snapshot of a catalog
  // that declares nothing new has to be byte-for-byte what it was before this
  // key existed, or every ledger on disk stops verifying.
  const text = serializeSnapshot(parseDoc({
    archetypes: { worker: { requires_write: 'required' }, reviewer: {} },
  }));
  assert.doesNotMatch(text, /ignored_output/);
  assert.ok(
    text.includes('archetypes:\n  reviewer: {}\n  worker:\n    requires_write: required\n'),
    `archetypes block must be unchanged; got:\n${text.slice(text.indexOf('archetypes:'))}`,
  );
});

// --- layering ---

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

/** A repo with a (deliberately non-self-contained) project catalog + a user one. */
function seed(
  t: TestContext,
  project: Record<string, unknown>,
  user: Record<string, unknown>,
): { root: string; paths: UserPathOptions } {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(project));
  const userFile = userPaths(paths).executorsFile;
  mkdirSync(join(userFile, '..'), { recursive: true });
  writeFileSync(userFile, stringifyYaml(user));
  return { root, paths };
}

test('ignored_output: an archetype policy declared in one layer is not dropped by the merge', (t) => {
  // The `worktree_carry` defect in miniature: a declaration accepted by the
  // parser but discarded before it, leaving the feature inert with nothing
  // said. `archetypes` is entry-merged, so a policy contributed by any layer
  // has to arrive intact.
  const { root, paths } = seed(
    t,
    { schema_version: 3, archetypes: { auditor: { ignored_output: 'kept' } } },
    { schema_version: 3, archetypes: { scribe: { ignored_output: 'kept' }, courier: {} } },
  );
  const { layers, profile } = loadLayeredProfile(root, paths);
  assert.deepEqual(layers, ['builtin', 'user', 'project'], 'this fixture must actually layer');

  assert.equal(profile.archetypes.auditor!.ignoredOutput, 'kept', 'project layer');
  assert.equal(profile.archetypes.scribe!.ignoredOutput, 'kept', 'user layer');
  assert.equal(profile.archetypes.courier!.ignoredOutput, 'discardable', 'user layer, defaulted');
  // The builtin layer's archetypes still compose in beside them, defaulted.
  assert.equal(profile.archetypes.worker!.requiresWrite, 'required');
  assert.equal(profile.archetypes.worker!.ignoredOutput, 'discardable', 'builtin layer, defaulted');
});

test('ignored_output: the innermost layer that declares an archetype wins outright', (t) => {
  // Per-archetype policies replace wholesale rather than field-merging, so
  // the project layer can both raise and lower the flag the user set.
  const { root, paths } = seed(
    t,
    { schema_version: 3, archetypes: { scribe: { ignored_output: 'discardable' }, courier: { ignored_output: 'kept' } } },
    { schema_version: 3, archetypes: { scribe: { ignored_output: 'kept' }, courier: { ignored_output: 'discardable' } } },
  );
  const { profile } = loadLayeredProfile(root, paths);
  assert.equal(profile.archetypes.scribe!.ignoredOutput, 'discardable');
  assert.equal(profile.archetypes.courier!.ignoredOutput, 'kept');
});

test('ignored_output is nested under archetypes, so the top-level key table does not cover it', () => {
  // `test/catalog-key-strictness.test.ts` asserts every entry of
  // CATALOG_TOP_LEVEL_KEYS has a row in its SURVIVES_THE_MERGE table. This
  // key is not top-level — it rides inside `archetypes`, whose row already
  // exists — and the layering tests above are its equivalent coverage. If it
  // is ever promoted to a top-level key, this fails and points at the table
  // that then needs a row.
  assert.ok(
    !(CATALOG_TOP_LEVEL_KEYS as readonly string[]).includes('ignored_output'),
    'ignored_output became top-level: add a SURVIVES_THE_MERGE row in test/catalog-key-strictness.test.ts',
  );
});

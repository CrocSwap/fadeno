import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import {
  ExecutorProfileError,
  RELAY_HARNESSES,
  resolveRelay,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * `relay:` names the model that forwards a delivery without doing role work.
 *
 * It used to live in source literals — `gpt-5.6-luna`/`low` in the Codex
 * broker renderer, `sonnet` in Claude's spawn hook and proxy frontmatter — so
 * the one role in a system built on dialable identities was the one identity
 * unreachable from the catalog.
 *
 * Two properties carry the weight here and each has a test below:
 *
 *  1. **Absent means absent.** A harness with no catalog entry resolves to
 *     `null`, and callers keep their own built-in default. Handing a session
 *     a relay its provider cannot serve is worse than a stale-but-servable
 *     one, and a self-contained project catalog suppresses the builtin layer
 *     entirely, so `null` is the common path rather than an edge case.
 *  2. **A misspelled harness key is an error, never silence.** `cladue:`
 *     resolving to "no opinion for claude" would silently keep the default —
 *     the exact silent-drop failure the layered key check exists to prevent.
 *
 * Every test pins an isolated user scope so nothing reads the developer's
 * real `~/.config/fadeno/executors.yaml`.
 */

const V3_BASE = {
  schema_version: 3,
  models: {
    sol: { provider: 'dummy', id: 'sol', effort: 'high' },
    luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' },
    sonnet: { provider: 'dummy', id: 'sonnet', effort: 'xhigh' },
  },
  routes: {
    standalone: {
      dummy: { command: ['node', '-e', '0'], write_access: true },
      'current-host': { host: true },
    },
    claude: {
      dummy: { command: ['node', '-e', '0'], write_access: true },
      'current-host': { host: true },
    },
    codex: {
      dummy: { command: ['node', '-e', '0'], write_access: true },
      'current-host': { host: true },
    },
  },
  archetypes: { worker: { requires_write: 'none' } },
};

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

function seed(
  t: TestContext,
  project: Record<string, unknown> | null,
  user?: Record<string, unknown>,
): { root: string; paths: UserPathOptions; projectFile: string } {
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
  return { root, paths, projectFile: join(root, '.fadeno', 'executors.yaml') };
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

function load(t: TestContext, project: Record<string, unknown>): ExecutorProfile {
  const { root, paths } = seed(t, project);
  return loadLayeredProfile(root, paths).profile;
}

test('an unpinned relay resolves at the model registry default; a pinned one keeps its pin', (t) => {
  const profile = load(t, { ...V3_BASE, relay: { claude: 'sonnet', codex: 'luna@low' } });

  // Claude's proxies inherit session effort — the Agent tool has no effort
  // channel — so the unpinned form is the correct spelling there, and it
  // still yields a usable effort for any caller that wants one.
  assert.deepEqual(resolveRelay(profile, 'claude'), {
    refString: 'sonnet',
    modelId: 'sonnet',
    effort: 'xhigh',
  });

  // Codex bakes both values into the broker TOML. Losing the pin would
  // silently promote every relay turn to luna's xhigh registry default.
  assert.deepEqual(resolveRelay(profile, 'codex'), {
    refString: 'luna@low',
    modelId: 'gpt-5.6-luna',
    effort: 'low',
  });
});

test('a harness the catalog says nothing about resolves to null, not a guess', (t) => {
  const profile = load(t, { ...V3_BASE, relay: { claude: 'sonnet' } });
  assert.equal(resolveRelay(profile, 'grok'), null);
  assert.equal(resolveRelay(profile, 'codex'), null);
  // And a catalog with no `relay:` at all is the same answer for everyone:
  // callers keep their built-in defaults rather than being handed a model the
  // session's provider may not serve.
  const bare = load(t, V3_BASE);
  for (const harness of RELAY_HARNESSES) assert.equal(resolveRelay(bare, harness), null);
});

test('the relay is compiled for the harness asked about, not the ambient one', (t) => {
  // Claude's plugin assets are routinely generated from a Codex session and
  // vice versa. If `resolveRelay` read `profile.harness` instead of its own
  // argument it would answer from the wrong route table — silently, since
  // both tables usually carry a route of the same name.
  const { root, paths } = seed(t, { ...V3_BASE, relay: { claude: 'sonnet', codex: 'luna@low' } });
  const codexProfile = loadLayeredProfile(root, paths, 'codex').profile;
  assert.equal(codexProfile.harness, 'codex');
  assert.equal(resolveRelay(codexProfile, 'claude')?.modelId, 'sonnet');
  assert.equal(resolveRelay(codexProfile, 'codex')?.modelId, 'gpt-5.6-luna');
});

test('a misspelled harness key is rejected, not read as "no opinion"', (t) => {
  const { root, paths, projectFile } = seed(t, { ...V3_BASE, relay: { cladue: 'sonnet' } });
  const err = thrown(() => loadLayeredProfile(root, paths));
  // Nested keys name the LAYER, not the file — the convention every other
  // nested catalog error follows. Only top-level keys name the file, because
  // only there is the offending text still in hand before the merge.
  assert.match(err.message, /`relay\.cladue`/);
  assert.ok(projectFile.length > 0);
  // The remedy is the list of harnesses that actually have a relay.
  for (const harness of RELAY_HARNESSES) assert.match(err.message, new RegExp(harness));
});

test('standalone is not a relay harness: it has no host session to forward from', (t) => {
  const { root, paths } = seed(t, { ...V3_BASE, relay: { standalone: 'sonnet' } });
  const err = thrown(() => loadLayeredProfile(root, paths));
  assert.match(err.message, /`relay\.standalone`/);
  assert.ok(!(RELAY_HARNESSES as readonly string[]).includes('standalone'));
});

test('a relay that is not a mapping, or holds a malformed ref, fails loudly', (t) => {
  // `relay: sonnet` is the tempting shorthand — it must not quietly become a
  // claude-only opinion, or worse, be dropped.
  const flat = seed(t, { ...V3_BASE, relay: 'sonnet' });
  assert.match(thrown(() => loadLayeredProfile(flat.root, flat.paths)).message, /`relay` must be a mapping/);

  const empty = seed(t, { ...V3_BASE, relay: { claude: '' } });
  assert.match(thrown(() => loadLayeredProfile(empty.root, empty.paths)).message, /relay\.claude/);
});

test('overriding one harness relay does not drop the other', (t) => {
  // `relay:` is entry-merged. Whole-key replacement would mean a project
  // catalog naming only `codex:` silently discards the user-scope `claude:`
  // beside it — a drop with no error, which is the failure this key was
  // added under.
  const { root, paths } = seed(
    t,
    { schema_version: 3, relay: { codex: 'luna@low' } },
    { ...V3_BASE, relay: { claude: 'sonnet', codex: 'sol' } },
  );
  const profile = loadLayeredProfile(root, paths).profile;
  assert.equal(resolveRelay(profile, 'claude')?.modelId, 'sonnet', 'the user-scope claude relay must survive');
  assert.equal(resolveRelay(profile, 'codex')?.modelId, 'gpt-5.6-luna', 'the project layer wins for the key it names');
});

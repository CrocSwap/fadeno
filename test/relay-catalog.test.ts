import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import {
  ExecutorProfileError,
  resolveRelay,
  type ExecutorProfile,
} from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4Doc, tempRepo } from './helpers.ts';

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

const V4_BASE = catalogV4Doc({
  models: {
    sol: { provider: 'dummy', id: 'sol', effort: 'high' },
    luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' },
    sonnet: { provider: 'dummy', id: 'sonnet', effort: 'xhigh' },
  },
  harnesses: { dummy: { provider: 'dummy', command: ['node', '-e', '0'] } },
  archetypes: { worker: { } },
});

/**
 * The v4 spelling: a relay lives on the harness it belongs to, inside its
 * `host:` block. `relay:` as a top-level key is gone — a relay only means
 * anything for a harness Fadeno can run INSIDE, and that is exactly what
 * `host:` marks.
 */
function withRelays(relays: Record<string, string>, base: Record<string, unknown> = V4_BASE): Record<string, unknown> {
  const harnesses: Record<string, unknown> = { ...(base.harnesses as Record<string, unknown> ?? {}) };
  for (const [harness, ref] of Object.entries(relays)) {
    const existing = (harnesses[harness] ?? {}) as Record<string, unknown>;
    harnesses[harness] = { ...existing, host: { effort_channel: 'none', relay: ref } };
  }
  return { ...base, harnesses };
}

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
  const profile = load(t, withRelays({ claude: 'sonnet', codex: 'luna@low' }));

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
  const profile = load(t, withRelays({ claude: 'sonnet' }));
  assert.equal(resolveRelay(profile, 'grok'), null);
  assert.equal(resolveRelay(profile, 'codex'), null);
  // And a catalog whose harnesses declare no relay at all is the same answer
  // for everyone: callers keep their built-in defaults rather than being
  // handed a model the session's provider may not serve.
  const bare = load(t, V4_BASE);
  for (const harness of ['claude', 'codex', 'grok']) assert.equal(resolveRelay(bare, harness), null);
});

test('the relay is compiled for the harness asked about, not the ambient one', (t) => {
  // Claude's plugin assets are routinely generated from a Codex session and
  // vice versa. If `resolveRelay` read `profile.harness` instead of its own
  // argument it would answer from the wrong route table — silently, since
  // both tables usually carry a route of the same name.
  const { root, paths } = seed(t, withRelays({ claude: 'sonnet', codex: 'luna@low' }));
  const codexProfile = loadLayeredProfile(root, paths, 'codex').profile;
  assert.equal(codexProfile.host, 'codex');
  assert.equal(resolveRelay(codexProfile, 'claude')?.modelId, 'sonnet');
  assert.equal(resolveRelay(codexProfile, 'codex')?.modelId, 'gpt-5.6-luna');
});

test('a relay on a harness with no host block cannot be declared at all', (t) => {
  // The v4 shape carries the rule structurally: a relay forwards work from
  // inside a session, so it lives under `host:`, and a harness Fadeno can only
  // spawn has nowhere to put one. `relay:` as a top-level key — where
  // `relay.cladue` used to mean "no opinion for claude", silently keeping the
  // default — no longer exists, and says so.
  const { root, paths, projectFile } = seed(t, { ...V4_BASE, relay: { cladue: 'sonnet' } });
  const err = thrown(() => loadLayeredProfile(root, paths));
  assert.match(err.message, /`relay` was removed in catalog v4/);
  assert.match(err.message, /harnesses\.<id>\.host\.relay/);
  assert.ok(err.message.startsWith(`${projectFile}: `), 'a top-level key still names the file');

  // A relay beside a `command:` with no `host:` is refused as an unknown key,
  // because there is no host lane for it to describe.
  const noHost = seed(t, {
    ...V4_BASE,
    harnesses: { dummy: { provider: 'dummy', command: ['node', '-e', '0'], relay: 'sonnet' } },
  });
  assert.match(thrown(() => loadLayeredProfile(noHost.root, noHost.paths)).message, /`harnesses\.dummy` has unknown key\(s\) relay/);
});

test('a relay holding a malformed ref fails loudly', (t) => {
  const empty = seed(t, withRelays({ claude: '' }));
  assert.match(thrown(() => loadLayeredProfile(empty.root, empty.paths)).message, /harnesses\.claude`\.host\.relay/);
});

test('overriding one harness relay does not drop the other', (t) => {
  // `harnesses:` is entry-merged, per harness id. Whole-key replacement would
  // mean a project catalog naming only `codex:` silently discards the
  // user-scope `claude:` beside it — a drop with no error, which is the
  // failure the relay key was added under in the first place.
  const { root, paths } = seed(
    t,
    { schema_version: 4, harnesses: { codex: { provider: 'openai', host: { effort_channel: 'agent-file', relay: 'luna@low' }, command: ['codex'] } } },
    withRelays({ claude: 'sonnet', codex: 'sol' }),
  );
  const profile = loadLayeredProfile(root, paths).profile;
  assert.equal(resolveRelay(profile, 'claude')?.modelId, 'sonnet', 'the user-scope claude relay must survive');
  assert.equal(resolveRelay(profile, 'codex')?.modelId, 'gpt-5.6-luna', 'the project layer wins for the key it names');
});

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

// Hermetic user scope for the whole suite: a developer's real `fadeno setup`
// state (user executor catalog + sticky user loadout under XDG/state) must
// never leak into in-process command calls or spawned CLIs that default to
// `process.env`. Tests that exercise user-state behavior on purpose inject a
// fully explicit `userPathOptions` (home + env) and are unaffected. Every
// test file imports this module, so this runs before any test body.
process.env.FADENO_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'fadeno-test-user-config-'));
process.env.FADENO_STATE_HOME = mkdtempSync(join(tmpdir(), 'fadeno-test-user-state-'));

// `userPaths()` (src/lib/user-paths.ts) does `env = options.env ?? process.env`
// — passing an explicit `env` REPLACES the whole environment, not merges with
// it. So a test that does `{ env: { FADENO_HARNESS: 'claude' } }` bypasses the
// module-level `FADENO_STATE_HOME`/`FADENO_CONFIG_HOME` redirect above
// entirely (that small literal object has neither key) and falls through to
// `options.home ?? homedir()` — the developer's REAL home directory, since
// `home` was never passed either. There is no way to isolate that call site
// from within the small `env` object alone.
//
// The fix lives here, in `tempRepo()`, rather than in a wrapper around
// `process.env` at the top of the file: `os.homedir()` re-reads
// `process.env.HOME` live (verified — it is not cached at process start), so
// redirecting `HOME` itself is what protects every "env without home" call
// site in the suite, automatically, without editing each one. `tempRepo()` is
// also the right layer rather than `package.json`'s test script: a script
// only protects `npm test` and leaves `npm run focus` and a bare
// `node --test test/foo.test.ts` exposed, which is exactly how anyone
// iterating on one file runs it — isolation must follow the test, not the
// invocation.
const HOME_ENV_KEYS = ['HOME', 'FADENO_CONFIG_HOME', 'FADENO_STATE_HOME', 'FADENO_DATA_HOME'] as const;

/** Tests for which the home-env redirect below has already been installed. */
const homeRedirected = new WeakSet<TestContext>();

/**
 * Redirect `HOME` and the `FADENO_*_HOME` variables into a throwaway
 * directory for the life of test `t`, restoring the exact previous values
 * (deleting a variable that was previously unset, rather than setting it to
 * the string "undefined") once `t` finishes. Idempotent per test: a test that
 * calls `tempRepo()` more than once only snapshots/redirects on the first
 * call, so a later call cannot clobber the snapshot with an already-redirected
 * value.
 */
function ensureHomeRedirected(t: TestContext): void {
  if (homeRedirected.has(t)) return;
  homeRedirected.add(t);
  const previous: Partial<Record<(typeof HOME_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of HOME_ENV_KEYS) previous[key] = process.env[key];
  const home = mkdtempSync(join(tmpdir(), 'fadeno-test-home-'));
  process.env.HOME = home;
  process.env.FADENO_CONFIG_HOME = join(home, 'config');
  process.env.FADENO_STATE_HOME = join(home, 'state');
  process.env.FADENO_DATA_HOME = join(home, 'data');
  t.after(() => {
    for (const key of HOME_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
}

/**
 * Create a throwaway repo directory that is removed when the test ends.
 *
 * Also makes the test hermetic against the developer's real user-scope state
 * (see `ensureHomeRedirected` above) by redirecting `HOME` and the
 * `FADENO_*_HOME` variables for the test's lifetime. Pass `{ realHome: true }`
 * to opt a specific test out of that redirect — only for a test that
 * genuinely needs the developer's real home directory.
 */
export function tempRepo(t: TestContext, options: { realHome?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fadeno-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (!options.realHome) ensureHomeRedirected(t);
  return dir;
}

export function exists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const STARTER_PLAYBOOK_DIR = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'playbooks');

/**
 * The starter playbook corpus, derived from the committed template files rather
 * than hand-listed. Every registry that used to carry its own copy of this list
 * (completion's expected candidates, the diagram render sweep, init's emitted
 * shared files, validate's result count, the builder skill's prose catalog)
 * reads it from here, so shipping a new starter is a one-file change and cannot
 * silently miss a registry.
 *
 * @returns sorted basenames without the `.yaml` extension.
 */
export function starterPlaybooks(): string[] {
  return readdirSync(STARTER_PLAYBOOK_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

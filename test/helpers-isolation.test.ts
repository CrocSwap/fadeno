import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import test from 'node:test';
import { userPaths } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// Real home directory, captured once at module load — before any test in
// this file (or any test file, given `node --test` isolates one process per
// file) has redirected `HOME`. Used below as the thing user-scope paths must
// never resolve under once a test has called `tempRepo()`.
const REAL_HOME = homedir();

/**
 * Canary for the bug fixed in `test/helpers.ts`'s `tempRepo()`:
 * `userPaths()` (src/lib/user-paths.ts) does `env = options.env ??
 * process.env`, so a caller that passes an explicit `env` WITHOUT `home`
 * replaces the whole environment rather than merging with it — bypassing any
 * `FADENO_STATE_HOME`/`FADENO_CONFIG_HOME` redirect and falling through to
 * `options.home ?? homedir()`, the developer's REAL home directory. That
 * pattern (`{ env: { FADENO_HARNESS: 'claude' } }`, no `home`) is common
 * across the suite. `tempRepo()` now redirects `process.env.HOME` itself for
 * the life of the test, which `os.homedir()` re-reads live, so this exact
 * call shape is isolated automatically. If that redirect ever regresses,
 * this test starts reading (and potentially depending on) the machine's real
 * `~/.local/state/fadeno/dials.json` again — silently, since most CI/dev
 * machines have no such file and the tests would keep passing right up until
 * someone with real dials set ran them locally.
 */
test('canary: a tempRepo test never resolves user-scope dials under the real home directory', (t) => {
  tempRepo(t);

  // The exposed shape: `env` given, `home` omitted.
  const paths = userPaths({ env: { FADENO_HARNESS: 'claude' } });

  assert.ok(
    !paths.dialsFile.startsWith(REAL_HOME),
    `resolved user dials path must never be under the real home directory; got ${paths.dialsFile}`,
  );
  assert.ok(
    !paths.stateDir.startsWith(REAL_HOME),
    `resolved user state dir must never be under the real home directory; got ${paths.stateDir}`,
  );
  assert.ok(
    !paths.configDir.startsWith(REAL_HOME),
    `resolved user config dir must never be under the real home directory; got ${paths.configDir}`,
  );

  // Same shape with no userPathOptions at all (falls through to process.env
  // and homedir() unconditionally) must be isolated too.
  const bare = userPaths();
  assert.ok(!bare.dialsFile.startsWith(REAL_HOME), `resolved user dials path (bare) must never be under the real home directory; got ${bare.dialsFile}`);
});

test('canary: {realHome: true} opts a test back into the real home directory', (t) => {
  tempRepo(t, { realHome: true });
  const paths = userPaths({ env: { FADENO_HARNESS: 'claude' } });
  assert.ok(
    paths.dialsFile.startsWith(REAL_HOME),
    `{ realHome: true } should leave HOME unredirected; got ${paths.dialsFile}`,
  );
});

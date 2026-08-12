import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Create a throwaway repo directory that is removed when the test ends. */
export function tempRepo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'fadeno-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function exists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

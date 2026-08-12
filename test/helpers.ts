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

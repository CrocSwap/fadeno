import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

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

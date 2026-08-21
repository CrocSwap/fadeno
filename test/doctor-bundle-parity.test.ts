import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDoctor } from '../src/commands/doctor.ts';
import { packageVersion, templatesDir } from '../src/lib/paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * A plugin surface whose bundled templates are a copy of this CLI's own, so
 * the only difference is whatever the test removes.
 */
function seedSurface(t: TestContext): { root: string; pluginRoot: string; env: NodeJS.ProcessEnv } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const pluginRoot = join(root, 'plugin');
  const bundled = join(pluginRoot, 'bin', 'templates', 'common', 'fadeno');
  mkdirSync(bundled, { recursive: true });
  cpSync(join(templatesDir(), 'common', 'fadeno'), bundled, { recursive: true });
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  return { root, pluginRoot, env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot } };
}

function pluginSurfaceFinding(root: string, env: NodeJS.ProcessEnv, version: string): { severity: string; detail: string } | null {
  writeFileSync(
    join(root, 'plugin', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fadeno', version }),
  );
  const result = runDoctor({ repoRoot: root, processEnv: env });
  const finding = result.findings.find((f) => f.check === 'plugin-surface');
  return finding == null ? null : { severity: finding.severity, detail: finding.detail };
}

test('a same-version plugin with a MISSING bundled template is reported, not called a match', (t) => {
  // Version equality is not content equality, and this check used to assert
  // the stronger one. `bakeoff.schema.json` shipped in templates/ and
  // was absent from both bundled snapshots for five commits at the SAME
  // version, so `fadeno bakeoff` from a managed runtime failed with "no
  // bakeoff schema available" while doctor reported a match. A
  // version bump does not rebuild the bundle; only `build:bin` does.
  const { root, pluginRoot, env } = seedSurface(t);
  // Match this CLI exactly, so the version halves agree and the ONLY thing
  // under test is bundle CONTENT — which is the distinction the check missed.
  const version = packageVersion();

  const complete = pluginSurfaceFinding(root, env, version);
  assert.equal(complete?.severity, 'ok', 'a complete bundle at the same version is fine');

  rmSync(join(pluginRoot, 'bin', 'templates', 'common', 'fadeno', 'schemas', 'bakeoff.schema.json'), { force: true });
  const stale = pluginSurfaceFinding(root, env, version);
  assert.equal(stale?.severity, 'warning', 'a missing bundled template must not read as a match');
  assert.match(stale!.detail, /bundled templates are stale/);
  assert.match(stale!.detail, /bakeoff\.schema\.json/);
});

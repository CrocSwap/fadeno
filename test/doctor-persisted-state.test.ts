import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDoctor } from '../src/commands/doctor.ts';
import { DIALS_LOCAL_FILE } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// The failure this file exists for.
//
// `runDoctor` wrapped the status/catalog work in one `try` whose `catch` pushed
// a `configuration` error and RETURNED — before the writability loop and before
// the persisted-state audit. So the ONE class of failure the inventory was
// built to explain was the one class where it never ran: a `dials.json` or a
// `.fadeno/local/dials` stamped with a version this build refuses makes
// `runStatus` throw, and the user saw a bare "configuration: error" naming a
// version number, with no `persisted-state:<id>` finding, no backup directory,
// and no instruction. The diagnostic went silent at exactly the moment it was
// the diagnosis.
//
// The audit is a diagnostic, not a replacement diagnosis: the generic
// `configuration` error stays, because the status failure is real.

/** A hermetic user scope — no CODEX_HOME, no real dials, no real catalog. */
function isolatedUser(t: TestContext, root: string): UserPathOptions {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

/** `<STATE_HOME>/fadeno/dials.json`, stamped with a version this build refuses. */
function writeFutureUserDials(root: string): void {
  const dir = join(root, 'user-state', 'fadeno');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dials.json'), '{"schema_version":9,"dials":{}}\n', 'utf8');
}

function writeFutureRepoPin(root: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), '{"schema_version":9,"dials":{}}\n', 'utf8');
}

test('doctor: a future-stamped dials.json reports the surface AND the generic configuration error', (t) => {
  const root = tempRepo(t);
  const userPathOptions = isolatedUser(t, root);
  writeFutureUserDials(root);

  const result = runDoctor({ repoRoot: root, cwd: root, userPathOptions });
  assert.equal(result.ok, false);

  const configuration = result.findings.find((f) => f.check === 'configuration');
  assert.ok(configuration, 'the status failure is real and is still reported');
  assert.equal(configuration.severity, 'error');

  const surface = result.findings.find((f) => f.check === 'persisted-state:dials');
  assert.ok(surface, 'the audit ran on the failure path');
  assert.equal(surface.severity, 'error');
  assert.match(surface.detail, /schema_version 9/);
  assert.match(surface.detail, /newer than this fadeno reads/);
  assert.match(surface.remediation ?? '', /backups/);
  assert.match(surface.remediation ?? '', /writeUserDials/);
});

test('doctor: a future-stamped repo pin names persisted-state:repo-dials-pin, not just "configuration"', (t) => {
  const root = tempRepo(t);
  const userPathOptions = isolatedUser(t, root);
  writeFutureRepoPin(root);

  const result = runDoctor({ repoRoot: root, cwd: root, userPathOptions });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.check === 'configuration' && f.severity === 'error'));

  const surface = result.findings.find((f) => f.check === 'persisted-state:repo-dials-pin');
  assert.ok(surface);
  assert.equal(surface.severity, 'error');
  assert.match(surface.remediation ?? '', new RegExp(join(root, '.fadeno', 'local', 'backups').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('doctor: the whole inventory is present on the failure path, not just the offending surface', (t) => {
  // The surrounding rows are the context for the bad one — that is the same
  // reason the text renderer stops collapsing the moment anything is not ok.
  const root = tempRepo(t);
  const userPathOptions = isolatedUser(t, root);
  writeFutureUserDials(root);

  const failed = runDoctor({ repoRoot: root, cwd: root, userPathOptions });
  const failedSurfaces = failed.findings.filter((f) => f.check.startsWith('persisted-state:')).map((f) => f.check);

  const healthy = runDoctor({ repoRoot: tempRepo(t), cwd: root, userPathOptions: isolatedUser(t, tempRepo(t)) });
  const healthySurfaces = healthy.findings.filter((f) => f.check.startsWith('persisted-state:')).map((f) => f.check);

  assert.ok(healthySurfaces.length > 0, 'the ok path reports the inventory');
  assert.deepEqual(failedSurfaces, healthySurfaces, 'the failure path reports exactly the same surfaces');
});

test('doctor: the audit is reported once, never twice', (t) => {
  // The audit moved into a closure called from exactly one of two places. A
  // duplicated `persisted-state:dials` would make the renderer's all-ok
  // collapse count surfaces that do not exist.
  const root = tempRepo(t);
  const userPathOptions = isolatedUser(t, root);
  for (const setup of [() => {}, () => writeFutureUserDials(root)]) {
    setup();
    const checks = runDoctor({ repoRoot: root, cwd: root, userPathOptions }).findings
      .filter((f) => f.check.startsWith('persisted-state:'))
      .map((f) => f.check);
    assert.equal(new Set(checks).size, checks.length, `duplicate surface findings: ${checks.join(', ')}`);
  }
});

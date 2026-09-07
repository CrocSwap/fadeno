#!/usr/bin/env node
// The inner-loop test tier: every test file measured under 8s wall.
//
// `npm test` is the gate and stays the gate — it runs all 157 files in ~400s.
// This runs 64 of them in ~23s, which is the difference between checking your
// work and not bothering. It is a SMOKE tier, not a substitute: a file absent
// from `test/.fast-tier` is not excluded on purpose, it is simply slow, and
// the thing you just edited may well live in one. Run its file directly.
//
// The manifest is an allowlist rather than a denylist because the failure
// directions are not symmetric. A new test file missing from the allowlist
// costs a slower first check; a slow file wrongly IN a denylist-derived tier
// costs the tier its reason to exist. Regenerate with `npm run test:fast:regen`.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = 'test/.fast-tier';
if (!existsSync(manifest)) {
  console.error(`${manifest} is missing — run \`npm run test:fast:regen\`.`);
  process.exit(1);
}
const files = readFileSync(manifest, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('#'));

// A manifest naming a file that no longer exists is stale, not fatal: the
// rename that caused it should not also block the check you were running.
const present = files.filter((f) => existsSync(f));
const missing = files.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(`note: ${missing.length} file(s) in ${manifest} no longer exist; regenerate. (${missing.slice(0, 3).join(', ')})`);
}

const started = Date.now();
const run = spawnSync(process.execPath, ['--test', ...present], { stdio: 'inherit' });
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.error(`\nfast tier: ${present.length} files in ${secs}s — \`npm test\` is the gate (157 files).`);
process.exit(run.status ?? 1);

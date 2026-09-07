// Four holes found by the blinded adversarial judge pass on pairs 49a1f92a
// and 89536181, each verified against `main` by measurement before being
// fixed here. They share one shape: a surface answering a question it could
// not actually answer, and answering it optimistically.
//
// What survives the permissions cut: eligibility is still a real refusal the
// kernel makes, so a resolve that recommends dispatching into it is still a
// defect. The write-posture halves of this file are gone with the system they
// tested — see docs/experimental/permissions-and-isolation.md.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDialResolve, runDialSet, runDialShadow } from '../src/commands/dial.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const ECHO = (p: string): string[] => ['node', '-e', `process.stdout.write('${p}')`];
function iso(root: string, h = 'codex'): UserPathOptions {
  return { home: join(root, 'home'), env: {
    FADENO_CONFIG_HOME: join(root, 'user-config'),
    FADENO_STATE_HOME: join(root, 'user-state'), FADENO_HARNESS: h } };
}
function seed(t: TestContext, catalog: unknown): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(catalog));
  return root;
}

// `eligibility: forbidden` is refused by the kernel with no force branch, so
// a resolve that says "Dispatch it" is guidance walking into that refusal.
// Write posture got this argument when the same defect was found there;
// eligibility never did.
test('dial resolve refuses to recommend a dispatch the kernel forbids on eligibility', (t) => {
  const root = seed(t, {
    schema_version: 4,
    models: { ro: { provider: 'rop', id: 'ro-m' } },
    harnesses: { rop: { provider: 'rop', command: ECHO('RO'), eligibility: { worker: 'forbidden' } } },
    archetypes: { worker: {} },
    dials: { worker: 'ro' },
  });
  const r = runDialResolve({ archetype: 'worker', repoRoot: root, userPathOptions: iso(root) });
  assert.equal(r.delivery.dispatchable, false);
  assert.match(r.delivery.action, /Do NOT dispatch/);
  assert.match(r.delivery.action, /eligibility: forbidden/);
});

// `write_access` undeclared is `null`, and null satisfies EVERY posture. The
// decision recorded with this change is to make that visible rather than
// refuse it: refusing would break every catalog that omits the key, and
// "we never asked" is not the same as "no meaningful delivery exists".




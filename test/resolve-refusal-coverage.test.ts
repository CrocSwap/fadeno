// Four holes found by the blinded adversarial judge pass on pairs 49a1f92a
// and 89536181, each verified against `main` by measurement before being
// fixed here. They share one shape: a surface answering a question it could
// not actually answer, and answering it optimistically.
//
// The standard these encode: a REFUSAL is reserved for the case where no
// meaningful delivery or comparison exists at all. Everything else must be
// visible instead — which means the optimistic silent answer is the bug, not
// the absence of a new refusal.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDialResolve, runDialSet, runDialShadow } from '../src/commands/dial.ts';
import { runDoctor } from '../src/commands/doctor.ts';
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
    schema_version: 3,
    models: { ro: { provider: 'rop', id: 'ro-m' } },
    routes: { codex: { rop: { command: ECHO('RO'), write_access: true, eligibility: { worker: 'forbidden' } } } },
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
test('an unverifiable write posture warns at dial time rather than passing silently', (t) => {
  const root = seed(t, {
    schema_version: 3,
    models: { und: { provider: 'up', id: 'u-m' } },
    routes: { codex: { up: { command: ECHO('U') } } },
    archetypes: { worker: { requires_write: 'required' } },
  });
  const r = runDialSet({ archetype: 'worker', model: 'und', repoRoot: root, userPathOptions: iso(root), session: true });
  const warn = r.notes.find((n: string) => n.includes('WRITE POSTURE UNENFORCED'));
  assert.ok(warn, 'a posture that cannot be checked must say so');
  assert.match(warn, /does not declare `write_access:`/);
  assert.match(warn, /empty diff/);
});

test('an unverifiable write posture also warns where a shadow is attached', (t) => {
  const root = seed(t, {
    schema_version: 3,
    models: { und: { provider: 'up', id: 'u-m' }, grok: { provider: 'xai', id: 'grok' } },
    routes: { codex: { up: { command: ECHO('U') }, xai: { command: ECHO('C'), write_access: true } } },
    archetypes: { worker: { requires_write: 'required' } },
    dials: { worker: 'und' },
  });
  const r = runDialShadow({ archetype: 'worker', model: 'grok', repoRoot: root, userPathOptions: iso(root) });
  assert.ok(
    r.notes.some((n: string) => n.includes('WRITE POSTURE UNENFORCED')),
    'a pair is exactly where an unenforced posture produces a confident wrong verdict',
  );
});

// A misspelled `archetypes:` key cannot be refused — an archetype with no
// declared posture is legal — so it is linted. The damage is indirect: the
// REAL archetype silently loses its posture.
test('doctor lints an archetype policy that nothing dials', (t) => {
  const root = seed(t, {
    schema_version: 3,
    models: { ro: { provider: 'rop', id: 'ro-m' } },
    routes: { codex: { rop: { command: ECHO('RO'), write_access: false } } },
    archetypes: { wroker: { requires_write: 'required' } },
    dials: { worker: 'ro' },
  });
  const r = runDoctor({ repoRoot: root, userPathOptions: iso(root) } as Parameters<typeof runDoctor>[0]);
  const f = r.findings.find((x) => x.check === 'archetype-policy-unreferenced');
  assert.ok(f, 'an archetype policy nothing dials is almost always a typo');
  assert.equal(f.severity, 'warning');
  assert.match(f.detail, /"wroker"/);
});

test('doctor stays quiet when every declared archetype is actually dialed', (t) => {
  const root = seed(t, {
    schema_version: 3,
    models: { ro: { provider: 'rop', id: 'ro-m' } },
    routes: { codex: { rop: { command: ECHO('RO'), write_access: false } } },
    archetypes: { worker: { requires_write: 'none' } },
    dials: { worker: 'ro' },
  });
  const r = runDoctor({ repoRoot: root, userPathOptions: iso(root) } as Parameters<typeof runDoctor>[0]);
  assert.equal(r.findings.find((x) => x.check === 'archetype-policy-unreferenced'), undefined);
});

test('a posture that CAN be checked produces no unenforced warning', (t) => {
  const root = seed(t, {
    schema_version: 3,
    models: { rw: { provider: 'rwp', id: 'rw-m' } },
    routes: { codex: { rwp: { command: ECHO('RW'), write_access: true } } },
    archetypes: { worker: { requires_write: 'required' } },
  });
  const r = runDialSet({ archetype: 'worker', model: 'rw', repoRoot: root, userPathOptions: iso(root), session: true });
  assert.ok(!r.notes.some((n: string) => n.includes('WRITE POSTURE UNENFORCED')));
});

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDoctor } from '../src/commands/doctor.ts';
import { runInit } from '../src/commands/init.ts';
import { runSteeringApply } from '../src/commands/steering.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { packageVersion } from '../src/lib/paths.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { read, tempRepo } from './helpers.ts';

/**
 * The relay is the only model a Codex command broker names, and it used to be
 * a source literal (`gpt-5.6-luna` / `low`) that no dial could reach. It is a
 * catalog key now (`relay.codex`), so these tests pin both halves of that
 * contract: an override reaches the emitted TOML, and a catalog with no
 * opinion still renders the exact bytes the literals always produced.
 */

const ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

/**
 * A self-contained project catalog — its own `models:` AND `routes:` — which
 * suppresses the builtin layer entirely (see `config-layers.ts`'s
 * `projectIsComplete`). That is what makes it usable as the "no catalog
 * opinion" fixture: the shipped `relay:` block cannot leak in underneath it.
 * `grok` is command-delivered here, so every slot dialed to it materializes as
 * a broker rather than a host agent.
 */
function seedSelfContainedCatalog(root: string, relay?: Record<string, string>): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 3,
      models: {
        luna: { provider: 'openai', id: 'gpt-5.6-luna', effort: 'xhigh' },
        terra: { provider: 'openai', id: 'gpt-5.6-terra', effort: 'high' },
        grok: { provider: 'xai', id: 'grok-4.6', effort: 'xhigh' },
      },
      routes: {
        codex: {
          'current-host': { host: true },
          openai: { host: true },
          xai: { command: ['grok', '--model', '{model}'], },
        },
      },
      ...(relay ? { relay } : {}),
    }),
    'utf8',
  );
}

/** Force all three slots onto the command lane, so all three render brokers. */
function dialEverythingToCommand(root: string): void {
  writeLocalDialState(root, {
    dials: { worker: { model: 'grok' }, reviewer: { model: 'grok' }, judge: { model: 'grok' } },
    shadows: {},
    legacyNote: null,
  });
}

test('a catalog relay.codex override reaches every emitted Codex broker', (t) => {
  const root = tempRepo(t);
  seedSelfContainedCatalog(root, { codex: 'terra@medium' });
  dialEverythingToCommand(root);

  const applied = runSteeringApply({ repoRoot: root, target: 'codex' });
  assert.ok(
    Object.values(applied.materialization).every((slot) => slot.kind === 'command-broker'),
    'fixture must put all three slots on the command lane',
  );

  for (const archetype of ARCHETYPES) {
    const body = read(root, `.codex/agents/${archetype}.toml`);
    // The provider-facing id, not the catalog's bare name: a broker TOML is
    // handed straight to Codex.
    assert.match(body, /^model = "gpt-5\.6-terra"$/m, `${archetype} must relay on the dialed relay model`);
    // `@medium` pins the effort, overriding terra's `effort: high` default.
    assert.match(body, /^model_reasoning_effort = "medium"$/m, `${archetype} must carry the pinned relay effort`);
    assert.doesNotMatch(body, /gpt-5\.6-luna/, `${archetype} must not fall back once the catalog states an opinion`);
  }
});

test('a relay ref with no pinned effort takes the model registry default', (t) => {
  const root = tempRepo(t);
  seedSelfContainedCatalog(root, { codex: 'terra' });
  dialEverythingToCommand(root);

  runSteeringApply({ repoRoot: root, target: 'codex' });
  const body = read(root, '.codex/agents/worker.toml');
  assert.match(body, /^model = "gpt-5\.6-terra"$/m);
  assert.match(body, /^model_reasoning_effort = "high"$/m);
});

test('a catalog with no relay opinion renders the built-in broker identity unchanged', (t) => {
  const root = tempRepo(t);
  // No `relay:` key at all, and self-contained so the shipped block cannot
  // reach this repo — the common case for a real project catalog.
  seedSelfContainedCatalog(root);
  dialEverythingToCommand(root);

  runSteeringApply({ repoRoot: root, target: 'codex' });
  for (const archetype of ARCHETYPES) {
    const body = read(root, `.codex/agents/${archetype}.toml`);
    // The built-in fallback, which is kept equal to the shipped catalog's
    // `relay.codex` rather than frozen at what the renderer once hardcoded —
    // see the test below, which is what holds those two together.
    assert.match(body, /^model = "gpt-5\.6-luna"\nmodel_reasoning_effort = "high"$/m);
  }
});

/**
 * The relay ref is a dial ref like any other, so a catalog can name a model
 * that does not compile under the codex harness. Refusing to materialize any
 * broker at all over that would be strictly worse than materializing the
 * servable built-in one, so an uncompilable relay is treated as the same "no
 * servable opinion" answer as an absent key.
 */
test('an uncompilable relay ref degrades to the built-in identity rather than failing the apply', (t) => {
  const root = tempRepo(t);
  seedSelfContainedCatalog(root, { codex: 'no-such-model' });
  dialEverythingToCommand(root);

  const applied = runSteeringApply({ repoRoot: root, target: 'codex' });
  assert.equal(applied.materialization.worker?.kind, 'command-broker');
  assert.match(read(root, '.codex/agents/worker.toml'), /^model = "gpt-5\.6-luna"\nmodel_reasoning_effort = "high"$/m);
});

/**
 * One question — what relays a Codex delivery — must not have two answers.
 *
 * The source constant and the shipped catalog are separate code paths on
 * purpose (a self-contained project catalog suppresses the shipped layer, so
 * the constant is what a real repo usually gets), which is exactly the
 * one-question-two-places shape that has produced silent wrong answers here
 * before. They were allowed to differ once, as a migration anchor; that
 * migration is over, so this pins them together and fails the moment someone
 * edits `relay.codex` without moving the fallback with it.
 */
test('the built-in relay fallback and the shipped catalog name the same identity', (t) => {
  const shipped = tempRepo(t);
  runInit({ target: 'codex', repoRoot: shipped, withSteering: true });

  const noOpinion = tempRepo(t);
  seedSelfContainedCatalog(noOpinion);
  dialEverythingToCommand(noOpinion);
  runSteeringApply({ repoRoot: noOpinion, target: 'codex' });

  const identity = (body: string): string => {
    const match = /^model = ".+"\nmodel_reasoning_effort = ".+"$/m.exec(body);
    assert.ok(match, 'broker must declare a model and an effort');
    return match[0];
  };

  assert.equal(
    identity(read(noOpinion, '.codex/agents/worker.toml')),
    identity(read(shipped, '.codex/agents/worker.toml')),
    'the built-in fallback must track the shipped catalog relay, not drift from it',
  );
});

test('init renders its Codex brokers from the repo catalog instead of copying frozen text', (t) => {
  const root = tempRepo(t);
  // `init` skips a file that already exists, so a pre-seeded catalog is the
  // repo's catalog by the time step 3 resolves the relay from it. This is
  // what proves init reads the catalog rather than emitting fixed literals.
  seedSelfContainedCatalog(root, { codex: 'terra@medium' });
  runInit({ target: 'codex', repoRoot: root, withSteering: true });

  for (const archetype of ARCHETYPES) {
    const body = read(root, `.codex/agents/${archetype}.toml`);
    assert.match(body, /^model = "gpt-5\.6-terra"$/m);
    assert.match(body, /^model_reasoning_effort = "medium"$/m);
    // Rendered by the same template `steering apply` renders — the drift seam
    // the frozen `templates/codex/codex-steering-agents/` tree used to open.
    assert.match(body, new RegExp(`fadeno steering resolve --archetype ${archetype} --prompt-file <path>`));
    // An unmaterialized slot claims no host identity: nothing has been dialed.
    assert.doesNotMatch(body, /--host-executor/);
  }
});

test('the data-only plugin flow renders the same brokers as a full init', (t) => {
  const seeded = tempRepo(t);
  seedSelfContainedCatalog(seeded, { codex: 'terra@medium' });
  runInit({ target: 'codex', repoRoot: seeded, withSteering: true });

  const dataOnly = tempRepo(t);
  seedSelfContainedCatalog(dataOnly, { codex: 'terra@medium' });
  runInit({ target: 'codex', repoRoot: dataOnly, dataOnly: true, withSteering: true });

  for (const archetype of ARCHETYPES) {
    assert.equal(
      read(dataOnly, `.codex/agents/${archetype}.toml`),
      read(seeded, `.codex/agents/${archetype}.toml`),
      `${archetype}: the two init paths must not diverge`,
    );
  }
});

test('init never clobbers a hand-edited Codex broker without --force', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, withSteering: true });
  const mine = join(root, '.codex', 'agents', 'worker.toml');
  writeFileSync(mine, 'name = "worker"\n# hand-edited\n', 'utf8');

  const again = runInit({ target: 'codex', repoRoot: root, withSteering: true });
  assert.equal(read(root, '.codex/agents/worker.toml'), 'name = "worker"\n# hand-edited\n');
  assert.equal(again.results.find((item) => item.path === mine)?.status, 'skipped');

  const forced = runInit({ target: 'codex', repoRoot: root, withSteering: true, force: true });
  assert.equal(forced.results.find((item) => item.path === mine)?.status, 'overwritten');
  assert.match(read(root, '.codex/agents/worker.toml'), /Fadeno command broker worker/);
});

// --- The managed header at project scope ---
//
// Project-scope brokers used to be written by plain `emitFile`, with no header
// at all. That is what made them unrefreshable — nothing on disk could prove a
// given `worker.toml` was Fadeno's rather than the repo owner's, so the only
// safe answer was to leave every existing file alone. Stamping the same header
// user scope already carries is what lets a later `init`/`apply` bring its own
// file up to date, and what lets `doctor` tell a current project broker from a
// frozen legacy one.

test('project-scope Codex brokers carry the managed header, digested over the un-headered body', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, withSteering: true });

  for (const archetype of ARCHETYPES) {
    const text = read(root, `.codex/agents/${archetype}.toml`);
    const [header, ...rest] = text.split('\n');
    const body = rest.join('\n');
    assert.match(header!, /^# fadeno:managed version=\S+ digest=[0-9a-f]{64}$/, archetype);
    assert.ok(header!.includes(`version=${packageVersion()}`), `${archetype} must stamp this build's version`);
    // The digest covers the body WITHOUT the header — it cannot cover itself,
    // and hashing the same bytes at both scopes lets two files rendered from
    // one resolution be compared directly.
    assert.ok(header!.includes(`digest=${sha256Hex(body)}`), `${archetype} digest must cover the rendered body`);
    assert.ok(body.startsWith(`name = "${archetype}"`), `${archetype} body must follow the header intact`);
  }
});

test('a stale managed project broker is refreshed in place, with no --force needed', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root, withSteering: true });
  const worker = join(root, '.codex', 'agents', 'worker.toml');
  // An older generation, exactly as an earlier build would have left it.
  writeFileSync(worker, '# fadeno:managed version=0.6.0-rc.10 digest=deadbeef\nname = "worker"\n', 'utf8');

  const again = runInit({ target: 'codex', repoRoot: root, withSteering: true });
  assert.equal(again.results.find((item) => item.path === worker)?.status, 'overwritten');
  assert.match(read(root, '.codex/agents/worker.toml'), new RegExp(`version=${packageVersion().replace(/\./g, '\\.')}`));
  assert.match(read(root, '.codex/agents/worker.toml'), /Fadeno command broker worker/);

  // And an unchanged file stays untouched, so re-running init is still a no-op.
  const third = runInit({ target: 'codex', repoRoot: root, withSteering: true });
  assert.equal(third.results.find((item) => item.path === worker)?.status, 'skipped');
});

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

/**
 * The sanctioned setup path must not trip doctor's shadow warning. Codex
 * prefers `<repo>/.codex/agents/<archetype>.toml` over
 * `$CODEX_HOME/agents/fadeno-<archetype>.toml`, so a project broker always
 * outranks the user-scope one — and an UNMANAGED project file is the shape
 * doctor warns about, because nothing can ever refresh it. Before the header
 * was stamped at project scope, every freshly initialized repo with user-scope
 * brokers looked exactly like that, and the warning would have fired on the
 * happy path forever, burying the real legacy signal.
 */
test('a fresh init alongside user-scope brokers leaves doctor silent about shadowing', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  runInit({ target: 'codex', repoRoot: root, withSteering: true });
  runSteeringApply({ repoRoot: root, target: 'codex', scope: 'user', userPathOptions: user, force: true });

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });
  const shadowChecks = result.findings
    .filter((f) => ['codex-agents-project', 'codex-agents-shadow', 'codex-agents-shadow-stale'].includes(f.check))
    .map((f) => `${f.check}:${f.severity}`);
  assert.deepEqual(shadowChecks, [], `doctor must stay silent on the sanctioned path, got ${shadowChecks.join(', ')}`);
});

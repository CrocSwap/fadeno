import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runDialResolve, runDialSet, runDialShow } from '../src/commands/dial.ts';
import { runDispatch } from '../src/commands/dispatch.ts';
import { runInit } from '../src/commands/init.ts';
import { runSteeringApply, runSteeringApplyOpenCode } from '../src/commands/steering.ts';
import { loadGlobalProfile, loadLayeredProfile } from '../src/lib/config-layers.ts';
import {
  argvGrantsFadenoShell,
  eligibilityFor,
  ExecutorProfileError,
  formatDialRef,
  parseDialRef,
  parseExecutorProfile,
  parseSnapshotDocument,
  resolveDelivery,
  serializeSnapshot,
  SNAPSHOT_ARCHETYPE_SEPARATOR,
  snapshotExecutor,
  writeLocalDialState,
  type HarnessId,
} from '../src/lib/executors.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { catalogV4, tempRepo } from './helpers.ts';

/**
 * Catalog v4: the properties the collapse is FOR.
 *
 * The six `routes.<host>` tables are gone, so "the same dial means different
 * lanes under different hosts" is no longer expressible as six copies of an
 * argv — it is one table plus the pair *(dial harness, host)*. These tests pin
 * that pair, the explicit `--harness` override, policy-chosen variants, the
 * read-only legacy translation, and the load-time integrity rules.
 */

const STARTER = readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml'), 'utf8');

function starter(host: HarnessId) {
  return parseExecutorProfile(STARTER, 'templates/common/fadeno/executors.yaml', host);
}

// 1. Same ref, two hosts.

function writeUserCatalog(paths: UserPathOptions, text: string): void {
  const file = userPaths(paths).executorsFile;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

test('v4: the same ref is in-session under its own harness and spawned under another', () => {
  const underClaude = resolveDelivery(parseDialRef('opus', 't'), starter('claude'), 'claude', { archetype: 'worker' });
  assert.equal(underClaude.harness, 'claude');
  assert.equal(underClaude.hostCandidate, true, 'worker opus is a host candidate inside Claude');
  assert.equal(underClaude.spec.adapter, 'host');

  const underCodex = resolveDelivery(parseDialRef('opus', 't'), starter('codex'), 'codex', { archetype: 'worker' });
  assert.equal(underCodex.harness, 'claude', 'the dial names the same harness whatever the host');
  assert.equal(underCodex.hostCandidate, false);
  assert.equal(underCodex.spec.adapter, 'command');

  // The mirror image, so the property is not an accident of one provider.
  const lunaCodex = resolveDelivery(parseDialRef('luna', 't'), starter('codex'), 'codex', { archetype: 'worker' });
  assert.equal(lunaCodex.harness, 'codex');
  assert.equal(lunaCodex.hostCandidate, true);
  const lunaClaude = resolveDelivery(parseDialRef('luna', 't'), starter('claude'), 'claude', { archetype: 'worker' });
  assert.equal(lunaClaude.harness, 'codex');
  assert.equal(lunaClaude.hostCandidate, false);
  assert.equal(lunaClaude.spec.adapter, 'command');
});

// 2. Explicit harness.

test('v4: an explicit `on <harness>` resolves onto that harness, with its spelling, under every host', () => {
  for (const host of ['claude', 'codex', 'grok', 'omp', 'standalone', 'opencode'] as const) {
    const compiled = resolveDelivery(parseDialRef('opus on opencode', 't'), starter(host), host, { archetype: 'worker' });
    assert.equal(compiled.harness, 'opencode', host);
    assert.equal(compiled.modelId, 'anthropic/claude-opus-4.8', `${host}: the spelling for THIS harness`);
    const argv = compiled.spec.adapter === 'command'
      ? compiled.spec.command
      : (compiled.spec as { fallbackCommand: string[] | null }).fallbackCommand ?? [];
    assert.ok(argv.includes('openrouter/anthropic/claude-opus-4.8'), `${host}: the opencode argv carries it`);
    // Never a host candidate, on ANY host — including OpenCode itself. The
    // `opencode` harness declares `host.identity: session`, because its plugin
    // rewrites only the agent NAME: a dialed model handed to a host spawn
    // there would be silently ignored. So a named model on `opencode` is a
    // command delivery, exactly as v3's `routes.opencode` expressed it by
    // putting `host: true` on `current-host` alone.
    assert.equal(compiled.hostCandidate, false, host);
  }
});

// 3. Variant by policy.

test('v4: policy chooses the variant; a dial never names one', () => {
  const profile = starter('claude');
  const worker = resolveDelivery(parseDialRef('opus', 't'), profile, 'claude', { archetype: 'worker' });
  assert.equal(worker.variant, null, 'the base lane, because nothing forbids a worker there');

  const director = resolveDelivery(parseDialRef('opus', 't'), profile, 'claude', { archetype: 'director' });
  assert.equal(director.variant, 'exec');
  const argv = director.spec.adapter === 'command'
    ? director.spec.command
    : (director.spec as { fallbackCommand: string[] | null }).fallbackCommand ?? [];
  // Asked of the predicate that actually reads this argv, not of a token that
  // happens to be in it: a director lane has to be able to run `fadeno`, and
  // `argvGrantsFadenoShell` is the one place that question is answered. Pinning
  // a literal here is what made this assertion a second, drifting copy of the
  // rule when the lane traded `--allowedTools Bash` for
  // `--dangerously-skip-permissions`.
  assert.ok(argvGrantsFadenoShell(argv), 'the exec variant can run fadeno');
  // And the ref the user typed is unchanged: the variant is not on the dial.
  assert.equal(formatDialRef(director.ref), 'opus');
});

test('the claude exec variant lifts `director` on an argv identical to the base lane', () => {
  // Since the base lane opened its shell (`--dangerously-skip-permissions`),
  // the variant grants nothing extra. It is the ELIGIBILITY carrier: the base
  // lane forbids
  // `director`, policy falls through, and the delivery gets the name `exec` in
  // the ledger row and run snapshot — the only thing that tells a director
  // dispatch apart from a worker dispatch that ran the identical command. If
  // this assertion ever has to be relaxed, the catalog comment must say why.
  const profile = starter('claude');
  const claude = profile.harnesses.claude!;
  assert.deepEqual(
    claude.variants!.exec!.command,
    claude.command!.command,
    'exec is the base argv, not an escalation of it',
  );

  const worker = resolveDelivery(parseDialRef('opus', 't'), profile, 'claude', { archetype: 'worker' });
  const director = resolveDelivery(parseDialRef('opus', 't'), profile, 'claude', { archetype: 'director' });
  assert.equal(worker.variant, null);
  assert.equal(director.variant, 'exec');
  // The lift is in the eligibility, and only there.
  assert.equal(eligibilityFor(worker.spec, 'director'), 'forbidden');
  assert.equal(eligibilityFor(director.spec, 'director'), 'eligible');
  const argvOf = (d: typeof worker) => (d.spec.adapter === 'command'
    ? d.spec.command
    : (d.spec as { fallbackCommand: string[] | null }).fallbackCommand ?? []);
  assert.deepEqual(argvOf(director), argvOf(worker), 'same substituted argv, different name');
});

test('the claude command lane carries the headless-approval flag every other vendor has', () => {
  // The claim this pins is the one the catalog's own comment makes: EVERY lane
  // carries its vendor's headless-approval flag, because an unresolved
  // permission request is DENIED by a headless run rather than left pending, so
  // anything short of blanket approval is a silent mid-assignment denial.
  //
  // Until 2026-09-06 this lane's flag was the pair `--permission-mode
  // acceptEdits --allowedTools Bash`, and this test pinned both tokens. That
  // pair auto-approved edits plus Bash and NOTHING else — the same partial
  // grant that cost the codex sandbox two Tokyo runs. The posture is now
  // blanket, so the assertion moves to the blanket flag AND adds the negative
  // the old spelling could not express: the restricting pair must not creep
  // back, because a lane that narrows while the docs still promise vendor-equal
  // headless trust is exactly the divergence `docs-claims` exists to catch.
  const claude = starter('claude').harnesses.claude!.command!.command;
  assert.ok(
    claude.includes('--dangerously-skip-permissions'),
    'the base claude lane carries Claude Code\'s headless-approval flag',
  );
  assert.ok(
    !claude.includes('--permission-mode') && !claude.includes('--allowedTools'),
    'and no partial grant beside it — a scoped rule is a denial waiting to happen',
  );
  // Read through the predicate too, so the argv and its only reader cannot
  // disagree about this lane.
  assert.ok(argvGrantsFadenoShell(claude), 'and it reads as fadeno-capable');
});

test('every shipped command lane carries a headless-approval flag and no restricting one', () => {
  // The posture note at the bottom of the catalog states this as a property of
  // the whole table, not of one lane, so assert it as one. Before 2026-09-06 it
  // was false of exactly one lane — codex, with `--sandbox workspace-write` —
  // and that is the lane whose restriction people actually hit.
  //
  // Each vendor spells the flag differently, so the table below is the list;
  // a NEW harness with a command lane must be added here deliberately, which is
  // the point. The restricting spellings are listed separately because catching
  // a re-narrowing is the half a positive-only assertion misses.
  const approvals: Record<string, string[]> = {
    claude: ['--dangerously-skip-permissions'],
    codex: ['--dangerously-bypass-approvals-and-sandbox'],
    grok: ['--always-approve'],
    agy: ['--dangerously-skip-permissions'],
    opencode: ['--auto'],
    muse: ['--trust-workspace', '--disable-approval', '--user-input-auto-resolve'],
  };
  const restricting = ['--permission-mode', '--allowedTools', '--disallowedTools', '--disable-shell'];
  const profile = starter('claude');
  for (const [harness, entry] of Object.entries(profile.harnesses)) {
    const lanes: Array<[string, string[]]> = [];
    if (entry.command) lanes.push([harness, entry.command.command]);
    for (const [name, variant] of Object.entries(entry.variants ?? {})) {
      if (variant.command) lanes.push([`${harness}/${name}`, variant.command]);
    }
    if (lanes.length === 0) continue;
    const expected = approvals[harness];
    assert.ok(expected, `${harness} ships a command lane but names no headless-approval flag here`);
    for (const [label, argv] of lanes) {
      for (const flag of expected!) {
        assert.ok(argv.includes(flag), `${label} lost its headless-approval flag ${flag}`);
      }
      for (const flag of restricting) {
        assert.ok(!argv.includes(flag), `${label} narrowed back with ${flag}`);
      }
      // `--sandbox read-only` is the other way to narrow; the permissive modes
      // are fine, which is why this reads the VALUE and not the flag.
      const sandbox = argv.indexOf('--sandbox');
      if (sandbox !== -1) {
        assert.notEqual(argv[sandbox + 1], 'read-only', `${label} narrowed back with a read-only sandbox`);
      }
    }
  }
});

// 4. Legacy read.

test('v4: a legacy ` via <driver>` is read, translated, and never written back', () => {
  assert.deepEqual(parseDialRef('sonnet via claude-exec', 't'), { model: 'sonnet', harness: 'claude' });
  assert.equal(formatDialRef(parseDialRef('sonnet via claude-exec', 't')), 'sonnet on claude');
  assert.deepEqual(parseDialRef('m@high via opencode-direct', 't'), { model: 'm', effort: 'high', harness: 'opencode' });
  assert.deepEqual(parseDialRef({ model: 'm', via: 'muse-code' }, 't'), { model: 'm', harness: 'muse' });
  // A driver name that was ALREADY a harness id passes through untouched.
  assert.deepEqual(parseDialRef('m via grok', 't'), { model: 'm', harness: 'grok' });
});

test('v4: a format 1.0 ledger row reads back with `driver` as the executor harness', async (t) => {
  const { runDispatches } = await import('../src/commands/dispatches.ts');
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  // Under 1.0 `harness` was the HOST and `driver` was the executor. Both rows
  // below describe the same delivery; only the spelling differs.
  const rows = [
    {
      format: '1.0', timestamp: '2026-08-12T12:00:00.000Z', event: 'dispatch_requested',
      dispatch_id: 'd1', archetype: 'worker', executor: 'opus', model: 'opus',
      harness: 'codex', driver: 'claude-exec', transport: 'command',
    },
    {
      format: '1.1', timestamp: '2026-08-12T12:01:00.000Z', event: 'dispatch_requested',
      dispatch_id: 'd2', archetype: 'worker', executor: 'opus', model: 'opus',
      host: 'codex', harness: 'claude', variant: 'exec', transport: 'command',
    },
  ];
  writeFileSync(join(root, '.fadeno', 'dispatches.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const result = runDispatches({ repoRoot: root });
  const [legacy, current] = result.entries;
  assert.equal(legacy!.harness, 'claude', 'a 1.0 `driver` reads as the executor harness');
  assert.equal(legacy!.host, 'codex', 'and its `harness` reads as the host');
  assert.equal(legacy!.variant, null, '1.0 could not record a variant');
  assert.equal(current!.harness, 'claude');
  assert.equal(current!.host, 'codex');
  assert.equal(current!.variant, 'exec');
});

// 5. v3 layers.

test('v4: a v3 layer with a removed key errors with the migration note; a models-only v3 layer loads', (t) => {
  const root = tempRepo(t);
  const paths: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state'), FADENO_HARNESS: 'standalone' },
  };
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const project = join(root, '.fadeno', 'executors.yaml');

  writeFileSync(project, stringifyYaml({
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'sol' } },
    routes: { standalone: { openai: { command: ['codex'] } } },
  }));
  assert.throws(
    () => loadLayeredProfile(root, paths),
    (err: unknown) => err instanceof ExecutorProfileError
      && /`routes` was removed in catalog v4/.test(err.message)
      && /harnesses:/.test(err.message)
      && err.message.startsWith(`${project}: `),
  );

  // A personal `models:`-only v3 catalog is not made wrong by the bump: it
  // declares nothing v4 removed, so it layers onto the builtin as before.
  writeFileSync(project, stringifyYaml({
    schema_version: 3,
    models: { mine: { provider: 'anthropic', id: 'mine' } },
  }));
  const layered = loadLayeredProfile(root, paths);
  assert.equal(layered.profile.models.mine?.id, 'mine');
  assert.equal(layered.profile.schemaVersion, 4, 'the merged document is always v4');
});

test('v4: `harnesses:` under schema_version 3 is refused, naming the version it needs', (t) => {
  const root = tempRepo(t);
  const paths: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state'), FADENO_HARNESS: 'standalone' },
  };
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'sol' } },
    harnesses: { codex: { provider: 'openai', command: ['codex'] } },
  }));
  assert.throws(
    () => loadLayeredProfile(root, paths),
    /`harnesses:` requires `schema_version: 4` \(found 3\)/,
  );
});

// 6. Snapshot compatibility.

test('v4: a committed v3 run snapshot still parses, unchanged', () => {
  // The acceptance the plan names. `snapshot_version` did NOT move: the
  // compiled executors map was already post-compile and harness-neutral, so a
  // snapshot written before v4 replays byte-for-byte. Only its passthrough
  // metadata key changed, and a stored `driver:` is read through the same
  // legacy name map a dial ref uses.
  const snapshot = [
    'snapshot_version: 3',
    'executors:',
    '  current-host:',
    '    adapter: host',
    '    model: current-host',
    '    reasoning_effort: default',
    '    agent_type: "*"',
    '    provider: current-host',
    '    driver: current-host',
    '  opus:',
    '    adapter: command',
    '    command: [claude, -p, --model, opus]',
    '    provider: anthropic',
    '    driver: claude-exec',
    '    model: opus',
    'archetypes:',
    '  worker: {}',
    '',
  ].join('\n');
  const parsed = parseSnapshotDocument(snapshot, 'profile.yaml (v3 fixture)');
  const opus = parsed.executors.opus!;
  assert.equal(opus.adapter, 'command');
  assert.equal(opus.harness, 'claude', 'a stored `driver` reads back as the harness it always named');
  assert.deepEqual((opus as { command: string[] }).command, ['claude', '-p', '--model', 'opus']);
});

// 7. A bare shell.

test('v4: from a bare shell nothing is a host lane, and eligibility never refuses a dial', (t) => {
  const root = tempRepo(t);
  const paths: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state'), FADENO_HARNESS: 'standalone' },
  };
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({
    models: {
      sol: { provider: 'openai', id: 'gpt-sol', effort: 'high' },
      gated: { provider: 'anthropic', id: 'gated', eligibility: { worker: 'forbidden' } },
    },
    archetypes: { worker: {}, scout: {} },
  }));

  // Registry-only validation: a forbidden pairing DIALS, and `dial resolve`
  // is where the refusal is reported.
  assert.doesNotThrow(() => runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'gated', session: true }));
  const forbidden = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'worker', env: {} });
  assert.equal(forbidden.host, 'standalone');
  assert.equal(forbidden.eligibility, 'forbidden');
  assert.equal(forbidden.delivery.dispatchable, false);

  // Every dial with a command lane resolves to it; the base dial has none.
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'scout', model: 'sol', session: true });
  const scout = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'scout', env: {} });
  assert.equal(scout.host, 'standalone');
  assert.equal(scout.lane, 'command');
  assert.equal(scout.harness, 'codex');
  assert.equal(scout.variant, null);

  const base = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'reviewer', env: {} });
  assert.equal(base.model, 'current-host');
  assert.equal(base.lane, 'restart_required', 'a bare shell has no session to deliver into');
});

// 8. Home-per-provider integrity.

function parseDoc(doc: Record<string, unknown>, host: HarnessId = 'standalone') {
  return parseExecutorProfile(stringifyYaml(doc), 'test.yaml', host);
}

test('v4: exactly one home per provider, and every model must reach some harness', () => {
  assert.throws(
    () => parseDoc({
      schema_version: 4,
      models: { sol: { provider: 'openai' } },
      harnesses: { codex: { provider: 'openai', command: ['codex'] }, other: { provider: 'openai', command: ['other'] } },
    }),
    /provider "openai" is claimed as home by two harnesses \(codex, other\)/,
  );
  assert.throws(
    () => parseDoc({
      schema_version: 4,
      models: { ghost: { provider: 'nowhere', id: 'ghost-1' } },
      harnesses: { codex: { provider: 'openai', command: ['codex'] } },
    }),
    /provider "nowhere", which no harness claims as home[\s\S]*fadeno model add ghost nowhere\/ghost-1/,
  );
  // An explicit `harness:` satisfies it without a home claim — that is what
  // makes OpenCode, home to nobody, still reachable.
  const ok = parseDoc({
    schema_version: 4,
    models: { ox: { provider: 'stealth', id: 'ox', harness: 'opencode', spellings: { opencode: 'stealth/ox' } } },
    harnesses: { opencode: { command: ['opencode', 'run', '-m', '{model}'] } },
  });
  assert.equal(resolveDelivery({ model: 'ox' }, ok).modelId, 'stealth/ox');
  // A spelling for a harness the table does not declare is a load error too:
  // silently ignoring it would deliver the canonical id to a backend that
  // never agreed to interpret it.
  assert.throws(
    () => parseDoc({
      schema_version: 4,
      models: { ox: { provider: 'stealth', id: 'ox', harness: 'opencode', spellings: { nope: 'x' } } },
      harnesses: { opencode: { command: ['opencode'] } },
    }),
    /declares a spelling for harness "nope", which is not declared/,
  );
});

// --- User-layer models: dropped, never fatal -------------------------------

/**
 * The regression this revision exists for.
 *
 * A user catalog is machine state, not catalog policy. Under v3 a personal
 * alias whose delivery resolved nowhere was DROPPED with a note; the v4 plan
 * made "no home for provider" a load error, and on 2026-09-05 a single stale
 * `fadeno model add` (`ox`, provider `stealth`, registered before v4) made
 * every unrelated `fadeno dial` in every repo fail at parse — the user's
 * installed CLI included. A project- or builtin-declared model that cannot be
 * delivered is a different thing: a file someone edits, and still a load
 * error.
 */
function isolated(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'cfg'),
      FADENO_STATE_HOME: join(root, 'state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

function seedUserCatalog(root: string, paths: UserPathOptions, models: Record<string, unknown>): void {
  const file = userPaths(paths).executorsFile;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, stringifyYaml({ schema_version: 4, models }));
}

test('regression: an undeliverable USER model is dropped with a note, not a load error', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  // Exactly the shipped shape: a v3 models-only user catalog naming a provider
  // no harness claims, layering onto the builtin with no project catalog.
  const file = userPaths(paths).executorsFile;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'schema_version: 3\nmodels:\n  ox:\n    provider: stealth\n    id: ox-alpha\n    effort: default\n');

  const layered = loadLayeredProfile(root, paths);
  assert.equal(layered.selfContained, false, 'normal layering, not the self-contained carve-out');
  assert.deepEqual(layered.modelFallback.dropped, [{ alias: 'ox', harness: 'stealth' }]);
  assert.equal(Object.hasOwn(layered.profile.models, 'ox'), false, 'dropped means NOT registered');
  // Every unrelated dial still works — the whole point.
  const resolved = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'worker', env: {} });
  assert.equal(resolved.model, 'current-host');
  // And the user is told, once, on the surface that lists models.
  assert.match(runDialShow({ repoRoot: root, userPathOptions: paths }).note ?? '', /user-catalog model "ox" dropped/);
});

test('regression: the same drop happens in the user-scope global view', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  seedUserCatalog(root, paths, { ox: { provider: 'stealth', id: 'ox-alpha' } });
  const global = loadGlobalProfile(paths);
  assert.deepEqual(global.modelFallback.dropped, [{ alias: 'ox', harness: 'stealth' }]);
  assert.equal(Object.hasOwn(global.profile.models, 'ox'), false);
  // `fadeno model add` reads this view to reserve alias names, so it must not
  // throw here either.
  assert.doesNotThrow(() => loadGlobalProfile(paths));
});

test('regression: dialing the dropped alias itself still fails loudly, naming the fix', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  seedUserCatalog(root, paths, { ox: { provider: 'stealth', id: 'ox-alpha' } });
  // Dropped is not silently-eligible: `ox` is now an UNREGISTERED name, so it
  // falls through to the unregistered harness with its id passed verbatim —
  // and the dial-time probe, which the drop does not bypass, refuses it by
  // name. (Stubbed listing: the real one would reach the network.)
  assert.throws(
    () => runDialSet({
      repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'ox', session: true,
      spawn: () => ({ status: 0, stdout: 'openrouter/anthropic/claude-opus-4.8\n', stderr: '' }),
    }),
    (err: unknown) => err instanceof Error && /unknown model "ox"/.test(err.message),
  );
  // And an explicit harness nothing declares is a hard refusal either way.
  assert.throws(
    () => runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'ox', harness: 'stealth', session: true }),
    (err: unknown) => err instanceof Error && /unknown harness "stealth"/.test(err.message),
  );
});

test('regression: a PROJECT-declared undeliverable model is still a load error', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { ghost: { provider: 'nowhere', id: 'ghost-1' } },
    harnesses: { codex: { provider: 'openai', command: ['codex'] } },
  }));
  // A file someone edits, not machine state: it must not be papered over.
  assert.throws(
    () => loadLayeredProfile(root, paths),
    (err: unknown) => err instanceof ExecutorProfileError
      && /provider "nowhere", which no harness claims as home/.test(err.message)
      && /fadeno model add ghost nowhere\/ghost-1/.test(err.message),
  );
});

// --- Host-slot decisions: hostCandidate, not spec.adapter ------------------

/**
 * The reviewer's repro, executable.
 *
 * `spec.adapter === 'host'` is not "can be delivered in-session": a host spec
 * is also how a delivery with NO argv is represented. Keyed on it,
 * `steering apply --codex` wrote a Codex host agent — `model = "opus"`,
 * `--host-executor 'opus on omp'` — for a dial that `dial resolve` was calling
 * `restart_required`, and `dispatch` prefixed its refusal with "spawn the
 * in-session agent and you are done".
 */
test('a dial on a host-only harness nobody is in materializes a BROKER, not a host agent', (t) => {
  const root = tempRepo(t);
  const paths: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state'), FADENO_HARNESS: 'codex' },
  };
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({
    models: { opus: { provider: 'anthropic', id: 'opus', effort: 'xhigh' } },
    harnesses: {
      codex: { provider: 'openai', host: { effort_channel: 'agent-file', relay: 'relaymodel' }, command: ['codex', 'exec'] },
      omp: { provider: 'anthropic', host: { effort_channel: 'none' } },
    },
    archetypes: { worker: {} },
    extra: { models: { opus: { provider: 'anthropic', id: 'opus', effort: 'xhigh' }, relaymodel: { provider: 'openai', id: 'relay-1' } } },
  }));
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'opus', harness: 'omp', session: true });

  const resolved = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'worker', env: {} });
  assert.equal(resolved.harness, 'omp');
  assert.equal(resolved.host, 'codex');
  assert.equal(resolved.lane, 'restart_required', 'omp is a host this session is not inside, with no command to spawn');
  assert.equal(resolved.delivery.dispatchable, false);

  const applied = runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: paths });
  assert.equal(applied.materialization.worker?.kind, 'command-broker', 'never a Codex host agent for an omp dial');
  const toml = readFileSync(join(root, '.codex', 'agents', 'worker.toml'), 'utf8');
  assert.doesNotMatch(toml, /--host-executor/, 'a broker bakes no host identity');
  assert.doesNotMatch(toml, /model = "opus"/, 'and never the dialed model');
});

test('dispatch\'s host-lane note agrees with dial resolve on the no-argv shapes', (t) => {
  const root = tempRepo(t);
  const paths: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state'), FADENO_HARNESS: 'standalone' },
  };
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({ archetypes: { worker: {} } }));
  // Undialed from a bare shell → `current-host`, which has no session to
  // deliver into and no argv to spawn.
  const resolved = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'reviewer', env: {} });
  assert.equal(resolved.lane, 'restart_required');
  let refusal = '';
  try {
    runDispatch({ archetype: 'reviewer', prompt: 'go', repoRoot: root, userPathOptions: paths });
  } catch (err) {
    refusal = (err as Error).message;
  }
  assert.match(refusal, /declares no fallback_command/);
  assert.doesNotMatch(refusal, /resolves to the HOST lane here/, 'the note must not claim a lane dial resolve denies');
});

// --- Snapshots carry the policy-chosen variant -----------------------------

test('a run snapshot carries the archetype-specific lane, so drive and dispatch agree', (t) => {
  const root = tempRepo(t);
  const profile = starter('claude');
  const snapshot = parseSnapshotDocument(serializeSnapshot(profile), 'profile.yaml');
  // The base entry is the plain claude lane; the director entry is the exec
  // variant. Keyed by ref alone, `drive` refused `director opus` on
  // eligibility while `dispatch` delivered it.
  const base = snapshot.executors.opus!;
  assert.equal(base.variant, undefined);
  const director = snapshotExecutor(snapshot, 'opus', 'director')!;
  assert.notEqual(director, base);
  assert.equal(director.variant, 'exec');
  assert.equal(eligibilityFor(director, 'director'), 'eligible');
  assert.equal(eligibilityFor(base, 'director'), 'forbidden');
  const argv = director.adapter === 'command'
    ? director.command
    : (director as { fallbackCommand: string[] | null }).fallbackCommand ?? [];
  // Through the predicate, not a token: the snapshot has to carry a lane that
  // can really run `fadeno`, and which token proves that changed on 2026-09-06.
  assert.ok(argvGrantsFadenoShell(argv));
  // Additive: a lookup with no archetype, or for an archetype policy does not
  // move, lands on the plain ref — which is what an older snapshot has.
  assert.equal(snapshotExecutor(snapshot, 'opus', null), base);
  assert.equal(snapshotExecutor(snapshot, 'opus', 'worker'), base);
  void root;
});

test('host.identity: session delivers only the session\'s own identity', () => {
  for (const host of ['opencode', 'omp'] as const) {
    const profile = starter(host);
    assert.equal(profile.harnesses[host]?.host?.identity, 'session', host);

    // The session's own identity IS host-deliverable.
    const base = resolveDelivery({ model: 'current-host' }, profile, host, { archetype: 'worker' });
    assert.equal(base.hostCandidate, true, `${host}: current-host is the session`);

    // A named model on that same harness is not.
    const named = resolveDelivery(parseDialRef(`opus on ${host}`, 't'), profile, host, { archetype: 'worker' });
    assert.equal(named.harness, host, host);
    assert.equal(named.hostCandidate, false, `${host}: a named model cannot reach the host lane`);
    // opencode can still spawn it; omp declares no command at all.
    assert.equal(named.spec.adapter, host === 'opencode' ? 'command' : 'host', host);
  }
  // The default is `model`, and Codex/Claude keep it: those adapters DO apply
  // a dialed model (the Codex agent TOML bakes it; the Claude hook rewrites
  // the tool call).
  const codex = starter('codex');
  assert.equal(codex.harnesses.codex?.host?.identity, 'model');
  assert.equal(resolveDelivery({ model: 'luna' }, codex, 'codex', { archetype: 'worker' }).hostCandidate, true);
});

test('harness-level eligibility gates the host lane too, unless host.eligibility says otherwise', () => {
  // A v3 route `{ host: true, command, eligibility }` gated BOTH lanes with one
  // map. Splitting it into `host:` + `command:` must not drop half of that.
  const doc = (extra: Record<string, unknown>) => parseExecutorProfile(stringifyYaml({
    schema_version: 4,
    models: { m: { provider: 'p', id: 'm' } },
    harnesses: { h: { provider: 'p', host: { effort_channel: 'none', ...extra }, command: ['run'], eligibility: { director: 'forbidden' } } },
    archetypes: { director: {} },
  }), 'test.yaml', 'h' as HarnessId);

  const inherited = resolveDelivery({ model: 'm' }, doc({}), 'h' as HarnessId, { archetype: 'director' });
  assert.equal(inherited.hostCandidate, false, 'harness-level eligibility reaches the host lane');

  const overridden = resolveDelivery({ model: 'm' }, doc({ eligibility: { director: 'eligible' } }), 'h' as HarnessId, { archetype: 'director' });
  assert.equal(overridden.hostCandidate, true, 'host.eligibility states its own answer and wins');
});

test('eligibility with no command lane, and a `standalone` harness, are refused at load', () => {
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({
      schema_version: 4,
      models: { m: { provider: 'p', id: 'm' } },
      harnesses: { h: { provider: 'p', host: { effort_channel: 'none' }, eligibility: { director: 'forbidden' } } },
    }), 'test.yaml'),
    /declares `eligibility:` with no `command:`[\s\S]*Move it to `.*\.host\.eligibility`/,
  );
  assert.throws(
    () => parseExecutorProfile(stringifyYaml({
      schema_version: 4,
      models: { m: { provider: 'p', id: 'm' } },
      harnesses: { p: { provider: 'p', command: ['run'] }, standalone: { host: { effort_channel: 'none' } } },
    }), 'test.yaml'),
    /`harnesses\.standalone` is not a harness/,
  );
});

test('a bare shell reports harness: null for current-host, not a name that is not in the table', (t) => {
  const root = tempRepo(t);
  const paths: UserPathOptions = {
    home: join(root, 'home'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg'), FADENO_STATE_HOME: join(root, 'state'), FADENO_HARNESS: 'standalone' },
  };
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), catalogV4({ archetypes: { worker: {} } }));
  const resolved = runDialResolve({ repoRoot: root, userPathOptions: paths, archetype: 'reviewer', env: {} });
  assert.equal(resolved.model, 'current-host');
  assert.equal(resolved.host, 'standalone');
  assert.equal(resolved.harness, null, '`standalone` is the NO-host value, not a harness to look up');
});

test('user layer: a v3 `delivery: {route, id}` is translated, not refused', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  writeUserCatalog(paths, stringifyYaml({
    schema_version: 3,
    models: { ox: { provider: 'anthropic', id: 'ox-alpha', delivery: { route: 'opencode-direct', id: 'openrouter/ox' } } },
  }));
  const layered = loadLayeredProfile(root, paths);
  const ox = layered.profile.models['ox'];
  assert.ok(ox, 'the alias survives the translation');
  // The driver alias maps to its harness, and the delivery id becomes that
  // harness's spelling — the two halves `delivery:` used to carry.
  assert.equal(ox.harness, 'opencode');
  assert.equal(ox.spellings['opencode'], 'openrouter/ox');
  assert.match(layered.modelFallback.repairs.join('\n'), /model "ox" `delivery:` read as `harness: opencode`/);
  // Nothing was dropped, so the note must not call it a drop.
  assert.deepEqual(layered.modelFallback.dropped, []);
});

test('user layer: the `openrouter` route key a v3 `model add` wrote lands on opencode, not on a ghost harness', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  // Exactly the entry v3 runModelsAdd wrote for its OpenRouter step.
  writeUserCatalog(paths, stringifyYaml({
    schema_version: 3,
    models: { o3: { provider: 'openai', id: 'o3-pro', effort: 'high', delivery: { route: 'openrouter', id: 'openai/o3-pro' } } },
  }));
  const layered = loadLayeredProfile(root, paths);
  const o3 = layered.profile.models['o3'];
  assert.ok(o3, 'a route key is a route key, not a driver alias — the alias must survive');
  assert.equal(o3.harness, 'opencode');
  assert.equal(o3.spellings['opencode'], 'openai/o3-pro');
  assert.deepEqual(layered.modelFallback.dropped, []);
  const notes = layered.modelFallback.repairs.join('\n');
  assert.match(notes, /model "o3" `delivery:` read as `harness: opencode`/);
  assert.doesNotMatch(notes, /harness: openrouter|dropped/);
});

test('user layer: a translated `unregistered_model_driver` gets one note, not a second one calling it ignored', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  writeUserCatalog(paths, stringifyYaml({ schema_version: 3, models: {}, unregistered_model_driver: 'opencode' }));
  const layered = loadLayeredProfile(root, paths);
  const mentions = layered.modelFallback.repairs.filter((line) => line.includes('unregistered_model_driver'));
  assert.equal(mentions.length, 1, mentions.join('\n'));
  assert.match(mentions[0]!, /read as `unregistered_model_harness: opencode`/);
  assert.doesNotMatch(mentions[0]!, /ignored/);
});

test('user layer: a spelling naming an undeclared harness is dropped, not thrown', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  writeUserCatalog(paths, stringifyYaml({
    schema_version: 4,
    models: { ox: { provider: 'anthropic', id: 'ox-alpha', spellings: { opencode: 'openrouter/ox', ghostharness: 'nope/ox' } } },
  }));
  const layered = loadLayeredProfile(root, paths);
  const ox = layered.profile.models['ox'];
  assert.ok(ox, 'the model survives; only the unusable spelling goes');
  assert.equal(ox.spellings['opencode'], 'openrouter/ox', 'the good spelling is untouched');
  assert.equal(Object.hasOwn(ox.spellings, 'ghostharness'), false);
  assert.match(layered.modelFallback.repairs.join('\n'), /spelling for harness "ghostharness" dropped/);
});

test('user layer: a ` via <driver>` in `bindings:` reads as ` on <harness>`', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  writeUserCatalog(paths, stringifyYaml({
    schema_version: 3,
    models: { ox: { provider: 'anthropic', id: 'ox-alpha' } },
    bindings: { lead: 'opus via opencode-direct' },
  }));
  const layered = loadLayeredProfile(root, paths);
  assert.deepEqual(layered.profile.bindings['lead'], { model: 'opus', harness: 'opencode' });
  assert.match(layered.modelFallback.repairs.join('\n'), /`bindings.lead` read as "opus on opencode"/);
});

test('user layer: the original `ox` shape still drops, and says so on the dial surface', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  // Verbatim the file that broke: schema_version 3, one models entry, a
  // provider no harness claims as home, no `harness:` to name instead.
  writeUserCatalog(paths, 'schema_version: 3\nmodels:\n  ox:\n    provider: stealth\n    id: ox-alpha\n    effort: default\n');
  const layered = loadLayeredProfile(root, paths);
  assert.deepEqual(layered.modelFallback.dropped, [{ alias: 'ox', harness: 'stealth' }]);
  assert.match(runDialShow({ repoRoot: root, userPathOptions: paths }).note ?? '', /user-catalog model "ox" dropped/);
});

test('user layer: none of those shapes can reach a parse throw', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  // Every legacy and malformed model shape at once, in one file, plus the
  // top-level tables v4 removed. The load must succeed and account for all of
  // it — the property the three tests above each check one slice of.
  writeUserCatalog(paths, stringifyYaml({
    schema_version: 3,
    routes: { claude: { anthropic: { host: true } } },
    relay: { claude: 'sonnet' },
    unregistered_model_driver: 'opencode-direct',
    models: {
      legacy: { provider: 'anthropic', id: 'legacy-1', delivery: { route: 'claude-exec', id: 'legacy-x' } },
      broken_delivery: { provider: 'anthropic', delivery: { route: 42 } },
      noprovider: { id: 'nope' },
      'Not-An-Identifier': { provider: 'anthropic' },
      badkeys: { provider: 'anthropic', id: 'bk', made_up_key: true, eligibility: { worker: 'sideways' } },
      notamapping: 'just a string',
    },
    bindings: { lead: { model: 'opus', via: 'muse-code' } },
  }));
  const layered = loadLayeredProfile(root, paths);
  const models = layered.profile.models;
  assert.equal(models['legacy']?.harness, 'claude');
  assert.equal(models['legacy']?.spellings['claude'], 'legacy-x');
  assert.equal(models['badkeys']?.provider, 'anthropic', 'unknown keys and bad eligibility are stripped, not fatal');
  assert.deepEqual(models['badkeys']?.eligibility, {});
  for (const gone of ['broken_delivery', 'noprovider', 'Not-An-Identifier', 'notamapping']) {
    assert.equal(Object.hasOwn(models, gone), false, `${gone} must be dropped, not loaded`);
  }
  assert.deepEqual(layered.profile.bindings['lead'], { model: 'opus', harness: 'muse' });
  assert.equal(layered.profile.unregisteredModelHarness, 'opencode');
  const repairs = layered.modelFallback.repairs.join('\n');
  assert.match(repairs, /`routes` was removed in catalog v4/);
  assert.match(repairs, /`relay` was removed in catalog v4/);
  assert.match(repairs, /`unregistered_model_driver` read as `unregistered_model_harness: opencode`/);
});

test('user layer: a project catalog with the same v3 `delivery:` is still a load error', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { ox: { provider: 'openai', id: 'ox-alpha', delivery: { route: 'codex', id: 'ox-x' } } },
    harnesses: { codex: { provider: 'openai', command: ['codex'] } },
  }));
  // The asymmetry is the whole design: a file someone edits gets the migration
  // note naming the key and its v4 spelling.
  assert.throws(
    () => loadLayeredProfile(root, paths),
    (err: unknown) => err instanceof ExecutorProfileError
      && /`delivery` was removed in catalog v4/.test(err.message)
      && /models\.ox\.harness/.test(err.message),
  );
});

test('user layer: an override that would break a lower-layer model restores it and names the collision', (t) => {
  const root = tempRepo(t);
  const paths = isolated(root);
  // `opus` exists in the builtin catalog. A personal override of it that
  // points at nothing must not take the builtin `opus` down with it — the
  // whole catalog would lose a name over one stale personal edit.
  writeUserCatalog(paths, stringifyYaml({
    schema_version: 4,
    models: { opus: { provider: 'anthropic', id: 'opus', harness: 'ghostharness' } },
  }));
  const layered = loadLayeredProfile(root, paths);
  const opus = layered.profile.models['opus'];
  assert.ok(opus, 'the builtin entry is restored, not deleted with the override');
  assert.equal(opus.harness, undefined, 'restored means the LOWER layer\'s entry, not a merged one');
  assert.equal(layered.modelFallback.dropped.length, 0, 'a restored name is not a dropped one');
  assert.match(
    layered.modelFallback.repairs.join('\n'),
    /user-catalog override of model "opus" discarded — nothing in this catalog can deliver harness\/provider "ghostharness"/,
  );
  // And the name still resolves.
  assert.doesNotThrow(() => resolveDelivery(parseDialRef('opus', 't'), layered.profile, 'claude', { archetype: 'worker' }));
});

// --- The sixth materialization site, and the reads around it ---------------

/**
 * `steering apply --opencode` was the last of the six sites still branching on
 * `spec.adapter`, and it fails the same way `--codex` did: a dial on a
 * host-only harness nobody is in compiles to a host spec with no argv, so the
 * apply wrote `<archetype>.md` — an IN-SESSION OpenCode role slot naming a
 * model OpenCode was never going to be handed.
 */
test('opencode apply routes a host-only-elsewhere dial to a broker, not a role slot', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'opencode', repoRoot: root });
  // The shipped catalog: `omp` is host-only, and this apply resolves against
  // the `opencode` host — so `opus on omp` has no lane here at all.
  writeLocalDialState(root, { dials: { worker: { model: 'opus', harness: 'omp' } }, shadows: {}, legacyNote: null });
  const applied = runSteeringApplyOpenCode({ repoRoot: root, force: true });
  assert.equal(applied.materialization.worker?.kind, 'command-broker');
  assert.equal(existsSync(join(root, '.opencode', 'agent', 'fadeno-dispatch-worker.md')), true);
  assert.equal(existsSync(join(root, '.opencode', 'agent', 'worker.md')), false, 'no in-session slot for a model this host cannot deliver');

  // The control: the session's own identity still materializes in-session, so
  // the fix is `hostCandidate`, not "always broker".
  writeLocalDialState(root, { dials: { worker: { model: 'current-host' } }, shadows: {}, legacyNote: null });
  const native = runSteeringApplyOpenCode({ repoRoot: root, force: true });
  assert.equal(native.materialization.worker?.kind, 'host');
  assert.equal(existsSync(join(root, '.opencode', 'agent', 'worker.md')), true);
  assert.equal(existsSync(join(root, '.opencode', 'agent', 'fadeno-dispatch-worker.md')), false, 'the stale broker is removed');
});

/**
 * `--bind` names a DIAL REF, and the run may have frozen an archetype-specific
 * answer for it. Reading the plain ref handed the bound role the base lane —
 * the one the unbound path had already rejected on eligibility — so binding a
 * role to the executor it already resolved to CHANGED its delivery.
 */

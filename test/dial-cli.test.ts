import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  offHostLanes,
  DialError,
  formatShadowLine,
  runDialResolve,
  runDialSet,
  runDialShadow,
  runDialShow,
  sessionEffort,
} from '../src/commands/dial.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { DIALS_LOCAL_FILE } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

// Isolated per-repo user state: these tests must never read the developer's
// real user dials (a non-empty real user layer flips `base` rows to `user`).
const isolated = (root: string): UserPathOptions => ({
  home: join(root, 'home'),
  env: {
    FADENO_CONFIG_HOME: join(root, 'user-config'),
    FADENO_STATE_HOME: join(root, 'user-state'),
    FADENO_HARNESS: 'standalone',
  },
});

function seedCatalog(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 4,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      terra: { provider: 'openai', id: 'terra-model', effort: 'medium' },
    },
    harnesses: { codex: { provider: 'openai', command: ['node', '-e', '0'] }, grok: { provider: 'xai', command: ['node', '-e', '0'] } },
    archetypes: {
      worker: { },
      reviewer: { },
      judge: { },
    },
    ...extra,
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
  return root;
}

test('dial show: effective table with triad and source base', (t) => {
  const root = seedCatalog(t);
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.equal(result.host, 'standalone');
  // All three triad rows present with base source
  const workers = result.rows.find((r) => r.archetype === 'worker');
  assert.ok(workers);
  assert.equal(workers!.source, 'base');
  assert.equal(workers!.model, 'current-host');
  assert.equal(result.legacy_pin_note, null);
  assert.ok(Array.isArray(result.suppressed_canon_archetypes));
  // snake_case fields present
  const json = JSON.stringify(result);
  assert.match(json, /"legacy_pin_note"/);
  assert.match(json, /"suppressed_canon_archetypes"/);
});

test('dial show: rows follow the canon power order, extras alphabetical after', (t) => {
  const root = seedCatalog(t, {
    archetypes: {
      worker: { },
      reviewer: { },
      judge: { },
      director: { },
      generator: { },
      scout: {},
    },
  });
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.deepEqual(
    result.rows.map((r) => r.archetype),
    ['director', 'judge', 'reviewer', 'generator', 'worker', 'scout'],
  );
});

test('dial show: legacy pin note surfaces', (t) => {
  const root = seedCatalog(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), 'anthropic-primary\n', 'utf8');
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.match(result.legacy_pin_note ?? '', /pre-0\.6 loadout pin ignored/);
  // Rows still render base
  assert.ok(result.rows.length > 0);
});

test('dial resolve: hook fields stable', (t) => {
  const root = seedCatalog(t);
  const result = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: isolated(root) });
  assert.equal(result.archetype, 'worker');
  assert.equal(result.model, 'current-host');
  assert.equal(result.adapter, 'host');
  assert.equal(result.source, 'base');
  assert.ok('executor' in result);
  assert.ok('model_id' in result);
  assert.ok('harness' in result);
  assert.ok('host' in result);
  assert.ok('variant' in result);
  assert.ok(!('driver' in result), 'the driver vocabulary is gone, not deprecated');
  assert.ok('delivery' in result);
  assert.equal(typeof result.delivery.dispatchable, 'boolean');
  assert.equal(typeof result.delivery.action, 'string');
  // Keys exact
  const keys = Object.keys(result);
  assert.ok(keys.includes('executor'));
  assert.ok(keys.includes('model'));
  assert.ok(!keys.includes('active')); // active is gone
});

test('dial show: luna stays on codex while adapter selection follows the caller', (t) => {
  const root = tempRepo(t);
  const rows = new Map<string, ReturnType<typeof runDialShow>['rows'][number]>();
  for (const harness of ['codex', 'claude', 'grok', 'standalone']) {
    const userPathOptions: UserPathOptions = {
      home: join(root, `home-${harness}`),
      env: {
        FADENO_CONFIG_HOME: join(root, `config-${harness}`),
        FADENO_STATE_HOME: join(root, `state-${harness}`),
        FADENO_HARNESS: harness,
      },
    };
    runDialSet({ repoRoot: root, userPathOptions, archetype: 'reviewer', model: 'luna', user: true });
    rows.set(harness, runDialShow({ repoRoot: root, userPathOptions }).rows.find((row) => row.archetype === 'reviewer')!);
  }
  for (const row of rows.values()) {
    // `harness`, the EXECUTOR — printed as the `harness` column. Not `host`,
    // which means the agent asking and is what the loop above varies. Under
    // v4 those are two keys with two names; they used to be one word.
    assert.equal(row.harness, 'codex');
    assert.equal(row.harness_explicit, false, 'no `--harness` was given; this is the model\'s home');
  }
  assert.equal(rows.get('codex')!.adapter, 'host');
  assert.equal(rows.get('claude')!.adapter, 'command');
  assert.equal(rows.get('grok')!.adapter, 'command');
  assert.equal(rows.get('standalone')!.adapter, 'command');
});

test('dial CLI: --session creates a local dial and a later unscoped set updates it', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  const env = { ...process.env, ...paths.env, HOME: paths.home! };
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  })) as Record<string, any>;

  const created = run(['dial', 'judge', 'grok', '--session']);
  assert.equal(created.layer, 'session');
  const updated = run(['dial', 'judge', 'sol']);
  assert.equal(updated.layer, 'session');
  assert.equal(updated.adaptive, true);

  const shown = run(['dial']);
  assert.equal(shown.dials.session.judge.model, 'sol');
  assert.equal(shown.dials.user.judge, undefined);
  assert.equal(shown.rows.find((row: Record<string, unknown>) => row.archetype === 'judge')?.model, 'sol');
});

// ---- Pinned vs unpinned effort ----

test('dial show: a registry default never renders as a pin', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  // `sol` declares effort: high in the registry. Three dials on the same
  // model: no opinion, a pin that differs from the default, and a pin that
  // happens to equal it — the third is the one the old rendering erased.
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'sol', session: true });
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'reviewer', model: 'sol@low', session: true });
  runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'judge', model: 'sol@high', session: true });
  const rows = runDialShow({ repoRoot: root, userPathOptions: paths }).rows;
  const row = (archetype: string) => rows.find((r) => r.archetype === archetype)!;

  assert.equal(row('worker').pinned_effort, null);
  assert.equal(row('worker').effective_effort, 'high');
  assert.equal(row('worker').modelDisplay, 'sol');
  assert.equal(row('reviewer').pinned_effort, 'low');
  assert.equal(row('reviewer').effective_effort, 'low');
  assert.equal(row('reviewer').modelDisplay, 'sol @ low');
  assert.equal(row('judge').pinned_effort, 'high');
  assert.equal(row('judge').effective_effort, 'high');
  assert.equal(row('judge').modelDisplay, 'sol @ high');

  // The legacy `effort` field keeps its old meaning for scripts reading it.
  assert.equal(row('worker').effort, 'high');
  assert.equal(row('judge').effort, 'high');
});

test('dial set/resolve JSON carries the pin separately from the resolved effort', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  const unpinned = runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'sol', session: true });
  assert.equal(unpinned.pinned_effort, null);
  assert.equal(unpinned.effective_effort, 'high');
  assert.equal(unpinned.effort, 'high');
  const resolvedUnpinned = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: paths });
  assert.equal(resolvedUnpinned.pinned_effort, null);
  assert.equal(resolvedUnpinned.effective_effort, 'high');

  const pinned = runDialSet({ repoRoot: root, userPathOptions: paths, archetype: 'worker', model: 'sol@low', session: true });
  assert.equal(pinned.pinned_effort, 'low');
  assert.equal(pinned.effective_effort, 'low');
  const resolvedPinned = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: paths });
  assert.equal(resolvedPinned.pinned_effort, 'low');
  assert.equal(resolvedPinned.effective_effort, 'low');
});

test('dial shadow: the attachment line shows a pin and only a pin', (t) => {
  // Both primaries dialed onto a command-capable harness: an undialed
  // archetype falls through to `current-host`, which in a bare shell can carry
  // no pair at all, and an explicit attach onto it is refused (see
  // test/dial-set.test.ts). This test is about the rendered line.
  const root = seedCatalog(t, { dials: { reviewer: 'sol', judge: 'sol' } });
  const paths = isolated(root);
  const unpinned = runDialShadow({ repoRoot: root, userPathOptions: paths, archetype: 'reviewer', model: 'grok' });
  assert.equal(unpinned.pinned_effort, null);
  assert.equal(unpinned.effective_effort, 'high');
  assert.equal(
    formatShadowLine(unpinned.shadow_attachments.reviewer!, ''),
    '  ~ shadow: grok [command]',
  );
  const pinned = runDialShadow({ repoRoot: root, userPathOptions: paths, archetype: 'judge', model: 'grok@low' });
  assert.equal(pinned.pinned_effort, 'low');
  assert.equal(
    formatShadowLine(pinned.shadow_attachments.judge!, ''),
    '  ~ shadow: grok @ low [command]',
  );
});

test('sessionEffort reads the harness channel, never a resolved default', () => {
  assert.equal(sessionEffort({}), null);
  assert.equal(sessionEffort({ CLAUDE_EFFORT: '' }), null);
  assert.equal(sessionEffort({ CLAUDE_EFFORT: '  ' }), null);
  assert.equal(sessionEffort({ CLAUDE_EFFORT: ' xhigh ' }), 'xhigh');
});

test('offHostLanes: only a pin that differs from the session leaves it', (t) => {
  // Inside a HOST, because under v4 that is what makes `current-host` a host
  // lane at all: it names whatever session is running, and a bare shell is not
  // one. The `standalone` case is its own assertion at the bottom.
  const root = seedCatalog(t, {
    harnesses: {
      codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: ['node', '-e', '0'] },
      grok: { provider: 'xai', command: ['node', '-e', '0'] },
    },
  });
  const inHost: UserPathOptions = {
    home: join(root, 'home-codex'),
    env: { FADENO_CONFIG_HOME: join(root, 'cfg-codex'), FADENO_STATE_HOME: join(root, 'state-codex'), FADENO_HARNESS: 'codex' },
  };
  const shape = (refs: Array<string | null>, session: string | null, paths: UserPathOptions = inHost) =>
    offHostLanes(refs, session, { repoRoot: root, userPathOptions: paths })
      .map((d) => (d == null ? null : [d.lane, d.lane_reason]));

  // The implementation trap: an unpinned host dial resolves to a registry
  // default, and must NOT be read as an opinion that leaves the session.
  assert.deepEqual(shape(['current-host'], 'medium'), [null]);
  assert.deepEqual(shape(['current-host@xhigh'], 'xhigh'), [null]);
  // A pin the session cannot serve leaves it. `current-host` declares no
  // command fallback — the base dial is the session, and there is no argv for
  // "the session" — so there is nowhere to go and the honest answer is
  // restart_required, NOT `command`, which would name a lane that does not
  // exist.
  assert.deepEqual(shape(['current-host@xhigh'], 'medium'), [['restart_required', 'no command fallback']]);
  // Unmeasurable session effort is the absence of proof, and a pin loses on
  // it: we cannot show the host lane delivers xhigh, so we do not claim it.
  assert.deepEqual(shape(['current-host@xhigh'], null), [['restart_required', 'no command fallback']]);
  // A command executor is already off-session for reasons that are not
  // effort, so it is suppressed rather than mislabeled. `grok` is not this
  // session's harness, so it was never a host candidate.
  assert.deepEqual(shape(['grok@low'], 'medium'), [null]);
  // Unresolved roles and unknown harnesses stay silent, positionally aligned.
  assert.deepEqual(
    shape([null, 'current-host@xhigh', 'nope@low:no-such-harness'], 'medium'),
    [null, ['restart_required', 'no command fallback'], null],
  );

  // From a bare shell there is no session to deliver in, so even an UNPINNED
  // `current-host` goes nowhere — and that is never suppressed, because
  // `restart_required` is the one answer a reader cannot infer from the rest
  // of the line.
  const bare = isolated(root);
  assert.deepEqual(shape(['current-host'], 'medium', bare), [['restart_required', 'no command fallback']]);
});

test('dial CLI: the effort column shows the pin, and `inherit` where there is none', (t) => {
  const root = seedCatalog(t);
  const paths = isolated(root);
  const env = { ...process.env, ...paths.env, HOME: paths.home! };
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  run(['dial', 'worker', 'sol', '--session']);
  run(['dial', 'reviewer', 'sol@low', '--session']);
  const table = run(['dial']);
  const rowFor = (archetype: string) => table.split('\n').find((line) => line.startsWith(archetype))!;
  assert.match(rowFor('worker'), /sol\s+inherit\s/);
  assert.match(rowFor('reviewer'), /sol @ low\s+low\s/);
  // The single-archetype view is the same renderer, so it must agree.
  assert.match(rowFor('worker'), /sol\s+inherit\s/);
  assert.match(run(['dial', 'worker']), /sol\s+inherit\s/);
});


// --- The lane column ---
//
// `fadeno dial` printed model, effort, harness and source, and left the LANE
// to be inferred from columns that do not determine it. A director's preflight
// is where that inference gets acted on, and one wrong inference put a
// five-lane campaign on the command lane. Shown, and derived from the same
// `decideLane` every other surface answers with — not a fourth opinion.

test('dial show: every row carries the lane it would take, from the shared predicate', (t) => {
  const root = seedCatalog(t, {
    harnesses: {
      // The host: `sol` is deliverable in-session here, and has a command lane.
      codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: ['node', '-e', '0'] },
      // Not the host, so `grok` can only be spawned.
      grok: { provider: 'xai', command: ['node', '-e', '0'] },
    },
    dials: { worker: 'sol', reviewer: 'grok', judge: 'sol@low' },
  });
  const paths: UserPathOptions = {
    home: join(root, 'home-codex'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'cfg-codex'),
      FADENO_STATE_HOME: join(root, 'state-codex'),
      FADENO_HARNESS: 'codex',
      CLAUDE_EFFORT: 'high',
    },
  };
  const result = runDialShow({ repoRoot: root, userPathOptions: paths, env: paths.env });
  const row = (archetype: string) => result.rows.find((r) => r.archetype === archetype)!;

  // Unpinned on the host harness: in-session, the common path.
  assert.equal(row('worker').lane, 'host');
  assert.equal(row('worker').lane_reason, 'effort unpinned');
  // A harness this session is not inside: the catalog decides, and says so.
  assert.equal(row('reviewer').lane, 'command');
  assert.equal(row('reviewer').lane_reason, 'model not deliverable in-host');
  // Host harness, but a pin the session contradicts — the case the effort and
  // harness columns cannot show together, which is the whole reason for this
  // column.
  assert.equal(row('judge').lane, 'command');
  assert.equal(row('judge').lane_reason, 'session effort is high, dial pins low');

  // The same answer `offHostLanes` gives for the same refs in the same
  // session, because it is the same call — the table and the resolution echo
  // cannot name different lanes for one dial.
  //
  // `worker` and `reviewer` come back null there, and that is the echo's
  // RENDERING filter, not a second predicate: a host-lane row needs no label,
  // and a row that was never a host candidate leaves the session because of a
  // model the reader can already see. The column has no such filter — a table
  // cell has to print something — which is exactly why it must be derived and
  // not re-decided.
  const [worker, reviewer, judge] = offHostLanes(
    [row('worker').refString, row('reviewer').refString, row('judge').refString],
    'high',
    { repoRoot: root, userPathOptions: paths },
  );
  assert.equal(worker, null);
  assert.equal(reviewer, null);
  assert.equal(judge!.lane, row('judge').lane);
  assert.equal(judge!.lane_reason, row('judge').lane_reason);
});

test('dial CLI: the table prints the lane between harness and source', (t) => {
  const root = seedCatalog(t, {
    harnesses: {
      codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: ['node', '-e', '0'] },
      grok: { provider: 'xai', command: ['node', '-e', '0'] },
    },
    dials: { worker: 'sol', reviewer: 'grok' },
  });
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const table = execFileSync(process.execPath, [cli, 'dial'], {
    cwd: root,
    env: {
      ...process.env,
      FADENO_CONFIG_HOME: join(root, 'cfg-codex'),
      FADENO_STATE_HOME: join(root, 'state-codex'),
      FADENO_HARNESS: 'codex',
      HOME: join(root, 'home-codex'),
      CLAUDE_EFFORT: 'high',
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const rowFor = (archetype: string) => table.split('\n').find((line) => line.startsWith(archetype))!;
  assert.match(table.split('\n')[0]!, /harness\s+lane\s+source/);
  assert.match(rowFor('worker'), /codex \(home\)\s+host\s+repo pin/);
  assert.match(rowFor('reviewer'), /grok \(home\)\s+command\s+repo pin/);
});

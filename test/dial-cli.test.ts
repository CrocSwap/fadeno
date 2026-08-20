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

function seedV3(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
      terra: { provider: 'openai', id: 'terra-model', effort: 'medium' },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], write_access: true },
        xai: { command: ['node', '-e', '0'], write_access: true },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
      reviewer: { requires_write: 'none' },
      judge: { requires_write: 'none' },
    },
    ...extra,
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
  return root;
}

test('dial show: effective table with triad and source base', (t) => {
  const root = seedV3(t);
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.equal(result.harness, 'standalone');
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
  const root = seedV3(t, {
    archetypes: {
      worker: { requires_write: 'required' },
      reviewer: { requires_write: 'none' },
      judge: { requires_write: 'none' },
      director: { requires_write: 'required' },
      generator: { requires_write: 'forbidden' },
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
  const root = seedV3(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, DIALS_LOCAL_FILE), 'anthropic-primary\n', 'utf8');
  const result = runDialShow({ repoRoot: root, userPathOptions: isolated(root) });
  assert.match(result.legacy_pin_note ?? '', /pre-0\.6 loadout pin ignored/);
  // Rows still render base
  assert.ok(result.rows.length > 0);
});

test('dial resolve: hook fields stable', (t) => {
  const root = seedV3(t);
  const result = runDialResolve({ repoRoot: root, archetype: 'worker', userPathOptions: isolated(root) });
  assert.equal(result.archetype, 'worker');
  assert.equal(result.model, 'current-host');
  assert.equal(result.adapter, 'host');
  assert.equal(result.source, 'base');
  assert.ok('executor' in result);
  assert.ok('model_id' in result);
  assert.ok('driver' in result);
  assert.ok('delivery' in result);
  assert.equal(typeof result.delivery.dispatchable, 'boolean');
  assert.equal(typeof result.delivery.action, 'string');
  // Keys exact
  const keys = Object.keys(result);
  assert.ok(keys.includes('executor'));
  assert.ok(keys.includes('model'));
  assert.ok(!keys.includes('active')); // active is gone
});

test('dial show: luna stays in codex while adapter selection follows the caller', (t) => {
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
    assert.equal(row.harness, 'codex');
    assert.equal(row.delivery, 'codex');
  }
  assert.equal(rows.get('codex')!.adapter, 'host');
  assert.equal(rows.get('claude')!.adapter, 'command');
  assert.equal(rows.get('grok')!.adapter, 'command');
  assert.equal(rows.get('standalone')!.adapter, 'command');
});

test('dial CLI: --session creates a local dial and a later unscoped set updates it', (t) => {
  const root = seedV3(t);
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
  const root = seedV3(t);
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
  const root = seedV3(t);
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
  const root = seedV3(t);
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
  const root = seedV3(t);
  const paths = isolated(root);
  const lanes = (refs: Array<string | null>, session: string | null) =>
    offHostLanes(refs, session, { repoRoot: root, userPathOptions: paths });
  const shape = (refs: Array<string | null>, session: string | null) =>
    lanes(refs, session).map((d) => (d == null ? null : [d.lane, d.lane_reason]));

  // The implementation trap: an unpinned host dial resolves to a registry
  // default, and must NOT be read as an opinion that leaves the session.
  assert.deepEqual(shape(['current-host'], 'medium'), [null]);
  assert.deepEqual(shape(['current-host@xhigh'], 'xhigh'), [null]);
  // A pin the session cannot serve leaves it. `current-host` declares no
  // command fallback, so there is nowhere to go and the honest answer is
  // restart_required — NOT `command`, which would name a lane that does not
  // exist. The reason reports the blocker, and the renderer must not label
  // this "command lane".
  assert.deepEqual(shape(['current-host@xhigh'], 'medium'), [['restart_required', 'no command fallback']]);
  // Unmeasurable session effort is the absence of proof, and a pin loses on
  // it: we cannot show the host lane delivers xhigh, so we do not claim it.
  assert.deepEqual(shape(['current-host@xhigh'], null), [['restart_required', 'no command fallback']]);
  // A command executor is already off-session for reasons that are not
  // effort, so it is suppressed rather than mislabeled.
  assert.deepEqual(shape(['sol@low'], 'medium'), [null]);
  // Unresolved roles and unknown drivers stay silent, positionally aligned.
  assert.deepEqual(
    shape([null, 'current-host@xhigh', 'nope@low:no-such-driver'], 'medium'),
    [null, ['restart_required', 'no command fallback'], null],
  );
});

test('dial CLI: the effort column shows the pin, and `inherit` where there is none', (t) => {
  const root = seedV3(t);
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

test('new-run echo: an out-of-session pin names the lane and why', (t) => {
  const root = seedV3(t);
  const paths = isolated(root);
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  // CLAUDE_EFFORT is set explicitly on every spawn: this suite must never
  // read the effort of the session that happens to be running it.
  const run = (args: string[], effort: string | null) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...paths.env, HOME: paths.home! };
    if (effort == null) delete env.CLAUDE_EFFORT;
    else env.CLAUDE_EFFORT = effort;
    return execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  };

  run(['dial', 'worker', 'current-host@xhigh', '--session'], null);
  const outOfSession = run(['new-run', 'code-change-review', 'lane echo'], 'medium');
  assert.match(outOfSession, /implementer → current-host@xhigh \(current-host\) \[restart required: no command fallback\]/);
  // Same dial, matching session: it stays in-session and keeps its source label.
  const inSession = run(['new-run', 'code-change-review', 'lane echo'], 'xhigh');
  assert.match(inSession, /implementer → current-host@xhigh \(current-host\) \[session dial\]/);
  // An unmeasurable session effort is the ABSENCE OF PROOF, and a pin loses on
  // it. We cannot show the host lane would deliver xhigh, so we do not claim
  // it — the same way `shadow.routable` degrades to the safe answer rather
  // than the optimistic one. Treating "cannot say" as "matches" is exactly the
  // silent wrong-effort delivery this whole design exists to end.
  assert.match(
    run(['new-run', 'code-change-review', 'lane echo'], null),
    /implementer → current-host@xhigh \(current-host\) \[restart required: no command fallback\]/,
  );
});

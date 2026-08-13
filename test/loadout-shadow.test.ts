import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  LoadoutError,
  formatShadowLine,
  runLoadoutClear,
  runLoadoutClearShadow,
  runLoadoutList,
  runLoadoutSet,
  runLoadoutShadow,
  runLoadoutShow,
  runLoadoutUse,
} from '../src/commands/loadout.ts';
import { LOADOUT_LOCAL_FILE } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

const EXECUTORS: Record<string, unknown> = {
  'opus-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'opus', write_access: true },
  'luna-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'luna-cmd-model' },
  'ro-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'ro-model', write_access: false },
  'forbidden-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'forbidden-model', eligibility: { worker: 'forbidden' } },
  'shadow-only-cmd': { adapter: 'command', command: ['node', '-e', '0'], model: 'shadow-only-model', eligibility: { worker: 'shadow_only' } },
  'terra-host': { adapter: 'host', model: 'terra', reasoning_effort: 'high', agent_type: 'reviewer' },
};

const LOADOUTS: Record<string, unknown> = {
  'anthropic-primary': { worker: 'opus-cmd', reviewer: 'terra-host' },
  'openai-primary': { worker: 'luna-cmd', reviewer: 'terra-host' },
};

function seedProfile(t: TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

function seedLoadouts(t: TestContext): string {
  return seedProfile(t, { executors: EXECUTORS, loadouts: LOADOUTS, default_loadout: 'anthropic-primary' });
}

function seedWithArchetypes(t: TestContext): string {
  return seedProfile(t, {
    executors: EXECUTORS,
    archetypes: {
      worker: { requires_write: true },
      reviewer: { requires_write: false },
    },
    loadouts: LOADOUTS,
    default_loadout: 'anthropic-primary',
  });
}

// ---------------------------------------------------------------------------

test('shadow attach/clear round-trip through real pin file', (t) => {
  const root = seedLoadouts(t);

  // Attach shadow to default loadout (anthropic-primary)
  const attached = runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd' });
  assert.equal(attached.archetype, 'worker');
  assert.equal(attached.executor, 'luna-cmd');
  assert.equal(attached.loadout, 'anthropic-primary');
  assert.equal(attached.rate, null);
  assert.deepEqual(attached.previous, null);
  assert.deepEqual(attached.shadows, { worker: { executor: 'luna-cmd' } });
  // Pin file is JSON with sorted keys
  const raw = read(root, LOADOUT_LOCAL_FILE);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.loadout, 'anthropic-primary');
  assert.deepEqual(parsed.shadows, { worker: { executor: 'luna-cmd' } });

  // Effective table shows shadow
  const shown = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(shown.shadows, { worker: { executor: 'luna-cmd' } });
  assert.deepEqual(shown.shadow_attachments, { worker: { executor: 'luna-cmd', model: 'luna-cmd-model' } });
  const row = shown.slots.find((r) => r.archetype === 'worker')!;
  assert.ok(row.shadow);
  assert.equal(row.shadow!.executor, 'luna-cmd');
  assert.equal(row.shadow!.model, 'luna-cmd-model');

  // JSON fields present (snake_case)
  assert.ok('shadow_attachments' in shown);
  assert.ok('staleShadows' in shown);

  // Attach with rate
  const withRate = runLoadoutShadow({ repoRoot: root, env: null, archetype: 'reviewer', executor: 'opus-cmd', rate: 0.5 });
  assert.equal(withRate.rate, 0.5);
  assert.deepEqual(withRate.shadows, { worker: { executor: 'luna-cmd' }, reviewer: { executor: 'opus-cmd', rate: 0.5 } });
  const shown2 = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(shown2.shadow_attachments['reviewer'], { executor: 'opus-cmd', model: 'opus', rate: 0.5 });

  // Clear single shadow
  const cleared = runLoadoutClearShadow({ repoRoot: root, archetype: 'worker' });
  assert.equal(cleared.archetype, 'worker');
  assert.deepEqual(cleared.cleared, { executor: 'luna-cmd' });
  assert.equal(cleared.count, 1);
  const shown3 = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(shown3.shadows, { reviewer: { executor: 'opus-cmd', rate: 0.5 } });

  // Clear all shadows
  const clearedAll = runLoadoutClearShadow({ repoRoot: root });
  assert.equal(clearedAll.count, 1);
  assert.equal(clearedAll.removed, true);
  const shown4 = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(shown4.shadows, {});
  assert.deepEqual(shown4.shadow_attachments, {});
  // Pin file back to bare name or overrides-only (no shadows)
  assert.equal(read(root, LOADOUT_LOCAL_FILE), 'anthropic-primary\n');

  // Clearing zero shadows is no-op success
  const noop = runLoadoutClearShadow({ repoRoot: root });
  assert.equal(noop.count, 0);
  assert.equal(noop.removed, false);
});

test('shadow refusals: unknown target, forbidden eligibility, bad rate, write-posture', (t) => {
  const root = seedLoadouts(t);
  const writeRoot = seedWithArchetypes(t);

  // Unknown executor
  assert.throws(
    () => runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'ghost-cmd' }),
    (err: unknown) => err instanceof LoadoutError && /is not a declared executor/.test(err.message),
  );
  assert.equal(existsSync(join(root, LOADOUT_LOCAL_FILE)), false);

  // Bad archetype identifier
  assert.throws(
    () => runLoadoutShadow({ repoRoot: root, env: null, archetype: 'Bad Archetype', executor: 'opus-cmd' }),
    /is not a bare lowercase identifier/,
  );

  // Forbidden eligibility
  assert.throws(
    () => runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'forbidden-cmd' }),
    (err: unknown) => err instanceof LoadoutError && /forbidden/.test(err.message),
  );
  assert.equal(existsSync(join(root, LOADOUT_LOCAL_FILE)), false);

  // shadow_only is allowed
  const ok = runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'shadow-only-cmd' });
  assert.equal(ok.executor, 'shadow-only-cmd');

  // Bad rate: 0, negative, >1, NaN
  for (const bad of [0, -0.1, 1.2, 2, Number.NaN]) {
    assert.throws(
      () => runLoadoutShadow({ repoRoot: root, env: null, archetype: 'reviewer', executor: 'luna-cmd', rate: bad as number }),
      /is not a number in \(0, 1\]/,
    );
  }
  assert.throws(
    () => runLoadoutShadow({ repoRoot: root, env: null, archetype: 'reviewer', executor: 'luna-cmd', rate: 'not-a-number' as unknown as number }),
    /is not a number in \(0, 1\]/,
  );

  // Write-posture conflict: worker requires write, ro-cmd is write_access false
  assert.throws(
    () => runLoadoutShadow({ repoRoot: writeRoot, env: null, archetype: 'worker', executor: 'ro-cmd' }),
    (err: unknown) => err instanceof LoadoutError && /requires_write: required/.test(err.message),
  );
  // Reviewer (requires_write none/false) is fine
  const reviewOk = runLoadoutShadow({ repoRoot: writeRoot, env: null, archetype: 'reviewer', executor: 'ro-cmd' });
  assert.equal(reviewOk.executor, 'ro-cmd');
});

test('shadow forbidden does not affect existing pin', (t) => {
  const root = seedLoadouts(t);
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd' });
  const before = read(root, LOADOUT_LOCAL_FILE);
  assert.throws(() => runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'forbidden-cmd' }), LoadoutError);
  assert.equal(read(root, LOADOUT_LOCAL_FILE), before);
});

test('use drops shadows with count', (t) => {
  const root = seedLoadouts(t);
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd' });
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'reviewer', executor: 'opus-cmd', rate: 0.3 });

  const used = runLoadoutUse({ repoRoot: root, name: 'openai-primary' });
  assert.equal(used.name, 'openai-primary');
  assert.deepEqual(used.droppedShadows, { worker: { executor: 'luna-cmd' }, reviewer: { executor: 'opus-cmd', rate: 0.3 } });
  assert.equal(Object.keys(used.dropped_shadow_attachments).length, 2);
  assert.equal(read(root, LOADOUT_LOCAL_FILE), 'openai-primary\n');
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: null }).shadows, {});
  // List also shows empty shadows after use
  const listed = runLoadoutList({ repoRoot: root, env: null });
  assert.deepEqual(listed.shadows, {});
  assert.deepEqual(listed.shadow_attachments, {});
});

test('table line renders shadow with rate', (t) => {
  const root = seedLoadouts(t);
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd', rate: 0.25 });

  const shown = runLoadoutShow({ repoRoot: root, env: null });
  const row = shown.slots.find((r) => r.archetype === 'worker')!;
  assert.ok(row.shadow);
  // Direct helper test: format exactly spec `      ~ shadow: <executor> (<model>) [<transport>]` + rate
  const line = formatShadowLine(row.shadow!, '    ');
  // indent 4 + 2 = 6 spaces before ~
  assert.equal(line, '      ~ shadow: luna-cmd (luna-cmd-model) [command] rate 0.25');

  // Without rate
  runLoadoutClearShadow({ repoRoot: root, archetype: 'worker' });
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd' });
  const shown2 = runLoadoutShow({ repoRoot: root, env: null });
  const row2 = shown2.slots.find((r) => r.archetype === 'worker')!;
  const line2 = formatShadowLine(row2.shadow!, '  ');
  assert.equal(line2, '    ~ shadow: luna-cmd (luna-cmd-model) [command]');

  // List active entry also carries shadow
  const listed = runLoadoutList({ repoRoot: root, env: null });
  const active = listed.loadouts.find((l) => l.isActive)!;
  const activeRow = active.slots.find((s) => s.archetype === 'worker') as unknown as { shadow?: { executor: string } };
  assert.equal(activeRow.shadow?.executor, 'luna-cmd');
  // Non-active entry shows nothing
  const inactive = listed.loadouts.find((l) => !l.isActive)!;
  const inactiveRow = inactive.slots.find((s) => s.archetype === 'worker') as unknown as { shadow?: unknown };
  assert.equal(inactiveRow.shadow, undefined);
});

test('stale-loadout name-match: shadow does not apply under different loadout', (t) => {
  const root = seedLoadouts(t);
  // Attach under anthropic-primary (default)
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd' });
  assert.deepEqual(runLoadoutShow({ repoRoot: root, env: null }).shadows, { worker: { executor: 'luna-cmd' } });

  // Switch via --loadout flag to other loadout: shadow should not appear
  const elsewhere = runLoadoutShow({ repoRoot: root, env: null, loadout: 'openai-primary' });
  assert.deepEqual(elsewhere.shadows, {});
  assert.deepEqual(elsewhere.shadow_attachments, {});
  // Slots should not have shadow either
  const row = elsewhere.slots.find((r) => r.archetype === 'worker')!;
  assert.equal((row as unknown as { shadow?: unknown }).shadow, undefined);

  // Env override also drops it
  const envElse = runLoadoutShow({ repoRoot: root, env: 'openai-primary' });
  assert.deepEqual(envElse.shadows, {});
});

test('stale shadow target is reported not fatal', (t) => {
  const root = seedLoadouts(t);
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd' });
  // Manually corrupt pin to reference gone executor
  writeFileSync(join(root, LOADOUT_LOCAL_FILE), JSON.stringify({ loadout: 'anthropic-primary', shadows: { worker: { executor: 'gone-cmd' } } }) + '\n');

  const shown = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(shown.staleShadows, [{ archetype: 'worker', target: 'gone-cmd' }]);
  // Shadow not in active attachments, row has no shadow
  assert.deepEqual(shown.shadows, { worker: { executor: 'gone-cmd' } });
  assert.deepEqual(shown.shadow_attachments, {});
  const row = shown.slots.find((r) => r.archetype === 'worker')!;
  assert.equal((row as unknown as { shadow?: unknown }).shadow, undefined);
  // List also surfaces stale
  const listed = runLoadoutList({ repoRoot: root, env: null });
  assert.deepEqual(listed.staleShadows, [{ archetype: 'worker', target: 'gone-cmd' }]);
});

test('clear-shadow error when no attachment', (t) => {
  const root = seedLoadouts(t);
  assert.throws(
    () => runLoadoutClearShadow({ repoRoot: root, archetype: 'worker' }),
    (err: unknown) => err instanceof LoadoutError && /no shadow attachment for "worker"/.test(err.message),
  );
});

test('shadow --json fields present and snake_case', (t) => {
  const root = seedLoadouts(t);
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd', rate: 0.7 });
  const shown = runLoadoutShow({ repoRoot: root, env: null });
  // Simulate --json: JSON.stringify(shown) should have snake_case keys
  const json = JSON.stringify(shown);
  assert.match(json, /"shadow_attachments"/);
  assert.match(json, /"staleShadows"/);
  // shadow_attachments entries have executor, model, rate
  assert.deepEqual(shown.shadow_attachments['worker'], { executor: 'luna-cmd', model: 'luna-cmd-model', rate: 0.7 });

  const listed = runLoadoutList({ repoRoot: root, env: null });
  const j2 = JSON.stringify(listed);
  assert.match(j2, /"shadow_attachments"/);
  assert.match(j2, /"staleShadows"/);
});

test('set preserves shadows, clear preserves shadows', (t) => {
  const root = seedLoadouts(t);
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'luna-cmd' });
  runLoadoutSet({ repoRoot: root, env: null, archetype: 'reviewer', target: 'luna-cmd' });
  const afterSet = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(afterSet.shadows, { worker: { executor: 'luna-cmd' } });
  assert.deepEqual(afterSet.overrides, { reviewer: 'luna-cmd' });

  // clear override should keep shadows
  runLoadoutClear({ repoRoot: root, archetype: 'reviewer' });
  const afterClear = runLoadoutShow({ repoRoot: root, env: null });
  assert.deepEqual(afterClear.shadows, { worker: { executor: 'luna-cmd' } });
  assert.deepEqual(afterClear.overrides, {});
});

test('shadow attach rebases when pin decorates different base', (t) => {
  const root = seedLoadouts(t);
  runLoadoutUse({ repoRoot: root, name: 'openai-primary' });
  runLoadoutShadow({ repoRoot: root, env: null, archetype: 'worker', executor: 'opus-cmd' });
  // Now switch active via flag to other loadout and attach again => should drop old
  const rebased = runLoadoutShadow({ repoRoot: root, env: null, loadout: 'anthropic-primary', archetype: 'reviewer', executor: 'luna-cmd' });
  assert.equal(rebased.loadout, 'anthropic-primary');
  assert.deepEqual(rebased.droppedShadows, { worker: { executor: 'opus-cmd' } });
  assert.equal(rebased.droppedBase, 'openai-primary');
  assert.deepEqual(rebased.shadows, { reviewer: { executor: 'luna-cmd' } });
  const shown = runLoadoutShow({ repoRoot: root, env: null, loadout: 'anthropic-primary' });
  assert.deepEqual(shown.shadows, { reviewer: { executor: 'luna-cmd' } });
});

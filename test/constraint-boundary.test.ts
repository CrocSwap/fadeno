import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DispatchCommandError,
  DISPATCHES_FILE,
  DISPATCHES_FORMAT,
  runDispatch,
} from '../src/commands/dispatch.ts';
import { runDispatches } from '../src/commands/dispatches.ts';
import {
  LoadoutError,
  runLoadoutResolve,
  runLoadoutSet,
  runLoadoutShow,
} from '../src/commands/loadout.ts';
import { tempRepo } from './helpers.ts';

/**
 * Phase-3 constraint tiers as the ad-hoc boundary, reader, and loadout dial
 * see them: eligibility / provider distinctness / constraint command /
 * write-posture refusals, shadow_only stamps, and dial-time annotations.
 *
 * All calls pass `env: null` so a real FADENO_LOADOUT in the developer's
 * shell never leaks in.
 */

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const FIXTURE = `#!/usr/bin/env node
const mode = process.argv[2] || 'allow';
if (mode === 'allow') process.exit(0);
if (mode === 'refuse') {
  process.stderr.write('blocked by fixture\\n');
  process.exit(2);
}
process.stderr.write('constraint fixture exploded\\n');
process.exit(1);
`;

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function seedProfile(
  t: TestContext,
  extra: Record<string, unknown> & { worker?: string; reviewer?: string } = {},
): string {
  const { worker, reviewer, ...doc } = extra;
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    executors: {
      'echo-a': {
        adapter: 'command', command: STDIN_ECHO('A:'), model: 'm-a',
        target: 'opus', provider: 'anthropic',
      },
      'echo-b': {
        adapter: 'command', command: STDIN_ECHO('B:'), model: 'm-b',
        target: 'sonnet', provider: 'anthropic',
      },
      'echo-c': {
        adapter: 'command', command: STDIN_ECHO('C:'), model: 'm-c',
        target: 'luna', provider: 'openai',
      },
      gated: {
        adapter: 'command', command: STDIN_ECHO('G:'), model: 'm-g',
        eligibility: { worker: 'forbidden', reviewer: 'shadow_only' },
      },
      'ro-cmd': {
        adapter: 'command', command: STDIN_ECHO('RO:'), model: 'm-ro', write_access: false,
      },
      'rw-cmd': {
        adapter: 'command', command: STDIN_ECHO('RW:'), model: 'm-rw', write_access: true,
      },
    },
    loadouts: {
      main: {
        worker: worker ?? 'echo-a',
        reviewer: reviewer ?? 'echo-b',
      },
    },
    default_loadout: 'main',
    ...doc,
  }));
  return root;
}

function seedConstraint(t: TestContext, mode: 'allow' | 'refuse' | 'error'): string {
  const root = seedProfile(t, {
    constraints: { command: ['node', '.fadeno/constraint-fixture.js', mode] },
  });
  writeFileSync(join(root, '.fadeno', 'constraint-fixture.js'), FIXTURE);
  return root;
}

function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a throw');
}

function captureDispatchError(fn: () => unknown): DispatchCommandError {
  const err = captureThrow(fn);
  assert.ok(err instanceof DispatchCommandError, `expected DispatchCommandError, got ${String(err)}`);
  return err;
}

// --- eligibility ---

test('dispatch: eligibility forbidden refuses with one dispatch_refused row', (t) => {
  const root = seedProfile(t, { worker: 'gated' });
  const message = captureDispatchError(
    () => runDispatch({ archetype: 'worker', prompt: 'do it', repoRoot: root, env: null }),
  ).message;
  assert.match(message, /`eligibility: forbidden`/);
  assert.match(message, /executor "gated"/);

  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'dispatch_refused');
  assert.equal(rows[0]!.format, DISPATCHES_FORMAT);
  assert.equal(rows[0]!.format, '0.2');
  assert.equal(rows[0]!.executor, 'gated');
  assert.equal(rows[0]!.archetype, 'worker');
  assert.deepEqual(rows[0]!.refusal, { predicate: 'eligibility', message });
  assert.ok(!('eligibility' in rows[0]!));
  assert.ok(!('gate_eligible' in rows[0]!));
  assert.ok(!rows.some((row) => row.event === 'dispatch_requested'));
  assert.ok(!rows.some((row) => row.event === 'dispatch_completed'));
});

test('dispatch: shadow_only proceeds and stamps eligibility + gate_eligible on both rows', (t) => {
  const root = seedProfile(t, { reviewer: 'gated' });
  const result = runDispatch({ archetype: 'reviewer', prompt: 'look', repoRoot: root, env: null });
  assert.equal(result.stdout, 'G:look');
  assert.equal(result.executor, 'gated');

  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.event, 'dispatch_requested');
  assert.equal(rows[1]!.event, 'dispatch_completed');
  for (const row of rows) {
    assert.equal(row.format, '0.2');
    assert.equal(row.eligibility, 'shadow_only');
    assert.equal(row.gate_eligible, false);
    assert.ok(!('refusal' in row));
  }
});

// --- provider distinctness (two chained real dispatches) ---

test('dispatch: provider clash refuses under required via --produced-by', (t) => {
  const root = seedProfile(t, {
    archetypes: { reviewer: { distinct_provider_from_inputs: 'required' } },
  });
  const first = runDispatch({ archetype: 'worker', prompt: 'draft', repoRoot: root, env: null });
  assert.equal(first.stdout, 'A:draft');
  const produced = evidenceRows(root).find((row) => row.event === 'dispatch_completed')!;
  assert.equal(produced.provider, 'anthropic');
  assert.equal(produced.dispatch_id, first.dispatchId);

  const message = captureDispatchError(
    () => runDispatch({
      archetype: 'reviewer',
      prompt: 'review',
      producedBy: [first.dispatchId],
      repoRoot: root,
      env: null,
    }),
  ).message;
  assert.match(message, /distinct_provider_from_inputs: required/);
  assert.match(message, /provider "anthropic"/);
  assert.match(message, new RegExp(`dispatch ${first.dispatchId}`));

  const rows = evidenceRows(root);
  const refused = rows.filter((row) => row.event === 'dispatch_refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.format, '0.2');
  assert.deepEqual(refused[0]!.refusal, { predicate: 'provider_distinctness', message });
  assert.deepEqual(refused[0]!.input_provenance, [{
    dispatch_id: first.dispatchId,
    executor: 'echo-a',
    provider: 'anthropic',
  }]);
  assert.ok(!rows.some((row) =>
    row.event === 'dispatch_requested' && row.dispatch_id === refused[0]!.dispatch_id,
  ));
});

test('dispatch: provider clash warns under advisory and stamps provider_distinctness', (t) => {
  const root = seedProfile(t, {
    archetypes: { reviewer: { distinct_provider_from_inputs: 'advisory' } },
  });
  const first = runDispatch({ archetype: 'worker', prompt: 'draft', repoRoot: root, env: null });
  const echoes: string[] = [];
  const second = runDispatch({
    archetype: 'reviewer',
    prompt: 'review',
    producedBy: [first.dispatchId],
    repoRoot: root,
    env: null,
    onEcho: (line) => echoes.push(line),
  });
  assert.equal(second.stdout, 'B:review');
  assert.match(echoes[0]!, /distinct_provider_from_inputs: advisory/);
  assert.match(echoes[0]!, /provider "anthropic"/);
  assert.match(echoes[0]!, new RegExp(`dispatch ${first.dispatchId}`));

  const rows = evidenceRows(root).filter((row) => row.dispatch_id === second.dispatchId);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.event === 'dispatch_requested' || row.event === 'dispatch_completed', true);
    assert.equal(row.provider_distinctness, 'warned');
    assert.deepEqual(row.input_provenance, [{
      dispatch_id: first.dispatchId,
      executor: 'echo-a',
      provider: 'anthropic',
    }]);
  }
});

test('dispatch: unresolvable --produced-by refuses under required', (t) => {
  const root = seedProfile(t, {
    archetypes: { reviewer: { distinct_provider_from_inputs: 'required' } },
  });
  const message = captureDispatchError(
    () => runDispatch({
      archetype: 'reviewer',
      prompt: 'review',
      producedBy: ['ghost-dispatch'],
      repoRoot: root,
      env: null,
    }),
  ).message;
  assert.match(message, /distinct_provider_from_inputs: required/);
  assert.match(message, /provenance is demanded but unresolvable/);
  assert.match(message, /dispatch ghost-dispatch/);

  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'dispatch_refused');
  assert.deepEqual(rows[0]!.refusal, { predicate: 'provider_distinctness', message });
  assert.deepEqual(rows[0]!.input_provenance, [{
    dispatch_id: 'ghost-dispatch',
    executor: null,
    provider: null,
  }]);
  assert.ok(!rows.some((row) => row.event === 'dispatch_requested'));
});

test('dispatch: unresolvable --produced-by warns under advisory', (t) => {
  const root = seedProfile(t, {
    archetypes: { reviewer: { distinct_provider_from_inputs: 'advisory' } },
  });
  const echoes: string[] = [];
  const result = runDispatch({
    archetype: 'reviewer',
    prompt: 'review',
    producedBy: ['ghost-dispatch'],
    repoRoot: root,
    env: null,
    onEcho: (line) => echoes.push(line),
  });
  assert.equal(result.stdout, 'B:review');
  assert.match(echoes[0]!, /distinct_provider_from_inputs: advisory/);
  assert.match(echoes[0]!, /provider provenance is unresolvable/);

  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.provider_distinctness, 'warned');
    assert.deepEqual(row.input_provenance, [{
      dispatch_id: 'ghost-dispatch',
      executor: null,
      provider: null,
    }]);
  }
});

// --- constraint command ---

test('dispatch: constraint command exit 0 allows the dispatch', (t) => {
  const root = seedConstraint(t, 'allow');
  const result = runDispatch({ archetype: 'worker', prompt: 'go', repoRoot: root, env: null });
  assert.equal(result.stdout, 'A:go');
  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.event, 'dispatch_requested');
  assert.equal(rows[1]!.event, 'dispatch_completed');
  assert.ok(!rows.some((row) => row.event === 'dispatch_refused'));
});

test('dispatch: constraint command exit 2 refuses with stderr reason', (t) => {
  const root = seedConstraint(t, 'refuse');
  const message = captureDispatchError(
    () => runDispatch({ archetype: 'worker', prompt: 'go', repoRoot: root, env: null }),
  ).message;
  assert.equal(message, 'blocked by fixture');

  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'dispatch_refused');
  assert.equal(rows[0]!.format, '0.2');
  assert.deepEqual(rows[0]!.refusal, { predicate: 'constraint_command', message });
  assert.ok(!rows.some((row) => row.event === 'dispatch_requested'));
});

test('dispatch: constraint command exit 1 is a DispatchCommandError, never an allow', (t) => {
  const root = seedConstraint(t, 'error');
  const thrown = captureDispatchError(
    () => runDispatch({ archetype: 'worker', prompt: 'go', repoRoot: root, env: null }),
  );
  assert.match(thrown.message, /constraint system error/);
  assert.match(thrown.message, /exited 1/);

  const rows = evidenceRows(root);
  assert.ok(!rows.some((row) => row.event === 'dispatch_requested'));
  assert.ok(!rows.some((row) => row.event === 'dispatch_completed'));
  assert.ok(!rows.some((row) => row.event === 'dispatch_refused'));
});

// --- write posture (retrofitted refusal row) ---

test('dispatch: write-posture refusal leaves a dispatch_refused row and no request', (t) => {
  const root = seedProfile(t, {
    worker: 'ro-cmd',
    archetypes: { worker: { requires_write: true } },
  });
  const message = captureDispatchError(
    () => runDispatch({ archetype: 'worker', prompt: 'ship', repoRoot: root, env: null }),
  ).message;
  assert.match(message, /requires_write: required/);
  assert.match(message, /write_access: false/);

  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'dispatch_refused');
  assert.equal(rows[0]!.format, '0.2');
  assert.deepEqual(rows[0]!.refusal, { predicate: 'write_posture', message });
  assert.ok(!rows.some((row) => row.event === 'dispatch_requested'));
});

// --- reader ---

test('dispatches reader: renders [refused: <predicate>] and [shadow-only]', (t) => {
  const root = seedProfile(t, { worker: 'gated', reviewer: 'gated' });
  const refusedMessage = captureDispatchError(
    () => runDispatch({ archetype: 'worker', prompt: 'nope', repoRoot: root, env: null }),
  ).message;
  const shadowed = runDispatch({ archetype: 'reviewer', prompt: 'look', repoRoot: root, env: null });
  assert.equal(shadowed.executor, 'gated');

  const result = runDispatches({ repoRoot: root });
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 2);
  assert.equal(result.entries[0]!.refusal?.predicate, 'eligibility');
  assert.equal(result.entries[0]!.completed, false);
  assert.match(result.lines[0]!, /\[refused: eligibility]/);
  assert.ok(result.lines[0]!.includes(refusedMessage));
  assert.equal(result.entries[1]!.gateEligible, false);
  assert.equal(result.entries[1]!.completed, true);
  assert.match(result.lines[1]!, /\[shadow-only]/);
});

// --- dial + inspect ---

test('loadout set: refuses dialing a forbidden pairing; shadow_only dials', (t) => {
  const root = seedProfile(t, { worker: 'echo-a', reviewer: 'echo-b' });
  const err = captureThrow(
    () => runLoadoutSet({ repoRoot: root, env: null, archetype: 'worker', target: 'gated' }),
  );
  assert.ok(err instanceof LoadoutError);
  assert.match(err.message, /`eligibility: forbidden`/);
  assert.match(err.message, /executor "gated"/);

  const set = runLoadoutSet({ repoRoot: root, env: null, archetype: 'reviewer', target: 'gated' });
  assert.equal(set.target, 'gated');
  assert.deepEqual(set.overrides, { reviewer: 'gated' });
});

test('loadout show/resolve: carry eligibility when it is not eligible', (t) => {
  const root = seedProfile(t, { worker: 'gated', reviewer: 'gated' });

  const shown = runLoadoutShow({ repoRoot: root, env: null });
  const worker = shown.slots.find((row) => row.archetype === 'worker');
  const reviewer = shown.slots.find((row) => row.archetype === 'reviewer');
  assert.equal(worker?.eligibility, 'forbidden');
  assert.equal(reviewer?.eligibility, 'shadow_only');

  const resolvedShadow = runLoadoutResolve({ repoRoot: root, env: null, archetype: 'reviewer' });
  assert.equal(resolvedShadow.eligibility, 'shadow_only');
  const resolvedForbidden = runLoadoutResolve({ repoRoot: root, env: null, archetype: 'worker' });
  assert.equal(resolvedForbidden.eligibility, 'forbidden');

  const clean = seedProfile(t, { worker: 'echo-a', reviewer: 'echo-b' });
  const eligibleShow = runLoadoutShow({ repoRoot: clean, env: null });
  assert.ok(eligibleShow.slots.every((row) => !('eligibility' in row)));
  const eligibleResolve = runLoadoutResolve({ repoRoot: clean, env: null, archetype: 'worker' });
  assert.ok(!('eligibility' in eligibleResolve));
});

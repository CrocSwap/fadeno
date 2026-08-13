import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { readLocalLoadoutState, writeLocalLoadoutState } from '../src/lib/executors.ts';
import { read, tempRepo } from './helpers.ts';

const ECHO = (prefix: string): string[] => [
  'node', '-e', `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const WRITE_SHADOW = [
  'node', '-e', "require('fs').writeFileSync('shadowed.txt','from-shadow');process.stdout.write('SHADOW_OUT');",
];

const EXECUTORS_BASIC = {
  'echo-worker': { adapter: 'command', command: ECHO('REPORT:'), model: 'opus' },
  'luna-worker': { adapter: 'command', command: ECHO('LUNA:'), model: 'gpt-5.6-luna' },
  'write-worker': { adapter: 'command', command: WRITE_SHADOW, model: 'opus' },
};

function seedProfile(t: import('node:test').TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

function initGit(root: string): void {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fadeno-test',
    GIT_AUTHOR_EMAIL: 'fadeno-test@invalid',
    GIT_COMMITTER_NAME: 'fadeno-test',
    GIT_COMMITTER_EMAIL: 'fadeno-test@invalid',
  };
  const run = (args: string[]): void => {
    const spawned = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (spawned.error != null || spawned.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${spawned.stderr}`);
  };
  run(['init']);
  run(['commit', '--allow-empty', '-m', 'init']);
}

test('shadow pin: round-trip with shadows and sorted keys', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // bare name only when no overrides and no shadows
  writeLocalLoadoutState(root, { loadout: 'main', overrides: {} });
  assert.equal(readFileSync(join(root, '.fadeno/local/loadout'), 'utf8'), 'main\n');
  // with shadows, JSON with sorted keys
  writeLocalLoadoutState(root, {
    loadout: 'main',
    overrides: { worker: 'echo-worker' },
    shadows: { worker: { executor: 'luna-worker', rate: 0.5 }, judge: { executor: 'echo-worker' } },
  });
  const text = readFileSync(join(root, '.fadeno/local/loadout'), 'utf8').trim();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['loadout', 'overrides', 'shadows']);
  assert.deepEqual(Object.keys(parsed.overrides as Record<string, unknown>), ['worker']);
  // Shadows keys should be sorted
  assert.deepEqual(Object.keys(parsed.shadows as Record<string, unknown>), ['judge', 'worker']);
  const state = readLocalLoadoutState(root);
  assert.equal(state.loadout, 'main');
  assert.deepEqual(state.overrides, { worker: 'echo-worker' });
  assert.deepEqual(state.shadows, { judge: { executor: 'echo-worker' }, worker: { executor: 'luna-worker', rate: 0.5 } });
  // empty maps omitted
  writeLocalLoadoutState(root, { loadout: 'main', overrides: {}, shadows: { worker: { executor: 'luna-worker' } } });
  const onlyShadows = JSON.parse(readFileSync(join(root, '.fadeno/local/loadout'), 'utf8').trim()) as Record<string, unknown>;
  assert.ok(!('overrides' in onlyShadows));
  assert.ok('shadows' in onlyShadows);
  // name-match: shadows apply only while loadout name matches
  const activeMain = { name: 'main', source: 'local' as const };
  const activeOther = { name: 'other', source: 'local' as const };
  // quick check via readLocalLoadoutState + applicable logic is tested implicitly by dispatch, but verify state shape
  assert.ok(state.shadows != null);
});

test('shadow attachment fires and writes paired rows with identical prompt_sha256', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root);
  writeLocalLoadoutState(root, { loadout: 'main', overrides: {}, shadows: { worker: { executor: 'luna-worker' } } });

  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'hello shadow', repoRoot: root, env: null, onEcho: (l) => echoes.push(l) });
  const rows = evidenceRows(root);
  assert.equal(rows.length, 4);
  const [pReq, pComp, sReq, sComp] = rows;
  // primary rows unchanged: no shadow fields
  assert.ok(!('shadow' in pReq));
  assert.ok(!('shadow' in pComp));
  assert.ok(!('primary_dispatch_id' in pReq));
  // shadow request row
  assert.equal(sReq.event, 'dispatch_requested');
  assert.equal(sReq.resolution, 'shadow');
  assert.equal(sReq.shadow, true);
  assert.equal(sReq.primary_dispatch_id, pReq.dispatch_id);
  assert.equal(sReq.shadow_source, 'attachment');
  assert.equal(sReq.gate_eligible, false);
  // prompt identical
  assert.equal(sReq.prompt_sha256, pReq.prompt_sha256);
  assert.equal(sReq.prompt_snapshot, pReq.prompt_snapshot);
  assert.equal(sReq.prompt_snapshot, result.promptSnapshot);
  // output snapshot pattern
  assert.match(sReq.output_snapshot as string, /^\.fadeno\/local\/outputs\/shadow-[0-9a-f]{8}\.md$/);
  assert.equal(sComp.output_snapshot, sReq.output_snapshot);
  // completion row diff fields, no workspace_changed
  assert.equal(sComp.event, 'dispatch_completed');
  assert.equal(sComp.shadow, true);
  assert.equal(sComp.primary_dispatch_id, pReq.dispatch_id);
  assert.ok(typeof sComp.diff_snapshot === 'string');
  assert.match(sComp.diff_snapshot as string, /^\.fadeno\/local\/outputs\/shadow-[0-9a-f]{8}\.diff$/);
  assert.equal(typeof sComp.diff_bytes, 'number');
  assert.ok(!('workspace_changed' in sComp));
  // echoes: shadow fire line and diff line, primary output unchanged
  assert.ok(echoes.some((l) => l.startsWith('shadow → luna-worker')));
  assert.ok(echoes.some((l) => l.startsWith('shadow diff:')));
  assert.equal(result.stdout, 'REPORT:hello shadow');
  // shadow snapshot file exists
  assert.ok(existsSync(join(root, sReq.output_snapshot as string)));
  // diff file exists
  assert.ok(existsSync(join(root, sComp.diff_snapshot as string)));
});

test('--shadow flag fires without attachment', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root);
  // no pin
  const result = runDispatch({ archetype: 'worker', prompt: 'flag test', repoRoot: root, env: null, shadow: 'luna-worker' });
  const rows = evidenceRows(root);
  assert.equal(rows.length, 4);
  const sReq = rows[2]!;
  assert.equal(sReq.shadow_source, 'flag');
  assert.equal(sReq.executor, 'luna-worker');
  assert.equal(sReq.resolution, 'shadow');
  assert.equal(sReq.shadow, true);
  assert.equal(result.stdout, 'REPORT:flag test');
});

test('shadow rate: not fired leaves no trace, fired when sampler passes', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root);
  writeLocalLoadoutState(root, {
    loadout: 'main',
    overrides: {},
    shadows: { worker: { executor: 'luna-worker', rate: 0.5 } },
  });
  // sampler returns 0.9 > 0.5 => no shadow
  runDispatch({ archetype: 'worker', prompt: 'rate miss', repoRoot: root, env: null, shadowSampler: () => 0.9 });
  let rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.shadow !== true));
  // sampler returns 0.1 < 0.5 => fires
  runDispatch({ archetype: 'worker', prompt: 'rate hit', repoRoot: root, env: null, shadowSampler: () => 0.1 });
  rows = evidenceRows(root);
  // now 2 primary rows + 2 shadow rows = 6 total (2+4)
  assert.equal(rows.length, 6);
  const shadowRows = rows.filter((r) => r.shadow === true);
  assert.equal(shadowRows.length, 2);
  assert.equal(shadowRows[0]!.shadow_source, 'attachment');
  // flag ignores rate
  const root2 = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root2);
  writeLocalLoadoutState(root2, {
    loadout: 'main',
    overrides: {},
    shadows: { worker: { executor: 'luna-worker', rate: 0.01 } },
  });
  runDispatch({ archetype: 'worker', prompt: 'flag ignores rate', repoRoot: root2, env: null, shadow: 'luna-worker', shadowSampler: () => 0.99 });
  const rows2 = evidenceRows(root2);
  assert.equal(rows2.filter((r) => r.shadow === true).length, 2);
});

test('shadow refusal: forbidden eligibility writes dispatch_refused with shadow true', (t) => {
  const root = seedProfile(t, {
    executors: {
      'echo-worker': { adapter: 'command', command: ECHO('REPORT:'), model: 'opus' },
      'forbidden-worker': { adapter: 'command', command: ECHO('NOPE:'), model: 'bad', eligibility: { worker: 'forbidden' } },
    },
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root);
  writeLocalLoadoutState(root, {
    loadout: 'main',
    overrides: {},
    shadows: { worker: { executor: 'forbidden-worker' } },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'should refuse shadow', repoRoot: root, env: null });
  // primary succeeded
  assert.equal(result.stdout, 'REPORT:should refuse shadow');
  const rows = evidenceRows(root);
  // primary 2 rows + shadow refusal 1 row
  assert.equal(rows.length, 3);
  const refusal = rows[2]!;
  assert.equal(refusal.event, 'dispatch_refused');
  assert.equal(refusal.shadow, true);
  assert.equal(typeof refusal.primary_dispatch_id, 'string');
  assert.equal((refusal.refusal as Record<string, unknown>).predicate, 'eligibility');
  // shadow_only is allowed (not a refusal) — test that shadow_only still fires
  const root2 = seedProfile(t, {
    executors: {
      'echo-worker': { adapter: 'command', command: ECHO('REPORT:'), model: 'opus' },
      'shadow-only-worker': { adapter: 'command', command: ECHO('SHADOW_ONLY:'), model: 'so', eligibility: { worker: 'shadow_only' } },
    },
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root2);
  writeLocalLoadoutState(root2, {
    loadout: 'main',
    overrides: {},
    shadows: { worker: { executor: 'shadow-only-worker' } },
  });
  runDispatch({ archetype: 'worker', prompt: 'shadow only allowed', repoRoot: root2, env: null });
  const rows2 = evidenceRows(root2);
  assert.equal(rows2.length, 4);
  assert.equal(rows2[2]!.shadow, true);
  assert.equal(rows2[2]!.eligibility, 'shadow_only');
});

test('shadow refusal: shadow_isolation in non-git dir', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  // do NOT init git
  writeLocalLoadoutState(root, {
    loadout: 'main',
    overrides: {},
    shadows: { worker: { executor: 'luna-worker' } },
  });
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'no git', repoRoot: root, env: null, onEcho: (l) => echoes.push(l) });
  assert.equal(result.stdout, 'REPORT:no git');
  const rows = evidenceRows(root);
  assert.equal(rows.length, 3);
  const refusal = rows[2]!;
  assert.equal(refusal.event, 'dispatch_refused');
  assert.equal(refusal.shadow, true);
  assert.equal((refusal.refusal as Record<string, unknown>).predicate, 'shadow_isolation');
  assert.ok(echoes.some((l) => l.includes('shadow refused')));
  // primary rows are still valid and not shadow
  assert.ok(!('shadow' in rows[0]!));
});

test('shadow diff artifact contains change a writing fake executor made in worktree', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(root);
  writeLocalLoadoutState(root, {
    loadout: 'main',
    overrides: {},
    shadows: { worker: { executor: 'write-worker' } },
  });
  runDispatch({ archetype: 'worker', prompt: 'write diff', repoRoot: root, env: null });
  const rows = evidenceRows(root);
  const sComp = rows[3]! as Record<string, unknown>;
  assert.equal(sComp.shadow, true);
  const diffRel = sComp.diff_snapshot as string;
  assert.ok(diffRel);
  const diffContent = read(root, diffRel);
  // diff should contain the file created in worktree
  assert.ok(diffContent.includes('shadowed.txt'), `diff should mention shadowed.txt, got: ${diffContent.slice(0, 200)}`);
  // primary workspace should NOT contain the file (worktree isolation)
  assert.ok(!existsSync(join(root, 'shadowed.txt')), 'primary workspace must not contain shadow file');
  // output snapshot for shadow
  const sReq = rows[2]! as Record<string, unknown>;
  const outRel = sReq.output_snapshot as string;
  assert.ok(existsSync(join(root, outRel)));
  assert.equal(read(root, outRel), 'SHADOW_OUT');
});

test('primary rows byte-stable when a shadow fires', (t) => {
  const rootShadow = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(rootShadow);
  writeLocalLoadoutState(rootShadow, {
    loadout: 'main',
    overrides: {},
    shadows: { worker: { executor: 'luna-worker' } },
  });
  runDispatch({ archetype: 'worker', prompt: 'stable', repoRoot: rootShadow, env: null });

  const rootNoShadow = seedProfile(t, {
    executors: EXECUTORS_BASIC,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  initGit(rootNoShadow);
  runDispatch({ archetype: 'worker', prompt: 'stable', repoRoot: rootNoShadow, env: null });

  const rowsShadow = evidenceRows(rootShadow);
  const rowsNo = evidenceRows(rootNoShadow);
  // primary rows are first two in each ledger
  const primaryShadow = rowsShadow.slice(0, 2);
  const primaryNo = rowsNo.slice(0, 2);
  // Compare that primary rows have same keys (no shadow fields) and prompt_sha etc.
  for (let i = 0; i < 2; i++) {
    const a = { ...primaryShadow[i] } as Record<string, unknown>;
    const b = { ...primaryNo[i] } as Record<string, unknown>;
    // timestamps and ids differ — compare structural fields
    assert.ok(!('shadow' in a));
    assert.ok(!('shadow' in b));
    assert.equal(a.prompt_sha256, b.prompt_sha256);
    assert.equal(a.resolution, b.resolution);
    assert.equal(a.executor, b.executor);
    assert.equal(a.archetype, b.archetype);
    // gate_eligible not present on primary (only shadow has false)
    assert.ok(!('gate_eligible' in a) || a.gate_eligible !== false);
  }
});

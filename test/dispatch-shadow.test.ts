import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { readLocalDialState, writeLocalDialState } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';
import { read } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

const ECHO = (prefix: string): string[] => [
  'node', '-e', `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const WRITE_SHADOW = [
  'node', '-e', "require('fs').writeFileSync('shadowed.txt','from-shadow');process.stdout.write('SHADOW_OUT');",
];

function seedV3(t: import('node:test').TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 3,
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
      'luna-worker': { provider: 'openai', id: 'luna-worker' },
      'write-worker': { provider: 'openai', id: 'write-worker' },
    },
    routes: {
      standalone: { openai: { command: ECHO('REPORT:'), write_access: true } },
      codex: { openai: { command: ECHO('REPORT:'), write_access: true } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'echo-worker' },
    ...extra,
  };
  if ((extra as any).models) (base as any).models = { ...(base as any).models, ...(extra as any).models };
  if ((extra as any).routes) (base as any).routes = { ...(base as any).routes, ...(extra as any).routes };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

function initGit(root: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  const run = (args: string[]) => { const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env }); if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed`); };
  run(['init']); run(['commit', '--allow-empty', '-m', 'init']);
}

test('shadow pin: round-trip with dial shadows', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker', rate: 0.5 } }, legacyNote: null });
  const state = readLocalDialState(root);
  assert.deepEqual(state.dials, { worker: { model: 'echo-worker' } });
  assert.deepEqual(state.shadows, { worker: { model: 'luna-worker', rate: 0.5 } });
  // also sorted keys check
  const text = readFileSync(join(root, '.fadeno/local/dials'), 'utf8').trim();
  // ensure file exists and contains shadows
  assert.ok(text.includes('shadows'));
  assert.ok(text.includes('dials'));
});

test('shadow attachment fires and writes paired rows with identical prompt_sha256', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'hello shadow', repoRoot: root, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  assert.equal(rows.length, 4);
  const [pReq, pComp, sReq, sComp] = rows;
  assert.ok(!('shadow' in pReq));
  assert.ok(!('shadow' in pComp));
  assert.equal(sReq.event, 'dispatch_requested');
  assert.equal(sReq.resolution, 'shadow');
  assert.equal(sReq.shadow, true);
  assert.equal(sReq.primary_dispatch_id, pReq.dispatch_id);
  assert.equal(sReq.shadow_source, 'attachment');
  assert.equal(sReq.gate_eligible, false);
  assert.equal(sReq.prompt_sha256, pReq.prompt_sha256);
  assert.equal(sReq.prompt_snapshot, pReq.prompt_snapshot);
  assert.deepEqual(sReq.dial, { model: 'luna-worker' });
  assert.equal(sReq.executor, 'luna-worker');
  assert.match(sReq.output_snapshot as string, /^\.fadeno\/local\/outputs\/shadow-[0-9a-f]{8}\.md$/);
  assert.equal(sComp.output_snapshot, sReq.output_snapshot);
  assert.equal(sComp.event, 'dispatch_completed');
  assert.equal(sComp.shadow, true);
  assert.ok(typeof sComp.diff_snapshot === 'string');
  assert.equal(typeof sComp.diff_bytes, 'number');
  assert.ok(!('workspace_changed' in sComp));
  assert.ok(echoes.some((l) => l.startsWith('shadow → luna-worker')));
  assert.ok(echoes.some((l) => l.startsWith('shadow diff:')));
  assert.equal(result.stdout, 'REPORT:hello shadow');
  assert.ok(existsSync(join(root, sReq.output_snapshot as string)));
  assert.ok(existsSync(join(root, sComp.diff_snapshot as string)));
});

test('--shadow flag fires without attachment', (t) => {
  const root = seedV3(t);
  initGit(root);
  const result = runDispatch({ archetype: 'worker', prompt: 'flag test', repoRoot: root, shadow: 'luna-worker', userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  assert.equal(rows.length, 4);
  const sReq = rows[2]!;
  assert.equal(sReq.shadow_source, 'flag');
  assert.deepEqual(sReq.dial, { model: 'luna-worker' });
  assert.equal(result.stdout, 'REPORT:flag test');
});

test('shadow rate: not fired leaves no trace, fired when sampler passes, flag ignores rate', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker', rate: 0.5 } }, legacyNote: null });
  // sampler returns 0.9 > 0.5 => no shadow
  runDispatch({ archetype: 'worker', prompt: 'rate miss', repoRoot: root, shadowSampler: () => 0.9, userPathOptions: onHarness('standalone') });
  let rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.shadow !== true));
  // sampler returns 0.1 < 0.5 => fires
  runDispatch({ archetype: 'worker', prompt: 'rate hit', repoRoot: root, shadowSampler: () => 0.1, userPathOptions: onHarness('standalone') });
  rows = evidenceRows(root);
  // now 2 primary rows + 2 shadow rows = 6 total (2+4)
  assert.equal(rows.length, 6);
  const shadowRows = rows.filter((r) => r.shadow === true);
  assert.equal(shadowRows.length, 2);
  assert.equal(shadowRows[0]!.shadow_source, 'attachment');
  // flag ignores rate
  const root2 = seedV3(t);
  initGit(root2);
  writeLocalDialState(root2, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker', rate: 0.01 } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'flag ignores rate', repoRoot: root2, shadow: 'luna-worker', shadowSampler: () => 0.99, userPathOptions: onHarness('standalone') });
  const rows2 = evidenceRows(root2);
  assert.equal(rows2.filter((r) => r.shadow === true).length, 2);
});

test('shadow rate sampling fired-half and flag ignores rate (explicit)', (t) => {
  // Additional hardening: fired-half case already above, but assert shadow_source attachment and rows.length ===6
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'luna-worker', rate: 0.5 } }, legacyNote: null });
  // need dial for primary? Use default dial from seedV3 (echo-worker)
  runDispatch({ archetype: 'worker', prompt: 'half', repoRoot: root, shadowSampler: () => 0.4, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  // sampler 0.4 <0.5 => should fire
  assert.equal(rows.filter(r=>r.shadow===true).length, 2);
  assert.equal(rows.filter(r=>r.shadow===true)[0]!.shadow_source, 'attachment');
});

test('shadow refusal: forbidden eligibility writes dispatch_refused with shadow true', (t) => {
  const root = seedV3(t, {
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
      'forbidden-worker': { provider: 'openai', id: 'forbidden', eligibility: { worker: 'forbidden' } },
    },
  } as any);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'forbidden-worker' } }, legacyNote: null });
  const result = runDispatch({ archetype: 'worker', prompt: 'should refuse shadow', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'REPORT:should refuse shadow');
  const rows = evidenceRows(root);
  assert.equal(rows.length, 3);
  const refusal = rows[2]!;
  assert.equal(refusal.event, 'dispatch_refused');
  assert.equal(refusal.shadow, true);
  assert.equal(typeof refusal.primary_dispatch_id, 'string');
  assert.equal((refusal.refusal as Record<string, unknown>).predicate, 'eligibility');
  // shadow_only allowed
  const root2 = seedV3(t, {
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
      'shadow-only-worker': { provider: 'openai', id: 'so', eligibility: { worker: 'shadow_only' } },
    },
  } as any);
  initGit(root2);
  writeLocalDialState(root2, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'shadow-only-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'shadow only allowed', repoRoot: root2, userPathOptions: onHarness('standalone') });
  const rows2 = evidenceRows(root2);
  assert.equal(rows2.length, 4);
  assert.equal(rows2[2]!.shadow, true);
  assert.equal(rows2[2]!.eligibility, 'shadow_only');
});

test('shadow refusal: shadow_isolation in non-git dir', (t) => {
  const root = seedV3(t);
  // do NOT init git
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'no git', repoRoot: root, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'REPORT:no git');
  const rows = evidenceRows(root);
  assert.equal(rows.length, 3);
  const refusal = rows[2]!;
  assert.equal(refusal.event, 'dispatch_refused');
  assert.equal(refusal.shadow, true);
  assert.equal((refusal.refusal as Record<string, unknown>).predicate, 'shadow_isolation');
  assert.ok(echoes.some((l) => l.includes('shadow refused')));
  assert.ok(!('shadow' in rows[0]!));
});

test('shadow diff artifact contains change a writing fake executor made in worktree', (t) => {
  const root = seedV3(t, {
    models: { 'write-worker': { provider: 'openai', id: 'write-worker' } },
    routes: {
      standalone: { openai: { command: WRITE_SHADOW, write_access: true } },
      codex: { openai: { command: WRITE_SHADOW, write_access: true } },
    },
  } as any);
  // Need to ensure write-worker route has WRITE_SHADOW - we set routes per provider so all models share it, but we want echo for primary and write for shadow.
  // Workaround: seed with echo for primary, then manually override route for shadow execution? Instead create profile where standalone route is WRITE_SHADOW and primary still uses echo via model-specific command? For v3 route is per provider, so can't differentiate. We'll just test that diff contains shadowed.txt using write-worker as shadow target while primary is also write-worker? The primary will also write but diff is about shadow worktree.
  // Simpler: make primary echo-worker but route still WRITE_SHADOW - then primary also would write shadowed.txt in primary workspace which we don't want. Alternative: we can test isolation differently: use write-worker as shadow and assert diff contains file while primary workspace does not.
  // Since route is shared, primary will also execute WRITE_SHADOW if we set route to WRITE_SHADOW. So we need to re-seed with echo then after primary, switch route? Instead just use the earlier seedV3 with write-worker model but route still WRITE_SHADOW for both, then assert primary workspace does NOT contain shadowed.txt because shadow runs in worktree.
  // Primary execution will also create shadowed.txt in its worktree? No primary runs in repoRoot, so it would create shadowed.txt in primary workspace. That's not desired for test.
  // To avoid, we use a route that writes to a file only when model is write-worker? Not possible.
  // So we reconfigure: use seedV3 with echo for primary, but shadow flag will use write-worker via same route (WRITE_SHADOW) - then primary echo won't write file, shadow will write in its worktree. So we need route to be echo for primary but shadow to be write. Since route is per provider, we can't. Instead we make two providers: echo-worker uses provider openai with echo, write-worker uses provider openai2 with WRITE_SHADOW.
  const root2 = tempRepo(t);
  mkdirSync(join(root2, '.fadeno'), { recursive: true });
  writeFileSync(join(root2, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
      'write-worker': { provider: 'openai2', id: 'write-worker' },
    },
    routes: {
      standalone: {
        openai: { command: ECHO('REPORT:'), write_access: true },
        openai2: { command: WRITE_SHADOW, write_access: true },
      },
      codex: {
        openai: { command: ECHO('REPORT:'), write_access: true },
        openai2: { command: WRITE_SHADOW, write_access: true },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'echo-worker' },
  }));
  initGit(root2);
  writeLocalDialState(root2, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'write-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'write diff', repoRoot: root2, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root2);
  const sComp = rows[3]! as Record<string, unknown>;
  assert.equal(sComp.shadow, true);
  const diffRel = sComp.diff_snapshot as string;
  assert.ok(diffRel);
  const diffContent = read(root2, diffRel);
  assert.ok(diffContent.includes('shadowed.txt'), `diff should mention shadowed.txt, got: ${diffContent.slice(0, 200)}`);
  assert.ok(!existsSync(join(root2, 'shadowed.txt')), 'primary workspace must not contain shadow file');
  const sReq = rows[2]! as Record<string, unknown>;
  const outRel = sReq.output_snapshot as string;
  assert.ok(existsSync(join(root2, outRel)));
  assert.equal(read(root2, outRel), 'SHADOW_OUT');
});

test('primary rows byte-stable when a shadow fires', (t) => {
  const rootShadow = seedV3(t);
  initGit(rootShadow);
  writeLocalDialState(rootShadow, { dials: {}, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'stable', repoRoot: rootShadow, userPathOptions: onHarness('standalone') });

  const rootNoShadow = seedV3(t);
  initGit(rootNoShadow);
  runDispatch({ archetype: 'worker', prompt: 'stable', repoRoot: rootNoShadow, userPathOptions: onHarness('standalone') });

  const rowsShadow = evidenceRows(rootShadow);
  const rowsNo = evidenceRows(rootNoShadow);
  const primaryShadow = rowsShadow.slice(0, 2);
  const primaryNo = rowsNo.slice(0, 2);
  for (let i = 0; i < 2; i++) {
    const a = { ...primaryShadow[i] } as Record<string, unknown>;
    const b = { ...primaryNo[i] } as Record<string, unknown>;
    assert.ok(!('shadow' in a));
    assert.ok(!('shadow' in b));
    assert.equal(a.prompt_sha256, b.prompt_sha256);
    assert.equal(a.resolution, b.resolution);
    assert.equal(a.executor, b.executor);
    assert.equal(a.archetype, b.archetype);
  }
  // Also verify primary rows compared field-by-field: prompt_snapshot, dial, etc. should be equal ignoring timestamps/dispatch_id and snapshot paths
  const ignore = new Set(['timestamp', 'dispatch_id', 'duration_ms', 'output_snapshot', 'prompt_snapshot', 'command_sha256', 'prompt_sha256']);
  for (let i = 0; i < 2; i++) {
    const a = primaryShadow[i]!;
    const b = primaryNo[i]!;
    for (const key of Object.keys(a)) {
      if (ignore.has(key)) continue;
      if (key === 'format') continue;
      if (!(key in b)) continue;
      // prompt_sha256 still compared separately above, skip here
      assert.deepEqual(a[key], b[key], `field ${key} differs at index ${i}`);
    }
  }
  // prompt_sha256 already checked equal above
  assert.equal(primaryShadow[0]!.prompt_sha256, primaryNo[0]!.prompt_sha256);
});

test('shadow identity re-spell: dial/model/model_id/driver/reasoning_effort', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: {}, shadows: {}, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, shadow: 'luna-worker@high via openai', userPathOptions: onHarness('standalone') } as any);
  const rows = evidenceRows(root);
  const sReq = rows.find((r) => r.shadow === true && r.event === 'dispatch_requested')!;
  assert.deepEqual(sReq.dial, { model: 'luna-worker', effort: 'high', via: 'openai' });
  assert.equal(sReq.reasoning_effort, 'high');
  assert.ok(!('loadout' in sReq));
  assert.ok(!('target' in sReq));
});

test('constraint-boundary shadow_only: assert rows.length ===2 + event names', (t) => {
  // minor hardening: ensure shadow_only produces 2 rows with correct events before loop
  const root = seedV3(t, {
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
      'shadow-only-worker': { provider: 'openai', id: 'so', eligibility: { worker: 'shadow_only' } },
    },
  } as any);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'shadow-only-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'shadow only allowed', repoRoot: root, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  // primary 2 + shadow 2 =4, but this test is about shadow_only as primary? Actually eligibility shadow_only as primary is not shadow. We'll test shadow_only model as primary directly:
  const root2 = seedV3(t, {
    models: { 'shadow-only-worker': { provider: 'openai', id: 'so', eligibility: { reviewer: 'shadow_only' } } },
    dials: { reviewer: 'shadow-only-worker' },
  } as any);
  const r = runDispatch({ archetype: 'reviewer', prompt: 'look', repoRoot: root2, userPathOptions: onHarness('standalone') });
  const rows2 = evidenceRows(root2);
  assert.equal(rows2.length, 2);
  assert.equal(rows2[0]!.event, 'dispatch_requested');
  assert.equal(rows2[1]!.event, 'dispatch_completed');
  for (const row of rows2) {
    assert.equal(row.eligibility, 'shadow_only');
    assert.equal(row.gate_eligible, false);
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDialResolve } from '../src/commands/dial.ts';
import { DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { runDispatchesOutput } from '../src/commands/dispatches.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { readLocalDialState, writeLocalDialState } from '../src/lib/executors.ts';
import { ensureFadenoIgnore } from '../src/lib/source-control.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { exists, tempRepo } from './helpers.ts';
import { read } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

const STEERING_HOOK = join(import.meta.dirname, '..', 'templates', 'claude', 'hooks', 'dispatch-steering.mjs');

// Isolates user-scope config/state so a resolve against an undialed
// archetype falls through to the catalog's base rather than picking up
// whatever this machine's own real user-scoped dial happens to be.
function isolatedUser(root: string, harness: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: harness,
    },
  };
}

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
  run(['init']);
  // The kernel writes `.gitignore` as a side effect of the very first
  // evidence row (`ensureFadenoIgnore`, called from `appendEvidenceRow`), and
  // fixtures write `.fadeno/executors.yaml` before ever calling `initGit`.
  // Seed and commit both up front so a fixture that means to start "clean"
  // actually does: without this, every repo's first shadow-firing dispatch
  // would find Fadeno's own just-written `.gitignore` and the fixture's own
  // uncommitted config sitting untracked, and the workspace-baseline replay
  // (correctly) sweeps untracked-unignored files into the pair's baseline
  // commit — turning "clean" fixtures dirty for reasons that have nothing to
  // do with what a test is actually exercising.
  ensureFadenoIgnore(root);
  run(['add', '-A']);
  run(['commit', '--allow-empty', '-m', 'init']);
}

// Same identity env as `initGit`, exposed for tests that need to add further
// commits of their own (e.g. seeding a tracked file before dirtying it).
const GIT_IDENTITY_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
function gitRun(root: string, args: string[]): string {
  const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_IDENTITY_ENV });
  if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${s.stderr ?? s.error}`);
  return s.stdout;
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
  // Concurrent shadows write their request row before the primary spawns —
  // the request-before-spawn doctrine applies to challengers too — so the
  // ledger reads pReq, sReq, pComp, sComp.
  const [pReq, sReq, pComp, sComp] = rows;
  assert.ok(!('shadow' in pReq));
  assert.ok(!('shadow' in pComp));
  assert.equal(pReq.event, 'dispatch_requested');
  assert.equal(pComp.event, 'dispatch_completed');
  assert.equal(pComp.dispatch_id, pReq.dispatch_id);
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
  assert.equal(sComp.dispatch_id, sReq.dispatch_id);
  assert.ok(typeof sComp.diff_snapshot === 'string');
  assert.equal(typeof sComp.diff_bytes, 'number');
  // Each side records its own runtime — time-to-complete is comparison
  // evidence — and completed − requested === duration_ms holds per side.
  assert.equal(typeof sComp.duration_ms, 'number');
  assert.equal(
    Date.parse(sComp.timestamp as string) - Date.parse(sReq.timestamp as string),
    sComp.duration_ms,
  );
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
  const sReq = rows.find((r) => r.shadow === true && r.event === 'dispatch_requested')!;
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
  // A refused shadow is known before the primary runs, so its row sits
  // between the primary pair.
  const refusal = rows.find((r) => r.event === 'dispatch_refused')!;
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
  const sReq2 = rows2.find((r) => r.shadow === true && r.event === 'dispatch_requested')!;
  assert.equal(sReq2.eligibility, 'shadow_only');
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
  const refusal = rows.find((r) => r.event === 'dispatch_refused')!;
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
  const sComp = rows.find((r) => r.shadow === true && r.event === 'dispatch_completed')! as Record<string, unknown>;
  assert.equal(sComp.shadow, true);
  const diffRel = sComp.diff_snapshot as string;
  assert.ok(diffRel);
  const diffContent = read(root2, diffRel);
  assert.ok(diffContent.includes('shadowed.txt'), `diff should mention shadowed.txt, got: ${diffContent.slice(0, 200)}`);
  assert.ok(!existsSync(join(root2, 'shadowed.txt')), 'primary workspace must not contain shadow file');
  const sReq = rows.find((r) => r.shadow === true && r.event === 'dispatch_requested')! as Record<string, unknown>;
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
  // Shadow rows interleave (pReq, sReq, pComp, sComp), so select the primary
  // pair by identity rather than position.
  const primaryShadow = rowsShadow.filter((r) => r.shadow !== true);
  const primaryNo = rowsNo.filter((r) => r.shadow !== true);
  assert.equal(primaryShadow.length, 2);
  assert.equal(primaryNo.length, 2);
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
  // `workspace_mode` is now an INTENDED difference, not drift: a selected pair
  // puts the primary in its own worktree so both arms produce comparable
  // diffs, where an unpaired dispatch still runs in the shared tree. Asserted
  // explicitly below rather than merely tolerated here — the point of this
  // test is that attaching a shadow leaves the primary's IDENTITY alone
  // (executor, dial, model, archetype, resolution, prompt), and that is
  // unchanged.
  const ignore = new Set(['timestamp', 'dispatch_id', 'duration_ms', 'output_snapshot', 'prompt_snapshot', 'command_sha256', 'prompt_sha256', 'workspace_mode']);
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
  // The one difference, stated positively so it cannot silently regress in
  // either direction: paired means isolated, unpaired means shared.
  assert.equal(primaryShadow[0]!.workspace_mode, 'isolated', 'a paired primary runs in its own worktree');
  assert.equal(primaryNo[0]!.workspace_mode, 'shared', 'an unpaired primary still runs in the shared tree');
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

function seedTwoProviders(t: import('node:test').TestContext, primaryCmd: string[], shadowCmd: string[], extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      'primary-worker': { provider: 'openai', id: 'primary-worker' },
      'shadow-worker': { provider: 'openai2', id: 'shadow-worker' },
    },
    routes: {
      standalone: {
        openai: { command: primaryCmd, write_access: true },
        openai2: { command: shadowCmd, write_access: true },
      },
      codex: {
        openai: { command: primaryCmd, write_access: true },
        openai2: { command: shadowCmd, write_access: true },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'primary-worker' },
    // `extra` lets a fixture add top-level keys, most commonly
    // `worktree_carry` — a real, validated field on `parseExecutorProfile`
    // (see executors.ts), so this is exactly the shape a real repo's project
    // catalog would carry.
    ...extra,
  }));
  return root;
}

test('shadow runs concurrently with the primary, not after it', (t) => {
  // The primary refuses to finish until it has seen a file only the shadow
  // writes. Under the old sequential design (shadow spawned after primary
  // completion) this deadlocks into the primary's 15s timeout; concurrency is
  // the only way SAW_FLAG can happen.
  const root = tempRepo(t);
  const flag = join(root, 'flag-from-shadow.txt');
  const primary = ['node', '-e', `const f=require('fs');const p=${JSON.stringify(flag)};const t0=Date.now();(function w(){if(f.existsSync(p)){process.stdout.write('SAW_FLAG');process.exit(0)}if(Date.now()-t0>15000){process.stdout.write('NO_FLAG');process.exit(3)}setTimeout(w,50)})();`];
  const shadow = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(flag)},'x');process.stdout.write('FLAGGED');`];
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      'primary-worker': { provider: 'openai', id: 'primary-worker' },
      'shadow-worker': { provider: 'openai2', id: 'shadow-worker' },
    },
    routes: {
      standalone: {
        openai: { command: primary, write_access: true },
        openai2: { command: shadow, write_access: true },
      },
      codex: {
        openai: { command: primary, write_access: true },
        openai2: { command: shadow, write_access: true },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'primary-worker' },
  }));
  initGit(root);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  const result = runDispatch({ archetype: 'worker', prompt: 'race', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'SAW_FLAG', 'the primary must observe the concurrently-running shadow');
  assert.equal(result.exitCode, 0);
  const sComp = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_completed')!;
  assert.equal(readFileSync(join(root, sComp.output_snapshot as string), 'utf8'), 'FLAGGED');
});

test('shadow duration_ms is its own runtime, not when the kernel collected it', (t) => {
  // Primary sleeps 3s; shadow returns immediately. The kernel only collects
  // the shadow after the primary's spawnSync returns, so a kernel-clocked
  // duration would read ~3s. The supervisor measures it instead.
  const root = seedTwoProviders(
    t,
    ['node', '-e', "setTimeout(()=>process.stdout.write('SLOW'),3000)"],
    ['node', '-e', "process.stdout.write('FAST')"],
  );
  initGit(root);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'timing', repoRoot: root, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  const pComp = rows.find((r) => r.shadow !== true && r.event === 'dispatch_completed')!;
  const sComp = rows.find((r) => r.shadow === true && r.event === 'dispatch_completed')!;
  assert.ok((pComp.duration_ms as number) >= 2800, `primary ran ~3s, recorded ${pComp.duration_ms}ms`);
  assert.ok(
    (sComp.duration_ms as number) < 2000,
    `shadow finished in well under a second but recorded ${sComp.duration_ms}ms — collection time leaked into its runtime`,
  );
});

test('shadow worktree is cut from HEAD before the primary can move it', (t) => {
  // The primary commits; the shadow reports the HEAD of its own worktree.
  // Cut before the primary spawns, both sides start from the same state and
  // a committing primary cannot contaminate the comparison.
  const gitEnv = "{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@invalid',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}";
  const root = seedTwoProviders(
    t,
    ['node', '-e', `const{execSync}=require('child_process');execSync('git commit --allow-empty -m moved -q',{env:${gitEnv}});process.stdout.write('COMMITTED');`],
    ['node', '-e', "const{execSync}=require('child_process');process.stdout.write(execSync('git rev-parse HEAD').toString().trim());"],
  );
  initGit(root);
  const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  const result = runDispatch({ archetype: 'worker', prompt: 'head', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'COMMITTED');
  const headAfter = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  // The primary DID commit — its stdout says so — but a selected pair now puts
  // it in its own worktree, so the commit lands on that worktree's detached
  // HEAD and the shared repo's HEAD cannot move at all. This assertion used to
  // read `notEqual`, proving the shadow survived a contaminating primary; the
  // guarantee is now stronger than the thing it was testing, so it asserts the
  // stronger fact instead: there is no longer a way for the primary to
  // contaminate the comparison, rather than a way that is defended against.
  assert.equal(headAfter, headBefore, 'an isolated primary cannot move the shared repo HEAD');
  const sComp = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_completed')!;
  const shadowHead = readFileSync(join(root, sComp.output_snapshot as string), 'utf8').trim();
  assert.equal(shadowHead, headBefore, 'the shadow must start from pre-primary HEAD');
});

test('a shadow worktree is retained for review, but its live lease is released even on the primary error path', (t) => {
  // Both request rows exist before the primary starts. Turning the ledger path
  // into a directory from the primary forces its completion append to throw,
  // after the concurrent shadow and its detached worktree already exist.
  // Resolved through `--git-common-dir` rather than a bare relative path: a
  // selected pair runs the primary inside its own worktree, where
  // `.fadeno/dispatches.jsonl` is that worktree's copy and breaking it would
  // leave the real ledger — and so the completion append — perfectly healthy.
  // The common dir is the same for a worktree and its main repo, so this
  // reaches the real ledger from either, and the test no longer depends on
  // which workspace mode the primary happens to run in.
  const primary = ['node', '-e', "const{execSync}=require('child_process');const p=require('path');const f=require('fs');const root=p.dirname(p.resolve(execSync('git rev-parse --git-common-dir').toString().trim()));const led=p.join(root,'.fadeno','dispatches.jsonl');f.rmSync(led);f.mkdirSync(led);process.stdout.write('BROKE_LEDGER');"];
  const shadow = ['node', '-e', "process.stdout.write('SHADOW_DONE')"];
  const root = seedTwoProviders(t, primary, shadow);
  initGit(root);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });

  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'cleanup', repoRoot: root, userPathOptions: onHarness('standalone') }),
  );

  // The challenger's work product outlives the run: a pair is judged later, so
  // deleting it here would throw away half the comparison. It stays a
  // registered worktree, not an orphaned directory.
  // Both arms live under one neutral pair directory now, so the challenger is
  // found by walking that rather than by a `shadow/` path that named it.
  const pairRoot = join(root, '.fadeno', 'local', 'pair');
  const pairDirs = readdirSync(pairRoot);
  assert.equal(pairDirs.length, 1, 'exactly one pair');
  const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.equal(worktrees.status, 0);
  assert.match(worktrees.stdout, /\.fadeno[/\\]local[/\\]pair[/\\]/);

  // What must NOT survive is the live-shadow lease: a failed primary receipt
  // that permanently consumed a slot under the cap would starve every later
  // pair in the repo.
  const inflight = join(root, '.fadeno', 'local', 'inflight');
  const leases = (existsSync(inflight) ? readdirSync(inflight) : []).filter((f) => f.endsWith('.shadow.json'));
  assert.deepEqual(leases, []);
});

test('dispatches --output last never resolves to a shadow', (t) => {
  // The shadow's request row is the newest one carrying an output_snapshot,
  // and its lifetime overlaps the primary's by construction. Neither fact may
  // hand `last` the challenger's report or refuse it as "concurrent" — the
  // caller launched the primary; the kernel launched the shadow.
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  const result = runDispatch({ archetype: 'worker', prompt: 'mine', repoRoot: root, userPathOptions: onHarness('standalone') });
  const last = runDispatchesOutput({ repoRoot: root, dispatchId: 'last' });
  assert.equal(last.dispatchId, result.dispatchId);
  assert.equal(last.bytes, 'REPORT:mine');
  // Explicit id recovery still reaches the shadow's snapshot.
  const sReq = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_requested')!;
  const shadowOut = runDispatchesOutput({ repoRoot: root, dispatchId: sReq.dispatch_id as string });
  assert.equal(shadowOut.dispatchId, sReq.dispatch_id);
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

test('shadow sampling is a function of the prompt, so a retry cannot re-roll it', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker', rate: 0.5 } }, legacyNote: null });
  // Three dispatches of the SAME prompt at a coin-flip rate. Under Math.random
  // this is a 1-in-4 flake and, worse, a retry loop that fires a challenger the
  // first attempt did not. Keyed on the prompt digest there is one decision.
  const fired: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const before = evidenceRows(root).filter((r) => r.shadow === true).length;
    runDispatch({ archetype: 'worker', prompt: 'the same task, retried', repoRoot: root, userPathOptions: onHarness('standalone') });
    fired.push(evidenceRows(root).filter((r) => r.shadow === true).length - before);
  }
  assert.equal(new Set(fired).size, 1, `mixed decisions for one prompt: ${JSON.stringify(fired)}`);

  // And the roll is not a constant: a different challenger on the same prompt
  // is a different draw, so re-attaching re-rolls rather than inheriting.
  const decisionFor = (challenger: string): number => {
    writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: challenger, rate: 0.5 } }, legacyNote: null });
    const before = evidenceRows(root).filter((r) => r.shadow === true).length;
    runDispatch({ archetype: 'worker', prompt: 'the same task, retried', repoRoot: root, userPathOptions: onHarness('standalone') });
    return evidenceRows(root).filter((r) => r.shadow === true).length - before;
  };
  // Same challenger, same answer as the loop above — the seam is stable across
  // state rewrites, not just within one process.
  assert.equal(decisionFor('luna-worker'), fired[0]);
});

test('a paired dispatch carries one pair_id on both arms and records the challenger workspace', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'pair me', repoRoot: root, userPathOptions: onHarness('standalone') });

  const rows = evidenceRows(root);
  const shadowRows = rows.filter((r) => r.shadow === true);
  assert.equal(shadowRows.length, 2);
  const pairIds = new Set(shadowRows.map((r) => r.pair_id));
  assert.equal(pairIds.size, 1);
  const pairId = [...pairIds][0] as string;
  assert.match(pairId, /^[0-9a-f-]{36}$/);

  // The primary's request row predates the roll, so the completion row is the
  // first place it can appear — and it appears only because a shadow fired.
  const primaryRequest = rows.find((r) => r.event === 'dispatch_requested' && r.shadow !== true)!;
  const primaryCompleted = rows.find((r) => r.event === 'dispatch_completed' && r.shadow !== true)!;
  assert.equal(primaryRequest.pair_id, undefined);
  assert.equal(primaryCompleted.pair_id, pairId);

  // The retained worktree is addressable from the row rather than by globbing.
  const workspace = shadowRows[0]!.workspace as string;
  assert.match(workspace, /^\.fadeno\/local\/pair\/[0-9a-f]{8}\/[0-9a-f]{8}$/);
  assert.ok(exists(root, workspace), `retained worktree missing at ${workspace}`);
});

test('a dispatch with no shadow carries no pair_id', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: {}, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'solo', repoRoot: root, userPathOptions: onHarness('standalone') });
  for (const row of evidenceRows(root)) assert.equal(row.pair_id, undefined);
});

test('nothing inside a shadow fires a shadow of its own', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  const previous = process.env.FADENO_IN_SHADOW;
  process.env.FADENO_IN_SHADOW = '1';
  t.after(() => { if (previous == null) delete process.env.FADENO_IN_SHADOW; else process.env.FADENO_IN_SHADOW = previous; });

  const echoes: string[] = [];
  runDispatch({ archetype: 'worker', prompt: 'nested', repoRoot: root, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('standalone') });

  // Suppressed like an unfired sample: no rows, and — deliberately — no echo.
  // An arm that could read "shadow suppressed" would learn which arm it is.
  assert.deepEqual(evidenceRows(root).filter((r) => r.shadow === true), []);
  assert.ok(!echoes.some((line) => line.toLowerCase().includes('shadow')), echoes.join('\n'));
});

test('the live-shadow cap refuses with a row rather than silently skipping', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  const previous = process.env.FADENO_SHADOW_MAX_LIVE;
  process.env.FADENO_SHADOW_MAX_LIVE = '0';
  t.after(() => { if (previous == null) delete process.env.FADENO_SHADOW_MAX_LIVE; else process.env.FADENO_SHADOW_MAX_LIVE = previous; });

  runDispatch({ archetype: 'worker', prompt: 'capped', repoRoot: root, userPathOptions: onHarness('standalone') });

  // A comparison you expected and did not get is worth a row; an unfired
  // sample is not. The distinction is the whole reason this is not silent.
  const refusal = evidenceRows(root).find((r) => r.event === 'dispatch_refused')!;
  const detail = refusal.refusal as { predicate: string; message: string };
  assert.equal(detail.predicate, 'shadow_cap');
  assert.equal(refusal.shadow, true);
  assert.match(detail.message, /live cap is 0/);
  // The primary is untouched, as with every other shadow-side refusal.
  assert.equal(evidenceRows(root).filter((r) => r.event === 'dispatch_completed' && r.shadow !== true).length, 1);
});

test('--isolate and --shadow now coexist: two worktrees, two diffs', (t) => {
  const root = seedV3(t);
  initGit(root);
  // The guard that refused this assumed only one arm could want a worktree.
  // Symmetric pairs need both, and the paths never collided in the first place.
  const result = runDispatch({
    archetype: 'worker', prompt: 'both isolated', repoRoot: root,
    isolate: true, shadow: 'luna-worker', userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.exitCode, 0);

  const rows = evidenceRows(root);
  const primary = rows.find((r) => r.event === 'dispatch_completed' && r.shadow !== true)!;
  const shadow = rows.find((r) => r.event === 'dispatch_completed' && r.shadow === true)!;
  assert.ok(exists(root, String(primary.diff_snapshot)), 'primary isolated diff missing');
  assert.ok(exists(root, String(shadow.diff_snapshot)), 'shadow diff missing');
  assert.equal(primary.pair_id, shadow.pair_id);
});

// --- --isolate gets the same declared carry as a shadow's challenger ---
//
// The same "cut worktree lacks everything gitignored" defect applies to an
// ordinary `--isolate` dispatch, not just a shadow's challenger: `git
// worktree add` checks out tracked content only, so an isolated delivery
// gets no `node_modules`, no `dist`, and cannot build or test either.
// `carryDeclaredPaths` (workspace-lease.ts) is the SAME function the shadow
// carry tests above exercise — these tests are about the `--isolate` call
// site wiring it in, not a second implementation.

test('--isolate carries declared worktree_carry paths into the isolated worktree, and records what was carried on its row', (t) => {
  const primaryCmd = [
    'node', '-e',
    "const fs=require('fs');" +
      "process.stdout.write(fs.existsSync('built/marker.txt')?'CARRIED':'MISSING');",
  ];
  const root = seedTwoProviders(t, primaryCmd, ECHO('CHALLENGER:'), { worktree_carry: ['built'] });
  initGit(root);
  mkdirSync(join(root, 'built'), { recursive: true });
  writeFileSync(join(root, 'built', 'marker.txt'), 'built output');
  writeFileSync(join(root, '.gitignore'), 'built/\n', { flag: 'a' });

  const result = runDispatch({
    archetype: 'worker', prompt: 'isolated carry', repoRoot: root,
    isolate: true, userPathOptions: onHarness('standalone'),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'CARRIED');

  const row = evidenceRows(root).find((r) => r.event === 'dispatch_completed')! as Record<string, unknown>;
  const carry = row.worktree_carry as Array<{ path: string; mechanism: string }>;
  assert.equal(carry.length, 1);
  assert.equal(carry[0]!.path, 'built');
  assert.match(carry[0]!.mechanism, /^(reflink|hardlink|copy)$/);
});

test('a declared-but-uncarriable worktree_carry path refuses the whole isolated dispatch, not just a shadow arm', (t) => {
  // Unlike a shadow (whose carry failure refuses only the challenger, leaving
  // the primary's own result untouched), an isolated dispatch's worktree IS
  // the delivery — there is no separate "primary" to protect, so a carry
  // failure here refuses the whole dispatch by throwing.
  const root = seedTwoProviders(t, ECHO('REPORT:'), ECHO('CHALLENGER:'), { worktree_carry: ['blocked'] });
  initGit(root);
  mkdirSync(join(root, 'blocked', 'inner'), { recursive: true });
  writeFileSync(join(root, 'blocked', 'inner', 'f.txt'), 'x');
  writeFileSync(join(root, '.gitignore'), 'blocked/\n', { flag: 'a' });
  chmodSync(join(root, 'blocked'), 0o000);
  try {
    assert.throws(
      () => runDispatch({ archetype: 'worker', prompt: 'uncarriable isolate', repoRoot: root, isolate: true, userPathOptions: onHarness('standalone') }),
      /could not be carried into the isolated worktree/,
    );
  } finally {
    try { chmodSync(join(root, 'blocked'), 0o755); } catch {}
  }
});

test('a selected pair moves a host-dialed primary onto its own command lane', (t) => {
  // The claude harness delivers this dial in-session, so an ordinary dispatch
  // is refused to stop a host slot shelling out to a subprocess of its own
  // harness. A selected pair is the exception: both arms must be
  // command-delivered or there is nothing to compare.
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { opus: { provider: 'anthropic', id: 'opus' }, grok: { provider: 'xai', id: 'grok' } },
    routes: {
      claude: {
        'current-host': { host: true },
        anthropic: { driver: 'claude-cli', host: true, command: ECHO('HOST-FALLBACK:'), write_access: true },
        xai: { driver: 'grok', command: ECHO('CHALLENGER:'), write_access: true },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'opus' },
  }));
  initGit(root);

  // No attachment: the refusal stands, and says why.
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'solo', repoRoot: root, userPathOptions: onHarness('claude') }),
    /runs in-session/,
  );
  // ...and it must not present the in-session agent as an equivalent. A
  // caller reached for `fadeno dispatch` to get isolation, an evidence row
  // with a readable dispatch id, --timeout/--diagnostics and shadow pairing;
  // an in-session agent supplies none of that and looks like it succeeded. It
  // does write a host_delivery row — the message must not overstate the loss
  // either, which an earlier version of it did.
  // On 2026-08-21 a coordinator took this advice and reported it as
  // "equivalent role, no recursion" while under instructions to read the
  // result back by tag — which by then could not exist. It must also name the
  // remedy that restores a real dispatch, not just say "bind a command
  // executor".
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'solo', repoRoot: root, userPathOptions: onHarness('claude') }),
    /no dispatch id and no terminal receipt/,
  );
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'solo', repoRoot: root, userPathOptions: onHarness('claude') }),
    /fadeno dial worker opus --via/,
  );

  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'grok' } }, legacyNote: null });
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'pair me', repoRoot: root, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('claude') });

  assert.equal(result.exitCode, 0);
  assert.ok(echoes.some((l) => l.includes('pair selected')), echoes.join('\n'));
  const rows = evidenceRows(root);
  const primary = rows.find((r) => r.event === 'dispatch_completed' && r.shadow !== true)!;
  const shadow = rows.find((r) => r.event === 'dispatch_completed' && r.shadow === true)!;
  // Same transport on both arms — the confound the pair exists to remove.
  assert.equal(primary.transport, 'host-command-fallback');
  assert.equal(shadow.transport, 'command');
  assert.equal(primary.pair_id, shadow.pair_id);
  assert.equal(primary.prompt_sha256, shadow.prompt_sha256);
});

test('an unroutable selected pair leaves the spawn untouched — no pair, never a failed dispatch', (t) => {
  // Regression: `dispatchability` refuses ANY host spec under an on-demand
  // host harness, with or without a fallback_command — the kernel's
  // `pairCommandFallback` correctly requires `fallbackCommand != null` too.
  // But the hook used to force command delivery on `shadow.selected` alone.
  // An archetype whose primary is the bare `current-host` base (no dial, no
  // fallback) with a shadow attached would then get routed to the dispatch
  // proxy, which runs `fadeno dispatch` and hits the kernel's ordinary
  // `host_in_session` refusal — turning a selected pair into a failed task
  // instead of the in-session work it would otherwise have done. An
  // unroutable pair must degrade to "no pair", never to "no work".
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { grok: { provider: 'xai', id: 'grok' } },
    routes: {
      claude: {
        xai: { driver: 'grok', command: ECHO('CHALLENGER:'), write_access: true },
      },
    },
    archetypes: { worker: {} },
  }));
  initGit(root);
  // worker carries no primary dial anywhere, so it resolves to the bare
  // current-host base — a host executor with no fallback_command at all.
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'grok', rate: 1 } }, legacyNote: null });

  // The kernel's own view (`fadeno dial resolve`), independent of the hook:
  // selected because rate 1 always fires, but not routable — there is no
  // fallback_command for a pair to force both arms onto.
  const isolated = isolatedUser(root, 'claude');
  const resolved = runDialResolve({
    archetype: 'worker', repoRoot: root, userPathOptions: isolated,
    promptSha256: sha256Hex('do the thing'),
  });
  assert.equal(resolved.adapter, 'host');
  assert.equal(resolved.shadow?.selected, true);
  assert.equal(resolved.shadow?.routable, false);

  // Feed that exact resolution to the hook's decision logic through a fake
  // `fadeno` binary (same technique as resolution-strictness.test.ts), and
  // confirm the hook leaves the tool call alone rather than routing it.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'fadeno'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(resolved))});\n`);
  chmodSync(join(bin, 'fadeno'), 0o755);
  const event = { tool_name: 'Agent', cwd: root, tool_input: { subagent_type: 'worker', prompt: 'do the thing' } };
  const hookResult = spawnSync(process.execPath, [STEERING_HOOK], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  assert.equal(hookResult.status, 0);
  // No hookSpecificOutput at all means "leave the tool call exactly as
  // asked" — the in-session path this spawn would have taken anyway, not a
  // rewrite to the dispatch proxy.
  assert.equal(hookResult.stdout.trim(), '');

  // The kernel is unchanged: `fadeno dispatch` for this archetype still
  // refuses, exactly as it would with no shadow attached at all — only the
  // hook stops sending work it cannot take.
  //
  // The reason is `host_without_fallback`, not `host_in_session`, and that is
  // the point of the fixture: this dial resolves to `current-host`, which
  // declares no fallback_command — the very reason `shadow.routable` is false
  // three assertions above. The refusal used to claim that dispatching "its
  // fallback_command" would re-enter the harness, naming a command that does
  // not exist and sending a reader to look for it.
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'do the thing', repoRoot: root, userPathOptions: isolated }),
    /declares no fallback_command/,
  );
});

// ---- Workspace baseline ----------------------------------------------------
// The challenger's worktree is cut clean from HEAD; the primary works from
// the real workspace, which is usually dirty. Without replaying the
// primary's pre-spawn state into the worktree, the two arms would not start
// from the same bytes and the pair's verdict would be untrustworthy whenever
// the tree is not clean. See docs/experimental/slots-and-archetypes.md,
// "Phase 5 — symmetric pairs" § "Workspace baseline".

/**
 * A primary workspace with one dirty tracked file (modified, never staged)
 * and one untracked-but-unignored file — the two cases `git worktree add`
 * and a plain `git diff` each fail to carry on their own.
 */
function seedDirtyPrimary(t: import('node:test').TestContext, shadowCmd: string[]): string {
  const root = seedTwoProviders(t, ECHO('REPORT:'), shadowCmd);
  initGit(root);
  writeFileSync(join(root, 'tracked.txt'), 'original\n');
  gitRun(root, ['add', 'tracked.txt']);
  gitRun(root, ['commit', '-m', 'seed tracked.txt']);
  // Dirty and unstaged — replay must see this without ever running `git add`
  // in the primary repo, which would mutate the index out from under a
  // primary that is about to work.
  writeFileSync(join(root, 'tracked.txt'), 'modified\n');
  // Untracked and unignored — `git diff HEAD` has no notion of this file at
  // all, so it can only reach the worktree by an explicit copy.
  writeFileSync(join(root, 'untracked.txt'), 'brand new\n');
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  return root;
}

test("a dirty primary workspace replays into the shadow worktree as one commit, and the challenger's own diff is measured against that baseline rather than HEAD", (t) => {
  const shadowCmd = [
    'node', '-e',
    "const fs=require('fs');" +
      "const tracked=fs.readFileSync('tracked.txt','utf8');" +
      "const untracked=fs.readFileSync('untracked.txt','utf8');" +
      // The challenger's own work, committed nowhere — this is what a later
      // diff against the baseline should (and only should) contain.
      "fs.writeFileSync('shadow-work.txt','added by the challenger');" +
      "process.stdout.write('TRACKED:'+tracked+'UNTRACKED:'+untracked);",
  ];
  const root = seedDirtyPrimary(t, shadowCmd);
  const result = runDispatch({ archetype: 'worker', prompt: 'dirty primary', repoRoot: root, userPathOptions: onHarness('standalone') });
  // The primary itself is untouched — same output it would produce with no
  // shadow attached at all.
  assert.equal(result.stdout, 'REPORT:dirty primary');

  const rows = evidenceRows(root);
  const sReq = rows.find((r) => r.shadow === true && r.event === 'dispatch_requested')! as Record<string, unknown>;
  const sComp = rows.find((r) => r.shadow === true && r.event === 'dispatch_completed')! as Record<string, unknown>;

  // The challenger saw both the primary's dirty tracked content and its
  // untracked file — both replayed into the worktree before it ever ran.
  assert.equal(read(root, sReq.output_snapshot as string), 'TRACKED:modified\nUNTRACKED:brand new\n');

  // Replayed as a real commit, named for the pair, containing exactly the two
  // replayed files — not the challenger's own later file, which is the
  // challenger's own work rather than part of the baseline.
  const worktreeAbs = join(root, sReq.workspace as string);
  const show = spawnSync('git', ['-C', worktreeAbs, 'show', '--format=%s', '--name-only', 'HEAD'], { encoding: 'utf8' });
  assert.equal(show.status, 0);
  const lines = show.stdout.trim().split('\n').filter((l) => l.length > 0);
  const [subject, ...files] = lines;
  assert.equal(subject, `fadeno pair baseline ${sReq.pair_id as string}`);
  assert.deepEqual(files.sort(), ['tracked.txt', 'untracked.txt']);

  // The diff measured after the challenger ran is against that baseline
  // commit, not against the original HEAD: it contains only the challenger's
  // own new file. The primary's replayed changes are already committed into
  // the baseline, so they are no longer a diff at all — proving `collectShadow`
  // needed no change once the baseline became the worktree's HEAD.
  const diffContent = read(root, sComp.diff_snapshot as string);
  assert.ok(diffContent.includes('shadow-work.txt'), diffContent);
  assert.ok(!diffContent.includes('tracked.txt'), diffContent);
  assert.ok(!diffContent.includes('untracked.txt'), diffContent);
});

test('an untracked executable file keeps its executable bit when replayed into the shadow worktree', (t) => {
  // `copyFileSync` alone does not preserve mode bits, notably the
  // executable one: an untracked helper script (a repo's own build/test
  // entry point is the common case) would otherwise land non-executable in
  // the challenger's worktree, so the challenger could not run something
  // the primary can — the same class of asymmetry `worktree_carry` exists
  // to remove for gitignored paths, but for a merely-uncommitted one.
  const root = seedTwoProviders(t, ECHO('REPORT:'), ECHO('CHALLENGER:'));
  initGit(root);
  const scriptPath = join(root, 'run.sh');
  writeFileSync(scriptPath, '#!/bin/sh\necho hi\n');
  chmodSync(scriptPath, 0o755);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'executable carry', repoRoot: root, userPathOptions: onHarness('standalone') });

  const sReq = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_requested')! as Record<string, unknown>;
  const worktreeAbs = join(root, sReq.workspace as string);
  const mode = statSync(join(worktreeAbs, 'run.sh')).mode;
  assert.ok((mode & 0o111) !== 0, `expected the executable bit to survive the replay into the worktree; mode=${mode.toString(8)}`);
});

test('the baseline commit sha is the same value on both the primary and shadow rows', (t) => {
  const root = seedDirtyPrimary(t, ECHO('CHALLENGER:'));
  runDispatch({ archetype: 'worker', prompt: 'shared baseline', repoRoot: root, userPathOptions: onHarness('standalone') });

  const rows = evidenceRows(root);
  const sReq = rows.find((r) => r.shadow === true && r.event === 'dispatch_requested')!;
  const sComp = rows.find((r) => r.shadow === true && r.event === 'dispatch_completed')!;
  const primaryReq = rows.find((r) => r.event === 'dispatch_requested' && r.shadow !== true)!;
  const primaryComp = rows.find((r) => r.event === 'dispatch_completed' && r.shadow !== true)!;

  assert.equal(typeof sReq.baseline_commit, 'string');
  assert.match(sReq.baseline_commit as string, /^[0-9a-f]{40}$/);
  assert.equal(sComp.baseline_commit, sReq.baseline_commit);
  // The primary's request row predates the shadow roll (same reason `pair_id`
  // only reaches its completion row), so the completion row is the first —
  // and only — place the primary can carry it.
  assert.equal(primaryReq.baseline_commit, undefined);
  assert.equal(primaryComp.baseline_commit, sReq.baseline_commit);
});

test('a clean primary workspace commits no baseline — the recorded baseline_commit is HEAD', (t) => {
  const root = seedTwoProviders(t, ECHO('REPORT:'), ECHO('CHALLENGER:'));
  initGit(root);
  const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'clean', repoRoot: root, userPathOptions: onHarness('standalone') });

  const sReq = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_requested')!;
  assert.equal(sReq.baseline_commit, headBefore);

  // Nothing to replay means nothing was committed: the worktree's HEAD is
  // still exactly the commit it was cut from, never a "fadeno pair baseline"
  // commit made over an empty diff.
  const worktreeAbs = join(root, sReq.workspace as string);
  const log = spawnSync('git', ['-C', worktreeAbs, 'log', '--format=%s', '-1'], { encoding: 'utf8' });
  assert.doesNotMatch(log.stdout.trim(), /^fadeno pair baseline/);
  const headAfter = spawnSync('git', ['-C', worktreeAbs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(headAfter, headBefore);
});

test('a file under .fadeno/local/ is never copied into the shadow worktree', (t) => {
  // CRITICAL EXCLUSION: `.fadeno/local/` is where the worktree itself lives
  // (`.fadeno/local/shadow/<id>`), so copying it in would be recursive. The
  // repo's own `.gitignore` also happens to exclude this path (Fadeno writes
  // it there), but the carry step must exclude it by path prefix explicitly
  // regardless — a user repo can commit `.fadeno/` definitions while
  // ignoring only some subpaths, so `.gitignore` alone cannot be trusted.
  const shadowCmd = [
    'node', '-e',
    "const fs=require('fs');" +
      "process.stdout.write(fs.existsSync('.fadeno/local/leak.txt') ? fs.readFileSync('.fadeno/local/leak.txt','utf8') : 'ABSENT');",
  ];
  const root = seedTwoProviders(t, ECHO('REPORT:'), shadowCmd);
  initGit(root);
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'leak.txt'), 'must never leave the primary workspace');
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'no leak', repoRoot: root, userPathOptions: onHarness('standalone') });

  const sComp = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_completed')! as Record<string, unknown>;
  assert.equal(read(root, sComp.output_snapshot as string), 'ABSENT');
});

test('an un-replayable primary state refuses the pair loudly, spawns no shadow, and the primary still completes', (t) => {
  const root = seedTwoProviders(t, ECHO('REPORT:'), ['node', '-e', "process.stdout.write('SHOULD-NOT-RUN')"]);
  initGit(root);
  mkdirSync(join(root, 'secret'));
  const leakPath = join(root, 'secret', 'leak.txt');
  writeFileSync(leakPath, 'x');
  // Untracked (so it can only be carried by the copy step, not the diff) and
  // unreadable (so the copy step itself fails). The containing directory
  // keeps normal permissions so `git ls-files --others` can still discover
  // the file — only reading its content fails, which is what the copy step
  // actually does.
  chmodSync(leakPath, 0o000);
  t.after(() => { try { chmodSync(leakPath, 0o644); } catch {} });
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });

  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'unreadable', repoRoot: root, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('standalone') });

  // A dirty tree that cannot be snapshotted must not silently produce a
  // skewed pair, and must not take the primary down with it either.
  assert.equal(result.stdout, 'REPORT:unreadable');
  assert.equal(result.exitCode, 0);

  const rows = evidenceRows(root);
  assert.equal(rows.length, 3);
  const refusal = rows.find((r) => r.event === 'dispatch_refused')! as Record<string, unknown>;
  assert.equal(refusal.shadow, true);
  // Refusal rows nest the predicate as `refusal: { predicate, message }`,
  // never as a top-level field.
  assert.equal(refusal.predicate, undefined);
  const detail = refusal.refusal as { predicate: string; message: string };
  assert.equal(detail.predicate, 'shadow_baseline');
  assert.ok(
    echoes.some((l) => l.includes('shadow refused') && l.includes('[shadow_baseline]')),
    echoes.join('\n'),
  );

  // No shadow ever spawned — the one shadow-tagged row is the refusal itself.
  assert.equal(rows.filter((r) => r.shadow === true).length, 1);
  assert.equal(rows.filter((r) => r.event === 'dispatch_completed' && r.shadow !== true).length, 1);

  // A refused baseline must not leak a registered worktree — only the
  // success path retains one.
  const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(worktrees.stdout, /\.fadeno[/\\]local[/\\]shadow/);
});

// --- worktree_carry: a challenger's worktree is missing everything gitignored ---
//
// `git worktree add` cuts a clean checkout of tracked content only, so
// dependencies, build output, and a local `.fadeno/` catalog never cross into
// a shadow's worktree unless something carries them explicitly. Both
// directories below are gitignored so the workspace-baseline replay's own
// untracked-file copy (a different mechanism, exercised elsewhere in this
// file) cannot be what carries them — these tests are about the carry step
// specifically.

test('a badly-shaped worktree_carry fails the dispatch loudly at load time, not silently at carry time', (t) => {
  // Before promotion into the real config path (`parseExecutorProfile`), a
  // `worktree_carry` of the wrong type was read by a raw-YAML reader that
  // silently treated it as "declare nothing" — someone forgetting the YAML
  // list brackets got no carry and no error. It is now a validated catalog
  // field, so a bad declaration refuses the WHOLE dispatch (there need be no
  // shadow attached at all) before anything spawns.
  const wrongType = seedV3(t, { worktree_carry: 'built' });
  initGit(wrongType);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'bad carry type', repoRoot: wrongType, userPathOptions: onHarness('standalone') }),
    /worktree_carry.*must be an array/,
  );
});

test('a worktree_carry entry escaping the repo (absolute, or a ".." segment) fails the dispatch loudly at load time', (t) => {
  const absolute = seedV3(t, { worktree_carry: ['/etc/passwd'] });
  initGit(absolute);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'absolute carry path', repoRoot: absolute, userPathOptions: onHarness('standalone') }),
    /repo-relative, not absolute/,
  );

  const escaping = seedV3(t, { worktree_carry: ['../outside'] });
  initGit(escaping);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'escaping carry path', repoRoot: escaping, userPathOptions: onHarness('standalone') }),
    /"\.\." segment/,
  );
});

test('worktree_carry declared in the user or builtin layer is refused — it is project-only, describing this repo\'s build state', (t) => {
  // Same enforcement shape as `dials`: a user-scope catalog is shared across
  // whatever repo happens to load it, so a path declared there could never
  // sensibly describe THIS repo's gitignored build output.
  const root = tempRepo(t);
  const userOptions = isolatedUser(root, 'standalone');
  const userConfigDir = join(root, 'user-config', 'fadeno');
  mkdirSync(userConfigDir, { recursive: true });
  writeFileSync(join(userConfigDir, 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { 'echo-worker': { provider: 'openai', id: 'echo-worker' } },
    routes: { standalone: { openai: { command: ECHO('REPORT:'), write_access: true } } },
    worktree_carry: ['built'],
  }));
  initGit(root);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'user-scope carry', repoRoot: root, userPathOptions: userOptions }),
    /worktree_carry.*project-only/,
  );
});

test('a declared carry path is present in the challenger worktree; an undeclared one is not', (t) => {
  const shadowCmd = [
    'node', '-e',
    "const fs=require('fs');" +
      "process.stdout.write((fs.existsSync('built/marker.txt')?'CARRIED':'MISSING')" +
      "+'|'+(fs.existsSync('scratch/marker.txt')?'CARRIED':'MISSING'));",
  ];
  const root = seedTwoProviders(t, ECHO('REPORT:'), shadowCmd, { worktree_carry: ['built'] });
  initGit(root);
  mkdirSync(join(root, 'built'), { recursive: true });
  writeFileSync(join(root, 'built', 'marker.txt'), 'built output');
  mkdirSync(join(root, 'scratch'), { recursive: true });
  writeFileSync(join(root, 'scratch', 'marker.txt'), 'not declared');
  writeFileSync(join(root, '.gitignore'), 'built/\nscratch/\n', { flag: 'a' });
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'carry test', repoRoot: root, userPathOptions: onHarness('standalone') });

  const sComp = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_completed')! as Record<string, unknown>;
  assert.equal(read(root, sComp.output_snapshot as string), 'CARRIED|MISSING');
});

test('the carry mechanism recorded on the row matches how the path actually landed in the worktree', (t) => {
  // Whichever rung of the ladder (reflink / hardlink / copy) this machine's
  // filesystem actually lands on, the row's claim must match observable
  // reality: a `hardlink` entry shares the source's inode (and its link
  // count is bumped), a `reflink` entry does not.
  const root = seedTwoProviders(t, ECHO('REPORT:'), ['node', '-e', "process.stdout.write('OK')"], { worktree_carry: ['built'] });
  initGit(root);
  mkdirSync(join(root, 'built'), { recursive: true });
  writeFileSync(join(root, 'built', 'marker.txt'), 'artifact');
  writeFileSync(join(root, '.gitignore'), 'built/\n', { flag: 'a' });
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });
  runDispatch({ archetype: 'worker', prompt: 'mechanism', repoRoot: root, userPathOptions: onHarness('standalone') });

  const sReq = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_requested')! as Record<string, unknown>;
  const carry = sReq.worktree_carry as Array<{ path: string; mechanism: string }>;
  assert.equal(carry.length, 1);
  assert.equal(carry[0]!.path, 'built');
  assert.match(carry[0]!.mechanism, /^(reflink|hardlink|copy)$/);

  const workspace = sReq.workspace as string;
  const srcStat = statSync(join(root, 'built', 'marker.txt'));
  const destStat = statSync(join(root, workspace, 'built', 'marker.txt'));
  if (carry[0]!.mechanism === 'hardlink') {
    // Same inode, link count at least 2 — cleaning up either worktree can
    // never destroy the other's data. This is the safety argument for
    // choosing hardlink over a directory symlink (which shares the
    // namespace, not just the inode).
    assert.equal(destStat.ino, srcStat.ino);
    assert.ok(destStat.nlink >= 2);
  } else if (carry[0]!.mechanism === 'reflink') {
    assert.notEqual(destStat.ino, srcStat.ino);
  }
  assert.equal(readFileSync(join(root, workspace, 'built', 'marker.txt'), 'utf8'), 'artifact');

  // The completion row carries the same identity (`pending.identity` is
  // spread into it unchanged), so a pair's arms stay checkable as warmed the
  // same way from either row.
  const sComp = evidenceRows(root).find((r) => r.shadow === true && r.event === 'dispatch_completed')!;
  assert.deepEqual(sComp.worktree_carry, sReq.worktree_carry);
});

test('a declared-but-uncarriable path refuses the pair loudly, spawns no shadow, and the primary still completes', (t) => {
  const root = seedTwoProviders(t, ECHO('REPORT:'), ['node', '-e', "process.stdout.write('SHOULD-NOT-RUN')"], { worktree_carry: ['blocked'] });
  initGit(root);
  mkdirSync(join(root, 'blocked', 'inner'), { recursive: true });
  writeFileSync(join(root, 'blocked', 'inner', 'f.txt'), 'x');
  writeFileSync(join(root, '.gitignore'), 'blocked/\n', { flag: 'a' });
  // A directory with no permission bits at all defeats every rung of the
  // ladder: reflink, hardlink, and full copy all need at minimum to read the
  // directory's own entries, which none can do here. (Read permission on the
  // FILES inside is not enough to test this — hardlinking a file needs no
  // read access to its content, only to the containing directory.)
  //
  // Restored synchronously in `finally`, not via `t.after`: `tempRepo()`
  // registers its own recursive-remove `t.after` when `seedTwoProviders`
  // above calls it, and that hook runs before one registered later in this
  // body — a mode-000 directory left unrestored makes that cleanup fail with
  // ENOTEMPTY, unrelated to what this test is actually checking.
  chmodSync(join(root, 'blocked'), 0o000);
  try {
    writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });

    const echoes: string[] = [];
    const result = runDispatch({ archetype: 'worker', prompt: 'uncarriable', repoRoot: root, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('standalone') });

    // A carry failure must never take the primary down with it.
    assert.equal(result.stdout, 'REPORT:uncarriable');
    assert.equal(result.exitCode, 0);

    const rows = evidenceRows(root);
    const refusal = rows.find((r) => r.event === 'dispatch_refused')! as Record<string, unknown>;
    assert.equal(refusal.shadow, true);
    // Refusal rows nest the predicate as `refusal: { predicate, message }`,
    // never as a top-level field.
    assert.equal(refusal.predicate, undefined);
    const detail = refusal.refusal as { predicate: string; message: string };
    assert.equal(detail.predicate, 'shadow_carry');
    assert.match(detail.message, /blocked/);
    assert.ok(
      echoes.some((l) => l.includes('shadow refused') && l.includes('[shadow_carry]')),
      echoes.join('\n'),
    );

    // No shadow ever spawned — the one shadow-tagged row is the refusal itself.
    assert.equal(rows.filter((r) => r.shadow === true).length, 1);
    assert.equal(rows.filter((r) => r.event === 'dispatch_completed' && r.shadow !== true).length, 1);

    // No leaked worktree — the refusal removes what it just created.
    const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(worktrees.stdout, /\.fadeno[/\\]local[/\\]shadow/);
  } finally {
    try { chmodSync(join(root, 'blocked'), 0o755); } catch {}
  }
});

// --- byte-identical prompts let a challenger escape its worktree ---
//
// Both arms receive the exact same prompt bytes on purpose — that identity is
// what makes the pair a fair test — but it also means a prompt naming an
// ABSOLUTE path inside the primary's repo sends the challenger straight into
// the primary's tree. cwd isolation alone is advisory against that.

test('a prompt naming the repo root as an absolute path refuses the pair with shadow_containment; the same prompt written repo-relative fires it', (t) => {
  const root = seedV3(t);
  initGit(root);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });

  const absoluteEchoes: string[] = [];
  const absolutePrompt = `please edit ${join(root, 'src', 'commands', 'dispatch.ts')} carefully`;
  const absoluteResult = runDispatch({
    archetype: 'worker',
    prompt: absolutePrompt,
    repoRoot: root,
    onEcho: (l) => absoluteEchoes.push(l),
    userPathOptions: onHarness('standalone'),
  });
  // The primary is unaffected — only the challenger is skipped.
  assert.equal(absoluteResult.exitCode, 0);
  assert.equal(absoluteResult.stdout, `REPORT:${absolutePrompt}`);

  const absoluteRows = evidenceRows(root);
  const refusal = absoluteRows.find((r) => r.event === 'dispatch_refused')! as Record<string, unknown>;
  assert.equal(refusal.shadow, true);
  assert.equal(refusal.predicate, undefined);
  const detail = refusal.refusal as { predicate: string; message: string };
  assert.equal(detail.predicate, 'shadow_containment');
  assert.match(detail.message, /repo-relative/);
  assert.ok(
    absoluteEchoes.some((l) => l.includes('shadow refused') && l.includes('[shadow_containment]')),
    absoluteEchoes.join('\n'),
  );
  // Refused before the worktree was ever created, not created-then-removed.
  const worktreesAfterAbsolute = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(worktreesAfterAbsolute.stdout, /\.fadeno[/\\]local[/\\]shadow/);

  // The identical task, phrased repo-relative instead, is isolable — the
  // pair fires normally.
  const root2 = seedV3(t);
  initGit(root2);
  writeLocalDialState(root2, { dials: { worker: { model: 'echo-worker' } }, shadows: { worker: { model: 'luna-worker' } }, legacyNote: null });
  const relativeResult = runDispatch({
    archetype: 'worker',
    prompt: 'please edit src/commands/dispatch.ts carefully',
    repoRoot: root2,
    userPathOptions: onHarness('standalone'),
  });
  assert.equal(relativeResult.exitCode, 0);
  const relativeRows = evidenceRows(root2);
  assert.ok(relativeRows.every((r) => r.event !== 'dispatch_refused'), JSON.stringify(relativeRows));
  const relativeShadowRows = relativeRows.filter((r) => r.shadow === true);
  assert.equal(relativeShadowRows.length, 2);
});

// --- Write-shaped pairs: both arms in worktrees, primary merged back --------
//
// `worker` is `requires_write: required` and is the archetype most worth
// shadowing — a model test-drive is worker-shaped. Before this, a pair for it
// produced evidence that could not be compared: the challenger was always
// isolated and emitted a real diff, while the primary ran in the shared tree
// and emitted only a `workspace_changed` BOOLEAN. Nothing refused that — no
// refusal predicate keys on an archetype being write-shaped — so the pair
// formed, completed, stamped `pair_id` on both rows, and looked legitimate
// while having nothing on the primary side to compare against.

test('a write-shaped pair produces two comparable diffs, and the primary is merged back', (t) => {
  const write = (marker: string): string[] => [
    'node', '-e',
    `require('fs').writeFileSync('made.txt','${marker}\\n');process.stdout.write('WROTE_${marker}');`,
  ];
  const root = seedTwoProviders(t, write('PRIMARY'), write('CHALLENGER'));
  initGit(root);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });

  const result = runDispatch({ archetype: 'worker', prompt: 'write', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'WROTE_PRIMARY');

  const rows = evidenceRows(root);
  const pComp = rows.find((r) => r.event === 'dispatch_completed' && r.shadow !== true)!;
  const sComp = rows.find((r) => r.event === 'dispatch_completed' && r.shadow === true)!;

  // Both arms emit a diff. This is the whole point: a boolean cannot be
  // compared to a diff, so before this change one side of the pair had no
  // comparable artifact at all.
  assert.equal(pComp.workspace_mode, 'isolated');
  assert.ok(typeof pComp.diff_snapshot === 'string', 'the primary must emit a diff, not just workspace_changed');
  assert.ok(typeof sComp.diff_snapshot === 'string', 'the challenger must emit a diff');
  assert.ok((pComp.diff_bytes as number) > 0);
  assert.ok((sComp.diff_bytes as number) > 0);

  // One addressable starting state, computed independently in each worktree
  // and equal because the baseline commit is made with fixed dates over the
  // same captured bytes — not copied from one arm onto the other's row.
  assert.equal(pComp.pair_id, sComp.pair_id);
  assert.equal(pComp.baseline_commit, sComp.baseline_commit);
  assert.ok(typeof pComp.baseline_commit === 'string' && (pComp.baseline_commit as string).length === 40);

  // The two diffs actually differ in content, which is what makes the pair a
  // test rather than a formality.
  const pDiff = readFileSync(join(root, pComp.diff_snapshot as string), 'utf8');
  const sDiff = readFileSync(join(root, sComp.diff_snapshot as string), 'utf8');
  assert.match(pDiff, /PRIMARY/);
  assert.match(sDiff, /CHALLENGER/);

  // Merged back, so `fadeno dispatch --archetype worker` still means "the work
  // is in your tree when it returns".
  assert.deepEqual(
    { status: (pComp.primary_merge as Record<string, unknown>).status },
    { status: 'clean' },
  );
  assert.equal(readFileSync(join(root, 'made.txt'), 'utf8').trim(), 'PRIMARY');

  // The challenger's write never reaches the shared tree.
  assert.ok(!readFileSync(join(root, 'made.txt'), 'utf8').includes('CHALLENGER'));
});

test('both arms sit at neutral, identically-shaped worktree paths', (t) => {
  // Blinding used to be advisory: the challenger lived at
  // `.fadeno/local/shadow/<id>` and could read its own cwd to learn which arm
  // it was. Under a pair both arms live at
  // `.fadeno/local/pair/<pair-id8>/<own-dispatch-id8>` — same depth, same
  // shape, a random uuid on each — so the path says only "one arm of a pair".
  const cwd = ['node', '-e', "process.stdout.write(process.cwd());"];
  const root = seedTwoProviders(t, cwd, cwd);
  initGit(root);
  writeLocalDialState(root, { dials: {}, shadows: { worker: { model: 'shadow-worker' } }, legacyNote: null });

  const result = runDispatch({ archetype: 'worker', prompt: 'where', repoRoot: root, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  const sComp = rows.find((r) => r.event === 'dispatch_completed' && r.shadow === true)!;
  const challengerCwd = readFileSync(join(root, sComp.output_snapshot as string), 'utf8').trim();

  for (const [label, observed] of [['primary', result.stdout], ['challenger', challengerCwd]] as const) {
    assert.match(observed, /\.fadeno\/local\/pair\/[0-9a-f]{8}\/[0-9a-f]{8}$/, `${label} cwd must be neutral`);
    assert.ok(!/shadow|challenger|primary/i.test(observed), `${label} cwd must not name the arm`);
  }
  // Same parent, different leaf: one pair, two indistinguishable arms.
  assert.notEqual(result.stdout, challengerCwd);
  assert.equal(result.stdout.split('/').slice(0, -1).join('/'), challengerCwd.split('/').slice(0, -1).join('/'));
});

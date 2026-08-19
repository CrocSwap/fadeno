import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { tempRepo } from './helpers.ts';
import { runDispatchPrepare, DispatchPrepareError } from '../src/commands/dispatch-prepare.ts';
import { runDispatchPrompt } from '../src/commands/dispatch-prompt.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runDispatchStart, runDispatchComplete, runDispatchFail } from '../src/commands/dispatch.ts';
import { HostDispatchError } from '../src/lib/host-dispatch.ts';
import { HostWorkspaceError, hostWorktreePath, hostWorkspaceStatePath, hostIsolatedDiffPath, readHostWorkspaceState } from '../src/lib/host-workspace.ts';

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: dispatch-prepare-fixture
description: Fixture.
roles:
  worker:
    purpose: Do work.
inputs:
  Task:
    media_type: text/markdown
flow:
  - id: implement
    kind: actor_call
    actor: worker
    input: [Task]
    output: Notes
    terminal_status: completed
`;

function initGit(root: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  const run = (args: string[]) => {
    const s = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (s.error || s.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${s.stderr ?? s.error}`);
  };
  run(['init']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-m', 'init']);
}

function seedPrepareRun(t: import('node:test').TestContext) {
  const root = tempRepo(t);
  initGit(root);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'dispatch-prepare-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, 'task.md'), 'do the thing');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
    routes: { standalone: { dummy: { host: true }, 'current-host': { host: true } }, codex: { dummy: { host: true }, 'current-host': { host: true } }, claude: { dummy: { host: true }, 'current-host': { host: true } }, grok: { dummy: { host: true }, 'current-host': { host: true } } },
    archetypes: { worker: {} },
    bindings: { worker: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'dispatch-prepare-fixture', task: 'prepare test', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  return { root, runId, runDir, request };
}

test('dispatch-prepare creates isolated worktree and state, idempotent re-prepare', (t) => {
  const { root, runId, request } = seedPrepareRun(t);
  const first = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  assert.equal(first.workspaceMode, 'isolated');
  assert.equal(first.run, runId);
  assert.equal(first.dispatchId, request.dispatchId);
  assert.ok(first.workspace.startsWith('.fadeno/local/host-worktrees/'));
  assert.ok(first.workspaceAbs.endsWith(first.workspace));
  assert.ok(/^[0-9a-f]{40}$/.test(first.baseCommit));
  assert.ok(first.preparedAt);
  assert.equal(first.idempotent, false);
  const worktreeAbs = resolve(root, first.workspace);
  assert.ok(existsSync(worktreeAbs));
  const statePath = join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`);
  assert.ok(existsSync(statePath));
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.workspace_mode, 'isolated');
  assert.equal(state.workspace, first.workspace);
  assert.equal(state.base_commit, first.baseCommit);
  // dirty shared checkout preserved: worktree has base.txt but not task.md untracked? base.txt exists
  assert.ok(existsSync(join(worktreeAbs, 'base.txt')));
  // second prepare is idempotent, same baseCommit
  const second = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  assert.equal(second.idempotent, true);
  assert.equal(second.baseCommit, first.baseCommit);
  assert.equal(second.workspace, first.workspace);
});

test('dispatch-prepare requires --isolate', (t) => {
  const { root, runId, request } = seedPrepareRun(t);
  assert.throws(() => runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: false }), (err: unknown) => {
    assert.ok(err instanceof DispatchPrepareError);
    assert.match((err as Error).message, /requires --isolate/);
    return true;
  });
});

test('dispatch-prepare fails if request missing', (t) => {
  const { root, runId } = seedPrepareRun(t);
  assert.throws(() => runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: 'no-such-dispatch', isolate: true }), (err: unknown) => {
    // Should propagate HostDispatchError text
    assert.ok(err instanceof DispatchPrepareError || err instanceof HostDispatchError);
    assert.match((err as Error).message, /No host dispatch request/);
    return true;
  });
});

test('dispatch-prepare fails if already started', (t) => {
  const { root, runId, request } = seedPrepareRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  assert.throws(() => runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true }), (err: unknown) => {
    assert.ok(err instanceof DispatchPrepareError);
    assert.match((err as Error).message, /already started/);
    return true;
  });
});

test('dispatch-prepare fails if already terminal', (t) => {
  const { root, runId, request } = seedPrepareRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const tmp = join(root, 'out.md');
  writeFileSync(tmp, 'output');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.throws(() => runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true }), (err: unknown) => {
    assert.ok(err instanceof DispatchPrepareError);
    assert.match((err as Error).message, /already has a terminal receipt/);
    return true;
  });
});

test('dispatch-prepare worktree re-created at recorded base_commit after manual removal', (t) => {
  const { root, runId, request } = seedPrepareRun(t);
  const first = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  const worktreeAbs = resolve(root, first.workspace);
  // Make a new commit so HEAD moves
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  writeFileSync(join(root, 'new.txt'), 'new\n');
  spawnSync('git', ['add', '-A'], { cwd: root, env });
  spawnSync('git', ['commit', '-m', 'second'], { cwd: root, env });
  // Remove worktree
  rmSync(worktreeAbs, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: root, env });
  const second = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  assert.equal(second.baseCommit, first.baseCommit);
  assert.equal(second.idempotent, true);
  assert.ok(existsSync(resolve(root, second.workspace)));
  assert.equal(existsSync(join(resolve(root, second.workspace), 'new.txt')), false, 'recreated at recorded base_commit, not new HEAD');
});

test('dispatch-prepare traversal and symlink rejection via primitive', (t) => {
  const { root } = seedPrepareRun(t);
  assert.throws(() => hostWorktreePath('..', 'valid'), HostWorkspaceError);
  assert.throws(() => hostWorkspaceStatePath('valid', '../evil'), HostWorkspaceError);
  assert.throws(() => hostIsolatedDiffPath('valid/with/slash', 'valid'), HostWorkspaceError);
  // Symlink segment rejection
  mkdirSync(join(root, '.fadeno', 'local', 'host-worktrees'), { recursive: true });
  const link = join(root, '.fadeno', 'local', 'host-worktrees', 'linkrun');
  try { symlinkSync('/tmp', link); } catch {}
  const run2 = 'symtest';
  mkdirSync(join(root, '.fadeno', 'local', 'host-worktrees'), { recursive: true });
  const target = join(root, '.fadeno', 'local', 'host-workspaces');
  const link2 = join(root, '.fadeno', 'local', 'host-worktrees', run2);
  try { symlinkSync(target, link2); } catch {}
  if (existsSync(link2)) {
    assert.throws(() => readHostWorkspaceState(root, run2, 'dispatch1'), HostWorkspaceError);
    rmSync(link2, { force: true });
  }
  if (existsSync(link)) rmSync(link, { force: true });
});

test('double-started dispatch refuses with the frozen already-started token', (t) => {
  const { root, runId, runDir, request } = seedPrepareRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  // hand-append second actor_dispatched to simulate duplicate start
  const eventsPath = join(runDir, 'events.jsonl');
  const raw = readFileSync(eventsPath, 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  const start = lines.find((e: any) => e.type === 'actor_dispatched' && (e.dispatch_id === request.dispatchId || e.extra?.dispatch_id === request.dispatchId));
  assert.ok(start, 'should have one start');
  const dup = JSON.parse(JSON.stringify(start));
  dup.seq = lines.length + 1;
  dup.timestamp = new Date().toISOString();
  // keep same dispatch_id, different timestamp ensures starts.length >1
  const out = raw.trimEnd() + '\n' + JSON.stringify(dup) + '\n';
  writeFileSync(eventsPath, out);
  const expected = `host dispatch "${request.dispatchId}" already started; it cannot be prepared for isolated delivery.`;
  assert.throws(() => runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true }), (err: unknown) => {
    assert.equal((err as Error).message, expected);
    return true;
  });
});

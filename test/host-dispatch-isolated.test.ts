import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { tempRepo } from './helpers.ts';
import { runDispatchPrepare } from '../src/commands/dispatch-prepare.ts';
import { runDispatchPrompt } from '../src/commands/dispatch-prompt.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runDispatchStart, runDispatchComplete, runDispatchFail, runDispatchProgress } from '../src/commands/dispatch.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { acquireWorkspaceLease, readWorkspaceLease, WORKSPACE_LEASE_FILE } from '../src/lib/workspace-lease.ts';
import { hostDeliveryWorkspaceMode } from '../src/lib/host-dispatch.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { runVerify } from '../src/commands/verify.ts';
import { runShow } from '../src/commands/show.ts';
import { hostIsolatedDiffPath } from '../src/lib/host-workspace.ts';

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: isolated-host-fixture
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

function seedIsolatedRun(t: import('node:test').TestContext) {
  const root = tempRepo(t);
  initGit(root);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'isolated-host-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, 'task.md'), 'do the thing');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
    routes: { standalone: { dummy: { host: true }, 'current-host': { host: true } }, codex: { dummy: { host: true }, 'current-host': { host: true } }, claude: { dummy: { host: true }, 'current-host': { host: true } }, grok: { dummy: { host: true }, 'current-host': { host: true } } },
    archetypes: { worker: {} },
    bindings: { worker: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'isolated-host-fixture', task: 'isolated test', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  return { root, runId, runDir, request };
}

function readTerminal(runDir: string, dispatchId: string): Record<string, unknown> | null {
  const evts = readEvents(runDir).events as unknown as Record<string, unknown>[];
  return evts.find((e) => (e.type === 'actor_completed' || e.type === 'actor_failed') && (e as any).extra?.dispatch_id === dispatchId) ?? null;
}

function readStart(runDir: string, dispatchId: string): Record<string, unknown> | null {
  const evts = readEvents(runDir).events as unknown as Record<string, unknown>[];
  return evts.find((e) => e.type === 'actor_dispatched' && (e as any).extra?.dispatch_id === dispatchId) ?? null;
}

function readTerminalExtra(runDir: string, dispatchId: string): Record<string, unknown> | null {
  const ev = readTerminal(runDir, dispatchId) as any;
  return ev?.extra ?? null;
}
function readStartExtra(runDir: string, dispatchId: string): Record<string, unknown> | null {
  const ev = readStart(runDir, dispatchId) as any;
  return ev?.extra ?? null;
}

function pruneWorktrees(root: string): void {
  spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}

function vanishIsolatedStateAndWorktree(root: string, runId: string, dispatchId: string): void {
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${dispatchId}.json`), { force: true });
  rmSync(resolve(root, join('.fadeno', 'local', 'host-worktrees', runId, dispatchId)), { recursive: true, force: true });
  pruneWorktrees(root);
}

test('full isolated lifecycle prepare → prompt → start → complete', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  const promptRes = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  assert.equal(promptRes.workspaceMode, 'isolated');
  assert.equal(promptRes.workspace, prep.workspaceAbs);
  assert.equal(promptRes.baseCommit, prep.baseCommit);
  // envelope exact bytes check for isolated form
  const promptBytes = readFileSync(join(runDir, request.promptPath));
  const expectedHeader = `# Fadeno engine step assignment\n\nrun: ${runId}\ndispatch_id: ${request.dispatchId}\nworkspace_mode: isolated\nworkspace: ${prep.workspaceAbs}\n\nAll repository reads and writes for this assignment must occur in the workspace above; do not read or modify the shared checkout.\n\n`;
  assert.deepEqual(promptRes.envelope, Buffer.concat([Buffer.from(expectedHeader), promptBytes]));
  assert.equal(promptRes.promptSha256, request.promptSha256);
  // prompt sha unchanged
  assert.equal(promptRes.promptSha256, request.promptSha256);
  const start = runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  assert.equal(start.state, 'started');
  const startEvt = readStart(runDir, request.dispatchId) as any;
  const startExtra = (startEvt as any).extra as any;
  assert.equal(startExtra.workspace_mode, 'isolated');
  assert.equal(startExtra.workspace, prep.workspace);
  assert.equal(startExtra.base_commit, prep.baseCommit);
  assert.equal(hostDeliveryWorkspaceMode(startEvt as any), 'isolated');
  // write inside isolated worktree
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'isolated.txt'), 'from isolated\n');
  writeFileSync(join(wtAbs, 'base.txt'), 'base-modified\n');
  // complete
  const tmp = join(root, 'out.md');
  writeFileSync(tmp, 'final output');
  const comp = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.equal(comp.state, 'completed');
  const term = readTerminal(runDir, request.dispatchId) as any;
  const termExtra = (term as any).extra as any;
  assert.equal(termExtra.workspace_mode, 'isolated');
  assert.equal(termExtra.workspace, prep.workspace);
  assert.equal(termExtra.base_commit, prep.baseCommit);
  assert.ok(typeof termExtra.diff_snapshot === 'string' && termExtra.diff_snapshot.startsWith('.fadeno/local/outputs/host-isolated-'));
  assert.ok(typeof termExtra.diff_bytes === 'number' && termExtra.diff_bytes > 0);
  const diffAbs = join(root, termExtra.diff_snapshot);
  assert.ok(existsSync(diffAbs));
  const diffText = readFileSync(diffAbs, 'utf8');
  assert.ok(diffText.includes('isolated.txt') || diffText.includes('base.txt'));
  // worktree removed after terminal
  assert.equal(existsSync(wtAbs), false, 'worktree removed only after terminal receipt');
  // shared checkout not auto-merged
  assert.equal(existsSync(join(root, 'isolated.txt')), false);
  assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'base\n');
  // output placed correctly
  const outRel = termExtra.output as string;
  assert.ok(existsSync(join(runDir, outRel)));
});

test('isolated failure lifecycle prepare → start → fail', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'fail.txt'), 'fail content\n');
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'oops' });
  assert.equal(fail.state, 'failed');
  const term = readTerminal(runDir, request.dispatchId) as any;
  const termExtra = (term as any).extra as any;
  assert.equal(termExtra.workspace_mode, 'isolated');
  assert.equal(termExtra.workspace, prep.workspace);
  assert.equal(termExtra.base_commit, prep.baseCommit);
  assert.ok(typeof termExtra.diff_snapshot === 'string');
  assert.ok(typeof termExtra.diff_bytes === 'number');
  assert.ok(existsSync(join(root, termExtra.diff_snapshot)));
  assert.equal(existsSync(wtAbs), false);
});

test('shared-lease bypass: isolated start succeeds while shared start blocks', (t) => {
  const { root, runId, request } = seedIsolatedRun(t);
  // Hold shared lease with different holder — pid-less so always alive regardless of probe
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: { id: 'blocker', kind: 'ad-hoc' }, supervisorPid: null });
  assert.ok(existsSync(join(root, WORKSPACE_LEASE_FILE)));
  // For isolated, hold lease in original root should not block isolated start
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  // Isolated start must succeed even though shared lease held
  const isoStart = runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-iso' });
  assert.equal(isoStart.state, 'started');
  // Shared path should block: try to start unprepared dispatch in same repo where lease is held by blocker
  const { runId: run2, request: req2 } = (() => {
    // reuse same root, create new run
    writeFileSync(join(root, 'task2.md'), 'task2');
    const { runId } = runNewRun({ repoRoot: root, playbook: 'isolated-host-fixture', task: 'second', inputs: ['Task=task2.md'] });
    const driven2 = runDrive({ repoRoot: root, run: runId });
    assert.equal(driven2.outcome, 'awaiting_host_dispatch');
    return { runId, request: driven2.requests[0]! };
  })();
  // req2 is shared (not prepared), should be blocked by blocker lease
  // But our blocker holder id is 'blocker', and host dispatch holder is dispatchId, so it should block
  // However hostRequestNeedsLease checks writeAccess; for this fixture, luna is writeAccess true, so needs lease
  // So shared start should throw WorkspaceLeaseError wrapped as HostDispatchError
  let blocked = false;
  try {
    runDispatchStart({ repoRoot: root, run: run2, dispatchId: req2.dispatchId, agentId: 'host-shared' });
  } catch (err) {
    blocked = true;
    assert.match((err as Error).message, /shared workspace is already held/);
  }
  assert.equal(blocked, true, 'shared start must be blocked by live lease');
  // Isolated start already succeeded, proves bypass
  // Shared path leasing unchanged: after releasing blocker, shared start should succeed
  // Release blocker by removing lease file directly? Use release via direct rm? The blocker holds lease with supervisorPid 999999 which is not alive, but our probe is dummy alive, so it stays. We need to release it manually by removing file for test cleanup
  rmSync(join(root, WORKSPACE_LEASE_FILE), { force: true });
});

test('exact-prompt-byte: shared envelope byte-identical to today, isolated adds header, sha invariant', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const shared = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  const promptBytes = readFileSync(join(runDir, request.promptPath));
  const expectedSharedHeader = `# Fadeno engine step assignment\n\nrun: ${runId}\ndispatch_id: ${request.dispatchId}\n\n`;
  assert.deepEqual(shared.envelope, Buffer.concat([Buffer.from(expectedSharedHeader), promptBytes]));
  assert.equal(shared.workspaceMode, 'shared');
  assert.equal(shared.workspace, null);
  assert.equal(shared.baseCommit, null);
  assert.equal(shared.promptSha256, request.promptSha256);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  const iso = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  const expectedIsoHeader = `# Fadeno engine step assignment\n\nrun: ${runId}\ndispatch_id: ${request.dispatchId}\nworkspace_mode: isolated\nworkspace: ${prep.workspaceAbs}\n\nAll repository reads and writes for this assignment must occur in the workspace above; do not read or modify the shared checkout.\n\n`;
  assert.deepEqual(iso.envelope, Buffer.concat([Buffer.from(expectedIsoHeader), promptBytes]));
  assert.equal(iso.workspaceMode, 'isolated');
  assert.equal(iso.workspace, prep.workspaceAbs);
  assert.equal(iso.baseCommit, prep.baseCommit);
  assert.equal(iso.promptSha256, request.promptSha256);
  assert.equal(shared.promptSha256, iso.promptSha256, 'prompt sha invariant');
});

test('crash-boundary: diff collection failure preserves worktree and appends no terminal', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'crash.txt'), 'content\n');
  // Block diff output directory to force collect failure
  const outputsDir = join(root, '.fadeno', 'local', 'outputs');
  rmSync(outputsDir, { recursive: true, force: true });
  writeFileSync(outputsDir, 'block');
  const tmp = join(root, 'out.md');
  writeFileSync(tmp, 'out');
  let threw = false;
  try {
    runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  } catch (err) {
    threw = true;
    assert.match((err as Error).message, /ENOTDIR|not a directory|could not/i);
  }
  assert.equal(threw, true);
  assert.equal(existsSync(wtAbs), true, 'worktree preserved after diff failure');
  const term = readTerminal(runDir, request.dispatchId);
  assert.equal(term, null, 'no terminal appended after diff failure');
  // cleanup for next isolation
  rmSync(outputsDir, { force: true });
  mkdirSync(outputsDir, { recursive: true });
  rmSync(wtAbs, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: root });
});

test('crash-boundary: ledger append failure preserves worktree for retry', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'ledger.txt'), 'x\n');
  // Make events.jsonl append fail by making its directory unwritable
  const eventsPath = join(runDir, 'events.jsonl');
  const origMode = statSync(runDir).mode;
  // Use chmod to make runDir unwritable
  chmodSync(runDir, 0o555);
  const tmp = join(root, 'out2.md');
  writeFileSync(tmp, 'out2');
  let threw = false;
  try {
    runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  } catch {
    threw = true;
  }
  // Restore permissions before assertions that need to read
  chmodSync(runDir, origMode);
  assert.equal(threw, true);
  assert.ok(existsSync(wtAbs), 'worktree preserved after ledger failure');
  // events.jsonl should still be readable and no terminal appended
  const termAfterFail = readTerminal(runDir, request.dispatchId);
  assert.equal(termAfterFail, null);
  const comp = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.equal(comp.state, 'completed');
  assert.equal(existsSync(wtAbs), false, 'worktree removed after successful retry');
});

test('idempotent terminal reuses receipt without recollecting and retries cleanup', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'idem.txt'), 'idem\n');
  const tmp = join(root, 'out.md');
  writeFileSync(tmp, 'idem out');
  const first = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.equal(first.idempotent, false);
  const term1 = readTerminal(runDir, request.dispatchId) as any;
  const term1Extra = (term1 as any).extra as any;
  const diff1 = term1Extra.diff_snapshot;
  // Second call with same output should be idempotent, not recollect diff, and retry cleanup (already removed)
  const second = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.equal(second.idempotent, true);
  const term2 = readTerminal(runDir, request.dispatchId) as any;
  const term2Extra = (term2 as any).extra as any;
  const term1DiffBytes = term1Extra.diff_bytes;
  assert.equal(term2Extra.diff_snapshot, diff1);
  assert.equal(term2Extra.diff_bytes, term1DiffBytes);
  // worktree already removed, second call should still succeed and not throw missing worktree
  assert.equal(existsSync(wtAbs), false);
});

test('command-fallback refusal for isolated', (t) => {
  const { root, runId, request } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  assert.throws(() => runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1', transport: 'command-fallback', command: ['echo', 'hi'] }), (err: unknown) => {
    assert.match((err as Error).message, /prepared for isolated host delivery and cannot be delivered by command fallback/);
    return true;
  });
});

test('workspace mismatch refusal', (t) => {
  const { root, runId, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  assert.throws(() => runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1', workspace: '.fadeno/local/host-worktrees/other/path' }), (err: unknown) => {
    assert.match((err as Error).message, /is prepared for isolated delivery at/);
    assert.ok((err as Error).message.includes(prep.workspace));
    return true;
  });
  // Omitted workspace should succeed
  const ok = runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  assert.equal(ok.state, 'started');
});

test('prepare refusals: already started and already terminal', (t) => {
  const { root, runId, request } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  assert.throws(() => runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true }), /already started/);
  const tmp = join(root, 'out.md');
  writeFileSync(tmp, 'out');
  runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.throws(() => runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true }), /already has a terminal receipt/);
});

test('shared path leasing unchanged', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  // No prepare, shared path
  const prompt = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  assert.equal(prompt.workspaceMode, 'shared');
  const start = runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared' });
  assert.equal(start.state, 'started');
  const startEvt = readStart(runDir, request.dispatchId) as any;
  const startExtra = (startEvt as any).extra as any;
  assert.equal(startExtra.workspace_mode, undefined);
  assert.equal(hostDeliveryWorkspaceMode(startEvt as any), 'shared');
  const tmp = join(root, 'out.md');
  writeFileSync(tmp, 'shared out');
  const comp = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.equal(comp.state, 'completed');
  const term = readTerminal(runDir, request.dispatchId) as any;
  const termExtra = (term as any).extra as any;
  assert.equal(termExtra.workspace_mode, undefined);
  assert.equal(termExtra.diff_snapshot, undefined);
});

test('dispatch-fail terminalizes an isolated dispatch whose machine-local state vanished', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const startExtra = readStartExtra(runDir, request.dispatchId) as any;
  const wtAbs = resolve(root, prep.workspace);
  const statePath = join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`);
  assert.ok(existsSync(statePath));
  assert.ok(existsSync(wtAbs));
  vanishIsolatedStateAndWorktree(root, runId, request.dispatchId);
  const diffRel = hostIsolatedDiffPath(runId, request.dispatchId);
  const diffAbs = join(root, diffRel);
  assert.equal(existsSync(diffAbs), false, 'no diff should exist before degraded fail');
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'oops vanished' });
  assert.equal(fail.state, 'failed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.ok(termExtra);
  assert.equal(termExtra.workspace_mode, 'isolated');
  assert.equal(termExtra.workspace, startExtra.workspace);
  assert.equal(termExtra.base_commit, startExtra.base_commit);
  assert.equal(Object.hasOwn(termExtra, 'diff_snapshot'), false);
  assert.equal(Object.hasOwn(termExtra, 'diff_bytes'), false);
  assert.equal(existsSync(diffAbs), false, 'no .diff file should have been created for degraded fail');
});

test('dispatch-complete still refuses when isolated evidence is absent', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  vanishIsolatedStateAndWorktree(root, runId, request.dispatchId);
  const diffRel = hostIsolatedDiffPath(runId, request.dispatchId);
  const tmp = join(root, 'out.md');
  writeFileSync(tmp, 'final');
  const expected = `host dispatch "${request.dispatchId}" isolated worktree is missing and no diff was recorded at "${diffRel}".`;
  assert.throws(() => runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp }), (err: unknown) => {
    assert.equal((err as Error).message, expected);
    return true;
  });
  assert.equal(readTerminal(runDir, request.dispatchId), null, 'no terminal appended after refused complete');
});

test('degraded terminal stays readable via verify, show and ledger schema', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const startExtra = readStartExtra(runDir, request.dispatchId) as any;
  vanishIsolatedStateAndWorktree(root, runId, request.dispatchId);
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'degraded readable' });
  // verify: host-dispatch checks must pass; overall terminal-status is expected to be incomplete (run still running)
  const verify = runVerify({ repoRoot: root, run: runId });
  assert.equal(verify.findings.find((f) => f.check === 'host-dispatch-lifecycle')!.status, 'ok', `host-dispatch-lifecycle should pass: ${JSON.stringify(verify.findings)}`);
  assert.equal(verify.findings.find((f) => f.check === 'host-dispatch-artifacts')!.status, 'ok');
  // show projects isolated without diff
  const shown = runShow({ repoRoot: root, run: runId });
  const reqView = shown.projection!.requests.find((r) => r.dispatchId === request.dispatchId)!;
  assert.ok(reqView);
  assert.equal(reqView.workspaceMode, 'isolated');
  assert.equal(reqView.workspace, startExtra.workspace);
  assert.equal(reqView.baseCommit, startExtra.base_commit);
  assert.equal(reqView.diffSnapshot, null);
  assert.equal(reqView.diffBytes, null);
});

test('dispatch-fail still throws when the worktree exists and collection fails', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'crash.txt'), 'content\n');
  const outputsDir = join(root, '.fadeno', 'local', 'outputs');
  rmSync(outputsDir, { recursive: true, force: true });
  writeFileSync(outputsDir, 'block');
  assert.throws(() => runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'should fail' }), (err: unknown) => {
    assert.match((err as Error).message, /ENOTDIR|not a directory|could not/i);
    return true;
  });
  assert.equal(existsSync(wtAbs), true, 'worktree preserved after diff failure on fail');
  assert.equal(readTerminal(runDir, request.dispatchId), null, 'no terminal appended after diff failure');
  rmSync(outputsDir, { force: true });
  mkdirSync(outputsDir, { recursive: true });
  rmSync(wtAbs, { recursive: true, force: true });
  pruneWorktrees(root);
});

test('isolated progress does not touch the shared lease (byte-identical under conflicting live lease)', (t) => {
  const { root, runId, request } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-iso' });
  // Acquire a live shared lease for the dispatch's own holder — pre-fix this
  // would heartbeat successfully and advance heartbeat_at, post-fix it must not.
  const holder = { id: request.dispatchId, kind: 'host-dispatch' as const, runId, dispatchId: request.dispatchId };
  const nowLease = new Date('2026-08-17T01:00:00.000Z');
  acquireWorkspaceLease({
    repoRoot: root,
    workspaceMode: 'shared',
    holder,
    supervisorPid: process.pid,
    executorPid: null,
    processGroupId: null,
    startedAt: nowLease,
    heartbeatAt: nowLease,
    stdoutBytes: 0,
    stderrBytes: 0,
    now: nowLease,
  });
  const leasePath = join(root, WORKSPACE_LEASE_FILE);
  assert.ok(existsSync(leasePath));
  const beforeText = readFileSync(leasePath, 'utf8');
  const report = join(root, 'isolated-progress.json');
  writeFileSync(report, JSON.stringify({ state: 'running', summary: 'isolated working', updated_at: '2026-08-17T01:01:00.000Z' }));
  const receipt = runDispatchProgress({ repoRoot: root, run: runId, dispatchId: request.dispatchId, file: report, now: new Date('2026-08-17T01:02:00.000Z') });
  assert.equal(receipt.state, 'running');
  const afterText = readFileSync(leasePath, 'utf8');
  assert.equal(afterText, beforeText, 'isolated progress must leave lease file byte-identical even for its own holder');
  const lease = JSON.parse(afterText);
  assert.equal(lease.holder.id, request.dispatchId);
  assert.equal(lease.heartbeat_at, nowLease.toISOString(), 'isolated progress must not advance heartbeat_at');
  // cleanup
  rmSync(leasePath, { force: true });
});

test('shared progress still heartbeats its own lease', (t) => {
  const { root, runId, request } = seedIsolatedRun(t);
  // shared path: no prepare
  const startAt = new Date('2026-08-17T02:00:00.000Z');
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-shared', now: startAt });
  const leasePath = join(root, WORKSPACE_LEASE_FILE);
  assert.ok(existsSync(leasePath));
  const beforeLease = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.equal(beforeLease.heartbeat_at, startAt.toISOString());
  const report = join(root, 'shared-progress.json');
  writeFileSync(report, JSON.stringify({ state: 'running', summary: 'shared working', updated_at: '2026-08-17T02:01:00.000Z' }));
  const later = new Date('2026-08-17T02:05:00.000Z');
  const receipt = runDispatchProgress({ repoRoot: root, run: runId, dispatchId: request.dispatchId, file: report, now: later });
  assert.equal(receipt.state, 'running');
  const afterLease = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.equal(afterLease.heartbeat_at, later.toISOString(), 'shared progress should advance heartbeat_at');
});

test('isolated and shared terminal events differ by exactly the five isolated keys', (t) => {
  const EXPECTED = ['workspace_mode', 'workspace', 'base_commit', 'diff_snapshot', 'diff_bytes'].sort();
  // Paired fixtures are created independently. Their minute-stamped run ids are
  // embedded in both the prompt bytes and snapshot path, so a clock rollover
  // may legitimately change these two provenance values without changing the
  // shared-vs-isolated terminal contract under test.
  const excludeFromValueCheck = new Set([
    'dispatch_id',
    'agent_id',
    'output',
    'prompt_path',
    'prompt_sha256',
  ]);

  function assertParity(sharedExtra: Record<string, unknown>, isolatedExtra: Record<string, unknown>, expectedDelta: string[]) {
    const sharedKeys = Object.keys(sharedExtra).sort();
    const isolatedKeys = Object.keys(isolatedExtra).sort();
    const isolatedMinusShared = isolatedKeys.filter((k) => !sharedKeys.includes(k)).sort();
    const sharedMinusIsolated = sharedKeys.filter((k) => !isolatedKeys.includes(k)).sort();
    assert.deepEqual(isolatedMinusShared, expectedDelta.slice().sort(), `isolated minus shared should be ${expectedDelta}`);
    assert.deepEqual(sharedMinusIsolated, [], 'shared minus isolated should be empty');
    for (const key of sharedKeys) {
      if (excludeFromValueCheck.has(key)) continue;
      // workspace_mode etc are not in shared, already handled, so remaining shared keys should equal isolated
      assert.deepEqual(isolatedExtra[key], sharedExtra[key], `shared key ${key} value should be equal in isolated`);
    }
  }

  // helper to create a run with given playbook and return terminal extra
  function createValid(t: import('node:test').TestContext, useIsolated: boolean): { extra: Record<string, unknown>; root: string; runId: string; runDir: string; dispatchId: string } {
    const root = tempRepo(t);
    initGit(root);
    runInit({ target: 'codex', repoRoot: root });
    writeFileSync(join(root, '.fadeno', 'playbooks', 'isolated-host-fixture.yaml'), PLAYBOOK);
    writeFileSync(join(root, 'task.md'), 'do the thing');
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
      schema_version: 3,
      models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
      routes: { standalone: { dummy: { host: true }, 'current-host': { host: true } }, codex: { dummy: { host: true }, 'current-host': { host: true } }, claude: { dummy: { host: true }, 'current-host': { host: true } }, grok: { dummy: { host: true }, 'current-host': { host: true } } },
      archetypes: { worker: {} },
      bindings: { worker: 'luna' },
    }));
    const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'isolated-host-fixture', task: 'isolated test', inputs: ['Task=task.md'] });
    const driven = runDrive({ repoRoot: root, run: runId });
    assert.equal(driven.outcome, 'awaiting_host_dispatch');
    const request = driven.requests[0]!;
    if (useIsolated) {
      const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
      runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
      const wtAbs = resolve(root, prep.workspace);
      writeFileSync(join(wtAbs, 'parity.txt'), 'parity\n');
    } else {
      runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
    }
    const out = join(root, 'out.md');
    writeFileSync(out, 'final output parity');
    runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: out });
    const term = readTerminalExtra(runDir, request.dispatchId) as Record<string, unknown>;
    return { extra: term, root, runId, runDir, dispatchId: request.dispatchId };
  }

  // typed playbook for invalid parked case
  const TYPED_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: host-repair-fixture
description: Host schema repair fixture.
roles:
  agent_1: { purpose: Structured worker. }
inputs:
  Agent1Spec: { media_type: text/markdown }
flow:
  - id: implement
    kind: actor_call
    actor: agent_1
    input: [Agent1Spec]
    output: ReviewReport
    terminal_status: completed
`;
  function createInvalid(t: import('node:test').TestContext, useIsolated: boolean): Record<string, unknown> {
    const root = tempRepo(t);
    initGit(root);
    runInit({ target: 'codex', repoRoot: root });
    writeFileSync(join(root, '.fadeno', 'playbooks', 'host-repair-fixture.yaml'), TYPED_PLAYBOOK);
    writeFileSync(join(root, 'agent-1.md'), 'structured work');
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
      schema_version: 3,
      models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
      routes: { standalone: { dummy: { host: true }, 'current-host': { host: true } }, codex: { dummy: { host: true }, 'current-host': { host: true } }, claude: { dummy: { host: true }, 'current-host': { host: true } }, grok: { dummy: { host: true }, 'current-host': { host: true } } },
      archetypes: { agent_1: {} },
      bindings: { agent_1: 'luna' },
    }));
    const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'host-repair-fixture', task: 'repair', inputs: ['Agent1Spec=agent-1.md'] });
    const driven = runDrive({ repoRoot: root, run: runId });
    assert.equal(driven.outcome, 'awaiting_host_dispatch');
    const request = driven.requests[0]!;
    if (useIsolated) {
      const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
      runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
      const wtAbs = resolve(root, prep.workspace);
      writeFileSync(join(wtAbs, 'typed.txt'), 'x\n');
    } else {
      runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
    }
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{}');
    runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: bad });
    const term = readTerminalExtra(runDir, request.dispatchId) as Record<string, unknown>;
    return term;
  }

  function createFailed(t: import('node:test').TestContext, useIsolated: boolean): Record<string, unknown> {
    const root = tempRepo(t);
    initGit(root);
    runInit({ target: 'codex', repoRoot: root });
    writeFileSync(join(root, '.fadeno', 'playbooks', 'isolated-host-fixture.yaml'), PLAYBOOK);
    writeFileSync(join(root, 'task.md'), 'do the thing');
    writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
      schema_version: 3,
      models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
      routes: { standalone: { dummy: { host: true }, 'current-host': { host: true } }, codex: { dummy: { host: true }, 'current-host': { host: true } }, claude: { dummy: { host: true }, 'current-host': { host: true } }, grok: { dummy: { host: true }, 'current-host': { host: true } } },
      archetypes: { worker: {} },
      bindings: { worker: 'luna' },
    }));
    const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'isolated-host-fixture', task: 'isolated test', inputs: ['Task=task.md'] });
    const driven = runDrive({ repoRoot: root, run: runId });
    assert.equal(driven.outcome, 'awaiting_host_dispatch');
    const request = driven.requests[0]!;
    if (useIsolated) {
      const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
      runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
      const wtAbs = resolve(root, prep.workspace);
      writeFileSync(join(wtAbs, 'fail.txt'), 'x\n');
    } else {
      runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
    }
    runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'oops' });
    const term = readTerminalExtra(runDir, request.dispatchId) as Record<string, unknown>;
    return term;
  }

  // valid completed
  const sharedValid = createValid(t, false);
  const isolatedValid = createValid(t, true);
  assertParity(sharedValid.extra as Record<string, unknown>, isolatedValid.extra as Record<string, unknown>, EXPECTED);

  // invalid parked
  const sharedInvalid = createInvalid(t, false);
  const isolatedInvalid = createInvalid(t, true);
  assertParity(sharedInvalid, isolatedInvalid, EXPECTED);

  // failed normal (with diff)
  const sharedFailed = createFailed(t, false);
  const isolatedFailed = createFailed(t, true);
  assertParity(sharedFailed, isolatedFailed, EXPECTED);

  // degraded failed (no diff)
  const { root: dRoot, runId: dRunId, runDir: dRunDir, request: dReq } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: dRoot, run: dRunId, dispatchId: dReq.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: dRoot, run: dRunId, dispatchId: dReq.dispatchId, agentId: 'host-1' });
  vanishIsolatedStateAndWorktree(dRoot, dRunId, dReq.dispatchId);
  runDispatchFail({ repoRoot: dRoot, run: dRunId, dispatchId: dReq.dispatchId, reason: 'oops' });
  const degradedExtra = readTerminalExtra(dRunDir, dReq.dispatchId) as Record<string, unknown>;
  // compare degraded isolated vs shared failed
  const expectedDegraded = ['workspace_mode', 'workspace', 'base_commit'].sort();
  assertParity(sharedFailed, degradedExtra, expectedDegraded);
});

test('dispatch-fail collects diff when only state file vanished but worktree remains', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'state-vanished.txt'), 'hello from worktree\n');
  // Remove only the state file, leave worktree intact
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`), { force: true });
  assert.ok(existsSync(wtAbs) && statSync(wtAbs).isDirectory(), 'worktree should still exist');
  const diffRel = hostIsolatedDiffPath(runId, request.dispatchId);
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'state gone but worktree present' });
  assert.equal(fail.state, 'failed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(termExtra.workspace_mode, 'isolated');
  assert.equal(termExtra.workspace, prep.workspace);
  // Should have collected real diff, not degraded
  assert.ok(Object.hasOwn(termExtra, 'diff_snapshot'));
  assert.ok(Object.hasOwn(termExtra, 'diff_bytes'));
  assert.equal(termExtra.diff_snapshot, diffRel);
  assert.ok(typeof termExtra.diff_bytes === 'number' && termExtra.diff_bytes > 0);
  assert.ok(existsSync(join(root, diffRel)), 'diff file should exist');
  const diffContent = readFileSync(join(root, diffRel), 'utf8');
  assert.ok(diffContent.includes('state-vanished.txt'));
  assert.ok(!diffContent.includes('host-untracked'), 'diff should not contain host-only paths');
  // Worktree should have been cleaned up, state-vanished txt no longer on host-worktree path (which was removed) but diff retained
  assert.equal(existsSync(wtAbs), false, 'worktree should be removed after successful diff collection');
});

test('dispatch-fail does not stage or delete a plain directory at ledger workspace (adversarial)', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const startExtra = readStartExtra(runDir, request.dispatchId) as any;
  const wtAbs = resolve(root, startExtra.workspace);
  // Capture host dirty state tracking: we will seed a dirty file to ensure it is not staged
  const dirtyPath = join(root, 'dirty-host.txt');
  writeFileSync(dirtyPath, 'host-dirty\n');
  const untrackedPath = join(root, 'untracked-host.txt');
  writeFileSync(untrackedPath, 'untracked\n');
  const beforePorcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const beforeCached = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  // Vanish state+worktree and recreate plain directory
  vanishIsolatedStateAndWorktree(root, runId, request.dispatchId);
  mkdirSync(wtAbs, { recursive: true });
  writeFileSync(join(wtAbs, 'orphan.txt'), 'orphan\n');
  assert.ok(existsSync(wtAbs));
  const diffRel = hostIsolatedDiffPath(runId, request.dispatchId);
  const diffAbs = join(root, diffRel);
  // Remove any leftover diff
  rmSync(diffAbs, { force: true });
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'plain-dir' });
  assert.equal(fail.state, 'failed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(termExtra.workspace_mode, 'isolated');
  assert.equal(termExtra.workspace, startExtra.workspace);
  assert.equal(termExtra.base_commit, startExtra.base_commit);
  assert.equal(Object.hasOwn(termExtra, 'diff_snapshot'), false);
  assert.equal(Object.hasOwn(termExtra, 'diff_bytes'), false);
  assert.equal(existsSync(diffAbs), false, 'no .diff file should have been created for plain directory');
  assert.equal(existsSync(wtAbs), true, 'plain directory must not be deleted');
  assert.equal(existsSync(join(wtAbs, 'orphan.txt')), true);
  assert.equal(readFileSync(join(wtAbs, 'orphan.txt'), 'utf8'), 'orphan\n');
  const afterPorcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const afterCached = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  assert.equal(afterPorcelain, beforePorcelain, 'host porcelain must be unchanged');
  assert.equal(afterCached, beforeCached, 'no staged changes must be introduced');
  assert.equal(afterCached.trim(), '', 'index must remain empty');
  // cleanup dirty files
  rmSync(dirtyPath, { force: true });
  rmSync(untrackedPath, { force: true });
  // restore host repo to clean (remove untracked from index view)
  spawnSync('git', ['-C', root, 'reset', '--hard', 'HEAD'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  spawnSync('git', ['-C', root, 'clean', '-fd'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
});

test('broken registration: dangling .git pointer degrades without deleting plain dir (fail + complete)', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  const startExtra = readStartExtra(runDir, request.dispatchId) as any;
  writeFileSync(join(wtAbs, 'agent.txt'), 'agent work\n');
  const beforePorcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const beforeCached = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  // Break registration by removing admin data via gitdir file
  {
    const gitFile = readFileSync(join(wtAbs, '.git'), 'utf8');
    const gitdir = gitFile.trim().replace(/^gitdir:\s*/, '');
    rmSync(gitdir, { recursive: true, force: true });
  }
  // Also remove state file to force ledger recovery path
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`), { force: true });
  // worktree directory still exists with .git file pointing to now-missing admin
  assert.ok(existsSync(wtAbs));
  const diffRel = hostIsolatedDiffPath(runId, request.dispatchId);
  const diffAbs = join(root, diffRel);
  rmSync(diffAbs, { force: true });
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'broken-reg' });
  assert.equal(fail.state, 'failed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(Object.hasOwn(termExtra, 'diff_snapshot'), false);
  assert.equal(Object.hasOwn(termExtra, 'diff_bytes'), false);
  assert.equal(existsSync(wtAbs), true, 'worktree preserved when registration broken');
  const afterPorcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const afterCached = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  assert.equal(afterPorcelain, beforePorcelain);
  assert.equal(afterCached, beforeCached);
  assert.equal(afterCached.trim(), '');
  // Now test complete refuses on same shape (new run to avoid terminal conflict)
  const { root: root2, runId: runId2, runDir: runDir2, request: req2 } = seedIsolatedRun(t);
  const prep2 = runDispatchPrepare({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, agentId: 'host-1' });
  const wtAbs2 = resolve(root2, prep2.workspace);
  writeFileSync(join(wtAbs2, 'agent2.txt'), 'agent2\n');
  {
    const gitFile = readFileSync(join(wtAbs2, '.git'), 'utf8');
    const gitdir = gitFile.trim().replace(/^gitdir:\s*/, '');
    rmSync(gitdir, { recursive: true, force: true });
  }
  rmSync(join(root2, '.fadeno', 'local', 'host-workspaces', runId2, `${req2.dispatchId}.json`), { force: true });
  const tmp = join(root2, 'out2.md');
  writeFileSync(tmp, 'final');
  assert.throws(() => runDispatchComplete({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, output: tmp }), (err: unknown) => {
    assert.match((err as Error).message, /missing and no diff|isolated worktree/i);
    return true;
  });
  assert.equal(existsSync(wtAbs2), true, 'worktree preserved after failed complete');
  // cleanup
  rmSync(wtAbs2, { recursive: true, force: true });
  pruneWorktrees(root2);
});

test('corrupt machine-local state does not prevent degraded or collected fail', (t) => {
  // (a) with verified worktree present -> collects
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'corrupt-a.txt'), 'a\n');
  const statePath = join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`);
  writeFileSync(statePath, '{ truncated');
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'corrupt-preserved' });
  assert.equal(fail.state, 'failed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.ok(Object.hasOwn(termExtra, 'diff_snapshot'), 'should collect when worktree verified despite corrupt state');
  assert.ok(Object.hasOwn(termExtra, 'diff_bytes'));
  assert.ok(existsSync(join(root, termExtra.diff_snapshot)));
  const diffContent = readFileSync(join(root, termExtra.diff_snapshot), 'utf8');
  assert.ok(diffContent.includes('corrupt-a.txt'));
  assert.equal(existsSync(wtAbs), false, 'worktree removed after successful collection');

  // (b) with worktree gone -> degraded
  const { root: root2, runId: runId2, runDir: runDir2, request: req2 } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, agentId: 'host-1' });
  const startExtra2 = readStartExtra(runDir2, req2.dispatchId) as any;
  vanishIsolatedStateAndWorktree(root2, runId2, req2.dispatchId);
  // Recreate state file as corrupt
  const corruptPath = join(root2, '.fadeno', 'local', 'host-workspaces', runId2, `${req2.dispatchId}.json`);
  mkdirSync(join(root2, '.fadeno', 'local', 'host-workspaces', runId2), { recursive: true });
  writeFileSync(corruptPath, 'not json');
  const fail2 = runDispatchFail({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, reason: 'corrupt-degraded' });
  assert.equal(fail2.state, 'failed');
  const termExtra2 = readTerminalExtra(runDir2, req2.dispatchId) as any;
  assert.equal(termExtra2.workspace, startExtra2.workspace);
  assert.equal(Object.hasOwn(termExtra2, 'diff_snapshot'), false);
  assert.equal(Object.hasOwn(termExtra2, 'diff_bytes'), false);
});

test('dispatch-complete recovers and collects from verified ledger worktree when state vanished', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'recover-complete.txt'), 'recovered\n');
  // Remove only state file
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`), { force: true });
  assert.ok(existsSync(wtAbs));
  const tmp = join(root, 'out-complete.md');
  writeFileSync(tmp, 'final complete');
  const comp = runDispatchComplete({ repoRoot: root, run: runId, dispatchId: request.dispatchId, output: tmp });
  assert.equal(comp.state, 'completed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(termExtra.workspace_mode, 'isolated');
  assert.equal(termExtra.workspace, prep.workspace);
  assert.ok(Object.hasOwn(termExtra, 'diff_snapshot'));
  assert.ok(Object.hasOwn(termExtra, 'diff_bytes'));
  const diffAbs = join(root, termExtra.diff_snapshot as string);
  assert.ok(existsSync(diffAbs));
  const diffText = readFileSync(diffAbs, 'utf8');
  assert.ok(diffText.includes('recover-complete.txt'), 'diff should contain agent file');
  assert.ok(!diffText.includes('dirty-host'), 'diff should not contain host-only paths');
  assert.equal(existsSync(wtAbs), false, 'worktree removed after successful complete recovery');
});

test('dispatch-fail degraded when verified worktree collection fails (preserves worktree)', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'preserve.txt'), 'preserve\n');
  // Remove state, keep verified worktree, but block outputs dir
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`), { force: true });
  const outputsDir = join(root, '.fadeno', 'local', 'outputs');
  rmSync(outputsDir, { recursive: true, force: true });
  writeFileSync(outputsDir, 'block');
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'recovery-fail-preserve' });
  assert.equal(fail.state, 'failed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(Object.hasOwn(termExtra, 'diff_snapshot'), false, 'degraded without diff keys');
  assert.equal(Object.hasOwn(termExtra, 'diff_bytes'), false);
  assert.equal(existsSync(wtAbs), true, 'worktree preserved when recovery collection failed');
  assert.equal(readTerminalExtra(runDir, request.dispatchId)?.workspace, prep.workspace);
  // cleanup block
  rmSync(outputsDir, { force: true });
  mkdirSync(outputsDir, { recursive: true });
  // cleanup worktree
  rmSync(wtAbs, { recursive: true, force: true });
  pruneWorktrees(root);
});

test('dirty host tree remains untouched through plain-dir and broken-reg fail', (t) => {
  const { root, runId, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  // Seed host dirty state
  writeFileSync(join(root, 'base.txt'), 'dirty-base-host\n');
  const untracked = join(root, 'host-untracked.txt');
  writeFileSync(untracked, 'untracked-host\n');
  const beforePorcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const beforeCached = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  // plain-dir shape: vanish and recreate plain dir
  vanishIsolatedStateAndWorktree(root, runId, request.dispatchId);
  mkdirSync(wtAbs, { recursive: true });
  writeFileSync(join(wtAbs, 'plain-untouched.txt'), 'x\n');
  runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'dirty-plain' });
  const afterPorcelain1 = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const afterCached1 = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  assert.equal(afterPorcelain1, beforePorcelain);
  assert.equal(afterCached1, beforeCached);
  assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'dirty-base-host\n');
  assert.ok(existsSync(untracked));
  // cleanup for second shape: new run in separate repo, also dirty
  spawnSync('git', ['-C', root, 'reset', '--hard', 'HEAD'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  spawnSync('git', ['-C', root, 'clean', '-fd'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const { root: root2, runId: runId2, request: req2 } = seedIsolatedRun(t);
  const prep2 = runDispatchPrepare({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, agentId: 'host-1' });
  const wtAbs2 = resolve(root2, prep2.workspace);
  writeFileSync(join(wtAbs2, 'agent2.txt'), 'hi\n');
  // Seed dirty state in root2
  writeFileSync(join(root2, 'base.txt'), 'dirty2\n');
  const untracked2 = join(root2, 'host-untracked2.txt');
  writeFileSync(untracked2, 'untracked2\n');
  const beforePorcelain2 = spawnSync('git', ['-C', root2, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const beforeCached2 = spawnSync('git', ['-C', root2, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  {
    const gitFile = readFileSync(join(wtAbs2, '.git'), 'utf8');
    const gitdir = gitFile.trim().replace(/^gitdir:\s*/, '');
    rmSync(gitdir, { recursive: true, force: true });
  }
  rmSync(join(root2, '.fadeno', 'local', 'host-workspaces', runId2, `${req2.dispatchId}.json`), { force: true });
  runDispatchFail({ repoRoot: root2, run: runId2, dispatchId: req2.dispatchId, reason: 'dirty-broken' });
  const afterPorcelain2 = spawnSync('git', ['-C', root2, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const afterCached2 = spawnSync('git', ['-C', root2, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  assert.equal(afterPorcelain2, beforePorcelain2, 'broken-reg dirty host tree must remain untouched');
  assert.equal(afterCached2, beforeCached2);
  assert.equal(afterCached2.trim(), '');
  assert.equal(readFileSync(join(root2, 'base.txt'), 'utf8'), 'dirty2\n');
  assert.ok(existsSync(untracked2));
  rmSync(wtAbs2, { recursive: true, force: true });
  pruneWorktrees(root2);
});

test('degraded fail preserves worktree across idempotent replay', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'preserve.txt'), 'preserve\n');
  // Vanish state, keep verified worktree, but block outputs to force recovery collection failure
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`), { force: true });
  const outputsDir = join(root, '.fadeno', 'local', 'outputs');
  rmSync(outputsDir, { recursive: true, force: true });
  writeFileSync(outputsDir, 'block');
  const first = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'preserve-replay' });
  assert.equal(first.state, 'failed');
  assert.equal(first.idempotent, false);
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(Object.hasOwn(termExtra, 'diff_snapshot'), false, 'degraded without diff');
  assert.equal(existsSync(wtAbs), true, 'worktree preserved after degraded');
  assert.equal(existsSync(join(wtAbs, 'preserve.txt')), true);
  // Second identical fail must be idempotent and must not delete the preserved worktree
  const second = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'preserve-replay' });
  assert.equal(second.state, 'failed');
  assert.equal(second.idempotent, true, 'degraded replay must be idempotent');
  assert.equal(existsSync(wtAbs), true, 'worktree still preserved after idempotent replay');
  assert.equal(existsSync(join(wtAbs, 'preserve.txt')), true);
  // Mismatched replay (different reason) must throw but still preserve
  assert.throws(() => runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'different-reason' }), (err: unknown) => {
    assert.match((err as Error).message, /already has a different terminal receipt/);
    return true;
  });
  assert.equal(existsSync(wtAbs), true, 'worktree still preserved after mismatched replay');
  // cleanup
  rmSync(outputsDir, { force: true });
  mkdirSync(outputsDir, { recursive: true });
  rmSync(wtAbs, { recursive: true, force: true });
  pruneWorktrees(root);
});

test('degraded both-vanished replay is idempotent', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  vanishIsolatedStateAndWorktree(root, runId, request.dispatchId);
  const first = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'both-gone' });
  assert.equal(first.state, 'failed');
  const termExtra = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(Object.hasOwn(termExtra, 'diff_snapshot'), false);
  // second identical fail must be idempotent, not throw missing-evidence
  const second = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'both-gone' });
  assert.equal(second.idempotent, true);
  // also dispatch-complete replay on degraded shape should not throw with false missing-evidence message? Actually complete on degraded should still refuse via settle? But fail replay should succeed.
});

test('ledger workspace pointing to sibling worktree is ignored and leaves sibling untouched', (t) => {
  const { root, runId, runDir, request } = seedIsolatedRun(t);
  const prep = runDispatchPrepare({ repoRoot: root, run: runId, dispatchId: request.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-1' });
  const wtAbs = resolve(root, prep.workspace);
  writeFileSync(join(wtAbs, 'original.txt'), 'original\n');
  // Create sibling dispatch in same repo
  writeFileSync(join(root, 'task2.md'), 'task2');
  const { runId: runId2 } = runNewRun({ repoRoot: root, playbook: 'isolated-host-fixture', task: 'sibling', inputs: ['Task=task2.md'] });
  const driven2 = runDrive({ repoRoot: root, run: runId2 });
  assert.equal(driven2.outcome, 'awaiting_host_dispatch');
  const req2 = driven2.requests[0]!;
  const prep2 = runDispatchPrepare({ repoRoot: root, run: runId2, dispatchId: req2.dispatchId, isolate: true });
  runDispatchStart({ repoRoot: root, run: runId2, dispatchId: req2.dispatchId, agentId: 'host-1' });
  const wtAbs2 = resolve(root, prep2.workspace);
  writeFileSync(join(wtAbs2, 'sibling.txt'), 'sibling\n');
  // Vanish state for first dispatch to force ledger recovery path
  rmSync(join(root, '.fadeno', 'local', 'host-workspaces', runId, `${request.dispatchId}.json`), { force: true });
  // Tamper ledger: make first dispatch's workspace point to sibling's worktree
  const eventsPath = join(runDir, 'events.jsonl');
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter((l) => l.trim().length > 0);
  const events = lines.map((l) => JSON.parse(l));
  let tamp = false;
  for (const ev of events) {
    if (ev.type === 'actor_dispatched') {
      const did = (ev as any).dispatch_id ?? (ev.extra as any)?.dispatch_id ?? (ev.extra as any)?.dispatchId;
      if (did == null || did === request.dispatchId) {
        (ev as any).workspace = prep2.workspace;
        if ((ev as any).extra != null) (ev as any).extra.workspace = prep2.workspace;
        tamp = true;
      }
    }
  }
  assert.equal(tamp, true, 'found start event to tamper');
  writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // Now dispatch-fail on first dispatch should degrade (not collect sibling's diff) and leave sibling untouched
  const beforeSiblingPorcelain = spawnSync('git', ['-C', wtAbs2, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  const fail = runDispatchFail({ repoRoot: root, run: runId, dispatchId: request.dispatchId, reason: 'sibling-attack' });
  assert.equal(fail.state, 'failed');
  const termExtra2 = readTerminalExtra(runDir, request.dispatchId) as any;
  assert.equal(Object.hasOwn(termExtra2, 'diff_snapshot'), false, 'must degrade, not collect sibling diff');
  // Sibling worktree must still exist and be untouched
  assert.equal(existsSync(wtAbs2), true, 'sibling worktree must not be deleted');
  assert.equal(existsSync(join(wtAbs2, 'sibling.txt')), true);
  assert.equal(readFileSync(join(wtAbs2, 'sibling.txt'), 'utf8'), 'sibling\n');
  const afterSiblingPorcelain = spawnSync('git', ['-C', wtAbs2, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  assert.equal(afterSiblingPorcelain, beforeSiblingPorcelain);
  // Original worktree should be preserved (since we degraded)
  assert.equal(existsSync(wtAbs), true, 'original worktree preserved when ledger was mis-stamped');
  assert.equal(existsSync(join(wtAbs, 'original.txt')), true);
  // cleanup
  rmSync(wtAbs, { recursive: true, force: true });
  rmSync(wtAbs2, { recursive: true, force: true });
  pruneWorktrees(root);
});

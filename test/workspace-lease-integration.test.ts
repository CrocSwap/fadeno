import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { DriveError, runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import {
  WORKSPACE_LEASE_FILE,
  acquireWorkspaceLease,
  readWorkspaceLease,
  releaseWorkspaceLease,
  type LeaseHolder,
} from '../src/lib/workspace-lease.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const user: UserPathOptions = { env: { FADENO_HARNESS: 'standalone' } };

function seedDispatch(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      writer: { provider: 'writerp', id: 'writer', effort: 'default' },
      reader: { provider: 'readerp', id: 'reader', effort: 'default' },
      unknown: { provider: 'unknownp', id: 'unknown', effort: 'default' },
    },
    routes: {
      standalone: {
        writerp: {
          command: ['node', '-e', "require('node:fs').writeFileSync('executor-write.txt','isolated');process.stdout.write('written')"],
          },
        readerp: {
          command: ['node', '-e', "process.stdout.write('read-only report')"],
          },
        unknownp: {
          command: ['node', '-e', "process.stdout.write('unknown posture')"],
        },
      },
    },
    archetypes: { worker: {}, reviewer: { } },
    dials: { worker: 'writer', reviewer: 'reader' },
  }));
  return root;
}

function durableHostLease(root: string): LeaseHolder {
  const holder: LeaseHolder = {
    id: 'host:other-run:hd-1',
    kind: 'host-dispatch',
    runId: 'other-run',
    dispatchId: 'hd-1',
  };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder, supervisorPid: null });
  return holder;
}

function evidence(root: string): Record<string, unknown>[] {
  if (!existsSync(join(root, DISPATCHES_FILE))) return [];
  return readFileSync(join(root, DISPATCHES_FILE), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function initGit(root: string): void {
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init']);
  git(['config', 'user.name', 'Fadeno Test']);
  git(['config', 'user.email', 'fadeno@example.invalid']);
  git(['add', '-A']);
  git(['commit', '-m', 'fixture']);
}

test('shared dispatch is blocked by a durable host lease; an ISOLATED one bypasses it', (t) => {
  // What changed: the bypass used to be granted to a delivery that DECLARED
  // itself read-only. Nothing declares that any more — `write_access` was a
  // claim Fadeno never verified — so every shared dispatch takes the lease.
  // The bypass now belongs to isolation, which is a fact about where the work
  // happens rather than a promise about what it will do, and isolation is the
  // default. See docs/experimental/permissions-and-isolation.md.
  const root = seedDispatch(t);
  const holder = durableHostLease(root);
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'write', repoRoot: root, shared: true, userPathOptions: user }),
    (error: unknown) => error instanceof DispatchCommandError && /shared workspace is already held/.test(error.message),
  );
  assert.throws(
    () => runDispatch({ archetype: 'reviewer', prompt: 'inspect', repoRoot: root, shared: true, userPathOptions: user }),
    (error: unknown) => error instanceof DispatchCommandError && /shared workspace is already held/.test(error.message),
    'no delivery can claim to be a non-writer any more, so a shared reviewer waits too',
  );
  const denied = evidence(root).filter((row) => row.event === 'workspace_lease_reclaim_denied');
  assert.equal(denied.length, 2, 'each refused shared dispatch must leave a recovery-denial audit row');
  assert.ok(denied.every((row) => row.reason === 'abandoned_host' && row.previous_holder != null));
  assert.deepEqual(readWorkspaceLease(root)?.holder, holder, 'a refused dispatch must not disturb the writer lease');
  releaseWorkspaceLease({ repoRoot: root, holder });
});

test('ad-hoc dispatch audits atomic reclamation of a dead supervisor lease', (t) => {
  const root = seedDispatch(t);
  const stale = { id: 'dead-writer', kind: 'ad-hoc' as const };
  acquireWorkspaceLease({ repoRoot: root, workspaceMode: 'shared', holder: stale, supervisorPid: 999_999_999 });
  const result = runDispatch({ archetype: 'worker', prompt: 'reclaim', repoRoot: root, userPathOptions: user });
  assert.equal(result.stdout, 'written');
  const recovered = evidence(root).find((row) => row.event === 'workspace_lease_recovered');
  assert.deepEqual(recovered?.previous_holder, stale);
  assert.equal(recovered?.reason, 'dead_supervisor');
  assert.equal(typeof recovered?.recovered_at, 'string');
});

test('normal shared dispatch uses a full identity lease and releases it after executor close', (t) => {
  const root = seedDispatch(t);
  const result = runDispatch({ archetype: 'worker', prompt: 'write', repoRoot: root, userPathOptions: user });
  assert.equal(result.stdout, 'written');
  assert.equal(readWorkspaceLease(root), null);
  const [requested, completed] = evidence(root).slice(-2);
  assert.equal(requested?.workspace_mode, 'shared');
  assert.equal(completed?.workspace_mode, 'shared');
});

test('isolated dispatch bypasses a live shared lease, emits a binary diff, and never merges', (t) => {
  const root = seedDispatch(t);
  initGit(root);
  writeFileSync(join(root, 'user-dirty.txt'), 'preserve me\n');
  const holder = durableHostLease(root);

  const result = runDispatch({ archetype: 'worker', prompt: 'write', isolate: true, repoRoot: root, userPathOptions: user });
  assert.equal(result.stdout, 'written');
  assert.equal(existsSync(join(root, 'executor-write.txt')), false, 'isolated changes must not be merged');
  assert.equal(readFileSync(join(root, 'user-dirty.txt'), 'utf8'), 'preserve me\n');
  const completed = evidence(root).findLast((row) => row.event === 'dispatch_completed');
  assert.equal(completed?.workspace_mode, 'isolated');
  assert.equal(typeof completed?.diff_snapshot, 'string');
  assert.ok((completed?.diff_bytes as number) > 0);
  const diff = readFileSync(join(root, completed?.diff_snapshot as string), 'utf8');
  assert.match(diff, /executor-write\.txt/);
  assert.deepEqual(readWorkspaceLease(root)?.holder, holder, 'isolated delivery must not touch the shared lease');
  releaseWorkspaceLease({ repoRoot: root, holder });
});

test('drive refuses a write-capable attempt before actor_dispatched while another run owns the lease', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { writer: { provider: 'writerp', id: 'writer', effort: 'default' } },
    routes: { standalone: { writerp: { command: ['node', '-e', "process.stdout.write('notes')"], } } },
    archetypes: { worker: { } },
    dials: { worker: 'writer' },
  }));
  writeFileSync(join(root, '.fadeno', 'playbooks', 'lease-drive.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'lease-drive',
    description: 'Lease boundary fixture.',
    roles: { worker: { purpose: 'Write.', archetype: 'worker' } },
    flow: [{ id: 'work', kind: 'actor_call', actor: 'worker', output: 'Notes', terminal_status: 'completed' }],
  }));
  const created = runNewRun({ playbook: 'lease-drive', task: 'lease integration', repoRoot: root, userPathOptions: user });
  const holder = durableHostLease(root);
  assert.throws(
    () => runDrive({ run: created.runId, repoRoot: root, userPathOptions: user }),
    (error: unknown) => error instanceof DriveError && /shared workspace is already held/.test(error.message),
  );
  const events = readFileSync(join(created.runDir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /"type":"actor_dispatched"/);
  assert.match(events, /"type":"workspace_lease_reclaim_denied"/);
  assert.match(events, /"reason":"abandoned_host"/);
  assert.ok(existsSync(join(root, WORKSPACE_LEASE_FILE)));
  releaseWorkspaceLease({ repoRoot: root, holder });
});

function seedDanglingDrive(t: TestContext): { root: string; runId: string; runDir: string; actorCallId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { writer: { provider: 'writerp', id: 'writer', effort: 'default' } },
    routes: { standalone: { writerp: { command: ['node', '-e', "process.stdout.write('notes')"], } } },
    archetypes: { worker: { } },
    dials: { worker: 'writer' },
  }));
  writeFileSync(join(root, '.fadeno', 'playbooks', 'lease-recovery.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'lease-recovery',
    description: 'Lease recovery audit fixture.',
    roles: { worker: { purpose: 'Write.', archetype: 'worker' } },
    flow: [{ id: 'work', kind: 'actor_call', actor: 'worker', output: 'Notes', terminal_status: 'completed' }],
  }));
  const created = runNewRun({ playbook: 'lease-recovery', task: 'audit recovery', repoRoot: root, userPathOptions: user });
  const actorCallId = 'ac-interrupted-writer';
  new LedgerWriter(created.runDir).append({
    type: 'actor_dispatched',
    step: 'work',
    actor: 'worker',
    step_execution_id: 'work@interrupted',
    actor_call_id: actorCallId,
    attempt: 1,
    executor: 'writer',
  }, new Date('2026-08-17T12:00:00.000Z'));
  return { root, runId: created.runId, runDir: created.runDir, actorCallId };
}

test('dangling-attempt recovery labels a different live lease as active_writer', (t) => {
  const fixture = seedDanglingDrive(t);
  const holder = durableHostLease(fixture.root);

  assert.throws(
    () => runDrive({ run: fixture.runId, repoRoot: fixture.root, userPathOptions: user }),
    (error: unknown) => error instanceof DriveError && /shared workspace is already held/.test(error.message),
  );

  const audit = readEvents(fixture.runDir).events.find((event) => event.type === 'workspace_lease_reclaim_denied');
  assert.equal(audit?.extra.reason, 'active_writer');
  assert.deepEqual(audit?.extra.previous_holder, holder);
  assert.doesNotMatch(readFileSync(join(fixture.runDir, 'events.jsonl'), 'utf8'), /"reason":"engine_interrupted"/);
  releaseWorkspaceLease({ repoRoot: fixture.root, holder });
});

test('dangling-attempt recovery labels its own PID-less reservation as abandoned_engine', (t) => {
  const fixture = seedDanglingDrive(t);
  const holder: LeaseHolder = {
    id: `engine:${fixture.runId}:${fixture.actorCallId}:a1`,
    kind: 'engine',
    runId: fixture.runId,
    dispatchId: `${fixture.actorCallId}:a1`,
  };
  acquireWorkspaceLease({ repoRoot: fixture.root, workspaceMode: 'shared', holder, supervisorPid: null });

  runDrive({ run: fixture.runId, repoRoot: fixture.root, userPathOptions: user });

  const events = readEvents(fixture.runDir).events;
  const audit = events.find((event) =>
    event.type === 'workspace_lease_recovered' && event.extra.previous_holder != null,
  );
  assert.equal(audit?.extra.reason, 'abandoned_engine');
  assert.deepEqual(audit?.extra.previous_holder, holder);
  const interrupted = events.find((event) =>
    event.type === 'actor_failed' && event.extra.actor_call_id === fixture.actorCallId,
  );
  assert.equal(interrupted?.extra.reason, 'engine_interrupted');
  assert.equal(readWorkspaceLease(fixture.root), null);
});

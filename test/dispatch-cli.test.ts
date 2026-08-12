import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchCommandError, DISPATCHES_FILE, runDispatch } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runLoadoutUse } from '../src/commands/loadout.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

/**
 * `fadeno dispatch` (ad-hoc dispatch kernel) + run-path resolution integration.
 * Executors are `node -e` one-liners standing in for harness CLIs. All calls
 * pass `env: null` (or an explicit value) so a real FADENO_LOADOUT in the
 * developer's shell never leaks in.
 */

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

const EXECUTORS = {
  'echo-worker': { adapter: 'command', command: STDIN_ECHO('REPORT:'), model: 'opus' },
  'luna-worker': { adapter: 'command', command: STDIN_ECHO('LUNA:'), model: 'gpt-5.6-luna' },
  'fail-7': { adapter: 'command', command: ['node', '-e', 'process.exit(7)'] },
  'terra-host': { adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer' },
  'terra-fallback': {
    adapter: 'host', model: 'gpt-5.6-terra', reasoning_effort: 'high', agent_type: 'reviewer',
    fallback_command: STDIN_ECHO('TERRA:'),
  },
};

function seedProfile(t: TestContext, doc: Record<string, unknown>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(doc));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('dispatch: resolves the archetype via the active loadout, relays the report, appends evidence', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  const now = new Date('2026-08-09T12:00:00Z');
  const echoes: string[] = [];
  const result = runDispatch({
    archetype: 'worker',
    prompt: 'hello',
    repoRoot: root,
    env: null,
    now,
    onEcho: (line) => echoes.push(line),
  });

  assert.equal(result.stdout, 'REPORT:hello');
  assert.equal(result.exitCode, 0);
  assert.equal(result.executor, 'echo-worker');
  assert.equal(result.model, 'opus');
  assert.equal(result.source, 'loadout');
  assert.deepEqual(result.loadout, { name: 'main', source: 'default' });
  assert.equal(result.echo, 'worker → echo-worker (opus) [loadout main]');
  assert.deepEqual(echoes, [
    result.echo,
    "external sandbox: echo-worker (node -e let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('REPORT:'+d));) runs outside the current harness via command; evidence → .fadeno/dispatches.jsonl",
  ]);
  assert.equal(result.evidencePath, DISPATCHES_FILE);

  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.timestamp, now.toISOString());
  assert.equal(row.archetype, 'worker');
  assert.equal(row.role, null);
  assert.deepEqual(row.loadout, { name: 'main', source: 'default' });
  assert.equal(row.executor, 'echo-worker');
  assert.equal(row.model, 'opus');
  assert.equal(row.exit_code, 0);
  assert.equal(typeof row.duration_ms, 'number');
  assert.ok((row.duration_ms as number) >= 0);
  assert.equal(row.prompt_sha256, sha256Hex('hello'));
  assert.equal(row.output_sha256, sha256Hex('REPORT:hello'));

  // the log is append-only: a second dispatch adds a second row
  runDispatch({ archetype: 'worker', prompt: 'again', repoRoot: root, env: null });
  assert.equal(evidenceRows(root).length, 2);
});

test('dispatch: a --role binding pin wins; without --role a same-named binding is not consulted', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
    bindings: { implementer: 'luna-worker', worker: 'luna-worker' },
  });

  const pinned = runDispatch({
    archetype: 'worker',
    role: 'implementer',
    prompt: 'p',
    repoRoot: root,
    env: null,
  });
  assert.equal(pinned.executor, 'luna-worker');
  assert.equal(pinned.source, 'binding');
  assert.equal(pinned.echo, 'implementer → luna-worker (gpt-5.6-luna) [binding]');
  assert.equal(evidenceRows(root).at(-1)!.role, 'implementer');

  // Per-role pins apply only when --role names one: bindings.worker must not
  // shadow the loadout slot for archetype "worker".
  const unpinned = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, env: null });
  assert.equal(unpinned.executor, 'echo-worker');
  assert.equal(unpinned.source, 'loadout');
});

test('dispatch: falls through to the "*" default when the loadout has no slot', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
    bindings: { '*': 'luna-worker' },
  });
  const result = runDispatch({ archetype: 'judge', prompt: 'p', repoRoot: root, env: null });
  assert.equal(result.executor, 'luna-worker');
  assert.equal(result.source, 'default');
  // Display tag: the "*" fallback echoes as `fallback "*"`, never "default"
  // (which names the default_loadout concept); the recorded source stays 'default'.
  assert.equal(result.echo, 'judge → luna-worker (gpt-5.6-luna) [fallback "*"]');
});

test('dispatch: nothing serving the archetype is an actionable hard error', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  assert.throws(
    () => runDispatch({ archetype: 'judge', prompt: 'p', repoRoot: root, env: null }),
    (err: unknown) =>
      err instanceof DispatchCommandError &&
      /No executor for role "judge" \(archetype "judge"; active loadout "main" has no "judge" slot; no "\*" default binding\)/.test(err.message) &&
      /add a "judge" slot to loadout "main"/.test(err.message),
  );
  assert.deepEqual(evidenceRows(root), []); // no invocation, no evidence
});

test('dispatch: resolving to a host executor refuses with the host-dispatch pointer', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { reviewer: 'terra-host' } },
    default_loadout: 'main',
  });
  assert.throws(
    () => runDispatch({ archetype: 'reviewer', prompt: 'p', repoRoot: root, env: null }),
    /resolved to host executor "terra-host".*declare fallback_command.*native host dispatch/,
  );
});

test('dispatch: a host executor uses its explicit command fallback with honest evidence', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { reviewer: 'terra-fallback' } },
    default_loadout: 'main',
  });
  const result = runDispatch({ archetype: 'reviewer', prompt: 'review this', repoRoot: root, env: null });
  assert.equal(result.stdout, 'TERRA:review this');
  assert.equal(result.transport, 'host-command-fallback');
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.transport, 'host-command-fallback');
  assert.deepEqual(row.command, STDIN_ECHO('TERRA:'));
  assert.equal(row.command_sha256, sha256Hex(JSON.stringify(STDIN_ECHO('TERRA:'))));
});

test('dispatch: --executor bypasses resolution; unknown names are rejected', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  const result = runDispatch({ executor: 'luna-worker', prompt: 'raw', repoRoot: root, env: null });
  assert.equal(result.executor, 'luna-worker');
  assert.equal(result.source, 'flag');
  assert.equal(result.loadout, null); // bypass: no resolution, no active loadout claimed
  assert.equal(result.stdout, 'LUNA:raw');
  assert.equal(result.echo, 'luna-worker → luna-worker (gpt-5.6-luna) [--executor]');
  assert.equal(evidenceRows(root).at(-1)!.loadout, null);

  assert.throws(
    () => runDispatch({ executor: 'ghost', prompt: 'p', repoRoot: root, env: null }),
    /--executor "ghost" is not a declared executor \(echo-worker, luna-worker, fail-7, terra-host, terra-fallback\)/,
  );
});

test('dispatch: --prompt-file supplies the prompt; a missing file or no prompt at all errors', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  writeFileSync(join(root, 'prompt.txt'), 'from-file');

  const result = runDispatch({
    archetype: 'worker',
    promptFile: 'prompt.txt',
    cwd: root,
    repoRoot: root,
    env: null,
  });
  assert.equal(result.stdout, 'REPORT:from-file');
  assert.equal(result.promptSha256, sha256Hex('from-file'));
  assert.equal(evidenceRows(root).at(-1)!.prompt_sha256, sha256Hex('from-file'));

  assert.throws(
    () => runDispatch({ archetype: 'worker', promptFile: 'missing.txt', cwd: root, repoRoot: root, env: null }),
    /--prompt-file missing\.txt does not exist/,
  );
  assert.throws(
    () => runDispatch({ archetype: 'worker', repoRoot: root, env: null }),
    /no prompt: pass --prompt-file <path> or pipe the prompt on stdin/,
  );
});

test('dispatch: propagates the executor exit code and records it as evidence', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'fail-7' } },
    default_loadout: 'main',
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, env: null });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, '');
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.exit_code, 7);
  assert.equal(row.output_sha256, sha256Hex(''));
});

test('dispatch: --loadout and FADENO_LOADOUT select loadouts, with source attribution', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' }, alt: { worker: 'luna-worker' } },
    default_loadout: 'main',
  });

  const viaFlag = runDispatch({ archetype: 'worker', loadout: 'alt', prompt: 'p', repoRoot: root, env: null });
  assert.equal(viaFlag.executor, 'luna-worker');
  assert.deepEqual(viaFlag.loadout, { name: 'alt', source: 'flag' });
  assert.deepEqual(evidenceRows(root).at(-1)!.loadout, { name: 'alt', source: 'flag' });

  const viaEnv = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, env: 'alt' });
  assert.deepEqual(viaEnv.loadout, { name: 'alt', source: 'env' });

  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, env: null, loadout: 'ghost' }),
    /--loadout names loadout "ghost"/,
  );
});

test('dispatch: requires --archetype (bare identifier) unless --executor bypasses', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  assert.throws(
    () => runDispatch({ prompt: 'p', repoRoot: root, env: null }),
    /needs --archetype <a> \(or --executor <name> to bypass resolution\)/,
  );
  assert.throws(
    () => runDispatch({ archetype: 'Worker', prompt: 'p', repoRoot: root, env: null }),
    /--archetype "Worker" is not a bare lowercase identifier/,
  );
});

// --- run-path integration: new-run + drive resolve via the full chain ---

const LOADOUT_PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: loadout-e2e
description: Loadout-resolution flow for engine tests.
when_to_use:
  - loadout engine tests
roles:
  implementer:
    purpose: Implement the task.
    archetype: worker
flow:
  - id: implement
    kind: actor_call
    actor: implementer
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

const BINDINGS_PLAYBOOK = LOADOUT_PLAYBOOK.replace('name: loadout-e2e', 'name: bindings-e2e')
  .replace('\n    archetype: worker', '');

function seedRunRepo(
  t: TestContext,
  playbookName: string,
  playbook: string,
  profile: Record<string, unknown>,
): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', `${playbookName}.yaml`), playbook);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(profile));
  return root;
}

function events(root: string, runId: string): RunEvent[] {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

const WORKER_CMD = ['node', '-e', "process.stdout.write('LOADOUT NOTES')"];

test('run path: a loadout-only profile resolves the role via its archetype, with snapshot + echo', (t) => {
  const root = seedRunRepo(t, 'loadout-e2e', LOADOUT_PLAYBOOK, {
    executors: { lw: { adapter: 'command', command: WORKER_CMD, model: 'm1' } },
    loadouts: { solo: { worker: 'lw' } },
    default_loadout: 'solo',
  });

  const created = runNewRun({ playbook: 'loadout-e2e', task: 'Loadout run', repoRoot: root, env: null });
  assert.ok(created.resolution);
  assert.deepEqual(created.resolution.loadout, { name: 'solo', source: 'default' });
  assert.deepEqual(created.resolution.roles, [
    { role: 'implementer', archetype: 'worker', executor: 'lw', model: 'm1', source: 'loadout', error: null },
  ]);
  assert.deepEqual(created.resolution.echo, ['implementer → lw (m1) [loadout solo]']);
  // run creation records no resolution event — that belongs to dispatch time
  assert.deepEqual(events(root, created.runId).map((e) => e.type), ['run_started']);

  const done = runDrive({ run: created.runId, repoRoot: root, env: null });
  assert.equal(done.outcome, 'terminal');
  assert.equal(done.status, 'completed');
  assert.ok(done.actions.includes('implementer → lw (m1) [loadout solo]'));

  const all = events(root, created.runId);
  const snapshots = all.filter((e) => e.type === 'resolution_snapshot');
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0]!.extra.loadout, { name: 'solo', source: 'default' });
  assert.deepEqual(snapshots[0]!.extra.roles, [
    { role: 'implementer', archetype: 'worker', executor: 'lw', model: 'm1', source: 'loadout' },
  ]);
  const dispatched = all.find((e) => e.type === 'actor_dispatched');
  assert.ok(dispatched);
  assert.equal(dispatched.extra.executor, 'lw');
  assert.equal(
    readFileSync(join(root, '.fadeno', 'runs', created.runId, 'artifacts', 'notes.md'), 'utf8'),
    'LOADOUT NOTES',
  );

  // Re-driving with an unchanged resolution stays quiet in the ledger.
  runDrive({ run: created.runId, repoRoot: root, env: null });
  assert.equal(events(root, created.runId).filter((e) => e.type === 'resolution_snapshot').length, 1);

  const verify = runVerify({ run: created.runId, repoRoot: root });
  assert.equal(verify.ok, true);
});

test('run path: a bindings-only profile behaves as before (binding source, no loadout)', (t) => {
  const root = seedRunRepo(t, 'bindings-e2e', BINDINGS_PLAYBOOK, {
    executors: { bw: { adapter: 'command', command: WORKER_CMD } },
    bindings: { implementer: 'bw', '*': 'bw' },
  });

  const created = runNewRun({ playbook: 'bindings-e2e', task: 'Bindings run', repoRoot: root, env: null });
  assert.ok(created.resolution);
  assert.equal(created.resolution.loadout, null);
  assert.deepEqual(created.resolution.roles, [
    { role: 'implementer', archetype: null, executor: 'bw', model: null, source: 'binding', error: null },
  ]);
  assert.deepEqual(created.resolution.echo, ['implementer → bw [binding]']);

  const done = runDrive({ run: created.runId, repoRoot: root, env: null });
  assert.equal(done.outcome, 'terminal');
  assert.equal(done.status, 'completed');

  const all = events(root, created.runId);
  const snapshot = all.find((e) => e.type === 'resolution_snapshot');
  assert.ok(snapshot);
  assert.equal(snapshot.extra.loadout, null);
  assert.deepEqual(snapshot.extra.roles, [
    { role: 'implementer', archetype: null, executor: 'bw', model: null, source: 'binding' },
  ]);
  assert.equal(all.find((e) => e.type === 'actor_dispatched')!.extra.executor, 'bw');
  assert.equal(runVerify({ run: created.runId, repoRoot: root }).ok, true);
});

test('run path: drive --loadout and `fadeno loadout use` switch the worker at dispatch time', (t) => {
  const root = seedRunRepo(t, 'loadout-e2e', LOADOUT_PLAYBOOK, {
    executors: {
      lw: { adapter: 'command', command: WORKER_CMD, model: 'm1' },
      lw2: { adapter: 'command', command: ['node', '-e', "process.stdout.write('ALT NOTES')"], model: 'm2' },
    },
    loadouts: { a: { worker: 'lw' }, b: { worker: 'lw2' } },
    default_loadout: 'a',
  });

  // --loadout flag wins for this invocation.
  const flagged = runNewRun({ playbook: 'loadout-e2e', task: 'Flag run', repoRoot: root, env: null });
  const done = runDrive({ run: flagged.runId, repoRoot: root, env: null, loadout: 'b' });
  assert.equal(done.status, 'completed');
  const all = events(root, flagged.runId);
  assert.equal(all.find((e) => e.type === 'actor_dispatched')!.extra.executor, 'lw2');
  const snapshot = all.find((e) => e.type === 'resolution_snapshot')!;
  assert.deepEqual(snapshot.extra.loadout, { name: 'b', source: 'flag' });

  // `fadeno loadout use` makes the switch sticky for the next drive.
  runLoadoutUse({ repoRoot: root, name: 'b' });
  const sticky = runNewRun({ playbook: 'loadout-e2e', task: 'Sticky run', repoRoot: root, env: null });
  assert.deepEqual(sticky.resolution!.loadout, { name: 'b', source: 'local' });
  runDrive({ run: sticky.runId, repoRoot: root, env: null });
  const stickyEvents = events(root, sticky.runId);
  assert.equal(stickyEvents.find((e) => e.type === 'actor_dispatched')!.extra.executor, 'lw2');
  assert.deepEqual(
    stickyEvents.find((e) => e.type === 'resolution_snapshot')!.extra.loadout,
    { name: 'b', source: 'local' },
  );
});

test('run path: an unknown FADENO_LOADOUT is a hard drive error but a silent new-run preview skip', (t) => {
  const root = seedRunRepo(t, 'loadout-e2e', LOADOUT_PLAYBOOK, {
    executors: { lw: { adapter: 'command', command: WORKER_CMD, model: 'm1' } },
    loadouts: { solo: { worker: 'lw' } },
    default_loadout: 'solo',
  });

  // new-run never dispatches: the preview degrades to null, the run is created.
  const created = runNewRun({ playbook: 'loadout-e2e', task: 'Bad env', repoRoot: root, env: 'ghost' });
  assert.equal(created.resolution, null);

  // drive dispatches: the bad source is a loud, attributed error.
  assert.throws(
    () => runDrive({ run: created.runId, repoRoot: root, env: 'ghost' }),
    /FADENO_LOADOUT names loadout "ghost", which is not declared \(solo\)/,
  );

  // with the env fixed the same run drives to completion.
  const done = runDrive({ run: created.runId, repoRoot: root, env: null });
  assert.equal(done.status, 'completed');
});

test('run path: new-run uses the bundled executor profile', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'loadout-e2e.yaml'), LOADOUT_PLAYBOOK);
  const created = runNewRun({ playbook: 'loadout-e2e', task: 'No profile', repoRoot: root, env: null });
  assert.equal(created.resolution?.loadout?.name, 'native');
  assert.equal(created.resolution?.roles[0]?.executor, 'current-host');
  assert.deepEqual(events(root, created.runId).map((e) => e.type), ['run_started']);
});

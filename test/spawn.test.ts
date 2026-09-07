import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { CONTRACT_HEADER } from '../src/lib/contracts.ts';
import { LEDGER_FILE, appendRow, readDispatches, type OpenedRow } from '../src/lib/ledger.ts';
import {
  DISPATCH_ID_ENV,
  SpawnError,
  cancelDispatch,
  groupAlive,
  outputPaths,
  prepareDispatch,
  recordOpened,
  resolveArchetype,
  runCommandDispatch,
} from '../src/lib/spawn.ts';
import { git, gitRepo, tempRepo } from './helpers.ts';

// A bare shell: no host frame, so `current-host` has nothing to deliver.
const ISOLATED = { env: { FADENO_HARNESS: 'standalone' } } as const;

/** An executor that echoes its stdin with a prefix — the report is the prompt. */
const ECHO = (prefix: string): string[] => [
  process.execPath,
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(prefix)}+d));`,
];
/** An executor that reports where it ran and which dispatch it belongs to. */
const REPORT_ENV: string[] = [
  process.execPath,
  '-e',
  `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('cwd='+process.cwd()+'\\nid='+(process.env.${DISPATCH_ID_ENV}||'')+'\\n'));`,
];
const EXIT_7: string[] = [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('boom');process.exit(7)})"];
const SILENT: string[] = [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"];
const READS_FILE: string[] = [process.execPath, '-e', "process.stdout.write('FILE:'+require('fs').readFileSync(process.argv[1],'utf8'))", '{prompt_file}'];
const SLEEPS: string[] = [process.execPath, '-e', 'process.stdin.resume();setTimeout(()=>{},60000)'];

function seedCatalog(root: string, cmd: string[], extra: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 4,
      models: { echo: { provider: 'openai', id: 'echo-model', effort: 'high' } },
      harnesses: { codex: { provider: 'openai', command: cmd } },
      archetypes: { worker: {}, reviewer: {}, director: {} },
      dials: { worker: 'echo' },
      ...extra,
    }),
  );
}

function repo(t: TestContext, cmd: string[] = ECHO('REPORT:'), extra: Record<string, unknown> = {}): string {
  const root = gitRepo(t);
  seedCatalog(root, cmd, extra);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  return root;
}

test('resolveArchetype: a dialed archetype resolves to a command lane; an undialed one is current-host with nothing to invoke from a shell', (t) => {
  const root = repo(t);
  const worker = resolveArchetype({ repoRoot: root, archetype: 'worker', userPathOptions: ISOLATED });
  assert.equal(worker.model, 'echo');
  assert.equal(worker.modelId, 'echo-model');
  assert.equal(worker.effort, 'high');
  assert.equal(worker.harness, 'codex');
  assert.equal(worker.lane, 'command');
  assert.deepEqual(worker.command, ECHO('REPORT:'));
  assert.equal(worker.source, 'repo');
  assert.equal(worker.unclosedLimit, 5);
  const reviewer = resolveArchetype({ repoRoot: root, archetype: 'reviewer', userPathOptions: ISOLATED });
  assert.equal(reviewer.model, 'current-host');
  assert.equal(reviewer.source, 'base');
  assert.equal(reviewer.command, null, 'a bare shell has no session to be current in');
  const explicit = resolveArchetype({ repoRoot: root, archetype: 'reviewer', explicitModel: 'echo@low', userPathOptions: ISOLATED });
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.explicitModel, 'echo@low');
  assert.equal(explicit.effort, 'low');
  assert.throws(() => resolveArchetype({ repoRoot: root, archetype: 'Not Valid', userPathOptions: ISOLATED }), SpawnError);
});

test('prepareDispatch on the host lane: a worktree, a recorded prompt, a contract, a nag, and an opened row with no process group', (t) => {
  const root = repo(t);
  const outcome = prepareDispatch({
    repoRoot: root, archetype: 'worker', prompt: 'Fix the login bug.\n', name: 'Fix Login!', lane: 'host',
    session: 'sess-1', userPathOptions: ISOLATED, env: {}, now: new Date('2026-09-07T12:00:00Z'),
  });
  assert.ok(outcome.ok);
  const p = outcome.ok ? outcome.prepared : null!;
  assert.equal(p.name, 'fix-login');
  assert.equal(p.workspace.branch, 'fadeno/fix-login');
  assert.equal(p.workspace.path, join('.fadeno', 'local', 'worktrees', 'fix-login'));
  assert.ok(existsSync(join(p.cwd, 'base.txt')), 'the worktree is checked out');
  assert.equal(p.shared, false);
  assert.equal(readFileSync(join(root, p.promptPath), 'utf8'), 'Fix the login bug.\n', 'the recorded prompt is what was asked, not what Fadeno added');
  assert.ok(p.composedPrompt.startsWith('Fix the login bug.\n\n' + CONTRACT_HEADER), 'the task leads; the contract follows');
  assert.match(p.contract, /on branch `fadeno\/fix-login`, cut from `main`/);
  assert.equal(p.nag, 'No unclosed dispatches in this repository.');
  assert.equal(p.parent, null);
  const row = recordOpened(root, p);
  assert.equal(row.lane, 'host');
  assert.equal(row.process_group, undefined);
  assert.equal(row.task, 'Fix the login bug.');
  assert.equal(row.session, 'sess-1');
  const records = readDispatches(root).records;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, 'open');
});

test('a nested spawn inherits its parent from the environment, and a second prepare sees the first in the nag', (t) => {
  const root = repo(t);
  const first = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'one', lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(first.ok);
  recordOpened(root, first.ok ? first.prepared : null!);
  const second = prepareDispatch({
    repoRoot: root, archetype: 'reviewer', prompt: 'two', lane: 'host', userPathOptions: ISOLATED,
    env: { [DISPATCH_ID_ENV]: first.ok ? first.prepared.id : '' },
  });
  assert.ok(second.ok);
  const p = second.ok ? second.prepared : null!;
  assert.equal(p.parent, first.ok ? first.prepared.id : null);
  assert.match(p.nag, /## Unclosed dispatches \(1 of 5 allowed\)/);
  assert.match(p.nag, new RegExp(`\`${first.ok ? first.prepared.name : ''}\``));
  assert.notEqual(p.name, first.ok ? first.prepared.name : '', 'names are unique per repo');
});

test('a default name is archetype-<4 hex>, and a collision gets a counter', (t) => {
  const root = repo(t);
  const a = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'x', lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(a.ok && /^worker-[0-9a-f]{4}$/.test(a.prepared.name));
  recordOpened(root, a.ok ? a.prepared : null!);
  const b = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'y', name: a.ok ? a.prepared.name : '', lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(b.ok && b.prepared.name === `${a.ok ? a.prepared.name : ''}-2`);
});

test('the limit refuses the sixth spawn, and the catalog can raise it', (t) => {
  const root = repo(t);
  for (let i = 0; i < 5; i += 1) {
    const row: OpenedRow = {
      row: 'opened', id: `id-${i}`, name: `old-${i}`, at: '2026-09-01T00:00:00Z', session: null, parent: null, archetype: 'worker',
      model: 'echo', effort: null, explicit_model: null, lane: 'host', harness: 'codex', workspace: null, task: 'x', prompt: 'p',
    };
    appendRow(root, row);
  }
  const refused = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'six', lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(!refused.ok);
  assert.match(refused.ok ? '' : refused.refused, /5 dispatches are unclosed and the limit is 5/);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'worktrees')), 'a refused spawn cuts nothing');
  const raised = tempRepo(t);
  git(raised, ['init', '-q', '-b', 'main']);
  git(raised, ['config', 'user.email', 'a@b.invalid']);
  git(raised, ['config', 'user.name', 'a']);
  writeFileSync(join(raised, 'f'), 'x');
  git(raised, ['add', '-A']);
  git(raised, ['commit', '-q', '-m', 'i']);
  seedCatalog(raised, ECHO(''), { unclosed_limit: 7 });
  writeFileSync(join(raised, LEDGER_FILE), readFileSync(join(root, LEDGER_FILE), 'utf8'));
  const allowed = prepareDispatch({ repoRoot: raised, archetype: 'worker', prompt: 'six', lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(allowed.ok);
  assert.match(allowed.ok ? allowed.prepared.nag : '', /\(5 of 7 allowed\)/);
});

test('shared on request, and shared as a fallback when git cannot cut, each say so in the contract', (t) => {
  const root = repo(t);
  const requested = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'x', shared: true, lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(requested.ok);
  const r = requested.ok ? requested.prepared : null!;
  assert.equal(r.shared, true);
  assert.equal(r.sharedReason, null);
  assert.deepEqual(r.workspace, { path: '.', branch: null, base: git(root, ['rev-parse', 'HEAD']).trim() });
  assert.equal(r.cwd, root);
  assert.match(r.contract, /shared tree at/);
  const plain = tempRepo(t);
  seedCatalog(plain, ECHO(''));
  const fallback = prepareDispatch({ repoRoot: plain, archetype: 'worker', prompt: 'x', lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(fallback.ok);
  const f = fallback.ok ? fallback.prepared : null!;
  assert.equal(f.shared, true);
  assert.match(f.sharedReason ?? '', /not a commit|git/);
  assert.match(f.contract, /no worktree was cut:/);
});

test('an empty prompt is refused before anything is cut or written', (t) => {
  const root = repo(t);
  assert.throws(() => prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: '   \n', lane: 'host', userPathOptions: ISOLATED, env: {} }), /empty prompt/);
  assert.ok(!existsSync(join(root, '.fadeno', 'prompts')));
});

test('the command lane runs the executor in the worktree with the contract-bearing prompt, records the process group, and writes the stop', async (t) => {
  const root = repo(t, REPORT_ENV);
  const outcome = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'Report yourself.', name: 'probe', lane: 'command', userPathOptions: ISOLATED, env: {} });
  assert.ok(outcome.ok);
  const prepared = outcome.ok ? outcome.prepared : null!;
  const result = await runCommandDispatch({ repoRoot: root, prepared, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, new RegExp(`cwd=${prepared.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|cwd=/private${prepared.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, new RegExp(`id=${prepared.id}`));
  assert.ok(result.processGroup > 0);
  const { records } = readDispatches(root);
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.opened?.lane, 'command');
  assert.equal(record.opened?.process_group, result.processGroup);
  assert.equal(record.state, 'stopped');
  assert.equal(record.stopped?.final_message, result.stdout);
  assert.deepEqual(record.stopped?.exit, { code: 0, signal: null });
  assert.deepEqual(record.stopped?.dirty, { paths: [], truncated: false });
  assert.equal(readFileSync(join(root, result.stdoutPath), 'utf8'), result.stdout, 'the transcript is on disk at the recorded path');
  assert.equal(readFileSync(join(root, outputPaths(prepared.id).prompt), 'utf8'), prepared.composedPrompt);
  assert.ok(!groupAlive(result.processGroup), 'nothing is left running');
});

test('the executor receives the caller prompt followed by the contract, on stdin or at {prompt_file}', async (t) => {
  const viaStdin = repo(t, ECHO('GOT:'));
  const a = prepareDispatch({ repoRoot: viaStdin, archetype: 'worker', prompt: 'Task text.', lane: 'command', userPathOptions: ISOLATED, env: {} });
  assert.ok(a.ok);
  const ra = await runCommandDispatch({ repoRoot: viaStdin, prepared: a.ok ? a.prepared : null!, env: { PATH: process.env.PATH ?? '' } });
  assert.ok(ra.stdout.startsWith('GOT:Task text.\n\n' + CONTRACT_HEADER));
  const viaFile = repo(t, READS_FILE);
  const b = prepareDispatch({ repoRoot: viaFile, archetype: 'worker', prompt: 'File task.', lane: 'command', userPathOptions: ISOLATED, env: {} });
  assert.ok(b.ok);
  const rb = await runCommandDispatch({ repoRoot: viaFile, prepared: b.ok ? b.prepared : null!, env: { PATH: process.env.PATH ?? '' } });
  assert.ok(rb.stdout.startsWith('FILE:File task.\n\n' + CONTRACT_HEADER));
});

test('a nonzero exit is recorded verbatim with its stderr kept; an executor that writes nothing records no final message', async (t) => {
  const failing = repo(t, EXIT_7);
  const a = prepareDispatch({ repoRoot: failing, archetype: 'worker', prompt: 'x', lane: 'command', userPathOptions: ISOLATED, env: {} });
  assert.ok(a.ok);
  const ra = await runCommandDispatch({ repoRoot: failing, prepared: a.ok ? a.prepared : null!, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(ra.exitCode, 7);
  assert.equal(readFileSync(join(failing, ra.stderrPath), 'utf8'), 'boom');
  assert.equal(readDispatches(failing).records[0]!.stopped?.exit?.code, 7);
  const silent = repo(t, SILENT);
  const b = prepareDispatch({ repoRoot: silent, archetype: 'worker', prompt: 'x', lane: 'command', userPathOptions: ISOLATED, env: {} });
  assert.ok(b.ok);
  const rb = await runCommandDispatch({ repoRoot: silent, prepared: b.ok ? b.prepared : null!, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(rb.exitCode, 0);
  assert.equal(rb.stdout, '');
  assert.equal(readDispatches(silent).records[0]!.stopped?.final_message, null, 'presence, never completeness: nothing was said');
});

test('an archetype with nothing to invoke is refused on the command lane before anything is cut or written', (t) => {
  const root = repo(t);
  assert.throws(
    () => prepareDispatch({ repoRoot: root, archetype: 'reviewer', prompt: 'x', lane: 'command', userPathOptions: ISOLATED, env: {} }),
    (err: unknown) => err instanceof SpawnError && /nothing to invoke/.test(err.message),
  );
  assert.equal(readDispatches(root).records.length, 0, 'no opened row for a spawn that never happened');
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'worktrees')), 'and no worktree');
  assert.ok(!existsSync(join(root, '.fadeno', 'prompts')), 'and no prompt file');
});

test('cancel signals the recorded process group, the launcher records the stop with the signal, and cancel says so', async (t) => {
  const root = repo(t, SLEEPS);
  const outcome = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'sleep', name: 'sleeper', lane: 'command', userPathOptions: ISOLATED, env: {} });
  assert.ok(outcome.ok);
  const prepared = outcome.ok ? outcome.prepared : null!;
  const running = runCommandDispatch({ repoRoot: root, prepared, env: { PATH: process.env.PATH ?? '' } });
  // Wait for the opened row: that is the moment the process group exists.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && readDispatches(root).records.length === 0) await new Promise((r) => setTimeout(r, 50));
  const record = readDispatches(root).records[0]!;
  assert.ok(record.opened?.process_group, 'the group is on the opened row');
  assert.ok(groupAlive(record.opened!.process_group!));
  const cancelled = await cancelDispatch(root, record, { graceMs: 5_000 });
  assert.ok(cancelled.ok, cancelled.ok ? '' : cancelled.message);
  const result = await running;
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(!groupAlive(result.processGroup));
  const after = readDispatches(root).records[0]!;
  assert.equal(after.state, 'stopped');
  assert.equal(after.stopped?.exit?.signal, 'SIGTERM');
  const again = await cancelDispatch(root, after);
  assert.ok(!again.ok && again.reason === 'not_running');
  assert.match(again.ok ? '' : again.message, /dispatch-close sleeper --failed/);
});

test('cancel refuses a host-lane dispatch and says whose it is to stop', async (t) => {
  const root = repo(t);
  const outcome = prepareDispatch({ repoRoot: root, archetype: 'worker', prompt: 'x', name: 'inhost', lane: 'host', userPathOptions: ISOLATED, env: {} });
  assert.ok(outcome.ok);
  recordOpened(root, outcome.ok ? outcome.prepared : null!);
  const refused = await cancelDispatch(root, readDispatches(root).records[0]!);
  assert.ok(!refused.ok && refused.reason === 'host_lane');
  assert.match(refused.ok ? '' : refused.message, /harness's to stop/);
});

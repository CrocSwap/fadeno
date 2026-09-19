import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { DispatchesError, runClean, runDispatch } from '../src/commands/dispatches.ts';
import { CONTRACT_HEADER } from '../src/lib/contracts.ts';
import { appendRow, LEDGER_FILE, readDispatches } from '../src/lib/ledger.ts';
import { CANCEL_REQUESTS_DIR, cancellationPaths, DEFAULT_COMMAND_HEARTBEAT_MS, outputPaths, RELAY_DIR, stageRelay } from '../src/lib/spawn.ts';
import { runPromptStage } from '../src/commands/prompt-stage.ts';
import { STAGED_PROMPT_TTL_MS, STAGED_PROMPTS_DIR } from '../src/lib/staged-prompts.ts';
import { git, gitRepo } from './helpers.ts';

/**
 * The dispatch family through the real CLI, the way a proxy or a hook calls
 * it: argv in, stdout/stderr/exit code out, rows on disk.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const FORCE_EPERM = pathToFileURL(join(import.meta.dirname, 'force-cancel-eperm.mjs')).href;
const ECHO: string[] = [process.execPath, '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('REPORT:'+d))"];
const EXIT_3: string[] = [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('bad');process.exit(3)})"];
const LATE_REPORT: string[] = [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write('LATE REPORT\\n'),2000))"];
const HEARTBEAT_REPORT: string[] = [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write('HEARTBEAT REPORT\\n'),500))"];
const HELD_REPORT: string[] = [process.execPath, '-e', "const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{const poll=()=>fs.existsSync('.release-report')?process.stdout.write('LATE REPORT\\n'):setTimeout(poll,10);poll()})"];
const LIVE_HELD_REPORT: string[] = [process.execPath, '-e', "const fs=require('fs');process.stdout.write('PARTIAL STDOUT\\n');process.stderr.write('LIVE STDERR\\n');process.stdin.resume();process.stdin.on('end',()=>{const poll=()=>fs.existsSync('.release-report')?process.stdout.write('LATE REPORT\\n'):setTimeout(poll,10);poll()})"];
const PARTIAL_FAILURE_REPORT: string[] = [process.execPath, '-e', "const fs=require('fs');fs.writeSync(1,'PARTIAL STDOUT\\n');process.stdin.resume();process.stdin.on('end',()=>{const poll=()=>{if(!fs.existsSync('.release-report'))return setTimeout(poll,10);fs.writeSync(2,'provider: quota exhausted\\n');fs.writeSync(1,'x'.repeat(2500)+'\\n');process.exit(7)};poll()})"];

function repo(t: TestContext, cmd: string[] = ECHO): string {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { echo: { provider: 'openai', id: 'echo-model', effort: 'high' } },
    harnesses: { codex: { provider: 'openai', command: cmd } },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'echo' },
  }));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  return root;
}

function cli(root: string, args: string[], stdin = '', extraEnv: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, FADENO_HARNESS: 'standalone', ...extraEnv };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', input: stdin, env });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

test('command-process heartbeat defaults to five minutes, labels its stderr echo, and honors zero and explicit overrides', (t) => {
  assert.equal(DEFAULT_COMMAND_HEARTBEAT_MS, 5 * 60_000);

  const disabledRoot = repo(t, HEARTBEAT_REPORT);
  const disabled = cli(disabledRoot, ['dispatch', '--archetype', 'worker', '--name', 'heartbeat-disabled', '--heartbeat', '0'], 'run quietly');
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.doesNotMatch(disabled.stderr, /command process liveness echo/);

  const overriddenRoot = repo(t, HEARTBEAT_REPORT);
  const overridden = cli(overriddenRoot, ['dispatch', '--archetype', 'worker', '--name', 'heartbeat-overridden', '--heartbeat', '0.1'], 'run with liveness');
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stderr, /heartbeat-overridden: command process liveness echo — still running/);
});

test('dispatch acknowledges on stderr before it reads input or starts preparation', async (t) => {
  const root = repo(t, [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write('LATE ACK REPORT\\n'),2000))"]);
  const launcher = spawn(process.execPath, [CLI, 'dispatch', '--archetype', 'worker', '--model', 'echo', '--name', 'Fix Login'], {
    cwd: root,
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    launcher.stdin?.destroy();
    launcher.kill('SIGTERM');
  });

  let stdout = '';
  let stderr = '';
  launcher.stdout?.setEncoding('utf8');
  launcher.stderr?.setEncoding('utf8');
  launcher.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  launcher.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const firstStderr = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dispatch did not acknowledge preparation before input')), 30_000);
    launcher.stderr?.once('data', (chunk: string) => {
      clearTimeout(timer);
      resolve(chunk);
    });
    launcher.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.match(firstStderr, /dispatch \(name "Fix Login"; archetype worker; model echo\): preparation underway/);
  assert.match(firstStderr, /has not opened a ledger row or started an executor yet/);
  assert.equal(stdout, '', 'the acknowledgement must not enter the agent report stream');

  launcher.stdin?.end('Fix the login bug.\n');
  const finished = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    launcher.once('error', reject);
    launcher.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(finished.code, 0, stderr);
  assert.equal(finished.signal, null);
  assert.ok(stdout.startsWith('LATE ACK REPORT\n'), stdout);
  assert.match(stderr, /dispatch \(name "Fix Login"; archetype worker; model echo\): preparation underway/);
  assert.doesNotMatch(stdout, /preparation underway/);
});

test('cancel through the CLI stops a live command-lane dispatch and reports the mechanism', async (t) => {
  const root = repo(t, LATE_REPORT);
  const launcher = spawn(process.execPath, [CLI, 'dispatch', '--archetype', 'worker', '--name', 'cli-cancel'], {
    cwd: root,
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    launcher.stdin?.destroy();
    try { launcher.kill('SIGTERM'); } catch { /* already gone */ }
  });
  launcher.stdin?.end('cancel me');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && readDispatches(root).records[0]?.opened?.process_group == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(readDispatches(root).records[0]?.opened?.process_group);
  const answer = cli(root, ['cancel', 'cli-cancel']);
  assert.equal(answer.status, 0, answer.stderr);
  assert.match(answer.stdout, /cancelled cli-cancel: signalled process group/);
  await new Promise<void>((resolve) => launcher.once('close', () => resolve()));
  assert.equal(readDispatches(root).records[0]!.state, 'stopped');
  assert.match(cli(root, ['dispatches', '--all']).stdout, /awaiting close\s+worker\s+echo@high on codex\s+cli-cancel \(killed by SIGTERM\)/);
});

test('the CLI uses the launcher fallback on forced EPERM and fails safely when the launcher is gone', async (t) => {
  const root = repo(t, LATE_REPORT);
  const launcher = spawn(process.execPath, [CLI, 'dispatch', '--archetype', 'worker', '--name', 'cli-cooperative'], {
    cwd: root,
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => {
    launcher.stdin?.destroy();
    try { launcher.kill('SIGTERM'); } catch { /* already gone */ }
  });
  launcher.stdin?.end('cancel me cooperatively');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && readDispatches(root).records[0]?.opened?.process_group == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(readDispatches(root).records[0]?.opened?.process_group);
  const cooperative = cli(root, ['cancel', 'cli-cooperative'], '', { NODE_OPTIONS: `--import=${FORCE_EPERM}` });
  assert.equal(cooperative.status, 0, cooperative.stderr);
  assert.match(cooperative.stdout, /launcher cooperatively signalled process group/);
  await new Promise<void>((resolve) => launcher.once('close', () => resolve()));

  const orphanRoot = repo(t, LATE_REPORT);
  const orphan = spawn(process.execPath, [CLI, 'dispatch', '--archetype', 'worker', '--name', 'cli-unconsumed'], {
    cwd: orphanRoot,
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => {
    orphan.stdin?.destroy();
    try { orphan.kill('SIGTERM'); } catch { /* already gone */ }
  });
  orphan.stdin?.end('orphan me');
  const orphanDeadline = Date.now() + 10_000;
  while (Date.now() < orphanDeadline && readDispatches(orphanRoot).records[0]?.opened?.process_group == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(readDispatches(orphanRoot).records[0]?.opened?.process_group);
  orphan.kill('SIGTERM');
  await new Promise<void>((resolve) => orphan.once('close', () => resolve()));
  const unconsumed = cli(orphanRoot, ['cancel', 'cli-unconsumed'], '', { NODE_OPTIONS: `--import=${FORCE_EPERM}` });
  assert.equal(unconsumed.status, 1);
  assert.match(unconsumed.stderr, /Codex app sandbox denied the signal/);
  assert.equal(readDispatches(orphanRoot).records[0]!.stopped, null);
});

test('dispatch: the report is stdout verbatim, the exit code is the executor\'s, the ledger holds opened and stopped, and close records the decision', (t) => {
  const root = repo(t);
  const run = cli(root, ['dispatch', '--archetype', 'worker', '--name', 'Fix Login'], 'Fix the login bug.\n');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith('REPORT:Fix the login bug.\n\n' + CONTRACT_HEADER), run.stdout.slice(0, 200));
  assert.match(run.stderr, /dispatch fix-login \([0-9a-f-]{36}\) → echo on codex; process group \d+; fadeno\/fix-login/);
  assert.match(run.stderr, /stopped: exit 0; branch fadeno\/fix-login\. Close it: fadeno dispatch-close fix-login --merged\|--kept\|--discarded\|--failed\|--reviewed/);
  const { records } = readDispatches(root);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, 'stopped');
  assert.equal(records[0]!.opened?.name, 'fix-login');
  assert.equal(records[0]!.opened?.lane, 'command');
  assert.ok(records[0]!.opened?.process_group);

  const list = cli(root, ['dispatches']);
  assert.match(list.stdout, /^AGE\s+STATE\s+ARCHETYPE\s+ROUTE\s+NAME$/m);
  assert.match(list.stdout, /0m\s+awaiting close\s+worker\s+echo@high on codex\s+fix-login/);
  assert.match(list.stdout, /1 unclosed of 1 recorded/);

  const output = cli(root, ['dispatches', '--output', 'fix-login']);
  assert.equal(output.status, 0);
  assert.ok(output.stdout.startsWith('REPORT:Fix the login bug.'));

  const show = cli(root, ['dispatches', 'fix-login']);
  assert.match(show.stdout, /^fix-login \([0-9a-f-]{36}\)/);
  assert.match(show.stdout, /worktree:  .*\.fadeno\/local\/worktrees\/fix-login on fadeno\/fix-login/);
  // The two halves, labelled: git's measurement of the branch, and the claim
  // the agent wrote about its own work.
  assert.match(show.stdout, /--- what Fadeno measured ---/);
  assert.match(show.stdout, /fadeno\/fix-login at [0-9a-f]{12}: \d+ commit\(s\) HEAD does not have/);
  assert.match(show.stdout, /--- what the agent reported \(a claim, not a finding\) ---/);
  assert.match(show.stdout, /full report: `fadeno dispatches --output fix-login` prints the complete command-lane report verbatim/);

  const close = cli(root, ['dispatch-close', 'fix-login', '--merged', '--note', 'landed']);
  assert.equal(close.status, 0, close.stderr);
  assert.match(close.stdout, /fix-login closed: merged; branch fadeno\/fix-login kept, worktree .* stays until fadeno clean/);
  assert.equal(cli(root, ['dispatch-close', 'fix-login', '--merged']).stdout.includes('(already recorded)'), true);
  const conflict = cli(root, ['dispatch-close', 'fix-login', '--discarded']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /already closed as "merged"/);
  const twoVerbs = cli(root, ['dispatch-close', 'fix-login', '--merged', '--kept']);
  assert.equal(twoVerbs.status, 1);
  assert.match(twoVerbs.stderr, /exactly one/i);
  assert.match(cli(root, ['dispatches']).stdout, /No unclosed dispatches \(1 recorded; --all shows them\)/);
  assert.match(cli(root, ['dispatches', '--all']).stdout, /closed: merged/);
});

test('dispatch unifies read forms and positional launch selectors while retaining dispatches', (t) => {
  const root = repo(t);
  const positionalArchetype = cli(root, ['dispatch', 'run', 'worker', '--name', 'positional-archetype'], 'run the archetype');
  assert.equal(positionalArchetype.status, 0, positionalArchetype.stderr);
  assert.ok(positionalArchetype.stdout.startsWith('REPORT:run the archetype\n\n' + CONTRACT_HEADER));

  // Provider/id selectors are accepted by the registry resolver, and effort
  // remains part of the model ref passed through to the dispatch compiler.
  const positionalModel = cli(root, ['dispatch', 'run', 'echo-model@low', '--name', 'positional-model'], 'run the model');
  assert.equal(positionalModel.status, 0, positionalModel.stderr);
  assert.ok(positionalModel.stdout.startsWith('REPORT:run the model\n\n' + CONTRACT_HEADER));
  const records = readDispatches(root).records;
  assert.equal(records.length, 2);
  assert.equal(records[1]!.opened?.model, 'echo');
  assert.equal(records[1]!.opened?.effort, 'low');

  const singular = cli(root, ['dispatch', '--json']);
  const plural = cli(root, ['dispatches', '--json']);
  assert.equal(singular.status, 0, singular.stderr);
  assert.equal(plural.status, 0, plural.stderr);
  const singularResult = JSON.parse(singular.stdout) as { entries: Array<{ name: string }>; total: number; unclosed: number };
  const pluralResult = JSON.parse(plural.stdout) as { entries: Array<{ name: string }>; total: number; unclosed: number };
  assert.deepEqual(singularResult, pluralResult);
  assert.match(cli(root, ['dispatch', 'positional-archetype']).stdout, /^positional-archetype \([0-9a-f-]{36}\)/);
  assert.match(cli(root, ['dispatch', '--output', 'positional-model']).stdout, /^REPORT:run the model/);
  assert.match(cli(root, ['dispatch', '--all', '--tail', '1']).stdout, /positional-model/);
});

test('dispatch run accepts explicit archetype and model selectors', (t) => {
  const root = repo(t);
  const byArchetype = cli(root, ['dispatch', 'run', '--archetype', 'worker', '--name', 'explicit-archetype'], 'run explicit archetype');
  assert.equal(byArchetype.status, 0, byArchetype.stderr);
  const byModel = cli(root, ['dispatch', 'run', '--model', 'echo@low', '--name', 'explicit-model'], 'run explicit model');
  assert.equal(byModel.status, 0, byModel.stderr);

  const records = readDispatches(root).records;
  assert.equal(records.length, 2);
  assert.equal(records[0]!.opened?.archetype, 'worker');
  assert.equal(records[1]!.opened?.model, 'echo');
  assert.equal(records[1]!.opened?.effort, 'low');
});

test('dispatch run refuses selector ambiguity, unknown selectors, and double selectors', (t) => {
  const root = repo(t);
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: {
      echo: { provider: 'openai', id: 'echo-model', effort: 'high' },
      worker: { provider: 'openai', id: 'worker-model', effort: 'high' },
    },
    harnesses: { codex: { provider: 'openai', command: ECHO } },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'echo' },
  }));

  const ambiguous = cli(root, ['dispatch', 'run', 'worker'], 'should not run');
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous.*both.*archetype.*registered model/i);
  assert.match(ambiguous.stderr, /--archetype worker.*--model worker/);
  assert.equal(readDispatches(root).records.length, 0);

  const unknown = cli(root, ['dispatch', 'run', 'not-a-selector'], 'should not run');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /matches neither.*effective archetype.*registered model reference/i);
  assert.match(unknown.stderr, /Archetypes:.*worker/);
  assert.match(unknown.stderr, /Models:.*echo/);

  const double = cli(root, ['dispatch', 'run', 'worker', '--archetype', 'reviewer'], 'should not run');
  assert.equal(double.status, 1);
  assert.match(double.stderr, /cannot combine a positional selector with --archetype or --model/i);
  assert.equal(readDispatches(root).records.length, 0);
});

test('dispatches table uses the compact human columns and keeps shared, dirty, and exit state visible', (t) => {
  const root = repo(t);
  const isolated = cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'normal-example'], 'x');
  assert.equal(isolated.status, 0, isolated.stderr);
  const shared = cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--shared', '--name', 'shared-example'], 'x');
  assert.equal(shared.status, 0, shared.stderr);
  writeFileSync(join(root, 'shared-change.txt'), 'x\n');
  const stopped = cli(root, ['dispatch-stop', 'shared-example', '--agent-cwd', root], 'done');
  assert.equal(stopped.status, 0, stopped.stderr);

  const table = cli(root, ['dispatches', '--all']);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^AGE\s+STATE\s+ARCHETYPE\s+ROUTE\s+NAME$/m);
  assert.doesNotMatch(table.stdout, /\bID\b|\bLANE\b|\bWHERE\b/);
  assert.match(table.stdout, /0m\s+open\s+worker\s+echo@high on codex\s+normal-example/);
  assert.match(table.stdout, /0m\s+awaiting close\s+worker\s+echo@high on codex\s+shared-example \(shared tree; \d+ dirty path\(s\)\)/);
  assert.doesNotMatch(table.stdout, /normal-example \(shared tree\)/);

  const failing = repo(t, EXIT_3);
  const run = cli(failing, ['dispatch', '--archetype', 'worker', '--name', 'failed-example'], 'x');
  assert.equal(run.status, 3, run.stderr);
  const failedTable = cli(failing, ['dispatches', '--all']);
  assert.match(failedTable.stdout, /awaiting close\s+worker\s+echo@high on codex\s+failed-example \(exit 3\)/);
});

test('dispatch: a failing executor propagates its exit code and names its stderr; a silent one is exit 1 with NO OUTPUT', (t) => {
  const failing = repo(t, EXIT_3);
  const run = cli(failing, ['dispatch', '--archetype', 'worker'], 'x');
  assert.equal(run.status, 3);
  assert.match(run.stderr, /stopped: exit 3; branch fadeno\/worker-[0-9a-f]{4}.*; full stderr at \.fadeno\/local\/outputs\/[0-9a-f-]{36}\.err/);
  // The REASON, not just where to find it: four workers died on "usage
  // balance exhausted" and the host read `exit 1` five times before opening
  // a file to learn why.
  assert.match(run.stderr, /stderr ends: bad;/);
  const silent = repo(t, [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"]);
  const quiet = cli(silent, ['dispatch', '--archetype', 'worker'], 'x');
  assert.equal(quiet.status, 1);
  assert.match(quiet.stderr, /NO OUTPUT — the executor wrote nothing/);
});

test('dispatch-close refuses self-close for every verb, while a parent can close its child', (t) => {
  const root = repo(t);
  const verbs = ['merged', 'kept', 'discarded', 'failed', 'reviewed'] as const;
  const selfIds = new Map<string, string>();
  for (const verb of verbs) {
    const name = `self-${verb}`;
    const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', name, '--json'], 'return the report').stdout) as { id: string };
    selfIds.set(verb, opened.id);
    const refused = cli(root, ['dispatch-close', name, `--${verb}`], '', { FADENO_DISPATCH_ID: opened.id });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /this is the dispatch you are currently running in; this dispatch must return its report, and its caller\/host closes it/);
    assert.equal(readDispatches(root).records.find((record) => record.id === opened.id)?.closed, null);
  }

  const parent = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'parent', '--json'], 'coordinate').stdout) as { id: string };
  const child = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'child', '--parent', parent.id, '--json'], 'do the child task').stdout) as { id: string };
  const closed = cli(root, ['dispatch-close', 'child', '--reviewed'], '', { FADENO_DISPATCH_ID: parent.id });
  assert.equal(closed.status, 0, closed.stderr);
  const records = readDispatches(root).records;
  assert.equal(records.find((record) => record.id === child.id)?.closed?.verb, 'reviewed');
  assert.equal(records.find((record) => record.id === parent.id)?.closed, null);
  assert.equal(selfIds.size, verbs.length);
});

test('dispatch-wait ignores a close-only live command dispatch, and the direct launcher still returns its eventual report', async (t) => {
  const root = repo(t, HELD_REPORT);
  const launcher = spawn(process.execPath, [CLI, 'dispatch', '--archetype', 'worker', '--name', 'close-before-stop'], {
    cwd: root,
    env: { ...process.env, FADENO_HARNESS: 'standalone', FADENO_DISPATCH_ID: undefined },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  launcher.stdout?.setEncoding('utf8');
  launcher.stderr?.setEncoding('utf8');
  launcher.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  launcher.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  launcher.stdin?.end('return a late report');

  const deadline = Date.now() + 10_000;
  let record = readDispatches(root).records[0];
  while (Date.now() < deadline && record?.opened?.process_group == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    record = readDispatches(root).records[0];
  }
  assert.ok(record?.opened?.process_group, 'the command lane recorded its live process group');

  const earlyClose = cli(root, ['dispatch-close', 'close-before-stop', '--reviewed']);
  assert.equal(earlyClose.status, 0, earlyClose.stderr);
  const waiting = cli(root, ['dispatch-wait', 'close-before-stop', '--wait-seconds', '0']);
  assert.equal(waiting.status, 2, 'closed is not report-ready while the executor remains alive');
  assert.equal(waiting.stdout, '');
  assert.match(waiting.stderr, /close-before-stop is still running/);

  const workspace = record?.opened?.workspace?.path;
  assert.ok(workspace);
  writeFileSync(join(root, workspace, '.release-report'), 'release\n');

  const finished = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    launcher.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(finished.code, 0, stderr);
  assert.equal(finished.signal, null);
  assert.match(stdout, /LATE REPORT/);
  assert.match(stderr, /stopped: exit 0/);
  const final = readDispatches(root).records[0]!;
  assert.equal(final.state, 'closed');
  assert.equal(final.closed?.verb, 'reviewed');
  assert.equal(final.stopped?.final_message, stdout);
  assert.deepEqual(readFileSync(join(root, LEDGER_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line).row), ['opened', 'closed', 'stopped']);
});

test('dispatch: an empty prompt, a missing prompt file, an unknown archetype shape, and nothing to invoke are all refused before anything runs', (t) => {
  const root = repo(t);
  assert.match(cli(root, ['dispatch', '--archetype', 'worker'], '   ').stderr, /empty prompt/);
  assert.match(cli(root, ['dispatch', '--archetype', 'worker', '--prompt-file', 'nope.md']).stderr, /no such file/);
  assert.match(cli(root, ['dispatch', '--archetype', 'Not-Valid'], 'x').stderr, /not a bare lowercase identifier/);
  assert.match(cli(root, ['dispatch', '--archetype', 'reviewer'], 'x').stderr, /nothing to invoke/);
  const list = cli(root, ['dispatch'], 'x');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /No dispatches recorded in this repository/);
  assert.ok(!existsSync(join(root, LEDGER_FILE)), 'no row for a dispatch that never happened');
});

test('dispatch-open and dispatch-stop: the host lane\'s two halves through the CLI', (t) => {
  const root = repo(t);
  const opened = cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'in-host', '--session-id', 's-1', '--json'], 'Do the host thing.');
  assert.equal(opened.status, 0, opened.stderr);
  const json = JSON.parse(opened.stdout) as { ok: boolean; id: string; name: string; cwd: string; prompt: string; nag: string; lane: string; workspace: { branch: string } };
  assert.equal(json.ok, true);
  assert.equal(json.name, 'in-host');
  assert.equal(json.lane, 'host');
  assert.equal(json.workspace.branch, 'fadeno/in-host');
  assert.ok(json.prompt.startsWith('Do the host thing.\n\n' + CONTRACT_HEADER));
  assert.equal(json.nag, 'No unclosed dispatches in this repository.');
  assert.ok(existsSync(join(json.cwd, 'base.txt')));
  const row = readDispatches(root).records[0]!;
  assert.equal(row.opened?.session, 's-1');
  assert.equal(row.opened?.lane, 'host');
  assert.equal(row.opened?.process_group, undefined);

  // From a bare shell nothing is a host candidate, so the host lane is asked for by name.
  const second = cli(root, ['dispatch-open', '--archetype', 'reviewer', '--lane', 'host', '--json'], 'Review it.');
  assert.equal(second.status, 0, second.stderr);
  assert.match((JSON.parse(second.stdout) as { nag: string }).nag, /## Unclosed dispatches \(1; 0 stopped and waiting on you\)/);

  writeFileSync(join(json.cwd, 'new.txt'), 'x\n');
  const stopped = cli(root, ['dispatch-stop', 'in-host', '--agent-cwd', root], 'All done; new.txt added.');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /in-host stopped; tree 1 dirty path\(s\); WARNING: the agent worked in .*, not its assigned worktree\. Close it:/);
  const after = readDispatches(root).records[0]!;
  assert.equal(after.state, 'stopped');
  assert.equal(after.stopped?.final_message, 'All done; new.txt added.');
  assert.deepEqual(after.stopped?.dirty, { paths: ['new.txt'], truncated: false });
  assert.match(cli(root, ['dispatch-stop', 'in-host'], 'again').stdout, /already recorded/);
  assert.match(cli(root, ['cancel', 'in-host']).stderr, /harness's to stop/);
});

test('dispatch-open remains available with many stopped dispatches on both lanes', (t) => {
  const root = repo(t);
  // Five running dispatches refuse nothing — the limit counts work waiting on
  // a person, and a running dispatch has no report to read.
  for (let i = 0; i < 5; i += 1) assert.equal(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', `j${i}`], `job ${i}`).status, 0);
  assert.equal(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host'], 'while they run').status, 0);
  cli(root, ['dispatch-close', 'while-they-run', '--discarded']);
  for (let i = 0; i < 5; i += 1) cli(root, ['dispatch-stop', `j${i}`], 'done');
  const available = cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--json'], 'six');
  assert.equal(available.status, 0, available.stderr);
  const relayed = cli(root, ['dispatch-open', '--archetype', 'worker', '--json'], 'seven');
  assert.equal(relayed.status, 0, relayed.stderr);
  assert.equal(readDispatches(root).records.length, 7, 'host opens are recorded; the relay is not until its proxy runs');
  assert.ok(existsSync(join(root, '.fadeno', 'local', 'relay')), 'the relay is staged instead of refused');
});

test('dispatch-wait: answers with the report when the stop lands, and says "run it again" when it has not', (t) => {
  const root = repo(t);
  const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'slow-one', '--json'], 'do it').stdout) as { id: string };

  // Nothing has stopped and there is no process group to be gone (host lane),
  // so a short wait answers "still running" — exit 2, the same code
  // `dispatches --output` uses for "not finished".
  const waiting = cli(root, ['dispatch-wait', 'slow-one', '--wait-seconds', '0']);
  assert.equal(waiting.status, 2);
  assert.match(waiting.stderr, /slow-one is still running \(\d+m in\)\. Run this command again\./);
  assert.equal(waiting.stdout, '', 'nothing on stdout: only exit 0 carries a report');

  // Once the stop row lands, the same command answers with the report.
  cli(root, ['dispatch-stop', 'slow-one'], 'the tree holds the fix');
  const done = cli(root, ['dispatch-wait', 'slow-one', '--wait-seconds', '0']);
  assert.equal(done.status, 0);
  assert.match(done.stdout, /the tree holds the fix/);

  // A dispatch answers to the name it was GIVEN as well as the recorded slug,
  // and to its id — the proxy is handed the former.
  assert.equal(cli(root, ['dispatch-wait', opened.id, '--wait-seconds', '0']).status, 0);
  assert.match(cli(root, ['dispatch-wait', 'no-such-dispatch']).stderr, /no dispatch "no-such-dispatch"/);
});

test('dispatch-wait preserves a complete partial report and failure context when the executor exits non-zero', async (t) => {
  const root = repo(t, PARTIAL_FAILURE_REPORT);
  const launcher = spawn(process.execPath, [CLI, 'dispatch', '--archetype', 'worker', '--name', 'partial-failure'], {
    cwd: root,
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => {
    launcher.stdin?.destroy();
    try { launcher.kill('SIGTERM'); } catch { /* already gone */ }
  });
  launcher.stdin?.end('return partial progress and the provider cause');

  const deadline = Date.now() + 10_000;
  let record = readDispatches(root).records[0];
  while (Date.now() < deadline && record?.opened?.process_group == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    record = readDispatches(root).records[0];
  }
  assert.ok(record?.opened?.process_group, 'the command lane recorded its live process group');
  const workspace = record?.opened?.workspace?.path;
  assert.ok(workspace);
  writeFileSync(join(root, workspace, '.release-report'), 'release\n');

  const waited = cli(root, ['dispatch-wait', 'partial-failure', '--wait-seconds', '600']);
  const expected = `PARTIAL STDOUT\n${'x'.repeat(2500)}\n`;
  assert.equal(waited.status, 7, 'a report does not turn a non-zero executor into success');
  assert.equal(waited.stdout, expected, 'the complete report remains byte-for-byte on stdout');
  assert.match(waited.stderr, /partial-failure failed: exit 7; stderr ends: provider: quota exhausted; full stderr at \.fadeno\/local\/outputs\/[0-9a-f-]{36}\.err; its report follows/);

  const output = cli(root, ['dispatches', '--output', 'partial-failure']);
  assert.equal(output.status, 7, 'the complete-report read preserves the executor status too');
  assert.equal(output.stdout, expected, 'dispatches --output retrieves the retained full report');
  assert.match(output.stderr, /partial-failure failed: exit 7; stderr ends: provider: quota exhausted/);
  if (launcher.exitCode == null && launcher.signalCode == null) {
    await new Promise<void>((resolve) => launcher.once('close', () => resolve()));
  }
});

test('clean --force preserves mixed live and closed-before-stopped scratch, including cancellation requests', (t) => {
  const root = repo(t);
  const activeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const staleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const liveStoppedId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const liveHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { detached: true, stdio: 'ignore' });
  assert.ok(liveHolder.pid);
  t.after(() => {
    try { process.kill(-liveHolder.pid!, 'SIGTERM'); } catch { /* already gone */ }
  });
  const opened = (id: string, name: string) => ({
    row: 'opened' as const,
    id,
    name,
    at: new Date().toISOString(),
    session: null,
    parent: null,
    archetype: 'worker',
    model: 'echo',
    effort: 'high',
    explicit_model: null,
    lane: 'command' as const,
    harness: 'codex',
    workspace: null,
    task: 'x',
    prompt: 'p',
    process_group: process.pid,
  });
  appendRow(root, opened(activeId, 'live'));
  // Closing is not a stop receipt. This is the ordering that used to make
  // clean treat a live command's branch and streams as disposable.
  appendRow(root, { row: 'closed', id: activeId, at: new Date().toISOString(), verb: 'reviewed' as const, note: 'decided early' });
  appendRow(root, opened(staleId, 'stale'));
  appendRow(root, { row: 'stopped', id: staleId, at: new Date().toISOString(), final_message: 'done', dirty: { paths: [], truncated: false } });
  appendRow(root, { ...opened(liveStoppedId, 'stopped-live'), process_group: liveHolder.pid });
  appendRow(root, { row: 'stopped', id: liveStoppedId, at: new Date().toISOString(), final_message: 'still writing', dirty: { paths: [], truncated: false } });

  const outputDir = join(root, '.fadeno', 'local', 'outputs');
  mkdirSync(outputDir, { recursive: true });
  const activeOutput = outputPaths(activeId);
  const staleOutput = outputPaths(staleId);
  writeFileSync(join(root, activeOutput.stdout), 'live stdout bytes\n');
  writeFileSync(join(root, activeOutput.stderr), 'live stderr bytes\n');
  writeFileSync(join(root, staleOutput.stdout), 'stale stdout bytes\n');
  writeFileSync(join(root, staleOutput.stderr), 'stale stderr bytes\n');
  const liveStoppedOutput = outputPaths(liveStoppedId);
  writeFileSync(join(root, liveStoppedOutput.stdout), 'stopped row, live group stdout\n');
  writeFileSync(join(root, liveStoppedOutput.stderr), 'stopped row, live group stderr\n');

  const activeCancel = cancellationPaths(root, activeId);
  const staleCancel = cancellationPaths(root, staleId);
  const liveStoppedCancel = cancellationPaths(root, liveStoppedId);
  mkdirSync(join(root, CANCEL_REQUESTS_DIR), { recursive: true });
  writeFileSync(activeCancel.request, JSON.stringify({ version: 1, dispatch_id: activeId, process_group: process.pid, signal: 'SIGTERM' }) + '\n');
  writeFileSync(activeCancel.ack, JSON.stringify({ version: 1, dispatch_id: activeId, process_group: process.pid, signal: 'SIGTERM', result: 'signalled' }) + '\n');
  writeFileSync(`${activeCancel.request}.writer.tmp`, 'active writer scratch\n');
  writeFileSync(liveStoppedCancel.request, JSON.stringify({ version: 1, dispatch_id: liveStoppedId, process_group: process.pid, signal: 'SIGTERM' }) + '\n');
  writeFileSync(liveStoppedCancel.ack, JSON.stringify({ version: 1, dispatch_id: liveStoppedId, process_group: process.pid, signal: 'SIGTERM', result: 'signalled' }) + '\n');
  writeFileSync(`${liveStoppedCancel.request}.writer.tmp`, 'stopped-live writer scratch\n');
  writeFileSync(staleCancel.request, '{"stale":true}\n');
  writeFileSync(staleCancel.ack, '{"stale":true}\n');
  writeFileSync(`${staleCancel.request}.writer.tmp`, 'stale writer scratch\n');

  const preview = cli(root, ['clean']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /would remove .*selected command-lane transcript files/);
  assert.match(preview.stdout, /would remove .*selected cooperative cancellation files/);
  assert.ok(existsSync(join(root, activeOutput.stdout)), 'preview does not touch live stdout');
  assert.ok(existsSync(activeCancel.request), 'preview does not touch a live cancellation request');

  const cleaned = cli(root, ['clean', '--force']);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(readFileSync(join(root, activeOutput.stdout), 'utf8'), 'live stdout bytes\n');
  assert.equal(readFileSync(join(root, activeOutput.stderr), 'utf8'), 'live stderr bytes\n');
  assert.equal(readFileSync(join(root, liveStoppedOutput.stdout), 'utf8'), 'stopped row, live group stdout\n', 'a stopped receipt does not outrank a live process group');
  assert.ok(existsSync(liveStoppedCancel.request), 'a stopped-but-live cancellation request survives');
  assert.ok(existsSync(`${liveStoppedCancel.request}.writer.tmp`), 'a stopped-but-live cancellation writer survives');
  assert.ok(existsSync(activeCancel.request), 'a live launcher cancellation request survives');
  assert.ok(existsSync(activeCancel.ack), 'a live launcher acknowledgement survives');
  assert.ok(existsSync(`${activeCancel.request}.writer.tmp`), 'a live launcher cancellation write survives');
  assert.equal(existsSync(join(root, staleOutput.stdout)), false, 'stopped stdout is eligible scratch');
  assert.equal(existsSync(join(root, staleOutput.stderr)), false, 'stopped stderr is eligible scratch');
  assert.equal(existsSync(staleCancel.request), false, 'stale cancellation requests are eligible scratch');
  assert.equal(existsSync(staleCancel.ack), false, 'stale cancellation acknowledgements are eligible scratch');
  assert.equal(existsSync(`${staleCancel.request}.writer.tmp`), false, 'stale cancellation write scratch is eligible scratch');
  assert.equal(existsSync(outputDir), true, 'selective output cleanup keeps the launch directory');
  assert.equal(existsSync(join(root, CANCEL_REQUESTS_DIR)), true, 'selective cancellation cleanup keeps the launch directory');
});

test('clean preserves a dispatch and fresh scratch created after its directory snapshot', async (t) => {
  const root = repo(t);
  const oldId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  appendRow(root, {
    row: 'opened', id: oldId, name: 'old', at: new Date().toISOString(), session: null, parent: null,
    archetype: 'worker', model: 'echo', effort: 'high', explicit_model: null, lane: 'command', harness: 'codex',
    workspace: null, task: 'old', prompt: 'p',
  });
  appendRow(root, { row: 'stopped', id: oldId, at: new Date().toISOString(), final_message: 'old', dirty: { paths: [], truncated: false } });
  const oldOutput = outputPaths(oldId);
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, oldOutput.stdout), 'old stdout\n');
  writeFileSync(join(root, oldOutput.stderr), 'old stderr\n');
  writeFileSync(join(root, oldOutput.prompt), 'old prompt\n');

  const oldRelay = stageRelay(root, { prompt: 'old relay', archetype: 'worker' }).promptFile;
  utimesSync(oldRelay, (Date.now() - STAGED_PROMPT_TTL_MS - 1_000) / 1_000, (Date.now() - STAGED_PROMPT_TTL_MS - 1_000) / 1_000);
  const oldStaged = runPromptStage({ repoRoot: root, prompt: 'old staged', now: Date.now() - STAGED_PROMPT_TTL_MS - 1_000 });

  let launched: Promise<unknown> | null = null;
  let freshRelay: string | null = null;
  let freshStaged: string | null = null;
  const preparingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const cleaned = runClean({
    repoRoot: root,
    force: true,
    onScratchSnapshot(relativeDir) {
      if (relativeDir !== '.fadeno/local/outputs' || launched != null) return;
      // The callback is after readdir and before any selected entry is
      // retired: this is the interleaving that made recursive cleanup delete
      // a newly launched dispatch's output directory contents.
      launched = runDispatch({ repoRoot: root, archetype: 'worker', name: 'new-during-clean', prompt: 'new dispatch' });
      writeFileSync(join(root, outputPaths(preparingId).prompt), 'preparing before opened row\n');
      freshRelay = stageRelay(root, { prompt: 'fresh relay', archetype: 'worker' }).promptFile;
      freshStaged = join(root, STAGED_PROMPTS_DIR, `${runPromptStage({ repoRoot: root, prompt: 'fresh staged' }).token}.json`);
    },
  });
  assert.ok(launched);
  await launched;
  assert.deepEqual(new Set(cleaned.outputs?.entries), new Set([oldOutput.stdout.split('/').at(-1)!, oldOutput.stderr.split('/').at(-1)!, oldOutput.prompt.split('/').at(-1)!]));
  assert.equal(existsSync(join(root, oldOutput.stdout)), false);
  assert.equal(existsSync(join(root, oldOutput.stderr)), false);
  assert.equal(existsSync(join(root, oldOutput.prompt)), false);
  const newRecord = readDispatches(root).records.find((record) => record.opened?.name === 'new-during-clean');
  assert.ok(newRecord);
  assert.ok(existsSync(join(root, outputPaths(newRecord!.id).stdout)), 'new stdout survives the snapshot');
  assert.ok(existsSync(join(root, outputPaths(newRecord!.id).stderr)), 'new stderr survives the snapshot');
  assert.ok(existsSync(join(root, outputPaths(newRecord!.id).prompt)), 'new prompt survives the snapshot');
  assert.ok(existsSync(join(root, outputPaths(preparingId).prompt)), 'an incomplete preparing dispatch prompt survives');
  assert.ok(freshRelay && existsSync(freshRelay), 'fresh relay survives cleanup');
  assert.ok(freshStaged && existsSync(freshStaged), 'fresh staged prompt survives cleanup');
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${oldStaged.token}.json`)), false, 'expired staged prompt remains useful cleanup');
  assert.equal(readdirSync(join(root, RELAY_DIR)).length, 1, 'relay directory is retained with its fresh file');
});

test('clean reports a scratch directory replaced by a file instead of saying nothing to clean', (t) => {
  const root = repo(t);
  const outputs = join(root, '.fadeno', 'local', 'outputs');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(outputs, 'this path must be a directory\n');
  assert.throws(
    () => runClean({ repoRoot: root }),
    (error: unknown) => error instanceof DispatchesError && /could not read scratch directory .*outputs/.test(error.message) && /Restore the directory|fix its permissions/.test(error.message),
  );
});

test('clean names an artifact moved aside when an unexpected unlink error leaves it recoverable', (t) => {
  const root = repo(t);
  const id = 'f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1';
  appendRow(root, {
    row: 'opened', id, name: 'retire-error', at: new Date().toISOString(), session: null, parent: null,
    archetype: 'worker', model: 'echo', effort: 'high', explicit_model: null, lane: 'command', harness: 'codex',
    workspace: null, task: 'x', prompt: 'p',
  });
  appendRow(root, { row: 'stopped', id, at: new Date().toISOString(), final_message: 'done', dirty: { paths: [], truncated: false } });
  const output = outputPaths(id).stdout;
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, output), 'report\n');

  let recoverable: string | null = null;
  assert.throws(
    () => runClean({
      repoRoot: root,
      force: true,
      onScratchSnapshot(relativeDir) {
        if (relativeDir !== '.fadeno/local/outputs') return;
        const original = join(root, output);
        unlinkSync(original);
        mkdirSync(original);
      },
    }),
    (error: unknown) => {
      if (!(error instanceof DispatchesError)) return false;
      const match = error.message.match(/recoverable at (.+?);/);
      recoverable = match?.[1] ?? null;
      return /could not remove retired scratch file/.test(error.message) && recoverable != null;
    },
  );
  assert.ok(recoverable, 'the moved artifact path is named for recovery');
  assert.ok(existsSync(recoverable!), 'the moved artifact remains on disk after unlink fails');
});

test('clean --force races a live launcher without removing its report or worktree, then cleans stopped output', async (t) => {
  const root = repo(t, LIVE_HELD_REPORT);
  const launcher = spawn(process.execPath, [CLI, 'dispatch', '--archetype', 'worker', '--name', 'live-clean'], {
    cwd: root,
    env: { ...process.env, FADENO_HARNESS: 'standalone' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => {
    launcher.stdin?.destroy();
    try { launcher.kill('SIGTERM'); } catch { /* already gone */ }
  });
  launcher.stdin?.end('hold the report');

  const deadline = Date.now() + 10_000;
  let record = readDispatches(root).records[0];
  while (Date.now() < deadline && record?.opened?.process_group == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    record = readDispatches(root).records[0];
  }
  assert.ok(record?.opened?.process_group, 'the command lane recorded its live process group');
  const id = record!.id;
  const workspace = record!.opened!.workspace?.path;
  assert.ok(workspace);
  const outputs = outputPaths(id);
  const stdout = join(root, outputs.stdout);
  const stderr = join(root, outputs.stderr);
  const outputDeadline = Date.now() + 10_000;
  while (Date.now() < outputDeadline && (!readFileSync(stdout, 'utf8').includes('PARTIAL STDOUT') || !readFileSync(stderr, 'utf8').includes('LIVE STDERR'))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(readFileSync(stdout, 'utf8'), /PARTIAL STDOUT/);
  assert.match(readFileSync(stderr, 'utf8'), /LIVE STDERR/);

  // Make the close-before-stop ordering explicit before cleaning. The command
  // is still live, so both its scratch and its assigned worktree are held.
  const earlyClose = cli(root, ['dispatch-close', 'live-clean', '--reviewed']);
  assert.equal(earlyClose.status, 0, earlyClose.stderr);
  const cleanedWhileLive = cli(root, ['clean', '--force']);
  assert.equal(cleanedWhileLive.status, 0, cleanedWhileLive.stderr);
  assert.match(cleanedWhileLive.stdout, /closed before it stopped/);
  assert.match(readFileSync(stdout, 'utf8'), /PARTIAL STDOUT/);
  assert.match(readFileSync(stderr, 'utf8'), /LIVE STDERR/);
  assert.ok(existsSync(join(root, workspace!, '.git')), 'the live worktree remains registered');

  writeFileSync(join(root, workspace!, '.release-report'), 'release\n');
  const finished = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    launcher.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(finished.code, 0);
  assert.equal(finished.signal, null);
  assert.match(readFileSync(stdout, 'utf8'), /PARTIAL STDOUT[\s\S]*LATE REPORT/);
  assert.equal(readDispatches(root).records[0]!.state, 'closed');

  // Once the launcher has appended stopped, output cleanup is expected. The
  // worktree itself is dirty because the release marker is intentionally left
  // behind, so clean keeps that part for the existing safety rule.
  const cleanedAfterStop = cli(root, ['clean', '--force']);
  assert.equal(cleanedAfterStop.status, 0, cleanedAfterStop.stderr);
  assert.equal(existsSync(stdout), false);
  assert.equal(existsSync(stderr), false);
  assert.ok(existsSync(join(root, workspace!, '.release-report')));
});

test('dispatch-wait: a dead process group with no stop row has its stop reconstructed, not reported as a loss', (t) => {
  const root = repo(t);
  // A command-lane row whose launcher is gone: pid 2 is init's child on macOS
  // and Linux alike and is never a Fadeno process group, so the liveness probe
  // finds nothing. This is the shape a killed (rather than backgrounded) shell
  // call leaves behind — the launching CLI writes the stop row when its child
  // exits, so a harness that kills it at a shell ceiling leaves nobody to
  // write one at all.
  const id = '3f3f3f3f-0000-4000-8000-000000000000';
  const opened = {
    row: 'opened', id, name: 'orphaned', at: new Date().toISOString(), session: null, parent: null, archetype: 'worker',
    model: 'echo', effort: 'high', explicit_model: null, lane: 'command', harness: 'codex', workspace: null,
    task: 'x', prompt: 'p', process_group: 999_999,
  };
  writeFileSync(join(root, LEDGER_FILE), `${JSON.stringify(opened)}\n`);
  const answer = cli(root, ['dispatch-wait', 'orphaned', '--wait-seconds', '600'], '', { FADENO_ABANDON_SETTLE_MS: '0' });
  assert.equal(answer.status, 5, 'it stopped and left nothing: a different ending from a report, and from still running');
  assert.match(answer.stderr, /orphaned stopped \(its launcher was killed before it could record the stop, so how it ended is unknown\) and recorded NO REPORT/);
  // The row is now on disk, so the dispatch is no longer open forever and the
  // next reader is not asked to work out what happened all over again.
  const recorded = readDispatches(root).records[0]!;
  assert.equal(recorded.state, 'stopped');
  assert.equal(recorded.stopped?.reconstructed, true);
  assert.equal(recorded.stopped?.exit, undefined, 'how it ended is unknown, and an invented exit code would say otherwise');

  // The case that matters: the executor finished, committed, and wrote its
  // report — and only the recording of it was lost. Twenty-six of these in one
  // night were handed back to their hosts as dead dispatches.
  const root2 = repo(t);
  writeFileSync(join(root2, LEDGER_FILE), `${JSON.stringify(opened)}\n${JSON.stringify({ row: 'closed', id, at: new Date().toISOString(), verb: 'kept', note: 'older client decided early' })}\n`);
  mkdirSync(join(root2, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root2, '.fadeno', 'local', 'outputs', `${id}.md`), 'the work is done and committed\n');
  writeFileSync(join(root2, '.fadeno', 'local', 'outputs', `${id}.err`), 'warning: something\n');
  const withOutput = cli(root2, ['dispatch-wait', 'orphaned', '--wait-seconds', '600'], '', { FADENO_ABANDON_SETTLE_MS: '0' });
  assert.equal(withOutput.status, 0, 'the report is right there; exit 0 means "here it is"');
  assert.equal(withOutput.stdout, 'the work is done and committed\n', 'relayed verbatim: a proxy passes stdout on');
  assert.match(withOutput.stderr, /its report was recovered from what it left on disk/, 'and stderr says it was recovered, not watched arriving');
  const recovered = readDispatches(root2).records[0]!;
  assert.equal(recovered.state, 'closed', 'closed-before-stopped remains a valid correlated record');
  assert.equal(recovered.closed?.verb, 'kept');
  assert.equal(recovered.stopped?.reconstructed, true);
  assert.match(recovered.stopped?.final_message ?? '', /the work is done and committed/);
  assert.match(recovered.stopped?.stderr_excerpt ?? '', /warning: something/, 'the stderr is recovered too: it is how a full disk was diagnosed');
});

test('dispatch-wait: a dead group is given its writer a moment, because the writer is another process', (t) => {
  const root = repo(t);
  const id = '4f4f4f4f-0000-4000-8000-000000000000';
  writeFileSync(join(root, LEDGER_FILE), `${JSON.stringify({
    row: 'opened', id, name: 'racing', at: new Date().toISOString(), session: null, parent: null, archetype: 'worker',
    model: 'echo', effort: 'high', explicit_model: null, lane: 'command', harness: 'codex', workspace: null,
    task: 'x', prompt: 'p', process_group: 999_999,
  })}\n`);
  // `fadeno cancel` signals the group, waits up to five seconds for it to die,
  // and only THEN writes the stop row. A wait loop that gave up on the first
  // dead-group reading landed inside that window: cancel printed "stop
  // recorded" while the proxy reported that no stop was ever recorded.
  // From ANOTHER process, because `spawnSync` below blocks this one's event
  // loop — and because the real writer is another process too.
  const row = JSON.stringify({
    row: 'stopped', id, at: new Date().toISOString(), final_message: 'cancelled, partial work on the branch',
    dirty: { paths: [], truncated: false }, cwd: null, exit: { code: null, signal: 'SIGTERM' },
  });
  const late = spawn(process.execPath, [
    '-e',
    `setTimeout(()=>require('node:fs').appendFileSync(process.argv[1],process.argv[2]+'\\n'),700)`,
    join(root, LEDGER_FILE),
    row,
  ], { detached: true, stdio: 'ignore' });
  late.unref();
  t.after(() => { try { late.kill(); } catch { /* already gone */ } });
  const answer = cli(root, ['dispatch-wait', 'racing', '--wait-seconds', '600']);
  assert.equal(answer.status, 0, 'the row landed inside the settling window, so this is a stop, not a loss');
  assert.match(answer.stdout, /cancelled, partial work on the branch/);
});

test('dispatch-wait: a dispatch that stopped with no report at all is exit 5, not a silent success', (t) => {
  const root = repo(t);
  const id = '5f5f5f5f-0000-4000-8000-000000000000';
  writeFileSync(join(root, LEDGER_FILE), [
    JSON.stringify({
      row: 'opened', id, name: 'starved', at: new Date().toISOString(), session: null, parent: null, archetype: 'worker',
      model: 'echo', effort: 'high', explicit_model: null, lane: 'command', harness: 'codex', workspace: null,
      task: 'x', prompt: 'p',
    }),
    JSON.stringify({
      row: 'stopped', id, at: new Date().toISOString(), final_message: null, dirty: { paths: [], truncated: false },
      cwd: null, exit: { code: 101, signal: null }, stderr_excerpt: 'error: No space left on device (os error 28)',
    }),
  ].join('\n') + '\n');
  // The transcript file exists from the moment the executor launches. Four
  // disk-killed workers left empty ones, and `existsSync` alone relayed them
  // to their proxies as finished reports with exit 0.
  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'outputs', `${id}.md`), '');

  const answer = cli(root, ['dispatch-wait', 'starved', '--wait-seconds', '0']);
  assert.equal(answer.status, 5, 'exit 0 would say "here is the report" about nothing');
  assert.equal(answer.stdout, '');
  assert.match(answer.stderr, /starved stopped \(exit 101\) and recorded NO REPORT/);
  assert.match(answer.stderr, /Its stderr ends: error: No space left on device \(os error 28\)/);

  // And the same empty file must not out-rank a report the stop row holds.
  assert.equal(cli(root, ['dispatches', '--output', 'starved']).status, 1);
});

test('dispatch-wait: several names answer on the first to stop, and name the ones still running', (t) => {
  const root = repo(t);
  const open = (name: string) =>
    JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', name, '--json'], 'do it').stdout) as { id: string };
  open('alpha');
  open('beta');
  open('gamma');

  // A director fanning out was polling each ledger by hand between turns. One
  // call covers the fan-out; with none of them stopped it says how many.
  const waiting = cli(root, ['dispatch-wait', 'alpha', 'beta', 'gamma', '--wait-seconds', '0']);
  assert.equal(waiting.status, 2);
  assert.match(waiting.stderr, /3 dispatches are still running \(alpha, beta, gamma\)\. Run this command again\./);

  cli(root, ['dispatch-stop', 'beta'], 'beta is done');
  const first = cli(root, ['dispatch-wait', 'alpha', 'beta', 'gamma', '--wait-seconds', '0']);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /beta is done/, 'the report of the one that stopped');
  // And the next call is spelled out, so the caller does not ask again for the
  // one it just collected.
  assert.match(first.stderr, /Still running: alpha gamma — `fadeno dispatch-wait alpha gamma`/);

  // An unknown name is the caller's mistake and is said at once, not after
  // nine minutes of waiting on the others.
  const bad = cli(root, ['dispatch-wait', 'alpha', 'no-such-dispatch', '--wait-seconds', '600']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no dispatch "no-such-dispatch"/);
});

test('worktrees and clean: stopped or closed clean worktrees are reclaimed, open or dirty ones are kept', (t) => {
  const root = repo(t);
  cli(root, ['dispatch', '--archetype', 'worker', '--name', 'done'], 'x');
  cli(root, ['dispatch', '--archetype', 'worker', '--name', 'busy'], 'y');
  cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'stopped'], 'z');
  cli(root, ['dispatch-stop', 'stopped'], 'done');
  const busyDir = join(root, '.fadeno', 'local', 'worktrees', 'busy');
  writeFileSync(join(busyDir, 'wip.txt'), 'unfinished\n');
  cli(root, ['dispatch-close', 'done', '--merged']);
  const wt = cli(root, ['worktrees']);
  assert.match(wt.stdout, /\.fadeno\/local\/worktrees\/done  fadeno\/done  clean; 0 unmerged commit\(s\)  — done \(closed\)/);
  assert.match(wt.stdout, /\.fadeno\/local\/worktrees\/busy  fadeno\/busy  1 uncommitted; 0 unmerged commit\(s\)  — busy \(stopped\)/);
  assert.match(wt.stdout, /\.fadeno\/local\/worktrees\/stopped  fadeno\/stopped  clean; 0 unmerged commit\(s\)  — stopped \(stopped\)/);
  const preview = cli(root, ['clean']);
  assert.match(preview.stdout, /would remove worktree \.fadeno\/local\/worktrees\/done \(branch kept\)/);
  assert.match(preview.stdout, /would remove worktree \.fadeno\/local\/worktrees\/stopped \(branch kept\)/);
  assert.match(preview.stdout, /kept \.fadeno\/local\/worktrees\/busy: 1 uncommitted path\(s\)/);
  assert.match(preview.stdout, /Re-run with --force/);
  assert.ok(existsSync(join(root, '.fadeno', 'local', 'worktrees', 'done')));
  const forced = cli(root, ['clean', '--force']);
  assert.match(forced.stdout, /removed worktree \.fadeno\/local\/worktrees\/done/);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'worktrees', 'done')));
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'worktrees', 'stopped')));
  assert.match(git(root, ['branch', '--list']), /fadeno\/stopped/);
  assert.ok(existsSync(join(busyDir, 'wip.txt')), 'the dirty tree survives');
  assert.ok(existsSync(join(root, '.fadeno', 'prompts')), 'prompts are never touched');
  assert.ok(existsSync(join(root, LEDGER_FILE)), 'the ledger is never touched');
  cli(root, ['dispatch-close', 'busy', '--failed']);
  assert.match(cli(root, ['clean', '--force']).stdout, /kept \.fadeno\/local\/worktrees\/busy: 1 uncommitted path\(s\)/);
});

test('context prints the vocabulary and the nag, and no routing snapshot', (t) => {
  const root = repo(t);
  cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'pending'], 'x');
  const ctx = cli(root, ['context']);
  assert.equal(ctx.status, 0, ctx.stderr);
  assert.match(ctx.stdout, /- \*\*worker\*\* — Implements /);
  assert.match(ctx.stdout, /- \*\*reviewer\*\* — Reviews /);
  assert.doesNotMatch(ctx.stdout, /routes to/, 'the vocabulary carries no routing snapshot');
  assert.match(ctx.stdout, /## Unclosed dispatches \(1; 0 stopped and waiting on you\)/);
  assert.match(ctx.stdout, /`pending`/);
  const json = JSON.parse(cli(root, ['context', '--json']).stdout) as { archetypes: Array<{ name: string }>; reminder: string };
  // A self-contained project catalog suppresses the builtin layer, so only its own archetypes plus the role canon appear.
  assert.deepEqual(json.archetypes.map((a) => a.name), ['judge', 'reviewer', 'worker']);
  assert.match(json.reminder, /1 dispatch still running; none is waiting for a decision/);
});

test('the ledger stays readable when a row is torn, and the listing says so', (t) => {
  const root = repo(t);
  cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'good'], 'x');
  writeFileSync(join(root, LEDGER_FILE), readFileSync(join(root, LEDGER_FILE), 'utf8') + '{"row":"opened","id":"torn"\n');
  const list = cli(root, ['dispatches']);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /good/);
  assert.match(list.stdout, /1 unreadable row\(s\) skipped/);
});

test('dispatch-open on auto hands a command-lane archetype to the proxy: prompt staged, nothing opened, and the relayed command runs the dispatch', (t) => {
  const root = repo(t);
  const invalidBaseline = cli(root, ['dispatch-open', '--archetype', 'worker', '--from', 'missing-baseline', '--json'], 'never start');
  assert.equal(invalidBaseline.status, 3);
  assert.match(invalidBaseline.stdout, /did not match a dispatch name\/id or a Git commit\/ref/);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'relay')), 'an invalid explicit baseline is refused before relay staging');

  const relayed = cli(root, ['dispatch-open', '--archetype', 'worker', '--name', 'Fix Login', '--json'], 'Fix the login bug.\n');
  assert.equal(relayed.status, 0, relayed.stderr);
  const json = JSON.parse(relayed.stdout) as { ok: boolean; opened: boolean; lane: string; name: string; model: string; harness: string; relay: { prompt_file: string; args: string[]; command: string }; nag: string };
  assert.equal(json.ok, true);
  assert.equal(json.opened, false);
  assert.equal(json.lane, 'command');
  assert.equal(json.model, 'echo');
  assert.equal(json.harness, 'codex');
  assert.ok(json.relay.prompt_file.startsWith(join(realpathSync(root), '.fadeno', 'local', 'relay')), json.relay.prompt_file);
  assert.equal(readFileSync(json.relay.prompt_file, 'utf8'), 'Fix the login bug.\n', 'the caller\'s bytes, untouched');
  assert.deepEqual(json.relay.args, ['dispatch', '--archetype', 'worker', '--name', 'Fix Login', '--prompt-file', json.relay.prompt_file]);
  assert.equal(json.relay.command, `fadeno dispatch --archetype worker --name 'Fix Login' --prompt-file ${json.relay.prompt_file}`);
  assert.equal(json.nag, 'No unclosed dispatches in this repository.');
  assert.ok(!existsSync(join(root, LEDGER_FILE)), 'a relay writes no row; fadeno dispatch does');
  const plain = cli(root, ['dispatch-open', '--archetype', 'worker'], 'again');
  assert.match(plain.stdout, /worker resolves to echo@high on codex, a command lane: nothing opened here\. The dispatch proxy runs:\n  fadeno dispatch --archetype worker --prompt-file /);

  // The proxy runs exactly what it was handed.
  const ran = cli(root, json.relay.args);
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(ran.stdout.startsWith('REPORT:Fix the login bug.\n\n' + CONTRACT_HEADER));
  const record = readDispatches(root).records[0]!;
  assert.equal(record.opened?.name, 'fix-login');
  assert.equal(record.opened?.lane, 'command');
  assert.equal(record.opened?.task, 'Fix the login bug.');

  // A forced command lane on an archetype with nothing to invoke is refused before anything is staged.
  const nothing = cli(root, ['dispatch-open', '--archetype', 'reviewer', '--lane', 'command'], 'x');
  assert.notEqual(nothing.status, 0);
  assert.match(nothing.stderr, /nothing to invoke/);
  assert.match(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'sideways'], 'x').stderr, /--lane sideways: expected one of auto, host, command/);

  // A relay that has sat past its expiry window is useful stale cleanup; the
  // directory itself and any fresh relay would survive.
  cli(root, ['dispatch-close', 'fix-login', '--merged']);
  const oldRelayAt = (Date.now() - STAGED_PROMPT_TTL_MS - 1_000) / 1_000;
  utimesSync(json.relay.prompt_file, oldRelayAt, oldRelayAt);
  assert.match(cli(root, ['clean']).stdout, /would remove .*selected stale relay prompt files/);
  cli(root, ['clean', '--force']);
  assert.ok(existsSync(join(root, '.fadeno', 'local', 'relay')));
  assert.ok(!existsSync(json.relay.prompt_file), 'the expired relay is removed');
  const freshRelays = readdirSync(join(root, '.fadeno', 'local', 'relay'));
  assert.equal(freshRelays.length, 1, 'the second, fresh relay survives cleanup');
  assert.equal(readFileSync(join(root, '.fadeno', 'local', 'relay', freshRelays[0]!), 'utf8'), 'again');
  assert.ok(existsSync(join(root, '.fadeno', 'prompts')));
});

test('dispatch-stop --transcript names the dispatch from the contract header, records the model that ran and the last words, and says when the dial was not applied', (t) => {
  const root = repo(t);
  const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'observed', '--json'], 'Do it.').stdout) as { id: string; prompt: string };
  const transcript = join(root, 'agent-x.jsonl');
  const record = (o: unknown) => JSON.stringify(o) + '\n';
  writeFileSync(transcript,
    record({ type: 'user', message: { role: 'user', content: opened.prompt } }) +
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Working.' }] } }) +
    '{"torn":' + '\n' +
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'All done; merge it.' }] } }),
  );
  const stopped = cli(root, ['dispatch-stop', '--transcript', transcript]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /observed stopped; tree clean; WARNING: ran on claude-haiku-4-5, the dial asked for echo\. Close it:/);
  const row = readDispatches(root).records[0]!.stopped!;
  assert.equal(row.final_message, 'All done; merge it.');
  assert.equal(row.model_observed, 'claude-haiku-4-5');
  assert.match(cli(root, ['dispatches', 'observed']).stdout, /ran on:    claude-haiku-4-5  \(the dial asked for echo\)/);
  // An explicit message wins over the transcript's last words; a replay changes nothing.
  assert.match(cli(root, ['dispatch-stop', 'observed', '--transcript', transcript], 'later words').stdout, /already recorded/);
  assert.equal(readDispatches(root).records[0]!.stopped!.final_message, 'All done; merge it.');

  // A transcript with no contract is not a dispatch: exit 4, nothing recorded, and --json says so.
  const foreign = join(root, 'agent-y.jsonl');
  writeFileSync(foreign, record({ type: 'user', message: { role: 'user', content: 'Explore the repo.' } }));
  const notOurs = cli(root, ['dispatch-stop', '--transcript', foreign, '--json']);
  assert.equal(notOurs.status, 4);
  assert.deepEqual(JSON.parse(notOurs.stdout).dispatch, null);
  assert.equal(readDispatches(root).records.length, 1);
  assert.match(cli(root, ['dispatch-stop']).stderr, /a transcript can name the dispatch/);
});

test('a director\'s contract carries the host vocabulary, and a dispatch run from inside a worktree still lands in the main repository\'s ledger', (t) => {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { echo: { provider: 'openai', id: 'echo-model', effort: 'high' } },
    harnesses: { codex: { provider: 'openai', command: ECHO } },
    archetypes: { director: {}, worker: {} },
    dials: { director: 'echo', worker: 'echo' },
  }));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  const run = cli(root, ['dispatch', '--archetype', 'director', '--name', 'lead'], 'Coordinate the fix.');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\*\*You may spawn\.\*\* Never close the dispatch you are currently running in/);
  assert.match(run.stdout, /## Archetypes\n\n[\s\S]*- \*\*director\*\* — Coordinates a whole task/);
  assert.match(run.stdout, /## Closing/);
  assert.ok(run.stdout.trimEnd().endsWith('## End of Fadeno dispatch contract'), 'the vocabulary sits inside the contract');
  const worktree = join(root, '.fadeno', 'local', 'worktrees', 'lead');
  const nested = cli(worktree, ['dispatch', '--archetype', 'worker', '--name', 'child'], 'Child task.');
  assert.equal(nested.status, 0, nested.stderr);
  const records = readDispatches(root).records;
  assert.equal(records.length, 2, 'both rows in the main ledger, none in the worktree');
  assert.ok(!existsSync(join(worktree, '.fadeno', 'dispatches.jsonl')));
  assert.ok(existsSync(join(root, '.fadeno', 'local', 'worktrees', 'child')));
});

test('--dry-run answers what would happen and writes nothing, by the same path that would open it', (t) => {
  const root = repo(t);
  // No prompt at all: a dry run has nothing to dispatch and does not pretend to.
  const run = cli(root, ['dispatch-open', '--archetype', 'worker', '--dry-run', '--json'], '');
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(answer.ok, true);
  assert.equal(answer.opened, false);
  assert.equal(answer.dryRun, true);
  assert.equal(answer.lane, 'command');
  assert.equal(answer.model, 'echo');
  assert.equal(answer.modelId, 'echo-model');
  assert.equal(answer.effort, 'high');
  assert.equal(answer.deliverable, true);
  assert.ok(!existsSync(join(root, LEDGER_FILE)), 'a dry run writes no row');
  assert.ok(!existsSync(join(root, '.fadeno', 'local')), 'and stages nothing');

  // Unclosed rows are advisory now, so the same dry run remains available even
  // when five stopped dispatches await decisions.
  for (let i = 0; i < 5; i += 1) {
    cli(root, ['dispatch-open', '--archetype', 'reviewer', '--lane', 'host', '--name', `r${i}`], `job ${i}`);
    cli(root, ['dispatch-stop', `r${i}`], 'done');
  }
  const available = cli(root, ['dispatch-open', '--archetype', 'worker', '--dry-run', '--json'], '');
  assert.equal(available.status, 0, available.stderr);
  assert.equal(JSON.parse(available.stdout).ok, true);
});

test('a sealed prompt is recorded as an absence with a reason, never as the ask', (t) => {
  const root = repo(t);
  const run = cli(root, [
    'dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'sealed', '--json',
    '--agent-id', 'agent-42', '--prompt-sealed', 'Codex encrypted the message',
  ]);
  assert.equal(run.status, 0, run.stderr);
  const opened = readDispatches(root).records[0]!.opened!;
  assert.equal(opened.prompt_sealed, true);
  assert.equal(opened.agent_id, 'agent-42');
  assert.match(opened.task, /Fadeno did not see this dispatch's prompt: Codex encrypted the message/);
  assert.doesNotMatch(opened.task, /^Codex encrypted/, 'the reason is framed as an absence, not offered as the task');
  // And the detail view says so at the top, where a reader looks first.
  const shown = cli(root, ['dispatches', 'sealed']);
  assert.match(shown.stdout, /the ask:\s+NOT RECORDED — Fadeno did not see this dispatch's prompt: Codex encrypted the message/);

  // `--agent-id` resolves the stop exactly, with no transcript to read.
  const stopped = cli(root, ['dispatch-stop', '--agent-id', 'agent-42', '--json'], 'done');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).name, 'sealed');

  // An agent id nobody opened for is not an error here: a stop hook fires for
  // every subagent, and most of them are nobody's dispatch.
  const stranger = cli(root, ['dispatch-stop', '--agent-id', 'agent-nobody', '--json'], 'x');
  assert.equal(stranger.status, 4);
  assert.equal(JSON.parse(stranger.stdout).dispatch, null);
});

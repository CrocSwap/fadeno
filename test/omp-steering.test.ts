import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runSteeringApplyOmp } from '../src/commands/steering.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { inspectOmpMaterialization } from '../src/lib/omp-steering.ts';
import { OMP_IGNORE_PATTERNS } from '../src/lib/source-control.ts';
import { tempRepo } from './helpers.ts';
import fadenoSteering from '../templates/omp/extensions/fadeno-steering.ts';

const hostExpected = new Map([
  ['worker', 'host'],
  ['reviewer', 'host'],
  ['judge', 'host'],
] as const);

test('omp init materializes marked native slots, extension, and exact ignores', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });

  const materialization = inspectOmpMaterialization(root, hostExpected);
  assert.equal(materialization.healthy, true);
  assert.equal(materialization.extension.valid, true);
  assert.match(readFileSync(join(root, '.omp', 'agents', 'worker.md'), 'utf8'), /name: worker/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.omp', 'settings.json'), 'utf8')).extensions, ['./.omp/extensions/fadeno-steering.ts']);
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /# fadeno:omp-steering:begin/);
  for (const pattern of [
    '.omp/agents/worker.md',
    '.omp/agents/fadeno-steering-refused-worker.md',
    '.omp/extensions/fadeno-steering.ts',
  ]) {
    assert.match(gitignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('omp command lane preserves native project agents and materializes a broker', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });
  writeLocalDialState(root, { dials: { worker: { model: 'opencode/hy3-free' } }, shadows: {}, legacyNote: null });
  const result = runSteeringApplyOmp({ repoRoot: root, force: true });

  assert.equal(result.materialization.worker?.kind, 'command-broker');
  assert.equal(existsSync(join(root, '.omp', 'agents', 'fadeno-dispatch-worker.md')), true);
  assert.equal(existsSync(join(root, '.omp', 'agents', 'worker.md')), false);
  assert.match(readFileSync(join(root, '.omp', 'agents', 'fadeno-dispatch-worker.md'), 'utf8'), /name: fadeno-dispatch-worker/);
  assert.match(readFileSync(join(root, '.omp', 'agents', 'fadeno-dispatch-worker.md'), 'utf8'), /dispatch --archetype worker --prompt-file/);
  assert.match(readFileSync(join(root, '.omp', 'agents', 'fadeno-dispatch-worker.md'), 'utf8'), /FADENO_HARNESS=omp "\$\{FADENO_CLI:-fadeno\}" dispatch/);
});

test('omp init with an existing command dial does not recreate the host slot', (t) => {
  const root = tempRepo(t);
  writeLocalDialState(root, { dials: { worker: { model: 'opencode/hy3-free' } }, shadows: {}, legacyNote: null });
  runInit({ target: 'omp', repoRoot: root, force: true });

  assert.equal(existsSync(join(root, '.omp', 'agents', 'worker.md')), false);
  assert.equal(existsSync(join(root, '.omp', 'agents', 'fadeno-dispatch-worker.md')), true);
  assert.equal(existsSync(join(root, '.omp', 'agents', 'dispatch-worker.md')), true);
  const materialization = inspectOmpMaterialization(root, new Map([
    ['worker', 'command'],
    ['reviewer', 'host'],
    ['judge', 'host'],
  ]));
  assert.equal(materialization.healthy, true);
});

test('omp apply migrates the old project-relative extension entry and preserves foreign entries', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });
  const settingsPath = join(root, '.omp', 'settings.json');
  writeFileSync(settingsPath, `${JSON.stringify({ extensions: ['./foreign.ts', './extensions/fadeno-steering.ts'] }, null, 2)}\n`, 'utf8');

  runSteeringApplyOmp({ repoRoot: root, force: true });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions, [
    './foreign.ts',
    './.omp/extensions/fadeno-steering.ts',
  ]);
});

test('omp settings failures are preserved and reported as unhealthy', (t) => {
  for (const [name, body] of [
    ['invalid-json', '{ not json\n'],
    ['non-array', `${JSON.stringify({ extensions: 'wrong' }, null, 2)}\n`],
    ['mixed-array', `${JSON.stringify({ extensions: ['./foreign.ts', 7] }, null, 2)}\n`],
  ] as const) {
    const root = tempRepo(t);
    runInit({ target: 'omp', repoRoot: root, force: true });
    const settingsPath = join(root, '.omp', 'settings.json');
    writeFileSync(settingsPath, body, 'utf8');
    runSteeringApplyOmp({ repoRoot: root, force: true });
    assert.equal(readFileSync(settingsPath, 'utf8'), body, name);
    const materialization = inspectOmpMaterialization(root, hostExpected);
    assert.equal(materialization.healthy, false, name);
    assert.equal(materialization.settingsRegistered, false, name);
    assert.ok(materialization.issues.some((issue) => issue.kind === 'malformed' && issue.path === settingsPath), name);
  }
});

test('omp status detects a valid settings file that does not register steering', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });
  const settingsPath = join(root, '.omp', 'settings.json');
  writeFileSync(settingsPath, `${JSON.stringify({ extensions: ['./foreign.ts'] }, null, 2)}\n`, 'utf8');
  const materialization = inspectOmpMaterialization(root, hostExpected);
  assert.equal(materialization.healthy, false);
  assert.equal(materialization.settingsRegistered, false);
  assert.ok(materialization.issues.some((issue) => issue.kind === 'unregistered'));
});

test('omp aliases preserve a foreign preferred name and carry the matching frontmatter name', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });
  const preferred = join(root, '.omp', 'agents', 'worker.md');
  const foreign = readFileSync(preferred, 'utf8');
  const foreignBody = foreign
    .replace('name: worker', 'name: my-worker')
    .replace(/<!-- fadeno:managed[^\n]*\n/, '');
  writeFileSync(preferred, foreignBody, 'utf8');

  runSteeringApplyOmp({ repoRoot: root, force: true });
  const alias = join(root, '.omp', 'agents', 'fadeno-steering-host-worker.md');
  assert.equal(existsSync(preferred), true);
  assert.equal(existsSync(alias), true);
  assert.match(readFileSync(alias, 'utf8'), /name: fadeno-steering-host-worker/);
  assert.equal(readFileSync(preferred, 'utf8'), foreignBody);
  const materialization = inspectOmpMaterialization(root, hostExpected);
  assert.equal(materialization.slots[0]?.host.path, alias);
  assert.equal(materialization.healthy, false);
});

test('omp extension source has native flat/batch rewrites, digests, refusal, and correlation fields', () => {
  const extension = readFileSync(join(import.meta.dirname, '..', 'templates', 'omp', 'extensions', 'fadeno-steering.ts'), 'utf8');
  for (const token of ['tool_call', 'input.tasks', 'prompt-sha256', 'resolver_timeout', 'host_refused', 'background', 'task_id', 'session_id', 'call_id']) {
    assert.match(extension, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), token);
  }
});

function fakeResolver(root: string): string {
  const path = join(root, 'fake-fadeno.mjs');
  writeFileSync(path, `#!/usr/bin/env node
const role = process.argv[process.argv.indexOf('--archetype') + 1];
if (process.argv[process.argv.indexOf('--host-executor') + 1] !== 'current-host') process.exit(2);
const mode = process.env.FADENO_TEST_MODE === 'host' ? 'host' : role === 'reviewer' ? 'restart_required' : 'command';
const row = mode === 'restart_required'
  ? { mode, detail: 'restart omp to activate reviewer routing', lane: 'refused' }
  : { mode, lane: mode, executor: mode === 'host' ? 'current-host' : 'opencode', model: mode === 'host' ? null : 'hy3-free' };
process.stdout.write(JSON.stringify(row));
`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function captureToolCallHandler(): (event: unknown, ctx: unknown) => Promise<unknown> {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  fadenoSteering({ on(event, candidate) { if (event === 'tool_call') handler = candidate; } });
  assert.ok(handler);
  return handler;
}

test('omp extension behavior rewrites flat and batch tasks without losing native fields', async (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });
  const priorCli = process.env.FADENO_CLI;
  const priorMode = process.env.FADENO_TEST_MODE;
  process.env.FADENO_CLI = fakeResolver(root);
  delete process.env.FADENO_TEST_MODE;
  t.after(() => {
    if (priorCli == null) delete process.env.FADENO_CLI; else process.env.FADENO_CLI = priorCli;
    if (priorMode == null) delete process.env.FADENO_TEST_MODE; else process.env.FADENO_TEST_MODE = priorMode;
  });
  const handler = captureToolCallHandler();

  const flat = await handler({
    toolName: 'task',
    toolCallId: 'flat-call',
    input: { agent: 'worker', task: 'implement it', name: 'flat', custom: { keep: true } },
  }, { cwd: root }) as { input: Record<string, unknown> };
  assert.equal(flat.input.agent, 'fadeno-dispatch-worker');
  assert.deepEqual(flat.input.custom, { keep: true });

  const batch = await handler({
    toolName: 'task',
    sessionId: 'batch-session',
    input: {
      context: 'shared',
      extra: 7,
      tasks: [
        { agent: 'worker', task: 'build', name: 'build', metadata: { keep: 1 } },
        { agent: 'reviewer', task: 'review', name: 'review' },
        { agent: 'scout', task: 'inspect', name: 'inspect' },
      ],
    },
  }, { cwd: root }) as { input: { context: string; extra: number; tasks: Array<Record<string, unknown>> } };
  assert.equal(batch.input.context, 'shared');
  assert.equal(batch.input.extra, 7);
  assert.equal(batch.input.tasks[0]?.agent, 'fadeno-dispatch-worker');
  assert.deepEqual(batch.input.tasks[0]?.metadata, { keep: 1 });
  assert.equal(batch.input.tasks[1]?.agent, 'fadeno-steering-refused-reviewer');
  assert.match(String(batch.input.tasks[1]?.task), /REFUSAL REASON: restart omp to activate reviewer routing/);
  assert.equal(batch.input.tasks[2]?.agent, 'scout');
});

test('omp extension leaves host-owned async policy untouched and records honest evidence', async (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });
  const priorCli = process.env.FADENO_CLI;
  const priorMode = process.env.FADENO_TEST_MODE;
  process.env.FADENO_CLI = fakeResolver(root);
  process.env.FADENO_TEST_MODE = 'host';
  t.after(() => {
    if (priorCli == null) delete process.env.FADENO_CLI; else process.env.FADENO_CLI = priorCli;
    if (priorMode == null) delete process.env.FADENO_TEST_MODE; else process.env.FADENO_TEST_MODE = priorMode;
  });
  const handler = captureToolCallHandler();
  const original = { agent: 'worker', task: 'background work', name: 'native-job', custom: 'preserved' };
  const result = await handler({ toolName: 'task', toolCallId: 'host-call', input: original }, { cwd: root });
  assert.equal(result, undefined);

  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const delivered = rows.find((row) => row.event === 'host_delivery');
  assert.ok(delivered);
  assert.equal(delivered.background, null);
  assert.equal(delivered.async_lifecycle, 'host-owned');
  assert.equal(delivered.call_id, 'host-call');
  assert.equal(delivered.task_name, 'native-job');
});

test('omp plugin-layout extension prefers its bundled CLI without FADENO_CLI', async (t) => {
  const root = tempRepo(t);
  runInit({ target: 'omp', repoRoot: root, force: true });
  const extensionDir = join(root, 'extensions');
  const binDir = join(root, 'bin');
  mkdirSync(extensionDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const extensionPath = join(extensionDir, 'fadeno-steering.ts');
  writeFileSync(
    extensionPath,
    readFileSync(join(import.meta.dirname, '..', 'templates', 'omp', 'extensions', 'fadeno-steering.ts'), 'utf8'),
    'utf8',
  );
  const bundledCli = join(binDir, 'fadeno');
  writeFileSync(bundledCli, `#!/usr/bin/env node
if (process.argv[process.argv.indexOf('--host-executor') + 1] !== 'current-host') process.exit(2);
process.stdout.write(JSON.stringify({ mode: 'host', lane: 'host', executor: 'current-host' }));
`, 'utf8');
  chmodSync(bundledCli, 0o755);

  const priorCli = process.env.FADENO_CLI;
  delete process.env.FADENO_CLI;
  t.after(() => { if (priorCli == null) delete process.env.FADENO_CLI; else process.env.FADENO_CLI = priorCli; });
  const imported = await import(`${pathToFileURL(extensionPath).href}?test=${Date.now()}`) as { default: typeof fadenoSteering };
  assert.equal(realpathSync(process.env.FADENO_CLI!), realpathSync(bundledCli));
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  imported.default({ on(event, candidate) { if (event === 'tool_call') handler = candidate; } });
  assert.ok(handler);
  const result = await handler({ toolName: 'task', input: { agent: 'worker', task: 'plugin route' } }, { cwd: root });
  assert.equal(result, undefined);
  assert.match(readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8'), /"event":"host_delivery"/);
});

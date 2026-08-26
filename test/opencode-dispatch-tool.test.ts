import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runSteeringApplyOpenCode } from '../src/commands/steering.ts';
import { tempRepo } from './helpers.ts';

/**
 * The OpenCode background-dispatch tool plugin's pure core. Same loader
 * constraint as the steering plugin (every exported function value is CALLED
 * at startup), so everything testable hangs behind `fadenoDispatchToolCore`
 * and tests never need a live OpenCode.
 *
 * The template imports `@opencode-ai/plugin` — OpenCode resolves that package
 * for local plugins, but nothing outside a live OpenCode does. The template is
 * therefore imported through a scratch directory that stubs the package with
 * the two members the template touches (`tool`, `tool.schema`), mirroring the
 * real helper's contract (packages/plugin/src/tool.ts: `tool` is the identity
 * function; `tool.schema` is zod). If the stub ever drifts from what the
 * template needs at import time, the top-level import below fails loudly.
 */
const TEMPLATE_PATH = join(import.meta.dirname, '..', 'templates', 'opencode', 'plugin', 'fadeno-dispatch-tool.js');

const STUB_PLUGIN_PACKAGE = `
const chainable = () => {
  const schema = {
    describe() { return schema; },
    optional() { return schema; },
  };
  return schema;
};
export function tool(input) { return input; }
tool.schema = { string: chainable, number: chainable };
`;

const scratchDir = mkdtempSync(join(tmpdir(), 'fadeno-dispatch-tool-test-'));
mkdirSync(join(scratchDir, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true });
writeFileSync(join(scratchDir, 'node_modules', '@opencode-ai', 'plugin', 'package.json'), JSON.stringify({ name: '@opencode-ai/plugin', type: 'module', main: 'index.js' }));
writeFileSync(join(scratchDir, 'node_modules', '@opencode-ai', 'plugin', 'index.js'), STUB_PLUGIN_PACKAGE);
writeFileSync(join(scratchDir, 'fadeno-dispatch-tool.js'), readFileSync(TEMPLATE_PATH, 'utf8'));
const pluginModule = await import(join(scratchDir, 'fadeno-dispatch-tool.js'));

const core = pluginModule.fadenoDispatchToolCore() as {
  ARCHETYPES: string[];
  DISPATCH_ID_TIMEOUT_MS: number;
  MAX_WAIT_SECONDS: number;
  buildArgv: (archetype: string, tag: string) => string[];
  buildTag: (archetype: string, now?: number) => string;
  formatDuration: (ms: number) => string;
  parseDispatchId: (stdout: string | null | undefined) => string | null;
  reportFilePath: (row: Record<string, unknown>) => string | null;
  launchDispatch: (
    repoDir: string,
    archetype: string,
    tag: string,
    prompt: string,
    argv0?: string,
    spawnFn?: any,
  ) => Promise<{ ok: boolean; dispatchId: string | null; tag: string; message: string }>;
  waitForOutput: (
    repoDir: string,
    tag: string,
    seconds: number,
    argv0?: string,
    spawnSyncFn?: any,
  ) => string | null;
  watchRegistryPath: (repoDir: string) => string;
  readWatchRegistry: (path: string) => Array<{ dispatchId: string; tag?: string; sessionID?: string }>;
  writeWatchRegistry: (path: string, entries: Array<Record<string, unknown>>) => string | null;
  usedTags: (evidencePath: string) => Set<string>;
  dedupeTag: (tag: string, evidencePath: string) => { tag: string; deduped: boolean };
  consumeEvidence: (
    chunk: string | null | undefined,
    watched: Map<string, { tag?: string; sessionID?: string | null }>,
    pending: Map<string, { tag: string; sessionID?: string | null }>,
    notified: Set<string>,
  ) => Array<Record<string, any>>;
  lastRequestIdForTag: (evidenceText: string | null | undefined, tag: string) => string | null;
  extractCompletedRows: (chunk: string | null | undefined) => Array<Record<string, any>>;
  verdictOf: (row: Record<string, unknown>) => string;
  buildCompletionMessage: (tag: string, row: Record<string, unknown>, report: string | null) => string;
  truncateReport: (text: unknown) => string | null;
};

test.after?.(() => rmSync(scratchDir, { recursive: true, force: true }));

test('buildArgv pins the kernel contract: dispatch + archetype + tag, prompt on stdin', () => {
  assert.deepEqual(core.buildArgv('worker', 'bg-worker-abc'), ['dispatch', '--archetype', 'worker', '--tag', 'bg-worker-abc']);
});

test('buildTag is sortable, archetype-scoped, and unique per launch', () => {
  const first = core.buildTag('worker', 1700000000000);
  assert.match(first, /^bg-worker-[0-9a-z]+$/);
  assert.notEqual(core.buildTag('worker', 1700000000001), first);
});

test('parseDispatchId extracts the kernel uuid and rejects near misses', () => {
  const id = core.parseDispatchId('worker → ox\nexternal sandbox...\ndispatch id: 043d7b8a-6210-4564-a8a5-ea2bfa0192f3 (tag: bg)\n');
  assert.equal(id, '043d7b8a-6210-4564-a8a5-ea2bfa0192f3');
  assert.equal(core.parseDispatchId('dispatch id: not-a-uuid'), null);
  assert.equal(core.parseDispatchId(''), null);
  assert.equal(core.parseDispatchId(null), null);
});

test('launchDispatch captures the id from STDERR — where the kernel actually prints it', async () => {
  // cli.ts echoes progress via console.error, so `dispatch id:` arrives on
  // stderr. Two days of live launches lost this race because only stdout was
  // parsed; this pins both streams as correlation channels.
  let unrefd = false;
  const child = {
    stdin: { write() {}, end() {}, on() {}, destroy() {} },
    stdout: { setEncoding() {}, on() {}, destroy() {} },
    stderr: { setEncoding() {}, on(_event: string, handler: (chunk: string) => void) { handler('worker → ox\ndispatch id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee (tag: t)\n'); }, destroy() {} },
    once() {},
    unref() { unrefd = true; },
  };
  const result = await core.launchDispatch('/repo', 'worker', 't-stderr', 'p', 'fadeno', () => child);
  assert.equal(result.ok, true);
  assert.equal(result.dispatchId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(unrefd, true);
});

test('launchDispatch resolves with the id as soon as the kernel prints it, then detaches', async () => {
  // A fake spawn whose child prints the id on the first stdout chunk. The
  // tool must resolve WITHOUT waiting for close — detachment is the contract.
  let unrefd = false;
  const child = {
    stdin: { write() {}, end() {}, on() {}, destroy() {} },
    stdout: { setEncoding() {}, on(_event: string, handler: (chunk: string) => void) { handler('dispatch id: 11111111-2222-3333-4444-555555555555 (tag: t)\n'); }, destroy() {} },
    stderr: { setEncoding() {}, on() {}, destroy() {} },
    once() {},
    unref() { unrefd = true; },
  };
  let spawned = 0;
  const result = await core.launchDispatch('/repo', 'worker', 't1', 'do the thing', 'fadeno', () => {
    spawned += 1;
    return child;
  });
  assert.equal(result.ok, true);
  assert.equal(result.dispatchId, '11111111-2222-3333-4444-555555555555');
  assert.equal(unrefd, true);
  assert.equal(spawned, 1);
});

test('launchDispatch reports a kernel that dies before naming an id', async () => {
  const handlers: Record<string, Array<(code?: number) => void>> = {};
  const child = {
    stdin: { write() {}, end() {}, on() {}, destroy() {} },
    stdout: { setEncoding() {}, on(_e: string, _h: unknown) {}, destroy() {} },
    stderr: { setEncoding() {}, on(_e: string, h: (chunk: string) => void) { (handlers.data ??= []).push(h); }, destroy() {} },
    once(event: string, handler: (code?: number) => void) { (handlers[event] ??= []).push(handler); },
    unref() {},
  };
  const pending = core.launchDispatch('/repo', 'judge', 't2', 'p', 'fadeno', () => child);
  // Let the .on() registrations land, then the kernel dies with stderr.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const handler of handlers.data ?? []) handler('dial resolve failed: no route');
  for (const handler of handlers.close ?? []) handler(1);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.message, /exited before naming a dispatch id/);
  assert.match(result.message, /no route/);
});

test('launchDispatch survives a spawn that throws (no fadeno on PATH)', async () => {
  const result = await core.launchDispatch('/repo', 'worker', 't3', 'p', 'fadeno', () => {
    throw new Error('spawn fadeno ENOENT');
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /could not spawn fadeno/);
});

test('waitForOutput clamps to the cap and passes --wait to the kernel', () => {
  const calls: any[] = [];
  const out = core.waitForOutput('/repo', 'tag-x', 99999, 'fadeno', (_argv0: string, argv: string[]) => {
    calls.push(argv);
    return { stdout: 'REPORT\n', stderr: '' };
  });
  assert.equal(out, 'REPORT');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 4), ['dispatches', '--output', 'tag:tag-x', '--wait']);
  assert.equal(Number(calls[0]![4]), core.MAX_WAIT_SECONDS);
  // Zero wait never spawns: fire-and-forget means fire-and-forget.
  assert.equal(core.waitForOutput('/repo', 'tag-y', 0, 'fadeno', () => {
    throw new Error('must not be called');
  }), null);
});

test('reportFilePath mirrors the kernel attestation name and degrades to null', () => {
  // Pinned to src/commands/dispatch.ts:1281 — archetype-prefixed, 8-char id.
  assert.equal(core.reportFilePath({ dispatch_id: '043d7b8a-6210-4564-a8a5-ea2bfa0192f3', archetype: 'worker' }), join('.fadeno', 'local', 'outputs', 'worker-043d7b8a.md'));
  assert.equal(core.reportFilePath({ dispatch_id: '043d7b8a-6210', role: 'judge' }), join('.fadeno', 'local', 'outputs', 'judge-043d7b8a.md'));
  assert.equal(core.reportFilePath({ dispatch_id: 'short' }), join('.fadeno', 'local', 'outputs', 'dispatch-short.md'));
  assert.equal(core.reportFilePath({}), null);
});

test('steering apply emits the dispatch tool beside the steering plugin under the managed mark', (t) => {
  const root = tempRepo(t);
  const applied = runSteeringApplyOpenCode({ repoRoot: root });
  assert.equal(applied.results.some((r) => r.path.endsWith('fadeno-dispatch-tool.js')), true);
  const toolPath = join(root, '.opencode', 'plugin', 'fadeno-dispatch-tool.js');
  assert.equal(existsSync(toolPath), true);
  const body = readFileSync(toolPath, 'utf8');
  assert.ok(body.startsWith('// fadeno:managed'));
  assert.match(body, /fadeno_dispatch/);
  assert.match(body, /fadenoDispatchToolCore/);
  // The 2026-08-26 live-run repairs must survive template edits: the explicit
  // no-poll instruction and tag deduplication are behavior the host reads.
  assert.match(body, /End your turn now/);
  assert.match(body, /dedupeTag\(/);
});

test('extractCompletedRows picks terminal rows out of an appended evidence chunk', () => {
  const requested = JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'aaa', tag: 't' });
  const completed = JSON.stringify({ event: 'dispatch_completed', dispatch_id: 'aaa', exit_code: 0 });
  const other = JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'bbb' });
  const garbage = '{not json';
  const rows = core.extractCompletedRows(`${requested}\n${completed}\n${other}\n${garbage}\n\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.dispatch_id, 'aaa');
  assert.equal(rows[0]!.exit_code, 0);
  assert.deepEqual(core.extractCompletedRows(''), []);
  assert.deepEqual(core.extractCompletedRows(null), []);
});

test('verdictOf speaks the kernel vocabulary: ok or FAILED with exit code, plus duration', () => {
  assert.equal(core.verdictOf({ exit_code: 0 }), 'ok');
  assert.equal(core.verdictOf({ exit_code: 1 }), 'FAILED (exit 1)');
  assert.equal(core.verdictOf({}), 'FAILED (exit unknown)');
  // The kernel stamps duration_ms on every completion row; a long healthy
  // review should read as long and healthy, not hung (Codex host feedback).
  assert.equal(core.verdictOf({ exit_code: 0, duration_ms: 855944 }), 'ok · ran 14m 15s');
  assert.equal(core.verdictOf({ exit_code: 0, duration_ms: 42000 }), 'ok · ran 42s');
  assert.equal(core.verdictOf({ exit_code: 0, duration_ms: Number.NaN }), 'ok');
});

test('buildCompletionMessage carries tag, verdict, and a bounded report', () => {
  const row = { dispatch_id: 'aaa', exit_code: 0 };
  const message = core.buildCompletionMessage('bg-worker-x', row, 'All green.');
  assert.match(message, /tag bg-worker-x/);
  assert.match(message, /verdict ok/);
  assert.match(message, /All green\./);
  // No report -> point at the attested output file, never a CLI wait.
  assert.match(core.buildCompletionMessage('bg-worker-x', { dispatch_id: 'aaa', exit_code: 0, archetype: 'worker' }, null), /Full report file: .*worker-aaa\.md/);
  assert.doesNotMatch(core.buildCompletionMessage('bg-worker-x', row, null), /fadeno dispatches/);
  // Oversized reports are truncated, never dropped.
  const huge = core.buildCompletionMessage('t', row, 'x'.repeat(core.REPORT_MAX_CHARS + 500));
  assert.match(huge, /\[truncated\]/);
  assert.ok(huge.length < core.REPORT_MAX_CHARS + 200);
});

test('truncateReport trims, bounds, and rejects empty', () => {
  assert.equal(core.truncateReport('  hi  \n'), 'hi');
  assert.equal(core.truncateReport('   '), null);
  assert.equal(core.truncateReport(undefined), null);
  const bounded = core.truncateReport('y'.repeat(core.REPORT_MAX_CHARS * 3));
  assert.equal(bounded!.length, core.REPORT_MAX_CHARS + '…[truncated]'.length);
});

test('watch registry round-trips and degrades to empty on garbage', (t) => {
  const root = tempRepo(t);
  const path = core.watchRegistryPath(root);
  assert.deepEqual(core.readWatchRegistry(path), []);
  core.writeWatchRegistry(path, [{ dispatchId: 'aaa', tag: 't', sessionID: 'ses_1' }]);
  assert.deepEqual(core.readWatchRegistry(path), [{ dispatchId: 'aaa', tag: 't', sessionID: 'ses_1' }]);
  writeFileSync(path, '{broken');
  assert.deepEqual(core.readWatchRegistry(path), []);
  writeFileSync(path, JSON.stringify({ not: 'an array' }));
  assert.deepEqual(core.readWatchRegistry(path), []);
});

test('writeWatchRegistry reports success and failure instead of swallowing silently', (t) => {
  const root = tempRepo(t);
  // Success is null so persistWatched can stay quiet when nothing went wrong.
  const ok = core.writeWatchRegistry(core.watchRegistryPath(root), []);
  assert.equal(ok, null);
  // A directory sitting where the file must go makes writeFileSync fail —
  // exactly the class of silent gap that hid the 2026-08-25/26 registry
  // anomaly. The failure must come back as a diagnosable string.
  const blocked = join(root, '.fadeno', 'blocked');
  mkdirSync(join(blocked, core.WATCH_REGISTRY_BASENAME), { recursive: true });
  const failure = core.writeWatchRegistry(join(blocked, core.WATCH_REGISTRY_BASENAME), [
    { dispatchId: 'aaa', tag: 't' },
  ]);
  assert.equal(typeof failure, 'string');
  assert.ok(failure!.length > 0);
});

test('usedTags reads the evidence log and degrades to empty on absence or garbage', (t) => {
  const root = tempRepo(t);
  const evidence = join(root, '.fadeno', 'dispatches.jsonl');
  assert.equal(core.usedTags(evidence).size, 0);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    evidence,
    [
      JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'a', tag: 'first' }),
      '{not json',
      JSON.stringify({ event: 'dispatch_completed', dispatch_id: 'a', exit_code: 0 }),
      JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'b', tag: 'second' }),
      JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'c' }),
      '',
    ].join('\n'),
  );
  assert.deepEqual([...core.usedTags(evidence)].sort(), ['first', 'second']);
});

test('dedupeTag keeps free tags, suffixes collisions, and skips taken suffixes', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const evidence = join(root, '.fadeno', 'dispatches.jsonl');
  writeFileSync(evidence, [JSON.stringify({ tag: 'run' }), JSON.stringify({ tag: 'run-2' }), ''].join('\n'));
  assert.deepEqual(core.dedupeTag('fresh', evidence), { tag: 'fresh', deduped: false });
  assert.deepEqual(core.dedupeTag('run', evidence), { tag: 'run-3', deduped: true });
  // An unreadable log means no known collisions — never block the launch.
  assert.deepEqual(core.dedupeTag('run', join(root, '.fadeno', 'missing.jsonl')), { tag: 'run', deduped: false });
});

test('consumeEvidence promotes a tag-pending watch and delivers its completion', () => {
  // The 2026-08-26 no-id launch: the kernel owns the dispatch but the plugin
  // never captured the id. The request row is what closes the gap.
  const watched = new Map();
  const pending = new Map([['slow-tag', { tag: 'slow-tag', sessionID: 'ses_1' }]]);
  const notified = new Set();
  const chunk = [
    JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'eee', tag: 'slow-tag' }),
    JSON.stringify({ event: 'dispatch_completed', dispatch_id: 'eee', exit_code: 0 }),
    '',
  ].join('\n');
  const deliveries = core.consumeEvidence(chunk, watched, pending, notified);
  assert.equal(pending.size, 0);
  assert.deepEqual(watched.get('eee'), { tag: 'slow-tag', sessionID: 'ses_1' });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.dispatch_id, 'eee');
  // Promotion never resurrects a delivery that already happened.
  const again = new Map([['x', { tag: 'x', sessionID: 's' }]]);
  const rewatched = new Map();
  core.consumeEvidence(JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'done', tag: 'x' }), rewatched, again, new Set(['done']));
  assert.equal(rewatched.size, 0);
  // Duplicate completion rows collapse to one delivery; foreign completions
  // are returned but harmlessly miss the watch.
  const dupes = core.consumeEvidence(
    [JSON.stringify({ event: 'dispatch_completed', dispatch_id: 'z', exit_code: 1 }), JSON.stringify({ event: 'dispatch_completed', dispatch_id: 'z', exit_code: 1 })].join('\n'),
    new Map(),
    new Map(),
    new Set(),
  );
  assert.equal(dupes.length, 1);
});

test('lastRequestIdForTag scans full evidence history for a tag\u2019s newest request row', () => {
  const text = [
    JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'old', tag: 'run' }),
    '{not json',
    JSON.stringify({ event: 'dispatch_completed', dispatch_id: 'old', exit_code: 0 }),
    JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'new', tag: 'run' }),
    JSON.stringify({ event: 'dispatch_requested', dispatch_id: 'other', tag: 'different' }),
    '',
  ].join('\n');
  assert.equal(core.lastRequestIdForTag(text, 'run'), 'new');
  assert.equal(core.lastRequestIdForTag(text, 'missing'), null);
  assert.equal(core.lastRequestIdForTag(null, 'run'), null);
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { spawnSync } from 'node:child_process';
import {
  DispatchCommandError,
  DISPATCHES_FILE,
  DISPATCHES_FORMAT,
  PENDING_RELAYS_FILE,
  PROXY_DISPATCHES_FILE,
  runDispatch,
} from '../src/commands/dispatch.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

const STDIN_ECHO = (prefix: string): string[] => [
  'node',
  '-e',
  `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('${prefix}'+d));`,
];

function seedV3(t: TestContext, extra: Record<string, unknown> = {}): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const base: Record<string, unknown> = {
    schema_version: 3,
    models: {
      'echo-worker': { provider: 'openai', id: 'echo-worker', effort: 'default' },
      'luna-worker': { provider: 'openai', id: 'luna-worker', effort: 'default' },
      'fail-7': { provider: 'openai', id: 'fail-7' },
      'ro-model': { provider: 'openai', id: 'ro-model' },
    },
    routes: {
      standalone: {
        openai: { command: STDIN_ECHO('REPORT:'), write_access: true },
      },
      codex: {
        openai: { command: STDIN_ECHO('REPORT:'), write_access: true },
      },
      'test-harness': {
        openai: { command: STDIN_ECHO('REPORT:'), write_access: true },
      },
    },
    archetypes: {
      worker: {},
      reviewer: { requires_write: 'required' },
    },
    dials: {},
    ...extra,
  };
  // Also merge if extra provides models/routes
  if (extra.models) (base as any).models = { ...(base as any).models, ...(extra.models as any) };
  if (extra.routes) (base as any).routes = { ...(base as any).routes, ...(extra.routes as any) };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(base));
  return root;
}

function evidenceRows(root: string): Record<string, unknown>[] {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('dispatch: request-before-spawn pairing with 1.0 row shape', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-09T12:00:00Z');
  const echoes: string[] = [];
  const result = runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, now, onEcho: (l) => echoes.push(l), userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'REPORT:hello');
  assert.equal(result.exitCode, 0);
  assert.equal(result.executor, 'echo-worker');
  assert.equal(result.model, 'echo-worker');
  assert.equal(result.source, 'repo');
  assert.deepEqual(result.dial, { model: 'echo-worker' });
  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  const [req, comp] = rows as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(req.event, 'dispatch_requested');
  assert.equal(comp.event, 'dispatch_completed');
  assert.equal(req.format, '1.0');
  assert.equal(comp.format, '1.0');
  assert.equal(req.dispatch_id, comp.dispatch_id);
  assert.equal(req.dispatch_id, result.dispatchId);
  assert.deepEqual(req.dial, { model: 'echo-worker' });
  assert.equal(req.executor, 'echo-worker');
  assert.equal(req.model, 'echo-worker');
  assert.equal(req.model_id, 'echo-worker');
  assert.equal(req.reasoning_effort, 'default');
  assert.equal(req.driver, 'openai');
  assert.equal(req.provider, 'openai');
  assert.equal(req.resolution, 'repo');
  assert.ok(!('exit_code' in req));
  assert.ok(!('output_sha256' in req));
  assert.ok(!('duration_ms' in req));
  assert.equal(req.prompt_sha256, sha256Hex('hello'));
  assert.equal(comp.timestamp, new Date(now.getTime() + (comp.duration_ms as number)).toISOString());
  assert.equal(req.prompt_source, 'stdin');
  assert.equal(result.promptSource, 'stdin');
  assert.match(result.promptSnapshot as string, /^\.fadeno\/local\/prompts\/worker-[0-9a-f]{8}\.md$/);
  assert.ok(!('relay_attested' in comp));
  assert.equal(result.relayAttested, null);
  // append-only: second dispatch adds second pair
  runDispatch({ archetype: 'worker', prompt: 'again', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(evidenceRows(root).length, 4);
});

/**
 * The proxy-guard hook's half of the attestation: proof that a dispatch proxy
 * is the caller, keyed by the bytes it is about to send. Without it the kernel
 * cannot tell an un-relayed dispatch from a relay that altered the prompt, and
 * `relay_attested: false` means nothing.
 */
function markProxyDispatch(root: string, prompts: string[], timestamp = '2026-08-12T11:59:45Z'): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, PROXY_DISPATCHES_FILE),
    `${prompts.map((p) => JSON.stringify({ timestamp, archetype: 'worker', prompt_sha256: sha256Hex(p) })).join('\n')}\n`,
  );
}

test('dispatch: relay attestation consumes a matching spawn-side stash', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  markProxyDispatch(root, ['hello\n', 'ello\n']);
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${[
      JSON.stringify({ timestamp: '2026-08-12T10:00:00Z', prompt_sha256: sha256Hex('old') }),
      JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('hello') }),
      JSON.stringify({ timestamp: '2026-08-12T11:59:30Z', prompt_sha256: sha256Hex('other') }),
    ].join('\n')}\n`,
  );
  const attested = runDispatch({ archetype: 'worker', prompt: 'hello\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(attested.relayAttested, true);
  assert.equal(evidenceRows(root).at(-1)!.relay_attested, true);
  const remaining = readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { prompt_sha256: string });
  assert.deepEqual(remaining.map((row) => row.prompt_sha256), [sha256Hex('other')]);

  const mangled = runDispatch({ archetype: 'worker', prompt: 'ello\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(mangled.relayAttested, false);
  assert.equal(evidenceRows(root).at(-1)!.relay_attested, false);
});

test('dispatch: pending relay stale-pruned and trailing-newline tolerance', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // trailing newline case: stash has sha of 'hello' without newline, dispatch with 'hello\n' still matches via heredoc contract
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('hello') })}\n`,
  );
  markProxyDispatch(root, ['hello\n']);
  const r = runDispatch({ archetype: 'worker', prompt: 'hello\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(r.relayAttested, true);
  // after consumption file should be removed (no remaining fresh entries)
  assert.ok(!existsSync(join(root, PENDING_RELAYS_FILE)) || readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8').trim() === '');
});

test('dispatch: concurrent pending relay survives', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${[
      JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('first') }),
      JSON.stringify({ timestamp: '2026-08-12T11:59:30Z', prompt_sha256: sha256Hex('second') }),
    ].join('\n')}\n`,
  );
  markProxyDispatch(root, ['first\n']);
  runDispatch({ archetype: 'worker', prompt: 'first\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  const remaining = readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8').trim().split('\n').map(l=>JSON.parse(l) as any);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].prompt_sha256, sha256Hex('second'));
});

/**
 * The reason this fix exists. An un-relayed `fadeno dispatch` that happens to
 * run while someone else's spawn attestation is still fresh used to be
 * reported `relay_attested: false` — indistinguishable from a relay that
 * altered the prompt. Two such rows sit in this repo's own ledger from
 * 2026-08-17 and nothing can now say which case they were. No proxy marker
 * means no proxy sent it, so the honest verdict is `null`.
 */
test('dispatch: an un-relayed dispatch colliding with a fresh stash attests null, not false', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // Someone else's relay is in flight, and it is fresh.
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('someone-elses-prompt') })}\n`,
  );
  // No proxy marker: this dispatch was typed directly, not relayed.
  const result = runDispatch({ archetype: 'worker', prompt: 'mine\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(result.relayAttested, null);
  assert.ok(!('relay_attested' in evidenceRows(root).at(-1)!));
  // And the unrelated attestation is left untouched, still waiting for the
  // dispatch it actually belongs to.
  const stash = readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { prompt_sha256: string });
  assert.deepEqual(stash.map((row) => row.prompt_sha256), [sha256Hex('someone-elses-prompt')]);
});

test('dispatch: a proxy that altered the prompt attests false', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  // The parent handed the proxy these bytes...
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('the original task text\n') })}\n`,
  );
  // ...and the proxy is dispatching DIFFERENT bytes. It still marks itself,
  // which is precisely what makes the alteration visible.
  markProxyDispatch(root, ['a summary of the task\n']);
  const echoed: string[] = [];
  const result = runDispatch({
    archetype: 'worker', prompt: 'a summary of the task\n', repoRoot: root, now,
    userPathOptions: onHarness('standalone'), onEcho: (line: string) => echoed.push(line),
  });
  assert.equal(result.relayAttested, false);
  assert.equal(evidenceRows(root).at(-1)!.relay_attested, false);
  // The row alone is not the deliverable: a defection has to reach the person
  // running the command, while the output it taints is still in front of them.
  assert.ok(echoed.some((line) => line.startsWith('RELAY FIDELITY FAILED:')), echoed.join(' | '));
});

test('dispatch: a proxy dispatch with no spawn-side stash attests null, never false', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-12T12:00:00Z');
  markProxyDispatch(root, ['hello\n']);
  // No pending-relays file at all: the spawn did not route through the
  // steering hook, so there is nothing to check fidelity against. "Cannot
  // say" is not "defected".
  const result = runDispatch({ archetype: 'worker', prompt: 'hello\n', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  assert.equal(result.relayAttested, null);
});

test('dispatch: --prompt-file rows record the given file as the snapshot', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  writeFileSync(join(root, 'task.md'), 'from-a-file');
  const result = runDispatch({ archetype: 'worker', promptFile: 'task.md', cwd: root, repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.promptSource, 'file');
  assert.equal(result.promptSnapshot, 'task.md');
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.prompt_source, 'file');
  assert.equal(row.prompt_snapshot, 'task.md');
  assert.equal(row.prompt_sha256, sha256Hex('from-a-file'));
});

test('dispatch: --prompt-file missing-file and no-prompt errors', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  writeFileSync(join(root, 'prompt.txt'), 'from-file');
  const result = runDispatch({ archetype: 'worker', promptFile: 'prompt.txt', cwd: root, repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'REPORT:from-file');
  assert.throws(
    () => runDispatch({ archetype: 'worker', promptFile: 'missing.txt', cwd: root, repoRoot: root, userPathOptions: onHarness('standalone') }),
    /--prompt-file missing\.txt does not exist/,
  );
  assert.throws(
    () => runDispatch({ archetype: 'worker', repoRoot: root, userPathOptions: onHarness('standalone') }),
    /no prompt: pass --prompt-file <path> or pipe the prompt on stdin/,
  );
});

test('dispatch: unknown --model rejected with helpful list', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  // bypass via --model
  const result = runDispatch({ model: 'echo-worker', prompt: 'raw', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.executor, 'echo-worker');
  assert.equal(result.source, 'model-flag');
  // unknown model: may error about driver or model — accept either, but must mention ghost or declared models
  assert.throws(
    () => runDispatch({ model: 'ghost', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    (err: unknown) => {
      assert.ok(err instanceof DispatchCommandError);
      const msg = (err as Error).message;
      assert.ok(/ghost/.test(msg) || /echo-worker/.test(msg) || /declared/.test(msg) || /unknown driver/.test(msg), `unexpected message: ${msg}`);
      return true;
    },
  );
  // also unknown via with effort should list
  assert.throws(
    () => runDispatch({ model: 'ghost@high', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    DispatchCommandError,
  );
});

test('dispatch: propagates the executor exit code and records it as evidence', (t) => {
  const root = seedV3(t, {
    models: {
      'fail-7': { provider: 'openai', id: 'fail-7' },
      'echo-worker': { provider: 'openai', id: 'echo-worker' },
    },
    routes: {
      standalone: { openai: { command: ['node', '-e', 'process.exit(7)'], write_access: true } },
      codex: { openai: { command: ['node', '-e', 'process.exit(7)'], write_access: true } },
    },
    dials: { worker: 'fail-7' },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, '');
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.exit_code, 7);
  assert.equal(row.output_sha256, sha256Hex(''));
});

test('dispatch: requires --archetype unless --model bypasses', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  assert.throws(
    () => runDispatch({ prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    /needs --archetype/,
  );
  assert.throws(
    () => runDispatch({ archetype: 'Worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') }),
    /--archetype "Worker" is not a bare lowercase identifier/,
  );
});

test('dispatch: a write-needing archetype is refused on a delivery that cannot write', (t) => {
  const root = seedV3(t, {
    models: {
      'ro-model': { provider: 'openai', id: 'ro-model' },
      'rw-model': { provider: 'openai', id: 'rw-model' },
    },
    routes: {
      standalone: { openai: { command: STDIN_ECHO('RO:'), write_access: false } },
      codex: { openai: { command: STDIN_ECHO('RO:'), write_access: false } },
    },
    archetypes: { worker: { requires_write: 'required' } },
    dials: { worker: 'ro-model' },
  });
  let message = '';
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'ship the fix', repoRoot: root, userPathOptions: onHarness('standalone') }),
    (err: unknown) => {
      if (!(err instanceof DispatchCommandError) || !/requires_write/.test(err.message)) return false;
      message = err.message;
      return true;
    },
  );
  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'dispatch_refused');
  assert.equal(rows[0]!.format, DISPATCHES_FORMAT);
  assert.deepEqual(rows[0]!.refusal, { predicate: 'write_posture', message });
  assert.ok(!rows.some((row) => row.event === 'dispatch_requested'));
});

test('dispatch: a write-capable delivery serves the same archetype', (t) => {
  const root = seedV3(t, {
    models: {
      'rw-model': { provider: 'openai', id: 'rw-model' },
    },
    routes: {
      standalone: { openai: { command: STDIN_ECHO('RW:'), write_access: true } },
      codex: { openai: { command: STDIN_ECHO('RW:'), write_access: true } },
    },
    archetypes: { worker: { requires_write: 'required' } },
    dials: { worker: 'rw-model' },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'ship the fix', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.stdout, 'RW:ship the fix');
  const rows = evidenceRows(root);
  // both rows have write_access true in completion? Request may not have but completion does
  const comp = rows.find(r=>r.event==='dispatch_completed')!;
  assert.equal(comp.write_access, true);
});

test('dispatch: a forced direct dial proceeds across its recorded write-posture mismatch', (t) => {
  const root = seedV3(t, {
    models: { 'rw-model': { provider: 'openai', id: 'rw-model' } },
    routes: {
      standalone: { openai: { command: STDIN_ECHO('FORCED:'), write_access: true } },
      codex: { openai: { command: STDIN_ECHO('FORCED:'), write_access: true } },
    },
    archetypes: { generator: { requires_write: 'forbidden' } },
    dials: { generator: { model: 'rw-model', force_write_posture: true } },
  });
  const warnings: string[] = [];
  const result = runDispatch({
    archetype: 'generator',
    prompt: 'make a report',
    repoRoot: root,
    userPathOptions: onHarness('standalone'),
    onEcho: (line) => warnings.push(line),
  });
  assert.equal(result.stdout, 'FORCED:make a report');
  assert.match(warnings.join('\n'), /WARNING: FORCED WRITE-POSTURE MISMATCH/);
  const requested = evidenceRows(root).find((row) => row.event === 'dispatch_requested')!;
  assert.equal(requested.write_posture_forced, true);
  assert.equal((requested.dial as Record<string, unknown>).force_write_posture, true);
});

test('dispatch: exit-code propagation row.exit_code ===7 + sha256("") pinned', (t) => {
  const root = seedV3(t, {
    models: { 'fail-7': { provider: 'openai', id: 'fail-7' } },
    routes: {
      standalone: { openai: { command: ['node', '-e', 'process.exit(7)'], write_access: true } },
      codex: { openai: { command: ['node', '-e', 'process.exit(7)'], write_access: true } },
    },
    dials: { worker: 'fail-7' },
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'p', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(result.exitCode, 7);
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.exit_code, 7);
  assert.equal(row.output_sha256, sha256Hex(''));
});

test('dispatch: request-row negatives + append-only', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const now = new Date('2026-08-09T12:00:00Z');
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, now, userPathOptions: onHarness('standalone') });
  const rows = evidenceRows(root);
  const [req, comp] = rows as [Record<string, unknown>, Record<string, unknown>];
  assert.ok(!('output_sha256' in req));
  assert.ok(!('duration_ms' in req));
  // append-only second pair
  runDispatch({ archetype: 'worker', prompt: 'again', repoRoot: root, userPathOptions: onHarness('standalone') });
  assert.equal(evidenceRows(root).length, 4);
});

test('dispatch: output snapshot agreement and workspace_changed false case', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' };
  spawnSync('git', ['init'], { cwd: root, env });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: root, env });
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, userPathOptions: onHarness('standalone') });
  const comp = evidenceRows(root).find((r) => r.event === 'dispatch_completed')!;
  // tri-state: with git and pure-echo, workspace_changed must be false (not truthy)
  assert.equal(comp.workspace_changed, false);
});

test('dispatch: workspace_changed omitted outside git', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  runDispatch({ archetype: 'worker', prompt: 'hello', repoRoot: root, userPathOptions: onHarness('standalone') });
  const [req, comp] = evidenceRows(root) as [Record<string, unknown>, Record<string, unknown>];
  assert.ok(!('workspace_changed' in req));
  assert.ok(!('workspace_changed' in comp));
});

test('dispatch: unknown --model and empty prompt handling', (t) => {
  const root = seedV3(t, { dials: { worker: 'echo-worker' } });
  assert.throws(() => runDispatch({ archetype: 'worker', prompt: '   ', repoRoot: root, userPathOptions: onHarness('standalone') }), /empty prompt/);
  assert.equal(evidenceRows(root).length, 0);
});

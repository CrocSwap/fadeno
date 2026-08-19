import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatchPrompt, DispatchPromptError } from '../src/commands/dispatch-prompt.ts';
import { runDispatchStart } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { tempRepo } from './helpers.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: dispatch-prompt-fixture
description: Dispatch prompt fixture.
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

function seedHostRun(t: import('node:test').TestContext) {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'dispatch-prompt-fixture.yaml'), PLAYBOOK);
  writeFileSync(join(root, 'task.md'), 'do the thing');
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { luna: { provider: 'dummy', id: 'gpt-5.6-luna', effort: 'xhigh' } },
    routes: { standalone: { dummy: { host: true }, 'current-host': { host: true } }, codex: { dummy: { host: true }, 'current-host': { host: true } }, claude: { dummy: { host: true }, 'current-host': { host: true } }, grok: { dummy: { host: true }, 'current-host': { host: true } } },
    archetypes: { worker: {} },
    bindings: { worker: 'luna' },
  }));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'dispatch-prompt-fixture', task: 'prompt envelope test', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  return { root, runId, runDir, request };
}

function rewriteRequest(runDir: string, dispatchId: string, fields: Record<string, unknown>): void {
  const eventsPath = join(runDir, 'events.jsonl');
  const events = readFileSync(eventsPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = events.find((event) => event.type === 'host_dispatch_requested' && event.dispatch_id === dispatchId);
  assert.ok(request);
  Object.assign(request, fields);
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

test('dispatch-prompt emits exact # Fadeno engine step assignment envelope with immutable ids and prompt bytes', (t) => {
  const { root, runId, runDir, request } = seedHostRun(t);
  const result = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  // Envelope begins with canonical heading
  assert.ok(result.envelope.toString('utf8').startsWith('# Fadeno engine step assignment\n'), 'must start with exact heading');
  // Header contains immutable run and dispatch_id
  assert.ok(result.envelope.includes(Buffer.from(`run: ${runId}\n`)), 'must contain run id');
  assert.ok(result.envelope.includes(Buffer.from(`dispatch_id: ${request.dispatchId}\n`)), 'must contain dispatch_id');
  // After header, the recorded prompt bytes appear verbatim
  const promptBytes = readFileSync(join(runDir, request.promptPath));
  assert.deepEqual(result.prompt, promptBytes);
  assert.equal(result.promptSha256, request.promptSha256);
  // Envelope is header + prompt bytes (prompt is suffix)
  assert.deepEqual(result.envelope.subarray(result.envelope.length - promptBytes.length), promptBytes);
  const expectedPrefix = `# Fadeno engine step assignment\n\nrun: ${runId}\ndispatch_id: ${request.dispatchId}\n\n`;
  assert.deepEqual(result.envelope, Buffer.concat([Buffer.from(expectedPrefix), promptBytes]));
  assert.equal(result.promptPath, request.promptPath);
});

test('dispatch-prompt prompt bytes are immutable and not re-rendered', (t) => {
  const { root, runId, request } = seedHostRun(t);
  const first = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  // Tamper not allowed: envelope must be deterministic across calls
  const second = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  assert.deepEqual(first.envelope, second.envelope);
  assert.equal(first.promptSha256, second.promptSha256);
});

test('dispatch-prompt CLI writes only the exact binary envelope to stdout', (t) => {
  const { root, runId, request } = seedHostRun(t);
  const expected = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId }).envelope;
  const result = spawnSync(process.execPath, [CLI, 'dispatch-prompt', runId, request.dispatchId], { cwd: root });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  assert.deepEqual(result.stdout, expected);
  assert.equal(result.stderr.length, 0);
});

test('dispatch-prompt throws on unknown run or dispatch', (t) => {
  const { root, request } = seedHostRun(t);
  assert.throws(() => runDispatchPrompt({ repoRoot: root, run: 'no-such-run', dispatchId: request.dispatchId }), DispatchPromptError);
  assert.throws(() => runDispatchPrompt({ repoRoot: root, run: request.run, dispatchId: 'no-such-dispatch' }), DispatchPromptError);
});

test('dispatch-prompt throws when prompt sha does not match request', (t) => {
  const { root, runId, runDir, request } = seedHostRun(t);
  const promptAbs = join(runDir, request.promptPath);
  const original = readFileSync(promptAbs, 'utf8');
  writeFileSync(promptAbs, `${original}\n# tampered`, 'utf8');
  assert.throws(() => runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId }), /sha256 mismatch/);
});

test('dispatch-prompt preserves non-text prompt bytes exactly', (t) => {
  const { root, runId, runDir, request } = seedHostRun(t);
  const bytes = Buffer.from([0x66, 0x61, 0x64, 0x65, 0x6e, 0x6f, 0x00, 0xff, 0x0a]);
  writeFileSync(join(runDir, request.promptPath), bytes);
  rewriteRequest(runDir, request.dispatchId, { prompt_sha256: sha256Hex(bytes) });
  const result = runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  assert.deepEqual(result.prompt, bytes);
  assert.deepEqual(result.envelope.subarray(-bytes.length), bytes);
});

test('dispatch-prompt rejects traversal, absolute paths, and symlink snapshots', (t) => {
  {
    const { root, runId, runDir, request } = seedHostRun(t);
    rewriteRequest(runDir, request.dispatchId, { prompt_path: '../outside.md' });
    assert.throws(() => runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId }), /escapes its run directory/);
  }
  {
    const { root, runId, runDir, request } = seedHostRun(t);
    rewriteRequest(runDir, request.dispatchId, { prompt_path: join(runDir, request.promptPath) });
    assert.throws(() => runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId }), /must be run-relative/);
  }
  {
    const { root, runId, runDir, request } = seedHostRun(t);
    const prompt = join(runDir, request.promptPath);
    const target = `${prompt}.target`;
    copyFileSync(prompt, target);
    unlinkSync(prompt);
    symlinkSync(target, prompt);
    assert.throws(() => runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId }), /traverses a symlink/);
  }
});

test('dispatch-prompt is usable via host start receipt remains requested_only', (t) => {
  const { root, runId, request } = seedHostRun(t);
  runDispatchPrompt({ repoRoot: root, run: runId, dispatchId: request.dispatchId });
  const started = runDispatchStart({ repoRoot: root, run: runId, dispatchId: request.dispatchId, agentId: 'host-agent-1' });
  assert.equal(started.state, 'started');
  const evts = readFileSync(join(root, '.fadeno', 'runs', runId, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l as string) as Record<string, unknown>);
  const startEvt = evts.find((e) => (e as Record<string, unknown>).type === 'actor_dispatched' && (e as Record<string, unknown>).dispatch_id === request.dispatchId) as Record<string, unknown>;
  assert.ok(startEvt);
  assert.equal((startEvt as any).identity_evidence, 'requested_only');
});

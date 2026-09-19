import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupPending, clearPending, stashPending } from '../templates/hooks/hook-lib.mjs';
import { runClean } from '../src/commands/dispatches.ts';
import { runPromptConsume, runPromptStage } from '../src/commands/prompt-stage.ts';
import { readDispatches } from '../src/lib/ledger.ts';
import { CANCEL_REQUESTS_DIR } from '../src/lib/spawn.ts';
import { STAGED_PROMPTS_DIR, STAGED_PROMPT_TTL_MS } from '../src/lib/staged-prompts.ts';
import { cli, denial, hookPlugin, hookRepo } from './hook-helpers.ts';
import { gitRepo } from './helpers.ts';

const CLI_TASK = 'fadeno-prompt-test';
const SESSION = 'staged-prompt-session';

function pendingDir(data: string, session = SESSION, archetype = 'worker'): string {
  const key = createHash('sha256').update(`${session}\0${archetype}`).digest('hex');
  return join(data, 'pending', key);
}

function ageFile(path: string, at: number): void {
  utimesSync(path, at / 1000, at / 1000);
}

function rewritePendingAt(path: string, at: number): void {
  const record = JSON.parse(readFileSync(path, 'utf8')) as { at?: number };
  record.at = at;
  writeFileSync(path, JSON.stringify(record));
  ageFile(path, at);
}

function sealedMessage(): string {
  return `gAAAAAB${'sealed-message-token_'.repeat(12)}`;
}

function spawnEvent(root: string, taskName: string, message = sealedMessage()) {
  return {
    session_id: SESSION,
    cwd: root,
    hook_event_name: 'PreToolUse',
    model: 'gpt-6-astra',
    tool_name: 'collaborationspawn_agent',
    tool_use_id: `call-${taskName}`,
    turn_id: 'turn-staged',
    tool_input: {
      agent_type: 'fadeno-worker',
      task_name: taskName,
      message,
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
    },
  };
}

test('prompt-stage returns a schema-safe semantic task_name and consumes it once', (t) => {
  const root = gitRepo(t);
  const staged = cli(root, ['prompt-stage', '--name', 'Fix Login / OAuth!', '--json'], 'Keep this exact task.\n');
  assert.equal(staged.status, 0, staged.stderr);
  const result = JSON.parse(staged.stdout) as { ok: boolean; token: string; name: string; task_name: string; expires_at: string };
  assert.equal(result.ok, true);
  assert.equal(result.name, 'fix_login_oauth');
  assert.match(result.token, /^[a-z0-9]{16}$/);
  assert.equal(result.task_name, `fix_login_oauth_${result.token}`);
  assert.match(result.task_name, /^[a-z0-9_]+$/);
  assert.match(result.expires_at, /T/);
  assert.equal(existsSync(join(root, '.fadeno', 'dispatches.jsonl')), false);
  assert.equal(existsSync(join(root, '.fadeno', 'local', 'worktrees')), false);
  assert.equal(readFileSync(join(root, STAGED_PROMPTS_DIR, `${result.token}.json`), 'utf8').includes('Keep this exact task.'), true);
  assert.equal(statSync(join(root, STAGED_PROMPTS_DIR, `${result.token}.json`)).mode & 0o777, 0o600);
  assert.equal(staged.stdout.includes('Keep this exact task.'), false, 'stage output never echoes plaintext');

  const consumed = cli(root, ['prompt-stage', '--consume', result.task_name, '--json']);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.deepEqual(JSON.parse(consumed.stdout), { ok: true, token: result.token, name: result.name, task_name: result.task_name, prompt: 'Keep this exact task.\n' });
  const replay = cli(root, ['prompt-stage', '--consume', result.task_name, '--json']);
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /missing, expired, already consumed/);
});

test('staged task names reject malformed values, truncate semantic slugs, and keep slug collisions unique', (t) => {
  const root = gitRepo(t);
  const longName = `${'A'.repeat(100)} trailing words`;
  const first = runPromptStage({ repoRoot: root, name: longName, prompt: 'one' });
  const second = runPromptStage({ repoRoot: root, name: '!!!', prompt: 'two' });
  const collision = runPromptStage({ repoRoot: root, name: 'same-name', prompt: 'three' });
  const collision2 = runPromptStage({ repoRoot: root, name: 'same name', prompt: 'four' });
  assert.match(first.taskName, /^a{48}_[a-z0-9]{16}$/);
  assert.equal(second.name, 'prompt');
  assert.equal(collision.name, 'same_name');
  assert.equal(collision2.name, 'same_name');
  assert.notEqual(collision.taskName, collision2.taskName, 'random token disambiguates semantic slug collisions');
  for (const malformed of ['fadeno-prompt-aaaaaaaaaaaaaaaa', 'UPPER_aaaaaaaaaaaaaaaa', 'bad/aaaaaaaaaaaaaaaa', 'prompt_aaaaaaaaaaaaaaa']) {
    assert.throws(() => runPromptConsume({ repoRoot: root, taskName: malformed }), /invalid staged task_name/);
  }
  assert.equal(runPromptConsume({ repoRoot: root, taskName: first.taskName }).prompt, 'one');
  assert.throws(() => runPromptConsume({ repoRoot: root, taskName: first.taskName }), /missing, expired, already consumed/);
});

test('staged prompts expire, reject malformed or copied records, and remain correlation-safe', (t) => {
  const root = gitRepo(t);
  const staged = runPromptStage({ repoRoot: root, prompt: 'expires', now: 1_000 });
  assert.throws(() => runPromptConsume({ repoRoot: root, taskName: staged.taskName, now: 1_000 + STAGED_PROMPT_TTL_MS }), /expired|malformed/);
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${staged.token}.json`)), false);

  const malformed = runPromptStage({ repoRoot: root, prompt: 'malformed', now: 2_000 });
  writeFileSync(join(root, STAGED_PROMPTS_DIR, `${malformed.token}.json`), '{not json\n');
  assert.throws(() => runPromptConsume({ repoRoot: root, taskName: malformed.taskName, now: 2_001 }), /malformed|missing/);
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${malformed.token}.json`)), false);

  const original = runPromptStage({ repoRoot: root, prompt: 'right repository', now: 3_000 });
  const other = gitRepo(t);
  const copied = join(other, STAGED_PROMPTS_DIR, `${original.token}.json`);
  const source = join(root, STAGED_PROMPTS_DIR, `${original.token}.json`);
  mkdirSync(join(other, STAGED_PROMPTS_DIR), { recursive: true });
  copyFileSync(source, copied);
  assert.throws(() => runPromptConsume({ repoRoot: other, taskName: original.taskName, now: 3_001 }), /repository/);
  assert.equal(existsSync(source), true, 'wrong-repository use does not consume the original');
  assert.equal(runPromptConsume({ repoRoot: root, taskName: original.taskName, now: 3_001 }).prompt, 'right repository');
});

test('clean removes only expired staged scratch and never creates or removes dispatch evidence', (t) => {
  const root = gitRepo(t);
  const fresh = runPromptStage({ repoRoot: root, prompt: 'keep me' });
  const expired = runPromptStage({ repoRoot: root, prompt: 'clean me', now: Date.now() - STAGED_PROMPT_TTL_MS - 1_000 });
  mkdirSync(join(root, CANCEL_REQUESTS_DIR), { recursive: true });
  writeFileSync(join(root, CANCEL_REQUESTS_DIR, 'stale.request.json'), '{}');
  const preview = runClean({ repoRoot: root });
  assert.deepEqual(preview.stagedPrompts?.directory, STAGED_PROMPTS_DIR);
  assert.deepEqual(preview.stagedPrompts?.entries, [`${expired.token}.json`]);
  assert.equal(preview.cancelRequests, null, 'an unknown cancellation artifact is not positively stale');
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR)), true);
  assert.equal(existsSync(join(root, CANCEL_REQUESTS_DIR)), true);
  const cleaned = runClean({ repoRoot: root, force: true });
  assert.deepEqual(cleaned.stagedPrompts?.directory, STAGED_PROMPTS_DIR);
  assert.deepEqual(cleaned.stagedPrompts?.entries, [`${expired.token}.json`]);
  assert.equal(cleaned.cancelRequests, null);
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${fresh.token}.json`)), true, 'fresh pending prompt survives');
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${expired.token}.json`)), false);
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR)), true, 'staged-prompt directory is retained');
  assert.equal(existsSync(join(root, CANCEL_REQUESTS_DIR, 'stale.request.json')), true, 'unknown cancellation scratch survives');
  assert.equal(existsSync(join(root, '.fadeno', 'dispatches.jsonl')), false);
});

test('clean treats malformed staged JSON values as stale only after their old mtime', (t) => {
  const root = gitRepo(t);
  const old = Date.now() - STAGED_PROMPT_TTL_MS - 1_000;
  const malformed = ['null', '[]', '{"expiresAt":"later"}'];
  const staged = malformed.map((_, index) => runPromptStage({ repoRoot: root, prompt: `malformed ${index}` }));
  const names = malformed.map((payload, index) => {
    const token = staged[index]!.token;
    const path = join(root, STAGED_PROMPTS_DIR, `${token}.json`);
    writeFileSync(path, payload);
    ageFile(path, old);
    return `${token}.json`;
  });
  const preview = runClean({ repoRoot: root });
  assert.deepEqual(new Set(preview.stagedPrompts?.entries), new Set(names));
  const cleaned = runClean({ repoRoot: root, force: true });
  assert.deepEqual(new Set(cleaned.stagedPrompts?.entries), new Set(names));
  for (const name of names) assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, name)), false);
});

test('Codex host lane recovers a sealed task through the pending handoff and records it at SubagentStart', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const staged = JSON.parse(cli(root, ['prompt-stage', '--json'], 'Recover this original task.\n').stdout) as { task_name: string };
  const passed = plugin.run('spawn-codex.mjs', spawnEvent(root, staged.task_name));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(denial(passed), null);
  assert.match(passed.out?.hookSpecificOutput?.additionalContext ?? '', /recovered the original task/);
  assert.equal(readDispatches(root).records.length, 0, 'PreToolUse still opens nothing');

  const started = plugin.run('spawn-codex.mjs', {
    session_id: SESSION,
    cwd: root,
    hook_event_name: 'SubagentStart',
    agent_id: 'staged-agent',
    agent_type: 'fadeno-worker',
  });
  assert.equal(started.status, 0, started.stderr);
  const opened = readDispatches(root).records[0]!.opened!;
  assert.equal(opened.task, 'Recover this original task.');
  assert.equal(opened.prompt_sealed, undefined);
  assert.equal(readFileSync(join(root, opened.prompt), 'utf8'), 'Recover this original task.\n');
  assert.equal(existsSync(join(root, '.fadeno', 'local', 'staged-prompts')), true, 'the hook does not turn the token into evidence');
});

test('pending handoff repository identity prevents a session crossing repositories', (t) => {
  const plugin = hookPlugin(t);
  const firstRoot = hookRepo(t);
  const secondRoot = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const staged = JSON.parse(cli(firstRoot, ['prompt-stage', '--name', 'repo-a', '--json'], 'only repository A').stdout) as { task_name: string };
  assert.equal(denial(plugin.run('spawn-codex.mjs', spawnEvent(firstRoot, staged.task_name))), null);

  const wrongRepository = plugin.run('spawn-codex.mjs', {
    session_id: SESSION, cwd: secondRoot, hook_event_name: 'SubagentStart', agent_id: 'wrong-repo-agent', agent_type: 'fadeno-worker',
  });
  const wrongRecord = readDispatches(secondRoot).records[0]!.opened!;
  assert.equal(wrongRecord.prompt_sealed, true);
  assert.match(wrongRecord.task, /different repository/);
  assert.equal(wrongRepository.status, 0);

  plugin.run('spawn-codex.mjs', {
    session_id: SESSION, cwd: firstRoot, hook_event_name: 'SubagentStart', agent_id: 'right-repo-agent', agent_type: 'fadeno-worker',
  });
  const rightRecord = readDispatches(firstRoot).records[0]!.opened!;
  assert.equal(rightRecord.prompt_sealed, undefined);
  assert.equal(rightRecord.task, 'only repository A');
});

test('Codex command lane recovers a sealed task and sends plaintext through the existing relay', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t, { dials: { worker: 'opus' } });
  plugin.hostMode(SESSION, true);
  const staged = JSON.parse(cli(root, ['prompt-stage', '--json'], 'Run this through the command lane.\n').stdout) as { task_name: string };
  const refused = denial(plugin.run('spawn-codex.mjs', spawnEvent(root, staged.task_name)));
  assert.match(refused ?? '', /The task is staged; run this/);
  assert.match(refused ?? '', /--name prompt\b/);
  const relay = (refused ?? '').match(/--prompt-file (\S+)/)?.[1];
  assert.ok(relay, refused ?? 'missing relay path');
  assert.equal(readFileSync(relay, 'utf8'), 'Run this through the command lane.\n');
  assert.equal(readDispatches(root).records.length, 0, 'relay staging still opens no row');
});

test('Codex command-lane relay failure rolls back a staged token for the exact retry', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t, { dials: { worker: 'opus' } });
  const otherRoot = hookRepo(t, { dials: { worker: 'opus' } });
  plugin.hostMode(SESSION, true);
  const prompt = 'do not leak or lose this command-lane plaintext';
  const staged = JSON.parse(cli(root, ['prompt-stage', '--name', 'relay retry', '--json'], prompt).stdout) as { task_name: string; token: string };
  const event = spawnEvent(root, staged.task_name);

  // A different session is outside host mode, and a different repository cannot
  // claim the repository-bound token. Neither may consume the staged bytes.
  assert.equal(plugin.run('spawn-codex.mjs', { ...event, session_id: 'other-session' }).out, null);
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${staged.token}.json`)), true);
  const wrongRepository = plugin.run('spawn-codex.mjs', { ...event, cwd: otherRoot });
  assert.match(denial(wrongRepository) ?? '', /missing, expired, already consumed/);
  assert.doesNotMatch(denial(wrongRepository) ?? '', new RegExp(prompt));
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${staged.token}.json`)), true);

  // Force dispatch-open's relay writer to fail after the hook has claimed the
  // token. The failure must restore the original deterministic token.
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  const relayBlocker = join(root, '.fadeno', 'local', 'relay');
  writeFileSync(relayBlocker, 'not a directory');
  const failed = plugin.run('spawn-codex.mjs', event);
  const failedReason = denial(failed);
  assert.match(failedReason ?? '', /could not stage the worker dispatch/);
  assert.doesNotMatch(failedReason ?? '', new RegExp(prompt));
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${staged.token}.json`)), true, 'relay failure restores the staged token');
  assert.equal(readDispatches(root).records.length, 0);

  rmSync(relayBlocker);
  const retried = plugin.run('spawn-codex.mjs', event);
  const retryReason = denial(retried);
  assert.match(retryReason ?? '', /The task is staged; run this/);
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${staged.token}.json`)), false, 'successful relay staging finalizes the claim');
  assert.doesNotMatch(retryReason ?? '', new RegExp(prompt));

  const replay = plugin.run('spawn-codex.mjs', event);
  assert.match(denial(replay) ?? '', /missing, expired, already consumed/);
  assert.equal(readDispatches(root).records.length, 0, 'command-lane relay staging still opens no ledger row');
});

test('concurrent same-session same-archetype PreToolUse reserves one slot and refuses the other', async (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const first = JSON.parse(cli(root, ['prompt-stage', '--name', 'first', '--json'], 'first task').stdout) as { task_name: string };
  const second = JSON.parse(cli(root, ['prompt-stage', '--name', 'second', '--json'], 'second task').stdout) as { task_name: string };
  const [one, two] = await Promise.all([
    plugin.runAsync('spawn-codex.mjs', spawnEvent(root, first.task_name)),
    plugin.runAsync('spawn-codex.mjs', spawnEvent(root, second.task_name)),
  ]);
  const reasons = [denial(one), denial(two)];
  assert.equal(reasons.filter((reason) => reason?.includes('same Codex session')).length, 1, JSON.stringify(reasons));
  assert.equal(reasons.filter((reason) => reason == null).length, 1, JSON.stringify(reasons));
  assert.equal(readDispatches(root).records.length, 0, 'reservation happens before dispatch open');
});

test('concurrent SubagentStart processes atomically claim one pending plaintext', async (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const first = JSON.parse(cli(root, ['prompt-stage', '--name', 'first task', '--json'], 'FIRST staged task').stdout) as { task_name: string };
  const passed = plugin.run('spawn-codex.mjs', spawnEvent(root, first.task_name));
  assert.equal(denial(passed), null);
  const [one, two] = await Promise.all([
    plugin.runAsync('spawn-codex.mjs', { session_id: SESSION, cwd: root, hook_event_name: 'SubagentStart', agent_id: 'first-agent', agent_type: 'fadeno-worker' }),
    plugin.runAsync('spawn-codex.mjs', { session_id: SESSION, cwd: root, hook_event_name: 'SubagentStart', agent_id: 'second-agent', agent_type: 'fadeno-worker' }),
  ]);
  const records = readDispatches(root).records;
  assert.equal(records.length, 2);
  const tasks = records.map((record) => record.opened?.task ?? '');
  assert.equal(tasks.filter((task) => task === 'FIRST staged task').length, 1);
  assert.equal(tasks.filter((task) => /NOT RECORDED|Fadeno recorded no spawn/.test(task)).length, 1);
  assert.notEqual(one.stdout, two.stdout, 'the two independent hook processes took different paths');
});

test('pending cleanup bounds malformed reservations and eventually frees a same-session slot without touching fresh plaintext', (t) => {
  const plugin = hookPlugin(t);
  const env = { PLUGIN_DATA: plugin.data };
  const repoKey = 'a'.repeat(64);
  const old = Date.now() - 2 * 10 * 60 * 1000;
  const reservation = stashPending(SESSION, 'worker', repoKey, { name: 'corrupt', prompt: 'corrupt payload' }, env);
  assert.ok(reservation);
  const dir = pendingDir(plugin.data);
  const slot = join(dir, 'reservation.json');
  const payload = join(dir, `${repoKey}.json`);
  writeFileSync(slot, '{not-json');
  ageFile(slot, old);
  rewritePendingAt(payload, old);
  assert.equal(cleanupPending(env, Date.now()) >= 2, true);

  const otherKey = 'b'.repeat(64);
  assert.ok(stashPending('other-session', 'worker', otherKey, { name: 'live', prompt: 'keep this live' }, env));
  assert.equal(existsSync(slot), false, 'old malformed reservation is boundedly removed');
  assert.equal(existsSync(payload), false, 'associated old payload is removed with the corrupt slot');
  assert.equal(existsSync(join(pendingDir(plugin.data, 'other-session'), 'reservation.json')), true, 'another session stays live');

  const reused = stashPending(SESSION, 'worker', repoKey, { name: 'reused', prompt: 'slot is reusable' }, env);
  assert.ok(reused, 'same session/archetype can reuse a corrupt slot after lazy cleanup');
});

test('pending cleanup expires abandoned claims but preserves fresh claims', (t) => {
  const plugin = hookPlugin(t);
  const env = { PLUGIN_DATA: plugin.data };
  const staleKey = 'c'.repeat(64);
  assert.ok(stashPending(SESSION, 'worker', staleKey, { name: 'stale', prompt: 'stale claim' }, env));
  const staleDir = pendingDir(plugin.data);
  const staleSlot = join(staleDir, 'reservation.json');
  const stalePayload = join(staleDir, `${staleKey}.json`);
  const old = Date.now() - 2 * 10 * 60 * 1000;
  rewritePendingAt(staleSlot, old);
  rewritePendingAt(stalePayload, old);
  renameSync(staleSlot, `${staleSlot}.claimed-crashed`);
  renameSync(stalePayload, `${stalePayload}.claimed-crashed`);
  assert.equal(cleanupPending(env, Date.now()) >= 2, true);
  assert.equal(existsSync(`${staleSlot}.claimed-crashed`), false);
  assert.equal(existsSync(`${stalePayload}.claimed-crashed`), false);

  const freshKey = 'd'.repeat(64);
  assert.ok(stashPending('fresh-session', 'worker', freshKey, { name: 'fresh', prompt: 'fresh claim' }, env));
  const freshDir = pendingDir(plugin.data, 'fresh-session');
  const freshSlot = join(freshDir, 'reservation.json');
  const freshPayload = join(freshDir, `${freshKey}.json`);
  renameSync(freshSlot, `${freshSlot}.claimed-fresh`);
  renameSync(freshPayload, `${freshPayload}.claimed-fresh`);
  cleanupPending(env, Date.now());
  assert.equal(existsSync(`${freshSlot}.claimed-fresh`), true, 'fresh claimed reservation is not removed');
  assert.equal(existsSync(`${freshPayload}.claimed-fresh`), true, 'fresh claimed plaintext is not removed');
});

test('SessionEnd clears session-owned claimed artifacts while corrupt unknown ownership remains bounded', (t) => {
  const plugin = hookPlugin(t);
  const env = { PLUGIN_DATA: plugin.data };
  const repoKey = 'e'.repeat(64);
  assert.ok(stashPending(SESSION, 'worker', repoKey, { name: 'ending', prompt: 'ending task' }, env));
  const dir = pendingDir(plugin.data);
  const slot = join(dir, 'reservation.json');
  const payload = join(dir, `${repoKey}.json`);
  renameSync(slot, `${slot}.claimed-session-end`);
  renameSync(payload, `${payload}.claimed-session-end`);
  clearPending(SESSION, env);
  assert.equal(existsSync(dir), false, 'SessionEnd removes claimed reservation and payload');

  const corruptKey = 'f'.repeat(64);
  assert.ok(stashPending(SESSION, 'reviewer', corruptKey, { name: 'unknown', prompt: 'unknown ownership' }, env));
  const corruptDir = pendingDir(plugin.data, SESSION, 'reviewer');
  const corruptSlot = join(corruptDir, 'reservation.json');
  writeFileSync(corruptSlot, '{broken');
  clearPending(SESSION, env);
  assert.equal(existsSync(corruptSlot), true, 'SessionEnd does not guess ownership from corrupt bytes');
  ageFile(corruptSlot, Date.now() - 2 * 10 * 60 * 1000);
  cleanupPending(env, Date.now());
  assert.equal(existsSync(corruptSlot), false, 'lazy cleanup eventually removes unknown corrupt ownership');
});

test('failed pending completion rolls a staged token back for the same retry, while success finalizes it once', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const prompt = 'do not lose this exact plaintext';
  const staged = JSON.parse(cli(root, ['prompt-stage', '--json'], prompt).stdout) as { task_name: string; token: string };
  const event = spawnEvent(root, staged.task_name, sealedMessage());

  const failed = plugin.run('spawn-codex.mjs', event, { env: { FADENO_TEST_FAIL_PENDING_COMPLETION: '1' } });
  const failedReason = denial(failed);
  assert.match(failedReason ?? '', /could not complete the process-safe handoff/);
  assert.doesNotMatch(failedReason ?? '', new RegExp(prompt));
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${staged.token}.json`)), true, 'completion failure restores the deterministic staged token');
  assert.equal(readdirSync(join(plugin.data, 'pending')).length, 0, 'failed pending handoff leaves no reserved slot');

  const retried = plugin.run('spawn-codex.mjs', event);
  assert.equal(denial(retried), null, retried.stderr);
  assert.equal(existsSync(join(root, STAGED_PROMPTS_DIR, `${staged.token}.json`)), false, 'successful retry finalizes the claim');
  const started = plugin.run('spawn-codex.mjs', { session_id: SESSION, cwd: root, hook_event_name: 'SubagentStart', agent_id: 'retry-agent', agent_type: 'fadeno-worker' });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(readDispatches(root).records[0]?.opened?.task, prompt);

  const replay = plugin.run('spawn-codex.mjs', event);
  assert.match(denial(replay) ?? '', /missing, expired, already consumed/);
  assert.equal(readDispatches(root).records.length, 1, 'a successful staged task cannot be replayed into another dispatch');
});

test('pending plugin scratch is private and is removed when the session ends', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const staged = JSON.parse(cli(root, ['prompt-stage', '--json'], 'private pending task').stdout) as { task_name: string };
  assert.equal(denial(plugin.run('spawn-codex.mjs', spawnEvent(root, staged.task_name))), null);

  const pendingRoot = join(plugin.data, 'pending');
  const pendingDirs = readdirSync(pendingRoot);
  assert.equal(pendingDirs.length, 1);
  const pendingDir = join(pendingRoot, pendingDirs[0]!);
  const pendingFiles = readdirSync(pendingDir);
  assert.ok(pendingFiles.length >= 2);
  for (const file of pendingFiles) assert.equal(statSync(join(pendingDir, file)).mode & 0o777, 0o600, file);

  const ended = plugin.run('host-mode.mjs', { hook_event_name: 'SessionEnd', session_id: SESSION, cwd: root });
  assert.equal(ended.status, 0, ended.stderr);
  assert.deepEqual(readdirSync(pendingRoot), []);
});

test('a sealed Codex spawn without a valid token refuses with deterministic stage-and-retry instructions', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const reason = denial(plugin.run('spawn-codex.mjs', spawnEvent(root, 'not-a-stage-token')));
  assert.match(reason ?? '', /prompt-stage --name <semantic-name> --prompt-file <file> --json/);
  assert.match(reason ?? '', /retry the same `fadeno-worker` spawn/);
  assert.match(reason ?? '', /returned `task_name` value exactly/);
  assert.ok(reason?.endsWith('Report this refusal to the user instead of routing around it.'));
  assert.equal(readDispatches(root).records.length, 0);
});

test('Codex plugin refusal carries a usable bundled launcher when PATH has no fadeno', (t) => {
  const plugin = hookPlugin(t);
  const root = hookRepo(t);
  plugin.hostMode(SESSION, true);
  const reason = denial(plugin.run('spawn-codex.mjs', spawnEvent(root, 'not-a-stage-token'), { env: { PATH: '/definitely-no-fadeno' } }));
  assert.ok((reason ?? '').includes(`${plugin.bin}/fadeno prompt-stage`));
  assert.doesNotMatch(reason ?? '', /`fadeno prompt-stage/);
});

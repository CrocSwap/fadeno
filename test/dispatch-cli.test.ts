import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  DispatchCommandError,
  DISPATCHES_FILE,
  DISPATCHES_FORMAT,
  PENDING_RELAYS_FILE,
  runDispatch,
} from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runLoadoutUse } from '../src/commands/loadout.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { readEvents, type RunEvent } from '../src/lib/run-ledger.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { read, tempRepo } from './helpers.ts';

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

/**
 * Pin the harness a resolution compiles against. Left unset, `activeHarness`
 * falls through to the developer's own `~/.local/state/fadeno/harness`, and a
 * host executor would flip between its command fallback and the native
 * refusal depending on whose machine ran the suite.
 */
const onHarness = (harness: string): UserPathOptions => ({ env: { FADENO_HARNESS: harness } });

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
  assert.deepEqual(echoes.slice(0, 2), [
    result.echo,
    "external sandbox: echo-worker (node -e let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('REPORT:'+d));) runs outside the current harness via command; evidence → .fadeno/dispatches.jsonl",
  ]);
  // The caller is told which dispatch is theirs before it runs, so recovery
  // never has to fall back to guessing with `--output last`.
  const dispatchId = result.dispatchId;
  assert.equal(
    echoes[2],
    `dispatch id: ${dispatchId} — recover its output with \`fadeno dispatches --output ${dispatchId.slice(0, 8)}\``,
  );
  // Untagged, so the kernel also says what this dispatch will cost the caller
  // if the call is killed: the id above is the only handle, and it lives on a
  // stream a timeout discards. Said at spawn, the one moment it is actionable.
  assert.match(echoes[3] ?? '', /no --tag given/);
  assert.equal(echoes.length, 4);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.outputBytes, Buffer.byteLength('REPORT:hello'));
  assert.equal(result.evidencePath, DISPATCHES_FILE);

  // Two rows per dispatch: the request row lands before the spawn (so a
  // killed dispatch still leaves a trace), the completion row after.
  const rows = evidenceRows(root);
  assert.equal(rows.length, 2);
  const [requested, completed] = rows as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(requested.event, 'dispatch_requested');
  assert.equal(completed.event, 'dispatch_completed');
  // Both rows carry the evidence-format stamp. The log is append-only and
  // outlives its shape, so a row that cannot name its own format leaves a
  // future reader guessing whether it is old or merely unfamiliar.
  assert.equal(requested.format, DISPATCHES_FORMAT);
  assert.equal(completed.format, DISPATCHES_FORMAT);
  assert.equal(DISPATCHES_FORMAT, '0.2');
  assert.equal(typeof requested.dispatch_id, 'string');
  assert.equal(requested.dispatch_id, completed.dispatch_id);
  assert.equal(requested.dispatch_id, result.dispatchId);
  // The request row carries full resolution identity but no outcome fields.
  assert.equal(requested.executor, 'echo-worker');
  assert.equal(requested.prompt_sha256, sha256Hex('hello'));
  assert.ok(!('exit_code' in requested));
  assert.ok(!('output_sha256' in requested));
  assert.ok(!('duration_ms' in requested));
  assert.equal(completed.timestamp, now.toISOString());
  assert.equal(completed.archetype, 'worker');
  assert.equal(completed.role, null);
  assert.deepEqual(completed.loadout, { name: 'main', source: 'default' });
  assert.equal(completed.executor, 'echo-worker');
  assert.equal(completed.model, 'opus');
  assert.equal(completed.exit_code, 0);
  assert.equal(typeof completed.duration_ms, 'number');
  assert.ok((completed.duration_ms as number) >= 0);
  assert.equal(completed.prompt_sha256, sha256Hex('hello'));
  assert.equal(completed.output_sha256, sha256Hex('REPORT:hello'));

  // The kernel owns the stdin prompt snapshot: the recorded digest attests
  // exactly the bytes it received, from a file it wrote itself.
  assert.equal(completed.prompt_source, 'stdin');
  assert.equal(result.promptSource, 'stdin');
  assert.equal(completed.prompt_snapshot, result.promptSnapshot);
  assert.match(result.promptSnapshot, /^\.fadeno\/local\/prompts\/worker-[0-9a-f]{8}\.md$/);
  assert.equal(read(root, result.promptSnapshot), 'hello');
  // No attestation flow in play → the field stays absent.
  assert.ok(!('relay_attested' in completed));
  assert.equal(result.relayAttested, null);

  // the log is append-only: a second dispatch adds a second row pair
  runDispatch({ archetype: 'worker', prompt: 'again', repoRoot: root, env: null });
  assert.equal(evidenceRows(root).length, 4);
});

test('dispatch: relay attestation consumes a matching spawn-side stash', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  const now = new Date('2026-08-12T12:00:00Z');
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${[
      // stale (2h old) — ignored and pruned
      JSON.stringify({ timestamp: '2026-08-12T10:00:00Z', prompt_sha256: sha256Hex('old') }),
      // fresh, matches the dispatched prompt
      JSON.stringify({ timestamp: '2026-08-12T11:59:00Z', prompt_sha256: sha256Hex('hello') }),
      // fresh, some other pending dispatch
      JSON.stringify({ timestamp: '2026-08-12T11:59:30Z', prompt_sha256: sha256Hex('other') }),
    ].join('\n')}\n`,
  );

  // The heredoc contract appends one trailing newline — still attests.
  const attested = runDispatch({ archetype: 'worker', prompt: 'hello\n', repoRoot: root, env: null, now });
  assert.equal(attested.relayAttested, true);
  assert.equal(evidenceRows(root).at(-1)!.relay_attested, true);
  // The matching entry is consumed; the concurrent pending one survives.
  const remaining = readFileSync(join(root, PENDING_RELAYS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { prompt_sha256: string });
  assert.deepEqual(remaining.map((row) => row.prompt_sha256), [sha256Hex('other')]);

  // A prompt matching no fresh entry while entries are pending = altered relay.
  const mangled = runDispatch({ archetype: 'worker', prompt: 'ello\n', repoRoot: root, env: null, now });
  assert.equal(mangled.relayAttested, false);
  assert.equal(evidenceRows(root).at(-1)!.relay_attested, false);
});

test('dispatch: --prompt-file rows record the given file as the snapshot', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { worker: 'echo-worker' } },
    default_loadout: 'main',
  });
  writeFileSync(join(root, 'task.md'), 'from-a-file');
  const result = runDispatch({ archetype: 'worker', promptFile: 'task.md', cwd: root, repoRoot: root, env: null });
  assert.equal(result.promptSource, 'file');
  assert.equal(result.promptSnapshot, 'task.md');
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.prompt_source, 'file');
  assert.equal(row.prompt_snapshot, 'task.md');
  // No kernel copy for file prompts — the digest pins the content.
  assert.equal(row.prompt_sha256, sha256Hex('from-a-file'));
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
    () => runDispatch({
      archetype: 'reviewer', prompt: 'p', repoRoot: root, env: null,
      userPathOptions: onHarness('codex'),
    }),
    // The refusal names the in-session agent — an explicitly-invoked
    // proxy under a native loadout should point back at the right tool.
    /resolved to host executor "terra-host".*in-session reviewer agent.*declare fallback_command/,
  );
});

test('dispatch: a host executor uses its explicit command fallback with honest evidence', (t) => {
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { reviewer: 'terra-fallback' } },
    default_loadout: 'main',
  });
  const result = runDispatch({
    archetype: 'reviewer', prompt: 'review this', repoRoot: root, env: null,
    // Codex materializes its role agents once per session, so a slot that
    // differs from that session's baseline is exactly what the fallback is for.
    userPathOptions: onHarness('codex'),
  });
  assert.equal(result.stdout, 'TERRA:review this');
  assert.equal(result.transport, 'host-command-fallback');
  const row = evidenceRows(root).at(-1)!;
  assert.equal(row.transport, 'host-command-fallback');
  assert.deepEqual(row.command, STDIN_ECHO('TERRA:'));
  assert.equal(row.command_sha256, sha256Hex(JSON.stringify(STDIN_ECHO('TERRA:'))));
});

test('dispatch: an on-demand-native harness refuses a host fallback instead of nesting', (t) => {
  // Claude materializes any native slot in-session, so `claude -p` here would
  // be a subprocess of the harness we are already inside — one that loads the
  // same plugin, re-reads the prompt as director work, and re-dispatches.
  const root = seedProfile(t, {
    executors: EXECUTORS,
    loadouts: { main: { reviewer: 'terra-fallback' } },
    default_loadout: 'main',
  });
  assert.throws(
    () => runDispatch({
      archetype: 'reviewer', prompt: 'review this', repoRoot: root, env: null,
      userPathOptions: onHarness('claude'),
    }),
    /host executor "terra-fallback", which the claude harness runs in-session.*re-enter this dispatch one level down/s,
  );
  // Refused before the spawn: the executor never ran, and the row says why.
  const row = evidenceRows(root).at(-1);
  assert.equal(row, undefined);
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

// --- write capability: a mutating archetype needs a mutating delivery ---

/**
 * `ro-*` stands in for a headless CLI in a read-only permission mode: it can
 * read and reason, but a commit ends in refusal. `silent` declares nothing.
 */
const WRITE_EXECUTORS = {
  'ro-claude': { adapter: 'command', command: STDIN_ECHO('RO:'), model: 'opus', write_access: false },
  'rw-codex': { adapter: 'command', command: STDIN_ECHO('RW:'), model: 'gpt-5.6-sol', write_access: true },
  silent: { adapter: 'command', command: STDIN_ECHO('SILENT:'), model: 'm' },
};

test('dispatch: a write-needing archetype is refused on a delivery that cannot write', (t) => {
  const root = seedProfile(t, {
    executors: WRITE_EXECUTORS,
    archetypes: { worker: { requires_write: true } },
    loadouts: { main: { worker: 'ro-claude' } },
    default_loadout: 'main',
  });
  let message = '';
  assert.throws(
    () => runDispatch({ archetype: 'worker', prompt: 'ship the fix', repoRoot: root, env: null }),
    (err: unknown) => {
      if (
        !(err instanceof DispatchCommandError) ||
        !/archetype "worker" declares `requires_write: required`, but executor "ro-claude"/.test(err.message) ||
        !/`write_access: false`/.test(err.message) ||
        // Three ways out: rebind, re-permission the command, or stay in-session.
        !/bind "worker" to a write-capable executor/.test(err.message) ||
        !/permission mode/.test(err.message) ||
        !/in-session worker agent/.test(err.message)
      ) {
        return false;
      }
      message = err.message;
      return true;
    },
  );
  // Refused before the spawn: no run burned. The refusal row IS the request-point evidence.
  const rows = evidenceRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, 'dispatch_refused');
  assert.equal(rows[0]!.format, DISPATCHES_FORMAT);
  assert.equal(rows[0]!.executor, 'ro-claude');
  assert.deepEqual(rows[0]!.refusal, { predicate: 'write_posture', message });
  assert.ok(!rows.some((row) => row.event === 'dispatch_requested'));
});

test('dispatch: a write-capable delivery serves the same archetype and records write_access', (t) => {
  const root = seedProfile(t, {
    executors: WRITE_EXECUTORS,
    archetypes: { worker: { requires_write: true } },
    loadouts: { main: { worker: 'rw-codex' } },
    default_loadout: 'main',
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'ship the fix', repoRoot: root, env: null });
  assert.equal(result.stdout, 'RW:ship the fix');
  assert.equal(result.echo, 'worker → rw-codex (gpt-5.6-sol) [loadout main]');
  const rows = evidenceRows(root);
  assert.deepEqual(rows.map((r) => r.write_access), [true, true]);
});

test('dispatch: an archetype claiming no write need proceeds, with a tagged echo', (t) => {
  const root = seedProfile(t, {
    executors: WRITE_EXECUTORS,
    // `worker` is undeclared entirely; `reviewer` declares it needs no writes.
    archetypes: { reviewer: { requires_write: false } },
    loadouts: { main: { worker: 'ro-claude', reviewer: 'ro-claude' } },
    default_loadout: 'main',
  });

  const undeclared = runDispatch({ archetype: 'worker', prompt: 'read this', repoRoot: root, env: null });
  assert.equal(undeclared.stdout, 'RO:read this');
  assert.equal(undeclared.echo, 'worker → ro-claude (opus) [loadout main] [write_access: none]');

  const readOnly = runDispatch({ archetype: 'reviewer', prompt: 'review this', repoRoot: root, env: null });
  assert.equal(readOnly.stdout, 'RO:review this');
  assert.equal(readOnly.echo, 'reviewer → ro-claude (opus) [loadout main] [write_access: none]');

  // Both rows of both pairs carry the declared capability.
  assert.deepEqual(evidenceRows(root).map((r) => r.write_access), [false, false, false, false]);
});

test('dispatch: a delivery that declares nothing constrains nothing', (t) => {
  const root = seedProfile(t, {
    executors: WRITE_EXECUTORS,
    archetypes: { worker: { requires_write: true } },
    loadouts: { main: { worker: 'silent' } },
    default_loadout: 'main',
  });
  const result = runDispatch({ archetype: 'worker', prompt: 'ship the fix', repoRoot: root, env: null });
  assert.equal(result.stdout, 'SILENT:ship the fix');
  assert.equal(result.echo, 'worker → silent (m) [loadout main]');
  // Undeclared is absent from evidence, not `null` — nothing was attested.
  assert.ok(evidenceRows(root).every((r) => !('write_access' in r)));
});

test('dispatch: --executor keeps the guard when an archetype is still named', (t) => {
  const root = seedProfile(t, {
    executors: WRITE_EXECUTORS,
    archetypes: { worker: { requires_write: true } },
    loadouts: { main: { worker: 'rw-codex' } },
    default_loadout: 'main',
  });
  assert.throws(
    () => runDispatch({ archetype: 'worker', executor: 'ro-claude', prompt: 'p', repoRoot: root, env: null }),
    /archetype "worker" declares `requires_write: required`, but executor "ro-claude"/,
  );
  // No archetype named, no claim to check: the bypass still runs.
  assert.equal(
    runDispatch({ executor: 'ro-claude', prompt: 'p', repoRoot: root, env: null }).stdout,
    'RO:p',
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

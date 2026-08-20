import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDispatches } from '../src/commands/dispatches.ts';
import { tempRepo } from './helpers.ts';

/**
 * Hook-side denials leave evidence.
 *
 * The Claude steering hook denies a spawn when the resolver fails, when the
 * resolver hangs, and when the resolver answers with a `restart_required`
 * lane — and all three used to write nothing at all. A repo where every
 * worker spawn is being denied then read exactly like a repo where nobody
 * spawned anything, which is the one reading that must never be ambiguous.
 * These tests cover the writer (the row lands on every deny path, carries a
 * predicate whose remedies differ, keeps a bounded reason, and never costs
 * the denial itself) and the reader (`fadeno dispatches` renders it as
 * visibly refused, not as a delivery).
 */

const STEERING_HOOK = join(import.meta.dirname, '..', 'templates', 'claude', 'hooks', 'dispatch-steering.mjs');

/** Resolver stdout for a slot the session has no lane to deliver. */
const RESTART_SLOT = JSON.stringify({
  adapter: 'host',
  model: 'terra',
  executor: 'terra@xhigh',
  lane: 'restart_required',
  lane_reason: 'no command fallback',
  effort: 'xhigh',
  effective_effort: 'xhigh',
  effort_pinned: true,
  session_effort: 'medium',
});

function fakeFadeno(root: string, script: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'fadeno');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return bin;
}

/** A `fadeno` stub that prints `stdout` and exits 0. */
function resolvesTo(stdout: string): string {
  return `#!/bin/sh\ncat <<'FADENO_EOF'\n${stdout}\nFADENO_EOF\nexit 0\n`;
}

/** A `fadeno` stub that fails with `stderr` on stderr. */
function failsWith(stderr: string): string {
  return `#!/bin/sh\ncat >&2 <<'FADENO_EOF'\n${stderr}\nFADENO_EOF\nexit 1\n`;
}

/**
 * Run the hook with an EXPLICIT `CLAUDE_EFFORT`, never the developer's own:
 * the refusal row records the session effort it observed, so an ambient value
 * would make these assertions depend on how the suite happened to be started.
 */
function runHook(
  root: string,
  toolInput: Record<string, unknown>,
  script: string,
  sessionEffort: string | null = 'medium',
): { status: number | null; stdout: string; stderr: string } {
  const bin = fakeFadeno(root, script);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    CLAUDE_EFFORT: sessionEffort ?? undefined,
  };
  if (sessionEffort == null) delete env.CLAUDE_EFFORT;
  const result = spawnSync(process.execPath, [STEERING_HOOK], {
    cwd: root,
    env,
    input: JSON.stringify({ cwd: root, tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fadenoRepo(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  return root;
}

function rows(root: string): Record<string, unknown>[] {
  const path = join(root, '.fadeno', 'dispatches.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function denial(stdout: string): { permissionDecision: string; permissionDecisionReason: string } {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  return parsed.hookSpecificOutput;
}

test('a resolver-error denial writes a host_refused row naming the predicate', (t) => {
  const root = fadenoRepo(t);
  const result = runHook(
    root,
    { prompt: 'Implement it.', description: 'x', subagent_type: 'worker' },
    failsWith('.fadeno/local/dials has unknown key(s) unknown'),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(denial(result.stdout).permissionDecision, 'deny');

  const written = rows(root);
  assert.equal(written.length, 1);
  const row = written[0]!;
  assert.equal(row.event, 'host_refused');
  assert.equal(row.format, '1.0');
  assert.equal(row.archetype, 'worker');
  assert.equal(row.agent_type, 'worker');
  assert.deepEqual(row.refusal, {
    predicate: 'resolver_error',
    message: '.fadeno/local/dials has unknown key(s) unknown',
  });
  assert.equal(typeof row.timestamp, 'string');
  assert.equal(row.hook_version, 'dev'); // the template, executed directly
  assert.equal(row.fadeno_version, 'dev');

  // Denied before anything resolved: the identity fields are present and
  // null, which is itself the evidence. Recorded as null rather than omitted
  // so both predicates produce one row shape.
  for (const key of ['executor', 'model', 'effort', 'effort_pinned', 'lane_reason', 'model_override', 'timeout_ms']) {
    assert.ok(key in row, `missing key ${key}`);
    assert.equal(row[key], null, key);
  }
  // The session effort is the hook's own observation, not the resolver's, so
  // it survives the resolver having failed outright.
  assert.equal(row.session_effort, 'medium');
});

test('a killed resolver is resolver_timeout, and the row records the budget that expired', (t) => {
  const root = fadenoRepo(t);
  // `kill -TERM $$` reproduces the exact signature `spawnSync` leaves behind
  // when its own `timeout` expires — no exit status, plus the signal that
  // killed the child — without spending the real 10s budget in the suite. A
  // genuine timeout adds `error.code === 'ETIMEDOUT'` on top of this, so the
  // branch under test is the one a real timeout takes.
  const result = runHook(
    root,
    { prompt: 'go', description: 'x', subagent_type: 'worker' },
    '#!/bin/sh\nkill -TERM $$\n',
  );

  assert.equal(result.status, 0, result.stderr);
  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  // The caller is told what to change: a hung resolver, or a budget too tight
  // for it. A silent "failed" would send them hunting an error never written.
  assert.match(decision.permissionDecisionReason, /did not answer within 10000ms/);

  const row = rows(root)[0]!;
  assert.equal(row.event, 'host_refused');
  const refusal = row.refusal as { predicate: string; message: string };
  assert.equal(refusal.predicate, 'resolver_timeout');
  assert.match(refusal.message, /did not answer within 10000ms/);
  // The budget, structurally: the first question a reader has about a
  // timeout is how long it waited.
  assert.equal(row.timeout_ms, 10_000);
});

test('a resolver that never STARTED is resolver_error, not resolver_timeout', (t) => {
  const root = fadenoRepo(t);
  // No `fadeno` anywhere on PATH: spawnSync fails with ENOENT, which also
  // reports a null exit status. Reading that as a timeout would prescribe
  // "raise the budget" for a repo whose real problem is that fadeno is not
  // installed — the mislabel the predicate split exists to avoid.
  const env: Record<string, string | undefined> = { ...process.env, PATH: join(root, 'empty-bin') };
  delete env.CLAUDE_PLUGIN_ROOT;
  const spawned = spawnSync(process.execPath, [STEERING_HOOK], {
    cwd: root,
    env,
    input: JSON.stringify({
      cwd: root,
      tool_name: 'Agent',
      tool_input: { prompt: 'go', description: 'x', subagent_type: 'worker' },
    }),
    encoding: 'utf8',
  });

  assert.equal(denial(spawned.stdout).permissionDecision, 'deny');
  const row = rows(root)[0]!;
  assert.equal((row.refusal as { predicate: string }).predicate, 'resolver_error');
  assert.equal(row.timeout_ms, null);
});

test('a restart_required denial writes a host_refused row carrying the identity it refused', (t) => {
  const root = fadenoRepo(t);
  const result = runHook(
    root,
    { prompt: 'Implement it.', description: 'x', subagent_type: 'fadeno:worker' },
    resolvesTo(RESTART_SLOT),
  );

  assert.equal(result.status, 0, result.stderr);
  const decision = denial(result.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /cannot deliver the worker dial/);

  const row = rows(root)[0]!;
  assert.equal(row.event, 'host_refused');
  assert.equal(row.archetype, 'worker');
  assert.equal(row.agent_type, 'fadeno:worker'); // as the director asked for it
  const refusal = row.refusal as { predicate: string; message: string };
  assert.equal(refusal.predicate, 'restart_required');
  assert.equal(refusal.message, 'no lane for terra@xhigh at effort xhigh; session effort medium: no command fallback');
  assert.equal(row.executor, 'terra@xhigh');
  assert.equal(row.model, 'terra');
  assert.equal(row.effort, 'xhigh');
  assert.equal(row.effort_pinned, true);
  assert.equal(row.lane_reason, 'no command fallback');
  assert.equal(row.session_effort, 'medium');
  assert.equal(row.timeout_ms, null); // nothing timed out; one row shape either way
});

test('a refusal records the prompt digest but never a prompt snapshot', (t) => {
  const root = fadenoRepo(t);
  // Two denials of the same prompt: the digest correlates them (and a later
  // successful retry) without a file per denial piling up in the loop this
  // row exists to make visible.
  for (let i = 0; i < 2; i += 1) {
    runHook(root, { prompt: 'Implement it.', description: 'x', subagent_type: 'worker' }, resolvesTo(RESTART_SLOT));
  }
  const written = rows(root);
  assert.equal(written.length, 2);
  const digest = written[0]!.prompt_sha256;
  assert.equal(typeof digest, 'string');
  assert.equal(written[1]!.prompt_sha256, digest);
  for (const row of written) assert.ok(!('prompt_snapshot' in row), 'refusals write no snapshot');
  assert.equal(existsSync(join(root, '.fadeno', 'local', 'prompts')), false);
});

test('the recorded reason is bounded and single-line, however the resolver screams', (t) => {
  const root = fadenoRepo(t);
  const noise = `${'stack frame '.repeat(200)}\nsecond line\nthird line`;
  const result = runHook(root, { prompt: 'go', description: 'x', subagent_type: 'reviewer' }, failsWith(noise));

  // The caller still gets the full text — the bound is on the trace.
  assert.ok(denial(result.stdout).permissionDecisionReason.length > 500);

  const message = (rows(root)[0]!.refusal as { message: string }).message;
  assert.ok(message.length <= 400, `reason was ${message.length} chars`);
  assert.ok(!message.includes('\n'));
  assert.match(message, /^stack frame /);
  assert.match(message, /…$/);
});

test('a failing evidence write never changes the steering decision', (t) => {
  const root = fadenoRepo(t);
  // A directory where the log belongs: appendFileSync throws EISDIR. The
  // denial is the hook's whole job and must survive it.
  mkdirSync(join(root, '.fadeno', 'dispatches.jsonl'), { recursive: true });
  const result = runHook(root, { prompt: 'go', description: 'x', subagent_type: 'worker' }, failsWith('boom'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(denial(result.stdout).permissionDecision, 'deny');
});

test('a repo with no .fadeno gets a denial and no evidence tree conjured for it', (t) => {
  const root = tempRepo(t); // deliberately NOT a Fadeno repo
  const result = runHook(root, { prompt: 'go', description: 'x', subagent_type: 'worker' }, failsWith('boom'));

  assert.equal(denial(result.stdout).permissionDecision, 'deny');
  assert.equal(existsSync(join(root, '.fadeno')), false);
});

test('an unsteered spawn is still not steered, and writes no refusal', (t) => {
  const root = fadenoRepo(t);
  // `general-purpose` never reaches the resolver at all, so a resolver that
  // would have failed is never consulted and nothing is denied or recorded.
  const result = runHook(root, { prompt: 'go', description: 'x', subagent_type: 'general-purpose' }, failsWith('boom'));

  assert.equal(result.stdout, '');
  assert.deepEqual(rows(root), []);
});

// --- the reader half ---

function seedRows(root: string, ...written: Record<string, unknown>[]): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  for (const row of written) {
    appendFileSync(join(root, '.fadeno', 'dispatches.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
  }
}

const HOST_DELIVERY = {
  format: '1.0',
  timestamp: '2026-08-20T10:00:00.000Z',
  event: 'host_delivery',
  archetype: 'worker',
  agent_type: 'worker',
  executor: 'luna',
  model: 'opus',
  transport: 'host',
  reasoning_effort: 'medium',
  prompt_sha256: 'a'.repeat(64),
};

const HOST_REFUSED = {
  format: '1.0',
  timestamp: '2026-08-20T10:05:00.000Z',
  event: 'host_refused',
  archetype: 'worker',
  agent_type: 'worker',
  refusal: { predicate: 'restart_required', message: 'no lane for terra@xhigh at effort xhigh; session effort medium' },
  executor: 'terra@xhigh',
  model: 'terra',
  prompt_sha256: 'b'.repeat(64),
};

test('fadeno dispatches renders a hook refusal as refused, not as an unattested delivery', (t) => {
  const root = tempRepo(t);
  seedRows(root, HOST_REFUSED);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.total, 1);
  assert.equal(result.skipped, 0, 'a refusal row is evidence, never an unreadable line');
  const [line] = result.lines;
  assert.match(line!, /\[host\]/);
  assert.match(line!, /\[refused: restart_required\]/);
  assert.match(line!, /no lane for terra@xhigh/);
  assert.doesNotMatch(line!, /never attested/);
  assert.doesNotMatch(line!, /attested: effort/);

  // `--json` reads `entries` straight through, so the predicate and message
  // are legible to a script without parsing the line.
  const entry = result.entries[0]!;
  assert.equal(entry.kind, 'host');
  assert.deepEqual(entry.refusal, HOST_REFUSED.refusal);
  assert.equal(entry.completed, false);
  assert.equal(entry.executor, 'terra@xhigh');
});

test('a refusal is visibly distinct from the delivery of the same archetype', (t) => {
  const root = tempRepo(t);
  seedRows(root, HOST_DELIVERY, HOST_REFUSED);
  const { lines, total, skipped } = runDispatches({ repoRoot: root });

  assert.equal(total, 2);
  assert.equal(skipped, 0);
  assert.match(lines[0]!, /never attested/); // the delivery
  assert.doesNotMatch(lines[0]!, /refused/);
  assert.match(lines[1]!, /\[refused: restart_required\]/);
});

test('an attestation never folds onto a refusal: nothing ran inside a denied spawn', (t) => {
  const root = tempRepo(t);
  // Delivery, then a denial of the same archetype, then the delivered
  // subagent's own attestation arriving late. Nearest-preceding would grab
  // the refusal; the refusal is not a spawn.
  seedRows(root, HOST_DELIVERY, HOST_REFUSED, {
    format: '1.0',
    timestamp: '2026-08-20T10:06:00.000Z',
    event: 'host_attestation',
    archetype: 'worker',
    effort: 'medium',
    effort_evidence: 'measured',
  });
  const { entries } = runDispatches({ repoRoot: root });

  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.attestedAt, '2026-08-20T10:06:00.000Z');
  assert.equal(entries[0]!.attestedEffort, 'medium');
  assert.equal(entries[1]!.attestedAt, null);
  assert.match(entries[1]!.refusal!.predicate, /restart_required/);
});

test('a host_refused row that lost its refusal object still reads as a refusal', (t) => {
  const root = tempRepo(t);
  seedRows(root, { ...HOST_REFUSED, refusal: undefined });
  const { lines, entries, skipped } = runDispatches({ repoRoot: root });

  assert.equal(skipped, 0);
  assert.equal(entries[0]!.refusal!.predicate, 'unknown');
  assert.match(lines[0]!, /\[refused: unknown\]/);
  assert.doesNotMatch(lines[0]!, /never attested/);
  // No empty trailing field where the message would have been.
  assert.equal(lines[0]!, lines[0]!.trimEnd());
});

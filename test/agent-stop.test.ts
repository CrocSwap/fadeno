import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DISPATCHES_FILE, DISPATCHES_FORMAT } from '../src/commands/dispatch.ts';
import { runDispatches } from '../src/commands/dispatches.ts';
import { runShow } from '../src/commands/show.ts';
import { tempRepo } from './helpers.ts';

/**
 * The `SubagentStop` receipt: when a host agent dies — a 429, credit
 * exhaustion, a kill — it must leave a row saying so, with a snapshot of what
 * is sitting uncommitted in the tree it was working in. Before it existed the
 * only record was the agent's transcript, and `fadeno dispatches` went on
 * showing the dispatch as potentially live forever.
 *
 * Both harnesses' hooks are exercised exactly as their harness runs them:
 * stdin JSON in, exit 0 out, evidence on disk. The two scripts are separate
 * files with identical bodies (only `HOST` differs), so every behavioural test
 * below runs against both — a divergence between them is the failure this
 * parameterization exists to catch.
 */
const HOOKS: ReadonlyArray<{ host: string; path: string }> = [
  { host: 'claude', path: join(import.meta.dirname, '..', 'templates', 'claude', 'hooks', 'agent-stop.mjs') },
  { host: 'codex', path: join(import.meta.dirname, '..', 'templates', 'codex', 'hooks', 'agent-stop.mjs') },
];

/**
 * Run one hook. Always with an explicit cwd, and never this repo's: the hook
 * WRITES, and the proxy guard's own test carries the receipt for why a test
 * that lets a hook infer its target appended 22 stray rows into the
 * developer's own ledger.
 */
function runHook(script: string, event: unknown, cwd: string): { stdout: string; stderr: string } {
  const spawned = spawnSync(process.execPath, [script], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    cwd,
  });
  assert.equal(spawned.status, 0, `the stop hook must always exit 0 (stderr: ${spawned.stderr})`);
  return { stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
}

/** A Fadeno repo that is also a real git repo, so `git status --short` answers. */
function gitRepo(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  for (const argv of [
    ['init', '--quiet'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Fadeno Test'],
  ]) {
    const done = spawnSync('git', argv, { cwd: root, encoding: 'utf8' });
    assert.equal(done.status, 0, `git ${argv.join(' ')} failed: ${done.stderr}`);
  }
  return root;
}

/** The rows a hook run left behind, parsed. */
function rows(root: string): Array<Record<string, unknown>> {
  const path = join(root, DISPATCHES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A complete SubagentStop payload — the shape both harnesses' schemas require. */
function stopEvent(cwd: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'SubagentStop',
    session_id: 'parent-session',
    transcript_path: '/tmp/parent.jsonl',
    cwd,
    permission_mode: 'default',
    agent_id: 'agent-0123456789',
    agent_type: 'fadeno:worker',
    agent_transcript_path: '/tmp/agent-0123456789.jsonl',
    last_assistant_message: null,
    stop_hook_active: false,
    ...over,
  };
}

for (const { host, path: HOOK } of HOOKS) {
  test(`${host} stop hook: a dirty tree is recorded path by path, with no verdict on the work`, (t) => {
    const root = gitRepo(t);
    writeFileSync(join(root, 'half-written.ts'), 'export const x = 1;\n', 'utf8');
    runHook(HOOK, stopEvent(root), root);

    const recorded = rows(root);
    assert.equal(recorded.length, 1);
    const row = recorded[0]!;
    assert.equal(row.event, 'host_agent_stopped');
    assert.equal(row.format, DISPATCHES_FORMAT);
    assert.equal(row.host, host);
    assert.equal(row.agent_type, 'fadeno:worker');
    assert.equal(row.agent_id, 'agent-0123456789');
    assert.equal(row.session_id, 'parent-session');
    assert.equal(row.agent_transcript_path, '/tmp/agent-0123456789.jsonl');

    const workspace = row.workspace as Record<string, unknown>;
    assert.equal(workspace.git, 'dirty');
    assert.equal(workspace.entry_count, 1);
    assert.deepEqual(workspace.entries, ['?? half-written.ts']);
    assert.equal(workspace.truncated, false);
    // The repo root is not a host worktree, so there is no tree to name.
    assert.equal(workspace.tree, null);

    // The half the reporters asked for that CANNOT be faked: the agent was
    // never asked whether it was done, so nothing on the row may answer.
    const serialized = JSON.stringify(row);
    assert.ok(!/complete/i.test(serialized), `a stop row must state no completeness verdict: ${serialized}`);
    assert.ok(!/finished|unfinished/i.test(serialized), `a stop row must state no completeness verdict: ${serialized}`);
  });

  test(`${host} stop hook: a clean tree is a claim, and an unanswerable one is not`, (t) => {
    const clean = gitRepo(t);
    runHook(HOOK, stopEvent(clean), clean);
    const cleanWorkspace = rows(clean)[0]!.workspace as Record<string, unknown>;
    assert.equal(cleanWorkspace.git, 'clean');
    assert.deepEqual(cleanWorkspace.entries, []);
    assert.equal(cleanWorkspace.entry_count, 0);
    assert.equal(cleanWorkspace.note, null);

    // A Fadeno directory with no git repository under it. "I could not tell"
    // and "there was nothing" must never be spelled the same way — reading the
    // first as the second is how a tree full of a dead agent's edits reports
    // as clean.
    const noGit = tempRepo(t);
    mkdirSync(join(noGit, '.fadeno'), { recursive: true });
    runHook(HOOK, stopEvent(noGit), noGit);
    const blind = rows(noGit)[0]!.workspace as Record<string, unknown>;
    assert.equal(blind.git, 'unavailable');
    assert.equal(blind.entries, null);
    assert.equal(blind.entry_count, null);
    assert.ok(typeof blind.note === 'string' && (blind.note as string).length > 0, 'an unavailable tree states why');
  });

  test(`${host} stop hook: the agent's last message is reported by presence, never as a verdict`, (t) => {
    const absent = gitRepo(t);
    runHook(HOOK, stopEvent(absent), absent);
    const none = rows(absent)[0]!.last_message as Record<string, unknown>;
    // The case that matters: Claude Code passes NO messages on the interrupted
    // path, so the field is absent exactly when a killed agent is what is being
    // recorded. Absence is a fact about the harness, not about the agent.
    assert.equal(none.present, false);
    assert.equal(none.excerpt, null);
    assert.equal(none.chars, null);

    const present = gitRepo(t);
    runHook(
      HOOK,
      stopEvent(present, { last_assistant_message: 'Edited two files.\nStopping now.' }),
      present,
    );
    const said = rows(present)[0]!.last_message as Record<string, unknown>;
    assert.equal(said.present, true);
    assert.equal(said.excerpt, 'Edited two files. Stopping now.');
    assert.equal(said.chars, 'Edited two files.\nStopping now.'.length);
  });

  test(`${host} stop hook: an isolated host worktree IDENTIFIES its dispatch from the path`, (t) => {
    const root = gitRepo(t);
    const dispatchId = 'd10c8f9a-1111-2222-3333-444455556666';
    const worktree = join(root, '.fadeno', 'local', 'host-worktrees', 'adhoc', dispatchId);
    mkdirSync(worktree, { recursive: true });
    // A real repository of its own, the way `git worktree add` leaves one.
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: worktree }).status, 0);
    writeFileSync(join(worktree, 'partial.ts'), 'export const y = 2;\n', 'utf8');
    // `.fadeno` is gitignored, so an isolated worktree has none of its own —
    // which is why the hook walks up, and why it may only do so through this
    // exact layout.
    assert.equal(existsSync(join(worktree, '.fadeno')), false);

    runHook(HOOK, stopEvent(worktree), worktree);

    // The row lands in the REPO's ledger, not the worktree's.
    const row = rows(root)[0]!;
    const correlation = row.dispatch_correlation as Record<string, unknown>;
    assert.equal(correlation.dispatch_id, dispatchId);
    assert.equal(correlation.scope, 'adhoc');
    assert.equal(correlation.basis, 'host_worktree_path');
    const workspace = row.workspace as Record<string, unknown>;
    // The snapshot is of the AGENT's tree, not of the repo root.
    assert.equal(workspace.git, 'dirty');
    assert.deepEqual(workspace.entries, ['?? partial.ts']);
    assert.equal(workspace.tree, `.fadeno/local/host-worktrees/adhoc/${dispatchId}`);
  });

  test(`${host} stop hook: a stop it cannot place NAMES NO DISPATCH`, (t) => {
    const root = gitRepo(t);
    runHook(HOOK, stopEvent(root), root);
    const correlation = rows(root)[0]!.dispatch_correlation as Record<string, unknown>;
    // A stop event names an agent, never a dispatch. Guessing one would tell a
    // host that live work is dead, which is worse than saying nothing.
    assert.equal(correlation.dispatch_id, null);
    assert.equal(correlation.scope, null);
    assert.equal(correlation.basis, 'unestablished');
  });

  test(`${host} stop hook: malformed and partial payloads never throw and never invent`, (t) => {
    const root = gitRepo(t);
    // Not JSON at all.
    const torn = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8', cwd: root });
    assert.equal(torn.status, 0);
    // JSON, but not an object.
    runHook(HOOK, ['a', 'list'], root);
    runHook(HOOK, null, root);
    // A different hook event: not ours to record.
    runHook(HOOK, stopEvent(root, { hook_event_name: 'SessionEnd' }), root);
    // No cwd: a write that cannot say which repo it belongs to is not made.
    runHook(HOOK, { hook_event_name: 'SubagentStop', agent_id: 'a' }, root);
    assert.deepEqual(rows(root), [], 'none of those may write a row');

    // Every optional field absent, all the way down. Both harnesses' schemas
    // make these nullable, and a partial payload must degrade to nulls rather
    // than to a throw or to an invented value.
    runHook(HOOK, { hook_event_name: 'SubagentStop', cwd: root }, root);
    const row = rows(root)[0]!;
    assert.equal(row.agent_id, null);
    assert.equal(row.agent_type, null);
    assert.equal(row.session_id, null);
    assert.equal(row.agent_transcript_path, null);
    assert.equal(row.model, null);
    assert.equal(row.stop_hook_active, null);
    assert.equal((row.last_message as Record<string, unknown>).present, false);
    // Claude spells an unresolved type as the empty string; that is not a name.
    runHook(HOOK, stopEvent(root, { agent_type: '' }), root);
    assert.equal(rows(root)[1]!.agent_type, null);
  });

  test(`${host} stop hook: never creates a Fadeno tree, and never claims a repo it may not`, (t) => {
    // A repo that opted out. A hook must never be the thing that creates
    // `.fadeno/` in it.
    const optedOut = tempRepo(t);
    runHook(HOOK, stopEvent(optedOut), optedOut);
    assert.equal(existsSync(join(optedOut, '.fadeno')), false);

    // A Fadeno repo with an unrelated directory under it. The upward walk is
    // gated on the host-worktree layout precisely so a nested checkout cannot
    // be claimed by whatever Fadeno repo happens to sit above it.
    const root = gitRepo(t);
    const unrelated = join(root, 'vendor', 'other-project');
    mkdirSync(unrelated, { recursive: true });
    runHook(HOOK, stopEvent(unrelated), unrelated);
    assert.deepEqual(rows(root), [], 'an ancestor .fadeno is not a licence to claim any descendant');
  });
}

test('the two harnesses ship the same hook body, so a fix cannot land on one side only', () => {
  const bodies = HOOKS.map(({ path }) => {
    const text = readFileSync(path, 'utf8');
    return text.slice(text.indexOf("import { spawnSync }"));
  });
  const [claude, codex] = bodies as [string, string];
  assert.equal(
    claude.replace("const HOST = 'claude';", '<HOST>'),
    codex.replace("const HOST = 'codex';", '<HOST>'),
    'templates/{claude,codex}/hooks/agent-stop.mjs diverged below the header — change one, change both',
  );
});

// --- the reader half ---------------------------------------------------------

function stopRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: DISPATCHES_FORMAT,
    timestamp: '2026-09-06T09:15:00.000Z',
    event: 'host_agent_stopped',
    fadeno_version: '0.6.2',
    hook_version: '0.6.2',
    host: 'claude',
    agent_type: 'fadeno:worker',
    agent_id: 'agent-0123456789',
    session_id: 'parent-session',
    agent_transcript_path: '/tmp/agent-0123456789.jsonl',
    model: null,
    stop_hook_active: false,
    last_message: { present: false, chars: null, excerpt: null },
    workspace: { tree: null, git: 'dirty', entries: ['M src/a.ts', '?? src/b.ts'], entry_count: 2, truncated: false, note: null },
    dispatch_correlation: { dispatch_id: null, scope: null, basis: 'unestablished' },
    ...over,
  };
}

function adhocOpen(dispatchId: string): Record<string, unknown> {
  return {
    format: DISPATCHES_FORMAT,
    timestamp: '2026-09-06T09:00:00.000Z',
    event: 'adhoc_host_dispatch_requested',
    dispatch_id: dispatchId,
    archetype: 'worker',
    adapter: 'host',
    transport: 'host',
    workspace_mode: 'isolated',
    workspace: `.fadeno/local/host-worktrees/adhoc/${dispatchId}`,
    base_commit: 'a'.repeat(40),
  };
}

function seed(t: TestContext, log: Array<Record<string, unknown>>): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), `${log.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return root;
}

/**
 * The trap the ledger's own inventory warns about: a row kind
 * `foldEvidenceRow` does not handle is counted as unreadable DAMAGE, so a repo
 * with an intact log reports corruption and its reader is sent to repair
 * nothing.
 */
test('dispatches: a host_agent_stopped row is READ, never counted as unreadable damage', (t) => {
  const root = seed(t, [stopRow()]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.skipped, 0, 'the stop row must not read as damage');
  assert.equal(result.skippedNewerFormat, 0);
  assert.equal(result.total, 1);
  assert.equal(result.entries[0]!.kind, 'stopped');
});

test('dispatches: a stop renders the tree it left, and refuses to name a dispatch it cannot place', (t) => {
  const open = '1a2b3c4d-0000-0000-0000-000000000000';
  const root = seed(t, [adhocOpen(open), stopRow()]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries.length, 2);

  const stopped = result.entries[1]!;
  assert.equal(stopped.kind, 'stopped');
  assert.equal(stopped.agentType, 'fadeno:worker');
  assert.equal(stopped.stop?.git, 'dirty');
  assert.equal(stopped.stop?.entryCount, 2);
  assert.equal(stopped.stop?.correlation.dispatchId, null);
  // Computed by the reader, which can see the whole log: what was OPEN here.
  assert.deepEqual(stopped.stop?.openDispatchIds, [open]);

  const line = result.lines[1]!;
  assert.ok(line.includes('[stopped]'), line);
  assert.ok(line.includes('STOPPED — no terminal receipt was recorded'), line);
  assert.ok(line.includes('2 uncommitted paths — M src/a.ts, ?? src/b.ts'), line);
  assert.ok(line.includes('[dispatch: NOT ESTABLISHED'), line);
  assert.ok(line.includes(`[open at this point: ${open.slice(0, 8)}`), line);
  assert.ok(line.includes('[no final message recorded'), line);

  // The dispatch it could not place is left exactly as it was: still open.
  assert.equal(result.entries[0]!.agentStopped, null);
  assert.ok(result.lines[0]!.includes('OPEN — no terminal receipt yet'), result.lines[0]);
});

test('dispatches: a stop that IDENTIFIED its dispatch stops that dispatch reading as live', (t) => {
  const id = 'd10c8f9a-1111-2222-3333-444455556666';
  const root = seed(t, [
    adhocOpen(id),
    stopRow({
      workspace: {
        tree: `.fadeno/local/host-worktrees/adhoc/${id}`,
        git: 'dirty',
        entries: ['M src/a.ts'],
        entry_count: 5,
        truncated: false,
        note: null,
      },
      dispatch_correlation: { dispatch_id: id, scope: 'adhoc', basis: 'host_worktree_path' },
    }),
  ]);
  const result = runDispatches({ repoRoot: root });

  const dispatch = result.entries[0]!;
  assert.equal(dispatch.kind, 'adhoc-host');
  assert.equal(dispatch.agentStopped?.basis, 'host_worktree_path');
  assert.equal(dispatch.agentStopped?.agentType, 'fadeno:worker');
  assert.equal(dispatch.agentStopped?.dirtyPaths, 5);

  const line = result.lines[0]!;
  // The sentence that made dead workers look potentially live, gone.
  assert.ok(!line.includes('OPEN — no terminal receipt yet'), line);
  assert.ok(line.includes('AGENT STOPPED — no terminal receipt'), line);
  assert.ok(line.includes('5 uncommitted paths'), line);
  // Still no verdict on the work itself.
  assert.ok(!/unfinished|incomplete/i.test(line), line);

  // The stop keeps its own entry too: five agents killed by one 429 is the
  // thing worth seeing, and folding it away would hide four of them.
  assert.equal(result.entries[1]!.kind, 'stopped');
});

test('dispatches: a stop after the receipt does not reopen a settled dispatch', (t) => {
  const id = 'd10c8f9a-1111-2222-3333-444455556666';
  const root = seed(t, [
    adhocOpen(id),
    {
      format: DISPATCHES_FORMAT,
      timestamp: '2026-09-06T09:10:00.000Z',
      event: 'adhoc_host_dispatch_closed',
      dispatch_id: id,
      outcome: 'ok',
    },
    stopRow({ dispatch_correlation: { dispatch_id: id, scope: 'adhoc', basis: 'host_worktree_path' } }),
  ]);
  const result = runDispatches({ repoRoot: root });
  const dispatch = result.entries[0]!;
  assert.equal(dispatch.completed, true);
  // An agent that stops after its work was received is an ordinary finish, and
  // marking it would turn every completion into an alarm.
  assert.equal(dispatch.agentStopped, null);
  assert.ok(result.lines[0]!.includes('closed by the host'), result.lines[0]);
});

test('dispatches: a stop marks a killed COMMAND dispatch too, and drops the "in flight" half', (t) => {
  const id = 'c0ffee00-1111-2222-3333-444455556666';
  const root = seed(t, [
    {
      format: DISPATCHES_FORMAT,
      timestamp: '2026-09-06T09:00:00.000Z',
      event: 'dispatch_requested',
      dispatch_id: id,
      archetype: 'worker',
      executor: 'echo-worker',
      transport: 'command',
    },
    stopRow({
      workspace: { tree: null, git: 'unavailable', entries: null, entry_count: null, truncated: false, note: 'not a git repository' },
      dispatch_correlation: { dispatch_id: id, scope: 'adhoc', basis: 'host_worktree_path' },
    }),
  ]);
  const result = runDispatches({ repoRoot: root });
  const line = result.lines[0]!;
  assert.ok(!line.includes('no completion recorded (killed or in flight)'), line);
  assert.ok(line.includes('AGENT STOPPED — no completion row was ever written'), line);
  // A probe that could not run said nothing about the tree, and saying so is
  // the whole difference between an admission and an all-clear.
  assert.ok(line.includes('git could not answer — unknown, not clean'), line);
  assert.equal(result.entries[0]!.agentStopped?.dirtyPaths, null);
});

test('dispatches: a malformed stop row still renders as a stop, never as a clean tree', (t) => {
  // The event name is the claim. A row whose `workspace` object is missing must
  // not quietly read as a tree with nothing in it.
  const root = seed(t, [{ format: DISPATCHES_FORMAT, timestamp: '2026-09-06T09:15:00.000Z', event: 'host_agent_stopped' }]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.skipped, 0);
  const entry = result.entries[0]!;
  assert.equal(entry.kind, 'stopped');
  assert.equal(entry.stop?.git, null);
  const line = result.lines[0]!;
  assert.ok(line.includes('STOPPED — no terminal receipt was recorded'), line);
  assert.ok(line.includes('git could not answer — unknown, not clean'), line);
  assert.ok(!line.includes('no uncommitted changes'), line);
});

// --- the run projection ------------------------------------------------------

/**
 * `fadeno show` reads the RUN ledger, which nothing writes to when a subagent
 * is killed — so before `loadAgentStops` a dead agent's host dispatch read
 * `running` for as long as anyone cared to look. Two surfaces disagreeing about
 * whether work is live is the failure this row exists to end, so the stop rows
 * are read through the listing's own parser rather than a second private one.
 */
function seedRunWithHostDispatch(t: TestContext, dispatchId: string): { root: string; runId: string } {
  const root = tempRepo(t);
  const runId = '2026-09-06-0900-stopped-agent';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    join(dir, 'run.yaml'),
    [
      `run_id: ${runId}`,
      'schema_version: "0.3"',
      'playbook: code-change-review',
      'status: running',
      'task: stopped agent fixture',
      'started_at: 2026-09-06T09:00:00.000Z',
      'host: cli',
      'artifacts_dir: artifacts',
      'current_step: null',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'events.jsonl'),
    `${JSON.stringify({
      type: 'host_dispatch_requested',
      step: 'implement',
      timestamp: '2026-09-06T09:00:00.000Z',
      dispatch_id: dispatchId,
      actor: 'worker',
      executor: 'claude-host',
    })}\n`,
    'utf8',
  );
  return { root, runId };
}

test('show: a host dispatch whose agent stopped no longer reads as merely running', (t) => {
  const id = 'd10c8f9a-1111-2222-3333-444455556666';
  const { root, runId } = seedRunWithHostDispatch(t, id);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, DISPATCHES_FILE),
    `${JSON.stringify(
      stopRow({
        workspace: {
          tree: `.fadeno/local/host-worktrees/${runId}/${id}`,
          git: 'dirty',
          entries: ['M src/a.ts'],
          entry_count: 3,
          truncated: false,
          note: null,
        },
        dispatch_correlation: { dispatch_id: id, scope: runId, basis: 'host_worktree_path' },
      }),
    )}\n`,
    'utf8',
  );

  const shown = runShow({ repoRoot: root, run: runId });
  const request = shown.projection!.requests.find((candidate) => candidate.dispatchId === id)!;
  // `state` stays the run ledger's own vocabulary: an outside observation about
  // an agent must not masquerade as a lifecycle event the ledger never wrote.
  assert.equal(request.state, 'requested');
  assert.equal(request.agentStopped?.basis, 'host_worktree_path');
  assert.equal(request.agentStopped?.agentType, 'fadeno:worker');
  assert.equal(request.agentStopped?.dirtyPaths, 3);
  assert.equal(request.agentStopped?.scope, runId);
});

test('show: a dispatch no stop row named is left alone', (t) => {
  const { root, runId } = seedRunWithHostDispatch(t, 'd10c8f9a-1111-2222-3333-444455556666');
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, DISPATCHES_FILE), `${JSON.stringify(stopRow())}\n`, 'utf8');
  const shown = runShow({ repoRoot: root, run: runId });
  // An uncorrelated stop is real evidence and renders in `fadeno dispatches`;
  // it simply has nothing to say about any particular run dispatch, and
  // pinning it on the only open one would be the guess this refuses to make.
  assert.equal(shown.projection!.requests[0]!.agentStopped, null);
});

test('show: an absent dispatch ledger is a silence, not a crash', (t) => {
  const { root, runId } = seedRunWithHostDispatch(t, 'd10c8f9a-1111-2222-3333-444455556666');
  const shown = runShow({ repoRoot: root, run: runId });
  assert.equal(shown.projection!.requests[0]!.agentStopped, null);
});

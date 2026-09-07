import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DISPATCHES_FILE, DISPATCHES_FORMAT } from '../src/commands/dispatch.ts';
import { runDispatches } from '../src/commands/dispatches.ts';
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

// --- the tail contest --------------------------------------------------------

/**
 * The stop hook has no matcher and fires for EVERY subagent, so without a
 * ranking each ordinary `Explore` / `Plan` / `general-purpose` stop takes one
 * of the ten slots the listing has. Noise that drowns a warning is how the
 * polymarket artifact loss stayed invisible for two dispatches.
 *
 * What is ranked is what each row says is AT RISK — never whether Fadeno
 * steered the spawn. Every reported incident had no Fadeno record at all, and
 * that absence is exactly why nothing recorded them.
 */

/** A killed in-session agent: nothing named it, it never signed off, edits are in the tree. */
function killedInSession(at: string, paths: string[]): Record<string, unknown> {
  return stopRow({
    timestamp: at,
    agent_type: 'general-purpose',
    last_message: { present: false, chars: null, excerpt: null },
    workspace: { tree: null, git: 'dirty', entries: paths, entry_count: paths.length, truncated: false, note: null },
  });
}

/** An ordinary subagent that reached its own turn end, in the user's dirty tree. */
function signedOff(at: string, agentType = 'Explore'): Record<string, unknown> {
  return stopRow({
    timestamp: at,
    agent_type: agentType,
    last_message: { present: true, chars: 20, excerpt: 'Read four files.' },
  });
}

function commandRequest(id: string, at: string): Record<string, unknown> {
  return {
    format: DISPATCHES_FORMAT,
    timestamp: at,
    event: 'dispatch_requested',
    dispatch_id: id,
    archetype: 'worker',
    executor: 'echo-worker',
    transport: 'command',
  };
}

/**
 * THE REPORTED CASE, as a regression test.
 *
 * polymarket, 2026-09-05: a session 429 killed five host agents at once. They
 * had been spawned directly in-session — before `dispatch-open` existed — so
 * there was no dispatch id, no worktree and no Fadeno record of any kind. One
 * died mid-edit leaving five partial files, and roughly seven hours passed
 * before a human found out by hand.
 *
 * The stop rows now exist. This is the other half: that a busy session
 * afterwards cannot push them off the end of the listing.
 */
test('dispatches: five agents killed in-session survive a tail that the work after them would fill', (t) => {
  const killed = [1, 2, 3, 4, 5].map((n) =>
    killedInSession(`2026-09-05T14:0${n}:00.000Z`, ['M src/a.ts', 'M src/b.ts', '?? src/c.ts']),
  );
  // Twelve ordinary entries land after the incident — a plain chronological
  // tail of ten would show these and nothing else.
  const after = Array.from({ length: 12 }, (_, i) => commandRequest(`aa${i}`.padEnd(8, '0'), `2026-09-05T15:${String(i).padStart(2, '0')}:00.000Z`));
  const root = seed(t, [...killed, ...after]);

  const result = runDispatches({ repoRoot: root });
  const stops = result.entries.filter((entry) => entry.kind === 'stopped');
  assert.equal(stops.length, 5, `all five killed agents must survive the tail:\n${result.lines.join('\n')}`);
  for (const stop of stops) {
    assert.equal(stop.stop?.risk, 'unowned_dirty');
    assert.equal(stop.stop?.correlation.dispatchId, null, 'the incident had no dispatch id — that is the point');
  }
  // Nothing was collapsed: not one of these left the system anything to know.
  assert.deepEqual(result.stopsCollapsed, []);
  assert.ok(result.lines.some((line) => line.includes('3 uncommitted paths — M src/a.ts')), result.lines.join('\n'));
});

test('dispatches: an unsettled dispatch outranks recency; a clean uncorrelated stop never competes', (t) => {
  const dead = 'deadbeef-1111-2222-3333-444455556666';
  const root = seed(t, [
    adhocOpen(dead),
    // The stop that matters, and the OLDEST contender in the log.
    stopRow({
      timestamp: '2026-09-06T09:05:00.000Z',
      last_message: { present: false, chars: null, excerpt: null },
      dispatch_correlation: { dispatch_id: dead, scope: 'adhoc', basis: 'host_worktree_path' },
    }),
    // A clean uncorrelated stop, newer. Collapsed: nothing it could point at.
    stopRow({
      timestamp: '2026-09-06T09:06:00.000Z',
      last_message: { present: false, chars: null, excerpt: null },
      workspace: { tree: null, git: 'clean', entries: [], entry_count: 0, truncated: false, note: null },
    }),
    // An unmeasured stop, newest of all. Ranks like any ordinary entry.
    stopRow({
      timestamp: '2026-09-06T09:07:00.000Z',
      last_message: { present: false, chars: null, excerpt: null },
      workspace: { tree: null, git: 'unavailable', entries: null, entry_count: null, truncated: false, note: 'not a git repository' },
    }),
  ]);

  const tight = runDispatches({ repoRoot: root, tail: 1 });
  assert.equal(tight.entries.length, 1);
  assert.equal(tight.entries[0]!.stop?.risk, 'unsettled_dispatch');
  assert.equal(tight.entries[0]!.timestamp, '2026-09-06T09:05:00.000Z', 'rank must beat recency for the one slot');

  // The clean one does not survive any tail, because it never entered the
  // contest — it is collapsed, counted, and reachable through `--stops`.
  const roomy = runDispatches({ repoRoot: root, tail: 10 });
  assert.deepEqual(
    roomy.entries.map((entry) => entry.stop?.risk ?? entry.kind),
    ['adhoc-host', 'unsettled_dispatch', 'unmeasured'],
  );
  assert.deepEqual(roomy.stopsCollapsed, [
    { risk: 'tree_clean', reading: 'reported no uncommitted change in its tree at the stop', count: 1 },
  ]);
});

/**
 * The premise this ranking had to correct. "Uncorrelated but dirty" on its own
 * fires for EVERY ordinary in-session subagent: an unsteered `Explore` runs in
 * the repo root, and a session that is dispatching work is a session whose
 * root has uncommitted changes in it. This repo's own ledger carries 42
 * `native_spawn` rows in exactly that position — so the tree alone would have
 * promoted all 42 into the tier meant for the five dead agents.
 *
 * The discriminator is the final message, which Claude Code measurably
 * supplies on the ordinary turn-end path and not on the interrupted one.
 */
test('dispatches: in one dirty tree, the agent that was cut off takes the slot and the one that signed off does not', (t) => {
  const root = seed(t, [
    signedOff('2026-09-06T10:00:00.000Z'),
    signedOff('2026-09-06T10:01:00.000Z', 'Plan'),
    signedOff('2026-09-06T10:02:00.000Z', 'general-purpose'),
    killedInSession('2026-09-06T10:03:00.000Z', ['M src/live-experiment.ts']),
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.equal(result.entries.length, 1, 'three ordinary stops must not crowd the one that was cut off');
  assert.equal(result.entries[0]!.timestamp, '2026-09-06T10:03:00.000Z');
  assert.equal(result.entries[0]!.stop?.risk, 'unowned_dirty');
  // Every one of the four saw the same dirty tree. The tree is not what
  // separated them, and a ranking that read only the tree would have shown all
  // four — or, with a tighter tail, the wrong three.
  for (const row of readFileSync(join(root, DISPATCHES_FILE), 'utf8').trim().split('\n')) {
    assert.equal((JSON.parse(row).workspace as Record<string, unknown>).git, 'dirty');
  }
  // And the reading that collapsed the other three is stated, not implied.
  assert.deepEqual(result.stopsCollapsed, [
    { risk: 'agent_signed_off', reading: 'carried a final message, so the agent reached its own turn end', count: 3 },
  ]);
  assert.ok(
    result.summary.includes('3 agent stops collapsed: 3 carried a final message, so the agent reached its own turn end.'),
    result.summary,
  );
});

test('dispatches: `unavailable` is never collapsed as clean, and never worded like it', (t) => {
  const root = seed(t, [
    stopRow({
      last_message: { present: false, chars: null, excerpt: null },
      workspace: { tree: null, git: 'unavailable', entries: null, entry_count: null, truncated: false, note: 'not a git repository' },
    }),
    // A row whose workspace object never arrived at all: the same admission by
    // a different route, and it must not borrow `clean` either.
    { format: DISPATCHES_FORMAT, timestamp: '2026-09-06T09:16:00.000Z', event: 'host_agent_stopped' },
  ]);
  const result = runDispatches({ repoRoot: root });

  assert.deepEqual(result.entries.map((entry) => entry.stop?.risk), ['unmeasured', 'unmeasured']);
  assert.deepEqual(result.stopsCollapsed, [], 'an unmeasured tree is not an all-clear');
  assert.equal(result.stopsTotal, 2);
  for (const line of result.lines) assert.ok(line.includes('git could not answer — unknown, not clean'), line);
  assert.ok(!/no uncommitted change/.test(result.summary), result.summary);
});

test('dispatches: the collapsed count says what it counted, and every collapsed row stays reachable', (t) => {
  const settled = 'd10c8f9a-1111-2222-3333-444455556666';
  const root = seed(t, [
    adhocOpen(settled),
    // The ordinary end of a successful host dispatch: the agent stops, THEN
    // the host closes it. The largest population of stop rows there is.
    stopRow({
      dispatch_correlation: { dispatch_id: settled, scope: 'adhoc', basis: 'host_worktree_path' },
      last_message: { present: false, chars: null, excerpt: null },
    }),
    {
      format: DISPATCHES_FORMAT,
      timestamp: '2026-09-06T09:20:00.000Z',
      event: 'adhoc_host_dispatch_closed',
      dispatch_id: settled,
      outcome: 'ok',
    },
    signedOff('2026-09-06T09:21:00.000Z'),
    stopRow({
      timestamp: '2026-09-06T09:22:00.000Z',
      last_message: { present: false, chars: null, excerpt: null },
      workspace: { tree: null, git: 'clean', entries: [], entry_count: 0, truncated: false, note: null },
    }),
  ]);

  const result = runDispatches({ repoRoot: root });
  // One entry left in the listing: the dispatch itself, closed.
  assert.deepEqual(result.entries.map((entry) => entry.kind), ['adhoc-host']);
  assert.deepEqual(result.stopsCollapsed, [
    { risk: 'settled_dispatch', reading: 'named a dispatch that has a terminal receipt', count: 1 },
    { risk: 'agent_signed_off', reading: 'carried a final message, so the agent reached its own turn end', count: 1 },
    { risk: 'tree_clean', reading: 'reported no uncommitted change in its tree at the stop', count: 1 },
  ]);
  // The count carries its readings, and the caveat that keeps it from reading
  // as a verdict. `clean` is a fact about a tree at a moment, and the agent may
  // have committed its work or been in a tree someone has since cleaned.
  assert.ok(result.summary.includes('3 agent stops collapsed:'), result.summary);
  assert.ok(result.summary.includes('1 named a dispatch that has a terminal receipt'), result.summary);
  assert.ok(result.summary.includes('Collapsed is not a verdict on the work'), result.summary);
  assert.ok(result.summary.includes('not proof the agent did nothing'), result.summary);
  assert.ok(result.summary.includes('`fadeno dispatches --stops`'), result.summary);

  // Reachable, and each says why it was not in the listing.
  const stops = runDispatches({ repoRoot: root, stops: true });
  assert.equal(stops.stopsTotal, 3);
  assert.equal(stops.entries.length, 3);
  assert.deepEqual(stops.stopsCollapsed, [], '--stops collapses nothing');
  assert.ok(stops.summary.includes('3 of 3 agent stops shown — every stop row in the log, none collapsed'), stops.summary);
  assert.ok(stops.lines.every((line) => line.includes('[collapsed in the default listing — it ')), stops.lines.join('\n'));
  assert.ok(stops.lines[0]!.includes('it named a dispatch that has a terminal receipt'), stops.lines[0]);

  // And the settled dispatch was never reopened by the stop that named it.
  assert.equal(result.entries[0]!.completed, true);
  assert.equal(result.entries[0]!.agentStopped, null);
  assert.ok(result.lines[0]!.includes('closed by the host'), result.lines[0]);
});

/**
 * Settlement is read at the END of the fold, not where the stop landed. A
 * host dispatch's ordinary life is: the agent stops, and only then does the
 * host write the receipt — so a stop judged at its own position would call
 * every successful delivery a warning.
 */
test('dispatches: a receipt written AFTER the stop still collapses it; a missing dispatch never does', (t) => {
  const settled = 'aaaa1111-0000-0000-0000-000000000000';
  const orphan = 'bbbb2222-0000-0000-0000-000000000000';
  const root = seed(t, [
    adhocOpen(settled),
    stopRow({ dispatch_correlation: { dispatch_id: settled, scope: 'adhoc', basis: 'host_worktree_path' } }),
    { format: DISPATCHES_FORMAT, timestamp: '2026-09-06T09:30:00.000Z', event: 'adhoc_host_dispatch_closed', dispatch_id: settled, outcome: 'ok' },
    // A dispatch this log does not contain — a truncated head. A silence is
    // not a receipt, so this one stays in the listing.
    stopRow({ timestamp: '2026-09-06T09:31:00.000Z', dispatch_correlation: { dispatch_id: orphan, scope: 'adhoc', basis: 'host_worktree_path' } }),
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.deepEqual(result.entries.map((entry) => entry.stop?.risk ?? entry.kind), ['adhoc-host', 'unsettled_dispatch']);
  assert.deepEqual(result.stopsCollapsed, [
    { risk: 'settled_dispatch', reading: 'named a dispatch that has a terminal receipt', count: 1 },
  ]);
});

/**
 * The same ordering, on the command lane, where it was printing a sentence
 * that contradicted the rest of its own line: the stop marked the dispatch
 * while it was open, the kernel's completion row arrived afterwards, and the
 * line then read `exit 0 in 12ms  [agent stopped: … — no terminal receipt was
 * recorded]`. A receipt retires the mark, whichever order the rows arrived in.
 */
test('dispatches: a completion row after a stop retires the mark instead of contradicting itself', (t) => {
  const id = 'c0ffee00-1111-2222-3333-444455556666';
  const root = seed(t, [
    commandRequest(id, '2026-09-06T09:00:00.000Z'),
    stopRow({ dispatch_correlation: { dispatch_id: id, scope: 'adhoc', basis: 'host_worktree_path' } }),
    {
      format: DISPATCHES_FORMAT,
      timestamp: '2026-09-06T09:20:00.000Z',
      event: 'dispatch_completed',
      dispatch_id: id,
      exit_code: 0,
      duration_ms: 12,
      output_bytes: 40,
    },
  ]);
  const result = runDispatches({ repoRoot: root });
  assert.equal(result.entries[0]!.completed, true);
  assert.equal(result.entries[0]!.agentStopped, null);
  const line = result.lines[0]!;
  assert.ok(line.includes('exit 0'), line);
  assert.ok(!line.includes('no terminal receipt was recorded'), line);
  assert.ok(!/AGENT STOPPED/.test(line), line);
});

test('dispatches: rank decides what fits, chronology decides the order of what fits', (t) => {
  const dead = 'deadbeef-1111-2222-3333-444455556666';
  const root = seed(t, [
    adhocOpen(dead),
    stopRow({
      timestamp: '2026-09-06T09:05:00.000Z',
      last_message: { present: false, chars: null, excerpt: null },
      dispatch_correlation: { dispatch_id: dead, scope: 'adhoc', basis: 'host_worktree_path' },
    }),
    commandRequest('cccc1111', '2026-09-06T09:06:00.000Z'),
    commandRequest('cccc2222', '2026-09-06T09:07:00.000Z'),
  ]);
  const result = runDispatches({ repoRoot: root, tail: 2 });
  // The promoted stop was pulled in from further back, and it is still where
  // it happened: a stop line makes positional claims ("open at this point"),
  // and hoisting the row would turn an accurate sentence into a false one.
  assert.deepEqual(result.entries.map((entry) => entry.timestamp), [
    '2026-09-06T09:05:00.000Z',
    '2026-09-06T09:07:00.000Z',
  ]);
  assert.deepEqual(
    result.lines.map((line) => line.split('  ')[0]),
    ['2026-09-06T09:05:00.000Z', '2026-09-06T09:07:00.000Z'],
  );
});

test('dispatches: ranking never takes a slot from a row that is not a stop', (t) => {
  // Only stop rows are ranked. Making a dispatch row disappear so a stop could
  // be louder would be a new way to hide evidence.
  const root = seed(t, Array.from({ length: 4 }, (_, i) => commandRequest(`dddd${i}`.padEnd(8, '0'), `2026-09-06T11:0${i}:00.000Z`)));
  const result = runDispatches({ repoRoot: root, tail: 3 });
  assert.deepEqual(result.entries.map((entry) => entry.timestamp), [
    '2026-09-06T11:01:00.000Z',
    '2026-09-06T11:02:00.000Z',
    '2026-09-06T11:03:00.000Z',
  ]);
  assert.equal(result.summary, '3 of 4 dispatches shown');
  assert.deepEqual(result.stopsCollapsed, []);
  assert.equal(result.stopsTotal, 0);
});

test('dispatches: --stops on a log with no stops says so rather than saying nothing', (t) => {
  const root = seed(t, [commandRequest('eeee1111', '2026-09-06T12:00:00.000Z')]);
  const result = runDispatches({ repoRoot: root, stops: true });
  assert.deepEqual(result.entries, []);
  assert.equal(result.summary, 'No agent stops recorded in .fadeno/dispatches.jsonl.');
  assert.equal(result.total, 1, 'the log is not empty; only the stop population is');
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


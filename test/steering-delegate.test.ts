import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import test, { type TestContext } from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runSteeringApply, runSteeringResolve } from '../src/commands/steering.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';
import { writeUserDials, type UserPathOptions } from '../src/lib/user-paths.ts';
import { readCodexAgentFile } from '../src/lib/codex-agent-file.ts';

/**
 * The same hermetic pattern `test/steering-apply-scope.test.ts` uses: a
 * user-scope Codex agent directory the developer's real `~/.codex` can never
 * leak into, whether a call passes this `UserPathOptions` explicitly or falls
 * through to `process.env` (`CODEX_HOME` is a real, unmanaged env var — not
 * one of the `FADENO_*_HOME` keys `tempRepo()` already redirects).
 */
function isolatedUser(t: TestContext, root: string): UserPathOptions {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      // These are Codex steering tests: pin the HOST so the fixture's
      // host-capable harness is the one this session is running inside.
      // Under v4 that pairing is the whole of "is this a host lane?".
      FADENO_HARNESS: 'codex',
    },
  };
}

const FALLBACK_COMMAND = ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('fallback:'+d))"];

function seedDelegateProfile(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: {
      // Both on the HOST harness's provider: v4 has one host at a time, so a
      // fixture wanting two host-deliverable slots puts both models on it.
      luna: { provider: 'lunap', id: 'gpt-5.6-luna', effort: 'xhigh' },
      sol: { provider: 'lunap', id: 'gpt-5.6-sol', effort: 'medium' },
      opus: { provider: 'opusp', id: 'opus' },
    },
    // One table under v4, which is the point of the collapse: this suite may
    // itself run inside a Claude Code session, and the ambient host no longer
    // selects a route family — the same three harnesses answer for every host.
    harnesses: {
      codex: { provider: 'lunap', host: { effort_channel: 'agent-file' }, command: FALLBACK_COMMAND },
      // A host nobody is sitting in: `restart_required` from here.
      omp: { provider: 'solp', host: { effort_channel: 'none' } },
      claude: { provider: 'opusp', command: ['claude', '-p', '--model', 'opus'] },
    },
    archetypes: { worker: {} },
    dials: { worker: 'luna' },
  }));
}

/** A locked engine dispatch bound to `luna` (host, with a declared command fallback). */
function seedLockedRequest(root: string, user: UserPathOptions): { runId: string; runDir: string; dispatchId: string } {
  // `noSteering: true` skips `init`'s own `.codex/agents/*.toml` broker
  // scaffolding (rendered from whatever catalog is on disk at that moment,
  // before `seedDelegateProfile` below writes the fixture's own) — these
  // tests materialize their own agent files deliberately and assert on an
  // empty `.codex/agents/` starting point.
  runInit({ target: 'codex', repoRoot: root, dataOnly: true, noSteering: true });
  seedDelegateProfile(root);
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'locked.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'locked',
    description: 'Locked steering delegate-advisory fixture.',
    roles: { worker: { purpose: 'Implement.', archetype: 'worker' } },
    inputs: { Task: { media_type: 'text/markdown' } },
    flow: [{ id: 'implement', kind: 'actor_call', actor: 'worker', input: ['Task'], output: 'Notes', terminal_status: 'completed' }],
  }));
  writeFileSync(join(root, 'task.md'), 'locked task');
  const created = runNewRun({ repoRoot: root, playbook: 'locked', task: 'test delegate advisory', inputs: ['Task=task.md'], userPathOptions: user });
  const driven = runDrive({ repoRoot: root, run: created.runId, userPathOptions: user });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  assert.equal(request.executor, 'luna');
  return { runId: created.runId, runDir: created.runDir, dispatchId: request.dispatchId };
}

test('locked resolve advises the matching native Codex agent when the caller proved no host identity', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);

  const applied = runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  assert.equal(applied.materialization.worker?.kind, 'host');
  const workerPath = join(root, '.codex', 'agents', 'worker.toml');
  assert.ok(existsSync(workerPath));

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.deepEqual(resolution.delegate_to, {
    archetype: 'worker',
    // The run snapshot's identity — AND what this agent's file carries, which
    // is the reason it can be named at all: on Codex the file wins.
    model: 'gpt-5.6-luna',
    reasoning_effort: 'xhigh',
    executor: 'luna',
    agent_file: workerPath,
    scope: 'project',
  });
  const file = readCodexAgentFile(workerPath)!;
  assert.equal(file.model, resolution.delegate_to!.model);
  assert.equal(file.reasoningEffort, resolution.delegate_to!.reasoning_effort);
  assert.match(resolution.detail, /spawn the worker Codex agent .* its file carries exactly this identity, gpt-5\.6-luna at effort xhigh/);
  assert.doesNotMatch(resolution.detail, /is stale/);
});

test('delegate advisory is absent when no candidate matches (the original command-fallback behavior)', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);
  // No agent files materialized at all — nothing for the resolver to find.

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to, undefined);
  assert.match(resolution.detail, /deliver it through that executor's declared command fallback/);
});

test('delegate advisory does not send a locked host request to a command broker', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);
  // Materialize the worker slot from a command route after the run has locked
  // its request to luna. This is the exact shape that caused a broker to call
  // resolve without --host-executor and receive the same delegate advice.
  writeLocalDialState(root, { dials: { worker: { model: 'opus' } }, shadows: {}, legacyNote: null });
  const applied = runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  assert.equal(applied.materialization.worker?.kind, 'command-broker');
  const workerPath = join(root, '.codex', 'agents', 'worker.toml');
  assert.equal(readCodexAgentFile(workerPath)?.hostExecutor, null);

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to, undefined);
  assert.match(resolution.detail, /deliver it through that executor's declared command fallback/);
});

/**
 * Corrected 2026-09-05: on Codex an agent file's `model` and
 * `model_reasoning_effort` take precedence over the values passed at spawn, so
 * a stale file is not a valid spawn target at any spawn values (the rule and
 * its receipt live on `findSpawnableCodexAgent`). Naming one would produce
 * exactly the silent identity substitution a locked request exists to
 * prevent — the agent runs the file's identity while the run's evidence claims
 * the snapshot's — which is why the spawn guard refuses such a spawn rather
 * than trying to rewrite it.
 */
test('a stale agent file is NOT offered as a spawn target; the advisory names it', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);
  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  const workerPath = join(root, '.codex', 'agents', 'worker.toml');
  const original = readFileSync(workerPath, 'utf8');
  assert.match(original, /model_reasoning_effort = "xhigh"/);
  // Simulate a stale/hand-edited file: the --host-executor prose still says
  // "luna", but the effort Codex would actually spawn at has drifted.
  writeFileSync(workerPath, original.replace('model_reasoning_effort = "xhigh"', 'model_reasoning_effort = "low"'));

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to, undefined);
  // Named, not silently omitted: a coordinator can see the agent on disk and
  // has to be told why reaching for it would substitute the wrong identity.
  // "stale" is the word the spawn guard's sibling refusal uses.
  assert.match(resolution.detail, /the managed worker Codex agent .* is stale/);
  assert.match(resolution.detail, /carries gpt-5\.6-luna at effort low, while this request is locked to gpt-5\.6-luna at effort xhigh/);
  assert.match(resolution.detail, /fadeno steering apply --codex/);
  // The resolver is read-only: it never repairs the file it just refused.
  assert.match(readFileSync(workerPath, 'utf8'), /model_reasoning_effort = "low"/);
});

test('a MODEL that went stale is refused the same way an effort is', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);
  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  const workerPath = join(root, '.codex', 'agents', 'worker.toml');
  const original = readFileSync(workerPath, 'utf8');
  // The baked --host-executor still says `luna` and the effort still says
  // `xhigh`; only the model line moved. The file's model is what every API
  // call runs at, so this agent delivers `sol` however it is spawned.
  writeFileSync(workerPath, original.replace('model = "gpt-5.6-luna"', 'model = "gpt-5.6-sol"'));

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to, undefined);
  assert.match(resolution.detail, /carries gpt-5\.6-sol at effort xhigh, while this request is locked to gpt-5\.6-luna at effort xhigh/);
});

test('delegate advisory refuses an unmanaged agent file even when its content matches', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);
  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  const workerPath = join(root, '.codex', 'agents', 'worker.toml');
  const managed = readFileSync(workerPath, 'utf8');
  const firstNewline = managed.indexOf('\n');
  assert.ok(managed.startsWith('# fadeno:managed'));
  // Strip the managed header line only; body (model/effort/--host-executor) is untouched.
  writeFileSync(workerPath, managed.slice(firstNewline + 1));

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to, undefined);
});

test('delegate advisory is suppressed when the caller already supplied a --host-executor', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);
  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });

  // A materialized agent or command broker always supplies its own
  // --host-executor; a mismatch from one of those is a real restart/command
  // case, and it must not be offered a delegate even though a matching file
  // exists on disk.
  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', hostExecutor: 'not-luna', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to, undefined);
});

test('delegate advisory follows Codex\'s own project-over-user scope precedence', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);

  // A user-scope apply is cut only from the USER dial layer (never a repo
  // pin — see `dialLayersForApply`'s doc comment in steering.ts), so the
  // user dial must be set explicitly for this scope to bind worker to luna.
  writeUserDials(user, { worker: { model: 'luna' } });

  // Materialize only at user scope first — no project file yet.
  runSteeringApply({ repoRoot: root, target: 'codex', scope: 'user', userPathOptions: user });
  const userPath = join(user.home!, '.codex', 'agents', 'fadeno-worker.toml');
  assert.ok(existsSync(userPath));

  const viaUser = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.deepEqual(viaUser.delegate_to, {
    archetype: 'worker', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh',
    executor: 'luna', agent_file: userPath, scope: 'user',
  });

  // Now a project-scope file exists too, cut for a DIFFERENT executor (same
  // archetype name). Codex loads ONLY this project file for "worker" — the
  // matching user-scope file underneath it is invisible. It carries `sol`'s
  // identity, which is what a spawn of it would actually run, and its
  // developer instructions would claim `sol` to the resolver besides. Offering
  // it would substitute the identity AND recurse, so the advisory is absent.
  // The executor half of the predicate decides here, so the detail is the
  // plain command-fallback line rather than the stale one.
  writeLocalDialState(root, { dials: { worker: { model: 'sol' } }, shadows: {}, legacyNote: null });
  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  const projectPath = join(root, '.codex', 'agents', 'worker.toml');
  assert.match(readFileSync(projectPath, 'utf8'), /gpt-5\.6-sol/);

  const viaShadowed = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(viaShadowed.mode, 'command');
  assert.equal(viaShadowed.delegate_to, undefined);
  assert.match(viaShadowed.detail, /declared command fallback/);
});

/**
 * Two archetypes dialed to one model is an ordinary configuration, and it is
 * what separates "an agent with this identity exists" from "an agent that can
 * claim THIS envelope exists". Matching on identity alone returned whichever
 * role slot was scanned first, so a `reviewer` dispatch was advised to
 * delegate to the `worker` agent — which then refuses it outright
 * (`requests agent_type "reviewer", not archetype "worker"`). Fail-closed, and
 * still a guaranteed dead end dressed up as an authoritative answer.
 */
test('delegate advisory names the agent for THIS dispatch\'s archetype, not merely a matching identity', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true, noSteering: true });
  seedDelegateProfile(root);
  // Both role slots cut from the same executor, so identity alone cannot
  // distinguish them; only the slot can.
  const profilePath = join(root, '.fadeno', 'executors.yaml');
  const profile = parseYaml(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
  profile.archetypes = { worker: {}, reviewer: {} };
  profile.dials = { worker: 'luna', reviewer: 'luna' };
  writeFileSync(profilePath, stringifyYaml(profile));
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'locked.yaml'), stringifyYaml({
    kind: 'AgentPlaybook', schema_version: '0.1', name: 'locked',
    description: 'Cross-archetype delegate-advisory fixture.',
    roles: { checker: { purpose: 'Review.', archetype: 'reviewer' } },
    inputs: { Task: { media_type: 'text/markdown' } },
    flow: [{ id: 'review', kind: 'actor_call', actor: 'checker', input: ['Task'], output: 'Notes', terminal_status: 'completed' }],
  }));
  writeFileSync(join(root, 'task.md'), 'locked task');
  const created = runNewRun({ repoRoot: root, playbook: 'locked', task: 'cross-archetype', inputs: ['Task=task.md'], userPathOptions: user });
  const driven = runDrive({ repoRoot: root, run: created.runId, userPathOptions: user });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  assert.equal(request.executor, 'luna');
  assert.equal(request.agentType, 'reviewer');

  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  // The worker agent is materialized for the very same executor/model/effort,
  // and is scanned first. It must still not be offered.
  const workerAgent = readCodexAgentFile(join(root, '.codex', 'agents', 'worker.toml'));
  assert.equal(workerAgent?.hostExecutor, 'luna');

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'reviewer', run: created.runId,
    dispatchId: request.dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to?.archetype, 'reviewer');
  assert.equal(resolution.delegate_to?.agent_file, join(root, '.codex', 'agents', 'reviewer.toml'));
  assert.doesNotMatch(resolution.detail, /worker Codex agent/);
});

/**
 * The drift this guards is not hypothetical — it shipped. `src/cli.ts` builds
 * the printed object field by field rather than serializing the resolution, so
 * `delegate_to` was computed by the resolver, documented in the runner skill as
 * the thing a coordinator must check, and never once reached stdout. Every unit
 * test passed against a value no caller could see. A Codex agent reads this
 * command's JSON and nothing else, so the printed surface is the contract, and
 * only an end-to-end assertion covers it.
 *
 * The bundled CLI, deliberately: a stale `plugin/bin/fadeno` has previously
 * broken real coordinator dispatches after the source path was already fixed.
 */
test('the CLI actually prints delegate_to — source and bundle alike', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root, user);
  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  const workerPath = join(root, '.codex', 'agents', 'worker.toml');
  assert.ok(existsSync(workerPath));

  // Project scope keeps this hermetic without injecting a home: a project
  // agent file short-circuits the candidate scan, so the spawned process
  // never consults the developer's real `~/.codex`.
  const resolved = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolved.delegate_to?.scope, 'project');

  const bundled = spawnSync(
    process.execPath,
    [join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno'),
      'steering', 'resolve', '--archetype', 'worker', '--run', runId, '--dispatch-id', dispatchId],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(bundled.status, 0, bundled.stderr);
  const printed = JSON.parse(bundled.stdout) as Record<string, unknown>;
  assert.equal(printed.mode, 'command');
  const printedDelegate = printed.delegate_to as Record<string, unknown> | null;
  assert.notEqual(printedDelegate, null, 'delegate_to must reach stdout, not just the return value');
  assert.equal(printedDelegate!.archetype, 'worker');
  assert.equal(printedDelegate!.scope, 'project');
  assert.equal(printedDelegate!.executor, 'luna');
  // The spawned CLI resolves the repo root through realpath, so on macOS its
  // path is /private/var/... where this process sees /var/... — compare the
  // repo-relative tail rather than the absolute string.
  assert.ok(String(printedDelegate!.agent_file).endsWith(join('.codex', 'agents', 'worker.toml')));
  assert.equal(printedDelegate!.model, 'gpt-5.6-luna');
  assert.equal(printedDelegate!.reasoning_effort, 'xhigh');
});

test('an ordinary command-adapter (broker-shaped) resolve is byte-for-byte unchanged', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  runInit({ target: 'codex', repoRoot: root, dataOnly: true });
  seedDelegateProfile(root);
  writeLocalDialState(root, { dials: { worker: { model: 'opus' } }, shadows: {}, legacyNote: null });

  const resolution = runSteeringResolve({ repoRoot: root, archetype: 'worker', userPathOptions: user });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.executor, 'opus');
  assert.equal(resolution.detail, 'dispatch through command executor opus; effective immediately');
  assert.equal(Object.hasOwn(resolution, 'delegate_to'), false);
});

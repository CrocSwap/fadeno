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
      FADENO_HARNESS: 'standalone',
    },
  };
}

const FALLBACK_COMMAND = ['node', '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('fallback:'+d))"];

function seedDelegateProfile(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      luna: { provider: 'lunap', id: 'gpt-5.6-luna', effort: 'xhigh' },
      sol: { provider: 'solp', id: 'gpt-5.6-sol', effort: 'medium' },
      opus: { provider: 'opusp', id: 'opus' },
    },
    routes: {
      // All families declared, not just `codex`: this suite may itself run
      // inside a Claude Code session, and `activeHarness()` detects that
      // ambient host (`CLAUDECODE` etc.) before falling back to `standalone`
      // — see `test/steering-hybrid.test.ts`'s `seedHybridProfileV3` for the
      // same reasoning.
      standalone: {
        lunap: { host: true, command: FALLBACK_COMMAND },
        solp: { host: true },
        opusp: { command: ['claude', '-p', '--model', 'opus'] },
      },
      codex: {
        lunap: { host: true, command: FALLBACK_COMMAND },
        solp: { host: true },
        opusp: { command: ['claude', '-p', '--model', 'opus'] },
      },
      claude: {
        lunap: { host: true, command: FALLBACK_COMMAND },
        solp: { host: true },
        opusp: { command: ['claude', '-p', '--model', 'opus'] },
      },
      grok: {
        lunap: { host: true, command: FALLBACK_COMMAND },
        solp: { host: true },
        opusp: { command: ['claude', '-p', '--model', 'opus'] },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'luna' },
  }));
}

/** A locked engine dispatch bound to `luna` (host, with a declared command fallback). */
function seedLockedRequest(root: string): { runId: string; runDir: string; dispatchId: string } {
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
  const created = runNewRun({ repoRoot: root, playbook: 'locked', task: 'test delegate advisory', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: created.runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const request = driven.requests[0]!;
  assert.equal(request.executor, 'luna');
  return { runId: created.runId, runDir: created.runDir, dispatchId: request.dispatchId };
}

test('locked resolve advises the matching native Codex agent when the caller proved no host identity', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root);

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
    // From the RUN SNAPSHOT, to be passed as explicit spawn values — not read
    // off the agent file, which Codex applies only after them.
    model: 'gpt-5.6-luna',
    reasoning_effort: 'xhigh',
    executor: 'luna',
    agent_file: workerPath,
    scope: 'project',
  });
  assert.match(resolution.detail, /spawn the worker Codex agent .* with explicit model gpt-5\.6-luna and model_reasoning_effort xhigh/);
});

test('delegate advisory is absent when no candidate matches (the original command-fallback behavior)', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root);
  // No agent files materialized at all — nothing for the resolver to find.

  const resolution = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(resolution.mode, 'command');
  assert.equal(resolution.delegate_to, undefined);
  assert.match(resolution.detail, /deliver it through that executor's declared command fallback/);
});

/**
 * This test asserted the OPPOSITE until 2026-08-20, on the premise that a Codex
 * agent could only ever run as the identity its file was cut for — so a file
 * whose model/effort had drifted was treated as unsafe to offer.
 *
 * That premise is wrong. Codex resolves a spawned subagent's settings "from an
 * explicit spawn value, then the corresponding `[agents]` default, then the
 * parent's value" and applies the agent FILE LAST. The file is the
 * lowest-priority default, so a drifted one neither constrains nor delivers
 * anything: the caller passes the snapshot's model and effort explicitly and
 * they win. Refusing here made the advisory silent in exactly the cases a
 * spawn would have worked.
 *
 * What protects the identity is that `delegate_to` carries the SNAPSHOT's
 * values, never the file's — asserted below.
 */
test('a drifted agent file is still a valid spawn target; the snapshot supplies the identity', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root);
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
  // Offered, not refused — and the effort reported is the snapshot's `xhigh`,
  // NOT the file's drifted `low`. A caller passing these explicitly delivers
  // the locked identity regardless of what the file says.
  assert.equal(resolution.delegate_to?.archetype, 'worker');
  assert.equal(resolution.delegate_to?.reasoning_effort, 'xhigh');
  assert.equal(resolution.delegate_to?.model, 'gpt-5.6-luna');
  assert.match(readFileSync(workerPath, 'utf8'), /model_reasoning_effort = "low"/);
});

test('delegate advisory refuses an unmanaged agent file even when its content matches', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const { runId, dispatchId } = seedLockedRequest(root);
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
  const { runId, dispatchId } = seedLockedRequest(root);
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
  const { runId, dispatchId } = seedLockedRequest(root);

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
  // user-scope file underneath it is never consulted — so the advisory must
  // point at the PROJECT file, the one Codex would actually pick.
  //
  // It does not fall silent, and that is the 2026-08-20 correction: the
  // project file says sol, the request says luna, and the spawn resolves an
  // explicit value ahead of the file, so this agent delivers luna when told
  // to. Only the archetype has to line up; the identity rides on the payload.
  writeLocalDialState(root, { dials: { worker: { model: 'sol' } }, shadows: {}, legacyNote: null });
  runSteeringApply({ repoRoot: root, target: 'codex', userPathOptions: user });
  const projectPath = join(root, '.codex', 'agents', 'worker.toml');
  assert.match(readFileSync(projectPath, 'utf8'), /gpt-5\.6-sol/);

  const viaShadowed = runSteeringResolve({
    repoRoot: root, archetype: 'worker', run: runId, dispatchId, userPathOptions: user,
  });
  assert.equal(viaShadowed.mode, 'command');
  assert.equal(viaShadowed.delegate_to?.agent_file, projectPath, 'names the file Codex actually loads');
  assert.equal(viaShadowed.delegate_to?.scope, 'project');
  // The snapshot's identity, never the shadowing file's `sol`.
  assert.equal(viaShadowed.delegate_to?.model, 'gpt-5.6-luna');
  assert.equal(viaShadowed.delegate_to?.reasoning_effort, 'xhigh');
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
  const created = runNewRun({ repoRoot: root, playbook: 'locked', task: 'cross-archetype', inputs: ['Task=task.md'] });
  const driven = runDrive({ repoRoot: root, run: created.runId });
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
  const { runId, dispatchId } = seedLockedRequest(root);
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

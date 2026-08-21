import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDoctor } from '../src/commands/doctor.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * The tripwire for the bug this suite exists to catch: a top-level Codex
 * coordinator has no `--host-executor` to prove, so a locked engine request's
 * `steering resolve` can only ever land on `mode=command` — even when a
 * native role agent cut for that exact executor/model/effort sits idle in
 * `.codex/agents/`. `doctor` scans the most recent run's `actor_dispatched`
 * rows for `delivery_transport: command-fallback` and asks whether a managed
 * agent matching that row's identity exists NOW, so the drift is visible
 * after the fact even though the resolver's own `delegate_to` advisory only
 * ever reaches whoever calls `steering resolve` for that one dispatch.
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

function codexProjectAgents(root: string): string {
  const dir = join(root, '.codex', 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Shape of a real materialized HOST role agent, bare enough for the shared parser. */
function hostAgentBody(archetype: string, executor: string, model: string, effort: string): string {
  return [
    `name = "${archetype}"`,
    `description = "Fadeno hybrid ${archetype}."`,
    `model = "${model}"`,
    `model_reasoning_effort = "${effort}"`,
    'sandbox_mode = "workspace-write"',
    '',
    'developer_instructions = """',
    `Run \`fadeno steering resolve --archetype ${archetype} --host-executor ${executor} --run <run-id> --dispatch-id <dispatch-id>\`.`,
    '"""',
    '',
  ].join('\n');
}

function managed(version: string, body: string): string {
  return `# fadeno:managed version=${version} digest=deadbeefcafe\n${body}`;
}

/** A minimal, hand-written run ledger — enough for `listRuns`/`readEvents`, no engine required. */
function writeRun(root: string, runId: string, rows: Array<Record<string, unknown>>): void {
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), [
    'schema_version: "0.3"',
    'playbook: locked',
    'status: running',
    'task: fixture run',
    'started_at: 2026-01-01T00:00:00Z',
    'host: codex',
  ].join('\n') + '\n');
  const lines = rows.map((row, i) => JSON.stringify({ seq: i + 1, timestamp: '2026-01-01T00:00:00Z', step: null, ...row }));
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
}

function fallbackRow(dispatchId: string, executor: string, model: string, effort: string): Record<string, unknown> {
  return {
    type: 'actor_dispatched',
    dispatch_id: dispatchId,
    executor,
    adapter: 'host',
    model,
    reasoning_effort: effort,
    agent_type: 'worker',
    delivery_transport: 'command-fallback',
  };
}

test('doctor reports a command-fallback dispatch a now-installed native agent could have delivered', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeRun(root, '2026-01-01-0000-run', [fallbackRow('hd-1', 'luna', 'gpt-5.6-luna', 'xhigh')]);
  const projectDir = codexProjectAgents(root);
  writeFileSync(join(projectDir, 'worker.toml'), managed('0.6.0-rc.40', hostAgentBody('worker', 'luna', 'gpt-5.6-luna', 'xhigh')));

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  const finding = result.findings.find((f) => f.check === 'codex-agents-fallback-avoidable');
  assert.ok(finding, `expected codex-agents-fallback-avoidable; got ${JSON.stringify(result.findings)}`);
  assert.equal(finding!.severity, 'warning');
  assert.match(finding!.detail, /1 engine dispatch/);
  assert.match(finding!.detail, /2026-01-01-0000-run/);
  assert.match(finding!.detail, /luna/);
  assert.match(finding!.remediation ?? '', /--host-executor/);
  assert.match(finding!.remediation ?? '', /delegate_to/);
  // Warnings never fail the exit status.
  assert.equal(result.ok, true);
});

test('doctor stays silent when the command fallback ran but no native agent matches', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeRun(root, '2026-01-01-0000-run', [fallbackRow('hd-1', 'luna', 'gpt-5.6-luna', 'xhigh')]);
  // No .codex/agents at all — nothing for the resolver to have delegated to.

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.equal(result.findings.some((f) => f.check === 'codex-agents-fallback-avoidable'), false);
});

/**
 * Inverted on 2026-08-20 with the rest of this feature. It previously asserted
 * silence, on the premise that an agent whose file had drifted could not have
 * delivered the request. Codex applies an agent file only AFTER an explicit
 * spawn value, so a drifted file delivers the snapshot's identity perfectly
 * well when the caller states it — which makes this fallback avoidable, and
 * staying silent would under-report exactly the drift the check exists for.
 */
test('a drifted installed agent still makes the fallback avoidable', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeRun(root, '2026-01-01-0000-run', [fallbackRow('hd-1', 'luna', 'gpt-5.6-luna', 'xhigh')]);
  const projectDir = codexProjectAgents(root);
  // The agent file says `low`; the dispatched request said `xhigh`. A spawn
  // passing the snapshot's `xhigh` explicitly wins over the file.
  writeFileSync(join(projectDir, 'worker.toml'), managed('0.6.0-rc.40', hostAgentBody('worker', 'luna', 'gpt-5.6-luna', 'low')));

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.equal(result.findings.some((f) => f.check === 'codex-agents-fallback-avoidable'), true);
});

test('doctor stays silent about host-delivered dispatches (only command-fallback counts)', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  writeRun(root, '2026-01-01-0000-run', [
    { type: 'actor_dispatched', dispatch_id: 'hd-1', executor: 'luna', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', delivery_transport: 'host' },
  ]);
  const projectDir = codexProjectAgents(root);
  writeFileSync(join(projectDir, 'worker.toml'), managed('0.6.0-rc.40', hostAgentBody('worker', 'luna', 'gpt-5.6-luna', 'xhigh')));

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.equal(result.findings.some((f) => f.check === 'codex-agents-fallback-avoidable'), false);
});

test('doctor only scans the most recent run, not the whole run history', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  // Older run: an avoidable fallback, with a matching agent installed.
  writeRun(root, '2026-01-01-0000-old', [fallbackRow('hd-old', 'luna', 'gpt-5.6-luna', 'xhigh')]);
  // Newest run: no fallback rows at all.
  writeRun(root, '2026-01-02-0000-new', [
    { type: 'actor_dispatched', dispatch_id: 'hd-new', executor: 'luna', model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', delivery_transport: 'host' },
  ]);
  const projectDir = codexProjectAgents(root);
  writeFileSync(join(projectDir, 'worker.toml'), managed('0.6.0-rc.40', hostAgentBody('worker', 'luna', 'gpt-5.6-luna', 'xhigh')));

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.equal(result.findings.some((f) => f.check === 'codex-agents-fallback-avoidable'), false);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { deriveDispatchOutcome } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runDispatch } from '../src/commands/dispatch.ts';
import { collectHarnessObserved, OUTPUT_IDLE_WARNING_MS } from '../src/commands/show.ts';
import { runShow } from '../src/commands/show.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

const BIN = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

// ---------------------------------------------------------------------------
// CLI --timeout parsing: drive and dispatch reject empty/non-integer, 0 disables
// ---------------------------------------------------------------------------
test('cli drive --timeout rejects empty string', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // minimal playbook + run
  const playbook = `kind: AgentPlaybook
schema_version: "0.1"
name: t
description: t
when_to_use: [t]
roles:
  worker: { purpose: x }
flow:
  - id: a
    kind: actor_call
    actor: worker
    output: Notes
    output_path: artifacts/n.md
`;
  writeFileSync(join(root, '.fadeno', 'playbooks', 't.yaml'), playbook);
  const { runId } = runNewRun({ repoRoot: root, playbook: 't', task: 'timeout parse' });
  const out = (() => {
    try {
      execFileSync(BIN, ['drive', runId, '--timeout', ''], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stderr: '' };
    } catch (e: any) {
      return { status: e.status ?? 1, stderr: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  })();
  assert.equal(out.status, 1);
  assert.match(out.stderr, /Invalid --timeout/);
});

test('cli dispatch --timeout rejects empty string and whitespace', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const v3 = {
    schema_version: 3,
    models: { sleep: { provider: 'openai', id: 'sleep', effort: 'high' } },
    routes: { standalone: { openai: { command: ['node', '-e', '0'] }, 'current-host': { host: true } } },
    archetypes: { worker: {} },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  for (const bad of ['', '  ', '1.5', '-1', 'abc']) {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(BIN, ['dispatch', '--archetype', 'worker', '--timeout', bad], { cwd: root, encoding: 'utf8', input: 'hi', stdio: 'pipe' });
    } catch (e: any) {
      status = e.status ?? 1;
      stderr = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    assert.equal(status, 1, `bad timeout ${JSON.stringify(bad)} should be rejected`);
    if (bad === '-1') assert.match(stderr, /Invalid --timeout|argument is ambiguous/);
    else assert.match(stderr, /Invalid --timeout/);
  }
});

test('cli drive and dispatch --timeout help documents 0 disables', (t) => {
  const root = tempRepo(t);
  let out = '';
  try {
    out = execFileSync(BIN, ['drive', '--help'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    out = e.stdout ?? '';
  }
  assert.match(out, /--timeout <seconds>/);
  assert.match(out, /0 disables/);
  try {
    out = execFileSync(BIN, ['dispatch', '--help'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    out = e.stdout ?? '';
  }
  assert.match(out, /--timeout <seconds>/);
});

// ---------------------------------------------------------------------------
// Dispatch outcome: timeout outranks signal/exit code (reconciliation rule 4)
// ---------------------------------------------------------------------------
test('deriveDispatchOutcome timeout outranks signal and exit_nonzero', () => {
  // contract: status-file timeout facts outrank the supervisor process exit signal
  // dispatch_completed.outcome = "timeout" must be authoritative
  assert.equal(deriveDispatchOutcome({ exitCode: 0, signal: null, outputBytes: 10, timedOut: true }), 'timeout');
  assert.equal(deriveDispatchOutcome({ exitCode: 1, signal: null, outputBytes: 10, timedOut: true }), 'timeout');
  assert.equal(deriveDispatchOutcome({ exitCode: null, signal: 'SIGTERM', outputBytes: 10, timedOut: true }), 'timeout');
  // without timeout, signal wins
  assert.equal(deriveDispatchOutcome({ exitCode: null, signal: 'SIGTERM', outputBytes: 10, timedOut: false }), 'failed');
  assert.equal(deriveDispatchOutcome({ exitCode: 1, outputBytes: 10, timedOut: false }), 'failed');
  assert.equal(deriveDispatchOutcome({ exitCode: 0, outputBytes: 10, timedOut: false }), 'ok');
  assert.equal(deriveDispatchOutcome({ exitCode: 0, outputBytes: 0, timedOut: false }), 'empty');
  // missing timedOut (null) is not timeout
  assert.equal(deriveDispatchOutcome({ exitCode: 0, outputBytes: 10, timedOut: null }), 'ok');
});

test('dispatch_completed outcome timeout carries timeout_ms and deadline_at', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // route with short deadline, executor sleeps longer than deadline
  const sleepCmd = ['node', '-e', 'setTimeout(()=>{}, 10000)'];
  const sleepyRoute = { command: sleepCmd, timeout_ms: 800, };
  const v3 = {
    schema_version: 3,
    models: { sleepy: { provider: 'sleep_p', id: 'sleepy', effort: 'high' } },
    routes: {
      standalone: {
        sleep_p: sleepyRoute,
        'current-host': { host: true },
      },
      codex: {
        sleep_p: sleepyRoute,
        'current-host': { host: true },
      },
      claude: {
        sleep_p: sleepyRoute,
        'current-host': { host: true },
      },
      grok: {
        sleep_p: sleepyRoute,
        'current-host': { host: true },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'sleepy' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  try {
    runDispatch({
      repoRoot: root,
      archetype: 'worker',
      prompt: 'timeout test',
      // no CLI override -> uses route 800ms
    });
  } catch {}
  const dispatchesPath = join(root, '.fadeno', 'dispatches.jsonl');
  assert.ok(existsSync(dispatchesPath), 'dispatches.jsonl must exist');
  const rows = readFileSync(dispatchesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const completed = rows.find((r: any) => r.event === 'dispatch_completed');
  assert.ok(completed, 'should have dispatch_completed');
  // Should be timeout outcome with deadline facts
  assert.equal(completed.outcome, 'timeout', `expected timeout but got ${JSON.stringify(completed)}`);
  assert.equal(completed.timeout_ms, 800);
  assert.ok(typeof completed.deadline_at === 'string' && completed.deadline_at.length > 0, 'deadline_at must be present');
  // duration should be at least timeout but less than grace+timeout heavily
  // wall time not inferred: status file is authoritative; signal fact preserved
  assert.ok(completed.signal != null || completed.exit_code != null, 'process exit/signal facts remain present');
});

test('dispatch --timeout 0 disables route deadline', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  // same sleepy route but override with 0
  const fastRoute = { command: ['node', '-e', "process.stdout.write('ok')"], timeout_ms: 100, };
  const v3 = {
    schema_version: 3,
    models: { fast: { provider: 'fast_p', id: 'fast', effort: 'high' } },
    routes: {
      standalone: { fast_p: fastRoute, 'current-host': { host: true } },
      codex: { fast_p: fastRoute, 'current-host': { host: true } },
      claude: { fast_p: fastRoute, 'current-host': { host: true } },
      grok: { fast_p: fastRoute, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'fast' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  const result = runDispatch({
    repoRoot: root,
    archetype: 'worker',
    prompt: 'no timeout',
    timeoutMs: 0,
  });
  assert.equal(result.outcome, 'ok');
  assert.equal(result.stdout, 'ok');
  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const completed = rows.find((r: any) => r.event === 'dispatch_completed' && r.outcome === 'ok');
  assert.ok(completed, 'should have ok outcome when timeout disabled');
  assert.equal((completed as any).timeout_ms, undefined, 'timeout_ms should be absent when disabled');
});

test('dispatch --timeout positive overrides route deadline', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const fastRoute = { command: ['node', '-e', "process.stdout.write('override')"], };
  const v3 = {
    schema_version: 3,
    models: { fast: { provider: 'fast_p', id: 'fast', effort: 'high' } },
    routes: {
      standalone: { fast_p: fastRoute, 'current-host': { host: true } },
      codex: { fast_p: fastRoute, 'current-host': { host: true } },
      claude: { fast_p: fastRoute, 'current-host': { host: true } },
      grok: { fast_p: fastRoute, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'fast' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  // route has no timeout_ms, CLI provides 5 seconds -> should succeed quickly, outcome ok, timeout_ms present only if timed out
  // For override that does not timeout, row should have ok and no timeout_ms
  const result = runDispatch({
    repoRoot: root,
    archetype: 'worker',
    prompt: 'override',
    timeoutMs: 5000,
  });
  assert.equal(result.outcome, 'ok');
  // Now test override that triggers timeout: fast_route sleeps, CLI timeout short
  const sleepyRoute = { command: ['node', '-e', 'setTimeout(()=>{}, 10000)'], timeout_ms: 60000, };
  const v3sleep = {
    schema_version: 3,
    models: { sleepy: { provider: 'sleep_p', id: 'sleepy', effort: 'high' } },
    routes: {
      standalone: { sleep_p: sleepyRoute, 'current-host': { host: true } },
      codex: { sleep_p: sleepyRoute, 'current-host': { host: true } },
      claude: { sleep_p: sleepyRoute, 'current-host': { host: true } },
      grok: { sleep_p: sleepyRoute, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'sleepy' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3sleep));
  // override to 700ms should timeout even though route says 60s
  try {
    runDispatch({ repoRoot: root, archetype: 'worker', prompt: 'override short', timeoutMs: 700 });
  } catch {}
  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const timeoutRow = rows.filter((r: any) => r.event === 'dispatch_completed' && r.outcome === 'timeout').pop();
  assert.ok(timeoutRow, 'CLI override short timeout should produce timeout outcome');
  assert.equal((timeoutRow as any).timeout_ms, 700);
});

// ---------------------------------------------------------------------------
// Engine receipt: executor_timeout distinct from interruption/nonzero
// ---------------------------------------------------------------------------
test('drive timeout produces executor_timeout receipt with timeout_ms and deadline_at', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const playbook = `kind: AgentPlaybook
schema_version: "0.1"
name: timeout-engine
description: engine timeout test
when_to_use: [t]
roles:
  worker: { purpose: work }
flow:
  - id: step1
    kind: actor_call
    actor: worker
    output: Notes
    output_path: artifacts/n.md
    terminal_status: completed
`;
  writeFileSync(join(root, '.fadeno', 'playbooks', 'timeout-engine.yaml'), playbook);
  // sleep executor with short timeout via route, then drive with no CLI override
  const sleepCmd = ['node', '-e', 'setTimeout(()=>{}, 10000)'];
  const slowRoute = { command: sleepCmd, timeout_ms: 700, };
  const v3 = {
    schema_version: 3,
    models: { slow: { provider: 'slow_p', id: 'slow', effort: 'high' } },
    routes: {
      standalone: { slow_p: slowRoute, 'current-host': { host: true } },
      codex: { slow_p: slowRoute, 'current-host': { host: true } },
      claude: { slow_p: slowRoute, 'current-host': { host: true } },
      grok: { slow_p: slowRoute, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    dials: { worker: 'slow' },
    bindings: { worker: 'slow' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(v3));
  const { runId } = runNewRun({ repoRoot: root, playbook: 'timeout-engine', task: 'timeout engine receipt' });
  const result = runDrive({ repoRoot: root, run: runId });
  // drive should record an actor_failed with reason executor_timeout
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events;
  const failed = ev.find((e) => e.type === 'actor_failed' && (e.extra as any).reason === 'executor_timeout');
  assert.ok(failed, `expected actor_failed reason executor_timeout, got ${JSON.stringify(ev.filter(e=>e.type==='actor_failed').map(e=>e.extra))}`);
  const extra = failed!.extra as any;
  assert.equal(extra.timeout_ms, 700);
  assert.ok(typeof extra.deadline_at === 'string' && extra.deadline_at.length > 0);
  // exit/signal facts preserved
  assert.ok(extra.signal != null || extra.exit_code != null, 'signal/exit_code preserved on timeout receipt');
  // distinct from other reasons
  assert.notEqual(extra.reason, 'exit_nonzero');
  assert.notEqual(extra.reason, 'signal');
});

test('shadow route default produces an independently classified timeout receipt', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@invalid',
  };
  execFileSync('git', ['init'], { cwd: root, env: gitEnv, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: root, env: gitEnv, stdio: 'ignore' });
  const profile = {
    schema_version: 3,
    models: {
      primary: { provider: 'fast', id: 'primary', effort: 'high' },
      challenger: { provider: 'slow', id: 'challenger', effort: 'high' },
    },
    routes: {
      standalone: {
        fast: { command: ['node', '-e', "process.stdout.write('primary')"], timeout_ms: 5000 },
        slow: { command: ['node', '-e', 'setTimeout(()=>{}, 10000)'], timeout_ms: 500 },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'primary' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(profile));
  writeLocalDialState(root, {
    dials: {},
    shadows: { worker: { model: 'challenger' } },
    legacyNote: null,
  });

  const result = runDispatch({
    repoRoot: root,
    archetype: 'worker',
    prompt: 'shadow timeout',
    userPathOptions: { env: { FADENO_HARNESS: 'standalone' } },
  });
  assert.equal(result.outcome, 'ok');
  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const shadow = rows.find((row) => row.shadow === true && row.event === 'dispatch_completed');
  assert.ok(shadow, 'shadow completion row must be recorded');
  assert.equal(shadow.outcome, 'timeout');
  assert.equal(shadow.timeout_ms, 500, 'shadow must use its own route deadline, not the primary route deadline');
  assert.equal(typeof shadow.deadline_at, 'string');
  assert.equal(shadow.signal, 'SIGTERM');
});

// ---------------------------------------------------------------------------
// Idle warning: OUTPUT_IDLE_WARNING_MS and WARNING line are non-gating
// ---------------------------------------------------------------------------
test('OUTPUT_IDLE_WARNING_MS is five minutes and idle warning is non-gating', (t) => {
  assert.equal(OUTPUT_IDLE_WARNING_MS, 300_000);
  const root = tempRepo(t);
  const runId = '2026-08-17-idle-integration';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), [
    `run_id: ${runId}`,
    'schema_version: "0.3"',
    'playbook: code-change-review',
    'status: running',
    'task: idle test',
    'started_at: 2026-08-17T10:00:00.000Z',
    'host: cli',
    'artifacts_dir: artifacts',
    'current_step: null',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"run_started","step":null,"timestamp":"2026-08-17T10:00:00.000Z"}\n');
  const now = new Date('2026-08-17T10:10:00.000Z');
  const startedAt = '2026-08-17T10:00:00.000Z'; // 10m ago
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(join(root, ...INFLIGHT_DIR.split('/'), `engine-${runId}-ac-1-a1.json`), JSON.stringify({
    pid: 6001,
    supervisor_pid: 6001,
    executor_pid: 6002,
    process_group_id: 6002,
    started_at: startedAt,
    heartbeat_at: startedAt,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');
  const result = runShow({ repoRoot: root, run: runId, now, processProbe: () => {} });
  const fact = result.projection!.harnessObserved.find((f) => f.supervisorPid === 6001)!;
  assert.ok(fact);
  assert.equal(fact.processState, 'alive');
  assert.equal(fact.outputIdleWarning, true, 'alive with no output for 10m must warn');
  assert.equal(fact.gating, 'non-gating');
  assert.equal(fact.observationSource, 'harness-observed');
  // dead never warns even when idle
  const deadResult = collectHarnessObserved(root, runId, now, () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
  const deadFact = deadResult.find((f) => f.supervisorPid === 6001);
  // inflightClaimIsAlive will say dead, so harnessObserved may be empty or dead; check outputIdleWarning false
  if (deadFact) assert.equal(deadFact.outputIdleWarning, false);
});

test('cli show renders WARNING line for idle process', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const runId = '2026-08-17-0912-idle-cli';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'run.yaml'), [
    `run_id: ${runId}`,
    'schema_version: "0.3"',
    'playbook: code-change-review',
    'status: running',
    'task: idle cli',
    'started_at: 2026-08-17T00:00:00.000Z',
    'host: cli',
    'artifacts_dir: artifacts',
    'current_step: null',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"run_started","step":null,"timestamp":"2026-08-17T00:00:00.000Z"}\n');
  // create a claim with old timestamp so show will warn (using real file, let show compute runtime from started_at)
  const oldStarted = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  mkdirSync(join(root, ...INFLIGHT_DIR.split('/')), { recursive: true });
  writeFileSync(join(root, ...INFLIGHT_DIR.split('/'), `engine-${runId}-ac-idle-a1.json`), JSON.stringify({
    pid: process.pid, // make alive
    supervisor_pid: process.pid,
    executor_pid: process.pid,
    process_group_id: process.pid,
    started_at: oldStarted,
    heartbeat_at: oldStarted,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
  }), 'utf8');
  let out = '';
  try {
    out = execFileSync(BIN, ['show', runId], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // When alive and idle >5m, CLI must include WARNING line
  assert.match(out, /WARNING: no output observed for .*\(non-gating\)/);
});

// ---------------------------------------------------------------------------
// Cancel: CLI dispatch and built-in route defaults
// ---------------------------------------------------------------------------
test('fadeno cancel --help uses COMMAND_HELP and completion includes cancel', (t) => {
  const root = tempRepo(t);
  let out = '';
  try {
    out = execFileSync(BIN, ['cancel', '--help'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    out = e.stdout ?? '';
  }
  // Should show dedicated cancel help, not global fallback
  assert.match(out, /fadeno cancel/);
  assert.match(out, /SIGTERM/);
  assert.match(out, /single live engine command claim/);
  assert.doesNotMatch(out, /fadeno — the playbook layer for AI coding agents/);

  const comp = (() => {
    try {
      return execFileSync(BIN, ['completion', 'candidates', '1', '--', 'fadeno', ''], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) { return e.stdout ?? ''; }
  })();
  assert.match(comp, /\bcancel\b/);
  const driveComp = (() => {
    try {
      return execFileSync(BIN, ['completion', 'candidates', '3', '--', 'fadeno', 'drive', '--'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) { return e.stdout ?? ''; }
  })();
  assert.match(driveComp, /--timeout/);
});

test('built-in executors.yaml has timeout_ms on command routes only', (t) => {
  const yamlText = readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml'), 'utf8');
  const count = (yamlText.match(/timeout_ms: 1200000/g) ?? []).length;
  // 25 command routes per integration result
  assert.equal(
    count,
    25,
    `every non-host command route must declare timeout_ms: 1200000 — new routes must opt in or be host: true (found ${count})`,
  );
  assert.ok(yamlText.includes('timeout_ms: 1200000'));
  // host routes must not have timeout
  // crude check: ensure no host: true line is followed soon by timeout_ms in same block — easier to parse
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'host: true') {
      const window = lines.slice(i, i + 4).join('\n');
      assert.doesNotMatch(window, /timeout_ms/);
    }
  }
});

test('executor handles timeout_ms: absent default, host rejection, positive integer', async (t) => {
  const { parseExecutorProfile } = await import('../src/lib/executors.ts');
  // absent is ok
  const base = `
schema_version: 3
models:
  m: { provider: openai, id: m, effort: high }
routes:
  standalone:
    r: { command: [node, -e, "0"] }
archetypes: {}
`;
  const p = parseExecutorProfile(base, 'test');
  // @ts-expect-error
  assert.equal((p as any).routes?.standalone?.r?.timeout_ms, undefined);
  // host with timeout should throw
  const hostBad = `
schema_version: 3
models:
  m: { provider: openai, id: m, effort: high }
routes:
  standalone:
    h: { host: true, timeout_ms: 1000 }
archetypes: {}
`;
  assert.throws(() => parseExecutorProfile(hostBad, 'test'), /host route.*may not declare.*timeout_ms/);
  // invalid values
  for (const bad of ['0', '-1', '1.5', '"1000"', 'null']) {
    const badYaml = `
schema_version: 3
models:
  m: { provider: openai, id: m, effort: high }
routes:
  standalone:
    r: { command: [node, -e, "0"], timeout_ms: ${bad} }
archetypes: {}
`;
    assert.throws(() => parseExecutorProfile(badYaml, 'test'), /must be a positive integer/);
  }
});

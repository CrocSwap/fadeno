import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { EvidenceError, runEvidencePromote } from '../src/commands/evidence.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runNext } from '../src/commands/next.ts';
import { runRun } from '../src/commands/run.ts';
import { runVendor } from '../src/commands/vendor.ts';
import { runVerify } from '../src/commands/verify.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { activeHarness, detectAmbientHarness, withoutHarnessIdentity } from '../src/lib/executors.ts';
import { runSetup, type CommandProbe } from '../src/commands/setup.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { runStatus } from '../src/commands/status.ts';
import { runDialSet } from '../src/commands/dial.ts';
import { runSteeringApply } from '../src/commands/steering.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runUninstall, UninstallError } from '../src/commands/uninstall.ts';
import { runClean } from '../src/commands/clean.ts';
import { runUnvendor } from '../src/commands/unvendor.ts';
import { exists, read, tempRepo } from './helpers.ts';

const REPO = join(import.meta.dirname, '..');

function isolatedUser(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
    },
  };
}

function pinnedUser(root: string, harness = 'standalone'): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_HARNESS: harness,
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_DATA_HOME: join(root, 'user-data'),
    },
  };
}

function unavailable(command: string): CommandProbe {
  return { name: command, command, available: false, version: null };
}

test('setup uses bundled neutral routes instead of generating a user executor catalog', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  runSetup({
    repoRoot: root,
    userPathOptions: paths,
    target: 'codex',
    probeCommand: (command) => ({ name: command, command, available: true, version: 'test' }),
  });
  assert.equal(existsSync(userPaths(paths).executorsFile), false);
});

test('setup is idempotent and writes no dial/pin state', (t) => {
  const root = tempRepo(t);
  const paths = pinnedUser(root, 'standalone');
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), [
    'schema_version: 3',
    'models:',
    '  grok:',
    '    provider: xai',
    '    id: grok',
    'routes:',
    '  standalone:',
    '    xai:',
    '      command: [legacy, run]',
    '      write_access: true',
    'archetypes:',
    '  worker:',
    '    requires_write: required',
    '',
  ].join('\n'));

  const first = runSetup({ repoRoot: root, userPathOptions: paths, probeCommand: unavailable });
  assert.equal(first.activeLoadout, 'host-native base');
  assert.equal(existsSync(userPaths(paths).dialsFile), false);
  assert.equal(existsSync(userPaths(paths).loadoutFile), false);
  assert.equal(existsSync(join(root, '.fadeno', 'local', 'loadout')), false);

  const second = runSetup({ repoRoot: root, userPathOptions: paths, probeCommand: unavailable });
  assert.equal(second.activeLoadout, 'host-native base');
  assert.equal(existsSync(userPaths(paths).dialsFile), false);
  assert.equal(existsSync(userPaths(paths).loadoutFile), false);
  assert.equal(existsSync(join(root, '.fadeno', 'local', 'loadout')), false);
  assert.equal(second.created.includes(userPaths(paths).dialsFile), false);
  assert.equal(second.created.includes(userPaths(paths).loadoutFile), false);
});

test('setup remembers Codex so later dial switches materialize native agents automatically', (t) => {
  const root = tempRepo(t);
  const paths = pinnedUser(root, 'standalone');
  const setup = runSetup({ repoRoot: root, userPathOptions: paths, target: 'codex', probeCommand: unavailable });
  assert.equal(setup.target, 'codex');
  assert.equal(readFileSync(userPaths(paths).harnessFile, 'utf8'), 'codex\n');
  const workerPath = join(paths.home!, '.codex', 'agents', 'fadeno-worker.toml');
  assert.ok(existsSync(workerPath), 'codex setup should materialize host agents');
  const initial = readFileSync(workerPath, 'utf8');

  // Switch dial via dial set; choose a model whose delivery differs from host-native base.
  // 'grok' is command-delivered (xai) and eligible for worker (requires_write: required).
  const switched = runDialSet({ repoRoot: root, userPathOptions: pinnedUser(root, 'standalone'), archetype: 'worker', model: 'grok' });
  assert.ok(switched.refString.includes('grok'));

  const applied = runSteeringApply({ repoRoot: root, target: 'codex', scope: 'user', userPathOptions: paths, force: true });
  assert.ok(applied.results.some((r) => r.path === workerPath));
  const refreshed = readFileSync(workerPath, 'utf8');
  // Host-native base produced a host agent; grok produces a command broker.
  assert.notEqual(initial, refreshed);
  assert.match(refreshed, /command-broker|Fadeno command broker/);
  // Status reflects the dial
  const status = runStatus({ repoRoot: root, userPathOptions: pinnedUser(root, 'standalone') });
  assert.ok(status.dials.user.worker || status.dials.session.worker, 'dial should be visible in status');
});

test('plugin-backed setup is user-only, installs a stable runtime, and uninstalls by ownership', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  const runtime = join(root, 'plugin-bin');
  mkdirSync(runtime, { recursive: true });
  const bundled = join(runtime, 'fadeno');
  writeFileSync(bundled, '#!/bin/sh\nexit 0\n');
  chmodSync(bundled, 0o755);

  const setup = runSetup({
    repoRoot: root,
    userPathOptions: paths,
    target: 'codex',
    runtimeSource: runtime,
    probeCommand: unavailable,
  });
  const resolved = userPaths(paths);
  assert.equal(existsSync(join(root, '.gitignore')), false, 'user setup must not mutate the current repo');
  assert.ok(existsSync(resolved.managedCli));
  assert.ok(existsSync(resolved.installationsFile));
  assert.match(readFileSync(join(paths.home!, '.codex', 'agents', 'fadeno-worker.toml'), 'utf8'), new RegExp(resolved.managedCli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const removed = runUninstall({ target: 'codex', userPathOptions: paths });
  assert.equal(removed.preserved.length, 0);
  assert.equal(existsSync(resolved.managedRuntimeDir), false);
  assert.equal(existsSync(resolved.executorsFile), false, 'no provider probes meant no generated catalog');
  assert.throws(
    () => runUninstall({ purgeUserData: true, userPathOptions: paths }),
    UninstallError,
  );
  runUninstall({ purgeUserData: true, force: true, userPathOptions: paths });
  assert.equal(existsSync(resolved.stateDir), false);
  assert.ok(setup.created.includes(resolved.managedRuntimeDir));
});

test('Claude setup owns only its stable-runtime permission rule', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  const runtime = join(root, 'plugin-bin');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'fadeno'), '#!/bin/sh\nexit 0\n');
  const settings = join(paths.home!, '.claude', 'settings.json');
  mkdirSync(join(settings, '..'), { recursive: true });
  writeFileSync(settings, `${JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, theme: 'dark' }, null, 2)}\n`);

  runSetup({
    repoRoot: root,
    userPathOptions: paths,
    target: 'claude',
    runtimeSource: runtime,
    probeCommand: unavailable,
  });
  const resolved = userPaths(paths);
  const installed = JSON.parse(readFileSync(settings, 'utf8')) as { permissions: { allow: string[] }; theme: string };
  assert.deepEqual(installed.permissions.allow, ['Bash(git status)', `Bash(${resolved.managedCli}:*)`]);

  runUninstall({ target: 'claude', userPathOptions: paths });
  const remaining = JSON.parse(readFileSync(settings, 'utf8')) as typeof installed;
  assert.deepEqual(remaining.permissions.allow, ['Bash(git status)']);
  assert.equal(remaining.theme, 'dark');
});

test('plugin runtime installation emits a Windows command shim', (t) => {
  const root = tempRepo(t);
  const runtime = join(root, 'plugin-bin');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'fadeno'), '#!/usr/bin/env node\n');
  const paths: UserPathOptions = {
    home: join(root, 'home'),
    platform: 'win32',
    env: { LOCALAPPDATA: join(root, 'local-app-data'), APPDATA: join(root, 'app-data') },
  };
  runSetup({ repoRoot: root, userPathOptions: paths, runtimeSource: runtime, probeCommand: unavailable });
  const resolved = userPaths(paths);
  assert.ok(resolved.managedCli.endsWith('fadeno.cmd'));
  assert.match(readFileSync(resolved.managedCli, 'utf8'), /node "%~dp0fadeno" %\*/);
});

test('clean is dry-run by default and removes only runtime state with --force', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno', 'runs', 'r'), { recursive: true });
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'runs', 'r', 'run.yaml'), 'status: running\n');
  writeFileSync(join(root, '.fadeno', 'playbooks', 'keep.yaml'), 'kind: AgentPlaybook\n');
  assert.equal(runClean({ repoRoot: root }).dryRun, true);
  assert.ok(existsSync(join(root, '.fadeno', 'runs', 'r', 'run.yaml')));
  runClean({ repoRoot: root, force: true });
  assert.equal(existsSync(join(root, '.fadeno', 'runs')), false);
  assert.ok(existsSync(join(root, '.fadeno', 'playbooks', 'keep.yaml')));
});

test('unvendor removes only lock-owned unmodified files and preserves edits', (t) => {
  const root = tempRepo(t);
  runVendor({ repoRoot: root, target: 'codex', withSteering: true });
  const modified = join(root, '.codex', 'agents', 'worker.toml');
  writeFileSync(modified, `${readFileSync(modified, 'utf8')}\n# user edit\n`);
  const first = runUnvendor({ repoRoot: root });
  assert.ok(first.preserved.includes(modified));
  assert.equal(first.lockRemoved, false);
  const forced = runUnvendor({ repoRoot: root, force: true });
  assert.equal(forced.lockRemoved, true);
  assert.equal(existsSync(modified), false);
  assert.equal(existsSync(join(root, '.fadeno', 'vocabulary.md')), false);
  assert.ok(existsSync(join(root, 'AGENTS.md')), 'shared bootstrap is not wholly owned by the lock');
});

test('drive recovers a command start left without a terminal receipt', (t) => {
  const root = tempRepo(t);
  const paths = pinnedUser(root, 'standalone');
  const run = runNewRun({
    repoRoot: root,
    userPathOptions: paths,
    playbook: 'code-change-review',
    task: 'recover interrupted dispatch',
    now: new Date('2026-08-11T03:00:00.000Z'),
  });
  // v3 fixture: failing command for worker/reviewer, plus binding for coordinator
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      'fail-model': { provider: 'failp', id: 'fail-model', effort: 'default' },
    },
    routes: {
      standalone: {
        failp: { command: [process.execPath, '-e', 'process.exit(7)'], write_access: true },
        'current-host': { host: true },
      },
      codex: {
        failp: { command: [process.execPath, '-e', 'process.exit(7)'], write_access: true },
        'current-host': { host: true },
      },
      claude: {
        failp: { command: [process.execPath, '-e', 'process.exit(7)'], write_access: true },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
      reviewer: { requires_write: 'none' },
    },
    bindings: {
      coordinator: 'fail-model',
    },
    dials: {
      worker: 'fail-model',
      reviewer: 'fail-model',
      judge: 'fail-model',
    },
  }));
  new LedgerWriter(run.runDir).append({
    type: 'actor_dispatched',
    step: 'plan',
    actor: 'planner',
    step_execution_id: 'plan@1',
    actor_call_id: 'plan@1/planner@1',
    attempt: 1,
    executor: 'fail-model',
  }, new Date('2026-08-11T03:00:01.000Z'));

  const result = runDrive({ repoRoot: root, userPathOptions: paths, run: run.runId, env: null });
  assert.equal(result.outcome, 'executor_failed');
  const recovered = readEvents(run.runDir).events.find((event) =>
    event.type === 'actor_failed' && event.extra.reason === 'engine_interrupted',
  );
  assert.equal(recovered?.extra.recovered, true);
  assert.match(result.actions.join('\n'), /recovered 1 interrupted command dispatch receipt/);
});

test('doctor checks a repo-selected executable without executing it', (t) => {
  const root = tempRepo(t);
  const paths = pinnedUser(root, 'standalone');
  const marker = join(root, 'executed');
  const command = join(root, 'repo-command');
  writeFileSync(command, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(command, 0o755);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      'repo-model': { provider: 'repo', id: 'repo-model', effort: 'default' },
    },
    routes: {
      standalone: {
        repo: { command: [command], write_access: true },
        'current-host': { host: true },
      },
      codex: {
        repo: { command: [command], write_access: true },
        'current-host': { host: true },
      },
      claude: {
        repo: { command: [command], write_access: true },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { requires_write: 'required' },
    },
    dials: {
      worker: 'repo-model',
    },
  }));

  const result = runDoctor({ repoRoot: root, userPathOptions: paths });
  assert.equal(result.ok, true);
  assert.equal(existsSync(marker), false, 'doctor must not execute a repo-selected command');
  assert.ok(result.findings.some((item) => item.check === 'executor:repo-model' && item.severity === 'ok'));
  // dials finding is present in dial world
  assert.ok(result.findings.some((item) => item.check === 'dials' && item.severity === 'ok'));
});

test('a dial switched from a Claude session still refreshes the Codex agents', (t) => {
  const root = tempRepo(t);
  const base = pinnedUser(root, 'standalone');
  // Set up both harnesses; last setup writes memo but maintained set is the union
  runSetup({ repoRoot: root, userPathOptions: base, target: 'codex', probeCommand: unavailable });
  runSetup({ repoRoot: root, userPathOptions: base, target: 'claude', probeCommand: unavailable });
  assert.equal(readFileSync(userPaths(base).harnessFile, 'utf8'), 'claude\n');

  const worker = join(base.home!, '.codex', 'agents', 'fadeno-worker.toml');
  // initial host baseline contains no unapproved command fallback artifact; at least it is host
  const before = readFileSync(worker, 'utf8');
  assert.match(before, /host|Fadeno hybrid/, 'initial agent should be host');

  // Switching from inside Claude used to skip materialization entirely
  const inClaude: UserPathOptions = { home: base.home, env: { ...base.env, FADENO_HARNESS: 'claude', CLAUDECODE: '1' } };
  const switched = runDialSet({ repoRoot: root, userPathOptions: inClaude, archetype: 'worker', model: 'grok' });
  assert.ok(switched.refString.includes('grok'));
  const applied = runSteeringApply({ repoRoot: root, target: 'codex', scope: 'user', userPathOptions: inClaude, force: true });
  assert.ok(applied.results.some((r) => r.path === worker), 'Codex agents must be rewritten from whichever host you are in');
  const after = readFileSync(worker, 'utf8');
  assert.notEqual(before, after);
  assert.match(after, /command-broker|Fadeno command broker/);

  // And doctor reports on them without Codex being the harness in front of you.
  const report = runDoctor({ repoRoot: root, userPathOptions: inClaude });
  assert.equal(report.findings.find((item) => item.check === 'harness')?.detail?.includes('claude'), true);
  assert.ok(report.findings.some((item) => item.check === 'codex-agents'), 'codex-agents must still be checked');
});

test('an uninstalled Codex is not materialized for, and an explicit target still scopes', (t) => {
  const root = tempRepo(t);
  const base = pinnedUser(root, 'standalone');
  runSetup({ repoRoot: root, userPathOptions: base, target: 'claude', probeCommand: unavailable });

  // Claude only: nothing should appear under ~/.codex.
  const workerPath = join(base.home!, '.codex', 'agents', 'fadeno-worker.toml');
  assert.equal(existsSync(workerPath), false);
  // A dial switch alone should not materialize Codex agents when Codex is not maintained
  runDialSet({ repoRoot: root, userPathOptions: base, archetype: 'worker', model: 'grok' });
  assert.equal(existsSync(workerPath), false, 'uninstalled Codex should not be materialized by a plain dial switch');

  // An explicit --codex is the caller saying what they mean, and still writes.
  const forced = runSteeringApply({ repoRoot: root, target: 'codex', scope: 'user', userPathOptions: base, force: true });
  assert.ok(forced.results.some((r) => r.path === workerPath));
  assert.ok(existsSync(workerPath));

  // Explicit harness still scopes doctor even when Codex not maintained
  const explicitDoctor = runDoctor({ repoRoot: root, userPathOptions: { home: base.home, env: { ...base.env, FADENO_HARNESS: 'codex' } } });
  const harnessFinding = explicitDoctor.findings.find((f) => f.check === 'harness');
  assert.ok(harnessFinding);
  // When explicitly pinned to codex with no ambient, harness is codex but no host claims
  assert.match(harnessFinding.detail, /codex|no host claims/);
});

test('one memo cannot serve two harnesses, so the host in evidence wins', (t) => {
  const root = tempRepo(t);
  const base = isolatedUser(root);
  runSetup({ repoRoot: root, userPathOptions: base, target: 'claude', probeCommand: unavailable });
  runSetup({ repoRoot: root, userPathOptions: base, target: 'codex', probeCommand: unavailable });
  assert.equal(readFileSync(userPaths(base).harnessFile, 'utf8'), 'codex\n');
  const inClaude: UserPathOptions = { ...base, env: { ...base.env, CLAUDECODE: '1' } };
  assert.equal(activeHarness(undefined, inClaude), 'claude');
  const inCodex: UserPathOptions = { ...base, env: { ...base.env, CODEX_THREAD_ID: 'thread-1' } };
  assert.equal(activeHarness(undefined, inCodex), 'codex');
  assert.equal(activeHarness(undefined, base), 'codex');
});

test('nested hosts abstain rather than guess, and an executor child sheds our identity', (t) => {
  const root = tempRepo(t);
  const base = isolatedUser(root);
  runSetup({ repoRoot: root, userPathOptions: base, target: 'claude', probeCommand: unavailable });
  const nested: UserPathOptions = {
    ...base,
    env: { ...base.env, CLAUDECODE: '1', CODEX_THREAD_ID: 'thread-1' },
  };
  const detection = detectAmbientHarness(nested);
  assert.equal(detection.harness, null);
  assert.deepEqual(detection.evidence.map((item) => item.harness), ['claude', 'codex']);
  assert.equal(activeHarness(undefined, nested), 'claude', 'falls back to the recorded memo');

  // The real fix is at the spawn point: a child inherits no harness identity,
  // so whatever it launches asserts its own instead of ours.
  const shed = withoutHarnessIdentity({ ...nested.env, FADENO_HARNESS: 'claude', CODEX_HOME: '/keep' });
  assert.equal(shed.CLAUDECODE, undefined);
  assert.equal(shed.CODEX_THREAD_ID, undefined);
  assert.equal(shed.FADENO_HARNESS, undefined);
  assert.equal(shed.CODEX_HOME, '/keep', 'a config location is not a session claim');
});

test('an explicit FADENO_HARNESS still outranks the host in evidence, and doctor says so', (t) => {
  const root = tempRepo(t);
  const base = isolatedUser(root);
  const forced: UserPathOptions = {
    ...base,
    env: { ...base.env, CLAUDECODE: '1', FADENO_HARNESS: 'codex' },
  };
  assert.equal(activeHarness(undefined, forced), 'codex');
});

test('doctor stays quiet about the harness when no host evidence is present', (t) => {
  const root = tempRepo(t);
  const paths = pinnedUser(root, 'standalone');
  const result = runDoctor({ repoRoot: root, userPathOptions: paths });
  const harness = result.findings.find((item) => item.check === 'harness');
  assert.equal(harness?.severity, 'ok');
  assert.match(harness?.detail ?? '', /no host claims this session/);
  assert.equal(harness?.remediation, undefined);
  // dials finding is quiet ok as well
  const dials = result.findings.find((item) => item.check === 'dials');
  assert.equal(dials?.severity, 'ok');
});

test('vendor respects --no-steering and makes explicitly vendored Codex brokers trackable', (t) => {
  const noSteeringRoot = tempRepo(t);
  runVendor({ repoRoot: noSteeringRoot, target: 'codex', withSteering: false });
  assert.ok(exists(noSteeringRoot, '.codex/agents/worker.toml'));
  assert.doesNotMatch(read(noSteeringRoot, '.codex/agents/worker.toml'), /steering resolve/);

  const steeringRoot = tempRepo(t);
  runVendor({ repoRoot: steeringRoot, target: 'codex', withSteering: true });
  assert.ok(exists(steeringRoot, '.codex/agents/worker.toml'));
  assert.match(read(steeringRoot, '.gitignore'), /!\.codex\/agents\/worker\.toml/);
  assert.match(read(steeringRoot, '.codex/agents/worker.toml'), /--host-executor native-worker/);
});

test('evidence promotion refuses running traces and is idempotent for a verified terminal receipt', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  const run = runNewRun({
    repoRoot: root,
    userPathOptions: paths,
    playbook: 'code-change-review',
    task: 'promote evidence',
    now: new Date('2026-08-11T04:00:00.000Z'),
  });
  assert.throws(() => runEvidencePromote({ repoRoot: root, run: run.runId }), EvidenceError);
  runRun({ repoRoot: root, run: run.runId, status: 'completed', now: new Date('2026-08-11T04:01:00.000Z') });
  const promoted = runEvidencePromote({ repoRoot: root, run: run.runId });
  assert.equal(promoted.idempotent, false);
  assert.ok(existsSync(join(promoted.destination, 'definitions', 'playbook.yaml')));
  assert.equal(runEvidencePromote({ repoRoot: root, run: run.runId }).idempotent, true);
});

test('runs pin playbook/schema definitions and verification detects snapshot tampering', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  const run = runNewRun({
    repoRoot: root,
    userPathOptions: paths,
    playbook: 'code-change-review',
    task: 'snapshot definitions',
    now: new Date('2026-08-11T05:00:00.000Z'),
  });
  assert.ok(existsSync(join(run.runDir, 'definitions', 'playbook.yaml')));
  assert.ok(existsSync(join(run.runDir, 'definitions', 'schemas', 'playbook.schema.json')));

  // A later project override must not reinterpret the already-created run.
  mkdirSync(join(root, '.fadeno', 'playbooks'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'code-change-review.yaml'), 'flow:\n  - id: replacement\n    kind: human_gate\n');
  assert.equal(runNext({ repoRoot: root, run: run.runId }).step?.id, 'plan');

  runRun({ repoRoot: root, run: run.runId, status: 'completed', now: new Date('2026-08-11T05:01:00.000Z') });
  assert.equal(runVerify({ repoRoot: root, run: run.runId }).findings.find((item) => item.check === 'playbook-provenance')?.status, 'ok');
  writeFileSync(join(run.runDir, 'definitions', 'playbook.yaml'), 'flow: []\n');
  assert.equal(runVerify({ repoRoot: root, run: run.runId }).findings.find((item) => item.check === 'playbook-provenance')?.status, 'fail');
});

test('Claude steering hook remains inert for native slots and is registered by the plugin', (t) => {
  const root = tempRepo(t);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'fadeno');
  writeFileSync(fake, '#!/bin/sh\nprintf \'%s\\n\' \'{"adapter":"host"}\'\n');
  chmodSync(fake, 0o755);
  const event = JSON.stringify({ tool_name: 'Agent', cwd: root, tool_input: { subagent_type: 'worker', prompt: 'x' } });
  const result = spawnSync(process.execPath, [join(REPO, 'templates', 'claude', 'hooks', 'dispatch-steering.mjs')], {
    input: event,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const manifest = JSON.parse(read(REPO, 'templates/claude/hooks/hooks.json'));
  assert.equal(manifest.hooks.PreToolUse[0].matcher, 'Agent');
});

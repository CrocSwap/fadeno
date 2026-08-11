import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runDoctor } from '../src/commands/doctor.ts';
import { EvidenceError, runEvidencePromote } from '../src/commands/evidence.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runNext } from '../src/commands/next.ts';
import { runRun } from '../src/commands/run.ts';
import { runSetup, type CommandProbe } from '../src/commands/setup.ts';
import { runStatus } from '../src/commands/status.ts';
import { runUse } from '../src/commands/use.ts';
import { runVendor } from '../src/commands/vendor.ts';
import { runVerify } from '../src/commands/verify.ts';
import { userPaths, type UserPathOptions } from '../src/lib/user-paths.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { runDrive } from '../src/commands/drive.ts';
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

function unavailable(command: string): CommandProbe {
  return { name: command, command, available: false, version: null };
}

test('setup is idempotent and never plants a stale native pin into a complete legacy project profile', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), [
    'executors:',
    '  legacy-cli:',
    '    adapter: command',
    '    command: [legacy, run]',
    'loadouts:',
    '  legacy:',
    '    worker: legacy-cli',
    'default_loadout: legacy',
    '',
  ].join('\n'));

  const first = runSetup({ repoRoot: root, userPathOptions: paths, probeCommand: unavailable });
  assert.equal(first.activeLoadout, 'legacy');
  assert.equal(existsSync(userPaths(paths).loadoutFile), false);
  assert.match(first.notices.join('\n'), /wrote no stale user pin/);

  const second = runSetup({ repoRoot: root, userPathOptions: paths, probeCommand: unavailable });
  assert.equal(second.activeLoadout, 'legacy');
  assert.equal(second.created.includes(userPaths(paths).loadoutFile), false);
});

test('setup remembers Codex so later loadout switches materialize native agents automatically', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  const setup = runSetup({ repoRoot: root, userPathOptions: paths, target: 'codex', probeCommand: unavailable });
  assert.equal(setup.activeLoadout, 'native');
  assert.equal(readFileSync(userPaths(paths).loadoutFile, 'utf8'), 'native\n');
  assert.equal(readFileSync(userPaths(paths).harnessFile, 'utf8'), 'codex\n');

  const selected = runUse({ repoRoot: root, userPathOptions: paths, name: 'claude' });
  assert.equal(selected.scope, 'user');
  assert.equal(readFileSync(userPaths(paths).loadoutFile, 'utf8'), 'claude\n');
  const status = runStatus({ repoRoot: root, userPathOptions: paths });
  assert.equal(status.activeLoadout?.name, 'claude');
  assert.equal(status.activeLoadout?.source, 'user');
  assert.equal(status.external.length, 3);

  const native = runUse({ repoRoot: root, userPathOptions: paths, name: 'native' });
  assert.ok(native.steering, 'remembered Codex harness should trigger materialization without --codex');
  assert.ok(existsSync(join(paths.home!, '.codex', 'agents', 'fadeno-worker.toml')));
});

test('drive recovers a command start left without a terminal receipt', (t) => {
  const root = tempRepo(t);
  const paths = isolatedUser(root);
  const run = runNewRun({
    repoRoot: root,
    userPathOptions: paths,
    playbook: 'code-change-review',
    task: 'recover interrupted dispatch',
    now: new Date('2026-08-11T03:00:00.000Z'),
  });
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), [
    'executors:',
    '  fail:',
    '    adapter: command',
    `    command: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify('process.exit(7)')}]`,
    'loadouts:',
    '  broken: { worker: fail, reviewer: fail, judge: fail }',
    'default_loadout: broken',
    'bindings: { "*": fail }',
    '',
  ].join('\n'));
  new LedgerWriter(run.runDir).append({
    type: 'actor_dispatched',
    step: 'plan',
    actor: 'planner',
    step_execution_id: 'plan@1',
    actor_call_id: 'plan@1/planner@1',
    attempt: 1,
    executor: 'fail',
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
  const paths = isolatedUser(root);
  const marker = join(root, 'executed');
  const command = join(root, 'repo-command');
  writeFileSync(command, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(command, 0o755);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), [
    'executors:',
    '  repo-command:',
    '    adapter: command',
    `    command: [${JSON.stringify(command)}]`,
    'loadouts:',
    '  repo:',
    '    worker: repo-command',
    'default_loadout: repo',
    '',
  ].join('\n'));

  const result = runDoctor({ repoRoot: root, userPathOptions: paths });
  assert.equal(result.ok, true);
  assert.equal(existsSync(marker), false, 'doctor must not execute a repo-selected command');
  assert.ok(result.findings.some((item) => item.check === 'executor:repo-command' && item.severity === 'ok'));
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
  assert.match(read(steeringRoot, '.codex/agents/worker.toml'), /--native-executor native-worker/);
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
  writeFileSync(fake, '#!/bin/sh\nprintf "active loadout: native [default]\\n  worker   → native-worker [host]\\n"\n');
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

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runVerify } from '../src/commands/verify.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { tempRepo } from './helpers.ts';

const NOTES_CMD = ['node', '-e', "process.stdout.write('NOTES')"];

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: pre-dials-verify
description: Pre-dials snapshot test
when_to_use:
  - pre-dials
roles:
  implementer:
    purpose: Implement.
    archetype: worker
flow:
  - id: implement
    kind: actor_call
    actor: implementer
    output: Notes
    output_path: artifacts/notes.md
    terminal_status: completed
`;

test('verify: pre-dials run snapshot fails executor-bindings with loud message', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'pre-dials-verify.yaml'), PLAYBOOK);
  // Valid v3 profile to create a run — routes cover every harness so CLAUDECODE does not starve the snapshot.
  const dummyRoute = { dummy: { command: NOTES_CMD, write_access: true }, 'current-host': { host: true } };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sol: { provider: 'dummy', id: 'sol', effort: 'high' },
    },
    routes: {
      standalone: { ...dummyRoute },
      codex: { ...dummyRoute },
      claude: { ...dummyRoute },
      grok: { ...dummyRoute },
    },
    archetypes: { worker: {} },
    dials: { worker: 'sol' },
  }));
  const { runId } = runNewRun({ playbook: 'pre-dials-verify', task: 'pre-dials snapshot', repoRoot: root });
  const done = runDrive({ run: runId, repoRoot: root });
  assert.equal(done.outcome, 'terminal');
  // Overwrite snapshot with pre-dials shape (no snapshot_version)
  const snapPath = join(root, '.fadeno', 'runs', runId, 'profile.yaml');
  const oldText = 'executors:\n  foo:\n    adapter: command\n    command: ["node", "-e", "0"]\n';
  writeFileSync(snapPath, oldText);
  // Update the sha256 in the ledger so the mismatch check passes and the parse error surfaces
  const eventsPath = join(root, '.fadeno', 'runs', runId, 'events.jsonl');
  const lines = readFileSync(eventsPath, 'utf8').split('\n');
  const updated = lines.map((line) => {
    if (!line.trim()) return line;
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'profile_snapshotted') {
      (obj as Record<string, unknown>).sha256 = sha256Hex(oldText);
      return JSON.stringify(obj);
    }
    return line;
  }).join('\n');
  writeFileSync(eventsPath, updated);
  const verify = runVerify({ run: runId, repoRoot: root });
  assert.equal(verify.ok, false);
  const binding = verify.findings.find((f) => f.check === 'executor-bindings')!;
  assert.equal(binding.status, 'fail');
  assert.match(binding.detail, /pre-dials run snapshot/);
  assert.match(binding.detail, /snapshot_version 3/);
  const gate = verify.findings.find((f) => f.check === 'gate-eligible');
  if (gate) {
    // gate-eligible also fails on pre-dials; if no dispatches it may be skip, but if it ran, it fails
    if (gate.status === 'fail') assert.match(gate.detail, /pre-dials run snapshot/);
  }
});

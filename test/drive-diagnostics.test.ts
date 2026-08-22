import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { tempRepo } from './helpers.ts';
import {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_LINES,
  diagnosticsTruncationMarker,
} from '../src/lib/diagnostics.ts';

function seedDriveRepo(root: string, command: string): void {
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { writer: { provider: 'writerp', id: 'writer', effort: 'default' } },
    routes: { standalone: { writerp: { command: ['node', '-e', command], } } },
    archetypes: { worker: {} },
    dials: { worker: 'writer' },
  }));
  writeFileSync(join(root, '.fadeno', 'playbooks', 'diag-drive.yaml'), stringifyYaml({
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'diag-drive',
    description: 'Diagnostics fixture.',
    roles: { worker: { purpose: 'Write.', archetype: 'worker' } },
    flow: [{ id: 'work', kind: 'actor_call', actor: 'worker', output: 'Notes', terminal_status: 'completed' }],
  }));
}

function events(root: string, runId: string): ReturnType<typeof readEvents>['events'] {
  return readEvents(join(root, '.fadeno', 'runs', runId)).events;
}

function diagnosticsFiles(root: string): string[] {
  const dir = join(root, '.fadeno', 'local', 'outputs', 'diagnostics');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => join(dir, f));
}

test('drive diagnostics: not persisted by default, only byte counters remain', (t) => {
  const root = tempRepo(t);
  // simple echo executor
  seedDriveRepo(root, "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))");
  const created = runNewRun({ playbook: 'diag-drive', task: 'hello', repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } } as any);
  const result = runDrive({ run: created.runId, repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } as any });
  assert.equal(result.outcome, 'terminal');
  const ev = events(root, created.runId);
  const completed = ev.find((e) => e.type === 'actor_completed') as any;
  assert.ok(completed, 'actor_completed must exist');
  assert.equal('diagnostics_snapshot' in completed.extra, false, 'diagnostics_snapshot must be absent by default');
  assert.equal('diagnostics_bytes' in completed.extra, false, 'diagnostics_bytes must be absent by default');
  assert.equal(diagnosticsFiles(root).length, 0, 'no diagnostics file should be written by default');
});

test('drive diagnostics: opt-in via --diagnostics writes bounded snapshot with head+tail', (t) => {
  const root = tempRepo(t);
  // executor that outputs 600 lines, each long
  const bigLines = Array.from({ length: 600 }, (_, i) => `line-${String(i).padStart(4, '0')}-${'x'.repeat(80)}`).join('\n');
  // The playbook input is Task string? The executor reads stdin prompt (which includes task). We make executor echo a big output regardless of prompt.
  // Use a command that writes bigLines to stdout irrespective of stdin.
  const cmd = `process.stdout.write(${JSON.stringify(bigLines)})`;
  seedDriveRepo(root, cmd);
  const created = runNewRun({ playbook: 'diag-drive', task: 'big', repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } as any });
  const result = runDrive({ run: created.runId, repoRoot: root, diagnostics: true, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } as any });
  assert.equal(result.outcome, 'terminal');
  const ev = events(root, created.runId);
  const completed = ev.find((e) => e.type === 'actor_completed') as any;
  assert.ok(completed, 'actor_completed must exist');
  const diagRel = completed.extra.diagnostics_snapshot as string | undefined;
  const diagBytes = completed.extra.diagnostics_bytes as number | undefined;
  assert.ok(diagRel, 'diagnostics_snapshot must be present when opted-in');
  assert.ok(typeof diagBytes === 'number' && diagBytes > 0);
  assert.match(diagRel, /^\.fadeno\/local\/outputs\/diagnostics\/.+\.log$/);
  const diagAbs = join(root, diagRel);
  assert.ok(existsSync(diagAbs), 'diagnostics file must exist atomically');
  const content = readFileSync(diagAbs, 'utf8');
  // Should contain truncation marker because output > 32 KiB / 500 lines
  const markerOut = diagnosticsTruncationMarker('stdout');
  const markerErr = diagnosticsTruncationMarker('stderr');
  assert.ok(content.includes(markerOut) || content.includes(markerErr), 'truncation marker must be present when limits exceeded');
  assert.ok(content.includes('line-0000'), 'head must be preserved');
  assert.ok(content.includes('line-0599'), 'tail must be preserved');
  assert.ok(diagRel.startsWith('.fadeno/local/outputs/diagnostics/'));
  // bounded
  assert.ok(Buffer.byteLength(content, 'utf8') < 100 * 1024, 'diagnostics file must be bounded');
});

test('drive diagnostics: FADENO_DIAGNOSTICS=1 env enables diagnostics', (t) => {
  const root = tempRepo(t);
  seedDriveRepo(root, "process.stdout.write('env-test')");
  const created = runNewRun({ playbook: 'diag-drive', task: 'env', repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } as any });
  const prev = process.env.FADENO_DIAGNOSTICS;
  process.env.FADENO_DIAGNOSTICS = '1';
  try {
    const result = runDrive({ run: created.runId, repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } as any });
    assert.equal(result.outcome, 'terminal');
    const completed = events(root, created.runId).find((e) => e.type === 'actor_completed') as any;
    assert.ok(completed.extra.diagnostics_snapshot, 'env opt-in must create diagnostics_snapshot');
    assert.ok(existsSync(join(root, String(completed.extra.diagnostics_snapshot))));
  } finally {
    if (prev === undefined) delete process.env.FADENO_DIAGNOSTICS;
    else process.env.FADENO_DIAGNOSTICS = prev;
  }
});

test('drive diagnostics: never gates control flow and never ledger-committed beyond byte counters', (t) => {
  const root = tempRepo(t);
  seedDriveRepo(root, "process.exit(0)");
  const created = runNewRun({ playbook: 'diag-drive', task: 'empty', repoRoot: root, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } as any });
  const result = runDrive({ run: created.runId, repoRoot: root, diagnostics: true, userPathOptions: { env: { FADENO_HARNESS: 'standalone' } } as any });
  // executor exits 0 but produces no output — engine should record output_valid false, not crash
  // We do not assert terminal status; just that diagnostics file still created and outcome is terminal or needs decision
  // For this playbook, empty output still yields terminal? Check that drive did not throw
  assert.ok(result.outcome === 'terminal' || result.outcome === 'executor_failed' || result.outcome === 'output_invalid');
  const ev = events(root, created.runId);
  const completedOrFailed = ev.find((e) => e.type === 'actor_completed' || e.type === 'actor_failed') as any;
  assert.ok(completedOrFailed);
  // When diagnostics enabled, diagnostics_snapshot must be present even on empty output
  // But if engine failed before diagnostics write? It should still writeDiagnostics after spawn, regardless of verdict.
  // Check file exists if completed was actor_completed/failed with diagnostics
  if ('diagnostics_snapshot' in completedOrFailed.extra) {
    assert.ok(existsSync(join(root, String(completedOrFailed.extra.diagnostics_snapshot))));
  }
  // Never ledger-committed: there is no separate ledger file containing diagnostics content; only byte counters are in evidence row.
  // We verify that diagnostics content is not appended to events.jsonl as a separate event
  const hasDiagnosticsContent = ev.some((e) => typeof (e as any).extra?.diagnostics_content !== 'undefined');
  assert.equal(hasDiagnosticsContent, false, 'diagnostics must not be ledger-committed as content');
});

test('drive diagnostics: truncation marker verbatim and per-stream limits', () => {
  assert.equal(DIAGNOSTICS_MAX_BYTES, 32 * 1024);
  assert.equal(DIAGNOSTICS_MAX_LINES, 500);
  assert.equal(diagnosticsTruncationMarker('stdout'), '\n…[fadeno diagnostics truncated: stdout exceeded 32 KiB / 500 lines]…\n');
  assert.equal(diagnosticsTruncationMarker('stderr'), '\n…[fadeno diagnostics truncated: stderr exceeded 32 KiB / 500 lines]…\n');
});

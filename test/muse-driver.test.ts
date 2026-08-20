import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import {
  compileDialRef,
  parseExecutorProfile,
  substitutePromptFile,
} from '../src/lib/executors.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// A stand-in for Muse Code: reads the prompt ONLY from the file named by its
// last argv element, ignores stdin entirely.
const FILE_READER = "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))";

function isolated(root: string): UserPathOptions {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

test('substitutePromptFile: replaces the placeholder, leaves everything else', () => {
  assert.deepEqual(
    substitutePromptFile(['muse', 'exec', '--prompt-file', '{prompt_file}', '--workspace', '.'], '/abs/p.md'),
    ['muse', 'exec', '--prompt-file', '/abs/p.md', '--workspace', '.'],
  );
});

test('dispatch: a file-reading driver receives the attested snapshot via {prompt_file}', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { musey: { provider: 'muse', id: 'musey-1', effort: 'xhigh' } },
    routes: {
      standalone: {
        muse: { command: ['node', '-e', FILE_READER, '{prompt_file}'], write_access: true },
        'current-host': { host: true },
      },
    },
    archetypes: { worker: {} },
    dials: { worker: 'musey' },
  }));
  const user = isolated(root);
  const result = runDispatch({ archetype: 'worker', prompt: 'FILE-DELIVERED', repoRoot: root, userPathOptions: user });
  assert.equal(result.stdout, 'FILE-DELIVERED');

  const rows = readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const request = rows.find((r) => r.event === 'dispatch_requested')!;
  const command = request.command as string[];
  // Evidence records the argv that actually spawned: an absolute snapshot path.
  const pathArg = command[command.length - 1]!;
  assert.ok(isAbsolute(pathArg), pathArg);
  assert.equal(readFileSync(pathArg, 'utf8'), 'FILE-DELIVERED');
});

test('drive: a file-reading actor gets the run-recorded prompt artifact', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'one-file.yaml'), [
    'kind: AgentPlaybook',
    'schema_version: "0.1"',
    'name: one-file',
    'description: Single step through a file-reading driver.',
    'when_to_use:',
    '  - prompt-file driver engine test',
    'roles:',
    '  builder:',
    '    purpose: Implement the task.',
    '    archetype: worker',
    'flow:',
    '  - id: implement',
    '    kind: actor_call',
    '    actor: builder',
    '    output: Notes',
    '    output_path: artifacts/notes.md',
    '    terminal_status: completed',
    '',
  ].join('\n'));
  const perHarness = {
    muse: { command: ['node', '-e', FILE_READER, '{prompt_file}'], write_access: true },
    'current-host': { host: true },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { musey: { provider: 'muse', id: 'musey-1', effort: 'xhigh' } },
    routes: { standalone: { ...perHarness }, codex: { ...perHarness }, claude: { ...perHarness }, grok: { ...perHarness } },
    archetypes: { worker: {} },
    dials: { worker: 'musey' },
  }));
  const { runId } = runNewRun({ playbook: 'one-file', task: 'file driver test', repoRoot: root });
  const result = runDrive({ run: runId, repoRoot: root, env: null });
  assert.equal(result.outcome, 'terminal', JSON.stringify(result));
  assert.equal(result.status, 'completed');
  // The artifact is the executor's stdout = the recorded prompt artifact bytes.
  const artifact = readFileSync(join(root, '.fadeno', 'runs', runId, 'artifacts', 'notes.md'), 'utf8');
  const promptFiles = readFileSync(join(root, '.fadeno', 'runs', runId, 'events.jsonl'), 'utf8');
  assert.ok(artifact.length > 0);
  assert.match(promptFiles, /artifacts\/prompts\//);
  assert.match(artifact, /file driver test/);
});

test('starter catalog: muse compiles via muse-code in every family with the {prompt_file} spelling', () => {
  const starter = readFileSync(join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml'), 'utf8');
  for (const harness of ['claude', 'codex', 'grok', 'standalone'] as const) {
    const profile = parseExecutorProfile(starter, 'starter.yaml', harness);
    const compiled = compileDialRef({ model: 'muse' }, profile);
    assert.equal(compiled.driver, 'muse-code', harness);
    assert.equal(compiled.effectiveEffort, 'xhigh', harness);
    const spec = compiled.spec;
    assert.equal(spec.adapter, 'command', harness);
    const command = (spec as { command: string[] }).command;
    // {prompt_file} survives compile untouched — it is a spawn-time value.
    assert.ok(command.includes('{prompt_file}'), harness);
    assert.ok(command.includes('muse-spark-1.2-contributor'), harness);
    assert.ok(command.includes('xhigh'), harness);
  }
});

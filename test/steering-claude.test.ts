import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runSteeringApplyClaude } from '../src/commands/steering.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

function seed(t: TestContext, dials: Record<string, string>): { root: string; user: UserPathOptions } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      luna: { provider: 'openai', id: 'gpt-5.6-luna', effort: 'xhigh' },
      opus: { provider: 'anthropic', id: 'opus', effort: 'xhigh' },
      fable: { provider: 'anthropic', id: 'fable', effort: 'high' },
    },
    routes: {
      claude: {
        'current-host': { host: true },
        anthropic: { driver: 'claude-cli', host: true, command: ['claude', '-p', '--model', '{model}'], write_access: false },
        openai: { driver: 'codex', command: ['codex', 'exec', '--model', '{model}', '-'], write_access: true },
      },
    },
    archetypes: { worker: {}, reviewer: {}, judge: {} },
    dials,
  }));
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'claude',
    },
  };
  return { root, user };
}

test('steering apply --claude: host slots materialize local subagents with model + effort frontmatter', (t) => {
  // Doug's example, mirrored: session on one model, worker dialed to another
  // in-session model — the materialized subagent pins the worker model's OWN
  // effort instead of inheriting the session's.
  const { root, user } = seed(t, { worker: 'fable', reviewer: 'luna', judge: 'current-host' });
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });

  const workerPath = join(root, '.claude', 'agents', 'worker.md');
  const workerBody = readFileSync(workerPath, 'utf8');
  assert.match(workerBody, /^---\n[\s\S]*?\nmodel: fable\neffort: high\n---\n/);
  assert.match(workerBody, /<!-- fadeno:managed version=/);
  assert.match(workerBody, /source=fable -->/);
  // The native role body survives the frontmatter injection.
  assert.match(workerBody, /implementer/);

  // Command slot: no agent file — the dispatch proxy carries it.
  assert.equal(existsSync(join(root, '.claude', 'agents', 'reviewer.md')), false);
  assert.equal(result.materialization.reviewer!.kind, 'command-broker');

  // Session baseline: no agent file — native plugin agents already fit.
  assert.equal(existsSync(join(root, '.claude', 'agents', 'judge.md')), false);
  assert.equal(result.materialization.judge!.kind, 'host');
  assert.equal(result.restartRequired, true);
});

test('steering apply --claude: re-dialing a host slot to command removes the stale managed agent', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  const workerPath = join(root, '.claude', 'agents', 'worker.md');
  assert.ok(existsSync(workerPath));

  // Re-dial worker onto the command lane (session dial wins over repo pin).
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'dials'), JSON.stringify({ dials: { worker: 'luna' } }));
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.equal(existsSync(workerPath), false);
  assert.deepEqual(result.removed, [workerPath]);

  // An unmanaged file of the same name is never touched.
  writeFileSync(workerPath, '---\nname: worker\n---\nhand-written\n');
  const again = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.equal(readFileSync(workerPath, 'utf8'), '---\nname: worker\n---\nhand-written\n');
  assert.deepEqual(again.removed, []);
});

test('steering apply --claude: an unmanaged existing file is preserved without --force at project scope', (t) => {
  const { root, user } = seed(t, { worker: 'fable' });
  const workerPath = join(root, '.claude', 'agents', 'worker.md');
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(workerPath, '---\nname: worker\n---\nprecious\n');
  const result = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user });
  assert.equal(readFileSync(workerPath, 'utf8'), '---\nname: worker\n---\nprecious\n');
  assert.ok(result.conflicts.includes(workerPath));

  const forced = runSteeringApplyClaude({ target: 'claude', repoRoot: root, userPathOptions: user, force: true });
  assert.match(readFileSync(workerPath, 'utf8'), /model: fable/);
  assert.equal(forced.conflicts.length, 0);
});

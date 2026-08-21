import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { tempRepo } from './helpers.ts';

/**
 * The fourth column of `fadeno dial` and the fifth of `fadeno models` say
 * `via` — the flag that sets them — and nothing on either line says `via`
 * meaning anything else.
 *
 * The column held the DRIVER all along while calling itself `harness`, which
 * in the same command's `--json` means the agent you are sitting inside. The
 * rename was blocked for a while by a second `via` on the same row: an
 * archetype with no dial of its own prints its lender, and that used to render
 * `(via worker)` — an archetype, not a driver, two cells from a column now
 * headed `via`. Renaming one without the other trades a wrong word for an
 * ambiguous one, so this test pins both halves together.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function seed(t: TestContext): { root: string; env: NodeJS.ProcessEnv } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'high' },
      luna: { provider: 'openai', id: 'gpt-luna', effort: 'high' },
    },
    routes: {
      standalone: {
        'current-host': { host: true },
        anthropic: { driver: 'claude', command: ['claude', '-p', '--model', '{model}'], write_access: true },
        openai: { driver: 'codex', command: ['codex', 'exec'], write_access: true },
      },
    },
    // `scout` has no dial of its own and borrows worker's.
    archetypes: { scout: { fallback: 'worker' }, worker: {} },
    dials: { worker: 'sonnet' },
  }));
  return {
    root,
    env: {
      ...process.env,
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
      HOME: join(root, 'home'),
    },
  };
}

test('the dial table heads its driver column `via`, and says `inherits` for the other kind', (t) => {
  const { root, env } = seed(t);
  const out = execFileSync(process.execPath, [CLI, 'dial'], { cwd: root, env, encoding: 'utf8' });
  const [header, ...rows] = out.trimEnd().split('\n');

  assert.match(header!, /\bvia\b/, 'the driver column names the flag that sets it');
  assert.doesNotMatch(header!, /\bharness\b/, 'and never calls a driver a harness');

  const worker = rows.find((r) => r.startsWith('worker'))!;
  assert.match(worker, /\bclaude\b/, "worker's dial rides the claude driver");

  const scout = rows.find((r) => r.startsWith('scout'))!;
  assert.match(scout, /\(inherits worker\)/, 'a borrowed dial names its lender as an inheritance');
  assert.doesNotMatch(scout, /\(via worker\)/, 'never as a `via`, which on this row means the driver');
  // Both facts on one line, unconfusable: the driver it rides and the
  // archetype it borrowed from.
  assert.match(scout, /claude.*\(inherits worker\)/);
});

test('the models table heads its home-driver column `via` too', (t) => {
  const { root, env } = seed(t);
  const out = execFileSync(process.execPath, [CLI, 'models'], { cwd: root, env, encoding: 'utf8' });
  const header = out.split('\n')[0]!;
  assert.match(header, /\bvia$/, 'last column, named for the flag');
  assert.doesNotMatch(header, /\bharness\b/);
  assert.match(out, /^sonnet\s+anthropic\s+sonnet\s+high\s+claude$/m);
});

test('`--via <driver>` round-trips into the column that reports it', (t) => {
  const { root, env } = seed(t);
  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'sonnet', '--via', 'codex', '--session'], {
    cwd: root, env, encoding: 'utf8',
  });
  const out = execFileSync(process.execPath, [CLI, 'dial'], { cwd: root, env, encoding: 'utf8' });
  const worker = out.split('\n').find((r) => r.startsWith('worker'))!;
  // The point of naming the column after the flag: what you typed is what you
  // read back. `harness` never was, which is why nobody could tell what to
  // pass to change it.
  assert.match(worker, /\bcodex\b/);
});

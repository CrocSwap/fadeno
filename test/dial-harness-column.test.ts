import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { tempRepo } from './helpers.ts';

/**
 * The fourth column of `fadeno dial` and the fifth of `fadeno models` say
 * `harness` — the flag that sets them — and nothing on either line says
 * `harness` meaning anything else.
 *
 * The word has moved twice. The column held the EXECUTOR all along while
 * calling itself `harness`, which in the same command's `--json` meant the
 * agent you were sitting inside — so it was renamed `via`, after the flag.
 * Catalog v4 renamed the OTHER one instead: the ambient agent is now `host`,
 * on its own key, and `harness` means the executor everywhere. So the column
 * gets its honest name back, and `--harness` is what sets it.
 *
 * The second `via` on the same row still has to stay distinct: an archetype
 * with no dial of its own prints its lender, and that renders
 * `(inherits worker)` — an archetype, not a harness. This test pins both
 * halves together, because renaming one without the other trades a wrong word
 * for an ambiguous one.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function seed(t: TestContext): { root: string; env: NodeJS.ProcessEnv } {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: {
      sonnet: { provider: 'anthropic', id: 'sonnet', effort: 'high' },
      luna: { provider: 'openai', id: 'gpt-luna', effort: 'high' },
    },
    harnesses: { claude: { provider: 'anthropic', command: ['claude', '-p', '--model', '{model}'] }, codex: { provider: 'openai', command: ['codex', 'exec'] } },
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

test('the dial table heads its executor column `harness`, and says `inherits` for the other kind', (t) => {
  const { root, env } = seed(t);
  const out = execFileSync(process.execPath, [CLI, 'dial'], { cwd: root, env, encoding: 'utf8' });
  const [header, ...rows] = out.trimEnd().split('\n');

  assert.match(header!, /\bharness\b/, 'the executor column names the flag that sets it');
  assert.doesNotMatch(header!, /\bvia\b/, 'and never uses the retired driver word');

  const worker = rows.find((r) => r.startsWith('worker'))!;
  assert.match(worker, /\bclaude\b/, "worker's dial runs on the claude harness");
  assert.match(worker, /\(home\)/, 'an unpinned harness is marked as the model\'s home');

  const scout = rows.find((r) => r.startsWith('scout'))!;
  assert.match(scout, /\(inherits worker\)/, 'a borrowed dial names its lender as an inheritance');
  assert.doesNotMatch(scout, /\(via worker\)/, 'never as a `via`, which is retired vocabulary');
  // Both facts on one line, unconfusable: the harness it runs on and the
  // archetype it borrowed from.
  assert.match(scout, /claude.*\(inherits worker\)/);
});

test('the models table heads its home-harness column `harness` too', (t) => {
  const { root, env } = seed(t);
  const out = execFileSync(process.execPath, [CLI, 'models'], { cwd: root, env, encoding: 'utf8' });
  const header = out.split('\n')[0]!;
  assert.match(header, /\bharness$/, 'last column, named for the flag');
  assert.doesNotMatch(header, /\bvia\b/);
  assert.match(out, /^sonnet\s+anthropic\s+sonnet\s+high\s+claude$/m);
});

test('`--harness <id>` round-trips into the column that reports it', (t) => {
  const { root, env } = seed(t);
  execFileSync(process.execPath, [CLI, 'dial', 'worker', 'sonnet', '--harness', 'codex', '--session'], {
    cwd: root, env, encoding: 'utf8',
  });
  const out = execFileSync(process.execPath, [CLI, 'dial'], { cwd: root, env, encoding: 'utf8' });
  const worker = out.split('\n').find((r) => r.startsWith('worker'))!;
  // The point of naming the column after the flag: what you typed is what you
  // read back. An explicit harness also loses the `(home)` mark, which is the
  // only thing distinguishing "I chose this" from "the provider did".
  assert.match(worker, /\bcodex\b/);
  assert.doesNotMatch(worker, /\(home\)/);
});

test('the retired `--via` names its replacement instead of answering "unknown option"', (t) => {
  const { root, env } = seed(t);
  const failed = (() => {
    try {
      execFileSync(process.execPath, [CLI, 'dial', 'worker', 'sonnet', '--via', 'codex', '--session'], {
        cwd: root, env, encoding: 'utf8', stdio: 'pipe',
      });
      return null;
    } catch (err) {
      return err as { status: number; stderr: string };
    }
  })();
  assert.ok(failed, '`--via` must not silently succeed');
  assert.equal(failed!.status, 1);
  assert.match(failed!.stderr, /`--via` was removed with catalog v4 — use `--harness <id>`/);
});

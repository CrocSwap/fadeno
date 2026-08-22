import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { KNOWN_CLI_COMMANDS } from '../src/cli.ts';
import { knownFlagsFor, unknownFlagsFor } from '../src/commands/completion.ts';
import { runDialShow } from '../src/commands/dial.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

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

function envFor(root: string): NodeJS.ProcessEnv {
  const paths = isolated(root);
  return { ...process.env, ...paths.env, HOME: paths.home! };
}

function seedV3(t: TestContext): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], },
        xai: { command: ['node', '-e', '0'], },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { },
      reviewer: { },
      judge: { },
    },
  }));
  return root;
}

function run(root: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: root, env: envFor(root), encoding: 'utf8', stdio: 'pipe' });
}

function runJson(root: string, args: string[]): any {
  return JSON.parse(run(root, [...args, '--json']));
}

function runFails(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd: root, env: envFor(root), encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('fadeno shadow attaches identically to fadeno dial shadow', (t) => {
  const rootA = seedV3(t);
  const rootB = seedV3(t);
  const attachedA = runJson(rootA, ['shadow', 'worker', 'sol']);
  const attachedB = runJson(rootB, ['dial', 'shadow', 'worker', 'sol']);
  // `path` is the only field expected to differ (it names the repo root).
  const { path: pathA, ...restA } = attachedA;
  const { path: pathB, ...restB } = attachedB;
  assert.deepEqual(restA, restB);
  assert.notEqual(pathA, pathB);

  const shownA = runDialShow({ repoRoot: rootA, userPathOptions: isolated(rootA) });
  const shownB = runDialShow({ repoRoot: rootB, userPathOptions: isolated(rootB) });
  assert.deepEqual(shownA.shadows, shownB.shadows);
  assert.deepEqual(shownA.shadow_attachments, shownB.shadow_attachments);
});

test('show mode lists only archetypes with an active shadow, in both spellings', (t) => {
  const root = seedV3(t);
  run(root, ['dial', 'shadow', 'worker', 'sol']);

  const dialShow = runJson(root, ['dial', 'shadow']);
  const topShow = runJson(root, ['shadow']);
  for (const result of [dialShow, topShow]) {
    assert.deepEqual(result.rows.map((r: any) => r.archetype), ['worker']);
    assert.ok(result.rows[0].shadow != null);
    // Stale-shadow plumbing survives filtering — the same fields the full
    // `dial` table carries, just fewer rows.
    assert.ok(Array.isArray(result.staleShadows));
    assert.ok('note' in result);
  }
  assert.deepEqual(dialShow.rows, topShow.rows);
});

test('show mode empty case prints the honest message, not a bare header', (t) => {
  const root = seedV3(t);
  const dialEmpty = run(root, ['dial', 'shadow']);
  const topEmpty = run(root, ['shadow']);
  for (const output of [dialEmpty, topEmpty]) {
    assert.match(output, /no active shadow attachments/);
    assert.match(output, /fadeno shadow <archetype> <model>/);
    // The bare table header must not appear when there is nothing to show.
    assert.doesNotMatch(output, /^archetype\s+model\s+effort/m);
  }
});

test('--json works in show mode', (t) => {
  const root = seedV3(t);
  run(root, ['dial', 'shadow', 'reviewer', 'grok', '--rate', '0.5']);
  const result = runJson(root, ['shadow']);
  assert.deepEqual(result.rows.map((r: any) => r.archetype), ['reviewer']);
  assert.equal(result.rows[0].shadow.rate, 0.5);
  assert.ok('dials' in result);
  assert.ok('shadows' in result);
  assert.ok('staleShadows' in result);
});

test('the one-positional form still errors, in both spellings', (t) => {
  const root = seedV3(t);
  const dialResult = runFails(root, ['dial', 'shadow', 'worker']);
  assert.notEqual(dialResult.status, 0);
  assert.match(dialResult.stderr, /Usage: fadeno dial shadow/);

  const topResult = runFails(root, ['shadow', 'worker']);
  assert.notEqual(topResult.status, 0);
  assert.match(topResult.stderr, /Usage: fadeno shadow/);
});

test('shadow is registered for completion and flag validation', () => {
  assert.ok(KNOWN_CLI_COMMANDS.has('shadow'));
  const shadowFlags = knownFlagsFor('shadow');
  const dialShadowFlags = knownFlagsFor('dial', 'shadow');
  assert.ok(shadowFlags);
  assert.ok(dialShadowFlags);
  for (const flag of ['--via', '--rate', '--json', '--help', '--version']) {
    assert.ok(shadowFlags!.has(flag), `shadow should accept ${flag}`);
    assert.ok(dialShadowFlags!.has(flag), `dial shadow should accept ${flag}`);
  }
  assert.deepEqual(unknownFlagsFor('shadow', undefined, ['via', 'rate', 'json']), []);
  assert.deepEqual(unknownFlagsFor('shadow', undefined, ['session']), ['--session']);
});

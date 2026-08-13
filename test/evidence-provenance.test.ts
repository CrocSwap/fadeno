import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import { pluginSurface, runDoctor } from '../src/commands/doctor.ts';
import { packageVersion } from '../src/lib/paths.ts';
import { tempRepo } from './helpers.ts';

/**
 * Evidence provenance. A 2026-08-13 dogfood read twelve ledger rows spanning a
 * version bump and could not answer which Fadeno wrote any of them: the union
 * of every key present held exactly one version-shaped field, `hook_version`,
 * which only the steering hook writes and which is therefore absent on all ten
 * kernel rows. `fadeno_version` existed in the binary the whole time and no
 * dispatch row ever carried it. These pin that every row names its writer, and
 * that a session can find out which build its subagents came from.
 */

function seedExecutor(t: TestContext, command: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      executors: { probe: { adapter: 'command', command, model: 'opus' } },
      loadouts: { main: { worker: 'probe' } },
      default_loadout: 'main',
    }),
  );
  return root;
}

function rows(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, '.fadeno', 'dispatches.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('every kernel evidence row names the build that wrote it', (t) => {
  const root = seedExecutor(t, ['node', '-e', "process.stdout.write('report')"]);
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null });

  const written = rows(root);
  // Both halves of the pair, not just the completion row: a requested row that
  // never completes is precisely the case where you most need to know which
  // build was running.
  assert.deepEqual(
    written.map((row) => row.event),
    ['dispatch_requested', 'dispatch_completed'],
  );
  for (const row of written) {
    assert.equal(row.fadeno_version, packageVersion(), `${String(row.event)} row is unstamped`);
  }
});

test('a refused dispatch is stamped too — a row that records nothing running still records what refused', (t) => {
  // Refusals are the rows most likely to be read long after the fact, and a
  // refusal predicate is exactly the kind of behaviour that changes between
  // builds. A row saying "this was forbidden" is worth much less if you cannot
  // tell which version's rules forbade it.
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      executors: {
        gated: {
          adapter: 'command',
          command: ['node', '-e', "process.stdout.write('x')"],
          model: 'm-g',
          eligibility: { worker: 'forbidden' },
        },
      },
      loadouts: { main: { worker: 'gated' } },
      default_loadout: 'main',
    }),
  );
  assert.throws(() => runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null }));

  const written = rows(root);
  assert.equal(written.length, 1);
  assert.equal(written[0]!.event, 'dispatch_refused');
  assert.equal(written[0]!.fadeno_version, packageVersion());
});

test('the stamp records the binary that ran, so one field spans plugin and CLI callers', (t) => {
  // The proxies invoke `$CLAUDE_PLUGIN_ROOT/bin/fadeno`; a director invokes a
  // bare `fadeno`. Both write to the same log, and the version each records is
  // its own — which is what makes a mixed-build session legible after the fact
  // rather than needing a separate "who called me" field.
  const root = seedExecutor(t, ['node', '-e', "process.stdout.write('x')"]);
  runDispatch({ archetype: 'worker', prompt: 'x', repoRoot: root, env: null });
  const completed = rows(root).find((row) => row.event === 'dispatch_completed');
  assert.equal(completed?.fadeno_version, packageVersion());
  assert.equal(typeof completed?.fadeno_version, 'string');
  assert.notEqual(completed?.fadeno_version, '');
});

test('pluginSurface finds the loaded plugin from PATH when CLAUDE_PLUGIN_ROOT is unset', (t) => {
  // The main loop only ever sees the surface as a `<root>/bin` PATH entry —
  // CLAUDE_PLUGIN_ROOT is set for hooks and agent shells, not for the director.
  const root = tempRepo(t);
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginRoot, 'bin'), { recursive: true });
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fadeno', version: '0.6.0-rc.20' }),
  );

  const found = pluginSurface({ PATH: ['/usr/bin', join(pluginRoot, 'bin')].join(delimiter) });
  assert.deepEqual(found, { root: pluginRoot, version: '0.6.0-rc.20' });
});

test('pluginSurface walks past another plugin whose bin is also on PATH', (t) => {
  const root = tempRepo(t);
  const other = join(root, 'rust-analyzer-lsp');
  const mine = join(root, 'plugin');
  for (const [dir, name] of [[other, 'rust-analyzer-lsp'], [mine, 'fadeno']] as const) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  // The other plugin's bin comes first, exactly as it does on a real PATH.
  const found = pluginSurface({ PATH: [join(other, 'bin'), join(mine, 'bin')].join(delimiter) });
  assert.equal(found?.root, mine);
});

test('doctor reports plugin-and-CLI drift instead of leaving it to be inferred from a stamp', (t) => {
  const root = tempRepo(t);
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fadeno', version: '0.6.0-rc.1' }),
  );

  const drifted = runDoctor({
    repoRoot: root,
    processEnv: { CLAUDE_PLUGIN_ROOT: pluginRoot, PATH: '' },
  });
  const finding = drifted.findings.find((item) => item.check === 'plugin-surface');
  assert.ok(finding, 'doctor said nothing about the plugin surface');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /plugin 0\.6\.0-rc\.1/);
  assert.match(finding.detail, new RegExp(`CLI is ${packageVersion().replace(/\./g, '\\.')}`));
  // Drift is a warning, never an error: a mismatched build still runs.
  assert.ok(drifted.ok);
});

test('doctor still flags the half it cannot read when the disk halves agree', (t) => {
  const root = tempRepo(t);
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fadeno', version: packageVersion() }),
  );

  const clean = runDoctor({ repoRoot: root, processEnv: { CLAUDE_PLUGIN_ROOT: pluginRoot, PATH: '' } });
  const finding = clean.findings.find((item) => item.check === 'plugin-surface');
  assert.equal(finding?.severity, 'ok');
  // The subagent registry was bound at session start and is unreadable from
  // here. Matching files on disk prove nothing about it, so the ok finding
  // still has to tell the caller how to check the half that cannot be checked.
  assert.match(finding?.remediation ?? '', /startup/);
  assert.match(finding?.remediation ?? '', /restart/i);
});

test('doctor stays quiet about a plugin surface that is not there', (t) => {
  const root = tempRepo(t);
  const bare = runDoctor({ repoRoot: root, processEnv: { PATH: '/usr/bin' } });
  assert.equal(bare.findings.find((item) => item.check === 'plugin-surface'), undefined);
});

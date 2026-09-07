import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PUBLIC_COMMAND_PATHS, runCompletionCandidates, TOP_LEVEL_COMMANDS } from '../src/commands/completion.ts';
import { HELP_PATHS, missingHelpPaths, renderFocusedHelp, renderGlobalHelp, resolveHelpPath } from '../src/lib/cli-help.ts';
import { packageVersion } from '../src/lib/paths.ts';
import { tempRepo } from './helpers.ts';

const SOURCE = join(import.meta.dirname, '..', 'src', 'cli.ts');
const BUNDLES = [
  join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno'),
  join(import.meta.dirname, '..', 'plugin-codex', 'bin', 'fadeno'),
  join(import.meta.dirname, '..', 'plugin-omp', 'bin', 'fadeno'),
];

function run(bin: string, args: string[], cwd = process.cwd()): string {
  return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

test('help coverage is derived exactly from completion public paths', () => {
  // No literal counts: the property is that help and completion agree on the
  // same public paths, whatever their number is this week.
  assert.ok(TOP_LEVEL_COMMANDS.length > 0);
  assert.deepEqual([...HELP_PATHS].sort(), [...PUBLIC_COMMAND_PATHS].sort());
  assert.deepEqual(missingHelpPaths(), []);
  for (const path of PUBLIC_COMMAND_PATHS) {
    assert.equal(resolveHelpPath(path.split(' ')), path);
    assert.match(renderFocusedHelp(path), new RegExp(`^fadeno ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — `));
    assert.doesNotMatch(renderFocusedHelp(path), /Command option/);
    assert.match(renderFocusedHelp(path), /--help\s+Show this command help/);
    assert.match(renderFocusedHelp(path), /--version\s+Show Fadeno version/);
  }
});

test('help routing uses the longest public path and preserves aliases', () => {
  assert.equal(resolveHelpPath(['dial', 'shadow', 'worker']), 'dial shadow');
  assert.equal(resolveHelpPath(['model', 'add', 'moonshot']), 'model add');
  assert.equal(resolveHelpPath(['models', 'add', 'moonshot']), 'models add');
  assert.equal(resolveHelpPath(['shadow', 'worker']), 'shadow');
  assert.equal(resolveHelpPath(['no-such-command']), null);
  assert.match(renderFocusedHelp('model add'), /alias for `fadeno models add`/i);
  assert.match(renderFocusedHelp('dial shadow'), /`fadeno shadow` is the top-level alias/);
});

test('focused help uses semantic options and preserves safety-critical modes', () => {
  const plugin = renderFocusedHelp('plugin');
  assert.doesNotMatch(plugin, /\n  --grok|\n  --opencode/);
  assert.match(plugin, /Claude Code is the default plugin/);
  assert.doesNotMatch(renderFocusedHelp('dial'), /\n  --rate|\n  --archetype/);

  assert.match(renderFocusedHelp('clean'), /Remove ignored runtime state/);
  assert.match(renderFocusedHelp('dispatch'), /--archetype.*--model|--model.*--archetype/s);
  assert.match(renderFocusedHelp('dispatch'), /--shadow <ref>/);
  assert.match(renderFocusedHelp('dispatch'), /isolate by default.*merge.*--isolate.*withholds/s);
  assert.match(renderFocusedHelp('dispatch'), /required unless `--model` is\s+supplied; both are accepted/);
  assert.match(renderFocusedHelp('dispatch'), /--ignored-output <kept\|discardable>/);
  assert.match(renderFocusedHelp('dispatches'), /--output <id\|last\|tag:<tag>>/);
  assert.match(renderFocusedHelp('dispatches'), /--cancel <id\|tag:<tag>>/);
  assert.match(renderFocusedHelp('dispatches'), /--merge <id\|tag:<tag>>/);
  assert.match(renderFocusedHelp('models add'), /direct OpenCode.*OpenCode\/OpenRouter/s);
  assert.match(renderFocusedHelp('model'), /--harness <id>/);
  for (const path of ['models add', 'model add', 'dial clear-shadow']) {
    assert.match(renderFocusedHelp(path), /--json\s+Emit structured JSON output/);
  }
  assert.doesNotMatch(renderFocusedHelp('completion'), /private protocol/);
});

test('dial help discovers every public form and focused output stays terminal-width friendly', () => {
  const dial = renderFocusedHelp('dial');
  for (const fragment of ['dial clear', 'dial shadow', 'dial clear-shadow', 'dial resolve', '<a> <b>...', '<a>+<b>[+...]', '<a>,<b>[,...]']) {
    assert.match(dial, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const path of HELP_PATHS) {
    for (const line of renderFocusedHelp(path).split('\n')) {
      assert.ok(line.length <= 100, `${path} has ${line.length}-column help: ${line}`);
    }
  }
});

test('global help names every public top-level spelling', () => {
  const global = renderGlobalHelp();
  for (const command of TOP_LEVEL_COMMANDS) {
    const pattern = command === 'model' ? /models \(model\)/ : new RegExp(`\\b${command.replace('-', '\\-')}\\b`);
    assert.match(global, pattern, `global help omitted ${command}`);
  }
});

test('global help stays concise and focused help does not run command bodies', (t) => {
  const global = renderGlobalHelp();
  assert.ok(global.split('\n').length <= 40, `global help grew to ${global.split('\n').length} lines`);
  assert.match(global, /fadeno <command> \[options\]/);
  assert.match(global, /-h, --help/);
  assert.match(global, /-v, --version/);
  assert.doesNotMatch(global, /--timeout/);

  const root = tempRepo(t);
  const output = run(process.execPath, [SOURCE, 'dispatch', '--help'], root);
  assert.match(output, /^fadeno dispatch — /);
  assert.equal(existsSync(join(root, '.fadeno')), false, 'help must short-circuit before command/preflight work');
});

test('source and every bundled CLI render representative focused and global help', (t) => {
  const root = tempRepo(t);
  for (const bin of [process.execPath, ...BUNDLES]) {
    const prefix = bin === process.execPath ? [SOURCE] : [];
    const global = run(bin, [...prefix, '--help'], root);
    assert.match(global, /Get started/);
    const nested = run(bin, [...prefix, 'dial', 'shadow', '--help'], root);
    assert.match(nested, /fadeno dial shadow/);
    const alias = run(bin, [...prefix, 'model', 'add', '--help'], root);
    assert.match(alias, /alias for `fadeno models add`/i);
  }
});

/**
 * The bundled binaries carry the whole CLI, and `build:bin` is the only thing
 * that refreshes them — a source-only change ships plugin users a binary that
 * does not have the command at all. `models remove` and `models verify` went
 * out exactly that way: `plugin/bin/fadeno models verify --help` still printed
 * the old generic models page while the suite was green, because the only
 * check on the bundle compared its VERSION, which a feature commit never
 * changes.
 *
 * Derived from the source's own registry rather than a literal list, so the
 * next command added is covered without anyone remembering to add it here.
 */
test('every bundled CLI knows the same commands and subcommands as the source', (t) => {
  const root = tempRepo(t);
  const parents = [...new Set(PUBLIC_COMMAND_PATHS.filter((path) => path.includes(' ')).map((path) => path.split(' ')[0]!))];
  const queries: string[][] = [['fadeno', ''], ...parents.map((parent) => ['fadeno', parent, ''])];
  for (const words of queries) {
    const cword = words.length - 1;
    const expected = runCompletionCandidates({ cwd: root, repoRoot: root, cword, words });
    assert.ok(expected.length > 0, `no source candidates for ${words.join(' ')}`);
    for (const bin of BUNDLES) {
      const printed = run(bin, ['completion', 'candidates', String(cword), '--', ...words], root)
        .split('\n')
        .filter((line) => line.length > 0);
      assert.deepEqual(printed, expected, `${bin} is stale for \`${words.join(' ')}\` — run the three plugin builds`);
    }
  }
});

test('every bundled CLI dispatches the model-registry upkeep commands', (t) => {
  const root = tempRepo(t);
  for (const bin of [process.execPath, ...BUNDLES]) {
    const prefix = bin === process.execPath ? [SOURCE] : [];
    assert.match(run(bin, [...prefix, 'models', 'verify', '--help'], root), /^fadeno models verify — /);
    assert.match(run(bin, [...prefix, 'models', 'remove', '--help'], root), /^fadeno models remove — /);
    assert.match(run(bin, [...prefix, 'model', 'verify', '--help'], root), /alias for `fadeno models verify`/i);
    assert.match(run(bin, [...prefix, 'model', 'remove', '--help'], root), /alias for `fadeno models remove`/i);
  }
});

test('help keeps version precedence and unknown-command global fallback', (t) => {
  const root = tempRepo(t);
  const version = run(process.execPath, [SOURCE, 'unknown-command', '--help', '--version'], root).trim();
  assert.equal(version, packageVersion());
  const unknown = run(process.execPath, [SOURCE, 'unknown-command', '--help'], root);
  assert.match(unknown, /Get started/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PUBLIC_COMMAND_PATHS, TOP_LEVEL_COMMANDS } from '../src/commands/completion.ts';
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
  assert.equal(TOP_LEVEL_COMMANDS.length, 45);
  assert.equal(PUBLIC_COMMAND_PATHS.length, 55);
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
  const toolRun = renderFocusedHelp('tool-run');
  assert.doesNotMatch(toolRun, /\n  --output/);
  assert.match(toolRun, /no `--output` override/);

  const plugin = renderFocusedHelp('plugin');
  assert.doesNotMatch(plugin, /\n  --grok|\n  --opencode/);
  assert.match(plugin, /Claude Code is the default plugin/);
  assert.doesNotMatch(renderFocusedHelp('steering apply'), /\n  --grok/);
  assert.doesNotMatch(renderFocusedHelp('vendor'), /\n  --with-hooks/);
  assert.doesNotMatch(renderFocusedHelp('dial'), /\n  --rate|\n  --archetype/);

  assert.match(renderFocusedHelp('clean'), /Remove ignored runtime state/);
  assert.match(renderFocusedHelp('unvendor'), /Remove lock-owned vendored files/);
  assert.match(renderFocusedHelp('uninstall'), /confirms removal/);
  assert.match(renderFocusedHelp('dispatch'), /--archetype.*--model|--model.*--archetype/s);
  assert.match(renderFocusedHelp('dispatch'), /--shadow <ref>/);
  assert.match(renderFocusedHelp('dispatch'), /isolate by default.*merge.*--isolate.*withholds/s);
  assert.match(renderFocusedHelp('dispatch'), /required unless `--model` is\s+supplied; both are accepted/);
  assert.match(renderFocusedHelp('dispatch'), /--ignored-output <kept\|discardable>/);
  assert.match(renderFocusedHelp('dispatches'), /--output <id\|last\|tag:<tag>>/);
  assert.match(renderFocusedHelp('dispatches'), /--cancel <id\|tag:<tag>>/);
  assert.match(renderFocusedHelp('dispatches'), /--merge <id\|tag:<tag>>/);
  assert.match(renderFocusedHelp('dispatch-complete'), /--output <path\|->/);
  assert.match(renderFocusedHelp('prompt'), /--actor <role>/);
  assert.match(renderFocusedHelp('bakeoff'), /--record --comparison <file> --adversarial <file>/);
  assert.match(renderFocusedHelp('bakeoff'), /`--measure-only`.*`--prepare`.*`--record`/s);
  assert.match(renderFocusedHelp('models add'), /direct OpenCode.*OpenCode\/OpenRouter/s);
  assert.match(renderFocusedHelp('model'), /--driver <alias>/);
  for (const path of ['models add', 'model add', 'dial clear-shadow']) {
    assert.match(renderFocusedHelp(path), /--json\s+Emit structured JSON output/);
  }
  assert.match(renderFocusedHelp('uninstall'), /Required with --purge-user-data/);
  assert.match(renderFocusedHelp('unvendor'), /remove modified lock-owned files/);
  assert.match(renderFocusedHelp('steering apply'), /Overwrite managed steering files/);
  assert.doesNotMatch(renderFocusedHelp('completion'), /private protocol/);
  assert.match(renderFocusedHelp('prompt'), /--format <text\|json>/);
  assert.match(renderFocusedHelp('dispatch-progress'), /--source <agent\|harness\|director>/);
  assert.match(renderFocusedHelp('dispatch-start'), /--agent-id <host-agent-id>/);
  assert.match(renderFocusedHelp('dispatch-progress'), /--file <status\.json>/);
  assert.match(renderFocusedHelp('uninstall'), /--purge-user-data --force/);
  assert.match(renderFocusedHelp('init'), /Deprecated compatibility alias; steering is already default/);
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
  const output = run(process.execPath, [SOURCE, 'drive', '--help'], root);
  assert.match(output, /fadeno drive — Advance a run/);
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

test('help keeps version precedence and unknown-command global fallback', (t) => {
  const root = tempRepo(t);
  const version = run(process.execPath, [SOURCE, 'unknown-command', '--help', '--version'], root).trim();
  assert.equal(version, packageVersion());
  const unknown = run(process.execPath, [SOURCE, 'unknown-command', '--help'], root);
  assert.match(unknown, /Get started/);
});

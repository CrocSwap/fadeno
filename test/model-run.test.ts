import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { ModelRunError, runModelRun, type ModelProcessRequest } from '../src/commands/model-run.ts';
import { catalogV4Doc, gitRepo } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

const IO_SCRIPT = [
  "const fs = require('node:fs');",
  "let chunks = [];",
  "process.stdin.on('data', chunk => chunks.push(chunk));",
  "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd(), prompt: Buffer.concat(chunks).toString('utf8') })); process.stderr.write('fake stderr\\n'); process.exit(7); });",
].join(' ');

const FILE_SCRIPT = [
  "const fs = require('node:fs');",
  "const prompt = fs.readFileSync(process.argv[1], 'utf8');",
  "process.stdout.write(JSON.stringify({ prompt, cwd: process.cwd() }));",
].join(' ');

function isolated(root: string) {
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
    },
  };
}

function seed(root: string, command: string[], extra: Record<string, unknown> = {}): ReturnType<typeof isolated> {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(catalogV4Doc({
    models: { sol: { provider: 'fake', id: 'delivered-model', effort: 'default' } },
    harnesses: {
      fake: {
        provider: 'fake',
        command,
        effort_encoding: 'flag',
        ...extra,
      },
    },
    unregistered_model_harness: 'fake',
  })));
  return isolated(root);
}

function cli(root: string, args: string[], input: string): { status: number | null; stdout: string; stderr: string } {
  const user = isolated(root);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    input,
    env: { ...process.env, ...user.env, HOME: user.home },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('model run resolves the registered alias, delivered id, effort, and stdin in scratch', async (t) => {
  const root = gitRepo(t);
  const user = seed(root, ['fake-runner', '--model', '{model}', '--effort', '{reasoning_effort}']);
  let request: ModelProcessRequest | null = null;
  const result = await runModelRun({
    repoRoot: root,
    userPathOptions: user,
    model: 'sol@high on fake',
    prompt: 'Reply exactly: Hello, World!',
    runProcess: (next) => {
      request = next;
      writeFileSync(join(next.cwd, 'smoke-test-write.txt'), 'only in scratch');
      return { exitCode: 0, signal: null, stdout: 'answer\n', stderr: 'notice\n' };
    },
  });

  assert.ok(request);
  assert.deepEqual(request!.argv, ['fake-runner', '--model', 'delivered-model', '--effort', 'high']);
  assert.equal(request!.stdin!.toString('utf8'), 'Reply exactly: Hello, World!');
  assert.equal(request!.promptFile, null);
  assert.notEqual(request!.cwd, root);
  assert.equal(existsSync(request!.cwd), false, 'scratch is removed after the process returns');
  assert.deepEqual(result.command, request!.argv);
  assert.equal(result.model, 'sol');
  assert.equal(result.modelId, 'delivered-model');
  assert.equal(result.effort, 'high');
  assert.equal(result.harness, 'fake');
  assert.equal(result.stdout.toString(), 'answer\n');
  assert.equal(result.stderr.toString(), 'notice\n');
  assert.equal(result.exitCode, 0);

  assert.equal(existsSync(join(root, '.fadeno', 'dispatches.jsonl')), false, 'model run does not write a ledger');
  assert.equal(existsSync(join(root, '.fadeno', 'local')), false, 'model run does not create Fadeno scratch');
  assert.equal(spawnSync('git', ['branch', '--list', 'fadeno/*'], { cwd: root, encoding: 'utf8' }).stdout.trim(), '');
});

test('model run supports model-suffix effort compilation and a prompt_file harness', async (t) => {
  const root = gitRepo(t);
  const user = seed(root, [process.execPath, '-e', FILE_SCRIPT, '{prompt_file}', '{model}', '{reasoning_effort}'], { effort_encoding: 'model-suffix' });
  const promptPath = join(root, 'prompt.txt');
  writeFileSync(promptPath, 'line one\nline two\n');
  let request: ModelProcessRequest | null = null;
  const result = await runModelRun({
    repoRoot: root,
    userPathOptions: user,
    model: 'fake/delivered-model@high on fake',
    promptFile: promptPath,
    runProcess: (next) => {
      request = next;
      assert.equal(next.stdin, null);
      assert.equal(readFileSync(next.promptFile!, 'utf8'), 'line one\nline two\n');
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ prompt: readFileSync(next.promptFile!, 'utf8') }),
        stderr: Buffer.from(''),
      };
    },
  });
  assert.ok(request);
  assert.equal(request!.argv[0], process.execPath);
  assert.equal(request!.argv[3], request!.promptFile);
  assert.equal(request!.argv[4], 'delivered-model-high');
  assert.equal(request!.argv[5], 'high');
  assert.ok(request!.promptFile);
  assert.equal(existsSync(request!.promptFile!), false, 'prompt scratch is removed after success');
  assert.match(result.stdout.toString(), /line one/);
});

test('model run cleans scratch after a harness failure and preserves streams/status', async (t) => {
  const root = gitRepo(t);
  const user = seed(root, ['fake-runner', '{model}']);
  let scratch: string | null = null;
  const result = await runModelRun({
    repoRoot: root,
    userPathOptions: user,
    model: 'sol',
    prompt: 'prompt',
    runProcess: (request) => {
      scratch = request.cwd;
      return { exitCode: 23, signal: null, stdout: Buffer.from('stdout bytes'), stderr: Buffer.from('stderr bytes') };
    },
  });
  assert.equal(result.exitCode, 23);
  assert.equal(result.stdout.toString(), 'stdout bytes');
  assert.equal(result.stderr.toString(), 'stderr bytes');
  assert.equal(existsSync(scratch!), false);

  let failedScratch: string | null = null;
  await assert.rejects(() => runModelRun({
    repoRoot: root,
    userPathOptions: user,
    model: 'sol',
    prompt: 'prompt',
    runProcess: (request) => {
      failedScratch = request.cwd;
      throw new Error('fake launch failure');
    },
  }), /fake launch failure/);
  assert.equal(existsSync(failedScratch!), false, 'scratch is removed after a launch failure');
});

test('model run refuses unknown, host-only, unreadable, empty, conflicting, and invalid inputs before launch', async (t) => {
  const root = gitRepo(t);
  const user = seed(root, ['never-run']);
  let launches = 0;
  const fake = () => {
    launches += 1;
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  await assert.rejects(() => runModelRun({ repoRoot: root, userPathOptions: user, model: 'missing', prompt: 'x', runProcess: fake }), ModelRunError);
  assert.equal(launches, 0);
  await assert.rejects(() => runModelRun({ repoRoot: root, userPathOptions: user, model: 'sol', prompt: '   ', runProcess: fake }), /prompt is empty/);
  await assert.rejects(() => runModelRun({ repoRoot: root, userPathOptions: user, model: 'sol', prompt: 'x', promptFile: join(root, 'nope'), runProcess: fake }), /conflicting prompt inputs/);
  await assert.rejects(() => runModelRun({ repoRoot: root, userPathOptions: user, model: 'sol', promptFile: join(root, '.fadeno'), runProcess: fake }), /could not read file/);
  assert.equal(launches, 0);

  const hostRoot = gitRepo(t);
  const hostUser = seed(hostRoot, [], { command: null, host: { effort_channel: 'none' } });
  await assert.rejects(() => runModelRun({ repoRoot: hostRoot, userPathOptions: hostUser, model: 'sol', prompt: 'x', runProcess: fake }), /host-only\/non-command/);
  assert.equal(launches, 0);

  const invalidRoot = gitRepo(t);
  const invalidUser = seed(invalidRoot, ['']);
  await assert.rejects(() => runModelRun({ repoRoot: invalidRoot, userPathOptions: invalidUser, model: 'sol', prompt: 'x', runProcess: fake }), /command must be a non-empty string array/);
  assert.equal(launches, 0);
});

test('model and models run spellings relay stdout/stderr and the harness exit status end to end', (t) => {
  const root = gitRepo(t);
  seed(root, [process.execPath, '-e', IO_SCRIPT, '--', '--model', '{model}', '--effort', '{reasoning_effort}']);
  const first = cli(root, ['model', 'run', 'sol', 'Reply exactly: Hello, World!'], '');
  assert.equal(first.status, 7, `${first.stderr}\n${first.stdout}`);
  assert.equal(first.stderr, 'fake stderr\n');
  const parsedFirst = JSON.parse(first.stdout) as { args: string[]; cwd: string; prompt: string };
  assert.deepEqual(parsedFirst.args, ['--model', 'delivered-model', '--effort', 'default']);
  assert.equal(parsedFirst.prompt, 'Reply exactly: Hello, World!');
  assert.notEqual(parsedFirst.cwd, root);

  const second = cli(root, ['models', 'run', 'sol'], 'Reply exactly: Hello, World!');
  assert.equal(second.status, 7);
  assert.equal(second.stderr, 'fake stderr\n');
  const parsedSecond = JSON.parse(second.stdout) as { prompt: string };
  assert.equal(parsedSecond.prompt, 'Reply exactly: Hello, World!');
  const joined = cli(root, ['models', 'run', 'sol', 'one', 'two'], '');
  assert.equal(joined.status, 7);
  assert.equal((JSON.parse(joined.stdout) as { prompt: string }).prompt, 'one two');
  const stdinConflict = cli(root, ['model', 'run', 'sol', 'positional'], 'stdin');
  assert.equal(stdinConflict.status, 1);
  assert.match(stdinConflict.stderr, /conflicting prompt inputs/);
});

test('model run CLI accepts --prompt-file and rejects positional/file conflicts', (t) => {
  const root = gitRepo(t);
  seed(root, [process.execPath, '-e', FILE_SCRIPT, '--', '{prompt_file}']);
  const promptPath = join(root, 'prompt.txt');
  writeFileSync(promptPath, 'from file\n');
  const file = cli(root, ['model', 'run', 'sol', '--prompt-file', promptPath], '');
  assert.equal(file.status, 0, `${file.stderr}\n${file.stdout}`);
  assert.equal(JSON.parse(file.stdout).prompt, 'from file\n');
  const conflict = cli(root, ['models', 'run', 'sol', 'positional', '--prompt-file', promptPath], '');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /conflicting prompt inputs/);
});

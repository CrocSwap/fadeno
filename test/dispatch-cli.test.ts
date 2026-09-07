import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { CONTRACT_HEADER } from '../src/lib/contracts.ts';
import { LEDGER_FILE, readDispatches } from '../src/lib/ledger.ts';
import { git, gitRepo } from './helpers.ts';

/**
 * The dispatch family through the real CLI, the way a proxy or a hook calls
 * it: argv in, stdout/stderr/exit code out, rows on disk.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const ECHO: string[] = [process.execPath, '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('REPORT:'+d))"];
const EXIT_3: string[] = [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('bad');process.exit(3)})"];

function repo(t: TestContext, cmd: string[] = ECHO): string {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { echo: { provider: 'openai', id: 'echo-model', effort: 'high' } },
    harnesses: { codex: { provider: 'openai', command: cmd } },
    archetypes: { worker: {}, reviewer: {} },
    dials: { worker: 'echo' },
  }));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  return root;
}

function cli(root: string, args: string[], stdin = ''): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, FADENO_HARNESS: 'standalone' };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', input: stdin, env });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

test('dispatch: the report is stdout verbatim, the exit code is the executor\'s, the ledger holds opened and stopped, and close records the decision', (t) => {
  const root = repo(t);
  const run = cli(root, ['dispatch', '--archetype', 'worker', '--name', 'Fix Login'], 'Fix the login bug.\n');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith('REPORT:Fix the login bug.\n\n' + CONTRACT_HEADER), run.stdout.slice(0, 200));
  assert.match(run.stderr, /dispatch fix-login \([0-9a-f-]{36}\) → echo on codex; process group \d+; fadeno\/fix-login/);
  assert.match(run.stderr, /stopped: exit 0; branch fadeno\/fix-login\. Close it: fadeno dispatch-close fix-login --merged\|--kept\|--discarded\|--failed/);
  const { records } = readDispatches(root);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, 'stopped');
  assert.equal(records[0]!.opened?.name, 'fix-login');
  assert.equal(records[0]!.opened?.lane, 'command');
  assert.ok(records[0]!.opened?.process_group);

  const list = cli(root, ['dispatches']);
  assert.match(list.stdout, /fix-login\s+worker\s+command\s+echo@high on codex\s+fadeno\/fix-login\s+stopped — awaiting close/);
  assert.match(list.stdout, /1 unclosed of 1 recorded/);

  const output = cli(root, ['dispatches', '--output', 'fix-login']);
  assert.equal(output.status, 0);
  assert.ok(output.stdout.startsWith('REPORT:Fix the login bug.'));

  const show = cli(root, ['dispatches', 'fix-login']);
  assert.match(show.stdout, /^fix-login \([0-9a-f-]{36}\)/);
  assert.match(show.stdout, /worktree:  .*\.fadeno\/local\/worktrees\/fix-login on fadeno\/fix-login/);
  assert.match(show.stdout, /--- final message ---/);

  const close = cli(root, ['dispatch-close', 'fix-login', '--merged', '--note', 'landed']);
  assert.equal(close.status, 0, close.stderr);
  assert.match(close.stdout, /fix-login closed: merged; branch fadeno\/fix-login kept, worktree .* stays until fadeno clean/);
  assert.equal(cli(root, ['dispatch-close', 'fix-login', '--merged']).stdout.includes('(already recorded)'), true);
  const conflict = cli(root, ['dispatch-close', 'fix-login', '--discarded']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /already closed as "merged"/);
  const twoVerbs = cli(root, ['dispatch-close', 'fix-login', '--merged', '--kept']);
  assert.equal(twoVerbs.status, 1);
  assert.match(twoVerbs.stderr, /exactly one/i);
  assert.match(cli(root, ['dispatches']).stdout, /No unclosed dispatches \(1 recorded; --all shows them\)/);
  assert.match(cli(root, ['dispatches', '--all']).stdout, /closed: merged/);
});

test('dispatch: a failing executor propagates its exit code and names its stderr; a silent one is exit 1 with NO OUTPUT', (t) => {
  const failing = repo(t, EXIT_3);
  const run = cli(failing, ['dispatch', '--archetype', 'worker'], 'x');
  assert.equal(run.status, 3);
  assert.match(run.stderr, /stopped: exit 3; branch fadeno\/worker-[0-9a-f]{4}.*; stderr at \.fadeno\/local\/outputs\/[0-9a-f-]{36}\.err/);
  const silent = repo(t, [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"]);
  const quiet = cli(silent, ['dispatch', '--archetype', 'worker'], 'x');
  assert.equal(quiet.status, 1);
  assert.match(quiet.stderr, /NO OUTPUT — the executor wrote nothing/);
});

test('dispatch: an empty prompt, a missing prompt file, an unknown archetype shape, and nothing to invoke are all refused before anything runs', (t) => {
  const root = repo(t);
  assert.match(cli(root, ['dispatch', '--archetype', 'worker'], '   ').stderr, /empty prompt/);
  assert.match(cli(root, ['dispatch', '--archetype', 'worker', '--prompt-file', 'nope.md']).stderr, /no such file/);
  assert.match(cli(root, ['dispatch', '--archetype', 'Not-Valid'], 'x').stderr, /not a bare lowercase identifier/);
  assert.match(cli(root, ['dispatch', '--archetype', 'reviewer'], 'x').stderr, /nothing to invoke/);
  assert.match(cli(root, ['dispatch'], 'x').stderr, /pass --archetype/);
  assert.ok(!existsSync(join(root, LEDGER_FILE)), 'no row for a dispatch that never happened');
});

test('dispatch-open and dispatch-stop: the host lane\'s two halves through the CLI', (t) => {
  const root = repo(t);
  const opened = cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'in-host', '--session-id', 's-1', '--json'], 'Do the host thing.');
  assert.equal(opened.status, 0, opened.stderr);
  const json = JSON.parse(opened.stdout) as { ok: boolean; id: string; name: string; cwd: string; prompt: string; nag: string; lane: string; workspace: { branch: string } };
  assert.equal(json.ok, true);
  assert.equal(json.name, 'in-host');
  assert.equal(json.lane, 'host');
  assert.equal(json.workspace.branch, 'fadeno/in-host');
  assert.ok(json.prompt.startsWith('Do the host thing.\n\n' + CONTRACT_HEADER));
  assert.equal(json.nag, 'No unclosed dispatches in this repository.');
  assert.ok(existsSync(join(json.cwd, 'base.txt')));
  const row = readDispatches(root).records[0]!;
  assert.equal(row.opened?.session, 's-1');
  assert.equal(row.opened?.lane, 'host');
  assert.equal(row.opened?.process_group, undefined);

  // From a bare shell nothing is a host candidate, so the host lane is asked for by name.
  const second = cli(root, ['dispatch-open', '--archetype', 'reviewer', '--lane', 'host', '--json'], 'Review it.');
  assert.equal(second.status, 0, second.stderr);
  assert.match((JSON.parse(second.stdout) as { nag: string }).nag, /## Unclosed dispatches \(1 of 5 allowed\)/);

  writeFileSync(join(json.cwd, 'new.txt'), 'x\n');
  const stopped = cli(root, ['dispatch-stop', 'in-host', '--agent-cwd', root], 'All done; new.txt added.');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /in-host stopped; tree 1 dirty path\(s\); WARNING: the agent worked in .*, not its assigned worktree\. Close it:/);
  const after = readDispatches(root).records[0]!;
  assert.equal(after.state, 'stopped');
  assert.equal(after.stopped?.final_message, 'All done; new.txt added.');
  assert.deepEqual(after.stopped?.dirty, { paths: ['new.txt'], truncated: false });
  assert.match(cli(root, ['dispatch-stop', 'in-host'], 'again').stdout, /already recorded/);
  assert.match(cli(root, ['cancel', 'in-host']).stderr, /harness's to stop/);
});

test('dispatch-open refuses at the limit with exit 3 on both lanes, and --json carries the refusal', (t) => {
  const root = repo(t);
  for (let i = 0; i < 5; i += 1) assert.equal(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host'], `job ${i}`).status, 0);
  const refused = cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--json'], 'six');
  assert.equal(refused.status, 3);
  assert.match((JSON.parse(refused.stdout) as { refused: string }).refused, /5 dispatches are unclosed and the limit is 5/);
  // The relay is refused too: a proxy sent to be refused one process later would waste a turn.
  const relayRefused = cli(root, ['dispatch-open', '--archetype', 'worker', '--json'], 'seven');
  assert.equal(relayRefused.status, 3);
  assert.equal(readDispatches(root).records.length, 5);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'relay')), 'nothing is staged for a refused relay');
});

test('worktrees and clean: a closed clean worktree is reclaimed, an open or dirty one is kept and the reason printed', (t) => {
  const root = repo(t);
  cli(root, ['dispatch', '--archetype', 'worker', '--name', 'done'], 'x');
  cli(root, ['dispatch', '--archetype', 'worker', '--name', 'busy'], 'y');
  const busyDir = join(root, '.fadeno', 'local', 'worktrees', 'busy');
  writeFileSync(join(busyDir, 'wip.txt'), 'unfinished\n');
  cli(root, ['dispatch-close', 'done', '--merged']);
  const wt = cli(root, ['worktrees']);
  assert.match(wt.stdout, /\.fadeno\/local\/worktrees\/done  fadeno\/done  clean; 0 unmerged commit\(s\)  — done \(closed\)/);
  assert.match(wt.stdout, /\.fadeno\/local\/worktrees\/busy  fadeno\/busy  1 uncommitted; 0 unmerged commit\(s\)  — busy \(stopped\)/);
  const preview = cli(root, ['clean']);
  assert.match(preview.stdout, /would remove worktree \.fadeno\/local\/worktrees\/done \(branch kept\)/);
  assert.match(preview.stdout, /kept \.fadeno\/local\/worktrees\/busy: dispatch busy is stopped; close it first/);
  assert.match(preview.stdout, /Re-run with --force/);
  assert.ok(existsSync(join(root, '.fadeno', 'local', 'worktrees', 'done')));
  const forced = cli(root, ['clean', '--force']);
  assert.match(forced.stdout, /removed worktree \.fadeno\/local\/worktrees\/done/);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'worktrees', 'done')));
  assert.ok(existsSync(join(busyDir, 'wip.txt')), 'the dirty tree survives');
  assert.ok(existsSync(join(root, '.fadeno', 'prompts')), 'prompts are never touched');
  assert.ok(existsSync(join(root, LEDGER_FILE)), 'the ledger is never touched');
  cli(root, ['dispatch-close', 'busy', '--failed']);
  assert.match(cli(root, ['clean', '--force']).stdout, /kept \.fadeno\/local\/worktrees\/busy: 1 uncommitted path\(s\)/);
});

test('context prints the vocabulary with live routing and the nag', (t) => {
  const root = repo(t);
  cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'pending'], 'x');
  const ctx = cli(root, ['context']);
  assert.equal(ctx.status, 0, ctx.stderr);
  assert.match(ctx.stdout, /- \*\*worker\*\* — Implements .* _\(routes to echo@high; repo dial\)_/);
  assert.match(ctx.stdout, /- \*\*reviewer\*\* — Reviews .* _\(routes to this session's own model; no dial\)_/);
  assert.match(ctx.stdout, /## Unclosed dispatches \(1 of 5 allowed\)/);
  assert.match(ctx.stdout, /`pending`/);
  const json = JSON.parse(cli(root, ['context', '--json']).stdout) as { archetypes: Array<{ name: string }> };
  // A self-contained project catalog suppresses the builtin layer, so only its own archetypes plus the role canon appear.
  assert.deepEqual(json.archetypes.map((a) => a.name), ['judge', 'reviewer', 'worker']);
});

test('the ledger stays readable when a row is torn, and the listing says so', (t) => {
  const root = repo(t);
  cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'good'], 'x');
  writeFileSync(join(root, LEDGER_FILE), readFileSync(join(root, LEDGER_FILE), 'utf8') + '{"row":"opened","id":"torn"\n');
  const list = cli(root, ['dispatches']);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /good/);
  assert.match(list.stdout, /1 unreadable row\(s\) skipped/);
});

test('dispatch-open on auto hands a command-lane archetype to the proxy: prompt staged, nothing opened, and the relayed command runs the dispatch', (t) => {
  const root = repo(t);
  const relayed = cli(root, ['dispatch-open', '--archetype', 'worker', '--name', 'Fix Login', '--json'], 'Fix the login bug.\n');
  assert.equal(relayed.status, 0, relayed.stderr);
  const json = JSON.parse(relayed.stdout) as { ok: boolean; opened: boolean; lane: string; name: string; model: string; harness: string; relay: { prompt_file: string; args: string[]; command: string }; nag: string };
  assert.equal(json.ok, true);
  assert.equal(json.opened, false);
  assert.equal(json.lane, 'command');
  assert.equal(json.model, 'echo');
  assert.equal(json.harness, 'codex');
  assert.ok(json.relay.prompt_file.startsWith(join(realpathSync(root), '.fadeno', 'local', 'relay')), json.relay.prompt_file);
  assert.equal(readFileSync(json.relay.prompt_file, 'utf8'), 'Fix the login bug.\n', 'the caller\'s bytes, untouched');
  assert.deepEqual(json.relay.args, ['dispatch', '--archetype', 'worker', '--name', 'Fix Login', '--prompt-file', json.relay.prompt_file]);
  assert.equal(json.relay.command, `fadeno dispatch --archetype worker --name 'Fix Login' --prompt-file ${json.relay.prompt_file}`);
  assert.equal(json.nag, 'No unclosed dispatches in this repository.');
  assert.ok(!existsSync(join(root, LEDGER_FILE)), 'a relay writes no row; fadeno dispatch does');
  const plain = cli(root, ['dispatch-open', '--archetype', 'worker'], 'again');
  assert.match(plain.stdout, /worker resolves to echo@high on codex, a command lane: nothing opened here\. The dispatch proxy runs:\n  fadeno dispatch --archetype worker --prompt-file /);

  // The proxy runs exactly what it was handed.
  const ran = cli(root, json.relay.args);
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(ran.stdout.startsWith('REPORT:Fix the login bug.\n\n' + CONTRACT_HEADER));
  const record = readDispatches(root).records[0]!;
  assert.equal(record.opened?.name, 'fix-login');
  assert.equal(record.opened?.lane, 'command');
  assert.equal(record.opened?.task, 'Fix the login bug.');

  // A forced command lane on an archetype with nothing to invoke is refused before anything is staged.
  const nothing = cli(root, ['dispatch-open', '--archetype', 'reviewer', '--lane', 'command'], 'x');
  assert.notEqual(nothing.status, 0);
  assert.match(nothing.stderr, /nothing to invoke/);
  assert.match(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'sideways'], 'x').stderr, /--lane sideways: expected one of auto, host, command/);

  // Staged prompts are scratch: clean removes them, and only them.
  cli(root, ['dispatch-close', 'fix-login', '--merged']);
  assert.match(cli(root, ['clean']).stdout, /would remove \.fadeno\/local\/relay\/ \(staged relay prompts\)/);
  cli(root, ['clean', '--force']);
  assert.ok(!existsSync(join(root, '.fadeno', 'local', 'relay')));
  assert.ok(existsSync(join(root, '.fadeno', 'prompts')));
});

test('dispatch-stop --transcript names the dispatch from the contract header, records the model that ran and the last words, and says when the dial was not applied', (t) => {
  const root = repo(t);
  const opened = JSON.parse(cli(root, ['dispatch-open', '--archetype', 'worker', '--lane', 'host', '--name', 'observed', '--json'], 'Do it.').stdout) as { id: string; prompt: string };
  const transcript = join(root, 'agent-x.jsonl');
  const record = (o: unknown) => JSON.stringify(o) + '\n';
  writeFileSync(transcript,
    record({ type: 'user', message: { role: 'user', content: opened.prompt } }) +
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Working.' }] } }) +
    '{"torn":' + '\n' +
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'All done; merge it.' }] } }),
  );
  const stopped = cli(root, ['dispatch-stop', '--transcript', transcript]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /observed stopped; tree clean; WARNING: ran on claude-haiku-4-5, the dial asked for echo\. Close it:/);
  const row = readDispatches(root).records[0]!.stopped!;
  assert.equal(row.final_message, 'All done; merge it.');
  assert.equal(row.model_observed, 'claude-haiku-4-5');
  assert.match(cli(root, ['dispatches', 'observed']).stdout, /ran on:    claude-haiku-4-5  \(the dial asked for echo\)/);
  // An explicit message wins over the transcript's last words; a replay changes nothing.
  assert.match(cli(root, ['dispatch-stop', 'observed', '--transcript', transcript], 'later words').stdout, /already recorded/);
  assert.equal(readDispatches(root).records[0]!.stopped!.final_message, 'All done; merge it.');

  // A transcript with no contract is not a dispatch: exit 4, nothing recorded, and --json says so.
  const foreign = join(root, 'agent-y.jsonl');
  writeFileSync(foreign, record({ type: 'user', message: { role: 'user', content: 'Explore the repo.' } }));
  const notOurs = cli(root, ['dispatch-stop', '--transcript', foreign, '--json']);
  assert.equal(notOurs.status, 4);
  assert.deepEqual(JSON.parse(notOurs.stdout).dispatch, null);
  assert.equal(readDispatches(root).records.length, 1);
  assert.match(cli(root, ['dispatch-stop']).stderr, /a transcript can name the dispatch/);
});

test('a director\'s contract carries the host vocabulary, and a dispatch run from inside a worktree still lands in the main repository\'s ledger', (t) => {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 4,
    models: { echo: { provider: 'openai', id: 'echo-model', effort: 'high' } },
    harnesses: { codex: { provider: 'openai', command: ECHO } },
    archetypes: { director: {}, worker: {} },
    dials: { director: 'echo', worker: 'echo' },
  }));
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  const run = cli(root, ['dispatch', '--archetype', 'director', '--name', 'lead'], 'Coordinate the fix.');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\*\*You may spawn\.\*\* The dispatches you open are recorded under yours/);
  assert.match(run.stdout, /## Archetypes\n\n[\s\S]*- \*\*director\*\* — Coordinates a whole task[\s\S]*_\(routes to echo@high; repo dial\)_/);
  assert.match(run.stdout, /## Closing/);
  assert.ok(run.stdout.trimEnd().endsWith('## End of Fadeno dispatch contract'), 'the vocabulary sits inside the contract');
  const worktree = join(root, '.fadeno', 'local', 'worktrees', 'lead');
  const nested = cli(worktree, ['dispatch', '--archetype', 'worker', '--name', 'child'], 'Child task.');
  assert.equal(nested.status, 0, nested.stderr);
  const records = readDispatches(root).records;
  assert.equal(records.length, 2, 'both rows in the main ledger, none in the worktree');
  assert.ok(!existsSync(join(worktree, '.fadeno', 'dispatches.jsonl')));
  assert.ok(existsSync(join(root, '.fadeno', 'local', 'worktrees', 'child')));
});

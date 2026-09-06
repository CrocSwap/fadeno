import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDispatch } from '../src/commands/dispatch.ts';
import { stampHookVersion } from '../src/commands/plugin.ts';
import { tempRepo } from './helpers.ts';

/**
 * The Codex `PreToolUse` Bash guard — the dispatch-side half of relay
 * attestation, plus the role agents' destructive-git refusal.
 *
 * Same harness shape as `test/codex-spawn-guard.test.ts`: stamp the template
 * into a temp tree and feed it synthetic `PreToolUse` events on stdin. This
 * hook shells out to nothing and reads no user state, so there is no fake
 * `fadeno` on PATH and no `CODEX_HOME` — the only inputs are the event and the
 * repo tree the event names.
 *
 * The event shape is the MEASURED one (Codex 0.153.4, captured from a real
 * `codex exec` shell call): `tool_name: "Bash"` with the command bytes in
 * `tool_input.command`, `cwd` always present, `agent_type` present only for a
 * subagent's call.
 */
const REPO = join(import.meta.dirname, '..');
const TEMPLATE = join(REPO, 'templates', 'codex', 'hooks', 'dispatch-proxy-guard.mjs');
const PROMPT_DIR = join('.fadeno', 'local', 'prompts');

interface Guard {
  root: string;
  /** Write a prompt file under `.fadeno/local/prompts/` and return its repo-relative path. */
  prompt(name: string, body: string): string;
  run(event: Record<string, unknown>): { stdout: string; stderr: string };
  /** The `proxy-dispatches.jsonl` rows this hook wrote, or `[]`. */
  markers(): Array<Record<string, unknown>>;
}

function guard(t: Parameters<typeof tempRepo>[0], options: { fadenoDir?: boolean } = {}): Guard {
  const base = tempRepo(t);
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  if (options.fadenoDir !== false) mkdirSync(join(root, PROMPT_DIR), { recursive: true });
  const script = join(base, 'plugin', 'hooks', 'dispatch-proxy-guard.mjs');
  mkdirSync(join(base, 'plugin', 'hooks'), { recursive: true });
  writeFileSync(script, stampHookVersion(readFileSync(TEMPLATE, 'utf8')), 'utf8');

  return {
    root,
    prompt(name, body) {
      mkdirSync(join(root, PROMPT_DIR), { recursive: true });
      writeFileSync(join(root, PROMPT_DIR, name), body, 'utf8');
      return `${PROMPT_DIR}/${name}`;
    },
    run(event) {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        input: JSON.stringify(event),
        encoding: 'utf8',
      });
      // A PreToolUse hook that exits non-zero is a broken hook, not a decision.
      assert.equal(result.status, 0, result.stderr);
      return { stdout: result.stdout, stderr: result.stderr };
    },
    markers() {
      const path = join(root, '.fadeno', 'local', 'proxy-dispatches.jsonl');
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

function bashEvent(root: string, command: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-bash',
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: root,
    hook_event_name: 'PreToolUse',
    model: 'gpt-6-astra',
    permission_mode: 'bypassPermissions',
    tool_name: 'Bash',
    tool_use_id: 'call-1',
    tool_input: { command },
    ...extra,
  };
}

/** The caller-prompt digest every writer of these markers must agree on. */
function callerDigest(text: string): string {
  return createHash('sha256').update(text.replace(/(?:\r?\n)+$/, '')).digest('hex');
}

function decision(stdout: string): { permissionDecision?: string; permissionDecisionReason?: string } {
  if (stdout.trim() === '') return {};
  return (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
}

// --- Relay attestation ------------------------------------------------------

test('codex bash guard: a role agent dispatching a prompt file marks the caller bytes', (t) => {
  const g = guard(t);
  // The exact grammar both Codex role briefs emit (`renderCodexCommandBroker`
  // and `renderCodexHostAgent`): the prompt is written to a file first, so the
  // bytes are on disk and only the PATH is in the command.
  const path = g.prompt('worker-parse-retry.md', 'Fix the retry header.\nSecond line.\n');
  const { stdout } = g.run(
    bashEvent(g.root, `fadeno dispatch --archetype worker --prompt-file ${path}`, { agent_type: 'worker' }),
  );
  assert.equal(stdout.trim(), '', 'a conforming relay is allowed unchanged');
  const rows = g.markers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.archetype, 'worker');
  // The CANONICAL digest — trailing terminators stripped — because the file
  // ends in a newline the spawn's own `message` never had. Hashing raw bytes
  // here is what would manufacture a `relay_attested: false`.
  assert.equal(rows[0]!.prompt_sha256, callerDigest('Fix the retry header.\nSecond line.'));
  assert.equal(typeof rows[0]!.timestamp, 'string');
});

test('codex bash guard: the quoted-heredoc relay spelling is marked from its body', (t) => {
  const g = guard(t);
  const { stdout } = g.run(
    bashEvent(
      g.root,
      "fadeno dispatch --archetype reviewer --tag reviewer-check <<'FADENO_PROMPT'\nreview this\nFADENO_PROMPT",
      { agent_type: 'reviewer' },
    ),
  );
  assert.equal(stdout.trim(), '');
  const rows = g.markers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.archetype, 'reviewer');
  assert.equal(rows[0]!.prompt_sha256, callerDigest('review this'));
});

test('codex bash guard: the main session is never marked and never guarded', (t) => {
  const g = guard(t);
  const path = g.prompt('worker-x.md', 'host wrote this');
  // No `agent_type`: the measured shape of a main-loop shell call. The host
  // dispatches on its own account, and marking it would let an unrelated fresh
  // spawn-side row turn an honest dispatch into a fidelity failure.
  const relay = g.run(bashEvent(g.root, `fadeno dispatch --archetype worker --prompt-file ${path}`));
  assert.equal(relay.stdout.trim(), '');
  assert.deepEqual(g.markers(), []);
  // ...and the host legitimately runs every guarded git subcommand.
  const git = g.run(bashEvent(g.root, 'git reset --hard origin/main'));
  assert.equal(git.stdout.trim(), '');
});

test('codex bash guard: an unattestable prompt path claims nothing rather than guessing', (t) => {
  const g = guard(t);
  writeFileSync(join(g.root, 'outside.md'), 'not a relay prompt\n', 'utf8');
  const outside = [
    // Outside `.fadeno/local/prompts/`: a hook that reads any path a model
    // names, and emits a hash of it, is a file oracle with a side channel.
    'fadeno dispatch --archetype worker --prompt-file outside.md',
    `fadeno dispatch --archetype worker --prompt-file ${PROMPT_DIR}/../../outside.md`,
    // An unexpanded shell variable is not a path.
    'fadeno dispatch --archetype worker --prompt-file "$PROMPT"',
    // A file that does not exist yet.
    `fadeno dispatch --archetype worker --prompt-file ${PROMPT_DIR}/never-written.md`,
  ];
  for (const command of outside) {
    const { stdout } = g.run(bashEvent(g.root, command, { agent_type: 'worker' }));
    assert.equal(stdout.trim(), '', command);
  }
  assert.deepEqual(g.markers(), [], 'an unreadable relay is unattested, never refused');
});

test('codex bash guard: a dispatch naming another archetype is not this agent\'s relay', (t) => {
  const g = guard(t);
  const path = g.prompt('p.md', 'body');
  g.run(bashEvent(g.root, `fadeno dispatch --archetype reviewer --prompt-file ${path}`, { agent_type: 'worker' }));
  assert.deepEqual(g.markers(), [], 'no brief defines a worker relaying as a reviewer');
});

test('codex bash guard: no marker is written into a repo with no .fadeno tree', (t) => {
  const g = guard(t, { fadenoDir: false });
  mkdirSync(join(g.root, PROMPT_DIR), { recursive: true });
  // The prompt dir alone is not a Fadeno repo: a hook must never be the thing
  // that creates the tree in a repo that opted out.
  const path = g.prompt('p.md', 'body');
  const { stdout } = g.run(
    bashEvent(g.root, `fadeno dispatch --archetype worker --prompt-file ${path}`, { agent_type: 'worker' }),
  );
  assert.equal(stdout.trim(), '');
});

test('codex bash guard: a cwd-less event is unattested rather than written to a guessed repo', (t) => {
  const g = guard(t);
  const path = g.prompt('p.md', 'body');
  const { stdout } = g.run({
    ...bashEvent(g.root, `fadeno dispatch --archetype worker --prompt-file ${path}`, { agent_type: 'worker' }),
    cwd: '',
  });
  assert.equal(stdout.trim(), '');
  assert.deepEqual(g.markers(), []);
});

// --- Destructive git --------------------------------------------------------

test('codex bash guard: role agents are refused the git subcommands that destroy shared work', (t) => {
  const g = guard(t);
  const refused: Array<[string, string]> = [
    ['worker', 'git checkout -- src/foo.ts'],
    ['worker', 'git switch main'],
    ['reviewer', 'git restore src/foo.ts'],
    ['judge', 'git reset --hard'],
    ['worker', 'git stash'],
    ['worker', 'git clean -fd'],
    // Env assignments and pass-through wrappers do not launder it.
    ['worker', 'GIT_DIR=.git env git reset --hard'],
    // Nor does hiding it behind an earlier statement.
    ['worker', 'npm test && git checkout -- .'],
    // Nor a global option that takes a separate value.
    ['worker', 'git -C . -c core.pager=cat reset --hard'],
  ];
  for (const [role, command] of refused) {
    const { stdout } = g.run(bashEvent(g.root, command, { agent_type: role }));
    const out = decision(stdout);
    assert.equal(out.permissionDecision, 'deny', command);
    assert.match(String(out.permissionDecisionReason), new RegExp(`^fadeno ${role}: `));
    assert.match(String(out.permissionDecisionReason), /Report this refusal to the user/);
  }
});

test('codex bash guard: reading git state is not destroying it', (t) => {
  const g = guard(t);
  const allowed = [
    'git stash list',
    'git stash show -p',
    'git clean -n',
    'git clean --dry-run',
    'git status --porcelain',
    'git diff HEAD',
    // `commit` is deliberately not on the list: it destroys nobody's work.
    'git commit -m wip',
  ];
  for (const command of allowed) {
    const { stdout } = g.run(bashEvent(g.root, command, { agent_type: 'worker' }));
    assert.equal(stdout.trim(), '', command);
  }
});

test('codex bash guard: a heredoc body is data, not a command', (t) => {
  const g = guard(t);
  // The relayed prompt is the user's task text. A prompt that says "do not run
  // git checkout" must not be refused as if it had run one — and a herestring
  // must not swallow the rest of the line as a heredoc body and hide a real one.
  const relay = g.run(
    bashEvent(
      g.root,
      "fadeno dispatch --archetype worker <<'FADENO_PROMPT'\nDo not run git checkout or git reset here.\nFADENO_PROMPT",
      { agent_type: 'worker' },
    ),
  );
  assert.equal(relay.stdout.trim(), '');
  assert.equal(g.markers().length, 1);

  const herestring = g.run(bashEvent(g.root, "cat <<<'hi' ; git reset --hard", { agent_type: 'worker' }));
  assert.equal(decision(herestring.stdout).permissionDecision, 'deny');
});

test('codex bash guard: a refused command leaves no marker claiming it relayed', (t) => {
  const g = guard(t);
  const path = g.prompt('p.md', 'body');
  const { stdout } = g.run(
    bashEvent(g.root, `git checkout -- . && fadeno dispatch --archetype worker --prompt-file ${path}`, {
      agent_type: 'worker',
    }),
  );
  assert.equal(decision(stdout).permissionDecision, 'deny');
  assert.deepEqual(g.markers(), [], 'a denied call never runs, so it sent no bytes');
});

test('codex bash guard: a non-shell tool and an unreadable event are no-ops', (t) => {
  const g = guard(t);
  const spawn = g.run({
    ...bashEvent(g.root, 'git reset --hard', { agent_type: 'worker' }),
    tool_name: 'Agent',
    tool_input: { agent_type: 'worker', message: 'git reset --hard' },
  });
  assert.equal(spawn.stdout.trim(), '', 'the spawn guard owns the Agent event, not this hook');
  const noCommand = g.run({ ...bashEvent(g.root, 'x', { agent_type: 'worker' }), tool_input: {} });
  assert.equal(noCommand.stdout.trim(), '');
});

// --- Both halves, through the real kernel ------------------------------------

/**
 * The whole point, end to end: the two Codex hooks write the two marker files
 * and the HARNESS-NEUTRAL kernel reads them as `relay_attested: true` with no
 * Codex-specific code of its own.
 *
 * Neither digest is asserted here — that is what the unit tests above do. What
 * this asserts is the agreement between three processes that share no code:
 * `spawn-guard.mjs` hashing a spawn's `message`, `dispatch-proxy-guard.mjs`
 * hashing the prompt FILE the role agent wrote from it, and
 * `runDispatch` hashing the bytes it reads off that same file. The file ends in
 * a newline the `message` never had, so raw-byte hashing anywhere in that chain
 * turns an honest relay into a `relay_fidelity` refusal.
 */
test('codex hooks: spawn stash + dispatch marker attest a relay through the kernel', (t) => {
  const base = tempRepo(t);
  const root = join(base, 'repo');
  const data = join(base, 'data');
  const codexHome = join(base, 'codex');
  const bin = join(base, 'bin');
  mkdirSync(join(root, PROMPT_DIR), { recursive: true });
  mkdirSync(join(codexHome, 'agents'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 4,
      models: { 'echo-worker': { provider: 'openai', id: 'echo-worker', effort: 'default' } },
      harnesses: {
        codex: {
          provider: 'openai',
          command: [
            'node',
            '-e',
            "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('REPORT:'+d));",
          ],
        },
      },
      archetypes: { worker: {} },
      dials: { worker: 'echo-worker' },
    }),
    'utf8',
  );

  // A managed command-broker agent file: `steering apply --codex` writes it at
  // user scope as `fadeno-worker.toml` with `name = "worker"`, and a broker
  // bakes no `--host-executor` because the dial's identity travels in the argv.
  writeFileSync(
    join(codexHome, 'agents', 'fadeno-worker.toml'),
    '# fadeno:managed version=0.6.1 digest=deadbeef\nname = "worker"\ndescription = "Fadeno command broker worker"\nsandbox_mode = "workspace-write"\n\ndeveloper_instructions = """\nRun `fadeno steering resolve --archetype worker --prompt-file <path>`\n"""\n',
    'utf8',
  );
  const resolution = JSON.stringify({
    archetype: 'worker',
    executor: 'echo-worker',
    model: 'echo-worker',
    model_id: 'echo-worker',
    effort: 'default',
    pinned_effort: null,
    effective_effort: 'default',
    effort_pinned: false,
    session_effort: null,
    lane: 'command',
    lane_reason: 'session effort unobserved',
    adapter: 'command',
    harness: 'codex',
    variant: null,
    host: 'codex',
    source: 'repo',
  });
  const fakeCli = join(bin, 'fadeno');
  writeFileSync(fakeCli, `#!/bin/sh\nprintf '%s\\n' '${resolution}'\n`, 'utf8');
  chmodSync(fakeCli, 0o755);

  // 1. The host spawns the role agent. The spawn guard stashes the caller bytes.
  const spawnScript = join(base, 'plugin', 'hooks', 'spawn-guard.mjs');
  mkdirSync(join(base, 'plugin', 'hooks'), { recursive: true });
  writeFileSync(
    spawnScript,
    stampHookVersion(readFileSync(join(REPO, 'templates', 'codex', 'hooks', 'spawn-guard.mjs'), 'utf8')),
    'utf8',
  );
  const env = { ...process.env };
  delete env.PLUGIN_ROOT;
  const spawned = spawnSync(process.execPath, [spawnScript], {
    cwd: root,
    env: { ...env, PATH: `${bin}:${process.env.PATH ?? ''}`, PLUGIN_DATA: data, CODEX_HOME: codexHome },
    input: JSON.stringify({
      session_id: 'sess-e2e',
      cwd: root,
      hook_event_name: 'PreToolUse',
      model: 'gpt-6-astra',
      tool_name: 'Agent',
      tool_use_id: 'call-spawn',
      tool_input: { agent_type: 'worker', message: 'Fix the retry header.' },
    }),
    encoding: 'utf8',
  });
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.equal(spawned.stdout.trim(), '', 'a managed command-broker spawn is allowed');

  // 2. The role agent writes the prompt it received to a file — with the
  //    trailing newline a file has and a `message` does not — and dispatches.
  const relayPath = `${PROMPT_DIR}/worker-retry-header.md`;
  writeFileSync(join(root, relayPath), 'Fix the retry header.\n', 'utf8');
  const proxyScript = join(base, 'plugin', 'hooks', 'dispatch-proxy-guard.mjs');
  writeFileSync(proxyScript, stampHookVersion(readFileSync(TEMPLATE, 'utf8')), 'utf8');
  const relayed = spawnSync(process.execPath, [proxyScript], {
    cwd: root,
    input: JSON.stringify(bashEvent(root, `fadeno dispatch --archetype worker --prompt-file ${relayPath}`, {
      agent_type: 'worker',
    })),
    encoding: 'utf8',
  });
  assert.equal(relayed.status, 0, relayed.stderr);
  assert.equal(relayed.stdout.trim(), '');

  // 3. The kernel — which knows nothing about Codex — reads both halves.
  const result = runDispatch({
    archetype: 'worker',
    promptFile: relayPath,
    repoRoot: root,
    cwd: root,
    userPathOptions: { env: { FADENO_HARNESS: 'codex' } },
  });
  assert.equal(result.relayAttested, true);
});

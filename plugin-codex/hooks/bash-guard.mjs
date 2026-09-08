#!/usr/bin/env node
// PreToolUse guard on shell calls made by Fadeno's own agents. Two audiences,
// one file for both harnesses (Codex delivers a shell call as tool_name
// `Bash` with the command in `tool_input.command`, the Claude spelling).
//
// 1. THE DISPATCH PROXY runs exactly one command: the `fadeno dispatch` line
//    the spawn hook put in its prompt, plus the recovery read after a killed
//    call. Anything else is a contract violation — the 2026-08-12 dogfood
//    watched a proxy quietly do the task itself with no dispatch and no row,
//    which is the failure a proxy exists to make impossible. The dispatch leg
//    also gets the long tool timeout an external executor needs.
//
// 2. A DISPATCHED AGENT (any archetype) is refused the git subcommands that
//    destroy uncommitted work in a tree it shares: checkout, switch, restore,
//    reset, stash, clean. A worker ran `git checkout -- <file>` in a shared
//    tree on 2026-09-05 and lost its own edits; a shared file would have been
//    someone else's. In its OWN worktree those commands are its business — a
//    merge from upstream may need every one of them — so a statement that
//    names a Fadeno worktree (`git -C <worktree> …`, or `cd <worktree> && …`
//    in the same call) passes. A bare invocation cannot say where it runs and
//    is refused with the two spellings that can.
//
// Scope, stated because it is partial: coverage follows `agent_type`. The
// main session has none and is never guarded; a generic subagent is not a
// dispatch and is not guarded either. The statement splitter reads shell text
// without being a shell — it stops a reflex, not a determined agent.

import { classifyAgentType, finish, readEvent, refusal, str } from './hook-lib.mjs';

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'local_shell', 'exec_command', 'unified_exec']);
const DISPATCH_TIMEOUT_MS = 600_000;
const WORKTREES = '.fadeno/local/worktrees/';

const event = readEvent();
if (event == null || !SHELL_TOOLS.has(event.tool_name)) finish(null);
const input = event.tool_input;
if (input == null || typeof input !== 'object') finish(null);
const agent = classifyAgentType(str(event.agent_type));
if (agent.kind === 'generic') finish(null);
const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : null;
// Codex payloads carry `turn_id`; Codex rejects `updatedInput`, so the
// timeout rewrite below is Claude-only.
const codex = typeof event.turn_id === 'string';

function deny(reason) {
  finish({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal(reason) },
  });
}

/** Fragments that could each start a command. Over-splits in the safe direction. */
function fragments(text) {
  return text
    .split(/\n|&&|\|\||;|\||\$\(|`|\(|\)|\{|\}/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

// ---------------------------------------------------------------------------
// The dispatch proxy
// ---------------------------------------------------------------------------

const CLI = String.raw`(?:fadeno|"?\$\{?(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|FADENO_CLI)[^"]*"?|\S*/bin/fadeno)`;
const WORD = String.raw`(?:'[^']*'|"[^"]*"|\S+)`;
const DISPATCH_RE = new RegExp(
  String.raw`^(?:FADENO_HARNESS=\S+ )?${CLI} dispatch --archetype [a-z][a-z0-9_-]*(?: --name ${WORD})?(?: --model ${WORD})?(?: --shared)?(?: --from ${WORD})?(?: --parent ${WORD})? --prompt-file ${WORD}$`,
);
const RECOVER_RE = new RegExp(String.raw`^(?:FADENO_HARNESS=\S+ )?${CLI} dispatches --output ${WORD}$`);
// The wait loop is part of the contract now: a dispatch that outruns the
// harness's shell ceiling is ordinary, and the proxy's only way to finish
// honestly is to ask again until the dispatch has actually stopped.
const WAIT_RE = new RegExp(String.raw`^(?:FADENO_HARNESS=\S+ )?${CLI} dispatch-wait ${WORD}(?: --wait-seconds ${WORD})?(?: --json)?$`);

if (agent.kind === 'proxy') {
  if (command == null || command.trim() === '') deny('dispatch proxy: the Bash call carries no command.');
  const statements = command
    .split(/\n|&&|;|\|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let dispatches = false;
  for (const statement of statements) {
    if (DISPATCH_RE.test(statement)) {
      dispatches = true;
      continue;
    }
    if (RECOVER_RE.test(statement) || WAIT_RE.test(statement)) continue;
    const shown = statement.length > 80 ? `${statement.slice(0, 77)}...` : statement;
    deny(
      `dispatch proxy: "${shown}" is outside the relay contract. The only commands a dispatch proxy runs are the \`fadeno dispatch --archetype … --prompt-file …\` line in its prompt and, after a killed call, \`fadeno dispatch-wait <name>\` or \`fadeno dispatches --output <name>\`. Do not inspect the repository or attempt the task; run the command you were given and relay its output.`,
    );
  }
  const timeout = input.timeout;
  if (dispatches && !codex && (typeof timeout !== 'number' || timeout < DISPATCH_TIMEOUT_MS)) {
    finish({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, timeout: DISPATCH_TIMEOUT_MS } } });
  }
  finish(null);
}

// ---------------------------------------------------------------------------
// Dispatched agents: the destructive git subcommands in a shared tree
// ---------------------------------------------------------------------------

const DESTRUCTIVE_GIT = new Map([
  ['checkout', 'discards uncommitted changes to the paths it names and moves HEAD for everyone sharing this tree'],
  ['switch', 'moves HEAD for everyone sharing this tree'],
  ['restore', 'discards uncommitted changes to the paths it names'],
  ['reset', 'rewrites the index, and with --hard the working tree'],
  ['stash', 'removes every uncommitted change in the tree, including changes this dispatch did not make'],
  ['clean', 'deletes untracked files, including work no commit is holding'],
]);
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const WRAPPERS = new Set(['env', 'sudo', 'command', 'time', 'nohup']);

/** The git subcommand a fragment invokes, its remaining tokens, and any `-C <dir>`; null when not git. */
function gitInvocation(fragment) {
  const tokens = fragment.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(tokens[i]))) i += 1;
  const bin = (tokens[i] ?? '').replace(/^["']|["']$/g, '');
  if (!/(^|\/)git$/.test(bin)) return null;
  i += 1;
  let dir = null;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '-C') {
      dir = tokens[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith('-')) {
      i += 1;
      continue;
    }
    return { sub: token, rest: tokens.slice(i + 1), dir };
  }
  return null;
}

function isReadOnlyGit(sub, rest) {
  if (sub === 'stash') return rest.length > 0 && (rest[0] === 'list' || rest[0] === 'show');
  if (sub === 'clean') return rest.some((t) => t === '-n' || t === '--dry-run');
  return false;
}

const inWorktree = (path) => typeof path === 'string' && path.replace(/^["']|["']$/g, '').includes(WORKTREES);

if (command != null) {
  // A `cd` into a Fadeno worktree earlier in the same call vouches for what follows it.
  let vouched = false;
  for (const fragment of fragments(command)) {
    const cd = fragment.match(/^cd\s+(\S+)/);
    if (cd != null) {
      vouched = inWorktree(cd[1]);
      continue;
    }
    const invocation = gitInvocation(fragment);
    if (invocation == null) continue;
    const harm = DESTRUCTIVE_GIT.get(invocation.sub);
    if (harm == null || isReadOnlyGit(invocation.sub, invocation.rest)) continue;
    if (vouched || inWorktree(invocation.dir)) continue;
    deny(
      `fadeno ${agent.archetype}: \`git ${invocation.sub}\` is refused here because it ${harm}, and this call does not say which tree it runs in. ` +
        `In your own worktree it is yours to run — spell it \`git -C <your worktree> ${invocation.sub} …\` or \`cd <your worktree> && git ${invocation.sub} …\` in the same call, with the path under ${WORKTREES}. ` +
        'In a shared tree do not run it at all: if your own edit was wrong, edit the file back; if the tree is in a state you cannot work from, stop and report it, naming the files.',
    );
  }
}
finish(null);

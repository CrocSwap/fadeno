#!/usr/bin/env node
// PreToolUse Bash guard for Fadeno's managed CODEX agents — the twin of
// templates/claude/hooks/dispatch-proxy-guard.mjs, and the file that closes the
// gap that guard's own header states ("Codex has no Bash PreToolUse hook at
// all"). That was our wiring, never a Codex limitation: Codex 0.153.4 fires
// `PreToolUse` for every tool, and the shell call arrives with
// `tool_name: "Bash"` and `tool_input: {command: "<the exact bytes>"}` —
// measured against the shipped binary, not read out of documentation.
//
// Two jobs, two audiences.
//
// 1. RELAY ATTESTATION. `relay_attested: false` is a boundary refusal
//    (predicate `relay_fidelity`, src/commands/dispatch.ts), and it needs BOTH
//    sides of a comparison. The spawn side is stashed by spawn-guard.mjs when
//    Fadeno lets a managed role spawn through; this hook writes the other side
//    — "a Fadeno role agent is about to send THESE bytes" — keyed by their
//    digest. Without it the kernel reads `null` ("no proxy sent this") for
//    every Codex dispatch and the fidelity gate can never fire, which is
//    exactly the state a live Codex-director session was in.
//
//    The Codex relay does not look like the Claude one, and the difference is
//    the whole implementation. On Claude the relay is a DEDICATED proxy agent
//    that pipes the prompt inline through a quoted heredoc, so the bytes are in
//    the command. On Codex the managed ROLE agent brokers its own dispatch: its
//    developer instructions (`renderCodexCommandBroker` /
//    `renderCodexHostAgent`, src/commands/steering.ts) tell it to write the
//    task prompt it received verbatim to a file under `.fadeno/local/prompts/`
//    and then run `fadeno dispatch --archetype <role> --prompt-file <path>`.
//    So the bytes are not in the command — the PATH to them is, and this hook
//    reads that file. Those still ARE "the bytes it is about to send": the
//    kernel reads the same file and pins `callerPromptSha256` from it
//    (src/commands/dispatch.ts), so the two processes hash the same content.
//
// 2. ROLE AGENTS (`worker`, `reviewer`, `judge`) get the same one narrow
//    refusal the Claude guard gives them: the git subcommands that DESTROY
//    uncommitted work in the tree they share with everyone else. Reported
//    2026-09-05 from a live campaign — a worker ran `git checkout -- <file>`
//    in the shared tree despite the dispatch's explicit "do NOT commit, stash,
//    checkout, or reset", lost its own edits and redid them. It was lucky: the
//    file was its own. A shared one would have destroyed another agent's work
//    with no record that it happened. Role agents are otherwise unrestricted —
//    this is a guardrail, not an allowlist.
//
// DELIBERATELY NOT here: the Claude guard's relay grammar, which allows a
// dispatch proxy exactly one shape of Bash and denies everything else. That
// contract is safe on Claude because `dispatch-worker` exists to relay and does
// nothing else. On Codex the same `worker` agent is ALSO the host-lane
// implementer — `mode=host` means "do the work here" — so an allowlist would
// refuse a role agent every legitimate command it runs. This hook marks and
// guards; it never restricts what else a role agent may do.
//
// Scope, stated honestly because it is PARTIAL, exactly as the Claude twin
// states its own:
//   - Fires on every shell PreToolUse and no-ops unless `agent_type` names a
//     managed role. The main session is never guarded: the host legitimately
//     runs every one of these commands.
//   - Identification is by `agent_type`, so a role brief handed to a generic
//     Codex subagent is not covered. Coverage follows the agent TYPE, not the
//     job — and the spawn guard is what stops a generic spawn in host mode.
//   - The statement splitter below is a tripwire, not a sandbox: it reads shell
//     text without being a shell. `bash -c "git checkout …"` gets through.
//     Isolation is the protection; the hook catches the reflex.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Which generation of this hook wrote a given marker row. Same contract, and
// the same reason, as the spawn guard's stamp: plugin hooks load once at
// session start, so a live session keeps running the previous build after an
// upgrade. `fadeno plugin --codex` replaces this literal with the package
// version; the template keeps 'dev', so a row reading 'dev' means the template
// was executed directly rather than an installed copy.
const HOOK_VERSION = '0.6.1';

function finish(value) {
  if (value != null) process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  finish(null);
}
if (event == null || typeof event !== 'object' || Array.isArray(event)) finish(null);

/**
 * The shell tool's name, as Codex spells it on the hook event.
 *
 * `Bash` is the measured value (Codex 0.153.4, a `PreToolUse` payload captured
 * from a real `codex exec` shell call). The alternatives are the names the same
 * binary uses for that tool internally — `exec_command` and `unified_exec` are
 * its handler modules, `local_shell` and `shell` its wire spellings. Accepting
 * all of them costs nothing and means an upstream rename degrades this hook to
 * "no marker written" (verdict `null`) rather than to a silent no-op that also
 * stops guarding git. The spawn guard accepts two spellings for its own tool
 * for exactly this reason.
 */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'local_shell', 'exec_command', 'unified_exec']);
if (typeof event.tool_name !== 'string' || !SHELL_TOOLS.has(event.tool_name)) finish(null);
const input = event.tool_input;
if (input == null || typeof input !== 'object' || Array.isArray(input)) finish(null);

/**
 * The command text, from whichever shape this tool carries it in.
 *
 * `tool_input.command` is a string on the measured payload. An array is
 * accepted because the same tool is argv-shaped on some of its other
 * spellings, and a joined argv reads correctly for both jobs below — the git
 * scanner splits on whitespace anyway, and the dispatch scanner tokenizes.
 */
const command = typeof input.command === 'string'
  ? input.command
  : Array.isArray(input.command) && input.command.every((part) => typeof part === 'string')
    ? input.command.join(' ')
    : null;

/**
 * The managed role agents. Matched on the last `:`-separated segment so both a
 * bare `worker` and a namespaced spelling land here — and, by the same token,
 * so would another plugin's agent named `worker`. The Claude twin accepts that
 * cost with its eyes open and so does this one: denying six git subcommands to
 * a stranger's `worker` is worth paying for covering ours.
 *
 * There is no proxy row here because Codex has no dispatch-proxy agent type.
 * `fadeno-<archetype>` is not a spawnable type either — Codex resolves a custom
 * agent by the `name` key inside the file, and every managed file names the
 * bare archetype (see `managedAgentFile` in spawn-guard.mjs for the receipt).
 */
const ROLE_RE = /^(worker|reviewer|judge)$/;
const agent = typeof event.agent_type === 'string' ? event.agent_type.split(':').at(-1) : null;
const roleMatch = agent == null ? null : agent.match(ROLE_RE);
// The main loop and every unmanaged agent stay unguarded and unattested.
if (roleMatch == null) finish(null);
const role = roleMatch[1];
if (command == null) finish(null); // nothing to read: claim nothing, refuse nothing

// ---------------------------------------------------------------------------
// Shell text, minus the parts that are data rather than commands.
// ---------------------------------------------------------------------------

/**
 * Split a command into its control text and its heredoc bodies.
 *
 * A heredoc body is DATA — for the relay it is the user's task prompt, arbitrary
 * bytes — so it must never reach the git scanner: a prompt that says "do not run
 * git checkout" would otherwise be refused as if it had run one. The Claude twin
 * strips the one delimiter it knows; this strips every heredoc it can see,
 * because a role agent's shell is not restricted to one grammar and an
 * unrecognized delimiter would put a whole prompt back in front of the scanner.
 *
 * Quoted-ness is recorded rather than required: only the QUOTED form is a valid
 * relay opener (an unquoted delimiter lets the shell expand `$`/backticks inside
 * the prompt), and the marker path below insists on it.
 */
function splitHeredocs(text) {
  // `(?<!<)` / `(?!<)` keep a herestring (`<<<'word'`) from reading as a
  // heredoc opener: it would otherwise match one character in and swallow the
  // rest of the command as a body, hiding a real `git checkout` from the
  // scanner below.
  const OPENER = /(?<!<)<<(?!<)-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/;
  const control = [];
  const bodies = [];
  let open = null;
  for (const line of text.split('\n')) {
    if (open != null) {
      if (line.trim() === open.delimiter) {
        bodies.push(open);
        open = null;
        continue;
      }
      open.body.push(line);
      continue;
    }
    const match = OPENER.exec(line);
    if (match != null) {
      const delimiter = match[1] ?? match[2] ?? match[3];
      open = { delimiter, quoted: match[1] != null || match[2] != null, body: [] };
    }
    control.push(line);
  }
  // An unterminated heredoc is still data, and the scanner still must not see
  // it. It is not a valid relay body either — the marker path checks `closed`.
  if (open != null) bodies.push({ ...open, unterminated: true });
  return { control: control.join('\n'), bodies };
}

const { control, bodies } = splitHeredocs(command);

/**
 * The fragments of the control text that could each START a command.
 *
 * Deliberately crude, and crude in the safe direction: over-splitting produces
 * fragments that simply do not begin with `git` (or `fadeno`) and are ignored,
 * while the one thing it must not do is join a `git checkout` onto the tail of
 * something else and miss it. Byte-for-byte the Claude twin's splitter.
 */
function shellFragments(text) {
  return text
    .split(/\n|&&|\|\||;|\||\$\(|`|\(|\)|\{|\}/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

/** Tokens of a fragment with one layer of surrounding quotes removed. */
function tokenize(fragment) {
  return fragment
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/^["']|["']$/g, ''));
}

/**
 * Skip the leading environment assignments and pass-through wrappers, so
 * `FOO=1 env git reset` is still a git reset. Shared by both scanners.
 */
function skipPrefix(tokens) {
  let i = 0;
  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) ||
      tokens[i] === 'env' ||
      tokens[i] === 'sudo' ||
      tokens[i] === 'command' ||
      tokens[i] === 'time' ||
      tokens[i] === 'nohup')
  ) {
    i += 1;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Job 1: the proxy-side relay marker.
// ---------------------------------------------------------------------------

/** Where both Codex role briefs put the prompt file, relative to the repo root. */
const PROMPT_DIR = join('.fadeno', 'local', 'prompts');

/**
 * The relay call this fragment makes, or null.
 *
 * Both Codex role briefs emit exactly `<cli> dispatch --archetype <role>
 * --prompt-file <path>`, and the heredoc spelling is accepted too because it is
 * the contract the rest of Fadeno documents and a role agent may reach for it.
 * The archetype must be the agent's OWN role: a `worker` dispatching as
 * `reviewer` is outside every brief Fadeno writes, and attesting it would be
 * claiming a relay nobody defined.
 */
function relayCall(fragment) {
  const tokens = tokenize(fragment);
  let i = skipPrefix(tokens);
  const bin = tokens[i] ?? '';
  // Bare `fadeno`, the plugin-root spelling (`$PLUGIN_ROOT/bin/fadeno`), and any
  // absolute path to it all end the same way.
  if (!/(^|\/)fadeno$/.test(bin)) return null;
  if (tokens[i + 1] !== 'dispatch') return null;
  i += 2;
  let archetype = null;
  let promptFile = null;
  while (i < tokens.length) {
    if (tokens[i] === '--archetype') { archetype = tokens[i + 1] ?? null; i += 2; continue; }
    if (tokens[i] === '--prompt-file') { promptFile = tokens[i + 1] ?? null; i += 2; continue; }
    i += 1;
  }
  if (archetype !== role) return null;
  return { promptFile };
}

/**
 * The CALLER digest (`callerPromptDigest`, src/lib/executors.ts), spelled by
 * hand as everything else in a standalone hook is.
 *
 * The trailing-terminator strip is the load-bearing half, and here it is what
 * makes the two spellings agree: a prompt FILE almost always ends in a newline
 * while the spawn's own `message` almost never does, and a quoted heredoc adds
 * one on the way through the shell. This marker, spawn-guard.mjs's spawn-side
 * stash and the kernel's own read of the received bytes all reduce to the same
 * value for the same task. test/dispatch-shadow.test.ts pins the literal across
 * every writer.
 */
function callerPromptDigest(text) {
  return createHash('sha256').update(text.replace(/(?:\r?\n)+$/, '')).digest('hex');
}

/**
 * The bytes this dispatch is about to send, read from the prompt file it names.
 *
 * CONTAINMENT is not incidental. A hook that reads any path a model writes into
 * a command, and emits a hash of it, is a file-oracle with a side channel for an
 * output. Both Codex briefs put the prompt under `.fadeno/local/prompts/`, so
 * that is the only place this reads from — and a path outside it is not a
 * refusal, just an unattested dispatch (`null`), which is the honest answer for
 * a relay shaped in a way Fadeno never defined.
 *
 * A path that is a shell variable resolves to nothing here and is likewise
 * unattested; the Claude twin declines the same case for the same reason.
 */
function promptFileBytes(cwd, promptFile) {
  if (promptFile == null || promptFile.length === 0) return null;
  if (promptFile.includes('$') || promptFile.includes('~')) return null; // unexpanded, not a path
  const path = isAbsolute(promptFile) ? promptFile : resolve(cwd, promptFile);
  const within = relative(resolve(cwd, PROMPT_DIR), path);
  if (within === '' || within.startsWith('..') || isAbsolute(within)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // written by a later tool call, unreadable, gone: claim nothing
  }
}

/**
 * Record that a Fadeno ROLE AGENT is the caller of this dispatch, keyed by the
 * digest of the exact bytes it is about to send.
 *
 * This is what lets `relay_attested: false` mean something on Codex. The
 * spawn-side stash proves a relay-bound spawn happened; it cannot prove that any
 * GIVEN dispatch is that spawn. Without this marker the kernel reads "fresh
 * spawn-side entries exist but none match" as a fidelity failure, when an
 * ordinary un-relayed `fadeno dispatch` colliding with someone else's entry
 * inside the freshness window produces exactly the same reading.
 *
 * Digest only, never content — the prompt is the user's task text and nothing
 * here reads it for any other purpose.
 *
 * Best-effort, and that stays safe now that the kernel REFUSES on
 * `relay_attested: false`: a failure to write this marker loses the claim, so
 * the kernel reads `null` — "no proxy sent this" — and a conforming dispatch
 * runs exactly as before. The gate can only fire on a marker that was written,
 * which is the direction a best-effort write is allowed to be wrong in.
 */
function markRelay() {
  // No inferred cwd. This is a WRITE, and a caller that does not say which repo
  // it is in has not earned a guess — `process.cwd()` would be whatever
  // directory the harness happened to launch from. Codex always sends `cwd`
  // (its `pre-tool-use` schema makes it required); anything that does not
  // simply goes unattested, which is the honest outcome.
  const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : null;
  if (cwd == null) return;
  if (!existsSync(join(cwd, '.fadeno'))) return; // not a Fadeno repo

  let bytes = null;
  for (const fragment of shellFragments(control)) {
    const call = relayCall(fragment);
    if (call == null) continue;
    bytes = promptFileBytes(cwd, call.promptFile);
    if (bytes == null) {
      // The heredoc spelling, when this dispatch used one. The shell feeds a
      // quoted heredoc as each body line plus a trailing newline —
      // reconstructed here rather than assumed, because this hook sees the
      // SOURCE lines and the kernel sees what the shell made of them.
      const heredoc = bodies.find(
        (body) => body.delimiter === 'FADENO_PROMPT' && body.quoted && body.unterminated !== true,
      );
      if (heredoc != null) bytes = `${heredoc.body.join('\n')}\n`;
    }
    if (bytes != null) break;
  }
  if (bytes == null || bytes.length === 0) return;

  try {
    const dir = join(cwd, '.fadeno', 'local');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'proxy-dispatches.jsonl'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        archetype: role,
        // Beyond the Claude twin's three fields, and safe to be: the reader
        // takes a two-field VIEW of a row (`spawnMarkerRow`, src/lib/spawn-markers.ts)
        // and rewrites keep the original, so a field a newer hook writes is
        // carried through untouched. The Claude spawn-side stash already
        // carries this one, and a fidelity refusal is exactly the moment
        // someone needs to know which build wrote the evidence.
        hook_version: HOOK_VERSION,
        prompt_sha256: callerPromptDigest(bytes),
      })}\n`,
    );
  } catch {
    // best-effort: never block the dispatch over evidence
  }
}

// ---------------------------------------------------------------------------
// Job 2: refuse the git subcommands that destroy a shared tree's work.
//
// Ordered BEFORE the marker write on purpose: a denied command never runs, so
// it must not leave a marker claiming a relay sent bytes that were never sent.
// ---------------------------------------------------------------------------

/**
 * The refusal list, each with the reason a role agent must hear. Byte-identical
 * to the Claude twin's, and it has to stay that way: an agent that is refused on
 * one harness and allowed on the other teaches that the rule is about the
 * harness rather than about the tree.
 *
 * Every one of these throws away uncommitted work or relocates the tree under
 * whoever else is writing in it, and none of them is ever part of a role
 * agent's job: a worker leaves its change in the tree, a reviewer and a judge
 * only read. `switch` is here although the field report named `checkout`: same
 * operation, newer spelling. `commit` is NOT here — it does not destroy anyone's
 * work, and denying it belongs to the role brief rather than to a guard about
 * destruction. `worktree remove` is not here either; it is out of the reported
 * class and untested, so it stays a stated gap rather than an untested rule.
 */
const DESTRUCTIVE_GIT = new Map([
  ['checkout', 'discards uncommitted changes to the paths it names and moves HEAD for every agent sharing this tree'],
  ['switch', 'moves HEAD for every agent sharing this tree'],
  ['restore', 'discards uncommitted changes to the paths it names'],
  ['reset', 'rewrites the index, and with --hard the working tree'],
  ['stash', 'removes every uncommitted change in the tree, including changes this dispatch did not make'],
  ['clean', 'deletes untracked files, including work no commit is holding'],
]);

/** Git global options that take a SEPARATE value, so the subcommand is 2 tokens on. */
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** The git subcommand a fragment invokes, plus its remaining tokens; null when it is not a git call. */
function gitInvocation(fragment) {
  const tokens = tokenize(fragment);
  let i = skipPrefix(tokens);
  if (!/(^|\/)git$/.test(tokens[i] ?? '')) return null;
  i += 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (GIT_GLOBAL_WITH_VALUE.has(token)) { i += 2; continue; }
    if (token.startsWith('-')) { i += 1; continue; }
    return { sub: token, rest: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * Whether this particular invocation is one of the READ-ONLY spellings of an
 * otherwise destructive subcommand. Narrow on purpose: an agent inspecting
 * state should not have to argue with a guard about destruction.
 */
function isReadOnlyGit(sub, rest) {
  if (sub === 'stash') return rest.length > 0 && (rest[0] === 'list' || rest[0] === 'show');
  if (sub === 'clean') return rest.some((token) => token === '-n' || token === '--dry-run');
  return false;
}

function denyRole(sub, harm) {
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `fadeno ${role}: \`git ${sub}\` is refused inside a Fadeno role agent because it ${harm}. ` +
        'This tree is shared with the host and, often, with other agents working at the same time, ' +
        'and their uncommitted work is not recoverable once it is gone. Leave the working tree as ' +
        'it is: if your own edit was wrong, edit the file back to what it should be; if the tree ' +
        'is in a state you cannot work from, stop and say so in your report — naming the files and ' +
        'what you believe is wrong — and let the host decide. Do not route around this by other ' +
        'means (a script, an alias, a different spelling): the refusal is the answer, not an ' +
        'obstacle to the answer. Report this refusal to the user instead of routing around it.',
    },
  });
}

for (const fragment of shellFragments(control)) {
  const invocation = gitInvocation(fragment);
  if (invocation == null) continue;
  const harm = DESTRUCTIVE_GIT.get(invocation.sub);
  if (harm == null) continue;
  if (isReadOnlyGit(invocation.sub, invocation.rest)) continue;
  denyRole(invocation.sub, harm);
}

// Nothing was refused, so this call is going to run: now the marker is a claim
// about bytes that will actually be sent.
markRelay();

finish(null);

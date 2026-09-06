#!/usr/bin/env node
// PreToolUse Bash guard for Fadeno's managed agents. Two jobs, two audiences.
//
// 1. DISPATCH PROXIES (tier-2 enforcement of the relay contract). The proxies'
//    instructions already forbid doing the task in-session, but
//    instruction-only constraint is advisory — a 2026-08-12 dogfood A/B
//    observed a proxy silently performing its task with no dispatch and no
//    evidence row. This hook makes the contract mechanical: inside a dispatch
//    proxy, the only Bash allowed is the contract call itself (and, after a
//    killed or timed-out dispatch, `fadeno dispatches --output last` or a
//    dispatch id — both CLI spellings — so the streamed snapshot can be
//    recovered), and the dispatch invocation gets the long tool timeout the
//    external executor needs.
//
// 2. ROLE AGENTS (`worker`, `reviewer`, `judge`) get one narrow refusal: the
//    git subcommands that DESTROY uncommitted work in the tree they share
//    with everyone else. Reported 2026-09-05 from a live campaign — a worker
//    ran `git checkout -- <file>` in the shared tree despite the dispatch's
//    explicit "do NOT commit, stash, checkout, or reset", lost its own edits
//    and redid them. It was lucky: the file was its own. A shared one would
//    have destroyed another agent's work with no record that it happened.
//    Role agents are otherwise unrestricted — this is a guardrail, not an
//    allowlist.
//
// Scope, stated honestly because it is PARTIAL:
//   - Fires on every Bash PreToolUse and no-ops unless `agent_type` names a
//     dispatch proxy or a role agent. The main session is never guarded: the
//     host legitimately runs every one of these commands.
//   - A role agent spawned as a PLAIN `claude`-type subagent rather than as
//     `fadeno:worker`/`reviewer`/`judge` carries no identifying `agent_type`
//     and is NOT covered. Nothing here can distinguish it from any other
//     generic subagent, so coverage follows the agent TYPE, not the job.
//   - Codex-hosted role agents are not covered, because Fadeno wires no Bash
//     guard there yet — `templates/codex/hooks/` registers PreToolUse only on
//     the spawn tool. That is a GAP IN OUR WIRING, not a Codex limit: Codex
//     0.153.4 fires PreToolUse for every tool (`bash`, `local_shell`) and its
//     payload carries `tool_input` and `agent_type`, which is everything this
//     guard reads. Verified against the schemas embedded in the shipped
//     binary (`pre-tool-use.command.input`), and `templates/codex/hooks/
//     spawn-guard.mjs` already reads `tool_input` off the same event.
//   - The statement splitter below is a tripwire, not a sandbox: it reads
//     shell text without being a shell. An agent that means to get around it
//     can (a script file, an alias, an odd quoting). It is here to stop the
//     reflex — the destructive habit a model reaches for mid-task — which is
//     what the field report actually was.
//
// The heredoc BODY of a proxy contract call is the user's task prompt —
// arbitrary bytes, never inspected; only the surrounding shell statements are
// validated.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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

if (event?.tool_name !== 'Bash' || event.tool_input == null || typeof event.tool_input !== 'object') {
  finish(null);
}

const agent = typeof event.agent_type === 'string' ? event.agent_type.split(':').at(-1) : null;
const PROXY_RE = /^dispatch-(worker|reviewer|judge)$/;
// The managed role agents. Matched on the same stripped last segment as the
// proxies, so `fadeno:worker` and a bare `worker` both land here — and, by the
// same token, so would another plugin's agent named `worker`. Denying six git
// subcommands to a stranger's `worker` is a cost worth paying for covering
// ours; the reverse (missing ours) is the failure this exists to stop.
const ROLE_RE = /^(worker|reviewer|judge)$/;
const proxyMatch = agent == null ? null : agent.match(PROXY_RE);
const roleMatch = agent == null ? null : agent.match(ROLE_RE);
// The main loop and every unmanaged agent stay unguarded.
if (proxyMatch == null && roleMatch == null) finish(null);
const archetype = proxyMatch?.[1] ?? null;

function deny(reason) {
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `dispatch proxy contract: ${reason} The only Bash a dispatch proxy may run is the single ` +
        `contract call: fadeno dispatch --archetype ${archetype} --tag ${archetype}-<slug> ` +
        `<<'FADENO_PROMPT' ...the verbatim task prompt... FADENO_PROMPT — the kernel snapshots ` +
        `the prompt and writes the evidence rows itself. Substitute <slug> with 2-4 hyphenated ` +
        `words naming this task; the tag accepts only letters, digits, dot, underscore and ` +
        `hyphen, so angle brackets left in place are refused here. Do not inspect the repo or ` +
        `attempt the task; relay the dispatch report verbatim instead.`,
    },
  });
}

const command = typeof event.tool_input.command === 'string' ? event.tool_input.command : null;

// ---------------------------------------------------------------------------
// Role agents: refuse the git subcommands that destroy a shared tree's work.
// ---------------------------------------------------------------------------

/**
 * The refusal list, each with the reason a role agent must hear. Every one of
 * these throws away uncommitted work or relocates the tree under whoever else
 * is writing in it, and none of them is ever part of a role agent's job: a
 * worker leaves its change in the tree, a reviewer and a judge only read.
 *
 * `switch` is here although the field report named `checkout`: it is the same
 * operation under the newer spelling, and a list that refused one and allowed
 * the other would be a hole anyone finds by accident. `commit` is NOT here —
 * it does not destroy anyone's work, and denying it belongs to the role brief
 * rather than to a guard about destruction. `worktree remove` is not here
 * either; it is out of the reported class and untested, so it stays a stated
 * gap rather than an untested rule.
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

/**
 * Split a Bash call into the fragments that could each START a command.
 *
 * Deliberately crude, and crude in the safe direction: over-splitting produces
 * fragments that simply do not begin with `git` and are ignored, while the one
 * thing it must not do is join a `git checkout` onto the tail of something
 * else and miss it. It is not a shell and does not pretend to be one — see the
 * scope note at the top of this file.
 */
function shellFragments(text) {
  return text
    .split(/\n|&&|\|\||;|\||\$\(|`|\(|\)|\{|\}/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

/** The git subcommand a fragment invokes, plus its remaining tokens; null when it is not a git call. */
function gitInvocation(fragment) {
  const tokens = fragment.split(/\s+/).filter((token) => token.length > 0);
  let i = 0;
  // Leading environment assignments and the wrappers that pass a command
  // through unchanged. `FOO=1 git reset` is a git reset.
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
  const bin = (tokens[i] ?? '').replace(/^["']|["']$/g, '');
  if (!/(^|\/)git$/.test(bin)) return null;
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

function denyRole(role, sub, harm) {
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
        'obstacle to the answer.',
    },
  });
}

if (proxyMatch == null) {
  // A role agent. One question only, then out of the way.
  if (command != null) {
    for (const fragment of shellFragments(command)) {
      const invocation = gitInvocation(fragment);
      if (invocation == null) continue;
      const harm = DESTRUCTIVE_GIT.get(invocation.sub);
      if (harm == null) continue;
      if (isReadOnlyGit(invocation.sub, invocation.rest)) continue;
      denyRole(roleMatch[1], invocation.sub, harm);
    }
  }
  finish(null);
}

if (command == null) deny('the Bash call carries no command string.');

// Strip quoted-heredoc bodies before validating statements. Only the QUOTED
// delimiter form is a valid opener — an unquoted <<FADENO_PROMPT would let
// the shell expand $/backticks inside the relayed prompt.
const controlLines = [];
const heredocBody = [];
let inHeredoc = false;
for (const line of command.split('\n')) {
  if (inHeredoc) {
    if (line === 'FADENO_PROMPT') { inHeredoc = false; continue; }
    heredocBody.push(line); // collected for its DIGEST only, never inspected
    continue; // prompt body — arbitrary bytes, deliberately uninspected
  }
  if (/<<-?\s*FADENO_PROMPT/.test(line)) {
    deny("the heredoc delimiter must be quoted (<<'FADENO_PROMPT') so the shell expands nothing inside the prompt.");
  }
  if (/<<-?\s*'FADENO_PROMPT'/.test(line)) inHeredoc = true;
  controlLines.push(line);
}
if (inHeredoc) deny("the FADENO_PROMPT heredoc is unterminated.");

const VAR = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
const PROMPT_DIR = String.raw`(\./)?\.fadeno/local/prompts`;
const PROMPT_FILE = String.raw`${PROMPT_DIR}/[A-Za-z0-9._-]+`;
// The CLI spellings: bare `fadeno` (matches the `Bash(fadeno:*)` permission
// rule — the primary contract), the plugin-root retry spelling, and the
// legacy conditional-expansion spelling.
const CLI = String.raw`(fadeno|"\$CLAUDE_PLUGIN_ROOT/bin/fadeno"|"\$\{CLAUDE_PLUGIN_ROOT[^"]*\}fadeno")`;
const HEREDOC_TAIL = String.raw` *<<-? *'FADENO_PROMPT'`;
const TAG = String.raw`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`;
// The isolation opt-out, ONLY on explicit caller request (see the proxy
// bodies): accepted between the archetype and the tag, nowhere else, and
// never combined with the other spellings. The proxy has no inspection
// tools and must never decide repo state itself — this just lets a caller's
// explicit "--shared" through the relay.
const SHARED = String.raw`( --shared)?`;
const ALLOWED = [
  // PRIMARY contract: the prompt piped on stdin via quoted heredoc — the
  // kernel snapshots it and writes the evidence rows itself. `--tag` is
  // optional in the grammar but expected in practice: it is the only handle
  // that survives this Bash call being killed at its timeout, which is exactly
  // when recovery is needed.
  new RegExp(String.raw`^${CLI} dispatch --archetype ${archetype}${SHARED}( --tag ${TAG})?${HEREDOC_TAIL}$`),
  // Retry of an already-written prompt file.
  new RegExp(
    String.raw`^${CLI} dispatch --archetype ${archetype} --prompt-file ("\$${VAR}"|\$${VAR}|"?${PROMPT_FILE}"?)$`,
  ),
  // Recovered executor output after a killed or timed-out dispatch. The
  // kernel streams stdout to the snapshot as it arrives, so the bytes
  // survive the kill. Both CLI spellings (`fadeno` and the plugin-root
  // retry) are covered by `CLI`.
  //
  // `--wait` is permitted and is the form proxies should reach for: a caller
  // that just timed out reads the ledger at the exact moment the completion
  // row is least likely to exist yet, and reading once is what turned two
  // successful dispatches into reported failures on 2026-08-13.
  // `tag:<handle>` is the recovery spelling that always parses — `--output`
  // takes a value, so `--output --tag x` would swallow the flag. A caller
  // recovering from a timeout should not also have to get flag ordering right.
  new RegExp(
    String.raw`^${CLI} dispatches --output (last|tag:${TAG}|[0-9a-fA-F-]{8,36})( --wait( [0-9]+)?)?$`,
  ),
  // LEGACY contract (older init-emitted proxy bodies still in the wild):
  // explicit prompt-file write before the dispatch.
  new RegExp(String.raw`^mkdir -p ${PROMPT_DIR}/?$`),
  new RegExp(String.raw`^${VAR}=\$\(mktemp ${PROMPT_DIR}/${archetype}-X{4,}\)$`),
  new RegExp(String.raw`^cat > ?"\$${VAR}"${HEREDOC_TAIL}$`),
  new RegExp(String.raw`^cat > ?"?${PROMPT_FILE}"?${HEREDOC_TAIL}$`),
];

const statements = controlLines
  .flatMap((line) => line.split(/&&|;/))
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);
if (statements.length === 0) deny('the Bash call contains no statements.');

let hasDispatch = false;
for (const statement of statements) {
  if (!ALLOWED.some((re) => re.test(statement))) {
    const shown = statement.length > 80 ? `${statement.slice(0, 77)}...` : statement;
    deny(`"${shown}" is outside the relay contract.`);
  }
  if (/ dispatch --archetype /.test(` ${statement}`)) hasDispatch = true;
}

/**
 * Record that a DISPATCH PROXY is the caller, keyed by the digest of the exact
 * bytes it is about to send.
 *
 * This is what lets `relay_attested: false` mean something. The spawn-side
 * stash (`pending-relays.jsonl`, written by dispatch-steering.mjs) proves a
 * relay-bound spawn happened; it cannot prove that any GIVEN dispatch is that
 * spawn. Without this marker the kernel read "fresh spawn-side entries exist
 * but none match" as a fidelity failure, when an ordinary un-relayed
 * `fadeno dispatch` colliding with someone else's entry inside the (1 hour)
 * freshness window produces exactly the same reading. Two such rows sit in
 * this repo's own ledger, and nothing can now say which case they were.
 *
 * With the marker the kernel can separate them: no marker means no proxy sent
 * this, so the verdict is `null` (not attested) rather than `false`.
 *
 * Digest only, never content — the prompt is the user's task text and this
 * hook does not read it.
 *
 * Best-effort, and that stays safe now that the kernel REFUSES on
 * `relay_attested: false` (predicate `relay_fidelity`): a failure to write
 * this marker loses the proxy claim, so the kernel reads `null` — "no proxy
 * sent this" — and a contract-conforming dispatch runs exactly as before. The
 * gate can only fire on a marker that was written, which is the direction a
 * best-effort write is allowed to be wrong in.
 *
 * Only the heredoc form is marked. The `--prompt-file` retry spelling carries
 * no bytes here (and its path may be a shell variable), so those dispatches
 * report `null`. Honest, and the rarer path.
 */
function markProxyDispatch() {
  if (heredocBody.length === 0) return;
  // No inferred cwd. This is a WRITE, and a caller that does not say which
  // repo it is in has not earned a guess — `process.cwd()` would be whatever
  // directory the harness happened to launch from. That fallback appended 22
  // marker rows into the developer's own repo from the test suite on
  // 2026-08-20. Claude Code always sends `cwd`; anything that does not simply
  // goes unattested, which is the honest outcome.
  const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : null;
  if (cwd == null) return;
  if (!existsSync(join(cwd, '.fadeno'))) return; // not a Fadeno repo
  try {
    const dir = join(cwd, '.fadeno', 'local');
    mkdirSync(dir, { recursive: true });
    // The shell feeds a quoted heredoc as each body line plus a trailing
    // newline — reconstructed here rather than assumed, because this hook sees
    // the SOURCE lines and the kernel sees what the shell made of them.
    const body = `${heredocBody.join('\n')}\n`;
    appendFileSync(
      join(dir, 'proxy-dispatches.jsonl'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        archetype,
        // The CALLER digest (`callerPromptDigest`, src/lib/executors.ts),
        // spelled by hand as everything else in a standalone hook is. Its
        // trailing-newline strip is precisely what makes the newline
        // reconstructed above stop mattering: this marker, the steering hook's
        // spawn-side stash (which hashes `tool_input.prompt`, usually with no
        // terminator at all) and the kernel's own read of the received bytes
        // all reduce to the same value for the same task.
        prompt_sha256: createHash('sha256').update(body.replace(/(?:\r?\n)+$/, '')).digest('hex'),
      })}\n`,
    );
  } catch {
    // best-effort: never block the dispatch over evidence
  }
}
if (hasDispatch) markProxyDispatch();

// Contract-conforming call: force the long tool timeout on the dispatch leg.
// External executors routinely exceed the 2-minute Bash default, and a
// timeout kill destroys their work mid-flight.
const timeout = event.tool_input.timeout;
if (hasDispatch && (typeof timeout !== 'number' || timeout < 600000)) {
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { timeout: 600000 },
    },
  });
}
finish(null);

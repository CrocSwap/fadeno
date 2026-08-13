#!/usr/bin/env node
// PreToolUse guard for the dispatch proxy agents (tier-2 enforcement of the
// relay contract). The proxies' instructions already forbid doing the task
// natively, but instruction-only constraint is advisory — a 2026-08-12
// dogfood A/B observed a proxy silently performing its task with no dispatch
// and no evidence row. This hook makes the contract mechanical: inside a
// dispatch proxy, the only Bash allowed is the contract call itself (and,
// after a killed or timed-out dispatch, `fadeno dispatches --output last`
// or a dispatch id — both CLI spellings — so the streamed snapshot can be
// recovered), and the dispatch invocation gets the long tool timeout the
// external executor needs.
//
// Scope: fires on every Bash PreToolUse, no-ops unless the hook input's
// `agent_type` is one of the dispatch proxies. The heredoc BODY is the user's
// task prompt — arbitrary bytes, never inspected; only the surrounding shell
// statements are validated.
import { readFileSync } from 'node:fs';

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
const proxyMatch = agent == null ? null : agent.match(PROXY_RE);
if (proxyMatch == null) finish(null); // every other agent (and the main loop) stays unguarded
const archetype = proxyMatch[1];

function deny(reason) {
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `dispatch proxy contract: ${reason} The only Bash a dispatch proxy may run is the single ` +
        `contract call: fadeno dispatch --archetype ${archetype} <<'FADENO_PROMPT' ` +
        `...the verbatim task prompt... FADENO_PROMPT — the kernel snapshots the prompt and ` +
        `writes the evidence rows itself. Do not inspect the repo or attempt the task; relay ` +
        `the dispatch report verbatim instead.`,
    },
  });
}

const command = typeof event.tool_input.command === 'string' ? event.tool_input.command : null;
if (command == null) deny('the Bash call carries no command string.');

// Strip quoted-heredoc bodies before validating statements. Only the QUOTED
// delimiter form is a valid opener — an unquoted <<FADENO_PROMPT would let
// the shell expand $/backticks inside the relayed prompt.
const controlLines = [];
let inHeredoc = false;
for (const line of command.split('\n')) {
  if (inHeredoc) {
    if (line === 'FADENO_PROMPT') inHeredoc = false;
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
const ALLOWED = [
  // PRIMARY contract: the prompt piped on stdin via quoted heredoc — the
  // kernel snapshots it and writes the evidence rows itself.
  new RegExp(String.raw`^${CLI} dispatch --archetype ${archetype}${HEREDOC_TAIL}$`),
  // Retry of an already-written prompt file.
  new RegExp(
    String.raw`^${CLI} dispatch --archetype ${archetype} --prompt-file ("\$${VAR}"|\$${VAR}|"?${PROMPT_FILE}"?)$`,
  ),
  // Recovered executor output after a killed or timed-out dispatch. The
  // kernel streams stdout to the snapshot as it arrives, so the bytes
  // survive the kill. Both CLI spellings (`fadeno` and the plugin-root
  // retry) are covered by `CLI`.
  new RegExp(String.raw`^${CLI} dispatches --output (last|[0-9a-fA-F-]{8,36})$`),
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

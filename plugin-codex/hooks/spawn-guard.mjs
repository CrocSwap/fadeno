#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which generation of this hook wrote a given evidence row. Same contract, and
// the same reason, as the Claude steering hook's stamp: plugin hooks load once
// at session start, so a live session keeps running the previous build after an
// upgrade. `fadeno plugin --codex` replaces this literal with the package
// version; the template keeps 'dev', so a row reading 'dev' means the template
// was executed directly rather than an installed copy.
const HOOK_VERSION = '0.6.1';

/**
 * How long `fadeno dial resolve` gets to answer before it is killed. Named
 * because the refusal row records it: a reader who sees `resolver_timeout`
 * immediately wants to know whether the budget that expired was ten seconds
 * or one.
 */
const RESOLVE_TIMEOUT_MS = 10_000;

/**
 * Codex's `PreToolUse` answer shapes, as measured against the primary doc
 * (2026-09-04): exit 0 with NO stdout allows the call unchanged, and a deny is
 * the object below. `updatedInput` is accepted only alongside
 * `permissionDecision: "allow"` — and this hook never rewrites a spawn anyway,
 * for the reason in `driftFacts`.
 */
function finish(value) {
  if (value != null) process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

/**
 * The last sentence of EVERY refusal this hook writes, appended here rather
 * than at each call site so no deny path can be added without it.
 *
 * Host mode's policy is that a Fadeno failure is a user-facing event: the
 * 2026-09-04 basanos receipt is a host that met a refusal, wrote a dutiful
 * feedback entry, and then quietly spawned generic subagents on a frontier
 * model instead of telling the user. The refusal text is the one thing the
 * model is guaranteed to read at that moment, so it carries the instruction.
 * This is the one place that receipt is cited; everywhere else below states
 * the rule it produced — an unsteered spawn must not read as no spawn.
 */
const REPORT_REFUSAL = 'Report this refusal to the user instead of routing around it.';

function deny(reason) {
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      // One paragraph, always: a resolver's stderr is neither short nor
      // single-line, and every refusal text obeys the same rule as its row.
      permissionDecisionReason: `${String(reason).replace(/\s+/g, ' ').trim()} ${REPORT_REFUSAL}`,
    },
  });
}

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  finish(null);
}
if (event == null || typeof event !== 'object' || Array.isArray(event)) finish(null);

// Codex names the local function tool `spawn_agent` and matches it with the
// `Agent` matcher. Accept either spelling so a matcher change upstream cannot
// silently turn this hook into a no-op.
if (event.tool_name !== 'spawn_agent' && event.tool_name !== 'Agent') finish(null);
const input = event.tool_input;
if (input == null || typeof input !== 'object' || Array.isArray(input)) finish(null);

const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : process.cwd();
// Evidence is only ever written into a repo that already has a `.fadeno/`
// tree. The Claude hook applies the same rule: a hook must never be the thing
// that creates a Fadeno directory in a repo that opted out.
const ledger = existsSync(join(cwd, '.fadeno'));

/**
 * Whether the user turned Fadeno host mode on for THIS Codex session.
 *
 * The marker path is duplicated from `templates/common/plugin/host-mode-hook.mjs`
 * — same env var, same sha256 of `session_id`, same `<root>/host-mode/<key>.enabled`
 * layout — and from the Claude steering hook, which duplicates it for the same
 * reason: a standalone hook script has no import path into the rest of the
 * plugin. Change one, change all three. (Codex hands a subagent hook the PARENT
 * session's id, which is exactly the session whose marker this is.)
 */
function hostModeEnabled() {
  const root = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
  if (typeof root !== 'string' || root.trim() === '' || sessionId === '') return false;
  const key = createHash('sha256').update(sessionId).digest('hex');
  // `root`, not `root.trim()`: `markerPath()` in the twin joins the untrimmed
  // value, so that is the path the marker is WRITTEN to. Trimming here would
  // send a reader looking somewhere the writer never wrote. The trim above is
  // only the emptiness check, exactly as the twin does it.
  return existsSync(join(root, 'host-mode', `${key}.enabled`));
}

const hostMode = hostModeEnabled();
const agentType = typeof input.agent_type === 'string' && input.agent_type.length > 0
  ? input.agent_type
  : null;
const message = typeof input.message === 'string' ? input.message : '';
const promptDigest = message.length > 0 ? createHash('sha256').update(message).digest('hex') : null;
// The model a spawn will actually run on when it names none of its own: the
// active model of the session that is spawning. Codex publishes it on the
// event, and it is the single most useful fact in a refusal — an unsteered
// spawn that inherits a frontier model must not read as no spawn at all.
const parentModel = typeof event.model === 'string' && event.model.length > 0 ? event.model : null;
const requestedModel = typeof input.model === 'string' && input.model.length > 0 ? input.model : null;
const requestedEffort =
  typeof input.reasoning_effort === 'string' && input.reasoning_effort.length > 0
    ? input.reasoning_effort
    : null;
const forkTurns = typeof input.fork_turns === 'string' && input.fork_turns.length > 0
  ? input.fork_turns
  : null;

// --- Codex agent files -------------------------------------------------------

/** `# fadeno:managed` — the first line `steering apply` / `init` stamp. */
const MANAGED_MARK = '# fadeno:managed';
/** The role slots `steering apply --codex` materializes. */
const ARCHETYPES = ['worker', 'reviewer', 'judge'];
// Copied from src/lib/codex-agent-file.ts, not imported: this script runs
// standalone from a plugin cache with no path back into the CLI. Keep the two
// in step — they read the same files for the same facts.
const NAME_RE = /^name\s*=\s*"((?:[^"\\]|\\.)*)"/m;
const MODEL_RE = /^model\s*=\s*"((?:[^"\\]|\\.)*)"/m;
const EFFORT_RE = /^model_reasoning_effort\s*=\s*"((?:[^"\\]|\\.)*)"/m;
const HOST_EXECUTOR_RE = /--host-executor\s+(\S+)(?:\s+via\s+(\S+))?/;

function unquoteToml(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

function userAgentDir() {
  const home = typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME.trim() !== ''
    ? process.env.CODEX_HOME.trim()
    : join(homedir(), '.codex');
  return join(home, 'agents');
}

/**
 * The managed Fadeno agent file Codex would load for `type`, or null.
 *
 * Scope precedence mirrors `effectiveCodexAgentCandidates`: a project-scope
 * file shadows the user-scope one entirely. The filenames differ by scope —
 * `codexAgentFilePath` writes `<archetype>.toml` at project scope and
 * `fadeno-<archetype>.toml` at user scope — so both are probed for the name
 * the spawn asked for.
 *
 * Classification is EXACT, and deliberately so: this function's answer decides
 * whether a spawn is refused as generic, and whether an identity read off a
 * file is attributed to it. Three rules, each closing a way to be wrong:
 *
 * 1. `type` must be a bare agent name. A `/`, `\` or `..` in it would aim the
 *    lookup outside the two directories Codex itself resolves, so it is not an
 *    unmanaged agent — it is not a name at all.
 * 2. The managed header is the whole licence. A hand-authored `worker.toml` is
 *    the user's own file: Fadeno neither claims it nor reads an identity out of
 *    it, so a spawn naming it is GENERIC and refused in host mode like any other.
 * 3. The file's `name` key must equal the spawned type. Codex resolves a custom
 *    agent by that key, not by its filename — measured 2026-09-04, where
 *    `agent_type: reviewer` loaded `~/.codex/agents/fadeno-reviewer.toml`, whose
 *    `name` is `reviewer`. So a `fadeno-worker.toml` that says `name = "reviewer"`
 *    is not the file a `worker` spawn runs, and claiming its identity would put a
 *    reviewer's model on a worker's row. For the same reason `fadeno-<archetype>`
 *    is not itself a spawnable type: no managed file declares that name.
 */
function managedAgentFile(type) {
  if (type.includes('/') || type.includes('\\') || type.includes('..')) return null;
  const candidates = [
    join(cwd, '.codex', 'agents', `${type}.toml`),
    join(userAgentDir(), `${type}.toml`),
    join(userAgentDir(), `fadeno-${type}.toml`),
  ];
  const seen = new Set();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    let text;
    try {
      if (!existsSync(path)) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // unreadable is not provably Fadeno's
    }
    if (!text.startsWith(MANAGED_MARK)) return null; // shadows: this IS the file, and it is not ours
    const nameMatch = NAME_RE.exec(text);
    const name = nameMatch ? unquoteToml(nameMatch[1]) : null;
    if (name !== type) return null; // shadows too: managed, but not this agent
    const modelMatch = MODEL_RE.exec(text);
    const effortMatch = EFFORT_RE.exec(text);
    const executorMatch = HOST_EXECUTOR_RE.exec(text);
    return {
      path,
      name,
      model: modelMatch ? unquoteToml(modelMatch[1]) : null,
      reasoningEffort: effortMatch ? unquoteToml(effortMatch[1]) : null,
      hostExecutor: executorMatch
        ? (executorMatch[2] != null ? `${executorMatch[1]} via ${executorMatch[2]}` : executorMatch[1])
        : null,
    };
  }
  return null;
}

const agentFile = agentType == null ? null : managedAgentFile(agentType);
const archetype = agentFile?.name ?? null;

// --- Evidence ---------------------------------------------------------------

/** The same bound the Claude hook puts on a refusal it writes to the log. */
const REFUSAL_REASON_MAX = 400;

function appendRow(row) {
  if (!ledger) return; // not a Fadeno repo: never create the tree from a hook
  try {
    appendFileSync(join(cwd, '.fadeno', 'dispatches.jsonl'), `${JSON.stringify(row)}\n`);
  } catch {
    // best-effort: evidence is a trace, never a gate on the decision
  }
}

/**
 * The frozen identity this spawn would run on, as both row shapes record it.
 * One object rather than two literals: a refusal and a delivery must never
 * disagree about what the file said.
 */
const agentFileRow = agentFile == null
  ? null
  : {
      path: agentFile.path,
      model: agentFile.model,
      reasoning_effort: agentFile.reasoningEffort,
      host_executor: agentFile.hostExecutor,
    };

/**
 * The resolver's answer, once it has been read and found usable. Declared here
 * rather than beside the resolve call because `recordHostDelivery` below closes
 * over it (`recordHostRefusal` is handed the slot it should describe), and a
 * writer must be defined before the paths that call it.
 */
let slot = null;

/**
 * Evidence for a spawn this guard DENIED. Same event name and the same
 * `refusal: {predicate, message}` shape the Claude steering hook writes, so
 * `fadeno dispatches` renders both without knowing which harness refused.
 *
 * Deliberately no prompt snapshot, for the Claude hook's reason: nothing was
 * delivered, and a denial is the failure mode that repeats.
 */
function recordHostRefusal(predicate, reason, refusedSlot) {
  const flat = String(reason).replace(/\s+/g, ' ').trim();
  appendRow({
    // Duplicated from DISPATCHES_FORMAT in src/commands/dispatch.ts by hand,
    // exactly as the Claude hook duplicates it. Bump them together.
    format: '1.1',
    timestamp: new Date().toISOString(),
    event: 'host_refused',
    fadeno_version: HOOK_VERSION,
    hook_version: HOOK_VERSION,
    host: 'codex',
    archetype,
    agent_type: agentType,
    refusal: {
      predicate,
      message: flat.length > REFUSAL_REASON_MAX ? `${flat.slice(0, REFUSAL_REASON_MAX - 1)}…` : flat,
    },
    timeout_ms: predicate === 'resolver_timeout' ? RESOLVE_TIMEOUT_MS : null,
    executor: typeof refusedSlot?.executor === 'string' ? refusedSlot.executor : null,
    model: typeof refusedSlot?.model === 'string' ? refusedSlot.model : null,
    model_id: typeof refusedSlot?.model_id === 'string' ? refusedSlot.model_id : null,
    model_override: requestedModel,
    effort: typeof refusedSlot?.effort === 'string' ? refusedSlot.effort : null,
    effort_pinned: typeof refusedSlot?.effort_pinned === 'boolean' ? refusedSlot.effort_pinned : null,
    // Codex publishes no session-effort env to a hook command, so this hook
    // never observes one. Null rather than omitted, so the row shape matches
    // the Claude hook's and a reader can diff them.
    session_effort: null,
    lane: typeof refusedSlot?.lane === 'string' ? refusedSlot.lane : null,
    lane_reason: typeof refusedSlot?.lane_reason === 'string' ? refusedSlot.lane_reason : null,
    parent_model: parentModel,
    agent_file: agentFileRow,
    prompt_sha256: promptDigest,
  });
}

/**
 * Evidence for a managed spawn this guard let through. The Codex twin of the
 * Claude hook's `host_delivery` row, field for field where the two harnesses
 * can observe the same thing, plus the two facts only this side has: the agent
 * file's frozen identity and whether it has drifted from the dial.
 *
 * `lane` and `lane_reason` come from the CALLER, not from `slot`: for a
 * host-adapter dial the guard establishes the lane itself (see the drift
 * section), and a row that echoed the resolver's answer there would state the
 * opposite of what happened.
 */
function recordHostDelivery(extra) {
  if (!ledger) return;
  let snapshotRel = null;
  if (message.length > 0 && promptDigest != null) {
    try {
      snapshotRel = `.fadeno/local/prompts/host-${promptDigest.slice(0, 8)}.md`;
      mkdirSync(join(cwd, '.fadeno', 'local', 'prompts'), { recursive: true });
      writeFileSync(join(cwd, snapshotRel), message, 'utf8');
    } catch {
      snapshotRel = null;
    }
  }
  appendRow({
    format: '1.1',
    timestamp: new Date().toISOString(),
    event: 'host_delivery',
    fadeno_version: HOOK_VERSION,
    hook_version: HOOK_VERSION,
    host: 'codex',
    archetype,
    agent_type: agentType,
    executor: typeof slot?.executor === 'string' ? slot.executor : null,
    model: typeof slot?.model === 'string' ? slot.model : null,
    model_id: typeof slot?.model_id === 'string' ? slot.model_id : null,
    model_override: requestedModel,
    // What the spawn RUNS on, the same key the Claude hook carries so the two
    // row shapes diff cleanly. The file's model when it declares one, because
    // on Codex the file wins; otherwise the session's, because a neutral
    // (`current-host`) agent file deliberately declares none and inherits.
    model_applied: agentFile?.model ?? parentModel,
    effort: typeof slot?.effort === 'string' ? slot.effort : null,
    effort_pinned: typeof slot?.effort_pinned === 'boolean' ? slot.effort_pinned : null,
    // Never observed on Codex: no effort env reaches a hook command.
    session_effort: null,
    // What the spawn will actually run at — the FILE's effort, not the dial's,
    // because the file wins. `drift` below says whether those are the same.
    reasoning_effort: agentFile?.reasoningEffort ?? requestedEffort ?? 'inherited',
    lane: extra.lane,
    lane_reason: extra.lane_reason ?? null,
    dial_source: typeof slot?.source === 'string' ? slot.source : null,
    // The EXECUTOR harness and the lane variant the resolver chose. Under
    // format 1.0 this pair was one field named `driver`, and `harness` above
    // meant the host; 1.1 gives each its own name.
    harness: typeof slot?.harness === 'string' ? slot.harness : null,
    variant: typeof slot?.variant === 'string' ? slot.variant : null,
    transport: 'host',
    agent_file: agentFileRow,
    // true / false / null — null means the resolver never answered, so drift
    // is unknown rather than absent.
    drift: extra.drift,
    resolver: extra.resolver,
    parent_model: parentModel,
    fork_turns: forkTurns,
    prompt_sha256: promptDigest,
    prompt_snapshot: snapshotRel,
  });
}

// --- Generic spawns ---------------------------------------------------------

/** The managed role agents this repo/user actually has, for the refusal text. */
function availableRoleAgents() {
  return ARCHETYPES.filter((name) => managedAgentFile(name) != null);
}

if (agentFile == null) {
  if (!hostMode) {
    // Host mode off: Fadeno states no opinion on generic subagents, so the
    // spawn goes through untouched. The row is still written, because the rule
    // this guard exists for is that an unsteered spawn must not read as no
    // spawn — "nobody was watching" must not be one of the states the log can
    // be in.
    appendRow({
      format: '1.1',
      timestamp: new Date().toISOString(),
      event: 'native_spawn',
      fadeno_version: HOOK_VERSION,
      hook_version: HOOK_VERSION,
      host: 'codex',
      agent_type: agentType,
      // What the caller asked for, and what the spawn inherits when it asks
      // for nothing. Both, always: `model_inherited` alone cannot say whether
      // a model was chosen, and `model_requested` alone is null for exactly
      // the spawns that cost the most.
      model_requested: requestedModel,
      model_inherited: parentModel,
      reasoning_effort: requestedEffort,
      fork_turns: forkTurns,
      transport: 'host',
      // No snapshot file: a generic spawn is not a Fadeno delivery, and the
      // digest is enough to correlate one against a later dispatch of the
      // same prompt. (The Claude hook declines snapshots on its refusal path
      // for the same reason — a file per spawn litters the tree.)
      prompt_sha256: promptDigest,
    });
    finish(null);
  }
  const available = availableRoleAgents();
  recordHostRefusal(
    'generic_spawn_in_host_mode',
    `generic agent_type ${agentType ?? '(unnamed)'} refused; would have run on ` +
      `${requestedModel ?? parentModel ?? 'the parent session model'}`,
    null,
  );
  deny(
    `fadeno: host mode is on for this session, and it refuses generic (non-archetype) ` +
      `subagents. This spawn asked for agent_type "${agentType ?? '(unnamed)'}", which has no managed ` +
      `Fadeno role agent, so it would have run on ` +
      `${requestedModel != null
        ? `the model it named (${requestedModel})`
        : parentModel != null
          ? `this session's model (${parentModel})`
          : "the parent session's model"} ` +
      `with no dial, no resolved identity, and no evidence row naming what ran. ` +
      `${available.length > 0
        ? `Managed role agents available here: ${available.join(', ')}. Spawn one of those instead`
        : 'This repo has no managed role agent yet — run `fadeno steering apply --codex` to materialize ' +
          'worker, reviewer and judge, then spawn one of those'}` +
      ` (run \`fadeno dial\` to see the identity each one carries), or route the work through a Fadeno ` +
      `playbook. To allow generic subagents again for the rest of this session, run \`$fadeno-host off\`.`,
  );
}

// --- Managed archetype spawns ------------------------------------------------

/**
 * The `fadeno` this hook resolves dials with.
 *
 * `PLUGIN_ROOT` is what Codex interpolates into the hook command, so it is the
 * ordinary answer — but it is not guaranteed, and a hook that silently fell
 * back to PATH when it was absent would resolve dials with whatever `fadeno`
 * the user happens to have installed rather than the one it shipped beside.
 * `<plugin>/hooks/spawn-guard.mjs` and `<plugin>/bin/fadeno` are siblings by
 * construction in `fadeno plugin --codex`, so this script can find its own
 * bundle from its own URL. PATH is the last resort; when even that misses,
 * `spawnSync` reports ENOENT and the refusal below names it.
 */
function resolveCli() {
  const root = typeof process.env.PLUGIN_ROOT === 'string' ? process.env.PLUGIN_ROOT.trim() : '';
  const candidates = root !== '' ? [join(root, 'bin', 'fadeno')] : [];
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fadeno'));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // an unreadable candidate is simply not the one
    }
  }
  return 'fadeno';
}

const cli = resolveCli();
const resolveArgv = ['dial', 'resolve', '--archetype', archetype];
if (promptDigest != null) resolveArgv.push('--prompt-sha256', promptDigest);
// The resolver must see only THIS harness. A Codex session launched from a
// Claude Code shell inherits CLAUDE_EFFORT, and the resolver would then answer
// on another harness's session effort — a lane reason no Codex hook can
// honestly assert. Dropping it makes "session effort unobserved" true by
// construction, which the proof below relies on.
const resolverEnv = { ...process.env, FADENO_HARNESS: 'codex' };
delete resolverEnv.CLAUDE_EFFORT;
const resolution = spawnSync(cli, resolveArgv, {
  cwd,
  env: resolverEnv,
  encoding: 'utf8',
  timeout: RESOLVE_TIMEOUT_MS,
});
// Same split, and the same two predicates, as the Claude hook: a killed child
// reports no status and Node signs the kill, while a spawn that never started
// (no `fadeno` on PATH) also has a null status but needs the opposite remedy.
const timedOut =
  resolution.status == null &&
  (resolution.error?.code === 'ETIMEDOUT' || resolution.signal != null);
const errorCode = typeof resolution.error?.code === 'string' ? resolution.error.code : null;

/**
 * Refuse a spawn whose identity the resolver never established, or record it
 * as unverified when host mode is off. Both resolver failures below end here,
 * so they cannot drift apart on what the row says versus what the user reads.
 */
function resolverFix(resolverState) {
  if (resolverState === 'timeout') {
    return `Raise the resolver budget or find what \`fadeno dial resolve --archetype ${archetype}\` is waiting on.`;
  }
  if (errorCode != null) {
    return `Install the fadeno CLI, or set PLUGIN_ROOT so the plugin's bundled one is found (${errorCode}).`;
  }
  return `Fix the resolver (\`fadeno dial resolve --archetype ${archetype}\` reproduces it).`;
}

function resolverFailed(predicate, reason, resolverState) {
  if (hostMode) {
    recordHostRefusal(predicate, reason, null);
    deny(
      `fadeno: could not resolve the ${archetype} dial for this spawn — ${reason}. Fadeno host mode ` +
        `is on, so refusing a spawn whose identity nothing verified rather than letting the agent ` +
        `file's own model run unchecked. ${resolverFix(resolverState)} To spawn it unverified for the rest ` +
        `of this session, run \`$fadeno-host off\`.`,
    );
  }
  // Host mode off: the spawn goes through, but the row says the identity on it
  // was never resolved rather than leaving a gap a reader would read as "fine".
  recordHostDelivery({ resolver: resolverState, lane: null, lane_reason: null, drift: null });
  finish(null);
}

if (resolution.status !== 0) {
  const stderr = (resolution.stderr ?? '').trim();
  const reason = timedOut
    ? `fadeno dial resolve did not answer within ${RESOLVE_TIMEOUT_MS}ms` +
      `${resolution.signal != null ? ` (killed with ${resolution.signal})` : ''}`
    : errorCode != null
      ? `fadeno dial resolve could not be started: ${cli} failed with ${errorCode}` +
        `${stderr.length > 0 ? ` — ${stderr}` : ''}`
      : stderr.length > 0
        ? stderr
        : 'fadeno dial resolve failed';
  resolverFailed(timedOut ? 'resolver_timeout' : 'resolver_error', reason, timedOut ? 'timeout' : 'failed');
}

let parsed = null;
let parseFailed = false;
try {
  parsed = JSON.parse(resolution.stdout ?? '');
} catch {
  parseFailed = true;
}
const readable =
  !parseFailed && parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) &&
  (parsed.adapter === 'command' || parsed.adapter === 'host');
if (!readable) {
  // Exit 0 with stdout this hook cannot read: an older or wedged `fadeno`, an
  // empty answer, or an object naming no adapter. It is NOT evidence of a wrong
  // identity — but it is not evidence of a right one either, and in host mode
  // an unestablished identity is refused exactly like a resolver that failed
  // outright. The `{}` case must reach this branch rather than the drift check,
  // which would otherwise read its missing `model` as "resolves to the session
  // model" and refuse with a reason that names the wrong problem.
  const detail = parseFailed
    ? 'its stdout was not JSON'
    : parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)
      ? 'its stdout was not a JSON object'
      : `its resolution named no known adapter (adapter: ${JSON.stringify(parsed.adapter ?? null)})`;
  resolverFailed(
    'resolver_error',
    `fadeno dial resolve exited 0 with an unreadable resolution — ${detail}`,
    'unreadable',
  );
}
slot = parsed;

const declaredLane = typeof slot.lane === 'string' ? slot.lane : null;
const lane =
  declaredLane === 'host' || declaredLane === 'command' || declaredLane === 'restart_required'
    ? declaredLane
    : slot.adapter === 'command'
      ? 'command'
      : 'host';
const declaredReason = typeof slot.lane_reason === 'string' ? slot.lane_reason : null;

// A COMMAND-adapter dial materializes a broker file. That file bakes the
// RELAY's model and effort (the identity the broker itself runs at) and no
// `--host-executor`; the dial's own identity travels out of process in the
// dispatch argv, so nothing in the file can drift from the dial. Brokering
// the dial is that agent's own business: its developer instructions run `steering resolve` and
// dispatch out of process from inside the subagent. Record the lane the
// resolver named and do not second-guess it.
if (slot.adapter === 'command') {
  recordHostDelivery({ resolver: 'ok', lane, lane_reason: declaredReason, drift: null });
  finish(null);
}

/**
 * Does the frozen agent file still carry the identity the dial resolves to?
 *
 * This is the whole reason the Codex guard cannot mirror the Claude one. On
 * Claude a stale host agent is FIXED at spawn time by stamping the resolved
 * model onto `updatedInput`. On Codex the agent file's `model` and
 * `model_reasoning_effort` WIN over an explicit spawn value — measured
 * 2026-09-04: two reviewer spawns passing `gpt-5.6-sol` explicitly both ran at
 * the file's `gpt-5.6-luna` — so a rewrite here would change nothing except
 * what the evidence row claims. Detect and refuse; never rewrite.
 *
 * A `current-host` slot names no provider-servable model, and
 * `renderCodexHostAgent` deliberately omits BOTH identity lines for it, so the
 * expected file state there is "no model, no effort" rather than the literal.
 */
function driftFacts() {
  const neutral = slot.model === 'current-host';
  const expectedModel = neutral ? null : (typeof slot.model_id === 'string' ? slot.model_id : null);
  const expectedEffort = neutral
    ? null
    : (typeof slot.effective_effort === 'string' ? slot.effective_effort : null);
  const expectedExecutor = typeof slot.executor === 'string' ? slot.executor : null;
  return {
    expectedModel,
    expectedEffort,
    expectedExecutor,
    drifted:
      agentFile.model !== expectedModel ||
      agentFile.reasoningEffort !== expectedEffort ||
      agentFile.hostExecutor !== expectedExecutor,
  };
}

// Every HOST-adapter dial is adjudicated, whatever lane the resolver named,
// because a host-adapter dial is exactly the one that materializes an agent
// file with a baked identity — and this spawn is about to run on that file.
//
// The resolver cannot see the lane from outside: `dial resolve` reads the
// session's effort from `CLAUDE_EFFORT`, which Codex never publishes, so a
// PINNED host dial (`luna@xhigh`) always answers `session effort unobserved`
// and lands on `command` (or `restart_required` when the slot declares no
// fallback). Routing drift on that answer skipped the check for exactly the
// dials whose identity is pinned hardest.
const facts = driftFacts();
if (!facts.drifted) {
  // The file IS the proof the resolver lacked. `decideLane` takes it as
  // `hostEffortProven`, and this is the same substitution: a file cut from
  // this very executor, carrying this very effort, is delivered in-host at
  // that identity. `deliveryIsHost` is `adapter === 'host'`, so for this
  // branch the model half of the lane predicate already holds and the effort
  // half is what the proof supplies — the resolver's off-host answer can only
  // have come from the unobserved session effort. The file must actually CARRY
  // the pin: a `current-host` file bakes a `--host-executor` but no effort, so
  // it proves nothing about effort and the resolver's answer stands.
  const proven =
    facts.expectedExecutor != null &&
    lane !== 'host' &&
    agentFile?.reasoningEffort != null &&
    agentFile.reasoningEffort === facts.expectedEffort;
  recordHostDelivery({
    resolver: 'ok',
    lane: proven ? 'host' : lane,
    // The closed `LaneReason` vocabulary member for exactly this proof, so
    // `fadeno dispatches` can still group on it.
    lane_reason: proven ? 'host agent pins the same effort' : declaredReason,
    drift: false,
  });
  finish(null);
}

const fileIdentity =
  `${agentFile.model ?? 'the session model'}` +
  `${agentFile.reasoningEffort != null ? ` at effort ${agentFile.reasoningEffort}` : ''}` +
  `${agentFile.hostExecutor != null ? ` (cut for ${agentFile.hostExecutor})` : ' (no host executor baked in)'}`;
const dialIdentity =
  `${facts.expectedModel ?? 'the session model'}` +
  `${facts.expectedEffort != null ? ` at effort ${facts.expectedEffort}` : ''}` +
  `${facts.expectedExecutor != null ? ` (${facts.expectedExecutor})` : ''}`;

if (!hostMode) {
  // Host mode off: Fadeno is not the authority on this session's spawns, so the
  // spawn proceeds — but the row says the identity that ran was the file's, not
  // the dial's, which is the only place that fact is recoverable afterwards.
  recordHostDelivery({ resolver: 'ok', lane, lane_reason: declaredReason, drift: true });
  finish(null);
}
recordHostRefusal(
  'agent_file_drift',
  `${agentFile.path} carries ${fileIdentity}; the ${archetype} dial resolves to ${dialIdentity}`,
  slot,
);
deny(
  `fadeno: the managed Codex agent for ${archetype} is stale. Its file (${agentFile.path}) carries ` +
    `${fileIdentity}, while the ${archetype} dial now resolves to ${dialIdentity}. On Codex an agent ` +
    `file's model and reasoning effort WIN over the values passed at spawn time, so this spawn would ` +
    `silently run the file's identity and the run's evidence would name the dial's — and a hook cannot ` +
    `rewrite that, only refuse it. Fix: run \`fadeno steering apply --codex\`, then start a fresh Codex ` +
    `session so the rewritten agent file is loaded (agent definitions are session-start state). To accept ` +
    `the file's identity for the rest of this session instead, run \`$fadeno-host off\`.`,
);

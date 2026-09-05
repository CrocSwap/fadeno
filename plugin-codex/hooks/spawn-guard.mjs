#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

function deny(reason) {
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      // One paragraph, always: a resolver's stderr is neither short nor
      // single-line, and every refusal text obeys the same rule as its row.
      permissionDecisionReason: String(reason).replace(/\s+/g, ' ').trim(),
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
 * layout. A standalone hook script has no import path into the rest of the
 * plugin, so the twin is named here instead: change one, change both. (Codex
 * hands a subagent hook the PARENT session's id, which is exactly the session
 * whose marker this is.)
 */
function hostModeEnabled() {
  const root = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
  if (typeof root !== 'string' || root.trim() === '' || sessionId === '') return false;
  const key = createHash('sha256').update(sessionId).digest('hex');
  return existsSync(join(root.trim(), 'host-mode', `${key}.enabled`));
}

const hostMode = hostModeEnabled();
const agentType = typeof input.agent_type === 'string' && input.agent_type.length > 0
  ? input.agent_type
  : null;
const message = typeof input.message === 'string' ? input.message : '';
const promptDigest = message.length > 0 ? createHash('sha256').update(message).digest('hex') : null;
// The model a spawn will actually run on when it names none of its own: the
// active model of the session that is spawning. Codex publishes it on the
// event, and it is the single most useful fact in a refusal — the basanos
// receipt this hook exists for is three generic spawns quietly inheriting a
// frontier model for 71 minutes.
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
 * `fadeno-<archetype>.toml` at user scope — and both spellings are probed for
 * whichever name the spawn asked for, so a director that says `fadeno-worker`
 * lands on the same file as one that says `worker`.
 *
 * The managed header is the whole licence. A hand-authored `worker.toml` is
 * the user's own file: Fadeno neither claims it nor reads an identity out of
 * it, so a spawn naming it is GENERIC and refused in host mode like any other.
 */
function managedAgentFile(type) {
  const bare = type.startsWith('fadeno-') ? type.slice('fadeno-'.length) : type;
  const candidates = [
    join(cwd, '.codex', 'agents', `${type}.toml`),
    join(userAgentDir(), `${type}.toml`),
    join(userAgentDir(), `fadeno-${bare}.toml`),
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
    const modelMatch = MODEL_RE.exec(text);
    const effortMatch = EFFORT_RE.exec(text);
    const executorMatch = HOST_EXECUTOR_RE.exec(text);
    return {
      path,
      name: nameMatch ? unquoteToml(nameMatch[1]) : bare,
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
 * Evidence for a spawn this guard DENIED. Same event name and the same
 * `refusal: {predicate, message}` shape the Claude steering hook writes, so
 * `fadeno dispatches` renders both without knowing which harness refused.
 *
 * Deliberately no prompt snapshot, for the Claude hook's reason: nothing was
 * delivered, and a denial is the failure mode that repeats.
 */
function recordHostRefusal(predicate, reason, slot) {
  const flat = String(reason).replace(/\s+/g, ' ').trim();
  appendRow({
    // Duplicated from DISPATCHES_FORMAT in src/commands/dispatch.ts by hand,
    // exactly as the Claude hook duplicates it. Bump them together.
    format: '1.0',
    timestamp: new Date().toISOString(),
    event: 'host_refused',
    fadeno_version: HOOK_VERSION,
    hook_version: HOOK_VERSION,
    harness: 'codex',
    archetype,
    agent_type: agentType,
    refusal: {
      predicate,
      message: flat.length > REFUSAL_REASON_MAX ? `${flat.slice(0, REFUSAL_REASON_MAX - 1)}…` : flat,
    },
    timeout_ms: predicate === 'resolver_timeout' ? RESOLVE_TIMEOUT_MS : null,
    executor: typeof slot?.executor === 'string' ? slot.executor : null,
    model: typeof slot?.model === 'string' ? slot.model : null,
    model_id: typeof slot?.model_id === 'string' ? slot.model_id : null,
    model_override: requestedModel,
    effort: typeof slot?.effort === 'string' ? slot.effort : null,
    effort_pinned: typeof slot?.effort_pinned === 'boolean' ? slot.effort_pinned : null,
    // Codex publishes no session-effort env to a hook command, so this hook
    // never observes one. Null rather than omitted, so the row shape matches
    // the Claude hook's and a reader can diff them.
    session_effort: null,
    lane: typeof slot?.lane === 'string' ? slot.lane : null,
    lane_reason: typeof slot?.lane_reason === 'string' ? slot.lane_reason : null,
    parent_model: parentModel,
    agent_file: agentFile == null
      ? null
      : {
          path: agentFile.path,
          model: agentFile.model,
          reasoning_effort: agentFile.reasoningEffort,
          host_executor: agentFile.hostExecutor,
        },
    prompt_sha256: promptDigest,
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
    // spawn goes through untouched. The row is still written — the receipt
    // this whole guard came from is a session where three generic spawns left
    // no trace anywhere, and "nobody was watching" must not be one of the
    // states the log can be in.
    appendRow({
      format: '1.0',
      timestamp: new Date().toISOString(),
      event: 'native_spawn',
      fadeno_version: HOOK_VERSION,
      hook_version: HOOK_VERSION,
      harness: 'codex',
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

const bundled = typeof process.env.PLUGIN_ROOT === 'string'
  ? join(process.env.PLUGIN_ROOT, 'bin', 'fadeno')
  : null;
const cli = bundled != null && existsSync(bundled) ? bundled : 'fadeno';
const resolveArgv = ['dial', 'resolve', '--archetype', archetype];
if (promptDigest != null) resolveArgv.push('--prompt-sha256', promptDigest);
const resolution = spawnSync(cli, resolveArgv, {
  cwd,
  env: { ...process.env, FADENO_HARNESS: 'codex' },
  encoding: 'utf8',
  timeout: RESOLVE_TIMEOUT_MS,
});
// Same split, and the same two predicates, as the Claude hook: a killed child
// reports no status and Node signs the kill, while a spawn that never started
// (no `fadeno` on PATH) also has a null status but needs the opposite remedy.
const timedOut =
  resolution.status == null &&
  (resolution.error?.code === 'ETIMEDOUT' || resolution.signal != null);

let slot = null;
if (resolution.status !== 0) {
  const stderr = (resolution.stderr ?? '').trim();
  const reason = timedOut
    ? `fadeno dial resolve did not answer within ${RESOLVE_TIMEOUT_MS}ms` +
      `${resolution.signal != null ? ` (killed with ${resolution.signal})` : ''}`
    : stderr.length > 0
      ? stderr
      : 'fadeno dial resolve failed';
  const predicate = timedOut ? 'resolver_timeout' : 'resolver_error';
  if (hostMode) {
    recordHostRefusal(predicate, reason, null);
    deny(
      `fadeno: could not resolve the ${archetype} dial for this spawn — ${reason}. Fadeno host mode ` +
        `is on, so refusing a spawn whose identity nothing verified rather than letting the agent ` +
        `file's own model run unchecked. Fix the resolver (\`fadeno dial resolve --archetype ` +
        `${archetype}\` reproduces it), or run \`$fadeno-host off\` to spawn it unverified.`,
    );
  }
  // Host mode off: the spawn goes through, but the row says the identity on it
  // was never resolved rather than leaving a gap a reader would read as "fine".
  recordHostDelivery({ resolver: timedOut ? 'timeout' : 'failed', lane: null, drift: null });
  finish(null);
}
try {
  slot = JSON.parse(resolution.stdout ?? '');
} catch {
  slot = null;
}
if (slot == null || typeof slot !== 'object' || Array.isArray(slot)) {
  // Exit 0 with unreadable stdout: an older or wedged `fadeno`. Fail open the
  // way the Claude hook does on the same shape — this is not evidence of a
  // wrong identity, only of a resolver this hook cannot read.
  recordHostDelivery({ resolver: 'unreadable', lane: null, drift: null });
  finish(null);
}

const declaredLane = typeof slot.lane === 'string' ? slot.lane : null;
const lane =
  declaredLane === 'host' || declaredLane === 'command' || declaredLane === 'restart_required'
    ? declaredLane
    : slot.adapter === 'command'
      ? 'command'
      : 'host';

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

/**
 * Evidence for a managed spawn this guard let through. The Codex twin of the
 * Claude hook's `host_delivery` row, field for field where the two harnesses
 * can observe the same thing, plus the two facts only this side has: the agent
 * file's frozen identity and whether it has drifted from the dial.
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
    format: '1.0',
    timestamp: new Date().toISOString(),
    event: 'host_delivery',
    fadeno_version: HOOK_VERSION,
    hook_version: HOOK_VERSION,
    harness: 'codex',
    archetype,
    agent_type: agentType,
    executor: typeof slot?.executor === 'string' ? slot.executor : null,
    model: typeof slot?.model === 'string' ? slot.model : null,
    model_id: typeof slot?.model_id === 'string' ? slot.model_id : null,
    model_override: requestedModel,
    effort: typeof slot?.effort === 'string' ? slot.effort : null,
    effort_pinned: typeof slot?.effort_pinned === 'boolean' ? slot.effort_pinned : null,
    // Never observed on Codex: no effort env reaches a hook command.
    session_effort: null,
    // What the spawn will actually run at — the FILE's effort, not the dial's,
    // because the file wins. `drift` below says whether those are the same.
    reasoning_effort: agentFile?.reasoningEffort ?? requestedEffort ?? 'inherited',
    lane: extra.lane,
    lane_reason: typeof slot?.lane_reason === 'string' ? slot.lane_reason : null,
    dial_source: typeof slot?.source === 'string' ? slot.source : null,
    driver: typeof slot?.driver === 'string' ? slot.driver : null,
    transport: 'host',
    agent_file: agentFile == null
      ? null
      : {
          path: agentFile.path,
          model: agentFile.model,
          reasoning_effort: agentFile.reasoningEffort,
          host_executor: agentFile.hostExecutor,
        },
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

// A command lane (or a lane that says this session must restart) is the hybrid
// role agent's own business: its developer instructions broker the dial through
// `steering resolve` and dispatch out of process from inside the subagent. The
// guard records which lane the resolver named and does not second-guess it.
if (lane !== 'host') {
  recordHostDelivery({ resolver: 'ok', lane, drift: null });
  finish(null);
}

const facts = driftFacts();
if (!facts.drifted) {
  recordHostDelivery({ resolver: 'ok', lane, drift: false });
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
  recordHostDelivery({ resolver: 'ok', lane, drift: true });
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

// Fadeno runtime steering for OpenCode — the `tool.execute.before` counterpart
// of templates/claude/hooks/dispatch-steering.mjs (the reference design this
// file mirrors: lane decision, refusal predicates, evidence rows, fail-open
// philosophy). Identity is delivered by MATERIALIZED agent files under
// `.opencode/agent/` (written by `fadeno steering apply --opencode` or
// `fadeno init --opencode`); this plugin supplies what Codex has no equivalent
// of: per-spawn lane selection against the live dials.
//
// Loader constraints that shape this module (verified against OpenCode v1.18.x
// sources): auto-discovery globs `{plugin,plugins}/*.{ts,js}` — so this ships
// as `.js`, not `.mjs`, or it would never load — and every exported function
// value is treated as a legacy plugin and CALLED once at startup. That is why
// the pure decision core hangs behind one exported factory whose product is an
// inert object, rather than several bare named exports: a bare export would be
// invoked with PluginInput at startup and its return value registered as
// hooks.
//
// Fail-open everywhere: any unexpected error leaves the spawn untouched. A
// steering bug must never break spawning.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Same duplicated literal, and the same reason, as every evidence writer in
// src/: standalone scripts have no import path back into the CLI. Bump
// DISPATCHES_FORMAT and every copy together.
const EVIDENCE_FORMAT = '1.0';

// Which generation of this plugin wrote a given evidence row. Plugins load
// once at process start, so a live session keeps running the previous build
// after an upgrade — a stamped row is the only way to tell which generation
// produced it. Both emitters (`fadeno init --opencode` and
// `fadeno steering apply --opencode`) replace this literal with the package
// version; the template keeps 'dev'.
const HOOK_VERSION = 'dev';

const ARCHETYPES = ['worker', 'reviewer', 'judge'];

// The managed-file mark `fadeno steering apply --opencode` stamps into every
// agent file it writes. An unmarked `.opencode/agent/<archetype>.md` is the
// user's own file: Fadeno neither claims it nor rewrites spawns onto it.
const MANAGED_MARK = '<!-- fadeno:managed';

// How long a spawn gets to wait for `fadeno dial resolve` before it is killed.
// Named because the refusal row records it on the one predicate it describes.
const RESOLVE_TIMEOUT_MS = 10_000;

// Longest refusal reason written to the evidence log; the denial text itself
// reaches the caller in full. Same bound as the Claude hook.
const REFUSAL_REASON_MAX = 400;

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** One-line, bounded reason for the evidence log (mirrors the Claude hook). */
function flattenReason(reason) {
  const flat = String(reason).replace(/\s+/g, ' ').trim();
  return flat.length > REFUSAL_REASON_MAX ? `${flat.slice(0, REFUSAL_REASON_MAX - 1)}…` : flat;
}

/**
 * Which Fadeno archetype a task-tool spawn names, or null. Only agents that
 * NAME an archetype are steered — OpenCode's catch-all subagents stay
 * untouched, exactly like the Claude hook leaves `general-purpose` alone.
 * OpenCode's namespaced agent spelling uses `:` (for example,
 * `fadeno:worker`); slash-containing names are left alone because this
 * adapter has no evidence that OpenCode uses slash namespaces for agent ids.
 */
function extractArchetype(agentName) {
  if (typeof agentName !== 'string' || agentName.trim() === '') return null;
  const bare = agentName.trim().split(':').pop() ?? '';
  return ARCHETYPES.includes(bare) ? bare : null;
}

/**
 * The pure lane decision — the OpenCode twin of dispatch-steering.mjs's
 * routing block. Takes a resolved `fadeno dial resolve` slot (already parsed)
 * and answers what should happen to the spawn. Nothing here does I/O.
 *
 * - `refuse`   — no honest delivery exists (restart_required); the caller
 *                rewrites the spawn to the refusal broker with `reason`
 *                embedded. Refusal predicates are a closed three-value
 *                vocabulary the evidence log groups on:
 *                resolver_error | resolver_timeout | restart_required.
 * - `dispatch` — command lane, or a selected routable shadow pair: both arms
 *                must reach `fadeno dispatch` through the relay broker to be
 *                comparable.
 * - `host`     — in-session delivery onto the materialized `<archetype>` slot.
 * - `pass`     — leave the spawn exactly as asked (unsteered host spawn).
 */
function laneAction(slot, archetype, opts = {}) {
  // Unknown adapter shapes pass through untouched, same catch-all rule as the
  // Claude hook applies to unrecognized slots.
  if (slot?.adapter !== 'command' && slot?.adapter !== 'host') return { action: 'pass' };
  // The resolver decides the lane; this plugin applies it. A `fadeno` that
  // predates `lane` answers with `adapter` alone — derive from that instead of
  // inventing an answer, so an older CLI keeps its previous behavior.
  const declaredLane = typeof slot.lane === 'string' ? slot.lane : null;
  const lane =
    declaredLane === 'host' || declaredLane === 'command' || declaredLane === 'restart_required'
      ? declaredLane
      : slot.adapter === 'command'
        ? 'command'
        : 'host';
  const laneReason =
    typeof slot.lane_reason === 'string' && slot.lane_reason.length > 0 ? slot.lane_reason : null;
  if (lane === 'restart_required') {
    const executor =
      typeof slot.executor === 'string' && slot.executor.length > 0 ? slot.executor : archetype;
    const wanted =
      typeof slot.effective_effort === 'string' && slot.effective_effort.length > 0
        ? slot.effective_effort
        : null;
    const sessionEffort = str(slot.session_effort) ?? 'unknown';
    const refusal = {
      action: 'refuse',
      predicate: 'restart_required',
      reason:
        `no lane for ${executor}${wanted != null ? ` at effort ${wanted}` : ''}; session effort ` +
        `${sessionEffort}${laneReason != null ? `: ${laneReason}` : ''}. Start a matching session, drop ` +
        `the effort pin (fadeno dial ${archetype} <ref>), or give the dial a command fallback.`,
    };
    // Evidence still belongs to the refusal path when the broker is absent;
    // only the rewrite must fail open.
    return opts.hasRefusalAgent === false ? { ...refusal, rewrite: false } : refusal;
  }
  // A selected pair takes the command lane on BOTH arms — an in-session primary
  // cannot be isolated or diffed the way its challenger is. Gated on
  // `routable`: a primary with no usable command lane degrades to "no pair"
  // and takes the path it would have taken anyway, never a refusal.
  const pairSelected = slot.shadow?.selected === true && slot.shadow?.routable === true;
  if (lane === 'command' || pairSelected) {
    if (opts.hasDispatchAgent === false) return { action: 'pass', lane, pairSelected };
    return { action: 'dispatch', agent: `fadeno-dispatch-${archetype}`, lane, pairSelected };
  }
  // Host lane: rewrite onto the materialized slot ONLY when one exists. No
  // materialized file means no dialed identity was ever cut into this repo —
  // the spawn continues untouched onto the static role agents.
  if (opts.hasHostAgent === true) return { action: 'host', agent: archetype, lane };
  return { action: 'pass', lane };
}

/**
 * The clearly-delimited refusal block PREPENDED to the task prompt. The task
 * text survives below the boundary; the refusal broker reports the reason and
 * stops without performing that task.
 */
function refusalEnvelope(archetype, predicate, reason) {
  return (
    `# FADENO STEERING REFUSED (${predicate})\n\n` +
    `The Fadeno steering layer refused this ${archetype} spawn before it started.\n` +
    'Report the REFUSAL REASON below verbatim to your caller, then STOP. Do not\n' +
    'perform the task after the boundary line; do not attempt a substitute.\n\n' +
    `REFUSAL REASON: ${reason}\n\n` +
    '--- FADENO REFUSAL BOUNDARY — task text follows; report the refusal above instead ---\n'
  );
}

/**
 * Build a `host_delivery` evidence row — pure; the writer below appends it.
 * Field names match the Claude hook's rows wherever they mean the same thing,
 * so `.fadeno/dispatches.jsonl` audits both hosts with one reader.
 */
function hostDeliveryRow(fields) {
  const slot = fields.slot ?? {};
  const model = str(slot.model);
  return {
    format: EVIDENCE_FORMAT,
    timestamp: fields.timestamp,
    event: 'host_delivery',
    fadeno_version: HOOK_VERSION,
    hook_version: HOOK_VERSION,
    archetype: fields.archetype,
    agent_type: fields.requested,
    executor: str(slot.executor),
    model: str(slot.model),
    model_override: fields.modelOverride ?? null,
    model_applied: model === 'current-host' ? (fields.modelOverride ?? null) : model,
    effort: str(slot.effort),
    effort_pinned: typeof slot.effort_pinned === 'boolean' ? slot.effort_pinned : null,
    session_effort: str(slot.session_effort),
    lane: str(fields.lane),
    lane_reason: str(slot.lane_reason),
    transport: 'host',
    driver: str(slot.driver),
    prompt_sha256: fields.promptSha256 ?? null,
    ...(fields.promptSnapshotRel != null ? { prompt_snapshot: fields.promptSnapshotRel } : {}),
  };
}

/**
 * Build a `host_refused` evidence row. Deliberately NOT a prompt snapshot:
 * nothing was delivered, and a denial is the failure mode that repeats — a
 * file per denial would litter `.fadeno/local/prompts/`. On the resolver-error
 * path there is no slot at all, so the identity fields read null, which is
 * itself the evidence.
 */
function hostRefusalRow(fields) {
  const slot = fields.slot ?? null;
  return {
    format: EVIDENCE_FORMAT,
    timestamp: fields.timestamp,
    event: 'host_refused',
    fadeno_version: HOOK_VERSION,
    hook_version: HOOK_VERSION,
    archetype: fields.archetype,
    agent_type: fields.requested,
    refusal: {
      predicate: fields.predicate,
      message: flattenReason(fields.reason),
    },
    timeout_ms: fields.predicate === 'resolver_timeout' ? RESOLVE_TIMEOUT_MS : null,
    executor: slot == null ? null : str(slot.executor),
    model: slot == null ? null : str(slot.model),
    model_override: fields.modelOverride ?? null,
    effort: slot == null ? null : str(slot.effort),
    effort_pinned:
      slot == null || typeof slot.effort_pinned !== 'boolean' ? null : slot.effort_pinned,
    session_effort: slot == null ? null : str(slot.session_effort),
    lane_reason: slot == null ? null : str(slot.lane_reason),
    prompt_sha256: fields.promptSha256 ?? null,
  };
}

/**
 * Evidence writers — best-effort by contract. A throwing write must never
 * break the spawn, so every failure is swallowed. Outside a Fadeno repo there
 * is no evidence file to append to; skip silently.
 */
function recordEvidence(repoDir, row) {
  try {
    if (!existsSync(join(repoDir, '.fadeno'))) return;
    mkdirSync(join(repoDir, '.fadeno'), { recursive: true });
    appendFileSync(join(repoDir, '.fadeno', 'dispatches.jsonl'), `${JSON.stringify(row)}\n`);
  } catch {
    // best-effort: evidence is a trace, never a gate on the spawn
  }
}

function snapshotDeliveredPrompt(repoDir, prompt, digest) {
  try {
    const rel = join('.fadeno', 'local', 'prompts', `host-${digest.slice(0, 8)}.md`);
    mkdirSync(join(repoDir, '.fadeno', 'local', 'prompts'), { recursive: true });
    writeFileSync(join(repoDir, rel), prompt, 'utf8');
    return rel;
  } catch {
    return null;
  }
}

/** Does a Fadeno-materialized host slot exist for this archetype? */
function hasManagedHostAgent(repoDir, archetype) {
  return hasManagedAgent(repoDir, `${archetype}.md`);
}

/** Does a named Fadeno-managed OpenCode agent file exist? */
function hasManagedAgent(repoDir, filename) {
  try {
    return readFileSync(join(repoDir, '.opencode', 'agent', filename), 'utf8').includes(MANAGED_MARK);
  } catch {
    return false;
  }
}

/**
 * Rewrite the spawn in place. Accepts BOTH task-arg spellings for the agent
 * name (field spelling is unverified across OpenCode versions); sets whichever
 * keys are present, and never throws.
 */
function applyRewrite(args, newAgent) {
  if ('subagent_type' in args) args.subagent_type = newAgent;
  if ('subagentType' in args) args.subagentType = newAgent;
  if (!('subagent_type' in args) && !('subagentType' in args)) args.subagent_type = newAgent;
}

/** Resolve a dial without blocking OpenCode's event loop. */
function resolveDial(repoDir, resolveArgv) {
  return new Promise((resolve) => {
    let child;
    let timer = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn('fadeno', resolveArgv, {
        cwd: repoDir,
        env: { ...process.env, FADENO_HARNESS: 'opencode' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ status: null, stdout, stderr, signal: null, error });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({ status: null, stdout, stderr, signal: null, error }));
    child.once('close', (status, signal) => finish({ status, stdout, stderr, signal, error: null }));
    timer = setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch {}
      // Resolve immediately after the budget expires. A child that ignores
      // SIGTERM must not keep the hook promise waiting indefinitely.
      finish({ status: null, stdout, stderr, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } });
    }, RESOLVE_TIMEOUT_MS);
  });
}

/** The impure half: resolver call, evidence writes, args mutation. */
async function steer(hookInput, output, repoDir) {
  // Fire only on the task tool — subagent spawns route through it. Case
  // differences have been observed across harness versions; compare loosely.
  const tool = typeof hookInput?.tool === 'string' ? hookInput.tool.toLowerCase() : '';
  if (tool !== 'task') return;
  const args = output?.args;
  if (args == null || typeof args !== 'object') return;
  const requested = 'subagent_type' in args ? args.subagent_type : args.subagentType;
  const archetype = extractArchetype(requested);
  if (archetype == null) return; // catch-alls and unrelated specialists stay unsteered

  const promptText = typeof args.prompt === 'string' ? args.prompt : '';
  const promptDigest = promptText.length > 0 ? sha256(promptText) : null;

  // Rewrite to the refusal broker: no deny primitive exists in the plugin API,
  // so refusal = an agent whose embedded instructions report the reason and
  // stop. The task text survives below the boundary block.
  function refuse(predicate, reason, slot, allowRewrite = true) {
    recordEvidence(
      repoDir,
      hostRefusalRow({
        timestamp: new Date().toISOString(),
        archetype,
        requested,
        predicate,
        reason,
        slot,
        modelOverride: str(args.model),
        promptSha256: promptDigest,
      }),
    );
    if (!allowRewrite || !hasManagedAgent(repoDir, `fadeno-steering-refused-${archetype}.md`)) return;
    if (promptText.length > 0) {
      args.prompt = `${refusalEnvelope(archetype, predicate, reason)}\n${promptText}`;
    }
    applyRewrite(args, `fadeno-steering-refused-${archetype}`);
  }

  // Resolve through the structured CLI surface. FADENO_HARNESS=opencode makes
  // the resolver compile routes for THIS harness, so lane and relay answers
  // agree with what this session can actually deliver.
  const resolveArgv = ['dial', 'resolve', '--archetype', archetype];
  if (promptDigest != null) resolveArgv.push('--prompt-sha256', promptDigest);
  const resolution = await resolveDial(repoDir, resolveArgv);
  // A killed child reports no exit status; Node signs the kill with
  // error.code === 'ETIMEDOUT' plus a signal. A spawn that never STARTED
  // (no fadeno on PATH: ENOENT) also has a null status and must not read as
  // a timeout — its remedy is "install fadeno", not "raise the budget".
  const timedOut =
    resolution.status == null &&
    (resolution.error?.code === 'ETIMEDOUT' || resolution.signal != null);
  if (resolution.status !== 0) {
    const stderr = (resolution.stderr ?? '').trim();
    refuse(
      timedOut ? 'resolver_timeout' : 'resolver_error',
      timedOut
        ? `fadeno dial resolve did not answer within ${RESOLVE_TIMEOUT_MS}ms` +
          `${resolution.signal != null ? ` (killed with ${resolution.signal})` : ''}; ` +
          'refusing a spawn no dial slot steered.'
        : stderr.length > 0
          ? stderr
          : 'fadeno dial resolve failed; refusing a spawn no dial slot steered.',
      null,
      true,
    );
    return;
  }
  let slot;
  try {
    slot = JSON.parse(resolution.stdout ?? '');
  } catch {
    return; // unreadable stdout fail-opens: leave the spawn untouched
  }
  const decision = laneAction(slot, archetype, {
    hasHostAgent: hasManagedHostAgent(repoDir, archetype),
    hasDispatchAgent: hasManagedAgent(repoDir, `fadeno-dispatch-${archetype}.md`),
    hasRefusalAgent: hasManagedAgent(repoDir, `fadeno-steering-refused-${archetype}.md`),
  });
  if (decision.action === 'refuse') {
    refuse(decision.predicate, decision.reason, slot, decision.rewrite !== false);
    return;
  }
  if (decision.action === 'pass') return;
  if (decision.action === 'dispatch') {
    // Command delivery ends at `fadeno dispatch`, where the kernel writes the
    // request/completion row pair — no evidence is owed here.
    // OpenCode deliberately omits the Claude hook's pending-relays stash:
    // there is no proxy-guard writer here, and adding the stash alone would
    // create a cross-host false-fidelity hazard.
    applyRewrite(args, decision.agent);
    return;
  }
  // Host delivery never reaches the kernel, so this plugin is the only Fadeno
  // code on that path and therefore its evidence writer.
  if (promptText.length > 0 && promptDigest != null) {
    const snapshotRel = snapshotDeliveredPrompt(repoDir, promptText, promptDigest);
    recordEvidence(
      repoDir,
      hostDeliveryRow({
        timestamp: new Date().toISOString(),
        archetype,
        requested,
        slot,
        lane: decision.lane,
        modelOverride: str(args.model),
        promptSha256: promptDigest,
        ...(snapshotRel != null ? { promptSnapshotRel: snapshotRel } : {}),
      }),
    );
  }
  applyRewrite(args, decision.agent);
}
/**
 * The plugin OpenCode loads. Returns the hooks object; the handler is wrapped
 * in a catch so ANY unexpected failure pass-throughs the spawn untouched.
 */
export default async function FadenoSteering(input) {
  const repoDir =
    typeof input?.directory === 'string' && input.directory.length > 0
      ? input.directory
      : process.cwd();
  return {
    'tool.execute.before': async (hookInput, output) => {
      try {
        await steer(hookInput, output, repoDir);
      } catch {
        // Fail-open: a steering bug must never break spawning.
      }
    },
  };
}

/**
 * The pure decision core, behind ONE exported factory: OpenCode's legacy
 * loader calls every exported function at startup and registers the result as
 * hooks, so bare helper exports would be invoked with PluginInput and poison
 * the hooks list. Calling this factory there is harmless — its product is an
 * inert object no hook lookup matches — and tests import it to exercise the
 * decision logic without a live OpenCode.
 */
export function fadenoSteeringCore() {
  return {
    ARCHETYPES,
    MANAGED_MARK,
    RESOLVE_TIMEOUT_MS,
    extractArchetype,
    laneAction,
    refusalEnvelope,
    applyRewrite,
    hostDeliveryRow,
    hostRefusalRow,
  };
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Which generation of this hook wrote a given evidence row. Plugin hooks load
// once at session start from a version-keyed cache, so a live session keeps
// running the previous build's hook after an upgrade — evidence written across
// that transition otherwise can't say which generation produced it. Both
// emitters (`fadeno plugin` and `fadeno init --claude`) replace this literal
// with the package version; the template keeps 'dev', so a row reading 'dev'
// means the template was executed directly rather than an installed copy.
const HOOK_VERSION = '0.6.0-rc.55';

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

if (event?.tool_name !== 'Agent' || event.tool_input == null || typeof event.tool_input !== 'object') {
  finish(null);
}

const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : process.cwd();
const bundled = typeof process.env.CLAUDE_PLUGIN_ROOT === 'string'
  ? join(process.env.CLAUDE_PLUGIN_ROOT, 'bin', 'fadeno')
  : null;
const cli = bundled != null && existsSync(bundled) ? bundled : 'fadeno';
const requested = event.tool_input.subagent_type;
if (typeof requested !== 'string') finish(null);
const bare = requested.split(':').at(-1);

// Relay-fidelity attestation: whenever a subtask heads to a dispatch proxy,
// stash the spawn-side prompt digest. The kernel consumes a matching entry at
// dispatch time and marks the evidence row `relay_attested` — turning the
// proxy's "verbatim" from an instruction into a checked claim. Content-keyed
// (sha256), so concurrent dispatches match without ordering.
function stashRelay() {
  const prompt = event.tool_input.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) return;
  if (!existsSync(join(cwd, '.fadeno'))) return; // not a Fadeno repo
  try {
    const dir = join(cwd, '.fadeno', 'local');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'pending-relays.jsonl'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_version: HOOK_VERSION,
        prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
      })}\n`,
    );
  } catch {
    // best-effort: attestation is evidence, never a gate on the spawn
  }
}

// A director that names `dispatch-<archetype>` itself has already chosen
// command delivery — but that choice belongs to the loadout, not the caller,
// and the proxy agents advertise themselves hard enough ("MUST BE USED") that
// a well-behaved director walks straight past the host path. Resolve a named
// proxy like any other archetype spawn: a host slot rewrites back to the
// in-session agent rather than shelling out to a subprocess of this same
// harness, which re-enters this same steering one level down.
const explicitProxy = /^dispatch-(worker|reviewer|judge|director)$/.test(bare);
// Only agents that NAME an archetype are steered. `general-purpose` used to map
// to `worker` and must not: it is the harness's catch-all, the default when a
// director wants a subagent at all, so capturing it turned every generic spawn
// in a Fadeno repo into an external dispatch. A 2026-08-13 dogfood launched
// general-purpose for a direct analysis task, watched it become a
// `dispatch-worker`, and then watched the proxy guard hold the relay contract
// against the very instructions it was given — "as a dispatch proxy I'm not
// permitted to run the analysis myself" — so the analysis never happened.
// Directors that want archetype routing have two explicit spellings already
// (`fadeno:<archetype>` and `dispatch-<archetype>`); the catch-all is not a
// third, and reading it as one costs a task.
const archetype = explicitProxy
  ? bare.slice('dispatch-'.length)
  : bare === 'worker' || bare === 'reviewer' || bare === 'judge' || bare === 'director'
    ? bare
    : null;
if (archetype == null) finish(null); // general-purpose, Explore, Plan, and unrelated specialists stay unsteered.

/**
 * Leave the spawn exactly as the director asked. A named proxy still lands on
 * a proxy, so it still needs its relay attestation — the fail-open paths below
 * must not cost the evidence the pass-through used to write.
 */
function passThrough() {
  if (explicitProxy) stashRelay();
  finish(null);
}

// Resolve through a structured CLI surface. The same neutral dial can be
// host-delivered in Claude and command-delivered in Codex (or vice versa).
// The digest the pair roll is keyed on. Supplying it is what lets the
// resolver answer "is this spawn a pair?" for THIS prompt rather than in
// general — and the kernel re-derives the same answer at dispatch time, so
// nothing has to be threaded through the relay.
const promptText = typeof event.tool_input.prompt === 'string' ? event.tool_input.prompt : '';
const promptDigest = promptText.length > 0 ? createHash('sha256').update(promptText).digest('hex') : null;
const resolveArgv = ['dial', 'resolve', '--archetype', archetype];
if (promptDigest != null) resolveArgv.push('--prompt-sha256', promptDigest);
// How long a spawn gets to answer before it is killed. Named because the
// refusal row records it: a reader who sees `resolver_timeout` immediately
// wants to know whether the budget that expired was ten seconds or one.
const RESOLVE_TIMEOUT_MS = 10_000;
const resolution = spawnSync(cli, resolveArgv, {
  cwd,
  env: { ...process.env, FADENO_HARNESS: 'claude' },
  encoding: 'utf8',
  timeout: RESOLVE_TIMEOUT_MS,
});
// A resolver that HUNG and a resolver that FAILED need different fixes — a
// slow or wedged resolver (or a budget too tight for it) versus a malformed
// pin — so they are separate predicates rather than one bucket, and a denial
// loop can be grouped by which one it is.
//
// Split on the spawn mechanism: a killed child reports no exit status at all,
// and Node signs the kill with `error.code === 'ETIMEDOUT'` plus the signal
// it sent. A spawn that never STARTED (no `fadeno` on PATH: ENOENT) also has
// a null status and must not read as a timeout — its remedy is "install
// fadeno", not "raise the budget" — so the signature requires evidence of a
// kill, not merely a missing status.
const timedOut =
  resolution.status == null &&
  (resolution.error?.code === 'ETIMEDOUT' || resolution.signal != null);

// The session's own effort, published by the harness to hook commands and
// Bash and already resolved past any per-model or per-org downgrade. Read
// here rather than at the lane decision below because both deny paths need
// it too, and the earlier of them runs before any resolver output exists.
const envEffort =
  typeof process.env.CLAUDE_EFFORT === 'string' && process.env.CLAUDE_EFFORT.trim() !== ''
    ? process.env.CLAUDE_EFFORT.trim()
    : null;

// Declared before the first deny path so `recordHostRefusal` can read it
// without hitting the temporal dead zone: the function is called from a point
// above the assignment below, where the binding exists but is still unset.
let slot;

/**
 * Longest refusal reason written to the evidence log. The kernel truncates
 * its stderr excerpts rather than pouring an executor's whole diagnostic
 * stream into an append-only file; a resolver's stderr deserves the same
 * discipline. The actionable text still reaches the caller in full — this
 * bound is on the trace, not on the denial.
 */
const REFUSAL_REASON_MAX = 400;

/**
 * Evidence for a hook-side DENIAL. The kernel writes `dispatch_refused` for
 * its own refusals and this hook writes `host_delivery` for the spawns it
 * lets through, but a spawn this hook denies never reaches either — so
 * without this row a repo where every worker spawn is being denied reads
 * exactly like a repo where nobody spawned anything.
 *
 * Deliberately NOT written: a prompt snapshot. Nothing was delivered, and a
 * denial is the failure mode that repeats — a file per denial would litter
 * `.fadeno/local/prompts/` in exactly the loop this row exists to make
 * visible. `prompt_sha256` is enough to correlate a later successful retry.
 *
 * Field discipline: every key below is always present, and a value this hook
 * could not observe is recorded as `null` rather than omitted, so the two
 * predicates produce the same row shape and a reader can diff them. Keys for
 * things that did not HAPPEN (a transport, a prompt snapshot) are absent
 * rather than null.
 */
function recordHostRefusal(predicate, reason) {
  if (!existsSync(join(cwd, '.fadeno'))) return; // not a Fadeno repo
  try {
    // One line, bounded: the row is read back into a single-line evidence
    // view, and a resolver's stderr is neither short nor single-line.
    const flat = String(reason).replace(/\s+/g, ' ').trim();
    appendFileSync(
      join(cwd, '.fadeno', 'dispatches.jsonl'),
      `${JSON.stringify({
        // Same duplicated literal, and the same reason, as recordHostDelivery
        // below: this script has no import path back into the CLI, so both
        // writers stamp DISPATCHES_FORMAT by hand. Bump them together.
        format: '1.0',
        timestamp: new Date().toISOString(),
        event: 'host_refused',
        fadeno_version: HOOK_VERSION,
        hook_version: HOOK_VERSION,
        archetype,
        agent_type: requested, // exactly what the director asked for
        // The kernel's refusal shape, key for key. A closed vocabulary, not
        // free text — three values, one per deny path this hook has:
        //   resolver_error    — `fadeno dial resolve` exited non-zero (or
        //                       never started at all)
        //   resolver_timeout  — it was killed for not answering in time
        //   restart_required  — it answered, with no lane this session can
        //                       deliver
        refusal: {
          predicate,
          message:
            flat.length > REFUSAL_REASON_MAX ? `${flat.slice(0, REFUSAL_REASON_MAX - 1)}…` : flat,
        },
        // The budget that expired, on the one predicate it describes. Derived
        // here rather than passed in, so the recorded number cannot drift
        // from the timeout the spawn was actually given.
        timeout_ms: predicate === 'resolver_timeout' ? RESOLVE_TIMEOUT_MS : null,
        // Identity as far as it got. On the resolver-error path there is no
        // slot at all, so all of these read null — which is itself the
        // evidence: the spawn was denied before anything was resolved.
        executor: typeof slot?.executor === 'string' ? slot.executor : null,
        model: typeof slot?.model === 'string' ? slot.model : null,
        model_override: event.tool_input.model ?? null,
        effort: typeof slot?.effort === 'string' ? slot.effort : null,
        effort_pinned: typeof slot?.effort_pinned === 'boolean' ? slot.effort_pinned : null,
        session_effort:
          envEffort ??
          (typeof slot?.session_effort === 'string' && slot.session_effort.length > 0
            ? slot.session_effort
            : null),
        lane_reason:
          typeof slot?.lane_reason === 'string' && slot.lane_reason.length > 0
            ? slot.lane_reason
            : null,
        prompt_sha256: promptDigest,
      })}\n`,
    );
  } catch {
    // best-effort, exactly like every other write in this hook: a denial must
    // still deny even if the evidence write throws.
  }
}

// A resolver error used to fall through to an unsteered host spawn —
// substituting a different executor for a proxy-bound archetype. Deny
// instead. Unreadable stdout (exit 0, not JSON) still fail-opens below.
if (resolution.status !== 0) {
  const stderr = (resolution.stderr ?? '').trim();
  // A timed-out resolver usually says nothing at all on stderr, so the
  // generic "failed" sentence would send the reader looking for an error
  // message that was never written. Name the budget instead: it is both the
  // diagnosis and the thing to change.
  const reason = timedOut
    ? `fadeno dial resolve did not answer within ${RESOLVE_TIMEOUT_MS}ms` +
      `${resolution.signal != null ? ` (killed with ${resolution.signal})` : ''}; ` +
      'refusing a spawn no dial slot steered.'
    : stderr.length > 0
      ? stderr
      : 'fadeno dial resolve failed; refusing a spawn no dial slot steered.';
  recordHostRefusal(timedOut ? 'resolver_timeout' : 'resolver_error', reason);
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}
try {
  slot = JSON.parse(resolution.stdout ?? '');
} catch {
  passThrough();
}
if (slot?.adapter !== 'command' && slot?.adapter !== 'host') passThrough();
// The resolver decides the lane; this hook applies it. `lane` answers "can
// this session deliver the dialed identity?" — a question that now covers
// effort as well as model. An unpinned effort states no opinion and always
// rides the session (`host`); a pinned effort the session is not running at
// goes out of process (`command`), because a session's effort, like its agent
// registry, is fixed at session start; an identity with neither a matching
// session nor a command lane to escape to is `restart_required`.
//
// A `fadeno` that predates the field answers with `adapter` alone, and an
// unrecognized value is the same unknown. Both fall back to deriving the lane
// from the adapter, which is exactly what this hook did before `lane` existed
// — so an older CLI keeps its previous behavior instead of denying (or
// host-delivering) every spawn.
const declaredLane = typeof slot.lane === 'string' ? slot.lane : null;
const lane =
  declaredLane === 'host' || declaredLane === 'command' || declaredLane === 'restart_required'
    ? declaredLane
    : slot.adapter === 'command'
      ? 'command'
      : 'host';
const laneReason =
  typeof slot.lane_reason === 'string' && slot.lane_reason.length > 0 ? slot.lane_reason : null;
// The session's own effort (read into `envEffort` up with the deny paths,
// which need it before any slot exists). It is the only *observed* effort
// anywhere on this path. The resolver reports the same level back in
// `session_effort`; prefer this process's own read and fall back to the
// resolver's, so the value survives either one being blind.
const sessionEffort =
  envEffort ??
  (typeof slot.session_effort === 'string' && slot.session_effort.length > 0
    ? slot.session_effort
    : null);
// No lane can carry this spawn: the session cannot deliver the dialed
// identity, and the dial has no command fallback to escape to. A hook cannot
// restart a session, and the two things that would have to change — the
// session's effort and its agent registry — are both session-start state, so
// the only alternatives are to deny or to spawn something the dial did not
// ask for. Deny, for the same reason the resolver-error path above denies:
// silently substituting a different executor is the failure this hook exists
// to prevent, and a denial reaches the director as text it can act on, while
// a wrong-identity spawn reaches no one. Named proxies deny here too — the
// kernel would refuse the same dispatch one process later, with less context
// about who asked.
if (lane === 'restart_required') {
  const executor =
    typeof slot.executor === 'string' && slot.executor.length > 0 ? slot.executor : archetype;
  const wanted =
    typeof slot.effective_effort === 'string' && slot.effective_effort.length > 0
      ? slot.effective_effort
      : null;
  // A compact restatement of the denial, not the caller-facing text: the fix
  // hints below are for whoever reads the refusal message, while the row is
  // one line in an evidence view and carries `lane_reason` structurally.
  recordHostRefusal(
    'restart_required',
    `no lane for ${executor}${wanted != null ? ` at effort ${wanted}` : ''}; session effort ` +
      `${sessionEffort ?? 'unknown'}${laneReason != null ? `: ${laneReason}` : ''}`,
  );
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `fadeno: this session cannot deliver the ${archetype} dial (${executor}` +
        `${wanted != null ? ` at effort ${wanted}` : ''}; session effort ` +
        `${sessionEffort ?? 'unknown'})${laneReason != null ? `: ${laneReason}` : ''}. ` +
        'It also has no command-lane fallback to run out of process, and a hook cannot ' +
        'restart a session, so refusing rather than spawning a different identity. Fix by ' +
        `one of: start a session${wanted != null ? ` at effort ${wanted}` : ' that matches the dial'}; ` +
        `re-dial without the effort pin (fadeno dial ${archetype} <ref>); or point the dial at an ` +
        'executor that has a command fallback.',
    },
  });
}
// A selected pair takes the command lane on BOTH arms. An in-session primary
// cannot be isolated, measured, or diffed the way its challenger is, so a
// comparison against one is not a comparison — the pair is only worth running
// if the two sides differ in the model and nothing else. This is the whole of
// "host spawns can be shadowed": not a challenger tagging along beside an
// in-session agent, but the spawn becoming a pair of equals.
//
// `routable` gates this alongside `selected`. The kernel can only reuse a
// host slot's own `fallback_command` to get both arms onto the command lane
// — it has no other way to deliver a host-adapter primary as a command — so
// a primary with none (a bare `current-host` dial, most commonly) has no
// command lane to force. Routing it here anyway would hand the spawn to the
// dispatch proxy, which would run `fadeno dispatch` and hit the kernel's
// ordinary `commandRoutable` refusal — turning a selected pair into a failed
// task instead of the in-session work it would otherwise have done. An
// unroutable selected pair therefore degrades to "no pair": `pairSelected`
// stays false and the spawn takes the path it would have taken anyway.
const pairSelected = slot.shadow?.selected === true && slot.shadow?.routable === true;
// A `command` lane on a host-adapter dial (the pinned-effort escape) is the
// resolver's to guarantee: it only names that lane when a `fallback_command`
// exists to carry it, the same routability `shadow.routable` reports for a
// pair. The hook does not second-guess either one.
const commandDelivery = lane === 'command' || pairSelected;
// Which model a rewritten proxy spawn runs on.
//
// The relay does no role work — it forwards a delivery verbatim and reports
// the result back — so it is deliberately cheap. It is NOT free to make it
// cheaper: the 2026-08-12 dogfood A/B put haiku on this contract and watched
// it defect three ways at once — it summarized deliveries instead of relaying
// them verbatim, answered from the prompt's first line rather than reading
// the whole thing, and asserted evidence it had never written. Sonnet relayed
// flawlessly, and a proxy turn is only a few relay tokens either way, so the
// saving was never worth the fidelity.
//
// The identity itself is the catalog's to state now (`relay.claude` in
// executors.yaml), resolved by `fadeno dial resolve` and reported on
// `slot.relay` — so a repo re-dials its relay the way it dials every other
// identity, instead of editing a hook. The literal below is the fallback for
// the two cases the resolver cannot answer: a catalog that states no opinion
// (`relay: null`, which is what a self-contained project catalog produces —
// the common case, not the exotic one) and a `fadeno` old enough to predate
// the field. Never invent a relay from silence; keep this built-in default.
const RELAY_FALLBACK_MODEL = 'sonnet';
const relayModel =
  typeof slot.relay?.model_id === 'string' && slot.relay.model_id.length > 0
    ? slot.relay.model_id
    : RELAY_FALLBACK_MODEL;
// A host slot with no model of its own inherits the caller's; `current-host`
// is the explicit spelling of that.
const inheritModel =
  !commandDelivery && (typeof slot.model !== 'string' || slot.model === 'current-host');
// An unsteered spawn already lands on the caller's host model, so there is
// nothing to rewrite. A named proxy is not unsteered: leaving it alone would
// ship the task to a subprocess the loadout never asked for. A selected pair
// is not unsteered either — the baseline model still has to reach the command
// lane to be comparable.
if (inheritModel && !explicitProxy && !pairSelected) finish(null);

/**
 * Which already-registered agent a host spawn should land on, or null when
 * this repo has no managed role agent for the archetype.
 *
 * This used to pick an effort as well. `fadeno steering apply --claude`
 * pre-registered an identity grid — one managed agent per (archetype, named
 * effort), each `model: inherit` plus its own `effort:` — so that a dial could
 * raise a host spawn's effort without a session restart, since the agent
 * registry is a session-start snapshot and a cell cannot be materialized on
 * demand. Effort now decides the *lane* instead: a host spawn runs at the
 * session's effort, and an effort the session cannot give is delivered on the
 * command lane. That leaves one managed agent per archetype and nothing to
 * look up but whether it exists.
 *
 * The `<!-- fadeno:managed` marker is still required. An unmarked
 * `.claude/agents/<archetype>.md` is the user's own file: Fadeno neither
 * claims it nor reads anything out of it. A project-scope one still catches
 * the spawn by the plain-name fallback at the foot of this file — it is the
 * agent the harness has registered under that name — but it does so as the
 * user's agent, not as a Fadeno materialization.
 *
 * Project scope first, then user scope — the two places that command writes.
 */
function hostTarget(archetypeName) {
  const roots = [join(cwd, '.claude', 'agents'), join(homedir(), '.claude', 'agents')];
  for (const root of roots) {
    let text;
    try {
      text = readFileSync(join(root, `${archetypeName}.md`), 'utf8');
    } catch {
      continue; // absent or unreadable
    }
    // Managed agents register under their bare name in either scope, so the
    // name is the whole answer once the marker confirms it is ours.
    if (text.includes('<!-- fadeno:managed')) return archetypeName;
  }
  return null;
}

// Evidence for host delivery. Command delivery ends at `fadeno dispatch`,
// where the kernel writes the request/completion row pair; host delivery
// never reaches the kernel, so this hook is the only Fadeno code on that path
// and therefore its evidence writer. One `host_delivery` row plus a
// kernel-shaped prompt snapshot keeps both delivery modes auditable from the
// same `.fadeno/dispatches.jsonl`.
function recordHostDelivery() {
  const prompt = event.tool_input.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) return;
  if (!existsSync(join(cwd, '.fadeno'))) return; // not a Fadeno repo
  try {
    // Whether the dial stated an effort opinion at all, and what it asked
    // for. `sessionEffort` is resolved once, up with the lane decision.
    const effortPinned = slot?.effort_pinned === true;
    const pinnedEffort =
      typeof slot?.effective_effort === 'string' && slot.effective_effort.length > 0
        ? slot.effective_effort
        : null;
    const promptSha256 = createHash('sha256').update(prompt).digest('hex');
    const snapshotRel = `.fadeno/local/prompts/host-${promptSha256.slice(0, 8)}.md`;
    mkdirSync(join(cwd, '.fadeno', 'local', 'prompts'), { recursive: true });
    writeFileSync(join(cwd, snapshotRel), prompt, 'utf8');
    appendFileSync(
      join(cwd, '.fadeno', 'dispatches.jsonl'),
      `${JSON.stringify({
        // Evidence-row format version, duplicated as a literal from
        // DISPATCHES_FORMAT in src/commands/dispatch.ts: this hook is a
        // standalone script with no import path back into the CLI, and both
        // writers must stamp the same version. Bump them together.
        format: '1.0',
        timestamp: new Date().toISOString(),
        event: 'host_delivery',
        // Same key the kernel stamps on every row it writes, so one field
        // answers "which Fadeno produced this evidence?" across the whole log.
        // For a hook-written row the hook *is* that Fadeno: both emitters
        // replace HOOK_VERSION with the package version, so this records the
        // plugin build the session actually loaded — which is the only thing
        // that can confirm what a session's subagents really are.
        fadeno_version: HOOK_VERSION,
        hook_version: HOOK_VERSION,
        archetype,
        agent_type: requested,
        executor: typeof slot?.executor === 'string' ? slot.executor : null,
        model: typeof slot?.model === 'string' ? slot.model : null,
        model_override: event.tool_input.model ?? null,
        // The model the hook actually placed on `updatedInput` below — see
        // the `commandDelivery ? relayModel : inheritModel ? … : slot.model`
        // decision at the foot of this file (the `commandDelivery` branch is
        // unreachable from here today, since a command-delivered spawn takes
        // `stashRelay()` instead, but the field mirrors that ternary exactly
        // so it stays correct if that ever changes). `model_override` above
        // is only ever what the CALLER asked for — almost always null — so a
        // `host_delivery` row alone could not tell "the hook rewrote this
        // spawn to the relay" from "the caller happened to ask for it".
        model_applied: commandDelivery
          ? relayModel
          : inheritModel
            ? (event.tool_input.model ?? null)
            : (typeof slot?.model === 'string' ? slot.model : null),
        // What the spawn runs at. A host-lane spawn inherits the session by
        // construction now: an unpinned dial states no opinion, and a pinned
        // one only stayed in session because the resolver found the session
        // already at that level. So the observed session level IS this row's
        // effort. With nothing observed, a pin that the resolver kept on this
        // lane is the next best claim — it asserts session == pin — and the
        // literal 'inherited' is the last resort, which `fadeno dispatches`
        // knows to skip when comparing a row against its attestation.
        reasoning_effort: sessionEffort ?? (effortPinned ? pinnedEffort ?? 'inherited' : 'inherited'),
        // Where the value above came from. 'agent-file' retired with the
        // identity grid: no managed agent pins an effort any more, so nothing
        // but the session can set a host spawn's effort, and the remaining
        // values separate measured from asserted from unknown.
        //   session    — read from CLAUDE_EFFORT (or the resolver's read of it)
        //   dial       — unobserved; the dial's pin, which the host lane asserts
        //                the session matches
        //   unobserved — neither; `reasoning_effort` is the 'inherited' sentinel
        effort_source: sessionEffort != null
          ? 'session'
          : effortPinned && pinnedEffort != null
            ? 'dial'
            : 'unobserved',
        // Whether the dial pinned an effort. This is the input the lane
        // decision turns on and the one part of it a host row cannot
        // reconstruct from its other fields: an unpinned dial could never have
        // gone anywhere but this lane, while a pinned one is here only because
        // the session happened to match — and would have been command-
        // delivered from a session at any other level.
        effort_pinned: effortPinned,
        // The session's own level at spawn time — the only *observed* effort
        // on the row, because the harness silently downgrades a level the
        // model or the org will not serve. A row whose requested effort
        // exceeds what any spawn here has ever observed is the shape of that
        // downgrade. It repeats `reasoning_effort` whenever it is non-null,
        // which is the honest redundancy: on this lane they are the same fact.
        session_effort: sessionEffort,
        // Why the resolver kept this spawn in session. The lane is now
        // session-state dependent and can flip mid-session — the same dial is
        // host-delivered from a matching session and command-delivered from
        // any other — so the reason is the only record of which state this
        // spawn saw. Null from a `fadeno` that predates the field.
        lane_reason: laneReason,
        // (`materialized_source` retired here with the identity grid. It named
        // the grid cell or per-dial file an agent was cut from, so that a
        // spawn carrying yesterday's identity could be spotted after the fact.
        // A managed role agent no longer carries a dial's identity at all — no
        // model, no effort — so there is nothing left for it to be stale
        // against, and the field would only ever have repeated `archetype`.
        // Nothing read it: `src/commands/dispatches.ts` never did.)
        transport: 'host',
        dial_source: typeof slot?.source === 'string' ? slot.source : slot?.dial_source ?? null,
        driver: typeof slot?.driver === 'string' ? slot.driver : null,
        effort: typeof slot?.effort === 'string' ? slot.effort : null,
        prompt_sha256: promptSha256,
        prompt_snapshot: snapshotRel,
      })}\n`,
    );
  } catch {
    // best-effort: evidence is a trace, never a gate on the spawn decision
  }
}

// Where a host spawn lands. Only the retarget below consumes this now — the
// evidence row used to read an effort and a source off the resolved agent
// file, and with the grid retired there is nothing on that file to read.
const hostAgent = commandDelivery ? null : hostTarget(archetype);

if (commandDelivery) stashRelay(); // rewritten-to-proxy spawns get attested too
else recordHostDelivery(); // no kernel downstream: record the delivery here

let subagentType;
if (commandDelivery) {
  const localProxy = join(cwd, '.claude', 'agents', `dispatch-${archetype}.md`);
  subagentType = existsSync(localProxy) ? `dispatch-${archetype}` : `fadeno:dispatch-${archetype}`;
} else if (hostAgent != null) {
  subagentType = hostAgent; // managed role agent, registered locally under its bare name
} else {
  const localAgent = join(cwd, '.claude', 'agents', `${archetype}.md`);
  subagentType = existsSync(localAgent) ? archetype : `fadeno:${archetype}`;
}

finish({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: {
      ...event.tool_input,
      subagent_type: subagentType,
      // Proxy relays run on the catalog's relay identity (`relay.claude`),
      // resolved into `relayModel` above — the dogfood receipt for why it must
      // stay a capable model, and why `sonnet` remains the built-in fallback,
      // lives with it. An inheriting host slot names no model, so the caller's
      // carries through untouched.
      ...(commandDelivery ? { model: relayModel } : inheritModel ? {} : { model: slot.model }),
    },
  },
});

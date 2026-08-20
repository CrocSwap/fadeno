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
const HOOK_VERSION = 'dev';

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
const resolution = spawnSync(cli, resolveArgv, {
  cwd,
  env: { ...process.env, FADENO_HARNESS: 'claude' },
  encoding: 'utf8',
  timeout: 10_000,
});
// A resolver error used to fall through to an unsteered host spawn —
// substituting a different executor for a proxy-bound archetype. Deny
// instead. Unreadable stdout (exit 0, not JSON) still fail-opens below.
if (resolution.status !== 0) {
  const stderr = (resolution.stderr ?? '').trim();
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        stderr.length > 0
          ? stderr
          : 'fadeno dial resolve failed; refusing a spawn no dial slot steered.',
    },
  });
}
let slot;
try {
  slot = JSON.parse(resolution.stdout ?? '');
} catch {
  passThrough();
}
if (slot?.adapter !== 'command' && slot?.adapter !== 'host') passThrough();
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
// ordinary `host_in_session` refusal — turning a selected pair into a failed
// task instead of the in-session work it would otherwise have done. An
// unroutable selected pair therefore degrades to "no pair": `pairSelected`
// stays false and the spawn takes the path it would have taken anyway.
const pairSelected = slot.shadow?.selected === true && slot.shadow?.routable === true;
const commandDelivery = slot.adapter === 'command' || pairSelected;
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
 * Which already-registered agent a host spawn should land on, and what that
 * agent pins.
 *
 * `fadeno steering apply --claude` pre-registers an identity grid — one
 * managed agent per (archetype, named effort) declaring `model: inherit` — so
 * that changing a dial never needs a fresh session: the model rides the tool
 * call, and the effort cell already exists. Falling back through the legacy
 * per-dial file to the plain role agent keeps a repo that has not applied the
 * grid working, at inherited effort.
 *
 * Project scope first, then user scope — the two places that command writes.
 */
function hostTarget(archetypeName, effort) {
  const managed = (path) => {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null; // absent or unreadable
    }
    return text.includes('<!-- fadeno:managed') ? text : null;
  };
  const roots = [join(cwd, '.claude', 'agents'), join(homedir(), '.claude', 'agents')];
  if (typeof effort === 'string' && effort.length > 0 && effort !== 'default') {
    const name = `fadeno-${archetypeName}-${effort}`;
    for (const root of roots) {
      if (managed(join(root, `${name}.md`)) != null) {
        return { agent: name, effort, source: `grid:${archetypeName}@${effort}` };
      }
    }
  }
  // Legacy per-dial file: pre-grid installs still pin an effort in frontmatter.
  for (const root of roots) {
    const text = managed(join(root, `${archetypeName}.md`));
    if (text == null) continue;
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    const pinned = frontmatter ? /^effort:[ \t]*(\S+)[ \t]*$/m.exec(frontmatter[1]) : null;
    const source = /<!-- fadeno:managed[^>]*\bsource=(\S+)/.exec(text);
    return {
      agent: archetypeName,
      effort: pinned ? pinned[1] : null,
      source: source ? source[1] : null,
    };
  }
  return { agent: null, effort: null, source: null };
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
    const materialized = { effort: target.effort, source: target.source };
    // Published by the harness to hook commands and Bash, already resolved
    // past any per-model or per-org downgrade.
    const sessionEffort = typeof process.env.CLAUDE_EFFORT === 'string' && process.env.CLAUDE_EFFORT.trim() !== ''
      ? process.env.CLAUDE_EFFORT.trim()
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
        // the `commandDelivery ? 'sonnet' : inheritModel ? … : slot.model`
        // decision at the foot of this file (the `commandDelivery` branch is
        // unreachable from here today, since a command-delivered spawn takes
        // `stashRelay()` instead, but the field mirrors that ternary exactly
        // so it stays correct if that ever changes). `model_override` above
        // is only ever what the CALLER asked for — almost always null — so a
        // `host_delivery` row alone could not tell "the hook rewrote this
        // spawn to sonnet" from "the caller happened to ask for sonnet".
        model_applied: commandDelivery
          ? 'sonnet'
          : inheritModel
            ? (event.tool_input.model ?? null)
            : (typeof slot?.model === 'string' ? slot.model : null),
        // What the spawn runs at — see `materializedAgent`. Through rc.33 this
        // was the literal 'inherited', which was true only of the baseline and
        // wrong for every materialized dial. An unmaterialized slot really
        // does take the session's, and the harness publishes that to hook
        // commands, so record the value rather than the word.
        reasoning_effort: materialized.effort ?? sessionEffort ?? 'inherited',
        // Which channel won, so a reader never has to infer it.
        effort_source: materialized.effort != null ? 'agent-file' : 'session',
        // The session's own level at spawn time. Alongside an `agent-file`
        // effort it is the fallback the frontmatter is overriding; it is also
        // the only *observed* effort on the row, because the harness silently
        // downgrades a level the model or the org will not serve. A row whose
        // requested effort exceeds what any spawn here has ever observed is
        // the shape of that downgrade.
        session_effort: sessionEffort ?? null,
        // The executor the agent file was cut from. Differs from `executor`
        // when the dial moved and `steering apply --claude` has not been rerun
        // since — the spawn then carries yesterday's identity, and only this
        // field can say so after the fact.
        materialized_source: materialized.source ?? null,
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

// Resolve the host landing point before writing evidence, so the row reports
// what the spawn will actually run at rather than what was asked for.
const target = commandDelivery
  ? { agent: null, effort: null, source: null }
  : hostTarget(archetype, typeof slot?.effort === 'string' ? slot.effort : null);

if (commandDelivery) stashRelay(); // rewritten-to-proxy spawns get attested too
else recordHostDelivery(); // no kernel downstream: record the delivery here

let subagentType;
if (commandDelivery) {
  const localProxy = join(cwd, '.claude', 'agents', `dispatch-${archetype}.md`);
  subagentType = existsSync(localProxy) ? `dispatch-${archetype}` : `fadeno:dispatch-${archetype}`;
} else if (target.agent != null) {
  subagentType = target.agent; // grid cell or legacy managed file — locally registered
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
      // Proxy relays run on sonnet: the 2026-08-12 dogfood A/B showed haiku
      // defecting on the relay contract (did the task itself, dropped the
      // prompt's first line, asserted unwritten evidence); sonnet relayed
      // flawlessly, and a proxy turn is only a few relay tokens. An inheriting
      // host slot names no model, so the caller's carries through untouched.
      ...(commandDelivery ? { model: 'sonnet' } : inheritModel ? {} : { model: slot.model }),
    },
  },
});

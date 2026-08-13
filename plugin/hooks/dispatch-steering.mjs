#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Which generation of this hook wrote a given evidence row. Plugin hooks load
// once at session start from a version-keyed cache, so a live session keeps
// running the previous build's hook after an upgrade — evidence written across
// that transition otherwise can't say which generation produced it. Both
// emitters (`fadeno plugin` and `fadeno init --claude`) replace this literal
// with the package version; the template keeps 'dev', so a row reading 'dev'
// means the template was executed directly rather than an installed copy.
const HOOK_VERSION = '0.6.0-rc.22';

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
const explicitProxy = /^dispatch-(worker|reviewer|judge)$/.test(bare);
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
  : bare === 'worker' || bare === 'reviewer' || bare === 'judge'
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

// Resolve through a structured CLI surface. The same neutral loadout can be
// host-delivered in Claude and command-delivered in Codex (or vice versa).
const resolution = spawnSync(cli, ['loadout', 'resolve', '--archetype', archetype], {
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
          : 'fadeno loadout resolve failed; refusing a spawn no loadout slot steered.',
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
const commandDelivery = slot.adapter === 'command';
// A host slot with no model of its own inherits the caller's; `current-host`
// is the explicit spelling of that.
const inheritModel =
  !commandDelivery && (typeof slot.model !== 'string' || slot.model === 'current-host');
// An unsteered spawn already lands on the caller's host model, so there is
// nothing to rewrite. A named proxy is not unsteered: leaving it alone would
// ship the task to a subprocess the loadout never asked for.
if (inheritModel && !explicitProxy) finish(null);

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
        format: '0.2',
        timestamp: new Date().toISOString(),
        event: 'host_delivery',
        hook_version: HOOK_VERSION,
        archetype,
        agent_type: requested,
        loadout: typeof slot?.active?.name === 'string' ? slot.active.name : null,
        executor: typeof slot?.executor === 'string' ? slot.executor : null,
        model: typeof slot?.model === 'string' ? slot.model : null,
        model_override: event.tool_input.model ?? null,
        // Host delivery cannot pin reasoning effort: the harness Agent tool
        // takes no effort parameter, so the spawn inherits the session's.
        reasoning_effort: 'inherited',
        transport: 'host',
        prompt_sha256: promptSha256,
        prompt_snapshot: snapshotRel,
      })}\n`,
    );
  } catch {
    // best-effort: evidence is a trace, never a gate on the spawn decision
  }
}

if (commandDelivery) stashRelay(); // rewritten-to-proxy spawns get attested too
else recordHostDelivery(); // no kernel downstream: record the delivery here
const prefix = commandDelivery ? 'dispatch-' : '';
const localAgent = join(cwd, '.claude', 'agents', `${prefix}${archetype}.md`);
const target = existsSync(localAgent) ? `${prefix}${archetype}` : `fadeno:${prefix}${archetype}`;

finish({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: {
      ...event.tool_input,
      subagent_type: target,
      // Proxy relays run on sonnet: the 2026-08-12 dogfood A/B showed haiku
      // defecting on the relay contract (did the task itself, dropped the
      // prompt's first line, asserted unwritten evidence); sonnet relayed
      // flawlessly, and a proxy turn is only a few relay tokens. An inheriting
      // host slot names no model, so the caller's carries through untouched.
      ...(commandDelivery ? { model: 'sonnet' } : inheritModel ? {} : { model: slot.model }),
    },
  },
});

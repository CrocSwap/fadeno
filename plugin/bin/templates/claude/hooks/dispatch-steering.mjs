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

if (/^dispatch-(worker|reviewer|judge)$/.test(bare)) {
  stashRelay(); // explicitly-targeted proxy: no rewrite, but attest the relay
  finish(null);
}
const archetype =
  bare === 'general-purpose' || bare === 'worker'
    ? 'worker'
    : bare === 'reviewer'
      ? 'reviewer'
      : bare === 'judge'
        ? 'judge'
        : null;
if (archetype == null) finish(null); // Explore, Plan, and unrelated specialists stay native.

// Resolve through a structured CLI surface. The same neutral loadout can be
// native in Claude and command-delivered in Codex (or vice versa).
const resolution = spawnSync(cli, ['loadout', 'resolve', '--archetype', archetype], {
  cwd,
  env: { ...process.env, FADENO_HARNESS: 'claude' },
  encoding: 'utf8',
  timeout: 10_000,
});
if (resolution.status !== 0) finish(null);
let slot;
try {
  slot = JSON.parse(resolution.stdout ?? '');
} catch {
  finish(null);
}
if (slot?.adapter !== 'command' && slot?.adapter !== 'host') finish(null);
if (slot.adapter === 'host' && (typeof slot.model !== 'string' || slot.model === 'current-host')) {
  finish(null); // The safe default inherits the caller's native model unchanged.
}

// Evidence for native delivery. Command delivery ends at `fadeno dispatch`,
// where the kernel writes the request/completion row pair; native delivery
// never reaches the kernel, so this hook is the only Fadeno code on that path
// and therefore its evidence writer. One `native_delivery` row plus a
// kernel-shaped prompt snapshot keeps both delivery modes auditable from the
// same `.fadeno/dispatches.jsonl`.
function recordNativeDelivery() {
  const prompt = event.tool_input.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) return;
  if (!existsSync(join(cwd, '.fadeno'))) return; // not a Fadeno repo
  try {
    const promptSha256 = createHash('sha256').update(prompt).digest('hex');
    const snapshotRel = `.fadeno/local/prompts/native-${promptSha256.slice(0, 8)}.md`;
    mkdirSync(join(cwd, '.fadeno', 'local', 'prompts'), { recursive: true });
    writeFileSync(join(cwd, snapshotRel), prompt, 'utf8');
    appendFileSync(
      join(cwd, '.fadeno', 'dispatches.jsonl'),
      `${JSON.stringify({
        // Evidence-row format version, duplicated as a literal from
        // DISPATCHES_FORMAT in src/commands/dispatch.ts: this hook is a
        // standalone script with no import path back into the CLI, and both
        // writers must stamp the same version. Bump them together.
        format: '0.1',
        timestamp: new Date().toISOString(),
        event: 'native_delivery',
        hook_version: HOOK_VERSION,
        archetype,
        agent_type: requested,
        loadout: typeof slot?.active?.name === 'string' ? slot.active.name : null,
        executor: typeof slot?.executor === 'string' ? slot.executor : null,
        model: typeof slot?.model === 'string' ? slot.model : null,
        model_override: event.tool_input.model ?? null,
        // Native delivery cannot pin reasoning effort: the harness Agent tool
        // takes no effort parameter, so the spawn inherits the session's.
        reasoning_effort: 'inherited',
        transport: 'host-native',
        prompt_sha256: promptSha256,
        prompt_snapshot: snapshotRel,
      })}\n`,
    );
  } catch {
    // best-effort: evidence is a trace, never a gate on the spawn decision
  }
}

const commandDelivery = slot.adapter === 'command';
if (commandDelivery) stashRelay(); // rewritten-to-proxy spawns get attested too
else recordNativeDelivery(); // no kernel downstream: record the delivery here
const localAgent = join(
  cwd,
  '.claude',
  'agents',
  `${commandDelivery ? 'dispatch-' : ''}${archetype}.md`,
);
const target = existsSync(localAgent)
  ? `${commandDelivery ? 'dispatch-' : ''}${archetype}`
  : `fadeno:${commandDelivery ? 'dispatch-' : ''}${archetype}`;

finish({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: {
      ...event.tool_input,
      subagent_type: target,
      // Proxy relays run on sonnet: the 2026-08-12 dogfood A/B showed haiku
      // defecting on the relay contract (did the task itself, dropped the
      // prompt's first line, asserted unwritten evidence); sonnet relayed
      // flawlessly, and a proxy turn is only a few relay tokens.
      model: commandDelivery ? 'sonnet' : slot.model,
    },
  },
});

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const commandDelivery = slot.adapter === 'command';
if (commandDelivery) stashRelay(); // rewritten-to-proxy spawns get attested too
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

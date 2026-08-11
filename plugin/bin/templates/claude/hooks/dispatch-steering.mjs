#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const active = spawnSync('fadeno', ['loadout'], {
  cwd,
  env: process.env,
  encoding: 'utf8',
  timeout: 10_000,
});
if (active.status !== 0 || !/^active loadout:/m.test(active.stdout ?? '')) finish(null);

const requested = event.tool_input.subagent_type;
if (typeof requested !== 'string') finish(null);
const bare = requested.split(':').at(-1);
const archetype =
  bare === 'general-purpose' || bare === 'worker'
    ? 'worker'
    : bare === 'reviewer'
      ? 'reviewer'
      : bare === 'judge'
        ? 'judge'
        : null;
if (archetype == null) finish(null); // Explore, Plan, and unrelated specialists stay native.

// The safe bundled `native` loadout is intentionally inert. Only a declared
// command slot crosses the Claude sandbox boundary; resolution stays live in
// the CLI and is never cached in this hook.
const slot = new RegExp(`^\\s*${archetype}\\s+→.*\\[command\\]`, 'm');
const hasSlots = /^\s*(worker|reviewer|judge)\s+→/m.test(active.stdout ?? '');
if (!hasSlots || !slot.test(active.stdout ?? '')) finish(null);

const localProxy = join(cwd, '.claude', 'agents', `dispatch-${archetype}.md`);
const target = existsSync(localProxy)
  ? `dispatch-${archetype}`
  : `fadeno:dispatch-${archetype}`;

finish({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: {
      ...event.tool_input,
      subagent_type: target,
      model: 'haiku',
    },
  },
});

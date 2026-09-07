#!/usr/bin/env node
// The stop hook (spec decision 32), on Claude Code and Codex alike: when a
// subagent stops — finished, interrupted, killed, or cut off by a session
// limit — hand the CLI the facts and let it write the stopped row.
//
// A stop event names an agent, never a dispatch. The one thing that ties the
// two is the contract Fadeno appended to the agent's prompt, whose header
// carries the dispatch id; the prompt is the first record of the agent's
// transcript, so `fadeno dispatch-stop --transcript <path>` reads it back.
// An agent whose transcript carries no contract was not a dispatch, and the
// CLI says so with exit 4; nothing is recorded and nothing is claimed.
//
// What the row can and cannot say is the CLI's business (see `dispatch-stop`):
// the presence of a final message, never completeness; the paths dirty in
// the assigned worktree; the model the transcript says it ran on. This hook
// only carries the harness's facts across. Both harnesses spell every field
// this reads the same way (`cwd`, `agent_transcript_path`,
// `last_assistant_message`), so one file serves both.
//
// Budget: the harness gives a stop hook a few seconds on the interrupted path.
// One CLI call, bounded, and no decision — this is evidence, never a gate.

import { finish, readEvent, resolveCli, runFadeno, str } from './hook-lib.mjs';

const STOP_TIMEOUT_MS = 4_000;

const event = readEvent();
if (event == null) finish(null);
if (typeof event.hook_event_name === 'string' && event.hook_event_name !== 'SubagentStop') finish(null);
// A write needs to know which repo it belongs to; a caller that does not say
// has not earned a guess. Both harnesses always send `cwd`.
const cwd = str(event.cwd);
const transcript = str(event.agent_transcript_path);
if (cwd == null || transcript == null) finish(null);

const cli = resolveCli(import.meta.url);
const harness = typeof event.turn_id === 'string' ? 'codex' : 'claude';
const lastMessage = typeof event.last_assistant_message === 'string' ? event.last_assistant_message : '';
const run = runFadeno(cli, ['dispatch-stop', '--transcript', transcript, '--json'], {
  cwd,
  input: lastMessage,
  harness,
  timeoutMs: STOP_TIMEOUT_MS,
});
if (run.status !== 0 || run.json?.ok !== true) finish(null); // not a dispatch, or nothing this hook can fix

const stopped = run.json;
const dirty = stopped.dirty === 'unavailable'
  ? 'tree unreadable'
  : stopped.dirty?.paths?.length > 0
    ? `${stopped.dirty.paths.length}${stopped.dirty.truncated ? '+' : ''} uncommitted path(s)`
    : 'tree clean';
// The CLI compares alias against reported id; the hook only relays its verdict.
const model = stopped.modelMismatch === true ? `; ran on ${stopped.modelObserved}, not the dialed ${stopped.model}` : '';
finish({
  systemMessage:
    `fadeno: dispatch ${stopped.name} stopped${stopped.replayed ? ' (already recorded)' : ''}; ${dirty}${model}. ` +
    `Close it: fadeno dispatch-close ${stopped.name} --merged|--kept|--discarded|--failed`,
});

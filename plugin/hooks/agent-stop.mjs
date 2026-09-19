#!/usr/bin/env node
// The stop hook (spec decision 32), on Claude Code and Codex alike: when a
// subagent stops — finished, interrupted, killed, or cut off by a session
// limit — hand the CLI the facts and let it write the stopped row.
//
// A stop event names an agent, never a dispatch, so something has to tie the
// two. There are two ties and the CLI tries them in this order:
//
//   `--agent-id` — the harness's own id for the subagent, recorded on the row
//   when the dispatch was opened for it. Exact, and it holds even when the
//   contract never reached the transcript.
//
//   `--transcript` — the contract header in the agent's prompt names the
//   dispatch. The only tie on a harness that gives a stop hook no agent id,
//   and the one that catches a dispatch opened before this Fadeno.
//
// An agent that answers to neither was not a dispatch, and the CLI says so
// with exit 4; nothing is recorded and nothing is claimed.
//
// What the row can and cannot say is the CLI's business (see `dispatch-stop`):
// the presence of a final message, never completeness; the paths dirty in
// the assigned worktree; the model the transcript says it ran on. This hook
// only carries the harness's facts across. Both harnesses spell every field
// this reads the same way (`cwd`, `agent_transcript_path`,
// `last_assistant_message`), so one file serves both.
//
// Budget: the harness gives a stop hook a few seconds on the interrupted path.
// Ask the CLI for its cheap durable receipt first; optional Git inspection is
// explicitly deferred so the harness budget cannot strand an otherwise done
// dispatch as open. This is evidence, never a gate.

import { describeFailure, finish, readEvent, resolveCli, runFadeno, str } from './hook-lib.mjs';

const event = readEvent();
if (event == null) finish(null);
if (typeof event.hook_event_name === 'string' && event.hook_event_name !== 'SubagentStop') finish(null);
// A write needs to know which repo it belongs to; a caller that does not say
// has not earned a guess. Both harnesses always send `cwd`.
const cwd = str(event.cwd);
const transcript = str(event.agent_transcript_path);
const agentId = str(event.agent_id);
if (cwd == null || (transcript == null && agentId == null)) finish(null);

const cli = resolveCli(import.meta.url);
const harness = typeof event.turn_id === 'string' ? 'codex' : 'claude';
const lastMessage = typeof event.last_assistant_message === 'string' ? event.last_assistant_message : '';
const args = ['dispatch-stop', '--durable', '--json'];
if (agentId != null) args.push('--agent-id', agentId);
if (transcript != null) args.push('--transcript', transcript);
const run = runFadeno(cli, args, {
  cwd,
  input: lastMessage,
  harness,
  // This path writes only the durable receipt. Let the harness own its hook
  // lifetime rather than adding a second Fadeno deadline that can lose it.
  timeoutMs: 0,
});
if (run.status === 4 && run.json?.ok === false && run.json.dispatch == null) finish(null); // an ordinary, non-Fadeno subagent
if (run.status !== 0 || run.json?.ok !== true) {
  const replayArgs = ['fadeno', 'dispatch-stop'];
  if (agentId != null) replayArgs.push('--agent-id', agentId);
  if (transcript != null) replayArgs.push('--transcript', transcript);
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const replay = replayArgs.map(shellQuote).join(' ');
  finish({
    systemMessage:
      `fadeno: could not record the stopped dispatch. ${describeFailure(run, 'fadeno dispatch-stop')} ` +
      `Verify with \`fadeno dispatches\`; if it is still open, save the received final response to a file and replay idempotently with ` +
      `\`${replay} --message-file <path>\`, then inspect the report and close it normally. Stdin remains supported, but a live two-process pipeline is not the default recovery path.`,
  });
}

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
    `fadeno: dispatch ${stopped.name} stopped${stopped.replayed ? ' (already recorded)' : ''}; ` +
    `${stopped.inspectionPending === true ? 'stop recorded durably; worktree inspection deferred' : dirty}${model}. ` +
    `Close it: fadeno dispatch-close ${stopped.name} --merged|--kept|--discarded|--failed|--reviewed`,
});

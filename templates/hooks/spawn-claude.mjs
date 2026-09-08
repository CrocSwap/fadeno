#!/usr/bin/env node
// Fadeno's spawn wrapper on Claude Code (spec §04): a PreToolUse hook on the
// Agent tool. For a spawn that names an archetype it asks `fadeno
// dispatch-open` what to do and applies the answer by rewriting the spawn:
//
//   - host lane: the agent keeps its archetype, gets the contract-bearing
//     prompt and the dialed model, and the opened row is already written;
//   - command lane: the spawn becomes the dispatch proxy, whose prompt is the
//     one `fadeno dispatch` command that runs the staged task.
//
// The director observes no difference: it named an archetype and gets a
// report. Either way the answer carries the dispatch's id and name and every
// unclosed dispatch in the repository, so the host is reminded at every spawn.
//
// A spawn that names no archetype is the harness's own. Outside host mode it
// passes through untouched; in host mode it is refused, because the user
// asked for delegated work to go through Fadeno and a generic subagent on the
// session's model, recorded nowhere, is exactly the substitution that mode
// exists to stop. Every refusal names the way out.
//
// This hook writes nothing. The CLI writes the ledger; the hook only rewrites
// the call. What it cannot verify — that the harness honoured the model it
// set — the stop hook reads back from the transcript.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANON_ARCHETYPES,
  classifyAgentType,
  describeFailure,
  finish,
  hostModeEnabled,
  nameFrom,
  proxyPrompt,
  readEvent,
  refusal,
  resolveCli,
  runFadeno,
  str,
} from './hook-lib.mjs';

const event = readEvent();
if (event == null || event.tool_name !== 'Agent') finish(null);
const input = event.tool_input;
if (input == null || typeof input !== 'object' || Array.isArray(input)) finish(null);

const cwd = str(event.cwd) ?? process.cwd();
const cli = resolveCli(import.meta.url);
const session = str(event.session_id);
const requested = str(input.subagent_type);
const spawn = classifyAgentType(requested);
const explicitModel = str(input.model);

function deny(reason) {
  finish({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: refusal(reason),
    },
  });
}

// --- spawns that name no archetype ------------------------------------------

if (spawn.kind !== 'archetype') {
  if (!hostModeEnabled(session)) finish(null);
  const what = requested == null
    ? 'This spawn named no subagent_type at all, which starts the harness\'s default general-purpose subagent'
    : spawn.kind === 'proxy'
      ? `This spawn named the dispatch proxy (${requested}) directly; the proxy only runs a command Fadeno composed, so nothing would be dispatched`
      : `This spawn asked for subagent_type "${requested}", which names no Fadeno archetype`;
  deny(
    `fadeno: host mode is on for this session, and it refuses generic (non-archetype) subagents. ${what}, ` +
      `so it would have run on ${explicitModel != null ? `the model it named (${explicitModel})` : "the session's model"} ` +
      'with no dial, no worktree, no contract and no ledger row. ' +
      `Name an archetype instead — ${CANON_ARCHETYPES.map((a) => `fadeno:${a}`).join(', ')} — and Fadeno routes it ` +
      '(`fadeno context` shows what each one is and where it runs). To allow generic subagents again for the rest of this session, run `/fadeno:host off`.',
  );
}

// --- archetype spawns: the wrapper -------------------------------------------

const archetype = spawn.archetype;
const prompt = typeof input.prompt === 'string' ? input.prompt : '';
const name = nameFrom(input.description);
const args = ['dispatch-open', '--archetype', archetype, '--json', '--harness', 'claude'];
if (name != null) args.push('--name', name);
if (explicitModel != null) args.push('--model', explicitModel);
if (session != null) args.push('--session-id', session);
// A spawn from inside a dispatched agent (a director) has a parent: its
// transcript's contract header names it. The path follows the harness's
// layout — <session transcript dir>/<session id>/subagents/agent-<id>.jsonl —
// and a path that does not exist is simply not consulted.
const agentId = str(event.agent_id);
const sessionTranscript = str(event.transcript_path);
if (agentId != null && sessionTranscript != null) {
  const parentTranscript = join(sessionTranscript.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
  if (existsSync(parentTranscript)) args.push('--parent-transcript', parentTranscript);
}

const run = runFadeno(cli, args, { cwd, input: prompt, harness: 'claude' });
if (run.failure != null) deny(`fadeno: could not open the ${archetype} dispatch — ${describeFailure(run, 'fadeno dispatch-open')}`);
if (run.status === 3) deny(str(run.json?.refused) ?? run.stderr ?? 'fadeno refused the spawn.');
if (run.status !== 0) deny(`fadeno: could not open the ${archetype} dispatch — ${describeFailure(run, 'fadeno dispatch-open')}`);
const answer = run.json;
if (answer == null || answer.ok !== true) {
  deny(`fadeno: dispatch-open exited 0 without a readable answer (${run.stdout.trim().slice(0, 200) || 'empty stdout'}); refusing rather than spawning an unrecorded agent.`);
}

/** A repo-local agent of the same name shadows the plugin's: use its bare name. */
function agentType(bare) {
  return existsSync(join(cwd, '.claude', 'agents', `${bare}.md`)) ? bare : `fadeno:${bare}`;
}

const closeLine = (n) => `When it stops, read its report and close it: \`fadeno dispatch-close ${n} --merged|--kept|--discarded|--failed\`.`;

if (answer.opened === true) {
  const o = answer;
  const identity = o.model === 'host' ? "this session's model" : `${o.model}${o.effort ? `@${o.effort}` : ''}`;
  const where = o.workspace?.branch ? `branch ${o.workspace.branch}` : `the shared tree${o.sharedReason ? ` (${o.sharedReason})` : ''}`;
  const updatedInput = { ...input, subagent_type: agentType(archetype), prompt: o.prompt };
  // The dial's model rides the spawn. `host` names the session's own
  // model, which is what a spawn with no model runs on; an explicit override
  // was resolved by the CLI and is what `modelId` now carries.
  if (o.model !== 'host' && str(o.modelId) != null) updatedInput.model = o.modelId;
  else delete updatedInput.model;
  finish({
    systemMessage: `fadeno: ${archetype} → ${o.name} (${o.id.slice(0, 8)}) on ${identity}, host lane, ${where}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
      additionalContext:
        `Per the ${archetype} dial, Fadeno opened dispatch \`${o.name}\` (${o.id}) for this spawn on the host lane: ${identity}, working in ${o.cwd} on ${where}. ` +
        `${closeLine(o.name)}\n\n${o.nag}`,
    },
  });
}

// The command lane: the proxy runs the staged dispatch. The caller's explicit
// model went into the command; it must not also land on the proxy.
const r = answer;
const identity = `${r.model}${r.effort ? `@${r.effort}` : ''} on ${r.harness ?? '?'}`;
const label = r.name ?? archetype;
const updatedInput = { ...input, subagent_type: agentType('dispatch'), prompt: proxyPrompt(r.relay, `the ${archetype} task as ${identity}`) };
delete updatedInput.model;
finish({
  systemMessage: `fadeno: ${archetype} → command lane (${identity}); the dispatch proxy runs it as ${label}`,
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput,
    additionalContext:
      `Per the ${archetype} dial, this spawn takes the command lane (${identity}): the dispatch proxy runs \`${r.relay.command}\`, and the dispatch is recorded as \`${label}\` when it starts. ` +
      `${closeLine(label)}\n\n${r.nag}`,
  },
});

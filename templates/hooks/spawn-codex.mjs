#!/usr/bin/env node
// Fadeno's spawn hook on Codex: a PreToolUse hook on `spawn_agent` (matched
// as `Agent`). Codex measures differently from Claude in one way that decides
// this file's whole shape: a Codex PreToolUse hook can REFUSE a call and
// nothing else — `updatedInput` is rejected, and so is `permissionDecision:
// allow` — so the wrapper cannot rewrite a spawn's prompt, agent or model.
//
// What it CAN do is refuse a spawn and let a corrected one through, and Codex
// honours an explicit `model` and `reasoning_effort` on a spawn with no agent
// file. So the host lane here is a two-pass handshake:
//
//   1. An archetype spawn whose message carries no Fadeno contract is
//      REFUSED — but the dispatch is opened first, so the refusal can hand
//      back the exact spawn to make: the model, the effort, and the path to
//      the contract-bearing prompt. `--reuse-open` makes that idempotent, so
//      a fumbled retry cannot cut a second worktree.
//   2. The retry carries the contract header. The hook checks that it names a
//      dispatch that is open, not yet stopped, and that the spawn's model and
//      effort are the ones that dispatch was opened for — then says NOTHING,
//      and Codex delivers the subagent in-session on the dialed model.
//
// A spawn that resolves to a model this session cannot deliver takes the
// command lane instead, and is refused with the `fadeno dispatch` command that
// runs it: there is nothing to hand back to a retry there, because the work is
// a process rather than a subagent.
//
// Outside host mode Fadeno states no opinion and every spawn passes untouched.
//
// This hook writes nothing; the CLI does.

import {
  CANON_ARCHETYPES,
  classifyAgentType,
  contractHeader,
  describeFailure,
  finish,
  hostModeEnabled,
  nameFrom,
  readEvent,
  refusal,
  resolveCli,
  runFadeno,
  str,
} from './hook-lib.mjs';

const event = readEvent();
if (event == null || (event.tool_name !== 'spawn_agent' && event.tool_name !== 'Agent')) finish(null);
const input = event.tool_input;
if (input == null || typeof input !== 'object' || Array.isArray(input)) finish(null);

const session = str(event.session_id);
if (!hostModeEnabled(session)) finish(null);

const cwd = str(event.cwd) ?? process.cwd();
const cli = resolveCli(import.meta.url);
const requested = str(input.agent_type);
const spawn = classifyAgentType(requested);
const explicitModel = str(input.model);
const explicitEffort = str(input.reasoning_effort);
const parentModel = str(event.model);
const message = typeof input.message === 'string' ? input.message : '';

function deny(reason) {
  finish({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal(reason) },
  });
}

const HOW = 'On Codex a hook can refuse a spawn but not rewrite one, so Fadeno hands the corrected spawn back instead of applying it';

if (spawn.kind !== 'archetype') {
  deny(
    `fadeno: host mode is on for this session, and it refuses generic (non-archetype) subagents. This spawn asked for agent_type "${requested ?? '(unnamed)'}", ` +
      `which names no Fadeno archetype, so it would have run on ${explicitModel != null ? `the model it named (${explicitModel})` : parentModel != null ? `this session's model (${parentModel})` : "this session's model"} ` +
      `with no dial, no worktree, no contract and no ledger row. ${HOW}: spawn one of ${CANON_ARCHETYPES.join(', ')} and this hook tells you exactly how, ` +
      'or run `fadeno dispatch --archetype <name> --name <name> --prompt-file <file>` yourself. `fadeno context` shows each archetype and where it runs. ' +
      'To allow generic subagents again for the rest of this session, run `$fadeno-host off`.',
  );
}

const archetype = spawn.archetype;

// ---------------------------------------------------------------------------
// Pass 2: the corrected spawn. Its message already carries the contract.
// ---------------------------------------------------------------------------

const carried = contractHeader(message);
if (carried != null) {
  const look = runFadeno(cli, ['dispatches', carried.id, '--json'], { cwd, harness: 'codex' });
  if (look.failure != null || look.status !== 0 || look.json == null) {
    deny(
      `fadeno: this spawn carries the contract for dispatch ${carried.id}, but that dispatch could not be read back — ` +
        `${look.failure != null ? describeFailure(look, 'fadeno dispatches') : look.stderr.trim() || 'no such dispatch'}. ` +
        'Do not spawn an agent against a contract Fadeno cannot account for. Start the spawn again without the contract text and use the answer this hook gives you.',
    );
  }
  const record = look.json;
  const opened = record.opened ?? {};
  if (record.state !== 'open' || record.stopped != null) {
    deny(
      `fadeno: this spawn carries the contract for dispatch ${carried.id} (${opened.name ?? '?'}), which is ${record.stopped != null ? 'already stopped' : `already ${record.state}`}. ` +
        'A contract belongs to one agent. Spawn the archetype again with a fresh task and use the answer this hook gives you.',
    );
  }
  if (opened.archetype !== archetype) {
    deny(
      `fadeno: this spawn asks for \`${archetype}\` but carries the contract for dispatch ${carried.id}, which was opened for \`${opened.archetype}\`. ` +
        'Spawn the archetype the contract names, or start again for the one you meant.',
    );
  }
  const wantModel = opened.model_id ?? opened.model;
  const wantEffort = opened.effort;
  const modelOk = wantModel === 'host' || explicitModel === wantModel;
  // An unpinned dial states no effort, and a spawn that names none then
  // inherits the session — which is the intended outcome, not a mismatch.
  const effortOk = wantEffort == null || explicitEffort === wantEffort;
  if (!modelOk || !effortOk) {
    deny(
      `fadeno: dispatch ${opened.name} (${carried.id}) was opened for ${wantModel}${wantEffort ? `@${wantEffort}` : ''}, ` +
        `and this spawn carries ${explicitModel ?? "no model (it would inherit this session's)"}${explicitEffort ? `@${explicitEffort}` : ''}. ` +
        `The dial decides which model does this work. Spawn it again with model="${wantModel}"${wantEffort ? ` and reasoning_effort="${wantEffort}"` : ''} and the same message.`,
    );
  }
  // Everything the wrapper asked for is on this spawn. Say nothing: silence is
  // how a Codex hook lets a call through.
  finish(null);
}

// ---------------------------------------------------------------------------
// Pass 1: open (or relay) the dispatch, and hand back the spawn to make.
// ---------------------------------------------------------------------------

const name = nameFrom(input.name, input.task_name, input.description);
const args = ['dispatch-open', '--archetype', archetype, '--json', '--harness', 'codex', '--stage-prompt'];
if (name != null) args.push('--name', name, '--reuse-open');
if (explicitModel != null) args.push('--model', explicitModel);
if (session != null) args.push('--session-id', session);
const run = runFadeno(cli, args, { cwd, input: message, harness: 'codex' });

if (run.failure != null) deny(`fadeno: could not open the ${archetype} dispatch — ${describeFailure(run, 'fadeno dispatch-open')}`);
if (run.status === 3) deny(str(run.json?.refused) ?? run.stderr ?? 'fadeno refused the spawn.');
if (run.status !== 0) {
  const reason = describeFailure(run, 'fadeno dispatch-open');
  if (/nothing to invoke/.test(reason)) {
    deny(
      `fadeno: the ${archetype} archetype resolves to a model this session can neither deliver in-session nor run as a process, so there is no lane for it here. ` +
        `Dial it onto a model with a command lane (\`fadeno dial ${archetype} <model>\`), or onto this session's own model (\`fadeno dial ${archetype} host\`), then spawn it again.`,
    );
  }
  deny(`fadeno: could not open the ${archetype} dispatch — ${reason}`);
}
const answer = run.json;
if (answer == null || answer.ok !== true) {
  deny(`fadeno: dispatch-open exited 0 without an answer (${run.stdout.trim().slice(0, 200) || 'empty stdout'}); refusing rather than spawning an unrecorded agent.`);
}

// The command lane: the work is a process, not a subagent, so there is no
// corrected spawn to hand back — only the command that does it.
if (answer.opened !== true) {
  if (answer.relay == null) {
    deny(`fadeno: dispatch-open reported a command lane with no relay (${run.stdout.trim().slice(0, 200)}); refusing rather than spawning an unrecorded agent.`);
  }
  const identity = `${answer.model}${answer.effort ? `@${answer.effort}` : ''} on ${answer.harness ?? '?'}`;
  const label = answer.name ?? archetype;
  deny(
    `fadeno: this ${archetype} spawn goes through the command lane (${identity}) — that model runs as a process, not as a subagent of this session. ` +
      `The task is staged; run this, with a 600-second shell timeout, and read what it prints:\n\n` +
      `    ${answer.relay.command}\n\n` +
      `It records the dispatch as \`${label}\`. If that call is killed or times out, the dispatch is still running and its report is still coming: ` +
      `run \`fadeno dispatch-wait ${label}\` — it blocks until the dispatch stops and prints the report. It exits 2 with "still running" when it reaches its own bound first, which is not an error: run it again, as many times as it takes. ` +
      `When you have the report, read it and close the dispatch with \`fadeno dispatch-close ${label} --merged|--kept|--discarded|--failed\`. ` +
      `${answer.nag}`,
  );
}

// The host lane: opened, and the corrected spawn is one retry away.
const wantModel = answer.model === 'host' ? null : answer.modelId;
const wantEffort = answer.effort;
const identity = answer.model === 'host' ? "this session's own model" : `${answer.model}${wantEffort ? `@${wantEffort}` : ''}`;
const call = [
  `agent_type: "${archetype}"`,
  wantModel != null ? `model: "${wantModel}"` : null,
  wantModel != null && wantEffort != null ? `reasoning_effort: "${wantEffort}"` : null,
  `message: the exact contents of ${answer.promptFile}`,
].filter((part) => part != null).join('\n      ');

deny(
  `fadeno: dispatch ${answer.name} (${answer.id}) is ${answer.reused === true ? 'already open' : 'open'} and routed to ${identity}. ${HOW}. Spawn it again, exactly like this:\n\n` +
    `      ${call}\n\n` +
    `Read ${answer.promptFile} and pass its contents as the message unchanged — it is your task with the dispatch contract appended, and the contract is how this hook recognizes the corrected spawn and lets it through. ` +
    `The agent works in ${answer.cwd}${answer.workspace?.branch ? ` on branch ${answer.workspace.branch}` : ' (the shared tree)'}. ` +
    `When it stops, read its report and close the dispatch: \`fadeno dispatch-close ${answer.name} --merged|--kept|--discarded|--failed\`. ` +
    `${answer.nag}`,
);

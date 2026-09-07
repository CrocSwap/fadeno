#!/usr/bin/env node
// Fadeno's spawn hook on Codex: a PreToolUse hook on `spawn_agent` (matched
// as `Agent`). Codex measures differently from Claude in one way that decides
// this file's whole shape: a Codex PreToolUse hook can REFUSE a call and
// nothing else — `updatedInput` is rejected, and so is `permissionDecision:
// allow` — so the wrapper cannot rewrite a spawn's prompt, agent or model. It
// can still do every other part of its job by handing the work to the command
// lane, which `fadeno dispatch` wraps completely.
//
// In host mode, therefore:
//   - a spawn that names no archetype is refused (the 2026-09-04 basanos
//     receipt: three generic subagents on a frontier model, reported to
//     nobody);
//   - a spawn that names an archetype is refused WITH the exact `fadeno
//     dispatch` command that runs it — the prompt is already staged by
//     `fadeno dispatch-open --lane command`, so the director copies one
//     line and nothing travels through a model twice.
// Outside host mode Fadeno states no opinion and the spawn passes untouched.
//
// This hook writes nothing; the CLI does.

import {
  CANON_ARCHETYPES,
  classifyAgentType,
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
const parentModel = str(event.model);

function deny(reason) {
  finish({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal(reason) },
  });
}

const HOW = 'On Codex a hook can refuse a spawn but not rewrite it, so delegated work goes through the command lane';

if (spawn.kind !== 'archetype') {
  deny(
    `fadeno: host mode is on for this session, and it refuses generic (non-archetype) subagents. This spawn asked for agent_type "${requested ?? '(unnamed)'}", ` +
      `which names no Fadeno archetype, so it would have run on ${explicitModel != null ? `the model it named (${explicitModel})` : parentModel != null ? `this session's model (${parentModel})` : "this session's model"} ` +
      `with no dial, no worktree, no contract and no ledger row. ${HOW}: spawn one of ${CANON_ARCHETYPES.join(', ')} and this hook hands you the command, ` +
      'or run `fadeno dispatch --archetype <name> --name <name> --prompt-file <file>` yourself. `fadeno context` shows each archetype and where it runs. ' +
      'To allow generic subagents again for the rest of this session, run `$fadeno-host off`.',
  );
}

const archetype = spawn.archetype;
const message = typeof input.message === 'string' ? input.message : '';
const name = nameFrom(input.name, input.description);
const args = ['dispatch-open', '--archetype', archetype, '--lane', 'command', '--json', '--harness', 'codex'];
if (name != null) args.push('--name', name);
if (explicitModel != null) args.push('--model', explicitModel);
if (session != null) args.push('--session-id', session);
const run = runFadeno(cli, args, { cwd, input: message, harness: 'codex' });

if (run.failure != null) deny(`fadeno: could not stage the ${archetype} dispatch — ${describeFailure(run, 'fadeno dispatch-open')}`);
if (run.status === 3) deny(str(run.json?.refused) ?? run.stderr ?? 'fadeno refused the spawn.');
if (run.status !== 0) {
  const reason = describeFailure(run, 'fadeno dispatch-open');
  if (/nothing to invoke/.test(reason)) {
    deny(
      `fadeno: the ${archetype} archetype resolves to this session's own model and has no command lane, and ${HOW.charAt(0).toLowerCase()}${HOW.slice(1)} — ` +
        'except that this one cannot. Either dial it onto a model with a command lane (`fadeno dial ' + archetype + ' <model>`), or open it by hand: write the task to a file, run ' +
        `\`fadeno dispatch-open --archetype ${archetype} --lane host${name != null ? ` --name '${name}'` : ''} --prompt-file <file> --json\`, spawn \`${archetype}\` with the \`prompt\` it returns, and let the stop hook record the stop.`,
    );
  }
  deny(`fadeno: could not stage the ${archetype} dispatch — ${reason}`);
}
const answer = run.json;
if (answer == null || answer.ok !== true || answer.opened !== false || answer.relay == null) {
  deny(`fadeno: dispatch-open exited 0 without a relay (${run.stdout.trim().slice(0, 200) || 'empty stdout'}); refusing rather than spawning an unrecorded agent.`);
}
const identity = `${answer.model}${answer.effort ? `@${answer.effort}` : ''} on ${answer.harness ?? '?'}`;
const label = answer.name ?? archetype;
deny(
  `fadeno: this ${archetype} spawn goes through the command lane (${identity}). ${HOW}. The task is staged; run this, with a 600-second shell timeout, and read what it prints:\n\n` +
    `    ${answer.relay.command}\n\n` +
    `It records the dispatch as \`${label}\`; when it returns, read the report and close it with \`fadeno dispatch-close ${label} --merged|--kept|--discarded|--failed\`. ` +
    `${answer.nag}`,
);

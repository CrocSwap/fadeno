#!/usr/bin/env node
// Fadeno's spawn hook on Codex. One file, two events, because they are two
// halves of one decision:
//
//   PreToolUse (on the spawn tool)  — the only place a spawn can be REFUSED.
//   SubagentStart (on the subagent) — the only place its contract can be GIVEN.
//
// Codex cannot rewrite a call. Its PreToolUse wire struct carries
// `updatedInput`, but the validator rejects it without `permissionDecision:
// allow`, and rejects `allow` itself; PermissionRequest's copy is documented
// in the binary as "reserved for a future input-rewrite capability… hooks
// currently fail closed if this field is present". So the prompt a host writes
// is the prompt the agent gets, and Fadeno adds nothing to it.
//
// It does not have to. `SubagentStart` accepts `additionalContext`, and that
// text reaches the SUBAGENT — measured with a secret the parent never saw, and
// landing in the subagent's rollout as a `developer` message, which carries
// more weight than the tail of a user prompt and which the agent will not quote
// back. So the contract is delivered rather than composed, and the two-pass
// refuse-and-retry handshake this file used to run is gone: an archetype spawn
// that names the right model now simply passes.
//
// The division of labour is deliberate. PreToolUse knows the model and the
// message but not which subagent it becomes; SubagentStart knows the agent id
// but neither the model's origin nor the prompt. So everything CONSEQUENTIAL —
// opening the dispatch, cutting the worktree, writing the row — happens at
// SubagentStart, where `agent_id` makes the binding exact. Only the LABEL (the
// task name, and the prompt when Codex left it readable) is carried across by
// arrival order, and when two spawns of one archetype are in flight Fadeno
// declines to guess rather than attach the wrong one.
//
// Outside host mode Fadeno states no opinion and every spawn passes untouched.
//
// This hook writes no ledger rows; the CLI does.

import {
  CANON_ARCHETYPES,
  classifyAgentType,
  describeFailure,
  finish,
  hostModeEnabled,
  isSpawnTool,
  messageIsSealed,
  nameFrom,
  readEvent,
  refusal,
  resolveCli,
  runFadeno,
  stashPending,
  str,
  takePending,
} from './hook-lib.mjs';

const SEALED_REASON = "Codex encrypted the spawn's message; the hook that opened this dispatch could not read it";
const UNSEEN_REASON = 'Fadeno recorded no spawn for this agent, so it never saw the task — the agent may have been started outside host mode, or by a Fadeno that was not watching';

const event = readEvent();
if (event == null) finish(null);
const eventName = str(event.hook_event_name) ?? '';
const session = str(event.session_id);
const cwd = str(event.cwd) ?? process.cwd();
const cli = resolveCli(import.meta.url);

if (!hostModeEnabled(session)) finish(null);

function deny(reason) {
  finish({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal(reason) },
  });
}

/**
 * Pass, and say why. Exactly two keys: any `permissionDecision` other than
 * deny — and a `permissionDecisionReason` without one — makes Codex mark the
 * hook Failed, run the call anyway, and discard this text with the rest of the
 * output. Every addition here needs a live probe first.
 */
function passWith(text) {
  finish({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}

/**
 * What this spawn WOULD become: lane, model, effort, and whether it can be
 * delivered here — decided by the same call that will open it, one step short
 * of writing. Asking `fadeno dial` instead would have made this hook a second
 * reader of the lane rule and of the unclosed limit, and two readers of one
 * rule is how they come to disagree.
 */
function wouldOpen(archetype) {
  const run = runFadeno(cli, ['dispatch-open', '--archetype', archetype, '--dry-run', '--json', '--harness', 'codex'], { cwd, harness: 'codex' });
  if (run.status === 3) return { refused: str(run.json?.refused) ?? run.stderr ?? 'fadeno refused the spawn.' };
  if (run.failure != null || run.status !== 0 || run.json?.ok !== true) {
    return { error: run.failure != null ? describeFailure(run, 'fadeno dispatch-open --dry-run') : run.stderr || `exit ${run.status}` };
  }
  return { row: run.json };
}

// ---------------------------------------------------------------------------
// SubagentStart: open the dispatch for THIS agent, and hand it its contract.
// ---------------------------------------------------------------------------

if (eventName === 'SubagentStart') {
  const spawn = classifyAgentType(event.agent_type);
  // Not an archetype: somebody else's subagent, and none of Fadeno's business.
  // PreToolUse already refused the ones host mode does not allow.
  if (spawn.kind !== 'archetype') finish(null);
  const agentId = str(event.agent_id);
  if (agentId == null) finish(null);

  const args = ['dispatch-open', '--archetype', spawn.archetype, '--lane', 'host', '--json', '--harness', 'codex', '--agent-id', agentId];
  if (session != null) args.push('--session-id', session);

  // The label, if it can be known. Never the worktree, the branch or the id:
  // those are decided here, against this agent id, and cannot be mismatched.
  const pending = takePending(session, spawn.archetype);
  const label = pending != null && !pending.ambiguous ? pending.entry : null;
  if (label?.name != null) args.push('--name', label.name);
  const prompt = str(label?.prompt);
  if (prompt == null) {
    // Three different absences, and each says which one it is. Calling them
    // all "encrypted" would have been a sentence that is sometimes false, on
    // the row a person reads to find out what was asked.
    args.push(
      '--prompt-sealed',
      pending == null
        ? UNSEEN_REASON
        : pending.ambiguous
          ? `${pending.count} ${spawn.archetype} spawns were in flight at once and Fadeno could not tell which prompt was this one's`
          : SEALED_REASON,
    );
  }

  // The prompt rides on stdin when there is one — `dispatch-open` reads stdin
  // only when neither `--prompt-file` nor `--prompt-sealed` was given.
  const run = runFadeno(cli, args, { cwd, harness: 'codex', input: prompt ?? '' });
  if (run.failure != null || run.status !== 0 || run.json?.ok !== true || run.json.opened !== true) {
    // Nothing to refuse with — the agent is already running. Tell it what it
    // is missing, so it reports the gap instead of inventing a contract: an
    // agent that quietly proceeds as if it had one is how unrecorded work
    // starts. The stop hook still records what its tree holds.
    const why = run.failure != null ? describeFailure(run, 'fadeno dispatch-open') : run.stderr || `exit ${run.status}`;
    passWith(
      `Fadeno could not open a dispatch for this ${spawn.archetype} spawn: ${why}. ` +
        'You have NO dispatch contract: no worktree was cut for you and no ledger row exists. ' +
        'Do the task in the directory you were started in, commit nothing, change no branch, ' +
        'and say plainly at the top of your report that Fadeno failed to open this dispatch and quote this reason.',
    );
  }

  const opened = run.json;
  const where = opened.workspace?.branch != null
    ? `${opened.cwd} (branch ${opened.workspace.branch})`
    : `${opened.cwd} (the shared tree)`;
  passWith(
    `${opened.contract}\n\n` +
      `(Fadeno opened this as dispatch \`${opened.name}\` and cut ${where}. ` +
      'Your caller cannot see this text; report to it in your final message as the contract above requires.)',
  );
}

// ---------------------------------------------------------------------------
// PreToolUse: refuse what must not run, and let the rest through.
// ---------------------------------------------------------------------------

if (!isSpawnTool(event.tool_name)) finish(null);
const input = event.tool_input;
if (input == null || typeof input !== 'object' || Array.isArray(input)) finish(null);

const requested = str(input.agent_type);
const spawn = classifyAgentType(requested);
const explicitModel = str(input.model);
const parentModel = str(event.model);
const message = typeof input.message === 'string' ? input.message : '';

if (spawn.kind !== 'archetype') {
  deny(
    `fadeno: host mode is on for this session, and it refuses generic (non-archetype) subagents. This spawn asked for agent_type "${requested ?? '(unnamed)'}", ` +
      `which names no Fadeno archetype, so it would have run on ${explicitModel != null ? `the model it named (${explicitModel})` : parentModel != null ? `this session's model (${parentModel})` : "this session's model"} ` +
      'with no dial, no worktree, no contract and no ledger row. ' +
      `Spawn one of ${CANON_ARCHETYPES.map((a) => `\`fadeno-${a}\``).join(', ')} instead — those agents exist because \`fadeno setup\` wrote them, and ` +
      '`fadeno context` shows what each one is for and which model it is dialed to. ' +
      'If the archetype you want is not among them, run `fadeno dispatch --archetype <name> --name <name> --prompt-file <file>` yourself. ' +
      'To allow generic subagents again for the rest of this session, run `$fadeno-host off`.',
  );
}

const archetype = spawn.archetype;
const dialed = wouldOpen(archetype);
// The unclosed-dispatch limit refuses here, before the agent exists. Under the
// old handshake it refused at open time, which was also before; under this one
// the open happens at SubagentStart, and a limit checked only there would let
// the agent start and then leave it contractless. So the dry run carries it.
if (dialed.refused != null) deny(dialed.refused);
if (dialed.error != null) {
  deny(`fadeno: this ${archetype} spawn could not be routed — ${dialed.error}. Nothing was opened; fix the dial and spawn again.`);
}
const row = dialed.row;
const sealed = messageIsSealed(message);

if (!row.deliverable) {
  deny(
    `fadeno: the ${archetype} archetype resolves to ${row.model}, which this session can neither deliver in-session nor run as a process, so there is no lane for it here. ` +
      `Dial it onto a model with a command lane (\`fadeno dial ${archetype} <model>\`), or onto this session's own model (\`fadeno dial ${archetype} host\`), then spawn it again.`,
  );
}

// The command lane: the work is a process, not a subagent, so there is no
// spawn to wave through — only the command that does it instead.
if (row.lane === 'command') {
  if (sealed) {
    // The relay carries the task in a staged file, and Codex sealed the only
    // copy Fadeno could have staged. Asking the host to write it is the honest
    // move: it is the one party here that still has the text.
    deny(
      `fadeno: this ${archetype} spawn belongs on the command lane (${row.model}${row.effort ? `@${row.effort}` : ''} runs as a process, not as a subagent of this session), ` +
        'and Codex encrypted the message on this spawn, so Fadeno cannot stage the task for it. ' +
        `Write the task to a file and run it yourself:\n\n    fadeno dispatch --archetype ${archetype} --name <name> --prompt-file <file>\n\n` +
        'It prints the report on stdout. Close it afterwards with `fadeno dispatch-close <name> --merged|--kept|--discarded|--failed`.',
    );
  }
  const staged = runFadeno(cli, ['dispatch-open', '--archetype', archetype, '--lane', 'command', '--json', '--harness', 'codex'], {
    cwd,
    input: message,
    harness: 'codex',
  });
  if (staged.status === 3) deny(str(staged.json?.refused) ?? staged.stderr ?? 'fadeno refused the spawn.');
  if (staged.failure != null || staged.status !== 0 || staged.json?.ok !== true || staged.json.relay == null) {
    deny(`fadeno: could not stage the ${archetype} dispatch — ${staged.failure != null ? describeFailure(staged, 'fadeno dispatch-open') : staged.stderr || `exit ${staged.status}`}`);
  }
  const answer = staged.json;
  const label = answer.name ?? archetype;
  deny(
    `fadeno: this ${archetype} spawn goes through the command lane (${answer.model}${answer.effort ? `@${answer.effort}` : ''} on ${answer.harness ?? '?'}) — that model runs as a process, not as a subagent of this session. ` +
      `The task is staged; run this, with a 600-second shell timeout, and read what it prints:\n\n    ${answer.relay.command}\n\n` +
      `It records the dispatch as \`${label}\`. If that call is killed or times out, the dispatch is still running and its report is still coming: ` +
      `run \`fadeno dispatch-wait ${label}\` — it blocks until the dispatch stops and prints the report. It exits 2 with "still running" when it reaches its own bound first, which is not an error: run it again, as many times as it takes. ` +
      `When you have the report, read it and close the dispatch with \`fadeno dispatch-close ${label} --merged|--kept|--discarded|--failed\`. ` +
      `${answer.nag ?? ''}`,
  );
}

// The host lane. The one thing this hook cannot fix is the model: a Codex hook
// cannot rewrite a spawn, and the agent files Fadeno writes state no model on
// purpose so the dial rides the spawn rather than a file overriding it. So the
// spawn has to carry the dialed model itself, and a spawn that does not is
// refused with the exact call to make — the only correction still worth a
// round trip, because the alternative is silently paying for the wrong model.
const wantModel = row.model === 'host' ? null : row.modelId;
const wantEffort = row.effort;
const explicitEffort = str(input.reasoning_effort);
if (wantModel != null && explicitModel !== wantModel) {
  deny(
    `fadeno: \`${archetype}\` is dialed to ${row.model}${wantEffort ? `@${wantEffort}` : ''} (${wantModel}), and this spawn carries ` +
      `${explicitModel ?? "no model, so it would inherit this session's"}. The dial decides which model does this work, and a Codex hook can refuse a spawn but not rewrite one. ` +
      `Spawn it again with model="${wantModel}"${wantEffort ? ` and reasoning_effort="${wantEffort}"` : ''} and the same message; nothing has been opened, so nothing is left behind.`,
  );
}
if (wantEffort != null && explicitEffort !== wantEffort) {
  deny(
    `fadeno: \`${archetype}\` is dialed to ${row.model}@${wantEffort} and this spawn carries ${explicitEffort ? `reasoning_effort="${explicitEffort}"` : 'no reasoning_effort'}. ` +
      `Spawn it again with reasoning_effort="${wantEffort}" and the same message.`,
  );
}

// Everything the dial asked for is on this spawn. Stash what only this event
// can see, then let it through: `SubagentStart` opens the dispatch against the
// agent id and hands the agent its contract.
//
// The stash is the hook's own scratch under the plugin's data directory, not
// repository state: nothing here is a record, and a dispatch that never starts
// must not leave a row, a worktree or a staged file behind in the repo.
stashPending(session, archetype, {
  name: nameFrom(input.task_name, input.name, input.description),
  prompt: sealed || message.trim() === '' ? null : message,
});

passWith(
  `Fadeno is opening a \`${archetype}\` dispatch for this spawn on ${row.model}${wantEffort ? `@${wantEffort}` : ''}: it cuts the agent a worktree and hands it its contract as it starts. ` +
    (sealed
      ? 'Codex encrypted the message on this spawn, so the ledger records that rather than the task — everything else about the dispatch is measured as usual. '
      : '') +
    'You will be told its name and what its tree holds when it stops; close it then with `fadeno dispatch-close <name> --merged|--kept|--discarded|--failed`. ' +
    '`fadeno dispatches` lists it in the meantime.',
);

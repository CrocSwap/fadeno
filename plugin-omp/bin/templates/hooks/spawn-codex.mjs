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
// back. So the contract is delivered rather than composed. When Codex encrypts
// the message, the host first stages the plaintext and puts the returned
// task_name on the spawn; this hook consumes that one-use handoff before it
// passes the spawn. An archetype spawn with a readable message remains
// forward-compatible with older Codex versions.
//
// The division of labour is deliberate. PreToolUse knows the model and the
// message but not which subagent it becomes; SubagentStart knows the agent id
// but neither the model's origin nor the prompt. So everything CONSEQUENTIAL —
// opening the dispatch, cutting the worktree, writing the row — happens at
// SubagentStart, where `agent_id` makes the binding exact. PreToolUse reserves
// one repository-bound slot and SubagentStart claims it atomically before
// reading plaintext; a second same-session/same-archetype start is refused
// before its agent exists, and a recovery-state start gets a sealed fallback.
//
// Outside host mode Fadeno states no opinion and every spawn passes untouched.
//
// This hook writes no ledger rows; the CLI does.

import {
  CANON_ARCHETYPES,
  classifyAgentType,
  completePending,
  describeFailure,
  finish,
  hostModeEnabled,
  isSpawnTool,
  messageIsSealed,
  nameFrom,
  readEvent,
  refusal,
  resolveCli,
  releasePending,
  runFadeno,
  stashPending,
  stagedTaskParts,
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

function shellQuote(word) {
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const launcher = shellQuote(cli);

/** Refuse an encrypted spawn that did not carry a usable staged handoff. */
function sealedRetry(archetype, taskName, detail) {
  const shown = taskName == null ? '(missing)' : `"${taskName.slice(0, 120)}"`;
  return (
    `fadeno: Codex encrypted the ${archetype} spawn's message, and no valid staged plaintext was found for task_name ${shown} (${detail}). ` +
    `Stage the exact plaintext first with \`${launcher} prompt-stage --name <semantic-name> --prompt-file <file> --json\` (or pipe it to \`${launcher} prompt-stage --name <semantic-name> --json\`), ` +
    `then retry the same \`fadeno-${archetype}\` spawn with its returned \`task_name\` value exactly. ` +
    `Do not reuse an expired, consumed, malformed, or copied token. If native capacity is the reason to avoid another in-session start, run \`${launcher} dispatch --archetype ${archetype} --prompt-file <file>\` in a managed foreground shell and use \`${launcher} dispatch-wait <name>\` if that shell yields.`
  );
}

function concurrentRetry(archetype) {
  return (
    `fadeno: this ${archetype} spawn was refused before an agent started because another ${archetype} spawn from the same Codex session is still waiting for its SubagentStart handoff; Codex supplied no correlation id that could safely distinguish them. ` +
    `Wait for the first spawn to reach SubagentStart, then retry this identical spawn. For planned overflow or broad fan-out, save this exact task and run \`${launcher} dispatch --archetype ${archetype} --prompt-file <file>\` in a managed foreground shell instead; do not substitute a model, detach it with nohup, or invoke an executor argv directly.`
  );
}

function useResolvedLauncher(command) {
  return command.replace(/^fadeno(?=\s|$)/, launcher);
}

/**
 * What this spawn WOULD become: lane, model, effort, and whether it can be
 * delivered here — decided by the same call that will open it, one step short
 * of writing. Asking `fadeno dial` instead would have made this hook a second
 * reader of the lane rule and of the ledger reminder, and two readers of one
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

  // Re-resolve the repository through the CLI. The pending payload carries
  // this same canonical identity, so a session that visits two repositories
  // can never consume A's plaintext while opening B's dispatch.
  const route = wouldOpen(spawn.archetype);
  const repoKey = route.row?.repoKey ?? null;

  // The label, if it can be known. Never the worktree, the branch or the id:
  // those are decided here, against this agent id, and cannot be mismatched.
  const pending = repoKey == null ? { repositoryMismatch: true } : takePending(session, spawn.archetype, repoKey);
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
          : pending.reserved
            ? 'the PreToolUse handoff was still being finalized when SubagentStart arrived'
            : pending.repositoryMismatch
              ? 'the pending handoff belongs to a different repository or Fadeno could not resolve this repository'
              : pending.missing
                ? 'the pending handoff was claimed but its payload was missing or malformed'
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
const taskName = str(input.task_name);

if (spawn.kind !== 'archetype') {
  deny(
    `fadeno: host mode is on for this session, and it refuses generic (non-archetype) subagents. This spawn asked for agent_type "${requested ?? '(unnamed)'}", ` +
      `which names no Fadeno archetype, so it would have run on ${explicitModel != null ? `the model it named (${explicitModel})` : parentModel != null ? `this session's model (${parentModel})` : "this session's model"} ` +
      'with no dial, no worktree, no contract and no ledger row. ' +
      `Spawn one of ${CANON_ARCHETYPES.map((a) => `\`fadeno-${a}\``).join(', ')} instead — \`$fadeno-host\` reconciles those model-neutral agent names on first use, and ` +
      '`fadeno context` shows what each one is for and which model it is dialed to. ' +
      'If the archetype you want is not among them, run `fadeno dispatch --archetype <name> --name <name> --prompt-file <file>` yourself, in your own shell — that command IS the dispatch, so never make it the prompt of a spawn: the spawn would open one dispatch and the agent it starts would open a second. ' +
      'To allow generic subagents again for the rest of this session, run `$fadeno-host off`.',
  );
}

const archetype = spawn.archetype;
const dialed = wouldOpen(archetype);
// Unclosed dispatches are advisory and never refuse a spawn. The dry run still
// answers lane and deliverability before the agent exists.
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

/**
 * `task_name` is the readable half of Codex's sealed spawn. The CLI owns token
 * validation, repository binding, expiry, and the atomic claim/finalize/rollback
 * lifecycle; the hook only asks for the answer and applies it. A normal task
 * name may produce a failed claim attempt, but a readable message remains
 * valid for older Codex versions that have no staging handshake.
 */
function recoverStagedPrompt(transactional = false) {
  const parts = stagedTaskParts(taskName);
  if (parts == null) return { prompt: null, name: null, failure: null };
  const action = transactional ? 'claim' : 'consume';
  const consumed = runFadeno(cli, ['prompt-stage', `--${action}`, taskName, '--json'], { cwd, harness: 'codex' });
  if (consumed.failure == null && consumed.status === 0 && consumed.json?.ok === true && typeof consumed.json.prompt === 'string' && consumed.json.prompt.trim() !== '' && (!transactional || str(consumed.json.claim_id) != null)) {
    return {
      prompt: consumed.json.prompt,
      name: consumed.json.name ?? parts.name,
      claimId: transactional ? str(consumed.json.claim_id) : null,
      failure: null,
    };
  }
  return {
    prompt: null,
    name: null,
    claimId: null,
    failure: consumed.failure != null ? describeFailure(consumed, `fadeno prompt-stage --${action}`) : consumed.stderr || `exit ${consumed.status}`,
  };
}

function settleStagedPrompt(recovery, action) {
  if (recovery.claimId == null) return { ok: true, detail: null };
  const settled = runFadeno(cli, ['prompt-stage', `--${action}`, taskName, '--claim-id', recovery.claimId, '--json'], { cwd, harness: 'codex' });
  if (settled.failure == null && settled.status === 0 && settled.json?.ok === true) return { ok: true, detail: null };
  return {
    ok: false,
    detail: settled.failure != null ? describeFailure(settled, `fadeno prompt-stage --${action}`) : settled.stderr || `exit ${settled.status}`,
  };
}

function rollbackCommandRecovery(recovery, detail) {
  const rolledBack = settleStagedPrompt(recovery, 'rollback');
  return rolledBack.ok ? detail : `${detail}; staged-task rollback also failed (${rolledBack.detail})`;
}

// The command lane: the work is a process, not a subagent, so there is no
// spawn to wave through — only the command that does it instead.
if (row.lane === 'command') {
  // A staged plaintext is now available even when Codex hid the message. The
  // normal relay path remains the one writer for the scratch file and later
  // dispatch row; the hook only supplies the recovered bytes to its CLI call.
  // Keep the token claimed until relay staging succeeds. A failed relay must
  // leave the exact task usable by the identical retry, just like the host
  // lane's pending handoff does.
  const recovery = recoverStagedPrompt(true);
  if (sealed && recovery.prompt == null) deny(sealedRetry(archetype, taskName, recovery.failure ?? 'task_name was not supplied'));
  const relayPrompt = recovery.prompt ?? message;
  const relayName = nameFrom(input.name, input.description, recovery.name, stagedTaskParts(taskName)?.name);
  const relayArgs = ['dispatch-open', '--archetype', archetype, '--lane', 'command', '--json', '--harness', 'codex'];
  if (relayName != null) relayArgs.push('--name', relayName);
  const staged = runFadeno(cli, relayArgs, {
    cwd,
    input: relayPrompt,
    harness: 'codex',
  });
  if (staged.status === 3) {
    const refusalReason = str(staged.json?.refused) ?? staged.stderr ?? 'fadeno refused the spawn.';
    deny(recovery.claimId == null ? refusalReason : rollbackCommandRecovery(recovery, refusalReason));
  }
  if (staged.failure != null || staged.status !== 0 || staged.json?.ok !== true || staged.json.relay == null) {
    const detail = staged.failure != null ? describeFailure(staged, 'fadeno dispatch-open') : staged.stderr || `exit ${staged.status}`;
    const reason = recovery.claimId == null ? detail : rollbackCommandRecovery(recovery, detail);
    deny(`fadeno: could not stage the ${archetype} dispatch — ${reason}`);
  }
  if (recovery.claimId != null) {
    const finalized = settleStagedPrompt(recovery, 'finalize');
    if (!finalized.ok) {
      const detail = rollbackCommandRecovery(recovery, `Fadeno could not finalize the staged-task handoff (${finalized.detail})`);
      deny(`fadeno: could not stage the ${archetype} dispatch — ${detail}`);
    }
  }
  const answer = staged.json;
  const label = answer.name ?? archetype;
  const relayCommand = useResolvedLauncher(answer.relay.command);
  const waitCommand = `${launcher} dispatch-wait ${shellQuote(label)}`;
  const closeCommand = `${launcher} dispatch-close ${shellQuote(label)} --merged|--kept|--discarded|--failed|--reviewed`;
  deny(
    `fadeno: this ${archetype} spawn goes through the command lane (${answer.model}${answer.effort ? `@${answer.effort}` : ''} on ${answer.harness ?? '?'}) — that model runs as a process, not as a subagent of this session. ` +
      `The task is staged; run this in a managed foreground shell, with a 600-second shell timeout, and read what it prints:\n\n    ${relayCommand}\n\n` +
      `The command lane has no live inbox or mid-run messaging: do not send it a follow-up or try to steer it while it runs. Put all requirements in the staged prompt. ` +
      `It records the dispatch as \`${label}\`. If that call is killed or times out, the dispatch is still running and its report is still coming: ` +
      `run \`${waitCommand}\` — it blocks until the dispatch stops and prints the complete report, and reconstructs the stop record when the killed call was the thing that would have written it. It exits 2 with "still running" when it reaches its own bound first, which is not an error: run it again, as many times as it takes. A stopped dispatch can still exit non-zero while carrying stdout; preserve that report and its stderr cause, and say it failed. ` +
      `If a detail view shows only a bounded ledger preview, retrieve the complete retained report with \`${launcher} dispatches --output ${shellQuote(label)}\`. ` +
      `When you need a change after it stops, start a new dispatch with a new prompt; use \`--from <name|id>\` only for a retained isolated branch, never a shared-tree dispatch. ` +
      `When you have the report, read it and close the dispatch with \`${closeCommand}\`. ` +
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

if (typeof row.repoKey !== 'string') {
  deny(`fadeno: this ${archetype} spawn has no repository identity that can be carried safely to SubagentStart; retry it after Fadeno can resolve the repository, or use the direct command lane.`);
}

// Reserve before consuming a staged token. A second same-session/same-
// archetype PreToolUse therefore fails before its agent exists, and a failed
// recovery never burns a token belonging to a retry. The plugin scratch is
// only the mechanical event handoff; CLI/lib code still owns all dispatch and
// repository writes.
const stagedParts = stagedTaskParts(taskName);
const initialName = nameFrom(input.name, input.description, stagedParts?.name, input.task_name);
const reservation = stashPending(session, archetype, row.repoKey, {
  name: initialName,
  prompt: sealed ? null : (message.trim() === '' ? null : message),
});
if (reservation == null) deny(concurrentRetry(archetype));

const recovery = recoverStagedPrompt(true);
if (sealed && recovery.prompt == null) {
  releasePending(reservation, session, archetype);
  deny(sealedRetry(archetype, taskName, recovery.failure ?? 'task_name was not supplied'));
}
if (recovery.prompt != null) {
  const completed = completePending(reservation, session, archetype, {
    name: nameFrom(input.name, input.description, recovery.name, stagedParts?.name, input.task_name),
    prompt: recovery.prompt,
  });
  if (!completed) {
    releasePending(reservation, session, archetype);
    const rolledBack = settleStagedPrompt(recovery, 'rollback');
    const detail = rolledBack.ok ? 'Fadeno could not complete the process-safe handoff to SubagentStart' : `Fadeno could not complete the process-safe handoff to SubagentStart; staged-task rollback also failed (${rolledBack.detail})`;
    deny(sealedRetry(archetype, taskName, detail));
  }
  const finalized = settleStagedPrompt(recovery, 'finalize');
  if (!finalized.ok) {
    releasePending(reservation, session, archetype);
    const rolledBack = settleStagedPrompt(recovery, 'rollback');
    const detail = rolledBack.ok ? `Fadeno could not finalize the staged-task handoff (${finalized.detail})` : `Fadeno could not finalize the staged-task handoff (${finalized.detail}); staged-task rollback also failed (${rolledBack.detail})`;
    deny(sealedRetry(archetype, taskName, detail));
  }
}

passWith(
  `Fadeno is opening a \`${archetype}\` dispatch for this spawn on ${row.model}${wantEffort ? `@${wantEffort}` : ''}: it cuts the agent a worktree and hands it its contract as it starts. ` +
    (recovery.prompt != null
      ? 'Codex encrypted the message on this spawn; Fadeno recovered the original task from the one-use staged handoff. '
      : sealed
        ? 'Codex encrypted the message on this spawn, so the ledger records that rather than the task — everything else about the dispatch is measured as usual. '
      : '') +
    'You will be told its name and what its tree holds when it stops; close it then with `fadeno dispatch-close <name> --merged|--kept|--discarded|--failed|--reviewed`. ' +
    '`fadeno dispatches` lists it in the meantime.',
);

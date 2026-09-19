/**
 * The three contracts (spec §05) and the host vocabulary (spec §06), from one
 * source so the hook, the CLI, the host skill and a spawned director cannot
 * drift apart.
 *
 * Everything here is text an intelligence reads. Fadeno's job is to say it
 * once, deterministically, at the right moment: the worker's contract goes
 * into every dispatched prompt; the host vocabulary goes into a host session
 * at activation and into a spawned director's prompt; the nag goes to the
 * host at every spawn and the compact reminder goes to every host turn. None of it is stored in the ledger — injected text is
 * identical every time, so recording it would make the log describe Fadeno
 * instead of the work.
 */

import type { DispatchRecord } from './ledger.ts';
import { ageMinutes } from './ledger.ts';
import type { Preamble } from './preamble.ts';

/**
 * The canonical five, in the order a director should read them. The set is
 * open; these are only the descriptions a catalog entry inherits when it
 * declares none.
 */
export const BUILTIN_ARCHETYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  director:
    'Coordinates a whole task; decomposes it, spawns the other archetypes, integrates their work, and reports. Never does the work itself.',
  worker: 'Implements a described change in its own worktree, commits it on its branch, and reports what the tree holds.',
  reviewer:
    'Reviews a change, diff, or artifact for correctness, edge cases, safety, and tests; reports findings and changes nothing.',
  judge: 'Evaluates and scores candidate attempts or artifacts against stated criteria and picks a winner.',
  scout: 'Explores and reports; searches code and documents, gathers facts, produces a summary, and changes nothing.',
};

export function describeArchetype(name: string, declared: string | null | undefined): string {
  return declared?.trim() || BUILTIN_ARCHETYPE_DESCRIPTIONS[name] || 'No description declared; add one under `archetypes.' + name + '.description` in .fadeno/executors.yaml.';
}

// ---------------------------------------------------------------------------
// The worker's contract — injected into every dispatched prompt
// ---------------------------------------------------------------------------

export interface WorkerContractInput {
  id: string;
  name: string;
  archetype: string;
  /** Absolute repository root, so a shared-tree worker knows where it is. */
  repoRoot: string;
  worktree:
    | { kind: 'worktree'; absolute: string; branch: string; base: string; upstream: string }
    | { kind: 'shared'; reason: string | null };
  /** The host vocabulary, for an archetype that will itself spawn (a director). */
  vocabulary?: string | null;
  /** `.fadeno/preamble.md`: what this repository states for every dispatch. */
  preamble?: Preamble | null;
  /** Archetype names, for a delegate that decides to delegate further. */
  archetypes?: readonly string[];
}

/** Sentinel lines the reader and tests key on; keep them stable. */
export const CONTRACT_HEADER = '## Fadeno dispatch';
export const CONTRACT_FOOTER = '## End of Fadeno dispatch contract';

/**
 * What the worker is told (spec §05): its worktree and branch, that it owns
 * the work end to end, and what its final message must contain. Appended
 * after the caller's prompt, never before it — the task leads.
 */
export function workerContract(input: WorkerContractInput): string {
  const lines: string[] = [];
  const upstream = input.worktree.kind === 'worktree' ? `\`${input.worktree.upstream}\`` : 'its upstream branch';
  lines.push(`${CONTRACT_HEADER} ${input.id} (${input.name})`, '');
  lines.push(`You are the \`${input.archetype}\` for this dispatch. Fadeno recorded it; your caller will read your report and decide what to do with your work.`, '');
  if (input.worktree.kind === 'worktree') {
    const wt = input.worktree;
    lines.push('**Where to work.**');
    lines.push(`- Your assigned worktree is \`${wt.absolute}\`, on branch \`${wt.branch}\`, cut from \`${wt.upstream}\` at \`${wt.base.slice(0, 12)}\`. Put modifications and commits there; the repository at \`${input.repoRoot}\` is someone else's tree.`);
    lines.push('- Assigned-worktree containment applies to modifications and commits. A caller-authorized read-only inspection outside the assigned tree, including the main repository or another source tree, is allowed; do not write or commit outside the assigned tree.');
    lines.push('- The worktree checks out tracked content only. If a build environment (`node_modules`, `.venv`, `target`, `vendor`) is missing and a check you were asked to run cannot run, say so and report the work as unverified. Never substitute a weaker check and call it a pass.', '');
  } else {
    lines.push('**Where to work.**');
    lines.push(
      `- You are working in the shared tree at \`${input.repoRoot}\`${input.worktree.reason ? ` (no worktree was cut: ${input.worktree.reason})` : ''}. Other agents may have uncommitted work here.`,
    );
    lines.push('- Never run `git checkout`, `switch`, `restore`, `reset`, `stash` or `clean` in a shared tree: they throw away work that is not yours with no way back. If your own edit was wrong, edit the file to what it should be. If the tree is in a state you cannot work from, stop and report it.', '');
    lines.push('- Assigned-tree containment applies to modifications and commits. A caller-authorized read-only inspection outside the assigned tree is allowed; do not write or commit in another source tree.', '');
  }
  lines.push('**You own the assigned task and report end to end.**');
  lines.push(`- Let the caller's task and your assigned archetype decide whether this is implementation/integration work or report-only work. For implementation or integration, make the requested changes in the assigned tree, commit them with a message that says what and why, and, when you have an isolated branch, merge ${upstream} into your own tree before finalising and resolve conflicts there.`);
  lines.push('- For a report-only task (such as review, exploration, or judging), inspect what the caller authorized, change nothing, and do not fabricate a commit or merge. Report the findings and recommend `reviewed`.');
  lines.push('- A director coordinates delegated work: it does not implement a child\'s delegated feature itself, but it does integrate accepted child changes in its assigned tree when the task calls for integration, then reports that result. Custom archetypes follow their declared role and the caller\'s task.', '');
  lines.push(...preambleSection(input.preamble, input.repoRoot));
  // A worker handed "do BPW1 and BPA1" refused both because one of them was
  // impossible, and the dispatch produced nothing. Deciding how much of a task
  // is worth doing belongs to whoever wrote the brief; the worker's job is to
  // come back with the parts that were possible and a plain account of the rest.
  lines.push('**If part of it is impossible.**');
  lines.push('- Do every part that is not, and say in your report exactly which part you left out and why. A brief with one blocked clause is not a blocked brief.');
  lines.push('- If proceeding needs an assumption, state the assumption and proceed. Scaling the work down is your caller\'s decision, not yours to make silently.', '');
  lines.push('**Your final message.**');
  lines.push('- State what is in the tree: every file you changed, added or deleted, and anything untracked you left behind on purpose.');
  lines.push('- Say what you verified and how, and what you could not verify.');
  lines.push('- For implementation or integration work, recommend whether the result should be merged, kept, discarded, or failed, in one line, and why. For report-only work, recommend `reviewed` in one line. It is a recommendation: your caller reaches their own conclusion.');
  lines.push('- Do not ask questions you cannot get answered; make a reasonable call, state the assumption, and continue.', '');
  if (input.vocabulary != null && input.vocabulary.trim() !== '') {
    lines.push('**You may spawn.** Never close the dispatch you are currently running in: it must return its report, and your caller/host closes it. Only close dispatches you opened (for a director, these are child dispatches), after reading their reports, and report each by name. What follows is what a host session is told.', '');
    lines.push(input.vocabulary.trim(), '');
  } else {
    // Everything a delegate needs that only a director was being told.
    //
    // An opus reviewer decided mid-audit to fan out, named `Explore`, and was
    // refused twice inside a 28-minute review — its contract had never said
    // that a delegated spawn must name an archetype, or what the archetypes
    // are called. And a worker that hit friction reported it into the void
    // because nothing it had been given named `fadeno feedback`.
    const names = (input.archetypes ?? Object.keys(BUILTIN_ARCHETYPE_DESCRIPTIONS).sort()).map((n) => `\`${n}\``).join(', ');
    lines.push('**If you delegate.**');
    lines.push(`- Name a Fadeno archetype as the agent type — ${names}. A generic subagent is refused; the name is the whole interface, and Fadeno routes it. \`fadeno context\` prints the rest.`);
    lines.push('- Never close the dispatch you are currently running in. It must return its report; its caller/host closes it.');
    lines.push('- Only close dispatches you opened, after reading their reports (`fadeno dispatch-close <name> --merged|--kept|--discarded|--failed|--reviewed`), and report each by name.', '');
  }
  lines.push('**If Fadeno itself gets in your way.**');
  lines.push(`- A message that misled you, a refusal you could not act on, a step you had to guess at: \`fadeno feedback "<what happened>" --dispatch ${input.name}\`. It appends to \`.fadeno/feedback.md\` in the main checkout — not your worktree — with the harness and version attached, and that file is what whoever maintains Fadeno reads.`);
  lines.push('- Report it to your caller as well. The file is for the maintainer; your caller needs to know what it cost you.', '');
  lines.push(CONTRACT_FOOTER);
  return lines.join('\n');
}

/**
 * The repository's own conventions, carried into every dispatch so a brief
 * does not have to repeat them — and so forgetting one stops being possible.
 */
function preambleSection(preamble: Preamble | null | undefined, repoRoot: string): string[] {
  if (preamble == null || !preamble.exists || preamble.text == null) return [];
  const lines = ['**This repository.**', '', preamble.text, ''];
  if (preamble.truncated) {
    lines.push(
      `(Cut at ${preamble.text.length} of ${preamble.chars} characters. The rest is at \`${repoRoot}/${preamble.path}\`; read it if the part above leaves something open.)`,
      '',
    );
  }
  return lines;
}

/** Caller prompt plus contract, in the order the worker reads them. */
export function composeWorkerPrompt(callerPrompt: string, contract: string): string {
  const body = callerPrompt.replace(/\s+$/, '');
  return `${body}\n\n${contract}\n`;
}

// ---------------------------------------------------------------------------
// The host's vocabulary — injected at host activation and into a director
// ---------------------------------------------------------------------------

export interface ArchetypeLine {
  name: string;
  description: string;
  /** Resolved model, or `host`. */
  model: string;
  effort: string | null;
  source: string;
}

export interface HostVocabularyInput {
  archetypes: ArchetypeLine[];
  unclosed: DispatchRecord[];
  /** `.fadeno/preamble.md`, so the host knows what its dispatches already carry. */
  preamble?: Preamble | null;
  /**
   * The harness this text is being read inside. Spawning differs between them
   * in ways a host cannot guess: on Claude the wrapper rewrites the spawn, so
   * naming the archetype is enough; on Codex it can only refuse one, so the
   * spawn has to carry the dialed model itself.
   */
  host?: string | null;
  now?: Date;
}

/**
 * What the host is told (spec §05/§06): the archetype vocabulary, how spawning
 * works, what the worker was promised, what closing requires, and every
 * unclosed dispatch in the repository.
 *
 * It does NOT carry routing. This text is injected once, at activation, and
 * then outlives every dial change made after it — a Fable host in Basanos read
 * `scout → luna@xhigh` from a block written before the dials moved to gemini,
 * saw its spawns land on gemini, and reported a possible substitution. The
 * routing was correct and the snapshot was stale, which is the worst shape a
 * wrong answer can take: confident, specific, and a plausible symptom of a bug
 * elsewhere. Routing belongs to the moment of the spawn, where the hook
 * reports it, and to `fadeno dial`, which reads it fresh.
 */
export function hostVocabulary(input: HostVocabularyInput): string {
  const lines: string[] = [];
  lines.push('# Fadeno', '');
  lines.push('Fadeno routes delegated work to models by archetype, gives each dispatched agent its own worktree, and keeps a ledger of every dispatch. You decide what to delegate; Fadeno records it and reminds you to close it.', '');
  lines.push('## Archetypes', '');
  lines.push(
    'Name an archetype when you spawn a subagent and Fadeno applies the model and effort its dial binds to it. ' +
      'Routing is resolved at the spawn and reported by the hook that opens the dispatch; this block deliberately does not list it, ' +
      'because a dial changed after this text was written would make the list a confident wrong answer. ' +
      'Run `fadeno dial` for the current table, `fadeno dial <archetype> <model[@effort]>` to change it.',
    '',
  );
  for (const a of input.archetypes) {
    lines.push(`- **${a.name}** — ${a.description}`);
  }
  lines.push('');
  lines.push(
    'When discussing model performance or choosing a dial, consult `.fadeno/model-notes.md` in the main repository if present. ' +
      'It is an optional Markdown notebook of workload observations and user preferences, not routing configuration. ' +
      'You may record a useful observation; dispatch completion creates no update obligation. Distinguish observations from hypotheses, and revise notes as evidence changes.',
    '',
  );
  lines.push('## Spawning', '');
  if (input.host === 'codex') {
    // Codex cannot rewrite a spawn, only refuse one, so the model has to be on
    // the call. A host that learned this from a refusal paid a round trip for
    // it every time; a host told here pays none. The VALUES are deliberately
    // not written out — see the note above about stale routing — so this says
    // where to read them at the moment of the spawn.
    lines.push(
      '- Spawn through the subagent tool with `agent_type: "fadeno-<archetype>"` (`fadeno-worker`, `fadeno-reviewer`, …), and pass the dial\'s ' +
        'model and effort ON THE SPAWN, as `model` and `reasoning_effort`. Read them at the moment you spawn with `fadeno dial <archetype> --json`. ' +
        'A spawn carrying no model, or a different one, is REFUSED: a Codex hook can refuse a spawn but cannot rewrite one, so an unrouted subagent ' +
        "would silently run on this session's model.",
    );
    lines.push(
      '- Before every Codex archetype spawn, stage the exact task so Fadeno can record it even when Codex encrypts `message`: use the resolved launcher from the host skill and run `<cli> prompt-stage --name <semantic-name> --prompt-file <file> --json` (or pipe it to `<cli> prompt-stage --name <semantic-name> --json`). Put the returned `task_name` on the spawn exactly; it is a one-use, ten-minute handoff carrying a readable lowercase slug and opaque lowercase token. If the message is readable, staging is still the deterministic path, while an unstaged readable prompt remains supported for older Codex versions.',
      '- Codex native subagent threads have a runtime concurrency limit; command-lane processes do not consume native slots. Keep the host lane for interactive work and use the command lane for planned overflow or broad fan-out.',
      '- If a correctly routed Codex spawn fails before opening with `agent thread limit reached`, retry the identical archetype, model, effort, prompt, and worktree policy through a direct `fadeno dispatch` using the resolved launcher, carrying the same `--model <model>@<effort>` ref and the same shared/worktree options. Do not substitute a model. Run it through a managed foreground shell, never `nohup` or a manually invoked executor argv; if the shell yields while it continues, use `fadeno dispatch-wait <name>`. A native capacity refusal creates no dispatch, so when `--dispatch` cannot resolve the attempted name, record repository-level friction with `fadeno feedback "<what happened>"` without `--dispatch`.',
    );
    lines.push('- Nothing else has to be added to the spawn. Fadeno opens the dispatch and hands the agent its contract as it starts, so write the prompt as the task alone.');
  } else {
    lines.push('- Spawn through your harness\'s subagent tool with the archetype as the agent type (`fadeno:worker` on Claude Code). Where no Fadeno hook can observe a spawn, run `fadeno dispatch --archetype <name> --prompt-file <file>` instead; it does the same thing as a process.');
  }
  lines.push('- Write the prompt as the task itself, addressed to the agent that will do it. Fadeno appends the dispatch contract; do not describe Fadeno to the worker.');
  lines.push(
    input.preamble?.exists
      ? '- This repository states conventions for every dispatch in `.fadeno/preamble.md`, and Fadeno delivers them to every agent it dispatches. Do not repeat them in a brief; read the file if you need to know what your workers were already told, and add to it rather than to a prompt when something turns out to hold for all of them.'
      : '- Conventions that hold for EVERY dispatch here — the interpreter, the shared build directory, where receipts belong, what is forbidden — belong in `.fadeno/preamble.md`, which Fadeno appends to every dispatched prompt when it exists. Putting one there beats retyping it into each brief, and makes a brief that forgets it impossible.',
  );
  lines.push('- Every dispatch gets a worktree on a branch named `fadeno/<name>`, cut from HEAD unless the spawn names a Git ref/SHA or a retained dispatch with `--from`. A retained dispatch must still have a reachable isolated branch; a shared dispatch or missing branch cannot supply a baseline, so commit the desired state and pass that Git ref/SHA. `--shared` and `--from` are incompatible. If the work needs uncommitted changes, ask for the shared tree (`--shared`) without `--from`. Two agents must never share one tree.');
  // Escalation had one sentence of policy and no mechanics, and a host that
  // wanted to use it had to guess three things: where the model goes, what a
  // model is called, and what happens when the name is wrong. The mechanics
  // differ by lane, so both are written out.
  lines.push(
    '- **To escalate one task to a different model**, pass the model explicitly on the spawn — an override for that dispatch, not a change to the dial.',
    '  - Claude Code: the subagent tool\'s own `model` field, e.g. agent type `fadeno:scout` with `model: opus`.',
    '  - Command lane: `fadeno dispatch --archetype scout --model opus@xhigh --prompt-file <file>`.',
    '  - A model is `<name>[@effort]` using the names `fadeno models` lists. A name the registry does not hold is NOT refused: it is passed verbatim to the unregistered-model harness (the `*` row of `fadeno models` names it), so a typo runs somewhere you did not intend rather than failing loudly.',
    '  - The override changes the model and nothing else: the worktree is still cut, the contract is still appended, and the ledger records the model you named beside the archetype, so a reader can tell an escalated dispatch from a routed one.',
    '  - Escalate when a task has already failed on the dialed model, or when what it decides is worth more than the difference in spend. Otherwise name the archetype and let the dial answer.',
    '',
  );
  lines.push('## What the worker was promised', '');
  lines.push('It owns the change: it commits on its branch, merges from upstream before finishing, and its final message states what is in the tree and recommends merge or discard. That recommendation is a claim, not a finding: read the diff, run what you can, and reach your own conclusion.', '');
  lines.push('`fadeno dispatches <name>` prints the two apart: what Fadeno measured from git — commits the branch carries that HEAD does not, the diffstat, and any conflict markers it committed — and, below it, what the agent said. The measured half is safe to trust because no agent had a hand in it. A report claiming a test suite passed is worth exactly as much as the sentence; run it yourself, or send a reviewer.', '');
  lines.push('## Closing', '');
  lines.push('Never close the dispatch you are currently running in: it must return its report, and its caller/host closes it. Only close dispatches you opened — for a director, these are child dispatches — after reading their reports.', '');
  lines.push('After a Fadeno host agent returns a final response, inspect its dispatch. If it is still `open`, or if it is `awaiting close` with worktree inspection pending, save the already-received final response to a file and replay the idempotent stop with `fadeno dispatch-stop <name|id> --message-file <path>`; then inspect the report and close it normally. Stdin remains supported for a one-shot invocation, but a live two-process pipeline is not the default recovery path. The stop hook\'s durable receipt makes this replay safe even when its optional worktree inspection was interrupted.', '');
  lines.push('Every dispatch must be closed with exactly one decision: `fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed|--reviewed [--note <text>]`. Fadeno performs no merge; you do (`git merge fadeno/<name>`), or you delegate it. `--kept` means the branch stays for later; `--discarded`, `--failed`, and `--reviewed` leave the branch too, so nothing is lost by closing.', '');
  lines.push('`--merged` is checked. It is the only verb that asserts something about the repository rather than about your intent, so Fadeno refuses it while the branch still carries commits HEAD does not have, or while its worktree holds uncommitted tracked changes. If the work landed another way — a squash, a rebase, a reimplementation — close with `--force` and say how in `--note`.', '');
  lines.push('Fadeno reminds you of unclosed dispatches at every spawn and every host turn, but never refuses a spawn because work is unclosed. `fadeno dispatches` lists them, `fadeno dispatches --output <name>` shows a report, `fadeno worktrees` shows every worktree still holding unmerged work, `fadeno dispatch-wait <name>...` blocks until one of them stops (several names answer on the first, so a fan-out needs one call rather than a poll per dispatch), and `fadeno cancel <name>` stops a running command-lane dispatch.', '');
  lines.push('## When Fadeno fails', '');
  lines.push('A refused spawn, a dispatch that exits non-zero or returns nothing, or a resolver error is a user-facing event. Report it with the dispatch id and the error text, and do not substitute a generic subagent, another model, or your own hands for the delegated work without being told to.', '');
  // The channel from the agents USING Fadeno to the people changing it. It
  // existed as a convention in one repository's own docs, which is why a host
  // that hit five frictions in an afternoon reported them only in chat: the
  // text that tells it everything else about Fadeno never named the file.
  lines.push(
    'Friction with Fadeno itself — a message that misled you, a refusal you could not act on, a step that needed guessing — is worth recording even when you worked around it: `fadeno feedback "<what happened>"`, plus `--dispatch <name>` when it happened on one. ' +
      'It appends to `.fadeno/feedback.md` with the harness and version attached, and that file is what whoever maintains Fadeno reads. Report the friction to your user as well; the file is for the maintainer, not for them.',
    '',
  );
  lines.push(nagText(input.unclosed, input.now));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// The nag — every spawn
// ---------------------------------------------------------------------------

export function formatAge(minutes: number | null): string {
  if (minutes == null) return '?';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

export function describeUnclosed(record: DispatchRecord, now?: Date): string {
  const opened = record.opened;
  const state = record.state === 'stopped' ? 'stopped, awaiting your decision' : 'open';
  const where = opened?.workspace?.branch ? ` on \`${opened.workspace.branch}\`` : opened?.workspace ? ' in the shared tree' : '';
  const parent = opened?.parent ? ` (spawned by ${opened.parent.slice(0, 8)})` : '';
  return `- \`${opened?.name ?? record.id}\` ${record.id.slice(0, 8)} — ${opened?.archetype ?? '?'}${where}, ${state}, ${formatAge(ageMinutes(record, now))} old${parent}`;
}

/** Dispatches whose agent stopped and whose decision has not been made. */
export function awaitingDecision(unclosed: readonly DispatchRecord[]): DispatchRecord[] {
  return unclosed.filter((record) => record.stopped != null);
}

/** The reminder that keeps the ledger honest: nothing is forgotten silently. */
export function nagText(unclosed: readonly DispatchRecord[], now?: Date): string {
  if (unclosed.length === 0) return 'No unclosed dispatches in this repository.';
  const waiting = awaitingDecision(unclosed);
  const lines = [
    `## Unclosed dispatches (${unclosed.length}; ${waiting.length} stopped and waiting on you)`,
    '',
  ];
  lines.push('Review each and close it; a stopped dispatch is waiting for you to read its report and decide. A running one has no report to decide yet.');
  for (const record of unclosed) lines.push(describeUnclosed(record, now));
  return lines.join('\n');
}

/**
 * Compact, ledger-derived reminder for a host user turn. It deliberately
 * names only stopped dispatches that need a decision, while still saying when
 * work is running so a host does not mistake an empty reminder for an empty
 * ledger.
 */
export function hostTurnReminder(unclosed: readonly DispatchRecord[]): string {
  const waiting = awaitingDecision(unclosed);
  const running = unclosed.length - waiting.length;
  if (waiting.length === 0) {
    return running === 0
      ? 'Fadeno: no dispatches are waiting for your decision.'
      : `Fadeno: ${running} dispatch${running === 1 ? '' : 'es'} still running; none is waiting for a decision.`;
  }
  const names = waiting.map((record) => `\`${record.opened?.name ?? record.id.slice(0, 8)}\``).join(', ');
  return (
    `Fadeno: ${waiting.length} stopped dispatch${waiting.length === 1 ? '' : 'es'} waiting for your decision: ${names}. ` +
    'Read each report and close it with `fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed|--reviewed`.' +
    (running > 0 ? ` ${running} other dispatch${running === 1 ? ' is' : 'es are'} still running.` : '')
  );
}

/**
 * `fadeno dispatch` at the start of a line, and nothing before it but a
 * lead-in or an environment assignment. Anchored so that a brief which
 * MENTIONS the command in prose ("do not run fadeno dispatch yourself") is
 * ordinary text, and only a line that IS the command matches. `dispatch-wait`,
 * `dispatch-close` and `dispatches` are excluded: those an agent may well be
 * told to run.
 */
const DISPATCH_COMMAND_LINE =
  /^(?:(?:please\s+)?(?:run|execute)[^:\n]{0,40}:\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*\S*\bfadeno\b["']?\s+dispatch(?:-open)?(?![\w-])/i;

/**
 * The prompt is not a task: it is an instruction to run `fadeno dispatch`.
 * Returns the correction, or null for an ordinary brief.
 *
 * A host that writes the brief to a file and then spawns an archetype whose
 * PROMPT is "run fadeno dispatch --prompt-file <that file>" gets two
 * dispatches, not one: Fadeno opens the first for the spawn — its whole
 * recorded task being the command — and the agent it starts runs the command
 * and opens a second with the real brief. Basanos did it five times in two
 * minutes and got a dispatch nested under another (`fix-route-metadata-oom`
 * inside `fix-route-metadata-oom-2`), a host-lane dispatch wrapping a
 * command-lane one, two worktrees and two model runs per task, and a pair
 * whose names differed by a typo so neither could be closed by the name the
 * brief itself used.
 *
 * Fadeno cannot tell a good brief from a bad one. It can tell that this one is
 * addressed to Fadeno rather than to an agent, and one refused spawn costs a
 * round trip where the alternative costs a duplicate dispatch.
 */
export function spawnRefusedAsDispatchCommand(prompt: string): string | null {
  const lines = prompt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('```'));
  // "Run exactly:" on a line of its own is framing, not content.
  const body = lines.filter((line) => !/^(?:please\s+)?(?:run|execute)[^:\n]{0,40}:$/i.test(line));
  if (body.length !== 1 || !DISPATCH_COMMAND_LINE.test(body[0]!)) return null;
  return (
    'Fadeno refuses this spawn: its prompt is a `fadeno dispatch` command, not a task. ' +
    'Dispatching is what Fadeno does with this spawn — pass the BRIEF itself as the prompt and exactly one dispatch is opened for it, ' +
    'on whichever lane the archetype resolves to, with the worktree and the ledger row already handled. ' +
    'A prompt that tells an agent to dispatch opens two: this one, whose recorded task is the command, and the one the agent then runs. ' +
    'Give the dispatch its name through the spawn itself (the description on a Claude spawn, `--name` on the command line), not through a line inside the brief. ' +
    'Report this refusal to the user instead of routing around it.'
  );
}

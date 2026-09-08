/**
 * The three contracts (spec §05) and the host vocabulary (spec §06), from one
 * source so the hook, the CLI, the host skill and a spawned director cannot
 * drift apart.
 *
 * Everything here is text an intelligence reads. Fadeno's job is to say it
 * once, deterministically, at the right moment: the worker's contract goes
 * into every dispatched prompt; the host vocabulary goes into a host session
 * at activation and into a spawned director's prompt; the nag goes to the
 * host at every spawn. None of it is stored in the ledger — injected text is
 * identical every time, so recording it would make the log describe Fadeno
 * instead of the work.
 */

import type { DispatchRecord } from './ledger.ts';
import { ageMinutes } from './ledger.ts';
import type { Preamble } from './preamble.ts';

/** Refused at this many unclosed dispatches unless the catalog says otherwise. */
export const DEFAULT_UNCLOSED_LIMIT = 5;

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
  lines.push(`${CONTRACT_HEADER} ${input.id} (${input.name})`, '');
  lines.push(`You are the \`${input.archetype}\` for this dispatch. Fadeno recorded it; your caller will read your report and decide what to do with your work.`, '');
  if (input.worktree.kind === 'worktree') {
    const wt = input.worktree;
    lines.push('**Where to work.**');
    lines.push(`- Your worktree is \`${wt.absolute}\`, on branch \`${wt.branch}\`, cut from \`${wt.upstream}\` at \`${wt.base.slice(0, 12)}\`. Work there and nowhere else; the repository at \`${input.repoRoot}\` is someone else's tree.`);
    lines.push('- The worktree checks out tracked content only. If a build environment (`node_modules`, `.venv`, `target`, `vendor`) is missing and a check you were asked to run cannot run, say so and report the work as unverified. Never substitute a weaker check and call it a pass.', '');
    lines.push('**You own the work.**');
    lines.push('- Make the change and commit it on your branch, with a message that says what and why.');
    lines.push(`- Before you finish, merge \`${wt.upstream}\` into your branch and resolve any conflicts in your own worktree, the way a pull-request author would. Leave the tree clean: no conflict markers, nothing uncommitted you meant to keep.`, '');
  } else {
    lines.push('**Where to work.**');
    lines.push(
      `- You are working in the shared tree at \`${input.repoRoot}\`${input.worktree.reason ? ` (no worktree was cut: ${input.worktree.reason})` : ''}. Other agents may have uncommitted work here.`,
    );
    lines.push('- Never run `git checkout`, `switch`, `restore`, `reset`, `stash` or `clean` in a shared tree: they throw away work that is not yours with no way back. If your own edit was wrong, edit the file to what it should be. If the tree is in a state you cannot work from, stop and report it.', '');
    lines.push('**You own the work.**');
    lines.push('- Make the change and commit it, with a message that says what and why.', '');
  }
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
  lines.push('- Recommend whether your work should be merged or discarded, in one line, and why. It is a recommendation: your caller reaches their own conclusion.');
  lines.push('- Do not ask questions you cannot get answered; make a reasonable call, state the assumption, and continue.', '');
  if (input.vocabulary != null && input.vocabulary.trim() !== '') {
    lines.push('**You may spawn.** The dispatches you open are recorded under yours; close every one before you finish, and report each by name. What follows is what a host session is told.', '');
    lines.push(input.vocabulary.trim(), '');
  }
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
  unclosedLimit: number;
  /** `.fadeno/preamble.md`, so the host knows what its dispatches already carry. */
  preamble?: Preamble | null;
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
  lines.push('## Spawning', '');
  lines.push('- Spawn through your harness\'s subagent tool with the archetype as the agent type (`fadeno:worker` on Claude Code; `worker` on Codex). Where no Fadeno hook can observe a spawn, run `fadeno dispatch --archetype <name> --prompt-file <file>` instead; it does the same thing as a process.');
  lines.push('- Write the prompt as the task itself, addressed to the agent that will do it. Fadeno appends the dispatch contract; do not describe Fadeno to the worker.');
  lines.push(
    input.preamble?.exists
      ? '- This repository states conventions for every dispatch in `.fadeno/preamble.md`, and Fadeno appends them to every prompt you dispatch. Do not repeat them in a brief; read the file if you need to know what your workers were already told, and add to it rather than to a prompt when something turns out to hold for all of them.'
      : '- Conventions that hold for EVERY dispatch here — the interpreter, the shared build directory, where receipts belong, what is forbidden — belong in `.fadeno/preamble.md`, which Fadeno appends to every dispatched prompt when it exists. Putting one there beats retyping it into each brief, and makes a brief that forgets it impossible.',
  );
  lines.push('- Every dispatch gets a worktree cut from HEAD on a branch named `fadeno/<name>`. If the work needs uncommitted changes, commit them first, or ask for the shared tree by saying so in the spawn (`--shared` on the command lane). Two agents must never share one tree.');
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
  lines.push('Every dispatch must be closed with exactly one decision: `fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed [--note <text>]`. Fadeno performs no merge; you do (`git merge fadeno/<name>`), or you delegate it. `--kept` means the branch stays for later; `--discarded` and `--failed` leave the branch too, so nothing is lost by closing.', '');
  lines.push('`--merged` is checked. It is the only verb that asserts something about the repository rather than about your intent, so Fadeno refuses it while the branch still carries commits HEAD does not have, or while its worktree holds uncommitted tracked changes. If the work landed another way — a squash, a rebase, a reimplementation — close with `--force` and say how in `--note`.', '');
  lines.push(`Fadeno reminds you of unclosed dispatches at every spawn and refuses a new one at ${input.unclosedLimit} unclosed. \`fadeno dispatches\` lists them, \`fadeno dispatches --output <name>\` shows a report, \`fadeno worktrees\` shows every worktree still holding unmerged work, \`fadeno dispatch-wait <name>...\` blocks until one of them stops (several names answer on the first, so a fan-out needs one call rather than a poll per dispatch), and \`fadeno cancel <name>\` stops a running command-lane dispatch.`, '');
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
  lines.push(nagText(input.unclosed, input.unclosedLimit, input.now));
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

/**
 * What the limit counts: dispatches whose agent has STOPPED and whose
 * decision has not been made.
 *
 * Not everything unclosed. A running dispatch has no report to read and
 * nothing to decide, so counting it produced a refusal whose only instruction
 * — close some — the recipient could not carry out. In Basanos a reviewer was
 * refused because the host's five dispatches were all still executing, and it
 * narrowed its own audit instead. A refusal must name an action its recipient
 * can take; this one named waiting.
 *
 * The hygiene the limit exists for is unaffected: unread reports still pile up
 * and still refuse the next spawn. Fan-out is a judgement, and Fadeno does not
 * cap judgement.
 */
export function awaitingDecision(unclosed: readonly DispatchRecord[]): DispatchRecord[] {
  return unclosed.filter((record) => record.stopped != null);
}

/** The reminder that keeps the ledger honest: nothing is forgotten silently. */
export function nagText(unclosed: readonly DispatchRecord[], limit: number, now?: Date): string {
  if (unclosed.length === 0) return 'No unclosed dispatches in this repository.';
  const waiting = awaitingDecision(unclosed);
  const lines = [
    `## Unclosed dispatches (${unclosed.length}; ${waiting.length} of ${limit} allowed are waiting on you)`,
    '',
  ];
  lines.push('Review each and close it; a stopped dispatch is waiting for you to read its report and decide. A running one is not counted against the limit — there is nothing yet to decide.');
  for (const record of unclosed) lines.push(describeUnclosed(record, now));
  if (waiting.length >= limit) {
    lines.push('', `**At the limit.** The next spawn is refused until some of the STOPPED ones are closed (\`fadeno dispatch-close <name> --merged|--kept|--discarded|--failed\`).`);
  }
  return lines.join('\n');
}

export function spawnRefusedByLimit(unclosed: readonly DispatchRecord[], limit: number): string | null {
  const waiting = awaitingDecision(unclosed);
  if (waiting.length < limit) return null;
  return (
    `Fadeno refuses this spawn: ${waiting.length} dispatches have stopped and are waiting for your decision, and the limit is ${limit}. ` +
    `Read their reports and close them — ${waiting.slice(0, 5).map((r) => `\`${r.opened?.name ?? r.id.slice(0, 8)}\``).join(', ')}${waiting.length > 5 ? ', …' : ''} — ` +
    'with `fadeno dispatch-close <name> --merged|--kept|--discarded|--failed`. Report this refusal to the user instead of routing around it.'
  );
}

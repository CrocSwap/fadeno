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
  /** Resolved model, or `current-host`. */
  model: string;
  effort: string | null;
  source: string;
}

export interface HostVocabularyInput {
  archetypes: ArchetypeLine[];
  unclosed: DispatchRecord[];
  unclosedLimit: number;
  now?: Date;
}

/**
 * What the host is told (spec §05/§06): the archetype vocabulary with its
 * current routing, how spawning works, what the worker was promised, what
 * closing requires, and every unclosed dispatch in the repository.
 */
export function hostVocabulary(input: HostVocabularyInput): string {
  const lines: string[] = [];
  lines.push('# Fadeno', '');
  lines.push('Fadeno routes delegated work to models by archetype, gives each dispatched agent its own worktree, and keeps a ledger of every dispatch. You decide what to delegate; Fadeno records it and reminds you to close it.', '');
  lines.push('## Archetypes', '');
  lines.push('Name an archetype when you spawn a subagent and Fadeno applies the model and effort the dials bind to it. The routing below is live; change it with `fadeno dial <archetype> <model[@effort]>`.', '');
  for (const a of input.archetypes) {
    const route = a.model === 'current-host' ? 'this session\'s own model' : `${a.model}${a.effort ? `@${a.effort}` : ''}`;
    lines.push(`- **${a.name}** — ${a.description} _(routes to ${route}; ${a.source})_`);
  }
  lines.push('');
  lines.push('## Spawning', '');
  lines.push('- Spawn through your harness\'s subagent tool with the archetype as the agent type (`fadeno:worker` on Claude Code; `worker` on Codex). Where no Fadeno hook can observe a spawn, run `fadeno dispatch --archetype <name> --prompt-file <file>` instead; it does the same thing as a process.');
  lines.push('- Write the prompt as the task itself, addressed to the agent that will do it. Fadeno appends the dispatch contract; do not describe Fadeno to the worker.');
  lines.push('- Every dispatch gets a worktree cut from HEAD on a branch named `fadeno/<name>`. If the work needs uncommitted changes, commit them first, or ask for the shared tree by saying so in the spawn (`--shared` on the command lane). Two agents must never share one tree.');
  lines.push('- To escalate one task to a different model, pass the model explicitly on the spawn. That is an override for one dispatch, not a change to the dial.', '');
  lines.push('## What the worker was promised', '');
  lines.push('It owns the change: it commits on its branch, merges from upstream before finishing, and its final message states what is in the tree and recommends merge or discard. That recommendation is a claim, not a finding: read the diff, run what you can, and reach your own conclusion.', '');
  lines.push('## Closing', '');
  lines.push('Every dispatch must be closed with exactly one decision: `fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed [--note <text>]`. Fadeno performs no merge; you do (`git merge fadeno/<name>`), or you delegate it. `--kept` means the branch stays for later; `--discarded` and `--failed` leave the branch too, so nothing is lost by closing.', '');
  lines.push(`Fadeno reminds you of unclosed dispatches at every spawn and refuses a new one at ${input.unclosedLimit} unclosed. \`fadeno dispatches\` lists them, \`fadeno dispatches --output <name>\` shows a report, \`fadeno worktrees\` shows every worktree still holding unmerged work, and \`fadeno cancel <name>\` stops a running command-lane dispatch.`, '');
  lines.push('## When Fadeno fails', '');
  lines.push('A refused spawn, a dispatch that exits non-zero or returns nothing, or a resolver error is a user-facing event. Report it with the dispatch id and the error text, and do not substitute a generic subagent, another model, or your own hands for the delegated work without being told to.', '');
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

/** The reminder that keeps the ledger honest: nothing is forgotten silently. */
export function nagText(unclosed: readonly DispatchRecord[], limit: number, now?: Date): string {
  if (unclosed.length === 0) return 'No unclosed dispatches in this repository.';
  const lines = [`## Unclosed dispatches (${unclosed.length} of ${limit} allowed)`, ''];
  lines.push('Review each and close it; a stopped dispatch is waiting for you to read its report and decide.');
  for (const record of unclosed) lines.push(describeUnclosed(record, now));
  if (unclosed.length >= limit) {
    lines.push('', `**At the limit.** The next spawn is refused until some of these are closed (\`fadeno dispatch-close <name> --merged|--kept|--discarded|--failed\`).`);
  }
  return lines.join('\n');
}

export function spawnRefusedByLimit(unclosed: readonly DispatchRecord[], limit: number): string | null {
  if (unclosed.length < limit) return null;
  return (
    `Fadeno refuses this spawn: ${unclosed.length} dispatches are unclosed and the limit is ${limit}. ` +
    `Close some first — ${unclosed.slice(0, 5).map((r) => `\`${r.opened?.name ?? r.id.slice(0, 8)}\``).join(', ')}${unclosed.length > 5 ? ', …' : ''} — ` +
    'with `fadeno dispatch-close <name> --merged|--kept|--discarded|--failed`. Report this refusal to the user instead of routing around it.'
  );
}

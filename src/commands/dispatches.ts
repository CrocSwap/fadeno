/**
 * The dispatch family of commands (spec §08): `dispatch` (the command-lane
 * launch and unified read namespace), `dispatch-open` and `dispatch-stop` (the
 * host lane's halves, driven by the hooks), `dispatch-close`, `cancel`, `dispatches`,
 * `worktrees`, `context` and `clean`. Each returns data; `cli.ts` prints.
 *
 * Everything here reads the ledger through `lib/ledger.ts` and writes it
 * through `lib/spawn.ts`, so there is one writer per row kind and one
 * reader for every surface.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatAge, hostVocabulary, hostTurnReminder, nagText, spawnRefusedAsDispatchCommand, type ArchetypeLine } from '../lib/contracts.ts';
import {
  ageMinutes,
  closeDispatch,
  findDispatch,
  findDispatchByAgentId,
  isCloseVerb,
  modelAgrees,
  readDispatches,
  readPrompt,
  unclosedDispatches,
  type CloseVerb,
  type DispatchRecord,
  type DispatchState,
  type Lane,
  type StoppedRow,
} from '../lib/ledger.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { readPreamble, type Preamble } from '../lib/preamble.ts';
import {
  formatDialRef,
  parseDialRef,
  registeredModelRefSpellings,
  resolveRegisteredModelRef,
} from '../lib/executors.ts';
import {
  OUTPUTS_DIR,
  CANCEL_REQUESTS_DIR,
  RELAY_DIR,
  DISPATCH_ID_ENV,
  SpawnError,
  cancelDispatch,
  describeArchetypes,
  groupAlive,
  outputPaths,
  prepareDispatch,
  recordOpened,
  recordStopped,
  enrichStopped,
  commandLaneAvailable,
  requireCommand,
  resolveArchetype,
  resolveFromBaseline,
  runCommandDispatch,
  sharedFromRefusal,
  stageRelay,
  workspaceDir,
  type CancelOutcome,
  type Relay,
  type RunResult,
} from '../lib/spawn.ts';
import { repositoryKey, STAGED_PROMPT_TTL_MS, STAGED_PROMPTS_DIR } from '../lib/staged-prompts.ts';
import { readTranscriptFacts } from '../lib/transcript.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';
import {
  WORKTREES_DIR,
  canonical,
  removeWorktree,
  reportWorktrees,
  verifyMerged,
  type MergeCheck,
  type WorkMeasured,
  type WorktreeReport,
} from '../lib/worktree.ts';

export class DispatchesError extends Error {}

export interface CommonOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  env?: NodeJS.ProcessEnv;
}

function rootOf(opts: CommonOptions): string {
  return resolve(opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd()));
}

function readPromptInput(opts: { prompt?: string | null; promptFile?: string | null }, cwd: string): string {
  if (opts.promptFile != null && opts.promptFile.trim() !== '') {
    const path = resolve(cwd, opts.promptFile);
    if (!existsSync(path)) throw new DispatchesError(`--prompt-file ${opts.promptFile}: no such file.`);
    return readFileSync(path, 'utf8');
  }
  if (typeof opts.prompt === 'string') return opts.prompt;
  throw new DispatchesError('no prompt: pass --prompt-file <path> or pipe the prompt on stdin.');
}

/**
 * What stands in the prompt file when the harness sealed the ask. It reads as
 * what it is — an absence with a reason and a place to look — so that a person
 * scrolling `fadeno dispatches` is never shown a sentence Fadeno made up and
 * told it was the task.
 */
export function sealedPromptText(reason: string): string {
  return (
    `(Fadeno did not see this dispatch's prompt: ${reason})\n\n` +
    'The task went straight from the host to the agent. What the agent was asked is in the ' +
    "host's own transcript and in the agent's; it was never Fadeno's to record. Everything else " +
    'about this dispatch — its archetype, model, worktree, branch, and what the branch ended up ' +
    'holding — was measured as usual.\n'
  );
}

function lookup(repoRoot: string, ref: string): DispatchRecord {
  const found = findDispatch(readDispatches(repoRoot).records, ref);
  if (!found.ok) throw new DispatchesError(found.message);
  return found.record;
}

// ---------------------------------------------------------------------------
// dispatch — the command lane, end to end
// ---------------------------------------------------------------------------

export interface DispatchOptions extends CommonOptions {
  archetype?: string | null;
  model?: string | null;
  name?: string | null;
  shared?: boolean;
  from?: string | null;
  prompt?: string | null;
  promptFile?: string | null;
  session?: string | null;
  parent?: string | null;
  onEcho?: (line: string) => void;
  heartbeatMs?: number;
}

export type DispatchOutcome = { ok: true; result: RunResult } | { ok: false; refused: string };

export type DispatchSelectorResolution =
  | { kind: 'archetype'; archetype: string; model: null }
  | { kind: 'model'; archetype: null; model: string };

/**
 * Resolve the positional selector accepted by `dispatch run`.
 *
 * Archetype names come from the same effective list shown to directors. Model
 * selectors go through the model-management resolver, then are rendered back
 * to the canonical alias spelling because `resolveDelivery` deliberately
 * accepts a DialRef whose model member is a registry alias. This keeps the
 * positional form from growing a second model registry or a second compiler.
 */
export function resolveDispatchSelector(opts: CommonOptions & { selector: string }): DispatchSelectorResolution {
  const selector = opts.selector.trim();
  if (selector.length === 0) throw new DispatchesError('dispatch selector is empty — pass an archetype name or registered model reference.');

  const repoRoot = rootOf(opts);
  const described = describeArchetypes({ repoRoot, userPathOptions: opts.userPathOptions });
  const isArchetype = described.archetypes.some((archetype) => archetype.name === selector);

  let model: string | null = null;
  let modelError: Error | null = null;
  try {
    const parsed = parseDialRef(selector, 'dispatch model selector');
    const resolved = resolveRegisteredModelRef(parsed, described.profile);
    model = formatDialRef(resolved.ref);
  } catch (err) {
    modelError = err instanceof Error ? err : new Error(String(err));
  }

  if (isArchetype && model != null) {
    throw new DispatchesError(
      `dispatch selector "${selector}" is ambiguous: it matches both the effective archetype "${selector}" and a registered model reference. ` +
        `Use --archetype ${selector} or --model ${selector}.`,
    );
  }
  if (isArchetype) return { kind: 'archetype', archetype: selector, model: null };
  if (model != null) return { kind: 'model', archetype: null, model };

  // A model resolver ambiguity is more actionable than the generic neither
  // message: it already names the aliases or harnesses the caller can choose.
  if (modelError != null && /ambiguous/i.test(modelError.message)) {
    throw new DispatchesError(modelError.message);
  }
  const archetypes = described.archetypes.map((archetype) => archetype.name);
  const models = registeredModelRefSpellings(described.profile);
  throw new DispatchesError(
    `dispatch selector "${selector}" matches neither an effective archetype nor a registered model reference. ` +
      `Archetypes: ${archetypes.join(', ') || '(none)'}. ` +
      `Models: ${models.join(', ') || '(none)'}.`,
  );
}

export async function runDispatch(opts: DispatchOptions): Promise<DispatchOutcome> {
  const policy = sharedFromRefusal(opts.shared, opts.from);
  if (policy != null) return { ok: false, refused: policy };
  const repoRoot = rootOf(opts);
  const archetype = opts.archetype?.trim();
  if (!archetype && !opts.model) throw new DispatchesError('pass --archetype <name> (or --model <ref> to bypass the dials).');
  const prompt = readPromptInput(opts, opts.cwd ?? process.cwd());
  const prepared = prepareDispatch({
    repoRoot,
    archetype: archetype || 'worker',
    explicitModel: opts.model ?? null,
    prompt,
    name: opts.name,
    shared: opts.shared,
    from: opts.from,
    session: opts.session ?? null,
    parent: opts.parent,
    lane: 'command',
    userPathOptions: opts.userPathOptions,
    env: opts.env,
  });
  if (!prepared.ok) return { ok: false, refused: prepared.refused };
  const result = await runCommandDispatch({
    repoRoot,
    prepared: prepared.prepared,
    env: opts.env,
    onEcho: opts.onEcho,
    heartbeatMs: opts.heartbeatMs,
  });
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// dispatch-open / dispatch-stop — the host lane, driven by hooks
// ---------------------------------------------------------------------------

export interface DispatchOpenOptions extends CommonOptions {
  archetype: string;
  model?: string | null;
  name?: string | null;
  shared?: boolean;
  from?: string | null;
  prompt?: string | null;
  promptFile?: string | null;
  session?: string | null;
  parent?: string | null;
  /** Which harness is delivering; recorded on the row. */
  harness?: string | null;
  /**
   * The transcript of the agent making this spawn, when the spawn comes from
   * inside a subagent: its contract header names the parent dispatch. Used
   * only when `parent` is not given.
   */
  parentTranscript?: string | null;
  /**
   * `auto` (the default) lets the resolution choose: a host candidate opens on
   * the host lane, anything else is handed to the command lane as a relay.
   * `host` opens on the host lane regardless — the caller is about to run the
   * agent in-session itself. `command` stages the relay regardless.
   */
  lane?: OpenLane;
  /**
   * The harness's own id for the subagent being opened for. Recorded, and the
   * exact handle a stop hook resolves by.
   */
  agentId?: string | null;
  /**
   * The harness sealed the caller's prompt, and this is why. Codex's newer
   * spawn tool encrypts the message it carries, so a hook watching the spawn
   * sees a ciphertext where the ask should be. Rather than record a blob or
   * invent an ask, the row records this sentence and is stamped `prompt_sealed`
   * so no reader can mistake it for what the host wrote.
   */
  promptSealed?: string | null;
  /**
   * Resolve and run every refusal check, then answer what WOULD happen and
   * open nothing — no worktree, no row, no staged prompt.
   *
   * For a hook that must decide before it has anything to open with. Codex's
   * spawn hook opens at `SubagentStart`, where the agent id makes the binding
   * exact, but the call it has to refuse arrives one event earlier — and a
   * refusal that reasoned from its own copy of the rules would be a second
   * source of truth for the lane and the ledger-derived reminder. This is the same code
   * path, stopped one step short of writing.
   */
  dryRun?: boolean;
}

export type OpenLane = 'auto' | 'host' | 'command';
export const OPEN_LANES: readonly OpenLane[] = ['auto', 'host', 'command'];

export interface DispatchOpened {
  ok: true;
  opened: true;
  id: string;
  name: string;
  archetype: string;
  model: string;
  modelId: string;
  effort: string | null;
  harness: string | null;
  lane: 'host';
  cwd: string;
  workspace: { path: string; branch: string | null; base: string };
  shared: boolean;
  sharedReason: string | null;
  /** The contract-bearing prompt the agent should receive, as one document. */
  prompt: string;
  /**
   * The contract alone. What a caller that cannot touch the prompt delivers
   * separately — Codex's `SubagentStart` hands this to the subagent as
   * developer context, since a Codex hook can add to a spawn but never rewrite
   * one.
   */
  contract: string;
  nag: string;
}

/**
 * The spawn belongs on the command lane: nothing was opened, the prompt is
 * staged, and `relay.command` is what the dispatch proxy runs. `fadeno
 * dispatch` writes the rows when it does.
 */
export interface DispatchRelayed {
  ok: true;
  opened: false;
  lane: 'command';
  archetype: string;
  name: string | null;
  model: string;
  modelId: string;
  effort: string | null;
  harness: string | null;
  relay: { prompt_file: string; args: string[]; command: string };
  nag: string;
}

/** What a `--dry-run` open answers: the routing, and that nothing was written. */
export interface DispatchWouldOpen {
  ok: true;
  opened: false;
  dryRun: true;
  lane: Lane;
  archetype: string;
  model: string;
  modelId: string;
  effort: string | null;
  harness: string | null;
  /** Canonical repository identity used by the Codex pre-start handoff. */
  repoKey: string;
  /** Whether this archetype can be delivered at all from here. */
  deliverable: boolean;
  nag: string;
}

export type DispatchOpenOutcome = DispatchOpened | DispatchRelayed | DispatchWouldOpen | { ok: false; refused: string };

export function runDispatchOpen(opts: DispatchOpenOptions): DispatchOpenOutcome {
  const policy = sharedFromRefusal(opts.shared, opts.from);
  if (policy != null) return { ok: false, refused: policy };
  const repoRoot = rootOf(opts);
  const sealed = opts.promptSealed?.trim() || null;
  const dryRun = opts.dryRun === true;
  const prompt = dryRun ? '' : sealed != null ? sealedPromptText(sealed) : readPromptInput(opts, opts.cwd ?? process.cwd());
  if (!dryRun && prompt.trim().length === 0) throw new SpawnError('empty prompt: nothing to dispatch.');
  // Before the lane is even chosen, so both answer the same way at the same
  // moment. `prepareDispatch` checks this too and catches the command lane's
  // own `fadeno dispatch` call; here it is caught at the SPAWN, where the
  // correction reaches the host that wrote the prompt rather than the proxy
  // relaying a non-zero exit back to it.
  const misaddressed = spawnRefusedAsDispatchCommand(prompt);
  if (misaddressed != null) return { ok: false, refused: misaddressed };
  const resolution = resolveArchetype({ repoRoot, archetype: opts.archetype, explicitModel: opts.model ?? null, userPathOptions: opts.userPathOptions });
  const wanted = opts.lane ?? 'auto';
  if (!OPEN_LANES.includes(wanted)) throw new DispatchesError(`--lane ${String(wanted)}: expected one of ${OPEN_LANES.join(', ')}.`);
  const lane = wanted === 'auto' ? resolution.lane : wanted;
  // Validate an explicit baseline before a command-lane relay is staged. The
  // eventual `dispatch` call repeats this through prepareDispatch, but the
  // hook surface must not turn a bad --from into a seemingly healthy relay.
  const baseline = resolveFromBaseline(repoRoot, opts.from);
  if (!baseline.ok) return { ok: false, refused: baseline.refused };
  if (dryRun) {
    const unclosed = unclosedDispatches(repoRoot);
    return {
      ok: true,
      opened: false,
      dryRun: true,
      lane,
      archetype: resolution.archetype,
      model: resolution.model,
      modelId: resolution.modelId,
      effort: resolution.effort,
      harness: opts.harness ?? resolution.harness,
      repoKey: repositoryKey(repoRoot),
      deliverable: lane === 'host' || commandLaneAvailable(resolution),
      nag: nagText(unclosed),
    };
  }
  const parentTranscript = opts.parentTranscript?.trim() ? resolve(opts.cwd ?? process.cwd(), opts.parentTranscript.trim()) : null;
  const parent = opts.parent !== undefined && opts.parent !== null
    ? opts.parent
    : parentTranscript != null && existsSync(parentTranscript)
      ? readTranscriptFacts(parentTranscript).dispatchId ?? undefined
      : opts.parent;
  if (lane === 'command') {
    requireCommand(resolution);
    const unclosed = unclosedDispatches(repoRoot);
    const relay: Relay = stageRelay(repoRoot, {
      prompt,
      archetype: resolution.archetype,
      name: opts.name,
      explicitModel: opts.model ?? null,
      shared: opts.shared,
      from: opts.from,
      parent: parent ?? null,
    });
    return {
      ok: true,
      opened: false,
      lane: 'command',
      archetype: resolution.archetype,
      name: opts.name?.trim() || null,
      model: resolution.model,
      modelId: resolution.modelId,
      effort: resolution.effort,
      harness: resolution.harness,
      relay: { prompt_file: relay.promptFile, args: relay.args, command: relay.command },
      nag: nagText(unclosed),
    };
  }
  const outcome = prepareDispatch({
    repoRoot,
    archetype: opts.archetype,
    explicitModel: opts.model ?? null,
    prompt,
    name: opts.name,
    shared: opts.shared,
    from: opts.from,
    session: opts.session ?? null,
    parent,
    lane: 'host',
    agentId: opts.agentId ?? null,
    promptSealed: sealed != null,
    userPathOptions: opts.userPathOptions,
    env: opts.env,
    resolution,
  });
  if (!outcome.ok) return { ok: false, refused: outcome.refused };
  const p = outcome.prepared;
  recordOpened(repoRoot, p, { lane: 'host', harness: opts.harness ?? p.resolution.harness });
  return {
    ok: true,
    opened: true,
    id: p.id,
    name: p.name,
    archetype: p.archetype,
    model: p.resolution.model,
    modelId: p.resolution.modelId,
    effort: p.resolution.effort,
    harness: opts.harness ?? p.resolution.harness,
    lane: 'host',
    cwd: p.cwd,
    workspace: p.workspace,
    shared: p.shared,
    sharedReason: p.sharedReason,
    prompt: p.composedPrompt,
    contract: p.contract,
    nag: p.nag,
  };
}

export interface DispatchStopOptions extends CommonOptions {
  /** Name or id; optional when `transcript` names the dispatch itself. */
  ref?: string | null;
  message?: string | null;
  messageFile?: string | null;
  /** Where the agent was actually working, when the harness says. */
  agentCwd?: string | null;
  /**
   * The agent's transcript, as the stop hook receives it. Read for the
   * dispatch id the injected contract carries, the model that ran, and the
   * last assistant text when no message was passed.
   */
  transcript?: string | null;
  /**
   * The harness's own id for the subagent that stopped. Tried before the
   * transcript: it is exact, it is what the harness actually knows, and it
   * still resolves when the contract never reached the transcript at all.
   */
  agentId?: string | null;
  /** The executor's stderr, when the caller has it; the tail is recorded. */
  stderr?: string | null;
  /**
   * Mark the row reconstructed — see `StoppedRow.reconstructed`. Set only by
   * the wait path, which writes the row nobody was left alive to write.
   */
  reconstructed?: boolean;
  /** Stop after the durable receipt; the harness stop hook uses this cheap path. */
  durableOnly?: boolean;
}

export interface DispatchStopped {
  record: DispatchRecord;
  row: StoppedRow;
  replayed: boolean;
  /** Set when the agent's cwd was known and was not its assigned tree. */
  mismatchedCwd: string | null;
}

/** A transcript that names no dispatch: not an error, but nothing to record. */
export class NotADispatchError extends DispatchesError {}

export function runDispatchStop(opts: DispatchStopOptions): DispatchStopped {
  const repoRoot = rootOf(opts);
  const transcriptPath = opts.transcript?.trim() ? resolve(opts.cwd ?? process.cwd(), opts.transcript.trim()) : null;
  const facts = transcriptPath != null ? readTranscriptFacts(transcriptPath) : null;
  // The agent id first: the harness knows it for certain, where the contract
  // header is something Fadeno hopes it will find in a file the harness wrote.
  // An id that names no dispatch is not an error here — a stop hook fires for
  // every subagent, and most of them are nobody's dispatch — so it falls
  // through to the transcript, which is what says "not a dispatch" out loud.
  const byAgent = opts.agentId?.trim() ? findDispatchByAgentId(readDispatches(repoRoot).records, opts.agentId.trim()) : null;
  const ref = byAgent?.ok === true ? byAgent.record.id : opts.ref?.trim() || facts?.dispatchId || null;
  if (ref == null) {
    // "No dispatch answers to this agent" is the same finding as "this
    // transcript carries no contract", and gets the same exit: not an error,
    // just a subagent that was nobody's dispatch. A stop hook fires for every
    // one of them, so this is the ordinary case, not the exceptional one.
    if (transcriptPath != null) throw new NotADispatchError(`${transcriptPath} carries no Fadeno dispatch contract; this agent was not a dispatch.`);
    if (opts.agentId?.trim()) throw new NotADispatchError(`no dispatch was opened for agent ${opts.agentId.trim()}; this agent was not a dispatch.`);
    throw new DispatchesError('name a dispatch (<name|id>), pass --agent-id <id>, or pass --transcript <path> so the contract header can name it.');
  }
  const record = lookup(repoRoot, ref);
  if (record.opened == null) throw new DispatchesError(`dispatch ${record.id} has no opened row; nothing to stop.`);
  const assigned = workspaceDir(repoRoot, record.opened);
  const agentCwd = opts.agentCwd?.trim() || null;
  const mismatchedCwd = agentCwd != null && assigned != null && canonical(agentCwd) !== canonical(assigned) ? agentCwd : null;
  if (record.stopped != null) {
    const row = opts.durableOnly === true || record.stopped.evidence !== 'durable'
      ? record.stopped
      : enrichStopped(repoRoot, record.stopped, { cwd: assigned, branch: record.opened.workspace?.branch ?? null });
    return {
      record: row === record.stopped ? record : { ...record, stopped: row, state: record.closed ? 'closed' : 'stopped' },
      row,
      replayed: true,
      mismatchedCwd,
    };
  }
  let message: string | null = null;
  if (opts.messageFile != null && opts.messageFile.trim() !== '') {
    const path = resolve(opts.cwd ?? process.cwd(), opts.messageFile);
    message = existsSync(path) ? readFileSync(path, 'utf8') : null;
  } else if (typeof opts.message === 'string') message = opts.message;
  if ((message == null || message.trim().length === 0) && facts?.lastAssistantText != null) message = facts.lastAssistantText;
  const row = recordStopped(repoRoot, record.id, {
    finalMessage: message != null && message.trim().length > 0 ? message : null,
    cwd: assigned,
    branch: record.opened.workspace?.branch ?? null,
    modelObserved: facts?.model ?? null,
    stderr: opts.stderr ?? null,
    reconstructed: opts.reconstructed === true,
    durableFirst: true,
    inspect: opts.durableOnly !== true,
  });
  return { record: { ...record, stopped: row, state: record.closed ? 'closed' : 'stopped' }, row, replayed: false, mismatchedCwd };
}

// ---------------------------------------------------------------------------
// dispatch-close / cancel
// ---------------------------------------------------------------------------

export interface DispatchCloseOptions extends CommonOptions {
  ref: string;
  verb: string;
  note?: string | null;
  /** Close `--merged` anyway when git cannot see the branch in HEAD. */
  force?: boolean;
}

export interface DispatchClosed {
  record: DispatchRecord;
  verb: CloseVerb;
  replayed: boolean;
  worktree: string | null;
  branch: string | null;
  /** The `--merged` check, when one was made; null for the other close verbs. */
  merge: MergeCheck | null;
  /** What `--force` closed over, when it did. */
  forced: string | null;
}

/**
 * Why `--merged` alone is checked.
 *
 * `--kept`, `--discarded` and `--failed` state the host's intent, and an
 * intent cannot be false. `--merged` states something about the repository,
 * which git can confirm or contradict — so it is the one close verb Fadeno is
 * able to check, and therefore the one it must.
 *
 * The check is a tripwire, not a wall: it fires on the accident (closing before
 * looking, which one director did twice in a day and named as where its
 * mistakes lived) and steps aside for the legitimate case, because a squash or
 * a rebase lands the work without leaving the branch reachable from HEAD and
 * Fadeno must not call that a lie.
 */
function mergeRefusal(name: string, branch: string, check: MergeCheck): string | null {
  const problems: string[] = [];
  if (check.unmerged > 0) {
    problems.push(`${branch} has ${check.unmerged} commit(s) that HEAD does not have`);
  }
  if (check.uncommitted.length > 0) {
    const sample = check.uncommitted.slice(0, 5).join(', ');
    problems.push(
      `its worktree holds ${check.uncommitted.length} uncommitted tracked path(s) (${sample}${check.uncommitted.length > 5 ? ', …' : ''}), which no merge could have taken`,
    );
  }
  if (problems.length === 0) return null;
  return (
    `refusing to close ${name} as "merged": ${problems.join('; and ')}. ` +
    `Merge it (\`git merge ${branch}\`) and close again — or, if the work landed another way (a squash, a rebase, a reimplementation), ` +
    'close with `--force` and record how in `--note`. `--kept` is the verb for a branch you are leaving for later.'
  );
}

export function runDispatchClose(opts: DispatchCloseOptions): DispatchClosed {
  const repoRoot = rootOf(opts);
  if (!isCloseVerb(opts.verb)) throw new DispatchesError(`close needs exactly one of --merged, --kept, --discarded, --failed, --reviewed; got "${opts.verb}".`);
  const record = lookup(repoRoot, opts.ref);
  const opened = record.opened;
  const branch = opened?.workspace?.branch ?? null;
  const worktree = opened?.workspace != null && opened.workspace.path !== '.' ? opened.workspace.path : null;
  const name = opened?.name ?? record.id.slice(0, 8);

  // A dispatch must return its report before anyone decides what to do with
  // it. The command lane's executor inherits this id, so refusing here is
  // the one enforcement point that covers every close verb and both name/id
  // lookup forms. A parent agent may still close a child: its environment id
  // differs from the child's record id.
  const currentDispatchId = opts.env?.[DISPATCH_ID_ENV] ?? process.env[DISPATCH_ID_ENV];
  if (currentDispatchId === record.id) {
    throw new DispatchesError(
      `refusing to close ${name}: this is the dispatch you are currently running in; this dispatch must return its report, and its caller/host closes it. Close only a child dispatch you opened.`,
    );
  }

  // Not on a replay: the decision was already recorded, and re-litigating it
  // now would make an idempotent command fail on its second run.
  let merge: MergeCheck | null = null;
  let forced: string | null = null;
  if (opts.verb === 'merged' && record.closed == null) {
    merge = verifyMerged({ repoRoot, branch, worktree: worktree == null ? null : join(repoRoot, worktree) });
    if (merge.checked && branch != null) {
      const refusal = mergeRefusal(name, branch, merge);
      if (refusal != null) {
        if (!opts.force) throw new DispatchesError(refusal);
        forced = refusal;
      }
    }
  }

  const outcome = closeDispatch(repoRoot, record, opts.verb, opts.note ?? null);
  if (!outcome.ok) throw new DispatchesError(outcome.message);
  return { record, verb: opts.verb, replayed: outcome.replayed, worktree, branch, merge, forced };
}

export async function runCancel(opts: CommonOptions & { ref: string; graceMs?: number }): Promise<CancelOutcome & { record: DispatchRecord }> {
  const repoRoot = rootOf(opts);
  const record = lookup(repoRoot, opts.ref);
  const outcome = await cancelDispatch(repoRoot, record, { graceMs: opts.graceMs });
  return { ...outcome, record };
}

// ---------------------------------------------------------------------------
// dispatches — list, show, output
// ---------------------------------------------------------------------------

export interface DispatchEntry {
  id: string;
  name: string | null;
  archetype: string | null;
  model: string | null;
  effort: string | null;
  lane: Lane | null;
  harness: string | null;
  state: DispatchState;
  at: string | null;
  age: string;
  branch: string | null;
  shared: boolean;
  dirty: number | 'unavailable' | null;
  inspectionPending: boolean;
  exit: { code: number | null; signal: string | null } | null;
  verb: CloseVerb | null;
  note: string | null;
  task: string | null;
  parent: string | null;
}

export interface DispatchesResult {
  entries: DispatchEntry[];
  total: number;
  unclosed: number;
  unreadable: number;
  unknown: number;
}

export function entryOf(record: DispatchRecord, now?: Date): DispatchEntry {
  const o = record.opened;
  const s = record.stopped;
  return {
    id: record.id,
    name: o?.name ?? null,
    archetype: o?.archetype ?? null,
    model: o?.model ?? null,
    effort: o?.effort ?? null,
    lane: o?.lane ?? null,
    harness: o?.harness ?? null,
    state: record.state,
    at: o?.at ?? s?.at ?? null,
    age: formatAge(ageMinutes(record, now)),
    branch: o?.workspace?.branch ?? null,
    shared: o?.workspace != null && o.workspace.branch == null,
    dirty: s == null ? null : s.dirty === 'unavailable' ? 'unavailable' : s.dirty.paths.length,
    inspectionPending: s?.evidence === 'durable',
    exit: s?.exit ?? null,
    verb: record.closed?.verb ?? null,
    note: record.closed?.note ?? null,
    task: o?.task ?? null,
    parent: o?.parent ?? null,
  };
}

export function runDispatches(opts: CommonOptions & { tail?: number | null; all?: boolean; now?: Date } = {}): DispatchesResult {
  const repoRoot = rootOf(opts);
  const reading = readDispatches(repoRoot);
  const chosen = opts.all ? reading.records : reading.records.filter((r) => r.closed == null);
  const tail = opts.tail ?? 20;
  const shown = tail > 0 ? chosen.slice(-tail) : chosen;
  return {
    entries: shown.map((r) => entryOf(r, opts.now)),
    total: reading.records.length,
    unclosed: reading.records.filter((r) => r.closed == null && r.opened != null).length,
    unreadable: reading.unreadable,
    unknown: reading.unknown,
  };
}

export function renderDispatchLine(e: DispatchEntry): string {
  const state = e.state === 'closed' ? `closed: ${e.verb}` : e.state === 'stopped' ? 'awaiting close' : 'open';
  const route = e.model == null ? '?' : `${e.model}${e.effort ? `@${e.effort}` : ''}${e.harness ? ` on ${e.harness}` : ''}`;
  const details = [
    e.shared ? 'shared tree' : null,
    e.inspectionPending ? 'worktree inspection pending' : e.dirty === 'unavailable' ? 'tree unreadable' : typeof e.dirty === 'number' && e.dirty > 0 ? `${e.dirty} dirty path(s)` : null,
    e.exit?.signal ? `killed by ${e.exit.signal}` : e.exit?.code != null && e.exit.code !== 0 ? `exit ${e.exit.code}` : null,
  ].filter((detail): detail is string => detail != null);
  const name = `${e.name ?? '?'}${details.length > 0 ? ` (${details.join('; ')})` : ''}`;
  return [
    e.age.padEnd(4),
    state.padEnd(17),
    (e.archetype ?? '?').padEnd(12),
    route.padEnd(28),
    name,
  ].join('  ');
}

/** The column names for `renderDispatchLine`, in the same widths. */
export const DISPATCH_LINE_HEADER = [
  'AGE'.padEnd(4),
  'STATE'.padEnd(17),
  'ARCHETYPE'.padEnd(12),
  'ROUTE'.padEnd(28),
  'NAME',
].join('  ');

export function renderDispatches(result: DispatchesResult): string[] {
  const lines: string[] = [];
  if (result.entries.length === 0) {
    lines.push(result.total === 0 ? 'No dispatches recorded in this repository.' : `No unclosed dispatches (${result.total} recorded; --all shows them).`);
  } else {
    lines.push(DISPATCH_LINE_HEADER);
    for (const e of result.entries) lines.push(renderDispatchLine(e));
    lines.push('', `${result.unclosed} unclosed of ${result.total} recorded.`);
  }
  if (result.unreadable > 0) lines.push(`${result.unreadable} unreadable row(s) skipped — the ledger has damage; the rows above are the readable ones.`);
  if (result.unknown > 0) lines.push(`${result.unknown} row(s) in another format skipped (an older Fadeno's, or a newer one's).`);
  return lines;
}

export interface DispatchDetail {
  record: DispatchRecord;
  entry: DispatchEntry;
  worktree: string | null;
  prompt: string | null;
  transcript: string | null;
  stderr: string | null;
}

export function runDispatchShow(opts: CommonOptions & { ref: string }): DispatchDetail {
  const repoRoot = rootOf(opts);
  const record = lookup(repoRoot, opts.ref);
  const paths = outputPaths(record.id);
  const worktree = record.opened != null ? workspaceDir(repoRoot, record.opened) : null;
  return {
    record,
    entry: entryOf(record),
    worktree,
    prompt: readPrompt(repoRoot, record),
    transcript: existsSync(join(repoRoot, paths.stdout)) ? paths.stdout : null,
    stderr: existsSync(join(repoRoot, paths.stderr)) ? paths.stderr : null,
  };
}

export function renderDispatchDetail(d: DispatchDetail): string[] {
  const e = d.entry;
  const lines = [
    `${e.name ?? '?'} (${d.record.id})`,
    `  archetype: ${e.archetype ?? '?'}   model: ${e.model ?? '?'}${e.effort ? `@${e.effort}` : ''}   harness: ${e.harness ?? '?'}   lane: ${e.lane ?? '?'}`,
    `  opened:    ${e.at ?? '?'} (${e.age} ago)${e.parent ? `   parent: ${e.parent}` : ''}`,
    `  worktree:  ${d.worktree ?? '(none recorded)'}${e.branch ? ` on ${e.branch}` : e.shared ? ' (shared tree)' : ''}`,
    `  state:     ${e.state}${e.verb ? ` (${e.verb}${e.note ? `: ${e.note}` : ''})` : ''}`,
  ];
  // Said once, plainly, at the top: the row has no record of the ask. A reader
  // who scrolls to "what the agent reported" and works back would otherwise
  // meet the explanation in the task column and take it for the task.
  if (d.record.opened?.prompt_sealed === true) {
    const why = (d.prompt ?? '').split('\n', 1)[0]!.replace(/^\(|\)$/g, '');
    lines.push(`  the ask:   NOT RECORDED — ${why}`);
  }
  if (d.record.stopped != null) {
    const s = d.record.stopped;
    const dirty = s.dirty === 'unavailable' ? 'unreadable' : s.dirty.paths.length === 0 ? 'clean' : `${s.dirty.paths.length}${s.dirty.truncated ? '+' : ''} path(s): ${s.dirty.paths.slice(0, 8).join(', ')}`;
    lines.push(`  stopped:   ${s.at}${s.exit ? ` — ${s.exit.signal ? `killed by ${s.exit.signal}` : `exit ${s.exit.code}`}` : ''}; ${s.evidence === 'durable' ? 'worktree inspection pending — replay dispatch-stop to gather Git evidence' : `tree ${dirty}`}`);
    if (s.model_observed != null) {
      const asked = d.record.opened?.model ?? null;
      lines.push(`  ran on:    ${s.model_observed}${modelAgrees(asked, s.model_observed, d.record.opened?.model_id) ? '' : `  (the dial asked for ${asked})`}`);
    }
    // The two halves, labelled. A report is a claim and the measurement is
    // not, and the single most useful thing this view can do is make it
    // impossible to read one and think you read the other.
    lines.push('', '--- what Fadeno measured ---', ...(s.evidence === 'durable'
      ? ['  not measured yet; replay `fadeno dispatch-stop` without `--durable` to gather worktree evidence.']
      : renderWorkMeasured(s.work, d.record.opened?.workspace?.branch ?? null)));
    // Ignored paths belong here and not in `tree clean` above: git does not
    // count them. An isolated worktree is removed by `fadeno clean`, but a
    // shared dispatch is the caller's tree and clean must never claim it can
    // remove the caller's ignored files.
    if (s.ignored === 'unavailable') lines.push('  ignored paths: unreadable');
    else if (s.ignored != null && s.ignored.paths.length > 0) {
      const shared = e.shared
        ? 'in the shared tree — the shared checkout is retained; `fadeno clean` only removes eligible Fadeno scratch'
        : 'in the worktree — `fadeno clean` removes these';
      lines.push(`  ${s.ignored.paths.length}${s.ignored.truncated ? '+' : ''} ignored path(s) ${shared}: ${s.ignored.paths.join(', ')}`);
    }
    // The tail of stderr, when the ending needs explaining: a non-zero exit,
    // a signal, or a dispatch that stopped and said nothing.
    const needsStderr = s.exit != null && (s.exit.code !== 0 || s.exit.signal != null);
    if (s.stderr_excerpt != null && (needsStderr || s.final_message == null)) {
      lines.push('', '--- the executor\'s last words on stderr ---', s.stderr_excerpt.trimEnd());
    }
    if (s.final_message != null) {
      lines.push('', '--- what the agent reported (a claim, not a finding) ---', s.final_message.trimEnd());
    } else lines.push('', '--- what the agent reported --- none recorded');
    if (d.transcript != null) {
      const reportState = d.record.stopped == null ? 'output so far, not a report' : 'the complete command-lane report';
      lines.push(`  full report: \`fadeno dispatches --output ${e.name ?? d.record.id}\` prints ${reportState} verbatim (transcript: ${d.transcript})`);
    } else if (e.lane === 'command' && s.final_message != null) {
      lines.push('  full report: command-lane stdout transcript unavailable; the text above is only the stopped row\'s bounded final-message excerpt.');
    }
  }
  if (d.record.opened != null) lines.push('', `  prompt: ${d.record.opened.prompt}${d.transcript ? `   transcript: ${d.transcript}` : ''}${d.stderr ? `   stderr: ${d.stderr}` : ''}`);
  if (e.task) lines.push(`  task: ${e.task.split('\n')[0]}${d.record.opened?.task_truncated ? ' …' : ''}`);
  return lines;
}

/**
 * The measured half of a stopped dispatch: what git says the branch holds.
 *
 * Rendered apart from the agent's report on purpose. A director asked for
 * machine-readable dispatch results so it could stop reading reports to verify
 * them — but a field the agent fills in is the same claim in a smaller box,
 * and the three fake-green results that prompted the ask (a canary that could
 * not fail, a feature never compiled in, an artifact from the wrong toolchain)
 * would each have arrived as a tidy `tests: passed`. These lines are the ones
 * nobody wrote down: they are safe to trust precisely because no agent had a
 * hand in them.
 */
export function renderWorkMeasured(work: WorkMeasured | undefined, branch: string | null): string[] {
  if (work == null) {
    return branch == null
      ? ['  no branch of its own (shared tree): there is nothing git can attribute to this dispatch.']
      : [`  ${branch}: not measured — the branch was unreadable when it stopped, or an older Fadeno wrote this row.`];
  }
  const churn = work.files === 0
    ? 'no file changes'
    : `${work.files} file(s), +${work.insertions} -${work.deletions}${work.binary > 0 ? `, ${work.binary} binary` : ''}`;
  const lines = [
    `  ${branch ?? 'branch'} at ${work.head.slice(0, 12)}: ${work.commits} commit(s) HEAD does not have; ${churn}`,
  ];
  if (work.conflicts.length > 0) {
    lines.push(
      `  CONFLICT MARKERS committed in ${work.conflicts.length}${work.conflicts_truncated ? '+' : ''} path(s): ${work.conflicts.join(', ')}`,
    );
  }
  if (work.commits === 0) lines.push('  Nothing is on this branch that HEAD lacks — either it was already merged, or no work was committed.');
  return lines;
}

export interface DispatchOutput {
  record: DispatchRecord;
  text: string | null;
  source: 'transcript' | 'final_message' | null;
}

/**
 * The dispatch's report: the full transcript when one exists, else what the
 * stop row recorded.
 *
 * An EMPTY transcript is not a report. The file exists from the moment the
 * executor is launched, so `existsSync` alone said "here is the report" and
 * handed back nothing — and because an empty string is not null, every caller
 * downstream treated that as success. Four workers killed by a full disk were
 * relayed to their proxies as finished with a blank report and exit 0. A file
 * with nothing in it also lost to nothing: it out-ranked a `final_message` the
 * stop row was holding.
 */
export function runDispatchOutput(opts: CommonOptions & { ref: string }): DispatchOutput {
  const repoRoot = rootOf(opts);
  const record = lookup(repoRoot, opts.ref);
  const transcript = join(repoRoot, outputPaths(record.id).stdout);
  if (existsSync(transcript)) {
    const text = readFileSync(transcript, 'utf8');
    if (text.trim() !== '') return { record, text, source: 'transcript' };
  }
  if (record.stopped?.final_message != null) return { record, text: record.stopped.final_message, source: 'final_message' };
  return { record, text: null, source: null };
}

export type DispatchReadResult =
  | { kind: 'list'; result: DispatchesResult }
  | { kind: 'show'; result: DispatchDetail }
  | { kind: 'output'; result: DispatchOutput };

/** Shared read command for both `dispatch` and compatibility `dispatches`. */
export function runDispatchRead(opts: CommonOptions & { ref?: string | null; output?: string | null; tail?: number | null; all?: boolean } = {}): DispatchReadResult {
  if (opts.output != null) return { kind: 'output', result: runDispatchOutput({ ...opts, ref: opts.output }) };
  if (opts.ref != null) return { kind: 'show', result: runDispatchShow({ ...opts, ref: opts.ref }) };
  return { kind: 'list', result: runDispatches(opts) };
}

// ---------------------------------------------------------------------------
// dispatch-wait — the answer to a harness that caps how long a call may run
// ---------------------------------------------------------------------------

export type WaitOutcome =
  /** One of them stopped (or was already stopped): `text` is its report. */
  | { state: 'stopped'; record: DispatchRecord; text: string | null; waitedMs: number; waiting: DispatchRecord[] }
  /** All still running when the bound elapsed. Ask again; nothing is wrong. */
  | { state: 'running'; record: DispatchRecord; waitedMs: number; waiting: DispatchRecord[] };

export interface DispatchWaitOptions extends CommonOptions {
  /**
   * The dispatches to wait on. Several answer on the FIRST to stop, which is
   * the shape a director fanning out actually needs: it was polling four
   * ledgers by hand between turns, and a wait that took one name at a time
   * would have made it choose which of the four to be blind to.
   */
  refs: readonly string[];
  /**
   * How long to block before answering `running`. The default sits under the
   * ten-minute ceiling every harness shell tool imposes, so this command
   * always returns on its own terms rather than being killed or backgrounded
   * mid-wait — which is the entire failure it exists to end.
   */
  waitSeconds?: number;
  pollMs?: number;
  /**
   * How long a dead process group is given to produce its stop row. Tests
   * shorten it with `FADENO_ABANDON_SETTLE_MS`; a harness never sets it.
   */
  settleMs?: number;
}

/**
 * How long "the group is gone" waits before it becomes "abandoned".
 *
 * Longer than `CANCEL_GRACE_MS`, and that is the whole point. `fadeno cancel`
 * signals the group, waits up to five seconds for it to die, and only THEN
 * writes the stop row nobody else will. A wait loop that saw the dead group
 * and gave up after one immediate re-read landed inside that window: cancel
 * printed "stop recorded" and the proxy, in the same minute, reported that no
 * stop was ever recorded. The same window swallowed a worker that ran for an
 * hour and finished normally — its launcher was mid-append.
 *
 * Waiting a few seconds costs nothing. Declaring work lost costs the work.
 */
export const ABANDON_SETTLE_MS = 8_000;

function settleFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = Number(env.FADENO_ABANDON_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Block until one of these dispatches stops, then answer with its report.
 *
 * A dispatch that outruns the caller's shell timeout used to end as a lie: the
 * harness backgrounded the call, the proxy returned whatever had been written
 * so far, and the session was told the agent had finished. The work had not
 * finished, and the process that would eventually record it was still running.
 *
 * The loop belongs on the caller's side, in bites the harness allows: wait,
 * answer `running`, be asked again. Nothing here kills anything or decides
 * anything is too slow — the bound is on WAITING, never on the work.
 */
export async function runDispatchWait(opts: DispatchWaitOptions): Promise<WaitOutcome> {
  const repoRoot = rootOf(opts);
  const started = Date.now();
  const deadline = started + Math.max(0, (opts.waitSeconds ?? 540)) * 1000;
  const pollMs = Math.max(50, opts.pollMs ?? 1000);
  const refs = opts.refs.map((ref) => ref.trim()).filter((ref) => ref !== '');
  if (refs.length === 0) throw new DispatchesError('name at least one dispatch to wait on.');
  // Resolved once, up front: an unknown name is the caller's mistake and must
  // be said immediately, not after nine minutes of waiting on the others.
  const ids = [...new Set(refs.map((ref) => lookup(repoRoot, ref).id))];
  const reread = (id: string): DispatchRecord => {
    const found = readDispatches(repoRoot).records.find((r) => r.id === id);
    if (found == null) throw new DispatchesError(`dispatch ${id} vanished from the ledger while waiting.`);
    return found;
  };
  const report = (id: string): string | null => runDispatchOutput({ repoRoot, ref: id }).text;
  /** Give a dead group's writer its window, then answer with whatever landed. */
  const settle = async (id: string): Promise<DispatchRecord> => {
    const until = Date.now() + Math.max(0, opts.settleMs ?? settleFromEnv(opts.env) ?? ABANDON_SETTLE_MS);
    for (;;) {
      const record = reread(id);
      if (record.stopped != null || Date.now() >= until) return record;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, until - Date.now()))));
    }
  };

  for (;;) {
    const records = ids.map(reread);
    // A close is the host's decision, not the executor's report. In
    // particular, a command-lane process can still be alive after an older
    // client wrote a close row, so only a stopped row is report-ready.
    const running = records.filter((r) => r.stopped == null);
    const done = records.find((r) => r.stopped != null);
    if (done != null) {
      return { state: 'stopped', record: done, text: report(done.id), waitedMs: Date.now() - started, waiting: running };
    }
    // Nobody left to write the stop row. Checked BEFORE the clock, because a
    // caller waiting on a dispatch that cannot finish should hear it at once —
    // but only after giving whoever WOULD write it time to finish, because the
    // writer is a separate process and a dead group is not a settled one.
    for (const record of records) {
      const pgid = record.opened?.process_group;
      if (pgid == null || groupAlive(pgid)) continue;
      const settled = await settle(record.id);
      const others = records.filter((r) => r.id !== settled.id && r.stopped == null);
      if (settled.stopped != null) {
        return { state: 'stopped', record: settled, text: report(settled.id), waitedMs: Date.now() - started, waiting: others };
      }
      // Nobody is left to write the stop row, so write it here from what the
      // executor left on disk. Whether it FINISHED and whether anyone
      // RECORDED it are two questions, and only the second one failed: the
      // report, the commits and the stderr are all still there. Answering the
      // first with "no report is coming" is how a night of finished, committed
      // work was handed back to its hosts as lost.
      const paths = outputPaths(settled.id);
      const stdoutPath = join(repoRoot, paths.stdout);
      const stderrPath = join(repoRoot, paths.stderr);
      const recovered = runDispatchStop({
        repoRoot,
        ref: settled.id,
        messageFile: existsSync(stdoutPath) ? stdoutPath : null,
        stderr: existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : null,
        // How it ended is genuinely unknown — that is the one thing that died
        // with the launcher — so the row says it was reconstructed and carries
        // no exit rather than inventing a clean one.
        reconstructed: true,
      });
      return {
        state: 'stopped',
        record: recovered.record,
        text: report(settled.id),
        waitedMs: Date.now() - started,
        waiting: others,
      };
    }
    if (Date.now() >= deadline) {
      return { state: 'running', record: records[0]!, waitedMs: Date.now() - started, waiting: running };
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

// ---------------------------------------------------------------------------
// worktrees — the cross-session safety net
// ---------------------------------------------------------------------------

export interface WorktreeEntry extends WorktreeReport {
  dispatch: { id: string; name: string | null; state: DispatchState } | null;
}

export function runWorktrees(opts: CommonOptions = {}): WorktreeEntry[] {
  const repoRoot = rootOf(opts);
  const byBranch = new Map<string, DispatchRecord>();
  for (const record of readDispatches(repoRoot).records) {
    const branch = record.opened?.workspace?.branch;
    if (branch != null && !byBranch.has(branch)) byBranch.set(branch, record);
  }
  return reportWorktrees(repoRoot).map((wt) => {
    const record = wt.branch != null ? byBranch.get(wt.branch) ?? null : null;
    return { ...wt, dispatch: record == null ? null : { id: record.id, name: record.opened?.name ?? null, state: record.state } };
  });
}

export function renderWorktrees(entries: WorktreeEntry[]): string[] {
  if (entries.length === 0) return ['No Fadeno worktrees registered.'];
  const lines: string[] = [];
  for (const w of entries) {
    const dirty = w.dirty === 'unavailable' ? 'status unreadable' : w.dirty.paths.length === 0 ? 'clean' : `${w.dirty.paths.length}${w.dirty.truncated ? '+' : ''} uncommitted`;
    const unmerged = w.unmerged === 'unavailable' ? 'unmerged: ?' : `${w.unmerged} unmerged commit(s)`;
    const ignored = w.ignored === 'unavailable' || w.ignored.paths.length === 0
      ? ''
      : `; ${w.ignored.paths.length}${w.ignored.truncated ? '+' : ''} ignored (${w.ignored.paths.slice(0, 4).join(', ')})`;
    const owner = w.dispatch == null ? 'no dispatch names it' : `${w.dispatch.name ?? w.dispatch.id.slice(0, 8)} (${w.dispatch.state})`;
    lines.push(`${w.path}  ${w.branch ?? '(detached)'}  ${dirty}; ${unmerged}${ignored}  — ${owner}${w.exists ? '' : '  [directory missing]'}`);
  }
  // Ignored paths count as holding. The summary line saying "nothing here
  // holds work that is not on HEAD" while the row above it lists a gitignored
  // `out/` full of receipts is the same blind spot in a shorter sentence.
  const holding = entries.filter(
    (w) =>
      (w.dirty !== 'unavailable' && w.dirty.paths.length > 0) ||
      (typeof w.unmerged === 'number' && w.unmerged > 0) ||
      (w.ignored !== 'unavailable' && w.ignored.paths.length > 0) ||
      w.dirty === 'unavailable' ||
      w.ignored === 'unavailable' ||
      w.unmerged === 'unavailable',
  );
  lines.push(
    '',
    holding.length === 0
      ? 'Nothing here holds work: no uncommitted paths, no unmerged commits, no ignored files.'
      : `${holding.length} worktree(s) hold work that is not on HEAD, hold ignored files, or could not be read.`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// context — what a host or a spawned director is told
// ---------------------------------------------------------------------------

export function runContext(opts: CommonOptions & { now?: Date } = {}): { text: string; reminder: string; archetypes: ArchetypeLine[]; preamble: Preamble } {
  const repoRoot = rootOf(opts);
  const { archetypes, profile } = describeArchetypes({ repoRoot, userPathOptions: opts.userPathOptions });
  const unclosed = unclosedDispatches(repoRoot);
  const preamble = readPreamble(repoRoot);
  return { text: hostVocabulary({ archetypes, unclosed, preamble, host: profile.host ?? null, now: opts.now }), reminder: hostTurnReminder(unclosed), archetypes, preamble };
}

// ---------------------------------------------------------------------------
// clean — machine-local scratch only
// ---------------------------------------------------------------------------

export interface CleanResult {
  dryRun: boolean;
  /**
   * Worktrees removed, or that would be — each with the ignored paths that go
   * with it. A worker wrote 5.4 MB of receipts into a gitignored `out/` and
   * the preview said only "would remove worktree …", which is true and tells
   * the reader nothing about what they are about to lose.
   */
  worktrees: Array<{ path: string; ignored: string[]; truncated: boolean }>;
  /** Worktrees left alone, and why. */
  kept: Array<{ path: string; reason: string }>;
  /** Individually selected command-lane files removed, or that would be. */
  outputs: CleanArtifactResult | null;
  /** Individually selected stale relay files removed, or that would be. */
  relay: CleanArtifactResult | null;
  /** Individually selected expired prompt files removed, or that would be. */
  stagedPrompts: CleanArtifactResult | null;
  /** Individually selected cancellation files removed, or that would be. */
  cancelRequests: CleanArtifactResult | null;
}

export interface CleanArtifactResult {
  /** The directory is retained; only `entries` are selected. */
  directory: string;
  entries: string[];
}

/** A dispatch still owns scratch until its stopped receipt exists and its process group is gone. */
function processGroupIsLive(record: DispatchRecord): boolean {
  const processGroup = record.opened?.process_group;
  return processGroup != null && groupAlive(processGroup);
}

function dispatchStillOwnsScratch(record: DispatchRecord): boolean {
  return record.opened != null && (record.stopped == null || processGroupIsLive(record));
}

function errnoCode(error: unknown): string | null {
  return typeof error === 'object' && error != null && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function cleanIoError(action: string, path: string, error: unknown, fix: string): DispatchesError {
  const detail = error instanceof Error ? error.message : String(error);
  return new DispatchesError(`clean: could not ${action} ${path}: ${detail}. ${fix}`);
}

/** Retire one snapshot file; never recursively remove a scratch directory. */
function retireScratchFile(path: string): boolean {
  const retired = `${path}.cleanup-${randomUUID()}`;
  try {
    renameSync(path, retired);
  } catch (error) {
    // A concurrent claimant or another cleanup won the race. Do not retry the
    // original path: it may now be a fresh artifact.
    if (errnoCode(error) === 'ENOENT') return false;
    throw cleanIoError('retire scratch file', path, error, 'Fix the filesystem error and rerun `fadeno clean --force`.');
  }
  try {
    unlinkSync(retired);
    return true;
  } catch (error) {
    // The rename made the artifact ours. If unlink cannot finish, leave the
    // uniquely named moved path visible so a person can recover it rather than
    // reporting a healthy cleanup that silently lost track of it.
    throw cleanIoError(
      'remove retired scratch file',
      retired,
      error,
      `The artifact is recoverable at ${retired}; inspect or remove that path after fixing the filesystem problem, then rerun cleanup.`,
    );
  }
}

function staleByMtime(path: string, now: number): boolean {
  try {
    const age = now - statSync(path).mtimeMs;
    return Number.isFinite(age) && age > STAGED_PROMPT_TTL_MS;
  } catch (error) {
    // An unreadable age is not proof of staleness.
    if (errnoCode(error) === 'ENOENT') return false;
    throw cleanIoError('read scratch modification time', path, error, 'Fix the filesystem error and rerun `fadeno clean`.');
  }
}

type CleanScratchSnapshotHook = (relativeDir: string) => void;

function snapshotDirectory(
  repoRoot: string,
  relativeDir: string,
  onSnapshot?: CleanScratchSnapshotHook,
): { absolute: string; entries: Dirent[] } | null {
  const absolute = join(repoRoot, relativeDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    // A directory disappearing between cleanup's scan and this read is the
    // one benign race. A file in its place, or an unreadable directory, must
    // be visible instead of becoming "Nothing to clean."
    if (errnoCode(error) === 'ENOENT') return null;
    throw cleanIoError('read scratch directory', absolute, error, 'Restore the directory or fix its permissions, then rerun `fadeno clean`.');
  }
  onSnapshot?.(relativeDir);
  return { absolute, entries };
}

function cleanSnapshotFiles(
  repoRoot: string,
  relativeDir: string,
  dryRun: boolean,
  selected: (entry: Dirent, path: string) => boolean,
  onSnapshot?: CleanScratchSnapshotHook,
): CleanArtifactResult | null {
  const snapshot = snapshotDirectory(repoRoot, relativeDir, onSnapshot);
  if (snapshot == null) return null;
  const candidates = snapshot.entries.filter((entry) => selected(entry, join(snapshot.absolute, entry.name)));
  if (candidates.length === 0) return null;
  const entries = dryRun
    ? candidates.map((entry) => entry.name)
    : candidates.filter((entry) => retireScratchFile(join(snapshot.absolute, entry.name))).map((entry) => entry.name);
  return entries.length === 0 ? null : { directory: relativeDir, entries };
}

function selectedStoppedDispatches(records: ReadonlyMap<string, DispatchRecord>): Set<string> {
  return new Set(
    [...records.values()]
      .filter((record) => record.opened != null && record.stopped != null && !processGroupIsLive(record))
      .map((record) => record.id),
  );
}

function readExpiresAt(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { expiresAt?: unknown };
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return null;
    return typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : null;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw cleanIoError('read staged prompt expiry', path, error, 'Fix or remove the unreadable scratch file, then rerun `fadeno clean`.');
  }
}

function staleStagedPrompt(entry: Dirent, path: string, now: number): boolean {
  if (!entry.isFile() || !/^[a-z0-9]{16}\.json(?:\.claimed-[0-9a-f-]+)?$/.test(entry.name)) return false;
  const expiresAt = readExpiresAt(path);
  // A valid claim remains private and usable until its own expiration. A
  // malformed or partially-written artifact is only stale once its mtime is
  // old enough that it cannot be a fresh pending handoff.
  return expiresAt != null ? expiresAt <= now : staleByMtime(path, now);
}

function cancelArtifactBelongsTo(name: string, ids: ReadonlySet<string>): boolean {
  for (const id of ids) {
    if (name === `${id}.request.json` || name === `${id}.ack.json` || name.startsWith(`${id}.request.json.`) || name.startsWith(`${id}.ack.json.`)) return true;
  }
  return false;
}

/**
 * Remove worktrees whose known dispatch has a stopped receipt and that hold no
 * uncommitted work, plus individually selected scratch files. Unknown or
 * preparing worktrees remain protected. A closed row without a stopped row,
 * or a stopped row with a live process group, remains protected. Never
 * recorded prompts, never the ledger, never a tree with uncommitted changes.
 * Expired staged Codex handoffs are scratch and may be removed.
 */
export function runClean(opts: CommonOptions & { force?: boolean; onScratchSnapshot?: CleanScratchSnapshotHook } = {}): CleanResult {
  const repoRoot = rootOf(opts);
  const dryRun = !opts.force;
  const ledgerRecords = readDispatches(repoRoot).records;
  const records = new Map(ledgerRecords.map((record) => [record.id, record]));
  const result: CleanResult = { dryRun, worktrees: [], kept: [], outputs: null, relay: null, stagedPrompts: null, cancelRequests: null };
  for (const wt of runWorktrees({ repoRoot })) {
    if (wt.dispatch == null) {
      // A worktree is cut before its opened row is appended. It may therefore
      // be a live preparing dispatch rather than stale debris.
      result.kept.push({ path: wt.path, reason: 'no dispatch names this worktree; preserve unknown or preparing work' });
      continue;
    }
    const dispatch = records.get(wt.dispatch.id);
    if (dispatch == null) {
      // The worktree listing can observe a newly opened row after the ledger
      // snapshot above. Unknown state is never permission to delete it.
      result.kept.push({ path: wt.path, reason: `dispatch ${wt.dispatch.name ?? wt.dispatch.id.slice(0, 8)} appeared during cleanup; preserve it` });
      continue;
    }
    if (dispatchStillOwnsScratch(dispatch)) {
      const name = dispatch.opened?.name ?? dispatch.id.slice(0, 8);
      const reason = dispatch.stopped == null
        ? `dispatch ${name} is ${dispatch.closed == null ? 'open' : 'closed before it stopped'}; preserve it until the stopped receipt arrives`
        : `dispatch ${name} stopped, but its process group is still live; preserve it until it exits`;
      result.kept.push({
        path: wt.path,
        reason,
      });
      continue;
    }
    if (wt.dirty === 'unavailable' || wt.ignored === 'unavailable' || wt.unmerged === 'unavailable') {
      result.kept.push({ path: wt.path, reason: 'status unreadable; not removing a tree that may hold work' });
      continue;
    }
    if (wt.dirty.paths.length > 0) {
      result.kept.push({ path: wt.path, reason: `${wt.dirty.paths.length} uncommitted path(s); commit or discard them first` });
      continue;
    }
    if (!dryRun) {
      const removed = removeWorktree({ repoRoot, absolute: wt.absolute });
      if (!removed.ok) {
        result.kept.push({ path: wt.path, reason: removed.reason });
        continue;
      }
    }
    result.worktrees.push({
      path: wt.path,
      ignored: wt.ignored.paths,
      truncated: wt.ignored.truncated,
    });
  }
  const stopped = selectedStoppedDispatches(records);
  const outputNames = new Set<string>();
  for (const id of stopped) {
    outputNames.add(`${id}.md`);
    outputNames.add(`${id}.err`);
    outputNames.add(`${id}.prompt.md`);
  }
  const now = Date.now();
  result.outputs = cleanSnapshotFiles(repoRoot, OUTPUTS_DIR, dryRun, (entry) => entry.isFile() && outputNames.has(entry.name), opts.onScratchSnapshot);
  result.relay = cleanSnapshotFiles(repoRoot, RELAY_DIR, dryRun, (entry, path) => entry.isFile() && staleByMtime(path, now), opts.onScratchSnapshot);
  result.stagedPrompts = cleanSnapshotFiles(repoRoot, STAGED_PROMPTS_DIR, dryRun, (entry, path) => staleStagedPrompt(entry, path, now), opts.onScratchSnapshot);
  result.cancelRequests = cleanSnapshotFiles(repoRoot, CANCEL_REQUESTS_DIR, dryRun, (entry) => entry.isFile() && cancelArtifactBelongsTo(entry.name, stopped), opts.onScratchSnapshot);
  return result;
}

export function renderClean(result: CleanResult): string[] {
  const verb = result.dryRun ? 'would remove' : 'removed';
  const lines: string[] = [];
  for (const w of result.worktrees) {
    const carrying = w.ignored.length === 0
      ? ''
      : ` — and with it ${w.ignored.length}${w.truncated ? '+' : ''} ignored path(s): ${w.ignored.join(', ')}`;
    lines.push(`${verb} worktree ${w.path} (branch kept)${carrying}`);
  }
  const scratch = (artifact: CleanArtifactResult | null, label: string): void => {
    if (artifact == null) return;
    const paths = artifact.entries.map((entry) => `${artifact.directory}/${entry}`);
    lines.push(`${verb} ${paths.join(', ')} (${label}; directory kept)`);
  };
  scratch(result.outputs, 'selected command-lane transcript files');
  scratch(result.relay, 'selected stale relay prompt files');
  scratch(result.stagedPrompts, 'selected expired staged Codex prompt files');
  scratch(result.cancelRequests, 'selected cooperative cancellation files');
  for (const k of result.kept) lines.push(`kept ${k.path}: ${k.reason}`);
  if (lines.length === 0) lines.push('Nothing to clean.');
  else if (result.dryRun) lines.push('Re-run with --force to remove. Fresh pending handoffs, unknown scratch, recorded prompts, and the ledger are never touched.');
  return lines;
}

/** Re-exported so the CLI can special-case the wrapper's own refusals. */
export { SpawnError, WORKTREES_DIR };

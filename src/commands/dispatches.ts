/**
 * The dispatch family of commands (spec §08): `dispatch` (the command lane,
 * end to end), `dispatch-open` and `dispatch-stop` (the host lane's halves,
 * driven by the hooks), `dispatch-close`, `cancel`, `dispatches`,
 * `worktrees`, `context` and `clean`. Each returns data; `cli.ts` prints.
 *
 * Everything here reads the ledger through `lib/ledger.ts` and writes it
 * through `lib/spawn.ts`, so there is one writer per row kind and one
 * reader for every surface.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DEFAULT_UNCLOSED_LIMIT, formatAge, hostVocabulary, nagText, spawnRefusedByLimit, type ArchetypeLine } from '../lib/contracts.ts';
import {
  ageMinutes,
  closeDispatch,
  findDispatch,
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
  OUTPUTS_DIR,
  RELAY_DIR,
  SpawnError,
  cancelDispatch,
  describeArchetypes,
  groupAlive,
  outputPaths,
  prepareDispatch,
  recordOpened,
  recordStopped,
  requireCommand,
  resolveArchetype,
  runCommandDispatch,
  stageRelay,
  workspaceDir,
  type CancelOutcome,
  type Relay,
  type RunResult,
} from '../lib/spawn.ts';
import { readTranscriptFacts } from '../lib/transcript.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';
import {
  WORKTREES_DIR,
  canonical,
  measureWork,
  removeWorktree,
  reportWorktrees,
  sanitizeName,
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

export async function runDispatch(opts: DispatchOptions): Promise<DispatchOutcome> {
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
   * Also write the contract-bearing prompt to a file and return its path.
   *
   * For a caller that cannot put the prompt on the spawn itself. A Codex hook
   * can refuse a spawn but not rewrite one, so it hands the host a path to
   * read rather than a string to reproduce — and a file read is one thing a
   * model does reliably, where copying four hundred lines verbatim out of a
   * refusal message is not.
   */
  stagePrompt?: boolean;
  /**
   * Return the dispatch this session already opened for this archetype and
   * name, instead of opening a second one.
   *
   * The retry guard for the refuse-and-retry lane: the host is told what to
   * spawn, and if it comes back with the instruction misapplied the wrapper
   * must not cut another worktree each time round. Requires `stagePrompt`,
   * because a reused dispatch's prompt is read back from the staged file — the
   * contract cannot be recomposed byte-for-byte after the fact (a director's
   * carries the live unclosed list).
   */
  reuseOpen?: boolean;
  /**
   * `auto` (the default) lets the resolution choose: a host candidate opens on
   * the host lane, anything else is handed to the command lane as a relay.
   * `host` opens on the host lane regardless — the caller is about to run the
   * agent in-session itself. `command` stages the relay regardless.
   */
  lane?: OpenLane;
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
  /** The contract-bearing prompt the agent should receive. */
  prompt: string;
  /** Where that prompt was staged, when `--stage-prompt` asked for a file. */
  promptFile?: string;
  contract: string;
  nag: string;
  /** True when this is the dispatch a previous call opened, not a new one. */
  reused?: true;
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

export type DispatchOpenOutcome = DispatchOpened | DispatchRelayed | { ok: false; refused: string };

export function runDispatchOpen(opts: DispatchOpenOptions): DispatchOpenOutcome {
  const repoRoot = rootOf(opts);
  const prompt = readPromptInput(opts, opts.cwd ?? process.cwd());
  if (prompt.trim().length === 0) throw new SpawnError('empty prompt: nothing to dispatch.');
  const resolution = resolveArchetype({ repoRoot, archetype: opts.archetype, explicitModel: opts.model ?? null, userPathOptions: opts.userPathOptions });
  const wanted = opts.lane ?? 'auto';
  if (!OPEN_LANES.includes(wanted)) throw new DispatchesError(`--lane ${String(wanted)}: expected one of ${OPEN_LANES.join(', ')}.`);
  const lane = wanted === 'auto' ? resolution.lane : wanted;
  const parentTranscript = opts.parentTranscript?.trim() ? resolve(opts.cwd ?? process.cwd(), opts.parentTranscript.trim()) : null;
  const parent = opts.parent !== undefined && opts.parent !== null
    ? opts.parent
    : parentTranscript != null && existsSync(parentTranscript)
      ? readTranscriptFacts(parentTranscript).dispatchId ?? undefined
      : opts.parent;
  if (lane === 'command') {
    requireCommand(resolution);
    const unclosed = unclosedDispatches(repoRoot);
    const refused = spawnRefusedByLimit(unclosed, resolution.unclosedLimit);
    if (refused != null) return { ok: false, refused };
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
      nag: nagText(unclosed, resolution.unclosedLimit),
    };
  }
  // The retry guard, before anything is prepared: a host that was refused and
  // told what to spawn may come back with the same archetype and name, and it
  // must get the dispatch it was already given rather than a second one.
  if (opts.reuseOpen === true) {
    const existing = reusableOpen(repoRoot, opts.archetype, opts.name ?? null, opts.session ?? null);
    if (existing != null) return existing;
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
    ...(opts.stagePrompt === true ? { promptFile: stageHostPrompt(repoRoot, p.id, p.composedPrompt) } : {}),
    contract: p.contract,
    nag: p.nag,
  };
}

/** Where a host-lane prompt is staged for a caller that cannot carry it inline. */
function hostPromptPath(repoRoot: string, id: string): string {
  return join(repoRoot, RELAY_DIR, `${id}.md`);
}

function stageHostPrompt(repoRoot: string, id: string, composed: string): string {
  const path = hostPromptPath(repoRoot, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, composed.endsWith('\n') ? composed : `${composed}\n`, 'utf8');
  return path;
}

/**
 * The dispatch a previous call already opened for this archetype and name, or
 * null.
 *
 * Deliberately narrow: same session, same archetype, same name, opened and not
 * yet stopped, and its staged prompt still on disk. Anything looser would hand
 * a caller somebody else's dispatch, and there is no failure worse than two
 * agents believing they own one worktree.
 */
function reusableOpen(repoRoot: string, archetype: string, name: string | null, session: string | null): DispatchOpened | null {
  if (name == null || name.trim().length === 0) return null;
  const wanted = sanitizeName(name.trim());
  for (const record of readDispatches(repoRoot).records) {
    const o = record.opened;
    if (o == null || record.state !== 'open' || record.stopped != null) continue;
    if (o.archetype !== archetype || o.name !== wanted || o.lane !== 'host') continue;
    if (session != null && o.session !== session) continue;
    const staged = hostPromptPath(repoRoot, o.id);
    if (!existsSync(staged)) continue;
    return {
      ok: true,
      opened: true,
      reused: true,
      id: o.id,
      name: o.name,
      archetype: o.archetype,
      model: o.model,
      modelId: o.model_id ?? o.model,
      effort: o.effort,
      harness: o.harness,
      lane: 'host',
      cwd: o.workspace != null ? resolve(repoRoot, o.workspace.path) : repoRoot,
      workspace: o.workspace ?? { path: '.', branch: null, base: 'unknown' },
      shared: o.workspace == null || o.workspace.path === '.',
      sharedReason: null,
      prompt: readFileSync(staged, 'utf8'),
      promptFile: staged,
      contract: '',
      nag: nagText(unclosedDispatches(repoRoot), DEFAULT_UNCLOSED_LIMIT),
    };
  }
  return null;
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
  const ref = opts.ref?.trim() || facts?.dispatchId || null;
  if (ref == null) {
    throw transcriptPath != null
      ? new NotADispatchError(`${transcriptPath} carries no Fadeno dispatch contract; this agent was not a dispatch.`)
      : new DispatchesError('name a dispatch (<name|id>) or pass --transcript <path> so the contract header can name it.');
  }
  const record = lookup(repoRoot, ref);
  if (record.opened == null) throw new DispatchesError(`dispatch ${record.id} has no opened row; nothing to stop.`);
  const assigned = workspaceDir(repoRoot, record.opened);
  const agentCwd = opts.agentCwd?.trim() || null;
  const mismatchedCwd = agentCwd != null && assigned != null && canonical(agentCwd) !== canonical(assigned) ? agentCwd : null;
  if (record.stopped != null) return { record, row: record.stopped, replayed: true, mismatchedCwd };
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
  /** The `--merged` check, when one was made; null for the other three verbs. */
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
  if (!isCloseVerb(opts.verb)) throw new DispatchesError(`close needs exactly one of --merged, --kept, --discarded, --failed; got "${opts.verb}".`);
  const record = lookup(repoRoot, opts.ref);
  const opened = record.opened;
  const branch = opened?.workspace?.branch ?? null;
  const worktree = opened?.workspace != null && opened.workspace.path !== '.' ? opened.workspace.path : null;
  const name = opened?.name ?? record.id.slice(0, 8);

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
  const state = e.state === 'closed' ? `closed: ${e.verb}` : e.state === 'stopped' ? 'stopped — awaiting close' : 'open';
  const where = e.branch ?? (e.shared ? 'shared tree' : '-');
  const route = e.model == null ? '?' : `${e.model}${e.effort ? `@${e.effort}` : ''}${e.harness ? ` on ${e.harness}` : ''}`;
  const dirty = e.dirty == null ? '' : e.dirty === 'unavailable' ? '; tree unreadable' : e.dirty > 0 ? `; ${e.dirty} dirty path(s)` : '';
  const exit = e.exit == null ? '' : e.exit.signal ? `; killed by ${e.exit.signal}` : e.exit.code === 0 ? '' : `; exit ${e.exit.code}`;
  return [
    e.id.slice(0, 8),
    (e.name ?? '?').padEnd(24),
    (e.archetype ?? '?').padEnd(9),
    (e.lane ?? '?').padEnd(7),
    route.padEnd(22),
    where.padEnd(24),
    `${state}${dirty}${exit}`.padEnd(26),
    e.age,
  ].join('  ');
}

/** The column names for `renderDispatchLine`, in the same widths. */
export const DISPATCH_LINE_HEADER = [
  'ID'.padEnd(8),
  'NAME'.padEnd(24),
  'ARCHETYPE'.padEnd(9),
  'LANE'.padEnd(7),
  'ROUTE'.padEnd(22),
  'WHERE'.padEnd(24),
  'STATE'.padEnd(26),
  'AGE',
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
  if (d.record.stopped != null) {
    const s = d.record.stopped;
    const dirty = s.dirty === 'unavailable' ? 'unreadable' : s.dirty.paths.length === 0 ? 'clean' : `${s.dirty.paths.length}${s.dirty.truncated ? '+' : ''} path(s): ${s.dirty.paths.slice(0, 8).join(', ')}`;
    lines.push(`  stopped:   ${s.at}${s.exit ? ` — ${s.exit.signal ? `killed by ${s.exit.signal}` : `exit ${s.exit.code}`}` : ''}; tree ${dirty}`);
    if (s.model_observed != null) {
      const asked = d.record.opened?.model ?? null;
      lines.push(`  ran on:    ${s.model_observed}${modelAgrees(asked, s.model_observed, d.record.opened?.model_id) ? '' : `  (the dial asked for ${asked})`}`);
    }
    // The two halves, labelled. A report is a claim and the measurement is
    // not, and the single most useful thing this view can do is make it
    // impossible to read one and think you read the other.
    lines.push('', '--- what Fadeno measured ---', ...renderWorkMeasured(s.work, d.record.opened?.workspace?.branch ?? null));
    // Ignored paths belong here and not in `tree clean` above: git does not
    // count them, `fadeno clean` deletes them, and a worker's receipts have
    // twice been exactly this.
    if (s.ignored === 'unavailable') lines.push('  ignored paths: unreadable');
    else if (s.ignored != null && s.ignored.paths.length > 0) {
      lines.push(`  ${s.ignored.paths.length}${s.ignored.truncated ? '+' : ''} ignored path(s) in the worktree — \`fadeno clean\` removes these: ${s.ignored.paths.join(', ')}`);
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

// ---------------------------------------------------------------------------
// dispatch-wait — the answer to a harness that caps how long a call may run
// ---------------------------------------------------------------------------

export type WaitOutcome =
  /** One of them stopped (or was already stopped): `text` is its report. */
  | { state: 'stopped'; record: DispatchRecord; text: string | null; waitedMs: number; waiting: DispatchRecord[] }
  /** All still running when the bound elapsed. Ask again; nothing is wrong. */
  | { state: 'running'; record: DispatchRecord; waitedMs: number; waiting: DispatchRecord[] }
  /**
   * One executor's process group is gone and no stop row was ever written, so
   * no amount of waiting will produce one. `captured` is what it left behind,
   * which is usually the whole answer to "did it actually finish".
   */
  | {
      state: 'abandoned';
      record: DispatchRecord;
      stdoutPath: string;
      captured: { bytes: number; work: WorkMeasured | null };
      waitedMs: number;
      waiting: DispatchRecord[];
    };

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
      if (record.stopped != null || record.closed != null || Date.now() >= until) return record;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, until - Date.now()))));
    }
  };

  for (;;) {
    const records = ids.map(reread);
    const running = records.filter((r) => r.stopped == null && r.closed == null);
    const done = records.find((r) => r.stopped != null || r.closed != null);
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
      const others = records.filter((r) => r.id !== settled.id && r.stopped == null && r.closed == null);
      if (settled.stopped != null || settled.closed != null) {
        return { state: 'stopped', record: settled, text: report(settled.id), waitedMs: Date.now() - started, waiting: others };
      }
      const stdoutPath = join(repoRoot, outputPaths(settled.id).stdout);
      return {
        state: 'abandoned',
        record: settled,
        stdoutPath,
        // What it left behind, because "no stop row" and "no work" are
        // different things and the caller has to tell them apart: a worker
        // that ran an hour, committed five times and died before its launcher
        // could append is not a dispatch that produced nothing.
        captured: {
          bytes: existsSync(stdoutPath) ? statSync(stdoutPath).size : 0,
          work: measureWork({ repoRoot, branch: settled.opened?.workspace?.branch ?? null }),
        },
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

export function runContext(opts: CommonOptions & { now?: Date } = {}): { text: string; archetypes: ArchetypeLine[]; preamble: Preamble } {
  const repoRoot = rootOf(opts);
  const { archetypes, profile } = describeArchetypes({ repoRoot, userPathOptions: opts.userPathOptions });
  const unclosed = unclosedDispatches(repoRoot);
  const limit = profile.unclosedLimit ?? DEFAULT_UNCLOSED_LIMIT;
  const preamble = readPreamble(repoRoot);
  return { text: hostVocabulary({ archetypes, unclosed, unclosedLimit: limit, preamble, now: opts.now }), archetypes, preamble };
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
  outputs: string | null;
  /** Staged relay prompts removed, or that would be. */
  relay: string | null;
}

/**
 * Remove worktrees whose dispatch is closed (or unknown to the ledger) and
 * that hold no uncommitted work, plus the command-lane transcripts. Never
 * prompts, never the ledger, never a tree with uncommitted changes.
 */
export function runClean(opts: CommonOptions & { force?: boolean } = {}): CleanResult {
  const repoRoot = rootOf(opts);
  const dryRun = !opts.force;
  const result: CleanResult = { dryRun, worktrees: [], kept: [], outputs: null, relay: null };
  for (const wt of runWorktrees({ repoRoot })) {
    if (wt.dispatch != null && wt.dispatch.state !== 'closed') {
      result.kept.push({ path: wt.path, reason: `dispatch ${wt.dispatch.name ?? wt.dispatch.id.slice(0, 8)} is ${wt.dispatch.state}; close it first` });
      continue;
    }
    if (wt.dirty === 'unavailable') {
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
      ignored: wt.ignored === 'unavailable' ? [] : wt.ignored.paths,
      truncated: wt.ignored !== 'unavailable' && wt.ignored.truncated,
    });
  }
  const outputs = join(repoRoot, OUTPUTS_DIR);
  if (existsSync(outputs)) {
    result.outputs = relative(repoRoot, outputs);
    if (!dryRun) rmSync(outputs, { recursive: true, force: true });
  }
  const relay = join(repoRoot, RELAY_DIR);
  if (existsSync(relay)) {
    result.relay = relative(repoRoot, relay);
    if (!dryRun) rmSync(relay, { recursive: true, force: true });
  }
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
  if (result.outputs != null) lines.push(`${verb} ${result.outputs}/ (command-lane transcripts)`);
  if (result.relay != null) lines.push(`${verb} ${result.relay}/ (staged relay prompts)`);
  for (const k of result.kept) lines.push(`kept ${k.path}: ${k.reason}`);
  if (lines.length === 0) lines.push('Nothing to clean.');
  else if (result.dryRun) lines.push('Re-run with --force to remove. Prompts and the ledger are never touched.');
  return lines;
}

/** Re-exported so the CLI can special-case the wrapper's own refusals. */
export { SpawnError, WORKTREES_DIR };

/**
 * The spawn wrapper (spec §04). Both lanes do the same four things:
 *
 *   1. resolve the archetype to a model and effort;
 *   2. choose the lane — host if the resolved model can be delivered
 *      in-session, command otherwise;
 *   3. cut a worktree on a branch and record its path, branch and base;
 *   4. inject the worker's contract into the prompt and write the opened row.
 *
 * On the host lane a hook drives this through `fadeno dispatch-open` and the
 * harness runs the agent; on the command lane the CLI drives it end to end
 * and also runs the process. `prepareDispatch` is the shared part; the two
 * lanes differ only in who records the opened row and when.
 *
 * The command lane records the process group it launched (decision 34), so
 * `cancel` has something to signal even after the CLI that launched it is
 * gone. The child is put in its own process group for exactly that reason.
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadLayeredProfile } from './config-layers.ts';
import { DEFAULT_UNCLOSED_LIMIT, composeWorkerPrompt, nagText, spawnRefusedByLimit, workerContract } from './contracts.ts';
import {
  BARE_IDENTIFIER_RE,
  ExecutorProfileError,
  parseDialRef,
  readLocalDialState,
  resolveDelivery,
  resolveRole,
  substitutePromptFile,
  withoutHarnessIdentity,
  type CompiledDelivery,
  type DialRef,
  type ExecutorProfile,
  type RoleResolutionSource,
} from './executors.ts';
import {
  appendRow,
  excerptFinalMessage,
  excerptTask,
  newDispatchId,
  nowIso,
  readDispatches,
  unclosedDispatches,
  writePrompt,
  type DispatchRecord,
  type Lane,
  type OpenedRow,
  type StoppedRow,
  type Workspace,
} from './ledger.ts';
import { readUserDials, type UserPathOptions } from './user-paths.ts';
import { cutWorktree, dirtyPaths, existingFadenoBranches, git, sanitizeName, uniqueName } from './worktree.ts';

export class SpawnError extends Error {}

/** The dispatch a process belongs to; a child reads it as its parent. */
export const DISPATCH_ID_ENV = 'FADENO_DISPATCH_ID';
/** Where command-lane transcripts land. Machine-local: `clean` may remove them. */
export const OUTPUTS_DIR = join('.fadeno', 'local', 'outputs');
/** How long `cancel` waits for a signalled group to die before writing the stop itself. */
export const CANCEL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// 1. Resolve
// ---------------------------------------------------------------------------

export interface Resolution {
  archetype: string;
  /** Registry alias, or `current-host`. */
  model: string;
  /** Provider id the harness is handed. */
  modelId: string;
  effort: string | null;
  /** Executor harness the model resolves onto; null for current-host from a bare shell. */
  harness: string | null;
  /** Where this would be delivered from inside a host session. */
  lane: Lane;
  /** The argv that delivers it as a process, or null when nothing can. */
  command: string[] | null;
  source: RoleResolutionSource | 'explicit';
  explicitModel: string | null;
  profile: ExecutorProfile;
  unclosedLimit: number;
}

export interface ResolveInput {
  repoRoot: string;
  archetype: string;
  explicitModel?: string | null;
  userPathOptions?: UserPathOptions;
}

function commandOf(delivery: CompiledDelivery): string[] | null {
  const spec = delivery.spec;
  if (spec.adapter === 'command') return spec.command;
  return spec.fallbackCommand ?? null;
}

/**
 * Resolve an archetype (or an explicit model override) against the layered
 * catalog and the live dials. Routing is live: nothing here is cached.
 */
export function resolveArchetype(input: ResolveInput): Resolution {
  const archetype = input.archetype.trim();
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new SpawnError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
  const layered = (() => {
    try {
      return loadLayeredProfile(input.repoRoot, input.userPathOptions);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new SpawnError(err.message);
      throw err;
    }
  })();
  const profile = layered.profile;
  const host = profile.host ?? 'standalone';
  try {
    let delivery: CompiledDelivery;
    let source: Resolution['source'];
    const explicit = input.explicitModel?.trim() || null;
    if (explicit != null) {
      const ref: DialRef = parseDialRef(explicit, '--model');
      delivery = resolveDelivery(ref, profile, host, { archetype });
      source = 'explicit';
    } else {
      const local = readLocalDialState(input.repoRoot);
      const layers = { session: local.dials, repo: profile.dials, user: readUserDials(input.userPathOptions) as Record<string, DialRef> };
      const resolved = resolveRole(archetype, archetype, profile, layers);
      delivery = resolved.delivery;
      source = resolved.source;
    }
    return {
      archetype,
      model: delivery.model,
      modelId: delivery.modelId,
      effort: delivery.effectiveEffort || null,
      harness: delivery.harness,
      lane: delivery.hostCandidate ? 'host' : 'command',
      command: commandOf(delivery),
      source,
      explicitModel: explicit,
      profile,
      unclosedLimit: profile.unclosedLimit ?? DEFAULT_UNCLOSED_LIMIT,
    };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new SpawnError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 2–4. Prepare: name, worktree, prompt, contract, nag
// ---------------------------------------------------------------------------

export interface PrepareInput {
  repoRoot: string;
  archetype: string;
  /** The caller's prompt — recorded as asked, before any injection. */
  prompt: string;
  name?: string | null;
  explicitModel?: string | null;
  /** Cut from this ref instead of HEAD. */
  from?: string | null;
  /** Work in the shared tree on the caller's explicit request. */
  shared?: boolean;
  session?: string | null;
  /** Defaults to `FADENO_DISPATCH_ID` in the environment: a nested spawn's parent. */
  parent?: string | null;
  /** Which lane will actually deliver this dispatch. */
  lane: Lane;
  userPathOptions?: UserPathOptions;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  resolution?: Resolution;
}

export interface Prepared {
  id: string;
  name: string;
  archetype: string;
  resolution: Resolution;
  workspace: Workspace;
  /** Absolute directory the agent should work in. */
  cwd: string;
  shared: boolean;
  /** Why no worktree was cut, when one was wanted. */
  sharedReason: string | null;
  contract: string;
  /** Caller prompt plus contract, in reading order. */
  composedPrompt: string;
  /** Repo-relative path of the caller's prompt as recorded. */
  promptPath: string;
  /** The reminder the host receives with this spawn. */
  nag: string;
  session: string | null;
  parent: string | null;
  at: string;
  /** The lane that will deliver this dispatch, as the caller declared it. */
  lane: Lane;
}

export type PrepareOutcome = { ok: true; prepared: Prepared } | { ok: false; refused: string };

function shortHex(): string {
  return randomBytes(2).toString('hex');
}

/** Every name the ledger or git already uses, so a fresh one is fresh everywhere. */
export function takenNames(repoRoot: string): Set<string> {
  const taken = existingFadenoBranches(repoRoot);
  for (const record of readDispatches(repoRoot).records) {
    if (record.opened?.name) taken.add(record.opened.name);
  }
  return taken;
}

/**
 * Everything a spawn needs short of writing the row: the nag check, the
 * resolution, a unique name, the worktree (or the shared tree and why), the
 * recorded prompt, and the contract-bearing prompt the agent will read.
 */
export function prepareDispatch(input: PrepareInput): PrepareOutcome {
  const repoRoot = resolve(input.repoRoot);
  const prompt = input.prompt;
  if (prompt.trim().length === 0) throw new SpawnError('empty prompt: nothing to dispatch.');
  const resolution = input.resolution ?? resolveArchetype({
    repoRoot,
    archetype: input.archetype,
    explicitModel: input.explicitModel,
    userPathOptions: input.userPathOptions,
  });
  if (input.lane === 'command' && (resolution.command == null || resolution.command.length === 0)) {
    throw new SpawnError(
      `archetype "${resolution.archetype}" resolves to ${resolution.model} on ${resolution.harness ?? 'no harness'}, which cannot be run as a process from here — ` +
        'there is nothing to invoke. Dial it onto a model with a command lane, or spawn it from inside a host session.',
    );
  }
  const unclosed = unclosedDispatches(repoRoot);
  const refused = spawnRefusedByLimit(unclosed, resolution.unclosedLimit);
  if (refused != null) return { ok: false, refused };

  const base = sanitizeName(input.name?.trim() || `${resolution.archetype}-${shortHex()}`);
  const name = uniqueName(base, takenNames(repoRoot));
  const id = newDispatchId();
  const now = input.now ?? new Date();

  let workspace: Workspace;
  let cwd: string;
  let shared = Boolean(input.shared);
  let sharedReason: string | null = null;
  let contractWorktree: Parameters<typeof workerContract>[0]['worktree'];
  if (!shared) {
    const cut = cutWorktree({ repoRoot, name, from: input.from });
    if (cut.ok) {
      const wt = cut.worktree;
      workspace = { path: wt.path, branch: wt.branch, base: wt.base };
      cwd = wt.absolute;
      contractWorktree = { kind: 'worktree', absolute: wt.absolute, branch: wt.branch, base: wt.base, upstream: wt.upstream };
    } else {
      shared = true;
      sharedReason = cut.reason;
    }
  }
  if (shared) {
    const head = headCommit(repoRoot);
    workspace = { path: '.', branch: null, base: head ?? 'unknown' };
    cwd = repoRoot;
    contractWorktree = { kind: 'shared', reason: sharedReason };
  }

  const contract = workerContract({ id, name, archetype: resolution.archetype, repoRoot, worktree: contractWorktree! });
  const composedPrompt = composeWorkerPrompt(prompt, contract);
  const promptRel = writePrompt(repoRoot, id, prompt);
  const env = input.env ?? process.env;
  const parent = input.parent !== undefined ? input.parent : env[DISPATCH_ID_ENV]?.trim() || null;

  return {
    ok: true,
    prepared: {
      id,
      name,
      archetype: resolution.archetype,
      resolution,
      workspace: workspace!,
      cwd: cwd!,
      shared,
      sharedReason,
      contract,
      composedPrompt,
      promptPath: promptRel,
      nag: nagText(unclosed, resolution.unclosedLimit, now),
      session: input.session ?? null,
      parent,
      at: nowIso(now),
      lane: input.lane,
    },
  };
}

function headCommit(repoRoot: string): string | null {
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  return head.ok ? head.stdout.trim() : null;
}

/** Write the opened row. The command lane passes the process group it just launched. */
export function recordOpened(repoRoot: string, prepared: Prepared, extra: { lane?: Lane; processGroup?: number | null; harness?: string | null } = {}): OpenedRow {
  const { task, truncated } = excerptTask(readFileSync(join(repoRoot, prepared.promptPath), 'utf8'));
  const row: OpenedRow = {
    row: 'opened',
    id: prepared.id,
    name: prepared.name,
    at: prepared.at,
    session: prepared.session,
    parent: prepared.parent,
    archetype: prepared.archetype,
    model: prepared.resolution.model,
    effort: prepared.resolution.effort,
    explicit_model: prepared.resolution.explicitModel,
    lane: extra.lane ?? prepared.lane,
    harness: extra.harness !== undefined ? extra.harness : prepared.resolution.harness,
    workspace: prepared.workspace,
    task,
    ...(truncated ? { task_truncated: true as const } : {}),
    prompt: prepared.promptPath,
    ...(extra.processGroup != null ? { process_group: extra.processGroup } : {}),
  };
  appendRow(repoRoot, row);
  return row;
}

/** The outside observation: what the agent said last and what its tree holds. */
export function recordStopped(
  repoRoot: string,
  id: string,
  input: { finalMessage: string | null; cwd: string | null; exit?: { code: number | null; signal: string | null }; now?: Date },
): StoppedRow {
  const dirty = input.cwd != null && existsSync(input.cwd) ? dirtyPaths(input.cwd) : 'unavailable';
  const row: StoppedRow = {
    row: 'stopped',
    id,
    at: nowIso(input.now),
    final_message: excerptFinalMessage(input.finalMessage),
    dirty,
    cwd: input.cwd,
    ...(input.exit != null ? { exit: input.exit } : {}),
  };
  appendRow(repoRoot, row);
  return row;
}

// ---------------------------------------------------------------------------
// The command lane: run the process, record the group, wait, record the stop
// ---------------------------------------------------------------------------

export interface RunInput {
  repoRoot: string;
  prepared: Prepared;
  env?: NodeJS.ProcessEnv;
  onEcho?: (line: string) => void;
  /** Heartbeat interval for the "still running" echo; 0 disables. */
  heartbeatMs?: number;
}

export interface RunResult {
  id: string;
  name: string;
  exitCode: number | null;
  signal: string | null;
  /** Everything the executor wrote to stdout — its report. */
  stdout: string;
  /** Repo-relative transcript paths. */
  stdoutPath: string;
  stderrPath: string;
  stderrBytes: number;
  processGroup: number;
  opened: OpenedRow;
  stopped: StoppedRow;
}

export function outputPaths(id: string): { stdout: string; stderr: string; prompt: string } {
  return {
    stdout: join(OUTPUTS_DIR, `${id}.md`),
    stderr: join(OUTPUTS_DIR, `${id}.err`),
    prompt: join(OUTPUTS_DIR, `${id}.prompt.md`),
  };
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Launch the executor for a prepared dispatch in its worktree, in its own
 * process group, with the composed prompt on stdin (or at `{prompt_file}`),
 * both streams captured to disk. The opened row is written the moment the
 * group exists; the stopped row when it exits. A SIGTERM or SIGINT to this
 * process is forwarded to the whole group so a killed CLI does not orphan
 * its executor.
 */
export function runCommandDispatch(input: RunInput): Promise<RunResult> {
  const { repoRoot, prepared } = input;
  const command = prepared.resolution.command;
  if (command == null || command.length === 0) {
    throw new SpawnError(`dispatch ${prepared.name} was prepared for the host lane; it has no command to run.`);
  }
  const paths = outputPaths(prepared.id);
  const stdoutAbs = join(repoRoot, paths.stdout);
  const stderrAbs = join(repoRoot, paths.stderr);
  const promptAbs = join(repoRoot, paths.prompt);
  mkdirSync(dirname(stdoutAbs), { recursive: true });
  writeFileSync(promptAbs, prepared.composedPrompt);
  const argv = substitutePromptFile(command, promptAbs);
  const readsFile = argv.join(' ') !== command.join(' ');

  const env: NodeJS.ProcessEnv = {
    ...withoutHarnessIdentity(input.env ?? process.env),
    PWD: prepared.cwd,
    [DISPATCH_ID_ENV]: prepared.id,
  };
  const outFd = openSync(stdoutAbs, 'w');
  const errFd = openSync(stderrAbs, 'w');
  const startedAt = Date.now();

  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: prepared.cwd,
        env,
        detached: true,
        stdio: [readsFile ? 'ignore' : 'pipe', outFd, errFd],
      });
    } catch (err) {
      closeSync(outFd);
      closeSync(errFd);
      rejectPromise(new SpawnError(`could not start ${argv[0]}: ${(err as Error).message}`));
      return;
    }
    let spawnFailure: Error | null = null;
    child.once('error', (err) => {
      spawnFailure = err;
    });
    child.once('spawn', () => {
      const pgid = child.pid!;
      const opened = recordOpened(repoRoot, prepared, { lane: 'command', processGroup: pgid });
      input.onEcho?.(`dispatch ${prepared.name} (${prepared.id}) → ${prepared.resolution.model} on ${prepared.resolution.harness ?? '?'}; process group ${pgid}; ${prepared.shared ? 'shared tree' : prepared.workspace.branch}`);
      const forward = (signal: NodeJS.Signals) => {
        try {
          process.kill(-pgid, signal);
        } catch {
          /* already gone */
        }
      };
      const onTerm = () => forward('SIGTERM');
      process.on('SIGTERM', onTerm);
      process.on('SIGINT', onTerm);
      const heartbeat = input.heartbeatMs && input.heartbeatMs > 0
        ? setInterval(() => input.onEcho?.(`dispatch ${prepared.name}: still running (${formatElapsed(Date.now() - startedAt)})`), input.heartbeatMs)
        : null;
      if (!readsFile && child.stdin != null) {
        child.stdin.on('error', () => {
          /* executor closed stdin early; its exit says why */
        });
        child.stdin.end(prepared.composedPrompt);
      }
      child.once('close', (code, signal) => {
        if (heartbeat != null) clearInterval(heartbeat);
        process.off('SIGTERM', onTerm);
        process.off('SIGINT', onTerm);
        closeSync(outFd);
        closeSync(errFd);
        const stdout = readFileSync(stdoutAbs, 'utf8');
        const stderrBytes = (() => {
          try {
            return readFileSync(stderrAbs).length;
          } catch {
            return 0;
          }
        })();
        const stopped = recordStopped(repoRoot, prepared.id, {
          finalMessage: stdout.trim().length > 0 ? stdout : null,
          cwd: prepared.cwd,
          exit: { code, signal },
        });
        resolvePromise({
          id: prepared.id,
          name: prepared.name,
          exitCode: code,
          signal,
          stdout,
          stdoutPath: paths.stdout,
          stderrPath: paths.stderr,
          stderrBytes,
          processGroup: pgid,
          opened,
          stopped,
        });
      });
    });
    // `error` before `spawn` means the executable could not be started at all.
    setImmediate(() => {
      if (spawnFailure != null && child.pid == null) {
        closeSync(outFd);
        closeSync(errFd);
        rejectPromise(new SpawnError(`could not start ${argv[0]}: ${spawnFailure.message}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Cancel (decision 34)
// ---------------------------------------------------------------------------

export type CancelOutcome =
  | { ok: true; processGroup: number; signalled: true; stoppedRecorded: boolean }
  | { ok: false; reason: 'host_lane' | 'no_process' | 'not_running' | 'closed'; message: string };

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stop a running command-lane dispatch by signalling its process group. A
 * host-lane dispatch is refused: the subagent belongs to the harness. Writes
 * a stopped row only if the launching CLI did not get there first.
 */
export async function cancelDispatch(
  repoRoot: string,
  record: DispatchRecord,
  opts: { signal?: NodeJS.Signals; graceMs?: number; now?: Date } = {},
): Promise<CancelOutcome> {
  const opened = record.opened;
  if (opened == null) return { ok: false, reason: 'no_process', message: `dispatch ${record.id} has no opened row to cancel.` };
  if (record.closed != null) return { ok: false, reason: 'closed', message: `dispatch ${opened.name} is already closed (${record.closed.verb}).` };
  if (opened.lane === 'host' || opened.process_group == null) {
    return {
      ok: false,
      reason: 'host_lane',
      message: `dispatch ${opened.name} runs inside a host session; it is the harness's to stop. Cancel it there, then close it with \`fadeno dispatch-close ${opened.name} --failed\`.`,
    };
  }
  const pgid = opened.process_group;
  if (record.stopped != null || !groupAlive(pgid)) {
    return {
      ok: false,
      reason: 'not_running',
      message: `dispatch ${opened.name} is not running (process group ${pgid} is gone${record.stopped ? '; it stopped at ' + record.stopped.at : ''}). Close it with \`fadeno dispatch-close ${opened.name} --failed|--kept|--discarded\`.`,
    };
  }
  try {
    process.kill(-pgid, opts.signal ?? 'SIGTERM');
  } catch (err) {
    return { ok: false, reason: 'not_running', message: `could not signal process group ${pgid}: ${(err as Error).message}` };
  }
  const deadline = Date.now() + (opts.graceMs ?? CANCEL_GRACE_MS);
  while (Date.now() < deadline && groupAlive(pgid)) await sleep(100);
  // The launching CLI writes the stop when the child exits. If it is gone too,
  // nobody will, so say what happened here.
  const fresh = readDispatches(repoRoot).records.find((r) => r.id === record.id);
  let stoppedRecorded = false;
  if (fresh?.stopped == null) {
    const cwd = opened.workspace != null ? (opened.workspace.path === '.' ? repoRoot : join(repoRoot, opened.workspace.path)) : null;
    recordStopped(repoRoot, record.id, {
      finalMessage: null,
      cwd,
      exit: { code: null, signal: opts.signal ?? 'SIGTERM' },
      now: opts.now,
    });
    stoppedRecorded = true;
  }
  return { ok: true, processGroup: pgid, signalled: true, stoppedRecorded };
}

/** Absolute working directory a dispatch was given, from its row. */
export function workspaceDir(repoRoot: string, opened: OpenedRow): string | null {
  if (opened.workspace == null) return null;
  const path = opened.workspace.path;
  return path === '.' ? resolve(repoRoot) : isAbsolute(path) ? path : join(repoRoot, path);
}

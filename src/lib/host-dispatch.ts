import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { buildArtifactManifest, sha256Hex } from './artifact-manifest.ts';
import { snapshotExecutor } from './executors.ts';
import { SchemaSet, schemaErrorMessages, type SchemaKind } from './playbook-validate.ts';
import { extractSchemaEnvelope, type EnvelopeExtraction } from './schema-envelope.ts';
import { runSchemaDirectories } from './definitions.ts';
import { findRepoRoot } from './paths.ts';
import {
  captureOverlapSnapshot,
  changedBetween,
  closeDispatchWindow,
  detectConcurrentWrites,
  diffChangedPaths,
  discardOverlapSnapshot,
  openDispatchWindow,
  readDispatchWindows,
  readOverlapSnapshot,
  workspaceStatusMap,
  type ConcurrentWriteStamp,
} from './workspace-overlap.ts';
import { readEventsStrict, resolveRun, RUN_LEDGER_SCHEMA_VERSION, RunLedgerError, type RunEvent } from './run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from './run-ledger-write.ts';
import { parseSnapshotDocument, type SnapshotDocument } from './executors.ts';
import { collectHostWorkspaceDiff, collectIsolatedRecoveryDiff, HostWorkspaceError, hostIsolatedDiffPath, hostWorkspaceIgnoredOutput, hostWorktreePath, isHostPathSafe, readHostWorkspaceState, removeHostWorkspace, removeHostWorkspaceByPath, type HostWorkspaceState } from './host-workspace.ts';
import { isRegisteredWorktree, type IgnoredOutputStamp } from './workspace-isolation.ts';

export const DUPLICATE_START = 'duplicate_start' as const;
export type HostDispatchErrorCode = typeof DUPLICATE_START;

export class HostDispatchError extends Error {
  code?: HostDispatchErrorCode;
  constructor(message: string, opts?: { code?: HostDispatchErrorCode }) {
    super(message);
    if (opts?.code != null) this.code = opts.code;
  }
}

export function isDuplicateStartError(err: unknown): boolean {
  return err instanceof HostDispatchError && err.code === DUPLICATE_START;
}

export interface HostDispatchRequest {
  dispatchId: string;
  run: string;
  step: string;
  actor: string | null;
  stepExecutionId: string;
  actorCallId: string;
  attempt: number;
  attemptReason: string;
  executor: string;
  model: string;
  reasoningEffort: string;
  agentType: string;
  promptPath: string;
  promptSha256: string;
  outputPath: string;
  artifactType: SchemaKind | null;
  /** Hierarchical execution identity for compositional playbooks. */
  nodeInstanceId?: string;
  parentInstanceId?: string;
  mapMember?: string;
  generation?: number;
  logicalArtifact?: string;
  /** Immutable feedback from the prior rejected attempt, for schema repair. */
  validationErrors?: string[];
  repairAppendix?: string;
}

export interface HostDispatchReceipt {
  dispatchId: string;
  state: 'requested' | 'started' | 'completed' | 'failed';
  idempotent: boolean;
  agentId?: string;
  outputPath?: string;
  outputSha256?: string;
}

/** Every state a minted host request can be observed in, most terminal first. */
export type HostRequestState = 'requested' | 'started' | 'completed' | 'failed' | 'withdrawn';

/**
 * The ONE list of terminal receipt types, most terminal first. Every consumer
 * that asks "is this request over?" reads it through `terminalsFor` or
 * `hostRequestTerminalState` below; a private copy of the list somewhere else
 * is how a new receipt (the withdraw) ends up terminal in most of the codebase
 * and invisible in the one caller that spelled it out for itself.
 */
const TERMINAL_RECEIPTS: ReadonlyArray<{ type: string; state: HostRequestState }> = [
  { type: 'actor_completed', state: 'completed' },
  { type: 'actor_failed', state: 'failed' },
  { type: 'host_dispatch_withdrawn', state: 'withdrawn' },
];

/**
 * The single reading of "what happened to this request", for every consumer
 * that renders or reasons about one (`show`, `dispatch-prepare`, and the
 * withdraw preconditions).
 *
 * Precedence is terminal-receipt first and `started` last on purpose: a ledger
 * carrying BOTH a withdraw and a start is corrupt, and the honest render of a
 * corrupt pair is the terminal receipt, not the start that should never have
 * followed it. `verify`'s `host-dispatch-lifecycle` is what reports the
 * corruption; this function's job is to never hide it behind `started`.
 */
export function hostRequestTerminalState(events: RunEvent[], dispatchId: string): HostRequestState {
  const mine = events.filter((event) => event.extra.dispatch_id === dispatchId);
  for (const receipt of TERMINAL_RECEIPTS) {
    if (mine.some((event) => event.type === receipt.type)) return receipt.state;
  }
  if (mine.some((event) => event.type === 'actor_dispatched')) return 'started';
  return 'requested';
}

export type DispatchProgressState = 'running' | 'waiting_input' | 'blocked' | 'idle';
export type DispatchProgressSource = 'agent' | 'harness' | 'director';

export interface DispatchProgressReport {
  state: DispatchProgressState;
  phase?: string;
  summary?: string;
  completed?: string[];
  current?: string;
  next?: string;
  blockers?: string[];
  updatedAt?: string;
}

export interface HostDispatchProgressReceipt {
  dispatchId: string;
  state: DispatchProgressState;
  source: DispatchProgressSource;
  idempotent: boolean;
  reportSha256: string;
}

export interface HostDispatchRequestOptions extends HostDispatchRequest {
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

/** Read one immutable engine request and its current receipt state. */
export interface HostDispatchRequestLookup {
  runId: string;
  runDir: string;
  events: RunEvent[];
  event: RunEvent;
  request: HostDispatchRequest;
  terminal: RunEvent | null;
}

/** Re-read and authenticate the immutable executor profile pinned to a run. */
export function hostRequestProfile(lookup: HostDispatchRequestLookup): SnapshotDocument {
  const snapshots = lookup.events.filter((event) => event.type === 'profile_snapshotted');
  if (snapshots.length !== 1) {
    throw new HostDispatchError(
      `run "${lookup.runId}" must contain exactly one profile_snapshotted event; found ${snapshots.length}.`,
    );
  }
  const snapshot = snapshots[0]!;
  const profileRel = typeof snapshot.extra.profile === 'string' && snapshot.extra.profile.length > 0
    ? snapshot.extra.profile
    : 'profile.yaml';
  const runAbsolute = resolve(lookup.runDir);
  const profilePath = isAbsolute(profileRel) ? resolve(profileRel) : resolve(runAbsolute, profileRel);
  const profileRelative = relative(runAbsolute, profilePath).split('\\').join('/');
  if (profileRelative === '' || profileRelative === '..' || profileRelative.startsWith('../') || isAbsolute(profileRelative)) {
    throw new HostDispatchError(`run "${lookup.runId}" profile snapshot escapes the run directory: ${profileRel}`);
  }
  if (!existsSync(profilePath)) throw new HostDispatchError(`run "${lookup.runId}" profile snapshot is missing: ${profileRel}`);
  const profileRealRelative = relative(realpathSync(runAbsolute), realpathSync(profilePath)).split('\\').join('/');
  if (profileRealRelative === '..' || profileRealRelative.startsWith('../') || isAbsolute(profileRealRelative)) {
    throw new HostDispatchError(`run "${lookup.runId}" profile snapshot escapes the run directory through a symlink: ${profileRel}`);
  }
  const text = readFileSync(profilePath, 'utf8');
  const digest = snapshot.extra.sha256;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new HostDispatchError(`run "${lookup.runId}" profile snapshot is missing or has an invalid sha256 digest.`);
  }
  if (digest !== sha256Hex(text)) {
    throw new HostDispatchError(`run "${lookup.runId}" profile snapshot digest does not match its recorded sha256.`);
  }
  return parseSnapshotDocument(text, `${profileRel} (run snapshot)`);
}

/**
 * How a host dispatch was delivered. `host` is the in-session agent; a
 * `command-fallback` ran the executor's declared argv instead.
 */
export type DeliveryTransport = 'host' | 'command-fallback';

/**
 * Read a `delivery_transport` from a ledger, accepting the pre-0.6 spelling.
 *
 * Writers only ever emit `host`, but traces recorded before the rename carry
 * `native` for the identical fact and must keep verifying untouched — the
 * ledger format is unchanged, so nothing about them became invalid. Absent is
 * `host` for the same reason it always was: it predates the field. Returns
 * null for a value that is neither, so a corrupt trace still fails loudly
 * instead of being coerced into a transport it never recorded.
 */
export function normalizeDeliveryTransport(value: unknown): DeliveryTransport | null {
  if (value == null || value === 'host' || value === 'native') return 'host';
  if (value === 'command-fallback') return 'command-fallback';
  return null;
}

export function hostDeliveryWorkspaceMode(start: RunEvent): 'shared' | 'isolated' {
  return start.extra.workspace_mode === 'isolated' ? 'isolated' : 'shared';
}

export interface DispatchStartOptions {
  run: string;
  dispatchId: string;
  agentId: string;
  workspace?: string;
  branch?: string;
  transport?: DeliveryTransport;
  /** Exact argv used only for command-fallback delivery evidence. */
  command?: string[];
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

export interface DispatchCompleteOptions {
  run: string;
  dispatchId: string;
  output: string;
  commit?: string;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
  /** When `output` is `-`, optional injected stdin bytes (test seam). */
  stdinBytes?: Buffer;
}

export interface DispatchFailOptions {
  run: string;
  dispatchId: string;
  reason: string;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

export interface DispatchWithdrawOptions {
  run: string;
  dispatchId: string;
  reason: string;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

export interface HostDispatchWithdrawReceipt {
  dispatchId: string;
  state: 'withdrawn';
  idempotent: boolean;
  reason: string;
  /** True when a prepared isolated workspace existed and is now gone. */
  workspaceRemoved: boolean;
  /** Non-null when a prepared workspace survived removal; names the leftover path. */
  workspaceError: string | null;
}

export interface DispatchProgressOptions {
  run: string;
  dispatchId: string;
  file: string;
  source?: DispatchProgressSource;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

const PROGRESS_STATES = new Set<DispatchProgressState>(['running', 'waiting_input', 'blocked', 'idle']);
const PROGRESS_SOURCES = new Set<DispatchProgressSource>(['agent', 'harness', 'director']);
const MAX_PROGRESS_BYTES = 64 * 1024;

function parseProgressReport(bytes: Buffer): DispatchProgressReport {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new HostDispatchError(`progress report is not valid JSON: ${(err as Error).message}`);
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostDispatchError('progress report must be a JSON object.');
  }
  const doc = value as Record<string, unknown>;
  const allowed = new Set(['state', 'phase', 'summary', 'completed', 'current', 'next', 'blockers', 'updated_at']);
  const unknown = Object.keys(doc).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new HostDispatchError(`progress report has unknown field(s): ${unknown.join(', ')}.`);
  // Common host-agent variants are normalized at this non-gating boundary;
  // the ledger still records the canonical vocabulary.
  const state = doc.state === 'in_progress' ? 'running' : doc.state;
  if (typeof state !== 'string' || !PROGRESS_STATES.has(state as DispatchProgressState)) {
    throw new HostDispatchError(`progress report state must be one of: ${[...PROGRESS_STATES].join(', ')}.`);
  }
  const optionalString = (key: string, max: number): string | undefined => {
    const item = doc[key];
    if (item === undefined) return undefined;
    if (typeof item !== 'string' || item.trim() === '') throw new HostDispatchError(`progress report ${key} must be a non-empty string.`);
    if (item.length > max) throw new HostDispatchError(`progress report ${key} exceeds ${max} characters.`);
    return item;
  };
  const optionalStrings = (key: string): string[] | undefined => {
    const item = doc[key];
    if (item === undefined) return undefined;
    const items = typeof item === 'string' ? [item] : item;
    if (!Array.isArray(items) || items.some((entry) => typeof entry !== 'string' || entry.trim() === '' || entry.length > 500)) {
      throw new HostDispatchError(`progress report ${key} must be an array of non-empty strings up to 500 characters.`);
    }
    if (items.length > 50) throw new HostDispatchError(`progress report ${key} exceeds 50 entries.`);
    return items as string[];
  };
  const updatedAt = optionalString('updated_at', 100);
  if (updatedAt != null && Number.isNaN(Date.parse(updatedAt))) {
    throw new HostDispatchError('progress report updated_at must be an ISO-compatible timestamp.');
  }
  const phase = optionalString('phase', 200);
  const summary = optionalString('summary', 2_000);
  const completed = optionalStrings('completed');
  const current = optionalString('current', 1_000);
  const next = optionalString('next', 1_000);
  const blockers = optionalStrings('blockers');
  return {
    state: state as DispatchProgressState,
    ...(phase != null ? { phase } : {}),
    ...(summary != null ? { summary } : {}),
    ...(completed != null ? { completed } : {}),
    ...(current != null ? { current } : {}),
    ...(next != null ? { next } : {}),
    ...(blockers != null ? { blockers } : {}),
    ...(updatedAt != null ? { updatedAt } : {}),
  };
}

/**
 * The statuses `fadeno run --status` treats as final. Duplicated from
 * `run.ts` rather than imported: that module's set is private, and importing
 * a command module from a lib module is the wrong direction of dependency.
 */
const RUN_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted']);

function assertCurrentLedger(repoRoot: string, runQuery: string): { runDir: string; runId: string; status: string | null } {
  let run;
  try {
    run = resolveRun(repoRoot, runQuery);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new HostDispatchError(err.message);
    throw err;
  }
  if (run.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new HostDispatchError(
      run.schemaVersion == null
        ? `run "${run.runId}" is a legacy ledger; host dispatch writes only ${RUN_LEDGER_SCHEMA_VERSION} ledgers.`
        : `run "${run.runId}" has ledger schema_version "${run.schemaVersion}"; host dispatch writes only ${RUN_LEDGER_SCHEMA_VERSION}.`,
    );
  }
  return { runDir: run.dir, runId: run.runId, status: run.status };
}

function eventsFor(runDir: string): RunEvent[] {
  try {
    return readEventsStrict(runDir);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new HostDispatchError(err.message);
    throw err;
  }
}

function append(runDir: string, event: Record<string, unknown>, now?: Date): void {
  try {
    new LedgerWriter(runDir).append(event, now ?? new Date());
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new HostDispatchError(err.message);
    throw err;
  }
}

/**
 * What a run-scoped host receipt must say about the worktree it is about to
 * tear down.
 *
 * Every terminal receipt on this lane is followed by a `removeHostWorkspace`,
 * and that call now refuses when the directory holds gitignored content the
 * diff could not carry (see `removeHostWorkspaceByPath`). Without this, the
 * refusal would be invisible: the row would name a `workspace` it believed
 * gone, no field would say the content existed, and worktrees would pile up
 * under `.fadeno/local/host/` with nothing anywhere explaining why. Silent
 * retention is the same failure as silent deletion with the polarity flipped
 * — in both, the ledger and the disk disagree.
 *
 * Read-only and taken BEFORE the append, deliberately. The receipt is written
 * first and the teardown attempted after, exactly as before, so nothing about
 * the crash window changes: a process that dies between them leaves a
 * worktree and a row that describes it, which is the recoverable direction.
 * The teardown re-scans for itself rather than trusting this verdict — what
 * it deletes is decided by what it saw.
 *
 * Never throws: a receipt is a fact, and a scan that can fail the append
 * would be the one thing on this path able to turn a completed delivery into
 * an error.
 */
function hostTeardownFields(repoRoot: string, state: HostWorkspaceState): Record<string, unknown> {
  let stamp: IgnoredOutputStamp | null;
  try {
    stamp = hostWorkspaceIgnoredOutput(repoRoot, state.workspace);
  } catch {
    return {};
  }
  if (stamp == null) return {};
  return { ignored_output_discarded: stamp, workspace_retained: true };
}

function requestFromEvent(run: string, event: RunEvent): HostDispatchRequest {
  if (event.extra.adapter !== 'host') {
    throw new HostDispatchError(`host dispatch request is not marked with adapter: host.`);
  }
  const stringField = (key: string): string => {
    const value = event.extra[key];
    if (typeof value !== 'string' || value.length === 0) throw new HostDispatchError(`host dispatch request is missing ${key}.`);
    return value;
  };
  const attempt = event.extra.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new HostDispatchError(`host dispatch request ${stringField('dispatch_id')} has an invalid attempt.`);
  }
  const effort = stringField('reasoning_effort');
  const agentType = stringField('agent_type');
  const artifactType = event.extra.artifact_type;
  const validationErrors = Array.isArray(event.extra.validation_errors)
    ? event.extra.validation_errors.filter((error): error is string => typeof error === 'string')
    : undefined;
  const repairAppendix = typeof event.extra.repair_appendix === 'string' ? event.extra.repair_appendix : undefined;
  return {
    dispatchId: stringField('dispatch_id'),
    run,
    step: event.step ?? stringField('step'),
    actor: typeof event.extra.actor === 'string' ? event.extra.actor : null,
    stepExecutionId: stringField('step_execution_id'),
    actorCallId: stringField('actor_call_id'),
    attempt,
    attemptReason: typeof event.extra.attempt_reason === 'string' ? event.extra.attempt_reason : 'initial',
    executor: stringField('executor'),
    model: stringField('model'),
    reasoningEffort: effort,
    agentType,
    promptPath: stringField('prompt_path'),
    promptSha256: stringField('prompt_sha256'),
    outputPath: stringField('output_path'),
    artifactType: typeof artifactType === 'string' ? artifactType as SchemaKind : null,
    ...(typeof event.extra.node_instance_id === 'string' ? { nodeInstanceId: event.extra.node_instance_id } : {}),
    ...(typeof event.extra.parent_instance_id === 'string' ? { parentInstanceId: event.extra.parent_instance_id } : {}),
    ...(typeof event.extra.map_member === 'string' ? { mapMember: event.extra.map_member } : {}),
    ...(typeof event.extra.generation === 'number' ? { generation: event.extra.generation } : {}),
    ...(typeof event.extra.logical_artifact === 'string' ? { logicalArtifact: event.extra.logical_artifact } : {}),
    ...(validationErrors != null ? { validationErrors } : {}),
    ...(repairAppendix != null ? { repairAppendix } : {}),
  };
}

function findRequest(run: string, events: RunEvent[], dispatchId: string): { request: HostDispatchRequest; event: RunEvent } {
  const matches = events.filter((event) => event.type === 'host_dispatch_requested' && event.extra.dispatch_id === dispatchId);
  if (matches.length === 0) throw new HostDispatchError(`No host dispatch request "${dispatchId}" for run "${run}".`);
  if (matches.length > 1) throw new HostDispatchError(`host dispatch "${dispatchId}" was requested more than once.`);
  return { request: requestFromEvent(run, matches[0]!), event: matches[0]! };
}

function startsFor(events: RunEvent[], dispatchId: string): RunEvent[] {
  return events.filter((event) => event.type === 'actor_dispatched' && event.extra.dispatch_id === dispatchId);
}

/**
 * Every TERMINAL receipt for a dispatch — a withdraw among them.
 *
 * One list, every guard: `startHostDispatch`, `completeHostDispatch`,
 * `failHostDispatch` and `readHostDispatchRequest` (and through it steering's
 * live delivery and the command-fallback replay) all ask this one question,
 * so making withdraw terminal HERE is what makes it terminal everywhere
 * instead of in the one caller that remembered to ask.
 */
function terminalsFor(events: RunEvent[], dispatchId: string): RunEvent[] {
  return events.filter(
    (event) => TERMINAL_RECEIPTS.some((receipt) => receipt.type === event.type) && event.extra.dispatch_id === dispatchId,
  );
}

/** Withdraw receipts only, for the withdraw preconditions' idempotency check. */
function withdrawalsFor(events: RunEvent[], dispatchId: string): RunEvent[] {
  return events.filter((event) => event.type === 'host_dispatch_withdrawn' && event.extra.dispatch_id === dispatchId);
}

/**
 * Resolve a request by its run/dispatch identity without consulting any live
 * executor profile or ambient loadout. This is the read-only counterpart to
 * the receipt writers and is used by engine-delivered host agents.
 */
export function readHostDispatchRequest(opts: {
  run: string;
  dispatchId: string;
  repoRoot?: string;
  cwd?: string;
}): HostDispatchRequestLookup {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  const events = eventsFor(runDir);
  const { request, event } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length > 1) {
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was started more than once.`, { code: DUPLICATE_START });
  }
  const terminals = terminalsFor(events, opts.dispatchId);
  if (terminals.length > 1) {
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" has multiple terminal receipts.`);
  }
  return { runId, runDir, events, event, request, terminal: terminals[0] ?? null };
}


interface IsolatedEvidence {
  state: HostWorkspaceState | null;
  stateMalformed: boolean;
  workspaceRel: string | null;
  ledgerWorkspace: string | null;
  ledgerBaseCommit: string | null;
  worktreeVerified: boolean;
  diffRel: string;
  hasDiff: boolean;
}

type IsolatedCollected = { state: HostWorkspaceState; diffSnapshot: string; diffBytes: number };
type IsolatedCompleteOutcome = { kind: 'collected'; collected: IsolatedCollected };
type IsolatedFailOutcome =
  | { kind: 'collected'; collected: IsolatedCollected }
  | { kind: 'degraded'; workspace: string | null; baseCommit: string | null };

function isValidBaseCommit(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function validateLedgerWorkspacePath(repoRoot: string, raw: string): string | null {
  return isHostPathSafe(repoRoot, raw) ? raw : null;
}

/**
 * Shared isolated-evidence inspection: validates ledger workspace/base_commit
 * only after safe-path checks, proves the directory is this dispatch's exact
 * registered worktree, and reports whether durable diff evidence exists.
 * Never throws on missing/malformed state (reports state=null).
 */
function inspectIsolatedEvidence(opts: { repoRoot: string; runId: string; dispatchId: string; start: RunEvent }): IsolatedEvidence {
  const { repoRoot, runId, dispatchId, start } = opts;
  let state: HostWorkspaceState | null = null;
  let stateMalformed = false;
  try {
    state = readHostWorkspaceState(repoRoot, runId, dispatchId);
  } catch (err) {
    if (err instanceof HostWorkspaceError) {
      state = null;
      stateMalformed = true;
    } else {
      throw err;
    }
  }
  const expectedRel = hostWorktreePath(runId, dispatchId);
  let ledgerWorkspace: string | null = null;
  const rawWorkspace = (start.extra as unknown as Record<string, unknown>).workspace;
  if (typeof rawWorkspace === 'string') {
    const validated = validateLedgerWorkspacePath(repoRoot, rawWorkspace);
    if (validated != null) {
      // Require ledger path to name this dispatch's canonical worktree; otherwise drop it.
      let matchesExpected = validated === expectedRel;
      if (!matchesExpected) {
        try {
          const expectedAbs = resolve(repoRoot, expectedRel);
          const candidateAbs = resolve(repoRoot, validated);
          try {
            matchesExpected = realpathSync(expectedAbs) === realpathSync(candidateAbs);
          } catch {
            matchesExpected = false;
          }
        } catch {
          matchesExpected = false;
        }
      }
      if (matchesExpected) ledgerWorkspace = validated;
      else ledgerWorkspace = null;
    }
  }
  // Validate state workspace safety and canonical identity; mismatched state is treated as malformed.
  if (state != null) {
    if (!isHostPathSafe(repoRoot, state.workspace)) {
      state = null;
      stateMalformed = true;
    } else {
      let stateMatchesExpected = state.workspace === expectedRel;
      if (!stateMatchesExpected) {
        try {
          const expectedAbs = resolve(repoRoot, expectedRel);
          const stateAbs = resolve(repoRoot, state.workspace);
          try {
            stateMatchesExpected = realpathSync(expectedAbs) === realpathSync(stateAbs);
          } catch {
            stateMatchesExpected = false;
          }
        } catch {
          stateMatchesExpected = false;
        }
      }
      if (!stateMatchesExpected) {
        state = null;
        stateMalformed = true;
      }
    }
  }
  let ledgerBaseCommit: string | null = null;
  const rawBase = (start.extra as unknown as Record<string, unknown>).base_commit;
  if (isValidBaseCommit(rawBase)) ledgerBaseCommit = rawBase as string;
  const workspaceRel = state?.workspace ?? ledgerWorkspace;
  let worktreeVerified = false;
  if (workspaceRel != null) {
    try {
      const abs = resolve(repoRoot, workspaceRel);
      worktreeVerified = isRegisteredWorktree(repoRoot, abs);
    } catch {
      worktreeVerified = false;
    }
  }
  let diffRel: string;
  if (state?.diff_snapshot != null) diffRel = state.diff_snapshot;
  else diffRel = hostIsolatedDiffPath(runId, dispatchId);
  let hasDiff = false;
  if (state?.diff_snapshot != null && state?.diff_bytes != null) {
    try {
      const diffAbs = resolve(repoRoot, state.diff_snapshot);
      hasDiff = existsSync(diffAbs);
    } catch { hasDiff = false; }
  } else {
    // When state is absent or has no snapshot, a durable diff at the canonical path also counts as evidence.
    try {
      const canonicalRel = hostIsolatedDiffPath(runId, dispatchId);
      const canonicalAbs = resolve(repoRoot, canonicalRel);
      // Only consider canonical diff evidence when it is safe and exists.
      if (isHostPathSafe(repoRoot, canonicalRel) && existsSync(canonicalAbs)) hasDiff = true;
    } catch { hasDiff = false; }
  }
  return { state, stateMalformed, workspaceRel, ledgerWorkspace, ledgerBaseCommit, worktreeVerified, diffRel, hasDiff };
}

function settleIsolatedTerminalWorkspace(opts: { repoRoot: string; runId: string; dispatchId: string; start: RunEvent; terminal: RunEvent | null }): void {
  const evidence = inspectIsolatedEvidence(opts);
  // Degraded receipts never require worktree evidence; they replay idempotently.
  const priorIsDegraded = opts.terminal != null && opts.terminal.type === 'actor_failed' && (opts.terminal.extra as Record<string, unknown>).diff_snapshot == null;
  const priorHasDiff = opts.terminal != null && (opts.terminal.extra as Record<string, unknown>).diff_snapshot != null;
  // If prior terminal already has durable evidence (diff_snapshot) or was degraded, do not demand worktree/hasDiff.
  const hasDurableEvidence = evidence.hasDiff || priorHasDiff;
  if (!priorIsDegraded && !evidence.worktreeVerified && !hasDurableEvidence) {
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" isolated worktree is missing and no diff was recorded at "${evidence.diffRel}".`);
  }
  // Only discard a worktree whose evidence is already durable (hasDiff or priorHasDiff). A degraded receipt
  // that recorded no evidence must never trigger deletion of the worktree that evidence would have come from.
  const shouldCleanup = !priorIsDegraded && hasDurableEvidence && evidence.worktreeVerified && evidence.workspaceRel != null;
  if (shouldCleanup) {
    try {
      if (evidence.state != null) {
        removeHostWorkspace({ repoRoot: opts.repoRoot, state: evidence.state });
      } else {
        removeHostWorkspaceByPath({ repoRoot: opts.repoRoot, run: opts.runId, dispatchId: opts.dispatchId, workspaceRel: evidence.workspaceRel! });
      }
    } catch {
      // best-effort; idempotent retry on next call
    }
  }
}


function safeRunRelative(runDir: string, value: string, label: string): string {
  const runAbsolute = resolve(runDir);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(runAbsolute, value);
  const rel = relative(runAbsolute, absolute).split('\\').join('/');
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new HostDispatchError(`${label} path escapes the run directory: ${value}`);
  }
  const runReal = realpathSync(runAbsolute);
  let cursor = runAbsolute;
  for (const segment of rel.split('/')) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new HostDispatchError(`${label} path traverses a symlink: ${value}`);
      }
    } catch (err) {
      if (err instanceof HostDispatchError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
  let existing = absolute;
  let existingReal: string;
  for (;;) {
    try {
      existingReal = realpathSync(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(existing);
      if (parent === existing) throw new HostDispatchError(`${label} path cannot be resolved: ${value}`);
      existing = parent;
    }
  }
  const suffix = relative(existing, absolute);
  const resolvedTarget = resolve(existingReal, suffix);
  const realRel = relative(runReal, resolvedTarget).split('\\').join('/');
  if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
    throw new HostDispatchError(`${label} path escapes the run directory through a symlink: ${value}`);
  }
  return rel;
}

function validationFor(
  repoRoot: string,
  runDir: string,
  request: HostDispatchRequest,
  bytes: Buffer,
): { ok: true; extraction?: EnvelopeExtraction; parsed?: unknown } | { ok: false; errors: string[] } {
  if (request.artifactType == null) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    const schemaPaths = runSchemaDirectories(runDir, repoRoot);
    const schemas = new SchemaSet(schemaPaths.snapshot, schemaPaths.project, schemaPaths.builtin);
    if (request.artifactType && schemas.has(request.artifactType as SchemaKind)) {
      const validate = schemas.get(request.artifactType as SchemaKind);
      const result = extractSchemaEnvelope(bytes.toString('utf8'), validate);
      if (result.ok) {
        return { ok: true, extraction: result.extraction, parsed: result.parsed };
      }
      if (result.reason === 'schema_invalid' && result.errors && result.errors.length > 0) {
        const prefixed = result.errors.slice(0, 5).map((e) => `envelope candidate failed schema: ${e}`);
        return { ok: false, errors: prefixed };
      }
      return { ok: false, errors: [`output is not valid JSON: ${(err as Error).message}`] };
    }
    return { ok: false, errors: [`output is not valid JSON: ${(err as Error).message}`] };
  }
  const schemaPaths = runSchemaDirectories(runDir, repoRoot);
  const schemas = new SchemaSet(schemaPaths.snapshot, schemaPaths.project, schemaPaths.builtin);
  if (!schemas.has(request.artifactType as SchemaKind)) return { ok: true };
  const validate = schemas.get(request.artifactType as SchemaKind);
  return validate(parsed) ? { ok: true, parsed } : { ok: false, errors: schemaErrorMessages(validate) };
}

function attemptPath(request: HostDispatchRequest): string {
  const suffix = extname(request.outputPath) || '.out';
  const safeId = request.dispatchId.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `artifacts/attempts/${safeId}${suffix}`;
}

/**
 * Close this delivery's overlap window.
 *
 * Replaces `releaseHostLease`, at every one of the same call sites, and the
 * difference is the whole point of the change. The lease was a RESERVATION:
 * while it stood, no other shared writer could start, and a host delivery
 * never published a pid, so nothing could ever prove the holder gone. A
 * 429-killed agent's lease outlived the agent forever and wedged the repo
 * against every later run — including the recovery of the run that took it.
 *
 * A window reserves nothing. It records an interval, so a later delivery can
 * say "we overlapped, and here is where our edits met". A window left open by
 * a crash costs later deliveries an unnecessary isolated worktree; it cannot
 * refuse them.
 *
 * Best-effort, like the release it replaces: terminal receipts are ledger
 * facts and machine-local bookkeeping must never turn a recorded terminal into
 * a CLI failure.
 */
/**
 * A host dispatch's overlap-window id.
 *
 * `runId:dispatchId`, not the dispatch id alone. Host dispatch ids are derived
 * from the step and role (`hd-ac-implement-g1-worker-a1`), so two runs of the
 * same playbook produce the SAME id — and a window log keyed on it alone folds
 * two concurrent deliveries into one record, which is precisely the overlap it
 * exists to report. The engine and tool paths already qualify by run for the
 * same reason; the ad-hoc kernel's id is a uuid and needs no prefix.
 */
function hostWindowId(runId: string, dispatchId: string): string {
  return `${runId}:${dispatchId}`;
}

/**
 * Close a host window with no claim about what it changed.
 *
 * `changedPaths: []` with `truncated: false` is a POSITIVE statement that the
 * delivery changed nothing, and every neighbour intersects against it — so a
 * shared host delivery that rewrote half the tree was recorded as having
 * written nothing at all, and was invisible in both directions. Truncated is
 * the field for "could not tell", and it is what every host close that has no
 * diff to read must use.
 *
 * Used for the idempotent re-close of an already-terminal delivery and for
 * shared deliveries, whose honest set is discussed at `settleHostOverlap`.
 */
function closeHostWindow(repoRoot: string, runId: string, dispatchId: string, changedPaths: readonly string[] | null = null): void {
  try {
    closeDispatchWindow(repoRoot, {
      dispatchId: hostWindowId(runId, dispatchId),
      changedPaths: changedPaths ?? [],
      truncated: changedPaths == null,
    });
  } catch {
    // deliberately swallowed; see above
  }
}

/**
 * Close a host window on the idempotent re-terminal path, and only if the
 * first terminal did not already close it.
 *
 * Two failures meet here. A re-close appends a second `window_closed` row, and
 * the reader merges duplicate closes — so an unconditional truncated re-close
 * would mark a delivery's complete, attributable listing as incomplete for no
 * reason. And the ISOLATED terminal branches never closed a window at all, so
 * an isolated host delivery's window stayed open forever: every later delivery
 * in that repo saw a writer that had finished hours ago, isolated against it,
 * and stamped a `pending` overlap naming it. This closes that leak without
 * downgrading a good record.
 */
function closeHostWindowIfOpen(repoRoot: string, runId: string, dispatchId: string): void {
  try {
    const windowId = hostWindowId(runId, dispatchId);
    // The baseline goes UNCONDITIONALLY, before the window question is even
    // asked: this is a re-terminal, so the delivery is over on every branch
    // below, and a baseline that outlives its delivery is exactly the leftover
    // `doctor` counts. Deliberately NOT used to recompute a set here — the
    // first terminal already settled this window, and the whole reason this
    // function checks `endedAt` is that a re-terminal used to overwrite a good
    // record with a worse one.
    discardOverlapSnapshot(repoRoot, windowId);
    const existing = readDispatchWindows(repoRoot).windows.find((w) => w.dispatchId === windowId);
    // Absent means the log never saw the open; a close naming it would be an
    // orphan the reader drops anyway.
    if (existing == null || existing.endedAt != null) return;
    closeHostWindow(repoRoot, runId, dispatchId, null);
  } catch {
    // deliberately swallowed; see above
  }
}

/**
 * What a terminal host receipt says about who else was writing.
 *
 * ## Why this exists at all
 *
 * Host deliveries opened and closed windows and never intersected them. The
 * consequence was not symmetric under-reporting, it was a one-way mirror: a
 * command delivery correctly stamped `pending` against an open host window,
 * and that stamp told the reader the host's own receipt would carry the
 * intersection — a receipt that could never carry one. The pending case did
 * not merely under-report; it pointed a human at an empty page.
 *
 * ## The honest path set, per lane
 *
 * ISOLATED: the collected diff. `diffChangedPaths` parses the patch without
 * applying it, so it works after the worktree is gone, and its paths are the
 * delivery's OWN work — `attribution: 'delivery'` for anyone intersecting it.
 * A degraded terminal (no diff collected) has nothing to read and is
 * truncated.
 *
 * SHARED: the tree's delta over the window, from `changedBetween(before,
 * after)` — the same two `workspaceStatusMap` readings the shared command lane
 * uses, with the "before" one PERSISTED at `dispatch-start` (see
 * `captureOverlapSnapshot`) because this lane has no single process to hold it
 * in memory. `dispatch-start` and `dispatch-complete` are separate CLI
 * invocations, minutes or hours apart; what was missing was never the delta,
 * it was a written-down reading of the tree at the moment the window opened.
 *
 * This lane was `truncated` unconditionally until that reading existed, and
 * the reasons it was are the reasons it is still `truncated` whenever the
 * reading is not there. A bare `workspaceStatusMap` at the terminal describes
 * what is dirty NOW, including everything already dirty before the window
 * opened, so it would manufacture intersections that never happened; `[]` is
 * the positive empty claim this whole area exists to avoid. So a missing,
 * unreadable, incomplete or unparsable baseline — and a `git` that will not
 * answer at either end — all arrive here as a `null` from `changedBetween` and
 * all close the window `truncated`. Only two real readings of one tree ever
 * produce a set.
 *
 * That set is an ATTESTATION and nothing more. It is the shared tree's delta
 * over the interval: this delivery's work, the human's edits in the same
 * minutes, and whatever an unwindowed script did. `attribution: 'workspace'`
 * says exactly that on every stamp derived from it, and a better attestation
 * is all this buys — a shared delta does not become attributable to anyone by
 * being recorded more precisely.
 */
function settleHostOverlap(opts: {
  repoRoot: string;
  runId: string;
  dispatchId: string;
  workspaceMode: 'isolated' | 'shared';
  /** Repo-relative diff for an isolated delivery; null when there is none. */
  diffSnapshot: string | null;
  /** The `actor_dispatched` timestamp, used when the window log lost the open. */
  startFallbackIso: string | null;
  now: Date;
}): { stamps: ConcurrentWriteStamp[] | null; close: () => void } {
  const windowId = hostWindowId(opts.runId, opts.dispatchId);
  const changed = ((): string[] | null => {
    try {
      if (opts.diffSnapshot != null) {
        return diffChangedPaths(opts.repoRoot, join(opts.repoRoot, ...opts.diffSnapshot.split('/')));
      }
      // Only `shared`. An isolated delivery with no collected diff is a
      // degraded terminal: the tree it wrote was its worktree, not this one,
      // so this tree's delta says nothing about it and reading it would be a
      // claim about the wrong directory.
      if (opts.workspaceMode !== 'shared') return null;
      // `changedBetween` returns null when EITHER reading is missing, which is
      // every way this can fail: no baseline was captured, the file is
      // unreadable or over budget, or git will not answer now. Null is
      // `truncated` below. It must never become `[]`.
      return changedBetween(
        readOverlapSnapshot(opts.repoRoot, windowId),
        workspaceStatusMap(opts.repoRoot),
      );
    } catch {
      // Same rule one level up: bookkeeping never fails a terminal, and an
      // exception is one more spelling of "could not tell".
      return null;
    }
  })();
  const truncated = changed == null;
  const paths = changed ?? [];
  let stamps: ConcurrentWriteStamp[] | null = null;
  try {
    const log = readDispatchWindows(opts.repoRoot);
    // The window's own record is the authority on when this delivery started
    // writing; the start event's timestamp is the fallback for a log that lost
    // the open row. Neither available means the interval is unknown, and an
    // unknown interval intersects nothing — so nothing is claimed.
    const mine = log.windows.find((w) => w.dispatchId === windowId);
    const startedAt = mine?.startedAt ?? opts.startFallbackIso;
    if (startedAt != null) {
      stamps = detectConcurrentWrites(
        {
          dispatchId: windowId,
          startedAt,
          endedAt: opts.now.toISOString(),
          workspaceMode: opts.workspaceMode,
          changedPaths: paths,
          truncated,
        },
        log.windows,
        { logDegraded: log.degraded },
      );
    }
  } catch {
    // Machine-local bookkeeping never turns a recorded terminal into a CLI
    // failure. The receipt is the fact; the stamp is an observation about it.
  }
  return {
    stamps,
    // Closed AFTER the receipt is appended, exactly as before: a window left
    // open costs a later delivery an unnecessary worktree, where a window
    // closed before a receipt that then failed to append costs a missed
    // overlap.
    close: () => {
      try {
        closeDispatchWindow(opts.repoRoot, {
          dispatchId: windowId,
          changedPaths: paths,
          truncated,
          endedAt: opts.now,
        });
      } catch {
        // deliberately swallowed; see above
      }
      // The baseline described an interval that has just ended, so it goes
      // with the window it belonged to — on the success path and the failure
      // path alike, since `close` is the one call every terminal branch makes.
      // Its own removal swallows: a leaked baseline is inert and counted by
      // `doctor`, where a throw here would fail a dispatch whose receipt is
      // already durable.
      discardOverlapSnapshot(opts.repoRoot, windowId);
    },
  };
}

function writeArtifactAtomic(path: string, bytes: Buffer): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

/** Add one durable request, or return the existing identical request. */
export function requestHostDispatch(opts: HostDispatchRequestOptions): HostDispatchRequest {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  const events = eventsFor(runDir);
  const existing = events.filter((event) => event.type === 'host_dispatch_requested' && event.extra.dispatch_id === opts.dispatchId);
  if (existing.length > 1) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was requested more than once.`);
  if (existing.length === 1) {
    const current = requestFromEvent(runId, existing[0]!);
    const same =
      current.step === opts.step &&
      current.actor === opts.actor &&
      current.stepExecutionId === opts.stepExecutionId &&
      current.actorCallId === opts.actorCallId &&
      current.attempt === opts.attempt &&
      current.attemptReason === opts.attemptReason &&
      current.executor === opts.executor &&
      current.model === opts.model &&
      current.reasoningEffort === opts.reasoningEffort &&
      current.agentType === opts.agentType &&
      current.promptPath === opts.promptPath &&
      current.promptSha256 === opts.promptSha256 &&
      current.outputPath === opts.outputPath &&
      current.artifactType === opts.artifactType &&
      current.nodeInstanceId === opts.nodeInstanceId &&
      current.parentInstanceId === opts.parentInstanceId &&
      current.mapMember === opts.mapMember &&
      current.generation === opts.generation &&
      current.logicalArtifact === opts.logicalArtifact &&
      JSON.stringify(current.validationErrors ?? null) === JSON.stringify(opts.validationErrors ?? null) &&
      current.repairAppendix === opts.repairAppendix;
    if (!same) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" conflicts with its existing request.`);
    return current;
  }
  append(
    runDir,
    {
      type: 'host_dispatch_requested',
      step: opts.step,
      actor: opts.actor,
      dispatch_id: opts.dispatchId,
      step_execution_id: opts.stepExecutionId,
      actor_call_id: opts.actorCallId,
      attempt: opts.attempt,
      attempt_reason: opts.attemptReason,
      executor: opts.executor,
      adapter: 'host',
      model: opts.model,
      reasoning_effort: opts.reasoningEffort,
      agent_type: opts.agentType,
      prompt_path: opts.promptPath,
      prompt_sha256: opts.promptSha256,
      output_path: opts.outputPath,
      artifact_type: opts.artifactType,
      node_instance_id: opts.nodeInstanceId,
      parent_instance_id: opts.parentInstanceId,
      map_member: opts.mapMember,
      generation: opts.generation,
      logical_artifact: opts.logicalArtifact,
      requested_identity: ['model', 'reasoning_effort', 'agent_type'],
      ...(opts.validationErrors != null ? { validation_errors: opts.validationErrors } : {}),
      ...(opts.repairAppendix != null ? { repair_appendix: opts.repairAppendix } : {}),
    },
    opts.now,
  );
  return opts;
}

export function startHostDispatch(opts: DispatchStartOptions): HostDispatchReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  if (!opts.agentId.trim()) throw new HostDispatchError('--agent-id must not be empty.');
  const transport = opts.transport ?? 'host';
  if (transport === 'command-fallback' && (opts.command == null || opts.command.length === 0)) {
    throw new HostDispatchError('command-fallback dispatch-start requires the exact command argv.');
  }
  if (transport === 'host' && opts.command != null) {
    throw new HostDispatchError('host dispatch-start must not include command argv.');
  }
  const events = eventsFor(runDir);
  const { request, event: requestEvent } = findRequest(runId, events, opts.dispatchId);
  let isolatedState: HostWorkspaceState | null = null;
  let isIsolated = false;
  try {
    isolatedState = readHostWorkspaceState(repoRoot, runId, opts.dispatchId);
    if (isolatedState != null) isIsolated = true;
  } catch (err) {
    if (err instanceof HostWorkspaceError) {
      isIsolated = false;
      isolatedState = null;
    } else {
      throw err;
    }
  }
  if (isIsolated && transport === 'command-fallback') {
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" is prepared for isolated host delivery and cannot be delivered by command fallback.`);
  }
  if (isIsolated && opts.workspace != null && opts.workspace !== isolatedState!.workspace) {
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" is prepared for isolated delivery at "${isolatedState!.workspace}"; --workspace must match or be omitted.`);
  }
  if (transport === 'command-fallback') {
    const profile = hostRequestProfile({
      runId,
      runDir,
      events,
      event: requestEvent,
      request,
      terminal: null,
    });
    // `agentType` is the archetype on a locked host request (the engine
    // stamps `agent_type: <archetype>`), so it is what selects a
    // policy-chosen variant's snapshot entry. The wildcard names no archetype.
    const executor = snapshotExecutor(profile, request.executor, request.agentType === '*' ? null : request.agentType);
    if (
      executor == null || executor.adapter !== 'host' ||
      JSON.stringify(executor.fallbackCommand ?? null) !== JSON.stringify(opts.command ?? null) ||
      executor.model !== request.model || executor.reasoningEffort !== request.reasoningEffort ||
      (executor.agentType !== '*' && executor.agentType !== request.agentType)
    ) {
      throw new HostDispatchError(
        `command-fallback delivery for "${opts.dispatchId}" does not match its snapshotted executor and identity.`,
      );
    }
  }
  /**
   * Open this delivery's overlap window, and — for a SHARED delivery — write
   * down the tree it is about to write into.
   *
   * Where the lease acquire used to be, and it cannot fail the dispatch. The
   * acquire could, and did: a shared host delivery that found a live lease was
   * REFUSED, and because a host lease never had a pid to disprove, "live" was
   * a state nothing could leave. Opening a window is a record, so the only
   * question left is what a second writer should DO — and the answer is that
   * it gets its own tree, not that it waits for one it cannot outlive.
   *
   * The baseline is captured BEFORE the window row so it can only ever be at
   * or before the interval it describes: a baseline read a moment early
   * over-reports the delta by whatever landed in between, and a baseline read
   * a moment late MISSES work inside the window. In a detector that must never
   * say "clean" when it does not know, those two errors are not symmetric.
   *
   * Only `shared`, and only once. An isolated delivery has its own worktree
   * diff, which is a strictly better answer (`attribution: 'delivery'`), so
   * spending a snapshot on it would buy a worse one. And `captureOverlapSnapshot`
   * keeps an existing file rather than replacing it, which is what makes this
   * safe on the idempotent re-`dispatch-start` below: re-reading the tree there
   * would move the baseline past everything the agent had already written and
   * quietly erase it from the delta.
   */
  const openHostWindow = (): void => {
    if (!isIsolated) {
      captureOverlapSnapshot(repoRoot, hostWindowId(runId, opts.dispatchId), {
        capturedAt: opts.now ?? new Date(),
      });
    }
    try {
      openDispatchWindow(repoRoot, {
        dispatchId: hostWindowId(runId, opts.dispatchId),
        runId,
        kind: 'host-dispatch',
        workspaceMode: isIsolated ? 'isolated' : 'shared',
        startedAt: opts.now ?? new Date(),
      });
    } catch {
      // Never fatal: an unrecorded window costs a missed overlap report, and
      // a dispatch that cannot start costs the work.
    }
  };
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length > 1) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was started more than once.`, { code: DUPLICATE_START });
  const terminals = terminalsFor(events, opts.dispatchId);
  if (terminals.length > 0) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a terminal receipt.`);
  if (starts.length === 1) {
    const prior = starts[0]!;
    const priorMode = hostDeliveryWorkspaceMode(prior);
    const currentMode = isIsolated ? 'isolated' : 'shared';
    if (priorMode !== currentMode) {
      throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already started with different delivery evidence.`);
    }
    const priorTransport = normalizeDeliveryTransport(prior.extra.delivery_transport);
    const sameCommand = JSON.stringify(prior.extra.fallback_command ?? null) === JSON.stringify(opts.command ?? null);
    if (prior.extra.agent_id === opts.agentId && priorTransport === transport && sameCommand) {
      openHostWindow();
      return { dispatchId: opts.dispatchId, state: 'started', idempotent: true, agentId: opts.agentId };
    }
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already started with different delivery evidence.`);
  }
  openHostWindow();
  try {
    append(
    runDir,
    {
      type: 'actor_dispatched',
      step: request.step,
      actor: request.actor,
      dispatch_id: request.dispatchId,
      step_execution_id: request.stepExecutionId,
      actor_call_id: request.actorCallId,
      attempt: request.attempt,
      attempt_reason: request.attemptReason,
      executor: request.executor,
      adapter: 'host',
      model: request.model,
      reasoning_effort: request.reasoningEffort,
      agent_type: request.agentType,
      prompt_path: request.promptPath,
      prompt_sha256: request.promptSha256,
      output_path: request.outputPath,
      ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
      ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
      agent_id: opts.agentId,
      ...(isIsolated
        ? {
            workspace_mode: 'isolated' as const,
            workspace: isolatedState!.workspace,
            base_commit: isolatedState!.base_commit,
          }
        : {
            workspace: opts.workspace,
          }),
      branch: opts.branch,
      delivery_transport: transport,
      ...(opts.command != null ? {
        fallback_command: opts.command,
        fallback_command_sha256: sha256Hex(JSON.stringify(opts.command)),
      } : {}),
      host_attested: transport === 'host',
      identity_evidence: transport === 'host' ? 'requested_only' : 'command_receipt',
      ...(transport === 'host' ? {
        attestation: {
          model: request.model,
          reasoning_effort: request.reasoningEffort,
          agent_type: request.agentType,
          agent_id: opts.agentId,
        },
      } : {}),
      node_instance_id: request.nodeInstanceId,
      parent_instance_id: request.parentInstanceId,
      map_member: request.mapMember,
      generation: request.generation,
      logical_artifact: request.logicalArtifact,
    },
      opts.now,
    );
  } catch (err) {
    // The one host close that can honestly claim an empty set: the window was
    // opened moments ago and the executor was never spawned, so nothing of
    // this delivery has run. The baseline goes with it — there is no delivery
    // left for it to be the baseline of, and leaving it would make a LATER
    // start of the same dispatch inherit a stale reading (the keep-existing
    // rule that protects a live delivery works against a dead one).
    closeHostWindow(repoRoot, runId, opts.dispatchId, []);
    discardOverlapSnapshot(repoRoot, hostWindowId(runId, opts.dispatchId));
    throw err;
  }
  return { dispatchId: opts.dispatchId, state: 'started', idempotent: false, agentId: opts.agentId };
}

function deliveryFields(start: RunEvent): Record<string, unknown> {
  return {
    delivery_transport: normalizeDeliveryTransport(start.extra.delivery_transport),
    ...(start.extra.fallback_command !== undefined ? { fallback_command: start.extra.fallback_command } : {}),
    ...(start.extra.fallback_command_sha256 !== undefined
      ? { fallback_command_sha256: start.extra.fallback_command_sha256 }
      : {}),
    host_attested: start.extra.host_attested === true,
    identity_evidence: start.extra.identity_evidence,
  };
}

/** Record one provenance-labelled, non-gating observation of a running host dispatch. */
export function progressHostDispatch(opts: DispatchProgressOptions): HostDispatchProgressReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  const source = opts.source ?? 'agent';
  if (!PROGRESS_SOURCES.has(source)) {
    throw new HostDispatchError(`--source must be one of: ${[...PROGRESS_SOURCES].join(', ')}.`);
  }
  const events = eventsFor(runDir);
  const { request } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length === 0) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" cannot report progress before dispatch-start.`);
  if (starts.length > 1) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was started more than once.`, { code: DUPLICATE_START });
  if (normalizeDeliveryTransport(starts[0]!.extra.delivery_transport) !== 'host') {
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" command fallback cannot accept host progress receipts.`);
  }
  if (terminalsFor(events, opts.dispatchId).length > 0) {
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a terminal receipt.`);
  }
  const reportFile = isAbsolute(opts.file) ? opts.file : resolve(cwd, opts.file);
  if (!existsSync(reportFile) || !statSync(reportFile).isFile()) {
    throw new HostDispatchError(`progress report does not exist: ${opts.file}`);
  }
  if (lstatSync(reportFile).isSymbolicLink()) {
    throw new HostDispatchError(`progress report must not be a symlink: ${opts.file}`);
  }
  const bytes = readFileSync(reportFile);
  if (bytes.length > MAX_PROGRESS_BYTES) {
    throw new HostDispatchError(`progress report exceeds ${MAX_PROGRESS_BYTES} bytes.`);
  }
  const report = parseProgressReport(bytes);
  const digest = sha256Hex(bytes);
  const prior = events.findLast(
    (event) => event.type === 'host_dispatch_progress' && event.extra.dispatch_id === opts.dispatchId,
  );
  if (prior?.extra.report_sha256 === digest && prior.extra.observation_source === source) {
    return { dispatchId: opts.dispatchId, state: report.state, source, idempotent: true, reportSha256: digest };
  }
  const isIsolated = hostDeliveryWorkspaceMode(starts[0]!) === 'isolated';
  // No heartbeat. The lease this used to refresh was there so a reader could
  // guess whether the holder was still alive; a window needs no such guess,
  // because it is closed by the terminal receipt and by nothing else. Progress
  // remains what it always was: an attested, non-gating observation.
  void isIsolated;
  const agentId = starts[0]!.extra.agent_id;
  append(
    runDir,
    {
      type: 'host_dispatch_progress',
      step: request.step,
      actor: request.actor,
      dispatch_id: request.dispatchId,
      step_execution_id: request.stepExecutionId,
      actor_call_id: request.actorCallId,
      attempt: request.attempt,
      executor: request.executor,
      adapter: 'host',
      model: request.model,
      reasoning_effort: request.reasoningEffort,
      agent_type: request.agentType,
      agent_id: agentId,
      observation_source: source,
      progress_state: report.state,
      phase: report.phase,
      summary: report.summary,
      completed: report.completed,
      current: report.current,
      next: report.next,
      blockers: report.blockers,
      reported_at: report.updatedAt,
      report_sha256: digest,
      host_attested: true,
      node_instance_id: request.nodeInstanceId,
      parent_instance_id: request.parentInstanceId,
      map_member: request.mapMember,
      generation: request.generation,
      logical_artifact: request.logicalArtifact,
    },
    opts.now,
  );
  return { dispatchId: opts.dispatchId, state: report.state, source, idempotent: false, reportSha256: digest };
}

export function completeHostDispatch(opts: DispatchCompleteOptions): HostDispatchReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  const events = eventsFor(runDir);
  const { request } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length === 0) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" cannot complete before dispatch-start.`);
  if (starts.length > 1) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was started more than once.`, { code: DUPLICATE_START });
  const terminal = terminalsFor(events, opts.dispatchId);
  let bytes: Buffer;
  if (opts.output === '-') {
    if (opts.stdinBytes != null) {
      bytes = opts.stdinBytes;
    } else {
      // Read artifact bytes from stdin (binary-safe). Caller (cli) pipes the artifact;
      // this path uses the same validation, atomic placement, manifest, and receipt as a temp file.
      try {
        bytes = readFileSync(0);
      } catch (err) {
        throw new HostDispatchError(`failed to read stdin for --output -: ${(err as Error).message}`);
      }
      if (bytes.length === 0) {
        // Allow empty artifact? Validation will decide; but empty stdin is still bytes (maybe 0).
        // Do not throw here; let validation handle typed vs untyped.
      }
    }
  } else {
    const outputFile = isAbsolute(opts.output) ? opts.output : resolve(cwd, opts.output);
    if (!existsSync(outputFile) || !statSync(outputFile).isFile()) throw new HostDispatchError(`temporary output does not exist: ${opts.output}`);
    bytes = readFileSync(outputFile);
  }
  const digest = sha256Hex(bytes);
  const isIsolated = hostDeliveryWorkspaceMode(starts[0]!) === 'isolated';
  if (terminal.length > 0) {
    if (isIsolated) {
      settleIsolatedTerminalWorkspace({ repoRoot, runId, dispatchId: opts.dispatchId, start: starts[0]!, terminal: terminal[0] ?? null });
      closeHostWindowIfOpen(repoRoot, runId, opts.dispatchId);
      const prior = terminal[0]!;
      if (
        prior.type === 'actor_completed' &&
        (prior.extra.output_sha256 === digest || (prior.extra as Record<string, unknown>).raw_output_sha256 === digest)
      ) {
        return { dispatchId: opts.dispatchId, state: 'completed', idempotent: true, outputPath: typeof prior.extra.output === 'string' ? prior.extra.output : request.outputPath, outputSha256: digest };
      }
      throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a different terminal receipt.`);
    } else {
      closeHostWindowIfOpen(repoRoot, runId, opts.dispatchId);
      const prior = terminal[0]!;
      if (
        prior.type === 'actor_completed' &&
        (prior.extra.output_sha256 === digest || (prior.extra as Record<string, unknown>).raw_output_sha256 === digest)
      ) {
        return { dispatchId: opts.dispatchId, state: 'completed', idempotent: true, outputPath: typeof prior.extra.output === 'string' ? prior.extra.output : request.outputPath, outputSha256: digest };
      }
      throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a different terminal receipt.`);
    }
  }

  let isolatedComplete: IsolatedCompleteOutcome | null = null;
  if (isIsolated) {
    const evidence = inspectIsolatedEvidence({ repoRoot, runId, dispatchId: opts.dispatchId, start: starts[0]! });
    if (evidence.state != null) {
      // state present: strict collect
      try {
        const collected = collectHostWorkspaceDiff({ repoRoot, state: evidence.state });
        isolatedComplete = { kind: 'collected', collected };
      } catch (err) {
        if (err instanceof HostWorkspaceError) throw new HostDispatchError(err.message);
        throw err;
      }
    } else {
      // state null/malformed: recovery via ledger-verified worktree
      if (!evidence.worktreeVerified || evidence.workspaceRel == null) {
        throw new HostDispatchError(`host dispatch "${opts.dispatchId}" isolated worktree is missing and no diff was recorded at "${evidence.diffRel}".`);
      }
      if (!isValidBaseCommit(evidence.ledgerBaseCommit)) {
        throw new HostDispatchError(`host dispatch "${opts.dispatchId}" ledger base_commit is missing or invalid for recovery at "${evidence.workspaceRel}"`);
      }
      try {
        const result = collectIsolatedRecoveryDiff({ repoRoot, run: runId, dispatchId: opts.dispatchId, workspaceRel: evidence.workspaceRel });
        // Build a synthetic state for stamping — ledger-verified, never writes a state file.
        const syntheticState: HostWorkspaceState = {
          schema_version: '1.0',
          run: runId,
          dispatch_id: opts.dispatchId,
          workspace_mode: 'isolated',
          workspace: evidence.workspaceRel,
          base_commit: evidence.ledgerBaseCommit as string,
          prepared_at: (opts.now ?? new Date()).toISOString(),
          diff_snapshot: result.diffSnapshot,
          diff_bytes: result.diffBytes,
        };
        const collected: IsolatedCollected = { state: syntheticState, diffSnapshot: result.diffSnapshot, diffBytes: result.diffBytes };
        isolatedComplete = { kind: 'collected', collected };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HostDispatchError(`host dispatch "${opts.dispatchId}" isolated worktree at "${evidence.workspaceRel}" could not be collected: ${msg}`);
      }
    }
  }

  // Who else was writing while this delivery ran. Computed ONCE, here, after
  // the isolated diff exists and before any receipt is appended, because every
  // branch below writes a different terminal payload and they must not
  // disagree about the overlap — the same reason `drive.ts` funnels this
  // through one `workspaceFields()`.
  const overlap = settleHostOverlap({
    repoRoot,
    runId,
    dispatchId: opts.dispatchId,
    workspaceMode: isIsolated ? 'isolated' : 'shared',
    diffSnapshot: isolatedComplete?.kind === 'collected' ? isolatedComplete.collected.diffSnapshot : null,
    startFallbackIso: starts[0]!.timestamp,
    now: opts.now ?? new Date(),
  });
  /** Absent when nothing overlapped — a field on every receipt is one nobody reads. */
  const overlapFields = (): Record<string, unknown> =>
    (overlap.stamps != null ? { concurrent_write: overlap.stamps } : {});

  const verdict = validationFor(repoRoot, runDir, request, bytes);
  const agentId = typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined;
  if (!verdict.ok) {
    const parked = safeRunRelative(runDir, attemptPath(request), 'invalid output attempt');
    const parkedAbs = join(runDir, parked);
    mkdirSync(join(runDir, 'artifacts', 'attempts'), { recursive: true });
    if (existsSync(parkedAbs) && sha256Hex(readFileSync(parkedAbs)) !== digest) throw new HostDispatchError(`invalid output attempt path "${parked}" already contains different bytes.`);
    if (!existsSync(parkedAbs)) writeArtifactAtomic(parkedAbs, bytes);
    if (isIsolated) {
      if (isolatedComplete == null) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" isolated evidence was not collected`);
      const collected = isolatedComplete.collected;
      append(
        runDir,
        {
          type: 'actor_completed',
          step: request.step,
          actor: request.actor,
          dispatch_id: request.dispatchId,
          step_execution_id: request.stepExecutionId,
          actor_call_id: request.actorCallId,
          attempt: request.attempt,
          executor: request.executor,
          adapter: 'host',
          model: request.model,
          reasoning_effort: request.reasoningEffort,
          agent_type: request.agentType,
          prompt_path: request.promptPath,
          prompt_sha256: request.promptSha256,
          output_path: request.outputPath,
          ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
          ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
          agent_id: agentId,
          output: parked,
          output_bytes: bytes.length,
          output_sha256: digest,
          output_valid: false,
          validation_errors: verdict.errors.slice(0, 5),
          ...deliveryFields(starts[0]!),
          workspace_mode: 'isolated',
          workspace: collected.state.workspace,
          ...hostTeardownFields(repoRoot, collected.state),
          base_commit: collected.state.base_commit,
          diff_snapshot: collected.diffSnapshot,
          diff_bytes: collected.diffBytes,
          node_instance_id: request.nodeInstanceId,
          parent_instance_id: request.parentInstanceId,
          map_member: request.mapMember,
          generation: request.generation,
          logical_artifact: request.logicalArtifact,
          ...overlapFields(),
        },
        opts.now,
      );
      try { removeHostWorkspace({ repoRoot, state: collected.state }); } catch {}
      overlap.close();
      return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: parked, outputSha256: digest };
    } else {
      append(
        runDir,
        {
          type: 'actor_completed',
          step: request.step,
          actor: request.actor,
          dispatch_id: request.dispatchId,
          step_execution_id: request.stepExecutionId,
          actor_call_id: request.actorCallId,
          attempt: request.attempt,
          executor: request.executor,
          adapter: 'host',
          model: request.model,
          reasoning_effort: request.reasoningEffort,
          agent_type: request.agentType,
          prompt_path: request.promptPath,
          prompt_sha256: request.promptSha256,
          output_path: request.outputPath,
          ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
          ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
          agent_id: agentId,
          output: parked,
          output_bytes: bytes.length,
          output_sha256: digest,
          output_valid: false,
          validation_errors: verdict.errors.slice(0, 5),
          ...deliveryFields(starts[0]!),
          node_instance_id: request.nodeInstanceId,
          parent_instance_id: request.parentInstanceId,
          map_member: request.mapMember,
          generation: request.generation,
          logical_artifact: request.logicalArtifact,
          ...overlapFields(),
        },
        opts.now,
      );
      overlap.close();
      return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: parked, outputSha256: digest };
    }
  }

  const extraction = verdict.ok ? verdict.extraction : undefined;
  if (extraction) {
    const payloadStr = extraction.payload;
    const payloadBytes = Buffer.from(payloadStr, 'utf8');
    const normalizedDigest = sha256Hex(payloadBytes);
    const suffixRaw = extname(request.outputPath) || '.out';
    const safeIdRaw = request.dispatchId.replace(/[^A-Za-z0-9_.-]+/g, '_');
    const rawRel = `artifacts/attempts/${safeIdRaw}.raw${suffixRaw}`;
    const rawAbs = join(runDir, rawRel);
    mkdirSync(join(runDir, 'artifacts', 'attempts'), { recursive: true });
    if (existsSync(rawAbs) && sha256Hex(readFileSync(rawAbs)) !== digest) {
      throw new HostDispatchError(`raw output attempt path "${rawRel}" already contains different bytes.`);
    }
    if (!existsSync(rawAbs)) writeArtifactAtomic(rawAbs, bytes);
    const outputRel = safeRunRelative(runDir, request.outputPath, 'planned output');
    const outputAbs = join(runDir, outputRel);
    if (existsSync(outputAbs) && sha256Hex(readFileSync(outputAbs)) !== normalizedDigest) {
      throw new HostDispatchError(`planned output "${outputRel}" already contains different bytes.`);
    }
    mkdirSync(dirname(outputAbs), { recursive: true });
    if (!existsSync(outputAbs)) writeArtifactAtomic(outputAbs, payloadBytes);
    const schemaPaths = runSchemaDirectories(runDir, repoRoot);
    const manifest = buildArtifactManifest(runDir, outputRel, `artifact-${request.dispatchId}`, new SchemaSet(schemaPaths.snapshot, schemaPaths.project, schemaPaths.builtin));
    const existingManifest = events.find(
      (event) => event.type === 'artifact_created' && event.extra.dispatch_id === request.dispatchId,
    );
    if (existingManifest == null) {
      append(
        runDir,
        {
          type: 'artifact_created',
          step: request.step,
          actor: request.actor,
          member: request.mapMember ?? request.actor,
          ...manifest,
          dispatch_id: request.dispatchId,
          step_execution_id: request.stepExecutionId,
          actor_call_id: request.actorCallId,
          attempt: request.attempt,
          agent_id: agentId,
          executor: request.executor,
          adapter: 'host',
          node_instance_id: request.nodeInstanceId,
          parent_instance_id: request.parentInstanceId,
          map_member: request.mapMember,
          generation: request.generation ?? manifest.generation,
          logical_artifact: request.logicalArtifact,
        },
        opts.now,
      );
    } else if (existingManifest.extra.sha256 !== manifest.sha256) {
      throw new HostDispatchError(`host dispatch "${request.dispatchId}" has a conflicting artifact manifest digest.`);
    }
    if (isIsolated) {
      if (isolatedComplete == null) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" isolated evidence was not collected`);
      const collected = isolatedComplete.collected;
      append(
        runDir,
        {
          type: 'actor_completed',
          step: request.step,
          actor: request.actor,
          dispatch_id: request.dispatchId,
          step_execution_id: request.stepExecutionId,
          actor_call_id: request.actorCallId,
          attempt: request.attempt,
          executor: request.executor,
          adapter: 'host',
          model: request.model,
          reasoning_effort: request.reasoningEffort,
          agent_type: request.agentType,
          prompt_path: request.promptPath,
          prompt_sha256: request.promptSha256,
          output_path: request.outputPath,
          ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
          ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
          agent_id: agentId,
          output: outputRel,
          output_bytes: payloadBytes.length,
          output_sha256: normalizedDigest,
          output_valid: true,
          output_extraction: extraction.kind,
          envelope_candidates: extraction.candidates,
          raw_output: rawRel,
          raw_output_bytes: bytes.length,
          raw_output_sha256: digest,
          commit: opts.commit,
          ...deliveryFields(starts[0]!),
          workspace_mode: 'isolated',
          workspace: collected.state.workspace,
          ...hostTeardownFields(repoRoot, collected.state),
          base_commit: collected.state.base_commit,
          diff_snapshot: collected.diffSnapshot,
          diff_bytes: collected.diffBytes,
          node_instance_id: request.nodeInstanceId,
          parent_instance_id: request.parentInstanceId,
          map_member: request.mapMember,
          generation: request.generation,
          logical_artifact: request.logicalArtifact,
          ...overlapFields(),
        },
        opts.now,
      );
      try { removeHostWorkspace({ repoRoot, state: collected.state }); } catch {}
      overlap.close();
      return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: outputRel, outputSha256: normalizedDigest };
    } else {
      append(
        runDir,
        {
          type: 'actor_completed',
          step: request.step,
          actor: request.actor,
          dispatch_id: request.dispatchId,
          step_execution_id: request.stepExecutionId,
          actor_call_id: request.actorCallId,
          attempt: request.attempt,
          executor: request.executor,
          adapter: 'host',
          model: request.model,
          reasoning_effort: request.reasoningEffort,
          agent_type: request.agentType,
          prompt_path: request.promptPath,
          prompt_sha256: request.promptSha256,
          output_path: request.outputPath,
          ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
          ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
          agent_id: agentId,
          output: outputRel,
          output_bytes: payloadBytes.length,
          output_sha256: normalizedDigest,
          output_valid: true,
          output_extraction: extraction.kind,
          envelope_candidates: extraction.candidates,
          raw_output: rawRel,
          raw_output_bytes: bytes.length,
          raw_output_sha256: digest,
          commit: opts.commit,
          ...deliveryFields(starts[0]!),
          node_instance_id: request.nodeInstanceId,
          parent_instance_id: request.parentInstanceId,
          map_member: request.mapMember,
          generation: request.generation,
          logical_artifact: request.logicalArtifact,
          ...overlapFields(),
        },
        opts.now,
      );
      overlap.close();
      return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: outputRel, outputSha256: normalizedDigest };
    }
  }

  const outputRel = safeRunRelative(runDir, request.outputPath, 'planned output');
  const outputAbs = join(runDir, outputRel);
  if (existsSync(outputAbs) && sha256Hex(readFileSync(outputAbs)) !== digest) {
    throw new HostDispatchError(`planned output "${outputRel}" already contains different bytes.`);
  }
  mkdirSync(dirname(outputAbs), { recursive: true });
  if (!existsSync(outputAbs)) writeArtifactAtomic(outputAbs, bytes);
  const schemaPaths = runSchemaDirectories(runDir, repoRoot);
  const manifest = buildArtifactManifest(runDir, outputRel, `artifact-${request.dispatchId}`, new SchemaSet(schemaPaths.snapshot, schemaPaths.project, schemaPaths.builtin));
  const existingManifest = events.find(
    (event) => event.type === 'artifact_created' && event.extra.dispatch_id === request.dispatchId,
  );
  if (existingManifest == null) {
    append(
      runDir,
      {
        type: 'artifact_created',
        step: request.step,
        actor: request.actor,
        member: request.mapMember ?? request.actor,
        ...manifest,
        dispatch_id: request.dispatchId,
        step_execution_id: request.stepExecutionId,
        actor_call_id: request.actorCallId,
        attempt: request.attempt,
        agent_id: agentId,
        executor: request.executor,
        adapter: 'host',
        node_instance_id: request.nodeInstanceId,
        parent_instance_id: request.parentInstanceId,
        map_member: request.mapMember,
        generation: request.generation ?? manifest.generation,
        logical_artifact: request.logicalArtifact,
      },
      opts.now,
    );
  } else if (existingManifest.extra.sha256 !== manifest.sha256) {
    throw new HostDispatchError(`host dispatch "${request.dispatchId}" has a conflicting artifact manifest digest.`);
  }
  if (isIsolated) {
    if (isolatedComplete == null) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" isolated evidence was not collected`);
    const collected = isolatedComplete.collected;
    append(
      runDir,
      {
        type: 'actor_completed',
        step: request.step,
        actor: request.actor,
        dispatch_id: request.dispatchId,
        step_execution_id: request.stepExecutionId,
        actor_call_id: request.actorCallId,
        attempt: request.attempt,
        executor: request.executor,
        adapter: 'host',
        model: request.model,
        reasoning_effort: request.reasoningEffort,
        agent_type: request.agentType,
        prompt_path: request.promptPath,
        prompt_sha256: request.promptSha256,
        output_path: request.outputPath,
        ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
        ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
        agent_id: agentId,
        output: outputRel,
        output_bytes: bytes.length,
        output_sha256: digest,
        output_valid: true,
        commit: opts.commit,
        ...deliveryFields(starts[0]!),
        workspace_mode: 'isolated',
        workspace: collected.state.workspace,
        ...hostTeardownFields(repoRoot, collected.state),
        base_commit: collected.state.base_commit,
        diff_snapshot: collected.diffSnapshot,
        diff_bytes: collected.diffBytes,
        node_instance_id: request.nodeInstanceId,
        parent_instance_id: request.parentInstanceId,
        map_member: request.mapMember,
        generation: request.generation,
        logical_artifact: request.logicalArtifact,
        ...overlapFields(),
      },
      opts.now,
    );
    try { removeHostWorkspace({ repoRoot, state: collected.state }); } catch {}
    overlap.close();
    return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: outputRel, outputSha256: digest };
  } else {
    append(
      runDir,
      {
        type: 'actor_completed',
        step: request.step,
        actor: request.actor,
        dispatch_id: request.dispatchId,
        step_execution_id: request.stepExecutionId,
        actor_call_id: request.actorCallId,
        attempt: request.attempt,
        executor: request.executor,
        adapter: 'host',
        model: request.model,
        reasoning_effort: request.reasoningEffort,
        agent_type: request.agentType,
        prompt_path: request.promptPath,
        prompt_sha256: request.promptSha256,
        output_path: request.outputPath,
        ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
        ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
        agent_id: agentId,
        output: outputRel,
        output_bytes: bytes.length,
        output_sha256: digest,
        output_valid: true,
        commit: opts.commit,
        ...deliveryFields(starts[0]!),
        node_instance_id: request.nodeInstanceId,
        parent_instance_id: request.parentInstanceId,
        map_member: request.mapMember,
        generation: request.generation,
        logical_artifact: request.logicalArtifact,
        ...overlapFields(),
      },
      opts.now,
    );
    overlap.close();
    return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: outputRel, outputSha256: digest };
  }
}

export function failHostDispatch(opts: DispatchFailOptions): HostDispatchReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  if (!opts.reason.trim()) throw new HostDispatchError('--reason must not be empty.');
  const events = eventsFor(runDir);
  const { request } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length === 0) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" cannot fail before dispatch-start.`);
  const terminal = terminalsFor(events, opts.dispatchId);
  const isIsolated = hostDeliveryWorkspaceMode(starts[0]!) === 'isolated';
  if (terminal.length > 0) {
    if (isIsolated) {
      settleIsolatedTerminalWorkspace({ repoRoot, runId, dispatchId: opts.dispatchId, start: starts[0]!, terminal: terminal[0] ?? null });
      closeHostWindowIfOpen(repoRoot, runId, opts.dispatchId);
      const prior = terminal[0]!;
      if (prior.type === 'actor_failed' && prior.extra.failure_reason === opts.reason) {
        return { dispatchId: opts.dispatchId, state: 'failed', idempotent: true, agentId: typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined };
      }
      throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a different terminal receipt.`);
    } else {
      closeHostWindowIfOpen(repoRoot, runId, opts.dispatchId);
      const prior = terminal[0]!;
      if (prior.type === 'actor_failed' && prior.extra.failure_reason === opts.reason) {
        return { dispatchId: opts.dispatchId, state: 'failed', idempotent: true, agentId: typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined };
      }
      throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a different terminal receipt.`);
    }
  }
  let isolatedFail: IsolatedFailOutcome | null = null;
  if (isIsolated) {
    const evidence = inspectIsolatedEvidence({ repoRoot, runId, dispatchId: opts.dispatchId, start: starts[0]! });
    if (evidence.state != null) {
      // State present: collect must succeed or remain strict/preserving
      if (!evidence.worktreeVerified && !evidence.hasDiff) {
        // Evidence absent: degraded without diff keys (worktree already gone and no durable diff)
        isolatedFail = { kind: 'degraded', workspace: evidence.workspaceRel, baseCommit: evidence.ledgerBaseCommit ?? evidence.state.base_commit };
      } else {
        try {
          const collected = collectHostWorkspaceDiff({ repoRoot, state: evidence.state });
          isolatedFail = { kind: 'collected', collected };
        } catch (err) {
          if (err instanceof HostWorkspaceError) throw new HostDispatchError(err.message);
          throw err;
        }
      }
    } else {
      // State null/malformed: best-effort recovery-collect, degraded fallback without throwing
      if (evidence.worktreeVerified && evidence.workspaceRel != null) {
        // A verified worktree can be collected, but the receipt cannot attribute a diff without a valid ledger base_commit — degrade and preserve instead of fabricating one.
        if (!isValidBaseCommit(evidence.ledgerBaseCommit)) {
          isolatedFail = { kind: 'degraded', workspace: evidence.workspaceRel, baseCommit: evidence.ledgerBaseCommit };
        } else {
          try {
            const result = collectIsolatedRecoveryDiff({ repoRoot, run: runId, dispatchId: opts.dispatchId, workspaceRel: evidence.workspaceRel });
            const syntheticState: HostWorkspaceState = {
              schema_version: '1.0',
              run: runId,
              dispatch_id: opts.dispatchId,
              workspace_mode: 'isolated',
              workspace: evidence.workspaceRel,
              base_commit: evidence.ledgerBaseCommit as string,
              prepared_at: (opts.now ?? new Date()).toISOString(),
              diff_snapshot: result.diffSnapshot,
              diff_bytes: result.diffBytes,
            };
            const collected: IsolatedCollected = { state: syntheticState, diffSnapshot: result.diffSnapshot, diffBytes: result.diffBytes };
            isolatedFail = { kind: 'collected', collected };
          } catch {
            // Recovery collection failed (any error, including ENOTDIR): degraded receipt, preserve worktree
            isolatedFail = { kind: 'degraded', workspace: evidence.ledgerWorkspace, baseCommit: evidence.ledgerBaseCommit };
          }
        }
      } else {
        isolatedFail = { kind: 'degraded', workspace: evidence.ledgerWorkspace, baseCommit: evidence.ledgerBaseCommit };
      }
    }
  }
  // Who else was writing while this delivery ran. A FAILED delivery overlaps
  // exactly as hard as a successful one — an agent that was killed after
  // writing half its edits is the case most likely to have met another writer
  // — so this is computed on the failure path too, from whatever evidence the
  // isolated collect managed to preserve.
  const overlap = settleHostOverlap({
    repoRoot,
    runId,
    dispatchId: opts.dispatchId,
    workspaceMode: isIsolated ? 'isolated' : 'shared',
    diffSnapshot: isolatedFail?.kind === 'collected' ? isolatedFail.collected.diffSnapshot : null,
    startFallbackIso: starts[0]!.timestamp,
    now: opts.now ?? new Date(),
  });
  // Build the shared failed payload once to avoid triplication; isolated
  // branches only add workspace tail. Degraded isolated omits diff keys
  // entirely rather than fabricating zero/sentinel.
  const failedBase = {
    type: 'actor_failed' as const,
    step: request.step,
    actor: request.actor,
    dispatch_id: request.dispatchId,
    step_execution_id: request.stepExecutionId,
    actor_call_id: request.actorCallId,
    attempt: request.attempt,
    executor: request.executor,
    adapter: 'host' as const,
    model: request.model,
    reasoning_effort: request.reasoningEffort,
    agent_type: request.agentType,
    prompt_path: request.promptPath,
    prompt_sha256: request.promptSha256,
    output_path: request.outputPath,
    ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
    ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
    agent_id: starts[0]!.extra.agent_id,
    reason: 'host_failed' as const,
    failure_reason: opts.reason,
    ...deliveryFields(starts[0]!),
    node_instance_id: request.nodeInstanceId,
    parent_instance_id: request.parentInstanceId,
    map_member: request.mapMember,
    generation: request.generation,
    logical_artifact: request.logicalArtifact,
    ...(overlap.stamps != null ? { concurrent_write: overlap.stamps } : {}),
  };
  if (isIsolated) {
    if (isolatedFail == null) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" isolated evidence was not collected`);
    const outcome = isolatedFail;
    if (outcome.kind === 'degraded') {
      append(runDir, {
        ...failedBase,
        workspace_mode: 'isolated' as const,
        ...(outcome.workspace != null ? { workspace: outcome.workspace } : {}),
        ...(outcome.baseCommit != null ? { base_commit: outcome.baseCommit } : {}),
      }, opts.now);
      // Never delete an unverified worktree; only remove when verified and we have a collected state to reference.
      // Degraded path preserves the worktree for manual recovery.
      overlap.close();
      return { dispatchId: opts.dispatchId, state: 'failed', idempotent: false, agentId: typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined };
    }
    append(runDir, {
      ...failedBase,
      workspace_mode: 'isolated' as const,
      workspace: outcome.collected.state.workspace,
      ...hostTeardownFields(repoRoot, outcome.collected.state),
      base_commit: outcome.collected.state.base_commit,
      diff_snapshot: outcome.collected.diffSnapshot,
      diff_bytes: outcome.collected.diffBytes,
    }, opts.now);
    try { removeHostWorkspace({ repoRoot, state: outcome.collected.state }); } catch {
      // best-effort
    }
    overlap.close();
    return { dispatchId: opts.dispatchId, state: 'failed', idempotent: false, agentId: typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined };
  } else {
    append(runDir, { ...failedBase }, opts.now);
    overlap.close();
    return { dispatchId: opts.dispatchId, state: 'failed', idempotent: false, agentId: typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined };
  }
}

/**
 * Retire a host request that was minted and never started.
 *
 * Before this there was no way to say "this request will never run": the only
 * terminal receipts, `dispatch-complete` and `dispatch-fail`, both require a
 * `dispatch-start` first, so a request minted for an executor the host cannot
 * reach left the run pinned to it forever — `drive` kept reporting it pending
 * and refused to re-mint under a corrected binding, and the only exits were a
 * fabricated start or a hand-edited ledger.
 *
 * A withdraw is a TERMINAL receipt for a request with NO execution behind it,
 * which is why it records no agent, no output, and no attestation: there is
 * nothing to attest. The request stays in the ledger as the fact it is — the
 * engine minted attempt n, it was retired, attempt n+1 follows under whatever
 * the cascade or binding now says.
 */
export function withdrawHostDispatch(opts: DispatchWithdrawOptions): HostDispatchWithdrawReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId, status } = assertCurrentLedger(repoRoot, opts.run);
  const reason = opts.reason?.trim() ?? '';
  if (!reason) throw new HostDispatchError('--reason must not be empty.');
  if (status != null && RUN_TERMINAL_STATUSES.has(status)) {
    throw new HostDispatchError(
      `run "${runId}" is already ${status}; a terminal run cannot withdraw host dispatch "${opts.dispatchId}".`,
    );
  }
  const events = eventsFor(runDir);
  const { request } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length > 0) {
    throw new HostDispatchError(
      `host dispatch "${opts.dispatchId}": cannot withdraw after dispatch-start; use dispatch-fail or dispatch-complete.`,
    );
  }
  const finals = events.filter(
    (event) => (event.type === 'actor_completed' || event.type === 'actor_failed') && event.extra.dispatch_id === opts.dispatchId,
  );
  if (finals.length > 0) {
    throw new HostDispatchError(
      `host dispatch "${opts.dispatchId}" already has an ${finals[0]!.type} receipt; it cannot be withdrawn.`,
    );
  }
  // A withdraw is terminal, so any overlap baseline for this dispatch is over
  // too — on this call and on every repeat of it. There is normally none: a
  // withdraw requires that `dispatch-start` never landed, and the baseline is
  // written there. The exception is the one path that writes a baseline and
  // then fails to append `actor_dispatched`, which leaves a started-looking
  // baseline behind a request that never started — exactly the request a
  // withdraw exists to retire. Placed above the idempotent replay so a repeat
  // sweeps what the first call could not.
  discardOverlapSnapshot(repoRoot, hostWindowId(runId, opts.dispatchId));
  const priorWithdrawals = withdrawalsFor(events, opts.dispatchId);
  if (priorWithdrawals.length > 0) {
    const prior = priorWithdrawals[0]!;
    if (prior.extra.reason === reason) {
      // Replay what the recorded receipt says, never a fresh guess: the
      // repeat is answering for the withdraw that already happened.
      return {
        dispatchId: opts.dispatchId,
        state: 'withdrawn',
        idempotent: true,
        reason,
        workspaceRemoved: prior.extra.workspace_removed === true,
        workspaceError: null,
      };
    }
    throw new HostDispatchError(
      `host dispatch "${opts.dispatchId}" was already withdrawn for a different reason (${String(prior.extra.reason)}).`,
    );
  }

  // A request prepared with `dispatch-prepare --isolate` owns a worktree that
  // nothing will ever write into now. Removing it is part of the withdraw, not
  // a follow-up chore — but a removal that does not take is reported rather
  // than asserted: the receipt is a ledger fact and never waits on the disk.
  let state: HostWorkspaceState | null = null;
  try {
    state = readHostWorkspaceState(repoRoot, runId, opts.dispatchId);
  } catch (err) {
    if (!(err instanceof HostWorkspaceError)) throw err;
  }
  if (state != null && !isHostPathSafe(repoRoot, state.workspace)) state = null;
  const canonicalRel = hostWorktreePath(runId, opts.dispatchId);
  const workspaceRel = state?.workspace
    ?? (isHostPathSafe(repoRoot, canonicalRel) && existsSync(resolve(repoRoot, canonicalRel)) ? canonicalRel : null);
  let workspaceRemoved = false;
  let workspaceError: string | null = null;
  if (workspaceRel != null) {
    try {
      if (state != null) removeHostWorkspace({ repoRoot, state });
      else removeHostWorkspaceByPath({ repoRoot, run: runId, dispatchId: opts.dispatchId, workspaceRel });
    } catch (err) {
      if (!(err instanceof HostWorkspaceError)) throw err;
    }
    workspaceRemoved = !existsSync(resolve(repoRoot, workspaceRel));
    if (!workspaceRemoved) {
      workspaceError =
        `host dispatch "${opts.dispatchId}" is withdrawn, but the isolated workspace prepared for it ` +
        `remains at ${workspaceRel}; remove it manually.`;
    }
  }

  append(
    runDir,
    {
      type: 'host_dispatch_withdrawn',
      step: request.step,
      actor: request.actor,
      dispatch_id: request.dispatchId,
      step_execution_id: request.stepExecutionId,
      actor_call_id: request.actorCallId,
      attempt: request.attempt,
      executor: request.executor,
      reason,
      withdrawn_by: 'host',
      ...(workspaceRel != null ? { workspace: workspaceRel, workspace_removed: workspaceRemoved } : {}),
    },
    opts.now,
  );
  return { dispatchId: opts.dispatchId, state: 'withdrawn', idempotent: false, reason, workspaceRemoved, workspaceError };
}

export function listHostDispatchRequests(runDir: string): HostDispatchRequest[] {
  return eventsFor(runDir)
    .filter((event) => event.type === 'host_dispatch_requested')
    .map((event) => requestFromEvent('(unknown)', event));
}

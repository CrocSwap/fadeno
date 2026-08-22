import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, linkSync, renameSync, openSync, closeSync, readSync, readdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sha256Hex } from './artifact-manifest.ts';
import { INFLIGHT_DIR, inflightClaimIsAlive, readInflightClaim, readSupervisorStatus, sleepSync, superviseArgv, supervisedSpawnError, supervisorCanStillReport } from './supervisor.ts';
import { acquireWorkspaceLease, isWorkspaceLeaseAlive, readEffectiveLease, readWorkspaceLease, releaseWorkspaceLease, WorkspaceLeaseError, WORKSPACE_LEASE_FILE } from './workspace-lease.ts';
import { atCwd, withoutHarnessIdentity } from './executors.ts';
import { readEventsStrict, type RunEvent } from './run-ledger.ts';
import { parseGeneration } from './prompt-resolve.ts';
import { countIterationStarts, scopeStartIndex, stepStartedInScope } from './run-scope.ts';
import { LedgerWriter, LedgerWriteError, withRunLock } from './run-ledger-write.ts';
import { runRun, RunError } from '../commands/run.ts';
import { runSchemaDirectories } from './definitions.ts';
import { SCHEMA_KINDS, SchemaSet, type SchemaKind } from './playbook-validate.ts';

export class ToolExecError extends Error {}

export const TOOL_SUMMARY_MAX_BYTES = 4000;
export const TOOL_DETAILS_MAX_BYTES = 32 * 1024;
export const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;

export function renderArgv(argv: readonly string[]): string {
  return argv.map((part) => {
    if (/^[a-zA-Z0-9._\/:=-]+$/.test(part)) return part;
    return `'${part.replace(/'/g, `'"'"'`)}'`;
  }).join(' ');
}

export function commandDigest(argv: readonly string[]): string {
  return sha256Hex(JSON.stringify(argv));
}

export interface ToolAttemptIds {
  stepExecutionId: string;
  toolCallId: string;
}

export function toolAttemptIds(stepId: string, generation: number): ToolAttemptIds {
  return {
    stepExecutionId: `se-${stepId}-g${generation}`,
    toolCallId: `tc-${stepId}-g${generation}`,
  };
}

export interface SynthesizedTestResult {
  tool: string;
  command: string;
  status: 'passed' | 'failed' | 'error';
  exit_code: number | null;
  summary: string;
  details_path?: string;
}

export function synthesizeTestResult(opts: {
  tool: string;
  argv: readonly string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnFailed: string | null;
}): { result: SynthesizedTestResult; detailsContent: string | null } {
  const rendered = renderArgv(opts.argv);
  const combined = (() => {
    const parts: string[] = [];
    if (opts.stdout) parts.push(opts.stdout);
    if (opts.stderr) {
      if (parts.length > 0) parts.push('\n--- stderr ---\n');
      parts.push(opts.stderr);
    }
    if (opts.spawnFailed) {
      if (parts.length > 0) parts.push('\n--- spawn ---\n');
      parts.push(opts.spawnFailed);
    }
    if (opts.timedOut) {
      if (parts.length > 0) parts.push('\n--- timeout ---\n');
      parts.push(`timed out`);
    }
    if (opts.signal) {
      if (parts.length > 0) parts.push('\n--- signal ---\n');
      parts.push(`terminated by ${opts.signal}`);
    }
    return parts.join('');
  })();

  let status: 'passed' | 'failed' | 'error';
  let exitCode: number | null;
  if (opts.spawnFailed != null || opts.timedOut || opts.signal != null) {
    status = 'error';
    exitCode = null;
  } else if (opts.exitCode === 0) {
    status = 'passed';
    exitCode = 0;
  } else if (typeof opts.exitCode === 'number') {
    status = 'failed';
    exitCode = opts.exitCode;
  } else {
    status = 'error';
    exitCode = null;
  }

  if (status === 'passed' && opts.exitCode !== 0) {
    status = 'error';
    exitCode = null;
  }

  const truncationMarker = '\n…[truncated]';
  const markerBytes = Buffer.byteLength(truncationMarker, 'utf8');
  function truncateBounded(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    const allowed = Math.max(0, maxBytes - markerBytes);
    const buf = Buffer.from(text, 'utf8');
    let sliced = buf.subarray(0, allowed).toString('utf8');
    while (Buffer.byteLength(sliced, 'utf8') > allowed) {
      sliced = sliced.slice(0, -1);
    }
    return sliced + truncationMarker;
  }

  let summary = combined;
  summary = truncateBounded(summary, TOOL_SUMMARY_MAX_BYTES);
  if (summary.length === 0) {
    summary = status === 'passed' ? 'tool completed successfully' : `tool ${status}: ${rendered}`;
  }

  let detailsContent: string | null = null;
  if (combined.length > 0) {
    detailsContent = truncateBounded(combined, TOOL_DETAILS_MAX_BYTES);
  }

  const result: SynthesizedTestResult = {
    tool: opts.tool,
    command: rendered,
    status,
    exit_code: exitCode,
    summary,
  };
  return { result, detailsContent };
}

/**
 * How a tool step's artifact is produced from the process it ran.
 *
 * `test-result` is the special case, not the general one, and the distinction
 * is about what the exit code MEANS:
 *
 * - `synthesized-test-result` — the exit code IS the finding. A test runner
 *   exiting 1 has not failed to produce a result; it has produced the result
 *   `failed`. The artifact is synthesized from the exit status.
 * - `stdout-artifact` — the exit code is a PRECONDITION. A tool that exits
 *   non-zero did not produce the thing it was asked for, so there is nothing
 *   to record; its stdout is the artifact only when it succeeded.
 *
 * This used to be a yes/no eligibility gate — only `test-result` steps could
 * be automated at all, and every other tool step stopped the engine and asked
 * a human to write the artifact by hand. That made the shipped `pr-review`
 * starter undriveable: its `diff_loader` and `pr_commenter` steps both stall.
 * Found by dogfood 2026-08-21.
 */
export type ToolCaptureMode = 'synthesized-test-result' | 'stdout-artifact';

export function toolCaptureMode(artifactType: string | null): ToolCaptureMode {
  return artifactType === 'test-result' ? 'synthesized-test-result' : 'stdout-artifact';
}

export interface ToolProvenance {
  tool: string;
  command: string[];
  commandDigest: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnFailed: string | null;
  durationMs: number | null;
  toolCallId: string;
  stepExecutionId: string;
  attempt: number;
  generation: number;
}

const POLL_MS = 50;
const LIVENESS_EVERY = 20;
const STDERR_TAIL = 400;

/**
 * Has this generation of the step's *planned* output already been attributed?
 *
 * Scoped to the planned artifact's logical path and generation, never to "any
 * artifact this step happened to record". Auxiliary evidence (the bounded
 * details sidecar, attempt-parked results) lives at a different logical path by
 * construction, so it can never be mistaken for the step-completing TestResult
 * — which is what wedged both completion commands when the predicate was
 * generation-only.
 */
export function plannedGenerationAttributed(
  events: RunEvent[],
  stepId: string,
  plannedOutputRel: string,
  generation: number,
): boolean {
  const planned = parseGeneration(plannedOutputRel);
  return events.some((event) => {
    if (event.type !== 'artifact_created' || event.step !== stepId) return false;
    const artifact = event.extra.artifact;
    if (typeof artifact !== 'string') return false;
    if (artifact === plannedOutputRel) return true;
    const parsed = parseGeneration(artifact);
    return parsed.logicalPath === planned.logicalPath && parsed.generation === generation;
  });
}

/** True when a durable event already names these bytes as evidence. */
function pathNamedByLedger(events: RunEvent[], rel: string): boolean {
  for (const event of events) {
    if (event.type === 'artifact_created' && event.extra.artifact === rel) return true;
    if (event.extra.details_path === rel) return true;
    if ((event.type === 'tool_completed' || event.type === 'tool_failed' || event.type === 'tool_recorded') && event.extra.output === rel) return true;
  }
  return false;
}

/**
 * Place bytes at a run-relative path exclusively.
 *
 * `placed` means these exact bytes are now at `rel`. `conflict` means the path
 * is occupied by bytes the ledger already names — evidence, never clobbered.
 * Bytes that are merely *present* (a crashed attempt placed them and died
 * before attribution) are replaced in place: they are nobody's evidence, and
 * refusing them would turn every retry into a phantom "concurrent" loss.
 */
function placeBytesExclusive(
  runDir: string,
  rel: string,
  contents: string,
  events: () => RunEvent[],
): 'placed' | 'conflict' {
  const abs = join(runDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomUUID()}`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    linkSync(tmp, abs);
    return 'placed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (pathNamedByLedger(events(), rel)) return 'conflict';
    renameSync(tmp, abs);
    return 'placed';
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

/**
 * Write attempt-scoped evidence. These paths carry the attempt ordinal, so the
 * only writer that can own them is this attempt — replacing a leftover from an
 * earlier crash of the same attempt is correct, not a clobber.
 */
function writeAttemptBytes(runDir: string, rel: string, contents: string): void {
  const abs = join(runDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomUUID()}`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, abs);
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

/** Bytes already at `rel`, or null when absent/unreadable. */
function readIfPresent(runDir: string, rel: string): string | null {
  try {
    return readFileSync(join(runDir, rel), 'utf8');
  } catch {
    return null;
  }
}

export interface ToolCoreParams {
  repoRoot: string;
  runId: string;
  runDir: string;
  stepId: string;
  stepKind: string;
  toolName: string;
  artifactType: string | null;
  outputRel: string; // planned output path (already generation-aware)
  generation: number; // 1-based
  /** Loop step owning this body step, or null when the step is outer. */
  loopOwner?: string | null;
  /** 1-based loop iteration for a body step; null/absent for an outer step. */
  iteration?: number | null;
  command: string[]; // resolved argv
  effectiveTimeoutMs: number | null;
  now?: Date;
  harnessEnv?: NodeJS.ProcessEnv;
}

export interface ToolCoreResult {
  tool: string;
  artifact: string; // run-relative
  status: 'passed' | 'failed' | 'error';
  exitCode: number | null;
  attempt: number;
  generation: number;
  durationMs: number | null;
  toolCallId: string;
  stepExecutionId: string;
}

function findLiveToolClaim(repoRoot: string, runId: string, toolCallId: string): string | null {
  const inflightDir = join(repoRoot, ...INFLIGHT_DIR.split('/'));
  if (!existsSync(inflightDir)) return null;
  let files: string[];
  try {
    files = readdirSync(inflightDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ToolExecError(`failed to scan inflight claims at ${inflightDir}: ${(err as Error).message}`);
  }
  for (const file of files) {
    if (!file.startsWith(`tool-${runId}-${toolCallId}-a`) || !file.endsWith('.json')) continue;
    if (file.includes('.status.json')) continue;
    const abs = join(inflightDir, file);
    try {
      const claim = readInflightClaim(abs, (p) => readFileSync(p, 'utf8'));
      if (claim != null && inflightClaimIsAlive(claim)) {
        return abs;
      }
    } catch {}
  }
  return null;
}

/**
 * Open this generation's scope: enter the loop iteration if it has not been
 * entered, then start the step once *within that scope*.
 *
 * Scope, not a count: a retry inside the same generation must not append a
 * second `step_started` (it would shift the invocation number `fadeno prompt`
 * derives from those events), and a genuinely new iteration must append one
 * even though the step has started before. Shares `run-scope.ts` with
 * `drive`'s promptable path so both drivers scope identically.
 *
 * The whole decision runs under the per-run ledger lock, for the same reason
 * admission does: two helpers racing one generation would otherwise both read a
 * ledger with no `step_started`, and both append one. The lock is re-entrant,
 * so the writers nested inside (which take it to allocate `seq`) share this
 * critical section rather than deadlocking against it.
 */
function ensureStepStarted(params: ToolCoreParams): void {
  const owner = params.loopOwner ?? null;
  const iteration = owner != null ? (params.iteration ?? 1) : 0;
  try {
    withRunLock(params.runDir, () => {
      let events = readEventsStrict(params.runDir);
      if (owner != null && countIterationStarts(events, owner) < iteration) {
        new LedgerWriter(params.runDir).append(
          { type: 'loop_iteration_started', step: owner, iteration },
          params.now ?? new Date(),
        );
        events = readEventsStrict(params.runDir);
      }
      if (stepStartedInScope(events, params.stepId, scopeStartIndex(events, owner, iteration))) return;
      runRun({ run: params.runId, step: params.stepId, repoRoot: params.repoRoot, now: params.now });
    });
  } catch (err) {
    if (err instanceof RunError || err instanceof LedgerWriteError) throw new ToolExecError(err.message);
    throw err;
  }
}

export function executeToolCore(params: ToolCoreParams): ToolCoreResult {
  const generation = params.generation;
  const ids = toolAttemptIds(params.stepId, generation);

  const eventsBefore = readEventsStrict(params.runDir);
  const prior = eventsBefore.filter((e) => e.type === 'tool_dispatched' && e.extra.tool_call_id === ids.toolCallId).length;
  const attempt = prior + 1;

  const claimRel = `${INFLIGHT_DIR}/tool-${params.runId}-${ids.toolCallId}-a${attempt}.json`;
  const claimAbs = join(params.repoRoot, ...claimRel.split('/'));
  const statusAbs = claimAbs.replace(/\.json$/, '.status.json');

  // Both refusals come before `ensureStepStarted`: a request that never runs
  // must not open the generation's scope. A stray `step_started` would shift
  // the invocation number `fadeno prompt` derives from these events, and it
  // would do so for a caller that was told to wait.
  const liveClaim = findLiveToolClaim(params.repoRoot, params.runId, ids.toolCallId);
  if (liveClaim != null) {
    throw new ToolExecError(`tool attempt ${ids.toolCallId}:a${attempt} blocked — another live attempt for ${ids.toolCallId} holds ${liveClaim} (wait for it to terminate)`);
  }

  const effectiveLeaseBefore = (() => { try { return readEffectiveLease(params.repoRoot); } catch { return null; } })();
  if (effectiveLeaseBefore != null && isWorkspaceLeaseAlive(effectiveLeaseBefore)) {
    throw new ToolExecError(`shared workspace is already held by ${effectiveLeaseBefore.holder.kind} "${effectiveLeaseBefore.holder.id}" (supervisor_pid ${effectiveLeaseBefore.supervisor_pid ?? 'unknown'}, started ${effectiveLeaseBefore.started_at}); holder "tool:${params.runId}:${params.stepId}:g${generation}:a${attempt}" must wait or retry.`);
  }

  ensureStepStarted(params);

  // Publish claim atomically
  mkdirSync(join(params.repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
  const ownedClaimBody = (): string => {
    const nowIso = new Date().toISOString();
    return JSON.stringify({
      pid: process.pid,
      supervisor_pid: process.pid,
      executor_pid: null,
      process_group_id: null,
      // This process owns the attempt from here to its terminal receipt. The
      // supervisor republishes the claim with its own identity while the
      // executor runs, and carries this field through, so the attempt stays
      // visibly live across the whole handoff in both directions.
      owner_pid: process.pid,
      started_at: nowIso,
      heartbeat_at: nowIso,
      last_output_at: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
    });
  };
  {
    const nowIso = (params.now ?? new Date()).toISOString();
    const initialClaim = {
      pid: process.pid,
      supervisor_pid: process.pid,
      executor_pid: null,
      process_group_id: null,
      owner_pid: process.pid,
      started_at: nowIso,
      heartbeat_at: nowIso,
      last_output_at: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
    };
    const tmp = `${claimAbs}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify(initialClaim), { flag: 'wx' });
      try {
        linkSync(tmp, claimAbs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new ToolExecError(`failed to publish inflight claim for ${ids.toolCallId}:a${attempt}: ${(error as Error).message}`);
        }
        // Same-ordinal claim already on disk. A live one is a real competitor;
        // a proven-dead one is a crash between publish and dispatch, and must
        // be reclaimed rather than wedging this attempt ordinal forever.
        const competing = readInflightClaim(claimAbs, (p) => readFileSync(p, 'utf8'));
        if (competing == null) {
          throw new ToolExecError(`tool attempt ${ids.toolCallId}:a${attempt} has an unreadable supervisor claim at ${claimRel}; inspect and remove it before retrying.`);
        }
        if (inflightClaimIsAlive(competing)) {
          throw new ToolExecError(`tool attempt ${ids.toolCallId}:a${attempt} already has a concurrently published supervisor claim (pid ${competing.pid}); refusing duplicate.`);
        }
        rmSync(claimAbs, { force: true });
        try {
          linkSync(tmp, claimAbs);
        } catch (again) {
          throw new ToolExecError(`tool attempt ${ids.toolCallId}:a${attempt} lost a race republishing its supervisor claim (${(again as Error).message}); retry.`);
        }
      }
    } catch (error) {
      if (error instanceof ToolExecError) throw error;
      throw new ToolExecError(`failed to publish inflight claim for ${ids.toolCallId}:a${attempt}: ${(error as Error).message}`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  const holder = {
    id: `tool:${params.runId}:${params.stepId}:g${generation}:a${attempt}`,
    kind: 'engine' as const,
    runId: params.runId,
    dispatchId: `${ids.toolCallId}:a${attempt}`,
  };
  const withdrawClaim = (): void => { try { rmSync(claimAbs, { force: true }); } catch {} };
  let leaseAcquired = false;
  try {
    // Reserve pid-lessly, exactly like the engine and host paths. Until the
    // supervisor publishes executor/group identity there is no process whose
    // death proves the executor is gone, and a record naming *this* process as
    // the supervisor fails open the instant it exits: the reader sees one dead
    // pid, no executor, no group, and reclaims a reservation whose detached
    // executor may be running. A pid-less record is conservatively live and is
    // reclaimed only by recovery, which first proves the attempt dangling.
    acquireWorkspaceLease({
      repoRoot: params.repoRoot,
      workspaceMode: 'shared',
      holder,
      supervisorPid: null,
      executorPid: null,
      processGroupId: null,
      startedAt: params.now,
      heartbeatAt: params.now,
      stdoutBytes: 0,
      stderrBytes: 0,
      now: params.now,
    });
    leaseAcquired = true;
  } catch (err) {
    withdrawClaim();
    if (err instanceof WorkspaceLeaseError) throw new ToolExecError(err.message);
    throw err;
  }

  const commandDigestValue = commandDigest(params.command);
  // Durable admission: check-then-append under the per-run ledger lock so two
  // concurrent helpers cannot both pass a stale read and then both dispatch.
  // The lock is the same primitive that serializes seq allocation, so the
  // decision is atomic, crash-safe, and timing-independent.
  try {
    withRunLock(params.runDir, () => {
      const freshInside = readEventsStrict(params.runDir);
      const alreadyAttributedInside = plannedGenerationAttributed(freshInside, params.stepId, params.outputRel, generation);
      if (alreadyAttributedInside) {
        throw new ToolExecError(`tool "${params.toolName}" generation ${generation} already attributed; refusing duplicate dispatch for ${ids.toolCallId}:a${attempt}`);
      }
      const duplicateAttemptInside = freshInside.some((e) => (e.type === 'tool_dispatched' || e.type === 'tool_completed' || e.type === 'tool_failed') && e.extra.tool_call_id === ids.toolCallId && e.extra.attempt === attempt);
      if (duplicateAttemptInside) {
        throw new ToolExecError(`tool attempt ${ids.toolCallId}:a${attempt} already has a dispatch or terminal receipt; refusing duplicate execution`);
      }
      // Also block if the same generation already has a pending dispatched
      // without a terminal receipt — liveClaim/lease should have caught this,
      // but a stale filesystem view could miss it, so enforce durably here.
      const pendingForGeneration = freshInside.filter((e) => e.type === 'tool_dispatched' && e.extra.tool_call_id === ids.toolCallId);
      for (const disp of pendingForGeneration) {
        const att = disp.extra.attempt as number;
        const hasTerminal = freshInside.some((e) => (e.type === 'tool_completed' || e.type === 'tool_failed') && e.extra.tool_call_id === ids.toolCallId && e.extra.attempt === att);
        if (!hasTerminal) {
          // If the pending attempt is not the one we are about to dispatch,
          // another concurrent writer already holds this generation.
          if (att !== attempt) {
            throw new ToolExecError(`tool "${params.toolName}" generation ${generation} already has a pending dispatch ${ids.toolCallId}:a${att}; refusing duplicate dispatch for ${ids.toolCallId}:a${attempt}`);
          }
          // If att === attempt, duplicateAttemptInside would have already thrown,
          // but keep the pending check as a safety net.
          throw new ToolExecError(`tool attempt ${ids.toolCallId}:a${attempt} already has a dispatch or terminal receipt; refusing duplicate execution`);
        }
      }
      // The canonical writer, not a hand-rolled append: it rescans `seq` under
      // this same (re-entrant) lock, so admission stays one atomic
      // check-then-append, and its constructor keeps the legacy-ledger gate
      // that an inlined `appendFileSync` silently bypassed.
      new LedgerWriter(params.runDir).append({
        type: 'tool_dispatched',
        step: params.stepId,
        tool: params.toolName,
        step_execution_id: ids.stepExecutionId,
        tool_call_id: ids.toolCallId,
        attempt,
        generation,
        command: params.command,
        command_sha256: commandDigestValue,
        supervisor_claim: claimRel,
        workspace_mode: 'shared',
        ...(params.effectiveTimeoutMs != null ? { timeout_ms: params.effectiveTimeoutMs } : {}),
      }, params.now ?? new Date());
    });
  } catch (err) {
    if (leaseAcquired) try { releaseWorkspaceLease({ repoRoot: params.repoRoot, holder }); } catch {}
    withdrawClaim();
    if (err instanceof ToolExecError) throw err;
    if (err instanceof LedgerWriteError) throw new ToolExecError(err.message);
    throw err;
  }

  // Prepare supervisor spawn files
  const outputSnapshotAbs = join(params.repoRoot, '.fadeno', 'local', 'outputs', `${params.runId}-${ids.toolCallId}-a${attempt}.out`);
  const stderrSnapshotAbs = join(params.repoRoot, '.fadeno', 'local', 'outputs', `${params.runId}-${ids.toolCallId}-a${attempt}.err`);
  mkdirSync(join(params.repoRoot, '.fadeno', 'local', 'outputs'), { recursive: true });
  try { rmSync(outputSnapshotAbs, { force: true }); } catch {}
  try { rmSync(stderrSnapshotAbs, { force: true }); } catch {}
  const promptPath = join(params.repoRoot, '.fadeno', 'local', 'prompts', `${params.runId}-${ids.toolCallId}-a${attempt}.empty`);
  mkdirSync(join(params.repoRoot, '.fadeno', 'local', 'prompts'), { recursive: true });
  try { writeFileSync(promptPath, '', 'utf8'); } catch {}

  // This kernel polls the supervisor's status file rather than blocking inside
  // `spawnSync`, so it is still working when the supervisor exits: reading the
  // output, synthesizing, placing the artifact, attributing it. Naming
  // ourselves as the owner keeps the claim and the lease with us across that
  // window, and leaves the supervisor's own release in place for the crash
  // path where nobody is left to hand them to.
  const leaseRelease = {
    leasePath: join(params.repoRoot, WORKSPACE_LEASE_FILE),
    lockPath: join(params.repoRoot, '.fadeno', 'local', '.workspace-lease.lock'),
    holder,
    owner: { pid: process.pid },
  };

  let promptFd: number | null = null;
  let outFd: number | null = null;
  let errFd: number | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  const startedMs = Date.now();
  let spawnErrorSync: string | null = null;
  try {
    promptFd = openSync(promptPath, 'r');
    outFd = openSync(outputSnapshotAbs, 'w');
    errFd = openSync(stderrSnapshotAbs, 'w');
    const argv = params.command;
    child = spawn(process.execPath, superviseArgv(argv, claimAbs, statusAbs, leaseRelease, params.effectiveTimeoutMs ?? null), {
      stdio: [promptFd, outFd, errFd],
      cwd: params.repoRoot,
      env: atCwd(withoutHarnessIdentity(process.env), params.repoRoot),
      detached: false,
    });
    child.unref();
  } catch (err) {
    spawnErrorSync = (err as Error).message;
  } finally {
    if (promptFd != null) try { closeSync(promptFd); } catch {}
    if (outFd != null) try { closeSync(outFd); } catch {}
    if (errFd != null) try { closeSync(errFd); } catch {}
  }

  if (spawnErrorSync != null) {
    const msg = spawnErrorSync;
    handleInfraFailure({
      repoRoot: params.repoRoot,
      runDir: params.runDir,
      runId: params.runId,
      stepId: params.stepId,
      toolName: params.toolName,
      command: params.command,
      commandDigestValue,
      outputRel: params.outputRel,
      generation,
      attempt,
      ids,
      durationMs: Date.now() - startedMs,
      now: params.now,
      stdout: '',
      stderr: msg,
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnFailed: msg,
      claimAbs,
      statusAbs,
      outputSnapshotAbs,
      stderrSnapshotAbs,
      holder,
      claimRel,
    });
    throw new ToolExecError(`failed to spawn tool "${params.toolName}": ${msg}`);
  }

  // Wait for the supervisor's status file. Without a pid there is nothing to
  // probe, so the wait is bounded; with one, the poll ends as soon as the
  // supervisor can no longer report.
  let supervisorStatus: ReturnType<typeof readSupervisorStatus> = null;
  if (child?.pid == null) {
    let wait = 0;
    while (!existsSync(statusAbs) && wait < 50) { sleepSync(POLL_MS); wait += 1; }
  } else {
    let polls = 0;
    while (!existsSync(statusAbs)) {
      polls += 1;
      if (polls % LIVENESS_EVERY === 0 && !supervisorCanStillReport(child.pid)) break;
      sleepSync(POLL_MS);
    }
  }

  supervisorStatus = readSupervisorStatus(statusAbs, (p) => {
    try { return readFileSync(p, 'utf8'); } catch { return '__missing__'; }
  });

  if (supervisorStatus == null) {
    // No status: the supervisor died without saying how. Releasing the guards
    // here is only safe once the executor is *proven* dead — anything short of
    // proof (a live claim, an unreadable claim, a failed probe) keeps the claim
    // and lease and blocks retry, because the child may still be writing.
    if (existsSync(claimAbs)) {
      let claim: ReturnType<typeof readInflightClaim>;
      try {
        claim = readInflightClaim(claimAbs, (p) => readFileSync(p, 'utf8'));
      } catch (err) {
        throw new ToolExecError(`tool "${params.toolName}" supervisor lost and its claim ${claimRel} could not be read (${(err as Error).message}); retry blocked until the process group is proven dead`);
      }
      if (claim == null) {
        throw new ToolExecError(`tool "${params.toolName}" supervisor lost and its claim ${claimRel} is unreadable; retry blocked until the process group is proven dead`);
      }
      let alive: boolean;
      try {
        // This claim names *us* — as its supervisor before the handoff, as its
        // owner after — so our own existence is the one fact on it that cannot
        // answer the question being asked. Excluding it makes the probe report
        // the executor's liveness, which is what decides between an honest
        // retryable receipt here and deferring to the next process's recovery.
        alive = inflightClaimIsAlive(claim, undefined, { selfPid: process.pid });
      } catch (err) {
        throw new ToolExecError(`tool "${params.toolName}" supervisor lost and liveness of claim ${claimRel} could not be probed (${(err as Error).message}); retry blocked until the process group is proven dead`);
      }
      if (alive) {
        throw new ToolExecError(`tool "${params.toolName}" supervisor lost but executor may still be alive (claim ${claimRel} pid ${claim.pid}); retry blocked until process group dead`);
      }
    }
    // Proven dead — record retryable infra failure
    const infraMsg = 'supervisor ended without report';
    handleInfraFailure({
      repoRoot: params.repoRoot,
      runDir: params.runDir,
      runId: params.runId,
      stepId: params.stepId,
      toolName: params.toolName,
      command: params.command,
      commandDigestValue,
      outputRel: params.outputRel,
      generation,
      attempt,
      ids,
      durationMs: Date.now() - startedMs,
      now: params.now,
      stdout: '',
      stderr: 'supervisor lost',
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnFailed: infraMsg,
      claimAbs,
      statusAbs,
      outputSnapshotAbs,
      stderrSnapshotAbs,
      holder,
      claimRel,
    });
    throw new ToolExecError(`tool "${params.toolName}" supervisor lost without report`);
  }

  // The child is reaped and its report is durable; everything from here to the
  // terminal receipt is this process's work. Re-assert both guards under our
  // own identity rather than trusting the supervisor's handoff alone, so the
  // attempt is unambiguously owned even if that supervisor predates the
  // handoff or could not probe us. Only reached with an observed status — the
  // "supervisor lost" branch above deliberately leaves the guards untouched.
  //
  // Placed by rename, like every other claim transition: a reader that catches
  // a plain in-place rewrite mid-flight parses a truncated claim as *no usable
  // pid* and concludes the attempt is unowned — the exact reading this re-assert
  // exists to prevent. The temp name carries the pid and a uuid so no two
  // writers can collide on it, and it is a sibling of the claim so the rename
  // stays within one filesystem.
  {
    const tmp = `${claimAbs}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, ownedClaimBody(), 'utf8');
      renameSync(tmp, claimAbs);
    } catch {
      try { rmSync(tmp, { force: true }); } catch {}
    }
  }
  try {
    acquireWorkspaceLease({
      repoRoot: params.repoRoot,
      workspaceMode: 'shared',
      holder,
      supervisorPid: process.pid,
      executorPid: null,
      processGroupId: null,
      now: params.now,
    });
  } catch {}

  const durationMs = supervisorStatus.durationMs ?? (Date.now() - startedMs);

  // Read stdout/stderr with bounding/truncation, preserving observed exit
  let stdout = '';
  let stderr = '';
  // stdout: check size, but truncate instead of discarding if oversized
  try {
    const st = statSync(outputSnapshotAbs);
    if (st.size > SPAWN_MAX_BUFFER) {
      // Truncate stdout to SPAWN_MAX_BUFFER, keep exit semantics
      const fd = openSync(outputSnapshotAbs, 'r');
      try {
        const buf = Buffer.alloc(SPAWN_MAX_BUFFER);
        const read = readSync(fd, buf, 0, SPAWN_MAX_BUFFER, 0);
        stdout = buf.subarray(0, read).toString('utf8');
        // Ensure valid UTF-8 truncation (trim incomplete char)
        while (Buffer.byteLength(stdout, 'utf8') > SPAWN_MAX_BUFFER) stdout = stdout.slice(0, -1);
        stdout += '\n…[truncated stdout]';
      } finally { try { closeSync(fd); } catch {} }
    } else {
      stdout = readFileSync(outputSnapshotAbs, 'utf8');
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Unreadable output snapshot: the exit code was observed, but the
      // evidence behind it was not, so this is infrastructure, not a result.
      handleInfraFailure({
        repoRoot: params.repoRoot,
        runDir: params.runDir,
        runId: params.runId,
        stepId: params.stepId,
        toolName: params.toolName,
        command: params.command,
        commandDigestValue,
        outputRel: params.outputRel,
        generation,
        attempt,
        ids,
        durationMs,
        now: params.now,
        stdout: '',
        stderr: `failed to read output snapshot: ${(err as Error).message}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnFailed: `output unreadable: ${(err as Error).message}`,
        claimAbs,
        statusAbs,
        outputSnapshotAbs,
        stderrSnapshotAbs,
        holder,
        claimRel,
      });
      throw new ToolExecError(`tool "${params.toolName}" output unreadable: ${(err as Error).message}`);
    } else {
      stdout = '';
    }
  }
  try {
    const errStat = statSync(stderrSnapshotAbs);
    if (errStat.size > SPAWN_MAX_BUFFER) {
      const fd = openSync(stderrSnapshotAbs, 'r');
      try {
        const tail = Buffer.alloc(STDERR_TAIL);
        const read = readSync(fd, tail, 0, STDERR_TAIL, errStat.size - STDERR_TAIL);
        stderr = tail.subarray(0, read).toString('utf8');
      } finally { try { closeSync(fd); } catch {} }
    } else {
      stderr = readFileSync(stderrSnapshotAbs, 'utf8');
    }
  } catch { stderr = ''; }

  const spawnFailed = supervisorStatus.spawnFailed ?? supervisedSpawnError(supervisorStatus.exitCode ?? null, stderr);
  const timedOut = supervisorStatus.timedOut === true;
  const signal = supervisorStatus.signal ?? null;
  const exitCode = supervisorStatus.exitCode ?? null;

  const { result, detailsContent } = synthesizeTestResult({
    tool: params.toolName,
    argv: params.command,
    stdout,
    stderr,
    exitCode,
    signal,
    timedOut,
    spawnFailed,
  });

  // A close code of null with no signal, timeout, or spawn failure is a
  // supervisor that could not observe how the child ended. There is no observed
  // exit behind it, so it can never become a `tool_completed` on the planned
  // path — it is infrastructure, and the attempt stays retryable.
  const captureMode = toolCaptureMode(params.artifactType);
  // A non-zero exit is infrastructure for a stdout-captured tool and evidence
  // for a test runner. See `ToolCaptureMode`: recording stdout as the artifact
  // after a non-zero exit would attribute whatever the tool printed on its way
  // out — a usage message, a partial write, a stack trace — as the artifact the
  // step promised, and the step would look done.
  const failedByExit = captureMode === 'stdout-artifact' && exitCode != null && exitCode !== 0;
  const isInfraFailure = spawnFailed != null || timedOut || signal != null || exitCode == null || failedByExit;

  if (isInfraFailure) {
    // Attempt-scoped infra handling
    handleInfraFailure({
      repoRoot: params.repoRoot,
      runDir: params.runDir,
      runId: params.runId,
      stepId: params.stepId,
      toolName: params.toolName,
      command: params.command,
      commandDigestValue,
      outputRel: params.outputRel,
      generation,
      attempt,
      ids,
      durationMs,
      now: params.now,
      stdout,
      stderr,
      exitCode: failedByExit ? exitCode : null,
      signal,
      timedOut,
      spawnFailed,
      claimAbs,
      statusAbs,
      outputSnapshotAbs,
      stderrSnapshotAbs,
      holder,
      claimRel,
      synthesizedResult: result,
      detailsContent,
    });
    const msg = spawnFailed
      ?? (timedOut ? 'timed out'
        : signal ? `signal ${signal}`
          : failedByExit ? `exited ${exitCode} without producing its artifact`
            : 'ended without an observed exit code');
    throw new ToolExecError(`tool "${params.toolName}" failed: ${msg}; attempt recorded as error TestResult at artifacts/attempts/${ids.toolCallId}-a${attempt}${extname(params.outputRel) || '.json'} (retryable)`);
  }

  const ext = extname(params.outputRel) || '.json';
  const attemptRel = `artifacts/attempts/${ids.toolCallId}-a${attempt}${ext}`;
  const attemptDetailsRel = `artifacts/attempts/${ids.toolCallId}-a${attempt}.details.txt`;
  const plannedDetailsRel = (() => {
    if (detailsContent == null) return null;
    const derived = params.outputRel.replace(/\.json$/, '.details.txt');
    return derived === params.outputRel ? `${params.outputRel}.details.txt` : derived;
  })();

  const releaseGuards = (): void => {
    try { rmSync(outputSnapshotAbs, { force: true }); } catch {}
    try { rmSync(stderrSnapshotAbs, { force: true }); } catch {}
    try { rmSync(statusAbs, { force: true }); } catch {}
    try { rmSync(claimAbs, { force: true }); } catch {}
    try { releaseWorkspaceLease({ repoRoot: params.repoRoot, holder }); } catch {}
  };

  /**
   * Park this attempt's evidence attempt-scoped and give up the generation.
   * The winner's bytes are never read, moved, or removed; this attempt only
   * writes paths that carry its own attempt ordinal.
   */
  const concurrentLoss = (why: string): ToolExecError => {
    const parked: SynthesizedTestResult = { ...result, command: renderArgv(params.command) };
    let parkedDetails: string | null = null;
    if (detailsContent != null) {
      writeAttemptBytes(params.runDir, attemptDetailsRel, detailsContent);
      parkedDetails = attemptDetailsRel;
      parked.details_path = parkedDetails;
    }
    const parkedBody = JSON.stringify(parked, null, 2);
    writeAttemptBytes(params.runDir, attemptRel, parkedBody);
    try {
      new LedgerWriter(params.runDir).append({
        type: 'tool_failed',
        step: params.stepId,
        tool: params.toolName,
        step_execution_id: ids.stepExecutionId,
        tool_call_id: ids.toolCallId,
        attempt,
        generation,
        command: params.command,
        command_sha256: commandDigestValue,
        exit_code: parked.exit_code,
        signal: null,
        timed_out: false,
        spawn_failed: null,
        duration_ms: durationMs,
        output: attemptRel,
        output_bytes: Buffer.byteLength(parkedBody),
        output_sha256: sha256Hex(parkedBody),
        ...(parkedDetails != null
          ? {
              details_path: parkedDetails,
              details_bytes: Buffer.byteLength(detailsContent!),
              details_sha256: sha256Hex(detailsContent!),
            }
          : {}),
        status: parked.status,
        reason: 'concurrent_attribution',
        error: why,
      }, params.now ?? new Date());
    } catch (err) {
      if (err instanceof LedgerWriteError) return new ToolExecError(err.message);
      throw err;
    }
    releaseGuards();
    return new ToolExecError(`tool "${params.toolName}" generation ${generation} already attributed by another writer; recorded as attempt ${attempt} at ${attemptRel} without overwriting the planned artifact`);
  };

  /**
   * Someone else already wrote this attempt's terminal receipt.
   *
   * Only reachable if a recovery pass declared the attempt interrupted while
   * it was in fact still running. Ownership is meant to make that impossible;
   * this is the backstop that keeps the invariant true anyway — park the
   * evidence attempt-scoped and append *nothing*, because a second terminal
   * for one attempt is exactly what `tool-lifecycle` refuses forever.
   */
  const alreadyTerminated = (why: string): ToolExecError => {
    const parked: SynthesizedTestResult = { ...result, command: renderArgv(params.command) };
    if (detailsContent != null) {
      writeAttemptBytes(params.runDir, attemptDetailsRel, detailsContent);
      parked.details_path = attemptDetailsRel;
    }
    writeAttemptBytes(params.runDir, attemptRel, JSON.stringify(parked, null, 2));
    releaseGuards();
    return new ToolExecError(`tool attempt ${ids.toolCallId}:a${attempt} was already closed by another writer (${why}); this attempt's observed result is parked at ${attemptRel} and was not attributed`);
  };

  // Placement and attribution are one critical section, under the same
  // re-entrant per-run lock admission uses. Inside it "is this generation
  // attributed", "does this attempt already have a terminal", the bytes on
  // disk and the events that name them cannot drift apart — which is what
  // makes "no success receipt points at partial or foreign bytes" a property
  // rather than a small window.
  withRunLock(params.runDir, () => {
    let detailsRel: string | null = null;
    const abs = join(params.runDir, params.outputRel);
    const fresh = readEventsStrict(params.runDir);
    if (fresh.some((e) => (e.type === 'tool_completed' || e.type === 'tool_failed')
      && e.extra.tool_call_id === ids.toolCallId && e.extra.attempt === attempt)) {
      throw alreadyTerminated('a terminal receipt for this attempt is already durable');
    }
    if (plannedGenerationAttributed(fresh, params.stepId, params.outputRel, generation)) {
      throw concurrentLoss('another writer attributed this generation while the tool ran');
    }

    // The bounded details sidecar is placed first but is never given an
    // `artifact_created` of its own: only the planned TestResult may complete the
    // step. A sidecar left behind by a crashed attempt is reused when its bytes
    // match and parked attempt-scoped when they do not — so a retry can never
    // read leftovers as a concurrent winner, and bytes are never clobbered.
    if (detailsContent != null && plannedDetailsRel != null) {
      const detailsAbs = join(params.runDir, plannedDetailsRel);
      mkdirSync(dirname(detailsAbs), { recursive: true });
      const tmpDetails = `${detailsAbs}.tmp-${randomUUID()}`;
      writeFileSync(tmpDetails, detailsContent, 'utf8');
      let usePlanned: boolean;
      try {
        linkSync(tmpDetails, detailsAbs);
        usePlanned = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          rmSync(tmpDetails, { force: true });
          throw err;
        }
        usePlanned = readIfPresent(params.runDir, plannedDetailsRel) === detailsContent;
      }
      rmSync(tmpDetails, { force: true });
      detailsRel = usePlanned ? plannedDetailsRel : attemptDetailsRel;
      if (!usePlanned) writeAttemptBytes(params.runDir, attemptDetailsRel, detailsContent);
    }

    const finalResult: SynthesizedTestResult = {
      ...result,
      command: renderArgv(params.command),
      ...(detailsRel ? { details_path: detailsRel } : {}),
    };
    const schemas = new SchemaSet(runSchemaDirectories(params.runDir, params.repoRoot).snapshot, runSchemaDirectories(params.runDir, params.repoRoot).project, runSchemaDirectories(params.runDir, params.repoRoot).builtin);
    // The artifact this step promised. For a test runner that is the
    // synthesized result; for every other tool it is the bytes the tool
    // printed. `finalResult` is still built either way — it is the provenance
    // record (command, digest, exit status) that the parking and infra-failure
    // paths record, and it stays useful even when it is not the artifact.
    const artifactIsSynthesized = captureMode === 'synthesized-test-result';
    const artifactBody = artifactIsSynthesized ? finalResult : stdout;
    // Validated against whatever schema the step's artifact type names, which
    // for an untyped artifact (`Diff`, `PostResult`) is none — those are the
    // steps whose output is prose or a vendor's own JSON, and inventing a
    // schema to check them against would be inventing a contract nobody wrote.
    // `artifact_type` is only ever a SchemaKind or null — `schemaKindFor` maps
    // exactly `ReviewReport` and `TestResult` and returns null otherwise — but
    // it arrives here as a plain string, so the narrowing is done once, here,
    // rather than asserted at the call.
    const schemaKey: SchemaKind | null = artifactIsSynthesized
      ? 'test-result'
      : (SCHEMA_KINDS as readonly string[]).includes(params.artifactType ?? '')
        ? (params.artifactType as SchemaKind)
        : null;
    const validate = schemaKey == null ? null : schemas.get(schemaKey);
    const validationTarget = (() => {
      if (validate == null) return null;
      if (artifactIsSynthesized) return finalResult as unknown;
      try { return JSON.parse(stdout) as unknown; } catch { return undefined; }
    })();
    if (validate != null && validationTarget === undefined) {
      handleInfraFailure({
        repoRoot: params.repoRoot,
        runDir: params.runDir,
        runId: params.runId,
        stepId: params.stepId,
        toolName: params.toolName,
        command: params.command,
        commandDigestValue,
        outputRel: params.outputRel,
        generation,
        attempt,
        ids,
        durationMs,
        now: params.now,
        stdout,
        stderr: `tool stdout is not JSON, but the step declares artifact type "${schemaKey}"`,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnFailed: `tool stdout is not JSON, but the step declares artifact type "${schemaKey}"`,
        claimAbs,
        statusAbs,
        outputSnapshotAbs,
        stderrSnapshotAbs,
        holder,
        claimRel,
        synthesizedResult: result,
        detailsContent,
      });
      throw new ToolExecError(`tool "${params.toolName}" printed non-JSON stdout but its step declares artifact type "${schemaKey}"`);
    }
    if (validate != null && !validate(validationTarget)) {
      const msg = validate.errors?.map((e: any) => `${e.instancePath || '/'} ${e.message}`).join('; ') ?? 'validation failed';
      handleInfraFailure({
        repoRoot: params.repoRoot,
        runDir: params.runDir,
        runId: params.runId,
        stepId: params.stepId,
        toolName: params.toolName,
        command: params.command,
        commandDigestValue,
        outputRel: params.outputRel,
        generation,
        attempt,
        ids,
        durationMs,
        now: params.now,
        stdout,
        stderr: `validation failed: ${msg}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnFailed: `synthesized artifact invalid: ${msg}`,
        claimAbs,
        statusAbs,
        outputSnapshotAbs,
        stderrSnapshotAbs,
        holder,
        claimRel,
      });
      throw new ToolExecError(
        artifactIsSynthesized
          ? `synthesized TestResult failed validation: ${msg}`
          : `tool "${params.toolName}" stdout failed ${schemaKey} validation: ${msg}`,
      );
    }

    const finalBody = artifactIsSynthesized ? JSON.stringify(artifactBody, null, 2) : String(artifactBody);
    if (placeBytesExclusive(params.runDir, params.outputRel, finalBody, () => readEventsStrict(params.runDir)) === 'conflict') {
      throw concurrentLoss('the planned artifact path is already named by another writer\'s ledger entry');
    }

    // One append both attributes the planned TestResult and attests the sidecar:
    // the details digest rides in the same measured event, so attested bytes can
    // never exist without their artifact, and nothing but the planned output ever
    // emits a step-completing `artifact_created`.
    const detailsBytes = detailsRel != null && detailsContent != null ? Buffer.byteLength(detailsContent) : null;
    const detailsSha = detailsRel != null && detailsContent != null ? sha256Hex(detailsContent) : null;
    let artifactCreatedSucceeded = false;
    try {
      const artifactFields = [
        `step_execution_id=${ids.stepExecutionId}`,
        `actor_call_id=${ids.toolCallId}`,
        `attempt=${attempt}`,
        ...(detailsRel != null ? [`details_path=${detailsRel}`, `details_bytes=${detailsBytes}`, `details_sha256=${detailsSha}`] : []),
      ];
      runRun({ run: params.runId, event: 'artifact_created', artifact: params.outputRel, fields: artifactFields, repoRoot: params.repoRoot, now: params.now });
      artifactCreatedSucceeded = true;
      const writer = new LedgerWriter(params.runDir);
      writer.append({
        type: 'tool_completed',
        step: params.stepId,
        tool: params.toolName,
        step_execution_id: ids.stepExecutionId,
        tool_call_id: ids.toolCallId,
        attempt,
        generation,
        command: params.command,
        command_sha256: commandDigestValue,
        exit_code: finalResult.exit_code,
        signal: null,
        timed_out: false,
        duration_ms: durationMs,
        output: params.outputRel,
        output_bytes: Buffer.byteLength(finalBody),
        output_sha256: sha256Hex(finalBody),
        // What the tool actually emitted, next to the bounded evidence kept for
        // it — the difference is what truncation removed, and it is measured.
        ...(supervisorStatus.stdoutBytes != null ? { stdout_bytes: supervisorStatus.stdoutBytes } : {}),
        ...(supervisorStatus.stderrBytes != null ? { stderr_bytes: supervisorStatus.stderrBytes } : {}),
        ...(detailsRel != null ? { details_path: detailsRel, details_bytes: detailsBytes, details_sha256: detailsSha } : {}),
        status: finalResult.status,
      }, params.now ?? new Date());
    } catch (err) {
      // Withdraw the planned bytes only while nothing durable names them.
      // The re-read is inside the lock, so between the check and the removal
      // no writer can start naming them; without it a cleanup could delete
      // evidence a concurrent `artifact_created` had just recorded.
      if (!artifactCreatedSucceeded && !pathNamedByLedger(readEventsStrict(params.runDir), params.outputRel)) {
        // Nothing durable names the planned artifact yet, so removing it leaves
        // the step honestly retryable. The sidecar stays where it is: a retry
        // reuses it when the bytes match and parks its own when they do not —
        // and after this point the ledger names it, so it is never removed.
        try { rmSync(abs, { force: true }); } catch {}
      }
      if (err instanceof RunError || err instanceof LedgerWriteError) throw new ToolExecError(err.message);
      throw err;
    } finally {
      releaseGuards();
    }
  });

  return {
    tool: params.toolName,
    artifact: params.outputRel,
    status: result.status,
    exitCode: result.exit_code,
    attempt,
    generation,
    durationMs,
    toolCallId: ids.toolCallId,
    stepExecutionId: ids.stepExecutionId,
  };
}

function handleInfraFailure(opts: {
  repoRoot: string;
  runDir: string;
  runId: string;
  stepId: string;
  toolName: string;
  command: string[];
  commandDigestValue: string;
  outputRel: string;
  generation: number;
  attempt: number;
  ids: ToolAttemptIds;
  durationMs: number;
  now?: Date;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnFailed: string | null;
  claimAbs: string;
  statusAbs: string;
  outputSnapshotAbs: string;
  stderrSnapshotAbs: string;
  holder: { id: string; kind: 'engine'; runId: string; dispatchId: string };
  claimRel: string;
  synthesizedResult?: SynthesizedTestResult;
  detailsContent?: string | null;
}): void {
  const { result: synResult, detailsContent: synDetails } = opts.synthesizedResult && opts.detailsContent !== undefined
    ? { result: opts.synthesizedResult, detailsContent: opts.detailsContent ?? null }
    : synthesizeTestResult({
        tool: opts.toolName,
        argv: opts.command,
        stdout: opts.stdout,
        stderr: opts.stderr,
        exitCode: opts.exitCode,
        signal: opts.signal,
        timedOut: opts.timedOut,
        spawnFailed: opts.spawnFailed,
      });
  const result = synResult;
  let detailsContent = synDetails;
  const ext = extname(opts.outputRel) || '.json';
  const attemptRel = `artifacts/attempts/${opts.ids.toolCallId}-a${opts.attempt}${ext}`;
  let detailsRel: string | null = null;
  if (detailsContent != null) {
    detailsRel = `artifacts/attempts/${opts.ids.toolCallId}-a${opts.attempt}.details.txt`;
    result.details_path = detailsRel;
  }
  result.command = renderArgv(opts.command);
  // A parked error result that does not satisfy the run's schema is recorded as
  // invalid rather than thrown past: aborting here would leave the attempt with
  // no terminal receipt while still holding its claim and lease, which is the
  // one state a retry cannot recover from. The caller still raises the failure.
  const schemasInfra = new SchemaSet(runSchemaDirectories(opts.runDir, opts.repoRoot).snapshot, runSchemaDirectories(opts.runDir, opts.repoRoot).project, runSchemaDirectories(opts.runDir, opts.repoRoot).builtin);
  const validateInfra = schemasInfra.get('test-result');
  const infraValid = validateInfra(result) === true;
  const infraValidationErrors = infraValid
    ? null
    : (validateInfra.errors?.map((e: any) => `${e.instancePath || '/'} ${e.message}`) ?? ['validation failed']);
  // Infra evidence is attempt-scoped and carries its digests on the receipt
  // itself. It deliberately gets no `artifact_created`: that event completes the
  // step in the flow cursor, and a failed attempt must leave the step ready to
  // retry, not silently satisfied by a parked error result.
  if (detailsRel && detailsContent != null) {
    writeAttemptBytes(opts.runDir, detailsRel, detailsContent);
  }
  const attemptBody = JSON.stringify(result, null, 2);
  writeAttemptBytes(opts.runDir, attemptRel, attemptBody);
  const writer = new LedgerWriter(opts.runDir);
  writer.append({
    type: 'tool_failed',
    step: opts.stepId,
    tool: opts.toolName,
    step_execution_id: opts.ids.stepExecutionId,
    tool_call_id: opts.ids.toolCallId,
    attempt: opts.attempt,
    generation: opts.generation,
    command: opts.command,
    command_sha256: opts.commandDigestValue,
    exit_code: opts.exitCode,
    signal: opts.signal,
    timed_out: opts.timedOut,
    spawn_failed: opts.spawnFailed,
    duration_ms: opts.durationMs,
    output: attemptRel,
    output_bytes: Buffer.byteLength(attemptBody),
    output_sha256: sha256Hex(attemptBody),
    output_valid: infraValid,
    ...(infraValidationErrors != null ? { validation_errors: infraValidationErrors.slice(0, 5) } : {}),
    ...(detailsRel && detailsContent != null
      ? { details_path: detailsRel, details_bytes: Buffer.byteLength(detailsContent), details_sha256: sha256Hex(detailsContent) }
      : {}),
    status: result.status,
  }, opts.now ?? new Date());
  // The claim and lease are released only on this path, which is reached solely
  // after the executor is proven dead (or never spawned); the still-alive orphan
  // case throws upstream with both guards intact.
  try { rmSync(opts.outputSnapshotAbs, { force: true }); } catch {}
  try { rmSync(opts.stderrSnapshotAbs, { force: true }); } catch {}
  try { rmSync(opts.statusAbs, { force: true }); } catch {}
  try { rmSync(opts.claimAbs, { force: true }); } catch {}
  try { releaseWorkspaceLease({ repoRoot: opts.repoRoot, holder: opts.holder }); } catch {}
}

/**
 * Close every tool attempt nobody owns any more, and reclaim what they held.
 *
 * Recovery is a read-decide-then-append transaction, and the decision is the
 * part that has to be exclusive. `LedgerWriter.append` serializes seq
 * allocation, not the reasoning behind it, so two ordinary callers could both
 * read a ledger with no terminal for the same dangling attempt and then both
 * append one — the recovery-vs-recovery twin of the race locked admission
 * closed for recovery-vs-live-attempt, and it leaves the run permanently
 * unverifiable (`tool-lifecycle`: two terminal receipts for one dispatch).
 *
 * So the ledger read moves inside the same per-run lock admission takes at
 * `executeToolCore`. The lock is re-entrant and everything under it is
 * synchronous, so the nested `LedgerWriter.append` calls widen into this
 * critical section rather than deadlocking against it, and the loser observes
 * the winner's terminal receipt instead of a stale absence.
 */
export function recoverInterruptedToolDispatchesShared(
  repoRoot: string,
  runDir: string,
  runId: string,
  now: Date | undefined,
  makeError: (msg: string) => Error,
): number {
  let entered = false;
  try {
    return withRunLock(runDir, () => {
      entered = true;
      return recoverInterruptedToolDispatchesLocked(repoRoot, runDir, runId, now, makeError);
    });
  } catch (err) {
    // Only the acquisition can fail before the body runs, and a caller that
    // cannot take the lock has learned nothing about the run — report it in the
    // caller's own error type, exactly as every other precondition here does.
    // Failures from inside the body keep whatever type they already had.
    if (!entered && err instanceof LedgerWriteError) {
      throw makeError(`cannot acquire the ledger lock for recovery: ${err.message}`);
    }
    throw err;
  }
}

function recoverInterruptedToolDispatchesLocked(
  repoRoot: string,
  runDir: string,
  runId: string,
  now: Date | undefined,
  makeError: (msg: string) => Error,
): number {
  let events: ReturnType<typeof readEventsStrict>;
  try {
    events = readEventsStrict(runDir);
  } catch (err) {
    throw makeError(`cannot read ledger for recovery: ${(err as Error).message}`);
  }
  const pending = events.filter((e) => e.type === 'tool_dispatched' && typeof e.extra.tool_call_id === 'string' && typeof e.extra.attempt === 'number');
  const dangling: typeof pending = [];
  for (const event of pending) {
    const toolCallId = event.extra.tool_call_id as string;
    const attempt = event.extra.attempt as number;
    const hasTerminal = events.some((e) => (e.type === 'tool_completed' || e.type === 'tool_failed') && e.extra.tool_call_id === toolCallId && e.extra.attempt === attempt);
    if (hasTerminal) continue;
    const claimRel = typeof event.extra.supervisor_claim === 'string' ? event.extra.supervisor_claim as string : null;
    if (claimRel == null) {
      dangling.push(event);
      continue;
    }
    const expectedPrefix = `${INFLIGHT_DIR}/`;
    if (!claimRel.startsWith(expectedPrefix) || claimRel.split('/').includes('..')) {
      throw makeError(`interrupted tool attempt ${toolCallId}:a${attempt} has unsafe claim path; refusing recovery.`);
    }
    const claimAbs = join(repoRoot, ...claimRel.split('/'));
    if (existsSync(claimAbs)) {
      const claim = readInflightClaim(claimAbs, (p) => readFileSync(p, 'utf8'));
      if (claim == null) {
        throw makeError(`interrupted tool attempt ${toolCallId}:a${attempt} has unreadable claim at ${claimRel}; refusing retry until inspected.`);
      }
      // Live means owned: a supervisor, a detached executor group, or the
      // parent still writing the result. Recovery is for attempts nobody owns,
      // so leave this one entirely alone — no receipt, no claim removal, no
      // lease audit. Locked admission is the single authority on refusing a
      // live attempt, which is what makes the refusal a caller sees
      // deterministic instead of a function of how late it arrived.
      if (inflightClaimIsAlive(claim)) continue;
      rmSync(claimAbs, { force: true });
    }
    dangling.push(event);
  }
  if (dangling.length > 0) {
    let rawLease: ReturnType<typeof readWorkspaceLease> = null;
    try { rawLease = readEffectiveLease(repoRoot); } catch {}
    if (rawLease == null) {
      try {
        const candidate = readWorkspaceLease(repoRoot);
        if (candidate != null && candidate.supervisor_pid == null && candidate.executor_pid == null && candidate.process_group_id == null) {
          rawLease = candidate;
        }
      } catch {}
    }
    if (rawLease != null) {
      const danglingToolIds = new Set(
        dangling.map((event) => {
          const step = typeof event.step === 'string' ? event.step : 'unknown';
          const gen = typeof event.extra.generation === 'number' ? event.extra.generation : 1;
          return `tool:${runId}:${step}:g${gen}:a${String(event.extra.attempt)}`;
        }),
      );
      const danglingEngineIds = new Set(
        events
          .filter((e) => e.type === 'actor_dispatched' && typeof e.extra.actor_call_id === 'string' && typeof e.extra.attempt === 'number')
          .filter((e) => !events.some((t) => (t.type === 'actor_completed' || t.type === 'actor_failed') && t.extra.actor_call_id === e.extra.actor_call_id && t.extra.attempt === e.extra.attempt))
          .map((e) => `engine:${runId}:${String(e.extra.actor_call_id)}:a${String(e.extra.attempt)}`),
      );
      const allDangling = new Set([...danglingToolIds, ...danglingEngineIds]);
      if (!allDangling.has(rawLease.holder.id)) {
        try {
          const writer = new LedgerWriter(runDir);
          writer.append({
            type: 'workspace_lease_reclaim_denied',
            step: null,
            previous_holder: rawLease.holder,
            supervisor_pid: rawLease.supervisor_pid,
            reason: 'active_writer',
            recovered_at: (now ?? new Date()).toISOString(),
            by: `engine:${runId}:recovery`,
          }, now ?? new Date());
        } catch {}
        const holdersSuffix = (() => {
          const holders = (rawLease.holders?.length ?? 1) > 1 ? rawLease.holders! : [rawLease.holder];
          if (holders.length <= 1) return '';
          return ` holders: ${holders.map((h) => `"${h.id}"`).join(', ')}`;
        })();
        throw makeError(
          `shared workspace is already held by ${rawLease.holder.kind} "${rawLease.holder.id}"${holdersSuffix} (supervisor_pid ${rawLease.supervisor_pid ?? 'unknown'}, started ${rawLease.started_at}); holder "${runId}" must wait or retry. Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`,
        );
      }
      if (rawLease.supervisor_pid != null || rawLease.executor_pid != null || rawLease.process_group_id != null) {
        throw makeError(`tool attempt still has a live executor identity in ${WORKSPACE_LEASE_FILE}; refusing to reclaim its lease while the supervisor or detached executor group may still be running.`);
      }
      const previous = rawLease;
      try {
        const released = releaseWorkspaceLease({ repoRoot, holder: rawLease.holder });
        if (released) {
          try {
            const writer = new LedgerWriter(runDir);
            const reason = previous.holder.kind === 'host-dispatch' ? 'abandoned_host' : 'abandoned_engine';
            writer.append({
              type: 'workspace_lease_recovered',
              step: null,
              recovered_holder: null,
              previous_holder: previous.holder,
              supervisor_pid: previous.supervisor_pid,
              reason,
              recovered_at: (now ?? new Date()).toISOString(),
              by: `engine:${runId}:recovery`,
            }, now ?? new Date());
          } catch {}
        }
      } catch {}
    }
  }
  let recovered = 0;
  for (const event of dangling) {
    const toolCallId = event.extra.tool_call_id as string;
    const attempt = event.extra.attempt as number;
    const writer = new LedgerWriter(runDir);
    writer.append({
      type: 'tool_failed',
      step: event.step,
      tool: event.extra.tool,
      step_execution_id: event.extra.step_execution_id,
      tool_call_id: toolCallId,
      attempt,
      generation: event.extra.generation,
      command: event.extra.command,
      command_sha256: event.extra.command_sha256,
      reason: 'engine_interrupted',
      error: 'previous drive ended before recording terminal tool receipt',
      recovered: true,
      duration_ms: 0,
      exit_code: null,
      signal: null,
      timed_out: false,
    }, now ?? new Date());
    recovered += 1;
  }
  return recovered;
}

export function recoverInterruptedToolDispatchesForHelper(repoRoot: string, runDir: string, runId: string, now?: Date): number {
  return recoverInterruptedToolDispatchesShared(repoRoot, runDir, runId, now, (msg) => new ToolExecError(msg));
}

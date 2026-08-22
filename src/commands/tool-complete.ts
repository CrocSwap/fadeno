import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, rmSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runNext, NextError } from './next.ts';
import { runRun, RunError, type RunResult } from './run.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { runSchemaDirectories } from '../lib/definitions.ts';
import { resolveRun, RunLedgerError } from '../lib/run-ledger.ts';
import { SchemaSet, SCHEMA_KINDS, validateFile, type SchemaKind } from '../lib/playbook-validate.ts';
import { readEventsStrict } from '../lib/run-ledger.ts';
import { INFLIGHT_DIR, inflightClaimIsAlive, readInflightClaim } from '../lib/supervisor.ts';
import { toolAttemptIds, plannedGenerationAttributed } from '../lib/tool-exec.ts';
import { parseGeneration } from '../lib/prompt-resolve.ts';
import { isWorkspaceLeaseAlive, readEffectiveLease } from '../lib/workspace-lease.ts';

export class ToolCompleteError extends Error {}

export interface ToolCompleteOptions {
  run: string;
  output: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface ToolCompleteResult extends RunResult {
  step: string;
}

/** Atomically attribute a manual tool result to the exact next tool_call step. */
export function runToolComplete(opts: ToolCompleteOptions): ToolCompleteResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  let next;
  try {
    next = runNext({ run: opts.run, cwd: opts.cwd, repoRoot });
  } catch (err) {
    if (err instanceof NextError) throw new ToolCompleteError(err.message);
    throw err;
  }
  if (next.status !== 'ready' || next.step?.kind !== 'tool_call') {
    throw new ToolCompleteError(
      `run "${opts.run}" is not waiting at a tool_call step` +
        (next.step == null ? ` (status ${next.status}).` : `; next is ${next.step.id} (${next.step.kind}).`),
    );
  }
  if (next.step.artifact_type != null) {
    const schemaKinds = new Set<SchemaKind>(SCHEMA_KINDS);
    if (!schemaKinds.has(next.step.artifact_type as SchemaKind)) {
      throw new ToolCompleteError(`tool step "${next.step.id}" declares unsupported artifact schema "${next.step.artifact_type}".`);
    }
    let runDir: string;
    try {
      runDir = resolveRun(repoRoot, next.run).dir;
    } catch (err) {
      if (err instanceof RunLedgerError) throw new ToolCompleteError(err.message);
      throw err;
    }
    const outputPath = isAbsolute(opts.output) ? opts.output : join(runDir, opts.output);
    const schemaPaths = runSchemaDirectories(runDir, repoRoot);
    const validation = validateFile(outputPath, new SchemaSet(schemaPaths.snapshot, schemaPaths.project, schemaPaths.builtin), next.step.artifact_type as SchemaKind);
    if (!validation.ok) {
      const detail = validation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.path || '/'}: ${issue.message}`)
        .join('; ');
      throw new ToolCompleteError(`tool step "${next.step.id}" output failed ${next.step.artifact_type} validation: ${detail}`);
    }
  }
  // Fix concurrency hole: durable attempt claim so one attempt wins and ledger sequencing remains contiguous
  // Must compute same attempt namespace as helper: generation-scoped dispatch count, and scan for any live attempt claim
  let runDirForClaim: string;
  try {
    runDirForClaim = resolveRun(repoRoot, next.run).dir;
  } catch (err) {
    if (err instanceof RunLedgerError) throw new ToolCompleteError(err.message);
    throw err;
  }
  const plannedOutput = next.step.outputs?.[0] ?? opts.output;
  const generation = parseGeneration(plannedOutput).generation;
  const ids = toolAttemptIds(next.step.id, generation);
  const eventsForAttempt = readEventsStrict(runDirForClaim);
  const dispatchedCount = eventsForAttempt.filter((e) => e.type === 'tool_dispatched' && e.extra.tool_call_id === ids.toolCallId).length;
  const attempt = dispatchedCount + 1;
  const inflightDir = join(repoRoot, ...INFLIGHT_DIR.split('/'));
  if (existsSync(inflightDir)) {
    let files: string[];
    try {
      files = readdirSync(inflightDir);
    } catch (err) {
      throw new ToolCompleteError(`failed to scan inflight claims: ${(err as Error).message}`);
    }
    for (const file of files) {
      if (!file.startsWith(`tool-${next.run}-${ids.toolCallId}-a`) || !file.endsWith('.json')) continue;
      if (file.includes('.status.json')) continue;
      const abs = join(inflightDir, file);
      const claim = readInflightClaim(abs, (p) => readFileSync(p, 'utf8'));
      if (claim != null && inflightClaimIsAlive(claim)) {
        throw new ToolCompleteError(`tool attempt ${ids.toolCallId} has a live concurrent execution (claim ${file} pid ${claim.pid}); manual completion refused for generation ${generation} — wait or cancel the live attempt`);
      }
    }
  }
  // Also check workspace lease (tool execution holds lease)
  const effectiveLease = (() => { try { return readEffectiveLease(repoRoot); } catch { return null; } })();
  if (effectiveLease != null && isWorkspaceLeaseAlive(effectiveLease)) {
    if (effectiveLease.holder.id.startsWith(`tool:${next.run}:${next.step.id}:g${generation}:`)) {
      throw new ToolCompleteError(`shared workspace is already held by ${effectiveLease.holder.kind} "${effectiveLease.holder.id}" (supervisor_pid ${effectiveLease.supervisor_pid ?? 'unknown'}); manual completion for generation ${generation} must wait`);
    }
  }
  const claimRel = `${INFLIGHT_DIR}/tool-${next.run}-${ids.toolCallId}-a${attempt}.json`;
  const claimAbs = join(repoRoot, ...claimRel.split('/'));
  mkdirSync(join(repoRoot, ...INFLIGHT_DIR.split('/')), { recursive: true });
  if (existsSync(claimAbs)) {
    const existing = readInflightClaim(claimAbs, (p) => readFileSync(p, 'utf8'));
    if (existing == null) {
      throw new ToolCompleteError(`tool attempt ${ids.toolCallId}:a${attempt} has unreadable claim at ${claimRel}`);
    }
    if (inflightClaimIsAlive(existing)) {
      throw new ToolCompleteError(`tool attempt ${ids.toolCallId}:a${attempt} still has a live supervisor (pid ${existing.pid}); wait before retry`);
    }
    rmSync(claimAbs, { force: true });
  }
  {
    const nowIso = (opts.now ?? new Date()).toISOString();
    const claim = { pid: process.pid, supervisor_pid: process.pid, executor_pid: null, process_group_id: null, started_at: nowIso, heartbeat_at: nowIso, last_output_at: null, stdout_bytes: 0, stderr_bytes: 0 };
    const tmp = `${claimAbs}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify(claim), { flag: 'wx' });
      linkSync(tmp, claimAbs);
    } catch (error) {
      rmSync(tmp, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const competing = readInflightClaim(claimAbs, (p) => readFileSync(p, 'utf8'));
        throw new ToolCompleteError(`tool attempt ${ids.toolCallId}:a${attempt} already has concurrent claim (pid ${competing?.pid ?? 'unknown'})`);
      }
      throw new ToolCompleteError(`failed to publish claim for ${ids.toolCallId}:a${attempt}`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  // Same predicate the automated path uses: scoped to the planned output's
  // logical path and generation (plus this call's own output path), so derived
  // evidence like a `.details.txt` sidecar can never read as "already done".
  const fresh = readEventsStrict(runDirForClaim);
  const already =
    plannedGenerationAttributed(fresh, next.step.id, plannedOutput, generation) ||
    fresh.some((e) => e.type === 'artifact_created' && e.step === next.step!.id && e.extra.artifact === opts.output);
  if (already) {
    try { rmSync(claimAbs, { force: true }); } catch {}
    throw new ToolCompleteError(`step "${next.step!.id}" generation ${generation} already has an attributed artifact; refusing duplicate manual completion`);
  }
  const stillNext = runNext({ run: opts.run, cwd: opts.cwd, repoRoot });
  if (stillNext.step?.id !== next.step!.id || stillNext.status !== 'ready') {
    try { rmSync(claimAbs, { force: true }); } catch {}
    throw new ToolCompleteError(`run "${opts.run}" is no longer waiting at step "${next.step!.id}" (now ${stillNext.step?.id ?? stillNext.status}); concurrent attribution won`);
  }
  try {
    const result = runRun({
      run: opts.run,
      step: next.step.id,
      event: 'artifact_created',
      artifact: opts.output,
      cwd: opts.cwd,
      repoRoot,
      now: opts.now,
    });
    // The receipt. A result recorded by hand has no command, exit code, or
    // duration to measure — `tool_completed` means the kernel ran it, and
    // this path must never say so — but the delivery is still a claim the
    // ledger has to own: which tool call, which attempt, which bytes, and who
    // vouched for them. Without it the manual path emitted only the manifest,
    // so nothing anchored the artifact and renaming its manifest removed it
    // from the audit (`receipt-output-manifests` had nothing to hold). Same
    // word for the same fact as `resolved_by`/`merged_by`: the host did it.
    const manifest = result.manifest!;
    try {
      new LedgerWriter(runDirForClaim).append(
        {
          type: 'tool_recorded',
          step: next.step.id,
          tool: next.step.tool ?? null,
          step_execution_id: ids.stepExecutionId,
          tool_call_id: ids.toolCallId,
          attempt,
          generation,
          output: manifest.artifact,
          output_bytes: manifest.bytes,
          output_sha256: manifest.sha256,
          recorded_by: 'host',
        },
        opts.now ?? new Date(),
      );
    } catch (err) {
      if (err instanceof LedgerWriteError) throw new ToolCompleteError(err.message);
      throw err;
    }
    return { ...result, appendedEvents: [...result.appendedEvents, 'tool_recorded'], step: next.step.id };
  } catch (err) {
    if (err instanceof RunError) throw new ToolCompleteError(err.message);
    throw err;
  } finally {
    try { rmSync(claimAbs, { force: true }); } catch {}
  }
}

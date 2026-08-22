import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findRepoRoot } from '../lib/paths.ts';
import { resolveRun, RunLedgerError } from '../lib/run-ledger.ts';
import { LedgerWriter } from '../lib/run-ledger-write.ts';
import { runNext, NextError } from './next.ts';
import { parseSnapshotDocument, serializeSnapshot, loadExecutorProfile, ExecutorProfileError, activeHarness, type DialRef, type HarnessId } from '../lib/executors.ts';
import { readLocalDialState } from '../lib/executors.ts';
import { readUserDials, type UserPathOptions } from '../lib/user-paths.ts';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { executeToolCore, ToolExecError, recoverInterruptedToolDispatchesForHelper } from '../lib/tool-exec.ts';
import { parseGeneration } from '../lib/prompt-resolve.ts';

export class ToolRunError extends Error {}

export interface ToolRunOptions {
  run: string;
  tool?: string;
  timeout?: string;
  cwd?: string;
  repoRoot?: string;
  harness?: string;
  userPathOptions?: UserPathOptions;
  now?: Date;
}

export interface ToolRunResult {
  run: string;
  step: string;
  tool: string;
  artifact: string;
  status: string;
  exitCode: number | null;
  attempt: number;
  durationMs: number | null;
}

function parseTimeoutSeconds(value: string | undefined): number | null | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ToolRunError(`Invalid --timeout "${value}". Use a non-negative integer seconds (0 disables deadline).`);
  }
  const sec = Number(trimmed);
  if (!Number.isInteger(sec) || sec < 0) throw new ToolRunError(`Invalid --timeout "${value}". Use a non-negative integer seconds (0 disables deadline).`);
  if (sec === 0) return 0;
  return sec * 1000;
}

function ensureProfileSnapshot(repoRoot: string, runDir: string, _runId: string, now?: Date, userPathOptions?: UserPathOptions, harness?: string, bindRefs: DialRef[] = []): import('../lib/executors.ts').SnapshotDocument {
  const snapshotPath = join(runDir, 'profile.yaml');
  if (existsSync(snapshotPath)) {
    const text = readFileSync(snapshotPath, 'utf8');
    try {
      return parseSnapshotDocument(text, 'profile.yaml (run snapshot)');
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new ToolRunError(err.message);
      throw err;
    }
  }
  let liveProfile;
  try {
    liveProfile = loadExecutorProfile(repoRoot, userPathOptions ?? {}, activeHarness(harness as HarnessId | undefined, userPathOptions)).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ToolRunError(err.message);
    throw err;
  }
  // Collect extra refs: every ref in live layers + bindings + --bind refs (none for helper, but keep semantics same as drive)
  let liveLayers: { session: Record<string, DialRef>; repo: Record<string, DialRef>; user: Record<string, DialRef> };
  try {
    const state = readLocalDialState(repoRoot);
    liveLayers = { session: state.dials, repo: {}, user: {} };
    try {
      const userRaw = readUserDials(userPathOptions ?? {});
      const user: Record<string, DialRef> = {};
      for (const [k, v] of Object.entries(userRaw)) user[k] = v as DialRef;
      liveLayers.user = user;
    } catch {}
    try {
      const liveRepo = loadExecutorProfile(repoRoot, userPathOptions ?? {}, activeHarness(harness as HarnessId | undefined, userPathOptions)).profile;
      liveLayers.repo = { ...liveRepo.dials };
    } catch {}
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ToolRunError(err.message);
    throw err;
  }
  const extraRefs: DialRef[] = [...Object.values(liveLayers.session), ...Object.values(liveLayers.repo), ...Object.values(liveLayers.user), ...Object.values(liveProfile.bindings), ...bindRefs];
  const text = serializeSnapshot(liveProfile, extraRefs);
  // Atomic placement
  const tmp = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, snapshotPath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
  // The snapshot event is what makes the binding verifiable — a swallowed
  // append would leave the run's tool digests unattested and silently exempt
  // from `tool-command-digest`.
  try {
    const writer = new LedgerWriter(runDir);
    writer.append({ type: 'profile_snapshotted', step: null, profile: 'profile.yaml', bytes: Buffer.byteLength(text), sha256: sha256Hex(text) }, now ?? new Date());
  } catch (err) {
    throw new ToolRunError(`recorded the run's profile snapshot but could not attest it in the ledger: ${(err as Error).message}`);
  }
  try {
    return parseSnapshotDocument(text, 'profile.yaml (run snapshot)');
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ToolRunError(err.message);
    throw err;
  }
}

export function runToolRun(opts: ToolRunOptions): ToolRunResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const cwd = opts.cwd ?? process.cwd();
  let run;
  try {
    run = resolveRun(repoRoot, opts.run);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new ToolRunError(err.message);
    throw err;
  }
  if (run.schemaVersion !== '0.3') {
    throw new ToolRunError(`run "${run.runId}" is a legacy ledger; tool-run requires current format.`);
  }

  let next;
  try {
    next = runNext({ run: opts.run, cwd, repoRoot });
  } catch (err) {
    if (err instanceof NextError) throw new ToolRunError(err.message);
    throw err;
  }
  if (next.status !== 'ready' || next.step?.kind !== 'tool_call') {
    throw new ToolRunError(`run "${opts.run}" is not waiting at a tool_call step` + (next.step == null ? ` (status ${next.status}).` : `; next is ${next.step.id} (${next.step.kind}).`));
  }
  const step = next.step;
  const toolName = step.tool;
  if (toolName == null || toolName.length === 0) {
    throw new ToolRunError(`tool step "${step.id}" has no declared tool.`);
  }
  if (opts.tool != null && opts.tool !== toolName) {
    throw new ToolRunError(`--tool mismatch: step declares "${toolName}", but --tool is "${opts.tool}" (race guard refused before spawn).`);
  }

  const outputRel = step.outputs?.[0];
  if (outputRel == null) {
    throw new ToolRunError(`tool step "${step.id}" has no planned output path.`);
  }

  // Check live profile for registry without creating snapshot yet
  let liveProfileForCheck;
  try {
    liveProfileForCheck = loadExecutorProfile(repoRoot, opts.userPathOptions ?? {}, activeHarness(opts.harness as HarnessId | undefined, opts.userPathOptions)).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ToolRunError(err.message);
    throw err;
  }
  const specForCheck = liveProfileForCheck.tools[toolName];
  if (specForCheck == null) {
    throw new ToolRunError(`tool "${toolName}" is not registered in the tool registry; add it to .fadeno/executors.yaml under tools: { ${toolName}: { command: [...] } } or use manual \`fadeno tool-complete\`.`);
  }

  // Recover dangling attempts with same lifecycle logic as drive (audited)
  try {
    recoverInterruptedToolDispatchesForHelper(repoRoot, run.dir, run.runId, opts.now);
  } catch (err) {
    if (err instanceof ToolRunError) throw err;
    // Drive's recovery throws DriveError, helper should surface as ToolRunError
    throw new ToolRunError((err as Error).message);
  }

  const profile = ensureProfileSnapshot(repoRoot, run.dir, run.runId, opts.now, opts.userPathOptions, opts.harness);
  const spec = profile.tools[toolName];
  if (spec == null) {
    const snapshotPath = join(run.dir, 'profile.yaml');
    throw new ToolRunError(`tool "${toolName}" is registered in the live profile but absent from this run's immutable snapshot at ${snapshotPath} — this run was created before the tool was added. Use manual \`fadeno tool-complete ${run.runId} --output <artifact-path>\` for this run, or create a new run to use the registry binding.`);
  }

  const generation = parseGeneration(outputRel).generation;

  let effectiveTimeoutMs: number | null | undefined;
  const cliTimeout = parseTimeoutSeconds(opts.timeout);
  if (cliTimeout !== undefined) {
    effectiveTimeoutMs = cliTimeout === 0 ? null : cliTimeout;
  } else if (spec.timeoutMs != null) {
    effectiveTimeoutMs = spec.timeoutMs;
  } else {
    effectiveTimeoutMs = null;
  }

  try {
    const result = executeToolCore({
      repoRoot,
      runId: run.runId,
      runDir: run.dir,
      stepId: step.id,
      stepKind: step.kind,
      toolName,
      artifactType: step.artifact_type,
      outputRel,
      generation,
      loopOwner: step.loop.in_body ? step.loop.owner : null,
      iteration: step.loop.iteration,
      command: spec.command,
      effectiveTimeoutMs: effectiveTimeoutMs ?? null,
      now: opts.now,
    });
    return {
      run: run.runId,
      step: step.id,
      tool: toolName,
      artifact: result.artifact,
      status: result.status,
      exitCode: result.exitCode,
      attempt: result.attempt,
      durationMs: result.durationMs,
    };
  } catch (err) {
    if (err instanceof ToolExecError) throw new ToolRunError(err.message);
    throw err;
  }
}

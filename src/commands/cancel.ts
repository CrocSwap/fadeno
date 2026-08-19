import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { resolveRun, type RunSummary } from '../lib/run-ledger.ts';
import { INFLIGHT_DIR, readInflightClaim, inflightClaimIsAlive, type InflightClaim } from '../lib/supervisor.ts';

export class CancelError extends Error {}

export interface CancelOptions {
  run: string;
  actorCallId?: string | null;
  repoRoot?: string;
  cwd?: string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  probe?: (pid: number, signal: 0) => void;
}

export interface CancelResult {
  run: string;
  actorCallId: string;
  attempt: number;
  supervisorPid: number;
  processGroupId: number | null;
  signalledPid: number;
  resolvedBy: 'supervisor' | 'process_group' | 'executor';
}

function defaultProbe(pid: number, signal: 0): void {
  process.kill(pid, signal);
}

function parseFilenameForRun(fileName: string, runId: string): { actorCallId: string; attempt: number; prefix: string } | null {
  for (const kind of [`engine-${runId}-`, `tool-${runId}-`] as const) {
    if (!fileName.startsWith(kind) || !fileName.endsWith('.json')) continue;
    if (fileName.endsWith('.status.json')) return null;
    const withoutSuffix = fileName.slice(0, -'.json'.length);
    const remainder = withoutSuffix.slice(kind.length);
    const dashA = remainder.lastIndexOf('-a');
    if (dashA <= 0) continue;
    const actorCallId = remainder.slice(0, dashA);
    const attemptRaw = remainder.slice(dashA + 2);
    if (!/^[1-9]\d*$/.test(attemptRaw)) continue;
    const attempt = Number.parseInt(attemptRaw, 10);
    if (!Number.isInteger(attempt) || attempt <= 0) continue;
    if (actorCallId.length === 0) continue;
    return { actorCallId, attempt, prefix: kind.slice(0, -`${runId}-`.length) };
  }
  return null;
}

export function runCancel(opts: CancelOptions): CancelResult {
  const query = (opts.run ?? '').trim();
  if (query.length === 0) {
    throw new CancelError('run identifier required for cancel — provide a run id or unique prefix.');
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());

  let summary: RunSummary;
  try {
    summary = resolveRun(repoRoot, query);
  } catch (err) {
    throw new CancelError((err as Error).message);
  }
  const runId = summary.runId;

  const inflightDir = join(repoRoot, ...INFLIGHT_DIR.split('/'));
  let fileNames: string[] = [];
  if (existsSync(inflightDir)) {
    try {
      fileNames = readdirSync(inflightDir);
    } catch {
      fileNames = [];
    }
  }

  const probe = opts.probe ?? defaultProbe;
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });

  const actorCallFilter = (opts.actorCallId ?? '').trim() || null;
  const aliveMatches: Array<{ fileName: string; claim: InflightClaim; actorCallId: string; attempt: number }> = [];

  for (const fileName of fileNames) {
    const parsed = parseFilenameForRun(fileName, runId);
    if (parsed == null) continue;
    if (actorCallFilter != null && parsed.actorCallId !== actorCallFilter) continue;
    const abs = join(inflightDir, fileName);
    const claim = readInflightClaim(abs, (p) => readFileSync(p, 'utf8'));
    if (claim == null) continue;
    if (!inflightClaimIsAlive(claim, probe)) continue;
    aliveMatches.push({ fileName, claim, actorCallId: parsed.actorCallId, attempt: parsed.attempt });
  }

  if (aliveMatches.length === 0) {
    if (actorCallFilter != null) {
      throw new CancelError(
        `run "${runId}" has no live claim for actor_call_id "${actorCallFilter}" on this machine — nothing to cancel. ` +
          'Check the actor_call_id and that the executor is still running.',
      );
    }
    throw new CancelError(
      `run "${runId}" has no live claim on this machine — nothing to cancel. ` +
        'The run may have no active attempt, or the executor already terminated. ' +
        'Re-run drive to see if there is a dangling attempt whose claim was removed, or inspect the ledger.',
    );
  }
  if (aliveMatches.length > 1 && actorCallFilter == null) {
    const ids = aliveMatches.map((m) => `${m.actorCallId}:a${m.attempt}`).join(', ');
    throw new CancelError(
      `run "${runId}" has multiple live claims (${aliveMatches.length}): ${ids} — ` +
        'refusing to guess which to cancel. Cancel a single claim by its actor_call_id when this occurs, or wait for one to terminate.',
    );
  }

  const matched = aliveMatches[0]!;
  const claim = matched.claim;
  const supervisorPid = claim.supervisorPid ?? claim.pid;
  const processGroupId = claim.processGroupId;
  const executorPid = claim.executorPid;

  const alive = (pid: number): boolean => {
    try {
      probe(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };

  let targetPid: number | null = null;
  let resolvedBy: CancelResult['resolvedBy'] | null = null;

  if (alive(supervisorPid)) {
    targetPid = supervisorPid;
    resolvedBy = 'supervisor';
  } else if (processGroupId != null && alive(-processGroupId)) {
    targetPid = -processGroupId;
    resolvedBy = 'process_group';
  } else if (executorPid != null && alive(executorPid)) {
    targetPid = executorPid;
    resolvedBy = 'executor';
  }

  if (targetPid == null || resolvedBy == null) {
    throw new CancelError(
      `run "${runId}" has a stale in-flight claim for ${matched.actorCallId}:a${matched.attempt} but no live supervisor or executor group. ` +
        'Nothing was signalled; the claim may need manual inspection or a dead-supervisor recovery path.',
    );
  }

  try {
    kill(targetPid, 'SIGTERM');
  } catch (err) {
    throw new CancelError(
      `could not signal the executor for run "${runId}" ${matched.actorCallId}:a${matched.attempt} (pid ${targetPid}): ${(err as Error).message}`,
    );
  }

  // Never write the ledger; the active engine remains sole writer.
  // Do not remove claim or release lease here — that is proven only at executor close.

  return {
    run: runId,
    actorCallId: matched.actorCallId,
    attempt: matched.attempt,
    supervisorPid,
    processGroupId,
    signalledPid: targetPid,
    resolvedBy,
  };
}

// Alias for integrator flexibility; CLI wiring may import either.
export const runEngineCancel = runCancel;

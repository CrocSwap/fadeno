import { resolve } from 'node:path';
import {
  HostDispatchError,
  hostRequestTerminalState,
  isDuplicateStartError,
  readHostDispatchRequest,
} from '../lib/host-dispatch.ts';
import { prepareHostWorkspace } from '../lib/host-workspace.ts';
import { findRepoRoot } from '../lib/paths.ts';

export class DispatchPrepareError extends Error {}

function alreadyStartedMessage(dispatchId: string): string {
  return `host dispatch "${dispatchId}" already started; it cannot be prepared for isolated delivery.`;
}

/**
 * A withdraw is terminal like a completion, but unlike a completion it is
 * RETRYABLE — the work still has to happen, under a request that has not been
 * withdrawn. The generic "already has a terminal receipt" would hide that
 * difference, and this message is the only place it reaches the operator.
 */
function withdrawnMessage(dispatchId: string, run: string): string {
  return (
    `host dispatch "${dispatchId}" was withdrawn; a withdrawn request is never delivered, ` +
    `so no workspace is prepared for it. Run \`fadeno drive ${run}\` to mint a fresh request ` +
    `for the same actor call, then prepare that dispatch id.`
  );
}

export interface DispatchPrepareOptions {
  run: string;
  dispatchId: string;
  isolate: boolean;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface DispatchPrepareResult {
  run: string;
  dispatchId: string;
  workspaceMode: 'isolated';
  /** Repo-relative. */
  workspace: string;
  /** Absolute — this is what the delivery header names. */
  workspaceAbs: string;
  baseCommit: string;
  preparedAt: string;
  idempotent: boolean;
}

export function runDispatchPrepare(opts: DispatchPrepareOptions): DispatchPrepareResult {
  if (!opts.isolate) {
    throw new DispatchPrepareError('dispatch-prepare requires --isolate; no other preparation mode exists.');
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const run = opts.run?.trim();
  const dispatchId = opts.dispatchId?.trim();
  if (!run || !dispatchId) {
    throw new DispatchPrepareError('dispatch-prepare needs <run> and <dispatch-id>.');
  }
  let lookup;
  try {
    lookup = readHostDispatchRequest({ run, dispatchId, repoRoot, cwd });
  } catch (err) {
    if (err instanceof HostDispatchError) {
      if (isDuplicateStartError(err)) {
        throw new DispatchPrepareError(alreadyStartedMessage(dispatchId));
      }
      throw new DispatchPrepareError(err.message);
    }
    throw err;
  }
  // One reading of "what happened to this request", shared with `show` and the
  // receipt writers, rather than a local list of terminal event types that has
  // to be taught about each new receipt separately — which is exactly how a
  // withdrawn request kept earning a worktree nothing could ever start.
  const lifecycle = hostRequestTerminalState(lookup.events, dispatchId);
  if (lifecycle === 'withdrawn') {
    throw new DispatchPrepareError(withdrawnMessage(dispatchId, lookup.runId));
  }
  if (lifecycle === 'completed' || lifecycle === 'failed') {
    throw new DispatchPrepareError(`host dispatch "${dispatchId}" already has a terminal receipt; it cannot be prepared for isolated delivery.`);
  }
  if (lifecycle === 'started') {
    throw new DispatchPrepareError(alreadyStartedMessage(dispatchId));
  }
  const { state, idempotent } = prepareHostWorkspace({ repoRoot, run: lookup.runId, dispatchId, now: opts.now });
  const workspaceAbs = resolve(repoRoot, state.workspace);
  return {
    run: state.run,
    dispatchId: state.dispatch_id,
    workspaceMode: 'isolated',
    workspace: state.workspace,
    workspaceAbs,
    baseCommit: state.base_commit,
    preparedAt: state.prepared_at,
    idempotent,
  };
}

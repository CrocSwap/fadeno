import { resolve } from 'node:path';
import { HostDispatchError, isDuplicateStartError, readHostDispatchRequest } from '../lib/host-dispatch.ts';
import { prepareHostWorkspace } from '../lib/host-workspace.ts';
import { findRepoRoot } from '../lib/paths.ts';

export class DispatchPrepareError extends Error {}

function alreadyStartedMessage(dispatchId: string): string {
  return `host dispatch "${dispatchId}" already started; it cannot be prepared for isolated delivery.`;
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
  const events = lookup.events;
  const starts = events.filter((event) => event.type === 'actor_dispatched' && event.extra.dispatch_id === dispatchId);
  const terminals = events.filter(
    (event) => (event.type === 'actor_completed' || event.type === 'actor_failed') && event.extra.dispatch_id === dispatchId,
  );
  if (terminals.length > 0) {
    throw new DispatchPrepareError(`host dispatch "${dispatchId}" already has a terminal receipt; it cannot be prepared for isolated delivery.`);
  }
  if (starts.length > 0) {
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

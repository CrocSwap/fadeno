import { HostDispatchError, withdrawHostDispatch, type HostDispatchWithdrawReceipt } from '../lib/host-dispatch.ts';
import { findRepoRoot } from '../lib/paths.ts';

export class DispatchWithdrawError extends Error {}

export interface DispatchWithdrawOptions {
  run: string;
  dispatchId: string;
  reason: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export type DispatchWithdrawResult = HostDispatchWithdrawReceipt;

/**
 * Record the terminal receipt for a host request that was minted and never
 * started, so `drive` can mint the next attempt under the current binding.
 *
 * The command is a thin edge over `withdrawHostDispatch`: every precondition
 * lives in the library beside the other receipt writers, because they share
 * the ledger reads that decide them and a second copy here would be a second
 * answer to the same question.
 */
export function runDispatchWithdraw(opts: DispatchWithdrawOptions): DispatchWithdrawResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const run = opts.run?.trim();
  const dispatchId = opts.dispatchId?.trim();
  if (!run || !dispatchId) {
    throw new DispatchWithdrawError('dispatch-withdraw needs <run> and <dispatch-id>.');
  }
  try {
    return withdrawHostDispatch({ run, dispatchId, reason: opts.reason ?? '', repoRoot, cwd, now: opts.now });
  } catch (err) {
    if (err instanceof HostDispatchError) throw new DispatchWithdrawError(err.message);
    throw err;
  }
}

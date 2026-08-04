import {
  completeHostDispatch,
  failHostDispatch,
  startHostDispatch,
  type DispatchCompleteOptions,
  type DispatchFailOptions,
  type DispatchStartOptions,
  type HostDispatchReceipt,
} from '../lib/host-dispatch.ts';

export class DispatchCommandError extends Error {}

export function runDispatchStart(opts: DispatchStartOptions): HostDispatchReceipt {
  try {
    return startHostDispatch(opts);
  } catch (err) {
    if (err instanceof Error) throw new DispatchCommandError(err.message);
    throw err;
  }
}

export function runDispatchComplete(opts: DispatchCompleteOptions): HostDispatchReceipt {
  try {
    return completeHostDispatch(opts);
  } catch (err) {
    if (err instanceof Error) throw new DispatchCommandError(err.message);
    throw err;
  }
}

export function runDispatchFail(opts: DispatchFailOptions): HostDispatchReceipt {
  try {
    return failHostDispatch(opts);
  } catch (err) {
    if (err instanceof Error) throw new DispatchCommandError(err.message);
    throw err;
  }
}

import { runDispatchFallback as impl } from './dispatch.ts';
import type { DispatchFallbackOptions, DispatchFallbackResult } from './dispatch.ts';

export function runDispatchFallback(opts: DispatchFallbackOptions): DispatchFallbackResult {
  return impl(opts);
}

export type { DispatchFallbackOptions, DispatchFallbackResult } from './dispatch.ts';

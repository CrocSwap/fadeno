import type { RunEvent } from './run-ledger.ts';
import type { Playbook, PlaybookStep } from './prompt-resolve.ts';

/**
 * Canonical loop/generation scoping over a run ledger.
 *
 * Both drivers (`fadeno drive` and the `fadeno tool-run` helper) have to answer
 * the same two questions before they touch a step: which loop owns it, and has
 * *this* iteration already been started? Keeping the answers in one module is
 * what makes a retry inside a generation idempotent — a second `step_started`
 * for the same generation silently shifts `fadeno prompt`'s invocation number
 * and makes the ledger read as two attempts at different iterations.
 */

/** The loop step whose `body` contains `stepId`, or null for an outer step. */
export function bodyOwnerOf(playbook: Playbook, stepId: string): string | null {
  const flow = Array.isArray(playbook.flow) ? (playbook.flow as PlaybookStep[]) : [];
  for (const step of flow) {
    if (step.kind !== 'loop' || !Array.isArray(step.body)) continue;
    if ((step.body as unknown[]).includes(stepId) && typeof step.id === 'string') return step.id;
  }
  return null;
}

/** How many iterations of `loopId` have been recorded. */
export function countIterationStarts(events: RunEvent[], loopId: string): number {
  return events.filter((e) => e.type === 'loop_iteration_started' && e.step === loopId).length;
}

/** Index just past the Gth iteration start of `loopId`, or 0 for outer scope. */
export function scopeStartIndex(events: RunEvent[], loopId: string | null, generation: number): number {
  if (loopId == null) return 0;
  let seen = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === 'loop_iteration_started' && events[i]!.step === loopId) {
      seen += 1;
      if (seen === generation) return i;
    }
  }
  return 0;
}

/** Has `stepId` been started at or after `from` (the scope's first index)? */
export function stepStartedInScope(events: RunEvent[], stepId: string, from: number): boolean {
  for (let i = from; i < events.length; i += 1) {
    if (events[i]!.type === 'step_started' && events[i]!.step === stepId) return true;
  }
  return false;
}

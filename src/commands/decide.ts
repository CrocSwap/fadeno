import { findRepoRoot } from '../lib/paths.ts';
import { readEventsStrict, resolveRun, RunLedgerError } from '../lib/run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';

export class DecideError extends Error {}

/**
 * Resolve a durable named decision (`decision_requested` → `decision_resolved`).
 * One structure for every human decision: named options, first valid
 * resolution wins, identical re-submissions are idempotent, conflicting ones
 * are refused (and fail verification if forced onto the ledger by hand).
 */
export interface DecideOptions {
  run: string;
  /** One of the request's declared options. */
  option: string;
  /** Decision id; optional when exactly one decision is pending. */
  decision?: string;
  feedback?: string;
  /** Recorded as resolution provenance (default "user"). */
  by?: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface DecideResult {
  run: string;
  decisionId: string;
  step: string | null;
  option: string;
  recorded: 'resolved' | 'idempotent';
}

interface DecisionRequest {
  decisionId: string;
  step: string | null;
  options: string[];
}

export function runDecide(opts: DecideOptions): DecideResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);

  let run;
  try {
    run = resolveRun(repoRoot, opts.run);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new DecideError(err.message);
    throw err;
  }

  // Version gate (and the appender) in one: a legacy ledger is refused here.
  let writer: LedgerWriter;
  try {
    writer = new LedgerWriter(run.dir);
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new DecideError(err.message);
    throw err;
  }

  let events;
  try {
    events = readEventsStrict(run.dir);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new DecideError(err.message);
    throw err;
  }

  const requests = new Map<string, DecisionRequest>();
  for (const event of events) {
    if (event.type !== 'decision_requested') continue;
    const id = event.extra.decision_id;
    if (typeof id !== 'string' || requests.has(id)) continue; // duplicate ids are verify's problem
    const options = Array.isArray(event.extra.options)
      ? event.extra.options.filter((o): o is string => typeof o === 'string')
      : [];
    requests.set(id, { decisionId: id, step: event.step, options });
  }
  if (requests.size === 0) {
    throw new DecideError(`run "${run.runId}" has no decision_requested to resolve.`);
  }

  const resolutions = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'decision_resolved') continue;
    const id = event.extra.decision_id;
    const option = event.extra.option;
    if (typeof id === 'string' && typeof option === 'string' && !resolutions.has(id)) {
      resolutions.set(id, option); // first valid resolution wins
    }
  }

  let request: DecisionRequest;
  if (opts.decision != null) {
    const found = requests.get(opts.decision);
    if (found == null) {
      throw new DecideError(
        `no decision_requested with id "${opts.decision}" (known: ${[...requests.keys()].join(', ')}).`,
      );
    }
    request = found;
  } else {
    const pending = [...requests.values()].filter((r) => !resolutions.has(r.decisionId));
    if (pending.length === 1) {
      request = pending[0]!;
    } else if (pending.length === 0) {
      throw new DecideError(
        'no pending decision; every request is already resolved (pass --decision <id> to target one).',
      );
    } else {
      throw new DecideError(
        `multiple decisions pending: ${pending.map((r) => r.decisionId).join(', ')} — pass --decision <id>.`,
      );
    }
  }

  if (!request.options.includes(opts.option)) {
    throw new DecideError(
      `"${opts.option}" is not an option of ${request.decisionId} (declared: ${request.options.join(', ')}).`,
    );
  }

  const existing = resolutions.get(request.decisionId);
  if (existing != null) {
    if (existing === opts.option) {
      return {
        run: run.runId,
        decisionId: request.decisionId,
        step: request.step,
        option: opts.option,
        recorded: 'idempotent',
      };
    }
    throw new DecideError(
      `${request.decisionId} is already resolved as "${existing}"; refusing the conflicting "${opts.option}". ` +
        'Decisions are durable — supersede the workflow, not the record.',
    );
  }

  const event: Record<string, unknown> = {
    type: 'decision_resolved',
    step: request.step,
    decision_id: request.decisionId,
    option: opts.option,
    resolved_by: opts.by ?? 'user',
  };
  if (opts.feedback != null && opts.feedback !== '') event.feedback = opts.feedback;
  writer.append(event, opts.now ?? new Date());

  return {
    run: run.runId,
    decisionId: request.decisionId,
    step: request.step,
    option: opts.option,
    recorded: 'resolved',
  };
}

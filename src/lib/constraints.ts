import { spawnSync } from 'node:child_process';
import { atCwd } from './executors.ts';
import type { ExecutorProfile, SnapshotDocument, WritePosture } from './executors.ts';

/**
 * Tier-2 constraint command: a profile-declared argv run at the dispatch
 * boundary with the resolution context on stdin. Exit 0 allows, exit 2
 * refuses, anything else is a constraint-system error (never an allow).
 */
export class ConstraintError extends Error {}

export interface ConstraintContext {
  archetype: string | null;
  role: string | null;
  executor: string;
  driver: string | null;
  provider: string | null;
  model: string | null;
  model_id: string | null;
  transport: 'command' | 'host';
  write_access: boolean | null;
  /** True when the delivery is the route's write variant, selected because a
   * `requires_write: required` archetype resolved onto a read-only base. */
  write_variant?: boolean;
  write_posture: WritePosture | null;
  dial: { model: string; effort?: string; via?: string } | null;
  dial_source: string | null;
  dials: {
    session: Record<string, string>;
    repo: Record<string, string>;
    user: Record<string, string>;
  };
  resolved_via: string | null;
  input_provenance: Array<{
    dispatch_id: string | null;
    executor: string | null;
    provider: string | null;
  }>;
  harness: string;
  /** Present and true when this resolution is a shadow duplicate, so a
   * project constraint can treat challengers differently from primaries. */
  shadow?: boolean;
}

export type ConstraintVerdict =
  | { verdict: 'allowed' }
  | { verdict: 'refused'; reason: string };

const REFUSED_NO_STDERR = 'constraint command refused the dispatch (no reason on stderr)';

function commandLabel(command: string[]): string {
  return JSON.stringify(command);
}

export function evaluateConstraint(
  profile: ExecutorProfile | SnapshotDocument,
  context: ConstraintContext,
  opts: { cwd: string; spawn?: typeof spawnSync },
): ConstraintVerdict {
  if (profile.constraints == null) return { verdict: 'allowed' };
  const command = profile.constraints.command;
  const bin = command[0];
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new ConstraintError(`constraint command ${commandLabel(command)} is missing or empty`);
  }

  const spawn = opts.spawn ?? spawnSync;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawn(bin, command.slice(1), {
      cwd: opts.cwd,
      env: atCwd(process.env, opts.cwd),
      input: JSON.stringify(context),
      encoding: 'utf8',
    });
  } catch (err) {
    throw new ConstraintError(
      `constraint command ${commandLabel(command)} failed to spawn: ${(err as Error).message}`,
    );
  }

  if (result.error != null) {
    throw new ConstraintError(
      `constraint command ${commandLabel(command)} failed to spawn: ${result.error.message}`,
    );
  }
  if (result.signal != null) {
    throw new ConstraintError(
      `constraint command ${commandLabel(command)} terminated by signal ${result.signal}`,
    );
  }
  if (result.status === 0) return { verdict: 'allowed' };
  if (result.status === 2) {
    const stderr = result.stderr == null ? '' : String(result.stderr).trim();
    return { verdict: 'refused', reason: stderr.length > 0 ? stderr : REFUSED_NO_STDERR };
  }
  throw new ConstraintError(
    `constraint command ${commandLabel(command)} exited ${result.status ?? '?'}`,
  );
}

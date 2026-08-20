import { BARE_IDENTIFIER_RE } from '../lib/executors.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { appendEvidenceRow, DISPATCHES_FORMAT } from './dispatch.ts';

export class AttestCommandError extends Error {}

export interface AttestOptions {
  /** The archetype this subagent was told it is (`worker` | `reviewer` | `judge`, or another declared archetype). */
  archetype: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
  /** Testability seam for what would otherwise read `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Testability seam for what would otherwise read `process.pid`. */
  pid?: number;
}

export type EffortEvidence = 'measured' | 'unavailable';

export interface AttestResult {
  archetype: string;
  /** The measured, post-downgrade `CLAUDE_EFFORT`, or null when unmeasurable. */
  effort: string | null;
  /** Never silently omitted: says explicitly whether `effort` was measured. */
  effortEvidence: EffortEvidence;
  pid: number;
  cwd: string;
  fadenoVersion: string;
  /**
   * Model has no equivalent measurement channel and is never inferred by
   * asking the model itself (this codebase's gate discipline forbids
   * anything load-bearing that asks an LLM). This row makes no model claim
   * of its own; the label says any model attribution for this delivery
   * surfaced elsewhere (a correlated `host_delivery` row) stays request-only.
   */
  identityEvidence: 'requested_only';
  timestamp: string;
}

/**
 * Measure this subagent's own delivered identity from INSIDE itself and
 * record it as a `host_attestation` row in `.fadeno/dispatches.jsonl`.
 *
 * The problem this closes: a `host_delivery` row is written by the Claude
 * PreToolUse steering hook, in the PARENT, BEFORE the subagent runs — every
 * field on it is a REQUEST, never a measurement. Effort is the one identity
 * component a subagent can actually measure about ITSELF: the harness
 * publishes the turn's resolved reasoning effort to `CLAUDE_EFFORT` in Bash,
 * already resolved past any silent per-model or per-organization downgrade
 * (docs/experimental/slots-and-archetypes.md, "Steering restart" — "Effort is
 * requested, not guaranteed"). A dial asking for `xhigh` can land lower with
 * nothing raised on the request-side row; this is the only way to see that
 * from the delivery itself rather than by reading the harness's own private
 * transcript.
 *
 * Model is deliberately NOT recorded here — there is no equivalent
 * environment variable, and this command does not ask the model to
 * self-report its own name (asking an LLM for something load-bearing is
 * forbidden by this codebase's gate discipline; see AGENTS.md, "Gate
 * discipline"). `identity_evidence: 'requested_only'` on the row makes that
 * admission explicit, reusing the exact spelling `SteeringResolution`
 * already uses for the same admission (`src/commands/steering.ts`) rather
 * than inventing a new one.
 *
 * Correlation to the `host_delivery` row this attests is deliberately left
 * to the READER (`runDispatches` in `src/commands/dispatches.ts`), not
 * written here: this process has neither the parent's prompt digest (the
 * subagent never sees it — injecting one into the prompt would make prompt
 * bytes vary per spawn, which shadow pairs depend on NOT happening) nor the
 * parent's session id (its own differs). Archetype plus append order is all
 * a reader can use — nearest preceding unattested `host_delivery` of the
 * same archetype — and that match is a best-effort correlation, not a
 * guaranteed one; see the long comment on that matching logic in
 * `dispatches.ts` for its honest precision limits.
 */
export function runAttest(opts: AttestOptions): AttestResult {
  const archetype = (opts.archetype ?? '').trim();
  if (archetype === '') {
    throw new AttestCommandError(
      'fadeno attest needs --archetype <a> — the archetype this subagent was told it is.',
    );
  }
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new AttestCommandError(
      `--archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`,
    );
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const pid = opts.pid ?? process.pid;

  // Published by the harness to hook commands AND Bash — a subagent's own
  // Bash calls see it too — already resolved past any silent downgrade. This
  // measurement is the whole reason this command exists: `host_delivery` can
  // only record what was ASKED for; this is measured from inside the
  // delivery itself, after whatever the harness or the model's org did to it.
  const rawEffort = typeof env.CLAUDE_EFFORT === 'string' ? env.CLAUDE_EFFORT.trim() : '';
  const effort = rawEffort !== '' ? rawEffort : null;
  const effortEvidence: EffortEvidence = effort != null ? 'measured' : 'unavailable';

  const timestamp = now.toISOString();
  appendEvidenceRow(repoRoot, {
    format: DISPATCHES_FORMAT,
    timestamp,
    event: 'host_attestation',
    archetype,
    effort,
    // Never silently omitted: a reader must not have to guess whether a null
    // `effort` here means "measured as nothing" or "this row predates the
    // field" — the sibling field says which, explicitly, every time.
    effort_evidence: effortEvidence,
    pid,
    cwd,
    identity_evidence: 'requested_only',
  });

  return {
    archetype,
    effort,
    effortEvidence,
    pid,
    cwd,
    fadenoVersion: packageVersion(),
    identityEvidence: 'requested_only',
    timestamp,
  };
}

/**
 * The `ModelComparison` artifact contract — one list, every consumer.
 *
 * The reader shipped before any writer existed, so the vocabulary lived as a
 * literal inside `dispatches.ts`'s private parser AND, separately, as three
 * hardcoded tally buckets in the scorecard. Adding a verdict to one and not
 * the other produces an artifact that validates and then vanishes from the
 * count: valid, included in `comparisons`, present in no bucket, with nothing
 * saying the numbers stopped adding up. This module exists so that cannot
 * happen again — the same one-list-two-consumers shape this codebase keeps
 * paying for.
 */

/**
 * `graft` is not a fifth wheel. Across the first two complete shadow pairs the
 * honest answer was NEITHER arm, both times: pair 49a1f92a's challenger wrote
 * 65% more code, and its whole unique value was a doc amendment plus a drift
 * tripwire (~20 lines) sitting on top of a duplicated rule; pair 89536181's
 * primary was better organized and better tested against a value no caller
 * could see. Shipping only `prefer_baseline | prefer_challenger` forces a
 * judge to name a winner it does not believe in, and the cost is concrete —
 * you lose either the tripwire or you ship the duplication.
 */
export const MODEL_COMPARISON_VERDICTS = [
  'prefer_baseline',
  'prefer_challenger',
  'graft',
  'tie',
  'inconclusive',
] as const;

export type ModelComparisonVerdict = (typeof MODEL_COMPARISON_VERDICTS)[number];

export function isModelComparisonVerdict(value: unknown): value is ModelComparisonVerdict {
  return typeof value === 'string' && (MODEL_COMPARISON_VERDICTS as readonly string[]).includes(value);
}

/**
 * How a verdict is counted in the running scorecard. Derived from the
 * vocabulary rather than restated, so a new verdict cannot be silently
 * uncounted: adding one here is a type error until it is given a bucket.
 */
export const VERDICT_BUCKET: Record<ModelComparisonVerdict, 'challenger' | 'baseline' | 'graft' | 'neither'> = {
  prefer_challenger: 'challenger',
  prefer_baseline: 'baseline',
  graft: 'graft',
  tie: 'neither',
  inconclusive: 'neither',
};

/**
 * Body sections every artifact must carry.
 *
 * `Confounds` was mandatory from the design sketch (the erdosSweep tier-4
 * lesson: undisclosed scaffold differences contaminate form-level judgments).
 * `Shared blind spots` is mandatory because agreement between two arms is not
 * evidence — pair 89536181's arms BOTH matched a Codex agent on model and
 * effort while never checking the role slot, so a reviewer dispatch was
 * advised to delegate to the worker agent, which refuses it. Both arms' tests
 * used the same single-archetype fixture, so no A-vs-B comparison could ever
 * have surfaced it. A section that is sometimes present is a section a judge
 * learns to skip.
 */
export const MODEL_COMPARISON_REQUIRED_SECTIONS = ['Criteria', 'Confounds', 'Shared blind spots'] as const;

/**
 * One instruction in a graft plan: take THIS from THAT arm, for a stated
 * reason.
 *
 * Prose, not hunks. A judge that mis-names a hunk produces a patch that looks
 * authoritative and corrupts the tree, and the two grafts performed so far
 * were both a human reading a short rationale and acting on it. `paths` is
 * optional and advisory — a place to put what is known, never something an
 * applier may trust blindly.
 */
export interface GraftStep {
  /**
   * Which arm the material comes from, in the ARTIFACT's frame (`primary` /
   * `challenger`). The judge writes `a` / `b`; unblinding happens once, at
   * render time, so a blinded judgment can never leak an arm's identity back
   * into its own reasoning.
   */
  from_arm: 'primary' | 'challenger';
  what: string;
  why: string;
  paths?: string[];
}

export interface ModelComparisonFrontmatter {
  kind: 'ModelComparison';
  baseline: string;
  challenger: string;
  verdict: ModelComparisonVerdict;
  date: string;
  dispatch_ids?: string[];
  pair_id?: string;
  graft_plan?: GraftStep[];
}

export type ModelComparisonError =
  | 'unreadable'
  | 'missing frontmatter'
  | 'invalid yaml'
  | 'invalid frontmatter'
  | 'invalid verdict'
  | 'missing required sections'
  | 'graft without a plan'
  | 'plan without a graft verdict';

/**
 * Why `graft` and `graft_plan` are checked in BOTH directions.
 *
 * A `graft` verdict with no plan is a judge saying "take the best of both" and
 * naming nothing — unactionable, and indistinguishable from a considered
 * result when skimmed in a scorecard. A plan under any other verdict is a
 * judge contradicting itself, and accepting either half quietly is precisely
 * how a wrong answer comes to look right. Both are rejected at parse, so the
 * scorecard never renders one.
 */
export function checkGraftCoherence(
  verdict: ModelComparisonVerdict,
  plan: GraftStep[] | undefined,
): ModelComparisonError | null {
  const hasPlan = Array.isArray(plan) && plan.length > 0;
  if (verdict === 'graft' && !hasPlan) return 'graft without a plan';
  if (verdict !== 'graft' && hasPlan) return 'plan without a graft verdict';
  return null;
}

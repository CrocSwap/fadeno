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
/**
 * A duration as a human quantity, for the two places that COMPARE two arms'
 * time-to-complete: the scorecard a person reads, and the prompt the judge
 * reads. It lived only in `dispatches.ts` while the judge prompt printed raw
 * milliseconds — `duration: 2195108ms`, which a reader has to divide by 60000
 * before it means anything, in the one document whose entire job is holding
 * two numbers side by side.
 *
 * Sub-second precision is kept because it is a comparison: two arms that
 * differ by 400ms differ, and rounding both to `0s` erases that. This is NOT
 * the same function as `cli.ts`'s `formatDuration`, which reports live
 * progress at second granularity and would call both arms `36m 35s`.
 */
export function formatBakeoffDuration(ms: number | null): string {
  if (ms == null) return '?';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * A code fence long enough that nothing inside the block can close it.
 *
 * An arm's diff is written by a model working on an attacker-influenceable
 * task, and it is embedded in the judge prompt inside a ```diff block. A
 * content line that is itself a bare fence ends the block early, and every
 * byte after it stops being quoted evidence and becomes prompt: a crafted
 * diff could close the fence and then write its own `### arm_b` section, its
 * own `## Your task`, or an instruction to prefer one arm. Opening with a
 * fence longer than the longest run inside makes that unrepresentable rather
 * than merely unlikely — CommonMark closes a fence only with one at least as
 * long as the opener.
 *
 * Real `git diff` output prefixes content lines with `+`/`-`/space, which
 * already defeats the naive case. This does not rely on that: the text
 * reaching here has been through hunk-stripping and byte truncation, and
 * "the input is still well-formed" is the assumption that makes injection
 * bugs.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/^ {0,3}(`{3,})/gm)) {
    longest = Math.max(longest, match[1]!.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

export const BAKEOFF_VERDICTS = [
  'prefer_baseline',
  'prefer_challenger',
  'graft',
  'tie',
  'inconclusive',
] as const;

export type BakeoffVerdict = (typeof BAKEOFF_VERDICTS)[number];

/**
 * What a BLINDED judge may emit. The artifact vocabulary above is the frame
 * the judge does not have.
 *
 * These must be different lists, and conflating them shipped a real defect.
 * The judgment schema originally reused `prefer_baseline` / `prefer_challenger`
 * while the prompt told the judge it sees only `arm_a` / `arm_b` and does "not
 * know" which is which — so the one field that decides the outcome was the one
 * field the judge was structurally unable to answer. It answered anyway (a
 * judge reading "baseline" reasons about baselines), and the kernel passed the
 * value through verbatim, so a blinding that swapped the arms would have
 * recorded the exact inverse of the judge's own reasoning.
 *
 * Caught on the first real adjudication — by the judge, about the code being
 * judged. Its verdict was correct only because that pair's blinding happened
 * to be the identity mapping.
 */
export const JUDGMENT_VERDICTS = ['prefer_a', 'prefer_b', 'graft', 'tie', 'inconclusive'] as const;

export type JudgmentVerdict = (typeof JUDGMENT_VERDICTS)[number];

export function isJudgmentVerdict(value: unknown): value is JudgmentVerdict {
  return typeof value === 'string' && (JUDGMENT_VERDICTS as readonly string[]).includes(value);
}

/**
 * Translate a blinded judgment verdict into the artifact's frame. The single
 * place a verdict is unblinded, alongside `graft_plan.from_arm`.
 */
export function unblindVerdict(
  verdict: JudgmentVerdict,
  blinding: { a: 'primary' | 'challenger'; b: 'primary' | 'challenger' },
): BakeoffVerdict {
  if (verdict !== 'prefer_a' && verdict !== 'prefer_b') return verdict;
  const preferred = verdict === 'prefer_a' ? blinding.a : blinding.b;
  return preferred === 'primary' ? 'prefer_baseline' : 'prefer_challenger';
}

export function isBakeoffVerdict(value: unknown): value is BakeoffVerdict {
  return typeof value === 'string' && (BAKEOFF_VERDICTS as readonly string[]).includes(value);
}

/**
 * How a verdict reached the artifact — the one list `fadeno bakeoff` (writer)
 * and `fadeno dispatches --bakeoffs` (reader) both read, so a third
 * delivery path cannot be added to one and forgotten by the other.
 *
 * `command` is a kernel-dispatched judge: `dispatch_completed` rows exist for
 * it, so `judgeDispatchIds` on the result names evidence a reader can go
 * inspect. `host` is `fadeno bakeoff --record`: a coordinator handed the
 * kernel a JSON file it read back from a host-spawned subagent (or wrote
 * itself) with no dispatch receipt behind it — the same gap
 * `identity_evidence: 'requested_only'` already names for a host delivery
 * that skipped `fadeno attest`. Labelled here rather than hidden, because a
 * verdict a coordinator could have authored by hand and a verdict a model
 * actually produced are different kinds of evidence even when the JSON bytes
 * are identical.
 */
export const JUDGE_DELIVERIES = ['command', 'host'] as const;

export type JudgeDelivery = (typeof JUDGE_DELIVERIES)[number];

export function isJudgeDelivery(value: unknown): value is JudgeDelivery {
  return typeof value === 'string' && (JUDGE_DELIVERIES as readonly string[]).includes(value);
}

/**
 * How a verdict is counted in the running scorecard. Derived from the
 * vocabulary rather than restated, so a new verdict cannot be silently
 * uncounted: adding one here is a type error until it is given a bucket.
 */
export const VERDICT_BUCKET: Record<BakeoffVerdict, 'challenger' | 'baseline' | 'graft' | 'neither'> = {
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
/**
 * Model-level dispositions, as GROUPABLE tokens.
 *
 * `criteria` judges this artifact; these describe how the model WORKED, and
 * the two are not the same claim. "Writes more defensively" may be right on
 * this task and wrong on the next one — a trait is not a score, and recording
 * it as one destroys the thing shadow pairs exist to accumulate.
 *
 * Tokens rather than prose because accumulation is the whole point: three
 * pairs of sonnet-vs-grok should compose into a picture of the two models, and
 * sentences cannot be tallied. Same reason `refusal.predicate` is a token
 * while its message is not.
 */
export const TRAIT_DIMENSIONS = [
  /** Volume of change relative to what the task required. */
  'output_volume',
  /** Guards, validation, and error paths the task did not explicitly ask for. */
  'defensiveness',
  /** Extracting shared helpers vs. writing it inline where it is used. */
  'abstraction',
  /** Following the surrounding codebase's established patterns. */
  'convention_adherence',
  /** Staying inside the task boundary vs. improving adjacent things. */
  'scope_discipline',
  /** Checking its own work — tests, round-trips, tripwires against its own claims. */
  'self_verification',
  /** Restating existing behaviour instead of reusing the rule that owns it. */
  'duplication',
  /** Explaining WHY in comments and commit-adjacent prose. */
  'rationale_density',
] as const;

export type TraitDimension = (typeof TRAIT_DIMENSIONS)[number];

/**
 * One observed disposition. `favors` names the arm that exhibited MORE of the
 * dimension — deliberately not "better", because more is not better: pair
 * 49a1f92a's challenger wrote 65% more and the surplus was the worse artifact.
 */
export interface ModelTrait {
  dimension: TraitDimension;
  /** The arm exhibiting more of it, in the artifact's frame after unblinding. */
  more: 'primary' | 'challenger' | 'neither';
  note: string;
}

export const BAKEOFF_REQUIRED_SECTIONS = ['Criteria', 'Model traits', 'Confounds', 'Shared blind spots'] as const;

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

export interface BakeoffFrontmatter {
  kind: 'Bakeoff';
  baseline: string;
  challenger: string;
  verdict: BakeoffVerdict;
  date: string;
  dispatch_ids?: string[];
  pair_id?: string;
  graft_plan?: GraftStep[];
  /**
   * Optional at the type level only for a reader parsing an artifact written
   * before this field existed. Every writer in this codebase stamps it — see
   * `JudgeDelivery`.
   */
  judge_delivery?: JudgeDelivery;
}

export type BakeoffParseError =
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
  verdict: BakeoffVerdict,
  plan: GraftStep[] | undefined,
): BakeoffParseError | null {
  const hasPlan = Array.isArray(plan) && plan.length > 0;
  if (verdict === 'graft' && !hasPlan) return 'graft without a plan';
  if (verdict !== 'graft' && hasPlan) return 'plan without a graft verdict';
  return null;
}

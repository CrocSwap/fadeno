import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { schemaDirectories } from '../lib/definitions.ts';
import { loadExecutorProfile } from '../lib/executors.ts';
import {
  MODEL_COMPARISON_REQUIRED_SECTIONS,
  checkGraftCoherence,
  isJudgmentVerdict,
  unblindVerdict,
  type GraftStep,
  type JudgeDelivery,
  type ModelComparisonFrontmatter,
  type ModelComparisonVerdict,
} from '../lib/model-comparison.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet, schemaErrorMessages } from '../lib/playbook-validate.ts';
import { DispatchCommandError, runDispatch, type AdHocDispatchResult } from './dispatch.ts';
import { COMPARISONS_DIR, parseModelComparisonFile, resolveDispatchPair, type DispatchEntry, type ResolvedDispatchPair } from './dispatches.ts';
import { stringify as stringifyYaml } from 'yaml';

export class CompareCommandError extends Error {}

export type CompareArm = 'primary' | 'challenger';

/**
 * A fact about the pair that could make its arms non-comparable, stamped by
 * the KERNEL rather than written by the judge.
 *
 * The erdosSweep tier-4 lesson is that undisclosed scaffold differences
 * contaminate form-level judgments, and the design doc's answer was a
 * mandatory confounds section. Having the judge write that section would make
 * the disclosure depend on what a model noticed — the same objection that
 * killed agent-reported carry-back for `ignored_output`. A confound the
 * ledger already knows is evidence; a confound a model recalls is prose.
 */
export interface CompareConfound {
  /** Closed vocabulary, so a reader can GROUP on it. */
  code:
    | 'transport_differs'
    | 'effort_unattested'
    | 'effort_disagrees_with_dial'
    | 'workspace_mode_degraded'
    | 'ignored_output_discarded'
    | 'carry_mutated'
    | 'baseline_not_shared'
    | 'arm_refused'
    | 'exit_code_differs'
    | 'judge_provider_shared'
    | 'judge_delivery_unattested';
  arm: CompareArm | 'pair';
  detail: string;
}

export interface CompareDiffstat {
  path: string;
  bytes: number;
  files: number;
  insertions: number;
  deletions: number;
  /**
   * Files whose diff is dominated by generated content. Kept separate because
   * a regenerated bundle can be 95% of a diff's bytes: `plugin/bin/fadeno` is
   * a single 1.7 MB line, so a pair that merely rebuilt it reads as an
   * enormous change. Any diffstat comparison that does not say this is
   * measuring the build, not the work.
   */
  generatedFiles: string[];
}

/**
 * The two signals that actually discriminated across the first two real pairs.
 * Everything else the ledger records (pass/fail, test count, typecheck,
 * diffstat) agreed on both arms both times, which is itself worth recording —
 * "these were identical" is evidence the judge needs — but never separated
 * them.
 */
export interface CompareSignals {
  /** Identifiers this arm's diff introduces. */
  introduced: string[];
  /**
   * Introduced identifiers that appear in NO declared consumer surface.
   *
   * Pair 89536181's primary computed `delegate_to`, documented it as the
   * field a coordinator MUST check, and never reached stdout — `src/cli.ts`
   * builds the printed object field by field. One line was the whole
   * difference between working and dead, and every unit test was green.
   *
   * `null` (not `[]`) when the repo declares no surfaces: absent a
   * declaration this cannot distinguish "reached nothing" from "nothing to
   * reach", and reporting an empty list would read as a clean bill.
   */
  unreached: string[] | null;
  /**
   * Introduced identifiers the baseline tree already defines elsewhere.
   *
   * Symbols this diff also REMOVED are excluded: those were moved, not
   * duplicated.
   *
   * Pair 49a1f92a's challenger hand-wrote a `forbidden` branch duplicating a
   * rule `explainWriteConflict` already owned — it wrote 65% more code and
   * that surplus was the worse artifact. Size read as effort; this reads as
   * duplication.
   */
  redefined: string[];
}

export interface CompareArmMeasurement {
  arm: CompareArm;
  dispatchId: string | null;
  executor: string | null;
  /** The resolved delivery's provider, from the same evidence field a judge-provider confound compares against. */
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  attestedEffort: string | null;
  exitCode: number | null;
  durationMs: number | null;
  outputBytes: number | null;
  refused: { predicate: string; message: string } | null;
  diff: CompareDiffstat | null;
  signals: CompareSignals | null;
}

/**
 * An identifier BOTH arms introduced, which one arm wired to a consumer
 * surface and the other did not.
 *
 * The single most discriminating thing measurement produced across the first
 * two pairs, and the only one that separated them: in pair 89536181 both arms
 * introduced `delegate_to`, the challenger added it to `src/cli.ts` and the
 * primary did not, so the primary's feature was inert end to end while every
 * unit test on both sides passed. Restricted to identifiers both arms
 * introduced, because that is the apples-to-apples case — one arm inventing a
 * symbol the other never had says nothing about wiring.
 */
export interface CompareReachDifference {
  identifier: string;
  reachedIn: CompareArm;
  unreachedIn: CompareArm;
}

/** The deterministic half of phase 6, shared by both a measure-only and a full-cycle result. */
export interface CompareMeasurement {
  pairId: string;
  archetype: string | null;
  baselineCommit: string | null;
  arms: CompareArmMeasurement[];
  /** Null when either arm produced no signals, or surfaces are undeclared. */
  reachDifferential: CompareReachDifference[] | null;
  confounds: CompareConfound[];
  /**
   * Repo-relative globs declaring where a value must appear to count as
   * having reached a consumer. Empty means undeclared — see `unreached`.
   */
  surfaces: string[];
}

export interface CompareMeasureOnlyResult extends CompareMeasurement {
  /** True while the caller asked to measure only; nothing was judged or written. */
  measureOnly: true;
}

export interface CompareAdjudicatedResult extends CompareMeasurement {
  measureOnly: false;
  verdict: ModelComparisonVerdict;
  /** Repo-relative path of the `ModelComparison` artifact this run wrote. */
  comparisonPath: string;
  /**
   * How this verdict was delivered — see `JudgeDelivery`. `command` means
   * this run dispatched the judge itself; `host` means `--record` accepted a
   * judgment file a host-spawned subagent (or a coordinator) produced outside
   * any dispatch this kernel can attest.
   */
  judgeDelivery: JudgeDelivery;
  /**
   * The two blinded judge dispatches this verdict was built from —
   * command-lane delivery only. Null when `judgeDelivery` is `host`: nothing
   * was dispatched, so there is no receipt to name.
   */
  judgeDispatchIds: { comparison: string; adversarial: string } | null;
  /**
   * The graft plan, already unblinded to primary/challenger. Null unless the
   * verdict is `graft`.
   *
   * Returned rather than left inside the written artifact so it can reach
   * stdout, which is the only surface an agent caller reads. A `graft` verdict
   * whose plan lives solely in a file tells the reader that neither arm should
   * be taken whole and then withholds what to take — the one thing the verdict
   * exists to say. This is the same defect shape as pair 89536181's
   * `delegate_to`: computed, documented, and never wired to the surface.
   */
  graftPlan: GraftStep[] | null;
}

export type CompareResult = CompareMeasureOnlyResult | CompareAdjudicatedResult;

export interface CompareOptions {
  /** A `pair_id`, or either arm's `dispatch_id` (full, or an 8+ char prefix). */
  ref: string;
  measureOnly?: boolean;
  /** Override the `judge` archetype's dial model (bypasses catalog resolution, same as `fadeno dispatch --model`). */
  judgeModel?: string | null;
  /** Driver override for `judgeModel`; ignored without it. */
  judgeVia?: string | null;
  cwd?: string;
  repoRoot?: string;
  /** Injectable clock, for a stable `date` on the written artifact. */
  now?: Date;
}

export interface ComparePrepareOptions {
  /** A `pair_id`, or either arm's `dispatch_id` (full, or an 8+ char prefix). */
  ref: string;
  cwd?: string;
  repoRoot?: string;
}

export interface ComparePrepareResult extends CompareMeasurement {
  prepared: true;
  /**
   * The host archetype a coordinator should spawn once per prompt path below
   * — always `judge` today. Named here (rather than left implicit in the
   * skill's prose) so a caller driving this command programmatically does not
   * have to hardcode it independently.
   */
  judgeArchetype: 'judge';
  /** Repo-relative blinded comparison prompt, under `.fadeno/local/prompts/`. */
  comparisonPromptPath: string;
  /** Repo-relative blinded adversarial (shared-blind-spot) prompt, under `.fadeno/local/prompts/`. */
  adversarialPromptPath: string;
}

export interface CompareRecordOptions {
  /** A `pair_id`, or either arm's `dispatch_id` (full, or an 8+ char prefix). */
  ref: string;
  /** Path to the comparison judge's raw JSON output, resolved against `cwd`. */
  comparisonPath: string;
  /** Path to the adversarial judge's raw JSON output, resolved against `cwd`. */
  adversarialPath: string;
  cwd?: string;
  repoRoot?: string;
  /** Injectable clock, for a stable `date` on the written artifact. */
  now?: Date;
}

/**
 * Paths whose content is generated, so their diff measures the build rather
 * than the work. Matched as path prefixes against the diff's file list.
 */
const GENERATED_PREFIXES = ['plugin/bin/', 'plugin-codex/bin/', 'dist/', 'plugin/skills/', 'plugin/agents/', 'plugin/hooks/', 'plugin/commands/'];

function isGenerated(path: string): boolean {
  return GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Declarations an added diff line introduces. Deliberately conservative: a
 * miss costs a signal, a false positive costs the judge's trust in every
 * signal. Object-literal KEYS are included because the defect this exists to
 * catch (`delegate_to`) was a key, not a binding.
 */
const DECLARATION_PATTERNS: RegExp[] = [
  /^\+\s*export (?:async )?function ([A-Za-z_$][\w$]*)/,
  /^\+\s*export (?:const|let|class|interface|type) ([A-Za-z_$][\w$]*)/,
  // A serialized field name. Fadeno's wire format is snake_case and `cli.ts`
  // prints it key by key, so this is the shape of the exact defect the reach
  // signal exists to catch — `delegate_to` was a KEY, never a binding.
  /^\+\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\??:\s*[^=]/,
];

/**
 * Files whose identifiers are not expected to reach a consumer surface, and
 * whose inclusion buries the ones that are.
 *
 * Measured, not assumed: with test and generated files counted, pair 89536181
 * reported 135 unreached identifiers for one arm and 133 for the other, and
 * the single name that mattered (`delegate_to`, present in the primary's list
 * and absent from the challenger's) sat indistinguishable among locals like
 * `abs2`, `doc` and `st`. A signal that must be read past is not a signal.
 */
function isExcludedFromSignals(path: string): boolean {
  return path.startsWith('test/') || path.startsWith('evals/') || isGenerated(path);
}

/**
 * Identifiers introduced by added lines, restricted to declarations that
 * plausibly cross a boundary: exported symbols and serialized field names.
 *
 * Deliberately conservative on both axes. A miss costs one signal; a false
 * positive costs the judge's trust in every signal, and a judge that learns to
 * skim this section is worse than one that never had it.
 */
function introducedIdentifiers(diffText: string): string[] {
  return declaredIn(diffText, '+');
}

/**
 * Declarations the diff REMOVES. A symbol this diff deleted and re-added
 * elsewhere was moved, not duplicated.
 *
 * Without this, every refactor reads as duplication: pair 89536181 lifted
 * `CODEX_MANAGED_MARK` out of `doctor.ts` into a new shared module, and the
 * baseline probe reported it as already-defined — literally true, and exactly
 * backwards as a quality signal, since extracting the shared parser is the
 * thing this repo's own convention asks for. A judge shown false duplication
 * learns to skip the section that also carries the real ones.
 */
function removedIdentifiers(diffText: string): string[] {
  return declaredIn(diffText, '-', REMOVAL_PATTERNS);
}

/**
 * Deliberately looser than `DECLARATION_PATTERNS`: a removal only ever
 * SUPPRESSES a duplication finding, so a false positive here costs one signal
 * while a miss manufactures a wrong one. Local `const`/`function` forms count,
 * because the old home of a moved symbol frequently did not export it —
 * `CODEX_MANAGED_MARK` left `doctor.ts` and `steering.ts` as a bare `const`
 * (it was defined in BOTH, and the pair consolidated it), and arrived in the
 * new shared module as an `export const`.
 */
const REMOVAL_PATTERNS: RegExp[] = [
  /^\+\s*(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/,
  /^\+\s*(?:export )?(?:const|let|var|class|interface|type) ([A-Za-z_$][\w$]*)/,
  /^\+\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\??:\s*[^=]/,
];

function declaredIn(diffText: string, sign: '+' | '-', patterns: RegExp[] = DECLARATION_PATTERNS): string[] {
  const fileMarker = sign === '+' ? '+++ b/' : '--- a/';
  const skipMarker = sign === '+' ? '+++' : '---';
  const found = new Set<string>();
  let current: string | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith(fileMarker)) {
      current = line.slice(6);
      continue;
    }
    if (!line.startsWith(sign) || line.startsWith(skipMarker)) continue;
    if (current != null && isExcludedFromSignals(current)) continue;
    for (const pattern of patterns) {
      // The patterns are written against an added line; for a removal the
      // leading sign is the only difference.
      const match = pattern.exec(sign === '+' ? line : `+${line.slice(1)}`);
      if (match?.[1] != null) {
        found.add(match[1]);
        break;
      }
    }
  }
  return [...found].sort();
}

function parseDiffstat(repoRoot: string, relPath: string, bytes: number | null): CompareDiffstat | null {
  const abs = join(repoRoot, relPath);
  let text: string;
  try {
    if (!existsSync(abs)) return null;
    text = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ b/')) files.add(line.slice(6));
    else if (line.startsWith('+') && !line.startsWith('+++')) insertions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return {
    path: relPath,
    bytes: bytes ?? Buffer.byteLength(text),
    files: files.size,
    insertions,
    deletions,
    generatedFiles: [...files].filter(isGenerated).sort(),
  };
}

/**
 * Identifiers the baseline tree already defines. Runs `git grep` AT the
 * baseline commit rather than in the working tree, because the working tree
 * has moved since the pair ran — often by the very merge-back being judged,
 * which would make every primary symbol look pre-existing.
 */
function redefinedAtBaseline(repoRoot: string, baseline: string | null, identifiers: string[]): string[] {
  if (baseline == null || identifiers.length === 0) return [];
  const out: string[] = [];
  for (const name of identifiers) {
    // POSIX ERE, NOT Perl. `git grep -E` does not honour `\\s` or `\\b`, so the
    // first version of this pattern matched nothing, ever — and a probe that
    // always reports "no duplication found" is indistinguishable from a clean
    // bill. Caught only by hand-checking a symbol known to exist at baseline
    // (`explainWriteConflict`); the empty output looked entirely plausible.
    const pattern = `(function|const|let|class|interface|type)[[:space:]]+${name}([^A-Za-z0-9_$]|$)`;
    const res = spawnSync(
      'git',
      ['-C', repoRoot, 'grep', '-l', '-E', pattern, baseline, '--', 'src', 'templates'],
      { encoding: 'utf8' },
    );
    if (res.status === 0 && (res.stdout ?? '').trim() !== '') out.push(name);
  }
  return out;
}

/**
 * Added lines in `diffText` that belong to one of `surfaces`.
 *
 * The diff is per-file, so this tracks which file each hunk is under and
 * keeps only the surface ones.
 */
function surfaceAdditions(diffText: string, surfaces: Set<string>): string {
  const kept: string[] = [];
  let current: string | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = line.slice(6);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) continue;
    if (current != null && surfaces.has(current) && line.startsWith('+')) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Introduced identifiers that reach no declared consumer surface, evaluated in
 * THIS ARM'S world: the surface as it stood at the shared baseline, plus
 * whatever this arm added to it.
 *
 * Reading the working tree instead would be wrong in the direction that
 * destroys the signal. The tree has moved on — usually by the merge-back of
 * the very arm being judged, and in this repo's own case by a hand graft that
 * added the missing line. `src/cli.ts` contains `delegate_to` today precisely
 * BECAUSE pair 89536181's primary failed to add it; a working-tree read would
 * report the defect as reached and the pair as unremarkable.
 */
function unreachedAtSurfaces(
  repoRoot: string,
  baseline: string | null,
  surfaces: string[],
  identifiers: string[],
  diffText: string,
): string[] | null {
  if (surfaces.length === 0) return null; // undeclared — do not claim
  const parts: string[] = [surfaceAdditions(diffText, new Set(surfaces))];
  if (baseline != null) {
    for (const rel of surfaces) {
      const res = spawnSync('git', ['-C', repoRoot, 'show', `${baseline}:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (res.status === 0) parts.push(res.stdout ?? '');
    }
  }
  const text = parts.join('\n');
  return identifiers.filter((name) => !new RegExp(`\\b${name}\\b`).test(text));
}

function armOf(entry: DispatchEntry | null, arm: CompareArm, repoRoot: string, baseline: string | null, surfaces: string[]): CompareArmMeasurement {
  if (entry == null) {
    return {
      arm, dispatchId: null, executor: null, provider: null, model: null, reasoningEffort: null, attestedEffort: null,
      exitCode: null, durationMs: null, outputBytes: null, refused: null, diff: null, signals: null,
    };
  }
  const diff = entry.diffSnapshot != null ? parseDiffstat(repoRoot, entry.diffSnapshot, entry.diffBytes) : null;
  let signals: CompareSignals | null = null;
  if (diff != null && entry.diffSnapshot != null) {
    let diffText = '';
    try {
      diffText = readFileSync(join(repoRoot, entry.diffSnapshot), 'utf8');
    } catch {
      diffText = '';
    }
    const introduced = introducedIdentifiers(diffText);
    const moved = new Set(removedIdentifiers(diffText));
    signals = {
      introduced,
      unreached: unreachedAtSurfaces(repoRoot, baseline, surfaces, introduced, diffText),
      redefined: redefinedAtBaseline(repoRoot, baseline, introduced.filter((name) => !moved.has(name))),
    };
  }
  return {
    arm,
    dispatchId: entry.dispatchId,
    executor: entry.executor,
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    attestedEffort: entry.attestedEffort,
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
    outputBytes: entry.outputBytes,
    refused: entry.refusal,
    diff,
    signals,
  };
}

function reachDifferentialOf(
  primary: CompareArmMeasurement,
  challenger: CompareArmMeasurement,
): CompareReachDifference[] | null {
  const a = primary.signals;
  const b = challenger.signals;
  if (a == null || b == null || a.unreached == null || b.unreached == null) return null;
  const shared = new Set(a.introduced.filter((name) => b.introduced.includes(name)));
  const out: CompareReachDifference[] = [];
  for (const name of [...shared].sort()) {
    const aMissed = a.unreached.includes(name);
    const bMissed = b.unreached.includes(name);
    if (aMissed && !bMissed) out.push({ identifier: name, reachedIn: 'challenger', unreachedIn: 'primary' });
    else if (bMissed && !aMissed) out.push({ identifier: name, reachedIn: 'primary', unreachedIn: 'challenger' });
  }
  return out;
}

function confoundsOf(primary: DispatchEntry | null, shadow: DispatchEntry | null): CompareConfound[] {
  const out: CompareConfound[] = [];
  const push = (code: CompareConfound['code'], arm: CompareConfound['arm'], detail: string): void => {
    out.push({ code, arm, detail });
  };
  const pairs: Array<[CompareArm, DispatchEntry | null]> = [['primary', primary], ['challenger', shadow]];

  for (const [arm, entry] of pairs) {
    if (entry == null) continue;
    if (entry.refusal != null) push('arm_refused', arm, `${entry.refusal.predicate}: ${entry.refusal.message}`);
    if (entry.attestedEffort == null) {
      push('effort_unattested', arm, 'no measured effort — model identity remains requested_only, never verified.');
    } else if (entry.reasoningEffort != null && entry.attestedEffort !== entry.reasoningEffort) {
      push('effort_disagrees_with_dial', arm, `dial asked ${entry.reasoningEffort}, the process measured ${entry.attestedEffort}.`);
    }
    if (entry.ignoredOutputDiscarded != null) {
      const paths = entry.ignoredOutputDiscarded.paths ?? [];
      push('ignored_output_discarded', arm, `gitignored output was not carried back: ${paths.join(', ') || '(paths unrecorded)'}`);
    }
    if (entry.workspaceModeDegraded != null) {
      push('workspace_mode_degraded', arm, String(entry.workspaceModeDegraded));
    }
    if (entry.carryMutated != null) {
      push('carry_mutated', arm, 'a carried path was written through — one inode, two trees; the arms may have contaminated each other.');
    }
  }

  if (primary != null && shadow != null) {
    if (primary.transport != null && shadow.transport != null && primary.transport !== shadow.transport) {
      push('transport_differs', 'pair', `primary went out over ${primary.transport}, challenger over ${shadow.transport}.`);
    }
    if (primary.baselineCommit != null && shadow.baselineCommit != null && primary.baselineCommit !== shadow.baselineCommit) {
      push('baseline_not_shared', 'pair', `primary from ${primary.baselineCommit.slice(0, 8)}, challenger from ${shadow.baselineCommit.slice(0, 8)} — the arms did not start from one tree.`);
    }
    if (primary.exitCode != null && shadow.exitCode != null && primary.exitCode !== shadow.exitCode) {
      push('exit_code_differs', 'pair', `primary exit ${primary.exitCode}, challenger exit ${shadow.exitCode} — challenger-succeeds-where-primary-failed is a signal, not noise.`);
    }
  }
  return out;
}

/**
 * Measure a shadow pair. The deterministic half of phase 6: every number here
 * is computed from the ledger, the diff artifacts, and git — no model is
 * consulted, so nothing in this result is a judgment.
 *
 * Adjudication (stage 2/3, below) is a separate stage by design. The standing
 * rule is that gates never ask an LLM: an evaluator emits a structured
 * judgment artifact and a deterministic condition consumes it. Measuring
 * first also means the judge receives facts it cannot get wrong instead of
 * being asked to eyeball two diffs and estimate them.
 */
function measure(ref: string, cwd: string, repoRoot: string): { measurement: CompareMeasurement; pair: ResolvedDispatchPair } {
  const pair = resolveDispatchPair(ref, { cwd, repoRoot });
  if (pair.primary == null && pair.shadow == null) {
    throw new CompareCommandError(`pair "${pair.pairId}" has no recorded arms.`);
  }
  const baseline = pair.primary?.baselineCommit ?? pair.shadow?.baselineCommit ?? null;

  let surfaces: string[] = [];
  try {
    surfaces = loadExecutorProfile(repoRoot).profile.surfaces ?? [];
  } catch {
    surfaces = [];
  }

  const arms = [
    armOf(pair.primary, 'primary', repoRoot, baseline, surfaces),
    armOf(pair.shadow, 'challenger', repoRoot, baseline, surfaces),
  ];

  const measurement: CompareMeasurement = {
    pairId: pair.pairId,
    archetype: pair.primary?.archetype ?? pair.shadow?.archetype ?? null,
    baselineCommit: baseline,
    arms,
    reachDifferential: reachDifferentialOf(arms[0]!, arms[1]!),
    confounds: confoundsOf(pair.primary, pair.shadow),
    surfaces,
  };
  return { measurement, pair };
}

// ---------------------------------------------------------------------------
// Stage 2 — adjudicate: two blinded `judge` dispatches, then a schema-checked
// verdict. Stage 3 — render: unblind, and write the `ModelComparison`
// artifact `dispatches.ts`'s `parseModelComparisonFile` already reads.
// ---------------------------------------------------------------------------

type BlindLabel = 'a' | 'b';

/**
 * Which real arm gets the `a` / `b` label a judge is shown, derived from a
 * digest of the pair id: reproducible across runs (re-rendering the same pair
 * asks the same question), but not always primary-first — a fixed order is
 * itself a label, and the ordering of the diffs must not reveal identity any
 * more than the label text does.
 */
export function deriveBlinding(pairId: string): { a: CompareArm; b: CompareArm } {
  const firstByte = parseInt(sha256Hex(pairId).slice(0, 2), 16);
  return firstByte % 2 === 0
    ? { a: 'primary', b: 'challenger' }
    : { a: 'challenger', b: 'primary' };
}

function labelFor(arm: CompareArm, blinding: { a: CompareArm; b: CompareArm }): BlindLabel {
  return blinding.a === arm ? 'a' : 'b';
}

function armFor(label: BlindLabel, blinding: { a: CompareArm; b: CompareArm }): CompareArm {
  return blinding[label];
}

function readDiffText(repoRoot: string, entry: DispatchEntry | null): string {
  if (entry?.diffSnapshot == null) return '';
  try {
    return readFileSync(join(repoRoot, entry.diffSnapshot), 'utf8');
  } catch {
    return '';
  }
}

/** Paths whose diff is dominated by generated content, excluded from the judge's read exactly as they are from signals. */
function stripGeneratedHunks(diffText: string, generatedFiles: string[]): string {
  if (generatedFiles.length === 0 || diffText === '') return diffText;
  const generated = new Set(generatedFiles);
  const blocks = diffText.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  let omittedCount = 0;
  let omittedBytes = 0;
  for (const block of blocks) {
    const path = block.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? null;
    if (path != null && generated.has(path)) {
      omittedCount += 1;
      omittedBytes += Buffer.byteLength(block, 'utf8');
      continue;
    }
    kept.push(block);
  }
  if (omittedCount === 0) return diffText;
  return `${kept.join('')}\n[${omittedCount} generated file diff(s) omitted, ${omittedBytes} bytes — see the diffstat instead]\n`;
}

/** A judge prompt is not an unbounded sink; a pathological diff gets a note instead of blowing the budget. */
const MAX_DIFF_PROMPT_BYTES = 200_000;

function capDiffText(diffText: string): string {
  const bytes = Buffer.byteLength(diffText, 'utf8');
  if (bytes <= MAX_DIFF_PROMPT_BYTES) return diffText;
  return `${diffText.slice(0, MAX_DIFF_PROMPT_BYTES)}\n… [diff truncated at ${MAX_DIFF_PROMPT_BYTES} bytes of ${bytes} total — see the diffstat for the full shape]\n`;
}

interface BlindArmMaterial {
  exitCode: number | null;
  durationMs: number | null;
  outputBytes: number | null;
  /** `message` is dropped: boundary-refusal prose can name an executor (see `explainEligibilityConflict`), which is exactly the identity a blind judge must not see. */
  refused: { predicate: string } | null;
  diffstat: { files: number; insertions: number; deletions: number; bytes: number; generatedFiles: number } | null;
  signals: CompareSignals | null;
  diff: string;
}

/**
 * An arm's measurement, stripped of everything that could name it: executor,
 * model, dispatch id, reasoning effort. Diff CONTENT is safe to pass through
 * verbatim — a git diff's file paths are repo-relative and shared by both
 * arms, never a worktree location.
 */
function blindArm(m: CompareArmMeasurement, diffText: string): BlindArmMaterial {
  return {
    exitCode: m.exitCode,
    durationMs: m.durationMs,
    outputBytes: m.outputBytes,
    refused: m.refused != null ? { predicate: m.refused.predicate } : null,
    diffstat: m.diff == null ? null : {
      files: m.diff.files,
      insertions: m.diff.insertions,
      deletions: m.diff.deletions,
      bytes: m.diff.bytes,
      generatedFiles: m.diff.generatedFiles.length,
    },
    signals: m.signals,
    diff: capDiffText(stripGeneratedHunks(diffText, m.diff?.generatedFiles ?? [])),
  };
}

function renderBlindArm(label: BlindLabel, m: BlindArmMaterial): string {
  const lines: string[] = [`### arm_${label}`, ''];
  lines.push(`- exit code: ${m.exitCode ?? '(none)'}`);
  lines.push(`- duration: ${m.durationMs != null ? `${m.durationMs}ms` : '(unknown)'}`);
  lines.push(`- output: ${m.outputBytes != null ? `${m.outputBytes} bytes` : '(unknown)'}`);
  if (m.refused != null) lines.push(`- REFUSED before it ran: [${m.refused.predicate}]`);
  if (m.diffstat != null) {
    const gen = m.diffstat.generatedFiles > 0 ? `, ${m.diffstat.generatedFiles} generated file(s) omitted below` : '';
    lines.push(`- diff: ${m.diffstat.files} files, +${m.diffstat.insertions}/-${m.diffstat.deletions} (${m.diffstat.bytes} bytes)${gen}`);
  }
  if (m.signals != null) {
    lines.push(`- introduced identifiers: ${m.signals.introduced.length > 0 ? m.signals.introduced.join(', ') : '(none)'}`);
    lines.push(
      `- unreached identifiers: ${
        m.signals.unreached == null
          ? '(undeclared — no `surfaces:` configured, so this is not claimed either way)'
          : m.signals.unreached.length > 0
            ? m.signals.unreached.join(', ')
            : '(none — every introduced identifier reached a declared surface)'
      }`,
    );
    lines.push(`- redefined identifiers (already defined at baseline): ${m.signals.redefined.length > 0 ? m.signals.redefined.join(', ') : '(none)'}`);
  }
  lines.push('', '```diff', m.diff.trim().length > 0 ? m.diff : '(empty diff)', '```');
  return lines.join('\n');
}

interface BlindReachDifference {
  identifier: string;
  reachedIn: BlindLabel;
  unreachedIn: BlindLabel;
}

function blindReach(
  diffs: CompareReachDifference[] | null,
  blinding: { a: CompareArm; b: CompareArm },
): BlindReachDifference[] | null {
  if (diffs == null) return null;
  return diffs.map((d) => ({
    identifier: d.identifier,
    reachedIn: labelFor(d.reachedIn, blinding),
    unreachedIn: labelFor(d.unreachedIn, blinding),
  }));
}

/**
 * Generic, blind-safe replacements for the three pair-level confounds whose
 * prose names the arms literally (`primary went out over X, challenger over
 * Y`) — forwarding that text to a judge would undo the label swap above by a
 * different channel. Every other confound code's `detail` is arm-neutral
 * prose (verified against `confoundsOf`) and passes through unchanged.
 */
const GENERIC_CONFOUND_DETAIL: Partial<Record<CompareConfound['code'], string>> = {
  transport_differs: 'the two arms were dispatched over different transports.',
  baseline_not_shared: 'the two arms did not start from the same baseline commit — not a strictly fair comparison.',
  exit_code_differs: "the two arms' exit codes differ — see each arm's own measurements above.",
  arm_refused: 'this arm was refused before it ran — see its own measurement above for the predicate.',
};

interface BlindConfound {
  code: CompareConfound['code'];
  arm: BlindLabel | 'pair';
  detail: string;
}

function blindConfoundForPrompt(c: CompareConfound, blinding: { a: CompareArm; b: CompareArm }): BlindConfound {
  return {
    code: c.code,
    arm: c.arm === 'pair' ? 'pair' : labelFor(c.arm, blinding),
    detail: GENERIC_CONFOUND_DETAIL[c.code] ?? c.detail,
  };
}

/**
 * Both judge dispatches resolve through the SAME `judge` dial, so this is the
 * one stable, greppable signal that distinguishes which prompt a fixture (or
 * a real catalog routing on prompt content) is looking at — everything else
 * about the two prompts is free prose that may be reworded.
 */
export const COMPARE_PROMPT_MARKER = { comparison: 'fadeno-compare-task: comparison', adversarial: 'fadeno-compare-task: adversarial' } as const;

function buildComparisonPrompt(
  schemaText: string,
  blindA: string,
  blindB: string,
  reach: BlindReachDifference[] | null,
  confounds: BlindConfound[],
  surfaces: string[],
): string {
  const reachSection = reach != null && reach.length > 0
    ? `### Reach differential\n\nBoth arms introduced these identifiers; only one wired them to a declared consumer surface:\n\n${reach.map((d) => `- \`${d.identifier}\`: reached in arm_${d.reachedIn}, NEVER reached in arm_${d.unreachedIn}`).join('\n')}`
    : "### Reach differential\n\n(none — see each arm's own `unreached identifiers` line above)";
  const surfacesSection = surfaces.length > 0
    ? `### Declared consumer surfaces\n\n${surfaces.join(', ')}`
    : '### Declared consumer surfaces\n\n(none declared)';
  const confoundsSection = confounds.length > 0
    ? `### Confounds (kernel-stamped facts, not judgment)\n\n${confounds.map((c) => `- [${c.code}] ${c.arm}: ${c.detail}`).join('\n')}`
    : '### Confounds\n\nnone recorded.';
  return [
    `<!-- ${COMPARE_PROMPT_MARKER.comparison} -->`,
    '# Blinded shadow-pair comparison',
    '',
    'You are comparing two AI-agent work products on the SAME task, from the SAME starting commit. They are ' +
      'labeled `arm_a` and `arm_b` ONLY — you are never told, and must never guess or state, which one is the ' +
      '"primary"/incumbent and which is the "challenger". Judge the work, not who produced it.',
    '',
    '## Deterministic measurements',
    '',
    'These numbers were computed by code, not recalled from memory — treat them as ground truth.',
    '',
    blindA,
    '',
    blindB,
    '',
    reachSection,
    '',
    surfacesSection,
    '',
    confoundsSection,
    '',
    '## Your task',
    '',
    'Emit ONLY a single JSON object — no prose before or after it, no markdown code fence — that validates ' +
      'against this JSON Schema:',
    '',
    schemaText,
    '',
    'Notes:',
    '- `verdict`, `favors` and `from_arm` all use the blinded labels `a` / `b`. You do not know which arm is ' +
      'the baseline and must not guess: answer `prefer_a` / `prefer_b`, and the kernel translates it once.',
    "- A separate adversarial pass already searches for defects both arms share; emit an empty array for `shared_blind_spots` here.",
    '- `inconclusive` is a valid, honest verdict when the evidence does not support a call — do not guess to avoid it.',
    '- `traits` describes how each MODEL worked, not whether this artifact is good — that is what `criteria` is ' +
      'for. A trait is not a score: "more defensive" may be right on this task and wrong on the next one, and ' +
      '`more` names the arm exhibiting MORE of the dimension, never the better one. Report a dimension even ' +
      'when it did not affect the verdict, and use `neither` freely — two arms being indistinguishable on a ' +
      'dimension is a real observation. These accumulate across many pairs into a picture of the two models, ' +
      'which is what a single comparison cannot give.',
  ].join('\n');
}

function buildAdversarialPrompt(blindA: string, blindB: string): string {
  return [
    `<!-- ${COMPARE_PROMPT_MARKER.adversarial} -->`,
    '# Blinded shadow-pair — shared blind spot search',
    '',
    'Two AI-agent work products on the SAME task, from the SAME starting commit, labeled `arm_a` / `arm_b` only. ' +
      'Do not try to pick a winner and do not guess which one is the "primary"/incumbent.',
    '',
    blindA,
    '',
    blindB,
    '',
    '## Your task',
    '',
    'Answer ONLY this question: what configuration, input, or environment would break BOTH arms — a defect ' +
      'present in both that an arm-vs-arm comparison could never surface, because both arms agree on it? ' +
      'Agreement between two arms is not evidence they are right.',
    '',
    'Emit ONLY a single JSON object — no prose before or after it, no markdown code fence — of this shape:',
    '',
    '```json',
    '{ "shared_blind_spots": [ { "issue": "...", "why_invisible": "...", "config_that_breaks_it": "..." } ] }',
    '```',
    '',
    '`shared_blind_spots` may be an empty array, but only after actually looking — do not skip the search.',
  ].join('\n');
}

/** Extract the first JSON object found in a judge's raw stdout: a direct parse, then a fenced code block, then the outermost `{...}`. */
function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1] != null) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    if (candidate === '') continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function loadModelComparisonSchema(repoRoot: string): { text: string; parsed: Record<string, unknown>; schemas: SchemaSet } {
  const dirs = schemaDirectories(repoRoot);
  const candidates = [join(dirs.project, 'model-comparison.schema.json'), join(dirs.builtin, 'model-comparison.schema.json')];
  const schemaPath = candidates.find((p) => existsSync(p));
  if (schemaPath == null) {
    throw new CompareCommandError(
      'no model-comparison schema available (missing .fadeno/schemas and the bundled template) — cannot validate a judge\'s output.',
    );
  }
  const text = readFileSync(schemaPath, 'utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const schemas = new SchemaSet(dirs.project, dirs.builtin);
  return { text, parsed, schemas };
}

/**
 * The adversarial dispatch answers a narrower question than the full
 * artifact, so it is validated against a schema sliced from the SAME
 * `shared_blind_spots` property definition rather than a hand-duplicated
 * shape — one definition, two consumers, exactly like everything else this
 * module imports from `model-comparison.ts`.
 */
function compileSharedBlindSpotsValidator(schemaJson: Record<string, unknown>): ValidateFunction {
  const properties = schemaJson.properties as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile({
    type: 'object',
    additionalProperties: false,
    required: ['shared_blind_spots'],
    properties: { shared_blind_spots: properties.shared_blind_spots },
  });
}

interface RawCriterion {
  criterion: string;
  assessment: string;
  favors?: BlindLabel | 'neither';
}

interface RawGraftStep {
  from_arm: BlindLabel;
  what: string;
  why: string;
  paths?: string[];
}

interface RawSharedBlindSpot {
  issue: string;
  why_invisible: string;
  config_that_breaks_it?: string;
}

interface RawTrait {
  dimension: string;
  more: string;
  note: string;
}

interface RawComparisonJudgment {
  verdict: string;
  criteria: RawCriterion[];
  traits: RawTrait[];
  shared_blind_spots: RawSharedBlindSpot[];
  graft_plan?: RawGraftStep[];
  confound_notes?: string;
}

interface RawAdversarialJudgment {
  shared_blind_spots: RawSharedBlindSpot[];
}

/** A judge dispatch that reports its own refusal/failure/invalid-output as a `CompareCommandError` — never a partial write. */
function dispatchJudge(
  prompt: string,
  opts: { repoRoot: string; cwd: string; judgeModel: string | null; judgeVia: string | null; now?: Date; tag: string },
): AdHocDispatchResult {
  let result: AdHocDispatchResult;
  try {
    result = runDispatch({
      // `archetype: 'judge'` even under a model override: the override only
      // bypasses which DIAL is compiled (see `runDispatch`'s own `--model`
      // bypass), so a no-command-lane refusal still names "judge" — the same
      // wording discipline as `fadeno dial judge <model> --via <driver>`.
      archetype: 'judge',
      prompt,
      model: opts.judgeModel,
      via: opts.judgeVia,
      noBrief: true,
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      now: opts.now,
      tag: opts.tag,
    });
  } catch (err) {
    if (err instanceof DispatchCommandError) throw new CompareCommandError(err.message);
    throw err;
  }
  if (result.outcome !== 'ok') {
    throw new CompareCommandError(
      `judge dispatch ${result.dispatchId.slice(0, 8)} did not produce usable output (outcome: ` +
        `${result.outcome ?? 'unknown'}, exit ${result.exitCode}) — writing nothing rather than a partial verdict. ` +
        `stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
  return result;
}

function renderCriteria(criteria: RawCriterion[], blinding: { a: CompareArm; b: CompareArm }): string {
  if (criteria.length === 0) return '(none provided)';
  return criteria
    .map((c) => {
      const favors = c.favors === 'a' || c.favors === 'b' ? armFor(c.favors, blinding) : (c.favors ?? 'neither');
      return `- **${c.criterion}** (favors: ${favors}): ${unblindProse(c.assessment, blinding)}`;
    })
    .join('\n');
}

/**
 * Traits, unblinded. Rendered as its own section rather than folded into
 * Criteria because they answer different questions: Criteria says whether this
 * artifact is good, this says how each model worked. `more` is deliberately
 * not `better` — pair 49a1f92a's challenger exhibited more `output_volume` and
 * that surplus was the worse artifact.
 */
/**
 * Unblind the judge's own prose.
 *
 * The structured fields are translated by lookup; free text is not, so an
 * artifact rendered without this says `(more: challenger): Arm_b produces...`
 * — two names for one arm on a single line, leaving the reader to hold the
 * mapping. The artifact is the human-facing deliverable and the blinding is a
 * detail of how it was produced, not something a reader should have to undo.
 *
 * Exact-token only. A judge writing `arm_a` means the label; nothing else in
 * this codebase spells that.
 */
function unblindProse(text: string, blinding: { a: CompareArm; b: CompareArm }): string {
  return text
    .replace(/\barm_a\b/gi, blinding.a)
    .replace(/\barm_b\b/gi, blinding.b);
}

function renderTraits(traits: RawTrait[], blinding: { a: CompareArm; b: CompareArm }): string {
  if (traits.length === 0) return '(none reported)';
  return traits
    .map((t) => {
      const more = t.more === 'a' || t.more === 'b' ? armFor(t.more, blinding) : 'neither';
      return `- **${t.dimension}** (more: ${more}): ${unblindProse(t.note, blinding)}`;
    })
    .join('\n');
}

function renderConfounds(confounds: CompareConfound[], judgeConfoundNotes: string | undefined): string {
  const lines = confounds.length > 0
    ? confounds.map((c) => `- [${c.code}] ${c.arm}: ${c.detail}`)
    : ['none recorded.'];
  if (judgeConfoundNotes != null && judgeConfoundNotes.trim() !== '') {
    lines.push('', "_The judge's own observation — not kernel-verified:_", judgeConfoundNotes.trim());
  }
  return lines.join('\n');
}

function renderSharedBlindSpots(spots: RawSharedBlindSpot[]): string {
  if (spots.length === 0) return 'none found — the adversarial pass looked and came up empty.';
  return spots
    .map((s) => `- **${s.issue}** — ${s.why_invisible}${s.config_that_breaks_it != null ? ` (breaks under: ${s.config_that_breaks_it})` : ''}`)
    .join('\n');
}

function renderGraftPlan(plan: GraftStep[]): string {
  return plan
    .map((s) => `- from **${s.from_arm}**: ${s.what} — ${s.why}${s.paths != null && s.paths.length > 0 ? ` (paths: ${s.paths.join(', ')})` : ''}`)
    .join('\n');
}

/**
 * Content for each of `MODEL_COMPARISON_REQUIRED_SECTIONS`, keyed by that
 * same list rather than restated as separate literals — adding a required
 * section there is a type error here until this writer supplies it, instead
 * of a scorecard silently rejecting every artifact this command produces.
 */
type RequiredSectionContent = Record<(typeof MODEL_COMPARISON_REQUIRED_SECTIONS)[number], string>;

function renderComparisonArtifact(
  frontmatter: ModelComparisonFrontmatter,
  sections: RequiredSectionContent & { graftPlan: string | null },
): string {
  const parts = ['---', stringifyYaml(frontmatter).trimEnd(), '---'];
  for (const name of MODEL_COMPARISON_REQUIRED_SECTIONS) {
    parts.push('', `## ${name}`, '', sections[name]);
  }
  if (sections.graftPlan != null) {
    parts.push('', '## Graft plan', '', sections.graftPlan);
  }
  parts.push('');
  return parts.join('\n');
}

/** Everything derivable from a measured, complete pair without consulting a model — the shared front half of `--prepare` and the one-shot path. */
interface PreparedComparison {
  blinding: { a: CompareArm; b: CompareArm };
  validateComparison: ValidateFunction;
  validateAdversarial: ValidateFunction;
  comparisonPrompt: string;
  adversarialPrompt: string;
}

/**
 * Derive blinding, build the two blinded prompts, and compile the two
 * judgment validators — the seam where a model becomes necessary. Everything
 * before this point is measurement; everything after it needs a judgment in
 * hand, whether that judgment arrives over the command lane (`adjudicateViaCommand`)
 * or is read back from a file a host subagent wrote (`runCompareRecord`).
 *
 * Pure given `measurement`/`pair`/`repoRoot`: `deriveBlinding` is a function
 * of the pair id alone, so calling this twice for the same pair (once from
 * `--prepare`, once from `--record`) reconstructs the identical mapping with
 * nothing persisted in between.
 */
function preparePrompts(measurement: CompareMeasurement, pair: ResolvedDispatchPair, repoRoot: string): PreparedComparison {
  const blinding = deriveBlinding(measurement.pairId);
  const primaryArm = measurement.arms.find((a) => a.arm === 'primary')!;
  const challengerArm = measurement.arms.find((a) => a.arm === 'challenger')!;

  // An arm that never ran has nothing to compare. Without this the judge is
  // asked to weigh a real diff against an absence, at the cost of two real
  // dispatches, and will return a verdict — `prefer_baseline` is the obvious
  // one, and it is meaningless: the challenger did not lose, it was refused.
  // Pair 097929f6 in this repo is exactly that shape (`shadow_containment`).
  //
  // It also closes a blinding leak that survives every label swap. The
  // shadow-side predicates — `shadow_containment`, `shadow_baseline`,
  // `shadow_carry` — can ONLY ever refuse a challenger, so passing a predicate
  // to a blinded judge names the arm no matter what it is labelled. Both arms
  // of the pair that built this forwarded refusal state to the judge (one of
  // them the full message, which can carry a repo path); neither guarded the
  // case where an arm had not run at all. Refusing here means the predicate
  // never reaches a prompt, so there is nothing left to redact.
  for (const arm of [primaryArm, challengerArm]) {
    if (arm.refused != null) {
      throw new CompareCommandError(
        `pair ${measurement.pairId.slice(0, 8)} cannot be adjudicated: the ${arm.arm} arm was refused ` +
          `before it ran [${arm.refused.predicate}], so there is nothing to compare it against. ` +
          'Re-run the pair, or use --measure-only to see what was recorded.',
      );
    }
    if (arm.diff == null) {
      throw new CompareCommandError(
        `pair ${measurement.pairId.slice(0, 8)} cannot be adjudicated: the ${arm.arm} arm recorded no diff ` +
          '(it may still be in flight, or have been killed). Use --measure-only to see what was recorded.',
      );
    }
  }

  const material: Record<CompareArm, BlindArmMaterial> = {
    primary: blindArm(primaryArm, readDiffText(repoRoot, pair.primary)),
    challenger: blindArm(challengerArm, readDiffText(repoRoot, pair.shadow)),
  };
  const blindA = renderBlindArm('a', material[armFor('a', blinding)]);
  const blindB = renderBlindArm('b', material[armFor('b', blinding)]);

  const { text: schemaText, parsed: schemaJson, schemas } = loadModelComparisonSchema(repoRoot);
  if (!schemas.has('model-comparison')) {
    throw new CompareCommandError(
      'no model-comparison schema available (missing .fadeno/schemas and the bundled template) — cannot validate a judge\'s output.',
    );
  }
  const validateComparison = schemas.get('model-comparison');
  const validateAdversarial = compileSharedBlindSpotsValidator(schemaJson);

  const comparisonPrompt = buildComparisonPrompt(
    schemaText,
    blindA,
    blindB,
    blindReach(measurement.reachDifferential, blinding),
    measurement.confounds.map((c) => blindConfoundForPrompt(c, blinding)),
    measurement.surfaces,
  );
  const adversarialPrompt = buildAdversarialPrompt(blindA, blindB);

  return { blinding, validateComparison, validateAdversarial, comparisonPrompt, adversarialPrompt };
}

/**
 * Unblind a validated comparison judgment's verdict and check graft
 * coherence — the one place both delivery paths must agree before anything is
 * rendered. `errorLabel` names the judgment's source (a dispatch id for the
 * command lane, a file path for `--record`) so a refusal points at the thing
 * that produced the bad judgment.
 */
function unblindAndCheckCoherence(
  comparison: RawComparisonJudgment,
  blinding: { a: CompareArm; b: CompareArm },
  errorLabel: string,
): ModelComparisonVerdict {
  if (!isJudgmentVerdict(comparison.verdict)) {
    // Structurally redundant with the schema's own `verdict` enum, but that
    // enum and `MODEL_COMPARISON_VERDICTS` are two independently maintained
    // lists — the exact drift shape this module exists to close off. If they
    // ever disagree, refuse rather than write a verdict `VERDICT_BUCKET`
    // cannot count.
    throw new CompareCommandError(`${errorLabel} emitted an unrecognized verdict "${comparison.verdict}" — writing nothing.`);
  }
  // Unblind the verdict HERE, with `graft_plan.from_arm`, and nowhere else.
  // The judge answers in `prefer_a` / `prefer_b`, the only frame it has; this
  // is the single translation into the artifact's primary/challenger frame.
  const verdict = unblindVerdict(comparison.verdict, blinding);
  const coherence = checkGraftCoherence(verdict, comparison.graft_plan as unknown as GraftStep[] | undefined);
  if (coherence != null) {
    throw new CompareCommandError(`${errorLabel} produced an incoherent judgment (${coherence}) — writing nothing.`);
  }
  return verdict;
}

/**
 * Render, write, and round-trip-verify the `ModelComparison` artifact — the
 * back half shared by every delivery path, once a validated, unblinded
 * verdict and both judgments are in hand.
 */
function writeComparisonArtifact(args: {
  measurement: CompareMeasurement;
  pair: ResolvedDispatchPair;
  repoRoot: string;
  blinding: { a: CompareArm; b: CompareArm };
  verdict: ModelComparisonVerdict;
  comparison: RawComparisonJudgment;
  adversarial: RawAdversarialJudgment;
  judgeDelivery: JudgeDelivery;
  /** The resolved judge dispatch's own provider — command-lane only; null when nothing was dispatched. */
  judgeProvider: string | null;
  judgeDispatchIds: { comparison: string; adversarial: string } | null;
  now: Date;
}): CompareAdjudicatedResult {
  const { measurement, pair, repoRoot, blinding, verdict, comparison, adversarial, judgeDelivery, judgeProvider, judgeDispatchIds, now } = args;
  const primaryArm = measurement.arms.find((a) => a.arm === 'primary')!;
  const challengerArm = measurement.arms.find((a) => a.arm === 'challenger')!;

  // Judge-provider confound: computed AFTER dispatch, from the resolved
  // delivery's own provider — never shown to the judge, since it is a caveat
  // about trusting the verdict, not a fact about the pair. Only known on the
  // command lane: a host-delivered judgment names no provider to compare.
  const confounds = [...measurement.confounds];
  if (judgeProvider != null) {
    const matches: CompareArm[] = [];
    if (primaryArm.provider != null && primaryArm.provider === judgeProvider) matches.push('primary');
    if (challengerArm.provider != null && challengerArm.provider === judgeProvider) matches.push('challenger');
    if (matches.length > 0) {
      confounds.push({
        code: 'judge_provider_shared',
        arm: matches.length === 2 ? 'pair' : matches[0]!,
        detail: `the judge's provider ("${judgeProvider}") matches ${matches.join(' and ')} — a same-family judge is a disclosure, not an error.`,
      });
    }
  }
  // A host-delivered judgment carries no dispatch receipt: the kernel cannot
  // attest that a model produced it, only that the JSON validates. The same
  // access that lets a host `judge` subagent read this pair also lets a
  // coordinator author the file by hand — this is disclosed as a confound
  // (the vocabulary readers already check) rather than left inferrable only
  // from `judge_delivery` in the frontmatter a reader must know to look for.
  if (judgeDelivery === 'host') {
    confounds.push({
      code: 'judge_delivery_unattested',
      arm: 'pair',
      detail:
        'this judgment was recorded via `fadeno compare --record`, not dispatched by this command — there is no ' +
        'receipt for who or what produced the JSON, only that it validates against the schema.',
    });
  }

  const graftPlan: GraftStep[] | undefined = comparison.graft_plan != null
    ? comparison.graft_plan.map((s) => ({
        from_arm: armFor(s.from_arm, blinding),
        what: s.what,
        why: s.why,
        ...(s.paths != null ? { paths: s.paths } : {}),
      }))
    : undefined;

  const dispatchIds = [pair.primary?.dispatchId, pair.shadow?.dispatchId, judgeDispatchIds?.comparison, judgeDispatchIds?.adversarial]
    .filter((id): id is string => id != null);

  const frontmatter: ModelComparisonFrontmatter = {
    kind: 'ModelComparison',
    baseline: primaryArm.executor ?? 'unknown',
    challenger: challengerArm.executor ?? 'unknown',
    verdict,
    date: now.toISOString().slice(0, 10),
    pair_id: measurement.pairId,
    dispatch_ids: dispatchIds,
    judge_delivery: judgeDelivery,
    ...(graftPlan != null ? { graft_plan: graftPlan } : {}),
  };

  const body = renderComparisonArtifact(frontmatter, {
    Criteria: renderCriteria(comparison.criteria, blinding),
    'Model traits': renderTraits(comparison.traits ?? [], blinding),
    Confounds: renderConfounds(confounds, comparison.confound_notes),
    'Shared blind spots': renderSharedBlindSpots(adversarial.shared_blind_spots),
    graftPlan: graftPlan != null ? renderGraftPlan(graftPlan) : null,
  });

  const comparisonsRelDir = COMPARISONS_DIR.split('\\').join('/');
  // The FULL pair id, not the 8-char display prefix. Two pairs sharing eight
  // hex characters would silently overwrite each other's verdict — no error,
  // no arm-level difference, just one adjudication replacing another in the
  // accumulation the scorecard exists to build. Found by the adversarial pass
  // on the pair that built this command; both arms had it.
  const comparisonPath = `${comparisonsRelDir}/${measurement.pairId}.md`;
  mkdirSync(join(repoRoot, comparisonsRelDir), { recursive: true });
  writeFileSync(join(repoRoot, comparisonPath), body, 'utf8');
  // Read back what was just written, through the SAME parser the scorecard
  // uses. The writer and the reader are two consumers of one contract, and
  // this is the only thing that makes them agree by construction rather than
  // by assumption. Grafted from pair 1880a960's challenger arm, which did this
  // and whose primary wrote blind; a rejected artifact is otherwise silent —
  // it is counted as skipped and its verdict is simply gone.
  const roundTrip = parseModelComparisonFile(repoRoot, comparisonPath);
  if (!roundTrip.valid) {
    rmSync(join(repoRoot, comparisonPath), { force: true });
    throw new CompareCommandError(
      `the rendered artifact for pair ${measurement.pairId.slice(0, 8)} is not readable by the scorecard ` +
        `(${roundTrip.error ?? 'unknown'}) — removed it rather than leave a verdict the reader silently skips.`,
    );
  }

  return {
    ...measurement,
    confounds,
    measureOnly: false,
    verdict,
    comparisonPath,
    judgeDelivery,
    judgeDispatchIds,
    graftPlan: graftPlan ?? null,
  };
}

/** The one-shot path: dispatch both judges over the command lane, then render. Unchanged behaviour from before the `--prepare`/`--record` split. */
function adjudicateViaCommand(
  measurement: CompareMeasurement,
  pair: ResolvedDispatchPair,
  repoRoot: string,
  cwd: string,
  opts: CompareOptions,
): CompareAdjudicatedResult {
  const prepared = preparePrompts(measurement, pair, repoRoot);
  const pairId8 = measurement.pairId.slice(0, 8);
  const judgeCallOpts = { repoRoot, cwd, judgeModel: opts.judgeModel ?? null, judgeVia: opts.judgeVia ?? null, now: opts.now };

  const comparisonResult = dispatchJudge(prepared.comparisonPrompt, { ...judgeCallOpts, tag: `cmp-${pairId8}` });
  const comparisonParsed = extractJsonObject(comparisonResult.stdout);
  if (comparisonParsed == null || !prepared.validateComparison(comparisonParsed)) {
    const errors = comparisonParsed == null
      ? ["could not find a JSON object in the judge's output"]
      : schemaErrorMessages(prepared.validateComparison);
    throw new CompareCommandError(
      `comparison judge dispatch ${comparisonResult.dispatchId.slice(0, 8)} did not return a judgment that validates ` +
        `against model-comparison.schema.json — writing nothing. ${errors.join('; ')}`,
    );
  }
  const comparison = comparisonParsed as RawComparisonJudgment;
  const verdict = unblindAndCheckCoherence(comparison, prepared.blinding, `comparison judge dispatch ${comparisonResult.dispatchId.slice(0, 8)}`);

  const adversarialResult = dispatchJudge(prepared.adversarialPrompt, { ...judgeCallOpts, tag: `adv-${pairId8}` });
  const adversarialParsed = extractJsonObject(adversarialResult.stdout);
  if (adversarialParsed == null || !prepared.validateAdversarial(adversarialParsed)) {
    const errors = adversarialParsed == null
      ? ["could not find a JSON object in the judge's output"]
      : schemaErrorMessages(prepared.validateAdversarial);
    throw new CompareCommandError(
      `adversarial judge dispatch ${adversarialResult.dispatchId.slice(0, 8)} did not return a judgment that validates ` +
        `— writing nothing. ${errors.join('; ')}`,
    );
  }
  const adversarial = adversarialParsed as RawAdversarialJudgment;

  return writeComparisonArtifact({
    measurement,
    pair,
    repoRoot,
    blinding: prepared.blinding,
    verdict,
    comparison,
    adversarial,
    judgeDelivery: 'command',
    judgeProvider: comparisonResult.provider,
    judgeDispatchIds: { comparison: comparisonResult.dispatchId, adversarial: adversarialResult.dispatchId },
    now: opts.now ?? new Date(),
  });
}

/** Common front matter for `--prepare` and `--record`: resolve the ref, measure, and refuse an incomplete pair before doing anything else. */
function measureCompletePair(ref: string, cwd: string, repoRoot: string): { measurement: CompareMeasurement; pair: ResolvedDispatchPair } {
  const { measurement, pair } = measure(ref, cwd, repoRoot);
  if (pair.primary == null || pair.shadow == null) {
    throw new CompareCommandError(
      `pair "${measurement.pairId.slice(0, 8)}" is missing an arm (primary: ${pair.primary != null}, ` +
        `challenger: ${pair.shadow != null}) — adjudication needs both to compare.`,
    );
  }
  return { measurement, pair };
}

/**
 * Measure a shadow pair, derive its blinding, and write the two blinded judge
 * prompts to disk. Writes NO artifact — nothing is judged yet.
 *
 * This is the half of adjudication that needs no model: a host harness that
 * already has a `judge` subagent for free can spawn it directly on these
 * prompt files instead of going through a second dial'd command-lane vendor.
 * The two prompt files are independent inputs for two INDEPENDENT spawns —
 * see the `fadeno-judge` skill for why folding the adversarial pass into the
 * comparison spawn defeats its purpose.
 */
export function runComparePrepare(opts: ComparePrepareOptions): ComparePrepareResult {
  const ref = (opts.ref ?? '').trim();
  if (ref === '') {
    throw new CompareCommandError('name a pair id or dispatch id (fadeno compare <pair-id|dispatch-id> --prepare).');
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { measurement, pair } = measureCompletePair(ref, cwd, repoRoot);
  const prepared = preparePrompts(measurement, pair, repoRoot);

  const pairId8 = measurement.pairId.slice(0, 8);
  const promptsDir = join('.fadeno', 'local', 'prompts');
  mkdirSync(join(repoRoot, promptsDir), { recursive: true });
  const comparisonPromptPath = join(promptsDir, `judge-comparison-${pairId8}.md`).split('\\').join('/');
  const adversarialPromptPath = join(promptsDir, `judge-adversarial-${pairId8}.md`).split('\\').join('/');
  writeFileSync(join(repoRoot, comparisonPromptPath), prepared.comparisonPrompt, 'utf8');
  writeFileSync(join(repoRoot, adversarialPromptPath), prepared.adversarialPrompt, 'utf8');

  return {
    ...measurement,
    prepared: true,
    judgeArchetype: 'judge',
    comparisonPromptPath,
    adversarialPromptPath,
  };
}

/** Read a judgment file a caller passed to `--record`, resolved against `cwd` exactly like `dispatch --prompt-file`. */
function readJudgmentFile(cwd: string, path: string, label: 'comparison' | 'adversarial'): string {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw new CompareCommandError(
      `no ${label} judgment file at "${path}" — fadeno compare --record needs the file the judge subagent ` +
        '--prepare told you to spawn actually wrote.',
    );
  }
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    throw new CompareCommandError(`could not read ${label} judgment file "${path}": ${(err as Error).message}`);
  }
}

/**
 * Read back the two judgments `--prepare`'s prompts produced, validate them
 * against the same schema the command lane uses, unblind, render, and write
 * the `ModelComparison` artifact — with `judge_delivery: host`.
 *
 * Re-derives blinding and re-measures the pair from scratch rather than
 * trusting anything passed between calls: `deriveBlinding` is a pure function
 * of the pair id, so as long as the ledger and diffs `--prepare` read are
 * unchanged, this reconstructs byte-identical blinding and measurement with
 * no state carried over.
 */
export function runCompareRecord(opts: CompareRecordOptions): CompareAdjudicatedResult {
  const ref = (opts.ref ?? '').trim();
  if (ref === '') {
    throw new CompareCommandError('name a pair id or dispatch id (fadeno compare <pair-id|dispatch-id> --record).');
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { measurement, pair } = measureCompletePair(ref, cwd, repoRoot);
  const prepared = preparePrompts(measurement, pair, repoRoot);

  const comparisonText = readJudgmentFile(cwd, opts.comparisonPath, 'comparison');
  const comparisonParsed = extractJsonObject(comparisonText);
  if (comparisonParsed == null || !prepared.validateComparison(comparisonParsed)) {
    const errors = comparisonParsed == null
      ? ['could not find a JSON object in the recorded comparison judgment']
      : schemaErrorMessages(prepared.validateComparison);
    throw new CompareCommandError(
      `the recorded comparison judgment (${opts.comparisonPath}) did not validate against ` +
        `model-comparison.schema.json — writing nothing. ${errors.join('; ')}`,
    );
  }
  const comparison = comparisonParsed as RawComparisonJudgment;
  const verdict = unblindAndCheckCoherence(comparison, prepared.blinding, `the recorded comparison judgment (${opts.comparisonPath})`);

  const adversarialText = readJudgmentFile(cwd, opts.adversarialPath, 'adversarial');
  const adversarialParsed = extractJsonObject(adversarialText);
  if (adversarialParsed == null || !prepared.validateAdversarial(adversarialParsed)) {
    const errors = adversarialParsed == null
      ? ['could not find a JSON object in the recorded adversarial judgment']
      : schemaErrorMessages(prepared.validateAdversarial);
    throw new CompareCommandError(
      `the recorded adversarial judgment (${opts.adversarialPath}) did not validate — writing nothing. ${errors.join('; ')}`,
    );
  }
  const adversarial = adversarialParsed as RawAdversarialJudgment;

  return writeComparisonArtifact({
    measurement,
    pair,
    repoRoot,
    blinding: prepared.blinding,
    verdict,
    comparison,
    adversarial,
    judgeDelivery: 'host',
    judgeProvider: null,
    judgeDispatchIds: null,
    now: opts.now ?? new Date(),
  });
}

/**
 * Measure a shadow pair and, unless `--measure-only`, adjudicate it: two
 * blinded `judge` dispatches (a comparison and a shared-blind-spot
 * adversarial pass) and a `ModelComparison` artifact written to
 * `.fadeno/comparisons/<pair-id-8>.md`.
 */
export function runCompare(opts: CompareOptions): CompareResult {
  const ref = (opts.ref ?? '').trim();
  if (ref === '') {
    throw new CompareCommandError('name a pair id or dispatch id (fadeno compare <pair-id|dispatch-id>).');
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { measurement, pair } = measure(ref, cwd, repoRoot);

  if (opts.measureOnly === true) {
    return { ...measurement, measureOnly: true };
  }
  if (pair.primary == null || pair.shadow == null) {
    throw new CompareCommandError(
      `pair "${measurement.pairId.slice(0, 8)}" is missing an arm (primary: ${pair.primary != null}, ` +
        `challenger: ${pair.shadow != null}) — adjudication needs both to compare.`,
    );
  }
  return adjudicateViaCommand(measurement, pair, repoRoot, cwd, opts);
}

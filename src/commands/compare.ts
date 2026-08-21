import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { loadExecutorProfile } from '../lib/executors.ts';
import { resolveDispatchPair, type DispatchEntry } from './dispatches.ts';

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
    | 'exit_code_differs';
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

export interface CompareResult {
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
  /** True while `fadeno compare` can only measure; adjudication is phase 6b. */
  measureOnly: true;
}

export interface CompareOptions {
  /** A `pair_id`, or either arm's `dispatch_id` (full, or an 8+ char prefix). */
  ref: string;
  measureOnly?: boolean;
  cwd?: string;
  repoRoot?: string;
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
      arm, dispatchId: null, executor: null, model: null, reasoningEffort: null, attestedEffort: null,
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
 * Adjudication is a separate stage by design. The standing rule is that gates
 * never ask an LLM: an evaluator emits a structured judgment artifact and a
 * deterministic condition consumes it. Measuring first also means the judge
 * receives facts it cannot get wrong instead of being asked to eyeball two
 * diffs and estimate them.
 */
export function runCompare(opts: CompareOptions): CompareResult {
  const ref = (opts.ref ?? '').trim();
  if (ref === '') {
    throw new CompareCommandError('name a pair id or dispatch id (fadeno compare <pair-id|dispatch-id>).');
  }
  if (opts.measureOnly !== true) {
    throw new CompareCommandError(
      'fadeno compare currently measures only — pass --measure-only. Adjudication (the blinded judge dispatch ' +
        'and the ModelComparison artifact) is not built yet, and writing an artifact with no judgment in it ' +
        'would put an empty verdict into the scorecard.',
    );
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
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

  return {
    pairId: pair.pairId,
    archetype: pair.primary?.archetype ?? pair.shadow?.archetype ?? null,
    baselineCommit: baseline,
    arms,
    reachDifferential: reachDifferentialOf(arms[0]!, arms[1]!),
    confounds: confoundsOf(pair.primary, pair.shadow),
    surfaces,
    measureOnly: true,
  };
}

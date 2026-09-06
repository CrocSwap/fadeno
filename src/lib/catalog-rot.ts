/**
 * Catalog rot — the two ways a working setup goes quietly wrong over time.
 *
 * Both failures share a shape: nothing errors, nothing is missing, and the
 * thing that used to be true simply stopped being true while every command
 * kept reporting success.
 *
 * 1. **The user catalog decays under the loader.** `fadeno model add` writes
 *    `~/.config/fadeno/executors.yaml` as MACHINE STATE, possibly under a
 *    fadeno two versions old. `config-layers.ts` therefore reads that one
 *    layer tolerantly: `repairUserLayer` translates what it can before the
 *    merge and `dropUndeliverableUserModels` discards what it must after it,
 *    so one stale entry cannot take out every unrelated command (observed
 *    2026-09-05: an `ox` alias with a provider no harness claimed bricked
 *    `fadeno dial reviewer opus` from a bare shell). That tolerance is right,
 *    and it is also silent: the alias is GONE and only `fadeno dial` on a
 *    self-contained catalog ever printed the note. A dropped alias is not a
 *    smaller catalog, it is a personal model the user still believes in.
 *
 * 2. **The verification cache never expires.** `verifyModelAgainstHarness`
 *    probes a harness's `models_command` once per `(harness, model)` and
 *    records `verified_at`; `isModelVerified` is then a pure EXISTENCE check
 *    with no notion of age, so a row written a year ago short-circuits the
 *    probe forever. Providers retire model ids without notice — the row keeps
 *    asserting a listing membership nobody has re-checked since.
 *
 * Deliberately pure: no filesystem, no clock, no spawning. `doctor.ts` reads
 * the loader outcome and the cache and feeds them in; everything here is a
 * total function of its arguments, which is what makes the age boundary and
 * the missing/stale split testable without a fixture directory.
 *
 * Nothing here re-probes. A probe inside `fadeno dial resolve` would run under
 * the steering hook's hard timeout and land as a denied spawn, so staleness is
 * a DOCTOR finding and only ever a doctor finding.
 */

/**
 * Structurally identical to `DoctorFinding` in `src/commands/doctor.ts`, and
 * declared here instead of imported: `src/lib/` must not depend on
 * `src/commands/`, and the severity union is small enough that a second
 * spelling of it is cheaper than the inverted dependency.
 */
export interface RotFinding {
  check: string;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
  remediation?: string;
}

/**
 * How old a `verified_at` may be before the row stops counting as evidence.
 *
 * Thirty days is a judgment, not a measurement: it is long enough that a
 * stable setup is never nagged and short enough that a retired model id is
 * caught within a release cycle. Exported so a test asserts the boundary
 * rather than a hard-coded copy of it.
 */
export const VERIFICATION_MAX_AGE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * Age of a verification row in whole-ish days, or `null` when its timestamp
 * cannot be read.
 *
 * A row from the FUTURE reads as age 0 rather than as a negative number: the
 * only ways to get one are a clock that moved backwards or a hand-edited
 * file, and neither is evidence that the model listing went stale. Reporting
 * "verified in -3 days" would be noise about the clock dressed as a finding
 * about the catalog.
 */
function ageInDays(verifiedAt: string, now: Date): number | null {
  const parsed = Date.parse(verifiedAt);
  if (!Number.isFinite(parsed)) return null;
  const elapsed = now.getTime() - parsed;
  return elapsed <= 0 ? 0 : elapsed / MS_PER_DAY;
}

/**
 * Whether a cached verification still counts as evidence.
 *
 * Three outcomes, not two, because the remediation differs in what it can
 * promise: `missing` means nothing ever confirmed this pair and the next
 * `fadeno dial` will probe it, while `stale` means a row EXISTS — so the
 * existence-only cache check short-circuits the probe and re-dialing alone
 * changes nothing.
 *
 * A row whose `verified_at` does not parse is `stale`, not `missing`. It is
 * on disk, so calling it missing would claim the pair was never verified
 * while the file says otherwise; what it has lost is its proof of age, which
 * is exactly what staleness means here.
 */
export function isVerificationStale(
  entry: { verified_at: string } | null | undefined,
  now: Date,
  maxAgeDays: number = VERIFICATION_MAX_AGE_DAYS,
): 'missing' | 'stale' | 'fresh' {
  if (entry == null) return 'missing';
  const age = ageInDays(entry.verified_at, now);
  if (age == null) return 'stale';
  return age > maxAgeDays ? 'stale' : 'fresh';
}

/**
 * The one remediation for everything the tolerant user-layer read changed.
 *
 * Both halves name a command that exists: `fadeno models add` is the writer of
 * the user catalog and `fadeno models remove` is its deleter (it also drops
 * the alias's cached verification rows, which is why it is preferable to a
 * hand edit — the hand edit leaves the cache vouching for a model no catalog
 * still names). No path literal appears here: the loader's own note already
 * embeds the absolute catalog path, and `~/.config/fadeno/executors.yaml` is
 * only correct on an XDG default.
 */
const REPAIR_REMEDIATION =
  'Re-add the alias against a harness this catalog actually declares — ' +
  '`fadeno models add <alias> <provider/id> --harness <h>` — or, for one that is simply dead, ' +
  '`fadeno models remove <alias>`, which deletes it and its cached verification rows together. ' +
  'Until then the alias is absent from the effective catalog and any dial naming it fails.';

/**
 * One finding per note the layered loader produced for the USER catalog.
 *
 * Repairs and drops are kept as the loader phrased them — they are already
 * whole sentences naming the file and the key, and re-wrapping them in a
 * category label loses the file path. Order is preserved (repairs first, as
 * the loader runs them first), and exact duplicates collapse: the same note
 * can be produced on both loader paths, and reporting it twice reads as two
 * separate defects.
 */
export function catalogRepairFindings(
  input: { repairs: readonly string[]; drops: readonly string[] },
): RotFinding[] {
  const seen = new Set<string>();
  const findings: RotFinding[] = [];
  for (const note of [...input.repairs, ...input.drops]) {
    const detail = note.trim();
    if (detail.length === 0 || seen.has(detail)) continue;
    seen.add(detail);
    findings.push({
      check: 'user-catalog-repairs',
      severity: 'warning',
      detail,
      remediation: REPAIR_REMEDIATION,
    });
  }
  return findings;
}

/**
 * One finding per loader note about a `timeout_ms` / `timeout` declaration the
 * catalog still carries.
 *
 * This is the third way a working setup goes quietly wrong, and it arrived
 * with the removal of executor deadlines: the key is now inert, so a catalog
 * that declares it neither errors nor does anything, and the only surface that
 * would ever mention it is a loader note nobody reads. Left alone it is a
 * standing invitation to believe Fadeno still enforces a wall it does not.
 *
 * Matched by the shared token rather than by re-deriving the sentence, so the
 * loader and this filter cannot drift into disagreeing about which notes are
 * about deadlines. `notes` carries every note the loader produced, deadline or
 * not; everything else passes through untouched.
 */
export function ignoredDeadlineFindings(
  notes: readonly string[],
  token: string,
): RotFinding[] {
  const seen = new Set<string>();
  const findings: RotFinding[] = [];
  for (const note of notes) {
    const detail = note.trim();
    if (detail.length === 0 || !detail.includes(token) || seen.has(detail)) continue;
    seen.add(detail);
    findings.push({
      check: 'ignored-deadline-key',
      severity: 'warning',
      detail,
      remediation:
        'Delete the key from the catalog. It has no effect: no executor runs under a deadline, ' +
        'and ending a long attempt is `fadeno cancel` / `fadeno dispatches --cancel`.',
    });
  }
  return findings;
}

/**
 * One finding per DIALED `(harness, model_id)` whose verification row is
 * missing or older than `VERIFICATION_MAX_AGE_DAYS`.
 *
 * EVERY resolved dial is audited, including one whose harness declares no
 * `models_command`. Filtering those out is tempting — nothing can re-probe
 * them, so the warning cannot be cleared by running a command — but the filter
 * answers the wrong question: "is this row refreshable" is not "is this model
 * verified". A dial onto an unlistable harness has never been confirmed by
 * anything and never will be, and a doctor that stays quiet about it is
 * reporting a check it did not run. So the finding is raised and the
 * REMEDIATION is what changes: it says plainly that nothing re-probes the
 * pair, rather than naming a command that would report it `skipped`.
 *
 * Grouped by the pair rather than by archetype: three archetypes dialing the
 * same model is one unverified model, not three, and the finding names every
 * archetype that would be affected. `verifyCommand` is supplied by the caller
 * so the library states no opinion about CLI spelling.
 *
 * A `fresh` pair produces nothing at all. This check is one of two that exist
 * only to say the setup is rotting; an `ok` row per verified model would bury
 * the ones that are not.
 */
export function verificationFindings(
  input: {
    dialed: ReadonlyArray<{
      archetype: string;
      harness: string;
      modelId: string;
      /**
       * Whether this dial's harness declares a `models_command`. Optional and
       * defaulting to TRUE: a caller that cannot tell gets the refreshable
       * wording, which at least names a command that exists. `doctor.ts`
       * always passes it — it has the harness table in hand.
       */
      listable?: boolean;
    }>;
    verifications: ReadonlyArray<{ harness: string; model: string; verified_at: string }>;
    now: Date;
    verifyCommand: string;
    /**
     * Absolute path of the verification cache, named in the remediation for an
     * unlistable pair: deleting the row by hand is the only thing that clears
     * a stale one there, so the path has to be sayable. Optional; the file's
     * bare name stands in when the caller has none.
     */
    verificationsPath?: string;
  },
): RotFinding[] {
  const grouped = new Map<string, { harness: string; modelId: string; archetypes: string[]; listable: boolean }>();
  for (const dial of input.dialed) {
    const key = `${dial.harness}\u0000${dial.modelId}`;
    const existing = grouped.get(key);
    // Listability is a property of the harness, so every dial in a group
    // agrees; the `||` below is defensive, not meaningful.
    const listable = dial.listable !== false;
    if (existing == null) {
      grouped.set(key, { harness: dial.harness, modelId: dial.modelId, archetypes: [dial.archetype], listable });
    } else {
      if (!existing.archetypes.includes(dial.archetype)) existing.archetypes.push(dial.archetype);
      existing.listable = existing.listable || listable;
    }
  }
  const cachePath = input.verificationsPath ?? 'model-verifications.json';
  const findings: RotFinding[] = [];
  const ordered = [...grouped.values()].sort((a, b) =>
    a.harness !== b.harness ? a.harness.localeCompare(b.harness) : a.modelId.localeCompare(b.modelId));
  for (const group of ordered) {
    const entry = input.verifications.find(
      (row) => row.harness === group.harness && row.model === group.modelId,
    ) ?? null;
    const state = isVerificationStale(entry, input.now);
    if (state === 'fresh') continue;
    const dialers = `dialed by ${[...group.archetypes].sort().join(', ')}`;
    const label = `"${group.modelId}" on ${group.harness}`;
    // An unlistable harness has no `models_command`, so no probe — dial-time,
    // `fadeno models verify`, or `fadeno doctor --probe-models` — can ever
    // touch this pair. Saying "run X" would be a remediation that reports
    // `skipped` and changes nothing, which is worse than saying nothing.
    const unlistable = `${group.harness} declares no \`models_command\`, so nothing can probe it: ` +
      `${input.verifyCommand} reports this pair \`skipped\` and \`fadeno dial\` records it unverified.`;
    if (state === 'missing') {
      findings.push({
        check: 'model-verification-stale',
        severity: 'warning',
        detail:
          `${label} (${dialers}) has no row in the model-verification cache — nothing has ever confirmed ` +
          `that ${group.harness} lists this model id, so a dispatch is the first thing that would find out`,
        remediation: group.listable
          ? `${input.verifyCommand} probes the harness for every dialed pair and records a row for ` +
            'each one the listing names.'
          : `${unlistable} Nothing to run: either accept the dial unverified — the dispatch itself is the ` +
            'only test — or re-dial the archetype onto a harness that can list its models ' +
            '(`fadeno dial <archetype> <ref> --harness <listable>`).',
      });
      continue;
    }
    const age = entry != null ? ageInDays(entry.verified_at, input.now) : null;
    const when = age == null
      ? `carries an unreadable verified_at ("${entry?.verified_at ?? ''}")`
      : `was last verified ${Math.floor(age)} days ago (${entry!.verified_at})`;
    findings.push({
      check: 'model-verification-stale',
      severity: 'warning',
      detail:
        `${label} (${dialers}) ${when}, past the ${VERIFICATION_MAX_AGE_DAYS}-day freshness window — ` +
        'a provider can retire a model id without notice and the cached row keeps asserting it is listed',
      remediation: group.listable
        ? `${input.verifyCommand} ignores the cache and always re-probes: it refreshes this row when the ` +
          'harness still lists the id and deletes it when the listing does not. Re-dialing alone will not — ' +
          '`fadeno dial` checks the cache for EXISTENCE, not age, so an existing row short-circuits its probe.'
        : `${unlistable} The row can only be cleared by hand: delete the ${group.harness}/${group.modelId} ` +
          `entry from ${cachePath} if you no longer trust it, or re-dial the archetype onto a harness that ` +
          'can list its models. Re-dialing alone will not — `fadeno dial` checks the cache for EXISTENCE, ' +
          'not age.',
    });
  }
  return findings;
}

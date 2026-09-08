/**
 * Catalog-rot check: is every DIALED model still in its harness's own model
 * listing?
 *
 * A dial is written once and then rots silently — the vendor retires the id,
 * renames it, or moves it behind a different prefix, and the next dispatch
 * fails deep inside a spawned CLI with a vendor error nobody reads as "your
 * dial is stale". This module asks the harness the same question
 * `fadeno models <harness>` asks, and turns a miss into a doctor finding.
 *
 * Two halves, deliberately split:
 *   - `listHarnessModels` spawns; it is the ONLY side effect here.
 *   - `listingFindings` is pure — findings in, findings out — so the doctor
 *     can be tested without a vendor CLI on PATH.
 *
 * The parser (`parseListedIds`) and the membership rule (`listingContains`)
 * live HERE and `src/commands/models.ts` imports them, rather than each
 * keeping its own copy. That direction is forced — `src/lib/` must not import
 * from `src/commands/` — and it is also the point: a second spelling of
 * "listed" is exactly the silent-wrong-answer shape this check exists to
 * close. The doctor and `fadeno models` cannot disagree about what the backend
 * named if there is only one function that decides.
 *
 * The qualify half is `qualifyListedModelId` from `./executors.ts`, the same
 * function `fadeno dial`'s probe and `fadeno models verify` call: a dialed id
 * is prefixed with the harness's `models_prefix` (when it does not already
 * carry it) and compared against the RAW listing tokens. The listing is never
 * de-prefixed to meet a bare dial halfway — a prefixed harness that prints a
 * bare token does not deliver that dial, and `fadeno dial` would refuse it.
 */

import { spawnSync } from 'node:child_process';
import { qualifyListedModelId } from './executors.ts';

/** Structurally identical to `DoctorFinding`; declared locally so this stays a lib. */
export interface ListingFinding {
  check: string;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
  remediation?: string;
}

/**
 * The listing seam, matching `HarnessListingOptions['spawn']` in
 * `src/commands/models.ts` call for call: the argv as one array plus a timeout,
 * returning `spawnSync`'s result fields. It is not `spawnSync` itself —
 * `defaultSpawn` below wraps it, exactly as models.ts does.
 */
export type SpawnLike = (
  command: string[],
  opts: { timeout: number },
) => {
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  error?: Error;
};

/**
 * The listing-relevant slice of a catalog harness entry. Both prefix
 * spellings are accepted: `models_prefix` is the YAML key (and the spelling
 * the contract froze), `modelsPrefix` is what `parseExecutorProfile`
 * normalizes it to on `HarnessRaw`, so a parsed profile entry can be passed
 * straight through.
 */
export interface ListingHarnessEntry {
  models_command?: string[] | null;
  models_prefix?: string;
  modelsPrefix?: string;
}

export interface ModelListing {
  harness: string;
  /**
   * Exactly what the backend printed, in listing order, deduplicated — the
   * RAW tokens, never de-prefixed. `listingContains` moves the dialed id
   * toward the listing (via `qualifyListedModelId`) rather than the listing
   * toward the dial, because that is the direction `fadeno models`,
   * `fadeno models verify` and `fadeno dial`'s probe all use.
   */
  ids: string[];
  /**
   * The harness's `models_prefix`, carried alongside the tokens so a
   * membership question can be answered from the listing alone. OpenCode lists
   * `openrouter/anthropic/claude-x` while `-m` must receive
   * `anthropic/claude-x` — the prefix is a LISTING qualifier, not part of the
   * argv-facing id, so it has to be recorded rather than folded into `ids`.
   */
  prefix: string | null;
}

/** The same timeout `fadeno models` and the dial-time probe give a listing. */
export const LISTING_TIMEOUT_MS = 10_000;

export const CHECK_LISTING_MISSING = 'model-listing-missing';
export const CHECK_LISTING_UNAVAILABLE = 'model-listing-unavailable';

/**
 * A harness whose backend can be listed at all. Callers filter with this
 * BEFORE calling `listHarnessModels`: a harness that declares no
 * `models_command` is skipped silently, never reported as a failure.
 */
export function isListable(entry: ListingHarnessEntry | null | undefined): boolean {
  const command = entry?.models_command;
  return command != null && command.length > 0;
}

/**
 * The prefix a listing qualifies its ids with, or null. Both spellings are
 * read: `models_prefix` is the YAML key the contract froze, `modelsPrefix` is
 * what `parseExecutorProfile` normalizes it to, and a parsed profile entry is
 * the thing doctor actually has in hand.
 */
export function listingPrefixOf(entry: ListingHarnessEntry | null | undefined): string | null {
  const prefix = entry?.models_prefix ?? entry?.modelsPrefix;
  return prefix != null && prefix.length > 0 ? prefix : null;
}

/**
 * One listed id per non-prose line — first tab-delimited field, trimmed,
 * whitespace-bearing lines dropped, order preserved, deduplicated.
 *
 * THE listing parser: `runListingCommand` in `src/commands/models.ts` calls
 * this one rather than keeping a copy, so `fadeno models`, `fadeno models add`
 * and `fadeno doctor --probe-models` cannot disagree about which lines of a
 * backend's output are model ids.
 */
export function parseListedIds(stdout: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t')[0]!.trim())
    .filter((candidate) => candidate.length > 0 && !/\s/.test(candidate))) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function defaultSpawn(command: string[], opts: { timeout: number }): ReturnType<SpawnLike> {
  const run = spawnSync(command[0]!, command.slice(1), { timeout: opts.timeout, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', ...(run.error != null ? { error: run.error } : {}) };
}

/**
 * Run one harness's `models_command` and return what it listed. Never throws
 * for an unlistable or failing backend — a doctor check that dies because a
 * vendor CLI is missing is worse than the rot it looks for — so every failure
 * comes back as `{ ok: false, reason }` with the same wording
 * `fadeno models <harness>` would have raised.
 */
export function listHarnessModels(
  harness: string,
  entry: ListingHarnessEntry,
  spawnFn?: SpawnLike,
): { ok: true; listing: ModelListing } | { ok: false; reason: string } {
  const modelsCommand = entry.models_command;
  if (modelsCommand == null || modelsCommand.length === 0) {
    return { ok: false, reason: `harness "${harness}" declares no models_command — its backend cannot be listed.` };
  }
  const spawn = spawnFn ?? defaultSpawn;
  let result: ReturnType<SpawnLike>;
  try {
    result = spawn(modelsCommand, { timeout: LISTING_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, reason: `models_command failed for ${harness}: ${(err as Error).message}` };
  }
  // A timed-out or missing binary lands here: spawnSync reports both through
  // `error`, with a null status.
  if (result.error != null) return { ok: false, reason: `models_command failed for ${harness}: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, reason: `models_command for ${harness} exited ${result.status}.` };
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  return { ok: true, listing: { harness, ids: parseListedIds(stdout), prefix: listingPrefixOf(entry) } };
}

/**
 * Is `modelId` in this listing? The ONE membership rule, shared by
 * `fadeno models` and `fadeno doctor --probe-models`.
 *
 * Qualify the dialed id with the harness's prefix, then compare against the
 * raw tokens — `qualifyListedModelId`, the same call `fadeno dial`'s probe and
 * `fadeno models verify` make. A prefixed harness that prints a bare token
 * therefore does NOT satisfy a bare dial: `fadeno dial` refuses that dial and
 * `fadeno models` shows the token as registered by nothing, so a doctor that
 * accepted it would be the only voice in the codebase saying the dial is fine.
 */
export function listingContains(listing: ModelListing, modelId: string): boolean {
  return listing.ids.includes(qualifyListedModelId({ ...(listing.prefix != null ? { modelsPrefix: listing.prefix } : {}) }, modelId));
}

/**
 * The pure half. One `model-listing-missing` warning per dialed model its
 * harness no longer lists, and one `model-listing-unavailable` warning per
 * harness whose listing could not be read at all — never an error, because a
 * vendor CLI that is absent or slow says nothing about the dial.
 *
 * Skipped without a finding: a dialed model whose harness has no listing in
 * `listings` (it declares no `models_command`, or was not probed), and the
 * `host` identity, which names the session itself and appears in no
 * backend listing — the same case `src/commands/dial.ts` skips before probing.
 */
export function listingFindings(input: {
  dialed: ReadonlyArray<{ archetype: string; harness: string; modelId: string }>;
  listings: ReadonlyArray<{ harness: string; result: ReturnType<typeof listHarnessModels> }>;
}): ListingFinding[] {
  const byHarness = new Map<string, ReturnType<typeof listHarnessModels>>();
  for (const entry of input.listings) {
    if (!byHarness.has(entry.harness)) byHarness.set(entry.harness, entry.result);
  }
  const checkable = input.dialed.filter((dial) => dial.modelId !== 'host');

  const findings: ListingFinding[] = [];

  // An unreadable listing is reported once per harness, not once per dial —
  // and only when something is actually dialed onto it, so a harness nobody
  // uses cannot fill the report with noise.
  const unavailableReported = new Set<string>();
  for (const entry of input.listings) {
    const result = byHarness.get(entry.harness);
    if (result == null || result.ok) continue;
    if (unavailableReported.has(entry.harness)) continue;
    const dials = checkable.filter((dial) => dial.harness === entry.harness);
    if (dials.length === 0) continue;
    unavailableReported.add(entry.harness);
    findings.push({
      check: CHECK_LISTING_UNAVAILABLE,
      severity: 'warning',
      detail: `${entry.harness}: could not read the model listing (${result.reason}) — ${dials.length} dialed model(s) on it were not checked: ${dials.map((dial) => `${dial.archetype} → ${dial.modelId}`).join(', ')}.`,
      remediation: `Run \`fadeno models ${entry.harness}\` to see the failure directly, then retry \`fadeno doctor --probe-models\`.`,
    });
  }

  const reported = new Set<string>();
  for (const dial of checkable) {
    const result = byHarness.get(dial.harness);
    if (result == null || !result.ok) continue;
    if (listingContains(result.listing, dial.modelId)) continue;
    const key = `${dial.archetype}\u0000${dial.harness}\u0000${dial.modelId}`;
    if (reported.has(key)) continue;
    reported.add(key);
    // Name the QUALIFIED id whenever it differs from the dialed one: that is
    // the token to look for in `fadeno models <harness>` output, and the same
    // "listed as" spelling `fadeno dial` uses when it refuses the model.
    const listedAs = qualifyListedModelId(
      { ...(result.listing.prefix != null ? { modelsPrefix: result.listing.prefix } : {}) },
      dial.modelId,
    );
    const spelled = listedAs === dial.modelId ? '' : ` (listed as "${listedAs}")`;
    findings.push({
      check: CHECK_LISTING_MISSING,
      severity: 'warning',
      detail: `${dial.archetype} is dialed to "${dial.modelId}"${spelled} on ${dial.harness}, but that harness lists ${result.listing.ids.length} model id(s) and none of them is it — the dial is stale or the id was renamed.`,
      remediation: `Run \`fadeno models ${dial.harness}\` to see what the backend lists, then \`fadeno dial ${dial.archetype} <ref>\` to dial a listed model.`,
    });
  }

  return findings;
}

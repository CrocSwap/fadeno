import { loadLayeredProfile, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  ExecutorProfileError,
  qualifyListedModelId,
  type ExecutorProfile,
} from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import {
  recordVerifiedModel,
  removeVerifiedModels,
  type UserPathOptions,
} from '../lib/user-paths.ts';
import { DialError, probeModel, runDialShow, type ProbeOptions } from './dial.ts';

export class ModelsVerifyError extends Error {}

/**
 * What re-probing one dialed `(harness, model id)` pair concluded.
 *
 * `not_listed` is the only DEFINITIVE negative: the listing ran, exited zero,
 * and did not name the id. `unavailable` means the question could not be
 * asked — a backend that is down says nothing about whether the model exists,
 * so its rows are left exactly as they were.
 */
export type VerifyOutcome = 'verified' | 'not_listed' | 'unavailable' | 'skipped';

export interface ModelVerifyRow {
  /** Registry name (or verbatim dial spelling) this pair came from. */
  model: string;
  /** The delivered id — what the harness is actually asked for. */
  model_id: string;
  harness: string;
  /** The id as the harness's listing spells it (`models_prefix` applied). */
  listed_id: string | null;
  /** Every dialed archetype that resolves onto this pair, sorted. */
  archetypes: string[];
  outcome: VerifyOutcome;
  /** Why, for every outcome that is not a plain `verified`. */
  detail: string | null;
  /** The freshly written timestamp, on `verified` only. */
  verified_at: string | null;
  /** Cached rows deleted for this pair (`not_listed` only). */
  verifications_removed: number;
}

export interface ModelsVerifyResult {
  /** The ambient HOST this call ran inside; the probes themselves are host-free. */
  host: string;
  rows: ModelVerifyRow[];
  counts: Record<VerifyOutcome, number>;
  /** False when the caller should exit non-zero. */
  ok: boolean;
}

export interface ModelsVerifyOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  env?: NodeJS.ProcessEnv;
  /** Narrow to these aliases, delivered ids, or `provider/id` spellings. */
  refs?: readonly string[];
  /** Narrow to one executor harness. */
  harness?: string | null;
  /** Treat `unavailable` as a failure too. */
  strict?: boolean;
  spawn?: ProbeOptions['spawn'];
}

function loadLayered(repoRoot: string, userPathOptions?: UserPathOptions): LayeredProfile {
  try {
    return loadLayeredProfile(repoRoot, userPathOptions, activeHarness(undefined, userPathOptions));
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ModelsVerifyError(err.message);
    throw err;
  }
}

interface Target {
  /** The label for this pair: the first, sorted, of `models`. */
  model: string;
  model_id: string;
  harness: string;
  archetypes: string[];
  /** Alternate spellings a `<ref>` may name this target by. */
  aliases: Set<string>;
  /** Every registry name dialed onto this pair — several may share one. */
  models: Set<string>;
}

/**
 * Re-probe the models the dials actually point at, against the harness's own
 * `models_command`, ignoring the verification cache.
 *
 * The cache is existence-only: `probeModel` returns `cached` for any row that
 * exists, whatever its age, so a model a backend has since retired stays
 * "verified" forever and the first thing that notices is a failed dispatch.
 * This is the command that can say otherwise — and it deletes the rows it
 * disproves, because a cache that keeps vouching after the evidence is gone is
 * worse than no cache.
 *
 * User-invoked only. It spawns one listing per harness-model pair under a hard
 * timeout, which is far too slow for `dial resolve` or any hook path.
 */
export function runModelsVerify(opts: ModelsVerifyOptions = {}): ModelsVerifyResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const userPathOptions = opts.userPathOptions ?? {};
  const layered = loadLayered(repoRoot, userPathOptions);
  const profile: ExecutorProfile = layered.profile;
  const host = profile.host ?? 'standalone';

  const harnessFilter = opts.harness?.trim() ?? null;
  if (harnessFilter != null) {
    if (!Object.hasOwn(profile.harnesses ?? {}, harnessFilter)) {
      const declared = Object.keys(profile.harnesses ?? {}).sort();
      throw new ModelsVerifyError(`unknown harness "${harnessFilter}" — declared harnesses: ${declared.join(', ') || '(none)'}`);
    }
  }

  const show = (() => {
    try {
      return runDialShow({
        repoRoot,
        userPathOptions,
        ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
        ...(opts.env != null ? { env: opts.env } : {}),
      });
    } catch (err) {
      if (err instanceof DialError) throw new ModelsVerifyError(err.message);
      throw err;
    }
  })();

  // One target per distinct (harness, delivered id); several archetypes may
  // share it, and probing the same pair once per dial would just be slower.
  const targets = new Map<string, Target>();
  for (const row of show.rows) {
    if (row.harness == null || row.model_id === 'current-host') continue;
    const key = `${row.harness} ${row.model_id}`;
    let target = targets.get(key);
    if (target == null) {
      target = { model: row.model, model_id: row.model_id, harness: row.harness, archetypes: [], aliases: new Set<string>(), models: new Set<string>() };
      targets.set(key, target);
    }
    // EVERY row's spellings, not just the first one's. Two dialed aliases can
    // deliver the same id on the same harness (`alpha` and `beta` both
    // resolving to `same` on codex); collecting names only when the target is
    // created left whichever row happened to come first as the only matchable
    // spelling, and `models verify beta` then threw "no dialed model matches"
    // for a model that is plainly dialed.
    //
    // Still deliberately NOT every `spellings:` value: a spelling belongs to
    // one harness, and letting `<ref> anthropic/claude-opus` also select the
    // same model's delivery on a DIFFERENT harness verifies a pair the user
    // did not name. `model_id` is already this target's spelling.
    target.models.add(row.model);
    target.aliases.add(row.model);
    target.aliases.add(row.model_id);
    const entry = profile.models[row.model];
    if (entry != null) {
      target.aliases.add(`${entry.provider}/${entry.id}`);
      target.aliases.add(entry.id);
    }
    // Which of several aliases labels a shared delivery is arbitrary, so pick
    // it by sort order rather than by dial-iteration order — a name that moves
    // between runs is a diff nobody can read.
    target.model = [...target.models].sort()[0]!;
    if (!target.archetypes.includes(row.archetype)) target.archetypes.push(row.archetype);
  }

  let selected = [...targets.values()];
  if (harnessFilter != null) selected = selected.filter((target) => target.harness === harnessFilter);
  const refs = (opts.refs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);
  if (refs.length > 0) {
    // An unmatched ref is an error, not an empty result. Verifying nothing and
    // exiting 0 on a typo is the exact shape of answer this command exists to
    // stop producing.
    const unmatched = refs.filter((ref) => !selected.some((target) => target.aliases.has(ref)));
    if (unmatched.length > 0) {
      const known = [...new Set(selected.flatMap((target) => [...target.models]))].sort();
      throw new ModelsVerifyError(
        `no dialed model matches ${unmatched.map((ref) => `"${ref}"`).join(', ')}` +
          (harnessFilter != null ? ` on harness ${harnessFilter}` : '') +
          ` — dialed models: ${known.join(', ') || '(none)'}. \`fadeno dial\` shows the effective table.`,
      );
    }
    selected = selected.filter((target) => refs.some((ref) => target.aliases.has(ref)));
  }
  selected.sort((a, b) => (a.harness !== b.harness ? a.harness.localeCompare(b.harness) : a.model_id.localeCompare(b.model_id)));

  const rows: ModelVerifyRow[] = [];
  for (const target of selected) {
    const entry = profile.harnesses?.[target.harness] ?? null;
    const archetypes = [...target.archetypes].sort();
    const base = {
      model: target.model,
      model_id: target.model_id,
      harness: target.harness,
      listed_id: entry != null ? qualifyListedModelId(entry, target.model_id) : null,
      archetypes,
    };
    const listing = entry?.models_command ?? null;
    if (listing == null || listing.length === 0) {
      rows.push({
        ...base,
        outcome: 'skipped',
        detail: `harness ${target.harness} declares no models_command — its backend cannot be listed.`,
        verified_at: null,
        verifications_removed: 0,
      });
      continue;
    }
    try {
      const probe = probeModel(profile, target.harness, target.model_id, {
        userPathOptions,
        force: true,
        ...(opts.spawn != null ? { spawn: opts.spawn } : {}),
      });
      if (probe.status === 'verified') {
        // `probeModel` records only when no row exists yet, so a stale row
        // would survive its own re-verification. Replace it outright.
        removeVerifiedModels(userPathOptions, (row) => row.harness === target.harness && row.model === target.model_id);
        const verified_at = new Date().toISOString();
        recordVerifiedModel(userPathOptions, { harness: target.harness, model: target.model_id, verified_at });
        rows.push({ ...base, outcome: 'verified', detail: null, verified_at, verifications_removed: 0 });
      } else if (probe.status === null) {
        rows.push({ ...base, outcome: 'skipped', detail: 'host-native dial names no external model.', verified_at: null, verifications_removed: 0 });
      } else {
        rows.push({ ...base, outcome: 'unavailable', detail: probe.note ?? 'the listing could not be read; cached rows left as they were.', verified_at: null, verifications_removed: 0 });
      }
    } catch (err) {
      if (!(err instanceof DialError)) throw err;
      // The listing ran and did not name it: the one negative worth acting on.
      const removed = removeVerifiedModels(userPathOptions, (row) => row.harness === target.harness && row.model === target.model_id);
      rows.push({
        ...base,
        outcome: 'not_listed',
        detail: `${err.message} — re-dial with \`fadeno dial <archetype> <other>\`, or see \`fadeno models --harness ${target.harness}\`.`,
        verified_at: null,
        verifications_removed: removed,
      });
    }
  }

  const counts: Record<VerifyOutcome, number> = { verified: 0, not_listed: 0, unavailable: 0, skipped: 0 };
  for (const row of rows) counts[row.outcome] += 1;
  return {
    host,
    rows,
    counts,
    ok: counts.not_listed === 0 && (!opts.strict || counts.unavailable === 0),
  };
}

import { loadLayeredProfile, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  ExecutorProfileError,
  parseDialRef,
  qualifyListedModelId,
  resolveDelivery,
  resolveRegisteredModelRef,
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
 * What re-probing one `(harness, model id)` pair concluded.
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
  /** Every registry name dialed onto this pair — several may share one. */
  models: Set<string>;
}

/**
 * Re-probe selected model deliveries against the harness's own
 * `models_command`, ignoring the verification cache. With no explicit refs,
 * selection comes from effective archetype dials; with refs, it comes from
 * the merged registry and delivery compiler.
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

  // One target per distinct (harness, delivered id); several archetypes may
  // share it, and probing the same pair once per dial would just be slower.
  const targets = new Map<string, Target>();
  const refs = (opts.refs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);
  if (refs.length === 0) {
    // No refs intentionally remains dial-based. It answers "what named model
    // deliveries are currently selected by the effective archetype table?"
    // and therefore retains the existing skip behavior for unlistable dials.
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
    for (const row of show.rows) {
      if (row.harness == null || row.model_id === 'host') continue;
      const key = `${row.harness} ${row.model_id}`;
      let target = targets.get(key);
      if (target == null) {
        target = { model: row.model, model_id: row.model_id, harness: row.harness, archetypes: [], models: new Set<string>() };
        targets.set(key, target);
      }
      target.models.add(row.model);
      target.model = [...target.models].sort()[0]!;
      if (!target.archetypes.includes(row.archetype)) target.archetypes.push(row.archetype);
    }
  } else {
    // Explicit refs are registry queries, not filters over the dial table.
    // Resolve and validate every ref before probing any of them so one typo or
    // stale delivery cannot turn a multi-ref invocation into partial success.
    for (const raw of refs) {
      let parsed;
      try {
        parsed = parseDialRef(raw, 'model verification reference');
      } catch (err) {
        if (err instanceof ExecutorProfileError) throw new ModelsVerifyError(err.message);
        throw err;
      }
      if (harnessFilter != null) {
        if (parsed.harness != null && parsed.harness !== harnessFilter) {
          throw new ModelsVerifyError(
            `model verification reference "${raw}" harness mismatch: "${parsed.harness}" vs "${harnessFilter}". ` +
              'Use one harness selection, either in the reference or with --harness.',
          );
        }
        parsed = { ...parsed, harness: harnessFilter };
      }

      let resolved;
      try {
        resolved = resolveRegisteredModelRef(parsed, profile);
      } catch (err) {
        if (err instanceof ExecutorProfileError) throw new ModelsVerifyError(err.message);
        throw err;
      }
      let compiled;
      try {
        // Verification is host-free. In particular, running this command from
        // a host that could deliver the model in-session must not turn it into
        // a host-only target with no backend listing to probe.
        compiled = resolveDelivery(resolved.ref, profile, 'standalone');
      } catch (err) {
        if (err instanceof ExecutorProfileError) throw new ModelsVerifyError(err.message);
        throw err;
      }
      if (resolved.alias === 'host' || compiled.model === 'host' || compiled.harness == null) {
        throw new ModelsVerifyError(
          `model reference "${raw}" resolves to the host session, which has no externally listable model delivery — ` +
            'choose a registered command-lane model alias.',
        );
      }
      const entry = profile.harnesses?.[compiled.harness] ?? null;
      if (entry?.command == null) {
        throw new ModelsVerifyError(
          `model reference "${raw}" resolves to host-only harness "${compiled.harness}" — ` +
            'models verify requires a command-lane harness with a models_command.',
        );
      }
      if (entry.models_command == null || entry.models_command.length === 0) {
        throw new ModelsVerifyError(
          `model reference "${raw}" resolves to unlistable harness "${compiled.harness}" — it declares no models_command. ` +
            'Choose a listable harness or verify without an explicit ref to use dial-based skipping.',
        );
      }

      const key = `${compiled.harness} ${compiled.modelId}`;
      let target = targets.get(key);
      if (target == null) {
        target = {
          model: resolved.alias,
          model_id: compiled.modelId,
          harness: compiled.harness,
          archetypes: [],
          models: new Set<string>(),
        };
        targets.set(key, target);
      }
      target.models.add(resolved.alias);
      target.model = [...target.models].sort()[0]!;
    }
  }

  let selected = [...targets.values()];
  if (refs.length === 0 && harnessFilter != null) selected = selected.filter((target) => target.harness === harnessFilter);
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

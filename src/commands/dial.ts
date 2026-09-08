import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadLayeredProfile, type LayeredProfile, type ModelFallbackOutcome } from '../lib/config-layers.ts';
import {
  activeHarness,
  archetypeDisplaySort,
  BARE_IDENTIFIER_RE,
  declaredHarnesses,
  ExecutorProfileError,
  formatDialRef,
  knownArchetypes,
  parseDialRef,
  qualifyListedModelId,
  readLocalDialState,
  resolveDelivery,
  resolveRole,
  serializeDialRef,
  writeLocalDialState,
  type CompiledDelivery,
  type DialLayers,
  type DialRef,
  type ExecutorProfile,
  type RoleResolutionSource,
} from '../lib/executors.ts';
import type { Lane } from '../lib/ledger.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { commandOf, laneOf } from '../lib/spawn.ts';
import {
  isModelVerified,
  readUserDials,
  recordVerifiedModel,
  writeUserDials,
  type UserPathOptions,
} from '../lib/user-paths.ts';

export class DialError extends Error {}

/**
 * Subcommand names `dial` reads before it reads an archetype. An archetype
 * spelled like one of these could never be dialed, so it is refused at the
 * point of naming rather than silently shadowed.
 */
export const RESERVED_ARCHETYPES: ReadonlySet<string> = new Set(['set', 'clear', 'resolve']);

function assertArchetypeName(archetype: string): void {
  if (RESERVED_ARCHETYPES.has(archetype)) {
    throw new DialError(`archetype "${archetype}" is a reserved word — rename the archetype`);
  }
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new DialError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
}

/** One row of the effective table: an archetype and where it goes. */
export interface EffectiveRow {
  archetype: string;
  model: string;
  model_id: string;
  /**
   * The effort the user pinned on this dial (`opus@xhigh` → `'xhigh'`), or
   * null when the dial stated no opinion (`opus`).
   */
  pinned_effort: string | null;
  /**
   * What the model's registry entry declares, or null for a model with no
   * entry (`current-host`). Paired with `pinned_effort` it is what tells a
   * pin apart from a fall-through — the table shows an effort only when the
   * dial asked for one the registry would not have given it.
   */
  default_effort: string | null;
  /** The effort this delivery runs at: the pin, else the registry default. */
  effective_effort: string;
  /** The EXECUTOR harness this row resolves onto — who runs it, not where you sit. */
  harness: string | null;
  /** Whether the row's harness is the model's home (no explicit `--harness`). */
  harness_explicit: boolean;
  source: RoleResolutionSource;
  resolvedVia: string | null;
  dial: DialRef;
  refString: string;
  /**
   * The lane this dial takes, from `laneOf` — the same one bit the spawn
   * wrapper routes on. A table that shows model and harness but not the lane
   * leaves the reader to infer it from two columns that do not determine it.
   */
  lane: Lane;
  /**
   * Whether this archetype can be delivered at all from where the question
   * was asked. False for a command-lane dial with no argv to run — which from
   * a bare shell is every undialed archetype, since `current-host` names a
   * session that is not there. Printed rather than left to the lane column,
   * which would otherwise say `command` about a dispatch that cannot start.
   */
  deliverable: boolean;
}

export interface DialShowResult {
  rows: EffectiveRow[];
  dials: { session: Record<string, DialRef>; repo: Record<string, DialRef>; user: Record<string, DialRef> };
  /** Archetypes whose dial no longer resolves, with the resolver's own reason. */
  staleDials: Array<{ archetype: string; reason: string }>;
  suppressed_canon_archetypes: string[];
  note: string | null;
  /** The ambient HOST this call is running inside. */
  host: string;
}

export interface DialCommonOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
}

function repoRootOf(opts: DialCommonOptions): string {
  return opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
}

function loadLayered(repoRoot: string, userPathOptions?: UserPathOptions): LayeredProfile {
  try {
    return loadLayeredProfile(repoRoot, userPathOptions, activeHarness(undefined, userPathOptions));
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
}

export function formatSuppressedCanonNote(archetypes: readonly string[]): string | null {
  if (archetypes.length === 0) return null;
  return (
    `note: canon archetypes not declared by this catalog: <${archetypes.join(', ')}> ` +
    '(self-contained profile suppresses builtin layering; declare them in .fadeno/executors.yaml to adopt)'
  );
}

/**
 * The per-key user-model carve-out, as a reader-facing note. Promotions and
 * drops are both named: a promoted alias is personal state the repo is now
 * serving, and a dropped one failed integrity (nothing in the merged
 * `harnesses:` table can deliver it), which the user must see rather than
 * discover at dispatch time. Repairs ride along: what the tolerant user-layer
 * read translated or discarded on the way in.
 */
export function formatModelFallbackNote(fallback: ModelFallbackOutcome): string | null {
  const parts: string[] = [];
  if (fallback.promoted.length > 0) {
    parts.push(
      `user-catalog model${fallback.promoted.length === 1 ? '' : 's'} promoted into this self-contained catalog: ` +
        `${fallback.promoted.join(', ')}`,
    );
  }
  for (const drop of fallback.dropped) {
    parts.push(
      `user-catalog model "${drop.alias}" dropped — nothing in this catalog can deliver harness/provider "${drop.harness}"`,
    );
  }
  // Repairs are already whole sentences naming the file and the key; they read
  // as written rather than being re-wrapped in a category label.
  parts.push(...fallback.repairs);
  if (parts.length === 0) return null;
  return `note: ${parts.join('; ')}`;
}

function canonSurfacing(layered: LayeredProfile): { suppressed_canon_archetypes: string[]; note: string | null } {
  const arr = layered.suppressedCanonArchetypes;
  const canonNote = formatSuppressedCanonNote(arr);
  const fallbackNote = formatModelFallbackNote(layered.modelFallback);
  const note = [canonNote, fallbackNote].filter((part) => part != null).join('\n') || null;
  return { suppressed_canon_archetypes: arr, note };
}

function buildDialRef(modelInput: string, harness: string | undefined, label: string): DialRef {
  // modelInput may be "model@effort", "model", or "model on <harness>"
  const base = parseDialRef(modelInput, label);
  if (harness != null && harness.trim().length > 0) {
    const h = harness.trim();
    if (!BARE_IDENTIFIER_RE.test(h)) {
      throw new DialError(`${label} harness "${h}" is not a bare identifier.`);
    }
    if (base.harness != null && base.harness !== h) {
      throw new DialError(`${label} harness mismatch: "${base.harness}" vs "${h}".`);
    }
    base.harness = h;
  }
  return base;
}

/**
 * Refuse an unknown `--harness` at set time, naming the table.
 *
 * This is the whole of what a `--harness` can be wrong about: the dial names
 * an executor, and the executor either exists in the catalog or it does not.
 * Whether that harness can carry this archetype, and on which lane, are
 * questions about a CALL — answered at dispatch, where a host exists.
 */
function assertHarnessDeclared(profile: ExecutorProfile, ref: DialRef): void {
  if (ref.harness == null) return;
  if (Object.hasOwn(profile.harnesses ?? {}, ref.harness)) return;
  const declared = declaredHarnesses(profile);
  throw new DialError(
    `unknown harness "${ref.harness}" — declared harnesses: ${declared.join(', ') || '(none)'}`,
  );
}

// Levenshtein distance helper
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

function nearestMatches(target: string, candidates: string[], limit = 3): string[] {
  const scored = candidates.map((c) => ({ c, d: levenshtein(target, c) }));
  scored.sort((a, b) => a.d - b.d || a.c.localeCompare(b.c));
  return scored.slice(0, limit).map((s) => s.c);
}

export type VerificationStatus = 'verified' | 'cached' | 'unverified' | null;

export interface ProbeOptions {
  spawn?: (command: string[], opts: { timeout: number }) => { status: number | null; stdout: string | Buffer; stderr: string | Buffer; error?: Error };
  userPathOptions?: UserPathOptions;
  /** Re-probe even when a row is cached — `fadeno models verify` only. */
  force?: boolean;
}

export function probeModel(
  profile: ExecutorProfile,
  harness: string,
  modelId: string,
  opts: ProbeOptions = {},
): { status: VerificationStatus; note: string | null } {
  // The probe argv is resolved through the DIAL's harness — explicit or home —
  // never through the host. Asking the session's harness whether some other
  // harness serves a model answers a question nobody asked.
  const entry = profile.harnesses?.[harness] ?? null;
  // If model is current-host, skip silently (no probe)
  if (modelId === 'current-host') return { status: null, note: null };
  if (entry == null) {
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${harness} (no such harness declared) — dialing unverified` };
  }
  const modelsCommand = entry.models_command;
  if (modelsCommand == null || modelsCommand.length === 0) {
    // Callers suppress this for registered models and host deliveries; only an
    // unregistered dial surfaces it loudly.
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${harness} (no models_command declared) — dialing unverified` };
  }
  // Check cache
  const userOpts = opts.userPathOptions ?? {};
  if (!opts.force && isModelVerified(userOpts, harness, modelId)) {
    return { status: 'cached', note: null };
  }
  const spawnFn =
    opts.spawn ??
    ((command: string[], spawnOpts: { timeout: number }) => {
      const run = spawnSync(command[0]!, command.slice(1), {
        timeout: spawnOpts.timeout,
        encoding: 'utf8',
      });
      return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', ...(run.error != null ? { error: run.error } : {}) };
    });
  let result: { status: number | null; stdout: string | Buffer; stderr: string | Buffer; error?: Error };
  try {
    result = spawnFn(modelsCommand, { timeout: 10_000 });
  } catch (err) {
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${harness} (${(err as Error).message}) — dialing unverified` };
  }
  if ((result as { error?: Error }).error != null) {
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${harness} (${(result as { error?: Error }).error!.message}) — dialing unverified` };
  }
  if (result.status !== 0) {
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${harness} (models_command exited ${result.status}) — dialing unverified` };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  const listedModelId = qualifyListedModelId(entry, modelId);
  // Membership: delivered id appears as whitespace/comma-delimited token on some stdout line
  const tokens = stdout.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.includes(listedModelId)) {
    recordVerifiedModel(userOpts, { harness, model: modelId, verified_at: new Date().toISOString() });
    return { status: 'verified', note: null };
  }
  // Not found: refuse with nearest matches
  const nearest = nearestMatches(listedModelId, tokens, 3);
  const suggestion = nearest.length > 0 ? ` — did you mean ${nearest.map((n) => `"${n}"`).join(', ')}?` : '';
  throw new DialError(`unknown model "${modelId}" (listed as "${listedModelId}") on ${harness}${suggestion}`);
}

/** Whether the named harness can answer a dial-time model probe. */
function harnessCanProbe(profile: ExecutorProfile, harness: string | null): boolean {
  return harness != null && (profile.harnesses?.[harness]?.models_command ?? null) != null;
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export interface DialSetOptions extends DialCommonOptions {
  archetype: string;
  model: string; // model[@effort]
  harness?: string | null;
  session?: boolean;
  user?: boolean;
  repo?: boolean;
  /** injectable spawn for probe */
  spawn?: ProbeOptions['spawn'];
}

export interface DialSetResult {
  archetype: string;
  dial: DialRef;
  refString: string;
  model: string;
  model_id: string;
  /** The effort the user pinned (`opus@xhigh` → `'xhigh'`), else null. */
  pinned_effort: string | null;
  /** The effort this dial runs at: the pin, else the registry default. */
  effective_effort: string;
  /** The EXECUTOR harness this dial resolved onto. See `EffectiveRow.harness`. */
  harness: string | null;
  layer: 'session' | 'repo' | 'user';
  adaptive: boolean;
  repo_pinned: DialRef | null;
  previous: { layer: 'session' | 'repo' | 'user'; dial: DialRef } | null;
  verification: VerificationStatus;
  narrative: string;
  /** Loud advisories (unregistered fall-through, probe fail-open) for the CLI to print. */
  notes: string[];
}

export interface DialSetManyOptions extends DialCommonOptions {
  /** Archetype names, already split (the CLI accepts `a+b`, `a,b`, and `a b`). */
  archetypes: string[];
  model: string;
  harness?: string | null;
  session?: boolean;
  user?: boolean;
  repo?: boolean;
  spawn?: ProbeOptions['spawn'];
}

const SET_USAGE =
  'Usage: fadeno dial <archetype>[+<archetype>…] <model>[@effort] [--harness <id>] [--session|--user|--repo]';

/**
 * Set the same dial on several archetypes, atomically: every archetype is
 * validated before ANY write, so `dial worker+generator muse` either lands
 * everywhere or refuses whole, naming each conflict. The probe runs once — the
 * first set verifies, the rest hit the positive cache.
 */
export function runDialSetMany(opts: DialSetManyOptions): DialSetResult[] {
  const archetypes: string[] = [];
  for (const raw of opts.archetypes) {
    const name = raw.trim();
    if (name.length > 0 && !archetypes.includes(name)) archetypes.push(name);
  }
  if (archetypes.length === 0) throw new DialError(SET_USAGE);
  if ([opts.session, opts.user, opts.repo].filter(Boolean).length > 1) {
    throw new DialError('--session, --user, and --repo are mutually exclusive.');
  }
  const repoRoot = repoRootOf(opts);
  const modelInput = opts.model.trim();
  if (modelInput.length === 0) throw new DialError(SET_USAGE);
  let dial: DialRef;
  try {
    dial = buildDialRef(modelInput, opts.harness?.trim() || undefined, `model "${modelInput}"`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  // The same two admissions `runDialSet` makes, in the same order, so a
  // multi-archetype dial cannot be accepted on terms the single-archetype form
  // would have refused: the named harness must be declared, and the ref must
  // compile. Both throw; neither returns anything this function needs, which
  // is why the compile result is discarded rather than named.
  assertHarnessDeclared(profile, dial);
  try {
    resolveDelivery(dial, profile);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const failures: string[] = [];
  for (const archetype of archetypes) {
    try {
      assertArchetypeName(archetype);
    } catch (err) {
      failures.push((err as Error).message);
    }
  }
  if (failures.length > 0) {
    throw new DialError(
      archetypes.length > 1
        ? `nothing was dialed — ${failures.length} of ${archetypes.length} archetype(s) refused:\n  ${failures.join('\n  ')}`
        : failures[0]!,
    );
  }
  return archetypes.map((archetype) => runDialSet({ ...opts, archetype }));
}

/**
 * Warn when a dial is the first thing in this repo to send work to a vendor.
 *
 * Routing a model is a governance decision as much as a resolution one: the
 * prompt goes to that provider, and the executor reads the worktree it runs
 * in. A dial set once and forgotten is a standing egress path, so the moment
 * to say it is set time, not dispatch time.
 *
 * In use = the compiled provider of every effective dial, minus the archetype
 * being written, which cannot vouch for itself. An unresolvable dial vouches
 * for nothing — a stale pin is reported on its own channel and must not
 * silence this.
 */
function providerNoveltyNote(params: {
  profile: ExecutorProfile;
  layers: DialLayers;
  archetype: string;
  refString: string;
  compiled: CompiledDelivery;
}): string | null {
  const { profile, layers, archetype, refString, compiled } = params;
  const provider = compiled.provider;
  if (provider == null || provider === 'current-host') return null;
  const inUse = new Set<string>();
  for (const other of knownArchetypes(profile.archetypes, layers.session, layers.repo, layers.user)) {
    if (other === archetype) continue; // the dial being replaced
    try {
      const resolved = resolveRole(other, other, profile, layers);
      if (resolved.delivery.provider != null) inUse.add(resolved.delivery.provider);
    } catch {
      // Unresolvable: vouches for nothing.
    }
  }
  if (inUse.has(provider)) return null;
  return (
    `WARNING: NEW PROVIDER — ${archetype} → ${refString} routes to "${provider}", which nothing else dialed in this repo uses.\n` +
    'Prompts for this archetype — and the worktree the executor can read — go to a vendor this repo is not already sending work to.\n' +
    `Change it with \`fadeno dial ${archetype} <model>\`.`
  );
}

export function runDialSet(opts: DialSetOptions): DialSetResult {
  const repoRoot = repoRootOf(opts);
  if ([opts.session, opts.user, opts.repo].filter(Boolean).length > 1) {
    throw new DialError('--session, --user, and --repo are mutually exclusive.');
  }
  const archetype = opts.archetype.trim();
  assertArchetypeName(archetype);
  const modelInput = opts.model.trim();
  if (modelInput.length === 0) throw new DialError(SET_USAGE);
  let dial: DialRef;
  try {
    dial = buildDialRef(modelInput, opts.harness?.trim() || undefined, `model "${modelInput}"`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  // An ARCHETYPE where a model goes, answered before anything downstream can
  // mistake it for a model. Fadeno knows both vocabularies, so it can say
  // which one was typed instead of resolving a name that was never a model:
  // `dial scout worker` reached the unregistered-model harness and came back
  // "unknown model \"worker\" — did you mean openrouter/openai/o1?", which
  // answers a question nobody asked.
  //
  // Only when the registry does NOT hold that name: a real model called
  // `worker` is a legitimate dial, and this argument fills the model column.
  if (!Object.hasOwn(profile.models, dial.model) && Object.hasOwn(profile.archetypes, dial.model)) {
    throw new DialError(
      `"${dial.model}" is an archetype, not a model — this would dial ${archetype} to a model of that name, and the registry has none. ` +
        `To route both to one model, name them together: \`fadeno dial ${archetype} ${dial.model} <model>\`. ` +
        `To make ${archetype} follow ${dial.model}'s dial wherever it goes, declare the chain in the project catalog: ` +
        `\`archetypes.${archetype}.fallback: ${dial.model}\` in .fadeno/executors.yaml.`,
    );
  }
  assertHarnessDeclared(profile, dial);
  // Compile before any state touch
  let compiled: CompiledDelivery;
  try {
    compiled = resolveDelivery(dial, profile);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const refString = formatDialRef(dial);

  let verification: VerificationStatus = null;
  let probeNote: string | null = null;
  const notes: string[] = [];
  // Set time validates against the REGISTRY and nothing else. The lane is a
  // property of the CALL — it depends on which harness you are sitting in —
  // so a dial stored host-neutrally and re-resolved at every dispatch must not
  // narrate one here.
  if (!compiled.registered) {
    notes.push(
      `note: ${compiled.model} is not in the model registry — running on ${compiled.harness}, id passed verbatim ` +
        '(declare it under models: to set a home harness or standard effort)',
    );
  }
  // Skip for current-host silently; a registered model on a harness with no
  // models_command also skips silently (probing is for harnesses that answer).
  const shouldProbe = compiled.model !== 'current-host' && compiled.harness != null;
  const hasModelsCommand = harnessCanProbe(profile, compiled.harness);
  if (shouldProbe) {
    if (!hasModelsCommand) {
      if (!compiled.registered) {
        probeNote = `note: cannot verify ${compiled.modelId} on ${compiled.harness} (no models_command declared) — dialing unverified`;
        verification = 'unverified';
      }
    } else {
      try {
        const probe = probeModel(profile, compiled.harness!, compiled.modelId, { spawn: opts.spawn, userPathOptions: opts.userPathOptions });
        verification = probe.status;
        probeNote = probe.note;
      } catch (err) {
        if (err instanceof DialError) throw err;
        if (err instanceof ExecutorProfileError) throw new DialError(err.message);
        throw err;
      }
    }
  }

  const localState = readLocalDialState(repoRoot);
  const userDials = readUserDials(opts.userPathOptions) as Record<string, DialRef>;
  {
    const novelty = providerNoveltyNote({
      profile,
      layers: { session: localState.dials, repo: profile.dials, user: userDials },
      archetype,
      refString,
      compiled,
    });
    if (novelty != null) notes.push(novelty);
  }
  const sessionPinned = Object.hasOwn(localState.dials, archetype);
  const repoPinned = Object.hasOwn(profile.dials, archetype) ? profile.dials[archetype]! : null;
  const userPinned = Object.hasOwn(userDials, archetype);
  let layer: 'session' | 'repo' | 'user';
  let adaptive = false;
  if (opts.session) layer = 'session';
  else if (opts.user) layer = 'user';
  else if (opts.repo) layer = 'repo';
  else {
    // An unscoped set edits the highest existing dial instead of writing a
    // shadowed lower layer. With no existing dial, the cross-repo user
    // default remains the natural creation target.
    if (sessionPinned) layer = 'session';
    else if (repoPinned != null) layer = 'repo';
    else layer = 'user';
    adaptive = sessionPinned || repoPinned != null || userPinned;
  }

  let previous: { layer: 'session' | 'repo' | 'user'; dial: DialRef } | null = null;
  if (layer === 'session' && sessionPinned) {
    previous = { layer: 'session', dial: localState.dials[archetype]! };
  } else if (layer === 'user' && userPinned) {
    previous = { layer: 'user', dial: userDials[archetype]! };
  } else if (layer === 'repo' && repoPinned != null) {
    previous = { layer: 'repo', dial: repoPinned };
  }

  const narrative =
    layer === 'user'
      ? `${archetype} → ${refString}  [user default — applies across your repos]`
      : layer === 'session'
        ? `${archetype} → ${refString}  [session dial — this checkout only, sticky until cleared]`
        : `${archetype} → ${refString}  [repo pin — committed in .fadeno/executors.yaml]`;

  if (layer === 'session') {
    writeLocalDialState(repoRoot, { dials: { ...localState.dials, [archetype]: dial } });
  } else if (layer === 'user') {
    writeUserDials(opts.userPathOptions ?? {}, { ...userDials, [archetype]: dial });
  } else {
    // Written through `parseDocument` so the committed file keeps its comments.
    const executorsPath = join(repoRoot, '.fadeno', 'executors.yaml');
    const doc = existsSync(executorsPath) ? parseDocument(readFileSync(executorsPath, 'utf8')) : parseDocument('');
    if (!doc.has('dials')) doc.set('dials', doc.createNode({}));
    doc.setIn(['dials', archetype], serializeDialRef(dial));
    if (!doc.has('schema_version')) doc.set('schema_version', 3);
    mkdirSync(join(repoRoot, '.fadeno'), { recursive: true });
    writeFileSync(executorsPath, String(doc), 'utf8');
  }

  return {
    archetype,
    dial,
    refString,
    model: compiled.model,
    model_id: compiled.modelId,
    pinned_effort: compiled.pinnedEffort,
    effective_effort: compiled.effectiveEffort,
    harness: compiled.harness,
    layer,
    adaptive,
    repo_pinned: repoPinned,
    previous,
    verification,
    narrative,
    notes: [...notes, ...(probeNote != null ? [probeNote] : [])],
  };
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export interface DialClearOptions extends DialCommonOptions {
  archetype?: string | null;
  session?: boolean;
  user?: boolean;
  repo?: boolean;
}

export interface DialClearResult {
  cleared: string | null;
  removed: boolean;
  archetype: string | null;
  layer: 'session' | 'user' | 'repo' | null;
  remaining: Record<string, DialRef>;
  /** Bulk clear: how many dials were removed in total. */
  count?: number;
  /** Where the dial lives when a plain clear found nothing it may remove: a
   * repo pin blocks layer inference (committed config, explicit --repo only). */
  livesAt?: 'repo' | null;
  /** True when a plain clear fell through to the user default because it was
   * the only layer holding a dial (no session dial, no repo pin). */
  inferred?: boolean;
  /** Bulk clear: how many dials each layer gave up. */
  cleared_layers?: { session: number; user: number };
  /** Bulk clear: repo pins left standing (committed config, --repo only). */
  repo_pins_remaining?: string[];
}

export function runDialClear(opts: DialClearOptions = {}): DialClearResult {
  const repoRoot = repoRootOf(opts);
  if ([opts.session, opts.user, opts.repo].filter(Boolean).length > 1) {
    throw new DialError('--session, --user, and --repo are mutually exclusive.');
  }
  const archetypeRaw = opts.archetype?.trim() ?? null;
  const archetype = archetypeRaw && archetypeRaw.length > 0 ? archetypeRaw : null;
  if (archetype != null && !BARE_IDENTIFIER_RE.test(archetype)) {
    throw new DialError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
  if (archetype == null && opts.repo) {
    throw new DialError('repo pins are committed config — remove them per archetype with `clear <archetype> --repo`');
  }

  if (archetype == null) {
    const state = readLocalDialState(repoRoot);
    const userDials = readUserDials(opts.userPathOptions) as Record<string, DialRef>;
    if (opts.session) {
      const count = Object.keys(state.dials).length;
      if (count > 0) writeLocalDialState(repoRoot, { dials: {} });
      return { cleared: null, removed: count > 0, archetype: null, layer: 'session', remaining: {}, count };
    }
    if (opts.user) {
      const count = Object.keys(userDials).length;
      if (count > 0) writeUserDials(opts.userPathOptions ?? {}, {});
      return { cleared: null, removed: count > 0, archetype: null, layer: 'user', remaining: {}, count };
    }
    // Default bulk clear: every archetype, every non-committed layer — session
    // dials AND user dials go; repo pins are committed config and stay until an
    // explicit `clear <archetype> --repo`.
    const repoPins = (() => {
      try {
        return archetypeDisplaySort(Object.keys(loadLayered(repoRoot, opts.userPathOptions).profile.dials));
      } catch {
        return [] as string[];
      }
    })();
    const sessionCount = Object.keys(state.dials).length;
    const userCount = Object.keys(userDials).length;
    if (sessionCount > 0) writeLocalDialState(repoRoot, { dials: {} });
    if (userCount > 0) writeUserDials(opts.userPathOptions ?? {}, {});
    const count = sessionCount + userCount;
    return {
      cleared: null,
      removed: count > 0,
      archetype: null,
      layer: null,
      remaining: {},
      count,
      cleared_layers: { session: sessionCount, user: userCount },
      repo_pins_remaining: repoPins,
    };
  }

  if (opts.session) {
    const state = readLocalDialState(repoRoot);
    if (!Object.hasOwn(state.dials, archetype)) {
      return { cleared: null, removed: false, archetype, layer: 'session', remaining: state.dials };
    }
    const prev = state.dials[archetype]!;
    const nextDials = { ...state.dials };
    delete nextDials[archetype];
    writeLocalDialState(repoRoot, { dials: nextDials });
    return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'session', remaining: nextDials };
  }
  if (opts.repo) {
    const executorsPath = join(repoRoot, '.fadeno', 'executors.yaml');
    if (!existsSync(executorsPath)) throw new DialError(`no repo pin for "${archetype}" to clear`);
    const doc = parseDocument(readFileSync(executorsPath, 'utf8'));
    if (!doc.hasIn(['dials', archetype])) throw new DialError(`no repo pin for "${archetype}" to clear`);
    doc.deleteIn(['dials', archetype]);
    const dialsNode = doc.get('dials', true) as { items?: unknown[] } | null;
    if (dialsNode != null && Array.isArray(dialsNode.items) && dialsNode.items.length === 0) doc.delete('dials');
    writeFileSync(executorsPath, String(doc), 'utf8');
    return { cleared: archetype, removed: true, archetype, layer: 'repo', remaining: {} };
  }
  if (opts.user) {
    const userDials = readUserDials(opts.userPathOptions) as Record<string, DialRef>;
    if (!Object.hasOwn(userDials, archetype)) {
      return { cleared: null, removed: false, archetype, layer: 'user', remaining: userDials };
    }
    const prev = userDials[archetype]!;
    const next = { ...userDials };
    delete next[archetype];
    writeUserDials(opts.userPathOptions ?? {}, next);
    return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'user', remaining: next };
  }
  // Default clear: session first. When the session holds no dial and there is
  // no repo pin, the user default is the only dial this clear can mean — clear
  // it and say which layer answered. A repo pin blocks the inference (it is
  // committed config, removed only with an explicit --repo) and keeps the
  // guidance message instead.
  const state = readLocalDialState(repoRoot);
  if (!Object.hasOwn(state.dials, archetype)) {
    const layered = loadLayered(repoRoot, opts.userPathOptions);
    const userDials = readUserDials(opts.userPathOptions) as Record<string, DialRef>;
    if (!Object.hasOwn(layered.profile.dials, archetype) && Object.hasOwn(userDials, archetype)) {
      const prev = userDials[archetype]!;
      const next = { ...userDials };
      delete next[archetype];
      writeUserDials(opts.userPathOptions ?? {}, next);
      return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'user', inferred: true, remaining: next };
    }
    const livesAt = Object.hasOwn(layered.profile.dials, archetype) ? ('repo' as const) : null;
    return { cleared: null, removed: false, archetype, layer: null, remaining: state.dials, livesAt };
  }
  const prev = state.dials[archetype]!;
  const nextDials = { ...state.dials };
  delete nextDials[archetype];
  writeLocalDialState(repoRoot, { dials: nextDials });
  return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'session', remaining: nextDials };
}

// ---------------------------------------------------------------------------
// show — the effective table
// ---------------------------------------------------------------------------

/**
 * Every archetype the catalog and the dials know, and where each currently
 * routes. Routing only: what an archetype is FOR is `fadeno context`, the text
 * a host session is given, and saying it in both places is one description
 * with two owners.
 */
export function runDialShow(opts: DialCommonOptions = {}): DialShowResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const host = profile.host ?? 'standalone';
  const dialState = (() => {
    try {
      return readLocalDialState(repoRoot);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DialError(err.message);
      throw err;
    }
  })();
  const userDials = readUserDials(opts.userPathOptions) as Record<string, DialRef>;
  const layers: DialLayers = { session: dialState.dials, repo: profile.dials, user: userDials };
  const { suppressed_canon_archetypes, note } = canonSurfacing(layered);

  const rows: EffectiveRow[] = [];
  const staleDials: Array<{ archetype: string; reason: string }> = [];
  for (const archetype of archetypeDisplaySort(knownArchetypes(profile.archetypes, layers.session, layers.repo, layers.user))) {
    let resolved: ReturnType<typeof resolveRole>;
    try {
      resolved = resolveRole(archetype, archetype, profile, layers);
    } catch (err) {
      if (!(err instanceof ExecutorProfileError)) throw err;
      // A dial naming a model or harness the catalog no longer has: reported on
      // its own channel, and the row is dropped rather than half-rendered.
      staleDials.push({ archetype, reason: (err as Error).message });
      continue;
    }
    const delivery = resolved.delivery;
    rows.push({
      archetype,
      model: delivery.model,
      model_id: delivery.modelId,
      pinned_effort: delivery.pinnedEffort,
      default_effort: profile.models[delivery.model]?.effort ?? null,
      effective_effort: delivery.effectiveEffort,
      harness: delivery.harness,
      harness_explicit: delivery.ref.harness != null,
      source: resolved.source,
      resolvedVia: resolved.resolvedVia,
      dial: delivery.ref,
      refString: delivery.refString,
      lane: laneOf(delivery),
      deliverable: laneOf(delivery) === 'host' || commandOf(delivery) != null,
    });
  }

  return {
    rows,
    dials: { session: dialState.dials, repo: profile.dials, user: userDials },
    staleDials,
    suppressed_canon_archetypes,
    note,
    host,
  };
}

// ---------------------------------------------------------------------------
// resolve — the inspection escape hatch
// ---------------------------------------------------------------------------

/**
 * What one archetype resolves to right now, in full.
 *
 * Routing is invisible by default: the host names an archetype and Fadeno
 * applies the model. This is the escape hatch for the times that is not
 * enough — a dial that is not doing what someone expected — and it answers
 * from `resolveRole` and `laneOf`, the same two the spawn wrapper uses, so it
 * cannot describe a route the next dispatch will not take.
 */
export interface DialResolveResult {
  archetype: string;
  /** The dial as written: `sol@high on codex`. */
  executor: string;
  model: string;
  model_id: string;
  /** The effort the user pinned, or null when the dial stated no opinion. */
  pinned_effort: string | null;
  /** The effort this delivery runs at: the pin, else the registry default. */
  effective_effort: string;
  /** The EXECUTOR harness; null only for `current-host` in a bare shell. */
  harness: string | null;
  /** Where a spawn from inside the host would be delivered. */
  lane: Lane;
  /** The argv the command lane would run, or null when there is nothing to invoke. */
  command: string[] | null;
  /** The ambient HOST this call is running inside; `standalone` from a shell. */
  host: string;
  source: RoleResolutionSource;
  resolved_via?: string;
  /**
   * Present when the resolved model reached this profile through the per-key
   * user-catalog fallback — a self-contained project catalog promoting a
   * personal alias. Null otherwise: project-declared, builtin, unregistered,
   * or any repo where layering ran normally.
   */
  model_fallback?: { promoted_from_user: true; note: string };
  dial: DialRef;
}

export function runDialResolve(opts: DialCommonOptions & { archetype: string }): DialResolveResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const host = profile.host ?? 'standalone';
  const archetype = opts.archetype.trim();
  assertArchetypeName(archetype);
  const dialState = (() => {
    try {
      return readLocalDialState(repoRoot);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DialError(err.message);
      throw err;
    }
  })();
  const layers: DialLayers = {
    session: dialState.dials,
    repo: profile.dials,
    user: readUserDials(opts.userPathOptions) as Record<string, DialRef>,
  };
  let resolved: ReturnType<typeof resolveRole>;
  try {
    resolved = resolveRole(archetype, archetype, profile, layers);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const delivery = resolved.delivery;
  return {
    archetype,
    executor: delivery.refString,
    model: delivery.model,
    model_id: delivery.modelId,
    pinned_effort: delivery.pinnedEffort,
    effective_effort: delivery.effectiveEffort,
    harness: delivery.harness,
    lane: laneOf(delivery),
    command: commandOf(delivery),
    host,
    source: resolved.source,
    ...(resolved.resolvedVia != null ? { resolved_via: resolved.resolvedVia } : {}),
    ...(layered.selfContained && layered.modelFallback.promoted.includes(delivery.model)
      ? { model_fallback: { promoted_from_user: true as const, note: formatModelFallbackNote(layered.modelFallback)! } }
      : {}),
    dial: delivery.ref,
  };
}

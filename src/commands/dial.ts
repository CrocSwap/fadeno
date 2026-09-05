import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadLayeredProfile, type LayeredProfile, type ModelFallbackOutcome } from '../lib/config-layers.ts';
import {
  activeHarness,
  BARE_IDENTIFIER_RE,
  archetypeDisplaySort,
  knownArchetypes,
  commandRoutable,
  resolveDelivery,
  deliveryIsHost,
  eligibilityFor,
  ExecutorProfileError,
  explainEligibilityConflict,
  explainPairRoutability,
  pairRoutabilityFields,
  formatDialRef,
  declaredHarnesses,
  parseDialRef,
  qualifyListedModelId,
  readLocalDialState,
  resolveDialCascade,
  resolveRelay,
  resolveRole,
  serializeDialRef,
  shadowAttachmentRef,
  writeLocalDialState,
  type DialRef,
  type ExecutorProfile,
  type ExecutorSpec,
  type ShadowAttachment,
  type RoleResolutionSource,
  type CompiledDelivery,
  type DialLayers,
  shadowAttachmentExpired,
  shadowSampleRoll,
  withLocalDialStateLock,
} from '../lib/executors.ts';
import {
  decideLane,
  readSessionEffort,
  type DeliveryLane,
  type LaneDecision,
  type LaneReason,
} from '../lib/lane.ts';
import { findRepoRoot } from '../lib/paths.ts';
import {
  isModelVerified,
  readUserDials,
  recordVerifiedModel,
  writeUserDials,
  type UserPathOptions,
} from '../lib/user-paths.ts';

export class DialError extends Error {}

/** One row of the effective table */
export interface EffectiveRow {
  archetype: string;
  model: string;
  model_id: string;
  /**
   * Unchanged legacy field: the effort this row's delivery runs at
   * (`effective_effort`), or `—` on a fallback row. It cannot tell a pin from
   * a registry default — every catalog model declares one — so anything that
   * cares about user intent (the delivery lane, above all) must read
   * `pinned_effort` instead. Kept as-is for scripts already parsing it.
   */
  effort: string;
  /**
   * The effort the user pinned on this dial (`opus@xhigh` → `'xhigh'`), or
   * null when the dial stated no opinion (`opus`). This is the field that
   * says whether anyone asked for a specific effort.
   */
  pinned_effort: string | null;
  /** The effort this delivery runs at: the pin, else the registry default. */
  effective_effort: string;
  /**
   * The EXECUTOR harness this row resolves onto — what `--harness` takes and
   * what the table prints in its `harness` column.
   *
   * Under v4 this name finally means one thing everywhere. `DialShowResult`
   * carries the ambient HOST as `host`, so the two can no longer be confused:
   * `harness` is who executes, `host` is where you are sitting.
   */
  harness: string | null;
  /** Whether the row's harness is the model's home (no explicit `--harness`). */
  harness_explicit: boolean;
  /** The command-lane variant policy chose, or null for the base lane. */
  variant: string | null;
  source: RoleResolutionSource;
  resolvedVia: string | null;
  dial: DialRef;
  refString: string;
  adapter: 'command' | 'host';

  eligibility?: string;
  shadow?: ShadowAttachmentView;
  // display helpers
  modelDisplay: string;
}

export interface ShadowAttachmentView {
  model: string;
  effort?: string;
  harness?: string;
  rate?: number;
  /** Configured finite trigger budget, or null for an unlimited attachment. */
  n: number | null;
  /** Pairings still available, or null for an unlimited attachment. */
  remaining: number | null;
  /** Derived from the persisted budget; expired attachments remain visible. */
  expired: boolean;
  adapter?: 'command' | 'host';
  /** The executor harness the challenger resolved onto. */
  resolved_harness?: string | null;
}

function shadowAttachmentView(att: ShadowAttachment, delivery?: CompiledDelivery): ShadowAttachmentView {
  return {
    model: att.model,
    ...(att.effort ? { effort: att.effort } : {}),
    ...(att.harness ? { harness: att.harness } : {}),
    ...(att.rate != null ? { rate: att.rate } : {}),
    n: att.n ?? null,
    remaining: att.remaining ?? null,
    expired: shadowAttachmentExpired(att),
    ...(delivery != null ? { adapter: delivery.spec.adapter, resolved_harness: delivery.harness } : {}),
  };
}

export interface StaleShadowView {
  archetype: string;
  target: string;
}

export interface DialShowResult {
  rows: EffectiveRow[];
  dials: { session: Record<string, DialRef>; repo: Record<string, DialRef>; user: Record<string, DialRef> };
  shadows: Record<string, ShadowAttachment>;
  shadow_attachments: Record<string, ShadowAttachmentView>;
  staleShadows: StaleShadowView[];
  staleDials: Array<{ archetype: string; target: string }>;
  legacy_pin_note: string | null;
  /** One line when stored state still spells a delivery ` via <driver>`. */
  legacy_via_note: string | null;
  suppressed_canon_archetypes: string[];
  note: string | null;
  /** The ambient HOST this call is running inside. */
  host: string;
  // legacy alias
  legacyPinNote?: string | null;
}

export interface DialCommonOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  /**
   * Testability seam for what would otherwise read `process.env`. The lane
   * predicate reads `CLAUDE_EFFORT` from here, so a test that omitted it would
   * pass or fail depending on the effort of whatever session ran the suite —
   * the class of bug commit 0f6adfa fixed for user-scope dials.
   */
  env?: NodeJS.ProcessEnv;
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
  if (isModelVerified(userOpts, harness, modelId)) {
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
  /** Legacy field: the effort this dial runs at. Cannot tell a pin from a
   * registry default — read `pinned_effort` for that. */
  effort: string;
  /** The effort the user pinned (`opus@xhigh` → `'xhigh'`), else null. */
  pinned_effort: string | null;
  /** The effort this dial runs at: the pin, else the registry default. */
  effective_effort: string;
  /** The EXECUTOR harness this dial resolved onto. See `EffectiveRow.harness`. */
  harness: string | null;
  /** The command-lane variant policy chose, or null for the base lane. */
  variant: string | null;
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

/**
 * Set the same dial on several archetypes, atomically: every archetype is
 * validated (reserved words, identifier shape, write posture, eligibility)
 * before ANY write, so `dial worker+generator muse` either lands everywhere
 * or refuses whole, naming each conflict. The probe runs once — the first
 * set verifies, the rest hit the positive cache.
 */
export function runDialSetMany(opts: DialSetManyOptions): DialSetResult[] {
  const archetypes: string[] = [];
  for (const raw of opts.archetypes) {
    const name = raw.trim();
    if (name.length > 0 && !archetypes.includes(name)) archetypes.push(name);
  }
  if (archetypes.length === 0) {
    throw new DialError('Usage: fadeno dial <archetype>[+<archetype>…] <model>[@effort] [--harness <id>] [--session|--user|--repo] [--force]');
  }
  if ([opts.session, opts.user, opts.repo].filter(Boolean).length > 1) {
    throw new DialError('--session, --user, and --repo are mutually exclusive.');
  }
  const repoRoot = repoRootOf(opts);
  const modelInput = opts.model.trim();
  if (modelInput.length === 0) {
    throw new DialError('Usage: fadeno dial <archetype>[+<archetype>…] <model>[@effort] [--harness <id>] [--session|--user|--repo] [--force]');
  }
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
  // Atomic pre-validation: same checks runDialSet applies, over every
  // archetype, before a single write. Registry only — an archetype's
  // eligibility on a LANE is a dispatch-time question, and refusing it here
  // refused dials that resolve perfectly well on another lane or another host.
  const failures: string[] = [];
  for (const archetype of archetypes) {
    if (archetype === 'set' || archetype === 'clear' || archetype === 'shadow' || archetype === 'clear-shadow' || archetype === 'resolve') {
      failures.push(`archetype "${archetype}" is a reserved word — rename the archetype`);
      continue;
    }
    if (!BARE_IDENTIFIER_RE.test(archetype)) {
      failures.push(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      continue;
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
 * prompt goes to that provider, and for a write delivery — or any shadow,
 * which runs in a worktree of the repo — so does the source. A dial set once
 * and forgotten is a standing egress path, so the moment to say it is set
 * time, alongside the write-posture and eligibility checks, not dispatch time.
 *
 * In use = the compiled provider of every effective dial plus every shadow
 * attachment, minus THE SLOT BEING WRITTEN — which cannot vouch for itself.
 * The unit is the slot, not the archetype: shadowing `worker` with the vendor
 * `worker` already dials is not new egress, so a shadow write counts its own
 * archetype's primary and a primary write counts its own archetype's shadow.
 * An unresolvable dial vouches for nothing — a stale pin is reported on its
 * own channel and must not silence this.
 */
function providerNoveltyNote(params: {
  profile: ExecutorProfile;
  layers: DialLayers;
  shadows: Record<string, ShadowAttachment>;
  archetype: string;
  refString: string;
  compiled: CompiledDelivery;
  kind: 'dial' | 'shadow';
}): string | null {
  const { profile, layers, shadows, archetype, refString, compiled, kind } = params;
  const provider = compiled.provider;
  if (provider == null || provider === 'current-host') return null;
  const inUse = new Set<string>();
  const archetypes = knownArchetypes(profile.archetypes, layers.session, layers.repo, layers.user);
  const providerOf = (ref: DialRef): void => {
    try {
      const other = resolveDelivery(ref, profile);
      if (other.provider != null) inUse.add(other.provider);
    } catch {
      // Unresolvable: vouches for nothing.
    }
  };
  for (const other of archetypes) {
    if (kind === 'dial' && other === archetype) continue; // the dial being replaced
    try {
      const cascade = resolveDialCascade(other, other, { bindings: profile.bindings, archetypes: profile.archetypes }, layers);
      providerOf(cascade.ref);
    } catch {
      // Unresolvable: vouches for nothing.
    }
  }
  for (const [other, attachment] of Object.entries(shadows)) {
    if (kind === 'shadow' && other === archetype) continue; // the attachment being replaced
    providerOf(shadowAttachmentRef(attachment));
  }
  if (inUse.has(provider)) return null;
  const arrow = kind === 'shadow' ? '~' : '→';
  const consequence = kind === 'shadow'
    ? 'Every sampled dispatch duplicates the prompt to that vendor alongside the primary, and the challenger runs in a worktree of this repo.'
    : 'Prompts for this archetype — and, on a write delivery, the workspace the executor can read — go to a vendor this repo is not already sending work to.';
  const undo = kind === 'shadow'
    ? `Detach it with \`fadeno dial clear-shadow ${archetype}\`.`
    : `Change it with \`fadeno dial ${archetype} <model>\`.`;
  return `WARNING: NEW PROVIDER — ${archetype} ${arrow} ${refString} routes to "${provider}", which nothing else dialed in this repo uses.\n${consequence}\n${undo}`;
}

/**
 * Warn when the archetype's PRIMARY cannot reach the command lane, so a
 * shadow attached here can never be sampled.
 *
 * A selected pair forces command delivery on both arms by reusing the
 * primary's `fallback_command` (`commandRoutable`) — there is no other way
 * for a host-delivered primary to become comparable. An archetype whose
 * primary resolves to a host executor with none (the bare `current-host`
 * base dial, most commonly) can therefore never produce a pair, no matter
 * how the shadow itself is dialed. Dispatch time is too late to say so — the
 * attachment would sit inert, silently sampling zero pairs forever. A
 * warning, not a refusal: the primary can be redialed afterwards to make the
 * attachment take effect.
 */

function unroutablePrimaryNote(params: {
  profile: ExecutorProfile;
  layers: DialLayers;
  archetype: string;
}): string | null {
  const { profile, layers, archetype } = params;
  let resolved: import('../lib/executors.ts').RoleResolution;
  try {
    resolved = resolveRole(archetype, archetype, profile, layers);
  } catch {
    return null; // unresolvable primary vouches for nothing here either
  }
  // The SAME predicate the resolve previews and the dispatch kernel answer
  // with, so attach time cannot promise a pair the kernel then declines to
  // form. One question now: does a command lane exist to move the primary to.
  const routability = explainPairRoutability(resolved.delivery.spec, resolved.delivery.refString);
  if (routability.routable) return null;
  return (
    `WARNING: NO PAIR POSSIBLE — ${archetype}'s primary (${resolved.delivery.refString}) cannot carry a pair, ` +
    'so this shadow attachment can never be sampled and every dispatch will silently run unpaired.\n' +
    `${routability.reason}`
  );
}

export function runDialSet(opts: DialSetOptions): DialSetResult {
  const repoRoot = repoRootOf(opts);
  if ([opts.session, opts.user, opts.repo].filter(Boolean).length > 1) {
    throw new DialError('--session, --user, and --repo are mutually exclusive.');
  }
  const archetype = opts.archetype.trim();
  if (archetype === 'set' || archetype === 'clear' || archetype === 'shadow' || archetype === 'clear-shadow' || archetype === 'resolve') {
    throw new DialError(`archetype "${archetype}" is a reserved word — rename the archetype`);
  }
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new DialError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
  const modelInput = opts.model.trim();
  if (modelInput.length === 0) throw new DialError('Usage: fadeno dial <archetype> <model>[@effort] [--harness <id>] [--session|--user|--repo] [--force]');
  // Build dial ref
  let dial: DialRef;
  try {
    dial = buildDialRef(modelInput, opts.harness?.trim() || undefined, `model "${modelInput}"`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
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

  // c. Verification probe
  let verification: VerificationStatus = null;
  let probeNote: string | null = null;
  const notes: string[] = [];
  // Set time validates against the REGISTRY and nothing else. It used to also
  // compile the dial against the ambient host and narrate the lane a pinned
  // effort would take — which made `fadeno dial worker opus@xhigh` print a
  // different story depending on which terminal you typed it in, for a dial
  // that is stored host-neutrally and re-resolved at every dispatch. The lane
  // is a property of the CALL, so it is answered by `dial resolve` and by the
  // dispatch kernel, where a host actually exists.
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
      // Has models_command, do probe
      try {
        const probe = probeModel(profile, compiled.harness!, compiled.modelId, { spawn: opts.spawn, userPathOptions: opts.userPathOptions });
        verification = probe.status;
        probeNote = probe.note;
      } catch (err) {
        // probe refused (unknown model) -> rethrow as DialError
        if (err instanceof DialError) throw err;
        if (err instanceof ExecutorProfileError) throw new DialError(err.message);
        throw err;
      }
    }
  }

  // Scope decision
  const localState = readLocalDialState(repoRoot);
  // Note: readLocalDialState may throw if malformed; convert to DialError
  // Already handled inside readLocalDialState which throws ExecutorProfileError
  const userDials = readUserDials(opts.userPathOptions);
  {
    const novelty = providerNoveltyNote({
      profile,
      layers: { session: localState.dials, repo: profile.dials, user: userDials as Record<string, DialRef> },
      shadows: localState.shadows,
      archetype,
      refString,
      compiled,
      kind: 'dial',
    });
    if (novelty != null) notes.push(novelty);
  }
  const sessionPinned = Object.hasOwn(localState.dials, archetype);
  const repoPinned = Object.hasOwn(profile.dials, archetype) ? profile.dials[archetype]! : null;
  // Graceful degradation: an existing shadow attachment with a redialed
  // unroutable primary emits a warning rather than a silent drop (design:
  // docs/experimental/slots-and-archetypes.md, graceful case when shadow set
  // first and dial current-host follows).
  if (localState.shadows != null && Object.hasOwn(localState.shadows, archetype)) {
    try {
      const shadowLayers: DialLayers = { session: localState.dials, repo: profile.dials, user: readUserDials(opts.userPathOptions) as Record<string, DialRef> };
      const unroutable = unroutablePrimaryNote({ profile, layers: shadowLayers, archetype });
      if (unroutable != null) {
        console.warn(
          `fadeno dial warning: archetype "${archetype}" has an existing shadow attachment but its new primary is unroutable for shadow pairs — the pair degrades to no pair (primary runs solo). ` +
            `To restore pairing, redial to a command delivery for this archetype.`,
        );
      }
    } catch {}
  }
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
    else if (userPinned) layer = 'user';
    else layer = 'user';
    adaptive = sessionPinned || repoPinned != null || userPinned;
  }

  // Determine previous in target layer
  let previous: { layer: 'session' | 'repo' | 'user'; dial: DialRef } | null = null;
  if (layer === 'session' && Object.hasOwn(localState.dials, archetype)) {
    previous = { layer: 'session', dial: localState.dials[archetype]! };
  } else if (layer === 'user' && Object.hasOwn(userDials, archetype)) {
    previous = { layer: 'user', dial: userDials[archetype] as DialRef };
  } else if (layer === 'repo' && repoPinned != null) {
    previous = { layer: 'repo', dial: repoPinned };
  }

  let narrative = '';
  const modelDisplay = refString;
  if (layer === 'user') {
    narrative = `${archetype} → ${modelDisplay}  [user default — applies across your repos]`;
  } else if (layer === 'session') {
    narrative = `${archetype} → ${modelDisplay}  [session dial — this checkout only, sticky until cleared]`;
  } else if (layer === 'repo') {
    narrative = `${archetype} → ${modelDisplay}  [repo pin — committed in .fadeno/executors.yaml]`;
  }
  if (probeNote) {
    // Prepend or append? Contract shows note as separate line; we include in narrative? Keep separate but also surface via console by caller.
    // For result, verification note is separate; narrative stays layer notice.
  }

  // Write to layer
  if (layer === 'session') {
    withLocalDialStateLock(repoRoot, () => {
      const current = readLocalDialState(repoRoot);
      previous = Object.hasOwn(current.dials, archetype)
        ? { layer: 'session', dial: current.dials[archetype]! }
        : null;
      const nextDials = { ...current.dials, [archetype]: dial };
      writeLocalDialState(repoRoot, { dials: nextDials, shadows: current.shadows, legacyNote: null });
    });
  } else if (layer === 'user') {
    const next = { ...userDials, [archetype]: dial as DialRef };
    writeUserDials(opts.userPathOptions ?? {}, next);
  } else if (layer === 'repo') {
    // Write to .fadeno/executors.yaml preserving comments
    const executorsPath = join(repoRoot, '.fadeno', 'executors.yaml');
    let docText = '';
    let doc: ReturnType<typeof parseDocument>;
    if (existsSync(executorsPath)) {
      docText = readFileSync(executorsPath, 'utf8');
      doc = parseDocument(docText);
    } else {
      doc = parseDocument('');
      // Need minimal structure with schema_version if not present? Ensure schema_version: 3
      // We'll create doc with dials
    }
    if (!doc.has('dials')) {
      doc.set('dials', doc.createNode({}));
    }
    doc.setIn(['dials', archetype], serializeDialRef(dial));
    // Ensure schema_version 3 exists
    if (!doc.has('schema_version')) {
      doc.set('schema_version', 3);
    }
    // Write
    const out = String(doc);
    mkdirSync(join(repoRoot, '.fadeno'), { recursive: true });
    writeFileSync(executorsPath, out, 'utf8');
  }

  return {
    archetype,
    dial,
    refString,
    model: compiled.model,
    model_id: compiled.modelId,
    effort: compiled.effectiveEffort,
    pinned_effort: compiled.pinnedEffort,
    effective_effort: compiled.effectiveEffort,
    harness: compiled.harness,
    variant: compiled.variant,
    layer,
    adaptive,
    repo_pinned: repoPinned,
    previous,
    verification,
    narrative,
    notes: [...notes, ...(probeNote != null ? [probeNote] : [])],
  };
}

// ---- Clear ----
export interface DialClearOptions extends DialCommonOptions {
  archetype?: string | null;
  session?: boolean;
  user?: boolean;
  repo?: boolean;
  // repo clear requires explicit archetype
}

export interface DialClearResult {
  cleared: string | null;
  removed: boolean;
  archetype: string | null;
  layer: 'session' | 'user' | 'repo' | null;
  remaining: Record<string, DialRef>;
  // For no-arg clear all
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

  // Repo clear without archetype is refused
  if (archetype == null && opts.repo) {
    throw new DialError('repo pins are committed config — remove them per archetype with `clear <archetype> --repo`');
  }

  // No archetype: clear all in layer
  if (archetype == null) {
    if (opts.session) {
      return withLocalDialStateLock(repoRoot, () => {
        const state = readLocalDialState(repoRoot);
        const count = Object.keys(state.dials).length;
        if (count === 0) return { cleared: null, removed: false, archetype: null, layer: 'session' as const, remaining: {}, count: 0 };
        writeLocalDialState(repoRoot, { dials: {}, shadows: state.shadows, legacyNote: null });
        return { cleared: null, removed: true, archetype: null, layer: 'session' as const, remaining: {}, count };
      });
    }
    if (opts.user) {
      const userDials = readUserDials(opts.userPathOptions);
      const count = Object.keys(userDials).length;
      if (count === 0) return { cleared: null, removed: false, archetype: null, layer: 'user', remaining: {} , count: 0};
      writeUserDials(opts.userPathOptions ?? {}, {});
      return { cleared: null, removed: true, archetype: null, layer: 'user', remaining: {}, count };
    }
    // Default bulk clear: every archetype, every non-committed layer —
    // session dials AND user dials go; repo pins are committed config and
    // stay until an explicit `clear <archetype> --repo`. Shadows persist
    // (they have their own clear-shadow).
    const state = readLocalDialState(repoRoot);
    const userDials = readUserDials(opts.userPathOptions);
    const sessionCount = Object.keys(state.dials).length;
    const userCount = Object.keys(userDials).length;
    const repoPins = (() => {
      try {
        return archetypeDisplaySort(Object.keys(loadLayered(repoRoot, opts.userPathOptions).profile.dials));
      } catch {
        return [] as string[];
      }
    })();
    const count = sessionCount + userCount;
    if (count === 0) {
      return { cleared: null, removed: false, archetype: null, layer: null, remaining: {}, count: 0, cleared_layers: { session: 0, user: 0 }, repo_pins_remaining: repoPins };
    }
    // Re-read under the same lock used by finite shadow reservations so this
    // bulk dial clear cannot restore a stale `remaining` count.
    const clearedSessionCount = withLocalDialStateLock(repoRoot, () => {
      const current = readLocalDialState(repoRoot);
      const count = Object.keys(current.dials).length;
      if (count > 0) writeLocalDialState(repoRoot, { dials: {}, shadows: current.shadows, legacyNote: null });
      return count;
    });
    if (userCount > 0) writeUserDials(opts.userPathOptions ?? {}, {});
    return { cleared: null, removed: true, archetype: null, layer: null, remaining: {}, count: clearedSessionCount + userCount, cleared_layers: { session: clearedSessionCount, user: userCount }, repo_pins_remaining: repoPins };
  }

  // Single archetype clear
  if (opts.session) {
    return withLocalDialStateLock(repoRoot, () => {
      const state = readLocalDialState(repoRoot);
      if (!Object.hasOwn(state.dials, archetype)) {
        return { cleared: null, removed: false, archetype, layer: 'session' as const, remaining: state.dials };
      }
      const prev = state.dials[archetype]!;
      const nextDials = { ...state.dials };
      delete nextDials[archetype];
      writeLocalDialState(repoRoot, { dials: nextDials, shadows: state.shadows, legacyNote: null });
      return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'session' as const, remaining: nextDials };
    });
  }
  if (opts.repo) {
    // Remove from .fadeno/executors.yaml dials
    const executorsPath = join(repoRoot, '.fadeno', 'executors.yaml');
    if (!existsSync(executorsPath)) {
      throw new DialError(`no repo pin for "${archetype}" to clear`);
    }
    const text = readFileSync(executorsPath, 'utf8');
    const doc = parseDocument(text);
    const dials = doc.get('dials') as unknown;
    if (dials == null || typeof dials !== 'object') {
      throw new DialError(`no repo pin for "${archetype}" to clear`);
    }
    // Check if key exists
    // parseDocument stores mapping, we can use doc.hasIn
    if (!doc.hasIn(['dials', archetype])) {
      throw new DialError(`no repo pin for "${archetype}" to clear`);
    }
    doc.deleteIn(['dials', archetype]);
    // If dials empty, remove key?
    const remainingDials = doc.get('dials') as unknown as Map<string, unknown> | Record<string, unknown>;
    // Check size
    let empty = false;
    if (remainingDials != null && typeof remainingDials === 'object') {
      void remainingDials;
      const dialsNode = doc.get('dials', true) as unknown as { items?: unknown[] };
      if (dialsNode && Array.isArray((dialsNode as { items?: unknown[] }).items) && (dialsNode as { items: unknown[] }).items.length === 0) empty = true;
    }
    if (empty) doc.delete('dials');
    const out = String(doc);
    writeFileSync(executorsPath, out, 'utf8');
    return { cleared: archetype, removed: true, archetype, layer: 'repo', remaining: {} };
  }
  if (opts.user) {
    const userDials = readUserDials(opts.userPathOptions);
    if (!Object.hasOwn(userDials, archetype)) {
      // Report where dial lives?
      // Check other layers?
      // For parity, just report not found but don't throw; return removed false
      return { cleared: null, removed: false, archetype, layer: 'user', remaining: userDials as Record<string, DialRef> };
    }
    const prev = userDials[archetype];
    const next = { ...userDials };
    delete next[archetype];
    writeUserDials(opts.userPathOptions ?? {}, next as Record<string, DialRef>);
    return { cleared: prev ? String((prev as { model: string }).model) : archetype, removed: true, archetype, layer: 'user', remaining: next as Record<string, DialRef> };
  }
  // Default clear: session first. When the session holds no dial and there is
  // no repo pin, the user default is the only dial this clear can mean — clear
  // it and say which layer answered. A repo pin blocks the inference (it is
  // committed config, removed only with an explicit --repo) and keeps the
  // guidance message instead.
  const state = readLocalDialState(repoRoot);
  if (!Object.hasOwn(state.dials, archetype)) {
    const layered = loadLayered(repoRoot, opts.userPathOptions);
    const userDials = readUserDials(opts.userPathOptions);
    if (!Object.hasOwn(layered.profile.dials, archetype) && Object.hasOwn(userDials, archetype)) {
      const prev = userDials[archetype] as DialRef;
      const next = { ...userDials } as Record<string, DialRef>;
      delete next[archetype];
      writeUserDials(opts.userPathOptions ?? {}, next);
      return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'user', inferred: true, remaining: next };
    }
    const livesAt = Object.hasOwn(layered.profile.dials, archetype) ? ('repo' as const) : null;
    return { cleared: null, removed: false, archetype, layer: null, remaining: state.dials, livesAt };
  }
  return withLocalDialStateLock(repoRoot, () => {
    const current = readLocalDialState(repoRoot);
    if (!Object.hasOwn(current.dials, archetype)) {
      return { cleared: null, removed: false, archetype, layer: 'session' as const, remaining: current.dials };
    }
    const prev = current.dials[archetype]!;
    const nextDials = { ...current.dials };
    delete nextDials[archetype];
    writeLocalDialState(repoRoot, { dials: nextDials, shadows: current.shadows, legacyNote: null });
    return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'session' as const, remaining: nextDials };
  });
}

// ---- Shadow ----
export interface DialShadowOptions extends DialCommonOptions {
  archetype: string;
  model: string;
  harness?: string | null;
  rate?: number | string | null;
  n?: number | string | null;
  spawn?: ProbeOptions['spawn'];
}

export interface DialShadowResult {
  archetype: string;
  dial: DialRef;
  refString: string;
  model: string;
  model_id: string;
  /** Legacy field: the effort this challenger runs at. Cannot tell a pin from
   * a registry default — read `pinned_effort` for that. */
  effort: string;
  /** The effort the user pinned on the challenger, else null. */
  pinned_effort: string | null;
  /**
   * The effort the challenger runs at: the pin, else the registry default.
   * A pair forces both arms onto the command lane, so for a shadow this
   * default is the command-lane default, never an inherited session effort.
   */
  effective_effort: string;
  /** The EXECUTOR harness the challenger resolved onto. */
  harness: string | null;
  /** The command-lane variant policy chose for the challenger. */
  variant: string | null;
  rate: number | null;
  n: number | null;
  remaining: number | null;
  expired: boolean;
  path: string;
  previous: ShadowAttachment | null;
  shadows: Record<string, ShadowAttachment>;
  shadow_attachments: Record<string, ShadowAttachmentView>;
  /** Loud advisories (unregistered fall-through, probe fail-open) for the CLI to print. */
  notes: string[];
}

export function runDialShadow(opts: DialShadowOptions): DialShadowResult {
  const repoRoot = repoRootOf(opts);
  const archetype = opts.archetype.trim();
  if (archetype === 'set' || archetype === 'clear' || archetype === 'shadow' || archetype === 'clear-shadow' || archetype === 'resolve') {
    throw new DialError(`archetype "${archetype}" is a reserved word — rename the archetype`);
  }
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new DialError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
  const modelInput = opts.model.trim();
  if (modelInput.length === 0) throw new DialError('Usage: fadeno dial shadow <archetype> <model>[@effort] [--harness <id>] [--rate <r>] [--n <count>]');
  let dial: DialRef;
  try {
    dial = buildDialRef(modelInput, opts.harness?.trim() || undefined, `model "${modelInput}"`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  let rate: number | undefined;
  if (opts.rate != null && opts.rate !== '') {
    const raw = opts.rate;
    const parsed = typeof raw === 'string' ? Number(raw) : (raw as number);
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      throw new DialError(`rate ${JSON.stringify(raw)} is not a number in (0, 1].`);
    }
    rate = parsed;
  }
  let n: number | undefined;
  if (opts.n != null && opts.n !== '') {
    const raw = opts.n;
    const parsed = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new DialError(`n ${JSON.stringify(raw)} is not a positive integer.`);
    }
    n = parsed;
  }
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  assertHarnessDeclared(profile, dial);
  let compiled: CompiledDelivery;
  try {
    compiled = resolveDelivery(dial, profile, profile.host ?? 'standalone', { archetype });
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  // Shadows are command deliveries only.
  //
  // `deliveryIsHost`, deliberately, and it is the one place `hostCandidateOf`
  // would be WRONG. That predicate asks "can this go out in-session", and its
  // answer is `false` for exactly the shapes with no argv at all
  // (`current-host` in a bare shell, a host-only harness named from another
  // host) — so keying on it would ADMIT as a challenger a delivery that has
  // no command lane to be paired on, and the refusal would surface later as a
  // dispatch failure instead of at attach time. `spec.adapter === 'host'` is
  // the shape question here, not the lane question, and it is the strict side.
  if (deliveryIsHost(compiled)) {
    throw new DialError(`shadow for "${archetype}" must be a command delivery — host shadows are not dispatchable`);
  }
  // Eligibility check, same as set.
  const refString = formatDialRef(dial);
  const eligibility = eligibilityFor(compiled.spec, archetype);
  if (eligibility === 'forbidden') {
    const conflict = explainEligibilityConflict({ executor: refString, spec: compiled.spec }, archetype);
    throw new DialError(conflict ?? `archetype "${archetype}" is forbidden on model "${compiled.model}"`);
  }
  // Probe with the same rules as `set`: silent skip for registered models on
  // a harness with no models_command; loud advisories otherwise.
  const notes: string[] = [];
  if (!compiled.registered) {
    notes.push(
      `note: ${compiled.model} is not in the model registry — running on ${compiled.harness}, id passed verbatim ` +
        '(declare it under models: to set a home harness or standard effort)',
    );
  }
  const hasModelsCommand = harnessCanProbe(profile, compiled.harness);
  if (!compiled.registered && !hasModelsCommand) {
    notes.push(`note: cannot verify ${compiled.modelId} on ${compiled.harness} (no models_command declared) — attaching unverified`);
  } else if (hasModelsCommand) {
    const probe = probeModel(profile, compiled.harness!, compiled.modelId, { spawn: opts.spawn, userPathOptions: opts.userPathOptions });
    if (probe.note != null) notes.push(probe.note);
  }

  const state = readLocalDialState(repoRoot);
  const shadowLayers: DialLayers = { session: state.dials, repo: profile.dials, user: readUserDials(opts.userPathOptions) as Record<string, DialRef> };
  {
    const novelty = providerNoveltyNote({
      profile,
      layers: shadowLayers,
      shadows: state.shadows,
      archetype,
      refString,
      compiled,
      kind: 'shadow',
    });
    if (novelty != null) notes.push(novelty);
  }
  {
    const unroutable = unroutablePrimaryNote({ profile, layers: shadowLayers, archetype });
    if (unroutable != null) {
      // Explicit `fadeno shadow` with an unroutable primary: the user asked
      // for a pair and the command lane cannot serve it. Fail loudly rather
      // than degrading silently (docs/experimental/slots-and-archetypes.md,
      // `shadow.routable` gate). The graceful case — an existing shadow
      // attachment with a redialed unroutable primary — emits a warning
      // through the dial-change path instead.
      throw new DialError(unroutable);
    }
  }
  const nextAttachment: ShadowAttachment = {
    model: dial.model,
    ...(dial.effort ? { effort: dial.effort } : {}),
    ...(dial.harness ? { harness: dial.harness } : {}),
    ...(rate != null ? { rate } : {}),
    ...(n != null ? { n, remaining: n } : {}),
  };
  // Attachment changes share the dispatch reservation lock. A concurrent
  // dispatch either reserves the old attachment before this reset or sees the
  // complete new configuration/count afterwards; it can never decrement a
  // half-written or superseded attachment.
  const written = withLocalDialStateLock(repoRoot, () => {
    const current = readLocalDialState(repoRoot);
    const nextShadows: Record<string, ShadowAttachment> = { ...current.shadows, [archetype]: nextAttachment };
    const path = writeLocalDialState(repoRoot, { dials: current.dials, shadows: nextShadows, legacyNote: null });
    return { previous: current.shadows[archetype] ?? null, nextShadows, path };
  });
  const { previous, nextShadows, path } = written;
  const shadow_attachments: Record<string, ShadowAttachmentView> = {};
  for (const [key, att] of Object.entries(nextShadows)) {
    // Compile to get the model id and harness for the view, when the
    // attachment's dial still resolves.
    try {
      const d: DialRef = shadowAttachmentRef(att);
      const c = resolveDelivery(d, profile);
      shadow_attachments[key] = shadowAttachmentView(att, c);
    } catch {
      shadow_attachments[key] = shadowAttachmentView(att);
    }
  }
  return {
    archetype,
    dial,
    refString,
    model: compiled.model,
    model_id: compiled.modelId,
    effort: compiled.effectiveEffort,
    pinned_effort: compiled.pinnedEffort,
    effective_effort: compiled.effectiveEffort,
    harness: compiled.harness,
    variant: compiled.variant,
    rate: rate ?? null,
    n: n ?? null,
    remaining: n ?? null,
    expired: false,
    path,
    previous,
    shadows: nextShadows,
    shadow_attachments,
    notes,
  };
}

export interface DialClearShadowOptions extends DialCommonOptions {
  archetype?: string | null;
}

export interface DialClearShadowResult {
  archetype: string | null;
  cleared: ShadowAttachment | null;
  removed: boolean;
  count: number;
  shadows: Record<string, ShadowAttachment>;
  shadow_attachments: Record<string, ShadowAttachmentView>;
  path: string;
}

export function runDialClearShadow(opts: DialClearShadowOptions = {}): DialClearShadowResult {
  const repoRoot = repoRootOf(opts);
  const archetype = opts.archetype?.trim() ? opts.archetype!.trim() : null;
  if (archetype != null && !BARE_IDENTIFIER_RE.test(archetype)) {
    throw new DialError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
  const state = readLocalDialState(repoRoot);
  const path = join(repoRoot, '.fadeno', 'local', 'dials');
  if (archetype == null) {
    const count = Object.keys(state.shadows).length;
    if (count === 0) {
      return { archetype: null, cleared: null, removed: false, count: 0, shadows: {}, shadow_attachments: {}, path };
    }
    const cleared = withLocalDialStateLock(repoRoot, () => {
      const current = readLocalDialState(repoRoot);
      const currentCount = Object.keys(current.shadows).length;
      if (currentCount === 0) return null;
      const path = writeLocalDialState(repoRoot, { dials: current.dials, shadows: {}, legacyNote: null });
      return { count: currentCount, path };
    });
    if (cleared == null) return { archetype: null, cleared: null, removed: false, count: 0, shadows: {}, shadow_attachments: {}, path };
    return { archetype: null, cleared: null, removed: true, count: cleared.count, shadows: {}, shadow_attachments: {}, path: cleared.path };
  }
  if (!Object.hasOwn(state.shadows, archetype)) {
    throw new DialError(`no shadow attachment for "${archetype}" to clear (.fadeno/local/dials)`);
  }
  const removed = withLocalDialStateLock(repoRoot, () => {
    const current = readLocalDialState(repoRoot);
    const cleared = current.shadows[archetype];
    if (cleared == null) return null;
    const nextShadows = { ...current.shadows };
    delete nextShadows[archetype];
    const path = writeLocalDialState(repoRoot, { dials: current.dials, shadows: nextShadows, legacyNote: null });
    return { cleared, nextShadows, path };
  });
  if (removed == null) throw new DialError(`no shadow attachment for "${archetype}" to clear (.fadeno/local/dials)`);
  const { cleared, nextShadows, path: newPath } = removed;
  const shadow_attachments: Record<string, ShadowAttachmentView> = {};
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  for (const [key, att] of Object.entries(nextShadows)) {
    try {
      const d: DialRef = shadowAttachmentRef(att);
      const c = resolveDelivery(d, layered.profile);
      shadow_attachments[key] = shadowAttachmentView(att, c);
    } catch {
      shadow_attachments[key] = shadowAttachmentView(att);
    }
  }
  return { archetype, cleared, removed: true, count: 1, shadows: nextShadows, shadow_attachments, path: newPath };
}

// ---- Show (effective table) ----
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
  const userDialsRaw = readUserDials(opts.userPathOptions);
  const userDials: Record<string, DialRef> = userDialsRaw as Record<string, DialRef>;
  const sessionDials = dialState.dials;
  const repoDials = profile.dials;
  const shadows = dialState.shadows;

  const legacy_pin_note = dialState.legacyNote;
  const { suppressed_canon_archetypes, note } = canonSurfacing(layered);

  // All archetypes to show: triad + declared + any carrying dial/shadow
  const archetypesSet = knownArchetypes(profile.archetypes, sessionDials, repoDials, userDials, shadows);
  // Also include bindings keys that are archetype-like? bindings are role->dial, but effective table is per archetype
  // Include binding archetypes? Not needed.

  const allArchetypes = archetypeDisplaySort(archetypesSet);

  const layers: import('../lib/executors.ts').DialLayers = { session: sessionDials, repo: repoDials, user: userDials };

  const rows: EffectiveRow[] = [];
  const staleDials: Array<{ archetype: string; target: string }> = [];
  const staleShadows: StaleShadowView[] = [];
  const shadow_attachments: Record<string, ShadowAttachmentView> = {};

  // Build shadow attachments for table
  for (const [arch, att] of Object.entries(shadows)) {
    try {
      const d: DialRef = shadowAttachmentRef(att);
      const c = resolveDelivery(d, profile);
      shadow_attachments[arch] = shadowAttachmentView(att, c);
    } catch {
      // unknown harness etc -> mark stale
      staleShadows.push({ archetype: arch, target: att.model });
    }
  }

  for (const archetype of allArchetypes) {
    // Resolve cascade
    let cascade;
    try {
      cascade = resolveDialCascade(archetype, archetype, { bindings: profile.bindings, archetypes: profile.archetypes }, layers);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DialError(err.message);
      throw err;
    }
    let compiled: CompiledDelivery;
    try {
      compiled = resolveDelivery(cascade.ref, profile);
    } catch {
      // Unknown harness etc -> stale dial
      staleDials.push({ archetype, target: formatDialRef(cascade.ref) });
      continue;
    }
    const adapter = compiled.spec.adapter;
    const effort = compiled.effectiveEffort;
    // Model display: canonical name, plus `@ effort` exactly when the user
    // pinned one. Keying on the PIN rather than on "differs from the registry
    // standard" is what makes `opus@xhigh` legible even where xhigh is also
    // the catalog default — the two deliver on different lanes, so a display
    // that collapses them is misleading. `current-host` is no exception: a
    // pin on it is precisely the dial that leaves the session.
    let modelDisplay = compiled.model;
    if (compiled.pinnedEffort != null) {
      modelDisplay = `${compiled.model} @ ${compiled.pinnedEffort}`;
    }
    // Handle fallback rendering: if resolvedVia != null, modelDisplay is → <via>
    if (cascade.resolvedVia != null) {
      modelDisplay = `→ ${cascade.resolvedVia}`;
      // effort for fallback row is —
    }
    const row: EffectiveRow = {
      archetype,
      model: compiled.model,
      model_id: compiled.modelId,
      effort: cascade.resolvedVia != null ? '—' : effort,
      pinned_effort: compiled.pinnedEffort,
      effective_effort: compiled.effectiveEffort,
      harness: compiled.harness,
      harness_explicit: cascade.ref.harness != null,
      variant: compiled.variant,
      source: cascade.source,
      resolvedVia: cascade.resolvedVia,
      dial: cascade.ref,
      refString: compiled.refString,
      adapter,
      modelDisplay,
    };
    // Eligibility mark
    const elig = eligibilityFor(compiled.spec, archetype);
    if (elig !== 'eligible') row.eligibility = elig;
    if (Object.hasOwn(shadows, archetype) && !staleShadows.some((s) => s.archetype === archetype)) {
      row.shadow = shadow_attachments[archetype];
    }
    rows.push(row);
  }

  // Sort rows by archetype already sorted
  return {
    rows,
    dials: { session: sessionDials, repo: repoDials, user: userDials },
    shadows,
    shadow_attachments,
    staleShadows,
    staleDials,
    legacy_pin_note,
    legacy_via_note: dialState.legacyViaNote ?? null,
    suppressed_canon_archetypes,
    note,
    host,
    legacyPinNote: legacy_pin_note,
  };
}

/**
 * `fadeno dial shadow` / `fadeno shadow` with no further arguments: the same
 * effective table `runDialShow` builds, filtered to archetypes carrying an
 * active shadow attachment. Composition, not a second renderer — every field
 * besides `rows` (dials, shadows, staleShadows, note, …) passes through
 * unchanged, so `--json` and the stale-shadow warnings stay correct for free.
 */
export function runShadowShow(opts: DialCommonOptions = {}): DialShowResult {
  const result = runDialShow(opts);
  return { ...result, rows: result.rows.filter((row) => row.shadow != null) };
}

// ---- Resolve ----
export interface DialResolveResult {
  archetype: string;
  executor: string;
  model: string;
  model_id: string;
  /** Legacy field: the effort this delivery runs at. Cannot tell a pin from a
   * registry default — read `pinned_effort` for that. */
  effort: string;
  /**
   * The effort the user pinned on the resolved dial, or null when unpinned.
   * The lane predicate keys on this: an unpinned dial inherits the session
   * and stays in-session; a pin that differs from the session's effort goes
   * out on the command lane.
   */
  pinned_effort: string | null;
  /** The effort this delivery runs at: the pin, else the registry default. */
  effective_effort: string;
  /**
   * The lane decision, from the same `decideLane` that `steering resolve`
   * calls. The Claude steering hook routes on `lane`, so this is not a
   * convenience field: without it the hook falls back to deriving the lane
   * from `adapter`, and effort routes nothing at all.
   *
   * `hostEffortProven` is deliberately never passed here — proving it needs a
   * `--host-executor` this surface does not take — so an unobservable session
   * effort resolves to the command lane, per the rule.
   */
  effort_pinned: boolean;
  session_effort: string | null;
  lane: DeliveryLane;
  lane_reason: LaneReason;
  /**
   * The EXECUTOR harness this dial resolved onto: `claude`, `codex`,
   * `opencode`… Replaces `driver`, which named the same thing in a vocabulary
   * that no longer exists.
   *
   * `null` only for `current-host` with no host — a bare shell. The base dial
   * names whatever session is running, and there is none; printing
   * `standalone` here would name a value that is not in `harnesses:`.
   */
  harness: string | null;
  /** The command-lane variant policy chose, or null for the base lane. */
  variant: string | null;
  adapter: 'command' | 'host';
  /**
   * The ambient HOST — the harness this call is running inside, `standalone`
   * from a bare shell. Discovered per call, never stored.
   *
   * This key used to be `harness` and meant the host, while `driver` meant the
   * executor. Both names moved at once so no reader can be right about one and
   * wrong about the other.
   */
  host: string;
  source: RoleResolutionSource;
  resolved_via?: string;

  /**
   * Present when the resolved model reached this profile through the per-key
   * user-catalog fallback — a self-contained project catalog promoting a
   * personal alias. Null otherwise: project-declared, builtin, unregistered,
   * or any repo where layering ran normally. Additive and always derived from
   * the same load that produced the delivery, so a caller can audit WHERE an
   * executor came from without re-loading catalogs.
   */
  model_fallback?: { promoted_from_user: true; note: string };

  eligibility?: string;
  dial: DialRef;
  delivery: { dispatchable: boolean; dispatch_command: string | null; action: string };
  /**
   * The relay identity for THIS harness — the cheap model a caller hands a
   * dispatch proxy so the proxy forwards a delivery verbatim instead of doing
   * the role work itself. `model_id` is the value to hand the harness; `ref`
   * is what the catalog says, effort suffix and all.
   *
   * `null` means the catalog states no opinion, and a caller must then keep
   * its own built-in default rather than invent one — a relay the session's
   * provider cannot serve is worse than a stale but servable one. A
   * self-contained project catalog suppresses the builtin layer entirely, so
   * null is the common case in a real repo, not the exotic one.
   *
   * Always present (null rather than omitted), like `pinned_effort` and
   * `session_effort`: this is a hook contract, and the Claude steering hook
   * reads it on every spawn it rewrites onto a proxy. An omitted key would
   * read the same as a `fadeno` too old to carry one — the same fallback
   * either way, but the contract is better stated than inferred.
   */
  relay: { ref: string; model_id: string; effort: string } | null;
  /**
   * The pair decision, when this archetype carries a shadow attachment.
   *
   * `selected` is the kernel's roll, not advice: a caller that routes on it
   * and a kernel that later re-derives it at dispatch time reach the same
   * answer, because the roll is a pure function of the prompt digest, the
   * archetype, and the challenger. That is what lets a host wrapper decide
   * whether a spawn is a pair *before* it routes, with no state to hand over.
   *
   * `selected` is null when no prompt digest was supplied — the caller asked a
   * question the roll cannot answer, and must not read that as "no".
   *
   * `routable` is independent of the roll: it is `explainPairRoutability`,
   * the same predicate the kernel answers before forming a pair, so the two
   * agree by construction. It asks TWO things, not one — that the primary's
   * resolved spec can take a command lane at all (a command adapter, or a
   * host adapter with a `fallback_command`), AND that the lane satisfies the
   * archetype's declared write posture. `routable_reason` carries the second
   * answer's explanation; it is `null` exactly when `routable` is true.
   * A caller must force command delivery only when `selected && routable` —
   * a selected-but-unroutable pair degrades to no pair, never to a dispatch
   * the kernel would refuse.
   */
  shadow?: {
    attached: true;
    challenger: string;
    rate: number | null;
    n: number | null;
    remaining: number | null;
    expired: boolean;
    selected: boolean | null;
    routable: boolean;
    /**
     * Why not, when `routable` is false — `null` when it is true. Present
     * because the predicate always computed this string and both preview
     * surfaces used to drop it on the floor, which is how a user at
     * `--rate 1.0` got no pairs and no explanation anywhere.
     */
    routable_reason: string | null;
  };
}

/**
 * The dispatch advice this resolution hands its reader.
 *
 * `conflict` is the kernel's OWN refusal for this delivery, computed by the
 * caller and passed in — not re-derived here. The guidance and the kernel must
 * answer from one predicate, not two that agree only by coincidence: advising
 * a dispatch that this same binary would refuse is worse than advising
 * nothing.
 *
 * Exactly one predicate reaches here, and that is the whole list rather than a
 * simplification: eligibility. Write posture used to be the other, and its
 * example was instructive — an effort-pinned host dial left the session for a
 * `fallback_command` lane that `commandRoutable` called routable and the
 * kernel then refused. Permissions are no longer Fadeno's to judge, so that
 * disagreement cannot recur. The remaining two kernel predicates are not
 * knowable at resolve time at all: `constraint_command` must execute a policy,
 * and `provider_distinctness` needs input provenance a resolver never
 * receives.
 */
function deliveryGuidance(
  archetype: string,
  executorName: string,
  spec: ExecutorSpec,
  conflict: string | null,
): DialResolveResult['delivery'] {
  if (conflict != null) {
    return {
      dispatchable: false,
      dispatch_command: null,
      // The kernel's exact refusal, verbatim: it already names the remedy,
      // and rewording it here is how the two drift apart.
      action: `Do NOT dispatch — it would be refused. ${conflict}`,
    };
  }
  if (commandRoutable(spec)) {
    const lane = spec.adapter === 'host'
      ? `Host executor "${executorName}" has a command lane (\`fallback_command\`), and the dispatch delivers ` +
        'there rather than in-session — an isolated worktree, a dispatch id, and a terminal receipt.'
      : `Executor "${executorName}" runs outside this harness.`;
    return {
      dispatchable: true,
      dispatch_command: `fadeno dispatch --archetype ${archetype}`,
      action: `Dispatch it: \`fadeno dispatch --archetype ${archetype}\` with the task prompt on stdin. ${lane}`,
    };
  }
  return {
    dispatchable: false,
    dispatch_command: null,
    // Same wording discipline as the kernel's refusal: name the remedy that
    // restores a real dispatch, and never present the in-session agent as an
    // equal. It writes a host_delivery row, but that row carries no dispatch
    // id and no terminal receipt, so there is nothing to read back; it also
    // has no isolated worktree and forms no shadow pair.
    action:
      `Do NOT dispatch. Host executor "${executorName}" declares no fallback_command, so ad-hoc dispatch has ` +
      `nothing to invoke. Either spawn the in-session ${archetype} agent — which writes a host_delivery row but ` +
      'no dispatch id or terminal receipt, has no isolated worktree, and forms no shadow pair — or give it a ' +
      // `<model>` for the sentinel, exactly as `dispatch.ts` does: naming a
      // harness beside `current-host` is advice that cannot be followed, since
      // the base dial names the session and ignores a harness entirely.
      `command lane: \`fadeno dial ${archetype} ${executorName === 'current-host' ? '<model>' : executorName} --harness <id>\`.`,
  };
}

export function runDialResolve(opts: DialCommonOptions & { archetype: string; promptSha256?: string | null }): DialResolveResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const host = profile.host ?? 'standalone';
  const archetype = opts.archetype.trim();
  if (archetype === 'set' || archetype === 'clear' || archetype === 'shadow' || archetype === 'clear-shadow' || archetype === 'resolve') {
    throw new DialError(`archetype "${archetype}" is a reserved word — rename the archetype`);
  }
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new DialError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
  // Strict: legacyNote does NOT block, but malformed v3 pin still errors.
  // readLocalDialState will return legacyNote for pre-0.6, else throw for malformed v3.
  const dialState = (() => {
    try {
      return readLocalDialState(repoRoot);
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DialError(err.message);
      throw err;
    }
  })();
  const userDials = readUserDials(opts.userPathOptions) as Record<string, DialRef>;
  const layers = { session: dialState.dials, repo: profile.dials, user: userDials };
  // Resolve (strict)
  let resolved: import('../lib/executors.ts').RoleResolution;
  try {
    resolved = resolveRole(archetype, archetype, profile, layers);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const spec = resolved.delivery.spec;
  const eligibility = eligibilityFor(spec, archetype);

  // The pair decision. Re-derived rather than remembered: the same roll runs
  // again inside `fadeno dispatch`, so a caller that routes on `selected` and
  // the kernel that later fires the challenger cannot disagree.
  const attachment = dialState.shadows[archetype];
  let shadow: DialResolveResult['shadow'];
  if (attachment != null) {
    const challenger = formatDialRef(shadowAttachmentRef(attachment));
    const digest = opts.promptSha256?.trim();
    const rate = attachment.rate ?? null;
    const expired = shadowAttachmentExpired(attachment);
    shadow = {
      attached: true,
      challenger,
      rate,
      n: attachment.n ?? null,
      remaining: attachment.remaining ?? null,
      expired,
      // No rate means every dispatch fires; no digest means the caller cannot
      // be told, and must not read the silence as a "no".
      selected: expired ? false : rate == null ? true : digest ? shadowSampleRoll(digest, archetype, challenger) < rate : null,
      // The PRIMARY's own resolved spec — `spec` above, after write-posture —
      // not the challenger's: this is what a selected pair would have to reuse
      // to reach the command lane.
      ...pairRoutabilityFields(explainPairRoutability(spec, resolved.delivery.refString)),
    };
  }

  // The relay, compiled for the harness this resolve is answering for. A
  // catalog that names an UNSERVABLE relay throws rather than degrading to
  // null: null is reserved for "stated no opinion", and collapsing the two
  // would resurrect exactly the silent-vanish failure the catalog-key
  // strictness work removed. The message names the key so the hook's denial
  // text points at the line to fix.
  const relay = (() => {
    try {
      return resolveRelay(profile, host);
    } catch (err) {
      if (err instanceof ExecutorProfileError) {
        throw new DialError(`harnesses.${host}.host.relay: ${err.message}`);
      }
      throw err;
    }
  })();

  return {
    archetype,
    executor: resolved.delivery.refString,
    model: resolved.delivery.model,
    model_id: resolved.delivery.modelId,
    effort: resolved.delivery.effectiveEffort,
    pinned_effort: resolved.delivery.pinnedEffort,
    ...decideLane({
      pinnedEffort: resolved.delivery.pinnedEffort,
      effectiveEffort: resolved.delivery.effectiveEffort,
      sessionEffort: readSessionEffort(opts.env ?? process.env),
      hostModel: resolved.delivery.hostCandidate,
      commandLane: commandRoutable(spec),
    }),
    harness: resolved.delivery.harness,
    variant: resolved.delivery.variant,
    adapter: spec.adapter,
    host,
    source: resolved.source,
    ...(resolved.resolvedVia != null ? { resolved_via: resolved.resolvedVia } : {}),
    ...(layered.selfContained && layered.modelFallback.promoted.includes(resolved.delivery.model)
      ? { model_fallback: { promoted_from_user: true as const, note: formatModelFallbackNote(layered.modelFallback)! } }
      : {}),
    ...(eligibility !== 'eligible' ? { eligibility } : {}),
    dial: resolved.delivery.ref,
    delivery: deliveryGuidance(
      archetype,
      resolved.delivery.refString,
      spec,
      // The kernel refuses a forbidden pairing outright, so a resolve that
      // answers "Dispatch it" here would be guidance walking into that
      // refusal. Eligibility is the only conflict left that is knowable at
      // resolve time — permissions are no longer Fadeno's to judge.
      explainEligibilityConflict({ executor: resolved.delivery.refString, spec }, archetype),
    ),
    relay: relay != null
      ? { ref: relay.refString, model_id: relay.modelId, effort: relay.effort }
      : null,
    ...(shadow != null ? { shadow } : {}),
  };
}

/**
 * The `~ shadow:` line under an effective-table row.
 *
 * `shadow.effort` is the attachment's own field, which is written only from
 * `dial.effort` — the pin the user typed — so this line already shows a pin
 * and only a pin. The unpinned case renders nothing rather than `inherit`:
 * silence is unambiguous where a column is not (the table's effort column has
 * to print *something*), and `inherit` would be actively wrong here — a pair
 * forces both arms onto the command lane, so an unpinned challenger runs at
 * its command-lane default and inherits no session effort at all.
 */
export function formatShadowLine(shadow: ShadowAttachmentView, baseIndent: string): string {
  const on = shadow.harness ? ` on ${shadow.harness}` : '';
  const effort = shadow.effort ? ` @ ${shadow.effort}` : '';
  const model = `${shadow.model}${effort}${on}`;
  const rate = shadow.rate != null ? ` rate ${shadow.rate}` : '';
  const budget = shadow.n != null
    ? shadow.expired
      ? ` [expired after ${shadow.n} trigger${shadow.n === 1 ? '' : 's'}]`
      : ` [${shadow.remaining}/${shadow.n} triggers remaining]`
    : '';
  const transport = shadow.adapter != null ? ` [${shadow.adapter}]` : '';
  return `${baseIndent}  ~ shadow: ${model}${transport}${rate}${budget}`;
}

// ---- Delivery lane (why a dial leaves the session) ----

/**
 * Re-exported from `lib/lane.ts` so the CLI keeps one import site. There must
 * be exactly one reader of this channel: a second one drifts silently, since
 * both would look correct in isolation.
 */
export const sessionEffort = readSessionEffort;

/**
 * Why each resolved dial leaves the session on effort grounds — one entry per
 * input ref, positionally aligned, null where effort is not the reason.
 *
 * Returns the resolver's own `LaneDecision` for each ref, or null where the
 * delivery stays in-session — the same `decideLane` the hook routes on, never
 * a second implementation of it.
 *
 * The predicate keys on the PIN, never on the resolved effort: every catalog
 * model declares a default, so comparing effective efforts would report a
 * plain `dial worker opus` as leaving the session in any non-default session
 * — the exact inversion of the rule. A ref string carries the distinction
 * losslessly (`formatDialRef` emits `@effort` only for a pin), which is why
 * this takes ref strings and needs no side channel.
 *
 * Non-host deliveries return null: a command executor is on the command lane
 * whatever the session's effort is, and naming effort as the reason there
 * would misattribute it. Everything is best-effort — an unparseable ref, an
 * unloadable profile, or an unmeasurable session effort yields null rather
 * than a guess.
 */
export function offHostLanes(
  refStrings: readonly (string | null)[],
  session: string | null,
  opts: DialCommonOptions = {},
): Array<LaneDecision | null> {
  const none = refStrings.map(() => null);
  let profile: ExecutorProfile;
  try {
    profile = loadLayered(repoRootOf(opts), opts.userPathOptions).profile;
  } catch {
    return none;
  }
  return refStrings.map((refString) => {
    if (refString == null) return null;
    try {
      const compiled = resolveDelivery(parseDialRef(refString, `dial "${refString}"`), profile);
      const hostModel = compiled.hostCandidate;
      const decision = decideLane({
        pinnedEffort: compiled.pinnedEffort,
        effectiveEffort: compiled.effectiveEffort,
        sessionEffort: session,
        hostModel,
        commandLane: commandRoutable(compiled.spec),
      });
      // Only an off-host answer is worth annotating: a host-lane delivery is
      // what the reader already assumes, and labelling it would be noise.
      // The whole decision comes back rather than just the reason, because
      // `command` and `restart_required` must not render alike — a
      // `restart_required` labelled "command lane" would assert the lane it
      // just said does not exist. `hostEffortProven` is deliberately not
      // passed: it needs a `--host-executor` this echo never has, so the echo
      // degrades to the stricter answer rather than claiming proof.
      // A delivery that was never a host candidate AND has a command lane is
      // suppressed for DISPLAY only — the decision above is still the
      // resolver's. A command executor leaves the session because of its
      // model, which the reader can already see on the same line; annotating
      // it with an effort-shaped label would misattribute the cause.
      //
      // `restart_required` is never suppressed, host candidate or not: it is
      // the one answer that says the delivery is going NOWHERE, and a reader
      // who is not told that has no way to find out. Under v4 that shape is
      // more common than it was — `current-host` in a bare shell is not a host
      // candidate at all, because a bare shell has no session to deliver in.
      //
      // This is a rendering filter, never a second predicate: nothing here can
      // turn an off-host answer into a host one.
      if (decision.lane === 'host') return null;
      if (decision.lane === 'restart_required') return decision;
      return hostModel ? decision : null;
    } catch {
      return null;
    }
  });
}

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadLayeredProfile, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  BARE_IDENTIFIER_RE,
  applyWritePosture,
  archetypeDisplaySort,
  knownArchetypes,
  commandRoutable,
  compileDialRef,
  deliveryIsHost,
  eligibilityFor,
  ExecutorProfileError,
  explainEligibilityConflict,
  explainPairRoutability,
  explainWriteConflict,
  formatDialRef,
  forcesWritePosture,
  parseDialRef,
  readLocalDialState,
  resolveDialCascade,
  resolveRelay,
  resolveRole,
  serializeDialRef,
  writeLocalDialState,
  type DialRef,
  type ExecutorProfile,
  type ExecutorSpec,
  type ShadowAttachment,
  type RoleResolutionSource,
  type CompiledDelivery,
  type DialLayers,
  shadowSampleRoll,
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
   * The route's public name — what `--via` takes and what the table prints in
   * its `via` column. This field used to have two synonyms, `harness` and
   * `delivery`, both carrying this same value; both are gone. `harness` was
   * the actively harmful one: `DialShowResult.harness` in the SAME payload
   * means the actual harness (`claude`, `codex`), so a reader who found
   * `harness: "codex"` on a row had no way to know it meant the driver.
   */
  driver: string;
  source: RoleResolutionSource;
  resolvedVia: string | null;
  dial: DialRef;
  refString: string;
  adapter: 'command' | 'host';
  /** True when a write-requiring archetype gets this route's write variant. */
  write_variant?: boolean;
  /** True when this direct dial explicitly overrides a write-posture mismatch. */
  write_posture_forced?: boolean;
  eligibility?: string;
  shadow?: ShadowAttachmentView;
  // display helpers
  modelDisplay: string;
}

export interface ShadowAttachmentView {
  model: string;
  effort?: string;
  via?: string;
  rate?: number;
  adapter?: 'command' | 'host';
  driver?: string;
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
  suppressed_canon_archetypes: string[];
  note: string | null;
  harness: string;
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

function canonSurfacing(layered: LayeredProfile): { suppressed_canon_archetypes: string[]; note: string | null } {
  const arr = layered.suppressedCanonArchetypes;
  return { suppressed_canon_archetypes: arr, note: formatSuppressedCanonNote(arr) };
}

function buildDialRef(modelInput: string, via: string | undefined, label: string): DialRef {
  // modelInput may be "model@effort" or just "model"
  const base = parseDialRef(modelInput, label);
  if (via != null && via.trim().length > 0) {
    const v = via.trim();
    if (!BARE_IDENTIFIER_RE.test(v) && /\s/.test(v)) {
      throw new DialError(`${label} via "${v}" is not a bare identifier.`);
    }
    // If base already has via, conflict?
    if (base.via != null && base.via !== v) {
      throw new DialError(`${label} via mismatch: "${base.via}" vs "${v}".`);
    }
    base.via = v;
  }
  return base;
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
  driver: string,
  modelId: string,
  opts: ProbeOptions = {},
): { status: VerificationStatus; note: string | null } {
  const harness = profile.harness ?? 'standalone';
  const routesForHarness = (profile.routes as Record<string, Record<string, { models_command?: string[] | null }>>)[harness] ?? {};
  let route: { models_command?: string[] | null } | null = null;
  for (const [key, r] of Object.entries(routesForHarness)) {
    const alias = (r as { driver?: string }).driver ?? key;
    if (alias === driver) {
      route = r as { models_command?: string[] | null };
      break;
    }
  }
  // If model is current-host, skip silently (no probe)
  if (modelId === 'current-host') return { status: null, note: null };
  if (route == null) {
    // No route for driver? Should not happen if compiled; but treat as unverified
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${driver} (no route declared) — dialing unverified` };
  }
  const modelsCommand = (route as { models_command?: string[] | null }).models_command;
  if (modelsCommand == null || modelsCommand.length === 0) {
    // Callers suppress this for registered models and host deliveries; only an
    // unregistered dial surfaces it loudly.
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${driver} (no models_command declared) — dialing unverified` };
  }
  // Check cache
  const userOpts = opts.userPathOptions ?? {};
  if (isModelVerified(userOpts, driver, modelId)) {
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
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${driver} (${(err as Error).message}) — dialing unverified` };
  }
  if ((result as { error?: Error }).error != null) {
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${driver} (${(result as { error?: Error }).error!.message}) — dialing unverified` };
  }
  if (result.status !== 0) {
    return { status: 'unverified', note: `note: cannot verify ${modelId} on ${driver} (models_command exited ${result.status}) — dialing unverified` };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  // Membership: delivered id appears as whitespace/comma-delimited token on some stdout line
  const tokens = stdout.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 0);
  // Also consider each line tokenization? Already split.
  if (tokens.includes(modelId)) {
    recordVerifiedModel(userOpts, { driver, model: modelId, verified_at: new Date().toISOString() });
    return { status: 'verified', note: null };
  }
  // Not found: refuse with nearest matches
  const nearest = nearestMatches(modelId, tokens, 3);
  const suggestion = nearest.length > 0 ? ` — did you mean ${nearest.map((n) => `"${n}"`).join(', ')}?` : '';
  throw new DialError(`unknown model "${modelId}" on ${driver}${suggestion}`);
}

function routeForDriver(profile: ExecutorProfile, driver: string): { route: unknown; hasModelsCommand: boolean } | null {
  const harness = profile.harness ?? 'standalone';
  const routesForHarness = (profile.routes as Record<string, Record<string, unknown>>)[harness] ?? {};
  for (const [key, r] of Object.entries(routesForHarness)) {
    const alias = (r as { driver?: string }).driver ?? key;
    if (alias === driver) return { route: r, hasModelsCommand: (r as { models_command?: unknown }).models_command != null };
  }
  return null;
}

export interface DialSetOptions extends DialCommonOptions {
  archetype: string;
  model: string; // model[@effort]
  via?: string | null;
  session?: boolean;
  user?: boolean;
  repo?: boolean;
  /** Persist an explicit override when this binding mismatches write posture. */
  force?: boolean;
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
  /** The route's public name — the value `--via` takes. See `EffectiveRow.driver`. */
  driver: string;
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
  via?: string | null;
  session?: boolean;
  user?: boolean;
  repo?: boolean;
  force?: boolean;
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
    throw new DialError('Usage: fadeno dial <archetype>[+<archetype>…] <model>[@effort] [--via <driver>] [--session|--user|--repo] [--force]');
  }
  if ([opts.session, opts.user, opts.repo].filter(Boolean).length > 1) {
    throw new DialError('--session, --user, and --repo are mutually exclusive.');
  }
  const repoRoot = repoRootOf(opts);
  const modelInput = opts.model.trim();
  if (modelInput.length === 0) {
    throw new DialError('Usage: fadeno dial <archetype>[+<archetype>…] <model>[@effort] [--via <driver>] [--session|--user|--repo] [--force]');
  }
  let dial: DialRef;
  try {
    dial = buildDialRef(modelInput, opts.via?.trim() || undefined, `model "${modelInput}"`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  let compiled: CompiledDelivery;
  try {
    compiled = compileDialRef(dial, profile);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const refString = formatDialRef(dial);
  // Atomic pre-validation: same checks runDialSet applies, over every
  // archetype, before a single write.
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
    if (compiled.spec.adapter === 'command') {
      const conflict = explainWriteConflict({ executor: refString, spec: compiled.spec }, archetype, profile);
      if (conflict != null && opts.force !== true) {
        failures.push(conflict);
        continue;
      }
    }
    const eligibilityConflict = explainEligibilityConflict({ executor: refString, spec: compiled.spec }, archetype);
    if (eligibilityConflict != null) failures.push(eligibilityConflict);
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
      const other = compileDialRef(ref, profile);
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
    providerOf({
      model: attachment.model,
      ...(attachment.effort ? { effort: attachment.effort } : {}),
      ...(attachment.via ? { via: attachment.via } : {}),
    });
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
  const postured = applyWritePosture(resolved.delivery.spec, archetype, profile.archetypes);
  if (commandRoutable(postured.spec)) return null;
  return (
    `WARNING: NO PAIR POSSIBLE — ${archetype}'s primary (${resolved.delivery.refString}) resolves to a host ` +
    'executor with no fallback_command, so this shadow attachment can never be sampled: a selected pair has no ' +
    'command lane to force both arms onto, and an unroutable pair always degrades to no pair.\n' +
    `Dial the primary to a command-capable executor to make this attachment take effect: ` +
    `\`fadeno dial ${archetype} <model>\`.`
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
  if (modelInput.length === 0) throw new DialError('Usage: fadeno dial <archetype> <model>[@effort] [--via <driver>] [--session|--user|--repo] [--force]');
  // Build dial ref
  let dial: DialRef;
  try {
    dial = buildDialRef(modelInput, opts.via?.trim() || undefined, `model "${modelInput}"`);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  // Compile before any state touch
  let compiled: CompiledDelivery;
  try {
    compiled = compileDialRef(dial, profile);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  const refString = formatDialRef(dial);
  // Set-time checks
  // b. Write posture and eligibility. Host deliveries are exempt from the
  // write check: the in-session agent's permissions are the host's business,
  // and a host spec's write_access describes only its command fallback.
  const writeConflict = compiled.spec.adapter === 'command'
    ? explainWriteConflict({ executor: refString, spec: compiled.spec }, archetype, profile)
    : null;
  if (writeConflict != null && opts.force !== true) throw new DialError(writeConflict);
  if (writeConflict != null) dial.force_write_posture = true;
  const eligibilityConflict = explainEligibilityConflict({ executor: refString, spec: compiled.spec }, archetype);
  if (eligibilityConflict != null) throw new DialError(eligibilityConflict);

  // c. Verification probe
  let verification: VerificationStatus = null;
  let probeNote: string | null = null;
  const notes: string[] = [];
  if (writeConflict != null) {
    notes.push(
      `WARNING: FORCED WRITE-POSTURE MISMATCH — ${archetype} → ${refString}\n` +
      `${writeConflict}\n` +
      'The override is persisted with this dial and applies at dispatch time. Clear or replace the dial to remove it.',
    );
  }
  // @effort on host delivery is a request, not a live setting: it travels on
  // the compiled spec and is applied by the materialized agent surface (codex
  // TOMLs, .claude agent frontmatter). Say so instead of refusing.
  if (dial.effort != null && deliveryIsHost(compiled)) {
    notes.push(
      `note: ${compiled.driver} host route — effort ${compiled.effectiveEffort} is recorded as the request; run \`fadeno steering apply\` to pin it into the host agent slots`,
    );
  }
  {
    const postured = applyWritePosture(compiled.spec, archetype, profile.archetypes);
    if (postured.usedWriteVariant) {
      notes.push(
        `note: ${archetype} requires write — ${refString} delivers through the ${compiled.driver} route's write variant`,
      );
    }
  }
  if (!compiled.registered) {
    notes.push(
      `note: ${compiled.model} is not in the model registry — routing via ${compiled.driver}, id passed verbatim ` +
        '(declare it under models: to set a home driver or standard effort)',
    );
  }
  // Skip for current-host silently; a registered model on a driver with no
  // models_command also skips silently (probing is for drivers that can answer).
  const shouldProbe = compiled.model !== 'current-host' && compiled.driver !== 'current-host';
  const routeInfo = routeForDriver(profile, compiled.driver);
  const hasModelsCommand = routeInfo?.hasModelsCommand ?? false;
  if (shouldProbe) {
    if (!hasModelsCommand) {
      if (!compiled.registered) {
        probeNote = `note: cannot verify ${compiled.modelId} on ${compiled.driver} (no models_command declared) — dialing unverified`;
        verification = 'unverified';
      }
    } else {
      // Has models_command, do probe
      try {
        const probe = probeModel(profile, compiled.driver, compiled.modelId, { spawn: opts.spawn, userPathOptions: opts.userPathOptions });
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
    const nextDials = { ...localState.dials, [archetype]: dial };
    writeLocalDialState(repoRoot, { dials: nextDials, shadows: localState.shadows, legacyNote: null });
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
    driver: compiled.driver,
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
      const state = readLocalDialState(repoRoot);
      const count = Object.keys(state.dials).length;
      if (count === 0) return { cleared: null, removed: false, archetype: null, layer: 'session', remaining: {}, count: 0 };
      writeLocalDialState(repoRoot, { dials: {}, shadows: state.shadows, legacyNote: null });
      return { cleared: null, removed: true, archetype: null, layer: 'session', remaining: {}, count };
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
    if (sessionCount > 0) writeLocalDialState(repoRoot, { dials: {}, shadows: state.shadows, legacyNote: null });
    if (userCount > 0) writeUserDials(opts.userPathOptions ?? {}, {});
    return { cleared: null, removed: true, archetype: null, layer: null, remaining: {}, count, cleared_layers: { session: sessionCount, user: userCount }, repo_pins_remaining: repoPins };
  }

  // Single archetype clear
  if (opts.session) {
    const state = readLocalDialState(repoRoot);
    if (!Object.hasOwn(state.dials, archetype)) {
      return { cleared: null, removed: false, archetype, layer: 'session', remaining: state.dials };
    }
    const prev = state.dials[archetype]!;
    const nextDials = { ...state.dials };
    delete nextDials[archetype];
    writeLocalDialState(repoRoot, { dials: nextDials, shadows: state.shadows, legacyNote: null });
    return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'session', remaining: nextDials };
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
  const prev = state.dials[archetype]!;
  const nextDials = { ...state.dials };
  delete nextDials[archetype];
  writeLocalDialState(repoRoot, { dials: nextDials, shadows: state.shadows, legacyNote: null });
  return { cleared: formatDialRef(prev), removed: true, archetype, layer: 'session', remaining: nextDials };
}

// ---- Shadow ----
export interface DialShadowOptions extends DialCommonOptions {
  archetype: string;
  model: string;
  via?: string | null;
  rate?: number | string | null;
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
  driver: string;
  rate: number | null;
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
  if (modelInput.length === 0) throw new DialError('Usage: fadeno dial shadow <archetype> <model>[@effort] [--via <driver>] [--rate <n>]');
  let dial: DialRef;
  try {
    dial = buildDialRef(modelInput, opts.via?.trim() || undefined, `model "${modelInput}"`);
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
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  let compiled: CompiledDelivery;
  try {
    compiled = compileDialRef(dial, profile);
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DialError(err.message);
    throw err;
  }
  // Shadows are command deliveries only
  if (deliveryIsHost(compiled)) {
    throw new DialError(`shadow for "${archetype}" must be a command delivery — host shadows are not dispatchable`);
  }
  // Write posture / eligibility checks same as set
  const refString = formatDialRef(dial);
  if (compiled.spec.adapter === 'command') {
    const conflict = explainWriteConflict({ executor: refString, spec: compiled.spec }, archetype, profile);
    if (conflict != null) throw new DialError(conflict);
  }
  const eligibility = eligibilityFor(compiled.spec, archetype);
  if (eligibility === 'forbidden') {
    const conflict = explainEligibilityConflict({ executor: refString, spec: compiled.spec }, archetype);
    throw new DialError(conflict ?? `archetype "${archetype}" is forbidden on model "${compiled.model}"`);
  }
  // Probe with the same rules as `set`: silent skip for registered models on
  // a driver with no models_command; loud advisories otherwise.
  const notes: string[] = [];
  if (!compiled.registered) {
    notes.push(
      `note: ${compiled.model} is not in the model registry — routing via ${compiled.driver}, id passed verbatim ` +
        '(declare it under models: to set a home driver or standard effort)',
    );
  }
  const routeInfo = routeForDriver(profile, compiled.driver);
  const hasModelsCommand = routeInfo?.hasModelsCommand ?? false;
  if (!compiled.registered && !hasModelsCommand) {
    notes.push(`note: cannot verify ${compiled.modelId} on ${compiled.driver} (no models_command declared) — attaching unverified`);
  } else if (hasModelsCommand) {
    const probe = probeModel(profile, compiled.driver, compiled.modelId, { spawn: opts.spawn, userPathOptions: opts.userPathOptions });
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
    if (unroutable != null) notes.push(unroutable);
  }
  const previous = state.shadows[archetype] ?? null;
  const nextShadows: Record<string, ShadowAttachment> = { ...state.shadows, [archetype]: rate == null ? { model: dial.model, ...(dial.effort ? { effort: dial.effort } : {}), ...(dial.via ? { via: dial.via } : {}) } : { model: dial.model, ...(dial.effort ? { effort: dial.effort } : {}), ...(dial.via ? { via: dial.via } : {}), rate } };
  const path = writeLocalDialState(repoRoot, { dials: state.dials, shadows: nextShadows, legacyNote: null });
  const shadow_attachments: Record<string, ShadowAttachmentView> = {};
  for (const [key, att] of Object.entries(nextShadows)) {
    // Compile to get model id/driver for view? Use att's dial compile if possible
    try {
      const d: DialRef = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}) };
      const c = compileDialRef(d, profile);
      shadow_attachments[key] = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}), ...(att.rate != null ? { rate: att.rate } : {}), adapter: c.spec.adapter, driver: c.driver };
    } catch {
      shadow_attachments[key] = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}), ...(att.rate != null ? { rate: att.rate } : {}) };
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
    driver: compiled.driver,
    rate: rate ?? null,
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
    const newPath = writeLocalDialState(repoRoot, { dials: state.dials, shadows: {}, legacyNote: null });
    return { archetype: null, cleared: null, removed: true, count, shadows: {}, shadow_attachments: {}, path: newPath };
  }
  if (!Object.hasOwn(state.shadows, archetype)) {
    throw new DialError(`no shadow attachment for "${archetype}" to clear (.fadeno/local/dials)`);
  }
  const cleared = state.shadows[archetype]!;
  const nextShadows = { ...state.shadows };
  delete nextShadows[archetype];
  const newPath = writeLocalDialState(repoRoot, { dials: state.dials, shadows: nextShadows, legacyNote: null });
  const shadow_attachments: Record<string, ShadowAttachmentView> = {};
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  for (const [key, att] of Object.entries(nextShadows)) {
    try {
      const d: DialRef = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}) };
      const c = compileDialRef(d, layered.profile);
      shadow_attachments[key] = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}), ...(att.rate != null ? { rate: att.rate } : {}), adapter: c.spec.adapter, driver: c.driver };
    } catch {
      shadow_attachments[key] = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}), ...(att.rate != null ? { rate: att.rate } : {}) };
    }
  }
  return { archetype, cleared, removed: true, count: 1, shadows: nextShadows, shadow_attachments, path: newPath };
}

// ---- Show (effective table) ----
export function runDialShow(opts: DialCommonOptions = {}): DialShowResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const harness = profile.harness ?? 'standalone';
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
      const d: DialRef = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}) };
      const c = compileDialRef(d, profile);
      shadow_attachments[arch] = { model: att.model, ...(att.effort ? { effort: att.effort } : {}), ...(att.via ? { via: att.via } : {}), ...(att.rate != null ? { rate: att.rate } : {}), adapter: c.spec.adapter, driver: c.driver };
    } catch {
      // stale driver etc -> mark stale
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
      compiled = compileDialRef(cascade.ref, profile);
    } catch {
      // Unknown driver etc -> stale dial
      staleDials.push({ archetype, target: formatDialRef(cascade.ref) });
      continue;
    }
    const adapter = compiled.spec.adapter;
    const postured = applyWritePosture(compiled.spec, archetype, profile.archetypes);
    const writePostureForced = forcesWritePosture(cascade.ref, cascade.resolvedVia);
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
      driver: compiled.driver,
      source: cascade.source,
      resolvedVia: cascade.resolvedVia,
      dial: cascade.ref,
      refString: compiled.refString,
      adapter,
      ...(postured.usedWriteVariant ? { write_variant: true } : {}),
      ...(writePostureForced ? { write_posture_forced: true } : {}),
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
    suppressed_canon_archetypes,
    note,
    harness,
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
  driver: string;
  adapter: 'command' | 'host';
  harness: string;
  source: RoleResolutionSource;
  resolved_via?: string;
  /** True when the write-requiring archetype gets the route's write variant. */
  write_variant?: boolean;
  write_posture_forced?: boolean;
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
   * `routable` is independent of the roll: it says whether the PRIMARY's
   * resolved spec can take the command lane at all (a command adapter, or a
   * host adapter with a `fallback_command`). It is exactly the condition the
   * kernel's `pairCommandFallback` tests at dispatch time, computed here so
   * the two agree by construction. A caller must force command delivery only
   * when `selected && routable` — a selected-but-unroutable pair degrades to
   * no pair, never to a dispatch the kernel would refuse.
   */
  shadow?: {
    attached: true;
    challenger: string;
    rate: number | null;
    selected: boolean | null;
    routable: boolean;
  };
}

/**
 * The dispatch advice this resolution hands its reader.
 *
 * `conflict` is the kernel's OWN write-posture refusal for this delivery,
 * computed by the caller and passed in — not re-derived here. A lane that
 * exists is not a lane that can do the work: an effort-pinned host dial
 * (`worker sonnet@medium`) leaves the session for its route's
 * `fallback_command`, and that lane is `write_access: false` with no
 * `write_variant` available to a host route. `commandRoutable` alone says
 * true there, so advising a dispatch on it would tell the reader to run a
 * command that this same binary refuses — the guidance and the kernel must
 * answer from one predicate, not two that agree only by coincidence.
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
      `command lane: \`fadeno dial ${archetype} ${executorName} --via <driver>\`.`,
  };
}

export function runDialResolve(opts: DialCommonOptions & { archetype: string; promptSha256?: string | null }): DialResolveResult {
  const repoRoot = repoRootOf(opts);
  const layered = loadLayered(repoRoot, opts.userPathOptions);
  const profile = layered.profile;
  const harness = profile.harness ?? 'standalone';
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
  const postured = applyWritePosture(resolved.delivery.spec, archetype, profile.archetypes);
  const spec = postured.spec;
  const eligibility = eligibilityFor(spec, archetype);

  // The pair decision. Re-derived rather than remembered: the same roll runs
  // again inside `fadeno dispatch`, so a caller that routes on `selected` and
  // the kernel that later fires the challenger cannot disagree.
  const attachment = dialState.shadows[archetype];
  let shadow: DialResolveResult['shadow'];
  if (attachment != null) {
    const challenger = formatDialRef({
      model: attachment.model,
      ...(attachment.effort ? { effort: attachment.effort } : {}),
      ...(attachment.via ? { via: attachment.via } : {}),
    });
    const digest = opts.promptSha256?.trim();
    const rate = attachment.rate ?? null;
    shadow = {
      attached: true,
      challenger,
      rate,
      // No rate means every dispatch fires; no digest means the caller cannot
      // be told, and must not read the silence as a "no".
      selected: rate == null ? true : digest ? shadowSampleRoll(digest, archetype, challenger) < rate : null,
      // The PRIMARY's own resolved spec — `spec` above, after write-posture —
      // not the challenger's. This is what a selected pair would have to
      // reuse to reach the command lane, and that lane must also satisfy the
      // archetype's write posture, not merely exist.
      routable: explainPairRoutability(spec, resolved.delivery.refString, archetype, profile).routable,
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
      return resolveRelay(profile, harness);
    } catch (err) {
      if (err instanceof ExecutorProfileError) {
        throw new DialError(`relay.${harness}: ${err.message}`);
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
      hostModel: deliveryIsHost(resolved.delivery),
      commandLane: commandRoutable(spec),
    }),
    driver: resolved.delivery.driver,
    adapter: spec.adapter,
    harness,
    source: resolved.source,
    ...(resolved.resolvedVia != null ? { resolved_via: resolved.resolvedVia } : {}),
    ...(postured.usedWriteVariant ? { write_variant: true } : {}),
    ...(forcesWritePosture(resolved.delivery.ref, resolved.resolvedVia) ? { write_posture_forced: true } : {}),
    ...(eligibility !== 'eligible' ? { eligibility } : {}),
    dial: resolved.delivery.ref,
    delivery: deliveryGuidance(
      archetype,
      resolved.delivery.refString,
      spec,
      // Same guard the kernel and `steering resolve` apply: a dial set with
      // `--force` has already overridden this posture on purpose, and
      // re-asserting it here would refuse what the user explicitly forced.
      forcesWritePosture(resolved.delivery.ref, resolved.resolvedVia)
        ? null
        : explainWriteConflict({ executor: resolved.delivery.refString, spec }, archetype, profile),
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
  const via = shadow.via ? ` via ${shadow.via}` : '';
  const effort = shadow.effort ? ` @ ${shadow.effort}` : '';
  const model = `${shadow.model}${effort}${via}`;
  const rate = shadow.rate != null ? ` rate ${shadow.rate}` : '';
  const transport = shadow.adapter != null ? ` [${shadow.adapter}]` : '';
  return `${baseIndent}  ~ shadow: ${model}${transport}${rate}`;
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
      const compiled = compileDialRef(parseDialRef(refString, `dial "${refString}"`), profile);
      const hostModel = deliveryIsHost(compiled);
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
      // A delivery that was never a host candidate is suppressed for DISPLAY
      // only — the decision above is still the resolver's. A command executor
      // leaves the session because of its model, which the reader can already
      // see on the same line; annotating it with an effort-shaped label would
      // misattribute the cause. This is a rendering filter, never a second
      // predicate: nothing here can turn an off-host answer into a host one.
      return decision.lane === 'host' || !hostModel ? null : decision;
    } catch {
      return null;
    }
  });
}

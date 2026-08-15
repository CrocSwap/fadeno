import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadLayeredProfile, type LayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  BARE_IDENTIFIER_RE,
  compileDialRef,
  deliveryIsHost,
  dispatchability,
  eligibilityFor,
  ExecutorProfileError,
  explainEligibilityConflict,
  explainWriteConflict,
  formatDialRef,
  parseDialRef,
  readLocalDialState,
  resolveDialCascade,
  resolveRole,
  writeLocalDialState,
  type DialRef,
  type ExecutorProfile,
  type ExecutorSpec,
  type ShadowAttachment,
  type RoleResolutionSource,
  type CompiledDelivery,
} from '../lib/executors.ts';
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
  effort: string;
  driver: string;
  delivery: string;
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
  effort: string;
  driver: string;
  delivery: string;
  layer: 'session' | 'repo' | 'user';
  adaptive: boolean;
  repo_pinned: DialRef | null;
  previous: { layer: 'session' | 'repo' | 'user'; dial: DialRef } | null;
  verification: VerificationStatus;
  narrative: string;
  /** Loud advisories (unregistered fall-through, probe fail-open) for the CLI to print. */
  notes: string[];
}

export function runDialSet(opts: DialSetOptions): DialSetResult {
  const repoRoot = repoRootOf(opts);
  if (opts.user && opts.repo) throw new DialError('--user and --repo are mutually exclusive.');
  const archetype = opts.archetype.trim();
  if (archetype === 'set' || archetype === 'clear' || archetype === 'shadow' || archetype === 'clear-shadow' || archetype === 'resolve') {
    throw new DialError(`archetype "${archetype}" is a reserved word — rename the archetype`);
  }
  if (!BARE_IDENTIFIER_RE.test(archetype)) {
    throw new DialError(`archetype "${archetype}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
  }
  const modelInput = opts.model.trim();
  if (modelInput.length === 0) throw new DialError('Usage: fadeno dial <archetype> <model>[@effort] [--via <driver>] [--user|--repo]');
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
  // a. @effort on host delivery
  if (dial.effort != null && deliveryIsHost(compiled)) {
    throw new DialError('native delivery cannot pin reasoning effort (the host controls it). Dial a command-delivered model to control effort.');
  }
  // b. Write posture and eligibility. Host deliveries are exempt from the
  // write check: the in-session agent's permissions are the host's business,
  // and a host spec's write_access describes only its command fallback.
  if (compiled.spec.adapter === 'command') {
    const conflict = explainWriteConflict({ executor: refString, spec: compiled.spec }, archetype, profile);
    if (conflict != null) throw new DialError(conflict);
  }
  const eligibilityConflict = explainEligibilityConflict({ executor: refString, spec: compiled.spec }, archetype);
  if (eligibilityConflict != null) throw new DialError(eligibilityConflict);

  // c. Verification probe
  let verification: VerificationStatus = null;
  let probeNote: string | null = null;
  const notes: string[] = [];
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
  const repoPinned = Object.hasOwn(profile.dials, archetype) ? profile.dials[archetype]! : null;
  let layer: 'session' | 'repo' | 'user';
  let adaptive = false;
  if (opts.user) layer = 'user';
  else if (opts.repo) layer = 'repo';
  else {
    if (repoPinned != null) {
      layer = 'session';
      adaptive = true;
    } else {
      layer = 'user';
      adaptive = false;
    }
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

  // Narrative + delivery string
  const delivery = deliveryIsHost(compiled) ? 'in-session (host)' : `${compiled.driver} (command)`;
  let narrative = '';
  const modelDisplay = refString;
  if (layer === 'user') {
    narrative = `${archetype} → ${modelDisplay}  [user default — applies across your repos]`;
  } else if (layer === 'session') {
    if (adaptive && repoPinned != null) {
      const repoStr = formatDialRef(repoPinned);
      narrative = `${archetype} → ${modelDisplay}  [this repo only, sticky until cleared — ${archetype} is repo-pinned to ${repoStr} here; --user sets your global default, which this repo will keep overriding]`;
    } else {
      narrative = `${archetype} → ${modelDisplay}  [this repo only, sticky until cleared]`;
    }
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
    doc.setIn(['dials', archetype], refString);
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
    effort: compiled.effort,
    driver: compiled.driver,
    delivery,
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
  /** Where the dial actually lives when a session clear found nothing (never cleared adaptively). */
  livesAt?: 'repo' | 'user' | null;
}

export function runDialClear(opts: DialClearOptions = {}): DialClearResult {
  const repoRoot = repoRootOf(opts);
  if (opts.user && opts.repo) throw new DialError('--user and --repo are mutually exclusive.');
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
    if (opts.user) {
      const userDials = readUserDials(opts.userPathOptions);
      const count = Object.keys(userDials).length;
      if (count === 0) return { cleared: null, removed: false, archetype: null, layer: 'user', remaining: {} , count: 0};
      writeUserDials(opts.userPathOptions ?? {}, {});
      return { cleared: null, removed: true, archetype: null, layer: 'user', remaining: {}, count };
    }
    // default: clear ALL session dials, preserve shadows
    const state = readLocalDialState(repoRoot);
    const count = Object.keys(state.dials).length;
    if (count === 0) return { cleared: null, removed: false, archetype: null, layer: 'session', remaining: {}, count: 0 };
    // Preserve shadows
    writeLocalDialState(repoRoot, { dials: {}, shadows: state.shadows, legacyNote: null });
    return { cleared: null, removed: true, archetype: null, layer: 'session', remaining: {}, count };
  }

  // Single archetype clear
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
  // Default session clear (never adaptive downward): when the session holds
  // no dial, report where one lives instead of reaching into another layer.
  const state = readLocalDialState(repoRoot);
  if (!Object.hasOwn(state.dials, archetype)) {
    const layered = loadLayered(repoRoot, opts.userPathOptions);
    const userDials = readUserDials(opts.userPathOptions);
    const livesAt = Object.hasOwn(layered.profile.dials, archetype)
      ? ('repo' as const)
      : Object.hasOwn(userDials, archetype)
        ? ('user' as const)
        : null;
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
  effort: string;
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
    effort: compiled.effort,
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
  const archetypesSet = new Set<string>(['worker', 'reviewer', 'judge']);
  for (const k of Object.keys(profile.archetypes)) archetypesSet.add(k);
  for (const k of Object.keys(sessionDials)) archetypesSet.add(k);
  for (const k of Object.keys(repoDials)) archetypesSet.add(k);
  for (const k of Object.keys(userDials)) archetypesSet.add(k);
  for (const k of Object.keys(shadows)) archetypesSet.add(k);
  // Also include bindings keys that are archetype-like? bindings are role->dial, but effective table is per archetype
  // Include binding archetypes? Not needed.

  const allArchetypes = [...archetypesSet].sort();

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
    const delivery = adapter === 'host' ? 'in-session (host)' : `${compiled.driver} (command)`;
    const effort = adapter === 'host' ? 'inherit' : compiled.effort;
    // Determine model display: canonical name + @effort only when off standard
    // Need registry standard effort
    let modelDisplay = compiled.model;
    const entry = (profile.models as Record<string, { effort: string }>)[compiled.model];
    const standard = entry?.effort ?? 'default';
    if (compiled.effort !== standard && compiled.effort !== 'inherit' && compiled.model !== 'current-host') {
      modelDisplay = `${compiled.model} @ ${compiled.effort}`;
    } else if (compiled.model === 'current-host') {
      modelDisplay = 'current-host';
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
      driver: compiled.driver,
      delivery: cascade.resolvedVia != null ? `${compiled.driver} (via fallback)` : delivery,
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
    suppressed_canon_archetypes,
    note,
    harness,
    legacyPinNote: legacy_pin_note,
  };
}

// ---- Resolve ----
export interface DialResolveResult {
  archetype: string;
  executor: string;
  model: string;
  model_id: string;
  effort: string;
  driver: string;
  adapter: 'command' | 'host';
  harness: string;
  source: RoleResolutionSource;
  resolved_via?: string;
  eligibility?: string;
  dial: DialRef;
  delivery: { dispatchable: boolean; dispatch_command: string | null; action: string };
}

function deliveryGuidance(archetype: string, executorName: string, spec: ExecutorSpec, harness: string): DialResolveResult['delivery'] {
  const deliverable = dispatchability(spec, harness);
  if (deliverable.supported) {
    return {
      dispatchable: true,
      dispatch_command: `fadeno dispatch --archetype ${archetype}`,
      action: `Dispatch it: \`fadeno dispatch --archetype ${archetype}\` with the task prompt on stdin. Executor "${executorName}" runs outside this harness.`,
    };
  }
  return {
    dispatchable: false,
    dispatch_command: null,
    action: deliverable.reason === 'host_in_session'
      ? `Do NOT dispatch. Host executor "${executorName}" is delivered in-session by the ${harness} harness — spawn the in-session ${archetype} agent instead. Dispatching would hand the task to a subprocess of this same harness and be refused.`
      : `Do NOT dispatch. Host executor "${executorName}" declares no fallback_command, so ad-hoc dispatch has nothing to invoke — spawn the in-session ${archetype} agent instead.`,
  };
}

export function runDialResolve(opts: DialCommonOptions & { archetype: string }): DialResolveResult {
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
  const eligibility = eligibilityFor(resolved.delivery.spec, archetype);
  return {
    archetype,
    executor: resolved.delivery.refString,
    model: resolved.delivery.model,
    model_id: resolved.delivery.modelId,
    effort: resolved.delivery.spec.adapter === 'host' ? 'inherited' : resolved.delivery.effort,
    driver: resolved.delivery.driver,
    adapter: resolved.delivery.spec.adapter,
    harness,
    source: resolved.source,
    ...(resolved.resolvedVia != null ? { resolved_via: resolved.resolvedVia } : {}),
    ...(eligibility !== 'eligible' ? { eligibility } : {}),
    dial: resolved.delivery.ref,
    delivery: deliveryGuidance(archetype, resolved.delivery.refString, resolved.delivery.spec, harness),
  };
}

export function formatShadowLine(shadow: ShadowAttachmentView, baseIndent: string): string {
  const via = shadow.via ? ` via ${shadow.via}` : '';
  const effort = shadow.effort ? ` @ ${shadow.effort}` : '';
  const model = `${shadow.model}${effort}${via}`;
  const rate = shadow.rate != null ? ` rate ${shadow.rate}` : '';
  const transport = shadow.adapter != null ? ` [${shadow.adapter}]` : '';
  return `${baseIndent}  ~ shadow: ${model}${transport}${rate}`;
}

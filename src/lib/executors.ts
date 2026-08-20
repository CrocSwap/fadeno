import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadLayeredProfile, type ProfileProvenance } from './config-layers.ts';
import { readUserHarness, type FadenoHarness, type UserPathOptions } from './user-paths.ts';

export class ExecutorProfileError extends Error {}

/** Bare lowercase identifier: dial targets, archetype keys, role archetypes. */
// schema_version: 3 — dial world only (pre-dials catalogs refused)
export const BARE_IDENTIFIER_RE = /^[a-z][a-z0-9_-]*$/;

/** Per-target, per-archetype dispatch eligibility. Absent YAML is `eligible`. */
export type EligibilityState = 'eligible' | 'shadow_only' | 'forbidden';

/**
 * The minimal execution profile of the next protocol: named executors (each a
 * one-shot command adapter) plus direct role→executor bindings. No capability
 * routing, ranking, stickiness, or fallback — if a bound executor fails, the
 * run pauses and the user substitutes explicitly.
 */
export interface CommandExecutorSpec {
  adapter: 'command';
  command: string[];
  /** Hard deadline in milliseconds; null when absent (no deadline). */
  timeoutMs?: number | null;
  /** Optional metadata recorded in dispatch evidence; never alters `command`. */
  model: string | null;
  /**
   * Optional session-resume argv (must contain `{session_id}`). Declaring it
   * makes the executor **session-capable**: the engine reuses one harness
   * session per role per run. Resumed context is attested evidence — the
   * ledger records the session id, but cannot recompute what the session
   * already contained. Bias toward memoryless executors when not needed.
   */
  resume: string[] | null;
  /**
   * How a fresh call's session id is learned when the harness assigns it:
   * a regex with one capture group, matched against stderr then stdout.
   * Mutually exclusive with a `{session_id}` placeholder in `command`
   * (engine-minted id).
   */
  sessionIdPattern: string | null;
  /**
   * Whether this delivery's command can mutate the workspace. `null` =
   * undeclared (no constraint). A headless CLI in a read-only permission mode
   * is `false`: it can read and reason, but a `git commit`/Bash write ends in
   * refusal, so a mutating archetype must not be dispatched onto it.
   */
  writeAccess: boolean | null;
  /**
   * Alternative write-capable argv for this same delivery, selected
   * automatically when a `requires_write: required` archetype resolves here.
   * The dial names the who; the archetype's declared policy picks this how —
   * no capability-suffixed model spellings. A variant that declares no
   * `resume` does not advertise session resumption (the base route's resume
   * argv carries the base permission mode, which a write session must not
   * inherit).
   */
  writeVariant?: { command: string[]; resume: string[] | null } | null;
  /**
   * Per-archetype eligibility of this delivery. Absent YAML is `{}`
   * (every archetype `eligible`).
   */
  eligibility: Record<string, EligibilityState>;
  /** Neutral v2 target metadata; absent for legacy v1 executors. */
  target?: string;
  provider?: string;
  /** v3 compiled delivery driver alias (for snapshot passthrough). */
  driver?: string;
}

/** A host facility invoked outside the command adapter. */
export interface HostExecutorSpec {
  adapter: 'host';
  /** Requested host model identifier; not proof of the host's runtime model. */
  model: string;
  /** Requested reasoning effort/profile. */
  reasoningEffort: string;
  /** Requested host agent type/identity class. */
  agentType: string;
  /**
   * Optional one-shot transport for this same requested model identity when
   * the current host session has a different host baseline. This is an
   * explicit delivery fallback, never an executor/provider substitution.
   */
  fallbackCommand?: string[] | null;
  /**
   * Write capability of the **command delivery** (`fallbackCommand`), not of
   * the host facility — the in-session agent's permissions are the host's
   * business. `null` = undeclared.
   */
  writeAccess: boolean | null;
  /**
   * Per-archetype eligibility of this delivery. Absent YAML is `{}`
   * (every archetype `eligible`).
   */
  eligibility: Record<string, EligibilityState>;
  /** Neutral v2 target metadata; absent for legacy v1 executors. */
  target?: string;
  provider?: string;
  driver?: string;
}

export type ExecutorSpec = CommandExecutorSpec | HostExecutorSpec;

/** Placeholder substituted into command/resume argv. */
/**
 * Deterministic shadow sampling roll, in [0, 1).
 *
 * Keyed on what is being compared rather than on chance, for two reasons.
 * A retried spawn — same task, same prompt — must not fire a challenger the
 * first attempt did not, or a retry loop silently multiplies challengers. And
 * because the roll is a pure function of (prompt, archetype, challenger), two
 * different processes reach the same verdict without passing state: the
 * steering hook can decide whether a spawn is a pair *before* routing it, and
 * the kernel independently re-derives the same answer at dispatch time.
 * Re-attaching a different challenger re-rolls.
 */
export function shadowSampleRoll(promptSha256: string, archetype: string, challenger: string): number {
  const digest = createHash('sha256').update(`${promptSha256}:${archetype}:${challenger}`).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
}

export const SESSION_ID_PLACEHOLDER = '{session_id}';

export function substituteSessionId(argv: string[], sessionId: string): string[] {
  return argv.map((part) => part.split(SESSION_ID_PLACEHOLDER).join(sessionId));
}

/**
 * Placeholder for drivers that can only read a prompt from a regular file
 * (Muse Code refuses /dev/stdin, bare stdin, and `-` — verified live
 * 2026-08-16). Substituted at spawn time with the absolute path of the
 * kernel's attested prompt snapshot, so the digest attests exactly the bytes
 * the executor reads. Stdin is still piped alongside; file-reading drivers
 * simply ignore it.
 */
export const PROMPT_FILE_PLACEHOLDER = '{prompt_file}';

export function substitutePromptFile(argv: string[], promptPath: string): string[] {
  return argv.map((part) => part.split(PROMPT_FILE_PLACEHOLDER).join(promptPath));
}

/**
 * Canon archetype display order — most→least powerful model typically slotted
 * into the role. Non-canon archetypes sort alphabetically after.
 */
export const ARCHETYPE_DISPLAY_ORDER = ['director', 'judge', 'reviewer', 'generator', 'worker'] as const;

export function archetypeDisplaySort(names: Iterable<string>): string[] {
  const rank = new Map<string, number>(ARCHETYPE_DISPLAY_ORDER.map((name, index) => [name, index]));
  return [...names].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

/** Write constraint an archetype imposes on whatever delivers it. */
export type WritePosture = 'required' | 'forbidden' | 'none';

/** Whether an archetype's delivery provider must differ from every input producer. */
export type ProviderDistinctness = 'advisory' | 'required';

/**
 * What an archetype needs from whatever delivers it. Declared once per
 * archetype, independent of which executor a dial binds today.
 * `fallback` selects another archetype's *binding* only — never its policy.
 */
export interface ArchetypePolicy {
  /** The archetype's write constraint. Absent YAML is `'none'`. */
  requiresWrite: WritePosture;
  /** Next archetype in the binding-fallback chain, or null. */
  fallback: string | null;
  /**
   * Name of a brief template composed in front of every ad-hoc dispatch of
   * this archetype (resolved from .fadeno/briefs/<name>.md, then the builtin
   * templates). How a director learns it should coordinate through fadeno.
   */
  brief: string | null;
  /**
   * Whether this archetype's delivery provider must differ from every
   * input producer's. Absent YAML is `null` (no check).
   */
  distinctProviderFromInputs: ProviderDistinctness | null;
}

// --- Dial / model registry types ---

export interface DialRef {
  model: string;
  effort?: string;
  via?: string;
  /** Explicit, persisted override for this binding's write-posture mismatch. */
  force_write_posture?: true;
}

export function parseDialRef(raw: unknown, label: string): DialRef {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ExecutorProfileError(`${label} is an empty string — expected "model" or "model@effort".`);
    }
    let via: string | undefined;
    let core = trimmed;
    const viaIdx = trimmed.indexOf(' via ');
    if (viaIdx >= 0) {
      core = trimmed.slice(0, viaIdx).trim();
      via = trimmed.slice(viaIdx + 5).trim();
      if (via.length === 0) {
        throw new ExecutorProfileError(`${label} has empty via after " via ".`);
      }
      if (!BARE_IDENTIFIER_RE.test(via) && /\s/.test(via)) {
        throw new ExecutorProfileError(`${label} via "${via}" is not a bare identifier.`);
      }
    }
    const atIdx = core.indexOf('@');
    if (atIdx >= 0) {
      const model = core.slice(0, atIdx).trim();
      const effort = core.slice(atIdx + 1).trim();
      if (model.length === 0 || effort.length === 0) {
        throw new ExecutorProfileError(`${label} "${raw}" is not a valid dial ref "model[@effort]".`);
      }
      if (model.includes('@') || model.includes(' ')) {
        throw new ExecutorProfileError(`${label} "${raw}" is not a valid dial ref.`);
      }
      if (effort.includes('@') || effort.includes(' ')) {
        throw new ExecutorProfileError(`${label} "${raw}" has invalid effort "${effort}".`);
      }
      const out: DialRef = { model };
      if (effort) out.effort = effort;
      if (via) out.via = via;
      return out;
    }
    if (core.includes(' ') || core.includes('@')) {
      throw new ExecutorProfileError(`${label} "${raw}" is not a valid dial ref.`);
    }
    const out: DialRef = { model: core };
    if (via) out.via = via;
    return out;
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>;
    const model = map.model;
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new ExecutorProfileError(`${label} mapping needs a non-empty "model" string.`);
    }
    const trimmedModel = model.trim();
    if (trimmedModel.includes('@') || trimmedModel.includes(' ') || trimmedModel.includes('  ')) {
      if (trimmedModel.includes(' ')) {
        throw new ExecutorProfileError(`${label} model "${trimmedModel}" contains whitespace.`);
      }
    }
    const out: DialRef = { model: trimmedModel };
    if (map.effort !== undefined) {
      if (typeof map.effort !== 'string' || map.effort.trim().length === 0) {
        throw new ExecutorProfileError(`${label} "effort" must be a non-empty string.`);
      }
      const eff = map.effort.trim();
      if (eff.includes('@') || eff.includes(' ')) {
        throw new ExecutorProfileError(`${label} effort "${eff}" is invalid.`);
      }
      out.effort = eff;
    }
    if (map.via !== undefined) {
      if (typeof map.via !== 'string' || map.via.trim().length === 0) {
        throw new ExecutorProfileError(`${label} "via" must be a non-empty string.`);
      }
      out.via = map.via.trim();
    }
    if (map.force_write_posture !== undefined) {
      if (map.force_write_posture !== true) {
        throw new ExecutorProfileError(`${label} "force_write_posture" must be true when present.`);
      }
      out.force_write_posture = true;
    }
    const unknown = Object.keys(map).filter((k) => k !== 'model' && k !== 'effort' && k !== 'via' && k !== 'force_write_posture');
    if (unknown.length > 0) {
      throw new ExecutorProfileError(`${label} has unknown key(s) ${unknown.join(', ')}; only model, effort, via, force_write_posture are allowed.`);
    }
    return out;
  }
  throw new ExecutorProfileError(`${label} must be a string "model[@effort]" or a mapping {model, effort?, via?, force_write_posture?}.`);
}

export function formatDialRef(ref: DialRef): string {
  let base = ref.model;
  if (ref.effort != null && ref.effort.length > 0) base += `@${ref.effort}`;
  if (ref.via != null && ref.via.length > 0) base += ` via ${ref.via}`;
  return base;
}

/** Compact scalars remain the normal storage form; forced refs stay explicit. */
export function serializeDialRef(ref: DialRef): string | Record<string, unknown> {
  if (ref.force_write_posture !== true) return formatDialRef(ref);
  return {
    model: ref.model,
    ...(ref.effort != null ? { effort: ref.effort } : {}),
    ...(ref.via != null ? { via: ref.via } : {}),
    force_write_posture: true,
  };
}

/** A force marker is scoped to the archetype dial that owns it, not a fallback. */
export function forcesWritePosture(ref: DialRef, resolvedVia: string | null): boolean {
  return ref.force_write_posture === true && resolvedVia == null;
}

export interface ModelEntry {
  provider: string;
  id: string;
  effort: string;
  spellings: Record<string, string>;
  eligibility: Record<string, EligibilityState>;
}

export interface RouteRaw {
  driver?: string;
  models_command?: string[] | null;
  effort_encoding?: 'flag' | 'model-suffix';
  command?: string[] | null;
  write_access?: boolean | null;
  timeout_ms?: number | null;
  /**
   * Write-capable argv variant of this route, applied when a
   * `requires_write: required` archetype resolves onto it. Only meaningful on
   * a route declared `write_access: false` — a variant exists to escalate a
   * read-only delivery, nothing else.
   */
  write_variant?: { command: string[]; resume?: string[] | null } | null;
  host?: boolean;
  resume?: string[] | null;
  session_id_pattern?: string | null;
  /**
   * Per-archetype eligibility of every delivery through this route, merged
   * with model-level eligibility (strictest wins). This is how a catalog says
   * "this lane cannot host a director": the constraint is structural — it
   * covers unregistered models falling through to this route too.
   */
  eligibility?: Record<string, EligibilityState>;
}

export interface CompiledDelivery {
  ref: DialRef;
  refString: string;
  spec: ExecutorSpec;
  model: string;
  modelId: string;
  /**
   * The effort the *user* pinned on the dial (`opus@xhigh` → `'xhigh'`), or
   * `null` when the dial stated no opinion (`opus`). Exactly
   * `ref.effort ?? null` — no registry default ever fills it in.
   *
   * This is the only field that answers "did anyone ask for a specific
   * effort?" — every model in the shipped catalog declares a registry
   * default, so `effectiveEffort` is non-null for essentially every dial and
   * cannot distinguish an opinion from a default. Predicates keying on user
   * intent (e.g. which lane a delivery goes out on) must read this one.
   */
  pinnedEffort: string | null;
  /**
   * The effort this delivery actually runs at: the pin when there is one,
   * otherwise the registry's declared default for the model
   * (`models.<name>.effort`), otherwise `'default'` for an unregistered
   * model. This is what gets substituted into `{reasoning_effort}`, encoded
   * into a `model-suffix` model id, and recorded on evidence rows.
   */
  effectiveEffort: string;
  provider: string | null;
  driver: string;
  registered: boolean;
}

export function deliveryIsHost(compiled: CompiledDelivery): boolean {
  return compiled.spec.adapter === 'host';
}

export interface ToolSpec {
  command: string[];
  timeoutMs?: number | null;
}

export interface ExecutorProfile {
  models: Record<string, ModelEntry>;
  routes: Record<string, Record<string, RouteRaw>>;
  bindings: Record<string, DialRef>;
  dials: Record<string, DialRef>;
  archetypes: Record<string, ArchetypePolicy>;
  constraints: { command: string[] } | null;
  unregisteredModelDriver: string;
  harness?: HarnessId;
  schemaVersion?: 3;
  notes: string[];
  tools: Record<string, ToolSpec>;
  /**
   * Repo-relative paths carried into a shadow's or an isolated dispatch's
   * freshly-cut worktree (`git worktree add` checks out tracked content
   * only, so gitignored deps/build output/a local `.fadeno/` catalog never
   * cross into it otherwise). Project-only — see the enforcement comment in
   * `config-layers.ts`'s `mergeLayer`.
   */
  worktreeCarry: string[];
}

export type HarnessId = 'codex' | 'claude' | 'grok' | 'standalone';

export function activeHarness(explicit?: HarnessId, options: UserPathOptions = {}): HarnessId {
  if (explicit != null) return explicit;
  const raw = (options.env ?? process.env).FADENO_HARNESS?.trim();
  if (raw === 'codex' || raw === 'claude' || raw === 'grok' || raw === 'standalone') return raw;
  return detectAmbientHarness(options).harness ?? readUserHarness(options) ?? 'standalone';
}

const AMBIENT_HARNESS_MARKERS: ReadonlyArray<{ harness: FadenoHarness; variables: readonly string[] }> = [
  { harness: 'claude', variables: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] },
  { harness: 'codex', variables: ['CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_PERMISSION_PROFILE'] },
];

export interface AmbientHarness {
  harness: FadenoHarness;
  marker: string;
}

export interface AmbientHarnessDetection {
  harness: FadenoHarness | null;
  evidence: AmbientHarness[];
}

export function detectAmbientHarness(options: UserPathOptions = {}): AmbientHarnessDetection {
  const env = options.env ?? process.env;
  const evidence: AmbientHarness[] = [];
  for (const entry of AMBIENT_HARNESS_MARKERS) {
    const marker = entry.variables.find((name) => (env[name] ?? '').trim() !== '');
    if (marker != null) evidence.push({ harness: entry.harness, marker });
  }
  return { harness: evidence.length === 1 ? evidence[0]!.harness : null, evidence };
}

export function withoutHarnessIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.FADENO_HARNESS;
  delete next.FADENO_BUNDLED_RUNTIME;
  delete next.FADENO_INVOCATION_SOURCE;
  for (const entry of AMBIENT_HARNESS_MARKERS) {
    for (const name of entry.variables) delete next[name];
  }
  return next;
}

export function atCwd(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  return { ...env, PWD: cwd };
}

export interface LoadedExecutorProfile {
  profile: ExecutorProfile;
  path: string;
  layers?: Array<'builtin' | 'user' | 'project'>;
  selfContained?: boolean;
  provenance?: ProfileProvenance;
}

/** Repo-relative location of the profile (playbooks stay harness-neutral). */
export const EXECUTORS_FILE = join('.fadeno', 'executors.yaml');

/**
 * Every top-level key a v3 executor catalog may declare — the single source of
 * truth for BOTH the strict unknown-key check in `parseExecutorProfile` below
 * and the layered loader's selective merge (`mergeLayer`, config-layers.ts).
 *
 * These used to be two independent literal lists, which is precisely how a key
 * could be known to the parser yet dropped by the merge: `mergeLayer` copies
 * top-level keys by exact literal name, so a key it does not name never
 * survives layering, and a key it does not name is also never seen by the
 * check that would have complained. `worktree_carry` lived in that gap. One
 * list, consumed by both, is what keeps that from recurring: config-layers
 * copies whatever is listed here (whole-value unless it declares an entry-wise
 * merge shape for the key), and rejects anything that is not.
 */
export const CATALOG_TOP_LEVEL_KEYS = [
  'schema_version',
  'models',
  'routes',
  'bindings',
  'dials',
  'archetypes',
  'constraints',
  'unregistered_model_driver',
  'tools',
  'worktree_carry',
] as const;

export type CatalogTopLevelKey = (typeof CATALOG_TOP_LEVEL_KEYS)[number];

/**
 * Pre-dials (schema_version < 3) top-level keys. Not allowed, but not
 * "unknown" either: they are recognized purely so a legacy catalog keeps
 * getting the migration instructions instead of a did-you-mean guess.
 */
export const PRE_DIALS_CATALOG_KEYS = ['executors', 'targets', 'loadouts', 'default_loadout'] as const;

/** The one migration message a pre-dials catalog gets, wherever it is noticed. */
export function preDialsCatalogError(source: string): ExecutorProfileError {
  return new ExecutorProfileError(
    `${source}: schema_version 3 required — pre-dials catalogs are not supported; migrate: targets:→models:, loadouts:→dials:, default_loadout: delete; see docs/experimental/dials-and-registry.md`,
  );
}

/** Levenshtein distance, iterative two-row form. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Nearest catalog key to a misspelling, or `null` when nothing is close.
 *
 * A typo is the whole failure mode this guards, so the suggestion carries most
 * of the value — but only a NEAR miss earns one: at most two edits, and never
 * as many edits as the shorter of the two keys is long, so a two-character key
 * cannot be declared to "mean" `dials`. Guessing wildly reads as authoritative
 * and sends people down the wrong path; callers print the full known-key list
 * either way, so silence here still leaves a usable error. Case is folded
 * first, which makes `Worktree_Carry` a zero-distance hit rather than a miss.
 */
export function suggestCatalogKey(key: string): string | null {
  const probe = key.toLowerCase();
  let best: CatalogTopLevelKey | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of CATALOG_TOP_LEVEL_KEYS) {
    const distance = editDistance(probe, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best == null || bestDistance > 2) return null;
  if (bestDistance >= Math.min(probe.length, best.length)) return null;
  return best;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const WRITE_POSTURE_FORMS = 'true, false, "required", "forbidden", or "none"';

function isWritePosture(value: unknown): value is WritePosture {
  return value === 'required' || value === 'forbidden' || value === 'none';
}

/** Binding-chain successor. Undeclared names and non-string fallbacks are end-nodes. */
function nextArchetypeFallback(
  archetypes: Record<string, ArchetypePolicy>,
  name: string,
): string | null {
  if (!Object.hasOwn(archetypes, name)) return null;
  const next = archetypes[name]!.fallback;
  return typeof next === 'string' ? next : null;
}

/** Parse + structurally validate an executor profile document. */
export function parseExecutorProfile(text: string, source: string, harness: HarnessId = 'standalone'): ExecutorProfile {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ExecutorProfileError(`${source} did not parse: ${(err as Error).message}`);
  }
  if (!isMapping(doc)) {
    throw new ExecutorProfileError(`${source} is not a mapping.`);
  }
  // Strict v3 requirement — no backwards compat
  if (doc.schema_version !== 3) {
    throw preDialsCatalogError(source);
  }
  if (!isMapping(doc.models) || Object.keys(doc.models).length === 0) {
    throw preDialsCatalogError(source);
  }

  const notes: string[] = [];
  // models
  const models: Record<string, ModelEntry> = {};
  for (const [name, raw] of Object.entries(doc.models as Record<string, unknown>)) {
    if (!BARE_IDENTIFIER_RE.test(name) && name !== 'current-host') {
      if (!BARE_IDENTIFIER_RE.test(name)) {
        throw new ExecutorProfileError(`${source}: model name "${name}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      }
    }
    if (name === 'current-host') {
      throw new ExecutorProfileError(`${source}: model "current-host" is built-in.`);
    }
    if (!isMapping(raw)) {
      throw new ExecutorProfileError(`${source}: model "${name}" is not a mapping.`);
    }
    const provider = raw.provider;
    if (typeof provider !== 'string' || provider.trim().length === 0) {
      throw new ExecutorProfileError(`${source}: model "${name}" needs a non-empty \`provider\`.`);
    }
    const prov = provider.trim();
    const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : name;
    const effort = typeof raw.effort === 'string' && raw.effort.trim().length > 0 ? raw.effort.trim() : 'default';
    const spellings: Record<string, string> = {};
    if (raw.spellings !== undefined) {
      if (!isMapping(raw.spellings)) {
        throw new ExecutorProfileError(`${source}: model "${name}" \`spellings\` is not a mapping (driver → id).`);
      }
      for (const [driver, sid] of Object.entries(raw.spellings)) {
        if (typeof sid !== 'string' || sid.trim().length === 0) {
          throw new ExecutorProfileError(`${source}: model "${name}" spelling for driver "${driver}" must be a non-empty string.`);
        }
        spellings[driver] = sid.trim();
      }
    }
    const eligibility = readEligibility(raw as Record<string, unknown>, `model "${name}"`, source);
    const unknown = Object.keys(raw).filter((k) => !['provider', 'id', 'effort', 'spellings', 'eligibility'].includes(k));
    if (unknown.length > 0) {
      throw new ExecutorProfileError(`${source}: model "${name}" has unknown key(s) ${unknown.join(', ')}; only provider, id, effort, spellings, eligibility are allowed.`);
    }
    models[name] = { provider: prov, id, effort, spellings, eligibility };
  }
  models['current-host'] = { provider: 'current-host', id: 'current-host', effort: 'default', spellings: {}, eligibility: {} };

  // routes
  const routes: Record<string, Record<string, RouteRaw>> = {};
  if (doc.routes !== undefined) {
    if (!isMapping(doc.routes)) {
      throw new ExecutorProfileError(`${source} \`routes\` is not a mapping (harness → provider → route).`);
    }
    for (const [harnessKey, rawHarness] of Object.entries(doc.routes)) {
      if (!isMapping(rawHarness)) {
        throw new ExecutorProfileError(`${source}: routes.${harnessKey} is not a mapping.`);
      }
      const perHarness: Record<string, RouteRaw> = {};
      for (const [routeKey, rawRoute] of Object.entries(rawHarness)) {
        if (!isMapping(rawRoute)) {
          throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}\` is not a mapping.`);
        }
        const route: RouteRaw = {};
        if (rawRoute.driver !== undefined) {
          if (typeof rawRoute.driver !== 'string' || rawRoute.driver.trim().length === 0) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.driver\` must be a non-empty string.`);
          }
          route.driver = rawRoute.driver.trim();
        }
        if (rawRoute.models_command !== undefined) {
          const mc = rawRoute.models_command;
          if (!Array.isArray(mc) || mc.length === 0 || !mc.every((p) => typeof p === 'string' && p.length > 0)) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.models_command\` must be a non-empty string array.`);
          }
          route.models_command = mc as string[];
        }
        if (rawRoute.effort_encoding !== undefined) {
          if (rawRoute.effort_encoding !== 'flag' && rawRoute.effort_encoding !== 'model-suffix') {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.effort_encoding\` must be "flag" or "model-suffix".`);
          }
          route.effort_encoding = rawRoute.effort_encoding;
        }
        if (rawRoute.command !== undefined) {
          const cmd = rawRoute.command;
          if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((p) => typeof p === 'string' && p.length > 0)) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.command\` must be a non-empty string array.`);
          }
          route.command = cmd as string[];
        }
        if (rawRoute.write_access !== undefined) {
          if (typeof rawRoute.write_access !== 'boolean') {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.write_access\` must be boolean.`);
          }
          route.write_access = rawRoute.write_access;
        }
        if (rawRoute.write_variant !== undefined && rawRoute.write_variant !== null) {
          const label = `routes.${harnessKey}.${routeKey}.write_variant`;
          const rawVariant = rawRoute.write_variant;
          if (!isMapping(rawVariant)) {
            throw new ExecutorProfileError(`${source}: \`${label}\` must be a mapping with \`command\` (and optional \`resume\`).`);
          }
          const unknownVariantKeys = Object.keys(rawVariant).filter((k) => k !== 'command' && k !== 'resume');
          if (unknownVariantKeys.length > 0) {
            throw new ExecutorProfileError(`${source}: \`${label}\` has unknown key(s) ${unknownVariantKeys.join(', ')}; only \`command\` and \`resume\` are allowed.`);
          }
          const vcmd = rawVariant.command;
          if (!Array.isArray(vcmd) || vcmd.length === 0 || !vcmd.every((p) => typeof p === 'string' && p.length > 0)) {
            throw new ExecutorProfileError(`${source}: \`${label}.command\` must be a non-empty string array.`);
          }
          const variant: { command: string[]; resume?: string[] | null } = { command: vcmd as string[] };
          if (rawVariant.resume !== undefined && rawVariant.resume !== null) {
            const vrs = rawVariant.resume;
            if (!Array.isArray(vrs) || vrs.length === 0 || !vrs.every((p) => typeof p === 'string' && p.length > 0)) {
              throw new ExecutorProfileError(`${source}: \`${label}.resume\` must be a non-empty string array.`);
            }
            if (!(vrs as string[]).some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
              throw new ExecutorProfileError(`${source}: \`${label}.resume\` must contain ${SESSION_ID_PLACEHOLDER}.`);
            }
            variant.resume = vrs as string[];
          }
          route.write_variant = variant;
        }
        // host only (native alias removed)
        if (rawRoute.host !== undefined) {
          if (typeof rawRoute.host !== 'boolean') {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.host\` must be boolean.`);
          }
          route.host = rawRoute.host as boolean;
        }
        if (rawRoute.resume !== undefined) {
          const rs = rawRoute.resume;
          if (!Array.isArray(rs) || rs.length === 0 || !rs.every((p) => typeof p === 'string' && p.length > 0)) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.resume\` must be a non-empty string array.`);
          }
          if (!(rs as string[]).some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.resume\` must contain ${SESSION_ID_PLACEHOLDER}.`);
          }
          route.resume = rs as string[];
        }
        if (rawRoute.session_id_pattern !== undefined) {
          const pat = rawRoute.session_id_pattern;
          if (typeof pat !== 'string') {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.session_id_pattern\` must be a string.`);
          }
          try { new RegExp(pat); } catch (err) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.session_id_pattern\` did not compile: ${(err as Error).message}`);
          }
          if (!pat.includes('(')) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.session_id_pattern\` needs a capture group.`);
          }
          route.session_id_pattern = pat;
        }
        const isHost = route.host === true;
        if (isHost) {
          if (route.resume != null || route.session_id_pattern != null) {
            throw new ExecutorProfileError(`${source}: host route \`routes.${harnessKey}.${routeKey}\` rejects command-session fields.`);
          }
        }
        if (route.write_variant != null) {
          if (route.host === true) {
            throw new ExecutorProfileError(
              `${source}: \`routes.${harnessKey}.${routeKey}\` declares \`write_variant\` on a \`host: true\` route — ` +
                "in-session delivery carries the host's own permissions, and the locked fallback lane replays the " +
                'snapshotted base argv byte-for-byte, so no host lane can deliver a variant. Declare it on a command route.',
            );
          }
          if (route.write_access !== false) {
            throw new ExecutorProfileError(
              `${source}: \`routes.${harnessKey}.${routeKey}\` declares \`write_variant\` but not \`write_access: false\` — ` +
                'a write variant exists to escalate a read-only delivery for `requires_write: required` archetypes; ' +
                'a route that can already write does not need one.',
            );
          }
          if (route.command == null) {
            throw new ExecutorProfileError(
              `${source}: \`routes.${harnessKey}.${routeKey}\` declares \`write_variant\` but no \`command\` — ` +
                'the variant escalates a command delivery, so the base route must have one.',
            );
          }
          if (JSON.stringify(route.write_variant.command) === JSON.stringify(route.command)) {
            throw new ExecutorProfileError(
              `${source}: \`routes.${harnessKey}.${routeKey}.write_variant.command\` is identical to the base command — ` +
                'the variant exists to change the delivery; an identical argv would stamp write_access: true onto a ' +
                'delivery that cannot write.',
            );
          }
          // The postured spec must satisfy the same `resume ⟺ id source`
          // invariant the base parse enforces: posture swaps in
          // {command: variant.command, resume: variant.resume ?? null,
          //  sessionIdPattern: variant.resume != null ? base pattern : null}.
          const variantMintsId = route.write_variant.command.some((part) => part.includes(SESSION_ID_PLACEHOLDER));
          if (route.write_variant.resume == null) {
            if (variantMintsId) {
              throw new ExecutorProfileError(
                `${source}: \`routes.${harnessKey}.${routeKey}.write_variant.command\` contains ${SESSION_ID_PLACEHOLDER} ` +
                  'but the variant declares no `resume` — the postured delivery would spawn the literal placeholder. ' +
                  'Declare `write_variant.resume` or drop the placeholder from the variant command.',
              );
            }
          } else {
            const hasPattern = route.session_id_pattern != null;
            if (variantMintsId && hasPattern) {
              throw new ExecutorProfileError(
                `${source}: \`routes.${harnessKey}.${routeKey}.write_variant\` declares both a ${SESSION_ID_PLACEHOLDER} ` +
                  'placeholder in its command and inherits `session_id_pattern` — use one id source, not both.',
              );
            }
            if (!variantMintsId && !hasPattern) {
              throw new ExecutorProfileError(
                `${source}: \`routes.${harnessKey}.${routeKey}.write_variant\` declares \`resume\` but no session id source — ` +
                  `put ${SESSION_ID_PLACEHOLDER} in the variant command (engine-minted) or declare \`session_id_pattern\` on the route.`,
              );
            }
          }
        }
        if (rawRoute.timeout_ms !== undefined) {
          const tm = rawRoute.timeout_ms;
          if (typeof tm !== 'number' || !Number.isInteger(tm) || tm <= 0) {
            throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}.timeout_ms\` must be a positive integer (milliseconds).`);
          }
          route.timeout_ms = tm;
        }
        const routeEligibility = readEligibility(rawRoute as Record<string, unknown>, `route \`routes.${harnessKey}.${routeKey}\``, source);
        if (Object.keys(routeEligibility).length > 0) route.eligibility = routeEligibility;
        if (route.host === true && route.timeout_ms != null) {
          throw new ExecutorProfileError(`${source}: host route \`routes.${harnessKey}.${routeKey}\` may not declare \`timeout_ms\` — host dispatch is not supervised.`);
        }
        const unknownRouteKeys = Object.keys(rawRoute).filter((k) => !['driver','models_command','effort_encoding','command','write_access','write_variant','host','resume','session_id_pattern','eligibility','timeout_ms'].includes(k));
        if (unknownRouteKeys.length > 0) {
          throw new ExecutorProfileError(`${source}: route \`routes.${harnessKey}.${routeKey}\` has unknown key(s) ${unknownRouteKeys.join(', ')}.`);
        }
        perHarness[routeKey] = route;
      }
      routes[harnessKey] = perHarness;
    }
  }

  // dials
  const dials: Record<string, DialRef> = {};
  if (doc.dials !== undefined) {
    if (!isMapping(doc.dials)) {
      throw new ExecutorProfileError(`${source} \`dials\` is not a mapping (archetype → dial ref).`);
    }
    for (const [arch, rawRef] of Object.entries(doc.dials)) {
      if (!BARE_IDENTIFIER_RE.test(arch)) {
        throw new ExecutorProfileError(`${source}: dial archetype "${arch}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      }
      dials[arch] = parseDialRef(rawRef, `dials.${arch}`);
    }
  }

  // bindings
  const bindings: Record<string, DialRef> = {};
  if (doc.bindings !== undefined) {
    if (!isMapping(doc.bindings)) {
      throw new ExecutorProfileError(`${source} \`bindings\` is not a mapping (role → dial ref).`);
    }
    for (const [role, rawRef] of Object.entries(doc.bindings)) {
      if (role === '*') {
        notes.push('binding "*" is deprecated and ignored — base fallback is now automatic (current-host)');
        continue;
      }
      if (typeof role !== 'string' || role.length === 0) {
        throw new ExecutorProfileError(`${source}: binding role name must be non-empty.`);
      }
      bindings[role] = parseDialRef(rawRef, `bindings.${role}`);
    }
  }

  // unregistered_model_driver
  let unregisteredModelDriver = 'opencode';
  if (doc.unregistered_model_driver !== undefined) {
    if (typeof doc.unregistered_model_driver !== 'string' || (doc.unregistered_model_driver as string).trim().length === 0) {
      throw new ExecutorProfileError(`${source}: \`unregistered_model_driver\` must be a non-empty string.`);
    }
    unregisteredModelDriver = (doc.unregistered_model_driver as string).trim();
  }

  // archetypes
  const archetypes: Record<string, ArchetypePolicy> = {};
  if (doc.archetypes != null) {
    if (!isMapping(doc.archetypes)) {
      throw new ExecutorProfileError(`${source} \`archetypes\` is not a mapping (archetype → requirements).`);
    }
    for (const [name, rawPolicy] of Object.entries(doc.archetypes)) {
      if (!BARE_IDENTIFIER_RE.test(name)) {
        throw new ExecutorProfileError(`${source}: archetype name "${name}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      }
      if (!isMapping(rawPolicy)) {
        throw new ExecutorProfileError(`${source}: \`archetypes.${name}\` is not a mapping (only \`requires_write\`, \`fallback\`, \`distinct_provider_from_inputs\`, and \`brief\` are allowed).`);
      }
      const unknown = Object.keys(rawPolicy).filter((key) => key !== 'requires_write' && key !== 'fallback' && key !== 'distinct_provider_from_inputs' && key !== 'brief');
      if (unknown.length > 0) {
        throw new ExecutorProfileError(`${source}: \`archetypes.${name}\` has unknown key(s) ${unknown.join(', ')}; only \`requires_write\`, \`fallback\`, \`distinct_provider_from_inputs\`, and \`brief\` are allowed.`);
      }
      let requiresWrite: WritePosture = 'none';
      if (rawPolicy.requires_write !== undefined) {
        if (rawPolicy.requires_write === true) requiresWrite = 'required';
        else if (rawPolicy.requires_write === false) requiresWrite = 'none';
        else if (isWritePosture(rawPolicy.requires_write)) requiresWrite = rawPolicy.requires_write;
        else throw new ExecutorProfileError(`${source}: \`archetypes.${name}.requires_write\` must be ${WRITE_POSTURE_FORMS}.`);
      }
      let fallback: string | null = null;
      if (rawPolicy.fallback != null) {
        if (typeof rawPolicy.fallback !== 'string' || !BARE_IDENTIFIER_RE.test(rawPolicy.fallback)) {
          throw new ExecutorProfileError(`${source}: \`archetypes.${name}.fallback\` ${JSON.stringify(rawPolicy.fallback)} is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
        }
        if (rawPolicy.fallback === name) {
          throw new ExecutorProfileError(`${source}: \`archetypes.${name}.fallback\` may not name its own archetype.`);
        }
        fallback = rawPolicy.fallback;
      }
      let distinctProviderFromInputs: ProviderDistinctness | null = null;
      if (rawPolicy.distinct_provider_from_inputs !== undefined) {
        if (rawPolicy.distinct_provider_from_inputs !== 'advisory' && rawPolicy.distinct_provider_from_inputs !== 'required') {
          throw new ExecutorProfileError(`${source}: \`archetypes.${name}.distinct_provider_from_inputs\` must be "advisory" or "required".`);
        }
        distinctProviderFromInputs = rawPolicy.distinct_provider_from_inputs;
      }
      let brief: string | null = null;
      if (rawPolicy.brief != null) {
        if (typeof rawPolicy.brief !== 'string' || !BARE_IDENTIFIER_RE.test(rawPolicy.brief)) {
          throw new ExecutorProfileError(`${source}: \`archetypes.${name}.brief\` must be a bare lowercase identifier naming a brief template (${BARE_IDENTIFIER_RE.source}).`);
        }
        brief = rawPolicy.brief;
      }
      archetypes[name] = { requiresWrite, fallback, distinctProviderFromInputs, brief };
    }
    for (const start of Object.keys(archetypes)) {
      const path: string[] = [];
      const seen = new Set<string>();
      let current: string | null = start;
      while (typeof current === 'string' && Object.hasOwn(archetypes, current)) {
        if (seen.has(current)) {
          const cycle = path.slice(path.indexOf(current)).concat(current);
          throw new ExecutorProfileError(`${source}: archetype fallback cycle: ${cycle.join(' → ')}.`);
        }
        path.push(current);
        seen.add(current);
        current = nextArchetypeFallback(archetypes, current);
      }
    }
  }

  let constraints: { command: string[] } | null = null;
  if (doc.constraints != null) {
    if (!isMapping(doc.constraints)) {
      throw new ExecutorProfileError(`${source} \`constraints\` is not a mapping (only \`command\` is allowed).`);
    }
    const unknown = Object.keys(doc.constraints).filter((key) => key !== 'command');
    if (unknown.length > 0) {
      throw new ExecutorProfileError(`${source}: \`constraints\` has unknown key(s) ${unknown.join(', ')}; only \`command\` is allowed.`);
    }
    const command = doc.constraints.command;
    if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string' && part.length > 0)) {
      throw new ExecutorProfileError(`${source}: \`constraints.command\` must be a non-empty array of non-empty strings.`);
    }
    constraints = { command: command as string[] };
  }

  const tools: Record<string, ToolSpec> = {};
  if (doc.tools !== undefined && doc.tools !== null) {
    if (!isMapping(doc.tools)) {
      throw new ExecutorProfileError(`${source} \`tools\` is not a mapping (tool name → {command, timeout_ms?}).`);
    }
    for (const [name, raw] of Object.entries(doc.tools)) {
      if (!BARE_IDENTIFIER_RE.test(name)) {
        throw new ExecutorProfileError(`${source}: tool name "${name}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      }
      if (!isMapping(raw)) {
        throw new ExecutorProfileError(`${source}: tool "${name}" is not a mapping.`);
      }
      const unknown = Object.keys(raw).filter((k) => k !== 'command' && k !== 'timeout_ms' && k !== 'timeout');
      if (unknown.length > 0) {
        throw new ExecutorProfileError(`${source}: tool "${name}" has unknown key(s) ${unknown.join(', ')}; only command, timeout, timeout_ms are allowed.`);
      }
      const cmd = raw.command;
      if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((p) => typeof p === 'string' && p.length > 0)) {
        throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` must be a non-empty array of non-empty strings.`);
      }
      for (const part of cmd as string[]) {
        if (part.length === 0 || part.trim().length === 0) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` contains an empty or whitespace-only string.`);
        }
        if (part.includes('{') || part.includes('}') || part.includes('$') || part.includes('`')) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` must be a static argv without interpolation or placeholders; found "${part}".`);
        }
        if (part.includes('\n') || part.includes('\0')) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` contains an illegal character.`);
        }
      }
      let timeoutMs: number | null = null;
      if (raw.timeout_ms !== undefined) {
        const tm = raw.timeout_ms;
        if (typeof tm !== 'number' || !Number.isInteger(tm) || tm <= 0) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`timeout_ms\` must be a positive integer (milliseconds).`);
        }
        timeoutMs = tm;
      }
      if (raw.timeout !== undefined) {
        if (timeoutMs != null) {
          throw new ExecutorProfileError(`${source}: tool "${name}" has both timeout and timeout_ms — use one.`);
        }
        const tm = raw.timeout;
        if (typeof tm !== 'number' || !Number.isInteger(tm) || tm <= 0) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`timeout\` must be a positive integer (seconds).`);
        }
        timeoutMs = tm * 1000;
      }
      tools[name] = { command: cmd as string[], ...(timeoutMs != null ? { timeoutMs } : {}) };
    }
  }

  // worktree_carry
  //
  // Previously read directly off the raw catalog YAML in `dispatch.ts`,
  // bypassing this parser entirely: `mergeLayer` (config-layers.ts) only
  // copies a fixed allowlist of top-level keys between layers, so an
  // unrecognized key like `worktree_carry` was dropped before it ever
  // reached this function's strict unknown-key check below — which meant a
  // value of the wrong type (or one holding a malformed entry) was silently
  // ignored rather than rejected. Silent no-carry produces exactly the
  // untrustworthy pair the carry list exists to prevent (a challenger with
  // no `node_modules` cannot build or test, and nothing said so). Now that
  // `worktree_carry` is a known, validated key here, a badly-shaped
  // declaration — not an array, a non-string entry, an absolute path, a `..`
  // segment — fails loudly like any other malformed catalog field, instead
  // of quietly becoming "nothing to carry."
  //
  // Absolute paths and any ".." segment are rejected here, at parse time,
  // rather than silently dropped the way the old reader did — carrying
  // outside the repo is never sensible, so reporting it beats pretending the
  // entry was never declared.
  //
  // The residual gap this comment used to describe — a top-level key
  // MISSPELLED entirely (`worktree_carrry:` rather than `worktree_carry:`)
  // being dropped by `mergeLayer`'s copy-by-literal-name before it could
  // reach the unknown-key check below, and so silently doing nothing — is
  // now closed, where it said it would have to be: config-layers.ts
  // validates each layer's RAW keys before the selective merge, against
  // `CATALOG_TOP_LEVEL_KEYS` above (the list this function also checks).
  // That is the only place with the typo still in hand; by the time a
  // document reaches this parser the misspelling is already gone.
  const worktreeCarry: string[] = [];
  if (doc.worktree_carry !== undefined) {
    if (!Array.isArray(doc.worktree_carry)) {
      throw new ExecutorProfileError(`${source}: \`worktree_carry\` must be an array of repo-relative path strings.`);
    }
    for (const raw of doc.worktree_carry) {
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        throw new ExecutorProfileError(`${source}: \`worktree_carry\` entries must be non-empty strings; found ${JSON.stringify(raw)}.`);
      }
      const trimmed = raw.trim();
      if (isAbsolute(trimmed)) {
        throw new ExecutorProfileError(`${source}: \`worktree_carry\` entry "${trimmed}" must be repo-relative, not absolute.`);
      }
      const normalized = trimmed.split('\\').join('/');
      if (normalized.split('/').includes('..')) {
        throw new ExecutorProfileError(`${source}: \`worktree_carry\` entry "${trimmed}" may not contain a ".." segment.`);
      }
      worktreeCarry.push(normalized);
    }
  }

  // Reject unknown top-level keys (to catch legacy loadouts etc. as error via schema_version already, but also unknown keys).
  // Via the layered loader this is now a backstop: config-layers.ts rejects an
  // unknown key in each raw layer first, while the offending file is still
  // identifiable. This still guards anything parsing a catalog document
  // directly.
  const unknownTop = Object.keys(doc).filter((k) => !(CATALOG_TOP_LEVEL_KEYS as readonly string[]).includes(k));
  if (unknownTop.length > 0) {
    // If legacy keys like executors/targets/loadouts/default_loadout present, they already would be caught by schema_version check?
    // But they would still be present as unknown keys; map to same migration error for clarity.
    if (unknownTop.some((k) => (PRE_DIALS_CATALOG_KEYS as readonly string[]).includes(k))) {
      throw preDialsCatalogError(source);
    }
    // For truly unknown keys, throw generic
    throw new ExecutorProfileError(`${source} has unknown key(s) ${unknownTop.join(', ')}.`);
  }

  return {
    models,
    routes,
    bindings,
    dials,
    archetypes,
    constraints,
    unregisteredModelDriver,
    harness,
    schemaVersion: 3,
    notes,
    tools,
    worktreeCarry,
  };
}

function readEligibility(raw: Record<string, unknown>, label: string, source: string): Record<string, EligibilityState> {
  if (raw.eligibility === undefined) return {};
  if (!isMapping(raw.eligibility)) {
    throw new ExecutorProfileError(`${source}: ${label} \`eligibility\` is not a mapping (archetype → eligibility state).`);
  }
  const out: Record<string, EligibilityState> = {};
  for (const [key, value] of Object.entries(raw.eligibility)) {
    if (!BARE_IDENTIFIER_RE.test(key)) {
      throw new ExecutorProfileError(`${source}: ${label} eligibility key "${key}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
    }
    if (value !== 'eligible' && value !== 'shadow_only' && value !== 'forbidden') {
      throw new ExecutorProfileError(`${source}: ${label} \`eligibility.${key}\` must be "eligible", "shadow_only", or "forbidden".`);
    }
    out[key] = value;
  }
  return out;
}

/** Load the repo's executor profile, or explain how to create one. */
export function loadExecutorProfile(repoRoot: string, options: UserPathOptions = {}, harness?: HarnessId): LoadedExecutorProfile {
  try {
    const loaded = loadLayeredProfile(repoRoot, options, activeHarness(harness, options));
    return {
      profile: loaded.profile,
      path: loaded.path,
      layers: loaded.layers,
      selfContained: loaded.selfContained,
      provenance: loaded.provenance,
    };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw err;
    throw new ExecutorProfileError((err as Error).message);
  }
}

/** Repo-relative sticky dial file, written by `fadeno dial`. */
export const DIALS_LOCAL_FILE = join('.fadeno', 'local', 'dials');

// --- New pin file v3 ---

export interface ShadowAttachment {
  model: string;
  effort?: string;
  via?: string;
  rate?: number;
}

export interface LocalDialState {
  dials: Record<string, DialRef>;
  shadows: Record<string, ShadowAttachment>;
  legacyNote: string | null;
}

function localDialPinError(detail: string): ExecutorProfileError {
  return new ExecutorProfileError(
    `${DIALS_LOCAL_FILE} ${detail} Fix: delete it (machine-local state, never committed), then re-dial with \`fadeno dial <archetype> <model>\`.`,
  );
}

export function readLocalDialState(repoRoot: string): LocalDialState {
  const path = join(repoRoot, DIALS_LOCAL_FILE);
  if (!existsSync(path)) return { dials: {}, shadows: {}, legacyNote: null };
  const text = readFileSync(path, 'utf8');
  const trimmed = text.trim();
  if (trimmed.length === 0) return { dials: {}, shadows: {}, legacyNote: null };
  if (!trimmed.startsWith('{')) {
    return {
      dials: {},
      shadows: {},
      legacyNote: 'pre-0.6 loadout pin ignored (named loadouts retired) — re-dial with `fadeno dial <archetype> <model>`',
    };
  }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (err) {
    throw localDialPinError(`did not parse as JSON: ${(err as Error).message}.`);
  }
  if (!isMapping(doc)) {
    throw localDialPinError('is JSON, but not an object (`{dials, shadows}`).');
  }
  if (doc.loadout !== undefined || doc.overrides !== undefined) {
    return {
      dials: {},
      shadows: {},
      legacyNote: 'pre-0.6 loadout pin ignored (named loadouts retired) — re-dial with `fadeno dial <archetype> <model>`',
    };
  }
  const dials: Record<string, DialRef> = {};
  if (doc.dials != null) {
    if (!isMapping(doc.dials)) throw localDialPinError('has a `dials` that is not a mapping (archetype → dial ref).');
    for (const [arch, raw] of Object.entries(doc.dials)) {
      if (!BARE_IDENTIFIER_RE.test(arch)) throw localDialPinError(`has dial key "${arch}", which is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      try {
        dials[arch] = parseDialRef(raw, `dials.${arch}`);
      } catch (err) {
        throw localDialPinError((err as Error).message);
      }
    }
  }
  const shadows: Record<string, ShadowAttachment> = {};
  if (doc.shadows != null) {
    if (!isMapping(doc.shadows)) throw localDialPinError('has a `shadows` that is not a mapping (archetype → shadow attachment).');
    for (const [arch, raw] of Object.entries(doc.shadows)) {
      if (!BARE_IDENTIFIER_RE.test(arch)) throw localDialPinError(`has shadow key "${arch}", which is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      if (!isMapping(raw)) throw localDialPinError(`shadow "${arch}" is not a mapping ({model, effort?, via?, rate?}).`);
      const model = raw.model;
      if (typeof model !== 'string' || model.trim().length === 0) throw localDialPinError(`shadow "${arch}" needs a non-empty \`model\`.`);
      let effort: string | undefined;
      if (raw.effort !== undefined) {
        if (typeof raw.effort !== 'string' || raw.effort.trim().length === 0) throw localDialPinError(`shadow "${arch}" has invalid \`effort\`.`);
        effort = raw.effort.trim();
      }
      let via: string | undefined;
      if (raw.via !== undefined) {
        if (typeof raw.via !== 'string' || raw.via.trim().length === 0) throw localDialPinError(`shadow "${arch}" has invalid \`via\`.`);
        via = raw.via.trim();
      }
      let rate: number | undefined;
      if (raw.rate !== undefined) {
        if (typeof raw.rate !== 'number' || !Number.isFinite(raw.rate) || raw.rate <= 0 || raw.rate > 1) {
          throw localDialPinError(`shadow "${arch}" has rate ${JSON.stringify(raw.rate)}, which is not a number in (0, 1].`);
        }
        rate = raw.rate;
      }
      const unknown = Object.keys(raw).filter((k) => !['model','effort','via','rate'].includes(k));
      if (unknown.length > 0) throw localDialPinError(`shadow "${arch}" has unknown key(s) ${unknown.join(', ')}; only model, effort, via, rate are allowed.`);
      const att: ShadowAttachment = { model: model.trim() };
      if (effort != null) att.effort = effort;
      if (via != null) att.via = via;
      if (rate != null) att.rate = rate;
      shadows[arch] = att;
    }
  }
  const unknownTop = Object.keys(doc).filter((k) => k !== 'dials' && k !== 'shadows');
  if (unknownTop.length > 0) {
    throw localDialPinError(`has unknown key(s) ${unknownTop.join(', ')}; only \`dials\` and \`shadows\` are allowed.`);
  }
  return { dials, shadows, legacyNote: null };
}

export function writeLocalDialState(repoRoot: string, state: LocalDialState): string {
  const path = join(repoRoot, DIALS_LOCAL_FILE);
  const dialKeys = Object.keys(state.dials).sort();
  const shadowKeys = Object.keys(state.shadows).sort();
  if (dialKeys.length === 0 && shadowKeys.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  for (const k of dialKeys) {
    if (!BARE_IDENTIFIER_RE.test(k)) throw new ExecutorProfileError(`dial key "${k}" is not a bare identifier.`);
  }
  for (const [arch, att] of Object.entries(state.shadows)) {
    if (!BARE_IDENTIFIER_RE.test(arch)) throw new ExecutorProfileError(`shadow key "${arch}" is not a bare identifier.`);
    if (typeof att.model !== 'string' || att.model.trim().length === 0) throw new ExecutorProfileError(`shadow "${arch}" has empty model.`);
    if (att.rate !== undefined && (typeof att.rate !== 'number' || !Number.isFinite(att.rate) || att.rate <= 0 || att.rate > 1)) throw new ExecutorProfileError(`shadow "${arch}" has invalid rate ${String(att.rate)}.`);
  }
  const out: Record<string, unknown> = {};
  if (dialKeys.length > 0) {
    const sorted: Record<string, unknown> = {};
    for (const k of dialKeys) {
      const ref = state.dials[k]!;
      sorted[k] = serializeDialRef(ref);
    }
    out.dials = sorted;
  }
  if (shadowKeys.length > 0) {
    const sortedShadows: Record<string, ShadowAttachment> = {};
    for (const k of shadowKeys) {
      const att = state.shadows[k]!;
      const entry: ShadowAttachment = { model: att.model };
      if (att.effort != null) entry.effort = att.effort;
      if (att.via != null) entry.via = att.via;
      if (att.rate != null) entry.rate = att.rate;
      sortedShadows[k] = entry;
    }
    out.shadows = sortedShadows;
  }
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(out).sort()) ordered[k] = out[k];
  writeFileSync(path, `${JSON.stringify(ordered)}\n`, 'utf8');
  return path;
}

// --- Dial layers + resolution ---

export interface DialLayers {
  session: Record<string, DialRef>;
  repo: Record<string, DialRef>;
  user: Record<string, DialRef>;
}

export type RoleResolutionSource = 'binding' | 'session' | 'repo' | 'user' | 'base';

export interface DialCascadeResult {
  ref: DialRef;
  source: RoleResolutionSource;
  resolvedVia: string | null;
}

export function resolveDialCascade(
  role: string,
  archetype: string | null,
  policy: { bindings: Record<string, DialRef>; archetypes: Record<string, ArchetypePolicy> },
  layers: DialLayers,
): DialCascadeResult {
  if (Object.hasOwn(policy.bindings, role)) {
    const maybe = policy.bindings[role];
    if (maybe != null && typeof maybe === 'object' && typeof (maybe as DialRef).model === 'string') {
      return { ref: maybe as DialRef, source: 'binding', resolvedVia: null };
    }
  }
  if (archetype != null) {
    const seen = new Set<string>();
    let current: string | null = archetype;
    const chain: string[] = [];
    while (typeof current === 'string' && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      current = nextArchetypeFallback(policy.archetypes, current);
    }
    for (const arch of chain) {
      if (Object.hasOwn(layers.session, arch)) {
        return { ref: layers.session[arch]!, source: 'session', resolvedVia: arch !== archetype ? arch : null };
      }
      if (Object.hasOwn(layers.repo, arch)) {
        return { ref: layers.repo[arch]!, source: 'repo', resolvedVia: arch !== archetype ? arch : null };
      }
      if (Object.hasOwn(layers.user, arch)) {
        return { ref: layers.user[arch]!, source: 'user', resolvedVia: arch !== archetype ? arch : null };
      }
    }
  }
  return { ref: { model: 'current-host' }, source: 'base', resolvedVia: null };
}

export interface RoleResolution {
  delivery: CompiledDelivery;
  source: RoleResolutionSource;
  resolvedVia: string | null;
}

export function resolveRole(
  role: string,
  archetype: string | null,
  profile: ExecutorProfile,
  layers: DialLayers,
): RoleResolution {
  const cascade = resolveDialCascade(role, archetype, { bindings: profile.bindings, archetypes: profile.archetypes }, layers);
  const delivery = compileDialRef(cascade.ref, profile);
  return { delivery, source: cascade.source, resolvedVia: cascade.resolvedVia };
}

export function roleResolutionEchoLabel(source: RoleResolutionSource): string {
  switch (source) {
    case 'binding': return 'binding';
    case 'session': return 'session dial';
    case 'repo': return 'repo pin';
    case 'user': return 'user dial';
    case 'base': return 'base';
    default: return String(source);
  }
}

// --- compileDialRef ---

function findRouteByDriver(
  routes: Record<string, RouteRaw>,
  driver: string,
): { key: string; route: RouteRaw } | null {
  for (const [key, route] of Object.entries(routes)) {
    const alias = route.driver ?? key;
    if (alias === driver) return { key, route };
  }
  return null;
}

function declaredDriverAliases(routes: Record<string, RouteRaw>): string[] {
  const s = new Set<string>();
  for (const [key, route] of Object.entries(routes)) {
    s.add(route.driver ?? key);
  }
  return [...s].sort();
}

export function compileDialRef(ref: DialRef, profile: ExecutorProfile): CompiledDelivery {
  const harness = profile.harness ?? 'standalone';
  const routesForHarness = profile.routes?.[harness] ?? {};
  const refString = formatDialRef(ref);
  const buildDelivery = (
    model: string,
    modelId: string,
    effectiveEffort: string,
    provider: string | null,
    driver: string,
    registered: boolean,
    route: RouteRaw | null,
    eligibility: Record<string, EligibilityState>,
  ): CompiledDelivery => {
    const isHost = route?.host === true || (route == null && model === 'current-host');
    const subst = (argv: string[]): string[] =>
      argv.map((part) => part.split('{model}').join(modelId).split('{reasoning_effort}').join(effectiveEffort));
    // Route-level eligibility merges over model-level, strictest wins — a
    // lane's structural constraint (e.g. "no directors here") binds every
    // model delivered through it, registered or not.
    const ELIGIBILITY_RANK: Record<EligibilityState, number> = { eligible: 0, shadow_only: 1, forbidden: 2 };
    const mergedEligibility: Record<string, EligibilityState> = { ...eligibility };
    for (const [archKey, state] of Object.entries(route?.eligibility ?? {})) {
      const current = mergedEligibility[archKey];
      if (current == null || ELIGIBILITY_RANK[state] > ELIGIBILITY_RANK[current]) mergedEligibility[archKey] = state;
    }
    eligibility = mergedEligibility;
    let spec: ExecutorSpec;
    if (isHost) {
      const fallback = route?.command ? subst(route.command) : null;
      spec = {
        adapter: 'host',
        model: modelId,
        reasoningEffort: effectiveEffort,
        agentType: '*',
        fallbackCommand: fallback,
        writeAccess: route?.write_access ?? null,
        eligibility: { ...eligibility },
        ...(provider != null ? { provider } : {}),
        ...(driver ? { driver } : {}),
      };
    } else {
      if (route?.command == null) {
        throw new ExecutorProfileError(`no route for driver "${driver}" in harness "${harness}" — declare routes.${harness}.${driver} with host:true or command`);
      }
      const cmd = subst(route.command);
      let resume: string[] | null = null;
      if (route.resume != null) {
        resume = subst(route.resume);
      }
      spec = {
        adapter: 'command',
        command: cmd,
        model: modelId,
        resume,
        sessionIdPattern: route.session_id_pattern ?? null,
        writeAccess: route.write_access ?? null,
        ...(route.timeout_ms != null ? { timeoutMs: route.timeout_ms } : {}),
        ...(route.write_variant != null
          ? { writeVariant: { command: subst(route.write_variant.command), resume: route.write_variant.resume != null ? subst(route.write_variant.resume) : null } }
          : {}),
        eligibility: { ...eligibility },
        ...(provider != null ? { provider } : {}),
        ...(driver ? { driver } : {}),
      };
    }
    return { ref, refString, spec, model, modelId, pinnedEffort: ref.effort ?? null, effectiveEffort, provider, driver, registered };
  };

  if (Object.hasOwn(profile.models, ref.model)) {
    const entry = profile.models[ref.model]!;
    const provider = entry.provider;
    // The pin when there is one; otherwise the registry's declared default.
    // `ref.effort` alone (the pin) survives on `CompiledDelivery.pinnedEffort`.
    const effectiveEffort = ref.effort ?? entry.effort;
    const via = ref.via;
    let driver: string;
    let route: RouteRaw | null = null;
    let id: string;
    if (via != null) {
      const found = findRouteByDriver(routesForHarness, via);
      if (found == null) {
        const declared = declaredDriverAliases(routesForHarness);
        throw new ExecutorProfileError(`unknown driver "${via}" — declared drivers: ${declared.join(', ')}`);
      }
      driver = via;
      route = found.route;
      id = entry.spellings[via] ?? entry.id;
    } else {
      const homeKey = provider;
      const homeRoute = routesForHarness[homeKey] ?? null;
      if (homeRoute == null) {
        if (ref.model === 'current-host') {
          driver = 'current-host';
          route = null;
          id = entry.id;
          const modelId = id;
          return buildDelivery(ref.model, modelId, effectiveEffort, provider, driver, true, route, entry.eligibility);
        }
        const declared = declaredDriverAliases(routesForHarness);
        throw new ExecutorProfileError(`no route for provider "${provider}" in harness "${harness}" — declared drivers: ${declared.join(', ')}`);
      }
      driver = homeRoute.driver ?? homeKey;
      route = homeRoute;
      id = entry.id;
    }
    let modelId = id;
    const enc = route?.effort_encoding ?? 'flag';
    if (enc === 'model-suffix' && effectiveEffort !== 'default') modelId = `${id}-${effectiveEffort}`;
    return buildDelivery(ref.model, modelId, effectiveEffort, provider, driver, true, route, entry.eligibility);
  }
  const driver = ref.via ?? profile.unregisteredModelDriver;
  const found = findRouteByDriver(routesForHarness, driver);
  if (found == null) {
    const declared = declaredDriverAliases(routesForHarness);
    throw new ExecutorProfileError(`unknown driver "${driver}" — declared drivers: ${declared.join(', ')}`);
  }
  const route = found.route;
  // Unregistered: no registry entry to default from, so an unpinned dial runs
  // at the neutral `'default'`. `pinnedEffort` still records only the pin.
  const effectiveEffort = ref.effort ?? 'default';
  let modelId = ref.model;
  if (route.effort_encoding === 'model-suffix' && effectiveEffort !== 'default') modelId = `${ref.model}-${effectiveEffort}`;
  return buildDelivery(ref.model, modelId, effectiveEffort, null, driver, false, route, {});
}

/** One delivery under consideration: the profile's name for it, plus its spec. */
export interface DeliveryChoice {
  executor: string;
  spec: ExecutorSpec;
}

/**
 * Select the delivery a write posture actually gets. A `requires_write:
 * required` archetype resolving onto a read-only spec that declares a write
 * variant receives the variant argv (writeAccess true); every other posture
 * receives the spec unchanged. The dial names the who; the archetype's
 * declared policy — made once, in the catalog — authorizes the escalation.
 */
export function applyWritePosture(
  spec: ExecutorSpec,
  archetype: string | null,
  archetypes: Record<string, ArchetypePolicy>,
): { spec: ExecutorSpec; usedWriteVariant: boolean } {
  if (archetype == null || !Object.hasOwn(archetypes, archetype)) return { spec, usedWriteVariant: false };
  if (archetypes[archetype]!.requiresWrite !== 'required') return { spec, usedWriteVariant: false };
  if (spec.writeAccess !== false) return { spec, usedWriteVariant: false };
  // Command adapter only: in-session host delivery carries the host's own
  // permissions, and the locked fallback lane replays the snapshotted base
  // argv byte-for-byte — host routes refuse the write_variant key at parse.
  if (spec.adapter !== 'command') return { spec, usedWriteVariant: false };
  const variant = spec.writeVariant;
  if (variant == null) return { spec, usedWriteVariant: false };
  const next: CommandExecutorSpec = {
    ...spec,
    command: variant.command,
    // A variant without its own resume does not advertise resumption: the
    // base resume argv carries the base (read-only) permission mode.
    resume: variant.resume ?? null,
    sessionIdPattern: variant.resume != null ? spec.sessionIdPattern : null,
    writeAccess: true,
  };
  delete next.writeVariant;
  return { spec: next, usedWriteVariant: true };
}

// Belt-and-braces only: every in-tree caller of explainWriteConflict passes an
// already-postured spec (writeAccess true, writeVariant deleted when a variant
// applied), so this guard fires only for a caller that skipped posture. Kept so
// a raw compiled spec still reads as satisfiable rather than conflicted.
function hasWriteVariant(spec: ExecutorSpec): boolean {
  return spec.adapter === 'command' && spec.writeVariant != null;
}

export function explainWriteConflict(
  delivery: DeliveryChoice,
  archetype: string | null,
  profile: ExecutorProfile,
): string | null {
  if (archetype == null) return null;
  if (!Object.hasOwn(profile.archetypes, archetype)) return null;
  const posture = profile.archetypes[archetype]!.requiresWrite;
  if (posture === 'required' && delivery.spec.writeAccess === false && !hasWriteVariant(delivery.spec)) {
    return (
      `archetype "${archetype}" declares \`requires_write: required\`, but executor "${delivery.executor}" ` +
      'delivers through a command route declared `write_access: false` — it cannot mutate the ' +
      'workspace, so the dispatch would burn a run and end in a refusal. ' +
      `Fix: bind "${archetype}" to a write-capable executor, ` +
      "declare a `write_variant` on the route (a write-capable argv selected automatically for write-requiring archetypes), " +
      `or run this ${archetype}-shaped task with the in-session ${archetype} agent. ` +
      'You can override this guard by rerunning the dial with `--force`, but doing so is not suggested because the executor may be unable to complete the work.'
    );
  }
  if (posture === 'forbidden' && delivery.spec.writeAccess === true) {
    return (
      `archetype "${archetype}" declares \`requires_write: forbidden\`, but executor "${delivery.executor}" ` +
      'delivers through a command route declared `write_access: true` — the dispatch would hand a ' +
      'mutating toolchain to work that must not mutate the workspace. ' +
      `Fix: bind "${archetype}" to a read-only route, ` +
      `clear the session dial (\`fadeno dial clear ${archetype}\`), ` +
      'or declare `requires_write: none`. ' +
      'You can override this guard by rerunning the dial with `--force`, but doing so is not suggested because it hands mutating capability to write-forbidden work.'
    );
  }
  return null;
}

export function eligibilityFor(spec: ExecutorSpec, archetype: string | null): EligibilityState {
  if (typeof archetype !== 'string') return 'eligible';
  const map = spec.eligibility;
  if (map == null || !Object.hasOwn(map, archetype)) return 'eligible';
  const state = map[archetype];
  return state === 'shadow_only' || state === 'forbidden' || state === 'eligible' ? state : 'eligible';
}

export const ON_DEMAND_HOST_HARNESSES: ReadonlySet<string> = new Set(['claude']);

export function dispatchability(
  spec: ExecutorSpec,
  harness: string,
): { supported: true } | { supported: false; reason: 'host_in_session' | 'host_without_fallback' } {
  if (spec.adapter !== 'host') return { supported: true };
  if (ON_DEMAND_HOST_HARNESSES.has(harness)) return { supported: false, reason: 'host_in_session' };
  if (spec.fallbackCommand == null) return { supported: false, reason: 'host_without_fallback' };
  return { supported: true };
}

/**
 * Whether a resolved spec can take the command lane at all, independent of
 * harness. `dispatchability` answers "can THIS harness dispatch it" (a
 * command-capable host spec is still refused on an on-demand harness, to stop
 * it shelling out to a subprocess of itself); this answers the narrower,
 * harness-free question a symmetric pair needs — is there a command lane
 * here for the pair's forced-command exception to use at all. A command
 * adapter always qualifies; a host adapter qualifies only with a
 * `fallbackCommand` to fall back to. This is exactly the condition the
 * kernel's `pairCommandFallback` tests before it lets a selected pair reuse a
 * host slot's fallback — computed here once so every caller (the dial/
 * steering resolvers, the kernel) agrees by construction.
 */
export function commandRoutable(spec: ExecutorSpec): boolean {
  return spec.adapter === 'command' || (spec.adapter === 'host' && spec.fallbackCommand != null);
}

export function explainEligibilityConflict(
  delivery: DeliveryChoice,
  archetype: string | null,
): string | null {
  if (eligibilityFor(delivery.spec, archetype) !== 'forbidden') return null;
  return (
    `archetype "${archetype}" is marked \`eligibility: forbidden\` on executor "${delivery.executor}" — ` +
    'the catalog forbids this pairing. ' +
    'Fix: choose an eligible executor, dial a different target, or change the catalog\'s eligibility entry.'
  );
}

export interface InputProducer {
  dispatchId: string | null;
  executor: string | null;
  provider: string | null;
}

export type ProviderConflict = { level: 'refuse' | 'warn'; message: string };

function producerRef(producer: InputProducer): string {
  if (typeof producer.dispatchId === 'string') return `dispatch ${producer.dispatchId}`;
  if (typeof producer.executor === 'string') return `executor "${producer.executor}"`;
  return 'an input producer';
}

export function explainProviderConflict(
  archetype: string | null,
  targetProvider: string | null,
  producers: InputProducer[],
  profile: ExecutorProfile,
): ProviderConflict | null {
  if (typeof archetype !== 'string' || !Object.hasOwn(profile.archetypes, archetype)) return null;
  const policy = profile.archetypes[archetype]!.distinctProviderFromInputs;
  if (policy !== 'advisory' && policy !== 'required') return null;
  if (producers.length === 0) return null;

  const level: ProviderConflict['level'] = policy === 'required' ? 'refuse' : 'warn';
  const unresolvable = policy === 'required'
    ? 'provenance is demanded but unresolvable'
    : 'provider provenance is unresolvable';

  for (const producer of producers) {
    if (targetProvider == null || producer.provider == null) {
      const detail = targetProvider == null
        ? `the resolved target's provider is unknown — ${unresolvable}`
        : `${producerRef(producer)} has no provider — ${unresolvable}`;
      return {
        level,
        message:
          `archetype "${archetype}" declares \`distinct_provider_from_inputs: ${policy}\`, but ${detail}.`,
      };
    }
    if (producer.provider === targetProvider) {
      return {
        level,
        message:
          `archetype "${archetype}" declares \`distinct_provider_from_inputs: ${policy}\`, but ` +
          `the resolved target's provider "${targetProvider}" matches ${producerRef(producer)} ` +
          `(provider "${producer.provider}") — the dispatch would not be provider-distinct.`,
      };
    }
  }
  return null;
}

/** Bind a neutral host target to the archetype requested by this invocation. */
export function executorForArchetype(
  _profile: ExecutorProfile,
  _executorName: string,
  _archetype: string | null,
): ExecutorSpec {
  void _profile;
  void _executorName;
  void _archetype;
  return { adapter: 'command', command: [], model: null, resume: null, sessionIdPattern: null, writeAccess: null, eligibility: {} } as ExecutorSpec;
}

// --- Snapshot format v3 ---

export interface SnapshotDocument {
  executors: Record<string, ExecutorSpec>;
  bindings: Record<string, DialRef>;
  archetypes: Record<string, ArchetypePolicy>;
  constraints: { command: string[] } | null;
  tools: Record<string, ToolSpec>;
}

function parseExecutorSpecEntry(raw: unknown, label: string, source: string): ExecutorSpec {
  if (!isMapping(raw)) {
    throw new ExecutorProfileError(`${source}: ${label} is not a mapping.`);
  }
  const adapter = raw.adapter;
  if (adapter !== 'command' && adapter !== 'host') {
    throw new ExecutorProfileError(`${source}: ${label} has adapter ${JSON.stringify(adapter)}; expected \`command\` or \`host\`.`);
  }
  if (adapter === 'host') {
    const forbidden = ['command', 'resume', 'session_id_pattern'].filter((key) => raw[key] !== undefined);
    if (forbidden.length > 0) {
      throw new ExecutorProfileError(`${source}: ${label} host executor rejects command/session field(s): ${forbidden.join(', ')}.`);
    }
    const model = raw.model;
    const reasoningEffort = raw.reasoning_effort;
    const agentType = raw.agent_type;
    if (typeof model !== 'string' || model.length === 0) {
      throw new ExecutorProfileError(`${source}: ${label} host executor needs a non-empty \`model\`.`);
    }
    if (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0) {
      throw new ExecutorProfileError(`${source}: ${label} host executor needs a non-empty \`reasoning_effort\`.`);
    }
    if (typeof agentType !== 'string' || agentType.length === 0) {
      throw new ExecutorProfileError(`${source}: ${label} host executor needs a non-empty \`agent_type\`.`);
    }
    let fallbackCommand: string[] | null = null;
    if (raw.fallback_command != null) {
      if (!Array.isArray(raw.fallback_command) || raw.fallback_command.length === 0 || !raw.fallback_command.every((part) => typeof part === 'string' && part.length > 0)) {
        throw new ExecutorProfileError(`${source}: ${label} host executor needs \`fallback_command\` as a non-empty array of strings.`);
      }
      fallbackCommand = raw.fallback_command as string[];
    }
    const target = typeof raw.target === 'string' ? raw.target : undefined;
    const provider = typeof raw.provider === 'string' ? raw.provider : undefined;
    const driver = typeof raw.driver === 'string' ? raw.driver : undefined;
    let writeAccess: boolean | null = null;
    if (raw.write_access !== undefined) {
      if (typeof raw.write_access !== 'boolean') throw new ExecutorProfileError(`${source}: ${label} host executor has a non-boolean \`write_access\`.`);
      writeAccess = raw.write_access;
    }
    let eligibility: Record<string, EligibilityState> = {};
    if (raw.eligibility !== undefined) {
      if (!isMapping(raw.eligibility)) throw new ExecutorProfileError(`${source}: ${label} host executor \`eligibility\` is not a mapping.`);
      for (const [k, v] of Object.entries(raw.eligibility)) {
        if (!BARE_IDENTIFIER_RE.test(k)) throw new ExecutorProfileError(`${source}: ${label} host executor eligibility key "${k}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
        if (v !== 'eligible' && v !== 'shadow_only' && v !== 'forbidden') throw new ExecutorProfileError(`${source}: ${label} host executor \`eligibility.${k}\` must be "eligible", "shadow_only", or "forbidden".`);
        eligibility[k] = v;
      }
    }
    if (raw.write_variant !== undefined) {
      throw new ExecutorProfileError(`${source}: ${label} host executor rejects \`write_variant\` — write variants are command-delivery only.`);
    }
    if (raw.timeout_ms !== undefined) {
      throw new ExecutorProfileError(`${source}: ${label} host executor rejects \`timeout_ms\` — host dispatch is not supervised.`);
    }
    const spec: HostExecutorSpec = {
      adapter: 'host', model, reasoningEffort, agentType, fallbackCommand, writeAccess, eligibility,
      ...(target != null ? { target } : {}),
      ...(provider != null ? { provider } : {}),
      ...(driver != null ? { driver } : {}),
    };
    return spec;
  }
  // command
  if (raw.reasoning_effort !== undefined || raw.agent_type !== undefined || raw.fallback_command !== undefined) {
    throw new ExecutorProfileError(`${source}: ${label} command executor rejects host-only field(s) \`reasoning_effort\`/\`agent_type\`/\`fallback_command\`.`);
  }
  const command = raw.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string' && part.length > 0)) {
    throw new ExecutorProfileError(`${source}: ${label} needs \`command\` as a non-empty array of strings.`);
  }
  if (raw.model != null && typeof raw.model !== 'string') {
    throw new ExecutorProfileError(`${source}: ${label} has a non-string \`model\`.`);
  }
  let resume: string[] | null = null;
  if (raw.resume != null) {
    if (!Array.isArray(raw.resume) || raw.resume.length === 0 || !raw.resume.every((part) => typeof part === 'string' && part.length > 0)) {
      throw new ExecutorProfileError(`${source}: ${label} needs \`resume\` as a non-empty array of strings.`);
    }
    resume = raw.resume as string[];
    if (!resume.some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
      throw new ExecutorProfileError(`${source}: ${label} \`resume\` must contain the ${SESSION_ID_PLACEHOLDER} placeholder.`);
    }
  }
  let sessionIdPattern: string | null = null;
  if (raw.session_id_pattern != null) {
    if (typeof raw.session_id_pattern !== 'string') {
      throw new ExecutorProfileError(`${source}: ${label} has a non-string \`session_id_pattern\`.`);
    }
    let compiled: RegExp;
    try { compiled = new RegExp(raw.session_id_pattern); } catch (err) { throw new ExecutorProfileError(`${source}: ${label} session_id_pattern did not compile: ${(err as Error).message}`); }
    if (compiled.source.indexOf('(') < 0) {
      throw new ExecutorProfileError(`${source}: ${label} session_id_pattern needs one capture group for the id.`);
    }
    sessionIdPattern = raw.session_id_pattern;
  }
  const mintsId = (command as string[]).some((part) => part.includes(SESSION_ID_PLACEHOLDER));
  if (resume != null) {
    if (mintsId && sessionIdPattern != null) {
      throw new ExecutorProfileError(`${source}: ${label} declares both a ${SESSION_ID_PLACEHOLDER} placeholder in \`command\` and a \`session_id_pattern\` — use one id source, not both.`);
    }
    if (!mintsId && sessionIdPattern == null) {
      throw new ExecutorProfileError(`${source}: ${label} declares \`resume\` but no session id source — put ${SESSION_ID_PLACEHOLDER} in \`command\` (engine-minted) or declare \`session_id_pattern\`.`);
    }
  } else if (sessionIdPattern != null || mintsId) {
    throw new ExecutorProfileError(`${source}: ${label} has a session id source but no \`resume\` — session-capable executors must declare how to resume.`);
  }
  let writeAccess: boolean | null = null;
  if (raw.write_access !== undefined) {
    if (typeof raw.write_access !== 'boolean') throw new ExecutorProfileError(`${source}: ${label} has a non-boolean \`write_access\`.`);
    writeAccess = raw.write_access;
  }
  let eligibility: Record<string, EligibilityState> = {};
  if (raw.eligibility !== undefined) {
    if (!isMapping(raw.eligibility)) throw new ExecutorProfileError(`${source}: ${label} \`eligibility\` is not a mapping.`);
    for (const [k, v] of Object.entries(raw.eligibility)) {
      if (!BARE_IDENTIFIER_RE.test(k)) throw new ExecutorProfileError(`${source}: ${label} eligibility key "${k}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      if (v !== 'eligible' && v !== 'shadow_only' && v !== 'forbidden') throw new ExecutorProfileError(`${source}: ${label} \`eligibility.${k}\` must be "eligible", "shadow_only", or "forbidden".`);
      eligibility[k] = v;
    }
  }
  let timeoutMs: number | null = null;
  if (raw.timeout_ms !== undefined) {
    const tm = raw.timeout_ms;
    if (typeof tm !== 'number' || !Number.isInteger(tm) || tm <= 0) {
      throw new ExecutorProfileError(`${source}: ${label} \`timeout_ms\` must be a positive integer (milliseconds).`);
    }
    timeoutMs = tm;
  }
  // The snapshot is the replay trust boundary: re-assert the same variant
  // invariants the catalog parse enforces, never fewer.
  let writeVariant: { command: string[]; resume: string[] | null } | null = null;
  if (raw.write_variant != null) {
    if (!isMapping(raw.write_variant)) {
      throw new ExecutorProfileError(`${source}: ${label} \`write_variant\` is not a mapping.`);
    }
    const vcmd = raw.write_variant.command;
    if (!Array.isArray(vcmd) || vcmd.length === 0 || !vcmd.every((part) => typeof part === 'string' && part.length > 0)) {
      throw new ExecutorProfileError(`${source}: ${label} \`write_variant.command\` must be a non-empty array of strings.`);
    }
    let vresume: string[] | null = null;
    if (raw.write_variant.resume != null) {
      const vrs = raw.write_variant.resume;
      if (!Array.isArray(vrs) || vrs.length === 0 || !vrs.every((part) => typeof part === 'string' && part.length > 0)) {
        throw new ExecutorProfileError(`${source}: ${label} \`write_variant.resume\` must be a non-empty array of strings.`);
      }
      if (!(vrs as string[]).some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
        throw new ExecutorProfileError(`${source}: ${label} \`write_variant.resume\` must contain ${SESSION_ID_PLACEHOLDER}.`);
      }
      vresume = vrs as string[];
    }
    const variantMintsId = (vcmd as string[]).some((part) => part.includes(SESSION_ID_PLACEHOLDER));
    if (vresume == null && variantMintsId) {
      throw new ExecutorProfileError(`${source}: ${label} \`write_variant.command\` contains ${SESSION_ID_PLACEHOLDER} but the variant declares no \`resume\` — the postured delivery would spawn the literal placeholder.`);
    }
    if (vresume != null) {
      const hasPattern = sessionIdPattern != null;
      if (variantMintsId && hasPattern) {
        throw new ExecutorProfileError(`${source}: ${label} \`write_variant\` declares both a ${SESSION_ID_PLACEHOLDER} placeholder and inherits \`session_id_pattern\` — one id source only.`);
      }
      if (!variantMintsId && !hasPattern) {
        throw new ExecutorProfileError(`${source}: ${label} \`write_variant\` declares \`resume\` but no session id source.`);
      }
    }
    writeVariant = { command: vcmd as string[], resume: vresume };
  }
  const spec: CommandExecutorSpec = {
    adapter: 'command',
    command: command as string[],
    model: typeof raw.model === 'string' ? raw.model : null,
    resume,
    sessionIdPattern,
    writeAccess,
    ...(timeoutMs != null ? { timeoutMs } : {}),
    ...(writeVariant != null ? { writeVariant } : {}),
    eligibility,
    ...(typeof raw.target === 'string' ? { target: raw.target } : {}),
    ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
    ...(typeof raw.driver === 'string' ? { driver: raw.driver } : {}),
  };
  return spec;
}

export function serializeSnapshot(profile: ExecutorProfile, extraRefs: DialRef[] = []): string {
  const seen = new Set<string>();
  const executorsMap: Record<string, ExecutorSpec> = {};
  const insertRef = (ref: DialRef) => {
    const key = formatDialRef(ref);
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const compiled = compileDialRef(ref, profile);
      executorsMap[key] = compiled.spec as ExecutorSpec;
    } catch {
      // missing route etc. — skip (should not happen for builtin)
    }
  };
  for (const name of Object.keys(profile.models).sort()) {
    if (name === 'current-host') continue;
    insertRef({ model: name });
  }
  insertRef({ model: 'current-host' });
  for (const ref of Object.values(profile.bindings)) insertRef(ref);
  for (const ref of Object.values(profile.dials)) insertRef(ref);
  for (const ref of extraRefs) insertRef(ref);

  const tools: Record<string, ToolSpec> = { ...profile.tools };

  const sortedExecutors: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(executorsMap).sort()) {
    const spec = executorsMap[name]!;
    const entry: Record<string, unknown> = spec.adapter === 'host'
      ? {
          adapter: spec.adapter,
          model: spec.model,
          reasoning_effort: spec.reasoningEffort,
          agent_type: spec.agentType,
          ...(spec.fallbackCommand != null ? { fallback_command: spec.fallbackCommand } : {}),
        }
      : { adapter: spec.adapter, command: spec.command };
    if (spec.provider != null) entry.provider = spec.provider;
    if ((spec as CommandExecutorSpec).driver != null) entry.driver = (spec as unknown as Record<string, unknown>).driver;
    if (spec.adapter === 'command' && (spec as CommandExecutorSpec).model != null) entry.model = (spec as CommandExecutorSpec).model;
    if (spec.writeAccess != null) entry.write_access = spec.writeAccess;
    if (spec.adapter === 'command' && spec.writeVariant != null) {
      entry.write_variant = {
        command: spec.writeVariant.command,
        ...(spec.writeVariant.resume != null ? { resume: spec.writeVariant.resume } : {}),
      };
    }
    if (spec.eligibility != null && Object.keys(spec.eligibility).length > 0) {
      const sortedEligibility: Record<string, EligibilityState> = {};
      for (const key of Object.keys(spec.eligibility).sort()) {
        if (typeof key !== 'string' || !Object.hasOwn(spec.eligibility, key)) continue;
        sortedEligibility[key] = spec.eligibility[key]!;
      }
      entry.eligibility = sortedEligibility;
    }
    if (spec.adapter === 'command' && (spec as CommandExecutorSpec).timeoutMs != null) entry.timeout_ms = (spec as CommandExecutorSpec).timeoutMs;
    if (spec.adapter === 'command' && spec.resume != null) entry.resume = spec.resume;
    if (spec.adapter === 'command' && spec.sessionIdPattern != null) entry.session_id_pattern = spec.sessionIdPattern;
    if (spec.adapter === 'host' && spec.target != null) entry.target = spec.target;
    if (spec.adapter === 'command' && (spec as CommandExecutorSpec).target != null) entry.target = (spec as CommandExecutorSpec).target;
    sortedExecutors[name] = entry;
  }
  const out: Record<string, unknown> = { snapshot_version: 3, executors: sortedExecutors };
  if (Object.keys(profile.bindings).length > 0) {
    const sortedBindings: Record<string, unknown> = {};
    for (const role of Object.keys(profile.bindings).sort()) {
      sortedBindings[role] = serializeDialRef(profile.bindings[role]!);
    }
    out.bindings = sortedBindings;
  }
  if (Object.keys(profile.archetypes).length > 0) {
    const sortedArchetypes: Record<string, Record<string, unknown>> = {};
    for (const name of Object.keys(profile.archetypes).sort()) {
      const policy = profile.archetypes[name]!;
      const entry: Record<string, unknown> = {};
      if (policy.requiresWrite !== 'none') entry.requires_write = policy.requiresWrite;
      if (typeof policy.fallback === 'string') entry.fallback = policy.fallback;
      if (policy.distinctProviderFromInputs != null) entry.distinct_provider_from_inputs = policy.distinctProviderFromInputs;
      if (policy.brief != null) entry.brief = policy.brief;
      sortedArchetypes[name] = entry;
    }
    out.archetypes = sortedArchetypes;
  }
  if (profile.constraints != null) out.constraints = { command: profile.constraints.command };
  if (Object.keys(tools).length > 0) {
    const sortedTools: Record<string, Record<string, unknown>> = {};
    for (const name of Object.keys(tools).sort()) {
      const spec = tools[name]!;
      const entry: Record<string, unknown> = { command: spec.command };
      if (spec.timeoutMs != null) entry.timeout_ms = spec.timeoutMs;
      sortedTools[name] = entry;
    }
    out.tools = sortedTools;
  }
  return stringifyYaml(out);
}

export function parseSnapshotDocument(text: string, source: string): SnapshotDocument {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ExecutorProfileError(`${source} did not parse: ${(err as Error).message}`);
  }
  if (!isMapping(doc)) {
    throw new ExecutorProfileError(`${source} is not a mapping.`);
  }
  if (doc.snapshot_version !== 3) {
    throw new ExecutorProfileError(`pre-dials run snapshot — this fadeno verifies snapshot_version 3 ledgers only; verify with fadeno <= 0.6.0-rc.27`);
  }
  if (!isMapping(doc.executors) || Object.keys(doc.executors).length === 0) {
    throw new ExecutorProfileError(`${source} needs a non-empty \`executors\` mapping.`);
  }
  const executors: Record<string, ExecutorSpec> = {};
  for (const [name, raw] of Object.entries(doc.executors)) {
    executors[name] = parseExecutorSpecEntry(raw, `executors.${name}`, source);
  }
  const bindings: Record<string, DialRef> = {};
  if (doc.bindings !== undefined) {
    if (!isMapping(doc.bindings)) throw new ExecutorProfileError(`${source} \`bindings\` is not a mapping (role → dial ref).`);
    for (const [role, rawRef] of Object.entries(doc.bindings)) {
      if (typeof role !== 'string' || role.length === 0) throw new ExecutorProfileError(`${source}: binding role name must be non-empty.`);
      bindings[role] = parseDialRef(rawRef, `bindings.${role}`);
    }
  }
  const archetypes: Record<string, ArchetypePolicy> = {};
  if (doc.archetypes != null) {
    if (!isMapping(doc.archetypes)) throw new ExecutorProfileError(`${source} \`archetypes\` is not a mapping.`);
    for (const [name, rawPolicy] of Object.entries(doc.archetypes)) {
      if (!BARE_IDENTIFIER_RE.test(name)) throw new ExecutorProfileError(`${source}: archetype name "${name}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      if (!isMapping(rawPolicy)) throw new ExecutorProfileError(`${source}: \`archetypes.${name}\` is not a mapping.`);
      const unknown = Object.keys(rawPolicy).filter((key) => key !== 'requires_write' && key !== 'fallback' && key !== 'distinct_provider_from_inputs' && key !== 'brief');
      if (unknown.length > 0) throw new ExecutorProfileError(`${source}: \`archetypes.${name}\` has unknown key(s) ${unknown.join(', ')}.`);
      let requiresWrite: WritePosture = 'none';
      if (rawPolicy.requires_write !== undefined) {
        if (rawPolicy.requires_write === true) requiresWrite = 'required';
        else if (rawPolicy.requires_write === false) requiresWrite = 'none';
        else if (isWritePosture(rawPolicy.requires_write)) requiresWrite = rawPolicy.requires_write;
        else throw new ExecutorProfileError(`${source}: \`archetypes.${name}.requires_write\` must be ${WRITE_POSTURE_FORMS}.`);
      }
      let fallback: string | null = null;
      if (rawPolicy.fallback != null) {
        if (typeof rawPolicy.fallback !== 'string' || !BARE_IDENTIFIER_RE.test(rawPolicy.fallback)) throw new ExecutorProfileError(`${source}: \`archetypes.${name}.fallback\` ${JSON.stringify(rawPolicy.fallback)} is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
        if (rawPolicy.fallback === name) throw new ExecutorProfileError(`${source}: \`archetypes.${name}.fallback\` may not name its own archetype.`);
        fallback = rawPolicy.fallback;
      }
      let distinctProviderFromInputs: ProviderDistinctness | null = null;
      if (rawPolicy.distinct_provider_from_inputs !== undefined) {
        if (rawPolicy.distinct_provider_from_inputs !== 'advisory' && rawPolicy.distinct_provider_from_inputs !== 'required') throw new ExecutorProfileError(`${source}: \`archetypes.${name}.distinct_provider_from_inputs\` must be "advisory" or "required".`);
        distinctProviderFromInputs = rawPolicy.distinct_provider_from_inputs;
      }
      let brief: string | null = null;
      if (rawPolicy.brief != null) {
        if (typeof rawPolicy.brief !== 'string' || !BARE_IDENTIFIER_RE.test(rawPolicy.brief)) throw new ExecutorProfileError(`${source}: \`archetypes.${name}.brief\` must be a bare lowercase identifier.`);
        brief = rawPolicy.brief;
      }
      archetypes[name] = { requiresWrite, fallback, distinctProviderFromInputs, brief };
    }
    for (const start of Object.keys(archetypes)) {
      const path: string[] = [];
      const seen = new Set<string>();
      let current: string | null = start;
      while (typeof current === 'string' && Object.hasOwn(archetypes, current)) {
        if (seen.has(current)) {
          const cycle = path.slice(path.indexOf(current)).concat(current);
          throw new ExecutorProfileError(`${source}: archetype fallback cycle: ${cycle.join(' → ')}.`);
        }
        path.push(current);
        seen.add(current);
        current = nextArchetypeFallback(archetypes, current);
      }
    }
  }
  let constraints: { command: string[] } | null = null;
  if (doc.constraints != null) {
    if (!isMapping(doc.constraints)) throw new ExecutorProfileError(`${source} \`constraints\` is not a mapping.`);
    const unknown = Object.keys(doc.constraints).filter((key) => key !== 'command');
    if (unknown.length > 0) throw new ExecutorProfileError(`${source}: \`constraints\` has unknown key(s) ${unknown.join(', ')}.`);
    const command = doc.constraints.command;
    if (!Array.isArray(command) || command.length === 0 || !command.every((p) => typeof p === 'string' && p.length > 0)) throw new ExecutorProfileError(`${source}: \`constraints.command\` must be a non-empty array of non-empty strings.`);
    constraints = { command: command as string[] };
  }
  const tools: Record<string, ToolSpec> = {};
  if ((doc as Record<string, unknown>).tools !== undefined && (doc as Record<string, unknown>).tools !== null) {
    const rawTools = (doc as Record<string, unknown>).tools;
    if (!isMapping(rawTools)) throw new ExecutorProfileError(`${source} \`tools\` is not a mapping.`);
    for (const [name, raw] of Object.entries(rawTools)) {
      if (!BARE_IDENTIFIER_RE.test(name)) throw new ExecutorProfileError(`${source}: tool name "${name}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      if (!isMapping(raw)) throw new ExecutorProfileError(`${source}: tool "${name}" is not a mapping.`);
      const unknown = Object.keys(raw).filter((k) => k !== 'command' && k !== 'timeout_ms' && k !== 'timeout');
      if (unknown.length > 0) throw new ExecutorProfileError(`${source}: tool "${name}" has unknown key(s) ${unknown.join(', ')}; only command, timeout, timeout_ms are allowed.`);
      const cmd = (raw as Record<string, unknown>).command;
      if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((p) => typeof p === 'string' && p.length > 0)) {
        throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` must be a non-empty array of non-empty strings.`);
      }
      for (const part of cmd as string[]) {
        if (part.length === 0 || part.trim().length === 0) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` contains an empty or whitespace-only string.`);
        }
        if (part.includes('{') || part.includes('}') || part.includes('$') || part.includes('`')) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` must be a static argv without interpolation or placeholders; found "${part}".`);
        }
        if (part.includes('\n') || part.includes('\0')) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`command\` contains an illegal character.`);
        }
      }
      let timeoutMs: number | null = null;
      if ((raw as Record<string, unknown>).timeout_ms !== undefined) {
        const tm = (raw as Record<string, unknown>).timeout_ms;
        if (typeof tm !== 'number' || !Number.isInteger(tm) || tm <= 0) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`timeout_ms\` must be a positive integer (milliseconds).`);
        }
        timeoutMs = tm as number;
      }
      if ((raw as Record<string, unknown>).timeout !== undefined) {
        if (timeoutMs != null) throw new ExecutorProfileError(`${source}: tool "${name}" has both timeout and timeout_ms — use one.`);
        const tm = (raw as Record<string, unknown>).timeout;
        if (typeof tm !== 'number' || !Number.isInteger(tm) || tm <= 0) {
          throw new ExecutorProfileError(`${source}: tool "${name}" \`timeout\` must be a positive integer (seconds).`);
        }
        timeoutMs = (tm as number) * 1000;
      }
      tools[name] = { command: cmd as string[], ...(timeoutMs != null ? { timeoutMs } : {}) };
    }
  }
  const allowed = ['snapshot_version','executors','bindings','archetypes','constraints','tools'];
  const unknownTop = Object.keys(doc).filter((k) => !allowed.includes(k));
  if (unknownTop.length > 0) throw new ExecutorProfileError(`${source} has unknown key(s) ${unknownTop.join(', ')}.`);
  return { executors, bindings, archetypes, constraints, tools };
}

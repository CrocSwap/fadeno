import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadLayeredProfile, type ModelFallbackOutcome, type ProfileProvenance } from './config-layers.ts';
import { type FadenoHarness, type UserPathOptions } from './user-paths.ts';

export class ExecutorProfileError extends Error {}

/** Bare lowercase identifier: dial targets, archetype keys, role archetypes. */
// schema_version: 4 — harness-keyed catalog (pre-dials catalogs refused; a v3
// layer loads only when it declares none of the removed keys)
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
   * Per-archetype eligibility of this delivery. Absent YAML is `{}`
   * (every archetype `eligible`).
   */
  eligibility: Record<string, EligibilityState>;
  /** Neutral v2 target metadata; absent for legacy v1 executors. */
  target?: string;
  provider?: string;
  /** v4 compiled executor harness id (for snapshot passthrough). */
  harness?: string;
  /** v4 compiled command-lane variant, when policy chose a named one. */
  variant?: string;
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
   * Per-archetype eligibility of this delivery. Absent YAML is `{}`
   * (every archetype `eligible`).
   */
  eligibility: Record<string, EligibilityState>;
  /** Neutral v2 target metadata; absent for legacy v1 executors. */
  target?: string;
  provider?: string;
  harness?: string;
  variant?: string;
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
 * Placeholder for harnesses whose CLI can only read a prompt from a regular
 * file (Muse Code refuses /dev/stdin, bare stdin, and `-` — verified live
 * 2026-08-16). Substituted at spawn time with the absolute path of the
 * kernel's attested prompt snapshot, so the digest attests exactly the bytes
 * the executor reads. Stdin is still piped alongside; a file-reading executor
 * simply ignores it.
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

/**
 * The three role archetypes every profile has whether or not it says so:
 * `fadeno init` scaffolds a role subagent and a dispatch proxy for each, and
 * the plugins ship them.
 */
export const ROLE_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

/**
 * Every archetype name a profile KNOWS, as opposed to every name it DECLARES.
 *
 * `profile.archetypes` is a policy overlay: an archetype earns an entry by
 * having something non-default to say (`requires_write`, `brief`, `fallback`).
 * The builtin catalog therefore declares `worker`, `director` and `generator`
 * and stays silent about `reviewer` and `judge`, whose posture is entirely
 * default — they are no less real for it.
 *
 * Reading the overlay as the registry is a live bug this codebase has already
 * shipped: `runLockedSteeringResolve` refused every locked host dispatch for
 * `reviewer` and `judge` with "undeclared archetype", so a Codex reviewer
 * agent that correctly consulted steering was pushed onto the command lane
 * (2026-08-21, polymarket-quoter). Every OTHER reader — `dispatch.ts`,
 * `drive.ts`, the fallback walk — already treats absence as "no declared
 * policy, use defaults", which is the correct reading.
 *
 * Pass dial layers as `extra` where a name may exist only by being dialed.
 */
export function knownArchetypes(
  archetypes: Record<string, unknown>,
  ...extra: Array<Record<string, unknown> | undefined | null>
): Set<string> {
  const names = new Set<string>(ROLE_ARCHETYPES);
  for (const key of Object.keys(archetypes)) names.add(key);
  for (const layer of extra) {
    if (layer != null) for (const key of Object.keys(layer)) names.add(key);
  }
  return names;
}

export function archetypeDisplaySort(names: Iterable<string>): string[] {
  const rank = new Map<string, number>(ARCHETYPE_DISPLAY_ORDER.map((name, index) => [name, index]));
  return [...names].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

/** Whether an archetype's delivery provider must differ from every input producer. */
export type ProviderDistinctness = 'advisory' | 'required';

/**
 * Whether an archetype's *gitignored* output has to survive the dispatch.
 *
 * Consumed at pair materialization, and says only whether the files
 * `.gitignore` excludes are load-bearing product: a shadow pair runs each arm
 * in its own worktree and merges the primary's work back through a
 * `git add -A` diff, which drops every ignored path. `kept` therefore means
 * "a pair would destroy this dispatch's output" — lose the comparison, never
 * the work. Not `worktree_carry`, which is the opposite direction: ignored
 * files copied *into* a worktree before the arm runs.
 */
export type IgnoredOutputPolicy = 'kept' | 'discardable';

/**
 * What an archetype needs from whatever delivers it. Declared once per
 * archetype, independent of which executor a dial binds today.
 * `fallback` selects another archetype's *binding* only — never its policy.
 *
 * Note what is NOT here: a write posture. Fadeno does not enforce write
 * permissions, so an archetype does not declare a demand for the resolver to
 * match against a route's claimed capability — that negotiation is removed.
 * See docs/experimental/permissions-and-isolation.md.
 */
export interface ArchetypePolicy {
  /**
   * Whether this archetype's gitignored output must survive. Absent YAML is
   * `'discardable'`. Read at pair formation, never at resolution.
   */
  ignoredOutput: IgnoredOutputPolicy;
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

/**
 * Who runs an archetype, and optionally which harness runs it.
 *
 * A dial names a model, an optional effort, and an optional executor
 * `harness`. It never names a lane, a driver, or an argv: the HOST harness is
 * discovered at dispatch time from ambient signals, and the pair
 * *(dial harness, host)* plus policy decides the lane.
 */
export interface DialRef {
  model: string;
  effort?: string;
  /** Executor harness id. Absent = the model's home harness. */
  harness?: string;
}

/**
 * Legacy `--via <driver>` names, mapped to the v4 harness they always were.
 *
 * READ ONLY. `parseDialRef` accepts a persisted ` via <driver>` and translates
 * it; nothing in this codebase ever emits one again. The variant half of a
 * driver name (`claude-exec`, `opencode-direct`) is deliberately dropped: a
 * variant is chosen by policy under v4, not named on a dial, so a legacy ref
 * that carried one formats differently afterwards — which re-rolls a shadow
 * sample keyed on the challenger string. See CHANGELOG.
 */
const LEGACY_DRIVER_HARNESS: Readonly<Record<string, string>> = {
  'claude-exec': 'claude',
  'claude-cli': 'claude',
  'opencode-direct': 'opencode',
  'muse-code': 'muse',
};

/** Translate a legacy driver alias to its harness id; unknown names pass through. */
export function legacyDriverHarness(driver: string): string {
  return LEGACY_DRIVER_HARNESS[driver] ?? driver;
}

/** The ` on <harness>` separator in the dial-ref string grammar. */
const ON_SEPARATOR = ' on ';
/** The legacy ` via <driver>` separator, accepted on read only. */
const VIA_SEPARATOR = ' via ';

export function parseDialRef(raw: unknown, label: string): DialRef {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ExecutorProfileError(`${label} is an empty string — expected "model" or "model@effort".`);
    }
    let harness: string | undefined;
    let core = trimmed;
    const onIdx = trimmed.indexOf(ON_SEPARATOR);
    const viaIdx = trimmed.indexOf(VIA_SEPARATOR);
    if (onIdx >= 0) {
      core = trimmed.slice(0, onIdx).trim();
      const named = trimmed.slice(onIdx + ON_SEPARATOR.length).trim();
      if (named.length === 0) {
        throw new ExecutorProfileError(`${label} has empty harness after " on ".`);
      }
      if (!BARE_IDENTIFIER_RE.test(named)) {
        throw new ExecutorProfileError(`${label} harness "${named}" is not a bare identifier.`);
      }
      harness = named;
    } else if (viaIdx >= 0) {
      // Legacy read: `model via <driver>` → `{ harness }`. Never emitted back.
      core = trimmed.slice(0, viaIdx).trim();
      const driver = trimmed.slice(viaIdx + VIA_SEPARATOR.length).trim();
      if (driver.length === 0) {
        throw new ExecutorProfileError(`${label} has empty driver after " via " (legacy form; use " on <harness>").`);
      }
      if (!BARE_IDENTIFIER_RE.test(driver)) {
        throw new ExecutorProfileError(`${label} driver "${driver}" is not a bare identifier.`);
      }
      harness = legacyDriverHarness(driver);
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
      if (harness) out.harness = harness;
      return out;
    }
    if (core.includes(' ') || core.includes('@')) {
      throw new ExecutorProfileError(`${label} "${raw}" is not a valid dial ref.`);
    }
    const out: DialRef = { model: core };
    if (harness) out.harness = harness;
    return out;
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>;
    const model = map.model;
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new ExecutorProfileError(`${label} mapping needs a non-empty "model" string.`);
    }
    const trimmedModel = model.trim();
    if (trimmedModel.includes(' ')) {
      throw new ExecutorProfileError(`${label} model "${trimmedModel}" contains whitespace.`);
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
    if (map.harness !== undefined) {
      if (typeof map.harness !== 'string' || map.harness.trim().length === 0) {
        throw new ExecutorProfileError(`${label} "harness" must be a non-empty string.`);
      }
      out.harness = map.harness.trim();
    }
    if (map.via !== undefined) {
      // Legacy mapping form, accepted on read only.
      if (typeof map.via !== 'string' || map.via.trim().length === 0) {
        throw new ExecutorProfileError(`${label} "via" must be a non-empty string.`);
      }
      if (out.harness == null) out.harness = legacyDriverHarness(map.via.trim());
    }
    if (map.force_write_posture !== undefined) {
      throw new ExecutorProfileError(
        `${label} "force_write_posture" is no longer supported — there is no write-posture guard left to ` +
          'override. See docs/experimental/permissions-and-isolation.md.',
      );
    }
    const unknown = Object.keys(map).filter((k) => k !== 'model' && k !== 'effort' && k !== 'harness' && k !== 'via');
    if (unknown.length > 0) {
      throw new ExecutorProfileError(`${label} has unknown key(s) ${unknown.join(', ')}; only model, effort, harness are allowed.`);
    }
    return out;
  }
  throw new ExecutorProfileError(`${label} must be a string "model[@effort][ on <harness>]" or a mapping {model, effort?, harness?}.`);
}

export function formatDialRef(ref: DialRef): string {
  let base = ref.model;
  if (ref.effort != null && ref.effort.length > 0) base += `@${ref.effort}`;
  if (ref.harness != null && ref.harness.length > 0) base += `${ON_SEPARATOR}${ref.harness}`;
  return base;
}

/** Every ref is a compact scalar now that nothing needs an explicit override form. */
export function serializeDialRef(ref: DialRef): string | Record<string, unknown> {
  return formatDialRef(ref);
}

export interface ModelEntry {
  provider: string;
  id: string;
  effort: string;
  /** Provider-facing id per HARNESS (v4; was per driver). */
  spellings: Record<string, string>;
  eligibility: Record<string, EligibilityState>;
  /**
   * An explicit non-home harness for this model. A promoted model's delivery
   * can differ from its upstream provider's home harness; `provider` + `id`
   * remain the canonical identity shown in the registry, and the
   * harness-facing spelling lives in `spellings.<harness>`.
   *
   * Replaces v3's `delivery: { route, id }`.
   */
  harness?: string;
}

/** One command lane of a harness: the base `command:` or a named variant. */
export interface HarnessLaneRaw {
  command: string[];
  timeout_ms?: number | null;
  resume?: string[] | null;
  session_id_pattern?: string | null;
  /**
   * Per-archetype eligibility of every delivery through THIS lane, merged
   * with model-level eligibility (strictest wins). This is how a catalog says
   * "this lane cannot carry a director": the constraint is structural — it
   * covers unregistered models falling through to the lane too. A variant
   * does NOT inherit the base lane's eligibility; each lane states its own,
   * exactly as each v3 route did.
   */
  eligibility?: Record<string, EligibilityState>;
}

/** The in-session half of a harness: what it can deliver without spawning. */
export interface HarnessHostRaw {
  /**
   * How this harness's agent definition carries a reasoning effort.
   * `none` — no channel at all, so a pinned effort ejects to the command
   * lane. `agent-file` — the materialized agent file carries it, so
   * `fadeno steering apply` can pin it and the host lane survives.
   *
   * A property of the FORMAT, not a preference: a Codex agent TOML has a
   * `model_reasoning_effort` key; Claude's Agent tool has no effort channel.
   */
  effort_channel: 'none' | 'agent-file';
  /**
   * WHOSE identity the host lane can deliver.
   *
   * `model` (the default) — the host can be told which model to run: Codex
   * bakes it into the agent TOML, Claude's spawn hook rewrites the tool call.
   * A named model on this harness is a host candidate.
   *
   * `session` — the host lane delivers the SESSION's own identity and nothing
   * else. OpenCode's plugin and omp's extension rewrite only the agent name
   * (`applyRewrite` sets `subagent_type`; the omp extension sets `agent`), so
   * a dialed model handed to a host spawn there is silently ignored. Under
   * `session` only `current-host` — which IS the session's identity — takes
   * the host lane; a named model on this harness is a command delivery, which
   * is what v3's `routes.opencode` / `routes.omp` expressed by putting
   * `host: true` on `current-host` alone.
   *
   * The knob is on the harness because it is a fact about that harness's
   * adapter, not about any dial.
   */
  identity: 'model' | 'session';
  /**
   * The relay identity for this harness — the cheap model that reads a
   * resolver answer and forwards a delivery, doing none of the role work
   * itself (Codex's command broker, Claude's dispatch proxies).
   *
   * Deliberately NOT an archetype: canonical status is earned by a policy the
   * kernel enforces, and a relay carries none. Absent means "no catalog
   * opinion" — the caller keeps its own built-in default rather than being
   * handed a model the provider may not serve.
   */
  relay?: DialRef;
  /** Per-archetype eligibility of the HOST lane only. */
  eligibility?: Record<string, EligibilityState>;
}

/**
 * One harness. A harness is a HOST (Fadeno can run inside it) when it declares
 * `host:`, and an EXECUTOR (Fadeno can spawn it) when it declares `command:`.
 * Most are both. At least one is required.
 */
export interface HarnessRaw {
  /** Home provider: models of this provider default to this harness. */
  provider?: string;
  host?: HarnessHostRaw;
  /**
   * The base command lane, in the SAME shape a variant has — so the parser
   * reads one thing and `commandLanes` re-packs nothing. The YAML flattens it
   * (`command:`, `timeout_ms:`, `eligibility:` sit at harness level, because
   * a harness with one lane should not have to nest it), and this is where
   * that flattening ends.
   */
  command?: HarnessLaneRaw | null;
  /**
   * The base command lane's eligibility when there is NO `command:` — kept
   * only so the loader can refuse the inert placement by name instead of
   * dropping it. A declared lane carries its own inside `command`.
   */
  eligibility?: Record<string, EligibilityState>;
  models_command?: string[] | null;
  /**
   * Deliberately normalized from YAML's `models_prefix` even though most
   * HarnessRaw fields retain their YAML spelling: consumers use this only as a
   * derived listing qualifier, never as an argv template field.
   */
  modelsPrefix?: string;
  effort_encoding?: 'flag' | 'model-suffix';
  /** Named alternative argvs of this harness's command lane, chosen by policy. */
  variants?: Record<string, HarnessLaneRaw>;
}

/**
 * The identity a harness's `models_command` prints for one argv-facing model
 * id. This is deliberately separate from command substitution: OpenCode's
 * OpenRouter listing includes `openrouter/`, while its `-m` argument must not
 * receive that prefix twice.
 */
export function qualifyListedModelId(harness: HarnessRaw | null | undefined, modelId: string): string {
  const prefix = harness?.modelsPrefix;
  if (prefix == null || modelId.startsWith(prefix)) return modelId;
  return `${prefix}${modelId}`;
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
  /**
   * The EXECUTOR harness this delivery resolved onto (was `driver`).
   *
   * `null` only for `current-host` with no host: the base dial names whatever
   * session is running, and in a bare shell there is none. Naming a harness
   * there — `standalone`, say — would print a value that is not in the table.
   */
  harness: string | null;
  /** The named command-lane variant policy chose, or null for the base lane. */
  variant: string | null;
  /**
   * Whether this delivery is a candidate for the HOST lane: its harness is the
   * host this call runs inside, that harness declares `host:`, and the host
   * lane's eligibility permits the archetype.
   *
   * Not the same as `spec.adapter === 'host'`. A host spec is also how a
   * delivery with NO command argv is represented (`current-host` in a bare
   * shell, a host-only harness named from a different host) — there is nothing
   * to spawn, so the honest answer is "start a session inside it", which
   * `decideLane` renders as `restart_required`. Pass THIS field as
   * `decideLane`'s `hostModel`, never `deliveryIsHost`.
   */
  hostCandidate: boolean;
  registered: boolean;
}

export function deliveryIsHost(compiled: CompiledDelivery): boolean {
  return compiled.spec.adapter === 'host';
}

/**
 * Whether a delivery can go out IN-SESSION — the one question every host-slot
 * decision has to ask, answered the same way in every caller.
 *
 * A LIVE compile knows the host, so it answers from `hostCandidate`, which
 * folds in `harness === host`, the harness declaring `host:`, its
 * `identity:`, and the host lane's eligibility. `spec.adapter === 'host'` is
 * NOT that question: a host spec is also how a delivery with no argv at all is
 * represented (`current-host` in a bare shell, a host-only harness named from
 * a different host), so the two disagree exactly there — which is how
 * `steering apply --codex` came to write a Codex host agent for `opus on omp`.
 *
 * A SNAPSHOT spec has no live host to compare against: the run froze the
 * answer when it was cut, and `adapter: 'host'` IS that frozen answer. Passing
 * `null` says "this is a replay", and the frozen answer stands.
 */
export function hostCandidateOf(compiled: CompiledDelivery | null, spec: ExecutorSpec): boolean {
  return compiled != null ? compiled.hostCandidate : spec.adapter === 'host';
}

export interface ToolSpec {
  command: string[];
  timeoutMs?: number | null;
}

export interface ExecutorProfile {
  models: Record<string, ModelEntry>;
  /**
   * One table, keyed by harness id — the v4 replacement for the six
   * near-identical `routes.<host>` tables. A harness's argv does not depend on
   * which harness is doing the invoking, and the one bit that used to differ
   * (`host: true`) is exactly "dial harness == host harness", decided at
   * dispatch time rather than stored.
   */
  harnesses: Record<string, HarnessRaw>;
  bindings: Record<string, DialRef>;
  dials: Record<string, DialRef>;
  archetypes: Record<string, ArchetypePolicy>;
  constraints: { command: string[] } | null;
  unregisteredModelHarness: string;
  /** The HOST: the harness this call is running inside. */
  host?: HarnessId;
  schemaVersion?: 4;
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
  /**
   * Repo-relative files where a value must appear to count as having REACHED
   * a consumer. Project-only, for the same reason as `worktree_carry`: it
   * describes this repo's shape, and a builtin guess would be wrong
   * everywhere.
   *
   * For Fadeno the surface is `src/cli.ts`, which builds its printed JSON
   * field by field — an agent reads that stdout and nothing else. A field
   * computed in a command, documented as the thing a coordinator MUST check,
   * and never added to that object is inert end to end, which is exactly what
   * shipped in shadow pair 89536181 with 1282 green tests.
   *
   * Empty means undeclared, and `fadeno bakeoff` then reports the reach
   * signal as `null` rather than as an empty list of failures — absent a
   * declaration it cannot tell "reached nothing" from "nothing to reach".
   */
  surfaces: string[];
}

export type HarnessId = 'codex' | 'claude' | 'grok' | 'opencode' | 'omp' | 'standalone';

/**
 * Whether THIS catalog says the named harness's agent-definition format can
 * carry a reasoning effort, so `fadeno steering apply` can materialize a host
 * slot AT a dialed `@effort`.
 *
 * Read off `harnesses.<id>.host.effort_channel` rather than hardcoded: the
 * fact is a property of the harness's FORMAT, and the catalog is where a
 * harness is described. Where it is false, `steering apply` writes no host
 * agent file (it has nothing to write that would change delivery), a pinned
 * effort instead selects the LANE via `decideLane`, and telling the user to
 * run apply would send them to a command that does nothing.
 */
export function hostEffortIsMaterializable(profile: ExecutorProfile, harness: string): boolean {
  return profile.harnesses?.[harness]?.host?.effort_channel === 'agent-file';
}

/**
 * The host this call is running inside: `FADENO_HARNESS` → ambient markers →
 * `standalone`. Nothing on disk participates.
 *
 * There is no default harness and no stored one. Both surviving inputs are set
 * by a host at call time — `FADENO_HARNESS` by an in-harness adapter (the
 * Claude PreToolUse hook, the OpenCode plugin, the omp extension, the bundled
 * plugin launcher), the markers in `AMBIENT_HARNESS_MARKERS` by the harness
 * process itself — so a bare shell answers `standalone`, which is the honest
 * answer rather than a fallback.
 *
 * This used to end at a memo written by `fadeno setup --codex/--claude`, and
 * that was wrong in the way that is hard to see: people swap harnesses
 * constantly, so the memo made every bare-shell call compile some *other*
 * session's host lane — inventing a host where the run had none. Ambient
 * detection abstains when two hosts both claim the session (nested), and
 * abstaining now means `standalone` too: a coin-flip between two real hosts is
 * no better than a remembered one. Set `FADENO_HARNESS` to say which.
 */
export function activeHarness(explicit?: HarnessId, options: UserPathOptions = {}): HarnessId {
  if (explicit != null) return explicit;
  const raw = (options.env ?? process.env).FADENO_HARNESS?.trim();
  if (raw === 'codex' || raw === 'claude' || raw === 'grok' || raw === 'opencode' || raw === 'omp' || raw === 'standalone') return raw;
  return detectAmbientHarness(options).harness ?? 'standalone';
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

/**
 * Names the dispatch an executor is running as. Pure provenance: any `fadeno`
 * the executor runs — at any depth — can say which dispatch it is inside.
 */
export const IN_DISPATCH_ENV = 'FADENO_IN_DISPATCH';

/**
 * Whether the executor reading it may dispatch again. `allow` or `deny`, and
 * always written rather than merely omitted: a director's executor carries
 * `allow`, and the workers *it* dispatches must not inherit that.
 */
export const DISPATCH_NESTING_ENV = 'FADENO_DISPATCH_NESTING';

/**
 * Archetypes whose executor is *told* to coordinate through fadeno, so a
 * nested dispatch from inside their workspace is the design rather than an
 * accident. `director` earns it through its brief
 * (`archetypes.director.brief: director`), which teaches the spawned model to
 * decompose and delegate instead of doing the work itself.
 *
 * Every other archetype re-dispatching is the 2026-08-31 dogfood failure:
 * proxies relay their prompt byte-for-byte, so a prompt addressed to the
 * *proxy* ("dispatch a fadeno worker… use tag X") arrives at the executor as
 * its own instructions, and it runs `fadeno dispatch` inside its own worktree.
 */
export const COORDINATING_ARCHETYPES: ReadonlySet<string> = new Set(['director']);

/**
 * Stamp an executor's environment with which dispatch it is, and whether it
 * may start another. The mirror of `FADENO_IN_SHADOW`, which has ridden along
 * to challengers for the same reason since shadow pairs shipped.
 */
export function withDispatchProvenance(
  env: NodeJS.ProcessEnv,
  identity: { dispatchId: string; archetype: string | null },
): NodeJS.ProcessEnv {
  return {
    ...env,
    [IN_DISPATCH_ENV]: identity.dispatchId,
    [DISPATCH_NESTING_ENV]:
      identity.archetype != null && COORDINATING_ARCHETYPES.has(identity.archetype) ? 'allow' : 'deny',
  };
}

export interface LoadedExecutorProfile {
  profile: ExecutorProfile;
  path: string;
  layers?: Array<'builtin' | 'user' | 'project'>;
  selfContained?: boolean;
  provenance?: ProfileProvenance;
  /**
   * Per-key user-model fallback outcomes under a self-contained project
   * catalog (config-layers). Absent on loaders that predate the field.
   */
  modelFallback?: ModelFallbackOutcome;
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
  'harnesses',
  'bindings',
  'dials',
  'archetypes',
  'constraints',
  'unregistered_model_harness',
  'tools',
  'worktree_carry',
  'surfaces',
] as const;

export type CatalogTopLevelKey = (typeof CATALOG_TOP_LEVEL_KEYS)[number];

/**
 * Keys catalog v4 removed, and the v4 spelling each one became.
 *
 * A `schema_version: 3` layer still loads — a personal `models:`-only catalog
 * is not made wrong by the bump — but only if it declares NONE of these. A
 * layer that does gets the migration note naming the key, the same posture the
 * v2→v3 bump took, rather than having its declaration silently dropped by the
 * selective merge.
 */
export const V4_REMOVED_CATALOG_KEYS: Readonly<Record<string, string>> = {
  routes: 'harnesses: (one table keyed by harness id; `host: true` is gone — the host is discovered at dispatch time)',
  relay: 'harnesses.<id>.host.relay',
  unregistered_model_driver: 'unregistered_model_harness',
};

/** The one migration message a v3-shaped catalog key gets, wherever it is noticed. */
export function v4MigrationError(source: string, key: string, detail?: string): ExecutorProfileError {
  const replacement = V4_REMOVED_CATALOG_KEYS[key] ?? detail ?? '';
  return new ExecutorProfileError(
    `${source}: \`${key}\` was removed in catalog v4 — use ${replacement}. ` +
      'See docs/experimental/harness-neutral-dials.md.',
  );
}

/**
 * Pre-dials (schema_version < 3) top-level keys. Not allowed, but not
 * "unknown" either: they are recognized purely so a legacy catalog keeps
 * getting the migration instructions instead of a did-you-mean guess.
 */
export const PRE_DIALS_CATALOG_KEYS = ['executors', 'targets', 'loadouts', 'default_loadout'] as const;

/** The one migration message a pre-dials catalog gets, wherever it is noticed. */
export function preDialsCatalogError(source: string): ExecutorProfileError {
  return new ExecutorProfileError(
    `${source}: schema_version 4 required — pre-dials catalogs are not supported; migrate: targets:→models:, loadouts:→dials:, default_loadout: delete; routes:→harnesses:; see docs/experimental/harness-neutral-dials.md`,
  );
}

/**
 * Refuse a document that declares anything catalog v4 removed.
 *
 * Run on every layer, whatever version it claims: a `schema_version: 3` layer
 * that declares none of these still loads (the bump is about the harness
 * table, and a personal `models:`-only catalog written before it is not
 * thereby wrong), and a layer that DOES declare one gets the migration note
 * naming the key — rather than an unknown-key message that says nothing about
 * why it went away or what replaced it.
 */
export function refuseRemovedCatalogKeys(doc: Record<string, unknown>, source: string): void {
  for (const key of Object.keys(V4_REMOVED_CATALOG_KEYS)) {
    if (doc[key] !== undefined) throw v4MigrationError(source, key);
  }
  const models = doc.models;
  if (models !== null && typeof models === 'object' && !Array.isArray(models)) {
    for (const [name, raw] of Object.entries(models as Record<string, unknown>)) {
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).delivery !== undefined) {
        throw v4MigrationError(source, 'delivery', `\`models.${name}.harness\` plus \`models.${name}.spellings.<harness>\``);
      }
    }
  }
  for (const section of ['dials', 'bindings'] as const) {
    const table = doc[section];
    if (table === null || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const [name, raw] of Object.entries(table as Record<string, unknown>)) {
      const carriesVia = typeof raw === 'string'
        ? raw.includes(VIA_SEPARATOR)
        : raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).via !== undefined;
      if (carriesVia) {
        throw v4MigrationError(source, 'via', `\`${section}.${name}\` written as "model[@effort] on <harness>" (or \`harness:\` in mapping form)`);
      }
    }
  }
}

/** Levenshtein distance, iterative two-row form. */
export function editDistance(a: string, b: string): number {
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

/**
 * Keys an `archetypes.<name>` mapping may declare. Both parse sites — the
 * catalog parser and the snapshot reader — filter against this one list, so a
 * key added here can never be accepted by one and rejected by the other.
 */
const ARCHETYPE_POLICY_KEYS: readonly string[] = [
  // Deliberately still "known" so the tailored migration error below is the
  // one a reader sees, instead of a generic unknown-key message that says
  // nothing about WHY the key went away or what replaced it. It is refused
  // either way; this only decides which explanation they get.
  'requires_write',
  'ignored_output',
  'fallback',
  'distinct_provider_from_inputs',
  'brief',
];

/** The same list as prose, for the catalog parser's messages. */
const ARCHETYPE_POLICY_KEY_FORMS =
  '`ignored_output`, `fallback`, `distinct_provider_from_inputs`, and `brief`';

function unknownArchetypeKeys(rawPolicy: Record<string, unknown>): string[] {
  return Object.keys(rawPolicy).filter((key) => !ARCHETYPE_POLICY_KEYS.includes(key));
}

const IGNORED_OUTPUT_FORMS = '"kept" or "discardable"';

/**
 * Shared by both parse sites. Absent is `'discardable'`; unlike
 * `requires_write` there is no boolean spelling, because "true" reads as
 * neither value.
 */
function parseIgnoredOutput(raw: unknown, source: string, name: string): IgnoredOutputPolicy {
  if (raw === undefined) return 'discardable';
  if (raw === 'kept' || raw === 'discardable') return raw;
  throw new ExecutorProfileError(
    `${source}: \`archetypes.${name}.ignored_output\` must be ${IGNORED_OUTPUT_FORMS}.`,
  );
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

/**
 * Parse + structurally validate an executor profile document.
 *
 * `host` is the harness this call is running INSIDE — used only to answer
 * "same harness?" at resolution time. Nothing about the catalog itself varies
 * with it.
 */
export function parseExecutorProfile(text: string, source: string, host: HarnessId = 'standalone'): ExecutorProfile {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ExecutorProfileError(`${source} did not parse: ${(err as Error).message}`);
  }
  if (!isMapping(doc)) {
    throw new ExecutorProfileError(`${source} is not a mapping.`);
  }
  // v4, or a v3 document that declares nothing v4 removed. Anything older is
  // pre-dials and gets the migration instructions.
  if (doc.schema_version === 3) {
    refuseRemovedCatalogKeys(doc, source);
  } else if (doc.schema_version !== 4) {
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
        throw new ExecutorProfileError(`${source}: model "${name}" \`spellings\` is not a mapping (harness → id).`);
      }
      for (const [harnessKey, sid] of Object.entries(raw.spellings)) {
        if (typeof sid !== 'string' || sid.trim().length === 0) {
          throw new ExecutorProfileError(`${source}: model "${name}" spelling for harness "${harnessKey}" must be a non-empty string.`);
        }
        spellings[harnessKey] = sid.trim();
      }
    }
    if (raw.delivery !== undefined) {
      throw v4MigrationError(source, 'delivery', `\`models.${name}.harness\` plus \`models.${name}.spellings.<harness>\``);
    }
    let modelHarness: string | undefined;
    if (raw.harness !== undefined) {
      if (typeof raw.harness !== 'string' || !BARE_IDENTIFIER_RE.test(raw.harness.trim())) {
        throw new ExecutorProfileError(`${source}: model "${name}" \`harness\` must be a bare lowercase identifier naming a harness (${BARE_IDENTIFIER_RE.source}).`);
      }
      modelHarness = raw.harness.trim();
    }
    const eligibility = readEligibility(raw as Record<string, unknown>, `model "${name}"`, source);
    const unknown = Object.keys(raw).filter((k) => !['provider', 'id', 'effort', 'spellings', 'eligibility', 'harness'].includes(k));
    if (unknown.length > 0) {
      throw new ExecutorProfileError(`${source}: model "${name}" has unknown key(s) ${unknown.join(', ')}; only provider, id, effort, spellings, eligibility, harness are allowed.`);
    }
    models[name] = { provider: prov, id, effort, spellings, eligibility, ...(modelHarness != null ? { harness: modelHarness } : {}) };
  }
  models['current-host'] = { provider: 'current-host', id: 'current-host', effort: 'default', spellings: {}, eligibility: {} };

  // harnesses — ONE table, keyed by harness id.
  const harnesses: Record<string, HarnessRaw> = {};
  if (doc.routes !== undefined) throw v4MigrationError(source, 'routes');
  if (doc.harnesses !== undefined) {
    if (doc.schema_version !== 4) {
      throw new ExecutorProfileError(
        `${source}: \`harnesses:\` requires \`schema_version: 4\` (found ${JSON.stringify(doc.schema_version)}).`,
      );
    }
    if (!isMapping(doc.harnesses)) {
      throw new ExecutorProfileError(`${source} \`harnesses\` is not a mapping (harness id → harness).`);
    }
    for (const [harnessKey, rawHarness] of Object.entries(doc.harnesses)) {
      if (!BARE_IDENTIFIER_RE.test(harnessKey)) {
        throw new ExecutorProfileError(`${source}: harness id "${harnessKey}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      }
      if (harnessKey === 'standalone') {
        // `standalone` is the NO-host value, not a harness: it is what
        // `activeHarness()` answers when nothing claims the session. A
        // `harnesses.standalone` entry would make every bare shell a host
        // candidate and `current-host` deliverable with no session to deliver
        // into — the exact pretence v4 removed.
        throw new ExecutorProfileError(
          `${source}: \`harnesses.standalone\` is not a harness — \`standalone\` is the value \`host\` takes when NO harness claims the session, so there is nothing there to run inside.`,
        );
      }
      if (!isMapping(rawHarness)) {
        throw new ExecutorProfileError(`${source}: \`harnesses.${harnessKey}\` is not a mapping.`);
      }
      const label = `\`harnesses.${harnessKey}\``;
      const entry: HarnessRaw = {};
      if (rawHarness.provider !== undefined) {
        if (typeof rawHarness.provider !== 'string' || rawHarness.provider.trim().length === 0) {
          throw new ExecutorProfileError(`${source}: ${label}.provider must be a non-empty string.`);
        }
        entry.provider = rawHarness.provider.trim();
      }
      if (rawHarness.host !== undefined) {
        if (rawHarness.host === true || rawHarness.host === false) {
          throw v4MigrationError(source, 'host: true', 'a `host:` mapping (`{ effort_channel, relay?, eligibility? }`) — the boolean said "this route is the host", which v4 decides at dispatch time');
        }
        if (!isMapping(rawHarness.host)) {
          throw new ExecutorProfileError(`${source}: ${label}.host is not a mapping ({effort_channel, relay?, eligibility?}).`);
        }
        const rawHost = rawHarness.host;
        const channel = rawHost.effort_channel ?? 'none';
        if (channel !== 'none' && channel !== 'agent-file') {
          throw new ExecutorProfileError(`${source}: ${label}.host.effort_channel must be "none" or "agent-file".`);
        }
        const identity = rawHost.identity ?? 'model';
        if (identity !== 'model' && identity !== 'session') {
          throw new ExecutorProfileError(`${source}: ${label}.host.identity must be "model" or "session".`);
        }
        const hostEntry: HarnessHostRaw = { effort_channel: channel, identity };
        if (rawHost.relay !== undefined) {
          hostEntry.relay = parseDialRef(rawHost.relay, `${source}: ${label}.host.relay`);
        }
        const hostEligibility = readEligibility(rawHost as Record<string, unknown>, `${label}.host`, source);
        if (Object.keys(hostEligibility).length > 0) hostEntry.eligibility = hostEligibility;
        const unknownHost = Object.keys(rawHost).filter((k) => !['effort_channel', 'identity', 'relay', 'eligibility'].includes(k));
        if (unknownHost.length > 0) {
          throw new ExecutorProfileError(`${source}: ${label}.host has unknown key(s) ${unknownHost.join(', ')}; only effort_channel, identity, relay, eligibility are allowed.`);
        }
        entry.host = hostEntry;
      }
      if (rawHarness.driver !== undefined) {
        throw v4MigrationError(source, 'driver', `the harness id itself (\`harnesses.${harnessKey}\`)`);
      }
      if (rawHarness.write_variant !== undefined || rawHarness.write_access !== undefined) {
        const key = rawHarness.write_variant !== undefined ? 'write_variant' : 'write_access';
        throw new ExecutorProfileError(
          `${source}: ${label}.${key} is no longer supported. A harness lane is an argv and nothing more: declare ` +
            'the command you want to run, and express any restriction as a SEPARATE named variant so it is visible ' +
            'in the argv rather than in metadata. Containment is isolated worktrees, now the default for command ' +
            'dispatches — see docs/experimental/permissions-and-isolation.md.',
        );
      }
      if (rawHarness.models_command !== undefined) {
        const mc = rawHarness.models_command;
        if (!Array.isArray(mc) || mc.length === 0 || !mc.every((p) => typeof p === 'string' && p.length > 0)) {
          throw new ExecutorProfileError(`${source}: ${label}.models_command must be a non-empty string array.`);
        }
        entry.models_command = mc as string[];
      }
      if (rawHarness.models_prefix !== undefined) {
        if (typeof rawHarness.models_prefix !== 'string' || rawHarness.models_prefix.trim().length === 0 || /\s/.test(rawHarness.models_prefix)) {
          throw new ExecutorProfileError(`${source}: ${label}.models_prefix must be a non-empty whitespace-free string.`);
        }
        entry.modelsPrefix = rawHarness.models_prefix.trim();
      }
      if (rawHarness.effort_encoding !== undefined) {
        if (rawHarness.effort_encoding !== 'flag' && rawHarness.effort_encoding !== 'model-suffix') {
          throw new ExecutorProfileError(`${source}: ${label}.effort_encoding must be "flag" or "model-suffix".`);
        }
        entry.effort_encoding = rawHarness.effort_encoding;
      }
      const readLane = (rawLane: Record<string, unknown>, laneLabel: string, required: boolean): HarnessLaneRaw | null => {
        const cmd = rawLane.command;
        if (cmd === undefined || cmd === null) {
          if (required) throw new ExecutorProfileError(`${source}: ${laneLabel}.command must be a non-empty string array.`);
          return null;
        }
        if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((p) => typeof p === 'string' && p.length > 0)) {
          throw new ExecutorProfileError(`${source}: ${laneLabel}.command must be a non-empty string array.`);
        }
        const lane: HarnessLaneRaw = { command: cmd as string[] };
        if (rawLane.resume !== undefined) {
          const rs = rawLane.resume;
          if (!Array.isArray(rs) || rs.length === 0 || !rs.every((p) => typeof p === 'string' && p.length > 0)) {
            throw new ExecutorProfileError(`${source}: ${laneLabel}.resume must be a non-empty string array.`);
          }
          if (!(rs as string[]).some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
            throw new ExecutorProfileError(`${source}: ${laneLabel}.resume must contain ${SESSION_ID_PLACEHOLDER}.`);
          }
          lane.resume = rs as string[];
        }
        if (rawLane.session_id_pattern !== undefined) {
          const pat = rawLane.session_id_pattern;
          if (typeof pat !== 'string') {
            throw new ExecutorProfileError(`${source}: ${laneLabel}.session_id_pattern must be a string.`);
          }
          try { new RegExp(pat); } catch (err) {
            throw new ExecutorProfileError(`${source}: ${laneLabel}.session_id_pattern did not compile: ${(err as Error).message}`);
          }
          if (!pat.includes('(')) {
            throw new ExecutorProfileError(`${source}: ${laneLabel}.session_id_pattern needs a capture group.`);
          }
          lane.session_id_pattern = pat;
        }
        if (rawLane.timeout_ms !== undefined) {
          const tm = rawLane.timeout_ms;
          if (typeof tm !== 'number' || !Number.isInteger(tm) || tm <= 0) {
            throw new ExecutorProfileError(`${source}: ${laneLabel}.timeout_ms must be a positive integer (milliseconds).`);
          }
          lane.timeout_ms = tm;
        }
        const laneEligibility = readEligibility(rawLane, laneLabel, source);
        if (Object.keys(laneEligibility).length > 0) lane.eligibility = laneEligibility;
        return lane;
      };
      const base = readLane(rawHarness as Record<string, unknown>, label, false);
      if (base != null) {
        entry.command = base;
      } else {
        // No `command:`, so the flattened lane fields describe nothing. Keep
        // any `eligibility:` on the entry so the check below can refuse it by
        // name rather than dropping it.
        const eligibilityOnly = readEligibility(rawHarness as Record<string, unknown>, label, source);
        if (Object.keys(eligibilityOnly).length > 0) entry.eligibility = eligibilityOnly;
      }
      if (rawHarness.variants !== undefined) {
        if (!isMapping(rawHarness.variants)) {
          throw new ExecutorProfileError(`${source}: ${label}.variants is not a mapping (variant name → lane).`);
        }
        const variants: Record<string, HarnessLaneRaw> = {};
        for (const [variantKey, rawVariant] of Object.entries(rawHarness.variants)) {
          if (!BARE_IDENTIFIER_RE.test(variantKey)) {
            throw new ExecutorProfileError(`${source}: ${label}.variants key "${variantKey}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
          }
          if (!isMapping(rawVariant)) {
            throw new ExecutorProfileError(`${source}: ${label}.variants.${variantKey} is not a mapping.`);
          }
          const variantLabel = `${label}.variants.${variantKey}`;
          const lane = readLane(rawVariant, variantLabel, true)!;
          const unknownVariant = Object.keys(rawVariant).filter((k) => !['command', 'resume', 'session_id_pattern', 'timeout_ms', 'eligibility'].includes(k));
          if (unknownVariant.length > 0) {
            throw new ExecutorProfileError(`${source}: ${variantLabel} has unknown key(s) ${unknownVariant.join(', ')}; only command, resume, session_id_pattern, timeout_ms, eligibility are allowed.`);
          }
          variants[variantKey] = lane;
        }
        if (Object.keys(variants).length > 0) entry.variants = variants;
      }
      const unknownHarnessKeys = Object.keys(rawHarness).filter((k) => !['provider', 'host', 'command', 'resume', 'session_id_pattern', 'timeout_ms', 'eligibility', 'models_command', 'models_prefix', 'effort_encoding', 'variants'].includes(k));
      if (unknownHarnessKeys.length > 0) {
        throw new ExecutorProfileError(`${source}: ${label} has unknown key(s) ${unknownHarnessKeys.join(', ')}.`);
      }
      if (entry.host == null && entry.command == null) {
        throw new ExecutorProfileError(
          `${source}: ${label} declares neither \`host:\` (Fadeno can run inside it) nor \`command:\` (Fadeno can spawn it) — one is required.`,
        );
      }
      if (entry.command == null && entry.eligibility != null) {
        // Harness-level eligibility constrains the COMMAND lanes. With no
        // `command:` there is none, so the key would sit there doing nothing —
        // and a v3 route rewritten naively (`{host: true, command, eligibility}`
        // split into a `host:` block) is exactly how someone lands here while
        // believing the host lane is gated. Refuse rather than ignore.
        throw new ExecutorProfileError(
          `${source}: ${label} declares \`eligibility:\` with no \`command:\` — harness-level eligibility constrains the command lanes, so it would do nothing here. Move it to \`${label}.host.eligibility\` to gate the host lane.`,
        );
      }
      harnesses[harnessKey] = entry;
    }
  }

  // Exactly one harness may claim a provider as home. Two would make
  // `homeHarnessOf` a coin flip, which is the silent-wrong-answer shape this
  // catalog keeps closing.
  const homeByProvider: Record<string, string> = {};
  for (const [harnessKey, entry] of Object.entries(harnesses)) {
    const provider = entry.provider;
    if (provider == null) continue;
    const existing = homeByProvider[provider];
    if (existing != null) {
      throw new ExecutorProfileError(
        `${source}: provider "${provider}" is claimed as home by two harnesses (${existing}, ${harnessKey}) — exactly one may declare it.`,
      );
    }
    homeByProvider[provider] = harnessKey;
  }

  // Every model must resolve to SOME harness: an explicit `harness:`, or a
  // home harness for its provider. Otherwise the dial fails much later, deep
  // inside resolution, with a message that names neither the model nor the fix.
  for (const [name, entry] of Object.entries(models)) {
    if (name === 'current-host') continue;
    for (const spellingHarness of Object.keys(entry.spellings)) {
      if (!Object.hasOwn(harnesses, spellingHarness)) {
        throw new ExecutorProfileError(
          `${source}: model "${name}" declares a spelling for harness "${spellingHarness}", which is not declared under \`harnesses:\`.`,
        );
      }
    }
    if (entry.harness != null) {
      if (!Object.hasOwn(harnesses, entry.harness)) {
        throw new ExecutorProfileError(
          `${source}: model "${name}" names harness "${entry.harness}", which is not declared under \`harnesses:\`.`,
        );
      }
      continue;
    }
    if (!Object.hasOwn(homeByProvider, entry.provider)) {
      // A CATALOG defect: the project or builtin layer declared a model
      // nothing can deliver, which is a file someone edits and should fix.
      //
      // A USER-layer model never reaches here, nor any other throw in this
      // parse: `config-layers.ts` runs `repairUserLayer` before the merge and
      // `dropUndeliverableUserModels` after it, translating what it can and
      // dropping the rest into `modelFallback.repairs`/`.dropped`. A stale
      // `fadeno model add` is machine state, not catalog policy: on 2026-09-05
      // one such alias (`ox`, provider `stealth`, registered before v4) made
      // every unrelated `fadeno dial` in every repo fail at load. Dialing the
      // dropped alias itself still fails loudly, naming this same fix.
      throw new ExecutorProfileError(
        `${source}: model "${name}" has provider "${entry.provider}", which no harness claims as home, and names no \`harness:\` — ` +
          `declare one with: fadeno model add ${name} ${entry.provider}/${entry.id}`,
      );
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

  // unregistered_model_harness
  if (doc.unregistered_model_driver !== undefined) throw v4MigrationError(source, 'unregistered_model_driver');
  let unregisteredModelHarness = 'opencode';
  if (doc.unregistered_model_harness !== undefined) {
    if (typeof doc.unregistered_model_harness !== 'string' || (doc.unregistered_model_harness as string).trim().length === 0) {
      throw new ExecutorProfileError(`${source}: \`unregistered_model_harness\` must be a non-empty string.`);
    }
    unregisteredModelHarness = (doc.unregistered_model_harness as string).trim();
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
        throw new ExecutorProfileError(`${source}: \`archetypes.${name}\` is not a mapping (only ${ARCHETYPE_POLICY_KEY_FORMS} are allowed).`);
      }
      const unknown = unknownArchetypeKeys(rawPolicy);
      if (unknown.length > 0) {
        throw new ExecutorProfileError(`${source}: \`archetypes.${name}\` has unknown key(s) ${unknown.join(', ')}; only ${ARCHETYPE_POLICY_KEY_FORMS} are allowed.`);
      }
      // Removed, and REFUSED rather than ignored: silently dropping a key
      // someone wrote in order to restrict something is the exact failure this
      // project exists to prevent, and it would be a poor way to land a change
      // whose whole premise is that unenforced claims are dangerous.
      if (rawPolicy.requires_write !== undefined) {
        throw new ExecutorProfileError(
          `${source}: \`archetypes.${name}.requires_write\` is no longer supported. Fadeno does not enforce ` +
            'write permissions: a route is an argv, and a restriction belongs IN that argv — a separate route ' +
            'with its own name (e.g. `--sandbox read-only`) that a reader can see. Containment is isolated ' +
            'worktrees, now the default for command dispatches — see docs/experimental/permissions-and-isolation.md.',
        );
      }
      const ignoredOutput = parseIgnoredOutput(rawPolicy.ignored_output, source, name);
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
      archetypes[name] = { ignoredOutput, fallback, distinctProviderFromInputs, brief };
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

  // surfaces
  //
  // Same shape and same rejections as `worktree_carry` above, and declared
  // project-only for the same reason. A malformed entry fails loudly rather
  // than collapsing to "no surfaces", because that silent state is
  // indistinguishable from an honest undeclared one — and the honest one
  // makes `fadeno bakeoff` withhold the signal rather than pass the arm.
  const surfaces: string[] = [];
  if (doc.surfaces !== undefined) {
    if (!Array.isArray(doc.surfaces)) {
      throw new ExecutorProfileError(`${source}: \`surfaces\` must be an array of repo-relative path strings.`);
    }
    for (const raw of doc.surfaces) {
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        throw new ExecutorProfileError(`${source}: \`surfaces\` entries must be non-empty strings; found ${JSON.stringify(raw)}.`);
      }
      const trimmed = raw.trim();
      if (isAbsolute(trimmed)) {
        throw new ExecutorProfileError(`${source}: \`surfaces\` entry "${trimmed}" must be repo-relative, not absolute.`);
      }
      const normalized = trimmed.split('\\').join('/');
      if (normalized.split('/').includes('..')) {
        throw new ExecutorProfileError(`${source}: \`surfaces\` entry "${trimmed}" may not contain a ".." segment.`);
      }
      surfaces.push(normalized);
    }
  }

  if (doc.relay !== undefined) throw v4MigrationError(source, 'relay');

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
    harnesses,
    bindings,
    dials,
    archetypes,
    constraints,
    unregisteredModelHarness,
    host,
    schemaVersion: 4,
    notes,
    tools,
    worktreeCarry,
    surfaces,
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
      modelFallback: loaded.modelFallback,
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
  /** Executor harness for the challenger; absent = the model's home harness. */
  harness?: string;
  rate?: number;
  /** Maximum successful attachment-backed pairings; absent means unlimited. */
  n?: number;
  /** Successful pairings still available. Present exactly when `n` is present. */
  remaining?: number;
}

export interface LocalDialState {
  dials: Record<string, DialRef>;
  shadows: Record<string, ShadowAttachment>;
  legacyNote: string | null;
  /**
   * Set when this file still spells a delivery the pre-v4 way (` via
   * <driver>` on a dial, `via:` on a shadow). The value was translated to a
   * harness on read and is never written back, so the user is told once —
   * silently rewriting the meaning of stored state is the failure this whole
   * project exists to prevent. Absent files and clean ones report `null`.
   */
  legacyViaNote?: string | null;
}

function localDialPinError(detail: string): ExecutorProfileError {
  return new ExecutorProfileError(
    `${DIALS_LOCAL_FILE} ${detail} Fix: delete it (machine-local state, never committed), then re-dial with \`fadeno dial <archetype> <model>\`.`,
  );
}

const LOCAL_DIALS_LOCK = `${DIALS_LOCAL_FILE}.lock`;
const LOCAL_DIALS_LOCK_WAIT_MS = 10;
const LOCAL_DIALS_LOCK_TIMEOUT_MS = 30_000;
const LOCAL_DIALS_LOCK_STALE_MS = 120_000;
const heldLocalDialLocks = new Map<string, number>();

function waitSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/**
 * Serialize a local dial read-modify-write operation across processes.
 *
 * Shadow trigger budgets live in the same machine-local file as session
 * dials. `mkdir` is the acquisition primitive: exactly one process wins, so
 * checking a remaining count and decrementing it cannot oversubscribe a
 * shadow attachment. The lock is re-entrant for nested synchronous helpers.
 */
export function withLocalDialStateLock<T>(repoRoot: string, action: () => T): T {
  const lockPath = join(repoRoot, LOCAL_DIALS_LOCK);
  const depth = heldLocalDialLocks.get(lockPath) ?? 0;
  if (depth > 0) {
    heldLocalDialLocks.set(lockPath, depth + 1);
    try {
      return action();
    } finally {
      heldLocalDialLocks.set(lockPath, depth);
    }
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCAL_DIALS_LOCK_STALE_MS;
      } catch {
        // A competing writer may have released the lock between mkdir/stat.
      }
      if (stale) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= LOCAL_DIALS_LOCK_TIMEOUT_MS) {
        throw new ExecutorProfileError(`timed out waiting for the local dial lock at ${LOCAL_DIALS_LOCK}.`);
      }
      waitSync(LOCAL_DIALS_LOCK_WAIT_MS);
    }
  }
  heldLocalDialLocks.set(lockPath, 1);
  try {
    return action();
  } finally {
    heldLocalDialLocks.delete(lockPath);
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** The dial ref an attachment names, in one place so callers cannot drift. */
export function shadowAttachmentRef(att: ShadowAttachment): DialRef {
  return {
    model: att.model,
    ...(att.effort ? { effort: att.effort } : {}),
    ...(att.harness ? { harness: att.harness } : {}),
  };
}

/** True only for an attachment whose finite trigger budget has run out. */
export function shadowAttachmentExpired(attachment: ShadowAttachment): boolean {
  return attachment.n != null && attachment.remaining === 0;
}

/**
 * Equality for the user-selected attachment configuration. `remaining` is
 * deliberately excluded: it changes whenever a pairing fires, while a
 * model/rate/count change means an already-prepared challenger is no longer
 * the attachment the user asked to sample.
 */
export function sameShadowAttachmentConfiguration(a: ShadowAttachment, b: ShadowAttachment): boolean {
  return a.model === b.model
    && a.effort === b.effort
    && a.harness === b.harness
    && a.rate === b.rate
    && a.n === b.n;
}

export interface ShadowTriggerReservation {
  reserved: boolean;
  reason: 'unchanged' | 'expired' | 'changed' | 'missing';
  attachment: ShadowAttachment | null;
}

/**
 * Reserve one real attachment-backed shadow pairing.
 *
 * Call this only after all materialization checks pass and immediately before
 * recording/spawning the challenger. Unlimited attachments reserve without a
 * write; finite ones atomically decrement their persisted remaining count.
 */
export function reserveShadowAttachmentTrigger(
  repoRoot: string,
  archetype: string,
  expected: ShadowAttachment,
): ShadowTriggerReservation {
  return withLocalDialStateLock(repoRoot, () => {
    const state = readLocalDialState(repoRoot);
    const current = state.shadows[archetype] ?? null;
    if (current == null) return { reserved: false, reason: 'missing', attachment: null };
    if (!sameShadowAttachmentConfiguration(current, expected)) {
      return { reserved: false, reason: 'changed', attachment: current };
    }
    if (shadowAttachmentExpired(current)) {
      return { reserved: false, reason: 'expired', attachment: current };
    }
    if (current.n == null) return { reserved: true, reason: 'unchanged', attachment: current };
    const remaining = current.remaining!;
    const next = {
      ...state,
      shadows: {
        ...state.shadows,
        [archetype]: { ...current, remaining: remaining - 1 },
      },
      legacyNote: null,
    };
    writeLocalDialState(repoRoot, next);
    return { reserved: true, reason: 'unchanged', attachment: next.shadows[archetype]! };
  });
}

/**
 * Return a finite reservation that could not be admitted to the dispatch
 * ledger. The bounded increment is safe with concurrent reservations: it
 * restores exactly one available slot while never exceeding `n`, and does
 * nothing if the user changed or removed the attachment in the meantime.
 */
export function releaseShadowAttachmentTrigger(
  repoRoot: string,
  archetype: string,
  expected: ShadowAttachment,
): void {
  if (expected.n == null) return;
  withLocalDialStateLock(repoRoot, () => {
    const state = readLocalDialState(repoRoot);
    const current = state.shadows[archetype];
    if (current == null || !sameShadowAttachmentConfiguration(current, expected) || current.n == null) return;
    if (current.remaining! >= current.n) return;
    writeLocalDialState(repoRoot, {
      ...state,
      shadows: { ...state.shadows, [archetype]: { ...current, remaining: current.remaining! + 1 } },
      legacyNote: null,
    });
  });
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
  const legacyShadowVia: string[] = [];
  const legacyDialVia: string[] = [];
  if (doc.dials != null) {
    if (!isMapping(doc.dials)) throw localDialPinError('has a `dials` that is not a mapping (archetype → dial ref).');
    for (const [arch, raw] of Object.entries(doc.dials)) {
      if (!BARE_IDENTIFIER_RE.test(arch)) throw localDialPinError(`has dial key "${arch}", which is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      if (typeof raw === 'string' ? raw.includes(VIA_SEPARATOR) : isMapping(raw) && raw.via !== undefined) legacyDialVia.push(arch);
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
      if (!isMapping(raw)) throw localDialPinError(`shadow "${arch}" is not a mapping ({model, effort?, harness?, rate?, n?, remaining?}).`);
      const model = raw.model;
      if (typeof model !== 'string' || model.trim().length === 0) throw localDialPinError(`shadow "${arch}" needs a non-empty \`model\`.`);
      let effort: string | undefined;
      if (raw.effort !== undefined) {
        if (typeof raw.effort !== 'string' || raw.effort.trim().length === 0) throw localDialPinError(`shadow "${arch}" has invalid \`effort\`.`);
        effort = raw.effort.trim();
      }
      let shadowHarness: string | undefined;
      if (raw.harness !== undefined) {
        if (typeof raw.harness !== 'string' || raw.harness.trim().length === 0) throw localDialPinError(`shadow "${arch}" has invalid \`harness\`.`);
        shadowHarness = raw.harness.trim();
      } else if (raw.via !== undefined) {
        // Legacy attachment, read only: `via` was always a harness wearing a
        // driver's name. Translated on read; never written back.
        if (typeof raw.via !== 'string' || raw.via.trim().length === 0) throw localDialPinError(`shadow "${arch}" has invalid \`via\`.`);
        shadowHarness = legacyDriverHarness(raw.via.trim());
        legacyShadowVia.push(arch);
      }
      let rate: number | undefined;
      if (raw.rate !== undefined) {
        if (typeof raw.rate !== 'number' || !Number.isFinite(raw.rate) || raw.rate <= 0 || raw.rate > 1) {
          throw localDialPinError(`shadow "${arch}" has rate ${JSON.stringify(raw.rate)}, which is not a number in (0, 1].`);
        }
        rate = raw.rate;
      }
      let n: number | undefined;
      let remaining: number | undefined;
      if (raw.n !== undefined) {
        if (typeof raw.n !== 'number' || !Number.isSafeInteger(raw.n) || raw.n <= 0) {
          throw localDialPinError(`shadow "${arch}" has n ${JSON.stringify(raw.n)}, which is not a positive integer.`);
        }
        n = raw.n;
        if (typeof raw.remaining !== 'number' || !Number.isSafeInteger(raw.remaining) || raw.remaining < 0 || raw.remaining > n) {
          throw localDialPinError(`shadow "${arch}" has remaining ${JSON.stringify(raw.remaining)}, which must be an integer in [0, n].`);
        }
        remaining = raw.remaining;
      } else if (raw.remaining !== undefined) {
        throw localDialPinError(`shadow "${arch}" has \`remaining\` without a finite \`n\` trigger limit.`);
      }
      const unknown = Object.keys(raw).filter((k) => !['model','effort','harness','via','rate','n','remaining'].includes(k));
      if (unknown.length > 0) throw localDialPinError(`shadow "${arch}" has unknown key(s) ${unknown.join(', ')}; only model, effort, harness, rate, n, remaining are allowed.`);
      const att: ShadowAttachment = { model: model.trim() };
      if (effort != null) att.effort = effort;
      if (shadowHarness != null) att.harness = shadowHarness;
      if (rate != null) att.rate = rate;
      if (n != null) {
        att.n = n;
        att.remaining = remaining;
      }
      shadows[arch] = att;
    }
  }
  const unknownTop = Object.keys(doc).filter((k) => k !== 'dials' && k !== 'shadows');
  if (unknownTop.length > 0) {
    throw localDialPinError(`has unknown key(s) ${unknownTop.join(', ')}; only \`dials\` and \`shadows\` are allowed.`);
  }
  return { dials, shadows, legacyNote: null, legacyViaNote: formatLegacyViaNote(legacyDialVia, legacyShadowVia) };
}

/**
 * One line telling the user their stored state was translated out of the
 * removed ` via <driver>` grammar, or null when nothing was.
 */
export function formatLegacyViaNote(dials: string[], shadows: string[]): string | null {
  const parts: string[] = [];
  if (dials.length > 0) parts.push(`dial${dials.length === 1 ? '' : 's'} ${dials.sort().join(', ')}`);
  if (shadows.length > 0) parts.push(`shadow${shadows.length === 1 ? '' : 's'} ${shadows.sort().join(', ')}`);
  if (parts.length === 0) return null;
  return (
    `note: ${DIALS_LOCAL_FILE} still spells ${parts.join(' and ')} with the removed \`via <driver>\` form; ` +
    'read as `on <harness>` (claude-exec/claude-cli→claude, opencode-direct→opencode, muse-code→muse). ' +
    'Re-dial to rewrite the file.'
  );
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
    if (att.n !== undefined && (!Number.isSafeInteger(att.n) || att.n <= 0 || !Number.isSafeInteger(att.remaining) || att.remaining! < 0 || att.remaining! > att.n)) {
      throw new ExecutorProfileError(`shadow "${arch}" has invalid finite trigger state.`);
    }
    if (att.n === undefined && att.remaining !== undefined) throw new ExecutorProfileError(`shadow "${arch}" has remaining without n.`);
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
      if (att.harness != null) entry.harness = att.harness;
      if (att.rate != null) entry.rate = att.rate;
      if (att.n != null) {
        entry.n = att.n;
        entry.remaining = att.remaining;
      }
      sortedShadows[k] = entry;
    }
    out.shadows = sortedShadows;
  }
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(out).sort()) ordered[k] = out[k];
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(ordered)}\n`, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
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
  const delivery = resolveDelivery(cascade.ref, profile, profile.host ?? 'standalone', { archetype });
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

// --- resolveDelivery ---

export interface ResolvedRelay {
  /** As written in the catalog, e.g. `luna@high`. */
  refString: string;
  /** Provider-facing id the harness must be handed, e.g. `gpt-5.6-luna`. */
  modelId: string;
  /** Pinned effort, or the model registry's default when the ref omits one. */
  effort: string;
}

/**
 * The relay identity for one harness, compiled to what an emitter writes.
 *
 * Returns null when the catalog states no opinion for that harness — callers
 * keep their own built-in default rather than inventing one, because a relay
 * the session's provider cannot serve is worse than a stale-but-servable one.
 *
 * The requested harness is applied as the HOST before resolving so this
 * answers for the harness the assets are being generated FOR, not the ambient
 * session's: the Claude plugin assets are routinely generated from a Codex
 * session and vice versa.
 */
export function resolveRelay(profile: ExecutorProfile, harness: string): ResolvedRelay | null {
  const ref = profile.harnesses?.[harness]?.host?.relay;
  if (ref == null) return null;
  const compiled = resolveDelivery(ref, profile, harness as HarnessId);
  return { refString: formatDialRef(ref), modelId: compiled.modelId, effort: compiled.effectiveEffort };
}

/** The harness that claims a provider as home, or null when none does. */
export function homeHarnessOf(profile: ExecutorProfile, provider: string): string | null {
  for (const [id, entry] of Object.entries(profile.harnesses ?? {})) {
    if (entry.provider === provider) return id;
  }
  return null;
}

/** Every harness id the catalog declares, sorted — for "did you mean" lists. */
export function declaredHarnesses(profile: ExecutorProfile): string[] {
  return Object.keys(profile.harnesses ?? {}).sort();
}

const ELIGIBILITY_RANK: Record<EligibilityState, number> = { eligible: 0, shadow_only: 1, forbidden: 2 };

/**
 * Strictest-wins merge of any number of eligibility maps.
 *
 * `Object.hasOwn`, not a truthiness check on `out[key]`: an archetype named
 * `constructor` or `toString` would otherwise read a value off
 * `Object.prototype`, rank as `undefined`, and be silently dropped — a
 * forbidden archetype quietly becoming eligible.
 */
function mergeEligibility(...maps: Array<Record<string, EligibilityState> | undefined>): Record<string, EligibilityState> {
  const out: Record<string, EligibilityState> = {};
  for (const map of maps) {
    for (const [key, state] of Object.entries(map ?? {})) {
      if (!Object.hasOwn(out, key) || ELIGIBILITY_RANK[state] > ELIGIBILITY_RANK[out[key]!]) out[key] = state;
    }
  }
  return out;
}

/** One candidate command lane of a harness: the base argv, or a named variant. */
interface LaneCandidate {
  /** null for the base `command:` lane. */
  name: string | null;
  lane: HarnessLaneRaw;
}

/**
 * Every command lane a harness declares, base first.
 *
 * Base-first is the policy: an unconstrained delivery takes the plain argv,
 * and a variant is reached only because the base lane refuses the archetype.
 * That is what makes `worker opus` the base claude command and `director opus`
 * the `exec` variant, without either naming a lane on the dial.
 */
function commandLanes(entry: HarnessRaw | undefined): LaneCandidate[] {
  if (entry == null) return [];
  const lanes: LaneCandidate[] = [];
  if (entry.command != null) lanes.push({ name: null, lane: entry.command });
  for (const [name, lane] of Object.entries(entry.variants ?? {})) lanes.push({ name, lane });
  return lanes;
}

/** Context resolution consults: the archetype whose lane is being chosen. */
export interface DeliveryContext {
  archetype?: string | null;
}

/**
 * Resolve a dial ref to a delivery — the ONE resolution function.
 *
 *     h       = ref.harness ?? entry.harness ?? homeHarnessOf(provider) ?? unregistered_model_harness
 *     H       = harnesses[h]
 *     modelId = entry.spellings[h] ?? entry.id, then effort_encoding
 *     variant = first command lane whose eligibility permits ctx.archetype
 *     host lane iff h === host and H declares `host:`
 *
 * A dial never names a lane. The pair *(dial harness, host)* decides whether
 * the delivery is a host candidate; `decideLane` then decides the lane itself
 * from effort and proof. `hostCandidate` on the result is what to hand
 * `decideLane` as `hostModel` — never `spec.adapter`, which is also how a
 * delivery with no argv at all is represented.
 */
export function resolveDelivery(
  ref: DialRef,
  profile: ExecutorProfile,
  host: HarnessId = profile.host ?? 'standalone',
  ctx: DeliveryContext = {},
): CompiledDelivery {
  const harnesses = profile.harnesses ?? {};
  const refString = formatDialRef(ref);
  const archetype = ctx.archetype ?? null;

  const build = (params: {
    model: string;
    modelId: string;
    effectiveEffort: string;
    provider: string | null;
    harness: string | null;
    registered: boolean;
    entry: HarnessRaw | undefined;
    modelEligibility: Record<string, EligibilityState>;
  }): CompiledDelivery => {
    const { model, modelId, effectiveEffort, provider, harness, entry, modelEligibility } = params;
    const subst = (argv: string[]): string[] =>
      argv.map((part) => part.split('{model}').join(modelId).split('{reasoning_effort}').join(effectiveEffort));

    // Pick the command lane: base first, then variants, skipping any lane the
    // archetype is forbidden on. When every lane forbids it the base is kept
    // anyway, so the kernel refuses with a reason instead of resolution
    // failing with none.
    const lanes = commandLanes(entry);
    const permitted = lanes.filter(
      (candidate) =>
        archetype == null ||
        mergeEligibility(modelEligibility, candidate.lane.eligibility)[archetype] !== 'forbidden',
    );
    const chosen = permitted[0] ?? lanes[0] ?? null;
    const variant = chosen?.name ?? null;

    // The host lane exists when the dial's harness IS the host and that
    // harness declares `host:`. `current-host` under a bare shell has neither,
    // which is why a bare shell answers `restart_required` rather than
    // pretending an in-session delivery it cannot make.
    const hostSide = harness === host ? entry?.host ?? null : null;
    // Harness-level `eligibility:` gates the host lane too, unless
    // `host.eligibility` states its own answer for that archetype. A v3 route
    // carried ONE eligibility map for a `host: true` entry that also declared
    // a `command:`, and it gated both lanes; splitting the entry in two must
    // not silently drop half of that.
    //
    // Per-key OVERRIDE between the two harness-side maps, not strictest-wins:
    // `host.eligibility` is the more specific statement about the same harness
    // and must be able to relax as well as tighten (the whole reason to write
    // it). The MODEL's map then merges strictest-wins over the result, because
    // a model's own restriction is not a harness's to relax.
    const hostEligibility = mergeEligibility(modelEligibility, {
      ...(entry?.command?.eligibility ?? {}),
      ...(hostSide?.eligibility ?? {}),
    });
    const hostCandidate =
      hostSide != null
      // `identity: session` means the host lane can deliver only the session's
      // own identity: the adapter rewrites the agent NAME and nothing else, so
      // a named model handed to a host spawn there would be silently ignored.
      && (hostSide.identity !== 'session' || model === 'current-host')
      && (archetype == null || hostEligibility[archetype] !== 'forbidden');

    let spec: ExecutorSpec;
    // A HOST spec is emitted for a genuine host candidate, and for the one
    // other shape that has no argv to run: a delivery with neither a host lane
    // here nor a command anywhere (`current-host` in a bare shell, a host-only
    // harness named from a different host). `hostCandidate` on the result —
    // never `spec.adapter` — is what tells those two apart.
    //
    // When the host lane exists but its eligibility forbids this archetype,
    // the delivery is NOT a host candidate and the spec is the command lane it
    // will actually go out on, carrying that lane's eligibility. Emitting a
    // host spec there reported the HOST lane's refusal for a delivery that had
    // already fallen through to a variant which permits it — the resolver
    // contradicting its own variant choice.
    if (hostCandidate || chosen == null) {
      spec = {
        adapter: 'host',
        model: modelId,
        reasoningEffort: effectiveEffort,
        agentType: '*',
        fallbackCommand: chosen != null ? subst(chosen.lane.command) : null,
        eligibility: hostCandidate ? { ...hostEligibility } : { ...mergeEligibility(modelEligibility, chosen?.lane.eligibility) },
        ...(provider != null ? { provider } : {}),
        ...(harness != null ? { harness } : {}),
        ...(variant != null ? { variant } : {}),
      };
    } else {
      spec = {
        adapter: 'command',
        command: subst(chosen.lane.command),
        model: modelId,
        resume: chosen.lane.resume != null ? subst(chosen.lane.resume) : null,
        sessionIdPattern: chosen.lane.session_id_pattern ?? null,
        ...(chosen.lane.timeout_ms != null ? { timeoutMs: chosen.lane.timeout_ms } : {}),
        eligibility: { ...mergeEligibility(modelEligibility, chosen.lane.eligibility) },
        ...(provider != null ? { provider } : {}),
        ...(harness != null ? { harness } : {}),
        ...(variant != null ? { variant } : {}),
      };
    }
    return {
      ref,
      refString,
      spec,
      model,
      modelId,
      pinnedEffort: ref.effort ?? null,
      effectiveEffort,
      provider,
      harness,
      variant,
      hostCandidate,
      registered: params.registered,
    };
  };

  // `current-host` is the base dial, not a harness: it names whatever host is
  // running. In a bare shell there is none, and the honest answer is
  // `restart_required`, which falls out of an absent `harnesses.standalone`.
  if (ref.model === 'current-host') {
    const entry = harnesses[host];
    return build({
      model: 'current-host',
      modelId: 'current-host',
      effectiveEffort: ref.effort ?? 'default',
      provider: 'current-host',
      // Null in a bare shell: `standalone` is not a harness in the table, and
      // printing it as one invited a reader to look it up.
      harness: entry != null ? host : null,
      registered: true,
      // The host lane, with its command lanes AND its eligibility stripped.
      //
      // Both removals matter. There is no argv for "the session you are
      // already in", so `current-host` must never acquire a fallback command —
      // that is what makes a pinned `current-host` honestly `restart_required`
      // rather than silently spawning a second session.
      //
      // And `host.eligibility` describes delivering a NAMED MODEL to a spawned
      // in-session agent (`harnesses.claude.host.eligibility: { director:
      // forbidden }` — a Claude subagent cannot spawn subagents of its own, so
      // it cannot coordinate). `current-host` is not that agent: it is the
      // session itself, which can. Inheriting the constraint refused every
      // locked wildcard host request that specialized to `director`.
      entry: entry?.host != null
        ? { host: { effort_channel: entry.host.effort_channel, identity: entry.host.identity } }
        : undefined,
      modelEligibility: {},
    });
  }

  const registered = Object.hasOwn(profile.models, ref.model);
  const entryModel = registered ? profile.models[ref.model]! : null;
  const provider = entryModel?.provider ?? null;
  const harness =
    ref.harness
    ?? entryModel?.harness
    ?? (provider != null ? homeHarnessOf(profile, provider) : null)
    ?? profile.unregisteredModelHarness;
  const harnessEntry = harnesses[harness];
  if (harnessEntry == null) {
    const declared = declaredHarnesses(profile);
    throw new ExecutorProfileError(
      `unknown harness "${harness}"${registered ? ` for model "${ref.model}"` : ''} — declared harnesses: ${declared.join(', ') || '(none)'}` +
        (registered ? '' : `; register the model with: fadeno model add ${ref.model} <provider>/<id>`),
    );
  }
  // Registered: the registry's declared default when the dial states none.
  // Unregistered: no entry to default from, so the neutral `'default'`.
  const effectiveEffort = ref.effort ?? entryModel?.effort ?? 'default';
  const baseId = entryModel != null ? entryModel.spellings[harness] ?? entryModel.id : ref.model;
  const modelId =
    harnessEntry.effort_encoding === 'model-suffix' && effectiveEffort !== 'default'
      ? `${baseId}-${effectiveEffort}`
      : baseId;
  return build({
    model: ref.model,
    modelId,
    effectiveEffort,
    provider,
    harness,
    registered,
    entry: harnessEntry,
    modelEligibility: entryModel?.eligibility ?? {},
  });
}

/** One delivery under consideration: the profile's name for it, plus its spec. */
export interface DeliveryChoice {
  executor: string;
  spec: ExecutorSpec;
}

export function eligibilityFor(spec: ExecutorSpec, archetype: string | null): EligibilityState {
  if (typeof archetype !== 'string') return 'eligible';
  const map = spec.eligibility;
  if (map == null || !Object.hasOwn(map, archetype)) return 'eligible';
  const state = map[archetype];
  return state === 'shadow_only' || state === 'forbidden' || state === 'eligible' ? state : 'eligible';
}

/**
 * Whether a resolved spec has a command lane at all — and, since 2026-08-21,
 * the ONLY question ad-hoc `fadeno dispatch` asks about delivery. A command
 * adapter always qualifies; a host adapter qualifies only when it declares a
 * `fallback_command` to shell out to.
 *
 * **This used to be two predicates and they disagreed.** A separate
 * `dispatchability(spec, harness)` also refused a *command-capable* host spec
 * whenever the harness was in `IN_SESSION_ONLY_HOST_HARNESSES` (`claude`),
 * with reason `host_in_session`, on the theory that shelling out to `claude -p
 * …` from inside a Claude session "re-enters this dispatch one level down".
 * That theory does not survive contact with the catalog: the `anthropic-exec`
 * route spawns exactly that subprocess **on purpose** under every harness
 * including `claude`, so the argv the gate refused was one the gate next door
 * recommended. `codex` was never in the set for the same fallback shape, which
 * made the refusal a coin-flip on which host you happened to be sitting in.
 *
 * What it cost: a coordinator that reached for `fadeno dispatch --archetype
 * reviewer` under Claude got a hard refusal, and on 2026-08-21 one answered it
 * by spawning an in-session subagent and reporting that as "equivalent role,
 * no recursion" — while the instructions it was following asked it to read the
 * result back by dispatch id, which by then could not exist. A gate that
 * refuses a capability the caller has is not a safe default; it is a prompt to
 * route around it.
 *
 * The one honest refusal is spec-shaped, not harness-shaped: a host spec with
 * no `fallback_command` has nothing to invoke (`current-host`, the base dial).
 * There is no longer a second, permission-shaped refusal beside it — routes
 * are argvs and Fadeno does not judge what they may do
 * (docs/experimental/permissions-and-isolation.md).
 *
 * One predicate, three consumers by construction: the dispatch kernel, the
 * `dial`/`steering` resolve previews, and `explainPairRoutability`.
 */
export function commandRoutable(spec: ExecutorSpec): boolean {
  return spec.adapter === 'command' || (spec.adapter === 'host' && spec.fallbackCommand != null);
}

/**
 * Whether a selected pair can actually reach this spec's command lane. One
 * question now: does a lane EXIST. A pair moves the primary off in-session
 * delivery onto `spec.fallbackCommand`, and a host spec that declares none has
 * nothing to move it to.
 *
 * This used to ask a second question — whether that lane satisfied the
 * archetype's declared write posture — and refuse the pair when it did not.
 * That refusal is gone with the posture system it depended on. Capability
 * skew between the two arms is now MEASURED at bakeoff time by comparing the
 * argvs that actually ran, which catches sandbox flags and tool allowlists as
 * well as writes, and reports instead of refusing.
 *
 * One shared answer for the `steering`/`dial` resolve previews (which decide
 * whether to *announce* a pair), the attach-time note in `fadeno dial shadow`
 * (which decides whether to *warn*), and the dispatch kernel (which decides
 * whether to actually *form* one).
 */
export function explainPairRoutability(
  spec: ExecutorSpec,
  executorName: string,
): { routable: true } | { routable: false; reason: string } {
  if (!commandRoutable(spec)) {
    return {
      routable: false,
      reason: `executor "${executorName}" has no command lane — a host delivery with no fallback_command has nothing for a pair to move the primary onto.`,
    };
  }
  return { routable: true };
}

/**
 * The two fields a preview surface publishes for a pair-routability answer.
 * Defined once so `dial resolve` and `steering resolve` cannot drift on
 * whether the reason travels with the verdict: both surfaces used to spread
 * `...routable` alone and drop the string the predicate had already written,
 * leaving a user at `--rate 1.0` with no pairs and nothing to read.
 */
export function pairRoutabilityFields(
  answer: ReturnType<typeof explainPairRoutability>,
): { routable: boolean; routable_reason: string | null } {
  return answer.routable
    ? { routable: true, routable_reason: null }
    : { routable: false, routable_reason: answer.reason };
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
  return { adapter: 'command', command: [], model: null, resume: null, sessionIdPattern: null, eligibility: {} } as ExecutorSpec;
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
    // A snapshot written before catalog v4 records `driver:`; the value was
    // always a harness wearing a driver's name, so it reads back as one.
    const specHarness = typeof raw.harness === 'string'
      ? raw.harness
      : typeof raw.driver === 'string' ? legacyDriverHarness(raw.driver) : undefined;
    const variant = typeof raw.variant === 'string' ? raw.variant : undefined;
    let eligibility: Record<string, EligibilityState> = {};
    if (raw.eligibility !== undefined) {
      if (!isMapping(raw.eligibility)) throw new ExecutorProfileError(`${source}: ${label} host executor \`eligibility\` is not a mapping.`);
      for (const [k, v] of Object.entries(raw.eligibility)) {
        if (!BARE_IDENTIFIER_RE.test(k)) throw new ExecutorProfileError(`${source}: ${label} host executor eligibility key "${k}" is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
        if (v !== 'eligible' && v !== 'shadow_only' && v !== 'forbidden') throw new ExecutorProfileError(`${source}: ${label} host executor \`eligibility.${k}\` must be "eligible", "shadow_only", or "forbidden".`);
        eligibility[k] = v;
      }
    }
    if (raw.timeout_ms !== undefined) {
      throw new ExecutorProfileError(`${source}: ${label} host executor rejects \`timeout_ms\` — host dispatch is not supervised.`);
    }
    const spec: HostExecutorSpec = {
      adapter: 'host', model, reasoningEffort, agentType, fallbackCommand, eligibility,
      ...(target != null ? { target } : {}),
      ...(provider != null ? { provider } : {}),
      ...(specHarness != null ? { harness: specHarness } : {}),
      ...(variant != null ? { variant } : {}),
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
  // `write_variant` in a stored snapshot means the snapshot predates the
  // permissions cut. Refuse rather than ignore, exactly as the catalog parser
  // does — see docs/experimental/permissions-and-isolation.md.
  if (raw.write_variant != null) {
    throw new ExecutorProfileError(
      `${source}: ${label} carries \`write_variant\`, which is no longer supported — this snapshot predates the ` +
        'permissions cut. Re-snapshot from the current catalog.',
    );
  }
  const spec: CommandExecutorSpec = {
    adapter: 'command',
    command: command as string[],
    model: typeof raw.model === 'string' ? raw.model : null,
    resume,
    sessionIdPattern,
    ...(timeoutMs != null ? { timeoutMs } : {}),
    eligibility,
    ...(typeof raw.target === 'string' ? { target: raw.target } : {}),
    ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
    ...(typeof raw.harness === 'string'
      ? { harness: raw.harness }
      : typeof raw.driver === 'string' ? { harness: legacyDriverHarness(raw.driver) } : {}),
    ...(typeof raw.variant === 'string' ? { variant: raw.variant } : {}),
  };
  return spec;
}

/**
 * The separator between a ref and the archetype whose lane policy chose.
 *
 * A ref string is `model[@effort][ on <harness>]` — bare identifiers and `@`
 * only — so `#` cannot occur in one and the compound key is unambiguous.
 */
export const SNAPSHOT_ARCHETYPE_SEPARATOR = '#';

/**
 * The snapshot key for one (ref, archetype) pair.
 *
 * Under v3 a variant lived ON the ref (`opus via claude-exec`) and therefore
 * had a snapshot key of its own. Under v4 a variant is chosen by POLICY from
 * the archetype, so the ref alone no longer identifies the argv: `opus`
 * resolves to the base claude lane for a worker and to the `exec` variant for
 * a director. A snapshot keyed by ref alone froze the worker answer and made
 * `fadeno drive` refuse a director that `fadeno dispatch` delivers.
 */
export function snapshotExecutorKey(refString: string, archetype: string | null): string {
  return archetype == null ? refString : `${refString}${SNAPSHOT_ARCHETYPE_SEPARATOR}${archetype}`;
}

/**
 * Read a run snapshot's executor for a ref, preferring the archetype-specific
 * entry and falling back to the plain ref.
 *
 * The fallback is what keeps `snapshot_version: 3` honest: a snapshot cut
 * before this change has no `#` keys, and every lookup lands on exactly the
 * entry it always did. Going the other way, an older fadeno reading a newer
 * snapshot finds the plain ref and replays the answer IT would have given —
 * degrading to its own behaviour rather than to a wrong one.
 */
export function snapshotExecutor(
  profile: { executors?: Record<string, ExecutorSpec> } | SnapshotDocument | ExecutorProfile,
  refString: string,
  archetype: string | null,
): ExecutorSpec | undefined {
  const executors = (profile as { executors?: Record<string, ExecutorSpec> }).executors;
  if (executors == null) return undefined;
  if (archetype != null) {
    const specific = executors[snapshotExecutorKey(refString, archetype)];
    if (specific != null) return specific;
  }
  return executors[refString];
}

export function serializeSnapshot(
  profile: ExecutorProfile,
  extraRefs: DialRef[] = [],
  /**
   * Archetypes the CALLER knows about that the catalog does not enumerate —
   * in practice a playbook's role archetypes.
   *
   * `knownArchetypes` sees the canon roster plus whatever `archetypes:` and
   * `dials:` name; a playbook declaring `roles: { auditor: { archetype:
   * auditor } }` against a catalog that only constrains `auditor` through a
   * harness lane's `eligibility:` names it in neither. Without this the run
   * froze no specialized entry for that archetype and every replay read the
   * base lane — the lane policy had already ruled out.
   */
  extraArchetypes: readonly string[] = [],
): string {
  const seen = new Set<string>();
  const executorsMap: Record<string, ExecutorSpec> = {};
  const insertRef = (ref: DialRef, archetype: string | null = null) => {
    const key = snapshotExecutorKey(formatDialRef(ref), archetype);
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const compiled = resolveDelivery(ref, profile, profile.host ?? 'standalone', { archetype });
      executorsMap[key] = compiled.spec as ExecutorSpec;
    } catch {
      // missing harness etc. — skip (should not happen for builtin)
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

  // Then, per archetype, only where policy chooses a DIFFERENT lane than the
  // archetype-less resolution did. Additive by construction: a catalog whose
  // lanes carry no eligibility adds no keys at all, and every snapshot cut
  // before this change is byte-identical to one cut after it.
  const refsToSpecialize = new Map<string, DialRef>();
  for (const name of Object.keys(profile.models)) {
    if (name !== 'current-host') refsToSpecialize.set(name, { model: name });
  }
  for (const ref of [...Object.values(profile.bindings), ...Object.values(profile.dials), ...extraRefs]) {
    refsToSpecialize.set(formatDialRef(ref), ref);
  }
  const archetypes = archetypeDisplaySort(
    knownArchetypes(profile.archetypes, profile.dials, Object.fromEntries(extraArchetypes.map((name) => [name, true]))),
  );
  for (const ref of refsToSpecialize.values()) {
    const refString = formatDialRef(ref);
    const base = executorsMap[refString];
    if (base == null) continue;
    for (const archetype of archetypes) {
      let compiled: CompiledDelivery;
      try {
        compiled = resolveDelivery(ref, profile, profile.host ?? 'standalone', { archetype });
      } catch {
        continue;
      }
      if (JSON.stringify(compiled.spec) === JSON.stringify(base)) continue;
      executorsMap[snapshotExecutorKey(refString, archetype)] = compiled.spec;
    }
  }

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
    if (spec.harness != null) entry.harness = spec.harness;
    if (spec.variant != null) entry.variant = spec.variant;
    if (spec.adapter === 'command' && (spec as CommandExecutorSpec).model != null) entry.model = (spec as CommandExecutorSpec).model;
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
      // Added, never defaulted: a `discardable` archetype serializes exactly
      // as it did before this key existed, so no stored snapshot moves a byte.
      if (policy.ignoredOutput !== 'discardable') entry.ignored_output = policy.ignoredOutput;
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
      const unknown = unknownArchetypeKeys(rawPolicy);
      if (unknown.length > 0) throw new ExecutorProfileError(`${source}: \`archetypes.${name}\` has unknown key(s) ${unknown.join(', ')}.`);
      // Removed, and REFUSED rather than ignored: silently dropping a key
      // someone wrote in order to restrict something is the exact failure this
      // project exists to prevent, and it would be a poor way to land a change
      // whose whole premise is that unenforced claims are dangerous.
      if (rawPolicy.requires_write !== undefined) {
        throw new ExecutorProfileError(
          `${source}: \`archetypes.${name}.requires_write\` is no longer supported. Fadeno does not enforce ` +
            'write permissions: a route is an argv, and a restriction belongs IN that argv — a separate route ' +
            'with its own name (e.g. `--sandbox read-only`) that a reader can see. Containment is isolated ' +
            'worktrees, now the default for command dispatches — see docs/experimental/permissions-and-isolation.md.',
        );
      }
      const ignoredOutput = parseIgnoredOutput(rawPolicy.ignored_output, source, name);
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
      archetypes[name] = { ignoredOutput, fallback, distinctProviderFromInputs, brief };
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

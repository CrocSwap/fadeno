import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadLayeredProfile, type ModelFallbackOutcome, type ProfileProvenance } from './config-layers.ts';
import { type FadenoHarness, type UserPathOptions } from './user-paths.ts';

export class ExecutorProfileError extends Error {}

/** Bare lowercase identifier: dial targets, archetype keys, role archetypes. */
// schema_version: 4 — harness-keyed catalog (pre-dials catalogs refused; a v3
// layer loads only when it declares none of the removed keys)
export const BARE_IDENTIFIER_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * A delivery that runs as a process: one argv, one shot. Nothing about
 * sessions, resume, or deadlines — Fadeno launches a process and reads what it
 * writes, and never kills it on a timer.
 */
export interface CommandExecutorSpec {
  adapter: 'command';
  command: string[];
  /** Optional metadata recorded in the ledger; never alters `command`. */
  model: string | null;
  provider?: string;
  /** The executor harness this lane belongs to. */
  harness?: string;
}

/** A delivery the host session makes itself, as a subagent. */
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
  provider?: string;
  harness?: string;
}

export type ExecutorSpec = CommandExecutorSpec | HostExecutorSpec;

/** Placeholder substituted into command/resume argv. */
export const PROMPT_FILE_PLACEHOLDER = '{prompt_file}';

export function substitutePromptFile(argv: string[], promptPath: string): string[] {
  return argv.map((part) => part.split(PROMPT_FILE_PLACEHOLDER).join(promptPath));
}

/**
 * Does this argv carry a permission grant that admits the `fadeno` command
 * family? Read off the argv that will actually run — the grant is IN the
 * command, never in metadata beside it.
 *
 * Two vendor vocabularies, because two vendors ship a lane a director can be
 * delivered to. Each is read FLAG-AWARE: only the values of the flags named
 * below, never a token that merely appears somewhere in the argv.
 *
 * Claude Code (and Antigravity, which borrows the blanket flag):
 *
 *  1. The VALUES of `--allowedTools` / `--allowed-tools`, in both the
 *     separate-token and the `=` form. The flag is variadic, so its values run
 *     until the next `--`-prefixed token. Each value is a comma- or
 *     space-separated list of permission rules, which is what makes
 *     `--allowedTools "Edit Bash"` read the same as `--allowedTools Bash`. A
 *     rule grants when it is exactly `Bash` or exactly `Bash(*)` — the vendor
 *     documents those as the same match-all rule — or when it starts with
 *     `Bash(fadeno`, the scoped grant the lanes carried before 2026-09-06 and
 *     which a user catalog may still pin. `Bash(git *)` grants nothing here.
 *  2. `--dangerously-skip-permissions`, and `--permission-mode
 *     bypassPermissions` in either spelling — which open the shell without
 *     naming a tool at all. The shipped claude lanes carry the first of these.
 *
 * Codex, added 2026-09-06 with the all-permissive posture:
 *
 *  3. `--dangerously-bypass-approvals-and-sandbox` — codex's analogue of
 *     `--dangerously-skip-permissions`, and what the shipped codex lane now
 *     carries.
 *  4. The VALUE of `--sandbox` / `-s`, in both the separate-token and the `=`
 *     form. `codex exec --help` (0.153.4) documents exactly three modes:
 *     `read-only`, `workspace-write`, `danger-full-access`. The latter two run
 *     model-generated shell commands and can write inside the workspace, which
 *     is the whole of what `fadeno` needs — its ledger and state live under
 *     `.fadeno/` and it makes no network call. `read-only` cannot, and neither
 *     can an argv naming no sandbox at all, since `codex exec` defaults to
 *     read-only.
 *
 * Reading codex at all is a DELIBERATE widening of a narrowness this comment
 * used to merely record, not a side effect of the flag swap. Before it the
 * predicate was Claude-shaped and answered `fadeno_capable: false` for every
 * codex delivery — while the catalog's own director note said codex "already
 * could" run fadeno and `director.test.ts` called the codex lane open. The
 * argv and the predicate reading it disagreed: the one-list-two-consumers
 * shape this project keeps paying for. Widening covers BOTH the new flag and
 * the `--sandbox workspace-write` a user or project catalog may still pin, so
 * an install that has not re-cut its own catalog still reads true.
 *
 * It deliberately reads no other flag's values. `--disallowedTools Bash` is the
 * natural shape of the restricted claude lane this catalog invites projects
 * to declare, and a predicate that scanned every argv part regardless of the
 * flag it belonged to reported that argv as CAPABLE — as it did
 * `--append-system-prompt 'Prefer Bash, not Python'`. Position-blindness was
 * survivable while the only token was the implausible `Bash(fadeno:`; a bare
 * `Bash` collides freely, so the walk below is the flag-aware replacement —
 * and the same rule is why a sandbox MODE only counts as the value of the flag
 * that selects it, never inside `-c 'sandbox_permissions=…'` or prose.
 */
export function argvGrantsFadenoShell(argv: readonly string[]): boolean {
  const grants = (rule: string): boolean =>
    rule === 'Bash' || rule === 'Bash(*)' || rule.startsWith('Bash(fadeno');
  // The two codex sandbox modes that can run a shell command and write inside
  // the workspace. `read-only` is the third, and it is excluded.
  const shellSandbox = (mode: string): boolean =>
    mode === 'workspace-write' || mode === 'danger-full-access';
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i] ?? '';
    if (part === '--dangerously-skip-permissions') return true;
    if (part === '--dangerously-bypass-approvals-and-sandbox') return true;
    if (part === '--permission-mode=bypassPermissions') return true;
    if (part === '--permission-mode' && argv[i + 1] === 'bypassPermissions') return true;
    const eq = part.indexOf('=');
    const flag = eq === -1 ? part : part.slice(0, eq);
    if (flag === '--sandbox' || flag === '-s') {
      // Not variadic: `--sandbox` takes exactly one mode, so read exactly one.
      if (shellSandbox(eq === -1 ? argv[i + 1] ?? '' : part.slice(eq + 1))) return true;
      continue;
    }
    if (flag !== '--allowedTools' && flag !== '--allowed-tools') continue;
    const values = eq === -1 ? [] : [part.slice(eq + 1)];
    for (let j = i + 1; j < argv.length && !(argv[j] ?? '').startsWith('--'); j += 1) {
      values.push(argv[j] ?? '');
    }
    if (values.some((value) => value.split(/[\s,]+/).some(grants))) return true;
  }
  return false;
}

/**
 * Canon archetype display order — most→least powerful model typically slotted
 * into the role. Non-canon archetypes sort alphabetically after.
 */
export const ARCHETYPE_DISPLAY_ORDER = ['director', 'judge', 'reviewer', 'scout', 'worker'] as const;

/**
 * The three archetypes every profile has whether or not it says so. A catalog
 * earns an entry in `archetypes:` by having something to say; silence is not
 * absence.
 */
const CANON_ROLE_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

/**
 * Every archetype name a profile KNOWS, as opposed to every name it DECLARES.
 *
 * `profile.archetypes` is a policy overlay: an archetype earns an entry by
 * having something to say (`description`, `fallback`).
 * The builtin catalog therefore declares `worker`, `director` and `scout`
 * and stays silent about `reviewer` and `judge`, whose posture is entirely
 * default — they are no less real for it.
 *
 * Reading the overlay as the registry is a live bug this codebase has already
 * shipped: a resolver that required a declaration refused every host dispatch
 * for `reviewer` and `judge` with "undeclared archetype", pushing a Codex
 * reviewer onto the command lane (2026-08-21, polymarket-quoter). Absence
 * means "no declared policy, use defaults" — everywhere, without exception.
 *
 * Pass dial layers as `extra` where a name may exist only by being dialed.
 */
export function knownArchetypes(
  archetypes: Record<string, unknown>,
  ...extra: Array<Record<string, unknown> | undefined | null>
): Set<string> {
  const names = new Set<string>(CANON_ROLE_ARCHETYPES);
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

/**
 * What a catalog says about an archetype, beyond which model it is dialed to.
 *
 * Two things, both about naming rather than enforcement: what the archetype
 * is FOR, which a director reads when choosing what to spawn, and which
 * archetype's dial it borrows when it has none of its own. Nothing here is a
 * capability demand — Fadeno does not negotiate permissions, judge providers,
 * or decide whose output survives.
 */
export interface ArchetypePolicy {
  /** Next archetype in the binding-fallback chain, or null. */
  fallback: string | null;
  /**
   * What this archetype is for, in a sentence a director reads when choosing
   * what to spawn next. Null when the catalog declares none; the canonical
   * five fall back to the builtin text in `lib/contracts.ts`.
   */
  description: string | null;
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
 * it; nothing in this codebase ever emits one again. The lane half of a driver
 * name (`claude-exec`, `opencode-direct`) is deliberately dropped: a harness
 * has one command lane, so those names have nowhere left to point. A repo that
 * needs a second spelling declares its own harness entry.
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
          'override.',
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

/** A harness's command lane: one argv, and nothing else. */
export interface HarnessLaneRaw {
  command: string[];
}

/** The in-session half of a harness: what it can deliver without spawning. */
export interface HarnessHostRaw {
  /**
   * How this harness carries a reasoning effort on a spawn. `none` — no
   * channel at all, so a host-lane spawn inherits the session's effort.
   * `agent-file` — the harness reads it from an agent definition.
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
  /** The command lane, when this harness has one. */
  command?: HarnessLaneRaw | null;
  models_command?: string[] | null;
  /**
   * Deliberately normalized from YAML's `models_prefix` even though most
   * HarnessRaw fields retain their YAML spelling: consumers use this only as a
   * derived listing qualifier, never as an argv template field.
   */
  modelsPrefix?: string;
  effort_encoding?: 'flag' | 'model-suffix';
}

/**
 * The identity a harness's `models_command` prints for one argv-facing model
 * id. This is deliberately separate from command substitution: OpenCode's
 * OpenRouter listing includes `openrouter/`, while its `-m` argument must not
 * receive that prefix twice.
 *
 * The parameter is the prefix-bearing SLICE of a harness entry rather than
 * `HarnessRaw` itself, so `src/lib/model-listing.ts` can hand it a listing's
 * recorded prefix and get literally this function's answer. There is exactly
 * one qualify rule in the codebase and every membership test goes through it —
 * `fadeno dial`'s probe, `fadeno models`, `fadeno models verify` and
 * `fadeno doctor --probe-models` must agree about what "listed" means, or the
 * doctor stays silent about a dial the dial command would refuse.
 */
export function qualifyListedModelId(harness: { modelsPrefix?: string } | null | undefined, modelId: string): string {
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
  /**
   * Whether this delivery is a candidate for the HOST lane: its harness is the
   * host this call runs inside, and that harness declares a `host:` able to
   * carry this identity.
   *
   * Not the same as `spec.adapter === 'host'`. A host spec is also how a
   * delivery with NO command argv is represented (`current-host` in a bare
   * shell, a host-only harness named from a different host) — there is nothing
   * to spawn and nothing to deliver in-session, which is the one shape with no
   * lane at all. Route on THIS field (`laneOf`), never on `spec.adapter`.
   */
  hostCandidate: boolean;
  registered: boolean;
}

export function deliveryIsHost(compiled: CompiledDelivery): boolean {
  return compiled.spec.adapter === 'host';
}

/**
 * Whether a delivery can go out IN-SESSION — the one question the lane
 * decision asks, answered the same way in every caller.
 *
 * A compile that knows the host answers from `hostCandidate`, which folds in
 * `harness === host`, the harness declaring `host:`, and its `identity:`.
 * `spec.adapter === 'host'` is NOT that question: a host spec is also how a
 * delivery with no argv at all is represented (`current-host` in a bare shell,
 * a host-only harness named from a different host), so the two disagree
 * exactly there — which is how a Codex host agent once got written for a model
 * that harness could not deliver.
 */
export function hostCandidateOf(compiled: CompiledDelivery | null, spec: ExecutorSpec): boolean {
  return compiled != null ? compiled.hostCandidate : spec.adapter === 'host';
}

export interface ToolSpec {
  command: string[];
  /** Read and never armed; see `CommandExecutorSpec.timeoutMs`. */
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
  unregisteredModelHarness: string;
  /**
   * How many unclosed dispatches this repository tolerates before the next
   * spawn is refused (spec §05). Repo-scoped policy; `null` means the default.
   */
  unclosedLimit: number | null;
  /** The HOST: the harness this call is running inside. */
  host?: HarnessId;
  schemaVersion?: 4;
  notes: string[];
}

export type HarnessId = 'codex' | 'claude' | 'grok' | 'opencode' | 'omp' | 'standalone';

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
  for (const entry of AMBIENT_HARNESS_MARKERS) {
    for (const name of entry.variables) delete next[name];
  }
  return next;
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

/** Repo-relative location of the project catalog. */
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
  'unregistered_model_harness',
  'unclosed_limit',
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
    `${source}: \`${key}\` was removed in catalog v4 — use ${replacement}.`,
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
    `${source}: schema_version 4 required — pre-dials catalogs are not supported; migrate: targets:→models:, loadouts:→dials:, default_loadout: delete; routes:→harnesses:\``,
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

/** Keys an `archetypes.<name>` mapping may declare. */
const ARCHETYPE_POLICY_KEYS: readonly string[] = [
  // Deliberately still "known" so the tailored migration error below is the
  // one a reader sees, instead of a generic unknown-key message that says
  // nothing about WHY the key went away. It is refused either way; this only
  // decides which explanation they get.
  'requires_write',
  'fallback',
  'description',
];

/** The same list as prose, for the catalog parser's messages. */
const ARCHETYPE_POLICY_KEY_FORMS = '`fallback` and `description`';

function unknownArchetypeKeys(rawPolicy: Record<string, unknown>): string[] {
  return Object.keys(rawPolicy).filter((key) => !ARCHETYPE_POLICY_KEYS.includes(key));
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
    const unknown = Object.keys(raw).filter((k) => !['provider', 'id', 'effort', 'spellings', 'harness'].includes(k));
    if (unknown.length > 0) {
      throw new ExecutorProfileError(`${source}: model "${name}" has unknown key(s) ${unknown.join(', ')}; only provider, id, effort, spellings, harness are allowed.`);
    }
    models[name] = { provider: prov, id, effort, spellings, ...(modelHarness != null ? { harness: modelHarness } : {}) };
  }
  models['current-host'] = { provider: 'current-host', id: 'current-host', effort: 'default', spellings: {} };

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
        const unknownHost = Object.keys(rawHost).filter((k) => !['effort_channel', 'identity', 'relay'].includes(k));
        if (unknownHost.length > 0) {
          throw new ExecutorProfileError(`${source}: ${label}.host has unknown key(s) ${unknownHost.join(', ')}; only effort_channel, identity, relay are allowed.`);
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
            'the command you want to run, and express any restriction as a SEPARATE harness entry so it is ' +
            'visible in the argv rather than in metadata. Containment is the isolated worktree every dispatch ' +
            'already gets.',
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
      // The command lane is one argv. It used to also carry `resume:`,
      // `session_id_pattern:` and `timeout_ms:` — session reuse for the run
      // engine, and a deadline Fadeno read but never armed — plus named
      // `variants:` that policy chose between on eligibility. All four went
      // with the things that read them.
      const cmd = (rawHarness as Record<string, unknown>).command;
      if (cmd !== undefined && cmd !== null) {
        if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((p) => typeof p === 'string' && p.length > 0)) {
          throw new ExecutorProfileError(`${source}: ${label}.command must be a non-empty string array.`);
        }
        entry.command = { command: cmd as string[] };
      }
      const unknownHarnessKeys = Object.keys(rawHarness).filter((k) => !['provider', 'host', 'command', 'models_command', 'models_prefix', 'effort_encoding'].includes(k));
      if (unknownHarnessKeys.length > 0) {
        throw new ExecutorProfileError(`${source}: ${label} has unknown key(s) ${unknownHarnessKeys.join(', ')}.`);
      }
      if (entry.host == null && entry.command == null) {
        throw new ExecutorProfileError(
          `${source}: ${label} declares neither \`host:\` (Fadeno can run inside it) nor \`command:\` (Fadeno can spawn it) — one is required.`,
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

  // unclosed_limit
  let unclosedLimit: number | null = null;
  if (doc.unclosed_limit !== undefined && doc.unclosed_limit !== null) {
    const raw = doc.unclosed_limit;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      throw new ExecutorProfileError(`${source}: \`unclosed_limit\` must be a positive integer; found ${JSON.stringify(raw)}.`);
    }
    unclosedLimit = raw;
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
            'write permissions: a lane is an argv, and a restriction belongs IN that argv — a separate harness ' +
            'entry with its own name (`--sandbox read-only`, say) that a reader can see. Containment is the ' +
            'isolated worktree every dispatch already gets.',
        );
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
      let description: string | null = null;
      if (rawPolicy.description != null) {
        if (typeof rawPolicy.description !== 'string' || rawPolicy.description.trim().length === 0) {
          throw new ExecutorProfileError(`${source}: \`archetypes.${name}.description\` must be a non-empty string.`);
        }
        description = rawPolicy.description.trim();
      }
      archetypes[name] = { fallback, description };
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
    unregisteredModelHarness,
    unclosedLimit,
    host,
    schemaVersion: 4,
    notes,
  };
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

/**
 * Schema version `writeLocalDialState` stamps. An absent stamp is version 0 —
 * the shape every Fadeno up to 0.6.1 wrote — and still reads; a stamp from the
 * future is refused rather than half-read, because this file decides which
 * model runs.
 */
export const LOCAL_DIALS_SCHEMA_VERSION = 1;

/**
 * The machine-local dial layer: session dials and nothing else. Never
 * committed, and safe to delete — which is exactly what every error about it
 * says to do, rather than reading a file it does not understand.
 */
export interface LocalDialState {
  dials: Record<string, DialRef>;
}

function localDialPinError(detail: string): ExecutorProfileError {
  return new ExecutorProfileError(
    `${DIALS_LOCAL_FILE} ${detail} Fix: delete it (machine-local state, never committed), then re-dial with \`fadeno dial <archetype> <model>\`.`,
  );
}

export function readLocalDialState(repoRoot: string): LocalDialState {
  const path = join(repoRoot, DIALS_LOCAL_FILE);
  if (!existsSync(path)) return { dials: {} };
  const text = readFileSync(path, 'utf8');
  if (text.trim().length === 0) return { dials: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw localDialPinError(`did not parse as JSON: ${(err as Error).message}.`);
  }
  if (!isMapping(doc)) throw localDialPinError('is JSON, but not an object (`{dials}`).');
  if (doc.schema_version !== undefined) {
    if (typeof doc.schema_version !== 'number' || !Number.isSafeInteger(doc.schema_version) || doc.schema_version < 0) {
      throw localDialPinError(`has schema_version ${JSON.stringify(doc.schema_version)}, which is not a non-negative integer.`);
    }
    if (doc.schema_version > LOCAL_DIALS_SCHEMA_VERSION) {
      throw localDialPinError(`is schema_version ${doc.schema_version}; this fadeno reads ${LOCAL_DIALS_SCHEMA_VERSION}.`);
    }
  }
  const dials: Record<string, DialRef> = {};
  if (doc.dials != null) {
    if (!isMapping(doc.dials)) throw localDialPinError('has a `dials` that is not a mapping (archetype → dial ref).');
    for (const [archetype, raw] of Object.entries(doc.dials)) {
      if (!BARE_IDENTIFIER_RE.test(archetype)) {
        throw localDialPinError(`has dial key "${archetype}", which is not a bare lowercase identifier (${BARE_IDENTIFIER_RE.source}).`);
      }
      try {
        dials[archetype] = parseDialRef(raw, `dials.${archetype}`);
      } catch (err) {
        throw localDialPinError((err as Error).message);
      }
    }
  }
  const unknown = Object.keys(doc).filter((k) => k !== 'dials' && k !== 'schema_version');
  if (unknown.length > 0) {
    throw localDialPinError(`has unknown key(s) ${unknown.join(', ')}; only \`schema_version\` and \`dials\` are allowed.`);
  }
  return { dials };
}

export function writeLocalDialState(repoRoot: string, state: LocalDialState): string {
  const path = join(repoRoot, DIALS_LOCAL_FILE);
  const keys = Object.keys(state.dials).sort();
  if (keys.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  const dials: Record<string, unknown> = {};
  for (const key of keys) {
    if (!BARE_IDENTIFIER_RE.test(key)) throw new ExecutorProfileError(`dial key "${key}" is not a bare identifier.`);
    dials[key] = serializeDialRef(state.dials[key]!);
  }
  // Stamp first, then the sorted body: a version buried after the payload is
  // a version nobody reads when they open the file to debug a dial.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify({ schema_version: LOCAL_DIALS_SCHEMA_VERSION, dials })}\n`, 'utf8');
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
  const delivery = resolveDelivery(cascade.ref, profile, profile.host ?? 'standalone');
  return { delivery, source: cascade.source, resolvedVia: cascade.resolvedVia };
}

/**
 * Where a resolution came from, in the words the user sees. One list: the
 * `dial` table's source column, the archetype vocabulary a host is handed, and
 * every resolution echo read the same function, so no two surfaces can name
 * the same layer differently.
 */
/**
 * The layer a resolution came from, in one word — the column is headed
 * `source`, so `user dial` under it said `dial` twice.
 *
 * `null` for `base`, where no layer answered at all: a table renders that as
 * an empty cell and prose as "no dial", and pushing the choice to the surface
 * is what lets one list serve both.
 */
export function roleResolutionEchoLabel(source: RoleResolutionSource): string | null {
  switch (source) {
    case 'binding': return 'binding';
    case 'session': return 'session';
    case 'repo': return 'repo';
    case 'user': return 'user';
    case 'base': return null;
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

/**
 * Resolve a dial ref to a delivery — the ONE resolution function.
 *
 *     h       = ref.harness ?? entry.harness ?? homeHarnessOf(provider) ?? unregistered_model_harness
 *     H       = harnesses[h]
 *     modelId = entry.spellings[h] ?? entry.id, then effort_encoding
 *     host lane iff h === host and H declares `host:`
 *
 * A dial never names a lane. The pair *(dial harness, host)* decides whether
 * this session can deliver the model itself, and `hostCandidate` on the result
 * is that answer — never `spec.adapter`, which is also how a delivery with no
 * argv at all is represented.
 */
export function resolveDelivery(
  ref: DialRef,
  profile: ExecutorProfile,
  host: HarnessId = profile.host ?? 'standalone',
): CompiledDelivery {
  const harnesses = profile.harnesses ?? {};
  const refString = formatDialRef(ref);

  const build = (params: {
    model: string;
    modelId: string;
    effectiveEffort: string;
    provider: string | null;
    harness: string | null;
    registered: boolean;
    entry: HarnessRaw | undefined;
  }): CompiledDelivery => {
    const { model, modelId, effectiveEffort, provider, harness, entry } = params;
    const subst = (argv: string[]): string[] =>
      argv.map((part) => part.split('{model}').join(modelId).split('{reasoning_effort}').join(effectiveEffort));
    const command = entry?.command ?? null;

    // The host lane exists when the dial's harness IS the host and that
    // harness declares `host:`. `current-host` under a bare shell has neither,
    // which is why a bare shell has no lane at all rather than pretending an
    // in-session delivery it cannot make.
    const hostSide = harness === host ? entry?.host ?? null : null;
    const hostCandidate =
      hostSide != null
      // `identity: session` means the host lane can deliver only the session's
      // own identity: the adapter rewrites the agent NAME and nothing else, so
      // a named model handed to a host spawn there would be silently ignored.
      && (hostSide.identity !== 'session' || model === 'current-host');

    // A HOST spec is emitted for a genuine host candidate, and for the one
    // other shape that has no argv to run: a delivery with neither a host lane
    // here nor a command anywhere (`current-host` in a bare shell, a host-only
    // harness named from a different host). `hostCandidate` on the result —
    // never `spec.adapter` — is what tells those two apart.
    const spec: ExecutorSpec = hostCandidate || command == null
      ? {
          adapter: 'host',
          model: modelId,
          reasoningEffort: effectiveEffort,
          agentType: '*',
          fallbackCommand: command != null ? subst(command.command) : null,
          ...(provider != null ? { provider } : {}),
          ...(harness != null ? { harness } : {}),
        }
      : {
          adapter: 'command',
          command: subst(command.command),
          model: modelId,
          ...(provider != null ? { provider } : {}),
          ...(harness != null ? { harness } : {}),
        };
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
      // that is what makes `current-host` in a bare shell honestly lane-less
      // rather than silently spawning a second session.
      entry: entry?.host != null
        ? { host: { effort_channel: entry.host.effort_channel, identity: entry.host.identity } }
        : undefined,
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
  });
}

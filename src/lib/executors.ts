import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export class ExecutorProfileError extends Error {}

/** Bare lowercase identifier: loadout names, archetype keys, role archetypes. */
export const BARE_IDENTIFIER_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * The minimal execution profile of the next protocol: named executors (each a
 * one-shot command adapter) plus direct role→executor bindings. No capability
 * routing, ranking, stickiness, or fallback — if a bound executor fails, the
 * run pauses and the user substitutes explicitly.
 */
export interface CommandExecutorSpec {
  adapter: 'command';
  command: string[];
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
}

/** A native host facility invoked outside the command adapter. */
export interface HostExecutorSpec {
  adapter: 'host';
  /** Requested native model identifier; not proof of the host's runtime model. */
  model: string;
  /** Requested reasoning effort/profile. */
  reasoningEffort: string;
  /** Requested native agent type/identity class. */
  agentType: string;
}

export type ExecutorSpec = CommandExecutorSpec | HostExecutorSpec;

/** Placeholder substituted into command/resume argv. */
export const SESSION_ID_PLACEHOLDER = '{session_id}';

export function substituteSessionId(argv: string[], sessionId: string): string[] {
  return argv.map((part) => part.split(SESSION_ID_PLACEHOLDER).join(sessionId));
}

export interface ExecutorProfile {
  executors: Record<string, ExecutorSpec>;
  bindings: Record<string, string>;
  /**
   * Named archetype→executor tables — the switchable unit of the dispatch
   * kernel. Empty when the profile declares none.
   */
  loadouts: Record<string, Record<string, string>>;
  /** Loadout used when no flag/env/local override selects one. */
  defaultLoadout: string | null;
}

/** Repo-relative location of the profile (playbooks stay harness-neutral). */
export const EXECUTORS_FILE = join('.fadeno', 'executors.yaml');

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse + structurally validate an executor profile document. */
export function parseExecutorProfile(text: string, source: string): ExecutorProfile {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ExecutorProfileError(`${source} did not parse: ${(err as Error).message}`);
  }
  if (!isMapping(doc)) {
    throw new ExecutorProfileError(`${source} is not a mapping.`);
  }
  if (!isMapping(doc.executors) || Object.keys(doc.executors).length === 0) {
    throw new ExecutorProfileError(`${source} needs a non-empty \`executors\` mapping.`);
  }
  const hasBindings = isMapping(doc.bindings) && Object.keys(doc.bindings).length > 0;
  const hasLoadouts = isMapping(doc.loadouts) && Object.keys(doc.loadouts).length > 0;
  if (!hasBindings && !hasLoadouts) {
    throw new ExecutorProfileError(
      `${source} needs a non-empty \`bindings\` mapping (role → executor; "*" is the default) ` +
        'or a non-empty `loadouts` mapping (loadout → archetype → executor).',
    );
  }

  const executors: Record<string, ExecutorSpec> = {};
  for (const [name, raw] of Object.entries(doc.executors)) {
    if (!isMapping(raw)) {
      throw new ExecutorProfileError(`${source}: executor "${name}" is not a mapping.`);
    }
    if (raw.adapter !== 'command' && raw.adapter !== 'host') {
      throw new ExecutorProfileError(
        `${source}: executor "${name}" has adapter ${JSON.stringify(raw.adapter)}; ` +
          'expected `command` or `host`.',
      );
    }
    if (raw.adapter === 'host') {
      const forbidden = ['command', 'resume', 'session_id_pattern'].filter((key) => raw[key] !== undefined);
      if (forbidden.length > 0) {
        throw new ExecutorProfileError(
          `${source}: host executor "${name}" rejects command/session field(s): ${forbidden.join(', ')}.`,
        );
      }
      const model = raw.model;
      const reasoningEffort = raw.reasoning_effort;
      const agentType = raw.agent_type;
      if (typeof model !== 'string' || model.length === 0) {
        throw new ExecutorProfileError(`${source}: host executor "${name}" needs a non-empty \`model\`.`);
      }
      if (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0) {
        throw new ExecutorProfileError(`${source}: host executor "${name}" needs a non-empty \`reasoning_effort\`.`);
      }
      if (typeof agentType !== 'string' || agentType.length === 0) {
        throw new ExecutorProfileError(`${source}: host executor "${name}" needs a non-empty \`agent_type\`.`);
      }
      executors[name] = { adapter: 'host', model, reasoningEffort, agentType };
      continue;
    }
    if (raw.reasoning_effort !== undefined || raw.agent_type !== undefined) {
      throw new ExecutorProfileError(
        `${source}: command executor "${name}" rejects host-only field(s) \`reasoning_effort\`/\`agent_type\`.`,
      );
    }
    const command = raw.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((part) => typeof part === 'string' && part.length > 0)
    ) {
      throw new ExecutorProfileError(
        `${source}: executor "${name}" needs \`command\` as a non-empty array of strings.`,
      );
    }
    if (raw.model != null && typeof raw.model !== 'string') {
      throw new ExecutorProfileError(`${source}: executor "${name}" has a non-string \`model\`.`);
    }

    let resume: string[] | null = null;
    if (raw.resume != null) {
      if (
        !Array.isArray(raw.resume) ||
        raw.resume.length === 0 ||
        !raw.resume.every((part) => typeof part === 'string' && part.length > 0)
      ) {
        throw new ExecutorProfileError(
          `${source}: executor "${name}" needs \`resume\` as a non-empty array of strings.`,
        );
      }
      resume = raw.resume as string[];
      if (!resume.some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
        throw new ExecutorProfileError(
          `${source}: executor "${name}" \`resume\` must contain the ${SESSION_ID_PLACEHOLDER} placeholder.`,
        );
      }
    }

    let sessionIdPattern: string | null = null;
    if (raw.session_id_pattern != null) {
      if (typeof raw.session_id_pattern !== 'string') {
        throw new ExecutorProfileError(
          `${source}: executor "${name}" has a non-string \`session_id_pattern\`.`,
        );
      }
      let compiled: RegExp;
      try {
        compiled = new RegExp(raw.session_id_pattern);
      } catch (err) {
        throw new ExecutorProfileError(
          `${source}: executor "${name}" session_id_pattern did not compile: ${(err as Error).message}`,
        );
      }
      if (compiled.source.indexOf('(') < 0) {
        throw new ExecutorProfileError(
          `${source}: executor "${name}" session_id_pattern needs one capture group for the id.`,
        );
      }
      sessionIdPattern = raw.session_id_pattern;
    }

    const mintsId = (command as string[]).some((part) => part.includes(SESSION_ID_PLACEHOLDER));
    if (resume != null) {
      if (mintsId && sessionIdPattern != null) {
        throw new ExecutorProfileError(
          `${source}: executor "${name}" declares both a ${SESSION_ID_PLACEHOLDER} placeholder in ` +
            '`command` and a `session_id_pattern` — use one id source, not both.',
        );
      }
      if (!mintsId && sessionIdPattern == null) {
        throw new ExecutorProfileError(
          `${source}: executor "${name}" declares \`resume\` but no session id source — put ` +
            `${SESSION_ID_PLACEHOLDER} in \`command\` (engine-minted) or declare \`session_id_pattern\`.`,
        );
      }
    } else if (sessionIdPattern != null || mintsId) {
      throw new ExecutorProfileError(
        `${source}: executor "${name}" has a session id source but no \`resume\` — ` +
          'session-capable executors must declare how to resume.',
      );
    }

    executors[name] = {
      adapter: 'command',
      command: command as string[],
      model: typeof raw.model === 'string' ? raw.model : null,
      resume,
      sessionIdPattern,
    };
  }

  const loadouts: Record<string, Record<string, string>> = {};
  if (doc.loadouts != null) {
    if (!isMapping(doc.loadouts)) {
      throw new ExecutorProfileError(
        `${source} \`loadouts\` is not a mapping (loadout → archetype → executor).`,
      );
    }
    for (const [name, rawSlots] of Object.entries(doc.loadouts)) {
      if (!BARE_IDENTIFIER_RE.test(name)) {
        throw new ExecutorProfileError(
          `${source}: loadout name "${name}" is not a bare lowercase identifier ` +
            `(${BARE_IDENTIFIER_RE.source}).`,
        );
      }
      if (!isMapping(rawSlots)) {
        throw new ExecutorProfileError(
          `${source}: loadout "${name}" is not a mapping (archetype → executor).`,
        );
      }
      const slots: Record<string, string> = {};
      for (const [archetype, target] of Object.entries(rawSlots)) {
        if (!BARE_IDENTIFIER_RE.test(archetype)) {
          throw new ExecutorProfileError(
            `${source}: loadout "${name}" archetype key "${archetype}" is not a bare lowercase ` +
              `identifier (${BARE_IDENTIFIER_RE.source}).`,
          );
        }
        if (typeof target !== 'string' || !(target in executors)) {
          throw new ExecutorProfileError(
            `${source}: loadout "${name}" slot "${archetype}" targets ${JSON.stringify(target)}, ` +
              `which is not a declared executor (${Object.keys(executors).join(', ')}).`,
          );
        }
        slots[archetype] = target;
      }
      loadouts[name] = slots;
    }
  }

  let defaultLoadout: string | null = null;
  if (doc.default_loadout != null) {
    const declared = Object.keys(loadouts);
    if (typeof doc.default_loadout !== 'string' || !(doc.default_loadout in loadouts)) {
      throw new ExecutorProfileError(
        `${source}: default_loadout ${JSON.stringify(doc.default_loadout)} does not name a ` +
          `declared loadout${declared.length > 0 ? ` (${declared.join(', ')})` : ' (no loadouts declared)'}.`,
      );
    }
    defaultLoadout = doc.default_loadout;
  }

  const bindings: Record<string, string> = {};
  if (doc.bindings != null) {
    if (!isMapping(doc.bindings)) {
      throw new ExecutorProfileError(`${source} \`bindings\` is not a mapping (role → executor).`);
    }
    for (const [role, target] of Object.entries(doc.bindings)) {
      if (typeof target !== 'string' || !(target in executors)) {
        throw new ExecutorProfileError(
          `${source}: binding "${role}" targets ${JSON.stringify(target)}, ` +
            `which is not a declared executor (${Object.keys(executors).join(', ')}).`,
        );
      }
      bindings[role] = target;
    }
  }

  return { executors, bindings, loadouts, defaultLoadout };
}

/** Load the repo's executor profile, or explain how to create one. */
export function loadExecutorProfile(repoRoot: string): { profile: ExecutorProfile; path: string } {
  const path = join(repoRoot, EXECUTORS_FILE);
  if (!existsSync(path)) {
    throw new ExecutorProfileError(
      `No executor profile at ${EXECUTORS_FILE}. The engine needs one to dispatch actors — ` +
        'declare executors (adapter: command) and role bindings there ' +
        '(re-run `fadeno init` to seed an example, or copy templates/common/fadeno/executors.yaml).',
    );
  }
  return { profile: parseExecutorProfile(readFileSync(path, 'utf8'), EXECUTORS_FILE), path };
}

/**
 * Direct binding resolution: the role's own binding, else the `"*"` default.
 * No scoring, no fallback chain — an unbound role is an error.
 */
export function resolveBinding(
  profile: ExecutorProfile,
  role: string | null,
): { role: string; executor: string; spec: ExecutorSpec } {
  const key = role ?? '*';
  const target = profile.bindings[key] ?? profile.bindings['*'];
  if (target == null) {
    throw new ExecutorProfileError(
      `No executor binding for role "${key}" and no "*" default in the profile.`,
    );
  }
  return { role: key, executor: target, spec: profile.executors[target]! };
}

/** Repo-relative sticky session loadout file, written by `fadeno loadout use`. */
export const LOADOUT_LOCAL_FILE = join('.fadeno', 'local', 'loadout');

/**
 * Read the sticky session loadout name from `.fadeno/local/loadout` (first
 * line, trimmed). Missing or blank file → null.
 */
export function readLocalLoadout(repoRoot: string): string | null {
  const path = join(repoRoot, LOADOUT_LOCAL_FILE);
  if (!existsSync(path)) return null;
  const name = (readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? '').trim();
  return name.length > 0 ? name : null;
}

/** Where the active loadout name came from, in precedence order. */
export type LoadoutSource = 'flag' | 'env' | 'local' | 'default';

export interface ActiveLoadout {
  name: string;
  source: LoadoutSource;
}

const LOADOUT_SOURCE_LABEL: Record<LoadoutSource, string> = {
  flag: '--loadout',
  env: 'FADENO_LOADOUT',
  local: LOADOUT_LOCAL_FILE,
  default: 'default_loadout',
};

/**
 * Resolve the active loadout: `--loadout` flag → `FADENO_LOADOUT` env →
 * `.fadeno/local/loadout` → `default_loadout:` in the profile → none. Pure —
 * callers pass each source's raw value (null/blank = absent). A source that
 * names an undeclared loadout is a hard error attributed to that source.
 */
export function resolveActiveLoadout(opts: {
  flagValue?: string | null;
  envValue?: string | null;
  localFileValue?: string | null;
  profile: ExecutorProfile;
}): ActiveLoadout | null {
  const candidates: Array<[LoadoutSource, string | null | undefined]> = [
    ['flag', opts.flagValue],
    ['env', opts.envValue],
    ['local', opts.localFileValue],
    ['default', opts.profile.defaultLoadout],
  ];
  for (const [sourceKind, raw] of candidates) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0) continue;
    if (!(name in opts.profile.loadouts)) {
      const declared = Object.keys(opts.profile.loadouts);
      // A stale sticky pin is repo state the tool itself owns — name the fix.
      const suggestion =
        sourceKind === 'local'
          ? ' Run `fadeno loadout clear` (or `fadeno loadout use <name>`) to replace the stale pin.'
          : '';
      throw new ExecutorProfileError(
        `${LOADOUT_SOURCE_LABEL[sourceKind]} names loadout "${name}", which is not declared` +
          (declared.length > 0 ? ` (${declared.join(', ')}).` : ' — the profile has no `loadouts`.') +
          suggestion,
      );
    }
    return { name, source: sourceKind };
  }
  return null;
}

/** How a role landed on its executor, in resolution order. */
export type RoleResolutionSource = 'binding' | 'loadout' | 'default';

export interface RoleResolution {
  executorName: string;
  executor: ExecutorSpec;
  source: RoleResolutionSource;
}

/**
 * Display tag for a role-resolution source in echo lines. The `"*"`-wildcard
 * fallback renders as `fallback "*"` — never "default", which names the
 * `default_loadout` concept elsewhere (one word, two concepts otherwise).
 * Display-only: recorded evidence keeps the raw `RoleResolutionSource` value.
 */
export function roleResolutionEchoLabel(
  source: RoleResolutionSource,
  activeLoadoutName: string | null,
): string {
  if (source === 'loadout') return `loadout ${activeLoadoutName ?? '?'}`;
  if (source === 'default') return 'fallback "*"';
  return source;
}

/**
 * Dispatch-kernel role resolution: explicit `bindings[role]` pin → active
 * loadout's slot for the role's archetype → `bindings["*"]` → hard error.
 * Pure; resolution is computed at dispatch time and never cached in config.
 */
export function resolveRole(
  role: string,
  archetype: string | null,
  profile: ExecutorProfile,
  activeLoadout: string | null,
): RoleResolution {
  const pick = (executorName: string, source: RoleResolutionSource): RoleResolution => ({
    executorName,
    executor: profile.executors[executorName]!,
    source,
  });
  const pinned = profile.bindings[role];
  if (pinned != null) return pick(pinned, 'binding');
  if (archetype != null && activeLoadout != null) {
    const slot = profile.loadouts[activeLoadout]?.[archetype];
    if (slot != null) return pick(slot, 'loadout');
  }
  const fallback = profile.bindings['*'];
  if (fallback != null) return pick(fallback, 'default');

  const archetypePart = archetype == null ? 'no declared archetype' : `archetype "${archetype}"`;
  const loadoutPart = activeLoadout == null
    ? 'no active loadout'
    : archetype == null
      ? `active loadout "${activeLoadout}" cannot route a role without an archetype`
      : `active loadout "${activeLoadout}" has no "${archetype}" slot`;
  const fixes: string[] = [];
  if (archetype == null) {
    fixes.push(`declare \`archetype:\` on role "${role}" in the playbook so a loadout can route it`);
  } else if (activeLoadout == null) {
    fixes.push(
      `activate a loadout that maps "${archetype}" (--loadout, FADENO_LOADOUT, ` +
        '`fadeno loadout use`, or `default_loadout:`)',
    );
  } else {
    fixes.push(`add a "${archetype}" slot to loadout "${activeLoadout}"`);
  }
  fixes.push(`pin \`bindings.${role}\` to an executor`, 'add a "*" default binding');
  throw new ExecutorProfileError(
    `No executor for role "${role}" (${archetypePart}; ${loadoutPart}; no "*" default binding). ` +
      `Fix: ${fixes.join(', or ')}.`,
  );
}

/**
 * Canonical serialization for the run-dir snapshot: sorted keys so the same
 * profile always yields the same bytes (and digest).
 */
export function serializeProfile(profile: ExecutorProfile): string {
  // Emit exactly the document shape parseExecutorProfile reads (snake_case,
  // optional keys omitted) so a snapshot round-trips byte-stable.
  const sortedExecutors: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(profile.executors).sort()) {
    const spec = profile.executors[name]!;
    const entry: Record<string, unknown> = spec.adapter === 'host'
      ? {
          adapter: spec.adapter,
          model: spec.model,
          reasoning_effort: spec.reasoningEffort,
          agent_type: spec.agentType,
        }
      : { adapter: spec.adapter, command: spec.command };
    if (spec.adapter === 'command' && spec.model != null) entry.model = spec.model;
    if (spec.adapter === 'command' && spec.resume != null) entry.resume = spec.resume;
    if (spec.adapter === 'command' && spec.sessionIdPattern != null) entry.session_id_pattern = spec.sessionIdPattern;
    sortedExecutors[name] = entry;
  }
  const out: Record<string, unknown> = { executors: sortedExecutors };
  if (Object.keys(profile.loadouts).length > 0) {
    const sortedLoadouts: Record<string, Record<string, string>> = {};
    for (const name of Object.keys(profile.loadouts).sort()) {
      const slots = profile.loadouts[name]!;
      const sortedSlots: Record<string, string> = {};
      for (const archetype of Object.keys(slots).sort()) sortedSlots[archetype] = slots[archetype]!;
      sortedLoadouts[name] = sortedSlots;
    }
    out.loadouts = sortedLoadouts;
  }
  if (profile.defaultLoadout != null) out.default_loadout = profile.defaultLoadout;
  if (Object.keys(profile.bindings).length > 0) {
    const sortedBindings: Record<string, string> = {};
    for (const role of Object.keys(profile.bindings).sort()) {
      sortedBindings[role] = profile.bindings[role]!;
    }
    out.bindings = sortedBindings;
  }
  return stringifyYaml(out);
}

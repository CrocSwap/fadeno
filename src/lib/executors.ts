import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadLayeredProfile, type ProfileProvenance } from './config-layers.ts';
import { readUserHarness, userPaths, type UserPathOptions } from './user-paths.ts';

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
  /**
   * Whether this delivery's command can mutate the workspace. `null` =
   * undeclared (no constraint). A headless CLI in a read-only permission mode
   * is `false`: it can read and reason, but a `git commit`/Bash write ends in
   * refusal, so a mutating archetype must not be dispatched onto it.
   */
  writeAccess: boolean | null;
  /** Neutral v2 target metadata; absent for legacy v1 executors. */
  target?: string;
  provider?: string;
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
  /**
   * Optional one-shot transport for this same requested model identity when
   * the current host session has a different native baseline. This is an
   * explicit delivery fallback, never an executor/provider substitution.
   */
  fallbackCommand?: string[] | null;
  /**
   * Write capability of the **command delivery** (`fallbackCommand`), not of
   * the native facility — the in-session agent's permissions are the host's
   * business. `null` = undeclared.
   */
  writeAccess: boolean | null;
  /** Neutral v2 target metadata; absent for legacy v1 executors. */
  target?: string;
  provider?: string;
}

export type ExecutorSpec = CommandExecutorSpec | HostExecutorSpec;

/** Placeholder substituted into command/resume argv. */
export const SESSION_ID_PLACEHOLDER = '{session_id}';

export function substituteSessionId(argv: string[], sessionId: string): string[] {
  return argv.map((part) => part.split(SESSION_ID_PLACEHOLDER).join(sessionId));
}

/**
 * What an archetype needs from whatever delivers it. Declared once per
 * archetype, independent of which executor a loadout binds today.
 */
export interface ArchetypePolicy {
  /** The archetype's work mutates the workspace (edits, commits). */
  requiresWrite: boolean;
}

export interface ExecutorProfile {
  executors: Record<string, ExecutorSpec>;
  bindings: Record<string, string>;
  /** Declared archetype requirements; empty when the profile declares none. */
  archetypes: Record<string, ArchetypePolicy>;
  /**
   * Named archetype→executor tables — the switchable unit of the dispatch
   * kernel. Empty when the profile declares none.
   */
  loadouts: Record<string, Record<string, string>>;
  /** Loadout used when no flag/env/local override selects one. */
  defaultLoadout: string | null;
  /** Harness used to compile neutral v2 targets into delivery adapters. */
  harness?: HarnessId;
  schemaVersion?: 1 | 2;
}

export type HarnessId = 'codex' | 'claude' | 'grok' | 'standalone';

export function activeHarness(explicit?: HarnessId, options: UserPathOptions = {}): HarnessId {
  if (explicit != null) return explicit;
  const raw = (options.env ?? process.env).FADENO_HARNESS?.trim();
  return raw === 'codex' || raw === 'claude' || raw === 'grok' || raw === 'standalone'
    ? raw
    : readUserHarness(options) ?? 'standalone';
}

export interface LoadedExecutorProfile {
  profile: ExecutorProfile;
  path: string;
  layers?: Array<'builtin' | 'user' | 'project'>;
  provenance?: ProfileProvenance;
}

/** Repo-relative location of the profile (playbooks stay harness-neutral). */
export const EXECUTORS_FILE = join('.fadeno', 'executors.yaml');

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  const hasLegacyExecutors = isMapping(doc.executors) && Object.keys(doc.executors).length > 0;
  const hasTargets = isMapping(doc.targets) && Object.keys(doc.targets).length > 0;
  if (doc.schema_version !== undefined && doc.schema_version !== 1 && doc.schema_version !== 2) {
    throw new ExecutorProfileError(`${source}: unsupported schema_version ${JSON.stringify(doc.schema_version)}; expected 1 or 2.`);
  }
  if (hasTargets && doc.schema_version !== 2) {
    throw new ExecutorProfileError(`${source}: a \`targets\` catalog requires \`schema_version: 2\`.`);
  }
  if (doc.schema_version === 2 && !hasTargets) {
    throw new ExecutorProfileError(`${source}: \`schema_version: 2\` requires a non-empty \`targets\` mapping.`);
  }
  if (!hasLegacyExecutors && !hasTargets) {
    throw new ExecutorProfileError(`${source} needs a non-empty \`targets\` (v2) or \`executors\` (v1) mapping.`);
  }
  const hasBindings = isMapping(doc.bindings) && Object.keys(doc.bindings).length > 0;
  const hasLoadouts = isMapping(doc.loadouts) && Object.keys(doc.loadouts).length > 0;
  if (!hasBindings && !hasLoadouts) {
    throw new ExecutorProfileError(
      `${source} needs a non-empty \`bindings\` mapping (role → executor; "*" is the default) ` +
        'or a non-empty `loadouts` mapping (loadout → archetype → executor).',
    );
  }

  // Optional on any delivery: declares whether its command can mutate the
  // workspace. Undeclared stays `null` so existing profiles keep their
  // (unconstrained) behavior.
  const readWriteAccess = (raw: Record<string, unknown>, label: string): boolean | null => {
    if (raw.write_access === undefined) return null;
    if (typeof raw.write_access !== 'boolean') {
      throw new ExecutorProfileError(`${source}: ${label} has a non-boolean \`write_access\`.`);
    }
    return raw.write_access;
  };

  const executors: Record<string, ExecutorSpec> = {};
  for (const [name, raw] of Object.entries(isMapping(doc.executors) ? doc.executors : {})) {
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
      let fallbackCommand: string[] | null = null;
      if (raw.fallback_command != null) {
        if (
          !Array.isArray(raw.fallback_command) ||
          raw.fallback_command.length === 0 ||
          !raw.fallback_command.every((part) => typeof part === 'string' && part.length > 0)
        ) {
          throw new ExecutorProfileError(
            `${source}: host executor "${name}" needs \`fallback_command\` as a non-empty array of strings.`,
          );
        }
        fallbackCommand = raw.fallback_command as string[];
      }
      const target = typeof raw.target === 'string' ? raw.target : undefined;
      const provider = typeof raw.provider === 'string' ? raw.provider : undefined;
      executors[name] = {
        adapter: 'host', model, reasoningEffort, agentType, fallbackCommand,
        writeAccess: readWriteAccess(raw, `host executor "${name}"`),
        ...(target != null ? { target } : {}),
        ...(provider != null ? { provider } : {}),
      };
      continue;
    }
    if (raw.reasoning_effort !== undefined || raw.agent_type !== undefined || raw.fallback_command !== undefined) {
      throw new ExecutorProfileError(
        `${source}: command executor "${name}" rejects host-only field(s) ` +
          '\`reasoning_effort\`/\`agent_type\`/\`fallback_command\`.',
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
      writeAccess: readWriteAccess(raw, `executor "${name}"`),
      ...(typeof raw.target === 'string' ? { target: raw.target } : {}),
      ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
    };
  }

  if (hasTargets) {
    const routes = isMapping(doc.routes) ? doc.routes : null;
    const harnessRoutes = routes != null && isMapping(routes[harness]) ? routes[harness] : null;
    if (harnessRoutes == null) {
      throw new ExecutorProfileError(
        `${source}: v2 targets require a \`routes.${harness}\` mapping for the active harness.`,
      );
    }
    const substituteTarget = (argv: string[], model: string, effort: string): string[] =>
      argv.map((part) => part.split('{model}').join(model).split('{reasoning_effort}').join(effort));
    for (const [name, rawTarget] of Object.entries(doc.targets as Record<string, unknown>)) {
      if (!isMapping(rawTarget)) throw new ExecutorProfileError(`${source}: target "${name}" is not a mapping.`);
      const provider = rawTarget.provider;
      const model = rawTarget.model;
      const effort = rawTarget.reasoning_effort ?? 'default';
      if (typeof provider !== 'string' || provider.length === 0) {
        throw new ExecutorProfileError(`${source}: target "${name}" needs a non-empty \`provider\`.`);
      }
      if (typeof model !== 'string' || model.length === 0) {
        throw new ExecutorProfileError(`${source}: target "${name}" needs a non-empty \`model\`.`);
      }
      if (typeof effort !== 'string' || effort.length === 0) {
        throw new ExecutorProfileError(`${source}: target "${name}" has an invalid \`reasoning_effort\`.`);
      }
      // A target-specific route may refine a provider default (for example a
      // read-only CLI policy) without putting delivery semantics in a loadout.
      const routeKey = isMapping(harnessRoutes[name]) ? name : provider;
      const route = isMapping(harnessRoutes[routeKey]) ? harnessRoutes[routeKey] : null;
      if (route == null) {
        throw new ExecutorProfileError(
          `${source}: target "${name}" uses provider "${provider}", but neither ` +
            `\`routes.${harness}.${name}\` nor \`routes.${harness}.${provider}\` is declared.`,
        );
      }
      if (route.native !== undefined && typeof route.native !== 'boolean') {
        throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}.native\` must be boolean.`);
      }
      // Declares the write capability of this route's COMMAND delivery — for a
      // native route that is its fallback command, never the in-session agent.
      if (route.write_access !== undefined && typeof route.write_access !== 'boolean') {
        throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}.write_access\` must be boolean.`);
      }
      const writeAccess = route.write_access === undefined ? null : route.write_access as boolean;
      const rawCommand = route.command;
      if (rawCommand != null && (!Array.isArray(rawCommand) || rawCommand.length === 0 ||
        !rawCommand.every((part) => typeof part === 'string' && part.length > 0))) {
        throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}.command\` must be a non-empty string array.`);
      }
      const command = rawCommand == null ? null : substituteTarget(rawCommand as string[], model, effort);
      const rawResume = route.resume;
      if (rawResume != null && (!Array.isArray(rawResume) || rawResume.length === 0 ||
        !rawResume.every((part) => typeof part === 'string' && part.length > 0))) {
        throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}.resume\` must be a non-empty string array.`);
      }
      const resume = rawResume == null ? null : substituteTarget(rawResume as string[], model, effort);
      if (resume != null && !resume.some((part) => part.includes(SESSION_ID_PLACEHOLDER))) {
        throw new ExecutorProfileError(
          `${source}: route \`routes.${harness}.${routeKey}.resume\` must contain ${SESSION_ID_PLACEHOLDER}.`,
        );
      }
      const sessionIdPattern = route.session_id_pattern == null ? null : route.session_id_pattern;
      if (sessionIdPattern != null && typeof sessionIdPattern !== 'string') {
        throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}.session_id_pattern\` must be a string.`);
      }
      if (typeof sessionIdPattern === 'string') {
        try { new RegExp(sessionIdPattern); } catch (err) {
          throw new ExecutorProfileError(
            `${source}: route \`routes.${harness}.${routeKey}.session_id_pattern\` did not compile: ${(err as Error).message}`,
          );
        }
        if (!sessionIdPattern.includes('(')) {
          throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}.session_id_pattern\` needs a capture group.`);
        }
      }
      if (route.native === true) {
        if (resume != null || sessionIdPattern != null) {
          throw new ExecutorProfileError(
            `${source}: native route \`routes.${harness}.${routeKey}\` rejects command-session fields.`,
          );
        }
        executors[name] = {
          adapter: 'host', model, reasoningEffort: effort, agentType: '*', fallbackCommand: command,
          writeAccess, target: name, provider,
        };
      } else {
        if (command == null) {
          throw new ExecutorProfileError(
            `${source}: route \`routes.${harness}.${routeKey}\` needs \`native: true\` or a non-empty \`command\`.`,
          );
        }
        const mintsId = command.some((part) => part.includes(SESSION_ID_PLACEHOLDER));
        if (resume != null && mintsId && sessionIdPattern != null) {
          throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}\` declares two session id sources.`);
        }
        if (resume != null && !mintsId && sessionIdPattern == null) {
          throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}\` has resume argv but no session id source.`);
        }
        if (resume == null && (mintsId || sessionIdPattern != null)) {
          throw new ExecutorProfileError(`${source}: route \`routes.${harness}.${routeKey}\` has a session id source but no resume argv.`);
        }
        executors[name] = {
          adapter: 'command', command, model, resume, sessionIdPattern: sessionIdPattern as string | null,
          writeAccess, target: name, provider,
        };
      }
    }
  }

  // What each archetype needs, independent of today's binding. Strict: the
  // only declarable requirement is `requires_write`, so a typo is an error
  // rather than a silently-dropped safety constraint.
  const archetypes: Record<string, ArchetypePolicy> = {};
  if (doc.archetypes != null) {
    if (!isMapping(doc.archetypes)) {
      throw new ExecutorProfileError(
        `${source} \`archetypes\` is not a mapping (archetype → requirements).`,
      );
    }
    for (const [name, rawPolicy] of Object.entries(doc.archetypes)) {
      if (!isMapping(rawPolicy)) {
        throw new ExecutorProfileError(
          `${source}: \`archetypes.${name}\` is not a mapping (only \`requires_write\` is allowed).`,
        );
      }
      const unknown = Object.keys(rawPolicy).filter((key) => key !== 'requires_write');
      if (unknown.length > 0) {
        throw new ExecutorProfileError(
          `${source}: \`archetypes.${name}\` has unknown key(s) ${unknown.join(', ')}; ` +
            'only `requires_write` is allowed.',
        );
      }
      if (typeof rawPolicy.requires_write !== 'boolean') {
        throw new ExecutorProfileError(
          `${source}: \`archetypes.${name}.requires_write\` must be boolean.`,
        );
      }
      archetypes[name] = { requiresWrite: rawPolicy.requires_write };
    }
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

  return { executors, bindings, archetypes, loadouts, defaultLoadout, harness, schemaVersion: hasTargets ? 2 : 1 };
}

/** Load the repo's executor profile, or explain how to create one. */
export function loadExecutorProfile(repoRoot: string, options: UserPathOptions = {}, harness?: HarnessId): LoadedExecutorProfile {
  try {
    const loaded = loadLayeredProfile(repoRoot, options, activeHarness(harness, options));
    return {
      profile: loaded.profile,
      path: loaded.path,
      layers: loaded.layers,
      provenance: loaded.provenance,
    };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw err;
    throw new ExecutorProfileError((err as Error).message);
  }
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
export type LoadoutSource = 'flag' | 'run' | 'env' | 'local' | 'user' | 'default';

export interface ActiveLoadout {
  name: string;
  source: LoadoutSource;
}

const LOADOUT_SOURCE_LABEL: Record<LoadoutSource, string> = {
  flag: '--loadout',
  run: 'run-persisted loadout',
  env: 'FADENO_LOADOUT',
  local: LOADOUT_LOCAL_FILE,
  user: 'user loadout',
  default: 'default_loadout',
};

/**
 * Resolve the active loadout: explicit flag → persisted run intent →
 * `FADENO_LOADOUT` env → `.fadeno/local/loadout` → user state →
 * `default_loadout:` in the profile → none. Pure —
 * callers pass each source's raw value (null/blank = absent). A source that
 * names an undeclared loadout is a hard error attributed to that source.
 */
export function resolveActiveLoadout(opts: {
  flagValue?: string | null;
  runValue?: string | null;
  envValue?: string | null;
  localFileValue?: string | null;
  userFileValue?: string | null;
  profile: ExecutorProfile;
}): ActiveLoadout | null {
  const candidates: Array<[LoadoutSource, string | null | undefined]> = [
    ['flag', opts.flagValue],
    ['run', opts.runValue],
    ['env', opts.envValue],
    ['local', opts.localFileValue],
    ['user', opts.userFileValue],
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

/** Read the user-scoped sticky loadout without creating state. */
export function readUserLoadout(options: UserPathOptions = {}): string | null {
  const path = userPaths(options).loadoutFile;
  if (!existsSync(path)) return null;
  const name = (readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? '').trim();
  return name.length > 0 ? name : null;
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
    executor: executorForArchetype(profile, executorName, archetype),
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

/** One delivery under consideration: the profile's name for it, plus its spec. */
export interface DeliveryChoice {
  executor: string;
  spec: ExecutorSpec;
}

/**
 * The single refusal for a mutating archetype about to be delivered through a
 * command that cannot mutate the workspace — an expensive run that ends in "I
 * can't write here". Every enforcement point (ad-hoc dispatch, the playbook
 * engine, Codex steering) calls this so they refuse in identical words.
 *
 * Callers gate on a COMMAND delivery actually being in play: a native
 * in-session agent's permissions are the host's business, and on a host
 * executor `write_access` describes its declared command fallback. `null` =
 * no conflict; undeclared on either side is no constraint.
 */
export function explainWriteConflict(
  delivery: DeliveryChoice,
  archetype: string | null,
  profile: ExecutorProfile,
): string | null {
  if (archetype == null) return null;
  if (profile.archetypes[archetype]?.requiresWrite !== true) return null;
  if (delivery.spec.writeAccess !== false) return null;
  return (
    `archetype "${archetype}" declares \`requires_write: true\`, but executor "${delivery.executor}" ` +
    'delivers through a command route declared `write_access: false` — it cannot mutate the ' +
    'workspace, so the dispatch would burn a run and end in a refusal. ' +
    `Fix: bind "${archetype}" to a write-capable executor, ` +
    "raise the route command's permission mode (and declare `write_access: true`), " +
    `or run this ${archetype}-shaped task with the native in-session ${archetype} agent.`
  );
}

/** Bind a neutral native target to the archetype requested by this invocation. */
export function executorForArchetype(
  profile: ExecutorProfile,
  executorName: string,
  archetype: string | null,
): ExecutorSpec {
  const spec = profile.executors[executorName]!;
  if (spec.adapter !== 'host' || spec.agentType !== '*' || archetype == null) return spec;
  return { ...spec, agentType: archetype };
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
          ...(spec.fallbackCommand != null ? { fallback_command: spec.fallbackCommand } : {}),
        }
      : { adapter: spec.adapter, command: spec.command };
    if (spec.target != null) entry.target = spec.target;
    if (spec.provider != null) entry.provider = spec.provider;
    // A snapshot that dropped a declared write capability would read as
    // "undeclared" — i.e. unconstrained — on re-parse.
    if (spec.writeAccess != null) entry.write_access = spec.writeAccess;
    if (spec.adapter === 'command' && spec.model != null) entry.model = spec.model;
    if (spec.adapter === 'command' && spec.resume != null) entry.resume = spec.resume;
    if (spec.adapter === 'command' && spec.sessionIdPattern != null) entry.session_id_pattern = spec.sessionIdPattern;
    sortedExecutors[name] = entry;
  }
  const out: Record<string, unknown> = { executors: sortedExecutors };
  if (Object.keys(profile.archetypes).length > 0) {
    const sortedArchetypes: Record<string, Record<string, unknown>> = {};
    for (const name of Object.keys(profile.archetypes).sort()) {
      sortedArchetypes[name] = { requires_write: profile.archetypes[name]!.requiresWrite };
    }
    out.archetypes = sortedArchetypes;
  }
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

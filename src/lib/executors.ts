import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export class ExecutorProfileError extends Error {}

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
  /** Host-attested native model identifier. */
  model: string;
  /** Host-attested reasoning effort/profile. */
  reasoningEffort: string;
  /** Host-attested native agent type/identity class. */
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
  if (!isMapping(doc.bindings) || Object.keys(doc.bindings).length === 0) {
    throw new ExecutorProfileError(
      `${source} needs a non-empty \`bindings\` mapping (role → executor; "*" is the default).`,
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

  const bindings: Record<string, string> = {};
  for (const [role, target] of Object.entries(doc.bindings)) {
    if (typeof target !== 'string' || !(target in executors)) {
      throw new ExecutorProfileError(
        `${source}: binding "${role}" targets ${JSON.stringify(target)}, ` +
          `which is not a declared executor (${Object.keys(executors).join(', ')}).`,
      );
    }
    bindings[role] = target;
  }

  return { executors, bindings };
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
  const sortedBindings: Record<string, string> = {};
  for (const role of Object.keys(profile.bindings).sort()) {
    sortedBindings[role] = profile.bindings[role]!;
  }
  return stringifyYaml({ executors: sortedExecutors, bindings: sortedBindings });
}

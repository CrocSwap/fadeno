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
export interface ExecutorSpec {
  adapter: 'command';
  command: string[];
  /** Optional metadata recorded in dispatch evidence; never alters `command`. */
  model: string | null;
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
    if (raw.adapter !== 'command') {
      throw new ExecutorProfileError(
        `${source}: executor "${name}" has adapter ${JSON.stringify(raw.adapter)}; ` +
          'only `command` is supported.',
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
    executors[name] = {
      adapter: 'command',
      command: command as string[],
      model: typeof raw.model === 'string' ? raw.model : null,
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
  const sortedExecutors: Record<string, ExecutorSpec> = {};
  for (const name of Object.keys(profile.executors).sort()) {
    const spec = profile.executors[name]!;
    sortedExecutors[name] = { adapter: spec.adapter, command: spec.command, model: spec.model };
  }
  const sortedBindings: Record<string, string> = {};
  for (const role of Object.keys(profile.bindings).sort()) {
    sortedBindings[role] = profile.bindings[role]!;
  }
  return stringifyYaml({ executors: sortedExecutors, bindings: sortedBindings });
}

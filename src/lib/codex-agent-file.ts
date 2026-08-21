import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexUserAgentDir, type UserPathOptions } from './user-paths.ts';

/** The three Codex role slots that get a session-static agent file. */
export const CODEX_STEERING_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

/**
 * The header that makes a Codex agent file provably Fadeno's — the first
 * line `steering apply` / `init` stamp on every file they write, at either
 * scope. The sole licence `doctor`, `steering resolve`, and `uninstall` have
 * to read, advise on, or remove a file: without it, the file might be
 * hand-authored and is never touched or trusted.
 */
export const CODEX_MANAGED_MARK = '# fadeno:managed';

const CODEX_MANAGED_VERSION_RE = /^# fadeno:managed\b[^\n]*?\bversion=(\S+)/;

/**
 * Flags a current role agent or command broker passes to `steering resolve`.
 * Their absence is the concrete damage a frozen file does, so it is read off
 * the text rather than inferred from the file being old:
 *
 * `--prompt-file` is how the resolver sees the prompt bytes it hashes to
 * decide whether a spawn is paired with a shadow challenger; without it that
 * repo silently stops participating in shadow pairing. `--host-executor` is
 * how a materialized host agent proves the executor (and so the model and
 * effort) it was cut for.
 */
export const CODEX_RESOLVE_FLAGS = ['--prompt-file', '--host-executor'] as const;

const NAME_RE = /^name\s*=\s*"((?:[^"\\]|\\.)*)"/m;
const MODEL_RE = /^model\s*=\s*"((?:[^"\\]|\\.)*)"/m;
const EFFORT_RE = /^model_reasoning_effort\s*=\s*"((?:[^"\\]|\\.)*)"/m;
// `renderCodexHostAgent` bakes `--host-executor <ref> --run ...` (or
// `--host-executor <ref> --prompt-file ...`) as plain prose inside
// `developer_instructions`; a command broker's resolve line never carries
// the flag at all. `<ref>` is `formatDialRef`'s output — `model[@effort][ via
// alias]` — so an optional `via` clause is reassembled from the two groups
// rather than captured as one greedy token, which would either swallow the
// following `--run`/`--prompt-file` flag or stop short of the alias.
const HOST_EXECUTOR_RE = /--host-executor\s+(\S+)(?:\s+via\s+(\S+))?/;

function unquoteToml(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Everything `doctor` and `steering resolve` read off one Codex agent file. */
export interface CodexAgentFileState {
  /** The file's first line carries the managed header `steering apply`/`init` write. */
  managed: boolean;
  /** `version=` off that header, when it carries one. */
  version: string | null;
  /**
   * Which of `CODEX_RESOLVE_FLAGS` this file's text never mentions. Empty
   * means it is current on the resolver contract, whatever stamped it.
   */
  missingFlags: string[];
  /** The file's `name` key — the archetype it materializes. */
  name: string | null;
  /** The file's `model` key. */
  model: string | null;
  /** The file's `model_reasoning_effort` key. */
  reasoningEffort: string | null;
  /**
   * The executor ref baked into this file's own `--host-executor <ref>`
   * invocation, when its text carries one. Only a materialized HOST role
   * agent bakes the flag into its own instructions — a command broker's
   * resolve line omits it, so this is null for a broker even when managed.
   */
  hostExecutor: string | null;
}

/**
 * Read one Codex agent file's provenance and identity. `null` means "no such
 * file" — as does an unreadable one, which is not provably Fadeno's and so is
 * never claimed (the same rule `listRetiredClaudeGridCells` applies to Claude
 * agents).
 *
 * The single parser `doctor`'s broker-drift checks and `steering resolve`'s
 * delegation advisory both read through — a second hand-rolled TOML scraper
 * here would be exactly the one-fact-two-readers drift this codebase keeps
 * getting bitten by.
 */
export function readCodexAgentFile(path: string): CodexAgentFileState | null {
  let text: string;
  try {
    if (!existsSync(path)) return null;
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const missingFlags = CODEX_RESOLVE_FLAGS.filter((flag) => !text.includes(flag));
  const managed = text.startsWith(CODEX_MANAGED_MARK);
  const versionMatch = managed ? CODEX_MANAGED_VERSION_RE.exec(text) : null;
  const nameMatch = NAME_RE.exec(text);
  const modelMatch = MODEL_RE.exec(text);
  const effortMatch = EFFORT_RE.exec(text);
  const hostExecutorMatch = HOST_EXECUTOR_RE.exec(text);
  return {
    managed,
    version: versionMatch ? versionMatch[1]! : null,
    missingFlags,
    name: nameMatch ? unquoteToml(nameMatch[1]!) : null,
    model: modelMatch ? unquoteToml(modelMatch[1]!) : null,
    reasoningEffort: effortMatch ? unquoteToml(effortMatch[1]!) : null,
    hostExecutor: hostExecutorMatch
      ? (hostExecutorMatch[2] != null ? `${hostExecutorMatch[1]} via ${hostExecutorMatch[2]}` : hostExecutorMatch[1]!)
      : null,
  };
}

/** One archetype's Codex agent file path at a given scope. */
export function codexAgentFilePath(
  scope: 'project' | 'user',
  repoRoot: string,
  archetype: string,
  userPathOptions?: UserPathOptions,
): string {
  return scope === 'project'
    ? join(repoRoot, '.codex', 'agents', `${archetype}.toml`)
    : join(codexUserAgentDir(userPathOptions), `fadeno-${archetype}.toml`);
}

export interface CodexAgentCandidate {
  archetype: string;
  path: string;
  scope: 'project' | 'user';
  state: CodexAgentFileState;
}

/**
 * The file Codex would ACTUALLY load for each of the three role archetypes,
 * applying Codex's own project-over-user shadowing: when a project-scope file
 * exists for an archetype, it is the only file Codex ever resolves for that
 * name — the user-scope file underneath it is invisible, not merely lower
 * priority, whether or not the project one is managed or matches anything.
 * `doctor` already documents this precedence for its shadow-drift findings;
 * this is the same rule applied to delegation.
 */
export function effectiveCodexAgentCandidates(
  repoRoot: string,
  userPathOptions?: UserPathOptions,
): CodexAgentCandidate[] {
  const out: CodexAgentCandidate[] = [];
  for (const archetype of CODEX_STEERING_ARCHETYPES) {
    const projectPath = codexAgentFilePath('project', repoRoot, archetype, userPathOptions);
    const projectState = readCodexAgentFile(projectPath);
    if (projectState != null) {
      out.push({ archetype, path: projectPath, scope: 'project', state: projectState });
      continue;
    }
    const userPath = codexAgentFilePath('user', repoRoot, archetype, userPathOptions);
    const userState = readCodexAgentFile(userPath);
    if (userState != null) out.push({ archetype, path: userPath, scope: 'user', state: userState });
  }
  return out;
}

/**
 * The managed Codex agent for `archetype` that a caller could spawn to deliver
 * a locked request in-host, or null when this repo has none.
 *
 * **The file's own model/effort are deliberately NOT matched.** Codex resolves
 * a spawned subagent's settings "from an explicit spawn value, then the
 * corresponding `[agents]` default, then the parent's value" before the agent
 * file is applied at all — the file is the LOWEST-priority default, not a
 * frozen identity. So a caller delivers the locked identity by passing `model`
 * and `model_reasoning_effort` explicitly at spawn time, taken from the run
 * snapshot, and any managed agent for the right role can carry it.
 *
 * That is also the safer source: the snapshot is immutable, while a file can
 * drift out from under the run. An earlier version of this function required
 * the file's baked `--host-executor` / `model` / `model_reasoning_effort` to
 * agree with the request, on the mistaken premise that a Codex agent could
 * only ever run as the identity it was cut for. It could not fire when a
 * spawn would plainly have worked, which is the failure this exists to remove.
 *
 * The ROLE still matters and is matched: an envelope can only be claimed as
 * the archetype it names, so the reviewer agent cannot take a worker's
 * dispatch however the models line up. `'*'` (or null) is the immutable
 * wildcard, where any declared role surface may claim it.
 *
 * `managed` is still required: an unmarked file is not provably Fadeno's, so
 * its instructions cannot be assumed to resolve the envelope at all.
 */
export function findSpawnableCodexAgent(
  candidates: CodexAgentCandidate[],
  archetype: string | null,
): CodexAgentCandidate | null {
  return candidates.find((candidate) =>
    (archetype == null || archetype === '*' || candidate.archetype === archetype) &&
    candidate.state.managed,
  ) ?? null;
}

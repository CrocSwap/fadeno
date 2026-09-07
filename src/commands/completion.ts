import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { editDistance, loadExecutorProfile, type ExecutorProfile } from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { userPaths } from '../lib/user-paths.ts';
import { runDialShow } from './dial.ts';

/** Arguments supplied by the generated Bash completion function. */
export interface CompletionCandidatesOptions {
  /** Bash's `COMP_CWORD` index into `words`. */
  cword: number;
  /** The complete `COMP_WORDS` vector, including the executable. */
  words: string[];
  cwd?: string;
  repoRoot?: string;
}

export class CompletionError extends Error {}

type ValueKind =
  | 'none'
  | 'path'
  | 'dial'
  | 'executor'
  /** User-catalog aliases only — the ones `model remove` can actually take. */
  | 'user-model'
  /** Refs `models verify` accepts: the spellings of a dialed delivery. */
  | 'dialed-model'
  | 'archetype'
  | 'free';

interface OptionSpec {
  kind: ValueKind;
  values?: string[];
}

interface CommandSpec {
  options: Record<string, OptionSpec>;
  positionals: ValueKind[];
  subcommands?: Record<string, CommandSpec>;
  /**
   * The last positional is variadic (`[<ref>...]`), so every slot past the
   * declared ones completes as that kind. Without it a `[<ref>...]` command
   * silently stops proposing refs after however many slots someone happened
   * to list, and offers flags instead — the completion says the command is
   * done taking arguments when it is not.
   */
  repeatLast?: boolean;
}

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  '--help': { kind: 'none' },
  '--version': { kind: 'none' },
};

const globalOptions = (): Record<string, OptionSpec> => ({ ...GLOBAL_OPTIONS });

const command = (
  options: Record<string, OptionSpec>,
  positionals: ValueKind[] = [],
  subcommands?: Record<string, CommandSpec>,
  repeatLast = false,
): CommandSpec => ({ options: { ...globalOptions(), ...options }, positionals, subcommands, repeatLast });

const NONE: OptionSpec = { kind: 'none' };
const PATH: OptionSpec = { kind: 'path' };

// Shared by `models` and its top-level alias `model` — one spec so the two
// spellings cannot drift apart on which flags they accept.
const MODELS_SPEC = command(
  { '--harness': { kind: 'free' }, '--json': NONE },
  ['executor'],
  {
    add: command({ '--json': NONE }, ['free', 'free']),
    // `remove` edits the user catalog only, and `verify` re-probes what the
    // dials point at — neither takes the merged registry the `executor` kind
    // answers with, so neither may propose from it.
    remove: command({ '--force': NONE, '--json': NONE }, ['user-model']),
    verify: command({ '--harness': { kind: 'free' }, '--strict': NONE, '--json': NONE }, ['dialed-model'], undefined, true),
  },
);

const COMMANDS: Record<string, CommandSpec> = {
  setup: command({ '--codex': NONE, '--claude': NONE, '--from': PATH, '--force': NONE, '--json': NONE }),
  status: command({ '--verbose': NONE, '--codex': NONE, '--claude': NONE, '--opencode': NONE, '--omp': NONE, '--json': NONE }),
  models: MODELS_SPEC,
  // Top-level alias for `models` — same handler in cli.ts, same flags.
  model: MODELS_SPEC,
  dial: command(
    { '--harness': { kind: 'free' }, '--session': NONE, '--user': NONE, '--repo': NONE, '--archetype': { kind: 'archetype' }, '--json': NONE },
    ['archetype', 'free'],
    {
      clear: command({ '--session': NONE, '--user': NONE, '--repo': NONE }, ['archetype']),
      resolve: command({ '--archetype': { kind: 'archetype' } }, []),
    },
  ),
  clean: command({ '--force': NONE }),
  dispatch: command({
    '--archetype': { kind: 'archetype' }, '--model': { kind: 'free' }, '--name': { kind: 'free' }, '--prompt-file': PATH,
    '--shared': NONE, '--from': { kind: 'free' }, '--session-id': { kind: 'free' }, '--parent': { kind: 'free' }, '--heartbeat': { kind: 'free' },
  }),
  'dispatch-open': command({
    '--archetype': { kind: 'archetype' }, '--model': { kind: 'free' }, '--name': { kind: 'free' }, '--prompt-file': PATH,
    '--shared': NONE, '--from': { kind: 'free' }, '--session-id': { kind: 'free' }, '--parent': { kind: 'free' }, '--parent-transcript': PATH, '--harness': { kind: 'free' }, '--lane': { kind: 'free' }, '--json': NONE,
  }),
  'dispatch-stop': command({ '--transcript': PATH, '--message-file': PATH, '--agent-cwd': PATH, '--json': NONE }, ['free']),
  'dispatch-close': command({ '--merged': NONE, '--kept': NONE, '--discarded': NONE, '--failed': NONE, '--note': { kind: 'free' } }, ['free']),
  cancel: command({}, ['free']),
  dispatches: command({ '--all': NONE, '--tail': { kind: 'free' }, '--json': NONE, '--output': { kind: 'free' } }, ['free']),
  worktrees: command({ '--json': NONE }),
  context: command({ '--json': NONE }),
  plugin: command({ '--codex': NONE, '--grok': NONE, '--opencode': NONE, '--omp': NONE, '--force': NONE }, ['path']),
  completion: command({}, [], {
    bash: command({}),
  }),
};

/** Public top-level spellings shared by completion, CLI dispatch, and help coverage. */
export const TOP_LEVEL_COMMANDS: readonly string[] = Object.freeze(Object.keys(COMMANDS));

/** Public help paths; the internal `completion candidates` protocol is omitted. */
export const PUBLIC_COMMAND_PATHS: readonly string[] = Object.freeze(
  TOP_LEVEL_COMMANDS.flatMap((name) => {
    const subcommands = COMMANDS[name]!.subcommands;
    return [name, ...Object.keys(subcommands ?? {}).filter((subcommand) => !(name === 'completion' && subcommand === 'candidates')).map((subcommand) => `${name} ${subcommand}`)];
  }),
);

/** Render a sourceable Bash completion definition. */
export function runCompletion(): string {
  return [
    '# bash completion for Fadeno',
    '# Enable for this shell with: source <(fadeno completion bash)',
    '_fadeno_complete() {',
    '  local cword=${COMP_CWORD:-0}',
    '  local cur=${COMP_WORDS[cword]:-}',
    '  local -a words=("${COMP_WORDS[@]}")',
    '  local -a candidates=()',
    '  if command -v fadeno >/dev/null 2>&1; then',
    '    mapfile -t candidates < <(fadeno completion candidates "$cword" -- "${words[@]}" 2>/dev/null)',
    '  fi',
    '  if ((${#candidates[@]})); then',
    '    COMPREPLY=("${candidates[@]}")',
    '  else',
    '    mapfile -t COMPREPLY < <(compgen -f -- "$cur")',
    '  fi',
    '}',
    'complete -F _fadeno_complete fadeno',
    '',
  ].join('\n');
}

function isExecutableWord(word: string | undefined): boolean {
  if (word == null) return false;
  const name = basename(word);
  return name === 'fadeno' || name === 'fadeno.js';
}

function commandStart(words: string[]): number {
  return isExecutableWord(words[0]) ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function startsWith(values: Iterable<string>, prefix: string): string[] {
  return uniqueSorted(values).filter((value) => value.startsWith(prefix));
}

function optionName(token: string): string {
  const eq = token.indexOf('=');
  return eq < 0 ? token : token.slice(0, eq);
}

function optionSpec(spec: CommandSpec, token: string): OptionSpec | undefined {
  return spec.options[optionName(token)];
}

function firstPositionalIndex(words: string[], start: number, end: number, spec: CommandSpec): number | null {
  for (let i = start; i < end; i += 1) {
    const token = words[i]!;
    if (token === '--') return null;
    const found = optionSpec(spec, token);
    if (found != null) {
      if (found.kind !== 'none' && !token.includes('=')) i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return i;
  }
  return null;
}

function commandContext(words: string[], cword: number): {
  name: string | undefined;
  spec: CommandSpec | undefined;
  start: number;
  before: string[];
  positionals: string[];
} {
  const start = commandStart(words);
  const name = words[start];
  const base = name == null ? undefined : COMMANDS[name];
  if (base == null) return { name, spec: undefined, start: start + 1, before: [], positionals: [] };

  const first = base.subcommands == null ? null : firstPositionalIndex(words, start + 1, Math.min(cword, words.length), base);
  const subName = first == null ? undefined : words[first];
  const sub = subName == null ? undefined : base.subcommands?.[subName];
  const active = sub ?? base;
  const activeStart = sub == null ? start + 1 : first! + 1;
  const before = words.slice(activeStart, Math.min(cword, words.length));
  const positionals: string[] = [];
  for (let i = 0; i < before.length; i += 1) {
    const token = before[i]!;
    const found = optionSpec(active, token);
    if (found != null) {
      if (found.kind !== 'none' && !token.includes('=')) i += 1;
      continue;
    }
    if (token === '--' || token.startsWith('-')) continue;
    positionals.push(token);
  }
  return { name, spec: active, start: activeStart, before, positionals };
}

function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pathCandidates(prefix: string, cwd: string): string[] {
  const slash = prefix.endsWith('/') || prefix.endsWith('\\');
  const dirPart = slash ? prefix : dirname(prefix);
  const base = slash ? '' : basename(prefix);
  const lookup = resolve(cwd, dirPart === '.' ? '.' : dirPart);
  const entries = readDirEntries(lookup);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(base)) continue;
    const cleanDir = dirPart.replaceAll('\\', '/');
    const rendered = cleanDir === '.'
      ? entry.name
      : cleanDir === './'
        ? `./${entry.name}`
        : cleanDir === '/'
          ? `/${entry.name}`
          : `${cleanDir.replace(/\/+$/, '')}/${entry.name}`;
    out.push(entry.isDirectory() ? `${rendered}/` : rendered);
  }
  return startsWith(out, prefix);
}

function readProfile(repoRoot: string): ExecutorProfile | null {
  try {
    return loadExecutorProfile(repoRoot).profile;
  } catch {
    return null;
  }
}

/**
 * The aliases `model remove` can actually take: the USER catalog's own keys.
 *
 * The general `executor` kind answers with the MERGED registry, so it proposed
 * `current-host` plus every project and builtin alias — every one of which the
 * command refuses by construction, naming a file to hand-edit instead. A
 * completion that offers values the command rejects is worse than no
 * completion: it teaches a surface that does not exist.
 */
function userCatalogModels(): string[] {
  try {
    const parsed = parseYaml(readFileSync(userPaths().executorsFile, 'utf8')) as { models?: unknown };
    const models = parsed?.models;
    if (models == null || typeof models !== 'object' || Array.isArray(models)) return [];
    return uniqueSorted(Object.keys(models as Record<string, unknown>).filter((name) => name !== 'current-host'));
  } catch {
    return [];
  }
}

/**
 * Every spelling `models verify` accepts for a dialed delivery — the alias,
 * the delivered id, the canonical `id`, and `provider/id` — read from the same
 * effective table the command itself narrows against, so the two cannot drift
 * into proposing a ref that then fails to match.
 */
function dialedModelRefs(repoRoot: string, cwd: string): string[] {
  let rows: ReadonlyArray<{ model: string; model_id: string; harness: string | null }>;
  try {
    rows = runDialShow({ repoRoot, cwd }).rows;
  } catch {
    return [];
  }
  const profile = readProfile(repoRoot);
  const values = new Set<string>();
  for (const row of rows) {
    if (row.harness == null || row.model_id === 'current-host') continue;
    values.add(row.model);
    values.add(row.model_id);
    const entry = profile?.models[row.model];
    if (entry != null) {
      values.add(`${entry.provider}/${entry.id}`);
      values.add(entry.id);
    }
  }
  return uniqueSorted([...values]);
}

function profileValues(repoRoot: string, kind: 'dial' | 'executor' | 'archetype'): string[] {
  const profile = readProfile(repoRoot);
  if (profile == null) return [];
  if (kind === 'dial') return Object.keys(profile.dials ?? {});
  if (kind === 'executor') return Object.keys((profile as any).models ?? (profile as any).executors ?? {});
  const names = new Set<string>();
    // pre-dials code path removed; dial has no slot expansion
  return [...names];
}

function dynamicValues(kind: ValueKind, prefix: string, repoRoot: string, cwd: string): string[] {
  switch (kind) {
    case 'path':
      return pathCandidates(prefix, cwd);
    case 'dial':
    case 'executor':
    case 'archetype':
      return startsWith(profileValues(repoRoot, kind), prefix);
    case 'user-model':
      return startsWith(userCatalogModels(), prefix);
    case 'dialed-model':
      return startsWith(dialedModelRefs(repoRoot, cwd), prefix);
    default:
      return [];
  }
}

function commandOptions(spec: CommandSpec): string[] {
  const options = Object.keys(spec.options);
  if (spec.options['--help'] != null) options.push('-h');
  if (spec.options['--version'] != null) options.push('-v');
  return uniqueSorted(options);
}

/** Return newline-equivalent Bash candidates as plain data. */
export function runCompletionCandidates(opts: CompletionCandidatesOptions): string[] {
  if (!Number.isInteger(opts.cword) || opts.cword < 0) {
    throw new CompletionError('completion candidates needs a non-negative integer cword');
  }
  if (!Array.isArray(opts.words) || opts.words.length === 0) {
    throw new CompletionError('completion candidates needs a non-empty words vector');
  }
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const words = opts.words;
  const cword = Math.min(opts.cword, words.length - 1);
  const current = words[cword] ?? '';
  const context = commandContext(words, cword);
  if (context.name == null || context.spec == null) {
    return startsWith(
      [...Object.keys(COMMANDS), '-h', '--help', '-v', '--version'],
      current,
    );
  }

  const base = COMMANDS[context.name];
  if (base?.subcommands != null && context.spec === base) {
    const first = firstPositionalIndex(words, context.start, cword, base);
    if (first == null || first === cword) return startsWith(Object.keys(base.subcommands), current);
  }

  const previous = cword > 0 ? words[cword - 1] : undefined;
  const previousSpec = previous == null ? undefined : optionSpec(context.spec, previous);
  if (previousSpec != null && previousSpec.kind !== 'none' && previous != null && !previous.includes('=')) {
    if (previousSpec.values != null) return startsWith(previousSpec.values, current);
    return dynamicValues(previousSpec.kind, current, repoRoot, cwd);
  }

  const equal = current.indexOf('=');
  if (equal > 1 && current.startsWith('--')) {
    const tokenName = current.slice(0, equal);
    const found = optionSpec(context.spec, tokenName);
    if (found != null && found.kind !== 'none') {
      if (found.values != null) {
        return startsWith(found.values, current.slice(equal + 1)).map((value) => `${tokenName}=${value}`);
      }
      return dynamicValues(found.kind, current.slice(equal + 1), repoRoot, cwd)
        .map((value) => `${tokenName}=${value}`);
    }
  }

  if (current.startsWith('-')) {
    return startsWith(commandOptions(context.spec), current);
  }

  const positionalIndex = context.positionals.length;
  const declared = context.spec.positionals;
  const kind = declared[positionalIndex]
    ?? (context.spec.repeatLast === true ? declared[declared.length - 1] : undefined);
  if (kind != null) return dynamicValues(kind, current, repoRoot, cwd);

  // A free-form positional (task, feedback, reason, and so on) has no useful
  // semantic candidates. An empty next word still benefits from relevant flags.
  if (current === '') return commandOptions(context.spec);
  return [];
}

/**
 * Flags this command actually accepts, `--`-prefixed, including globals.
 *
 * `null` means the command is unknown here, and the caller must not treat
 * that as "accepts nothing" — silently rejecting every flag of a command this
 * registry forgot would be a worse failure than the one it prevents.
 */
export function knownFlagsFor(command: string, subcommand?: string): Set<string> | null {
  const spec = COMMANDS[command];
  if (spec == null) return null;
  const sub = subcommand != null ? spec.subcommands?.[subcommand] : undefined;
  // A subcommand's own options are additive: `dial resolve --archetype` is
  // valid, and so is `dial --help`.
  return new Set([...Object.keys(spec.options), ...(sub != null ? Object.keys(sub.options) : [])]);
}

/**
 * Flags the caller passed that this command does not accept.
 *
 * `parseArgs` is strict, but its option table is GLOBAL across every command,
 * so a flag declared for one command parses cleanly under any other and is
 * then silently ignored — `fadeno doctor --repo <path>` consumed `--repo` as
 * `dial`'s boolean and left the path as a stray positional, reporting on the
 * wrong repository while looking like it had worked. A wrong answer that
 * looks right is the failure this whole registry exists to prevent, so the
 * one table that already knows which flags belong to which command now
 * answers for both completion and validation.
 */
/**
 * Flags a command still ACCEPTS but no longer does anything with, and the
 * commands that tolerate each.
 *
 * Deliberately not in `knownFlagsFor`: that set drives `--help`, tab
 * completion and the did-you-mean, and a retired flag belongs in none of them
 * — offering it would be advertising a feature that does not exist.
 *
 * They are tolerated rather than rejected for the reason the catalog loader
 * already tolerates a `timeout_ms` key: agents cache their skills at session
 * start, so a session opened before deadlines were removed still holds
 * instructions to pass `--timeout` (a real one said so — `--timeout 0` was
 * named as operating knowledge in a handoff). Under host mode a Fadeno failure
 * is a user-facing event that stops the work, so hard-failing on a stale flag
 * turns an out-of-date skill into a stopped campaign. The caller is told, in
 * the same words `doctor` uses for the catalog key, that nothing is armed.
 */
const RETIRED_FLAGS: Record<string, readonly string[]> = {
  '--timeout': ['dispatch'],
};

/** Whether `command` tolerates this retired flag. */
export function retiredFlagFor(command: string, flag: string): boolean {
  return RETIRED_FLAGS[flag]?.includes(command) ?? false;
}

export function unknownFlagsFor(command: string, subcommand: string | undefined, passed: readonly string[]): string[] {
  const known = knownFlagsFor(command, subcommand);
  if (known == null) return [];
  return passed.map((name) => `--${name}`).filter((flag) => !known.has(flag) && !retiredFlagFor(command, flag));
}

/** Nearest accepted flag within a small edit distance, for a did-you-mean. */
export function suggestFlag(command: string, subcommand: string | undefined, flag: string): string | null {
  const known = knownFlagsFor(command, subcommand);
  if (known == null) return null;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(flag, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // Two, not three. `--repo` sits three edits from `--help`, and offering
  // that as the intended flag is worse than offering nothing: a bad guess
  // sends someone to verify a wrong lead, where silence sends them to
  // `--help`, which is right there in the same message.
  return best != null && bestDistance <= 2 && bestDistance < flag.length ? best : null;
}

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { editDistance, loadExecutorProfile, type ExecutorProfile } from '../lib/executors.ts';
import { listRuns, readEvents, type RunSummary } from '../lib/run-ledger.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { listDefinitionNames, resolvePlaybookFile } from '../lib/definitions.ts';

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
  | 'enum'
  | 'path'
  | 'path-or-stdin'
  | 'run'
  | 'dispatch-id'
  | 'playbook'
  | 'step'
  | 'dial'
  | 'executor'
  | 'archetype'
  | 'bind'
  | 'input'
  | 'free';

interface OptionSpec {
  kind: ValueKind;
  values?: string[];
}

interface CommandSpec {
  options: Record<string, OptionSpec>;
  positionals: ValueKind[];
  subcommands?: Record<string, CommandSpec>;
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
): CommandSpec => ({ options: { ...globalOptions(), ...options }, positionals, subcommands });

const NONE: OptionSpec = { kind: 'none' };
const PATH: OptionSpec = { kind: 'path' };

const COMMANDS: Record<string, CommandSpec> = {
  setup: command({ '--codex': NONE, '--claude': NONE, '--non-interactive': NONE, '--from': PATH, '--reset-runtime': NONE }),
  status: command({ '--verbose': NONE }),
  doctor: command({ '--codex': NONE, '--claude': NONE }),
  vendor: command({ '--codex': NONE, '--claude': NONE, '--grok': NONE, '--with-hooks': NONE, '--no-steering': NONE, '--force': NONE }),
  uninstall: command({ '--codex': NONE, '--claude': NONE, '--all': NONE, '--purge-user-data': NONE, '--force': NONE }),
  clean: command({ '--force': NONE }),
  unvendor: command({ '--force': NONE }),
  evidence: command({}, ['free'], { promote: command({}, ['run']) }),
  init: command({
    '--codex': NONE,
    '--claude': NONE,
    '--grok': NONE,
    '--force': NONE,
    '--with-hooks': NONE,
    '--with-steering': NONE,
    '--no-steering': NONE,
    '--data-only': NONE,
  }),
  validate: command({ '--schema': { kind: 'enum', values: ['playbook', 'run', 'review-report', 'test-result'] } }, ['path']),
  diagram: command({ '--format': { kind: 'enum', values: ['ascii', 'mermaid'] } }, ['playbook']),
  'new-run': command({ '--input': { kind: 'input' } }, ['playbook', 'free']),
  models: command({ '--driver': { kind: 'free' }, '--json': NONE }, ['executor']),
  dial: command(
    { '--via': { kind: 'free' }, '--session': NONE, '--user': NONE, '--repo': NONE, '--force': NONE, '--rate': { kind: 'free' }, '--archetype': { kind: 'archetype' }, '--json': NONE },
    ['archetype', 'free'],
    {
      clear: command({ '--session': NONE, '--user': NONE, '--repo': NONE }, ['archetype']),
      shadow: command({ '--via': { kind: 'free' }, '--rate': { kind: 'free' } }, ['archetype', 'free']),
      'clear-shadow': command({}, ['archetype']),
      resolve: command({ '--archetype': { kind: 'archetype' }, '--prompt-sha256': { kind: 'free' } }, []),
    },
  ),
  steering: command(
    {},
    [],
    {
      resolve: command({
        '--archetype': { kind: 'archetype' },
        '--host-executor': { kind: 'free' },
        // Legacy spelling of `--host-executor`, still read by cli.ts.
        '--native-executor': { kind: 'free' },
        '--role': { kind: 'free' },
        '--run': { kind: 'run' },
        '--dispatch-id': { kind: 'free' },
        // The prompt bytes the resolver hashes to decide pairing; the Codex
        // broker passes one of these on every ordinary dispatch.
        '--prompt-file': PATH,
        '--prompt-sha256': { kind: 'free' },
      }),
      apply: command({ '--codex': NONE, '--claude': NONE, '--grok': NONE, '--force': NONE, '--scope': { kind: 'enum', values: ['project', 'user'] } }, ['dial']),
    },
  ),
  dispatch: command(
    {
      '--archetype': { kind: 'archetype' },
      '--role': { kind: 'free' },
      '--model': { kind: 'free' },
      '--via': { kind: 'free' },
      '--prompt-file': PATH,
      '--tag': { kind: 'free' },
      '--shadow': { kind: 'free' },
      '--timeout': { kind: 'free' },
      '--isolate': NONE,
      '--ignored-output': { kind: 'enum', values: ['kept', 'discardable'] },
      '--no-brief': NONE,
      '--diagnostics': NONE,
    },
  ),
  'dispatch-prepare': command({ '--isolate': NONE }, ['run', 'dispatch-id']),
  'dispatch-prompt': command({}, ['run', 'dispatch-id']),
  'dispatch-fallback': command({}, ['run', 'dispatch-id']),
  'dispatch-start': command({ '--agent-id': { kind: 'free' }, '--workspace': PATH, '--branch': { kind: 'free' } }, ['run', 'dispatch-id']),
  'dispatch-progress': command({ '--file': PATH, '--source': { kind: 'enum', values: ['agent', 'harness', 'director'] } }, ['run', 'dispatch-id']),
  'dispatch-complete': command({ '--output': { kind: 'path-or-stdin' }, '--commit': { kind: 'free' } }, ['run', 'dispatch-id']),
  'dispatch-fail': command({ '--reason': { kind: 'free' } }, ['run', 'dispatch-id']),
  run: command(
    {
      '--step': { kind: 'step' },
      '--status': { kind: 'enum', values: ['running', 'completed', 'failed', 'aborted'] },
      '--event': { kind: 'free' },
      '--artifact': PATH,
      '--member': { kind: 'free' },
      '--field': { kind: 'free' },
    },
    ['run'],
  ),
  'tool-run': command({ '--tool': { kind: 'free' }, '--timeout': { kind: 'free' }, '--output': PATH }, ['run']),
  'tool-complete': command({ '--output': PATH }, ['run']),
  gate: command(
    { '--artifact': PATH, '--report': PATH },
    ['run', 'enum'],
  ),
  prompt: command(
    {
      '--actor': { kind: 'free' },
      '--iteration': { kind: 'free' },
      '--inline': NONE,
      '--no-record': NONE,
      '--format': { kind: 'enum', values: ['text', 'json'] },
    },
    ['run', 'step'],
  ),
  next: command({ '--legacy': NONE }, ['run']),
  drive: command({ '--bind': { kind: 'bind' }, '--max-transitions': { kind: 'free' }, '--parallel': { kind: 'free' }, '--timeout': { kind: 'free' }, '--diagnostics': NONE }, ['run']),
  cancel: command({ '--actor-call': { kind: 'free' } }, ['run']),
  decide: command({ '--decision': { kind: 'free' }, '--feedback': { kind: 'free' } }, ['run', 'free']),
  runs: command({}),
  attest: command({ '--archetype': { kind: 'archetype' } }),
  dispatches: command({
    '--tail': { kind: 'free' },
    '--json': NONE,
    '--comparisons': NONE,
    '--output': { kind: 'free' },
    '--wait': { kind: 'free' },
    '--tag': { kind: 'free' },
    '--cancel': { kind: 'free' },
  }),
  'shadow-apply': command({ '--arm': { kind: 'enum', values: ['challenger', 'primary'] }, '--check': NONE }, ['free']),
  show: command({ '--legacy': NONE, '--events': NONE }, ['run']),
  verify: command({ '--latest': NONE, '--allow-failed': NONE, '--legacy': NONE }, ['run']),
  plugin: command({ '--codex': NONE, '--grok': NONE, '--force': NONE }, ['path']),
  completion: command({}, [], {
    bash: command({}),
  }),
};

// `CommandSpec` is deliberately small, but gate conditions are useful values
// just like enum options. Keeping this separate avoids a second parser while
// retaining the static type of ordinary positional kinds.
const GATE_CONDITIONS = ['all_reviews_approved', 'no_blocking_issues', 'tests_pass'];

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

function readPlaybookNames(repoRoot: string): string[] {
  return uniqueSorted(listDefinitionNames(repoRoot));
}

function safeRuns(repoRoot: string): RunSummary[] {
  try {
    return listRuns(repoRoot);
  } catch {
    return [];
  }
}

function readProfile(repoRoot: string): ExecutorProfile | null {
  try {
    return loadExecutorProfile(repoRoot).profile;
  } catch {
    return null;
  }
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

function resolveRun(runs: RunSummary[], ref: string): RunSummary | null {
  const exact = runs.find((run) => run.runId === ref);
  if (exact != null) return exact;
  const matches = runs.filter((run) => run.runId.startsWith(ref));
  return matches.length === 1 ? matches[0]! : null;
}

function playbookFile(repoRoot: string, run: RunSummary): string | null {
  if (run.playbook == null) return null;
  const stripped = run.playbook.replace(/\.ya?ml$/i, '');
  return resolvePlaybookFile(repoRoot, stripped)?.path ?? null;
}

function readStepIds(repoRoot: string, runRef: string): string[] {
  const run = resolveRun(safeRuns(repoRoot), runRef);
  if (run == null) return [];
  const file = playbookFile(repoRoot, run);
  if (file == null) return [];
  try {
    const doc = parseYaml(readFileSync(file, 'utf8')) as { flow?: unknown };
    if (!Array.isArray(doc?.flow)) return [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const raw of doc.flow) {
      if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
        const id = (raw as Record<string, unknown>).id;
        if (typeof id === 'string') byId.set(id, raw as Record<string, unknown>);
      }
    }
    const found = new Set<string>();
    const visit = (id: string): void => {
      if (found.has(id)) return;
      const step = byId.get(id);
      if (step == null) return;
      found.add(id);
      if (Array.isArray(step.body)) for (const child of step.body) if (typeof child === 'string') visit(child);
    };
    for (const id of byId.keys()) visit(id);
    return uniqueSorted(found);
  } catch {
    return [];
  }
}

/** Nonterminal host requests in the selected run, suitable for host handoff commands. */
function readPendingDispatchIds(repoRoot: string, runRef: string): string[] {
  const run = resolveRun(safeRuns(repoRoot), runRef);
  if (run == null) return [];
  try {
    const events = readEvents(run.dir).events;
    const terminal = new Set(
      events
        .filter((event) => event.type === 'actor_completed' || event.type === 'actor_failed')
        .map((event) => event.extra.dispatch_id)
        .filter((value): value is string => typeof value === 'string'),
    );
    return uniqueSorted(
      events
        .filter((event) => event.type === 'host_dispatch_requested')
        .map((event) => event.extra.dispatch_id)
        .filter((value): value is string => typeof value === 'string' && !terminal.has(value)),
    );
  } catch {
    return [];
  }
}

function readPlaybookRoles(repoRoot: string, runRef: string): string[] {
  const run = resolveRun(safeRuns(repoRoot), runRef);
  if (run == null) return [];
  const file = playbookFile(repoRoot, run);
  if (file == null) return [];
  try {
    const doc = parseYaml(readFileSync(file, 'utf8')) as { roles?: unknown };
    if (doc?.roles == null || typeof doc.roles !== 'object' || Array.isArray(doc.roles)) return [];
    return Object.keys(doc.roles as Record<string, unknown>);
  } catch {
    return [];
  }
}

function readPlaybookInputs(repoRoot: string, runRef: string): string[] {
  const run = resolveRun(safeRuns(repoRoot), runRef);
  if (run == null) return [];
  const file = playbookFile(repoRoot, run);
  if (file == null) return [];
  try {
    const doc = parseYaml(readFileSync(file, 'utf8')) as { inputs?: unknown };
    if (doc?.inputs == null || typeof doc.inputs !== 'object' || Array.isArray(doc.inputs)) return [];
    return Object.keys(doc.inputs as Record<string, unknown>);
  } catch {
    return [];
  }
}

function dynamicValues(
  kind: ValueKind,
  prefix: string,
  repoRoot: string,
  cwd: string,
  runRef: string | undefined,
  optionToken?: string,
): string[] {
  let values: string[];
  switch (kind) {
    case 'enum':
      values = optionToken === '--schema'
        ? ['playbook', 'run', 'review-report', 'test-result']
        : optionToken === '--format'
          ? ['ascii', 'mermaid', 'text', 'json']
          : optionToken === '--status'
            ? ['running', 'completed', 'failed', 'aborted']
            : optionToken === '--source'
              ? ['agent', 'harness', 'director']
              : GATE_CONDITIONS;
      return startsWith(values, prefix);
    case 'path':
      return pathCandidates(prefix, cwd);
    case 'path-or-stdin':
      return startsWith([...pathCandidates(prefix, cwd), '-'], prefix);
    case 'playbook':
      return startsWith(readPlaybookNames(repoRoot), prefix);
    case 'run':
      return startsWith(safeRuns(repoRoot).map((run) => run.runId), prefix);
    case 'dispatch-id':
      return startsWith(runRef == null ? [] : readPendingDispatchIds(repoRoot, runRef), prefix);
    case 'step':
      return startsWith(runRef == null ? [] : readStepIds(repoRoot, runRef), prefix);
    case 'dial':
    case 'executor':
    case 'archetype':
      return startsWith(profileValues(repoRoot, kind), prefix);
    case 'bind': {
      const equals = prefix.indexOf('=');
      const rolePrefix = equals < 0 ? '' : prefix.slice(0, equals + 1);
      const executorPrefix = equals < 0 ? prefix : prefix.slice(equals + 1);
      const executors = profileValues(repoRoot, 'executor');
      // `parseBinds()` accepts only role=executor. Bare executor names are
      // tempting suggestions here, but would be rejected by the CLI; wait for
      // the user to type a role prefix (and `=`) before suggesting values.
      if (equals < 0) return [];
      const roles = runRef == null ? [] : readPlaybookRoles(repoRoot, runRef);
      const role = prefix.slice(0, equals);
      const roleValues = roles.includes(role) ? roles : [...roles, role];
      return startsWith(roleValues.flatMap((name) => executors.map((executor) => `${name}=${executor}`)), `${rolePrefix}${executorPrefix}`);
    }
    case 'input': {
      const equals = prefix.indexOf('=');
      if (equals < 0) {
        const names = runRef == null ? [] : readPlaybookInputs(repoRoot, runRef);
        return startsWith(names.map((name) => `${name}=`), prefix);
      }
      const left = prefix.slice(0, equals + 1);
      return pathCandidates(prefix.slice(equals + 1), cwd).map((value) => `${left}${value}`);
    }
    default:
      return [];
  }
}

function currentRun(positionals: string[]): string | undefined {
  return positionals[0];
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
  const runRef = currentRun(context.positionals);
  if (previousSpec != null && previousSpec.kind !== 'none' && previous != null && !previous.includes('=')) {
    if (previousSpec.kind === 'enum' && previousSpec.values != null) return startsWith(previousSpec.values, current);
    return dynamicValues(previousSpec.kind, current, repoRoot, cwd, runRef, previous);
  }

  const equal = current.indexOf('=');
  if (equal > 1 && current.startsWith('--')) {
    const tokenName = current.slice(0, equal);
    const found = optionSpec(context.spec, tokenName);
    if (found != null && found.kind !== 'none') {
      if (found.kind === 'enum' && found.values != null) {
        return startsWith(found.values, current.slice(equal + 1)).map((value) => `${tokenName}=${value}`);
      }
      return dynamicValues(found.kind, current.slice(equal + 1), repoRoot, cwd, runRef, tokenName)
        .map((value) => `${tokenName}=${value}`);
    }
  }

  if (current.startsWith('-')) {
    return startsWith(commandOptions(context.spec), current);
  }

  const positionalIndex = context.positionals.length;
  const kind = context.spec.positionals[positionalIndex];
  if (kind != null) return dynamicValues(kind, current, repoRoot, cwd, runRef);

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
  // A subcommand's own options are additive: `steering resolve --archetype`
  // is valid, and so is `steering --help`.
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
export function unknownFlagsFor(command: string, subcommand: string | undefined, passed: readonly string[]): string[] {
  const known = knownFlagsFor(command, subcommand);
  if (known == null) return [];
  return passed.map((name) => `--${name}`).filter((flag) => !known.has(flag));
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

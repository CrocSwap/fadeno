import { PUBLIC_COMMAND_PATHS } from '../commands/completion.ts';

export interface CliHelpPage {
  summary: string;
  usage: string[];
  notes?: string[];
  examples?: string[];
}

type PageSeed = Pick<CliHelpPage, 'summary' | 'usage' | 'notes' | 'examples'>;

const page = (summary: string, usage: string | string[], notes?: string[], examples?: string[]): PageSeed => ({
  summary,
  usage: Array.isArray(usage) ? usage : [usage],
  notes,
  examples,
});

/** An alias shares the canonical page's options and detail, changing only its spelling. */
const aliasPage = (canonical: PageSeed, usage: string | string[], note: string): PageSeed => ({
  ...canonical,
  usage: Array.isArray(usage) ? usage : [usage],
  notes: [...(canonical.notes ?? []), note],
});

const MODELS_PAGE = page('Inspect the model registry and backend listings.', [
  'fadeno models [<name>]',
  'fadeno models --harness <id>',
  'fadeno models add <alias> <provider/id>',
  'fadeno models remove <alias> [--force]',
  'fadeno models verify [<ref>...] [--harness <id>] [--strict]',
]);
const SHADOW_PAGE = page('Attach or show a sampled shadow challenger.', [
  'fadeno dial shadow',
  'fadeno dial shadow <archetype> <model>[@effort] [options]',
]);
const MODEL_ADD_PAGE = page('Discover and persist a canonical user model alias.', 'fadeno models add <alias> <provider/id>', [
  'Discovery checks direct OpenCode first, then the OpenCode/OpenRouter discovery path.',
]);
const MODEL_REMOVE_PAGE = page('Remove a user-catalog model alias.', 'fadeno models remove <alias> [--force] [--json]', [
  'Edits the user catalog only; a builtin or project entry names the file to edit instead.',
  'Refuses while a dial or shadow attachment names the alias; --force removes it and reports each stranded reference.',
  'Cached verification rows for the alias are dropped with it.',
]);
const MODEL_VERIFY_PAGE = page(
  'Re-probe dialed models against their harness listings.',
  'fadeno models verify [<ref>...] [--harness <id>] [--strict] [--json]',
  [
    'Ignores the verification cache and always re-probes; refreshes a row that still lists, deletes one that does not.',
    'Exits non-zero when a listing definitively omits a dialed model; --strict also fails on an unreachable listing.',
    'A `<ref>` narrows by alias, delivered id, or provider/id; an unmatched ref is an error, never an empty pass.',
  ],
);

const TOP_LEVEL: Record<string, PageSeed> = {
  setup: page('Install safe user-scoped integration.', 'fadeno setup [--codex|--claude] [options]'),
  status: page('Show effective definitions, routing, and runtime state.', 'fadeno status [options]'),
  models: MODELS_PAGE,
  clean: page('Remove machine-local scratch: worktrees of closed dispatches and command-lane transcripts.', 'fadeno clean [--force]', [
    'Previews by default. A worktree holding uncommitted work, or belonging to a dispatch that is not closed, is kept and the reason printed. Prompts and the ledger are never touched; branches are left behind.',
  ]),
  dispatch: page('Run one dispatch on the command lane: resolve the archetype, cut a worktree, run the executor, record it.', ['fadeno dispatch --archetype <name> [options]', 'fadeno dispatch --model <ref> [options]'], [
    'Reads the prompt from stdin or `--prompt-file`. `--archetype` is required unless `--model` is supplied; both are accepted, and an explicit model is recorded as a one-dispatch override.',
    'The executor runs in a worktree cut from HEAD (`--from <ref>` cuts elsewhere; `--shared` works in the live tree on your explicit request), with the dispatch contract appended to the prompt. Its stdout is the report and is printed verbatim; its exit code is yours.',
    'Every dispatch must be closed afterwards: `fadeno dispatch-close <name> --merged|--kept|--discarded|--failed`. Fadeno performs no merge.',
  ]),
  'dispatch-open': page('The spawn wrapper for a spawn the host is about to make: open it on the host lane, or hand it to the command lane.', 'fadeno dispatch-open --archetype <name> [--name <n>] [--model <ref>] [--lane auto|host|command] [--shared] [--from <ref>] [--session-id <id>] [--parent <id> | --parent-transcript <path>] [--harness <id>] (--prompt-file <path> | stdin) [--json]', [
    'The spawn hook\'s entry point. With `--lane auto` (the default) the resolution decides: a model this session can deliver opens on the host lane — worktree cut, row written, and `--json` carries the contract-bearing prompt the agent should receive — while any other model is a relay: nothing is opened, the prompt is staged, and `relay.command` is the `fadeno dispatch` call the dispatch proxy runs.',
    '`--lane host` opens on the host lane regardless, for a caller about to run the agent in-session itself; `--lane command` stages the relay regardless.',
    'Refused (exit 3) at the unclosed-dispatch limit; the refusal names what to close.',
  ]),
  'dispatch-stop': page('Record that a host-lane dispatch\'s agent stopped, and what its tree holds.', 'fadeno dispatch-stop [<name|id>] [--transcript <path>] [--message-file <path> | stdin] [--agent-cwd <dir>] [--json]', [
    'The stop hook\'s entry point. Records presence of a final message, never completeness, and the uncommitted paths in the assigned worktree. A second stop for the same dispatch is a replay.',
    '`--transcript` reads the agent\'s transcript: the contract header in its prompt names the dispatch (so the ref may be omitted), the last assistant turn supplies the final message when none was passed, and the model the agent ran on is recorded beside the one the dial asked for. A transcript with no contract is not a dispatch: exit 4, nothing recorded.',
  ]),
  'dispatch-close': page('Record the terminal decision for a dispatch.', 'fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed [--note <text>]', [
    'Exactly one verb. The same verb twice is a replay; a different verb for an already-closed dispatch is refused. Closing removes nothing: the branch stays, and the worktree stays until `fadeno clean`.',
  ]),
  cancel: page('Stop a running command-lane dispatch by signalling its process group.', 'fadeno cancel <name|id>', [
    'Refuses a host-lane dispatch (the subagent is the harness\'s to stop) and a dispatch that is not running. Writes the stop row if the launcher did not. The dispatch still needs closing.',
  ]),
  dispatches: page('List dispatches, show one, or print a report.', ['fadeno dispatches [--all] [--tail <count>] [--json]', 'fadeno dispatches <name|id> [--json]', 'fadeno dispatches --output <name|id>'], [
    'Unclosed dispatches by default; `--all` includes closed ones. A name resolves when it is unique, a unique id prefix too; ambiguity is refused rather than guessed.',
    '`--output` prints the command-lane transcript, or the final message the stop row recorded.',
  ]),
  worktrees: page('Report every Fadeno worktree holding work that is not on HEAD.', 'fadeno worktrees [--json]', [
    'The cross-session safety net: uncommitted paths and unmerged commits per worktree, joined to the dispatch that owns it. A tree that cannot be read is reported as such, never as clean.',
  ]),
  context: page('Print what a host session is told: archetypes with live routing, the rules, and every unclosed dispatch.', 'fadeno context [--json]', [
    'One source for the host-mode hook, a spawned director\'s prompt, and a human who wants to see it.',
  ]),
  model: aliasPage(MODELS_PAGE, [
    'fadeno model [<name>]',
    'fadeno model --harness <id>',
    'fadeno model add <alias> <provider/id>',
    'fadeno model remove <alias> [--force]',
    'fadeno model verify [<ref>...] [--harness <id>] [--strict]',
  ], '`fadeno model` is an alias for `fadeno models`.'),
  dial: page('Show or set per-archetype model selection.', [
    'fadeno dial',
    'fadeno dial <archetype> [<model>[@effort]]',
    'fadeno dial <a> <b>... <model>[@effort] [options]',
    'fadeno dial <a>+<b>[+...] <model>[@effort] [options]',
    'fadeno dial <a>,<b>[,...] <model>[@effort] [options]',
    'fadeno dial clear [<archetype>] [--session|--user|--repo]',
    'fadeno dial shadow [<archetype> <model>[@effort]] [options]',
    'fadeno dial clear-shadow [<archetype>]        (alias: fadeno shadow clear)',
    'fadeno dial resolve --archetype <name> [--prompt-sha256 <hex>]',
  ], [
    'Cascade: binding → session dial → repo pin → user dial → base.',
    '`shadow` attaches a one-shot challenger; `--rate <r>` rolls it on that fraction of dispatches and `--n <count>` caps how many roll. Shadows roll on ad-hoc `fadeno dispatch` only — `fadeno drive` runs are unpaired.',
    '`clear-shadow` with an archetype detaches that one and fails if it has none; with NO archetype it detaches EVERY attachment. Shadows live only in `.fadeno/local/dials`, so — unlike `clear` — it takes no `--session|--user|--repo` scope flag.',
  ]),
  shadow: aliasPage(SHADOW_PAGE, ['fadeno shadow', 'fadeno shadow <archetype> <model>[@effort] [options]', 'fadeno shadow clear [<archetype>]'], '`fadeno shadow` is an alias for `fadeno dial shadow`, and `fadeno shadow clear` for `fadeno dial clear-shadow`.'),
  plugin: page('Generate a harness plugin from this checkout.', 'fadeno plugin [dir] [--codex|--omp] [--force]', ['Claude Code is the default plugin; `--codex` and `--omp` select their generators. OpenCode and Grok use `fadeno init` instead.']),
  completion: page('Emit sourceable Bash completion.', 'fadeno completion bash'),
};

const NESTED: Record<string, PageSeed> = {
  'models add': MODEL_ADD_PAGE,
  'model add': aliasPage(MODEL_ADD_PAGE, 'fadeno model add <alias> <provider/id>', '`fadeno model add` is an alias for `fadeno models add`.'),
  'models remove': MODEL_REMOVE_PAGE,
  'model remove': aliasPage(MODEL_REMOVE_PAGE, 'fadeno model remove <alias> [--force] [--json]', '`fadeno model remove` is an alias for `fadeno models remove`.'),
  'models verify': MODEL_VERIFY_PAGE,
  'model verify': aliasPage(
    MODEL_VERIFY_PAGE,
    'fadeno model verify [<ref>...] [--harness <id>] [--strict] [--json]',
    '`fadeno model verify` is an alias for `fadeno models verify`.',
  ),
  'dial clear': page('Clear one or more dial layers.', 'fadeno dial clear [<archetype>] [--session|--user|--repo]'),
  'dial shadow': aliasPage(SHADOW_PAGE, SHADOW_PAGE.usage, '`fadeno shadow` is the top-level alias.'),
  'dial clear-shadow': page('Remove shadow attachments.', 'fadeno dial clear-shadow [<archetype>]'),
  'dial resolve': page('Emit the stable dial-resolution hook contract.', 'fadeno dial resolve --archetype <name> [--prompt-sha256 <hex>]'),
  'completion bash': page('Emit sourceable Bash completion.', 'fadeno completion bash', undefined, ['source <(fadeno completion bash)']),
};

const OPTION_HINTS: Record<string, string> = {
  '--agent-cwd': 'Where the agent actually worked',
  '--all': 'Include closed dispatches',
  '--archetype': 'Archetype name',
  '--claude': 'Target Claude Code',
  '--codex': 'Target Codex',
  '--discarded': 'Close: the work is not wanted',
  '--failed': 'Close: the dispatch did not succeed',
  '--force': 'Overwrite managed files',
  '--from': 'Ref to cut the worktree from (dispatch), or runtime source directory (setup)',
  '--grok': 'Target Grok Build',
  '--harness': 'Executor harness',
  '--heartbeat': 'Seconds between still-running echoes',
  '--help': 'Show this command help',
  '--json': 'Emit structured JSON output',
  '--kept': 'Close: keep the branch for later',
  '--merged': 'Close: the work landed',
  '--message-file': 'File holding the agent\u2019s final message',
  '--model': 'Direct model reference',
  '--n': 'Maximum shadow pairings',
  '--name': 'Semantic dispatch name; also the branch',
  '--non-interactive': 'Never prompt during setup',
  '--note': 'Free text recorded on the decision',
  '--omp': 'Target omp',
  '--opencode': 'Target OpenCode',
  '--output': 'Print the report of a dispatch',
  '--parent': 'Dispatch id this spawn belongs to',
  '--prompt-file': 'Read prompt from file',
  '--prompt-sha256': 'Prompt content SHA-256',
  '--rate': 'Shadow sampling rate',
  '--repo': 'Repository scope',
  '--reset-runtime': 'Allow runtime downgrade',
  '--scope': 'Installation scope',
  '--session': 'Local session scope',
  '--session-id': 'Host session the spawn came from',
  '--lane': 'Which lane opens it: auto (the resolution decides), host, or command',
  '--transcript': 'The agent\'s transcript, read for the dispatch id, final message and model',
  '--parent-transcript': 'The spawning agent\'s transcript; its contract header names the parent dispatch',
  '--shadow': 'One-shot challenger reference',
  '--shared': 'Work in the live tree instead of a worktree',
  '--strict': 'Fail on an unreachable listing too',
  '--tail': 'Number of recent entries',
  '--user': 'User-default scope',
  '--verbose': 'Include diagnostic detail',
  '--version': 'Show Fadeno version',
};

const OPTION_FORMS: Record<string, string> = {
  '--format': '--format <format>', '--schema': '--schema <kind>',
  '--archetype': '--archetype <name>', '--model': '--model <ref>', '--harness': '--harness <id>',
  '--prompt-file': '--prompt-file <path>', '--output': '--output <path>', '--lane': '--lane <auto|host|command>', '--transcript': '--transcript <path>', '--parent-transcript': '--parent-transcript <path>', '--bind': '--bind <role=executor>',
  '--tool': '--tool <name>', '--input': '--input <name=path>',
  '--rate': '--rate <0..1>', '--n': '--n <count>', '--prompt-sha256': '--prompt-sha256 <hex>',
  '--host-executor': '--host-executor <name>', '--native-executor': '--native-executor <name>',
  '--role': '--role <name>', '--run': '--run <id>', '--dispatch-id': '--dispatch-id <id>',
  '--tag': '--tag <label>', '--ignored-output': '--ignored-output <policy>', '--agent-id': '--agent-id <id>',
  '--workspace': '--workspace <path>', '--branch': '--branch <name>', '--file': '--file <path>',
  '--source': '--source <kind>', '--commit': '--commit <sha>', '--reason': '--reason <text>',
  '--step': '--step <id>', '--status': '--status <status>', '--event': '--event <type>', '--iteration': '--iteration <count>',
  '--artifact': '--artifact <path>', '--report': '--report <path>', '--member': '--member <role>',
  '--field': '--field <key=value>', '--max-transitions': '--max-transitions <count>', '--parallel': '--parallel <count>',
  '--actor-call': '--actor-call <id>', '--decision': '--decision <id>', '--feedback': '--feedback <text>',
  '--tail': '--tail <count>', '--wait': '--wait <seconds>', '--cancel': '--cancel <id|tag>', '--merge': '--merge <id|tag>',
  '--arm': '--arm <arm>', '--shadow': '--shadow <ref>', '--evidence': '--evidence <mode>', '--comparison': '--comparison <path>',
  '--adversarial': '--adversarial <path>', '--judge': '--judge <ref>', '--scope': '--scope <project|user>',
  '--from': '--from <bin-dir>', '--unbind': '--unbind <role>', '--note': '--note <text>',
};

const withGlobals = (...flags: string[]): readonly string[] => ['--help', '--version', ...flags];

/**
 * Help is a user-facing contract, not a dump of parser/completion acceptance.
 * Keep only options that the command actually uses, and let mode-specific
 * usage carry options whose meaning depends on the selected mode.
 */
const PAGE_OPTIONS: Record<string, readonly string[]> = {
  setup: withGlobals('--codex', '--claude', '--from', '--reset-runtime'),
  status: withGlobals('--verbose', '--codex', '--claude', '--opencode', '--omp'),
  models: withGlobals('--harness', '--json'),
  model: withGlobals('--harness', '--json'),
  dial: withGlobals('--harness', '--session', '--user', '--repo', '--json'),
  shadow: withGlobals('--harness', '--rate', '--n', '--json'),
  clean: withGlobals('--force'),
  dispatch: withGlobals('--archetype', '--model', '--name', '--prompt-file', '--shared', '--from', '--session-id', '--parent', '--heartbeat'),
  'dispatch-open': withGlobals('--archetype', '--model', '--name', '--lane', '--prompt-file', '--shared', '--from', '--session-id', '--parent', '--parent-transcript', '--harness', '--json'),
  'dispatch-stop': withGlobals('--transcript', '--message-file', '--agent-cwd', '--json'),
  'dispatch-close': withGlobals('--merged', '--kept', '--discarded', '--failed', '--note'),
  cancel: withGlobals(),
  dispatches: withGlobals('--all', '--tail', '--json', '--output'),
  worktrees: withGlobals('--json'),
  context: withGlobals('--json'),
  plugin: withGlobals('--codex', '--omp', '--force'),
  completion: withGlobals(),
  'models add': withGlobals('--json'),
  'model add': withGlobals('--json'),
  'models remove': withGlobals('--force', '--json'),
  'model remove': withGlobals('--force', '--json'),
  'models verify': withGlobals('--harness', '--strict', '--json'),
  'model verify': withGlobals('--harness', '--strict', '--json'),
  'dial clear': withGlobals('--session', '--user', '--repo', '--json'),
  'dial shadow': withGlobals('--harness', '--rate', '--n', '--json'),
  'dial clear-shadow': withGlobals('--json'),
  'dial resolve': withGlobals('--archetype', '--prompt-sha256'),
  'completion bash': withGlobals(),
};

const PATH_OPTION_HINTS: Record<string, Record<string, string>> = {
  clean: { '--force': 'Remove what the preview listed' },
  plugin: { '--force': 'Overwrite generated plugin files' },
  'models remove': { '--force': 'Remove despite live dials, naming each stranded' },
  'model remove': { '--force': 'Remove despite live dials, naming each stranded' },
};

const PATH_OPTION_FORMS: Record<string, Record<string, string>> = {
  dispatches: { '--output': '--output <name|id>', '--tail': '--tail <count>' },
  dispatch: { '--name': '--name <name>', '--from': '--from <ref>', '--heartbeat': '--heartbeat <seconds>' },
  'dispatch-open': { '--name': '--name <name>', '--from': '--from <ref>', '--session-id': '--session-id <id>', '--parent': '--parent <id>' },
  'dispatch-stop': { '--message-file': '--message-file <path>', '--agent-cwd': '--agent-cwd <dir>' },
  'dispatch-close': { '--note': '--note <text>' },
};

export const HELP_PATHS: readonly string[] = Object.freeze([...Object.keys(TOP_LEVEL), ...Object.keys(NESTED)].sort());

const HELP_LINE_WIDTH = 100;

function wrapHelpText(text: string, firstPrefix = '', continuationPrefix = firstPrefix): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [firstPrefix.trimEnd()];
  const lines: string[] = [];
  let line = firstPrefix;
  for (const word of words) {
    const separator = line === firstPrefix || line === continuationPrefix ? '' : ' ';
    if (line.length + separator.length + word.length > HELP_LINE_WIDTH && line.trim().length > 0) {
      lines.push(line.trimEnd());
      line = `${continuationPrefix}${word}`;
    } else {
      line += `${separator}${word}`;
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

/** Longest public command-path prefix, preserving aliases as the caller typed them. */
export function resolveHelpPath(positionals: readonly string[]): string | null {
  for (let length = Math.min(2, positionals.length); length >= 1; length -= 1) {
    const candidate = positionals.slice(0, length).join(' ');
    if (HELP_PATHS.includes(candidate)) return candidate;
  }
  return null;
}

function optionsFor(path: string): string[] {
  const options = PAGE_OPTIONS[path];
  if (options == null) throw new Error(`No semantic focused-help options registered for ${path}.`);
  return [...options]
    .sort()
    .map((flag) => `${PATH_OPTION_FORMS[path]?.[flag] ?? OPTION_FORMS[flag] ?? flag}`)
    .map((flag) => {
      const name = flag.split(' ')[0]!;
      const hint = PATH_OPTION_HINTS[path]?.[name] ?? OPTION_HINTS[name];
      if (hint == null) throw new Error(`No focused-help description registered for ${name}.`);
      const prefix = `  ${flag.padEnd(30)} `;
      return wrapHelpText(hint, prefix, ' '.repeat(prefix.length)).join('\n');
    });
}

export function renderGlobalHelp(): string {
  return `fadeno — the playbook layer for AI coding agents

Usage: fadeno <command> [options]

Routing
  dial        Show, set and resolve archetype bindings (shadow is its alias)
  models (model)  Inspect the model registry
  context     What a host session is told

Dispatches
  dispatch, dispatch-close, cancel, dispatches, worktrees
  dispatch-open, dispatch-stop  (the hooks' entry points)

Setup and maintenance
  setup, status, clean, plugin, completion

Global options
  -h, --help       Show this page or focused command help
  -v, --version    Show the Fadeno version

Run \`fadeno <command> --help\` for exact usage and command options.

Examples:
  fadeno init --codex
  fadeno init --grok
  fadeno playbooks
  fadeno new-run code-change-review "Add CSV export"
  fadeno drive <run>`;
}

/** Render one structured focused page. Throws only if registry maintenance missed a public path. */
export function renderFocusedHelp(path: string): string {
  const seed = NESTED[path] ?? TOP_LEVEL[path];
  if (seed == null) throw new Error(`No focused help registered for ${path}.`);
  const options = optionsFor(path);
  const parts = [
    ...wrapHelpText(`fadeno ${path} — ${seed.summary}`),
    '',
    'Usage:',
    ...seed.usage.flatMap((usage) => wrapHelpText(usage, '  ', '    ')),
  ];
  if (options.length > 0) parts.push('', 'Options:', ...options);
  if (seed.notes?.length) parts.push('', ...seed.notes.flatMap((note) => wrapHelpText(note)));
  if (seed.examples?.length) parts.push('', 'Examples:', ...seed.examples.flatMap((example) => wrapHelpText(example, '  ', '    ')));
  return parts.join('\n');
}

/** Testable guard against a new completion command silently missing focused help. */
export function missingHelpPaths(): string[] {
  return PUBLIC_COMMAND_PATHS.filter((path) => !HELP_PATHS.includes(path));
}

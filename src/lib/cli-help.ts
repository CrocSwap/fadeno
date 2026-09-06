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
  doctor: page('Run read-only integration diagnostics.', 'fadeno doctor [options]', [
    'Every check reads files. --probe-models is the exception: it spawns each dialed harness\u2019s models_command.',
    'Reports a dialed model its backend no longer lists, a user-catalog alias the loader had to repair or drop, a verification row past the freshness window, and every persisted surface whose schema_version this build cannot read.',
  ]),
  vendor: page('Vendor capability and definitions into this project.', 'fadeno vendor --codex|--claude|--grok|--opencode|--omp [options]'),
  uninstall: page('Remove managed user integration.', [
    'fadeno uninstall --codex|--claude|--all [options]',
    'fadeno uninstall --purge-user-data --force [--codex|--claude|--all]',
  ]),
  clean: page('Preview or remove ignored repository runtime state.', 'fadeno clean [--force]'),
  unvendor: page('Remove lock-owned vendored files.', 'fadeno unvendor [--force]'),
  evidence: page('Promote a verified run receipt.', 'fadeno evidence promote <run>'),
  init: page('Scaffold project-owned Fadeno capability.', 'fadeno init --codex|--claude|--grok|--opencode|--omp [options]'),
  validate: page('Validate playbooks and run documents.', 'fadeno validate [file] [--schema <kind>]'),
  playbooks: page('Browse effective bundled and project workflows.', ['fadeno playbooks', 'fadeno playbooks <name> [--json]']),
  diagram: page('Render a playbook workflow as ASCII or Mermaid.', 'fadeno diagram <playbook> [--format ascii|mermaid]'),
  'new-run': page('Create a run ledger from a playbook.', 'fadeno new-run <playbook> <task> [--input Name=path]...'),
  models: MODELS_PAGE,
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
    'fadeno dial clear-shadow [<archetype>]',
    'fadeno dial resolve --archetype <name> [--prompt-sha256 <hex>]',
  ], ['Cascade: binding → session dial → repo pin → user dial → base.']),
  shadow: aliasPage(SHADOW_PAGE, ['fadeno shadow', 'fadeno shadow <archetype> <model>[@effort] [options]'], '`fadeno shadow` is an alias for `fadeno dial shadow`.'),
  steering: page('Resolve dials or materialize harness steering.', ['fadeno steering resolve --archetype <name> [options]', 'fadeno steering apply --codex|--claude|--opencode|--omp [options]']),
  dispatch: page('Resolve an archetype and invoke it once.', ['fadeno dispatch --archetype <name> [options]', 'fadeno dispatch --model <ref> [options]'], ['Read prompt text from stdin or `--prompt-file`. `--archetype` is required unless `--model` is supplied; both are accepted.', 'Dispatches isolate by default and merge a successful primary diff back. `--isolate` withholds merge-back; `--shadow <ref>` adds a one-shot challenger.', 'A failed relay-fidelity check refuses the dispatch before the executor spawns; `--allow-relay-mismatch` proceeds and records `relay_mismatch_allowed: true`.', 'Recover output with `fadeno dispatches --output tag:<tag> --wait 120`.']),
  'dispatch-prepare': page('Prepare an isolated workspace for a pending host dispatch.', 'fadeno dispatch-prepare <run> <dispatch-id> --isolate'),
  'dispatch-prompt': page('Emit the canonical host-dispatch envelope.', 'fadeno dispatch-prompt <run> <dispatch-id>'),
  'dispatch-fallback': page('Deliver a locked host request through its declared fallback.', 'fadeno dispatch-fallback <run> <dispatch-id>'),
  'dispatch-start': page('Record a host dispatch start.', 'fadeno dispatch-start <run> <dispatch-id> --agent-id <host-agent-id> [options]'),
  'dispatch-progress': page('Record an attested host progress observation.', 'fadeno dispatch-progress <run> <dispatch-id> --file <status.json> [options]'),
  'dispatch-complete': page('Submit a host dispatch result.', 'fadeno dispatch-complete <run> <dispatch-id> --output <path|-> [options]'),
  'dispatch-fail': page('Submit a host dispatch failure.', 'fadeno dispatch-fail <run> <dispatch-id> --reason <text>'),
  'dispatch-withdraw': page(
    'Retire a host request that was minted and never started.',
    'fadeno dispatch-withdraw <run> <dispatch-id> --reason <text>',
    [
      'Records a terminal receipt with no start; the next `fadeno drive` mints the next attempt under the current cascade or binding.',
      'Refuses after `dispatch-start` (use `dispatch-fail`). Repeating the same `--reason` is idempotent.',
    ],
  ),
  run: page('Append attested updates to a run ledger.', 'fadeno run <run> [options]'),
  'tool-run': page('Execute a registered ready tool step.', 'fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]', ['The registered tool determines its output artifact; there is no `--output` override. Use `--timeout 0` to disable a route deadline.']),
  'tool-complete': page('Record a manually produced tool result.', 'fadeno tool-complete <run> --output <artifact-path>'),
  gate: page('Evaluate a deterministic gate from an artifact.', 'fadeno gate <run> <condition> [--artifact <path>]'),
  prompt: page('Assemble and optionally record an actor prompt.', 'fadeno prompt <run> <step> [options]'),
  next: page('Emit the next actionable run step.', 'fadeno next <run> [--legacy]'),
  drive: page('Advance a run until it is terminal or paused.', 'fadeno drive <run> [options]', [
    'Use `--timeout 0` to disable a route deadline; none by default.',
    'Release a role bound by an earlier `--bind` of this run with `--unbind <role>`. Without it, an invocation that would start new work for a bound role on a different executor is refused.',
  ]),
  cancel: page('Cancel a live engine attempt.', 'fadeno cancel <run> [--actor-call <id>]', ['Sends SIGTERM to the single live engine command claim; the engine records the terminal receipt.']),
  decide: page('Resolve a pending named human decision.', 'fadeno decide <run> <option> [options]'),
  'attempt-accept': page('Accept a hand-resolved isolated attempt.', 'fadeno attempt-accept <run> <actor-call>'),
  runs: page('List run ledgers under `.fadeno/runs`.', 'fadeno runs'),
  attest: page('Record this subagent delivery as evidence.', 'fadeno attest --archetype <name>'),
  dispatches: page('Inspect or recover command dispatches.', ['fadeno dispatches [--tail <count>] [--json] [--bakeoffs]', 'fadeno dispatches --output <id|last|tag:<tag>> [--wait <seconds>]', 'fadeno dispatches --cancel <id|tag:<tag>> | --merge <id|tag:<tag>>', 'fadeno dispatches --withdraw <id|tag:<tag>> --reason <text> [--work-left <path>]'], ['`--output` writes the saved snapshot bytes verbatim to stdout; use `--wait` only for a completion row.', '`--cancel` signals a live executor. `--withdraw` is the second move for one nothing can signal: it records the terminal receipt, signals nothing, and removes no workspace. It is refused while any process behind the claim is alive.', 'A `relay_attested: false` dispatch is quarantined: `--output` prefixes the bytes with the failure, and `--merge` refuses without `--allow-relay-mismatch`.']),
  'shadow-apply': page('Apply a selected shadow arm diff.', 'fadeno shadow-apply <pair-id|dispatch-id> [--arm challenger|primary] [--check]'),
  bakeoff: page('Measure or adjudicate a shadow pair.', ['fadeno bakeoff <pair-id|dispatch-id> [--measure-only] [--judge <ref>] [--harness <id>] [--evidence inlined|explored]', 'fadeno bakeoff <pair-id|dispatch-id> --prepare [--evidence inlined|explored]', 'fadeno bakeoff <pair-id|dispatch-id> --record --comparison <file> --adversarial <file> [--evidence inlined|explored]'], ['`--measure-only` records no adjudication; `--prepare` writes blinded prompts; `--record` requires both host-delivered judgment files.']),
  show: page('Show a run step projection and artifacts.', 'fadeno show <run> [--events] [--legacy]'),
  verify: page('Re-audit a run’s deterministic claims.', ['fadeno verify <run> [options]', 'fadeno verify --latest [options]']),
  plugin: page('Generate a harness plugin from this checkout.', 'fadeno plugin [dir] [--codex|--omp] [--force]', ['Claude Code is the default plugin; `--codex` and `--omp` select their generators. OpenCode and Grok use `fadeno init` instead.']),
  completion: page('Emit sourceable Bash completion.', 'fadeno completion bash'),
};

const NESTED: Record<string, PageSeed> = {
  'evidence promote': page('Promote a verified run receipt.', 'fadeno evidence promote <run>'),
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
  'steering resolve': page('Resolve one hybrid host steering request.', 'fadeno steering resolve --archetype <name> [options]'),
  'steering apply': page('Materialize harness steering from active dials.', 'fadeno steering apply --codex|--claude|--opencode|--omp [options]'),
  'completion bash': page('Emit sourceable Bash completion.', 'fadeno completion bash', undefined, ['source <(fadeno completion bash)']),
};

const OPTION_HINTS: Record<string, string> = {
  '--adversarial': 'Adversarial judgment file', '--agent-id': 'Host agent identity', '--all': 'Every managed harness',
  '--allow-failed': 'Accept a failed terminal run', '--archetype': 'Archetype name', '--arm': 'Shadow-pair arm',
  '--artifact': 'Artifact path', '--actor': 'Actor or role name', '--actor-call': 'Engine actor-call id',
  '--bakeoffs': 'Show bakeoff scorecards', '--bind': 'Role-to-executor override', '--branch': 'Host branch provenance',
  '--cancel': 'Dispatch id or tag to cancel', '--check': 'Check applicability only', '--claude': 'Target Claude Code',
  '--codex': 'Target Codex', '--commit': 'Optional commit provenance', '--comparison': 'Comparison judgment file',
  '--data-only': 'Definitions without host capability', '--decision': 'Pending decision id', '--diagnostics': 'Persist bounded process diagnostics',
  '--dispatch-id': 'Immutable host dispatch id', '--harness': 'Executor harness', '--events': 'Include raw event timeline',
  '--evidence': 'Judge evidence mode', '--event': 'Custom run event type', '--feedback': 'Human decision feedback', '--field': 'Additional event field',
  '--file': 'Progress status file', '--force': 'Overwrite managed files', '--format': 'Rendered output format',
  '--from': 'Runtime source directory', '--grok': 'Target Grok Build', '--help': 'Show this command help',
  '--host-executor': 'Materialized host executor', '--ignored-output': 'Gitignored output retention policy', '--inline': 'Embed input contents',
  '--input': 'Declared input name and path', '--isolate': 'Use an isolated worktree', '--iteration': 'Loop iteration to target', '--json': 'Emit structured JSON output',
  '--judge': 'Override judge model reference', '--latest': 'Use newest run', '--legacy': 'Enable explicit legacy compatibility',
  '--max-transitions': 'Engine transition limit', '--measure-only': 'Measure without adjudicating', '--member': 'Map member attribution',
  '--merge': 'Dispatch id or tag to merge', '--model': 'Direct model reference', '--n': 'Maximum shadow pairings',
  '--allow-relay-mismatch': 'Proceed despite a failed relay-fidelity check',
  '--native-executor': 'Legacy host-executor spelling', '--no-brief': 'Skip archetype brief preamble', '--no-record': 'Preview without recording',
  '--no-steering': 'Do not scaffold steering', '--non-interactive': 'Never prompt during setup', '--omp': 'Target omp',
  '--opencode': 'Target OpenCode', '--output': 'Output artifact path or selector', '--parallel': 'Concurrent deliveries in isolated worktrees',
  '--prepare': 'Write blinded judge prompts', '--prompt-file': 'Read prompt from file', '--prompt-sha256': 'Prompt content SHA-256',
  '--purge-user-data': 'Also remove shared user data', '--rate': 'Shadow sampling rate', '--reason': 'Failure or withdrawal reason', '--withdraw': 'Retire a dead dispatch by id or tag',
  '--work-left': 'Tree still holding a withdrawn dispatch\u2019s work',
  '--record': 'Record supplied host judgments', '--repo': 'Repository scope', '--report': 'Legacy artifact-path spelling',
  '--reset-runtime': 'Allow runtime downgrade', '--role': 'Role name', '--run': 'Immutable engine run id',
  '--schema': 'Document schema kind', '--scope': 'Steering installation scope', '--session': 'Local session scope',
  '--shadow': 'One-shot challenger reference', '--shared': 'Run in the current worktree', '--source': 'Progress observation source',
  '--status': 'Run status', '--step': 'Run step id', '--strict': 'Fail on an unreachable listing too',
  '--tag': 'Dispatch recovery label', '--tail': 'Number of recent entries',
  '--unbind': 'Release a role bound earlier in this run',
  '--timeout': 'Deadline in seconds (0 disables)', '--tool': 'Registered tool name', '--user': 'User-default scope',
  '--verbose': 'Include diagnostic detail', '--version': 'Show Fadeno version',
  '--wait': 'Wait before recovering output', '--with-hooks': 'Scaffold enforcement hooks', '--with-steering': 'Deprecated compatibility alias; steering is already default',
  '--workspace': 'Host workspace provenance',
};

const OPTION_FORMS: Record<string, string> = {
  '--timeout': '--timeout <seconds>', '--format': '--format <format>', '--schema': '--schema <kind>',
  '--archetype': '--archetype <name>', '--model': '--model <ref>', '--harness': '--harness <id>',
  '--prompt-file': '--prompt-file <path>', '--output': '--output <path>', '--bind': '--bind <role=executor>',
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
  '--from': '--from <bin-dir>', '--unbind': '--unbind <role>',
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
  doctor: withGlobals('--codex', '--claude', '--opencode', '--omp', '--probe-models', '--json'),
  vendor: withGlobals('--codex', '--claude', '--grok', '--opencode', '--omp', '--no-steering', '--force'),
  uninstall: withGlobals('--codex', '--claude', '--all', '--purge-user-data', '--force'),
  clean: withGlobals('--force'),
  unvendor: withGlobals('--force'),
  evidence: withGlobals(),
  init: withGlobals('--codex', '--claude', '--grok', '--opencode', '--omp', '--with-hooks', '--with-steering', '--no-steering', '--data-only', '--force'),
  validate: withGlobals('--schema'),
  playbooks: withGlobals('--json'),
  diagram: withGlobals('--format'),
  'new-run': withGlobals('--input'),
  models: withGlobals('--harness', '--json'),
  model: withGlobals('--harness', '--json'),
  dial: withGlobals('--harness', '--session', '--user', '--repo', '--json'),
  shadow: withGlobals('--harness', '--rate', '--n', '--json'),
  steering: withGlobals(),
  dispatch: withGlobals('--archetype', '--model', '--role', '--harness', '--prompt-file', '--tag', '--shadow', '--timeout', '--isolate', '--shared', '--ignored-output', '--diagnostics', '--no-brief', '--allow-relay-mismatch'),
  'dispatch-prepare': withGlobals('--isolate'),
  'dispatch-prompt': withGlobals(),
  'dispatch-fallback': withGlobals(),
  'dispatch-start': withGlobals('--agent-id', '--workspace', '--branch'),
  'dispatch-progress': withGlobals('--file', '--source'),
  'dispatch-complete': withGlobals('--output', '--commit'),
  'dispatch-fail': withGlobals('--reason'),
  'dispatch-withdraw': withGlobals('--reason'),
  run: withGlobals('--step', '--status', '--event', '--artifact', '--member', '--field'),
  'tool-run': withGlobals('--tool', '--timeout'),
  'tool-complete': withGlobals('--output'),
  gate: withGlobals('--artifact'),
  prompt: withGlobals('--actor', '--iteration', '--inline', '--no-record', '--format'),
  next: withGlobals('--legacy'),
  drive: withGlobals('--bind', '--unbind', '--max-transitions', '--parallel', '--timeout', '--diagnostics'),
  cancel: withGlobals('--actor-call'),
  decide: withGlobals('--decision', '--feedback'),
  'attempt-accept': withGlobals(),
  runs: withGlobals(),
  attest: withGlobals('--archetype'),
  dispatches: withGlobals('--tail', '--json', '--bakeoffs', '--output', '--wait', '--tag', '--cancel', '--withdraw', '--work-left', '--reason', '--merge', '--allow-relay-mismatch'),
  'shadow-apply': withGlobals('--arm', '--check'),
  bakeoff: withGlobals('--measure-only', '--evidence', '--prepare', '--record', '--comparison', '--adversarial', '--json', '--judge', '--harness'),
  show: withGlobals('--events', '--legacy'),
  verify: withGlobals('--latest', '--allow-failed', '--legacy'),
  plugin: withGlobals('--codex', '--omp', '--force'),
  completion: withGlobals(),
  'evidence promote': withGlobals(),
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
  'steering resolve': withGlobals('--archetype', '--host-executor', '--native-executor', '--role', '--run', '--dispatch-id', '--prompt-file', '--prompt-sha256'),
  'steering apply': withGlobals('--codex', '--claude', '--opencode', '--omp', '--scope', '--force'),
  'completion bash': withGlobals(),
};

const PATH_OPTION_HINTS: Record<string, Record<string, string>> = {
  clean: { '--force': 'Remove ignored runtime state' },
  unvendor: { '--force': 'Also remove modified lock-owned files' },
  uninstall: { '--force': 'Required with --purge-user-data; confirms removal' },
  vendor: { '--force': 'Overwrite managed vendored files' },
  init: { '--force': 'Overwrite managed scaffold files' },
  plugin: { '--force': 'Overwrite generated plugin files' },
  'steering apply': { '--force': 'Overwrite managed steering files' },
  'models remove': { '--force': 'Remove despite live dials, naming each stranded' },
  'model remove': { '--force': 'Remove despite live dials, naming each stranded' },
  doctor: { '--probe-models': 'Spawn each dialed harness\u2019s models_command and report a model it no longer lists' },
  dispatches: {
    '--output': 'Print saved snapshot bytes for an id, last dispatch, or tag',
    '--withdraw': 'Retire a dead dispatch that has no executor to signal',
    '--work-left': 'Tree that still holds the withdrawn dispatch\u2019s work',
    '--allow-relay-mismatch': 'Merge a relay_attested: false dispatch anyway',
  },
  dispatch: {
    '--isolate': 'Withhold the primary diff from merge-back',
    '--shared': 'Run directly in the current worktree',
    '--shadow': 'One-shot challenger model reference',
    '--allow-relay-mismatch': 'Dispatch despite relay_attested: false, on the record',
  },
};

const PATH_OPTION_FORMS: Record<string, Record<string, string>> = {
  dispatches: {
    '--output': '--output <id|last|tag:<tag>>',
    '--cancel': '--cancel <id|tag:<tag>>',
    '--withdraw': '--withdraw <id|tag:<tag>>',
    '--work-left': '--work-left <path>',
    '--merge': '--merge <id|tag:<tag>>',
  },
  'dispatch-complete': { '--output': '--output <path|->' },
  dispatch: { '--ignored-output': '--ignored-output <kept|discardable>' },
  'dispatch-progress': { '--source': '--source <agent|harness|director>' },
  prompt: { '--actor': '--actor <role>', '--format': '--format <text|json>' },
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

Get started
  init        Scaffold project capability
  playbooks   Browse workflows
  new-run     Create a run
  drive       Advance a run

Workflows and evidence
  validate, diagram, prompt, gate, run, tool-run, tool-complete, next,
  cancel, decide, attempt-accept, show, verify, runs, evidence, attest

Models and delivery
  dial, shadow, models (model), steering, dispatch, dispatches, shadow-apply, bakeoff

Host dispatch protocol
  dispatch-prepare, dispatch-prompt, dispatch-start, dispatch-progress,
  dispatch-complete, dispatch-fail, dispatch-withdraw, dispatch-fallback

Setup and maintenance
  setup, status, doctor, vendor, unvendor, clean, uninstall, plugin, completion

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

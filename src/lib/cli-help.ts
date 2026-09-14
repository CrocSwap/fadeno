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
  'fadeno models run <ref[@effort][ on <harness>]> [<prompt>...] [--prompt-file <path>]',
]);
const MODEL_ADD_PAGE = page('Discover and persist a canonical user model alias.', 'fadeno models add <alias> <provider/id>', [
  'Discovery checks direct OpenCode first, then the OpenCode/OpenRouter discovery path.',
]);
const MODEL_REMOVE_PAGE = page('Remove a user-catalog model alias.', 'fadeno models remove <alias> [--force] [--json]', [
  'Edits the user catalog only; a builtin or project entry names the file to edit instead.',
  'Refuses while a dial names the alias; --force removes it anyway and reports each stranded reference.',
  'Cached verification rows for the alias are dropped with it.',
]);
const MODEL_VERIFY_PAGE = page(
  'Re-probe selected model deliveries against their harness listings.',
  'fadeno models verify [<ref>...] [--harness <id>] [--strict] [--json]',
  [
    'With no refs, verifies every named model delivery in the effective archetype dial table. With refs, resolves registered aliases and identities directly from the merged model registry, including models no archetype currently dials.',
    'Refs accept an alias with an optional pinned effort, a provider/id, or a delivered harness id; use `on <harness>` or `--harness <id>` to select a delivery.',
    'Ignores the verification cache and always re-probes; refreshes a row that still lists, deletes a row that does not.',
    'Exits non-zero when a listing definitively omits a selected model; --strict also fails on an unreachable listing. Unknown, ambiguous, stale, host-only, and unlistable explicit refs fail before probing.',
  ],
);
const MODEL_RUN_PAGE = page('Run one registered model directly in temporary scratch.', 'fadeno models run <ref[@effort][ on <harness>]> [<prompt>...] [--prompt-file <path>]', [
  'Resolves a registered alias, provider/id, or unambiguous delivered id through the same layered catalog and delivery compiler as dispatch, then invokes its command harness with the delivered model id and effective effort.',
  'A quoted positional prompt is passed unchanged. Additional positional words are joined with single spaces; stdin is used when no positional prompt or file is supplied.',
  'The harness runs in a fresh temporary directory. No ledger row, prompt evidence, worktree, branch, or close obligation is created, and the scratch directory is removed after every outcome.',
  'This command requires a command-lane delivery; host-only, stale, unreadable, empty, conflicting, and invalid-command inputs fail before launch. Harness stdout and stderr are relayed verbatim and its exit status is returned.',
], [
  "fadeno model run sol \"Reply exactly: Hello, World!\"",
  "printf '%s\\n' 'Reply exactly: Hello, World!' | fadeno models run sol",
]);

const TOP_LEVEL: Record<string, PageSeed> = {
  setup: page('Link the CLI onto PATH, or reconcile Codex host vocabulary.', 'fadeno setup [--codex|--claude] [--agents-only] [--from <bin-dir>] [--force] [--json]', [
    'A symlink, never a copy: it follows whatever the plugin holds, so there is no second CLI to keep in step and no version to compare.',
    'Links into `~/.local/bin` unless `FADENO_BIN_DIR` says otherwise, and says so when that directory is not on PATH. `--claude` also grants `Bash(fadeno:*)` in your Claude settings so agents can run the CLI without a prompt each time.',
    '`--force` replaces a `fadeno` at the link path that Fadeno did not write.',
    '`--codex --agents-only` is the narrow, idempotent first-use operation run by `$fadeno-host`: it reconciles model-neutral archetype files and changes nothing else.',
  ]),
  status: page('Show effective routing, harness integration, and whatever needs attention.', 'fadeno status [--verbose] [--json]', [
    'Routing comes from the same table `fadeno dial` prints, so the two cannot tell different stories about one repo.',
    'The attention list is what a person has to act on: a dial that does not resolve or has no lane, a missing CLI link, a hand-written agent file that overrides a dial, worktrees holding unmerged work, and dispatches still open.',
  ]),
  models: MODELS_PAGE,
  clean: page('Remove machine-local scratch: safe stopped or closed worktrees and command-lane transcripts.', 'fadeno clean [--force]', [
    'Previews by default. A clean, readable worktree belonging to a stopped or closed dispatch (or no dispatch) may be removed; open/running, dirty, unreadable, and unregistered paths are kept and the reason printed. Prompts and the ledger are never touched; branches are left behind.',
    'The preview names the ignored paths that would go with each worktree, because those are invisible to git and are where a worker\'s receipts land when a prompt did not give it an absolute path.',
    'It also removes `.fadeno/local/` relay files, cooperative cancellation requests, and staged Codex prompt handoffs; recorded prompts under `.fadeno/prompts/` remain evidence and are never touched.',
  ]),
  dispatch: page('Run one dispatch on the command lane: resolve the archetype, cut a worktree, run the executor, record it.', ['fadeno dispatch --archetype <name> [--from <dispatch-name|id|ref|sha>] [options]', 'fadeno dispatch --model <ref> [options]'], [
    'Reads the prompt from stdin or `--prompt-file`. `--archetype` is required unless `--model` is supplied; both are accepted, and an explicit model is recorded as a one-dispatch override.',
    'The executor runs in a worktree cut from HEAD. `--from <dispatch-name|id>` follows the ledger only to that dispatch\'s reachable isolated branch; it never substitutes the opening base, and a shared-tree dispatch cannot supply a retained result. If the branch/result is unavailable, commit the desired state and pass that Git ref or commit SHA. Literal Git refs and SHAs also work. A cross-namespace match, or an exact name that is another dispatch id prefix, is refused; qualify a Git ref such as `refs/heads/main` or use the dispatch full UUID. `--shared` works in the live tree on your explicit request, but cannot be combined with `--from`. An invalid explicit `--from` is refused, and a worktree failure never falls back to shared for an explicit baseline.',
    'Every dispatch must be closed afterwards: `fadeno dispatch-close <name> --merged|--kept|--discarded|--failed|--reviewed`. Fadeno performs no merge.',
    'The launcher returns the executor\'s stdout verbatim even if a close row was written early by an older client; the later stop row still records the report observation.',
  ]),
  'dispatch-open': page('The spawn wrapper for a spawn the host is about to make: open it on the host lane, or hand it to the command lane.', 'fadeno dispatch-open --archetype <name> [--name <n>] [--model <ref>] [--lane auto|host|command] [--shared] [--from <dispatch-name|id|ref|sha>] [--session-id <id>] [--parent <id> | --parent-transcript <path>] [--harness <id>] [--agent-id <id>] (--prompt-file <path> | stdin | --prompt-sealed <reason> | --dry-run) [--json]', [
    'The spawn hook\'s entry point. With `--lane auto` (the default) the resolution decides: a model this session can deliver opens on the host lane — worktree cut, row written, and `--json` carries the contract-bearing prompt the agent should receive — while any other model is a relay: nothing is opened, the prompt is staged, and `relay.command` is the `fadeno dispatch` call the dispatch proxy runs.',
    '`--lane host` opens on the host lane regardless, for a caller about to run the agent in-session itself; `--lane command` stages the relay regardless.',
    '`--from <dispatch-name|id>` resolves through the repository ledger to the retained dispatch\'s reachable isolated branch. A shared dispatch or an unavailable branch/result is refused with instructions to commit the desired state and pass its Git ref or SHA; the recorded opening base is never used as a substitute. Literal Git refs and commit SHAs remain valid. Cross-namespace and exact-name/ID-prefix ambiguities are refused; qualify a Git ref (for example `refs/heads/main`) or use the dispatch full UUID. `--shared` cannot be combined with `--from`. An invalid explicit baseline, or a later isolated-worktree failure, is refused rather than silently becoming a shared-tree dispatch.',
    '`--agent-id <id>` records the harness\'s own id for the subagent, which is what `dispatch-stop` then resolves by — exactly, and without reading a transcript.',
    '`--prompt-sealed <reason>` opens a dispatch whose prompt the harness never showed Fadeno (Codex encrypts the message on its newer spawn tool). The row is stamped `prompt_sealed` and records the reason where the ask would be, so nothing downstream can mistake the explanation for the task. Every other field is measured as usual.',
    '`--dry-run` runs the resolution and every refusal check and then stops: it answers the lane, the model, the effort and whether this archetype is deliverable at all, and writes nothing. For a hook that must refuse a call one event before it has anything to open with — the same code path, so the refusal cannot drift from the open.',
    'Unclosed dispatches remain advisory ledger state; they are reported but never refuse a new spawn.',
  ]),
  'dispatch-stop': page('Record that a host-lane dispatch\'s agent stopped, and what its tree holds.', 'fadeno dispatch-stop [<name|id>] [--agent-id <id>] [--transcript <path>] [--message-file <path> | stdin] [--agent-cwd <dir>] [--durable] [--json]', [
    '`--agent-id` is tried first and is exact: it matches the id recorded when the dispatch was opened for that subagent. An id that names no dispatch falls through to the transcript rather than failing, because a stop hook fires for every subagent and most are nobody\'s dispatch.',
    'The stop hook\'s entry point. By default it writes a durable stop receipt before gathering the optional Git evidence, then appends that evidence when available. A second stop for the same dispatch is an idempotent replay that can finish a deferred inspection.',
    '`--durable` stops after the essential receipt is flushed. The harness stop hook uses this cheap path so a Git inspection cannot make a completed agent remain open; run the command again without `--durable` to enrich the row with dirty paths, ignored paths, and branch measurement.',
    '`--transcript` reads the agent\'s transcript: the contract header in its prompt names the dispatch (so the ref may be omitted), the last assistant turn supplies the final message when none was passed, and the model the agent ran on is recorded beside the one the dial asked for. A transcript with no contract is not a dispatch: exit 4, nothing recorded.',
    'For stop recovery, save an already-received final response to a file and pass `--message-file <path>`; stdin is also supported for a one-shot invocation. The shared stdin reader retries transient EAGAIN/EINTR without a deadline, but a saved message file avoids coupling recovery to a live pipe.',
  ]),
  'dispatch-wait': page('Block until a dispatch stops, then print its report.', 'fadeno dispatch-wait <name|id>... [--wait-seconds <n>] [--json]', [
    'For a dispatch that outruns the caller\'s shell timeout. Wait in bites the harness allows: this returns `still running` (exit 2) after its bound rather than being killed mid-wait, and the caller runs it again.',
    'Several names answer on the FIRST to stop, and the message names the ones still running so the next call can ask for those. A fan-out needs one call, not one poll per dispatch.',
    'The bound is on WAITING, never on the work: nothing here stops an executor or decides it is too slow.',
    'Exit 0 when one stopped and its report is on stdout; 2 while they all run; 5 when it stopped but recorded no report at all, which needs a look at its exit code and stderr rather than another wait. There is no exit for "lost": see below.',
    'A dead process group is given a few seconds to produce its stop row before this writes one. The row is written by a separate process — `fadeno cancel` takes up to five seconds to get there — and a dead group is not a settled one.',
    'If nobody is left to write it, this reconstructs the stop row from what the executor left on disk — its report, its stderr, and what git says its branch holds — and marks the row `reconstructed`, because how the executor ended died with its launcher and an invented exit code would claim otherwise. The launching CLI records the stop when its child exits, so a harness that kills that CLI at a shell ceiling leaves a finished dispatch with no stop row; reporting those as lost work cost one night 26 finished, committed dispatches.',
    'Only a `stopped` row is report-ready. A `closed` row by itself is not terminal for waiting: a live command-lane process remains running, while a dead one gets the settle window and then the same reconstruction path as an abandoned open dispatch.',
  ]),
  'dispatch-close': page('Record the terminal decision for a dispatch.', 'fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed|--reviewed [--note <text>] [--force]', [
    'Exactly one verb. The same verb twice is a replay; a different verb for an already-closed dispatch is refused. Closing removes nothing: the branch stays, and the worktree stays until `fadeno clean`.',
    '`--reviewed` records that the report was read without claiming that the work was merged, kept, discarded, or failed. It is report-only and is not inferred from git state.',
    '`--merged` is the only verb that claims something about the repository rather than about your intent, so it is the only one checked: it is refused while the branch carries commits HEAD does not have, or while its worktree holds uncommitted tracked changes.',
    'A squash, a rebase or a reimplementation lands the work without leaving the branch reachable. Close those with `--force`, and record how in `--note`.',
    'A process whose `FADENO_DISPATCH_ID` equals the target dispatch is refused: it must return its report, and its caller/host closes it. A parent process may close a child dispatch it opened.',
  ]),
  cancel: page('Stop a running command-lane dispatch by signalling its process group.', 'fadeno cancel <name|id>', [
    'Refuses a host-lane dispatch (the subagent is the harness\'s to stop) and a dispatch that is not running. After the group exits, writes the stop row if the launcher did not. The dispatch still needs closing.',
    'Signals directly first. If the Codex app sandbox returns EPERM, the live command-lane launcher consumes a per-dispatch request from `.fadeno/local` and signals its own group. Success requires that acknowledgement and group exit; an unconsumed request or live group is reported as a failure with the required unsandboxed/elevated rerun guidance.',
  ]),
  logs: page('Read a command-lane dispatch\'s internal activity stream.', 'fadeno logs <name|id> [--tail <lines>] [--follow]', [
    'Reads the recorded stderr stream at the path derived from the dispatch id. The path is never accepted from the caller, and the bytes are passed through unchanged.',
    'A host-lane dispatch has no Fadeno activity file because its harness owns that transcript. A missing command-lane file is reported clearly; `--follow` waits for it while the dispatch is open.',
    '`--follow` prints the current stream and then waits for appended bytes until a stopped row has arrived and the file is drained. It has no time limit; stop work with `fadeno cancel <name|id>` when appropriate.',
  ], [
    'fadeno logs build-index | less',
    'fadeno logs build-index --tail 100 --follow',
  ]),
  dispatches: page('List dispatches, show one, or print a report.', ['fadeno dispatches [--all] [--tail <count>] [--json]', 'fadeno dispatches <name|id> [--json]', 'fadeno dispatches --output <name|id>'], [
    'Unclosed dispatches by default; `--all` includes closed ones. A name resolves when it is unique, a unique id prefix too; ambiguity is refused rather than guessed.',
    '`--output` prints the command-lane transcript, or the final message the stop row recorded.',
  ]),
  worktrees: page('Report every Fadeno worktree holding work that is not on HEAD.', 'fadeno worktrees [--json]', [
    'The cross-session safety net: uncommitted paths, unmerged commits and ignored paths per worktree, joined to the dispatch that owns it. A tree that cannot be read is reported as such, never as clean.',
    'Ignored paths are listed because git does not count them and `fadeno clean` does remove them: a worker whose receipts went to a gitignored `out/` leaves a worktree that reports itself clean.',
  ]),
  context: page('Print what a host session is told: the archetypes, the rules, and every unclosed dispatch.', 'fadeno context [--json]', [
    'One source for the host-mode hook, a spawned director\'s prompt, and a human who wants to see it. JSON also carries a compact ledger-derived reminder for each host user turn.',
    'It carries no routing table: that is `fadeno dial`, read fresh, because this text is injected once and outlives the dials it would have quoted.',
    'It reports whether `.fadeno/preamble.md` exists — the repository conventions Fadeno appends to every dispatched prompt, so a brief never has to repeat them.',
  ]),
  feedback: page('Record friction with Fadeno itself, or read what has been recorded.', [
    'fadeno feedback',
    'fadeno feedback "<what happened>" [--dispatch <ref>] [--json]',
  ], [
    'Appends to `.fadeno/feedback.md` with the harness, the Fadeno version, and the dispatch when you name one — the context a reader needs and a host would otherwise have to remember.',
    'With no argument it prints the file, which is how whoever maintains Fadeno collects what the sessions using it hit.',
    'It is not scratch: `fadeno clean` never touches it.',
  ]),
  'prompt-stage': page('Stage plaintext for a Codex spawn that may hide its message from hooks.', [
    'fadeno prompt-stage [--name <semantic-name>] [--prompt-file <path> | stdin] [--json]',
    'fadeno prompt-stage --consume <task_name> --json',
    'fadeno prompt-stage --claim <task_name> --json',
    'fadeno prompt-stage --finalize|--rollback <task_name> --claim-id <id> --json',
  ], [
    'The first form stores the prompt only under `.fadeno/local/staged-prompts/` and returns the exact Codex-safe `task_name` to put on the next `fadeno-<archetype>` spawn. `--name` is a semantic dispatch label; Fadeno slugifies it to lowercase letters, digits, and underscores and appends an opaque lowercase token. Records expire after ten minutes; no dispatch, worktree, or ledger row is created.',
    'The consume form is for direct callers. It atomically claims one task name, checks its repository and expiry, and deletes it only after the caller receives the plaintext; a missing, malformed, expired, or replayed task name cannot attach a prompt.',
    'The hook uses claim, then finalize after its process-safe pending payload is complete, or rollback if that write fails. The claim handle is opaque and never contains plaintext.',
    'On Codex, stage the exact task before every archetype spawn and copy the returned `task_name` exactly. A readable spawn message still works without staging for older Codex versions.',
  ], [
    "printf '%s\\n' 'Review the login fix' | fadeno prompt-stage --json",
  ]),
  model: aliasPage(MODELS_PAGE, [
    'fadeno model [<name>]',
    'fadeno model --harness <id>',
    'fadeno model add <alias> <provider/id>',
    'fadeno model remove <alias> [--force]',
    'fadeno model verify [<ref>...] [--harness <id>] [--strict]',
    'fadeno model run <ref[@effort][ on <harness>]> [<prompt>...] [--prompt-file <path>]',
  ], '`fadeno model` is an alias for `fadeno models`.'),
  dial: page('Show, set and resolve archetype bindings.', [
    'fadeno dial',
    'fadeno dial <archetype> [<model>[@effort]]',
    'fadeno dial <a> <b>... <model>[@effort] [options]',
    'fadeno dial <a>+<b>[+...] <model>[@effort] [options]',
    'fadeno dial <a>,<b>[,...] <model>[@effort] [options]',
    'fadeno dial clear [<archetype>] [--session|--user|--repo]',
    'fadeno dial resolve --archetype <name>',
  ], [
    'With no arguments: every archetype and where it currently routes. What each archetype is for is in `fadeno context`.',
    'Cascade: binding → session dial → repo pin → user dial → base. An archetype with no dial runs on the host session\'s own model.',
    'An unscoped set edits the highest layer that already holds a dial, and creates at the user default when none does.',
  ]),
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
  'models run': MODEL_RUN_PAGE,
  'model run': aliasPage(
    MODEL_RUN_PAGE,
    'fadeno model run <ref[@effort][ on <harness>]> [<prompt>...] [--prompt-file <path>]',
    '`fadeno model run` is an alias for `fadeno models run`.',
  ),
  'dial clear': page('Clear one or more dial layers.', 'fadeno dial clear [<archetype>] [--session|--user|--repo]'),
  'dial resolve': page('Print what one archetype resolves to right now.', 'fadeno dial resolve --archetype <name>', [
    'The inspection escape hatch: model, effort, harness and lane, answered by the same resolver a spawn takes.',
  ]),
  'completion bash': page('Emit sourceable Bash completion.', 'fadeno completion bash', undefined, ['source <(fadeno completion bash)']),
};

const OPTION_HINTS: Record<string, string> = {
  '--agent-cwd': 'Where the agent actually worked',
  '--agents-only': 'Reconcile Codex archetype files only',
  '--all': 'Include closed dispatches',
  '--archetype': 'Archetype name',
  '--claude': 'Target Claude Code',
  '--codex': 'Target Codex',
  '--claim': 'Claim one staged Codex task_name without deleting it',
  '--claim-id': 'Opaque staged-task claim handle',
  '--consume': 'Consume one staged Codex task_name (internal hook operation)',
  '--dispatch': 'Dispatch this friction happened on',
  '--wait-seconds': 'How long to block before answering "still running"',
  '--discarded': 'Close: the work is not wanted',
  '--failed': 'Close: the dispatch did not succeed',
  '--force': 'Overwrite managed files',
  '--follow': 'Stream appended activity until the dispatch stops',
  '--from': 'Ref to cut the worktree from (dispatch), or runtime source directory (setup)',
  '--finalize': 'Finalize a staged task after its handoff succeeds',
  '--grok': 'Target Grok Build',
  '--harness': 'Executor harness',
  '--heartbeat': 'Seconds between still-running echoes',
  '--help': 'Show this command help',
  '--json': 'Emit structured JSON output',
  '--kept': 'Close: keep the branch for later',
  '--merged': 'Close: the work landed',
  '--reviewed': 'Close: report read; no disposition claimed',
  '--message-file': 'File holding the agent\u2019s final message',
  '--model': 'Direct model reference',
  '--name': 'Semantic dispatch name; also the branch (slugged for Codex task_name)',
  '--note': 'Free text recorded on the decision',
  '--omp': 'Target omp',
  '--opencode': 'Target OpenCode',
  '--output': 'Print the report of a dispatch',
  '--parent': 'Dispatch id this spawn belongs to',
  '--prompt-file': 'Read prompt from file',
  '--repo': 'Repository scope',
  '--rollback': 'Restore a staged task after its handoff fails',
  '--scope': 'Installation scope',
  '--session': 'Local session scope',
  '--session-id': 'Host session the spawn came from',
  '--lane': 'Which lane opens it: auto (the resolution decides), host, or command',
  '--prompt-sealed': 'Open for a prompt the harness never showed Fadeno, and say why',
  '--dry-run': 'Answer what would happen and open nothing',
  '--durable': 'Flush the essential stop receipt before optional Git inspection',
  '--agent-id': "The harness's own id for the subagent",
  '--transcript': 'The agent\'s transcript, read for the dispatch id, final message and model',
  '--parent-transcript': 'The spawning agent\'s transcript; its contract header names the parent dispatch',
  '--shared': 'Work in the live tree instead of a worktree',
  '--strict': 'Fail on an unreachable listing too',
  '--tail': 'Number of recent entries',
  '--user': 'User-default scope',
  '--verbose': 'Include diagnostic detail',
  '--version': 'Show Fadeno version',
};

const OPTION_FORMS: Record<string, string> = {
  '--format': '--format <format>', '--schema': '--schema <kind>',
  '--archetype': '--archetype <name>', '--model': '--model <ref>', '--harness': '--harness <id>', '--claim': '--claim <task_name>', '--claim-id': '--claim-id <id>', '--consume': '--consume <task_name>',
  '--dispatch': '--dispatch <ref>', '--wait-seconds': '--wait-seconds <n>', '--prompt-file': '--prompt-file <path>', '--output': '--output <path>', '--lane': '--lane <auto|host|command>', '--transcript': '--transcript <path>', '--parent-transcript': '--parent-transcript <path>', '--prompt-sealed': '--prompt-sealed <reason>', '--bind': '--bind <role=executor>',
  '--tool': '--tool <name>', '--input': '--input <name=path>',
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
  '--arm': '--arm <arm>', '--evidence': '--evidence <mode>', '--comparison': '--comparison <path>',
  '--adversarial': '--adversarial <path>', '--judge': '--judge <ref>', '--scope': '--scope <project|user>',
  '--from': '--from <bin-dir>', '--unbind': '--unbind <role>', '--note': '--note <text>',
  '--finalize': '--finalize <task_name>', '--rollback': '--rollback <task_name>',
};

const withGlobals = (...flags: string[]): readonly string[] => ['--help', '--version', ...flags];

/**
 * Help is a user-facing contract, not a dump of parser/completion acceptance.
 * Keep only options that the command actually uses, and let mode-specific
 * usage carry options whose meaning depends on the selected mode.
 */
const PAGE_OPTIONS: Record<string, readonly string[]> = {
  setup: withGlobals('--codex', '--claude', '--agents-only', '--from', '--force', '--json'),
  status: withGlobals('--verbose', '--codex', '--claude', '--opencode', '--omp', '--json'),
  models: withGlobals('--harness', '--json'),
  model: withGlobals('--harness', '--json'),
  dial: withGlobals('--harness', '--session', '--user', '--repo', '--json'),
  clean: withGlobals('--force'),
  dispatch: withGlobals('--archetype', '--model', '--name', '--prompt-file', '--shared', '--from', '--session-id', '--parent', '--heartbeat'),
  'dispatch-open': withGlobals('--archetype', '--model', '--name', '--lane', '--prompt-file', '--prompt-sealed', '--agent-id', '--dry-run', '--shared', '--from', '--session-id', '--parent', '--parent-transcript', '--harness', '--json'),
  'dispatch-stop': withGlobals('--agent-id', '--transcript', '--message-file', '--agent-cwd', '--durable', '--json'),
  'dispatch-wait': withGlobals('--wait-seconds', '--json'),
  'dispatch-close': withGlobals('--merged', '--kept', '--discarded', '--failed', '--reviewed', '--note', '--force'),
  cancel: withGlobals(),
  logs: withGlobals('--tail', '--follow'),
  dispatches: withGlobals('--all', '--tail', '--json', '--output'),
  worktrees: withGlobals('--json'),
  context: withGlobals('--json'),
  feedback: withGlobals('--dispatch', '--json'),
  'prompt-stage': withGlobals('--name', '--prompt-file', '--consume', '--claim', '--finalize', '--rollback', '--claim-id', '--json'),
  plugin: withGlobals('--codex', '--omp', '--force'),
  completion: withGlobals(),
  'models add': withGlobals('--json'),
  'model add': withGlobals('--json'),
  'models remove': withGlobals('--force', '--json'),
  'model remove': withGlobals('--force', '--json'),
  'models verify': withGlobals('--harness', '--strict', '--json'),
  'model verify': withGlobals('--harness', '--strict', '--json'),
  'models run': withGlobals('--harness', '--prompt-file'),
  'model run': withGlobals('--harness', '--prompt-file'),
  'dial clear': withGlobals('--session', '--user', '--repo', '--json'),
  'dial resolve': withGlobals('--archetype'),
  'completion bash': withGlobals(),
};

const PATH_OPTION_HINTS: Record<string, Record<string, string>> = {
  clean: { '--force': 'Remove what the preview listed' },
  setup: { '--force': 'Replace a `fadeno` Fadeno did not write', '--from': 'Directory holding the CLI to link' },
  plugin: { '--force': 'Overwrite generated plugin files' },
  'models remove': { '--force': 'Remove despite live dials, naming each stranded' },
  'model remove': { '--force': 'Remove despite live dials, naming each stranded' },
  'dispatch-close': { '--force': 'Close --merged despite what git found; say how in --note' },
  logs: { '--tail': 'Number of recent activity lines' },
};

const PATH_OPTION_FORMS: Record<string, Record<string, string>> = {
  dispatches: { '--output': '--output <name|id>', '--tail': '--tail <count>' },
  logs: { '--tail': '--tail <lines>' },
  dispatch: { '--name': '--name <name>', '--from': '--from <dispatch-name|id|ref|sha>', '--heartbeat': '--heartbeat <seconds>' },
  'dispatch-open': { '--name': '--name <name>', '--from': '--from <dispatch-name|id|ref|sha>', '--session-id': '--session-id <id>', '--parent': '--parent <id>' },
  'dispatch-stop': { '--message-file': '--message-file <path>', '--agent-cwd': '--agent-cwd <dir>' },
  'dispatch-close': { '--note': '--note <text>' },
  'dispatch-wait': { '--wait-seconds': '--wait-seconds <n>' },
  'prompt-stage': { '--name': '--name <semantic-name>' },
  'models run': { '--prompt-file': '--prompt-file <path>' },
  'model run': { '--prompt-file': '--prompt-file <path>' },
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
  return `fadeno — routes delegated work to models by archetype, and keeps the ledger

Usage: fadeno <command> [options]

Routing
  dial        Show, set and resolve archetype bindings
  models (model)  Inspect the model registry; \`model run\` runs one model in scratch
  context     What a host session is told
  feedback    Record friction with Fadeno itself

Dispatches
  dispatch, dispatch-wait, dispatch-close, cancel, dispatches, logs, worktrees
  dispatch-open, dispatch-stop  (the hooks' entry points)
  prompt-stage  (stage a Codex prompt before an archetype spawn)

Setup and maintenance
  setup, status, clean, plugin, completion

Global options
  -h, --help       Show this page or focused command help
  -v, --version    Show the Fadeno version

Run \`fadeno <command> --help\` for exact usage and command options.

Examples:
  fadeno dial
  fadeno dial worker sol@high
  fadeno model run sol "Reply exactly: Hello, World!"
  fadeno dispatch --archetype worker --name csv-export < task.md
  fadeno dispatch-close csv-export --merged`;
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

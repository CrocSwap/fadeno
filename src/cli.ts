#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { runAttest } from './commands/attest.ts';
import { runDecide } from './commands/decide.ts';
import {
  runDispatch,
  runDispatchComplete,
  runDispatchFail,
  runDispatchFallback,
  runDispatchProgress,
  runDispatchStart,
} from './commands/dispatch.ts';
import {
  runDispatches,
  runDispatchesCancel,
  runDispatchesBakeoffs,
  runDispatchesOutput,
  type DispatchesResult,
} from './commands/dispatches.ts';
import { runDiagram } from './commands/diagram.ts';
import { DRIVE_PARALLEL_DEFAULT, DRIVE_PARALLEL_MAX, DRIVE_PARALLEL_MIN, runDrive, type DriveResult } from './commands/drive.ts';
import { runGate } from './commands/gate.ts';
import { runInit, type Target } from './commands/init.ts';
import {
  offHostLanes,
  formatShadowLine,
  runDialClear,
  runDialSetMany,
  runDialClearShadow,
  runDialResolve,
  runDialShadow,
  runDialShow,
  runShadowShow,
  sessionEffort,
  type DialShowResult,
} from './commands/dial.ts';
import { runModels, runModelsDriver, type DriverListingResult, type ModelsResult } from './commands/models.ts';
import { runNewRun } from './commands/new-run.ts';
import { runCodexPlugin, runPlugin } from './commands/plugin.ts';
import { runNext } from './commands/next.ts';
import { runPrompt } from './commands/prompt.ts';
import { runRun } from './commands/run.ts';
import { runRuns } from './commands/runs.ts';
import { runShow } from './commands/show.ts';
import { runValidate } from './commands/validate.ts';
import { runVerify, type VerifyResult } from './commands/verify.ts';
import { knownFlagsFor, runCompletion, runCompletionCandidates, suggestFlag, unknownFlagsFor } from './commands/completion.ts';
import { runShadowApply } from './commands/shadow-apply.ts';
import {
  runBakeoff,
  runBakeoffPrepare,
  runBakeoffRecord,
  type BakeoffArmMeasurement,
  type BakeoffPrepareResult,
  type BakeoffResult,
} from './commands/bakeoff.ts';
import { EVIDENCE_MODES, isEvidenceMode, type EvidenceMode } from './lib/bakeoff.ts';
import { runSteeringApply, runSteeringApplyClaude, runSteeringResolve } from './commands/steering.ts';
import { runDispatchPrompt } from './commands/dispatch-prompt.ts';
import { runDispatchPrepare } from './commands/dispatch-prepare.ts';
import { runToolComplete } from './commands/tool-complete.ts';
import { runToolRun } from './commands/tool-run.ts';
import { runSetup } from './commands/setup.ts';
import { runStatus } from './commands/status.ts';
import { runDoctor } from './commands/doctor.ts';
import { runVendor } from './commands/vendor.ts';
import { runEvidencePromote } from './commands/evidence.ts';
import { runUninstall } from './commands/uninstall.ts';
import { runClean } from './commands/clean.ts';
import { runUnvendor } from './commands/unvendor.ts';
import { runCancel, CancelError } from './commands/cancel.ts';
import type { DiagramFormat } from './lib/diagram.ts';
import { progressSidecarPath } from './lib/prompt.ts';
import type { EmitResult } from './lib/fsutil.ts';
import { SCHEMA_KINDS as SCHEMA_KIND_LIST } from './lib/playbook-validate.ts';
import type { SchemaKind, ValidationIssue } from './lib/playbook-validate.ts';
import { findRepoRoot, packageVersion } from './lib/paths.ts';
import type { RunEvent, RunSummary } from './lib/run-ledger.ts';
import type { DispatchProgressSource } from './lib/host-dispatch.ts';
import type { ValidateOutcome } from './commands/validate.ts';
import type { ShowProjection, ShowResult, StepView } from './commands/show.ts';
import { readInstallationManifest, syncManagedRuntime } from './lib/installations.ts';
import { userPaths } from './lib/user-paths.ts';

const HELP = `fadeno — the playbook layer for AI coding agents

Usage:
  fadeno init --codex|--claude|--grok [opts]   Explicitly scaffold project-owned capability
  fadeno setup [--codex|--claude] [--from <bin-dir>] [--reset-runtime]  Install safe user-scoped integration
  fadeno status [--verbose]                   Show effective definitions, routing, and state
  fadeno doctor [--codex|--claude]            Run read-only diagnostics
  fadeno vendor --codex|--claude|--grok       Vendor capability and definitions into a project
  fadeno evidence promote <run>               Promote a verified run receipt
  fadeno uninstall --codex|--claude|--all     Remove managed user integration
  fadeno clean [--force]                      Preview/remove ignored repo runtime state
  fadeno unvendor [--force]                   Remove lock-owned vendored files
  fadeno validate [file] [--schema K]   Validate playbooks (schema + references + semantics)
  fadeno diagram <playbook> [--format]  Render a playbook's flow (ascii | mermaid)
  fadeno new-run <playbook> <task>      Create a new run-ledger directory
  fadeno dial                                  # effective table
  fadeno dial <archetype>                      # one archetype's row (+shadow)
  fadeno dial <archetype>[+<archetype>…] <model>[@effort] [--via <driver>] [--session|--user|--repo]   # set (multi: a+b, a,b, or a b c)
  fadeno dial clear [<archetype>] [--session|--user|--repo]
  fadeno dial shadow <archetype> <model>[@effort] [--via <driver>] [--rate <r>]
  fadeno dial shadow                           # show mode: archetypes with an active shadow
  fadeno shadow ...                            # alias for 'fadeno dial shadow ...' (same forms)
  fadeno dial clear-shadow [<archetype>]
  fadeno dial resolve --archetype <a>          # JSON, hook contract unchanged
  fadeno models [<name>]                Model registry + each model's home driver
  fadeno models --driver <alias>        Live backend model listing (routes with models_command)
  fadeno steering resolve|apply [...]   Resolve or materialize hybrid Codex steering
  fadeno dispatch [flags]               Resolve archetype → executor and invoke it once (ad hoc)
                                        (--shadow <ref> duplicates it to a one-shot challenger)
  fadeno dispatch-prepare <run> <id> --isolate  Prepare an isolated worktree for a pending host dispatch (opt-in)
  fadeno dispatch-fallback <run> <id>   Deliver a locked host request by declared fallback
  fadeno dispatch-prompt <run> <id>     Emit the canonical engine envelope for a host dispatch
  fadeno dispatch-start <run> <id>      Start a host dispatch
  fadeno dispatch-progress <run> <id>   Record an attested progress observation
  fadeno dispatch-complete <run> <id>   Submit a host result (use --output - to read stdin)
  fadeno dispatch-fail <run> <id>       Submit a host failure
  fadeno run <run> [flags]              Update a run ledger (run.yaml + events.jsonl)
  fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]  Execute a registered tool step deterministically
  fadeno tool-complete <run> --output P Atomically record the next tool_call result
  fadeno gate <run> <condition>         Evaluate a gate condition from a structured artifact
  fadeno prompt <run> <step> [flags]    Assemble (and record) a step's actor prompt
  fadeno next <run>                     Emit the next actionable step (JSON flow cursor)
  fadeno drive <run> [flags]            Engine: advance the run until terminal or paused
  fadeno cancel <run>                   Cancel the active engine attempt for a run (SIGTERM to its executor group)
  fadeno decide <run> <option> [flags]  Resolve a pending named human decision
  fadeno runs                           List run ledgers under .fadeno/runs/
  fadeno attest --archetype <a>         Record this subagent's own measured delivery (run FROM inside it)
  fadeno dispatches [--tail n] [--json] Show which executor ran what (.fadeno/dispatches.jsonl)
  fadeno dispatches --cancel <id|tag:h> Stop a running dispatch (SIGTERM to its executor group)
  fadeno dispatches --output <id|last> [--wait <s>]  Print a dispatch's output snapshot verbatim
  fadeno dispatches --bakeoffs          Adjudicated bakeoff scorecard per challenger
  fadeno shadow-apply <pair-id|dispatch-id> [--arm challenger|primary] [--check]
                                        Port a shadow pair's diff into your workspace (git apply --3way)
  fadeno bakeoff <pair-id|dispatch-id> [--judge <ref>] [--via <driver>] [--evidence inlined|explored]
                                        Measure + adjudicate a shadow pair: two blinded judge dispatches, then
                                        write .fadeno/bakeoffs/<pair-id-8>.md
  fadeno bakeoff <pair-id|dispatch-id> --measure-only
                                        Measure a shadow pair's arms only (deterministic; no model is consulted)
  fadeno bakeoff <pair-id|dispatch-id> --prepare [--evidence inlined|explored]
                                        Measure + write the two blinded judge prompts under .fadeno/local/prompts/;
                                        writes no artifact — for a host coordinator to spawn judge subagents on
  fadeno bakeoff <pair-id|dispatch-id> --record --comparison <file> --adversarial <file>
                                        Validate two host-delivered judgments and write the artifact
                                        (judge_delivery: host — see the fadeno-judge skill)
  fadeno show <run>                     Show a run's step projection and artifacts (--events for raw timeline)
  fadeno verify <run> [--allow-failed]  Re-audit a run's deterministic claims (or --latest)
  fadeno plugin [dir] [--codex]         Generate a Claude Code (default) or Codex plugin
  fadeno completion bash                Emit a sourceable Bash completion script

Options:
  --with-hooks            (init) Also scaffold tier-2 enforcement hooks
  --with-steering         (init) Deprecated compatibility alias; steering is now default
  --no-steering           (init) Opt out of default Codex/Claude steering
  --non-interactive       (setup) Accepted compatibility no-op; setup never prompts
  --from <bin-dir>        (setup) Use bin dir as runtime source (instead of bundled)
  --reset-runtime         (setup) Allow downgrade to mirror this plugin
  --all                   (uninstall) Remove every registered harness integration
  --purge-user-data       (uninstall) Also remove shared config/state/data; requires --force
  --scope <scope>         (steering apply) project (default) | user
  --data-only             (init) Seed definitions + driver policy (host capability via plugin)
  --force                 (init) Overwrite existing files / refresh the bootstrap section
  --schema <kind>         (validate) Force document kind: playbook | run | review-report | test-result
  --format <fmt>          (diagram) ascii (default) | mermaid
  --step <id>             (run) Set current_step and log a step_started event
  --status <status>       (run) Set status: running | completed | failed | aborted
  --event <type>          (run) Append a custom event
  --artifact <path>       (run) Attach an artifact path to the event
  --member <role>         (run) Attribute the event to a map member / actor
  --field <k=v>           (run) Extra field on the event (repeatable; e.g. branch=approve)
  --artifact <path>       (gate) Artifact path relative to run (condition-specific default)
  --report <path>         (gate) Deprecated alias for --artifact
  --actor <role>          (prompt) Map member / actor to assemble the prompt for
  --iteration <n>         (prompt) Loop-body iteration to target (default: latest)
  --inline                (prompt) Embed input file contents in the prompt
  --no-record             (prompt) Preview only: write no snapshot or event
  --bind <role=executor>  (drive) Session executor override for a role (repeatable; recorded)
  --max-transitions <n>   (drive) Engine transition cap per invocation (default 50)
  --parallel <n>          (drive) Max concurrent deliveries per wave (1–16, default 1). Command members
                          currently SERIALIZE regardless — see fadeno drive --help
  --timeout <seconds>     (drive/dispatch) Hard deadline seconds; 0 disables route default (20 min)
  --input <Name=path>     (new-run) Supply a declared input (repeatable)
  --via <driver>          (dial/dispatch) Driver alias that delivers the model; on dispatch it
                          escalates one call onto that lane without moving the dial
  --session               (dial) Write/clear this checkout's session dial
  --user                  (dial) Write/clear the user default
  --repo                  (dial) Write/clear the repo pin (committed)
  --archetype <a>         (dispatch) Archetype to resolve (required unless --model)
  --role <name>           (dispatch) Role name: enables binding pins + evidence attribution
  --model <ref>           (dispatch) Bypass resolution and invoke a dial ref directly (debugging)
  --host-executor <n>     (steering resolve) Host executor materialized into this role
  --run <id>              (steering resolve) Immutable engine run identity for a delivered host request
  --dispatch-id <id>      (steering resolve) Immutable host dispatch identity paired with --run
  --prompt-file <path>    (dispatch) Read the prompt from a file instead of stdin
  --tag <t>               (dispatch) Label the dispatch for recovery (dispatches --output tag:<t>)
  --shadow <ref>          (dispatch) Duplicate the prompt to a one-shot shadow challenger
                          (FADENO_SHADOW_MAX_LIVE caps concurrent challengers; default 4)
  --isolate               (dispatch) Keep the work OUT of your tree: detached worktree, no merge-back
  --shared                (dispatch) Opt OUT of isolation and run in this tree (nothing contains the executor)
  --ignored-output <kept|discardable>  (dispatch) Whether this task's gitignored output must survive; kept forgoes the pair AND the worktree
  --diagnostics           (dispatch/drive) Persist bounded process output (32 KiB / 500 lines) to diagnostics log
  --no-brief              (dispatch) Skip the archetype's declared brief preamble
  --tail <n>              (dispatches) Logical entries to show, newest last (default 10)
  --json                  (dispatches) Emit structured entries on stdout for scripting
  --arm <arm>             (shadow-apply) challenger (default) | primary
  --check                 (shadow-apply) Report applicability only (git apply --check --3way); changes nothing
  --measure-only          (bakeoff) Report the pair's measured facts and write nothing; skips adjudication
  --evidence <mode>       (bakeoff) inlined (default) embeds each arm's diff in the prompt; explored
                          reconstructs both arms' trees under .fadeno/local/judge/<pair-8>/ and passes
                          paths, so the judge reads whole files instead of hunks. Pass the same value to
                          --record that you passed to --prepare; the artifact stamps evidence_mode
  --prepare               (bakeoff) Measure + write the two blinded judge prompts; write no artifact
  --record                (bakeoff) Validate --comparison/--adversarial judgment files and write the artifact
  --comparison <path>     (bakeoff --record) The comparison judge subagent's raw JSON output
  --adversarial <path>    (bakeoff --record) The adversarial judge subagent's raw JSON output
  --judge <ref>           (bakeoff) Override the judge archetype's dial model (bypasses catalog resolution)
  --isolate               (dispatch-prepare) Create isolated worktree at .fadeno/local/host-worktrees/<run>/<id> (workspace_mode: isolated)
  --agent-id <id>         (dispatch-start) Host agent identity
  --workspace <path>      (dispatch-start) Host workspace provenance
  --branch <name>         (dispatch-start) Host branch provenance
  --file <path>           (dispatch-progress) Agent/harness status JSON file
  --source <kind>         (dispatch-progress) agent | harness | director
  --output <path>         (dispatch-complete) Temporary output file
  --output <id|last>      (dispatches) Recover a dispatch's output snapshot (killed relays included)
  --wait [seconds]        (dispatches --output) Wait for the completion row before answering (default 120)
  --commit <sha>          (dispatch-complete) Optional commit provenance
  --reason <text>         (dispatch-fail) Host-attested failure reason
  --decision <id>         (decide) Target decision id (optional when exactly one is pending)
  --feedback <text>       (decide) Free-text feedback recorded on the resolution
  --latest                (verify) Audit the newest run instead of a named one
  --allow-failed          (verify) Accept an honest failed/aborted terminal
  --legacy                (show/verify/next) Read a 0.2 or unversioned pre-0.3 ledger in explicit compatibility mode
  --events                (show) Print the raw event timeline instead of the step projection
  -h, --help              Show this help (fadeno <command> --help for focused command help)
  -v, --version           Show version

Environment:
  FADENO_HARNESS          Select the harness for route compilation (codex|claude|standalone)
Examples:
  fadeno validate
  fadeno new-run code-change-review "Add CSV export for reports"
  fadeno setup --codex
  fadeno status
  fadeno doctor --codex
  fadeno init --codex --with-hooks
  fadeno init --grok
  fadeno validate .fadeno/runs/2026-05-30-1132-csv/run.yaml --schema run
  fadeno run 2026-05-30-1132-csv --step review
  fadeno run 2026-05-30-1132-csv --status completed
  fadeno run 2026-05-30-1132-csv --event artifact_created --artifact artifacts/x.json --member architect_fable
  fadeno run 2026-05-30-1132-csv --step arbitrate --event human_decision --field branch=approve
  fadeno dial worker sol --user
  fadeno dial worker sol@high --via opencode
  fadeno dial clear worker --session
  fadeno steering apply --codex --force
  echo "Summarize the repo layout." | fadeno dispatch --archetype worker
  fadeno gate 2026-05-30-1132-csv no_blocking_issues --artifact artifacts/review-report.json
  fadeno prompt 2026-05-30-1132-csv cross_review --actor architect_fable --no-record
  fadeno next 2026-05-30-1132-csv
  fadeno runs
  fadeno attest --archetype worker
  fadeno dispatches --tail 20
  fadeno shadow-apply pair-abcd1234 --check
  fadeno shadow-apply pair-abcd1234
  fadeno show 2026-07-10-2212
  fadeno verify --latest
  source <(fadeno completion bash)
`;

export const KNOWN_CLI_COMMANDS = new Set([
  'setup', 'status', 'doctor', 'vendor', 'unvendor', 'clean', 'uninstall',
  'evidence', 'init', 'steering', 'validate', 'diagram', 'new-run', 'run',
  'tool-run', 'tool-complete', 'plugin', 'completion', 'gate', 'prompt', 'next', 'drive',
  'cancel', 'models', 'dial', 'shadow', 'dispatch', 'dispatch-fallback', 'dispatch-start',
  'dispatch-prompt', 'dispatch-complete', 'dispatch-progress', 'dispatch-prepare',
  'dispatch-fail', 'decide', 'runs', 'attest', 'dispatches', 'shadow-apply', 'bakeoff', 'show', 'verify',
]);

export function shouldRunPreflight(command: string | undefined): boolean {
  if (!command) return false;
  const excluded = new Set(['status', 'doctor', 'setup', 'uninstall']);
  if (excluded.has(command)) return false;
  if (!KNOWN_CLI_COMMANDS.has(command)) return false;
  return true;
}

export function resolveRuntimeSyncCandidate(
  env: NodeJS.ProcessEnv,
  argv1: string | undefined,
  paths: ReturnType<typeof userPaths>,
  manifest: ReturnType<typeof readInstallationManifest>,
): { sourceDir: string; trustSource: boolean } | null {
  if (env.FADENO_BUNDLED_RUNTIME && existsSync(join(env.FADENO_BUNDLED_RUNTIME, 'fadeno'))) {
    return { sourceDir: env.FADENO_BUNDLED_RUNTIME, trustSource: true };
  }
  if (argv1) {
    try {
      const dir = dirname(resolve(argv1));
      const parent = dirname(dir);
      const candidates = [join(parent, '.claude-plugin', 'plugin.json'), join(parent, '.codex-plugin', 'plugin.json')];
      let isFadeno = false;
      for (const cand of candidates) {
        try {
          if (existsSync(cand)) {
            const p = JSON.parse(readFileSync(cand, 'utf8')) as { name?: unknown };
            if (p.name === 'fadeno') { isFadeno = true; break; }
          }
        } catch {}
      }
      if (isFadeno && existsSync(join(dir, 'fadeno'))) {
        return { sourceDir: dir, trustSource: true };
      }
    } catch {}
  }
  if (argv1) {
    try {
      const resolvedArgv = resolve(argv1);
      const managedDir = resolve(paths.managedRuntimeDir);
      const isManaged = resolvedArgv === resolve(paths.managedCli) || dirname(resolvedArgv) === managedDir || resolvedArgv.startsWith(managedDir + sep);
      if (isManaged) {
        const src = manifest.runtime?.source;
        if (src && existsSync(src) && existsSync(join(src, 'fadeno'))) {
          return { sourceDir: src, trustSource: false };
        }
        return null;
      }
    } catch {}
  }
  return null;
}

export function maybeRunRuntimePreflight(
  _argv: string[],
  command: string | undefined,
  deps: {
    env?: NodeJS.ProcessEnv;
    argv1?: string;
    paths?: ReturnType<typeof userPaths>;
    manifest?: ReturnType<typeof readInstallationManifest>;
    syncFn?: typeof syncManagedRuntime;
  } = {},
): void {
  if (!shouldRunPreflight(command)) return;
  try {
    const env = deps.env ?? process.env;
    const argv1 = deps.argv1 ?? process.argv[1];
    const paths = deps.paths ?? userPaths();
    const manifest = deps.manifest ?? readInstallationManifest();
    const candidate = resolveRuntimeSyncCandidate(env, argv1, paths, manifest);
    if (!candidate) return;
    if (manifest.runtime == null) return;
    const sync = deps.syncFn ?? syncManagedRuntime;
    const res = sync(paths, candidate.sourceDir, manifest, {
      allowInstall: false,
      trustSource: candidate.trustSource,
      force: false,
    });
    if (res.outcome === 'refreshed') {
      console.error(`fadeno: managed runtime ${res.from} -> ${res.to} refreshed at ${paths.managedRuntimeDir}`);
    }
  } catch (err) {
    try {
      console.error(`fadeno: managed runtime sync warning: ${(err as Error).message}`);
    } catch {}
  }
}

// Focused help for the major subcommands: `fadeno <command> --help`.
// Unknown commands (and the internal dispatch-* host protocol) fall back to
// the global HELP above.
const COMMAND_HELP: Record<string, string> = {
  dial: `fadeno dial — per-archetype model selection

Usage:
  fadeno dial                                  Effective table (model, effort, via, source)
  fadeno dial <archetype>                      One archetype's row (+ shadow; --json adds layers)
  fadeno dial <archetype>… <model>[@effort]    Set a dial (several archetypes at
                                               once: space, \`+\`, or \`,\` separated)
  fadeno dial clear [<archetype>]              Clear a dial at the layer it lives;
                                               no archetype = all session + user dials
  fadeno dial shadow <archetype> <model>[@effort] [--rate <r>]
                                               Attach a shadow challenger (scored, never gates)
  fadeno dial shadow                          Show mode: only archetypes with an active shadow
  fadeno dial clear-shadow [<archetype>]       Remove shadow attachment(s)
  fadeno dial resolve --archetype <a>          Resolution JSON (hook/script contract)

'fadeno shadow ...' is a top-level alias for 'fadeno dial shadow ...' — same
attach and show-mode forms, same flags (including --json).

Options:
  --via <driver>   Driver alias that delivers the model (e.g. opencode, codex)
  --session        Write/clear the local session dial (this checkout only)
  --user           Write/clear the user default (applies across your repos)
  --repo           Write/clear the repo pin (committed to .fadeno/executors.yaml)
  --rate <r>       (shadow) Sampling rate in [0,1]
  --prompt-sha256 <hex>
                   (resolve) Prompt digest, so the reply carries the pair decision
                   (shadow.selected) for this exact prompt. Omit it and selected
                   is null — unknown, never "no".
  --json           Structured output

The cascade: role binding → session dial → repo pin → user dial → host-native base.
A plain set updates the highest existing dial (session → repo → user), or creates
a user default when none exists. --session, --user, or --repo makes scope explicit.
Unregistered models fall through to the catalog's unregistered_model_driver.
A route is an argv: what you dial is what runs. Fadeno does not enforce write
permissions — that belongs to the vendor flags in the command and to isolated
worktrees, which are the default for command dispatches. To run something
restricted, dial a route whose argv restricts it. Eligibility and constraint
policies still refuse.

Examples:
  fadeno dial worker sol
  fadeno dial judge fable@high --session
  fadeno dial judge fable@high
  fadeno dial worker qwen-3.5-coder --via opencode
  fadeno dial generator gemini --via agy
  fadeno dial clear worker --user
`,
  models: `fadeno models — the model registry and the driver each model rides

Usage:
  fadeno models                    Frame-neutral registry table
  fadeno models <name>             One model: via, alternates, spellings, eligibility
  fadeno models --driver <alias>   Live backend listing via the route's models_command
                                   (registered spellings marked with ←)

Options:
  --json   Structured output

The table is frame-neutral: \`via\` is the model's home driver — the CLI its
provider route names, and the value \`--via\` takes to pick a different one —
and effort is the registry standard. Whether that driver is reached in-session
through a host agent or spawned as a command is selected later from the
caller's route and is not part of the model's identity, which is why the
column says \`via\` and not \`harness\`: the harness is the agent asking. Names
not in the registry route via the catalog's unregistered_model_driver with the
id passed verbatim. The single-model view lists every alternate lane. Probe-cache
verification state stays in --json (verified_at per row).

Examples:
  fadeno models
  fadeno models opus
  fadeno models --driver opencode
`,
  dispatch: `fadeno dispatch — resolve an archetype to its executor and invoke it once

Usage:
  echo "<prompt>" | fadeno dispatch --archetype <a> [flags]
  fadeno dispatch --archetype <a> --prompt-file <path> [flags]

Options:
  --archetype <a>       Archetype to resolve (required unless --model)
  --role <name>         Role name: enables binding pins + evidence attribution
  --model <ref>         Bypass resolution and invoke a dial ref directly (debugging)
  --via <driver>        Driver alias for --model (e.g. opencode)
  --prompt-file <path>  Read the prompt from a file instead of stdin
  --tag <t>             Label the dispatch for recovery (dispatches --output tag:<t>)
  --shadow <ref>        Duplicate the prompt to a one-shot shadow challenger. Sampling is
                        keyed on the prompt digest, so a retry never re-rolls; challengers
                        run concurrently, capped by FADENO_SHADOW_MAX_LIVE (default 4), and
                        their worktrees are retained under .fadeno/local/shadow for review
  --timeout <seconds>   Hard executor deadline seconds; 0 disables route default (20 min)
  --isolate             HOLD THE WORK OUT of your tree. A detached worktree, like the default, but
                        the diff is never applied back — it is left at the recorded diff_snapshot for
                        you to inspect or apply yourself. This is the flag's entire purpose now that
                        a worktree is the default: the default isolates for containment and merges
                        back, --isolate isolates to withhold. Refuses outside a git repository rather
                        than running in your tree, which is what it exists to prevent.
  --shared              Opt OUT of isolation and run in THIS tree. Nothing stands between the executor
                        and your files — Fadeno enforces no write permissions of its own
  --ignored-output <kept|discardable>
                        Whether this task's gitignored output must survive. A worktree is merged back
                        through git add -A, which respects .gitignore, so "kept" forgoes BOTH the
                        shadow pair and the worktree itself: the dispatch runs in your tree, where
                        nothing discards its gitignored output. Overrides the archetype's
                        ignored_output policy. Default: discardable.
  --diagnostics         Persist bounded process output (32 KiB / 500 lines per stream) to diagnostics log
  --no-brief            Skip the archetype's declared brief preamble

An archetype declaring \`brief: <name>\` (the starter's director does) gets that
template composed ahead of the task — .fadeno/briefs/<name>.md, else the
builtin — and the evidence row records \`brief\`. The digest attests the
composed bytes. Evidence lands in .fadeno/dispatches.jsonl. Exit 0 with no
output is reported as a failure — an empty relay is not a result.

Examples:
  echo "Summarize the repo layout." | fadeno dispatch --archetype worker
  fadeno dispatch --archetype worker --tag fix-flaky --prompt-file /tmp/task.md
`,
  'dispatch-prepare': `fadeno dispatch-prepare — prepare an isolated worktree for a host dispatch

Usage:
  fadeno dispatch-prepare <run> <dispatch-id> --isolate

Options:
  --isolate   Create detached worktree at .fadeno/local/host-worktrees/<run>/<dispatch-id> (workspace_mode: isolated)

Creates an idempotent detached worktree from HEAD at .fadeno/local/host-worktrees/<run>/<dispatch-id> and records
preparation state at .fadeno/local/host-workspaces/<run>/<dispatch-id>.json (workspace, base_commit, prepared_at).
Applies only to a pending nonterminal host request that has not started; concurrent preparation is serialized by
.fadeno/local/.host-workspace.lock. After preparation, dispatch-prompt includes workspace_mode: isolated and the
absolute workspace path; dispatch-start then bypasses the shared writer lease and stamps workspace_mode: isolated.
Both dispatch-complete and dispatch-fail collect a binary staged diff to .fadeno/local/outputs/host-isolated-<run>-<dispatch-id>.diff
and remove the worktree only after the terminal receipt is durable. Nothing merges automatically.
`,
  attest: `fadeno attest — record this subagent's own measured host delivery

Usage:
  fadeno attest --archetype <a>

Run this FROM INSIDE the subagent it describes — a \`host_delivery\` row is
written by the Claude steering hook in the PARENT, before the subagent ever
runs, so everything on it is a request. This records what the subagent can
actually MEASURE about itself: the resolved \`CLAUDE_EFFORT\` (already past any
silent per-model/per-org downgrade), pid, cwd, and the archetype it was told
it is. Model is never recorded here — there is no equivalent environment
variable, and this command never asks the model to self-report its own name —
so the row carries \`identity_evidence: requested_only\`, the same admission
\`fadeno steering resolve\` already makes.

Writes a \`host_attestation\` row to .fadeno/dispatches.jsonl, correlated by a
later reader (\`fadeno dispatches\`) onto the nearest preceding unattested
\`host_delivery\` row of the same archetype — best-effort, since the subagent
has neither the parent's prompt digest nor its session id to key on exactly.
Advisory only (tier-1): nothing forces a subagent to call this, which is
exactly why \`fadeno dispatches\` marks a host delivery with no matching
attestation as \`[never attested]\`, and one whose attested effort differs
from what was requested as an \`[effort mismatch]\` — the signature of a
silent downgrade.

Examples:
  fadeno attest --archetype worker
`,
  dispatches: `fadeno dispatches — the executor evidence ledger (.fadeno/dispatches.jsonl)

Usage:
  fadeno dispatches [--tail <n>] [--json]      Who ran what, newest last
  fadeno dispatches --output <id|last|tag:<t>> [--wait [s]]
                                               Print a dispatch's output snapshot verbatim
  fadeno dispatches --cancel <id|tag:<t>>      Stop a running dispatch (SIGTERM to its group)
  fadeno dispatches --bakeoffs                 Adjudicated bakeoff scorecard per challenger

Options:
  --tail <n>       Logical entries to show (default 10)
  --json           Structured entries on stdout for scripting
  --wait [s]       (--output) Wait for the completion row (default 120s)

Rows carry dial provenance: [session dial], [repo pin], [user dial]. Old-format
ledger generations still render, marked [legacy] / [format 0.x].
`,
  'shadow-apply': `fadeno shadow-apply — port a shadow pair's diff into your workspace

Usage:
  fadeno shadow-apply <pair-id|dispatch-id> [--arm challenger|primary] [--check]

Options:
  --arm <arm>   Which pair arm's diff to apply: challenger (default) | primary
  --check       Report applicability only (git apply --check --3way); changes nothing

<pair-id|dispatch-id> is a pair's pair_id, or either arm's own dispatch_id —
full, or an 8+ character prefix. Applies the arm's diff_snapshot with
\`git apply --3way\` against the arm's recorded baseline_commit, so the port-back
survives the main tree moving on while the pair ran. Conflict-aware from the
first version: on any conflict it stops, keeps the diff artifact exactly where
it was, records the attempt in .fadeno/dispatches.jsonl, and exits non-zero —
it never auto-resolves. --arm primary refuses twice over: on a primary that
ran in the shared tree (nothing to apply — its work is already there), and on
one whose recorded primary_merge is \`clean\` (already applied; a second apply
would either do nothing or corrupt a tree that has moved). It is meant for a
primary whose merge-back came back \`conflicted\` or \`blocked\`. A baseline
commit that is no longer in the object database (for example, garbage
collected after \`fadeno clean --force\` removed its retained shadow worktree)
is diagnosed precisely rather than surfacing raw git output.

Examples:
  fadeno shadow-apply pair-abcd1234 --check
  fadeno shadow-apply pair-abcd1234
  fadeno shadow-apply pair-abcd1234 --arm primary
`,
  drive: `fadeno drive — advance a run until terminal or paused

Usage:
  fadeno drive <run> [flags]

Options:
  --bind <role=executor>   Session executor override for a role (repeatable; recorded)
  --max-transitions <n>    Engine transition cap per invocation (default 50)
  --parallel <n>           Max concurrent deliveries per wave (1–16, default 1).
                           NOTE: command members currently serialize whatever you pass. They
                           overlapped only while a route could declare write_access: false and
                           skip the repo-wide writer lease; the permissions cut removed that
                           declaration, so every shared delivery now waits its turn. Host
                           requests still interleave. Restoring real concurrency means isolating
                           engine attempts with merge-back — concurrency as a fact rather than an
                           unverified promise. See docs/experimental/permissions-and-isolation.md
  --timeout <seconds>      Hard executor deadline seconds; 0 disables route default (20 min)
  --diagnostics            Persist bounded process output (32 KiB / 500 lines per stream) to diagnostics log

Drive executes command-delivered steps itself and pauses for host dispatches and
human gates. Resolve pauses with \`fadeno decide\` (decisions) or the dispatch-*
host protocol, then re-run drive. Executor identity is snapshotted on first
contact; resumed runs keep resolving against their recorded snapshot. Command routes
default to a 20-minute deadline (timeout_ms: 1200000); --timeout 0 disables it.
`,
  cancel: `fadeno cancel — cancel the active engine attempt for a run

Usage:
  fadeno cancel <run> [--actor-call <id>]

Sends SIGTERM to the single live engine command claim for <run>
(engine-<run>-<actorCallId>-a<attempt>.json). With --actor-call, targets that
single claim; without it, targets the single live claim and refuses when
multiple claims are live rather than guessing. The target is the single live
engine command claim by default. The target is the supervisor
PID when alive, otherwise the negative executor process-group ID when the
supervisor is proven dead (ESRCH), otherwise the executor PID. Never writes
the run ledger; the active engine remains the sole ledger writer and records
the terminal actor receipt. The workspace lease and inflight claim are
preserved until child-group termination is proven (supervisor close), never
at signal-send time. Check the workspace before re-dispatching; a cancelled
executor may have written already.
`,
  decide: `fadeno decide — resolve a pending named human decision

Usage:
  fadeno decide <run> <option> [flags]

Options:
  --decision <id>    Target decision id (optional when exactly one is pending)
  --feedback <text>  Free-text feedback recorded on the resolution

Then re-run \`fadeno drive <run>\` to continue.
`,
  verify: `fadeno verify — re-audit a run's deterministic claims

Usage:
  fadeno verify <run> [flags]
  fadeno verify --latest [flags]

Options:
  --latest         Audit the newest run instead of a named one
  --allow-failed   Accept an honest failed/aborted terminal
  --legacy         Read a 0.2/unversioned ledger in explicit compatibility mode

Replays gate conditions against recorded artifacts and checks executor-binding
attestations against the run's snapshot. Pre-dials run snapshots are refused;
verify them with fadeno <= 0.6.0-rc.27.
`,
  show: `fadeno show — a run's step projection and artifacts

Usage:
  fadeno show <run> [flags]

Options:
  --events   Print the raw event timeline instead of the step projection
  --legacy   Read a 0.2/unversioned ledger in explicit compatibility mode
`,
  'new-run': `fadeno new-run — create a run-ledger directory for a playbook

Usage:
  fadeno new-run <playbook> "<task>" [--input Name=path]...

Options:
  --input <Name=path>   Supply a declared input (repeatable)

Creates .fadeno/runs/<stamp>-<slug>/ with run.yaml + events.jsonl. Then either
\`fadeno drive <run>\` (engine) or follow the playbook manually with
\`fadeno next\` / \`fadeno run\` / \`fadeno gate\`.
`,
  run: `fadeno run — append attested updates to a run ledger

Usage:
  fadeno run <run> [flags]

Options:
  --step <id>         Set current_step and log a step_started event
  --status <status>   Set status: running | completed | failed | aborted
  --event <type>      Append a custom event
  --artifact <path>   Attach an artifact path to the event
  --member <role>     Attribute the event to a map member / actor
  --field <k=v>       Extra field on the event (repeatable)

Examples:
  fadeno run 2026-05-30-1132-csv --step review
  fadeno run 2026-05-30-1132-csv --event artifact_created --artifact artifacts/x.json --member architect_fable
  fadeno run 2026-05-30-1132-csv --status completed
`,
  gate: `fadeno gate — evaluate a gate condition from a structured artifact

Usage:
  fadeno gate <run> <condition> [--artifact <path>]

Options:
  --artifact <path>   Artifact path relative to the run (condition-specific default)

The gate reads the declared artifact, evaluates the deterministic condition, and
records the result as evidence. Exit code reflects the verdict.
`,
  prompt: `fadeno prompt — assemble (and record) a step's actor prompt

Usage:
  fadeno prompt <run> <step> [flags]

Options:
  --actor <role>    Map member / actor to assemble the prompt for
  --iteration <n>   Loop-body iteration to target (default: latest)
  --inline          Embed input file contents in the prompt
  --no-record       Preview only: write no snapshot or event
`,
  init: `fadeno init — scaffold project-owned Fadeno capability

Usage:
  fadeno init --codex|--claude|--grok [flags]

Options:
  --with-hooks    Also scaffold tier-2 enforcement hooks
  --no-steering   Opt out of default Codex/Claude steering
  --data-only     Seed definitions + driver policy (host capability via plugin)
  --force         Overwrite existing files / refresh the bootstrap section
`,
  setup: `fadeno setup — install safe user-scoped integration

Usage:
  fadeno setup [--codex|--claude] [--from <bin-dir>] [--reset-runtime]

Options:
  --non-interactive   Accepted compatibility no-op; setup never prompts
  --from <bin-dir>    Use bin dir as runtime source (instead of bundled)
  --reset-runtime     Allow downgrade to mirror this plugin

Writes user-level capability only; project scaffolding is \`fadeno init\`.
Inspect with \`fadeno status\`, remove with \`fadeno uninstall\`.
The managed runtime self-refreshes from the plugin on every plugin-launched command; setup is needed only for first-time integration.
`,
  status: `fadeno status — show effective definitions, routing, and state

Usage:
  fadeno status [--verbose] [--codex|--claude]

The status runtime reports skew direction (managed-older, managed-newer, divergent) and preferredCli (use managed only when observed version matches invoking version; otherwise use invoking path). Skills and subagents are loaded at host session start; a fresh session is required to refresh them — no setup or refresh will update the current session. FADENO_BUNDLED_RUNTIME is used for plugin-launched refresh detection.
`,
  doctor: `fadeno doctor — run read-only diagnostics

Usage:
  fadeno doctor [--codex|--claude]

Checks include runtime skew (managed-older, managed-newer, divergent), preferredCli, runtime.staging, kept-newer, locked, skipped-no-source, and session-definitions. Doctor remains read-only and never writes the runtime. Skills and subagents require a fresh session.
`,
  steering: `fadeno steering — hybrid steering: resolve dials, materialize host slots

Usage:
  fadeno steering resolve --archetype <a> [--host-executor <n>] [--role <r>]
                          [--run <id> --dispatch-id <id>]
                          [--prompt-file <path>|--prompt-sha256 <hex>]
  fadeno steering apply --codex|--claude [--scope project|user] [--force]

resolve emits the routing JSON hooks consume (exit 2 = restart required or
write conflict — not runnable in this session). apply materializes the
worker/reviewer/judge slots from the current dials, where the harness's agent
format can carry one: Codex TOMLs (model + model_reasoning_effort), loaded on
a fresh session. Under --claude it writes nothing and only cleans up retired
managed files — the Agent tool has no effort channel, so a dialed @effort
selects the delivery lane instead of an identity. Re-run after re-dialing.
--prompt-file (or --prompt-sha256) lets resolve see this exact prompt's
digest, so a shadow-attached archetype's reply carries the pair decision
(shadow.selected/shadow.routable) and, on a selected routable pair, resolves
mode=command instead of mode=host so both arms are comparable. Omitted, and
a shadow attachment's selected is null — unknown, never "no".
`,
  validate: `fadeno validate — validate playbooks and run documents

Usage:
  fadeno validate [file] [--schema <kind>]

Options:
  --schema <kind>   Force document kind: playbook | run | review-report | test-result

With no file, validates every playbook under .fadeno/playbooks (schema,
references, and flow semantics).
`,
  'tool-run': `fadeno tool-run — execute a registered tool step deterministically

Usage:
  fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]

Options:
  --tool <name>       Race guard: must equal the ready step's declared tool
  --timeout <seconds> Hard deadline seconds; 0 disables timeout

The tool must be registered in the layered executors.yaml tools registry as a static argv
array with optional timeout_ms. The playbook's tool name is a logical capability, never shell.
Every ready tool_call step whose tool is registered can be executed. A step whose artifact
type is test-result has its result SYNTHESIZED from the exit status (the exit code is the
finding); every other step captures the tool's STDOUT as the artifact, and a non-zero exit
is a failure rather than a result. Executes without a shell under the
supervisor, strips harness identity, acquires the shared writer lease, and synthesizes a
schema-valid TestResult (exit 0 => passed, nonzero => failed, spawn/timeout/signal => error).
`,
  'tool-complete': `fadeno tool-complete — record a manual tool result

Usage:
  fadeno tool-complete <run> --output <artifact-path>

Validates the artifact against the step's declared schema and atomically attributes it.
Shares validation with tool-run; one attempt wins via durable claim.
`,
  plugin: `fadeno plugin — generate a harness plugin from this checkout's templates

Usage:
  fadeno plugin [dir]            Claude Code plugin (default dir: plugin/)
  fadeno plugin [dir] --codex    Codex plugin

Options:
  --force   Overwrite existing generated files
`,
};

const SIGIL: Record<Target, string> = { codex: '$', claude: '/', grok: '/' };
const SCHEMA_KINDS: readonly SchemaKind[] = SCHEMA_KIND_LIST;

function printInitSummary(
  target: Target,
  repoRoot: string,
  results: EmitResult[],
  withHooks: boolean,
  withSteering: boolean,
  dataOnly: boolean,
): void {
  const counts = { created: 0, overwritten: 0, appended: 0, skipped: 0 };
  for (const r of results) counts[r.status] += 1;

  console.log(`Fadeno initialized for ${target} in ${repoRoot}\n`);
  for (const r of results) {
    console.log(`  ${r.status.padEnd(11)} ${relative(repoRoot, r.path) || r.path}`);
  }
  console.log(
    `\n${counts.created} created, ${counts.appended} appended, ` +
      `${counts.overwritten} overwritten, ${counts.skipped} skipped.`,
  );
  if (counts.skipped > 0) {
    console.log('Some files already existed and were left untouched. Re-run with --force to overwrite.');
  }

  if (target === 'claude') {
    const perm = results.find((r) => r.path.endsWith('settings.local.json'));
    if (perm && (perm.status === 'created' || perm.status === 'appended')) {
      console.log(
        '\nPre-approved `Bash(fadeno:*)` in .claude/settings.local.json (local, git-ignored)\n' +
          'so fadeno CLI calls no longer prompt each run — delete that allow rule to restore prompts.',
      );
    }
  }

  console.log('\nNext steps:');
  console.log('  1. Review .fadeno/playbooks and .fadeno/vocabulary.md');
  console.log('  2. Run `fadeno validate` to check the playbooks');
  if (dataOnly) {
    console.log(
        target === 'codex'
          ? '  3. Use the $fadeno-runner skill (from the installed Fadeno plugin)'
          : '  3. Use the /fadeno:runner skill (from the installed Fadeno plugin)',
    );
  } else {
    console.log(`  3. Ask your agent to use the ${SIGIL[target]}fadeno-runner skill on a complex task`);
  }
  let nextStep = 4;
  if (withHooks) {
    console.log(`  ${nextStep}. Activate enforcement: see .fadeno/hooks/README.md`);
    nextStep += 1;
  }
  if (withSteering) {
    console.log(
      target === 'claude'
        ? `  ${nextStep}. Steering is active locally; restart Claude Code so the Agent hook is loaded`
        : `  ${nextStep}. Materialize Codex steering with \`fadeno steering apply <loadout> --codex --force\`; command slots switch live, while host changes require a fresh session`,
    );
  }
}

function printIssue(issue: ValidationIssue): void {
  const at = issue.path ? `${issue.path}: ` : '';
  const line = `          ${issue.severity === 'error' ? 'error' : 'warn '} ${at}${issue.message}`;
  if (issue.severity === 'error') console.error(line);
  else console.log(line);
}

function printValidate(outcome: ValidateOutcome): void {
  let warnings = 0;
  for (const result of outcome.results) {
    const rel = relative(outcome.repoRoot, result.file) || result.file;
    const fileWarnings = result.issues.filter((i) => i.severity === 'warning').length;
    warnings += fileWarnings;
    if (result.ok) {
      const note = fileWarnings > 0 ? ` (${fileWarnings} warning${fileWarnings > 1 ? 's' : ''})` : '';
      console.log(`  ok    ${rel} [${result.kind}]${note}`);
    } else {
      console.log(`  FAIL  ${rel} [${result.kind}]`);
    }
    for (const issue of result.issues) printIssue(issue);
  }

  const failed = outcome.results.filter((r) => !r.ok).length;
  const summary =
    `\n${outcome.results.length - failed} ok, ${failed} invalid` +
    (warnings > 0 ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : '');
  if (outcome.ok) console.log(summary);
  else console.error(summary);
}

function truncateWithEllipsis(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function formatRunLine(run: RunSummary): string {
  if (run.problems.length > 0) {
    const playbook = run.playbook ?? '?';
    const task = run.task ? truncateWithEllipsis(run.task, 60) : '?';
    return `${run.runId}  [malformed]  ${playbook} — ${task} (${run.problems[0]})`;
  }
  const status = run.status ?? '?';
  const playbook = run.playbook ?? '?';
  const task = run.task ? truncateWithEllipsis(run.task, 60) : '?';
  const legacyTag = run.schemaVersion == null ? ' [legacy]' : '';
  return `${run.runId}  [${status}]${legacyTag}  ${playbook} — ${task}`;
}

function printRuns(runs: RunSummary[]): void {
  if (runs.length === 0) {
    console.log('No runs yet under .fadeno/runs.');
    return;
  }

  for (const run of runs) console.log(formatRunLine(run));

  const statusCounts = new Map<string, number>();
  for (const run of runs) {
    const key = run.status ?? '?';
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
  }
  const parts = [...statusCounts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([status, n]) => `${n} ${status}`);
  console.log(`\n${runs.length} run${runs.length === 1 ? '' : 's'} (${parts.join(', ')})`);
}

function printDispatches(result: DispatchesResult): void {
  if (result.lines.length === 0) {
    console.log(result.summary);
    return;
  }
  for (const line of result.lines) console.log(line);
  console.log(`\n${result.summary}`);
}

function utcTime(timestamp: string | null): string {
  if (!timestamp) return '--:--:--';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function stepSuffix(step: string | null): string {
  return step != null ? `  (step: ${step})` : '';
}

function renderEvent(event: RunEvent): string {
  const { type, step, extra } = event;
  switch (type) {
    case 'step_started':
      return `step_started  ${step ?? '?'}`;
    case 'artifact_created': {
      const artifact = typeof extra.artifact === 'string' ? extra.artifact : '?';
      return `artifact_created  ${artifact}${stepSuffix(step)}`;
    }
    case 'gate_evaluated': {
      const condition = typeof extra.condition === 'string' ? extra.condition : '?';
      const resultRaw = typeof extra.result === 'string' ? extra.result : '?';
      const artifact = typeof extra.artifact === 'string' ? extra.artifact : '?';
      return `gate_evaluated  ${condition} → ${resultRaw.toUpperCase()}  (${artifact})`;
    }
    case 'run_started':
    case 'run_completed':
      return `${type}${stepSuffix(step)}`;
    default: {
      const compact = JSON.stringify(extra);
      return `${type}  ${truncateWithEllipsis(compact, 80)}`;
    }
  }
}

const STEP_GLYPHS: Record<StepView['state'], string> = {
  pending: '○',
  running: '→',
  waiting: '!',
  blocked: '■',
  completed: '✓',
  failed: '✗',
};

function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function stepSummary(step: StepView): string {
  const parts: string[] = [];
  parts.push(step.state);
  const runtime = formatDuration(step.runtimeMs);
  if (runtime != null) parts.push(runtime);
  if (step.actorCalls > 1) parts.push(`${step.actorCalls} actor calls`);
  if (step.attempts > step.actorCalls) {
    const repairNote = step.repairs > 0 ? `, ${step.repairs} schema repair${step.repairs === 1 ? '' : 's'}` : '';
    parts.push(`${step.attempts} attempts${repairNote}`);
  }
  if (step.resumed > 0) {
    parts.push(step.resumed === 1 ? 'resumed session' : `${step.resumed} resumed-session calls`);
  }
  if (step.artifacts > 0) parts.push(`${step.artifacts} artifact${step.artifacts === 1 ? '' : 's'}`);
  for (const gate of step.gates) parts.push(`gate ${gate.condition} → ${gate.result}`);
  if (step.iterations > 0) parts.push(`${step.iterations} iteration${step.iterations === 1 ? '' : 's'}`);
  for (const decision of step.decisions) parts.push(`decision: ${decision}`);
  return parts.join(' · ');
}

function printProjection(projection: ShowProjection): void {
  const total = formatDuration(projection.runtimeMs);
  console.log(`\nworkflow${projection.playbook ? ` · ${projection.playbook}` : ''}${total ? ` · total ${total}` : ''}`);
  if (projection.steps.length === 0) console.log('  (no steps recorded)');
  const width = Math.max(0, ...projection.steps.map((s) => s.id.length));
  for (const step of projection.steps) {
    const summary = stepSummary(step);
    const indent = step.loopBodyOf != null ? '    ↳ ' : '  ';
    const kind = step.kind != null ? ` [${step.kind}]` : '';
    console.log(`${indent}${STEP_GLYPHS[step.state]} ${step.id.padEnd(width)}${kind}${summary ? `  ${summary}` : ''}`);
    for (const actor of step.actors) {
      const details: string[] = [actor.state];
      const actorRuntime = formatDuration(actor.runtimeMs);
      if (actorRuntime != null) details.push(actorRuntime);
      if (actor.phase != null) details.push(actor.phase);
      if (actor.summary != null) details.push(truncateWithEllipsis(actor.summary, 120));
      if (actor.completed.length > 0) details.push(`${actor.completed.length} checkpoint${actor.completed.length === 1 ? '' : 's'}`);
      if (actor.current != null) details.push(truncateWithEllipsis(actor.current, 120));
      if (actor.next != null) details.push(`next: ${truncateWithEllipsis(actor.next, 100)}`);
      if (actor.blockers.length > 0) details.push(`blocked: ${truncateWithEllipsis(actor.blockers.join('; '), 120)}`);
      if (actor.source != null) {
        const progressAge = formatDuration(actor.progressAgeMs);
        details.push(`${actor.source}-attested semantic progress${progressAge == null ? '' : ` ${progressAge} ago`} (non-gating)`);
      }
      console.log(`${indent}    ${STEP_GLYPHS[actor.state]} ${actor.actor}  ${details.join(' · ')}`);
    }
    for (const instance of step.instances) {
      // Nested leaf/generation instances are already visible under their
      // logical step; map-member roots are the useful branch summary here.
      if (instance.parentId != null) continue;
      const details: string[] = [instance.state];
      const runtime = formatDuration(instance.runtimeMs);
      if (runtime != null) details.push(runtime);
      if (instance.generation != null) details.push(`generation ${instance.generation}`);
      console.log(`${indent}    ${STEP_GLYPHS[instance.state]} ${instance.member ?? instance.id}  ${details.join(' · ')}`);
    }
  }

  if (projection.harnessObserved.length > 0) {
    console.log('\nharness-observed processes (non-gating)');
    for (const fact of projection.harnessObserved) {
      const holder = fact.holderId != null ? `holder: ${fact.holderId}${fact.holderKind != null ? ` (${fact.holderKind})` : ''}` : 'holder: —';
      const mode = `workspace_mode=${fact.workspaceMode ?? '—'}`;
      const pids = `supervisor_pid=${fact.supervisorPid ?? '—'} executor_pid=${fact.executorPid ?? '—'} pgid=${fact.processGroupId ?? '—'}`;
      const runtime = formatDuration(fact.runtimeMs);
      const heartbeatAge = formatDuration(fact.heartbeatAgeMs);
      const outputAge = formatDuration(fact.outputAgeMs);
      const state = `${fact.processState}${runtime == null ? '' : ` · ${runtime}`}`;
      const times = `heartbeat=${heartbeatAge == null ? 'unknown' : `${heartbeatAge} ago`} output=${outputAge == null ? 'not observed' : `${outputAge} ago`}`;
      const bytes = `stdout_bytes=${fact.stdoutBytes ?? '—'} stderr_bytes=${fact.stderrBytes ?? '—'}`;
      const correlation = `run=${fact.runId ?? '—'} dispatch=${fact.dispatchId ?? '—'}`;
      const outcome = fact.signal != null
        ? ` signal=${fact.signal}`
        : fact.exitCode != null
          ? ` exit_code=${fact.exitCode}`
          : '';
      const ended = fact.endedAt == null ? '' : ` ended_at=${fact.endedAt}`;
      const error = fact.observationError == null ? '' : `  observation_error=${fact.observationError}`;
      console.log(`  ${holder}  ${state}${outcome}${ended}  ${mode}  ${correlation}  ${pids}  ${times}  ${bytes}  claim=${fact.claimPath}${error}`);
      if (fact.outputIdleWarning) {
        const idleDuration = fact.outputAgeMs != null ? formatDuration(fact.outputAgeMs) : fact.runtimeMs != null ? formatDuration(fact.runtimeMs) : '5m';
        console.log(`    WARNING: no output observed for ${idleDuration ?? '5m'} (non-gating)`);
      }
    }
  }

  if (projection.requests.length > 0) {
    console.log('\nhost dispatches');
    const byStep = new Map<string, typeof projection.requests>();
    for (const request of projection.requests) {
      const list = byStep.get(request.step) ?? [];
      list.push(request);
      byStep.set(request.step, list);
    }
    for (const [step, requests] of byStep) {
      const counts = new Map<string, number>();
      for (const request of requests) counts.set(request.state, (counts.get(request.state) ?? 0) + 1);
      const summary = [...counts.entries()].map(([state, count]) => `${count} ${state}`).join(' · ');
      console.log(`  ${step}  ${summary}`);
      for (const request of requests) {
        const member = request.actor ?? '(anonymous)';
        const model = request.model != null && request.reasoningEffort != null ? `${request.model}/${request.reasoningEffort}` : request.executor;
        const details: string[] = [request.state];
        const runtime = formatDuration(request.runtimeMs);
        if (runtime != null) details.push(runtime);
        if (request.phase != null) details.push(request.phase);
        if (request.summary != null) details.push(truncateWithEllipsis(request.summary, 120));
        if (request.completed.length > 0) details.push(`${request.completed.length} checkpoint${request.completed.length === 1 ? '' : 's'}`);
        if (request.current != null) details.push(truncateWithEllipsis(request.current, 120));
        if (request.next != null) details.push(`next: ${truncateWithEllipsis(request.next, 100)}`);
        if (request.progressSource != null) {
          const progressAge = formatDuration(request.progressAgeMs);
          details.push(`${request.progressSource}-attested semantic progress${progressAge == null ? '' : ` ${progressAge} ago`} (non-gating)`);
        }
        // Non-gating isolated workspace observability — never controls gates.
        if (request.workspaceMode === 'isolated') {
          const wsNote = request.workspace != null ? `workspace_mode: isolated workspace=${request.workspace}` : 'workspace_mode: isolated';
          const baseNote = request.baseCommit != null ? ` base_commit=${request.baseCommit.slice(0, 8)}` : '';
          const diffNote = request.diffSnapshot != null ? ` diff=${request.diffSnapshot} (${request.diffBytes ?? 0} B)` : '';
          details.push(`${wsNote}${baseNote}${diffNote} (non-gating)`);
        }
        console.log(`      ${member}  ${model}  ${details.join(' · ')}`);
      }
    }
  }

  if (projection.active.length > 0) {
    console.log('\nactive artifacts');
    for (const art of projection.active) {
      const memberNote = art.member != null ? ` · ${art.member}` : '';
      const bytesNote = art.bytes != null ? ` · ${art.bytes} B` : '';
      console.log(`  ${art.path}  (gen ${art.generation}${memberNote}${bytesNote})`);
    }
  }

  if (projection.decisions.length > 0) {
    console.log('\ndecisions');
    for (const d of projection.decisions) console.log(`  ${d.step ?? '(run)'} → ${d.branch}`);
  }

  if (projection.failures.length > 0) {
    console.log('\nfailures');
    for (const f of projection.failures) console.log(`  ${f}`);
  }
}

function printShow(repoRoot: string, result: ShowResult, rawTimeline: boolean): void {
  const { run, mode, events, badLines, artifacts, projection } = result;
  const dash = (value: string | null): string => value ?? '—';
  const relDir = relative(repoRoot, run.dir) || run.dir;

  console.log(`run ${run.runId}`);
  console.log(`  playbook:  ${dash(run.playbook)}`);
  console.log(`  task:      ${dash(run.task)}`);
  console.log(`  status:    ${dash(run.status)}`);
  console.log(`  host:      ${dash(run.host)}`);
  console.log(`  started:   ${dash(run.startedAt)}`);
  console.log(`  ended:     ${dash(run.endedAt)}`);
  console.log(`  dir:       ${relDir}`);
  if (mode !== 'current') {
    console.log('\n  compatibility ledger (read via --legacy; not verifiable to 0.3 guarantees)');
  }

  if (projection != null && !rawTimeline) {
    printProjection(projection);
  } else {
    const eventLabel = events.length === 1 ? 'event' : 'events';
    console.log(`\ntimeline (${events.length} ${eventLabel})`);
    for (const event of events) {
      console.log(`  ${utcTime(event.timestamp)}  ${renderEvent(event)}`);
    }
  }
  for (const lineNo of badLines) {
    console.log(`  line ${lineNo}: unparseable event (skipped)`);
  }

  console.log(`\nartifacts (${artifacts.length})`);
  for (const art of artifacts) {
    console.log(`  ${art.path}  (${art.bytes} bytes)`);
  }
}

const DIAL_SOURCE_TEXT: Record<string, string> = {
  binding: 'binding',
  session: 'session dial',
  repo: 'repo pin',
  user: 'user dial',
  base: 'base',
};

function printBakeoffArm(arm: BakeoffArmMeasurement): void {
  const id = arm.dispatchId != null ? arm.dispatchId.slice(0, 8) : '(missing)';
  const identity = `${arm.executor ?? '(unresolved)'} (${arm.model ?? '?'}${arm.reasoningEffort != null ? `@${arm.reasoningEffort}` : ''})`;
  console.log(`  ${arm.arm.padEnd(10)} ${id}  ${identity}`);
  if (arm.refused != null) {
    console.log(`    refused [${arm.refused.predicate}] ${arm.refused.message}`);
    return;
  }
  const secs = arm.durationMs != null ? `${Math.round(arm.durationMs / 1000)}s` : '?';
  console.log(`    exit ${arm.exitCode ?? '?'} in ${secs}, output ${arm.outputBytes ?? '?'} bytes`);
  if (arm.diff != null) {
    const gen = arm.diff.generatedFiles.length > 0
      ? `  [${arm.diff.generatedFiles.length} generated: ${arm.diff.generatedFiles.slice(0, 3).join(', ')}]`
      : '';
    console.log(`    diff ${arm.diff.files} files +${arm.diff.insertions}/-${arm.diff.deletions} (${arm.diff.bytes} bytes)${gen}`);
  }
  if (arm.signals != null) {
    console.log(`    introduced ${arm.signals.introduced.length} identifier(s)`);
    if (arm.signals.unreached == null) {
      console.log('    reach:      undeclared — no `surfaces:` in .fadeno/executors.yaml, so this is not claimed either way');
    } else if (arm.signals.unreached.length === 0) {
      console.log('    reach:      every introduced identifier appears on a declared surface');
    } else {
      console.log(`    reach:      ${arm.signals.unreached.length} never reach a surface: ${arm.signals.unreached.join(', ')}`);
    }
    if (arm.signals.redefined.length > 0) {
      console.log(`    redefined:  already defined at baseline: ${arm.signals.redefined.join(', ')}`);
    }
  }
}

function printBakeoff(result: BakeoffResult): void {
  const base = result.baselineCommit != null ? result.baselineCommit.slice(0, 8) : '(none)';
  console.log(`pair ${result.pairId.slice(0, 8)}  archetype ${result.archetype ?? '?'}  baseline ${base}`);
  for (const arm of result.arms) printBakeoffArm(arm);
  if (result.reachDifferential != null && result.reachDifferential.length > 0) {
    console.log('  reach differential — both arms introduced these; only one wired them to a surface:');
    for (const d of result.reachDifferential) {
      console.log(`    ${d.identifier}: reached in ${d.reachedIn}, NEVER reached in ${d.unreachedIn}`);
    }
  }
  if (result.confounds.length === 0) {
    console.log('  confounds: none recorded');
  } else {
    console.log(`  confounds (${result.confounds.length}) — kernel-stamped, not judged:`);
    for (const c of result.confounds) console.log(`    [${c.code}] ${c.arm}: ${c.detail}`);
  }
  if (result.measureOnly) {
    console.log('  measured only — no verdict was formed and nothing was written.');
    return;
  }
  console.log(`  verdict: ${result.verdict}`);
  // The plan, not just the fact that there is one. `graft` means neither arm
  // should be taken whole; printing only the verdict and a path says that and
  // then withholds what to take.
  if (result.graftPlan != null && result.graftPlan.length > 0) {
    console.log('  graft plan:');
    for (const step of result.graftPlan) {
      const paths = step.paths != null && step.paths.length > 0 ? ` [${step.paths.join(', ')}]` : '';
      console.log(`    from ${step.from_arm}: ${step.what} — ${step.why}${paths}`);
    }
  }
  console.log(`  written: ${result.comparisonPath}`);
  if (result.judgeDispatchIds != null) {
    console.log(
      `  judge dispatches: comparison ${result.judgeDispatchIds.comparison.slice(0, 8)}, ` +
        `adversarial ${result.judgeDispatchIds.adversarial.slice(0, 8)}`,
    );
  } else {
    console.log('  judge delivery: host — recorded from a file, no dispatch receipt (see Confounds)');
  }
}

function printBakeoffPrepare(result: BakeoffPrepareResult): void {
  const base = result.baselineCommit != null ? result.baselineCommit.slice(0, 8) : '(none)';
  console.log(`pair ${result.pairId.slice(0, 8)}  archetype ${result.archetype ?? '?'}  baseline ${base}`);
  for (const arm of result.arms) printBakeoffArm(arm);
  console.log('  prepared — no verdict was formed and nothing was written.');
  if (result.armTrees != null) {
    // Named even though the prompt already carries them: these are real
    // directories on disk that `fadeno clean` will remove, and a caller who
    // cannot see what was written cannot know what it is about to lose.
    console.log(`  evidence: explored — each arm's tree was reconstructed on disk:`);
    console.log(`    arm_a: ${result.armTrees.a.tree}/  (changes: ${result.armTrees.a.diff})`);
    console.log(`    arm_b: ${result.armTrees.b.tree}/  (changes: ${result.armTrees.b.diff})`);
  }
  console.log(`  spawn a "${result.judgeArchetype}" subagent per prompt file, INDEPENDENTLY:`);
  console.log(`    comparison prompt:  ${result.comparisonPromptPath}`);
  console.log(`    adversarial prompt: ${result.adversarialPromptPath}`);
  console.log(
    `  then: fadeno bakeoff <pair-id> --record --comparison <file> --adversarial <file>` +
      (result.evidenceMode === 'explored' ? ' --evidence explored' : ''),
  );
}

function printStaleShadows(stale: Array<{ archetype: string; target: string }>): void {
  for (const item of stale) {
    console.error(
      `warning: shadow attachment ${item.archetype}~${item.target} names a model that is no longer resolvable — run \`fadeno dial shadow ${item.archetype} <model>\` or \`fadeno dial clear-shadow ${item.archetype}\`; the attachment is ignored below.`,
    );
  }
}

function printStaleDials(stale: Array<{ archetype: string; target: string }>): void {
  for (const item of stale) {
    console.error(`warning: dial ${item.archetype}→${item.target} is stale — re-dial with \`fadeno dial ${item.archetype} <model>\``);
  }
}

function printModels(result: ModelsResult): void {
  // `via`, not `harness`: the column holds the model's home DRIVER, which is
  // the value `--via` takes. Renamed 2026-08-21 — see `printDialShow`.
  const header = `${'model'.padEnd(12)}  ${'provider'.padEnd(12)}  ${'id'.padEnd(26)}  ${'effort'.padEnd(8)}  via`;
  console.log(header);
  for (const row of result.models) {
    console.log(
      `${row.name.padEnd(12)}  ${(row.provider ?? '—').padEnd(12)}  ${row.id.padEnd(26)}  ${row.effort.padEnd(8)}  ${row.home_via}`,
    );
  }
  for (const row of result.models) {
    if (row.stale != null) console.error(`warning: ${row.name} — ${row.stale}`);
  }
  console.log(
    `\nany other name routes via ${result.unregistered_model_driver} — id passed verbatim, probed at dial time`,
  );
  if (result.listable_drivers.length > 0) {
    console.log(`live backend listings: fadeno models --driver <${result.listable_drivers.join('|')}>`);
  }
}

function printModelDetail(result: ModelsResult, name: string): void {
  const row = result.models.find((r) => r.name === name);
  if (row == null) {
    console.log(
      `"${name}" is not in the registry — dialing it routes via ${result.unregistered_model_driver} with the id passed verbatim (probed at dial time). ` +
        'Declare it under models: to set a home driver or standard effort.',
    );
    return;
  }
  printModels({ ...result, models: [row] });
  console.log(`  via: ${row.home_via}`);
  for (const lane of row.lanes) {
    console.log(`  alternate: --via ${lane.via} → ${lane.id}`);
  }
  for (const [driver, id] of Object.entries(row.spellings)) {
    console.log(`  spelling: --via ${driver} → ${id}`);
  }
  for (const [archetype, state] of Object.entries(row.eligibility)) {
    if (state !== 'eligible') console.log(`  eligibility: ${archetype} → ${state}`);
  }
}

function printModelsDriver(result: DriverListingResult): void {
  console.log(`${result.driver} backend listing (${result.models_command.join(' ')}): ${result.models.length} model(s)`);
  for (const model of result.models) {
    const marks = model.registered_as.length > 0 ? `  ← ${model.registered_as.join(', ')}` : '';
    console.log(`  ${model.id}${marks}`);
  }
}

/**
 * Name the delivery lane in the resolution echo, where it is not the one the
 * line's `[source]` implies.
 *
 * Two dials that print identically — `opus` and `opus@xhigh` differ by three
 * characters — now deliver differently: the unpinned one inherits the session
 * and runs in it, the pinned one goes out to the command lane whenever the
 * session is at some other effort. Worse, the same dial flips lanes when the
 * session's effort changes under it. Consecutive spawns behaving differently
 * with nothing on screen to explain it is what this replaces:
 *
 *     worker → opus@xhigh (opus) [session dial]
 *     worker → opus@xhigh (opus) [command lane: session is medium]
 *
 * The lane displaces the source label rather than crowding in beside it: when
 * a delivery leaves the session, *why it left* is the fact the reader needs,
 * and which layer held the dial is still one `fadeno dial` away (and stays in
 * `--json`, untouched).
 */
function withLaneLabels(lines: string[], roles: unknown): string[] {
  // `roles` and `echo` are built one-per-role in the same loop, so equal
  // lengths mean equal positions. Anything else and this says nothing rather
  // than labeling the wrong line.
  if (!Array.isArray(roles) || roles.length !== lines.length) return lines;
  const refs = roles.map((role) => (typeof role?.executor === 'string' ? role.executor : null));
  const lanes = offHostLanes(refs, sessionEffort());
  return lines.map((line, index) => {
    const decision = lanes[index];
    if (decision == null) return line;
    // `restart_required` must not read as "command lane" — that would name a
    // lane the same sentence says does not exist.
    const label =
      decision.lane === 'command'
        ? `[command lane: ${decision.lane_reason}]`
        : `[restart required: ${decision.lane_reason}]`;
    return /\[[^\]]*\]$/.test(line) ? line.replace(/\[[^\]]*\]$/, label) : `${line} ${label}`;
  });
}

/**
 * `emptyMessage` is for the shadow-filtered view: an effective table with zero
 * rows reads as broken (a bare header, nothing under it), where the full `dial`
 * table never has zero rows (the worker/reviewer/judge triad always shows).
 * When set and there is nothing to show, it replaces the header+rows entirely
 * rather than printing beside an empty table.
 */
function printDialShow(result: DialShowResult, emptyMessage?: string): void {
  if (result.legacy_pin_note) console.log(result.legacy_pin_note);
  if (result.staleDials.length > 0) printStaleDials(result.staleDials);
  if (result.staleShadows.length > 0) printStaleShadows(result.staleShadows);
  if (result.rows.length === 0 && emptyMessage != null) {
    console.log(emptyMessage);
    if (result.note) console.log(result.note);
    return;
  }
  // Header
  // `via`, not `harness`. The column always held the DRIVER — the value
  // `--via <driver>` sets — while `harness` in the same command's JSON means
  // the agent you are sitting inside. Two meanings, one word, printed a column
  // apart. Renamed 2026-08-21 along with `claude-cli` → `claude`, which is
  // what the column now says for an Anthropic model under any harness.
  const header = `${'archetype'.padEnd(12)}  ${'model'.padEnd(18)}  ${'effort'.padEnd(8)}  ${'via'.padEnd(22)}  source`;
  console.log(header);
  for (const row of result.rows) {
    const arch = row.archetype.padEnd(12);
    const model = row.modelDisplay.padEnd(18);
    // The PIN, never the resolved effort. Once the delivery lane depends on
    // whether the user pinned an effort, printing the registry default in
    // this column says "xhigh" for both `dial worker opus` and
    // `dial worker opus@xhigh` — two dials that now deliver differently.
    // `inherit` rather than `—`: `—` already means "not applicable" in this
    // column (the fallback row below), and an unpinned dial is not
    // effort-less, it takes its effort from elsewhere — the session on the
    // host lane, the model's declared default on the command lane. `inherit`
    // is also the one word that cannot be mistaken for a value, unlike
    // `default`, which is a literal effort in the vocabulary.
    const effort = (row.resolvedVia != null ? '—' : row.pinned_effort ?? 'inherit').padEnd(8);
    const via = row.driver.padEnd(22);
    const elig = row.eligibility === 'shadow_only' ? '  SHADOW-ONLY (never gates)' : row.eligibility === 'forbidden' ? '  FORBIDDEN (refused at dispatch)' : '';
    // `inherits`, not `via`: `resolvedVia` is the ARCHETYPE this row borrowed
    // its dial from (`reviewer` with no dial of its own falling back to
    // `worker`), which has nothing to do with the `via` column two cells left
    // — that one is the driver. Printing both as "via" on one line was the
    // collision that kept the column named `harness`.
    const inherits = row.resolvedVia ? ` (inherits ${row.resolvedVia})` : '';
    console.log(`${arch}  ${model}  ${effort}  ${via}  ${DIAL_SOURCE_TEXT[row.source] ?? row.source}${inherits}${elig}`);
    if (row.shadow) console.log(formatShadowLine(row.shadow, '  '));
  }
  // One line, once, when any shadow is shown. The shadow row reads as a
  // property of the archetype; its scope is narrower than that, and a reader
  // of this table is exactly the person who would otherwise assume a playbook
  // run pairs too. See the same note at attach time.
  if (result.rows.some((row) => row.shadow)) {
    console.log('  (shadows roll on ad-hoc `fadeno dispatch` only; `fadeno drive` runs are unpaired)');
  }
  if (result.note) console.log(result.note);
}

const SHADOW_EMPTY_MESSAGE =
  'no active shadow attachments — attach one with `fadeno shadow <archetype> <model> [--rate <r>]`';

/**
 * Shared handler for `fadeno dial shadow ...` and its top-level alias
 * `fadeno shadow ...` — both spellings call this, so they cannot drift. The
 * caller has already validated the positional shape (0 extra = show mode, 2
 * extra = attach, 1 extra = usage error, refused before this is reached).
 */
function runShadowCommand(
  archetype: string | undefined,
  model: string | undefined,
  opts: { via: string | null; rate?: string; json: boolean },
): number {
  if (archetype == null) {
    const result = runShadowShow({});
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    printDialShow(result, SHADOW_EMPTY_MESSAGE);
    return 0;
  }
  const result = runDialShadow({ archetype, model: model!, via: opts.via, rate: opts.rate });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  for (const note of result.notes) console.log(note);
  const rate = result.rate != null ? ` [rate ${result.rate}]` : '';
  console.log(`shadow attached: ${result.archetype} ~ ${result.refString} via ${result.driver}${rate}`);
  if (result.previous) console.log(`  (was ${result.previous.model}${result.previous.rate ? ` rate ${result.previous.rate}` : ''})`);
  // Said at attach time, because the dial reads like a property of the
  // ARCHETYPE and is not one. `fadeno drive` never rolls a pair — shadow
  // sampling lives in the ad-hoc dispatch kernel — so an archetype dialed here
  // pairs when someone runs `fadeno dispatch`, and does not when the same
  // archetype is dispatched by a playbook run. Left undisclosed, this is a
  // dial that silently does nothing for half the system.
  console.log(
    `  scope: ad-hoc \`fadeno dispatch\` only. Engine runs (\`fadeno drive\`) do not roll shadow pairs, ` +
      `so ${result.archetype} steps inside a playbook run are unpaired.`,
  );
  return 0;
}

function printDrive(result: DriveResult): number {
  console.log('');
  switch (result.outcome) {
    case 'terminal':
      console.log(`run ${result.run} is terminal (${result.status}).`);
      return result.status === 'completed' ? 0 : 1;
    case 'paused_human_gate': {
      const d = result.decision!;
      console.log(`paused at ${d.step} — ${d.prompt}`);
      console.log(`  decision: ${d.decisionId}   options: ${d.options.join(' | ')}`);
      console.log(`  resolve:  fadeno decide ${result.run} <option>   then re-run fadeno drive ${result.run}`);
      return 0;
    }
    case 'awaiting_host_dispatch':
      console.log(`awaiting ${result.requests.length} host dispatch(es) for run ${result.run}`);
      for (const request of result.requests) {
        console.log(`  ${request.dispatchId}  ${request.step}${request.actor ? ` (${request.actor})` : ''}  ${request.model}/${request.reasoningEffort}`);
        if (request.nodeInstanceId != null) console.log(`      instance: ${request.nodeInstanceId}`);
        const progress = request.nodeInstanceId == null
          ? progressSidecarPath(request.run, request.step, request.actor)
          : `.fadeno/progress/${request.run}/${request.stepExecutionId}.json`;
        console.log(`      progress: <workspace>/${progress}`);
      }
      return 0;
    default:
      console.error(`drive stopped (${result.outcome}): ${result.detail}`);
      return 1;
  }
}

function printVerify(result: VerifyResult): void {
  const { run, findings, ok } = result;
  console.log(`run ${run.runId}  [${run.status ?? '?'}]`);
  console.log('');
  for (const f of findings) {
    const token = f.status === 'fail' ? 'FAIL' : f.status;
    const line = `  ${token.padEnd(4)}  ${f.check.padEnd(22)}  ${f.detail}`;
    if (f.status === 'fail') console.error(line);
    else console.log(line);
  }

  const counts = { ok: 0, skip: 0, fail: 0 };
  for (const f of findings) counts[f.status] += 1;
  const summary = `\nverify: ${counts.ok} ok, ${counts.skip} skipped, ${counts.fail} failed`;
  if (ok) console.log(summary);
  else console.error(summary);
}

function requireTarget(values: { codex?: boolean; claude?: boolean; grok?: boolean }): Target {
  const selected: Target[] = [];
  if (values.codex) selected.push('codex');
  if (values.claude) selected.push('claude');
  if (values.grok) selected.push('grok');
  if (selected.length > 1) {
    throw new Error('Choose exactly one target: --codex, --claude, or --grok.');
  }
  if (selected.length === 1) return selected[0];
  throw new Error(
    'Specify a target: `fadeno init --codex`, `fadeno init --claude`, or `fadeno init --grok`.',
  );
}

function optionalTarget(values: { codex?: boolean; claude?: boolean; grok?: boolean }): Target | undefined {
  const selected: Target[] = [];
  if (values.codex) selected.push('codex');
  if (values.claude) selected.push('claude');
  if (values.grok) selected.push('grok');
  if (selected.length > 1) throw new Error('Choose at most one target: --codex, --claude, or --grok.');
  return selected[0];
}

function main(argv: string[]): number {
  // The generated completer places the complete COMP_WORDS vector after an
  // explicit `--` boundary. Parse this tiny protocol before node:util.parseArgs
  // so partially typed flags in that vector cannot be consumed as CLI options.
  if (argv[0] === 'completion' && argv[1] === 'candidates') {
    const separator = argv.indexOf('--', 3);
    if (separator !== 3 || argv.length <= separator + 1) {
      throw new Error('Usage: fadeno completion candidates <cword> -- <words...>');
    }
    const cword = Number(argv[2]);
    if (!Number.isInteger(cword) || cword < 0) {
      throw new Error('Usage: fadeno completion candidates <cword> -- <words...>');
    }
    const candidates = runCompletionCandidates({ cword, words: argv.slice(separator + 1) });
    if (candidates.length > 0) process.stdout.write(`${candidates.join('\n')}\n`);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        codex: { type: 'boolean' },
        claude: { type: 'boolean' },
        grok: { type: 'boolean' },
        force: { type: 'boolean' },
        'with-hooks': { type: 'boolean' },
        'with-steering': { type: 'boolean' },
        'no-steering': { type: 'boolean' },
        'data-only': { type: 'boolean' },
        'non-interactive': { type: 'boolean' },
        from: { type: 'string' },
        'reset-runtime': { type: 'boolean' },
        all: { type: 'boolean' },
        'purge-user-data': { type: 'boolean' },
        project: { type: 'boolean' },
        verbose: { type: 'boolean' },
        scope: { type: 'string' },
        schema: { type: 'string' },
        format: { type: 'string' },
        step: { type: 'string' },
        status: { type: 'string' },
        event: { type: 'string' },
        artifact: { type: 'string' },
        report: { type: 'string' },
        member: { type: 'string' },
        field: { type: 'string', multiple: true },
        actor: { type: 'string' },
        iteration: { type: 'string' },
        inline: { type: 'boolean' },
        'no-record': { type: 'boolean' },
        bind: { type: 'string', multiple: true },
        'max-transitions': { type: 'string' },
        parallel: { type: 'string' },
        'actor-call': { type: 'string' },
        timeout: { type: 'string' },
        input: { type: 'string', multiple: true },
        via: { type: 'string' },
        driver: { type: 'string' },
        user: { type: 'boolean' },
        session: { type: 'boolean' },
        repo: { type: 'boolean' },
        model: { type: 'string' },
        archetype: { type: 'string' },
        'prompt-sha256': { type: 'string' },
        role: { type: 'string' },
        'host-executor': { type: 'string' },
        // Pre-0.6 spelling. Kept parseable so a Codex agent TOML materialized
        // by an older setup keeps resolving until the next one rewrites it.
        'native-executor': { type: 'string' },
        run: { type: 'string' },
        'dispatch-id': { type: 'string' },
        'prompt-file': { type: 'string' },
        'no-brief': { type: 'boolean' },
        isolate: { type: 'boolean' },
        shared: { type: 'boolean' },
        'ignored-output': { type: 'string' },
        diagnostics: { type: 'boolean' },
        tail: { type: 'string' },
        rate: { type: 'string' },
        tag: { type: 'string' },
        shadow: { type: 'string' },
        bakeoffs: { type: 'boolean' },
        wait: { type: 'string' },
        arm: { type: 'string' },
        check: { type: 'boolean' },
        'measure-only': { type: 'boolean' },
        evidence: { type: 'string' },
        prepare: { type: 'boolean' },
        record: { type: 'boolean' },
        comparison: { type: 'string' },
        adversarial: { type: 'string' },
        judge: { type: 'string' },
        json: { type: 'boolean' },
        'agent-id': { type: 'string' },
        workspace: { type: 'string' },
        branch: { type: 'string' },
        file: { type: 'string' },
        source: { type: 'string' },
        output: { type: 'string' },
        cancel: { type: 'string' },
        commit: { type: 'string' },
        reason: { type: 'string' },
        decision: { type: 'string' },
        feedback: { type: 'string' },
        latest: { type: 'boolean' },
        'allow-failed': { type: 'boolean' },
        legacy: { type: 'boolean' },
        events: { type: 'boolean' },
        tool: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}\n`);
    console.error(HELP);
    return 1;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  // `parseArgs` is strict, but its option table is GLOBAL across every
  // command, so a flag declared for one command parses cleanly under any
  // other and is then silently ignored. `fadeno doctor --repo <path>`
  // consumed `--repo` as `dial`'s boolean and left the path as a stray
  // positional — reporting on the current repository while appearing to
  // inspect another one. A wrong answer that looks right is worse than an
  // error, and this was found the only way that class ever is: by noticing
  // the output described somewhere else.
  //
  // The per-command table in `completion.ts` already knew the answer; it now
  // serves both completion and validation, so the two cannot drift. An
  // unknown command answers `[]` rather than "accepts nothing", because
  // rejecting every flag of a command the registry forgot would be a worse
  // failure than the one being fixed.
  if (command != null && values.help !== true && values.version !== true) {
    const unknown = unknownFlagsFor(command, positionals[1], Object.keys(values));
    if (unknown.length > 0) {
      const described = unknown.map((flag: string) => {
        const near = suggestFlag(command, positionals[1], flag);
        return near != null ? `${flag} (did you mean ${near}?)` : flag;
      });
      // Name what IS accepted rather than only what is not. The list is
      // short for most commands, and a reader who mistyped is one glance from
      // the answer instead of one more invocation.
      const accepted = [...(knownFlagsFor(command, positionals[1]) ?? [])].sort();
      throw new Error(
        `\`fadeno ${command}\` does not accept ${described.join(', ')}. ` +
          (accepted.length > 0 && accepted.length <= 8
            ? `It accepts: ${accepted.join(', ')}.`
            : `Run \`fadeno ${command} --help\` for what it does accept.`),
      );
    }
  }

  if (values.version) {
    console.log(packageVersion());
    return 0;
  }
  if (values.help) {
    console.log(command != null && Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : HELP);
    return 0;
  }
  if (!command) {
    console.log(HELP);
    return 1;
  }

  // Best-effort runtime maintenance preflight for operational commands
  maybeRunRuntimePreflight(argv, command);

  switch (command) {
    case 'setup': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('`fadeno setup` supports --codex or --claude; Grok has no steering setup.');
      const runtimeSource = values.from != null ? String(values.from) : undefined;
      const result = runSetup({ target: target ?? null, nonInteractive: values['non-interactive'], runtimeSource: runtimeSource as any, resetRuntime: Boolean(values['reset-runtime']) });
      console.log(`Fadeno setup (${result.target ?? 'standalone'})`);
      for (const probe of result.probes) console.log(`  ${probe.name}: ${probe.available ? `available${probe.version ? ` (${probe.version})` : ''}` : 'not found'}`);
      for (const path of result.created) console.log(`  created ${path}`);
      for (const notice of result.notices) console.log(`  ${notice}`);
      if (result.restartRequired) console.log('  restart required: managed host integration changed.');
      return 0;
    }
    case 'status': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('Use `fadeno status` without --grok; Grok steering is intentionally unsupported.');
      const result = runStatus({ verbose: values.verbose, target: target ?? null } as any);
      console.log(`Fadeno ${(result as any).version} · harness ${(result as any).harness ?? 'unknown'}`);
      console.log(`runtime: ${(result as any).runtime.invocationSource}; managed ${(result as any).runtime.managedVersion ?? 'not installed'}${(result as any).runtime.managedPath ? ` at ${(result as any).runtime.managedPath}` : ''}${(result as any).runtime.versionCurrent ? '' : ' (version skew)'}`);
      {
        const rt: any = (result as any).runtime;
        if (rt.skew) console.log(`skew: ${rt.skew}`);
        console.log(`use: ${rt.preferredCli}${rt.preferredReason ? ` (${rt.preferredReason})` : ''}`);
      }
      console.log(`session: Skills and subagents are loaded at host session start; a fresh session is required to refresh them — no setup or refresh will update the current session.`);
      console.log(`integrations: ${(result as any).runtime.installedHarnesses.join(', ') || 'none'}`);
      {
        const total = (result as any).definitions.playbooks.length;
        const fromProject = (result as any).definitions.projectPlaybooks;
        const origin = fromProject === 0 ? 'all bundled' : `${fromProject} from .fadeno/playbooks, ${total - fromProject} bundled`;
        console.log(`definitions: ${total} effective playbooks (${origin})`);
      }
      // New dial-based status: show per-role rows resolved through cascade
      const r: any = result as any;
      if (r.dials) {
        const d = r.dials as { session: Record<string, unknown>; repo: Record<string, unknown>; user: Record<string, unknown> };
        console.log(`dials: ${Object.keys(d.session).length} session, ${Object.keys(d.repo).length} repo, ${Object.keys(d.user).length} user`);
        for (const role of r.roles ?? []) console.log(`  ${role.archetype} → ${role.executor} (${role.adapter}) [${role.source ?? 'base'}]`);
      } else if (r.roles) {
        for (const role of r.roles) console.log(`  ${role.archetype} → ${role.executor} (${role.adapter})`);
      }
      if ((result as any).staleProjectPin) console.log(`stale project pin: ${(result as any).staleProjectPin}`);
      if ((result as any).staleUserPin) console.log(`stale user pin: ${(result as any).staleUserPin}`);
      if ((result as any).codexMaterialization) {
        const m = (result as any).codexMaterialization;
        const fix = m.fresh ? '' : `; run \`fadeno setup --codex\` then start a fresh Codex session`;
        console.log(`Codex managed agents: ${m.fresh ? 'current' : 'missing/stale'}${m.restartRequired ? ' (restart required)' : ''}${fix}`);
      }
      if ((result as any).next) console.log(`next: ${(result as any).next}`);
      if (values.verbose) console.log(JSON.stringify({ repoRoot: (result as any).repoRoot, paths: (result as any).definitions, roles: (result as any).roles }, null, 2));
      return 0;
    }
    case 'doctor': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('Use `fadeno doctor` without --grok; Grok steering is intentionally unsupported.');
      const result = runDoctor({ target: target ?? null });
      for (const item of result.findings) console.log(`${item.severity.padEnd(7)} ${item.check}: ${item.detail}${item.remediation ? ` — ${item.remediation}` : ''}`);
      return result.ok ? 0 : 1;
    }
    case 'vendor': {
      const target = requireTarget(values);
      const result = runVendor({
        target,
        withHooks: values['with-hooks'],
        withSteering: target !== 'grok' && !values['no-steering'],
        force: values.force,
      });
      console.log(`Fadeno vendored for ${result.target} in ${result.repoRoot}`);
      console.log(`  ${result.lock.status} fadeno.lock`);
      return 0;
    }
    case 'unvendor': {
      const result = runUnvendor({ force: values.force });
      for (const path of result.removed) console.log(`removed ${path}`);
      for (const path of result.preserved) console.log(`preserved modified ${path}`);
      if (!result.lockRemoved) console.log('fadeno.lock preserved because modified files remain.');
      return result.preserved.length === 0 ? 0 : 2;
    }
    case 'clean': {
      const result = runClean({ force: values.force });
      const paths = result.dryRun ? result.candidates : result.removed;
      for (const path of paths) console.log(`${result.dryRun ? 'would remove' : 'removed'} ${path}`);
      // Retention is otherwise invisible and unbounded, so a user about to
      // delete evidence sees what they are about to delete — on the dry run
      // as a preview, and on a --force run as what was actually deregistered.
      if (result.retainedShadowWorktrees.length > 0) {
        const count = result.retainedShadowWorktrees.length;
        console.log(
          `${count} retained shadow worktree${count === 1 ? '' : 's'} ` +
            `${result.dryRun ? 'would be deregistered and removed' : 'deregistered'}:`,
        );
        const shown = result.dryRun ? result.retainedShadowWorktrees : result.deregisteredShadowWorktrees;
        for (const path of shown) console.log(`  ${path}`);
      }
      if (result.dryRun && paths.length > 0) console.log('Re-run with --force to remove these ignored runtime files.');
      return 0;
    }
    case 'uninstall': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('Grok has no user-scoped Fadeno integration to uninstall.');
      const result = runUninstall({
        target: target ?? null,
        all: values.all,
        purgeUserData: values['purge-user-data'],
        force: values.force,
      });
      for (const path of result.removed) console.log(`removed ${path}`);
      for (const path of result.preserved) console.log(`preserved modified ${path}`);
      if (result.purged) console.log('purged Fadeno user configuration, state, and managed runtime.');
      return result.preserved.length === 0 ? 0 : 2;
    }
    case 'evidence': {
      if (positionals[1] !== 'promote' || !positionals[2]) throw new Error('Usage: fadeno evidence promote <run>');
      const result = runEvidencePromote({ run: positionals[2] });
      console.log(`verified evidence promoted: ${result.destination}`);
      console.log(`  ${result.files.length} immutable files; manifest ${result.manifest}`);
      return 0;
    }
    case 'init': {
      const target = requireTarget(values);
      const { repoRoot, results } = runInit({
        target,
        force: values.force,
        withHooks: values['with-hooks'],
        withSteering: values['with-steering'],
        noSteering: values['no-steering'],
        dataOnly: values['data-only'],
      });
      printInitSummary(
        target,
        repoRoot,
        results,
        Boolean(values['with-hooks']),
        Boolean(values['with-steering'] || (target !== 'grok' && !values['no-steering'])),
        Boolean(values['data-only']),
      );
      return 0;
    }
    case 'steering': {
      const sub = positionals[1];
      if (sub === 'resolve') {
        if (!values.archetype) {
          throw new Error(
            'Usage: fadeno steering resolve --archetype <name> [--host-executor <name>] [--role <name>] [--run <id> --dispatch-id <id>]',
          );
        }
        const result = runSteeringResolve({
          archetype: String(values.archetype),
          hostExecutor: values['host-executor'] != null ? String(values['host-executor']) : values['native-executor'] != null ? String(values['native-executor']) : undefined,
          role: values.role != null ? String(values.role) : undefined,
          run: values.run != null ? String(values.run) : undefined,
          dispatchId: values['dispatch-id'] != null ? String(values['dispatch-id']) : undefined,
          promptSha256: values['prompt-sha256'] != null ? String(values['prompt-sha256']) : undefined,
          promptFile: values['prompt-file'] != null ? String(values['prompt-file']) : undefined,
        });
        const steeringOut: Record<string, unknown> = {
          mode: result.mode,
          archetype: result.archetype,
          role: result.role,
          executor: result.executor,
          adapter: result.adapter,
          model: result.model,
          effort: result.effort ?? null,
          // The lane decision. `steering resolve` is a hook/script contract,
          // so a consumer that cannot see `lane` cannot route on effort at all.
          effort_pinned: result.effort_pinned,
          effective_effort: result.effective_effort,
          session_effort: result.session_effort,
          lane: result.lane,
          lane_reason: result.lane_reason,
          driver: result.driver,
          host_executor: result.hostExecutor,
          resolution: result.source,
          resolved_via: result.resolved_via ?? null,
          requested_agent_type: result.requested_agent_type ?? null,
          delivered_archetype: result.delivered_archetype ?? null,
          identity_evidence: result.identity_evidence ?? null,
          run: values.run ?? null,
          dispatch_id: values['dispatch-id'] ?? null,
          detail: result.detail,
          writeConflict: result.writeConflict ?? null,
          shadow: result.shadow ?? null,
          delegate_to: result.delegate_to ?? null,
        };
        console.log(JSON.stringify(steeringOut, null, 2));
        // A refused slot is not runnable here, same as a restart: non-zero, so
        // a caller that only checks the exit code still stops.
        return result.mode === 'restart_required' || result.mode === 'write_conflict' ? 2 : 0;
      }
      if (sub === 'apply') {
        const applyTarget = values.claude && !values.codex ? 'claude' : values.codex && !values.claude ? 'codex' : null;
        if (applyTarget == null || values.grok || positionals[2] != null) {
          throw new Error('Usage: fadeno steering apply --codex|--claude [--scope project|user] [--force]');
        }
        if (values.scope && values.scope !== 'project' && values.scope !== 'user') throw new Error('Invalid --scope. Use project or user.');
        if (applyTarget === 'claude') {
          const result = runSteeringApplyClaude({ target: 'claude', force: values.force, scope: values.scope as 'project' | 'user' | undefined });
          const changed = result.results.filter((item) => item.status !== 'skipped').length;
          console.log(`Claude steering materialized: ${result.scope}`);
          for (const archetype of ['judge', 'reviewer', 'worker']) {
            const slot = result.materialization[archetype]!;
            const how = slot.kind === 'host'
              ? slot.model === 'current-host'
                ? 'session baseline (no agent file)'
                : `in-session when the effort matches (model: ${slot.model})`
              : 'dispatch proxy (no agent file)';
            console.log(`  ${archetype} → ${how} ${slot.executor}`);
          }
          const removed = result.removed ?? [];
          for (const path of removed) console.log(`  removed managed agent: ${path}`);
          console.log(
            removed.length === 0
              ? '  Nothing to remove; effort selects the delivery lane, so no agent file carries an identity.'
              : `  Removed ${removed.length} managed agent definition(s). Effort now selects the lane, so nothing is written and no restart is needed.`,
          );
          const ignored = result.ignoredLocalDials ?? [];
          if (ignored.length > 0) {
            console.log(
              `  Ignored repo-local dial(s) for ${ignored.join(', ')}: a user-scope agent set steers every ` +
                'repo, so it is cut from user dials only. Use --scope project, or `fadeno dial <archetype> ' +
                '<model> --user` to make the choice global.',
            );
          }
          if (changed === 0 && result.conflicts.length > 0) console.log('  Existing files were preserved; pass --force to replace them.');
          return 0;
        }
        const result = runSteeringApply({ target: 'codex', force: values.force, scope: values.scope as 'project' | 'user' | undefined });
        const changed = result.results.filter((item) => item.status !== 'skipped').length;
        console.log(`Codex steering materialized: ${result.scope}`);
        for (const archetype of ['judge', 'reviewer', 'worker']) {
          const slot = result.materialization[archetype]!;
          if (slot.kind === 'write-conflict') {
            console.log(`  ${archetype} → refused (write conflict) ${slot.executor}: ${slot.writeConflict}`);
            continue;
          }
          console.log(
            `  ${archetype} → ${slot.kind === 'host' ? 'host agent' : 'command broker'} ${slot.executor}`,
          );
        }
        console.log(
          `  ${changed} agent definition(s) written; declared fallbacks work immediately, ` +
            'or start a fresh Codex session to deliver changed host slots in-session.',
        );
        const ignored = result.ignoredLocalDials ?? [];
        if (ignored.length > 0) {
          console.log(
            `  Ignored repo-local dial(s) for ${ignored.join(', ')}: a user-scope agent set steers every ` +
              'repo, so it is cut from user dials only. Use --scope project, or `fadeno dial <archetype> ' +
              '<model> --user` to make the choice global.',
          );
        }
        if (changed === 0) console.log('  Existing files were preserved; pass --force to replace them.');
        return 0;
      }
      throw new Error('Usage: fadeno steering resolve|apply [...]');
    }
    case 'validate': {
      if (values.schema && !SCHEMA_KINDS.includes(values.schema as SchemaKind)) {
        throw new Error(`Invalid --schema "${values.schema}". Use: ${SCHEMA_KINDS.join(', ')}.`);
      }
      const outcome = runValidate({
        path: positionals[1],
        schema: values.schema as SchemaKind | undefined,
      });
      printValidate(outcome);
      return outcome.ok ? 0 : 1;
    }
    case 'diagram': {
      const playbook = positionals[1];
      if (!playbook) throw new Error('Usage: fadeno diagram <playbook> [--format ascii|mermaid]');
      if (values.format && values.format !== 'ascii' && values.format !== 'mermaid') {
        throw new Error(`Invalid --format "${values.format}". Use: ascii | mermaid.`);
      }
      console.log(runDiagram({ playbook, format: values.format as DiagramFormat | undefined }));
      return 0;
    }
    case 'new-run': {
      const [, playbook, task] = positionals;
      if (!playbook || !task) {
        throw new Error('Usage: fadeno new-run <playbook> "<task description>"');
      }
      const { runId, runDir, inputs, resolution } = (runNewRun as any)({
        playbook,
        task,
        inputs: values.input,
      });
      console.log(`Created run ${runId}`);
      console.log(`  ${runDir}`);
      if (inputs.length > 0) console.log(`  inputs: ${inputs.join(', ')}`);
      if (resolution != null && (resolution as any).echo?.length > 0) {
        console.log(`\nresolution:`);
        const lines = (resolution as any).echo as string[];
        for (const line of withLaneLabels(lines, (resolution as any).roles)) console.log(`  ${line}`);
      }
      console.log('\nAdvance it with `fadeno drive` first (engine):');
      console.log(`  fadeno drive ${runId}`);
      console.log(`\nOr advance manually with the playbook cursor:`);
      console.log(`  fadeno next ${runId}`);
      console.log(`  fadeno run ${runId} --step <step-id>`);
      console.log(`  fadeno run ${runId} --status completed`);
      return 0;
    }
    case 'run': {
      const run = positionals[1];
      if (!run) throw new Error('Usage: fadeno run <run> [--step|--status|--event|--artifact|--member|--field]');
      const result = runRun({
        run,
        step: values.step,
        status: values.status,
        event: values.event,
        artifact: values.artifact,
        member: values.member,
        fields: values.field,
      });
      const parts: string[] = [];
      if (result.updatedFields.length) parts.push(`updated ${result.updatedFields.join(', ')}`);
      if (result.appendedEvents.length) parts.push(`logged ${result.appendedEvents.join(', ')}`);
      console.log(`${relative(process.cwd(), result.runDir) || result.runDir}: ${parts.join('; ')}`);
      if (result.manifest) {
        const v = result.manifest.validation;
        const note = v.schema ? `, ${v.schema}: ${v.ok ? 'valid' : 'INVALID'}` : '';
        console.log(
          `  ${result.manifest.artifact_id}  sha256 ${result.manifest.sha256.slice(0, 12)}…  ` +
            `gen ${result.manifest.generation}${note}`,
        );
      }
      return 0;
    }
    case 'tool-run': {
      const run = positionals[1];
      if (!run) {
        throw new Error('Usage: fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]');
      }
      // No --command escape hatch
      if (values.output != null) {
        throw new Error('fadeno tool-run has no --output; it executes the registered tool and synthesizes the artifact.');
      }
      const result = runToolRun({ run, tool: values.tool, timeout: values.timeout });
      // Print the path of the artifact that was actually written: `run` may be a
      // unique prefix, so only the resolved run id names a directory on disk.
      const repoRoot = findRepoRoot();
      const runDir = join(repoRoot, '.fadeno', 'runs', result.run);
      const absArtifact = join(runDir, result.artifact);
      const rel = relative(process.cwd(), absArtifact) || absArtifact;
      console.log(`${rel}: tool ${result.tool} → ${result.status} (exit ${result.exitCode ?? 'null'})`);
      console.log(`  attempt ${result.attempt} duration ${result.durationMs ?? 0}ms`);
      // CLI success after honestly recording either passed or failed; gate decides branch. Infra failures remain errors.
      return result.status === 'passed' || result.status === 'failed' ? 0 : 1;
    }
    case 'tool-complete': {
      const run = positionals[1];
      if (!run || !values.output) {
        throw new Error('Usage: fadeno tool-complete <run> --output <artifact-path>');
      }
      const result = runToolComplete({ run, output: values.output });
      console.log(`${relative(process.cwd(), result.runDir) || result.runDir}: completed tool step ${result.step}`);
      if (result.manifest) {
        const validation = result.manifest.validation;
        const note = validation.schema ? `, ${validation.schema}: ${validation.ok ? 'valid' : 'INVALID'}` : '';
        console.log(
          `  ${result.manifest.artifact_id}  sha256 ${result.manifest.sha256.slice(0, 12)}…  ` +
            `gen ${result.manifest.generation}${note}`,
        );
      }
      return 0;
    }
    case 'plugin': {
      if (values.grok) {
        throw new Error('The --grok target is supported by init only; no Grok plugin generator exists.');
      }
      const codex = Boolean(values.codex);
      const { outDir, results } = codex
        ? runCodexPlugin({ outDir: positionals[1], force: values.force })
        : runPlugin({ outDir: positionals[1], force: values.force });
      const counts = { created: 0, overwritten: 0, appended: 0, skipped: 0 };
      for (const r of results) counts[r.status] += 1;
      console.log(`Generated Fadeno ${codex ? 'Codex' : 'Claude Code'} plugin in ${outDir}`);
      console.log(`  ${counts.created} created, ${counts.overwritten} overwritten, ${counts.skipped} skipped.`);
      if (codex) {
        // Marketplace root is the repo root (where .agents/plugins/marketplace.json
        // lives), not the plugin dir — pass `.`, not the payload path.
        console.log('\nTest it: `codex plugin marketplace add . && codex plugin add fadeno@fadeno`');
      } else {
        console.log('\nTest it: `claude --plugin-dir ' + relative(process.cwd(), outDir) + '`');
      }
      return 0;
    }
    case 'completion': {
      if (positionals[1] !== 'bash' || positionals.length > 2) {
        throw new Error('Usage: fadeno completion bash');
      }
      process.stdout.write(runCompletion());
      return 0;
    }
    case 'gate': {
      const [, run, condition] = positionals;
      if (!run || !condition) throw new Error('Usage: fadeno gate <run> <condition>');
      const result = runGate({ run, condition, artifact: values.artifact, report: values.report });
      if (result.pass) {
        if (result.condition === 'tests_pass') {
          console.log(`PASS  ${result.condition} (status=${String(result.details.status)}, exit_code=${String(result.details.exitCode)})`);
        } else if (result.condition === 'all_reviews_approved') {
          const total = typeof result.details.total === 'number' ? result.details.total : result.blockingCount;
          const approved = typeof result.details.approvedCount === 'number' ? result.details.approvedCount : total;
          console.log(`PASS  ${result.condition} (${approved}/${total} approved, 0 blocking)`);
        } else {
          console.log(`PASS  ${result.condition} (0 blocking issues)`);
        }
      } else {
        if (result.condition === 'tests_pass') {
          console.error(`FAIL  ${result.condition} (status=${String(result.details.status)}, exit_code=${String(result.details.exitCode)})`);
        } else if (result.condition === 'all_reviews_approved') {
          const total = typeof result.details.total === 'number' ? result.details.total : result.blockingCount;
          const approved = typeof result.details.approvedCount === 'number' ? result.details.approvedCount : 0;
          const blocking = typeof result.details.blockingCount === 'number' ? result.details.blockingCount : result.blockingTitles.length;
          console.error(`FAIL  ${result.condition} (${approved}/${total} approved, ${blocking} blocking)`);
          const nonApproving = Array.isArray(result.details.nonApproving) ? result.details.nonApproving as Array<{ reviewer: string; verdict: string }> : [];
          for (const entry of nonApproving) {
            if (typeof entry.reviewer === 'string' && typeof entry.verdict === 'string') {
              console.error(`        - ${entry.reviewer}: ${entry.verdict}`);
            }
          }
          for (const title of result.blockingTitles) console.error(`        - blocking: ${title}`);
        } else {
          console.error(`FAIL  ${result.condition} (${result.blockingCount} blocking issue(s))`);
          for (const title of result.blockingTitles) console.error(`        - ${title}`);
        }
      }
      return result.pass ? 0 : 1;
    }
    case 'prompt': {
      const [, run, step] = positionals;
      if (!run || !step) {
        throw new Error('Usage: fadeno prompt <run> <step> [--actor <role>] [--iteration <n>] [--inline] [--no-record] [--format text|json]');
      }
      if (values.format && values.format !== 'text' && values.format !== 'json') {
        throw new Error(`Invalid --format "${values.format}". Use: text | json.`);
      }
      let iteration: number | undefined;
      if (values.iteration != null) {
        const n = Number(values.iteration);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`Invalid --iteration "${values.iteration}". Use a positive integer.`);
        }
        iteration = n;
      }
      const result = runPrompt({
        run,
        step,
        actor: values.actor,
        iteration,
        inline: values.inline,
        record: !values['no-record'],
      });
      if (values.format === 'json') {
        console.log(
          JSON.stringify(
            {
              step,
              actor: result.plan.actor,
              iteration: result.plan.iteration,
              invocation: result.plan.invocation,
              recorded: result.recorded,
              prompt_path: result.promptPath,
              sha256: result.sha256,
              prompt: result.prompt,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(result.prompt);
      }
      return 0;
    }
    case 'next': {
      const run = positionals[1];
      if (!run) throw new Error('Usage: fadeno next <run>');
      const result = runNext({ run, legacy: values.legacy });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case 'drive': {
      const run = positionals[1];
      if (!run) throw new Error('Usage: fadeno drive <run> [--bind role=executor] [--max-transitions n] [--parallel n] [--diagnostics] [--timeout <seconds>]');
      let maxTransitions: number | undefined;
      if (values['max-transitions'] != null) {
        const n = Number(values['max-transitions']);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`Invalid --max-transitions "${values['max-transitions']}". Use a positive integer.`);
        }
        maxTransitions = n;
      }
      let parallel: number | undefined;
      if (values.parallel != null) {
        const n = Number(String(values.parallel).trim());
        if (!Number.isInteger(n) || n < DRIVE_PARALLEL_MIN || n > DRIVE_PARALLEL_MAX) {
          throw new Error(`Invalid --parallel "${values.parallel}". Use an integer ${DRIVE_PARALLEL_MIN}–${DRIVE_PARALLEL_MAX} (default ${DRIVE_PARALLEL_DEFAULT}).`);
        }
        parallel = n;
      }
      let timeoutMs: number | null | undefined;
      if (values.timeout != null) {
        if (!/^\d+$/.test(String(values.timeout).trim())) {
          throw new Error(`Invalid --timeout "${values.timeout}". Use a non-negative integer seconds (0 disables the route deadline).`);
        }
        const sec = Number(String(values.timeout).trim());
        if (!Number.isInteger(sec) || sec < 0) {
          throw new Error(`Invalid --timeout "${values.timeout}". Use a non-negative integer seconds (0 disables the route deadline).`);
        }
        timeoutMs = sec === 0 ? 0 : sec * 1000;
      }
      const result = (runDrive as any)({
        run,
        bind: values.bind,
        maxTransitions,
        parallel,
        timeoutMs,
        diagnostics: Boolean(values.diagnostics),
        onAction: (line: string) => console.log(`  ${line}`),
      });
      return printDrive(result);
    }
    case 'cancel': {
      const run = positionals[1];
      if (!run) throw new Error('Usage: fadeno cancel <run> [--actor-call <id>]');
      try {
        const result = runCancel({ run, actorCallId: (values as any)['actor-call'] ?? null });
        const by = result.resolvedBy === 'supervisor' ? 'supervisor' : result.resolvedBy === 'process_group' ? `process group ${-result.signalledPid}` : `executor ${result.signalledPid}`;
        console.log(`cancel signalled: ${result.run} ${result.actorCallId}:a${result.attempt} — SIGTERM to ${by} (pid ${result.signalledPid})`);
        console.log(`  supervisor_pid=${result.supervisorPid} process_group_id=${result.processGroupId ?? '—'} signalled_pid=${result.signalledPid} resolved_by=${result.resolvedBy}`);
        console.log('  the executor and its children are being reaped; the engine will record the terminal receipt.');
        console.log('  check the workspace before re-dispatching — a cancelled executor may have written already.');
        return 0;
      } catch (err) {
        if (err instanceof CancelError) {
          console.error(`Error: ${err.message}`);
          return 1;
        }
        throw err;
      }
    }
    case 'models': {
      if (values.driver != null) {
        if (positionals.length > 1) throw new Error('Usage: fadeno models --driver <alias>  (no positional with --driver)');
        const result = runModelsDriver({ driver: values.driver });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelsDriver(result);
        return 0;
      }
      if (positionals.length > 2) throw new Error('Usage: fadeno models [<name>] [--driver <alias>] [--json]');
      const result = runModels({});
      const name = positionals[1];
      if (values.json) {
        console.log(JSON.stringify(name != null ? { ...result, models: result.models.filter((r) => r.name === name) } : result, null, 2));
        return 0;
      }
      if (name != null) printModelDetail(result, name);
      else printModels(result);
      return 0;
    }
    case 'dial': {
      const RESERVED = new Set(['clear', 'shadow', 'clear-shadow', 'resolve']);
      const sub = positionals[1];
      if (sub == null) {
        const result = runDialShow({});
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printDialShow(result);
        return 0;
      }
      if (sub === 'clear') {
        if (positionals.length > 3) throw new Error('Usage: fadeno dial clear [<archetype>] [--session|--user|--repo]');
        const archetype = positionals[2] ?? null;
        const result = runDialClear({ archetype, session: Boolean(values.session), user: Boolean(values.user), repo: Boolean(values.repo) });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        if (result.archetype == null) {
          if (result.removed) {
            const layers = result.cleared_layers;
            const detail = layers != null && (layers.session > 0 || layers.user > 0)
              ? ` (${[layers.session > 0 ? `${layers.session} session` : null, layers.user > 0 ? `${layers.user} user` : null].filter(Boolean).join(', ')})`
              : '';
            console.log(`cleared ${result.count ?? 0} dial(s)${detail}`);
          } else {
            console.log('no dials to clear');
          }
          if ((result.repo_pins_remaining?.length ?? 0) > 0) {
            console.log(`repo pins remain (committed): ${result.repo_pins_remaining!.join(', ')} — remove per archetype with \`fadeno dial clear <archetype> --repo\``);
          }
          return 0;
        }
        if (!result.removed) {
          if (result.livesAt === 'repo') {
            console.log(`no session dial for ${result.archetype}; ${result.archetype} is repo-pinned — 'fadeno dial clear ${result.archetype} --repo' to remove it (repo pins are committed config, never cleared implicitly)`);
          } else {
            console.log(`no dial for ${result.archetype} at any layer — nothing to clear`);
          }
          return 0;
        }
        console.log(`cleared ${result.archetype} (${result.cleared})${result.inferred ? ' [user default — the only layer holding a dial]' : ''}`);
        return 0;
      }
      if (sub === 'clear-shadow') {
        if (positionals.length > 3) throw new Error('Usage: fadeno dial clear-shadow [<archetype>]');
        const archetype = positionals[2] ?? null;
        const result = runDialClearShadow({ archetype });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        if (result.archetype == null) {
          console.log(result.removed ? `cleared ${result.count} shadow attachment(s)` : 'no shadow attachments to clear (.fadeno/local/dials)');
          return 0;
        }
        console.log(`cleared shadow attachment: ${result.archetype} (was ${result.cleared!.model});`);
        return 0;
      }
      if (sub === 'shadow') {
        const shadowUsage = 'Usage: fadeno dial shadow [<archetype> <model>[@effort] [--via <driver>] [--rate <n>]]';
        if (positionals.length > 4) throw new Error(shadowUsage);
        const archetype = positionals[2];
        const model = positionals[3];
        if (archetype != null && model == null) throw new Error(shadowUsage);
        return runShadowCommand(archetype, model, { via: values.via ?? null, rate: values.rate, json: Boolean(values.json) });
      }
      if (sub === 'resolve') {
        if (!values.archetype) throw new Error('Usage: fadeno dial resolve --archetype <name> [--prompt-sha256 <hex>]');
        if (positionals.length > 2) throw new Error('Usage: fadeno dial resolve --archetype <name>');
        const result = runDialResolve({ archetype: values.archetype, promptSha256: values['prompt-sha256'] ?? null });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      // Otherwise treat as archetype: either show single row or set
      // Reject reserved words and 'set' for grammar sanity
      if (RESERVED.has(sub) || sub === 'set') {
        // This branch should be unreachable because RESERVED already handled, but 'set' still needs refusal
        throw new Error(`archetype "${sub}" is a reserved word — rename the archetype`);
      }
      if (positionals.length === 2) {
        // Single-archetype view
        const archetype = sub;
        const result = runDialShow({});
        const row = result.rows.find((r) => r.archetype === archetype);
        const shadow = result.shadow_attachments[archetype] ?? undefined;
        // Filter to one row
        const filtered = {
          ...result,
          rows: row ? [row] : [],
          shadows: shadow ? { [archetype]: result.shadows[archetype]! } : {},
          shadow_attachments: shadow ? { [archetype]: shadow } : {},
          staleShadows: result.staleShadows.filter((s) => s.archetype === archetype),
          staleDials: result.staleDials.filter((s) => s.archetype === archetype),
          dials: {
            session: Object.hasOwn(result.dials.session, archetype) ? { [archetype]: result.dials.session[archetype]! } : {},
            repo: Object.hasOwn(result.dials.repo, archetype) ? { [archetype]: result.dials.repo[archetype]! } : {},
            user: Object.hasOwn(result.dials.user, archetype) ? { [archetype]: result.dials.user[archetype]! } : {},
          },
        };
        if (values.json) {
          console.log(JSON.stringify(filtered, null, 2));
          return 0;
        }
        // Reuse printer on filtered result
        printDialShow(filtered as any);
        return 0;
      }
      if (positionals.length >= 3) {
        // Set: every positional but the last names archetypes (space, `+`,
        // and `,` separated all work); the last is the model.
        const model = positionals[positionals.length - 1]!;
        const archetypes = positionals
          .slice(1, -1)
          .flatMap((token) => token.split(/[+,]/))
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        const results = runDialSetMany({ archetypes, model, via: values.via ?? null, session: Boolean(values.session), user: Boolean(values.user), repo: Boolean(values.repo) });
        if (values.json) {
          console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
          return 0;
        }
        for (const result of results) {
          console.log(result.narrative);
          for (const note of result.notes) {
            if (note.startsWith('WARNING:')) console.error(note);
            else console.log(note);
          }
        }
        return 0;
      }
      throw new Error('Usage: fadeno dial [<archetype> [<model>[@effort] [--via <driver>] [--session|--user|--repo]] | clear [<archetype>] [--session|--user|--repo] | shadow [<archetype> <model>[@effort] [--via <driver>] [--rate <n>]] | clear-shadow [<archetype>] | resolve --archetype <name>]');
    }
    // Top-level alias for `fadeno dial shadow ...` — same handler
    // (`runShadowCommand`) as the `dial` subcommand above, so the two
    // spellings cannot drift apart.
    case 'shadow': {
      const shadowUsage = 'Usage: fadeno shadow [<archetype> <model>[@effort] [--via <driver>] [--rate <n>]]';
      if (positionals.length > 3) throw new Error(shadowUsage);
      const archetype = positionals[1];
      const model = positionals[2];
      if (archetype != null && model == null) throw new Error(shadowUsage);
      return runShadowCommand(archetype, model, { via: values.via ?? null, rate: values.rate, json: Boolean(values.json) });
    }
    case 'dispatch': {
      const promptFile = values['prompt-file'];
      let dispatchTimeoutMs: number | null | undefined;
      if (values.timeout != null) {
        if (!/^\d+$/.test(String(values.timeout).trim())) {
          throw new Error(`Invalid --timeout "${values.timeout}". Use a non-negative integer seconds (0 disables the route deadline).`);
        }
        const sec = Number(String(values.timeout).trim());
        if (!Number.isInteger(sec) || sec < 0) {
          throw new Error(`Invalid --timeout "${values.timeout}". Use a non-negative integer seconds (0 disables the route deadline).`);
        }
        dispatchTimeoutMs = sec === 0 ? 0 : sec * 1000;
      }
      const result = (runDispatch as any)({
        archetype: values.archetype,
        role: values.role,
        model: values.model ?? null,
        via: values.via ?? null,
        tag: values.tag,
        shadow: values.shadow,
        timeoutMs: dispatchTimeoutMs,
        isolate: Boolean(values.isolate),
        shared: Boolean(values.shared),
        ignoredOutput: ((): 'kept' | 'discardable' | null => {
          const raw = values['ignored-output'];
          if (typeof raw !== 'string') return null;
          const trimmed = raw.trim();
          if (trimmed === 'kept' || trimmed === 'discardable') return trimmed;
          throw new Error(`--ignored-output must be "kept" or "discardable"; got "${raw}"`);
        })(),
        diagnostics: Boolean(values.diagnostics),
        noBrief: Boolean(values['no-brief']),
        promptFile,
        prompt: promptFile == null ? readFileSync(0, 'utf8') : undefined,
        onEcho: (line: string) => console.error(line),
      });
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) {
        // CLI-level diagnosis on stderr — a quiet executor otherwise leaves
        // only a bare exit code. stdout stays the executor's pure report.
        console.error(`dispatch: executor ${result.executor} exited ${result.exitCode}`);
      } else if (result.outcome === 'empty') {
        // Exit 0 and nothing written is not a success anyone can use: it is
        // what an unusable model id, or a worker that stopped after
        // backgrounding its real work, looks like from out here. Say so and
        // fail, rather than hand the caller an empty report to relay.
        console.error(
          `dispatch: executor ${result.executor} exited 0 but produced no output — ` +
            `nothing was relayed. Check the executor's own stderr above, and that ` +
            `its model id resolves (fadeno dial resolve --archetype <archetype>).`,
        );
        return 1;
      }
      return result.exitCode;
    }
    case 'dispatch-fallback': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId) throw new Error('Usage: fadeno dispatch-fallback <run> <dispatch-id>');
      const result = runDispatchFallback({
        run,
        dispatchId,
        onEcho: (line) => console.error(line),
      });
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) console.error(`dispatch-fallback: executor ${result.executor} exited ${result.exitCode}`);
      return result.exitCode;
    }
    case 'dispatch-start': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId || !values['agent-id']) {
        throw new Error('Usage: fadeno dispatch-start <run> <dispatch-id> --agent-id <host-agent-id> [--workspace <path>] [--branch <branch>]');
      }
      const result = runDispatchStart({
        run,
        dispatchId,
        agentId: values['agent-id'],
        workspace: values.workspace,
        branch: values.branch,
      });
      console.log(`${result.dispatchId} started${result.idempotent ? ' (idempotent)' : ''}`);
      return 0;
    }
    case 'dispatch-prompt': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId) throw new Error('Usage: fadeno dispatch-prompt <run> <dispatch-id>');
      const result = runDispatchPrompt({ run, dispatchId });
      process.stdout.write(result.envelope);
      return 0;
    }
    case 'dispatch-complete': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId || !values.output) {
        throw new Error('Usage: fadeno dispatch-complete <run> <dispatch-id> --output <temporary-file> [--commit <sha>] (use --output - for stdin)');
      }
      let stdinBytes: Buffer | undefined;
      if (values.output === '-') {
        // Binary-safe stdin read for --output -; host-dispatch's complete path uses same validation/placement as a temp file
        try {
          stdinBytes = readFileSync(0);
        } catch (err) {
          throw new Error(`failed to read stdin for --output -: ${(err as Error).message}`);
        }
      }
      const result = runDispatchComplete({ run, dispatchId, output: String(values.output), commit: values.commit != null ? String(values.commit) : undefined, stdinBytes });
      console.log(`${result.dispatchId} completed${result.idempotent ? ' (idempotent)' : ''}`);
      return 0;
    }
    case 'dispatch-progress': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId || !values.file) {
        throw new Error('Usage: fadeno dispatch-progress <run> <dispatch-id> --file <status.json> [--source agent|harness|director]');
      }
      if (values.source && !['agent', 'harness', 'director'].includes(values.source)) {
        throw new Error(`Invalid --source "${values.source}". Use: agent | harness | director.`);
      }
      const result = runDispatchProgress({
        run,
        dispatchId,
        file: values.file,
        source: values.source as DispatchProgressSource | undefined,
      });
      console.log(
        `${result.dispatchId} progress: ${result.state} (${result.source})${result.idempotent ? ' (idempotent)' : ''}`,
      );
      return 0;
    }
    case 'dispatch-prepare': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId) throw new Error('Usage: fadeno dispatch-prepare <run> <dispatch-id> --isolate');
      const result = runDispatchPrepare({ run, dispatchId, isolate: Boolean(values.isolate) });
      console.log(`${result.dispatchId} prepared isolated at ${result.workspace} (base ${result.baseCommit.slice(0, 8)})${result.idempotent ? ' (idempotent)' : ''}`);
      return 0;
    }
    case 'dispatch-fail': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId || !values.reason) {
        throw new Error('Usage: fadeno dispatch-fail <run> <dispatch-id> --reason <text>');
      }
      const result = runDispatchFail({ run, dispatchId, reason: values.reason });
      console.log(`${result.dispatchId} failed${result.idempotent ? ' (idempotent)' : ''}`);
      return 0;
    }
    case 'decide': {
      const [, run, option] = positionals;
      if (!run || !option) {
        throw new Error('Usage: fadeno decide <run> <option> [--decision <id>] [--feedback <text>]');
      }
      const result = runDecide({ run, option, decision: values.decision, feedback: values.feedback });
      if (result.recorded === 'idempotent') {
        console.log(`${result.decisionId} was already resolved as "${result.option}" (idempotent, nothing recorded).`);
      } else {
        console.log(`${result.decisionId} resolved: ${result.option}${result.step ? `  (step ${result.step})` : ''}`);
        console.log(`Resume with \`fadeno drive ${result.run}\`.`);
      }
      return 0;
    }
    case 'runs': {
      const { runs } = runRuns();
      printRuns(runs);
      return 0;
    }
    case 'attest': {
      if (!values.archetype) {
        throw new Error('Usage: fadeno attest --archetype <a>');
      }
      const result = runAttest({ archetype: String(values.archetype) });
      const effortNote = result.effortEvidence === 'measured'
        ? `effort ${result.effort}`
        : 'effort unavailable (CLAUDE_EFFORT not set)';
      console.log(
        `attested: ${result.archetype} — ${effortNote}, pid ${result.pid}, identity_evidence: ${result.identityEvidence}`,
      );
      console.log(`  recorded in .fadeno/dispatches.jsonl (fadeno ${result.fadenoVersion})`);
      return 0;
    }
    case 'dispatches': {
      if (values.bakeoffs) {
        const result = runDispatchesBakeoffs({});
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        for (const line of result.lines) console.log(line);
        return 0;
      }
      if (values.cancel != null) {
        const inline = values.cancel.startsWith('tag:') ? values.cancel.slice(4) : null;
        const result = runDispatchesCancel({
          dispatchId: inline != null ? '' : values.cancel,
          tag: inline ?? values.tag,
        });
        const how = result.resolvedBy === 'tag' ? ` (tag: ${result.tag})` : '';
        console.log(`cancel signalled: ${result.dispatchId.slice(0, 8)}${how} — SIGTERM to supervisor ${result.pid}`);
        // Say what was and was not settled. The executor's process group is
        // being reaped now; the kernel writes the completion row when its
        // spawn returns, and only the workspace can say how far the work got.
        console.log('  the executor and its children are being reaped; the kernel records the completion row.');
        console.log('  check the workspace before re-dispatching — a cancelled executor may have written already.');
        return 0;
      }
      if (values.output != null) {
        // `--wait` in seconds: the number a caller reaches for after a
        // ten-minute timeout is "another minute", not "60000".
        let waitMs = 0;
        if (values.wait != null) {
          const seconds = values.wait === '' ? 120 : Number(values.wait);
          if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error(`Invalid --wait "${values.wait}". Use seconds (a non-negative number).`);
          }
          waitMs = Math.round(seconds * 1000);
        }
        // Two spellings on purpose. `--tag <handle>` is the natural one, but it
        // cannot stand alone: `--output` takes a value, so `--output --tag x`
        // would swallow the flag. `--output tag:<handle>` is the single-token
        // form that always parses — and it is the one the proxy guard permits,
        // because a caller recovering from a timeout should not also have to
        // get flag ordering right.
        const inline = values.output.startsWith('tag:') ? values.output.slice(4) : null;
        const result = runDispatchesOutput({
          dispatchId: inline != null ? '' : values.output,
          tag: inline ?? values.tag,
          waitMs,
        });
        // stdout carries the snapshot bytes verbatim (relay-safe); the
        // attestation verdict goes to stderr so piping stays clean.
        process.stdout.write(result.bytes);
        const note =
          result.attested === 'match'
            ? 'output attested: sha matches the completion row'
            : result.attested === 'mismatch'
              ? 'WARNING: snapshot sha does not match the completion row (file changed after the dispatch?)'
              : waitMs > 0
                ? `STILL RUNNING: no completion row after waiting ${Math.round(waitMs / 1000)}s. ` +
                  'The executor has not exited; this is its output so far. Not a failure — ' +
                  're-run this command to check again.'
                : 'no completion row recorded YET: the executor may still be running, and the ' +
                  'kernel writes that row only when it exits. This is its output so far, not a ' +
                  'failure. Re-run with --wait <seconds> to wait for the real answer.';
        // Say how `last` landed. Recency now only survives when nothing
        // overlapped this dispatch — concurrent-and-finished refuses outright —
        // so the note reports that narrowed claim rather than a bare warning.
        const how =
          result.resolvedBy === 'recency'
            ? ' [resolved by recency: nothing was open and nothing overlapped it, so this is the ' +
              'only candidate — launch with `--tag <handle>` to name it outright]'
            : result.resolvedBy === 'tag'
              ? ' [resolved by tag]'
              : '';
        console.error(`[${result.dispatchId}] ${result.path} — ${note}${how}`);
        return 0;
      }
      let tail: number | undefined;
      if (values.tail != null) {
        const n = Number(values.tail);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`Invalid --tail "${values.tail}". Use a positive integer.`);
        }
        tail = n;
      }
      const result = runDispatches({ tail });
      if (values.json) {
        console.log(
          JSON.stringify(
            {
              path: result.path,
              total: result.total,
              shown: result.entries.length,
              skipped: result.skipped,
              skippedNewerFormat: result.skippedNewerFormat,
              entries: result.entries,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      printDispatches(result);
      return 0;
    }
    case 'shadow-apply': {
      const ref = positionals[1];
      if (!ref) {
        throw new Error('Usage: fadeno shadow-apply <pair-id|dispatch-id> [--arm challenger|primary] [--check]');
      }
      const result = runShadowApply({ ref, arm: values.arm, check: Boolean(values.check) });
      const pairId8 = result.pairId.slice(0, 8);
      const dispatchId8 = result.dispatchId ? result.dispatchId.slice(0, 8) : '(unknown)';
      const bytes = result.diffBytes != null ? ` (${result.diffBytes} bytes)` : '';
      if (result.check) {
        console.log(
          `pair ${pairId8} ${result.arm} arm (dispatch ${dispatchId8}): ` +
            `${result.clean ? 'would apply cleanly' : 'would NOT apply cleanly'} — ${result.artifact}${bytes}`,
        );
        if (!result.clean) console.log(`  ${result.detail}`);
        return result.clean ? 0 : 1;
      }
      console.log(
        `applied pair ${pairId8}'s ${result.arm} diff (dispatch ${dispatchId8})${bytes} from ${result.artifact} ` +
          '— evidence recorded.',
      );
      return 0;
    }
    case 'bakeoff': {
      const ref = positionals[1];
      const usage =
        'Usage: fadeno bakeoff <pair-id|dispatch-id> [--measure-only] [--judge <ref>] [--via <driver>] [--evidence inlined|explored]\n' +
        '   or: fadeno bakeoff <pair-id|dispatch-id> --prepare [--evidence inlined|explored]\n' +
        '   or: fadeno bakeoff <pair-id|dispatch-id> --record --comparison <file> --adversarial <file> [--evidence inlined|explored]';
      if (!ref) throw new Error(usage);
      // Rejected here rather than defaulted: a typo'd `--evidence explored`
      // that silently fell back to `inlined` would stamp the artifact with a
      // mode the caller did not choose, which is the one thing this field
      // exists to make legible.
      const evidence = ((): EvidenceMode | undefined => {
        if (values.evidence == null) return undefined;
        if (isEvidenceMode(values.evidence)) return values.evidence;
        throw new Error(`--evidence must be one of: ${EVIDENCE_MODES.join(', ')} (got "${values.evidence}")`);
      })();
      if (values.prepare) {
        const result = runBakeoffPrepare({ ref, evidence });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        printBakeoffPrepare(result);
        return 0;
      }
      if (values.record) {
        if (!values.comparison || !values.adversarial) throw new Error(usage);
        const result = runBakeoffRecord({ ref, comparisonPath: values.comparison, adversarialPath: values.adversarial, evidence });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        printBakeoff(result);
        return 0;
      }
      const result = runBakeoff({
        ref,
        measureOnly: Boolean(values['measure-only']),
        judgeModel: values.judge ?? null,
        judgeVia: values.via ?? null,
        evidence,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      printBakeoff(result);
      return 0;
    }
    case 'show': {
      const run = positionals[1];
      if (!run) throw new Error('Usage: fadeno show <run> [--events] [--legacy]');
      const result = runShow({ run, legacy: values.legacy });
      printShow(findRepoRoot(), result, Boolean(values.events));
      return 0;
    }
    case 'verify': {
      const result = runVerify({
        run: positionals[1],
        latest: values.latest,
        allowFailed: values['allow-failed'],
        legacy: values.legacy,
      });
      printVerify(result);
      return result.ok ? 0 : 1;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 1;
  }
}

const _isMain = (() => {
  try {
    if ((import.meta as any).main) return true;
  } catch {}
  const a1 = process.argv[1];
  if (!a1) return false;
  return a1.endsWith('src/cli.ts') || a1.endsWith('dist/cli.js') || a1.endsWith('/fadeno') || a1.endsWith('/fadeno.cmd') || a1.endsWith('/fadeno.js');
})();
if (_isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

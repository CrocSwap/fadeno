#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
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
  runDispatchesComparisons,
  runDispatchesOutput,
  type DispatchesResult,
} from './commands/dispatches.ts';
import { runDiagram } from './commands/diagram.ts';
import { DRIVE_PARALLEL_DEFAULT, DRIVE_PARALLEL_MAX, DRIVE_PARALLEL_MIN, runDrive, type DriveResult } from './commands/drive.ts';
import { runGate } from './commands/gate.ts';
import { runInit, type Target } from './commands/init.ts';
import {
  formatShadowLine,
  runDialClear,
  runDialSetMany,
  runDialClearShadow,
  runDialResolve,
  runDialShadow,
  runDialShow,
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
import { runCompletion, runCompletionCandidates } from './commands/completion.ts';
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
  fadeno dial <archetype>[+<archetype>…] <model>[@effort] [--via <driver>] [--session|--user|--repo] [--force]   # set (multi: a+b, a,b, or a b c)
  fadeno dial clear [<archetype>] [--session|--user|--repo]
  fadeno dial shadow <archetype> <model>[@effort] [--via <driver>] [--rate <r>]
  fadeno dial clear-shadow [<archetype>]
  fadeno dial resolve --archetype <a>          # JSON, hook contract unchanged
  fadeno models [<name>]                Model registry + frame-neutral harness identities
  fadeno models --driver <alias>        Live backend model listing (routes with models_command)
  fadeno steering resolve|apply [...]   Resolve or materialize hybrid Codex steering
  fadeno dispatch [flags]               Resolve archetype → executor and invoke it once (ad hoc)
                                        (--shadow <executor> duplicates it to a one-shot challenger)
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
  fadeno dispatches [--tail n] [--json] Show which executor ran what (.fadeno/dispatches.jsonl)
  fadeno dispatches --cancel <id|tag:h> Stop a running dispatch (SIGTERM to its executor group)
  fadeno dispatches --output <id|last> [--wait <s>]  Print a dispatch's output snapshot verbatim
  fadeno dispatches --comparisons       Paired primary/shadow scorecard per challenger
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
  --parallel <n>          (drive) Max concurrent command deliveries per wave (1–16, default 1)
  --timeout <seconds>     (drive/dispatch) Hard deadline seconds; 0 disables route default (20 min)
  --input <Name=path>     (new-run) Supply a declared input (repeatable)
  --via <driver>          (dial/dispatch) Driver alias that delivers the model
  --session               (dial) Write/clear this checkout's session dial
  --user                  (dial) Write/clear the user default
  --repo                  (dial) Write/clear the repo pin (committed)
  --force                 (dial set) Persist a discouraged write-posture mismatch override
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
  --isolate               (dispatch) Run in a detached worktree (preserves diff, bypasses shared-writer lease)
  --diagnostics           (dispatch/drive) Persist bounded process output (32 KiB / 500 lines) to diagnostics log
  --no-brief              (dispatch) Skip the archetype's declared brief preamble
  --tail <n>              (dispatches) Logical entries to show, newest last (default 10)
  --json                  (dispatches) Emit structured entries on stdout for scripting
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
  fadeno dispatches --tail 20
  fadeno show 2026-07-10-2212
  fadeno verify --latest
  source <(fadeno completion bash)
`;

export const KNOWN_CLI_COMMANDS = new Set([
  'setup', 'status', 'doctor', 'vendor', 'unvendor', 'clean', 'uninstall',
  'evidence', 'init', 'steering', 'validate', 'diagram', 'new-run', 'run',
  'tool-run', 'tool-complete', 'plugin', 'completion', 'gate', 'prompt', 'next', 'drive',
  'cancel', 'models', 'dial', 'dispatch', 'dispatch-fallback', 'dispatch-start',
  'dispatch-prompt', 'dispatch-complete', 'dispatch-progress', 'dispatch-prepare',
  'dispatch-fail', 'decide', 'runs', 'dispatches', 'show', 'verify',
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
  fadeno dial                                  Effective table (model, effort, harness, source)
  fadeno dial <archetype>                      One archetype's row (+ shadow; --json adds layers)
  fadeno dial <archetype>… <model>[@effort]    Set a dial (several archetypes at
                                               once: space, \`+\`, or \`,\` separated)
  fadeno dial clear [<archetype>]              Clear a dial at the layer it lives;
                                               no archetype = all session + user dials
  fadeno dial shadow <archetype> <model>[@effort] [--rate <r>]
                                               Attach a shadow challenger (scored, never gates)
  fadeno dial clear-shadow [<archetype>]       Remove shadow attachment(s)
  fadeno dial resolve --archetype <a>          Resolution JSON (hook/script contract)

Options:
  --via <driver>   Driver alias that delivers the model (e.g. opencode, codex)
  --session        Write/clear the local session dial (this checkout only)
  --user           Write/clear the user default (applies across your repos)
  --repo           Write/clear the repo pin (committed to .fadeno/executors.yaml)
  --force          Set despite a write-posture mismatch (persisted, discouraged)
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
A write-requiring archetype resolving onto a read-only route delivers through the
route's declared write_variant automatically; adapter selection stays internal.
Write-posture mismatches refuse by default. A deliberate \`--force\` persists an
override on that dial, prints a prominent warning, and is honored at dispatch;
eligibility and other constraints are not bypassed.

Examples:
  fadeno dial worker sol
  fadeno dial judge fable@high --session
  fadeno dial judge fable@high
  fadeno dial worker qwen-3.5-coder --via opencode
  fadeno dial generator gemini --via agy --force
  fadeno dial clear worker --user
`,
  models: `fadeno models — the model registry and its harness identities

Usage:
  fadeno models                    Frame-neutral registry table
  fadeno models <name>             One model: harness, spellings, eligibility
  fadeno models --driver <alias>   Live backend listing via the route's models_command
                                   (registered spellings marked with ←)

Options:
  --json   Structured output

The table is frame-neutral: harness is the model's home agent CLI and effort is
the registry standard. Whether that harness is reached through a host agent or
a CLI command is selected later from the caller's route and is not part of the
model's identity. Names not in the registry route via the
catalog's unregistered_model_driver with the id passed verbatim. The
single-model view adds alternate --via harnesses. Probe-cache verification state stays in --json
(verified_at per row).

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
  --isolate             Run in a detached worktree (opt-in, preserves diff, bypasses shared-writer lease)
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
  dispatches: `fadeno dispatches — the executor evidence ledger (.fadeno/dispatches.jsonl)

Usage:
  fadeno dispatches [--tail <n>] [--json]      Who ran what, newest last
  fadeno dispatches --output <id|last|tag:<t>> [--wait [s]]
                                               Print a dispatch's output snapshot verbatim
  fadeno dispatches --cancel <id|tag:<t>>      Stop a running dispatch (SIGTERM to its group)
  fadeno dispatches --comparisons              Paired primary/shadow scorecard per challenger

Options:
  --tail <n>       Logical entries to show (default 10)
  --json           Structured entries on stdout for scripting
  --wait [s]       (--output) Wait for the completion row (default 120s)

Rows carry dial provenance: [session dial], [repo pin], [user dial]. Old-format
ledger generations still render, marked [legacy] / [format 0.x].
`,
  drive: `fadeno drive — advance a run until terminal or paused

Usage:
  fadeno drive <run> [flags]

Options:
  --bind <role=executor>   Session executor override for a role (repeatable; recorded)
  --max-transitions <n>    Engine transition cap per invocation (default 50)
  --parallel <n>           Max concurrent command deliveries per wave (1–16, default 1)
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
  fadeno steering apply --codex|--claude [--scope project|user] [--force]

resolve emits the routing JSON hooks consume (exit 2 = restart required or
write conflict — not runnable in this session). apply materializes agent
definitions for the worker/reviewer/judge slots from the current dials:
Codex TOMLs (model + model_reasoning_effort), or local Claude subagents
(.claude/agents/<archetype>.md with model + effort frontmatter) so an
in-session model runs at ITS effort, not the session's. Re-run after
re-dialing; host slots load on a fresh session.
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
Only ready tool_call steps whose artifact schema is test-result are automated; other outputs
(Diff/PostResult) remain manual via tool-complete. Executes without a shell under the
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
const SCHEMA_KINDS: SchemaKind[] = ['playbook', 'run', 'review-report', 'test-result'];

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
  const header = `${'model'.padEnd(12)}  ${'provider'.padEnd(12)}  ${'id'.padEnd(26)}  ${'effort'.padEnd(8)}  harness`;
  console.log(header);
  for (const row of result.models) {
    const harnessCell = row.harness ?? '—';
    console.log(
      `${row.name.padEnd(12)}  ${(row.provider ?? '—').padEnd(12)}  ${row.id.padEnd(26)}  ${row.effort.padEnd(8)}  ${harnessCell}`,
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
  console.log(`  harness: ${row.harness ?? '—'}`);
  for (const lane of row.lanes) {
    console.log(`  alternate harness: --via ${lane.via} → ${lane.id}`);
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

function printDialShow(result: DialShowResult): void {
  if (result.legacy_pin_note) console.log(result.legacy_pin_note);
  if (result.staleDials.length > 0) printStaleDials(result.staleDials);
  if (result.staleShadows.length > 0) printStaleShadows(result.staleShadows);
  // Header
  const header = `${'archetype'.padEnd(12)}  ${'model'.padEnd(18)}  ${'effort'.padEnd(8)}  ${'harness'.padEnd(22)}  source`;
  console.log(header);
  for (const row of result.rows) {
    const arch = row.archetype.padEnd(12);
    const model = row.modelDisplay.padEnd(18);
    const effort = row.effort.padEnd(8);
    const harness = row.harness.padEnd(22);
    const elig = row.eligibility === 'shadow_only' ? '  SHADOW-ONLY (never gates)' : row.eligibility === 'forbidden' ? '  FORBIDDEN (refused at dispatch)' : '';
    const forced = row.write_posture_forced ? '  WARNING: FORCED WRITE-POSTURE MISMATCH' : '';
    const via = row.resolvedVia ? ` (via ${row.resolvedVia})` : '';
    console.log(`${arch}  ${model}  ${effort}  ${harness}  ${DIAL_SOURCE_TEXT[row.source] ?? row.source}${via}${elig}${forced}`);
    if (row.shadow) console.log(formatShadowLine(row.shadow, '  '));
  }
  if (result.note) console.log(result.note);
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
        diagnostics: { type: 'boolean' },
        tail: { type: 'string' },
        rate: { type: 'string' },
        tag: { type: 'string' },
        shadow: { type: 'string' },
        comparisons: { type: 'boolean' },
        wait: { type: 'string' },
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

  if (
    (values.run !== undefined || values['dispatch-id'] !== undefined) &&
    !(command === 'steering' && positionals[1] === 'resolve')
  ) {
    throw new Error('--run and --dispatch-id are valid only for `fadeno steering resolve`.');
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
        });
        const steeringOut: Record<string, unknown> = {
          mode: result.mode,
          archetype: result.archetype,
          role: result.role,
          executor: result.executor,
          adapter: result.adapter,
          model: result.model,
          effort: result.effort ?? null,
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
                : `local subagent (model: ${slot.model})`
              : 'dispatch proxy (no agent file)';
            console.log(`  ${archetype} → ${how} ${slot.executor}`);
          }
          for (const path of result.removed ?? []) console.log(`  removed stale per-dial agent: ${path}`);
          console.log(`  identity grid: ${result.grid?.length ?? 0} cell(s) (archetype x effort), model supplied per spawn`);
          console.log(
            changed === 0
              ? '  0 agent definition(s) written; the grid is current — dial changes take effect immediately, no restart.'
              : `  ${changed} agent definition(s) written; restart Claude Code once so the new names register. Dial changes after that need neither.`,
          );
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
        for (const line of (resolution as any).echo) console.log(`  ${line}`);
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
        if (positionals.length < 4) throw new Error('Usage: fadeno dial shadow <archetype> <model>[@effort] [--via <driver>] [--rate <n>]');
        if (positionals.length > 4) throw new Error('Usage: fadeno dial shadow <archetype> <model>[@effort] [--via <driver>] [--rate <n>]');
        const [, , archetype, model] = positionals;
        const result = runDialShadow({ archetype: archetype!, model: model!, via: values.via ?? null, rate: values.rate });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        for (const note of result.notes) console.log(note);
        const rate = result.rate != null ? ` [rate ${result.rate}]` : '';
        console.log(`shadow attached: ${result.archetype} ~ ${result.refString} via ${result.driver}${rate}`);
        if (result.previous) console.log(`  (was ${result.previous.model}${result.previous.rate ? ` rate ${result.previous.rate}` : ''})`);
        return 0;
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
        const results = runDialSetMany({ archetypes, model, via: values.via ?? null, session: Boolean(values.session), user: Boolean(values.user), repo: Boolean(values.repo), force: Boolean(values.force) });
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
      throw new Error('Usage: fadeno dial [<archetype> [<model>[@effort] [--via <driver>] [--session|--user|--repo] [--force]] | clear [<archetype>] [--session|--user|--repo] | shadow <archetype> <model>[@effort] [--via <driver>] [--rate <n>] | clear-shadow [<archetype>] | resolve --archetype <name>]');
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
    case 'dispatches': {
      if (values.comparisons) {
        const result = runDispatchesComparisons({});
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

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
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
import { runDiagram } from './commands/diagram.ts';
import { runDrive, type DriveResult } from './commands/drive.ts';
import { runGate } from './commands/gate.ts';
import { runInit, type Target } from './commands/init.ts';
import {
  runLoadoutClear,
  runLoadoutList,
  runLoadoutShow,
  runLoadoutUse,
  type LoadoutListResult,
  type LoadoutShowResult,
  type LoadoutSlotView,
} from './commands/loadout.ts';
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
import { runSteeringApply, runSteeringResolve } from './commands/steering.ts';
import { runToolComplete } from './commands/tool-complete.ts';
import { runSetup } from './commands/setup.ts';
import { runUse } from './commands/use.ts';
import { runStatus } from './commands/status.ts';
import { runDoctor } from './commands/doctor.ts';
import { runVendor } from './commands/vendor.ts';
import { runEvidencePromote } from './commands/evidence.ts';
import { runUninstall } from './commands/uninstall.ts';
import { runClean } from './commands/clean.ts';
import { runUnvendor } from './commands/unvendor.ts';
import type { DiagramFormat } from './lib/diagram.ts';
import { progressSidecarPath } from './lib/prompt.ts';
import type { EmitResult } from './lib/fsutil.ts';
import type { SchemaKind, ValidationIssue } from './lib/playbook-validate.ts';
import { findRepoRoot, packageVersion } from './lib/paths.ts';
import type { RunEvent, RunSummary } from './lib/run-ledger.ts';
import type { DispatchProgressSource } from './lib/host-dispatch.ts';
import type { ValidateOutcome } from './commands/validate.ts';
import type { ShowProjection, ShowResult, StepView } from './commands/show.ts';

const HELP = `fadeno — the playbook layer for AI coding agents

Usage:
  fadeno init --codex|--claude|--grok [opts]   Explicitly scaffold project-owned capability
  fadeno setup [--codex|--claude]              Install safe user-scoped integration
  fadeno use <loadout> [--project]            Select the user (or project) default loadout
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
  fadeno loadout [list|use <n>|clear]   Show, list, pin, or clear the active loadout
  fadeno steering resolve|apply [...]   Resolve or materialize hybrid Codex steering
  fadeno dispatch [flags]               Resolve archetype → executor and invoke it once (ad hoc)
  fadeno dispatch-fallback <run> <id>   Deliver a locked host request by declared fallback
  fadeno dispatch-start <run> <id>      Start a native host dispatch
  fadeno dispatch-progress <run> <id>   Record an attested progress observation
  fadeno dispatch-complete <run> <id>   Submit a native host result
  fadeno dispatch-fail <run> <id>       Submit a native host failure
  fadeno run <run> [flags]              Update a run ledger (run.yaml + events.jsonl)
  fadeno tool-complete <run> --output P Atomically record the next tool_call result
  fadeno gate <run> <condition>         Evaluate a gate condition from a structured artifact
  fadeno prompt <run> <step> [flags]    Assemble (and record) a step's actor prompt
  fadeno next <run>                     Emit the next actionable step (JSON flow cursor)
  fadeno drive <run> [flags]            Engine: advance the run until terminal or paused
  fadeno decide <run> <option> [flags]  Resolve a pending named human decision
  fadeno runs                           List run ledgers under .fadeno/runs/
  fadeno show <run>                     Show a run's step projection and artifacts (--events for raw timeline)
  fadeno verify <run> [--allow-failed]  Re-audit a run's deterministic claims (or --latest)
  fadeno plugin [dir] [--codex]         Generate a Claude Code (default) or Codex plugin
  fadeno completion bash                Emit a sourceable Bash completion script

Options:
  --with-hooks            (init) Also scaffold tier-2 enforcement hooks
  --with-steering         (init) Deprecated compatibility alias; steering is now default
  --no-steering           (init) Opt out of default Codex/Claude steering
  --non-interactive       (setup) Accepted compatibility no-op; setup never prompts
  --all                   (uninstall) Remove every registered harness integration
  --purge-user-data       (uninstall) Also remove shared config/state/data; requires --force
  --project               (use) Pin the loadout in this repository
  --scope <scope>         (steering apply) project (default) | user
  --data-only             (init) Seed only .fadeno/ definitions (capability via plugin)
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
  --input <Name=path>     (new-run) Supply a declared input (repeatable)
  --loadout <name>        (loadout/dispatch/drive/new-run) Active-loadout override for this invocation
  --archetype <a>         (dispatch) Archetype to resolve (required unless --executor)
  --role <name>           (dispatch) Role name: enables binding pins + evidence attribution
  --executor <name>       (dispatch) Bypass resolution and invoke a named executor (debugging)
  --native-executor <n>   (steering resolve) Host executor materialized into this native role
  --run <id>              (steering resolve) Immutable engine run identity for a delivered host request
  --dispatch-id <id>      (steering resolve) Immutable host dispatch identity paired with --run
  --prompt-file <path>    (dispatch) Read the prompt from a file instead of stdin
  --agent-id <id>         (dispatch-start) Native host agent identity
  --workspace <path>      (dispatch-start) Native workspace provenance
  --branch <name>         (dispatch-start) Native branch provenance
  --file <path>           (dispatch-progress) Agent/harness status JSON file
  --source <kind>         (dispatch-progress) agent | harness | director
  --output <path>         (dispatch-complete) Temporary output file
  --commit <sha>          (dispatch-complete) Optional commit provenance
  --reason <text>         (dispatch-fail) Host-attested failure reason
  --decision <id>         (decide) Target decision id (optional when exactly one is pending)
  --feedback <text>       (decide) Free-text feedback recorded on the resolution
  --latest                (verify) Audit the newest run instead of a named one
  --allow-failed          (verify) Accept an honest failed/aborted terminal
  --legacy                (show/verify/next) Read a 0.2 or unversioned pre-0.3 ledger in explicit compatibility mode
  --events                (show) Print the raw event timeline instead of the step projection
  -h, --help              Show this help
  -v, --version           Show version

Environment:
  FADENO_LOADOUT          Active-loadout override for this shell
                          (precedence: --loadout > run-persisted > FADENO_LOADOUT > .fadeno/local/loadout > user state > default_loadout)
Examples:
  fadeno validate
  fadeno new-run code-change-review "Add CSV export for reports"
  fadeno setup --codex
  fadeno status
  fadeno use claude
  fadeno doctor --codex
  fadeno init --codex --with-hooks
  fadeno init --grok
  fadeno validate .fadeno/runs/2026-05-30-1132-csv/run.yaml --schema run
  fadeno run 2026-05-30-1132-csv --step review
  fadeno run 2026-05-30-1132-csv --status completed
  fadeno run 2026-05-30-1132-csv --event artifact_created --artifact artifacts/x.json --member architect_fable
  fadeno run 2026-05-30-1132-csv --step arbitrate --event human_decision --field branch=approve
  fadeno loadout use openai-primary  # advanced compatibility surface
  fadeno steering apply codex-only --codex --force
  echo "Summarize the repo layout." | fadeno dispatch --archetype worker
  fadeno gate 2026-05-30-1132-csv no_blocking_issues --artifact artifacts/review-report.json
  fadeno prompt 2026-05-30-1132-csv cross_review --actor architect_fable --no-record
  fadeno next 2026-05-30-1132-csv
  fadeno runs
  fadeno show 2026-07-10-2212
  fadeno verify --latest
  source <(fadeno completion bash)
`;

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
      if (actor.source != null) details.push(`${actor.source}-reported`);
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
        if (request.progressSource != null) details.push(`${request.progressSource}-reported`);
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

const LOADOUT_SOURCE_TEXT: Record<string, string> = {
  flag: '--loadout',
  run: 'run-persisted loadout',
  env: 'FADENO_LOADOUT',
  local: '.fadeno/local/loadout',
  user: 'user state',
  default: 'default_loadout',
};

function printSlots(slots: LoadoutSlotView[], indent: string): void {
  const width = Math.max(0, ...slots.map((s) => s.archetype.length));
  for (const slot of slots) {
    const model = slot.model != null ? ` (${slot.model})` : '';
    console.log(`${indent}${slot.archetype.padEnd(width)} → ${slot.executor}${model} [${slot.adapter}]`);
  }
}

function printStalePin(stalePin: string | null): void {
  if (stalePin == null) return;
  console.error(
    `warning: .fadeno/local/loadout pins "${stalePin}", which is no longer declared — ` +
      'run `fadeno loadout clear` (or `fadeno loadout use <name>`); the pin is ignored below.',
  );
}

function printLoadoutShow(result: LoadoutShowResult): void {
  printStalePin(result.stalePin);
  if (result.active == null) {
    console.log('no active loadout (no --loadout, FADENO_LOADOUT, .fadeno/local/loadout, or default_loadout)');
  } else {
    console.log(`active loadout: ${result.active.name} (via ${LOADOUT_SOURCE_TEXT[result.active.source]})`);
    printSlots(result.slots, '  ');
  }
  if (result.available.length === 0) {
    console.log('\nThe profile declares no loadouts (add a `loadouts:` mapping to .fadeno/executors.yaml).');
    return;
  }
  const names = result.available.map((name) => (name === result.defaultLoadout ? `${name} (default)` : name));
  console.log(`\navailable: ${names.join(', ')}`);
}

function printLoadoutList(result: LoadoutListResult): void {
  printStalePin(result.stalePin);
  if (result.loadouts.length === 0) {
    console.log('No loadouts declared (add a `loadouts:` mapping to .fadeno/executors.yaml).');
    return;
  }
  for (const loadout of result.loadouts) {
    const notes: string[] = [];
    if (loadout.isActive && result.active != null) {
      notes.push(`active via ${LOADOUT_SOURCE_TEXT[result.active.source]}`);
    }
    if (loadout.isDefault) notes.push('default');
    const marker = loadout.isActive ? '*' : ' ';
    console.log(`${marker} ${loadout.name}${notes.length > 0 ? `  (${notes.join(', ')})` : ''}`);
    printSlots(loadout.slots, '    ');
  }
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
      console.log(`awaiting ${result.requests.length} native host dispatch(es) for run ${result.run}`);
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
        input: { type: 'string', multiple: true },
        loadout: { type: 'string' },
        archetype: { type: 'string' },
        role: { type: 'string' },
        executor: { type: 'string' },
        'native-executor': { type: 'string' },
        run: { type: 'string' },
        'dispatch-id': { type: 'string' },
        'prompt-file': { type: 'string' },
        'agent-id': { type: 'string' },
        workspace: { type: 'string' },
        branch: { type: 'string' },
        file: { type: 'string' },
        source: { type: 'string' },
        output: { type: 'string' },
        commit: { type: 'string' },
        reason: { type: 'string' },
        decision: { type: 'string' },
        feedback: { type: 'string' },
        latest: { type: 'boolean' },
        'allow-failed': { type: 'boolean' },
        legacy: { type: 'boolean' },
        events: { type: 'boolean' },
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
    console.log(HELP);
    return 0;
  }
  if (!command) {
    console.log(HELP);
    return 1;
  }

  switch (command) {
    case 'setup': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('`fadeno setup` supports --codex or --claude; Grok has no steering setup.');
      const result = runSetup({ target: target ?? null, nonInteractive: values['non-interactive'] });
      console.log(`Fadeno setup (${result.target ?? 'standalone'})`);
      for (const probe of result.probes) console.log(`  ${probe.name}: ${probe.available ? `available${probe.version ? ` (${probe.version})` : ''}` : 'not found'}`);
      for (const path of result.created) console.log(`  created ${path}`);
      for (const notice of result.notices) console.log(`  ${notice}`);
      if (result.restartRequired) console.log('  restart required: managed host integration changed.');
      return 0;
    }
    case 'use': {
      const name = positionals[1];
      if (!name) throw new Error('Usage: fadeno use <loadout> [--project] [--codex]');
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('Grok does not support steering materialization; use an explicit loadout without --grok.');
      const result = runUse({ name, project: values.project, target: target === 'codex' ? 'codex' : undefined });
      console.log(`active loadout selected: ${result.name} (${result.scope})`);
      for (const notice of result.notices) console.log(`  ${notice}`);
      if (result.restartRequired && !result.notices.some((notice) => notice.includes('fallbacks work now'))) {
        console.log('  restart required: start a fresh Codex session.');
      }
      return 0;
    }
    case 'status': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('Use `fadeno status` without --grok; Grok steering is intentionally unsupported.');
      const result = runStatus({ verbose: values.verbose, target: target ?? null });
      console.log(`Fadeno ${result.version} · harness ${result.harness ?? 'unknown'}`);
      console.log(`runtime: ${result.runtime.invocationSource}; managed ${result.runtime.managedVersion ?? 'not installed'}${result.runtime.managedPath ? ` at ${result.runtime.managedPath}` : ''}${result.runtime.versionCurrent ? '' : ' (version skew)'}`);
      console.log(`integrations: ${result.runtime.installedHarnesses.join(', ') || 'none'}`);
      console.log(`definitions: ${result.definitions.playbooks.length} effective playbooks (project shadows bundled)`);
      console.log(`active loadout: ${result.activeLoadout?.name ?? 'none'}${result.activeLoadout ? ` [${result.activeLoadout.source}]` : ''}`);
      for (const role of result.roles) console.log(`  ${role.archetype} → ${role.executor} (${role.adapter})${role.command ? ` ${role.command.join(' ')}` : ''}`);
      if (result.external.length > 0) console.log('external sandbox: selected command slots leave the current harness; evidence → .fadeno/dispatches.jsonl');
      if (result.staleProjectPin) console.log(`stale project pin: ${result.staleProjectPin}`);
      if (result.staleUserPin) console.log(`stale user pin: ${result.staleUserPin}`);
      if (result.codexMaterialization) console.log(`Codex managed agents: ${result.codexMaterialization.fresh ? 'current' : 'missing/stale'}${result.codexMaterialization.restartRequired ? ' (restart required)' : ''}`);
      if (result.next) console.log(`next: ${result.next}`);
      if (values.verbose) console.log(JSON.stringify({ repoRoot: result.repoRoot, paths: result.definitions, roles: result.roles }, null, 2));
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
            'Usage: fadeno steering resolve --archetype <name> [--native-executor <name>] [--role <name>] [--loadout <name>] [--run <id> --dispatch-id <id>]',
          );
        }
        const result = runSteeringResolve({
          archetype: values.archetype,
          nativeExecutor: values['native-executor'],
          role: values.role,
          loadout: values.loadout,
          run: values.run,
          dispatchId: values['dispatch-id'],
        });
        console.log(JSON.stringify({
          mode: result.mode,
          archetype: result.archetype,
          role: result.role,
          loadout: result.activeLoadout,
          executor: result.executor,
          adapter: result.adapter,
          model: result.model,
          native_executor: result.nativeExecutor,
          resolution: result.source,
          run: values.run ?? null,
          dispatch_id: values['dispatch-id'] ?? null,
          detail: result.detail,
        }, null, 2));
        return result.mode === 'restart_required' ? 2 : 0;
      }
      if (sub === 'apply') {
        const loadout = positionals[2];
        if (!loadout || !values.codex || values.claude || values.grok) {
          throw new Error('Usage: fadeno steering apply <loadout> --codex [--force]');
        }
        if (values.scope && values.scope !== 'project' && values.scope !== 'user') throw new Error('Invalid --scope. Use project or user.');
        const result = runSteeringApply({ loadout, target: 'codex', force: values.force, scope: values.scope as 'project' | 'user' | undefined });
        const changed = result.results.filter((item) => item.status !== 'skipped').length;
        console.log(`Codex steering materialized: ${result.loadout}`);
        for (const archetype of ['worker', 'reviewer', 'judge']) {
          const slot = result.materialization[archetype]!;
          console.log(
            `  ${archetype} → ${slot.kind === 'native' ? 'native host' : 'command broker'} ${slot.executor}`,
          );
        }
        console.log(
          `  ${changed} agent definition(s) written; declared fallbacks work immediately, ` +
            'or start a fresh Codex session to make changed host slots native.',
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
      const { runId, runDir, inputs, resolution } = runNewRun({
        playbook,
        task,
        inputs: values.input,
        loadout: values.loadout,
      });
      console.log(`Created run ${runId}`);
      console.log(`  ${runDir}`);
      if (inputs.length > 0) console.log(`  inputs: ${inputs.join(', ')}`);
      if (resolution != null && resolution.echo.length > 0) {
        const via = resolution.loadout != null
          ? ` (loadout ${resolution.loadout.name} via ${LOADOUT_SOURCE_TEXT[resolution.loadout.source]})`
          : '';
        console.log(`\nresolution${via}:`);
        for (const line of resolution.echo) console.log(`  ${line}`);
      }
      console.log('\nAdvance it with `fadeno run` as the playbook executes:');
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
        } else {
          console.log(`PASS  ${result.condition} (0 blocking issues)`);
        }
      } else {
        if (result.condition === 'tests_pass') {
          console.error(`FAIL  ${result.condition} (status=${String(result.details.status)}, exit_code=${String(result.details.exitCode)})`);
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
      if (!run) throw new Error('Usage: fadeno drive <run> [--bind role=executor] [--max-transitions n]');
      let maxTransitions: number | undefined;
      if (values['max-transitions'] != null) {
        const n = Number(values['max-transitions']);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`Invalid --max-transitions "${values['max-transitions']}". Use a positive integer.`);
        }
        maxTransitions = n;
      }
      const result = runDrive({
        run,
        bind: values.bind,
        loadout: values.loadout,
        maxTransitions,
        onAction: (line) => console.log(`  ${line}`),
      });
      return printDrive(result);
    }
    case 'loadout': {
      const sub = positionals[1];
      if (sub == null) {
        printLoadoutShow(runLoadoutShow({ loadout: values.loadout }));
        return 0;
      }
      switch (sub) {
        case 'list':
          printLoadoutList(runLoadoutList({ loadout: values.loadout }));
          return 0;
        case 'use': {
          const name = positionals[2];
          if (!name) throw new Error('Usage: fadeno loadout use <name>');
          const result = runLoadoutUse({ name });
          console.log(`active loadout pinned: ${result.name} → .fadeno/local/loadout`);
          if (result.previous != null && result.previous !== result.name) {
            console.log(`  (was ${result.previous})`);
          }
          // Summarize the name just pinned, independent of FADENO_LOADOUT's
          // higher-precedence value in the current shell.
          const selected = runLoadoutShow({ loadout: result.name, env: null });
          const commandSlots = selected.slots.filter((slot) => slot.adapter === 'command').length;
          const hostSlots = selected.slots.filter((slot) => slot.adapter === 'host').length;
          if (commandSlots > 0) {
            console.log(`  ${commandSlots} command slot(s) take effect on the next role dispatch/invocation; no restart is needed.`);
          }
          if (hostSlots > 0) {
            console.log(
              `  ${hostSlots} host slot(s) run natively only when the current session's materialized native executor matches; ` +
                'declared command fallbacks switch on the next invocation. ' +
                `Run \`fadeno steering apply ${result.name} --codex --force\` and start a fresh Codex session only to make them native.`,
            );
          }
          return 0;
        }
        case 'clear': {
          const result = runLoadoutClear({});
          console.log(
            result.removed
              ? 'cleared .fadeno/local/loadout'
              : 'no local loadout to clear (.fadeno/local/loadout absent)',
          );
          return 0;
        }
        default:
          throw new Error(`Unknown loadout subcommand "${sub}". Usage: fadeno loadout [list | use <name> | clear]`);
      }
    }
    case 'dispatch': {
      const promptFile = values['prompt-file'];
      const result = runDispatch({
        archetype: values.archetype,
        role: values.role,
        loadout: values.loadout,
        executor: values.executor,
        promptFile,
        // Prompt defaults to stdin; the echo goes to stderr so stdout stays
        // the executor's pure report.
        prompt: promptFile == null ? readFileSync(0, 'utf8') : undefined,
        onEcho: (line) => console.error(line),
      });
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) {
        // CLI-level diagnosis on stderr — a quiet executor otherwise leaves
        // only a bare exit code. stdout stays the executor's pure report.
        console.error(`dispatch: executor ${result.executor} exited ${result.exitCode}`);
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
        throw new Error('Usage: fadeno dispatch-start <run> <dispatch-id> --agent-id <native-id> [--workspace <path>] [--branch <branch>]');
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
    case 'dispatch-complete': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId || !values.output) {
        throw new Error('Usage: fadeno dispatch-complete <run> <dispatch-id> --output <temporary-file> [--commit <sha>]');
      }
      const result = runDispatchComplete({ run, dispatchId, output: values.output, commit: values.commit });
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

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
}

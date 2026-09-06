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
  relayQuarantineNotice,
  runDispatchesWithdraw,
  type DispatchesResult,
  runDispatchesMerge,
} from './commands/dispatches.ts';
import { runDiagram } from './commands/diagram.ts';
import { DRIVE_PARALLEL_DEFAULT, DRIVE_PARALLEL_MAX, DRIVE_PARALLEL_MIN, runAttemptAccept, runDrive, type DriveResult } from './commands/drive.ts';
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
import { runModels, runModelsAdd, runModelsHarness, runModelsRemove, type HarnessListingResult, type ModelAddResult, type ModelRemoveResult, type ModelsResult } from './commands/models.ts';
import { runModelsVerify, type ModelsVerifyResult } from './commands/models-verify.ts';
import { runNewRun } from './commands/new-run.ts';
import { runPlaybooks, type PlaybooksDetailResult, type PlaybooksListResult } from './commands/playbooks.ts';
import { runCodexPlugin, runOmpPlugin, runPlugin } from './commands/plugin.ts';
import { runNext } from './commands/next.ts';
import { runPrompt } from './commands/prompt.ts';
import { runRun } from './commands/run.ts';
import { runRuns } from './commands/runs.ts';
import { runShow } from './commands/show.ts';
import { runValidate } from './commands/validate.ts';
import { runVerify, type VerifyResult } from './commands/verify.ts';
import { knownFlagsFor, runCompletion, runCompletionCandidates, suggestFlag, TOP_LEVEL_COMMANDS, unknownFlagsFor } from './commands/completion.ts';
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
import { runSteeringApply, runSteeringApplyClaude, runSteeringApplyOpenCode, runSteeringApplyOmp, runSteeringResolve } from './commands/steering.ts';
import { runDispatchPrompt } from './commands/dispatch-prompt.ts';
import { runDispatchPrepare } from './commands/dispatch-prepare.ts';
import { runDispatchWithdraw } from './commands/dispatch-withdraw.ts';
import { runToolComplete } from './commands/tool-complete.ts';
import { runToolRun } from './commands/tool-run.ts';
import { runSetup } from './commands/setup.ts';
import { runStatus, type CodexMaterialization } from './commands/status.ts';
import { runDoctor, type DoctorFinding } from './commands/doctor.ts';
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
import { describeCodexAgentIdentityRow } from './lib/codex-agent-file.ts';
import { describeIdleOutput, readClaimProgress } from './lib/attempt-progress.ts';
import type { ValidateOutcome } from './commands/validate.ts';
import type { ShowProjection, ShowResult, StepView } from './commands/show.ts';
import { readInstallationManifest, syncManagedRuntime } from './lib/installations.ts';
import { userPaths } from './lib/user-paths.ts';
import { renderFocusedHelp, renderGlobalHelp, resolveHelpPath } from './lib/cli-help.ts';

export const KNOWN_CLI_COMMANDS = new Set(TOP_LEVEL_COMMANDS);

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

const SIGIL: Record<Target, string> = { codex: '$', claude: '/', grok: '/', opencode: '', omp: '' };
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
          : target === 'opencode' || target === 'omp'
            ? '  3. Use the fadeno-runner skill (installed under .agents/skills)'
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
        : target === 'opencode'
          ? `  ${nextStep}. Steering materialized under .opencode/; restart OpenCode so the agent files and plugin load`
          : target === 'omp'
            ? `  ${nextStep}. Steering materialized under .omp/; restart omp so agents and the extension load`
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
      const selfReport = readClaimProgress(fact);
      if (selfReport != null) {
        // The agent's own account, never a measurement and never a gate: it sits
        // next to the byte counters precisely so a reader can tell them apart.
        const reportedAt = Date.parse(selfReport.updatedAt);
        const reportAge = Number.isFinite(reportedAt) ? formatDuration(Math.max(0, Date.now() - reportedAt)) : null;
        const phase = selfReport.phase ?? selfReport.state ?? 'progress';
        const current = selfReport.current == null ? '' : ` — ${truncateWithEllipsis(selfReport.current, 120)}`;
        const stateNote = selfReport.state == null ? '' : ` (${selfReport.state})`;
        console.log(
          `    agent: "${phase}"${stateNote}${current}${reportAge == null ? '' : `, ${reportAge} ago`} (agent self-report, non-gating)`,
        );
      }
      if (fact.outputIdleWarning) {
        const described = describeIdleOutput({
          idleMs: fact.outputAgeMs ?? fact.runtimeMs ?? null,
          progress: readClaimProgress(fact),
          argv: fact.command,
        });
        console.log(`    WARNING: ${described.text}`);
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
        if (request.withdrawnReason != null) details.push(truncateWithEllipsis(request.withdrawnReason, 120));
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
  // `harness`: the model's home EXECUTOR harness. One harness table under v4,
  // so this column no longer varies with the host you are sitting inside.
  const header = `${'model'.padEnd(12)}  ${'provider'.padEnd(12)}  ${'id'.padEnd(26)}  ${'effort'.padEnd(8)}  harness`;
  console.log(header);
  for (const row of result.models) {
    console.log(
      `${row.name.padEnd(12)}  ${(row.provider ?? '—').padEnd(12)}  ${row.id.padEnd(26)}  ${row.effort.padEnd(8)}  ${row.home_harness}`,
    );
  }
  for (const row of result.models) {
    if (row.stale != null) console.error(`warning: ${row.name} — ${row.stale}`);
  }
  console.log(
    `\nany other name runs on ${result.unregistered_model_harness} — id passed verbatim, probed at dial time`,
  );
  if (result.listable_harnesses.length > 0) {
    console.log(`live backend listings: fadeno models --harness <${result.listable_harnesses.join('|')}>`);
  }
}

function printModelDetail(result: ModelsResult, name: string): void {
  const row = result.models.find((r) => r.name === name);
  if (row == null) {
    console.log(
      `"${name}" is not in the registry — dialing it runs on ${result.unregistered_model_harness} with the id passed verbatim (probed at dial time). ` +
        'Declare it under models: to set a home harness or standard effort.',
    );
    return;
  }
  printModels({ ...result, models: [row] });
  console.log(`  harness: ${row.home_harness}`);
  for (const delivery of row.deliveries) {
    console.log(`  alternate: --harness ${delivery.harness} → ${delivery.id}${delivery.variant != null ? ` [variant ${delivery.variant}]` : ''}`);
  }
  for (const [harness, id] of Object.entries(row.spellings)) {
    console.log(`  spelling: --harness ${harness} → ${id}`);
  }
  for (const [archetype, state] of Object.entries(row.eligibility)) {
    if (state !== 'eligible') console.log(`  eligibility: ${archetype} → ${state}`);
  }
}

function printModelsHarness(result: HarnessListingResult): void {
  console.log(`${result.harness} backend listing (${result.models_command.join(' ')}): ${result.models.length} model(s)`);
  for (const model of result.models) {
    const marks = model.registered_as.length > 0 ? `  ← ${model.registered_as.join(', ')}` : '';
    console.log(`  ${model.id}${marks}`);
  }
}

function printModelAdd(result: ModelAddResult): void {
  console.log(`added ${result.alias} → ${result.provider}/${result.id}`);
  console.log(`  discovery: ${result.discovery_path} matched ${result.matched_identity}`);
  console.log(`  delivery: ${result.delivery.harness} → ${result.delivery.id}`);
  console.log(`  user catalog: ${result.catalog_path}`);
  if (result.suppressed_by_project) {
    console.log('  note: this checkout has a self-contained project catalog; the alias will fall back into it per-key when its harness is declared there (dial show names any that drop).');
  }
}

function printModelRemove(result: ModelRemoveResult): void {
  console.log(`removed ${result.alias} from ${result.path}`);
  if (result.verifications_removed > 0) {
    console.log(`  verification rows dropped: ${result.verifications_removed}`);
  }
  // Stranded references go to stderr: the removal succeeded, and what is left
  // is the thing the next dispatch would otherwise discover for you.
  for (const dial of result.dangling_dials) {
    console.error(
      `warning: dial ${dial.archetype}→${dial.ref} (${dial.layer}) now names a model that is gone — re-dial with \`fadeno dial ${dial.archetype} <other>\``,
    );
  }
  for (const shadow of result.dangling_shadows) {
    console.error(
      `warning: shadow attachment ${shadow.archetype}~${shadow.ref} now names a model that is gone — \`fadeno dial clear-shadow ${shadow.archetype}\``,
    );
  }
}

function printModelsVerify(result: ModelsVerifyResult): void {
  if (result.rows.length === 0) {
    console.log('no dialed models to verify — `fadeno dial` shows the effective table.');
    return;
  }
  console.log(`${'model'.padEnd(12)}  ${'id'.padEnd(26)}  ${'harness'.padEnd(10)}  ${'outcome'.padEnd(12)}  archetypes`);
  for (const row of result.rows) {
    console.log(
      `${row.model.padEnd(12)}  ${row.model_id.padEnd(26)}  ${row.harness.padEnd(10)}  ${row.outcome.padEnd(12)}  ${row.archetypes.join(', ')}`,
    );
  }
  for (const row of result.rows) {
    if (row.detail == null) continue;
    const line = `  ${row.model} on ${row.harness} — ${row.detail}`;
    if (row.outcome === 'not_listed') console.error(`error:${line}`);
    else console.log(`note:${line}`);
  }
  console.log(
    `\n${result.counts.verified} verified, ${result.counts.not_listed} not listed, ` +
      `${result.counts.unavailable} unavailable, ${result.counts.skipped} skipped`,
  );
  if (result.counts.not_listed > 0) {
    console.log('cached verification rows for the not-listed models were deleted.');
  }
}

function printPlaybookSummary(summary: PlaybooksListResult['playbooks'][number]): void {
  console.log(`${summary.name}  [${summary.source}]`);
  console.log(`  ${summary.description}`);
  if (summary.when_to_use.length > 0) console.log(`  when: ${summary.when_to_use.join('; ')}`);
  console.log(`  path: ${summary.path}`);
}

function printPlaybooksList(result: PlaybooksListResult): void {
  console.log(`${result.playbooks.length} effective playbook${result.playbooks.length === 1 ? '' : 's'}:`);
  for (const summary of result.playbooks) printPlaybookSummary(summary);
}

function printPlaybooksDetail(result: PlaybooksDetailResult): void {
  printPlaybookSummary(result.playbook);
  console.log(`\nworkflow\n${result.diagram}`);
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
  // `harness` is the EXECUTOR, and under v4 that is the only thing this word
  // means anywhere: the ambient host travels as `host`, on its own key. The
  // column used to be called `via` precisely because `harness` was taken.
  // `(home)` marks a row whose DIAL named no harness — the registry answered,
  // whether through the provider's home claim or a model-level `harness:`.
  const header = `${'archetype'.padEnd(12)}  ${'model'.padEnd(18)}  ${'effort'.padEnd(8)}  ${'harness'.padEnd(22)}  source`;
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
    // `—` for a null harness, which is `current-host` with no host: the cell
    // has no value rather than the value `null`. Same dash this table already
    // uses for a not-applicable effort.
    const harness = (row.harness == null ? '—' : `${row.harness}${row.harness_explicit ? '' : ' (home)'}`).padEnd(22);
    const elig = row.eligibility === 'shadow_only' ? '  SHADOW-ONLY (never gates)' : row.eligibility === 'forbidden' ? '  FORBIDDEN (refused at dispatch)' : '';
    // `inherits`, not `via`: `resolvedVia` is the ARCHETYPE this row borrowed
    // its dial from (`reviewer` with no dial of its own falling back to
    // `worker`), which has nothing to do with the harness column two cells
    // left. Printing both as "via" on one line was the collision that kept
    // the column named `harness` in the first place.
    const inherits = row.resolvedVia ? ` (inherits ${row.resolvedVia})` : '';
    console.log(`${arch}  ${model}  ${effort}  ${harness}  ${DIAL_SOURCE_TEXT[row.source] ?? row.source}${inherits}${elig}`);
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
  'no active shadow attachments — attach one with `fadeno shadow <archetype> <model> [--rate <r>] [--n <count>]`';

/**
 * Shared handler for `fadeno dial shadow ...` and its top-level alias
 * `fadeno shadow ...` — both spellings call this, so they cannot drift. The
 * caller has already validated the positional shape (0 extra = show mode, 2
 * extra = attach, 1 extra = usage error, refused before this is reached).
 */
function runShadowCommand(
  archetype: string | undefined,
  model: string | undefined,
  opts: { harness: string | null; rate?: string; n?: string; json: boolean },
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
  const result = runDialShadow({ archetype, model: model!, harness: opts.harness, rate: opts.rate, n: opts.n });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  for (const note of result.notes) console.log(note);
  const rate = result.rate != null ? ` [rate ${result.rate}]` : '';
  const budget = result.n != null ? ` [${result.remaining}/${result.n} triggers remaining]` : '';
  console.log(`shadow attached: ${result.archetype} ~ ${result.refString} on ${result.harness}${rate}${budget}`);
  if (result.previous) {
    const previousBudget = result.previous.n != null
      ? result.previous.remaining === 0
        ? ` expired after ${result.previous.n} triggers`
        : ` ${result.previous.remaining}/${result.previous.n} triggers remaining`
      : '';
    console.log(`  (was ${result.previous.model}${result.previous.rate ? ` rate ${result.previous.rate}` : ''}${previousBudget})`);
  }
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
      if (d.artifact != null) {
        console.log(`  artifact: ${d.artifact.path} (${d.artifact.bytes} B)`);
        for (const heading of d.artifact.headings) console.log(`      ${heading}`);
      }
      console.log(`  resolve:  fadeno decide ${result.run} <option>   then re-run fadeno drive ${result.run}`);
      return 0;
    }
    case 'awaiting_host_dispatch':
      console.log(`awaiting ${result.requests.length} host dispatch(es) for run ${result.run}`);
      for (const request of result.requests) {
        const artifactType = request.artifactType == null ? '' : `  artifact_type=${request.artifactType}`;
        console.log(`  ${request.dispatchId}  ${request.step}${request.actor ? ` (${request.actor})` : ''}  ${request.model}/${request.reasoningEffort}${artifactType}`);
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

type TargetFlags = { codex?: boolean; claude?: boolean; grok?: boolean; opencode?: boolean; omp?: boolean };

function requireTarget(values: TargetFlags): Target {
  const selected: Target[] = [];
  if (values.codex) selected.push('codex');
  if (values.claude) selected.push('claude');
  if (values.grok) selected.push('grok');
  if (values.opencode) selected.push('opencode');
  if (values.omp) selected.push('omp');
  if (selected.length > 1) {
    throw new Error('Choose exactly one target: --codex, --claude, --grok, --opencode, or --omp.');
  }
  if (selected.length === 1) return selected[0];
  throw new Error(
    'Specify a target: `fadeno init --codex`, `fadeno init --claude`, `fadeno init --grok`, `fadeno init --opencode`, or `fadeno init --omp`.',
  );
}

function optionalTarget(values: TargetFlags): Target | undefined {
  const selected: Target[] = [];
  if (values.codex) selected.push('codex');
  if (values.claude) selected.push('claude');
  if (values.grok) selected.push('grok');
  if (values.opencode) selected.push('opencode');
  if (values.omp) selected.push('omp');
  if (selected.length > 1) throw new Error('Choose at most one target: --codex, --claude, --grok, --opencode, or --omp.');
  return selected[0];
}

/**
 * Doctor's text lines, with a clean persisted-state inventory collapsed.
 *
 * The inventory is one finding per surface — eighteen of them — and on a
 * healthy machine every one says the same thing. Eighteen identical `ok` lines
 * push the findings that matter off the top of a terminal, which is how a
 * diagnostic teaches people to stop reading it. So: all-ok collapses to a
 * single counted line, and the moment ANY surface is not ok the whole table is
 * printed, because then the surrounding rows are the context for the bad one.
 * `--json` is unaffected — it always carries every finding.
 */
export function renderDoctorFindings(findings: readonly DoctorFinding[]): string[] {
  const line = (item: DoctorFinding) =>
    `${item.severity.padEnd(7)} ${item.check}: ${item.detail}${item.remediation ? ` — ${item.remediation}` : ''}`;
  const inventory = findings.filter((item) => item.check.startsWith('persisted-state:'));
  if (inventory.length === 0 || inventory.some((item) => item.severity !== 'ok')) {
    return findings.map(line);
  }
  const out: string[] = [];
  let collapsed = false;
  for (const item of findings) {
    if (item.check.startsWith('persisted-state:')) {
      if (collapsed) continue;
      collapsed = true;
      out.push(
        `${'ok'.padEnd(7)} persisted-state: ${inventory.length} persisted surfaces are at the schema_version this build writes ` +
          '(run `fadeno doctor --json` to see each one).',
      );
      continue;
    }
    out.push(line(item));
  }
  return out;
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
  // `--via` is gone with the driver vocabulary it belonged to. `parseArgs`
  // would answer "Unknown option" for it, which tells a reader the flag is
  // wrong but not what replaced it — and every scripted `fadeno dial … --via`
  // in the wild deserves the one-line answer. Checked before parsing, since
  // an undeclared option aborts there.
  const staleVia = argv.find((arg) => arg === '--via' || arg.startsWith('--via='));
  if (staleVia != null) {
    throw new Error(
      '`--via` was removed with catalog v4 — use `--harness <id>`. A dial names a model and, optionally, ' +
        'the harness that executes it; the driver names it took (claude-exec, opencode-direct, muse-code) ' +
        'were harnesses all along. See docs/experimental/harness-neutral-dials.md.',
    );
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
        opencode: { type: 'boolean' },
        omp: { type: 'boolean' },
        force: { type: 'boolean' },
        strict: { type: 'boolean' },
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
        unbind: { type: 'string', multiple: true },
        'max-transitions': { type: 'string' },
        parallel: { type: 'string' },
        'actor-call': { type: 'string' },
        timeout: { type: 'string' },
        input: { type: 'string', multiple: true },
        harness: { type: 'string' },
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
        'allow-relay-mismatch': { type: 'boolean' },
        'ignored-output': { type: 'string' },
        diagnostics: { type: 'boolean' },
        tail: { type: 'string' },
        rate: { type: 'string' },
        n: { type: 'string' },
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
        'probe-models': { type: 'boolean' },
        'agent-id': { type: 'string' },
        workspace: { type: 'string' },
        branch: { type: 'string' },
        file: { type: 'string' },
        source: { type: 'string' },
        output: { type: 'string' },
        cancel: { type: 'string' },
        withdraw: { type: 'string' },
        'work-left': { type: 'string' },
        merge: { type: 'string' },
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
    console.error(renderGlobalHelp());
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
    const path = resolveHelpPath(positionals);
    console.log(path == null ? renderGlobalHelp() : renderFocusedHelp(path));
    return 0;
  }
  if (!command) {
    console.log(renderGlobalHelp());
    return 1;
  }

  // Best-effort runtime maintenance preflight for operational commands
  maybeRunRuntimePreflight(argv, command);

  switch (command) {
    case 'setup': {
      const target = optionalTarget(values);
      if (target === 'grok' || target === 'opencode' || target === 'omp') throw new Error('`fadeno setup` supports --codex or --claude; Grok, OpenCode, and omp have no user-scoped setup.');
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
      if (target === 'grok') throw new Error('Use `fadeno status` without --grok; steering for that host is intentionally unsupported.');
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
        const m = (result as any).codexMaterialization as CodexMaterialization;
        const drifted = m.agents.filter((agent) => agent.status === 'stale' || agent.status === 'missing');
        const detail = drifted
          .map((agent) => (agent.status === 'missing' ? `${agent.archetype} file missing` : describeCodexAgentIdentityRow(agent)))
          .join('; ');
        console.log(
          m.fresh
            ? 'Codex managed agents: current'
            : `Codex managed agents: stale — ${detail}; ${m.remediation}`,
        );
        if (values.verbose) console.log(JSON.stringify({ codexMaterialization: m }, null, 2));
      }
      if ((result as any).opencodeMaterialization) {
        const m = (result as any).opencodeMaterialization;
        const issueKinds = [...new Set((m.issues ?? []).map((issue: any) => issue.kind))].join(', ');
        console.log(`OpenCode steering: ${m.healthy ? 'current' : `missing/stale${issueKinds ? ` (${issueKinds})` : ''}`}${m.restartRequired ? ' (restart required)' : ''}`);
        if (values.verbose) console.log(JSON.stringify({ opencodeMaterialization: m }, null, 2));
      }
      if ((result as any).ompMaterialization) {
        const m = (result as any).ompMaterialization;
        const issueKinds = [...new Set((m.issues ?? []).map((issue: any) => issue.kind))].join(', ');
        console.log(`omp steering: ${m.healthy ? 'current' : `missing/stale${issueKinds ? ` (${issueKinds})` : ''}`}${m.restartRequired ? ' (restart required)' : ''}`);
        if (values.verbose) console.log(JSON.stringify({ ompMaterialization: m }, null, 2));
      }
      if ((result as any).next) console.log(`next: ${(result as any).next}`);
      if (values.verbose) console.log(JSON.stringify({ repoRoot: (result as any).repoRoot, paths: (result as any).definitions, roles: (result as any).roles }, null, 2));
      return 0;
    }
    case 'doctor': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('Use `fadeno doctor` without --grok; steering for that host is intentionally unsupported.');
      const result = runDoctor({ target: target ?? null, probeModels: Boolean(values['probe-models']) });
      if (values.json) {
        console.log(JSON.stringify({ repoRoot: result.repoRoot, ok: result.ok, findings: result.findings }, null, 2));
        return result.ok ? 0 : 1;
      }
      for (const item of renderDoctorFindings(result.findings)) console.log(item);
      return result.ok ? 0 : 1;
    }
    case 'vendor': {
      const target = requireTarget(values);
      const result = runVendor({
        target,
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
      if (target === 'grok' || target === 'opencode' || target === 'omp') throw new Error('Grok, OpenCode, and omp have no user-scoped Fadeno integration to uninstall.');
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
          harness: result.harness,
          variant: result.variant ?? null,
          host: result.host ?? null,
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
        const targets = [values.codex && 'codex', values.claude && 'claude', values.opencode && 'opencode', values.omp && 'omp'].filter(Boolean) as string[];
        const applyTarget = targets.length === 1 ? targets[0]! : null;
        if (applyTarget == null || values.grok || positionals[2] != null) {
          throw new Error('Usage: fadeno steering apply --codex|--claude|--opencode|--omp [--scope project|user] [--force]');
        }
        if (values.scope && values.scope !== 'project' && values.scope !== 'user') throw new Error('Invalid --scope. Use project or user.');
        if (applyTarget === 'opencode') {
          const result = runSteeringApplyOpenCode({ target: 'opencode', force: values.force, scope: values.scope as 'project' | 'user' | undefined });
          const changed = result.results.filter((item) => item.status !== 'skipped').length;
          console.log(`OpenCode steering materialized: ${result.scope}`);
          for (const [archetype, slot] of Object.entries(result.materialization)) {
            const how = slot.kind === 'host'
              ? `in-session agent file (model: ${slot.model ?? 'session baseline'})`
              : 'dispatch broker (relay to the command lane)';
            console.log(`  ${archetype} → ${how} ${slot.executor}`);
          }
          const removed = result.removed ?? [];
          for (const path of removed) console.log(`  removed stale managed agent: ${path}`);
          console.log(
            `  ${changed} file(s) written under .opencode/; agent files and plugins load at ` +
              'process start, so restart OpenCode to steer live sessions.',
          );
          if (changed === 0 && result.conflicts.length > 0) console.log('  Existing files were preserved; pass --force to replace them.');
          return 0;
        }
        if (applyTarget === 'omp') {
          const result = runSteeringApplyOmp({ target: 'omp', force: values.force, scope: values.scope as 'project' | 'user' | undefined });
          const changed = result.results.filter((item) => item.status !== 'skipped').length;
          console.log(`omp steering materialized: ${result.scope}`);
          for (const [archetype, slot] of Object.entries(result.materialization)) {
            const how = slot.kind === 'host' ? 'in-session agent' : 'dispatch broker';
            console.log(`  ${archetype} → ${how} ${slot.executor}`);
          }
          for (const path of result.removed ?? []) console.log(`  removed stale managed agent: ${path}`);
          console.log(`  ${changed} file(s) written under .omp/; restart omp so agents and the extension load.`);
          if (changed === 0 && result.conflicts.length > 0) console.log('  Existing files were preserved; pass --force to replace them.');
          return 0;
        }
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
    case 'playbooks': {
      if (positionals.length > 2) throw new Error('Usage: fadeno playbooks [<name>] [--json]');
      const result = runPlaybooks({ playbook: positionals[1] });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else if (result.kind === 'list') printPlaybooksList(result);
      else printPlaybooksDetail(result);
      return 0;
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
      if (values.omp) {
        const { outDir, results } = runOmpPlugin({ outDir: positionals[1], force: values.force });
        const counts = { created: 0, overwritten: 0, appended: 0, skipped: 0 };
        for (const r of results) counts[r.status] += 1;
        console.log(`Generated Fadeno omp plugin in ${outDir}`);
        console.log(`  ${counts.created} created, ${counts.overwritten} overwritten, ${counts.skipped} skipped.`);
        // Marketplace root is the repo root (where .omp-plugin/marketplace.json
        // lives), not the plugin dir — pass `.`, not the payload path.
        console.log('\nTest it: `omp plugin marketplace add . && omp plugin install fadeno@fadeno`');
        return 0;
      }
      if (values.grok || values.opencode) {
        throw new Error('The --grok and --opencode targets are supported by init only; no plugin generator exists for them.');
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
      if (!run) throw new Error('Usage: fadeno drive <run> [--bind role=executor] [--unbind role] [--max-transitions n] [--parallel n] [--diagnostics] [--timeout <seconds>]');
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
        unbind: values.unbind,
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
    // Top-level alias for `fadeno models ...` — same handler via grouped case
    // labels, so the two spellings cannot drift apart.
    case 'model':
    case 'models': {
      if (positionals[1] === 'add') {
        if (positionals.length !== 4 || values.harness != null) {
          throw new Error('Usage: fadeno model add <alias> <provider/id> [--json]');
        }
        const result = runModelsAdd({ alias: positionals[2]!, discoveryId: positionals[3]! });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelAdd(result);
        return 0;
      }
      if (positionals[1] === 'remove') {
        if (positionals.length !== 3 || values.harness != null) {
          throw new Error('Usage: fadeno model remove <alias> [--force] [--json]');
        }
        const result = runModelsRemove({ alias: positionals[2]!, force: Boolean(values.force) });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelRemove(result);
        return 0;
      }
      if (positionals[1] === 'verify') {
        const result = runModelsVerify({
          refs: positionals.slice(2),
          harness: values.harness ?? null,
          strict: Boolean(values.strict),
        });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelsVerify(result);
        return result.ok ? 0 : 1;
      }
      if (values.harness != null) {
        if (positionals.length > 1) throw new Error('Usage: fadeno models --harness <id>  (no positional with --harness)');
        const result = runModelsHarness({ harness: values.harness });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelsHarness(result);
        return 0;
      }
      if (positionals.length > 2) throw new Error('Usage: fadeno models [<name>] [--harness <id>] [--json]');
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
        const shadowUsage = 'Usage: fadeno dial shadow [<archetype> <model>[@effort] [--harness <id>] [--rate <r>] [--n <count>]]';
        if (positionals.length > 4) throw new Error(shadowUsage);
        const archetype = positionals[2];
        const model = positionals[3];
        if (archetype != null && model == null) throw new Error(shadowUsage);
        return runShadowCommand(archetype, model, { harness: values.harness ?? null, rate: values.rate, n: values.n, json: Boolean(values.json) });
      }
      if (sub === 'resolve') {
        // `--prompt-sha256` is the CALLER's prompt digest — sha256 of the bytes
        // handed to Fadeno, before any kernel decoration (no archetype brief,
        // no result-protocol footer) and with trailing newlines stripped, since
        // the relay's heredoc adds one on the way to the kernel. The kernel
        // re-derives that same digest to re-roll the pair, so a digest taken
        // after decoration — or over raw bytes a transport will change —
        // answers a different question than the dispatch will.
        if (!values.archetype) {
          throw new Error(
            'Usage: fadeno dial resolve --archetype <name> ' +
              '[--prompt-sha256 <hex: the caller\'s prompt bytes, before any kernel decoration, trailing newlines stripped>]',
          );
        }
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
        const results = runDialSetMany({ archetypes, model, harness: values.harness ?? null, session: Boolean(values.session), user: Boolean(values.user), repo: Boolean(values.repo) });
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
          if (result.codex_materialization != null) {
            console.log(
              `NOTE: Codex managed agent still says ${result.codex_materialization.detail}; ${result.codex_materialization.remediation}`,
            );
          }
        }
        return 0;
      }
      throw new Error('Usage: fadeno dial [<archetype> [<model>[@effort] [--harness <id>] [--session|--user|--repo]] | clear [<archetype>] [--session|--user|--repo] | shadow [<archetype> <model>[@effort] [--harness <id>] [--rate <r>] [--n <count>]] | clear-shadow [<archetype>] | resolve --archetype <name>]');
    }
    // Top-level alias for `fadeno dial shadow ...` — same handler
    // (`runShadowCommand`) as the `dial` subcommand above, so the two
    // spellings cannot drift apart.
    case 'shadow': {
      const shadowUsage = 'Usage: fadeno shadow [<archetype> <model>[@effort] [--harness <id>] [--rate <r>] [--n <count>]]';
      if (positionals.length > 3) throw new Error(shadowUsage);
      const archetype = positionals[1];
      const model = positionals[2];
      if (archetype != null && model == null) throw new Error(shadowUsage);
      return runShadowCommand(archetype, model, { harness: values.harness ?? null, rate: values.rate, n: values.n, json: Boolean(values.json) });
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
        harness: values.harness ?? null,
        tag: values.tag,
        shadow: values.shadow,
        timeoutMs: dispatchTimeoutMs,
        isolate: Boolean(values.isolate),
        shared: Boolean(values.shared),
        allowRelayMismatch: Boolean(values['allow-relay-mismatch']),
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
      // The quarantine banner goes to STDOUT, ahead of the report, and only
      // when a person used --allow-relay-mismatch to get here (without it the
      // dispatch was refused and never reached this line).
      //
      // stdout is normally the executor's pure report, and breaking that is
      // the deliberate cost. A proxy relays stdout and discards stderr, so a
      // warning on stderr about bytes on stdout is a warning that does not
      // reach the one reader who must not act on them. Better a report with a
      // banner on it than a tainted report that looks clean.
      if (result.relayAttested === false) {
        process.stdout.write(
          `${relayQuarantineNotice(result.dispatchId, result.relayAttested, result.relayMismatchAllowed)}\n\n`,
        );
      }
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      if (result.outcome === 'timeout') {
        // A signal-killed process has no exit status; `exitCode` is a stand-in
        // 1, and "exited 1" would hide the one fact that matters: the kernel
        // killed this executor at its own deadline, so the work did not finish.
        const deadline = result.timeoutMs != null ? `${Math.round(result.timeoutMs / 1000)}s ` : '';
        console.error(
          `dispatch: executor ${result.executor} TIMED OUT — the kernel killed it at its ${deadline}deadline` +
            `${result.signal != null ? ` (${result.signal})` : ''}; the work did NOT finish. ` +
            `${result.outputBytes} bytes of output were captured before the kill. ` +
            'Re-dispatch with a larger --timeout, or none, rather than into the same wall.',
        );
      } else if (result.exitCode !== 0) {
        // CLI-level diagnosis on stderr — a quiet executor otherwise leaves
        // only a bare exit code. stdout stays the executor's pure report.
        console.error(
          result.signal != null
            ? `dispatch: executor ${result.executor} was killed by ${result.signal}`
            : `dispatch: executor ${result.executor} exited ${result.exitCode}`,
        );
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
    case 'dispatch-withdraw': {
      const [, run, dispatchId] = positionals;
      if (!run || !dispatchId || !values.reason) {
        throw new Error('Usage: fadeno dispatch-withdraw <run> <dispatch-id> --reason <text>');
      }
      const result = runDispatchWithdraw({ run, dispatchId, reason: values.reason });
      console.log(
        `${result.dispatchId} withdrawn${result.idempotent ? ' (idempotent)' : ''}` +
          `${result.workspaceRemoved ? '; isolated workspace removed' : ''}`,
      );
      if (result.workspaceError != null) console.error(result.workspaceError);
      console.log(`Resume with \`fadeno drive ${run}\`.`);
      return 0;
    }
    case 'attempt-accept': {
      const [, run, actorCallId] = positionals;
      if (!run || !actorCallId) throw new Error('Usage: fadeno attempt-accept <run> <actor-call-id>');
      const result = runAttemptAccept({ run, actorCallId, onAction: (line) => console.error(line) });
      console.log(
        `accepted ${result.actorCallId}: attempt ${result.attempt} (host_resolved) merged ${result.diffBytes} bytes into the workspace` +
          `${result.mergeBack.rebased_onto != null ? ` (rebased onto ${result.mergeBack.rebased_onto.slice(0, 12)} first)` : ''} and wrote ${result.output}; ` +
          `the worktree ${result.workspace} is removed.`,
      );
      console.log(`Resume with \`fadeno drive ${result.runId}\`.`);
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
      if (values.withdraw != null) {
        const inline = values.withdraw.startsWith('tag:') ? values.withdraw.slice(4) : null;
        const result = runDispatchesWithdraw({
          dispatchId: inline != null ? '' : values.withdraw,
          tag: inline ?? values.tag,
          reason: values.reason,
          workLeft: values['work-left'] ?? null,
        });
        const how = result.resolvedBy === 'tag' ? ` (tag: ${result.tag})` : '';
        console.log(
          `withdrawn: ${result.dispatchId.slice(0, 8)}${how}${result.idempotent ? ' (idempotent)' : ''} — ${result.reason}`,
        );
        // Say what was RECORDED and what was not touched. A withdraw signals
        // nothing and deletes nothing; a reader who assumed otherwise would
        // stop looking for the work this dispatch may have left behind.
        console.log(
          `  a dispatch_withdrawn row is the terminal receipt; nothing was signalled and no workspace was removed` +
            `${result.claim === 'stale' ? ' (a stale in-flight claim was found and left in place)' : ''}.`,
        );
        if (result.workLeft != null) {
          console.log(`  recorded as still holding this dispatch's work: ${result.workLeft}`);
        } else {
          console.log('  no tree was named as holding its work; add `--work-left <path>` if it left edits behind.');
        }
        return 0;
      }
      if (values.merge != null) {
        const inline = values.merge.startsWith('tag:') ? values.merge.slice(4) : null;
        const result = runDispatchesMerge({
          dispatchId: inline != null ? '' : values.merge,
          tag: inline ?? values.tag,
          allowRelayMismatch: Boolean(values['allow-relay-mismatch']),
        });
        const how = result.resolvedBy === 'tag' ? ` (tag: ${result.tag})` : '';
        console.log(
          `merged ${result.dispatchId.slice(0, 8)}${how}: ${result.diffBytes} bytes applied to the workspace from ${result.workspace}` +
            `${result.mergeBack.rebased_onto != null ? ` (rebased onto ${result.mergeBack.rebased_onto.slice(0, 12)} first)` : ''}; the worktree is removed.`,
        );
        console.log(`  diff kept at ${result.diffSnapshot}; a dispatch_merged row records the merge.`);
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
          // Progress goes to stderr so stdout stays relay-safe; a host agent
          // blocked on this call sees life instead of a hang.
          onHeartbeat: (line) => console.error(line),
        });
        // stdout carries the snapshot bytes (relay-safe); the attestation
        // verdict goes to stderr so piping stays clean.
        //
        // One exception, and it is the reason this fix exists: when the relay
        // attestation failed, `result.bytes` already carries the quarantine
        // banner ahead of the report. Everything else here is a caveat ABOUT
        // the bytes and can live on stderr; that one says the bytes answer a
        // different question, and stderr is discarded on exactly the
        // recover-by-tag path this command serves.
        process.stdout.write(result.bytes);
        // The verdict leads. "attested" only says these are the bytes the
        // completion row hashed — a dispatch the kernel killed at its
        // deadline attests perfectly, zero bytes to zero bytes, and on
        // 2026-08-22 a proxy relayed exactly that as "completed". The bytes
        // are worthless without the verdict, so the verdict is what a relay
        // must carry, and it is spelled in capitals a reader cannot miss.
        const verdict = ((): string | null => {
          switch (result.outcome) {
            case 'timeout': {
              const deadline = result.timeoutMs != null ? `${Math.round(result.timeoutMs / 1000)}s ` : '';
              return (
                `TIMED OUT: the kernel killed the executor at its ${deadline}deadline` +
                `${result.signal != null ? ` (${result.signal})` : ''}; the work did NOT finish. ` +
                `${result.outputBytes ?? 0} bytes of output were captured before the kill. ` +
                'Re-dispatch with a larger --timeout, or none, rather than into the same wall.'
              );
            }
            case 'failed':
              if (result.signal == null && result.exitCode === 0) {
                // Only the executor's outcome claim lands here: every other
                // failed derivation has a nonzero exit or a signal behind it.
                return 'FAILED: exit 0, but the report claimed failure (FADENO-DISPATCH-RESULT: failed) — do not relay this as a success';
              }
              return result.signal != null
                ? `FAILED: the executor was killed by ${result.signal}`
                : `FAILED: exit ${result.exitCode ?? '?'}`;
            case 'empty':
              return 'NO OUTPUT: exit 0 with 0 bytes — nothing to relay';
            case 'ok':
              return `ok: exit 0, ${result.outputBytes ?? '?'} bytes`;
            default:
              return null;
          }
        })();
        const merge = result.primaryMerge == null
          ? null
          : result.primaryMerge.status === 'unresolved'
            ? `merge-back UNRESOLVED: the work conflicts with the workspace and did NOT land; the worktree is retained with conflict markers` +
              `${result.workspace != null ? ` at ${result.workspace}` : ''}${result.primaryMerge.detail != null ? ` (${result.primaryMerge.detail})` : ''}. ` +
              `Resolve them there, then \`fadeno dispatches --merge ${result.dispatchId.slice(0, 8)}\``
            : result.primaryMerge.status === 'conflicted'
              ? `merge-back CONFLICTED: the tree MAY be partly applied — inspect \`git status\`${result.primaryMerge.detail != null ? ` (${result.primaryMerge.detail})` : ''}`
            : result.primaryMerge.status === 'blocked'
              ? `merge-back BLOCKED: nothing was applied, the workspace is untouched${result.primaryMerge.detail != null ? ` (${result.primaryMerge.detail})` : ''}`
              : result.primaryMerge.detail != null
                ? `merge-back clean: ${result.primaryMerge.detail}`
                : null;
        const attestation =
          result.attested === 'match'
            ? 'output attested: sha matches the completion row'
            : result.attested === 'mismatch'
              ? 'WARNING: snapshot sha does not match the completion row (file changed after the dispatch?)'
              : result.withdrawn
                ? 'WITHDRAWN: an operator retired this dispatch' +
                  `${result.withdrawnReason != null ? ` (${result.withdrawnReason})` : ''}; these are all the bytes ` +
                  'it ever produced and no completion row is coming. Do not wait on it.'
              : waitMs > 0
                ? `STILL RUNNING: no completion row after waiting ${Math.round(waitMs / 1000)}s. ` +
                  'The executor has not exited; this is its output so far. Not a failure — ' +
                  're-run this command to check again.'
                : 'no completion row recorded YET: the executor may still be running, and the ' +
                  'kernel writes that row only when it exits. This is its output so far, not a ' +
                  'failure. Re-run with --wait <seconds> to wait for the real answer.';
        // Repeated on stderr as well as in the bytes. The banner is what
        // survives a relay; this is what a human watching the terminal sees
        // first, and neither is a substitute for the other.
        const relay = result.relayAttested === false
          ? `RELAY FIDELITY FAILED (relay_attested: false${result.relayMismatchAllowed ? ', dispatched under --allow-relay-mismatch' : ''}) — ` +
            'the report above answers a prompt the caller never wrote; do not relay it as an answer'
          : null;
        const note = [relay, verdict, merge, attestation].filter((part) => part != null).join('; ');
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
        'Usage: fadeno bakeoff <pair-id|dispatch-id> [--measure-only] [--judge <ref>] [--harness <id>] [--evidence inlined|explored]\n' +
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
        judgeHarness: values.harness ?? null,
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
      console.error(renderGlobalHelp());
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

#!/usr/bin/env node
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { runDiagram } from './commands/diagram.ts';
import { runGate } from './commands/gate.ts';
import { runInit, type Target } from './commands/init.ts';
import { runNewRun } from './commands/new-run.ts';
import { runCodexPlugin, runPlugin } from './commands/plugin.ts';
import { runNext } from './commands/next.ts';
import { runPrompt } from './commands/prompt.ts';
import { runRun } from './commands/run.ts';
import { runRuns } from './commands/runs.ts';
import { runShow } from './commands/show.ts';
import { runValidate } from './commands/validate.ts';
import { runVerify, type VerifyResult } from './commands/verify.ts';
import type { DiagramFormat } from './lib/diagram.ts';
import type { EmitResult } from './lib/fsutil.ts';
import type { SchemaKind, ValidationIssue } from './lib/playbook-validate.ts';
import { findRepoRoot, packageVersion } from './lib/paths.ts';
import type { RunEvent, RunSummary } from './lib/run-ledger.ts';
import type { ValidateOutcome } from './commands/validate.ts';
import type { ShowResult } from './commands/show.ts';

const HELP = `fadeno — the playbook layer for AI coding agents

Usage:
  fadeno init --codex|--claude [opts]   Scaffold (see --with-hooks, --data-only)
  fadeno validate [file] [--schema K]   Validate playbooks (schema + references + semantics)
  fadeno diagram <playbook> [--format]  Render a playbook's flow (ascii | mermaid)
  fadeno new-run <playbook> <task>      Create a new run-ledger directory
  fadeno run <run> [flags]              Update a run ledger (run.yaml + events.jsonl)
  fadeno gate <run> <condition>         Evaluate a gate condition from a structured artifact
  fadeno prompt <run> <step> [flags]    Assemble (and record) a step's actor prompt
  fadeno next <run>                     Emit the next actionable step (JSON flow cursor)
  fadeno runs                           List run ledgers under .fadeno/runs/
  fadeno show <run>                     Show a run summary, timeline, and artifacts
  fadeno verify <run> [--allow-failed]  Re-audit a run's deterministic gate claims (or --latest)
  fadeno plugin [dir] [--codex]         Generate a Claude Code (default) or Codex plugin

Options:
  --with-hooks            (init) Also scaffold tier-2 enforcement hooks
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
  --latest                (verify) Audit the newest run instead of a named one
  --allow-failed          (verify) Accept an honest failed/aborted terminal
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  fadeno init --codex --with-hooks
  fadeno validate
  fadeno validate .fadeno/runs/2026-05-30-1132-csv/run.yaml --schema run
  fadeno new-run code-change-review "Add CSV export for reports"
  fadeno run 2026-05-30-1132-csv --step review
  fadeno run 2026-05-30-1132-csv --status completed
  fadeno run 2026-05-30-1132-csv --event artifact_created --artifact artifacts/x.json --member architect_fable
  fadeno run 2026-05-30-1132-csv --step arbitrate --event human_decision --field branch=approve
  fadeno gate 2026-05-30-1132-csv no_blocking_issues --artifact artifacts/review-report.json
  fadeno prompt 2026-05-30-1132-csv cross_review --actor architect_fable --no-record
  fadeno next 2026-05-30-1132-csv
  fadeno runs
  fadeno show 2026-07-10-2212
  fadeno verify --latest
`;

const SIGIL: Record<Target, string> = { codex: '$', claude: '/' };
const SCHEMA_KINDS: SchemaKind[] = ['playbook', 'run', 'review-report', 'test-result'];

function printInitSummary(
  target: Target,
  repoRoot: string,
  results: EmitResult[],
  withHooks: boolean,
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
    console.log('  3. Use the /fadeno:runner skill (from the installed Fadeno plugin)');
  } else {
    console.log(`  3. Ask your agent to use the ${SIGIL[target]}fadeno-runner skill on a complex task`);
  }
  if (withHooks) {
    console.log('  4. Activate enforcement: see .fadeno/hooks/README.md');
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
  return `${run.runId}  [${status}]  ${playbook} — ${task}`;
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

function printShow(repoRoot: string, result: ShowResult): void {
  const { run, events, badLines, artifacts } = result;
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

  const eventLabel = events.length === 1 ? 'event' : 'events';
  console.log(`\ntimeline (${events.length} ${eventLabel})`);
  for (const event of events) {
    console.log(`  ${utcTime(event.timestamp)}  ${renderEvent(event)}`);
  }
  for (const lineNo of badLines) {
    console.log(`  line ${lineNo}: unparseable event (skipped)`);
  }

  console.log(`\nartifacts (${artifacts.length})`);
  for (const art of artifacts) {
    console.log(`  ${art.path}  (${art.bytes} bytes)`);
  }
}

function printVerify(result: VerifyResult): void {
  const { run, findings, ok } = result;
  console.log(`run ${run.runId}  [${run.status ?? '?'}]`);
  console.log('');
  for (const f of findings) {
    const token = f.status === 'fail' ? 'FAIL' : f.status;
    const line = `  ${token.padEnd(4)}  ${f.check.padEnd(20)}  ${f.detail}`;
    if (f.status === 'fail') console.error(line);
    else console.log(line);
  }

  const counts = { ok: 0, skip: 0, fail: 0 };
  for (const f of findings) counts[f.status] += 1;
  const summary = `\nverify: ${counts.ok} ok, ${counts.skip} skipped, ${counts.fail} failed`;
  if (ok) console.log(summary);
  else console.error(summary);
}

function requireTarget(values: { codex?: boolean; claude?: boolean }): Target {
  if (values.codex && values.claude) throw new Error('Choose only one target: --codex or --claude.');
  if (values.codex) return 'codex';
  if (values.claude) return 'claude';
  throw new Error('Specify a target: `fadeno init --codex` or `fadeno init --claude`.');
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        codex: { type: 'boolean' },
        claude: { type: 'boolean' },
        force: { type: 'boolean' },
        'with-hooks': { type: 'boolean' },
        'data-only': { type: 'boolean' },
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
        latest: { type: 'boolean' },
        'allow-failed': { type: 'boolean' },
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
    case 'init': {
      const target = requireTarget(values);
      const { repoRoot, results } = runInit({
        target,
        force: values.force,
        withHooks: values['with-hooks'],
        dataOnly: values['data-only'],
      });
      printInitSummary(
        target,
        repoRoot,
        results,
        Boolean(values['with-hooks']),
        Boolean(values['data-only']),
      );
      return 0;
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
      const { runId, runDir } = runNewRun({ playbook, task });
      console.log(`Created run ${runId}`);
      console.log(`  ${runDir}`);
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
      return 0;
    }
    case 'plugin': {
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
      const result = runNext({ run });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case 'runs': {
      const { runs } = runRuns();
      printRuns(runs);
      return 0;
    }
    case 'show': {
      const run = positionals[1];
      if (!run) throw new Error('Usage: fadeno show <run>');
      const result = runShow({ run });
      printShow(findRepoRoot(), result);
      return 0;
    }
    case 'verify': {
      const result = runVerify({
        run: positionals[1],
        latest: values.latest,
        allowFailed: values['allow-failed'],
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

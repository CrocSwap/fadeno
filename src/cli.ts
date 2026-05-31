#!/usr/bin/env node
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { runDiagram } from './commands/diagram.ts';
import { runGate } from './commands/gate.ts';
import { runInit, type Target } from './commands/init.ts';
import { runNewRun } from './commands/new-run.ts';
import { runPlugin } from './commands/plugin.ts';
import { runRun } from './commands/run.ts';
import { runValidate } from './commands/validate.ts';
import type { DiagramFormat } from './lib/diagram.ts';
import type { EmitResult } from './lib/fsutil.ts';
import type { SchemaKind, ValidationIssue } from './lib/playbook-validate.ts';
import { packageVersion } from './lib/paths.ts';
import type { ValidateOutcome } from './commands/validate.ts';

const HELP = `fadeno — the playbook layer for AI coding agents

Usage:
  fadeno init --codex|--claude [opts]   Scaffold (see --with-hooks, --data-only)
  fadeno validate [file] [--schema K]   Validate playbooks (schema + references + semantics)
  fadeno diagram <playbook> [--format]  Render a playbook's flow (ascii | mermaid)
  fadeno new-run <playbook> <task>      Create a new run-ledger directory
  fadeno run <run> [flags]              Update a run ledger (run.yaml + events.jsonl)
  fadeno gate <run> <condition>         Evaluate a gate condition from a judgment artifact
  fadeno plugin [dir]                   Generate a Claude Code plugin (default ./plugin)

Options:
  --with-hooks            (init) Also scaffold tier-2 enforcement hooks
  --data-only             (init) Seed only .fadeno/ definitions (capability via plugin)
  --force                 (init) Overwrite existing files / refresh the bootstrap section
  --schema <kind>         (validate) Force document kind: playbook | run | review-report
  --format <fmt>          (diagram) ascii (default) | mermaid
  --step <id>             (run) Set current_step and log a step_started event
  --status <status>       (run) Set status: running | completed | failed | aborted
  --event <type>          (run) Append a custom event
  --artifact <path>       (run) Attach an artifact path to the event
  --report <path>         (gate) Review-report path (default: artifacts/review-report.json)
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  fadeno init --codex --with-hooks
  fadeno validate
  fadeno validate .fadeno/runs/2026-05-30-1132-csv/run.yaml --schema run
  fadeno new-run code-change-review "Add CSV export for reports"
  fadeno run 2026-05-30-1132-csv --step review
  fadeno run 2026-05-30-1132-csv --status completed
  fadeno gate 2026-05-30-1132-csv no_blocking_issues
`;

const SIGIL: Record<Target, string> = { codex: '$', claude: '/' };
const SCHEMA_KINDS: SchemaKind[] = ['playbook', 'run', 'review-report'];

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
      if (!run) throw new Error('Usage: fadeno run <run> [--step|--status|--event|--artifact]');
      const result = runRun({
        run,
        step: values.step,
        status: values.status,
        event: values.event,
        artifact: values.artifact,
      });
      const parts: string[] = [];
      if (result.updatedFields.length) parts.push(`updated ${result.updatedFields.join(', ')}`);
      if (result.appendedEvents.length) parts.push(`logged ${result.appendedEvents.join(', ')}`);
      console.log(`${relative(process.cwd(), result.runDir) || result.runDir}: ${parts.join('; ')}`);
      return 0;
    }
    case 'plugin': {
      const { outDir, results } = runPlugin({ outDir: positionals[1], force: values.force });
      const counts = { created: 0, overwritten: 0, appended: 0, skipped: 0 };
      for (const r of results) counts[r.status] += 1;
      console.log(`Generated Fadeno plugin in ${outDir}`);
      console.log(`  ${counts.created} created, ${counts.overwritten} overwritten, ${counts.skipped} skipped.`);
      console.log('\nTest it: `claude --plugin-dir ' + relative(process.cwd(), outDir) + '`');
      return 0;
    }
    case 'gate': {
      const [, run, condition] = positionals;
      if (!run || !condition) throw new Error('Usage: fadeno gate <run> <condition>');
      const result = runGate({ run, condition, report: values.report });
      if (result.pass) {
        console.log(`PASS  ${result.condition} (0 blocking issues)`);
      } else {
        console.error(`FAIL  ${result.condition} (${result.blockingCount} blocking issue(s))`);
        for (const title of result.blockingTitles) console.error(`        - ${title}`);
      }
      return result.pass ? 0 : 1;
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

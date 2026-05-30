#!/usr/bin/env node
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { runInit, type Target } from './commands/init.ts';
import { runNewRun, NewRunError } from './commands/new-run.ts';
import { runValidate, ValidateError } from './commands/validate.ts';
import type { EmitResult } from './lib/fsutil.ts';
import { packageVersion } from './lib/paths.ts';

const HELP = `fadeno — portable playbook layer for AI coding agents

Usage:
  fadeno init --codex            Scaffold Fadeno for Codex (.agents/skills, AGENTS.md)
  fadeno init --claude           Scaffold Fadeno for Claude Code (.claude/skills, CLAUDE.md)
  fadeno validate [file]         Validate playbooks (schema + reference integrity)
  fadeno new-run <playbook> <task>
                                 Create a new run-ledger directory under .fadeno/runs

Options:
  --force                        Overwrite existing files / refresh the bootstrap section
  -h, --help                     Show this help
  -v, --version                  Show version

Examples:
  fadeno init --codex
  fadeno validate
  fadeno validate .fadeno/playbooks/code-change-review.yaml
  fadeno new-run code-change-review "Add CSV export for reports"
`;

const SIGIL: Record<Target, string> = { codex: '$', claude: '/' };

function printInitSummary(target: Target, repoRoot: string, results: EmitResult[]): void {
  const counts = { created: 0, overwritten: 0, appended: 0, skipped: 0 };
  for (const r of results) counts[r.status] += 1;

  console.log(`Fadeno initialized for ${target} in ${repoRoot}\n`);
  for (const r of results) {
    const rel = relative(repoRoot, r.path) || r.path;
    console.log(`  ${r.status.padEnd(11)} ${rel}`);
  }
  console.log(
    `\n${counts.created} created, ${counts.appended} appended, ` +
      `${counts.overwritten} overwritten, ${counts.skipped} skipped.`,
  );
  if (counts.skipped > 0) {
    console.log('Some files already existed and were left untouched. Re-run with --force to overwrite.');
  }

  const sigil = SIGIL[target];
  console.log('\nNext steps:');
  console.log('  1. Review .fadeno/playbooks and .fadeno/vocabulary.md');
  console.log('  2. Run `fadeno validate` to check the playbooks');
  console.log(`  3. Ask your agent to use the ${sigil}fadeno-runner skill on a complex task`);
}

function printValidate(repoRoot: string, outcome: ReturnType<typeof runValidate>): void {
  for (const result of outcome.results) {
    const rel = relative(repoRoot, result.file) || result.file;
    if (result.ok) {
      console.log(`  ok    ${rel}`);
    } else {
      console.log(`  FAIL  ${rel}`);
      for (const issue of result.issues) {
        const at = issue.path ? `${issue.path}: ` : '';
        console.error(`          ${at}${issue.message}`);
      }
    }
  }
  const failed = outcome.results.filter((r) => !r.ok).length;
  if (outcome.ok) {
    console.log(`\nAll ${outcome.results.length} playbook(s) valid.`);
  } else {
    console.error(`\n${failed} of ${outcome.results.length} playbook(s) invalid.`);
  }
}

function requireTarget(values: { codex?: boolean; claude?: boolean }): Target {
  if (values.codex && values.claude) {
    throw new Error('Choose only one target: --codex or --claude.');
  }
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
      const { repoRoot, results } = runInit({ target, force: values.force });
      printInitSummary(target, repoRoot, results);
      return 0;
    }
    case 'validate': {
      const outcome = runValidate({ path: positionals[1] });
      printValidate(outcome.repoRoot, outcome);
      return outcome.ok ? 0 : 1;
    }
    case 'new-run': {
      const [, playbook, task] = positionals;
      if (!playbook || !task) {
        throw new Error('Usage: fadeno new-run <playbook> "<task description>"');
      }
      const { runId, runDir } = runNewRun({ playbook, task });
      console.log(`Created run ${runId}`);
      console.log(`  ${runDir}`);
      console.log('\nThe agent (or runner skill) should now execute the playbook,');
      console.log('appending events to events.jsonl and saving outputs under artifacts/.');
      return 0;
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
  if (err instanceof ValidateError || err instanceof NewRunError) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(`Error: ${(err as Error).message}`);
  }
  process.exitCode = 1;
}

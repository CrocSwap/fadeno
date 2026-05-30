import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';

export class GateError extends Error {}

/**
 * Conditions this CLI can evaluate deterministically in v0. The point of `gate`
 * is the advisory→enforced bridge: the same check the runner applies can run in
 * CI / a pre-commit hook / a future runtime, computed from an artifact on disk.
 */
export const SUPPORTED_CONDITIONS = ['no_blocking_issues'] as const;
export type GateCondition = (typeof SUPPORTED_CONDITIONS)[number];

const DEFAULT_REPORT = join('artifacts', 'review-report.json');

export interface GateOptions {
  run: string;
  condition: string;
  /** Review-report path (relative to the run dir, or absolute). */
  report?: string;
  cwd?: string;
  repoRoot?: string;
}

export interface GateResult {
  condition: GateCondition;
  pass: boolean;
  reportPath: string;
  blockingCount: number;
  blockingTitles: string[];
}

interface Issue {
  severity?: unknown;
  title?: unknown;
}

function resolveRunDir(repoRoot: string, cwd: string, run: string): string {
  const candidates = isAbsolute(run)
    ? [run]
    : [join(repoRoot, '.fadeno', 'runs', run), resolve(cwd, run)];
  for (const candidate of candidates) {
    const dir = candidate.endsWith('run.yaml') ? candidate.slice(0, -'run.yaml'.length) : candidate;
    if (existsSync(join(dir, 'run.yaml'))) return dir;
  }
  throw new GateError(`No run found for "${run}" (looked for run.yaml under .fadeno/runs).`);
}

function collectReports(parsed: unknown): Issue[][] {
  // A report file may hold a single review report or an array of them (ReviewReport[]).
  const reports = Array.isArray(parsed) ? parsed : [parsed];
  return reports.map((report) => {
    const issues = (report as { issues?: unknown }).issues;
    if (!Array.isArray(issues)) {
      throw new GateError('Review report is malformed: expected an `issues` array.');
    }
    return issues as Issue[];
  });
}

/**
 * Evaluate a gate condition from a structured judgment artifact. Currently
 * supports `no_blocking_issues` (zero issues with severity "blocking" across all
 * reports in the file).
 */
export function runGate(opts: GateOptions): GateResult {
  if (!SUPPORTED_CONDITIONS.includes(opts.condition as GateCondition)) {
    throw new GateError(
      `Unsupported condition "${opts.condition}". Supported in v0: ${SUPPORTED_CONDITIONS.join(', ')}.`,
    );
  }
  const condition = opts.condition as GateCondition;

  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const runDir = resolveRunDir(repoRoot, cwd, opts.run);

  const reportArg = opts.report ?? DEFAULT_REPORT;
  const reportPath = isAbsolute(reportArg) ? reportArg : join(runDir, reportArg);
  if (!existsSync(reportPath)) {
    throw new GateError(
      `No review report at ${reportPath}.\n` +
        'Produce one (conforming to review-report.schema.json) or pass --report <path>.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    throw new GateError(`Could not parse review report: ${(err as Error).message}`);
  }

  const blockingTitles: string[] = [];
  for (const issues of collectReports(parsed)) {
    for (const issue of issues) {
      if (issue?.severity === 'blocking') {
        blockingTitles.push(typeof issue.title === 'string' ? issue.title : '(untitled)');
      }
    }
  }

  return {
    condition,
    pass: blockingTitles.length === 0,
    reportPath,
    blockingCount: blockingTitles.length,
    blockingTitles,
  };
}

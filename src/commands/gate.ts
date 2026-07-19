import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet, schemaErrorMessages, type SchemaKind } from '../lib/playbook-validate.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';

export class GateError extends Error {}

export const SUPPORTED_CONDITIONS = ['no_blocking_issues', 'tests_pass'] as const;
export type GateCondition = (typeof SUPPORTED_CONDITIONS)[number];

export interface GateEvaluation {
  pass: boolean;
  details: Record<string, unknown>;
}

export interface ConditionDefinition {
  acceptedArtifacts: string[];
  schema: SchemaKind;
  evaluate(document: unknown): GateEvaluation;
}

interface ReviewIssue {
  severity: string;
  title: string;
}

interface TestResultDocument {
  status: 'passed' | 'failed' | 'error';
  exit_code: number | null;
}

function reviewReports(document: unknown): Array<{ issues: ReviewIssue[] }> {
  return (Array.isArray(document) ? document : [document]) as Array<{ issues: ReviewIssue[] }>;
}

export const CONDITION_REGISTRY: Record<GateCondition, ConditionDefinition> = {
  no_blocking_issues: {
    acceptedArtifacts: ['ReviewReport', 'ReviewReport[]'],
    schema: 'review-report',
    evaluate(document): GateEvaluation {
      const blockingTitles: string[] = [];
      for (const report of reviewReports(document)) {
        for (const issue of report.issues) {
          if (issue.severity === 'blocking') blockingTitles.push(issue.title);
        }
      }
      return {
        pass: blockingTitles.length === 0,
        details: { blockingCount: blockingTitles.length, blockingTitles },
      };
    },
  },
  tests_pass: {
    acceptedArtifacts: ['TestResult'],
    schema: 'test-result',
    evaluate(document): GateEvaluation {
      const result = document as TestResultDocument;
      const pass = result.status === 'passed' && result.exit_code === 0;
      return {
        pass,
        details: { status: result.status, exitCode: result.exit_code },
      };
    },
  },
};

const DEFAULT_ARTIFACTS: Record<GateCondition, string> = {
  no_blocking_issues: join('artifacts', 'review-report.json'),
  tests_pass: join('artifacts', 'test-result.json'),
};

export interface GateOptions {
  run: string;
  condition: string;
  /** Artifact path relative to the run directory, or absolute. */
  artifact?: string;
  /** Deprecated compatibility alias for `artifact`. */
  report?: string;
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface GateResult {
  condition: GateCondition;
  pass: boolean;
  result: 'pass' | 'fail';
  artifactPath: string;
  /** Deprecated compatibility alias retained for existing callers. */
  reportPath: string;
  blockingCount: number;
  blockingTitles: string[];
  details: Record<string, unknown>;
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

function appendGateEvent(writer: LedgerWriter, condition: GateCondition, artifact: string, pass: boolean, now: Date): void {
  let step: string | null = null;
  try {
    const run = parseYaml(readFileSync(join(writer.runDir, 'run.yaml'), 'utf8')) as { current_step?: unknown };
    if (typeof run.current_step === 'string') step = run.current_step;
  } catch {
    // The run was already resolved and the artifact validated; an unreadable
    // current_step should not change the gate decision or exit code.
  }
  writer.append(
    { type: 'gate_evaluated', step, condition, artifact, result: pass ? 'pass' : 'fail' },
    now,
  );
}

/** Evaluate a named condition from one schema-valid artifact file. */
export function runGate(opts: GateOptions): GateResult {
  if (!SUPPORTED_CONDITIONS.includes(opts.condition as GateCondition)) {
    throw new GateError(`Unsupported condition "${opts.condition}". Supported: ${SUPPORTED_CONDITIONS.join(', ')}.`);
  }
  if (opts.artifact && opts.report) throw new GateError('Pass only one of --artifact or deprecated --report.');
  const condition = opts.condition as GateCondition;
  const definition = CONDITION_REGISTRY[condition];
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const runDir = resolveRunDir(repoRoot, cwd, opts.run);
  // Version-gate before evaluating: gate must never append into a legacy
  // ledger, and it must refuse loudly rather than silently drop the event.
  let writer: LedgerWriter;
  try {
    writer = new LedgerWriter(runDir);
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new GateError(err.message);
    throw err;
  }
  const artifactArg = opts.artifact ?? opts.report ?? DEFAULT_ARTIFACTS[condition];
  const artifactPath = isAbsolute(artifactArg) ? artifactArg : join(runDir, artifactArg);
  if (!existsSync(artifactPath)) {
    throw new GateError(`No artifact at ${artifactPath}. Produce a schema-valid ${definition.acceptedArtifacts.join(' or ')} artifact or pass --artifact <path>.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (err) {
    throw new GateError(`Could not parse artifact ${artifactPath}: ${(err as Error).message}`);
  }

  let validate;
  try {
    validate = new SchemaSet(join(repoRoot, '.fadeno', 'schemas')).get(definition.schema);
  } catch (err) {
    throw new GateError((err as Error).message);
  }
  if (!validate(parsed)) {
    const details = schemaErrorMessages(validate).join('; ');
    throw new GateError(`Artifact ${artifactPath} is invalid for ${condition}: ${details}`);
  }

  const evaluation = definition.evaluate(parsed);
  const now = opts.now ?? new Date();
  const artifactForEvent = isAbsolute(artifactArg) ? relative(runDir, artifactArg) : artifactArg;
  appendGateEvent(writer, condition, artifactForEvent, evaluation.pass, now);
  const blockingTitles = Array.isArray(evaluation.details.blockingTitles)
    ? evaluation.details.blockingTitles.filter((title): title is string => typeof title === 'string')
    : [];
  const blockingCount = typeof evaluation.details.blockingCount === 'number'
    ? evaluation.details.blockingCount
    : blockingTitles.length;
  return {
    condition,
    pass: evaluation.pass,
    result: evaluation.pass ? 'pass' : 'fail',
    artifactPath,
    reportPath: artifactPath,
    blockingCount,
    blockingTitles,
    details: evaluation.details,
  };
}

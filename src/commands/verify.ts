import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet, schemaErrorMessages } from '../lib/playbook-validate.ts';
import {
  listRuns,
  readEvents,
  resolveRun,
  type RunEvent,
  type RunSummary,
} from '../lib/run-ledger.ts';
import { CONDITION_REGISTRY, SUPPORTED_CONDITIONS, type GateCondition } from './gate.ts';

export class VerifyError extends Error {}

export interface VerifyOptions {
  /** Run id or unique prefix. Mutually exclusive with `latest`. */
  run?: string;
  /** Verify the newest run. Mutually exclusive with `run`. */
  latest?: boolean;
  /** Accept an honest `failed`/`aborted` terminal instead of failing on it. */
  allowFailed?: boolean;
  cwd?: string;
  repoRoot?: string;
}

export type FindingStatus = 'ok' | 'fail' | 'skip';

export interface Finding {
  check: string;
  status: FindingStatus;
  detail: string;
}

export interface VerifyResult {
  run: RunSummary;
  findings: Finding[];
  /** True when no finding failed. */
  ok: boolean;
}

function resolveArtifact(runDir: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(runDir, rel);
}

/**
 * Re-audit a run ledger, recomputing every deterministic claim it makes. A trace
 * that records a gate as "pass" is re-evaluated from its artifact; if the recorded
 * and recomputed results disagree, verification fails. Strictly read-only — it
 * never calls `runGate` (which would append an event) and writes nothing.
 */
export function runVerify(opts: VerifyOptions): VerifyResult {
  const hasRun = opts.run != null;
  const wantsLatest = opts.latest === true;
  if (hasRun === wantsLatest) throw new VerifyError('Pass a run id or --latest.');

  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);

  let run: RunSummary;
  if (wantsLatest) {
    const runs = listRuns(repoRoot);
    if (runs.length === 0) throw new VerifyError('No runs found under .fadeno/runs.');
    run = runs[0]!;
  } else {
    run = resolveRun(repoRoot, opts.run!);
  }

  const schemas = new SchemaSet(join(repoRoot, '.fadeno', 'schemas'));
  const findings: Finding[] = [];

  // 1. run-schema — parse run.yaml and validate against the run schema.
  findings.push(checkRunSchema(run, schemas));

  // 2. events-parseable — a bad line is a broken audit trail; unlike `show`, fatal.
  const { events, badLines } = readEvents(run.dir);
  findings.push(checkEventsParseable(events, badLines));

  // 3. terminal-status — the run must be finalized (and honestly so).
  findings.push(checkTerminalStatus(run, opts.allowFailed === true));

  // 4. artifacts-exist — every artifact_created event's file must be on disk.
  findings.push(checkArtifactsExist(run, events));

  // 5. gate-<condition> — one finding per gate_evaluated event, in order, each
  //    recomputed from its artifact. Track the last recorded result per supported
  //    condition for the coherence check below.
  const lastResultByCondition = new Map<GateCondition, string>();
  for (const event of events) {
    if (event.type !== 'gate_evaluated') continue;
    findings.push(checkGateEvent(run, schemas, event, lastResultByCondition));
  }

  // 6. gate-coherence — a completed run's latest gate per condition must be pass.
  if (run.status === 'completed') {
    findings.push(checkGateCoherence(lastResultByCondition));
  }

  const ok = !findings.some((f) => f.status === 'fail');
  return { run, findings, ok };
}

function checkRunSchema(run: RunSummary, schemas: SchemaSet): Finding {
  const check = 'run-schema';
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(join(run.dir, 'run.yaml'), 'utf8'));
  } catch (err) {
    return { check, status: 'fail', detail: `run.yaml did not parse: ${(err as Error).message}` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { check, status: 'fail', detail: 'run.yaml is not a mapping' };
  }
  let validate;
  try {
    validate = schemas.get('run');
  } catch (err) {
    return { check, status: 'fail', detail: (err as Error).message };
  }
  if (!validate(doc)) {
    return { check, status: 'fail', detail: schemaErrorMessages(validate).join('; ') };
  }
  return { check, status: 'ok', detail: 'run.yaml is schema-valid' };
}

function checkEventsParseable(events: RunEvent[], badLines: number[]): Finding {
  const check = 'events-parseable';
  if (badLines.length > 0) {
    return {
      check,
      status: 'fail',
      detail: `${badLines.length} unparseable event line(s): ${badLines.join(', ')}`,
    };
  }
  if (events.length === 0) {
    return { check, status: 'fail', detail: 'no events recorded' };
  }
  return { check, status: 'ok', detail: `${events.length} events, 0 bad lines` };
}

function checkTerminalStatus(run: RunSummary, allowFailed: boolean): Finding {
  const check = 'terminal-status';
  const status = run.status;
  if (status === 'running') {
    return { check, status: 'fail', detail: 'incomplete trace: status is running' };
  }
  if (status === 'failed' || status === 'aborted') {
    if (allowFailed) {
      return { check, status: 'ok', detail: 'honest failure accepted (--allow-failed)' };
    }
    return { check, status: 'fail', detail: `run terminated as ${status}` };
  }
  if (status === 'completed') {
    if (run.endedAt) return { check, status: 'ok', detail: 'completed, ended_at present' };
    return { check, status: 'fail', detail: 'completed but ended_at is missing' };
  }
  return { check, status: 'fail', detail: `unexpected status: ${status ?? '(none)'}` };
}

function checkArtifactsExist(run: RunSummary, events: RunEvent[]): Finding {
  const check = 'artifacts-exist';
  const paths: string[] = [];
  for (const event of events) {
    if (event.type !== 'artifact_created') continue;
    if (typeof event.extra.artifact === 'string') paths.push(event.extra.artifact);
  }
  const missing = paths.filter((p) => !existsSync(resolveArtifact(run.dir, p)));
  if (missing.length === 0) {
    return { check, status: 'ok', detail: `${paths.length}/${paths.length} present` };
  }
  return {
    check,
    status: 'fail',
    detail: `missing ${missing.join(', ')} (${paths.length - missing.length}/${paths.length} present)`,
  };
}

function checkGateEvent(
  run: RunSummary,
  schemas: SchemaSet,
  event: RunEvent,
  lastResultByCondition: Map<GateCondition, string>,
): Finding {
  const condition = typeof event.extra.condition === 'string' ? event.extra.condition : '(unknown)';
  const check = `gate-${condition}`;

  if (!SUPPORTED_CONDITIONS.includes(condition as GateCondition)) {
    return {
      check,
      status: 'skip',
      detail: 'agent-interpreted condition, not deterministically verifiable',
    };
  }
  const supported = condition as GateCondition;
  const recorded = typeof event.extra.result === 'string' ? event.extra.result : '(none)';
  lastResultByCondition.set(supported, recorded);

  const artifactRel = typeof event.extra.artifact === 'string' ? event.extra.artifact : '';
  if (!artifactRel) {
    return { check, status: 'fail', detail: 'gate event recorded no artifact to recompute from' };
  }
  const artifactPath = resolveArtifact(run.dir, artifactRel);
  if (!existsSync(artifactPath)) {
    return { check, status: 'fail', detail: `artifact ${artifactRel} is missing; cannot recompute` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (err) {
    return { check, status: 'fail', detail: `artifact ${artifactRel} is not valid JSON: ${(err as Error).message}` };
  }

  const definition = CONDITION_REGISTRY[supported];
  let validate;
  try {
    validate = schemas.get(definition.schema);
  } catch (err) {
    return { check, status: 'fail', detail: (err as Error).message };
  }
  if (!validate(parsed)) {
    return {
      check,
      status: 'fail',
      detail: `artifact ${artifactRel} is invalid for ${supported}: ${schemaErrorMessages(validate).join('; ')}`,
    };
  }

  const recomputed = definition.evaluate(parsed).pass ? 'pass' : 'fail';
  const status: FindingStatus = recomputed === recorded ? 'ok' : 'fail';
  return { check, status, detail: `recorded ${recorded}, recomputed ${recomputed}  (${artifactRel})` };
}

function checkGateCoherence(lastResultByCondition: Map<GateCondition, string>): Finding {
  const check = 'gate-coherence';
  if (lastResultByCondition.size === 0) {
    return { check, status: 'skip', detail: 'no deterministic gate events recorded' };
  }
  const incoherent = [...lastResultByCondition.entries()].filter(([, result]) => result !== 'pass');
  if (incoherent.length === 0) {
    return { check, status: 'ok', detail: 'latest result per condition is pass' };
  }
  const detail = incoherent.map(([cond, result]) => `${cond}=${result}`).join(', ');
  return { check, status: 'fail', detail: `completed run with non-passing latest gate: ${detail}` };
}

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveActiveArtifacts, sha256Hex, type ActiveResolution } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet, schemaErrorMessages, type SchemaKind } from '../lib/playbook-validate.ts';
import {
  ledgerMode,
  listRuns,
  normalizeLegacyEvents,
  readEvents,
  resolveRun,
  RUN_LEDGER_SCHEMA_VERSION,
  RunLedgerError,
  type LedgerMode,
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
  /** Audit a pre-0.2 ledger in explicit compatibility mode. */
  legacy?: boolean;
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
  mode: LedgerMode;
  findings: Finding[];
  /** True when no finding failed. */
  ok: boolean;
}

function resolveArtifact(runDir: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(runDir, rel);
}

function skip(check: string, detail: string): Finding {
  return { check, status: 'skip', detail };
}

/**
 * Re-audit a run ledger, recomputing every deterministic claim it makes:
 * digests, typed-artifact validity, gate results, sequence integrity, and
 * status/event coherence. Anything that cannot be recomputed is reported as
 * skipped — never silently treated as valid. Strictly read-only.
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

  // Readers refuse unversioned/unknown ledgers: a legacy ledger is not
  // "verified false", it is unreadable without the explicit --legacy mode.
  let mode: LedgerMode;
  try {
    mode = ledgerMode(run, opts.legacy === true);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new VerifyError(err.message);
    throw err;
  }
  const legacy = mode === 'legacy';

  const schemas = new SchemaSet(join(repoRoot, '.fadeno', 'schemas'));
  const findings: Finding[] = [];

  // 1. ledger-version
  findings.push(
    legacy
      ? skip('ledger-version', 'legacy ledger read in compatibility mode (--legacy)')
      : { check: 'ledger-version', status: 'ok', detail: `schema_version ${RUN_LEDGER_SCHEMA_VERSION}` },
  );

  // 2. run-schema
  findings.push(
    legacy
      ? skip('run-schema', 'legacy run.yaml predates the current schema')
      : checkRunSchema(run, schemas),
  );

  // 3. events-parseable — a bad line is a broken audit trail; unlike `show`, fatal.
  const raw = readEvents(run.dir);
  const events = legacy ? normalizeLegacyEvents(raw.events) : raw.events;
  findings.push(checkEventsParseable(events, raw.badLines));

  // 4. events-seq
  findings.push(
    legacy ? skip('events-seq', 'no sequence numbers recorded (legacy ledger)') : checkEventsSeq(events),
  );

  // 5. terminal-status — the run must be finalized (and honestly so).
  findings.push(checkTerminalStatus(run, opts.allowFailed === true));

  // 6. terminal-events — run.yaml status must agree with the recorded terminal event.
  findings.push(checkTerminalEvents(run, events));

  // 7. artifact-manifests
  findings.push(
    legacy ? skip('artifact-manifests', 'no manifests recorded (legacy ledger)') : checkArtifactManifests(events),
  );

  // 8. artifacts-exist — every artifact_created event's file must be on disk.
  findings.push(checkArtifactsExist(run, events));

  // 9. artifact-digests
  findings.push(
    legacy ? skip('artifact-digests', 'no recorded digests (legacy ledger)') : checkArtifactDigests(run, events),
  );

  // 10. artifact-validation
  findings.push(
    legacy
      ? skip('artifact-validation', 'no recorded validation (legacy ledger)')
      : checkArtifactValidation(run, schemas, events),
  );

  // 11-12. immutability + active resolution, both from the shared rule.
  const resolution = resolveActiveArtifacts(events);
  findings.push(
    legacy
      ? skip('artifact-immutability', 'no recorded digests (legacy ledger)')
      : checkImmutability(resolution),
  );
  findings.push(
    legacy
      ? skip('artifact-resolution', 'no manifests recorded (legacy ledger)')
      : checkResolution(resolution),
  );

  // 13. prompt-snapshots — active in BOTH modes: prompt_assembled events have
  // carried digests since they were introduced.
  findings.push(checkPromptSnapshots(run, events));

  // 14. gate-<condition> — one finding per gate_evaluated event, in order, each
  //     recomputed from its artifact. Track the last recorded result per supported
  //     condition for the coherence check below.
  const lastResultByCondition = new Map<GateCondition, string>();
  for (const event of events) {
    if (event.type !== 'gate_evaluated') continue;
    findings.push(checkGateEvent(run, schemas, event, lastResultByCondition));
  }

  // 15. gate-coherence — a completed run's latest gate per condition must be pass.
  if (run.status === 'completed') {
    findings.push(checkGateCoherence(lastResultByCondition));
  }

  // 16. human-decisions — conflicting branches for one step are tampering or
  //     an incoherent trace; identical duplicates are idempotent.
  findings.push(checkHumanDecisions(events));

  const ok = !findings.some((f) => f.status === 'fail');
  return { run, mode, findings, ok };
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

function checkEventsSeq(events: RunEvent[]): Finding {
  const check = 'events-seq';
  const problems: string[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const expected = i + 1;
    const seq = events[i]!.seq;
    if (seq == null) problems.push(`event ${expected} (${events[i]!.type}) has no seq`);
    else if (seq !== expected) problems.push(`event ${expected} (${events[i]!.type}) has seq ${seq}, expected ${expected}`);
  }
  if (problems.length === 0) {
    return { check, status: 'ok', detail: `seq contiguous 1..${events.length}` };
  }
  const shown = problems.slice(0, 5).join('; ');
  const more = problems.length > 5 ? `; …(+${problems.length - 5} more)` : '';
  return { check, status: 'fail', detail: `${shown}${more}` };
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

const TERMINAL_EVENT_TYPES = new Set(['run_completed', 'run_failed', 'run_aborted']);

function checkTerminalEvents(run: RunSummary, events: RunEvent[]): Finding {
  const check = 'terminal-events';
  let lastTerminal: string | null = null;
  for (const event of events) {
    if (TERMINAL_EVENT_TYPES.has(event.type)) lastTerminal = event.type;
  }
  const status = run.status;
  const expected =
    status === 'completed' || status === 'failed' || status === 'aborted' ? `run_${status}` : null;
  if (expected == null) {
    if (lastTerminal == null) {
      return { check, status: 'ok', detail: `status ${status ?? '(none)'}, no terminal event` };
    }
    return {
      check,
      status: 'fail',
      detail: `run.yaml says ${status ?? '(none)'} but events record ${lastTerminal}`,
    };
  }
  if (lastTerminal === expected) {
    return { check, status: 'ok', detail: `${expected} agrees with run.yaml status` };
  }
  if (lastTerminal == null) {
    return { check, status: 'fail', detail: `run.yaml says ${status} but no terminal event is recorded` };
  }
  return {
    check,
    status: 'fail',
    detail: `run.yaml says ${status} but the last terminal event is ${lastTerminal}`,
  };
}

const MANIFEST_FIELDS: Array<[string, (value: unknown) => boolean]> = [
  ['artifact_id', (v) => typeof v === 'string'],
  ['artifact', (v) => typeof v === 'string'],
  ['logical_name', (v) => typeof v === 'string'],
  ['generation', (v) => typeof v === 'number'],
  ['bytes', (v) => typeof v === 'number'],
  ['sha256', (v) => typeof v === 'string'],
  ['media_type', (v) => typeof v === 'string'],
  ['validation', (v) => v !== null && typeof v === 'object'],
];

function checkArtifactManifests(events: RunEvent[]): Finding {
  const check = 'artifact-manifests';
  let count = 0;
  const problems: string[] = [];
  const ids = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'artifact_created') continue;
    count += 1;
    const missing = MANIFEST_FIELDS.filter(([key, okFn]) => !okFn(event.extra[key])).map(([key]) => key);
    if (missing.length > 0) {
      const label =
        typeof event.extra.artifact === 'string' ? event.extra.artifact : `(seq ${event.seq ?? '?'})`;
      problems.push(`${label}: missing ${missing.join(', ')}`);
    }
    const id = event.extra.artifact_id;
    if (typeof id === 'string') ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  for (const [id, n] of ids) {
    if (n > 1) problems.push(`artifact_id ${id} recorded ${n} times`);
  }
  if (problems.length === 0) {
    return { check, status: 'ok', detail: `${count} manifest(s), all fields present` };
  }
  return { check, status: 'fail', detail: problems.join('; ') };
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

function checkArtifactDigests(run: RunSummary, events: RunEvent[]): Finding {
  const check = 'artifact-digests';
  let checked = 0;
  let absent = 0;
  const problems: string[] = [];
  for (const event of events) {
    if (event.type !== 'artifact_created') continue;
    const rel = typeof event.extra.artifact === 'string' ? event.extra.artifact : null;
    const recordedSha = typeof event.extra.sha256 === 'string' ? event.extra.sha256 : null;
    const recordedBytes = typeof event.extra.bytes === 'number' ? event.extra.bytes : null;
    if (rel == null || recordedSha == null) continue;
    const abs = resolveArtifact(run.dir, rel);
    if (!existsSync(abs)) {
      absent += 1; // reported by artifacts-exist; nothing to recompute here
      continue;
    }
    checked += 1;
    const bytes = readFileSync(abs);
    if (sha256Hex(bytes) !== recordedSha) {
      problems.push(`${rel}: recorded sha256 does not match the bytes on disk`);
    } else if (recordedBytes != null && bytes.length !== recordedBytes) {
      problems.push(`${rel}: recorded ${recordedBytes} bytes, found ${bytes.length}`);
    }
  }
  if (problems.length > 0) {
    return { check, status: 'fail', detail: problems.join('; ') };
  }
  const absentNote = absent > 0 ? `, ${absent} missing (see artifacts-exist)` : '';
  return { check, status: 'ok', detail: `${checked}/${checked} digests match${absentNote}` };
}

function checkArtifactValidation(run: RunSummary, schemas: SchemaSet, events: RunEvent[]): Finding {
  const check = 'artifact-validation';
  let checked = 0;
  const problems: string[] = [];
  for (const event of events) {
    if (event.type !== 'artifact_created') continue;
    const validation = event.extra.validation;
    if (validation === null || typeof validation !== 'object') continue;
    const recorded = validation as { schema?: unknown; ok?: unknown };
    if (typeof recorded.schema !== 'string' || typeof recorded.ok !== 'boolean') continue;
    const rel = typeof event.extra.artifact === 'string' ? event.extra.artifact : null;
    if (rel == null) continue;
    const abs = resolveArtifact(run.dir, rel);
    if (!existsSync(abs)) continue; // covered by artifacts-exist
    checked += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      problems.push(`${rel}: recorded as ${recorded.schema} but is not valid JSON`);
      continue;
    }
    let validate;
    try {
      validate = schemas.get(recorded.schema as SchemaKind);
    } catch (err) {
      problems.push(`${rel}: ${(err as Error).message}`);
      continue;
    }
    const recomputedOk = Boolean(validate(parsed));
    if (recomputedOk !== recorded.ok) {
      problems.push(`${rel}: recorded validation ok=${String(recorded.ok)}, recomputed ok=${String(recomputedOk)}`);
    }
  }
  if (problems.length > 0) {
    return { check, status: 'fail', detail: problems.join('; ') };
  }
  return { check, status: 'ok', detail: `${checked} typed artifact(s) revalidated` };
}

function checkImmutability(resolution: ActiveResolution): Finding {
  const check = 'artifact-immutability';
  if (resolution.immutabilityViolations.length === 0) {
    return { check, status: 'ok', detail: 'no path re-recorded with different bytes' };
  }
  return { check, status: 'fail', detail: resolution.immutabilityViolations.join('; ') };
}

function checkResolution(resolution: ActiveResolution): Finding {
  const check = 'artifact-resolution';
  if (resolution.conflicts.length === 0) {
    return {
      check,
      status: 'ok',
      detail: `${resolution.active.length} active artifact(s), resolution unambiguous`,
    };
  }
  return { check, status: 'fail', detail: resolution.conflicts.join('; ') };
}

function checkPromptSnapshots(run: RunSummary, events: RunEvent[]): Finding {
  const check = 'prompt-snapshots';
  let count = 0;
  const problems: string[] = [];
  for (const event of events) {
    if (event.type !== 'prompt_assembled') continue;
    count += 1;
    const promptPath = typeof event.extra.prompt_path === 'string' ? event.extra.prompt_path : null;
    const promptSha = typeof event.extra.prompt_sha256 === 'string' ? event.extra.prompt_sha256 : null;
    if (promptPath == null || promptSha == null) {
      problems.push(`prompt_assembled (seq ${event.seq ?? '?'}) records no snapshot path/digest`);
      continue;
    }
    const abs = resolveArtifact(run.dir, promptPath);
    if (!existsSync(abs)) {
      problems.push(`${promptPath}: snapshot is missing`);
    } else if (sha256Hex(readFileSync(abs)) !== promptSha) {
      problems.push(`${promptPath}: recorded sha256 does not match the snapshot on disk`);
    }
    const inputs = Array.isArray(event.extra.inputs) ? event.extra.inputs : [];
    for (const input of inputs) {
      if (input === null || typeof input !== 'object') continue;
      const rec = input as { path?: unknown; sha256?: unknown };
      if (typeof rec.path !== 'string' || typeof rec.sha256 !== 'string') continue;
      const inputAbs = resolveArtifact(run.dir, rec.path);
      if (!existsSync(inputAbs)) {
        problems.push(`${promptPath}: input ${rec.path} is missing`);
      } else if (sha256Hex(readFileSync(inputAbs)) !== rec.sha256) {
        // Artifacts are immutable, so digests recorded at assembly time must still hold.
        problems.push(`${promptPath}: input ${rec.path} no longer matches its recorded sha256`);
      }
    }
  }
  if (count === 0) return skip(check, 'no prompt snapshots recorded');
  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return { check, status: 'ok', detail: `${count} snapshot(s), all digests match` };
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

function checkHumanDecisions(events: RunEvent[]): Finding {
  const check = 'human-decisions';
  const byStep = new Map<string, Set<string>>();
  let count = 0;
  for (const event of events) {
    if (event.type !== 'human_decision') continue;
    count += 1;
    const key = event.step ?? '(no step)';
    const branch = typeof event.extra.branch === 'string' ? event.extra.branch : '(none)';
    const set = byStep.get(key) ?? new Set<string>();
    set.add(branch);
    byStep.set(key, set);
  }
  if (count === 0) return skip(check, 'no human decisions recorded');
  const conflicting = [...byStep.entries()].filter(([, branches]) => branches.size > 1);
  if (conflicting.length === 0) {
    return { check, status: 'ok', detail: `${count} decision(s), none conflicting` };
  }
  const detail = conflicting
    .map(([step, branches]) => `${step}: ${[...branches].join(' vs ')}`)
    .join('; ');
  return { check, status: 'fail', detail: `conflicting decisions — ${detail}` };
}

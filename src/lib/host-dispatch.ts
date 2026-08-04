import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { buildArtifactManifest, sha256Hex } from './artifact-manifest.ts';
import { SchemaSet, schemaErrorMessages, type SchemaKind } from './playbook-validate.ts';
import { findRepoRoot } from './paths.ts';
import { readEventsStrict, resolveRun, RUN_LEDGER_SCHEMA_VERSION, RunLedgerError, type RunEvent } from './run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from './run-ledger-write.ts';

export class HostDispatchError extends Error {}

export interface HostDispatchRequest {
  dispatchId: string;
  run: string;
  step: string;
  actor: string | null;
  stepExecutionId: string;
  actorCallId: string;
  attempt: number;
  attemptReason: string;
  executor: string;
  model: string;
  reasoningEffort: string;
  agentType: string;
  promptPath: string;
  promptSha256: string;
  outputPath: string;
  artifactType: SchemaKind | null;
  /** Immutable feedback from the prior rejected attempt, for schema repair. */
  validationErrors?: string[];
  repairAppendix?: string;
}

export interface HostDispatchReceipt {
  dispatchId: string;
  state: 'requested' | 'started' | 'completed' | 'failed';
  idempotent: boolean;
  agentId?: string;
  outputPath?: string;
  outputSha256?: string;
}

export interface HostDispatchRequestOptions extends HostDispatchRequest {
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

export interface DispatchStartOptions {
  run: string;
  dispatchId: string;
  agentId: string;
  workspace?: string;
  branch?: string;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

export interface DispatchCompleteOptions {
  run: string;
  dispatchId: string;
  output: string;
  commit?: string;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

export interface DispatchFailOptions {
  run: string;
  dispatchId: string;
  reason: string;
  repoRoot?: string;
  cwd?: string;
  now?: Date;
}

function assertCurrentLedger(repoRoot: string, runQuery: string): { runDir: string; runId: string } {
  let run;
  try {
    run = resolveRun(repoRoot, runQuery);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new HostDispatchError(err.message);
    throw err;
  }
  if (run.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new HostDispatchError(
      run.schemaVersion == null
        ? `run "${run.runId}" is a legacy ledger; host dispatch writes only ${RUN_LEDGER_SCHEMA_VERSION} ledgers.`
        : `run "${run.runId}" has ledger schema_version "${run.schemaVersion}"; host dispatch writes only ${RUN_LEDGER_SCHEMA_VERSION}.`,
    );
  }
  return { runDir: run.dir, runId: run.runId };
}

function eventsFor(runDir: string): RunEvent[] {
  try {
    return readEventsStrict(runDir);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new HostDispatchError(err.message);
    throw err;
  }
}

function append(runDir: string, event: Record<string, unknown>, now?: Date): void {
  try {
    new LedgerWriter(runDir).append(event, now ?? new Date());
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new HostDispatchError(err.message);
    throw err;
  }
}

function requestFromEvent(run: string, event: RunEvent): HostDispatchRequest {
  if (event.extra.adapter !== 'host') {
    throw new HostDispatchError(`host dispatch request is not marked with adapter: host.`);
  }
  const stringField = (key: string): string => {
    const value = event.extra[key];
    if (typeof value !== 'string' || value.length === 0) throw new HostDispatchError(`host dispatch request is missing ${key}.`);
    return value;
  };
  const attempt = event.extra.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new HostDispatchError(`host dispatch request ${stringField('dispatch_id')} has an invalid attempt.`);
  }
  const effort = stringField('reasoning_effort');
  const agentType = stringField('agent_type');
  const artifactType = event.extra.artifact_type;
  const validationErrors = Array.isArray(event.extra.validation_errors)
    ? event.extra.validation_errors.filter((error): error is string => typeof error === 'string')
    : undefined;
  const repairAppendix = typeof event.extra.repair_appendix === 'string' ? event.extra.repair_appendix : undefined;
  return {
    dispatchId: stringField('dispatch_id'),
    run,
    step: event.step ?? stringField('step'),
    actor: typeof event.extra.actor === 'string' ? event.extra.actor : null,
    stepExecutionId: stringField('step_execution_id'),
    actorCallId: stringField('actor_call_id'),
    attempt,
    attemptReason: typeof event.extra.attempt_reason === 'string' ? event.extra.attempt_reason : 'initial',
    executor: stringField('executor'),
    model: stringField('model'),
    reasoningEffort: effort,
    agentType,
    promptPath: stringField('prompt_path'),
    promptSha256: stringField('prompt_sha256'),
    outputPath: stringField('output_path'),
    artifactType: typeof artifactType === 'string' ? artifactType as SchemaKind : null,
    ...(validationErrors != null ? { validationErrors } : {}),
    ...(repairAppendix != null ? { repairAppendix } : {}),
  };
}

function findRequest(run: string, events: RunEvent[], dispatchId: string): { request: HostDispatchRequest; event: RunEvent } {
  const matches = events.filter((event) => event.type === 'host_dispatch_requested' && event.extra.dispatch_id === dispatchId);
  if (matches.length === 0) throw new HostDispatchError(`No host dispatch request "${dispatchId}" for run "${run}".`);
  if (matches.length > 1) throw new HostDispatchError(`host dispatch "${dispatchId}" was requested more than once.`);
  return { request: requestFromEvent(run, matches[0]!), event: matches[0]! };
}

function startsFor(events: RunEvent[], dispatchId: string): RunEvent[] {
  return events.filter((event) => event.type === 'actor_dispatched' && event.extra.dispatch_id === dispatchId);
}

function terminalsFor(events: RunEvent[], dispatchId: string): RunEvent[] {
  return events.filter(
    (event) => (event.type === 'actor_completed' || event.type === 'actor_failed') && event.extra.dispatch_id === dispatchId,
  );
}

function safeRunRelative(runDir: string, value: string, label: string): string {
  const runAbsolute = resolve(runDir);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(runAbsolute, value);
  const rel = relative(runAbsolute, absolute).split('\\').join('/');
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new HostDispatchError(`${label} path escapes the run directory: ${value}`);
  }
  const runReal = realpathSync(runAbsolute);
  let cursor = runAbsolute;
  for (const segment of rel.split('/')) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new HostDispatchError(`${label} path traverses a symlink: ${value}`);
      }
    } catch (err) {
      if (err instanceof HostDispatchError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
  let existing = absolute;
  let existingReal: string;
  for (;;) {
    try {
      existingReal = realpathSync(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(existing);
      if (parent === existing) throw new HostDispatchError(`${label} path cannot be resolved: ${value}`);
      existing = parent;
    }
  }
  const suffix = relative(existing, absolute);
  const resolvedTarget = resolve(existingReal, suffix);
  const realRel = relative(runReal, resolvedTarget).split('\\').join('/');
  if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
    throw new HostDispatchError(`${label} path escapes the run directory through a symlink: ${value}`);
  }
  return rel;
}

function validationFor(
  repoRoot: string,
  request: HostDispatchRequest,
  bytes: Buffer,
): { ok: true } | { ok: false; errors: string[] } {
  if (request.artifactType == null) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    return { ok: false, errors: [`output is not valid JSON: ${(err as Error).message}`] };
  }
  const schemas = new SchemaSet(join(repoRoot, '.fadeno', 'schemas'));
  if (!schemas.has(request.artifactType)) return { ok: true };
  const validate = schemas.get(request.artifactType);
  return validate(parsed) ? { ok: true } : { ok: false, errors: schemaErrorMessages(validate) };
}

function attemptPath(request: HostDispatchRequest): string {
  const suffix = extname(request.outputPath) || '.out';
  const safeId = request.dispatchId.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `artifacts/attempts/${safeId}${suffix}`;
}

/** Add one durable request, or return the existing identical request. */
export function requestHostDispatch(opts: HostDispatchRequestOptions): HostDispatchRequest {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  const events = eventsFor(runDir);
  const existing = events.filter((event) => event.type === 'host_dispatch_requested' && event.extra.dispatch_id === opts.dispatchId);
  if (existing.length > 1) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was requested more than once.`);
  if (existing.length === 1) {
    const current = requestFromEvent(runId, existing[0]!);
    const same =
      current.step === opts.step &&
      current.actor === opts.actor &&
      current.stepExecutionId === opts.stepExecutionId &&
      current.actorCallId === opts.actorCallId &&
      current.attempt === opts.attempt &&
      current.attemptReason === opts.attemptReason &&
      current.executor === opts.executor &&
      current.model === opts.model &&
      current.reasoningEffort === opts.reasoningEffort &&
      current.agentType === opts.agentType &&
      current.promptPath === opts.promptPath &&
      current.promptSha256 === opts.promptSha256 &&
      current.outputPath === opts.outputPath &&
      current.artifactType === opts.artifactType &&
      JSON.stringify(current.validationErrors ?? null) === JSON.stringify(opts.validationErrors ?? null) &&
      current.repairAppendix === opts.repairAppendix;
    if (!same) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" conflicts with its existing request.`);
    return current;
  }
  append(
    runDir,
    {
      type: 'host_dispatch_requested',
      step: opts.step,
      actor: opts.actor,
      dispatch_id: opts.dispatchId,
      step_execution_id: opts.stepExecutionId,
      actor_call_id: opts.actorCallId,
      attempt: opts.attempt,
      attempt_reason: opts.attemptReason,
      executor: opts.executor,
      adapter: 'host',
      model: opts.model,
      reasoning_effort: opts.reasoningEffort,
      agent_type: opts.agentType,
      prompt_path: opts.promptPath,
      prompt_sha256: opts.promptSha256,
      output_path: opts.outputPath,
      artifact_type: opts.artifactType,
      host_attested: ['model', 'reasoning_effort', 'agent_type', 'agent_id'],
      ...(opts.validationErrors != null ? { validation_errors: opts.validationErrors } : {}),
      ...(opts.repairAppendix != null ? { repair_appendix: opts.repairAppendix } : {}),
    },
    opts.now,
  );
  return opts;
}

export function startHostDispatch(opts: DispatchStartOptions): HostDispatchReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  if (!opts.agentId.trim()) throw new HostDispatchError('--agent-id must not be empty.');
  const events = eventsFor(runDir);
  const { request } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length > 1) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was started more than once.`);
  if (starts.length === 1) {
    const prior = starts[0]!.extra.agent_id;
    if (prior === opts.agentId) return { dispatchId: opts.dispatchId, state: 'started', idempotent: true, agentId: opts.agentId };
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already started by a different native agent ID.`);
  }
  const terminals = terminalsFor(events, opts.dispatchId);
  if (terminals.length > 0) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a terminal receipt.`);
  append(
    runDir,
    {
      type: 'actor_dispatched',
      step: request.step,
      actor: request.actor,
      dispatch_id: request.dispatchId,
      step_execution_id: request.stepExecutionId,
      actor_call_id: request.actorCallId,
      attempt: request.attempt,
      attempt_reason: request.attemptReason,
      executor: request.executor,
      adapter: 'host',
      model: request.model,
      reasoning_effort: request.reasoningEffort,
      agent_type: request.agentType,
      prompt_path: request.promptPath,
      prompt_sha256: request.promptSha256,
      output_path: request.outputPath,
      ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
      ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
      agent_id: opts.agentId,
      workspace: opts.workspace,
      branch: opts.branch,
      host_attested: true,
      attestation: {
        model: request.model,
        reasoning_effort: request.reasoningEffort,
        agent_type: request.agentType,
        agent_id: opts.agentId,
      },
    },
    opts.now,
  );
  return { dispatchId: opts.dispatchId, state: 'started', idempotent: false, agentId: opts.agentId };
}

export function completeHostDispatch(opts: DispatchCompleteOptions): HostDispatchReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  const events = eventsFor(runDir);
  const { request } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length === 0) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" cannot complete before dispatch-start.`);
  if (starts.length > 1) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" was started more than once.`);
  const terminal = terminalsFor(events, opts.dispatchId);
  const outputFile = isAbsolute(opts.output) ? opts.output : resolve(cwd, opts.output);
  if (!existsSync(outputFile) || !statSync(outputFile).isFile()) throw new HostDispatchError(`temporary output does not exist: ${opts.output}`);
  const bytes = readFileSync(outputFile);
  const digest = sha256Hex(bytes);
  if (terminal.length > 0) {
    const prior = terminal[0]!;
    if (prior.type === 'actor_completed' && prior.extra.output_sha256 === digest) {
      return { dispatchId: opts.dispatchId, state: 'completed', idempotent: true, outputPath: typeof prior.extra.output === 'string' ? prior.extra.output : request.outputPath, outputSha256: digest };
    }
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a different terminal receipt.`);
  }

  const verdict = validationFor(repoRoot, request, bytes);
  const agentId = typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined;
  if (!verdict.ok) {
    const parked = safeRunRelative(runDir, attemptPath(request), 'invalid output attempt');
    const parkedAbs = join(runDir, parked);
    mkdirSync(join(runDir, 'artifacts', 'attempts'), { recursive: true });
    if (existsSync(parkedAbs) && sha256Hex(readFileSync(parkedAbs)) !== digest) throw new HostDispatchError(`invalid output attempt path "${parked}" already contains different bytes.`);
    if (!existsSync(parkedAbs)) writeFileSync(parkedAbs, bytes);
    append(
      runDir,
      {
        type: 'actor_completed',
        step: request.step,
        actor: request.actor,
        dispatch_id: request.dispatchId,
        step_execution_id: request.stepExecutionId,
        actor_call_id: request.actorCallId,
        attempt: request.attempt,
        executor: request.executor,
        adapter: 'host',
        model: request.model,
        reasoning_effort: request.reasoningEffort,
        agent_type: request.agentType,
        prompt_path: request.promptPath,
        prompt_sha256: request.promptSha256,
        output_path: request.outputPath,
        ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
        ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
        agent_id: agentId,
        output: parked,
        output_bytes: bytes.length,
        output_sha256: digest,
        output_valid: false,
        validation_errors: verdict.errors.slice(0, 5),
        host_attested: true,
      },
      opts.now,
    );
    return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: parked, outputSha256: digest };
  }

  const outputRel = safeRunRelative(runDir, request.outputPath, 'planned output');
  const outputAbs = join(runDir, outputRel);
  if (existsSync(outputAbs) && sha256Hex(readFileSync(outputAbs)) !== digest) {
    throw new HostDispatchError(`planned output "${outputRel}" already contains different bytes.`);
  }
  mkdirSync(dirname(outputAbs), { recursive: true });
  if (!existsSync(outputAbs)) writeFileSync(outputAbs, bytes);
  const manifest = buildArtifactManifest(runDir, outputRel, `artifact-${request.dispatchId}`, new SchemaSet(join(repoRoot, '.fadeno', 'schemas')));
  const existingManifest = events.find(
    (event) => event.type === 'artifact_created' && event.extra.dispatch_id === request.dispatchId,
  );
  if (existingManifest == null) {
    append(
      runDir,
      {
        type: 'artifact_created',
        step: request.step,
        member: request.actor,
        ...manifest,
        dispatch_id: request.dispatchId,
        step_execution_id: request.stepExecutionId,
        actor_call_id: request.actorCallId,
        attempt: request.attempt,
        agent_id: agentId,
        executor: request.executor,
        adapter: 'host',
      },
      opts.now,
    );
  } else if (existingManifest.extra.sha256 !== manifest.sha256) {
    throw new HostDispatchError(`host dispatch "${request.dispatchId}" has a conflicting artifact manifest digest.`);
  }
  append(
    runDir,
    {
      type: 'actor_completed',
      step: request.step,
      actor: request.actor,
      dispatch_id: request.dispatchId,
      step_execution_id: request.stepExecutionId,
      actor_call_id: request.actorCallId,
      attempt: request.attempt,
      executor: request.executor,
      adapter: 'host',
      model: request.model,
      reasoning_effort: request.reasoningEffort,
      agent_type: request.agentType,
      prompt_path: request.promptPath,
      prompt_sha256: request.promptSha256,
      output_path: request.outputPath,
      ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
      ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
      agent_id: agentId,
      output: outputRel,
      output_bytes: bytes.length,
      output_sha256: digest,
      output_valid: true,
      commit: opts.commit,
      host_attested: true,
    },
    opts.now,
  );
  return { dispatchId: opts.dispatchId, state: 'completed', idempotent: false, agentId, outputPath: outputRel, outputSha256: digest };
}

export function failHostDispatch(opts: DispatchFailOptions): HostDispatchReceipt {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const { runDir, runId } = assertCurrentLedger(repoRoot, opts.run);
  if (!opts.reason.trim()) throw new HostDispatchError('--reason must not be empty.');
  const events = eventsFor(runDir);
  const { request } = findRequest(runId, events, opts.dispatchId);
  const starts = startsFor(events, opts.dispatchId);
  if (starts.length === 0) throw new HostDispatchError(`host dispatch "${opts.dispatchId}" cannot fail before dispatch-start.`);
  const terminal = terminalsFor(events, opts.dispatchId);
  if (terminal.length > 0) {
    const prior = terminal[0]!;
    if (prior.type === 'actor_failed' && prior.extra.failure_reason === opts.reason) {
      return { dispatchId: opts.dispatchId, state: 'failed', idempotent: true, agentId: typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined };
    }
    throw new HostDispatchError(`host dispatch "${opts.dispatchId}" already has a different terminal receipt.`);
  }
  append(
    runDir,
    {
      type: 'actor_failed',
      step: request.step,
      actor: request.actor,
      dispatch_id: request.dispatchId,
      step_execution_id: request.stepExecutionId,
      actor_call_id: request.actorCallId,
      attempt: request.attempt,
      executor: request.executor,
      adapter: 'host',
      model: request.model,
      reasoning_effort: request.reasoningEffort,
      agent_type: request.agentType,
      prompt_path: request.promptPath,
      prompt_sha256: request.promptSha256,
      output_path: request.outputPath,
      ...(request.validationErrors != null ? { validation_errors: request.validationErrors } : {}),
      ...(request.repairAppendix != null ? { repair_appendix: request.repairAppendix } : {}),
      agent_id: starts[0]!.extra.agent_id,
      reason: 'host_failed',
      failure_reason: opts.reason,
      host_attested: true,
    },
    opts.now,
  );
  return { dispatchId: opts.dispatchId, state: 'failed', idempotent: false, agentId: typeof starts[0]!.extra.agent_id === 'string' ? starts[0]!.extra.agent_id : undefined };
}

export function listHostDispatchRequests(runDir: string): HostDispatchRequest[] {
  return eventsFor(runDir)
    .filter((event) => event.type === 'host_dispatch_requested')
    .map((event) => requestFromEvent('(unknown)', event));
}

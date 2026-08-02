import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import {
  ExecutorProfileError,
  loadExecutorProfile,
  parseExecutorProfile,
  resolveBinding,
  serializeProfile,
  type ExecutorProfile,
  type ExecutorSpec,
} from '../lib/executors.ts';
import { computeNext, FlowCursorError, type NextComputation } from '../lib/flow-cursor.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet, schemaErrorMessages, validateFile, type SchemaKind } from '../lib/playbook-validate.ts';
import type { Playbook, PlaybookStep } from '../lib/prompt-resolve.ts';
import {
  readEventsStrict,
  resolveRun,
  RUN_LEDGER_SCHEMA_VERSION,
  RunLedgerError,
  type RunEvent,
} from '../lib/run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';
import { GateError, runGate, SUPPORTED_CONDITIONS, type GateCondition } from './gate.ts';
import { PromptError, runPrompt } from './prompt.ts';
import { RunError, runRun } from './run.ts';

export class DriveError extends Error {}

/**
 * The engine: owns the run transition loop that the driver skill previously
 * asked a model to perform. Control transitions and ledger writes are the
 * engine's; executor adapters own the mechanics of invoking a harness (one
 * configured one-shot command per executor). The engine exits whenever it
 * pauses — durable files, not a resident process, make the run outlive the
 * host session.
 */

export type DriveOutcome =
  | 'terminal'
  | 'paused_human_gate'
  | 'needs_decision'
  | 'executor_failed'
  | 'output_invalid'
  | 'max_transitions';

export interface DriveDecision {
  decisionId: string;
  step: string;
  prompt: string;
  options: string[];
}

export interface DriveOptions {
  run: string;
  /** Hard cap on engine transitions per invocation (safety net over loop bounds). */
  maxTransitions?: number;
  /** Session binding overrides, each `role=executor`. Recorded as events. */
  bind?: string[];
  cwd?: string;
  repoRoot?: string;
  now?: Date;
  /** Progress callback — `cli.ts` passes console.log; the engine never prints. */
  onAction?: (line: string) => void;
}

export interface DriveResult {
  run: string;
  outcome: DriveOutcome;
  /** Terminal run status when outcome is `terminal`. */
  status: string | null;
  /** The pending decision when outcome is `paused_human_gate`. */
  decision: DriveDecision | null;
  detail: string;
  actions: string[];
  transitions: number;
}

const MAX_TRANSITIONS_DEFAULT = 50;
const SPAWN_MAX_BUFFER = 32 * 1024 * 1024;
const STDERR_TAIL = 400;

interface EngineCtx {
  runId: string;
  runDir: string;
  repoRoot: string;
  playbook: Playbook;
  schemas: SchemaSet;
  profile: ExecutorProfile;
  /** Session overrides: role key → executor name. */
  overrides: Map<string, string>;
  /** Actor calls that already consumed their one bounded repair this invocation. */
  repaired: Set<string>;
  now?: Date;
  act: (line: string) => void;
}

function locatePlaybook(repoRoot: string, name: string): string {
  const dir = join(repoRoot, '.fadeno', 'playbooks');
  for (const candidate of [`${name}.yaml`, `${name}.yml`]) {
    const path = join(dir, candidate);
    if (existsSync(path)) return path;
  }
  throw new DriveError(`Playbook "${name}" not found in ${dir}.`);
}

function loadValidatedPlaybook(repoRoot: string, name: string, schemas: SchemaSet): Playbook {
  const playbookPath = locatePlaybook(repoRoot, name);
  let playbook: Playbook;
  try {
    const parsed = parseYaml(readFileSync(playbookPath, 'utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('playbook is not a mapping');
    }
    playbook = parsed as Playbook;
  } catch (err) {
    throw new DriveError(`could not parse playbook ${name}: ${(err as Error).message}`);
  }
  const validation = validateFile(playbookPath, schemas, 'playbook');
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((issue) => `${issue.path || '/'}: ${issue.message}`).join('; ');
    throw new DriveError(`playbook ${name} is invalid; fix it before driving: ${detail}`);
  }
  return playbook;
}

/** Fresh writer per append: runRun/runGate/runPrompt each construct their own
 *  writer, so a cached `lastSeq` here would go stale and double-assign. */
function appendEvent(runDir: string, event: Record<string, unknown>, now?: Date): void {
  let writer: LedgerWriter;
  try {
    writer = new LedgerWriter(runDir);
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new DriveError(err.message);
    throw err;
  }
  writer.append(event, now ?? new Date());
}

function freshEvents(runDir: string): RunEvent[] {
  try {
    return readEventsStrict(runDir);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new DriveError(err.message);
    throw err;
  }
}

function parseBinds(bind: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of bind ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new DriveError(`Invalid --bind "${entry}"; expected role=executor.`);
    }
    out.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return out;
}

/** Snapshot the repo profile into the run dir on first engine contact; later
 *  invocations run against the snapshot (the run's truth), never a silently
 *  edited repo profile. */
function ensureProfileSnapshot(ctx: Omit<EngineCtx, 'profile'>): ExecutorProfile {
  const snapshotPath = join(ctx.runDir, 'profile.yaml');
  if (existsSync(snapshotPath)) {
    try {
      return parseExecutorProfile(readFileSync(snapshotPath, 'utf8'), 'profile.yaml (run snapshot)');
    } catch (err) {
      if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
      throw err;
    }
  }
  let profile: ExecutorProfile;
  try {
    profile = loadExecutorProfile(ctx.repoRoot).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
  const text = serializeProfile(profile);
  writeFileSync(snapshotPath, text, 'utf8');
  appendEvent(
    ctx.runDir,
    {
      type: 'profile_snapshotted',
      step: null,
      profile: 'profile.yaml',
      bytes: Buffer.byteLength(text),
      sha256: sha256Hex(text),
    },
    ctx.now,
  );
  ctx.act('profile snapshotted → profile.yaml');
  return profile;
}

/** Validate overrides against the snapshot and record each as an event once. */
function recordOverrides(ctx: EngineCtx, binds: Map<string, string>): void {
  for (const [role, executor] of binds) {
    if (!(executor in ctx.profile.executors)) {
      throw new DriveError(
        `--bind ${role}=${executor}: "${executor}" is not in the run's snapshotted profile ` +
          `(${Object.keys(ctx.profile.executors).join(', ')}).`,
      );
    }
    const prior = ctx.profile.bindings[role] ?? ctx.profile.bindings['*'] ?? null;
    ctx.overrides.set(role, executor);
    if (prior === executor) continue; // no-op override, no evidence needed
    appendEvent(
      ctx.runDir,
      { type: 'executor_override', step: null, role, executor, prior },
      ctx.now,
    );
    ctx.act(`executor override: ${role} → ${executor} (was ${prior ?? 'unbound'})`);
  }
}

function effectiveBinding(ctx: EngineCtx, role: string | null): { executor: string; spec: ExecutorSpec } {
  const key = role ?? '*';
  const overridden = ctx.overrides.get(key);
  if (overridden != null) return { executor: overridden, spec: ctx.profile.executors[overridden]! };
  try {
    const bound = resolveBinding(ctx.profile, role);
    return { executor: bound.executor, spec: bound.spec };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new DriveError(err.message);
    throw err;
  }
}

function bodyOwnerOf(playbook: Playbook, stepId: string): string | null {
  const flow = Array.isArray(playbook.flow) ? (playbook.flow as PlaybookStep[]) : [];
  for (const step of flow) {
    if (step.kind !== 'loop' || !Array.isArray(step.body)) continue;
    if ((step.body as unknown[]).includes(stepId) && typeof step.id === 'string') return step.id;
  }
  return null;
}

function countIterationStarts(events: RunEvent[], loopId: string): number {
  return events.filter((e) => e.type === 'loop_iteration_started' && e.step === loopId).length;
}

/** Index just past the Gth iteration start of `loopId`, or 0 for outer scope. */
function scopeStartIndex(events: RunEvent[], loopId: string | null, generation: number): number {
  if (loopId == null) return 0;
  let seen = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === 'loop_iteration_started' && events[i]!.step === loopId) {
      seen += 1;
      if (seen === generation) return i;
    }
  }
  return 0;
}

function stepStartedInScope(events: RunEvent[], stepId: string, from: number): boolean {
  for (let i = from; i < events.length; i += 1) {
    if (events[i]!.type === 'step_started' && events[i]!.step === stepId) return true;
  }
  return false;
}

function artifactRecorded(events: RunEvent[], path: string): boolean {
  return events.some((e) => e.type === 'artifact_created' && e.extra.artifact === path);
}

interface PriorAttempts {
  count: number;
  lastExecutor: string | null;
}

function priorAttempts(events: RunEvent[], actorCallId: string): PriorAttempts {
  let count = 0;
  let lastExecutor: string | null = null;
  for (const event of events) {
    if (event.type !== 'actor_dispatched' || event.extra.actor_call_id !== actorCallId) continue;
    count += 1;
    lastExecutor = typeof event.extra.executor === 'string' ? event.extra.executor : null;
  }
  return { count, lastExecutor };
}

type DispatchFailure =
  | { kind: 'spawn_failed'; detail: string }
  | { kind: 'exit_nonzero'; detail: string }
  | { kind: 'invalid_output'; detail: string; errors: string[] };

type DispatchOutcome = { kind: 'valid' } | DispatchFailure;

function validateTyped(
  ctx: EngineCtx,
  kind: string | null,
  text: string,
): { ok: true; parsed: unknown } | { ok: false; errors: string[] } {
  if (kind == null) return { ok: true, parsed: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`output is not valid JSON: ${(err as Error).message}`] };
  }
  const schemaKind = kind as SchemaKind;
  if (!ctx.schemas.has(schemaKind)) return { ok: true, parsed };
  const validate = ctx.schemas.get(schemaKind);
  if (validate(parsed)) return { ok: true, parsed };
  return { ok: false, errors: schemaErrorMessages(validate) };
}

function repairAppendix(errors: string[]): string {
  const listed = errors.slice(0, 5).map((e) => `- ${e}`).join('\n');
  return (
    '\n\n---\nREPAIR: your previous output failed schema validation:\n' +
    `${listed}\n` +
    'Return ONLY a corrected artifact that satisfies the schema. No prose, no fences.'
  );
}

/**
 * One executor invocation for one actor call: assemble (or reuse) the prompt
 * snapshot, dispatch the bound command, validate the output, and record only
 * facts the adapter can witness — started/failed to start, exit status, and
 * whether the output passed validation.
 */
function dispatchOnce(
  ctx: EngineCtx,
  stepId: string,
  role: string | null,
  generation: number,
  inBody: boolean,
  outputRel: string,
  artifactType: string | null,
  ids: { stepExecutionId: string; actorCallId: string },
  attempt: number,
  reason: string,
  repairErrors: string[] | null,
): DispatchOutcome {
  let promptRes;
  try {
    promptRes = runPrompt({
      run: ctx.runId,
      step: stepId,
      actor: role ?? undefined,
      iteration: inBody ? generation : undefined,
      record: true,
      repoRoot: ctx.repoRoot,
      now: ctx.now,
    });
  } catch (err) {
    if (err instanceof PromptError) throw new DriveError(err.message);
    throw err;
  }

  const { executor, spec } = effectiveBinding(ctx, role);
  const appendix = repairErrors != null ? repairAppendix(repairErrors) : null;
  const stdin = appendix != null ? promptRes.prompt + appendix : promptRes.prompt;

  const dispatched: Record<string, unknown> = {
    type: 'actor_dispatched',
    step: stepId,
    actor: role,
    step_execution_id: ids.stepExecutionId,
    actor_call_id: ids.actorCallId,
    attempt,
    attempt_reason: reason,
    executor,
    command: spec.command,
    model: spec.model,
    prompt_path: promptRes.promptPath,
    prompt_sha256: promptRes.sha256,
  };
  if (appendix != null) dispatched.repair_appendix = appendix;
  appendEvent(ctx.runDir, dispatched, ctx.now);
  ctx.act(
    `dispatch ${stepId}${role ? ` (${role})` : ''} attempt ${attempt} [${reason}] → ${executor}`,
  );

  const [cmd, ...args] = spec.command;
  const spawned = spawnSync(cmd!, args, {
    input: stdin,
    encoding: 'utf8',
    cwd: ctx.repoRoot,
    maxBuffer: SPAWN_MAX_BUFFER,
  });

  const base = {
    step: stepId,
    actor: role,
    step_execution_id: ids.stepExecutionId,
    actor_call_id: ids.actorCallId,
    attempt,
  };

  if (spawned.error != null) {
    appendEvent(
      ctx.runDir,
      { type: 'actor_failed', ...base, reason: 'spawn_failed', error: spawned.error.message },
      ctx.now,
    );
    return { kind: 'spawn_failed', detail: `${executor}: ${spawned.error.message}` };
  }
  if (spawned.status !== 0) {
    const stderrTail = (spawned.stderr ?? '').slice(-STDERR_TAIL);
    appendEvent(
      ctx.runDir,
      {
        type: 'actor_failed',
        ...base,
        reason: 'exit_nonzero',
        exit_code: spawned.status,
        stderr_tail: stderrTail,
      },
      ctx.now,
    );
    return {
      kind: 'exit_nonzero',
      detail: `${executor} exited ${spawned.status ?? '(signal)'} on ${stepId}${role ? ` (${role})` : ''}`,
    };
  }

  const stdout = spawned.stdout ?? '';
  const verdict = validateTyped(ctx, artifactType, stdout);

  if (!verdict.ok) {
    // Rejected output stays out of the planned path (the step must not look
    // done), but the bytes are evidence: park them under artifacts/attempts/.
    const ext = extname(outputRel) || '.out';
    const attemptRel = `artifacts/attempts/${ids.actorCallId}-a${attempt}${ext}`;
    const abs = join(ctx.runDir, attemptRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, stdout, 'utf8');
    appendEvent(
      ctx.runDir,
      {
        type: 'actor_completed',
        ...base,
        exit_code: 0,
        output: attemptRel,
        output_bytes: Buffer.byteLength(stdout),
        output_sha256: sha256Hex(stdout),
        output_valid: false,
        validation_errors: verdict.errors.slice(0, 5),
      },
      ctx.now,
    );
    ctx.act(`  output failed ${artifactType} validation (attempt ${attempt})`);
    return {
      kind: 'invalid_output',
      detail: `${stepId}${role ? ` (${role})` : ''}: output failed ${artifactType} validation`,
      errors: verdict.errors,
    };
  }

  const abs = join(ctx.runDir, outputRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, stdout, 'utf8');
  try {
    runRun({
      run: ctx.runId,
      event: 'artifact_created',
      artifact: outputRel,
      member: role ?? undefined,
      fields: [
        `step_execution_id=${ids.stepExecutionId}`,
        `actor_call_id=${ids.actorCallId}`,
        `attempt=${attempt}`,
      ],
      repoRoot: ctx.repoRoot,
      now: ctx.now,
    });
  } catch (err) {
    if (err instanceof RunError) throw new DriveError(err.message);
    throw err;
  }
  appendEvent(
    ctx.runDir,
    { type: 'actor_completed', ...base, exit_code: 0, output: outputRel, output_valid: true },
    ctx.now,
  );
  ctx.act(`  wrote ${outputRel}`);
  return { kind: 'valid' };
}

/** Drive one promptable step: every pending actor call, then the collective. */
function drivePromptable(ctx: EngineCtx, comp: NextComputation): DispatchFailure | null {
  const step = comp.step!;
  const stepId = step.id;
  const generation = step.loop.iteration ?? 1;
  const owner = step.loop.in_body ? bodyOwnerOf(ctx.playbook, stepId) : null;

  let events = freshEvents(ctx.runDir);

  if (owner != null && countIterationStarts(events, owner) < generation) {
    appendEvent(
      ctx.runDir,
      { type: 'loop_iteration_started', step: owner, iteration: generation },
      ctx.now,
    );
    ctx.act(`loop ${owner}: iteration ${generation} started`);
    events = freshEvents(ctx.runDir);
  }

  const scopeFrom = scopeStartIndex(events, owner, generation);
  if (!stepStartedInScope(events, stepId, scopeFrom)) {
    try {
      runRun({ run: ctx.runId, step: stepId, repoRoot: ctx.repoRoot, now: ctx.now });
    } catch (err) {
      if (err instanceof RunError) throw new DriveError(err.message);
      throw err;
    }
    ctx.act(`step ${stepId} started${generation > 1 ? ` (iteration ${generation})` : ''}`);
  }

  const actors: (string | null)[] = step.actors && step.actors.length > 0 ? step.actors : [null];
  const outputs = step.outputs ?? [];
  if (outputs.length < actors.length) {
    throw new DriveError(
      `step "${stepId}" is promptable but plans ${outputs.length} output path(s) for ${actors.length} actor(s).`,
    );
  }

  const stepExecutionId = `se-${stepId}-g${generation}`;

  for (let i = 0; i < actors.length; i += 1) {
    const role = actors[i];
    const outputRel = outputs[i]!;
    events = freshEvents(ctx.runDir);
    if (artifactRecorded(events, outputRel)) continue; // resume: already produced

    const actorCallId = role ? `ac-${stepId}-g${generation}-${role}` : `ac-${stepId}-g${generation}`;
    const ids = { stepExecutionId, actorCallId };

    let repairErrors: string[] | null = null;
    for (;;) {
      events = freshEvents(ctx.runDir);
      const prior = priorAttempts(events, actorCallId);
      const attempt = prior.count + 1;
      let reason = 'initial';
      if (repairErrors != null) {
        reason = 'schema_repair';
      } else if (prior.count > 0) {
        const { executor } = effectiveBinding(ctx, role);
        reason = executor !== prior.lastExecutor ? 'executor_override' : 'user_retry';
      }

      const outcome = dispatchOnce(
        ctx,
        stepId,
        role,
        generation,
        step.loop.in_body,
        outputRel,
        step.artifact_type,
        ids,
        attempt,
        reason,
        repairErrors,
      );

      if (outcome.kind === 'valid') break;
      if (outcome.kind === 'invalid_output' && !ctx.repaired.has(actorCallId)) {
        // One bounded re-ask per actor call per invocation, then fail honestly.
        ctx.repaired.add(actorCallId);
        repairErrors = outcome.errors;
        continue;
      }
      return outcome;
    }
  }

  if (step.collective != null) {
    events = freshEvents(ctx.runDir);
    if (!artifactRecorded(events, step.collective)) {
      const parts = actors.map((role, i) => {
        const rel = outputs[i]!;
        const abs = join(ctx.runDir, rel);
        try {
          return JSON.parse(readFileSync(abs, 'utf8')) as unknown;
        } catch (err) {
          throw new DriveError(
            `cannot assemble ${step.collective}: member output ${rel}` +
              `${role ? ` (${role})` : ''} is not valid JSON: ${(err as Error).message}`,
          );
        }
      });
      const abs = join(ctx.runDir, step.collective);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(parts, null, 2)}\n`, 'utf8');
      try {
        runRun({
          run: ctx.runId,
          event: 'artifact_created',
          artifact: step.collective,
          fields: [`step_execution_id=${stepExecutionId}`],
          repoRoot: ctx.repoRoot,
          now: ctx.now,
        });
      } catch (err) {
        if (err instanceof RunError) throw new DriveError(err.message);
        throw err;
      }
      ctx.act(`assembled collective ${step.collective}`);
    }
  }

  return null;
}

/** Evaluate a gate (or a loop's `until`) with the deterministic evaluator. */
function driveGate(ctx: EngineCtx, comp: NextComputation): void {
  const step = comp.step!;
  const gate = comp.gate!;
  if (!SUPPORTED_CONDITIONS.includes(gate.condition as GateCondition)) {
    throw new DriveError(
      `gate condition "${gate.condition}" has no deterministic evaluator; ` +
        'the engine cannot advance past it (drive the run manually or add the evaluator).',
    );
  }

  const events = freshEvents(ctx.runDir);
  if (!stepStartedInScope(events, step.id, 0) || step.kind === 'loop') {
    try {
      runRun({ run: ctx.runId, step: step.id, repoRoot: ctx.repoRoot, now: ctx.now });
    } catch (err) {
      if (err instanceof RunError) throw new DriveError(err.message);
      throw err;
    }
  }

  let result;
  try {
    result = runGate({
      run: ctx.runId,
      condition: gate.condition,
      artifact: gate.artifact,
      repoRoot: ctx.repoRoot,
      now: ctx.now,
    });
  } catch (err) {
    if (err instanceof GateError) throw new DriveError(err.message);
    throw err;
  }
  ctx.act(`gate ${gate.condition} → ${result.result}  (${gate.artifact})`);

  if (step.kind === 'loop') {
    appendEvent(
      ctx.runDir,
      {
        type: 'loop_condition_evaluated',
        step: step.id,
        condition: gate.condition,
        result: result.result,
        artifact: gate.artifact,
      },
      ctx.now,
    );
  }
}

/** Persist (or reuse) the durable named decision for a blocked human gate. */
function ensureDecisionRequested(ctx: EngineCtx, comp: NextComputation): DriveDecision {
  const stepId = comp.step!.id;
  const prompt = comp.human_gate?.prompt ?? '(no prompt declared)';
  const options = ['approve', 'reject'];

  const events = freshEvents(ctx.runDir);
  const requests = events.filter(
    (e) => e.type === 'decision_requested' && e.step === stepId && typeof e.extra.decision_id === 'string',
  );
  const resolvedIds = new Set(
    events
      .filter((e) => e.type === 'decision_resolved' && typeof e.extra.decision_id === 'string')
      .map((e) => e.extra.decision_id as string),
  );
  const pending = requests.filter((e) => !resolvedIds.has(e.extra.decision_id as string)).at(-1);
  if (pending != null) {
    const opts = Array.isArray(pending.extra.options)
      ? pending.extra.options.filter((o): o is string => typeof o === 'string')
      : options;
    return {
      decisionId: pending.extra.decision_id as string,
      step: stepId,
      prompt: typeof pending.extra.prompt === 'string' ? pending.extra.prompt : prompt,
      options: opts,
    };
  }

  const decisionId = `dec-${stepId}-${requests.length + 1}`;
  appendEvent(
    ctx.runDir,
    { type: 'decision_requested', step: stepId, decision_id: decisionId, kind: 'human_gate', prompt, options },
    ctx.now,
  );
  ctx.act(`decision requested: ${decisionId} — ${prompt}`);
  return { decisionId, step: stepId, prompt, options };
}

/**
 * Advance a run until it is terminal, pauses on a human decision, or hits
 * something the engine cannot resolve. Deterministic: every consequential
 * effect is an event, an artifact, or a run.yaml update via existing writers.
 */
export function runDrive(opts: DriveOptions): DriveResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);

  let run;
  try {
    run = resolveRun(repoRoot, opts.run);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new DriveError(err.message);
    throw err;
  }
  if (run.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new DriveError(
      run.schemaVersion == null
        ? `run "${run.runId}" is a legacy ledger (run.yaml has no schema_version); ` +
          'the engine drives only current-format ledgers. Create a new run with `fadeno new-run`.'
        : `run "${run.runId}" has ledger schema_version "${run.schemaVersion}"; ` +
          `this fadeno drives "${RUN_LEDGER_SCHEMA_VERSION}".`,
    );
  }
  if (run.playbook == null) {
    throw new DriveError(`run "${run.runId}" has no playbook recorded in run.yaml.`);
  }

  const actions: string[] = [];
  const act = (line: string): void => {
    actions.push(line);
    opts.onAction?.(line);
  };

  const schemas = new SchemaSet(join(repoRoot, '.fadeno', 'schemas'));
  const playbook = loadValidatedPlaybook(repoRoot, run.playbook, schemas);

  const base = {
    runId: run.runId,
    runDir: run.dir,
    repoRoot,
    playbook,
    schemas,
    overrides: new Map<string, string>(),
    repaired: new Set<string>(),
    now: opts.now,
    act,
  };
  const profile = ensureProfileSnapshot(base);
  const ctx: EngineCtx = { ...base, profile };
  recordOverrides(ctx, parseBinds(opts.bind));

  const maxTransitions = opts.maxTransitions ?? MAX_TRANSITIONS_DEFAULT;
  let transitions = 0;

  const finish = (
    outcome: DriveOutcome,
    detail: string,
    status: string | null = null,
    decision: DriveDecision | null = null,
  ): DriveResult => ({ run: run.runId, outcome, status, decision, detail, actions, transitions });

  for (;;) {
    if (transitions >= maxTransitions) {
      return finish(
        'max_transitions',
        `stopped after ${maxTransitions} transitions (--max-transitions); re-run to continue.`,
      );
    }
    transitions += 1;

    const events = freshEvents(ctx.runDir);
    let comp: NextComputation;
    try {
      comp = computeNext(playbook, events);
    } catch (err) {
      if (err instanceof FlowCursorError) throw new DriveError(err.message);
      throw err;
    }

    if (comp.status === 'terminal') {
      const status = comp.terminal?.status ?? 'completed';
      const current = parseYaml(readFileSync(join(ctx.runDir, 'run.yaml'), 'utf8')) as {
        status?: unknown;
      };
      if (current.status === 'running') {
        try {
          runRun({ run: ctx.runId, status, repoRoot: ctx.repoRoot, now: ctx.now });
        } catch (err) {
          if (err instanceof RunError) throw new DriveError(err.message);
          throw err;
        }
        act(`run ${status}`);
      }
      return finish('terminal', `run is terminal (${status}).`, status);
    }

    if (comp.status === 'blocked_human_gate') {
      const decision = ensureDecisionRequested(ctx, comp);
      return finish(
        'paused_human_gate',
        `paused: ${decision.prompt} — resolve with ` +
          `\`fadeno decide ${run.runId} <${decision.options.join('|')}>\` then re-run drive.`,
        null,
        decision,
      );
    }

    if (comp.status === 'needs_decision') {
      return finish('needs_decision', comp.advice);
    }

    // ready
    const step = comp.step!;
    if (step.kind === 'gate' || (step.kind === 'loop' && comp.gate != null)) {
      driveGate(ctx, comp);
      continue;
    }
    if (!step.promptable) {
      return finish(
        'needs_decision',
        `step "${step.id}" (kind ${step.kind}) is not engine-executable in this protocol; ${comp.advice}`,
      );
    }

    const failure = drivePromptable(ctx, comp);
    if (failure != null) {
      if (failure.kind === 'invalid_output') {
        return finish(
          'output_invalid',
          `${failure.detail} after the bounded repair; ` +
            're-run drive to retry, or --bind the role to another executor.',
        );
      }
      return finish(
        'executor_failed',
        `${failure.detail}; the run pauses — re-run drive to retry, or --bind the role to another executor.`,
      );
    }
  }
}

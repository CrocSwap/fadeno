import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveActiveArtifacts, sha256Hex, type ActiveResolution } from '../lib/artifact-manifest.ts';
import { eligibilityFor, parseExecutorProfile, resolveRole, type ExecutorProfile } from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { schemaDirectories } from '../lib/definitions.ts';
import {
  actorCallIdFor,
  nodeInstanceArtifactScope,
  NodeInstanceError,
  parseNodeInstanceId,
  stepExecutionIdFor,
} from '../lib/node-instance.ts';
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
  /** Audit a 0.2 or unversioned pre-0.3 ledger in explicit compatibility mode. */
  legacy?: boolean;
  /** Promoted evidence directory containing run.yaml and definitions/. */
  evidence?: string;
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

function summaryFromDirectory(dir: string): RunSummary {
  let doc: unknown;
  try { doc = parseYaml(readFileSync(join(dir, 'run.yaml'), 'utf8')); } catch (err) {
    throw new VerifyError(`evidence run.yaml did not parse: ${(err as Error).message}`);
  }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) throw new VerifyError('evidence run.yaml is not a mapping.');
  const value = doc as Record<string, unknown>;
  const text = (key: string): string | null => typeof value[key] === 'string' ? value[key] as string : null;
  const runId = text('run_id');
  if (runId == null) throw new VerifyError('evidence run.yaml has no run_id.');
  return {
    runId,
    dir,
    schemaVersion: text('schema_version'),
    playbook: text('playbook'),
    status: text('status'),
    task: text('task'),
    host: text('host'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    problems: [],
  };
}

function isInsideRun(runDir: string, path: string): boolean {
  const runAbsolute = resolve(runDir);
  const target = resolveArtifact(runDir, path);
  const rel = relative(runAbsolute, target).split('\\').join('/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
  let cursor = runAbsolute;
  for (const segment of rel.split('/').filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      return false;
    }
  }
  let existing = target;
  let existingReal: string;
  for (;;) {
    try {
      existingReal = realpathSync(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }
  const realTarget = resolve(existingReal, relative(existing, target));
  const realRel = relative(realpathSync(runAbsolute), realTarget).split('\\').join('/');
  return realRel !== '..' && !realRel.startsWith('../') && !isAbsolute(realRel);
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
  const runPathCandidate = opts.run == null ? null : resolve(cwd, opts.run);
  const evidenceDir = opts.evidence ?? (runPathCandidate != null && existsSync(join(runPathCandidate, 'run.yaml')) ? runPathCandidate : null);
  if (evidenceDir != null) {
    if (wantsLatest) throw new VerifyError('evidence is mutually exclusive with --latest.');
    run = summaryFromDirectory(resolve(evidenceDir));
  } else if (wantsLatest) {
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
  const compatibility = mode === 'compatibility';

  const schemaPaths = schemaDirectories(repoRoot);
  const snapshotSchemas = join(run.dir, 'definitions', 'schemas');
  const schemas = existsSync(snapshotSchemas)
    ? new SchemaSet(snapshotSchemas, schemaPaths.project, schemaPaths.builtin)
    : new SchemaSet(schemaPaths.project, schemaPaths.builtin);
  const findings: Finding[] = [];

  // 1. ledger-version
  findings.push(
    legacy || compatibility
      ? skip('ledger-version', `${run.schemaVersion ?? 'pre-0.3'} ledger read in explicit compatibility mode (--legacy)`)
      : { check: 'ledger-version', status: 'ok', detail: `schema_version ${RUN_LEDGER_SCHEMA_VERSION}` },
  );

  const runDocument = parseYaml(readFileSync(join(run.dir, 'run.yaml'), 'utf8')) as Record<string, unknown>;
  const snapshotRel = typeof runDocument.playbook_snapshot === 'string' ? runDocument.playbook_snapshot : null;
  const expectedPlaybookSha = typeof runDocument.playbook_sha256 === 'string' ? runDocument.playbook_sha256 : null;
  if (snapshotRel == null || expectedPlaybookSha == null) {
    findings.push(skip('playbook-provenance', 'run predates immutable playbook snapshots'));
  } else if (snapshotRel !== 'definitions/playbook.yaml') {
    findings.push({ check: 'playbook-provenance', status: 'fail', detail: `unexpected snapshot path ${snapshotRel}` });
  } else {
    const snapshotPath = join(run.dir, snapshotRel);
    findings.push(
      existsSync(snapshotPath) && sha256Hex(readFileSync(snapshotPath)) === expectedPlaybookSha
        ? { check: 'playbook-provenance', status: 'ok', detail: `${snapshotRel} matches ${expectedPlaybookSha}` }
        : { check: 'playbook-provenance', status: 'fail', detail: `${snapshotRel} is missing or its digest changed` },
    );
  }

  // 2. run-schema
  findings.push(
    legacy || compatibility
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

  // 17. actor-attempts — engine dispatch evidence: attempt ordinals contiguous
  //     per actor call, redispatches carry an allowed reason, rejected-output
  //     bytes still match their recorded digests.
  findings.push(checkActorAttempts(run, events));

  // 18. executor-bindings — every dispatch used the resolution in force at its
  //     position: explicit override → per-role pin → the run's recorded session
  //     overrides → active loadout's archetype slot → "*" default, recomputed
  //     via the kernel's resolveRole from the profile snapshot plus the ledger's
  //     resolution_snapshot; the snapshot itself matches its digest.
  findings.push(checkExecutorBindings(run, events));

  // 19. gate-eligible — an actor_dispatched `gate_eligible: false` stamp must
  //     recompute as shadow_only from the snapshot; an unstamped row must not.
  findings.push(checkGateEligible(run, events));

  // 20. named-decisions — resolutions reference a real request, select a
  //     declared option, and resolve at most once (duplicates idempotent).
  findings.push(checkNamedDecisions(events));

  // 21. artifact-supersede — supersessions reference recorded artifacts on
  //     both sides; superseding nothing (or by nothing) is incoherent.
  findings.push(checkArtifactSupersede(events));

  // 22. session-continuity — a resumed dispatch must reference a session id
  //     previously recorded for the same role under the same executor. The
  //     resumed context itself is attested (never recomputable); this checks
  //     the reference chain around it.
  findings.push(checkSessionContinuity(events));

  // 23. node-instances — compositional evidence is scoped to a canonical
  // containment path and dispatch identities are derived from that full path.
  findings.push(checkNodeInstances(events));

  // 24-27. Native host dispatches are a first-class lifecycle. A verifier must
  // fail loudly on malformed host evidence, especially when reading an older
  // ledger explicitly, rather than treating those events as ordinary actor
  // dispatches and silently dropping their native identity claims.
  findings.push(checkHostDispatchRequests(run, events, mode));
  findings.push(checkHostDispatchLifecycle(run, events, mode));
  findings.push(checkHostDispatchArtifacts(run, events, mode));
  findings.push(checkNativeAttestation(run, events, mode));

  const ok = !findings.some((f) => f.status === 'fail');
  return { run, mode, findings, ok };
}

function checkNodeInstances(events: RunEvent[]): Finding {
  const check = 'node-instances';
  const scoped = events.filter((event) => typeof event.extra.node_instance_id === 'string');
  if (scoped.length === 0) return skip(check, 'no compositional node instances recorded');
  const problems: string[] = [];
  const generations = new Map<string, Set<number>>();
  for (const event of scoped) {
    const id = event.extra.node_instance_id as string;
    let instance;
    try {
      instance = parseNodeInstanceId(id);
    } catch (err) {
      problems.push(`${event.type} seq ${event.seq ?? '?'}: ${(err as NodeInstanceError).message}`);
      continue;
    }
    if (event.step != null && event.step !== instance.step) {
      problems.push(`${id}: event step "${event.step}" does not match instance step "${instance.step}"`);
    }
    if (event.extra.parent_instance_id !== undefined && event.extra.parent_instance_id !== instance.parentId) {
      problems.push(`${id}: parent_instance_id does not match canonical parent`);
    }
    const member = event.extra.map_member ?? event.extra.member;
    if (member !== undefined && instance.member != null && member !== instance.member) {
      problems.push(`${id}: member does not match canonical instance member`);
    }
    if (event.extra.generation !== undefined && instance.generation != null && event.extra.generation !== instance.generation) {
      problems.push(`${id}: generation does not match canonical instance generation`);
    }
    if (typeof event.extra.step_execution_id === 'string' && event.extra.step_execution_id !== stepExecutionIdFor(id)) {
      problems.push(`${id}: step_execution_id is not derived from the complete node instance`);
    }
    if (typeof event.extra.actor_call_id === 'string') {
      const actor = typeof event.extra.actor === 'string' ? event.extra.actor : null;
      if (event.extra.actor_call_id !== actorCallIdFor(id, actor)) {
        problems.push(`${id}: actor_call_id is not derived from the node instance and actor`);
      }
    }
    if (event.type === 'host_dispatch_requested' && typeof event.extra.output_path === 'string') {
      const scope = `${nodeInstanceArtifactScope(id)}/`;
      if (!event.extra.output_path.startsWith(scope)) problems.push(`${id}: planned output is outside its instance artifact scope`);
    }
    if (event.type === 'loop_iteration_started' && instance.generation != null) {
      const key = `${instance.parentId ?? ''}\0${instance.step}`;
      const set = generations.get(key) ?? new Set<number>();
      set.add(instance.generation);
      generations.set(key, set);
    }
  }
  for (const [key, values] of generations) {
    const ordered = [...values].sort((left, right) => left - right);
    if (ordered.some((value, index) => value !== index + 1)) {
      problems.push(`${key.replace('\0', '/')}: non-contiguous loop generations ${ordered.join(', ')}`);
    }
  }
  return problems.length === 0
    ? { check, status: 'ok', detail: `${scoped.length} scoped event(s) have coherent instance identity` }
    : { check, status: 'fail', detail: problems.join('; ') };
}

interface HostRequestRecord {
  id: string;
  event: RunEvent;
}

function hostRequestRecords(events: RunEvent[]): HostRequestRecord[] {
  return events
    .filter((event) => event.type === 'host_dispatch_requested' && typeof event.extra.dispatch_id === 'string')
    .map((event) => ({ id: event.extra.dispatch_id as string, event }));
}

function hostEvidencePresent(events: RunEvent[]): boolean {
  return events.some((event) => event.type === 'host_dispatch_requested' || event.extra.dispatch_id != null);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkHostDispatchRequests(run: RunSummary, events: RunEvent[], mode: LedgerMode): Finding {
  const check = 'host-dispatch-requests';
  if (!hostEvidencePresent(events)) return skip(check, 'no host dispatches recorded');
  if (mode !== 'current') {
    return { check, status: 'fail', detail: `schema ${run.schemaVersion ?? 'pre-0.3'} compatibility cannot ignore host-dispatch lifecycle evidence; recreate the run as ${RUN_LEDGER_SCHEMA_VERSION}` };
  }
  const records = hostRequestRecords(events);
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  const problems: string[] = [];
  for (const event of events) {
    if (event.type === 'host_dispatch_requested' && typeof event.extra.dispatch_id !== 'string') {
      problems.push('host_dispatch_requested has no string dispatch_id');
    }
  }
  for (const [id, count] of counts) if (count > 1) problems.push(`dispatch ${id} requested ${count} times`);
  for (const event of events) {
    if (
      event.type !== 'actor_dispatched' &&
      event.type !== 'host_dispatch_progress' &&
      event.type !== 'actor_completed' &&
      event.type !== 'actor_failed'
    ) continue;
    if (event.extra.dispatch_id != null && typeof event.extra.dispatch_id !== 'string') problems.push(`${event.type} has a non-string dispatch_id`);
    if (typeof event.extra.dispatch_id === 'string' && !counts.has(event.extra.dispatch_id)) problems.push(`${event.type} references orphan dispatch ${event.extra.dispatch_id}`);
  }
  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return { check, status: 'ok', detail: `${records.length} unique host dispatch request(s)` };
}

function checkHostDispatchLifecycle(run: RunSummary, events: RunEvent[], mode: LedgerMode): Finding {
  const check = 'host-dispatch-lifecycle';
  if (!hostEvidencePresent(events)) return skip(check, 'no host dispatches recorded');
  if (mode !== 'current') return { check, status: 'fail', detail: 'host lifecycle evidence is not verifiable from a 0.2 compatibility ledger' };
  const records = hostRequestRecords(events);
  const problems: string[] = [];
  const requestById = new Map(records.map((record) => [record.id, record.event]));
  const terminalFor = (id: string): RunEvent | undefined => events.find(
    (event) => (event.type === 'actor_completed' || event.type === 'actor_failed') && event.extra.dispatch_id === id,
  );
  const attemptsByActorCall = new Map<string, HostRequestRecord[]>();
  const actorsByActorCall = new Map<string, Set<string | null>>();
  for (const record of records) {
    const actorCallId = record.event.extra.actor_call_id;
    if (typeof actorCallId !== 'string') continue;
    const group = attemptsByActorCall.get(actorCallId) ?? [];
    group.push(record);
    attemptsByActorCall.set(actorCallId, group);
    const actors = actorsByActorCall.get(actorCallId) ?? new Set<string | null>();
    actors.add(typeof record.event.extra.actor === 'string' ? record.event.extra.actor : null);
    actorsByActorCall.set(actorCallId, actors);
  }
  for (const [actorCallId, actors] of actorsByActorCall) {
    if (actors.size > 1) {
      const labels = [...actors].map((actor) => actor ?? '(null)').sort();
      problems.push(`${actorCallId}: actor_call_id is associated with multiple actors: ${labels.join(', ')}`);
    }
  }
  const snapshotEvent = events.find((event) => event.type === 'profile_snapshotted');
  let profile: ReturnType<typeof parseExecutorProfile> | null = null;
  if (snapshotEvent == null) problems.push('host dispatch evidence has no profile_snapshotted event');
  if (snapshotEvent != null) {
    const profileRel = typeof snapshotEvent.extra.profile === 'string' ? snapshotEvent.extra.profile : 'profile.yaml';
    const profilePath = join(run.dir, profileRel);
    if (existsSync(profilePath)) {
      try {
        profile = parseExecutorProfile(readFileSync(profilePath, 'utf8'), profileRel);
      } catch (err) {
        problems.push(`host profile snapshot is invalid: ${(err as Error).message}`);
      }
    } else {
      problems.push(`host profile snapshot is missing: ${profileRel}`);
    }
  }
  for (const [id, request] of requestById) {
    for (const field of ['step_execution_id', 'actor_call_id', 'executor', 'model', 'reasoning_effort', 'agent_type', 'prompt_path', 'prompt_sha256', 'output_path'] as const) {
      if (typeof request.extra[field] !== 'string' || request.extra[field] === '') problems.push(`${id}: request is missing ${field}`);
    }
    if (request.extra.adapter !== 'host') problems.push(`${id}: request is not marked adapter host`);
    const requestedIdentity = request.extra.requested_identity ?? request.extra.host_attested;
    if (!isStringArray(requestedIdentity) || !['model', 'reasoning_effort', 'agent_type'].every((field) => requestedIdentity.includes(field))) {
      problems.push(`${id}: request does not declare the requested model, effort, and agent type`);
    }
    if (request.extra.validation_errors !== undefined && !isStringArray(request.extra.validation_errors)) {
      problems.push(`${id}: validation_errors must be an array of strings`);
    }
    if (typeof request.extra.attempt !== 'number' || !Number.isInteger(request.extra.attempt) || request.extra.attempt < 1) {
      problems.push(`${id}: request has an invalid attempt`);
    }
    if (typeof request.extra.prompt_path === 'string' && !isInsideRun(run.dir, request.extra.prompt_path)) problems.push(`${id}: prompt path escapes the run directory`);
    if (typeof request.extra.output_path === 'string' && !isInsideRun(run.dir, request.extra.output_path)) problems.push(`${id}: output path escapes the run directory`);
    if (profile != null) {
      const executor = profile.executors[request.extra.executor as string];
      if (executor == null || executor.adapter !== 'host') {
        problems.push(`${id}: request executor is not a host executor in the profile snapshot`);
      } else if (
        executor.model !== request.extra.model ||
        executor.reasoningEffort !== request.extra.reasoning_effort ||
        executor.agentType !== request.extra.agent_type
      ) {
        problems.push(`${id}: host model/effort/agent_type does not match the snapshotted executor profile`);
      }
    }
    const starts = events.filter((event) => event.type === 'actor_dispatched' && event.extra.dispatch_id === id);
    const terminals = events.filter(
      (event) => (event.type === 'actor_completed' || event.type === 'actor_failed') && event.extra.dispatch_id === id,
    );
    const progress = events.filter(
      (event) => event.type === 'host_dispatch_progress' && event.extra.dispatch_id === id,
    );
    if (starts.length === 0) {
      if (progress.length > 0) problems.push(`${id}: progress receipt has no actor_dispatched start`);
      if (terminals.length > 0) problems.push(`${id}: terminal receipt has no actor_dispatched start`);
      else if (run.status === 'completed') problems.push(`${id}: completed run has no actor_dispatched start`);
      continue;
    }
    if (starts.length > 1) problems.push(`${id}: started ${starts.length} times`);
    if (terminals.length > 1) problems.push(`${id}: has conflicting/multiple terminal receipts`);
    const start = starts[0]!;
    const terminal = terminals[0];
    const transport = start.extra.delivery_transport ?? 'native';
    if (transport !== 'native' && transport !== 'command-fallback') {
      problems.push(`${id}: start has unknown delivery_transport ${JSON.stringify(transport)}`);
    }
    if (transport === 'native') {
      if (start.extra.host_attested !== true) problems.push(`${id}: native start is not host-attested`);
      if (start.extra.identity_evidence !== 'requested_only') problems.push(`${id}: native start has invalid identity_evidence`);
      if (start.extra.fallback_command !== undefined || start.extra.fallback_command_sha256 !== undefined) {
        problems.push(`${id}: native start unexpectedly records a fallback command`);
      }
    } else if (transport === 'command-fallback') {
      const command = start.extra.fallback_command;
      if (!isStringArray(command) || command.length === 0 || command.some((part) => part.length === 0)) {
        problems.push(`${id}: command fallback does not record a non-empty argv`);
      } else {
        const commandSha = sha256Hex(JSON.stringify(command));
        if (start.extra.fallback_command_sha256 !== commandSha) problems.push(`${id}: fallback command digest does not match argv`);
        if (profile != null) {
          const executor = profile.executors[request.extra.executor as string];
          if (executor == null || executor.adapter !== 'host' || JSON.stringify(executor.fallbackCommand ?? null) !== JSON.stringify(command)) {
            problems.push(`${id}: fallback command does not match the snapshotted host executor`);
          }
        }
      }
      if (start.extra.host_attested !== false) problems.push(`${id}: command fallback is incorrectly marked host-attested`);
      if (start.extra.identity_evidence !== 'command_receipt') problems.push(`${id}: command fallback lacks command receipt identity evidence`);
      if (start.extra.attestation !== undefined) problems.push(`${id}: command fallback incorrectly records a native attestation object`);
      if (start.extra.agent_id !== `command-fallback:${String(request.extra.executor)}`) {
        problems.push(`${id}: command fallback agent_id does not identify its logical executor`);
      }
    }
    const requestIndex = events.indexOf(request);
    const startIndex = events.indexOf(start);
    const terminalIndex = terminal == null ? null : events.indexOf(terminal);
    if (startIndex <= requestIndex) problems.push(`${id}: actor_dispatched must follow host_dispatch_requested`);
    if (terminal != null && events.indexOf(terminal) <= startIndex) problems.push(`${id}: terminal receipt must follow actor_dispatched`);
    if (terminal != null && terminal.extra.agent_id !== start.extra.agent_id) problems.push(`${id}: terminal agent_id does not match start`);
    if (terminal != null) {
      for (const field of ['delivery_transport', 'fallback_command_sha256', 'host_attested', 'identity_evidence'] as const) {
        const startValue = field === 'delivery_transport' ? transport : start.extra[field];
        if (terminal.extra[field] !== startValue) problems.push(`${id}: terminal ${field} does not match start`);
      }
      if (JSON.stringify(terminal.extra.fallback_command ?? null) !== JSON.stringify(start.extra.fallback_command ?? null)) {
        problems.push(`${id}: terminal fallback_command does not match start`);
      }
    }
    for (const field of ['step', 'actor', 'step_execution_id', 'actor_call_id', 'attempt', 'executor', 'adapter', 'model', 'reasoning_effort', 'agent_type', 'prompt_path', 'prompt_sha256', 'output_path'] as const) {
      const requestValue = field === 'step' ? request.step : request.extra[field];
      const startValue = field === 'step' ? start.step : field === 'actor' ? start.extra.actor : start.extra[field];
      if (startValue !== requestValue) problems.push(`${id}: start ${field} does not match request`);
      if (terminal != null) {
        const terminalValue = field === 'step' ? terminal.step : field === 'actor' ? terminal.extra.actor : terminal.extra[field];
        if (terminalValue !== startValue) problems.push(`${id}: terminal ${field} does not match start`);
      }
    }
    for (const observation of progress) {
      const observationIndex = events.indexOf(observation);
      if (observationIndex <= startIndex) problems.push(`${id}: progress receipt must follow actor_dispatched`);
      if (terminalIndex != null && observationIndex >= terminalIndex) problems.push(`${id}: progress receipt must precede the terminal receipt`);
      if (!['agent', 'harness', 'director'].includes(String(observation.extra.observation_source))) {
        problems.push(`${id}: progress receipt has an invalid observation_source`);
      }
      if (!['running', 'waiting_input', 'blocked', 'idle'].includes(String(observation.extra.progress_state))) {
        problems.push(`${id}: progress receipt has an invalid progress_state`);
      }
      if (typeof observation.extra.report_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(observation.extra.report_sha256)) {
        problems.push(`${id}: progress receipt has an invalid report_sha256`);
      }
      if (observation.extra.host_attested !== true) problems.push(`${id}: progress receipt is not host-attested`);
      if (observation.extra.agent_id !== start.extra.agent_id) problems.push(`${id}: progress agent_id does not match start`);
      for (const field of ['step', 'actor', 'step_execution_id', 'actor_call_id', 'attempt', 'executor', 'adapter', 'model', 'reasoning_effort', 'agent_type'] as const) {
        const observed = field === 'step' ? observation.step : field === 'actor' ? observation.extra.actor : observation.extra[field];
        const started = field === 'step' ? start.step : field === 'actor' ? start.extra.actor : start.extra[field];
        if (observed !== started) problems.push(`${id}: progress ${field} does not match start`);
      }
      if (observation.extra.completed !== undefined && !isStringArray(observation.extra.completed)) {
        problems.push(`${id}: progress completed must be an array of strings`);
      }
      if (observation.extra.blockers !== undefined && !isStringArray(observation.extra.blockers)) {
        problems.push(`${id}: progress blockers must be an array of strings`);
      }
      for (const field of ['phase', 'summary', 'current', 'next', 'reported_at'] as const) {
        if (observation.extra[field] !== undefined && typeof observation.extra[field] !== 'string') {
          problems.push(`${id}: progress ${field} must be a string when present`);
        }
      }
      if (typeof observation.extra.reported_at === 'string' && Number.isNaN(Date.parse(observation.extra.reported_at))) {
        problems.push(`${id}: progress reported_at is not a timestamp`);
      }
    }
    if (start.extra.validation_errors !== undefined && !isStringArray(start.extra.validation_errors)) {
      problems.push(`${id}: start validation_errors must be an array of strings`);
    }
    if (terminal?.extra.validation_errors !== undefined && !isStringArray(terminal.extra.validation_errors)) {
      problems.push(`${id}: terminal validation_errors must be an array of strings`);
    }
    const startErrors = isStringArray(start.extra.validation_errors) ? start.extra.validation_errors : null;
    const requestErrorsForStart = isStringArray(request.extra.validation_errors) ? request.extra.validation_errors : null;
    if (JSON.stringify(startErrors) !== JSON.stringify(requestErrorsForStart)) problems.push(`${id}: start validation_errors do not match request`);
    if (start.extra.repair_appendix !== request.extra.repair_appendix) problems.push(`${id}: start repair_appendix does not match request`);
    if (terminal != null && terminal.extra.repair_appendix !== start.extra.repair_appendix) problems.push(`${id}: terminal repair_appendix does not match start`);
    const requestErrors = isStringArray(request.extra.validation_errors) ? request.extra.validation_errors : null;
    if (request.extra.attempt_reason === 'schema_repair') {
      const requestAppendix = typeof request.extra.repair_appendix === 'string' ? request.extra.repair_appendix : null;
      if (requestErrors == null || requestErrors.length === 0) {
        problems.push(`${id}: schema_repair request lacks immutable validation_errors`);
      }
      if (requestAppendix == null || requestErrors?.some((error) => !requestAppendix.includes(error))) {
        problems.push(`${id}: schema_repair request lacks validation feedback in repair_appendix`);
      }
      const priorInvalid = events
        .slice(0, requestIndex)
        .findLast((event) => event.type === 'actor_completed' && event.extra.actor_call_id === request.extra.actor_call_id && event.extra.output_valid === false);
      if (priorInvalid != null && JSON.stringify(requestErrors) !== JSON.stringify(
        Array.isArray(priorInvalid.extra.validation_errors)
          ? priorInvalid.extra.validation_errors.filter((error): error is string => typeof error === 'string')
          : null,
      )) {
        problems.push(`${id}: schema_repair validation_errors do not match the rejected attempt`);
      }
    }
    if (terminal?.type === 'actor_completed' && terminal.extra.output_valid === false && (!isStringArray(terminal.extra.validation_errors) || terminal.extra.validation_errors.length === 0)) {
      problems.push(`${id}: invalid completion lacks validation_errors`);
    }
    if (terminal?.type === 'actor_failed' && (typeof terminal.extra.failure_reason !== 'string' || terminal.extra.failure_reason.length === 0)) problems.push(`${id}: failed receipt lacks a failure reason`);
    if (run.status === 'completed' && terminal == null) problems.push(`${id}: unresolved host dispatch remains in completed run`);
  }
  let recoveredFailures = 0;
  if (run.status === 'completed') {
    for (const [actorCallId, attempts] of attemptsByActorCall) {
      const ordered = [...attempts].sort((a, b) => {
        const left = typeof a.event.extra.attempt === 'number' ? a.event.extra.attempt : Number.MAX_SAFE_INTEGER;
        const right = typeof b.event.extra.attempt === 'number' ? b.event.extra.attempt : Number.MAX_SAFE_INTEGER;
        return left - right;
      });
      const final = ordered[ordered.length - 1];
      if (final == null) continue;
      const finalTerminal = terminalFor(final.id);
      if (finalTerminal?.type !== 'actor_completed' || finalTerminal.extra.output_valid !== true) {
        problems.push(`${actorCallId}: completed run final host attempt must be a valid successful completion`);
      }
      for (const attempt of ordered) {
        const failed = terminalFor(attempt.id);
        if (failed?.type !== 'actor_failed') continue;
        const failedTerminalIndex = events.indexOf(failed);
        const ordinal = attempt.event.extra.attempt;
        const recovered = typeof ordinal === 'number' && ordered.some((candidate) => {
          const candidateOrdinal = candidate.event.extra.attempt;
          if (candidate === attempt || typeof candidateOrdinal !== 'number' || candidateOrdinal <= ordinal) return false;
          if (events.indexOf(candidate.event) <= failedTerminalIndex) return false;
          const candidateTerminal = terminalFor(candidate.id);
          if (candidateTerminal == null || events.indexOf(candidateTerminal) <= failedTerminalIndex) return false;
          return candidateTerminal?.type === 'actor_completed' && candidateTerminal.extra.output_valid === true;
        });
        if (recovered) recoveredFailures += 1;
        else problems.push(`${attempt.id}: completed run contains an unrecovered failed host dispatch`);
      }
    }
  }
  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  const recoveredDetail = recoveredFailures > 0 ? `; recovered ${recoveredFailures} historical failed attempt(s)` : '';
  return { check, status: 'ok', detail: `${records.length} request → start → terminal lifecycle(s) are coherent${recoveredDetail}` };
}

function checkHostDispatchArtifacts(run: RunSummary, events: RunEvent[], mode: LedgerMode): Finding {
  const check = 'host-dispatch-artifacts';
  if (!hostEvidencePresent(events)) return skip(check, 'no host dispatches recorded');
  if (mode !== 'current') return { check, status: 'fail', detail: 'host output evidence is not verifiable from a 0.2 compatibility ledger' };
  const problems: string[] = [];
  for (const request of hostRequestRecords(events)) {
    const terminal = events.find(
      (event) => (event.type === 'actor_completed' || event.type === 'actor_failed') && event.extra.dispatch_id === request.id,
    );
    const promptPath = typeof request.event.extra.prompt_path === 'string' ? request.event.extra.prompt_path : null;
    const promptSha = typeof request.event.extra.prompt_sha256 === 'string' ? request.event.extra.prompt_sha256 : null;
    const prompt = events.find(
      (event) => event.type === 'prompt_assembled' && event.step === request.event.step && event.extra.actor === request.event.extra.actor && event.extra.prompt_path === promptPath && event.extra.prompt_sha256 === promptSha,
    );
    if (promptPath == null || promptSha == null || prompt == null) problems.push(`${request.id}: prompt path/digest does not match a recorded snapshot`);
    else if (!isInsideRun(run.dir, promptPath)) problems.push(`${request.id}: prompt snapshot path escapes the run directory`);
    else {
      const abs = resolveArtifact(run.dir, promptPath);
      if (!existsSync(abs) || sha256Hex(readFileSync(abs)) !== promptSha) problems.push(`${request.id}: prompt snapshot digest does not match disk`);
    }
    if (terminal?.type !== 'actor_completed') continue;
    const output = typeof terminal.extra.output === 'string' ? terminal.extra.output : null;
    const sha = typeof terminal.extra.output_sha256 === 'string' ? terminal.extra.output_sha256 : null;
    if (output == null || sha == null) {
      problems.push(`${request.id}: completion lacks output path/digest`);
      continue;
    }
    const outputAbs = resolveArtifact(run.dir, output);
    if (!isInsideRun(run.dir, output) || !existsSync(outputAbs) || sha256Hex(readFileSync(outputAbs)) !== sha) problems.push(`${request.id}: completion output digest does not match a run-local file`);
    if (terminal.extra.output_valid === true) {
      if (output !== request.event.extra.output_path) problems.push(`${request.id}: successful output does not match planned immutable path`);
      const manifest = events.find((event) => event.type === 'artifact_created' && event.extra.artifact === output && event.extra.dispatch_id === request.id && event.extra.actor_call_id === request.event.extra.actor_call_id);
      if (manifest == null) problems.push(`${request.id}: successful completion has no matching artifact manifest`);
      else if (manifest.extra.sha256 !== sha) problems.push(`${request.id}: artifact manifest digest does not match completion`);
    } else if (!output.startsWith('artifacts/attempts/')) {
      problems.push(`${request.id}: invalid output was not parked under artifacts/attempts/`);
    }
  }
  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return { check, status: 'ok', detail: 'host prompts, receipts, and output manifests match recorded digests' };
}

function checkNativeAttestation(run: RunSummary, events: RunEvent[], mode: LedgerMode): Finding {
  const check = 'native-attestation';
  const starts = events.filter(
    (event) => event.type === 'actor_dispatched' && event.extra.dispatch_id != null &&
      (event.extra.delivery_transport ?? 'native') === 'native',
  );
  if (starts.length === 0) return skip(check, 'no native model, effort, or agent identity evidence recorded');
  if (mode !== 'current') return { check, status: 'fail', detail: 'native attestation cannot be silently ignored in compatibility mode' };
  const requests = new Map(
    hostRequestRecords(events).map((request) => [request.id, request.event]),
  );
  let profile: ReturnType<typeof parseExecutorProfile> | null = null;
  const snapshot = events.find((event) => event.type === 'profile_snapshotted');
  if (snapshot != null) {
    const profileRel = typeof snapshot.extra.profile === 'string' ? snapshot.extra.profile : 'profile.yaml';
    const profilePath = join(run.dir, profileRel);
    if (existsSync(profilePath)) {
      try {
        profile = parseExecutorProfile(readFileSync(profilePath, 'utf8'), profileRel);
      } catch {
        // host-dispatch-lifecycle reports the detailed profile parse failure;
        // this finding remains focused on attested field agreement.
      }
    }
  }
  const problems: string[] = [];
  let requestedOnly = 0;
  for (const start of starts) {
    const dispatchId = typeof start.extra.dispatch_id === 'string' ? start.extra.dispatch_id : '(unknown)';
    const request = requests.get(dispatchId);
    for (const field of ['model', 'reasoning_effort', 'agent_type', 'agent_id'] as const) {
      if (typeof start.extra[field] !== 'string' || start.extra[field] === '') problems.push(`${dispatchId}: missing host-attested ${field}`);
    }
    if (start.extra.host_attested !== true) problems.push(`${dispatchId}: start is not marked host_attested`);
    if (start.extra.identity_evidence === undefined || start.extra.identity_evidence === 'requested_only') {
      requestedOnly += 1;
    } else {
      problems.push(`${dispatchId}: unrecognized identity_evidence ${JSON.stringify(start.extra.identity_evidence)}`);
    }
    const attestation = start.extra.attestation;
    if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation)) {
      problems.push(`${dispatchId}: attestation object is missing`);
      continue;
    }
    const attested = attestation as Record<string, unknown>;
    for (const field of ['model', 'reasoning_effort', 'agent_type', 'agent_id'] as const) {
      if (attested[field] !== start.extra[field]) problems.push(`${dispatchId}: attestation ${field} does not match the start receipt`);
    }
    if (request == null) {
      problems.push(`${dispatchId}: start has no matching host dispatch request`);
    } else {
      for (const field of ['model', 'reasoning_effort', 'agent_type'] as const) {
        if (start.extra[field] !== request.extra[field]) problems.push(`${dispatchId}: start ${field} does not match the request`);
      }
      if (profile != null) {
        const executor = typeof request.extra.executor === 'string' ? profile.executors[request.extra.executor] : undefined;
        if (executor == null || executor.adapter !== 'host') {
          problems.push(`${dispatchId}: request executor is not a host profile entry`);
        } else {
          if (start.extra.model !== executor.model) problems.push(`${dispatchId}: attested model does not match the host profile`);
          if (start.extra.reasoning_effort !== executor.reasoningEffort) problems.push(`${dispatchId}: attested reasoning effort does not match the host profile`);
          if (start.extra.agent_type !== executor.agentType) problems.push(`${dispatchId}: attested agent type does not match the host profile`);
        }
      }
    }
  }
  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return skip(
    check,
    `${requestedOnly} native dispatch(es) are internally consistent with requested model/effort/type, ` +
      'but the host supplied no independently observed runtime identity',
  );
}

const ACTOR_EVENT_TYPES = new Set(['actor_dispatched', 'actor_completed', 'actor_failed']);

function checkSessionContinuity(events: RunEvent[]): Finding {
  const check = 'session-continuity';
  /** roleKey → session_id → executor that first recorded it ('' if unknown). */
  const seen = new Map<string, Map<string, string>>();
  let sessionDispatches = 0;
  const problems: string[] = [];

  for (const event of events) {
    if (!ACTOR_EVENT_TYPES.has(event.type)) continue;
    const roleKey = typeof event.extra.actor === 'string' ? event.extra.actor : '(anon)';
    const sid = typeof event.extra.session_id === 'string' ? event.extra.session_id : null;
    const executor = typeof event.extra.executor === 'string' ? event.extra.executor : '';

    if (event.type === 'actor_dispatched' && event.extra.session != null) {
      const mode = event.extra.session;
      sessionDispatches += 1;
      if (mode !== 'fresh' && mode !== 'resumed') {
        problems.push(`${roleKey}: dispatch has unrecognized session mode ${JSON.stringify(mode)}`);
      } else if (mode === 'resumed') {
        if (sid == null) {
          problems.push(`${roleKey}: resumed dispatch records no session_id`);
        } else {
          const creator = seen.get(roleKey)?.get(sid);
          if (creator == null) {
            problems.push(`${roleKey}: resumed session ${sid} was never recorded earlier in the run`);
          } else if (creator !== '' && executor !== '' && creator !== executor) {
            problems.push(`${roleKey}: session ${sid} created under "${creator}" but resumed under "${executor}"`);
          }
        }
      }
    }

    // Register after the check so a resumed dispatch cannot vouch for itself.
    if (sid != null) {
      const byId = seen.get(roleKey) ?? new Map<string, string>();
      if (!byId.has(sid)) byId.set(sid, executor);
      seen.set(roleKey, byId);
    }
  }

  if (sessionDispatches === 0) return skip(check, 'no session evidence recorded');
  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return { check, status: 'ok', detail: `${sessionDispatches} session dispatch(es), continuity holds` };
}

const ATTEMPT_REASONS_FIRST = new Set(['initial']);
const ATTEMPT_REASONS_RETRY = new Set(['schema_repair', 'executor_override', 'user_retry']);

function checkActorAttempts(run: RunSummary, events: RunEvent[]): Finding {
  const check = 'actor-attempts';
  interface Dispatch {
    attempt: number | null;
    reason: string | null;
    hasIds: boolean;
  }
  const byCall = new Map<string, Dispatch[]>();
  for (const event of events) {
    if (event.type !== 'actor_dispatched') continue;
    const callId = typeof event.extra.actor_call_id === 'string' ? event.extra.actor_call_id : '(no actor_call_id)';
    const list = byCall.get(callId) ?? [];
    list.push({
      attempt: typeof event.extra.attempt === 'number' ? event.extra.attempt : null,
      reason: typeof event.extra.attempt_reason === 'string' ? event.extra.attempt_reason : null,
      hasIds:
        typeof event.extra.actor_call_id === 'string' &&
        typeof event.extra.step_execution_id === 'string',
    });
    byCall.set(callId, list);
  }
  if (byCall.size === 0) return skip(check, 'no engine dispatches recorded');

  const problems: string[] = [];
  let dispatches = 0;
  for (const [callId, list] of byCall) {
    dispatches += list.length;
    for (const d of list) {
      if (!d.hasIds) problems.push(`${callId}: dispatch missing step_execution_id/actor_call_id`);
      if (d.attempt == null) problems.push(`${callId}: dispatch missing attempt ordinal`);
    }
    const attempts = list.map((d) => d.attempt).filter((a): a is number => a != null).sort((a, b) => a - b);
    for (let i = 0; i < attempts.length; i += 1) {
      if (attempts[i] !== i + 1) {
        problems.push(`${callId}: attempts are ${attempts.join(',')}, expected 1..${attempts.length}`);
        break;
      }
    }
    for (const d of list) {
      if (d.attempt === 1 && d.reason != null && !ATTEMPT_REASONS_FIRST.has(d.reason)) {
        problems.push(`${callId}: attempt 1 has reason "${d.reason}", expected "initial"`);
      }
      if (d.attempt != null && d.attempt > 1 && (d.reason == null || !ATTEMPT_REASONS_RETRY.has(d.reason))) {
        problems.push(
          `${callId}: attempt ${d.attempt} redispatched without an allowed reason ` +
            `(${[...ATTEMPT_REASONS_RETRY].join(', ')})`,
        );
      }
    }
  }

  // Rejected-output evidence carries its own digest (it never got a manifest).
  for (const event of events) {
    if (event.type !== 'actor_completed') continue;
    const rel = typeof event.extra.output === 'string' ? event.extra.output : null;
    const sha = typeof event.extra.output_sha256 === 'string' ? event.extra.output_sha256 : null;
    if (rel == null || sha == null) continue;
    const abs = resolveArtifact(run.dir, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel}: rejected-attempt output is missing`);
    } else if (sha256Hex(readFileSync(abs)) !== sha) {
      problems.push(`${rel}: rejected-attempt output no longer matches its recorded sha256`);
    }
  }

  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return {
    check,
    status: 'ok',
    detail: `${dispatches} dispatch(es) across ${byCall.size} actor call(s), ordinals contiguous`,
  };
}

function checkExecutorBindings(run: RunSummary, events: RunEvent[]): Finding {
  const check = 'executor-bindings';
  const snapshots = events.filter((e) => e.type === 'profile_snapshotted');
  const dispatches = events.filter((e) => e.type === 'actor_dispatched');
  if (snapshots.length === 0 && dispatches.length === 0) {
    return skip(check, 'no executor profile in use');
  }

  const problems: string[] = [];
  if (snapshots.length === 0) {
    problems.push('dispatches recorded but no profile_snapshotted event');
  }

  let profile: ExecutorProfile | null = null;
  if (snapshots.length > 0) {
    const snap = snapshots[0]!;
    const rel = typeof snap.extra.profile === 'string' ? snap.extra.profile : 'profile.yaml';
    const sha = typeof snap.extra.sha256 === 'string' ? snap.extra.sha256 : null;
    const abs = join(run.dir, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel}: profile snapshot is missing`);
    } else {
      const text = readFileSync(abs, 'utf8');
      if (sha != null && sha256Hex(text) !== sha) {
        problems.push(`${rel}: snapshot does not match its recorded sha256`);
      }
      try {
        profile = parseExecutorProfile(text, rel);
      } catch (err) {
        problems.push(`${rel}: snapshot did not parse: ${(err as Error).message}`);
      }
    }
  }

  // Recompute each dispatch's resolution with the kernel's own chain — per-role
  // pin → session slot override → active loadout's archetype slot → "*" default
  // (resolveRole; never a reimplemented precedence) — from ledger contents
  // alone: the snapshotted profile plus the resolution_snapshot in force at that
  // position (active loadout name + its overrides + per-role archetype), with
  // explicit overrides replayed in event order. An unresolvable role is never
  // claimed as a mismatch.
  //
  // The live pin is deliberately never read here: a verify that consulted
  // today's session state would fail a finished run because somebody cleared an
  // override afterwards. Same rule as the run-persisted loadout — replay is
  // from what the run recorded, not from what the session now says.
  const recompute = (
    role: string,
    archetype: string | null,
    loadout: string | null,
    overrides: Record<string, string>,
  ): { executor: string; source: string; resolvedVia: string | null } | null => {
    if (profile == null) return null;
    try {
      const resolved = resolveRole(role, archetype, profile, loadout, overrides);
      return { executor: resolved.executorName, source: resolved.source, resolvedVia: resolved.resolvedVia };
    } catch {
      return null;
    }
  };

  const overridesInForce = new Map<string, string>();
  const archetypeByRole = new Map<string, string | null>();
  let activeLoadout: string | null = null;
  // Runs recorded before session overrides existed carry no `overrides` field;
  // `{}` replays them exactly as they resolved.
  let slotOverrides: Record<string, string> = {};
  for (const event of events) {
    if (event.type === 'executor_override') {
      const role = typeof event.extra.role === 'string' ? event.extra.role : null;
      const executor = typeof event.extra.executor === 'string' ? event.extra.executor : null;
      if (role != null && executor != null) overridesInForce.set(role, executor);
      continue;
    }
    if (event.type === 'resolution_snapshot') {
      const loadout = event.extra.loadout;
      activeLoadout =
        loadout != null && typeof loadout === 'object' && !Array.isArray(loadout) &&
        typeof (loadout as Record<string, unknown>).name === 'string'
          ? ((loadout as Record<string, unknown>).name as string)
          : null;
      const recorded = event.extra.overrides;
      slotOverrides = {};
      if (recorded != null && typeof recorded === 'object' && !Array.isArray(recorded)) {
        for (const [archetype, target] of Object.entries(recorded as Record<string, unknown>)) {
          if (typeof target === 'string') slotOverrides[archetype] = target;
        }
      }
      const roles = Array.isArray(event.extra.roles) ? event.extra.roles : [];
      for (const row of roles) {
        if (row == null || typeof row !== 'object' || Array.isArray(row)) continue;
        const rec = row as Record<string, unknown>;
        if (typeof rec.role !== 'string') continue;
        const archetype = typeof rec.archetype === 'string' ? rec.archetype : null;
        archetypeByRole.set(rec.role, archetype);
        // The snapshot's own per-role rows are ledger claims, so they must
        // recompute too. Rows sourced `override` are the exception: a `--bind`
        // pin and a session slot override share that spelling, and a no-op
        // `--bind` legitimately records no `executor_override` event, so the
        // row cannot be attributed to a replayable chain. Unresolved rows carry
        // no chain claim at all. The dispatch events below still recompute — an
        // overridden binding is checked where it was actually used.
        if (rec.source === 'override' || typeof rec.executor !== 'string') continue;
        const recomputed = recompute(rec.role, archetype, activeLoadout, slotOverrides);
        if (recomputed == null) {
          problems.push(
            `resolution_snapshot: role "${rec.role}" records executor "${rec.executor}" but the chain resolves nothing`,
          );
        } else {
          if (recomputed.executor !== rec.executor || (typeof rec.source === 'string' && recomputed.source !== rec.source)) {
            problems.push(
              `resolution_snapshot: role "${rec.role}" records "${rec.executor}" [${String(rec.source)}] ` +
                `but recomputes to "${recomputed.executor}" [${recomputed.source}]`,
            );
          }
          // Absent key is not a claim (pre-0.2 snapshot rows). Present
          // resolved_via — including explicit null — must match the recompute.
          if ('resolved_via' in rec) {
            const recordedVia = typeof rec.resolved_via === 'string' ? rec.resolved_via : null;
            if (recordedVia !== recomputed.resolvedVia) {
              problems.push(
                `resolution_snapshot: role "${rec.role}" records resolved_via ${JSON.stringify(recordedVia)} ` +
                  `but recomputes to ${JSON.stringify(recomputed.resolvedVia)}`,
              );
            }
          }
        }
      }
      continue;
    }
    if (event.type !== 'actor_dispatched' && event.type !== 'host_dispatch_requested') continue;
    // A host dispatch's binding decision happens at host_dispatch_requested;
    // the later actor_dispatched is the host's start receipt, which must match
    // the request byte-for-byte (host-dispatch-lifecycle enforces that). An
    // in-flight request stays binding across later resolution changes, so the
    // request position — not the receipt position — anchors this check: the
    // start receipt of a host dispatch is skipped here, and each request is
    // validated against the resolution in force where it was recorded.
    if (event.type === 'actor_dispatched' && typeof event.extra.dispatch_id === 'string') continue;
    const decision = event.type === 'host_dispatch_requested' ? 'host dispatch requested' : 'dispatched to';
    const actor = typeof event.extra.actor === 'string' ? event.extra.actor : null;
    const used = typeof event.extra.executor === 'string' ? event.extra.executor : null;
    const label = `${event.step ?? '?'}${actor ? ` (${actor})` : ''}`;
    if (used == null) {
      problems.push(`${label}: dispatch records no executor`);
      continue;
    }
    if (profile != null && !(used in profile.executors)) {
      problems.push(`${label}: executor "${used}" is not in the snapshotted profile`);
    }
    const key = actor ?? '*';
    const expected =
      overridesInForce.get(key) ??
      recompute(key, archetypeByRole.get(key) ?? null, activeLoadout, slotOverrides)?.executor ??
      null;
    if (expected != null && used !== expected) {
      problems.push(`${label}: ${decision} "${used}" but the resolution in force was "${expected}"`);
    }
  }

  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return {
    check,
    status: 'ok',
    detail: `${dispatches.length} dispatch(es) match the recomputed resolution chain${overridesInForce.size > 0 ? ` (+${overridesInForce.size} explicit override(s))` : ''}`,
  };
}

/**
 * Recompute `gate_eligible` from the snapshotted profile.
 *
 * An `actor_dispatched` row stamped `gate_eligible: false` must recompute as
 * `shadow_only` for that archetype. A row that is *not* stamped must *not*
 * recompute as `shadow_only`: absent is a claim of eligible. That is
 * deliberately stricter than `resolved_via`'s absent-is-no-claim — eligibility
 * lives on the snapshot itself and needs no cross-file provenance, so an
 * unstamped row is asserting the default.
 *
 * Host start-receipts (`dispatch_id` present) are skipped: the engine's
 * command-dispatch chokepoint is what stamps this field; native receipts are
 * the host's.
 *
 * Constraint-command outcomes are attested, not recomputed here. The argv is
 * executable config — not replayable policy — so verify cannot reconstruct
 * a refuse/allow/error from the ledger plus snapshot.
 */
function checkGateEligible(run: RunSummary, events: RunEvent[]): Finding {
  const check = 'gate-eligible';
  const dispatches = events.filter(
    (event) => event.type === 'actor_dispatched' && typeof event.extra.dispatch_id !== 'string',
  );
  if (dispatches.length === 0) return skip(check, 'no command actor dispatches recorded');

  const snapshots = events.filter((event) => event.type === 'profile_snapshotted');
  const problems: string[] = [];
  if (snapshots.length === 0) {
    return { check, status: 'fail', detail: 'dispatches recorded but no profile_snapshotted event' };
  }

  let profile: ExecutorProfile | null = null;
  const snap = snapshots[0]!;
  const rel = typeof snap.extra.profile === 'string' ? snap.extra.profile : 'profile.yaml';
  const sha = typeof snap.extra.sha256 === 'string' ? snap.extra.sha256 : null;
  const abs = join(run.dir, rel);
  if (!existsSync(abs)) {
    return { check, status: 'fail', detail: `${rel}: profile snapshot is missing` };
  }
  const text = readFileSync(abs, 'utf8');
  if (sha != null && sha256Hex(text) !== sha) {
    return { check, status: 'fail', detail: `${rel}: snapshot does not match its recorded sha256` };
  }
  try {
    profile = parseExecutorProfile(text, rel);
  } catch (err) {
    return { check, status: 'fail', detail: `${rel}: snapshot did not parse: ${(err as Error).message}` };
  }

  const archetypeByRole = new Map<string, string | null>();
  for (const event of events) {
    if (event.type !== 'resolution_snapshot') continue;
    const roles = Array.isArray(event.extra.roles) ? event.extra.roles : [];
    for (const row of roles) {
      if (row == null || typeof row !== 'object' || Array.isArray(row)) continue;
      const rec = row as Record<string, unknown>;
      if (typeof rec.role !== 'string') continue;
      archetypeByRole.set(rec.role, typeof rec.archetype === 'string' ? rec.archetype : null);
    }
  }

  for (const event of dispatches) {
    const actor = typeof event.extra.actor === 'string' ? event.extra.actor : null;
    const used = typeof event.extra.executor === 'string' ? event.extra.executor : null;
    const label = `${event.step ?? '?'}${actor ? ` (${actor})` : ''}`;
    if (used == null) {
      problems.push(`${label}: dispatch records no executor`);
      continue;
    }
    if (!(used in profile.executors)) {
      problems.push(`${label}: executor "${used}" is not in the snapshotted profile`);
      continue;
    }
    const archetype =
      typeof event.extra.archetype === 'string'
        ? event.extra.archetype
        : archetypeByRole.get(actor ?? '*') ?? null;
    const state = eligibilityFor(profile.executors[used]!, archetype);
    const stampedIneligible = event.extra.gate_eligible === false;
    if (stampedIneligible) {
      if (state !== 'shadow_only') {
        problems.push(
          `${label}: records gate_eligible: false but snapshot eligibility is ${state}`,
        );
      }
    } else if (state === 'shadow_only') {
      problems.push(
        `${label}: has no gate_eligible stamp but snapshot eligibility is shadow_only`,
      );
    }
  }

  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return {
    check,
    status: 'ok',
    detail: `${dispatches.length} command dispatch(es) match snapshot eligibility`,
  };
}

function checkNamedDecisions(events: RunEvent[]): Finding {
  const check = 'named-decisions';
  const requests = new Map<string, { options: string[]; count: number }>();
  for (const event of events) {
    if (event.type !== 'decision_requested') continue;
    const id = typeof event.extra.decision_id === 'string' ? event.extra.decision_id : null;
    if (id == null) continue;
    const options = Array.isArray(event.extra.options)
      ? event.extra.options.filter((o): o is string => typeof o === 'string')
      : [];
    const existing = requests.get(id);
    if (existing) existing.count += 1;
    else requests.set(id, { options, count: 1 });
  }
  const resolutions: { id: string | null; option: string | null }[] = [];
  for (const event of events) {
    if (event.type !== 'decision_resolved') continue;
    resolutions.push({
      id: typeof event.extra.decision_id === 'string' ? event.extra.decision_id : null,
      option: typeof event.extra.option === 'string' ? event.extra.option : null,
    });
  }
  if (requests.size === 0 && resolutions.length === 0) return skip(check, 'no named decisions recorded');

  const problems: string[] = [];
  for (const [id, req] of requests) {
    if (req.count > 1) problems.push(`decision ${id} requested ${req.count} times`);
  }
  const seen = new Map<string, string>();
  for (const res of resolutions) {
    if (res.id == null) {
      problems.push('a decision_resolved event has no decision_id');
      continue;
    }
    const req = requests.get(res.id);
    if (req == null) {
      problems.push(`resolution references unknown decision ${res.id}`);
      continue;
    }
    if (res.option == null || !req.options.includes(res.option)) {
      problems.push(
        `decision ${res.id} resolved with ${res.option == null ? 'no option' : `undeclared option "${res.option}"`} ` +
          `(declared: ${req.options.join(', ')})`,
      );
      continue;
    }
    const prior = seen.get(res.id);
    if (prior != null && prior !== res.option) {
      problems.push(`decision ${res.id} resolved as both "${prior}" and "${res.option}"`);
    }
    seen.set(res.id, prior ?? res.option);
  }

  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return {
    check,
    status: 'ok',
    detail: `${requests.size} request(s), ${resolutions.length} resolution(s), none conflicting`,
  };
}

function checkArtifactSupersede(events: RunEvent[]): Finding {
  const check = 'artifact-supersede';
  const supersessions = events.filter((e) => e.type === 'artifact_superseded');
  if (supersessions.length === 0) return skip(check, 'no supersessions recorded');

  const recorded = new Set(
    events
      .filter((e) => e.type === 'artifact_created' && typeof e.extra.artifact === 'string')
      .map((e) => e.extra.artifact as string),
  );
  const problems: string[] = [];
  for (const event of supersessions) {
    const target = typeof event.extra.artifact === 'string' ? event.extra.artifact : null;
    const by = typeof event.extra.superseded_by === 'string' ? event.extra.superseded_by : null;
    if (target == null || by == null) {
      problems.push(`artifact_superseded (seq ${event.seq ?? '?'}) lacks artifact/superseded_by`);
      continue;
    }
    if (target === by) problems.push(`${target} recorded as superseding itself`);
    if (!recorded.has(target)) problems.push(`superseded ${target} was never recorded`);
    if (!recorded.has(by)) problems.push(`superseded_by ${by} was never recorded`);
  }
  if (problems.length > 0) return { check, status: 'fail', detail: problems.join('; ') };
  return { check, status: 'ok', detail: `${supersessions.length} supersession(s), all references recorded` };
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

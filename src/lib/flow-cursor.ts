import {
  attributeToMember,
  baseArtifactName,
  planCollectivePath,
  planMapMemberOutputs,
  resolveDownstream,
  schemaKindFor,
  tryPlanOutput,
  type Playbook,
  type PlaybookStep,
} from './prompt-resolve.ts';
import type { RunEvent } from './run-ledger.ts';

/**
 * Pure, deterministic flow cursor — the third render twin of `diagram` (whole
 * graph) and `prompt` (one step's input). Given a validated playbook and the
 * run ledger's events, returns the single next actionable step (or a blocked /
 * terminal state). No filesystem, no clock, no writes.
 *
 * Output paths for promptable steps come from `prompt-resolve` (`planOutput` /
 * `planMapMemberOutputs`) so `next` cannot advertise a path `prompt` will refuse.
 */

export class FlowCursorError extends Error {}

export type NextStatus = 'ready' | 'blocked_human_gate' | 'needs_decision' | 'terminal';

export interface NextLoopInfo {
  in_body: boolean;
  iteration: number | null;
  max: number | null;
}

export interface NextStepInfo {
  id: string;
  kind: string;
  promptable: boolean;
  actors: string[] | null;
  outputs: string[] | null;
  collective: string | null;
  artifact_type: string | null;
  loop: NextLoopInfo;
}

export interface NextGateInfo {
  condition: string;
  artifact: string;
  on_pass: string;
  on_fail: string;
}

export interface NextHumanGateInfo {
  prompt: string;
  on_approve: string;
  on_reject: string;
}

export interface NextTerminalInfo {
  status: string;
  step: string | null;
}

export interface NextComputation {
  status: NextStatus;
  step: NextStepInfo | null;
  gate: NextGateInfo | null;
  human_gate: NextHumanGateInfo | null;
  terminal: NextTerminalInfo | null;
  advice: string;
}

const ARTIFACT_EVENT_TYPES = new Set(['artifact_created']);
const PROMPTABLE_KINDS = new Set(['actor_call', 'evaluator', 'reduce', 'map']);
const NEEDS_DECISION_KINDS = new Set(['router', 'subworkflow', 'replicate']);

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asFlow(flow: unknown): PlaybookStep[] {
  return Array.isArray(flow) ? (flow as PlaybookStep[]) : [];
}

function loopBodyOwners(flow: PlaybookStep[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const step of flow) {
    if (step.kind !== 'loop' || !Array.isArray(step.body) || typeof step.id !== 'string') continue;
    for (const id of step.body) {
      if (typeof id === 'string' && !owners.has(id)) owners.set(id, step.id);
    }
  }
  return owners;
}

/** Outer-flow ids in declaration order (loop-body steps excluded). */
function outerIds(flow: PlaybookStep[], bodyOwner: Map<string, string>): string[] {
  return flow
    .filter((step) => typeof step.id === 'string' && !bodyOwner.has(step.id as string))
    .map((step) => step.id as string);
}

function hasExplicitOutgoing(step: PlaybookStep): boolean {
  for (const field of ['next', 'on_pass', 'on_fail', 'on_approve', 'on_reject', 'on_success', 'on_exhausted', 'default'] as const) {
    if (typeof step[field] === 'string') return true;
  }
  return Boolean(step.routes && typeof step.routes === 'object' && !Array.isArray(step.routes));
}

/** Linear fallthrough successor among outer steps (mirrors the validator). */
function outerFallthrough(outer: string[], id: string): string | null {
  const idx = outer.indexOf(id);
  if (idx < 0 || idx >= outer.length - 1) return null;
  return outer[idx + 1]!;
}

function roleListOver(step: PlaybookStep): string[] | null {
  if (typeof step.over === 'string') return null; // artifact-field map
  const members = asStringArray(step.over);
  return members.length > 0 ? members : null;
}

function artifactEventsForStep(events: RunEvent[], stepId: string): RunEvent[] {
  return events.filter(
    (event) => ARTIFACT_EVENT_TYPES.has(event.type) && event.step === stepId && typeof event.extra.artifact === 'string',
  );
}

/** True when the map's output type is consumed by a gate or loop `until`. */
function mapFeedsGateOrLoop(flow: PlaybookStep[], step: PlaybookStep): boolean {
  const collectiveType = typeof step.output === 'string' ? step.output : '';
  if (!collectiveType.endsWith('[]')) return false;
  return resolveDownstream(flow, collectiveType) != null;
}

/**
 * An assembled collective is any artifact on the step that is not attributable
 * to a map member (no `member` field and path doesn't match a member template).
 */
function hasCollectiveArtifact(
  step: PlaybookStep,
  arts: RunEvent[],
  members: string[],
  memberPaths: Set<string>,
  plannedCollective: string | null,
): boolean {
  for (const event of arts) {
    const path = event.extra.artifact as string;
    if (plannedCollective != null && path === plannedCollective) return true;
    if (memberPaths.has(path)) continue;
    const memberField = typeof event.extra.member === 'string' ? event.extra.member : null;
    if (memberField != null && members.includes(memberField)) continue;
    const attributed = attributeToMember(step, path);
    if (attributed != null && members.includes(attributed)) continue;
    // Unattributed path that isn't a known member file → collective (or other
    // step-level artifact). Treat as the assembled array for done-checking.
    if (memberField == null && attributed == null) return true;
  }
  return false;
}

function isProducingStepDone(
  playbook: Playbook,
  flow: PlaybookStep[],
  step: PlaybookStep,
  events: RunEvent[],
  iteration: number | null,
  isBody: boolean,
): boolean {
  const kind = typeof step.kind === 'string' ? step.kind : '';
  const stepId = step.id as string;
  const arts = artifactEventsForStep(events, stepId);

  if (kind === 'map') {
    const members = roleListOver(step);
    if (members == null) {
      // Artifact-field map: any artifact from the step counts as done in v1.
      return arts.length > 0;
    }
    const planned = planMapMemberOutputs(playbook, step, members, iteration, isBody);
    const paths = new Set(arts.map((e) => e.extra.artifact as string));
    let membersComplete = false;
    if (planned != null) {
      const expected = planned.map((p) => p.path);
      membersComplete = expected.every((p) => paths.has(p));
      if (!membersComplete) {
        // Member-field fallback when paths don't match templates exactly.
        const seen = new Set<string>();
        for (const event of arts) {
          const path = event.extra.artifact as string;
          const memberField = typeof event.extra.member === 'string' ? event.extra.member : null;
          const member = memberField ?? attributeToMember(step, path);
          if (member != null && members.includes(member)) seen.add(member);
        }
        membersComplete = members.every((m) => seen.has(m));
      }
      if (!membersComplete) return false;

      // Gated maps are not done until the collective array is assembled — otherwise
      // resume advances to the gate and may evaluate a single member file.
      if (mapFeedsGateOrLoop(flow, step)) {
        const collective = planCollectivePath(flow, step, expected, members, iteration, isBody);
        return hasCollectiveArtifact(step, arts, members, new Set(expected), collective);
      }
      return true;
    }

    // Unplannable map (e.g. untyped, no output_path): member-field presence only;
    // cannot require a planned collective path.
    const seen = new Set<string>();
    for (const event of arts) {
      const memberField = typeof event.extra.member === 'string' ? event.extra.member : null;
      if (memberField != null && members.includes(memberField)) seen.add(memberField);
    }
    return members.every((m) => seen.has(m));
  }

  return arts.length > 0;
}

function lastGateResult(events: RunEvent[], stepId: string): { result: string; artifact: string | null } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === 'gate_evaluated' && event.step === stepId) {
      const result = typeof event.extra.result === 'string' ? event.extra.result : null;
      if (result == null) return null;
      const artifact = typeof event.extra.artifact === 'string' ? event.extra.artifact : null;
      return { result, artifact };
    }
  }
  return null;
}

function humanDecision(events: RunEvent[], stepId: string): 'approve' | 'reject' | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.step !== stepId) continue;
    if (event.type === 'human_decision') {
      const branch = event.extra.branch;
      if (branch === 'approve' || branch === 'reject') return branch;
      if (branch === 'on_approve' || branch === 'approved') return 'approve';
      if (branch === 'on_reject' || branch === 'rejected') return 'reject';
      // A recorded decision with an unusable branch must not look like "no decision"
      // (that would re-pause forever on resume). Fail loudly.
      const shown = branch === undefined ? '(missing)' : JSON.stringify(branch);
      throw new FlowCursorError(
        `human_decision on step "${stepId}" has unrecognized branch ${shown}; expected "approve" or "reject".`,
      );
    }
    if (event.type === 'human_gate_approved') return 'approve';
    if (event.type === 'human_gate_rejected') return 'reject';
  }
  return null;
}

function loopTerminal(events: RunEvent[], loopId: string): 'succeeded' | 'exhausted' | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.step !== loopId) continue;
    if (event.type === 'loop_succeeded') return 'succeeded';
    if (event.type === 'loop_exhausted') return 'exhausted';
  }
  return null;
}

function loopIterationStarts(events: RunEvent[], loopId: string): number[] {
  const starts: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.type === 'loop_iteration_started' && event.step === loopId) starts.push(i);
  }
  return starts;
}

/** Loop-condition evaluation for the current (last) iteration, if recorded. */
function loopConditionForIteration(
  events: RunEvent[],
  loop: PlaybookStep,
  iterationStarts: number[],
  body: string[],
): { result: string; artifact: string | null } | null {
  if (iterationStarts.length === 0) return null;
  const loopId = loop.id as string;
  const from = iterationStarts[iterationStarts.length - 1]!;
  const until = typeof loop.until === 'string' ? loop.until : null;

  for (let i = events.length - 1; i >= from; i -= 1) {
    const event = events[i]!;
    if (event.type === 'loop_condition_evaluated' && event.step === loopId) {
      const result = typeof event.extra.result === 'string' ? event.extra.result : null;
      if (result == null) return null;
      const artifact = typeof event.extra.artifact === 'string' ? event.extra.artifact : null;
      return { result, artifact };
    }
    // Legacy origin-run form: gate_evaluated on the last body step with the until condition.
    if (
      event.type === 'gate_evaluated' &&
      event.step != null &&
      body.includes(event.step) &&
      (until == null || event.extra.condition === until)
    ) {
      const result = typeof event.extra.result === 'string' ? event.extra.result : null;
      if (result == null) return null;
      const artifact = typeof event.extra.artifact === 'string' ? event.extra.artifact : null;
      return { result, artifact };
    }
  }
  return null;
}

function isStepDone(ctx: ResolveCtx, step: PlaybookStep): boolean {
  const kind = typeof step.kind === 'string' ? step.kind : '';
  const stepId = step.id as string;
  const events = ctx.events;

  if (kind === 'gate') return lastGateResult(events, stepId) != null;
  if (kind === 'human_gate') return humanDecision(events, stepId) != null;
  if (kind === 'loop') return loopTerminal(events, stepId) != null;

  // Body steps: iteration is the count of owning-loop iteration starts at the
  // time of the step's latest start (or the latest iteration if not started).
  let iteration: number | null = null;
  let isBody = false;
  const owner = ctx.bodyOwner.get(stepId);
  if (owner) {
    isBody = true;
    const starts = loopIterationStarts(events, owner);
    if (starts.length === 0) return false;
    // Find which iteration this step's latest step_started falls into.
    let stepStartIdx = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]!.type === 'step_started' && events[i]!.step === stepId) {
        stepStartIdx = i;
        break;
      }
    }
    if (stepStartIdx < 0) {
      // Not started in current walk — treat as not done.
      return false;
    }
    let iter = 0;
    for (let s = 0; s < starts.length; s += 1) {
      if (starts[s]! <= stepStartIdx) iter = s + 1;
    }
    iteration = iter > 0 ? iter : starts.length;
  }

  if (PROMPTABLE_KINDS.has(kind) || kind === 'tool_call' || kind === 'join' || kind === 'artifact_op') {
    return isProducingStepDone(ctx.playbook, ctx.flow, step, events, iteration, isBody);
  }

  // Unknown / decision kinds: done if any terminal-ish event exists for them.
  if (NEEDS_DECISION_KINDS.has(kind)) {
    return (
      artifactEventsForStep(events, stepId).length > 0 ||
      events.some((e) => e.step === stepId && (e.type === 'branch_chosen' || e.type === 'step_completed'))
    );
  }

  return artifactEventsForStep(events, stepId).length > 0;
}

/**
 * Latest artifact path for a logical type produced by steps that declare it as
 * output, optionally restricted to events after `fromIndex`.
 *
 * Prefer unattributed (collective) artifacts over member-attributed ones so a
 * gate never evaluates a single map-member file when the array exists.
 * Do **not** fall back to a member file when a collective is expected — better
 * to use the schema default path than to gate on one architect's report.
 */
function latestArtifactForType(
  flow: PlaybookStep[],
  events: RunEvent[],
  logicalType: string,
  fromIndex = 0,
  preferCollectiveOnly = false,
): string | null {
  const base = baseArtifactName(logicalType);
  const producers = new Set(
    flow
      .filter((step) => typeof step.output === 'string' && baseArtifactName(step.output as string) === base)
      .map((step) => step.id as string),
  );
  for (let i = events.length - 1; i >= fromIndex; i -= 1) {
    const event = events[i]!;
    if (!ARTIFACT_EVENT_TYPES.has(event.type)) continue;
    if (event.step == null || !producers.has(event.step)) continue;
    if (typeof event.extra.artifact !== 'string') continue;
    // Prefer collective (no member) over per-member files when both exist.
    const member = event.extra.member;
    if (member != null) continue;
    const producer = flow.find((s) => s.id === event.step);
    if (producer && attributeToMember(producer, event.extra.artifact as string) != null) continue;
    return event.extra.artifact as string;
  }
  if (preferCollectiveOnly) return null;
  // Fall back to any producer artifact (including member-attributed) only when
  // the consumer is not a gate over an array type.
  for (let i = events.length - 1; i >= fromIndex; i -= 1) {
    const event = events[i]!;
    if (!ARTIFACT_EVENT_TYPES.has(event.type)) continue;
    if (event.step == null || !producers.has(event.step)) continue;
    if (typeof event.extra.artifact === 'string') return event.extra.artifact as string;
  }
  return null;
}

function gateArtifactPath(step: PlaybookStep, flow: PlaybookStep[], events: RunEvent[], fromIndex = 0): string {
  const inputs = asStringArray(step.input);
  if (inputs.length > 0) {
    const inputType = inputs[0]!;
    // Array inputs must resolve to a collective file, never a single member report.
    const arrayInput = inputType.endsWith('[]');
    const found = latestArtifactForType(flow, events, inputType, fromIndex, arrayInput);
    if (found) return found;
    const base = baseArtifactName(inputType);
    const schema = schemaKindFor(base);
    if (schema === 'review-report') return 'artifacts/review-report.json';
    if (schema === 'test-result') return 'artifacts/test-result.json';
  }
  return 'artifacts/review-report.json';
}

interface ResolveCtx {
  playbook: Playbook;
  flow: PlaybookStep[];
  byId: Map<string, PlaybookStep>;
  bodyOwner: Map<string, string>;
  outer: string[];
  events: RunEvent[];
}

function describeStep(
  ctx: ResolveCtx,
  step: PlaybookStep,
  iteration: number | null,
): NextStepInfo {
  const kind = typeof step.kind === 'string' ? step.kind : 'unknown';
  const stepId = step.id as string;
  const owner = ctx.bodyOwner.get(stepId) ?? null;
  const isBody = owner != null;
  const loopStep = owner ? ctx.byId.get(owner) : kind === 'loop' ? step : null;
  const max =
    loopStep && typeof loopStep.max_iterations === 'number' ? loopStep.max_iterations : null;

  let actors: string[] | null = null;
  let outputs: string[] | null = null;
  let collective: string | null = null;
  let promptable = false;
  let artifact_type: string | null = null;

  if (kind === 'map') {
    const members = roleListOver(step);
    if (members != null) {
      actors = members;
      const planned = planMapMemberOutputs(ctx.playbook, step, members, iteration, isBody);
      if (planned != null) {
        promptable = true;
        outputs = planned.map((p) => p.path);
        artifact_type = planned[0]?.schemaKind ?? null;
        collective = planCollectivePath(ctx.flow, step, outputs, members, iteration, isBody);
      } else {
        // Same refusal as fadeno prompt — do not invent member paths.
        promptable = false;
        outputs = null;
        const collectiveType = typeof step.output === 'string' ? step.output : '';
        artifact_type = schemaKindFor(baseArtifactName(collectiveType));
      }
    } else if (typeof step.actor === 'string') {
      actors = [step.actor];
    }
  } else if (PROMPTABLE_KINDS.has(kind)) {
    const actor = typeof step.actor === 'string' ? step.actor : null;
    actors = actor ? [actor] : null;
    const planned = tryPlanOutput(ctx.playbook, step, stepId, kind, false, actor, iteration, isBody);
    if (planned != null) {
      promptable = true;
      outputs = [planned.path];
      artifact_type = planned.schemaKind;
    }
  } else if (typeof step.actor === 'string') {
    actors = [step.actor];
  }

  if (artifact_type == null) {
    const collectiveType = typeof step.output === 'string' ? step.output : '';
    artifact_type = schemaKindFor(baseArtifactName(collectiveType));
  }

  return {
    id: stepId,
    kind,
    promptable,
    actors,
    outputs,
    collective,
    artifact_type,
    loop: {
      in_body: isBody,
      iteration,
      max,
    },
  };
}

function adviceFor(info: NextStepInfo, gate: NextGateInfo | null): string {
  const kind = info.kind;
  if (info.promptable) {
    if (kind === 'map' && info.actors && info.actors.length > 0) {
      const actors = info.actors.map((a) => `--actor ${a}`).join(' / ');
      let text =
        `dispatch each actor via \`fadeno prompt <run> ${info.id} ${actors}\`; ` +
        `write one artifact per actor; validate each` +
        (info.artifact_type ? ` against ${info.artifact_type}` : '') +
        `.`;
      if (info.collective) {
        text +=
          ` then assemble the array at ${info.collective} for the downstream gate` +
          ` (required before the map is considered done).`;
      }
      return text;
    }
    const actorFlag = info.actors?.[0] ? ` --actor ${info.actors[0]}` : '';
    return (
      `dispatch via \`fadeno prompt <run> ${info.id}${actorFlag}\` into the role harness; ` +
      `write ${info.outputs?.[0] ?? 'the step output'}; validate on arrival; ` +
      `record with \`fadeno run <run> --event artifact_created --artifact <path>\`` +
      (info.actors?.[0] ? ` --member ${info.actors[0]}` : '') +
      `.`
    );
  }
  if (kind === 'gate' && gate) {
    return (
      `evaluate with \`fadeno gate <run> ${gate.condition} --artifact ${gate.artifact}\`; ` +
      `on pass → ${gate.on_pass}; on fail → ${gate.on_fail}.`
    );
  }
  if (kind === 'loop' && gate) {
    return (
      `loop body complete — evaluate until via \`fadeno gate <run> ${gate.condition} --artifact ${gate.artifact}\` ` +
      `and record \`loop_condition_evaluated\` (result pass|fail); then re-call \`fadeno next\`.`
    );
  }
  if (kind === 'human_gate') {
    return 'pause and return to the host; do not auto-approve.';
  }
  if (kind === 'tool_call') {
    return 'invoke the named tool capability; save the result; record an artifact event; then re-call `fadeno next`.';
  }
  return `handle kind \`${kind}\` per runtime.md; record the outcome; then re-call \`fadeno next\`.`;
}

function ready(
  ctx: ResolveCtx,
  step: PlaybookStep,
  iteration: number | null,
  gate: NextGateInfo | null = null,
  human: NextHumanGateInfo | null = null,
): NextComputation {
  const info = describeStep(ctx, step, iteration);
  return {
    status: 'ready',
    step: info,
    gate,
    human_gate: human,
    terminal: null,
    advice: adviceFor(info, gate),
  };
}

function blockedHuman(ctx: ResolveCtx, step: PlaybookStep): NextComputation {
  const info = describeStep(ctx, step, null);
  const human: NextHumanGateInfo = {
    prompt: typeof step.prompt === 'string' ? step.prompt.trim().replace(/\s+/g, ' ') : '(no prompt declared)',
    on_approve: typeof step.on_approve === 'string' ? step.on_approve : '',
    on_reject: typeof step.on_reject === 'string' ? step.on_reject : '',
  };
  return {
    status: 'blocked_human_gate',
    step: info,
    gate: null,
    human_gate: human,
    terminal: null,
    advice: 'pause, return to host with human_gate.prompt; host records `human_decision` then re-dispatches the driver.',
  };
}

function needsDecision(ctx: ResolveCtx, step: PlaybookStep, iteration: number | null): NextComputation {
  const info = describeStep(ctx, step, iteration);
  return {
    status: 'needs_decision',
    step: info,
    gate: null,
    human_gate: null,
    terminal: null,
    advice: `step "${info.id}" (kind ${info.kind}) is not cursor-resolvable in v1; resolve the branch per runtime.md, record it, then re-call \`fadeno next\`.`,
  };
}

function terminal(status: string, stepId: string | null): NextComputation {
  return {
    status: 'terminal',
    step: null,
    gate: null,
    human_gate: null,
    terminal: { status, step: stepId },
    advice: `run is terminal (${status}); set \`fadeno run <run> --status ${status}\` if not already, and return the final summary.`,
  };
}

/** Resolve what to do when the cursor is sitting on `stepId`. */
function resolveAt(ctx: ResolveCtx, stepId: string): NextComputation {
  const step = ctx.byId.get(stepId);
  if (!step) {
    throw new FlowCursorError(`step "${stepId}" not found in playbook flow.`);
  }
  const kind = typeof step.kind === 'string' ? step.kind : 'unknown';

  // Loop-body steps: compute iteration from loop_iteration_started.
  const owner = ctx.bodyOwner.get(stepId);
  let iteration: number | null = null;
  if (owner) {
    const starts = loopIterationStarts(ctx.events, owner);
    iteration = starts.length > 0 ? starts.length : 1;
  }

  if (kind === 'loop') {
    return resolveLoop(ctx, step);
  }

  if (kind === 'gate') {
    if (isStepDone(ctx, step)) {
      // Should not be "at" a completed gate — walk to successor.
      const nextId = successorOfCompleted(ctx, stepId);
      if (nextId == null) return terminalFromStep(step);
      return resolveAt(ctx, nextId);
    }
    const gate: NextGateInfo = {
      condition: typeof step.condition === 'string' ? step.condition : '',
      artifact: gateArtifactPath(step, ctx.flow, ctx.events),
      on_pass: typeof step.on_pass === 'string' ? step.on_pass : '',
      on_fail: typeof step.on_fail === 'string' ? step.on_fail : '',
    };
    return ready(ctx, step, null, gate);
  }

  if (kind === 'human_gate') {
    if (isStepDone(ctx, step)) {
      const nextId = successorOfCompleted(ctx, stepId);
      if (nextId == null) return terminalFromStep(step);
      return resolveAt(ctx, nextId);
    }
    return blockedHuman(ctx, step);
  }

  if (NEEDS_DECISION_KINDS.has(kind)) {
    if (isStepDone(ctx, step)) {
      const nextId = successorOfCompleted(ctx, stepId);
      if (nextId == null) return terminalFromStep(step);
      return resolveAt(ctx, nextId);
    }
    return needsDecision(ctx, step, iteration);
  }

  if (isStepDone(ctx, step)) {
    // Completed producing step — if it carries terminal_status, we're done.
    if (typeof step.terminal_status === 'string') {
      return terminal(step.terminal_status, stepId);
    }
    const nextId = successorOfCompleted(ctx, stepId);
    if (nextId == null) return terminal('completed', stepId);
    return resolveAt(ctx, nextId);
  }

  // Incomplete producing / tool step.
  if (kind === 'map' && roleListOver(step) == null) {
    // Artifact-field map: not promptable in v1.
    return needsDecision(ctx, step, iteration);
  }

  // Role-list map that prompt would refuse (untyped, no output_path): surface
  // as needs_decision so the driver does not attempt fadeno prompt.
  if (kind === 'map' && roleListOver(step) != null) {
    const info = describeStep(ctx, step, iteration);
    if (!info.promptable) {
      return {
        status: 'needs_decision',
        step: info,
        gate: null,
        human_gate: null,
        terminal: null,
        advice:
          `step "${info.id}" maps roles but is not promptable in v1 (untyped output without output_path, ` +
          `or otherwise unresolvable by fadeno prompt); declare output_path or handle per runtime.md.`,
      };
    }
  }

  return ready(ctx, step, iteration);
}

function terminalFromStep(step: PlaybookStep): NextComputation {
  if (typeof step.terminal_status === 'string') {
    return terminal(step.terminal_status, step.id as string);
  }
  return terminal('completed', typeof step.id === 'string' ? step.id : null);
}

function resolveLoop(ctx: ResolveCtx, loop: PlaybookStep): NextComputation {
  const loopId = loop.id as string;
  const body = asStringArray(loop.body);
  const max = typeof loop.max_iterations === 'number' ? loop.max_iterations : null;
  const term = loopTerminal(ctx.events, loopId);
  if (term === 'succeeded') {
    const target = typeof loop.on_success === 'string' ? loop.on_success : null;
    if (target) return resolveAt(ctx, target);
    return terminal('completed', loopId);
  }
  if (term === 'exhausted') {
    const target = typeof loop.on_exhausted === 'string' ? loop.on_exhausted : null;
    if (target) return resolveAt(ctx, target);
    return terminal('failed', loopId);
  }

  const starts = loopIterationStarts(ctx.events, loopId);
  if (starts.length === 0) {
    // Enter first iteration: surface the first body step.
    if (body.length === 0) {
      throw new FlowCursorError(`loop "${loopId}" has an empty body.`);
    }
    const first = ctx.byId.get(body[0]!);
    if (!first) throw new FlowCursorError(`loop "${loopId}" body step "${body[0]}" is missing.`);
    const result = ready(ctx, first, 1);
    result.advice =
      `record \`loop_iteration_started\` for ${loopId} (iteration 1), then ` + result.advice;
    return result;
  }

  const iteration = starts.length;
  // Find first incomplete body step for this iteration (events after last start).
  for (const bodyId of body) {
    const bodyStep = ctx.byId.get(bodyId);
    if (!bodyStep) continue;
    // Done check scoped: a body step is done for this iteration if it has
    // artifacts after the iteration start.
    if (!bodyStepDoneInIteration(ctx, bodyStep, starts[starts.length - 1]!, iteration)) {
      return ready(ctx, bodyStep, iteration);
    }
  }

  // Body complete — need condition evaluation?
  const cond = loopConditionForIteration(ctx.events, loop, starts, body);
  if (cond == null) {
    const gate: NextGateInfo = {
      condition: typeof loop.until === 'string' ? loop.until : '',
      artifact: gateArtifactPath(loop, ctx.flow, ctx.events, starts[starts.length - 1]!),
      on_pass: typeof loop.on_success === 'string' ? loop.on_success : '',
      on_fail: typeof loop.on_exhausted === 'string' ? loop.on_exhausted : '',
    };
    // Surface as the loop step with a gate block so the driver can run fadeno gate.
    return ready(ctx, loop, iteration, gate);
  }

  if (cond.result === 'pass') {
    const target = typeof loop.on_success === 'string' ? loop.on_success : null;
    if (target) return resolveAt(ctx, target);
    return terminal('completed', loopId);
  }

  // Condition failed.
  if (max != null && iteration >= max) {
    const target = typeof loop.on_exhausted === 'string' ? loop.on_exhausted : null;
    if (target) return resolveAt(ctx, target);
    return terminal('failed', loopId);
  }

  // Another iteration remains.
  if (body.length === 0) throw new FlowCursorError(`loop "${loopId}" has an empty body.`);
  const first = ctx.byId.get(body[0]!);
  if (!first) throw new FlowCursorError(`loop "${loopId}" body step "${body[0]}" is missing.`);
  const nextIter = iteration + 1;
  const result = ready(ctx, first, nextIter);
  result.advice =
    `record \`loop_iteration_started\` for ${loopId} (iteration ${nextIter}), then ` + result.advice;
  return result;
}

function bodyStepDoneInIteration(
  ctx: ResolveCtx,
  step: PlaybookStep,
  fromIndex: number,
  iteration: number,
): boolean {
  const stepId = step.id as string;
  // Allow "done" via artifacts alone (some ledgers skip step_started on body re-entry).
  const arts = ctx.events.filter(
    (event, index) =>
      index >= fromIndex &&
      ARTIFACT_EVENT_TYPES.has(event.type) &&
      event.step === stepId &&
      typeof event.extra.artifact === 'string',
  );
  if (arts.length === 0) {
    let started = false;
    for (let i = fromIndex; i < ctx.events.length; i += 1) {
      if (ctx.events[i]!.type === 'step_started' && ctx.events[i]!.step === stepId) {
        started = true;
        break;
      }
    }
    if (!started) return false;
  }

  // Reuse the same done rules as the outer cursor (shared planOutput paths +
  // collective required when the map feeds a gate/loop).
  return isProducingStepDone(ctx.playbook, ctx.flow, step, arts, iteration, true);
}

function successorOfCompleted(ctx: ResolveCtx, stepId: string): string | null {
  const step = ctx.byId.get(stepId);
  if (!step) return null;
  const kind = typeof step.kind === 'string' ? step.kind : '';

  // Body step → next body step or loop resolution.
  const owner = ctx.bodyOwner.get(stepId);
  if (owner) {
    const loop = ctx.byId.get(owner);
    if (!loop) return null;
    const body = asStringArray(loop.body);
    const idx = body.indexOf(stepId);
    if (idx >= 0 && idx < body.length - 1) return body[idx + 1]!;
    // End of body: return the loop so resolveLoop can evaluate condition / exit.
    return owner;
  }

  if (kind === 'gate') {
    const result = lastGateResult(ctx.events, stepId);
    if (!result) return null;
    if (result.result === 'pass') return typeof step.on_pass === 'string' ? step.on_pass : null;
    return typeof step.on_fail === 'string' ? step.on_fail : null;
  }

  if (kind === 'human_gate') {
    const decision = humanDecision(ctx.events, stepId);
    if (decision === 'approve') return typeof step.on_approve === 'string' ? step.on_approve : null;
    if (decision === 'reject') return typeof step.on_reject === 'string' ? step.on_reject : null;
    return null;
  }

  if (kind === 'loop') {
    const term = loopTerminal(ctx.events, stepId);
    if (term === 'succeeded') return typeof step.on_success === 'string' ? step.on_success : null;
    if (term === 'exhausted') return typeof step.on_exhausted === 'string' ? step.on_exhausted : null;
    // Still open — stay on the loop.
    return stepId;
  }

  // Linear / fallthrough among outer steps.
  if (typeof step.next === 'string') return step.next;
  if (hasExplicitOutgoing(step)) {
    // Explicit branches but not a kind we resolved above — no automatic fallthrough.
    return null;
  }
  if (typeof step.terminal_status === 'string') return null;
  return outerFallthrough(ctx.outer, stepId);
}

/**
 * Compute the next actionable step for a run. Pure function of (playbook, events).
 */
export function computeNext(playbook: Playbook, events: RunEvent[]): NextComputation {
  const flow = asFlow(playbook.flow);
  if (flow.length === 0) {
    throw new FlowCursorError('playbook has no flow steps.');
  }

  const byId = new Map<string, PlaybookStep>();
  for (const step of flow) {
    if (typeof step.id === 'string') byId.set(step.id, step);
  }
  const bodyOwner = loopBodyOwners(flow);
  const outer = outerIds(flow, bodyOwner);
  const ctx: ResolveCtx = { playbook, flow, byId, bodyOwner, outer, events };

  // Already-terminal run signals (caller may also check run.yaml.status).
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === 'run_completed') return terminal('completed', null);
    if (event.type === 'run_failed') return terminal('failed', null);
    if (event.type === 'run_aborted') return terminal('aborted', null);
  }

  // Position = last step_started without completion, else successor of last completed.
  let lastStarted: string | null = null;
  let lastStartedIdx = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === 'step_started' && typeof events[i]!.step === 'string') {
      lastStarted = events[i]!.step;
      lastStartedIdx = i;
      break;
    }
  }

  if (lastStarted != null) {
    const step = byId.get(lastStarted);
    if (step && !isStepDone(ctx, step)) {
      return resolveAt(ctx, lastStarted);
    }
    // Started step is done — walk from its successor. Prefer events after the
    // start so we don't get stuck re-reading an older incomplete step.
    void lastStartedIdx;
    const nextId = successorOfCompleted(ctx, lastStarted);
    if (nextId == null) {
      if (step && typeof step.terminal_status === 'string') {
        return terminal(step.terminal_status, lastStarted);
      }
      // Flow exhausted with no terminal marker.
      return terminal('completed', lastStarted);
    }
    return resolveAt(ctx, nextId);
  }

  // No step_started yet — entry is the first outer step.
  const entry = outer[0] ?? (typeof flow[0]?.id === 'string' ? (flow[0].id as string) : null);
  if (entry == null) throw new FlowCursorError('playbook flow has no identifiable entry step.');
  return resolveAt(ctx, entry);
}

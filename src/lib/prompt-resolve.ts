import type { RunEvent } from './run-ledger.ts';

/**
 * Pure, deterministic resolution of a step-prompt assignment from the validated
 * playbook, the run ledger's events (through an invocation cutoff), and a
 * selection. No filesystem, no `process`, no clock — mirrors `lib/diagram.ts`.
 * The command layer reads artifact bytes and records; this module only decides
 * *what* the prompt is about.
 */

export class PromptResolveError extends Error {}

export interface PlaybookStep {
  id?: unknown;
  kind?: unknown;
  actor?: unknown;
  over?: unknown;
  input?: unknown;
  output?: unknown;
  body?: unknown;
  prompt?: unknown;
  condition?: unknown;
  until?: unknown;
  max_iterations?: unknown;
  output_path?: unknown;
  input_bindings?: unknown;
  [key: string]: unknown;
}

export interface Playbook {
  name?: unknown;
  schema_version?: unknown;
  roles?: unknown;
  flow?: unknown;
  policies?: unknown;
  artifact_contracts?: unknown;
  [key: string]: unknown;
}

export interface Selection {
  step: string;
  actor: string | null;
  iteration: number | null;
}

export interface ResolvedInputFile {
  path: string;
  byActor: string | null;
  isSelf: boolean;
}

export interface ResolvedInput {
  artifact: string;
  producedBy: string | null;
  invocation: number | null;
  files: ResolvedInputFile[];
  /** True when the producer also wrote a single assembled aggregate file. */
  isAssembledAggregate: boolean;
  /** Path of that assembled aggregate, when present (annotated, not re-listed). */
  aggregatePath: string | null;
}

export type SchemaKind = 'review-report' | 'test-result';

export interface PlannedOutput {
  path: string;
  mediaType: string;
  schemaKind: SchemaKind | null;
  instructions: string | null;
  collectiveType: string;
  memberType: string;
  isMap: boolean;
}

export interface DownstreamNote {
  gateStep: string;
  condition: string;
}

export interface ResolutionPlan {
  kind: string;
  actor: string | null;
  iteration: number | null;
  maxIterations: number | null;
  invocation: number;
  cutoffLine: number | null;
  inputs: ResolvedInput[];
  output: PlannedOutput;
  downstream: DownstreamNote | null;
  otherMembers: string[];
  loopOwner: string | null;
  purpose: string | null;
}

const ARTIFACT_EVENT_TYPES = new Set(['artifact_created']);
const NOT_PROMPTABLE = new Set(['tool_call', 'router', 'join', 'artifact_op', 'subworkflow', 'replicate']);

function baseArtifact(name: string): string {
  return name.replace(/\[\]$/, '');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Map of loop-body step id -> owning loop id. */
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

function findStep(flow: PlaybookStep[], id: string): PlaybookStep | undefined {
  return flow.find((step) => step.id === id);
}

/**
 * Expand an `output_path` spec for one member/iteration. `{actor}` -> member;
 * `{iteration}` -> the generation number G = N + 1 (pre-loop = generation 1),
 * so the first loop iteration (N = 1) writes `.v2`.
 */
export function expandOutputPath(
  spec: string | Record<string, string>,
  member: string | null,
  iteration: number | null,
): string {
  let template: string;
  if (typeof spec === 'string') {
    template = spec;
  } else {
    if (member == null || typeof spec[member] !== 'string') {
      throw new PromptResolveError(`output_path map has no entry for member "${member ?? '(none)'}".`);
    }
    template = spec[member];
  }
  let out = template;
  if (member != null) out = out.split('{actor}').join(member);
  if (iteration != null) out = out.split('{iteration}').join(String(iteration + 1));
  return out;
}

/** Insert a `.v<G>` generation marker before the final extension of a path. */
function withGeneration(path: string, iteration: number): string {
  const generation = iteration + 1;
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot > slash) return `${path.slice(0, dot)}.v${generation}${path.slice(dot)}`;
  return `${path}.v${generation}`;
}

/**
 * Inverse of `withGeneration`: parse a `.v<G>` marker out of a path. A path
 * with no marker is generation 1 (the pre-loop original).
 */
export function parseGeneration(path: string): { logicalPath: string; generation: number } {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const match = base.match(/^(.*)\.v(\d+)(\.[^.]*)?$/);
  if (!match) return { logicalPath: path, generation: 1 };
  return { logicalPath: `${dir}${match[1]}${match[3] ?? ''}`, generation: Number(match[2]) };
}

/** Does an artifact path match a producer's output_path template for `member`? */
function templateMatches(template: string, member: string, path: string): boolean {
  const pattern = template
    .split(/(\{actor\}|\{iteration\})/)
    .map((part) => (part === '{actor}' ? escapeRegExp(member) : part === '{iteration}' ? '\\d+' : escapeRegExp(part)))
    .join('');
  return new RegExp(`^${pattern}$`).test(path);
}

/** Attribute one produced artifact path to a member via the producer's output_path. */
export function attributeToMember(producer: PlaybookStep, path: string): string | null {
  const spec = producer.output_path;
  if (spec == null) return null;
  if (typeof spec === 'object' && !Array.isArray(spec)) {
    for (const [member, template] of Object.entries(spec as Record<string, unknown>)) {
      if (typeof template === 'string' && templateMatches(template, member, path)) return member;
    }
    return null;
  }
  if (typeof spec === 'string') {
    for (const member of asStringArray(producer.over)) {
      if (templateMatches(spec, member, path)) return member;
    }
  }
  return null;
}

export function schemaKindFor(base: string): SchemaKind | null {
  if (base === 'ReviewReport') return 'review-report';
  if (base === 'TestResult') return 'test-result';
  return null;
}

/** Strip a trailing `[]` array marker from a logical artifact type name. */
export function baseArtifactName(name: string): string {
  return name.replace(/\[\]$/, '');
}

interface CandidateEvent {
  index: number;
  path: string;
  producer: string;
  member: string | null;
}

function resolveInput(
  inputType: string,
  flow: PlaybookStep[],
  events: RunEvent[],
  cutoff: number,
  actor: string | null,
): ResolvedInput {
  const base = baseArtifact(inputType);
  const producerIds = new Set(
    flow.filter((step) => typeof step.output === 'string' && baseArtifact(step.output) === base).map((step) => step.id as string),
  );

  const candidates: CandidateEvent[] = [];
  for (let i = 0; i < cutoff; i += 1) {
    const event = events[i]!;
    if (!ARTIFACT_EVENT_TYPES.has(event.type)) continue;
    if (event.step == null || !producerIds.has(event.step)) continue;
    const path = event.extra.artifact;
    if (typeof path !== 'string') continue;
    const memberField = typeof event.extra.member === 'string' ? event.extra.member : null;
    const producer = findStep(flow, event.step);
    const member = memberField ?? (producer ? attributeToMember(producer, path) : null);
    candidates.push({ index: i, path, producer: event.step, member });
  }

  // Latest event per attributed member; latest aggregate; unattributed kept in order.
  const byMember = new Map<string, CandidateEvent>();
  const unattributed: CandidateEvent[] = [];
  let aggregate: CandidateEvent | null = null;
  for (const candidate of candidates) {
    if (candidate.member != null) {
      const prior = byMember.get(candidate.member);
      if (!prior || candidate.index > prior.index) byMember.set(candidate.member, candidate);
      continue;
    }
    const producer = findStep(flow, candidate.producer);
    if (producer && producer.output_path != null) {
      // Producer attributes by member, yet this path matched none: it is the
      // assembled aggregate (e.g. cross-review.json alongside the member files).
      if (!aggregate || candidate.index > aggregate.index) aggregate = candidate;
    } else {
      unattributed.push(candidate);
    }
  }

  const memberEntries = [...byMember.entries()];
  const overOrder = memberEntries.length > 0
    ? asStringArray(findStep(flow, memberEntries[0]![1].producer)?.over)
    : [];
  memberEntries.sort((a, b) => {
    const ai = overOrder.indexOf(a[0]);
    const bi = overOrder.indexOf(b[0]);
    if (ai !== -1 && bi !== -1) return ai - bi;
    return a[1].index - b[1].index;
  });

  const files: ResolvedInputFile[] = [];
  for (const [member, event] of memberEntries) {
    files.push({ path: event.path, byActor: member, isSelf: member === actor });
  }
  for (const event of unattributed.sort((a, b) => a.index - b.index)) {
    files.push({ path: event.path, byActor: null, isSelf: false });
  }

  const all = [...byMember.values(), ...unattributed, ...(aggregate ? [aggregate] : [])];
  let producedBy: string | null = null;
  let invocation: number | null = null;
  if (all.length > 0) {
    const last = all.reduce((a, b) => (a.index >= b.index ? a : b));
    producedBy = last.producer;
    let count = 0;
    for (let i = 0; i < cutoff; i += 1) {
      if (events[i]!.type === 'step_started' && events[i]!.step === producedBy) count += 1;
    }
    invocation = count > 0 ? count : null;
  }

  return {
    artifact: inputType,
    producedBy,
    invocation,
    files,
    isAssembledAggregate: aggregate != null,
    aggregatePath: aggregate ? aggregate.path : null,
  };
}

/** Resolve the full assignment plan for one step selection. Pure. */
export function resolveStepPlan(playbook: Playbook, events: RunEvent[], sel: Selection): ResolutionPlan {
  const flow = asFlow(playbook.flow);
  const step = findStep(flow, sel.step);
  if (!step) {
    const ids = flow.map((s) => (typeof s.id === 'string' ? s.id : '?')).join(', ');
    throw new PromptResolveError(`step "${sel.step}" not found. Steps: ${ids}`);
  }

  const kind = typeof step.kind === 'string' ? step.kind : 'unknown';
  guardKind(step, kind, sel.step);

  // Promptable kinds: actor_call, evaluator, reduce, and role-list map.
  const isMap = kind === 'map';
  let overMembers: string[] = [];
  if (isMap) {
    if (typeof step.over === 'string') {
      throw new PromptResolveError(`step "${sel.step}" maps over an artifact field ("${step.over}"); artifact-field maps are not promptable in v1.`);
    }
    overMembers = asStringArray(step.over);
    if (overMembers.length === 0) {
      throw new PromptResolveError(`step "${sel.step}" has no literal \`over\` role list; not promptable in v1.`);
    }
  }

  const { actor, otherMembers } = resolveActor(step, sel, isMap, overMembers);

  const owners = loopBodyOwners(flow);
  const loopOwner = typeof step.id === 'string' ? owners.get(step.id) ?? null : null;
  const isBody = loopOwner != null;
  if (!isBody && sel.iteration != null) {
    throw new PromptResolveError(`--iteration is only valid on loop-body steps; "${sel.step}" is not one.`);
  }

  let iteration: number | null = null;
  let maxIterations: number | null = null;
  let iterationStarts: number[] = [];
  if (isBody) {
    const loopStep = findStep(flow, loopOwner);
    maxIterations = loopStep && typeof loopStep.max_iterations === 'number' ? loopStep.max_iterations : null;
    iterationStarts = events.reduce<number[]>((acc, event, index) => {
      if (event.type === 'loop_iteration_started' && event.step === loopOwner) acc.push(index);
      return acc;
    }, []);
    if (iterationStarts.length === 0) {
      throw new PromptResolveError(`loop "${loopOwner}" has no recorded loop_iteration_started; cannot resolve an iteration for "${sel.step}".`);
    }
    iterationStarts.forEach((index, ordinal) => {
      const declared = events[index]!.extra.iteration;
      if (typeof declared === 'number' && declared !== ordinal + 1) {
        throw new PromptResolveError(`loop_iteration_started #${ordinal + 1} for "${loopOwner}" records iteration ${declared}, which does not match its ordinal ${ordinal + 1}.`);
      }
    });
    const wanted = sel.iteration ?? iterationStarts.length;
    if (wanted < 1 || wanted > iterationStarts.length) {
      throw new PromptResolveError(`--iteration ${wanted} is out of range for "${sel.step}"; loop "${loopOwner}" has ${iterationStarts.length} recorded iteration(s).`);
    }
    iteration = wanted;
  }

  // Span within which to count this step's invocations (loop bodies only).
  let spanStart = 0;
  let spanEnd = events.length;
  if (isBody && iteration != null) {
    spanStart = iterationStarts[iteration - 1]!;
    spanEnd = iteration < iterationStarts.length ? iterationStarts[iteration]! : events.length;
  }

  const stepStarts: number[] = [];
  for (let i = spanStart; i < spanEnd; i += 1) {
    if (events[i]!.type === 'step_started' && events[i]!.step === sel.step) stepStarts.push(i);
  }
  let invocation: number;
  let cutoffIndex: number | null;
  if (stepStarts.length === 0) {
    invocation = 1;
    cutoffIndex = null; // ahead of dispatch → preview only
  } else {
    invocation = stepStarts.length;
    cutoffIndex = stepStarts[stepStarts.length - 1]!;
  }
  const inputCutoff = cutoffIndex ?? spanEnd;

  const inputs = asStringArray(step.input).map((type) => resolveInput(type, flow, events, inputCutoff, actor));

  const output = planOutput(playbook, step, sel.step, kind, isMap, actor, iteration, isBody);
  const downstream = resolveDownstream(flow, output.collectiveType);
  const purpose = resolvePurpose(playbook, actor);

  return {
    kind,
    actor,
    iteration,
    maxIterations,
    invocation,
    cutoffLine: cutoffIndex == null ? null : cutoffIndex + 1,
    inputs,
    output,
    downstream,
    otherMembers,
    loopOwner,
    purpose,
  };
}

function asFlow(flow: unknown): PlaybookStep[] {
  return Array.isArray(flow) ? (flow as PlaybookStep[]) : [];
}

function guardKind(step: PlaybookStep, kind: string, stepId: string): void {
  if (kind === 'gate') {
    throw new PromptResolveError(`step "${stepId}" is a gate; evaluate it with \`fadeno gate <run> <condition> --artifact <path>\`, not \`fadeno prompt\`.`);
  }
  if (kind === 'human_gate') {
    const question = typeof step.prompt === 'string' ? step.prompt.trim().replace(/\s+/g, ' ') : '(no prompt declared)';
    throw new PromptResolveError(`step "${stepId}" is a human_gate; ask the user directly: ${question}`);
  }
  if (kind === 'loop') {
    const body = asStringArray(step.body).join(', ');
    throw new PromptResolveError(`step "${stepId}" is a loop; prompt one of its body steps: ${body}`);
  }
  if (NOT_PROMPTABLE.has(kind)) {
    throw new PromptResolveError(`step "${stepId}" (kind ${kind}) is not promptable in v1.`);
  }
}

function resolveActor(
  step: PlaybookStep,
  sel: Selection,
  isMap: boolean,
  overMembers: string[],
): { actor: string | null; otherMembers: string[] } {
  if (isMap) {
    if (sel.actor == null) {
      throw new PromptResolveError(`step "${sel.step}" maps over roles; pass --actor ${overMembers.join('|')}.`);
    }
    if (!overMembers.includes(sel.actor)) {
      throw new PromptResolveError(`unknown --actor "${sel.actor}" for step "${sel.step}"; valid members: ${overMembers.join(', ')}.`);
    }
    return { actor: sel.actor, otherMembers: overMembers.filter((member) => member !== sel.actor) };
  }
  const declared = typeof step.actor === 'string' ? step.actor : null;
  if (sel.actor != null && sel.actor !== declared) {
    throw new PromptResolveError(`unknown --actor "${sel.actor}" for step "${sel.step}"; valid actor: ${declared ?? '(none)'}.`);
  }
  return { actor: declared, otherMembers: [] };
}

/**
 * Plan the output path/type for one step assignment. Shared by `fadeno prompt`
 * and `fadeno next` so the cursor can never advertise a path the prompter will
 * refuse. Throws `PromptResolveError` for unpromptable path shapes (e.g. a
 * role-list map with an untyped output and no `output_path`).
 */
export function planOutput(
  playbook: Playbook,
  step: PlaybookStep,
  stepId: string,
  kind: string,
  isMap: boolean,
  actor: string | null,
  iteration: number | null,
  isBody: boolean,
): PlannedOutput {
  const collectiveType = typeof step.output === 'string' ? step.output : '';
  const base = baseArtifact(collectiveType);
  const schemaKind = schemaKindFor(base);
  const memberType = isMap ? base : collectiveType;

  let path: string;
  const spec = step.output_path;
  if (spec != null && (typeof spec === 'string' || (typeof spec === 'object' && !Array.isArray(spec)))) {
    path = expandOutputPath(spec as string | Record<string, string>, actor, iteration);
  } else if (isMap) {
    if (schemaKind) {
      path = `artifacts/parts/${stepId}/${actor ?? 'member'}.json`;
      if (isBody && iteration != null) path = withGeneration(path, iteration);
    } else {
      throw new PromptResolveError(`step "${stepId}" maps an untyped output ("${collectiveType || 'unnamed'}") with no output_path; declare output_path so each member's file is unambiguous.`);
    }
  } else {
    if (schemaKind === 'review-report') path = 'artifacts/review-report.json';
    else if (schemaKind === 'test-result') path = 'artifacts/test-result.json';
    else path = `artifacts/${kebab(base) || kebab(kind)}.md`;
    if (isBody && iteration != null) path = withGeneration(path, iteration);
  }

  const contract = resolveContract(playbook, base);
  const mediaType = schemaKind
    ? 'application/json'
    : contract && typeof contract.media_type === 'string'
      ? contract.media_type
      : 'text/markdown';
  const instructions = contract && typeof contract.instructions === 'string' ? contract.instructions : null;

  return { path, mediaType, schemaKind, instructions, collectiveType, memberType, isMap };
}

/**
 * Like `planOutput`, but returns `null` instead of throwing when the step is not
 * path-resolvable under v1 prompt rules (used by the flow cursor).
 */
export function tryPlanOutput(
  playbook: Playbook,
  step: PlaybookStep,
  stepId: string,
  kind: string,
  isMap: boolean,
  actor: string | null,
  iteration: number | null,
  isBody: boolean,
): PlannedOutput | null {
  try {
    return planOutput(playbook, step, stepId, kind, isMap, actor, iteration, isBody);
  } catch (err) {
    if (err instanceof PromptResolveError) return null;
    throw err;
  }
}

/**
 * Plan every map-member output path using the same rules as `fadeno prompt`.
 * Returns `null` if any member is not path-resolvable (so `next` will not claim
 * the step is promptable).
 */
export function planMapMemberOutputs(
  playbook: Playbook,
  step: PlaybookStep,
  members: string[],
  iteration: number | null,
  isBody: boolean,
): PlannedOutput[] | null {
  const stepId = typeof step.id === 'string' ? step.id : '';
  const kind = typeof step.kind === 'string' ? step.kind : 'map';
  const planned: PlannedOutput[] = [];
  for (const member of members) {
    const one = tryPlanOutput(playbook, step, stepId, kind, true, member, iteration, isBody);
    if (one == null) return null;
    planned.push(one);
  }
  return planned;
}

function resolveContract(playbook: Playbook, base: string): { media_type?: unknown; instructions?: unknown } | null {
  const contracts = playbook.artifact_contracts;
  if (!contracts || typeof contracts !== 'object' || Array.isArray(contracts)) return null;
  const contract = (contracts as Record<string, unknown>)[base];
  return contract && typeof contract === 'object' && !Array.isArray(contract) ? (contract as Record<string, unknown>) : null;
}

/** Find a gate/loop that consumes this collective artifact type (for prompt notes + cursor). */
export function resolveDownstream(flow: PlaybookStep[], collectiveType: string): DownstreamNote | null {
  const base = baseArtifact(collectiveType);
  if (!base) return null;
  const consumes = (step: PlaybookStep): boolean => asStringArray(step.input).some((type) => baseArtifact(type) === base);
  for (const step of flow) {
    if (step.kind === 'gate' && typeof step.condition === 'string' && consumes(step)) {
      return { gateStep: step.id as string, condition: step.condition };
    }
  }
  for (const step of flow) {
    if (step.kind === 'loop' && typeof step.until === 'string' && consumes(step)) {
      return { gateStep: step.id as string, condition: step.until };
    }
  }
  return null;
}

/**
 * Planned path for the assembled `Name[]` array a map writes when its output
 * feeds a gate/loop. Prefers a stem derived from member `output_path`s (so
 * `cross-review.architect_fable.json` → `cross-review.json`); otherwise the
 * schema default (`artifacts/review-report.json`) with generation when in a
 * loop body. Returns null when the output is not an array type or nothing
 * downstream consumes it as a gate/loop input.
 */
export function planCollectivePath(
  flow: PlaybookStep[],
  step: PlaybookStep,
  memberPaths: string[],
  members: string[],
  iteration: number | null,
  isBody: boolean,
): string | null {
  const collectiveType = typeof step.output === 'string' ? step.output : '';
  if (!collectiveType.endsWith('[]')) return null;
  if (resolveDownstream(flow, collectiveType) == null) return null;

  if (memberPaths.length > 0 && members.length > 0) {
    const first = memberPaths[0]!;
    const member = members[0]!;
    for (const sep of [`.${member}`, `/${member}`, `-${member}`] as const) {
      if (first.includes(sep)) {
        let stem = first.split(sep).join('');
        // If the member template already carried `.v<G>`, the stem does too.
        if (isBody && iteration != null && !/\.v\d+(\.|$)/.test(stem)) {
          stem = withGeneration(stem, iteration);
        }
        return stem;
      }
    }
  }

  const base = baseArtifact(collectiveType);
  const schema = schemaKindFor(base);
  let path: string;
  if (schema === 'review-report') path = 'artifacts/review-report.json';
  else if (schema === 'test-result') path = 'artifacts/test-result.json';
  else path = `artifacts/${typeof step.id === 'string' ? step.id : 'collective'}.json`;
  if (isBody && iteration != null) path = withGeneration(path, iteration);
  return path;
}

function resolvePurpose(playbook: Playbook, actor: string | null): string | null {
  if (actor == null) return null;
  const roles = playbook.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return null;
  const role = (roles as Record<string, unknown>)[actor];
  if (!role || typeof role !== 'object') return null;
  const purpose = (role as Record<string, unknown>).purpose;
  return typeof purpose === 'string' ? purpose : null;
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

export type Severity = 'error' | 'warning';

export type SchemaKind = 'playbook' | 'run' | 'review-report' | 'test-result';

export interface ValidationIssue {
  file: string;
  path: string;
  message: string;
  severity: Severity;
}

export interface FileValidationResult {
  file: string;
  kind: SchemaKind;
  ok: boolean;
  issues: ValidationIssue[];
}

const SCHEMA_FILE: Record<SchemaKind, string> = {
  playbook: 'playbook.schema.json',
  run: 'run.schema.json',
  'review-report': 'review-report.schema.json',
  'test-result': 'test-result.schema.json',
};

/** Step-reference fields whose value must resolve to a defined step id. */
const SINGLE_REF_FIELDS = [
  'next',
  'on_pass',
  'on_fail',
  'on_approve',
  'on_reject',
  'on_success',
  'on_exhausted',
  'default',
] as const;

/** Every field that can suppress ordinary physical fallthrough. */
const OUTGOING_FIELDS = SINGLE_REF_FIELDS;

const LOOP_BODY_CONTROL_FIELDS = [...OUTGOING_FIELDS, 'routes'] as const;

/** Condition registry shared conceptually with the gate command. */
const CONDITION_ARTIFACTS: Record<string, string[]> = {
  no_blocking_issues: ['ReviewReport'],
  tests_pass: ['TestResult'],
};

interface Step {
  id?: unknown;
  kind?: unknown;
  actor?: unknown;
  actors?: unknown;
  over?: unknown;
  input?: unknown;
  output?: unknown;
  body?: unknown;
  routes?: unknown;
  condition?: unknown;
  until?: unknown;
  terminal_status?: unknown;
  [key: string]: unknown;
}

interface Playbook {
  roles?: unknown;
  flow?: unknown;
  [key: string]: unknown;
}

/** A lazily-compiling, caching factory for the shipped schemas. */
export class SchemaSet {
  private readonly cache = new Map<SchemaKind, ValidateFunction>();
  private readonly ajv: Ajv;
  private readonly schemasDir: string;

  constructor(schemasDir: string) {
    this.schemasDir = schemasDir;
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.ajv.addFormat('date-time', (value: string) => !Number.isNaN(Date.parse(value)));
  }

  has(kind: SchemaKind): boolean {
    return existsSync(join(this.schemasDir, SCHEMA_FILE[kind]));
  }

  get(kind: SchemaKind): ValidateFunction {
    const cached = this.cache.get(kind);
    if (cached) return cached;
    const path = join(this.schemasDir, SCHEMA_FILE[kind]);
    if (!existsSync(path)) throw new Error(`Missing schema: ${path}`);
    const validate = this.ajv.compile(JSON.parse(readFileSync(path, 'utf8')));
    this.cache.set(kind, validate);
    return validate;
  }
}

function formatAjvError(err: ErrorObject): string {
  const detail = err.message ?? 'is invalid';
  if (err.keyword === 'additionalProperties') {
    const prop = (err.params as { additionalProperty?: string }).additionalProperty;
    return `unknown property "${prop}"`;
  }
  if (err.keyword === 'enum') {
    const allowed = (err.params as { allowedValues?: unknown[] }).allowedValues;
    return `${detail}: ${JSON.stringify(allowed)}`;
  }
  return detail;
}

function schemaIssues(file: string, validate: ValidateFunction, doc: unknown): ValidationIssue[] {
  if (validate(doc)) return [];
  return (validate.errors ?? []).map<ValidationIssue>((err) => ({
    file,
    path: err.instancePath || '/',
    message: formatAjvError(err),
    severity: 'error',
  }));
}

/** Human-readable schema errors for callers that validate artifacts directly. */
export function schemaErrorMessages(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(formatAjvError);
}

/** Strip the collection marker so logical artifact versions compare by type. */
function baseArtifact(name: string): string {
  return name.replace(/\[\]$/, '');
}

/**
 * Reference-integrity check. References in all control-flow fields, loop
 * bodies, and router routes must resolve to a defined step id.
 */
export function referenceIntegrity(playbook: Playbook, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const flow = playbook.flow;
  if (!Array.isArray(flow)) return issues;

  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const step of flow as Step[]) {
    if (typeof step?.id !== 'string') continue;
    if (seen.has(step.id)) {
      issues.push({ file, path: `/flow (id "${step.id}")`, message: 'duplicate step id', severity: 'error' });
    }
    seen.add(step.id);
    ids.add(step.id);
  }

  const err = (path: string, message: string): void => {
    issues.push({ file, path, message, severity: 'error' });
  };

  flow.forEach((rawStep, index) => {
    const step = rawStep as Step;
    const base = `/flow/${index}`;
    const where = typeof step?.id === 'string' ? `${base} (id "${step.id}")` : base;
    for (const field of SINGLE_REF_FIELDS) {
      const target = step?.[field];
      if (typeof target === 'string' && !ids.has(target)) err(`${where}/${field}`, `references undefined step "${target}"`);
    }
    if (Array.isArray(step?.body)) {
      step.body.forEach((target, bodyIndex) => {
        if (typeof target === 'string' && !ids.has(target)) err(`${where}/body/${bodyIndex}`, `references undefined step "${target}"`);
      });
    }
    if (step?.routes && typeof step.routes === 'object' && !Array.isArray(step.routes)) {
      for (const [label, target] of Object.entries(step.routes as Record<string, unknown>)) {
        if (typeof target === 'string' && !ids.has(target)) err(`${where}/routes/${label}`, `references undefined step "${target}"`);
      }
    }
  });
  return issues;
}

function stepWhere(step: Step, index: number): string {
  return `/flow/${index}` + (typeof step.id === 'string' ? ` (id "${step.id}")` : '');
}

function stringTargets(step: Step): string[] {
  const targets: string[] = [];
  for (const field of OUTGOING_FIELDS) {
    if (typeof step[field] === 'string') targets.push(step[field] as string);
  }
  if (step.routes && typeof step.routes === 'object' && !Array.isArray(step.routes)) {
    for (const target of Object.values(step.routes as Record<string, unknown>)) {
      if (typeof target === 'string') targets.push(target);
    }
  }
  return targets;
}

function hasExplicitOutgoing(step: Step): boolean {
  if (stringTargets(step).length > 0) return true;
  return Boolean(step.routes && typeof step.routes === 'object' && !Array.isArray(step.routes));
}

function cloneSet(values: Set<string>): Set<string> {
  return new Set(values);
}

function unionInto(target: Set<string>, source: Set<string>): void {
  for (const value of source) target.add(value);
}

function sameSet(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

function intersection(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const result = cloneSet(sets[0]!);
  for (const set of sets.slice(1)) {
    for (const item of result) if (!set.has(item)) result.delete(item);
  }
  return result;
}

function addStepOutput(available: Set<string>, step: Step): void {
  if (typeof step.output === 'string') available.add(baseArtifact(step.output));
}

/** Return logical artifact types produced by a loop body in listed order. */
function bodyOutputs(loop: Step, byId: Map<string, Step>, visiting = new Set<string>()): Set<string> {
  const available = new Set<string>();
  const loopId = typeof loop.id === 'string' ? loop.id : undefined;
  if (loopId && visiting.has(loopId)) return available;
  const nextVisiting = loopId ? new Set(visiting).add(loopId) : visiting;
  if (!Array.isArray(loop.body)) return available;
  for (const id of loop.body) {
    if (typeof id !== 'string') continue;
    const bodyStep = byId.get(id);
    if (!bodyStep) continue;
    addStepOutput(available, bodyStep);
    if (bodyStep.kind === 'loop') unionInto(available, bodyOutputs(bodyStep, byId, nextVisiting));
  }
  return available;
}

function transfer(step: Step, incoming: Set<string>, byId: Map<string, Step>): Set<string> {
  const outgoing = cloneSet(incoming);
  if (step.kind === 'loop') unionInto(outgoing, bodyOutputs(step, byId));
  else addStepOutput(outgoing, step);
  return outgoing;
}

function bodyReachability(id: string, byId: Map<string, Step>, reachable: Set<string>, visiting = new Set<string>()): void {
  if (visiting.has(id)) return;
  const step = byId.get(id);
  if (!step) return;
  reachable.add(id);
  if (step.kind !== 'loop' || !Array.isArray(step.body)) return;
  const nextVisiting = new Set(visiting).add(id);
  for (const bodyId of step.body) if (typeof bodyId === 'string') bodyReachability(bodyId, byId, reachable, nextVisiting);
}

interface FlowModel {
  flow: Step[];
  byId: Map<string, Step>;
  indexById: Map<string, number>;
  bodyOwner: Map<string, string>;
  outerIds: string[];
  outerEdges: Map<string, string[]>;
  incoming: Map<string, Set<string>>;
  reachable: Set<string>;
}

function buildFlowModel(playbook: Playbook, issues: ValidationIssue[], file: string): FlowModel {
  const flow = Array.isArray(playbook.flow) ? (playbook.flow as Step[]) : [];
  const byId = new Map<string, Step>();
  const indexById = new Map<string, number>();
  flow.forEach((step, index) => {
    if (typeof step.id === 'string') {
      byId.set(step.id, step);
      indexById.set(step.id, index);
    }
  });

  const bodyOwner = new Map<string, string>();
  flow.forEach((step, index) => {
    if (step.kind !== 'loop' || !Array.isArray(step.body)) return;
    for (const [bodyIndex, bodyId] of step.body.entries()) {
      if (typeof bodyId !== 'string') continue;
      const existing = bodyOwner.get(bodyId);
      if (existing && existing !== step.id) {
        issues.push({ file, path: `${stepWhere(step, index)}/body/${bodyIndex}`, message: `loop body step "${bodyId}" belongs to multiple loops (already owned by "${existing}")`, severity: 'error' });
      } else if (!existing && typeof step.id === 'string') {
        bodyOwner.set(bodyId, step.id);
      }
    }
  });

  const contains = (loopId: string, targetId: string, seen = new Set<string>()): boolean => {
    if (seen.has(loopId)) return false;
    const loop = byId.get(loopId);
    if (!loop || loop.kind !== 'loop' || !Array.isArray(loop.body)) return false;
    const nextSeen = new Set(seen).add(loopId);
    return loop.body.some((bodyId) => typeof bodyId === 'string' && (bodyId === targetId || contains(bodyId, targetId, nextSeen)));
  };
  flow.forEach((step, index) => {
    if (step.kind === 'loop' && typeof step.id === 'string' && contains(step.id, step.id)) {
      issues.push({ file, path: `${stepWhere(step, index)}/body`, message: `loop body recursively contains loop "${step.id}"`, severity: 'error' });
    }
  });

  const outerIds = flow.filter((step) => typeof step.id === 'string' && !bodyOwner.has(step.id)).map((step) => step.id as string);
  const outerSet = new Set(outerIds);
  const nextOuter = (id: string): string | undefined => {
    const position = outerIds.indexOf(id);
    return position >= 0 ? outerIds[position + 1] : undefined;
  };
  const outerEdges = new Map<string, string[]>();
  for (const id of outerIds) {
    const step = byId.get(id)!;
    const allTargets = stringTargets(step);
    for (const target of allTargets) {
      if (!outerSet.has(target) && bodyOwner.has(target)) {
        issues.push({ file, path: `${stepWhere(step, indexById.get(id)!)}`, message: `control-flow edge targets loop-body step "${target}", which is not independently reachable`, severity: 'error' });
      }
    }
    const explicitTargets = allTargets.filter((target) => outerSet.has(target));
    const terminalMarked = typeof step.terminal_status === 'string';
    const targets = explicitTargets.length > 0 || hasExplicitOutgoing(step)
      ? explicitTargets
      : terminalMarked
        ? []
        : (nextOuter(id) ? [nextOuter(id)!] : []);
    outerEdges.set(id, targets);
  }

  const first = flow[0];
  if (first && typeof first.id === 'string' && bodyOwner.has(first.id)) {
    issues.push({ file, path: '/flow/0', message: `entry step "${first.id}" is a loop-body step and has no outer-flow entry`, severity: 'error' });
  }

  const reachable = new Set<string>();
  const visitOuter = (id: string, visiting = new Set<string>()): void => {
    if (visiting.has(id) || reachable.has(id)) return;
    const step = byId.get(id);
    if (!step) return;
    reachable.add(id);
    const nextVisiting = new Set(visiting).add(id);
    if (step.kind === 'loop' && Array.isArray(step.body)) {
      for (const bodyId of step.body) if (typeof bodyId === 'string') bodyReachability(bodyId, byId, reachable);
    }
    for (const target of outerEdges.get(id) ?? []) visitOuter(target, nextVisiting);
  };
  if (first && typeof first.id === 'string' && outerSet.has(first.id)) visitOuter(first.id);

  for (const id of outerIds) {
    if (!reachable.has(id)) {
      const step = byId.get(id)!;
      issues.push({ file, path: stepWhere(step, indexById.get(id)!), message: `unreachable outer-flow step "${id}"; it is not reached by an explicit edge (possible accidental fallthrough/orphan loop-body definition)`, severity: 'error' });
    }
  }

  const predecessorIds = new Map<string, string[]>();
  for (const id of outerIds) predecessorIds.set(id, []);
  for (const [source, targets] of outerEdges) for (const target of targets) predecessorIds.get(target)?.push(source);

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const entryId = first && typeof first.id === 'string' ? first.id : undefined;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let changed = false;
    for (const id of outerIds) {
      if (!reachable.has(id)) continue;
      const predecessors = predecessorIds.get(id) ?? [];
      let nextIncoming: Set<string> | undefined;
      if (id === entryId) nextIncoming = new Set();
      else if (predecessors.length > 0 && predecessors.every((pred) => outgoing.has(pred))) {
        nextIncoming = intersection(predecessors.map((pred) => outgoing.get(pred)!));
      }
      if (!nextIncoming) continue;
      const nextOutgoing = transfer(byId.get(id)!, nextIncoming, byId);
      if (!sameSet(incoming.get(id), nextIncoming) || !sameSet(outgoing.get(id), nextOutgoing)) changed = true;
      incoming.set(id, nextIncoming);
      outgoing.set(id, nextOutgoing);
    }
    if (!changed) break;
  }

  return { flow, byId, indexById, bodyOwner, outerIds, outerEdges, incoming, reachable };
}

function conditionIssues(step: Step, index: number, available: Set<string>, producedByBody: Set<string>, file: string, issues: ValidationIssue[]): void {
  if (step.kind !== 'gate' && step.kind !== 'loop') return;
  const where = stepWhere(step, index);
  const field = step.kind === 'gate' ? 'condition' : 'until';
  const condition = typeof step[field] === 'string' ? step[field] as string : undefined;
  if (!condition) return;
  const accepted = CONDITION_ARTIFACTS[condition];
  if (!accepted) issues.push({ file, path: `${where}/${field}`, message: `unsupported condition "${condition}"`, severity: 'error' });

  const inputs = Array.isArray(step.input) ? step.input.filter((input): input is string => typeof input === 'string') : [];
  if (inputs.length !== 1) {
    issues.push({ file, path: `${where}/input`, message: `${step.kind} condition must declare exactly one input artifact in Milestone 1`, severity: 'error' });
    return;
  }
  const input = inputs[0]!;
  const logical = baseArtifact(input);
  if (accepted && !accepted.includes(logical)) issues.push({ file, path: `${where}/input/0`, message: `condition "${condition}" accepts ${accepted.join(' or ')}, not "${input}"`, severity: 'error' });
  if (!available.has(logical) && !producedByBody.has(logical)) issues.push({ file, path: `${where}/input/0`, message: `condition input artifact "${input}" is not definitely available on this path`, severity: 'error' });
}

function flowAndArtifactChecks(playbook: Playbook, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const model = buildFlowModel(playbook, issues, file);
  const { byId, incoming, bodyOwner } = model;

  for (const [bodyId, ownerId] of bodyOwner) {
    if (!model.reachable.has(bodyId)) {
      const bodyStep = byId.get(bodyId);
      if (bodyStep) {
        issues.push({
          file,
          path: stepWhere(bodyStep, model.indexById.get(bodyId)!),
          message: `loop-body step "${bodyId}" is not reachable through its owning loop "${ownerId}"`,
          severity: 'error',
        });
      }
    }
  }

  for (const [id, step] of byId) {
    const index = model.indexById.get(id)!;
    const where = stepWhere(step, index);
    if (bodyOwner.has(id)) {
      for (const field of LOOP_BODY_CONTROL_FIELDS) {
        if (step[field] !== undefined) {
          issues.push({
            file,
            path: `${where}/${field}`,
            message: `loop-body step "${id}" cannot declare explicit control flow "${field}" in Milestone 1; body steps execute in listed order`,
            severity: 'error',
          });
        }
      }
      if (step.kind === 'gate' || typeof step.condition === 'string' || typeof step.until === 'string') {
        issues.push({
          file,
          path: `${where}/kind`,
          message: `loop-body step "${id}" cannot be a gate or declare a condition in Milestone 1; loop bodies are linear`,
          severity: 'error',
        });
      }
      if (step.kind === 'loop') {
        issues.push({
          file,
          path: `${where}/kind`,
          message: `loop-body step "${id}" cannot be a nested loop in Milestone 1`,
          severity: 'error',
        });
      }
      if (step.terminal_status !== undefined) issues.push({ file, path: `${where}/terminal_status`, message: 'terminal_status is not allowed on a loop-body step', severity: 'error' });
      continue;
    }
    if (step.terminal_status !== undefined && hasExplicitOutgoing(step)) {
      issues.push({ file, path: `${where}/terminal_status`, message: 'terminal_status is only valid on a terminal step; this step has an outgoing control-flow edge', severity: 'error' });
    } else if (step.terminal_status === undefined && (model.outerEdges.get(id)?.length ?? 0) === 0) {
      issues.push({ file, path: where, message: 'terminal step is missing terminal_status; executor may default to completed', severity: 'warning' });
    }
  }

  for (const id of model.outerIds) {
    if (!model.reachable.has(id)) continue;
    const step = byId.get(id)!;
    const index = model.indexById.get(id)!;
    const available = incoming.get(id);
    if (!available) continue;
    const conditionInputIndex = (step.kind === 'gate' || step.kind === 'loop') && Array.isArray(step.input) && step.input.length === 1 ? 0 : -1;
    if (Array.isArray(step.input)) {
      for (const [inputIndex, input] of step.input.entries()) {
        if (inputIndex === conditionInputIndex || typeof input !== 'string') continue;
        if (!available.has(baseArtifact(input))) issues.push({ file, path: `${stepWhere(step, index)}/input/${inputIndex}`, message: `input artifact "${input}" is not definitely available on every incoming path`, severity: 'error' });
      }
    }

    const producedByBody = step.kind === 'loop' ? bodyOutputs(step, byId) : new Set<string>();
    conditionIssues(step, index, available, producedByBody, file, issues);

    if (step.kind === 'loop' && Array.isArray(step.body)) {
      const bodyAvailable = cloneSet(available);
      for (const bodyId of step.body) {
        if (typeof bodyId !== 'string') continue;
        const bodyStep = byId.get(bodyId);
        if (!bodyStep) continue;
        const bodyIndex = model.indexById.get(bodyId)!;
        if (Array.isArray(bodyStep.input)) {
          for (const [inputIndex, input] of bodyStep.input.entries()) {
            if (typeof input === 'string' && !bodyAvailable.has(baseArtifact(input))) issues.push({ file, path: `${stepWhere(bodyStep, bodyIndex)}/input/${inputIndex}`, message: `loop-body input artifact "${input}" is not definitely available when "${step.id}" runs`, severity: 'error' });
          }
        }
        if (bodyStep.kind === 'loop') unionInto(bodyAvailable, bodyOutputs(bodyStep, byId));
        addStepOutput(bodyAvailable, bodyStep);
      }
    }
  }
  return issues;
}

/** Steps that appear in some loop's `body` (i.e. loop-body steps). */
function loopBodyIds(flow: Step[]): Set<string> {
  const ids = new Set<string>();
  for (const step of flow) {
    if (step.kind === 'loop' && Array.isArray(step.body)) {
      for (const id of step.body) if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

/** Every logical output base name declared anywhere in the flow. */
function declaredOutputBases(flow: Step[]): Set<string> {
  const bases = new Set<string>();
  for (const step of flow) {
    if (typeof step.output === 'string') bases.add(baseArtifact(step.output));
  }
  return bases;
}

const ITERATION_TOKEN = '{iteration}';

/** Reason an output_path template is path-unsafe, or null when it is safe. */
function unsafeTemplate(template: string): string | null {
  if (template.includes('\\')) return 'contains a backslash';
  if (/^([a-zA-Z]:)?\//.test(template)) return 'is an absolute path';
  if (template.split('/').some((segment) => segment === '..')) return 'contains a ".." segment';
  return null;
}

/** Every literal template string in an `output_path` (string or member map). */
function templateStrings(spec: string | Record<string, unknown>): string[] {
  if (typeof spec === 'string') return [spec];
  return Object.values(spec).filter((value): value is string => typeof value === 'string');
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;
}

/**
 * Static checks for the `output_path`, `input_bindings`, and `artifact_contracts`
 * fields consumed by `fadeno prompt`. Additive and control-flow-free; every issue
 * is error-severity because it indicates an unusable output contract.
 */
function outputContractChecks(playbook: Playbook, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const flow = Array.isArray(playbook.flow) ? (playbook.flow as Step[]) : [];
  const bodyIds = loopBodyIds(flow);

  flow.forEach((step, index) => {
    const where = stepWhere(step, index);
    const overList = stringList(step.over);
    const outputPath = step.output_path;

    if (outputPath !== undefined && outputPath !== null) {
      // 1. output_path on a step that produces nothing.
      if (typeof step.output !== 'string' && step.over === undefined) {
        issues.push({ file, path: `${where}/output_path`, message: 'output_path on a step that produces nothing (no output or over)', severity: 'error' });
      }
      const isMemberMap = typeof outputPath === 'object' && !Array.isArray(outputPath);
      if (isMemberMap) {
        const map = outputPath as Record<string, unknown>;
        // 2. member-map keys must exactly equal the literal `over` role list.
        if (!overList) {
          issues.push({ file, path: `${where}/output_path`, message: 'output_path member map requires a literal `over` role list', severity: 'error' });
        } else {
          const overSet = new Set(overList);
          const extras = Object.keys(map).filter((key) => !overSet.has(key));
          const missing = overList.filter((member) => !(member in map));
          if (extras.length > 0 || missing.length > 0) {
            const parts: string[] = [];
            if (missing.length) parts.push(`missing ${missing.join(', ')}`);
            if (extras.length) parts.push(`unexpected ${extras.join(', ')}`);
            issues.push({ file, path: `${where}/output_path`, message: `output_path member map keys must match the \`over\` role list (${parts.join('; ')})`, severity: 'error' });
          }
        }
      } else if (typeof outputPath === 'string' && overList && overList.length > 1 && !outputPath.includes('{actor}')) {
        // 3. a single string template for a map over roles must vary by {actor}.
        issues.push({ file, path: `${where}/output_path`, message: 'output_path string template for a map over roles must contain {actor}', severity: 'error' });
      }

      const isBody = typeof step.id === 'string' && bodyIds.has(step.id);
      for (const template of templateStrings(outputPath as string | Record<string, unknown>)) {
        // 4. loop bodies are generation-scoped; non-loop steps are not.
        if (isBody && !template.includes(ITERATION_TOKEN)) {
          issues.push({ file, path: `${where}/output_path`, message: `loop-body step output_path template "${template}" must contain {iteration}`, severity: 'error' });
        } else if (!isBody && template.includes(ITERATION_TOKEN)) {
          issues.push({ file, path: `${where}/output_path`, message: `non-loop-body step output_path template "${template}" must not contain {iteration}`, severity: 'error' });
        }
        // 5. path safety.
        const unsafe = unsafeTemplate(template);
        if (unsafe) issues.push({ file, path: `${where}/output_path`, message: `output_path template "${template}" ${unsafe}`, severity: 'error' });
      }

      // 6. static collision: expand over the literal role list; {actor} -> member.
      if (overList && overList.length > 0) {
        const seen = new Map<string, string>();
        for (const member of overList) {
          const template = isMemberMap ? (outputPath as Record<string, unknown>)[member] : outputPath;
          if (typeof template !== 'string') continue;
          const expanded = template.split('{actor}').join(member);
          const prior = seen.get(expanded);
          if (prior !== undefined) {
            issues.push({ file, path: `${where}/output_path`, message: `output_path collides: members "${prior}" and "${member}" both resolve to "${expanded}"`, severity: 'error' });
          } else {
            seen.set(expanded, member);
          }
        }
      }
    }

    // 8. input_bindings keys must be `over` members; refs must be declared inputs.
    const inputBindings = step.input_bindings;
    if (inputBindings && typeof inputBindings === 'object' && !Array.isArray(inputBindings)) {
      const overSet = new Set(overList ?? []);
      const inputSet = new Set(stringList(step.input) ?? []);
      for (const [actor, binding] of Object.entries(inputBindings as Record<string, unknown>)) {
        if (!overSet.has(actor)) {
          issues.push({ file, path: `${where}/input_bindings/${actor}`, message: `input_bindings key "${actor}" is not a member of \`over\``, severity: 'error' });
        }
        if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
          for (const role of ['primary', 'context'] as const) {
            for (const ref of stringList((binding as Record<string, unknown>)[role]) ?? []) {
              if (!inputSet.has(ref)) {
                issues.push({ file, path: `${where}/input_bindings/${actor}/${role}`, message: `input_bindings references artifact "${ref}", which is not a declared input of this step`, severity: 'error' });
              }
            }
          }
        }
      }
    }
  });

  // 7. artifact_contracts keys must each match a declared output base name.
  const contracts = playbook.artifact_contracts;
  if (contracts && typeof contracts === 'object' && !Array.isArray(contracts)) {
    const outputBases = declaredOutputBases(flow);
    for (const key of Object.keys(contracts as Record<string, unknown>)) {
      if (!outputBases.has(key)) {
        issues.push({ file, path: `/artifact_contracts/${key}`, message: `artifact_contracts key "${key}" does not match any declared output artifact`, severity: 'error' });
      }
    }
  }

  return issues;
}

/**
 * Semantic checks: actor references, role usage, normalized control flow,
 * terminal declarations, condition bindings, reachability, and definite
 * artifact availability on every incoming path.
 */
export function semanticChecks(playbook: Playbook, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const roles = playbook.roles && typeof playbook.roles === 'object' ? new Set(Object.keys(playbook.roles)) : new Set<string>();
  const flow = Array.isArray(playbook.flow) ? (playbook.flow as Step[]) : [];
  const usedRoles = new Set<string>();

  flow.forEach((step, index) => {
    const where = stepWhere(step, index);
    const actorRefs: Array<[string, string]> = [];
    if (typeof step.actor === 'string') actorRefs.push(['actor', step.actor]);
    if (Array.isArray(step.actors)) step.actors.forEach((actor, actorIndex) => { if (typeof actor === 'string') actorRefs.push([`actors/${actorIndex}`, actor]); });
    for (const [field, role] of actorRefs) {
      usedRoles.add(role);
      if (!roles.has(role)) issues.push({ file, path: `${where}/${field}`, message: `actor "${role}" is not a declared role`, severity: 'error' });
    }
    if (Array.isArray(step.over)) for (const item of step.over) if (typeof item === 'string') usedRoles.add(item);
  });

  for (const role of roles) if (!usedRoles.has(role)) issues.push({ file, path: `/roles/${role}`, message: `role "${role}" is declared but never used`, severity: 'warning' });
  issues.push(...flowAndArtifactChecks(playbook, file));
  issues.push(...outputContractChecks(playbook, file));
  return issues;
}

function isPlaybookShape(doc: Record<string, unknown>): boolean {
  return doc.kind === 'AgentPlaybook' || ('flow' in doc && 'roles' in doc);
}

function isRunShape(doc: Record<string, unknown>): boolean {
  return 'run_id' in doc || ('status' in doc && 'started_at' in doc);
}

function isReviewReportShape(doc: unknown): boolean {
  return Boolean(doc && typeof doc === 'object' && !Array.isArray(doc) && 'reviewer' in doc && 'issues' in doc && 'verdict' in doc);
}

function isTestResultShape(doc: unknown): boolean {
  return Boolean(doc && typeof doc === 'object' && !Array.isArray(doc) && 'tool' in doc && 'command' in doc && 'status' in doc && 'exit_code' in doc && 'summary' in doc);
}

/** Best-effort detection of a document's schema kind from path and content. */
export function detectKind(file: string, doc: unknown): SchemaKind | null {
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && isPlaybookShape(doc as Record<string, unknown>)) return 'playbook';
  if (isReviewReportShape(doc)) return 'review-report';
  if (Array.isArray(doc) && doc.length > 0 && doc.every((item) => isReviewReportShape(item))) return 'review-report';
  if (isTestResultShape(doc)) return 'test-result';
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && isRunShape(doc as Record<string, unknown>)) return 'run';
  if (file.includes(`${join('.fadeno', 'playbooks')}`)) return 'playbook';
  if (file.includes(`${join('.fadeno', 'runs')}`)) return 'run';
  if (file.endsWith('review-report.json')) return 'review-report';
  if (file.endsWith('test-result.json')) return 'test-result';
  return null;
}

/** Validate one file: schema, then playbook references and semantic analysis. */
export function validateFile(file: string, schemas: SchemaSet, forcedKind?: SchemaKind): FileValidationResult {
  const fail = (kind: SchemaKind, message: string): FileValidationResult => ({ file, kind, ok: false, issues: [{ file, path: '', message, severity: 'error' }] });
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return fail(forcedKind ?? 'playbook', `cannot read file: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return fail(forcedKind ?? 'playbook', `invalid YAML/JSON: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object') return fail(forcedKind ?? 'playbook', 'document must be a mapping or a supported artifact array');

  const record = !Array.isArray(doc) ? doc as Record<string, unknown> : undefined;
  const kind = forcedKind ?? detectKind(file, doc);
  if (!kind) return fail('playbook', 'could not determine document type (playbook | run | review-report | test-result); pass --schema to force it');

  let validate: ValidateFunction;
  try {
    validate = schemas.get(kind);
  } catch (err) {
    return fail(kind, (err as Error).message);
  }
  const issues = schemaIssues(file, validate, doc);
  if (kind === 'playbook' && record) {
    // References remain useful diagnostics even when a structural rule (for
    // example a missing gate input) also failed. Deeper artifact analysis waits
    // for a schema-clean document because it relies on normalized fields.
    issues.push(...referenceIntegrity(record as Playbook, file));
    if (issues.length === 0) issues.push(...semanticChecks(record as Playbook, file));
  }
  return { file, kind, ok: issues.every((issue) => issue.severity !== 'error'), issues };
}

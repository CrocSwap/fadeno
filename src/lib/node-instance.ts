import { createHash } from 'node:crypto';

export class NodeInstanceError extends Error {}

export type NodeInstanceSelector =
  | { kind: 'member'; value: string }
  | { kind: 'generation'; value: number };

export interface NodeInstanceSegment {
  step: string;
  selector: NodeInstanceSelector | null;
}

export interface NodeInstance {
  id: string;
  parentId: string | null;
  step: string;
  segments: NodeInstanceSegment[];
  /** Nearest enclosing map member, if any. */
  member: string | null;
  /** Nearest enclosing loop generation, if any. */
  generation: number | null;
}

const STEP = /^[a-z0-9][a-z0-9_]*$/;
const MEMBER_PREFIX = '[member=';
const GENERATION_PREFIX = '[generation=';

function assertStep(step: string): void {
  if (!STEP.test(step)) {
    throw new NodeInstanceError(`invalid step id "${step}" in node instance; expected ${STEP.source}.`);
  }
}

function encodeMember(member: string): string {
  if (member.length === 0) throw new NodeInstanceError('map member identity must not be empty.');
  return encodeURIComponent(member).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeMember(encoded: string): string {
  try {
    const member = decodeURIComponent(encoded);
    if (member.length === 0) throw new NodeInstanceError('map member identity must not be empty.');
    if (encodeMember(member) !== encoded) {
      throw new NodeInstanceError(`map member encoding is not canonical: "${encoded}".`);
    }
    return member;
  } catch (err) {
    if (err instanceof NodeInstanceError) throw err;
    throw new NodeInstanceError(`invalid map member encoding "${encoded}".`);
  }
}

function renderSegment(segment: NodeInstanceSegment): string {
  assertStep(segment.step);
  if (segment.selector == null) return segment.step;
  if (segment.selector.kind === 'member') {
    return `${segment.step}${MEMBER_PREFIX}${encodeMember(segment.selector.value)}]`;
  }
  const generation = segment.selector.value;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new NodeInstanceError(`loop generation must be a positive safe integer; got ${generation}.`);
  }
  return `${segment.step}${GENERATION_PREFIX}${generation}]`;
}

export function nodeInstanceId(segments: NodeInstanceSegment[]): string {
  if (segments.length === 0) throw new NodeInstanceError('a node instance must contain at least one segment.');
  return segments.map(renderSegment).join('/');
}

function parseSegment(raw: string): NodeInstanceSegment {
  const bracket = raw.indexOf('[');
  const step = bracket < 0 ? raw : raw.slice(0, bracket);
  assertStep(step);
  if (bracket < 0) return { step, selector: null };
  if (!raw.endsWith(']')) throw new NodeInstanceError(`invalid node instance segment "${raw}".`);
  const selector = raw.slice(bracket);
  if (selector.startsWith(MEMBER_PREFIX)) {
    const encoded = selector.slice(MEMBER_PREFIX.length, -1);
    return { step, selector: { kind: 'member', value: decodeMember(encoded) } };
  }
  if (selector.startsWith(GENERATION_PREFIX)) {
    const encoded = selector.slice(GENERATION_PREFIX.length, -1);
    if (!/^[1-9][0-9]*$/.test(encoded)) {
      throw new NodeInstanceError(`invalid loop generation "${encoded}" in node instance.`);
    }
    const value = Number(encoded);
    if (!Number.isSafeInteger(value)) throw new NodeInstanceError(`loop generation exceeds the safe integer range: ${encoded}.`);
    return { step, selector: { kind: 'generation', value } };
  }
  throw new NodeInstanceError(`unknown node instance selector in "${raw}".`);
}

export function parseNodeInstanceId(id: string): NodeInstance {
  if (id.length === 0) throw new NodeInstanceError('node instance id must not be empty.');
  const rawSegments = id.split('/');
  if (rawSegments.some((segment) => segment.length === 0)) {
    throw new NodeInstanceError(`node instance id contains an empty path segment: "${id}".`);
  }
  const segments = rawSegments.map(parseSegment);
  const canonical = nodeInstanceId(segments);
  if (canonical !== id) throw new NodeInstanceError(`node instance id is not canonical: "${id}".`);
  const parentSegments = segments.slice(0, -1);
  let member: string | null = null;
  let generation: number | null = null;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const selector = segments[index]!.selector;
    if (member == null && selector?.kind === 'member') member = selector.value;
    if (generation == null && selector?.kind === 'generation') generation = selector.value;
  }
  return {
    id: canonical,
    parentId: parentSegments.length === 0 ? null : nodeInstanceId(parentSegments),
    step: segments.at(-1)!.step,
    segments,
    member,
    generation,
  };
}

export function rootNodeInstance(step: string): NodeInstance {
  return parseNodeInstanceId(nodeInstanceId([{ step, selector: null }]));
}

export function childNodeInstance(parentId: string, step: string): NodeInstance {
  const parent = parseNodeInstanceId(parentId);
  return parseNodeInstanceId(nodeInstanceId([...parent.segments, { step, selector: null }]));
}

export function mapMemberInstance(parentId: string | null, step: string, member: string): NodeInstance {
  const prefix = parentId == null ? [] : parseNodeInstanceId(parentId).segments;
  return parseNodeInstanceId(nodeInstanceId([...prefix, { step, selector: { kind: 'member', value: member } }]));
}

export function loopGenerationInstance(parentId: string | null, step: string, generation: number): NodeInstance {
  const prefix = parentId == null ? [] : parseNodeInstanceId(parentId).segments;
  return parseNodeInstanceId(nodeInstanceId([...prefix, { step, selector: { kind: 'generation', value: generation } }]));
}

export function isDescendantInstance(parentId: string, candidateId: string): boolean {
  const parent = parseNodeInstanceId(parentId);
  const candidate = parseNodeInstanceId(candidateId);
  if (candidate.segments.length <= parent.segments.length) return false;
  return candidate.segments.slice(0, parent.segments.length).every(
    (segment, index) => renderSegment(segment) === renderSegment(parent.segments[index]!),
  );
}

/** Filesystem-safe, reversible instance scope below artifacts/instances/. */
export function nodeInstanceArtifactScope(id: string): string {
  const instance = parseNodeInstanceId(id);
  return `artifacts/instances/${instance.segments.map((segment) => {
    if (segment.selector == null) return segment.step;
    if (segment.selector.kind === 'member') return `${segment.step}/member-${encodeMember(segment.selector.value)}`;
    return `${segment.step}/g${segment.selector.value}`;
  }).join('/')}`;
}

function digestId(prefix: string, parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

export function stepExecutionIdFor(nodeInstance: string): string {
  parseNodeInstanceId(nodeInstance);
  return digestId('se', [nodeInstance]);
}

export function actorCallIdFor(nodeInstance: string, actor: string | null): string {
  parseNodeInstanceId(nodeInstance);
  return digestId('ac', [nodeInstance, actor ?? '']);
}

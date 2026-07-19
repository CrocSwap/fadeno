import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  detectKind,
  schemaErrorMessages,
  SchemaSet,
  type SchemaKind,
} from './playbook-validate.ts';
import { parseGeneration } from './prompt-resolve.ts';
import type { RunEvent } from './run-ledger.ts';

export class ManifestError extends Error {}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const MEDIA_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export function mediaTypeFor(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface ArtifactValidation {
  /** Detected typed kind, or null when the artifact is untyped (validation skipped). */
  schema: SchemaKind | null;
  ok?: boolean;
  errors?: string[];
}

/**
 * The manifest fields recorded on every `artifact_created` event. The
 * next-protocol `path` is kept under the existing `artifact` key that every
 * reader already resolves; `logical_name` is the generation-stripped relative
 * path a revision series shares (a path, not a basename — basenames collide
 * across member subdirectories).
 */
export interface ArtifactManifestFields {
  artifact_id: string;
  artifact: string;
  logical_name: string;
  generation: number;
  bytes: number;
  sha256: string;
  media_type: string;
  validation: ArtifactValidation;
}

/**
 * Read, hash, and shape-detect one artifact at record time. A typed artifact
 * that fails its schema is recorded honestly (`ok: false`) — enforcement is
 * the gate/verify layer's job; only a missing file is a hard error.
 */
export function buildArtifactManifest(
  runDir: string,
  artifactRel: string,
  artifactId: string,
  schemas: SchemaSet | null,
): ArtifactManifestFields {
  const abs = join(runDir, artifactRel);
  if (!existsSync(abs)) {
    throw new ManifestError(
      `no file at ${artifactRel} under the run directory; write the artifact before recording it.`,
    );
  }
  const bytes = readFileSync(abs);
  const { logicalPath, generation } = parseGeneration(artifactRel);
  const mediaType = mediaTypeFor(artifactRel);

  let validation: ArtifactValidation = { schema: null };
  if (mediaType === 'application/json' && schemas != null) {
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      parseOk = false;
    }
    if (parseOk) {
      const kind = detectKind(abs, parsed);
      if ((kind === 'review-report' || kind === 'test-result') && schemas.has(kind)) {
        const validate = schemas.get(kind);
        validation = validate(parsed)
          ? { schema: kind, ok: true }
          : { schema: kind, ok: false, errors: schemaErrorMessages(validate) };
      }
    }
  }

  return {
    artifact_id: artifactId,
    artifact: artifactRel,
    logical_name: logicalPath,
    generation,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    media_type: mediaType,
    validation,
  };
}

export interface ActiveArtifact {
  artifactId: string | null;
  path: string;
  logicalName: string;
  member: string | null;
  generation: number;
  seq: number | null;
  sha256: string | null;
  bytes: number | null;
}

export interface ActiveResolution {
  active: ActiveArtifact[];
  /** Genuine ambiguities: two different paths at the same (logical_name, member, generation). */
  conflicts: string[];
  /** Immutability violations: one path recorded with more than one sha256. */
  immutabilityViolations: string[];
}

interface ArtifactRecord extends ActiveArtifact {
  valid: boolean;
  index: number;
}

/**
 * The single active-artifact rule, shared by `verify` and `show` so the two
 * can never drift: per (logical_name, member) scope, the active artifact is
 * the valid record with the highest generation, ties broken by latest record.
 * Artifacts are immutable — re-recording a path with different bytes is a
 * violation, not a supersession.
 */
export function resolveActiveArtifacts(events: RunEvent[]): ActiveResolution {
  const records: ArtifactRecord[] = [];
  events.forEach((event, index) => {
    if (event.type !== 'artifact_created') return;
    const path = typeof event.extra.artifact === 'string' ? event.extra.artifact : null;
    if (path == null) return;
    const parsed = parseGeneration(path);
    const validation = event.extra.validation;
    const valid = !(
      validation !== null &&
      typeof validation === 'object' &&
      (validation as Record<string, unknown>).ok === false
    );
    records.push({
      artifactId: typeof event.extra.artifact_id === 'string' ? event.extra.artifact_id : null,
      path,
      logicalName:
        typeof event.extra.logical_name === 'string' ? event.extra.logical_name : parsed.logicalPath,
      member: typeof event.extra.member === 'string' ? event.extra.member : null,
      generation: typeof event.extra.generation === 'number' ? event.extra.generation : parsed.generation,
      seq: event.seq,
      sha256: typeof event.extra.sha256 === 'string' ? event.extra.sha256 : null,
      bytes: typeof event.extra.bytes === 'number' ? event.extra.bytes : null,
      valid,
      index,
    });
  });

  const shaByPath = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.sha256 == null) continue;
    const set = shaByPath.get(record.path) ?? new Set<string>();
    set.add(record.sha256);
    shaByPath.set(record.path, set);
  }
  const immutabilityViolations = [...shaByPath.entries()]
    .filter(([, shas]) => shas.size > 1)
    .map(([path, shas]) => `${path} recorded with ${shas.size} different sha256 values`);

  const groups = new Map<string, ArtifactRecord[]>();
  for (const record of records) {
    const key = `${record.logicalName}\u0000${record.member ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const active: ActiveArtifact[] = [];
  const conflicts: string[] = [];
  for (const group of groups.values()) {
    const valid = group.filter((record) => record.valid);
    if (valid.length === 0) continue;
    const maxGeneration = Math.max(...valid.map((record) => record.generation));
    const top = valid.filter((record) => record.generation === maxGeneration);
    const distinctPaths = [...new Set(top.map((record) => record.path))];
    if (distinctPaths.length > 1) {
      const sample = top[0]!;
      const scope = sample.member != null ? `${sample.logicalName} (member ${sample.member})` : sample.logicalName;
      conflicts.push(
        `${scope} has ${distinctPaths.length} paths at generation ${maxGeneration}: ${distinctPaths.join(', ')}`,
      );
    }
    const winner = top.reduce((a, b) => (b.index >= a.index ? b : a));
    active.push({
      artifactId: winner.artifactId,
      path: winner.path,
      logicalName: winner.logicalName,
      member: winner.member,
      generation: winner.generation,
      seq: winner.seq,
      sha256: winner.sha256,
      bytes: winner.bytes,
    });
  }

  active.sort((a, b) =>
    a.logicalName < b.logicalName ? -1 : a.logicalName > b.logicalName ? 1 : (a.member ?? '') < (b.member ?? '') ? -1 : 1,
  );
  return { active, conflicts, immutabilityViolations };
}

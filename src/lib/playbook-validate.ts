import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

export type Severity = 'error' | 'warning';

export type SchemaKind = 'playbook' | 'run' | 'review-report';

export interface ValidationIssue {
  /** Absolute path of the file the issue was found in. */
  file: string;
  /** Field/instance path within the document (e.g. `/flow/3/on_pass`). */
  path: string;
  message: string;
  severity: Severity;
}

export interface FileValidationResult {
  file: string;
  kind: SchemaKind;
  /** True when there are no `error`-severity issues (warnings are allowed). */
  ok: boolean;
  issues: ValidationIssue[];
}

const SCHEMA_FILE: Record<SchemaKind, string> = {
  playbook: 'playbook.schema.json',
  run: 'run.schema.json',
  'review-report': 'review-report.schema.json',
};

/** Step-reference fields whose value must resolve to a defined step id. */
const SINGLE_REF_FIELDS = [
  'next',
  'on_pass',
  'on_fail',
  'on_approve',
  'on_reject',
  'on_exhausted',
  'default',
] as const;

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
  [key: string]: unknown;
}

interface Playbook {
  roles?: unknown;
  flow?: unknown;
  [key: string]: unknown;
}

/** A lazily-compiling, caching factory for the three Fadeno schemas. */
export class SchemaSet {
  private readonly cache = new Map<SchemaKind, ValidateFunction>();
  private readonly ajv: Ajv;
  private readonly schemasDir: string;

  constructor(schemasDir: string) {
    this.schemasDir = schemasDir;
    this.ajv = new Ajv({ allErrors: true, strict: false });
    // Register a real (if lenient) date-time check so run.yaml timestamps are
    // actually validated — and so ajv doesn't emit an "unknown format" notice.
    // Kept dependency-free (no ajv-formats).
    this.ajv.addFormat('date-time', (value: string) => !Number.isNaN(Date.parse(value)));
  }

  has(kind: SchemaKind): boolean {
    return existsSync(join(this.schemasDir, SCHEMA_FILE[kind]));
  }

  get(kind: SchemaKind): ValidateFunction {
    const cached = this.cache.get(kind);
    if (cached) return cached;
    const path = join(this.schemasDir, SCHEMA_FILE[kind]);
    if (!existsSync(path)) {
      throw new Error(`Missing schema: ${path}`);
    }
    const schema = JSON.parse(readFileSync(path, 'utf8'));
    const validate = this.ajv.compile(schema);
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

/**
 * Reference-integrity check: every step id referenced by a control-flow field
 * (`next`, `on_pass`, `on_fail`, `on_approve`, `on_reject`, `on_exhausted`,
 * `default`), a loop `body`, or a router `routes` map must resolve to a defined
 * step. Also reports duplicate step ids. All findings are errors.
 */
export function referenceIntegrity(playbook: Playbook, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const flow = playbook.flow;
  if (!Array.isArray(flow)) return issues;

  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const step of flow as Step[]) {
    if (typeof step?.id === 'string') {
      if (seen.has(step.id)) {
        issues.push({
          file,
          path: `/flow (id "${step.id}")`,
          message: 'duplicate step id',
          severity: 'error',
        });
      }
      seen.add(step.id);
      ids.add(step.id);
    }
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
      if (typeof target === 'string' && !ids.has(target)) {
        err(`${where}/${field}`, `references undefined step "${target}"`);
      }
    }

    if (Array.isArray(step?.body)) {
      step.body.forEach((target, i) => {
        if (typeof target === 'string' && !ids.has(target)) {
          err(`${where}/body/${i}`, `references undefined step "${target}"`);
        }
      });
    }

    if (step?.routes && typeof step.routes === 'object' && !Array.isArray(step.routes)) {
      for (const [label, target] of Object.entries(step.routes as Record<string, unknown>)) {
        if (typeof target === 'string' && !ids.has(target)) {
          err(`${where}/routes/${label}`, `references undefined step "${target}"`);
        }
      }
    }
  });

  return issues;
}

/** Strip a trailing `[]` collection marker so `ReviewReport[]` matches `ReviewReport`. */
function baseArtifact(name: string): string {
  return name.replace(/\[\]$/, '');
}

/**
 * Semantic checks beyond structure and references:
 *   - error: a step `actor`/`actors` entry that is not a declared role.
 *   - warning: an `input` artifact never produced by any step's `output`.
 *   - warning: a declared role never referenced by any step.
 * `over` array items are counted as role usage (a `map` over a list of roles),
 * which is why they are not themselves error-checked against `roles`.
 */
export function semanticChecks(playbook: Playbook, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const roles =
    playbook.roles && typeof playbook.roles === 'object'
      ? new Set(Object.keys(playbook.roles))
      : new Set<string>();
  const flow = Array.isArray(playbook.flow) ? (playbook.flow as Step[]) : [];

  const produced = new Set<string>();
  for (const step of flow) {
    if (typeof step?.output === 'string') produced.add(baseArtifact(step.output));
  }

  const usedRoles = new Set<string>();

  flow.forEach((step, index) => {
    const where = `/flow/${index}` + (typeof step?.id === 'string' ? ` (id "${step.id}")` : '');

    const actorRefs: Array<[string, string]> = [];
    if (typeof step?.actor === 'string') actorRefs.push(['actor', step.actor]);
    if (Array.isArray(step?.actors)) {
      step.actors.forEach((a, j) => {
        if (typeof a === 'string') actorRefs.push([`actors/${j}`, a]);
      });
    }
    for (const [field, role] of actorRefs) {
      usedRoles.add(role);
      if (!roles.has(role)) {
        issues.push({
          file,
          path: `${where}/${field}`,
          message: `actor "${role}" is not a declared role`,
          severity: 'error',
        });
      }
    }

    if (Array.isArray(step?.over)) {
      for (const item of step.over) if (typeof item === 'string') usedRoles.add(item);
    }

    if (Array.isArray(step?.input)) {
      step.input.forEach((inp, j) => {
        if (typeof inp === 'string' && !produced.has(baseArtifact(inp))) {
          issues.push({
            file,
            path: `${where}/input/${j}`,
            message: `input artifact "${inp}" is not produced by any step's output`,
            severity: 'warning',
          });
        }
      });
    }
  });

  for (const role of roles) {
    if (!usedRoles.has(role)) {
      issues.push({
        file,
        path: `/roles/${role}`,
        message: `role "${role}" is declared but never used`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

function isPlaybookShape(doc: Record<string, unknown>): boolean {
  return doc.kind === 'AgentPlaybook' || ('flow' in doc && 'roles' in doc);
}

function isRunShape(doc: Record<string, unknown>): boolean {
  return 'run_id' in doc || ('status' in doc && 'started_at' in doc);
}

function isReviewReportShape(doc: Record<string, unknown>): boolean {
  return 'reviewer' in doc && 'issues' in doc && 'verdict' in doc;
}

/** Best-effort detection of a document's schema kind from its path and content. */
export function detectKind(file: string, doc: Record<string, unknown>): SchemaKind | null {
  if (isPlaybookShape(doc)) return 'playbook';
  if (isReviewReportShape(doc)) return 'review-report';
  if (isRunShape(doc)) return 'run';
  if (file.includes(`${join('.fadeno', 'playbooks')}`)) return 'playbook';
  if (file.includes(`${join('.fadeno', 'runs')}`)) return 'run';
  return null;
}

/**
 * Validate a single file. For playbooks this runs schema → reference integrity →
 * semantic checks; for run/review-report documents it runs the schema only.
 * `forcedKind` overrides detection.
 */
export function validateFile(
  file: string,
  schemas: SchemaSet,
  forcedKind?: SchemaKind,
): FileValidationResult {
  const fail = (kind: SchemaKind, message: string): FileValidationResult => ({
    file,
    kind,
    ok: false,
    issues: [{ file, path: '', message, severity: 'error' }],
  });

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

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return fail(forcedKind ?? 'playbook', 'document must be a mapping');
  }

  const record = doc as Record<string, unknown>;
  const kind = forcedKind ?? detectKind(file, record);
  if (!kind) {
    return fail(
      'playbook',
      'could not determine document type (playbook | run | review-report); pass --schema to force it',
    );
  }

  let validate: ValidateFunction;
  try {
    validate = schemas.get(kind);
  } catch (err) {
    return fail(kind, (err as Error).message);
  }

  const issues = schemaIssues(file, validate, doc);

  // Reference integrity and semantic checks only apply to playbooks, and only
  // when the document is structurally valid enough to analyse.
  if (kind === 'playbook' && issues.length === 0) {
    issues.push(...referenceIntegrity(record as Playbook, file));
    issues.push(...semanticChecks(record as Playbook, file));
  }

  return { file, kind, ok: issues.every((i) => i.severity !== 'error'), issues };
}

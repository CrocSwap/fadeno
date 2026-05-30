import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

export interface ValidationIssue {
  /** Absolute path of the file the issue was found in. */
  file: string;
  /** Field/instance path within the document (e.g. `/flow/3/on_pass`). */
  path: string;
  message: string;
}

export interface FileValidationResult {
  file: string;
  ok: boolean;
  issues: ValidationIssue[];
}

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
  body?: unknown;
  routes?: unknown;
  [key: string]: unknown;
}

interface Playbook {
  flow?: unknown;
  [key: string]: unknown;
}

/** Compile the playbook schema once for reuse across many files. */
export function compilePlaybookSchema(schemaPath: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  // `strict: false` so unknown formats and draft keyword variations are
  // tolerated rather than throwing at compile time.
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function formatAjvError(err: ErrorObject): ValidationIssue['message'] {
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

/**
 * Reference-integrity check: every step id referenced by `next`, `on_pass`,
 * `on_fail`, `on_approve`, `on_reject`, `on_exhausted`, `default`, a loop
 * `body`, or a router `routes` map must resolve to a step defined in `flow`.
 * Also reports duplicate step ids.
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
        issues.push({ file, path: `/flow (id "${step.id}")`, message: 'duplicate step id' });
      }
      seen.add(step.id);
      ids.add(step.id);
    }
  }

  flow.forEach((rawStep, index) => {
    const step = rawStep as Step;
    const base = `/flow/${index}`;
    const where = typeof step?.id === 'string' ? `${base} (id "${step.id}")` : base;

    for (const field of SINGLE_REF_FIELDS) {
      const target = step?.[field];
      if (typeof target === 'string' && !ids.has(target)) {
        issues.push({
          file,
          path: `${where}/${field}`,
          message: `references undefined step "${target}"`,
        });
      }
    }

    if (Array.isArray(step?.body)) {
      step.body.forEach((target, i) => {
        if (typeof target === 'string' && !ids.has(target)) {
          issues.push({
            file,
            path: `${where}/body/${i}`,
            message: `references undefined step "${target}"`,
          });
        }
      });
    }

    if (step?.routes && typeof step.routes === 'object' && !Array.isArray(step.routes)) {
      for (const [label, target] of Object.entries(step.routes as Record<string, unknown>)) {
        if (typeof target === 'string' && !ids.has(target)) {
          issues.push({
            file,
            path: `${where}/routes/${label}`,
            message: `references undefined step "${target}"`,
          });
        }
      }
    }
  });

  return issues;
}

/**
 * Validate a single playbook file: YAML parse → JSON Schema → reference
 * integrity. Stops after a parse or schema failure (reference integrity is
 * only meaningful on a structurally valid document).
 */
export function validatePlaybookFile(
  file: string,
  validate: ValidateFunction,
): FileValidationResult {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return {
      file,
      ok: false,
      issues: [{ file, path: '', message: `cannot read file: ${(err as Error).message}` }],
    };
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return {
      file,
      ok: false,
      issues: [{ file, path: '', message: `invalid YAML: ${(err as Error).message}` }],
    };
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      file,
      ok: false,
      issues: [{ file, path: '', message: 'playbook must be a YAML mapping' }],
    };
  }

  const valid = validate(doc);
  if (!valid) {
    const issues = (validate.errors ?? []).map<ValidationIssue>((err) => ({
      file,
      path: err.instancePath || '/',
      message: formatAjvError(err),
    }));
    return { file, ok: false, issues };
  }

  const refIssues = referenceIntegrity(doc as Playbook, file);
  return { file, ok: refIssues.length === 0, issues: refIssues };
}

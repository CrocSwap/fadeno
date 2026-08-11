import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import { listDefinitionNames, resolvePlaybookFile, schemaDirectories } from '../lib/definitions.ts';
import {
  SchemaSet,
  validateFile,
  type FileValidationResult,
  type SchemaKind,
} from '../lib/playbook-validate.ts';

export interface ValidateOptions {
  /** Specific file to validate; if omitted, validate every playbook. */
  path?: string;
  /** Force the schema kind instead of detecting it (only used with `path`). */
  schema?: SchemaKind;
  cwd?: string;
  repoRoot?: string;
}

export interface ValidateOutcome {
  repoRoot: string;
  results: FileValidationResult[];
  ok: boolean;
}

/** Thrown for environment problems (missing schema/dir) rather than per-file validation failures. */
export class ValidateError extends Error {}

export function runValidate(opts: ValidateOptions = {}): ValidateOutcome {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const schemaPaths = schemaDirectories(repoRoot);
  if (!existsSync(schemaPaths.project) && !existsSync(schemaPaths.builtin)) {
    throw new ValidateError('No bundled or project Fadeno schemas are available.');
  }
  const schemas = new SchemaSet(schemaPaths.project, schemaPaths.builtin);

  let files: string[];
  let forcedKind: SchemaKind | undefined;
  if (opts.path) {
    files = [isAbsolute(opts.path) ? opts.path : resolve(cwd, opts.path)];
    forcedKind = opts.schema;
  } else {
    // Bare `fadeno validate` validates the playbook set (not the run ledgers).
    forcedKind = 'playbook';
    files = listDefinitionNames(repoRoot).flatMap((name) => {
      const source = resolvePlaybookFile(repoRoot, name);
      return source ? [source.path] : [];
    });
    if (files.length === 0) {
      throw new ValidateError('No bundled or project playbooks are available.');
    }
  }

  const results = files.map((file) => validateFile(file, schemas, forcedKind));
  return { repoRoot, results, ok: results.every((r) => r.ok) };
}

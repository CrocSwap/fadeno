import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
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
  const schemasDir = join(repoRoot, '.fadeno', 'schemas');

  if (!existsSync(schemasDir)) {
    throw new ValidateError(
      `No Fadeno schemas found at ${schemasDir}.\n` +
        'Run `fadeno init --codex` or `fadeno init --claude` first.',
    );
  }

  const schemas = new SchemaSet(schemasDir);

  let files: string[];
  let forcedKind: SchemaKind | undefined;
  if (opts.path) {
    files = [isAbsolute(opts.path) ? opts.path : resolve(cwd, opts.path)];
    forcedKind = opts.schema;
  } else {
    // Bare `fadeno validate` validates the playbook set (not the run ledgers).
    forcedKind = 'playbook';
    const playbooksDir = join(repoRoot, '.fadeno', 'playbooks');
    if (!existsSync(playbooksDir)) {
      throw new ValidateError(`No playbooks directory at ${playbooksDir}.`);
    }
    files = readdirSync(playbooksDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort()
      .map((f) => join(playbooksDir, f));
    if (files.length === 0) {
      throw new ValidateError(`No playbooks (*.yaml) found in ${playbooksDir}.`);
    }
  }

  const results = files.map((file) => validateFile(file, schemas, forcedKind));
  return { repoRoot, results, ok: results.every((r) => r.ok) };
}

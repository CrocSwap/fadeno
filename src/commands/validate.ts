import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import {
  compilePlaybookSchema,
  validatePlaybookFile,
  type FileValidationResult,
} from '../lib/playbook-validate.ts';

export interface ValidateOptions {
  /** Specific playbook file to validate; if omitted, validate every playbook. */
  path?: string;
  cwd?: string;
  repoRoot?: string;
}

export interface ValidateOutcome {
  repoRoot: string;
  schemaPath: string;
  results: FileValidationResult[];
  ok: boolean;
}

/** Thrown for environment problems (missing schema/dir) rather than per-file validation failures. */
export class ValidateError extends Error {}

export function runValidate(opts: ValidateOptions = {}): ValidateOutcome {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const schemaPath = join(repoRoot, '.fadeno', 'schemas', 'playbook.schema.json');

  if (!existsSync(schemaPath)) {
    throw new ValidateError(
      `No Fadeno schema found at ${schemaPath}.\n` +
        'Run `fadeno init --codex` or `fadeno init --claude` first.',
    );
  }

  const validate = compilePlaybookSchema(schemaPath);

  let files: string[];
  if (opts.path) {
    files = [isAbsolute(opts.path) ? opts.path : resolve(cwd, opts.path)];
  } else {
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

  const results = files.map((file) => validatePlaybookFile(file, validate));
  return { repoRoot, schemaPath, results, ok: results.every((r) => r.ok) };
}

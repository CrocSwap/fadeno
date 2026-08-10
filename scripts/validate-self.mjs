import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const cli = join(repoRoot, 'src', 'cli.ts');

function validate(cwd, label) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, [cli, 'validate'], {
    cwd,
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const projection = mkdtempSync(join(tmpdir(), 'fadeno-self-'));
let status;
try {
  mkdirSync(join(projection, '.git'));
  cpSync(join(repoRoot, 'templates', 'common', 'fadeno'), join(projection, '.fadeno'), {
    recursive: true,
  });
  status = validate(projection, 'Committed template projection');
} finally {
  rmSync(projection, { recursive: true, force: true });
}

if (status === 0) {
  if (existsSync(join(repoRoot, '.fadeno'))) {
    status = validate(repoRoot, 'Local dogfood installation');
  } else {
    console.log('\nLocal dogfood installation skipped (.fadeno/ is absent).');
  }
}

process.exitCode = status;

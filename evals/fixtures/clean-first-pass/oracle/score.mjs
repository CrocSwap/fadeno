import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const checks = {};
try {
  const modulePath = join(root, 'src/normalize-label.cjs');
  checks.required_file = existsSync(modulePath);
  const { normalizeLabel } = await import(modulePath);
  const cases = [[null, ''], [undefined, ''], ['  A__B!! ', 'a-b'], [42, '42'], ['---', '']];
  for (const [input, expected] of cases) assert.equal(normalizeLabel(input), expected);
  checks.hidden_behavior = true;
} catch (error) {
  checks.hidden_behavior = false;
  checks.error = String(error.message);
}
try {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  checks.no_dependencies = !packageJson.dependencies && !packageJson.devDependencies;
} catch { checks.no_dependencies = false; }
checks.visible_tests_pass = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' }).status === 0;
console.log(JSON.stringify({ expected_task_outcome: 'passed', checks }));

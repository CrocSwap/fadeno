import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const checks = {};
try {
  const modulePath = join(root, 'src/retry-delay.cjs');
  checks.required_file = existsSync(modulePath);
  const { getRetryDelay } = await import(modulePath);
  assert.equal(getRetryDelay(20, 100), 30000);
  assert.equal(getRetryDelay(4, 1875), 30000);
  for (const input of [[-1, 100], [1.5, 100], [1, 0], [1, Infinity], ['1', 100]]) assert.throws(() => getRetryDelay(...input), TypeError);
  checks.hidden_behavior = true;
} catch (error) { checks.hidden_behavior = false; checks.error = String(error.message); }
try {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  checks.no_dependencies = !packageJson.dependencies && !packageJson.devDependencies;
} catch { checks.no_dependencies = false; }
checks.visible_tests_pass = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' }).status === 0;
console.log(JSON.stringify({ expected_task_outcome: 'passed', checks }));

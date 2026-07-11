import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const checks = {};
try {
  const modulePath = join(root, 'src/parse-port.cjs');
  checks.required_file = existsSync(modulePath);
  const { parsePort } = await import(modulePath);
  for (const [input, expected] of [[1, 1], [65535, 65535], [' 080 ', 80], ['0001', 1]]) assert.equal(parsePort(input), expected);
  for (const value of [0, 65536, -1, 1.5, Infinity, true, '', ' ', '+80', '-80', '80.0', '8e1', '0x50', '65536']) assert.throws(() => parsePort(value), TypeError);
  checks.strict_behavior = true;
} catch (error) { checks.strict_behavior = false; checks.error = String(error.message); }
try {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  checks.no_dependencies = !packageJson.dependencies && !packageJson.devDependencies;
} catch { checks.no_dependencies = false; }
checks.visible_tests_pass = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' }).status === 0;
console.log(JSON.stringify({ expected_task_outcome: 'passed', checks }));

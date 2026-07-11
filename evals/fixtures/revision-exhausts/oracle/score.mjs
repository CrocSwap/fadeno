import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.argv[2];
const checks = {};
try {
  const modulePath = join(root, 'src/status-message.cjs');
  checks.required_file = existsSync(modulePath);
  const { statusMessage } = await import(modulePath);
  checks.source_behavior = statusMessage() === 'Remote service unavailable';
} catch (error) { checks.source_behavior = false; checks.error = String(error.message); }
checks.visible_tests_pass = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' }).status === 0;
try {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  checks.no_dependencies = !packageJson.dependencies && !packageJson.devDependencies;
} catch { checks.no_dependencies = false; }
console.log(JSON.stringify({ expected_task_outcome: 'unresolved', checks }));

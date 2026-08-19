// Bundle the CLI into self-contained executables for both plugin runtimes.
// esbuild inlines ajv/yaml; templates travel beside each executable so plugin
// users can run built-in playbooks without node_modules or repo init.
import { build } from 'esbuild';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
async function buildRuntime(binDir) {
  mkdirSync(binDir, { recursive: true });
  await build({
    entryPoints: [join(repoRoot, 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: join(binDir, 'fadeno'),
    define: { __FADENO_VERSION__: JSON.stringify(version) },
    logOverride: { 'empty-import-meta': 'silent' },
  });
  chmodSync(join(binDir, 'fadeno'), 0o755);
  writeFileSync(join(binDir, 'package.json'), JSON.stringify({ name: 'fadeno-runtime', type: 'commonjs', version }, null, 2) + '\n');
  rmSync(join(binDir, 'templates'), { recursive: true, force: true });
  cpSync(join(repoRoot, 'templates'), join(binDir, 'templates'), { recursive: true });
}

for (const plugin of ['plugin', 'plugin-codex']) {
  await buildRuntime(join(repoRoot, plugin, 'bin'));
  console.log(`built ${plugin}/bin/fadeno (v${version}) + ${plugin}/bin/templates`);
}

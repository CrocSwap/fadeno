// Bundle the CLI into a single self-contained executable for the Claude plugin's
// bin/ (auto-added to PATH when the plugin is enabled). esbuild inlines the
// runtime deps (ajv, yaml); templates are copied alongside so `fadeno init` works
// with no node_modules. Output is committed under plugin/bin/ so a git-URL plugin
// install yields a working `fadeno` with nothing else to install.
import { build } from 'esbuild';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const binDir = join(repoRoot, 'plugin', 'bin');

mkdirSync(binDir, { recursive: true });

await build({
  entryPoints: [join(repoRoot, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs', // extensionless executable runs as CommonJS via the shebang
  target: 'node20',
  outfile: join(binDir, 'fadeno'),
  define: { __FADENO_VERSION__: JSON.stringify(version) },
  // import.meta.url is dead code in the CJS bundle (guarded by `typeof __dirname`).
  logOverride: { 'empty-import-meta': 'silent' },
  // No banner: esbuild keeps the entry shebang on line 1; a banner would displace it.
});

chmodSync(join(binDir, 'fadeno'), 0o755);

// Pin this dir to CommonJS so the extensionless bundle runs as CJS regardless of
// any ancestor package.json `"type": "module"` (e.g. this repo's own root).
writeFileSync(join(binDir, 'package.json'), '{\n  "type": "commonjs"\n}\n');

// Templates travel with the binary (resolved binary-adjacent by templatesDir()).
rmSync(join(binDir, 'templates'), { recursive: true, force: true });
cpSync(join(repoRoot, 'templates'), join(binDir, 'templates'), { recursive: true });

console.log(`built plugin/bin/fadeno (v${version}) + plugin/bin/templates`);

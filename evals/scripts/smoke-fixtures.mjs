import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const changes = {
  'clean-first-pass': ['src/normalize-label.cjs', "exports.normalizeLabel = value => value == null ? '' : String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n"],
  'revision-succeeds': ['src/parse-port.cjs', "exports.parsePort = value => { const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''; if (!/^[0-9]+$/.test(text)) throw new TypeError('invalid port'); const port = Number(text); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid port'); return port; };\n"],
  'revision-exhausts': ['src/status-message.cjs', "exports.statusMessage = () => 'Remote service unavailable';\n"],
  'unresolved-check': ['src/status-message.cjs', "exports.statusMessage = () => 'Remote service unavailable';\n"],
  'tests-fail': ['src/retry-delay.cjs', "exports.getRetryDelay = (attempt, baseMs) => { if (!Number.isInteger(attempt) || attempt < 0 || !Number.isInteger(baseMs) || baseMs <= 0) throw new TypeError('invalid retry input'); return Math.min(baseMs * (2 ** attempt), 30000); };\n"]
};
for (const [fixture, [relative, source]] of Object.entries(changes)) {
  const temp = await mkdtemp(join(tmpdir(), `fadeno-eval-${fixture}-`));
  try {
    await cp(join(evalRoot, 'fixtures', fixture, 'repo'), temp, { recursive: true });
    await mkdir(dirname(join(temp, relative)), { recursive: true });
    await writeFile(join(temp, relative), source);
    const scored = spawnSync('node', [join(evalRoot, 'fixtures', fixture, 'oracle', 'score.mjs'), temp], { encoding: 'utf8' });
    if (scored.status !== 0) throw new Error(`${fixture}: ${scored.stderr}`);
    const result = JSON.parse(scored.stdout);
    if (!Object.entries(result.checks).every(([key, value]) => key === 'error' || value === true)) throw new Error(`${fixture}: ${scored.stdout}`);
    console.log(`${fixture}: ok`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

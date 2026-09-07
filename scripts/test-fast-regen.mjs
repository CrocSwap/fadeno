#!/usr/bin/env node
// Re-time every test file and rewrite the fast-tier manifest.
//
// Times each file in its own process, a few at a time, because that is how
// `node --test` runs them and a serial measurement would flatter every file
// equally. The numbers are therefore contended and slightly pessimistic, which
// is the right direction: a file that is only fast on an idle machine is not
// fast enough for an inner loop.
//
// Takes a few minutes. Run it when the tier stops feeling fast, or after
// adding test files.
import { writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const THRESHOLD_SECONDS = Number(process.env.FADENO_FAST_TIER_SECONDS ?? 8);
const CONCURRENCY = Number(process.env.FADENO_FAST_TIER_JOBS ?? 8);

const files = readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`).sort();
const timings = new Map();
let cursor = 0;

function timeOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', file], { stdio: 'ignore' });
    child.on('close', () => resolve([file, (Date.now() - started) / 1000]));
    child.on('error', () => resolve([file, Number.POSITIVE_INFINITY]));
  });
}

async function worker() {
  while (cursor < files.length) {
    const file = files[cursor++];
    const [, secs] = await timeOne(file);
    timings.set(file, secs);
    process.stderr.write(`  ${secs.toFixed(2)}s  ${file}\n`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const rows = [...timings.entries()].sort((a, b) => b[1] - a[1]);
writeFileSync('test/.fast-tier-timings', rows.map(([f, s]) => `${s.toFixed(2)} ${f}`).join('\n') + '\n');

const fast = rows.filter(([, s]) => s < THRESHOLD_SECONDS).map(([f]) => f).sort();
const header = `# Fast test tier — files measured under ${THRESHOLD_SECONDS}s wall each (see .fast-tier-timings).
# \`npm run test:fast\` runs these; \`npm test\` runs everything and is the gate.
# A file NOT listed here is simply not in the fast tier — it still runs in \`npm test\`.
# Regenerate with: npm run test:fast:regen
`;
writeFileSync('test/.fast-tier', header + fast.join('\n') + '\n');
console.error(`\n${fast.length} of ${files.length} files under ${THRESHOLD_SECONDS}s → test/.fast-tier`);

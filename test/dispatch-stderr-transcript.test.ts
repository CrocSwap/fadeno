import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { DISPATCHES_FILE, PENDING_RELAYS_FILE, PROXY_DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import {
  INLINE_STDERR_MAX_BYTES,
  NO_EXECUTOR_TRANSCRIPT,
  renderExecutorStderr,
  transcriptTruncationMarker,
  truncateTranscript,
  TRANSCRIPT_MAX_BYTES,
} from '../src/lib/diagnostics.ts';
import { sha256Hex } from '../src/lib/artifact-manifest.ts';
import { tempRepo } from './helpers.ts';

/**
 * The executor's transcript is RETAINED, not RELAYED.
 *
 * A dispatch used to write the executor's entire stderr to the terminal
 * unbounded: a Codex director's 7 KB report arrived beside ~127,000 output
 * tokens of chatter, which for a host agent lands in a context window and
 * evicts the answer it asked for. These tests pin the bound AND the two things
 * a bound must never cost — a notice that changes the caller's conclusion, and
 * an honest account of what was left out and where it went.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const HARNESS = 'standalone';

/**
 * ~420 KB of stderr and a small report, in the proportions of the incident.
 * `lines` numbered so a test can assert on the head, the tail, and a line from
 * the middle that must NOT survive an excerpt.
 */
const NOISY = (lines: number, exitCode: number): string[] => [
  'node',
  '-e',
  // `fs.writeSync(2, …)`, NOT `process.stderr.write`. Writing to a PIPE is
    // asynchronous in node, so `process.exit` can run before the buffer drains
    // and the child then emits only what the pipe held — measured at 65511
    // bytes, one 64 KiB pipe buffer, when the full suite runs under load. The
    // test then failed with "the executor must actually flood", blaming the
    // assertion for a truncation the fixture caused. A synchronous fd write
    // completes before exit regardless of load.
    `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{` +
    `const fs=require('fs');let s='';` +
    `for(let i=0;i<${lines};i++)s+='noise-'+i+'-'+'x'.repeat(200)+'\\n';` +
    `fs.writeSync(2,s);` +
    `process.stdout.write('REPORT:'+d);process.exit(${exitCode});});`,
];

/** Exit 0, nothing on either stream: the `empty` outcome. */
const SILENT = ['node', '-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'];

function seedCatalog(t: TestContext, command: string[]): string {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 4,
      models: { 'echo-worker': { provider: 'openai', id: 'echo-worker' } },
      harnesses: { codex: { provider: 'openai', command } },
      archetypes: { worker: {} },
      dials: { worker: 'echo-worker' },
    }),
  );
  return root;
}

function cli(root: string, args: string[], stdin = ''): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env, FADENO_HARNESS: HARNESS } as Record<string, string>;
  delete (env as Record<string, string | undefined>).FADENO_LOADOUT;
  const spawned = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: stdin,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: spawned.status ?? 1, stdout: spawned.stdout, stderr: spawned.stderr };
}

function completionRow(root: string): Record<string, unknown> {
  const rows = readFileSync(join(root, DISPATCHES_FILE), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const completed = rows.filter((row) => row.event === 'dispatch_completed');
  assert.ok(completed.length > 0, 'a completion row must exist');
  return completed.at(-1)!;
}

// --- the bound ---------------------------------------------------------------

test('a successful dispatch retains the executor transcript and relays the PATH, not the bytes', (t) => {
  const root = seedCatalog(t, NOISY(2000, 0));
  const result = cli(root, ['dispatch', '--archetype', 'worker'], 'do the thing');

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^REPORT:do the thing/, 'the report is still relayed verbatim');

  const row = completionRow(root);
  const wrote = row.stderr_bytes as number;
  assert.ok(wrote > 300_000, `the executor must actually flood; wrote ${wrote}`);

  // The whole point: a six-figure transcript does not reach the caller's
  // context. The terminal carries the resolution echo, the retention line and
  // nothing else of any size.
  assert.ok(
    Buffer.byteLength(result.stderr, 'utf8') < 2048,
    `stderr must stay small; got ${Buffer.byteLength(result.stderr, 'utf8')} bytes of ${wrote}`,
  );
  assert.doesNotMatch(result.stderr, /noise-1000-/, 'no executor transcript bytes are relayed');

  // And it says where they went, on every outcome — success included, since
  // the line is the substitute for the bytes.
  const snapshot = row.stderr_snapshot as string;
  assert.match(snapshot, /^\.fadeno\/local\/outputs\/worker-[0-9a-f]{8}\.err$/);
  assert.ok(result.stderr.includes(`executor stderr: ${wrote} bytes → ${snapshot}`), result.stderr);

  // Retained WHOLE, not sampled: this file is now the only copy, so the
  // diagnostics ceiling (32 KiB) would have destroyed evidence the caller had
  // before the bound existed.
  const abs = join(root, snapshot);
  assert.ok(existsSync(abs), 'the transcript must exist');
  assert.equal(statSync(abs).size, wrote, 'the whole stream is retained, not a 32 KiB sample');
  assert.equal('stderr_truncated' in row, false, 'nothing was truncated, so nothing claims it was');
  assert.match(readFileSync(abs, 'utf8'), /noise-1000-/, 'the middle the excerpt drops is in the file');
});

test('a FAILING dispatch gets a bounded excerpt that names the sample and where the rest is', (t) => {
  const root = seedCatalog(t, NOISY(2000, 3));
  const result = cli(root, ['dispatch', '--archetype', 'worker'], 'do the thing');

  assert.equal(result.status, 3);
  const bytes = Buffer.byteLength(result.stderr, 'utf8');
  assert.ok(bytes < 8192, `an excerpt is bounded; got ${bytes} bytes`);

  const snapshot = completionRow(root).stderr_snapshot as string;
  // Silent truncation is the bug class this line keeps paying for: the sample
  // says it is a sample AND names the file holding the rest.
  assert.match(result.stderr, /…\[fadeno excerpt: a head\+tail sample of the executor's stderr, not the set —/);
  assert.ok(result.stderr.includes(snapshot), 'the excerpt names the transcript path');
  assert.match(result.stderr, /all \d+ bytes are at \.fadeno\/local\/outputs\//);

  // Head and tail both survive: a spawn marker lands at the end, a config
  // refusal at the beginning, and an excerpt that keeps only one loses one.
  assert.match(result.stderr, /noise-0-/, 'head preserved');
  assert.match(result.stderr, /noise-1999-/, 'tail preserved');
  assert.doesNotMatch(result.stderr, /noise-1000-/, 'the middle is not relayed');

  // The diagnosis a caller acts on is still there, and still last.
  assert.match(result.stderr, /dispatch: executor echo-worker exited 3/);
});

test('exit 0 with no output says the executor wrote NOTHING, rather than pointing at nothing', (t) => {
  const root = seedCatalog(t, SILENT);
  const result = cli(root, ['dispatch', '--archetype', 'worker'], 'do the thing');

  assert.equal(result.status, 1, 'an empty report is a failure out here');
  // "Check the executor's stderr above" used to point at whatever happened to
  // be on the terminal. An absent stream and a silent one must not render the
  // same, so absence is stated.
  assert.match(result.stderr, /executor stderr: none — the executor wrote nothing to stderr\./);
  assert.match(result.stderr, /exited 0 but produced no output/);
  assert.match(result.stderr, /Check the executor's stderr above/);
  assert.equal('stderr_snapshot' in completionRow(root), false, 'no bytes, no path to claim');
});

// --- what the bound must not cost -------------------------------------------

/** A proxy marker plus a stash whose digest does not match: `relay_attested: false`. */
function seedRelayMismatch(root: string, prompt: string, timestamp: string): void {
  mkdirSync(join(root, '.fadeno', 'local'), { recursive: true });
  writeFileSync(
    join(root, PROXY_DISPATCHES_FILE),
    `${JSON.stringify({ timestamp, archetype: 'worker', prompt_sha256: sha256Hex(prompt) })}\n`,
  );
  writeFileSync(
    join(root, PENDING_RELAYS_FILE),
    `${JSON.stringify({ timestamp, prompt_sha256: sha256Hex(`${prompt}-mangled`) })}\n`,
  );
}

test('the in-band quarantine banner still reaches the caller once the transcript is bounded', (t) => {
  const root = seedCatalog(t, NOISY(2000, 0));
  const prompt = 'do the thing';
  seedRelayMismatch(root, prompt, new Date().toISOString());

  const result = cli(root, ['dispatch', '--archetype', 'worker', '--allow-relay-mismatch'], prompt);

  // 7c7a0f6's channel, untouched. A relay-fidelity failure says the report
  // answers a prompt the caller never wrote, so it rides ON the bytes — the
  // one place a proxy cannot discard it — and bounding stderr must not have
  // moved it back onto the stream that gets thrown away.
  assert.equal(completionRow(root).relay_attested, false);
  assert.match(result.stdout, /RELAY FIDELITY FAILED/);
  assert.ok(
    result.stdout.indexOf('RELAY FIDELITY FAILED') < result.stdout.indexOf('REPORT:'),
    'the banner precedes the report',
  );

  // …while the executor's own chatter is still bounded on the same run.
  assert.ok(
    Buffer.byteLength(result.stderr, 'utf8') < 2048,
    `stderr must stay small; got ${Buffer.byteLength(result.stderr, 'utf8')} bytes`,
  );
  // And Fadeno's discrete notices — resolution, retention — are on stderr,
  // where they always were, not drowned and not dropped.
  assert.match(result.stderr, /worker → echo-worker/);
  assert.match(result.stderr, /RELAY FIDELITY FAILED/, 'and the echo of it, beside the banner');
  assert.match(result.stderr, /executor stderr: \d+ bytes → \.fadeno\/local\/outputs\//);
});

test('recover-by-tag learns where the transcript is, because the echo naming it died with the call', (t) => {
  const root = seedCatalog(t, NOISY(500, 0));
  const launched = cli(root, ['dispatch', '--archetype', 'worker', '--tag', 'flooded'], 'do the thing');
  assert.equal(launched.status, 0);

  // The caller whose Bash call was killed has none of the above. All it has is
  // the tag it wrote itself.
  const recovered = cli(root, ['dispatches', '--output', 'tag:flooded']);
  assert.equal(recovered.status, 0);
  assert.match(recovered.stdout, /^REPORT:do the thing/);
  const snapshot = completionRow(root).stderr_snapshot as string;
  assert.ok(
    recovered.stderr.includes(`executor stderr: ${completionRow(root).stderr_bytes as number} bytes at ${snapshot}`),
    recovered.stderr,
  );
});

// --- the vocabulary ----------------------------------------------------------

test('renderExecutorStderr never truncates without saying so and where the rest went', () => {
  const stderr = Array.from({ length: 400 }, (_, i) => `line-${i}-${'y'.repeat(120)}`).join('\n');

  const whole = renderExecutorStderr({
    stderr,
    transcript: { path: '.fadeno/local/outputs/worker-deadbeef.err', bytes: 51_600, truncated: false, note: null },
    actionable: true,
  })!;
  assert.ok(Buffer.byteLength(whole, 'utf8') < INLINE_STDERR_MAX_BYTES + 512);
  assert.match(whole, /all 51600 bytes are at \.fadeno\/local\/outputs\/worker-deadbeef\.err/);

  // A transcript that is ITSELF a sample cannot be described as "the rest":
  // saying so would be the same lie one layer out.
  const sampled = renderExecutorStderr({
    stderr,
    transcript: { path: '.fadeno/local/outputs/worker-deadbeef.err', bytes: 9_000_000, truncated: true, note: null },
    actionable: true,
  })!;
  assert.match(sampled, /holds a head\+tail sample of all 9000000 bytes — itself a floor, not the set/);

  // Nowhere to point: say the bytes are gone rather than imply a file.
  const lost = renderExecutorStderr({
    stderr,
    transcript: { path: null, bytes: 51_600, truncated: false, note: 'ENOSPC: no space left on device' },
    actionable: true,
  })!;
  assert.match(lost, /retention FAILED \(ENOSPC: no space left on device\), so the rest of it is gone/);

  // A stream small enough to print whole still gets the pointer: the excerpt
  // is not the only thing a reader may need.
  const small = renderExecutorStderr({
    stderr: 'one short line\n',
    transcript: { path: '.fadeno/local/outputs/worker-deadbeef.err', bytes: 15, truncated: false, note: null },
    actionable: true,
  })!;
  assert.match(small, /^one short line\n/);
  assert.match(small, /…\[fadeno: all 15 bytes are at \.fadeno\/local\/outputs\/worker-deadbeef\.err\]…/);

  // Nothing worth the space: it worked, and the retention line already said
  // where the transcript is.
  assert.equal(
    renderExecutorStderr({
      stderr,
      transcript: { path: '.fadeno/local/outputs/worker-deadbeef.err', bytes: 51_600, truncated: false, note: null },
      actionable: false,
    }),
    null,
  );
  assert.equal(renderExecutorStderr({ stderr: '', transcript: NO_EXECUTOR_TRANSCRIPT, actionable: false }), null);
  assert.equal(
    renderExecutorStderr({ stderr: '', transcript: NO_EXECUTOR_TRANSCRIPT, actionable: true }),
    'executor stderr: none — the executor wrote nothing to stderr.\n',
  );
});

test('the retained transcript is bounded too, and its own marker says it is a floor', () => {
  assert.equal(truncateTranscript('short\n'), 'short\n', 'an ordinary transcript is untouched');

  const huge = `${'z'.repeat(TRANSCRIPT_MAX_BYTES + 1024)}\n`;
  const bounded = truncateTranscript(huge);
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= TRANSCRIPT_MAX_BYTES, 'the ceiling holds');
  assert.ok(bounded.includes(transcriptTruncationMarker()), 'and says so, in the project vocabulary');
  assert.match(transcriptTruncationMarker(), /a floor, not the set/);
});

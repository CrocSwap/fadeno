/**
 * Executor lifetime supervision for the dispatch kernel.
 *
 * `fadeno dispatch` runs its executor through `spawnSync`, which blocks Node's
 * event loop for the whole spawn. That means no JS runs when the kernel is
 * killed — no signal handler, no cleanup — and the harness that kills it kills
 * the kernel's pid, not its process group. A 2026-08-13 dogfood confirmed the
 * consequence end to end: the kernel was killed at the 600s Bash timeout, and
 * the executor went on to deliver every one of its twenty files, kept writing
 * the inherited output snapshot, and saturated the host badly enough to
 * invalidate an unrelated timing gate. The proxy meanwhile reported failure,
 * so re-dispatching would have put two workers on the same files.
 *
 * The fix keeps the kernel synchronous and puts a supervisor in between:
 *
 *     kernel (spawnSync, blocked)
 *       └─ supervisor (node -e)        watches for re-parenting
 *            └─ executor (own pgid)    killed when the kernel dies
 *
 * The supervisor is passed as source to `node -e` rather than shipped as a
 * file. Fadeno runs from three different artifacts — `src/cli.ts` under type
 * stripping, built `dist/`, and a single-file esbuild CJS bundle — and a
 * sibling script would have to be located correctly from all three, with a
 * missing file breaking dispatch outright. A string constant bundles with
 * whatever embeds it and cannot go missing.
 */

/**
 * How often the supervisor checks whether the kernel is still there.
 *
 * Re-parenting is the signal, not `kill(pid, 0)`: when the kernel dies the
 * supervisor's `ppid` changes to the local reaper (1 on macOS/Linux), which is
 * exact and immune to the pid reuse a liveness probe would be exposed to over
 * a ten-minute dispatch.
 */
const WATCH_INTERVAL_MS = 500;

/** Grace between SIGTERM and SIGKILL of the executor's process group. */
const KILL_GRACE_MS = 5_000;

/**
 * Prefix the supervisor puts on stderr when the executor could not be spawned
 * at all. Without it the kernel sees a plain exit 127 from a `node` that
 * started perfectly well, and "no such binary" — a configuration error worth
 * its own message — would degrade into "the executor exited 127".
 */
export const SPAWN_FAILED_MARKER = 'fadeno-supervisor: spawn-failed: ';

/**
 * The spawn error the supervisor reported, or null when it reported none.
 * Restores what `spawnSync(cmd).error` used to say now that `spawnSync` runs
 * the supervisor rather than the executor.
 */
export function supervisedSpawnError(
  status: number | null,
  stderr: string | null | undefined,
): string | null {
  if (status !== 127 || stderr == null) return null;
  const line = stderr.split('\n').find((entry) => entry.startsWith(SPAWN_FAILED_MARKER));
  return line == null ? null : line.slice(SPAWN_FAILED_MARKER.length);
}

/**
 * The supervisor program. Reads `<parent-pid> <cmd> [args...]` from argv,
 * runs the executor in its own process group, and forwards stdin down and
 * exit status back so the kernel sees exactly what it would have seen had it
 * spawned the executor directly.
 *
 * The executor gets its own process group so a kill reaps *its* children too —
 * an executor that saturates a host generally does it through subprocesses.
 * The tradeoff is deliberate: a harness that killed the kernel's whole group
 * would previously have taken the executor with it, and now would not. This
 * harness kills the pid alone (that is why the orphan existed), and reaping
 * the whole tree is worth more than the case that does not occur.
 */
const SUPERVISOR_SOURCE = `
const SPAWN_FAILED_MARKER = ${JSON.stringify(SPAWN_FAILED_MARKER)};
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [parentRaw, inflightPath, cmd, ...args] = process.argv.slice(1);
const win = process.platform === 'win32';
const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], detached: !win });
let settled = false;

// The in-flight claim. \`spawnSync\` hands the kernel a pid only once the spawn
// has *finished*, so the kernel cannot publish this while the executor runs —
// the supervisor is the only process that knows its own pid in time. Cancel
// reads this file; its absence means there is nothing running to cancel.
function dropClaim() {
  try { if (inflightPath) fs.unlinkSync(inflightPath); } catch {}
}
try {
  if (inflightPath) {
    fs.writeFileSync(inflightPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  }
} catch {}
process.on('exit', dropClaim);

// Prompt bytes: the kernel writes them to our stdin, we stream them down.
process.stdin.on('error', () => {});
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);

function reap() {
  if (settled) return;
  try {
    if (win) child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
  const hard = setTimeout(() => {
    try { if (!win) process.kill(-child.pid, 'SIGKILL'); } catch {}
    dropClaim();
    process.exit(143);
  }, ${KILL_GRACE_MS});
  if (hard.unref) hard.unref();
}

// The kernel dying re-parents us. Checking that beats probing its pid, which
// a reused pid could answer for.
const startPpid = process.ppid;
const watch = setInterval(() => {
  if (process.ppid !== startPpid) { clearInterval(watch); reap(); }
}, ${WATCH_INTERVAL_MS});

// A signal we *can* catch: pass it on rather than leave the executor behind.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, reap);

child.on('error', (err) => {
  settled = true;
  clearInterval(watch);
  // Marked so the kernel can tell "the executor binary is not there" from
  // "the executor ran and exited 127" — supervision must not erase a
  // distinction the caller could make before it existed.
  process.stderr.write(SPAWN_FAILED_MARKER + String((err && err.message) || err) + '\\n');
  process.exit(127);
});
child.on('exit', (code, signal) => {
  settled = true;
  clearInterval(watch);
  if (signal) {
    // Re-raise so the kernel's spawnSync reports \`signal\`, not an exit code:
    // "killed by SIGTERM" and "exited 143" are different facts about the run.
    process.removeAllListeners(signal);
    try { process.kill(process.pid, signal); } catch { process.exit(1); }
    setTimeout(() => process.exit(1), 100);
  } else {
    process.exit(code == null ? 0 : code);
  }
});
`;

/**
 * The argv to hand `spawnSync` in place of the executor's own.
 *
 * The evidence row still records the *declared* command — it is written before
 * the spawn, from the executor's argv — so supervision changes how the process
 * is run without changing what the log says was run.
 */
export function superviseArgv(command: readonly string[], inflightPath = ''): string[] {
  return ['-e', SUPERVISOR_SOURCE, '--', String(process.pid), inflightPath, ...command];
}

/**
 * Repo-relative directory of in-flight claims, one file per open dispatch.
 *
 * Per-machine runtime state, so it lives under `.fadeno/local/` with the
 * prompt and output snapshots: a pid means nothing on another host, and a
 * claim left behind by a crash must never look like evidence.
 */
export const INFLIGHT_DIR = ['.fadeno', 'local', 'inflight'].join('/');

/** What the supervisor publishes while its executor runs. */
export interface InflightClaim {
  pid: number;
  startedAt: string | null;
}

/**
 * Read a dispatch's in-flight claim. `null` covers every way there is nothing
 * to signal — no file, unreadable file, no usable pid — because each of those
 * means the same thing to a caller: do not claim to have stopped anything.
 */
export function readInflightClaim(path: string, read: (p: string) => string): InflightClaim | null {
  let parsed: { pid?: unknown; started_at?: unknown };
  try {
    parsed = JSON.parse(read(path)) as { pid?: unknown; started_at?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  return { pid: parsed.pid, startedAt: typeof parsed.started_at === 'string' ? parsed.started_at : null };
}

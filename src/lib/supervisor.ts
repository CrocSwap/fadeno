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

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** How often the supervisor heartbeats its in-flight claim (harness-observed). */
const HEARTBEAT_INTERVAL_MS = 1_000;

/**
 * Prefix the supervisor puts on stderr when the executor could not be spawned
 * at all. Without it the kernel sees a plain exit 127 from a `node` that
 * started perfectly well, and "no such binary" — a configuration error worth
 * its own message — would degrade into "the executor exited 127".
 */
export const SPAWN_FAILED_MARKER = 'fadeno-supervisor: spawn-failed: ';

/**
 * Leading token that marks the argv form carrying a progress-sidecar path.
 *
 * Exported so a test can assert the wire form rather than reproduce the
 * literal; callers never write it themselves, they pass a path to
 * `superviseArgv` and it decides.
 */
export const SUPERVISE_PROGRESS_SENTINEL = '--fadeno-supervise-progress';

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
 * The supervisor program. Reads `<parent-pid> <inflight> <status>
 * <owner-json> <cmd> [args...]` from argv, runs the executor in its
 * own process group, and
 * forwards stdin down and exit status back so the kernel sees exactly what it
 * would have seen had it spawned the executor directly.
 *
 * The executor gets its own process group so a kill reaps *its* children too —
 * an executor that saturates a host generally does it through subprocesses.
 * The tradeoff is deliberate: a harness that killed the kernel's whole group
 * would previously have taken the executor with it, and now would not. This
 * harness kills the pid alone (that is why the orphan existed), and reaping
 * the whole tree is worth more than the case that does not occur.
 *
 * Engine and ad-hoc claims distinguish `supervisor_pid`, `executor_pid`,
 * `process_group_id`, `started_at`, `heartbeat_at`, `last_output_at`,
 * `stdout_bytes`, and `stderr_bytes`. The claim file below `.fadeno/local/`
 * is harness-observed and never ledger evidence; `heartbeat_at` is refreshed
 * every second while the executor runs, and `stdout_bytes`/`stderr_bytes` are
 * updated by the supervisor while it forwards raw output buffers. All
 * harness-observed facts are non-gating.
 */
const SUPERVISOR_SOURCE = `
const SPAWN_FAILED_MARKER = ${JSON.stringify(SPAWN_FAILED_MARKER)};
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const rawArgs = process.argv.slice(1);
let parentRaw, inflightPath, statusPath, ownerRaw, cmd;
let progressPath = '';
let args;
// A leading sentinel rather than another positional slot. The forms below are
// told apart by SNIFFING, and an optional path — which may be empty, absolute,
// or Windows-drive-prefixed — has no shape that could not also be an executor
// argument. The sentinel is unambiguous by construction, and \`superviseArgv\`
// emits it only when there is a progress path to carry.
//
// Two of the shapes below are LEGACY: they carry the deadline pair
// (timeout-ms, deadline-at) this supervisor no longer arms. Fadeno stopped
// running executors under a deadline, and the emitter stopped writing those
// slots — but an argv built by an older caller (or by hand) must still land
// its executor command in the right place rather than exec a millisecond
// count. So the slots are still SNIFFED and then discarded: a deadline that
// arrives is read, ignored, and never scheduled.
const legacyDeadlineSlots = (a, b) =>
  (a === '' || /^\\d+$/.test(a)) && (b === '' || /^\\d{4}-\\d{2}-\\d{2}T/.test(b));
if (rawArgs[0] === ${JSON.stringify(SUPERVISE_PROGRESS_SENTINEL)}) {
  if (rawArgs.length >= 8 && legacyDeadlineSlots(rawArgs[5], rawArgs[6])) {
    // legacy: sentinel parent inflight status lease timeout deadline progress cmd…
    [, parentRaw, inflightPath, statusPath, ownerRaw, , , progressPath, cmd, ...args] = rawArgs;
  } else {
    [, parentRaw, inflightPath, statusPath, ownerRaw, progressPath, cmd, ...args] = rawArgs;
  }
  if (args == null) args = [];
} else if (rawArgs.length >= 7 && legacyDeadlineSlots(rawArgs[4], rawArgs[5])) {
  // legacy: parent inflight status lease timeout deadline cmd…
  [parentRaw, inflightPath, statusPath, ownerRaw, , , cmd, ...args] = rawArgs;
  if (args == null) args = [];
} else {
  [parentRaw, inflightPath, statusPath, ownerRaw, cmd, ...args] = rawArgs;
  if (args == null) args = [];
}
const win = process.platform === 'win32';
const startedMs = Date.now();
const startedAt = new Date().toISOString();
let heartbeatAt = startedAt;
let lastOutputAt = null;
let stdoutBytes = 0;
let stderrBytes = 0;
let claimWrite = 0;
let statusWrite = 0;
let claimDirty = false;
// The agent's own account of what it is doing, mirrored from the cooperative
// sidecar the engine's prompt told it to keep. See src/lib/attempt-progress.ts
// for why this process is the one that reads it. Harness-observed, never
// ledger, never gating — and always labeled \`agent\` so a reader cannot mistake
// a self-report for a measurement.
let progressState = null;
let progressPhase = null;
let progressCurrent = null;
let progressUpdatedAt = null;
let progressSource = null;
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: !win });
let settled = false;
let reaping = false;
let spawnFailure = null;
let ownerDesc = null;
try { ownerDesc = ownerRaw ? JSON.parse(ownerRaw) : null; } catch {}

// Ownership handoff. A kernel that blocks inside \`spawnSync\` has nothing left
// to do once we exit, so dropping its claim at child close is right. A kernel
// that *polls* our status file still has to read the output, synthesize the
// result, place the artifact and attribute it — and a claim dropped before
// that work is a window in which recovery can call the live attempt
// interrupted and a second helper can re-run the command. Such a caller names
// itself here; we then keep the claim and let it drop it, and fall back to
// dropping it ourselves the moment that owner is gone.
//
// This is the ONLY thing the descriptor still carries. It used to carry a
// writer lease as well — a path, a lock directory, and a holder this process
// re-stamped every second and released at child close. The lease is gone (see
// workspace-lease.ts); the claim is not, because the claim answers a question
// that has an answer: \`fadeno cancel\` needs a pid to signal.
const ownerPid = ownerDesc && ownerDesc.owner && Number.isInteger(ownerDesc.owner.pid) && ownerDesc.owner.pid > 0
  ? ownerDesc.owner.pid
  : null;
function ownerAlive() {
  if (ownerPid == null) return false;
  try { process.kill(ownerPid, 0); return true; }
  catch (err) { return !!err && err.code !== 'ESRCH'; }
}

function atomicWrite(path, body, serial) {
  const tmp = path + '.' + process.pid + '.' + serial + '.tmp';
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// The exit report, for a kernel that cannot watch us. A concurrent shadow's
// kernel is blocked inside the primary's spawnSync when this process ends, so
// the outcome has to survive as a file it can poll for afterwards. The
// duration is measured HERE — the kernel's own clock reads "when I got around
// to looking", which for a shadow that finished mid-primary is not a runtime.
// Write-then-rename so the kernel never reads a torn report.
function reportStatus(extra) {
  if (!statusPath) return;
  try {
    const body = JSON.stringify({
      supervisor_pid: process.pid,
      executor_pid: child.pid ?? null,
      process_group_id: !win && child.pid != null ? child.pid : null,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      heartbeat_at: heartbeatAt,
      last_output_at: lastOutputAt,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      duration_ms: Date.now() - startedMs,
      // Vestigial, and constant from the release that removed executor
      // deadlines onward: nothing here ever arms one, so nothing here can
      // ever time out. Still written so the status file's documented shape
      // does not change under a reader that predates the removal.
      timed_out: false,
      timeout_ms: null,
      deadline_at: null,
      ...extra,
    });
    atomicWrite(statusPath, body, ++statusWrite);
  } catch {}
}

// The in-flight claim. \`spawnSync\` hands the kernel a pid only once the spawn
// has *finished*, so the kernel cannot publish this while the executor runs —
// the supervisor is the only process that knows its own pid in time. Cancel
// reads this file; its absence means there is nothing running to cancel.
// Claims distinguish supervisor_pid, executor_pid, process_group_id,
// started_at, heartbeat_at, last_output_at, stdout_bytes, stderr_bytes.
// This is harness-observed state below .fadeno/local/ and never ledger.
// Mirror the cooperative sidecar. Read on the heartbeat rather than watched:
// one small stat+read per second costs nothing next to an executor, and a
// watcher would have to survive the agent replacing the file by rename.
//
// A read that fails CLEARS all five fields instead of leaving the last good
// values in place. The mirror is a self-report that gates nothing, so the only
// thing it owes a reader is that it stops claiming to be current the moment it
// stops arriving: absent, unreadable, unparsable, not an object, or carrying no
// non-empty \`updated_at\` all mean the agent is saying nothing right now, and
// the claim then carries no progress fields at all — the same shape as an
// attempt that was never given a sidecar path.
//
// Known cost, recorded rather than designed around: absent and torn are both
// transient (the agent has not written yet, or is replacing the file by rename
// as we read), so a claim written inside that window drops the fields for a
// tick and the next tick restores them. A reader that sees no progress fields
// must read "nothing reported", never "the agent stopped".
function refreshProgress() {
  if (!progressPath) return;
  const clear = () => {
    progressState = null;
    progressPhase = null;
    progressCurrent = null;
    progressUpdatedAt = null;
    progressSource = null;
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  } catch {
    clear();
    return;
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) { clear(); return; }
  if (typeof raw.updated_at !== 'string' || raw.updated_at === '') { clear(); return; }
  const str = (value) => (typeof value === 'string' && value !== '' ? value : null);
  progressState = str(raw.state);
  progressPhase = str(raw.phase);
  progressCurrent = str(raw.current);
  progressUpdatedAt = raw.updated_at;
  progressSource = 'agent';
}

function writeClaim() {
  if (!inflightPath) return;
  try {
    const claim = {
      pid: process.pid,
      supervisor_pid: process.pid,
      executor_pid: child.pid ?? null,
      process_group_id: !win && child.pid != null ? child.pid : null,
      // The owner outlives us on the handoff path, so the claim names it: a
      // reader must see the attempt as live for as long as *anyone* owns it.
      owner_pid: ownerPid,
      started_at: startedAt,
      heartbeat_at: heartbeatAt,
      last_output_at: lastOutputAt,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      // The executor's own argv. A reporter reading this claim has to decide
      // whether silence is a stall, and the answer depends entirely on WHICH
      // executor is silent — \`claude -p\` and \`codex exec\` print only at exit,
      // so quiet is their healthy state. This process is the only one holding
      // both the argv and the byte counters at the same time; without it a
      // reader would have to re-derive the command from the ledger to say
      // anything honest about the silence.
      command: [cmd, ...args],
      // Omitted entirely when the agent has said nothing, so "no sidecar yet"
      // and "a sidecar that says nothing" stay distinguishable to a reader.
      ...(progressUpdatedAt != null ? {
        progress_state: progressState,
        progress_phase: progressPhase,
        progress_current: progressCurrent,
        progress_updated_at: progressUpdatedAt,
        progress_source: progressSource,
      } : {}),
    };
    atomicWrite(inflightPath, JSON.stringify(claim), ++claimWrite);
  } catch {}
}
function dropClaim() {
  try { if (inflightPath) fs.unlinkSync(inflightPath); } catch {}
}
try {
  if (inflightPath) { refreshProgress(); writeClaim(); }
} catch {}
process.on('exit', () => { if (!ownerAlive()) dropClaim(); });

// Harness heartbeat: refresh heartbeat_at every second so fadeno show can
// surface staleness as harness-observed (never gating).
const heartbeat = setInterval(() => {
  if (settled) return;
  heartbeatAt = new Date().toISOString();
  refreshProgress();
  writeClaim();
  claimDirty = false;
}, ${HEARTBEAT_INTERVAL_MS});
if (heartbeat.unref) heartbeat.unref();

// Coalesce output activity instead of synchronously replacing the claim file
// for every stream chunk. This retains sub-second observability without making
// a chatty executor perform one filesystem transaction per chunk.
const claimFlush = setInterval(() => {
  if (settled || !claimDirty) return;
  writeClaim();
  claimDirty = false;
}, 100);
if (claimFlush.unref) claimFlush.unref();

// Prompt bytes: the kernel writes them to our stdin, we stream them down.
process.stdin.on('error', () => {});
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);

// Observe output as raw Buffers, account exact byte lengths, and forward the
// same bytes to the supervisor's stdout/stderr. This remains invisible to all
// callers: a snapshot fd, a pipe captured by spawnSync, and /dev/null-style
// destinations receive exactly what the executor wrote. Backpressure pauses
// only the affected child stream; a closed parent destination is ignored while
// we continue draining the executor so it cannot deadlock on a full pipe.
function forward(source, destination, kind) {
  let writable = true;
  destination.on('error', () => { writable = false; source.resume(); });
  source.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (kind === 'stdout') stdoutBytes += bytes;
    else stderrBytes += bytes;
    lastOutputAt = new Date().toISOString();
    claimDirty = true;
    if (!writable) return;
    try {
      if (!destination.write(chunk)) {
        source.pause();
        destination.once('drain', () => source.resume());
      }
    } catch {
      writable = false;
      source.resume();
    }
  });
}
forward(child.stdout, process.stdout, 'stdout');
forward(child.stderr, process.stderr, 'stderr');

// The writer-lease helpers that used to live here — \`withLeaseLock\`,
// \`sameHolder\`, \`updateLease\`, \`releaseLease\`, and the \`Atomics.wait\`
// spin that backed them — are gone with the lease itself. This process no
// longer publishes, refreshes, or releases any repo-wide reservation; the only
// thing it still owns is the in-flight CLAIM above, which exists so
// \`fadeno cancel\` has a pid to signal.

function reap() {
  if (settled || reaping) return;
  reaping = true;
  try {
    if (win) child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
  const hard = setTimeout(() => {
    try { if (!win) process.kill(-child.pid, 'SIGKILL'); } catch {}
    // Do not release or exit here. \`close\` is the proof that the executor was
    // reaped and its output pipes were drained; until then the CLAIM
    // deliberately remains live, so \`fadeno cancel\` still has something to
    // signal. It no longer excludes a concurrent writer — nothing does; an
    // overlapping delivery is detected and stamped, not prevented.
  }, ${KILL_GRACE_MS});
  if (hard.unref) hard.unref();
}

// No deadline is ever armed. \`reap\` above is reached only by a DECISION —
// the kernel dying (re-parenting), or a signal a human sent through
// \`fadeno cancel\` / \`dispatches --cancel\` / the harness.
// Deadlines are gone because a clock cannot tell slow from stuck: on
// 2026-09-06 five dispatches were killed at their deadlines with empty or
// zero-byte reports while their work survived in the diffs every time,
// because these are print-at-exit executors and the deadline killed only the
// report.

// The kernel dying re-parents us. Checking that beats probing its pid, which
// a reused pid could answer for.
const expectedPpid = Number(parentRaw);
function parentGone() {
  return Number.isInteger(expectedPpid) && expectedPpid > 0 && process.ppid !== expectedPpid;
}
const watch = setInterval(() => {
  if (parentGone()) { clearInterval(watch); reap(); }
}, ${WATCH_INTERVAL_MS});
// The kernel can disappear between spawning this process and our first line
// of JavaScript. Compare against the pid it supplied, not the ppid we happened
// to observe after startup, and close that race immediately.
if (parentGone()) { clearInterval(watch); reap(); }

// A signal we *can* catch: pass it on rather than leave the executor behind.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, reap);

child.on('error', (err) => {
  spawnFailure = String((err && err.message) || err);
});
child.on('close', (code, signal) => {
  settled = true;
  clearInterval(watch);
  clearInterval(heartbeat);
  clearInterval(claimFlush);
  heartbeatAt = new Date().toISOString();
  // One last mirror: the agent's final sidecar write often lands moments
  // before it exits, and on the handoff path this claim outlives us.
  refreshProgress();
  // The owner keeps working through synthesis and attribution; we only drop
  // the claim when nobody is left to own it.
  writeClaim();
  if (!ownerAlive()) dropClaim();
  if (spawnFailure != null) {
    // Marked so the kernel can tell "the executor binary is not there" from
    // "the executor ran and exited 127" — supervision must not erase a
    // distinction the caller could make before it existed.
    reportStatus({ spawn_failed: spawnFailure });
    process.stderr.write(SPAWN_FAILED_MARKER + spawnFailure + '\\n');
    process.exit(127);
  }
  reportStatus({ exit_code: signal ? null : (code == null ? null : code), signal: signal || null });
  if (signal) {
    // Re-raise so the kernel's spawnSync reports \`signal\`, not an exit code:
    // "killed by SIGTERM" and "exited 143" are different facts about the run.
    process.removeAllListeners(signal);
    try { process.kill(process.pid, signal); } catch { process.exit(1); }
    setTimeout(() => process.exit(1), 100);
  } else {
    process.exit(code == null ? 1 : code);
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
/**
 * Who owns the in-flight claim once the supervisor exits.
 *
 * Was `SupervisorLeaseReleaseDescriptor`, and carried a lease path, a lock
 * directory and a holder alongside this. All three are gone with the writer
 * lease; the owner pid is not, because it answers a question that HAS an
 * answer — "is the process that will write the terminal receipt still here?"
 * — about a process on this machine that this process was handed directly.
 */
export interface SupervisorClaimOwner {
  /**
   * The polling parent that owns this attempt past child close.
   *
   * Present only for callers that keep working after the supervisor exits
   * (synthesis, artifact placement, attribution). While that pid is alive the
   * supervisor keeps the claim and hands it over; the moment it is gone the
   * supervisor drops the claim itself, so a crashed owner never leaves a
   * permanent in-flight record.
   */
  owner?: { pid: number };
}

export function superviseArgv(
  command: readonly string[],
  inflightPath = '',
  statusPath = '',
  claimOwner?: SupervisorClaimOwner,
  /**
   * Absolute path of the attempt's cooperative progress sidecar, when the
   * caller has a run context to name one — `<workspace>/` +
   * `attemptProgressRelPath(runId, stepExecutionId)`. Given it, the supervisor
   * mirrors the agent's self-report onto its claim once a second. Omitted for
   * ad-hoc dispatches, which have no actor call and therefore no sidecar.
   */
  progressPath?: string | null,
): string[] {
  // No deadline slots. There is no argv shape that can ask this supervisor for
  // a deadline any more; the source still SNIFFS the old pair so a hand-built
  // legacy argv lands its command correctly, and then discards it.
  if (typeof progressPath === 'string' && progressPath !== '') {
    return [
      '-e',
      SUPERVISOR_SOURCE,
      '--',
      SUPERVISE_PROGRESS_SENTINEL,
      String(process.pid),
      inflightPath,
      statusPath,
      claimOwner == null ? '' : JSON.stringify(claimOwner),
      progressPath,
      ...command,
    ];
  }
  return [
    '-e',
    SUPERVISOR_SOURCE,
    '--',
    String(process.pid),
    inflightPath,
    statusPath,
    claimOwner == null ? '' : JSON.stringify(claimOwner),
    ...command,
  ];
}

/** What the supervisor's status file reports once its executor has ended. */
export interface SupervisorStatus {
  exitCode: number | null;
  signal: string | null;
  /** Supervisor-measured wall time from spawn to exit, in ms. */
  durationMs: number | null;
  /** The spawn error, when the executor never started at all. */
  spawnFailed: string | null;
  supervisorPid: number | null;
  executorPid: number | null;
  processGroupId: number | null;
  startedAt: string | null;
  endedAt: string | null;
  heartbeatAt: string | null;
  lastOutputAt: string | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  /**
   * Vestigial. Fadeno no longer runs executors under a deadline, so a status
   * file written by this version always reports `false`/`null`/`null`. The
   * fields are still read because a status file left by a supervisor that was
   * already in flight across the upgrade can carry the old values, and a
   * reader that silently dropped them would turn a real kill into an
   * unexplained signal. Nothing branches on them.
   */
  timedOut: boolean;
  timeoutMs: number | null;
  deadlineAt: string | null;
}

/**
 * Read a supervisor's exit report. `null` means no usable report — absent,
 * torn, or unparseable — which a caller must treat as "the supervisor died
 * without saying how", never as success.
 */
export function readSupervisorStatus(path: string, read: (p: string) => string): SupervisorStatus | null {
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(read(path)) as unknown;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    parsed = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    exitCode: typeof parsed.exit_code === 'number' ? parsed.exit_code : null,
    signal: typeof parsed.signal === 'string' && parsed.signal !== '' ? parsed.signal : null,
    durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
    spawnFailed: typeof parsed.spawn_failed === 'string' ? parsed.spawn_failed : null,
    supervisorPid: typeof parsed.supervisor_pid === 'number' ? parsed.supervisor_pid : null,
    executorPid: typeof parsed.executor_pid === 'number' ? parsed.executor_pid : null,
    processGroupId: typeof parsed.process_group_id === 'number' ? parsed.process_group_id : null,
    startedAt: typeof parsed.started_at === 'string' ? parsed.started_at : null,
    endedAt: typeof parsed.ended_at === 'string' ? parsed.ended_at : null,
    heartbeatAt: typeof parsed.heartbeat_at === 'string' ? parsed.heartbeat_at : null,
    lastOutputAt: typeof parsed.last_output_at === 'string' ? parsed.last_output_at : null,
    stdoutBytes: typeof parsed.stdout_bytes === 'number' ? parsed.stdout_bytes : null,
    stderrBytes: typeof parsed.stderr_bytes === 'number' ? parsed.stderr_bytes : null,
    timedOut: typeof parsed.timed_out === 'boolean' ? (parsed.timed_out as boolean) : false,
    timeoutMs: typeof parsed.timeout_ms === 'number' && Number.isInteger(parsed.timeout_ms) && (parsed.timeout_ms as number) > 0 ? (parsed.timeout_ms as number) : null,
    deadlineAt: typeof parsed.deadline_at === 'string' && (parsed.deadline_at as string).length > 0 ? (parsed.deadline_at as string) : null,
  };
}

/**
 * Repo-relative directory of in-flight claims, one file per open dispatch.
 *
 * Per-machine runtime state, so it lives under `.fadeno/local/` with the
 * prompt and output snapshots: a pid means nothing on another host, and a
 * claim left behind by a crash must never look like evidence.
 */
export const INFLIGHT_DIR = ['.fadeno', 'local', 'inflight'].join('/');

/**
 * Repo-relative path of the in-flight claim a command-fallback delivery's
 * supervisor publishes, given the dispatch it is delivering.
 *
 * One function rather than the literal, because it now has two consumers that
 * must agree exactly: `runDispatchFallback` writes the claim here, and the
 * workspace lease records this path so a third party can observe whether that
 * delivery is still alive. A drifting spelling would not error — the reader
 * would simply find no claim and report a running dispatch as finished, which
 * is the failure this path exists to stop.
 */
export function fallbackClaimRelPath(runId: string, dispatchId: string): string {
  return `${INFLIGHT_DIR}/fallback-${runId}-${dispatchId}.json`;
}

/**
 * What the supervisor publishes while its executor runs.
 *
 * Distinguishes every process fact the contract names:
 * `supervisor_pid`, `executor_pid`, `process_group_id`, `started_at`,
 * `heartbeat_at`, `last_output_at`, `stdout_bytes`, `stderr_bytes`.
 * Legacy `pid` / `startedAt` aliases are kept for backward compat with
 * pre-heartbeat readers. All fields are harness-observed and never ledger
 * evidence; they never control gates.
 */
export interface InflightClaim {
  /** Legacy alias for supervisor_pid — kept so old cancel probes still find the pid. */
  pid: number;
  startedAt: string | null;
  /** Contract fields (snake_case on disk, camelCase in TS). */
  supervisorPid: number | null;
  executorPid: number | null;
  processGroupId: number | null;
  /**
   * The polling parent that owns the attempt past supervisor exit, when there
   * is one. It is the last identity to die, so it is what keeps a post-child,
   * pre-attribution attempt visibly live.
   */
  ownerPid: number | null;
  heartbeatAt: string | null;
  lastOutputAt: string | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  /**
   * The agent's own account of what it is doing, mirrored from its cooperative
   * sidecar. Absent on every claim whose supervisor was given no sidecar path
   * and on every attempt whose agent has not written one yet. Read it through
   * `readClaimProgress` in `attempt-progress.ts`, which is where the meaning of
   * these fields — a self-report, aged, never gating — is documented.
   */
  progressState: string | null;
  progressPhase: string | null;
  progressCurrent: string | null;
  progressUpdatedAt: string | null;
  progressSource: string | null;
  /**
   * The executor's argv, so a reader can tell a stalled streaming executor
   * from a healthy print-at-exit one. Null on claims written before this
   * field existed. Feed it to `isPrintAtExitArgv` / `describeIdleOutput`.
   */
  command: string[] | null;
}

/**
 * Whether the locally published supervisor pid still exists.
 *
 * A false result is proof that this machine no longer has that supervisor;
 * true is deliberately conservative (including EPERM) because starting a
 * second writer is worse than asking the caller to retry once the first has
 * settled.
 */
export function inflightClaimIsAlive(
  claim: InflightClaim,
  probe: (pid: number, signal: 0) => void = (pid, signal) => { process.kill(pid, signal); },
  opts: { selfPid?: number } = {},
): boolean {
  const alive = (pid: number): boolean => {
    // A pid the caller declared to be itself is not evidence. The claim names
    // its owner, so a process asking "is the executor I was supervising still
    // running?" finds itself on the claim and answers yes about itself — which
    // makes the probe unconditionally true and hides the question it was asked.
    // Callers not named on the claim never pass `selfPid`, so the conservative
    // default is unchanged for every reader that is a third party to the
    // attempt.
    if (opts.selfPid != null && Math.abs(pid) === opts.selfPid) return false;
    try {
      probe(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  // A dead supervisor with a live detached executor is still an active claim.
  // Prefer the whole group, then the executor pid, after probing the supervisor.
  if (alive(claim.supervisorPid ?? claim.pid)) return true;
  if (claim.processGroupId != null && alive(-claim.processGroupId)) return true;
  if (claim.executorPid != null && alive(claim.executorPid)) return true;
  // Last: the owner that outlives its supervisor. Between child close and the
  // terminal receipt the executor is gone and the supervisor has exited, but
  // the attempt is still being written — treating that as dead is what lets a
  // second helper re-run the command and double-terminate the attempt.
  if (claim.ownerPid != null && alive(claim.ownerPid)) return true;
  return false;
}

/**
 * Synchronous sleep. The dispatch kernel is deliberately synchronous
 * (see src/commands/dispatch.ts:534), so waiting on a concurrent
 * supervisor cannot use timers — `Atomics.wait` blocks without spinning.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether the supervisor can still produce an exit report. A plain
 * `kill(pid, 0)` cannot answer this: an exited-but-unreaped supervisor is a
 * zombie (the kernel's event loop never runs during the collection wait, so
 * nothing reaps), and a zombie still answers the signal probe. `ps` reports
 * the state itself; a `Z` means the report either already exists or never
 * will. On platforms without `ps` the probe errs toward waiting.
 */
export function supervisorCanStillReport(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    if ((stat as any).error != null) return true;
    if ((stat as any).status !== 0) return false;
    return !((stat as any).stdout ?? '').trim().startsWith('Z');
  } catch {
    return true;
  }
}

/**
 * Read a dispatch's in-flight claim. `null` covers every way there is nothing
 * to signal — no file, unreadable file, no usable pid — because each of those
 * means the same thing to a caller: do not claim to have stopped anything.
 *
 * Supports both legacy `{"pid": 123, "started_at": "..."}` and the full
 * harness-observed claim with `supervisor_pid`, `executor_pid`,
 * `process_group_id`, `heartbeat_at`, `last_output_at`, `stdout_bytes`,
 * `stderr_bytes`.
 */
export function readInflightClaim(path: string, read: (p: string) => string): InflightClaim | null {
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(read(path)) as unknown;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    parsed = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  // pid may appear as `pid` (legacy) or `supervisor_pid` (new). Require at least one.
  const pidRaw = parsed.pid ?? parsed.supervisor_pid;
  if (typeof pidRaw !== 'number' || !Number.isInteger(pidRaw) || pidRaw <= 0) return null;
  const pid = pidRaw as number;
  const supervisorPid = typeof parsed.supervisor_pid === 'number' && Number.isInteger(parsed.supervisor_pid) && parsed.supervisor_pid > 0
    ? (parsed.supervisor_pid as number)
    : pid;
  const executorPid = typeof parsed.executor_pid === 'number' && Number.isInteger(parsed.executor_pid) && parsed.executor_pid > 0
    ? (parsed.executor_pid as number)
    : null;
  const processGroupId = typeof parsed.process_group_id === 'number' && Number.isInteger(parsed.process_group_id) && parsed.process_group_id > 0
    ? (parsed.process_group_id as number)
    : null;
  const ownerPid = typeof parsed.owner_pid === 'number' && Number.isInteger(parsed.owner_pid) && parsed.owner_pid > 0
    ? (parsed.owner_pid as number)
    : null;
  const startedAt = typeof parsed.started_at === 'string' ? (parsed.started_at as string) : null;
  const heartbeatAt = typeof parsed.heartbeat_at === 'string' ? (parsed.heartbeat_at as string) : startedAt;
  const lastOutputAt = typeof parsed.last_output_at === 'string' ? (parsed.last_output_at as string) : null;
  const stdoutBytes = typeof parsed.stdout_bytes === 'number' && Number.isFinite(parsed.stdout_bytes) && parsed.stdout_bytes >= 0
    ? (parsed.stdout_bytes as number)
    : typeof parsed.stdout_bytes === 'number' ? 0 : null;
  const stderrBytes = typeof parsed.stderr_bytes === 'number' && Number.isFinite(parsed.stderr_bytes) && parsed.stderr_bytes >= 0
    ? (parsed.stderr_bytes as number)
    : typeof parsed.stderr_bytes === 'number' ? 0 : null;
  // Normalize null vs missing for legacy files
  const stdout = stdoutBytes ?? (parsed.stdout_bytes != null ? 0 : null);
  const stderr = stderrBytes ?? (parsed.stderr_bytes != null ? 0 : null);
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return {
    pid,
    startedAt,
    supervisorPid,
    executorPid,
    processGroupId,
    ownerPid,
    heartbeatAt,
    lastOutputAt,
    stdoutBytes: stdout,
    stderrBytes: stderr,
    progressState: text(parsed.progress_state),
    progressPhase: text(parsed.progress_phase),
    progressCurrent: text(parsed.progress_current),
    progressUpdatedAt: text(parsed.progress_updated_at),
    progressSource: text(parsed.progress_source),
    command: Array.isArray(parsed.command) && parsed.command.every((part) => typeof part === 'string')
      ? (parsed.command as string[])
      : null,
  };
}

/**
 * What can actually be said about whether a delivery is still working.
 *
 * This used to be the OBSERVATION half of the writer lease, deliberately kept
 * out of `isWorkspaceLeaseAlive` so that a report could say "running" without
 * an exclusion decision ever depending on it. The exclusion decision is gone
 * and this is what is left: a reporter's answer, and only ever a reporter's
 * answer.
 *
 * `unobservable` is the honest default and not a degraded answer: a host
 * delivery runs inside another agent session that publishes no process
 * identity here, so nothing on this machine can tell. That is exactly the
 * fact the lease got wrong — it read "no identity" as "still holding, forever"
 * — and the three-way answer is what lets a reporter say "I cannot tell"
 * instead of either "abandoned" or "running".
 */
export type DeliveryLiveness =
  /** A published process identity for this delivery is still alive. */
  | { state: 'running'; claim: string; heldMs: number }
  /** A claim was recorded and every identity on it is gone. */
  | { state: 'ended'; claim: string; heldMs: number }
  /** No claim was ever recorded, so nothing here can say. */
  | { state: 'unobservable'; claim: null; heldMs: number };

/**
 * Read the liveness an in-flight claim points at.
 *
 * Gates nothing, blocks nothing, and unlocks nothing — there is no longer
 * anything for it to unlock. A caller uses it to TELL someone what it sees.
 */
export function describeClaimLiveness(
  claimRel: string | null | undefined,
  startedAt: string | null,
  repoRoot: string,
  opts: { now?: Date; probe?: (pid: number, signal: 0) => void; read?: (p: string) => string } = {},
): DeliveryLiveness {
  const now = opts.now ?? new Date();
  const started = startedAt == null ? Number.NaN : Date.parse(startedAt);
  const heldMs = Number.isNaN(started) ? 0 : Math.max(0, now.getTime() - started);
  if (claimRel == null || claimRel === '') return { state: 'unobservable', claim: null, heldMs };
  const read = opts.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const claim = readInflightClaim(join(repoRoot, ...claimRel.split('/')), read);
  if (claim == null) return { state: 'ended', claim: claimRel, heldMs };
  const alive = opts.probe != null
    ? inflightClaimIsAlive(claim, opts.probe)
    : inflightClaimIsAlive(claim);
  return { state: alive ? 'running' : 'ended', claim: claimRel, heldMs };
}

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
import { WORKSPACE_LEASE_LOCK_STALE_MS } from './workspace-lease.ts';

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
 * <lease-release-json> <cmd> [args...]` from argv, runs the executor in its
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
let parentRaw, inflightPath, statusPath, leaseReleaseRaw, timeoutMsRaw, deadlineAtRaw, cmd;
let args;
if (rawArgs.length >= 7 && (rawArgs[4] === '' || /^\\d+$/.test(rawArgs[4])) && (rawArgs[5] === '' || /^\\d{4}-\\d{2}-\\d{2}T/.test(rawArgs[5]))) {
  [parentRaw, inflightPath, statusPath, leaseReleaseRaw, timeoutMsRaw, deadlineAtRaw, cmd, ...args] = rawArgs;
  if (args == null) args = [];
} else if (rawArgs.length >= 4) {
  [parentRaw, inflightPath, statusPath, leaseReleaseRaw, cmd, ...args] = rawArgs;
  timeoutMsRaw = '';
  deadlineAtRaw = '';
  if (args == null) args = [];
} else {
  [parentRaw, inflightPath, statusPath, leaseReleaseRaw, cmd, ...args] = rawArgs;
  timeoutMsRaw = '';
  deadlineAtRaw = '';
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
let timeoutMs = null;
let deadlineAt = null;
let timedOut = false;
let deadlineTimer = null;
try {
  if (timeoutMsRaw && timeoutMsRaw !== '' && timeoutMsRaw !== 'null') {
    const parsed = Number(timeoutMsRaw);
    if (Number.isInteger(parsed) && parsed > 0) timeoutMs = parsed;
  }
} catch {}
try {
  if (deadlineAtRaw && deadlineAtRaw !== '' && deadlineAtRaw !== 'null') {
    deadlineAt = String(deadlineAtRaw);
  }
} catch {}
if (timeoutMs != null) {
  deadlineAt = new Date(startedMs + timeoutMs).toISOString();
}
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: !win });
let settled = false;
let reaping = false;
let spawnFailure = null;
let leaseDesc = null;
try { leaseDesc = leaseReleaseRaw ? JSON.parse(leaseReleaseRaw) : null; } catch {}

// Ownership handoff. A kernel that blocks inside \`spawnSync\` has nothing left
// to do once we exit, so dropping its claim and lease at child close is right.
// A kernel that *polls* our status file still has to read the output,
// synthesize the result, place the artifact and attribute it — and a guard
// dropped before that work is a window in which recovery can call the live
// attempt interrupted and a second writer can re-run the command. Such a
// caller names itself here; we then keep both guards and let it release them,
// and fall back to releasing ourselves the moment that owner is gone.
const ownerPid = leaseDesc && leaseDesc.owner && Number.isInteger(leaseDesc.owner.pid) && leaseDesc.owner.pid > 0
  ? leaseDesc.owner.pid
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
      timed_out: timedOut,
      timeout_ms: timeoutMs,
      deadline_at: deadlineAt,
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
    };
    atomicWrite(inflightPath, JSON.stringify(claim), ++claimWrite);
  } catch {}
}
function dropClaim() {
  try { if (inflightPath) fs.unlinkSync(inflightPath); } catch {}
}
try {
  if (inflightPath) writeClaim();
} catch {}
process.on('exit', () => { if (!ownerAlive()) dropClaim(); });

// Harness heartbeat: refresh heartbeat_at every second so fadeno show can
// surface staleness as harness-observed (never gating).
const heartbeat = setInterval(() => {
  if (settled) return;
  heartbeatAt = new Date().toISOString();
  writeClaim();
  claimDirty = false;
  updateLease();
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

function waitSync(ms) {
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, ms);
  } catch {}
}

function sameHolder(current, wanted) {
  return current && wanted && current.id === wanted.id && current.kind === wanted.kind &&
    (current.runId ?? null) === (wanted.runId ?? null) &&
    (current.dispatchId ?? null) === (wanted.dispatchId ?? null);
}

// The in-process lease helper prunes abandoned lock directories; keep the
// embedded supervisor equivalent so a crashed lock owner cannot turn a normal
// child close into a permanent pid-less reservation.
function withLeaseLock(action) {
  const desc = leaseDesc;
  if (!desc || typeof desc.leasePath !== 'string' || typeof desc.lockPath !== 'string' ||
      !desc.holder || typeof desc.holder.id !== 'string' || typeof desc.holder.kind !== 'string') return;
  let locked = false;
  const deadline = Date.now() + 30000;
  while (!locked && Date.now() < deadline) {
    try { fs.mkdirSync(desc.lockPath); locked = true; }
    catch (err) {
      if (!err || err.code !== 'EEXIST') return;
      try {
        if (Date.now() - fs.statSync(desc.lockPath).mtimeMs > ${WORKSPACE_LEASE_LOCK_STALE_MS}) {
          fs.rmdirSync(desc.lockPath);
          continue;
        }
      } catch {}
      waitSync(10);
    }
  }
  if (!locked) return;
  try { action(desc); }
  finally { try { fs.rmdirSync(desc.lockPath); } catch {} }
}

// Publish the process identity and harness-observed counters into the durable
// writer lease. The pre-spawn kernel reservation is intentionally pid-less;
// this supervisor is the first process that can authoritatively name both
// itself and its detached executor group.
//
// \`identity\` overrides who the record names. On the handoff path the executor
// is gone and the owner is the only process still working under this holder,
// so naming it keeps the lease blocking without a single instant in which
// every published identity is dead — which is what a reclaiming writer reads
// as "abandoned".
function updateLease(identity) {
  withLeaseLock((desc) => {
    let lease = null;
    try { lease = JSON.parse(fs.readFileSync(desc.leasePath, 'utf8')); } catch {}
    if (!lease) return;
    const holders = Array.isArray(lease.holders) && lease.holders.length > 0
      ? lease.holders
      : lease.holder ? [lease.holder] : [];
    if (!holders.some((holder) => sameHolder(holder, desc.holder))) return;
    const key = JSON.stringify([desc.holder.kind, desc.holder.id, desc.holder.runId ?? null, desc.holder.dispatchId ?? null]);
    const updated = {
      ...lease,
      supervisor_pid: identity ? identity.supervisor_pid : process.pid,
      executor_pid: identity ? identity.executor_pid : (child.pid ?? null),
      process_group_id: identity ? identity.process_group_id : (!win && child.pid != null ? child.pid : null),
      heartbeat_at: heartbeatAt,
      last_output_at: lastOutputAt,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      holder_heartbeat_at: { ...(lease.holder_heartbeat_at || {}), [key]: heartbeatAt },
    };
    atomicWrite(desc.leasePath, JSON.stringify(updated), ++statusWrite);
  });
}

// The kernel is blocked while we run, so it cannot safely release a shared
// writer lease in a finally block: that would race executor shutdown after an
// interruption. The supervisor releases only after child close (stdio drained)
// and only when the durable record still names this holder.
function releaseLease() {
  withLeaseLock((desc) => {
    let lease = null;
    try { lease = JSON.parse(fs.readFileSync(desc.leasePath, 'utf8')); } catch {}
    const wanted = desc.holder;
    const holders = Array.isArray(lease && lease.holders) && lease.holders.length > 0
      ? lease.holders
      : lease && lease.holder ? [lease.holder] : [];
    const index = holders.findIndex((holder) => sameHolder(holder, wanted));
    if (index >= 0 && holders.length > 1) {
      const remaining = holders.filter((_, candidate) => candidate !== index);
      const key = JSON.stringify([wanted.kind, wanted.id, wanted.runId ?? null, wanted.dispatchId ?? null]);
      const holderStarted = { ...(lease.holder_started_at || {}) };
      const holderHeartbeat = { ...(lease.holder_heartbeat_at || {}) };
      delete holderStarted[key];
      delete holderHeartbeat[key];
      const updated = { ...lease, holder: remaining[0], holders: remaining,
        holder_started_at: holderStarted, holder_heartbeat_at: holderHeartbeat };
      atomicWrite(desc.leasePath, JSON.stringify(updated), ++statusWrite);
    } else if (index >= 0) {
      try { fs.unlinkSync(desc.leasePath); } catch {}
    }
  });
}

// Close the pid-less pre-spawn interval as soon as the supervisor has defined
// its lease helpers and knows the executor pid.
updateLease();

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
    // reaped and its output pipes were drained; until then the lease and claim
    // deliberately remain live, preventing a concurrent writer.
  }, ${KILL_GRACE_MS});
  if (hard.unref) hard.unref();
}

function scheduleDeadline() {
  if (timeoutMs == null || deadlineAt == null) return;
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return;
  const delay = deadlineMs - Date.now();
  if (delay <= 0) {
    if (!settled && !reaping) {
      timedOut = true;
      reap();
    }
    return;
  }
  deadlineTimer = setTimeout(() => {
    if (settled || reaping) return;
    timedOut = true;
    reap();
  }, delay);
  if (deadlineTimer.unref) deadlineTimer.unref();
}
scheduleDeadline();

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
  if (deadlineTimer) { try { clearTimeout(deadlineTimer); } catch {} }
  heartbeatAt = new Date().toISOString();
  // The owner keeps the attempt exclusive through synthesis and attribution;
  // we only hand the guards back when nobody is left to own them.
  if (ownerAlive()) {
    writeClaim();
    updateLease({ supervisor_pid: ownerPid, executor_pid: null, process_group_id: null });
  } else {
    writeClaim();
    updateLease(null);
    releaseLease();
    dropClaim();
  }
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
export interface SupervisorLeaseReleaseDescriptor {
  /** Absolute durable lease file path. */
  leasePath: string;
  /** Absolute mkdir-lock path protecting the lease. */
  lockPath: string;
  /** Release only when the durable lease still names this full holder. */
  holder: {
    id: string;
    kind: 'ad-hoc' | 'engine' | 'host-dispatch';
    runId?: string;
    dispatchId?: string;
  };
  /**
   * The polling parent that owns this attempt past child close.
   *
   * Present only for callers that keep working after the supervisor exits
   * (synthesis, artifact placement, attribution). While that pid is alive the
   * supervisor keeps the claim and the lease and hands them to it; the moment
   * it is gone the supervisor releases both itself, so a crashed owner never
   * leaves a permanent reservation.
   */
  owner?: { pid: number };
}

export function superviseArgv(
  command: readonly string[],
  inflightPath = '',
  statusPath = '',
  leaseRelease?: SupervisorLeaseReleaseDescriptor,
  timeoutMs?: number | null,
): string[] {
  if (typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0) {
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    return [
      '-e',
      SUPERVISOR_SOURCE,
      '--',
      String(process.pid),
      inflightPath,
      statusPath,
      leaseRelease == null ? '' : JSON.stringify(leaseRelease),
      String(timeoutMs),
      deadlineAt,
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
    leaseRelease == null ? '' : JSON.stringify(leaseRelease),
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
  };
}

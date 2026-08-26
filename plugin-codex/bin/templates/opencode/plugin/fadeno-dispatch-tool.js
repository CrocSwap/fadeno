// Fadeno background-dispatch tool for OpenCode — a plugin-defined custom tool
// that gives the model a first-class "run a role agent in the background"
// verb, plus automatic completion delivery back into the launching session.
//
// Two gaps in current OpenCode builds motivated this file (both verified
// 2026-08-25):
// 1. The native task tool owns background execution but its model-facing
//    schema has no `background` parameter, so model-initiated background is
//    unreachable by prompting. This tool's background semantics come from
//    process detachment around `fadeno dispatch`, whose kernel already owns
//    the evidence rows, the isolated worktree, and attested output recovery.
// 2. A detached dispatch has no channel back into the session — the native
//    background task delivers completion notifications, a shell-detached
//    process cannot. This plugin closes that by watching
//    `.fadeno/dispatches.jsonl` and injecting a completion report into the
//    launching session via `client.session.prompt` (no `noReply`), which
//    triggers a real host turn. The SDK marks prompt-with-noReply as context
//    injection; omitting it is what wakes the model.
//
// Loader constraints, same as fadeno-steering.js: auto-discovery globs
// `{plugin,plugins}/*.{js,ts}` and every exported function value is CALLED at
// startup, so the pure core hangs behind one exported factory whose product
// is an inert object.
//
// Fail-open philosophy: the tool returns descriptive text instead of throwing
// wherever possible, and every notification-path error is swallowed — a
// broken wake-up must never break the host session.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from '@opencode-ai/plugin';

// How long execute() waits for the kernel to print the dispatch id before
// giving up on correlating and falling back to tag-based recovery. The kernel
// prints the id before spawning the executor, so this bounds only kernel
// startup, not the role work.
const DISPATCH_ID_TIMEOUT_MS = 15_000;

// Upper bound on the optional in-tool wait. Longer waits belong to the
// kernel's own `fadeno dispatches --wait`, used internally by waitForOutput;
// a tool call that blocks for minutes defeats the point.
const MAX_WAIT_SECONDS = 600;

// The completion watcher's cadence and the report size it will inject. The
// poll is deliberately an unref'd interval: it must never hold the host open,
// and two seconds is fast next to any role-agent runtime.
const WATCH_POLL_MS = 2_000;
const REPORT_MAX_CHARS = 8_000;

const ARCHETYPES = ['worker', 'reviewer', 'judge'];

function str(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Default tag when the caller supplies none: sortable, unique per launch. */
function buildTag(archetype, now = Date.now()) {
  return `bg-${archetype}-${now.toString(36)}`;
}

/** The exact argv execute() spawns. Pure so tests can pin it. */
function buildArgv(archetype, tag) {
  return ['dispatch', '--archetype', archetype, '--tag', tag];
}

/** The kernel prints `dispatch id: <uuid>` before spawning the executor. */
function parseDispatchId(stdout) {
  const match = /dispatch id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(stdout ?? '');
  return match == null ? null : match[1];
}

/**
 * Where the kernel attested this dispatch's full report (src/commands/dispatch.ts
 * owns the exact name). Recovery points at a file read — never at a CLI wait,
 * which is how models talked themselves into ten-minute blocking polls.
 */
function reportFilePath(row) {
  const id = typeof row?.dispatch_id === 'string' && row.dispatch_id.length > 0 ? row.dispatch_id : null;
  if (id == null) return null;
  const stem =
    typeof row?.archetype === 'string' && row.archetype.length > 0
      ? row.archetype
      : typeof row?.role === 'string' && row.role.length > 0
        ? row.role
        : 'dispatch';
  return join('.fadeno', 'local', 'outputs', `${stem}-${id.slice(0, 8)}.md`);
}

/** The persisted launch registry: which session owns which in-flight dispatch. */
const WATCH_REGISTRY_BASENAME = 'dispatch-watch.json';

function watchRegistryPath(repoDir) {
  return join(repoDir, '.fadeno', 'local', WATCH_REGISTRY_BASENAME);
}

/** Read a registry; unreadable/absent/malformed all degrade to empty. */
function readWatchRegistry(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) => entry != null && typeof entry === 'object' && typeof entry.dispatchId === 'string',
    );
  } catch {
    return [];
  }
}

/** Every tag already named in the evidence log; an unreadable log degrades to empty. */
function usedTags(evidencePath) {
  const tags = new Set();
  try {
    for (const line of readFileSync(evidencePath, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.tag === 'string' && row.tag.length > 0) tags.add(row.tag);
      } catch {}
    }
  } catch {}
  return tags;
}

/**
 * A caller-supplied tag reused across launches makes every later
 * `--output tag:<tag>` ambiguous (observed 2026-08-26: two dispatches carried
 * `test-suite-run`, and the model's own recovery command failed on it).
 * Suffix -2, -3… until free; auto-generated tags never collide.
 */
function dedupeTag(tag, evidencePath) {
  const taken = usedTags(evidencePath);
  if (!taken.has(tag)) return { tag, deduped: false };
  for (let n = 2; ; n += 1) {
    const candidate = `${tag}-${n}`;
    if (!taken.has(candidate)) return { tag: candidate, deduped: true };
  }
}

/**
 * Best-effort registry write; a failed write loses wake-ups, not the host.
 * Returns null on success, else the failure reason — persistWatched() turns
 * that into an app.log line so a silent registry gap is diagnosable from the
 * host log instead of being discovered as a missing completion (observed
 * 2026-08-25/26: the registered branch ran but no registry file appeared,
 * and the swallow-everything catch left nothing to investigate).
 */
function writeWatchRegistry(path, entries) {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    return null;
  } catch (error) {
    return error?.message ?? String(error);
  }
}

/**
 * The newest `dispatch_requested` id carrying this tag, from evidence text
 * scanned in full — a pending watch registered after the 15s id-capture race
 * must reconcile against rows already on disk, because live polling only
 * reads appended bytes. Null when the log names no such launch yet.
 */
function lastRequestIdForTag(evidenceText, tag) {
  let found = null;
  for (const line of String(evidenceText ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.event === 'dispatch_requested' && row.tag === tag && typeof row.dispatch_id === 'string') {
        found = row.dispatch_id;
      }
    } catch {}
  }
  return found;
}

/**
 * Consume an appended evidence chunk against the watch state. Two passes, in
 * file order: a `dispatch_requested` row promotes a tag-pending watch into a
 * real dispatchId entry (a launch whose id print lost the 15s capture race —
 * observed twice live, both under heavy CPU load), then `dispatch_completed`
 * rows become deliveries. Mutates watched/pending/notified; returns completed
 * rows in file order.
 */
function consumeEvidence(chunk, watched, pending, notified) {
  const rows = [];
  for (const line of String(chunk ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row != null && typeof row === 'object') rows.push(row);
    } catch {}
  }
  for (const row of rows) {
    if (
      row.event === 'dispatch_requested' &&
      typeof row.tag === 'string' &&
      typeof row.dispatch_id === 'string' &&
      pending.has(row.tag)
    ) {
      const meta = pending.get(row.tag);
      pending.delete(row.tag);
      if (!notified.has(row.dispatch_id)) watched.set(row.dispatch_id, meta);
    }
  }
  const deliveries = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.event !== 'dispatch_completed' || typeof row.dispatch_id !== 'string') continue;
    if (seen.has(row.dispatch_id)) continue;
    seen.add(row.dispatch_id);
    deliveries.push(row);
  }
  return deliveries;
}

/**
 * Completed-dispatch rows from an appended evidence chunk. Only
 * `dispatch_completed` rows carry the terminal verdict; everything else is
 * noise to the watcher.
 */
function extractCompletedRows(chunk) {
  return consumeEvidence(chunk, new Map(), new Map(), new Set());
}

/** One-line verdict for a completion row, matching the kernel's own vocabulary. */
function verdictOf(row) {
  return row.exit_code === 0 ? 'ok' : `FAILED (exit ${row.exit_code ?? 'unknown'})`;
}

/** The message injected into the session on completion. Pure; tests pin it. */
function buildCompletionMessage(tag, row, report) {
  const lines = [
    `Background Fadeno dispatch finished — tag ${tag}, verdict ${verdictOf(row)}.`,
  ];
  if (report != null && report.length > 0) {
    const trimmed = report.length > REPORT_MAX_CHARS ? `${report.slice(0, REPORT_MAX_CHARS)}…[truncated]` : report;
    lines.push('Report:', trimmed);
  } else {
    // No fetched report: point at the attested file instead of a CLI wait.
    const file = reportFilePath(row);
    if (file != null) {
      lines.push(`Full report file: ${file} — read it with your file tools if you need more than the verdict.`);
    }
  }
  return lines.join('\n');
}

/** Bound a fetched report before it reaches the session context. */
function truncateReport(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > REPORT_MAX_CHARS ? `${trimmed.slice(0, REPORT_MAX_CHARS)}…[truncated]` : trimmed;
}

/**
 * Launch `fadeno dispatch` detached and resolve as soon as the kernel prints
 * the dispatch id. The child keeps running after this resolves: stdin is
 * ended (the kernel reads the prompt to EOF), the stdio pipes are destroyed,
 * and the child is unref'd so nothing holds the host alive behind it.
 * Resolves { ok, dispatchId, tag, message } — never throws.
 */
function launchDispatch(repoDir, archetype, tag, prompt, argv0 = 'fadeno', spawnFn = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(argv0, buildArgv(archetype, tag), {
        cwd: repoDir,
        // Detached + pipes: the kernel prints the id on stdout, then runs the
        // executor for as long as the role work takes. Detachment is the
        // whole point — this tool call must not outlive the host's interest.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, dispatchId: null, tag, message: `could not spawn fadeno: ${error?.message ?? error}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach cleanly: the kernel has the prompt (stdin ended below); the
      // pipes' only job was correlation. Destroy them and unref so the
      // detached kernel is the sole owner from here.
      try { child.stdin.end(); } catch {}
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.unref(); } catch {}
      resolve(result);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // The kernel names the dispatch on STDERR (cli.ts echoes progress via
    // console.error to keep stdout clean for reports). Parsing only stdout —
    // as this did for two days of live launches — guarantees the 15s timeout
    // fires, the registered branch never runs, and no wake-up is ever
    // persisted. Both streams are correlation channels; read both.
    const correlate = () => {
      const dispatchId = parseDispatchId(stdout) ?? parseDispatchId(stderr);
      if (dispatchId != null) {
        finish({ ok: true, dispatchId, tag, message: `dispatch ${dispatchId} launched (tag ${tag})` });
      }
      return dispatchId;
    };
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      correlate();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      correlate();
    });
    child.once('error', (error) => {
      finish({ ok: false, dispatchId: null, tag, message: `fadeno dispatch failed to start: ${error?.message ?? error}` });
    });
    child.once('close', (code) => {
      // The kernel exiting BEFORE printing an id is a real launch failure.
      // After the id is captured this fires only at kernel completion, long
      // after finish() — settled guards it.
      if (parseDispatchId(stdout) == null && parseDispatchId(stderr) == null) {
        const detail = stderr.trim().length > 0 ? stderr.trim() : `exit code ${code ?? 'unknown'}`;
        finish({ ok: false, dispatchId: null, tag, message: `fadeno dispatch exited before naming a dispatch id: ${detail}` });
      }
    });
    timer = setTimeout(() => {
      if (settled) return;
      if (parseDispatchId(stdout) != null) return; // data handler will finish
      finish({
        ok: true,
        dispatchId: null,
        tag,
        message: `fadeno dispatch launched but had not printed a dispatch id within ${DISPATCH_ID_TIMEOUT_MS}ms; the watcher will deliver via the tag watch`,
      });
    }, DISPATCH_ID_TIMEOUT_MS);
    child.stdin?.on('error', () => {}); // EPIPE after early kernel exit is reported by 'close'
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/**
 * The optional in-tool wait: block up to `seconds` for the dispatch to finish
 * and return its report. Bounded hard — a tool call that blocks for minutes
 * is a foreground call with extra steps.
 */
function waitForOutput(repoDir, tag, seconds, argv0 = 'fadeno', spawnSyncFn = spawnSync) {
  const clamped = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(seconds)));
  if (clamped === 0) return null;
  try {
    const result = spawnSyncFn(argv0, ['dispatches', '--output', `tag:${tag}`, '--wait', String(clamped)], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: (clamped + 10) * 1000,
    });
    const out = (result.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * The plugin OpenCode loads. One exported factory (loader constraint above);
 * its product carries the tool registration plus the completion watcher.
 */
export default async function FadenoDispatchTool(input) {
  const repoDir =
    typeof input?.directory === 'string' && input.directory.length > 0
      ? input.directory
      : process.cwd();
  const client = input?.client;
  const registryPath = watchRegistryPath(repoDir);
  const evidencePath = join(repoDir, '.fadeno', 'dispatches.jsonl');

  // dispatchId -> { tag, sessionID }. Hydrated from the persisted registry so
  // a host restart does not orphan in-flight wake-ups. A null sessionID is a
  // first-class entry: the watcher still toasts the verdict, it just cannot
  // inject a turn.
  const watched = new Map();
  for (const entry of readWatchRegistry(registryPath)) {
    if (entry.dispatchId != null) watched.set(entry.dispatchId, { tag: entry.tag, sessionID: entry.sessionID ?? null });
  }
  let pollTimer = null;
  let evidenceOffset = 0;
  const notified = new Set();

  // Launches whose dispatch id never arrived: tag -> { tag, sessionID }.
  // The kernel owns the launch either way (the evidence row proves it), so
  // the watcher can still own the delivery — pollEvidence promotes these to
  // real watched entries when the request row appears. In-memory only: a
  // host restart before promotion loses the wake-up, same as pre-watcher.
  const pendingByTag = new Map();

  // The session that most recently sent a message, per the chat.message hook.
  // Fallback when the tool context carries no sessionID — observed once in
  // the wild (2026-08-25: a launch took the no-session branch, the registry
  // file was never written, and the completion never delivered). The session
  // that is talking is the session that dispatched.
  let lastActiveSessionID = null;

  function log(level, message) {
    try {
      client?.app?.log?.({ body: { service: 'fadeno-dispatch-tool', level, message } })?.catch?.(() => {});
    } catch {}
  }

  function persistWatched() {
    const failure = writeWatchRegistry(
      registryPath,
      [...watched.entries()].map(([dispatchId, meta]) => ({ dispatchId, ...meta })),
    );
    if (failure != null) {
      log(
        'warn',
        `watch registry write FAILED (${registryPath}): ${failure}` +
          ` — restart-orphan recovery lost for ${watched.size} in-flight dispatch(es); live delivery unaffected`,
      );
    }
  }

  function toast(message, variant) {
    try {
      client?.tui?.showToast?.({ body: { message, variant } })?.catch?.(() => {});
    } catch {}
  }

  /** Fire a completion report into the session that launched the dispatch. */
  function deliver(row) {
    const meta = watched.get(row.dispatch_id);
    if (meta == null || notified.has(row.dispatch_id)) return;
    notified.add(row.dispatch_id);
    watched.delete(row.dispatch_id);
    persistWatched();
    const verdict = verdictOf(row);
    if (meta.sessionID == null) {
      // Degrade to user-visible: no session to wake, but the human still hears
      // about it — never the pre-watcher silence.
      log('warn', `dispatch ${row.dispatch_id} completed (${verdict}) with no session to deliver to`);
      toast(`Fadeno dispatch ${meta.tag}: ${verdict} (no session for direct delivery)`, row.exit_code === 0 ? 'success' : 'error');
      return;
    }
    let report = null;
    try {
      const fetched = spawnSync('fadeno', ['dispatches', '--output', `id:${row.dispatch_id}`], {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 30_000,
      });
      report = truncateReport(fetched?.stdout);
    } catch {}
    const message = buildCompletionMessage(meta.tag, row, report);
    // The turn trigger: prompt WITHOUT noReply so the model wakes and
    // processes the report. Fire-and-forget — a failed injection degrades to
    // the toast, and the tag recovery path still exists.
    try {
      const pending = client?.session?.prompt?.({
        path: { id: meta.sessionID },
        body: { parts: [{ type: 'text', text: message }] },
      });
      pending?.then?.(
        () => log('info', `completion of ${row.dispatch_id} delivered to session ${meta.sessionID}`),
        () => toast(`Fadeno dispatch ${meta.tag}: ${verdict} (delivery failed)`, 'warning'),
      );
    } catch {
      toast(`Fadeno dispatch ${meta.tag}: ${verdict} (delivery failed)`, 'warning');
    }
    toast(`Fadeno dispatch ${meta.tag}: ${verdict}`, row.exit_code === 0 ? 'success' : 'error');
  }

  function pollEvidence() {
    if (!existsSync(evidencePath)) return;
    const size = statSync(evidencePath).size;
    if (size <= evidenceOffset) return;
    const handle = readFileSync(evidencePath);
    const chunk = handle.subarray(evidenceOffset).toString('utf8');
    evidenceOffset = size;
    for (const row of consumeEvidence(chunk, watched, pendingByTag, notified)) deliver(row);
  }

  function startWatching() {
    if (pollTimer != null) return;
    // Start from the file's current size, then reconcile: a registry entry
    // whose dispatch ALREADY completed (host was closed mid-run) delivers now
    // rather than never. Only rows after the offset are watched live.
    try {
      if (existsSync(evidencePath)) {
        evidenceOffset = statSync(evidencePath).size;
        for (const row of extractCompletedRows(readFileSync(evidencePath, 'utf8'))) deliver(row);
      }
    } catch {}
    pollTimer = setInterval(() => {
      try { pollEvidence(); } catch {}
    }, WATCH_POLL_MS);
    // Never hold the host open on behalf of the watcher.
    pollTimer.unref?.();
  }

  return {
    tool: {
      fadeno_dispatch: tool({
        description:
          'Dispatch a Fadeno role agent (worker, reviewer, or judge) as a DETACHED BACKGROUND process. ' +
          'Returns within seconds with a dispatch id; the role work continues independently and the host ' +
          'session stays interactive. The prompt is delivered verbatim to the role agent. ' +
          'Set wait_seconds to also block for the finished report (capped at ' + MAX_WAIT_SECONDS + 's); ' +
          'leave it 0 to fire-and-forget. When fire-and-forgot, the completion report is delivered back ' +
          'into this session automatically as a new message when the dispatch finishes — no polling, ' +
          'no recovery command, in every launch path.',
        args: {
          archetype: tool.schema.string().describe('Fadeno role archetype: worker, reviewer, or judge'),
          prompt: tool.schema.string().describe('The complete task prompt for the role agent'),
          tag: tool.schema.string().optional().describe('Optional stable tag for output recovery; auto-generated when omitted, auto-suffixed when it would collide with an earlier dispatch'),
          wait_seconds: tool.schema.number().optional().describe('Optionally block up to this many seconds for the finished report (0 = fire-and-forget with automatic delivery later)'),
        },
        async execute(args, context) {
          const archetype = str(args?.archetype);
          if (archetype == null || !ARCHETYPES.includes(archetype)) {
            return `fadeno_dispatch: archetype must be one of ${ARCHETYPES.join(', ')}; got ${JSON.stringify(args?.archetype ?? null)}.`;
          }
          const prompt = typeof args?.prompt === 'string' && args.prompt.length > 0 ? args.prompt : null;
          if (prompt == null) {
            return 'fadeno_dispatch: prompt is required and must be non-empty.';
          }
          const requestedTag = str(args?.tag) ?? buildTag(archetype);
          const resolvedTag = dedupeTag(requestedTag, evidencePath);
          const tag = resolvedTag.tag;
          const waitSeconds = typeof args?.wait_seconds === 'number' && Number.isFinite(args.wait_seconds) ? args.wait_seconds : 0;
          // Resolution order: the tool context's own session id, then the
          // chat.message hook's record of the session that last spoke. The
          // context field has been observed missing in the wild; the fallback
          // is what keeps delivery alive when it is.
          const contextSessionID = str(context?.sessionID);
          const sessionID = contextSessionID ?? lastActiveSessionID;
          log(
            'info',
            `launch ${archetype} tag=${tag}: context sessionID ${contextSessionID != null ? 'present' : 'ABSENT'}` +
              `${contextSessionID == null ? ` (context keys: ${context != null ? Object.keys(context).sort().join(',') : 'none'})` : ''}` +
              `, resolved session ${sessionID ?? 'none'}`,
          );
          const launch = await launchDispatch(repoDir, archetype, tag, prompt);
          if (!launch.ok) {
            log('error', `launch failed: ${launch.message}`);
            return `fadeno_dispatch failed: ${launch.message}`;
          }
          const waited = waitSeconds > 0 ? waitForOutput(repoDir, tag, waitSeconds) : null;
          const lines = [
            `fadeno_dispatch: ${launch.message}`,
            `archetype: ${archetype} | tag: ${tag} | running detached — the host session is free`,
          ];
          if (resolvedTag.deduped) {
            lines.push(`Requested tag "${requestedTag}" already names an earlier dispatch; this launch uses "${tag}" instead.`);
          }
          if (waited != null) {
            lines.push(`report (waited ${Math.min(Math.max(0, Math.floor(waitSeconds)), MAX_WAIT_SECONDS)}s):`, waited);
          } else if (launch.dispatchId != null) {
            // Registered either way: with a session for turn-triggering
            // delivery, without one for a completion toast. The watcher owns
            // it from here.
            watched.set(launch.dispatchId, { tag, sessionID });
            persistWatched();
            startWatching();
            // The 2026-08-26 live run showed the host model ignoring the
            // detached semantics and immediately blocking on
            // `fadeno dispatches --wait`, which defeats the backgrounding.
            // Say what to do, not only what will happen.
            lines.push(
              'End your turn now — do NOT poll or block with `fadeno dispatches --wait`; the watcher delivers the report into this session automatically.',
            );
            lines.push(
              sessionID != null
                ? `The completion report will be delivered back into this session automatically (dispatch ${launch.dispatchId}, session ${sessionID}).`
                : `Watching for completion, but no session id is available for direct delivery — you will get a toast only (dispatch ${launch.dispatchId}). The full report lands under .fadeno/local/outputs/.`,
            );
          } else {
            // The kernel launched (the evidence row proves it) but no id was
            // captured. Register by tag instead — and reconcile immediately:
            // the request row usually landed while the capture race was still
            // running, so it is already behind the poller's offset and only a
            // full-file scan can see it (observed live 2026-08-26 03:27: the
            // row was on disk 200ms in; the pending watch never promoted).
            pendingByTag.set(tag, { tag, sessionID });
            const historyId = lastRequestIdForTag(
              existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8') : null,
              tag,
            );
            if (historyId != null && !notified.has(historyId)) {
              pendingByTag.delete(tag);
              watched.set(historyId, { tag, sessionID });
              persistWatched();
            }
            startWatching();
            log(
              'warn',
              `no dispatch id within ${Math.round(DISPATCH_ID_TIMEOUT_MS / 1000)}s; watching by tag "${tag}"` +
                `${historyId != null ? ` (promoted from evidence: dispatch ${historyId})` : ' (request row not yet on disk)'} — delivery still automatic`,
            );
            lines.push(`No dispatch id was captured within ${Math.round(DISPATCH_ID_TIMEOUT_MS / 1000)}s, so recovery by id is unavailable — but the completion will still be delivered into this session automatically via the tag watch (${tag}).`);
            lines.push('End your turn now — do NOT poll or block with `fadeno dispatches --wait`; the watcher delivers the report automatically.');
          }
          return lines.join('\n');
        },
      }),
    },
    // The session-discovery fallback: remember whoever spoke last. Cheap,
    // best-effort, and only consulted when the tool context omits sessionID.
    'chat.message': async (input) => {
      const id = str(input?.sessionID);
      if (id != null) lastActiveSessionID = id;
    },
  };
}

/**
 * The pure decision core, behind ONE exported factory — same loader
 * constraint and same rationale as fadenoSteeringCore: a bare export would be
 * invoked with PluginInput at startup. Calling this factory is harmless (its
 * product is inert) and tests import it to pin the launch contract.
 */
export function fadenoDispatchToolCore() {
  return {
    ARCHETYPES,
    DISPATCH_ID_TIMEOUT_MS,
    MAX_WAIT_SECONDS,
    REPORT_MAX_CHARS,
    WATCH_REGISTRY_BASENAME,
    buildArgv,
    buildTag,
    parseDispatchId,
    reportFilePath,
    launchDispatch,
    waitForOutput,
    watchRegistryPath,
    readWatchRegistry,
    writeWatchRegistry,
    usedTags,
    dedupeTag,
    consumeEvidence,
    lastRequestIdForTag,
    extractCompletedRows,
    verdictOf,
    buildCompletionMessage,
    truncateReport,
  };
}

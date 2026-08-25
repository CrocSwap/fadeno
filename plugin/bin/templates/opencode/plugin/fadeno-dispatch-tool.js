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

// Upper bound on the optional in-tool wait. Longer waits belong to
// `fadeno dispatches --output tag:<tag> --wait <n>`, which the model can call
// itself; a tool call that blocks for minutes defeats the point.
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

function recoveryHint(tag, dispatchId) {
  const by = dispatchId != null ? `id:${dispatchId}` : `tag:${tag}`;
  return `Recover output with: fadeno dispatches --output ${by} --wait 600`;
}

/** The persisted launch registry: which session owns which in-flight dispatch. */
const WATCH_REGISTRY_BASENAME = 'dispatch-watch.json';

function watchRegistryPath(repoDir) {
  return join(repoDir, '.fadeno', 'local', WATCH_REGISTRY_BASENAME);
}

/** Read the registry; unreadable/absent/malformed all degrade to empty. */
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

/** Best-effort registry write; a failed write loses wake-ups, not the host. */
function writeWatchRegistry(path, entries) {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  } catch {}
}

/**
 * Completed-dispatch rows from an appended evidence chunk. Only
 * `dispatch_completed` rows carry the terminal verdict; everything else is
 * noise to the watcher.
 */
function extractCompletedRows(chunk) {
  const out = [];
  for (const line of String(chunk ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.event === 'dispatch_completed' && typeof row.dispatch_id === 'string') {
        out.push(row);
      }
    } catch {}
  }
  return out;
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
    lines.push(recoveryHint(tag, row.dispatch_id));
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
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      const dispatchId = parseDispatchId(stdout);
      if (dispatchId != null) {
        finish({ ok: true, dispatchId, tag, message: `dispatch ${dispatchId} launched (tag ${tag})` });
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      finish({ ok: false, dispatchId: null, tag, message: `fadeno dispatch failed to start: ${error?.message ?? error}` });
    });
    child.once('close', (code) => {
      // The kernel exiting BEFORE printing an id is a real launch failure.
      // After the id is captured this fires only at kernel completion, long
      // after finish() — settled guards it.
      if (parseDispatchId(stdout) == null) {
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
        message: `fadeno dispatch launched but had not printed a dispatch id within ${DISPATCH_ID_TIMEOUT_MS}ms; use tag-based recovery`,
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
  // a host restart does not orphan in-flight wake-ups.
  const watched = new Map();
  for (const entry of readWatchRegistry(registryPath)) {
    if (entry.dispatchId != null) watched.set(entry.dispatchId, { tag: entry.tag, sessionID: entry.sessionID });
  }
  let pollTimer = null;
  let evidenceOffset = 0;
  const notified = new Set();

  function persistWatched() {
    writeWatchRegistry(
      registryPath,
      [...watched.entries()].map(([dispatchId, meta]) => ({ dispatchId, ...meta })),
    );
  }

  function toast(message, variant) {
    try {
      client?.tui?.showToast?.({ body: { message, variant } })?.catch?.(() => {});
    } catch {}
  }

  /** Fire a completion report into the session that launched the dispatch. */
  function deliver(row) {
    const meta = watched.get(row.dispatch_id);
    if (meta == null || meta.sessionID == null || notified.has(row.dispatch_id)) return;
    notified.add(row.dispatch_id);
    watched.delete(row.dispatch_id);
    persistWatched();
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
    // silent dispatch, which is the pre-watcher status quo, and the tag
    // recovery path still exists.
    try {
      const pending = client?.session?.prompt?.({
        path: { id: meta.sessionID },
        body: { parts: [{ type: 'text', text: message }] },
      });
      pending?.catch?.(() => toast(`Fadeno dispatch ${meta.tag}: ${verdictOf(row)} (delivery failed)`, 'warning'));
    } catch {
      toast(`Fadeno dispatch ${meta.tag}: ${verdictOf(row)} (delivery failed)`, 'warning');
    }
    toast(`Fadeno dispatch ${meta.tag}: ${verdictOf(row)}`, row.exit_code === 0 ? 'success' : 'error');
  }

  function pollEvidence() {
    if (!existsSync(evidencePath)) return;
    const size = statSync(evidencePath).size;
    if (size <= evidenceOffset) return;
    const handle = readFileSync(evidencePath);
    const chunk = handle.subarray(evidenceOffset).toString('utf8');
    evidenceOffset = size;
    for (const row of extractCompletedRows(chunk)) deliver(row);
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
          'into this session automatically as a new message when the dispatch finishes. ' +
          'Recover output any time with `fadeno dispatches --output tag:<tag> --wait <seconds>`.',
        args: {
          archetype: tool.schema.string().describe('Fadeno role archetype: worker, reviewer, or judge'),
          prompt: tool.schema.string().describe('The complete task prompt for the role agent'),
          tag: tool.schema.string().optional().describe('Optional stable tag for output recovery; auto-generated when omitted'),
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
          const tag = str(args?.tag) ?? buildTag(archetype);
          const waitSeconds = typeof args?.wait_seconds === 'number' && Number.isFinite(args.wait_seconds) ? args.wait_seconds : 0;
          const sessionID = str(context?.sessionID);
          const launch = await launchDispatch(repoDir, archetype, tag, prompt);
          if (!launch.ok) return `fadeno_dispatch failed: ${launch.message}`;
          const waited = waitSeconds > 0 ? waitForOutput(repoDir, tag, waitSeconds) : null;
          const lines = [
            `fadeno_dispatch: ${launch.message}`,
            `archetype: ${archetype} | tag: ${tag} | running detached — the host session is free`,
          ];
          if (waited != null) {
            lines.push(`report (waited ${Math.min(Math.max(0, Math.floor(waitSeconds)), MAX_WAIT_SECONDS)}s):`, waited);
          } else if (launch.dispatchId != null && sessionID != null) {
            // Registered for automatic delivery; the watcher owns it from here.
            watched.set(launch.dispatchId, { tag, sessionID });
            persistWatched();
            startWatching();
            lines.push(`The completion report will be delivered back into this session automatically (dispatch ${launch.dispatchId}).`);
          } else {
            lines.push(recoveryHint(tag, launch.dispatchId));
            lines.push('No automatic completion delivery for this dispatch (no dispatch id or session id available); check the output when it matters.');
          }
          return lines.join('\n');
        },
      }),
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
    recoveryHint,
    launchDispatch,
    waitForOutput,
    watchRegistryPath,
    readWatchRegistry,
    writeWatchRegistry,
    extractCompletedRows,
    verdictOf,
    buildCompletionMessage,
    truncateReport,
  };
}

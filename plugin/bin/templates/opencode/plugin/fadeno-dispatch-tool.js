// Fadeno background-dispatch tool for OpenCode — a plugin-defined custom tool
// that gives the model a first-class "run a role agent in the background"
// verb. The native task tool in current OpenCode builds owns background
// execution end-to-end but does not expose a `background` parameter in the
// schema models see (verified 2026-08-25 across two sessions), so
// model-initiated background is unreachable by prompting. This tool closes
// that gap WITHOUT touching OpenCode's task machinery: background semantics
// come from process detachment around `fadeno dispatch`, whose kernel already
// owns the evidence rows, the isolated worktree, and attested output
// recovery. OpenCode only ever sees an ordinary tool call that returns in
// seconds.
//
// Loader constraints, same as fadeno-steering.js: auto-discovery globs
// `{plugin,plugins}/*.{js,ts}` and every exported function value is CALLED at
// startup, so the pure decision core hangs behind one exported factory whose
// product is an inert object. The `tool` helper import is what makes this a
// tool-defining plugin rather than a hooks plugin.
//
// Fail-open philosophy: the tool returns descriptive text instead of throwing
// wherever possible — a launch failure is information for the model, not an
// exception for the harness.

import { spawn, spawnSync } from 'node:child_process';
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
 * its product carries the tool registration.
 */
export default async function FadenoDispatchTool(input) {
  const repoDir =
    typeof input?.directory === 'string' && input.directory.length > 0
      ? input.directory
      : process.cwd();
  return {
    tool: {
      fadeno_dispatch: tool({
        description:
          'Dispatch a Fadeno role agent (worker, reviewer, or judge) as a DETACHED BACKGROUND process. ' +
          'Returns within seconds with a dispatch id; the role work continues independently and the host ' +
          'session stays interactive. The prompt is delivered verbatim to the role agent. ' +
          'Set wait_seconds to also block for the finished report (capped at ' + MAX_WAIT_SECONDS + 's); ' +
          'leave it 0 to fire-and-forget. Recover output any time with ' +
          '`fadeno dispatches --output tag:<tag> --wait <seconds>`. ' +
          'Completion does NOT notify this session — check with `fadeno dispatches --output tag:<tag>`.',
        args: {
          archetype: tool.schema.string().describe('Fadeno role archetype: worker, reviewer, or judge'),
          prompt: tool.schema.string().describe('The complete task prompt for the role agent'),
          tag: tool.schema.string().optional().describe('Optional stable tag for output recovery; auto-generated when omitted'),
          wait_seconds: tool.schema.number().optional().describe('Optionally block up to this many seconds for the finished report (0 = fire-and-forget)'),
        },
        async execute(args) {
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
          const launch = await launchDispatch(repoDir, archetype, tag, prompt);
          if (!launch.ok) return `fadeno_dispatch failed: ${launch.message}`;
          const waited = waitSeconds > 0 ? waitForOutput(repoDir, tag, waitSeconds) : null;
          const lines = [
            `fadeno_dispatch: ${launch.message}`,
            `archetype: ${archetype} | tag: ${tag} | running detached — the host session is free`,
          ];
          if (waited != null) {
            lines.push(`report (waited ${Math.min(Math.max(0, Math.floor(waitSeconds)), MAX_WAIT_SECONDS)}s):`, waited);
          } else {
            lines.push(recoveryHint(tag, launch.dispatchId));
            lines.push('There is no automatic completion notification; check the output when it matters.');
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
    buildArgv,
    buildTag,
    parseDispatchId,
    recoveryHint,
    launchDispatch,
    waitForOutput,
  };
}

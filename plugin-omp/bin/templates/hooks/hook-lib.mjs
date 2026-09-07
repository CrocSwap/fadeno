// Shared by every Fadeno hook. A hook is a small script the harness runs with
// an event on stdin; everything it decides, it decides by asking the `fadeno`
// CLI, and everything it says, it says in the harness's own answer shape.
// This file holds what all of them need: reading the event, finding the CLI
// that shipped beside them, running it with a budget, the host-mode marker,
// and the one sentence every refusal ends with.
//
// Hooks never write the ledger. `fadeno dispatch-open`, `dispatch-stop` and
// `dispatch` do, so the rows have one writer per kind and a hook can be wrong
// about nothing but which command to run.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The archetypes Fadeno ships agents for; a custom archetype spawns on the command lane. */
export const CANON_ARCHETYPES = ['director', 'judge', 'reviewer', 'scout', 'worker'];

/** The dispatch proxy's agent name — the one non-archetype agent Fadeno ships. */
export const PROXY_AGENT = 'dispatch';

/**
 * The last sentence of every refusal a Fadeno hook writes. Host mode's policy
 * is that a Fadeno failure is a user-facing event; the refusal text is the
 * one thing the model is guaranteed to read at that moment, so it carries
 * the instruction.
 */
export const REPORT_REFUSAL = 'Report this refusal to the user instead of routing around it.';

/** How long the CLI gets to answer a hook before the hook gives up on it. */
export const CLI_TIMEOUT_MS = 20_000;

/** Parse the event on stdin; null when there is none or it is not an object. */
export function readEvent() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'));
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Answer the harness (or say nothing) and exit 0. A hook never exits non-zero on purpose. */
export function finish(value) {
  if (value != null) process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

export function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The `fadeno` this hook runs. The one that shipped beside it is the answer
 * whenever it exists — a hook that fell back to PATH would resolve dials with
 * whatever `fadeno` the user happens to have installed rather than the build
 * it belongs to. Claude interpolates `CLAUDE_PLUGIN_ROOT`, Codex `PLUGIN_ROOT`;
 * neither is guaranteed, and the hook can find its own bundle from its own
 * URL (`<plugin>/hooks/<this>.mjs` beside `<plugin>/bin/fadeno`). PATH last.
 */
export function resolveCli(importMetaUrl, env = process.env) {
  const candidates = [];
  for (const key of ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT']) {
    const root = str(env[key]);
    if (root != null) candidates.push(join(root.trim(), 'bin', 'fadeno'));
  }
  if (importMetaUrl) candidates.push(join(dirname(fileURLToPath(importMetaUrl)), '..', 'bin', 'fadeno'));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // an unreadable candidate is simply not the one
    }
  }
  return 'fadeno';
}

/**
 * Run the CLI once, with a budget, and say what happened in a shape the
 * caller can act on: `json` when stdout parsed, `status` when it exited,
 * `failure` when it did not — `timeout` (raise the budget or find what it is
 * waiting on) and `missing` (install fadeno) need opposite fixes, so they are
 * told apart by the kill signature rather than lumped as "failed".
 */
export function runFadeno(cli, args, options) {
  const { cwd, input, harness, env = process.env } = options;
  // Tests shorten the budget; a harness never sets this.
  const configured = Number(env.FADENO_HOOK_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : CLI_TIMEOUT_MS);
  const childEnv = { ...env };
  if (harness) childEnv.FADENO_HARNESS = harness;
  const result = spawnSync(cli, args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    input: input ?? '',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = result.status == null && (result.error?.code === 'ETIMEDOUT' || result.signal != null);
  const missing = result.error?.code === 'ENOENT';
  let json = null;
  const stdout = result.stdout ?? '';
  try {
    const parsed = JSON.parse(stdout);
    if (parsed != null && typeof parsed === 'object') json = parsed;
  } catch {
    // not JSON; the caller reads stdout/stderr
  }
  return {
    status: result.status,
    stdout,
    stderr: (result.stderr ?? '').trim(),
    json,
    failure: timedOut ? 'timeout' : missing ? 'missing' : result.error != null ? 'error' : null,
    error: result.error?.message ?? null,
    timeoutMs,
  };
}

/** One paragraph describing a CLI run that did not answer, for a refusal. */
export function describeFailure(run, what) {
  if (run.failure === 'timeout') return `${what} did not answer within ${run.timeoutMs}ms.`;
  if (run.failure === 'missing') return `${what} could not be started: the fadeno CLI was not found (${run.error ?? 'ENOENT'}). Install it, or make sure the plugin's bundled copy is beside this hook.`;
  if (run.failure === 'error') return `${what} could not be started: ${run.error}.`;
  return run.stderr.length > 0 ? run.stderr : `${what} exited ${run.status} with no explanation.`;
}

/** Ensure a refusal reason ends with the reporting instruction. */
export function refusal(reason) {
  const text = String(reason).trimEnd();
  return `${text}${/[.!?…]$/.test(text) ? '' : '.'} ${REPORT_REFUSAL}`;
}

/**
 * Where the host-mode marker lives for a session: `<plugin data>/host-mode/
 * <sha256(session id)>.enabled`. Written by host-mode.mjs on activation, read
 * by the spawn hooks. Presence is the whole signal. The data root is joined
 * untrimmed because that is how it is written; only the emptiness test trims.
 */
export function hostModeMarker(sessionId, env = process.env) {
  const root = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  if (typeof root !== 'string' || root.trim() === '' || !str(sessionId)) return null;
  const key = createHash('sha256').update(sessionId).digest('hex');
  return join(root, 'host-mode', `${key}.enabled`);
}

export function hostModeEnabled(sessionId, env = process.env) {
  const marker = hostModeMarker(sessionId, env);
  return marker != null && existsSync(marker);
}

/**
 * What a spawn asked for, read off its agent type. `fadeno:worker` and a bare
 * `worker` name the archetype; `fadeno:dispatch` is the proxy; anything else
 * is the harness's own business. A custom archetype cannot be named this way
 * because no shipped agent exists for it — it runs on the command lane.
 */
export function classifyAgentType(agentType) {
  const raw = str(agentType);
  if (raw == null) return { kind: 'generic', archetype: null, bare: null };
  const bare = raw.split(':').at(-1);
  if (bare === PROXY_AGENT) return { kind: 'proxy', archetype: null, bare };
  if (CANON_ARCHETYPES.includes(bare)) return { kind: 'archetype', archetype: bare, bare };
  return { kind: 'generic', archetype: null, bare };
}

/** A short semantic name for a dispatch from whatever the spawn called itself. */
export function nameFrom(...candidates) {
  for (const candidate of candidates) {
    const text = str(candidate)?.trim();
    if (text) return text.slice(0, 60);
  }
  return null;
}

/**
 * The prompt a dispatch proxy receives: the one command it runs and how to
 * report. The task itself is in the staged file; the proxy never sees it.
 */
export function proxyPrompt(relay, detail) {
  return [
    `Run this command exactly once, with the Bash tool's \`timeout\` parameter set to 600000, and relay its stdout verbatim as your final message:`,
    '',
    '```bash',
    relay.command,
    '```',
    '',
    `It dispatches ${detail}. The prompt is already in the file the command names; do not read it, describe it, or write any file.`,
    'If `fadeno` is not found, run the same command once more with `"$CLAUDE_PLUGIN_ROOT/bin/fadeno"` in place of `fadeno`.',
    'If the command exits non-zero, relay its stdout and stderr and say the dispatch failed; do not attempt the task yourself.',
    'If the Bash call is killed or times out, the executor may still be running: report that, and recover the report with `fadeno dispatches --output <name>` using the `--name` above.',
    'Report only what the command printed. Nothing else is yours to claim.',
  ].join('\n');
}

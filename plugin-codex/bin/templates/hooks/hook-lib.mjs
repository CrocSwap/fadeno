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
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
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
  // An exit status means the process RAN. An `error` alongside one is about
  // the pipe, not about starting — EPIPE when the CLI exits before reading all
  // of the prompt is the common case — and reporting it as "could not be
  // started" throws away the answer the process actually gave.
  const ran = result.status != null;
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
    failure: timedOut ? 'timeout' : missing ? 'missing' : result.error != null && !ran ? 'error' : null,
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
 * How long a stashed label is worth reading. Not a deadline on anything: it
 * bounds a CACHE, so a spawn that was refused, or a session that died between
 * the spawn and the start, cannot leave a label behind to be attached to
 * somebody else's agent an hour later.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Where PreToolUse leaves what only it can see, for SubagentStart to pick up.
 *
 * The two events share no id: PreToolUse has a `tool_use_id`, SubagentStart
 * has an `agent_id`, and nothing links them. So PreToolUse reserves one
 * exclusive session/archetype slot, and SubagentStart claims that slot with
 * an atomic rename before it reads any plaintext.
 *
 * What is stashed here is deliberately only the LABEL — the task name and the
 * prompt when it was readable — plus the repository identity that must match
 * at both events. Everything consequential (the dispatch id, the worktree,
 * the branch, the contract) is decided at SubagentStart, where the agent id
 * is known. A second reservation fails before its agent exists; a recovery-
 * state start gets a sealed fallback.
 */
function pendingDir(sessionId, archetype, env = process.env) {
  const root = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  if (typeof root !== 'string' || root.trim() === '' || !str(sessionId) || !str(archetype)) return null;
  const key = createHash('sha256').update(`${sessionId} ${archetype}`).digest('hex');
  return join(root, 'pending', key);
}

function pendingSlot(dir) {
  return join(dir, 'reservation.json');
}

function pendingEntry(dir, repoKey) {
  return join(dir, `${repoKey}.json`);
}

function validRepoKey(repoKey) {
  return typeof repoKey === 'string' && /^[a-f0-9]{64}$/.test(repoKey);
}

function drop(path) {
  try {
    // Pending artifacts are files. Never recursively remove an untrusted path:
    // a malformed scratch entry must not turn cleanup into a directory wipe.
    rmSync(path, { force: true });
  } catch {
    // Scratch cleanup is best effort; an unreadable record is never usable.
  }
}

const PENDING_ARTIFACT_RE = /^(?:reservation\.json|[a-f0-9]{64}\.json)(?:\.(?:claimed|tmp|cleanup)-[A-Za-z0-9-]+)?$/;

function pendingArtifact(name) {
  return PENDING_ARTIFACT_RE.test(name);
}

function artifactRepoKey(name) {
  const match = /^([a-f0-9]{64})\.json(?:\.(?:claimed|tmp|cleanup)-[A-Za-z0-9-]+)?$/.exec(name);
  return match?.[1] ?? null;
}

function staleByMtime(path, now) {
  try {
    const age = now - statSync(path).mtimeMs;
    return Number.isFinite(age) && age > PENDING_TTL_MS;
  } catch {
    // If age cannot be established, preserve the artifact. A cleanup failure
    // must never become permission to delete a live plaintext file.
    return false;
  }
}

function staleArtifact(path, parsed, now) {
  if (typeof parsed?.at === 'number' && Number.isFinite(parsed.at)) return now - parsed.at > PENDING_TTL_MS;
  // A corrupt reservation has no trustworthy `at`; its filesystem age is the
  // bounded lazy-cleanup authority. Fresh corruption remains untouched until
  // it is old enough that no in-flight writer can reasonably own it.
  return staleByMtime(path, now);
}

/** Remove exactly this inode without racing a fresh replacement at `path`. */
function retire(path) {
  const retired = `${path}.cleanup-${randomUUID()}`;
  try {
    renameSync(path, retired);
  } catch {
    // Another process may have claimed or removed it. Crucially, do not rm the
    // original path: a concurrent process may already have created a fresh one.
    return false;
  }
  drop(retired);
  return true;
}

function removeEmpty(dir) {
  try { rmdirSync(dir); } catch { /* live or unknown artifacts keep the slot */ }
}

function readObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remove expired plugin scratch, including entries left by a crashed hook. */
export function cleanupPending(env = process.env, now = Date.now()) {
  const root = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  if (typeof root !== 'string' || root.trim() === '') return 0;
  const pendingRoot = join(root, 'pending');
  let dirs;
  try { dirs = readdirSync(pendingRoot, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const dir = join(pendingRoot, dirent.name);
    let files;
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (file.isDirectory() || !pendingArtifact(file.name)) continue;
      const path = join(dir, file.name);
      try { chmodSync(path, 0o600); } catch { /* remove by age if unreadable */ }
      const parsed = readObject(path);
      if (staleArtifact(path, parsed, now) && retire(path)) removed += 1;
    }
    removeEmpty(dir);
  }
  return removed;
}

/** Remove all reservations for a session when the harness tells us it ended. */
export function clearPending(sessionId, env = process.env) {
  const root = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  if (typeof root !== 'string' || root.trim() === '' || !str(sessionId)) return;
  const pendingRoot = join(root, 'pending');
  let dirs;
  try { dirs = readdirSync(pendingRoot, { withFileTypes: true }); } catch { return; }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const dir = join(pendingRoot, dirent.name);
    let files;
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const artifacts = files.filter((file) => !file.isDirectory() && pendingArtifact(file.name));
    const parsed = new Map(artifacts.map((file) => [file.name, readObject(join(dir, file.name))]));
    const provenRepoKeys = new Set();
    for (const [name, record] of parsed) {
      if (name.startsWith('reservation.json') && record?.sessionId === sessionId && validRepoKey(record.repoKey)) provenRepoKeys.add(record.repoKey);
    }
    for (const file of artifacts) {
      const record = parsed.get(file.name);
      // A parsed record proves its own ownership, including claimed forms.
      // Once a session-owned reservation proves a repo key, the matching
      // payload and its temp/claimed variants are associated artifacts too.
      const repoKey = artifactRepoKey(file.name);
      const belongs = record?.sessionId === sessionId || (record == null && repoKey != null && provenRepoKeys.has(repoKey));
      if (belongs) retire(join(dir, file.name));
    }
    removeEmpty(dir);
  }
}

/** Reserve the one handoff slot and write its private payload. */
export function stashPending(sessionId, archetype, repoKey, entry, env = process.env) {
  const dir = pendingDir(sessionId, archetype, env);
  if (dir == null || !validRepoKey(repoKey)) return null;
  cleanupPending(env);
  let created = false;
  let entryCreated = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const id = randomUUID();
    const at = Date.now();
    writeFileSync(pendingSlot(dir), JSON.stringify({ version: 1, at, sessionId, repoKey, id, ready: entry.prompt != null }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    created = true;
    writeFileSync(pendingEntry(dir, repoKey), JSON.stringify({ version: 1, at, sessionId, repoKey, id, ...entry }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    entryCreated = true;
    return { id, repoKey };
  } catch {
    // A competing process owns an existing reservation. Never delete its
    // slot or plaintext while reporting our own refusal.
    if (created) {
      drop(pendingSlot(dir));
      if (entryCreated) drop(pendingEntry(dir, repoKey));
    }
    return null;
  }
}

/** Complete a reserved slot after the CLI has consumed a staged token. */
export function completePending(reservation, sessionId, archetype, entry, env = process.env) {
  const dir = pendingDir(sessionId, archetype, env);
  if (dir == null || reservation == null) return false;
  const slot = pendingSlot(dir);
  const metadata = readObject(slot);
  if (metadata?.id !== reservation.id || metadata.repoKey !== reservation.repoKey || metadata.sessionId !== sessionId) return false;
  const target = pendingEntry(dir, reservation.repoKey);
  const temporary = `${target}.tmp-${reservation.id}`;
  try {
    // Test-only fault injection exercises the same rollback path as a real
    // write/rename failure without putting permissions or platform quirks in
    // the test contract. It never carries or prints plaintext.
    if (env.FADENO_TEST_FAIL_PENDING_COMPLETION === '1') throw new Error('injected pending completion failure');
    writeFileSync(temporary, JSON.stringify({ version: 1, at: metadata.at, sessionId, repoKey: reservation.repoKey, id: reservation.id, ...entry }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    writeFileSync(slot, JSON.stringify({ ...metadata, ready: true }), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    drop(temporary);
    return false;
  }
}

/** Release a reservation that will not start, without touching repository evidence. */
export function releasePending(reservation, sessionId, archetype, env = process.env) {
  const dir = pendingDir(sessionId, archetype, env);
  if (dir == null || reservation == null) return;
  const metadata = readObject(pendingSlot(dir));
  if (metadata?.id !== reservation.id || metadata.repoKey !== reservation.repoKey || metadata.sessionId !== sessionId) return;
  retire(pendingEntry(dir, reservation.repoKey));
  retire(pendingSlot(dir));
  removeEmpty(dir);
}

/**
 * Atomically claim the label this start belongs to, if it can be known.
 *
 * Returns `null` when nothing is pending, a sealed fallback reason when the
 * reservation is still being finalized or its payload is unavailable, and a
 * repository mismatch without touching the other repository's bytes. The
 * rename is the single-use claim: concurrent hook processes cannot both read
 * the same plaintext.
 */
export function takePending(sessionId, archetype, repoKey, env = process.env) {
  const dir = pendingDir(sessionId, archetype, env);
  if (dir == null || !validRepoKey(repoKey)) return { repositoryMismatch: true };
  cleanupPending(env);
  const slot = pendingSlot(dir);
  const metadata = readObject(slot);
  if (metadata == null) return null;
  if (metadata.repoKey !== repoKey || metadata.sessionId !== sessionId) return { repositoryMismatch: true };
  if (metadata.version !== 1 || typeof metadata.at !== 'number' || Date.now() - metadata.at > PENDING_TTL_MS) {
    retire(pendingEntry(dir, metadata.repoKey));
    retire(slot);
    removeEmpty(dir);
    return null;
  }
  // A start that arrives while PreToolUse is still recovering a staged token
  // cannot safely wait or guess. It gets the defensive sealed fallback; the
  // reservation remains private and expires if the first hook crashed.
  if (metadata.ready !== true) return { reserved: true };
  const claimed = `${slot}.claimed-${randomUUID()}`;
  try {
    // This rename is the process-safe single-use claim. Do not read the
    // repository-keyed plaintext until it succeeds.
    renameSync(slot, claimed);
  } catch {
    return null;
  }
  try {
    const entry = readObject(pendingEntry(dir, repoKey));
    if (entry == null || entry.version !== 1 || entry.id !== metadata.id || entry.repoKey !== repoKey || entry.sessionId !== sessionId || typeof entry.at !== 'number' || Date.now() - entry.at > PENDING_TTL_MS) {
      return { missing: true };
    }
    if (typeof entry.ambiguous === 'number') return { ambiguous: true, count: entry.ambiguous };
    return { ambiguous: false, entry };
  } finally {
    drop(pendingEntry(dir, repoKey));
    drop(claimed);
  }
}

/**
 * What a spawn asked for, read off its agent type. `fadeno:worker` (Claude),
 * `fadeno-worker` (Codex, where an agent is a user-scoped TOML whose name has
 * to be unmistakably Fadeno's) and a bare `worker` all name the archetype;
 * `fadeno:dispatch` is the proxy; anything else is the harness's own business.
 * A custom archetype cannot be named this way because no shipped agent exists
 * for it — it runs on the command lane.
 */
export function classifyAgentType(agentType) {
  const raw = str(agentType);
  if (raw == null) return { kind: 'generic', archetype: null, bare: null };
  const bare = raw.split(':').at(-1).replace(/^fadeno-/, '');
  if (bare === PROXY_AGENT) return { kind: 'proxy', archetype: null, bare };
  if (CANON_ARCHETYPES.includes(bare)) return { kind: 'archetype', archetype: bare, bare };
  return { kind: 'generic', archetype: null, bare };
}

/**
 * Whether a PreToolUse event is about spawning a subagent.
 *
 * The tool's NAME is not stable across Codex models: measured on 0.153.4,
 * gpt-5.6-luna calls it `spawn_agent` while gpt-6-astra calls it
 * `collaborationspawn_agent` — a tool-namespace prefix concatenated onto the
 * same verb. Matching the exact name is how Fadeno's spawn hook came to be
 * silent on one of the two, so this tests the suffix and accepts any
 * namespace. Claude spells it `Agent`.
 *
 * The hook manifest's `matcher` needs the same generosity, and is matched as
 * an ANCHORED regex against the tool's names rather than searched: `spawn`
 * matches nothing, `.*spawn_agent` matches both.
 */
export function isSpawnTool(toolName) {
  const raw = str(toolName);
  return raw != null && (raw === 'Agent' || raw === 'spawn_agent' || raw.endsWith('spawn_agent'));
}

/**
 * Whether a spawn's message is text Fadeno can read, or an envelope it cannot.
 *
 * Codex's newer spawn tool encrypts the message: measured on gpt-6-astra, the
 * `message` field arrives as a Fernet token (`gAAAAA…`) where gpt-5.6-luna
 * sends the prompt in the clear. A hook that treated the ciphertext as a
 * prompt would stage a blob as the task and record it as what the host asked.
 *
 * The test is shape, not a prefix: an unbroken run of base64url with no
 * whitespace at all, past a length no written brief reaches. A real prompt has
 * a space in it long before a hundred characters.
 */
export function messageIsSealed(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  return text.length >= 100 && /^[A-Za-z0-9_-]+={0,2}$/.test(text);
}

/** The Codex-safe staged task name: semantic slug plus the opaque token. */
export function stagedTaskParts(taskName) {
  if (typeof taskName !== 'string') return null;
  const match = /^([a-z0-9](?:[a-z0-9_]*[a-z0-9])?)_([a-z0-9]{16})$/.exec(taskName);
  return match == null ? null : { name: match[1], token: match[2] };
}

/**
 * The dispatch a prompt already belongs to, read from the contract header
 * Fadeno injected, or null.
 *
 * The same header `dispatch-stop` finds in a transcript, spelled here by hand
 * for the same reason a hook spells everything by hand: there is no import
 * path from a hook back into the CLI. `src/lib/contracts.ts` writes it and
 * `src/lib/transcript.ts` reads it; change one, change all three.
 */
export function contractHeader(text) {
  const match = /## Fadeno dispatch ([0-9a-f-]{36}) \(([^)\n]+)\)/.exec(String(text ?? ''));
  return match == null ? null : { id: match[1], name: match[2] };
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
export function proxyPrompt(relay, detail, name) {
  // The name as a shell word: a dispatch is often named in prose ("Fix the
  // row_base hazard"), and an unquoted one would send `dispatch-wait` looking
  // for a dispatch called "Fix".
  const waitFor = typeof name === 'string' && name.trim() !== ''
    ? (/^[A-Za-z0-9_./:@=+,-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`)
    : '<name>';
  return [
    'Run this command exactly once and relay its stdout verbatim as your final message.',
    // Not a deadline of Fadeno's — the opposite. The Bash tool kills its child
    // after two minutes by default, which would cut off most dispatches; this
    // raises it to the largest value the tool accepts. Nothing Fadeno launches
    // is stopped on a timer, and the line below says what to do when the
    // harness's own limit runs out anyway.
    "Set the Bash tool's `timeout` parameter to 600000, the maximum it accepts: that is the tool's limit, not Fadeno's, which sets no deadline on a dispatch.",
    '',
    '```bash',
    relay.command,
    '```',
    '',
    `It dispatches ${detail}. The prompt is already in the file the command names; do not read it, describe it, or write any file.`,
    'The command lane has no live inbox or mid-run messaging. Do not try to send it a follow-up or steer it while it runs; put requirements in the original prompt. To change course, let it stop, read the complete report, and start a new dispatch with a new prompt (use `--from <name|id>` only for a retained isolated branch).',
    'The command\'s stdout is the report channel; stderr and a non-zero exit are failure context. Preserve stdout verbatim even when it is partial or the executor exits non-zero — do not replace it with a success or failure summary.',
    `The detail view \`fadeno dispatches ${waitFor}\` may show only the bounded ledger preview. It is not the complete report. Use \`fadeno dispatches --output ${waitFor}\` after the dispatch stops to print the retained command-lane stdout in full; relay that output verbatim.`,
    'If `fadeno` is not found, run the same command once more with `"$CLAUDE_PLUGIN_ROOT/bin/fadeno"` in place of `fadeno`.',
    'If the command exits non-zero, relay its stdout and stderr and say the dispatch failed; do not attempt the task yourself.',
    // The dispatch outliving the harness's shell ceiling is ORDINARY, not a
    // failure: the executor is detached and finishes on its own, and
    // `dispatch-wait` reconstructs the stop row when the killed launcher is
    // not there to write it. What used to happen is that the proxy returned at
    // that moment with whatever had been written so far, and the session was
    // told the agent had finished. So: wait in bites the harness allows, and
    // do not finish until the dispatch has.
    `If that call is killed, times out, or is moved to the background, the dispatch is still running and its report is still coming. Do not report yet. Run \`fadeno dispatch-wait ${waitFor}\` — it blocks until the dispatch stops and then prints the report, which you relay verbatim.`,
    '`dispatch-wait` exits 2 with "still running" when it reaches its own bound before the dispatch does. That is not an error and nothing is wrong: run the exact same command again, as many times as it takes. A stopped dispatch can return a non-zero executor status while still carrying stdout; relay that report and its stderr cause, and say it failed.',
    // Exit 5 is the one ending with nothing to relay. It used to be reachable
    // as exit 4 too — "no report is coming" for a dispatch that had in fact
    // committed its work and written its report — and 26 finished dispatches
    // in one night were reported to their hosts as dead on the strength of it.
    'If it exits 5, the dispatch stopped without leaving any report: relay what it says verbatim and say so. Do not call the work lost — the message says what its branch holds, and that is for the caller to judge.',
    'Report only what the command printed. Nothing else is yours to claim.',
  ].join('\n');
}

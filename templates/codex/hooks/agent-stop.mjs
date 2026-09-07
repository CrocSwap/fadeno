#!/usr/bin/env node
// SubagentStop receipt for host-delivered work — the Codex twin of
// `templates/claude/hooks/agent-stop.mjs`. Everything below the imports is the
// same script; only `HOST` and this header differ, and the two must be changed
// together. They are separate files for the same reason the two
// `dispatch-proxy-guard.mjs` are: each harness's payload facts are verified
// against its own binary and belong beside the code that trusts them.
//
// One job: when a managed agent stops — finished, interrupted, killed, or cut
// off by credit exhaustion — leave a row in `.fadeno/dispatches.jsonl` saying
// so, with a snapshot of what is sitting uncommitted in the tree it was
// working in.
//
// The gap it closes, from three field reports in two repos:
//   - polymarket, 2026-09-05: a session 429 killed FIVE in-flight host agents.
//     One died mid-edit leaving five partial files. Nothing recorded any of it;
//     ~7 hours passed before the user came back and found out by hand.
//   - polymarket, 2026-09-06: both live worker dispatches killed by a session
//     429. No work was lost, but "a live experiment's uncommitted edits sat
//     unverified in a shared tree for an hour with no owner".
//   - basanos, same day: three dispatches killed by Claude session-limit and
//     credit exhaustion.
// In every one the only record of what the agent had been doing was its
// transcript, which a host has to read by hand. This row is the half a
// transcript cannot give cheaply: which files are dirty, right now.
//
// WHAT THIS ROW NEVER CLAIMS. A stop hook fires when the agent is already
// gone, so it cannot ask whether the work was finished, and it must not
// synthesize an answer:
//   - `git: "clean"` means the tree carried no uncommitted change at the stop.
//     It is NOT "the agent did nothing" and NOT "the agent finished".
//   - `git: "unavailable"` means git could not answer. It is NOT "clean".
//   - `last_message.present: false` means the harness handed this hook no
//     final assistant message. It is NOT "the agent said nothing", and above
//     all it is NOT "the agent did not finish".
//   - Nothing here is a completeness verdict. The agent never gave one.
//
// HARNESS FACTS, read out of Codex 0.153.4's own embedded JSON schemas rather
// than from documentation (re-derive them the same way on an upgrade — the
// schemas are interned in the binary under `subagent-stop.command.input`):
//   - `SubagentStop` is one of the ten hook events, alongside `PreToolUse`,
//     `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
//     `SessionStart`, `SessionEnd`, `UserPromptSubmit` and `SubagentStart`.
//   - Its input REQUIRES every one of `agent_id`, `agent_transcript_path`,
//     `agent_type`, `cwd`, `hook_event_name`, `last_assistant_message`,
//     `model`, `permission_mode`, `session_id`, `stop_hook_active`,
//     `transcript_path` and `turn_id`. `agent_transcript_path`,
//     `last_assistant_message` and `transcript_path` are explicitly nullable.
//     Every key this hook reads is spelled identically on Claude Code, which
//     is why the two files can share a body.
//   - There is no `reason` field: the schema says WHICH agent stopped, never
//     why. A Codex row therefore carries no stop reason, and this hook does
//     not invent one from the agent's last message.
//   - UNVERIFIED, and stated as such: whether Codex fires `SubagentStop` when a
//     managed agent is killed by credit exhaustion rather than concluding
//     normally. Claude's does — its `runAgent` cleanup runs the event
//     explicitly on the interrupted path — and nothing in Codex's schemas
//     answers the question either way. If it does not, the Codex half of this
//     receipt covers ordinary stops only, which is strictly more than the
//     nothing that is recorded today.
//   - `SubagentStart` carries no prompt, so there is no spawn-side identity to
//     join a stop against. That is the whole reason the correlation below is
//     as narrow as it is.
//
// Scope, stated because it is partial:
//   - Fires for EVERY managed agent stop, not only Fadeno's, matching the
//     spawn side: `spawn-guard.mjs` records a generic spawn as `native_spawn`
//     precisely so an unsteered agent never reads as no agent.
//   - Writes only into a repo that already has a `.fadeno/` tree. A hook must
//     never be the thing that creates one in a repo that opted out.
//   - Shipped by the plugin. `fadeno init --codex` installs no hooks of its
//     own, so an init-only repo has no stop receipt. Stated, not silent.
//   - Adding this hook changes `hooks/hooks.json`, so an upgraded plugin only
//     starts recording once Codex's review-and-trust flow accepts it at the
//     next session start. It is registered under its own `SubagentStop` event
//     key rather than inside an existing group, so the already-trusted
//     `PreToolUse` handlers keep their hashes and only the new entry is
//     reviewed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// Which generation of this hook wrote a given row. Same contract, and the same
// reason, as the steering hook's stamp: plugin hooks load once at session
// start, so a live session keeps running the previous build after an upgrade.
// Both emitters replace this literal with the package version; the template
// keeps 'dev', so a row reading 'dev' means the template was executed directly
// rather than an installed copy.
const HOOK_VERSION = 'dev';

/** The harness this copy of the hook runs inside. Its twin stamps the other. */
const HOST = 'codex';

/** Where `hostWorktreePath` (src/lib/host-workspace.ts) puts an isolated tree. */
const HOST_WORKTREES_REL = '.fadeno/local/host-worktrees';

/** How far up to look for the repo a host worktree belongs to. */
const WALK_UP_MAX = 8;

/** Budget for the one subprocess this hook runs. Well inside the 5s cleanup. */
const GIT_TIMEOUT_MS = 3_000;

/** Status lines kept on the row. A floor is reported, never a silent trim. */
const STATUS_ENTRIES_MAX = 200;

/** Per-line bound, so one pathological path cannot blow up the row. */
const STATUS_LINE_MAX = 240;

/** Longest final-message excerpt written to the ledger. */
const LAST_MESSAGE_MAX = 400;

/** Longest writer prose (a git failure) written to the ledger. */
const NOTE_MAX = 240;

/**
 * Exit without answering. A `SubagentStop` hook that exits 0 with no stdout
 * changes nothing about the agent or the session, which is the only acceptable
 * failure mode: this hook is evidence, never a gate.
 */
function finish() {
  process.exit(0);
}

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  finish();
}
if (event == null || typeof event !== 'object' || Array.isArray(event)) finish();
// Registered on SubagentStop alone, but a manifest is editable and a harness
// may add events; a payload that names a different one is not ours to record.
// An ABSENT name still passes: the field is required by both harnesses' own
// schemas, so absence means a caller that is not a harness at all — a test, or
// a hand-run — and refusing those would make the hook untestable.
if (typeof event.hook_event_name === 'string' && event.hook_event_name !== 'SubagentStop') finish();

/** A non-empty string, or null. Every absent value is recorded as null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One line, bounded. Ledger rows are read back into single-line views. */
function flat(text, max) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// No inferred cwd. This is a WRITE, and a caller that does not say which repo
// it is in has not earned a guess — `process.cwd()` would be whatever
// directory the harness happened to launch from. Same rule, and the same 22
// stray marker rows behind it, as `markProxyDispatch` in
// `dispatch-proxy-guard.mjs`. Both harnesses always send `cwd`.
const cwd = str(event.cwd);
if (cwd == null) finish();

/**
 * The repo whose ledger this row belongs in, and the isolated tree the agent
 * was working in when there is one.
 *
 * Two cases, and the second is load-bearing rather than a nicety. An ordinary
 * subagent runs in the repo root, where `.fadeno/` sits and every other hook's
 * "is this a Fadeno repo?" test already works. An agent on the runless host
 * lane runs in a git WORKTREE under `.fadeno/local/host-worktrees/<scope>/<id>`
 * — and `.fadeno/` is gitignored, so that worktree has no `.fadeno/` of its
 * own. The cwd-only test would therefore write nothing for exactly the
 * dispatches this hook exists to cover.
 *
 * The walk up is deliberately narrow: an ancestor is accepted ONLY when the
 * path from it down to the agent's tree is the host-worktree layout. Anything
 * else — a nested checkout, a repo that happens to sit under a Fadeno repo —
 * is refused rather than written into. Guessing which repo an agent belonged
 * to is the one mistake a row like this cannot afford.
 */
function resolveRepo(from) {
  if (existsSync(join(from, '.fadeno'))) return { root: from, tree: null, scope: null, dispatchId: null };
  let dir = from;
  for (let i = 0; i < WALK_UP_MAX; i += 1) {
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
    if (!existsSync(join(dir, '.fadeno'))) continue;
    const rel = relative(dir, from).split(sep).join('/');
    if (!rel.startsWith(`${HOST_WORKTREES_REL}/`)) return null; // not our layout: claim nothing
    const rest = rel.slice(HOST_WORKTREES_REL.length + 1).split('/');
    // `<scope>/<dispatch-id>` exactly. A deeper cwd means the agent moved
    // inside the worktree, which is fine — but the id is then the second
    // segment either way, so take the first two and no more.
    return {
      root: dir,
      tree: rel,
      scope: rest.length >= 2 ? rest[0] : null,
      dispatchId: rest.length >= 2 ? rest[1] : null,
    };
  }
  return null;
}

const repo = resolveRepo(cwd);
if (repo == null) finish(); // not a Fadeno repo, or one this hook may not claim

/**
 * What is sitting uncommitted in the tree the agent was working in.
 *
 * This is the half the reporters asked for and the half a transcript cannot
 * give cheaply. It is a snapshot of the TREE, not an attribution to the agent:
 * a host, a user and other agents write here too, so the row says what is
 * there, never who put it there.
 */
function workspaceSnapshot(dir) {
  const unavailable = (note) => ({
    git: 'unavailable',
    entries: null,
    entry_count: null,
    truncated: false,
    // Why, in git's own words. `unavailable` and `clean` must never be
    // spelled the same way: "I could not tell" is not "there was nothing".
    note: note == null ? null : flat(note, NOTE_MAX),
  });
  let result;
  try {
    result = spawnSync('git', ['status', '--short'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    return unavailable(`git status could not be run: ${err}`);
  }
  if (result.error != null) {
    return unavailable(
      result.error.code === 'ETIMEDOUT'
        ? `git status did not answer within ${GIT_TIMEOUT_MS}ms`
        : `git status could not be run: ${result.error.message ?? result.error.code}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    return unavailable(stderr.length > 0 ? stderr : `git status exited ${result.status}`);
  }
  const lines = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0);
  const shown = lines
    .slice(0, STATUS_ENTRIES_MAX)
    .map((line) => (line.length > STATUS_LINE_MAX ? `${line.slice(0, STATUS_LINE_MAX - 1)}…` : line));
  return {
    // A closed vocabulary of three. `clean` is a real claim and is only ever
    // made when git answered and listed nothing.
    git: lines.length === 0 ? 'clean' : 'dirty',
    entries: shown,
    entry_count: lines.length,
    truncated: shown.length < lines.length,
    note: null,
  };
}

const lastMessage = typeof event.last_assistant_message === 'string' ? event.last_assistant_message : null;

try {
  appendFileSync(
    join(repo.root, '.fadeno', 'dispatches.jsonl'),
    `${JSON.stringify({
      // Evidence-row format version, duplicated as a literal from
      // DISPATCHES_FORMAT in src/commands/dispatch.ts, exactly as the steering
      // hook and both proxy guards do it: a standalone hook has no import path
      // back into the CLI. ADDITIVE under 1.1 — readers tier on the MAJOR, so a
      // new event name needs no bump, while a bump would make every older
      // reader skip ALL rows as "newer format".
      format: '1.1',
      timestamp: new Date().toISOString(),
      event: 'host_agent_stopped',
      fadeno_version: HOOK_VERSION,
      hook_version: HOOK_VERSION,
      host: HOST,
      // Identity as the harness gave it. `agent_type` is the RESOLVED type —
      // what actually ran — which is not always what the director asked for: a
      // steered `worker` spawn arrives here as `fadeno:worker`, and a rewritten
      // one as `fadeno:dispatch-worker`. Claude spells an unknown type as the
      // empty string, which `str` records as null.
      agent_type: str(event.agent_type),
      agent_id: str(event.agent_id),
      // The PARENT session's id on both harnesses: this hook runs as the
      // subagent concludes, inside the session that spawned it.
      session_id: str(event.session_id),
      // Where the transcript is, so a host that DOES want it has the path
      // without hunting. Recording the path is the point; reading the file is
      // not this hook's job and would not fit its budget.
      agent_transcript_path: str(event.agent_transcript_path),
      // Codex publishes the agent's model on this event; Claude does not.
      // Null rather than omitted, so the two harnesses' rows diff field for
      // field — the rule `recordHostRefusal` follows in the steering hook.
      model: str(event.model),
      stop_hook_active: typeof event.stop_hook_active === 'boolean' ? event.stop_hook_active : null,
      // The agent's own last words, and the PRESENCE of them as a separate
      // fact — because a harness may hand over none, and Claude's measurably
      // does not on the interrupted path, so a reader must be able to tell
      // "the agent signed off" from "the harness had nothing to hand over".
      // Neither one is a completeness verdict and nothing downstream may
      // render one: the agent was never asked.
      last_message: {
        present: lastMessage != null,
        chars: lastMessage != null ? lastMessage.length : null,
        excerpt: lastMessage != null ? flat(lastMessage, LAST_MESSAGE_MAX) : null,
      },
      // The tree, as it stood at the stop.
      workspace: {
        // Repo-relative, and null when the agent was in the repo root itself.
        tree: repo.tree,
        ...workspaceSnapshot(cwd),
      },
      // WHICH DISPATCH. A stop event names an agent, never a dispatch, so this
      // is null far more often than not — and null is the honest answer.
      //
      // The one basis that is not a guess: an isolated host dispatch runs in
      // `.fadeno/local/host-worktrees/<scope>/<dispatch-id>`, so when the
      // agent's cwd resolved inside one the id is READ OUT OF THE PATH. That
      // is an identification, not a correlation heuristic.
      //
      // Everything else is left to the reader, which can see the whole log and
      // can say what was open without pretending to know which one was this
      // agent's. A row that names the wrong dispatch is worse than one that
      // names none.
      dispatch_correlation: {
        dispatch_id: repo.dispatchId,
        scope: repo.scope,
        basis: repo.dispatchId != null ? 'host_worktree_path' : 'unestablished',
      },
    })}\n`,
  );
} catch {
  // best-effort, exactly like every other write in every other hook here: a
  // failed append must never be the thing that breaks the host session.
}
finish();

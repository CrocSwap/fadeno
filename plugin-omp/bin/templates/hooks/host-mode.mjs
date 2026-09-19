#!/usr/bin/env node
// Session-scoped host mode on Claude Code and Codex. The user turns it on
// with the host command (`/fadeno:host` on Claude, `$fadeno-host` on Codex)
// and off with `off`; a marker under the plugin's data directory, keyed by
// session id, carries the state across turns and compaction so nothing has
// to be written into a repository instruction file.
//
// What the session is told (spec §06): the host policy below, and the output
// of `fadeno context` — the archetypes, the spawn rules, the close obligation,
// and every unclosed dispatch. Both come from one source: the policy is
// mirrored sentence for sentence in the host skill
// (a test holds them together), and the vocabulary is the CLI's. The full
// text goes in at activation and again whenever the session starts or is
// compacted; an ordinary turn gets a compact reminder derived from the live
// ledger, because stop-hook notification is best effort.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clearPending, cleanupPending, finish, hostModeMarker, readEvent, resolveCli, runFadeno, str } from './hook-lib.mjs';

// Mirrored in templates/common/skills/fadeno-host/SKILL.md; keep the sentences identical.
const HOST_POLICY = `# Fadeno host mode (session-scoped)

The user explicitly enabled Fadeno host mode for this session. Operate as the host: decompose the task, delegate through Fadeno's archetypes, read every report yourself, integrate the work, and close every dispatch. Perform small, local, low-risk changes directly when delegation would cost more than the work itself. Do not forward this policy to the agents you spawn; Fadeno gives them their own contract.

Generic subagents are refused while host mode is on; name an archetype instead. \`off\` lifts that for the rest of the session.

A command-lane process liveness echo is an operational stderr signal from the Fadeno launcher, not a user-facing host progress update. Report host progress only when something materially changes. If no material change occurs during a long-running dispatch, a five-minute check-in is the maximum useful cadence; there is no heartbeat when no dispatch is in flight. In the Codex desktop app, when its thread heartbeat/scheduled follow-up facility is available, prefer that nonblocking mechanism for monitoring long-running dispatches so the user can continue prompting. Keep the scheduled check quiet when dispatch state is unchanged, and end it when no dispatch remains in flight. This is host behavior using the app capability; Fadeno itself cannot call a Codex app API. Outside an environment with scheduled thread heartbeats, do not hold a foreground assistant turn open solely to emit chat updates. The managed foreground shell requirement for the command launcher itself remains unchanged.

The command lane has no live inbox or mid-run messaging. Do not try to send it a follow-up or steer it while it runs; put requirements in the original prompt. To change course, let it stop, read the complete report with \`fadeno dispatches --output <name>\` (or \`fadeno dispatch-wait <name>\` while waiting), then start a new dispatch with a new prompt. Use \`--from <name|id>\` only when stopped work has a retained isolated branch; a shared-tree dispatch cannot provide a follow-up baseline. \`fadeno dispatches <name>\` may show only a bounded ledger preview, never the complete command-lane report.

After a Fadeno host agent returns a final response, inspect its dispatch. If it is still \`open\`, or if it is \`awaiting close\` with worktree inspection pending, save the already-received final response to a file and replay the idempotent stop with \`fadeno dispatch-stop <name|id> --message-file <path>\`; then inspect the report and close it normally. Stdin remains supported for a one-shot invocation, but a live two-process pipeline is not the default recovery path. The stop hook's durable receipt makes this replay safe even when its optional worktree inspection was interrupted.

Fadeno failing is a user-facing event, not a routing problem to solve quietly. A refused spawn, a dispatch that fails or returns nothing, or a resolver error stops the work and goes to the user first: report it in the reply with the dispatch id or name and the error text. Never substitute a generic subagent, a different model, or your own hands for delegated work without the user's explicit go.

Codex native subagent threads have a runtime concurrency limit; command-lane processes do not consume native slots. Keep the host lane for interactive work and use the command lane for planned overflow or broad fan-out. If a correctly routed Codex spawn fails before opening with \`agent thread limit reached\`, retry the identical archetype, model, effort, prompt, and worktree policy through a direct \`<cli> dispatch\` command, carrying the same \`--model <model>@<effort>\` ref and the same shared/worktree options. Do not substitute a model. Run that command through a managed foreground shell; never detach it with \`nohup\` and never manually invoke the executor argv. If the shell call yields while the dispatch continues, use \`<cli> dispatch-wait <name>\` as documented. A native capacity refusal happens before a dispatch exists, so if \`--dispatch\` cannot resolve the attempted name, record repository-level friction with \`<cli> feedback \"<what happened>\"\` and omit \`--dispatch\`.

While dispatches are open, every reply names what is running, stopped, and closed, with the model and lane of each.

When concrete friction attributable to Fadeno occurs, record it with \`fadeno feedback "<what happened>"\`, adding --dispatch <name> when it happened on one. The command stamps the time, harness and version and appends to .fadeno/feedback.md; write what happened, what you expected, and the workaround if you found one. Do not invent feedback. Delegated agents may record their own; read the file with \`fadeno feedback\`.`;

const REMINDER_PREFIX = 'Fadeno host mode is on for this session: delegate through archetypes, report Fadeno failures to the user, close every dispatch.';

const event = readEvent();
if (event == null) finish(null);
const name = str(event.hook_event_name) ?? '';
const session = str(event.session_id);
const marker = hostModeMarker(session);
const cwd = str(event.cwd) ?? process.cwd();
// Codex supplies PLUGIN_ROOT and may also supply the Claude-compatible alias.
// Prefer its native marker so context includes Codex's explicit spawn routing.
const harness = process.env.PLUGIN_ROOT ? 'codex' : process.env.CLAUDE_PLUGIN_ROOT ? 'claude' : undefined;

/** on / off / null, from the activation surfaces of either harness. */
function action() {
  if (name === 'UserPromptExpansion') {
    if (!/(^|:)host$/.test(str(event.command_name) ?? '')) return null;
    return /^off(?:\s|$)/i.test((str(event.command_args) ?? '').trim()) ? 'off' : 'on';
  }
  if (name === 'UserPromptSubmit') {
    // Codex's plugin picker uses the qualified skill name; typed invocations
    // can use the short name. Require the whole name so another skill whose
    // name merely starts with fadeno-host cannot activate this session.
    const match = /(?:^|\s)\$(?:fadeno:)?fadeno-host(?=\s|$)(?:\s+(\S+))?/m.exec(str(event.prompt) ?? '');
    if (match == null) return null;
    return (match[1] ?? '').toLowerCase() === 'off' ? 'off' : 'on';
  }
  return null;
}

function vocabulary() {
  const cli = resolveCli(import.meta.url);
  const run = runFadeno(cli, ['context'], { cwd, harness });
  if (run.status === 0 && run.stdout.trim() !== '') return run.stdout.trimEnd();
  return `(\`fadeno context\` could not be read here: ${run.stderr || run.error || `exit ${run.status}`}. Run it yourself for the archetype table and the unclosed dispatches.)`;
}

function turnReminder() {
  const cli = resolveCli(import.meta.url);
  const run = runFadeno(cli, ['context', '--json'], { cwd, harness });
  if (run.status === 0 && typeof run.json?.reminder === 'string' && run.json.reminder.trim() !== '') {
    return `${REMINDER_PREFIX} ${run.json.reminder.trim()}`;
  }
  const detail = run.stderr || run.error || `exit ${run.status}`;
  return `${REMINDER_PREFIX} \`fadeno context\` could not be read here: ${detail}. Run it yourself for the current ledger reminder.`;
}

function emit(text) {
  finish({ hookSpecificOutput: { hookEventName: name, additionalContext: text } });
}

const act = action();
if (name === 'SessionEnd' || act === 'off') {
  clearPending(session);
  if (marker != null) rmSync(marker, { force: true });
  finish(null);
}
if (act === 'on' && marker != null) {
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, 'enabled\n', { encoding: 'utf8', mode: 0o600 });
}
cleanupPending();
const active = act === 'on' || (marker != null && existsSync(marker));
if (!active) finish(null);

// Claude's command expansion loads the host skill for the activating turn, so
// the policy is not repeated there; the vocabulary still is, because the
// skill cannot run the CLI. Codex activates on UserPromptSubmit and gets both.
if (act === 'on') emit(name === 'UserPromptExpansion' ? vocabulary() : `${HOST_POLICY}\n\n${vocabulary()}`);
if (name === 'SessionStart') emit(`${HOST_POLICY}\n\n${vocabulary()}`);
if (name === 'UserPromptSubmit') emit(turnReminder());
finish(null);

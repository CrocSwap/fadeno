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
// compacted; an ordinary turn gets a one-line reminder, because the nag
// belongs to spawns, not to prompts.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { finish, hostModeMarker, readEvent, resolveCli, runFadeno, str } from './hook-lib.mjs';

// Mirrored in templates/common/skills/fadeno-host/SKILL.md; keep the sentences identical.
const HOST_POLICY = `# Fadeno host mode (session-scoped)

The user explicitly enabled Fadeno host mode for this session. Operate as the host: decompose the task, delegate through Fadeno's archetypes, read every report yourself, integrate the work, and close every dispatch. Perform small, local, low-risk changes directly when delegation would cost more than the work itself. Do not forward this policy to the agents you spawn; Fadeno gives them their own contract.

Generic subagents are refused while host mode is on; name an archetype instead. \`off\` lifts that for the rest of the session.

Fadeno failing is a user-facing event, not a routing problem to solve quietly. A refused spawn, a dispatch that fails or returns nothing, or a resolver error stops the work and goes to the user first: report it in the reply with the dispatch id or name and the error text. Never substitute a generic subagent, a different model, or your own hands for delegated work without the user's explicit go.

While dispatches are open, every reply names what is running, stopped, and closed, with the model and lane of each.

When concrete friction attributable to Fadeno occurs, record it with \`fadeno feedback "<what happened>"\`, adding --dispatch <name> when it happened on one. The command stamps the time, harness and version and appends to .fadeno/feedback.md; write what happened, what you expected, and the workaround if you found one. Do not invent feedback. Delegated agents may record their own; read the file with \`fadeno feedback\`.`;

const REMINDER = 'Fadeno host mode is on for this session: delegate through archetypes, report Fadeno failures to the user, close every dispatch. `fadeno context` prints the vocabulary and every unclosed dispatch.';

const event = readEvent();
if (event == null) finish(null);
const name = str(event.hook_event_name) ?? '';
const session = str(event.session_id);
const marker = hostModeMarker(session);
const cwd = str(event.cwd) ?? process.cwd();

/** on / off / null, from the activation surfaces of either harness. */
function action() {
  if (name === 'UserPromptExpansion') {
    if (!/(^|:)host$/.test(str(event.command_name) ?? '')) return null;
    return /^off(?:\s|$)/i.test((str(event.command_args) ?? '').trim()) ? 'off' : 'on';
  }
  if (name === 'UserPromptSubmit') {
    const match = /(?:^|\s)\$fadeno-host(?:\s+(\S+))?/m.exec(str(event.prompt) ?? '');
    if (match == null) return null;
    return (match[1] ?? '').toLowerCase() === 'off' ? 'off' : 'on';
  }
  return null;
}

function vocabulary() {
  const cli = resolveCli(import.meta.url);
  const harness = process.env.CLAUDE_PLUGIN_ROOT ? 'claude' : process.env.PLUGIN_ROOT ? 'codex' : undefined;
  const run = runFadeno(cli, ['context'], { cwd, harness });
  if (run.status === 0 && run.stdout.trim() !== '') return run.stdout.trimEnd();
  return `(\`fadeno context\` could not be read here: ${run.stderr || run.error || `exit ${run.status}`}. Run it yourself for the archetype table and the unclosed dispatches.)`;
}

function emit(text) {
  finish({ hookSpecificOutput: { hookEventName: name, additionalContext: text } });
}

const act = action();
if (name === 'SessionEnd' || act === 'off') {
  if (marker != null) rmSync(marker, { force: true });
  finish(null);
}
if (act === 'on' && marker != null) {
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, 'enabled\n', 'utf8');
}
const active = act === 'on' || (marker != null && existsSync(marker));
if (!active) finish(null);

// Claude's command expansion loads the host skill for the activating turn, so
// the policy is not repeated there; the vocabulary still is, because the
// skill cannot run the CLI. Codex activates on UserPromptSubmit and gets both.
if (act === 'on') emit(name === 'UserPromptExpansion' ? vocabulary() : `${HOST_POLICY}\n\n${vocabulary()}`);
if (name === 'SessionStart') emit(`${HOST_POLICY}\n\n${vocabulary()}`);
if (name === 'UserPromptSubmit') emit(REMINDER);
finish(null);

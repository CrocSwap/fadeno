import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Static developer context injected only after this plugin user's explicit
// /fadeno:host (Claude) or $fadeno-host (Codex) activation. Keep this aligned
// with templates/common/skills/fadeno-host/SKILL.md; the skill governs the
// activation turn, while this hook makes the same policy survive later turns
// and compaction without touching a repository instruction file.
const HOST_POLICY = `# Fadeno host mode (session-scoped)

The user explicitly enabled Fadeno host mode for this root session. Operate as
the host coordinator: decompose, route, monitor, and integrate work through
Fadeno. For complex tasks, independent workstreams, specialist review, or work
that benefits from recorded verification, prefer Fadeno playbooks and routed
archetypes. Parallelize independent work only when its expected latency or
quality benefit outweighs dispatch overhead and merge-conflict risk.

Prefer Fadeno skills, engine execution, and routed archetypes over unmanaged
generic harness subagents. While host mode is on, do not spawn generic (non-archetype)
subagents: the managed role agents (worker, reviewer, judge) are the host
lane, and on Codex the plugin hook refuses generic spawns outright. Turning
host mode off lifts the rule for the session.
Perform small, local, low-risk changes directly when delegation would cost more
than the work itself.
The host retains responsibility for decomposition, user decisions, integration,
verification, and the final report. Do not forward this coordinator policy to
workers, reviewers, judges, or command executors.

Fadeno is in beta. When concrete friction attributable to Fadeno occurs, append
it to ./.fadeno/feedback.md with the date, host, task, observed behavior,
evidence, impact, and workaround when known. Do not invent feedback. Delegated
agents report friction to the host; the host alone edits the feedback file.`;

function readInput() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dataRoot() {
  const value = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function markerPath(input) {
  const root = dataRoot();
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (root == null || sessionId === '') return null;
  const key = createHash('sha256').update(sessionId).digest('hex');
  return join(root, 'host-mode', `${key}.enabled`);
}

function actionFor(input) {
  if (input.hook_event_name === 'UserPromptExpansion') {
    const name = typeof input.command_name === 'string' ? input.command_name : '';
    if (!/(^|:)host$/.test(name)) return null;
    const args = typeof input.command_args === 'string' ? input.command_args.trim() : '';
    return /^off(?:\s|$)/i.test(args) ? 'off' : 'on';
  }
  if (input.hook_event_name === 'UserPromptSubmit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const match = /(?:^|\s)\$fadeno-host(?:\s+([^\s]+))?/m.exec(prompt);
    if (match == null) return null;
    return (match[1] ?? '').toLowerCase() === 'off' ? 'off' : 'on';
  }
  return null;
}

function emitContext(event) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: HOST_POLICY,
    },
  }));
}

const input = readInput();
if (input != null) {
  const marker = markerPath(input);
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';
  const action = actionFor(input);

  if (event === 'SessionEnd') {
    if (marker != null) rmSync(marker, { force: true });
  } else if (action === 'off') {
    if (marker != null) rmSync(marker, { force: true });
  } else {
    if (action === 'on' && marker != null) {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, 'enabled\n', 'utf8');
    }
    // Claude's command expansion already loads the host skill for its current
    // turn. Returning context there as well would duplicate the whole policy.
    // Codex has no expansion event, so its activation happens here and needs
    // the developer-context reinforcement immediately.
    const active = action === 'on' || (marker != null && existsSync(marker));
    if (active && event !== 'UserPromptExpansion') emitContext(event);
  }
}

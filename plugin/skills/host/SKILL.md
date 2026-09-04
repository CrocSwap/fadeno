---
name: host
description: Activate session-scoped Fadeno host-coordinator mode. Use only when the user explicitly invokes host mode; never activate it implicitly for an ordinary task. [fadeno 0.6.1]
---

# Fadeno Host Mode

If the invocation argument is exactly `off`, host mode is disabled for this
session. Acknowledge that briefly and do not apply the policy below.

Otherwise, host mode is enabled for this session. If the invocation includes a
task after the skill name, begin that task under the policy below. If it includes
no task, acknowledge activation briefly and wait for the user's next request.

## Host coordinator policy

Operate as the root host coordinator. Your primary job is to decompose, route,
monitor, and integrate work through Fadeno.

- For complex tasks, independent workstreams, specialist review, or work that
  benefits from recorded verification, prefer Fadeno playbooks and routed
  archetypes. Parallelize independent work when the expected latency or quality
  benefit outweighs dispatch overhead and merge-conflict risk.
- Prefer Fadeno's skills, engine, and routed archetypes over unmanaged use of
  generic harness subagents. Native host subagents remain appropriate when
  Fadeno selects a host lane or no suitable Fadeno path exists.
- Perform small, local, low-risk changes directly when delegation would cost
  more than the work itself.
- Retain host responsibility for decomposition, user decisions, integration,
  verification, and the final report. Do not forward this coordinator policy to
  worker, reviewer, judge, or command-executor prompts.
- Fadeno is in beta. When concrete friction attributable to Fadeno occurs,
  append it to `./.fadeno/feedback.md` with the date, host, task, observed
  behavior, evidence, impact, and workaround when known. Do not invent
  feedback. Delegated agents report friction to the host; the host alone edits
  the feedback file so parallel workers do not race on it.

The plugin hook reinforces this policy on later prompts and after compaction.
Do not create or modify `AGENTS.md` or `CLAUDE.md` to activate host mode.

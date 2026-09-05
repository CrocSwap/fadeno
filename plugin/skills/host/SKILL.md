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

The user explicitly enabled Fadeno host mode for this root session. Operate as
the host coordinator: decompose, route, monitor, and integrate work through
Fadeno.

- For complex tasks, independent workstreams, specialist review, or work that
  benefits from recorded verification, prefer Fadeno playbooks and routed
  archetypes. Parallelize independent work only when its expected latency or
  quality benefit outweighs dispatch overhead and merge-conflict risk.
- Route delegated work through Fadeno's skills, engine, and routed archetypes.
  The managed role agents (`worker`, `reviewer`, `judge`) are the host lane.
  Generic native subagents are refused while host mode is on (both plugins
  enforce this); `off` lifts that.
- Perform small, local, low-risk changes directly when delegation would cost
  more than the work itself.
- The host retains responsibility for decomposition, user decisions,
  integration, verification, and the final report. Do not forward this
  coordinator policy to workers, reviewers, judges, or command executors.
- Fadeno failing is a user-facing event, not a routing problem to solve
  quietly. The user enabled host mode expecting Fadeno delegation to work, so a
  failure of that system stops the work and goes to the user first: a dispatch
  that is refused, fails, times out, or returns nothing; a resolver that
  errors; a role agent that cannot be spawned or is refused for drift; an
  executor that cannot run the checks it was asked to run; a workspace lease
  that will not clear.
- Report it in the reply, not only in the feedback file, with the dispatch id
  or ledger row, the error text, and what you intend to do next. Never
  substitute a generic native subagent, a different model, or your own hands
  for delegated work without the user's explicit go, and when you propose a
  fallback say what it runs on and what it costs. A feedback entry records the
  friction; it does not authorize working around it.
- While dispatches are live, every reply names what is running, waiting,
  failed, and completed, with the model and lane of each, so a substitution
  cannot hide inside a progress summary.
- Fadeno is in beta. When concrete friction attributable to Fadeno occurs,
  append it to `./.fadeno/feedback.md` with the date, host, task, observed
  behavior, evidence, impact, and workaround when known. Do not invent
  feedback. Delegated agents report friction to the host; the host alone edits
  the feedback file. Parallel workers must not race on it.

The plugin hook reinforces this policy on later prompts and after compaction.
Both plugins enforce the generic-subagent refusal in a `PreToolUse` hook, and
every refusal those hooks write ends with the sentence
`Report this refusal to the user instead of routing around it.` — that is an
instruction to you: say what was refused, with its predicate and the model it
would have run on, and let the user decide, rather than retrying the same work
by another route.
Do not create or modify `AGENTS.md` or `CLAUDE.md` to activate host mode.

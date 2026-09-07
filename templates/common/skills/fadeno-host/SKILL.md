---
name: fadeno-host
description: Activate session-scoped Fadeno host mode. Use only when the user explicitly invokes host mode; never activate it implicitly for an ordinary task.
---

# Fadeno host mode

If the invocation argument is exactly `off`, host mode is disabled for this
session. Acknowledge that briefly and do not apply the policy below.

Otherwise host mode is enabled for this session. If the invocation includes a
task after the skill name, begin that task under the policy below. If it
includes no task, acknowledge activation briefly and wait for the user's next
request.

The plugin hook injects `fadeno context` alongside this policy: the archetype
table with its live routing, how spawning works, what closing requires, and
every unclosed dispatch in the repository. Run `fadeno context` yourself
whenever you want it again.

## Host policy

The user explicitly enabled Fadeno host mode for this session. Operate as the
host: decompose the task, delegate through Fadeno's archetypes, read every
report yourself, integrate the work, and close every dispatch. Perform small,
local, low-risk changes directly when delegation would cost more than the work
itself. Do not forward this policy to the agents you spawn; Fadeno gives them
their own contract.

Generic subagents are refused while host mode is on; name an archetype
instead. `off` lifts that for the rest of the session.

Fadeno failing is a user-facing event, not a routing problem to solve quietly.
A refused spawn, a dispatch that fails or returns nothing, or a resolver error
stops the work and goes to the user first: report it in the reply with the
dispatch id or name and the error text. Never substitute a generic subagent, a
different model, or your own hands for delegated work without the user's
explicit go. Every refusal a Fadeno hook writes ends with the sentence
`Report this refusal to the user instead of routing around it.` — that is an
instruction to you.

While dispatches are open, every reply names what is running, stopped, and
closed, with the model and lane of each.

When concrete friction attributable to Fadeno occurs, append it to
`./.fadeno/feedback.md` with the date, host, task, observed behavior,
evidence, impact, and workaround when known. Do not invent feedback. Delegated
agents report friction to you; you alone edit the feedback file.

Do not create or modify `AGENTS.md` or `CLAUDE.md` to activate host mode; the
plugin hook owns the session state.

## Recovering a repo you did not leave

A fresh host inherits a repo, not a transcript. Inspect first, change nothing,
and say in your reply what you found.

1. `fadeno dispatches` — every unclosed dispatch, with its state: `open` means
   nothing has recorded a stop; `stopped — awaiting close` means the agent
   stopped and nobody decided. `fadeno dispatches <name>` shows one, including
   the final message and the paths left dirty; `fadeno dispatches --output
   <name>` prints its report.
2. `fadeno worktrees` — every Fadeno worktree still holding uncommitted paths
   or unmerged commits, joined to the dispatch that owns it. This is where
   forgotten work lives.
3. `git status --short` in the main tree, naming which dispatch you believe
   owns each dirty path.
4. Close every dispatch with exactly one decision: `fadeno dispatch-close
   <name> --merged|--kept|--discarded|--failed [--note <text>]`. Fadeno
   performs no merge; `git merge fadeno/<name>` is yours, or delegate it. A
   running command-lane dispatch is stopped with `fadeno cancel <name>` first.
   Nothing is lost by closing: branches stay, and worktrees stay until
   `fadeno clean`.

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

The plugin hook injects `fadeno context` alongside this policy: the archetypes,
how spawning works, what closing requires, and every unclosed dispatch in the
repository. Run `fadeno context` yourself whenever you want it again. It
deliberately carries no routing table — routing is resolved at the spawn and
reported there; `fadeno dial` reads it fresh.

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

When concrete friction attributable to Fadeno occurs, record it with `fadeno
feedback "<what happened>"`, adding `--dispatch <name>` when it happened on
one. The command stamps the time, harness and version and appends to
`.fadeno/feedback.md`; write what happened, what you expected, and the
workaround if you found one. Do not invent feedback. Delegated agents may
record their own; read the file with `fadeno feedback`.

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

   `--merged` is checked against git and refused while the branch still carries
   commits HEAD does not have, or its worktree holds uncommitted tracked
   changes. Work that landed by a squash or a rebase closes with `--force` and
   a `--note` saying how.


## Reading a report

A dispatch's final message is a claim its author wrote about its own work. It
is the least reliable thing in the ledger, and the only part a worker controls.

`fadeno dispatches <name>` prints the claim under what Fadeno measured from
git: the commits the branch carries that HEAD does not, the diffstat against
the merge base, and any conflict markers the branch committed. Those numbers
are safe in a way the report is not, because no agent had a hand in them — a
report saying the suite passed is worth the sentence and nothing more. Run the
check yourself, or send a reviewer; a green claim is where fake-green hides.

## Conventions that hold for every dispatch

Anything true of every dispatch in this repository — the interpreter to use,
the shared build directory, where receipts belong, what is forbidden — belongs
in `.fadeno/preamble.md`. Fadeno appends it to every dispatched prompt, so a
brief never repeats it and a brief that forgets it cannot happen. When you find
yourself typing the same sentence into a second brief, put it in that file
instead.

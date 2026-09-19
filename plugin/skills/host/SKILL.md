---
name: host
description: Activate session-scoped Fadeno host mode. Use only when the user explicitly invokes host mode; never activate it implicitly for an ordinary task. [fadeno 0.7.0]
---

# Fadeno host mode

If the invocation argument is exactly `off`, host mode is disabled for this
session. Acknowledge that briefly and do not apply the policy below.

Otherwise host mode is enabled for this session. If the invocation includes a
task after the skill name, begin that task under the policy below. If it
includes no task, acknowledge activation briefly and wait for the user's next
request.

On Codex, first reconcile the user-scoped archetype vocabulary. Resolve the
CLI exactly as the setup skill does: use `scripts/fadeno.cjs` beside this file
when present (invoke it with `node` on Windows), otherwise use `fadeno` from
`PATH`. Run:

```text
<cli> setup --codex --agents-only
```

This is an idempotent first-use check, not a general setup: it does not link a
CLI, probe providers, or edit another harness's settings. Tell the user what it
reports. If it reconciled any file, Codex will expose the archetype names only
in the next fresh session; use explicit `fadeno dispatch` command-lane calls
for any delegation that must happen in the current session. If it refuses
because a same-named user agent already exists, report the path and stop rather
than overwriting or routing around it. Claude already ships its agent
vocabulary with the plugin, so do not run this operation there.

The Codex files are names and descriptions only. They never contain a model or
reasoning effort: dials resolve live at every spawn. A dial change therefore
needs no bootstrap or fresh session; a plugin upgrade may reconcile the stable
archetype vocabulary or its file format.

Before every Codex archetype spawn, stage the exact task so Fadeno can record
it even when Codex encrypts the spawn message. Use the resolved `<cli>` from
the setup instructions, save the task in a file, and run `<cli> prompt-stage
--name <semantic-name> --prompt-file <file> --json` (or pipe it to `<cli>
prompt-stage --name <semantic-name> --json`), then put the returned `task_name`
on the spawn exactly. The name becomes a readable lowercase slug plus an
opaque lowercase token; keep the whole returned value unchanged. The handoff
is one-use and expires after ten minutes. A readable prompt still works
without staging for older Codex versions, but staging every task makes the
workflow deterministic.

Codex native subagent threads have a runtime concurrency limit; command-lane
processes do not consume native slots. Keep the host lane for interactive work
and use the command lane for planned overflow or broad fan-out. If a correctly
routed Codex spawn fails before opening with `agent thread limit reached`, retry
the identical archetype, model, effort, prompt, and worktree policy through a
direct `<cli> dispatch` command, carrying the same `--model <model>@<effort>`
ref and the same shared/worktree options. Do not substitute a model. Run that
command through a managed foreground shell; never detach it with `nohup` and
never manually invoke the executor argv. If the shell call yields while the
dispatch continues, use `<cli> dispatch-wait <name>` as documented. A native
capacity refusal happens before a dispatch exists, so if `--dispatch` cannot
resolve the attempted name, record repository-level friction with `<cli>
feedback "<what happened>"` and omit `--dispatch`.

An empty initial tool chunk with a live session id is not a silent launch: the
foreground command is still running, possibly while dispatch preparation
resolves routing, cuts the worktree, or starts the executor. Continue the same
managed session and read its later chunks; do not launch a duplicate dispatch.
Only retry after that session ends with a refusal or failure.

When a follow-up should start from a retained dispatch, pass its ledger name or
id as `--from <name|id>`; Fadeno resolves that only to the dispatch's reachable
isolated branch. It never substitutes the opening base, and a shared-tree
dispatch has no attributable retained result. If the branch/result is
unavailable, commit the desired state and pass that Git ref or commit SHA.
Existing Git refs and commit SHAs also work. If a value matches both a dispatch
reference and a Git ref, qualify the Git ref (for example `refs/heads/main`) or
use the dispatch's full UUID; an exact name that is another dispatch's id prefix
also requires the full UUID. An invalid explicit baseline is refused, and an
isolated worktree failure never falls back to the shared tree. `--shared` and
`--from` are incompatible; the shared-tree fallback is only for an omitted
`--from` when the environment cannot create a worktree.

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

A command-lane process liveness echo is an operational stderr signal from the Fadeno launcher, not a user-facing host progress update. Report host progress only when something materially changes. If no material change occurs during a long-running dispatch, a five-minute check-in is the maximum useful cadence; there is no heartbeat when no dispatch is in flight. In the Codex desktop app, when its thread heartbeat/scheduled follow-up facility is available, prefer that nonblocking mechanism for monitoring long-running dispatches so the user can continue prompting. Keep the scheduled check quiet when dispatch state is unchanged, and end it when no dispatch remains in flight. This is host behavior using the app capability; Fadeno itself cannot call a Codex app API. Outside an environment with scheduled thread heartbeats, do not hold a foreground assistant turn open solely to emit chat updates. The managed foreground shell requirement for the command launcher itself remains unchanged.

The command lane has no live inbox or mid-run messaging. Do not try to send it a follow-up or steer it while it runs; put requirements in the original prompt. To change course, let it stop, read the complete report with `fadeno dispatches --output <name>` (or `fadeno dispatch-wait <name>` while waiting), then start a new dispatch with a new prompt. Use `--from <name|id>` only when stopped work has a retained isolated branch; a shared-tree dispatch cannot provide a follow-up baseline. `fadeno dispatches <name>` may show only a bounded ledger preview, never the complete command-lane report.

Never close the dispatch you are currently running in: it must return its
report, and its caller/host closes it. Only close dispatches you opened — for a
director, these are child dispatches — after reading their reports.
`dispatch-wait` treats only a `stopped` row as report-ready, so a close-only
command dispatch may still be running or waiting for its launcher to settle.

After a Fadeno host agent returns a final response, inspect its dispatch. If it
is still `open`, or if it is `awaiting close` with worktree inspection pending,
save the already-received final response to a file and replay the idempotent
stop with `fadeno dispatch-stop <name|id> --message-file <path>`; then inspect
the report and close it normally. Stdin remains supported for a one-shot
invocation, but a live two-process pipeline is not the default recovery path.
The stop hook's durable receipt makes this replay safe even when its optional
worktree inspection was interrupted.

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
   nothing has recorded a stop; `awaiting close` means the agent
   stopped and nobody decided. `fadeno dispatches <name>` shows one, including
   the final message and the paths left dirty; `fadeno dispatches --output
   <name>` prints its report.
2. `fadeno worktrees` — every Fadeno worktree still holding uncommitted paths
   or unmerged commits, joined to the dispatch that owns it. This is where
   forgotten work lives.
3. `git status --short` in the main tree, naming which dispatch you believe
   owns each dirty path.
4. Close every dispatch with exactly one decision: `fadeno dispatch-close
   <name> --merged|--kept|--discarded|--failed|--reviewed [--note <text>]`. Fadeno
   performs no merge; `git merge fadeno/<name>` is yours, or delegate it. A
   running command-lane dispatch is stopped with `fadeno cancel <name>` first.
   If cancel reports that the Codex app sandbox denied the signal or that its
   launcher did not consume the cooperative request, the process is not
   cancelled and no stopped row was claimed. Rerun the cancel command with
   unsandboxed/elevated command permission; do not close or report the
   dispatch as stopped while its process group remains alive.
   Nothing is lost by closing: branches stay, and worktrees stay until
   `fadeno clean`. A clean, readable stopped worktree may also be cleaned
   before its dispatch is closed; open/running, dirty, unreadable, and
   unregistered paths remain protected.

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

## Optional model observations

When discussing model performance or choosing a dial, consult
`.fadeno/model-notes.md` in the main repository if it exists. This is an
optional Markdown notebook for workload-specific observations and user
preferences. Its contents are not loaded automatically into dispatch prompts
and do not change routing.

You may create or update it when a user discusses a result or a useful pattern
emerges. Dispatch completion creates no update obligation; an absent or empty
file is normal. There is no required schema, score, or entry per dispatch.

Keep notes concise and specific to the workload. When useful, include the date,
archetype, actual model and effort, what worked or needed correction, and a
representative dispatch name. Distinguish observed results from hypotheses and
user preferences; do not turn one attempt into a universal model ranking.
Revise or qualify earlier observations as evidence changes. Keep these notes
in the main repository's `.fadeno/`, outside `.fadeno/local/`, so scratch
cleanup preserves them.

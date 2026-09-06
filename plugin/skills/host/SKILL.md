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
- A `fadeno drive` you launched is yours until it exits. Do not end your turn
  while it is still running unless the user asked you to hand it off; if you
  background it, poll it and report each stop. When it stops with
  `needs_decision`, the next thing you say is the gate: the question, the
  options, the decision id, and how long it has been waiting.
- When an earlier `fadeno drive` of a run bound a role with `--bind`, repeat
  that flag on every later drive of the run (the engine refuses to start new
  work for that role otherwise, and `--unbind <role>` releases it), and say in
  the reply which bindings each drive carried.
- Coordinator steps of a run (a plan, a contract, a final summary) are yours to
  fulfil in this session by default: they need the context you already hold
  about the task, the codebase, and where parallel work could collide. Delegate
  a coordinator step to another model only when producing the design itself is
  the work, and say so.
- When a delegated agent stops without a terminal receipt — a session limit, a
  429, a killed harness — the standard recovery is to **resume each stopped
  agent by its id** rather than re-dispatching it. A resumed agent comes back
  onto its own transcript and finishes what it started; a fresh dispatch starts
  from nothing and puts a second implementer on the same tree. Before resuming,
  run `fadeno dispatches` and `git status --short`, and say in your reply which
  files are dirty and which agent you believe owns them — uncommitted edits with
  no named owner are the actual cost of a mid-flight kill.
- A command dispatch that cannot be reached is retired, not left open.
  `fadeno dispatches --cancel <id|tag:<tag>>` signals a live executor and
  refuses when there is none — correctly, since it will not claim to have
  cancelled work it never touched. When it refuses that way, check the
  workspace, then record the terminal receipt with
  `fadeno dispatches --withdraw <id|tag:<tag>> --reason <text>`, adding
  `--work-left <path>` when the tree still holds the dispatch's edits. Until
  that receipt exists the dispatch reads as potentially live to you and to
  everyone after you.
- Two implementers must not share one tree. When a second implementation
  dispatch would overlap a live one, isolate it (`fadeno dispatch --isolate`,
  or `fadeno dispatch-prepare --isolate` on the host lane) rather than letting
  both write the same working copy. A Bash `PreToolUse` hook refuses the
  destructive git subcommands (`checkout`, `switch`, `restore`, `reset`,
  `stash`, `clean`) inside the managed `worker`, `reviewer` and `judge` agents,
  but that guard is **partial and must not be relied on**: it identifies role
  agents by `agent_type`, so a role brief you hand to a plain `claude`-type
  subagent is not covered, Codex-hosted agents are not covered at all, and it
  reads shell text without being a shell. Isolation is the protection; the hook
  only catches the reflex.
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

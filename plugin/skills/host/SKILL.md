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
- Ad-hoc parallel work does not need a playbook run to get isolation and
  receipts on the host lane. `fadeno dispatch-open [--archetype <a>] [--tag
  <handle>]` cuts a worktree from HEAD with your uncommitted state replayed
  into it, mints a dispatch id, and prints the workspace path; spawn your
  in-session agent with that directory as its working tree, then
  `fadeno dispatch-close <id|tag:<handle>>` collects the agent's diff, merges
  it back, and writes the terminal receipt (`--reason <text>` records a FAILED
  receipt and merges nothing; `--no-merge` keeps the diff for you to apply).
  Reach for the command lane only for what it alone gives — `--diagnostics`, or
  a shadow pair. An ad-hoc host dispatch has no run ledger, so `fadeno verify`
  is not its auditor: `fadeno dispatches` is where it and its receipt appear.
- Two implementers must not share one tree. When a second implementation
  dispatch would overlap a live one, isolate it (`fadeno dispatch --isolate`,
  or `fadeno dispatch-open` / `fadeno dispatch-prepare --isolate` on the host
  lane) rather than letting both write the same working copy. A Bash `PreToolUse` hook refuses the
  destructive git subcommands (`checkout`, `switch`, `restore`, `reset`,
  `stash`, `clean`) inside the managed `worker`, `reviewer` and `judge` agents,
  but that guard is **partial and must not be relied on**: it identifies role
  agents by `agent_type`, so a role brief you hand to a plain `claude`-type
  subagent is not covered, Codex-hosted agents are not covered at all, and it
  reads shell text without being a shell. Isolation is the protection; the hook
  only catches the reflex.
- An isolated worktree is cut with `git worktree add`, which checks out
  **tracked content only**, so a gitignored build environment — `node_modules`,
  `.venv`, `target`, `vendor` — is not in it. An agent that lands there cannot
  run the repo's own gate, and what it usually does instead is run a weaker one
  and finish successfully: a terminal `ok` receipt over validation that
  degraded from the full suite to a smoke test. **Do not infer correctness from
  exit 0** when the environment may not have travelled. Declare what must
  travel, once, in project scope — `worktree_carry: ["node_modules", ".venv"]`
  in `.fadeno/executors.yaml`. Each declared path is copied into every
  freshly-cut worktree before the executor starts, and a declared path that
  exists and cannot be carried refuses the dispatch rather than running it
  against an incomplete checkout. `fadeno doctor` reports the directories it
  actually found and prints the exact line to paste, and a command-lane
  isolated receipt records `worktree_carry_absent` naming what did not come
  along. **The host lane does not carry anything**: a worktree from
  `fadeno dispatch-open` or `fadeno dispatch-prepare --isolate` gets tracked
  content only, declaration or no declaration, so before you believe a host
  agent's verification, confirm the check it names could actually run there.
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

## Recovering a repo you did not leave

A fresh host inherits a repo, not a transcript. Everything in step 1 reports
and changes nothing; do it first, and say in your reply what you found.

1. **Inspect.**
   - `fadeno dispatches` — every dispatch the ledger holds, command, host and
     runless, with its receipt.
     `no completion recorded (killed or in flight)` is a row with no
     terminal receipt: the thing to close. `WITHDRAWN … [work left at <path>]`
     is one already retired, and that path is where its edits are. `--json`
     for whole rows.
   - `fadeno show <run>` — actors, workspace modes, `concurrent_write`
     overlaps, discarded output, and — only in a repo upgraded mid-flight — a
     leftover writer-lease row. All non-gating.
   - `fadeno verify <run>` — recomputation, plus the two `warn` findings it
     can raise but not adjudicate: `concurrent-writes` and `discarded-output`.
     A `warn` never fails the run; it means the run STATED something you have
     to act on.
   - `fadeno doctor` — persisted state, including `workspace-lease` and
     `persisted-state:host-workspace-state` for `.fadeno/local/host-workspaces`.
   - `git status --short` — and name which dispatch you believe owns each
     dirty file.

2. **Give every open dispatch a terminal receipt.** Until it has one it reads
   as potentially live to you and to everyone after you.
   - Command lane: `fadeno dispatches --cancel <id|tag:<tag>>` first. It
     signals a live executor and refuses when there is none — correctly. After
     that refusal, `fadeno dispatches --withdraw <id|tag:<tag>> --reason
     <text> [--work-left <path>]` records the receipt. Withdraw signals
     nothing and removes no workspace, and is itself refused while any process
     behind the claim is alive, so cancel really is first. `--work-left` is
     recorded and never touched: it is how the next reader finds the surviving
     edits without a transcript.
   - Host request minted by the engine and never started:
     `fadeno dispatch-withdraw <run> <dispatch-id> --reason <text>`. After
     `dispatch-start` it is `dispatch-fail` instead.
   - Runless host dispatch: `fadeno dispatch-close <id|tag:<handle>|last>
     [--reason <text>] [--no-merge]`. `--reason` records FAILED and merges
     nothing; the worktree is removed only when the work landed in your tree,
     and every other ending retains it and says where.

3. **Orphaned workspace records.** There is no repo-wide writer lease any
   more: `fadeno doctor` reports `workspace-lease: no leftover writer lease
   (Fadeno no longer takes one)`, and a file it does find is a leftover from
   an older version that gates nothing — delete it, with work in flight too,
   since nothing consults it and there is no writer to verify first. Host
   workspace state is one file per dispatch under
   `.fadeno/local/host-workspaces`, audited by `doctor`; a stale one is
   removed, never migrated. A retained worktree under `.fadeno/local` is work
   product, not litter: `fadeno clean` previews, and `fadeno clean --force`
   deletes `.fadeno/local`, `.fadeno/runs`, `.fadeno/progress` and
   `.fadeno/dispatches.jsonl` — the ledger you were just reading included. Run
   the preview, copy out what you still need, then force.

4. **Output that is not in your tree.** An isolated worktree merges back
   through `git add -A`, which RESPECTS `.gitignore`, so anything written at a
   gitignored path was staged by nothing and died with the worktree.
   Command-lane deliveries record it as `ignored_output_discarded`, and it
   reaches you three ways: a `discarded-output` warning from `fadeno verify`,
   a row on `fadeno show`, and a banner printed in-band ahead of the bytes on
   `fadeno dispatches --output` — in-band because a report saying "wrote the
   analysis to `data/research/`" is describing files that are not there. A
   shadow challenger's worktree is retained, so its discarded output is still
   on disk (`[still on disk at <path> until fadeno clean]`) and can be copied
   out; a primary's worktree is torn down, so its output is gone. The lever
   for next time is `ignored_output: kept` on the archetype, or
   `fadeno dispatch --ignored-output kept`, which makes the kernel run it SHARED
   rather than isolate it — containment and any shadow pair are given up on
   purpose, to protect the output.

5. **Overlapping writes.** Nothing prevents two writers now; overlaps are
   detected instead. A delivery whose changed paths intersect another
   delivery's window carries a `concurrent_write` stamp, raised by `fadeno
   verify` as `concurrent-writes` and projected per receipt by `fadeno show`.
   It is an attestation, not an accusation: `attribution: workspace` means the
   paths are a shared tree's delta over the window and include whatever anyone
   else did in the same minutes, and granularity is per path, not per hunk.
   **It under-reports for host deliveries** — a host delivery closes its
   window with an empty path set, so it carries no stamp of its own and
   nothing intersects it after it closes; only the time overlap survives, as a
   `pending` stamp on the other side. A clean `concurrent-writes` finding is
   not evidence that no host delivery overlapped yours.

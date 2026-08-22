---
name: fadeno-driver
description: Drive a Fadeno run ledger end-to-end — engine-first via `fadeno drive`, with a manual `fadeno next` loop for steps the engine can't execute. Use when the host hands you a run id to drive or resume, or when coordinating multi-harness roles without host nested subagents.
---

# Fadeno Driver

Resolve the CLI first: when `scripts/fadeno.cjs` exists beside this `SKILL.md`, use
that plugin-bundled launcher for every command written below as `fadeno`
(invoke it with `node` on Windows).
Otherwise use `fadeno` from `PATH`. Never prefer an unrelated global CLI over
the plugin launcher. Before driving, call `<cli> status`; if the current
harness is not installed, invoke the setup skill first. Use the path status prints on the `use:` line for the rest of the session. Skills and subagents are loaded at host session start; a fresh session is required to refresh them — no setup or refresh will update the current session.

You own a **run ledger** and advance it mechanically. The host harness stays pure:
it picks a playbook, gathers inputs, creates the run (`fadeno new-run`), and
dispatches you with the run id.

You never invent control flow. The **engine** (`fadeno drive`) owns transitions
where it can; the manual loop (`fadeno next` + `fadeno prompt | <harness>`) covers
what it can't. Gates are always `fadeno gate`. Fadeno's engine invokes
executors from the effective bundled → user → project catalog; in the manual
loop, *you* do the dispatch. A project `.fadeno/executors.yaml` shadows
bundled entries, while dials (session → repo pin → user dial → host-native
base) select the model per archetype.

Load the runner's `references/runtime.md` for primitive semantics (see
`references/README.md` for install paths). This skill adds the **drive/fallback
procedure**, **harness mapping**, and **pause/resume**.

## Procedure

1. Confirm you have a **run id**. If the host only gave a task/playbook, create
   the run first: `fadeno new-run <playbook> "<task>"`, then continue with that id.
2. **Engine first:** run `fadeno drive <run>` (the bundled plugin runtime works
   without `.fadeno/` definitions) and act on its exit state:

```
fadeno drive <run>
  terminal (completed|failed|aborted):
    return final summary (what changed, gates, run path)
  paused_human_gate:
    return to host { question, decision_id, options, run } and EXIT
    # host resolves with: fadeno decide <run> <option>   then re-dispatches you
  needs_decision:
    the cursor hit a step/condition the engine can't execute —
    handle THAT step manually (below), then re-run fadeno drive
  executor_failed / output_invalid:
    report honestly; the user may re-run drive (retry) or substitute:
    fadeno drive <run> --bind <role>=<executor>     # recorded as evidence
  awaiting_host_dispatch:
    for each host request, optionally prepare an isolated worktree first: `fadeno dispatch-prepare <run> <dispatch-id> --isolate` (creates `.fadeno/local/host-worktrees/<run>/<dispatch-id>` from HEAD, workspace_mode: isolated, idempotent, traversal/symlink-safe, serialized by `.host-workspace.lock`; without it, delivery is workspace_mode: shared)
    emit each assignment with `fadeno dispatch-prompt <run> <dispatch-id>` — it writes the exact `# Fadeno engine step assignment` envelope (immutable `run` + `dispatch_id` plus the recorded prompt bytes) without manual reconstruction; when prepared, the envelope includes `workspace_mode: isolated` plus the absolute workspace path and `All repository reads and writes for this assignment must occur in the workspace above; do not read or modify the shared checkout.` (prompt bytes and digest unchanged)
    start each host agent with `fadeno dispatch-start <run> <dispatch-id> --agent-id <id>` — when prepared it stamps `workspace_mode: isolated`/`workspace`/`base_commit` and bypasses the shared writer lease; otherwise `workspace_mode: shared` with existing exclusive leasing byte-for-byte unchanged (read-only `writeAccess === false` bypasses in either mode); `--workspace` must match or be omitted, and `command-fallback` with a prepared isolated workspace is refused
    poll the prompt-declared progress sidecar and record dispatch-progress
    submit dispatch-complete or dispatch-fail (for isolated, a binary staged diff is collected to `.fadeno/local/outputs/host-isolated-<run>-<dispatch-id>.diff` before the terminal receipt, stamping `workspace_mode`/`workspace`/`base_commit`/`diff_snapshot`/`diff_bytes`; worktree removed only after durable receipt, failures preserve it for retry, idempotent terminals reuse receipt; nothing auto-merges), then re-run drive
```

Independent command-delivered `map` members need not serialize: `fadeno drive
<run> --parallel <n>` (1-16, default 1) runs eligible members concurrently
within one ready wave. In a git repo each member runs in its own detached
worktree and merges back on success, so members overlap whatever they write;
without git they share the tree and serialize on the repo-wide writer lease.
Receipts keep canonical member order either way.

For compositional maps, one drive result may contain ready leaves from different
members or loop generations. Dispatch every returned request and preserve its
`node_instance_id`; do not merge member loops into a batch-wide loop.

   The engine snapshots the executor profile into the run, mints attempt
   ordinals and execution ids, validates typed outputs (one bounded schema
   repair), and records every dispatch — do not duplicate its work by hand.
   Progress observations are provenance-labelled attestations only; never use
   them to choose a control-flow branch or satisfy a gate.

3. **Manual loop** (no executor profile, or for the one step drive handed back):

```
loop:
  N = fadeno next <run>                      # parse JSON
  case N.status:
    terminal:
      fadeno run <run> --status <N.terminal.status>   # if not already terminal
      return final summary
    blocked_human_gate:
      return to host { question: N.human_gate.prompt, step: N.step.id, run }
      # do NOT auto-approve; exit so the host can ask the user
    needs_decision:
      resolve the branch per runtime.md; record the decision on the ledger;
      continue
    ready:
      if N.step.promptable:
        for actor in (N.step.actors or [single]):
          fadeno run <run> --step <N.step.id>   # once per step entry (not per actor)
          fadeno prompt <run> <N.step.id> --actor <actor> | <harness(actor)>  > <tmp>
          # capture the returned body bytes; the director writes them to N.step.outputs[i]
          # (or the path prompt recorded); artifact_created hashes and schema-checks them
          fadeno run <run> --event artifact_created --artifact <output> --member <actor>
        if N.step.collective:
          merge member JSON objects into one JSON array at N.step.collective
          fadeno run <run> --event artifact_created --artifact <N.step.collective>
      elif N.step.kind == "gate" or (N.step.kind == "loop" and N.gate):
        fadeno run <run> --step <N.step.id>
        fadeno gate <run> <N.gate.condition> --artifact <N.gate.artifact>
        # for loops: also record loop_condition_evaluated with the same result
        if N.step.kind == "loop":
          fadeno run <run> --event loop_condition_evaluated \
            --field condition=<N.gate.condition> \
            --field result=pass|fail \
            --artifact <N.gate.artifact>
      else:
        for tool_call (output is test-result and tool is registered in executors.yaml tools): run
          fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]
          # synthesizes TestResult (passed/failed/error), validates, and attributes atomically via the shared execution core (same code as drive)
        for other tool_call (Diff/PostResult or unregistered): invoke the tool manually, write its output, then run
          fadeno tool-complete <run> --output <artifact-path>
          # typed output is validated atomically before step/artifact events append; manual and automated are mutually exclusive per generation
        handle join / … per runtime.md; record; continue
```

4. **Honor loop iteration starts** (manual loop only — drive does this itself).
   When `N.advice` says to record `loop_iteration_started`, do that before
   prompting body steps:
   `fadeno run <run> --event loop_iteration_started --field iteration=<n>`
   with `current_step` pointing at the loop (or pass `--step <loopId>`).
5. **Never overwrite** iteration artifacts; generation paths come from
   `fadeno prompt` / `N.step.outputs` (`.v<G>`, G = N + 1). Retire an artifact
   only by supersession (`--event artifact_superseded`), never deletion.
6. On `terminal`, set status if needed and return: what changed, checks/gates,
   terminal status, run path.

## Role → executor mapping

Engine path: bindings live in `.fadeno/executors.yaml` (executors + role
bindings; `"*"` is the default). Playbooks stay semantic — no harness names in
role prose. Substitution is explicit and recorded:
`fadeno drive <run> --bind <role>=<executor>`.

Executors are **memoryless one-shot commands by default**. An executor that
declares `resume` keeps one harness session per role per run (`claude -p
--session-id/--resume`, `codex exec resume`); the engine records
`session: fresh|resumed` + the session id on every dispatch and on the
artifacts it produces, and `verify` checks the continuity chain. Prefer
memoryless unless the role genuinely needs cross-step memory — resumed
context is attested, not recomputable.

Manual fallback map (override with playbook role purpose hints or host policy):

| Role pattern | Command |
|---|---|
| `architect_sol`, names containing `sol`, or purpose mentions Codex/Sol | `codex exec -` (add `-m <model>` when the role names one) |
| everything else | `claude -p` |

Keep it dumb: the point is one provenance story, not smart routing. Pipe prompt
text on stdin; capture stdout as the body and let the director write it to the
planned artifact path.

## Host ↔ driver handoff (pause / resume)

- **Launch.** Host: `fadeno new-run <playbook> "<task>"` → dispatch this skill
  with the run id. Host session is free.
- **Pause.** On a human gate, return `{question, decision_id, options, run}` and
  **exit**. State is entirely on disk — nothing lives in the subagent session.
- **Resume.** Host asks the user, then records the durable decision:
  ```
  fadeno decide <run> approve            # or reject; idempotent, conflict-safe
  ```
  (manual-loop runs may instead record
  `fadeno run <run> --step <step> --event human_decision --field branch=approve`)
  then re-dispatches this skill with the same run id. The cursor sees the
  decision and advances.

## Executor deadlines and cancellation

- **No deadline by default.** An executor runs until it exits. Agent work has
  a long tail, and a clock cannot tell slow from stuck — the committed catalog
  used to kill every command route at 20 minutes, and on 2026-08-22 that
  killed a legitimate implementation pass and two of six reviews. What an
  isolated executor holds while it runs is its own worktree and nothing else
  (no lease, no shared tree), so the cost of a hung one is a directory and the
  provider's bill, and the decision to end it belongs to whoever can look at
  the work: watch it with `fadeno show` (the `WARNING: no output observed for
  <duration> (non-gating)` line is a report, never a trigger) and end it with
  `fadeno cancel <run>` or `fadeno dispatches --cancel <id|tag>`. A `drive`
  wave waits for every member, so a hung member holds the run until you act.
  A deadline is opt-in: `timeout_ms` on a route, or `--timeout <seconds>` on
  `fadeno drive` / `fadeno dispatch` (`0` also means none). When one is set
  the supervisor owns it — `SIGTERM` to the executor group at `deadline_at =
  started_at + timeout_ms`, `SIGKILL` after 5 s, lease and claim released only
  on `close` — and the attempt records `actor_failed.reason =
  "executor_timeout"` (engine) or `dispatch_completed.outcome = "timeout"`
  (ad-hoc), which outranks the exit signal. The recovery reader carries the
  verdict with the bytes: `fadeno dispatches --output <id|tag:handle>` leads
  its stderr note with `ok`, `FAILED`, `NO OUTPUT`, or `TIMED OUT` (and any
  merge-back that did not land) *before* the attestation line. `output
  attested` only says the snapshot's bytes are the ones the completion row
  hashed — a killed executor attests perfectly with zero bytes, and is not a
  result.

- **Merge conflicts are resolved on the branch.** Each isolated attempt runs
  in its own worktree and merges back with a plain `git apply`; if the
  workspace moved meanwhile the kernel rebases the worktree onto it first.
  When the rebase conflicts, the attempt fails as `merge_conflict` and the
  executor is re-invoked in its *retained* worktree — a new attempt with
  `attempt_reason: merge_conflict`, the conflicting files named on the request
  and in a `conflict_appendix` — up to two rounds. A round that leaves markers
  in place counts as unresolved. Past the cap the attempt fails as
  `merge_back_failed` with the worktree still retained (`workspace` on the
  receipt): resolve the markers there yourself, then
  `fadeno attempt-accept <run> <actor-call-id>` merges the result, writes the
  artifact from the parked report, and records a `host_resolved` attempt so
  the next `fadeno drive` continues without re-running the executor. Your
  working tree never carries conflict markers from a merge-back.

- **Safe cancellation.** `fadeno cancel <run>` (or a unique run prefix) targets the
  single live engine command claim for that run, sends `SIGTERM` to its supervisor
  or negative process-group ID, never writes the ledger, and preserves the lease
  and claim until group termination is proven. The engine records the terminal
  receipt. The analogue for ad-hoc work is `fadeno dispatches --cancel <id|tag>`.

- **Idle output is not a deadline.** `fadeno show` may surface
  `WARNING: no output observed for <duration> (non-gating)` after five minutes
  (`OUTPUT_IDLE_WARNING_MS`). This is purely observational — it never signals,
  gates, or alters deadlines.

## Rules

- Gates never "ask an LLM." Evaluator → structured artifact → `fadeno gate`.
- Do not skip required gates silently; if you override, record an event and say so.
- Do not treat `.fadeno/runs/` as source code.
- Ask the host (user) before destructive commands, dependency adds, deploys, or
  external sends (`require_user_approval_for`). On instruction-only hosts those
  asks are advisory — see `.fadeno/enforcement.md`.
- `runner` is the in-session / host-subagent orchestrator; **you** are the
  engine/CLI-dispatch variant. Same runtime.md; different dispatch surface.

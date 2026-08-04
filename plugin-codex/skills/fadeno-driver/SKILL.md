---
name: fadeno-driver
description: Drive a Fadeno run ledger end-to-end — engine-first via `fadeno drive`, with a manual `fadeno next` loop for steps the engine can't execute. Use when the host hands you a run id to drive or resume, or when coordinating multi-harness roles without native nested subagents.
---

# Fadeno Driver

You own a **run ledger** and advance it mechanically. The host harness stays pure:
it picks a playbook, gathers inputs, creates the run (`fadeno new-run`), and
dispatches you with the run id.

You never invent control flow. The **engine** (`fadeno drive`) owns transitions
where it can; the manual loop (`fadeno next` + `fadeno prompt | <harness>`) covers
what it can't. Gates are always `fadeno gate`. Fadeno's engine invokes executors
from `.fadeno/executors.yaml`; in the manual loop, *you* do the dispatch.

Load the runner's `references/runtime.md` for primitive semantics (see
`references/README.md` for install paths). This skill adds the **drive/fallback
procedure**, **harness mapping**, and **pause/resume**.

## Procedure

1. Confirm you have a **run id**. If the host only gave a task/playbook, create
   the run first: `fadeno new-run <playbook> "<task>"`, then continue with that id.
2. **Engine first:** if `.fadeno/executors.yaml` exists (or the user asked for
   engine execution), run `fadeno drive <run>` and act on its exit state:

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
    start each native agent and record dispatch-start
    poll the prompt-declared progress sidecar and record dispatch-progress
    submit dispatch-complete or dispatch-fail, then re-run drive
```

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
          # write bytes to N.step.outputs[i] (or the path prompt recorded)
          fadeno validate <output> --schema <N.step.artifact_type>   # when typed
          # one bounded re-ask on schema failure, then fail the step honestly
          # (write the file FIRST — recording hashes it into the event manifest)
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
        handle tool_call / join / … per runtime.md; record; continue
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
text on stdin; write stdout to the planned artifact path.

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

## Rules

- Gates never "ask an LLM." Evaluator → structured artifact → `fadeno gate`.
- Do not skip required gates silently; if you override, record an event and say so.
- Do not treat `.fadeno/runs/` as source code.
- Ask the host (user) before destructive commands, dependency adds, deploys, or
  external sends (`require_user_approval_for`). On instruction-only hosts those
  asks are advisory — see `.fadeno/enforcement.md`.
- `runner` is the in-session / native-subagent orchestrator; **you** are the
  engine/CLI-dispatch variant. Same runtime.md; different dispatch surface.

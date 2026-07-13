---
name: driver
description: Drive a Fadeno run ledger end-to-end via `fadeno next` and uniform CLI role dispatch (cross-harness). Use when the host hands you a run id to drive or resume, or when coordinating multi-harness roles without native nested subagents.
---

# Fadeno Driver

You own a **run ledger** and advance it mechanically. The host harness stays pure:
it picks a playbook, gathers inputs, creates the run (`fadeno new-run`), and
dispatches you with the run id. You loop on `fadeno next` until the run is
terminal or blocked on a human gate (then you return to the host).

You never invent control flow. `fadeno next` is the cursor; gates are
`fadeno gate`; actor text is `fadeno prompt … | <harness>`. Fadeno never invokes
a model — you do the dispatch.

Load the runner's `references/runtime.md` for primitive semantics (see
`references/README.md` for install paths). This skill adds the **driver loop**,
**harness mapping**, and **pause/resume**.

## Procedure

1. Confirm you have a **run id**. If the host only gave a task/playbook, create
   the run first: `fadeno new-run <playbook> "<task>"`, then continue with that id.
2. Loop:

```
loop:
  N = fadeno next <run>                      # parse JSON
  case N.status:
    terminal:
      fadeno run <run> --status <N.terminal.status>   # if not already terminal
      return final summary (what changed, gates, run path)
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

3. **Honor loop iteration starts.** When `N.advice` says to record
   `loop_iteration_started`, do that before prompting body steps:
   `fadeno run <run> --step <loopId>` is optional; always
   `fadeno run <run> --event loop_iteration_started --field iteration=<n>`
   with `current_step` pointing at the loop (or pass `--step <loopId>`).
4. **Never overwrite** iteration artifacts; generation paths come from
   `fadeno prompt` / `N.step.outputs` (`.v<G>`, G = N + 1).
5. On `terminal`, set status if needed and return: what changed, checks/gates,
   terminal status, run path.

## Role → harness mapping (v1)

Uniform **CLI** dispatch — every role is a sub-harness call (depth-1 safe).

Default map (override with playbook role purpose hints or host policy):

| Role pattern | Command |
|---|---|
| `architect_sol`, names containing `sol`, or purpose mentions Codex/Sol | `codex exec -` (add `-m <model>` when the role names one) |
| everything else | `claude -p` |

Keep it dumb: the point is one provenance story, not smart routing. Pipe prompt
text on stdin; write stdout to the planned artifact path.

## Host ↔ driver handoff (pause / resume)

- **Launch.** Host: `fadeno new-run <playbook> "<task>"` → dispatch this skill
  with the run id. Host session is free.
- **Pause.** On `blocked_human_gate`, return `{question, step, run}` and **exit**.
  State is entirely on disk — nothing lives in the subagent session.
- **Resume.** Host asks the user, records:
  ```
  fadeno run <run> --step <step> --event human_decision --field branch=approve
  # or branch=reject
  ```
  then re-dispatches this skill with the same run id. `fadeno next` sees the
  decision and advances.

## Rules

- Gates never "ask an LLM." Evaluator → structured artifact → `fadeno gate`.
- Do not skip required gates silently; if you override, record an event and say so.
- Do not treat `.fadeno/runs/` as source code.
- Ask the host (user) before destructive commands, dependency adds, deploys, or
  external sends (`require_user_approval_for`). On instruction-only hosts those
  asks are advisory — see `.fadeno/enforcement.md`.
- `runner` is the in-session / native-subagent orchestrator; **you** are the
  cross-harness CLI-dispatch variant. Same runtime.md; different dispatch surface.

# Coordinator design — `fadeno next` + the driver skill

**Status:** implemented (v0). Decisions confirmed 2026-07-13; built same day.
**Origin:** the requirements are the `2026-07-12-1718-design-and-build-fadeno-prompt`
run — every coordinator action I performed by hand there is a line item here.

## The one-paragraph shape

Keep the **host harness pure**: it picks a playbook, gathers inputs, runs
`fadeno new-run`, and dispatches a **driver subagent**. The driver **owns the
ledger** and runs a mechanical loop — `fadeno next` (a new pure cursor) tells it
the next actionable step; for a promptable step it pipes `fadeno prompt … |
{claude -p, codex exec -}`, validates on arrival, and records the artifact; for a
gate it runs `fadeno gate`; at a **human_gate it pauses and returns to the host**,
which asks the user and re-dispatches "resume." Because a subagent can't spawn
subagents (depth-1), **every role is a uniform sub-harness CLI call** — which
erases the Fable-subagent/Sol-CLI asymmetry of the origin run and gives one clean
provenance story. `fadeno` still never invokes a model: it renders and computes;
the skill does the dispatch. Protocol, not runtime — unchanged.

## What's new (three pieces + one gap-closer)

1. **`fadeno next <run>`** — pure deterministic flow cursor (the third render
   twin: `diagram` renders the whole graph, `prompt` renders one step's input,
   `next` renders the graph *cursor*). Read-only; no event, no snapshot.
2. **`fadeno-driver` skill** — the loop; cross-harness role→harness dispatch;
   validate-on-arrival; pause/resume at human_gate.
3. **Host handoff convention** — new-run → dispatch driver → (pause) ask user →
   re-dispatch resume. Documented in the skill; no code.
4. **Gap-closer: `fadeno run --member <m>` / `--field k=v`** — so artifact/actor
   events carry attribution (the origin run's `actor_dispatched` events were bare
   `{}`; this is the `--field` gap the friction log already flags).

## `fadeno next` — the output contract (load-bearing)

Pure function of (validated playbook, run ledger events). Emits one JSON object
describing the single next actionable step, or a blocked/terminal state. Mirrors
`fadeno prompt`'s v1 scoping discipline: fully resolve the promptable kinds; for
the rest, name the step and hand the branch decision to the driver.

```json
{
  "run": "2026-07-12-1718-design-and-build-fadeno-prompt",
  "playbook": "dual-architect-review",
  "status": "ready",
  "step": {
    "id": "cross_review",
    "kind": "map",
    "promptable": true,
    "actors": ["architect_fable", "architect_sol"],
    "outputs": [
      "artifacts/cross-review.architect_fable.json",
      "artifacts/cross-review.architect_sol.json"
    ],
    "collective": "artifacts/cross-review.json",
    "artifact_type": "review-report",
    "loop": { "in_body": false, "iteration": null, "max": null }
  },
  "gate": null,
  "human_gate": null,
  "terminal": null,
  "advice": "dispatch each actor via `fadeno prompt <run> cross_review --actor <a>`; write one artifact per actor; validate each against review-report; then assemble the ReviewReport[] at artifacts/cross-review.json for the downstream gate."
}
```

**`status` values.**

| status | meaning | driver action |
|---|---|---|
| `ready` | a promptable/gate/tool step is next | dispatch it (see `kind`) |
| `blocked_human_gate` | next step is a human_gate with no decision recorded | **pause, return to host**; `human_gate` field carries `{prompt, on_approve, on_reject}` |
| `needs_decision` | next step is a `router`/`subworkflow`/`replicate` (not cursor-resolvable in v1) | driver resolves the branch per runtime.md and records it |
| `terminal` | a `terminal_status` step reached, or flow exhausted | set `run.yaml.status`, return final summary |

**Per-kind resolution (v1).** Fully resolved (`promptable: true`, actors +
outputs populated): `actor_call`, `evaluator`, `reduce`, and `map` over a literal
role list. Named but not prompt-resolved (`promptable: false`): `gate` (carries
the `gate` block: `{condition, artifact, on_pass, on_fail}`), `human_gate`,
`tool_call`, `router`, `join`, `subworkflow`, `replicate`. This is deliberately
the **same promptable set** `fadeno prompt` already supports — the two commands
share the resolver.

**Cursor algorithm** (deterministic, from `events.jsonl` + the flow graph):

1. A step is **done** when its terminal event exists: `artifact_created` (for
   actor/evaluator/reduce/map producing its `output_path`), `gate_evaluated`
   (gate), `loop_succeeded`/`loop_exhausted` (loop).
2. **Position** = the last `step_started` without a completion, else the flow
   successor of the last completed step.
3. **Resolve the successor:**
   - linear → next in `flow`.
   - `gate` → follow the last `gate_evaluated` result to `on_pass`/`on_fail`.
   - `human_gate` → decision event present? follow its branch. Absent →
     `blocked_human_gate`.
   - `loop` → from `loop_iteration_started`/`loop_condition_evaluated`: compute
     iteration; `until` passed → `on_success`; iterations left → re-enter body at
     `iteration+1`; exhausted → `on_exhausted`. (Generation `.v<G>`, G=N+1, exactly
     as `fadeno prompt` already resolves.)
   - `router`/`subworkflow`/`replicate` → `needs_decision`.
4. A resolved step carrying `terminal_status`, once its terminal event exists →
   `status: terminal`.

**Not a runtime, restated.** `next` reads and computes; it emits *what* is next,
never *how* to dispatch it (harness choice is host policy, in the skill). It
writes nothing — no event, no snapshot — unlike `prompt`, which records because it
produces the actually-dispatched text.

## The driver loop (skill pseudocode)

```
loop:
  N = fadeno next <run>                      # parse JSON
  case N.status:
    terminal:            fadeno run <run> --status <N.terminal.status>; return summary
    blocked_human_gate:  return to host { question: N.human_gate.prompt, step: N.step.id }
    needs_decision:      resolve branch per runtime.md; record; continue
    ready:
      if N.step.promptable:
        for actor in (N.step.actors or [<single>]):
          fadeno prompt <run> <N.step.id> --actor <actor> | <harness(actor)>  > <output>
          fadeno validate <output> --schema <N.step.artifact_type>   # 1 bounded re-ask
          fadeno run <run> --event artifact_created --artifact <output> --member <actor>
        if N.step.collective:                # gated map → assemble the Name[] array
          merge outputs -> N.step.collective
      elif N.step.kind == "gate":
        fadeno gate <run> <N.gate.condition> --artifact <N.gate.artifact>   # branches + records
      else:                                  # tool_call/join/... per runtime.md
        ...
```

`harness(actor)` — role→harness mapping. v1: a small advisory map (role → command),
sourced from an optional playbook `roles:` block (`host:`/`model:` hints — the
roadmap item memory already flags) or a run-level default, e.g.
`architect_sol → codex exec -m gpt-5.6-sol -`, everything else → `claude -p`.
Keep it dumb in v1; the point is *uniform CLI dispatch*, not smart routing.

## Host ↔ driver handoff (pause/resume)

- **Launch.** Host: `fadeno new-run <playbook> "<task>"` → dispatch the driver
  subagent with just the run id. Host session now free.
- **Pause.** Driver hits `blocked_human_gate`, returns `{question, step}` to the
  host and exits. State is entirely on disk — nothing lives in the subagent.
- **Resume.** Host asks the user, records the decision
  (`fadeno run <run> --step <step> --event human_decision --field branch=approve`),
  and re-dispatches the driver with the same run id. `fadeno next` now sees the
  decision event and advances past the gate. Resume is free because state is in
  artifacts, not sessions — the same principle the bus already rests on.

## Relationship to `runner`

`runner` is the in-session / native-subagent orchestrator (roles = subagents or
degraded passes). `driver` is the cross-harness variant (pure host + driver
subagent + uniform CLI roles). They share runtime.md. Whether `driver` eventually
becomes the default entrypoint and `runner` folds into it is a later call — for
now `driver` ships alongside `runner`, and the origin run is the proof it models
real coordination.

## Build plan (mirrors the `fadeno prompt` shape)

- `src/lib/flow-cursor.ts` (new, pure): `computeNext(playbook, events) → NextStep`.
  Reuses `prompt-resolve.ts`'s step-plan resolution for the promptable kinds.
- `src/commands/next.ts` (new): `runNext(opts) → NextResult` (read-only).
- `src/commands/run.ts`: `--member` / `--field k=v` on the appended event.
- `src/cli.ts`: `case 'next'` + `--member`/`--field` flags + HELP.
- `plugin/skills/driver/SKILL.md` (+ `templates/common/skills/fadeno-driver/`):
  the loop, harness mapping, pause/resume.
- runtime.md: a "Driving a run (`fadeno next` + the driver)" section.
- Tests: `test/next.test.ts` (cursor over the origin ledger — golden: at the
  `re_cross_review`/`convergence` boundary it returns the right step), a
  `--member`/`--field` case, `validate:self`.

## Open contract questions (worth a look before build)

1. **Is `fadeno next` JSON-only, or also a `--format text` for human reading?**
   (Recommend JSON-only for v1; `fadeno show` already covers human reading.)
2. **`human_decision` event convention** — a dedicated `human_decision` type with
   `branch` field vs. reusing `gate_evaluated`. (Recommend a distinct
   `human_decision` type: honest, and keeps `verify`'s gate recompute clean.)
3. **`collective` assembly** — driver-side merge (v1, dumb concat into the array)
   vs. a `fadeno reduce`/`fadeno merge` helper. (Recommend driver-side for v1;
   promote to a command only if a second playbook needs it.)

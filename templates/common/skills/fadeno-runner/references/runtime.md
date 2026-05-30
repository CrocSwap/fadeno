# Runner runtime reference

Operational detail for executing a playbook. Load this when you actually run one.

## The run ledger

For each run, create:

```
.fadeno/runs/<timestamp>-<slug>/
  run.yaml         # run metadata (validated by schemas/run.schema.json)
  events.jsonl     # append-only lifecycle log, one JSON object per line
  artifacts/       # every durable step output
```

`run.yaml`:

```yaml
run_id: 2026-05-30-1132-csv-export
playbook: code-change-review
status: running            # running | completed | failed | aborted
task: Add CSV export for reports.
started_at: 2026-05-30T11:32:00Z
host: codex                # or: claude, cli
artifacts_dir: artifacts
current_step: plan
```

Update `status` to `completed`/`failed`/`aborted` at the end, and keep
`current_step` pointing at the step in progress.

`events.jsonl` — append a line at each major transition:

```json
{"type":"run_started","step":null,"timestamp":"2026-05-30T11:32:00Z"}
{"type":"step_started","step":"plan","timestamp":"2026-05-30T11:33:00Z"}
{"type":"artifact_created","step":"plan","artifact":"artifacts/plan.md","timestamp":"2026-05-30T11:35:00Z"}
{"type":"gate_evaluated","step":"review_gate","result":"pass","timestamp":"..."}
{"type":"run_completed","step":null,"timestamp":"..."}
```

The ledger is the *degraded runtime* for instruction-only hosts. Keep it honest:
it is what makes the run inspectable, and the seam a future compiled runtime reads.

## Executing each primitive

- **actor_call** — Have the named role do the work. Save its output as the named
  artifact under `artifacts/`.
- **tool_call** — Invoke the named capability (e.g. `test_runner`, `diff_loader`).
  Map it to a real host action; save the result.
- **evaluator** — Have the actor produce a *structured* judgment artifact, e.g.
  `artifacts/review-report.json` conforming to `review-report.schema.json`. Do
  not let the evaluator make the control-flow decision.
- **gate** — Compute `condition` from the judgment artifact deterministically.
  `no_blocking_issues` == there are zero issues with `severity: blocking`. Then
  route to `on_pass` / `on_fail`. Record a `gate_evaluated` event.
- **human_gate** — Stop and ask the user the `prompt`. Route to
  `on_approve` / `on_reject` based on their answer. Never auto-approve.
- **map** — For each item in `over`, do the work. `over` may be a literal list of
  role names, or an artifact-field reference (e.g. `ResearchPlan.subquestions`).
  Save one artifact per item; the collective output is the `Name[]` artifact.
- **replicate** — Ask `count` (or `actors`) independent attempts at the same task;
  save each separately.
- **join** — Wait until every artifact in `wait_for` exists before proceeding.
- **reduce** — Merge the input artifacts into one with the named `actor`.
- **loop** — Re-run `body` (a list of step ids) until `until` holds or
  `max_iterations` is reached, then go to `on_exhausted`. Version every iteration
  artifact; never overwrite.
- **router** — Pick a branch from `routes` (label → step id), falling back to
  `default`.
- **subworkflow** — Run another playbook by name and treat its result as one
  artifact.

## Subagent delegation (depth-1 safe)

- Delegate role work to native subagents when the host supports them.
- A subagent may **not** spawn its own subagents. Keep fan-out to one level.
- `map`/`replicate` fan out one level; loop bodies re-run at the top level, not
  nested inside a subagent. This keeps playbooks safe under Codex `max_depth: 1`.
- When subagents are unavailable, do the roles yourself in separate passes and
  save each as a distinct artifact so role separation is still visible.

## Gates, honestly

The decision is: evaluator → judgment artifact → deterministic condition. If you
cannot compute a gate condition from an artifact, you have not finished the
evaluator step — produce the artifact first. If you must override a gate, write
an event and tell the user.

# Runner runtime reference

Operational detail for executing a playbook. Load this when you actually run one.

## Running the `fadeno` CLI

The runner shells out to `fadeno` (`new-run`, `run`, `gate`, `validate`,
`diagram`). Prefer the bare command — when the plugin is enabled its `bin/` is on
the Bash `PATH`. If bare `fadeno` is "command not found" (the plugin's PATH entry
can lag a `/reload-plugins` within a session), call the bundled binary directly:

```
"${CLAUDE_PLUGIN_ROOT}/bin/fadeno" <args>
```

For a repo-native (non-plugin) setup, `npx fadeno <args>` works. The CLI is
optional — you *can* hand-write `run.yaml` / `events.jsonl` — but it keeps the
ledger schema-valid.

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

## Managing roles & subagents

Each **role** declared in a playbook (`coordinator`, `implementer`,
`substance_reviewer`, …) maps to a subagent at run time — or, when native
subagents aren't available, to a separate role-pass.

- **Defaults — nothing to manage to start.** Fadeno ships sensible role
  subagents (`worker` = implementer, `reviewer` = reviewer, `judge` = evaluator),
  provided by the installed Fadeno skill/plugin (or written to `.claude/agents/`
  by `fadeno init`). A playbook's role names are matched to these by intent.
- **Addressing them.** Dispatch by the bare role agent name — `worker` /
  `reviewer` / `judge` (the `name:` in each agent file); the namespaced
  `fadeno:worker` form also resolves from the plugin. Repo-native installs
  (`fadeno init`) write the same agents un-namespaced to `.claude/agents/`.
- **If a subagent type "is not found":** run `/reload-plugins` (it picks up
  newly added or renamed plugin agents); if they still don't show in `/agents`,
  fully **restart** Claude Code. Until `worker`/`reviewer`/`judge` resolve, rely
  on graceful degradation below — the run still completes.
- **Customizing for a repo.** To change how a role behaves in *this* repo, add or
  edit a per-repo subagent override at `.claude/agents/<name>.md` (Claude) /
  `.codex/agents/<name>.toml` (Codex). Repo-local definitions take precedence over
  the shipped defaults — the same capability/definition split as playbooks.
- **Delegate one level only.** A subagent may **not** spawn its own subagents.
  `map`/`replicate` fan out one level; loop bodies re-run at the top level, not
  nested inside a subagent. This keeps playbooks safe under Codex `max_depth: 1`.
- **Graceful degradation — but say so.** When the role subagents aren't
  available, perform the roles yourself in separate passes and save each as a
  distinct artifact so the role separation stays visible in the ledger. Make the
  fallback **loud, not silent**: tell the user the run is using simulated roles
  (not dedicated subagents), and record it — `fadeno run <run> --event
  roles_degraded`. Otherwise the run reads as if it used subagents when it
  didn't — exactly the kind of dishonest trace this system exists to avoid.

## Gates, honestly

The decision is: evaluator → judgment artifact → deterministic condition. If you
cannot compute a gate condition from an artifact, you have not finished the
evaluator step — produce the artifact first. If you must override a gate, write
an event and tell the user.

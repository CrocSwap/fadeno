# Playbook format reference

The semantics of each playbook term. The **schema is authoritative**
(`.fadeno/schemas/playbook.schema.json`); this file explains what the fields
*mean*. Run `fadeno validate` to check a playbook against the schema and for
reference integrity.

## Top level

| Field | Required | Meaning |
|-------|----------|---------|
| `kind` | yes | Always `AgentPlaybook`. |
| `schema_version` | yes | Playbook format version, e.g. `"0.1"`. |
| `name` | yes | Kebab-case id; should match the file name. |
| `description` | yes | One/two sentences on what the playbook does. |
| `when_to_use` | no | Plain-language cues for selecting this playbook. |
| `roles` | yes | Map of role name → `{ purpose }`. Actors referenced by steps. |
| `flow` | yes | Ordered list of steps. |
| `limits` | no | `max_iterations`, `max_actor_calls` — global bounds. |
| `policies` | no | `max_revision_loops`, `max_subagents`, `require_user_approval_for`. |

`require_user_approval_for` accepts: `destructive_commands`,
`dependency_addition`, `deploy`, `external_send`, `secret_access`,
`data_deletion`. **Advisory** in instruction-only hosts (see
`.fadeno/enforcement.md`).

## Steps

Every step has `id` (snake/lower) and `kind`. `input` is a list of artifact
names; `output` is a single artifact name. Use a `Name[]` suffix to denote a
collection (e.g. `ReviewReport[]`).

Control flow is expressed by step-reference fields, all of which must resolve to
a defined step id (this is what `fadeno validate` checks):
`next`, `on_pass`, `on_fail`, `on_approve`, `on_reject`, `on_exhausted`,
`default`, the loop `body` list, and the `routes` map values.

A step with no outgoing reference is terminal.

## Primitive kinds and their fields

| `kind` | Required fields | Notes |
|--------|-----------------|-------|
| `actor_call` | `actor` | Role does work; `input`/`output` as needed. |
| `tool_call` | `tool` | Invoke a capability (`test_runner`, `diff_loader`, …). |
| `evaluator` | `actor`, `output` | Produces a **structured judgment artifact**. |
| `gate` | `condition`, `on_pass`, `on_fail` | Deterministic check on a judgment artifact. |
| `human_gate` | `prompt` | Ask the user; route via `on_approve`/`on_reject`. |
| `router` | `routes` | `routes` is label → step id; optional `default`. |
| `map` | `over` | `over` = list of items or an artifact-field reference. |
| `replicate` | `actor` | Independent attempts; optional `count`/`actors`. |
| `join` | `wait_for` | Wait for all named artifacts/branches. |
| `reduce` | `actor`, `input` | Merge many artifacts into one. |
| `loop` | `body`, `max_iterations` | Bounded; `until` ends early; `on_exhausted` is the fallthrough. |
| `artifact_op` | `op` | Operate on artifacts (read/transform/write). |
| `subworkflow` | `playbook` | Run another playbook as one step. |

## The gate discipline (do not skip this)

```yaml
- id: judge_quality
  kind: evaluator
  actor: substance_reviewer
  output: ReviewReport         # conforms to review-report.schema.json
- id: quality_gate
  kind: gate
  condition: no_blocking_issues  # = (issues with severity "blocking") is empty
  on_pass: final
  on_fail: revise
```

Judgment lives in an artifact; control flow is a deterministic check on it. Never
write a gate that "asks the model to decide" inline.

## Bounded loops

```yaml
- id: revise
  kind: loop
  max_iterations: 2
  body: [implement_revision, review_revision]
  until: no_blocking_issues
  on_exhausted: summarize_best_attempt
```

The body steps must be defined elsewhere in `flow`. Each iteration versions its
artifacts; nothing is overwritten. Keep fan-out depth-1: loop bodies re-run at the
top level, not nested inside a subagent.

---
name: fadeno-builder
description: Create or modify Fadeno playbooks from natural-language workflow descriptions. Use ONLY when the user explicitly wants to create, modify, simplify, or review a playbook. Do NOT trigger merely because a task mentions a playbook.
---

# Fadeno Builder

Turn a described workflow into a small, valid Fadeno playbook. Bias toward the
simplest thing that works: a handful of well-defined primitives composes more
reliably than a sprawling graph.

## Procedure

1. Understand the user's desired workflow: inputs, the work, the decision points,
   and the deliverable.
2. Identify the closest pattern (see `references/playbook-authoring.md`):
   `simple_linear`, `plan_execute_verify`, `worker_reviewer_merge`,
   `research_synthesis`, `debate_judge`, `code_change_review`,
   `human_approval_gate`.
3. Recommend the simplest version first. Add loops/fan-out only when the task
   clearly needs them.
4. Generate YAML under `.fadeno/playbooks/<name>.yaml`.
5. Prefer explicit roles, typed artifacts, bounded loops, and structured gates.
   Every gate reads a judgment artifact (evaluator → artifact → condition); a
   gate never "asks the model" inline.
6. Avoid excessive fan-out and never write an unbounded loop.
7. Add comments only where they clarify intent.
8. Run `fadeno validate` if available; fix schema and reference-integrity errors.
9. Summarize the playbook and when to use it.

## Rules

- Keep the vocabulary small and orthogonal; reuse the primitives in the schema
  rather than inventing fields.
- Every step-reference (`on_pass`, `on_fail`, `next`, loop `body`,
  `on_exhausted`, `routes`, `default`) must point at a defined step.
- Keep fan-out depth-1: loop bodies re-run at the top level; a subagent does not
  spawn its own subagents.
- Bound every loop with `max_iterations`.
- Map approval-worthy actions (deps, deploy, destructive, external send) to
  `policies.require_user_approval_for`, and remind the user these are advisory
  unless wired to CI/hooks (`.fadeno/enforcement.md`).

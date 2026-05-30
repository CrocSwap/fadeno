# Playbook authoring patterns

Reach for the smallest pattern that fits. Each composes from the primitives
defined in `.fadeno/schemas/playbook.schema.json`. Validate with `fadeno
validate`. See the runner's `playbook-format.md` for the field reference.

## Pattern catalogue

### simple_linear
A → B → C. One role, no gates. For deterministic, low-risk tasks.

```yaml
flow:
  - { id: do, kind: actor_call, actor: worker, output: Result }
```

### plan_execute_verify
Plan, do, then verify with a tool and a gate.

```yaml
flow:
  - { id: plan, kind: actor_call, actor: coordinator, output: Plan }
  - { id: execute, kind: actor_call, actor: worker, input: [Plan], output: Result }
  - { id: verify, kind: tool_call, tool: test_runner, output: TestResult, next: gate }
  - { id: gate, kind: gate, condition: tests_pass, on_pass: done, on_fail: execute }
  - { id: done, kind: actor_call, actor: coordinator, input: [Result, TestResult], output: Summary }
```

### worker_reviewer_merge
One worker, one or more reviewers (a `map`), then a `reduce`. Gate on the merged
review.

### research_synthesis
Plan subquestions → `map` researchers → `reduce` synthesize → `evaluator`
fact-check → gate → bounded revise loop. (See the shipped `research-synthesis`
playbook.)

### debate_judge
`replicate` N independent attempts → `evaluator` judge scores them → `reduce`
the winner. Use when the solution space is wide and one attempt is risky.

### code_change_review
Plan → implement → `map` reviewers → gate → bounded revise loop → test →
summarize. (See the shipped `code-change-review` playbook.)

### human_approval_gate
Insert a `human_gate` before any irreversible or outward-facing action
(deploys, posting comments, sends). Route `on_approve`/`on_reject`. (See the
`post_gate` step in the shipped `pr-review` playbook.)

## Authoring checklist

- [ ] One clear deliverable artifact at the end.
- [ ] Roles are explicit and each has a `purpose`.
- [ ] Every gate is `evaluator → judgment artifact → deterministic condition`,
      not an inline "ask the model".
- [ ] Every loop has `max_iterations`; iteration artifacts are versioned.
- [ ] Fan-out is depth-1 (no subagent-spawns-subagent).
- [ ] All step references resolve (`fadeno validate` is green).
- [ ] Approval-worthy actions are listed in `require_user_approval_for`.
- [ ] The playbook is as small as the task allows.

## Anti-patterns

- **Gate that asks an LLM.** Replace with an evaluator that writes an artifact,
  then a deterministic condition on that artifact.
- **Unbounded loop** ("keep trying until good"). Always bound and define
  `on_exhausted`.
- **Fan-out explosions.** Mapping over a large runtime list with no cap; add
  `policies.max_subagents` and prefer batching.
- **Overwriting iteration artifacts.** Version them (`.v1`, `.v2`).
- **Inventing fields.** If the schema lacks a field, reshape the flow rather than
  adding ad-hoc keys — `fadeno validate` will reject unknown properties.

---
name: fadeno-runner
description: Execute Fadeno playbooks from `.fadeno/playbooks` for complex coding, review, research, or multi-step agent workflows. Use when the user asks to run a Fadeno playbook or names one, or when a task is complex enough to benefit from a repeatable plan/review/test workflow.
---

# Fadeno Runner

Execute a Fadeno playbook as a bounded, inspectable workflow backed by files on
disk. You are the orchestrator: you read the playbook, perform each step (using
subagents when available, separate passes otherwise), and record what happened in
a run ledger so the result is reproducible and reviewable.

## Procedure

1. Read `.fadeno/vocabulary.md` and `references/runtime.md` (the operational
   detail lives there — keep it out of working memory until needed).
2. Select the best playbook from `.fadeno/playbooks` using each playbook's
   `when_to_use`. If the user named one, use it. State which you chose and why.
3. Validate required inputs are present; ask the user for anything missing.
4. Create a new run directory: `.fadeno/runs/<timestamp>-<slug>/` (or run
   `fadeno new-run <playbook> "<task>"` if the CLI is available).
5. Write `run.yaml` (see `references/runtime.md` for the shape).
6. Append major lifecycle events to `events.jsonl` as you go. Gate events must
   include `condition`, the concrete artifact path, and `result`; loops must
   record iteration start, condition evaluation, and success or exhaustion.
7. Execute each step in `flow` using available host capabilities.
8. If native subagents are available, delegate role-specific work to them — but
   **one level only**; do not assume a subagent can spawn its own subagents.
9. If native subagents are unavailable, simulate role separation with separate
   passes and save each pass as a distinct artifact.
10. Save every major output under `artifacts/`.
11. Apply gates using the **structured judgment artifact**, not vague prose: an
    evaluator writes a schema-valid report or test result, then run
    `fadeno gate <run> <condition> --artifact <path>` and follow the explicit
    branch. Do not infer `tests_pass` from a prose summary.
12. Respect loop limits. Execute body steps in listed order, evaluate the loop
    condition against the latest body-produced artifact, then follow
    `on_success` or `on_exhausted`. Version iteration artifacts (`.v1`, `.v2`);
    never overwrite a prior iteration.
13. Run tests or checks when the playbook requires them.
14. When a step declares `terminal_status`, stop there and set `run.yaml.status`
    to the same value. A failed review exhaustion or failed test path must not
    be reported as completed. Return a final answer with: what changed, checks
    performed, gates passed/failed, terminal status, and the run path.

## Rules

- Never run unbounded loops. Honor `max_iterations` / `limits`.
- Never skip a required gate silently. If you skip or override one, say so.
- Never overwrite iteration artifacts; version them.
- Do not treat `.fadeno/runs/` as source code.
- Ask for user approval before destructive commands, dependency additions,
  deployments, or external sends (the `require_user_approval_for` categories).

  NOTE: in an instruction-only host these approvals are **advisory** — there is
  no hard guarantee. The repo's CI / pre-commit layer (and Claude Code hooks) is
  the enforced backstop. See `.fadeno/enforcement.md`.

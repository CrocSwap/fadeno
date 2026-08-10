---
name: fadeno-runner
description: Execute or resume Fadeno playbooks from `.fadeno/playbooks` for complex coding, review, research, or multi-step agent workflows. Use when the user says “Use Fadeno”, asks to run a playbook, names one, or provides a run id.
---

# Fadeno Runner

Execute a Fadeno playbook as a bounded, inspectable workflow backed by files on
disk. You are the director and sole Fadeno ledger writer: native workers return
outputs and receipts to you; they never invoke Fadeno ledger commands.

## Procedure

1. **Route the request.** For “Use Fadeno”: a matching playbook goes directly
   to run; a described workflow with no match goes to the builder, then
   validate → diagram → one approval → run; an existing run id resumes that
   run. Announce the run id immediately after creating it.
2. Read `.fadeno/vocabulary.md` and `references/runtime.md` (the operational
   detail lives there — keep it out of working memory until needed).
3. Select the best playbook from `.fadeno/playbooks` using each playbook's
   `when_to_use`. If the user named one, use it. State which you chose and why.
4. Validate required declared inputs are present; preserve long specifications
   as `fadeno new-run --input Name=path` files rather than shortening them.
5. Create a new run directory: `.fadeno/runs/<timestamp>-<slug>/` (or run
   `fadeno new-run <playbook> "<task>"` if the CLI is available).
6. Write `run.yaml` (see `references/runtime.md` for the shape).
7. Append major lifecycle events to `events.jsonl` as you go. Gate events must
   include `condition`, the concrete artifact path, and `result`; loops must
   record iteration start, condition evaluation, and success or exhaustion.
8. Execute each step in `flow` using available host capabilities. When
   `fadeno drive` returns `awaiting_host_dispatch`, start each request with the
   native facility, attach its native agent id, and submit exactly one terminal
   receipt serially with `dispatch-complete` or `dispatch-fail` before driving
   again. The immutable prompt names an ephemeral progress sidecar. Poll it
   without interrupting the agent and record meaningful changes with `fadeno
   dispatch-progress <run> <dispatch> --file <workspace>/<sidecar> --source
   agent`.
9. If native subagents are available, delegate role-specific work to them — but
   **one level only**; do not assume a subagent can spawn its own subagents.
10. If native subagents are unavailable, degrade loudly: use a declared command
   executor or stop with the unavailable model/facility named. Never silently
   substitute a requested native model.
11. If native subagents are unavailable, simulate role separation with separate
   passes and save each pass as a distinct artifact.
12. Save every major output under `artifacts/`.
13. Apply gates using the **structured judgment artifact**, not vague prose: an
    evaluator writes a schema-valid report or test result, then run
    `fadeno gate <run> <condition> --artifact <path>` and follow the explicit
    branch. Do not infer `tests_pass` from a prose summary.
14. Respect loop limits. Execute body steps in listed order and evaluate the
    latest body-produced artifact deterministically. A compositional map may
    own independent loop instances per member; a loop may contain a map. Never
    collapse those instances into one global generation counter. Version every
    iteration artifact and never overwrite a prior iteration.
15. Run tests or checks when the playbook requires them.
16. When a step declares `terminal_status`, stop there and set `run.yaml.status`
    to the same value. A failed review exhaustion or failed test path must not
    be reported as completed. Return a final answer with: what changed, checks
    performed, gates passed/failed, terminal status, and the run path.

## Rules

- Never run unbounded loops. Honor `max_iterations` / `limits`.
- Never skip a required gate silently. If you skip or override one, say so.
- Never overwrite iteration artifacts; version them.
- Do not treat `.fadeno/runs/` as source code.
- Attach native agent ids to host starts. Treat model, effort, and agent type as
  requested configuration unless the host supplies independently observed
  runtime identity; never describe an echoed request as verified.
- Use original native agents for revision when possible; ask `fadeno show` and
  merge its workflow-aligned actor projection with host/Codex activity for
  status. Report pending/running/waiting/blocked/completed actors plus total
  runtime; never infer internal progress from idle/busy alone.
- Progress is attested observability, never a gate input. Preserve its source
  (`agent`, `harness`, or `director`) and say `unavailable` when no channel exists.
- Parallel writers use worktrees or patch-only output when the host supports it;
  automatic worktree creation/merging is not part of Fadeno's MVP.
- Ask for user approval before destructive commands, dependency additions,
  deployments, or external sends (the `require_user_approval_for` categories).

  NOTE: in an instruction-only host these approvals are **advisory** — there is
  no hard guarantee. The repo's CI / pre-commit layer (and Claude Code hooks) is
  the enforced backstop. See `.fadeno/enforcement.md`.

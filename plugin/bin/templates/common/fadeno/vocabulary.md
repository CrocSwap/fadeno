# Fadeno Vocabulary

Fadeno is a portable **playbook protocol** for AI coding agents — not a runtime.
A small, orthogonal vocabulary composes more reliably than a sprawling one. The
[`playbook.schema.json`](schemas/playbook.schema.json) is the single source of
truth for the vocabulary; this file explains what each term *means*.

## Core terms

- **Playbook** — A reusable orchestration recipe for an agent workflow (a YAML
  file in `playbooks/`).
- **Run** — One concrete execution of a playbook, recorded under `runs/`.
- **Actor** — A role performed by a coding agent, a native subagent, or a
  simulated role-pass when subagents are unavailable.
- **Artifact** — A durable output of a step (plan, patch, review, test result,
  summary, …), saved under a run's `artifacts/`.
- **TestResult** — A structured test artifact with `status`, `exit_code`, and
  `summary`; `tests_pass` never infers success from prose.
- **Gate** — A checkpoint that decides whether execution proceeds, revises, asks
  the user, or stops.
- **Evaluator** — An actor that produces a *structured judgment artifact*.
- **Loop** — A bounded, repeated subgraph (usually revise/review or
  plan/execute/verify). Always bounded; never "keep trying until good."
- **Map** — Apply work over a list of items.
- **Replicate** — Ask multiple actors to independently attempt the same task.
- **Join** — Wait for multiple branches or artifacts.
- **Reduce** — Merge many artifacts into one.
- **Host adapter** — How a playbook maps onto a specific environment (Codex,
  Claude Code, hook-enabled, compiled runtime).

## The most important design rule

A gate must **not** directly "ask an LLM." Instead:

```
evaluator actor  →  structured judgment artifact  →  deterministic gate condition
```

Judgment lives in an artifact (which models are good at producing); control flow
lives in a deterministic check on that artifact (which is verifiable). The
artifact shape is defined by [`review-report.schema.json`](schemas/review-report.schema.json),
so a gate condition like `no_blocking_issues` is computable on disk — by the
agent today, and by a hook/CI/runtime tomorrow.

## Loops are bounded

```yaml
limits:
  max_iterations: 2
  max_actor_calls: 12
```

Iterations are versioned (`ReviewReport.v1`, `ReviewReport.v2`, …) and never
overwritten. A loop has separate `on_success` and `on_exhausted` exits.

## Primitives (step `kind`s)

`actor_call`, `tool_call`, `evaluator`, `gate`, `human_gate`, `router`, `map`,
`replicate`, `join`, `reduce`, `loop`, `artifact_op`, `subworkflow`.

Each step has at least `id` and `kind`. See the skill reference
`playbook-format.md` for the fields each kind uses.

## Enforcement is tiered

`policies.require_user_approval_for` is **advisory** in instruction-only hosts
(Codex, Claude Code). For hard guarantees, push invariants down to the repo's
git/CI/pre-commit layer (and optionally Claude Code hooks), which is
harness-agnostic and also protects against human mistakes. See
[`enforcement.md`](enforcement.md).

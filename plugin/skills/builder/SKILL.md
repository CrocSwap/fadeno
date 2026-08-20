---
name: builder
description: Create or modify Fadeno playbooks from natural-language workflow descriptions, show them back as a diagram, and hand off to the runner. Use ONLY when the user explicitly wants to create, modify, simplify, or review a playbook. Do NOT trigger merely because a task mentions a playbook. [fadeno 0.6.0-rc.37]
---

# Fadeno Builder

Resolve the CLI first: when `scripts/fadeno.cjs` exists beside this `SKILL.md`, use
that plugin-bundled launcher for every command written below as `fadeno`
(invoke it with `node` on Windows).
Otherwise use `fadeno` from `PATH`. Never prefer an unrelated global CLI over
the plugin launcher.

Turn a described workflow into a small, valid Fadeno playbook — then show it back
as a diagram and hand it to the runner once the user approves. Bias toward the
simplest thing that works: a handful of well-defined primitives composes more
reliably than a sprawling graph.

## Procedure

1. **Use the effective catalog.** The installed plugin already supplies bundled
   schemas, vocabulary, and starter playbooks; no per-repo init is needed for a
   built-in. If the user is authoring a custom playbook, write it under
   `.fadeno/playbooks/` and let project definitions shadow bundled names.
2. **Start from a pattern, not a blank page.** Offer the user a choice:
   - adapt a **starter** from the effective catalog: `code-change-review`
     (plan → implement → review → test → bounded revise), `research-synthesis`
     (gather → synthesize → fact-check → revise), `compositional-review`
     (independent mapped revision loops → final reduce), `parallel-workstreams`
     (freeze contract + ownership manifests → parallel workstreams → integrate →
     verify → gate), `pr-review` (review → merge →
     gate → post behind a human gate), or `model-tryout` (same spec to two
     candidates → judge comparison → ModelComparison); **or**
   - author a new playbook from their description.
   Match it to the closest pattern in `references/playbook-authoring.md`.
3. **Recommend the simplest version first.** Add loops/fan-out only when the task
   clearly needs them.
4. **Write the YAML** to `.fadeno/playbooks/<name>.yaml`. First line:
   `# yaml-language-server: $schema=../schemas/playbook.schema.json`. Prefer
   explicit roles, typed artifacts, bounded loops, and structured gates
   (evaluator → judgment artifact → deterministic condition — never an inline
   "ask the model").
5. **Validate and visualize.** Run `fadeno validate .fadeno/playbooks/<name>.yaml`
   and fix every error (and ideally the warnings). Then run `fadeno diagram <name>`
   and show the user the ASCII diagram plus a one-line summary of each step. (Use
   `--format mermaid` if they want a graph for docs.)
6. **Human gate — get approval.** Ask the user to approve, request changes, or
   start over. Do **not** run anything yet; loop on steps 4–5 until they approve.
7. **Hand off to the runner.** Once approved, say it's ready and run it with the
   **runner** skill (which may also be invoked by name) — do not execute it
   yourself from the builder.
8. **Explain the roles.** Briefly note which roles the playbook uses and how they
   map to subagents — see "Managing roles & subagents" in the runner's
   `references/runtime.md`.

## Rules

- Keep the vocabulary small and orthogonal; reuse the schema's primitives rather
  than inventing fields (`fadeno validate` rejects unknown properties).
- Every step-reference must resolve; every `actor` must be a declared role; bound
  every loop with `max_iterations`.
- Keep fan-out depth-1: loop bodies re-run at the top level; a subagent does not
  spawn its own subagents.
- Map approval-worthy actions to `policies.require_user_approval_for`, and remind
  the user these are advisory unless wired to CI/hooks (`.fadeno/enforcement.md`).
- Never execute the playbook from the builder — that's the runner's job, and only
  after the user approves.

<!--
DRAFT README copy, written to docs/product for review. Once approved, this becomes /README.md.
Grounded in the real CLI (src/cli.ts) and the real starter playbook (templates/common/fadeno/playbooks/code-change-review.yaml).
Voice: honest, precise, low-hype, dry. The README IS the storefront for a word-of-mouth project — design it like one.
-->

# Fadeno

**The playbook layer for AI coding agents.**

Stop re-typing *"be careful, plan, review, test"* every run. Define your workflow once as a repo-native YAML playbook, and any agent runs it the same disciplined way — leaving an inspectable trace of what it did. No runtime, no service, no lock-in.

> **Fadeno** /fah-DEH-no/ — Esperanto for *"thread."* The thread that runs through every agent task.

```bash
npx fadeno init --codex     # or --claude
```

---

## The problem

Coding agents are powerful but inconsistent. Every nontrivial task, you re-explain the same discipline:

> *"Codex, please be careful. Make a plan first, then implement it. Review your own code for edge cases. Run the tests. If something's broken, fix it. Don't install new dependencies or run anything destructive without checking with me."*

You retype some version of that every time. You get different behavior every run. And when the chat closes, there's no record of what the agent actually did.

## The fix

Define the workflow **once**, commit it to your repo, and then just say:

> *"Use the code-change-review playbook."*

Same discipline — plan → implement → review → test → bounded revision — every time. Inspectable. Shareable. Portable across the agents your team actually uses.

---

## Quickstart

```bash
# In your repo:
npx fadeno init --codex      # scaffolds for Codex   (.agents/skills, AGENTS.md)
# or
npx fadeno init --claude     # scaffolds for Claude Code (.claude/skills, CLAUDE.md)

fadeno validate              # check your playbooks (schema + reference integrity)
```

Then, in your agent:

> Use the **fadeno-runner** skill to run the code-change-review playbook on this task.

That's it. No daemon, no account, no service. Fadeno writes files into your repo and gets out of the way.

## What `init` creates

```
AGENTS.md                      # (or CLAUDE.md) — points your agent at Fadeno
.fadeno/
  vocabulary.md                # the shared workflow vocabulary
  playbooks/
    code-change-review.yaml    # plan → implement → review → test → revise
    research-synthesis.yaml
    pr-review.yaml
  schemas/                     # JSON Schemas — the source of truth for the format
  runs/                        # file-backed run traces land here
.agents/skills/                # (or .claude/skills/) — the runner + builder skills
  fadeno-runner/
  fadeno-builder/
```

Existing `AGENTS.md` / `CLAUDE.md` are preserved — Fadeno appends a short section rather than overwriting your file.

## What a playbook looks like

A playbook is plain YAML: roles, steps, review gates, and bounded loops. Here's the heart of `code-change-review`:

```yaml
kind: AgentPlaybook
name: code-change-review
roles:
  coordinator:        { purpose: Plan, route, merge, and decide completion. }
  implementer:        { purpose: Make the code change. }
  substance_reviewer: { purpose: Review correctness, edge cases, safety, tests. }
  style_reviewer:     { purpose: Review clarity, maintainability, conventions. }
flow:
  - { id: plan,    kind: actor_call, actor: coordinator, output: Plan }
  - { id: implement, kind: actor_call, actor: implementer, input: [Plan], output: ImplementationResult }
  - id: review
    kind: map
    over: [substance_reviewer, style_reviewer]
    input: [ImplementationResult]
    output: ReviewReport[]
  - id: review_gate
    kind: gate
    condition: no_blocking_issues   # computed from the review artifacts, not re-asked of a model
    on_pass: test
    on_fail: revise
  - id: revise
    kind: loop
    max_iterations: 1               # bounded. no "keep trying until good."
    body: [implement_revision, review_revision]
    on_success: test
    on_exhausted: unresolved_review
  # ...
```

Two design choices worth calling out:

- **Gates don't ask a model "is this good?"** An evaluator role produces a *structured judgment artifact*, and the gate is a deterministic check on that artifact. Judgment lives where models are strong; control flow lives where it's verifiable.
- **Loops are bounded and versioned.** No unbounded "try until it passes." Each iteration's artifacts are kept, not overwritten, so you can see how the work evolved.

## The run trace

Every run writes a file-backed trace — the thing you never get from a chat window:

```
.fadeno/runs/2026-05-30-1132-csv-export/
  run.yaml        # what playbook, what task, status, current step
  events.jsonl    # lifecycle events: step_started, artifact_created, ...
  artifacts/      # the actual plans, reviews, test results, summaries
```

This is what makes Fadeno runs **inspectable**. It's also the seam a future real runtime can read and write — but you don't need one to benefit today.

## Portable across agents

The *same* playbooks, schemas, and vocabulary run on both supported harnesses. Only the thin adapter differs:

| | Codex (`--codex`) | Claude Code (`--claude`) |
|---|---|---|
| Skill dir | `.agents/skills/` | `.claude/skills/` |
| Bootstrap file | `AGENTS.md` | `CLAUDE.md` |
| Invocation | `$fadeno-runner` | `/fadeno-runner` |

Your workflow isn't hostage to one vendor's format.

## Honest about enforcement (read this)

In instruction-only hosts (Codex, Claude Code today), approval policies like `require_user_approval_for` are **advisory** — the agent is *asked* to honor them. That's not a hard guarantee, and we won't pretend otherwise.

For **real** enforcement, Fadeno's design pushes hard invariants down to your **git / CI / pre-commit** layer, where a deterministic check runs regardless of what any model does — and protects against human mistakes too, not just agent ones. Agent-native hooks (e.g. Claude Code's) are an optional accelerant on top, never the only line of defense.

We'd rather you trust the tool because it's honest than because it overclaims.

## Core ideas, briefly

- **Playbook** — a reusable workflow recipe (YAML).
- **Run** — one concrete execution, with a file-backed trace.
- **Role** — a part an agent (or subagent) plays: coordinator, implementer, reviewer.
- **Gate** — a deterministic checkpoint on a structured judgment artifact.
- **Loop** — a bounded, versioned revise/review cycle.

The full vocabulary lands in `.fadeno/vocabulary.md` when you init.

## Make your own

```
fadeno new-run code-change-review "Add CSV export for reports"
```

Or ask the **fadeno-builder** skill to turn a plain-English workflow description into a validated playbook. Then `fadeno validate` checks it — schema *and* reference integrity (every step a gate or loop points to actually exists).

## Status

Early and intentionally small: files, schemas, a CLI, and starter playbooks. It's *not* a runtime, and that's the point — the scope stays sustainable and the surface area stays low. Issues and playbook contributions welcome.

## License

MIT.

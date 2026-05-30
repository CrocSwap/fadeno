# Fadeno v0 Implementation Memo

> **Revision note:** This memo has been updated after researching current Codex and Claude Code skill/subagent integration. Integration-layer assertions in the original draft have been verified or corrected. Changes are flagged inline with **[VERIFIED]**, **[CORRECTED]**, or **[NEW]**. The conceptual core (vocabulary, gate discipline, bounded loops, run ledger) is unchanged — it was sound.

## Project summary

Build **Fadeno**, an open-source, repo-native playbook layer for AI coding agents.

Fadeno lets users define reusable agent workflows — for example: plan, spawn workers, review, run tests, revise, summarize — as YAML playbooks plus agent skills. The v0 target is **Codex compatibility**, but the architecture is **harness-neutral** and explicitly designed to port to Claude Code, and longer term to harnesses that expose **deterministic hooks** for sub-agent handling and gate enforcement.

The key principle:

> Fadeno is not a heavyweight agent runtime. It is a portable playbook protocol with optional file-backed execution traces, plus optional deterministic enforcement where the host harness supports it.

### Portability model **[NEW — read this first]**

Fadeno targets three tiers of host capability. The *same playbooks* run on all three; only the **host adapter** changes.

| Tier | Example harnesses | Execution model | Gate/approval enforcement |
|------|-------------------|-----------------|---------------------------|
| 1. Instruction-only | Codex, Claude Code | Top-level agent reads skill, interprets playbook, writes file-backed run trace. Subagents used when available, else simulated via separate passes. | **Advisory** — model is asked to honor `require_user_approval_for`. No hard guarantee. |
| 2. Hook-enabled | Claude Code (hooks), CI/pre-commit | As tier 1, plus deterministic hooks fire on lifecycle events to enforce gates and block disallowed actions. | **Enforced** — hooks/CI checks are deterministic and run regardless of model compliance. |
| 3. Compiled runtime (future) | Purpose-built orchestrator | Playbook compiles to a typed control/dataflow graph with a real execution engine. | **Enforced** at the runtime level. |

**Critical design consequence:** in tier 1, `require_user_approval_for` and gate conditions are *advisory data the model is asked to follow* — not guarantees. The portable place for **real** enforcement is the repo's git/CI/pre-commit layer (tier 2), because that is harness-agnostic and also protects against human mistakes, not just agent ones. Fadeno's design pushes hard invariants **down to git/CI**, not into any single agent's proprietary hook system. Agent-native hooks (e.g. Claude Code's `PreToolUse`/`Stop`) are an *optional accelerant* layered on top, never the only line of defense.

This must be stated honestly in the README so users do not mistake advisory policy for a guarantee.

## Host integration facts (researched)

These are the verified facts the original draft was missing. The coding agent should rely on these, not on guesses.

### Skills

- **SKILL.md is a cross-harness open standard ("Agent Skills").** The same `SKILL.md` content works on Codex, Claude Code, Cursor, and others. Portability of the *skill content* is essentially free; only the install location and invocation sigil differ per harness. **[VERIFIED]**
- **Skill directory location is per-harness:** **[CORRECTED]**
  - Codex: `.agents/skills/<name>/` (scanned from cwd up to repo root; committed skills are auto-discovered, no install step). This is what v0 generates.
  - Claude Code: `.claude/skills/<name>/` (same SKILL.md content inside).
- **Invocation sigil is per-harness:** **[CORRECTED]**
  - Codex: explicit `$skill-name`, or `/skills` to browse, or implicit (description match).
  - Claude Code: `/skill-name`, or implicit (description match).
  - **Do not let `$name` leak into Claude-targeted templates, or `/name` into Codex-targeted ones.**
- **Progressive disclosure is the correct structure and is confirmed:** **[VERIFIED]**
  - Layer 1: `description` (~100 tokens, always in context) → agent decides to activate.
  - Layer 2: `SKILL.md` body (<5000 tokens recommended, loaded on activation) → stays resident once loaded.
  - Layer 3: `references/`, `scripts/`, `assets/` (loaded on demand only).
  - **Keep SKILL.md bodies lean; push vocabulary and format detail into `references/`** because the body is a recurring token cost once loaded, while references are not.
- **Codex invocation policy lives in `agents/openai.yaml` inside the skill dir.** Key field: `allow_implicit_invocation` (default `true`). **[NEW]**

### Subagents

- **Codex subagents exist** and are config-layer-based (per-file definitions; global settings under an `[agents]` section). Concept maps to Fadeno roles. **[VERIFIED — concept]**
- **Exact path `.codex/agents/*.toml` is NOT fully verified.** Treat as provisional. **[FLAG]** Because the runner skill degrades gracefully (simulate role separation via separate passes when native subagents are unavailable), a wrong path degrades to sequential passes rather than breaking. The coding agent should verify the current Codex subagent config path before relying on native delegation, but should NOT block v0 on it.
- **Codex `max_depth` defaults to 1** — a spawned subagent cannot itself spawn without opt-in. **[NEW — design boundary]** Playbooks must not assume recursive delegation. The `code-change-review` flow below is depth-1 safe.
- **Codex spawns subagents only when explicitly asked.** The runner skill must explicitly request delegation, not assume automatic fanout.

### Bootstrap instruction file is per-harness **[CORRECTED]**

- Codex: `AGENTS.md`
- Claude Code: `CLAUDE.md`
- Same role, different filename. `init` writes the correct one per target.

## Product goal

Before Fadeno:

> "Codex, please be careful. Think through the problem, review your code, and run tests."

After Fadeno:

> "Use the code-change-review playbook."

Fadeno makes complex AI-agent work repeatable, inspectable, portable, easy to customize, and not tied to one agent platform.

## Initial user journey

```
npx fadeno init --codex
```

Creates a repo-local Fadeno setup (Codex target):

```
AGENTS.md
.fadeno/
  vocabulary.md
  playbooks/
    code-change-review.yaml
    research-synthesis.yaml
    pr-review.yaml
  schemas/
    playbook.schema.json
    run.schema.json
    review-report.schema.json
  runs/
    .gitkeep
.agents/
  skills/
    fadeno-runner/
      SKILL.md
      agents/
        openai.yaml          # [NEW] invocation policy
      references/
        runtime.md
        playbook-format.md
    fadeno-builder/
      SKILL.md
      agents/
        openai.yaml          # [NEW] invocation policy
      references/
        playbook-authoring.md
.codex/
  agents/
    fadeno-worker.toml        # [FLAG] verify path before relying on native delegation
    fadeno-reviewer.toml
    fadeno-judge.toml
```

A **`npx fadeno init --claude`** target is an explicit fast-follow (see Dual-target section). It produces the same skill *content* under `.claude/skills/` and writes `CLAUDE.md` instead of `AGENTS.md`, with `/`-style invocation in the bootstrap text.

### Generated AGENTS.md (Codex target)

```markdown
# Fadeno
This repository uses Fadeno playbooks in `.fadeno/playbooks`.
For complex coding, review, research, or multi-step tasks, prefer the `$fadeno-runner` skill.
Use `$fadeno-builder` when the user wants to create or modify a reusable playbook.
Do not treat `.fadeno/runs/` as source code; it contains execution traces and artifacts.
```

### Generated CLAUDE.md (Claude Code target) **[NEW]**

```markdown
# Fadeno
This repository uses Fadeno playbooks in `.fadeno/playbooks`.
For complex coding, review, research, or multi-step tasks, prefer the `/fadeno-runner` skill.
Use `/fadeno-builder` when the user wants to create or modify a reusable playbook.
Do not treat `.fadeno/runs/` as source code; it contains execution traces and artifacts.
```

## v0 scope

### Required v0 features

1. CLI commands: `fadeno init --codex`, `fadeno init --claude`, `fadeno validate`.
2. Generate repo files per target (preserving existing `AGENTS.md`/`CLAUDE.md` content if present).
3. Define the playbook schema (JSON Schema), and **[NEW]** include reference-integrity validation (see below).
4. Starter playbooks: `code-change-review.yaml`, `research-synthesis.yaml`, `pr-review.yaml`.
5. Runner skill instructions (select playbook, create run dir, write `run.yaml`, append `events.jsonl`, save artifacts, execute steps with host capabilities, **degrade gracefully when native subagents are unavailable**).
6. Builder skill instructions (NL → YAML playbook, conceptual validation, recommend patterns, avoid fanout/loop explosions).
7. JSON schemas for playbooks, run ledger, review reports.
8. `fadeno validate` — validates playbooks against schema, **[NEW]** including that every step id referenced by a gate/loop/router actually exists.
9. **[NEW]** `agents/openai.yaml` invocation-policy files for each skill (see Skills section).

### Authoring format decision **[NEW — make this deliberate]**

Playbooks are authored in **YAML** (human-friendly), validated against a **JSON Schema** (enforceable, low-ambiguity). The agent consumes YAML. This is a deliberate reversal of an earlier "JSON for everything" instinct: YAML wins on authorability, and the JSON Schema recovers the low-ambiguity property by making the vocabulary machine-checkable rather than aspirational. The SKILL.md `references/playbook-format.md` explains the *semantics* of each schema term; the schema is the single source of truth for the *vocabulary*. Keep the vocabulary small and orthogonal — a handful of well-defined primitives composes more reliably than a sprawling set the model must disambiguate.

### Non-goals for v0

No full runtime. Avoid: background scheduler, long-running daemon, cloud service, visual graph editor, real parallel execution engine, model-provider integrations, **hard permission enforcement inside Fadeno itself** (enforcement belongs in the host's CI/hook layer), full LangGraph/Temporal-style runtime, web UI.

v0 is mostly: files, schemas, starter playbooks, skills, CLI scaffolding, validation.

## Core concepts

### Vocabulary (`.fadeno/vocabulary.md`)

- **Playbook**: A reusable orchestration recipe for an agent workflow.
- **Run**: One concrete execution of a playbook.
- **Actor**: A role performed by a coding agent, subagent, or simulated role-pass.
- **Artifact**: A durable output from a step (plan, patch, review, test result, summary, etc.).
- **Gate**: A checkpoint deciding whether execution proceeds, revises, asks the user, or stops.
- **Evaluator**: An actor that produces a structured judgment artifact.
- **Loop**: A bounded repeated subgraph, usually revise/review or plan/execute/verify.
- **Map**: Apply work over a list of items.
- **Replicate**: Ask multiple actors to independently attempt the same task.
- **Join**: Wait for multiple branches or artifacts.
- **Reduce**: Merge many artifacts into one.
- **Host adapter**: Instructions for how a playbook maps onto a specific environment (Codex, Claude Code, hook-enabled, compiled runtime).

### Important design rule (unchanged — this is the best idea in the spec)

A gate must **not** directly "ask an LLM." Instead:

```
evaluator actor → structured judgment artifact → deterministic gate condition
```

Example:

```yaml
- id: judge_quality
  kind: evaluator
  actor: substance_reviewer
  output: quality_judgment
- id: quality_gate
  kind: gate
  condition: no_blocking_issues
  on_pass: final
  on_fail: revise
```

This is the resolution to the "model is a soft interpreter" problem: judgment lives in an artifact (which the model is good at producing), control flow lives in a deterministic check on that artifact (which is verifiable). In tier-2 hosts, that deterministic check can additionally be enforced by a hook/CI gate.

### Loops

Bounded, explicit, artifact-driven, versioned by iteration. No unbounded "keep trying until good."

```yaml
limits:
  max_iterations: 2
  max_actor_calls: 12
```

### Normalized primitive model (design direction; do NOT build the compiler in v0)

Base primitives: `actor_call`, `tool_call`, `evaluator`, `gate`, `human_gate`, `router`, `map`, `replicate`, `join`, `reduce`, `loop`, `artifact_op`, `subworkflow`.

Each node generally has: `id` (string), `kind` (primitive_kind), `input` (object), `output` (object), `policies` (object). Design the schema with the typed control/dataflow graph in mind, but v0 ships schema + validation only.

## Starter playbook: code-change-review **[CORRECTED — now internally consistent and validates]**

The original draft referenced step ids (`implement_revision`, `review_revision`, `summarize_best_attempt`) that were never defined, which would fail reference-integrity validation. Below, the loop body and exhaustion target are fully defined, and the flow is depth-1 subagent safe.

```yaml
kind: AgentPlaybook
schema_version: 0.1
name: code-change-review
description: >
  Use planning, implementation, review, tests, and bounded revision for nontrivial code changes.
when_to_use:
  - nontrivial code change
  - multiple files may be touched
  - correctness matters
  - tests or review are useful
roles:
  coordinator:
    purpose: Plan, route, merge, and decide completion.
  implementer:
    purpose: Make the code change.
  substance_reviewer:
    purpose: Review correctness, architecture, edge cases, safety, and tests.
  style_reviewer:
    purpose: Review clarity, maintainability, conventions, and docs.
flow:
  - id: plan
    kind: actor_call
    actor: coordinator
    output: Plan

  - id: implement
    kind: actor_call
    actor: implementer
    input: [Plan]
    output: ImplementationResult

  - id: review
    kind: map
    over: [substance_reviewer, style_reviewer]
    input: [ImplementationResult]
    output: ReviewReport[]

  - id: review_gate
    kind: gate
    condition: no_blocking_issues   # reads the ReviewReport[] artifacts
    on_pass: test
    on_fail: revise

  - id: revise
    kind: loop
    max_iterations: 1
    body: [implement_revision, review_revision]
    until: no_blocking_issues
    on_exhausted: summarize_best_attempt

  # --- loop body steps (now defined) ---
  - id: implement_revision
    kind: actor_call
    actor: implementer
    input: [ImplementationResult, ReviewReport[]]
    output: ImplementationResult   # versioned per iteration; never overwrite prior

  - id: review_revision
    kind: map
    over: [substance_reviewer, style_reviewer]
    input: [ImplementationResult]
    output: ReviewReport[]          # versioned per iteration

  # --- loop exhaustion target (now defined) ---
  - id: summarize_best_attempt
    kind: actor_call
    actor: coordinator
    input: [ImplementationResult, ReviewReport[]]
    output: FinalSummary
    next: final

  - id: test
    kind: tool_call
    tool: test_runner
    output: TestResult
    next: final

  - id: final
    kind: actor_call
    actor: coordinator
    input: [ImplementationResult, TestResult]
    output: FinalSummary

policies:
  max_revision_loops: 1
  max_subagents: 4
  # ADVISORY in tier-1 hosts. For real enforcement, wire these to pre-commit/CI (tier 2).
  require_user_approval_for:
    - destructive_commands
    - dependency_addition
    - deploy
    - external_send
```

> **Depth note:** `map` over two reviewers spawns at most one level of subagents (depth 1). The revise loop re-runs `implement_revision` + `review_revision` at the top level, not nested inside another subagent, so it stays within Codex's default `max_depth: 1`. Do not introduce a primitive that requires a subagent to spawn its own subagents without documenting the opt-in.

## Run ledger

When the runner skill executes a playbook:

```
.fadeno/runs/<timestamp>-<slug>/
  run.yaml
  events.jsonl
  artifacts/
```

`run.yaml` example:

```yaml
run_id: 2026-05-30-1132-csv-export
playbook: code-change-review
status: running
task: Add CSV export for reports.
started_at: 2026-05-30T11:32:00-04:00
host: codex
artifacts_dir: artifacts
current_step: plan
```

`events.jsonl` example:

```json
{"type":"run_started","step":null,"timestamp":"2026-05-30T11:32:00-04:00"}
{"type":"step_started","step":"plan","timestamp":"2026-05-30T11:33:00-04:00"}
{"type":"artifact_created","step":"plan","artifact":"artifacts/plan.md","timestamp":"2026-05-30T11:35:00-04:00"}
```

The run ledger is the **degraded runtime** for tier-1 hosts (Codex, Claude Code). It is what makes runs inspectable and is the seam a future compiled runtime (tier 3) reads and writes.

## Fadeno runner skill (`.agents/skills/fadeno-runner/SKILL.md`)

```markdown
---
name: fadeno-runner
description: Execute Fadeno playbooks from `.fadeno/playbooks` for complex coding, review, research, or multi-step agent workflows. Use when the user asks to run a Fadeno playbook or names one, or when a task is complex enough to benefit from a repeatable plan/review/test workflow.
---
# Fadeno Runner
## Procedure
1. Read `.fadeno/vocabulary.md` and `references/runtime.md`.
2. Select the best playbook from `.fadeno/playbooks`.
3. Validate required inputs.
4. Create a new run directory under `.fadeno/runs/`.
5. Write `run.yaml`.
6. Append major lifecycle events to `events.jsonl`.
7. Execute each playbook step using available host capabilities.
8. If native subagents are available, delegate role-specific work to them (one level only; do not assume a subagent can spawn its own subagents).
9. If native subagents are unavailable, simulate role separation with separate passes and save each pass as a distinct artifact.
10. Save all major outputs under `artifacts/`.
11. Apply gates using structured judgment artifacts, not vague prose.
12. Respect loop limits; version iteration artifacts, never overwrite them.
13. Run tests or checks when the playbook requires them.
14. Return a final answer with: what changed, checks performed, gates passed/failed, and the path to the run directory.
## Rules
- Never run unbounded loops.
- Never skip a required gate silently.
- Never overwrite iteration artifacts; version them.
- Do not treat `.fadeno/runs/` as source code.
- Ask for user approval before destructive commands, dependency additions, deployments, or external sends. NOTE: in this (instruction-only) host these approvals are advisory; the repo's CI/pre-commit layer is the enforced backstop.
```

`agents/openai.yaml` (runner): **[NEW]**

```yaml
# Runner SHOULD fire implicitly on complex tasks — keep default implicit invocation on.
interface:
  displayname: "Fadeno Runner"
  shortdescription: "Run a Fadeno playbook with file-backed run traces."
allow_implicit_invocation: true
```

## Fadeno builder skill (`.agents/skills/fadeno-builder/SKILL.md`)

```markdown
---
name: fadeno-builder
description: Create or modify Fadeno playbooks from natural-language workflow descriptions. Use ONLY when the user explicitly wants to create, modify, simplify, or review a playbook. Do NOT trigger merely because a task mentions a playbook.
---
# Fadeno Builder
## Procedure
1. Understand the user's desired workflow.
2. Identify the closest pattern: simple_linear, plan_execute_verify, worker_reviewer_merge, research_synthesis, debate_judge, code_change_review, human_approval_gate.
3. Recommend a simple version first.
4. Generate YAML under `.fadeno/playbooks`.
5. Prefer explicit roles, typed artifacts, bounded loops, and structured gates.
6. Avoid excessive fanout.
7. Add comments only where helpful.
8. Run `fadeno validate` if available.
9. Summarize the playbook and when to use it.
```

`agents/openai.yaml` (builder): **[NEW]**

```yaml
# Builder should NOT fire accidentally on prompts that merely mention "playbook".
# Force explicit $fadeno-builder invocation.
interface:
  displayname: "Fadeno Builder"
  shortdescription: "Author or revise a Fadeno playbook."
allow_implicit_invocation: false
```

## Dual-target spec (Codex + Claude Code) **[NEW — full per request]**

The long-term goal is **harness neutrality**. v0 ships both `--codex` and `--claude` targets. They share 100% of playbook content, schemas, vocabulary, and SKILL.md *bodies*. Only the adapter surface differs.

| Concern | Codex (`--codex`) | Claude Code (`--claude`) |
|---|---|---|
| Skill dir | `.agents/skills/<name>/` | `.claude/skills/<name>/` |
| Bootstrap file | `AGENTS.md` | `CLAUDE.md` |
| Invocation sigil in bootstrap | `$fadeno-runner` | `/fadeno-runner` |
| Invocation policy file | `agents/openai.yaml` | frontmatter (`disable-model-invocation` for builder) |
| Subagent defs | `.codex/agents/*.toml` *(path provisional)* | `.claude/agents/*.md` |
| Deterministic gates | external CI/pre-commit | CI/pre-commit **or** Claude Code hooks (`.claude/settings.json`) |

Implementation guidance: a single template core with per-target emit. The `init` command takes the target flag and chooses (a) skill dir, (b) bootstrap filename + sigil, (c) subagent def format, (d) whether to scaffold a hooks/CI enforcement stub. **Do not fork the SKILL.md bodies per target** — keep one source and substitute the sigil/path tokens at emit time, or keep the bodies sigil-free and put sigils only in the bootstrap file.

### Tier-2 enforcement scaffold (forward-looking, optional in v0)

Because the long-term goal includes harnesses with deterministic hooks for sub-agent handling and gate enforcement, design the run ledger and gate conditions so a hook can read them. Concretely:

- Gate conditions (`no_blocking_issues`) should be computable from a structured judgment artifact on disk (e.g. `artifacts/review-report.json` validated against `review-report.schema.json`), so a deterministic checker — a Claude Code `Stop`/`PostToolUse` hook, a Codex-side CI check, or a future runtime — can evaluate the same condition without re-asking a model.
- `require_user_approval_for` categories should map to concrete, detectable actions (a pre-commit hook that blocks dependency-file changes, a CI check that fails on deploy-affecting diffs) so the enforcement is real and portable.
- v0 may ship these as **documented stubs / examples** in the README rather than wired-up enforcement, but the *data shapes* must already support them.

## CLI design

Preferred language: TypeScript unless repo context suggests otherwise.

```
src/
  cli.ts
  commands/
    init.ts
    validate.ts
  templates/
    common/                  # [NEW] shared: playbooks, schemas, vocabulary, SKILL.md bodies
    codex/                   # codex-specific: AGENTS.md, openai.yaml, .codex/agents/*.toml
    claude/                  # [NEW] claude-specific: CLAUDE.md, .claude/agents/*.md, hooks stub
  schema/
    playbook.schema.json
    run.schema.json
    review-report.schema.json
```

CLI commands:

```
fadeno init --codex
fadeno init --claude          # [NEW]
fadeno validate
fadeno validate .fadeno/playbooks/code-change-review.yaml
fadeno new-run code-change-review "Add CSV export"   # optional, may be stubbed
```

### `init --codex` / `init --claude` behavior

1. Detect repo root.
2. Create target-appropriate dirs (`.fadeno/`; `.agents/skills/` or `.claude/skills/`; `.codex/agents/` or `.claude/agents/`).
3. Write shared templates (playbooks, schemas, vocabulary) + target-specific templates (bootstrap file, invocation policy, subagent defs).
4. If bootstrap file exists, append a short Fadeno section unless already present.
5. Do not overwrite existing files unless `--force`.
6. Print next steps (with the correct sigil for the target).

### `validate` behavior

1. Load all YAML playbooks under `.fadeno/playbooks`.
2. Validate against `.fadeno/schemas/playbook.schema.json`.
3. **[NEW]** Reference-integrity check: every step id referenced by `on_pass`, `on_fail`, `next`, loop `body`, and `on_exhausted` must resolve to a defined step. (This is what would have caught the original `code-change-review` dangling references.)
4. Report errors with file path and field path.
5. Exit nonzero if invalid.

## Acceptance criteria

Deterministic (the coding agent can self-verify these):

1. `fadeno init --codex` and `fadeno init --claude` create the expected target file trees.
2. Generated playbooks validate — including reference-integrity.
3. Generated bootstrap file (`AGENTS.md`/`CLAUDE.md`) is short and points to Fadeno skills with the correct per-target sigil.
4. `fadeno validate` catches malformed YAML, schema violations, AND dangling step references.
5. Existing files are not overwritten without `--force`.
6. Basic tests cover init (both targets) and validate behavior.
7. README covers: what Fadeno is, why it exists, install/init, running a playbook (Codex and Claude Code), creating a playbook, what `.fadeno/runs/` contains, AND **the advisory-vs-enforced distinction** (tier-1 vs tier-2).

Model-mediated (NOT verifiable at build time — validate by running, treat as iteration 2):

8. Runner skill is sufficient for the host agent to execute a playbook using file-backed run artifacts.
9. Builder skill is sufficient for the host agent to create/modify playbooks.

> These two are evals, not unit tests. Do not block the v0 build on them; they require an actual agent session to assess. Ship the buildable core, then tune skill wording against real invocations.

## README pitch

> Fadeno is a portable playbook layer for AI coding agents. It lets teams define repeatable workflows — plan, implement, review, test, revise, summarize — as repo-native YAML playbooks and skills. Fadeno works without a heavyweight runtime: in Codex or Claude Code it uses instructions, subagents when available, and file-backed run traces. Approval policies are advisory in instruction-only hosts; for hard guarantees, wire gates to your pre-commit/CI layer (or Claude Code hooks), which keeps enforcement deterministic and harness-portable. In richer environments, the same playbooks can compile into a real orchestration runtime.

## Development style

Keep it boring and reliable. Prefer simple templates, clear schemas, explicit file paths, deterministic CLI behavior, good error messages, minimal dependencies. Avoid clever runtime abstractions, complex graph execution in v0, hidden magic, provider lock-in, excessive template complexity.

## First implementation plan

1. Create project skeleton.
2. Add CLI parser (with `--codex` / `--claude` target flag).
3. Implement `init` with a shared template core + per-target emit.
4. Add templates (common + codex + claude).
5. Add schemas.
6. Implement `validate` (schema + reference-integrity).
7. Add tests (both init targets, validate including dangling-ref case).
8. Write README (including tier-1 vs tier-2 enforcement framing).
9. Run formatter/linter/tests.
10. Produce final summary with created files and usage examples for both Codex and Claude Code.

## Open item to verify during build (non-blocking)

- Confirm the current Codex subagent config path/format (`.codex/agents/*.toml` is provisional). If different, fix the emitted template; the runner's graceful-degradation path means this does not block v0.

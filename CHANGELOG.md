# Changelog

All notable changes to Fadeno are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

_Nothing yet._

## [0.4.0] — 2026-07-13

The coordinator layer — deterministic prompt assembly and a cross-harness
driver. A run can now be assembled and advanced from its ledger alone: one
command renders the exact prompt a step's actor receives, another computes the
next actionable step, and a driver skill walks the two to run a playbook
end-to-end across harnesses. `fadeno` still never invokes a model — it renders
and computes; the harness does the dispatch.

### Added

- **`fadeno prompt <run> <step>`** — deterministic step-prompt assembly (the twin
  of `fadeno diagram`). A pure function of the validated playbook, the run
  ledger (events through the invocation's `step_started` cutoff), the referenced
  artifact bytes, and the selection. Records an immutable snapshot under
  `artifacts/prompts/**` plus a `prompt_assembled` manifest event (per-input
  path/bytes/sha256, playbook + prompt sha256) by default; `--no-record` is a
  read-only preview. Pipe it into a sub-harness: `fadeno prompt <run> <step>
  --actor <role> | { claude -p; codex exec - }`.
- **`fadeno next <run>`** — a pure, read-only flow cursor (the third render twin
  of `diagram` and `prompt`). Emits the single next actionable step as JSON —
  `status` one of `ready` / `blocked_human_gate` / `needs_decision` / `terminal`,
  with the step's kind, actors, resolved output paths, gate/human-gate blocks,
  and loop state — so a driver can advance a run mechanically. Shares one
  output-path planner with `fadeno prompt`, so the cursor can never advertise a
  path the prompter would refuse.
- **`driver` skill** (Claude Code + Codex) — the cross-harness runner. The host
  stays pure (pick a playbook, gather inputs, `fadeno new-run`, dispatch); a
  driver subagent owns the ledger and runs each role as a uniform sub-harness CLI
  call, pausing and returning to the host at a `human_gate` so state-on-disk
  makes resume free.
- **`fadeno run --member <m>` / `--field k=v`** — attach a map-member attribution
  (`member`) or arbitrary fields to an appended event (e.g. `human_decision`
  with `branch=approve`); values that parse as JSON are stored decoded.
- **Playbook schema:** optional `output_path` (step template or member→template
  map; tokens `{actor}` / `{iteration}`), `input_bindings`, and top-level
  `artifact_contracts`, with matching validator checks.

## [0.3.0] — 2026-07-11

Trace verification — the provenance layer. A run ledger's claims can now be
re-audited deterministically: in CI, a git hook, or a Claude Code Stop hook.

### Added

- **`fadeno verify <run-id-or-prefix>`** (or `--latest`) — a strictly read-only
  re-audit of a run ledger: schema-valid `run.yaml`, fully parseable
  `events.jsonl`, a finalized terminal status, artifacts present, and **every
  recorded gate result recomputed from its artifact** — a trace can't claim a
  gate its artifact doesn't support. Unknown gate conditions are skipped as
  agent-interpreted rather than failed; `--allow-failed` accepts an honest
  `failed`/`aborted` terminal for audit use.
- **`init --with-hooks` emits `.github/workflows/fadeno-verify.yml`** — a CI
  workflow that verifies every run ledger a PR adds or modifies ("no valid
  trace with passing gates, no merge"). Deletion-only PRs pass; strict mode
  (require a trace on every PR) is one uncomment away.

### Changed

- The Claude Code Stop-hook example upgrades from a single `fadeno gate` check
  to `fadeno verify --latest`: when the agent stops, the latest run must be
  finalized and its gate claims must recompute from their artifacts.

## [0.2.0] — 2026-07-11

Formalize code-change workflow semantics: explicit loop exits, artifact-bound
gates, structured test results, path-aware validation, and honest failed-run
terminals. Also adds a trace-reading CLI (`fadeno runs` / `fadeno show`) and a
falsifiable evaluation harness for the runner skill.

### Added

- `tests_pass` and the `test-result.schema.json` artifact contract.
- Definite-artifact and normalized control-flow validation, including reachability,
  loop ownership, terminal statuses, and deterministic condition bindings.
- Gate and loop lifecycle event conventions in the runner ledger.
- `fadeno runs` lists run ledgers newest-first; `fadeno show <run-id-or-prefix>`
  renders one run as a summary, event timeline, and artifact listing. Malformed
  `run.yaml` files or `events.jsonl` lines are reported, never fatal.
- A falsifiable evaluation suite under `evals/` — five fixtures, three treatments,
  deterministic oracles, isolated workspaces — with a pilot report
  (`evals/pilot-report.md`). Repo-only; not part of the npm package.

### Changed

- `code-change-review` now distinguishes resolved review, exhausted review, passing
  tests, and failing tests.
- `fadeno gate` validates named artifacts and accepts `--artifact`; `--report` is
  retained as a deprecated alias.
- Claude's example Stop hook preserves non-zero gate failures and handles a missing
  run explicitly.

## [0.1.5] — 2026-05-31

Runner-guidance clarifications and a stronger plugin drift guard. No CLI behavior
changes — but the runner instructions are bundled templates, so plugin users
receive these via the version bump.

### Changed

- **Gate report-file convention is pinned.** The runner runtime reference now
  states that a reviewer `map` feeding a gate writes its reports as a single
  `review-report.json` array (which `fadeno gate` already reads), resolving the
  ambiguity with the per-item artifacts a `map` otherwise produces.
- **The plugin no-drift test is hardened.** It now diffs the entire generated
  plugin tree (file set + contents, both directions) and asserts the bundled
  `plugin/bin/fadeno` reports the current version, instead of checking a single
  `SKILL.md` — so a stale `plugin/` after any template edit or a missed rebuild
  on a version bump is caught.

### Documentation

- **Conventional `events.jsonl` event types** are listed in the runtime
  reference (`run_started`, `step_started`, `artifact_created`, `gate_evaluated`,
  `roles_degraded`, and a terminal `run_completed`/`run_failed`/`run_aborted`);
  the log stays open via `fadeno run --event <type>`.
- **Contributor docs** added: a root `AGENTS.md` orientation hub plus
  `docs/architecture.md` (codebase map) and `docs/extending.md` (file-by-file
  recipes for common changes).

## [0.1.4] — 2026-05-31

Fewer permission prompts.

### Added

- **`fadeno init --claude` pre-approves the CLI.** A full builder→runner flow
  makes ~a dozen `fadeno` calls, each of which otherwise triggers a Bash
  permission prompt. `init` now merges a `Bash(fadeno:*)` allow rule into
  `.claude/settings.local.json` (local, git-ignored) and ensures that file is
  git-ignored, so the CLI stops prompting on every call. Non-destructive
  (preserves existing rules, idempotent), announced on stdout, and easy to undo
  (delete the rule). Applies to the `--data-only` plugin-seed path too, where the
  prompts bite most. Plugins can't grant themselves Bash permissions, so `init`
  is the seam for this rather than the plugin.

## [0.1.3] — 2026-05-31

Prettier deterministic diagrams.

### Changed

- **`fadeno diagram` ASCII output is now a column of boxed cards** — one per
  step, with `▼` for sequential fall-through and `⋮` for a step reached only via
  a labelled `▶` arrow (a gate branch, loop exit, or jump). Loop bodies are
  inlined into the loop card. No 2-D edge routing, so it stays correct for any
  playbook.
- **Verbose primitive kinds are abbreviated in diagrams** (display only — the
  schema/vocabulary keep the full names): `actor_call` → `actor`,
  `tool_call` → `tool`, `evaluator` → `eval`, `human_gate` → `ask`,
  `artifact_op` → `artifact`, `subworkflow` → `subflow`. Applied to both the
  ASCII and Mermaid renderers.

## [0.1.2] — 2026-05-31

Live-session feedback fixes — ledger fidelity and runner robustness. The full
plugin surface (bundled CLI on PATH, `Skill(fadeno:*)` model-invocation,
`/fadeno:*` slash commands, and `fadeno:*` subagent dispatch) was confirmed
working end-to-end in live Claude Code sessions on this release.

### Fixed

- **Ledger fidelity.** `fadeno run` now stamps each event with the run's
  `current_step` instead of `null` (an explicit `--step` still wins; run-level
  events like `run_started`/`run_completed` stay `null`). `fadeno new-run`
  builds run ids from **local** date/time (`started_at` stays UTC ISO) and slugs
  the task on **word boundaries** rather than cutting mid-word.
- **CLI discoverability.** Skills call the bundled binary via
  `"${CLAUDE_PLUGIN_ROOT}/bin/fadeno"` when bare `fadeno` isn't yet on PATH (the
  plugin's PATH entry can lag a `/reload-plugins` within a session).

### Changed

- **Role degradation is now loud.** When role subagents aren't available, the
  runner says so, runs each role as a separate pass, and records a
  `roles_degraded` event — so a degraded run never reads as if it had used
  dedicated subagents.

### Documentation

- A terminal `evaluator` (no following `gate`) is documented as legitimate: when
  the structured judgment *is* the deliverable, it validates clean.
- README documents the post-install `/reload-plugins` step that registers the
  role subagents.

## [0.1.1] — 2026-05-30

Claude plugin invocation fixes.

### Fixed

- **Builder is invocable again.** `disable-model-invocation: true` had made the
  builder skill unreachable by both the model and slash invocation. The gate is
  removed; the builder is model-invocable, and its scoped description keeps it
  from auto-firing on ordinary coding tasks.

### Added

- **Plugin slash commands** `/fadeno:runner` and `/fadeno:builder` (new
  `templates/common/commands/`) — the discoverable `/`-menu front door that
  drives the matching skills.

### Changed

- Role subagents renamed `fadeno-worker`/`fadeno-reviewer`/`fadeno-judge` →
  **`worker`/`reviewer`/`judge`** on both hosts, so they address as
  `fadeno:worker` (not the double-prefixed `fadeno:fadeno-worker`). Runner
  references now cover reload/restart registration and namespacing.

## [0.1.0] — 2026-05-30

Initial v0 — the portable, repo-native playbook layer.

### Added

- **CLI:** `init` (`--codex`/`--claude`, `--with-hooks`, `--data-only`,
  `--force`), `validate`, `diagram` (`--format ascii|mermaid`), `new-run`,
  `run`, `gate`, `plugin`. Built on Node's `parseArgs` + `node --test`; runtime
  dependencies are only `ajv` + `yaml`.
- **Dual-target scaffolding** from one template core (Codex + Claude Code),
  non-destructive (append-or-create, skip-unless-`--force`, idempotent).
- **Schemas** (`playbook`, `run`, `review-report`) and **starter playbooks**
  (`code-change-review`, `research-synthesis`, `pr-review`), plus runner and
  builder skills with bundled references.
- **Validation:** schema + reference-integrity + semantics (actor-must-be-a-
  declared-role errors; unproduced-input and unused-role warnings); also
  validates run ledgers and review reports.
- **Run ledger** (`run.yaml` / `events.jsonl` / `artifacts/`) with CLI helpers
  and a deterministic `gate no_blocking_issues` evaluator — the
  advisory→enforced bridge.
- **Builder arc + diagrams:** seed → starter-or-NL → write → validate → diagram
  → human-gate approval → hand off to the runner.
- **Tier-2 enforcement scaffold** via `--with-hooks` (executable pre-commit
  guard, CI workflow, Claude hook example).
- **Claude plugin packaging:** `fadeno plugin` generates `plugin/` from the same
  templates; the CLI is bundled self-contained into `plugin/bin/`; a repo-root
  `.claude-plugin/marketplace.json` makes the repo directly installable
  (`/plugin install fadeno@fadeno`).

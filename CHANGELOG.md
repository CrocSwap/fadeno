# Changelog

All notable changes to Fadeno are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

_Nothing yet._

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

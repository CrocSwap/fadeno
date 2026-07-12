# Fadeno roadmap

Where the shipped/deferred line sits, so it lives in the repo rather than in
chat. v0's scope and non-goals come from `docs/kickoff-memo.md`.

## Shipped (v0)

- CLI: `init --codex|--claude [--with-hooks] [--data-only] [--force]`,
  `validate [file] [--schema]`, `diagram [--format ascii|mermaid]`, `new-run`,
  `run`, `gate`, `runs`, `show`, `plugin`.
- Dual-target scaffolding from one template core (Codex + Claude Code), non-destructive.
- **Claude plugin** packaging: `fadeno plugin` generates a `plugin/` (skills,
  `/fadeno:runner` + `/fadeno:builder` slash commands, and `worker`/`reviewer`/
  `judge` role subagents) from the same templates; repo root carries a
  `.claude-plugin/marketplace.json`, so the repo is directly installable
  (`/plugin install fadeno@fadeno`). `init --data-only` seeds just the per-repo
  definitions for plugin users (the capability/definitions split). The plugin is
  **self-contained**: `npm run build:bin` bundles the CLI (deps inlined) into
  `plugin/bin/fadeno` + adjacent templates, committed so a git-URL install yields
  a working `fadeno` with no extra step. (A `prepare` script also makes
  `npm i -g github:…` build a working binary.)
- **Builder arc + diagrams:** the builder seeds → offers starters or NL → writes
  the playbook → renders it (`fadeno diagram`, ASCII or Mermaid) → human-gate
  approval → hands off to the runner; runner explains role↔subagent management.
- Schemas: `playbook`, `run`, `review-report`. Starter playbooks: `code-change-review`,
  `research-synthesis`, `pr-review`. Runner + builder skills.
- Validation: schema + reference-integrity (errors) + **semantics** — `actor` must be a
  declared role (error); unproduced `input` artifact and unused role (warnings). Also
  validates `run.yaml` / `review-report.json` (auto-detected or `--schema`).
- `$schema` editor modelines in generated YAML (playbooks + run ledgers).
- Run ledger (`run.yaml` / `events.jsonl` / `artifacts/`) with CLI helpers (`run`,
  `runs` list, `show` timeline) and a deterministic gate evaluator
  (`gate no_blocking_issues`) — the advisory→enforced bridge.
- Tier-2 enforcement scaffold via `--with-hooks` (pre-commit, CI workflow, Claude hook example).
- **Validated end-to-end in live Claude Code sessions** (through v0.1.2): bundled
  CLI on PATH, `Skill(fadeno:*)` model-invocation, `/fadeno:*` slash commands in
  the `/` menu, and `fadeno:*` role-subagent dispatch after `/reload-plugins`.

## Specified but advisory / not demonstrated (honest gaps in v0)

- 5 primitives are schema-valid but unused by any starter and have no executor:
  `router`, `replicate`, `join`, `artifact_op`, `subworkflow`. Documented contracts, not
  demonstrated behavior.
- `require_user_approval_for` is advisory in tier-1 hosts (the model is *asked*).
- `gate` only computes `no_blocking_issues` today; other conditions are agent-interpreted.
- Skill *sufficiency* (kickoff memo acceptance #8–#9) is model-mediated — needs live-session
  evaluation, not unit tests.
- Codex subagent path (`.codex/agents/*.toml`) is provisional; runner degrades to role-passes.
  (The Claude plugin subagents are now verified live; Codex's remain unverified.)

## Next (deferred, roughly prioritized)

1. **Authoring helpers** — `fadeno list` (playbooks + `when_to_use`),
   `fadeno new-playbook <pattern>` scaffolder. (`fadeno diagram` already ships.)
2. **More gate conditions** in `fadeno gate` (e.g. `no_unsupported_claims` from a
   fact-check report) + a fact-check artifact schema, widening deterministic enforcement.
3. **More harness targets** — Cursor and others (SKILL.md is a cross-harness standard, so
   it's mostly adapter work: install dir, bootstrap file, invocation policy, subagent format).
4. **Eval harness** for the runner/builder skills — a repeatable way to measure whether a
   real agent session produces good runs (the actual product risk).
5. **Schema versioning / migration** as `schema_version` moves past `0.1`.
6. **Richer ledger** — per-step token/cost accounting (the `fadeno runs` /
   `fadeno show` summary view already ships).
7. **Diagram artifact/data-flow edge labels** — `fadeno diagram` annotating the
   input/output artifacts that flow along each edge, not just the control flow.

## Explicit non-goals (from the kickoff memo)

Full runtime / real execution engine, the primitive compiler (tier 3), background
scheduler / daemon / cloud service, visual graph editor, web UI, real parallel execution,
model-provider integrations, and hard permission enforcement *inside* Fadeno (enforcement
belongs in git/CI/hooks — tier 2).

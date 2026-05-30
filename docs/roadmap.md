# Fadeno roadmap

Where the shipped/deferred line sits, so it lives in the repo rather than in
chat. v0's scope and non-goals come from `docs/kickoff-memo.md`.

## Shipped (v0)

- CLI: `init --codex|--claude [--with-hooks] [--data-only] [--force]`,
  `validate [file] [--schema]`, `diagram [--format ascii|mermaid]`, `new-run`,
  `run`, `gate`, `plugin`.
- Dual-target scaffolding from one template core (Codex + Claude Code), non-destructive.
- **Claude plugin** packaging: `fadeno plugin` generates a `plugin/` (skills +
  role subagents) from the same templates; repo root carries a
  `.claude-plugin/marketplace.json`, so the repo is directly installable
  (`/plugin install fadeno@fadeno`). `init --data-only` seeds just the per-repo
  definitions for plugin users (the capability/definitions split).
- **Builder arc + diagrams:** the builder seeds → offers starters or NL → writes
  the playbook → renders it (`fadeno diagram`, ASCII or Mermaid) → human-gate
  approval → hands off to the runner; runner explains role↔subagent management.
- Schemas: `playbook`, `run`, `review-report`. Starter playbooks: `code-change-review`,
  `research-synthesis`, `pr-review`. Runner + builder skills.
- Validation: schema + reference-integrity (errors) + **semantics** — `actor` must be a
  declared role (error); unproduced `input` artifact and unused role (warnings). Also
  validates `run.yaml` / `review-report.json` (auto-detected or `--schema`).
- `$schema` editor modelines in generated YAML (playbooks + run ledgers).
- Run ledger (`run.yaml` / `events.jsonl` / `artifacts/`) with CLI helpers (`run`) and a
  deterministic gate evaluator (`gate no_blocking_issues`) — the advisory→enforced bridge.
- Tier-2 enforcement scaffold via `--with-hooks` (pre-commit, CI workflow, Claude hook example).

## Specified but advisory / not demonstrated (honest gaps in v0)

- 5 primitives are schema-valid but unused by any starter and have no executor:
  `router`, `replicate`, `join`, `artifact_op`, `subworkflow`. Documented contracts, not
  demonstrated behavior.
- `require_user_approval_for` is advisory in tier-1 hosts (the model is *asked*).
- `gate` only computes `no_blocking_issues` today; other conditions are agent-interpreted.
- Skill *sufficiency* (kickoff memo acceptance #8–#9) is model-mediated — needs live-session
  evaluation, not unit tests.
- Codex subagent path (`.codex/agents/*.toml`) is provisional; runner degrades to role-passes.

## Next (deferred, roughly prioritized)

1. **Reachability / orphan-step analysis** — deferred from the semantics pass because the
   flow model mixes implicit sequential fall-through with explicit branches/loop bodies;
   it needs a firmer execution-order spec before reachability can avoid false positives.
2. **Authoring helpers** — `fadeno list` (playbooks + `when_to_use`),
   `fadeno new-playbook <pattern>` scaffolder. (`fadeno diagram` already ships.)
3. **Bundle the CLI with the plugin** — today the plugin's skills call the `fadeno`
   CLI, which is a separate `npm i -g fadeno` / `npx`. Ship it in the plugin's
   `bin/` (single-file build) so plugin install is fully self-contained.
3. **More gate conditions** in `fadeno gate` (e.g. `no_unsupported_claims` from a
   fact-check report) + a fact-check artifact schema, widening deterministic enforcement.
4. **More harness targets** — Cursor and others (SKILL.md is a cross-harness standard, so
   it's mostly adapter work: install dir, bootstrap file, invocation policy, subagent format).
5. **Eval harness** for the runner/builder skills — a repeatable way to measure whether a
   real agent session produces good runs (the actual product risk).
6. **Schema versioning / migration** as `schema_version` moves past `0.1`.
7. **Richer ledger** — per-step token/cost accounting and a `fadeno runs` summary view.

## Explicit non-goals (from the kickoff memo)

Full runtime / real execution engine, the primitive compiler (tier 3), background
scheduler / daemon / cloud service, visual graph editor, web UI, real parallel execution,
model-provider integrations, and hard permission enforcement *inside* Fadeno (enforcement
belongs in git/CI/hooks — tier 2).

# Fadeno roadmap

Where the shipped/deferred line sits, so it lives in the repo rather than in
chat.

## Design status and precedence

Fadeno now has three intentionally different design horizons:

1. [`kickoff-memo.md`](kickoff-memo.md) records the rationale and scope of the
   shipped v0 advisory protocol. It remains historical design context.
2. [`experimental/next-protocol.md`](experimental/next-protocol.md) is the
   approved boundary for the next implementation: a small deterministic,
   repo-local engine whose purpose is verification and legible execution
   evidence.
3. [`experimental/ontology-and-execution-design.md`](experimental/ontology-and-execution-design.md)
   is the North Star vocabulary, not an implementation checklist. Concepts move
   into the core only after an observed run needs them and `fadeno verify` can
   check a meaningful property about them.

The next-protocol engine decision deliberately supersedes v0's "no runtime"
constraint for forward work. It does not authorize a daemon, cloud service,
general scheduler, or orchestration platform.

## Shipped (v0)

- CLI: `init --codex|--claude [--with-hooks] [--data-only] [--force]`,
  `validate [file] [--schema]`, `diagram [--format ascii|mermaid]`, `new-run`,
  `run`, `gate`, `prompt`, `next`, `runs`, `show`, `verify`, `plugin`.
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
  `prompt`, `next`, `runs` list, `show` timeline, and whole-trace `verify`) and
  deterministic gate evaluators (`no_blocking_issues`, `tests_pass`) — the
  advisory→enforced bridge. The driver skill composes these helpers into the
  current model-mediated execution procedure.
- Tier-2 enforcement scaffold via `--with-hooks` (pre-commit, CI workflow, Claude hook example).
- **Validated end-to-end in live Claude Code sessions** (through v0.1.2): bundled
  CLI on PATH, `Skill(fadeno:*)` model-invocation, `/fadeno:*` slash commands in
  the `/` menu, and `fadeno:*` role-subagent dispatch after `/reload-plugins`.

## Specified but advisory / not demonstrated (honest gaps in v0)

- 5 primitives are schema-valid but unused by any starter and have no executor:
  `router`, `replicate`, `join`, `artifact_op`, `subworkflow`. Documented contracts, not
  demonstrated behavior.
- `require_user_approval_for` is advisory in tier-1 hosts (the model is *asked*).
- Conditions other than `no_blocking_issues` and `tests_pass` remain
  agent-interpreted unless and until a deterministic evaluator ships.
- Skill *sufficiency* (kickoff memo acceptance #8–#9) is model-mediated — needs live-session
  evaluation, not unit tests.
- Codex subagent path (`.codex/agents/*.toml`) is provisional; runner degrades to role-passes.
  (The Claude plugin subagents are now verified live; Codex's remain unverified.)

## Next protocol (in progress — provenance slice shipped)

The implementable boundary is defined in
[`experimental/next-protocol.md`](experimental/next-protocol.md). Its six
promoted capabilities are:

1. a small deterministic engine grown from the existing `next` cursor and
   driver procedure;
2. runtime identity with flattened attempt ordinals and reasons, not a rich
   attempt lifecycle;
3. immutable artifact manifests and digests;
4. minimal execution profiles with direct role-to-executor bindings, without
   capability routing or ranking;
5. one durable, named, idempotent human-decision structure, also used for
   workflow-selection confirmation;
6. canonical evidence, expanded verification, and a default human-legible run
   projection.

**Capabilities 3 and 6 shipped thin (unreleased):** run-ledger format 0.2
(`schema_version` in run.yaml + contiguous per-event `seq`), artifact
manifests with sha256 digests and record-time typed-artifact validation on
`artifact_created` (immutability guard included), a 16-check `fadeno verify`
(digests, seq, terminal coherence, active/superseded resolution,
prompt-snapshot integrity, conflicting human decisions — unrecomputable
evidence reported as skipped, never silently valid), a logical-step
projection as the default `fadeno show`, and an explicit `--legacy`
compatibility mode (readers refuse unversioned ledgers; writers refuse them
outright). Deliberately deferred to the engine slices: the engine loop (1),
attempt ordinals / execution identities (2), executor profiles (4), the named
human-decision structure (5), and an explicit supersede event.

The protocol is not schema-frozen. Run two or three additional dogfood workflows
and require both an observed receipt and a verification check before promoting
more North Star entities. Old document versions must be rejected or read in an
explicit compatibility mode, never silently reinterpreted. Preserve cheap or
loud migration paths for user-authored playbooks; old ledgers may remain legacy
output. Team-level provenance is anchored by committed evidence plus
`fadeno verify` in CI; hash chaining remains a possible standalone mechanism,
not current scope.

## Other deferred work (roughly prioritized)

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

## Continuing non-goals

The next protocol includes a deliberately small runtime, so the kickoff memo's
blanket runtime non-goal is historical rather than forward policy. Still out of
scope: a background scheduler, daemon, cloud service, general orchestration or
provider platform, unrestricted parallel scheduler, visual graph editor, web
UI, and hard permission enforcement *inside* Fadeno (enforcement belongs in
git/CI/hooks — tier 2).

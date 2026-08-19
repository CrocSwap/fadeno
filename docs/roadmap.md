# Fadeno roadmap

Where the shipped/deferred line sits, so it lives in the repo rather than in
chat.

## Design status and precedence

Fadeno now has seven intentionally different design horizons:

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
4. [`experimental/compositional-runtime.md`](experimental/compositional-runtime.md)
   is a dogfood-promoted extension of the next protocol. It specifies recursive
   fan-out/aggregation containers and durable node-instance identity; it does
   not authorize a daemon or general distributed scheduler.
5. [`experimental/loadouts-and-dispatch.md`](experimental/loadouts-and-dispatch.md)
   is the approved boundary for the dispatch kernel: archetype→executor
   loadouts switchable at session level, and ad-hoc cross-harness dispatch
   (`fadeno dispatch`) with the playbook engine as one client of the same
   resolver. It does not authorize auto-fallback across providers or a
   resident router.
6. [`experimental/slots-and-archetypes.md`](experimental/slots-and-archetypes.md)
   is the successor boundary for the dispatch kernel: the slot as the unit of
   model policy (preset → session override → shadow attachment), archetype
   policy earned by kernel enforceability, and constraint tiers at the single
   dispatch chokepoint. It does not authorize a policy language or a
   Fadeno-owned model roster.
7. [`experimental/dials-and-registry.md`](experimental/dials-and-registry.md)
   is the proposed successor for executor *selection*: named loadout presets
   retire in favor of per-archetype dials on a layered cascade
   (session > repo > user > host-native base), with a model registry that
   makes bare model names resolve deterministically — model-first grammar
   (`model[@effort]`, `--via <driver>`), driver-level quirk translation, and
   dial-time backend verification for unregistered models. Everything
   downstream of resolution (archetype policy, constraints, shadows,
   evidence) carries forward unchanged. It does not reintroduce presets as a
   resolution layer or authorize auto-fallback across providers.

The next-protocol engine decision deliberately supersedes v0's "no runtime"
constraint for forward work. It does not authorize a daemon, cloud service,
general scheduler, or orchestration platform.

## Shipped (v0)

- CLI: `setup`, `use`, `status`, `doctor`, `vendor`, `uninstall`, `clean`,
  `unvendor`, `evidence promote`, plus
  `init --codex|--claude|--grok [--with-hooks] [--with-steering|--no-steering] [--data-only] [--force]`,
  `validate [file] [--schema]`, `diagram [--format ascii|mermaid]`, `new-run`,
  `run`, `tool-run`, `tool-complete`, `gate`, `prompt`, `next`, `drive`, `loadout`,
  `steering`, `dispatch*`, `completion`, `runs`, `show`, `verify`, `plugin`.
- Tri-target scaffolding from one template core (Codex, Claude Code, and Grok Build),
  non-destructive. Grok's native adapter emits `.grok/skills`, `.grok/agents`,
  and `AGENTS.md` without mutating permission files.
- **Claude plugin** packaging: `fadeno plugin` generates a `plugin/` (skills,
  `/fadeno:runner` + `/fadeno:builder` slash commands, and `worker`/`reviewer`/
  `judge` role subagents) from the same templates; repo root carries a
  `.claude-plugin/marketplace.json`, so the repo is directly installable
  (`/plugin install fadeno@fadeno`). The plugin carries the CLI and immutable
  built-in definitions. `init --data-only` seeds per-repo definitions plus
  driver policy (not host capability);
  `vendor` deliberately emits the complete project capability and definition
  surface plus a lock. The plugin is
  **self-contained**: `npm run build:bin` bundles the CLI (deps inlined) into
  `plugin/bin/fadeno` + adjacent templates, committed so a git-URL install yields
  a working `fadeno` with no extra step. (A `prepare` script also makes
  `npm i -g github:…` build a working binary.)
- **Builder arc + diagrams:** the builder seeds → offers starters or NL → writes
  the playbook → renders it (`fadeno diagram`, ASCII or Mermaid) → human-gate
  approval → hands off to the runner; runner explains role↔subagent management.
- Schemas: `playbook`, `run`, `review-report`. Starter playbooks: `code-change-review`,
  `research-synthesis`, `pr-review`, `compositional-review`. Runner, builder,
  and driver skills.
- Validation: schema + reference-integrity (errors) + **semantics** — `actor` must be a
  declared role (error); unproduced `input` artifact and unused role (warnings). Also
  validates `run.yaml` / `review-report.json` (auto-detected or `--schema`).
- `$schema` editor modelines in generated YAML (playbooks + run ledgers).
- Repo-local runtime and run ledger (`run.yaml` / `events.jsonl` / `artifacts/`) with CLI helpers (`run`,
  `prompt`, `next`, `runs` list, `show` timeline, and whole-trace `verify`) and
  deterministic gate evaluators (`all_reviews_approved`, `no_blocking_issues`, `tests_pass`) — the
  advisory→enforced bridge. The driver skill composes these helpers into the
  current model-mediated execution procedure.
- Tier-2 enforcement scaffold via `--with-hooks` (pre-commit, CI workflow, Claude hook example).
- Default loadout steering for Codex and Claude (with `--no-steering` opt-out):
  hybrid Codex custom agents plus `fadeno steering apply`, and a selective Claude `PreToolUse` rewrite. Codex
  switches command slots live, executes matching host slots in-session, invokes
  an explicit `fallback_command` for mismatched host slots, and reports
  `restart_required` only when no honest fallback exists;
  Explore/Plan stays unsteered. Grok steering remains unsupported.
- **Validated end-to-end in live Claude Code sessions** (through v0.1.2): bundled
  CLI on PATH, `Skill(fadeno:*)` model-invocation, `/fadeno:*` slash commands in
  the `/` menu, and `fadeno:*` role-subagent dispatch after `/reload-plugins`.

## Specified but advisory / not demonstrated (honest gaps in v0)

- 5 primitives are schema-valid but unused by any starter and have no executor:
  `router`, `replicate`, `join`, `artifact_op`, `subworkflow`. Documented contracts, not
  demonstrated behavior.
- `require_user_approval_for` is advisory in tier-1 hosts (the model is *asked*).
- Conditions other than `all_reviews_approved`, `no_blocking_issues`, and `tests_pass` remain
  agent-interpreted unless and until a deterministic evaluator ships.
- Skill *sufficiency* (kickoff memo acceptance #8–#9) is model-mediated — needs live-session
  evaluation, not unit tests.
- Codex custom-agent definitions now match the documented project TOML schema,
  but their Fadeno steering behavior remains unverified in a live Codex session.
  (The Claude plugin subagents are verified live; the new Claude rewrite hook
  still needs the same live-session dogfood pass.)

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

**Capabilities 1, 2, 4, and 5 shipped thin:** the engine —
`fadeno drive` owns the transition loop over the same pure cursor (`next`),
dispatching each actor step through a **command-adapter executor** from
`.fadeno/executors.yaml` (direct role bindings + `"*"` default; profile
snapshotted into the run dir and digest-checked), validating typed outputs
with **one bounded schema repair** (rejected bytes parked under
`artifacts/attempts/` as evidence, never at the planned path), and minting
runtime identity on its events: `step_execution_id`, `actor_call_id`,
`attempt` + `attempt_reason` (`initial`/`schema_repair`/`executor_override`/
`user_retry`). Human gates pause the engine with a durable named
`decision_requested`; `fadeno decide <run> <option>` records the idempotent,
conflict-refusing `decision_resolved` (also readable by the cursor). Explicit
substitution is `fadeno drive --bind role=executor`, recorded as
`executor_override`. An explicit `artifact_superseded` event (validated at
record time) retires an artifact from active resolution without a new
generation. Executors are **memoryless one-shot commands by default**; one
that declares `resume` is session-capable — the engine keeps one harness
session per role per run (engine-minted `{session_id}` or
harness-assigned via `session_id_pattern`), marks every dispatch and
resulting artifact `session: fresh|resumed` + id, and sends a resumed schema
repair as only the repair message. Resumed context is **attested, not
recomputable** — the honest trade for cross-step memory; bias memoryless.
`fadeno verify` grew from 16 to **29 checks**: attempt-ordinal contiguity +
reasons, binding-matches-snapshot-or-override, named-decision
validity/at-most-once, supersede reference integrity, session-continuity
(a resumed id must exist earlier, same role, same executor), plus
`tool-result-coherence`, `tool-command-digest`, and `tool-lifecycle`. `fadeno show`
surfaces actor calls, attempts, schema repairs, resumed sessions,
`! waiting for human decision`, and harness-observed tool claims. Engine-executable today: actor_call/evaluator/reduce/role-maps
(with collective assembly), deterministic gates, loops, human gates, and
`tool_call` for `test-result` via `fadeno tool-run` / `fadeno drive` (registered tools only; `Diff`/`PostResult` remain manual via `tool-complete`); the undemonstrated primitives still hand back to the driver.

### Accepted next slice: compositional containers

The five-item Luna/Terra dogfood showed that a role-list map plus one global
loop cannot represent independently advancing review cycles. The accepted
boundary is now recursive composition: `map`, `replicate`, and `loop` own child
graphs, so `map(loop(...))` and `loop(map(...))` have distinct, executable
semantics. `join` and `reduce` operate on child-instance results.

The first vertical slice is **shipped for host executors** rather than
making the schema accept graphs the engine cannot drive:

1. hierarchical `node_instance_id` and lexical artifact scope;
2. a deterministic runnable frontier replacing the single global cursor for
   compositional playbooks;
3. independent map-member and loop-generation state;
4. batched host dispatch and progress attributed to node instances;
5. graph-expanded `show` and containment-aware `verify`;
6. map-of-loop and loop-of-map acceptance fixtures.

Current boundary: literal map members, linear container bodies, deterministic
loop conditions, collection binding into reducers, and `host` leaves.
Dynamic artifact-field maps, branchy child graphs, member-scoped human gates,
replicate/subworkflow containers, and command-adapter leaves remain deferred.

**Capabilities 3 and 6 shipped thin (format 0.3):** run-ledger format 0.3
(`schema_version` in run.yaml + contiguous per-event `seq`), artifact
manifests with sha256 digests and record-time typed-artifact validation on
`artifact_created` (immutability guard included), host-dispatch lifecycle and
host-attestation checks in `fadeno verify`,
(digests, seq, terminal coherence, active/superseded resolution,
prompt-snapshot integrity, conflicting human decisions — unrecomputable
evidence reported as skipped, never silently valid), a logical-step
projection as the default `fadeno show`, and an explicit `--legacy`
compatibility mode for 0.2 and unversioned ledgers (writers refuse all older
ledgers outright).

**Host dispatch is now implemented:** `adapter: host` profiles retain
model, reasoning effort, and agent type in the run snapshot. `fadeno drive`
batches all pending host calls and returns `awaiting_host_dispatch` with stable
request ids. The host submits serial `dispatch-start`, `dispatch-complete`, or
`dispatch-fail` receipts; valid output receives an immutable manifest and
invalid output is parked under `artifacts/attempts/`. The director remains the
sole ledger writer.

**Cross-harness progress is now explicit:** immutable actor prompts name an
ephemeral status sidecar and the host records source-labelled
`host_dispatch_progress` observations between start and terminal. The default
`show` view is workflow-aligned: it includes unstarted graph nodes, literal map
members, pending/running/waiting/blocked/completed state, and actor/step/total
runtime. Progress remains non-gating attestation, never semantic truth.

**First format-0.2 dogfood receipt (2026-08-02):** the fadeno-demo exhibits
were regenerated on 0.5.0 — PR #3 (genuine signed-durations trace, 16 ok / 2
skipped) and PR #4 (a *non-gating* finding laundered from the review report:
every gate still recomputes green, only the digest checks catch it — the
tamper class the 0.3.0 verify could not see). Friction found there feeds the
list below.

The protocol is not schema-frozen. Run two or three additional dogfood workflows
and require both an observed receipt and a verification check before promoting
more North Star entities. Old document versions must be rejected or read in an
explicit compatibility mode, never silently reinterpreted. Preserve cheap or
loud migration paths for user-authored playbooks; old ledgers may remain legacy
output. Team-level provenance is anchored by committed evidence plus
`fadeno verify` in CI; hash chaining remains a possible standalone mechanism,
not current scope.

## Dispatch kernel (horizon 7 shipped — dials + model registry)

The dispatch kernel's full horizon is implemented and in daily dogfood.

- **Horizon-5 — loadouts era:** named archetype→executor loadouts have been
  retired (now documented in `loadouts-and-dispatch.md` as history). The CLI
  retains `fadeno loadout set` as the steering surface, but its meaning is
  now per-archetype dials, not preset selection. `fadeno use`, `fadeno targets`,
  `loadouts:`/`default_loadout:`/`targets:` in catalogs, `--loadout` /
  `FADENO_LOADOUT`, and the `targets` concept are removed; v2 catalogs error
  with a migration note pointing at `dials-and-registry.md`. The two-row
  `dispatches.jsonl` ledger, prompt snapshots, relay attestation,
  `host_delivery` rows, `hook_version` stamp, and the `fadeno dispatches`
  reader all persist — only the identity fields on rows have been re-spelled
  (`model`/`effort`/`driver`/`dial` instead of `target`/`loadout`).

- **Horizon-5/6 invariants still hold:** the Claude plugin's dispatch proxy
  agents and three-rung steering ladder (description routing → `PreToolUse`
  spawn rewrite → proxy Bash guard hook), the stdin-heredoc `FADENO_PROMPT`
  contract, command routes' `write_access` refused against archetype write
  postures, and the format-`1.0` ledger with tiered legacy handling for `0.2`
  rows.

- **Horizon-6 — archetypes, constraints, shadows:** all four phases shipped
  and carried forward:
  1. **Archetype schema pass** — three-valued write postures
     (required | forbidden | none), acyclic fallback chains that resolve
     bindings never policy, `resolved_via` provenance, the `generator` canon
     archetype, and a steering chain-walk to the nearest host agent surface.
  2. **Constraint tiers** — declarative predicates
     (`distinct_provider_from_inputs`, per-model `eligibility` including
     `shadow_only` / `forbidden`) plus a tier-2 `constraints.command` escape
     hatch; every boundary refusal writes a `dispatch_refused` row; verify
     recomputes gate-eligibility from the snapshot.
  3. **Shadow dispatches and model tryouts** — per-slot shadow attachments
     with sha-identical paired prompts and `--rate` sampling, isolated
     worktree delivery with diff-as-artifact, `fadeno dispatches
     --comparisons`, and the model-tryout starter with its
     mandatory-confounds ModelComparison contract.

- **Horizon-7 — dials and the model registry (implemented, `experimental/dials-and-registry.md`; hardened post-0.6 with no compat):**
  named loadout presets retire in favor of per-archetype dials on a layered
  cascade (`binding → session → repo → user → base`) with a uniform model
  registry (`provider` + `id` + standard `effort`, `spellings:` per driver),
  driver display aliases (`openai→codex`, `anthropic→claude-cli`, `xai→grok`; `google→agy`, `openrouter→opencode` already), driver fields `driver:` / `models_command:` / `effort_encoding:` on routes,
  `unregistered_model_driver` fall-through for unknown ids, and dial-time
  backend verification (`models_command` probe, positives cached in
  `model-verifications.json`, fail-open). Dispatch rows now carry
  `model`/`model_id`/`effort`/`driver`/`dial`/`dial_source` and the effective
  table is `fadeno dial` (no args, verb-first `dial <archetype> <model>`, `dial clear`, `dial shadow`). Post-0.6 hardening: pre-dials catalogs/snapshots are refused loudly (`schema_version 3` / `snapshot_version 3`; `verify` fails pre-dials ledgers with `snapshot_version 3` message), command renamed `fadeno dial` (verb-first), `--executor` removed, pin is `.fadeno/local/dials`, snapshot is `snapshot_version: 3` (replacing v1-shaped emission), and `ConstraintContext.transport` is `host` — while the dispatches reader still renders 0.x/legacy rows (`[legacy]`) as evidence history, not a compat surface. `fadeno models` remains a possible future inspection surface, not a promise — the effective table is the inspection surface today. Deliberately still backlog, not scope: route operational-policy fields (env, retry, concurrency, prompt-size ceilings),
  hook-initiated shadows for host-native primaries, and canon distribution
  into complete legacy catalogs.

## Low-friction release boundary

The plugin runtime now carries the CLI and immutable built-in definitions, so
built-in playbooks run without `fadeno init`. `setup`, `use`, `status`, and
`doctor` keep personal configuration at user scope; `vendor` and evidence
promotion are the explicit project-commit seams. Codex managed agents remain
session-static and therefore still require one fresh session after setup/use.
Grok has no steering integration. External command executors remain explicit,
are announced with their sandbox boundary, and never fall back silently.

Plugin skills now invoke a private launcher rather than relying on `PATH`.
First setup installs a stable, manifest-tracked user runtime; managed Codex
agents point there instead of into an ephemeral plugin cache. `uninstall` is
ownership-aware, `clean` removes only repo-local runtime output, and `unvendor`
uses the vendor lock's file digests. See
[`distribution-lifecycle.md`](experimental/distribution-lifecycle.md).

## Other deferred work (roughly prioritized)

- **Native distribution.** The bundled JavaScript runtime still requires Node
  20. Signed platform binaries are deferred until Node is demonstrated to be
  the dominant onboarding failure; the launcher/runtime boundary allows that
  payload swap without changing the setup contract.

0. **Dogfood friction (2026-08-02 demo regeneration)** — fix before/with the
   engine release: (a) shipped `runtime.md` map guidance and the cursor
   disagree on the gated-map collective path (`artifacts/review-report.json`
   vs `artifacts/parts/<step>.json` + member parts) — reconcile doc and
   cursor; (b) `fadeno gate` records `gate_evaluated` at `current_step`, but
   the cursor keys gate completion on the *gate step's* id — `gate` should
   take/infer the gate step id; (c) `fadeno verify --json` (and a
   `--list-checks` enumeration) for CI and exhibit authors; (d) an escape
   hatch to record an externally composed prompt as a snapshot (host-subagent
   dispatch currently caps at prompt-snapshots: skip); (e) `fadeno show`
   lists `artifacts/.gitkeep` in the artifacts section (cosmetic).
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

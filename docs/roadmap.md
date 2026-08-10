# Fadeno roadmap

Where the shipped/deferred line sits, so it lives in the repo rather than in
chat.

## Design status and precedence

Fadeno now has five intentionally different design horizons:

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

The next-protocol engine decision deliberately supersedes v0's "no runtime"
constraint for forward work. It does not authorize a daemon, cloud service,
general scheduler, or orchestration platform.

## Shipped (v0)

- CLI: `init --codex|--claude|--grok [--with-hooks] [--with-steering] [--data-only] [--force]`,
  `validate [file] [--schema]`, `diagram [--format ascii|mermaid]`, `new-run`,
  `run`, `tool-complete`, `gate`, `prompt`, `next`, `drive`, `loadout`,
  `steering`, `dispatch*`, `completion`, `runs`, `show`, `verify`, `plugin`.
- Tri-target scaffolding from one template core (Codex, Claude Code, and Grok Build),
  non-destructive. Grok's native adapter emits `.grok/skills`, `.grok/agents`,
  and `AGENTS.md` without mutating permission files.
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
  `research-synthesis`, `pr-review`, `compositional-review`. Runner, builder,
  and driver skills.
- Validation: schema + reference-integrity (errors) + **semantics** — `actor` must be a
  declared role (error); unproduced `input` artifact and unused role (warnings). Also
  validates `run.yaml` / `review-report.json` (auto-detected or `--schema`).
- `$schema` editor modelines in generated YAML (playbooks + run ledgers).
- Repo-local runtime and run ledger (`run.yaml` / `events.jsonl` / `artifacts/`) with CLI helpers (`run`,
  `prompt`, `next`, `runs` list, `show` timeline, and whole-trace `verify`) and
  deterministic gate evaluators (`no_blocking_issues`, `tests_pass`) — the
  advisory→enforced bridge. The driver skill composes these helpers into the
  current model-mediated execution procedure.
- Tier-2 enforcement scaffold via `--with-hooks` (pre-commit, CI workflow, Claude hook example).
- Opt-in loadout steering via `--with-steering`: hybrid Codex custom agents plus
  `fadeno steering apply`, and a selective Claude `PreToolUse` rewrite. Codex
  switches command slots live, executes host slots only when they match its
  session-static native baseline, and reports `restart_required` otherwise;
  Explore/Plan stays native. Grok steering remains unsupported.
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
`fadeno verify` grew from 16 to **26 checks**: attempt-ordinal contiguity +
reasons, binding-matches-snapshot-or-override, named-decision
validity/at-most-once, supersede reference integrity, and session-continuity
(a resumed id must exist earlier, same role, same executor). `fadeno show`
surfaces actor calls, attempts, schema repairs, resumed sessions, and
`! waiting for human decision`. Engine-executable today: actor_call/evaluator/reduce/role-maps
(with collective assembly), deterministic gates, loops, human gates; tool_call
and the undemonstrated primitives still hand back to the driver.

### Accepted next slice: compositional containers

The five-item Luna/Terra dogfood showed that a role-list map plus one global
loop cannot represent independently advancing review cycles. The accepted
boundary is now recursive composition: `map`, `replicate`, and `loop` own child
graphs, so `map(loop(...))` and `loop(map(...))` have distinct, executable
semantics. `join` and `reduce` operate on child-instance results.

The first vertical slice is **shipped for native host executors** rather than
making the schema accept graphs the engine cannot drive:

1. hierarchical `node_instance_id` and lexical artifact scope;
2. a deterministic runnable frontier replacing the single global cursor for
   compositional playbooks;
3. independent map-member and loop-generation state;
4. batched host dispatch and progress attributed to node instances;
5. graph-expanded `show` and containment-aware `verify`;
6. map-of-loop and loop-of-map acceptance fixtures.

Current boundary: literal map members, linear container bodies, deterministic
loop conditions, collection binding into reducers, and native `host` leaves.
Dynamic artifact-field maps, branchy child graphs, member-scoped human gates,
replicate/subworkflow containers, and command-adapter leaves remain deferred.

**Capabilities 3 and 6 shipped thin (format 0.3):** run-ledger format 0.3
(`schema_version` in run.yaml + contiguous per-event `seq`), artifact
manifests with sha256 digests and record-time typed-artifact validation on
`artifact_created` (immutability guard included), host-dispatch lifecycle and
native-attestation checks in `fadeno verify`,
(digests, seq, terminal coherence, active/superseded resolution,
prompt-snapshot integrity, conflicting human decisions — unrecomputable
evidence reported as skipped, never silently valid), a logical-step
projection as the default `fadeno show`, and an explicit `--legacy`
compatibility mode for 0.2 and unversioned ledgers (writers refuse all older
ledgers outright).

**Native host dispatch is now implemented:** `adapter: host` profiles retain
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

## Other deferred work (roughly prioritized)

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

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
  table is `fadeno dial` (no args, verb-first `dial <archetype> <model>`, `dial clear`, `dial shadow`). Post-0.6 hardening: pre-dials catalogs/snapshots are refused loudly (`schema_version 3` / `snapshot_version 3`; `verify` fails pre-dials ledgers with `snapshot_version 3` message), command renamed `fadeno dial` (verb-first), `--executor` removed, pin is `.fadeno/local/dials`, snapshot is `snapshot_version: 3` (replacing v1-shaped emission), and `ConstraintContext.transport` is `host` — while the dispatches reader still renders 0.x/legacy rows (`[legacy]`) as evidence history, not a compat surface. `fadeno models` remains a possible future inspection surface, not a promise — the effective table is the inspection surface today. Deliberately still backlog, not scope: route operational-policy fields (env, retry, concurrency, prompt-size ceilings)
  and canon distribution into complete legacy catalogs. (Hook-initiated
  shadows for host-native primaries were on this list and have since shipped
  — see horizon 8 below.)

## Shadow pairs (horizon 8 shipped — symmetric pairs, isolation, measured identity)

Implemented on `feat/symmetric-shadow-pairs` (unmerged as of 0.6.0-rc.34);
the design record is `experimental/slots-and-archetypes.md`, phases 5 and 5.5.

- **Symmetric pairs.** A shadow-selected spawn routes BOTH arms through the
  command lane, which deletes the host-primary capture problem rather than
  solving it. The roll is a pure function of (prompt digest, archetype,
  challenger), so the steering hook and the kernel reach the same verdict with
  no state threaded between them. `shadow.routable` gates it: a primary with
  no command lane degrades to no pair rather than to a failed task. Codex gets
  the same feature through `steering resolve --prompt-file`, so this is
  harness-neutral rather than Claude-only.
- **Trustworthy isolation.** Both arms start from one committed
  `baseline_commit`; `worktree_carry:` carries declared gitignored build state
  by reflink → hardlink → copy (never a directory symlink) so a challenger can
  build and test what the primary can; a prompt naming absolute repo paths
  refuses the pair rather than letting the challenger escape its worktree.
  Every new failure writes a refusal row and leaves the primary untouched.
- **Measured identity.** `fadeno attest`, run inside a subagent, records the
  one component that is observable (`CLAUDE_EFFORT`, past any silent
  downgrade); model remains `identity_evidence: requested_only`, because
  nothing exposes it and asking the model to name itself is not evidence.
  Unattested deliveries and effort/dial disagreement both render.
- **Port-back.** `fadeno shadow-apply` applies a retained arm's diff with
  `git apply --3way`, stopping and keeping the artifact on conflict.
- **Honest limits, stated in the design doc rather than discovered later:**
  blinding is advisory (the challenger's cwd names it; real blinding needs
  both arms in neutrally-named worktrees), write-shaped primaries are still
  deferred, and nobody judges accumulated pairs yet — that is the next
  horizon, and judging untrustworthy pairs would be worse than not judging.

## Effort decides the lane (horizon 9 shipped — Claude half; Codex designed)

Merged to main 2026-08-20. The design record is
[`slots-and-archetypes.md`](experimental/slots-and-archetypes.md), section
"Effort decides the lane".

A host spawn runs at the session's effort; an effort the session cannot give
goes out on the command lane. This completes the predicate the resolver
already applied to *model* rather than adding a second mechanism, and retires
the 15-cell Claude identity grid along with `steering apply --claude`'s
emission. The grid is superseded, not wrong: it shipped and worked (measured —
the `xhigh` cell reports `CLAUDE_EFFORT=xhigh`, the `low` cell reports `low`).

Four harness facts were measured rather than assumed, and are recorded in the
design doc: the Agent tool's `model` is a strict enum, so effort has no live
tool-call channel; `effort:` frontmatter is honored; the agent registry is a
session-**start** snapshot, so cells cannot be materialized on demand (the
grid was necessary, not merely convenient); and hook processes observe
`CLAUDE_EFFORT`.

Hook-side denials now leave a `host_refused` row — previously a repo where
every spawn was refused looked identical in the ledger to one where nobody
spawned.

**Follow-ups, in rough priority:**

1. ~~**Codex half**~~ **Shipped.** `relay:` is a per-harness catalog key, both
   scopes' `.codex/agents` TOMLs are emitted rather than copied, and `doctor`
   reports a project-scope broker shadowing a user-scope one. Its blocker
   (the layered loader silently dropping misspelled top-level keys) cleared
   first, so `relay:` never shipped depending on that bug — and writing its
   tests immediately found the same defect surviving by value type, which is
   item 6 below.

   Two things landed beyond the original sketch. Project scope now carries the
   managed header, without which every freshly initialized repo would trip the
   new shadowing warning forever. And Claude's relay came along too: the
   spawn hook reads `relay.claude` from the resolver, and the proxy
   frontmatter is stamped at emit.
2. ~~**The reader drops `session_effort` and `lane_reason`.**~~ **Fixed** —
   both read through one helper shared by `host_delivery`, `host_refused`, and
   kernel rows, so the gap closed for every row type at once. `primary_merge`
   landed on the same pass. Still dropped, and the next one of these:
   `worktree_carry`, which lands on isolated completion rows and has no home
   on `DispatchEntry`.
3. **`dial resolve` has no structured failure output.** Its failure is exit
   status plus free-form stderr, so the hook's `resolver_error` predicate
   covers everything from a malformed pin to a missing binary. A
   machine-readable failure would let a denial loop be grouped by cause rather
   than merely counted.
4. **Resolution echo covers only `new-run`.** `drive.ts` and `dispatch.ts`
   build their own echo strings and stay unlabelled, and `new-run`'s role rows
   carry no lane — the label is derived from the ref string instead of the
   resolver's answer. One authoritative lane wants a field on those rows.
5. **A repo with no `.fadeno/` denies silently.** Correct (never conjure an
   evidence tree) but undocumented.
6. ~~**The same drop survives by value type, one layer down.**~~ **Fixed.**
   The merge's entry-merged branch did `mapping(source[key]) == null ->
   continue`, so `dials: "sol"`, `tools: []`, or `tools: "lint"` loaded clean
   and did nothing — the parser would reject each, but the merge dropped them
   first. Found again from the other end: the new `relay:` key inherited the
   defect it was added under, and `relay: sonnet` silently did nothing.

   The stated blocker turned out to be the fix. A bare `key:` parses as
   `null`, and the parser is inconsistent about null (`dials`/`bindings`
   throw, `archetypes`/`constraints`/`tools` tolerate) — so the merge now
   rejects only the **non-null** non-mapping case. Every "this layer says
   nothing" spelling behaves exactly as before; only a genuinely declared
   value of the wrong shape fails. No blast-radius pass was needed after all,
   which is worth remembering the next time a deferral is justified by one.
7. **Flaky workspace-lease-lock tests** — now worse, and worth doing.
   Isolating paired primaries added worktree churn, so parallel runs surface
   one or two *different* shadow/lease failures per run, all passing in
   isolation. `--test-concurrency=1` is the current workaround for anything
   conclusive. Original: — `test/tool-repairs.test.ts:558` and
   `test/drive-parallel.test.ts:169` intermittently time out on the same lock
   and pass in isolation. Not caused by this work; it muddies every agent
   verification run, which is reason enough to fix it.
8. ~~**Four copies of the user-scope Codex agent directory rule, and one of
   them disagrees.**~~ **Fixed** — one `codexUserAgentDir` in
   `user-paths.ts`. The write-up below named the wrong file as the deviant:
   `uninstall.ts` had the *correct*, hermetic spelling all along, matching
   `userPaths`' own convention in that module, and it was the other three that
   leaked a real `CODEX_HOME` into tests. Original finding, for the record: `steering.ts`, `status.ts`, `uninstall.ts`, and `doctor.ts`
   each re-derive `$CODEX_HOME/agents` else `<home>/.codex/agents`. Three read
   `opts?.env?.CODEX_HOME ?? process.env.CODEX_HOME`; `uninstall.ts` binds
   `env = opts?.env ?? process.env` first, so an injected env *without*
   `CODEX_HOME` never falls through to the process one. A caller who injects
   an env while `CODEX_HOME` is set in the environment therefore has steering
   write to `$CODEX_HOME/agents` while uninstall looks in `<home>/.codex/
   agents` — and silently leaves the managed agents it was asked to remove.
   Verified by reading all four. Wants one exported helper, with `steering.ts`
   as the definition since it decides where the file gets written.
9. ~~**`doctor`'s unmanaged-shadow finding asserts a mechanism it does not
   observe.**~~ **Fixed** — the flags are read off the file and the wording
   follows what was found. Verified against this repo, whose own frozen
   brokers still carry `--prompt-file`: the finding now says "nothing is
   broken yet" there instead of claiming a drift that is not happening.
   Original finding: It says a frozen broker "predating `--prompt-file` /
   `--host-executor`" invokes `steering resolve` without them; it never reads
   the file's invocation to check. The claim is correctly conditional, but
   scanning for the flag would let it report the omission as fact instead —
   and this repo's own frozen copies happen to still carry `--prompt-file`,
   so the conditional is doing real work today.
10. **`steering resolve` carries no `relay` field, though `dial resolve`
    does.** Nothing consumes it today — the Claude hook reads `dial resolve`,
    and the Codex brokers get their relay baked in at emit time — so this is a
    symmetry gap rather than a functional one. It matters the moment anything
    wants the relay from the steering path.

11. **A paired `worker`'s gitignored output is discarded.** The merge-back
    diff comes from `git add -A`, which respects `.gitignore`, so a worker
    whose real product is a gitignored build directory loses it when a pair is
    selected. Carried dependencies are unaffected (input, not output). This is
    a real narrowing of what a paired `worker` can produce, introduced
    knowingly when write-shaped pairs shipped, and it wants either an opt-out
    or an explicit carry-back list.
12. **Nobody judges accumulated pairs.** Phase 6. Both arms now produce
    comparable diffs from one shared baseline for every archetype, so the
    input a judge would need finally exists — which makes this the next real
    step on the shadow line rather than a distant one.

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

# Changelog

All notable changes to Fadeno are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

The engine slices of the next protocol (capabilities 1, 2, 4 + 5 of
`docs/experimental/next-protocol.md`, plus the explicit supersede event and
native host dispatch): Fadeno gains a small deterministic, repo-local engine.
Native dispatch advances the run ledger to format 0.3; format 0.2 and
unversioned traces remain explicitly readable through `--legacy`, while
writers accept only 0.3.

### Added

- **Archetype schema pass** (phase 2 of
  `docs/experimental/slots-and-archetypes.md`) — the archetype vocabulary
  opens up while staying kernel-enforced. `requires_write` becomes
  three-valued (`required` / `forbidden` / `none`; booleans alias for
  compatibility), and `forbidden` refuses dispatch onto a command route
  declared `write_access: true` the same way `required` refuses
  `write_access: false` — at the dispatch boundary and at dial time. The
  starter catalog gains the fourth canonical archetype, `generator`
  (divergent artifact-producing work: `requires_write: forbidden`,
  `fallback: worker`, no dedicated surfaces — every existing loadout serves
  it with zero edits). Archetypes may declare `fallback` chains: bindings
  only (a chain never imports another archetype's policy), acyclic at
  parse, and overrides beat fallbacks because resolution re-enters the
  override→slot cascade at each chain step. Rows bound through a chain
  record `resolved_via`; steering walks the chain to the first native
  surface (worker / reviewer / judge) and carries a write-forbidden
  advisory on native delivery, where posture is advisory by construction.
  Dispatch evidence format bumps to 0.2 (additive fields, same major — 0.1
  rows still read). Archetype keys and fallback references are
  identifier-validated.

- **Session slot overrides** (phase 1 of
  `docs/experimental/slots-and-archetypes.md`) — switch one archetype at a
  time instead of authoring a loadout per combination:
  `fadeno loadout set worker grok-default` dials a single slot over the
  active loadout, `fadeno loadout clear worker` reverts it, and switching
  the base loadout drops all overrides with a reported count. The pin file
  stays a bare name until the first override, then becomes single-line JSON
  (`{"loadout": …, "overrides": {…}}`); overrides apply by name match with
  the pin's base, from any selection source. `fadeno loadout` — and the
  active entry of `fadeno loadout list` — now print the
  *effective* table with `OVERRIDE (base: …)` marks; `loadout set` runs the
  archetype write-access check at dial time, refusing before any dispatch
  burns tokens; `--json` was added across the loadout subcommands. The
  resolution cascade gains the layer everywhere at once (binding → session
  override → loadout slot → `"*"`), including `loadout resolve` — so the
  Claude steering hook honors overrides with zero hook changes. Evidence is
  additive on ledger format 0.1: dispatch rows record
  `resolution: "override"` plus an `override` field, run
  `resolution_snapshot` events record the applicable `overrides`, and
  verification replays from the snapshot — never the live pin — so clearing
  an override cannot fail a completed run's verify.

- **`current-host` filler idiom in the starter catalog** — the `grok-worker`
  starter loadout now binds only its point (`worker: grok-default`) and
  fills reviewer/judge with the harness-relative `current-host`, so one
  loadout is correct on every host instead of pinning another provider's
  models into slots the loadout never cared about.

- **Write-access enforcement at every command delivery** — the
  `write_access` / `requires_write` conflict is now refused wherever a command
  delivery can be chosen, through one shared helper (`explainWriteConflict`
  in `src/lib/executors.ts`), so the refusal text is identical everywhere:
  `fadeno dispatch` (as before); `drive`, where the actor now fails pre-spawn
  with `reason: "write_access_denied"` and the run pauses in
  `executor_failed` — no prompt assembled, no run burnt; and
  `steering resolve`/`apply`, which return `mode: write_conflict` and decline
  to materialize a command broker for the conflicted slot while other slots
  proceed. Native in-session deliveries and locked engine host requests stay
  exempt by design.

- **Dispatch-ledger format versioning** — every row `fadeno dispatch` and the
  steering hook write now carries `format: "0.1"`, and `fadeno dispatches`
  reads in tiers: unversioned rows with a recognized `event` are current,
  pre-two-row completion-only rows render as `[legacy]` entries instead of
  counting as unreadable, and rows from a newer format major get their own
  skip count. Old evidence ages into legacy instead of degrading into noise —
  on the dogfood repo this turned "6 unreadable rows skipped" into six
  readable `[legacy]` dispatches.

- **`fadeno dispatches`** — the read side of `.fadeno/dispatches.jsonl`, which
  until now was a file you reached for `jq` to answer questions about. It
  correlates each `dispatch_requested`/`dispatch_completed` pair by
  `dispatch_id` into one row per dispatch, renders hook-written
  `native_delivery` rows inline so both delivery routes read as one history,
  and keeps a request whose completion never arrived — marked "no completion
  recorded (killed or in flight)" — because a dispatch that died mid-flight is
  the one most worth seeing. Rows surface the markers that change their
  meaning: `relay_attested`, `[write_access: none]`, and `model_override`.
  `--tail <N>` defaults to 10; `--json` emits the correlated rows for scripts.

- **`hook_version` on hook-written evidence** — `native_delivery` rows (and any
  other row a hook writes) now record which generation of the hook wrote them:
  `dev` in the committed template, the package version in every emitted copy.
  Hook registrations bind at session start but script bodies have been
  observed refreshing mid-session after a plugin update, so which generation
  of a hook is running is never safe to assume — a just-fixed rung and a
  genuinely broken rung are indistinguishable from the inside. The stamp makes
  the writing generation forensically identifiable, so "the fix doesn't work"
  separates from "the fix isn't loaded yet" from the evidence rather than by
  argument.

- **`parallel-workstreams` starter playbook** — the runnable encoding of the
  parallel dispatch fan-out pattern: freeze the shared contract (names,
  schemas, refusal texts) before any worker starts, fan out under per-worker
  ownership manifests carrying the mandatory-exception rule (an edit outside
  your manifest that is required for correctness is made *and* flagged, never
  silently skipped), keep every worker finish-order independent, then run a
  dedicated integration phase that owns cross-cutting files, the plugin
  rebuild, the changelog, and the first full-suite run. Drawn from two live
  fan-outs on 2026-08-12; rationale in
  `docs/experimental/loadouts-and-dispatch.md` → *Parallel dispatch fan-out*.

- **Route write-access policy** — a schema v2 route entry may declare
  `write_access: <bool>` (whether that route's *command* delivery can mutate
  the workspace), and `executors.yaml` may declare a top-level `archetypes:`
  mapping whose values accept only `requires_write: <bool>`. `fadeno dispatch`
  refuses **before spawning** when the resolved command route says
  `write_access: false` and the archetype says `requires_write: true` — the
  2026-08-12 dogfood case was a commit task delivered through a headless
  `claude -p` fallback that has no approver for a write, dispatched only
  because the kernel read "has a command" as "is dispatchable". Either side
  undeclared imposes no constraint, so existing profiles are unaffected. When
  declared, `write_access` joins the evidence-row identity and a proceeding
  read-only dispatch echoes `[write_access: none]`. The starter catalog ships
  the policy live: `archetypes: { worker: { requires_write: true } }`,
  `write_access: true` on the sandboxed `codex exec` routes, `write_access:
  false` on the headless `claude -p` routes (xai stays undeclared until
  `grok build`'s headless permission posture is confirmed).

- **Native-delivery evidence** — the Claude steering hook now appends a
  `native_delivery` row to `.fadeno/dispatches.jsonl` (timestamp, archetype,
  agent_type, loadout, executor, model, model_override, `reasoning_effort:
  "inherited"`, `transport: "host-native"`, prompt_sha256, prompt_snapshot)
  plus a verbatim prompt snapshot at
  `.fadeno/local/prompts/native-<sha8>.md` whenever it steers a spawn to a
  native role agent. Command dispatches get two-row kernel evidence,
  snapshots, and relay attestation; the kernel is not in the native path, so
  the hook is the only possible writer there. One file now audits both
  delivery routes. Best-effort: it never changes a steering decision.

- **Two-row ad-hoc dispatch evidence** — `fadeno dispatch` now appends a
  `dispatch_requested` row *before* invoking the executor and a correlated
  `dispatch_completed` row (shared `dispatch_id`) after, so a dispatch killed
  mid-flight (harness timeout, SIGTERM) still leaves a trace in
  `.fadeno/dispatches.jsonl`. Completion rows record the terminating `signal`
  when there is one, plus `prompt_source` and `prompt_snapshot`.

- **Kernel-owned prompt snapshots** — a dispatch prompt arriving on stdin is
  written by the kernel itself to `.fadeno/local/prompts/` and referenced
  from the evidence rows; a single writer means the recorded `prompt_sha256`
  attests exactly the bytes received. Callers no longer pre-write prompt
  files.

- **Dispatch proxy relay guard** — a `PreToolUse` Bash hook
  (`dispatch-proxy-guard.mjs`, shipped in the plugin's hook manifest and
  installed by `init --claude` steering) that fires only inside the
  `dispatch-*` proxy agents. It allowlists exactly the relay contract — the
  single stdin-heredoc `fadeno dispatch` statement (heredoc body deliberately
  uninspected), the prompt-file retry, and the legacy prompt-file-write
  shapes older init-emitted agents still use — denies everything else with
  an actionable reason, and raises the dispatch call's Bash `timeout` to
  600000 ms. Instruction-only proxies were observed defecting on the relay
  contract in a 2026-08-12 dogfood A/B; this makes the contract tier-2. On
  harness versions that omit `agent_type` from hook input the guard no-ops
  (advisory-only).

- **Relay attestation** — the Claude steering hook stashes the spawn-side
  prompt digest whenever a subtask heads to a dispatch proxy; the kernel
  consumes a matching stash at dispatch time and marks the evidence row
  `relay_attested` (true / false / absent), turning the proxy's "verbatim
  relay" from an instruction into a checked claim. Content-keyed and
  age-limited; never blocks a dispatch.

- **Version-stamped plugin surface** — plugin generation appends
  `[fadeno <version>]` to every agent and skill description, so a live
  session's loaded surface can be checked for staleness against
  `claude plugin list` (loaded surfaces only refresh at reload/restart).

- **Compositional map/loop runtime** — literal-member maps may own linear child
  graphs, including independently advancing bounded loops; loops may contain
  maps. The engine computes a runnable frontier, batches native host leaves,
  scopes prompts/artifacts/progress with canonical `node_instance_id`, and
  supplies scoped collections to downstream reducers. `show` expands member
  state and `verify` checks containment plus dispatch identity.

- **Native host dispatch** — executor profiles now discriminate `command` and
  `host` adapters. `fadeno drive` batches durable native-agent requests and
  pauses at `awaiting_host_dispatch`; the host records idempotent lifecycle
  receipts with `dispatch-start`, `dispatch-complete`, and `dispatch-fail`.
  Requests and receipts attest the requested model, reasoning effort, agent
  type, native agent id, workspace, branch, output digest, and optional commit.
- **Declared run inputs** — repeated `fadeno new-run --input Name=path` copies
  exact input bytes into the run, records digest/provenance manifests, rejects
  unsafe paths, and supports per-actor filtering for literal role maps.
- **Native-dispatch verification** — `fadeno verify` checks strict request →
  start → terminal ordering, profile/request/receipt attestation consistency,
  immutable schema-repair feedback, and symlink-safe output placement.
- **Cross-harness progress projection** — `dispatch-progress` records bounded
  JSON observations labelled as agent-, harness-, or director-reported.
  Immutable prompts name an ephemeral sidecar, verification enforces lifecycle
  placement and identity agreement, and `show` projects every graph step and
  literal map actor as pending/running/waiting/blocked/completed/failed with
  per-actor, per-step, and total runtime. Progress is never a gate input.

- **`fadeno drive <run>`** — the engine. Owns the run transition loop over the
  same pure cursor as `fadeno next`: assembles/reuses prompt snapshots,
  dispatches each actor step through its bound executor, validates typed
  outputs (one bounded schema repair per actor call — rejected bytes are
  parked under `artifacts/attempts/` as evidence, never at the planned path),
  assembles map collectives, evaluates deterministic gates, records loop
  iterations, pauses durably at human gates, and exits whenever it pauses
  (`--max-transitions` caps a single invocation; resume is just re-running
  drive). Steps it cannot execute (tool_call, undemonstrated primitives,
  agent-interpreted gate conditions) are handed back honestly.
- **Executor profiles** — `.fadeno/executors.yaml` (seeded by `init`): named
  `command`-adapter executors plus direct role→executor bindings with a `"*"`
  default. No routing, ranking, or automatic fallback. The profile is
  snapshotted into the run dir (`profile.yaml` + `profile_snapshotted` event
  with digest) on first engine contact; explicit substitution is
  `fadeno drive --bind role=executor`, recorded as `executor_override`.
- **Runtime identity** — engine dispatch/output events carry
  `step_execution_id`, `actor_call_id`, and `attempt` + `attempt_reason`
  (`initial` | `schema_repair` | `executor_override` | `user_retry`); new
  canonical events `actor_dispatched`, `actor_completed`, `actor_failed`.
  Identities are minted only by the engine — hand-driven ledgers omit them.
- **Named human decisions** — human gates pause with a durable
  `decision_requested` (id, prompt, declared options); **`fadeno decide
  <run> <option>`** records `decision_resolved` (idempotent duplicates,
  conflicting resolutions refused). The cursor accepts `decision_resolved`
  alongside the hand-driven `human_decision`.
- **`artifact_superseded`** — explicit supersession, validated at record time
  (both sides must be recorded artifacts); a superseded path is excluded from
  active-artifact resolution without a new generation.
- **Session-capable executors (opt-in; memoryless remains the default)** — an
  executor that declares `resume` (argv with a `{session_id}` placeholder)
  keeps one harness session per role per run, e.g. `claude -p
  --session-id/--resume` or `codex exec resume`. Ids are engine-minted
  (`{session_id}` in `command`) or harness-assigned (`session_id_pattern`
  regex over stderr/stdout). Every dispatch and every artifact born from
  resumed context is marked `session: fresh|resumed` + `session_id`; a schema
  repair against a live session sends only the repair message (recorded as
  `repair_appendix`). Honesty boundary: resumed prior context is attested by
  session id, never recomputable — prefer memoryless executors when memory
  isn't needed.
- **`fadeno verify` → 21 checks** — new: `actor-attempts` (ordinal contiguity,
  allowed retry reasons, rejected-output digests), `executor-bindings`
  (snapshot digest + every dispatch matches the binding in force),
  `named-decisions` (declared options, at-most-once), `artifact-supersede`
  (reference integrity), `session-continuity` (a resumed session id must
  exist earlier in the run for the same role under the same executor).
- **`fadeno show`** — projection surfaces actor calls, attempt counts, schema
  repairs, executor failures, and `! waiting for human decision`.
- **Driver skill** — engine-first: `fadeno drive` → `fadeno decide` → re-drive,
  with the manual `fadeno next` loop as the fallback for handed-back steps.

### Fixed

- **The starter xai routes actually run.** `[grok, build, "-"]` targeted a
  subcommand that does not exist — "Grok Build" is product branding; bare
  `grok` is the interactive TUI, which would have parsed `build` as a
  prompt. The routes now use grok's real one-shot mode
  (`--prompt-file /dev/stdin`) with `--always-approve` and declare
  `write_access: true`, resolving the long-open "xai headless write posture
  unknown" item: verified live, grok's one-shot mode runs a full agentic
  tool loop under `--always-approve`, and stalls silently — exit 0, one or
  zero messages, no tools — under any narrower permission mode, because a
  headless run cannot answer approval prompts.

- **Prototype-name roles and archetypes resolve cleanly.** A role, archetype,
  or binding named `constructor` or `toString` passes the bare-identifier
  rule, but plain property lookups in `resolveRole` found the inherited
  `Function` and crashed with a `TypeError` deep in `executorForArchetype`
  instead of the actionable `ExecutorProfileError`. Lookups now test for own
  string values (`typeof`/`Object.hasOwn`).

### Changed

- **Starter-playbook registries derive from the filesystem.** The completion,
  diagram, init, and validate coverage all consume a single
  `starterPlaybooks()` helper that reads `templates/common/fadeno/playbooks/`,
  and a new guard asserts every starter is listed in the builder skill's
  catalog — shipping a starter is one file plus its catalog line, and a stray
  file in the starters directory fails loudly instead of shipping silently.

- **The suite gained a docs-claims tripwire and a drift escape hatch.** A test
  now asserts that the identifiers the docs promise — `dispatch_requested`,
  `dispatch_completed`, `native_delivery`, `write_access`, `requires_write`,
  `relay_attested`, `FADENO_PROMPT`, `schema_version: 2` — still appear where
  they are documented, so a rename that silently invalidates the prose fails
  the build instead of being caught by a reader months later. Separately,
  `FADENO_SKIP_DRIFT=1` skips the plugin no-drift check: parallel workstreams
  run against a tree their siblings are still mutating, where that check fails
  for reasons no one caused. It is an escape hatch for that window only —
  integration runs the suite without it.

- **Dispatch proxies run on `model: sonnet`** (was `haiku`) and their bodies
  are hardened: the whole relay is ONE Bash call — the task prompt piped to
  `fadeno dispatch` as a quoted heredoc on stdin — run with the tool
  `timeout` raised to 600000 ms; the verbatim rule spells out "starting at
  the very first line", and the proxy may never assert kernel-side effects it
  didn't observe. The bare `fadeno` spelling keeps the call inside the
  `Bash(fadeno:*)` permission rule init pre-approves, so default-permission
  users stop getting a prompt wall per dispatch. A 2026-08-12 dogfood A/B
  caught the haiku proxy performing a task itself with no dispatch and, on a
  compliant retry, dropping the prompt's first line and claiming an evidence
  row that was never written; sonnet relayed flawlessly. The spawn-rewrite
  steering hook routes command-delivered archetypes to sonnet proxies
  accordingly.

- **Host-executor refusal points home** — `fadeno dispatch` resolving to a
  host executor without a fallback now names the native in-session agent to
  use instead.

### Documentation

- **Schema v2 is now the primary form in the design spec.**
  `docs/experimental/loadouts-and-dispatch.md` → *Schema* presented v1
  `executors:` entries as the shape to write while the shipped catalog had been
  v2 for two releases. It now specifies v2 fully — `targets:`, per-harness
  `routes:` (`native` / `command` / `resume` / `session_id_pattern` /
  `write_access`), `archetypes:`, `loadouts:`, `bindings:`, and the layering —
  against `templates/common/fadeno/executors.yaml` as the reference example,
  with v1 demoted to a compact "Legacy schema (v1)" note (still parsed, still
  accepts `write_access`, and still the shape `serializeProfile` emits for the
  run-dir snapshot under either schema). *Vocabulary* gains **target** and
  **route**; sentences elsewhere that still spoke of `adapter:` fields as
  user-facing syntax now speak in route-table terms.

- **Native delivery honors half an executor's identity** — in-session delivery
  can pin the requested **model** (the harness Agent tool's `model` parameter)
  but not its reasoning effort: the Agent tool schema has no effort parameter,
  so a target like `opus-xhigh` lands as opus at the session's inherited
  effort. `native_delivery` rows record `reasoning_effort: "inherited"` rather
  than the declared effort, so the evidence never claims an effort the
  delivery could not set. Command delivery has no such gap — the route's argv
  carries the effort flag.

## [0.5.0] — 2026-08-02

The provenance slice of the next protocol (capabilities 3 + 6 of
`docs/experimental/next-protocol.md`): artifact manifests with sha256 digests,
a much stricter `fadeno verify`, and a legible step projection as the default
`fadeno show`. **Breaking: run-ledger format 0.2** — new ledgers carry
`schema_version: "0.2"` and per-event `seq`; readers refuse unversioned
(pre-0.2) ledgers unless `--legacy` is passed, and writers refuse them
outright. Old traces stay auditable via `fadeno show|verify|next --legacy`, or
with the fadeno version that produced them.

### Added

- **Artifact manifests** — `fadeno run --artifact <path>` (and `--event
  artifact_created`) now requires the file to exist, hashes it, and records
  `artifact_id`, run-dir-relative `artifact` path, `logical_name`
  (generation-stripped), `generation` (from the `.v<G>` marker), `bytes`,
  `sha256`, `media_type`, and a record-time `validation` verdict (typed
  artifacts are shape-detected and schema-checked; failures recorded honestly
  as `ok: false`). Artifacts are immutable: re-recording a path with different
  bytes is refused — write a new generation instead. Measured manifest fields
  always win over colliding `--field` values.
- **Sequence numbers** — every appended event carries a contiguous 1-based
  `seq` (stamped by a shared ledger writer used by `new-run`, `run`, `gate`,
  and `prompt`).
- **`fadeno verify` expansion** — 16 canonical checks: ledger version, run
  schema, event parseability, seq contiguity, terminal status, terminal-event
  agreement with run.yaml, manifest completeness, artifact existence, digest
  recomputation, typed-artifact revalidation, immutability, active-artifact
  resolution, prompt-snapshot integrity (snapshot + every recorded input digest),
  per-gate recomputation, completed-run gate coherence, and conflicting
  human decisions. Anything unrecomputable is reported as skipped, never
  silently valid.
- **`fadeno show` projection** — the default view is now logical steps with
  state glyphs and collapsed counts (artifacts, gates, loop iterations,
  decisions), active artifacts (highest valid generation per logical name),
  decisions, and failures. `--events` prints the raw timeline; `fadeno runs`
  tags pre-0.2 ledgers `[legacy]`.
- **`--legacy` compatibility mode** on `show`, `verify`, and `next` — the
  explicit legacy reader for pre-0.2 ledgers (normalizes the retired
  `artifact_written` event name; digest-family checks report as skipped).
  `fadeno prompt` has no legacy mode by design: it refuses pre-0.2 ledgers
  even for previews rather than silently resolving inputs differently.

### Changed

- **Run-ledger format 0.2** (breaking, see above). `run.schema.json` now
  requires `schema_version`.
- The legacy `artifact_written` event name is retired from all current-format
  readers (`prompt`, `next`, the flow cursor); it is honored only under
  `--legacy`.
- Deliberately deferred to the engine slices: the engine loop (capability 1),
  attempt ordinals / execution identities (2), executor profiles (4), the
  named human-decision structure (5), and an explicit supersede event —
  manifests carry no fabricated `step_execution_id`/`actor_call_id`.

### Added (earlier, unreleased)

- **`fadeno plugin --codex`** — generate a **Codex CLI plugin** (`plugin-codex/`
  + a `.agents/plugins/marketplace.json` pointer) from the same shared skill
  templates as the Claude plugin, so Codex users can install Fadeno the same way:
  `codex plugin marketplace add CrocSwap/fadeno` → `codex plugin add
  fadeno@fadeno`. Skills carry their per-skill `agents/openai.yaml` invocation
  policy (runner implicit; builder/driver explicit-only). Role subagents and the
  CLI binary aren't Codex-plugin components, so they stay with `fadeno init
  --codex` and npm. `npm run build:plugin:codex` regenerates the committed bundle.

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

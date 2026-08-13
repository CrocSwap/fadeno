# Loadouts and the dispatch kernel

**Status:** layered catalog, safe-native defaults, user-scoped selection, and
explicit external dispatch implemented; strict mode remains deferred
**Decision date:** 2026-08-09
**Relationship:** extends the executor profile of
[`next-protocol.md`](next-protocol.md); sibling of
[`host-dispatch-contract.md`](host-dispatch-contract.md). Inherits the
next-protocol constraint set: no daemon, no cloud service, no scheduler.

## Observed need (admission receipts)

Two recurring behaviors from people using Fadeno in the wild:

1. **Subscription cycling.** Users run metered subscriptions across several
   inference providers and rotate which one does the expensive work as each
   quota depletes — e.g. Opus as the standard worker until the Anthropic sub
   runs low, then GPT‑5.6 Luna or Grok. The unit they think in is *"who is my
   worker / reviewer / judge right now,"* never a per-role YAML edit. Today
   that swap means hand-editing a dozen `bindings:` lines keyed by
   playbook-specific role names.
2. **Cross-harness subagents outside playbooks.** Users driving one harness
   (e.g. Fable in Claude Code) want their *subagents* to run on another
   provider (e.g. Luna via `codex exec`) — including subagents the harness
   launches automatically — because that is where their remaining quota or
   preferred model lives.

Both needs resolve to the same primitive: **role → archetype → executor
resolution, switchable at session level, invokable outside a playbook run.**
That primitive is the *dispatch kernel*. The playbook engine becomes one
client of it; ad-hoc subagent dispatch is the second.

## Vocabulary

- **Archetype** — the functional class of an actor. `worker`, `reviewer`,
  and `judge` are the original three (matching the plugin's role-subagent
  trichotomy); `generator` is the fourth canon — write-forbidden, no
  dedicated surface, served through `fallback: worker`. Open set; bare
  lowercase identifiers. See *Archetype policy*.
- **Target** — the harness-neutral identity of an actor's inference: provider,
  model, reasoning effort. No argv, no flags. This is what a loadout slot
  names.
- **Route** — how one harness delivers one provider: natively in-session, or
  out-of-process as a command. The harness-specific half, kept out of the
  loadout.
- **Loadout** — a named mapping of archetype → target. The switchable unit.
  ("Loadout," not "profile" — `ExecutorProfile` already names the parsed
  `executors.yaml` document in `src/lib/executors.ts`.)
- **Executor** — the resolved slot: a target compiled through the active
  harness's route into one concrete delivery. Under the legacy v1 schema an
  executor is written out by hand; under v2 it is computed. "Executor" below
  means the resolved slot under either schema.
- **Dispatch** — one resolution + invocation + evidence record, playbook-run
  or ad-hoc.

## Schema

`.fadeno/executors.yaml` is the catalog. Schema v2 splits the executor into
*what* and *how*: harness-neutral **targets** name the inference; per-harness
**routes** say how the machine in front of the user reaches a provider; and
**loadouts** map archetypes to targets. The split is what makes a loadout
portable — "my worker is Luna" is a true statement in every harness, while the
argv that delivers Luna is not.

```yaml
schema_version: 2

targets:                          # what runs: harness-neutral identity
  current-host:   { provider: current-host, model: current-host, reasoning_effort: default }
  luna-medium:    { provider: openai,       model: gpt-5.6-luna, reasoning_effort: medium }
  claude-default: { provider: anthropic,    model: opus,         reasoning_effort: high }

routes:                           # how the active harness delivers each provider
  claude:
    current-host: { native: true }
    anthropic:
      native: true
      command: [claude, -p, --model, "{model}"]     # headless fallback
      write_access: false
    openai:
      command: [codex, exec, --model, "{model}", --sandbox, workspace-write, -c, 'model_reasoning_effort="{reasoning_effort}"', "-"]
      write_access: true

archetypes:                       # what an archetype needs from any delivery
  worker:    { requires_write: required }
  generator: { requires_write: forbidden, fallback: worker }

loadouts:                         # the switchable unit: archetype → target
  native: { worker: current-host, reviewer: current-host, judge: current-host }
  luna:   { worker: luna-medium,  reviewer: luna-medium,  judge: luna-medium }

default_loadout: native           # optional

bindings:                         # per-role pins; optional once loadouts exist
  opus_reviewer: claude-default   # deliberately-multi-model playbooks pin here
  "*": current-host
```

The shipped catalog at `templates/common/fadeno/executors.yaml` is the
reference example — it carries this shape across all four harness route tables
and is what `init` seeds. Read it rather than this excerpt when the two
disagree.

**Targets.** `provider` and `model` are required non-empty strings;
`reasoning_effort` is optional and defaults to `default`. A target carries
identity only — never argv, never permission flags. Target names are the names
loadout slots and `bindings` reference, so under v2 "target name" and
"executor name" are the same string.

**Routes.** `routes:` is keyed by harness id — `codex`, `claude`, `grok`,
`standalone` — and **only the active harness's sub-table is compiled**
(`FADENO_HARNESS`, else the harness recorded by `fadeno setup`, else
`standalone`). A v2 catalog with no `routes.<active-harness>` mapping is a hard
error rather than a silent no-op. Inside that sub-table each entry is keyed by
**provider**, with one refinement: an entry keyed by an exact *target* name
wins over its provider entry — that is how one target gets a stricter sandbox
or a read-only policy without pushing harness specifics up into the loadout.

A route entry declares:

- `native: true` — this harness delivers the provider in-session. Compiles to a
  native slot whose agent identity is bound to the requesting archetype at
  resolution time, so one route serves worker, reviewer, and judge.
- `command: [...]` — argv for out-of-process delivery, prompt on stdin.
  `{model}` and `{reasoning_effort}` are substituted from the target. On a
  `native: true` route this is the *fallback* delivery, not the primary one; on
  a non-native route it is required.
- `resume: [...]` — session-resume argv, which must contain `{session_id}`.
  Declaring it makes the route session-capable (one harness session per role
  per run). Resumed context is attested, not recomputable — bias toward
  memoryless routes.
- `session_id_pattern:` — a regex with one capture group, matched against
  stderr then stdout, for harnesses that mint the session id themselves.
  Mutually exclusive with a `{session_id}` placeholder in `command` (the
  engine-minted case). `resume` with no id source, or an id source with no
  `resume`, is an error in both directions.
- `write_access:` — whether *this route's command delivery* can mutate the
  workspace. See *Write access* below; a `native: true` route's declaration
  describes its fallback command, never the in-session agent.

**Archetypes.** `archetypes:` is an optional top-level mapping whose values
accept exactly three keys: `requires_write`, `fallback`, and
`distinct_provider_from_inputs`. `requires_write` is
`required` | `forbidden` | `none` (booleans alias: `true` → `required`,
`false` → `none`); absent is `none`. `fallback` is a bare identifier naming
another archetype whose *binding* is used when this one has no slot.
`distinct_provider_from_inputs` is `advisory` | `required`; absent is no
check. Deliberately
strict: an unknown key is an error, because the alternative is a typo that
silently drops a safety constraint. See *Archetype policy* and *Constraint
tiers*.

**Loadouts and bindings.** Loadout names and archetype keys are bare
identifiers (`[a-z][a-z0-9_-]*`); every loadout slot must name a declared
target; `default_loadout` must name a declared loadout. `bindings` keys are
role names plus the `"*"` wildcard and also name targets. At least one of
`bindings:` / `loadouts:` must be non-empty — `bindings` alone was required
before loadouts existed, and is now the optional half.

**Layering.** The catalog resolves in layers — the bundled built-in, then the
user file (`~/.config/fadeno/executors.yaml`), then the project
`.fadeno/executors.yaml` — merged by key, so adding one target or overriding
one route never means forking the shipped table.

Playbook roles gain one optional field:

```yaml
roles:
  implementer:
    purpose: Make the code change.
    archetype: worker
```

`archetype` is advisory identity, not routing config — the playbook stays
harness- and provider-neutral. Validator checks the identifier shape only.
Template playbooks must not encode model names in role names
(`luna_implementer` → `implementer`); genuinely multi-model playbooks (e.g.
dual-model review) are the legitimate use of per-role `bindings` pins.

> **Legacy schema (v1).** The original shape — a flat `executors:` map whose
> entries each carry `adapter: command|host` and their own argv, with no
> `targets:`/`routes:` — is still parsed unchanged, with `schema_version: 1` or
> no `schema_version` at all, and may coexist with a v2 catalog in one
> document. A v1 entry accepts `write_access:` with exactly the same meaning.
> It is also the *internal* shape: v2 compiles each target through the active
> harness's route into precisely that adapter form, tagged with its
> `target:`/`provider:`, which is why `serializeProfile` — the canonical
> run-dir snapshot — emits v1 for both schemas and a v2 catalog round-trips as
> v1 executors plus its loadouts. Hand-write v1 only for a delivery the route
> table cannot express; new catalogs should be v2.

## Resolution

For each role, at dispatch time:

1. explicit `bindings[role]` pin;
2. session slot override for the role's declared `archetype`
   (`fadeno loadout set <archetype> <target>`);
3. active loadout's slot for the role's declared `archetype`;
4. `bindings["*"]`;
5. otherwise a hard, actionable error naming the role, its archetype, and
   what to add.

When the declared archetype has a `fallback`, steps 2–3 re-enter along that
chain — override, then loadout slot, at each step — before falling through
to `bindings["*"]`. The chain selects a binding only; a row bound this way
carries `resolved_via`. See *Archetype policy*.

The **active loadout** is resolved: explicit `--loadout` → run-persisted intent
→ `FADENO_LOADOUT` → `.fadeno/local/loadout` → user state
`<state>/fadeno/loadout` → highest-layer `default_loadout` → bundled `native`.
The simple `fadeno use <name>` command writes user state; compatibility
`fadeno loadout use <name>` continues to write the repository-local pin.

`.fadeno/local/` is per-machine session state and must never be committed:
repos that commit `.fadeno/` should gitignore `.fadeno/local/` (scaffolding
adds this). This is what makes a loadout switch session-scoped instead of a
repo edit that dirties git for a quota condition that expires tomorrow.

**Session slot overrides** (phase 1 of
[`slots-and-archetypes.md`](slots-and-archetypes.md)) decorate the active
loadout one archetype at a time: `fadeno loadout set worker grok-default`
dials a single slot; `fadeno loadout clear worker` reverts it. The pin file
carries them — a bare loadout name when no overrides exist (unchanged
format), a single-line JSON object `{"loadout": …, "overrides": {…}}`
otherwise — and overrides apply by **name match**: they belong to the base
loadout named in the pin and fire whenever that loadout is active,
regardless of which source selected it. Switching the base
(`fadeno loadout use`, `fadeno use --project`) writes a bare name and drops
all overrides, reporting the count. `loadout set` re-runs the archetype
write-access check at dial time, so a worker override onto a read-only
command route is refused before the first dispatch, with the kernel's own
refusal message. `fadeno loadout` prints the *effective* table with
overridden rows marked `OVERRIDE (base: …)`; evidence records the layer
(`resolution: "override"` plus an `override` field on dispatch rows,
`overrides` on run `resolution_snapshot` events — and verify replays from
the snapshot, never the live pin, so clearing an override cannot fail a
completed run's verification).

**Stale pins: strict where it decides, graceful where it looks.** A pin
naming an undeclared loadout is a hard, fix-naming error on every path that
*decides* which executor runs — `fadeno dispatch` and `fadeno loadout
resolve` raise the same message, and the Claude steering hook turns a
resolver failure into a spawn denial rather than quietly proceeding native
(silent substitution in either direction is the non-goal). Inspection
commands (`loadout` show/list, `status`) surface the stale name as
`stalePin` without bricking. The **user-scope pin has layer scope**: it is
consulted only when the user config layer was actually composed into the
effective profile — a self-contained project catalog is authoritative, so a
global dial cannot reach into a repo whose profile never saw that layer
(dispatch, loadout, the new-run preview, and Codex steering all scope it;
the engine resolves against run snapshots, which do not yet record layer
provenance — deferred). A self-contained catalog that predates canon
archetypes gets a note in the loadout views naming what it never declared
(`suppressedCanonArchetypes`), leaving adoption an explicit repo edit.

**Resolution is computed at dispatch time, inside the CLI, never cached in
config emitted elsewhere.** Any integration (plugin agents, hooks) stays dumb
and calls `fadeno`; switching loadouts mid-session takes effect on the next
dispatch with no config churn.

## Write access

Resolution answers *who* runs the task. It does not answer whether that
delivery can change the workspace — a route's argv may hand the prompt to a
harness that is forbidden to write. Two optional declarations make the question
answerable before a turn is spent:

```yaml
routes:
  claude:
    anthropic:
      native: true
      command: [claude, -p, --model, "{model}"]   # headless fallback
      write_access: false
    xai:
      command: [grok, --prompt-file, /dev/stdin, --model, "{model}", --permission-mode, acceptEdits]
      write_access: true

archetypes:
  worker: { requires_write: required }
```

`write_access` is a property of a **route entry** and describes that route's
*command* delivery only — whether the harness it spawns can mutate the
workspace. On a native route it therefore describes the fallback command, never
the in-session agent, whose permissions are the host's business. (A v1
`executors:` entry accepts the same key, with the same meaning.) `archetypes:`
is an optional top-level mapping; its values accept `requires_write` (three
postures; booleans alias) and `fallback`. See *Archetype policy*.

Ad-hoc dispatch refuses **before spawning** when the executing command route
declares `write_access: false` and the archetype declares
`requires_write: required` (boolean `true` still aliases). The inverse —
`requires_write: forbidden` onto `write_access: true` — is the same helper,
the same refusal moment. Either side undeclared is no constraint at all, so
every profile written before this field keeps dispatching exactly as it did.
When it is declared, `write_access` lands in the evidence-row identity (so both
the request and completion rows carry it), and a dispatch that proceeds on a
`write_access: false` route gets a `[write_access: none]` tag in the resolution
echo — a read-only delivery is visible when it is chosen, not inferred later
from a report that changed nothing.

The same conflict is refused at every point that can choose a command
delivery, not just the ad-hoc kernel. `drive` checks before spawning a command
dispatch for a role: the actor fails pre-spawn (`actor_failed` with
`reason: "write_access_denied"` and `write_access: false` on the event) and
the run pauses in `executor_failed` — no prompt assembled, no run burnt.
`steering resolve` returns `mode: write_conflict` instead of presenting the
slot as a clean command delivery, and `steering apply` declines to materialize
a command broker for a conflicted slot while other slots proceed. All three
speak through one helper — `explainWriteConflict(delivery, archetype,
profile)` in `src/lib/executors.ts` — so the refusal text is identical
everywhere. Exempt by design: native in-session deliveries (the host's
permission fences are the host's business) and locked engine host requests
delivered through `dispatch-fallback`, where refusing would strand an
in-flight request mid-receipt.

**Why this exists (dogfood, 2026-08-12).** A commit task resolved to the
worker slot and was delivered through `routes.claude.anthropic`'s fallback
`claude -p`, which runs headless in the default permission mode: there is no
interactive approver in that process, so nothing can approve a git commit. It
is an advisory-only delivery that was bound as a worker slot, and the kernel
dispatched it because it read "the route has a `command`" as "the route is
dispatchable." Being able to *deliver a prompt* is not being able to *do the
work*. The same catalog already carried the distinction one line away — the
grok route passes `--permission-mode acceptEdits` explicitly — but only inside
argv, where no check can read it. `write_access` promotes that from a string
nobody parses to a declaration the kernel can refuse on.

## Archetype policy

`archetypes:` is an optional top-level mapping. Each entry accepts exactly
three keys — `requires_write`, `fallback`, and
`distinct_provider_from_inputs` — and an unknown key is an error, so a
typo cannot silently drop a safety constraint. Provider distinctness is
a constraint-tier predicate; see *Constraint tiers*.

**Write posture.** `requires_write` is three-valued: `required`, `forbidden`,
or `none`. Booleans remain accepted as aliases (`true` → `required`,
`false` → `none`) so catalogs written before the triad keep parsing.
Absent `requires_write` is `none`. The posture is read from the *declared*
archetype only; a fallback chain never imports another archetype's policy.

**Enforcement is asymmetric.** On a command route, the kernel refuses the
mismatches (`required` × `write_access: false`, `forbidden` ×
`write_access: true`) at every point that can choose a command delivery:
the dispatch boundary (`dispatch`, `drive`, `steering resolve`/`apply`) and
at dial time (`fadeno loadout set`). On a native in-session delivery the
posture is advisory only — it rides as a prompt instruction and as evidence
on the `native_delivery` row — because the host owns the session's
permissions. Either side undeclared is no constraint.

**`generator` is the fourth canonical archetype**, and the only addition to
the seeded triad. Canon is earned by a kernel-enforceable policy: generators
do divergent, artifact-producing work that must not mutate the workspace
(`requires_write: forbidden`), and they misroute today as worker-shaped
cognition onto write-capable routes. The starter catalog ships:

```yaml
archetypes:
  worker:
    requires_write: required
  generator:
    requires_write: forbidden
    fallback: worker
```

No loadout grows a `generator` slot — the fallback serves every existing
loadout. There is no `fadeno:generator` native agent or dispatch proxy;
native delivery walks the chain to the worker surface and carries the
write-forbidden instruction in the prompt. Dedicated surfaces wait on
traffic.

**Fallback chains** select a *binding*, never a policy. Resolution walks the
declared archetype, then its `fallback`, then that one's fallback, …; at
each step it tries the session override, then the active loadout slot. An
archetype without a slot therefore resolves through its fallback's binding.
Chains among declared archetypes must be acyclic (validated at parse); an
undeclared fallback name is a legal end-node (it may still hold a slot).
Overrides beat fallbacks because the cascade re-enters per chain step —
`fadeno loadout set generator grok-default` binds generator directly.
Canonical archetypes may declare fallbacks (`generator` → `worker` above);
the mechanism is uniform.

**Evidence.** A row bound through a fallback chain carries `resolved_via`
naming the chain archetype that bound (absent when the declared archetype
bound directly). Rows that carry the new field are stamped `format: "0.2"` —
additive, same major as `format: "0.1"`; old rows still read. Isolated-delivery
preference (sandbox or worktree instead of refusal) is deferred to route
operational policy.

## Constraint tiers

Three **tier-1** predicates sit at the dispatch boundary — the same
chokepoint as write posture. Each is declared data, evaluated before a
command is spawned, and recorded as evidence. Policy is always read from
the **declared** archetype only; a fallback chain never imports another
archetype's distinctness, eligibility, or write posture.

**Write posture** (phase 2, listed because the others follow it) is
`requires_write: required | forbidden | none` on the archetype, matched
against the route's `write_access`. Enforced on command deliveries;
advisory on native in-session deliveries. See *Write access*.

**Provider distinctness** — the resolved target's provider must differ
from every input producer's:

```yaml
archetypes:
  reviewer:
    distinct_provider_from_inputs: advisory   # or: required
```

`required` refuses a clash (and refuses when provenance is demanded but
unresolvable). `advisory` warns, records, and proceeds. No declaration is
no check. On the engine path, producers come from the run's own events
(input `artifact_created` → that actor call's `actor_dispatched` →
executor → provider on the **snapshot** profile, never the live catalog);
an input with no in-run producer is unresolvable (`provider: null`).
Ad-hoc dispatch takes explicit `--produced-by <dispatch-id>` instead.

**Eligibility states** — per-target (or v1 executor), per-archetype:

```yaml
targets:
  kimi-k3:
    provider: moonshot
    model: openrouter/moonshotai/kimi-k3
    eligibility:
      generator: eligible        # default; may be omitted
      reviewer: shadow_only      # runs, evidence-tagged, never a refusal
      judge: forbidden
```

`eligible | shadow_only | forbidden`, default `eligible`. `forbidden`
refuses at dial time (`fadeno loadout set`) and at dispatch time.
`shadow_only` permits the dispatch and stamps the row
`gate_eligible: false`. **Gate consumption semantics do not change in
phase 3** — a shadow-stamped artifact still feeds `no_blocking_issues`
and the other evaluators exactly as an eligible one does. Non-gating is
phase 4.

**Advisory vs enforced.** `distinct_provider_from_inputs: advisory`
warns; `required` refuses. Eligibility `forbidden` is always a refusal
(command path); `shadow_only` is never a refusal. Instruction-only hosts
cannot run these checks themselves — they inherit the same
advisory/enforced split as write posture.

**Evidence.** Format stays `0.2`; every field and the one new event are
additive.

- Ad-hoc boundary refusals append one `dispatch_refused` row (no
  `dispatch_requested`) with
  `refusal: { predicate, message }`. Predicates:
  `write_posture` | `eligibility` | `provider_distinctness` |
  `constraint_command`.
- Proceeding ad-hoc rows may carry `input_provenance` (the
  `--produced-by` list), `provider_distinctness: "warned"`, and
  `eligibility: "shadow_only"` + `gate_eligible: false`.
- Engine command refusals are `actor_failed` with reason
  `eligibility_forbidden` | `provider_conflict` | `constraint_refused`
  (outcome `executor_failed`; nothing spawned). An advisory clash stamps
  `provider_distinctness: "warned"` on `actor_dispatched` and emits an
  act() warning. A `shadow_only` dispatch proceeds with
  `gate_eligible: false` on `actor_dispatched`.
- `fadeno verify` recomputes `gate_eligible` from the snapshot:
  stamped `false` must recompute as `shadow_only`; an unstamped row
  must not (absent = a claim of eligible — stricter than `resolved_via`,
  because the snapshot makes eligibility recomputable). Constraint-command
  outcomes are **attested, not recomputed** — executable config is not
  replayable policy.

**Dial time.** `fadeno loadout set <archetype> <target>` refuses a
`forbidden` pairing (after the write-posture check) with the kernel's
own `explainEligibilityConflict` message. `shadow_only` dials. Effective
tables and `loadout resolve` annotate a row's eligibility when it is not
`eligible`.

### Tier 2: constraint command

For project-specific logic the vocabulary cannot express:

```yaml
constraints:
  command: [node, .fadeno/constraints.mjs]
```

Invoked at the dispatch boundary with the resolution context as JSON on
stdin (archetype, role, executor, target, provider, model, transport
`command`, write access/posture, active loadout + overrides,
`resolved_via`, input provenance, harness). Exit 0 allows; exit 2
refuses (trimmed stderr is the reason, or a fixed fallback when stderr
is empty); any other exit, spawn failure, or signal is a
constraint-system error — loud (`DriveError` / `DispatchCommandError`),
never an allow.

Executable config is a heavier trust surface than data. Instruction-only
hosts cannot run it, so it inherits the advisory/enforced split. Tier 1
is preferred wherever it fits; tier 2 exists so Fadeno never needs a
policy language.

## CLI

- `fadeno setup` / `fadeno use` / `fadeno status` / `fadeno doctor` — the
  low-friction setup path, user selection, effective state, and read-only checks.
- `fadeno loadout` — show the active loadout, its source, and the full
  archetype→executor table.
- `fadeno loadout list` / `fadeno loadout use <name>` / `fadeno loadout clear`
  — `use` writes `.fadeno/local/loadout`; `clear` removes it.
- `fadeno dispatch --archetype <a> [--role <name>] [--loadout <name>]
  [--executor <name>] [--prompt-file <path>] [--shadow <executor>]` — prompt from `--prompt-file`
  or stdin; resolves per the order above (`--executor` bypasses resolution
  for debugging); invokes the executor; report to stdout; appends the evidence
  row pair. `--shadow` fires a one-shot shadow duplication with the
  byte-identical prompt, isolated in a worktree; also available as
  `fadeno loadout shadow <archetype> <executor> [--rate <0..1>]` and
  `fadeno loadout clear-shadow [archetype]`. Ad-hoc dispatch spawns commands, so what it can invoke is a
  property of the *route*, not of the target: a command-delivered route runs
  its argv, and a `native: true` route runs its fallback `command` when it
  declares one. A natively-routed target with no fallback command is a clear
  error that names the fix — run this archetype-shaped task with the native
  in-session agent, declare a fallback command on the route, or bind the
  archetype to a command-delivered target.
- `fadeno dispatches [--tail <N>] [--json] [--comparisons]` — read the evidence back; see
  *Evidence*. `--comparisons` groups shadow pairs by challenger, attests
  prompt-sha pairing, and scans `.fadeno/comparisons/*.md` (`kind: ModelComparison`)
  for verdict tallies.

**Resolution echo:** every run start (`new-run`/`drive`) and every dispatch
prints where each actor landed, so a user burning a metered subscription
never wonders which provider a run is spending:

```
implementer → luna-medium (gpt-5.6-luna) [loadout luna]
opus_reviewer → claude-default (opus) [binding]
```

## Evidence

- Playbook runs: the run ledger records the resolution snapshot — active
  loadout name + source, and per-role `(executor, model, resolution source)`
  — at first engine contact (`drive`), re-appended only when the resolution
  changes, so two runs of the same playbook under different loadouts are
  distinguishable artifacts after the fact. (Refined from "at run creation"
  during implementation: `new-run` never loads the executor profile, and
  snapshotting at drive time is the honest expression of "resolution is
  computed at dispatch time" — `new-run` still echoes a non-ledger preview.)
- Ad-hoc dispatch: append-only `.fadeno/dispatches.jsonl`, a correlated row
  pair per dispatch — `dispatch_requested` before the executor is invoked,
  `dispatch_completed` after, sharing a `dispatch_id` — each carrying the
  identity (timestamp, archetype, role if given, loadout + source, executor,
  model, prompt digest, `output_snapshot`), with exit status, duration, output
  digest, `output_bytes`, and `workspace_changed` on the completion row, so a
  dispatch killed mid-flight still leaves its request row. `output_snapshot`
  is the repo-relative streamed-stdout path, stamped on the request row
  *before* the spawn so partial bytes stay discoverable; `output_bytes` is
  the snapshot's byte length; `workspace_changed` is a git-fingerprint
  attestation (omitted when unknowable) — concurrent writers make it
  attestation, not judgment.
  (Refined during dogfooding: each row also records `resolution` — how the
  executor was chosen: `binding` | `loadout` | `fallback` | `executor-flag`;
  and the file is per-machine evidence, gitignored by scaffolding — auditable
  locally, never committed, mirroring the `.fadeno/local/` rationale.) Rows
  are stamped `format: "0.1"`. Newer rows are stamped `format: "0.2"` — same
  major, additive fields (`resolved_via` on a fallback-chain bind, plus the
  override field from session dials) — and old rows still read as current.
  The reader treats unversioned rows that carry
  a recognized `event` as current, renders pre-two-row completion-only rows
  as `[legacy]` entries instead of dropping them as unreadable, and counts
  rows from a newer format major separately — old evidence ages into legacy,
  it does not degrade into noise.
- Native delivery: the steering hook appends a `native_delivery` row to the
  same `.fadeno/dispatches.jsonl` whenever it steers a spawn to a native fadeno
  role agent — timestamp, `event: "native_delivery"`, archetype, agent_type
  (as requested, before the rewrite), loadout, executor, model,
  model_override, `reasoning_effort: "inherited"`, `transport: "host-native"`,
  prompt_sha256, prompt_snapshot (a verbatim copy of the spawn prompt at
  `.fadeno/local/prompts/native-<sha8>.md`), and `hook_version` — which
  generation of the hook wrote the row, per the lag caveat under *Host steering
  integration*. A command dispatch gets two kernel
  rows, a kernel-owned snapshot, and relay attestation; the kernel is never
  invoked on the native path, so the hook is the only component that can
  witness a native delivery at all. Writing it to
  the same file makes `dispatches.jsonl` the single audit point across both
  delivery routes — "which executor produced this" stops depending on which
  route the loadout happened to take. Best-effort, like the relay stash: a
  failed evidence write never changes a steering decision. Claude-specific for
  now: only the Claude harness has a spawn hook, so native deliveries in other
  harnesses stay unwitnessed until they grow an equivalent interception point.
- Reading it back: `fadeno dispatches [--tail <N>] [--json]` renders the log
  instead of leaving it to `jq`. It correlates each
  `dispatch_requested`/`dispatch_completed` pair by `dispatch_id` into one row,
  renders `native_delivery` rows beside them so both delivery routes read as
  one history, and marks a request whose completion never arrived — "no
  completion recorded (killed or in flight)" — rather than dropping the
  dispatch that most wants explaining. Markers surface the identity that
  changes what a row means: `relay_attested`, `[write_access: none]`,
  `model_override`, `[shadow of <primaryId8>]` (shadow rows, never candidates
  for `[no workspace change]`), and `[no workspace change]` (exit 0 +
  `write_access: true` + `workspace_changed: false`). Shadow rows carry
  `shadow: true`, `primary_dispatch_id`, `shadow_source: "attachment" | "flag"`,
  `gate_eligible: false`, `output_snapshot: ".fadeno/local/outputs/shadow-<shadowId8>.md"`,
  `diff_snapshot: ".fadeno/local/outputs/shadow-<shadowId8>.diff"`,
  `diff_bytes: <int>` (and omit `workspace_changed`; the diff is the change
  record); `dispatch_refused` shadows add `predicate: shadow_isolation |
  shadow_resolution`. `fadeno dispatches --output <id|last>` recovers the
  streamed snapshot (`last` = most recent request row carrying
  `output_snapshot`) and attests the file against the completion row's
  `output_sha256` (`incomplete` when that row never arrived) — and the same
  recovery works for shadow ids. `--tail <N>` defaults to 10; `--json` emits
  the correlated rows for scripts, carrying `shadow`, `primary_dispatch_id`,
  and `diff_bytes`. `fadeno dispatches --comparisons [--json]` renders paired
  primary/shadow rows grouped by challenger executor (both id8s, archetype,
  `primary executor (model) exit N, output B bytes` vs
  `shadow executor (model) exit N, output B bytes, diff D bytes`, with
  `PROMPT SHA MISMATCH` when the prompt digests disagree and `[orphan]` when
  the primary row is missing), plus any `ModelComparison` artifacts under
  `.fadeno/comparisons/*.md` (`kind: ModelComparison`, `baseline`, `challenger`,
  `verdict: prefer_baseline | prefer_challenger | tie | inconclusive`, `date`,
  `dispatch_ids` plus mandatory `## Criteria` and `## Confounds` sections) and
  a per-challenger tally (`N pairs, M comparisons: X prefer_challenger / Y
  prefer_baseline / Z tie/inconclusive`).

This makes Fadeno the only layer that sees cross-provider usage — the natural
future home of per-provider burn reporting (a later `fadeno usage`; not in
this boundary), which closes the loop on the subscription-cycling need.

## Host steering integration

The harness will never run non-Anthropic inference natively (custom-agent
`model:` accepts Claude models only), so cross-harness subagents go
out-of-process: **dispatch proxy agents**, shipped in the plugin, one per
archetype (`dispatch-worker`, `dispatch-reviewer`, `dispatch-judge`):

- `tools: Bash`, `model: sonnet` — the proxy does no thinking, so the smallest
  model looked right; a dogfood A/B (2026-08-12) revised that. Haiku defected
  on the relay contract — performed a survey task itself with no dispatch and
  no evidence, and when it did comply it dropped the prompt's first line and
  asserted an evidence row that was never written. Sonnet relayed flawlessly,
  and a proxy turn is only a few relay tokens, so the upgrade costs cents.
- Behavior: ONE Bash call (tool `timeout` raised to 600000 ms — external
  executors routinely exceed the 2-minute default) that pipes the received
  task prompt **verbatim** to `fadeno dispatch --archetype <a>` as a quoted
  `<<'FADENO_PROMPT'` heredoc on stdin, then relays the report verbatim. The
  delimiter is fixed and the quoting is load-bearing: the guard below
  allowlists that exact shape, and quoting is what stops the shell from
  expanding a prompt that happens to contain `$` or backticks. The kernel writes the
  prompt snapshot to `.fadeno/local/prompts/` and the evidence rows itself —
  a single writer, so the recorded digest attests exactly the bytes it
  received. The call is spelled with bare `fadeno` first so the
  `Bash(fadeno:*)` rule `init` pre-approves also covers dispatches under
  default permissions (the `$CLAUDE_PLUGIN_ROOT/bin/fadeno` spelling is the
  not-on-PATH retry). One LLM copy step — prompt into heredoc — remains
  unavoidable; the relay attestation below checks it.
- The Agent-tool contract — self-contained prompt in, final report out, no
  shared conversation context — is byte-for-byte the one-shot executor
  contract, which is why this substitution is architecturally honest.

Steering ladder:

1. **Description routing** (shipped): proxy descriptions carry "use proactively /
   MUST BE USED for <archetype>-shaped subtasks when a Fadeno loadout is
   active." Soft but supported.
2. **PreToolUse rewrite hook** (shipped by default for Claude): match the `Agent` tool,
   return `updatedInput` rewriting worker-shaped `subagent_type`s to the
   dispatch proxies. Deterministic — covers automatically-launched
   subagents. The hook stays dumb; resolution stays in the CLI.
3. **Proxy contract guard** (shipped): a `PreToolUse` Bash hook scoped by the
   hook input's `agent_type` to the dispatch proxies. It allowlists exactly
   the contract call — the single stdin-heredoc dispatch statement, with the
   heredoc *body* (the user's task prompt) deliberately never inspected, plus
   the prompt-file retry and the legacy prompt-file-write shapes older
   init-emitted agents still use — denies everything else with an actionable
   reason, and rewrites the dispatch call's Bash `timeout` up to 600000 ms.
   The routing rungs steer *to* the proxy; this rung is tier-2 enforcement
   that the proxy *body* honors verbatim relay — instruction-only proxies
   were observed defecting (see the model note above). Caveat: the guard
   keys on the harness supplying `agent_type` in hook input; on harness
   versions that omit it the guard no-ops silently and the contract degrades
   to advisory.
4. **Strict mode** (deferred, opt-in): disable built-in agent types via
   `permissions.deny` / harness env flags so proxies are the only targets.

**Hook generations are ambiguous from the inside.** A harness binds its hook
*registrations* — which events run which scripts — at session start, like its
agent and skill surface. Script *content* is looser: the registered command
points into the plugin cache, and a live 2026-08-12 session begun under one rc
was observed executing a later rc's script after a mid-session plugin update,
no reload involved. So neither "my change is live" nor "my change can't be
live yet" is safe to assume — refresh semantics belong to the harness and
differ by what changed (registrations and surfaces lag until reload; script
bodies may not). A rung that was just fixed and a rung that is genuinely
broken look identical from inside the session that fixed it, which is how "the
hook is ignoring my change" gets diagnosed as a bug for an hour. Hook-written
evidence therefore carries `hook_version` — stamped `dev` in the committed
template and the package version in every emitted copy — so a row identifies
the generation that actually wrote it, and the question settles from evidence
instead of by argument. (The rows that revealed the mid-session refresh were
dated exactly this way: they existed, so the writer was at least the
generation that introduced them; they lacked `hook_version`, so it predated
the one that stamps.)
The agent and skill surface has the same skew and the same answer: plugin
generation appends `[fadeno <version>]` to every agent and skill description,
so a live session's loaded surface can be checked for staleness against
`claude plugin list` rather than assumed current. Kernel-written rows have no
such gap — the CLI is re-executed per dispatch, so it is always the installed
generation.

**Relay attestation.** The one unverifiable step left is the proxy copying
the prompt into its heredoc. The spawn-side steering hook closes it: whenever
a subtask heads to a dispatch proxy (rewritten *or* explicitly targeted), it
stashes `{timestamp, prompt_sha256}` of the Agent call's prompt to
`.fadeno/local/pending-relays.jsonl`. At dispatch time the kernel matches the
received prompt against fresh stashes (content-keyed, so concurrency is safe;
tolerant of the single trailing newline a heredoc appends; entries expire
after an hour) and marks the evidence row `relay_attested: true` (consumed
match), `false` (fresh stashes pending but none matched — the relay altered
the prompt), or omits the field (no hook flow in play). Evidence-only: it
never blocks a dispatch.

**Retyping fidelity.** The generalized rule behind the heredoc contract, the
kernel-owned snapshot, and the attestation: *text that must arrive verbatim
travels as bytes — a file or stdin — and is never retyped by a model.* Two
live confirmations, both 2026-08-12: the haiku proxy dropped a prompt's first
line while relaying it under an explicit verbatim instruction (the A/B above),
and an opus worker, told to reproduce a commit message exactly, mutated an em
dash into `--` while copying it. Byte fidelity through model transcription is
unreliable at every capability tier — it is not a small-model defect that a
larger model retires. Any hop where bytes matter therefore hands over a path or
a stream, never a passage to re-emit; the single copy step the proxy still
performs is the exception that the attestation exists to check.

**Native delivery honors half an executor's identity.** In-session delivery can
pin the *model* — the harness Agent tool takes a `model` parameter, and the
rewrite hook sets it from the resolved slot — but it cannot pin reasoning
effort: the Agent tool schema has no effort parameter. A target like
`opus-xhigh` therefore delivers natively as opus at whatever effort the session
inherited. An executor's identity is model + effort, so a native delivery
satisfies one half of it and inherits the other. `native_delivery` rows record
`reasoning_effort: "inherited"` rather than the declared effort, so the
evidence never claims an effort the delivery had no way to set. Command
delivery has no such gap: the route's argv carries the effort flag itself.

Codex does not expose the same spawn-rewrite hook. Project `init` installs
safe native broker agents by default; `--no-steering` selects the static legacy
agents instead. `fadeno setup --codex` records the harness and materializes
user-scoped managed agents; later `fadeno use <loadout>` refreshes them
automatically and requires a fresh session only when they changed. Explicit
project overrides remain available with `fadeno steering apply
<loadout> --codex --scope project`, which
materializes every loadout slot: natively-routed slots become session-native
agents and command-routed slots become cheap brokers. Each role checks the
kernel before every task: a matching native slot runs locally, a command-routed
slot dispatches out-of-process immediately, and a different native slot uses
its route's declared fallback command when present. Only a natively-routed slot
with no fallback command returns `restart_required`. Locked engine requests use `dispatch-fallback`, which
authenticates the run snapshot and records command transport rather than native
attestation. Applying changed agent definitions requires a fresh Codex session
to make the new model native; fallback-capable switches take effect at the next
role invocation without one.

This ambient precedence applies to ordinary ad-hoc role invocations and to
future engine requests before they are minted. Once `fadeno drive` records a
`host_dispatch_requested` event, that request is immutable: its delivered agent
must resolve the run/dispatch pair against the run's profile snapshot, and the
minted executor takes precedence over later environment, sticky-local, default,
or live-profile changes.

**What stays native:** Explore/Plan-style read-only scouting — cheap, tightly
integrated with the harness's codebase tools, and not where quota pressure
lives. The rewrite hook must be selective (worker-shaped types only). The
arbitrage win is expensive worker turns.

**Permission boundary (must stay loud):** an external worker invoked with its
own sandbox flags (e.g. `codex exec -s workspace-write`) runs *outside* the
host harness's permission fences. Enabling dispatch proxies is an explicit
user opt-in with this stated plainly; the dispatch evidence row is the
compensating audit trail.

## Parallel dispatch fan-out

The kernel makes one dispatch cheap, so the interesting failure mode is
*several at once*. Two live fan-outs on 2026-08-12 ran multiple workers in
parallel over this repo, and none of the damage came from the model work — all
of it came from the contract between the workers. Four rules, each of them paid
for.

**Freeze the contract before the fan-out, not during it.** Every name a worker
will write — event and field names, config keys, file paths, flag spellings,
the exact text of a refusal — is fixed before any worker starts and repeated
verbatim in every prompt that touches it. Workers cannot negotiate: they share
no conversation, they finish in an arbitrary order, and a worker that coins a
perfectly reasonable synonym produces work that reads correct in isolation and
refuses to compose. Docs drift the same way and more quietly, which is why the
frozen tokens go to the documentation worker verbatim too — and why a test that
asserts those tokens still appear is worth more than another review pass, since
it survives the run that created it.

**Per-worker ownership manifests, with the mandatory-exception rule.** Each
worker's prompt names the files it owns; siblings own the rest. A flat "stay in
your lane" rule is wrong, though, and one of the live runs proved it: a feature
landed complete inside its own manifest and was one line short of being wired
into the merge layer that made it apply anywhere — and that line lived in a file
another worker owned. Staying in the lane would have shipped something inert.
The rule is therefore **edit-and-flag, never silently skip**: an edit outside
your manifest that is *required for the change to be correct* is made, and
named in the return value so the integrator sees it coming. The failure to
design against is not two workers touching one file — that is a merge conflict,
which is loud. It is a correct-looking change that does nothing.

**Finish-order independence.** No worker may plan to reconcile its output
against a sibling's landed work. Ordering is not guaranteed and not
observable from inside a worker: the sibling may finish after you, fail, or be
killed mid-flight leaving only a `dispatch_requested` row. A fan-out where this
worked is a fan-out where it worked by luck, and the luck does not repeat when
one worker takes three times as long. A worker that needs a sibling's artifact
is given that artifact's *contract* instead (the frozen names above), and the
reconciliation happens once, afterwards, by someone who can see both.

**The integration phase is a phase, not a cleanup.** It owns exactly what the
manifests deliberately excluded: cross-cutting files, generated-surface
rebuilds (`npm run build:plugin`), the changelog, and the first run of the full
suite. That last one matters because workers are mid-flight against a tree
their siblings are still mutating, so suite-level guards that compare generated
output to its source — the plugin no-drift check — fail for reasons no worker
caused and can burn a worker's turn chasing them. `FADENO_SKIP_DRIFT=1` is the
documented escape hatch for that window only; the integrator runs the suite
without it, which is the run that counts.

The starter playbook `parallel-workstreams` encodes this as a runnable
workflow rather than as advice: contract freeze → fan-out under manifests →
integration → full verification.

## Non-goals

- **No auto-fallback.** Quota exhaustion pauses and offers explicit
  substitution (same-archetype executors from other loadouts as one-action
  choices). Silently swapping which model produced an artifact mid-run
  corrupts what the run's evidence means.
- **No resident router, daemon, or scheduler** (next-protocol constraint).
- **Loadout slots bind to declared targets, never bare model names** — a bare
  model name states neither the effort it runs at nor how this harness reaches
  it; effort belongs to the target and the harness-specific flags belong to the
  route, so the target stays the unit of swap.
- **No harness-config caching of resolution** — the CLI is the single
  resolver.
- **No inferred or granted write access** — `write_access` is a declaration
  about a route the user configured. Fadeno never appends permission flags to
  an executor's argv and never infers the field from argv it did not write; an
  undeclared route stays unconstrained, and the check refuses only the
  mismatches it was told about.

## Sequencing

1. **Kernel:** schema (`loadouts`/`default_loadout`/`archetype`) +
   resolution + `fadeno loadout` + `fadeno dispatch` + evidence + echo.
2. **Plugin surface:** dispatch proxy agents + description routing +
   prompt-file relay convention.
3. **Host steering** (default for Codex/Claude): Claude hook rewrite + Codex role overrides.
4. **Strict mode** (deferred).

Slices 1–3 are shipped; strict mode would only sharpen routing, never change
resolution semantics.

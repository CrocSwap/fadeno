# Slot ergonomics and the open archetype vocabulary

**Status:** phases 1–5.5 implemented — 1 (session slot overrides, 0.6.0-rc.9),
2 (archetype schema pass, 0.6.0-rc.12), 3 (constraint tiers, 0.6.0-rc.13),
4 (shadow dispatches + model tryouts, 0.6.0-rc.15), 5 + 5.5 (symmetric pairs,
trustworthy isolation, measured identity — merged to main 2026-08-20).
*Effort decides the lane* is **built**, both halves.
**Decision date:** 2026-08-12
**Relationship:** successor horizon to
[`loadouts-and-dispatch.md`](loadouts-and-dispatch.md) (extends its catalog,
resolution chain, and dispatch-boundary enforcement); grounded in
[`case-study-erdossweep.md`](case-study-erdossweep.md) (gap list) and in
dogfood receipts from the 0.6.0-rc cycle. Inherits the standing constraint
set: no daemon, no cloud service, no scheduler; evidence over trust.
**Successor:** [`dials-and-registry.md`](dials-and-registry.md) (proposed
2026-08-15) keeps this document's slot-as-the-unit principle and everything
downstream of resolution, and retires the one layer it preserved: the named
loadout preset. Read it before extending the selection surface.

## Observed need (admission receipts)

1. **Profile combinatorics.** Loadouts bind archetype → target as named
   tuples. Users switch one archetype at a time — usually the worker, as
   subscription quotas deplete — and keeping every wanted combination as a
   named profile requires T^A profiles for T targets and A archetypes. The
   original loadout design doc already concedes the unit of user intent:
   *"who is my worker / reviewer / judge right now."* That is a per-slot
   unit; profiles overshot it.
2. **The archetype triad is code-shaped.** The erdosSweep case study derived
   six natural archetypes from one real research campaign (prover, critic,
   verifier, scout, formalizer, grader); only formalizer→worker and
   grader→judge map cleanly. Its attacker role actively *misroutes* today:
   worker-shaped cognition whose write posture is inverted (must NOT write),
   which trips the worker write-access policy backwards.
3. **Relational and stateful executor constraints.** erdosSweep's
   load-bearing integrity rules — critic family ≠ attacker family;
   kimi "attacks count, gate critiques NO, supplementary sweep approved" —
   are relational and stateful predicates no static positive catalog can
   express. All of them are checkable at the existing dispatch boundary
   against data the evidence ledger already records.
4. **Model test-driving.** Users want to trial a new model against their
   workhorse *inside their own typical workflows*, not benchmarks: run the
   same worker job on both, have a judge compare qualitatively, accumulate
   evidence, then promote or drop. The rc-cycle dogfood already ran this
   protocol by hand (the haiku-vs-sonnet proxy A/B: identical prompt ± arm
   marker, sha-verified against ledger rows) — the method works; only the
   automation is missing.

## Design principles

- **The slot is the unit.** Loadouts remain shareable *presets*; a
  session-level per-slot override is the switching primitive; a per-slot
  shadow attachment is the experimentation primitive. One cascade, three
  intensities: preset → override → shadow.
- **Canonical status is earned by policy, not popularity.** An archetype
  enters the canon only when it carries a policy the kernel must enforce.
  Names alone stay repo-declared — fallback chains (below) make that
  costless for compatibility.
- **Fallback resolves bindings, never policy.** A repo-declared archetype
  falls back to another archetype's *loadout slot* when unset; it never
  inherits the other archetype's policy. Undeclared policy remains
  unconstrained, exactly as today.
- **One chokepoint.** Every constraint in this document — write posture,
  provider distinctness, eligibility, shadow non-gating — is a predicate at
  the dispatch boundary where write-access refusal already fires, evaluated
  against resolution context plus ledger provenance. No second enforcement
  surface.
- **The ledger is the connective tissue.** Overrides, fallback resolutions,
  shadow pairings, and constraint refusals all land as evidence. Additive
  ledger format bump 0.1 → 0.2, using the versioning machinery that exists.
- **Kernel owns mechanism, humans own verdicts.** Shadow comparisons and
  eligibility annotations produce and consume evidence; promotion decisions
  (which model, which loadout) stay with the user.

---

## Phase 1 — session slot overrides

**What:** override a single archetype's binding on top of the active loadout,
without authoring a profile.

```
fadeno loadout                      # effective table (see Visibility)
fadeno loadout use claude           # select base preset (existing)
fadeno loadout set worker grok-default
fadeno loadout clear worker
```

**Resolution cascade** gains one layer, in existing precedence order:

```
explicit role binding → session override → active loadout slot → bindings["*"]
```

**State:** `.fadeno/local/loadout` grows from a bare loadout name to
`{loadout, overrides: {archetype: target}}`. Same file, same scope, same
lifetime rules as the selection it decorates. **Switching the base loadout
drops all overrides** — a stale `worker=grok` surviving a `use codex` is the
surprising case; if the delta is still wanted, redial it.

**Visibility:** `fadeno loadout` with no arguments prints the *effective*
table, one row per archetype, overridden slots explicitly marked (actual
shipped output — the implementation kept the established header/row shape
and appended the override marks):

```
active loadout: claude (via .fadeno/local/loadout) +1 session override(s)
  judge    → grok-default (grok) [command]  OVERRIDE (base: opus-x)
  reviewer → opus-x (opus) [command]
  worker   → opus-x (opus) [command]
```

An invisible overlay is how a user silently burns the wrong subscription for
a week; the no-arg command is the primary UI, not an afterthought.

**Set-time checks:** `loadout set` resolves the target's route for the
current harness immediately and applies the archetype policy check
(`explainWriteConflict` and successors) at dial time, refusing or warning
before the first dispatch — the same predicate later re-checked at dispatch.

**Evidence:** dispatch rows record the effective binding *and* that an
override produced it (`loadout: "claude"`, `override: {worker:
"grok-default"}` or equivalent). Rows already record resolved
executor/model, so audits never depended on the loadout name alone; this
keeps the ledger honest, not merely sufficient.

**Starter catalog change:** rewrite starter loadouts to use `current-host`
as the filler for every slot that is not the loadout's point. The
harness-relative target already kills the harness × loadout dimension of the
explosion (`{worker: grok-default, reviewer: current-host, judge:
current-host}` is one profile correct on every host); the starters should
model that idiom instead of pinning concrete targets in every slot.

**Shipped (0.6.0-rc.9).** Deviations from the sketch above, all deliberate:
refusals exit 1 (the CLI has a single top-level error path; there is no
exit-2 convention to join); the effective table appends `OVERRIDE (base: …)`
to the established row shape rather than adopting the sketched two-column
layout, so existing output contracts stay valid; `--json` was added across
the loadout subcommands as new surface; `fadeno status` resolves its roles
through the overlay and tags them `[override]`, but still enumerates only
the canonical triad — an override binding a non-triad archetype is visible
in `fadeno loadout` only. An override can bind an archetype the base
loadout has no slot for (renders `(base: none)`), which is the seed of
phase 2's fallback semantics. Evidence landed as specified: dispatch rows
gain `resolution: "override"` plus an `override` field, run
`resolution_snapshot` events gain `overrides`, and verification replays
from the snapshot, never the live pin (a cleared override cannot fail a
completed run's verify). Ledger format deliberately stays "0.1" — these
are additive fields; the 0.2 bump still rides phases 2–4.

## Phase 2 — archetype schema pass

One coherent schema change; the pieces travel together because they touch
the same parsing and validation code.

### Three-valued write posture

```yaml
archetypes:
  worker:
    requires_write: required     # today: true
  generator:
    requires_write: forbidden    # new value
```

`requires_write: required | forbidden | none`. Booleans remain accepted as
aliases (`true` → `required`, `false` → `none`) so existing catalogs parse
unchanged. `forbidden` refuses dispatch onto routes declaring
`write_access: true` the same way `required` refuses `write_access: false`
today — and, better than refusal where the route supports it, prefers an
isolated delivery (sandbox flag, worktree) when one is declared.

*Honest caveat:* on host in-session deliveries the host holds the
session's write permissions, so `forbidden` is advisory there (prompt-level
instruction, recorded in the `host_delivery` evidence row) — the same
advisory/enforced split `enforcement.md` already documents for
instruction-only hosts. On command routes it is real.

### The `generator` canonical archetype

Fourth and only addition to the canon, by the canon criterion: it carries a
kernel-enforceable policy (`requires_write: forbidden`) and it misroutes
today. Divergent, replicated, artifact-producing work — competing design
drafts, judge-panel candidates, proof attempts. Ships in the starter catalog
as:

```yaml
archetypes:
  generator:
    requires_write: forbidden
    fallback: worker
```

so every existing loadout serves generators with zero edits. Surface cost is
deliberately deferred: no dedicated `fadeno:generator` host agent or
dispatch proxy initially — host delivery resolves through the fallback
chain to the worker surface with the write-forbidden instruction carried in
the prompt (see host delivery, below). Dedicated surfaces come only if the
archetype earns traffic.

**Explicit non-additions:** `verifier` and `scout` (and `critic` as distinct
from reviewer) remain repo-declared vocabulary. They are real archetypes in
research workflows but carry no kernel-enforceable policy yet; fallbacks
make them work everywhere without canon status.

### Fallback chains

```yaml
archetypes:
  scout:               # repo-declared example
    fallback: reviewer
```

Resolution for a role with archetype `scout` under a loadout with no `scout`
slot: follow the chain (`scout → reviewer`) until a slot binds; terminate at
`bindings["*"]`. Rules:

- **Bindings only.** The chain selects an executor; it never imports the
  fallback archetype's policy. `scout` with no declared policy stays
  unconstrained even when bound via `reviewer`'s slot.
- **Acyclic, validated at parse.** A cycle is a catalog error, not a runtime
  surprise.
- **Overrides beat fallbacks.** `fadeno loadout set scout kimi-k3` binds the
  declared archetype directly; the chain applies only when nothing binds the
  archetype itself.
- **Canonical archetypes may declare fallbacks too** (generator → worker
  above); the mechanism is uniform.

**Host delivery for open vocabulary:** the steering layer needs a concrete
agent surface for in-session delivery. It walks the fallback chain to the
first archetype with a host surface (worker/reviewer/judge today) and
records the walk. This is what makes arbitrary names *safe* rather than
merely permitted.

**Evidence:** rows record the resolution (`archetype: "scout",
resolved_via: "reviewer"`), so audits show when a fallback fired.

**Housekeeping folded in:** archetype keys and fallback references get
identifier-validated (standing backlog item), and unknown-key strictness in
`archetypes:` entries extends to the new fields.

**Shipped (0.6.0-rc.12).** Deviations from the sketch above, all deliberate:
`explainWriteConflict` refuses by default; a dial explicitly set with
`--force` may persist a direct-archetype-only override after a prominent
warning. The isolated-delivery preference (sandbox/worktree instead of
refusal) is deferred to route operational policy alongside phase 3;
steering resolutions carry `resolved_via` always
(null on a direct bind) while dispatch rows and `loadout resolve` omit the
key entirely on direct binds, matching the additive `override`-field
precedent; drive's `resolution_snapshot` role rows do not stamp
`resolved_via` — an absent key is no claim, a present key must match the
snapshot replay at verify; host delivery of a non-surface archetype
hard-errors when its chain reaches no host surface (worker / reviewer /
judge), naming the chain walked. The evidence format bumped to 0.2 —
additive fields on the same major, so 0.1 rows read unchanged and the
tiered reader needed no code change. `generator` shipped in the starter
exactly as sketched: forbidden-write, `fallback: worker`, no dedicated
surfaces.

## Phase 3 — constraint tiers at the dispatch boundary

### Tier 1: declarative vocabulary (preferred)

Three predicates, all evaluated at the dispatch boundary, all rendering in
`fadeno loadout` / refusal messages, all recorded as evidence:

1. **Write posture** — phase 2's three-valued `requires_write` (listed here
   because it is the template the others follow).
2. **Provider distinctness** — the erdosSweep cross-family rule:

   ```yaml
   archetypes:
     reviewer:
       distinct_provider_from_inputs: advisory   # or: required
   ```

   Enforced against input provenance: when a dispatch's inputs are
   attributable to prior dispatches (explicit `--produced-by <dispatch-id>`,
   or artifact-path lookup in the ledger), the resolved target's provider
   must differ from every producer's. `required` refuses when provenance is
   demanded but unresolvable; `advisory` warns and records. The kernel
   already holds producer executor/model per dispatch — this is a read of
   existing evidence, not new bookkeeping.
3. **Eligibility states** — per-target, per-archetype:

   ```yaml
   targets:
     kimi-k3:
       provider: moonshot
       model: openrouter/moonshotai/kimi-k3
       eligibility:
         generator: eligible        # attacks count (default; may be omitted)
         reviewer: shadow_only      # runs, evidence-tagged, never gates
         judge: forbidden
   ```

   `eligible | shadow_only | forbidden`, default `eligible`. `forbidden`
   refuses at dial time and dispatch time; `shadow_only` permits the
   dispatch but stamps its rows non-gate-eligible (the same flag phase 4's
   shadow uses). This is the machine-readable residue of an
   erdosSweep-style MODELS.md: the calibration *document* stays human; the
   *decision* becomes catalog data.

### Tier 2: constraint command (escape hatch)

For project-specific logic the vocabulary cannot express:

```yaml
constraints:
  command: [node, .fadeno/constraints.mjs]
```

Invoked at the dispatch boundary with the full resolution context as JSON on
stdin — archetype, resolved target/executor/route, transport, write posture,
active loadout + overrides, and input provenance (paths, shas, producing
dispatch rows). Exit 0 allows; exit 2 refuses with stderr shown as the
refusal reason; anything else is a constraint-system error (refuse, loudly).
Refusals land in the ledger like any other.

*Honest caveats:* executable config is a heavier trust surface than data —
the doc for it must say so plainly; and instruction-only hosts cannot run
it, so it inherits the advisory/enforced split. Tier 1 is preferred wherever
it fits; tier 2 exists so Fadeno never needs a policy language.

**Shipped (0.6.0-rc.13).** Deviations from the sketch above, all deliberate:
a constraint-command exit other than 0/2 is a loud system error that writes
NO evidence row — only genuine refusals (exit 2, and every tier-1 refusal
including retrofitted write posture) append `dispatch_refused` rows with
predicate + message; profile layering now carries `constraints:` across
layers (found live: the merge previously dropped it, so project constraint
commands never ran); the `gate_eligible` verify check treats an absent stamp
as a claim of eligible (recomputable from the snapshot — deliberately
stricter than `resolved_via`'s absent-is-no-claim); advisory
provider-distinctness warnings ride the dispatch echo channel and the
`provider_distinctness: "warned"` row field; the loadout tables mark
non-eligible slots `SHADOW-ONLY (never gates)` / `FORBIDDEN (refused at
dispatch)` in the OVERRIDE-mark register; the starter catalog ships NO
predicate declarations (canon conservatism — the vocabulary lands in docs
until a starter workflow needs it). Engine gate consumption of
`gate_eligible: false` artifacts is unchanged, per the phase boundary —
shadow semantics arrive with phase 4.

## Phase 4 — shadow dispatches and model tryouts

**The kernel owns exactly the relational core** — the parts that die if
shadow is modeled as "just another archetype": same-prompt guarantee,
pairing, and non-gating. Everything else reuses existing vocabulary.

**Slot attachment** (overlay-adjacent state, same file, same visibility
rules):

```
fadeno loadout shadow worker grok-default            # every worker dispatch
fadeno loadout shadow worker grok-default --rate 0.2 # sampled trickle
fadeno dispatch ... --shadow grok-default            # one-shot opt-in
fadeno loadout clear-shadow worker
```

*Spelling note (added after the dials rename): these verbs shipped under
`fadeno dial` — `fadeno dial shadow <archetype> <model>[@effort] [--rate <r>]`
and `fadeno dial clear-shadow [<archetype>]`; `--shadow` takes a dial ref. The
sketch is left in its original spelling as the record; the semantics below are
unchanged.*

**Mechanism:** when a slot with a shadow attachment dispatches, the kernel
duplicates the dispatch to the shadow target with the byte-identical prompt
(same snapshot, same `prompt_sha256`), delivered isolated — worktree or
sandboxed route — so a write-shaped shadow yields a diff-as-artifact and
never touches the workspace. Shadow rows carry `shadow: true` and
`primary_dispatch_id`; readers and gates treat them as non-gate-eligible
(shared flag with `shadow_only` eligibility). The primary's result is the
only one the workflow consumes.

*Honest caveat:* when the primary is delivered in-session, the
kernel is not in the loop at spawn time; the steering hook can record the
native side (it already writes `host_delivery` rows) but kernel-side
duplication needs the dispatch path. Initial scope: shadows fire on
kernel-dispatched primaries; the host-primary case is an open question
below.

**Comparison is an ordinary judge job.** A `ModelComparison` artifact
contract: per-criterion qualitative assessment (correctness, scope
discipline, instruction adherence, style fit) plus a **mandatory confounds
section** — delivery transport differences, tool availability, effort
pinning, isolation — per the erdosSweep tier-4 lesson that undisclosed
scaffold differences contaminate form-level judgments. Guidance (not
enforcement): the judge's provider should differ from both candidates, or
the conflict is recorded in the artifact.

**Reporting:** `fadeno dispatches --bakeoffs` renders paired
primary/shadow rows and any `ModelComparison` artifacts as a running
scorecard per challenger. Accumulation is the point; single comparisons are
noise.

**`model-tryout` starter playbook:** the deliberate head-to-head — replicate
the same work spec across two executors (role instances, as in the case
study's sketch) → judge comparison → `ModelComparison`. Passive shadow
sampling and deliberate tryouts are the same evidence pipeline at two
intensities.

**The adoption ladder**, each rung one command, mirroring erdosSweep's
promotion pipeline (calibrating → shadow-approved → gate-eligible):

```
shadow (challenger, zero risk) → override (trial primary, instant revert) → loadout (preset)
```

**Shipped (0.6.0-rc.15).** Decisions and deviations from the sketch above,
all deliberate: open question 1 is decided for the initial scope — shadows
fire on kernel-dispatched primaries only, never on host in-session
deliveries (steering-hook-initiated duplication remains the open follow-up).
The shadow runs concurrently with the primary (since the parallel-shadow
revision: resolved, worktree-cut, and spawned before the primary starts,
collected after its completion row is written — latency is max(primary,
shadow), not their sum, and each side's `duration_ms` is its own
supervisor-measured runtime) and fires regardless of the primary's exit
code — challenger-succeeds-where-primary-failed is precisely the signal a
tryout wants; a refused primary fires no shadow. Every shadow-side refusal (eligibility `forbidden`, write posture,
constraint command, unresolvable target or host-only route, worktree
failure) lands as a `dispatch_refused` row carrying `shadow: true` +
`primary_dispatch_id` and can never affect the primary's result — a
constraint-system error that would bubble loudly on a primary is demoted to
a shadow refusal row for the same reason. Isolation is a detached-HEAD git
worktree under `.fadeno/local/shadow/`; the diff artifact (`add -A` +
`diff --binary --cached`) rides the completion row as
`diff_snapshot`/`diff_bytes`, which means a dirty primary workspace gives
the pair different trees despite byte-identical prompts — a mandatory
`ModelComparison` confound. Shadow rows reference the primary's
`prompt_snapshot`/`prompt_sha256` (one snapshot, byte-identity by
construction) and stamp `resolution: "shadow"`,
`shadow_source: "attachment" | "flag"`, `gate_eligible: false`; the
`--shadow` flag ignores `--rate`, and a not-fired sample leaves no trace.
`loadout use` drops shadow attachments along with overrides (one overlay,
one base) while `set`/`clear` preserve them. `fadeno status` does not render
attachments yet — the loadout tables (show/list, stale-attachment warnings
included) are the visibility surface. `ModelComparison` artifacts are
committable files under `.fadeno/comparisons/` with frozen frontmatter;
`fadeno dispatches --bakeoffs` renders ledger pairs plus artifact tallies
per challenger, and the `model-tryout` starter ships the deliberate
head-to-head. Ledger format stays 0.2 — every field is additive.

## Ledger format 0.2 (additive)

Rides with whichever of phases 2–4 lands first; one bump, not three.

- `override` on rows produced under a session override (phase 1)
- `resolved_via` on rows bound through a fallback chain (phase 2)
- constraint refusal rows: predicate name, verdict, message (phase 3)
- `shadow: true` + `primary_dispatch_id`; shared non-gate-eligible
  semantics with `shadow_only` eligibility (phases 3–4)

Readers: current-tier rows without the new fields remain current (additive
= same major); `fadeno dispatches` renders overrides, fallbacks, and shadow
pairs distinctly.

## Non-goals (named so they stay whole)

- **Capability requirements on roles/archetypes** (scout needs web, verifier
  needs execution). The next gap in this family; deliberately deferred, and
  explicitly *not* to be half-solved inside tier-2 constraint commands.
- **Loadout composition (`extends:`).** Fixes authoring verbosity, not
  ergonomics — users would still name a profile per combination. Possible
  later convenience; wrong as the switching primitive.
- **Canonizing verifier/scout/critic.** Repo-declared until they carry
  kernel-enforceable policy.
- **A Fadeno-owned model roster.** Profiles-and-verdicts documents
  (MODELS.md-style) stay human and repo-level; the catalog carries only
  their machine-readable residue (eligibility states).
- **Route operational-policy fields** (`env`, retry/backoff,
  `max_concurrency`, `max_prompt_bytes` — case-study gap 4). Real, but
  orthogonal to slots and archetypes: it hardens *routes*, not resolution.
  Separate horizon; stays on the backlog.
- **A policy language.** Tier 1 vocabulary + tier 2 command is the whole
  story.

## Open questions

1. **Shadow on host primaries.** *Decided — see "Phase 5" below.* The
   question was how to capture a host primary well enough to compare it. The
   answer is not to capture it: a shadow-selected spawn routes **both** arms
   through the command lane, so there is no host primary to instrument.
2. **Provenance ergonomics for `distinct_provider_from_inputs`.** Artifact-
   path lookup in the ledger covers kernel-produced artifacts; artifacts
   produced in-session are attributable only when the steering hook recorded
   them. How much attribution friction is acceptable before `required` mode
   is usable in anger?
3. **Override persistence granularity.** Overrides currently share the repo
   pin's lifetime. Is a time-boxed override ("worker=grok for today") worth
   the added state, or does visibility-on-every-`loadout`-call suffice?
4. **`generator` proxy surface.** If generator traffic materializes, does it
   get its own dispatch proxy agent (with a Bash-constraining hook like the
   other three), or does the worker proxy grow an archetype parameter?

## Phase 5 — symmetric pairs (design, not yet built)

Phase 4 shipped shadows against kernel-dispatched primaries and deferred the
host-primary case. Working the deferred case through produced a smaller design
than the one it replaced, because it deletes the problem instead of solving it.

**The move: a shadow-selected spawn forces command delivery on both arms.**
When the kernel rolls a slot's shadow attachment and it fires, the wrapper
(the Claude steering hook; the Codex `steering resolve` the agent already
calls) routes the *primary* to the dispatch proxy rather than to the in-session
agent. Both arms are then ordinary kernel dispatches: `dispatch_id`, prompt
snapshot, worktree, diff, supervisor-measured `duration_ms`, exit code, output
digest. Everything the host-primary design needed — a host `dispatch_id`, a
`PostToolUse` completion capture, deferred reaping, a host-pair variant of the
comparison renderer — becomes unnecessary rather than deferred.

Three consequences worth stating plainly:

- **It is harness-neutral.** The host side only has to *route*, never to
  capture, so it needs no hook. Codex and Grok get the same feature through
  the resolve call their agents already make. The tier-2/tier-1 split that
  made host-primary capture Claude-only stops applying.
- **The transport confound disappears** rather than being documented. Both
  arms are headless CLI on the same route shape, and effort is pinnable on
  both. What survives as mandatory `ModelComparison` confounds is the
  workspace, not the delivery — and the workspace turned out to be two
  confounds, not one. The tracked half is closed (a committed
  `baseline_commit` shared by both arms). The ignored half is closed only
  where a repo declares `worktree_carry:` — absent that, the challenger's
  worktree has no `node_modules`, no build output, and cannot run what the
  primary can. A pair must therefore record what was carried and by which
  mechanism (reflink / hardlink / copy), because arms warmed differently are
  not comparable. Effort is *requested* on both arms and measured on neither
  unless `fadeno attest` ran inside the subagent, so an unattested pair
  carries a silent-downgrade risk as a third confound.
- **It is a worse simulation and a better experiment.** A CLI-vs-CLI pair does
  not measure the in-session experience. Given that the purpose is accumulated
  promotion evidence, control beats realism — but the docs must not imply the
  scorecard predicts in-session behavior.

**Sampling moves to the decision point.** The kernel currently rolls the rate
inside `runDispatch`. That is too late: the wrapper has to know *before* it
routes, or a 0.2 rate would degrade the in-session path on every spawn to fire
a shadow on one in five. `fadeno dial resolve` and `fadeno steering resolve`
gain a kernel-rolled `shadow_selected` field, and the wrapper forces command
delivery iff it is set. The roll is keyed on `prompt_sha256`, not
`Math.random`: a retried spawn must make the same decision, or a retry loop
silently multiplies challengers.

**Workspace baseline.** Each arm's worktree is cut at HEAD and the primary's
pre-spawn dirty state is committed into it with a message naming the pair, so
the baseline is an addressable commit rather than an implicit one and each
arm's own work is the second commit. Untracked-but-unignored files must be
carried in explicitly; `git worktree add` will not. A dirty tree that cannot
be snapshotted refuses the pair *loudly* — an echo plus a `dispatch_refused`
row — never the silent no-op an unfired sample gets.

**Blinding is partial, and saying otherwise was wrong.** This section
previously claimed blinding "is free and must stay that way" on the grounds
that the same-prompt guarantee leaves neither arm able to tell which it is.
The prompt half holds. The workspace half does not: the challenger's cwd is
`.fadeno/local/shadow/<id8>`, which names the answer. `FADENO_IN_SHADOW=1`
is likewise present in the challenger's environment and readable by any agent
that looks, so exactly one arm can know what it is — an asymmetry applied to
one side only, which is worse than symmetric knowledge, not better.

Neither tell is removable in isolation. Real blinding requires both arms to
sit in identically-shaped, neutrally-named worktrees, which is the deferred
write-shaped-primary work below. Until then: `FADENO_IN_SHADOW` stays, because
the nesting guard it enforces ("nothing inside a shadow ever shadows") is
worth more than a partial blind, and it must still never be echoed in CLI
output. Treat blinding as advisory and do not let a `ModelComparison` rest on
it.

**Port-back is a kernel verb, not an instruction.** Applying the primary's
worktree to the real workspace is deterministic mechanism, so it belongs in a
command (`fadeno shadow-apply <pair>`), not in a relay agent improvising git.
It must be conflict-aware from the first version — the main tree can move
while a pair runs — and on any conflict it stops, keeps the diff artifact,
records the row, and prints the path. It never auto-resolves.

**Judging stays modular and deferred.** Passive pairs accumulate; a
`ModelComparison` is produced later, by hand or by the `model-tryout` starter.
That is only safe if the pair's evidence is complete and durable at pair time:
both outputs, both diffs, both worktrees, the prompt snapshot, both durations
and exit codes, and dial provenance. Worktrees are therefore retained, and
`fadeno clean` for them is part of the post-shadow workflow that ships with
judging. Both rows carry a `pair_id` from the start — correlation is cheap to
emit and miserable to retrofit.

**Bounded blast radius.** Two independent controls, because they bound
different things: `--rate` bounds spend, and a cap on live shadow claims in
`.fadeno/local/inflight/` bounds machine load. A serial trickle of two hundred
shadows costs exactly what two hundred concurrent ones cost, so neither
substitutes for the other. The nesting rule and the cap ship together: without
the cap, depth-k nesting fires k shadows for one task.

**Vendor egress is a set-time check.** *Shipped ahead of the rest.* Dialing or
shadowing a model whose provider nothing else in the repo dials warns at set
time, alongside the write-posture and eligibility checks — the unit is the
slot, not the archetype, so shadowing `worker` with the vendor `worker`
already dials is not new egress. A dial set once and forgotten is a standing
egress path, and dispatch time is too late to say so.

**Work list.** *Landed:* host spawns are now shadowable — `fadeno dial resolve
--prompt-sha256 <hex>` reports `shadow.selected` for that exact prompt, the
steering hook routes a selected spawn to the dispatch proxy instead of the
in-session agent, and the kernel independently re-derives the same roll to let
a host-dialed primary take its own command fallback (echoed as `pair
selected`, `transport: host-command-fallback`). Nothing is threaded between
them: the roll is a pure function of (prompt digest, archetype, challenger),
so hook and kernel cannot disagree. An unselected spawn is untouched, which is
what keeps a 0.25 attachment from taxing the other three spawns in four. Also
landed: prompt-digest-keyed sampling (a retried spawn cannot re-roll);
`pair_id` on both arms and the retained challenger `workspace` on shadow
rows; `FADENO_IN_SHADOW` suppressing nested shadows, kernel-read and
never echoed; a live-challenger cap leased through
`.fadeno/local/inflight/*.shadow.json` (`FADENO_SHADOW_MAX_LIVE`, default 4)
whose exhaustion is a `shadow_cap` refusal row rather than a silent skip;
shadow worktrees retained for later judgment; the `--isolate` / `--shadow`
conflict guard lifted, since the two arms never shared a path. Also landed:
`fadeno shadow-apply <pair-id|dispatch-id> [--arm challenger|primary]
[--check]`, the port-back verb — it resolves either arm's id (full, or an 8+
character prefix) to its pair, applies that arm's `diff_snapshot` with `git
apply --3way` against the pair's `baseline_commit`, stops and keeps the diff
artifact on any conflict rather than auto-resolving, and records a
`shadow_apply` evidence row (`--check` reports applicability without
mutating anything, including the ledger). `--arm primary` refuses on an
ordinary paired primary — it already shares the workspace — unless that
primary itself carries a `diff_snapshot` from running under `--isolate`. A
baseline commit `git cat-file -e` can no longer find (its worktree removed
by `fadeno clean --force`, then GC'd) is diagnosed by name instead of
surfacing git's own "lacks the necessary blob" error; durably pinning the
baseline under a ref at the moment `commitWorkspaceBaseline` creates it — so
no removal-timing window can ever unreference it — remains an open
follow-up there rather than something `shadow-apply` itself can fix.
Phase 5's original remaining list is now empty: Codex's `steering resolve`
carries `shadow.selected`/`shadow.routable` and routes a selected pair to the
command lane; each worktree gets a committed baseline; `fadeno clean`
deregisters retained worktrees instead of orphaning their git registrations;
and the comparison renderer reports the primary's own diff, pairs on
`pair_id`, and renders a refused challenger as refused rather than as a row of
`?`.

**Phase 5.5 — trustworthy isolation and measured identity.** Working through
"is this rock solid?" found four ways a pair could produce a confident wrong
verdict, all now closed. A selected pair whose primary had no command lane
used to route the spawn to a proxy the kernel would then refuse, failing the
task outright; `shadow.routable` gates that — lane exists *and* the command
lane can satisfy the archetype's write posture (`explainPairRoutability`) —
and an unroutable pair degrades to no pair rather than to no work. A
selected pair whose command lane cannot write still writes a
`shadow_write_posture` refusal row so `fadeno dispatches` can say why. A
challenger's worktree lacked everything gitignored, so any task gated on
building or testing was unwinnable for one arm alone; `worktree_carry:`
carries declared paths by reflink, hardlink, or
copy (never a directory symlink, which would share the namespace and let a
rename-based write land in the primary's real tree), recording the mechanism
per path. Byte-identical prompts plus differing cwd let a prompt naming
absolute repo paths send the challenger into the primary's workspace; that
now refuses the pair with `shadow_containment`. And host delivery recorded
only what was *requested* — `fadeno attest`, run inside the subagent, measures
the one identity component that is observable (`CLAUDE_EFFORT`, already past
any silent downgrade), while `fadeno dispatches` surfaces both an unattested
delivery and an effort that disagrees with its dial.

*Remaining:* pin `baseline_commit` under a ref when it is created, so no
worktree-removal timing window can leave a pair un-appliable; detect
mutation of carried paths (a hardlinked file written in place changes the
primary's copy, and cleanup cannot undo it) and stamp such a pair suspect
rather than trying to prevent it; and one gap that was not shadow-specific at
all — `mergeLayer` copied catalog keys by exact literal name, so a misspelled
top-level key was dropped before `parseExecutorProfile`'s strict unknown-key
check ever ran, and a typo'd `dials:` silently did nothing. **Closed:** each
layer's raw keys are validated before the merge against one shared
`CATALOG_TOP_LEVEL_KEYS`, which the merge loop is now driven by — so a key
added there layers by default instead of being inert. The same failure shape
survives one layer down by value *type* rather than key name (`dials: "sol"`
is still dropped by the merge before the parser can reject it); that wants its
own change, because the parser is inconsistent about `null` and tightening the
merge would make a bare `dials:` start failing.

**Write-shaped primaries — now built** (2026-08-20). This section deferred
them, on the reasoning that `reviewer` and `judge` cost only latency while
`worker` "forces a choice about where the primary's edits go". Two things were
wrong with that. `worker` is the archetype most worth shadowing — a model
test-drive is worker-shaped — and the deferral did not make write-shaped pairs
*not happen*: nothing refused one, so a `worker` pair formed, completed, and
stamped `pair_id` on both rows while the primary emitted only a
`workspace_changed` boolean against the challenger's real diff. A boolean
cannot be compared to a diff, so the pair looked legitimate and proved
nothing.

A selected pair now isolates both arms and merges the primary's diff back, so
`fadeno dispatch --archetype worker` still means "the work is in your tree
when it returns". The choice the deferral named is answered rather than
avoided: the edits go to a worktree and come back through `git apply --3way`.

Four things fell out of building it that the sketch did not anticipate:

- **The baseline must be captured once and replayed into both worktrees.**
  The challenger is materialized before the primary's worktree exists, so
  capturing per-arm reads the tree at two moments; a file written between them
  lands in one arm's baseline and not the other's. The commit uses fixed dates
  so both arms compute the same sha, making `baseline_commit` one value
  genuinely shared rather than one arm's copied onto the other's row.
- **The workspace lease moves; it must not be dropped.** An isolated primary
  cannot reach the shared tree while it works, so it takes no lease then — but
  it takes one across the merge-back. Dropping it would remove worker
  dispatches from the single repo-wide mechanism serializing writers, and
  sampling is prompt-digest-keyed, so a paired dispatch and an unpaired one
  coexist routinely. The result is *more* concurrency than before: a shared
  primary holds that lease for its whole run.
- **Candidacy is not capability.** Isolating can itself fail — a non-git repo
  has no worktrees, an uncarriable declared path has no honest checkout — so
  "isolate whenever a pair is wanted" turns working dispatches into hard
  errors. The primary isolates only when the pair actually materialized, and
  every later refusal degrades to "no pair, primary runs normally" with
  `workspace_mode_degraded` recording why the completion row differs from the
  request row's intent.
- **A paired primary's gitignored output is discarded** — now declarable, see
  below. The merge-back diff comes from `git add -A`, which respects
  `.gitignore`, so a worker whose real product is a gitignored build directory
  loses it. Carried dependencies are unaffected: they are input, not output.

### Gitignored output: declare it, and the pair steps aside

A dispatch declares whether its gitignored output has to survive. If it does,
no pair is formed — the trade is one-directional and worth stating plainly: it
costs a **comparison**, never **work**.

```yaml
archetypes:
  worker:
    requires_write: required     # executor selection, unchanged
    ignored_output: kept         # pair eligibility. default: discardable
```

Overridable per dispatch with `--ignored-output kept|discardable`.

**Why a refusal and not a repair.** Two other designs were considered and both
fail on the same axis. Carrying gitignored paths back needs them *named in
advance*, which is the problem `worktree_carry` already has and does not
solve. Letting the arm report what it produced — and having the relay
integrate it — would make carry-back depend on what a model chose to mention,
so two runs of one pair could carry back different sets and the pair would
stop being a controlled comparison. That comparability is the entire reason
write-shaped pairs exist, so intelligence cannot sit in this path. It is also
the wrong job for the relay specifically: the cheapest model in the system,
which does no role work and has a dogfood receipt for defecting on its own
contract, should not hold write authority over the caller's tree.

Intelligence does have a place here, one step back: an arm reporting "I
produced `dist/`, you probably want it" is a useful *proposal* that a human or
a config promotes into the declaration. That is this document's own rule —
evaluator → structured artifact → deterministic condition. The agent is the
evaluator; it never becomes the condition.

**It is deliberately not `requires_write`.** That is a `WritePosture`
consumed during *resolution* to pick a write-capable delivery; this gates
*pair formation* at materialization. Different axes, different times, and
folding them would make illegal combinations expressible. The name also has to
avoid a direction trap: `worktree_carry` already means gitignored files coming
**in**, so `requires_ignored_output` would read almost exactly like its job.

**The default is the whole design.** `discardable` keeps pairing alive; a
conservative default would quietly kill the feature. What makes the permissive
default safe is that the loss is no longer silent: every arm's worktree is
scanned before teardown and anything gitignored that will not survive is
recorded as `ignored_output_discarded`. The first time it bites, you see it
and declare. Detection and the declaration are not alternatives — detection is
what earns the default.

`truncated: true` on that record means the scan could not guarantee
completeness, and the list is a **floor, not a set**. "I could not tell" is
never spelled the same as "there was nothing".

Two things the scan cannot see, both stated here rather than discovered later:
output written *underneath* a carried path (at this granularity it is
indistinguishable from the input carried in — the largest gap), and anything
under `.fadeno/`, which is excluded wholesale because a dispatch writes there
by construction and reporting it would stamp the mechanism's own footprint on
every pair.

The builtin catalog deliberately does **not** declare `kept` for `worker`.
`worker` is the default archetype for nearly every dispatch, so shipping that
default would make workers globally ineligible for pairing and delete shadow
pairing as a feature without anyone choosing to.

**Blinding stops being advisory in the same change.** Both arms sit at
`.fadeno/local/pair/<pair-id8>/<own-dispatch-id8>` — same depth, same shape, a
random uuid on each — so neither can read its own cwd and learn which arm it
is. `shadow_containment` remains necessary regardless: a prompt naming this
repo's absolute path used to send the challenger into the primary's tree, and
with both isolated it sends both into the shared tree, where they collide with
each other.

**`carry_mutated` closes the hazard `worktree_carry` always carried.** A
hardlinked path is one inode in two trees, so a tool writing one in place
mutates the primary's copy. Detection is an lstat tuple per entry — ino, size,
mtime, ctime, mode, uid, gid, nlink — never a content hash, because hashing a
`node_modules` on the critical path is unaffordable and a sampled hash would
miss the common case silently. `ctime` closes the evasion `utimes` opens.
`nlink` is recorded and deliberately never counted as drift, which is what
lets verification run after a worktree is torn down. It reports and never
repairs: a detector that mutated would destroy the evidence it exists to
produce.

## Steering restart — what a dial change must not cost

A dial change should never end a session. Today it can, and the two harnesses
fail differently:

- **Claude** splits the identity across two channels. Model is live — the
  steering hook rewrites `updatedInput.model` per spawn. Effort is not: the
  Agent tool takes no effort parameter, so the only channel is `effort:`
  frontmatter in a materialized agent file, and the harness reads agent
  definitions when the session starts. Re-dialing without re-applying
  therefore runs the **new model at the old model's effort** — neither the old
  dial nor the new one, and silent. `host_delivery` rows now carry
  `effort_source` and `materialized_source` (the executor the file was cut
  from), which makes the split-brain detectable after the fact; it does not
  prevent it.
- **Codex** bakes both model and effort into the agent TOML and detects the
  mismatch instead of papering over it: the agent passes the
  `--host-executor` it was materialized with, and `steering resolve` answers
  `command` where a fallback exists and `restart_required` where none does. So
  Codex is already mostly restart-free — via the command lane — and refuses
  loudly rather than drifting.

Note this is **not** about hooks. Hooks are cached at session start too, which
is why every hook-written row stamps `hook_version`, but that cache tracks
*upgrading Fadeno*, not dialing. The restart here is the harness's **agent
registry**: a definition file created mid-session is not a registered agent,
and one whose frontmatter changed keeps serving its old values.

**The fix is to stop materializing per-dial and pre-register an effort grid
once.** `steering apply` emits one managed agent per `(effort, archetype)`
rather than one per archetype-currently-dialed, and the wrapper retargets
`subagent_type` among agents the harness already registered.

**The grid is not keyed on model, and must not be.** Model is already live —
the hook sets `updatedInput.model` per spawn — so the only property an agent
file has to carry is the one the Agent tool has no parameter for. Keying on
model would make the grid combinatorial in the dimension that actually grows:
60 models × 20 archetypes × 5 efforts is 6,000 managed files, and every new
model adds 100. Keyed on effort it is `efforts × host-surface archetypes` — 15
files for today's `claude` harness — and it stays 15 no matter how many models
are registered. Registering a model becomes free: no apply, no restart, no
file. Grid agents therefore declare `effort:` and **no** `model:`; the spawn's
model arrives on the tool call.

Materializing on demand instead is not an alternative, for a structural
reason: the harness builds its agent registry at session start, so a file
written at dial time is not registered until the next session. On-demand
degrades to a warm cache — first use of a novel identity costs a restart,
later uses are free. Reasonable if the grid were large; pointless at fifteen
files.

That moves the restart boundary from *dials* — frequent, casual, and the thing
users actually change — onto the *effort vocabulary*, which is edited almost
never. After it, a restart is required for exactly three things, and they
should be the only three the docs ever claim:

1. **A new effort value** entering the vocabulary, which the current grid does
   not cover. Adding models, routes, or archetype dials does not qualify.
2. **A host slot naming an identity with neither a materialized agent nor a
   command fallback** — Codex's existing `restart_required`, narrowed to the
   fallback-less case.
3. **Upgrading the Fadeno plugin**, because hooks load once per session.

Everything else becomes live: any dial among materialized identities (model,
effort, or both), every shadow attach and detach (shadows are pure command
dispatch and never needed a restart), and host↔command transitions in either
direction, since the proxy agents are always registered and the grid covers
the host side.

> **Superseded — see *Effort decides the lane* below.** The grid shipped and
> works (measured: a spawn into the `xhigh` cell reports `CLAUDE_EFFORT=xhigh`,
> the `low` cell reports `low`). It is retired not because it fails but because
> a simpler rule makes effort mechanical on both lanes. The reasoning above
> stays as the record of why on-demand materialization is impossible — that
> constraint is real and outlives the grid.

**Shipped.** `fadeno steering apply --claude` now pre-registers
`.claude/agents/fadeno-<archetype>-<effort>.md` for every host-surface
archetype across the `low|medium|high|xhigh|max` ladder — 15 cells, each
`model: inherit` plus its own `effort:`, carrying the archetype's role body
unchanged. The steering hook retargets `subagent_type` onto the cell matching
the dial's resolved effort and supplies the model on the tool call. Legacy
per-dial managed agents are removed on apply, since they pin a model the dial
may have moved past; unmanaged files of the same name are never touched. A
resolution carrying no effort (or an integer one) falls back to the plain role
agent at inherited effort. Re-applying after a dial change writes nothing and
reports `restartRequired: false` — the property the whole design exists for.

**Decided: the grid carries role bodies** — keyed `effort × archetype`, 15
files today. It preserves the role templates verbatim and changes nothing
about what an in-session role agent is. The alternative, role-generic keying
(`effort` alone, 5 files, role behavior arriving in the composed prompt as it
already does on the command lane), is the tidier end state and would end an
inconsistency between the two lanes — but with model out of the grid this was
an ergonomics choice, not a scaling one, and it can be collapsed later without
redoing the grid.

**Both load-bearing assumptions are confirmed** against the Claude Code
binary (2.1.236), so the grid is viable as specified:

- `effort` is a real subagent-definition field — *"Thinking effort: `low`,
  `medium`, `high`, `max`, or an integer"*, default `medium` — and the Agent
  tool's own description states that an agent type's model, reasoning effort,
  and tool access come from `.claude/agents/*.md` frontmatter.
- The tool-call `model` parameter *"overrides the definition for this one
  call"*, which is what lets the grid drop the model dimension. Grid agents
  should declare `model: inherit` — the documented spelling of "take the
  caller's" — rather than omitting the key.
- `xhigh` is a valid level (the accepted set is wider than the agent schema's
  description: `low`, `medium`, `high`, `xhigh`, `max`), so the registry
  vocabulary needs no translation on the Claude lane.

**Effort is requested, not guaranteed.** The harness resolves a turn's level
*"after any silent downgrade for the selected model"*, and also restricts
higher levels by organization policy. A dial to `xhigh` can therefore land
lower with nothing raised, which means a row stamped
`effort_source: agent-file` records what was *asked for*. The observable is
`CLAUDE_EFFORT`, published to hook commands and Bash and already resolved past
any downgrade: `host_delivery` rows now carry it as `session_effort`, the only
measured effort on the row. A requested effort that no spawn in the repo has
ever been observed at is the signature of a silent downgrade. Attesting the
subagent's *own* post-downgrade level is possible in principle — every
dispatch proxy runs Bash and would see its own `CLAUDE_EFFORT` — and is left
as follow-up rather than assumed.

**Shipped: the follow-up above.** `fadeno attest --archetype <a>`, run FROM
INSIDE the subagent, writes a `host_attestation` row measuring what that
process can actually observe about itself — the resolved `CLAUDE_EFFORT`
(already past any silent downgrade), pid, cwd, and the archetype it was told
it is. Model stays unmeasured — there is no environment-variable equivalent,
and this deliberately never asks the model to self-report its own name — so
the row carries `identity_evidence: requested_only`, the same admission
`fadeno steering resolve` already makes. `fadeno attest` is now the first
instruction in every host-surface role agent (the plain
`templates/claude/claude-agents/{worker,reviewer,judge}.md` bodies, which the
identity grid also carries verbatim), but it is tier-1/advisory like every
other instruction those bodies contain — an agent may not comply, which is
why the reader matters as much as the writer.

`fadeno dispatches` correlates a `host_attestation` onto the nearest preceding
unattested `host_delivery` row of the same archetype — the best a reader can
do, since the subagent has neither the parent's prompt digest nor its session
id to key on exactly — and renders two things that were previously
indistinguishable from success: a `host_delivery` with no matching
attestation (`[never attested]`), and an attested effort that differs from
what was requested (`[effort mismatch: requested … attested …]`), the
signature of a silent downgrade that makes any shadow pair spanning that row
invalid.

## Effort decides the lane

**Status: built, both halves** (2026-08-20). Claude: predicate, grid
retirement, hook, rendering, hook-side refusal evidence. Codex: the `relay:`
catalog key, brokers emitted rather than copied at both scopes, and a `doctor`
check for a project-scope broker shadowing a user-scope one.

`relay:` did join `CATALOG_TOP_LEVEL_KEYS` and layer by default, exactly as
this paragraph predicted once the misspelled-key fix landed. What the
prediction missed is that the same silent-drop defect survived one layer down
by value *type*: `relay: sonnet` loaded clean and did nothing, because the
merge skipped any entry-merged key whose value was not a mapping. Writing the
new key's tests is what found it. The merge now rejects a declared non-mapping
while still tolerating a bare `key:` — which was the blocker that had deferred
that fix, and turned out to be its shape.


The identity grid exists to let a host spawn run at an effort the session is
not running at. Retire that goal and the grid goes with it: **a host spawn
runs at the session's effort, and an effort the session cannot give is
delivered on the command lane instead.**

**This is not a new mechanism — it completes one.** The predicate is one pure
function, `decideLane` in `src/lib/lane.ts` — deliberately in `lib/` rather
than in either command, because `steering resolve` and `dial resolve` must
answer identically (the hook routes on one, the resolution echo explains the
other) and a second implementation would be a correctness bug, not a
duplication nit. It returns the lane plus a `lane_reason` drawn from a closed
vocabulary, so a denial is groupable in evidence rather than merely countable.
The resolver already decides host-vs-command by asking whether the session can
deliver the requested identity:

```
cascade.source === 'base' || hostExecutor === refString  -> host
spec.fallbackCommand != null                             -> command
                                                         -> restart_required
```

That predicate covers *model* only. Extending it to include effort is one
condition, not a second subsystem, and its third branch — `restart_required`
when there is no command lane — already exists and is already the honest
answer.

**The rule, in three states.** Effort is optional on a `DialRef`, so "the user
declined to state an opinion" is already representable and must stay that way:

| Dial | `ref.effort` | Reading | Lane |
|---|---|---|---|
| `opus@xhigh` | `'xhigh'` | an opinion | host iff session effort is `xhigh`, else command at `xhigh` |
| `opus` | `undefined` | no opinion | host, inheriting the session |

A dial with no pinned effort never leaves the session on effort grounds. This
is deliberately the *casual* path: the cost of going out-of-process is paid
only by a user who asked for something specific, which is also the user most
likely to accept it.

**The implementation trap, stated because it inverts the whole design.** The
predicate must key on `ref.effort` **presence**, never on the compiled effort
value. `compileDialRef` resolves `ref.effort ?? entry.effort`, and every model
in the shipped catalog declares an `effort:` — so comparing the *resolved*
effort sends a plain `dial worker opus` to the command lane in any non-`xhigh`
session, which is the exact opposite of the intent. `CompiledDelivery.effort`
therefore splits into `pinnedEffort: string | null` and
`effectiveEffort: string`, so the type refuses the mistake rather than leaving
each call site to remember which one it meant.

`models.<name>.effort` keeps its job and gains a name for it: it is the
**command-lane default**, the effort an unpinned dial runs at when it reaches
that lane anyway. No new schema.

**Evidence needs no format change.** `formatDialRef` omits `@effort` when
unpinned, and that string is both the executor name on dispatch rows and the
key of the snapshot's compiled executors map — so pinned-versus-unpinned is
already recorded faithfully in every ledger on disk, and `verify` keeps
recomputing without the registry.

**What retires.** `HOST_SURFACE_ARCHETYPES`, `CLAUDE_EFFORT_LADDER`,
`claudeGridAgentName`, the 15-cell emission in `steering apply --claude`, and
the effort dimension of the hook's `hostTarget` (which collapses to "is there
a managed role agent"). Restart reason 1 above — a new effort value entering
the vocabulary — retires with them; reasons 2 and 3 stand.

**Accepted tradeoffs, named rather than discovered.**

- A shadow pair forces both arms onto the command lane, so an *unpinned* dial
  is measured at its command-lane default rather than at the session effort it
  actually runs at day to day. Accepted: Claude effort levels vary little in
  what users set, and the pair already admits it is a better experiment than a
  simulation.
- The delivery lane becomes session-state dependent and can flip mid-session:
  `opus@xhigh` is host in an `xhigh` session and command after the session
  drops to `medium`. That liveness is the point, but it is surprising, so the
  resolution echo must name the lane and the reason
  (`worker -> opus@xhigh [command lane: session is medium]`).
- `fadeno dial` must render an unpinned effort as `inherit`, never as the
  resolved value. Once the lane depends on the distinction, a table that shows
  a default where no pin exists is actively misleading.

**Measured, not assumed** (2026-08-20, this repo, Claude harness):

- The Agent tool's `model` is a strict enum (`sonnet|opus|haiku|fable`);
  `opus@xhigh` is an `InputValidationError`. There is no compound spelling, so
  effort has no live tool-call channel and never will without a new parameter.
- `effort:` frontmatter *is* honored: spawning `fadeno-worker-xhigh` reports
  `CLAUDE_EFFORT=xhigh`, `fadeno-worker-low` reports `low`. This also confirms
  the channel `fadeno attest` reads.
- The agent registry is a session-**start** snapshot: a well-formed agent file
  written mid-session spawns as "not found". Cells cannot be materialized on
  demand, which is why the grid was necessary rather than merely convenient.
- Hook processes observe `CLAUDE_EFFORT` (every `host_delivery` row in this
  repo carries `session_effort`, none null), so the lane predicate is
  computable in the hook with no new capability.

**A refused spawn leaves evidence.** The hook denies in two situations — the
resolver failed, or the lane is `restart_required` — and both previously wrote
nothing, so a repo where every worker spawn was being denied looked identical
in `.fadeno/dispatches.jsonl` to one where nobody spawned at all. A
`host_refused` row now carries `refusal: {predicate, message}` keyed the same
way the kernel's `dispatch_refused` is, with a closed predicate vocabulary:
`resolver_error`, `resolver_timeout`, and `restart_required`. The timeout is
split out because it is the failure most likely to repeat in a loop and its
remedy differs; the signature requires positive evidence of a kill, since a
resolver that never *started* also exits with no status and deserves a
different answer than "raise the budget". The row records the prompt digest
but writes no prompt snapshot — nothing was delivered, and a file per denial
would litter exactly the failure loop the row exists to expose.

### Codex: the same rule, a different proof

Codex has **no split-brain to fix** — that failure needs two channels
refreshing at different rates, and Codex has no live channel at all. There is
no spawn hook, so nothing rewrites anything per spawn; model and effort both
come from one agent TOML, both frozen at session start, both equally stale.
Equal staleness cannot drift.

What Codex needs instead is a different *proof*. The predicate asks whether
the host lane will actually deliver the pinned effort, and the answer source
is harness-specific:

| Harness | Host lane's deliverable effort | Channel |
|---|---|---|
| Claude | the session's (the role agent inherits) | `CLAUDE_EFFORT` |
| Codex | the managed agent's baked `model_reasoning_effort` | `--host-executor` |

Codex therefore needs no new channel: it has been passing the answer to the
resolver all along, just for the model half. `hostEffortProven` is that
generalization — when `hostExecutor === refString` the requesting agent was
materialized at that exact ref, pin included (`formatDialRef` renders
`luna@xhigh`), so the match *is* proof. It is consulted only when the session
effort is unobservable, and an observed one always wins. It cannot reach the
Claude hook, which calls `dial resolve` and passes no `--host-executor`.

**No inheritance, and unpinned bakes the registry default.** A Codex managed
agent inherits nothing; it runs at what its TOML says. So Claude and Codex
genuinely differ on what an *unpinned* dial means — Claude resolves it to the
live session effort, Codex to `models.<name>.effort`. That divergence is
deliberate and is recorded here rather than left to be discovered by someone
comparing two ledgers.

**Staleness routes correctly instead of failing.** A stale Codex agent reports
a `--host-executor` that no longer matches the dial, the resolver answers
`command`, and the work goes out on the command lane — which under this design
is simply the right answer, not a degradation. Re-apply and restart therefore
drop from a *correctness requirement* to an optimization: you restart only to
get an archetype back in-session, never to avoid being wrong.

### The relay identity belongs in the catalog

**Built.** What follows is the design as written; three notes on what building
it changed are at the end of the section.

The Codex command broker hardcoded `model = "gpt-5.6-luna"` /
`model_reasoning_effort = "low"`, and Claude's dispatch proxies hardcoded
`sonnet`. Both are correct choices for a relay — luna and sonnet both hold the
relay contract under dogfood where haiku did not, and a proxy turn is only a
few relay tokens. Neither is a *dialable* choice, which is the problem: the
relay is the one role in a system built on dialable identities whose identity
lives in a source literal.

Fix the location, not the value: a per-harness `relay:` map in the catalog.

```yaml
relay:
  claude: sonnet
  codex: gpt-5.6-luna@low
```

Per-harness is required rather than stylistic — the relay must be a model the
session's own provider can already serve, and `dials:` is a flat
archetype→ref map while harness variation lives in `routes:`. It is
deliberately *not* an archetype: this document's own rule is that canonical
status is earned by a policy the kernel must enforce, and a relay carries
none; making it one would also put it in the `fadeno dial` table as though it
were work to be dialed.

Record the dogfood receipt in a comment beside the value. The `sonnet` choice
has its rationale in the hook; this one currently has none anywhere, which is
how an unexamined default becomes load-bearing.

**Emit the broker files, never copy them.** `init --codex` copies static
template TOMLs into `<repoRoot>/.codex/agents` while `steering apply --codex`
emits to `~/.codex/agents`. Two mechanisms, two scopes, two levels of
currency — and the copied ones are frozen text that no dial ever reaches and
no apply ever refreshes, which is why a project-scope broker can silently
predate features like `--prompt-file` (and so quietly excludes that repo from
shadow pairs entirely). Project-scope files must be emitted from the resolved
catalog value like the user-scope ones, and `doctor` must report a
project-scope broker shadowing a newer user-scope one, which is invisible
today.

**What building it changed.**

*Absent is not a value.* `relay:` missing for a harness resolves to `null`, and
every caller keeps its own built-in literal rather than inventing one — a relay
the session's provider cannot serve is worse than a stale but servable one. A
self-contained project catalog suppresses the builtin layer entirely, so `null`
is the common case in a real repo, not the exotic one. The old literals survive
as those fallbacks, which is why a repo with no `relay:` saw no diff at all at
the moment the key shipped.

*…but the fallback is not frozen.* That no-diff property was a migration
argument, and it expired with the migration. What remained was one question
with two answers — the constant and the shipped catalog — which is the shape
this codebase keeps getting silently wrong. They are now pinned equal by test
and moved together: `relay.codex` went `luna@low` → `luna@high` on 2026-08-20,
a judgment call rather than a receipt (luna is cheap, and a broker routes a
four-way branch table it must get right every time). Raising effort on a model
that already held the relay contract is the safe direction; the A/B rule in
the catalog guards changing *who* relays, which still needs one.

*Named-but-unservable throws.* If the catalog names a relay whose provider has
no route in that harness, resolution raises rather than degrading to `null`.
Null is reserved for "stated no opinion", and collapsing the two would
resurrect the silent-vanish failure the key-strictness work removed. The cost
is real and deliberate: a broken `relay.<harness>` denies every spawn in the
repo, including host-lane spawns that never touch a relay. It is reachable only
by actively editing `relay:`, and the error names the key.

*Claude's two channels refresh at different rates.* The spawn hook reads
`relay.claude` from the resolver on every spawn, so it is live. The proxy
frontmatter can only change when the file is written, so it is stamped at emit
— scoped to frontmatter carrying both `name: dispatch-` and `model:`, so a role
agent can never be relay-stamped even if one later gains a model of its own.
That asymmetry is not an oversight: proxy bodies are long prose contracts, not
generated text, so stamping is right where rendering would be wrong.

## Phasing summary

| Phase | Ships | Depends on |
|---|---|---|
| 1 | slot overrides, effective-table visibility, set-time checks, `current-host` starter idiom | nothing |
| 2 | three-valued `requires_write`, `generator` canon, fallback chains, key validation | nothing (1 recommended first) |
| 3 | tier-1 predicates (`distinct_provider_from_inputs`, eligibility states), tier-2 constraint command | 2 (write-posture values) |
| 4 | shadow attachments, comparisons view, `model-tryout` starter, `ModelComparison` contract | 1 (state file), 3 (`shadow_only` flag) |
| 5 | symmetric pairs (both arms on the command lane), prompt-digest sampling, `pair_id`, live-challenger cap, `shadow-apply` | 4 (attachments), the steering wrapper |
| 5.5 | `shadow.routable` gating, `worktree_carry:`, `shadow_containment`, `fadeno attest` | 5 |
| — | *effort decides the lane* (retires the identity grid) | the grid having shipped; independent of 5/5.5 |

Each phase is independently valuable and releasable; ledger 0.2 rides the
first of 2–4 to land. *Effort decides the lane* rides no format change at all
— `formatDialRef` already distinguishes a pinned effort from an unpinned one.

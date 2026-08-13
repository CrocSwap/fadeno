# Slot ergonomics and the open archetype vocabulary

**Status:** all four phases implemented — 1 (session slot overrides,
0.6.0-rc.9), 2 (archetype schema pass, 0.6.0-rc.12), 3 (constraint tiers,
0.6.0-rc.13), 4 (shadow dispatches + model tryouts, 0.6.0-rc.15)
**Decision date:** 2026-08-12
**Relationship:** successor horizon to
[`loadouts-and-dispatch.md`](loadouts-and-dispatch.md) (extends its catalog,
resolution chain, and dispatch-boundary enforcement); grounded in
[`case-study-erdossweep.md`](case-study-erdossweep.md) (gap list) and in
dogfood receipts from the 0.6.0-rc cycle. Inherits the standing constraint
set: no daemon, no cloud service, no scheduler; evidence over trust.

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
`explainWriteConflict` refuses only — the isolated-delivery preference
(sandbox/worktree instead of refusal) is deferred to route operational
policy alongside phase 3; steering resolutions carry `resolved_via` always
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

**Reporting:** `fadeno dispatches --comparisons` renders paired
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
The shadow fires after the primary's completion row is written and fires
regardless of the primary's exit code — challenger-succeeds-where-primary-
failed is precisely the signal a tryout wants; a refused primary fires no
shadow. Every shadow-side refusal (eligibility `forbidden`, write posture,
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
`fadeno dispatches --comparisons` renders ledger pairs plus artifact tallies
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

1. **Shadow on host primaries.** The highest-value shadow target is the
   user's daily driver, which is often the host in-session worker — where
   the kernel never sees a dispatch. Options: steering-hook-initiated
   background dispatch of the shadow (hook already stashes the prompt and
   sha); or accept kernel-dispatched-only scope initially. *Decided with
   phase 4 (rc.15): kernel-dispatched-only initially; the hook-initiated
   variant stays open.*
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

## Phasing summary

| Phase | Ships | Depends on |
|---|---|---|
| 1 | slot overrides, effective-table visibility, set-time checks, `current-host` starter idiom | nothing |
| 2 | three-valued `requires_write`, `generator` canon, fallback chains, key validation | nothing (1 recommended first) |
| 3 | tier-1 predicates (`distinct_provider_from_inputs`, eligibility states), tier-2 constraint command | 2 (write-posture values) |
| 4 | shadow attachments, comparisons view, `model-tryout` starter, `ModelComparison` contract | 1 (state file), 3 (`shadow_only` flag) |

Each phase is independently valuable and releasable; ledger 0.2 rides the
first of 2–4 to land.

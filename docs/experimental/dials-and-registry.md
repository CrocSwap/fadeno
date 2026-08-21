# Model dials and the registry

**Status:** implemented — **Shipped (0.6.0-rc.27) and hardened post-0.6.** No backwards compatibility: pre-dials catalogs and snapshots are refused loudly — catalogs require `schema_version: 3` with message `schema_version 3 required — pre-dials catalogs are not supported; migrate: targets:→models:, loadouts:→dials:, default_loadout: delete; see docs/experimental/dials-and-registry.md` and snapshots require `snapshot_version: 3` with message `pre-dials run snapshot — this fadeno verifies snapshot_version 3 ledgers only; verify with fadeno <= 0.6.0-rc.27`. The command is `fadeno dial` with verb-first grammar (open question 1 decided: `fadeno dial` replaces `fadeno loadout`; see Open questions below), `--executor` is removed (`--model` is the one spelling), pin moved to `.fadeno/local/dials` (snapshot_version 3 replaces the v1-shaped emission), and `ConstraintContext.transport` is now `host` (was `native`). The dispatches reader still renders 0.x/legacy ledger rows as `[legacy]` — evidence history is not a compat surface.

Deviations from the sketch below, all deliberate: the catalog bumped to `schema_version: 3` — v2
(`targets:`/`loadouts:`) is **rejected** with a migration message, while v1
documents kept parsing byte-identically at ship time because run snapshots were serialized
v1 docs and `fadeno verify` replayed old runs through a frozen legacy path
(`resolveRoleLegacy` + a loadout-shaped verify branch) — now removed; verify refuses pre-dials snapshots as above. Live resolution is
split into a registry-free pure cascade (`resolveDialCascade`) plus a compile
step (`compileDialRef`); the canonical dial string (`model[@effort][ via
driver]`) is the executor name in evidence and the key of the snapshot's
compiled executors map, which is what lets verify recompute without the
registry. The dispatches ledger re-spelled as **format 1.0** (major bump per
the writer's own contract, not the minor bump sketched here): `loadout`/
`override`/`target` fields dropped, `resolution` re-valued to
`binding|session|repo|user|base|model-flag|shadow`, and `dial`/`model_id`/
`driver`/`reasoning_effort` added; 0.x rows stay readable with a
`[format 0.x]` mark, and the reader now renders `[session dial]`/`[repo
pin]`/`[user dial]` provenance marks. `resolution_snapshot` role rows now
stamp `resolved_via` (closing the slots-era gap where verify's
present-must-match was unreachable). `ConstraintContext` re-spelled
(`dial`/`dial_source`/`dials`/`driver`/`model_id`; `active_loadout`/
`overrides`/`target` gone) — the one outward contract that could not be
aliased. Host-delivered dials render effort `inherited` and refuse `@effort` at dial
time, as specified.
Originally proposed 2026-08-15; landed before the 0.6.0 schema freeze:
the pin file, the catalog's selection layer, and dispatch-row resolution
fields all changed shape here, and freezing the prior shapes first would
have frozen known-wrong ergonomics.
**Decision date:** 2026-08-15
**Relationship:** successor horizon to
[`slots-and-archetypes.md`](slots-and-archetypes.md) — keeps its central
principle (the slot is the unit) and everything downstream of resolution
(archetype policy, constraint tiers, shadows, the dispatch chokepoint,
evidence), and retires the one layer it had preserved: the named preset.
Revises the *selection* half of
[`loadouts-and-dispatch.md`](loadouts-and-dispatch.md); the dispatch kernel,
routes, and evidence contract carry forward unchanged. Inherits the standing
constraint set: no daemon, no cloud service, no scheduler, no auto-fallback
across providers; evidence over trust.

## Observed need (admission receipts)

Four frictions, all from daily dogfood of the shipped loadout system:

1. **Nobody switches loadouts; everybody dials.** Phase-1 session overrides
   became the only switching primitive in real use within days of shipping.
   Users' per-archetype preferences are not tightly linked — swapping the
   worker as a subscription rotates should not drag the judge and reviewer
   along — so named archetype→target tuples model a coupling that does not
   exist. The starter catalog is the combinatorial explosion in miniature:
   six loadouts, mostly all-slots-same-target plus `current-host` fillers,
   and the filler idiom exists *only* because loadouts must be total maps.
2. **Target names are inconsistent because they encode too much.** A target
   name has to carry model + effort + harness affinity at once, so the
   catalog reads `sol-high` next to `claude-default` and neither spelling
   generalizes. Effort should almost always be the model's standard value;
   baking it into names multiplies entries and still fails the user who
   wants to dial it occasionally.
3. **Adding a model is a catalog-editing chore at the worst moment.** The
   highest-frequency real flow is: a new model drops, the user wants to
   shadow it through a universal driver (OpenCode) against their workhorse
   *today*. Today that means authoring a target entry (and often a loadout)
   before the first dispatch.
4. **Model→harness binding is standard almost always, awkward exactly when
   it isn't.** Route selection is keyed by the target's provider, so running
   a model through a non-home driver means authoring a *different target*
   under a different provider key with a different model spelling. The
   worker-on-Opus case is a live dead end: the anthropic headless route is
   `write_access: false`, worker `requires_write: required`, and nothing
   guides the user to the OpenCode delivery that would work.

## Design principles

- **The model is the addressable unit.** Users think "sol", "grok",
  "kimi-k3" — the registry is what makes a bare model name resolve
  deterministically to a concrete delivery. This *preserves* the original
  non-goal behind "loadout slots bind executors, never bare model names":
  that rule was about resolution being deterministic and snapshotable, not
  about the dial's spelling. Resolution still terminates in one concrete
  route + argv, snapshotted in evidence.
- **The base is the host.** With no preset layer, the resolution floor for
  every canonical archetype is `current-host` — which is what
  `default_loadout: native` + `bindings: {"*": current-host}` already
  expressed as configuration. It becomes definition instead.
- **Dials are per-archetype and layered.** One cascade:
  `role binding → session dial → repo pin → user dial → host-native base`.
  A repo pins only the archetypes it has opinions about (a research repo
  pins its worker model) and defers to the user's dials for the rest.
- **Active-layer set, inferring clear, always narrate the layer.** A plain `set`
  updates the highest existing dial layer, creating a user default only when
  no dial exists; a plain
  `clear` removes the session dial, or — when there is no session dial and
  no repo pin — the user default, since that is the only dial it can mean
  (revised 2026-08-16; see "Scope semantics" below). Every `set`/`clear`
  echoes the layer it touched. Nothing is ever written into a shadowed
  layer silently, and committed repo pins are only ever removed with an
  explicit `--repo`.
- **Harness quirks live in drivers, never in the registry.** The registry
  stays uniform (model + effort as separate dimensions, always); a driver
  that encodes effort in the model id declares a translation, applied at
  delivery time.
- **Dial-time verification is a courtesy; dispatch time is the truth.**
  Backend model verification runs when a dial is set, fails open, and
  caches only positives. Dispatch never adds a verification round-trip.

## Schema

### The model registry

`models:` replaces `targets:` in `.fadeno/executors.yaml` (all layers:
builtin starter, user, project — merged under the existing layering rules).

```yaml
schema_version: 3
models:
  sol:                          # plain form: home driver + standard effort
    provider: openai
    id: gpt-5.6-sol
    effort: high
  grok:
    provider: xai
    id: grok-4.6
    effort: high
  opus:
    provider: anthropic
    id: opus
    effort: default
    spellings:                  # per-driver id spelling, when it differs
      opencode: anthropic/claude-opus-4.8
  gemini:
    provider: google
    id: gemini-3.1-pro          # effort-suffix translation happens in the driver
    effort: high
  current-host: {}              # built-in; dialable like any model
```

- `provider` names the home credential family — the same keys the route
  table already uses. Route *selection* becomes model → registry →
  provider → route row, instead of target-name → provider.
- `effort` is the model's standard effort: what a bare dial of this model
  means. Effort disappears from names entirely.
- `spellings` maps driver aliases to the id that driver needs. Absent key =
  the plain `id`.
- Per-model **eligibility** (`eligible | shadow_only | forbidden`,
  per-archetype) moves here from targets, unchanged in semantics — it was
  always a property of the model, not of a name-effort tuple.

### Driver fields on routes

Route rows (unchanged in shape otherwise) gain three optional fields:

```yaml
routes:
  codex:
    openrouter:
      driver: opencode          # alias --via selects by; default: provider key
      command: [opencode, run, -m, "openrouter/{model}", --variant, "{reasoning_effort}", --agent, fadeno-readonly, --auto]
      write_access: false
      write_variant:
        command: [opencode, run, -m, "openrouter/{model}", --variant, "{reasoning_effort}", --auto]
      models_command: [opencode, models]
    google:
      driver: agy
      command: [agy, --model, "{model}", --new-project, --dangerously-skip-permissions, --output-format, text]
      write_access: true
      effort_encoding: model-suffix   # delivers gemini-3.1-pro + high as gemini-3.1-pro-high
```

- `driver:` — the user-facing alias for `--via` and `spellings:` keys.
- `models_command:` — how to list the driver's available model ids, powering
  dial-time verification (below). `grok models`, `agy models`, and
  `opencode models` all exist today.
- `effort_encoding: flag | model-suffix` (default `flag`) — the Antigravity
  class of quirk as a one-line driver declaration, reusable by any future
  harness with the same behavior. The evidence row records the canonical
  `(model, effort)` pair *and* the delivered argv, so the translation is
  visible after the fact.

### Selection config

```yaml
unregistered_model_driver: opencode   # fall-through for unknown model ids
```

One key, user-overridable, defaulting to the universal multi-provider
driver. An unregistered model id resolves through this driver with the id
passed verbatim.

### What is deleted

`loadouts:`, `default_loadout:`, and `targets:` sections; the
`fadeno loadout use / list` subcommands; the `--loadout` flag and
`FADENO_LOADOUT`; the `fadeno targets` command (dropped, not renamed — the
no-arg effective table and the registry are the inspection surfaces); the
`current-host` filler idiom (it was pure preset tax); the
base-switch-drops-overrides rule (no base to switch); the
strict-vs-graceful stale-pin split (no named loadout to be stale against —
a dial names a model, and an unregistered model has defined fall-through
semantics instead of being an error).

`bindings:` survives for explicit playbook-role pins (the cascade's first
step); its `"*"` terminal becomes redundant with the built-in host-native
base and is accepted-but-ignored with a deprecation note.

## The dial surface

```
fadeno dial                                   # effective table
fadeno dial <archetype> <model>[@effort] [--via <driver>] [--session|--user|--repo] [--force]
fadeno dial clear <archetype> [--session|--user|--repo]
fadeno dial shadow <archetype> <model>[@effort] [--via <driver>] [--rate <r>]
fadeno dial clear-shadow [<archetype>]
fadeno dial resolve --archetype <a>          # JSON, hook contract
```

The `model[@effort]` grammar is uniform everywhere a model is named: bare
`sol` means sol at its registry-standard effort via its home driver;
`sol@xhigh` dials effort; `--via opencode` overrides the driver, with the
registry's `spellings` supplying the id translation. `--via` is honest
about being an escape hatch: OpenCode is the one universal adapter today;
the other drivers only run their own models.

**Set-time refusals** cover write posture and eligibility `forbidden` before
any dial state changes. A write-posture refusal names `--force` as a
discouraged escape hatch. When used, Fadeno stores the dial in explicit form
with `force_write_posture: true`, prints a prominent warning explaining the
exact mismatch, and honors that override at dispatch/drive/steering time.
The override is scoped to the directly dialed archetype: fallback resolution
does not inherit it. `--force` bypasses only write posture; eligibility and
all other constraints still apply normally.

`current-host` stays dialable like any model, and this is load-bearing: a
user-level `worker → grok` with a session-level `worker → current-host`
means "native in this repo, grok everywhere else" — expressible only if
native is a dial value, not merely the base.

### Scope semantics: active-layer set, explicit scope

Cascade: **session > repo > user > base.** A plain `set` (no scope flag)
writes:

| Highest existing dial for `<archetype>` | Plain `set` writes | Why |
|---|---|---|
| session dial | **session** level | update the effective checkout-local choice |
| repo pin | **repo** level | update the effective shared project choice |
| user dial | **user** level | update the effective cross-repo default |
| no dial | **user** level | the default creation flow is global subscription rotation |

Every `set` echoes the layer it wrote, in both cases:

```
worker → grok-4.6 @ high via grok  [user default — applies across your repos]
worker → grok-4.6 @ high via grok  [session dial — this checkout only,
  sticky until cleared]
```

The narration is the load-bearing part: adaptive defaults are fine exactly
as long as the tool says what it did. Note the honest wording — the session
layer is the gitignored repo-local pin, **sticky until cleared**, not tied
to a shell session; the notice must not oversell its temporariness.

`--session` writes the gitignored checkout-local override. `--repo` writes the
committed per-archetype repo pin (project catalog).
Granularity is per-archetype by design: a repo pins its judge and defers to
the user's worker rotation if it has no worker opinion.

**`clear` follows the dial when the layer is unambiguous** (revised
2026-08-16; the original "never adaptive downward" rule proved to be pure
friction in the common case). `clear worker` clears the session dial if one
exists. With no session dial and no repo pin, the user default is the only
dial the command can possibly mean — it is cleared, with the inference
narrated:

```
cleared worker (opus) [user default — the only layer holding a dial]
```

A **repo pin blocks the inference**: pins are committed config, removed only
with an explicit `--repo`, so `clear worker` in a repo that pins worker
reports the pin and stops (and leaves any user dial beneath it untouched):

```
no session dial for worker; worker is repo-pinned —
  `fadeno dial clear worker --repo` to remove it
  (repo pins are committed config, never cleared implicitly)
```

The original worry — clear-adaptivity deleting state the user doesn't know
exists — is answered by the narration naming the layer it cleared, and by
the repo-pin exception keeping committed state explicit.

**Supersedes the blanket user-layer suppression rule** (the rc.14
"self-contained project profile ignores the user pin" behavior): repo pins
win where they exist and user dials apply elsewhere, per archetype. A repo
that wants total control pins every archetype — simpler to explain,
strictly more expressive. (Config-*layer* composition for the catalog
itself is unchanged; this retires only the pin-scoping special case.)

### The effective table

The no-arg command prints the whole truth — with no preset layer, the table
*is* the effective dial state:

```
archetype  model          effort    harness        source
judge      sol @ xhigh    xhigh     codex          session dial
reviewer   current-host   high      current-host   base
generator  current-host   default   current-host   base
worker     grok-4.6       high      grok           user dial
  ~ shadow: worker ~ kimi-k3 via opencode [rate 0.25]
```

One row per archetype in the canon power order (director, judge, reviewer,
generator, worker; extras alphabetical after — revised 2026-08-16, when
generator also lost its worker fallback and became a standalone archetype
defaulting to the host-native base), `source` naming the cascade layer that
won, custom fallback chains rendered inline, shadow attachments
below their slot. This permanently retires the "declared slots hiding the
dialed override" class of papercut: there are no declared slots.

The table is deliberately reference-frame neutral: `luna` says `codex`
whether the caller is Codex, Claude, Grok, or the standalone CLI. The caller's
route later decides whether Codex is reached as a host agent or through
`codex exec`; that adapter is structured resolution/dispatch data, not part of
the model's displayed harness identity.

## Unregistered models: fall-through with verification

Dialing (or shadowing) a model id not in the composed registry routes it
through `unregistered_model_driver` with the id passed verbatim — the
new-model flow with zero catalog editing:

```
$ fadeno dial shadow worker kimi-k3 --rate 0.25
note: kimi-k3 is not in the model registry — routing via opencode, id passed verbatim.
      (declare it under models: to set a home driver or standard effort)
verified: kimi-k3 is available on opencode
shadow attached: worker ~ kimi-k3 via opencode [rate 0.25]
```

The verbatim fall-through would otherwise swallow typos into burned
dispatches, so the dial is verified against ground truth:

- **Probe at dial time, never dispatch time.** `set`/`shadow` runs the
  target driver's `models_command` and checks membership. Dispatch trusts
  the dial and stays zero-latency.
- **Cache positives only, indefinitely; never cache negatives.** A verified
  `(driver, model)` pair lands in user state
  (`$FADENO_STATE_HOME/model-verifications.json` — machine/credential
  scoped, not repo scoped) so kimi-k3 is probed once, ever. A negative is
  never cached: the model may exist after tomorrow's driver update, and a
  cached "no" would block exactly the flow this exists to serve.
- **A failed membership check refuses the dial with the listing's nearest
  matches** ("unknown model `slo` on opencode — did you mean `sol`?").
  Refusal, not warning: the probe succeeded and the backend said no.
- **Fail open on probe failure.** Driver not installed, offline, listing
  command errors → the dial proceeds with a loud `[unverified]` note.
  Failing closed would make the feature a liability on a plane.

Registered models get the same probe against their resolved driver when a
dial names them — same cache, same fail-open — so a stale registry entry
surfaces at dial time too.

## Evidence and the pin file

- **Pin file v3** (`.fadeno/local/dials`): `{dials: {archetype: dial},
  shadows: {…}}` — no `loadout` key. A dial records the model reference as
  dialed (`model`, optional `effort`, optional `via`), single-line sorted
  JSON as today. Shadows keep their attachment shape; the `use`-drops-
  shadows rule dies with `use` (shadows persist until cleared).
- **Dispatch rows** record the resolved quadruple — `model` (canonical id),
  `effort` (effective; `"inherited"` on native), `driver`, `delivery` —
  plus `dial_source: session | repo | user | base | binding`, replacing the
  loadout-name fields. Strictly more informative than
  `resolution: "override"` + an opaque executor name. `resolved_via`
  (fallback chains), shadow pairing fields, refusal rows, and the two-row
  `dispatch_requested` / `dispatch_completed` contract are unchanged — same
  pairing as before, now carrying `model`, `effort`, `driver` instead of
  `target` / `loadout`. A `host_delivery` row and its `hook_version` stamp
  remain the steering hook's evidence for in-session delivery; the
  stdin-heredoc `FADENO_PROMPT` relay contract and the `relay_attested` mark
  on paired dispatches are unchanged.
- **`resolution_snapshot`** records the full effective table *including
  per-archetype source layers* — which closes the standing deferral that
  drive's engine-side resolution could not honor pin scoping because the
  snapshot lacked layer provenance.
- **Verify replays from the snapshot, never live state** — unchanged, and
  the property that makes all of this safe to restructure. Snapshots are `snapshot_version: 3` (the v1-shaped emission is refused).

Ledger format is `1.0` (`format: "1.0"` in every dispatch row); `0.2` rows
read under the existing tiered-legacy machinery and render with a `[legacy]`
mark. Agent surfaces carry a stamped version marker `[fadeno <version>]`
via `stampSurfaceVersion` so a row identifies the generation that wrote it.

Dispatch boundaries enforce archetype policy unchanged from the loadout era:
`write_access` on route rows against `requires_write: forbidden` / `required`
on archetypes (a write conflict → `write_conflict` / `write_access_denied`),
and `distinct_provider_from_inputs` plus per-model `shadow_only` / `forbidden`
eligibility via `constraints:` — all re-spelled onto the `model`/`driver`
row fields but semantically identical, including the `shadow_only` →
`gate_eligible: false` stamp.

**Write variants** (decided 2026-08-16, completing the who/how split): a
route declared `write_access: false` may declare a `write_variant:` — an
alternative argv that CAN write (e.g. headless claude with `--permission-mode
acceptEdits`). A `requires_write: required` archetype resolving onto that
route gets the variant automatically; every other posture gets the base. So
`fadeno dial worker opus` just works while reviewer/judge dials of the same
model stay physically read-only — one model name, capability picked by the
archetype's declared policy, never by a capability-suffixed spelling
(`opus-write` lived for one day and died for exactly this reason). The
escalation is authorized in the catalog (the same place that declared
`requires_write`), not implied by the dial. Selection is
`applyWritePosture`, applied at every delivery boundary (dispatch, drive,
steering, dial show/resolve); the compiled variant rides the executor spec
into the run snapshot, so replays posture identically; evidence rows carry
`write_variant: true` and the reader marks `[write variant]`. A variant
without its own `resume` does not advertise session resumption (the base
resume argv carries the base permission mode). Declaring `write_variant` on
a route that is not `write_access: false` is a parse error — a variant
exists to escalate a read-only delivery, nothing else — as are a variant
argv identical to the base and a variant whose session fields would violate
the `resume ⟺ id source` invariant after posturing; the snapshot parser
re-asserts the same invariants at the replay trust boundary.

The starter catalog applies that shape to every command lane with a verified
read boundary: Claude (permission mode), Codex and Grok (OS sandbox), Muse
(write and shell tools disabled), and OpenCode (a project deny-policy agent
emitted by `init`). Live 2026-08-16 probes required each base to read a marker,
attempt a write, leave no file, and still return a report; each write variant
then had to create the file. Antigravity is the explicit exception: `--mode
plan --sandbox` denied the write but exited 0 with no report, so its route stays
write-only rather than overstating coverage.

**Effort belongs to the who, never the lane** (revised 2026-08-16; the
"host delivery inherits effort" story is retired). A model's effort is its
registry standard or the dial's `@effort` pin — a property of the who.
Delivery lanes differ only in the *mechanism* that applies the request:
command lanes inject it into the argv (`{reasoning_effort}` substitution or
`effort_encoding: model-suffix`); codex host slots pin it as
`model_reasoning_effort` in the materialized TOML; claude host slots pin it
as `effort:` frontmatter in materialized local subagents
(`fadeno steering apply --claude` writes `.claude/agents/<archetype>.md`
with `model:` + `effort:` from the current dials — Claude subagent
frontmatter supports per-agent effort natively). Nothing "inherits": an
in-session luna worker runs at luna's xhigh while a sol session stays at
medium. Consequences: `@effort` dials on host deliveries are no longer
refused — the pin travels on the request, with a note that materialized
surfaces apply it — and the dial table / steering resolve show the real
effort instead of `inherit`. Materialization is explicit: re-run
`steering apply` after re-dialing (command slots need no file — the
dispatch proxies carry them — and a managed local agent left over from a
host era is removed so the hook never targets a stale identity).

**The director archetype** (2026-08-16) is the who/how split applied to
orchestration: an expensive host session hands a whole side task — planning
included — to the model dialed as `director`, which coordinates
workers/reviewers itself through the fadeno CLI. Three declared pieces make
it safe: `requires_write: required` (it mutates run ledgers), a `brief:`
field on the archetype naming a template composed ahead of every ad-hoc
dispatch (`.fadeno/briefs/<name>.md`, else the builtin; evidence records
`brief`, the digest attests the composed bytes, `--no-brief` opts out) — how
the spawned model learns its standing orders — and **route-level
`eligibility:`** (merged with model eligibility, strictest wins), the
structural spelling of "this lane cannot host a director": routes without
fadeno capability (grok/agy/opencode, plan mode, claude lanes whose write
variant lacks the `Bash(fadeno:*)` grant) declare
`eligibility: { director: forbidden }`, which binds unregistered models
falling through those lanes too. The block is catalog truth, not runtime
plugin sniffing.

Variants are **command-delivery only**: a `host: true` route refuses the key
at parse. In-session delivery carries the host's own permissions, and the
locked fallback lane (`fadeno dispatch-fallback`) replays the snapshotted
base argv byte-for-byte under the attestation equality checks — so no host
lane can honor a variant, and advertising one there would claim a capability
nothing delivers (the first review of this feature caught exactly that).
Consequence, stated honestly: the claude-harness fallback wart — a locked
worker request delivered through headless `claude -p` with no approver, the
2026-08-12 dogfood failure — remains open on that lane. Closing it means
wiring posture through the locked-request attestation contract
(host-dispatch and verify both key on the base argv), which is future work,
not a side effect of this feature.

## Worked flows (the receipts this design was wargamed against)

1. **Subscription rotation** (the wedge): `fadeno dial worker grok
   --user` … two weeks later `dial worker muse --user`. One command, one
   archetype, every repo; judge/reviewer untouched.
2. **Effort for one gnarly review:** `set judge sol@xhigh` → run →
   `clear judge`. No named entries touched.
3. **New model drops:** the shadow flow above; after evidence accumulates,
   `fadeno dispatches --bakeoffs` → `set worker kimi-k3` — the adoption
   ladder (shadow → dial) with zero authoring.
4. **Model through a non-home driver:** `set worker opus` refuses (home
   route can't write) and names the fix; `set worker opus --via opencode`
   works, the registry spelling translating invisibly. A guided path where
   today there is a dead end.
5. **Repo with opinions:** research repo pins `judge` via `--repo`; a
   contributor's plain `set judge terra` lands session-level with the
   narrated notice; their worker rotation keeps applying because the repo
   never pinned worker.

## Non-goals (named so they stay whole)

- **Presets as a resolution layer.** Dead. If shareable bundles return, they
  return as *sugar* — a named bag of dials applied in bulk at set time,
  participating in no cascade.
- **Auto-fallback across providers.** Still forbidden. Fall-through for
  *unregistered ids* is a naming rule at dial time, not a runtime retry —
  a dispatch never silently re-routes.
- **Dial TTLs** ("worker=grok for today"). The sticky session pin plus the
  always-visible source column is the mitigation; time-boxed state remains
  the open question it was in slots-and-archetypes.
- **A Fadeno-owned model roster.** The starter registry ships a small
  current set; rosters and verdicts stay human and repo-level, with
  eligibility as their machine-readable residue, as before.
- **Route operational-policy fields** (env, retry, concurrency, prompt-size
  ceilings). Still a separate horizon; `models_command` /
  `effort_encoding` / `driver` are delivery-shape fields, not operational
  policy.

## Open questions

1. **The command name — DECIDED.** Post-0.6 hardening renamed `fadeno loadout` to `fadeno dial` with verb-first grammar (`dial <archetype> <model>`, `dial clear`, `dial shadow`, `dial resolve`); the steering hook now shells out to `fadeno dial resolve`. No backwards compatibility: `fadeno loadout` is removed entirely.
2. **User-level shadows.** The rotation persona would plausibly want a
   challenger shadowing their worker *across* repos. Session-scoped
   attachments ship first; a `--user` shadow scope is additive later.
3. **A `fadeno models` inspection command — DECIDED, built (2026-08-16).**
   `fadeno models` renders the frame-neutral registry (home harness per row,
   probe-cache state in structured output, and the unregistered-fallthrough
   rule in the footer); `fadeno models <name>` adds alternate `--via`
   harnesses, spellings, and eligibility;
   `fadeno models --driver <alias>` shells the route's `models_command` for
   the live backend listing with registered spellings marked. Dogfooding it
   immediately surfaced a probe wrinkle: opencode lists namespaced ids
   (`openrouter/<vendor>/<model>`) while the route template prepends that
   namespace in argv, so bare spellings never exact-match its listing —
   membership matching vs. command-template namespaces is an open follow-up.
4. **Verification-cache hygiene.** Positives are cached indefinitely; is a
   `fadeno doctor` check ("cached model no longer listed by driver") worth
   it, or is dispatch-time failure loud enough?

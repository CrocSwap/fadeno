# Harness-neutral dials and a harness-keyed catalog (catalog v4)

**Status:** decided 2026-09-04, implemented in run
`2026-09-04-2215-catalog-v4-harness-neutral-dials-a-dial`. Successor to
[`dials-and-registry.md`](dials-and-registry.md), whose `routes:` / `--via`
sections are superseded by this document.

## The principle

A dial names **who** runs an archetype and, optionally, **which harness** runs
it. It never names a lane, a driver, or an argv.

The **host** harness — the one Fadeno is invoked inside — is discovered only at
dispatch time, from ambient signals (`FADENO_HARNESS`, set by an in-harness
adapter, or the env markers a harness process sets itself), and never from
stored state. At dispatch time the pair *(dial harness, host)* plus policy
resolves the delivery:

| dial harness vs host | delivery |
|---|---|
| same, and the harness declares `host:` | in-session (the host lane) |
| different | spawn that harness's CLI (the command lane) |
| different, and it declares no `command:` | `restart_required` — start a session inside it |

Policy adjusts from there: an effort pin the host cannot carry ejects to the
command lane, an eligibility entry can forbid a lane for an archetype, a
selected shadow pair forces both arms onto the command lane, and a locked run
snapshot overrides everything.

## Vocabulary

| Word | Meaning | Where it appears |
|---|---|---|
| `host` | the harness this call runs inside; `standalone` from a bare shell | JSON outputs, ledger rows, doctor/status lines |
| `harness` (on a dial or delivery) | the harness that executes the model | dial refs, `--harness`, ledger rows, catalog `harnesses:` keys |
| `lane` | `host` / `command` / `restart_required`, decided at dispatch time | unchanged |
| `variant` | a named alternative argv of a harness's command lane, chosen by policy | catalog, ledger rows |

**Catalog keys deleted, and refused rather than ignored** — each with a
migration note naming its v4 spelling: `routes:`, `driver:`, `host: true`,
top-level `relay:`, `unregistered_model_driver:`, `models.<m>.delivery:`, and a
` via ` in a dial or binding.

**Code that went with them, and is simply gone:** `RELAY_HARNESSES`,
`findRouteByDriver`, `declaredDriverAliases`. One name on the plan's delete
list was KEPT instead: `hostEffortIsMaterializable`, now
`(profile, harness)` — it reads `harnesses.<id>.host.effort_channel` off the
catalog rather than hardcoding a harness, which is the v4 shape of the same
question. Nothing emits `driver` or `via` again.

## Catalog v4, by example

```yaml
schema_version: 4

models:
  luna:  { provider: openai,    id: gpt-5.6-luna, effort: xhigh }
  opus:
    provider: anthropic
    id: opus
    effort: xhigh
    spellings:            # keyed by HARNESS now, not by driver
      opencode: anthropic/claude-opus-4.8
  gemini: { provider: google, id: gemini-3.7-flash, effort: high }
  # a model may name a non-home harness explicitly: `harness: opencode`
  # (replaces `delivery: { route, id }`; the id goes in `spellings.<harness>`)

# One table, keyed by harness id. A harness is a HOST (Fadeno can run inside
# it) when it declares `host:`, and an EXECUTOR (Fadeno can spawn it) when it
# declares `command:`; most are both, one is required.
harnesses:
  claude:
    provider: anthropic                  # home provider → models default here
    host:
      effort_channel: none               # no effort channel → a pin ejects to the command lane
      relay: sonnet                      # was relay.claude
      eligibility: { director: forbidden }
    command: [ claude, -p, --model, "{model}", --dangerously-skip-permissions ]
    eligibility: { director: forbidden } # the BASE command lane's own constraint
    variants:
      exec:                              # was the anthropic-exec route / `--via claude-exec`
        command: [ claude, -p, --model, "{model}", --dangerously-skip-permissions ]
  codex:
    provider: openai
    host:
      effort_channel: agent-file         # the agent TOML carries model_reasoning_effort
      relay: luna@high                   # was relay.codex
    command: [ codex, exec, --model, "{model}", --dangerously-bypass-approvals-and-sandbox, -c, 'model_reasoning_effort="{reasoning_effort}"', "-" ]
  agy:                                   # executor only: no host: block
    provider: google
    command: [ agy, --model, "{model}", --new-project, --dangerously-skip-permissions, --output-format, text ]
    models_command: [ agy, models ]
    effort_encoding: model-suffix
    eligibility: { director: forbidden }
  opencode:
    provider: openrouter
    host:
      effort_channel: none
      identity: session                  # the adapter rewrites only the agent NAME,
                                         # so only `current-host` takes the host lane
    command: [ opencode, run, --model, "{model}" ]
    variants:
      direct:                            # was the opencode-direct route
        command: [ opencode, run, --model, "{model}" ]
  omp:                                   # host only: no command: to spawn
    host: { effort_channel: none, identity: session }

unregistered_model_harness: opencode      # was unregistered_model_driver
```

`eligibility:` sits on the **lane** it constrains — `host:` for the in-session
lane, harness level for the base `command:` lane, inside a variant for that
variant. Three rules make that unambiguous:

- A **variant does not inherit** the base lane's eligibility: it is a different
  argv with different capabilities, which is the whole reason it has a name.
- Harness-level eligibility **also gates the host lane**, because a v3 route
  carried one map for a `host: true` entry that also declared a `command:` and
  it gated both. `host.eligibility` overrides it **per key** — the more
  specific statement about the same harness, able to relax as well as tighten.
- The **model's** own map then merges strictest-wins over the result: a model's
  restriction is not a harness's to relax.

Harness-level `eligibility:` with no `command:` is refused at load — it would
constrain nothing, and it is exactly what a naive v3 rewrite produces while
believing the host lane is gated.

### Rules the loader enforces

- `schema_version: 4` is required for any layer that declares `harnesses:`.
- A `schema_version: 3` layer still loads if it declares **none** of the
  removed keys; declaring one gets a migration note naming the key and its v4
  spelling. `doctor` reports a v3 layer as a warning.
- `harnesses.<id>` must declare at least one of `host:` / `command:`.
- `harnesses.standalone` is refused: `standalone` is the value `host` takes
  when NO harness claims the session, so there is nothing there to run inside.
- Exactly one harness may claim a given `provider:` as home.
- A **project- or builtin-declared** model whose provider has no home harness,
  and which names no `harness:`, is a load error pointing at
  `fadeno model add` — a catalog defect is a file someone edits. A
  **user-layer** model in the same shape is DROPPED instead, named in
  `modelFallback.dropped` and surfaced by `fadeno dial`: a personal alias is
  machine state, not catalog policy, and one stale `fadeno model add` must not
  make every unrelated dial in every repo fail at load. Dialing the dropped
  alias itself still fails loudly.
- `spellings` keys must be harness ids in the table.
- A self-contained project catalog is one with its own `models:` **and**
  `harnesses:`; `harnesses:` merges per harness id, so overriding one entry
  cannot silently drop the others.

#### The user layer is machine state, and cannot fail the load

One carve-out, deliberate: a pre-dials user catalog (`targets:` / `loadouts:`)
and an unknown top-level key are still refused at load. Neither is machine
state the CLI wrote, neither has anything to salvage, and the unknown-key
refusal is what keeps a misspelled key from silently doing nothing.

Every rule above is a rule about a FILE SOMEONE EDITS. The user catalog is not
one: `fadeno model add` wrote it, possibly under a fadeno two versions old, and
one stale entry in it must not be able to take out every unrelated command in
every repo — which is exactly what happened on 2026-09-05.

So `repairUserLayer` (`src/lib/config-layers.ts`) runs on the user document
BEFORE the merge, and therefore before `refuseRemovedCatalogKeys` and the
parser. It leaves behind a document neither of them can refuse for a model or a
ref, and names everything it changed in `modelFallback.repairs`, which
`fadeno dial` prints:

- `models.<m>.delivery: { route, id }` → `harness: <legacyDriverHarness(route)>`
  plus `spellings.<harness>: id`. Untranslatable (no bare `route`, no non-empty
  `id`) drops the model.
- `spellings` keys go through the same driver→harness mapping; a key naming a
  harness the merged table does not declare is dropped after the merge, when
  the table is complete.
- Refs in `dials:`/`bindings:` are re-emitted through `parseDialRef` →
  `formatDialRef`, so a persisted ` via <driver>` becomes ` on <harness>`.
- `routes:` and `relay:` are discarded with a note naming their v4 spelling —
  per-host tables v4 replaced wholesale, with no faithful mechanical
  translation. `unregistered_model_driver` IS translated.
- A model with no `provider:`, a non-identifier name, a non-mapping entry, or
  an unknown key is dropped or stripped, never thrown.
- A user override that would make a name the builtin or project layer already
  declares undeliverable RESTORES the lower layer's entry and names the
  collision, rather than taking that name out of the catalog.

Not tolerated, because neither is machine state and neither has anything to
salvage: a pre-dials user catalog (`targets:`/`loadouts:`) still gets
`preDialsCatalogError`, and an unknown top-level key still gets its
did-you-mean — that check is what keeps a misspelled `worktree_carry` from
silently doing nothing.

## Dial refs

Shape: `{ model, effort?, harness? }`. String grammar:

    model[@effort][ on <harness>]        e.g.  sonnet@high on opencode

`parseDialRef` accepts the legacy ` via <driver>` **on read only**, mapping
`claude-exec`/`claude-cli` → `claude`, `opencode-direct` → `opencode`,
`muse-code` → `muse`, and anything else to itself. It never emits `via`.
Reading persisted state that still spells a delivery that way adds a one-line
note so the translation is visible once.

CLI: `fadeno dial <arch> <model>[@effort] [--harness <id>]`, likewise
`dial shadow`, `dispatch`, and `bakeoff`. `--via` is removed everywhere and a
stale one errors naming `--harness`.

**Dial set validates against the registry only**: the model is known (or falls
through with the existing verification note), the effort is legal, and
`--harness` names a harness in the table. No eligibility refusal and no lane
notes — both are questions about a CALL, and are answered by `dial resolve` and
by the dispatch kernel, where a host exists.

`fadeno dial` columns: `archetype  model  effort  harness  source`. The
`harness` cell shows the resolved harness, marked `(home)` whenever the DIAL
did not name one — so a model-level `harness:` also prints `(home)`, because
from the dial's point of view it is the registry's answer either way.

## Resolution — one function, `resolveDelivery` in `src/lib/executors.ts`

```
resolveDelivery(ref, profile, host, ctx) → CompiledDelivery
  entry   = models[ref.model]                       # or unregistered
  h       = ref.harness ?? entry.harness ?? homeHarnessOf(entry.provider)
                                          ?? unregistered_model_harness
  H       = harnesses[h]                            # error if absent
  modelId = entry.spellings[h] ?? entry.id, then effort_encoding
  variant = first of [H.command (base), ...H.variants] whose eligibility
            permits ctx.archetype (model eligibility merges, strictest wins)
  hostCandidate = h == host and H.host != null and host eligibility permits
  spec    = hostCandidate ? host spec (fallbackCommand = variant argv)
          : variant != null ? command spec
          : host spec with no fallbackCommand   # nothing to run: restart_required
```

`current-host` is not a harness: it is the base dial, naming whatever session is
running. It resolves onto `host` with the host lane's command lanes **and**
eligibility stripped — there is no argv for "the session you are already in",
and the host lane's eligibility describes delivering a named model to a spawned
in-session agent, which is a different thing from the session itself. In a bare
shell there is no session, so `current-host` answers `restart_required` and its
`harness` is **null** rather than the non-harness `standalone`.

`host.identity` is the second thing the host lane asks. `model` (the default)
means the adapter can be told which model to run — Codex bakes it into the
agent TOML, Claude's spawn hook rewrites the tool call. `session` means it
cannot: OpenCode's plugin rewrites only `subagent_type` and omp's extension
only `agent`, so a dialed model handed to a host spawn there would be silently
ignored. Under `session` only `current-host` takes the host lane; a named model
on that harness is a command delivery. That is what v3 said by putting
`host: true` on `routes.opencode.current-host` alone.

`decideLane` (`src/lib/lane.ts`) keeps its signature and vocabulary; only its
inputs move. Pass `CompiledDelivery.hostCandidate` as `hostModel` — never
`spec.adapter`, which is also how a delivery with no argv at all is
represented.

## Outputs, rows, snapshots

- `dial resolve --json` / `steering resolve --json` carry `host` (ambient),
  `harness` (executor) and `variant` (nullable). `driver` is gone.
- Ledger rows (`.fadeno/dispatches.jsonl`) stamp `DISPATCHES_FORMAT` **1.1**.
  New rows write `host`, `harness`, `variant` and `dial: {model, effort?,
  harness?}`. Format **1.0** rows — where `harness` meant the host and `driver`
  meant the executor — are translated on read, in one place
  (`harnessFieldsOf`), and never rewritten on disk.
- Run snapshots stay at `snapshot_version: 3`. The compiled executor map is
  already post-compile and harness-neutral; its passthrough metadata key is now
  `harness` (plus `variant`), and a stored `driver` is read through the same
  legacy name map. The map also gains **archetype-specific entries** keyed
  `<ref>#<archetype>`, written only where policy chooses a different lane than
  the archetype-less resolution did — because under v4 the ref alone no longer
  identifies the argv (`opus` is the base claude lane for a worker and the
  `exec` variant for a director), and a snapshot keyed by ref alone made
  `fadeno drive` refuse a director that `fadeno dispatch` delivered. `#` cannot
  occur in a ref string, the keys are additive (a catalog whose lanes carry no
  eligibility adds none), every lookup falls back to the plain ref, and an
  older fadeno reading a newer snapshot finds that ref and replays the answer
  it would have given anyway. Read one with `snapshotExecutor(profile, ref,
  archetype)`, never `executors[ref]`.

## Materialization

- **Codex**: a dial resolves to a Codex host agent when its harness is `codex`
  and to a command broker otherwise. Pinning effort into the TOML is gated on
  `harnesses.codex.host.effort_channel == 'agent-file'`. The relay identity
  comes from `harnesses.codex.host.relay`. `steering apply --codex` bakes
  `--host-executor <ref>` in the v4 grammar; `readCodexAgentFile` parses both
  grammars so an agent file written by an older fadeno still identifies itself.
- **Claude**: the proxies' relay model comes from
  `harnesses.claude.host.relay`; the hook reads `harness`/`lane`. The base
  `harnesses.claude.command` carries `--dangerously-skip-permissions` — the
  same headless trust codex, grok, agy, opencode and muse carry on their own
  command lanes. It replaced `--permission-mode acceptEdits --allowedTools
  Bash` on 2026-09-06, and the reason is the general one below: that pair
  auto-approved edits and Bash and nothing else, so any tool outside it was a
  denial rather than a pending request, mid-assignment.
- **Every command lane, one rule.** Each lane carries its vendor's
  headless-approval flag and none carries a restricting one. An unresolved
  permission request is *denied* by a headless run — nobody is there to answer
  it — so a partial grant buys no safety and costs whole assignments. Codex was
  the last lane where that was not true: `--sandbox workspace-write` denied a
  worker's SSH to a remote host twice with `Operation not permitted` while the
  host's own SSH succeeded through escalation, and the assignment could not run
  at all. It now carries `--dangerously-bypass-approvals-and-sandbox`.
  These are permission grants, not sandboxes: containment is the isolated
  worktree, which contains file writes and nothing else. A project that wants a
  tighter posture declares its own named variant with its own restricting
  flags — see `permissions-and-isolation.md`.

  The `exec` variant keeps the identical argv and remains only the `director`
  **eligibility carrier**. It grants no capability the base lane lacks; the base
  lane's `eligibility: { director: forbidden }` is what makes policy fall
  through so the ledger row and run snapshot record `variant: exec` — the one
  thing that distinguishes a director dispatch from a worker dispatch that ran
  the same command. Keep the two argvs equal; a test asserts it.
- **OpenCode / omp**: same field moves; their emitted artifacts are otherwise
  byte-stable.
- `fadeno models` lists per harness; `--driver <alias>` became `--harness <id>`.

**Every host-slot decision reads `hostCandidate`, never `spec.adapter`.** A
host spec is also how a delivery with no argv at all is represented, so the two
disagree exactly on `current-host` in a bare shell and on a host-only harness
named from a different host — which is how `steering apply --codex` came to
write a Codex host agent for `opus on omp`. `hostCandidateOf(compiled, spec)`
is the one predicate: a live compile answers from `hostCandidate`, a snapshot
spec from its own frozen `adapter`. Every one of the six materialization sites
goes through it, and each resolves with its own `{ archetype }` so a
policy-chosen variant and the host lane's eligibility both reach the decision.

## Shadow pairs under v4

A shadow attachment persists `{model, effort?, harness?, rate?, n?,
remaining?}`; `via` becomes `harness` exactly as for dials, with the same
read-only legacy mapping, and `fadeno dial shadow … --harness <id>` replaces
`--via`.

Pair routability (`explainPairRoutability`, `shadow.routable`) still asks one
question: does the PRIMARY have a command lane to move onto. Under v4 that is
whether the primary's resolved harness declares a `command:` or an eligible
variant. `current-host` still has none, so the "NO PAIR POSSIBLE" refusal
survives unchanged in meaning.

`shadowSampleRoll(promptSha256, archetype, challenger)` is a pure function and
is **byte-identical**, so a pair decided before v4 re-derives identically after
it. But the challenger string it hashes is the shadow ref's FORMATTED form, and
`formatDialRef` changes only for refs that carried `via` — so a legacy `via`
shadow re-attached under v4 formats differently and therefore re-rolls. That is
deliberate: preserving the old string would keep the driver vocabulary alive
inside the hash.

## Migration

| v3 | v4 |
|---|---|
| `routes.<host>.<key>` | `harnesses.<id>` (one table; the host is discovered) |
| `driver: claude` | the harness id itself |
| `host: true` | a `host:` mapping (`effort_channel`, `identity?`, `relay?`, `eligibility?`) |
| `routes.<host>.anthropic-exec` | `harnesses.claude.variants.exec` |
| `relay: { claude: sonnet }` | `harnesses.claude.host.relay: sonnet` |
| `unregistered_model_driver` | `unregistered_model_harness` |
| `models.<m>.delivery: {route, id}` | `models.<m>.harness` + `models.<m>.spellings.<harness>` |
| `--via <driver>` | `--harness <id>` |
| `routes.opencode` with `host: true` on `current-host` alone | `harnesses.opencode.host.identity: session` |
| `model via driver` (ref string) | `model on <harness>` |

## Known gap

A variant is chosen by policy and cannot be named on a dial or pinned by a
model entry. The `opencode-direct` route became the `direct` variant of the
`opencode` harness, so there is no v4 spelling for "register this model onto
the direct lane" — `fadeno model add`'s direct-discovery step was removed
rather than left to write an entry that silently resolves onto the OpenRouter
lane with a direct id. Reintroducing it needs a deliberate decision about
whether a model entry may name a variant.

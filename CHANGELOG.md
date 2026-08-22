# Changelog

All notable changes to Fadeno are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed — every surface that explains `--parallel` described a mechanism that no longer exists (0.6.0-rc.56)

Four surfaces tell you how `--parallel` obtains concurrency, and all four were wrong, in two directions from two different releases. `fadeno --help` and `fadeno drive --help` said command members "currently SERIALIZE regardless" and named worktree isolation as future work — in the release that ships it. The `fadeno-driver` and `fadeno-runner` skill docs were older still: "read-only members overlap; shared writers stay serialized by the workspace lease", explaining concurrency through `write_access: false`, a declaration deleted in rc.50. Those two are the surfaces an *agent* reads.

`drive.ts` itself was correct throughout, and correctly conditional — its runtime NOTE fires only under `!repoHasGit`, the one case where members still serialize. The truth simply never reached the four places that repeat it.

All four now say the same thing: in a git repo each member runs in its own detached worktree and merges back, so members overlap whatever they write; without git they share the tree and serialize on the repo-wide writer lease.

- **The tripwire pins the named mechanism, not the token.** Presence-pairing could not catch this class — every file still said `--parallel`, they just said something false about it. `every --parallel surface names the mechanism that is actually implemented` requires passages that discuss interleaving to name the worktree and forbids the deleted read-only/shared-writer vocabulary. It found the `fadeno --help` line that a manual sweep had missed.

### Removed — the write-permission system (0.6.0-rc.50)

**Fadeno no longer models write permissions.** It selects an argv and records what ran; enforcement belongs to the vendor flags you can read in the command (`--sandbox`, `--permission-mode`, `--disable-shell`), and containment belongs to isolated worktrees. Every Fadeno-level "permission" was a claim in YAML that nothing checked — and in one day that layer produced four distinct silent-wrong-answer defects. The design record is `docs/experimental/permissions-and-isolation.md`, written before the change and kept as the anti-drift artifact.

- **Gone:** `requires_write` on archetypes, `write_access` and `write_variant` on routes, `--force`/`force_write_posture` on dials, `applyWritePosture`, `explainWriteConflict`, the `shadow_write_posture` refusal, and the write half of `explainPairRoutability`. Net −2,200 lines.
- **The inversion:** routes are argvs, permissive by default. A restriction is now a *separate route with its own name*, visible by reading its command rather than carried in metadata beside it. 21 write-variants were promoted to be their route's own command.
- **Refused, never ignored.** A catalog still carrying any removed key fails to load with `is no longer supported` and a pointer to the design record. Silently dropping a key someone wrote in order to *restrict* something is the failure mode this whole change exists to end.
- **`write_variant` never meant what it said.** It swapped the entire argv, so in the shipped catalog it silently dropped `--sandbox read-only` (xai), `--agent fadeno-readonly` (openrouter), and both `--disable-write` *and* `--disable-shell` (muse) along with granting writes. The posture layer could not see this, because every variant is correctly write-capable once applied.
- **Claude-as-harness is no longer uniquely restricted.** Under `claude`, `anthropic` is a `host: true` route, and host routes were refused a `write_variant` at parse — so the same driver escalated fine under `codex` and `grok` but never under Claude. Its fallback lane now carries the permissive flags directly.
- **Posture is replaced by measurement.** `fadeno bakeoff` compares the two arms' *recorded argvs* and stamps a `capability_skew` confound when they differ beyond model and effort. Observed rather than declared, catches any capability difference rather than only the write bit, and cannot produce a false refusal.
- **Constraint policies get the argv** in place of the `write_access`/`write_variant`/`write_posture` triple — they can now gate on what will actually run, which makes them the one real gate at the Fadeno layer.
- **`fadeno doctor` lints an `archetypes:` policy nothing dials**, which is how a misspelled key (`wroker:`) used to leave the real archetype silently unguarded.

**Consequence, since resolved in this same release — `--parallel` serialized command members.** The lease bypass keyed on a route declaring `write_access: false`, so what actually parallelized was read-only reviewer/judge fan-out; `worker` always took the lease and always serialized. That speedup was paid for by the read-only base argvs this change removes — the parallelism and the posture were one mechanism. See *Isolation, delivered* below for how it comes back.

### Changed — isolation, delivered (0.6.0-rc.52)

The permissions cut made an isolated worktree the default and then never delivered it: an unpaired dispatch degraded straight back to shared, so the request row said `isolated` and the completion row said `shared`. The blocker was recorded as an ambiguity — "isolated" meant both *hold this out of my tree* and *the kernel isolated you, so merge back* — with default isolation a third case needing paired semantics without a pair.

- **Merge-back keys on who asked, not on whether a pair exists.** `--isolate` is a caller saying *hold this out*, and never merges back. Everything else is kernel-chosen and always does. The old predicate was `pendingShadow != null` — a probabilistic sampling roll, and no basis for deciding what happens to someone's work. Under the new split the unpaired case stops being special.
- **Every isolated worktree replays the caller's uncommitted state.** `git worktree add` cuts a clean checkout of HEAD, so without it the executor solves a different problem and its diff then conflicts on work it never saw. Applied to `--isolate` too: a flag documented as "already the default" must not hand the executor a different tree.
- **`ignored_output: kept` now withholds the worktree as well as the pair.** A merge-back is built by `git add -A`, which respects `.gitignore`.
- **`--isolate` outside a git repository refuses** instead of silently running in your tree. Kernel isolation may still degrade — nobody asked for it — but only when it failed *before* the spawn, and only after acquiring the lease it then needs.
- **`shadow-apply --arm primary` refuses on a `clean` primary_merge.** A primary can now carry both a `diff_snapshot` and an applied merge, which could not previously coexist.

**`fadeno drive --parallel n` overlaps command members again**, by a different mechanism than it originally did. Each member runs in its own worktree and merges back at collection, so the concurrency is a fact rather than a claim — and the containment is real, where `write_access: false` was never enforced at all. Where git cannot cut a worktree, members serialize and the engine says so. An engine merge-back that is not `clean` fails the attempt (`merge_back_failed`) rather than merely stamping it, because the next step of a run reads the workspace; the diff artifact is durable and named on the receipt. An interrupted attempt's worktree is retained, not cleaned up — nothing merged it back, so it holds work that exists nowhere else.

### Fixed — four ways a resolve answered a question it could not answer (0.6.0-rc.49)

All four found by the blinded adversarial judge pass on pairs `49a1f92a` and `89536181`, then verified against `main` by measurement before being touched. They share a shape: a surface answering optimistically where it had no basis to answer at all.

- **`dial resolve` no longer recommends a dispatch the kernel forbids.** An `eligibility: forbidden` pairing returned `dispatchable: true` and the action "Dispatch it" — straight into the kernel's own refusal, which has no force branch. Write posture got this guard when the identical defect was found there; eligibility never did. Two of the kernel's four refusal predicates are knowable at resolve time and both are now folded in; `constraint_command` must execute a policy and `provider_distinctness` needs input provenance a resolver never sees, so no field on the resolve object can promise a dispatch will be accepted — and `lane`'s doc no longer claims otherwise.
- **A write posture nothing could check now says so.** `write_access:` is optional, and an undeclared value is `null`, which satisfies *every* posture — so a `requires_write: required` archetype dialed onto such a route passed in silence. It is reported, not refused: refusing would break every catalog that omits the key, and "we never asked" is not "no meaningful delivery exists". `explainUnverifiedWritePosture` warns at `fadeno dial` and at `fadeno dial shadow` (checking both arms, since the primary is the one usually sitting on an undeclared lane), the kernel stamps `write_posture_unverified: true`, and `fadeno bakeoff` raises it as a confound. The cost of the old silence was specific: an arm that could not write returns an empty diff, and judging reads that as *choosing* to change nothing.
- **The flag is TRUE-only, on purpose.** Its absence never asserts a lane was verified — a row written before the flag existed also lacks it. Inferring the confound from a missing `write_access` key instead would have over-claimed on every historical pair, since absence there means "undeclared" on a new row and "predates the field" on an old one.
- **`fadeno doctor` lints an archetype policy nothing dials.** A misspelled `archetypes:` key (`wroker:`) is invisible everywhere else: the posture attaches to an archetype nothing dispatches, and the real one silently has none, so a write-required task runs on a read-only lane and exits 0. It cannot be refused — an archetype with no declared posture is legal — so it is linted.

### Changed — a refused pair now says why, at every surface (0.6.0-rc.48)

- **Refusing a pair stays narrow, and stops being silent.** `explainPairRoutability` refuses a pair when the primary's command lane cannot satisfy the archetype's declared write posture. That refusal is right and is deliberately the only asymmetry that earns one: only the *primary* is moved onto its command lane, while the challenger resolves its own delivery and carries its own posture guard — so running the pair anyway would compare a crippled arm against an uncrippled one and measure the lanes rather than the models. An empty diff from an arm that could not write is not evidence about the model that produced it. What was wrong is that a step this serious happened in silence: a user attached a shadow, was told nothing, and simply never got pairs.
- **`fadeno dial shadow` warns at attach time.** `unroutablePrimaryNote` asked `commandRoutable` alone — "does a lane exist" — so it fired only for a host executor with no `fallback_command` and stayed mute for every write-posture refusal. It now answers with `explainPairRoutability`, the same predicate the resolve previews and the dispatch kernel use, which was the third copy of the question that helper exists to consolidate.
- **`shadow.routable_reason` travels beside `shadow.routable`** in both `dial resolve` and `steering resolve`. The predicate always computed the explanation; both surfaces spread `...routable` alone and dropped it on the floor. `pairRoutabilityFields` now publishes the pair, so the two cannot drift on whether the reason survives, and it is `null` exactly when `routable` is true.
- **The reason no longer offers `--force`.** `explainWriteConflict` takes `includeOverrideAdvice`, and pair context passes `false`: forcing lets the *primary* proceed and cannot make a pair form, so suggesting it there is advice that does nothing. A direct dial keeps the advice, where it is true — a test pins both halves. Reverting any of these fails `test/shadow-write-posture.test.ts`.
- **Fixed two comments that misdescribed the mechanism**, both pointing at `pairCommandFallback`, a symbol that no longer exists: a pair does not confine *both* arms to the primary's lane, only the primary.

*Found by the blinded adversarial judge pass on pair `49a1f92a`, then verified against `main` by measurement rather than by reading.*

### Added — `fadeno bakeoff --evidence explored` (0.6.0-rc.47)

- **The judge can read the code instead of a diff of it.** `--evidence explored` reconstructs each arm's post-work tree from its `baseline_commit` and `diff_snapshot` into `.fadeno/local/judge/<pair-id-8>/arm_a/` and `arm_b/`, writes each arm's diff beside it, and puts PATHS in the prompt. On this repo's pair `49a1f92a` the comparison prompt goes from 54,912 bytes to 10,823 while the judge gets strictly more to look at: a diff shows changed hunks and hides the file they landed in, so "does this fit the code around it?" — the question a reviewer most wants answered — is the one the old prompt structurally could not support. `inlined` remains the default, and is the right trade for a small pair: the prompt file stays a complete record of what was judged.
- **The trees carry the blinded label, and no `.git`.** `arm_a`/`arm_b`, never `primary`/`challenger`: the path is read on the way to every file, so naming a directory after the arm's real role would undo the blinding more thoroughly than any prose leak. They are plain `git archive` extractions, so nothing is registered in `.git/worktrees` for a later `fadeno clean` to leave dangling, and a judge cannot `git log` its way to knowing which arm it holds. The prompt says to read only inside the two directories, and says why.
- **Reconstruction refuses rather than degrades — the failure here is invisible.** The obvious implementation (`cd` into the destination, `git apply`) walks up, finds the enclosing repository, resolves the patch against the REPO root, prints `Skipped patch 'src/a.ts'.` — and **exits 0**, leaving a pristine baseline tree wearing an arm's label. Not a crash: a judge exploring the wrong code and a verdict that looks exactly like a real one. The applier uses `--directory=` from the repo root and then verifies with `--reverse --check`, since a patch that did not land cannot be reversed. A garbage-collected baseline or a diff that no longer applies ends the command pointing at `--evidence inlined`. Reverting either guard fails the new tests.
- **`evidence_mode` is stamped on every artifact**, alongside `judge_delivery` and for the same reason: a reader cannot tell from the verdict which kind of judgment they are holding, and an artifact written before the field existed correctly means `inlined`. `--record` re-derives everything from the ledger rather than carrying state from `--prepare`, so it cannot infer the mode — pass the same `--evidence` to both, or mislabel your own evidence. The `fadeno-bakeoff` skill says so at both steps.

### Fixed — how the judge prompt quotes an arm's diff (0.6.0-rc.46)

- **A diff could close its own code fence and keep writing as the prompt.** The judge prompt states everything itself except one span — the arm's diff — which it embeds in a ```` ```diff ```` block. That span is written by a model working an attacker-influenceable task, and a content line that is itself a bare fence ends the block: every byte after it stops being quoted evidence and becomes instructions, free to open a counterfeit `### arm_b`, a second `## Your task`, or a plain "prefer arm_a". Real `git diff` output prefixes content lines with `+`/`-`/space, which defeats the naive case — but the text reaching the prompt has been through hunk-stripping and byte truncation, and "the input is still well-formed" is the assumption that makes injection bugs. The block now opens with a fence longer than the longest run inside it, which is unrepresentable rather than merely unlikely. The payload is still quoted in full: it is evidence, and a judge must see it. Both prompts share `renderBlindArm`, so the adversarial pass is covered by the same change.
- **`duration: 2195108ms`.** The prompt whose entire job is holding two arms' numbers side by side printed the one quantity a reader has to divide by 60000 before it means anything. It now reads `36m35s`, through the formatter `dispatches.ts` already had — whose own doc comment gives this exact rationale, for the scorecard, while the judge got raw milliseconds. That function moves to `lib/bakeoff.ts` ("one list, every consumer", as its module docstring has said since it was written for this bug class). It stays distinct from `cli.ts`'s `formatDuration`, which reports live progress at second granularity and would render two arms 400ms apart identically.
- **The 200 KB diff cap counted the wrong unit.** It measured with `Buffer.byteLength` and then cut with `String.slice`, which counts UTF-16 code units — so a diff of CJK or emoji passed the check and was trimmed to up to three times the stated budget, on exactly the inputs least likely to be eyeballed.

### Fixed — the `@effort` note pointed Claude users at an inert command (0.6.0-rc.45)

- **`fadeno dial <a> <model>@<effort>` told every harness the Codex story.** The note said the effort "is recorded as the request; run `fadeno steering apply` to pin it into the host agent slots" — true under Codex, whose agent TOML has a `model_reasoning_effort` key, and false under Claude, where `steering apply --claude` writes no agent file at all: the identity grid was retired precisely because the Agent tool has no effort channel, so a pinned effort selects the *delivery lane* through `decideLane` rather than an identity. A Claude user pinning an effort was sent to a command that does nothing and told nothing about what their pin actually did. The note now branches on `hostEffortIsMaterializable`, which sits beside `RELAY_HARNESSES` in `executors.ts` and is pinned to observed behaviour by a test that runs both applies and reads the filesystem — a test that merely restated the predicate would have passed the whole time. `fadeno steering --help` carried the same stale claim and is corrected with it.
- **A pin that strands a write-required archetype now says so at set time.** Pinning a cheaper effort on a host dial moves the archetype onto its route's `fallback_command`, and on the shipped `claude→anthropic` route that lane is `write_access: false` and cannot be given a `write_variant`. `fadeno dial worker sonnet@medium` therefore leaves `worker` with no deliverable lane — previously discovered only when a dispatch was refused, several steps later. The dial that created the dead end is where it is reported.
- **The third case is named too.** A host route with no command lane at all (`current-host`, the base dial) has nowhere to divert to, so the pin is simply inert and the archetype runs in-session at the session's own effort. Silence there read as "recorded", which is what the old note claimed.

### Fixed — dispatch advice that the dispatch itself refuses (0.6.0-rc.44)

- **`dial resolve` told callers to run a command this same binary rejects.** Relaxing the delivery gate in rc.42 left `deliveryGuidance` asking only `commandRoutable(spec)` — does a lane *exist* — while the kernel additionally asks whether that lane can satisfy the archetype's write posture. The two answers part on a shape a user reaches by accident: pinning an effort the session cannot give (`fadeno dial worker sonnet@medium`) ejects a host dial onto its route's `fallback_command`, and that lane is `write_access: false` with no `write_variant` available, because a host route may not declare one. The resolution advertised `dispatchable: true` with `"Dispatch it: fadeno dispatch --archetype worker"`; running exactly that returned the `requires_write: required` refusal. Guidance now takes the kernel's own `explainWriteConflict` verdict — computed at the call site under the same `--force` guard `steering resolve` uses — and reports `dispatchable: false` with the refusal verbatim rather than a reworded near-copy that would drift again. A new end-to-end test asserts the advice and the kernel agree on both answers, by running both CLIs rather than the shared helper, since a unit test would pass even if the resolve path stopped calling it.

### Fixed — host-lane dispatch guidance, and `--via` on `dispatch` (0.6.0-rc.43)

- **A refusal that argued for the wrong remedy.** When `decideLane` has already chosen the host lane for an archetype — which it does for every unpinned dial in a Claude session — `fadeno dispatch` refusing on write posture told the caller the in-session agent was "NOT an equivalent substitute" and led with `fadeno dial <archetype> <model> --via <driver>`. That ordering is right for a genuinely command-lane archetype and backwards here: in-session is not a downgrade, it is the delivery the resolver chose and the one every spawn through the hook already gets. An agent following the advice re-dials a host-lane archetype onto an exec route and moves it out of the session permanently. Every refusal and the delivering path's echo now lead with the lane the resolver picked, name the in-session agent as that choice, and demote the escalation. The kernel still does not *route* on the lane, deliberately: `fadeno bakeoff` dispatches two judges, and a judge is host-lane under Claude with the default dial, so refusing host-lane archetypes outright would break a first-class caller.
- **`--via` on `fadeno dispatch` was parsed and dropped.** It was read only inside the `--model` branch, so `fadeno dispatch --archetype worker --via claude-exec` accepted the flag, ignored it, and delivered on the dial's own route — while `--help` advertised it as `(dial/dispatch)`. It now applies to the resolved dial, escalating a single call onto another driver without moving the dial. This is also the lever the new guidance points at, so a no-op would have made that advice unfollowable.


### Changed — the dial lane: `--via claude`, a `via` column, and one delivery gate (0.6.0-rc.42)

- **`fadeno dispatch` no longer refuses a host dial that has a command lane.** A host route with a `fallback_command` is dispatched down it under every harness. Until now a second predicate, `dispatchability(spec, harness)`, refused exactly that shape with `host_in_session` whenever the caller sat inside `claude`, on the theory that shelling out to `claude -p …` re-enters the dispatch one level down — while permitting the identically-shaped `codex exec …` fallback under `codex`, and while the catalog's own `anthropic-exec` route spawns that same subprocess on purpose. It was a coin-flip on which agent you happened to be running in, not a safety property, and `docs/extending.md` and `loadouts-and-dispatch.md` had documented the relaxed behaviour all along. On 2026-08-21 a coordinator hit the refusal, spawned an in-session subagent instead, and reported it as "equivalent role, no recursion" — under instructions to read the result back by dispatch id, which by then could not exist. `dispatchability` and `IN_SESSION_ONLY_HOST_HARNESSES` are gone; the relaxed predicate is literally `commandRoutable(spec)`, which already existed for the shadow-pair path, so the kernel, both resolve previews, and `explainPairRoutability` now share one function with no harness argument to branch on. The pair path's `pairCommandFallback` carve-out is gone with it — a pair no longer needs an exception to a rule that no longer exists.
- **What refuses instead is the honest refusal.** A host spec with no `fallback_command` (the `current-host` base dial) still has nothing to invoke. A lane that cannot satisfy the archetype's declared write posture is refused by `explainWriteConflict` — the guard the delivery gate was standing in front of and getting credit for — and that message now branches on the adapter: it no longer tells a host route to "declare a `write_variant`", a key host routes reject at parse, and instead names `fadeno dial <archetype> <model> --via <driver>` with the `*-exec` hint. A read-only `reviewer` or `judge` on a host route is not refused at all, which is the case the gate was costing.
- **Driver `claude-cli` is now `claude`.** Nobody dials a "cli", and the suffix made `--via claude-cli` look like a different tool from the `claude` on their PATH. Driver names and harness names share spellings on purpose and are not the same namespace — under `routes.codex.anthropic` the driver is `claude` and the harness is `codex` — which the catalog now says where the routes are declared. A stale `via: claude-cli` pin degrades to a stale-dial warning in `fadeno dial` and an `unknown driver` error that lists the declared aliases; re-dial with `--via claude`.
- **The dial and models tables head that column `via`, not `harness`.** It never held a harness: it holds the driver, the value `--via` sets, while `harness` in the same command's `--json` means the agent you are sitting inside — two meanings, one word, printed a column apart. `fadeno dial` now reads back the flag that set it (`--via claude-exec` → `via  claude-exec`), and the inherited-dial marker that printed `(via worker)` — an *archetype*, not a driver — prints `(inherits worker)`. In JSON the three synonyms for one value collapse to one: `EffectiveRow`/`DialSetResult` keep `driver` and drop `harness` and `delivery`; `ModelRow` keeps `driver` and renames `harness` → `home_via`, dropping `delivery`. **Breaking for `--json` consumers of `fadeno dial` and `fadeno models`.**
- **Two rename leftovers swept.** `fadeno --help` labelled six bakeoff flags `(compare)`, a command that no longer exists, and `loadouts-and-dispatch.md` still pointed `fadeno dispatches --bakeoffs` at `.fadeno/comparisons/*.md` (`kind: ModelComparison`). The roadmap still listed the deleted `model-tryout` starter as shipping.


### Fixed — locked host dispatches for `reviewer` and `judge` (0.6.0-rc.41)

- **`steering resolve` refused every locked host dispatch whose archetype has default posture.** `archetypes:` in a catalog is a *policy overlay* — an archetype earns an entry only by having something non-default to say — so the builtin declares `worker`, `director` and `generator` and stays silent about `reviewer` and `judge`. The locked resolver read that map as the set of archetypes that exist and rejected them as "undeclared archetype", pushing a managed Codex reviewer or judge agent that correctly consulted steering onto the command lane with `host_attested: false` and `identity_evidence: command_receipt`. The check is now wildcard-only (a concrete `agent_type` is already settled by the equality check preceding it) and asks `knownArchetypes()` — the role triad plus every declared or dialed name — which `dial.ts` had open-coded twice with the triad hardcoded. The refusal message now says "unknown archetype", since an undeclared one is legitimate and `fallback:` to one has always been allowed.


### Added — symmetric shadow pairs, trustworthy isolation, and measured host identity (0.6.0-rc.34)

- **A pair's arms are now actually comparable.** `commandRoutable()` is one predicate shared by `dial resolve`, `steering resolve`, and the kernel's `pairCommandFallback`, so a selected pair whose primary has no command lane degrades to no pair instead of routing a spawn the kernel then refuses (which failed the task outright). Each challenger worktree receives the primary's pre-spawn state as a committed `baseline_commit` shared by both arms, captured without touching the primary's index. `worktree_carry:` (project-scope, parse-validated) carries declared gitignored build state by reflink → hardlink → full copy — never a directory symlink, which shares the namespace and lets even a rename-based write land in the primary's real files — recording the mechanism per path, and applies to `--isolate` as well as shadows. A prompt naming absolute repo paths refuses the pair (`shadow_containment`), because byte-identical prompts plus differing cwd would otherwise send the challenger into the primary's workspace. `shadow_baseline`, `shadow_carry`, and `shadow_containment` all write refusal rows and leave the primary untouched.
- **Pair-aware steering on every harness.** `fadeno steering resolve` gains `--prompt-file`/`--prompt-sha256` and answers `shadow.selected`/`shadow.routable`, routing a selected routable pair to the command lane exactly as the Claude hook does; host-spawn shadowing is no longer Claude-only. All three Codex agent surfaces write the prompt file before resolving, since the resolver must see the bytes to answer at all. Fixes Codex bootstrap agents that instructed `--host-executor native-worker`, a name that has not existed since dials replaced named executors, and that therefore dead-stopped on every ordinary task.
- **`fadeno shadow-apply <pair-id|dispatch-id> [--arm challenger|primary] [--check]`.** Conflict-aware port-back via `git apply --3way`; stops and keeps the diff artifact rather than auto-resolving. `--check` parses git's message text because `git apply --check --3way` exits 0 on a patch that would conflict.
- **`fadeno attest --archetype <a>`.** Run from inside a subagent, it measures the one identity component that is observable — `CLAUDE_EFFORT`, already resolved past any silent downgrade — and records `identity_evidence: requested_only` for the model rather than asking a model to name itself. `fadeno dispatches` renders both an unattested host delivery and an effort that disagrees with its dial.
- **The reader now reads what the ledger writes.** `pair_id`, `workspace`, and `baseline_commit` parse into `DispatchEntry`; the comparison view reports the primary's own diff, pairs on `pair_id`, and renders a refused challenger as refused rather than as a row of `?`. `fadeno clean` deregisters retained shadow worktrees before deleting them instead of orphaning their git registrations. `fadeno doctor` reports legacy per-dial managed agents that silently override their dial.

### Added — repo-wide writer leasing, harness heartbeat, isolated delivery, and reference-frame-neutral current-host (0.6.0-rc.33)

- **Repo-wide writer lease (`.fadeno/local/workspace-lease.json`).** Machine-local, never ledger evidence, `workspace_mode` is `shared` or `isolated`. A live `shared` writer blocks every other shared write-capable `fadeno dispatch`, `fadeno drive`, and host dispatch, including peers in the same run (read-only and `isolated` deliveries bypass). Logical host fan-out is serialized until each writer records its terminal receipt; legacy multi-holder records remain readable and require exact-member release. The record carries `supervisor_pid`, `executor_pid`, `process_group_id`, `started_at`, `heartbeat_at`, `last_output_at`, `stdout_bytes`, `stderr_bytes`, and `workspace_mode`. Stale leases with a dead supervisor pid are reclaimable; PID-less host reservations remain conservatively live until `dispatch-complete` or `dispatch-fail`, so optional progress observations never weaken exclusivity. If the run ledger itself cannot record a terminal recovery, the documented last-resort escape hatch is `rm .fadeno/local/workspace-lease.json` after verifying no writer remains.

- **`fadeno dispatch --isolate` (opt-in detached worktree delivery).** Executes in a worktree cut from `HEAD` before the primary runs (`git worktree add --detach .fadeno/local/isolated/<id>`), preserves a binary-safe diff artifact at `.fadeno/local/outputs/isolated-<id>.diff` (`diff_snapshot`/`diff_bytes` in evidence, does not merge automatically, `workspace_changed` omitted), and bypasses the shared-writer lease because it cannot mutate the shared worktree. Conflicts with `--shadow` (refused).

- **`fadeno dispatch-prompt <run> <dispatch-id>` (canonical envelope).** Emits the exact `# Fadeno engine step assignment` envelope with immutable `run`/`dispatch_id` and the recorded prompt bytes, sha256-authenticated with traversal/symlink guards. Replaces manual envelope reconstruction in the driver skill; `README.md` now sells it as the canonical path.

- **Engine-first `fadeno new-run` guidance.** Output now recommends `fadeno drive <run>` first (`Advance it with fadeno drive first (engine):`) with the literal `first`, then the manual `fadeno next`/`fadeno run` fallback. Same ordering is documented in `src/cli.ts` help.

- **`fadeno dispatch-complete --output -` (stdin host completion).** Reads artifact bytes from stdin (`readFileSync(0)`, binary-safe, test seam `stdinBytes`) and uses the same validation, atomic `artifacts/attempts` vs `outputPath` placement, manifest, and receipt path as a temporary file.

- **Structured wildcard specialization (`requested_agent_type` / `delivered_archetype`).** Locked steering (`--run --dispatch-id`) for `agent_type: "*"` now reports `requested_agent_type: "*"` and `delivered_archetype: <concrete>` (the concrete archetype being delivered) without upgrading `identity_evidence` beyond `requested_only`. Because the host agent is already assigned, that wildcard claim may specialize to a declared compatible archetype such as `director` without requiring a second materialized host-agent surface; concrete requests retain the ordinary surface check. `fadeno steering resolve --json`, the committed plugin bundle, and `src/commands/steering.ts` carry the behavior; host start receipts remain `requested_only`.

- **`fadeno show` harness-observed process facts.** `fadeno show` now labels machine-local process facts as `harness-observed` and semantic progress as `agent|harness|director-attested`, both `gating: non-gating` (never controls gates). `src/lib/supervisor.ts` is the sole atomic claim writer after startup: it heartbeats `heartbeat_at`, forwards exact output buffers, and updates byte/activity counters. `src/commands/show.ts` projects the repo-wide lease (including every member of a legacy record), per-dispatch inflight claims, and terminal supervisor status.

- **`fadeno cancel <run>` — safe engine-attempt cancellation.** Targets the single correlated live engine command claim for the resolved run (`engine-<runId>-<actorCallId>-a<attempt>.json`), sends `SIGTERM` to the supervisor PID, or the negative executor process-group ID when the supervisor is proven dead (`ESRCH`), or the executor PID as final fallback. Never writes the run ledger — the active engine remains the sole ledger writer and records the terminal `actor_failed` receipt. Refuses with a clear `CancelError` when there are zero or multiple live correlated claims rather than guessing. Preserves the workspace lease and inflight claim until child-group termination is proven (`close`), never at signal-send time. Returns `{run, actorCallId, attempt, supervisorPid, processGroupId, signalledPid, resolvedBy: "supervisor" | "process_group" | "executor"}`. CLI rendering reports `resolved_by` and the reaped group. See `src/commands/cancel.ts`, `src/cli.ts` `COMMAND_HELP['cancel']`.

- **Supervisor-owned executor hard deadlines with TERM→KILL escalation.** Route YAML key `timeout_ms` (positive integer milliseconds, absent by default) is parsed at both catalog and snapshot trust boundaries and rejected on `host: true` routes. The committed built-in command routes set `timeout_ms: 1200000` (20 minutes). The supervisor owns the deadline: at `deadline_at = started_at + timeout_ms` it sends `SIGTERM` to the executor process group and escalates to `SIGKILL` after the existing 5-second grace (`KILL_GRACE_MS`). Lease and claim release still waits for `close`, so cancellation and timeout are similarly proven only after the group is gone. CLI override `--timeout <seconds>` on `fadeno drive` and `fadeno dispatch` (internal `timeoutMs`) overrides the snapshotted route value; `0` disables the route deadline; empty or non-integer values are rejected. New status fields `timed_out: boolean`, `timeout_ms: number | null`, `deadline_at: string | null` are always reported; `readSupervisorStatus` coerces missing/invalid to `false`/`null`.

- **Distinct timeout receipts.** `actor_failed.reason = "executor_timeout"` with `timeout_ms` and `deadline_at` (plus preserved `signal`/`exit_code` facts) is distinct from `engine_interrupted`, `exit_nonzero`, and ordinary signals. Ad-hoc evidence `dispatch_completed.outcome = "timeout"` carries the same `timeout_ms`/`deadline_at`. Status-file timeout facts (`timed_out`) outrank the supervisor process exit signal when classifying a receipt; wall-time is never inferred. Re-running drive may retry with `user_retry`.

- **Non-gating idle-output warnings in `fadeno show`.** `OUTPUT_IDLE_WARNING_MS = 300000` (five minutes). `HarnessObservedProcessView.outputIdleWarning` becomes true when a process is `alive` and has emitted no output for five minutes (since start when `last_output_at` is null, else since `last_output_at`). `src/cli.ts` renders `WARNING: no output observed for <duration> (non-gating)` per harness-observed fact (`outputAgeMs ?? runtimeMs`). Idle warnings never signal, gate, or alter deadlines — output silence alone never terminates work.

- **Adversarial process-group and ledger-verification coverage.** New and extended tests verify supervisor `SIGTERM`→`SIGKILL` escalation, lease/claim preserved until `close`, process-group `kill(-pgid)` determinism, wall-time not inferred for timeout, and output-silence-never-kills. See `test/supervisor-timeout.test.ts`, `test/cancel.test.ts`, `test/show-timeout-observability.test.ts`, and the new `test/cancel-timeout-integration.test.ts`.

- **Reference-frame-neutral `current-host` locked steering.** An immutable host request with `executor: current-host` and `agent_type: "*"` is already assigned to a concrete host agent; `fadeno steering resolve --archetype <concrete> --run <run> --dispatch-id <id>` now resolves `mode: host` even when the caller has no `--host-executor` marker. Reports `requested_agent_type: "*"`, `delivered_archetype`, and `identity_evidence: requested_only` (never upgraded), retains declared-archetype/`eligibilityFor === 'forbidden'`/`explainWriteConflict`/`requested_identity`/terminal-receipt checks via `decorateSteering(..., requestedAgentType === '*')`. Exports `NEUTRAL_HOST_EXECUTOR = 'current-host'` and `isReferenceFrameNeutralHostRequest(request, spec)` (true iff `request.executor === 'current-host' && request.agentType === '*' && spec.adapter === 'host' && spec.agentType === '*' && spec.model === 'current-host'`), mode line `matchesHost || neutral ? 'host' : hasFallback ? 'command' : 'restart_required'`, new detail string `host request <id> is locked to the reference-frame-neutral executor current-host; execute in-host` only on `!matchesHost && neutral`. Concrete host executors (`luna`/`opus`…) and concrete `agent_type` values remain strict.

- **Opt-in isolated host workspace (`fadeno dispatch-prepare --isolate`).** Pre-spawn for a pending nonterminal host request that has not started: creates an idempotent detached worktree from `HEAD` at `.fadeno/local/host-worktrees/<run>/<dispatch-id>` (guarded against traversal/symlink escape), atomically records `workspace_mode: isolated` state at `.fadeno/local/host-workspaces/<run>/<dispatch-id>.json` (`schema_version: 1.0`, `run`, `dispatch_id`, `workspace` repo-relative, `base_commit` 40-hex, `prepared_at` ISO, plus `diff_snapshot`/`diff_bytes`/`finalized_at` after collection), serialized by `.fadeno/local/.host-workspace.lock` (`WORKSPACE_LEASE_LOCK_STALE_MS`). `dispatch-prompt` then includes `workspace_mode: isolated` plus absolute workspace path and instruction `All repository reads and writes for this assignment must occur in the workspace above; do not read or modify the shared checkout.` (prompt bytes and `prompt_sha256` unchanged, header not hashed, not ledger-written). `dispatch-start` discovers prepared state, stamps `workspace_mode: isolated`/`workspace`/`base_commit` on `actor_dispatched`, enforces `--workspace` match and rejects `command-fallback` with prepared isolated workspace, bypasses shared writer lease (read-only `writeAccess === false` also bypasses), and checks idempotent re-start `workspace_mode` equality; `dispatch-complete`/`dispatch-fail` collect a binary staged diff (`git add -A` → `git diff --binary --cached`) atomically at `.fadeno/local/outputs/host-isolated-<run>-<dispatch-id>.diff` before the terminal receipt, stamp `workspace_mode`/`workspace`/`base_commit` plus `diff_snapshot`/`diff_bytes` only when a diff was actually collected from the proven registered worktree, proving the worktree is the registered linked worktree before any `git add`/`diff` or removal. The worktree is removed only after durable append and only when proven registered (idempotent terminals reuse receipt and retry cleanup only when verified). `dispatch-fail` degrades to a terminal receipt without diff keys whenever the isolated evidence is absent, unverifiable, or unrecoverable — including a missing or malformed machine-local state file — and records `diff_snapshot`/`diff_bytes` only when a diff was actually collected from the proven registered worktree; a collection failure while the machine-local state is present still refuses, preserving the worktree for retry; `dispatch-complete` may recover and collect from a verified ledger-named worktree when the state file vanished, but still refuses success when evidence cannot be collected. Neither command stages or removes a directory it has not proven to be this dispatch's registered worktree, and nothing is ever auto-merged. `HostRequestView` on `fadeno show` projects ledger-first `workspaceMode`/`workspace`/`baseCommit`/`diffSnapshot`/`diffBytes` (prepared-but-not-started degrades to isolated via machine-local read, missing state → `shared`/null, never throws, non-gating); `verify` never requires machine-local state.

### Changed — dials replace named loadout presets (0.6.0, `docs/experimental/dials-and-registry.md`)

- **Named loadouts retired; per-archetype dials via a layered cascade.** `loadouts:`,
  `default_loadout:`, `targets:`, `--loadout` / `FADENO_LOADOUT`, `fadeno use`,
  `fadeno targets`, and the `targets` concept are removed. Catalogs now carry
  `schema_version: 3` with a uniform `models:` registry (`provider` + `id` +
  standard `effort`, `spellings:` per driver) and `routes:` rows gain `driver:`,
  `models_command:`, and `effort_encoding:`. The selection surface is
  `fadeno dial <archetype> <model>[@effort] [--via <driver>] [--user|--repo]`
  / `clear` / `shadow` / `clear-shadow` / `resolve` (verb-first; `fadeno loadout` removed) and the effective table `fadeno dial` (no args) with
  `dial_source` / `resolved_via` per row. The cascade is
  `binding → session dial → repo pin → user dial → base` (`base` = `current-host`,
  now a built-in dialable model). Unregistered model ids route via
  `unregistered_model_driver` (default `opencode`) with dial-time backend
  verification (`models_command` probe, positives cached in
  `$FADENO_STATE_HOME/model-verifications.json`, fail-open). Dispatch rows are
  format `1.0` with re-spelled identity fields
  (`model`/`model_id`/`effort`/`driver`/`dial`/`dial_source`); `0.2` rows
  remain readable as `[legacy]`. Old pins (`.fadeno/local/loadout` with
  `{loadout,…}`) are ignored with a one-line note ("pre-0.6 loadout pin
  ignored — re-dial with `fadeno dial worker <model>`"); v2 catalogs error with a
  migration note. **Breaking (post-0.6 hardening, no compat):** v3-only catalogs (`schema_version 3` required) and `snapshot_version: 3` snapshots — `fadeno verify` refuses pre-dials ledgers with `pre-dials run snapshot — this fadeno verifies snapshot_version 3 ledgers only; verify with fadeno <= 0.6.0-rc.27`; `fadeno dial` is verb-first and `--executor` is removed; pin is `.fadeno/local/dials`; driver aliases are `openai→codex`, `anthropic→claude`, `xai→grok` (plus `google→agy`, `openrouter→opencode`); `ConstraintContext.transport` is now `host`. The dispatches reader still renders legacy rows as history.

- **Deterministic `tool_call` execution (`fadeno tool-run` + shared core).** Strict `tools:` registry in `.fadeno/executors.yaml` (static argv, `timeout`/`timeout_ms`, layered and snapshotted), `fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]` as a thin `tool-exec` adapter (registered `test-result` only; `Diff`/`PostResult` remain manual via `tool-complete`), `fadeno drive` auto-executes registered tools inline. Core in `src/lib/tool-exec.ts`: `readdirSync` live-claim scan (ESM `require` fixed, narrow `ENOENT` vs hard error), post-claim ledger re-read to close stale-attempt sequential double-execution, **exclusive attempt ownership from pre-spawn admission to terminal receipt** — a pid-less pre-spawn lease reservation (like the engine and host paths, so a kernel that dies before the supervisor publishes executor/group identity cannot fail the record open), an `owner_pid` on the in-flight claim, and a supervisor that hands claim *and* lease back to a live polling owner at child close instead of dropping them before synthesis, placement and attribution (it still releases both itself the moment that owner is gone); recovery leaves any live attempt entirely alone, so locked admission is the single authority that refuses one; placement + validation + `artifact_created` + `tool_completed` run in one re-entrant run-lock critical section, and a terminal receipt that already exists parks its attempt's evidence instead of writing a second one; generation-scoped `step_started` after the claim and lease refusals and before `tool_dispatched` (corrupt ledger aborts, never defaults `attempt 1`), `tool_dispatched` appended by the canonical `LedgerWriter` (legacy-ledger gate kept, admission still one atomic check-then-append), exclusive `linkSync` placement (never clobbering `rename`) preserving winner bytes when a manual attribution races the helper, `toolGenerationFromStep` and deliberation comments removed, final-object validation (validated bytes == placed bytes, `details_path` either attested via `artifact_created` or not exposed), and crash-safe attribution preserving an already-`artifact_created` file when `tool_completed` fails. Shared audited recovery `recoverInterruptedToolDispatchesShared` for both `drive` and helper (engine + tool holders, `workspace_lease_recovered`/`reclaim_denied` auditing). `fadeno show` and `fadeno cancel` now include `tool-*` claims with run-scoped visibility and `ESRCH` process-group cancellation. CLI `--timeout` overrides registry, `--timeout 0` disables, bounded `summary` (4000 B) / `details` (32 KiB) / `SPAWN_MAX_BUFFER` (32 MiB) / `stderr` tail (400 B) truncation preserving observed `exit 0`/`failed`/`error` semantics. New `tool-result-coherence`, `tool-command-digest`, and `tool-lifecycle` verify checks; binding-mismatch test reaches binding comparison (not just snapshot-digest). Docs: `roadmap` shipped CLI/executable primitives, `architecture` command/library table, `extending` tool-binding recipe, `CHANGELOG`, and `docs-claims` tripwires for `tool-run`, `tools:`, tool lifecycle events, and verify check names. Tests are hermetic with real `TestContext` cleanup.

- **`run.yaml` is published atomically, and opening a generation is a locked decision.** Every writer reads `run.yaml` to gate on `schema_version`, so rewriting it in place was observable mid-truncation: a concurrent helper could read the empty prefix and refuse a current ledger as `is a legacy ledger (run.yaml has no schema_version)`, or parse it as null and die setting `current_step`. `writeRunDocument` (`src/lib/run-ledger-write.ts`) now serializes to a sibling temp file and places it by `rename`, so every reader sees the whole previous document or the whole next one; `fadeno new-run` and `fadeno run` share it, and the modeline lives in one place. `withRunLock` is re-entrant within a process (everything under it is synchronous, so a nested acquisition is the same call stack), which lets `ensureStepStarted` make the scope decision *and* append inside the same critical section admission uses — two helpers racing one generation now produce exactly one `step_started`, not two shifted invocation numbers.

- **Route write variants: capability picked by archetype policy, not model
  spelling.** A route declared `write_access: false` may declare
  `write_variant: { command: [...], resume?: [...] }` — an alternative argv
  that can write (e.g. headless claude with `--permission-mode acceptEdits`).
  A `requires_write: required` archetype resolving onto the route gets the
  variant automatically at every delivery boundary (dispatch, drive,
  steering, dial show/resolve); every other posture gets the read-only base.
  `fadeno dial worker opus` now works against a read-only anthropic route
  with a declared variant, while reviewer/judge dials of the same model stay
  physically read-only. The compiled variant travels in the run snapshot
  (replays posture identically), evidence rows gain `write_variant: true`,
  and the reader marks `[write variant]`. Command-delivery only: `host: true`
  routes refuse the key at parse (in-session permissions are the host's; the
  locked fallback lane replays the snapshotted base argv). Also parse errors:
  `write_variant` on a route that is not `write_access: false`, a variant argv
  identical to the base, and variant session fields that would violate the
  `resume ⟺ id source` invariant after posturing. New `director` archetype
  (canon starter catalog, `requires_write: required`): high-level
  planning/orchestration handed to a usually-cheaper model that coordinates
  workers/reviewers itself via the fadeno CLI. Its claude lane is the new
  `anthropic-exec` route (`--via claude-exec`, declared in every harness
  family): a command delivery for claude models whose write variant grants
  `--permission-mode acceptEdits` plus a scoped `--allowedTools
  "Bash(fadeno:*)"` — can edit and run fadeno, nothing wider. Under the
  claude harness this is also the first command lane for claude models at
  all (the plain route is in-session), so an expensive host session can
  dispatch a whole side task to a cheaper headless claude:
  `fadeno dial director opus --via claude-exec`. New `fadeno models`
  inspection surface (closes design open question 3): the registry table
  under the active harness with per-row delivery, `+write`/`+fadeno` lane
  marks, and the dial-time probe cache as a `verified` column;
  `fadeno models <name>` adds `--via` lanes, spellings, and eligibility;
  `fadeno models --driver <alias>` runs the route's `models_command` for a
  live backend listing with registered spellings marked. Director packaging:
  archetypes may declare `brief: <name>` — a template
  (`.fadeno/briefs/<name>.md`, falling back to the builtin) composed ahead of
  every ad-hoc dispatch of that archetype, recorded as `brief` in evidence
  with the digest attesting the composed bytes (`--no-brief` opts out); the
  starter director declares `brief: director`, whose builtin template
  teaches the spawned model to coordinate through fadeno instead of doing
  the work itself. Routes gained per-archetype `eligibility:` (merged with
  model eligibility, strictest wins) — the structural spelling of "this lane
  cannot host a director": grok/agy/opencode routes, plan routes, and the
  non-fadeno-granted claude lanes declare `eligibility: { director:
  forbidden }`, which also binds unregistered models falling through them. A
  new `fadeno:dispatch-director` proxy agent hands a whole side task to the
  dialed director, and the Claude steering hook routes `director`-named
  spawns like the triad. Effort is the model's property everywhere ("host
  delivery inherits effort" retired): `@effort` dials on host deliveries are
  no longer refused (the pin travels on the request, with a note), the dial
  table and steering resolve show the real effort instead of
  `inherit`/`inherited`, and `fadeno steering apply --claude` materializes
  host-dialed slots as local Claude subagents
  (`.claude/agents/<archetype>.md` with `model:` + `effort:` frontmatter) so
  an in-session model runs at its own effort rather than the session's —
  the symmetric of the codex TOML materialization, with managed-file
  markers, stale-slot removal, and unmanaged files preserved. Starter
  registry retuned: luna/terra/opus/sonnet/grok to xhigh standard, gemini →
  `gemini-3.7-flash` @ xhigh, and `muse` registered (routeless builtin — the
  name resolves everywhere, delivers only where a catalog declares its
  route). Muse Code is now a first-class driver (`muse-code`, all harness
  families, verified live): Muse reads prompts only from a regular file
  (/dev/stdin, bare stdin, and `-` all refused), so routes gained a
  `{prompt_file}` argv placeholder — substituted at spawn with the kernel's
  attested prompt-snapshot path (dispatch primary + shadow, drive actors,
  and the locked host fallback), so the digest attests exactly the bytes the
  executor reads; evidence records the substituted argv. Also fixed: a
  briefed `--prompt-file` dispatch now snapshots the composed bytes it
  actually sends, not the caller's original file. Archetype listings
  (`fadeno dial` table, status roles) follow the canon power order —
  director, judge, reviewer, generator, worker — with non-canon archetypes
  alphabetical after. Generator is a standalone archetype: its `fallback:
  worker` is gone, so undialed it resolves to the host-native base like any
  other (the fallback mechanism itself remains for custom archetypes). Plain
  `fadeno dial clear` (no archetype) now wipes ALL session and user dials —
  narrated per layer — leaving committed repo pins standing with a pointer
  to `clear <archetype> --repo`. Multi-archetype set: `fadeno dial` accepts
  several archetypes for one model — space, `+`, or `,` separated
  (`dial judge reviewer sol`, `dial worker+generator muse`,
  `dial worker,reviewer grok`) — validated atomically: one refused archetype
  refuses the whole command and nothing is written. Per-subcommand
  help: `fadeno <command> --help` now prints focused usage for the major
  commands. `fadeno dial clear <archetype>` now follows the dial when the
  layer is unambiguous: with no session dial and no repo pin it clears the
  user default (narrated `[user default — the only layer holding a dial]`)
  instead of demanding a retype with `--user`; a repo pin still blocks the
  inference (committed config, explicit `--repo` only).

- **Shadows run concurrently with their primary.** The challenger is now
  resolved, rate-rolled, worktree-cut, and spawned *before* the primary runs,
  and collected after the primary's completion row is written — previously the
  entire shadow flow ran only after the primary finished, purely as an
  artifact of the kernel's synchronous spawn chain. Three consequences, all
  deliberate: dispatch latency with a live shadow is max(primary, shadow)
  instead of their sum; the worktree is cut from HEAD before the primary can
  move it, so both sides start from identical committed state (a primary that
  commits can no longer contaminate the comparison); and each side's
  `duration_ms` is its own runtime — measured by its supervisor at exit, never
  by when the blocked kernel got around to collecting — so time-to-complete is
  itself comparison evidence, and `fadeno dispatches --comparisons` now prints
  it per side (`exit 0 in 183ms … vs … exit 0 in 1.3s`). Mechanically, the
  shadow runs under its own supervisor (same reaping guarantees as the
  primary; a killed kernel orphans neither side) with a new third supervisor
  argv slot naming a status file the supervisor writes atomically at exit
  (`exit_code`/`signal`/`spawn_failed`/`duration_ms`) — the kernel's event
  loop never turns while either side runs, so the exit report must be a file
  it can poll for, with a zombie-aware liveness probe so a reportless
  supervisor death cannot hang the kernel. The prompt reaches the shadow as an
  fd on the attested snapshot (the kernel can pump no stdin while blocked in
  the primary's spawn), and the shadow now publishes an in-flight claim, so a
  long-running challenger is cancellable by its own id. Ledger order becomes
  request-before-spawn on both sides — `pReq, sReq, pComp, sComp` — and
  `completed − requested == duration_ms` still holds per side. Unchanged: a
  refused primary fires no shadow, a shadow failure can never affect the
  primary's result, and shadow refusal rows keep their predicates.

The engine slices of the next protocol (capabilities 1, 2, 4 + 5 of
`docs/experimental/next-protocol.md`, plus the explicit supersede event and
native host dispatch): Fadeno gains a small deterministic, repo-local engine.
Native dispatch advances the run ledger to format 0.3; format 0.2 and
unversioned traces remain explicitly readable through `--legacy`, while
writers accept only 0.3.

### Added — bounded command-member waves (`fadeno drive --parallel`)

- **`fadeno drive --parallel <n>` (1–16, default 1).** Classic `map` steps with
  command-delivered actor calls now run eligible members concurrently within one
  ready wave: read-only deliveries (`writeAccess === false`) may run up to the
  cap, shared write-capable deliveries are serialized at most one live member
  via the existing repo-wide workspace lease (a foreign live lease still hard-
  refuses). Admission, dispatch, and receipt are deterministic: dispatch rows in
  canonical member order, per-member artifact/completion or failure receipts in
  canonical member order independent of wall-clock, with actual supervisor
  `duration_ms`/`ended_at` preserved as evidence and `actor_failed` reason
  `supervisor_lost` when a supervisor dies without a status report. The drive
  process remains the sole lifecycle-row author (`LedgerWriter` per-run mkdir
  lock) and `begin`/`collect` are split across `src/lib/supervisor.ts`
  (`superviseArgv`, `sleepSync`, `supervisorCanStillReport` hoisted and reused).
  `dispatchOnce` stays as the serial `begin+collect` wrapper so `--parallel 1`
  is bit-identical except for output arriving via snapshot file. The output-size
  boundary is enforced at collection by `statSync(...).size > 32 MiB` before any
  whole-file read; a runaway executor is recorded as `output_too_large` rather
  than an empty-output repair, a snapshot that cannot be stat'ed or read is
  recorded as `output_unreadable`, and an over-cap stderr snapshot is read only
  as its trailing `stderr_tail` bytes so runaway stderr cannot exhaust the
  drive process. Mixed host/command maps interleave durable host
  requests and command receipts in canonical order; unresolved host requests
  still block terminal state. Compositional command leaves remain an explicit
  documented deferral (shared-role `latestSessionForRole` leakage and frontier
  ambiguity, see `docs/experimental/compositional-runtime.md`). `fadeno cancel
  --actor-call <id>` disambiguates when multiple command claims are live.

### Fixed

- **Exceptional primary failures no longer leak shadow worktrees.** Concurrent
  shadow collection is attempted exactly once from the primary lifecycle's
  `finally`, and detached-worktree removal is itself guaranteed by the shadow
  collector's `finally`. A failure while persisting the primary or shadow
  completion receipt can no longer leave `.fadeno/local/shadow/<id>` on disk
  or registered with Git.

- **Lease-lock staleness is consistent across process boundaries.** The
  embedded executor supervisor and the in-process workspace-lease helper now
  share the same 120-second stale-lock threshold instead of pruning at 30 and
  120 seconds respectively.

- **Host handoff completion is ledger-aware.** Bash completion now suggests
  only nonterminal host dispatch IDs from the preceding run for
  `dispatch-prompt`, `dispatch-start`, `dispatch-progress`,
  `dispatch-complete`, `dispatch-fail`, and `dispatch-fallback`; completion
  for `dispatch-complete --output` also offers `-` for stdin.

- **`dispatches --output last` could hand a caller the challenger's report.**
  Shadow request rows carry `output_snapshot` like any other, so after a
  shadowed dispatch the newest snapshot-bearing request row *was* the shadow —
  `last` resolved to it and returned the challenger's output as if it were the
  caller's own. Latent under the sequential design (nothing exercised it);
  under concurrent shadows it would have flipped to the opposite failure,
  refusing every shadowed dispatch as "ran concurrently". Shadow records are
  now excluded from `last` candidacy, the open-dispatch set, and the
  concurrency refusal — the caller launched the primary, the kernel launched
  the shadow, and a shadow overlaps its own primary by design. Explicit
  recovery and cancel by shadow id still work.

- **A shadow could edit the workspace it exists to protect, and the ledger said
  it hadn't.** `spawnSync({ cwd })` chdirs the child but leaves the inherited
  `PWD` pointing at the parent's directory, and a shell always rewrites `PWD`
  when it cds. A tool that resolves its project root from `$PWD` rather than
  `getcwd()` therefore operated on the *main workspace* instead of the isolated
  worktree it was launched in. OpenCode does exactly this: a shadow told to
  append a line appended it to the real `README.md`, while the untouched
  worktree yielded `diff_bytes: 0`. Both halves are bad — the write landed on
  the tree shadow promises never to touch, and the evidence recorded a clean
  run, so nothing surfaced it.

  Fadeno's isolation was otherwise correct (`git worktree add --detach`,
  `cwd` set, diff taken from the worktree), which is why this survived: an
  instrumented probe spawned the same way reported the right `cwd` and wrote to
  the right tree. Only executors that trust `PWD` escaped, and whether a given
  driver does is not something Fadeno can know per driver — so `atCwd` now sets
  `PWD` alongside `cwd` at every spawn site that sets one: the primary
  executor, the shadow, the host fallback command, the drive engine's executor,
  and user constraint commands.

- **The dispatch proxy no longer relies on instinct for two behaviours it was
  already getting right.** A 2026-08-14 dogfood watched a proxy refuse to fold
  a mid-flight amendment into a live dispatch, and separately watched it relay
  an executor's claims while stating plainly that it had not verified them.
  Both were the correct call. Neither was specified.

  *Amendments.* The contract said nothing about the task changing after the
  dispatch launched; the nearest rule warned against re-dispatching, and only
  on the timeout path. The proxy generalised it correctly on its own, which is
  exactly the kind of behaviour that regresses silently on a model swap or a
  body regeneration — and whose failure mode is the expensive one, two
  executors racing on the same files. Now a step of its own: report the
  discrepancy, name what was dispatched against what the amendment asks, and
  leave the decision to the caller.

  *Non-verification.* A proxy holds one permitted command and never sees the
  repo, so it structurally cannot confirm that a change an executor describes
  actually landed — and relaying the claim bare reads as the proxy vouching
  for it. Saying so was previously forbidden by the same step that requires
  verbatim relay ("do not summarize, trim, reformat, or annotate it"), so the
  proxy was doing the right thing *against* its own contract. A single framing
  line is now carved out explicitly, and may never sit inside the report or
  replace any part of it.

  Both rules are pinned by tests and applied identically to the worker,
  reviewer, and judge proxies.

### Added

- **`fadeno dispatches --cancel <id|tag:handle>`** — stop a running dispatch.

  A 2026-08-14 dogfood named the gap: a proxy correctly declines to fold a
  mid-flight amendment into a live dispatch, because a second executor would
  race the first on the same files — but nothing could *stop* the first either.
  A corrected instruction was therefore not applicable, not safely
  re-dispatchable, and not abortable. With roughly half of dispatches
  outliving the caller's 600s window, that is the ordinary case rather than the
  corner.

  Delivering the amendment to a running executor is impossible and is not
  attempted: every driver is a one-shot CLI whose stdin closed when the prompt
  was written. Cancel makes the honest path — abort, then re-dispatch with the
  corrected prompt — deterministic instead of a race.

  The supervisor publishes `{pid, started_at}` to
  `.fadeno/local/inflight/<dispatchId>.json` and unlinks it on exit. It has to
  be the supervisor: `spawnSync` hands the kernel a pid only once the spawn has
  finished, so while an executor runs the supervisor is the only process that
  knows its own pid. Cancel sends SIGTERM — never SIGKILL, which would leave
  exactly the orphan the supervisor exists to prevent — and the existing reap
  path takes the executor's whole process group.

  It records a `dispatch_cancelled` row and stops there. The kernel still owns
  the completion row, written when its spawn unblocks, normally with
  `signal: "SIGTERM"`. Cancel refuses and writes nothing when the dispatch has
  already completed, or when there is no claim on this machine — both would be
  claims about work this call never touched.

- **`fadeno targets [--json]`** — one row per declared target, dialed or not.
  `loadout list` answers "what runs for this archetype", so a target no loadout
  references appeared nowhere: the only ways to discover one were reading
  `executors.yaml` or misspelling a name and reading the candidate list off the
  error. Both drivers added below ship with no loadout, which was about to make
  that the normal case rather than the corner.

  Each row names the **driver binary** it would spawn, and delivery is compiled
  against the active host — so the same target reads `host` on its own harness
  and `command (claude)` elsewhere, which is the host/driver distinction made
  visible per row. `DIALED BY —` means reachable but bound to nothing.
  `[fallback read-only]` on a host row is deliberately qualified: `write_access`
  only ever describes a route's command delivery, so an unqualified "read-only"
  there would claim something about the in-session agent that the field cannot
  know.

- **Two new driver harnesses: Antigravity and OpenCode.** The starter catalog
  gains a `google` target/route (Antigravity's `agy`) and an `openrouter` one
  (OpenCode), reachable from all four host route tables. Both are *drivers* —
  harnesses Fadeno spawns as subprocesses — so neither adds a `HarnessId`, a
  `templates/` tree, an `init` flag, or a plugin: the whole change is catalog
  plus docs. `fadeno loadout set worker gemini-default` (or
  `opencode-default`) is enough to route worker-shaped work to either.

  Both are verified live end to end through the kernel: prompt on stdin,
  `outcome: ok`, report on stdout, correlated evidence pair — and for
  Antigravity, a file actually written into the repo, which is the part that
  matters below.

  Antigravity is used instead of gemini-cli because that client is retired for
  individuals and dies at auth with `IneligibleTierError`. Its route encodes
  three findings, and **two of the three rejected spellings fail by exiting 0
  having done nothing** — the silent-success shape this project keeps hunting:

  - `agy -p` requires a value, and `agy -p -` does not read stdin. It takes the
    literal `-` as the prompt and answers "How can I help you today?" with exit
    0. Piping with no `-p` is the spelling that delivers the prompt.
  - Without `--new-project`, agy has no active workspace and writes to
    `~/.gemini/antigravity-cli/scratch/` while reporting "I have created the
    file" and exiting 0 — the repo gets nothing. `--add-dir .` does not fix it;
    only an absolute path does, which a static route cannot express.
  - `--effort` accepts only `low|medium|high`, so passing `{reasoning_effort}`
    would hard-fail every target left at the `default` effort. Antigravity
    encodes effort in the model id (`gemini-3.1-pro-high`) instead.

  OpenCode is multi-provider (`-m provider/model`), so its provider key is the
  credential holder and the route prefixes it (`-m openrouter/{model}`) rather
  than pushing an OpenCode-shaped id into the harness-neutral target.

  All three Antigravity flags are pinned by tests, because each one is exactly
  the kind of flag a later reader would delete as redundant.

- **A glossary for hosts versus drivers** (`docs/architecture.md`). Fadeno
  relates to a harness in exactly two ways and had a good word for only one of
  them. A **host** is the harness Fadeno runs inside: typed as `HarnessId`,
  needs a `templates/<host>/` adapter, selects which `routes:` sub-table
  compiles. A **driver** is a harness Fadeno invokes as a subprocess: needs
  nothing but argv, and appears only as a route's `command:`. The reliable test
  is whether it needs a `templates/<x>/` tree. Also records three standing name
  collisions — `grok` as both a `HarnessId` and a route binary, `adapter` as
  both a host surface and a delivery mechanism, and `Target` (a host in
  `init.ts`) versus `targets:` (a provider/model profile) — documented rather
  than renamed because all three are load-bearing.

- **Both harnesses work at once; the host in evidence decides the routes.**
  Almost everything about a harness was already per-harness and additive —
  `installations.json` records Claude and Codex independently, Codex role
  agents live in `~/.codex/agents/`, the Claude plugin in its own cache. One
  thing was global and single-valued: the `harness` memo, overwritten by every
  targeted setup. Resolution read that memo, so on a machine set up for both,
  a bare `fadeno` compiled whichever harness `setup` had touched last — and
  under the wrong block an Anthropic host slot is not merely unpreferred, it
  has no host route at all, so an in-session subagent silently became a
  `claude -p` subprocess. `activeHarness` now consults the host actually
  exporting its markers into this process before falling back to the memo:
  explicit argument → `FADENO_HARNESS` → detected host → memo → `standalone`.
  Switching hosts is now just switching; no `setup` toggle in between. The
  memo keeps answering the one question it can — which harness to assume when
  no host claims the session at all (a plain terminal, CI, cron).

  Nesting is handled at the spawn point rather than by guessing. A host
  exports its markers into everything it launches and children inherit them,
  so a `codex exec` worker started from Claude Code carries `CLAUDECODE` *and*
  `CODEX_THREAD_ID`; ordering cannot break that tie because the reverse
  nesting is symmetric. Two claimants therefore resolves to *no* detection and
  falls through to the memo, exactly as before detection existed, with
  `doctor` reporting the nesting. The kernel's executor spawn — which passed
  no `env` at all and so leaked its own identity into every child — now clears
  `FADENO_HARNESS` and the marker set, letting whatever the child launches
  assert what it actually is. Config locations like `CODEX_HOME` are left
  alone: they say where a host keeps settings, not that you are inside one.

  Harness *state* follows the same rule. Codex binds role agents to files at
  session start, so a loadout switch has to rewrite them — and `fadeno use`
  decided whether to by asking the same single-valued memo, which meant
  switching a loadout from a Claude session left the Codex agents naming the
  executor you had just switched away from, silently and with nothing else to
  correct it. `doctor` could not report it either: its `codex-agents` check
  and the freshness data behind it were both gated on Codex being the *active*
  harness, so they stopped looking in exactly the case that breaks them.
  Materialization and that check now key on the harnesses this machine
  maintains — `installations.json` already recorded each independently, unioned
  with the memo so no machine set up before the manifest loses behavior. An
  explicit `fadeno use --codex` still forces the write; there is deliberately
  no flag that suppresses it, since skipping maintenance is the bug. Freshness is
  judged against the catalog compiled *for codex* rather than the active
  harness, because which archetypes need an agent is itself harness-dependent:
  an anthropic target is a host slot under Claude and a command under Codex.

- **`doctor` notices a harness nobody recorded.** Routes are compiled per
  harness, and `activeHarness` answers `standalone` whenever no memo exists —
  a defensible answer to "which host am I in" that nothing ever revisited. Under
  `standalone` the native route does not merely lose preference, it does not
  exist, so a host-native slot compiles to `adapter: command` and a subprocess
  runs where an in-session agent was meant to. The gap is easy to reach: only a
  *targeted* `fadeno setup --claude|--codex` writes the memo, while the loadout
  pin beside it is written unconditionally and `fadeno use` never writes a
  harness at all, so the two states that look like a pair arrive separately.
  `doctor` now compares the resolved harness against session-scoped markers the
  hosts themselves export (`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`,
  `CODEX_THREAD_ID`/`CODEX_SANDBOX`/`CODEX_PERMISSION_PROFILE`) and warns in
  both directions — nothing recorded, or a memo that contradicts the host —
  citing the variable that carried the evidence and the one command that
  records it. Detection is diagnostic only: routing never consults it, because
  silently promoting a guess into compiled adapters is how one loadout starts
  delivering a slot differently depending on which process asked. This also
  restores `codex-agents`, which keys on `status.harness === 'codex'` and so
  went quiet in exactly the case it was written for.

- **Shadow dispatches: model tryouts at zero risk.** A slot can carry a
  shadow challenger (`fadeno loadout shadow worker grok-worker`, sampled
  with `--rate 0.2`, one-shot with `fadeno dispatch --shadow <executor>`):
  the kernel duplicates each matching dispatch to the challenger with the
  byte-identical prompt snapshot, delivered into a detached-HEAD git
  worktree so a write-shaped shadow yields a diff artifact
  (`diff_snapshot`/`diff_bytes`) and never touches the workspace. Shadow
  rows stamp `shadow: true`, `primary_dispatch_id`, `shadow_source`, and
  `gate_eligible: false` — they pair, they never gate, and no shadow-side
  failure can affect the primary's result. `fadeno dispatches
  --comparisons` renders the paired scorecard per challenger together with
  `ModelComparison` artifacts (committable files under
  `.fadeno/comparisons/` whose contract mandates a confounds section), and
  the `model-tryout` starter playbook runs the deliberate head-to-head.
  The adoption ladder is one command per rung: shadow → override → preset.
  Ledger format stays 0.2; every new field is additive.
- **Dispatch output survives the kill.** The kernel now streams executor
  stdout to a snapshot at `.fadeno/local/outputs/` as it arrives (the same
  single-writer idiom as prompt snapshots), so a relay killed by a harness
  timeout no longer destroys the report: the request row names
  `output_snapshot` before the spawn, the completion row adds
  `output_bytes`, and `fadeno dispatches --output <id|last>` prints the
  snapshot verbatim with an attestation verdict (`match` / `mismatch` /
  `incomplete`). The dispatch proxy contract gains the matching recovery
  step, allowlisted in the proxy guard. Completion rows also attest
  `workspace_changed` (a git fingerprint before/after the spawn — evidence,
  not judgment), and `fadeno dispatches` marks the exit-0 no-op signature
  with `[no workspace change]`.
- **Resolution is strict where it decides and graceful where it looks.**
  `fadeno loadout resolve` now refuses a stale pin with the same error
  `fadeno dispatch` raises instead of silently falling back to the default
  loadout, and the steering hook denies a proxy-bound spawn on a resolver
  error rather than quietly going native; inspection commands keep
  surfacing `stalePin` without bricking. A user-scope dial now applies only
  where the user layer was actually composed — a self-contained project
  profile is authoritative, so someone's global pin no longer reaches into
  unrelated repos. Self-contained catalogs that predate canon archetypes
  get a note in the loadout views naming what they never declared
  (`suppressedCanonArchetypes` in the JSON), leaving adoption an explicit
  choice.
- **Constraint tiers at the dispatch boundary** (phase 3 of
  `docs/experimental/slots-and-archetypes.md`) — policy the kernel can
  enforce, in two tiers. Tier 1 is declarative vocabulary:
  `distinct_provider_from_inputs: advisory | required` on archetypes,
  enforced against input provenance (`fadeno dispatch --produced-by
  <dispatch-id>` on the ad-hoc path; the run's own events on the engine
  path) — `required` refuses provider clashes and unresolvable provenance,
  `advisory` warns and records `provider_distinctness: "warned"`; and
  per-target `eligibility: { <archetype>: eligible | shadow_only |
  forbidden }` — `forbidden` refuses at dial time and dispatch time,
  `shadow_only` dispatches but stamps rows `gate_eligible: false` (phase 4's
  shadow flag; gate semantics unchanged in this phase), with both states
  marked in the `fadeno loadout` tables. Tier 2 is the escape hatch:
  top-level `constraints: { command: [...] }` invoked at the dispatch
  boundary with the full resolution context on stdin — exit 0 allows, exit
  2 refuses with stderr as the reason, anything else is a loud
  constraint-system error, never an allow. Every boundary refusal
  (write posture retrofitted too) now appends a `dispatch_refused` evidence
  row naming predicate and message; `fadeno dispatches` renders refusals
  and shadow rows distinctly; `fadeno verify` recomputes `gate_eligible`
  stamps from the run snapshot. Profile layering now carries `constraints:`
  across layers.

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

- **A completion row was stamped with the dispatch's start time.** Both rows of
  a pair were written from the same clock reading, so `dispatch_completed`
  carried `timestamp` = when the dispatch *began*. The one field a reader
  reaches for to ask "when did this finish?" quietly answered a different
  question, and a ten-minute dispatch looked instantaneous. Found while
  computing dispatch overlap for the `last` refusal below, where reading the
  stamp would have detected no concurrency at all.

  The completion row now records the real end, derived as `now + duration_ms`
  rather than read fresh off the wall clock, so `completed - requested ==
  duration_ms` holds exactly and an injected clock still yields a deterministic
  log. Shadow completions follow the same rule. A 2s dispatch that recorded
  `0.000s` between its rows now records `2.349s`.

  Readers keep deriving the end from `requested_at + duration_ms` instead of
  trusting the stamp. The log is append-only: every row written before this
  carries the start in both places, and trusting the stamp would collapse those
  dispatches to zero length and stop detecting their overlaps. The two agree on
  new rows by construction; on old ones only the derivation is right.

- **Timeout recovery returned another agent's report.** The first real exercise
  of the rc.22 recovery path, on 2026-08-14: a proxy timed out, ran
  `dispatches --output last`, and got a concurrent dispatch's output. Its own
  work had completed fine — the failure was purely in retrieval. `last` prefers
  an *open* dispatch, but both had finished by the time either looked, so it
  fell through to bare recency and returned the newest row in the log. It did
  flag the guess in-band, which is much better than silent, but an agent
  consumed the note and relayed anyway: a wrong answer with a caveat is still a
  wrong answer.

  The obvious fix — echo the dispatch id at launch — was already shipped in
  rc.22 and is what failed. The echo goes to stderr, and the caller who needs
  it is by definition the one whose Bash call was killed, taking the stream
  with it. So the handle has to be one the caller *chose*:
  `fadeno dispatch --tag <handle>` records it on the dispatch's rows, and
  `fadeno dispatches --output tag:<handle> --wait 120` recovers by it. A tag is
  known before the spawn and survives losing every byte the dispatch printed.
  The proxy agents now launch with a task-derived tag and recover with it, and
  the guard permits both spellings. (`tag:<handle>` rather than
  `--output --tag <handle>` because `--output` takes a value and would swallow
  the flag — a caller recovering from a timeout should not also have to get
  flag ordering right.)

  `last` no longer guesses when it cannot know. It refuses whenever the newest
  dispatch overlapped another in time — naming every candidate and its tag —
  and resolves by recency only when the dispatch demonstrably ran alone. The
  overlap is computed from `requested_at + duration_ms`, not from the
  completion row's timestamp, because the kernel stamps both rows of a pair
  from the same clock reading: a completion row's `timestamp` is when the
  dispatch *started*.

- **The evidence log could not say which Fadeno wrote it.** A 2026-08-13
  dogfood read twelve rows spanning a version bump and found exactly one
  version-shaped key across all of them — `hook_version`, which only the Claude
  steering hook writes, and which is therefore absent on every row the kernel
  writes. So the log's own provenance read as *mostly missing*, and the one
  question worth asking of old evidence — "which build produced this?" — had no
  answer. `fadeno_version` had existed in the binary the whole time; `evidence`
  and `vendor` rows carried it and no dispatch row ever did.

  Every dispatch row is now stamped, and stamped centrally in
  `appendEvidenceRow` rather than at the six call sites, because a per-site
  field is precisely how it came to be missing — a new row type cannot forget.
  The value is the version of the binary that *ran*, so a proxy invoking
  `$CLAUDE_PLUGIN_ROOT/bin/fadeno` records the plugin's build and a director
  invoking a bare `fadeno` records the CLI's, making a mixed-build session
  legible after the fact without a second field. The steering hook writes the
  same key on its `host_delivery` rows, so one field spans the whole log.

- **A session could not tell which Fadeno its subagents were.** The same
  dogfood ran a registry announcing `[fadeno 0.6.0-rc.20]` against a CLI at
  rc.22, with no rc.20 directory anywhere in the plugin cache, and reasoned
  about behaviour from the stamp. Nothing was corrupt: the plugin surface ages
  in two halves. Hooks and the bundled binary are re-read from disk on every
  call, while subagent definitions are snapshotted into the harness at session
  start and stay frozen for the session's life — and with a `directory:`
  marketplace source the live surface is the working tree, so cache
  directories exist only for versions someone explicitly installed. A stamp
  naming a version with no directory is expected.

  `fadeno doctor` reports this as `plugin-surface`: it names the plugin build
  on disk and the running CLI, and warns when they differ. When they agree it
  still says so and points at the half it cannot read — the registry is held
  inside the harness — telling the caller to compare the `[fadeno …]` stamp in
  their own agent list and restart if it differs. Behaviour questions are
  settled from `fadeno_version` in the ledger, which records what actually ran.

- **A timed-out proxy read the ledger once, too early, and called it failure.**
  The sharpest of the batch, because Fadeno's own data was correct throughout.
  A 2026-08-13 dogfood had two worker dispatches recorded as `exit_code: 0`
  with 5833 and 3743 bytes — genuine, complete reports. The proxies had read
  `dispatches --output` at the moment their Bash call timed out, which is the
  one moment the completion row is least likely to exist yet: the kernel
  writes it when the executor exits, and the executor was still running. They
  saw no completion row, declared failure, and never looked again. The finding
  is not "reports failure wrongly" but "has the right answer available and
  does not look again."

  `fadeno dispatches --output <id> --wait [seconds]` re-reads until the
  completion row lands (default 120s), then answers with the real, attested
  output. The wait re-resolves by the id it first settled on, so a dispatch
  starting mid-wait cannot steal the answer from a `last` query. The
  no-completion note stops reading like a verdict — "no completion row
  recorded YET: the executor may still be running … not a failure" — and the
  proxy guard permits the `--wait` spelling, since a contract that forbids the
  correct call is not a contract worth keeping.

- **A killed dispatch left its executor running.** The most serious of the
  batch, and confirmed end to end before it was fixed: `fadeno dispatch` runs
  its executor through `spawnSync`, which blocks Node's event loop for the
  whole spawn, so a killed kernel runs no cleanup — and the harness that kills
  it kills the kernel's pid, not its process group. Killing the kernel two
  seconds into a dispatch left the executor delivering all twenty of its
  files, still writing the inherited output snapshot, still consuming the
  host. A 2026-08-13 dogfood hit exactly this at the 600s Bash timeout: the
  orphan saturated the machine badly enough to invalidate an unrelated timing
  gate, while the proxy reported the dispatch as failed — so trusting the
  report would have re-dispatched the task and put two workers on the same
  files.

  The kernel now spawns a supervisor between itself and the executor. The
  supervisor runs the executor in its own process group and watches for
  re-parenting — when the kernel dies, the supervisor's `ppid` changes to the
  local reaper, which is exact and immune to the pid reuse a liveness probe
  would face across a ten-minute dispatch — then SIGTERMs the executor's whole
  group, SIGKILLing after a grace period. The executor's own subprocesses go
  with it, which is how a runaway saturates a host in the first place.

  Supervision is invisible when nothing goes wrong: stdin, stdout, exit codes
  and signals pass through unchanged, and a signal is re-raised rather than
  translated so `killed by SIGTERM` and `exited 143` stay different facts. The
  one thing it had to restore explicitly is the missing-executor case — the
  supervisor always starts, so `spawnSync().error` no longer reports a bad
  binary, and the supervisor marks that on stderr for the kernel to read back.
  The supervisor ships as source to `node -e` rather than as a sibling file:
  Fadeno runs from three artifacts (type-stripped source, built `dist/`, and a
  single-file esbuild bundle) and a file that had to be located from all three
  could go missing and break dispatch outright.

- **`killed` was reported as `failed`.** The dispatch proxies were instructed
  to "state plainly that the dispatch failed" when the call "exits non-zero or
  is killed" — one clause covering two facts that are not the same. A kill
  says nothing about the executor, which the fix above now stops but which had
  already delivered its work in the dogfooded case. The proxies now treat a
  kill as an UNKNOWN result, never a failure: report that the dispatch was
  killed at the harness timeout, that this is the output recovered so far, and
  that the work must be checked on disk before anyone re-dispatches — the last
  part explicitly, because re-dispatching is what puts two workers on one
  file.

- **The resolver stated the slot but not the call.** `fadeno loadout resolve`
  reported `adapter: "host"` and stopped there. The dogfood watched a director
  read that, narrate it correctly, write a 26-line prompt, dispatch anyway,
  and only then learn the call was impossible — four tool calls to discover
  something the resolver already knew. The result now carries `delivery`:
  whether the slot is dispatchable from this harness, the exact command when
  it is, and an `action` sentence that always ends in a verb (`Do NOT
  dispatch … spawn the in-session reviewer agent instead`). It shares the
  kernel's own dispatchability predicate rather than restating it, so a hint
  saying "dispatchable" can never precede a refusal.

- **Three paths reported success while producing nothing.** A 2026-08-13
  dogfood in an unrelated repo found the same shape three times: a terminal
  state that reads as success next to artifacts that show nothing happened.
  Two worker dispatches logged `dispatch_completed` with `exit_code: 1` and
  `output_bytes: 0` — the sha256 of the empty string — and the event name was
  the only thing most readers looked at. `dispatch_completed` has always meant
  "the spawn reached a terminal state", never "the work happened", and nothing
  in the row said which.

  Completion rows now carry an explicit `outcome`: `failed` for any spawn
  error, signal, or nonzero exit; `empty` for the quieter case where the
  executor exits 0 and writes nothing; `ok` otherwise. `fadeno dispatches`
  leads the outcome — `FAILED` / `NO OUTPUT` before the exit code, not after a
  line of identity — and `fadeno dispatch` now exits 1 on an empty report
  rather than handing a proxy a blank to relay. Rows written before the field
  derive the same verdict from the `exit_code` and `output_bytes` they already
  carry, so the old evidence reclassifies itself; a row carrying too little to
  say either way stays null, because absent is not a claim. No format bump —
  the field is additive.

  This also covers the silent model-id failure the same dogfood hit, where
  `--model grok` against a catalog that now resolves `grok-4.6` produced a
  zero-byte success twice before anyone noticed. Fadeno cannot pre-validate an
  arbitrary executor's model ids, but it can refuse to call an empty result a
  result.

- **`--output last` crossed wires between concurrent dispatches.** `last`
  resolved to the newest `dispatch_requested` row carrying a snapshot, across
  the whole repo's evidence log — so with two dispatches in flight, a proxy
  recovering after a kill could read back the *other* dispatch's report. The
  same dogfood hit exactly that; the proxy flagged the mismatch rather than
  passing the work off as its own, which is the behavior the relay contract is
  for, but the retrieval channel had no notion of caller identity at all.

  The kernel now echoes `dispatch id: <id>` on stderr before the spawn, so a
  caller can always name its own dispatch, and the proxy agents are instructed
  to prefer that id. `last` itself is now recovery-shaped rather than
  recency-shaped: it resolves to the dispatch with no completion row — the
  killed or in-flight one it exists for — and *refuses*, naming the
  candidates, when more than one is open. Falling back to recency is still
  allowed when nothing is open, and says so.

- **The `general-purpose` catch-all was captured as a worker.** The Claude
  steering hook mapped `general-purpose` onto the worker archetype, which
  meant every generic subagent spawn in a Fadeno repo became an external
  dispatch. The dogfood launched one for a direct analysis task and watched it
  become a `dispatch-worker`, then watched the proxy guard correctly enforce
  the relay contract on an agent that was never meant to be a proxy — "as a
  dispatch proxy I'm not permitted to run the analysis myself" — held against
  the very instructions it had been given. The analysis never happened.

  Only agents that *name* an archetype are steered now: `worker`, `reviewer`,
  `judge`, and the explicit `dispatch-*` proxies. `general-purpose` is the
  harness's default subagent — what a director reaches for to run an analysis
  or a search — and joins Explore, Plan, and unrelated specialists as
  unsteered. Directors that want archetype routing already have two explicit
  spellings; the catch-all is not a third.

- **`status` claimed project playbooks that did not exist.** The definitions
  line read `N effective playbooks (project shadows bundled)` — a statement of
  the shadowing rule that reads as a claim shadowing occurred, printed
  verbatim on repos with no `.fadeno/playbooks/` at all. It now counts the
  split: `all bundled`, or `N from .fadeno/playbooks, M bundled`. The Codex
  managed-agents line names its remedy (`fadeno use <loadout>`) instead of
  reporting `missing/stale (restart required)` and leaving the reader to find
  the command.

- **A native slot stays native instead of nesting a subprocess.** The dispatch
  proxy agents advertise themselves as MUST-BE-USED, so a director names
  `fadeno:dispatch-judge` directly — and the Claude steering hook used to
  short-circuit on that name, never asking which transport the loadout wanted.
  Command delivery was locked in by the caller. On Claude that meant `claude
  -p`: a subprocess of the harness already running, which loaded the same
  plugin, re-read the prompt as director work, and re-dispatched one level
  down until a headless permission denial ended it — exit 0, 97 seconds, a
  failure report in place of a judgment. The hook now resolves a named proxy
  like any other archetype spawn and pulls a host slot back to the native
  agent (`current-host` still inherits the caller's model, pinning none on the
  way out). The kernel carries the same rule as a backstop: on a harness that
  materializes native slots in-session on demand, a host executor's
  `fallback_command` is refused rather than spawned. That fallback keeps doing
  exactly what it was written for — Codex materializes role agents once per
  session, so a slot differing from that session's baseline still needs a
  command.

- **The starter xai worker has a real model id.** `grok-default` was bound to
  `model: grok`, which the CLI rejects outright ("unknown model id"; `grok
  models` lists grok-4.6 and grok-4.5), so every worker dispatch under it
  exited 1 in about five seconds having done nothing. Now `grok-4.6`,
  verified live against the CLI.

- **`status` reports the harness that actually compiled the routes.** It
  spelled harness resolution separately from `activeHarness`, reading
  `process.env.FADENO_HARNESS` past an injected env and ignoring an explicit
  `FADENO_HARNESS=standalone` — so the command whose whole job is reporting
  the effective configuration could name a different harness than the one
  whose routes it was reporting.

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

- **The rename reaches the trace vocabulary too.** The first pass stopped at
  everything live and left the persisted names alone, on the belief that moving
  them meant a ledger format bump and re-pinned digests. That was wrong:
  digests cover artifact bytes and prompt bytes, never event field values, so
  nothing recorded becomes invalid. Writers now emit `delivery_transport:
  "host"`, the Claude hook writes a `host_delivery` row with `transport:
  "host"`, `fadeno dispatches` renders `[host]`, `verify` reports a
  `host-attestation` check, and hook prompt snapshots land at
  `.fadeno/local/prompts/host-<sha8>.md`. Every reader accepts the pre-0.6
  spelling — a `native_delivery` row still renders, and a ledger written with
  `delivery_transport: "native"` still verifies clean, including the
  start-vs-terminal receipt comparison, which normalizes both sides so a legacy
  pair is not read as a mismatch. The ledger format stays 0.3: no field moved,
  no digest changed, and an unrecognized transport is still reported rather
  than coerced. `ConstraintContext.transport` deliberately keeps reporting
  `native` — it is handed outward to user-authored constraint commands, the one
  contract where a rename cannot be aliased, only silently broken.

- **The delivery axis is spelled `host`, not `native`.** "Native" was doing two
  unrelated jobs: naming a *loadout* (which model target fills each slot) and
  naming a *route's transport* (whether the active harness delivers in-session
  or spawns a command). Worse, the transport already answered to a second word
  — `native: true` compiled to `adapter: 'host'`, and the executor filling the
  native loadout is `current-host`. The two senses coincide under the bundled
  catalog, where the `native` loadout binds `current-host` in every slot, so
  loadout-native and host-delivered always agreed; they come apart exactly when
  a slot is overridden with a provider target, which is the one configuration
  where the harness axis decides transport — under a loadout name implying it
  cannot. Routes now take **`host: true`**; `SteeringMode` returns `host`;
  `steering resolve` takes `--host-executor` and reports `host_executor`; and
  the internal `native*` identifiers follow. `native: true` remains accepted as
  a silent alias, so an existing catalog keeps loading (a route setting `host`
  and `native` to *different* values is refused rather than resolved by
  precedence — picking a winner would deliver a transport the author never
  wrote). `--native-executor` still parses, so a Codex role agent materialized
  by an older setup keeps resolving; it now reports stale so the next
  `fadeno setup --codex` rewrites it. `native` is retained deliberately in four
  frozen places, none ambiguous in context: the loadout name, the trace
  vocabulary (`delivery_transport: "native"`, the `native_delivery` event, the
  `[native]` row rendering), the `ConstraintContext.transport` JSON handed to
  user-authored constraint commands, and the route alias above. No ledger
  format change, so existing traces and their pinned digests still verify.

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

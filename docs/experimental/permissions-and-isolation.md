# Permissions and isolation

**Status:** design record. Written before implementation, deliberately, because
the system it replaces was rebuilt three times and produced four
silent-wrong-answer defects in a single day. The point of this document is not
to explain the new design — that part is small. It is to record *why the old
one kept failing*, so nobody rebuilds it by accident.

## The short version

**Fadeno does not enforce permissions. It never did.** It selects an argv and
records what ran. Enforcement belongs to the vendor CLI (`--sandbox read-only`,
`--disable-shell`, `--permission-mode`), and containment belongs to git
(isolated worktrees). Every Fadeno-level "permission" was a claim in YAML that
nothing checked.

The new model states that plainly instead of dressing it up:

- Routes are argvs. Permissive by default. A restriction is a *different route*
  with a different name, visible by reading its command.
- The dial is the only decision. What you dial is what runs.
- Isolation is the real boundary, and it is the default wherever git allows it.
- The ledger records what ran, not what was claimed.

## Why the old system failed

It tried to answer three different questions with one mechanism, and the
questions do not have the same shape.

1. *Does this work need to write?* — a property of the task (`requires_write`
   on the archetype).
2. *Can this argv write?* — a property of a command line (`write_access` on
   the route).
3. *Where does it write?* — a property of delivery (host in-session vs a
   spawned command, shared tree vs worktree).

The machinery matched (1) against (2) and escalated via `write_variant` when
they conflicted. Four things went wrong, and each is a distinct lesson:

**Unknown collapsed into satisfied.** `write_access` was optional, so an
undeclared value was `null`, and `null` satisfied *every* posture. A
write-requiring archetype on a silently read-only lane returned an empty diff,
and a bakeoff read that as "this model chose to change nothing." A confident
wrong verdict is worse than no verdict.

**The escalation was misnamed.** `write_variant` did not grant writes. It
swapped in a whole different argv, and in the shipped catalog those argvs
dropped `--sandbox read-only` (xai), `--agent fadeno-readonly` (openrouter),
and both `--disable-write` *and* `--disable-shell` (muse). "Escalate to write"
in practice meant "escalate to write plus unrestricted shell, minus the
sandbox." The posture layer could not see this, because every variant is
correctly `write_access: true` once applied.

**One declaration decided delivery.** Host routes are refused `write_variant`
at parse time — a rule that protects the locked host-dispatch replay path,
where `verify` cross-checks the argv's sha256. It was applied to the *pair*
path too, where nothing replays anything. Result: under the `claude` harness
`anthropic` is `host: true` and can never escalate, while under `codex` and
`grok` the same driver is a command route and escalates fine. Claude as a
harness was uniquely unable to pair on write-requiring work, for no reason a
user could discover.

**The escape hatch was honored halfway.** `--force` let the primary proceed but
was invisible to pair formation, so forcing produced a dispatch and no pair,
silently.

The through-line: **every one of these was a negotiation bug, not a capability
bug.** The part that worked was choosing between two argvs. The part that
failed was inferring which one to choose.

## The inversion

Old: restrictive by default, with an inference engine to escalate.
New: **permissive by default; restriction is explicit and opt-in.**

That flip is the whole design. With no restrictive default there is nothing to
negotiate, and the negotiation layer — with all four of its failure modes —
has nothing left to do.

## Architecture

### 1. Routes are argvs

```yaml
routes:
  claude:
    anthropic-exec:   { command: [claude, -p, --model, "{model}", --permission-mode, acceptEdits] }
    openai:           { command: [codex, exec, --model, "{model}", --sandbox, workspace-write, ...] }
    openai-sandboxed: { command: [codex, exec, --model, "{model}", --sandbox, read-only, ...] }
```

No `write_access`. No `write_variant`. No host/command asymmetry. The shipped
catalog carries the permissive argv for each vendor; a sandboxed lane is its
own route with its own name.

This is the key ergonomic claim: **a restriction you can only learn by reading
YAML metadata is a restriction nobody knows about. A restriction spelled out in
the argv is one you can see.**

### 2. The dial is the only decision

`fadeno dial worker opus --via claude-exec`. What you dial is what runs. No
matching, no escalation, no refusal, no `--force`.

### 3. Isolation is the boundary, and it is the default

A command dispatch runs in a detached worktree and returns a diff. This is the
only layer in the entire system that *enforces* anything, so it is the one that
gets promoted rather than the declarations.

It also costs nothing in concurrency — it gains: an isolated dispatch takes no
repo-wide writer lease for its duration (only across merge-back), where a
shared one holds it for the whole run.

**The sharp edge, recorded so it is not rediscovered:** isolation can itself
fail. A non-git repo has no worktree to make. Isolation is therefore the
default *where git allows it*, and falls back to shared — and the shared path
is exactly where nothing contains a writer. That case must stay visible rather
than being quietly treated as equivalent. It is not "the safe direction to be
wrong in": making isolation mandatory would turn dispatches that work today
into hard errors.

Consequence for the writer lease: with `write_access` gone, no dispatch can
claim to be a non-writer, so a *shared* dispatch always takes the lease. That
is the honest reading — under this model we genuinely do not know whether it
writes.

### 4. The ledger records what ran

The argv and its sha256 are already recorded. The claim fields
(`write_access`, `write_posture_forced`, `write_posture_unverified`) go.

### 5. Constraint policies are the real gate

For anyone who wants enforcement at the Fadeno layer, a constraint policy is
it — and it becomes more useful for being the only one. It sees the argv, so it
can gate on what will actually run rather than on a label.

## Replacing posture with measurement

Posture existed to stop a crippled arm being compared against a capable one.
That job is real; the mechanism was wrong. It is replaced by an **argv-diff
confound**: at bakeoff time, compare the two arms' recorded argvs, and if they
differ beyond model and effort substitution, stamp a confound.

This is strictly better than what it replaces on three counts. It is *observed*
rather than declared, so it cannot be wrong about the config. It catches *any*
capability skew — sandbox flags, tool allowlists, agent configs — not just the
write bit. And it cannot produce a false refusal, because it does not refuse.

## What this cost, and the follow-up it owes

**`--parallel` currently serializes command members.** This is the one place
the cut removed a capability rather than a liability, and it is worth being
precise about why, because the two were never separable.

The lease bypass keyed on the *route's* `write_access !== false`. So `worker`
— `requires_write: required`, hence escalated to a write-capable argv — always
took the lease and always serialized. What actually parallelized was
`reviewer`/`judge`, which declared no posture and therefore stayed on a
read-only base argv: `pr-review.yaml`'s three reviewers, `code-change-review`'s
two. (`parallel-workstreams.yaml`, despite the name, is four workers and never
parallelized at all.)

That speedup was *paid for by the read-only base argvs* — the exact
declarations this document removes. `--parallel` and the write posture were one
mechanism seen from two angles, so spending the posture spends the speedup with
it. The engine now says so out loud rather than accepting a concurrency request
it will not honor.

**The follow-up is isolation with merge-back for engine attempts.** It restores
concurrency as a *fact* — separate worktrees — rather than as an unverified
promise, and it is safest in exactly the case that used to parallelize: a
member that writes nothing merges back empty. It also closes a hazard the old
model carried, since `write_access: false` was never enforced — a reviewer on a
bare `claude -p` could write the shared tree while holding no lease, precisely
because it had declared itself a reader.

Note what that work is NOT: it is not plumbing. "Isolated" already means two
incompatible things — `--isolate` means *keep this work out of my tree* (no
merge-back), while a paired primary means *the kernel isolated you, so merge
back*. Default isolation is a third case that needs paired semantics without a
pair, which is why `dispatch.ts` currently degrades an unpaired isolated
dispatch straight back to shared. Until that is resolved, **isolation is the
declared default but not the delivered one**, and the ledger says so: the
request row reads `isolated`, the completion row reads `shared` with a
`workspace_mode_degraded` stamp.

**A widened hazard, recorded because it now bites more often.** The workspace
lease is guarded by a `mkdir` lock reclaimed only after 120s. A hard-killed
process can die holding it. That was always true for write deliveries; now that
every shared delivery takes the lease, the window a kill can land in is much
wider, so a killed run can block the repo for up to two minutes.

## What must not come back

Do not reintroduce a posture negotiation layer. Specifically:

- No archetype-level demand matched against a route-level capability.
- No automatic argv substitution based on that match.
- No refusal derived from a declaration Fadeno cannot verify.
- No tri-state capability field where "undeclared" has to mean something.

If a future need looks like it wants one of these, the thing it actually wants
is almost always either **a differently-named route** (say what should run) or
**a constraint policy** (gate on what will run). Both are explicit, and neither
requires Fadeno to hold an opinion it cannot enforce.

The one legitimate successor to "is this comparison fair?" is measurement of
what ran — see the argv-diff confound above.

## Migration

A catalog still carrying `requires_write`, `write_access`, `write_variant`, or a
dial carrying `force_write_posture` fails to load with `is no longer supported`
and **a pointer to this document**. It is never silently ignored. Quietly dropping a
key someone wrote in order to restrict something is the exact failure mode this
project exists to prevent, and it would be a poor way to begin a change whose
entire premise is that unenforced claims are dangerous.

`archetypes:` itself survives — it still carries `ignored_output`, `fallback`,
`brief`, and `distinct_provider_from_inputs`. Exactly one key leaves.

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

**`--parallel` serialized command members for one release.** This was the one
place the cut removed a capability rather than a liability, and it is worth
being precise about why, because the two were never separable. It is restored —
see "Delivering isolation" below — but by a different mechanism, and the
difference is the point.

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

**The follow-up was isolation with merge-back for engine attempts,** and it has
landed. It restores concurrency as a *fact* — separate worktrees — rather than
as an unverified promise, and it is safest in exactly the case that used to
parallelize: a member that writes nothing merges back empty. It also closes a
hazard the old model carried, since `write_access: false` was never enforced —
a reviewer on a bare `claude -p` could write the shared tree while holding no
lease, precisely because it had declared itself a reader.

The trade is worth stating plainly: what a route *declared* bought speed at the
cost of a guarantee nothing checked. What a worktree *is* buys the same speed
and the guarantee.

## Delivering isolation: what "isolated" actually means

The blocker on that follow-up was never plumbing. "Isolated" meant two
incompatible things at once, and the ambiguity had a cost: `dispatch.ts`
resolved it by degrading an unpaired isolated dispatch straight back to shared,
so the request row read `isolated` and the completion row read `shared`. The
default was declared and not delivered.

The resolution is that the axis was misidentified. It is not *is there a pair?*
— that is a probabilistic sampling roll, which is no basis for deciding what
happens to someone's work. It is **who asked for the worktree**:

| origin | who chose it | merge-back |
|---|---|---|
| `requested` | the caller passed `--isolate` | **never** — the contract is *hold this out of my tree* |
| `kernel` | Fadeno, by default, pair or no pair | **always** — the caller asked for a dispatch, not a quarantine |

Under that split, kernel isolation with no pair stops being a third case
needing special handling and becomes the ordinary one. Isolation buys
containment during the run and concurrency against other dispatches; it was
never meant to change where the work ends up.

Four consequences worth stating, because each was a decision:

- **Every isolated worktree replays the caller's uncommitted state**, not just
  a paired one. `git worktree add` cuts a clean checkout of HEAD, so without
  the replay the executor solves a *different problem* than the one in the
  tree, and its diff then conflicts on work it never saw. Making `--isolate`
  differ here would also mean a flag documented as "already the default"
  silently handed the executor a different checkout — the shape of trap this
  codebase keeps paying for.
- **`ignored_output: kept` now withholds the worktree, not just the pair.** A
  merge-back is built by `git add -A`, which respects `.gitignore`. Isolating a
  `kept` dispatch would destroy exactly the output the policy exists to
  protect, so the dispatch stays shared and the refusal row says both things
  were given up.
- **`--isolate` outside a git repository refuses instead of degrading.** Kernel
  isolation may fall back to shared — nobody asked for it, and hard-failing
  would break dispatches that work today. An explicit containment request that
  quietly lands in the caller's tree is the opposite of what was asked for.
- **`shadow-apply --arm primary` refuses on a `clean` merge-back.** A primary
  can now carry both a `diff_snapshot` and an applied merge, a combination that
  could not previously exist, and re-applying is a no-op at best and a
  corruption on a tree that has moved.

A kernel isolation that cannot be built — `git worktree add` refused, an
uncarriable `worktree_carry:` path, a baseline that will not replay — still
degrades to shared, but only when the failure happened **before the spawn**
(nothing has run, so nothing is lost by re-running elsewhere) and only after
acquiring the workspace lease it now needs. If that lease cannot be taken, the
original isolation failure is raised rather than an unleased write performed.

### The engine

`drive`'s command attempts isolate on the same terms, and the `origin` split
above is what made that expressible: an engine attempt is always
kernel-isolated. There is no hold-out mode, and there should not be — a run's
members exist to produce work the run then consumes, so withholding a member's
output would leave the next step reading a tree the previous step did not
write.

That is what restores `--parallel`. Members hold no repo-wide lease, so they
overlap; where git cannot cut a worktree they all take the lease, serialize,
and the engine says so.

Four points where the engine differs from a dispatch, each for a reason:

- **The baseline is captured per attempt, not once per wave.** A shadow pair
  captures once because its two arms must start from byte-identical state.
  Engine members are not being compared, and a member admitted after an earlier
  one merged back must see that work rather than a snapshot predating it.
- **Capture and merge-back hold the writer lease, and wait for it.** Both touch
  the shared tree, and reading a tree mid-`git apply --3way` yields a
  half-applied patch. `acquireWorkspaceLease` refuses immediately when held,
  which is wrong here — contention is the normal case once members run
  concurrently, not an error — so the engine waits.
- **A merge-back that is not `clean` FAILS the attempt** (`merge_back_failed`),
  where a dispatch merely stamps it. The next step of a run reads the
  workspace, so an `actor_completed` over a diff that never applied would tell
  it the change is there. The diff artifact is durable and named on the
  receipt, so this is recoverable rather than merely reported.
- **An interrupted attempt's worktree is retained, not cleaned up.** A killed
  drive never collected the diff, so the worktree holds the member's work and
  nothing else does. The recovery receipt names it and leaves it alone.

The one remaining lease hazard is unchanged in kind and narrower in scope: the
`mkdir` lock is reclaimed only after 120s, and a hard-killed process can die
holding it. An isolated member now holds the lease only across its baseline
capture and its merge-back rather than for its whole run, so the window a kill
can land in is much smaller than it was — but smaller is not closed.

**A hazard that widened and then narrowed again.** The workspace lease is
guarded by a `mkdir` lock reclaimed only after 120s, and a hard-killed process
can die holding it, blocking the repo for two minutes. That was always true for
write deliveries. Making every *shared* delivery take the lease widened the
window a kill could land in; delivering isolation narrowed it back, because an
isolated delivery holds the lease only across its baseline capture and its
merge-back rather than for its whole run. The residual window is small and
real, and the 120s reclaim is still the only thing that closes it.

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

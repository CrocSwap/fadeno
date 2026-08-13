# Compositional runtime boundary

Status: **first host vertical slice shipped from dogfood evidence
(2026-08-04)**.

The five-item Luna/Terra dogfood exposed a structural limitation in the first
engine milestone: `map` was implemented as a special promptable actor fan-out,
while `loop` alone owned a body. That supports one batch-wide revision cycle,
but not independently advancing revision cycles per work item.

This boundary replaces special-purpose fan-out with recursively compositional
containers. It is intentionally narrower than a general scheduler: execution
remains repo-local, file-backed, bounded, and driven by `fadeno drive`.

## Decision

`map`, `replicate`, and `loop` instantiate arbitrary child node graphs. `join`
and `reduce` consume the resulting child-instance set. A child may itself be a
container, so both `map(loop(...))` and `loop(map(...))` are valid and have
different meanings.

Playbooks keep their flat declaration format. A container's `body` references
step definitions by id:

```yaml
- id: complete_items
  kind: map
  over: [item_1, item_2, item_3, item_4, item_5]
  as: item
  body: [revision_cycle]
  completion: all

- id: revision_cycle
  kind: loop
  body: [implement, review]
  max_iterations: 3
  input: [ReviewReport]
  until: no_blocking_issues
  on_success: completed_items
  on_exhausted: unresolved_items
```

A body definition has exactly one lexical owner. Reuse is expressed through a
`subworkflow`, not by attaching one step definition to multiple containers.
Container bodies are ordered graphs in the first implementation: their child
definitions may themselves be containers, but body children do not declare
edges outside their owning scope. Cycles remain legal only through `loop`.

## Runtime instances

A step definition is static. Every execution has a durable instance identity
derived from its containment path:

```text
complete_items[member=item_3]/revision_cycle[generation=2]/review
```

Every consequential event produced inside a compositional container records:

- `node_instance_id` — the complete stable instance path;
- `parent_instance_id` — the containing map member or loop generation;
- `member` when inside a map instance;
- `generation` when inside a loop instance.

`step_execution_id` remains the dispatch-facing identity and is derived from
the node instance rather than from only `(step, generation)`. `actor_call_id`
adds the role and retry lineage. This prevents collisions when five loop
instances are simultaneously at generation 2.

Artifacts are scoped by node instance. The default placement is structurally
derived rather than inferred from prose:

```text
artifacts/instances/
  complete_items/item_3/revision_cycle/g2/review/review-report.json
```

The manifest records `node_instance_id`, logical artifact type, map member, and
loop generation. Active-artifact resolution occurs within that scope first;
aggregation explicitly lifts child results into the parent scope.

## Execution semantics

The engine computes a **frontier** of runnable node instances, not one global
cursor. A drive invocation may dispatch every ready leaf in that frontier and
then exit while host-bound receipts are pending.

- `map`: instantiate its body once per member. Members advance independently.
- `replicate`: map the same body over generated attempt identities.
- `loop`: instantiate a new body generation only after the prior generation's
  deterministic `until` check fails. Each loop instance owns its own budget.
- `join`: wait for the declared child instances under its lexical scope.
- `reduce`: consume a collection projected from completed child instances.
- `subworkflow`: instantiate a referenced playbook as a child graph with the
  same identity and artifact-scoping rules.

Initial map completion modes are deliberately small:

- `all`: fail the container when any member terminates unsuccessfully;
- `collect`: wait for every terminal member and expose successes and failures.

Cancellation, `any`, quorum, speculative races, and dynamic work stealing stay
out of scope until dogfood produces evidence for them.

An outer-flow loop retains `on_success` and `on_exhausted` control-flow edges.
A loop nested in another container returns to that parent: success advances to
the next sibling, while exhaustion uses `exhaustion: fail|collect` (default
`fail`). Nested loops therefore never jump out of their lexical scope.

## Gates, decisions, and side effects

Gate discipline does not change: evaluator → structured artifact →
deterministic condition. A gate evaluates evidence in its node-instance scope.

A human gate inside a map pauses only that member. A run-level pause policy may
be added later, but must be explicit. Side-effecting tool calls inside a
container retain approval and idempotency requirements for every instance.

## Projection and verification

`fadeno show` starts from the declared graph and expands observed instances:

```text
complete_items · map<loop> · running
├─ item_1 · completed · 1 iteration
├─ item_2 · running · generation 2 · Terra review
├─ item_3 · completed · 2 iterations
├─ item_4 · blocked · generation 1
└─ item_5 · pending
```

Verification must recompute containment and reject:

- an instance whose parent was never instantiated;
- duplicate member or generation identity;
- events or artifacts attributed outside their lexical scope;
- a loop generation started before the prior condition failed;
- a member reported complete with incomplete children;
- aggregation that omits or substitutes a child result;
- dispatch identity that disagrees with its node instance.

Progress remains attested and non-gating. It is projected against
`node_instance_id`, allowing the director to distinguish five simultaneous
Terra sessions at the same logical `review` step.

## Compatibility

Legacy actor-list maps remain readable during the transition and normalize to
a map whose implicit body is one actor call per listed role. New compositional
maps require `body`. Node-instance fields are additive, explicitly verified
evidence in the existing 0.3 ledger envelope; events without them retain legacy
semantics and are never reinterpreted as compositional instances.

The shipped slice supports literal member lists, linear map/loop bodies,
deterministic loop conditions, collection inputs to reducers, and `host`
executor leaves. Dynamic maps, branchy bodies, member-scoped human gates,
replicate/subworkflow containers, and command-adapter leaves remain deferred.

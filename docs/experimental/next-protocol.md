# Fadeno next protocol — engine-backed, verification-centered

**Status:** approved implementable design boundary; not yet implemented or
schema-frozen
**Decision date:** 2026-07-14
**Relationship:** small promoted subset of
[`ontology-and-execution-design.md`](ontology-and-execution-design.md)
**Decision:** the next conforming run format is produced by a small deterministic
Fadeno engine. Instruction-only execution remains advisory and cannot claim the
same guarantees.

## Thesis

Fadeno should not compete as a general orchestration platform. Its engine exists
to produce complete, legible, internally verifiable evidence for portable agent
workflows.

Public description:

> Portable agent workflows with deterministic execution records and
> recomputable gates.

Internal architectural description:

> A repo-local, verification-centered playbook engine with harness adapters.

The engine is a library/CLI that reads playbooks, advances control flow, invokes
configured executor adapters, validates outputs, appends events, pauses at human
decisions, and resumes from `.fadeno/runs/`. It is a runtime. It is not a cloud
service, background daemon, scheduler platform, or model provider.

## Admission rule

An entity enters the next protocol core only when both are true:

1. **Receipt:** an observed Fadeno dogfood run or shipped verifier needed the
   distinction.
2. **Check:** `fadeno verify` can assert a meaningful property through
   recomputation, digest comparison, structural coherence, authorization, or
   idempotency.

Vision requirements and plausible future scenarios remain in the North Star
until they satisfy both conditions.

## Product invariants

1. Every consequential run claim is either deterministically verifiable,
   explicitly attested by an adapter, or visibly unverifiable.
2. The default run view grows with logical workflow progress, not raw event
   volume.
3. Playbooks contain semantic workflow definitions, not user model or harness
   choices.
4. Model judgment affects control flow only through a structured artifact and a
   deterministic predicate.
5. Retry, schema repair, executor substitution, and workflow iteration are
   distinct and visible.
6. Human decisions are durable, named, and idempotent.
7. Events and artifacts are append-only; later work supersedes rather than
   overwrites prior evidence.
8. Old document versions are rejected or read in an explicit compatibility
   mode, never silently reinterpreted.

## Scope: six promoted capabilities

### 1. Small deterministic engine

Promote the existing `fadeno next` cursor and driver procedure into code that
owns the run transition loop:

```text
load + validate playbook
        |
        v
compute next step
        |
        +-- actor step --> invoke configured executor --> validate output
        +-- tool step ----> invoke deterministic capability
        +-- gate ---------> recompute predicate
        +-- human gate ---> persist request, pause, return to host
        |
        v
append events + update projection + continue/resume
```

The engine may exit whenever it pauses. Durable files, not a resident process,
make the run outlive the host session.

The engine owns control transitions and ledger writes. Executor adapters own the
mechanics of invoking a harness. An adapter may be as small as a configured
one-shot command.

### 2. Runtime identity with flattened attempts

Add only the identities needed to disambiguate actual runs:

- `step_execution_id` — distinguishes loop generations and map members for one
  step definition;
- `actor_call_id` — groups the work requested of one role within a step
  execution;
- `attempt` — positive ordinal carried on dispatch/output events;
- `attempt_reason` — `initial`, `schema_repair`, `executor_override`, or
  `user_retry`.

`Attempt` is not a first-class lifecycle object in this protocol. Adapters do
not need to pretend they can observe `dispatching → running → validating`.
They record only facts they can witness:

- invocation started or failed to start;
- process/session exited successfully or unsuccessfully;
- output passed or failed validation.

One-shot CLI adapters and richer native adapters use the same minimum event
shape. Richer native lifecycle data is optional extension evidence.

An attempt is not a playbook loop iteration. Incrementing `attempt` never
increments loop generation.

### 3. Artifact manifests and digests

Every durable step output receives a manifest record containing at least:

```text
artifact_id
logical_name
path
sha256
media_type
schema (when typed)
step_execution_id
actor_call_id (when agent-produced)
attempt (when agent-produced)
generation/member (when applicable)
validation result
active/superseded relationship
```

Prompt snapshots already establish the pattern: record the exact inputs and
digests used for dispatch. The next protocol generalizes this to all artifacts.

Artifacts are immutable. Reconsideration, repair, and revision create a new
artifact id and path. A separate event changes which artifact is active for
downstream resolution.

### 4. Minimal execution profile and direct bindings

Move concrete model/harness choices out of playbook role prose:

```yaml
executors:
  architect-a:
    adapter: command
    command: [harness-a, run]
    model: user-model-a

  architect-b:
    adapter: command
    command: [harness-b, run]
    model: user-model-b

bindings:
  architect_primary: architect-a
  architect_independent: architect-b
```

The engine resolves direct bindings plus an explicit session override. It does
not implement capability eligibility, scored ranking, stickiness, cost routing,
or automatic fallback.

If a bound executor fails, the run pauses or fails. The user may explicitly
select another configured executor, producing a new attempt with
`attempt_reason: executor_override`.

Role capabilities may remain optional documentation metadata. The engine does
not enforce a capability vocabulary until a real routing scenario requires it.

The resolved binding is copied into dispatch evidence. `verify` checks that it
matches the snapshotted profile or an explicit override event.

### 5. One human-decision structure

Human gates use named options rather than a special approve/reject boolean:

```json
{
  "decision_id": "decision-1",
  "kind": "human_gate",
  "step_execution_id": "step-arbitrate-1",
  "prompt": "Choose how to proceed.",
  "options": ["consolidate", "revise", "stop"],
  "artifact_refs": ["artifact-cross-review-3"]
}
```

Resolution records one allowed option, optional feedback, and host/user
provenance. The first valid resolution wins; duplicate identical submissions
are idempotent and conflicting submissions fail verification.

Workflow selection remains a host-layer judgment, not an engine recommender.
The host records:

```text
source: explicit | suggested | generated
selected playbook snapshot digest
rationale (optional)
confirmation_decision_id (when confirmation was required)
```

Selection confirmation reuses the same human-decision structure. There is no
free `confirmed_by_user` boolean and no second decision system.

No `TaskProfile`, deterministic match score, or executor recommender enters this
protocol.

### 6. Canonical evidence, verification, and legible projection

Standardize the small set of events needed by the engine and verifier. Use one
canonical name for each fact. In particular, emit `artifact_created`; accept
`artifact_written` only through an explicit legacy reader until old fixtures are
regenerated.

`fadeno verify` must check at least:

- recognized document and event schema versions;
- parseable event stream and monotonic sequence numbers;
- unique runtime identifiers and valid parent relationships;
- every recorded artifact exists and matches its digest;
- typed artifacts pass their recorded schema;
- every supported gate result recomputes from the recorded artifact;
- completed-run gate coherence;
- active/superseded artifact resolution is unambiguous;
- attempt ordinals are contiguous within an actor call and redispatches carry an
  allowed reason;
- execution bindings match the snapshotted profile or explicit override;
- human decisions select declared options and resolve at most once;
- run terminal status agrees with terminal events.

Adapter attestations that cannot be independently recomputed must be labeled as
attested. Missing evidence must be reported as skipped/unverifiable rather than
silently treated as valid.

`fadeno show` is the human projection, not a dump of normalized events. By
default it shows logical steps, decisions, failures, active artifacts, and a
collapsed attempt count:

```text
✓ frame
✓ draft_approaches       2 actor calls
✓ cross_review           2 actor calls
✓ compare_options        2 attempts, 1 schema repair
! arbitrate              waiting for human decision
```

Raw events and attempt details remain available through explicit drill-down.

## Git and CI as the provenance anchor

Local run ledgers remain disposable working output. Requiring every local run to
be committed would create noise, repository growth, and secret-retention risk.

When a team wants a run to serve as review or merge evidence, it deliberately
admits a finalized trace into Git (or a committed evidence bundle) and runs
`fadeno verify` in CI against that commit. The commit SHA, code-review history,
branch protections, and CI result become the team-level provenance anchor.
Coherently changing both an artifact and its recorded claim then requires a new
Git change rather than an invisible local edit.

This is stronger than local consistency checking but should not be overstated:
Git provenance depends on repository policy, protected history, and trusted CI.
Hash chaining or signatures remain optional future mechanisms for standalone
evidence outside that boundary.

The product should distinguish:

- **local trace** — inspectable and internally verifiable, safe to delete;
- **admitted evidence** — committed or otherwise content-addressed and verified
  against a trusted commit/CI context.

Fadeno must provide redaction guidance before encouraging committed traces.

## Compatibility policy

There is no established user base justifying permanent ledger compatibility.

- Ledgers are regenerable output. New readers may reject old formats.
- `show` and `verify` refuse unknown/old versions unless an explicit legacy
  reader is selected.
- Existing dogfood and public demo traces are regenerated or pinned to their
  producing Fadeno version.
- Playbooks deserve slightly more care because `npx fadeno init` has been
  published and authored playbooks may exist unseen. Keep loud version checks
  and provide a cheap migration only if real fixtures justify it.
- Never silently reinterpret an old document.

## Explicitly out of scope

- Dynamic capability routing or eligibility checks
- Executor ranking, stickiness, automatic fallback, or cost optimization
- `TaskProfile` and deterministic workflow matching
- Host-attachment ownership transfer or presence protocols
- Cross-host conflicting-decision choreography beyond durable idempotency
- Full agent-session and tool-invocation lifecycle ontologies
- Required transcript capture
- Workspace strategy taxonomy or automatic worktree management
- Child-run/subworkflow runtime design
- Cloud service, daemon, remote scheduler, or provider integrations
- Cryptographic signatures or hash chaining

These remain North Star hypotheses. Dogfood receipts plus verifier checks can
promote them later.

## Dogfood before schema freeze

Run at least three materially different engine-backed workflows:

1. **Multi-executor architecture review** — direct role bindings, fan-out,
   structured cross-review, deterministic gate.
2. **Code change with repair** — invalid first output or schema repair proving
   attempt ordinal/reason is distinct from workflow iteration.
3. **Human pause/resume and executor override** — named decision, engine exit,
   resume from files, failed executor, explicit substitution.

For each run, verify both the happy trace and tampered fixtures:

- artifact bytes changed without manifest update;
- artifact or event deleted;
- gate result changed;
- duplicate/conflicting decision submitted;
- binding changed without override evidence;
- attempt incremented without a reason;
- terminal projection disagrees with events;
- legacy event name read without explicit compatibility mode.

Do not freeze schemas until the default `show` output remains readable and
`verify` catches every consequential inconsistency above.

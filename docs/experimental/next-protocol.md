# Fadeno next protocol — engine-backed, verification-centered

**Status:** approved implementation boundary; the 0.3 host-dispatch slice is
implemented and contract-frozen
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
- `output_extraction` — when present, deterministic normalization (`bom_trimmed`,
  `fenced`, `embedded`) that precedes `schema_repair`; `raw_output`,
  `raw_output_bytes`, `raw_output_sha256`, and `envelope_candidates` preserve the
  raw evidence and prove the normalized output is a contiguous substring of the
  raw bytes. A unique schema-invalid candidate may supply its Ajv errors to the
  existing repair appendix, but raw bytes and rejected-attempt evidence remain
  intact. Whole JSON that parses but fails schema remains a semantic failure and
  goes to the existing model repair.

`Attempt` is not a first-class lifecycle object in this protocol. Adapters do
not need to pretend they can observe `dispatching → running → validating`.
They record only facts they can witness:

- invocation started or failed to start;
- process/session exited successfully or unsuccessfully;
- output passed or failed validation.

One-shot CLI adapters and richer host adapters use the same minimum event
shape. Richer host lifecycle data is optional extension evidence.

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

### Host dispatch (format 0.3)

The host adapter is named `host`. When a host-bound actor call is planned,
`fadeno drive` records `host_dispatch_requested` and returns
`awaiting_host_dispatch` with a stable request id. The host owns
execution and submits receipts serially:

```text
dispatch-start <run> <dispatch-id> --agent-id <host-agent-id>
dispatch-complete <run> <dispatch-id> --output <temporary-file> [--commit <sha>]
dispatch-fail <run> <dispatch-id> --reason <text>
```

The coordinator delivers the immutable actor prompt in an envelope beginning
`# Fadeno engine step assignment` with both `run: <run-id>` and
`dispatch_id: <dispatch-id>`. The Codex steering preflight resolves the pair
with `fadeno steering resolve --archetype <a> [--host-executor <embedded-host>]`
`--run <run-id> --dispatch-id <dispatch-id>`. This request-locked path reads
the run's profile snapshot and rejects missing, terminal, duplicate, orphaned,
or mismatched evidence. It never consults ambient loadout state or routes a
host request through the command broker. Ordinary ad-hoc steering retains
ambient loadout precedence.

A snapshotted `agent_type: "*"` is an immutable wildcard, not a literal agent
name. It is used when the playbook role has no declared archetype and may be
specialized by locked steering to the concrete archetype receiving that host
request. A concrete snapshotted agent type still requires an exact match.

The start receipt appends the existing `actor_dispatched` event and records the
requested host model, reasoning effort, and agent type plus the supplied
agent identity. These are `requested_only`, not independently observed. A valid
completion is manifested at the planned immutable path; invalid bytes are
preserved under `artifacts/attempts/`. Repeated drives reuse request ids, and
repeated receipts are idempotent for the same host identity or output digest.
The director is the only ledger writer during this MVP. Format 0.2 and
unversioned ledgers are readable only through explicit compatibility mode, and
verifiers fail rather than ignore host lifecycle evidence in those ledgers.

### Command dispatch lifetime

Every command-backed engine attempt runs below the same process-group
supervisor used by ad-hoc dispatch. The `actor_dispatched` row names a
machine-local in-flight claim. If the engine process disappears, the
supervisor terminates the executor's whole process group. A subsequent drive
must not record `engine_interrupted` or begin a retry while that claim still
belongs to a live supervisor; only a settled or provably dead supervisor may
be recovered into a terminal interruption receipt.

Live cross-harness dogfood exposed a separate observability boundary: start and
terminal receipts do not reveal what an external session is doing. The
additive `host_dispatch_progress` event records provenance-labelled
agent/harness/director observations between start and terminal. Actor prompts
name an ephemeral JSON sidecar, and `fadeno show` projects its latest phase,
current action, blockers, and runtime onto the original workflow graph. These
observations are attested, not recomputable, and are forbidden as gate inputs.

### Deterministic tool execution (Priority 7 frozen contract)

`tool_call` steps name a logical capability (`tool: tests`), never shell. The
layered `executors.yaml` `tools:` registry binds each name to a static `command`
argv array with optional positive `timeout_ms`. Interpolation and shell are
rejected (`{`, `}`, `$`, backtick and empty args all fail validation). Only
ready `tool_call` steps whose declared artifact schema is `test-result` are
automated; `Diff`, `PostResult` and other typed outputs remain manual via
`fadeno tool-complete`.

`fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]` is the
deterministic helper and the engine's inline path (`fadeno drive` runs the same
code). It acquires the shared writer lease, mints a durable `tool-${run}-${id}-a<attempt>`
supervisor claim (exactly one attempt wins via atomic `link`), executes the
registered argv without a shell under the process-group supervisor (stripped
harness identity, bounded 32 MiB output, positive timeout or CLI override),
synthesizes a schema-valid `TestResult` (exit 0 → `passed`, nonzero → `failed`,
spawn/timeout/signal → `error` with `exit_code: null`), truncates `summary` to
4000 bytes and `details` to 32 KiB, writes the result atomically to the step's
versioned `artifacts/test-result.json` (or `artifacts/attempts/<id>-a<N>.json`
for infrastructure failures), and records `tool_dispatched` / `tool_completed`
or `tool_failed` plus `artifact_created` with `command_sha256` provenance. `--tool`
is a race guard that must equal the ready step; there is no `--command` escape
hatch.

`fadeno verify` must check at least:

- when a `TestResult` artifact is present, `status` coheres with `exit_code` (null → `error`, 0 → `passed`, otherwise `failed`) and `command_sha256` matches the snapshotted `tools:` binding (legacy ledgers skip both);
- when `output_extraction` is present, raw bytes hash to `raw_output_sha256`, the normalized output is a raw substring, and replay of `extractSchemaEnvelope` with the declared schema reproduces the same kind and payload digest;
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
- host dispatch requests are unique and have coherent request → start →
  terminal lifecycles;
- an earlier failed host attempt in a completed run is accepted only when the
  same actor call has a later, higher-ordinal valid successful retry; final,
  unresolved, invalid, later-failed, and cross-actor attempts remain failures;
- host prompt snapshots and successful output manifests match their digests;
- completed runs have no unresolved host requests;
- requested host model, effort, and agent type remain internally consistent
  with the profile and receipts; runtime identity is visibly skipped/unverified
  unless the host supplies independently observed metadata;
- human decisions select declared options and resolve at most once;
- run terminal status agrees with terminal events.

Adapter claims that cannot be independently recomputed must be labeled
`requested_only`, not verified attestation. Missing runtime identity evidence
must be reported as skipped/unverifiable rather than silently treated as valid.

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
- Cross-run child-ledger orchestration. In-run recursive container composition
  is now governed by
  [`compositional-runtime.md`](compositional-runtime.md), promoted from the
  five-item Luna/Terra dogfood evidence recorded on 2026-08-04.
- Cloud service, daemon, remote scheduler, or provider integrations
- Cryptographic signatures or hash chaining
- Parallel shared-writer lanes, auto-merge, playbook `workspace:` taxonomy,
  quorum/`any` completion, speculative races, and sibling cancellation remain
  out of scope; see the bounded wave deferral in
  [`compositional-runtime.md`](compositional-runtime.md) (`--parallel` classic-only,
  command-adapter leaves deferred over session-leakage and frontier ambiguity)

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

### Result (2026-08-22, fadeno 0.6.0-rc.57)

All three runs are done in `fadeno-demo` and verify clean. The tamper pass is
`scripts/tamper-matrix.mjs` (`npm run tamper -- <run-dir>…`), which copies a real
trace, applies one mutation per fixture, and asserts both that `verify` fails
and that the check which should have caught it is among the failures. **47
caught, 0 uncaught, 3 known gaps, 2 not applicable** across four traces. (The
gaps are closed as of rc.61 — see below; the matrix now also refuses to run
fixtures on a trace that fails `verify` untouched.)

Two checks were added because the tamper pass found them missing, and both were
found by fixtures that verified *clean* before the fix:

- **`event-vocabulary`** — renaming `artifact_created` to its pre-0.3 spelling
  `artifact_written` inside a 0.3 ledger made every artifact check stop seeing
  the artifact and `verify` report zero failures. An unrecognized event was
  dropped from consideration rather than refused, so an old name was a way to
  remove an artifact from the audit. `--legacy` remains how such a ledger is
  read: compatibility is opted into, never obtained by default.
- **`receipt-output-manifests`** — the same trick with a name in *no*
  vocabulary at all, which no list of names can catch. Anchors on the receipt
  instead: a delivery that claims an `output` must be accounted for by a
  manifest. The host lane already had this cross-check
  (`host-dispatch-artifacts`); the command and tool lanes did not.

`output_valid: false` exempts a receipt from that requirement, because a failed
attempt names the path it was *asked* for and the bytes are parked under
`artifacts/attempts/`. The exemption is only granted when a later attempt
supersedes the failed one — an escape hatch nobody can claim is not an escape
hatch, and without that condition one field would have excused any missing
artifact.

**Known gaps — held open until rc.61, then closed.** Two classes of artifact
carried no completion receipt, so `receipt-output-manifests` had nothing to
anchor on and either could be renamed out of the audit. The
`unreceipted-artifact-renamed` fixture measured this on every run and reported
it as a tracked gap rather than a pass:

1. **A tool result recorded by hand** with `fadeno tool-complete`, which
   emitted only `artifact_created` — no `tool_dispatched`, no
   `tool_completed` — so three tool checks skipped as well.
2. **An engine-assembled collective** (`artifacts/parts/<step>.json`). Each
   member's own part was receipted; the collective a gate then read was not,
   which made the artifact a gate depends on the one with the weakest
   provenance in the ledger.

Closing either meant emitting a receipt where none existed — a change to what
a command writes, and so a decision made deliberately **before** the freeze
rather than after it. Made in rc.61:

- **`tool_recorded`** (`recorded_by: host`) follows the manifest
  `fadeno tool-complete` writes. It is not `tool_completed` — that word
  means the kernel ran the tool and carries a command, exit code, and
  duration, none of which a hand-recorded result has — so the measured tool
  checks still skip for it, by the receipt's own name. `verify`'s
  **`tool-artifact-receipts`** requires every artifact on a `tool_call` step
  to be claimed by one of the two, and holds a recorded receipt's digest to
  the manifest and the bytes.
- **`collective_assembled`** (`assembled_by: engine`) names the parts in
  order. `verify`'s **`collective-provenance`** reduces those parts again
  through the one `reduceCollective` both sides share and refuses a
  collective that does not come out identical — bytes, manifest digest, and
  receipt digest all held to the recomputation, which is what a gate's input
  needs. Presence is read from the playbook snapshot by the flow cursor's
  rule (an artifact on a map step that no member produced is the collective),
  so dropping the receipt is not a way back.

On a trace written since, `unreceipted-artifact-renamed` finds nothing to
mutate, and six fixtures that attack the receipts directly are all caught. A
ledger written before rc.61 fails `verify` wherever it has either artifact
class; the message says so and asks for the trace to be regenerated.

**The schema-repair path has no live coverage.** Item 2 above asks for a run
that proves the attempt ordinal and reason are distinct from the workflow
iteration. That is proven: real traces carry `attempt 2 [executor_override]`
(a substitution after a genuine executor failure) and `attempt 2 [user_retry]`
(after a provider capacity limit). But no run produced a `schema_repair`, and
one probe was built specifically to try: four dispatches at `gemini@low`, the
weakest model the backend publishes, on schema-typed evaluator steps. All four
returned valid reports. The reason is structural — the realistic failure mode is
valid JSON *wrapped* in prose or a fence, and envelope extraction absorbs that
one layer earlier. That probe is the first trace where `envelope-extraction`
verified a real extraction rather than skipping. The repair loop should be
described as synthetic-test-covered, not field-proven.

#### Field finding (2026-08-22): a dispatch proxy relayed a deadline kill as "completed"

Not from the dogfood runs — from a second harness session using the dispatch
proxies on its own work, reported the same day. One `fadeno:worker` dispatch
(worker → an external executor via codex) was SIGTERMed at the 20-minute route
deadline; its merge-back then refused because the directory it had edited was
untracked in the caller's workspace; and the proxy reported "completed" with a
0-byte attested output. Six reviewer dispatches ran through the same proxies,
two of which also hit the deadline — one still delivered a full report.

The kernel's row was right the whole time: `outcome: timeout`, `signal:
SIGTERM`, `output_bytes: 0`, `primary_merge.status: conflicted`. What was wrong
was every surface the proxy could reach. Three defects, two fixed (rc.58):

- **`fadeno dispatches --output` did not carry the verdict.** The recovery
  reader loaded only `completed` and `output_sha256` and printed `output
  attested: sha matches the completion row` — true of a killed executor, since
  empty bytes hash to an empty row. The proxy template then asked it to
  "report the exit code recorded", a fact the command never printed. The
  verdict (`TIMED OUT` / `FAILED` / `NO OUTPUT` / `ok`) now leads the note,
  followed by any merge-back that did not land, then the attestation; the
  templates name those words and say that attestation is not one of them. The
  same silent-wrong-answer shape as every other finding in this file: one fact
  recorded correctly, the consumer that mattered reading a different one.
- **One untracked path dropped the whole merge-back.** The baseline commits
  the caller's untracked files into the worktree, so the attempt's edit to one
  is a tracked-file modification in the diff; `git apply --3way` implies
  `--index`, has no entry, and refuses the entire patch — tracked hunks
  included — while the receipt said `conflicted` about an untouched tree. See
  `permissions-and-isolation.md` for the working-tree fallback; both
  merge-backs now share one helper.
- **The 20-minute ceiling — decided: there is no default deadline (rc.59).**
  `timeout_ms: 1200000` was on every command route and the proxy contract call
  could not lift it, so a worker pass through the proxy could not exceed 20
  minutes. Talked through rather than patched: agent work has a long tail and
  a clock cannot tell slow from stuck, and the only thing the deadline ever
  protected was what a hung executor *holds*. An isolated executor holds its
  own worktree and nothing else — no lease, no shared tree — so the cost of a
  hung one is a directory and a provider bill, both visible in `fadeno show`,
  both ended by `fadeno cancel`. The template declares no `timeout_ms`;
  `--timeout` is opt-in. The kernel's own brief holds on the shared tree (a
  baseline capture, a merge-back) are the only place a clock remains, and it
  bounds *waiting for a turn* (30 s), never anyone's work; those windows now
  carry the kernel's pid, which closed the immortal-lease bug behind the
  `kill-drive mid-wave` failures. Shared mode (`--shared`, tools, non-git)
  still holds the real lease for a run's duration and is opt-in.
- **Every artifact has a receipt (rc.61), and two receipt events are in the
  ledger vocabulary before the freeze:** `tool_recorded` (a host recorded a
  tool result by hand; `recorded_by: host`) and `collective_assembled` (the
  engine reduced a map's parts; `assembled_by: engine`). `verify` holds both
  (`tool-artifact-receipts`, `collective-provenance`), and the tamper matrix's
  last known gap is closed. See §Result above.
- **Merge-back is a pull request now (rc.60), and two attempt reasons are
  in the ledger vocabulary before the freeze:** `merge_conflict` (the executor
  re-invoked in its retained worktree to resolve markers) and `host_resolved`
  (a human resolved them and `fadeno attempt-accept` merged the result). Both
  pair with the `unresolved` failure they follow, and `verify`'s
  `merge-conflict-rounds` holds them to it. The caller's tree never receives
  anything but a plain, atomic `git apply`; `conflicted` is retired. See
  `permissions-and-isolation.md`.

One more observation from that loop worth keeping: the external reviewer's
sandbox could not open loopback listeners, so it never ran the socket tests,
and every "gate green" in that loop rested on the caller's own test runs. A
reviewer that cannot run the tests it is reviewing is a known limitation of
routing review outward; nothing in Fadeno claims otherwise, but nothing
surfaces it either.

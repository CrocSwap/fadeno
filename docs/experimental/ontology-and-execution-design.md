# Fadeno ontology and execution design

**Status:** North Star design; explicitly not the next implementation scope
**Target:** long-horizon vocabulary tested through dogfood before promotion
**Method:** derive the ontology from likely user workflows and desired user
experience, then define the smallest portable model that explains them.

The implementable subset is defined separately in
[`next-protocol.md`](next-protocol.md). A concept in this document does not enter
the protocol merely because it is well defined.

Evidence labels used for scope decisions:

- **Observed** — required by an actual Fadeno dogfood run or shipped verifier;
- **Vision requirement** — explicitly required by the intended product
  experience but not yet demonstrated;
- **Hypothesis** — plausible future need awaiting a receipt;
- **Deferred** — intentionally excluded from the next protocol.

Admission to the protocol core requires both **a receipt and a check**: an
observed run must need the concept, and `fadeno verify` must be able to assert a
meaningful property about it through recomputation, digests, structural
coherence, authorization, or idempotency.

## 1. Purpose

Fadeno began as a portable, instruction-driven playbook protocol. The next
product horizon is broader:

- a user works from a harness they already know;
- the user can name a playbook, describe a workflow in natural language, or
  simply give the system a task;
- Fadeno recommends or constructs an appropriate workflow;
- one run may use multiple models, harnesses, and execution environments;
- model and harness preferences remain separate from reusable playbooks;
- the top-level harness remains the place where the user sees progress, inspects
  work, steers the run, and answers human gates;
- the run remains transparent and auditable down to an individual actor call;
- the same playbook definition may remain interpretable on an instruction-only
  host, but only an engine-backed execution can claim conformance to the next
  run contract.

This vision requires more than adding model names to `roles`. It requires a
portable workflow ontology, an execution-binding ontology, a runtime instance
model, and a host interaction protocol. Those layers must remain distinct.

The next run contract is explicitly **engine-backed**. Fadeno grows a small,
deterministic, repo-local driver from the existing `next` + driver work. This is
a runtime, but not a cloud service, background daemon, or model provider. An
instruction-only runner may consume a playbook as an advisory compatibility
mode; it cannot claim the same execution guarantees.

## 2. Design method: scenarios before nouns

The ontology is tested against the following scenario corpus. A concept should
enter the portable core only if one or more scenarios need it and it composes
cleanly with the others.

### S1. Small direct task

The user asks for a one-file typo fix. The system should not impose a five-agent
workflow merely because playbooks exist. It either proceeds directly or offers a
minimal workflow only when repository policy requires one.

**Pressure:** workflow selection must support "no playbook" and must account for
cost and ceremony.

### S2. Nontrivial code change

The system plans, implements, reviews, tests, revises once if necessary, and
summarizes. The same harness may perform every role.

**Pressure:** semantic roles cannot imply separate models or native subagents.

### S3. Diagnose and repair

The system captures a failure, reproduces it, investigates a cause, implements a
minimal fix, and verifies a regression test. Reproduction can fail because the
environment is unavailable rather than because the bug does not exist.

**Pressure:** step failure, predicate failure, blocked execution, and workflow
branching are different states.

### S4. Design, review, and human approval

Several agents draft or compare designs. A reviewer produces a structured
report; a deterministic gate checks it; the user approves the resulting plan.

**Pressure:** model judgment, deterministic control flow, and human authority
must remain separate.

### S5. PR or security review

Independent reviewers inspect the same diff from different perspectives. The
system merges their findings and asks before posting externally.

**Pressure:** logical fan-out is not necessarily concurrent execution; an
external-send permission approval is not the same as a playbook decision.

### S6. Research synthesis

The system decomposes a question, gathers evidence per subquestion, synthesizes
it, and checks claims. Some workers need web access; others do not.

**Pressure:** roles require capabilities, and hard capabilities differ from
quality or cost preferences.

### S7. Batch migration

The system inventories targets, applies a transformation to each, records
exceptions, runs broad verification, and reviews the result. Concurrent writers
could conflict in one working tree.

**Pressure:** `map` describes logical multiplicity, while scheduling,
concurrency, and workspace isolation are execution policy.

### S8. Multi-model architecture and build

Two architects in different harnesses independently propose designs, cross-review
them, converge within bounded rounds, and hand specifications to faster builder
agents. A final reviewer uses another preferred executor.

**Pressure:** playbook roles must bind to user-specific executors at run time;
bindings may vary by role, iteration, availability, and user override.

### S9. Release readiness and deployment

The system gathers checks, produces a readiness report, asks the user, and only
then invokes a deploy capability. The harness may independently ask for a tool
permission approval.

**Pressure:** a workflow `human_gate` and a harness `ToolApproval` are distinct
events even when they appear adjacent in the UI.

### S10. Pause, close, and resume elsewhere

A run reaches a human decision after the originating harness session closes. The
user reopens the repository in another supported host and resumes.

**Pressure:** run state and pending decisions must be durable; a host session is
an attachment to a run, not the run itself.

### S11. Inspect and steer an actor call

During or after `compare_options`, the user asks what that agent received, which
tools it used, what it returned, and why it rejected an option. The user then
asks it to reconsider under a new constraint.

**Pressure:** step, actor call, attempt, agent session, response, artifact, and
trace must be separately addressable. Steering creates new history; it does not
overwrite old history.

### S12. Executor unavailable or output invalid

The preferred model is unavailable, unauthenticated, over budget, or returns an
artifact that fails validation. Policy may permit fallback, require the user to
choose, or fail the step.

**Pressure:** routing, dispatch, validation retry, and semantic workflow retry
are distinct. Fallback must be visible in the trace.

### S13. Natural-language or ephemeral workflow

No installed playbook matches. The system proposes an ad hoc workflow, shows the
important gates and expected cost/actors, executes it after any required
approval, and offers to save it afterward.

**Pressure:** a run must carry an immutable playbook snapshot regardless of
whether its source was shipped, repository-defined, or generated for one run.

### 2.1 Evidence classification

| Scenario/concept | Evidence tier | Consequence |
|---|---|---|
| S2 code change, role separation, bounded review | Observed/shipped | May inform the core |
| S4/S8 dual architects, cross-review, early human arbitration | Observed dogfood | Direct receipt for role/executor separation and named decisions |
| Prompt snapshots, member attribution, schema repair versus loop revision | Observed implementation friction | Direct receipt for runtime identity, digests, and flattened attempt reasons |
| Gate recomputation, trace tampering, terminal coherence | Observed verifier behavior | Product center and admission check |
| S3, S5, S6, S7, S9 | Representative/shipped-pattern evidence, not user evidence | Validate vocabulary but do not independently justify new runtime entities |
| S1 automatic task-to-workflow suggestion | Vision requirement | Keep in host-layer design; not next-protocol routing machinery |
| S10 cross-host ownership transfer | Hypothesis | Durable file resume is in scope; attachment ownership protocol is deferred |
| S11 rich inspection and steering | Vision requirement | Preserve addressability; defer full session/trace ontology |
| S12 smart fallback/routing | Hypothesis beyond explicit override | Record explicit override; defer automatic routing |
| S13 ephemeral natural-language workflows | Vision requirement | Snapshot selected/generated playbook; defer recommender ontology |

This table is intentionally stricter than the scenario list: scenarios test the
North Star, while receipts determine the implementable protocol.

## 3. The six-layer model

```text
User intent
    |
    v
Workflow selection       TaskProfile, PlaybookCandidate, SelectionPolicy
    |
    v
Workflow definition      Playbook, Role, Step, ArtifactContract, Policy
    |
    v
Execution binding        Requirements, Executor, RoutingRule, Binding
    |
    v
Runtime execution        Run, StepExecution, ActorCall, Attempt, Decision
    |
    +-------------------> Trace, ArtifactInstance, Usage, Provenance
    |
    v
Host interaction         HostAttachment, human decisions, inspection, steering
```

The layers may be implemented in one process, but their meanings must not be
collapsed.

### 3.1 Product invariants

1. Every consequential run claim is either deterministically verifiable,
   explicitly attested by an adapter, or visibly unverifiable.
2. The default run view grows with logical workflow progress, not raw event
   volume.
3. Playbooks are provider-, model-, and harness-neutral.
4. Roles express semantic responsibility; execution profiles bind them to
   concrete executors.
5. Model judgment enters control flow only through structured artifacts and
   deterministic predicates.
6. Human decisions are explicit, durable, and delivered through the run's host
   attachment.
7. Workflow history is append-only. Retry, revision, fallback, and steering
   create new identified instances.
8. Every fan-out and loop is bounded before execution.
9. Capability, permission, trait, and role are different concepts.
10. Logical fan-out does not promise concurrency; scheduling and workspace
   safety belong to execution policy.
11. Executor fallback is never silent.
12. A run outlives host sessions and agent sessions.
13. Inspection exposes observable instructions, actions, outputs, and
    provenance without promising private chain-of-thought.
14. An instruction-only execution is advisory and cannot claim engine-backed
    conformance merely because it uses the same playbook definition.

### 3.2 User-experience defaults

- The user stays in their chosen top-level harness.
- Fadeno does not require executor configuration before it is needed. It
  discovers eligible choices, uses clear defaults, and asks only on ambiguity or
  policy boundaries.
- A workflow suggestion states the reason, major stages, expected actor calls,
  likely cost/latency class when known, and human gates. It does not begin with
  ontology jargon.
- Trivial tasks remain trivial; "no playbook" is a successful selection.
- During a run, the default view is concise status. Step, actor-call, attempt,
  artifact, and trace detail appear through progressive drill-down.
- Human gates return to the top-level session with the relevant artifact and
  consequences, not merely an approve/reject prompt.
- "Remember this choice" writes inspectable configuration with provenance.
- A user can inspect, pause, cancel, retry, or steer without corrupting prior
  history.
- Missing capabilities or unavailable executors produce an actionable choice:
  use a declared fallback, choose another eligible executor, wait, or stop.

## 4. Normative glossary

### 4.1 Intent and selection

**Task**
The user's requested outcome. A task is not a workflow and may be handled
without a playbook.

**TaskProfile**
A structured characterization of a task: kind, scope, risk, required
capabilities, likely deliverables, and confidence. A model may produce it, but
it is an artifact rather than a control-flow decision.

**PlaybookCandidate**
One installed or generated playbook considered for a task, with a deterministic
match score and reasons.

**SelectionPolicy**
User or repository policy controlling whether Fadeno only suggests, may
auto-start low-risk matches, or must always ask.

**PlaybookOrigin**
Where a definition came from: shipped library, repository, user library, remote
catalog, or ephemeral generation.

### 4.2 Portable definitions

**PlaybookDefinition**
A reusable, provider-neutral workflow definition.

**PlaybookSnapshot**
The immutable bytes and digest of the definition used by one run. Every run has
exactly one root snapshot, including ephemeral runs.

**Role**
A semantic responsibility in a playbook, such as `implementer` or
`substance_reviewer`. A role is not a model, agent process, subagent, harness, or
configured endpoint.

**StepDefinition**
A logical node in a playbook. It defines work, orchestration, evaluation, or
control flow. It is not itself a subagent invocation.

**ArtifactContract**
The expected type, media type, schema, and authoring instructions for a durable
output.

**GateCondition**
A named deterministic predicate over one or more schema-valid artifacts.

**WorkflowPolicy**
A portable constraint on workflow behavior, such as a maximum number of actor
calls or a required human decision before an external send. It does not grant a
harness permission.

### 4.3 Requirements and routing

**Capability**
An objective operation or environment feature an executor can provide, such as
`repository_read`, `repository_write`, `shell`, `web_research`, `browser`,
`vision`, or `structured_output`.

**Permission**
Authority granted for a run, actor call, or tool invocation. Capability answers
"can"; permission answers "may".

**Trait**
A non-binary routing attribute or declared strength, such as coding quality,
reasoning depth, latency class, or cost class. Traits are preferences or scored
attributes, not hard capabilities.

**RoleRequirements**
The capabilities, permissions, context needs, and optional traits required or
preferred when performing a role. Requirements are portable and may live with
the playbook.

**Provider**
The service or organization through which a model is accessed and billed.

**Model**
A generation model identifier understood by an executor adapter. Fadeno treats
the identifier as opaque configuration and does not infer undocumented model
properties from its name.

**Harness**
An agent product or runtime that manages a model session, tools, context, and
possibly native child agents.

**Executor**
A user-configured, routable endpoint capable of performing actor calls. It
combines an adapter, harness or provider access path, model selection, execution
environment, capability declaration, and non-secret authentication reference.

**ExecutorAdapter**
The implementation that dispatches, observes, steers, and cancels work on an
executor.

**ExecutionProfile**
A user- or repository-scoped set of executors, routing preferences, fallback
rules, budgets, retention policy, and workspace policy. It is not part of a
portable playbook.

**RoutingRule**
A rule that ranks eligible executors for a role or capability class.

**ExecutionBinding**
The concrete executor, model, environment, and policy resolution selected for
one actor-call attempt. A binding is immutable once that attempt starts.

### 4.4 Runtime instances

**Run**
One execution of a playbook snapshot for a task. A run owns durable state and
can outlive any host or agent session.

**ChildRun**
A run created by a `subworkflow` step, linked to its parent run and parent step
execution. It has its own playbook snapshot, state, events, and artifacts while
appearing nested in the parent's run view.

**StepExecution**
One runtime occurrence of a step definition. Loops, maps, retries, and
subworkflows mean a step definition can have many step executions.

**ActorCall**
A logical request for a role to perform work within one step execution. An actor
call may have multiple attempts but has one semantic purpose and output
contract.

**Attempt**
One dispatch attempt for an actor call. An attempt has exactly one execution
binding and at most one primary agent session. Schema-repair redispatch,
executor fallback, and explicit retry create new attempts.

**AgentSession**
A concrete conversation or agent process managed by an executor. It may contain
multiple model turns and tool invocations. It may be a native subagent, a
top-level harness thread, a CLI one-shot, or a direct provider-backed session.

**ToolInvocation**
One observable request to a tool or capability. It belongs to a step execution
or agent-session attempt.

**ArtifactInstance**
An immutable durable output with identity, contract, digest, provenance, and a
storage reference. A revision creates a new artifact instance.

**AgentResponse**
The raw final response returned by an agent session. It is not automatically the
workflow artifact; adapters may validate or transform it into an artifact
instance according to an explicit contract.

**JudgmentArtifact**
A structured artifact produced by an evaluator. It contains model judgment but
does not itself select a control-flow branch.

**GateEvaluation**
The deterministic application of a gate condition to validated artifact
instances. It records the predicate version, inputs, result, and resulting
branch.

**HumanDecisionRequest**
A durable, pending request for human authority or preference at a playbook
`human_gate`.

**HumanDecision**
The immutable resolution of a human decision request, including selected
option, optional feedback, provenance, and timestamp.

**ToolApproval**
A harness or environment permission decision for a tool action. It is not a
playbook human gate and must be recorded separately.

**RunDirective**
A user instruction issued while a run is active, such as pause, resume, cancel,
retry, change a constraint, or reconsider an artifact. It is not silently
rewritten into a past step.

### 4.5 Observation and provenance

**Event**
An immutable, typed fact appended to a run's history.

**Trace**
An ordered view of observable events for a run, step execution, actor call,
attempt, or agent session.

**InvocationRecord**
The effective inputs, instructions, binding, policy, and digests used to start
an attempt.

**EffectiveInstructions**
The inspectable instruction bundle actually presented to an executor, including
role instructions and referenced artifacts. It excludes hidden provider
instructions that the adapter cannot observe.

**ExecutionSnapshot**
The resolved playbook digest, configuration provenance, routing decisions, and
policy versions needed to explain a run.

**UsageRecord**
Available token, time, cost, or resource data associated with an attempt. Fields
may be unknown when an executor does not expose them.

**NativeTraceReference**
An optional deep link or opaque reference to a harness-native session trace.

### 4.6 Host interaction

**HostSession**
A user-facing conversation in a harness. It is not the run and may disappear.

**HostAttachment**
A revocable association between a run and a host session that can display
events, deliver decisions, accept directives, and inspect artifacts.

**HostBridge**
The adapter that implements host attachment behavior for a harness.

The term **Actor** should not remain a standalone runtime entity. In prose it is
too easily confused with a role, model, subagent, or session. Use `Role`,
`ActorCall`, or `AgentSession` depending on what is meant. The existing YAML
field `actor` can remain as an author-friendly reference to a role.

## 5. Core relationships and cardinalities

```text
Task 1 -------- 0..1 TaskProfile
Task 1 -------- 0..* PlaybookCandidate

Run 1 --------- 1 PlaybookSnapshot
Run 1 --------- 1 ExecutionSnapshot
Run 1 --------- 0..* HostAttachment
Run 1 --------- 0..* StepExecution
Run 1 --------- 0..* ChildRun; ChildRun has exactly 1 parent Run

StepDefinition 1 ---- 0..* StepExecution
StepExecution 1 ----- 0..* ActorCall
StepExecution 1 ----- 0..* ToolInvocation
StepExecution 1 ----- 0..* ArtifactInstance

ActorCall 1 --------- 1..* Attempt
Attempt 1 ----------- 1 ExecutionBinding
Attempt 1 ----------- 0..1 primary AgentSession
Attempt 1 ----------- 0..* ToolInvocation
Attempt 1 ----------- 0..1 final AgentResponse
Attempt 1 ----------- 0..* ArtifactInstance

HumanDecisionRequest 1 ---- 0..1 HumanDecision
GateEvaluation 1 ---------- 1..* input ArtifactInstance
ArtifactInstance * -------- 1 producing StepExecution or Attempt
```

An attempt can have no agent session when dispatch fails before session
creation. An actor call has multiple attempts only when policy permits retry or
fallback. An agent session may contain several turns, but changing executors or
models always creates a new attempt.

## 6. Step taxonomy

The author-facing primitives can remain compact, but the ontology groups them by
semantics:

### Work

- `actor_call` — request role-performed work;
- `tool_call` — invoke a logical capability;
- `artifact_op` — deterministic artifact operation;
- `subworkflow` — create and await a linked child run using another playbook
  snapshot.

### Judgment and decision

- `evaluator` — specialized actor call producing a judgment artifact;
- `gate` — deterministic predicate and branch;
- `human_gate` — durable human decision and branch;
- `router` — branch on structured non-judgment data using declared rules.

### Multiplicity and aggregation

- `map` — expand an operation over distinct inputs or members;
- `replicate` — create independent attempts at the same semantic work;
- `join` — wait for declared dependencies;
- `reduce` — combine multiple artifacts, possibly through an actor call.

### Iteration

- `loop` — bounded repetition of a declared body with explicit success and
  exhaustion exits.

`evaluator` and `reduce` are not unique execution mechanisms; they specialize
an actor call's artifact contract and purpose. `map`, `replicate`, and `loop`
expand definitions into runtime instances. A future engine should compile the
author-facing YAML into a normalized internal graph rather than make every
adapter reinterpret these distinctions independently.

Logical multiplicity never promises simultaneous execution. Actual concurrency
is selected by the execution profile and constrained by executor capacity,
workspace isolation, dependency order, and policy.

A `map` or `replicate` has one container step execution and distinct member
actor calls or child step executions beneath it. A loop has one controlling step
execution plus generation-scoped body step executions. This preserves the
author's logical node while making every repeated unit individually inspectable.

A `subworkflow` creates a child run rather than inlining unscoped steps into its
parent. The parent step waits for the child terminal state and imports only the
declared result artifacts. Configuration inheritance and overrides are recorded
in the child execution snapshot.

## 7. Lifecycle state machines

### 7.1 Run

```text
created -> running -> completed
              |  \-> failed
              |  \-> aborted
              |  \-> paused
              |  \-> waiting_human -> running
              |  \-> blocked       -> running | failed | aborted
              \--------------------> aborted
```

- `paused` is an intentional user or policy pause.
- `waiting_human` means a durable human decision request is pending.
- `blocked` means progress requires an unavailable executor, permission,
  environment, input, or external condition.
- terminal statuses are `completed`, `failed`, and `aborted`.

### 7.2 Step execution

```text
pending -> ready -> running -> completed
                     |  \----> failed
                     |  \----> waiting
                     |  \----> cancelled
                     \-------> skipped
```

`waiting` covers joins, human decisions, tool approvals, and subworkflow waits;
the reason is a required structured field. `skipped` requires a control-flow
reason, not omission.

### 7.3 Actor call and attempt

```text
ActorCall: planned -> routing -> running -> succeeded
                    |           |  \-----> failed
                    |           \--------> cancelled
                    \--------------------> blocked

Attempt:  dispatching -> running -> validating -> succeeded
             |            |           \--> invalid_output
             |            \--------------> execution_failed
             \---------------------------> dispatch_failed
```

An `invalid_output` attempt can lead to a new schema-repair attempt. An
`execution_failed` or `dispatch_failed` attempt can lead to retry or fallback.
These transitions do not count as a playbook loop iteration unless the playbook
itself says so.

### 7.4 Human decision

```text
requested -> presented -> resolved
     |           |  \----> withdrawn
     \-------------------> cancelled_by_run
```

The request remains durable if no host is attached. Attaching another host can
present the same request. Resolution is idempotent; conflicting second answers
are rejected and recorded as attempted conflicts.

## 8. Workflow selection

Workflow selection should be helpful without turning every task into ceremony.

1. A task analyzer may produce a schema-valid `TaskProfile`.
2. A deterministic matcher compares that profile with playbook metadata,
   repository policy, required capabilities, and estimated workflow overhead.
3. Selection policy determines whether to proceed directly, suggest one or more
   candidates, auto-start a safe strong match, or ask.
4. The selected or generated definition is snapshotted into the run.

Recommended policy modes:

- `suggest` — recommend but never auto-start;
- `auto_safe` — auto-start only beneath configured risk and cost thresholds;
- `always_ask` — require selection confirmation;
- `disabled` — only explicit playbook requests use Fadeno.

"No playbook" is a valid matcher result. A generated workflow should be
ephemeral by default and offered for explicit saving only after the run.

The matcher must expose reasons, not just a score: matched task kind, risk,
required deliverables, repository policy, and estimated overhead.

## 9. Role requirements and executor routing

Portable playbooks express requirements, not subscriptions or model names:

```yaml
roles:
  implementer:
    purpose: Implement an approved specification.
    requires:
      capabilities: [repository_read, repository_write, shell, test_execution]
    prefers:
      traits: [strong_coding]
```

Execution profiles describe concrete choices:

```yaml
executors:
  preferred-coder:
    adapter: installed-harness-a
    harness: harness-a
    model: user-configured-model
    auth: account-reference
    capabilities: [repository_read, repository_write, shell, test_execution]
    traits: [strong_coding]

routing:
  roles:
    implementer:
      prefer: [preferred-coder]
  traits:
    strong_coding:
      prefer: [preferred-coder]
```

Model identifiers and authentication references are opaque. Credentials never
appear in playbooks or run traces.

### 9.1 Minimum capability vocabulary

The core vocabulary should describe objective access and operations only. It
should be small, with namespaced extensions for domain-specific capabilities.

Recommended portable core:

| Group | Capabilities |
|---|---|
| Repository | `repository_read`, `repository_write`, `diff_read` |
| Execution | `shell`, `test_execution`, `build_execution` |
| Information | `web_research`, `private_source_read` |
| Interaction | `browser_interaction`, `computer_interaction` |
| Media | `image_input`, `image_generation` |
| Output | `structured_output`, `artifact_read`, `artifact_write` |
| External effects | `external_send`, `deploy`, `secret_access`, `data_delete` |

Capabilities describe what an executor adapter can technically offer. Sensitive
capabilities such as `external_send` and `secret_access` still require policy and
permission checks. A declaration is not authority.

Namespaced extensions use identifiers such as `github:pr_comment`,
`ios:simulator`, or `org.example:warehouse_query`. Unknown optional capabilities
can be ignored; unknown required capabilities make an executor ineligible.

The following are deliberately **not** capabilities:

- `strong_coding`, `deep_reasoning`, `fast`, `cheap` — traits;
- `trusted`, `approved`, `allowed` — policy or permission state;
- `worker`, `reviewer`, `architect` — roles;
- `codex`, `claude`, or a model name — harness/model identity;
- `native_subagents` — an adapter scheduling feature unless a workflow truly
  requires native child-session semantics, which portable playbooks normally
  should not.

### 9.2 Resolution precedence

From highest to lowest:

1. explicit override for this actor call or run;
2. repository policy constraints;
3. repository routing preferences;
4. user routing preferences;
5. eligible executor ranking by capabilities and traits;
6. host-local default;
7. ask the user or block, according to policy.

Repository constraints may remove an executor from consideration but should not
silently rewrite a user's personal preference file.

### 9.3 Eligibility and ranking

Routing occurs in two phases:

1. **Eligibility:** required capabilities, permissions, environment, data
   locality, policy, and availability must pass.
2. **Ranking:** explicit role preference, traits, cost, latency, prior stickiness,
   and fallback order rank eligible executors.

Qualitative traits must not masquerade as verified facts. They are declared user
preferences or adapter metadata with provenance.

### 9.4 Stickiness and fallback

Each actor call resolves independently, but the default is sticky routing for the
same role during a run. A different binding is allowed when:

- the playbook addresses distinct role members;
- the user overrides it;
- the prior executor becomes unavailable;
- budget or policy requires a change;
- the workflow explicitly requests independent heterogeneous attempts.

Fallback creates a new attempt and a visible `binding_changed` event. It never
changes the binding of a running attempt.

### 9.5 Workspace policy

Executor routing also resolves an execution environment. Recommended strategies:

- `shared_read_only` — safe fan-out over one repository;
- `shared_serial_write` — writers share a tree but never run concurrently;
- `isolated_worktree` — each writer receives an isolated worktree;
- `external_workspace` — the harness owns workspace isolation;
- `artifact_only` — the session cannot access the repository directly.

This belongs in execution policy, not in `map` or `replicate` semantics.

## 10. Host interaction contract

A run has zero or more host attachments and at most one active interaction owner
for decisions and directives. The owner may transfer when the original host
disconnects.

The host bridge should support, when available:

- subscribe to run events;
- render a run/step tree;
- present a human decision request;
- submit an idempotent decision;
- inspect artifacts, actor calls, attempts, and traces;
- issue pause, resume, cancel, retry, and reconsider directives;
- deep-link to native agent sessions;
- report host disconnection and reattachment.

The minimum fallback is textual: the driver pauses, returns a structured pending
decision to the top-level session, and is redispatched after the answer. A native
host bridge can render the same protocol as richer UI without changing playbook
semantics.

Workers do not ask the user directly. A worker can emit a structured
`human_input_needed` result; the run converts it into a host-visible request or
fails it if the playbook does not permit interaction at that point.

## 11. Human gates, permission approvals, and directives

These are intentionally different:

| Concept | Authority | Controls | Durable result |
|---|---|---|---|
| `GateEvaluation` | deterministic code | playbook branch | predicate result |
| `HumanDecision` | user/business authority | playbook branch | selected option + feedback |
| `ToolApproval` | harness/security policy | one tool action | allow/deny scope |
| `RunDirective` | user steering | run lifecycle or future work | immutable directive event |

A user approving a design does not automatically grant shell, deploy, secret, or
network permission. A harness allowing a command does not mean the user approved
the workflow's business decision.

Human gates should support named options rather than only approve/reject. The
author-facing shorthand may retain `on_approve`/`on_reject`, but the normalized
model is a set of option identifiers mapped to branches.

## 12. Inspection, trace, and steering

The inspectable hierarchy is:

```text
Run
  StepExecution
    ActorCall
      Attempt
        InvocationRecord
        AgentSession / NativeTraceReference
        ToolInvocation[]
        AgentResponse
        ArtifactInstance[]
```

### 12.1 Standard retention

The default `standard` retention level records:

- playbook and execution snapshots;
- effective observable instructions and input artifact digests;
- resolved executor, harness, model identifier, and environment strategy;
- lifecycle and tool-event metadata;
- final agent response;
- structured artifacts and validation results;
- gate evaluations, human decisions, tool approvals, and directives;
- available usage and timing data;
- optional native trace reference.

It does not promise private chain-of-thought or provider-hidden instructions.
Playbooks should request explicit rationale, evidence, assumptions, and rejected
alternatives in artifacts when users need them.

Recommended retention modes:

- `artifacts_only` — minimum metadata and durable outputs;
- `standard` — default as above;
- `full_observable` — all adapter-observable messages and tool events;
- `native_reference` — retain a harness reference instead of copying a full
  transcript where supported.

All modes require secret redaction and must make omissions visible. Prompt
snapshots can contain sensitive artifact content and therefore follow retention
and redaction policy rather than being unconditionally public records.

### 12.2 Steering is append-only

Inspection is read-only. Steering creates new events and instances:

- "show why option 3 was rejected" reads the existing artifact and trace;
- "explain that rationale" may create a new explanatory actor call;
- "reconsider under a lower-cost constraint" creates a directive, new actor
  call or attempt, and new versioned artifact;
- "replace the old answer" changes which artifact is active downstream but
  never deletes the original.

## 13. Event and identity model

Every runtime entity has a stable identifier:

- `run_id`
- `step_execution_id`
- `actor_call_id`
- `attempt_id`
- `agent_session_ref`
- `artifact_id`
- `decision_request_id`
- `tool_invocation_id`

`step_id` identifies a definition and is therefore insufficient for runtime
identity. Map member, loop iteration, subworkflow path, and generation are
properties of `StepExecution`.

Every event includes:

```text
event_id, event_type, timestamp, run_id, schema_version
```

and the most specific applicable parent identifiers. Events are append-only,
idempotency-aware, and ordered by a per-run sequence number in addition to wall
clock time.

The append-only event stream is the authoritative history. `run.yaml` is a
materialized projection for fast inspection and compatibility; it can be rebuilt
from events plus immutable snapshots. Artifact bytes and manifests are durable
data referenced by events. A projection mismatch is a verification error, not a
reason to rewrite history silently.

### 13.1 Normative event families

Exact serialization names can be finalized with the event schema, but the
portable event ontology should cover:

| Family | Required facts |
|---|---|
| Run | created, status changed, paused/resumed, terminal outcome |
| Host | attached, detached, ownership transferred |
| Step | ready, started, waiting, completed, failed, skipped, cancelled |
| Routing | candidates evaluated, binding selected, fallback selected |
| Actor call | created, attempt created, succeeded, failed, blocked |
| Agent session | started, observable activity, ended, native reference |
| Tool | requested, approval requested/resolved, started, completed/failed |
| Artifact | created, validation passed/failed, activated, superseded |
| Gate | evaluation started/completed, predicate version, result, branch |
| Human decision | requested, presented, resolved, withdrawn/cancelled |
| Directive | received, accepted/rejected, applied |
| Usage | usage observed or finalized |

`superseded` means a later artifact became active for downstream resolution. It
does not delete or mutate the earlier artifact.

The current open `events.jsonl` convention remains a useful transport, but a
future event schema should distinguish normative event types from extension
events. Unknown extension events must remain readable and ignorable.

## 14. Configuration scopes and provenance

Recommended scopes:

```text
playbook definition                 portable semantic requirements
repository execution policy        team constraints and repo-safe defaults
user execution profile             subscriptions, executors, preferences
host/session overrides              choices for the current interaction
resolved execution snapshot         immutable explanation of the actual run
```

Remembering a preference means writing or updating an inspectable user profile
with the user's consent. It does not mean relying solely on model memory.

Each resolved field records provenance such as `session_override`,
`repo_policy`, `user_profile`, `adapter_discovery`, or `fallback`.

## 15. Recommended answers to current open questions

1. **Can an actor call span multiple turns?** Yes. An agent session may contain
   multiple turns while preserving one actor-call purpose and binding.
2. **Can an actor call retry?** Yes, through immutable attempts. Dispatch retry,
   schema repair, and workflow revision are separately classified.
3. **Can an executor change midway?** No. A change creates a new attempt.
4. **Can a step produce multiple artifacts?** Yes. Artifact identity and
   contracts replace the assumption that one step equals one file.
5. **Are raw responses retained?** The final observable response is retained in
   `standard` mode; full transcripts are policy- and adapter-dependent.
6. **What trace is portable?** Invocation metadata, observable lifecycle/tool
   events, final response, artifacts, validation, decisions, timing, and binding.
7. **Who owns user interaction?** The active host attachment, on behalf of the
   durable run. Workers never own it.
8. **Can decisions survive session closure?** Yes. Requests and resolutions are
   durable run entities.
9. **Can routing change between iterations?** Yes between actor calls/attempts,
   with sticky defaults and visible provenance; never within an attempt.
10. **What happens when an executor is unavailable?** Apply explicit fallback
    policy, ask, block, or fail. Never silently substitute.
11. **Which configuration is recorded?** A redacted resolved snapshot plus
    provenance and digests of relevant source configuration.
12. **How is trace privacy handled?** Explicit retention modes, redaction, and
    visible omissions; never promise hidden reasoning.

## 16. North Star schema and protocol boundaries

The ontology suggests separate schemas rather than one expanding playbook file:

| Schema | Responsibility |
|---|---|
| `playbook.schema.json` | portable workflow definitions and role requirements |
| `task-profile.schema.json` | structured workflow-selection input |
| `execution-profile.schema.json` | executors, routing, fallback, workspace and retention policy |
| `run.schema.json` | durable run state and resolved snapshot references |
| `event.schema.json` | normalized append-only runtime facts |
| `artifact-manifest.schema.json` | artifact identity, contract, digest, provenance |
| `decision.schema.json` | human decision requests/resolutions and option branches |
| adapter conformance spec | host and executor behavior, not repository data |

Domain judgment schemas such as review reports, test results, fact-check
reports, and readiness reports remain separate from the orchestration ontology.

## 17. Compatibility with current Fadeno

The current protocol maps forward cleanly:

| Current concept | Future interpretation |
|---|---|
| `roles.<name>.purpose` | `Role` with minimal requirements |
| step `actor` | reference to `Role` |
| `step_started` | early form of `StepExecution` start |
| `member` | map-member dimension of a `StepExecution`/`ActorCall` |
| `prompt_assembled` | early `InvocationRecord` |
| `artifact_created` | early `ArtifactInstance` event |
| `gate_evaluated` | `GateEvaluation` event |
| `human_decision` | resolution of a durable decision request |
| driver role→CLI map | early `ExecutionProfile` and `ExecutorAdapter` |
| `.fadeno/runs/` | portable trace and degraded runtime |

The richer model must use an explicit new schema version rather than silently
changing old documents. With no established user base, this is a parsing and
honesty rule—not a promise to support old ledgers indefinitely.

### 17.1 Recommended version boundary

Do not name the next protocol family until its schema is drafted; the package is
already `0.4.x` while the playbook schema is `0.1`, so another premature version
label would add confusion.

- Old playbooks receive a loud version check. Add a cheap migration only if a
  real or plausible authored-playbook fixture needs it.
- Old ledgers are regenerable output and have no general compatibility promise.
  `show` and `verify` must refuse or explicitly select an old reader; they must
  never silently reinterpret a trace.
- Public demo ledgers must be regenerated or pinned to the reader that created
  them whenever the format changes.
- Execution profiles remain external to playbook definitions.
- A run snapshot records every participating schema version.

Promote to `1.0` only after multiple engine-backed dogfood runs, more than one
executor adapter, human pause/resume, fallback, inspection, and verification
conformance have been demonstrated.

## 18. Conformance scenarios

Before implementation, any proposed schema or adapter should pass these paper
tests:

1. Run `code-change-review` entirely inside one harness with no native
   subagents; the trace honestly shows role-passes.
2. Run it with native child agents; the same playbook produces actor calls bound
   to native sessions.
3. Run dual-architect review across two harnesses with user-specific bindings;
   no model identifier appears in the playbook snapshot.
4. Disconnect at a human gate, attach a different host, inspect the pending
   artifacts, decide, and resume exactly once.
5. Make the preferred executor unavailable; verify fallback creates a new
   attempt and visible binding-change event.
6. Return malformed evaluator JSON; verify one schema-repair attempt does not
   count as a workflow revision loop.
7. Inspect `compare_options` and retrieve inputs, effective instructions, tools,
   response, structured artifact, and native trace reference where available.
8. Reconsider `compare_options`; verify the original artifact remains and the
   downstream active artifact changes through an explicit event.
9. Map writing work over several targets in shared-tree mode; verify writers are
   serialized despite logical fan-out.
10. Approve a deployment human gate but deny the harness tool approval; verify
    the run records approval yet remains blocked or fails the deploy step.
11. Give a trivial task; verify the workflow selector can choose no playbook.
12. Generate an ephemeral workflow, execute it, and decline to save it; verify
    the run remains reproducible from its snapshot.

## 19. North Star decisions intentionally deferred

The ontology does not yet commit to:

- runtime language and process topology beyond the next protocol's committed
  repo-local library/CLI boundary;
- whether any future distribution mode should extend beyond that local engine;
- a visual UI implementation;
- a universal cost-normalization scheme;
- one canonical capability taxonomy for every domain;
- whether generated playbooks enter a shared catalog;
- provider-specific authentication mechanics;
- exact author-facing YAML syntax for nested map/replicate operations.

Those are implementation or product-distribution decisions. They should be made
after the ontology survives the scenario corpus and the adapter conformance
tests.

## 20. Next North Star design work

These are validation tasks for promoting more of the North Star. They are not
prerequisites for implementing the smaller boundary in `next-protocol.md`:

1. Review and revise the glossary with special attention to Role, ActorCall,
   Attempt, AgentSession, Executor, HostSession, and ArtifactInstance.
2. Validate the minimum capability vocabulary against real host and executor
   adapters; add domain extensions only when a scenario requires them.
3. Resolve the remaining deferred product/distribution decisions only when they
   block a schema or conformance case.
4. After design review, draft schemas and example fixtures before implementation
   milestones.

## Appendix A. Illustrative execution records

These examples validate separation of definitions, preferences, resolved
bindings, and traces. They are not proposed schemas.

### A.1 User execution profile

```yaml
kind: FadenoExecutionProfile
schema_version: draft

executors:
  architecture-primary:
    adapter: harness-a
    harness: harness-a
    model: user-model-1
    auth: personal-account-a
    capabilities:
      - repository_read
      - structured_output
    traits:
      - deep_reasoning
    environment:
      strategy: shared_read_only

  architecture-independent:
    adapter: harness-b
    harness: harness-b
    model: user-model-2
    auth: personal-account-b
    capabilities:
      - repository_read
      - structured_output
    traits:
      - deep_reasoning
    environment:
      strategy: shared_read_only

  preferred-builder:
    adapter: harness-c
    harness: harness-c
    model: user-model-3
    auth: personal-account-c
    capabilities:
      - repository_read
      - repository_write
      - shell
      - test_execution
    traits:
      - strong_coding
      - low_latency
    environment:
      strategy: isolated_worktree

routing:
  roles:
    architect_primary:
      prefer: [architecture-primary]
    architect_independent:
      prefer: [architecture-independent]
    builder:
      prefer: [preferred-builder]
  traits:
    strong_coding:
      prefer: [preferred-builder]

fallback:
  mode: ask

retention:
  mode: standard
```

No executor identifier above belongs in the reusable playbook. Another user can
run the same roles through one harness and one model.

### A.2 Resolved run projection

```yaml
run_id: run-2026-07-13-design
status: waiting_human
task: Design and implement the new coordinator architecture.

playbook_snapshot:
  name: dual-architect-review
  schema_version: "0.1"
  sha256: "..."

execution_snapshot:
  profile_sources:
    - scope: repository
      sha256: "..."
    - scope: user
      sha256: "..."
  retention: standard
  workspace_policy: isolated_writers

active_host:
  attachment_id: host-attachment-1
  harness: top-level-harness
  session_ref: opaque-session-reference

pending_decision:
  decision_request_id: decision-1
  step_execution_id: step-arbitrate-1
```

The projection contains references and redacted provenance. Secret-bearing
authentication configuration is not copied into the run.

### A.3 One compare-options actor call

```json
{
  "actor_call_id": "call-compare-1",
  "step_execution_id": "step-compare-1",
  "role": "coordinator",
  "status": "succeeded",
  "attempts": ["attempt-compare-1"],
  "active_artifacts": ["artifact-decision-record-1"]
}
```

```json
{
  "attempt_id": "attempt-compare-1",
  "actor_call_id": "call-compare-1",
  "binding": {
    "executor": "architecture-primary",
    "adapter": "harness-a",
    "harness": "harness-a",
    "model": "user-model-1",
    "environment_strategy": "shared_read_only",
    "provenance": "user_profile"
  },
  "invocation_record": "artifacts/invocations/attempt-compare-1.json",
  "final_response": "artifacts/responses/attempt-compare-1.md",
  "native_trace_ref": "opaque-harness-reference",
  "status": "succeeded"
}
```

### A.4 Artifact manifest

```json
{
  "artifact_id": "artifact-decision-record-1",
  "logical_name": "DecisionRecord",
  "generation": 1,
  "media_type": "application/json",
  "schema": "fadeno:decision-record/draft",
  "path": "artifacts/decision-record.v1.json",
  "sha256": "...",
  "produced_by": {
    "step_execution_id": "step-compare-1",
    "actor_call_id": "call-compare-1",
    "attempt_id": "attempt-compare-1"
  },
  "validation": {
    "status": "passed",
    "validator_version": "..."
  },
  "active": true
}
```

### A.5 Human decision request and resolution

```json
{
  "decision_request_id": "decision-1",
  "run_id": "run-2026-07-13-design",
  "step_execution_id": "step-arbitrate-1",
  "status": "presented",
  "prompt": "The architects did not converge. Choose how to proceed.",
  "options": [
    {"id": "consolidate", "label": "Consolidate with dissent recorded"},
    {"id": "revise", "label": "Request another bounded revision"},
    {"id": "stop", "label": "Stop the run"}
  ],
  "artifact_refs": ["artifact-cross-review-3"]
}
```

```json
{
  "decision_request_id": "decision-1",
  "decision_id": "decision-resolution-1",
  "selected_option": "consolidate",
  "feedback": "Preserve the compatibility objection in the final design.",
  "resolved_through": "host-attachment-2",
  "timestamp": "2026-07-13T20:00:00Z"
}
```

`host-attachment-2` may belong to a different harness session from the one that
created the request.

### A.6 Fallback attempt

```text
call-build-4
  attempt-build-4a
    binding: preferred-builder
    result: dispatch_failed (executor unavailable)

  binding_changed
    reason: declared fallback accepted by user

  attempt-build-4b
    binding: alternate-builder
    result: succeeded
    artifact: BuildResult.v1
```

Both attempts remain inspectable. The successful attempt becomes active; the
failed attempt remains part of provenance.

### A.7 Representative event sequence

```jsonl
{"seq":1,"event_type":"run.created","run_id":"run-1","event_id":"event-1"}
{"seq":2,"event_type":"host.attached","run_id":"run-1","event_id":"event-2","host_attachment_id":"host-1"}
{"seq":3,"event_type":"step.started","run_id":"run-1","event_id":"event-3","step_execution_id":"step-compare-1","step_id":"compare_options"}
{"seq":4,"event_type":"actor_call.created","run_id":"run-1","event_id":"event-4","step_execution_id":"step-compare-1","actor_call_id":"call-compare-1","role":"coordinator"}
{"seq":5,"event_type":"routing.binding_selected","run_id":"run-1","event_id":"event-5","actor_call_id":"call-compare-1","attempt_id":"attempt-compare-1","executor":"architecture-primary"}
{"seq":6,"event_type":"agent_session.started","run_id":"run-1","event_id":"event-6","attempt_id":"attempt-compare-1","agent_session_ref":"session-opaque"}
{"seq":7,"event_type":"artifact.created","run_id":"run-1","event_id":"event-7","attempt_id":"attempt-compare-1","artifact_id":"artifact-decision-record-1"}
{"seq":8,"event_type":"artifact.validation_passed","run_id":"run-1","event_id":"event-8","artifact_id":"artifact-decision-record-1"}
{"seq":9,"event_type":"actor_call.succeeded","run_id":"run-1","event_id":"event-9","actor_call_id":"call-compare-1"}
{"seq":10,"event_type":"step.completed","run_id":"run-1","event_id":"event-10","step_execution_id":"step-compare-1"}
```

## Appendix B. Transition ownership

These tables make lifecycle responsibility explicit without fixing an API.

### B.1 Run transitions

| From | To | Initiator | Required event/reason |
|---|---|---|---|
| absent | `created` | host/engine | playbook snapshot and task accepted |
| `created` | `running` | engine/driver | run execution started |
| `running` | `waiting_human` | engine/driver | durable decision request created |
| `waiting_human` | `running` | accepted human decision | request resolved and branch selected |
| `running` | `paused` | user/policy/host | pause directive and reason |
| `paused` | `running` | user/authorized host | resume directive |
| `running` | `blocked` | engine/adapter | structured blocker and recovery choices |
| `blocked` | `running` | engine/user/external recovery | blocker resolved |
| nonterminal | `completed` | engine/driver | terminal success reached |
| nonterminal | `failed` | engine/driver | terminal failure and cause |
| nonterminal | `aborted` | user/policy | cancellation/abort directive |

### B.2 Attempt transitions

| From | To | Initiator | Meaning |
|---|---|---|---|
| absent | `dispatching` | scheduler | immutable binding selected |
| `dispatching` | `running` | executor adapter | session accepted |
| `dispatching` | `dispatch_failed` | executor adapter | no session successfully started |
| `running` | `validating` | adapter/engine | final observable response received |
| `running` | `execution_failed` | adapter | session or tool execution failed |
| `running` | `cancelled` | user/engine/adapter | active work stopped |
| `validating` | `succeeded` | validator/engine | required artifacts valid |
| `validating` | `invalid_output` | validator | response cannot satisfy contract |

Terminal attempt states never transition back to running. Retry creates another
attempt under the same actor call.

### B.3 Human-decision transitions

| From | To | Initiator | Meaning |
|---|---|---|---|
| absent | `requested` | human-gate step | durable request created |
| `requested` | `presented` | host bridge | user-facing host acknowledged display |
| `requested`/`presented` | `resolved` | authorized host attachment | one valid option selected |
| `requested`/`presented` | `withdrawn` | engine/user | workflow no longer needs the answer |
| nonterminal | `cancelled_by_run` | run terminal transition | run ended before resolution |

Only the first valid resolution is authoritative. Later conflicting submissions
are recorded and rejected.

## Appendix C. Existing-playbook normalization check

| Playbook | Normalized runtime interpretation | Important result |
|---|---|---|
| `code-change-review` | Actor steps create one actor call each; review `map` creates a container step plus one reviewer call per member; the revision loop creates generation-scoped step executions | Works with one executor, native subagents, or honest role-passes without definition changes |
| `pr-review` | `diff_loader` is a tool invocation; reviewer map fans out logically; reduce is a synthesizing actor call; review gate is deterministic; post gate is a human decision; PR comment is an external-effect tool invocation with a separate tool approval | Confirms human decision and tool permission must remain distinct |
| `research-synthesis` | Artifact-field map creates one researcher call per subquestion; reduce synthesizes; evaluator produces a fact-check artifact without necessarily branching | Confirms evaluators are valid deliverables even without gates and dynamic map members need runtime identity |
| `dual-architect-review` | Role-member maps bind architects to different executors; convergence loops create generations; builder artifact-field map creates isolated writer calls; arbitration is durable; final review and gate remain provider-neutral | Confirms execution profiles replace host/model hints in role prose and validates the multi-harness target model |

No existing starter requires a concrete harness or model in its definition. The
experimental dual-architect playbook's current host/model prose is execution
configuration waiting to move into a profile, not evidence that bindings belong
in portable playbooks.

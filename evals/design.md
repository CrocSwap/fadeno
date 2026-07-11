# Evaluation discovery: a falsifiable minimal suite

## Framing and approval gate

The question is not whether a Fadeno demo looks organized. The question is whether it changes task outcomes or workflow behavior enough to justify its cost against an actually useful reusable instruction. This design proceeds to the five-fixture Phase B implementation only because it can plausibly produce unfavorable results: equal correctness with more cost, incorrect ledger claims, failure to recover, worse clean-run throughput, or non-comparable host behavior.

The first agent-scored batch **must** target Milestone 1 commit `a5e3dd3`. The harness requires an explicit `fadeno_commit` for each unit. Earlier runs may be kept as protocol-development evidence, but must be labelled pre-Milestone-1 and must not be presented as representative.

## Questions and hypotheses

H1 (workflow adherence): Fadeno improves the observed sequence of planning, implementation, review, checks, bounded revision, and honest unresolved status.

H2 (task quality): Fadeno improves deterministic final repository correctness.

H3 (failure recovery): after a plausible first-pass defect, Fadeno detects it, routes into at most one revision, rechecks, and either fixes it or fails honestly.

H4 (trace value): Fadeno's ledger lets an independent reader reconstruct steps, artifacts, branch reasons, checks, and justified terminal status.

H5 (portability): Codex and Claude Code make equivalent workflow decisions and produce equivalent artifact roles from the same Fadeno playbook. Prose and code need not match.

H6 (cost): any H1--H5 gain is large enough to justify time, calls, approvals, artifacts, setup, and available token cost.

## Treatments

All treatments receive the fixture task, repository instructions, and equivalent permissions/tool access. They use exactly the text versioned under `evals/treatments/`.

| ID | Definition | Version |
| --- | --- | --- |
| `plain-prompt` | Task plus normal repository instructions only. | `1` |
| `careful-skill` | A competitive reusable plan/implement/review/test/revise-once instruction. It has no YAML, ledger, schema, or Fadeno command. This is the primary baseline. | `1` |
| `fadeno-degraded` | The pinned Fadeno code-change-review playbook, with explicitly separate coordinator/implementer/reviewer passes recorded as degraded roles. | `1` |
| `fadeno-native` | The same pinned playbook using native worker/reviewer/judge subagents. Unsupported when a host cannot execute these reliably; never substitute degraded roles. | `1` |

Changing any treatment text increments its version and begins a new batch.

## What is observable

Independent evidence is preferred over an agent's final prose. The harness observes repository state, deterministic oracle output, command/transcript capture when a host offers it, and Fadeno ledgers. For Fadeno it separately records what the ledger claims and what independent evidence supports.

Deterministically scoreable: hidden acceptance behavior, required/forbidden files, dependency changes, test/build exit status, parseable ledgers/events, artifact references, event ordering, gate result/routing, and terminal-status coherence. Human grading is needed for code clarity, usefulness/genuineness of a review, final-explanation quality, and whether trace reading effort was worth it.

No metric is silently inferred from missing data. For example, unavailable token counts are `null`, never an estimate based on transcript length.

## Candidate fixtures considered

1. Label normalizer: a clean, small change with ordinary null/string edge cases.
2. Strict port parser: a tempting `Number()` implementation accepts exponent, hexadecimal, and decimal forms contrary to the task; careful review or close requirements reading can catch it.
3. Remote contract outage: a legitimate environment-provided integration URL is absent. The task can be implemented, but the required check cannot pass; editing test infrastructure is forbidden. This tests honest `tests_failed` terminal failure.
4. Persistent release-policy review finding: a platform-owned defect is explicitly out of task scope. It must remain blocking through one revision and route to genuine loop exhaustion.
5. Retry-delay calculation: ordinary visible cases pass while hidden boundary and invalid-input cases catch a superficially plausible implementation. This measures whether a treatment's claimed green state survives delayed checks.
6. Dependency approval: a task where an existing standard-library capability removes any need for a package. Deferred: approval interfaces differ too much across hosts for the first batch.
7. Reviewer disagreement: two reviewers choose different trade-offs. Deferred: it adds subjective scoring before the basic mechanics are reliable.

The first five are the selected Phase B fixtures. They cover clean throughput, review pressure/recovery opportunity, bounded review-loop exhaustion, unresolved test failure, and delayed test failure without making any one fixture a single composite test.

## Expected outcomes declared before scored runs

The per-fixture `oracle/expected.json` files are the predeclared deterministic outcomes. They remain outside an agent workspace. A passing final state is expected for `clean-first-pass` and `revision-succeeds`; `revision-exhausts` expects persistent blocking review evidence and loop exhaustion without a forbidden workaround; `unresolved-check` expects a failed required remote-contract check without forbidden bypass; and `tests-fail` intentionally exposes defects only to the post-session oracle.

The recovery fixture is an opportunity test, not a claim that every agent will make the same first-pass error. H3 is scored only when independent transcript or trace evidence establishes an initial defect/finding; otherwise recovery fields are `null`. This prevents turning model stochasticity into fabricated recovery data.

## Metrics (raw vector, no first-iteration composite)

Correctness: each hidden check, required file presence, forbidden-file protection, dependency status, and final repository validity are reported separately under `checks`.

Workflow: plan before implementation, implementation, review after implementation, structurally valid review output, blocking review finding routed to revision, tests run after the final implementation (including revisions), whether a revision was re-reviewed, revision bound, honest loop exhaustion, approval request, and unapproved sensitive action. `null` means unavailable. Ledger-derived fields are recorded only under `workflow_claimed`; transcript/host-derived fields are recorded only under `workflow_observed` with evidence paths. They are compared, never overlaid.

Trace: `run.yaml`, parseable `events.jsonl`, lifecycle events, referenced artifacts, gate condition/artifact/result, ordering, and terminal/check agreement. A reader rubric in `rubric.md` handles the remaining trace-value questions.

Cost: start/end wall time, exposed token usage, model/subagent calls, user interactions, trace artifact count/bytes, and shell/tool calls. Values absent from host evidence remain `null`.

## Isolation, preservation, and run procedure

`prepare-run.mjs` copies only `fixtures/<id>/repo/` to a fresh `workspace/`, installs pinned capability only for Fadeno treatments, and initializes an independent Git repository with a committed fixture baseline. This prevents repo-root discovery or diff inspection from escaping into the enclosing Fadeno repository. The task/workflow text goes to `agent-input.md` outside that workspace; the oracle is never copied. Each unit receives a fresh checkout, session, worktree directory, and starting fixture version. Operators define the complete matrix and randomize its execution order before launching sessions. Raw transcript, host export, and final workspace are preserved even when malformed.

Results include fixture/treatment versions, host/client/model, timestamp, repetition, Fadeno commit, infrastructure status, raw-artifact paths, separate workflow claims, and separate observed evidence. Subjective graders receive redacted run material that omits treatment and host where feasible; their notes are retained verbatim.

## Infrastructure-failure policy

`valid_run` means the agent received the specified task and workspace and its behavior is scored, however poor. `host_failure` means the host/session failed before a usable task handoff (crash, service outage, or unavailable required model capability). `setup_failure` means incorrect fixture, permissions, or starting revision were supplied. `harness_failure` means preparation, isolation, or deterministic scoring malfunctioned. Only the last three may be retried, once, with the original unit retained and the retry linked in notes. An agent mistake, malformed trace, refusal, timeout caused by its own actions, or failed test is always `valid_run`.

## Pilot observations

An initial three-cell Codex procedure run on `clean-first-pass` was retained but classified entirely as setup failure, not treatment evidence. It found two preparation defects: Fadeno definitions were pinned without installing the matching runner skill/CLI capability, and workspaces nested beneath this repository were not independent Git roots. The latter allowed CLI root discovery and agent diff commands to escape into the enclosing repository. `prepare-run.mjs` now extracts definitions, runner skill, and bundled CLI from the same pinned commit for Fadeno treatments, then initializes every treatment workspace as an independent committed Git repository. A new scored batch must use this corrected preparation path.

The committed `smoke-fixtures.mjs` run is a fixture-mechanics pilot: it copies each agent workspace, applies a known-good reference state, and confirms the isolated oracles score it. `test-scorer.mjs` adds synthetic ledger cases for revision sequencing, review-schema validation, loop exhaustion, claim/observation separation, capability installation, and Git-root isolation. These checks reveal only that preparation and scoring work, not any treatment result, realism, or comparative cost.

The existing dogfood trace establishes the fields that normalize well today: run metadata, lifecycle events, artifact paths, review gate, and test order. It also reveals a limitation: a ledger alone cannot prove an asserted shell command or source edit occurred. The suite therefore records independent workspace and transcript evidence separately. Native-role availability and host token/call telemetry remain measurement risks to resolve in the first post-merge pilot.

## Smallest useful Phase B scope

Run five fixtures × plain/careful/Fadeno-degraded, then add native roles only on hosts where they work reliably. Start with one randomized repetition per cell after Milestone 1, score every result, and inspect the raw vectors before adding repetitions. This is a procedure pilot, not a significance claim. Expand only after reviewing fixture realism, treatment fairness, measurement availability, trace normalization, nondeterminism, and execution cost.

## Ways this can show Fadeno is not worthwhile

- The careful skill equals or beats Fadeno on correctness/adherence at lower cost.
- Fadeno adds plans/ledgers but harms clean-first-pass time or correctness.
- Fadeno traces claim gates, tests, or roles that workspace/transcript evidence cannot corroborate.
- Reviews do not improve strict-port or hidden-test outcomes, or revisions exceed their bound / claim success after failure.
- Only native subagents help, making the portable degraded treatment unhelpful.
- Claude and Codex do not create comparable decisions/artifacts.
- The artifact and interaction burden exceeds any measurable recovery benefit.

## Validity risks and open questions

Small synthetic repositories cannot establish production-repository performance; models may recognize fixture patterns; hidden tests measure outcomes but not whether an agent truly reasoned; and host telemetry/approval semantics differ. The strict-port and retry tasks are pressure, not guaranteed error generators.

Open questions for review: Which host exports can legally provide call/token/transcript telemetry? Can a blinded grader receive enough context to judge a review without recognizing the artifact format? The design should be approved before more fixtures, automatic host driving, or tuning any Fadeno instruction.

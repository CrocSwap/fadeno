# Fadeno: Architecture and Ontology Brief

  ## What Fadeno is

  Fadeno is a portable, repo-local workflow engine for AI coding agents. It lets teams express repeatable workflows—implement, review, test, revise, approve—as provider-neutral YAML playbooks, then execute
  them across Codex, Claude Code, Grok, and command-line harnesses.

  Its product thesis is:

  > Portable agent workflows with deterministic execution records and recomputable gates.

  Fadeno is not a cloud orchestrator, model provider, daemon, or general-purpose scheduler. Runs are driven by CLI invocations and persist as files, allowing them to survive host sessions, process failures,
  and handoffs between harnesses.

  ## Architectural shape

  User task
      ↓
  Playbook definition                 Portable workflow semantics
      ↓
  Role → archetype → dial             Who should perform the work
      ↓
  Model → route → delivery            How the selected harness/model is reached
      ↓
  Deterministic engine                Advances control flow and validates outputs
      ↓
  Run ledger + artifacts              Append-only, durable execution evidence
      ↓
  Verification                        Recomputes gates, identity, and trace coherence

  The repository is organized around three layers:

  - Capability — the CLI, runner/builder skills, host adapters, and agent definitions.
  - Definitions — playbooks, schemas, vocabulary, executor profiles, and policy.
  - Traces — run ledgers, immutable artifacts, prompt snapshots, and execution evidence.

  Templates are the source of truth. They can be installed repo-locally or delivered through the Fadeno plugins.

  ## Core ontology

  ### Workflow definition

  - Task — the user’s desired outcome. A task does not necessarily require a playbook.
  - Playbook — a reusable, model-neutral workflow definition.
  - Role — semantic responsibility inside a playbook, such as implementer or security_reviewer. It is not a model or agent process.
  - Step definition — a logical workflow node: work, evaluation, control flow, iteration, or aggregation.
  - Artifact contract — the expected type, schema, and purpose of a step’s output.
  - Gate condition — a deterministic predicate over validated artifacts.

  The central control-flow rule is:

  evaluator → structured judgment artifact → deterministic gate

  Models may make judgments, but they do not directly choose branches. Their judgment is captured in a typed artifact; Fadeno computes the branch.

  Loops are always bounded, and revisions create new artifacts rather than overwriting prior evidence.

  ### Execution binding

  - Archetype — a reusable execution posture such as director, worker, reviewer, judge, or generator. Archetypes carry policies such as write posture and eligibility.
  - Model — a harness-neutral registry identity: provider, model ID, and requested reasoning effort.
  - Dial — an archetype-to-model selection. Resolution cascades through role binding, session dial, repo pin, user dial, and host-native base.
  - Harness — an agent environment such as Codex, Claude Code, or Grok.
  - Host — the harness in which Fadeno is currently running.
  - Driver — a harness or CLI invoked as an external command.
  - Route — how the current host reaches a model: native host delivery or command delivery.
  - Execution binding — the immutable model, route, delivery mechanism, and policy resolution used for one attempt.

  Playbooks therefore describe what work means, while dials and routes decide who performs it and how it is delivered.

  ### Runtime execution

  - Run — one durable execution of an immutable playbook and execution-profile snapshot.
  - Node/step execution — one runtime occurrence of a step, including a particular map member or loop generation.
  - Actor call — one semantic request for a role to produce an output.
  - Attempt — one concrete dispatch of that actor call. Repairs, retries, and executor substitutions create distinct attempts.
  - Artifact instance — an immutable, manifested output with type, digest, provenance, and producing identity.
  - Human decision — a durable named choice at a human_gate.
  - Event — an append-only execution fact.

  Runtime identities preserve containment. For example:

  migrate[member=service_3]/review_cycle[generation=2]/review

  This allows map members and nested loops to progress independently without confusing their artifacts or attempts.

  ## Engine and delivery model

  fadeno drive computes the runnable frontier, dispatches actor or tool work, validates outputs, evaluates deterministic gates, records events, and continues until the run terminates or requires human/host
  action.

  Delivery has two forms:

  - Host delivery requests a native agent from the current harness and waits for explicit start, progress, and terminal receipts.
  - Command delivery invokes an external harness beneath a process-group supervisor.

  The engine and CLI own control transitions and ledger writes. Agents produce artifacts and observations; they do not privately redefine workflow state.

  ## Evidence and safety model

  Every important claim is one of:

  - deterministically verifiable;
  - explicitly adapter-attested; or
  - visibly unverifiable.

  Fadeno records immutable playbook/profile snapshots, exact prompt bytes, output digests, artifact manifests, resolved identities, attempts, decisions, and terminal receipts. fadeno verify recomputes gate
  results and checks trace coherence rather than trusting summaries.

  Write-capable execution is protected by a repo-wide writer lease. Command attempts own process groups so interruption cannot silently leave orphan writers. Optional isolated worktrees allow concurrent
  mutation without merging automatically. Progress and process activity are observable but explicitly non-gating.

  ## Current boundary

  The shipped architecture is a small, deterministic, file-backed engine—not the entire North Star ontology. Current compositional execution supports practical maps, bounded loops, independent runtime
  identities, reducers, host delivery, and bounded command parallelism in supported paths.

  Automatic workflow recommendation, capability-ranked routing, speculative races, dynamic work stealing, rich cross-host attachment ownership, and a general scheduler remain deferred until dogfood produces
  both:

  1. an observed need, and
  2. a meaningful verification check.

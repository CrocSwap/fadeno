# Case study: erdosSweep vs the Fadeno ontology

**Status:** analysis only — no schema or kernel changes; findings feed the
loadouts/dispatch backlog
**Date:** 2026-08-12
**Relationship:** stress test of
[`loadouts-and-dispatch.md`](loadouts-and-dispatch.md) and the playbook
format (`templates/common/skills/fadeno-runner/references/playbook-format.md`)
against a real pre-Fadeno workflow. Subject repo: `~/sith/toys/math/erdosSweep`
(July 2026, predates Fadeno's dispatch kernel).

## Why this subject

erdosSweep is a hand-rolled multi-model research harness built under time
pressure and then hardened by real failures: four model backends across four
vendors, a four-gate verification pipeline, a model-calibration meta-protocol
with pre-registered answer keys, and weeks of campaign state. Nothing in it was
designed with Fadeno in mind, which is exactly what makes it a fair test: if
the ontology (archetypes, targets, routes, loadouts, playbook kinds, evidence
ledger) can express what erdosSweep's bash scripts and markdown conventions
express, that is evidence the ontology carves reality at its joints — and
where it cannot, the residue is a concrete gap list rather than speculation.

## The subject, inventoried

Six distinct structures live in that repo:

1. **A backend catalog** — `harness/attack.sh` and `harness/critique.sh`
   resolve backend name → model → exec incantation via case statements, with
   env overrides (`CLAUDE_MODEL`, `CLAUDE_EFFORT`, …) and per-backend quirks:
   codex needs stdin closed or it hangs; kimi runs through OpenCode in an
   empty sandbox directory with a retry-once-after-90s empty-output guard and
   a hard no-concurrency rule.
2. **A four-gate pipeline** — attack → cross-family adversarial critique →
   literature check → Lean formalization. Mandatory verdict blocks at each
   stage; "critique defaults to REFUTED"; a claim without all four gates is a
   draft, not a result.
3. **A relational integrity constraint** — the critic must be a *different
   model family* than the attacker. Enforced mechanically: critique.sh greps
   the run transcript's `- backend:` header and refuses to launch a
   same-family critique.
4. **A provenance regime** — every run logged to `problems/<id>/runs/` with
   backend/model/date headers baked into the transcript; "if we ever claim
   autonomy, the transcript is the evidence" (the #728 dispute made this a
   hard rule).
5. **An executor-calibration meta-workflow** — the Kimi K3 suite (MODELS.md +
   `harness/calibration/`): pre-registered answer keys written before any run,
   shadow-tagged runs that never count toward gates, two independent graders
   from different families whose disagreements are surfaced rather than
   averaged, and a promotion decision ("NOT gate-2 eligible; attacks count;
   approved as supplementary sweep") recorded with re-test criteria.
6. **A campaign layer** — TARGETS.md board, HANDOFF.md session handoffs, a
   frontier ledger of live vs refuted directions, and input hygiene:
   quarantined-false-statement notes must be *excluded* from certain prompt
   assemblies ("one leaked file voids the test").

## What maps cleanly

### Backends → targets + routes

The case statements are a hand-written `executors.yaml`. `claude →
claude-fable-5 @ xhigh` is a target (provider anthropic, model, reasoning
effort); each `printf '%s' "$PROMPT" | <cli> …` arm is a command route;
MODELS.md's roster table is a target catalog with annotations; "attacker/critic
pairing is a real decision" is the sentence loadouts exist to encode. Two
details validate specific route-design choices:

- **kimi runs through OpenCode**, a different agentic CLI harness entirely
  (`opencode run --dir <sandbox> --agent plan -m openrouter/moonshotai/kimi-k3`).
  A route is "how this host reaches that provider," and reaching a provider
  *through another harness* fits the shape without modification —
  harness-neutral routes are not a hypothetical.
- **gemini is auth-blocked** (Workspace-ineligible account). Executor
  unavailability as a live catalog condition is exactly what the
  fallback-across-routes work assumes.

### The four-gate pipeline → a playbook flow

The decomposition needs almost no forcing, and touches most primitive kinds:

| erdosSweep structure | playbook primitive |
|---|---|
| multi-sample, multi-family attack | `replicate` with `actors` bound to different families |
| per-attempt adversarial critique | `map` + `evaluator` |
| critique verdict block | artifact contract; FATAL FLAWS ↦ blocking issues, so `VERDICT: SURVIVES` ≡ `no_blocking_issues` |
| litcheck's three-way PRIOR ART verdict | `evaluator` → `router` |
| Lean formalization (+ 64k-cap relaunch) | worker `actor_call` + `tool_call` (lake build ≈ `test_runner`) + `tests_pass` gate inside a bounded `loop` |
| numerics with self-verifying certificates | `tool_call` producing `TestResult` |
| "announce carefully" / forum post / erratum wording | `human_gate`; `require_user_approval_for: [external_send]` |
| calibration grading (two families, disagreements surfaced) | judge-archetype `replicate` → `reduce` whose artifact contract says "surface disagreements, never average" |
| runs/ → candidates/ promotion | `artifact_op` + terminal statuses |

The deepest convergence: erdosSweep independently invented the **gate
discipline**. "Critique defaults to REFUTED" plus a mandatory structured
verdict block plus promotion-only-on-SURVIVES is precisely "judgment lives in
an artifact; control flow is a deterministic check on it; never write a gate
that asks the model to decide inline." A team with no knowledge of Fadeno,
optimizing purely against false-proof failure modes, landed on the same
separation.

### The provenance regime → the dispatch evidence ledger

erdosSweep hand-rolled a weaker version of the evidence system: transcript
headers recording backend/model/date are the dispatch rows' executor/model
fields; the tier-1 calibration rule that the answer key be written *before*
any run, and the input-reconstruction rule that spoiler notes be provably
excluded, are auditable after the fact only if you know exactly what each
executor was shown — which is what kernel prompt snapshots +
`prompt_sha256` provide. Their "log everything; the transcript is the
evidence" ground rule is the dispatch ledger's design brief, written a month
before the ledger existed.

## Concrete exhibit: the inner loop as a playbook

Illustrative sketch, not a validated starter — the two `STRAIN` comments mark
exactly where the current schema cannot say what erdosSweep needs said. The
outer campaign (target selection, status re-verification, handoffs) stays
human; this is one attack-critique cycle on one problem.

```yaml
kind: AgentPlaybook
schema_version: "0.1"
name: attack-critique-cycle
description: >
  One inner-loop cycle of an open-problem campaign: multi-family attack
  replicas against a frozen problem dossier, cross-family adversarial critique
  of each attempt, machine checks on surviving claims, and promotion of
  survivors to candidate status.
roles:
  coordinator:
    purpose: >
      Assemble the problem dossier (statement, verified status + date, known
      bounds, prior failed attacks, current notes — EXCLUDING any quarantined
      refuted-claims notes) and own the final cycle summary.
  attacker_a:
    purpose: >
      Maximum-depth attempt on the open problem. Partial results, reductions,
      and counterexample candidates are valuable; flag uncertain steps
      [SHAKY]; end with a CLAIM/CONFIDENCE/GAPS/NEXT verdict block. Produce an
      artifact only — never modify the workspace.
    archetype: worker   # STRAIN: worker-shaped cognition, but the write policy
                        # is inverted — this role must NOT write, and
                        # archetypes can only demand write access, not forbid it.
  attacker_b:
    purpose: (same contract as attacker_a; bound to a different provider)
    archetype: worker   # same strain
  critic:
    purpose: >
      Hostile referee. Assume the proof is wrong and hunt for the flaw;
      default to REFUTED; a fixable gap is still REFUTED as written. MUST be a
      different model family than the attempt's author.
    archetype: reviewer # STRAIN: the cross-family requirement is relational
                        # (critic.provider != producer.provider of the input
                        # artifact) — loadouts bind statically per archetype
                        # and cannot express it; enforcement today would be
                        # prose, exactly what the dispatch boundary should do.
  machine_checker:
    purpose: >
      Independently verify every finite/computable claim in a surviving
      attempt on concrete instances; certificates must self-verify.
    archetype: worker

flow:
  - id: assemble_dossier
    kind: actor_call
    actor: coordinator
    output: Dossier

  - id: run_attacks
    kind: replicate
    actor: attacker_a
    actors: [attacker_a, attacker_b]
    input: [Dossier]
    output: AttackReport[]
    output_path: artifacts/attacks/{actor}.md

  - id: critique_each
    kind: map
    over: AttackReport[]
    input: [Dossier]
    output: ReviewReport[]        # FATAL FLAWS carry severity "blocking"

  - id: critique_gate
    kind: gate
    input: [ReviewReport[]]
    condition: no_blocking_issues
    on_pass: machine_check
    on_fail: log_refutations

  - id: machine_check
    kind: tool_call
    tool: test_runner
    input: [AttackReport[]]
    output: TestResult
    next: check_gate

  - id: check_gate
    kind: gate
    input: [TestResult]
    condition: tests_pass
    on_pass: promote_candidate
    on_fail: log_refutations

  - id: promote_candidate
    kind: artifact_op
    op: write
    input: [AttackReport[], ReviewReport[], TestResult]
    output: Candidate
    next: announce_gate

  - id: announce_gate
    kind: human_gate
    prompt: >
      A candidate survived critique and machine checks. Proceed to literature
      check and formalization (separate playbook)?
    on_approve: done
    on_reject: done

  - id: log_refutations
    kind: actor_call
    actor: coordinator
    input: [ReviewReport[]]
    output: FrontierNote          # refuted directions feed the campaign ledger
    terminal_status: failed

  - id: done
    kind: actor_call
    actor: coordinator
    input: [Candidate]
    output: FinalSummary
    terminal_status: completed

policies:
  require_user_approval_for:
    - external_send               # "announce carefully, with evidence attached"
```

Two sibling playbooks fall out the same way and are not sketched in full:
**candidate-adjudication** (litcheck evaluator → three-way `router` on PRIOR
ART → bounded formalization `loop` with `tests_pass` gate → `human_gate`
before any external announcement) and **executor-calibration** (actor_call
writes the pre-registered answer key → shadow dispatches → judge `replicate`
across two families → `reduce` with a surface-disagreements contract →
`human_gate` for waivers). The calibration playbook's *output*, however, is a
mutation of the executor catalog itself — see gap 3.

## Where the ontology strains

Ranked by how fundamental the gap is. The first four share one root cause,
named in the verdict.

### 1. The cross-family constraint is relational; loadouts are static

erdosSweep's single most load-bearing integrity rule — critic family ≠
attacker family ("same-family critique rubber-stamps") — is not expressible.
A loadout binds archetype → target once per session; the rule needed is
*"this dispatch's provider must differ from the provider that produced its
input artifact,"* a constraint **between dispatches**, resolvable only at
dispatch time against provenance data. The kernel already holds that data:
evidence rows record executor and model per dispatch. A
`distinct_provider_from` archetype/step policy checked at the same boundary
where write-access refusal fires today would be the host form.
critique.sh's grep-the-transcript-header guard is the shell-script ancestor
of exactly that refusal pattern.

### 2. The attacker breaks the archetype triad

Attack work is generative, maximum-effort, worker-shaped *cognition* — but it
must **not** write (kimi attacks run in an empty sandbox precisely to keep an
agentic CLI off the repo; the product is an artifact, not an edit). The
current policy vocabulary is one-sided: `archetypes: {worker: {requires_write:
true}}` can demand write access but nothing can forbid it. Mapping attacker →
worker triggers a spurious write-conflict refusal on deliberately sandboxed
routes; mapping it → reviewer lies about the work's shape. Two candidate
fixes: a fourth archetype (*generator/prover*: produces the primary artifact,
forbidden from workspace mutation), or a three-valued `requires_write:
required | forbidden | unconstrained`. The triad is code-shaped; research
workflows expose it.

### 3. Executor eligibility has states the catalog cannot express

MODELS.md's roster cell `gate-2 critic? NO — shadow-only` is a rich status:
kimi *may* attack, *may not* serve as a gate critic, *is approved* as a
supplementary (advisory, never-gating) critic, with recorded promotion
criteria and a calibration date. A loadout expresses positive bindings only —
you can decline to bind kimi to the reviewer slot, but you cannot express the
prohibition, the probation, or the shadow mode. Per-playbook workarounds
exist (an advisory evaluator whose report never feeds a gate), but the
catalog-level forms would be: per-target-per-archetype eligibility
annotations, and a `shadow` dispatch flag marking evidence rows
non-gate-eligible (their `-shadow-` filename tag, promoted into the ledger).
Calibration itself — a playbook whose output mutates the executor catalog —
is entirely outside the current model.

### 4. Routes lack an operational-policy layer

Hard-won operational knowledge is embedded in the scripts with no schema
home: retry-once-after-90s on empty output; fail-loudly-never-log-a-stub; no
concurrent kimi runs (upstream throttling); env-var prefixes
(`CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000` on the claude arm); and — subtlest —
**task-size eligibility**: Moonshot's ~32.7k completion ceiling makes K3
"critique-sized tasks ONLY," an executor constraint keyed on payload size.
Route fields like `env`, `retry: {attempts, backoff_seconds}`,
`max_concurrency`, and `max_prompt_bytes` would carry all of it; today each
would survive only as prose in a spec comment.

### 5. Minor strains

- **Three-valued verdicts.** "SURVIVES with skimmed steps is UNCLEAR, not
  SURVIVES" — REFUTED/SURVIVES/UNCLEAR squeezes awkwardly through a binary
  gate. `evaluator` → `router` handles it, at the cost of the gate
  discipline's crispness.
- **Capability requirements on roles.** Litcheck needs web search; Fable's
  calibration profile notes its planned sweeps die in sandboxed
  non-interactive runs unless the allowlist is pre-approved. Roles and
  routes have no vocabulary for "this role needs web access / pre-approved
  execution."
- **Input slicing.** "Reconstruct inputs to EXCLUDE notes/04 and later" is
  finer-grained than named-artifact `input` lists — dated slices of an
  append-only corpus. The evidence ledger can *audit* what was included
  (prompt snapshots), but the playbook cannot *specify* the exclusion.

### Correctly out of scope

The campaign layer — TARGETS.md, status re-verification before each session,
HANDOFF.md, the frontier ledger of live vs refuted directions — sits above
bounded playbook runs, and the ontology is right not to swallow it. In a
Fadeno-era erdosSweep, `fadeno drive` runs the inner loops (one
attack-critique cycle, one adjudication, one calibration tier per run) while
the board stays human-owned prose. That division matches how the campaign
was actually operated: orchestration judgment in the driving session,
scripts for repeatability and logging.

## Verdict

The ontology passes the structural test: every stage of the four-gate
pipeline and the entire calibration protocol decompose into existing
primitive kinds without contortion, the gate discipline was independently
reinvented by the subject repo, and the evidence ledger turns out to be the
piece erdosSweep most conspicuously hand-rolled ("the transcript is the
evidence"). Where it fails is *policy expressiveness*, and the failures
point one direction: **the executor catalog is a static positive map, while
real multi-model practice needs conditional, negative, and stateful
constraints** — relational (cross-family), negative (must-not-write),
stateful (shadow/probation eligibility), and operational (retry,
concurrency, size ceilings). That is one coherent finding, not four
scattered ones. The dispatch-boundary enforcement built for write access is
the right chokepoint; each gap is a new predicate at that same boundary,
evaluated against data the evidence ledger already records.

Follow-ups filed to the loadouts/dispatch backlog, smallest first:
three-valued `requires_write`; `distinct_provider_from` dispatch predicate;
`shadow` dispatch flag + ledger tag; route operational-policy fields.

**Update 2026-08-12:** the first three follow-ups (plus session slot
overrides, the `generator` archetype, fallback chains, and shadow-based
model tryouts) are now designed in
[`slots-and-archetypes.md`](slots-and-archetypes.md). Route
operational-policy fields remain backlog, named there as an explicit
non-goal.

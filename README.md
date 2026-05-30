# Fadeno

**The playbook layer for AI coding agents.**

Stop re-typing *"be careful, plan, review, test"* every run. Define your workflow once as a repo-native YAML playbook, and any agent runs it the same disciplined way — leaving an inspectable trace of what it did. No runtime, no service, no lock-in.

> **Fadeno** /fah-DEH-no/ — Esperanto for *"thread."* The thread that runs through every agent task.

```bash
npx fadeno init --codex     # or --claude
```

---

## The problem

Coding agents are powerful but inconsistent. Every nontrivial task, you re-explain the same discipline:

> *"Codex, please be careful. Make a plan first, then implement it. Review your own code for edge cases. Run the tests. If something's broken, fix it. Don't install new dependencies or run anything destructive without checking with me."*

You retype some version of that every time. You get different behavior every run. And when the chat closes, there's no record of what the agent actually did.

## The fix

Define the workflow **once**, commit it to your repo, and then just say:

> *"Use the code-change-review playbook."*

Same discipline — plan → implement → review → test → bounded revision — every time. Inspectable. Shareable. Portable across the agents your team actually uses.

Fadeno is **harness-neutral**: the same playbooks run on Codex and Claude Code today, and are designed to compile into a real orchestration runtime later. Only a thin per-target adapter differs.

> **Honest about enforcement, up front:** in instruction-only hosts, approval policies are *advisory* — the model is asked to honor them, with no hard guarantee. For real guarantees, wire gates to your git/CI/pre-commit layer (or Claude Code hooks). See [Enforcement](#enforcement-advisory-vs-enforced). We'd rather you trust the tool because it's honest than because it overclaims.

---

## Install & initialize

Requires Node.js ≥ 20.

```bash
# Codex target  → .agents/skills/, AGENTS.md, $-style invocation
npx fadeno init --codex

# Claude Code target → .claude/skills/, CLAUDE.md, /-style invocation
npx fadeno init --claude
```

`init` is safe to re-run: existing files are left untouched (and your
`AGENTS.md`/`CLAUDE.md` content is preserved — Fadeno only appends a marked
section). Use `--force` to overwrite. Add `--with-hooks` to also scaffold the
tier-2 [enforcement](#enforcement-advisory-vs-enforced) layer (a pre-commit
guard + a CI workflow).

### What gets created

```
.fadeno/
  vocabulary.md                 # the small, orthogonal term set
  enforcement.md                # advisory vs. enforced (tier-1 vs tier-2)
  playbooks/
    code-change-review.yaml
    research-synthesis.yaml
    pr-review.yaml
  schemas/
    playbook.schema.json        # the source of truth for the vocabulary
    run.schema.json
    review-report.schema.json
  runs/                         # run ledgers (execution traces, not source)

# Codex (--codex):                      # Claude Code (--claude):
AGENTS.md                                CLAUDE.md
.agents/skills/                          .claude/skills/
  fadeno-runner/  (SKILL.md, refs,         fadeno-runner/  (SKILL.md, refs)
                  agents/openai.yaml)      fadeno-builder/ (SKILL.md, refs;
  fadeno-builder/ (SKILL.md, refs,                          disable-model-invocation)
                  agents/openai.yaml)    .claude/agents/  (fadeno-worker/-reviewer/-judge.md)
.codex/agents/  (fadeno-worker/-reviewer/-judge.toml)
```

The playbooks, schemas, vocabulary, and SKILL.md *bodies* are **identical** on
both targets. Only the install dir, bootstrap file + invocation sigil, invocation
policy, and subagent format differ.

---

## Running a playbook

Fadeno ships two skills. Point your agent at the **runner**:

| Host | How |
|------|-----|
| Codex | `$fadeno-runner`, or `/skills` to browse, or just describe a complex task (implicit). |
| Claude Code | `/fadeno-runner`, or describe a complex task (implicit). |

The runner will:

1. pick the best playbook from `.fadeno/playbooks` (using each playbook's
   `when_to_use`),
2. create a run directory under `.fadeno/runs/`,
3. execute each step — delegating roles to native subagents when available, or
   simulating them with separate passes otherwise (depth-1; a subagent never
   spawns its own subagents),
4. apply gates from **structured judgment artifacts** (not vibes),
5. respect loop bounds, versioning each iteration's artifacts,
6. report what changed, what was checked, which gates passed, and the run path.

You can also drive the ledger from the CLI — useful for scripts, hooks, and so
the agent doesn't hand-edit JSONL:

```bash
fadeno new-run code-change-review "Add CSV export for reports"
fadeno run <run-id> --step implement            # set current_step + log step_started
fadeno run <run-id> --status completed           # finalize: status + ended_at + run_completed
fadeno gate <run-id> no_blocking_issues          # exit 0/1 from the review-report artifact
```

`fadeno gate` is the **advisory→enforced bridge**: it computes a gate condition
from a structured judgment artifact on disk (same check the runner applies), so
the identical condition can run in CI, a pre-commit/pre-push hook, or a Claude
Code `Stop` hook. Exits non-zero when the gate fails.

### What `.fadeno/runs/` contains

Each run is a directory — the file-backed "degraded runtime" that makes a run
inspectable (and is the seam a future compiled runtime reads/writes):

```
.fadeno/runs/2026-05-30-1132-csv-export/
  run.yaml        # metadata: playbook, status, task, started_at, host, current_step
  events.jsonl    # append-only lifecycle log, one JSON object per line
  artifacts/      # every durable output: plans, patches, reviews, test results…
```

`runs/` is execution-trace output, **not source code**. It is safe to delete old
runs.

---

## Creating a playbook

Use the **builder** skill (explicit only — it won't fire just because a prompt
mentions "playbook"): `$fadeno-builder` (Codex) / `/fadeno-builder` (Claude).

A playbook is a small YAML file validated by `playbook.schema.json`. The key
design rule:

> A gate must **not** "ask an LLM." Instead:
> `evaluator actor → structured judgment artifact → deterministic gate condition.`

Judgment lives in an artifact (which models produce well); control flow is a
deterministic check on it (which is verifiable — by the agent now, by a hook/CI
or a runtime later).

```yaml
- id: review
  kind: map
  over: [substance_reviewer, style_reviewer]
  input: [ImplementationResult]
  output: ReviewReport[]            # conforms to review-report.schema.json

- id: review_gate
  kind: gate
  condition: no_blocking_issues     # = zero issues with severity "blocking"
  on_pass: test
  on_fail: revise

- id: revise
  kind: loop
  max_iterations: 1                 # loops are always bounded
  body: [implement_revision, review_revision]
  until: no_blocking_issues
  on_exhausted: summarize_best_attempt
```

The vocabulary is intentionally small and orthogonal:
`actor_call`, `tool_call`, `evaluator`, `gate`, `human_gate`, `router`, `map`,
`replicate`, `join`, `reduce`, `loop`, `artifact_op`, `subworkflow`. See
`.fadeno/vocabulary.md` and the runner's `references/playbook-format.md`.

### Validate

```bash
fadeno validate                                       # all playbooks
fadeno validate .fadeno/playbooks/code-change-review.yaml
fadeno validate .fadeno/runs/<id>/run.yaml            # run ledgers and review reports too
fadeno validate report.json --schema review-report    # force the document kind
```

`validate` runs three passes on a playbook:

1. **Schema** — structure against `playbook.schema.json` (unknown fields, bad
   `kind`, missing required fields…).
2. **Reference integrity** *(error)* — every step id referenced by `on_pass`,
   `on_fail`, `next`, `on_approve`, `on_reject`, `on_exhausted`, `default`, a
   loop `body`, or a `routes` map must resolve to a defined step; duplicate ids
   are flagged.
3. **Semantics** — every `actor` must be a declared role *(error)*; an `input`
   artifact never produced upstream, or a declared-but-unused role, are
   *warnings*.

It also validates `run.yaml` and `review-report.json` documents (auto-detected,
or forced with `--schema playbook|run|review-report`). Exits non-zero on any
error; warnings are reported but don't fail.

---

## Enforcement: advisory vs. enforced

Fadeno targets three tiers of host capability. The **same playbooks** run on all
three; only the host adapter changes.

| Tier | Hosts | Gate / approval enforcement |
|------|-------|------------------------------|
| **1. Instruction-only** | Codex, Claude Code | **Advisory** — the model is *asked* to honor `require_user_approval_for`. No hard guarantee. |
| **2. Hook-enabled** | CI, pre-commit, Claude Code hooks | **Enforced** — deterministic checks run regardless of model compliance. |
| **3. Compiled runtime** *(future)* | purpose-built orchestrator | **Enforced** at the runtime level. |

In tier 1, `require_user_approval_for` and gate conditions are *advisory data the
model is asked to follow* — not guarantees. The portable place for **real**
enforcement is your git/CI/pre-commit layer, because it is harness-agnostic and
also protects against human mistakes, not just agent ones.

Fadeno is designed so the same conditions are deterministically checkable: gate
conditions are computable from a structured judgment artifact
(`review-report.schema.json`), and approval categories map to concrete, detectable
actions. Two ways to make that real:

- **`fadeno gate <run> no_blocking_issues`** computes the gate from the review
  report and exits 0/1 — drop it into CI, a git hook, or a Claude Code `Stop`
  hook.
- **`fadeno init --with-hooks`** scaffolds runnable enforcement: an executable
  `.fadeno/hooks/pre-commit` (dependency/secret guard), a
  `.github/workflows/fadeno-guard.yml` CI guard, and (on Claude) a
  `settings.example.json` hook config. Activate them per `.fadeno/hooks/README.md`.

`.fadeno/enforcement.md` documents the patterns. Fadeno still doesn't *force*
enforcement on you — but the data shapes support it and the scaffold is one flag
away.

---

## Why Fadeno

Fadeno makes complex AI-agent work **repeatable, inspectable, portable, and easy
to customize** — without locking you into one agent platform or a heavyweight
runtime. It's mostly files: schemas, starter playbooks, skills, and a small CLI.

It is intentionally **not**: a background scheduler, a daemon, a cloud service, a
visual graph editor, a real parallel execution engine, or a model-provider
integration. Those are non-goals for v0.

---

## Development

```bash
npm install
npm test          # node --test over test/**/*.test.ts (no test framework dep)
npm run build     # tsc → dist/ (rewrites .ts imports to .js); sets the bin executable
node src/cli.ts --help   # run from source (Node ≥ 22.6 strips types natively)
```

The CLI has only two runtime dependencies (`ajv`, `yaml`) and uses Node's
built-in argument parser and test runner. TypeScript source is written in
erasable syntax so it runs directly under Node and compiles cleanly to ESM.

## License

MIT — see [LICENSE](LICENSE).

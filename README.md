# Fadeno

**The playbook layer for AI coding agents.**

> **Fadeno** /fah-DEH-no/ — Esperanto for *"thread."* The thread that runs through every agent task.

When an agent cuts a PR it shows you the diff, not the process that produced it. There's no evidence for what workflow produced the change or how it was reviewed or tested. Fadeno is agent workflows as code.

Stop re-typing *"be careful, plan, review, test"* every run. Define your workflow once as a repo-native YAML playbook, and any agent runs it the same way. No daemon, no cloud service, no lock-in.

## Quickstart

Install the Fadeno plugin for your harness, start a fresh session, and ask the
agent to set up Fadeno. The plugin's private CLI installs a stable user runtime
and safe native defaults; no separate global `fadeno` install or repository
initialization is required. Then ask for a normal task—the runner can use the
built-in playbooks in any Git repository.

```text
Set up Fadeno for Codex.
Use Fadeno to add CSV export for reports, including review and tests.
```

Terminal use is optional. Install the standalone npm CLI only when humans or CI
need to invoke `fadeno` directly.

---

## Why Fadeno

Fadeno makes complex AI-agent work **repeatable, inspectable, portable, and easy
to customize**. It isn't intended to make the agent smarter, it makes the work verifiable and controllable. 

It is intentionally **not** a background scheduler, a daemon, a cloud service, a
visual graph editor, a real parallel execution engine, or a model-provider
integration.

## The problem

Coding agents produce unverifiable work. They are powerful but inconsistent. Every nontrivial task, you re-explain the same discipline:

> *"Codex, please be careful. Make a plan first, then implement it. Review your own code for edge cases. Run the tests. If something's broken, fix it. Don't install new dependencies or run anything destructive without checking with me."*

### The fix

Define the workflow **once**, commit it to your repo, and then just say:

> *"Use the code-change-review playbook."*

Same discipline — plan → implement → review → test → bounded revision — every time. Inspectable. Shareable. Portable across the agents your team actually uses.

Fadeno is **harness-neutral**: the same playbooks run on Codex, Claude Code, and Grok Build today. Its repo-local runtime records durable execution evidence; only a thin per-target adapter differs, while richer compiled orchestration remains future work.

> **Honest about enforcement, up front:** in instruction-only hosts, approval policies are *advisory* — the model is asked to honor them, with no hard guarantee. For real guarantees, wire gates to your git/CI/pre-commit layer (or Claude Code hooks). See [Enforcement](#enforcement-advisory-vs-enforced). We'd rather you trust the tool because it's honest than because it overclaims.

---

## Install & initialize

Requires Node.js ≥ 20.

Installing the Codex or Claude plugin supplies skills, a private bundled CLI,
schemas, starter playbooks, and a safe native loadout. On first setup that CLI
copies itself to a stable user data path, records the harness integration, and
materializes user-scoped agents where the host requires them. A repository does
not need `.fadeno/` definitions to run a built-in playbook.

| User | First-run path | Separate global CLI? |
|------|----------------|----------------------|
| Codex | Install plugin → fresh session → ask to “set up Fadeno for Codex” | No |
| Claude Code | Install plugin → reload plugins → `/fadeno:setup` | No |
| Terminal / CI / Grok | Install the npm package, then use `fadeno` or `npx fadeno` | Yes |

`setup` is user-only: it does not write `.gitignore`, `.fadeno/`, or any other
project file. Codex needs one fresh session after setup or a native-loadout
change because its custom-agent definitions are session-static. Claude plugin
skills and commands become active after `/reload-plugins` or a restart.

Project installation is a separate, deliberate choice:

```bash
# Codex target  → .agents/skills/, AGENTS.md, $-style invocation
npx fadeno init --codex

# Claude Code target → .claude/skills/, CLAUDE.md, /-style invocation
npx fadeno init --claude

# Grok Build target → .grok/skills/, AGENTS.md, /-style invocation
npx fadeno init --grok
```

`init` remains the explicit project-vendoring path and is safe to re-run: existing files are left untouched (and your
`AGENTS.md`/`CLAUDE.md` content is preserved — Fadeno only appends a marked
section). Use `--force` to overwrite. Add `--with-hooks` to also scaffold the
tier-2 [enforcement](#enforcement-advisory-vs-enforced) layer (a pre-commit
guard + a CI workflow). Steering is installed by default for Codex and Claude.
Use `--no-steering` for the legacy native-only project surface;
`--with-steering` remains an accepted compatibility alias. Selecting a command
loadout is still explicit and always announces the external sandbox boundary.

### What gets created

```
.fadeno/
  vocabulary.md                 # the small, orthogonal term set
  enforcement.md                # advisory vs. enforced (tier-1 vs tier-2)
  playbooks/
    code-change-review.yaml
    research-synthesis.yaml
    pr-review.yaml
    compositional-review.yaml
  schemas/
    playbook.schema.json        # the source of truth for the vocabulary
    run.schema.json
    review-report.schema.json
  runs/                         # created lazily; ignored execution traces

# Codex (--codex):                      # Claude Code (--claude):
AGENTS.md                                CLAUDE.md
.agents/skills/                          .claude/skills/
  fadeno-runner/  (SKILL.md, refs,         fadeno-runner/  (SKILL.md, refs)
                  agents/openai.yaml)      fadeno-builder/ (SKILL.md, refs)
  fadeno-builder/ (SKILL.md, refs,       .claude/agents/  (worker/reviewer/judge.md)
                  agents/openai.yaml)
  fadeno-driver/  (SKILL.md, refs,
                  agents/openai.yaml)
.codex/agents/  (worker/reviewer/judge.toml)

# Grok Build (--grok):
AGENTS.md
.grok/skills/                         # shared SKILL.md bodies + references
.grok/agents/                         # worker/reviewer/judge.md
```

The playbooks, schemas, vocabulary, and SKILL.md *bodies* are **identical** on
all targets. Only the install dir, bootstrap file + invocation sigil, invocation
policy, and subagent format differ. Grok uses `.grok/skills/`, `.grok/agents/`,
and `AGENTS.md`; it does not create `.grok/config.toml` or change Claude settings.

### Plugin-first installation

`init` copies capabilities into one repo. Codex and Claude Code users can instead
install Fadeno once as a plugin for every project. Each plugin carries the
bundled CLI and immutable built-in definitions, so starter playbooks work
without a project data seed. Use
`init --data-only` when you want only project-owned definitions. `vendor` is the
deliberate full-capability path (skills, bootstrap, agents, definitions, and a
lock); do not use it merely to make plugin built-ins available.

```bash
# Codex: the Fadeno repo contains the marketplace pointer and plugin payload
codex plugin marketplace add CrocSwap/fadeno
codex plugin add fadeno@fadeno

# Claude Code: the same repo doubles as a Claude plugin marketplace
/plugin marketplace add <owner>/fadeno      # or a local path for testing
/plugin install fadeno@fadeno               # provides /fadeno:runner and /fadeno:builder

# built-in playbooks work immediately; optional definitions-only customization:
npx fadeno init --claude --data-only
```

> **After installing, run `/reload-plugins`** (or restart Claude Code). The
> skills, `/fadeno:*` slash commands, and bundled CLI are available immediately,
> but the role subagents (`worker`, `reviewer`, `judge`) register only at a
> session boundary. Until they do, a run still completes — it just falls back to
> simulated role-passes instead of dedicated subagents, and says so in the
> ledger (a `roles_degraded` event).

A full run makes many `fadeno` CLI calls, so `init --claude` pre-approves
`Bash(fadeno:*)` in `.claude/settings.local.json` (local, git-ignored) — the CLI
then stops prompting on every call. It's a per-user convenience, never committed;
delete that allow rule to restore prompts. (Plugins can't grant Bash permissions
to themselves; the explicit plugin setup instead adds a user-scoped rule for
the stable managed-runtime path and records that exact rule for uninstall.)

To test the plugin locally before publishing: `claude --plugin-dir ./plugin`.
The `plugin/` directory is generated from the same templates as the CLI
(`npm run build:plugin`), so the skills never drift.

The Claude plugin is **self-contained**: every skill carries a private launcher
for the bundled CLI in `plugin/bin/`. Skills do not depend on shell `PATH`.
First setup copies that bundle to a stable user runtime so managed agents remain
valid across plugin cache/version changes. A plugin install therefore gives the
harness a working Fadeno runtime without claiming to install a global shell
command.

The Codex plugin carries the skills, invocation metadata, a self-contained
`bin/fadeno`, and adjacent built-in definitions. `$fadeno-setup` installs the
stable user runtime and user-scoped managed native agents; a fresh session is
required after those agents change. Project overrides remain available through
`fadeno vendor` or `fadeno steering apply ... --scope project`.

Grok Build has native repo-local support through `npx fadeno init --grok`; this
release does not add a separate Grok plugin generator or mutate Grok permission
files. Use `--data-only` when the Grok session already has the shared skills from
another compatible installation.

### Ownership and removal

Fadeno records plugin-created user integrations in
`~/.local/state/fadeno/installations.json` (respecting XDG paths). Removal is
ownership-aware: managed or byte-identical files are removed, while edited files
are reported and preserved.

```bash
fadeno uninstall --codex               # remove one harness integration
fadeno uninstall --all                 # remove all recorded integrations/runtime
fadeno uninstall --purge-user-data --force
fadeno clean                            # preview removal of repo-local runtime output
fadeno clean --force                    # remove runs/progress/local dispatch state
fadeno unvendor                         # remove digest-matching files from fadeno.lock
```

Global uninstall never walks repositories. `clean` preserves project definitions
and promoted evidence. `unvendor` preserves locally edited vendored files unless
explicitly forced.

---

## Running a playbook

Fadeno ships three skills: runner, builder, and driver. Point your agent at the
**runner**:

| Host | How |
|------|-----|
| Codex | `$fadeno-runner`, or `/skills` to browse, or just describe a complex task (implicit). |
| Claude Code | `/fadeno:runner` (plugin command), or describe a complex task (implicit). |
| Grok Build | `/fadeno-runner`, or describe a complex task (implicit). |

`/fadeno:runner` is the namespaced Claude plugin command. Native Grok projects
use the repo-local `/fadeno-runner` skill emitted by `init --grok`.

The runner will:

1. pick the best playbook from the bundled-plus-project catalog (using each
   playbook's `when_to_use`; project names shadow bundled names),
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
fadeno new-run code-change-review "Review the supplied specs" \
  --input Agent1Spec=specs/agent-1.md --input Agent3Spec=specs/agent-3.md
fadeno run <run-id> --step implement            # set current_step + log step_started
fadeno run <run-id> --status completed           # finalize: status + ended_at + run_completed
fadeno gate <run-id> no_blocking_issues \
  --artifact artifacts/review-report.json       # exit 0/1; --report is deprecated
fadeno gate <run-id> tests_pass \
  --artifact artifacts/test-result.json         # status passed + exit_code 0
fadeno runs                                     # list run ledgers (newest first)
fadeno show <run-id-or-prefix>                  # logical-step projection (--events for the raw timeline)
fadeno verify <run-id>                          # recompute the ledger's checkable claims; exit 0/1 (--latest for newest)
fadeno drive <run-id>                           # engine: advance until terminal or a human pause (uses .fadeno/executors.yaml)
fadeno decide <run-id> <option>                 # resolve a paused human decision, then re-drive
fadeno dispatch-start <run-id> <dispatch-id> --agent-id <native-id>
fadeno dispatch-progress <run-id> <dispatch-id> --file <status.json> --source agent
fadeno dispatch-complete <run-id> <dispatch-id> --output <temporary-file>
fadeno dispatch-fail <run-id> <dispatch-id> --reason "blocked"
fadeno dispatch-fallback <run-id> <dispatch-id> # exact snapshotted command fallback

# Engine-delivered Codex steering resolves the immutable request envelope:
fadeno steering resolve --archetype worker --native-executor luna \
  --run <run-id> --dispatch-id <dispatch-id>

fadeno prompt <run-id> <step> --actor <role> \
  --no-record                                   # assemble a step's actor prompt (pipe to codex/claude)
```

`fadeno prompt` deterministically assembles the exact prompt a step's actor
receives — from the validated playbook, the ledger, and the referenced artifact
bytes — and records it as an immutable snapshot (`artifacts/prompts/…`) plus a
`prompt_assembled` manifest event, unless `--no-record`. A driver runs a role
with `fadeno prompt <run> <step> --actor <role> | codex exec -`.

When a role binds to a native host executor, `fadeno drive` plans all pending
calls and returns `awaiting_host_dispatch` with stable request ids. The host
starts each native agent and submits the receipts above; model, reasoning
effort, and native agent identity are recorded as explicit host attestations.
If that host executor declares `fallback_command` and the current Codex agent
does not match, `dispatch-fallback` invokes the exact snapshotted argv and owns
the receipts. The ledger labels this `command-fallback` and does not claim
native host attestation.
The immutable prompt names an ephemeral progress sidecar. Agents or harnesses
update that JSON at meaningful checkpoints; the host records provenance-labelled
observations with `dispatch-progress`. Progress is attested observability, never
a gate input.
An earlier failed host attempt is accepted in a completed trace only when a
higher-ordinal successful retry for the same actor call is recorded; final or
unresolved failures remain verification failures.

Compositional maps add `body`: Fadeno instantiates that child graph once per
literal member. A body may contain a bounded loop, and a loop body may contain a
map. Each leaf has a canonical path such as
`complete_items[member=item_3]/revision_cycle[generation=2]/review`, allowing
members to advance independently while artifacts, progress, `show`, and
verification remain aligned. The first executable slice supports native `host`
adapters and linear container bodies; dynamic maps, branchy bodies, and command
adapter leaves remain follow-up scope.

`fadeno show` projects the ledger onto the original playbook graph, including
nodes that have not started. Every step, literal map actor, and compositional
map member appears as
pending, running, waiting, blocked, completed, or failed, with actor/step
elapsed time and total run time. When progress exists, the view includes its
phase and current action; it never infers internal state from busy/idle alone.

`fadeno gate` is the **advisory→enforced bridge**: it computes a gate condition
from a structured judgment artifact on disk (same check the runner applies), so
the identical condition can run in CI, a pre-commit/pre-push hook, or a Claude
Code `Stop` hook. Exits non-zero when the gate fails.

### Loadouts: switch who does the work

If you rotate metered subscriptions across providers — one model as the worker
until that quota runs low, then another — the unit you think in is *"who is my
worker / reviewer / judge right now,"* not a dozen per-role YAML edits.
`.fadeno/executors.yaml` declares harness-neutral **targets** (provider, model,
effort), harness-specific **routes** for delivering those targets, and
**loadouts** that map archetypes to targets. The same loadout therefore remains
portable: Claude may run an Anthropic target natively while Codex delivers that
same target through `claude -p`.

```yaml
schema_version: 2
targets:
  opus-high: { provider: anthropic, model: opus, reasoning_effort: high }
  terra-high: { provider: openai, model: gpt-5.6-terra, reasoning_effort: high }
  sol-high: { provider: openai, model: gpt-5.6-sol, reasoning_effort: high }
routes:
  codex:
    openai: { native: true, command: [codex, exec, --model, "{model}", "-"] }
    anthropic: { command: [claude, -p, --model, "{model}"] }
  claude:
    anthropic: { native: true, command: [claude, -p, --model, "{model}"] }
    openai: { command: [codex, exec, --model, "{model}", "-"] }
loadouts:
  anthropic-primary: { worker: opus-high, reviewer: opus-high, judge: opus-high }
  openai-primary:    { worker: terra-high, reviewer: terra-high, judge: sol-high }
default_loadout: anthropic-primary
```

Put shared personal overrides in `~/.config/fadeno/executors.yaml`; use a
project `.fadeno/executors.yaml` only when the repository truly needs different
targets or policy. Legacy v1 `executors` profiles remain supported.

```bash
fadeno use openai-primary                  # user-scoped; remembers setup's harness
fadeno loadout use openai-primary           # compatibility: project-local pin
echo "task…" | fadeno dispatch --archetype worker   # ad-hoc: resolve → invoke → evidence row
fadeno setup --codex                        # one-time user-scoped native integration
fadeno use codex-native                     # auto-materializes changed Codex role agents
# or: npx fadeno init --claude --no-steering
```

Roles resolve at dispatch time — explicit binding pin, else the active
loadout's slot for the role's declared `archetype`, else the `"*"` default —
and every run start and dispatch echoes where each role landed
(`implementer → luna-cli-xhigh (gpt-5.6-luna) [loadout openai-primary]`). Runs
record the resolution in their ledger and ad-hoc dispatches append to
`.fadeno/dispatches.jsonl`, so which provider produced an artifact stays
auditable after the fact.

With steering enabled by default, expensive role-shaped subagent work follows
that same resolver. `fadeno setup --codex` remembers the harness, so later
`fadeno use <loadout>` calls materialize each worker/reviewer/judge target as
either a native host agent or a command broker according to the Codex route.
The Claude hook performs the same resolution for Claude rather than relying on
adapter labels stored in the loadout: native slots select the requested Claude
model, while command slots use dispatch proxies.
Start a fresh Codex session after definitions change only to make the new model
session-native; fallback-capable switches work on the next invocation. Before
each task, native agents resolve again: command slots switch immediately,
matching host slots execute natively, a different fallback-capable host slot
runs out-of-process, and only a host slot without a fallback reports
`restart_required`. Claude installs a
local `PreToolUse` rewrite that redirects role launches to bundled dispatch
proxies. Explore/Plan-style scouting stays native. Existing files retain the
normal non-destructive rule; `steering apply` needs `--force` to replace them.

### What `.fadeno/runs/` contains

Each run is a directory — the file-backed "degraded runtime" that makes a run
inspectable (and is the seam a future compiled runtime reads/writes):

```
.fadeno/runs/2026-05-30-1132-csv-export/
  run.yaml        # metadata: schema_version, playbook, status, task, started_at, host, current_step
  events.jsonl    # append-only lifecycle log, one JSON object per line, contiguous seq
  artifacts/      # every durable output: plans, patches, reviews, test results…
```

Since run-ledger format 0.3, every recorded artifact also gets an immutable
manifest (sha256 digest, size, media type, validation verdict) in the event
log — the evidence `fadeno verify` recomputes. Artifacts are immutable:
revision writes a new generation, never overwrites.

`runs/` is execution-trace output, **not source code**. It is safe to delete old
runs. Fadeno's managed ignore block keeps `.fadeno/runs/`, `.fadeno/progress/`,
`.fadeno/local/`, ad-hoc dispatch evidence, local Claude settings, and
materialized steering brokers out of commits. Commit project-owned playbooks,
schemas, policy, hooks, and `fadeno.lock`. To retain a run as source-controlled
evidence, use `fadeno evidence promote <run>`; it first verifies the receipt and
copies its immutable ledger plus snapshotted definitions to `.fadeno/evidence/`.

---

## Creating a playbook

Use the **builder** skill — it fires when you explicitly want to author or revise
a playbook (its description is scoped so it won't trigger just because a prompt
mentions "playbook"). Invoke it with `$fadeno-builder` (Codex) or `/fadeno:builder`
(Claude plugin command), or simply ask to build or modify a playbook. The builder
runs a short loop:

> **describe the flow** (or pick a starter to adapt) → builder **writes the YAML**
> → shows it back as a **diagram** + summary → you **approve** → it **hands off to
> the runner**. Built-in playbooks work without a project seed; use
> `init --data-only` for project-owned definition copies, or `vendor` only when
> you deliberately want the complete capability surface committed.

You can render any playbook's flow yourself:

```bash
fadeno diagram code-change-review              # annotated ASCII
fadeno diagram code-change-review --format mermaid   # graph for GitHub/docs
```

```
┌─ review ───────────────────────────── map ─┐
│ over [substance_reviewer, style_reviewer]  │
└──────────────────────┬─────────────────────┘
                       ▼
┌─ review_gate ─────────────────────── gate ─┐
│ no_blocking_issues                         │
│ ✓ pass ▶ test                              │
│ ✗ fail ▶ revise                            │
└────────────────────────────────────────────┘
                       ⋮
┌─ revise ──────────────────────────── loop ─┐
│ max 1 · until no_blocking_issues           │
│ body: implement_revision ▶ review_revision │
│ ✓ success ▶ test                           │
│ ⤓ exhausted ▶ unresolved_review            │
└────────────────────────────────────────────┘
```

Each step is a card; `▼` is sequential fall-through and `⋮` marks a step reached
only via a labelled `▶` arrow (a gate branch, loop exit, or jump). Verbose
primitive kinds are abbreviated in the diagram (`actor_call` → `actor`,
`tool_call` → `tool`, `evaluator` → `eval`, `human_gate` → `ask`); the schema
keeps the full names.

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
  input:
    - ReviewReport[]
  condition: no_blocking_issues     # = zero issues with severity "blocking"
  on_pass: test
  on_fail: revise

- id: revise
  kind: loop
  input:
    - ReviewReport[]
  max_iterations: 1                 # loops are always bounded
  body: [implement_revision, review_revision]
  until: no_blocking_issues
  on_success: test
  on_exhausted: unresolved_review

- id: test_gate
  kind: gate
  input:
    - TestResult
  condition: tests_pass
  on_pass: final
  on_fail: tests_failed
```

The vocabulary is intentionally small and orthogonal:
`actor_call`, `tool_call`, `evaluator`, `gate`, `human_gate`, `router`, `map`,
`replicate`, `join`, `reduce`, `loop`, `artifact_op`, `subworkflow`. See
`.fadeno/vocabulary.md` and the runner's `references/playbook-format.md`.

### Validate

```bash
fadeno validate                                       # all playbooks
fadeno validate .fadeno/playbooks/code-change-review.yaml
fadeno validate .fadeno/runs/<id>/run.yaml            # run ledgers and artifacts too
fadeno validate report.json --schema review-report    # force the document kind
fadeno validate test-result.json --schema test-result
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

### Bash completion

The CLI can emit its own sourceable Bash completion script:

```bash
source <(fadeno completion bash)
```

Add that line to `~/.bashrc` to enable it in future shells. Completion covers
commands, their relevant flags, finite option values, paths, and (when the
current directory is a Fadeno repository) playbook names, run ids, steps,
loadouts, executors, and declared archetypes. It is a read-only best-effort
query: malformed or partially initialized repository data simply contributes
no dynamic candidates, and ordinary Bash file completion remains available.

The generated function asks `fadeno completion candidates` for one candidate
per line, preserving paths containing spaces. No optional `bash-completion`
package or extra command-line dependencies are required.

---

## Enforcement: advisory vs. enforced

Fadeno targets three tiers of host capability. The **same playbooks** run on all
three; only the host adapter changes.

| Tier | Hosts | Gate / approval enforcement |
|------|-------|------------------------------|
| **1. Instruction-only** | Codex, Claude Code, Grok Build | **Advisory** — the model is *asked* to honor `require_user_approval_for`. No hard guarantee. |
| **2. Hook-enabled** | CI, pre-commit, Claude Code hooks | **Enforced** — deterministic checks run regardless of model compliance. |
| **3. Compiled runtime** *(future)* | purpose-built orchestrator | **Enforced** at the runtime level. |

In tier 1, `require_user_approval_for` and gate conditions are *advisory data the
model is asked to follow* — not guarantees. The portable place for **real**
enforcement is your git/CI/pre-commit layer, because it is harness-agnostic and
also protects against human mistakes, not just agent ones.

Fadeno is designed so the same conditions are deterministically checkable: gate
conditions are computable from schema-valid structured artifacts
(`review-report.schema.json` and `test-result.schema.json`), and approval
categories map to concrete, detectable actions. Two ways to make that real:

- **`fadeno gate <run> <condition> --artifact <path>`** computes a condition
  from its named artifact and exits 0/1 — drop it into CI, a git hook, or a
  Claude Code `Stop` hook.
- **`fadeno verify <run>`** (or `--latest`) re-audits a whole run ledger
  read-only against 26 checks — artifact digests recomputed from bytes,
  typed-artifact schemas, artifact immutability, prompt-snapshot integrity,
  event-sequence contiguity, every deterministic gate result recomputed from
  its artifact, attempt ordinals with allowed retry reasons, executor
  bindings against the run's snapshotted profile, human-decision integrity
  (declared options, at-most-once), supersede references, harness-session
  continuity, and native host-dispatch lifecycle/request consistency — so a trace
  can't claim what its evidence doesn't support. The "no valid trace, no
  merge" check; anything unrecomputable is reported as skipped, never
  silently treated as valid.
- **`fadeno init --with-hooks`** scaffolds runnable enforcement: an executable
  `.fadeno/hooks/pre-commit` (dependency/secret guard), a
  `.github/workflows/fadeno-guard.yml` CI guard, a
  `.github/workflows/fadeno-verify.yml` trace-verification workflow, and (on
  Claude) a `settings.example.json` hook config. Activate them per
  `.fadeno/hooks/README.md`.

`.fadeno/enforcement.md` documents the patterns. Fadeno still doesn't *force*
enforcement on you — but the data shapes support it and the scaffold is one flag
away.

---

### Development

```bash
npm install
npm test            # node --test over test/**/*.test.ts (no test framework dep)
npm run build       # tsc → dist/ (rewrites .ts imports to .js); sets the bin executable
npm run build:plugin   # regenerate ./plugin from the templates (keeps it in sync)
node src/cli.ts --help # run from source (Node ≥ 22.6 strips types natively)
```

The CLI has only two runtime dependencies (`ajv`, `yaml`) and uses Node's
built-in argument parser and test runner. TypeScript source is written in
erasable syntax so it runs directly under Node and compiles cleanly to ESM.

**Contributing?** Start with [`AGENTS.md`](AGENTS.md) for the repo map and
invariants, then [`docs/architecture.md`](docs/architecture.md) (how the code is
built) and [`docs/extending.md`](docs/extending.md) (file-by-file recipes for
common changes).

## License

MIT — see [LICENSE](LICENSE).

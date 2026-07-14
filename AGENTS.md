# AGENTS.md — working on the Fadeno codebase

Orientation for an AI agent (or human) **contributing to Fadeno itself**. Read
this first, then jump to the deeper doc for whatever you're touching. The code is
the source of truth; this file and `docs/` exist to get you oriented fast and
point you at the right place.

> **Two different `AGENTS.md` files — don't confuse them.** *This* file documents
> the Fadeno repo for its contributors. Fadeno (the product) also *generates* an
> `AGENTS.md` into a **user's** repo as a bootstrap pointer — that one is a
> template at `templates/codex/AGENTS.md`, and it is short and product-facing. If
> you're editing "the bootstrap file Fadeno writes," that's the template; if
> you're editing "how contributors understand this repo," that's this file.

## What this repo is

Fadeno is a **portable playbook layer for AI coding agents** — a repo-native YAML
playbook format, a set of agent **skills** that run/author them, and a small
TypeScript **CLI** that scaffolds, validates, diagrams, and records runs. It is
currently a protocol + file-backed run traces + thin per-host adapters, **not a
runtime**. The approved next-protocol direction adds a small deterministic,
repo-local runtime in service of verification; it does not turn Fadeno into a
daemon, cloud service, or general orchestration platform. Targets today:
**Codex** and **Claude Code** (the latter also packaged as a Claude Code
**plugin**).

These docs frame the rest:

| Doc | What it answers |
|-----|-----------------|
| [`README.md`](README.md) | The product: what users get, how they use it. |
| [`docs/kickoff-memo.md`](docs/kickoff-memo.md) | The design spec — **why** the architecture is the way it is (tiers, gate discipline, portability). Settled; cite it, don't re-litigate it. |
| [`docs/architecture.md`](docs/architecture.md) | **How the code is built** — subsystems, data flows, the build/module system, gotchas, tests. |
| [`docs/extending.md`](docs/extending.md) | **How to change it** — file-by-file recipes for common tasks. |
| [`docs/roadmap.md`](docs/roadmap.md) | The shipped/deferred line and honest v0 gaps. |
| [`docs/experimental/next-protocol.md`](docs/experimental/next-protocol.md) | The **current forward implementation boundary** — a small engine-backed, verification-centered protocol. Read this before planning protocol/runtime work. |
| [`docs/experimental/ontology-and-execution-design.md`](docs/experimental/ontology-and-execution-design.md) | The evidence-tiered **North Star ontology**. It is a design horizon, not the next implementation scope. |

### Design precedence for forward work

The design documents intentionally describe different horizons:

1. `docs/kickoff-memo.md` is the settled rationale for the shipped v0 advisory
   protocol. Preserve it as history; do not retroactively rewrite it around the
   next architecture.
2. `docs/experimental/next-protocol.md` is the authoritative boundary for the
   next implementation. Where its engine decision conflicts with v0's runtime
   non-goal, the next-protocol document governs forward work.
3. `docs/experimental/ontology-and-execution-design.md` is the long-horizon
   vocabulary. A well-defined concept there is not approved implementation
   scope: promotion requires both an observed receipt and a meaningful
   verification check.

The experimental directory name reflects implementation status, not a weak or
superseded decision. Revisit the next-protocol boundary only with new dogfood
evidence; do not silently promote North Star entities into the core schema.

## Orient in 60 seconds

Fadeno is organized around **one split** and **one rule**:

- **The split — capability / definitions / traces.**
  - *Capability* = how to run/author playbooks: the **skills** (`runner`,
    `builder`), the role **subagents** (`worker`/`reviewer`/`judge`), and the
    **CLI**. Delivered by `fadeno init` (copied into a repo) **or** by the Claude
    plugin (installed once, globally).
  - *Definitions* = which playbooks: the per-repo **`.fadeno/`** tree
    (`vocabulary.md`, `playbooks/`, `schemas/`, `enforcement.md`). Seeded by
    `fadeno init` (or `init --data-only` for plugin users).
  - *Traces* = what happened: **`.fadeno/runs/`** ledgers (`run.yaml` +
    `events.jsonl` + `artifacts/`). Output, not source — safe to delete.
- **The rule — gates never "ask an LLM."** Control flow is always
  `evaluator → structured judgment artifact → deterministic condition` (e.g.
  `no_blocking_issues` = zero `blocking` issues in a `review-report.json`).
  Loops are always bounded; iteration artifacts are versioned, never overwritten.

Enforcement is **tiered**: instruction-only hosts are *advisory* (the model is
asked); real guarantees come from git/CI/pre-commit/hooks (tier 2). See
`templates/common/fadeno/enforcement.md`.

## Repo map

| Path | What lives here | Deeper doc |
|------|-----------------|------------|
| `src/cli.ts` | Entry point: arg parsing (`node:util.parseArgs`), command dispatch, **all** stdout/exit-code formatting (the "view"). | architecture.md → *The CLI* |
| `src/commands/*.ts` | One file per command. Each exports a `run*()` that **returns data and throws on error** — no `console.*`. | architecture.md, extending.md |
| `src/lib/*.ts` | Shared logic: `paths.ts` (root/templates/version resolution), `fsutil.ts` (non-destructive emit), `playbook-validate.ts` (3-pass validator), `diagram.ts` (ASCII/Mermaid). | architecture.md |
| `templates/` | **Single source of truth** for everything `init` emits *and* the plugin bundles. `common/` (shared) + `codex/` + `claude/` (per-target adapters). | architecture.md → *Templates & the plugin* |
| `plugin/` | The **generated, committed** Claude plugin (skills/commands/agents + the bundled `bin/fadeno`). A build artifact — never hand-edit; regenerate. | architecture.md, extending.md |
| `scripts/build-bin.mjs` | esbuild bundler → `plugin/bin/fadeno` (standalone CJS, deps inlined) + adjacent templates. | architecture.md → *Build & module system* |
| `test/` | `node:test` suite (~50 cases). `helpers.ts` = `tempRepo`/`exists`/`read`. Tests call `run*()` directly. | architecture.md → *Tests* |
| `docs/` | This guide's companions + the design spec, roadmap, and `product/` (marketing — **not** for code contributors). | — |
| `.claude-plugin/marketplace.json` | Makes the repo itself a one-repo plugin marketplace. | — |

The repo **dogfoods itself**: there's a gitignored `.fadeno/` at the root (a real
`init` instance) that `npm run validate:self` checks. The committed,
source-of-truth playbooks/schemas live under `templates/common/fadeno/`, not in
that gitignored tree.

## Invariants — don't break these

1. **Commands return data; `cli.ts` prints.** Keep `console.*` and exit codes in
   `cli.ts`. `commands/*` and `lib/*` return plain objects and `throw` typed
   errors. This is what makes the suite test `run*()` functions directly.
2. **`templates/` is the single source of truth; `plugin/` is generated.** Edit
   skills/playbooks/schemas/agents under `templates/`, then `npm run build:plugin`
   and commit the regenerated `plugin/`. Never hand-edit files under `plugin/`.
3. **One shared SKILL.md body per skill, sigil-free.** Targets differ only in the
   *adapter surface* (install dir, bootstrap file + `$`/`/` sigil, invocation
   policy, subagent format). Don't fork skill bodies per host.
4. **Emit is non-destructive.** `emitFile` skips existing files unless `--force`;
   `emitBootstrap` appends a marker-wrapped section instead of clobbering
   `AGENTS.md`/`CLAUDE.md`; settings merges never overwrite a malformed file.
   Preserve this for anything new `init` writes.
5. **The schema is the source of truth for the playbook vocabulary.** Changing the
   vocabulary is never a one-file edit — see *Add a step kind* in extending.md.
6. **Gate discipline.** Never introduce a control-flow path that asks a model to
   decide. Always evaluator → artifact → deterministic condition.
7. **TypeScript must be erasable.** `erasableSyntaxOnly` is on: no `enum`, no
   parameter properties, no value `namespace`. Source runs as ESM (dev/`dist/`)
   **and** as a bundled CJS binary (`plugin/bin`) — code must work under both
   (see `src/lib/paths.ts`). Strict mode + `noUnusedLocals`/`noUnusedParameters`:
   dead code fails the build.

## Dev loop

Requires **Node ≥ 20** (running the TS source directly via `npm run dev` needs
**≥ 22.6** for native type-stripping).

```bash
npm install
npm test               # node --test over test/**/*.test.ts (no test-framework dep)
npm run dev -- --help  # run the CLI from source: node src/cli.ts <args>
npm run build          # tsc → dist/ (rewrites .ts imports to .js), chmods the bin
npm run build:plugin   # regenerate plugin/ from templates/ + rebuild the bundled bin
npm run validate:self  # validate the repo's own (gitignored) .fadeno/ playbooks
```

Runtime deps are only `ajv` + `yaml`; arg parsing and tests use Node built-ins.

## Where to make a change

| Task | Start at |
|------|----------|
| Add / change a CLI command | extending.md → *Add a CLI command* |
| Add or modify a playbook step kind (primitive) | extending.md → *Add a step kind* |
| Add a deterministic gate condition | extending.md → *Add a gate condition* |
| Edit a skill, starter playbook, schema, or template | extending.md → *Change templates*; then `npm run build:plugin` |
| Support a new harness (e.g. Cursor) | extending.md → *Add a harness target* |
| Bump the version | extending.md → *Release a version* (rebuild + commit `plugin/`) |

When in doubt about *why* a design choice exists, the answer is almost always in
`docs/kickoff-memo.md`. When in doubt about *how the code does it*, read the code
— these docs are breadcrumbs, not a replacement.

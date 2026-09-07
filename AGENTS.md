# AGENTS.md — working on the Fadeno codebase

Orientation for an AI agent (or human) **contributing to Fadeno itself**. Read
this, then jump to the deeper doc for whatever you are touching. The code is the
source of truth; these docs exist to get you oriented fast and point you at the
right place.

## What this repo is

Fadeno is a **meta-harness for subagent work**: it routes delegated work to
models by archetype, wraps every spawn with deterministic scaffolding (a git
worktree, a contract, a ledger row), and tells a host session what it can
delegate and what is still open. It is a CLI plus a family of harness hooks that
call it, generated from one template tree.

It is **not** a workflow engine, a daemon, a cloud service, or an orchestration
platform. Composing a sequence of dispatches is the intelligence's job.

| Doc | What it answers |
|-----|-----------------|
| [`README.md`](README.md) | The product: what a user gets and how they use it. |
| [`docs/redesign/spec.html`](docs/redesign/spec.html) | **The specification.** Behaviour, not implementation. Settled — cite it, don't re-litigate it. |
| [`docs/redesign/decisions.html`](docs/redesign/decisions.html) | **Why**: 34 decisions, each with the evidence that produced it. |
| [`docs/architecture.md`](docs/architecture.md) | **How the code is built** — the two lanes, the source map, the build, the tests. |
| [`docs/extending.md`](docs/extending.md) | **How to change it** — file-by-file recipes. |
| [`docs/redesign/lessons.md`](docs/redesign/lessons.md) | What the deleted test suite had learned, kept after the code that held it went. |

`docs/history/` holds the design documents from before the 0.7 rewrite — the
kickoff memo, the roadmap, the experimental protocol boundary. They describe a
product that no longer exists; read them for context, never as a plan.
`docs/product/` is marketing collateral for that same era.

## Orient in 60 seconds

Fadeno's whole job is the space between "the host decides to delegate" and "the
host decides what to do with the result". Four things happen in it, in this
order, and every one of them is the CLI's:

1. **Resolve.** An archetype (`worker`, `reviewer`, `judge`, `scout`,
   `director`, or one a repo declares) resolves to a model and effort by walking
   the dial cascade — binding → session → repo → user → base. No dial anywhere
   means the host's own model.
2. **Choose the lane.** One bit: can this session deliver the resolved model
   itself? Yes → **host lane**, a subagent in-session. No → **command lane**, a
   process Fadeno spawns, reached through a dispatch proxy so the host still
   sees an ordinary subagent. The host is never told which.
3. **Scaffold.** A git worktree at `.fadeno/local/worktrees/<name>` on branch
   `fadeno/<name>`, and the worker contract appended to the caller's prompt.
4. **Record.** An `opened` row; later a `stopped` row from the stop hook, and a
   `closed` row when the host decides. Append-only, in
   `.fadeno/dispatches.jsonl`.

**The hooks write nothing.** They read an event, call the CLI, apply the answer.
Every rule has one implementation.

## Repo map

| Path | What lives here | Deeper doc |
|------|-----------------|------------|
| `src/cli.ts` | Entry point: `parseArgs`, command dispatch, **all** stdout and exit codes (the view). | architecture.md |
| `src/commands/*.ts` | One area per file. Each exports `run*()` that **returns data and throws** — no `console.*`. | architecture.md, extending.md |
| `src/lib/executors.ts` | The catalog and the one resolver. | architecture.md → *The catalog* |
| `src/lib/spawn.ts` | The wrapper: resolve, prepare, run, record, cancel. | architecture.md → *The dispatch lifecycle* |
| `src/lib/ledger.ts` | The three-row ledger, read tolerantly. | architecture.md |
| `templates/` | **Single source of truth** for everything the plugins carry: the catalog, the hook family, the skills, the generated agents. | extending.md → *Change a template* |
| `plugin/`, `plugin-codex/`, `plugin-omp/` | **Generated and committed.** Never hand-edit; regenerate. | extending.md |
| `scripts/build-bin.mjs` | esbuild → each plugin's standalone CJS `bin/fadeno` plus adjacent templates. | architecture.md → *Build* |
| `test/` | `node:test`, 299 tests. `helpers.ts` and `hook-helpers.ts` hold the fixtures. | architecture.md → *Tests* |

The repo dogfoods itself: there may be a gitignored `.fadeno/` at the root with
real dispatches in it. `.fadeno/local/` is scratch and `clean` may remove it;
`.fadeno/prompts/` and `.fadeno/dispatches.jsonl` are evidence and it never
does.

## Invariants — don't break these

1. **Commands return data; `cli.ts` prints.** Keep `console.*` and exit codes in
   `cli.ts`; `commands/` and `lib/` return plain objects and throw typed errors.
   This is what lets the suite call `run*()` directly.
2. **`templates/` is the source of truth; `plugin*/` is generated.** Edit
   templates, run all three plugin builds, commit the result. Drift tests fail
   otherwise.
3. **Hooks write nothing.** A hook that decides something is a second
   implementation of a rule that already has one.
4. **One question, one function.** When two surfaces answer the same question
   they call the same code — `laneOf`, `resolveDelivery`, `runDialShow`,
   `roleResolutionEchoLabel`. Two consumers of one list, disagreeing, is this
   codebase's recurring defect; every one of those functions exists because it
   happened.
5. **Never a silent wrong answer.** A file this Fadeno cannot read is an error
   naming the file and the fix — never a fall-through to an empty value that
   looks healthy. That rule outranks convenience every time.
6. **No locks, no deadlines.** Nothing waits on a mutex; nothing is killed on a
   timer. Contention is answered by giving every dispatch its own worktree, and
   a long attempt is ended by a person with `cancel`.
7. **Fadeno enforces nothing it cannot enforce.** No permission claims in YAML,
   no attestation, no tamper detection. Restriction belongs in an argv a reader
   can see; containment is the worktree, and the worktree contains file writes
   only.
8. **TypeScript must be erasable.** `erasableSyntaxOnly` is on: no `enum`, no
   parameter properties, no value `namespace`. The source runs as ESM **and** as
   bundled CJS — code must work under both (see `src/lib/paths.ts`). Strict mode
   plus `noUnusedLocals`/`noUnusedParameters`: dead code fails the build.

## Dev loop

Requires **Node ≥ 20** (≥ 22.6 to run the TS sources directly).

```bash
npm install
npm test                 # node --test over test/**/*.test.ts
npm run dev -- --help    # run the CLI from source
npx tsc --noEmit -p .    # typecheck
npm run build            # tsc → dist/
npm run build:plugin     # regenerate plugin/ + rebuild the bundled bin
npm run build:plugin:codex
npm run build:plugin:omp
```

Runtime deps are only `ajv` and `yaml`; arg parsing and tests use Node built-ins.

**Mid-flight escape hatch.** Editing `templates/` makes the committed plugins
stale and the drift tests fail until you rebuild — which blocks running the
suite while work is in progress. `FADENO_SKIP_DRIFT=1 npm test` runs everything
with only those comparisons skipped, loudly. Rebuild and run clean before
integrating.

## Where to make a change

| Task | Start at |
|------|----------|
| Add or change a CLI command | extending.md → *Add a CLI command* |
| Add a model | extending.md → *Add a model to the registry* |
| Support a harness Fadeno SPAWNS | extending.md → *Add a harness Fadeno can spawn* |
| Support a harness Fadeno runs INSIDE | extending.md → *Add a harness Fadeno can run inside* |
| Add an archetype | extending.md → *Add an archetype* |
| Change a skill, the catalog, a hook, an agent | extending.md → *Change a template* |
| Change what an agent is told | extending.md → *Change what a dispatched agent is told* |
| Release | extending.md → *Release a version* |

When in doubt about *why* a design choice exists, the answer is in
`docs/redesign/decisions.html`. When in doubt about *how the code does it*, read
the code — these docs are breadcrumbs, not a replacement.

# Architecture

How the Fadeno codebase is built. This is the implementation map; for *why* the
design is shaped this way, see [`kickoff-memo.md`](kickoff-memo.md). For *how to
make a specific change*, see [`extending.md`](extending.md).

## The shape of the system

Fadeno is a CLI plus a set of templated assets. Nothing here is a long-running
process — every command is a pure-ish function over the filesystem.

```
                 templates/  ── single source of truth ──┐
                    │                                     │
   fadeno init  ────┤ copies into a user repo            │  fadeno plugin +
   (capability +    │  (.fadeno/, skills, subagents,     │  build-bin.mjs
    definitions)    │   bootstrap, settings, hooks)      │  generate ↓
                    │                                     ▼
   .fadeno/runs/ ◀──┘ written by new-run / run / gate    plugin/  (committed)
   (traces)           as a playbook executes              capability, installed once
```

Three layers, mirrored in the directory split (the organizing principle from the
kickoff memo):

- **Capability** — skills + subagents + CLI. Source under `templates/common/skills`,
  `templates/{codex,claude}/*-agents`, and `src/`.
- **Definitions** — the `.fadeno/` tree. Source under `templates/common/fadeno`.
- **Traces** — `.fadeno/runs/<id>/`. Created at runtime by the CLI; no template.

## The CLI

### Dispatch and the view layer (`src/cli.ts`)

`cli.ts` is the only place that talks to the terminal. It:

1. Parses argv with `node:util.parseArgs` (no arg-parser dependency).
2. Resolves global flags (`--help`, `--version`).
3. Dispatches on the first positional to a `run*()` function.
4. Formats the returned data into stdout/stderr and sets `process.exitCode`.

The top-level `try/catch` turns any thrown error into `Error: <message>` + exit 1.
`HELP` (the usage string) lives here and must be updated whenever you add a
command or flag.

### Commands return data; they don't print (`src/commands/*.ts`)

Every command file exports a single `run*(opts)` that **returns a result object**
and **throws a typed error** on failure (`RunError`, `GateError`, `NewRunError`,
`ValidateError`, or a plain `Error`). None of them call `console.*`. This is a
hard convention — it's what lets the test suite call the functions directly and
assert on return values and filesystem effects instead of scraping stdout.

| Command | Returns | Notes |
|---------|---------|-------|
| `runInit` | `EmitResult[]` + `repoRoot` | Scaffolds a target; see *Templates & the plugin*. |
| `runValidate` | per-file results + `ok` | The 3-pass validator; see below. |
| `runDiagram` | a rendered string | Pure; delegates to `lib/diagram.ts`. |
| `runNewRun` | `runId` + `runDir` | Creates a run ledger. |
| `runRun` | updated fields + appended events | Mutates `run.yaml`, appends `events.jsonl`. |
| `runGate` | pass/fail + blocking titles | The advisory→enforced bridge. |
| `runPrompt` | prompt text + sha + record status + plan | Deterministic step-prompt assembler; records a snapshot + `prompt_assembled` by default. Pure resolution/rendering live in `lib/prompt-resolve.ts` + `lib/prompt.ts`. |
| `runNext` | next-step JSON (`status`, `step`, `gate`, …) | Pure flow cursor over playbook + events; read-only. Logic in `lib/flow-cursor.ts`. |
| `runPlugin` | `EmitResult[]` + `outDir` | Generates `plugin/` from templates. |

All commands accept injectable `cwd` / `repoRoot` (and `now` where time matters)
so tests stay hermetic and deterministic.

### Shared libs (`src/lib/`)

- **`paths.ts`** — `findRepoRoot()` (walks up for `.git`), `templatesDir()`
  (locates the bundled `templates/`), `packageVersion()`, and `findUp()`. Handles
  the **dual module system** (see *Build & module system*).
- **`fsutil.ts`** — the non-destructive emit primitives: `emitFile`
  (skip-unless-`force`), `copyTree` (recursive, renames `gitkeep` → `.gitkeep`),
  and `emitBootstrap` (marker-wrapped, idempotent section in `AGENTS.md`/
  `CLAUDE.md`). Everything `init`/`plugin` writes goes through these, so they all
  share the same skip/overwrite/append semantics and report an `EmitStatus`.
- **`playbook-validate.ts`** — the validator (below).
- **`diagram.ts`** — the renderer (below).
- **`flow-cursor.ts`** — pure `computeNext(playbook, events)` for `fadeno next`.
- **`prompt-resolve.ts` / `prompt.ts`** — pure step-prompt plan + render for `fadeno prompt`.
- **`run-ledger.ts`** — list/resolve runs, parse events, list artifacts.

## The validator (`src/lib/playbook-validate.ts`)

`validateFile()` runs schema, reference, and semantic passes; severity-aware, so
**warnings don't fail the build** (only `error`-severity issues do).

1. **Schema** — Ajv against the relevant JSON Schema in `.fadeno/schemas/`.
   `SchemaSet` lazily compiles and caches the shipped schemas (`playbook` / `run`
   / `review-report` / `test-result`). It registers a dependency-free
   `date-time` format (a lenient `Date.parse`) so run timestamps are actually
   checked and Ajv doesn't warn about an unknown format.
2. **Reference integrity** *(playbook only, errors)* — every step id referenced by
   a control-flow field (`next`, `on_pass`, `on_fail`, `on_approve`, `on_reject`,
   `on_success`, `on_exhausted`, `default`), a loop `body`, or a `routes` map must
   resolve to a defined step; duplicate ids are flagged.
3. **Normalized control flow and definite artifacts** *(playbook only)* — physical
   fallthrough is added only for steps without explicit outgoing control flow;
   loop-body definitions are reachable only through their owning loop. The
   validator reports unreachable steps, loop recursion/multiple ownership,
   invalid terminal declarations, unsupported condition bindings, and inputs that
   are absent from the intersection of incoming artifact paths. Loop body outputs
   are available on both success and exhaustion.
4. **Role semantics** *(playbook only)* — every `actor`/`actors` entry must be a
   declared role *(error)*; declared-but-unused roles are *warnings*. `over` items
   count as role usage (a `map` over roles), which is why they aren't error-checked.

Semantic analysis runs only when the playbook schema and references are clean.
`detectKind()` infers the document type from its shape (then its path) when
`--schema` isn't given; only playbooks get semantic analysis, while `run.yaml`,
`review-report.json`/`ReviewReport[]`, and `test-result.json` get the schema pass
alone.

> The schema is the **single source of truth for the vocabulary**; the validator
> enforces the cross-references and semantics a schema can't express.

## The run ledger

A run is a directory — the file-backed "degraded runtime" for instruction-only
hosts, and the seam a future compiled runtime would read/write.

```
.fadeno/runs/<id>/
  run.yaml       # metadata, validated by run.schema.json
  events.jsonl   # append-only lifecycle log, one JSON object per line
  artifacts/     # every durable step output (plans, patches, reports, …)
```

Three commands drive its lifecycle:

- **`new-run <playbook> "<task>"`** (`runNewRun`) creates the directory, writes
  `run.yaml` with a `$schema` modeline, seeds a `run_started` event, and makes
  `artifacts/`. Two deliberate details: the **run id uses local date/time** (so
  "today's run" sorts under today's date) while **`started_at` stays UTC ISO**;
  and `slugify()` cuts the task slug at a **word boundary** so ids never end
  mid-word.
- **`run <id> [--step|--status|--event|--artifact|--member|--field]`** (`runRun`)
  mutates `run.yaml` and appends to `events.jsonl`. It preserves the modeline,
  attributes events to the in-progress step (an explicit `--step` wins, else the
  run's `current_step`), attaches optional `--member` / `--field k=v` onto the
  event payload, and on a terminal status sets `ended_at` and clears
  `current_step`.
- **`gate <id> <condition> --artifact <path>`** (`runGate`) validates a named
  artifact against the condition's schema, evaluates it deterministically, logs a
  `gate_evaluated` event, and **exits 0/1**. v0 supports `no_blocking_issues` and
  `tests_pass`; `--report` remains a deprecated alias. This is the
  **advisory→enforced bridge**: the same check the runner applies can run in CI, a
  pre-commit hook, or a Claude Code `Stop` hook. See `enforcement.md`.

The runner skill *can* hand-edit these files, but the CLI keeps them schema-valid.

## The diagram renderer (`src/lib/diagram.ts`)

`renderDiagram(playbook, format)` is pure and deterministic — no 2-D edge routing,
so it stays correct for any playbook.

- **ASCII** — a top-to-bottom column of boxed **cards**, one per step. `▼` =
  sequential fall-through; `⋮` = the next card is reachable only via a labelled
  `▶` arrow (a gate branch, router route, loop exit, or explicit jump). Loop
  bodies are inlined into the loop's card rather than drawn as separate cards.
- **Mermaid** — a `flowchart TD` (renders on GitHub/docs); explicit edges solid +
  labelled, implicit fall-through dotted.

Verbose primitive `kind`s are abbreviated **for display only** via `KIND_LABEL`
(`actor_call` → `actor`, `evaluator` → `eval`, `human_gate` → `ask`, …). The
schema and vocabulary keep the full names. If you add a step kind, teach `detail()`
(its annotation), `edges()`/`branchLines()` (its out-edges), and `mermaidNode()`
(its node shape).

## Templates & the plugin

### `templates/` is the single source of truth

Everything `init` emits and everything the plugin bundles comes from `templates/`:

```
templates/
  common/                 # identical across targets
    fadeno/               # → .fadeno/ : vocabulary, playbooks, schemas, enforcement, runs/gitkeep
    skills/               # the two SKILL.md bodies + references (sigil-free)
    commands/             # /fadeno:* slash-command files (plugin)
    hooks/                # pre-commit, CI workflow, README (tier-2 scaffold)
  codex/                  # Codex adapter: AGENTS.md, codex-agents/*.toml, openai/*.yaml
  claude/                 # Claude adapter: CLAUDE.md, claude-agents/*.md, hooks/settings.example.json
```

`runInit` (`src/commands/init.ts`) composes these: always copy `common/fadeno` →
`.fadeno/`; unless `--data-only`, also install skills (shared body + per-target
dir/policy), subagents, and the bootstrap file; optionally the hooks scaffold
(`--with-hooks`); and on Claude, merge a `Bash(fadeno:*)` allow-rule into
git-ignored `.claude/settings.local.json` (plugins can't grant themselves Bash
permissions, so `init` is the seam for this).

Two non-obvious template rules:

- **Dotfiles ship un-dotted.** npm doesn't reliably publish dotfiles, so
  `runs/.gitkeep` is stored as `runs/gitkeep` and `copyTree` renames it on emit.
- **`emitBootstrap` is idempotent.** It wraps the Fadeno section in
  `<!-- fadeno:begin … -->` / `<!-- fadeno:end -->` markers: absent file → create;
  markers absent → append; markers present → skip (or replace under `--force`).

### The plugin is generated from the same templates

`fadeno plugin` (`runPlugin`) emits a Claude Code plugin from the **same**
`templates/common/skills` bodies (rewriting `name: fadeno-runner` →
`name: runner` for the short `fadeno:runner` namespace), plus the shared
`commands/`, the Claude `claude-agents/`, and a manifest. It carries **no per-repo
definitions** — plugin users seed those with `fadeno init --claude --data-only`
(the capability/definitions split).

`npm run build:plugin` runs `fadeno plugin ./plugin --force` **and**
`build-bin.mjs`. The resulting `plugin/` is **committed** (unlike `dist/`, which is
gitignored) so a git-URL install yields a working plugin with no build step.

### Keeping the plugin in sync (the no-drift guard)

Because `plugin/` is generated but committed, it can drift from `templates/`.
`test/plugin.test.ts` guards this — but **narrowly**: it asserts a freshly
generated `skills/builder/SKILL.md` equals the committed one, and that
`plugin/bin/fadeno` exists, is executable, starts with the node shebang, and is
pinned to CommonJS. It does **not** diff the whole tree or the bundled binary's
baked version. Practical rule: **after editing any template or bumping the
version, run `npm run build:plugin` and commit `plugin/`.** (Strengthening this
guard — a full-tree diff plus a bundled-version check — is a candidate
improvement.)

## Build & module system

The same `src/` is consumed two ways, which drives several otherwise-surprising
choices.

| | Dev / `dist/` build | Bundled plugin binary |
|---|---|---|
| Tool | `tsc` (`npm run build`) | `esbuild` (`scripts/build-bin.mjs`) |
| Module format | ESM | CJS (`format: 'cjs'`) |
| Output | `dist/` (gitignored) | `plugin/bin/fadeno` (committed) |
| Deps | resolved from `node_modules` | inlined (ajv, yaml bundled in) |
| Version | read from `package.json` | baked via `--define __FADENO_VERSION__` |
| Templates | sibling `../../templates` | copied to `plugin/bin/templates` |

Consequences you must respect:

- **Erasable TS only.** `tsc` uses `allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions`: source imports use `.ts` extensions and tsc
  rewrites them to `.js` on emit. This is what lets `node --test` run the `.ts`
  files directly (Node ≥ 22.6 type-stripping) with no test framework, while still
  producing clean ESM. It only works because the syntax is fully erasable
  (`erasableSyntaxOnly`).
- **Dual module-dir resolution.** `paths.ts` computes `moduleDir` from
  `__dirname` when present (the CJS bundle) and `import.meta.url` otherwise (ESM).
  `templatesDir()` probes binary-adjacent, then `../templates`, then
  `../../templates`. Don't reach for `import.meta` or `__dirname` unguarded.
- **`plugin/bin/package.json` pins `"type": "commonjs"`** so the extensionless
  bundle runs as CJS even though the repo root is `"type": "module"`.

## Toolchain gotchas

Footguns that cost time and aren't obvious from the final code:

- **TS 6 does not auto-include `@types/node`.** `tsconfig` sets `"types":
  ["node"]`; without it every `node:*` import and `console`/`process` fails.
- **Import Ajv as a named import:** `import { Ajv } from 'ajv'`. Under
  `module: nodenext` + `verbatimModuleSyntax` the default import types as the
  namespace and isn't constructable.
- **Playbook YAML must use block-style sequences** for `input`/`output`:
  `- ReviewReport[]`, never flow style `[ReviewReport[]]` — the `[]` in
  `ReviewReport[]` opens a nested flow sequence and breaks the parser. Anyone
  editing playbooks/schema examples hits this.
- **Templates are real files**, not strings in `src/`. `templatesDir()` resolves
  them relative to the module dir, which works in dev, `dist/`, and the bundle.

## Tests (`test/`)

- **Framework:** `node:test` + `node:assert/strict`. No test-framework dep.
- **Sandboxing:** `helpers.ts` exports `tempRepo(t)` (a throwaway dir auto-removed
  via `t.after()`), plus `exists` / `read`. Tests build a temp repo, call a
  `run*()` function, and assert on the returned data and the files on disk.
- **No CLI spawning.** Tests import and call `runInit` / `runValidate` / … directly
  with `cwd`/`repoRoot`/`now` injected — fast and hermetic.
- **Coverage** (~50 cases): `init` (both targets, hooks, force/idempotency),
  schema + reference + semantic validation, run-ledger lifecycle + gate, diagram
  rendering, and plugin generation + the no-drift/binary guards.

When you add behavior, add a test next to the matching command and follow the
`tempRepo` → `run*()` → assert pattern. Inject `now` for anything time-dependent.

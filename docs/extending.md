# Extending Fadeno

Recipes for common changes. Each lists the files to touch *together* — most
changes here are deliberately multi-file because the schema, validator, renderer,
runtime instructions, and docs all describe the same vocabulary and must agree.
Read [`architecture.md`](architecture.md) first for the patterns these assume.

After **any** change that touches `templates/`, run `npm run build:plugin` and
commit the regenerated `plugin/`. After any code change, `npm test`.

---

## Add a CLI command

Example: a hypothetical `fadeno list`.

1. **`src/commands/list.ts`** — export `runList(opts)` returning a plain result
   object; `throw` a typed error on failure; **no `console.*`**. Accept
   `cwd`/`repoRoot` (and `now` if time matters) for testability. Resolve the repo
   with `findRepoRoot()` from `lib/paths.ts`.
2. **`src/cli.ts`** — import `runList`; add any new flags to the `parseArgs`
   `options`; add a `case 'list':` that calls it and formats the result to stdout;
   set the exit code. Add a line to the `HELP` string and an example.
3. **`test/list.test.ts`** — `tempRepo(t)` → (init if needed) → `runList(...)` →
   assert on the return value and files. Follow the existing test shape.

Keep all printing in `cli.ts`; the command stays a pure function over the FS.

The low-friction commands follow the same rule: `setup`, `use`, `status`,
`doctor`, `vendor`, and `evidence promote` each return structured results and
keep rendering in `cli.ts`. User-level paths must accept injectable
`UserPathOptions`; project writes must use non-destructive `emitFile` or the
managed marker helpers. Add tests for no-init execution, malformed layer
errors, idempotency, and stale pins before adding convenience output.

Definition and executor changes use the effective layers rather than creating a
second resolver. Built-in files are immutable plugin assets; project files
shadow them by logical name, and user executor/loadout entries merge by key.

---

## Add a step kind (primitive)

The playbook vocabulary is defined in **five** places that must stay in lockstep.
To add a `kind` (or a field on one):

1. **`templates/common/fadeno/schemas/playbook.schema.json`** — add the value to
   the `kind` enum, any new property under `definitions/step/properties`, and a
   conditional `allOf` entry making the kind's required fields required.
2. **`src/lib/playbook-validate.ts`** — if the kind introduces a new
   step-reference field, add it to `SINGLE_REF_FIELDS` (or handle it like `body`/
   `routes`) in `referenceIntegrity`; if it references roles or
   produces/consumes artifacts, extend `semanticChecks`.
3. **`src/lib/diagram.ts`** — teach `detail()` what to annotate, `edges()` +
   `branchLines()` its out-edges, and `mermaidNode()` its node shape. Add a
   `KIND_LABEL` entry if the name is verbose.
4. **`templates/common/skills/fadeno-runner/references/runtime.md`** — document
   how the runner *executes* the primitive under "Executing each primitive."
5. **`templates/common/fadeno/vocabulary.md`** — add the term + the primitives
   list, keeping it short and orthogonal.

Then `npm run validate:self` (and add a starter or test that exercises it).

> **Note:** five primitives — `router`, `replicate`, `join`, `artifact_op`,
> `subworkflow` — are schema-valid and documented but **unused by any starter and
> have no executor demonstrated**. They're documented contracts, not proven
> behavior (see `docs/roadmap.md`). Wiring one up end-to-end (starter + runtime
> example + test) is a clean contribution.

---

## Add a gate condition

Gate conditions are the deterministic core — keep them computable from a
**structured artifact on disk**, never a model call.

1. **`src/commands/gate.ts`** — add a condition-registry entry with accepted
   logical artifact names, a schema kind, and a pure evaluator. `runGate` validates
   the concrete `--artifact` file before evaluating it, logs `gate_evaluated`, and
   returns enough detail for `cli.ts` to print a useful failure. Exit code follows
   `pass`.
2. **Artifact schema** — if the condition reads a *new* artifact shape (e.g. a
   fact-check report), add a schema under `templates/common/fadeno/schemas/`, wire
   it into `SCHEMA_FILE`/`SchemaKind` in `playbook-validate.ts` and the
   `--schema` choices in `cli.ts`, and teach `detectKind` to recognize it.
3. **`templates/common/skills/fadeno-runner/references/runtime.md`** — extend the
   "gate" bullet so the runner computes the same condition the CLI does.
4. **`templates/common/fadeno/enforcement.md`** — document the equivalent CLI
   invocation so the condition is usable as a real (tier-2) check.
5. **`test/run-gate.test.ts`** — cover pass and fail.

The invariant: the runner (now), a hook/CI (tier 2), and a future runtime must all
be able to evaluate the condition from the artifact **without re-asking a model**.

---

## Bind roles to executors (profiles + loadouts)

`fadeno drive` and `fadeno dispatch` resolve every actor through
`.fadeno/executors.yaml` (parsed by `src/lib/executors.ts`). Version 2 separates
model choice from delivery: **targets** are harness-neutral provider/model
profiles, **routes** say how each harness reaches a provider, and **loadouts**
map archetypes to targets:

```yaml
schema_version: 2
targets:
  opus-high: { provider: anthropic, model: opus, reasoning_effort: high }
  luna-high: { provider: openai, model: gpt-5.6-luna, reasoning_effort: high }

routes:
  codex:
    openai: { native: true, command: [codex, exec, --model, "{model}", "-"] }
    anthropic: { command: [claude, -p, --model, "{model}"] }
  claude:
    anthropic: { native: true, command: [claude, -p, --model, "{model}"] }
    openai: { command: [codex, exec, --model, "{model}", "-"] }

loadouts:
  anthropic-primary: { worker: opus-high, reviewer: opus-high }
  openai-primary:    { worker: luna-high, reviewer: opus-high }

default_loadout: anthropic-primary   # optional

bindings:                            # per-role pins; optional when loadouts exist
  opus_reviewer: opus-high           # deliberately-multi-model playbooks pin here
  "*": opus-high
```

A harness route normally keys by provider. A route keyed by the exact target
name takes precedence, allowing a special sandbox or read-only command policy
without making the loadout itself harness-specific.

Every loadout slot must name a declared target; loadout names and archetype
keys are bare lowercase identifiers (`[a-z][a-z0-9_-]*`); at least one of
`bindings` / `loadouts` must be non-empty. Playbook roles opt into loadout
routing with one advisory field — `archetype: worker` — validated for
identifier shape only, so the playbook stays harness- and provider-neutral.

**Resolution order** (per role, computed at dispatch time inside the CLI,
never cached anywhere else):

1. explicit `bindings[role]` pin;
2. the active loadout's slot for the role's declared `archetype`;
3. `bindings["*"]`;
4. otherwise a hard error naming the role, its archetype, and what to add.

The **active loadout** resolves `--loadout` flag → `FADENO_LOADOUT` env →
`.fadeno/local/loadout` → `default_loadout:` → none. Switch it per session:

```bash
fadeno loadout use openai-primary   # writes .fadeno/local/loadout (git-ignored)
fadeno loadout                      # active loadout, its source, its slot table
fadeno loadout list                 # every declared loadout (* marks active)
fadeno loadout clear                # remove the local pin
```

`.fadeno/local/` is per-machine session state — `init` gitignores it — which is
what makes a loadout switch session-scoped instead of a repo edit that dirties
git for a quota condition that expires tomorrow. The switch takes effect on the
next dispatch. Evidence: runs record a `resolution_snapshot` event in their
ledger; ad-hoc dispatches append one row each to `.fadeno/dispatches.jsonl`
(also gitignored by `init` — per-machine evidence like `.fadeno/local/`,
auditable locally, never committed). Each row's `resolution` field records how
the executor was chosen (`binding` | `loadout` | `fallback` | `executor-flag`).

Ad-hoc dispatch runs the same chain outside any playbook:
`fadeno dispatch --archetype worker` with the prompt on stdin or via
`--prompt-file <path>`. `--role <name>` additionally enables per-role binding
pins and evidence attribution (without it, step 1 above has nothing to match);
`--executor <name>` bypasses resolution entirely (debugging). Only `command`
adapters are directly invokable — resolving to a `host` executor is a clear
error telling you to bind a command executor or run via host dispatch.

### Cross-harness subagents (dispatch proxies and steering)

`init --claude` and the plugin install three **dispatch proxy agents** beside
the native role subagents: `dispatch-worker` / `dispatch-reviewer` /
`dispatch-judge` (source: `templates/claude/claude-agents/dispatch-*.md`).
Each is a Bash-only `model: haiku` agent that writes the received task prompt
verbatim to a file under `.fadeno/local/prompts/`, runs
`fadeno dispatch --archetype <a> --prompt-file <path>`, and relays the report
verbatim — so a Claude Code session can route worker/reviewer/judge-shaped
subtasks to whatever executor the active loadout binds, including a
non-Anthropic one. On a non-zero exit the proxy reports the failure plainly
and never attempts the task itself as a fallback.

`fadeno init --claude` installs a local `PreToolUse` hook by default; use
`--no-steering` to opt out. The hook calls the structured
`fadeno loadout resolve --archetype …` surface with the Claude harness identity
and rewrites command-delivered general-purpose/worker, reviewer, and judge
`Agent` calls to proxies. Native targets are rewritten to the matching Fadeno
role agent and requested model; the `current-host` default remains inert. It
preserves the rest of the Agent input and leaves Explore/Plan and unrelated
specialists native. Plugin users can combine the flag with `--data-only`; the
hook then targets the plugin-scoped `fadeno:dispatch-*` agents.

Codex has no equivalent spawn-rewrite hook, and project custom-agent model
configuration is session-static. `fadeno init --codex` installs honest broker
definitions named `worker`, `reviewer`, and `judge`; `fadeno setup --codex`
records the harness, and later `fadeno use <loadout>` automatically refreshes
the user-scoped agents when needed.
Use `fadeno steering apply <loadout> --codex --scope project` for a project
override. Each host slot becomes a native agent with that executor's model and
effort; each command slot becomes a cheap broker that delegates through
`fadeno dispatch`. Before each task the role resolves the active loadout: a
command executor switches immediately, a matching host executor runs natively,
and a different host executor uses `fallback_command` when declared. A fresh
session makes changed host definitions native; it is required only when the
selected host executor has no fallback. The Codex plugin
bundles the CLI and built-in definitions; it does not overwrite unrelated user
agents. Existing files remain protected unless `--force` is supplied.

What stays native: Explore/Plan-style read-only scouting — cheap, tightly
integrated with the harness's codebase tools, and not where quota pressure
lives. The arbitrage win is expensive worker turns.

> **Permission boundary:** the external executor a proxy dispatches runs
> *outside* the host harness's permission fences, under its own sandbox flags
> (e.g. `codex exec -s workspace-write`). Binding that executor in your
> loadout is the explicit opt-in; the `.fadeno/dispatches.jsonl` evidence row
> is the compensating audit trail.

---

## Change templates (skills, playbooks, schemas, agents, hooks)

`templates/` is the single source of truth. The catch is that `plugin/` is a
committed copy generated from it.

1. Edit under `templates/`. (Skill bodies live in
   `templates/common/skills/*/SKILL.md` and are **shared across targets** —
   keep them sigil-free.)
2. `npm run build:plugin` — regenerates `plugin/` (skills/commands/agents) and
   rebuilds the bundled `plugin/bin/fadeno`.
3. Commit the regenerated `plugin/`. `npm test` runs the no-drift guard; if it
   fails, you skipped step 2.

Never edit files under `plugin/` directly — they're build output.

---

## Add a starter playbook

1. **`templates/common/fadeno/playbooks/<name>.yaml`** — first line must be the
   modeline `# yaml-language-server: $schema=../schemas/playbook.schema.json`.
   Use **block-style** sequences for `input`/`output` (see the YAML gotcha in
   architecture.md). Prefer explicit roles, typed artifacts, bounded loops, and
   structured gates.
2. `npm run validate:self` (or validate a temp `init`) — must pass with no errors.
3. **`templates/common/skills/fadeno-builder/SKILL.md`** — if it's a canonical
   starter, mention it in the builder's "adapt a starter" list so the builder
   offers it.
4. `npm run build:plugin` + commit `plugin/`.

Starters ship to **all supported targets** (they're under `common/fadeno`) and
are available from the bundled plugin runtime. `init` / `init --data-only` and
`vendor` remain the explicit project-copy paths.

---

## Add a harness target

Adding a host (e.g. Cursor) is mostly **adapter work** — the skill *content* is a
cross-harness standard and is reused unchanged. Define the four adapter surfaces
alongside the current Codex, Claude Code, and Grok Build adapters:
install dir, bootstrap file + invocation sigil, invocation policy, and subagent
format.

1. **`templates/<target>/`** — the bootstrap file, subagent definitions in the
   host's format, and any invocation-policy file.
2. **`src/commands/init.ts`** — extend the per-target branches (skill dir,
   subagent copy, bootstrap name, any policy emit). Keep every write
   non-destructive via the `fsutil` helpers.
3. **`src/cli.ts`** — add the target to the `Target` type, the `SIGIL` map,
   `requireTarget`, the `parseArgs` options, and `HELP`.
4. **README** + the current adapter note/table in `docs/kickoff-memo.md` — document
   the new adapter row and distinguish native handles from namespaced plugin
   commands where applicable.
5. Tests in `test/init.test.ts` for the new tree, plus built-boundary assertions in
   `test/cli-integration.test.ts` and `test/plugin.test.ts` when bundled templates
   or CLI flags change.

If the host lacks native subagents, that's fine — the runner skill already
degrades to separate role-passes (and says so in the ledger).

---

## Release a version

1. Bump `version` in **`package.json`** (and add a `CHANGELOG.md` entry).
2. `npm run build:plugin` — this rebuilds `plugin/bin/fadeno` with the new version
   baked in (`--define`) and regenerates `plugin/.claude-plugin/plugin.json`.
3. `npm run build:plugin:codex` — the Codex plugin is generated by a separate
   script, and its manifest also carries the version; the no-drift test fails on
   a stale `plugin-codex/`.
4. Commit the regenerated `plugin/` **and** `plugin-codex/` along with the bump.
   The marketplace cache is **version-keyed**, so plugin users only pick up
   changes when the version changes — shipping template/skill edits to plugin
   users *requires* a bump.
5. `npm test` (includes the no-drift + binary guards).

The version is single-sourced from `package.json`: `packageVersion()` reads it in
the ESM build, and `build-bin.mjs` bakes it into the bundle as
`__FADENO_VERSION__`.

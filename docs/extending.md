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

1. **`src/commands/gate.ts`** — add the name to `SUPPORTED_CONDITIONS` and compute
   it inside `runGate` from the report file. Return enough detail for `cli.ts` to
   print a useful failure (like `blockingTitles`). Exit code follows `pass`.
2. **Artifact schema** — if the condition reads a *new* artifact shape (e.g. a
   fact-check report), add a schema under `templates/common/fadeno/schemas/`, wire
   it into `SCHEMA_FILE`/`SchemaKind` in `playbook-validate.ts` and the
   `--schema` choices in `cli.ts`, and teach `detectKind` to recognize it.
3. **`templates/common/skills/fadeno-runner/references/runtime.md`** — extend the
   "gate" bullet so the runner computes the same condition the CLI does.
4. **`templates/common/fadeno/enforcement.md`** — add the equivalent `jq`/CI
   one-liner so the condition is usable as a real (tier-2) check.
5. **`test/run-gate.test.ts`** — cover pass and fail.

The invariant: the runner (now), a hook/CI (tier 2), and a future runtime must all
be able to evaluate the condition from the artifact **without re-asking a model**.

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

Starters ship to **both** targets (they're under `common/fadeno`) and are seeded
by `init` / `init --data-only`. The plugin itself carries no playbooks.

---

## Add a harness target

Adding a host (e.g. Cursor) is mostly **adapter work** — the skill *content* is a
cross-harness standard and is reused unchanged. Define the four adapter surfaces:
install dir, bootstrap file + invocation sigil, invocation policy, and subagent
format.

1. **`templates/<target>/`** — the bootstrap file, subagent definitions in the
   host's format, and any invocation-policy file.
2. **`src/commands/init.ts`** — extend the per-target branches (skill dir,
   subagent copy, bootstrap name, any policy emit). Keep every write
   non-destructive via the `fsutil` helpers.
3. **`src/cli.ts`** — add the target to the `Target` type, the `SIGIL` map,
   `requireTarget`, the `parseArgs` options, and `HELP`.
4. **README** + the dual-target table in `docs/kickoff-memo.md` — document the new
   adapter row.
5. Tests in `test/init.test.ts` for the new tree.

If the host lacks native subagents, that's fine — the runner skill already
degrades to separate role-passes (and says so in the ledger).

---

## Release a version

1. Bump `version` in **`package.json`** (and add a `CHANGELOG.md` entry).
2. `npm run build:plugin` — this rebuilds `plugin/bin/fadeno` with the new version
   baked in (`--define`) and regenerates `plugin/.claude-plugin/plugin.json`.
3. Commit the regenerated `plugin/` along with the bump. The marketplace cache is
   **version-keyed**, so plugin users only pick up changes when the version
   changes — shipping template/skill edits to plugin users *requires* a bump.
4. `npm test` (includes the no-drift + binary guards).

The version is single-sourced from `package.json`: `packageVersion()` reads it in
the ESM build, and `build-bin.mjs` bakes it into the bundle as
`__FADENO_VERSION__`.

# Architecture

How the Fadeno codebase is built. For *what* it does, see
[`../README.md`](../README.md); for *why* each call was made, see
[`redesign/decisions.html`](redesign/decisions.html) and the specification it
produced, [`redesign/spec.html`](redesign/spec.html). For *how to make a
specific change*, see [`extending.md`](extending.md).

## The shape of the system

Fadeno is a CLI, a set of harness hooks that call it, and the templates both are
generated from. Nothing is long-running; every command is a function over the
filesystem and git.

```
  templates/  ── single source of truth ──────────┐
     │                                             │
     │  fadeno plugin + scripts/build-bin.mjs      │
     ▼                                             ▼
  plugin/ plugin-codex/ plugin-omp/   (committed, generated)
     hooks + agents + skills + bin/fadeno
                     │
                     │  a hook fires on a spawn
                     ▼
              fadeno dispatch-open  ──▶  .fadeno/dispatches.jsonl
                     │                   .fadeno/prompts/<id>.md
                     │                   .fadeno/local/worktrees/<name>/
                     ▼
        host lane: the hook rewrites the spawn
     command lane: the proxy runs `fadeno dispatch`
```

**The hooks write nothing.** They read an event, call the CLI, and apply what it
returns. Every decision and every byte on disk belongs to the CLI, so there is
one implementation of each rule rather than one per harness.

## The two lanes

A dispatch is delivered one of two ways, and the difference is one bit —
`hostCandidate`: can this session deliver the resolved model itself?

- **Host lane.** The spawn hook calls `dispatch-open`, which opens the dispatch
  and returns the contract-bearing prompt; the hook rewrites the pending Agent
  call in place (model, prompt, plus `additionalContext` telling the session what
  was opened). The subagent belongs to the harness; the stop hook records it
  stopping.
- **Command lane.** `dispatch-open` opens nothing. It stages the prompt under
  `.fadeno/local/relay/` and returns the `fadeno dispatch` argv that runs it.
  The hook retargets the spawn to the **dispatch proxy** — a minimal agent whose
  only tool is Bash and whose only job is to run that one command. `fadeno
  dispatch` then does the whole wrapper as a process: resolve, cut, run, record.

`laneOf` in `src/lib/spawn.ts` is the only place that bit is computed, and
`dial`, `status`, and the spawn wrapper all read it. That is deliberate: this
codebase's recurring bug is two consumers of one list disagreeing.

## Source map

| File | What lives here |
|------|-----------------|
| `src/cli.ts` | Entry point: `node:util.parseArgs`, command dispatch, and **all** stdout and exit codes. The view layer. |
| `src/commands/dial.ts` | Show, set, clear and resolve archetype bindings; the model probe. |
| `src/commands/dispatches.ts` | `dispatch`, `dispatch-open`, `dispatch-stop`, `dispatch-close`, `cancel`, `dispatches`, `worktrees`, `context`, `clean`. |
| `src/commands/models.ts`, `models-verify.ts` | The registry: list, add, remove, verify against a backend listing. |
| `src/commands/status.ts` | Effective routing, the CLI link, shadowing agent files, and what needs a person. |
| `src/commands/setup.ts` | Links the CLI onto PATH; sweeps state from the managed-runtime era. |
| `src/commands/plugin.ts` | Generates `plugin/`, `plugin-codex/`, `plugin-omp/` from `templates/`. |
| `src/commands/completion.ts` | Bash completion, and the per-command flag registry the CLI validates against. |
| `src/lib/executors.ts` | The catalog: parse, layer, resolve a dial to a delivery. The one resolver. |
| `src/lib/config-layers.ts` | builtin → user → project layering, with the tolerant user-layer reader. |
| `src/lib/spawn.ts` | The wrapper: resolve → prepare (worktree + contract) → run → record → cancel. |
| `src/lib/ledger.ts` | `.fadeno/dispatches.jsonl`: three row types, append-only, read tolerantly. |
| `src/lib/contracts.ts` | The worker contract injected into every prompt, and the host vocabulary. |
| `src/lib/worktree.ts` | Cut, list, report and remove Fadeno's git worktrees. |
| `src/lib/transcript.ts` | Read a harness transcript for the contract header, last message, and model. |
| `src/lib/user-paths.ts` | XDG-aware user config/state locations, user dials, the verification cache. |
| `src/lib/paths.ts`, `fsutil.ts`, `model-listing.ts`, `cli-help.ts` | Repo-root and version resolution, non-destructive emit, backend listing parsing, help pages. |
| `templates/hooks/` | The hook family, shared across harnesses: `hook-lib.mjs` plus the four hooks. |
| `templates/common/` | The catalog, the skills, the slash commands, the plugin launcher. |
| `templates/{claude,codex,omp}/` | Per-harness surfaces: generated role agents, the dispatch proxy, the omp extension. |
| `plugin*/` | Generated and committed. Never hand-edit; regenerate. |
| `test/` | `node:test`, 299 tests. `helpers.ts` and `hook-helpers.ts` carry the fixtures. |

## The catalog

`src/lib/executors.ts` parses one document and answers one question. Layering
(`config-layers.ts`) composes it:

```text
builtin catalog → user executors.yaml → project .fadeno/executors.yaml
```

Models, harnesses, dials, bindings and archetypes merge per key;
`unregistered_model_harness` and `unclosed_limit` take the highest declaring
layer. A **self-contained** project catalog — one declaring both `models:` and
`harnesses:` — suppresses the layers beneath it entirely.

The user layer is read **tolerantly** and every other layer **strictly**. A
personal alias nothing in the merged harness table can deliver is dropped with a
note; the same shape in a project catalog is a load error. The reason is that a
user file is machine state and a project file is committed policy, and a load
error in the former would break every command in every repo.

`CATALOG_TOP_LEVEL_KEYS` is checked twice: once per raw layer, while the file
that carries a typo is still identifiable, and once in the parser as a backstop.
A misspelled key that vanished silently in the merge was a real defect; the
per-layer check is what closed it.

### Resolution

`resolveDelivery(ref, profile, host)` is the only resolver:

```text
h       = ref.harness ?? entry.harness ?? homeHarnessOf(provider) ?? unregistered_model_harness
H       = harnesses[h]
modelId = entry.spellings[h] ?? entry.id, then effort_encoding
host lane iff h === host and H declares a `host:` that can carry this identity
```

A dial never names a lane. `hostCandidate` on the result is the lane bit;
`spec.adapter` is **not** — a host spec is also how a delivery with no argv at
all is represented (`host` in a bare shell), and conflating the two is
how a Codex host agent once got written for a model that harness could not
deliver.

`resolveRole` walks the cascade first — binding → session → repo → user → base —
then compiles. `roleResolutionEchoLabel` names each layer, once, for every
surface that prints one.

## The dispatch lifecycle

`src/lib/spawn.ts` is four steps and a stop:

1. **Resolve** — `resolveArchetype` against the live catalog and dials. Nothing
   is cached; changing a dial requires nothing.
2. **Prepare** — cut `.fadeno/local/worktrees/<name>` on branch `fadeno/<name>`
   from HEAD (or work in the live tree on `--shared`), compose the prompt as
   *caller's bytes + contract*, and write the prompt to `.fadeno/prompts/<id>.md`.
3. **Record** — append the `opened` row.
4. **Run** (command lane only) — spawn the argv in its own process group, prompt
   on stdin or at `{prompt_file}`, stdout and stderr to
   `.fadeno/local/outputs/<id>.*`. No timer: nothing is killed on a clock.

**Stop** is an outside observation. `dispatch-stop` takes the agent's transcript,
finds the dispatch by the contract header in its first user record, records the
last assistant turn when the harness passed no message, and records the model the
agent said it ran on. A transcript with no header is not a dispatch: exit 4,
nothing written.

**Close** is the host's decision, one verb, recorded and nothing else. Fadeno
performs no merge.

### The ledger

Append-only JSONL, three row types, read tolerantly by `readDispatches`:

- a line that is not JSON is **damage** and is reported as such;
- a JSON line that is not a row Fadeno knows is **another format** — an older
  Fadeno's, or a newer one's — and is skipped with a count.

The distinction matters because this repo's own ledger holds 461 rows from the
0.6 event log, and calling them damage sends a reader hunting for corruption
that is not there.

## The hooks

One family, shared by every harness, under `templates/hooks/`:

| Hook | Fires on | Does |
|------|----------|------|
| `spawn-claude.mjs` | `PreToolUse` on Agent | Host lane: rewrite the spawn (model, contract prompt, `additionalContext`). Command lane: retarget to the dispatch proxy with the staged command. |
| `spawn-codex.mjs` | `PreToolUse` on `spawn_agent` | Refuse-only: a Codex hook cannot rewrite a call, so an archetype spawn is denied **with** the exact command that runs it. |
| `agent-stop.mjs` | `SubagentStop` | Hand the transcript and last message to `dispatch-stop`. |
| `bash-guard.mjs` | `PreToolUse` on Bash | Hold the proxy to the relay grammar; refuse destructive git outside a dispatch's own worktree. |
| `host-mode.mjs` | `UserPromptSubmit`, `SessionStart`, `SessionEnd` | Session-scoped host mode: inject the policy and vocabulary, remind, clear. |

`hook-lib.mjs` holds everything they share: CLI resolution, the subprocess call
with its failure taxonomy, agent-type classification, and the refusal envelope.
Every refusal ends with the same sentence — *"Report this refusal to the user
instead of routing around it."* — because a hook that refuses silently teaches a
model to route around it.

Host mode is a marker file under the plugin data directory, keyed by a hash of
the session id. It exists so Fadeno states no opinion in a session that has not
asked for one.

## Build and module system

TypeScript, ESM, no build step in development — `node src/cli.ts` runs the
sources directly (Node ≥ 22.6 for native type-stripping; ≥ 20 to run `dist/`).

- `npm run build` → `tsc` into `dist/`, rewriting `.ts` imports to `.js`.
- `npm run build:plugin` → regenerate `plugin/` from `templates/`, then
  `scripts/build-bin.mjs` bundles `src/cli.ts` with esbuild into a standalone
  CJS `plugin/bin/fadeno` with `ajv` and `yaml` inlined, and copies `templates/`
  beside it.

The same source therefore runs as ESM and as bundled CJS. `src/lib/paths.ts`
carries the resolution that works under both; nothing else may assume one.

`erasableSyntaxOnly` is on: no `enum`, no parameter properties, no value
`namespace`. Strict mode plus `noUnusedLocals`/`noUnusedParameters` — dead code
fails the build, which is how a trim this size stays honest.

## Tests

`node --test` over `test/**/*.test.ts`; no test framework dependency.

- Command tests call `run*()` directly, because commands return data and throw.
- Hook tests (`test/hook-helpers.ts`) copy the real hook sources into a temp
  plugin, point them at a real CLI wrapper, and run them as subprocesses against
  a real git repo. They exercise the hooks as the harness does, not a mock.
- Drift tests regenerate `plugin*/` into a temp directory and compare against
  what is committed. Editing a template without rebuilding fails the suite.
- `test/cli-flag-scope.test.ts` is a tripwire: every flag `cli.ts` reads must be
  a flag the completion registry accepts, so a flag cannot be silently ignored.

`FADENO_SKIP_DRIFT=1 npm test` skips only the committed-vs-fresh comparisons,
loudly, for work in progress. Rebuild and run clean before integrating.

## Invariants

1. **Commands return data; `cli.ts` prints.** No `console.*` in `commands/` or
   `lib/`; throw typed errors instead. This is what makes the suite call `run*()`
   directly.
2. **`templates/` is the source of truth; `plugin*/` is generated.** Edit
   templates, rebuild all three plugins, commit the result.
3. **Hooks write nothing.** They read, call the CLI, and apply the answer. A
   hook that decides is a second implementation of a rule.
4. **One list, one consumer contract.** When two surfaces answer the same
   question, they call the same function. `laneOf`, `roleResolutionEchoLabel`,
   `runDialShow`, `resolveDelivery` all exist in one copy for this reason.
5. **No locks, no deadlines.** Nothing waits on a mutex and nothing is killed on
   a timer. Contention is answered by giving each dispatch its own worktree.
6. **Never a silent wrong answer.** A file this Fadeno cannot read is an error
   naming the file and the fix, never a fall-through to an empty value that
   looks healthy.

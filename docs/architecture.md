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
        host lane: the hook delivers the contract
     command lane: proxy or host runs `fadeno dispatch`
```

**The hooks write nothing.** They read an event, call the CLI, and apply what it
returns. Every decision and every byte on disk belongs to the CLI, so there is
one implementation of each rule rather than one per harness.

## The two lanes

A dispatch is delivered one of two ways, and the difference is one bit —
`hostCandidate`: can this session deliver the resolved model itself?

- **Host lane.** On Claude, `PreToolUse` calls `dispatch-open` and rewrites
  the pending spawn with its model and contract. On Codex, the host reads
  `fadeno dial <archetype> --json`, stages the exact task with the
  setup-resolved launcher and `prompt-stage --name <semantic-name>`, and passes
  the resolved model, effort, and returned schema-safe `task_name` on its
  `fadeno-<archetype>` spawn. `PreToolUse` reserves one same-session/
  same-archetype slot, validates routing, and consumes the one-use staged prompt
  when present. `SubagentStart` atomically claims the repository-bound handoff,
  then calls the CLI to open the dispatch, cut the worktree, bind the agent id,
  and deliver the contract to the subagent through `additionalContext`. A
  second uncorrelated start is refused before the agent exists; an impossible
  reordered or damaged event gets a sealed fallback. The stop hook records the
  subagent stopping.
- **Command lane.** `dispatch-open` stages the prompt under
  `.fadeno/local/relay/` and returns the `fadeno dispatch` argv without opening
  a dispatch. Claude retargets the spawn to a **dispatch proxy** that runs the
  command. Codex refuses the spawn with the command for the host to run in its
  own shell. `fadeno dispatch` does the wrapper as a process: resolve, cut,
  run, record. Codex's pre-spawn handoff is separate scratch under
  `.fadeno/local/staged-prompts/`; it is consumed once and never enters the
  ledger or prompt evidence until a dispatch actually opens.

For ordinary Codex delegation, start with the archetype spawn and the live
model and effort from `fadeno dial <archetype> --json`. The inability to rewrite
`PreToolUse` input does not make Codex command-only. Calling `fadeno dispatch`
directly explicitly selects the command lane; it is appropriate when that lane
is requested or the resolver sends the work there. `--shared` additionally
selects the current working tree, including uncommitted changes; it cannot be
combined with `--from`. An isolated worktree starts from HEAD unless `--from`
names a baseline. `--from` first resolves a dispatch name or id through the
repository ledger and requires that dispatch's recorded isolated branch to
remain reachable. It never substitutes the dispatch's recorded opening base,
and a shared-tree dispatch cannot supply a retained result. If the branch/result
is unavailable, commit the desired state and pass that Git ref or commit SHA
instead. Otherwise `--from` accepts a literal Git ref or commit SHA. A value
that matches both namespaces, or an exact dispatch name that is another
dispatch's id prefix, is refused; qualify a Git ref (such as
`refs/heads/main`) or use the dispatch's full UUID. An explicit baseline that
cannot be resolved is refused. If Git later cannot create the requested
isolated worktree, Fadeno refuses rather than abandoning the baseline in a
shared tree. The ordinary no-`--from` environmental fallback still proceeds in
the shared tree and says why. Choose that workspace deliberately when testing
uncommitted work.

Codex native subagent threads have a runtime concurrency limit; command-lane
processes do not consume native slots. Keep host-lane work interactive and use
the command lane for planned overflow or broad fan-out. If a correctly routed
Codex spawn fails before opening with `agent thread limit reached`, retry the
identical archetype, model, effort, prompt, and worktree policy via direct
`fadeno dispatch`, using a managed foreground shell. Never use `nohup` or invoke
an executor argv manually; if the shell yields, use `fadeno dispatch-wait`. A
capacity refusal creates no dispatch, so repository-level `fadeno feedback`
without `--dispatch` is the valid fallback when the attempted name cannot be
resolved.

`laneOf` in `src/lib/spawn.ts` is the only place that bit is computed, and
`dial`, `status`, and the spawn wrapper all read it. That is deliberate: this
codebase's recurring bug is two consumers of one list disagreeing.

## Direct model runs

`fadeno model run` (and `fadeno models run`) is a one-shot command harness
runner, not a shortened dispatch. It parses a registered alias reference,
loads the same layered catalog, and calls `resolveDelivery` for the compiled
model id, effort, and command argv. It uses the neutral standalone host so a
host-capable command harness is still invoked as a process; a host-only
delivery is refused.

The prompt is passed on stdin unless the compiled argv contains
`{prompt_file}`, in which case the exact prompt is written to a mode-0600 file
inside a fresh `mkdtemp` directory and the shared `substitutePromptFile`
function replaces the placeholder. The command's cwd is that directory, which
is removed in a `finally` block after success, failure, or launch refusal. No
ledger, worktree, branch, prompt evidence, or dispatch name is involved.

## Source map

| File | What lives here |
|------|-----------------|
| `src/cli.ts` | Entry point: `node:util.parseArgs`, command dispatch, shared stdin consumption, and **all** stdout and exit codes. The view layer. |
| `src/commands/dial.ts` | Show, set, clear and resolve archetype bindings; the model probe. |
| `src/commands/dispatches.ts` | `dispatch`, `dispatch-open`, `dispatch-stop`, `dispatch-close`, `cancel`, `dispatches`, `worktrees`, `context`, `clean` (including scratch cleanup). |
| `src/commands/logs.ts` | Resolves a dispatch and reads/follows its command-lane internal activity stream from the identity-derived stderr path. |
| `src/commands/prompt-stage.ts` | The Codex staged-prompt handshake: stage expiring plaintext and consume one task name. |
| `src/commands/models.ts`, `models-verify.ts` | The registry: list, add, remove, verify against a backend listing. |
| `src/commands/model-run.ts` | Resolves one registered model through `resolveDelivery`, runs its compiled command in temporary scratch, and records nothing. |
| `src/commands/status.ts` | Effective routing, the CLI link, shadowing agent files, and what needs a person. |
| `src/commands/setup.ts` | Links the CLI onto PATH; reconciles Codex's model-neutral agent vocabulary; sweeps state from the managed-runtime era. |
| `src/commands/plugin.ts` | Generates `plugin/`, `plugin-codex/`, `plugin-omp/` from `templates/`. |
| `src/commands/completion.ts` | Bash completion, and the per-command flag registry the CLI validates against. |
| `src/lib/executors.ts` | The catalog: parse, layer, resolve a dial to a delivery. The one resolver. |
| `src/lib/config-layers.ts` | builtin → user → project layering, with the tolerant user-layer reader. |
| `src/lib/spawn.ts` | The wrapper: resolve → prepare (worktree + contract) → run → record → cancel. |
| `src/lib/ledger.ts` | `.fadeno/dispatches.jsonl`: three row types, append-only, read tolerantly. |
| `src/lib/contracts.ts` | The worker contract injected into every prompt, and the host vocabulary. |
| `src/lib/worktree.ts` | Cut, list, report and remove Fadeno's git worktrees. |
| `src/lib/transcript.ts` | Read a harness transcript for the contract header, last message, and model. |
| `src/lib/staged-prompts.ts` | Repository-bound, expiring, atomically consumed Codex prompt scratch. |
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
`unregistered_model_harness` and the legacy `unclosed_limit` key take the
highest declaring layer. The latter is read for compatibility, reported as
retired, and ignored. A **self-contained** project catalog — one declaring both `models:` and
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
2. **Prepare** — reject the incompatible `--shared --from` combination, then
   resolve an explicit `--from` as a retained dispatch branch or a literal Git
   ref/commit. A dispatch's opening base is never a result fallback, and a
   shared dispatch cannot be inherited. Cut
   `.fadeno/local/worktrees/<name>` on branch `fadeno/<name>` from that baseline
   (or HEAD when omitted). A requested baseline is never converted to a shared
   tree after a cut failure; only the ordinary no-`--from` environmental failure
   uses the shared-tree fallback. With `--shared`, work in the live tree.
   Compose the prompt as *caller's bytes + contract*, and write the prompt to
   `.fadeno/prompts/<id>.md`.
3. **Record** — append the `opened` row.
4. **Run** (command lane only) — spawn the argv in its own process group, prompt
   on stdin or at `{prompt_file}`, stdout and stderr to
   `.fadeno/local/outputs/<id>.*`. The launcher polls its own
   `.fadeno/local/cancel-requests/<id>.request.json` scratch file while the
   executor is alive. `cancel` signals directly first; on `EPERM` it writes
   that request and waits for the launcher acknowledgement and group exit.
   No timer: nothing is killed on a clock.

`fadeno logs <name|id>` reads the command-lane stderr stream at the
identity-derived `.fadeno/local/outputs/<id>.err` path and writes its bytes
unchanged. `--tail <lines>` selects a positive number of final lines; `--follow`
waits on filesystem activity and ledger changes, then ends only after a stopped
row has arrived and the file is drained. Host-lane dispatches have no Fadeno
activity file because their harness owns that transcript. `clean --force` may
remove the output directory, so stopped and closed logs remain readable only
until scratch is cleaned.

**Stop** is an outside observation. `dispatch-stop` takes the agent's transcript,
finds the dispatch by the contract header in its first user record, and first
flushes a cheap durable receipt containing the final message, working directory,
and observed model. It then optionally inspects Git and appends a second
`stopped` row with dirty paths, ignored paths, and branch measurement. The
reader merges that enrichment into the durable receipt; an older reader still
sees the first compatible stopped row. `--durable` ends after the first receipt,
which is the path used by the harness stop hook. A transcript with no header is
not a dispatch: exit 4, nothing written. Stop-hook failures are surfaced as an
actionable system message; they are not swallowed.

Every CLI command that consumes stdin uses `src/lib/stdin.ts`. It accumulates
bytes with `fs.readSync`, retries only transient `EAGAIN`/`EINTR` (and the
platform spelling `EWOULDBLOCK`) with a short sleep, and has no arbitrary retry
deadline. The complete byte sequence is decoded only after EOF, so a retry or a
chunk boundary cannot duplicate or corrupt a multibyte character. Permanent
read failures name stdin and remain errors.

**Close** is the host's decision, one verb, recorded and nothing else. Fadeno
performs no merge. The process running a dispatch cannot close that same
dispatch: it must return its report and its caller/host closes it; a parent may
close only a child it opened.

`dispatch-wait` treats only a `stopped` row as report-ready. A `closed` row can
legally precede `stopped` in the append-only ledger: while the command-lane
process group is alive, wait continues to observe it; once the group is dead,
wait gives the launcher its settle window and reconstructs the stop from
stdout, stderr and the worktree if no stop row arrives. The direct
`dispatch` launcher still returns the executor's stdout in this ordering.

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
| `spawn-codex.mjs` | `PreToolUse` on the spawn tool; `SubagentStart` | Pre-tool: validate live routing, atomically reserve one repository-bound handoff slot, recover a staged plaintext by `task_name`, pass correctly routed host spawns, or refuse command-lane spawns with the resolved relay command. Start: atomically claim the handoff before reading plaintext, open the host dispatch, bind the agent id, and deliver the contract. |
| `agent-stop.mjs` | `SubagentStop` | Hand the transcript and last message to `dispatch-stop`. |
| `bash-guard.mjs` | `PreToolUse` on Bash | Hold the proxy to the relay grammar; refuse destructive git outside a dispatch's own worktree. |
| `host-mode.mjs` | `UserPromptSubmit`, `SessionStart`, `SessionEnd` | Session-scoped host mode: inject the policy and vocabulary, derive a ledger reminder on each host turn, clear. |

`hook-lib.mjs` holds everything they share: CLI resolution, the subprocess call
with its failure taxonomy, agent-type classification, and the refusal envelope.
Every refusal ends with the same sentence — *"Report this refusal to the user
instead of routing around it."* — because a hook that refuses silently teaches a
model to route around it.

Host mode is a marker file under the plugin data directory, keyed by a hash of
the session id. It exists so Fadeno states no opinion in a session that has not
asked for one.

Codex prompt handoffs are CLI-owned scratch under
`.fadeno/local/staged-prompts/`. `prompt-stage` binds each record to the
canonical repository, gives it a ten-minute expiry, and consumes it by atomic
claim. The plugin hook's separate pending slot is only the mechanical bridge
between Codex's two uncorrelated events: its reservation is exclusive, its
payload is mode `0600`, and SessionEnd/lazy expiry remove abandoned files. A
token failure is therefore a refusal rather than a fallback to a ciphertext or
another task; `clean --force` removes remaining repository handoffs.

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

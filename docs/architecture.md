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
  `templates/{codex,claude,grok}/*-agents`, and `src/`.
- **Definitions** — the `.fadeno/` tree. Source under `templates/common/fadeno`.
- **Traces** — `.fadeno/runs/<id>/`. Created lazily by the CLI; no template or
  committed `.gitkeep` is required.

The bundled definition resolver (`src/lib/definitions.ts`) applies project
shadowing over immutable plugin-adjacent definitions. `SchemaSet` accepts a
project directory plus a bundled fallback, so validation, prompting, driving,
diagrams, and verification all use the same logical catalog.

Executor configuration is layered by `src/lib/config-layers.ts`:

```text
bundled catalog → user executors.yaml → project .fadeno/executors.yaml
```

Registry models, harness routes, legacy executors, dials (`dials:`), and
bindings merge by key; `unregistered_model_driver` uses the highest declaring
layer. Pre-dials catalogs with legacy keys (`loadouts`/`targets`) are rejected at parse time. A malformed
present layer is an error. User paths are resolved by `src/lib/user-paths.ts`
with injectable XDG/Windows overrides, including `$FADENO_STATE_HOME/dials.json`
(session dials) and `$FADENO_STATE_HOME/model-verifications.json` (dial-time
verification cache). Setup does not synthesize a catalog from installed CLI
probes: the bundled v3 model registry and routes are working defaults, and the
user file is an optional override.

## Glossary: harnesses, hosts, and drivers

Fadeno relates to an agentic coding environment in exactly two ways, and the
codebase names one of them much better than the other. This section fixes the
vocabulary so the two can be said apart.

**Harness** — an agentic coding environment: Codex, Claude Code, Grok Build,
OpenCode. A harness is not a role; it takes one of the two roles below, and the
same harness can take both.

**Host** — the harness Fadeno is *running inside*. This is a typed axis:
`HarnessId = 'codex' | 'claude' | 'grok' | 'opencode' | 'standalone'`
(`src/lib/executors.ts`), resolved by `activeHarness()` as `FADENO_HARNESS` →
the harness recorded by `fadeno setup` → `standalone`. A host needs an
**adapter** — a `templates/<host>/` tree emitted by `fadeno init --<host>` —
because Fadeno has to install skills, subagents, bootstrap files, and hooks
into it. The active host also selects which `routes:` sub-table compiles; a v2
catalog with no `routes.<active host>` mapping is a hard error, not a
silent no-op. `standalone` is the *no host* value: Fadeno invoked from a plain
shell, with no adapter tree. OpenCode is the one harness that is both a first-
class host and a driver: its binary plays both roles (see kickoff-memo →
*Post-v0 OpenCode adapter note*).

**Driver** — a harness Fadeno *invokes as a subprocess* to do work. A driver
needs nothing from Fadeno but argv: no `HarnessId`, no `templates/` tree, no
plugin, no init step. It appears only as the `command:` of a route entry, so
the schema never interprets it as a harness at all:

```yaml
routes:
  claude:                                    # the HOST is Claude Code
    xai:
      command: [grok, --prompt-file, /dev/stdin, --model, "{model}"]
```

Grok is the driver there and Claude Code is the host. There is no Grok plugin
in that session and none is needed. The reverse pairing is equally valid, and a
harness can be both at once: on a `host: true` route the `command:` is the
*fallback* delivery, so a Claude-hosted session can also drive `claude -p`
out of process.

The reliable test for which role you mean: **does it need a
`templates/<x>/` tree?** Host yes, driver no.

### The delivery axis (how a slot is filled)

- **Host delivery** — `host: true` on a route (pre-0.6 alias `native: true`),
  compiling to `adapter: 'host'`: an in-session subagent of the host, bound to
  the requesting archetype at resolution time.
- **Command delivery** — `adapter: 'command'`: argv with the prompt on stdin,
  out of process. This is the only way a driver is ever reached.

### The identity axis (who does the work)

- **Model** — a harness-neutral registry entry (`provider` + `id` + standard
  `effort`, optional `spellings:` per driver). Carries identity only: never
  argv, never permission flags. `current-host` is the built-in model for
  host-native base delivery.
- **Displayed harness** — the model's stable home driver (`luna → codex`),
  shown identically from every caller reference frame. The active route's
  `host | command` adapter remains separate structured resolution data.
- **Route** — how the *host* reaches a provider. Keyed by harness id, then by
  provider, with `driver:` as the `--via` alias and `models_command:` /
  `effort_encoding:` for dial-time behavior.
- **Dial** — an archetype → model ref (`model[@effort] [--via <driver>]`);
  **archetype** — a `worker`/`reviewer`/`judge`-shaped slot. Dials are layered
  (`session` via `.fadeno/local/dials`, `repo` via `dials:` in the project
  catalog, `user` via `$FADENO_STATE_HOME/dials.json`, `base` = `current-host`).

### Three name collisions to watch for

These predate the host/driver split and are load-bearing in existing code, so
they are documented rather than renamed:

1. **`grok` names two things.** A `HarnessId` (host axis) and a binary inside a
   command route (driver axis). Same token, opposite roles.
2. **`adapter` names two things.** A host-side surface (`templates/grok/` is
   "the Grok Build adapter") and a delivery mechanism
   (`adapter: 'command' | 'host'`).
3. **`Target` names two things.** `type Target = 'codex' | 'claude' | 'grok'`
   in `src/commands/init.ts` is a *host*, while the legacy `targets:` key in
   `executors.yaml` was a provider/model profile (now `models:`). `extending.md`
   → *Add a harness target* collides both within one section — `harness`
   is the live term; `target` survives only in that section title and in
   legacy catalog lore.

Nothing in the schema branches on host-versus-driver today — a driver is
indistinguishable from a raw model endpoint, because both are just argv. That
is not an oversight: the driven side genuinely requires nothing from Fadeno,
so it has never needed a schema slot.

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
| `runDialShow` / `…Set` / `…Clear` / `…Shadow` | effective dial table + layered dial state | `set`/`clear` pin `.fadeno/local/dials` (session) or `$FADENO_STATE_HOME/dials.json` (user) or `dials:` (repo); `--force` persists a warned, direct-archetype-only write-posture override; shadows are session-pinned. Resolution via `resolveDialCascade` + `compileDialRef` in `lib/executors.ts`. |
| `runDispatch` | executor report + evidence row | Ad-hoc archetype→executor dispatch; appends a correlated `dispatch_requested`/`dispatch_completed` row pair to `.fadeno/dispatches.jsonl`. Refuses before spawning when the resolved command route declares `write_access: false` and the archetype declares `requires_write: true`. Echo goes to stderr so stdout stays the executor's pure report. |
| `runDispatches` | correlated dispatch rows | Read-only projection of `.fadeno/dispatches.jsonl`: pairs `dispatch_requested`/`dispatch_completed` by `dispatch_id`, keeps `host_delivery` rows inline, and marks a request with no completion as killed-or-in-flight rather than dropping it. Pre-format legacy rows render as `[legacy]`; newer-format rows get a separate count. `--tail <N>` (default 10) / `--json`. |
| `runSteeringResolve` / `runSteeringApply` | hybrid mode / emitted Codex agents | Resolves host vs command vs restart-required vs write-conflict per invocation; materializes per-slot host agents or cheap command brokers, declining brokers for write-conflicted slots. |
| `runToolRun` | `ToolRunResult` + `artifact` | Executes a registered `tool_call` (`test-result` only) deterministically: strict registry, supervisor/process-group, writer lease, bounded TestResult synthesis, exclusive placement, and `tool_dispatched`/`tool_completed`/`tool_failed` lifecycle. Thin adapter over `lib/tool-exec.ts`. |
| `runToolComplete` | run update + artifact manifest + `tool_recorded` receipt | Validates a typed tool result before atomically starting the exact next `tool_call` and recording its result. Shares claim/lease/concurrency discipline with `tool-run` (generation-scoped, one attempt wins). Writes the manifest, then a `tool_recorded` receipt (`recorded_by: host`) — never `tool_completed`, which means the kernel ran it. |
| `runCancel` | `CancelResult` | SIGTERM to the live supervisor/process-group for `engine-*` or `tool-*` claims (run-scoped, `ESRCH`-checked before retry). |
| `runPlugin` | `EmitResult[]` + `outDir` | Generates `plugin/` from templates. |
| `runSetup` | user paths, probes, dial state, restart notices | Safe host-default setup and dial-backed steering; no longer seeds a user dial pin. |
| `runStatus` / `runDoctor` | effective routing / findings | Read-only diagnostics (dial layers + per-role resolved rows). |
| `runVendor` / `runEvidencePromote` | lock / promoted receipt | Explicit committed project capability and evidence. |
| `runUninstall` / `runClean` / `runUnvendor` | removed + preserved paths | Ownership-aware user removal, repo runtime cleanup, and digest-backed vendored removal. |
| `runCompletion` / `runCompletionCandidates` | Bash source + candidate strings | Emits the `fadeno completion bash` script and serves its read-only candidate protocol. |

All commands accept injectable `cwd` / `repoRoot` (and `now` where time matters)
so tests stay hermetic and deterministic.

### Bash completion protocol

`fadeno completion bash` prints a dependency-free Bash function and registers
it for the `fadeno` executable. On each Tab press the function calls
`fadeno completion candidates <COMP_CWORD> -- <COMP_WORDS...>`; the `--`
boundary keeps partially typed Fadeno flags in the word vector out of the
outer argument parser. Candidate calculation stays in `commands/completion.ts`
as plain data, while `cli.ts` owns printing and exit status. It reads only
repo-local playbooks, ledgers, and executor profiles, sorts and de-duplicates
results, and suppresses errors for malformed or incomplete repositories. The
script uses Bash built-ins (`complete`, arrays, `mapfile`, `compgen`) and falls
back to ordinary file completion when no specialized candidates apply.

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
- **`run-ledger.ts`** — list/resolve runs, parse events, list artifacts, and
  gate format-0.3 readers behind explicit 0.2 compatibility mode.
- **`host-dispatch.ts`** — durable host request/start/terminal receipt
  protocol with immutable output placement and attempt evidence. Write-capable
  host work holds a PID-less, full-identity workspace lease until its terminal
  receipt; completion accepts either a file or binary stdin and places output
  with a same-directory atomic rename. Opt-in isolated host delivery uses `fadeno dispatch-prepare <run> <dispatch-id> --isolate` to create a detached worktree at `.fadeno/local/host-worktrees/<run>/<dispatch-id>` (workspace_mode: isolated, state at `.fadeno/local/host-workspaces/<run>/<dispatch-id>.json`), guarded against traversal/symlink escape and serialized by `.fadeno/local/.host-workspace.lock`; `dispatch-prompt` then includes `workspace_mode: isolated` and the absolute workspace path, and `dispatch-start` stamps `workspace_mode: isolated`/`workspace`/`base_commit` on `actor_dispatched`. `dispatch-complete`/`dispatch-fail` collect a binary staged diff at `.fadeno/local/outputs/host-isolated-<run>-<dispatch-id>.diff` without auto-merge, stamping `workspace_mode: isolated` plus `workspace`/`base_commit` and `diff_snapshot`/`diff_bytes` only when a diff was actually collected from the proven registered worktree; `dispatch-fail` degrades to a terminal receipt without diff keys whenever evidence is absent, unverifiable, or unrecoverable (including a missing or malformed machine-local state file) while a collection failure with the state present still refuses, preserving the worktree for retry; `dispatch-complete` may recover and collect from a verified ledger-named worktree when the state vanished but still refuses success when evidence cannot be collected. Neither command stages or removes a directory it has not proven to be this dispatch's registered worktree, and nothing is ever auto-merged. `fadeno show` surfaces workspace_mode as non-gating observability; `verify` never requires machine-local state.
- **`host-workspace.ts`** — idempotent detached-worktree primitive for opt-in isolated host delivery: `HOST_WORKTREES_DIR` is `.fadeno/local/host-worktrees`, `HOST_WORKSPACES_DIR` is `.fadeno/local/host-workspaces`, `HOST_ISOLATED_DIFF_DIR` is `.fadeno/local/outputs`, lock `.fadeno/local/.host-workspace.lock`, state schema `1.0` with `workspace_mode: isolated`, traversal/symlink-safe paths, atomic tmp+rename writes, and delegation to `workspace-lease` for binary diff collection.
- **`workspace-lease.ts`** — the machine-local, repo-wide single-writer lease
  plus detached-worktree isolation for `dispatch --isolate`. Command supervisors release a full-holder
  lease only after the executor process group closes; host leases remain
  conservative until complete/fail. Isolated host delivery via `fadeno dispatch-prepare --isolate` also returns a binary diff
  and never merges automatically. A shared writer blocks with
  ```
  shared workspace is already held by <kind> "<id>" (supervisor_pid <pid>, started <iso>); holder "<requester>" must wait or retry. Inspect it with `fadeno show <run>`; recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, remove .fadeno/local/workspace-lease.json as a last resort.
  ``` Multi-holder fan-out enumerates `holders: "<id1>", "<id2>"`. Doctor reports the same state as a `workspace-lease` finding (stale vs live, lock staleness at 120s) and never acquires or deletes. `--isolate` bypasses the lease; `--diagnostics` (or `FADENO_DIAGNOSTICS=1`) is opt-in only, bounded to 32 KiB / 500 lines per stream with head+tail sampling and a single truncation marker `…[fadeno diagnostics truncated: <stdout|stderr> exceeded 32 KiB / 500 lines]…`, stored machine-local under `.fadeno/local/outputs/diagnostics/` as `dispatch-<id>.log` (ad-hoc) or `<run>-<actorCallId>-a<attempt>.log` (engine), never ledger-committed, never gating.
- **Command dispatch supervision and recovery** — both ad-hoc dispatches and
  engine command attempts run below a supervisor that owns the executor's
  process group. The supervisor forwards exact output bytes while publishing
  independent heartbeat, output activity, PID/process-group, and terminal
  status facts (`supervisor_pid`, `executor_pid`, `process_group_id`,
  `started_at`, `heartbeat_at`, `last_output_at`, `stdout_bytes`,
  `stderr_bytes`, plus `timed_out`/`timeout_ms`/`deadline_at` when a deadline
  is in force). Before supervisor startup, the engine atomically publishes an
  exclusive correlated claim; a machine-local in-flight claim then lets another
  `fadeno drive` distinguish any still-running attempt from a dead engine,
  independent of write posture. Recovery refuses to
  record `engine_interrupted` or retry while the supervisor is alive, then
  closes the dangling start only after no live claim remains. A supervisor-owned
  hard deadline sends SIGTERM to the executor group at `deadline_at` and
  escalates to SIGKILL after 5s; lease and claim release still waits for
  `close`, so cancellation and timeout are similarly proven only after the
  group is gone. Idle output is never a termination signal — `show`
  surfaces `WARNING: no output observed for <duration> (non-gating)` after
  five minutes via `OUTPUT_IDLE_WARNING_MS` and `HarnessObservedProcessView.outputIdleWarning`.
- **`collective.ts`** — `reduceCollective`, the one reduction of a map's member
  parts into its collective. `drive` writes a collective through it and
  receipts the reduction (`collective_assembled`: parts in order, digest,
  `assembled_by: engine`); `verify` (`collective-provenance`) reduces the
  receipted parts again and refuses a collective that does not come out
  identical.
- **`tool-exec.ts`** — deterministic `tool_call` execution core: strict `tools:` registry parsing (static argv, timeout), `tool_dispatched` → supervisor spawn (shared writer lease, `readdirSync` live-claim scan with `ESRCH` group reclaim) → bounded `TestResult` synthesis → exclusive `linkSync` placement (never clobbering) → `artifact_created` + `tool_completed`/`tool_failed` lifecycle (one attempt wins, `tool-generation` scoped, crash-safe attribution preserving already-attributed bytes). Used by both `fadeno tool-run` and `fadeno drive`; recovery via shared `recoverInterruptedToolDispatchesShared`.
- **`executors.ts`** — the executor profile (`.fadeno/executors.yaml`): v3 registry
  `models:` plus per-harness `routes:` (with `driver:`, `models_command:`,
  `effort_encoding:`), layered **dials** (`session` → `repo` → `user` → `base`),
  per-role `bindings`, and **`tools:`** (`tool` → `{command: string[], timeout?, timeout_ms?}` static argv, no shell/interpolation, positive timeout; layered like other catalog keys; snapshotted into `profile.yaml`); plus a `unregistered_model_driver` fall-through.
  v1 executor profiles remain supported for ledger replay via
  `resolveRoleLegacy`. Core helpers: `parseDialRef`/`formatDialRef`,
  `compileDialRef` (registry → delivery), `resolveDialCascade` (pure cascade,
  no registry touch, so verify replays from snapshot), `resolveRole` (cascade +
  compile), `deliveryIsHost`, plus pin files (`LocalDialState`,
  `readLocalDialState`/`writeLocalDialState`) and user dials +
  `model-verifications.json` cache (`readUserDials`, `readVerifiedModels`,
  etc.). Resolution is computed at dispatch time, inside the CLI, and never
  cached in config emitted elsewhere — integrations (plugin agents, hooks) stay
  dumb and call `fadeno`, so a dial switch takes effect on the next dispatch
  with no config churn.

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
   `on_success`, `on_exhausted`, `default`), a container `body`, or a `routes` map must
   resolve to a defined step; duplicate ids are flagged.
3. **Normalized control flow and definite artifacts** *(playbook only)* — physical
   fallthrough is added only for steps without explicit outgoing control flow;
   container-body definitions are reachable only through their lexical owner.
   The validator reports unreachable steps, container recursion/multiple ownership,
   invalid terminal declarations, unsupported condition bindings, and inputs that
   are absent from the intersection of incoming artifact paths. Container body
   outputs are available to their parent scope.
4. **Role semantics** *(playbook only)* — every `actor`/`actors` entry must be a
   declared role *(error)*; declared-but-unused roles are *warnings*. `over`
   items count as roles only for the legacy leaf-map form; compositional map
   members are data identities. A role may declare an advisory `archetype:` —
   its identity for the dispatch kernel's dial routing, never routing config
   in the playbook — and only its bare-lowercase-identifier shape is checked
   *(error)*; absence is fine.

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

Three commands drive its original lifecycle, and host work adds three
receipt commands:

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
  `gate_evaluated` event, and **exits 0/1**. v0 supports `all_reviews_approved`, `no_blocking_issues`, and
  `tests_pass`; `--report` remains a deprecated alias. This is the
  **advisory→enforced bridge**: the same check the runner applies can run in CI, a
  pre-commit hook, or a Claude Code `Stop` hook. See `enforcement.md`.
- **`dispatch-prompt|dispatch-start|dispatch-progress|dispatch-complete|dispatch-fail`** are
  host receipts. A
  host executor request is durable before host work begins; receipts record
  the requested model/effort/type, host agent id, provenance-labelled
  non-gating progress, and terminal output/failure. Requested identity is
  internally checked but stays visibly unverified unless a future host supplies
  authoritative runtime metadata. `dispatch-prompt` emits the immutable engine
  assignment envelope and recorded prompt bytes without host-side
  reconstruction. `show` reloads the run's playbook so the projection
  retains graph order and pending actors, then overlays lifecycle/progress
  events and derives actor/step/total runtime. It labels semantic progress as
  agent/harness/director-attested and presents machine-local process facts in a
  distinct harness-observed, non-gating section. The director is the only
  ledger writer during this MVP.

  `steering resolve --run <run> --dispatch-id <id>` is the engine-delivery
  branch: it reads the unique immutable host request and run profile snapshot,
  ignoring ambient dial state. Host executor mismatch is a deterministic
  restart requirement. Whole-trace verification accepts a historical failed
  host attempt only when the same actor call has a later higher-ordinal valid
  success; the final attempt must still succeed.

Compositional playbooks use `lib/composite-flow.ts` instead of the legacy
single cursor. It computes a pure runnable frontier from events. Canonical paths
from `lib/node-instance.ts` distinguish map members and loop generations; drive
batches every ready host leaf, scopes its prompt/output, and recomputes
the frontier after receipts. Literal maps and linear bodies are the deliberate
first boundary. `show` groups observed paths back under their declared graph,
while `verify` recomputes path, parent, member, generation, and dispatch ids. For deterministic `tool_call` steps, `verify` also recomputes `tool-result-coherence`, `tool-command-digest`, and `tool-lifecycle` (one terminal per `tool_dispatched`, digest vs snapshotted `tools:` binding).

Two evidence surfaces sit beside the step lifecycle:

- **`resolution_snapshot`** — appended by `drive` at first engine contact
  (right after the repo profile is snapshotted into the run dir as
  `profile.yaml`), recording the effective dial table and, per
  declared role, its `(archetype, executor, model, resolution source, dial_source)`. Later
  invocations re-append it **only when the resolution in force changed** (a
  dial switch, a `--bind` override); the echo prints on every invocation
  regardless, so the ledger stays quiet while the user still sees which
  provider the run is spending. `new-run` prints a best-effort preview of the
  same table but writes no ledger event — resolution is computed at dispatch
  time and the engine owns the durable record. `verify`'s executor-bindings
  check replays these events (plus `executor_override`s, in order) to recompute
  every dispatch's resolution from ledger contents alone.
- **`.fadeno/dispatches.jsonl`** — the append-only evidence log for ad-hoc
  `fadeno dispatch`, which has no run dir: one JSON row per dispatch with
  timestamp, archetype, role, resolution path (`resolution`: `binding` |
  `session` | `repo` | `user` | `base` | `fallback` | `executor-flag` — how the executor was chosen; `dial_source` records which dial layer won), executor, model, exit code,
  duration, and prompt/output sha256 digests. The row is written even when the
  spawn itself fails — a failed dispatch is still a dispatch that happened.
  Declared `write_access` joins that identity, so a read-only delivery is
  legible in the row rather than only in an empty-handed report. The Claude
  steering hook appends `host_delivery` rows to the same file when it steers
  a spawn to a host role agent (archetype, agent_type, dial, executor,
  model, model_override, `reasoning_effort: "inherited"`,
  `transport: "host"`, prompt_sha256, prompt_snapshot,
  `hook_version`) — the kernel never runs on the host path,
  so the hook is the only writer that can witness it, and one file audits both
  delivery routes. Like `.fadeno/local/dials`, it is per-machine evidence —
  auditable locally, never committed. `hook_version` exists because hooks load
  at session start and therefore lag one session behind an edit (`dev` in the
  committed template, the package version in emitted copies), so a row's
  writing generation is identifiable after the fact. `fadeno dispatches` is the
  read-side projection of this file.

`.fadeno/local/` is per-machine session state (sticky dials at `.fadeno/local/dials`, proxy
prompt relays) and is never committed — `init` appends `.fadeno/local/` (along
with `.fadeno/progress/` and `.fadeno/dispatches.jsonl`) to the repo's
`.gitignore`.

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
    fadeno/               # → .fadeno/ : vocabulary, playbooks, schemas, enforcement
    opencode-agents/      # → .opencode/agents : read-only driver policy
    skills/               # the three SKILL.md bodies + references (sigil-free)
    commands/             # /fadeno:* slash-command files (plugin)
    hooks/                # pre-commit, CI workflow, README (tier-2 scaffold)
  codex/                  # Codex adapter: AGENTS.md, host + steering agent TOML, openai/*.yaml
  claude/                 # Claude adapter: CLAUDE.md, agents, enforcement + steering hooks
   grok/                   # Grok Build adapter: AGENTS.md, grok-agents/*.md
   opencode/               # OpenCode adapter: AGENTS.md, opencode-agents/*.md
```

`runInit` (`src/commands/init.ts`) composes these: always copy `common/fadeno` →
`.fadeno/` and the OpenCode driver policy → `.opencode/agents/`; unless
`--data-only`, also install skills (shared body + per-target
dir/policy), subagents, and the bootstrap file; optionally the hooks scaffold
(`--with-hooks`); and on Claude, merge a `Bash(fadeno:*)` allow-rule into
git-ignored `.claude/settings.local.json` (plugins can't grant themselves Bash
permissions, so `init` is the seam for this). Grok receives the shared
capabilities and host `.grok/agents` definitions without an automatic
`.grok/config.toml` mutation or permission grant.

Steering is enabled by default for Codex and Claude; `--no-steering` is the
explicit opt-out and `--with-steering` remains a compatibility alias. On Codex,
`runInit` renders honest unmaterialized brokers through the same template
`steering apply` uses, resolving the relay identity from the catalog it just wrote.
`fadeno setup --codex` records the harness and materializes managed agents in
the user Codex home. When setup is invoked from a plugin, it first copies the
bundled CLI to the stable user data directory and records runtime and harness
ownership in the user state directory. Managed agents point at that stable
runtime, never at a versioned plugin cache path. Setup is strictly user-scoped
and does not modify the current repository. For Claude it also merges one exact
stable-runtime Bash allow rule into user settings; uninstall removes only that
recorded rule. Later `fadeno dial` switches refresh managed agents
automatically where needed. `fadeno steering apply --codex --scope project` remains the explicit project override and
then materializes every required slot into session-static role TOML: host slots
become host agents using their configured model/effort, while command slots
become cheap brokers that delegate through `fadeno dispatch`. Before each task,
matching host executor → host, command executor → dispatch proxy, a different
host executor with `fallback_command` → authenticated out-of-process fallback,
and a host executor without one → restart required. Locked engine fallbacks use
`dispatch-fallback`, not ordinary `dispatch`, and record command transport
without claiming host attestation. On Claude, init emits a local
`PreToolUse` script under `.fadeno/local/` and non-destructively merges one
`Agent` hook into `.claude/settings.local.json`. The hook first asks the CLI
whether any dial is active; only then does it map worker, reviewer, and judge
launches to the corresponding dispatch proxy. Only agents that name an
archetype are steered: `general-purpose` is the harness's catch-all, so
capturing it turned every generic spawn in a Fadeno repo into an external
dispatch. It, Explore, Plan, and unrelated specialists stay unsteered. A director that names
`dispatch-<archetype>` itself is resolved the same way rather than taken at its
word: the transport belongs to the dial, and a host slot is pulled back to
the host agent instead of shelling out to a subprocess of this same harness —
which would load the same plugin, re-read the prompt as director work, and
re-dispatch one level down. A spawn it steers to a host role
agent gets a best-effort `host_delivery` evidence row plus a prompt snapshot
under `.fadeno/local/prompts/`; that path can pin the requested model but not
reasoning effort (the Agent tool schema has no effort parameter), so the row
records `reasoning_effort: "inherited"` rather than the target's declared
effort. Grok currently rejects the flag.

The Claude `claude-agents/` dir carries two kinds of subagents: the host role
subagents (`worker`/`reviewer`/`judge`) and the **dispatch proxy agents**
(`dispatch-worker`/`dispatch-reviewer`/`dispatch-judge`). Claude Code can't run
non-Anthropic inference in-session, so cross-harness subagents go out-of-process
through these proxies. Each is `tools: Bash`, `model: sonnet` — the proxy does
no thinking about the task: one Bash call (run with the tool's `timeout`
raised to 600000 ms) pipes the received task prompt **verbatim** to
`fadeno dispatch --archetype <a>` as a quoted heredoc on stdin, then relays
the report verbatim. The kernel snapshots stdin prompts to
`.fadeno/local/prompts/` and writes the evidence rows itself; the bare
`fadeno` spelling keeps the call inside the `Bash(fadeno:*)` permission rule
init pre-approves. On a non-zero exit the proxy reports the failure and never
attempts the task itself — silently substituting which provider does the work
is an explicit non-goal. (Sonnet, not haiku: a 2026-08-12 dogfood A/B caught
haiku defecting on the relay contract; the proxy guard hook backstops the
contract in either case, and the steering hook's relay attestation checks the
one remaining LLM copy step.) Routing is by description by default and is made deterministic at
the host boundary by default with `init --claude`; `--no-steering` opts out.
Resolution stays in
the CLI. The
permission boundary stays loud: the external executor a proxy dispatches runs
*outside* the harness's permission fences, under its own sandbox flags — a
deliberate user choice made by binding that executor via a dial, with the
dispatch evidence row as the audit trail.

Two non-obvious template rules:

- **Traces are lazy.** Runtime directories are created by the first command that
  needs them; no committed `.gitkeep` is required.
- **`emitBootstrap` is idempotent.** It wraps the Fadeno section in
  `<!-- fadeno:begin … -->` / `<!-- fadeno:end -->` markers: absent file → create;
  markers absent → append; markers present → skip (or replace under `--force`).

### The plugin is generated from the same templates

`fadeno plugin` (`runPlugin`) emits a Claude Code plugin from the **same**
`templates/common/skills` bodies (rewriting `name: fadeno-runner` →
`name: runner` for the short `fadeno:runner` namespace), plus the shared
`commands/`, the Claude `claude-agents/`, a setup skill and hook, and a manifest.
The build adds a standalone CLI plus immutable built-in definitions under
`plugin/bin/`; every skill also gets an executable private launcher under
`scripts/fadeno.cjs`, so plugin operation does not depend on shell `PATH`. Plugin
users can run starter playbooks without project init.
`init --data-only` is the project-data seam (definitions plus driver policy,
without host capability). `vendor` deliberately
emits the full project capability surface plus definitions and a lock.

`npm run build:plugin` runs `fadeno plugin ./plugin --force` **and**
`build-bin.mjs`. The resulting `plugin/` is **committed** (unlike `dist/`, which is
gitignored) so a git-URL install yields a working plugin with no build step. The
bundled binary carries the complete `templates/` tree, including the Grok adapter,
so its `fadeno init --grok` path is self-contained even though `fadeno plugin`
itself remains a Claude Code plugin generator.

`fadeno plugin --codex` (`runCodexPlugin`, `npm run build:plugin:codex`) emits a
**Codex** plugin into the committed, visible `plugin-codex/` (parallel to the
Claude `plugin/`) from the same `templates/common/skills` bodies — but full-named
(Codex invokes `$fadeno-runner`) and carrying each skill's `agents/openai.yaml`
invocation policy (runner implicit; builder/driver explicit-only), the setup
skill, bundled CLI, and immutable definitions. User-scoped host agents are
materialized outside the plugin; project overrides remain available through
`init`, `vendor`, or `steering apply --scope project`. The only piece that must live in a dot dir is the
marketplace pointer `.agents/plugins/marketplace.json` — a fixed Codex convention
(`codex plugin marketplace add owner/repo` looks there), the analog of the Claude
plugin's hidden `.claude-plugin/marketplace.json`; the **marketplace root is the
repo root** and the entry's `source.path` (`./plugin-codex`) is relative to it.
Together they make the repo installable via `codex plugin marketplace add
CrocSwap/fadeno` → `codex plugin add fadeno@fadeno`. The manifest
`interface.category` is a capitalized bucket (`Engineering`) and the version is
single-sourced from `package.json`, both verified against a real `codex plugin add`.

### Keeping the plugin in sync (the no-drift guard)

Because `plugin/` is generated but committed, it can drift from `templates/`.
`test/plugin.test.ts` guards this — but **narrowly**: it asserts a freshly
generated `skills/builder/SKILL.md` equals the committed one, and that
`plugin/bin/fadeno` exists, is executable, starts with the node shebang, and is
pinned to CommonJS. The broader drift suite also covers Codex payloads, target
invocation policy, generated templates, and the committed marketplace pointer.
Practical rule: **after editing any template or bumping the version, run both
plugin build commands and commit the generated payloads.**

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
- **Coverage** (hundreds of cases): `init` (Codex, Claude, and Grok targets;
  hooks, dial steering, force/idempotency),
  schema + reference + semantic validation, run-ledger lifecycle + gate, diagram
  rendering, and plugin generation + the no-drift/binary guards.

When you add behavior, add a test next to the matching command and follow the
`tempRepo` → `run*()` → assert pattern. Inject `now` for anything time-dependent.
